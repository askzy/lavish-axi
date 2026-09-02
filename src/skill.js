import { realpathSync } from "node:fs";
import path from "node:path";

import {
  POLL_HANDOFF_RULE,
  POLL_PICKUP_RULE,
  POLL_SEND_AND_END_RULE,
  POLL_WAKE_PATH_RULES,
  createHomeOutput,
} from "./cli.js";
import { PLAYBOOK_ROUTER_HELP } from "./playbooks.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "about to show something visual" intents.
export const SKILL_DESCRIPTION =
  "Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can " +
  "annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, " +
  "comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.";

// Trigger string for the companion pickup skill. The /lavish skill deliberately stops listening
// when a poll is reaped rather than looping (see POLL_HANDOFF_RULE), so this is how an agent gets
// back to feedback the user queued in the meantime. Phrased around the user's words, not the
// mechanism, because the user says "did anything come back" far more often than "drain the poll".
export const CHECK_SKILL_DESCRIPTION =
  "Collect feedback a user queued on a Lavish artifact while no agent was listening, without " +
  "opening a long poll. Use when the user asks to check Lavish, asks whether feedback came back " +
  "on an artifact or review page, or says they have sent notes on something you showed them.";

// How the published skill tells agents to invoke the CLI: no global install, no prompt.
export const NPX_INVOCATION = "npx -y lavish-axi";

/**
 * Invocation for a checkout of this fork, which must never route through npm: `npx -y lavish-axi`
 * resolves to upstream's published package, bypassing the fork's disabled sharing and its guards.
 * The caller derives `repoRoot` from its own location so no absolute path is ever committed.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {string} e.g. `node /path/to/lavish-axi/dist/cli.mjs`
 */
export function localInvocation(repoRoot) {
  return `node ${path.join(repoRoot, "dist", "cli.mjs")}`;
}

/**
 * Pick the shortest path that is provably the same directory as `derivedRoot`.
 *
 * Node realpaths `import.meta.url`, so a derived root can be far longer than the path a human uses
 * for the same checkout - a symlinked `~/Work` into Dropbox's `CloudStorage` directory turns 39
 * characters into 130. The local skill repeats its invocation more than a dozen times and loads
 * into every session, so the difference is real context. It is only worth taking when the shorter
 * form is verified rather than string-guessed: an unverified shortcut points every agent at a path
 * that may not exist, which is worse than a long path that works. So each candidate must realpath
 * to the same directory, and the realpath is the fallback when none qualifies.
 *
 * `PWD` is the useful candidate because a shell sets it unresolved, so it holds the short form when
 * the build is run from the checkout. `INIT_CWD` (npm's own cwd) is usually already resolved and
 * simply loses on length, but it costs nothing to offer.
 *
 * @param {string} derivedRoot absolute path derived from the caller's own location
 * @param {(string | undefined)[]} [candidates] unresolved alternatives to try, shortest wins
 * @returns {string} the shortest verified candidate, else `derivedRoot` realpathed
 */
export function shortestEquivalentPath(derivedRoot, candidates = [process.env.PWD, process.env.INIT_CWD]) {
  const target = realpathSync(derivedRoot);
  let best = target;

  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    const normalized = path.resolve(candidate);
    if (normalized.length >= best.length) {
      continue;
    }
    try {
      if (realpathSync(normalized) === target) {
        best = normalized;
      }
    } catch {
      // a candidate that does not resolve is not a candidate
    }
  }

  return best;
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function playbookList(playbooks) {
  return playbooks.map((p) => `- \`${p.id}\` - ${p.use_when}`).join("\n");
}

function installNote(invocation) {
  if (invocation === NPX_INVOCATION) {
    return `You do not need lavish-axi installed globally - invoke it with \`${invocation} <html-file>\`.`;
  }
  return (
    "This install is the local fork (askzy/lavish-axi), which has the `share` and `setup hooks` subcommands disabled. " +
    `Always invoke it as \`${invocation} <html-file>\` - never \`npx lavish-axi\`, which would fetch the upstream ` +
    "package and bypass the fork."
  );
}

/**
 * Render the installable SKILL.md for the lavish skill. The body mirrors what
 * `lavish-axi` prints with no arguments (minus live session state), while the
 * frontmatter adds discovery metadata for Agent Skills and Hermes Agent.
 *
 * @param {object} [options]
 * @param {string} [options.invocation] how the skill tells agents to invoke the CLI. Defaults to
 *   the published `npx -y lavish-axi`; pass `localInvocation(repoRoot)` for the checkout-local
 *   flavor, which swaps the install line for the fork note.
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown({ invocation = NPX_INVOCATION } = {}) {
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false });
  const skillCommandText = (text) => text.replaceAll("`lavish-axi", `\`${invocation}`);

  return `---
name: lavish
description: ${SKILL_DESCRIPTION}
argument-hint: <what the artifact should show>
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, visualization]
    category: productivity
---

# Lavish Editor

${skillCommandText(home.description)}

${installNote(invocation)}
If lavish-axi output shows a follow-up command starting with \`lavish-axi\`, run it as \`${invocation} ...\` instead.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/lavish\` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

${home.help[home.help.length - 1]}

## Workflow

1. Create the HTML artifact (default location \`.lavish/<name>.html\` in the working directory).
2. Run \`${invocation} <html-file>\` to open or resume a review session in the browser.
3. Run \`${invocation} poll <html-file>\` to long-poll for the user's annotations and queued prompts.
   On the first poll, prefer \`--agent-reply "<one-line summary of what you built and what to review first>"\` so the conversation panel opens with context.
   Browser-detected layout issues are filed passively in the user's Layout issues inbox and arrive as an ordinary \`layout-warnings\` prompt only when the user selects and queues them. Never edit an issue the user has not queued. The only response that arrives without user action is \`artifact_failures\`, when the review surface itself is unusable.
   The poll stays silent until the user acts or a fatal artifact failure makes the review surface unusable - leave it running, never kill it.
   Cosmetic, intentional, transient, tiny, and uncertain observations remain silent.
   The agent that starts the poll must outlive it, so a SUBAGENT must never own one: its notification dies with it and the feedback drains into an output file nobody reads (see \`/check-lavish\` for the signals and the recovery). Delegating the artifact edits is fine - forbid \`${invocation}\` in the brief and poll from the parent session after the subagent returns.
${POLL_WAKE_PATH_RULES.map((rule) => `   ${skillCommandText(rule)}`).join("\n")}
4. If poll returns feedback, apply the user's prompts. A \`layout-warnings\` prompt is an explicit repair request; apply every listed fix in one pass before saving, and let Lavish re-check it after a newer artifact load.
5. Apply human feedback, then poll again with \`--agent-reply "<message>"\` to reply in the browser and keep the loop going under the same foreground-or-verified-wake-path rule.
6. If a poll is reaped before the user sends anything, hand the review back rather than looping. One line is enough: you have stopped listening, anything already sent is safely queued, and \`/check-lavish\` will collect it. Do not re-enter the poll silently - see the wake-path rules in step 3 for why an unbounded loop is the wrong default.
7. \`/check-lavish\` (collect feedback later): poll this review's artifact directly with \`${invocation} poll <html-file> --timeout-ms 0\` - that returns immediately instead of waiting, and it works after the user has ended the session, which drops the session from the no-argument list. Apply the prompts exactly as in step 4. If nothing comes back, say so and stop; do not open a long poll just to look.
8. Run \`${invocation} end <html-file>\` when the review is finished.
9. ${POLL_SEND_AND_END_RULE} Deliver any remaining updates directly in this conversation.

## Visual guidance

${bullets(home.visual_guidance)}

## Playbooks

Run \`${invocation} playbook <id>\` for focused, detailed guidance on any of these.
${PLAYBOOK_ROUTER_HELP}
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox; open the diagram playbook and use the theme-aware Mermaid snippet from \`${invocation} design\` unless SVG is needed for richly annotated nodes.

${playbookList(home.playbooks)}

## Commands & rules

${bullets(home.help.map(skillCommandText))}
`;
}

/**
 * Render the installable SKILL.md for the `check-lavish` companion skill.
 *
 * It loads on demand mid-task. The lookup order is the point: name the artifact from the
 * conversation, poll it directly, and only then fall back to the session list, which omits
 * user-ended sessions that still hold queued feedback. The rule text is imported from
 * `POLL_PICKUP_RULE` rather than restated, so the two skills cannot disagree about it.
 *
 * @param {object} [options]
 * @param {string} [options.invocation] how the skill tells agents to invoke the CLI. Defaults to
 *   the published `npx -y lavish-axi`; pass `localInvocation(repoRoot)` for the checkout-local flavor.
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createCheckSkillMarkdown({ invocation = NPX_INVOCATION } = {}) {
  const skillCommandText = (text) => text.replaceAll("`lavish-axi", `\`${invocation}`);

  return `---
name: check-lavish
description: ${CHECK_SKILL_DESCRIPTION}
argument-hint: "[artifact path or nothing]"
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, feedback]
    category: productivity
---

# Check Lavish for queued feedback

${installNote(invocation)}

## Why this exists

A Lavish poll is a long-lived job, and harnesses reap those on their own schedule. The \`/lavish\`
skill therefore hands the review back instead of looping forever. Nothing is lost when it does:
the server keeps queued feedback and delivers it to the next poll that attaches. This skill is
that next poll.

## Steps

1. Name the artifact before touching the session list. It is the html file this session, or a
   subagent it dispatched, passed to \`${invocation}\` - subagent reports carry the path. If the
   conversation names nothing, take the newest file under \`.lavish/\` in the working directory.
   Only when both come up empty, run \`${invocation}\` with no arguments and pick from the list it
   prints: the artifact the user named, else one under the current working directory. Do NOT sweep
   every listed session - \`open\` sessions accumulate across conversations, and the list omits
   sessions the user has ended, so it is neither complete nor live.
2. Drain it with \`${invocation} poll <html-file> --timeout-ms 0\`. That returns immediately
   instead of waiting. Run it whether or not the file appears in the list: a session the user ended
   is absent from the list but still delivers its queued feedback once.
3. Read the result. \`session_ended: true\` means the user is done - apply what came back, deliver
   any further updates in this conversation, and do not reopen. An empty result means the queue is
   empty _right now_, not that the user sent nothing; rule out a drained queue (below) before
   reporting "no feedback". Do not open a long poll just to look.
4. Apply the returned prompts exactly as the \`/lavish\` workflow describes. A \`layout-warnings\`
   prompt is an explicit repair request; apply every listed fix in one pass.
5. If the session is still open and you want to carry on in the browser, reply with
   \`${invocation} poll <html-file> --agent-reply "<message>"\` and follow the \`/lavish\` wake-path
   rules from there. If the user is done, \`${invocation} end <html-file>\`.

## When the queue is empty but the user says they sent feedback

A poll that collected the feedback and then exited took it with it - typically a poll a subagent
started and left behind. Signals: the browser is stuck on "Working" or a spinner, or a recent
background job in this session's \`tasks/\` directory contains a \`prompts[\` block. The last one is
decisive:

\`\`\`bash
grep -l 'prompts\\[' /private/tmp/claude-501/<cwd-slug>/<session-uuid>/tasks/*.output
\`\`\`

Read the newest match, treat its \`prompts[N]{uid,prompt,selector,tag,text}:\` block as the feedback,
apply it normally, then reply into the browser so it stops spinning. A bash background-job
\`.output\` file is plain text and safe to read, unlike a subagent's JSONL transcript.

## Rules

- ${skillCommandText(POLL_PICKUP_RULE)}
- ${skillCommandText(POLL_HANDOFF_RULE)}
- A subagent must NEVER own a Lavish poll. The poll delivers to whoever started it, so when the subagent exits the prompts land in an output file nobody reads and no completion notification reaches the session that can act on them. When delegating artifact edits, forbid \`${invocation}\` in the brief; the parent polls after the subagent returns.
- ${POLL_SEND_AND_END_RULE}
`;
}
