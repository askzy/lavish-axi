import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reviewAttemptPath, reviewSessionIndexPath, validReviewAttempt } from "./review-attempts.js";
import { codexHandles, evaluateReviewStop, guardScope, observeReviewTool } from "./review-guard.js";

function boundedJson(file, limit) {
  if (statSync(file).size > limit) throw new Error("Review guard input exceeds its read limit");
  return JSON.parse(readFileSync(file, "utf8"));
}

function readOptional(file, limit, fallback) {
  try {
    return boundedJson(file, limit);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return fallback;
  }
}

function writeRecord(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}

function canonicalFile(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function callKey(id) {
  return createHash("sha256").update(id).digest("hex");
}

export function runReviewGuard(input, harness, options = {}) {
  if (
    !["claude", "codex"].includes(harness) ||
    typeof input.session_id !== "string" ||
    input.session_id.length > 256 ||
    typeof input.transcript_path !== "string"
  )
    return {};
  const stateDir = options.stateDir || process.env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), ".lavish-axi");
  const now = options.now || Date.now();
  const transcript = realpathSync(input.transcript_path);
  const scope = guardScope(harness, input.session_id, transcript);
  const directory = path.join(stateDir, "review-guard", scope);
  const callDirectory = path.join(directory, "calls");
  const correctionDirectory = path.join(directory, "corrections");
  if (["PreToolUse", "PostToolUse"].includes(input.hook_event_name)) {
    if (typeof input.tool_use_id !== "string") return {};
    const file = path.join(callDirectory, `${callKey(input.tool_use_id)}.json`);
    const prior = readOptional(file, 64 * 1024, null);
    const cliPath = options.cliPath || fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
    const state = observeReviewTool({ calls: prior ? [prior] : [] }, input, {
      now,
      cwd: input.cwd || process.cwd(),
      cliPath,
      canonicalFile,
    });
    if (state.calls.length) writeRecord(file, state.calls[0]);
    return {};
  }
  if (input.hook_event_name !== "Stop") return {};
  let files = [];
  try {
    files = readdirSync(callDirectory).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (files.length > 256) throw new Error("Review guard command scope exceeds its read limit");
  const calls = files
    .map((file) => boundedJson(path.join(callDirectory, file), 64 * 1024))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!calls.length) return {};
  const corrections = Object.fromEntries(
    calls.map((call) => [call.id, readOptional(path.join(correctionDirectory, `${callKey(call.id)}.json`), 64, 0)]),
  );
  const state = { calls, corrections };
  let handles = null;
  if (harness === "codex") {
    if (statSync(transcript).size > 16 * 1024 * 1024) throw new Error("Review guard transcript exceeds its read limit");
    const records = readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    handles = codexHandles(records, input.session_id, input.turn_id);
  } else if (path.basename(transcript) !== `${input.session_id}.jsonl`) {
    return { systemMessage: "Lavish did not apply the parent review guard to a child transcript." };
  }
  const runtimeStateFile = path.join(stateDir, "state.json");
  const indexFile = reviewSessionIndexPath(runtimeStateFile, { name: harness, sessionId: input.session_id });
  const index = readOptional(indexFile, 64 * 1024, { v: 1, active: [], recent: [] });
  if (index.v !== 1 || !Array.isArray(index.active) || !Array.isArray(index.recent))
    throw new Error("Invalid review attempt session index");
  const ids = [...new Set([...index.active, ...index.recent])];
  if (ids.length > 256 || !ids.every(validReviewAttempt))
    throw new Error("Review guard session index exceeds its read limit");
  const attempts = ids.map((id) => boundedJson(reviewAttemptPath(runtimeStateFile, id), 16 * 1024));
  const result = evaluateReviewStop({ harness, input, state, attempts, handles });
  if (!result.allow) {
    writeRecord(
      path.join(correctionDirectory, `${callKey(result.key)}.json`),
      (state.corrections[result.key] || 0) + 1,
    );
    return { decision: "block", reason: result.reason };
  }
  for (const call of calls) {
    const trackedTask =
      harness === "claude" &&
      call.taskId &&
      input.background_tasks?.some((task) => task.id === call.taskId && task.status === "running");
    if (trackedTask) continue;
    const key = callKey(call.id);
    rmSync(path.join(callDirectory, `${key}.json`), { force: true });
    rmSync(path.join(correctionDirectory, `${key}.json`), { force: true });
  }
  return result.warning ? { systemMessage: result.warning } : {};
}

export function guardFailureMessage(error) {
  const detail = createHash("sha256")
    .update(String(error?.message || error))
    .digest("hex")
    .slice(0, 8);
  return {
    systemMessage: `Lavish could not verify review state (guard check ${detail}). Hand back explicitly if listening stopped; queued feedback remains available through check-lavish.`,
  };
}
