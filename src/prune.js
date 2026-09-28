import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

/** @typedef {import("./session-store.js").SessionStore} SessionStore */

export const DEFAULT_PRUNE_MAX_AGE = "30d";
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
  const raw = env.LAVISH_AXI_PRUNE_MAX_AGE?.trim();
  if (raw === undefined || raw === "") return parseDuration(DEFAULT_PRUNE_MAX_AGE);
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  return parseDuration(raw);
}

/**
 * Remove stale review state. A session goes when its artifact file no longer exists, or when it
 * is ended and its last update is older than the cutoff. An open session with a live file stays
 * whatever its age. Then every `.html` file directly inside each artifact directory that is older
 * than the cutoff is deleted, unless a session that is still open points at it.
 *
 * The caller passes its own store so the removal joins that store's exclusive queue: a second
 * store on the same file would race the server's own writes.
 *
 * @param {object} options
 * @param {SessionStore} options.store
 * @param {string[]} [options.artifactDirs] directories to sweep for stale `.html` files
 * @param {number} options.maxAgeMs
 * @param {boolean} [options.dryRun]
 * @param {() => number} [options.now]
 */
export async function prune({ store, artifactDirs = [], maxAgeMs, dryRun = false, now = () => Date.now() }) {
  const cutoff = now() - maxAgeMs;
  const {
    removed: removedSessions,
    kept,
    bytesFreed: stateBytesFreed,
  } = await store.removeSessions(
    async (session) => {
      if (!(await pathExists(session.file))) return true;
      return session.status === "ended" && timestampMs(session.updated_at) < cutoff;
    },
    { dryRun },
  );

  const protectedFiles = new Set(kept.filter((session) => session.status !== "ended").map((session) => session.file));
  const removedFiles = [];
  let fileBytesFreed = 0;
  for (const dir of uniqueDirs(artifactDirs)) {
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
    bytesFreed: stateBytesFreed + fileBytesFreed,
    removedSessions: removedSessions.map((session) => session.file),
    removedFiles,
  };
}

// The artifact directories the store knows about: every `.lavish/` that holds a recorded session.
// The server has no meaningful working directory of its own, so this is how the start-up prune
// finds artifacts across projects.
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
