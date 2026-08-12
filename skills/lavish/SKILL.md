---
name: lavish
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
argument-hint: <what the artifact should show>
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, visualization]
    category: productivity
---

# Lavish Editor

Lavish Editor helps agents turn rich HTML artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Lavish Editor. First generate an interactive HTML artifact according to user request, then run `npx -y lavish-axi <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `npx -y lavish-axi poll`.

You do not need lavish-axi installed globally - invoke it with `npx -y lavish-axi <html-file>`.
If lavish-axi output shows a follow-up command starting with `lavish-axi`, run it as `npx -y lavish-axi ...` instead.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lavish` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop

## Workflow

1. Create the HTML artifact (default location `.lavish/<name>.html` in the working directory).
2. Run `npx -y lavish-axi <html-file>` to open or resume a review session in the browser.
3. Run `npx -y lavish-axi poll <html-file>` to long-poll for the user's annotations and queued prompts.
   On the first poll, prefer `--agent-reply "<one-line summary of what you built and what to review first>"` so the conversation panel opens with context.
   Browser-detected layout issues are filed passively in the user's Layout issues inbox and arrive as an ordinary `layout-warnings` prompt only when the user selects and queues them. Never edit an issue the user has not queued. The only response that arrives without user action is `artifact_failures`, when the review surface itself is unusable.
   The poll stays silent until the user acts or a fatal artifact failure makes the review surface unusable - leave it running, never kill it.
   Cosmetic, intentional, transient, tiny, and uncertain observations remain silent.
   Run the poll in the foreground when your harness allows it, so it returns the feedback directly to the agent. If your harness caps how long a foreground command may run, running the poll as a background task is expected and supported.
   A background poll must go through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent.
   Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.
   If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor.
   Do not tell the user the artifact is being monitored until that wake path is live.
   A reaped or timed-out poll is expected and is not a failure: harnesses reap long-lived jobs on their own schedule, so it says nothing about whether the user is still reviewing, and queued feedback is never lost either way.
   Do NOT silently re-run the poll after a reap. Every wake re-reads the whole conversation, so an unbounded re-poll loop is a standing token cost that grows with the session, and it is the reason an agent eventually decides it is stuck and abandons a review the user is still working through. Hand back instead: say in one line that you have stopped listening, that anything already sent is safely queued, and that `/check-lavish` will collect it.
   To collect queued feedback later - the `/check-lavish` path - run `npx -y lavish-axi` with no arguments and read the session list it prints: each listed session carries a pending prompts count, and anything above 0 has feedback waiting. Drain it with `npx -y lavish-axi poll <html-file> --timeout-ms 0`, which returns immediately instead of waiting. Scope this to the session you opened or to the current working directory, because `open` sessions accumulate across conversations.
4. If poll returns feedback, apply the user's prompts. A `layout-warnings` prompt is an explicit repair request; apply every listed fix in one pass before saving, and let Lavish re-check it after a newer artifact load.
5. Apply human feedback, then poll again with `--agent-reply "<message>"` to reply in the browser and keep the loop going under the same foreground-or-verified-wake-path rule.
6. If a poll is reaped before the user sends anything, hand the review back rather than looping. One line is enough: you have stopped listening, anything already sent is safely queued, and `/check-lavish` will collect it. Do not re-enter the poll silently - see the wake-path rules in step 3 for why an unbounded loop is the wrong default.
7. `/check-lavish` (collect feedback later): run `npx -y lavish-axi` with no arguments, find the listed session for this review whose pending prompts count is above 0, then drain it with `npx -y lavish-axi poll <html-file> --timeout-ms 0` - that returns immediately instead of waiting. Apply the prompts exactly as in step 4. If that count is 0, say so and stop; do not open a long poll just to look.
8. Run `npx -y lavish-axi end <html-file>` when the review is finished.
9. `Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited. Deliver any remaining updates directly in this conversation.

## Visual guidance

- Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance
- Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose
- Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view
- Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately
- When the artifact would describe existing or current UI or state, show it instead: capture screenshots of the real pages (run the app read-only if needed) and embed them, rather than explaining the current look in prose; reserve prose for what cannot be shown such as rationale, trade-offs, and open questions

## Playbooks

Run `npx -y lavish-axi playbook <id>` for focused, detailed guidance on any of these.
One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox; open the diagram playbook and use the theme-aware Mermaid snippet from `npx -y lavish-axi design` unless SVG is needed for richly annotated nodes.

- `diagram` - Map relationships, flows, state, and architecture
- `table` - Turn dense records into scan-friendly review surfaces
- `comparison` - Show options, tradeoffs, and current vs target behavior
- `plan` - Explain a product or technical plan before implementation
- `code` - Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts
- `input` - Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact
- `slides` - Create a deliberate presentation when slides are requested

## Commands & rules

- Run `npx -y lavish-axi <html-file>` to open or resume a Lavish Editor session. If the user explicitly ended the session from the browser, this refuses to reopen it and explains why instead of reopening uninvited - pass `--reopen` only when the user asks for further review or something important needs their visual attention
- Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`
- Lavish serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work
- The artifact runs in a sandboxed iframe with an opaque origin, so `localStorage` and `sessionStorage` throw on any access. An unguarded top-level access aborts that whole `<script>` block, so the page still renders while every listener below it silently never attaches - wrap storage in try/catch and treat persistence as optional
- Run `npx -y lavish-axi poll <html-file>` to wait for user feedback. It long-polls and stays silent until the user sends feedback or ends the session, so leave it running - never kill it. Detected layout issues never return this poll: the browser files them in the user's Layout issues inbox in the Lavish top bar, and they arrive as an ordinary tag "layout-warnings" prompt only when the user selects them and queues the fixes. Never edit the artifact to chase a layout issue the user has not queued. The only exception is a fatal artifact_failures response, which means the review surface itself could not be used. Run the poll in the foreground when your harness allows it, so it returns the feedback directly to the agent. If your harness caps how long a foreground command may run, running the poll as a background task is expected and supported. A background poll must go through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent. Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive. If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor. Do not tell the user the artifact is being monitored until that wake path is live. A reaped or timed-out poll is expected and is not a failure: harnesses reap long-lived jobs on their own schedule, so it says nothing about whether the user is still reviewing, and queued feedback is never lost either way. Do NOT silently re-run the poll after a reap. Every wake re-reads the whole conversation, so an unbounded re-poll loop is a standing token cost that grows with the session, and it is the reason an agent eventually decides it is stuck and abandons a review the user is still working through. Hand back instead: say in one line that you have stopped listening, that anything already sent is safely queued, and that `/check-lavish` will collect it. To collect queued feedback later - the `/check-lavish` path - run `npx -y lavish-axi` with no arguments and read the session list it prints: each listed session carries a pending prompts count, and anything above 0 has feedback waiting. Drain it with `npx -y lavish-axi poll <html-file> --timeout-ms 0`, which returns immediately instead of waiting. Scope this to the session you opened or to the current working directory, because `open` sessions accumulate across conversations. `Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited.
- Run `npx -y lavish-axi` with no arguments to collect feedback the user queued while nothing was listening - this is the `/check-lavish` path. Each listed session carries a pending prompts count; anything above 0 has feedback waiting. Drain it with `npx -y lavish-axi poll <html-file> --timeout-ms 0`, which returns immediately rather than waiting, then apply the prompts as usual. Prefer the session you opened or one under the current working directory: `open` sessions accumulate across conversations, so a bare listing is not a list of live reviews
- Run `npx -y lavish-axi end <html-file>` to end a session as the agent - ending it this way still allows a plain reopen later. When the user ends it from the browser instead, a later `npx -y lavish-axi <html-file>` refuses to reopen it without `--reopen`
- Run `npx -y lavish-axi export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Lavish server and no sibling files. Remote CDN/font references are left as links, so it needs network to render those. Users can also export from the browser chrome's overflow menu
- Run `npx -y lavish-axi stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected)
- Run `npx -y lavish-axi playbook <playbook_id>` for focused artifact guidance. One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
- Lavish does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without lavish-axi running. Before writing any HTML: Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN, and prefer that CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user. Run `npx -y lavish-axi design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference. When you deliver the artifact, state which of the three design sources you used and why.
- Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop
