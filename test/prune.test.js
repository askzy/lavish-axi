import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_PRUNE_MAX_AGE,
  DEFAULT_PRUNE_OPEN_MAX_AGE,
  DEFAULT_PRUNE_UNREPLIED_MAX_AGE,
  formatBytes,
  formatPruneSummary,
  knownArtifactDirs,
  parseDuration,
  prune,
  resolvePruneMaxAgeMs,
  resolvePruneOpenMaxAgeMs,
  resolvePruneUnrepliedMaxAgeMs,
} from "../src/prune.js";
import { serve } from "../src/server.js";
import { SessionStore, sessionKey } from "../src/session-store.js";

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-28T12:00:00Z");
const OLD = new Date(NOW - 45 * DAY_MS);
const RECENT = new Date(NOW - 2 * DAY_MS);
const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

async function makeTemp() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "lavish-prune-")));
  await mkdir(path.join(dir, ".lavish"));
  return dir;
}

async function writeArtifact(dir, name, at) {
  const file = path.join(dir, ".lavish", name);
  await writeFile(file, `<!doctype html><title>${name}</title>`);
  await utimes(file, at, at);
  return file;
}

function sessionRecord(file, status, updatedAt, overrides = {}) {
  return {
    key: sessionKey(file),
    file,
    url: "http://127.0.0.1:4387/s/x",
    status,
    pending_prompts: 0,
    prompts: [],
    leases: [],
    layout_warnings: [],
    artifact_failures: [],
    dom_snapshot: "<html>snapshot</html>",
    chat: [],
    updated_at: updatedAt.toISOString(),
    ...overrides,
  };
}

function daysAgo(days) {
  return new Date(NOW - days * DAY_MS);
}

const USER_REPLY = { chat: [{ role: "user", text: "Looks good, ship it", at: daysAgo(70).toISOString() }] };
const AGENT_ONLY = { chat: [{ role: "agent", text: "Here is the plan", at: daysAgo(70).toISOString() }] };
// An annotation the reviewer sent is a user entry in the transcript too, so a session whose only
// reviewer words are notes on elements counts as replied-to.
const ANNOTATION_ONLY = {
  chat: [
    {
      role: "user",
      kind: "annotation",
      text: "Rename this",
      anchor: { kind: "element", label: "<h2>", excerpt: "Heading" },
      at: daysAgo(70).toISOString(),
    },
  ],
};

async function writeStore(dir, sessions) {
  const file = path.join(dir, "state.json");
  const state = { sessions: Object.fromEntries(sessions.map((session) => [session.key, session])) };
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test("parseDuration accepts d, h, and m units and rejects everything else", () => {
  assert.equal(parseDuration("30d"), 30 * DAY_MS);
  assert.equal(parseDuration("12h"), 12 * 60 * 60_000);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.equal(parseDuration(" 7D "), 7 * DAY_MS);
  assert.equal(parseDuration(DEFAULT_PRUNE_MAX_AGE), 30 * DAY_MS);
  for (const bad of ["30", "abc", "-1d", "1.5d", "1w", "", undefined]) {
    assert.throws(() => parseDuration(bad), /Invalid duration/, `expected "${bad}" to be rejected`);
  }
});

test("resolvePruneMaxAgeMs reads LAVISH_AXI_PRUNE_MAX_AGE with 0/off disabling", () => {
  assert.equal(resolvePruneMaxAgeMs({}), 30 * DAY_MS);
  assert.equal(resolvePruneMaxAgeMs({ LAVISH_AXI_PRUNE_MAX_AGE: "" }), 30 * DAY_MS);
  assert.equal(resolvePruneMaxAgeMs({ LAVISH_AXI_PRUNE_MAX_AGE: "7d" }), 7 * DAY_MS);
  assert.equal(resolvePruneMaxAgeMs({ LAVISH_AXI_PRUNE_MAX_AGE: "0" }), null);
  assert.equal(resolvePruneMaxAgeMs({ LAVISH_AXI_PRUNE_MAX_AGE: "off" }), null);
  assert.throws(() => resolvePruneMaxAgeMs({ LAVISH_AXI_PRUNE_MAX_AGE: "soon" }), /Invalid duration/);
});

test("resolvers for the open-session windows read their own env vars with 0/off disabling", () => {
  assert.equal(parseDuration(DEFAULT_PRUNE_UNREPLIED_MAX_AGE), 14 * DAY_MS);
  assert.equal(parseDuration(DEFAULT_PRUNE_OPEN_MAX_AGE), 60 * DAY_MS);
  assert.equal(resolvePruneUnrepliedMaxAgeMs({}), 14 * DAY_MS);
  assert.equal(resolvePruneUnrepliedMaxAgeMs({ LAVISH_AXI_PRUNE_UNREPLIED_MAX_AGE: "3d" }), 3 * DAY_MS);
  assert.equal(resolvePruneUnrepliedMaxAgeMs({ LAVISH_AXI_PRUNE_UNREPLIED_MAX_AGE: "off" }), null);
  assert.equal(resolvePruneOpenMaxAgeMs({}), 60 * DAY_MS);
  assert.equal(resolvePruneOpenMaxAgeMs({ LAVISH_AXI_PRUNE_OPEN_MAX_AGE: "90d" }), 90 * DAY_MS);
  assert.equal(resolvePruneOpenMaxAgeMs({ LAVISH_AXI_PRUNE_OPEN_MAX_AGE: "0" }), null);
  assert.throws(() => resolvePruneOpenMaxAgeMs({ LAVISH_AXI_PRUNE_OPEN_MAX_AGE: "1w" }), /Invalid duration/);
});

test("prune removes a pruned session's attachment dir and leaves live sessions' attachments alone", async () => {
  const dir = await makeTemp();
  try {
    const stale = await writeArtifact(dir, "stale.html", OLD);
    const live = await writeArtifact(dir, "live.html", RECENT);
    const staleRecord = sessionRecord(stale, "ended", OLD);
    const liveRecord = sessionRecord(live, "open", RECENT, USER_REPLY);
    const stateFile = await writeStore(dir, [staleRecord, liveRecord]);
    const id = "a".repeat(64) + ".png";
    const staleDir = path.join(dir, "attachments", staleRecord.key);
    const liveDir = path.join(dir, "attachments", liveRecord.key);
    await mkdir(staleDir, { recursive: true });
    await mkdir(liveDir, { recursive: true });
    await writeFile(path.join(staleDir, id), Buffer.alloc(100));
    await writeFile(path.join(staleDir, `${id}.meta`), "{}");
    await writeFile(path.join(liveDir, id), Buffer.alloc(100));

    const dryRun = await prune({
      store: new SessionStore(stateFile),
      maxAgeMs: 30 * DAY_MS,
      dryRun: true,
      now: () => NOW,
    });
    assert.deepEqual(dryRun.removedSessions, [stale]);
    assert.ok(await exists(path.join(staleDir, id)), "a dry run deletes nothing");

    const result = await prune({ store: new SessionStore(stateFile), maxAgeMs: 30 * DAY_MS, now: () => NOW });
    assert.deepEqual(result.removedSessions, [stale]);
    assert.equal(await exists(staleDir), false, "the pruned session's attachment dir is gone");
    assert.ok(await exists(path.join(liveDir, id)), "the live session's attachment survives");
    assert.ok(result.bytesFreed >= 102, "freed bytes count the attachment files");
    assert.equal(dryRun.bytesFreed, result.bytesFreed, "a dry run reports the same total it would free");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune removes a pruned session's whiteboard sidecars and keeps those a live lease points at", async () => {
  const dir = await makeTemp();
  try {
    const stale = await writeArtifact(dir, "stale.html", OLD);
    const leased = await writeArtifact(dir, "leased.html", RECENT);
    const staleRecord = sessionRecord(stale, "ended", OLD);
    const leasedRecord = sessionRecord(leased, "open", daysAgo(400));
    const scenePath = path.join(dir, "whiteboards", leasedRecord.key, "0.excalidraw");
    const previewPath = path.join(dir, "whiteboards", leasedRecord.key, "0.png");
    const prompt = {
      uid: "",
      prompt: "Whiteboard edits to diagram 1",
      selector: "",
      tag: "whiteboard",
      text: "",
      target: { type: "excalidraw-scene", diagramIndex: 0, scenePath, previewPath },
    };
    leasedRecord.leases = [{ delivery_id: "d1", leased_at: daysAgo(400).toISOString(), prompts: [prompt] }];
    const stateFile = await writeStore(dir, [staleRecord, leasedRecord]);
    const staleDir = path.join(dir, "whiteboards", staleRecord.key);
    await mkdir(staleDir, { recursive: true });
    await mkdir(path.dirname(scenePath), { recursive: true });
    await writeFile(path.join(staleDir, "0.json"), "{}");
    await writeFile(path.join(staleDir, "0.excalidraw"), Buffer.alloc(100));
    await writeFile(path.join(staleDir, "0.png"), Buffer.alloc(50));
    await writeFile(scenePath, Buffer.alloc(100));

    const dryRun = await prune({
      store: new SessionStore(stateFile),
      maxAgeMs: 30 * DAY_MS,
      dryRun: true,
      now: () => NOW,
    });
    assert.deepEqual(dryRun.removedSessions, [stale]);
    assert.ok(await exists(path.join(staleDir, "0.excalidraw")), "a dry run deletes nothing");

    const result = await prune({ store: new SessionStore(stateFile), maxAgeMs: 30 * DAY_MS, now: () => NOW });
    assert.deepEqual(result.removedSessions, [stale]);
    assert.equal(await exists(staleDir), false, "the pruned session's whiteboard dir is gone");
    assert.ok(await exists(scenePath), "the sidecar an unacked lease points at survives");
    assert.ok(result.bytesFreed >= 152, "freed bytes count the sidecar files");
    assert.equal(dryRun.bytesFreed, result.bytesFreed, "a dry run reports the same total it would free");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune removes abandoned open sessions by the unreplied and open windows", async () => {
  const dir = await makeTemp();
  try {
    const unreplied15 = await writeArtifact(dir, "unreplied-15d.html", RECENT);
    const unreplied13 = await writeArtifact(dir, "unreplied-13d.html", RECENT);
    const agentOnly15 = await writeArtifact(dir, "agent-only-15d.html", RECENT);
    const replied59 = await writeArtifact(dir, "replied-59d.html", RECENT);
    const replied61 = await writeArtifact(dir, "replied-61d.html", RECENT);
    const stateFile = await writeStore(dir, [
      sessionRecord(unreplied15, "open", daysAgo(15)),
      sessionRecord(unreplied13, "open", daysAgo(13)),
      sessionRecord(agentOnly15, "open", daysAgo(15), AGENT_ONLY),
      sessionRecord(replied59, "open", daysAgo(59), USER_REPLY),
      sessionRecord(replied61, "open", daysAgo(61), USER_REPLY),
    ]);

    const result = await prune({ store: new SessionStore(stateFile), maxAgeMs: 30 * DAY_MS, now: () => NOW });

    assert.deepEqual(result.removedSessions.sort(), [agentOnly15, replied61, unreplied15].sort());
    assert.equal(result.filesRemoved, 0, "a removed session's recent file waits for the normal cutoff");
    const remaining = await new SessionStore(stateFile).listSessions();
    assert.deepEqual(remaining.map((session) => session.file).sort(), [replied59, unreplied13].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune keeps an open session with queued or leased feedback whatever its age", async () => {
  const dir = await makeTemp();
  try {
    const queued = await writeArtifact(dir, "queued.html", RECENT);
    const feedback = await writeArtifact(dir, "feedback.html", RECENT);
    const leased = await writeArtifact(dir, "leased.html", RECENT);
    const control = await writeArtifact(dir, "control.html", RECENT);
    const prompt = { uid: "u1", prompt: "Make the title bigger", selector: "h1", tag: "text", text: "Title" };
    const stateFile = await writeStore(dir, [
      sessionRecord(queued, "open", daysAgo(400), { prompts: [prompt], pending_prompts: 1 }),
      sessionRecord(feedback, "feedback", daysAgo(400), USER_REPLY),
      sessionRecord(leased, "open", daysAgo(400), {
        leases: [{ delivery_id: "d1", leased_at: daysAgo(400).toISOString(), prompts: [prompt] }],
      }),
      sessionRecord(control, "open", daysAgo(400)),
    ]);

    const result = await prune({ store: new SessionStore(stateFile), maxAgeMs: 30 * DAY_MS, now: () => NOW });

    assert.deepEqual(result.removedSessions, [control]);
    const remaining = await new SessionStore(stateFile).listSessions();
    assert.deepEqual(remaining.map((session) => session.file).sort(), [feedback, leased, queued].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open-session windows can be moved or disabled per call", async () => {
  const dir = await makeTemp();
  try {
    const unreplied15 = await writeArtifact(dir, "unreplied-15d.html", RECENT);
    const replied61 = await writeArtifact(dir, "replied-61d.html", RECENT);
    const stateFile = await writeStore(dir, [
      sessionRecord(unreplied15, "open", daysAgo(15)),
      sessionRecord(replied61, "open", daysAgo(61), USER_REPLY),
    ]);
    const store = new SessionStore(stateFile);

    const disabled = await prune({
      store,
      maxAgeMs: 30 * DAY_MS,
      unrepliedMaxAgeMs: null,
      openMaxAgeMs: null,
      dryRun: true,
      now: () => NOW,
    });
    assert.equal(disabled.sessionsRemoved, 0);

    const moved = await prune({
      store,
      maxAgeMs: 30 * DAY_MS,
      unrepliedMaxAgeMs: 20 * DAY_MS,
      openMaxAgeMs: 90 * DAY_MS,
      dryRun: true,
      now: () => NOW,
    });
    assert.equal(moved.sessionsRemoved, 0);

    const tightened = await prune({
      store,
      maxAgeMs: 30 * DAY_MS,
      unrepliedMaxAgeMs: 10 * DAY_MS,
      openMaxAgeMs: 50 * DAY_MS,
      dryRun: true,
      now: () => NOW,
    });
    assert.deepEqual(tightened.removedSessions.sort(), [replied61, unreplied15].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune removes ended-and-old and file-gone sessions, keeps open-and-live and ended-but-recent", async () => {
  const dir = await makeTemp();
  try {
    const endedOld = await writeArtifact(dir, "ended-old.html", RECENT);
    const openOld = await writeArtifact(dir, "open-old.html", OLD);
    const endedRecent = await writeArtifact(dir, "ended-recent.html", RECENT);
    const gone = path.join(dir, ".lavish", "gone.html");
    const stateFile = await writeStore(dir, [
      sessionRecord(endedOld, "ended", OLD),
      sessionRecord(openOld, "open", OLD, USER_REPLY),
      sessionRecord(endedRecent, "ended", RECENT),
      sessionRecord(gone, "open", RECENT),
    ]);
    const before = (await stat(stateFile)).size;

    const result = await prune({ store: new SessionStore(stateFile), maxAgeMs: 30 * DAY_MS, now: () => NOW });

    assert.equal(result.sessionsRemoved, 2);
    assert.deepEqual(result.removedSessions.sort(), [endedOld, gone].sort());
    assert.equal(result.filesRemoved, 0);
    assert.ok(result.bytesFreed > 0);
    assert.equal((await stat(stateFile)).size, before - result.bytesFreed);

    const remaining = await new SessionStore(stateFile).listSessions();
    assert.deepEqual(
      remaining.map((session) => session.file).sort(),
      [openOld, endedRecent].sort(),
      "open-with-a-reply and ended-but-recent survive",
    );
    assert.ok(await exists(openOld), "an open session's artifact is never deleted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact sweep removes stale .lavish html except what an open session still points at", async () => {
  const dir = await makeTemp();
  try {
    const openOld = await writeArtifact(dir, "open-old.html", OLD);
    const endedOld = await writeArtifact(dir, "ended-old.html", OLD);
    const orphanOld = await writeArtifact(dir, "orphan-old.html", OLD);
    const orphanRecent = await writeArtifact(dir, "orphan-recent.html", RECENT);
    const exportOld = await writeArtifact(dir, "orphan-old.export.html", OLD);
    const imageOld = await writeArtifact(dir, "screenshot.png", OLD);
    const stateFile = await writeStore(dir, [
      sessionRecord(openOld, "open", OLD, USER_REPLY),
      sessionRecord(endedOld, "ended", OLD),
    ]);

    const result = await prune({
      store: new SessionStore(stateFile),
      artifactDirs: [path.join(dir, ".lavish"), path.join(dir, "missing", ".lavish")],
      maxAgeMs: 30 * DAY_MS,
      now: () => NOW,
    });

    assert.equal(result.sessionsRemoved, 1);
    assert.deepEqual(result.removedFiles.sort(), [endedOld, exportOld, orphanOld].sort());
    assert.equal(result.filesRemoved, 3);
    assert.ok(await exists(openOld), "open session artifact kept");
    assert.ok(await exists(orphanRecent), "recent file kept");
    assert.ok(await exists(imageOld), "non-html files are left alone");
    assert.equal(await exists(orphanOld), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dry run reports the same counts and writes nothing", async () => {
  const dir = await makeTemp();
  try {
    const endedOld = await writeArtifact(dir, "ended-old.html", OLD);
    const orphanOld = await writeArtifact(dir, "orphan-old.html", OLD);
    const stateFile = await writeStore(dir, [sessionRecord(endedOld, "ended", OLD)]);
    const before = await readFile(stateFile, "utf8");

    const dry = await prune({
      store: new SessionStore(stateFile),
      artifactDirs: [path.join(dir, ".lavish")],
      maxAgeMs: 30 * DAY_MS,
      dryRun: true,
      now: () => NOW,
    });
    assert.equal(dry.sessionsRemoved, 1);
    assert.equal(dry.filesRemoved, 2);
    assert.ok(dry.bytesFreed > 0);
    assert.equal(await readFile(stateFile, "utf8"), before, "state.json untouched");
    assert.ok(await exists(endedOld));
    assert.ok(await exists(orphanOld));
    assert.match(formatPruneSummary(dry), /^Would remove 1 session and 2 files, .* freed$/);

    const wet = await prune({
      store: new SessionStore(stateFile),
      artifactDirs: [path.join(dir, ".lavish")],
      maxAgeMs: 30 * DAY_MS,
      now: () => NOW,
    });
    assert.equal(wet.sessionsRemoved, dry.sessionsRemoved);
    assert.equal(wet.filesRemoved, dry.filesRemoved);
    assert.equal(wet.bytesFreed, dry.bytesFreed);
    assert.match(formatPruneSummary(wet), /^Removed 1 session and 2 files, .* freed$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("knownArtifactDirs lists each .lavish directory the store points into once", async () => {
  const dir = await makeTemp();
  try {
    const a = await writeArtifact(dir, "a.html", RECENT);
    const b = await writeArtifact(dir, "b.html", RECENT);
    const elsewhere = path.join(dir, "elsewhere.html");
    const stateFile = await writeStore(dir, [
      sessionRecord(a, "open", RECENT),
      sessionRecord(b, "ended", RECENT),
      sessionRecord(elsewhere, "open", RECENT),
    ]);
    assert.deepEqual(await knownArtifactDirs(new SessionStore(stateFile)), [path.join(dir, ".lavish")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default sweep covers every .lavish directory the store has a session in and nothing else", async () => {
  const projectA = await makeTemp();
  const projectB = await makeTemp();
  const unreferenced = await makeTemp();
  try {
    const endedA = await writeArtifact(projectA, "ended-old.html", OLD);
    const orphanA = await writeArtifact(projectA, "orphan-old.html", OLD);
    const orphanB = await writeArtifact(projectB, "orphan-old.html", OLD);
    const liveB = await writeArtifact(projectB, "open-live.html", OLD);
    const untouched = await writeArtifact(unreferenced, "orphan-old.html", OLD);
    const stateFile = await writeStore(projectA, [
      sessionRecord(endedA, "ended", OLD),
      sessionRecord(liveB, "open", OLD, USER_REPLY),
    ]);

    const result = await prune({ store: new SessionStore(stateFile), maxAgeMs: 30 * DAY_MS, now: () => NOW });

    assert.equal(result.sessionsRemoved, 1);
    assert.deepEqual(result.removedFiles.sort(), [endedA, orphanA, orphanB].sort());
    assert.ok(await exists(liveB), "open session artifact kept");
    assert.ok(await exists(untouched), "a directory no session references is not swept");
  } finally {
    await Promise.all([projectA, projectB, unreferenced].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("explicit artifactDirs narrows the sweep to those directories", async () => {
  const projectA = await makeTemp();
  const projectB = await makeTemp();
  try {
    const orphanA = await writeArtifact(projectA, "orphan-old.html", OLD);
    const orphanB = await writeArtifact(projectB, "orphan-old.html", OLD);
    const recentA = await writeArtifact(projectA, "recent.html", RECENT);
    const recentB = await writeArtifact(projectB, "recent.html", RECENT);
    const stateFile = await writeStore(projectA, [
      sessionRecord(recentA, "ended", RECENT),
      sessionRecord(recentB, "ended", RECENT),
    ]);

    const result = await prune({
      store: new SessionStore(stateFile),
      artifactDirs: [path.join(projectA, ".lavish")],
      maxAgeMs: 30 * DAY_MS,
      now: () => NOW,
    });

    assert.deepEqual(result.removedFiles, [orphanA]);
    assert.ok(await exists(orphanB), "a directory outside the narrowed set is left alone");
  } finally {
    await Promise.all([projectA, projectB].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("formatBytes picks a readable unit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(877 * 1024), "877 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("server start prunes across every known .lavish directory and logs a summary", async () => {
  const dir = await makeTemp();
  try {
    const endedOld = await writeArtifact(dir, "ended-old.html", OLD);
    const orphanOld = await writeArtifact(dir, "orphan-old.html", OLD);
    const openLive = await writeArtifact(dir, "open-live.html", OLD);
    const stateFile = await writeStore(dir, [
      sessionRecord(endedOld, "ended", OLD),
      sessionRecord(openLive, "open", OLD, USER_REPLY),
    ]);
    const lines = [];
    const server = await serve({
      port: 0,
      host: "127.0.0.1",
      stateFile,
      idleTimeoutMs: null,
      log: (line) => lines.push(line),
      pruneMaxAgeMs: 30 * DAY_MS,
    });
    await server.close();

    assert.equal(await exists(endedOld), false);
    assert.equal(await exists(orphanOld), false);
    assert.ok(await exists(openLive));
    const remaining = await new SessionStore(stateFile).listSessions();
    assert.deepEqual(
      remaining.map((session) => session.file),
      [openLive],
    );
    assert.ok(
      lines.some((line) => /^\[lavish\] prune: Removed 1 session and 2 files/.test(line)),
      `expected a prune summary in ${JSON.stringify(lines)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("server start prune is skipped when disabled and non-fatal on a corrupt store", async () => {
  const dir = await makeTemp();
  try {
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, "{ this is not json");
    const lines = [];

    const disabled = await serve({
      port: 0,
      host: "127.0.0.1",
      stateFile,
      idleTimeoutMs: null,
      log: (line) => lines.push(line),
      pruneMaxAgeMs: null,
    });
    await disabled.close();
    // Every shutdown logs its cause; that line is not a store read.
    assert.deepEqual(
      lines.filter((line) => !line.startsWith("[lavish] shutting down:")),
      [],
      "a disabled prune never reads the store",
    );

    const server = await serve({
      port: 0,
      host: "127.0.0.1",
      stateFile,
      idleTimeoutMs: null,
      log: (line) => lines.push(line),
      pruneMaxAgeMs: 30 * DAY_MS,
    });
    assert.ok(server.port > 0, "server came up despite the corrupt store");
    await server.close();
    assert.ok(
      lines.some((line) => line.startsWith("[lavish] prune failed:")),
      `expected a prune failure line in ${JSON.stringify(lines)}`,
    );
    assert.equal(await readFile(stateFile, "utf8"), "{ this is not json", "a corrupt store is left for inspection");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune command sweeps store-wide by default, narrows with --cwd, and rejects a bad duration", async () => {
  const dir = await makeTemp();
  const other = await makeTemp();
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  try {
    const endedOld = await writeArtifact(dir, "ended-old.html", OLD);
    const orphanOther = await writeArtifact(other, "orphan-old.html", OLD);
    const recentOther = await writeArtifact(other, "recent.html", RECENT);
    await writeStore(stateDir, [sessionRecord(endedOld, "ended", OLD), sessionRecord(recentOther, "ended", RECENT)]);
    const env = { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_TELEMETRY: "0" };

    const dry = spawnSync(process.execPath, [BIN, "prune", "--dry-run"], { encoding: "utf8", env, cwd: os.tmpdir() });
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.match(dry.stdout.trim(), /^Would remove 1 session and 2 files, .* freed$/);
    assert.ok(await exists(endedOld));
    assert.ok(await exists(orphanOther));

    const narrowed = spawnSync(process.execPath, [BIN, "prune", "--older-than=7d", "--cwd", dir], {
      encoding: "utf8",
      env,
    });
    assert.equal(narrowed.status, 0, narrowed.stderr || narrowed.stdout);
    assert.match(narrowed.stdout.trim(), /^Removed 1 session and 1 file, .* freed$/);
    assert.equal(await exists(endedOld), false);
    assert.ok(await exists(orphanOther), "--cwd leaves other known directories alone");

    const wide = spawnSync(process.execPath, [BIN, "prune"], { encoding: "utf8", env, cwd: os.tmpdir() });
    assert.equal(wide.status, 0, wide.stderr || wide.stdout);
    assert.match(wide.stdout.trim(), /^Removed 0 sessions and 1 file, .* freed$/);
    assert.equal(await exists(orphanOther), false);
    assert.ok(await exists(recentOther));

    const bad = spawnSync(process.execPath, [BIN, "prune", "--older-than", "soon"], { encoding: "utf8", env });
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /Invalid duration .*soon/);
    assert.match(`${bad.stdout}${bad.stderr}`, /VALIDATION_ERROR/);
  } finally {
    await Promise.all([dir, other].map((d) => rm(d, { recursive: true, force: true })));
  }
});

test("prune command takes the open-session windows from flags, then env, then defaults", async () => {
  const dir = await makeTemp();
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  try {
    const unreplied = await writeArtifact(dir, "unreplied.html", new Date());
    const replied = await writeArtifact(dir, "replied.html", new Date());
    const now = Date.now();
    const seed = () =>
      writeStore(stateDir, [
        sessionRecord(unreplied, "open", new Date(now - 5 * DAY_MS)),
        sessionRecord(replied, "open", new Date(now - 20 * DAY_MS), USER_REPLY),
      ]);
    const baseEnv = {
      ...process.env,
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_PRUNE_UNREPLIED_MAX_AGE: "",
      LAVISH_AXI_PRUNE_OPEN_MAX_AGE: "",
    };
    const run = (args, env) =>
      spawnSync(process.execPath, [BIN, "prune", "--dry-run", ...args], { encoding: "utf8", env, cwd: os.tmpdir() });

    await seed();
    const defaults = run([], baseEnv);
    assert.equal(defaults.status, 0, defaults.stderr || defaults.stdout);
    assert.match(defaults.stdout.trim(), /^Would remove 0 sessions/);

    const viaEnv = run([], {
      ...baseEnv,
      LAVISH_AXI_PRUNE_UNREPLIED_MAX_AGE: "3d",
      LAVISH_AXI_PRUNE_OPEN_MAX_AGE: "10d",
    });
    assert.equal(viaEnv.status, 0, viaEnv.stderr || viaEnv.stdout);
    assert.match(viaEnv.stdout.trim(), /^Would remove 2 sessions/);

    const viaFlags = run(["--unreplied-older-than", "3d", "--open-older-than=10d"], baseEnv);
    assert.equal(viaFlags.status, 0, viaFlags.stderr || viaFlags.stdout);
    assert.match(viaFlags.stdout.trim(), /^Would remove 2 sessions/);

    const flagBeatsEnv = run(["--unreplied-older-than", "off", "--open-older-than", "0"], {
      ...baseEnv,
      LAVISH_AXI_PRUNE_UNREPLIED_MAX_AGE: "3d",
      LAVISH_AXI_PRUNE_OPEN_MAX_AGE: "10d",
    });
    assert.equal(flagBeatsEnv.status, 0, flagBeatsEnv.stderr || flagBeatsEnv.stdout);
    assert.match(flagBeatsEnv.stdout.trim(), /^Would remove 0 sessions/);

    const bad = run(["--open-older-than", "soon"], baseEnv);
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /Invalid duration .*soon/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an annotation-only transcript counts as a user message for the unreplied rule", async () => {
  const dir = await makeTemp();
  try {
    const annotated = await writeArtifact(dir, "annotated-15d.html", RECENT);
    const silent = await writeArtifact(dir, "silent-15d.html", RECENT);
    const stateFile = await writeStore(dir, [
      sessionRecord(annotated, "open", daysAgo(15), ANNOTATION_ONLY),
      sessionRecord(silent, "open", daysAgo(15), AGENT_ONLY),
    ]);

    const result = await prune({ store: new SessionStore(stateFile), maxAgeMs: 30 * DAY_MS, now: () => NOW });

    assert.deepEqual(result.removedSessions, [silent]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
