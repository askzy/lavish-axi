import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  codexHandles,
  directReviewCommand,
  evaluateReviewStop,
  guardScope,
  observeReviewTool,
} from "../src/review-guard.js";
import { updateReviewAttempt, reviewSessionIndexPath } from "../src/review-attempts.js";
import { runReviewGuard } from "../src/review-guard-hook.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/review-guard-native.json", import.meta.url), "utf8"));
const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const attemptId = "11111111-1111-4111-8111-111111111111";

function reviewState() {
  return { calls: [{ id: "native-tool", file: "/review.html", kind: "open", startedAt: 1000 }], corrections: {} };
}

function attempt(fields = {}) {
  return {
    v: 1,
    id: attemptId,
    file: "/review.html",
    createdAt: 1001,
    listenerStartedAt: 1002,
    finishedAt: null,
    harness: { name: "codex", sessionId: fixture.codexSession },
    ...fields,
  };
}

function evaluate(fields = {}) {
  return evaluateReviewStop({
    harness: "codex",
    input: { session_id: fixture.codexSession },
    state: reviewState(),
    attempts: [attempt()],
    handles: { cells: ["1"], sessions: [] },
    ...fields,
  });
}

test("actual Codex Stop snapshot retains yielded outer cell", () => {
  assert.deepEqual(codexHandles(fixture.codexFirst, fixture.codexSession, fixture.codexTurn), {
    cells: ["1"],
    sessions: [],
    completedTools: [],
  });
});

test("actual Codex wait completion still retains native running command", () => {
  assert.deepEqual(codexHandles(fixture.codexSecond, fixture.codexSession, fixture.codexTurn), {
    cells: [],
    sessions: ["73520"],
    completedTools: [],
  });
});

test("child and another session cannot satisfy parent tool state", () => {
  assert.equal(codexHandles(fixture.codexFirst, "other-session", fixture.codexTurn), null);
  const child = structuredClone(fixture.codexFirst);
  child[0].payload.parent_thread_id = "parent";
  assert.equal(codexHandles(child, fixture.codexSession, fixture.codexTurn), null);
  assert.notEqual(guardScope("codex", "parent", "/same/transcript"), guardScope("codex", "child", "/same/transcript"));
  assert.notEqual(guardScope("codex", "parent", "/a"), guardScope("codex", "parent", "/b"));
});

test("direct native command registration excludes source snippets and read-only drains", () => {
  assert.deepEqual(directReviewCommand(`node '${cliPath}' '/tmp/review file.html' --no-open`, "/tmp", cliPath), {
    kind: "open",
    file: "/tmp/review file.html",
  });
  assert.equal(directReviewCommand(`node '${cliPath}' /tmp/review.html --view-only`, "/tmp", cliPath), null);
  assert.equal(directReviewCommand(`node '${cliPath}' poll /tmp/review.html --timeout-ms 0`, "/tmp", cliPath), null);
  assert.equal(
    directReviewCommand(`text(await tools.exec_command({cmd:"node ${cliPath} /tmp/review.html"}))`, "/tmp", cliPath),
    null,
  );
  assert.equal(directReviewCommand(`node '${cliPath}' /tmp/review.html &`, "/tmp", cliPath), null);
});

test("Codex active listener and unread results require native waiting", () => {
  assert.equal(evaluate().allow, false);
  assert.match(evaluate().reason, /functions.wait cell_id=1/);
  assert.match(evaluate({ handles: { cells: [], sessions: ["73520"] } }).reason, /write_stdin session_id=73520/);
  assert.equal(evaluate({ attempts: [attempt({ finishedAt: 1003, outcome: "feedback" })] }).allow, false);
});

test("never-started and legacy successful opens are corrected", () => {
  assert.match(evaluate({ attempts: [attempt({ listenerStartedAt: null })] }).reason, /has not started listening/);
  const state = reviewState();
  state.calls[0].legacyOpened = true;
  assert.equal(evaluate({ state, attempts: [] }).allow, false);
});

test("terminal state survives absent listener and permits handoff once native result is read", () => {
  for (const outcome of ["socket_closed", "browser_disconnected", "ended", "replaced", "error", "feedback"]) {
    const state = reviewState();
    state.calls[0].completed = true;
    assert.equal(
      evaluate({ state, attempts: [attempt({ finishedAt: 1003, outcome })], handles: { cells: [], sessions: [] } })
        .allow,
      true,
    );
  }
});

test("another session and another artifact do not create a review obligation", () => {
  const state = reviewState();
  state.calls[0].completed = true;
  assert.equal(
    evaluate({ state, attempts: [attempt({ harness: { name: "codex", sessionId: "other-session" } })] }).allow,
    true,
  );
  assert.equal(evaluate({ state, attempts: [attempt({ file: "/different.html" })] }).allow, true);
});

test("corrections are bounded and unknown native state allows explicit handoff", () => {
  const state = reviewState();
  state.corrections["native-tool"] = 2;
  assert.match(evaluate({ state }).warning, /after two corrections/);
  assert.equal(evaluate({ handles: null }).allow, true);
});

test("Claude allows only the exact native tracked task observed by this parent", () => {
  const pre = fixture.claudeEvents.find((event) => event.hook_event_name === "PreToolUse");
  const post = fixture.claudeEvents.find((event) => event.hook_event_name === "PostToolUse");
  const stop = fixture.claudeEvents.find((event) => event.hook_event_name === "Stop");
  const state = reviewState();
  state.calls[0].command = pre.tool_input.command;
  state.calls[0].taskId = post.tool_response.backgroundTaskId;
  const active = attempt({ harness: { name: "claude", sessionId: stop.session_id } });
  assert.equal(evaluate({ harness: "claude", input: stop, state, attempts: [active], handles: null }).allow, true);
  assert.equal(
    evaluate({
      harness: "claude",
      input: { ...stop, background_tasks: [{ ...stop.background_tasks[0], id: "unrelated" }] },
      state,
      attempts: [active],
      handles: null,
    }).allow,
    true,
  );
  assert.equal(
    evaluate({ harness: "claude", input: { ...stop, background_tasks: [] }, state, attempts: [active], handles: null })
      .allow,
    true,
  );
});

test("hook stores exact session/transcript state and limits repeated Stop corrections", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "lavish-guard-"));
  try {
    const transcript = path.join(directory, "transcript.jsonl");
    writeFileSync(transcript, fixture.codexFirst.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const input = {
      session_id: fixture.codexSession,
      turn_id: fixture.codexTurn,
      transcript_path: transcript,
      cwd: directory,
    };
    const options = { stateDir: directory, cliPath, now: 1000 };
    const command = `node '${cliPath}' /review.html --no-open`;
    assert.deepEqual(
      runReviewGuard(
        {
          ...input,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "native-tool",
          tool_input: { command },
        },
        "codex",
        options,
      ),
      {},
    );
    updateReviewAttempt(path.join(directory, "state.json"), attemptId, attempt());
    const stop = { ...input, hook_event_name: "Stop" };
    assert.equal(runReviewGuard(stop, "codex", options).decision, "block");
    assert.equal(runReviewGuard(stop, "codex", options).decision, "block");
    assert.match(runReviewGuard(stop, "codex", options).systemMessage, /two corrections/);
    assert.deepEqual(runReviewGuard({ ...stop, session_id: "different-parent" }, "codex", options), {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recognized startup command is corrected before runtime preparation", () => {
  assert.equal(evaluate({ attempts: [] }).allow, false);
});

test("completed own review ignores unrelated running tools", () => {
  const state = reviewState();
  state.calls[0].completed = true;
  assert.equal(evaluate({ state, attempts: [attempt({ finishedAt: 1003, outcome: "feedback" })] }).allow, true);
});

test("actual full-wait completion retires the exact native process", () => {
  const handles = codexHandles(fixture.codexFull, fixture.codexFullSession, fixture.codexFullTurn);
  assert.deepEqual(handles.cells, []);
  assert.deepEqual(handles.sessions, []);
  assert.ok(handles.completedTools.includes("exec-48bacee6-5c06-44d8-9ebe-8c2b62a802aa"));
});

test("native TOON legacy output is recognized in Codex string and Claude stdout", () => {
  const command = `node '${cliPath}' /review.html`;
  const options = { now: 1000, cwd: "/", cliPath, canonicalFile: (file) => file };
  for (const tool_response of [
    "session:\n  file: /review.html\n  url: http://localhost:4387/session/example\n  status: opened\nnext_step: Poll now",
    {
      stdout:
        "session:\n  file: /review.html\n  url: http://localhost:4387/session/example\n  status: ready\nnext_step: Poll now",
    },
  ]) {
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "legacy-tool",
      tool_input: { command },
      tool_response,
    };
    const state = observeReviewTool({ calls: [] }, input, options);
    assert.equal(state.calls[0].legacyOpened, true);
    assert.equal(evaluate({ state, attempts: [] }).allow, false);
    const resumed = observeReviewTool(
      state,
      {
        ...input,
        hook_event_name: "PreToolUse",
        tool_use_id: "parent-poll",
        tool_input: { command: `node '${cliPath}' poll /review.html` },
      },
      { ...options, now: 2000 },
    );
    assert.equal(resumed.calls[0].superseded, true);
    assert.equal(evaluate({ state: resumed, attempts: [] }).key, "parent-poll");
  }
});

test("old interrupted turns do not trap the next user turn", () => {
  const state = reviewState();
  state.calls[0].turnId = "previous-turn";
  assert.equal(evaluate({ state, input: { session_id: fixture.codexSession, turn_id: "new-turn" } }).allow, true);
  assert.equal(evaluate({ attempts: [attempt({ finishedAt: 1003, outcome: "socket_closed" })] }).allow, false);
});

test("session attempt index retains active reviews beyond the historical limit", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "lavish-index-"));
  try {
    const stateFile = path.join(directory, "state.json");
    const harness = { name: "codex", sessionId: fixture.codexSession };
    updateReviewAttempt(stateFile, attemptId, attempt());
    for (let n = 0; n < 70; n++) {
      const id = `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
      updateReviewAttempt(stateFile, id, attempt({ id, finishedAt: 1003 }));
    }
    const index = JSON.parse(readFileSync(reviewSessionIndexPath(stateFile, harness), "utf8"));
    assert.deepEqual(index.active, [attemptId]);
    assert.equal(index.recent.length, 64);
    updateReviewAttempt(stateFile, attemptId, { finishedAt: 1004, outcome: "socket_closed" });
    assert.deepEqual(JSON.parse(readFileSync(reviewSessionIndexPath(stateFile, harness), "utf8")).active, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a preceding terminal attempt cannot satisfy a newly starting review", () => {
  assert.equal(
    evaluate({ attempts: [attempt({ createdAt: 999, finishedAt: 1000, outcome: "conflict" })] }).allow,
    false,
  );
});

test("child runtime terminal cannot clear the parent's pending native command", () => {
  assert.equal(evaluate({ attempts: [attempt({ finishedAt: 1003, outcome: "conflict" })] }).allow, false);
  assert.equal(
    evaluate({
      harness: "claude",
      attempts: [
        attempt({
          harness: { name: "claude", sessionId: fixture.codexSession },
          finishedAt: 1003,
          outcome: "socket_closed",
        }),
      ],
      handles: null,
    }).allow,
    false,
  );
});

test("explicit open is registered like the default invocation", () => {
  assert.deepEqual(directReviewCommand(`node '${cliPath}' open /tmp/review.html`, "/tmp", cliPath), {
    kind: "open",
    file: "/tmp/review.html",
  });
});

test("parallel native observers preserve every review command", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "lavish-parallel-guard-"));
  try {
    const transcript = path.join(directory, "transcript.jsonl");
    writeFileSync(transcript, fixture.codexFirst.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await Promise.all(
      Array.from(
        { length: 12 },
        (_, index) =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [fileURLToPath(new URL("../bin/lavish-review-guard.js", import.meta.url)), "codex"],
              { env: { ...process.env, LAVISH_AXI_STATE_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] },
            );
            child.on("error", reject);
            child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Observer exited ${code}`))));
            child.stdin.end(
              JSON.stringify({
                session_id: fixture.codexSession,
                turn_id: fixture.codexTurn,
                transcript_path: transcript,
                cwd: directory,
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_use_id: `parallel-tool-${index}`,
                tool_input: { command: `node '${cliPath}' /review-${index}.html --no-open` },
              }),
            );
          }),
      ),
    );
    const scope = guardScope("codex", fixture.codexSession, realpathSync(transcript));
    const records = readdirSync(path.join(directory, "review-guard", scope, "calls")).map((file) =>
      JSON.parse(readFileSync(path.join(directory, "review-guard", scope, "calls", file), "utf8")),
    );
    assert.equal(new Set(records.map((record) => record.id)).size, 12);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
