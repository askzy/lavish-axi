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

1. Run `npx -y lavish-axi` with no arguments and read the session list it prints.
2. Pick the session this request is about: the artifact the user named, else one under the current
   working directory, else the most recently opened. Do NOT sweep every listed session - `open`
   sessions accumulate across conversations, so the list is not a list of live reviews.
3. If its pending prompts count is 0, say so in one line and stop. Do not open a long poll just to
   look, and do not reopen an ended session.
4. If the count is above 0, drain it with `npx -y lavish-axi poll <html-file> --timeout-ms 0`. That
   returns immediately instead of waiting.
5. Apply the returned prompts exactly as the `/lavish` workflow describes. A `layout-warnings`
   prompt is an explicit repair request; apply every listed fix in one pass.
6. To carry on the conversation in the browser, reply with
   `npx -y lavish-axi poll <html-file> --agent-reply "<message>"` and follow the `/lavish` wake-path
   rules from there. If the user is done, `npx -y lavish-axi end <html-file>`.

## Rules

- To collect queued feedback later - the `/check-lavish` path - run `npx -y lavish-axi` with no arguments and read the session list it prints: each listed session carries a pending prompts count, and anything above 0 has feedback waiting. Drain it with `npx -y lavish-axi poll <html-file> --timeout-ms 0`, which returns immediately instead of waiting. Scope this to the session you opened or to the current working directory, because `open` sessions accumulate across conversations.
- Do NOT silently re-run the poll after a reap. Every wake re-reads the whole conversation, so an unbounded re-poll loop is a standing token cost that grows with the session, and it is the reason an agent eventually decides it is stuck and abandons a review the user is still working through. Hand back instead: say in one line that you have stopped listening, that anything already sent is safely queued, and that `/check-lavish` will collect it.
- `Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited.
