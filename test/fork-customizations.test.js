// Regression guards for the deliberate divergences in this fork (askzy/lavish-axi).
//
// The fork disables upstream's outbound-sharing surface: the `share` command, the
// `setup hooks` command, the `POST /api/:key/share` endpoint, the browser chrome's
// "Publish link" menu item, and every agent-facing mention of ht-ml.app. A cumulative
// replay of upstream commits onto this fork with file-level conflict resolution silently
// restored all of it, so these assertions exist to turn that silent revert into a loud
// test failure.
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createChromeHtml, serve } from "../src/server.js";

const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Records every request an ht-ml.app publish attempt would make, so a restored upstream code
// path is caught by the recorder even if it somehow still produced an acceptable status.
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

test("fork: the chrome overflow menu's Publish link button is not reachable", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const button = html.match(/<button[^>]*id="shareArtifact"[^>]*>/)?.[0];

  assert.ok(button, "expected a #shareArtifact button in the chrome bar - if upstream dropped it, drop this guard");
  assert.match(button, /(^|\s)hidden(\s|>|$)/, "the fork's `hidden` attribute is gone from #shareArtifact");
  assert.match(button, /display:\s*none/, "the fork's inline display:none is gone from #shareArtifact");
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
