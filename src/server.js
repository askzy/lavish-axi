import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";
import express from "express";

import {
  classifySevereTextOverflow,
  classifyMaterialRectEscape,
  classifyUnreadableContrast,
  compositeSrgbOver,
  createArtifactSdk,
  deriveLavishQueueKey,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isNearTotalOcclusion,
  MODE_TOGGLE_HOTKEY_KEY,
  resolveTextBackdrop,
  srgbContrastRatio,
  srgbRelativeLuminance,
} from "./artifact-sdk.js";
import {
  activeLayoutWarningCount,
  resolveDiagnosticViewportClasses,
  serializeLayoutWarnings,
} from "./layout-warnings.js";
import * as mermaidNode from "./mermaid-node.js";
import { buildSelfContainedHtml, exportFileName, splitExportWarnings } from "./export-bundle.js";
import { injectLavishSdk } from "./html-transform.js";
import { bindHost, extraAllowedHosts, hostForUrl, IPV6_LOOPBACK_HOST, linkHost, LOOPBACK_HOST } from "./paths.js";
import {
  formatPruneSummary,
  prune,
  resolvePruneMaxAgeMs,
  resolvePruneOpenMaxAgeMs,
  resolvePruneUnrepliedMaxAgeMs,
} from "./prune.js";
import { canonicalFile, canonicalSessionFile, SessionStore, sessionKey } from "./session-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);
const designAssetUrls = {
  "daisyui.css": {
    packaged: new URL("./design/daisyui.css", import.meta.url),
    source: new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    type: "text/css",
  },
  "daisyui-themes.css": {
    packaged: new URL("./design/daisyui-themes.css", import.meta.url),
    source: new URL("../node_modules/daisyui/themes.css", import.meta.url),
    type: "text/css",
  },
  "tailwindcss-browser.js": {
    packaged: new URL("./design/tailwindcss-browser.js", import.meta.url),
    source: new URL("../node_modules/@tailwindcss/browser/dist/index.global.js", import.meta.url),
    type: "application/javascript",
  },
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
// The reasons a caller may name for shutting this server down. Each one drives a different line
// in the chrome's outdated banner, so an unknown value is dropped rather than passed through to
// text the user would read as a fact.
const SHUTDOWN_REASONS = new Set(["upgrade", "local-build", "stop"]);
// An escaped popup can navigate to an artifact-owned HTML or SVG asset on the
// server origin. Keep every artifact response sandboxed at the response layer
// so active documents stay opaque-origin even when they are top-level.
const ARTIFACT_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

// Live-reload coalescing. A normal save is one reload after a short debounce. While a queued
// layout-warning batch is outstanding, the agent is applying several related edits, so widen the
// window: the user asked for one group of fixes and should get one artifact refresh for it.
export const RELOAD_DEBOUNCE_MS = 100;
export const BATCH_RELOAD_DEBOUNCE_MS = 900;
// How long an active poll keeps waiting after the last browser chrome for its session drops
// before it returns `browser_disconnected`. Long enough to ride out a reload, short enough that
// a foreground poll stops blocking soon after the user closes the page.
export const BROWSER_DISCONNECT_GRACE_MS = 10_000;

// A detached server should not live forever. When no browser chrome (SSE) and no agent poll
// are connected for this long, the server shuts itself down so it stops dangling. The next
// `lavish-axi <file>` invocation re-spawns a fresh server and adopts resumable sessions from
// state.json. Browser-ended sessions still require the explicit --reopen opt-in. Set
// LAVISH_AXI_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond budget.
export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.LAVISH_AXI_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return value;
}

export async function serve({
  port,
  stateFile,
  version = "",
  build = undefined,
  debug = false,
  log = null,
  pollHeartbeatMs = 15_000,
  browserDisconnectGraceMs = BROWSER_DISCONNECT_GRACE_MS,
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(),
  linkHost: linkHostName = linkHost(),
  allowedHosts = extraAllowedHosts(),
  feedbackLeaseTtlMs = undefined,
  // undefined resolves LAVISH_AXI_PRUNE_MAX_AGE at start; null skips the start-up prune.
  pruneMaxAgeMs = undefined,
}) {
  const app = express();
  const store = new SessionStore(stateFile, feedbackLeaseTtlMs === undefined ? {} : { feedbackLeaseTtlMs });
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  // SSE response -> session key, so a session can tell whether any browser chrome still holds it.
  const sseClients = new Map();
  const browserDisconnectTimers = new Map();
  let shuttingDown = false;
  // Sessions with at least one warning the user queued that has not been re-checked yet.
  const outstandingRepairBatches = new Set();
  const diagnosticViewportClasses = resolveDiagnosticViewportClasses();
  const verbose = debug || process.env.LAVISH_AXI_DEBUG === "1";
  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`${line}\n`);
  const logEvent = verbose ? (line) => writeLog(`[lavish] ${line}`) : null;
  let publicPort = port;

  // DNS-rebinding guard. An Origin/Referer same-origin check stops classic cross-origin CSRF but
  // NOT DNS rebinding: a page that rebinds its own domain to this loopback port
  // sends that domain in both Origin and Host, so the two still match. The robust
  // defense is a Host-header allowlist - a rebound browser carries the attacker's
  // domain in Host, which is never one of the hostnames this server answers to.
  //
  // The allowlist is always enforced, not just on loopback: a bind to a concrete
  // LAN interface is still rebinding-reachable, so switching the guard off there
  // would leave the exposed case unprotected. Loopback names are always accepted,
  // and binding to a concrete interface (LAVISH_AXI_HOST) or naming a link host
  // (LAVISH_AXI_LINK_HOST) adds that host, so the intended hostname keeps working.
  // Additional names are an explicit opt-in via LAVISH_AXI_ALLOWED_HOSTS; a lone
  // "*" there disables the guard. When a reverse proxy sits in front,
  // X-Forwarded-Host is validated too (see isAllowedRequestHost).
  const allowedHostnames = buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts });
  const allowAnyHostname = allowsAllHosts(allowedHosts);
  if (!allowAnyHostname) {
    app.use((req, res, next) => {
      const requestHost = { host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] };
      if (isAllowedRequestHost(requestHost, allowedHostnames)) {
        next();
        return;
      }
      logEvent?.(
        `rejected request with disallowed host host=${req.headers.host ?? ""} x-forwarded-host=${req.headers["x-forwarded-host"] ?? ""} path=${req.path}`,
      );
      res.status(403).json({ error: "forbidden host" });
    });
  }

  // CSRF defense-in-depth on top of the Host allowlist. A foreign page that can reach
  // 127.0.0.1 passes the Host check, but the browser attaches the real Origin, so mutating
  // requests with a present, non-matching Origin or Referer are rejected. Header-less CLI
  // control-channel requests have no Origin and are allowed; the Host allowlist remains their
  // gate. Routes that already call isSameOriginRequest keep those checks - they also reject
  // header-less callers, and this middleware does not replace them.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
      logEvent?.(
        `rejected cross-origin request origin=${req.get("origin") ?? ""} referer=${req.get("referer") ?? ""} path=${req.path}`,
      );
      res.status(403).json({ error: "cross-origin request rejected" });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "lavish-axi", version, build });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    // The caller names the session it is about to reopen, and only that session's chrome is
    // reloaded. A call that names none reloads nothing. It also names why it is shutting this
    // server down, because the banner every other chrome shows has to be true for that reason;
    // an unrecognized or absent reason claims nothing beyond "this server is gone".
    const reloadKey = String(req.body?.reload_key || "");
    const reason = SHUTDOWN_REASONS.has(String(req.body?.reason || "")) ? String(req.body.reason) : "";
    res.json({ status: "shutting-down" });
    // Defer until after the response flushes so the client gets confirmation.
    setImmediate(() => shutdown(reloadKey, reason));
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      const reopen = Boolean(req.body.reopen);
      const existing = await store.findByKey(key);
      // A user-initiated end (ending or send-and-ending from the browser) means the human
      // deliberately closed the review surface. Silently reopening it on the next
      // `lavish-axi <file>` is the exact behavior this route exists to prevent - require an
      // explicit `reopen` opt-in instead of reviving it automatically. Agent-initiated ends
      // (`lavish-axi end`) keep reviving on the next open, same as before this change.
      if (existing?.status === "ended" && existing.ended_by === "user" && !reopen) {
        logEvent?.(`session open blocked (user-ended) key=${key} file=${file}`);
        res.json({ key, file, url: existing.url, status: "user-ended" });
        return;
      }
      const sessionUrl = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      const url = shouldDisableLayoutGateOpen(req.body || {}) ? appendNoGateParam(sessionUrl) : sessionUrl;
      const session = await store.upsertSession(file, sessionUrl);
      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session opened key=${key} file=${file}`);
      await syncOutstandingRepairs(key);
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      res.json({ key, file, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/poll", async (req, res, next) => {
    try {
      // Lenient on purpose: queued feedback belongs to the session record, not to the file, so a
      // deleted artifact must not make the queue unreachable.
      const file = await canonicalSessionFile(String(req.query.file || ""));
      const key = sessionKey(file);
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        if (immediate.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
        res.json(immediate);
        return;
      }
      const streamHeartbeat = timeoutMs === null;
      let heartbeat = null;
      if (streamHeartbeat) {
        res.status(200).type("application/json");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, pollHeartbeatMs);
        heartbeat.unref?.();
      }
      setPollActive(key, activePolls, deliveredFeedback, events, true);
      refreshIdleTimer();
      const timer = timeoutMs === null ? null : setTimeout(() => respond().catch(handleRespondError), timeoutMs);
      // A batch leased to a poll that died is re-delivered when the lease expires. Nothing
      // emits an event at that moment, so a poll already waiting arms its own timer for it.
      let leaseTimer = null;
      const armLeaseTimer = (retryAfterMs) => {
        if (cleaned || typeof retryAfterMs !== "number") return;
        if (timeoutMs !== null && retryAfterMs >= timeoutMs) return;
        leaseTimer = setTimeout(() => respond({ leaseExpiry: true }).catch(handleRespondError), retryAfterMs);
        leaseTimer.unref?.();
      };
      let cleaned = false;
      let responding = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        if (leaseTimer) clearTimeout(leaseTimer);
        if (heartbeat) clearInterval(heartbeat);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        events.off("browser-disconnected", onBrowserDisconnected);
        setPollActive(key, activePolls, deliveredFeedback, events, false);
        if (!activePolls.has(key)) clearBrowserDisconnectTimer(key);
        refreshIdleTimer();
      };
      const respond = async ({ leaseExpiry = false, browserDisconnected = false } = {}) => {
        if (responding || res.writableEnded) return;
        responding = true;
        try {
          const result = await store.takeFeedback(key);
          if (leaseExpiry && result.status === "waiting") {
            // The lease was acked in the meantime; keep waiting for real feedback.
            responding = false;
            armLeaseTimer(result.retry_after_ms);
            return;
          }
          // Feedback or an end that raced the grace timer wins. The disconnect result only
          // replaces a poll that would otherwise keep waiting, and it touches no lease: a batch
          // still leased to an earlier poll is left for the next drain.
          const body = browserDisconnected && result.status === "waiting" ? { status: "browser_disconnected" } : result;
          if (body.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
          if (streamHeartbeat) {
            res.end(JSON.stringify(body));
          } else {
            res.json(body);
          }
        } finally {
          cleanup();
        }
      };
      function handleRespondError(error) {
        if (streamHeartbeat) {
          cleanup();
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        next(error);
      }
      const onFeedback = (changedKey) => {
        if (changedKey !== key || res.writableEnded) {
          return;
        }
        respond().catch(handleRespondError);
      };
      const onBrowserDisconnected = (changedKey) => {
        if (changedKey !== key || res.writableEnded) return;
        respond({ browserDisconnected: true }).catch(handleRespondError);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      events.on("browser-disconnected", onBrowserDisconnected);
      req.on("close", cleanup);
      armLeaseTimer(immediate.retry_after_ms);
    } catch (error) {
      next(error);
    }
  });

  // Retires a delivered batch. The CLI sends this only after the batch is fully on stdout, so a
  // poll that dies first leaves the lease to expire and the batch is delivered again.
  app.post("/api/:key/ack", async (req, res, next) => {
    try {
      const deliveryId = String(req.body?.delivery_id || "");
      if (!deliveryId) {
        res.status(400).json({ error: "delivery_id is required" });
        return;
      }
      const result = await store.ackFeedback(req.params.key, deliveryId);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({ status: "acked", retired: result.retired });
    } catch (error) {
      next(error);
    }
  });

  // The one route that puts words in the reviewer's mouth: whatever lands here reaches the agent
  // as the user's own instructions. The session key is derived from the artifact path, not a
  // secret, so knowing it must not be enough - only this server's own chrome may queue prompts.
  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin prompt submission rejected" });
        return;
      }
      const shouldEndSession = Boolean(req.body?.endSession || req.body?.end_session);
      const hasLayoutWarningPrompt = Array.isArray(req.body?.prompts)
        ? req.body.prompts.some((prompt) => prompt?.tag === "layout-warnings")
        : false;
      const session = await store.queuePrompts(req.params.key, req.body || {});
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // The session was already ended by someone else before this batch arrived - no agent will
      // ever poll it again, so a 200 here would be a lie. Nothing was persisted; the chrome keeps
      // its queue and goes read-only itself in case it missed the SSE `ended` event.
      if (session.ended) {
        res.status(409).json({ status: "ended", error: "session already ended", ended_by: session.ended_by });
        return;
      }
      if (session.conflict) {
        res.status(409).json({
          status: "conflict",
          error: "a layout warning changed before it was sent; review the warning again",
          warning_ids: session.warning_ids,
          warnings: session.warnings,
        });
        return;
      }
      if (shouldEndSession) clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      if (hasLayoutWarningPrompt) {
        await syncOutstandingRepairs(req.params.key);
        events.emit("layout-warnings", req.params.key, serializeLayoutWarnings(session.layout_warnings));
      }
      events.emit(shouldEndSession ? "ended" : "feedback", req.params.key, session.ended_by);
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
      if (shouldEndSession) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  // Passive detection. A diagnostic pass updates the warning inbox and notifies open browser
  // chromes - it never emits "feedback", so it can never make `lavish-axi poll` return and can
  // never wake an agent. Only the user's explicit "Queue selected fixes" does that, through the
  // ordinary prompt queue.
  app.post("/api/:key/layout-diagnostics", async (req, res, next) => {
    try {
      const result = await store.recordLayoutDiagnostics(req.params.key, req.body || {}, {
        viewportClasses: diagnosticViewportClasses,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const activeCount = activeLayoutWarningCount(result.session.layout_warnings);
      if (!result.stale) {
        await syncOutstandingRepairs(req.params.key);
        if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      }
      res.json({ status: result.stale ? "stale" : "recorded", active_count: activeCount, warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/layout-warnings", async (req, res, next) => {
    try {
      const result = await store.listLayoutWarnings(req.params.key);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({ warnings: result.warnings, revision: result.revision });
    } catch (error) {
      next(error);
    }
  });

  // Prepare the user's selected warnings. The prompt commits the repair request through
  // /api/:key/prompts with the rest of the ordinary feedback queue.
  app.post("/api/:key/layout-warnings/queue", async (req, res, next) => {
    try {
      const result = await store.prepareLayoutWarningFixes(req.params.key, req.body?.ids);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        status: result.queued.length > 0 ? "prepared" : "unchanged",
        queued_count: result.queued.length,
        prompt: result.prompt,
        warnings: result.warnings,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/layout-warnings/dismiss", async (req, res, next) => {
    try {
      const result = await store.dismissLayoutWarning(req.params.key, req.body?.id);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      res.json({ status: result.changed ? "dismissed" : "unchanged", warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  // The narrow fatal path: the artifact cannot be served, or one of its own local assets failed
  // to load. There is no usable review to triage from, so this still reaches the agent directly.
  app.post("/api/:key/artifact-failures", async (req, res, next) => {
    try {
      const result = await store.recordArtifactFailures(req.params.key, req.body || {});
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: "stale" });
        return;
      }
      if (result.changed) events.emit("feedback", req.params.key);
      res.json({ status: "recorded" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      const session = await store.endSession(req.params.key, "user");
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit("ended", req.params.key, session?.ended_by);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const session = await store.addAgentReply(req.params.key, text);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("agent-reply", req.params.key, text);
      // The reply concludes the delivered-feedback "working" state. Without this, a poll that
      // drains feedback and then releases leaves presence stuck on "working" - the chrome keeps
      // Send disabled - until some future poll happens to attach, even though the agent already
      // answered. See "SSE agent-presence returns to waiting after an agent reply".
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  // Static export: inline the artifact's local assets into one portable HTML file the user can
  // open from disk or host anywhere, with no dependency on this server. Remote CDN/font URLs are
  // left as references for the browser to load, so the export needs network to render those.
  app.get("/api/:key/export", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      const { unresolved, notices } = splitExportWarnings(warnings);
      // Although this response downloads in normal chrome usage, an escaped artifact popup can
      // navigate to it directly. Preserve the artifact's opaque-origin boundary if the browser
      // renders the exported HTML instead of saving it.
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      res.setHeader("content-disposition", exportContentDisposition(session.file));
      res.setHeader("x-lavish-export-warning-count", String(unresolved.length));
      res.setHeader("x-lavish-export-notice-count", String(notices.length));
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });

  // Tombstone for upstream's hosted-share route, which published the local-inlined artifact to
  // ht-ml.app (a third-party host, not part of Lavish). This fork does not publish anywhere, and
  // the browser chrome no longer ships a Publish button or share dialog to call this. The route
  // stays as an explicit 410 so an agent that learned the upstream API gets "deliberately gone"
  // rather than a generic 404 it might read as a broken build.
  app.post("/api/:key/share", async (_req, res) => {
    res.status(410).json({
      error: "publishing to ht-ml.app is disabled in this fork (askzy/lavish-axi)",
    });
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      // Ending only rewrites the record, so it must not depend on the artifact still existing:
      // a session whose HTML was deleted was previously impossible to close from any route.
      const file = await canonicalSessionFile(req.body.file);
      const key = sessionKey(file);
      const session = await store.endSession(key, "agent");
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      events.emit("ended", key, session.ended_by);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const chromeLoad = await store.issueReviewerHandoff(req.params.key);
      if (!chromeLoad) {
        res.status(404).send("Session not found");
        return;
      }
      const session = chromeLoad.session;
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      const artifactHtml = await readFile(session.file, "utf8").catch(() => "");
      const { faviconTag, title } = extractArtifactHead(artifactHtml);
      // Nothing legitimately frames the review chrome - it is the top-level page, and exports
      // ship standalone HTML rather than embedding it. Refusing to be framed denies an attacker
      // page both a window handle to this chrome and a clickjacking surface over Send. Scoped to
      // this route: /artifact/* is framed by this page.
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      res.type("html").send(
        createChromeHtml(session, {
          layoutGateEnabled: shouldEnableLayoutGate(req.query || {}),
          faviconTag,
          title: title ? `${title} · Lavish` : "Lavish Editor",
          artifactRevision: chromeLoad.artifact_revision,
          artifactLoadToken: chromeLoad.artifact_load_token,
          artifactLoadSequence: chromeLoad.artifact_load_sequence,
          chromeLoadToken: chromeLoad.chrome_load_token,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.post("/api/:key/chrome-loads/begin", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin chrome handoff rejected" });
        return;
      }
      const handoff = await store.issueReviewerHandoff(req.params.key);
      if (!handoff) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        chrome_load_token: handoff.chrome_load_token,
        artifact_revision: handoff.artifact_revision,
        artifact_load_token: handoff.artifact_load_token,
        artifact_load_sequence: handoff.artifact_load_sequence,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/artifact-loads/begin", async (req, res, next) => {
    try {
      const result = await store.beginArtifactLoad(req.params.key, {
        requestId: req.body?.request_id,
        requestSequence: req.body?.request_sequence,
        handoffToken: req.body?.chrome_load_token,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: result.stale });
        return;
      }
      res.json({ artifact_revision: result.artifact_revision, artifact_load_token: result.artifact_load_token });
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      const key = req.params[0];
      const token = String(req.query.artifact_load_token || "");
      const revision = req.query.artifact_revision;
      const beforeRead = await store.verifyArtifactLoad(key, token, revision);
      if (!beforeRead) {
        res.status(404).send("Session not found");
        return;
      }
      if (!beforeRead.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Lavish to continue.</p>",
          );
        return;
      }
      const html = await readFile(beforeRead.session.file, "utf8");
      const verified = await store.verifyArtifactLoad(key, token, revision);
      if (!verified?.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Lavish to continue.</p>",
          );
        return;
      }
      res.type("html").send(injectLavishSdk(html, key, verified.artifact_revision, verified.artifact_load_token));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const root = path.dirname(session.file);
      const file = await resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  function hasSseClient(key) {
    for (const clientKey of sseClients.values()) {
      if (clientKey === key) return true;
    }
    return false;
  }

  function clearBrowserDisconnectTimer(key) {
    const timer = browserDisconnectTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    browserDisconnectTimers.delete(key);
  }

  // Losing the last chrome for a session starts the grace timer, but only while a poll is
  // waiting on it: a poll that starts later with no browser attached gets its own full wait.
  // A reconnect within the grace period cancels the timer, so a reload never releases a poll.
  function scheduleBrowserDisconnect(key) {
    clearBrowserDisconnectTimer(key);
    if (shuttingDown || hasSseClient(key) || !activePolls.has(key)) return;
    const timer = setTimeout(() => {
      browserDisconnectTimers.delete(key);
      if (!hasSseClient(key) && activePolls.has(key)) events.emit("browser-disconnected", key);
    }, browserDisconnectGraceMs);
    timer.unref?.();
    browserDisconnectTimers.set(key, timer);
  }

  app.get("/events/:key", async (req, res, next) => {
    let cleanup = () => {};
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.set(res, req.params.key);
      clearBrowserDisconnectTimer(req.params.key);
      refreshIdleTimer();
      const sendReload = (key) => {
        if (key === req.params.key) {
          res.write("event: reload\ndata: {}\n\n");
        }
      };
      const sendAgentReply = (key, text) => {
        if (key === req.params.key) {
          res.write(`event: agent-reply\ndata: ${JSON.stringify({ text })}\n\n`);
        }
      };
      const sendPresence = (key, state) => {
        if (key === req.params.key) {
          res.write(`event: agent-presence\ndata: ${JSON.stringify({ state })}\n\n`);
        }
      };
      // Warning-inbox state lives on the server, so every attached chrome - including one that
      // just reconnected after a browser refresh - converges on the same list.
      const sendLayoutWarnings = (key, warnings) => {
        if (key === req.params.key) {
          res.write(`event: layout-warnings\ndata: ${JSON.stringify({ warnings })}\n\n`);
        }
      };
      // A session end (`lavish-axi end` or the browser's own End/Send & End) must reach every
      // attached chrome, not just a poll waiter - otherwise a tab left open keeps accepting Sends
      // nobody will ever poll (upstream #171).
      const sendEnded = (key, endedBy) => {
        if (key === req.params.key) {
          res.write(`event: ended\ndata: ${JSON.stringify({ ended_by: endedBy || null })}\n\n`);
        }
      };
      // Listeners must be registered BEFORE the session read below: an end that lands during
      // that await would otherwise fire "ended" while nothing here is listening yet, and this
      // connection would never learn the session ended.
      events.on("reload", sendReload);
      events.on("agent-reply", sendAgentReply);
      events.on("agent-presence", sendPresence);
      events.on("layout-warnings", sendLayoutWarnings);
      events.on("ended", sendEnded);
      let cleanedUp = false;
      cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        req.off("close", cleanup);
        sseClients.delete(res);
        scheduleBrowserDisconnect(req.params.key);
        events.off("reload", sendReload);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-presence", sendPresence);
        events.off("layout-warnings", sendLayoutWarnings);
        events.off("ended", sendEnded);
        refreshIdleTimer();
      };
      req.once("close", cleanup);
      const session = await store.findByKey(req.params.key);
      if (req.destroyed || res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(
        `event: agent-presence\ndata: ${JSON.stringify({ state: computePresence(req.params.key, activePolls, deliveredFeedback) })}\n\n`,
      );
      // A connection that attaches (or reconnects) to a session already ended - including one
      // that misses the live "ended" event entirely by connecting after it fired - still needs to
      // learn that on its own; `markSessionEnded()` is idempotent, so a duplicate is harmless.
      if (session?.status === "ended") sendEnded(req.params.key, session.ended_by);
    } catch (error) {
      cleanup();
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/design/:asset", async (req, res, next) => {
    try {
      const asset = designAssetUrls[req.params.asset];
      if (!asset) {
        res.status(404).send("Not found");
        return;
      }
      res.type(asset.type).send(await readDesignAsset(asset));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", async (req, res, next) => {
    try {
      const verified = await store.verifyArtifactLoad(
        String(req.query.key || ""),
        req.query.artifact_load_token,
        req.query.artifact_revision,
      );
      if (!verified) {
        res.status(404).send("Session not found");
        return;
      }
      if (!verified.valid) {
        res.status(409).json({ status: "stale" });
        return;
      }
      res
        .type("application/javascript")
        .send(createSdkJs(String(req.query.key || ""), verified.artifact_revision, verified.artifact_load_token));
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => {
      if (s.address()) resolve(s);
    });
    s.once("error", reject);
  });
  publicPort = httpServer.address().port;

  function shutdown(reloadKey = "", reason = "") {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // Only the chrome whose artifact is being reopened is reloaded: the replacement server
    // adopts that session via state.json once it binds, and the caller named it. Every other
    // open review page is told why this server went away and left alone - a forced reload of a
    // page the user is reading or writing in is exactly what this avoids. Both events carry the
    // same reason so two pages never describe one shutdown differently.
    const shutdownData = JSON.stringify({ reason });
    for (const [res, clientKey] of sseClients) {
      try {
        if (reloadKey && clientKey === reloadKey) {
          res.write(`event: chrome-reload\ndata: ${shutdownData}\n\n`);
        } else {
          res.write(`event: chrome-outdated\ndata: ${shutdownData}\n\n`);
        }
        res.end();
      } catch {
        // best effort
      }
    }
    sseClients.clear();
    for (const timer of browserDisconnectTimers.values()) clearTimeout(timer);
    browserDisconnectTimers.clear();
    for (const w of watchers.values()) {
      w.close().catch(() => {});
    }
    watchers.clear();
    httpServer.close(() => shutdownResolve());
    // Force-close keep-alive sockets so SSE / long-polls don't keep us alive.
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
  }

  // Idle self-shutdown: the timer only runs while nothing is connected. Any live SSE chrome or
  // active long-poll cancels it; losing the last connection (re)arms it.
  let idleTimer = null;
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && sseClients.size === 0 && activePolls.size === 0) {
        logEvent?.(`idle for ${idleTimeoutMs}ms with no connections, shutting down`);
        shutdown();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // When the final open session ends with nothing connected, there is nothing left to serve,
  // so step down immediately rather than waiting out the idle timeout. If a browser chrome or
  // poll is still attached (e.g. the user is about to reopen), leave the server up and let the
  // idle timer reap it once those connections drop. Best-effort: never let a read failure
  // block the end response.
  async function shutdownIfNoLiveSessions() {
    if (sseClients.size > 0 || activePolls.size > 0) return;
    try {
      const sessions = await store.listSessions();
      if (sessions.every((session) => session.status === "ended")) {
        logEvent?.("last open session ended with no live connections, shutting down");
        setImmediate(shutdown);
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  // A queued repair batch is outstanding until a diagnostic pass re-checks it. While it is, the
  // agent's related saves coalesce into one artifact refresh for that group.
  async function syncOutstandingRepairs(key) {
    try {
      if (await store.hasOutstandingLayoutRepairs(key)) {
        outstandingRepairBatches.add(key);
      } else {
        outstandingRepairBatches.delete(key);
      }
    } catch {
      // Best effort - the normal debounce still applies.
    }
  }

  function reloadDebounceMs(key) {
    return outstandingRepairBatches.has(key) ? BATCH_RELOAD_DEBOUNCE_MS : RELOAD_DEBOUNCE_MS;
  }

  // Housekeeping runs at start so no scheduler or agent discipline is needed to keep state.json
  // and .lavish/ from growing forever. It must never stop the server from coming up.
  async function runStartupPrune() {
    try {
      const maxAgeMs = pruneMaxAgeMs === undefined ? resolvePruneMaxAgeMs() : pruneMaxAgeMs;
      if (maxAgeMs === null) return;
      const result = await prune({
        store,
        maxAgeMs,
        unrepliedMaxAgeMs: resolvePruneUnrepliedMaxAgeMs(),
        openMaxAgeMs: resolvePruneOpenMaxAgeMs(),
      });
      if (result.sessionsRemoved > 0 || result.filesRemoved > 0) {
        writeLog(`[lavish] prune: ${formatPruneSummary(result)}`);
      }
    } catch (error) {
      writeLog(`[lavish] prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await runStartupPrune();

  // Arm the idle timer for a server that is spawned but never opens a session.
  refreshIdleTimer();

  return {
    port: httpServer.address().port,
    close: async () => {
      shutdown();
      await done;
    },
    done,
  };
}

async function readDesignAsset(asset) {
  try {
    return await readFile(asset.packaged, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return readFile(asset.source, "utf8");
  }
}

// Map a legacy root-absolute `/design/<asset>` reference to the packaged design file on disk
// (falling back to the node_modules source for source runs) so an export can inline it instead
// of pointing back at this server's `/design` route.
export function resolveDesignAssetPath(refPath) {
  const match = /^\/design\/([^/?#]+)(?:[?#].*)?$/.exec(refPath);
  if (!match) return null;
  const asset = designAssetUrls[match[1]];
  if (!asset) return null;
  const packaged = fileURLToPath(asset.packaged);
  if (existsSync(packaged)) return packaged;
  const source = fileURLToPath(asset.source);
  return existsSync(source) ? source : null;
}

export function exportContentDisposition(file) {
  const filename = exportFileName(file);
  return `attachment; filename="${sanitizeDispositionFilename(filename)}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function sanitizeDispositionFilename(filename) {
  const fallback = Array.from(String(filename || ""), (char) => {
    const codePoint = char.codePointAt(0) || 0;
    if (codePoint < 0x20 || codePoint > 0x7e || char === '"' || char === "\\") return "_";
    return char;
  }).join("");
  return fallback || "artifact.export.html";
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(String(value)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Wildcard bind addresses ("all interfaces") are not connectable hostnames, so
// they never belong in the Host allowlist - and "0.0.0.0" as a Host is a known
// loopback-reach trick, so it must stay rejected.
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

// The set of Host header hostnames this server answers to: loopback names plus
// the resolved bind and link host and any explicit LAVISH_AXI_ALLOWED_HOSTS
// extras, minus wildcard binds and the "*" sentinel. Lowercased for
// case-insensitive comparison against the incoming Host.
export function buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts = [] }) {
  return new Set(
    [LOOPBACK_HOST, IPV6_LOOPBACK_HOST, "localhost", host, linkHostName, ...allowedHosts]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => value && value !== "*" && !WILDCARD_BIND_HOSTS.has(value)),
  );
}

// A lone "*" in LAVISH_AXI_ALLOWED_HOSTS is an explicit opt-out of the Host
// allowlist, for operators who front the server with their own auth/proxy.
export function allowsAllHosts(allowedHosts = []) {
  return allowedHosts.some((value) => String(value).trim() === "*");
}

// Parse a Host-style authority (`hostname[:port]`, with bracketed IPv6 literals) into its
// parts, or null when it is malformed: trailing garbage after a bracket, userinfo, a bare IPv6
// literal, a non-numeric or out-of-range port, or anything the URL parser would not accept.
function parseHostAuthority(value) {
  const raw = String(value).trim();
  if (!raw || /[@/\\?#\s]/.test(raw)) return null;

  let hostname;
  let port;
  let bracketed = false;
  if (raw.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(raw);
    if (!match || isIP(match[1]) !== 6) return null;
    [, hostname, port = ""] = match;
    bracketed = true;
  } else {
    const match = /^([A-Za-z0-9._-]+)(?::(\d+))?$/.exec(raw);
    if (!match) return null;
    [, hostname, port = ""] = match;
  }
  if (port && Number(port) > 65535) return null;

  hostname = hostname.toLowerCase();
  const authority = `${bracketed ? `[${hostname}]` : hostname}${port ? `:${port}` : ""}`;
  try {
    const parsed = new URL(`http://${authority}`);
    if (!parsed.origin || parsed.origin === "null") return null;
  } catch {
    return null;
  }
  return { hostname, port, authority };
}

// Extract the hostname (without port) from a Host header value, honoring
// bracketed IPv6 literals ("[::1]:4387"). Returns null for a malformed authority.
export function hostnameFromHostHeader(value) {
  return parseHostAuthority(value)?.hostname ?? null;
}

// DNS-rebinding defense: a loopback-bound server answers only to its own known
// hostnames. A rebound browser carries the attacker's domain in Host and is
// rejected. Host is mandatory in HTTP/1.1 and every browser sends it, so a
// missing or blank value is never a legitimate client - reject it rather than
// fail open.
export function isAllowedHostHeader(hostHeader, allowedHostnames) {
  if (hostHeader === undefined || hostHeader === null) return false;
  const authority = parseHostAuthority(hostHeader);
  return authority !== null && allowedHostnames.has(authority.hostname);
}

// Validate a request's effective host for DNS-rebinding protection. The Host
// header is required and must be allowlisted. When an X-Forwarded-Host is present
// - a reverse proxy in front of the loopback server - its outermost (last) value
// must ALSO be allowlisted, so a proxy works once its public hostname is added to
// LAVISH_AXI_ALLOWED_HOSTS. This is an AND check: a client-spoofed forwarded host
// can only narrow access (Host is still checked), never widen it into a bypass. A
// blank forwarded host is treated as absent, matching how proxies omit it.
/**
 * @param {{ host?: string|undefined|null, forwardedHost?: string|undefined|null }} headers
 * @param {Set<string>} allowedHostnames
 */
export function isAllowedRequestHost({ host, forwardedHost }, allowedHostnames) {
  if (!isAllowedHostHeader(host, allowedHostnames)) return false;
  const forwarded = forwardedHost === undefined || forwardedHost === null ? "" : String(forwardedHost).trim();
  if (forwarded === "") return true;
  return isAllowedHostHeader(forwarded.split(",").pop(), allowedHostnames);
}

function hasPresentOriginOrReferer(req) {
  return Boolean(req.get("origin") || req.get("referer"));
}

// Guard state-changing routes against CSRF: a browser attaches an Origin/Referer that must match
// this server's own origin. Upstream introduced this for the ht-ml.app publish route, which this
// fork disables; the reviewer-handoff and prompts routes need the same guard, so it stays. The
// global mutating-route middleware reuses it too; that middleware is lenient (absent headers pass)
// while per-route callers still reject header-less requests. Behind a reverse proxy the expected
// origin is built from the outermost X-Forwarded-Host (validated as a complete authority against
// the same allowlist as Host) and X-Forwarded-Proto.
function isSameOriginRequest(req, allowedHostnames, allowAnyHostname = false) {
  const host = parseHostAuthority(req.headers.host);
  if (!host) return false;

  let protocol = req.protocol;
  let authority = host;
  const forwardedHost = String(req.get("x-forwarded-host") || "")
    .split(",")
    .pop()
    .trim();
  if (forwardedHost) {
    const forwardedAuthority = parseHostAuthority(forwardedHost);
    if (
      !forwardedAuthority ||
      (!allowAnyHostname &&
        (!allowedHostnames.has(host.hostname) || !allowedHostnames.has(forwardedAuthority.hostname)))
    )
      return false;
    protocol = String(req.get("x-forwarded-proto") || req.protocol)
      .split(",")
      .pop()
      .trim()
      .toLowerCase();
    if (protocol !== "http" && protocol !== "https") return false;
    authority = forwardedAuthority;
  }
  const expectedOrigin = normalizeOrigin(`${protocol}://${authority.authority}`);
  if (!expectedOrigin) return false;
  const origin = req.get("origin");
  if (origin) {
    return normalizeOrigin(origin) === expectedOrigin;
  }
  const referer = req.get("referer");
  return Boolean(referer) && normalizeOrigin(referer) === expectedOrigin;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

// Confines an asset request lexically first, then - like export-bundle.js's guardedRead -
// resolves the real (symlink-followed) path and refuses anything that escapes the artifact
// directory, so a symlink placed beside the artifact can't make this route serve an outside
// file (e.g. ~/.ssh/id_rsa).
export async function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  let real;
  try {
    real = await realpath(file);
  } catch (error) {
    // Nonexistent path (e.g. an asset that hasn't been built yet): nothing to read, so the
    // lexical confinement above is enough - the caller's existsSync/sendFile handles the 404.
    // Every other realpath failure fails closed, like guardedRead.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return file;
    }
    throw error;
  }
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const relativeReal = path.relative(realRoot, real);
  if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
    return null;
  }
  // Hand back the resolved path, not the requested one: a real path contains no symlinks, so
  // sendFile re-opening it cannot be redirected by a link swapped in after this check.
  return real;
}

/**
 * @param {(key: string) => number} reloadDebounceMs
 */
async function watchSession(session, watchers, events, logEvent, reloadDebounceMs = () => RELOAD_DEBOUNCE_MS) {
  if (watchers.has(session.key)) {
    return;
  }
  const target = await resolveWatchTarget(session);
  if (watchers.has(session.key)) {
    return;
  }
  logEvent?.(`watch session=${session.key} scope=${target.scope} path=${target.path}`);
  const watcher = chokidar.watch(target.path, target.options);
  let timer = null;
  watcher.on("all", (event, file) => {
    logEvent?.(`watch event=${event} session=${session.key} file=${file ?? ""}`);
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), reloadDebounceMs(session.key));
  });
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logEvent?.(`watch error session=${session.key} message=${message}`);
  });
  watchers.set(session.key, watcher);
}

// Watching the artifact's parent directory recursively can stall the event loop when the
// artifact lives in a large tree (e.g. ~/Downloads). Default to watching only the artifact
// itself; an artifact opts back into directory-wide live reload via either a
// `data-lavish-live-reload-root` attribute on its root element or
// `<meta name="lavish-live-reload" content="root">`.
export async function resolveWatchTarget(session) {
  const baseOptions = {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  };
  try {
    const html = await readFile(session.file, "utf8");
    if (hasLiveReloadRootOptIn(html)) {
      return {
        path: path.dirname(session.file),
        scope: "directory",
        options: {
          ...baseOptions,
          ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
        },
      };
    }
  } catch {
    // Fall through to file-only watching when the artifact can't be read.
  }
  return { path: session.file, scope: "file", options: baseOptions };
}

export function hasLiveReloadRootOptIn(html) {
  if (typeof html !== "string") return false;
  const searchableHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<html\b[^>]*\sdata-lavish-live-reload-root(?:[\s=>/]|$)[^>]*>/i.test(searchableHtml)) return true;
  return /<meta\b(?=[^>]*name=["']lavish-live-reload["'])(?=[^>]*content=["']root["'])[^>]*>/i.test(searchableHtml);
}

function setPollActive(key, activePolls, deliveredFeedback, events, active) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) {
    activePolls.delete(key);
  } else {
    activePolls.set(key, nextCount);
    deliveredFeedback.delete(key);
  }
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

function markFeedbackDelivered(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.add(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

function clearFeedbackDelivery(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.delete(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

export function computePresence(key, activePolls, deliveredFeedback) {
  if (activePolls.has(key)) return "listening";
  if (deliveredFeedback.has(key)) return "working";
  return "waiting";
}

function chromeIcon(paths, size = 16, strokeWidth = 1.7) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const chromeIcons = {
  more: chromeIcon(
    '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  ),
  file: chromeIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    13,
  ),
  copy: chromeIcon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    12,
  ),
  check: chromeIcon('<polyline points="20 6 9 17 4 12"/>', 12),
  refresh: chromeIcon(
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    15,
  ),
  camera: chromeIcon(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    15,
  ),
  download: chromeIcon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    15,
  ),
  exit: chromeIcon(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    15,
  ),
  warning: chromeIcon(
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    16,
  ),
  reveal: chromeIcon('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>', 13),
  dismiss: chromeIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13),
};

// Display the path with the home directory shortened to "~", split so the directory part can
// ellipsize in the menu while the file name itself always stays visible.
export function displayPathParts(file, home = homedir()) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  const display =
    normalizedHome && normalizedFile.startsWith(`${normalizedHome}/`)
      ? `~/${normalizedFile.slice(normalizedHome.length + 1)}`
      : normalizedFile;
  const tailStart = display.lastIndexOf("/") + 1;
  return { head: display.slice(0, tailStart), tail: display.slice(tailStart) };
}

export function shouldEnableLayoutGate(query = {}) {
  const noGate = query["no-gate"] ?? query.noGate ?? query.no_gate;
  if (isTruthyFlag(noGate)) return false;

  const gate = query.gate ?? query.layoutGate ?? query.layout_gate;
  if (isFalseyFlag(gate)) return false;

  return true;
}

function shouldDisableLayoutGateOpen(body = {}) {
  const noGate = body["no-gate"] ?? body.noGate ?? body.no_gate;
  if (isTruthyFlag(noGate)) return true;

  const gate = body.gate ?? body.layoutGate ?? body.layout_gate;
  return isFalseyFlag(gate);
}

function appendNoGateParam(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("no-gate", "1");
  return parsed.toString();
}

function isTruthyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isFalseyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function normalizeFlagValue(value) {
  if (Array.isArray(value)) return normalizeFlagValue(value[0]);
  return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}

const LAVISH_DEFAULT_FAVICON =
  "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F48E}</text></svg>\">";

function readTagAttr(tag, name) {
  // Tokenize real attributes rather than searching for the bare name anywhere in
  // the tag: a `\b`-anchored name matches attribute-name suffixes (e.g. `href`
  // inside `data-href`) and names that appear inside another attribute's quoted
  // value (e.g. `href=` inside a `title="... href=x"`), both of which would make
  // us adopt the wrong href. Walking whole `name="value"` pairs consumes each
  // value as one unit, so only genuine attribute names are matched.
  const attrRe = /([a-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const target = name.toLowerCase();
  let match;
  while ((match = attrRe.exec(tag)) !== null) {
    if (match[1].toLowerCase() === target) {
      return (match[3] ?? match[4] ?? match[5] ?? "").trim();
    }
  }
  return "";
}

// Pull a tab favicon + title out of the artifact's own <head>. Lavish renders the
// artifact in a sandboxed iframe, so the artifact's own <link rel="icon"> and
// <title> never reach the browser tab; surfacing them here makes a wall of Lavish
// tabs identifiable. Falls back to the Lavish default favicon. Only data: and
// absolute (http/https/protocol-relative) icon hrefs are adopted verbatim;
// artifact-relative hrefs would not resolve against the chrome page, so they fall
// back to the default.
export function extractArtifactHead(html) {
  const head = String(html || "").slice(0, 10000);
  let faviconTag = LAVISH_DEFAULT_FAVICON;
  const linkTags = head.match(/<link\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi) || [];
  const iconTag = linkTags.find((tag) => /(^|\s)icon(\s|$)/i.test(readTagAttr(tag, "rel")));
  const iconHref = iconTag ? readTagAttr(iconTag, "href") : "";
  if (iconHref && /^(data:|https?:|\/\/)/i.test(iconHref)) {
    const safeHref = iconHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    faviconTag = `<link rel="icon" href="${safeHref}">`;
  }
  let title = "";
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/\s+/g, " ").trim();
  return { faviconTag, title };
}

// The chrome page ships with the layout-gate overlay already covering the artifact area. Install
// its bounded escape and manual bypass inline before `chrome-client.js`, so they still work if the
// shared server shuts down between serving the page and serving that script. This block also arms
// the boot-failure card before the external script tag, surviving a request that hangs instead of
// erroring; `chrome-client.js` cancels that boot timer once it has run to completion and reuses the
// gate escape for every later overlay state.
export const CHROME_BOOT_FAILSAFE_MS = 15000;
export const CHROME_LAYOUT_GATE_MAX_HOLD_MS = 12000;
// The failsafe's button is the only control on a page whose client script is dead, so its own
// probe is bounded too: a port that accepts and never answers must not disable it for good.
const CHROME_BOOT_FAILSAFE_PROBE_TIMEOUT_MS = 4000;
const CHROME_BOOT_FAILSAFE_JS = `(function(){
var t=setTimeout(fail,${CHROME_BOOT_FAILSAFE_MS});
var o=document.getElementById("layoutGateOverlay"),h,c,a,b,gt=0,manual=false,ended=false;
try{ended=JSON.parse(document.getElementById("lavish-session").textContent).initialEnded===true;}catch(e){}
function cancelGate(){if(gt)clearTimeout(gt);gt=0;}
function reveal(){cancelGate();if(o)o.hidden=true;if(document.body)document.body.classList.remove("layout-gate-active");}
function manualReveal(){if(ended)return false;manual=true;reveal();return true;}
function armGate(ms,onTimeout){cancelGate();if(!ended)gt=setTimeout(function(){if(ended)return;if(onTimeout)onTimeout();else reveal();},ms);}
function showBypass(){b=document.getElementById("layoutGateBypass");if(b){b.hidden=false;b.onclick=manualReveal;}}
window.__lavishLayoutGateEscape={arm:armGate,cancel:cancelGate,reveal:reveal,manualReveal:manualReveal,showBypass:showBypass,end:function(){ended=true;cancelGate();},isEnded:function(){return ended;},isManuallyBypassed:function(){return manual;}};
a=document.getElementById("layoutGateAction");
if(ended){reveal();b=document.getElementById("endedOverlay");if(b)b.hidden=false;}
if(a&&!ended)a.onclick=manualReveal;
if(o&&!o.hidden&&!ended)armGate(${CHROME_LAYOUT_GATE_MAX_HOLD_MS});
window.__lavishCancelChromeBootFailsafe=function(){clearTimeout(t);};
window.__lavishChromeBootFailed=function(){clearTimeout(t);fail();};
function fail(){
if(window.__lavishChromeReady||ended)return;
h=document.getElementById("layoutGateTitle");
c=document.getElementById("layoutGateCopy");
a=document.getElementById("layoutGateAction");
if(h)h.textContent="Lavish could not finish loading.";
if(c)c.textContent="The Lavish editor script did not load. The server usually restarted while this page was opening. Check and reload to reconnect.";
if(a){a.textContent="Check and reload";a.disabled=false;a.onclick=check;}
showBypass();
if(o)o.hidden=false;
if(document.body)document.body.classList.add("layout-gate-active");
armGate(${CHROME_LAYOUT_GATE_MAX_HOLD_MS});
}
function check(){
if(a)a.disabled=true;
var ctl=new AbortController();
var pt=setTimeout(function(){ctl.abort();},${CHROME_BOOT_FAILSAFE_PROBE_TIMEOUT_MS});
fetch("/health",{cache:"no-store",signal:ctl.signal}).then(function(r){return r&&r.ok?"running":"not-running";},function(){return ctl.signal.aborted?"no-answer":"not-running";}).then(function(outcome){
clearTimeout(pt);
if(outcome==="running"){location.reload();return;}
if(a)a.disabled=false;
if(c)c.textContent=outcome==="no-answer"?"Lavish did not answer the check, so this page cannot tell whether it is running. Try again in a moment.":"Lavish is still not running. Start it again with your agent, then use Check and reload.";
});
}
})();`;

export function createChromeHtml(
  session,
  {
    layoutGateEnabled = true,
    faviconTag = LAVISH_DEFAULT_FAVICON,
    title = "Lavish Editor",
    artifactRevision = 0,
    artifactLoadToken = "",
    artifactLoadSequence = 0,
    chromeLoadToken = "",
  } = {},
) {
  const sessionJson = jsonScript({
    key: session.key,
    file: session.file,
    // A page loaded (or reloaded) after the session already ended has no future SSE `ended`
    // event to wait for - it must start read-only instead of looking live until the user tries
    // to send and gets refused.
    initialEnded: session.status === "ended",
    initialEndedBy: session.ended_by || null,
    initialChat: session.chat || [],
    // Bootstrapping the inbox from the server is what makes it survive a browser refresh or a
    // reconnect: the chrome never owns warning state, it only renders it.
    initialLayoutWarnings: serializeLayoutWarnings(session.layout_warnings),
    initialArtifactRevision: artifactRevision,
    initialArtifactLoadToken: artifactLoadToken,
    initialArtifactLoadSequence: artifactLoadSequence,
    chromeLoadToken,
    layoutGateEnabled,
    modeToggleHotkeyKey: MODE_TOGGLE_HOTKEY_KEY,
  });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  const bodyClass = layoutGateEnabled ? "lavish layout-gate-active" : "lavish";
  const layoutGateHidden = layoutGateEnabled ? "" : " hidden";
  const modeHotkeyUpper = MODE_TOGGLE_HOTKEY_KEY.toUpperCase();
  const modeToggleHint = `Toggle annotate/explore mode (⌘${modeHotkeyUpper} / Ctrl+${modeHotkeyUpper})`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${faviconTag}
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="${bodyClass}">
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div><div class="spacer" aria-hidden="true"></div><div class="warnings-wrap" id="warningsWrap" hidden><button class="warnings-button" id="warningsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="warningsDrawer">${chromeIcons.warning}<span class="warnings-count" id="warningsCount">0</span></button><div class="menu warnings-drawer" id="warningsDrawer" role="dialog" aria-labelledby="warningsTitle" aria-describedby="warningsSummary" hidden><div class="warnings-head"><h2 class="warnings-title" id="warningsTitle">Layout issues</h2><p class="warnings-summary" id="warningsSummary"></p></div><div class="warnings-toolbar"><label class="warnings-selectall"><input type="checkbox" id="warningsSelectAll"><span>Select all</span></label><span class="warnings-selected" id="warningsSelected" role="status" aria-live="polite"></span></div><div class="warnings-list" id="warningsList"></div><div class="warnings-foot"><p class="warnings-note">Queueing sends a repair request with your next feedback. An issue is marked resolved only after a newer artifact load and a complete check at the same viewport no longer finds it.</p><button class="button" id="warningsQueueButton" type="button" disabled>Queue selected fixes</button></div></div></div><button class="annotate-switch" id="annotation" type="button" aria-pressed="true" title="${escapeHtml(modeToggleHint)}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Editing</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>Reload artifact</span></button><button class="menu-item" id="copySnapshot" type="button">${chromeIcons.camera}<span>Copy DOM snapshot</span></button><button class="menu-item" id="exportArtifact" type="button">${chromeIcons.download}<span>Export standalone HTML</span></button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">${chromeIcons.exit}<span>End session</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" data-artifact-src="/artifact/${session.key}/index.html"></iframe></div><aside class="panel"><h2>Conversation</h2><div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotation-pills" id="annotationPills"></div></div><div class="composer"><div class="presence-banner handoff-banner" id="handoffBanner" hidden><span>This review is open in another Lavish tab.</span><button class="handoff-takeover" id="handoffTakeover" type="button">Take over here</button></div><div class="presence-banner handoff-banner" id="outdatedBanner" hidden><span id="outdatedText">The Lavish server this page was connected to is no longer running. Reloading will work once it is running again.</span><span class="outdated-actions"><button class="handoff-takeover" id="outdatedReload" type="button">Check and reload</button><button class="handoff-takeover" id="outdatedDismiss" type="button">Dismiss</button></span></div><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from Lavish.</div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="send-hint" id="sendHint" hidden>Write a message or annotate an element first.</div><div class="actions" id="sendActions"><button class="button button-danger" id="sendAndEnd" type="button">${chromeIcons.exit}<span>Send &amp; End</span></button><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<div class="ended-overlay layout-gate-overlay" id="layoutGateOverlay"${layoutGateHidden}><div class="ended-card"><div class="ended-title" id="layoutGateTitle">Checking layout.<br>One moment.</div><p class="ended-copy" id="layoutGateCopy">Lavish is waiting for fonts and final geometry before revealing this artifact.</p><button class="button ended-action" id="layoutGateAction" type="button">Show anyway</button><button class="button ended-action layout-gate-bypass" id="layoutGateBypass" type="button" hidden>Show anyway</button></div></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div><p class="ended-copy">${escapeHtml(session.file)}</p></div></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script>${CHROME_BOOT_FAILSAFE_JS}</script>
<script src="/chrome-client.js" onerror="window.__lavishChromeBootFailed()"></script>
</body>
</html>`;
}

export function createSdkJs(key, artifactRevision = 0, artifactLoadToken = "") {
  // Serialize every helper exported by mermaid-node.js as a same-scope const so
  // cross-helper calls (e.g. mermaidNodeFrom → mermaidNodeElement) resolve in the
  // browser. Deriving this from the module's exports — rather than a hand-kept
  // list — means adding a helper can never silently ReferenceError at runtime.
  const mermaidHelperEntries = Object.entries(mermaidNode).filter(([, value]) => typeof value === "function");
  const mermaidHelperDecls = mermaidHelperEntries.map(([name, fn]) => `const ${name}=${fn.toString()};`).join("\n");
  const mermaidHelperKeys = mermaidHelperEntries.map(([name]) => name).join(", ");
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : 0;
  const loadToken = String(artifactLoadToken || "").slice(0, 200);
  return `(() => {
const key=${JSON.stringify(key)};
void key;
const artifactRevision=${revision};
const artifactLoadToken=${JSON.stringify(loadToken)};
const deriveQueueKey=${deriveLavishQueueKey.toString()};
const isNativeInteractiveControl=${isNativeInteractiveControl.toString()};
const MODE_TOGGLE_HOTKEY_KEY=${JSON.stringify(MODE_TOGGLE_HOTKEY_KEY)};
const isModeToggleHotkeyEvent=${isModeToggleHotkeyEvent.toString()};
const classifySevereTextOverflow=${classifySevereTextOverflow.toString()};
const classifyMaterialRectEscape=${classifyMaterialRectEscape.toString()};
const isMaterialPageOverflow=${isMaterialPageOverflow.toString()};
const findStableLayoutFindings=${findStableLayoutFindings.toString()};
const isNearTotalOcclusion=${isNearTotalOcclusion.toString()};
const srgbRelativeLuminance=${srgbRelativeLuminance.toString()};
const srgbContrastRatio=${srgbContrastRatio.toString()};
const compositeSrgbOver=${compositeSrgbOver.toString()};
const resolveTextBackdrop=${resolveTextBackdrop.toString()};
const classifyUnreadableContrast=${classifyUnreadableContrast.toString()};
${mermaidHelperDecls}
const mermaidHelpers={ ${mermaidHelperKeys} };
(${createArtifactSdk.toString()})(deriveQueueKey, isNativeInteractiveControl, mermaidHelpers, artifactRevision, artifactLoadToken);
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
