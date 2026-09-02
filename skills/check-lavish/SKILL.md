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
   instead of waiting. Run it whether or not the file appears in the list: a session the user ended
   is absent from the list but still delivers its queued feedback once.
3. Read the result. `session_ended: true` means the user is done - apply what came back, deliver
   any further updates in this conversation, and do not reopen. An empty result means the queue is
   empty _right now_, not that the user sent nothing; rule out a drained queue (below) before
   reporting "no feedback". Do not open a long poll just to look.
4. Apply the returned prompts exactly as the `/lavish` workflow describes. A `layout-warnings`
   prompt is an explicit repair request; apply every listed fix in one pass.
5. If the session is still open and you want to carry on in the browser, reply with
   `npx -y lavish-axi poll <html-file> --agent-reply "<message>"` and follow the `/lavish` wake-path
   rules from there. If the user is done, `npx -y lavish-axi end <html-file>`.

## When the queue is empty but the user says they sent feedback

A poll that collected the feedback and then exited took it with it - typically a poll a subagent
started and left behind. Signals: the browser is stuck on "Working" or a spinner, or a recent
background job in this session's `tasks/` directory contains a `prompts[` block. The last one is
decisive:

```bash
grep -l 'prompts\[' /private/tmp/claude-501/<cwd-slug>/<session-uuid>/tasks/*.output
```

Read the newest match, treat its `prompts[N]{uid,prompt,selector,tag,text}:` block as the feedback,
apply it normally, then reply into the browser so it stops spinning. A bash background-job
`.output` file is plain text and safe to read, unlike a subagent's JSONL transcript.

## Rules

- To collect queued feedback later - the `/check-lavish` path - start from the artifact you already know: the html file this session or its subagents passed to `npx -y lavish-axi`, else the newest file under `.lavish/` in the working directory. Drain it directly with `npx -y lavish-axi poll <html-file> --timeout-ms 0`, which returns immediately instead of waiting. Do this whether or not the file appears in the no-argument session list: a session the user ended is absent from that list but still delivers its queued feedback once, and `session_ended: true` in the result means stop after this drain and do not reopen. Only when the conversation names no artifact, run `npx -y lavish-axi` with no arguments and pick from the list it prints; each listed session carries a pending prompts count, and `open` sessions accumulate across conversations, so the list is neither complete nor live.
- Do NOT silently re-run the poll after a reap. Every wake re-reads the whole conversation, so an unbounded re-poll loop is a standing token cost that grows with the session, and it is the reason an agent eventually decides it is stuck and abandons a review the user is still working through. Hand back instead: say in one line that you have stopped listening, that anything already sent is safely queued, and that `/check-lavish` will collect it.
- A subagent must NEVER own a Lavish poll. The poll delivers to whoever started it, so when the subagent exits the prompts land in an output file nobody reads and no completion notification reaches the session that can act on them. When delegating artifact edits, forbid `npx -y lavish-axi` in the brief; the parent polls after the subagent returns.
- `Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited.
