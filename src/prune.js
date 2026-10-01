import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { attachmentsDir } from "./attachment-store.js";

/** @typedef {import("./session-store.js").SessionStore} SessionStore */

export const DEFAULT_PRUNE_MAX_AGE = "30d";
// An open session nobody ever wrote back to is a page the user read and closed: the poll only
// learns `browser_disconnected` and leaves the session open. Two windows catch those and the
// rest: a short one for sessions with no user message, a long one for any open session.
export const DEFAULT_PRUNE_UNREPLIED_MAX_AGE = "14d";
export const DEFAULT_PRUNE_OPEN_MAX_AGE = "60d";
export const ARTIFACT_DIR_NAME = ".lavish";

const DURATION_UNIT_MS = { d: 24 * 60 * 60_000, h: 60 * 60_000, m: 60_000 };

// Accepts `<n>d`, `<n>h`, or `<n>m`. The unit is required so a bare number cannot be read as
// seconds by one caller and milliseconds by another.
export function parseDuration(text) {
  const match = /^\s*(\d+)\s*([dhm])\s*$/i.exec(String(text ?? ""));
  if (!match) {
    throw new Error(`Invalid duration "${text}": use a number followed by d, h, or m (for example 30d, 12h, 90m)`);
  }
  return Number(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()];
}

// LAVISH_AXI_PRUNE_MAX_AGE controls the prune the server runs at start. Unset means the default
// cutoff; `0` or `off` disables it. Returns the cutoff age in milliseconds, or null when disabled.
export function resolvePruneMaxAgeMs(env = process.env) {
  return resolveDurationMs(env.LAVISH_AXI_PRUNE_MAX_AGE, DEFAULT_PRUNE_MAX_AGE);
}

// The two open-session windows follow the same rules as LAVISH_AXI_PRUNE_MAX_AGE, each under its
// own variable, so either can be tuned or switched off without touching the other.
export function resolvePruneUnrepliedMaxAgeMs(env = process.env) {
  return resolveDurationMs(env.LAVISH_AXI_PRUNE_UNREPLIED_MAX_AGE, DEFAULT_PRUNE_UNREPLIED_MAX_AGE);
}

export function resolvePruneOpenMaxAgeMs(env = process.env) {
  return resolveDurationMs(env.LAVISH_AXI_PRUNE_OPEN_MAX_AGE, DEFAULT_PRUNE_OPEN_MAX_AGE);
}

function resolveDurationMs(value, fallback) {
  const raw = value?.trim();
  if (raw === undefined || raw === "") return parseDuration(fallback);
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  return parseDuration(raw);
}

/**
 * Remove stale review state. A session goes when its artifact file no longer exists, when it is
 * ended and its last update is older than the cutoff, or when it is open and its last update is
 * older than `openMaxAgeMs`, or older than `unrepliedMaxAgeMs` while the user never wrote in its
 * chat. An open session holding undelivered or unacknowledged feedback is kept whatever its age.
 * A removed session's image attachments (`<state-dir>/attachments/<key>/`) go with it: nothing
 * can reference them once the record is gone, and the hourly sweep would otherwise hold them
 * until their own TTL. Then every `.html` file directly inside each artifact directory that is
 * older than the cutoff is deleted, unless a session that is still open points at it; the file of
 * an open session removed here is swept by that same cutoff.
 *
 * Without `artifactDirs` the sweep covers every `.lavish/` directory the store has a session in,
 * resolved before any session is removed so a directory whose last session goes is still swept.
 * The CLI and the server start-up prune both take this path; `artifactDirs` narrows it.
 *
 * The caller passes its own store so the removal joins that store's exclusive queue: a second
 * store on the same file would race the server's own writes.
 *
 * @param {object} options
 * @param {SessionStore} options.store
 * @param {string[]} [options.artifactDirs] directories to sweep instead of the store-wide set
 * @param {number} options.maxAgeMs
 * @param {number | null} [options.unrepliedMaxAgeMs] null disables the unreplied rule
 * @param {number | null} [options.openMaxAgeMs] null disables the open-age rule
 * @param {boolean} [options.dryRun]
 * @param {() => number} [options.now]
 */
export async function prune({
  store,
  artifactDirs,
  maxAgeMs,
  unrepliedMaxAgeMs = parseDuration(DEFAULT_PRUNE_UNREPLIED_MAX_AGE),
  openMaxAgeMs = parseDuration(DEFAULT_PRUNE_OPEN_MAX_AGE),
  dryRun = false,
  now = () => Date.now(),
}) {
  const current = now();
  const cutoff = current - maxAgeMs;
  const unrepliedCutoff = unrepliedMaxAgeMs === null ? null : current - unrepliedMaxAgeMs;
  const openCutoff = openMaxAgeMs === null ? null : current - openMaxAgeMs;
  const sweepDirs = artifactDirs ?? (await knownArtifactDirs(store));
  const {
    removed: removedSessions,
    kept,
    bytesFreed: stateBytesFreed,
  } = await store.removeSessions(
    async (session) => {
      if (!(await pathExists(session.file))) return true;
      const updatedAt = timestampMs(session.updated_at);
      if (session.status === "ended") return updatedAt < cutoff;
      if (hasPendingFeedback(session)) return false;
      if (openCutoff !== null && updatedAt < openCutoff) return true;
      return unrepliedCutoff !== null && !hasUserMessage(session) && updatedAt < unrepliedCutoff;
    },
    { dryRun },
  );

  let attachmentBytesFreed = 0;
  for (const session of removedSessions) {
    attachmentBytesFreed += await removeSessionAttachments(path.dirname(store.file), session.key, dryRun);
  }

  const protectedFiles = new Set(kept.filter((session) => session.status !== "ended").map((session) => session.file));
  const removedFiles = [];
  let fileBytesFreed = 0;
  for (const dir of uniqueDirs(sweepDirs)) {
    for (const file of await staleArtifactFiles(dir, cutoff)) {
      if (protectedFiles.has(await realpath(file.path))) continue;
      if (!dryRun) await rm(file.path, { force: true });
      removedFiles.push(file.path);
      fileBytesFreed += file.size;
    }
  }

  return {
    dryRun,
    sessionsRemoved: removedSessions.length,
    filesRemoved: removedFiles.length,
    bytesFreed: stateBytesFreed + attachmentBytesFreed + fileBytesFreed,
    removedSessions: removedSessions.map((session) => session.file),
    removedFiles,
  };
}

// Queued prompts wait for the next poll; a lease, live or expired, holds a batch a poll took but
// never acknowledged, which is redelivered rather than dropped. Either is work an agent still owes.
function hasPendingFeedback(session) {
  return (
    session.status === "feedback" ||
    (session.pending_prompts || 0) > 0 ||
    (session.prompts || []).length > 0 ||
    (session.leases || []).length > 0
  );
}

// Returns the bytes the session's attachment dir held. The dir is removed whole: every file in it
// belongs to this session alone, and the store no longer has a record that could reference one.
async function removeSessionAttachments(stateDir, key, dryRun) {
  const dir = attachmentsDir(stateDir, key);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      bytes += (await stat(path.join(dir, entry.name))).size;
    } catch {
      // Raced with the sweep; the file is gone either way.
    }
  }
  if (!dryRun) await rm(dir, { recursive: true, force: true });
  return bytes;
}

function hasUserMessage(session) {
  return (session.chat || []).some((message) => message?.role === "user");
}

// The artifact directories the store knows about: every `.lavish/` that holds a recorded session.
// Lavish pages live next to many projects, so neither the server nor the CLI has one working
// directory that could stand in for this set.
export async function knownArtifactDirs(store) {
  const sessions = await store.listSessions();
  const dirs = sessions.map((session) => path.dirname(session.file));
  return uniqueDirs(dirs.filter((dir) => path.basename(dir) === ARTIFACT_DIR_NAME));
}

export function formatPruneSummary(result) {
  const verb = result.dryRun ? "Would remove" : "Removed";
  return (
    `${verb} ${plural(result.sessionsRemoved, "session")} and ${plural(result.filesRemoved, "file")}, ` +
    `${formatBytes(result.bytesFreed)} freed`
  );
}

async function staleArtifactFiles(dir, cutoff) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  const stale = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const info = await stat(filePath);
    if (info.mtimeMs < cutoff) stale.push({ path: filePath, size: info.size });
  }
  return stale.sort((a, b) => a.path.localeCompare(b.path));
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

// A record without a readable timestamp has nothing to date it by, so it counts as old.
function timestampMs(value) {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

function uniqueDirs(dirs) {
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
