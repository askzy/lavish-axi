// Real-browser guard: the served chrome script must initialise to its last statement.
//
// WHY THIS EXISTS, AND WHY THE NORMAL SUITE CANNOT REPLACE IT
//
// `src/chrome-client.js` resolves every chrome control into a top-level `const` through
// `document.getElementById` and assigns handlers at module scope. One stale id therefore throws
// during initialisation and kills the *entire* chrome script - annotation, the feedback loop, the
// layout inbox - in every artifact Lavish serves.
//
// `test/chrome-client-queue.test.js` runs that same module under a `vm` harness whose
// `getElementById` lazily fabricates any element it is asked for. A null dereference is
// structurally impossible in there, so the whole suite stays green for the one failure mode that
// breaks every artifact. That blind spot is why this file exists; do not delete it as redundant
// with the queue harness.
//
// The load-bearing assertion is a set relation over served bytes: every id the served
// `chrome-client.js` asks `getElementById` for must exist in the served chrome markup. A keyword
// grep for a removed feature would not have caught it.
//
// The second test is a negative control. A guard that passes both ways is worse than none, so it
// serves a synthetic copy of the client with one stale top-level lookup injected - through a proxy
// that passes every other request through to the real server - and asserts the same verdict function
// reports the `TypeError`, the unattached handlers, and the missing id. `src/chrome-client.js` is
// never mutated.
//
// Opt in with `LAVISH_AXI_BROWSER_E2E=1`, like the other browser suites. Skips (never fails) with
// the flag unset or no Chrome installed. Unlike `test/layout-audit-browser.test.js` this drives
// raw CDP rather than `chrome-devtools-axi`: the invariant is "the chrome boots at all", and it has
// to be checkable on any machine that has Chrome, with no extra tooling.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = findChromeBinary();

// A machine without the flag, without Chrome, or on a Node build with no global WebSocket has to
// skip rather than fail: this suite is opt-in infrastructure, not a portability claim.
const skip =
  process.env.LAVISH_AXI_BROWSER_E2E !== "1"
    ? "set LAVISH_AXI_BROWSER_E2E=1 to run the real-browser chrome-load probe"
    : !chromeBinary
      ? "no Chrome binary found (set LAVISH_AXI_CHROME_BINARY or CHROME_PATH)"
      : typeof WebSocket !== "function"
        ? "this Node build exposes no global WebSocket"
        : false;

const ARTIFACT_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chrome load probe</title></head><body><main><h1>Chrome load probe</h1><p>A deliberately trivial artifact: this suite is about the chrome around it.</p><button type="button">Continue</button></main></body></html>';

// Mimics the real failure shape - a stale id resolved into a top-level const, then a handler
// assigned on the null it returns - rather than an arbitrary throw.
const STALE_ID = "lavishProbeStaleControl";
const HANDLER_ANCHOR = "annotationSwitch.onclick = toggleAnnotationMode;";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "real browser: the served chrome initialises to its last statement in the source and bundle layouts",
  { skip, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-chrome-load-"));
    const chrome = await launchChrome();
    /** @type {Array<() => Promise<void>>} */
    const cleanups = [];
    try {
      const artifact = path.join(temp, "artifact.html");
      await writeFile(artifact, ARTIFACT_HTML, "utf8");

      // Both layouts, because they serve the chrome from different places: the source layout from
      // `src/` via `bin/lavish-axi.js`, the published layout from `dist/` via the self-spawning
      // `dist/cli.mjs`. A `scripts/build.js` that forgot to copy an asset only fails the latter.
      const layouts = [
        { name: "source", session: await startSourceLayoutSession(temp, artifact, cleanups) },
        { name: "bundle", session: await startBundleLayoutSession(temp, artifact, cleanups) },
      ];

      for (const { name, session } of layouts) {
        const report = await probeChromeLoad(chrome.cdp, session.url);

        // Guards against a vacuous pass: an audit that resolved nothing would otherwise report a
        // clean set relation over two empty sets.
        assert.ok(
          report.requestedIdCount >= 30,
          `${name}: only ${report.requestedIdCount} ids requested by the client`,
        );
        assert.ok(report.markupIdCount >= 30, `${name}: only ${report.markupIdCount} ids in the served markup`);
        assert.ok(report.handlerIdCount >= 10, `${name}: only ${report.handlerIdCount} handler targets derived`);

        assert.deepEqual(chromeLoadFailures(report), [], `${name} layout:\n${JSON.stringify(report, null, 2)}`);
      }
    } finally {
      await chrome.close();
      for (const cleanup of cleanups.reverse()) await cleanup();
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "real browser: the chrome-load probe fails loudly on a stale top-level getElementById",
  { skip, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-chrome-load-control-"));
    const chrome = await launchChrome();
    /** @type {Array<() => Promise<void>>} */
    const cleanups = [];
    try {
      const artifact = path.join(temp, "artifact.html");
      await writeFile(artifact, ARTIFACT_HTML, "utf8");
      const session = await startSourceLayoutSession(temp, artifact, cleanups);

      const served = await (await fetch(new URL("/chrome-client.js", session.url))).text();
      // Fail loudly rather than doctor nothing if the client stops attaching handlers here.
      assert.ok(served.includes(HANDLER_ANCHOR), `chrome-client.js no longer contains "${HANDLER_ANCHOR}"`);
      const doctored = served.replace(
        HANDLER_ANCHOR,
        `const staleControl = document.getElementById(${JSON.stringify(STALE_ID)});\n` +
          `staleControl.onclick = () => {};\n` +
          HANDLER_ANCHOR,
      );
      assert.notEqual(doctored, served);

      // Everything but /chrome-client.js is proxied to the real server, so the control differs from
      // the passing case by exactly one injected lookup.
      const proxy = await startDoctoredClientProxy(session.origin, doctored);
      cleanups.push(proxy.close);

      const report = await probeChromeLoad(chrome.cdp, new URL(session.path, proxy.origin).href);
      const failures = chromeLoadFailures(report);
      const detail = `\n${JSON.stringify({ report, failures }, null, 2)}`;

      assert.ok(
        failures.some((failure) => /^uncaught exception: TypeError: Cannot set properties of null/.test(failure)),
        `the probe did not report the injected null dereference${detail}`,
      );
      assert.ok(
        failures.includes(`getElementById("${STALE_ID}") has no matching id in the served markup`),
        `the served-bytes id audit did not report the injected stale id${detail}`,
      );
      assert.deepEqual(
        Object.entries(report.handlersAttached).filter(([, attached]) => attached),
        [],
        `handlers were attached even though initialisation threw${detail}`,
      );
      assert.equal(
        report.presenceBannerHidden,
        true,
        `presenceBanner was unhidden even though the module never reached its last statement${detail}`,
      );
    } finally {
      await chrome.close();
      for (const cleanup of cleanups.reverse()) await cleanup();
      await rm(temp, { recursive: true, force: true });
    }
  },
);

/**
 * The single verdict both tests read, so the negative control exercises the same logic the passing
 * case relies on.
 * @param {Awaited<ReturnType<typeof probeChromeLoad>>} report
 * @returns {string[]}
 */
function chromeLoadFailures(report) {
  const failures = [];
  for (const message of report.uncaughtExceptions) failures.push(`uncaught exception: ${message}`);
  for (const message of report.consoleErrors) failures.push(`console error: ${message}`);
  for (const message of report.errorLogEntries) failures.push(`error log entry: ${message}`);
  for (const id of report.missingIds) failures.push(`getElementById("${id}") has no matching id in the served markup`);
  for (const [id, attached] of Object.entries(report.handlersAttached)) {
    if (!attached) failures.push(`handler never attached: #${id}`);
  }
  // `setAgentPresence("waiting")` is the module's last statement and it unhides this banner.
  if (report.presenceBannerHidden !== false) {
    failures.push("presenceBanner still hidden: the module never reached its last statement");
  }
  for (const [name, held] of Object.entries(report.interaction)) {
    if (!held) failures.push(`interaction failed: ${name}`);
  }
  return failures;
}

/**
 * Loads one session URL in Chrome and reports everything the verdict needs.
 * @param {ReturnType<typeof createCdpClient>} cdp
 * @param {string} sessionUrl
 */
async function probeChromeLoad(cdp, sessionUrl) {
  // Read both sides of the invariant off the wire before navigating: `GET /session/:key` issues a
  // fresh chrome-load token per request, so the browser must be the last reader or it inherits a
  // superseded one and renders the handoff banner.
  const markupIds = idsInMarkup(await (await fetch(sessionUrl)).text());
  const clientSource = await (await fetch(new URL("/chrome-client.js", sessionUrl))).text();
  const requestedIds = idsRequestedByClient(clientSource);
  const handlerIds = handlerTargetIds(clientSource);
  const missingIds = requestedIds.filter((id) => !markupIds.includes(id));

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  /** @type {string[]} */ const uncaughtExceptions = [];
  /** @type {string[]} */ const consoleErrors = [];
  /** @type {string[]} */ const errorLogEntries = [];
  let loaded = () => {};
  const load = new Promise((resolve) => (loaded = () => resolve(undefined)));

  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      uncaughtExceptions.push(details.exception?.description || details.text || JSON.stringify(details));
    }
    if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) {
      consoleErrors.push(message.params.args.map((arg) => arg.description ?? arg.value ?? arg.type).join(" "));
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      errorLogEntries.push(`[${message.params.entry.source}] ${message.params.entry.text}`);
    }
    if (message.method === "Page.loadEventFired") loaded();
  });

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: sessionUrl }, sessionId);
  await load;
  // Let the module's async tails settle: EventSource open, the chrome-load beacon, iframe load.
  await sleep(3000);

  /** @param {string} expression */
  const evaluate = async (expression) => {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate threw: ${result.exceptionDetails.exception?.description}`);
    }
    return result.result.value;
  };

  const state = await evaluate(`(() => {
    const handlerIds = ${JSON.stringify(handlerIds)};
    const banner = document.getElementById("presenceBanner");
    const handlersAttached = {};
    for (const id of handlerIds) {
      handlersAttached[id] = typeof document.getElementById(id)?.onclick === "function";
    }
    return {
      title: document.title,
      domIdCount: document.querySelectorAll("[id]").length,
      presenceBannerHidden: banner ? banner.hidden : null,
      handlersAttached,
    };
  })()`);

  // Attachment alone is not proof the chrome works, so drive it: the mode switch, the overflow
  // menu, the global Escape handler, and the composer's send button.
  const interaction = await evaluate(`(() => {
    const out = {};
    const annotationSwitch = document.getElementById("annotation");
    const before = annotationSwitch.getAttribute("aria-pressed");
    annotationSwitch.click();
    out.annotationToggles = annotationSwitch.getAttribute("aria-pressed") !== before;
    annotationSwitch.click();
    out.annotationRestores = annotationSwitch.getAttribute("aria-pressed") === before;

    const moreButton = document.getElementById("moreButton");
    const moreMenu = document.getElementById("moreMenu");
    moreButton.click();
    out.overflowMenuOpens = moreMenu.hidden === false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    out.escapeClosesOverflowMenu = out.overflowMenuOpens && moreMenu.hidden === true;

    // An empty composer reveals the send hint and posts nothing, so this exercises the send
    // handler without mutating the session.
    const send = document.getElementById("send");
    const sendHint = document.getElementById("sendHint");
    out.sendHintStartsHidden = sendHint.hidden === true;
    send.click();
    out.emptySendRevealsHint = sendHint.hidden === false;
    return out;
  })()`);

  await cdp.send("Target.closeTarget", { targetId });

  return {
    sessionUrl,
    uncaughtExceptions,
    consoleErrors,
    errorLogEntries,
    requestedIdCount: requestedIds.length,
    markupIdCount: markupIds.length,
    handlerIdCount: handlerIds.length,
    missingIds,
    interaction: /** @type {Record<string, boolean>} */ (interaction),
    .../** @type {{ title: string, domIdCount: number, presenceBannerHidden: boolean | null, handlersAttached: Record<string, boolean> }} */ (
      state
    ),
  };
}

/**
 * Every id present in the served chrome markup.
 * @param {string} html
 */
function idsInMarkup(html) {
  return [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))].sort();
}

/**
 * Every id the served client resolves through a literal `getElementById`.
 * @param {string} source
 */
function idsRequestedByClient(source) {
  return [...new Set([...source.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]))].sort();
}

/**
 * The ids of elements the served client assigns an `onclick` to, derived from the bytes rather than
 * hand-listed, so a newly added handler is required to attach without anyone updating this file.
 * @param {string} source
 */
function handlerTargetIds(source) {
  const idByBinding = new Map(
    [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=[^;]*?getElementById\(\s*"([^"]+)"\s*\)/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const ids = new Set();
  for (const [, binding] of source.matchAll(/\b(\w+)\.onclick\s*=/g)) {
    const id = idByBinding.get(binding);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * @param {string} temp
 * @param {string} artifact
 * @param {Array<() => Promise<void>>} cleanups
 */
async function startSourceLayoutSession(temp, artifact, cleanups) {
  const port = await freePort();
  const env = lavishEnv(port, path.join(temp, "state-source"));
  const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], env);
  cleanups.push(async () => {
    run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], env, 15_000);
  });
  return sessionFrom(output);
}

/**
 * The published layout: only `dist/` exists, so `resolveServerEntry()` re-spawns `dist/cli.mjs`
 * itself and the chrome is served out of `dist/`.
 * @param {string} temp
 * @param {string} artifact
 * @param {Array<() => Promise<void>>} cleanups
 */
async function startBundleLayoutSession(temp, artifact, cleanups) {
  const distSource = path.join(repoRoot, "dist");
  // `dist/` is gitignored, and plain `npm test` does not build. Build on demand so this test needs
  // no ordering guarantee from the script that invoked it.
  if (!existsSync(path.join(distSource, "cli.mjs")) || !existsSync(path.join(distSource, "chrome-client.js"))) {
    run(process.execPath, ["scripts/build.js"], {}, 120_000);
  }
  const bundleRoot = path.join(temp, "bundle");
  await cp(distSource, path.join(bundleRoot, "dist"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules"), path.join(bundleRoot, "node_modules"), "dir");

  const entry = path.join(bundleRoot, "dist", "cli.mjs");
  const port = await freePort();
  const env = lavishEnv(port, path.join(temp, "state-bundle"));
  const output = run(process.execPath, [entry, artifact, "--no-open"], env);
  cleanups.push(async () => {
    run(process.execPath, [entry, "stop", "--port", String(port)], env, 15_000);
  });
  return sessionFrom(output);
}

/**
 * @param {number} port
 * @param {string} stateDir
 */
function lavishEnv(port, stateDir) {
  return {
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
  };
}

/** @param {string} output */
function sessionFrom(output) {
  const href = output.match(/url:\s*"([^"]+)"/)?.[1];
  assert.ok(href, `no session url in CLI output:\n${output}`);
  const url = new URL(href);
  return { url: href, origin: url.origin, path: `${url.pathname}${url.search}` };
}

/**
 * A pass-through proxy in front of a real session that replaces exactly one response body. Serving
 * the synthetic client this way keeps `src/chrome-client.js` untouched on disk.
 * @param {string} upstreamOrigin
 * @param {string} clientSource
 */
async function startDoctoredClientProxy(upstreamOrigin, clientSource) {
  let proxyOrigin = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", upstreamOrigin);
    if (url.pathname === "/chrome-client.js") {
      req.resume();
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(clientSource);
      return;
    }
    (async () => {
      /** @type {Record<string, string>} */
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value !== "string") continue;
        if (/^(host|connection|content-length|transfer-encoding|accept-encoding)$/i.test(name)) continue;
        // The chrome's own POSTs are same-origin-checked upstream, so rewrite the browser's view of
        // the origin. Without this the control would differ from the passing case by a rejected
        // handoff as well as by the injected lookup.
        headers[name] = name === "origin" || name === "referer" ? value.replace(proxyOrigin, upstreamOrigin) : value;
      }
      const body = ["GET", "HEAD"].includes(String(req.method)) ? undefined : await readRequestBody(req);
      const upstream = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
      /** @type {Record<string, string>} */
      const responseHeaders = {};
      for (const [name, value] of upstream.headers) {
        if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(name)) {
          responseHeaders[name] = value;
        }
      }
      res.writeHead(upstream.status, responseHeaders);
      // The SSE stream never ends, so it has to be piped; buffering it would hang the request.
      if (/text\/event-stream/i.test(upstream.headers.get("content-type") || "") && upstream.body) {
        Readable.fromWeb(/** @type {any} */ (upstream.body)).pipe(res);
        return;
      }
      res.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch(() => {
      res.writeHead(502).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object", "proxy did not bind a port");
  proxyOrigin = `http://127.0.0.1:${address.port}`;
  return {
    origin: proxyOrigin,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/** @param {import("node:http").IncomingMessage} req */
async function readRequestBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  return body.length ? body : undefined;
}

async function launchChrome() {
  assert.ok(chromeBinary, "no Chrome binary");
  const userDataDir = await mkdtemp(path.join(tmpdir(), "lavish-chrome-profile-"));
  const chrome = spawn(
    chromeBinary,
    [
      "--headless=new",
      // Ephemeral port, read back from DevToolsActivePort, so parallel runs cannot collide.
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  chrome.stderr.on("data", (chunk) => (stderr += chunk));

  let wsUrl = "";
  for (let attempt = 0; attempt < 120 && !wsUrl; attempt += 1) {
    await sleep(250);
    const [port, browserPath] = (
      await readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8").catch(() => "")
    ).split("\n");
    if (port && browserPath) wsUrl = `ws://127.0.0.1:${port.trim()}${browserPath.trim()}`;
  }
  const close = async () => {
    chrome.kill("SIGKILL");
    await rm(userDataDir, { recursive: true, force: true });
  };
  if (!wsUrl) {
    await close();
    throw new Error(`Chrome never exposed a DevTools endpoint.\n${stderr}`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(undefined), { once: true });
    ws.addEventListener("error", () => reject(new Error(`Chrome DevTools socket failed.\n${stderr}`)), { once: true });
  });
  return {
    cdp: createCdpClient(ws),
    async close() {
      try {
        ws.close();
      } catch {
        /* the socket is already gone */
      }
      await close();
    },
  };
}

/**
 * A minimal DevTools Protocol client over Node's built-in WebSocket - no dependency, and no
 * `chrome-devtools-axi` install, which is what lets this suite run wherever Chrome exists.
 * @param {WebSocket} ws
 */
function createCdpClient(ws) {
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  /** @type {Array<(message: any) => void>} */
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const settle = message.id === undefined ? undefined : pending.get(message.id);
    if (settle) {
      pending.delete(message.id);
      if (message.error) settle.reject(new Error(JSON.stringify(message.error)));
      else settle.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    /**
     * @param {string} method
     * @param {Record<string, any>} params
     * @param {string} [sessionId]
     */
    send(method, params = {}, sessionId) {
      const id = nextId++;
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    /** @param {(message: any) => void} listener */
    on(listener) {
      listeners.push(listener);
    },
  };
}

function findChromeBinary() {
  const explicit = process.env.LAVISH_AXI_CHROME_BINARY || process.env.CHROME_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const which = spawnSync("which", [name], { encoding: "utf8" });
    const resolved = which.status === 0 ? which.stdout.split("\n")[0].trim() : "";
    if (resolved && existsSync(resolved)) return resolved;
  }
  return null;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {number} [timeout]
 */
function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}
