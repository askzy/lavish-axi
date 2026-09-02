// Regression guards for the deliberate divergences in this fork (askzy/lavish-axi).
//
// The fork disables upstream's outbound-sharing surface: the `share` command, the
// `setup hooks` command, the `POST /api/:key/share` endpoint, and every agent-facing mention of
// ht-ml.app. A cumulative replay of upstream commits onto this fork with file-level conflict
// resolution silently restored all of it, so these assertions exist to turn that silent revert
// into a loud test failure.
//
// The browser chrome's "Publish link" menu item and share dialog are a step further: they are
// deleted outright, not disabled, along with the chrome client code and CSS behind them and the
// ht-ml.app HTTP client. Deleted markup cannot be un-hidden by an upstream rewrite of the chrome
// bar line, which is why the first guard below asserts absence rather than a hidden attribute.
// The three subcommand/endpoint rejections stay, because a rejection is a message to an agent:
// "deliberately gone", not "broken".
//
// This lives in its own file on purpose. Upstream owns test/server.test.js and
// test/cli-output.test.js, so a file-level "take upstream" resolution there would delete
// the guard and restore the feature in one move - exactly the failure being guarded
// against. Nothing upstream will ever write to this path.
//
// If upstream itself ever removes one of these features, the matching guard here starts
// failing for a good reason. Delete the guard then, do not weaken it.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

// Namespace import on purpose: a named import of a handler upstream might delete would fail
// at link time and take every other guard in this file down with it. This way each guard
// fails on its own terms.
import * as cli from "../src/cli.js";
import * as skill from "../src/skill.js";
import { createChromeHtml, serve } from "../src/server.js";

const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Records every request an ht-ml.app publish attempt would make, so a restored upstream code
// path is caught by the recorder even if it somehow still produced an acceptable status.
// This fork has deleted src/html-app.js, so nothing reads LAVISH_AXI_HTML_APP_API_URL today and
// the recorder is dormant. It stays wired up because restoring the client is exactly the revert
// being guarded against, and a restored client honours that env var again.
async function startHtmlAppRecorder(requests) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ site_id: "abc123", url: "https://abc123.ht-ml.app/", update_key: "uk" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// The fork used to ship the Publish button with `hidden style="display:none"` and this guard
// asserted those attributes were still there. That was the weaker form twice over: a hidden
// element can be un-hidden by any upstream rewrite of the chrome bar line (three separate commits
// rewrote it in one sync), and the guard itself would have gone green on a restored-but-hidden
// button. The markup is deleted now, so the assertion is absence.
//
// All three surfaces are checked, not just the markup. Deleting the button alone would leave
// chrome-client.js doing `document.getElementById("shareArtifact")` on a top-level const and then
// assigning .onclick to null - which throws and kills the entire chrome script, taking annotation
// and the feedback loop with it. A restored client-side reference is therefore worse than a
// restored button, and it is what the second assertion block exists to catch.
test("fork: the chrome ships no Publish link button, share dialog, or client-side share code", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /id="shareArtifact"/, "the chrome bar renders a #shareArtifact button again");
  assert.doesNotMatch(html, /id="shareDialog"/, "the chrome renders the share dialog again");
  assert.doesNotMatch(html, /Publish link/, "the overflow menu advertises a Publish link again");
  assert.doesNotMatch(html, /ht-ml\.app/, "the rendered chrome mentions ht-ml.app again");

  // A surviving reference here is the null-dereference that kills the whole chrome script.
  const chromeClient = await readFile(path.join(REPO_ROOT, "src/chrome-client.js"), "utf8");
  assert.doesNotMatch(
    chromeClient,
    /shareArtifact|shareDialog|shareForm|publishShare/,
    [
      "src/chrome-client.js references the removed share UI again.",
      "getElementById returns null for it, so the top-level assignment throws and the entire chrome",
      "script dies - annotation and the feedback loop included. Remove the reference, do not re-add",
      "the markup.",
    ].join(" "),
  );

  const chromeCss = await readFile(path.join(REPO_ROOT, "src/chrome.css"), "utf8");
  assert.doesNotMatch(chromeCss, /\.share-/, "src/chrome.css styles the removed share UI again");
});

test("fork: agent-facing help never advertises ht-ml.app or the share command", () => {
  const home = cli.createHomeOutput({ bin: "lavish-axi", sessions: [] });

  assert.ok(Array.isArray(home.help));
  for (const item of home.help) {
    assert.doesNotMatch(item, /ht-ml\.app/, "home help still points agents at ht-ml.app");
    assert.doesNotMatch(item, /lavish-axi share/, "home help still advertises `lavish-axi share`");
  }
  // Catches a restored mention anywhere in the home payload, not just the help array.
  assert.doesNotMatch(JSON.stringify(home), /ht-ml\.app/);

  const shareHelp = cli.getCommandHelp("share");
  assert.match(shareHelp, /disabled in this fork/);
  assert.doesNotMatch(shareHelp, /ht-ml\.app/);

  const setupHelp = cli.getCommandHelp("setup");
  assert.match(setupHelp, /disabled in this fork/);
});

test("fork: top-level help never advertises ht-ml.app or the share command", () => {
  const result = spawnSync(process.execPath, [BIN, "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, LAVISH_AXI_STATE_DIR: os.tmpdir() },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /ht-ml\.app/, "top-level help still points agents at ht-ml.app");
  assert.doesNotMatch(result.stdout, /lavish-axi share/, "top-level help still advertises `lavish-axi share`");
  assert.doesNotMatch(result.stdout, /lavish-axi setup hooks/, "top-level help still advertises `setup hooks`");
});

test("fork: the share command rejects instead of publishing", async () => {
  assert.equal(typeof cli.shareCommand, "function", "src/cli.js no longer exports shareCommand");

  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-fork-share-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  const requests = [];
  const recorder = await startHtmlAppRecorder(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${recorder.port}`;

  try {
    // A valid artifact path on purpose: a restored upstream shareCommand would sail past
    // argument validation and publish, so this cannot pass on a generic validation error.
    await assert.rejects(
      () => cli.shareCommand([artifact]),
      (error) => {
        assert.ok(error instanceof AxiError, `expected an AxiError, got ${error}`);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /`share` command is disabled in this fork/);
        return true;
      },
    );
    assert.deepEqual(requests, [], "the share command reached out to ht-ml.app");
  } finally {
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await recorder.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("fork: the setup hooks command rejects instead of writing agent hooks", async () => {
  assert.equal(typeof cli.setupCommand, "function", "src/cli.js no longer exports setupCommand");

  const homeDir = await mkdtemp(path.join(os.tmpdir(), "lavish-fork-setup-"));
  const previousHome = process.env.HOME;
  const previousCopilotHome = process.env.COPILOT_HOME;
  // Sandbox HOME so a restored upstream setupCommand writes into the temp dir instead of the
  // developer's real ~/.claude and ~/.copilot.
  process.env.HOME = homeDir;
  delete process.env.COPILOT_HOME;

  try {
    await assert.rejects(
      () => cli.setupCommand(["hooks"]),
      (error) => {
        assert.ok(error instanceof AxiError, `expected an AxiError, got ${error}`);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /`setup hooks` command is disabled in this fork/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(homeDir, ".claude")), false, "setup hooks installed a Claude Code hook");
    assert.equal(existsSync(path.join(homeDir, ".copilot")), false, "setup hooks installed a Copilot CLI hook");
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("COPILOT_HOME", previousCopilotHome);
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("fork: POST /api/:key/share is gone (410) and never reaches ht-ml.app", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-fork-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Ship</h1></body></html>", "utf8");

  const requests = [];
  const recorder = await startHtmlAppRecorder(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${recorder.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    // Same-origin, which is the one request shape upstream's handler would have accepted.
    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({}),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 410);
    assert.deepEqual(body, {
      error: "publishing to ht-ml.app is disabled in this fork (askzy/lavish-axi)",
    });
    assert.deepEqual(requests, [], "the share endpoint reached out to ht-ml.app");
  } finally {
    await server.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await recorder.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// Upstream ends its poll wake-path rules with an unconditional "if the poll gets killed or times
// out anyway, just re-run it". On a harness that reaps long-lived jobs on a fixed schedule (measured
// here: every 30 minutes at HH:05 / HH:35), that instruction is an unbounded re-poll loop, and every
// wake re-reads the whole conversation. It is also self-defeating: an agent following it eventually
// decides it is stuck and abandons a review the user is still working through.
//
// This fork replaces it with a bounded handoff plus a cheap later-pickup path (/check-lavish).
// Upstream's version is a single sentence inside a frozen array in src/cli.js, so a file-level
// "take upstream" resolution restores the loop with no conflict and no other test failing -
// exactly the silent revert this file exists to catch.
test("fork: poll wake-path rules bound re-polling instead of looping unconditionally", () => {
  const rules = cli.POLL_WAKE_PATH_RULES.join(" ");

  assert.match(rules, /do NOT silently re-run the poll after a reap/i);
  assert.match(rules, /\/check-lavish/);
  assert.match(rules, /--timeout-ms 0/);
  assert.match(rules, /pending prompts count/);
  assert.match(rules, /reaped or timed-out poll is expected/i);

  // Upstream's unconditional instruction must not reappear beside the bounded rule.
  assert.doesNotMatch(rules, /just re-run it/i);
});

// The reaped-poll stderr notice is the one place an agent reads policy at the moment the poll dies,
// so it has to agree with the rules above. Upstream's wording tells the agent to re-run and keep
// waiting, which is the loop being guarded against.
test("fork: the interrupted-poll notice routes to /check-lavish, not back into a poll", () => {
  const interrupted = cli.pollInterruptedText("/tmp/report.html");

  assert.match(interrupted, /Do not silently re-enter the poll/i);
  // Upstream's --help test asserts no `sessions[` ever appears in agent-facing help output.
  assert.doesNotMatch(cli.POLL_WAKE_PATH_RULES.join(" "), /sessions\[/);
  assert.match(interrupted, /--timeout-ms 0/);
  assert.match(interrupted, /\/check-lavish/);
  assert.doesNotMatch(interrupted, /to keep waiting/i);
});

// The pickup path is only useful if an agent can find it. It has to survive in both agent-facing
// surfaces: the bare-command help an agent reads from the CLI, and the generated SKILL.md an agent
// reads when it never runs the CLI at all.
test("fork: the /check-lavish pickup path reaches both the CLI help and the generated skill", () => {
  const home = cli.createHomeOutput({ bin: "lavish-axi", sessions: [] });
  const help = home.help.join(" ");
  assert.match(help, /\/check-lavish/);
  assert.match(help, /pending prompts count/);
  assert.match(help, /--timeout-ms 0/);

  const markdown = skill.createSkillMarkdown();
  assert.match(markdown, /\/check-lavish/);
  assert.match(markdown, /--timeout-ms 0/);
  assert.match(markdown, /pending prompts count/);
  // The handoff step must be numbered guidance, not buried only in the rules blob.
  assert.match(markdown, /hand the review back rather than looping/i);
  // Upstream's skill.test.js forbids the literal bookkeeping field name in SKILL.md.
  assert.doesNotMatch(markdown, /pending_prompts/);
});

// The pickup path is only reachable if `/check-lavish` exists as a real skill. It is generated from
// the same rule constants as /lavish so the two cannot describe the procedure differently, and it
// is emitted in every build mode so it cannot go stale while /lavish stays fresh.
test("fork: the /check-lavish companion skill is generated and shares the pickup rule verbatim", () => {
  const markdown = skill.createCheckSkillMarkdown();

  assert.match(markdown, /^---\nname: check-lavish\n/);
  assert.match(markdown, /description: .*queued.*Lavish artifact/i);

  // The mechanics an agent has to get right.
  assert.match(markdown, /with no arguments/);
  assert.match(markdown, /--timeout-ms 0/);
  // \s+ not a literal space: the generated markdown hard-wraps, so this phrase spans a newline.
  assert.match(markdown, /do not open a long poll just to\s+look/i);
  assert.match(markdown, /Do NOT sweep\s+every listed session/i);
  // Lookup order: the artifact the conversation names comes first, the session list is the
  // fallback, and a user-ended session (absent from that list) still drains once.
  const steps = markdown.slice(markdown.indexOf("## Steps"), markdown.indexOf("## Rules"));
  assert.ok(
    steps.indexOf("Name the artifact") < steps.indexOf("with no arguments"),
    "names the artifact before consulting the session list",
  );
  assert.match(steps, /absent from the list but still delivers its queued feedback once/);
  assert.match(steps, /session_ended: true/);
  assert.match(markdown, /subagent must NEVER own a Lavish poll/);

  // Single-sourced, not restated. Rendered with an identity invocation so the command rewrite is a
  // no-op and the constants must appear byte-for-byte; under the default `npx -y lavish-axi` the
  // rule text is deliberately rewritten, so a verbatim check there would fail for the wrong reason.
  const raw = skill.createCheckSkillMarkdown({ invocation: "lavish-axi" });
  assert.ok(raw.includes(cli.POLL_PICKUP_RULE), "renders POLL_PICKUP_RULE verbatim");
  assert.ok(raw.includes(cli.POLL_HANDOFF_RULE), "renders POLL_HANDOFF_RULE verbatim");

  // Same leak rule upstream enforces on the lavish skill.
  assert.doesNotMatch(markdown, /pending_prompts/);
  assert.doesNotMatch(markdown, /sessions\[/);

  // The local flavor must never route through npm, which would fetch upstream.
  const local = skill.createCheckSkillMarkdown({ invocation: "node /repo/dist/cli.mjs" });
  assert.match(local, /node \/repo\/dist\/cli\.mjs/);
  assert.doesNotMatch(local, /npx -y lavish-axi poll/);
});

// A skill that only exists in dist/ is not installed, and one that only exists in skills/ is not
// usable from this checkout. Both flavors have to be produced from the same source.
test("fork: both generated skills are committed and reproducible", async () => {
  for (const name of ["lavish", "check-lavish"]) {
    const committed = await readFile(path.join(REPO_ROOT, "skills", name, "SKILL.md"), "utf8");
    const expected = name === "lavish" ? skill.createSkillMarkdown() : skill.createCheckSkillMarkdown();
    assert.equal(committed, expected, `skills/${name}/SKILL.md is stale - run node scripts/build-skill.js`);
  }
});
