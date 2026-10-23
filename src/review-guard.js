import crypto from "node:crypto";
import path from "node:path";

import { decode } from "@toon-format/toon";

export function guardScope(harness, sessionId, transcriptPath) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([harness, sessionId, transcriptPath]))
    .digest("hex");
}

export function directReviewCommand(command, cwd, cliPath, canonicalFile = (file) => file) {
  if (typeof command !== "string" || /[\n\r;&|<>`$\\]/.test(command)) return null;
  const words = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g);
  if (
    !words ||
    words
      .map((word) => word)
      .join(" ")
      .replace(/\s+/g, " ") !== command.trim().replace(/\s+/g, " ")
  )
    return null;
  const args = words.map((word) => (/^["']/.test(word) ? word.slice(1, -1) : word));
  const executable = args.shift();
  if (path.basename(executable || "") === "node") {
    if (canonicalFile(path.resolve(cwd, args.shift() || "")) !== canonicalFile(cliPath)) return null;
  } else if (path.basename(executable || "") !== "lavish-axi") return null;
  const kind = ["poll", "open"].includes(args[0]) ? args.shift() : "open";
  if (!args[0] || !/\.html?$/i.test(args[0])) return null;
  const file = path.resolve(cwd, args.shift());
  if (args.includes("--view-only") || (args.includes("--timeout-ms") && args[args.indexOf("--timeout-ms") + 1] === "0"))
    return null;
  return { kind, file };
}

function outputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output))
    return output
      .filter((item) => item.type === "input_text" || item.type === "text")
      .map((item) => item.text)
      .join("\n");
  return "";
}

function jsonValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function codexHandles(records, sessionId, turnId) {
  const meta = records.find((record) => record.type === "session_meta")?.payload;
  if (!meta || meta.id !== sessionId || meta.parent_thread_id || meta.thread_source === "subagent") return null;
  const cells = new Set();
  const sessions = new Set();
  const calls = new Map();
  const completedTools = new Set();
  const completedProcesses = new Set();
  let activeTurn = null;
  for (const record of records) {
    if (record.type === "turn_context") activeTurn = record.payload?.turn_id;
    if (
      record.type === "event_msg" &&
      record.payload?.thread_id === sessionId &&
      record.payload?.turn_id === turnId &&
      record.payload?.item?.type === "CommandExecution" &&
      record.payload.item.status !== "in_progress"
    ) {
      completedTools.add(record.payload.item.id);
      completedProcesses.add(String(record.payload.item.process_id));
      sessions.delete(String(record.payload.item.process_id));
    }
    if (record.type !== "response_item") continue;
    const item = record.payload;
    const itemTurn = item.internal_chat_message_metadata_passthrough?.turn_id || activeTurn;
    if (itemTurn !== turnId) continue;
    if (["custom_tool_call", "function_call"].includes(item.type)) {
      calls.set(item.call_id, item);
      continue;
    }
    if (!["custom_tool_call_output", "function_call_output"].includes(item.type)) continue;
    const call = calls.get(item.call_id);
    if (!call) continue;
    const name = call.name?.replace(/^functions\./, "");
    const text = outputText(item.output);
    const args = jsonValue(call.arguments || "{}");
    if (name === "wait" && args?.cell_id) cells.delete(String(args.cell_id));
    if (name === "write_stdin" && args?.session_id) sessions.delete(String(args.session_id));
    if (!["exec", "wait", "exec_command", "write_stdin"].includes(name)) continue;
    const running = /^Script running with cell ID ([A-Za-z0-9_-]+)(?:\n|$)/.exec(text);
    if (running) cells.add(running[1]);
    for (const line of text.split("\n")) {
      const result = jsonValue(line);
      if (!result || typeof result !== "object" || Array.isArray(result)) continue;
      if (typeof result.session_id === "number" && typeof result.exit_code !== "number")
        sessions.add(String(result.session_id));
      if (typeof result.session_id === "number" && typeof result.exit_code === "number")
        sessions.delete(String(result.session_id));
    }
  }
  return {
    cells: [...cells],
    sessions: [...sessions].filter((id) => !completedProcesses.has(id)),
    completedTools: [...completedTools],
  };
}

export function observeReviewTool(state, input, { now, cwd, cliPath, canonicalFile }) {
  if (input.tool_name !== "Bash" || !input.tool_use_id) return state;
  const command = input.tool_input?.command;
  const review = directReviewCommand(command, cwd, cliPath, canonicalFile);
  if (!review) return state;
  const calls = [...(state.calls || [])];
  let call = calls.find((item) => item.id === input.tool_use_id);
  if (!call) {
    const file = canonicalFile(review.file);
    for (const prior of calls) {
      if (prior.file === file && prior.completed && prior.legacyOpened) prior.superseded = true;
    }
    call = {
      id: input.tool_use_id,
      command,
      ...review,
      file: canonicalFile(review.file),
      startedAt: now,
      turnId: input.turn_id || null,
    };
    calls.push(call);
  }
  if (input.hook_event_name === "PostToolUse") {
    call.completed = true;
    call.taskId = input.tool_response?.backgroundTaskId || null;
    const raw = typeof input.tool_response === "string" ? input.tool_response : input.tool_response?.stdout || "";
    let output = jsonValue(raw);
    if (!output) {
      const start = raw.search(/^session:\r?$/m);
      if (start >= 0) {
        try {
          output = decode(raw.slice(start));
        } catch {
          output = null;
        }
      }
    }
    if (output?.session?.file && canonicalFile(output.session.file) !== call.file) output = null;
    if (input.tool_response?.interrupted) call.terminal = true;
    if (output?.session?.file && ["opened", "ready"].includes(output.session.status)) call.legacyOpened = true;
    if (
      output?.session?.session_ended ||
      ["browser_disconnected", "ended", "user-ended"].includes(output?.session?.status)
    )
      call.terminal = true;
  }
  return { ...state, calls: calls.slice(-32) };
}

export function evaluateReviewStop({ harness, input, state, attempts, handles }) {
  for (const call of state.calls || []) {
    if (harness === "codex" && call.turnId && call.turnId !== input.turn_id) continue;
    const later = state.calls.some((other) => other.file === call.file && other.startedAt > call.startedAt);
    if (call.terminal || call.superseded || (call.completed && call.legacyOpened && later)) continue;
    if (harness === "claude" && call.taskId) {
      if (!Array.isArray(input.background_tasks))
        return {
          allow: true,
          warning:
            "Lavish could not verify the native background task registry. Hand back explicitly if listening stopped; queued feedback remains available through check-lavish.",
        };
      const task = input.background_tasks.find((task) => task.id === call.taskId);
      if (!task) continue;
      if (task.type === "shell" && task.command === call.command) continue;
      return {
        allow: true,
        warning:
          "Lavish could not match the native background task to this parent's review command. Hand back explicitly if listening stopped; queued feedback remains available through check-lavish.",
      };
    }
    const attempt = attempts
      .filter(
        (attempt) =>
          attempt.v === 1 &&
          attempt.harness?.name === harness &&
          attempt.harness.sessionId === input.session_id &&
          attempt.file === call.file &&
          attempt.createdAt >= call.startedAt,
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const nativeCompleted = (call.completed && !call.taskId) || handles?.completedTools?.includes(call.id);
    if (nativeCompleted && !call.legacyOpened) continue;

    const key = call.id;
    const count = state.corrections?.[key] || 0;
    const handoff =
      "Leave the review open. If listening has stopped, say so clearly and point to check-lavish for queued feedback.";
    if (count >= 2)
      return { allow: true, warning: `Lavish could not verify continued listening after two corrections. ${handoff}` };
    if (harness === "codex" && handles === null)
      return { allow: true, warning: `Lavish could not verify this transcript's native tool state. ${handoff}` };
    let action = `The Lavish review for ${call.file} has not started listening. Start its first parent-owned poll before finishing.`;
    if (attempt?.listenerStartedAt || (!call.legacyOpened && !attempt)) {
      const waits = [
        ...(handles?.cells || []).map((id) => `functions.wait cell_id=${id}`),
        ...(handles?.sessions || []).map((id) => `write_stdin session_id=${id}`),
      ];
      action = `The parent-owned Lavish review for ${call.file} is still waiting. Continue the active turn${waits.length ? ` with ${waits.join(" or ")}` : " and wait for its native tracked command"}. A live listener alone does not permit a final answer.`;
    }
    return {
      allow: false,
      key,
      reason: `${action} Do not restart a running poll. After an actual reap, disconnect, user end, or interruption, hand back explicitly instead of polling again.`,
    };
  }
  return { allow: true };
}
