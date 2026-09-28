import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_PRUNE_MAX_AGE,
  formatBytes,
  formatPruneSummary,
  knownArtifactDirs,
  parseDuration,
  prune,
  resolvePruneMaxAgeMs,
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

function sessionRecord(file, status, updatedAt) {
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
  };
}

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

test("prune removes ended-and-old and file-gone sessions, keeps open-and-live and ended-but-recent", async () => {
  const dir = await makeTemp();
  try {
    const endedOld = await writeArtifact(dir, "ended-old.html", RECENT);
    const openOld = await writeArtifact(dir, "open-old.html", OLD);
    const endedRecent = await writeArtifact(dir, "ended-recent.html", RECENT);
    const gone = path.join(dir, ".lavish", "gone.html");
    const stateFile = await writeStore(dir, [
      sessionRecord(endedOld, "ended", OLD),
      sessionRecord(openOld, "open", OLD),
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
      "open-and-live and ended-but-recent survive",
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
      sessionRecord(openOld, "open", OLD),
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
      sessionRecord(openLive, "open", OLD),
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
    assert.deepEqual(lines, [], "a disabled prune never reads the store");

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

test("prune command prints one summary line and rejects a bad duration", async () => {
  const dir = await makeTemp();
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  try {
    const endedOld = await writeArtifact(dir, "ended-old.html", OLD);
    await writeStore(stateDir, [sessionRecord(endedOld, "ended", OLD)]);
    const env = { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_TELEMETRY: "0" };

    const dry = spawnSync(process.execPath, [BIN, "prune", "--dry-run", "--cwd", dir], { encoding: "utf8", env });
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.match(dry.stdout.trim(), /^Would remove 1 session and 1 file, .* freed$/);
    assert.ok(await exists(endedOld));

    const real = spawnSync(process.execPath, [BIN, "prune", "--older-than=7d", "--cwd", dir], {
      encoding: "utf8",
      env,
    });
    assert.equal(real.status, 0, real.stderr || real.stdout);
    assert.match(real.stdout.trim(), /^Removed 1 session and 1 file, .* freed$/);
    assert.equal(await exists(endedOld), false);

    const bad = spawnSync(process.execPath, [BIN, "prune", "--older-than", "soon"], { encoding: "utf8", env });
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /Invalid duration .*soon/);
    assert.match(`${bad.stdout}${bad.stderr}`, /VALIDATION_ERROR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
