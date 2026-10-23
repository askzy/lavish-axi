---
name: check-lavish
description: Collect feedback a user queued on a Lavish artifact while no agent was listening, without opening a long poll. Use when the user asks to check Lavish, asks whether feedback came back on an artifact or review page, or says they have sent notes on something you showed them.
argument-hint: "[artifact path or nothing]"
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, feedback]
    category: productivity
---

# Check Lavish for queued feedback

You do not need lavish-axi installed globally - invoke it with `npx -y lavish-axi <html-file>`.

## Why this exists

A Lavish poll is a long-lived job, and harnesses reap those on their own schedule. The `/lavish`
skill therefore hands the review back instead of looping forever. Nothing is lost when it does:
the server keeps queued feedback and delivers it to the next poll that attaches. This skill is
that next poll.

## Steps

1. Name the artifact before touching the session list. It is the html file this session, or a
   subagent it dispatched, passed to `npx -y lavish-axi` - subagent reports carry the path. If the
   conversation names nothing, take the newest file under `.lavish/` in the working directory.
   Only when both come up empty, run `npx -y lavish-axi` with no arguments and pick from the list it
   prints: the artifact the user named, else one under the current working directory. Do NOT sweep
   every listed session - `open` sessions accumulate across conversations, and the list omits
   sessions the user has ended, so it is neither complete nor live.
2. Drain it with `npx -y lavish-axi poll <html-file> --timeout-ms 0`. That returns immediately
   instead of waiting, and it is never refused: a drain claims no listener, so it works while another
   poll holds the session. Run it whether or not the file appears in the list: a session the user
   ended is absent from the list but still delivers its queued feedback once.
3. Read the result. `session_ended: true` means the user is done - apply what came back, deliver
   any further updates in this conversation, and do not reopen. An empty result means the queue is
   empty _right now_, not that the user sent nothing; rule out a leased batch (below) before
   reporting "no feedback". Do not open a long poll just to look, and leave the session open when the queue is empty.
4. Apply the returned prompts exactly as the `/lavish` workflow describes. A `layout-warnings`
   prompt is an explicit repair request; apply every listed fix in one pass.
5. If the session is still open and you want to carry on in the browser, reply with
   `npx -y lavish-axi poll <html-file> --agent-reply "<message>"` and follow the `/lavish` wake-path
   rules from there. To post the result without waiting for more feedback, use `npx -y lavish-axi reply <html-file> --agent-reply "<message>"` - it exits once the
   server accepts the reply, so the review page clears its waiting message. End the session only when the user explicitly says the review is finished or asks to end it. A finished agent turn, an empty drain, a timeout, a reap, or a browser disconnect does not mean the user is done: leave the session open. A polite thanks alone is not a completion request.
   If the user explicitly finishes the review, run `npx -y lavish-axi end <html-file>`. A reply claims no listener, so it is never refused while
   another poll holds the session; on an ended session it exits with `SESSION_ENDED` and the
   update belongs in this conversation instead.

## When the queue is empty but the user says they sent feedback

Delivered feedback stays leased to the poll that took it for about a minute. A poll that collected
the feedback and then exited before acknowledging it - typically a poll a subagent started and left
behind - leaves that lease to expire, and the next drain delivers the batch again. Signals: the
browser still shows an unanswered note, or the drain came back `waiting` with a
`retry_after_ms`. Wait that long, then drain again with `--timeout-ms 0`; the prompts come back.
Apply them normally, then reply into the browser to clear the waiting message - `npx -y lavish-axi reply
<html-file> --agent-reply "<message>"` does that without opening a long poll, and it retires the
lease.

## Rules

- The parent session runs `npx -y lavish-axi <html-file>` to claim a listener, open the review, and wait in one tracked command. Subagents only build or edit the artifact and return its path. Use `--view-only` only for an explicitly requested read-only page. `--no-open` suppresses the browser launch and still listens.
- Run the poll in the foreground when your harness allows it, so it returns the feedback directly to the agent. If your harness caps how long a foreground command may run, running the poll as a background task is expected and supported.
- Codex: when exec_command yields a session_id, the poll is still running. Continue waiting with repeated write_stdin calls on that same session_id until the command exits. When functions.exec yields a running cell, continue with repeated functions.wait calls on the same cell_id. Continuing a running command is not starting another poll. Use waits of at most 60 seconds so you can share progress, without adding a timeout to the poll itself. A running handle is not a completion notification: stay in the active turn and do not send a final answer while claiming to listen.
- Claude: start the poll as a harness-native tracked background task, retain its task identity, and handle its completion notification in the same parent session. Starting the task is required before handing back the review; opening the page alone does not start listening.
- A background poll must go through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent.
- Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.
- If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor.
- Do not tell the user the artifact is being monitored until that wake path is live.
- A reaped or timed-out poll is expected and is not a failure: harnesses reap long-lived jobs on their own schedule, so it says nothing about whether the user is still reviewing, and queued feedback is never lost either way.
- Read a delivered poll response completely before truncating or filtering it: the user's `prompts`, any `artifact_failures`, and the `next_step` instruction come first, and the bulky `dom_snapshot` comes last.
- Do NOT silently re-run the poll after a reap. This applies only after a poll actually exits, not before the first poll or when a tool yields a running handle. Hand back instead: leave the session open and say in one line that you have stopped listening, that anything already sent is safely queued, and that `/check-lavish` will collect it.
- To collect queued feedback later - the `/check-lavish` path - start from the artifact you already know: the html file this session or its subagents passed to `npx -y lavish-axi`, else the newest file under `.lavish/` in the working directory. Drain it directly with `npx -y lavish-axi poll <html-file> --timeout-ms 0`, which returns immediately instead of waiting. Do this whether or not the file appears in the no-argument session list: a session the user ended is absent from that list but still delivers its queued feedback once, and `session_ended: true` in the result means stop after this drain and do not reopen. Only when the conversation names no artifact, run `npx -y lavish-axi` with no arguments and pick from the list it prints; each listed session carries a pending prompts count, and `open` sessions accumulate across conversations, so the list is neither complete nor live.
- If the poll returns `browser_disconnected`, the user closed the review page (every review tab stayed disconnected past a short grace period). Say so in one line and stop polling. Leave the session open and resumable; do not reopen it uninvited or end it because the browser disconnected. Anything already sent is safely leased, and `/check-lavish` will collect it.
- End the session only when the user explicitly says the review is finished or asks to end it. A finished agent turn, an empty drain, a timeout, a reap, or a browser disconnect does not mean the user is done: leave the session open. A polite thanks alone is not a completion request.
- One poll listens per session: a second `npx -y lavish-axi poll` without `--takeover` fails with `LISTENER_ACTIVE` instead of silently returning waiting, and the error names the current listener's label and age. Treat it as a live poll elsewhere - usually one this conversation or a subagent left running - not as a server fault: do not retry it in a loop and do not start another listener to look. The zero-timeout drain (`npx -y lavish-axi poll <html-file> --timeout-ms 0`, the `/check-lavish` path) is never refused - it claims no listener and returns the queue at once - so collect queued feedback that way while the holder keeps waiting. `npx -y lavish-axi reply <html-file> --agent-reply "<message>"` is never refused either: it posts the reply and exits once the server accepts it, claims no listener, and leaves the holder listening. Pass `--takeover` only when you mean to displace the holder; it exits with `LISTENER_REPLACED` and stops listening. Pass `--owner <label>` to make your listener visible in session listings and in the refusal others see.
- A subagent must NEVER own a Lavish poll. The poll delivers to whoever started it, so when the subagent exits the prompts land in an output file nobody reads and no completion notification reaches the session that can act on them. When delegating artifact edits, forbid `npx -y lavish-axi` in the brief; the parent polls after the subagent returns.
- `Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited.
