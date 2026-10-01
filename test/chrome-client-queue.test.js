import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createChromeHtml } from "../src/server.js";

const sourceUrl = new URL("../src/chrome-client.js", import.meta.url);

// The ids the served chrome page actually declares. The client reaches for these by id, so a page
// that stopped declaring one would leave the corresponding feature silently dead behind an
// `if (element)` guard - a harness that invents an element for any id would never notice.
const servedChromeIds = new Set(
  [...createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }).matchAll(/\sid="([^"]+)"/g)].map(
    (match) => match[1],
  ),
);

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string, initialLayoutWarnings?: any[], chromeLoadToken?: string, initialArtifactRevision?: number, initialArtifactLoadToken?: string, initialArtifactLoadSequence?: number, initialEnded?: boolean, initialEndedBy?: string | null }} HarnessSessionData */
/** @type {HarnessSessionData} */
const defaultSessionData = { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i" };

async function createChromeHarness({
  fetchImpl = /** @type {(url?: any, init?: any) => Promise<any>} */ (
    async () => ({ ok: true, json: async () => ({}) })
  ),
  sessionData = defaultSessionData,
  artifactSrc = "",
  storage = new Map(),
  beginLoadResponses = [],
  handoffResponses = [],
  // Opt-in frozen clock. `reloadChromeAfterServerRestart` waits on wall-clock deadlines, so a
  // test that needs one to expire has to own `Date.now()` rather than sleep through it.
  fakeClock = false,
  // Opt-in phone-width viewport: installs a `window.matchMedia` whose single query answers the
  // chrome's sheet breakpoint, with `setMobile` flipping it the way a resize would. Left off, the
  // window has no matchMedia at all, which is the desktop the other tests run against.
  mobile = false,
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const postedToFrame = [];
  const eventSources = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  const beginRequests = [];
  const artifactBeginRequests = [];
  const focusLog = [];
  let activeElement = null;
  let nextTimerId = 1;
  let reloadCount = 0;
  let artifactRevision = 0;

  function fakeSetTimeout(fn, ms) {
    const timer = {
      id: nextTimerId++,
      ms,
      fn,
      unref() {},
    };
    timers.set(timer.id, timer);
    return timer;
  }

  function fakeClearTimeout(timer) {
    if (timer && typeof timer === "object") timers.delete(timer.id);
  }

  function runTimers(ms) {
    for (const timer of [...timers.values()]) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timers.delete(timer.id);
      timer.fn();
    }
  }

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: false,
      disabled: false,
      checked: false,
      indeterminate: false,
      type: "",
      className: "",
      value: "",
      innerHTML: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      scrolledIntoView: null,
      dataset: {},
      children: [],
      onclick: null,
      onchange: null,
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        contains(name) {
          return classes.has(name);
        },
        toString() {
          return [...classes].join(" ");
        },
      },
      style: {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      dispatch(type, event = {}) {
        const handler = listeners.get(type);
        if (handler) handler(event);
      },
      querySelectorAll(selector) {
        const matches = [];
        const walk = (node) => {
          for (const child of node.children || []) {
            if (typeof selector === "string" && selector.startsWith(".")) {
              if (
                String(child.className || "")
                  .split(/\s+/)
                  .includes(selector.slice(1))
              )
                matches.push(child);
            }
            walk(child);
          }
        };
        walk(this);
        return matches;
      },
      querySelector(selector) {
        if (selector !== "span") return this.querySelectorAll(selector)[0] || null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      contains(node) {
        let current = node;
        while (current) {
          if (current === this) return true;
          current = current.parentElement;
        }
        return false;
      },
      appendChild(child) {
        // Appending a node that is already in the tree moves it, as the real DOM does.
        const existing = child.parentElement;
        if (existing) existing.children = existing.children.filter((node) => node !== child);
        child.parentElement = this;
        this.children.push(child);
        this.lastAppendedChild = child;
        return child;
      },
      replaceChildren(...next) {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        for (const child of next) this.appendChild(child);
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      remove() {
        const parent = this.parentElement;
        if (!parent) return;
        parent.children = parent.children.filter((child) => child !== this);
        this.parentElement = null;
      },
      focus() {
        this.focused = true;
        activeElement = this;
        focusLog.push(this.id);
      },
      select() {},
      scrollIntoView(options) {
        this.scrolledIntoView = options;
      },
      listeners,
    };
    elements.set(id, el);
    return el;
  }

  element("lavish-session").textContent = JSON.stringify(sessionData);
  const frame = element("artifact");
  frame.dataset.artifactSrc = artifactSrc;
  Object.defineProperty(frame, "src", {
    get() {
      return this.currentSrc || "";
    },
    set(value) {
      this.currentSrc = String(value);
      srcLoads.push({ src: this.currentSrc, hadMessageListener: windowListeners.has("message") });
    },
  });
  frame.contentWindow = {
    postMessage(message) {
      postedToFrame.push(message);
    },
  };
  element("moreMenu").hidden = true;
  element("warningsDrawer").hidden = true;
  element("layoutGateBypass").hidden = true;
  element("chatInput").parentElement = element("chatComposer");
  element("chatComposer").parentElement = element("panel");
  element("panelScroll").parentElement = element("panel");

  const harnessFetch = async (url, init) => {
    if (String(url).includes("/chrome-loads/begin")) {
      beginRequests.push({ url, init });
      if (handoffResponses.length > 0) return handoffResponses.shift();
      return {
        ok: true,
        json: async () => ({ chrome_load_token: "harness-chrome-refresh", artifact_revision: artifactRevision }),
      };
    }
    if (String(url).includes("/artifact-loads/begin")) {
      artifactBeginRequests.push({ url, init });
      if (beginLoadResponses.length > 0) return beginLoadResponses.shift();
      artifactRevision += 1;
      return {
        ok: true,
        json: async () => ({
          artifact_revision: artifactRevision,
          artifact_load_token: `harness-load-${artifactRevision}`,
        }),
      };
    }
    return fetchImpl(url, init);
  };

  let clockNow = Date.now();
  const context = {
    AbortController,
    clearTimeout: fakeClearTimeout,
    console,
    ...(fakeClock ? { Date: { now: () => clockNow, parse: Date.parse } } : {}),
    fetch: harnessFetch,
    location: {
      reload() {
        reloadCount += 1;
      },
    },
    navigator: {},
    setTimeout: fakeSetTimeout,
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    EventSource: class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        eventSources.push(this);
      }

      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }
    },
    document: {
      body: element("body"),
      get activeElement() {
        return activeElement;
      },
      getElementById(id) {
        // Answer only for ids the served page declares, so an id the client and the page disagree
        // on fails here the way it would go dead in a browser.
        if (!servedChromeIds.has(id) && !elements.has(id)) return null;
        return element(id);
      },
      addEventListener(type, handler, capture) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push({ handler, capture: Boolean(capture) });
      },
      createElement(tag) {
        const el = element(`${tag}-${elements.size}`);
        el.tagName = tag.toUpperCase();
        return el;
      },
      execCommand() {
        return true;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    window: {
      clearTimeout: fakeClearTimeout,
      setTimeout: fakeSetTimeout,
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
    },
  };

  const mediaQueries = [];
  if (mobile) {
    context.window.matchMedia = (query) => {
      const list = {
        media: query,
        matches: true,
        changeHandlers: [],
        addEventListener(type, handler) {
          if (type === "change") this.changeHandlers.push(handler);
        },
      };
      mediaQueries.push(list);
      return list;
    };
  }

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });
  await flushPromises();
  if (artifactSrc) frame.dispatch("load");

  function frameLoadToken() {
    const match = String(frame.src).match(/[?&]artifact_load_token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  return {
    element,
    frame,
    postedToFrame,
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    sendFrameMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      const message =
        artifactSrc && !Object.hasOwn(data || {}, "artifact_load_token")
          ? { ...data, artifact_load_token: frameLoadToken() }
          : data;
      for (const handler of handlers) handler({ source: frame.contentWindow, data: message });
    },
    dispatchDocumentKeydown(eventProps) {
      const handlers = documentListeners.get("keydown") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document keydown handler");
      const event = {
        key: "",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of handlers) handler(event);
      return event;
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
    },
    reloadCount() {
      return reloadCount;
    },
    focusLog,
    storage,
    warningRows() {
      return element("warningsList").children.filter((child) => String(child.className).startsWith("warning-row"));
    },
    dispatchDocumentMousedown(target) {
      for (const { handler } of documentListeners.get("mousedown") || []) handler({ target });
    },
    runTimers,
    advanceClock(ms) {
      clockNow += ms;
    },
    srcLoads,
    beginRequests,
    artifactBeginRequests,
    artifactLoadToken: frameLoadToken,
    mediaQueries,
    setMobile(matches) {
      for (const list of mediaQueries) {
        list.matches = matches;
        for (const handler of list.changeHandlers) handler({ matches });
      }
    },
    // A pointer gesture on the conversation dock, as the browser would deliver it: one pointer
    // id from down to up, with the y travel the test names.
    dragDock(fromY, toY, { pointerId = 1 } = {}) {
      const head = element("panelHead");
      head.dispatch("pointerdown", { pointerId, clientY: fromY, button: 0 });
      head.dispatch("pointermove", { pointerId, clientY: fromY + (toY - fromY) / 2 });
      head.dispatch("pointermove", { pointerId, clientY: toY });
      head.dispatch("pointerup", { pointerId, clientY: toY });
      // A completed pointer sequence is followed by a click on the same target.
      head.dispatch("click", {});
    },
    cancelDock(fromY, moveY, cancelY, { pointerId = 1 } = {}) {
      const head = element("panelHead");
      head.dispatch("pointerdown", { pointerId, clientY: fromY, button: 0 });
      head.dispatch("pointermove", { pointerId, clientY: moveY });
      head.dispatch("pointercancel", { pointerId, clientY: cancelY });
    },
  };
}

// One whole begin-load attempt that fails: the request plus both in-call transport retries.
async function exhaustOneBeginLoadAttempt(chrome) {
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();
  chrome.runTimers(300);
  await flushPromises();
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("chrome client re-handshakes once after a missing reviewer handoff", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: {
      ...defaultSessionData,
      chromeLoadToken: "expired-handoff",
      initialArtifactRevision: 1,
      initialArtifactLoadToken: "old-load",
    },
    beginLoadResponses: [{ ok: false, status: 409, json: async () => ({ status: "no-handoff" }) }],
    handoffResponses: [
      {
        ok: true,
        json: async () => ({
          chrome_load_token: "fresh-handoff",
          artifact_revision: 1,
          artifact_load_token: "",
          artifact_load_sequence: 0,
        }),
      },
    ],
  });
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.beginRequests.length, 1);
  assert.equal(chrome.artifactBeginRequests.length, 2);
  assert.match(chrome.artifactBeginRequests[0].init.body, /expired-handoff/);
  assert.match(chrome.artifactBeginRequests[1].init.body, /fresh-handoff/);
  assert.equal(chrome.element("handoffBanner").hidden, true);
});

test("chrome client surfaces a superseded reviewer without re-handshaking", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: { ...defaultSessionData, chromeLoadToken: "old-handoff" },
    beginLoadResponses: [{ ok: false, status: 409, json: async () => ({ status: "superseded" }) }],
  });
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.beginRequests.length, 0);
  assert.equal(chrome.artifactBeginRequests.length, 1);
  assert.equal(chrome.element("handoffBanner").hidden, false);
  chrome.element("handoffTakeover").click();
  assert.equal(chrome.reloadCount(), 1);
});

test("stale re-handshake responses cannot overwrite a newer load", async () => {
  /** @type {((value: any) => void) | undefined} */
  let resolveOldHandoff;
  const oldHandoffJson = new Promise((resolve) => {
    resolveOldHandoff = resolve;
  });
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: {
      ...defaultSessionData,
      chromeLoadToken: "old-handoff",
      initialArtifactRevision: 1,
      initialArtifactLoadToken: "old-load",
    },
    beginLoadResponses: [
      { ok: false, status: 409, json: async () => ({ status: "no-handoff" }) },
      { ok: false, status: 409, json: async () => ({ status: "no-handoff" }) },
    ],
    handoffResponses: [
      { ok: true, json: async () => oldHandoffJson },
      {
        ok: true,
        json: async () => ({
          chrome_load_token: "new-handoff",
          artifact_revision: 1,
          artifact_load_token: "",
          artifact_load_sequence: 0,
        }),
      },
    ],
  });

  await flushPromises();
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  await flushPromises();

  assert.ok(resolveOldHandoff);
  resolveOldHandoff({
    chrome_load_token: "old-recovery",
    artifact_revision: 1,
    artifact_load_token: "",
    artifact_load_sequence: 0,
  });
  await flushPromises();
  await flushPromises();

  chrome.element("reloadArtifact").click();
  await flushPromises();
  await flushPromises();

  const lastRequest = chrome.artifactBeginRequests.at(-1);
  assert.match(lastRequest.init.body, /new-handoff/);
  assert.doesNotMatch(lastRequest.init.body, /old-recovery/);
  assert.equal(chrome.element("handoffBanner").hidden, true);
});

test("chrome client replaces queued prompts with the same internal key", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan A", selector: "input#plan-a", tag: "choice", text: "Plan A", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Apply dark mode", selector: "button#dark", tag: "choice", text: "Dark" },
  });

  assert.deepEqual(
    chrome.queued().map((prompt) => prompt.prompt),
    ["Use plan B", "Apply dark mode"],
  );
  assert.match(chrome.element("annotationPills").innerHTML, /Use plan B/);
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, /Use plan A/);
});

test("chrome client scrolls new chat bubbles into view above queued prompts", async () => {
  const chrome = await createChromeHarness();
  const panelScroll = chrome.element("panelScroll");
  panelScroll.scrollHeight = 1800;

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Review the title", selector: "h1", tag: "annotation", text: "Title" },
  });
  assert.equal(panelScroll.scrollTop, 1800);

  panelScroll.scrollTop = 640;
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ text: "I updated the title." }),
  });

  const bubble = chrome.element("chatLog").lastAppendedChild;
  assert.equal(bubble.scrolledIntoView.block, "nearest");
  assert.equal(bubble.scrolledIntoView.inline, "nearest");
  assert.equal(panelScroll.scrollTop, 640);
});

function warningPayload(overrides = {}) {
  return {
    id: "w1",
    fingerprint: "w1",
    rule: "page-horizontal-overflow",
    severity: "error",
    status: "open",
    status_label: "Open",
    title: "Page scrolls sideways",
    explanation: "The page is 18px wider than the 720px viewport, so content sits off-screen.",
    selector: "html",
    component: "html",
    axis: "horizontal",
    overflow_px: 18,
    viewport_class: "compact",
    viewport_label: "Tablet / compact",
    viewport_width: 720,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    last_seen_revision: 1,
    queued_at: "",
    queue_attempts: 0,
    active: true,
    selectable: true,
    outstanding: false,
    history: [],
    ...overrides,
  };
}

function diagnosticsHarness(warningsByCall) {
  const posts = [];
  let call = 0;
  return {
    posts,
    fetchImpl: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      posts.push({ url, body, method: init?.method || "GET" });
      const warnings = warningsByCall[Math.min(call, warningsByCall.length - 1)] || [];
      call += 1;
      return { ok: true, json: async () => ({ warnings, prompt: null }) };
    },
  };
}

test("chrome client posts a completed diagnostic pass and never queues feedback from it", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[warningPayload()]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    artifact_revision: 7,
    complete: true,
    target_presence_complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  const diagnostics = posts.filter((post) => post.url === "/api/abc/layout-diagnostics");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].body.artifact_revision, 7);
  assert.equal(diagnostics[0].body.complete, true);
  assert.equal(diagnostics[0].body.target_presence_complete, true);
  assert.equal(diagnostics[0].body.viewport_width, 720);
  assert.equal(diagnostics[0].body.findings.length, 1);
  // Detection must never touch the prompt queue.
  assert.equal(
    posts.some((post) => post.url === "/api/abc/prompts"),
    false,
  );
  assert.deepEqual(chrome.queued(), []);
});

test("a failed diagnostic pass reports its incompleteness rather than an empty result", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[warningPayload({ status: "unverified" })]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: false, viewport_width: 720, findings: [] });
  await flushPromises();

  assert.equal(posts[0].body.complete, false);
  assert.equal(chrome.element("warningsWrap").hidden, false);
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
});

test("warning-only observations are discarded before they reach the server", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[]]);
  await createChromeHarness({ fetchImpl });

  const chrome = await createChromeHarness({ fetchImpl });
  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [
      { selector: ".card", kind: "clipped-text", overflowPx: 2, severity: "warning" },
      { selector: ".unproven", kind: "clipped-text", overflowPx: 200 },
    ],
  });
  await flushPromises();

  assert.deepEqual(posts.at(-1).body.findings, []);
});

test("the warning button hides at zero and shows a deduplicated unresolved count", async () => {
  const chrome = await createChromeHarness();

  assert.equal(chrome.element("warningsWrap").hidden, true, "no button without unresolved work");

  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2", selector: "p" })] }),
  });

  assert.equal(chrome.element("warningsWrap").hidden, false);
  assert.equal(chrome.element("warningsCount").textContent, "2");
  assert.equal(chrome.element("warningsButton")["aria-label"], "2 unresolved layout issues");
  assert.equal(chrome.warningRows().length, 2);

  // The same warnings arriving again must not inflate anything.
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2", selector: "p" })] }),
  });
  assert.equal(chrome.element("warningsCount").textContent, "2");
  assert.equal(chrome.warningRows().length, 2);
});

test("resolved warnings drop out of the active count and hide the button", async () => {
  const chrome = await createChromeHarness();
  const source = chrome.eventSource().listeners.get("layout-warnings");

  source({ data: JSON.stringify({ warnings: [warningPayload()] }) });
  assert.equal(chrome.element("warningsWrap").hidden, false);

  source({
    data: JSON.stringify({ warnings: [warningPayload({ status: "resolved", active: false, selectable: false })] }),
  });
  assert.equal(chrome.element("warningsWrap").hidden, true);
  assert.equal(chrome.element("warningsCount").textContent, "0");
});

test("nothing is selected by default and Select all is an explicit action", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2" })] }),
  });

  assert.equal(chrome.element("warningsSelectAll").checked, false);
  assert.equal(chrome.element("warningsSelected").textContent, "None selected");
  assert.equal(chrome.element("warningsQueueButton").disabled, true);
  for (const row of chrome.warningRows()) {
    assert.equal(row.children[0].checked, false);
  }

  chrome.element("warningsSelectAll").checked = true;
  chrome.element("warningsSelectAll").onchange();
  assert.equal(chrome.element("warningsSelected").textContent, "2 selected");
  assert.equal(chrome.element("warningsQueueButton").disabled, false);
});

test("queueing a selected subset produces exactly one ordinary prompt with only those warnings", async () => {
  const posts = [];
  const queuedWarnings = [
    warningPayload({ status: "queued", status_label: "Queued for fix", selectable: false, outstanding: true }),
    warningPayload({ id: "w2", selector: "p" }),
  ];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        json: async () => ({
          status: "queued",
          queued_count: 1,
          warnings: queuedWarnings,
          prompt: {
            prompt: "Fix this layout issue the browser detected in this artifact:\n1. [w1] ...",
            text: "Layout issue: 1 selected",
            target: { type: "layout-warnings", warnings: [{ id: "w1", rule: "page-horizontal-overflow" }] },
          },
        }),
      };
    },
  });
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2", selector: "p" })] }),
  });

  const [first] = chrome.warningRows();
  first.children[0].checked = true;
  first.children[0].dispatch("change");
  assert.equal(chrome.element("warningsSelected").textContent, "1 selected");

  await chrome.element("warningsQueueButton").onclick();
  await flushPromises();

  const queueCall = posts.find((post) => post.url === "/api/abc/layout-warnings/queue");
  assert.deepEqual(queueCall.body, { ids: ["w1"] });

  const queued = chrome.queued();
  assert.equal(queued.length, 1, "one ordinary queued prompt");
  assert.equal(queued[0].tag, "layout-warnings");
  assert.equal(queued[0].target.warnings.length, 1);
  assert.equal(queued[0].target.warnings[0].id, "w1");

  // Queueing does not clear the warning; it stays counted and becomes unselectable.
  assert.equal(chrome.element("warningsCount").textContent, "2");
  assert.equal(chrome.warningRows()[0].children[0].disabled, true);
  assert.equal(chrome.warningRows()[0].children[1].children.at(-1).children.at(-1).disabled, true);
  assert.equal(chrome.warningRows()[0].children[1].children[2].children[1].textContent, "Queued for send");
  assert.equal(chrome.element("warningsSelected").textContent, "None selected");
});

test("a stale queued layout prompt remains available for user re-decision", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/layout-warnings/queue")) {
        return {
          ok: true,
          json: async () => ({
            queued_count: 1,
            warnings: [warningPayload()],
            prompt: {
              prompt: "Fix this layout issue",
              text: "Layout issue: 1 selected",
              target: { type: "layout-warnings", artifact_revision: 1, warnings: [{ id: "w1" }] },
            },
          }),
        };
      }
      if (url.endsWith("/prompts")) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ warnings: [warningPayload({ status: "recurring", status_label: "Still present" })] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });

  const [row] = chrome.warningRows();
  row.children[0].checked = true;
  row.children[0].dispatch("change");
  await chrome.element("warningsQueueButton").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "" });
  await flushPromises();

  assert.ok(posts.some((post) => post.url === "/api/abc/prompts"));
  assert.equal(chrome.queued().length, 1);
  assert.equal(chrome.warningRows()[0].children[1].children[2].children[1].textContent, "Queued for send");
});

test("dismissing a warning asks the server and never clears it locally on failure", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: false, json: async () => ({}) };
    },
  });
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });

  const [row] = chrome.warningRows();
  const dismiss = row.children[1].children.at(-1).children.at(-1);
  dismiss.dispatch("click");
  await flushPromises();

  assert.ok(posts.some((post) => post.url === "/api/abc/layout-warnings/dismiss" && post.body.id === "w1"));
  assert.equal(chrome.element("warningsCount").textContent, "1", "a failed dismissal must not look like a resolution");
});

test("Reveal asks the artifact iframe to highlight the affected element", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload({ selector: "p#copy" })] }),
  });

  const [row] = chrome.warningRows();
  const reveal = row.children[1].children.at(-1).children[0];
  reveal.dispatch("click");

  const revealMessage = chrome.postedToFrame.at(-1);
  assert.equal(revealMessage.type, "lavish:revealElement");
  assert.equal(revealMessage.selector, "p#copy");
});

test("the drawer manages focus and closes on Escape", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });

  assert.equal(chrome.element("warningsDrawer").hidden, true);
  chrome.element("warningsButton").click();
  assert.equal(chrome.element("warningsDrawer").hidden, false);
  assert.equal(chrome.element("warningsButton")["aria-expanded"], "true");
  assert.equal(chrome.focusLog.at(-1), "warningsSelectAll", "focus moves into the drawer");

  chrome.dispatchDocumentKeydown({ key: "Escape" });
  assert.equal(chrome.element("warningsDrawer").hidden, true);
  assert.equal(chrome.element("warningsButton")["aria-expanded"], "false");
  assert.equal(chrome.focusLog.at(-1), "warningsButton", "focus returns to the trigger");
});

test("a click outside the drawer closes it", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });
  chrome.element("warningsButton").click();
  assert.equal(chrome.element("warningsDrawer").hidden, false);

  chrome.dispatchDocumentMousedown(chrome.element("chatInput"));
  assert.equal(chrome.element("warningsDrawer").hidden, true);
});

test("warning state and selection survive a chrome reload of the same session", async () => {
  const first = await createChromeHarness();
  first.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload(), warningPayload({ id: "w2" })] }),
  });
  const [row] = first.warningRows();
  row.children[0].checked = true;
  row.children[0].dispatch("change");
  assert.equal(first.element("warningsSelected").textContent, "1 selected");

  // A browser refresh re-bootstraps from the server, and the chrome's own selection is restored
  // from per-session storage.
  const reloaded = await createChromeHarness({
    storage: first.storage,
    sessionData: {
      key: "abc",
      file: "/tmp/artifact.html",
      modeToggleHotkeyKey: "i",
      initialLayoutWarnings: [warningPayload(), warningPayload({ id: "w2" })],
    },
  });
  assert.equal(reloaded.element("warningsCount").textContent, "2");
  assert.equal(reloaded.element("warningsSelected").textContent, "1 selected");
});

test("warning state does not leak across review sessions", async () => {
  const first = await createChromeHarness();
  first.eventSource().listeners.get("layout-warnings")({
    data: JSON.stringify({ warnings: [warningPayload()] }),
  });
  const [row] = first.warningRows();
  row.children[0].checked = true;
  row.children[0].dispatch("change");

  const other = await createChromeHarness({
    storage: first.storage,
    sessionData: { key: "zzz", file: "/tmp/other.html", modeToggleHotkeyKey: "i" },
  });
  assert.equal(other.element("warningsWrap").hidden, true);
  assert.equal(other.element("warningsSelected").textContent, "None selected");
});

test("chrome client surfaces export warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 unresolved asset");
});

test("chrome client surfaces export notices from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "0";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 notice");
});

test("chrome client includes export notices alongside unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "2";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(
    chrome.element("exportArtifact").querySelector("span").textContent,
    "Exported with 2 unresolved assets and 1 notice",
  );
});

test("chrome client registers message listener before loading the artifact iframe", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  assert.equal(chrome.srcLoads.length, 1);
  assert.match(chrome.srcLoads[0].src, /^\/artifact\/abc\/index\.html\?artifact_revision=\d+&artifact_load_token=/);
  assert.equal(chrome.srcLoads[0].hadMessageListener, true);
});

test("the layout gate reveals after a completed pass with no findings", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[]]);
  const chrome = await createChromeHarness({ fetchImpl });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 720, findings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(posts[0].url, "/api/abc/layout-diagnostics");
  assert.deepEqual(posts[0].body.findings, []);
});

// The gate used to hold the artifact hostage until an agent repaired the finding. Triage is the
// user's now, so a completed pass always reveals and hands the result to the inbox.
test("the layout gate reveals on severe findings and points at the inbox instead of holding", async () => {
  const { fetchImpl } = diagnosticsHarness([[warningPayload()]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true, "the user sees the artifact");
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("warningsWrap").hidden, false);
});

test("layout gate timeout fails open when no result arrives", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
});

test("layout gate re-arms on reload and still reveals on the next completed pass", async () => {
  const { fetchImpl } = diagnosticsHarness([[], [warningPayload()]]);
  const chrome = await createChromeHarness({
    fetchImpl,
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);

  chrome.eventSource().listeners.get("reload")();
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
});

test("a stale prior-document diagnostic cannot reveal the new gate or clear its probe", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/abc/layout-diagnostics") {
        return { ok: true, json: async () => ({ status: "stale", warnings: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    },
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
    artifactSrc: "/artifact/abc/index.html",
  });

  const oldToken = chrome.artifactLoadToken();
  chrome.runTimers(25);
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:layoutDiagnostics",
    artifact_revision: 1,
    complete: true,
    viewport_width: 720,
    findings: [],
  });
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url === "/api/abc/layout-diagnostics"),
    false,
  );
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  chrome.frame.dispatch("load");
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:layoutDiagnostics",
    artifact_revision: 1,
    complete: true,
    viewport_width: 720,
    findings: [],
  });
  await flushPromises();
  chrome.runTimers(8000);
  await flushPromises();
  assert.ok(posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")));
});

test("a failed begin-load keeps the previous frame until a retry succeeds", async () => {
  const beginLoadResponses = [];
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  const previousSrc = chrome.frame.src;
  beginLoadResponses.push(
    { ok: false, status: 503 },
    { ok: true, json: async () => ({ artifact_revision: 2, artifact_load_token: "retry-load" }) },
  );
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  assert.equal(chrome.frame.src, previousSrc);

  chrome.runTimers(100);
  await flushPromises();
  assert.match(chrome.frame.src, /artifact_load_token=retry-load/);
  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

// A chrome whose FIRST begin-load fails has no previous frame to preserve: the iframe carries
// only `data-artifact-src` and is never navigated until a begin succeeds. Abandoning the load
// there leaves the layout gate spinning over an empty frame for good, which is what a session
// reopened across a server restart looked like.
test("a first begin-load that fails keeps retrying until the artifact loads", async () => {
  const beginLoadResponses = [
    { ok: false, status: 503 },
    { ok: false, status: 503 },
    { ok: false, status: 503 },
  ];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  await exhaustOneBeginLoadAttempt(chrome);
  assert.equal(chrome.artifactBeginRequests.length, 3);
  assert.equal(chrome.frame.src, "", "the artifact frame is never navigated while begin fails");

  // The backoff retry is a whole fresh attempt, and the harness answers it successfully.
  chrome.runTimers(1000);
  await flushPromises();
  assert.equal(chrome.artifactBeginRequests.length, 4);
  assert.match(chrome.frame.src, /^\/artifact\/abc\/index\.html\?artifact_revision=\d+&artifact_load_token=/);
  // Retries alone never raise the failure card: the gate is back on its ordinary checking copy.
  assert.match(String(chrome.element("layoutGateTitle").innerHTML), /Checking layout/);
});

test("a first begin-load that never recovers surfaces a reloadable failure instead of a blank frame", async () => {
  const beginLoadResponses = [];
  for (let i = 0; i < 40; i += 1) beginLoadResponses.push({ ok: false, status: 503 });
  let running = false;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async (url) => {
      if (String(url) === "/health" && !running) throw new Error("connection refused");
      return { ok: true, json: async () => ({}) };
    },
  });

  await exhaustOneBeginLoadAttempt(chrome);
  for (const delay of [1000, 3000, 8000, 20000]) {
    chrome.runTimers(delay);
    await exhaustOneBeginLoadAttempt(chrome);
  }

  assert.equal(chrome.frame.src, "");
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("layoutGateTitle").textContent, "Lavish could not load this artifact.");
  assert.equal(chrome.element("layoutGateAction").textContent, "Check and reload");
  assert.equal(chrome.element("layoutGateBypass").hidden, false, "Show anyway stays available on a failure card");

  // This card is raised in the state where the server may be gone, so it must not navigate into
  // a port nothing is listening on.
  await chrome.element("layoutGateAction").click();
  await flushPromises();
  assert.equal(chrome.reloadCount(), 0);
  assert.match(chrome.element("layoutGateCopy").textContent, /still not answering/);
  assert.equal(chrome.element("layoutGateAction").disabled, false);

  running = true;
  await chrome.element("layoutGateAction").click();
  await flushPromises();
  assert.equal(chrome.reloadCount(), 1);
});

// The backoff budget belongs to the attempt that started it, not to the page.
test("a load that asks for the artifact again gets the whole recovery backoff again", async () => {
  const beginLoadResponses = [];
  for (let i = 0; i < 18; i += 1) beginLoadResponses.push({ ok: false, status: 503 });
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  await exhaustOneBeginLoadAttempt(chrome);
  for (const delay of [1000, 3000, 8000, 20000]) {
    chrome.runTimers(delay);
    await exhaustOneBeginLoadAttempt(chrome);
  }
  assert.equal(chrome.artifactBeginRequests.length, 15);
  assert.equal(chrome.element("layoutGateTitle").textContent, "Lavish could not load this artifact.");

  chrome.element("reloadArtifact").click();
  await exhaustOneBeginLoadAttempt(chrome);
  assert.equal(chrome.artifactBeginRequests.length, 18);
  assert.equal(chrome.frame.src, "");

  chrome.runTimers(1000);
  await flushPromises();
  assert.equal(chrome.artifactBeginRequests.length, 19);
  assert.match(chrome.frame.src, /artifact_load_token=/);
  assert.match(String(chrome.element("layoutGateTitle").innerHTML), /Checking layout/);
});

test("a superseded reviewer is not retried in the background", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: { ...defaultSessionData, chromeLoadToken: "old-handoff" },
    beginLoadResponses: [{ ok: false, status: 409, json: async () => ({ status: "superseded" }) }],
  });
  await flushPromises();

  assert.equal(chrome.artifactBeginRequests.length, 1);
  assert.equal(chrome.element("handoffBanner").hidden, false);
  chrome.runTimers(1000);
  await flushPromises();
  assert.equal(chrome.artifactBeginRequests.length, 1);
});

test("a superseded first load names itself on the layout gate instead of holding the spinner", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    sessionData: { ...defaultSessionData, chromeLoadToken: "old-handoff", layoutGateEnabled: true },
    beginLoadResponses: [{ ok: false, status: 409, json: async () => ({ status: "superseded" }) }],
  });
  await flushPromises();
  await flushPromises();

  // Nothing ever reached the frame, and the takeover banner is covered by the gate overlay, so
  // the overlay itself has to carry the message and the control.
  assert.equal(chrome.element("artifact").src, "");
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.match(chrome.element("layoutGateTitle").textContent, /already open in another tab/);
  assert.equal(chrome.element("layoutGateAction").textContent, "Take over here");
  chrome.element("layoutGateAction").click();
  assert.equal(chrome.reloadCount(), 1);
  chrome.runTimers();
  await flushPromises();
  assert.equal(chrome.artifactBeginRequests.length, 1);
});

test("a chrome told to reload after a server restart waits for the replacement to answer", async () => {
  let healthy = false;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fakeClock: true,
    fetchImpl: async (url) => {
      if (String(url) === "/health" && !healthy) throw new Error("connection refused");
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.eventSource().listeners.get("chrome-reload")({ data: JSON.stringify({ reason: "upgrade" }) });
  for (let i = 0; i < 5; i += 1) {
    await flushPromises();
    chrome.runTimers(100);
  }
  await flushPromises();
  assert.equal(chrome.reloadCount(), 0, "never reload into a port nothing is listening on");

  healthy = true;
  for (let i = 0; i < 3; i += 1) {
    await flushPromises();
    chrome.runTimers(100);
  }
  await flushPromises();
  assert.equal(chrome.reloadCount(), 1);
});

async function createChromeWithDeadReplacement({ layoutGateEnabled = true } = {}) {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fakeClock: true,
    sessionData: { ...defaultSessionData, layoutGateEnabled },
    fetchImpl: async (url) => {
      if (String(url) === "/health") throw new Error("connection refused");
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.eventSource().listeners.get("chrome-reload")({ data: "{}" });
  await flushPromises();
  chrome.advanceClock(61000);
  for (let i = 0; i < 3; i += 1) {
    chrome.runTimers(100);
    await flushPromises();
  }
  return chrome;
}

test("a chrome whose replacement server never returns says so instead of reloading", async () => {
  const chrome = await createChromeWithDeadReplacement();

  assert.equal(chrome.reloadCount(), 0);
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("layoutGateTitle").textContent, "Lavish is not running.");
  assert.equal(chrome.element("layoutGateAction").textContent, "Check and reload");
});

// The sticky card's copy is the user's to retire, but it may never trap the viewer: a completed
// pass, Show anyway, or the gate timeout still reveals the artifact underneath.
test("the not-running card copy survives a later artifact load but never traps the viewer", async () => {
  const chrome = await createChromeWithDeadReplacement();
  assert.equal(chrome.element("layoutGateTitle").textContent, "Lavish is not running.");

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  await flushPromises();
  assert.match(chrome.frame.src, /artifact_load_token=/, "the artifact still reloads");
  assert.equal(chrome.element("layoutGateTitle").textContent, "Lavish is not running.");
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);

  chrome.sendFrameMessage({
    artifact_load_token: chrome.artifactLoadToken(),
    type: "lavish:layoutDiagnostics",
    complete: true,
    findings: [],
  });
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutGateTitle").textContent, "Lavish is not running.");

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  await flushPromises();
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("layoutGateBypass").hidden, false);
  chrome.element("layoutGateBypass").click();
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
});

test("a sticky failure cannot outlive the layout gate timeout", async () => {
  const chrome = await createChromeWithDeadReplacement();
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);

  chrome.runTimers(12000);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
});

test("a no-gate sticky failure reveals by pass, manual bypass, or timeout", async () => {
  const completed = await createChromeWithDeadReplacement({ layoutGateEnabled: false });
  assert.equal(completed.element("layoutGateOverlay").hidden, false);
  completed.sendFrameMessage({
    artifact_load_token: completed.artifactLoadToken(),
    type: "lavish:layoutDiagnostics",
    complete: true,
    findings: [],
  });
  assert.equal(completed.element("layoutGateOverlay").hidden, true);

  const bypassed = await createChromeWithDeadReplacement({ layoutGateEnabled: false });
  bypassed.element("layoutGateBypass").click();
  assert.equal(bypassed.element("layoutGateOverlay").hidden, true);

  const timedOut = await createChromeWithDeadReplacement({ layoutGateEnabled: false });
  timedOut.runTimers(12000);
  assert.equal(timedOut.element("layoutGateOverlay").hidden, true);
});

test("a diagnostics network failure does not hold the visual gate", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (String(url).includes("/layout-diagnostics")) throw new Error("server replaced");
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, findings: [] });
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
});

test("a layout pass lost to a token race requests a fresh pass", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  chrome.sendFrameMessage({
    artifact_load_token: "stale-load-token",
    type: "lavish:layoutDiagnostics",
    complete: true,
    findings: [],
  });
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestLayoutDiagnostics");
});

function sendChromeOutdated(chrome, reason) {
  chrome.eventSource().listeners.get("chrome-outdated")({
    data: JSON.stringify(reason === undefined ? {} : { reason }),
  });
}

test("an outdated chrome shows a dismissible banner and never reloads itself", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  assert.equal(chrome.element("outdatedBanner").hidden, true);
  const gateBefore = chrome.element("layoutGateOverlay").hidden;
  sendChromeOutdated(chrome, "upgrade");
  await flushPromises();

  assert.equal(chrome.element("outdatedBanner").hidden, false);
  assert.equal(chrome.element("layoutGateOverlay").hidden, gateBefore, "the banner never covers the artifact");
  assert.equal(chrome.element("chatInput").disabled, false, "an outdated page can still write feedback");
  chrome.runTimers();
  await flushPromises();
  assert.equal(chrome.reloadCount(), 0, "only the user may reload an outdated page");

  chrome.element("outdatedDismiss").click();
  assert.equal(chrome.element("outdatedBanner").hidden, true);

  sendChromeOutdated(chrome, "upgrade");
  await chrome.element("outdatedReload").click();
  await flushPromises();
  assert.equal(chrome.reloadCount(), 1);
});

test("the outdated banner says what actually happened to the server", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  sendChromeOutdated(chrome, "upgrade");
  assert.equal(
    chrome.element("outdatedText").textContent,
    "Lavish was updated. This page is running the previous version.",
  );

  sendChromeOutdated(chrome, "stop");
  assert.equal(chrome.element("outdatedText").textContent, "Lavish was stopped. Reload after you start it again.");

  sendChromeOutdated(chrome, "local-build");
  const localBuild = chrome.element("outdatedText").textContent;
  assert.match(localBuild, /local build/);
  assert.doesNotMatch(localBuild, /updated/);

  for (const unnamed of [undefined, "", "something-else"]) {
    sendChromeOutdated(chrome, unnamed);
    const copy = chrome.element("outdatedText").textContent;
    assert.match(copy, /no longer running/);
    assert.doesNotMatch(copy, /updated/);
    assert.doesNotMatch(copy, /stopped/);
  }
});

test("the outdated banner's reload asks the server before navigating", async () => {
  let running = false;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url) => {
      if (String(url) === "/health" && !running) throw new Error("connection refused");
      return { ok: true, json: async () => ({}) };
    },
  });

  sendChromeOutdated(chrome, "stop");
  await chrome.element("outdatedReload").click();
  await flushPromises();
  assert.equal(chrome.reloadCount(), 0);
  assert.match(chrome.element("outdatedText").textContent, /still not running/);
  assert.equal(chrome.element("outdatedReload").disabled, false);

  running = true;
  await chrome.element("outdatedReload").click();
  await flushPromises();
  assert.equal(chrome.reloadCount(), 1);
});

// Unsent annotation text is the user's writing. A restart-driven reload replays it, but the
// interruption is still theirs to choose, and the banner names the same cause the shutdown gave.
async function restartWithUnsentDraft(reason) {
  let healthy = false;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fakeClock: true,
    fetchImpl: async (url) => {
      if (String(url) === "/health" && !healthy) throw new Error("connection refused");
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.sendFrameMessage({
    artifact_load_token: chrome.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  await flushPromises();

  chrome.eventSource().listeners.get("chrome-reload")({
    data: JSON.stringify(reason === undefined ? {} : { reason }),
  });
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();
  healthy = true;
  for (let i = 0; i < 3; i += 1) {
    chrome.runTimers(100);
    await flushPromises();
  }
  return chrome;
}

test("a restart reload with an unsent draft offers the banner instead of reloading", async () => {
  const chrome = await restartWithUnsentDraft("upgrade");

  assert.equal(chrome.reloadCount(), 0);
  assert.equal(chrome.element("outdatedBanner").hidden, false);
  assert.equal(
    chrome.element("outdatedText").textContent,
    "Lavish was updated. This page is running the previous version.",
  );
});

test("the banner a held-back reload shows names the reason the shutdown gave", async () => {
  const localBuild = await restartWithUnsentDraft("local-build");
  assert.match(localBuild.element("outdatedText").textContent, /local build/);

  const unnamed = await restartWithUnsentDraft(undefined);
  const unnamedCopy = unnamed.element("outdatedText").textContent;
  assert.match(unnamedCopy, /no longer running/);
  assert.doesNotMatch(unnamedCopy, /updated/);
});

// A full page reload used to destroy an annotation draft: the chrome kept it in memory only,
// while queued prompts were already persisted per session.
test("an unsent annotation draft survives a full page reload", async () => {
  const storage = new Map();
  const first = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });

  first.sendFrameMessage({
    artifact_load_token: first.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  await flushPromises();

  const second = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });
  const restored = second.postedToFrame.filter((message) => message.type === "lavish:restoreReviewState");
  assert.equal(restored.length, 1, "the reloaded chrome replays the draft into the new document");
  assert.equal(restored[0].state.card.text, "needs a shorter headline");
  assert.equal(restored[0].state.card.selector, "#hero");
});

test("a queued or cancelled card leaves no draft behind for the next page load", async () => {
  const storage = new Map();
  const first = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });

  first.sendFrameMessage({
    artifact_load_token: first.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  await flushPromises();
  first.sendFrameMessage({
    artifact_load_token: first.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: null, fields: [] },
  });
  await flushPromises();

  const second = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });
  assert.deepEqual(
    second.postedToFrame.filter((message) => message.type === "lavish:restoreReviewState"),
    [],
  );
});

test("a draft never leaks from one artifact into another", async () => {
  const storage = new Map();
  const first = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });

  first.sendFrameMessage({
    artifact_load_token: first.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  await flushPromises();

  const other = await createChromeHarness({
    artifactSrc: "/artifact/def/index.html",
    sessionData: { ...defaultSessionData, key: "def" },
    storage,
  });
  assert.deepEqual(
    other.postedToFrame.filter((message) => message.type === "lavish:restoreReviewState"),
    [],
  );
});

// Drives one live-reload, which the harness answers with a fresh artifact revision and token.
async function reloadArtifactOnce(chrome) {
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  await flushPromises();
}

// A draft whose anchor the agent removed can never be replayed, so it must not be retried against
// every later load. Two artifact revisions have to agree that it is gone.
test("a draft the artifact can no longer anchor is retired after a second revision says so", async () => {
  const storage = new Map();
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });

  chrome.sendFrameMessage({
    artifact_load_token: chrome.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  await flushPromises();

  chrome.sendFrameMessage({ type: "lavish:reviewDraftUnrestorable", selector: "#hero" });
  assert.ok(storage.get("lavish-axi:review-state:abc"), "one miss only records the answer");
  // The same revision reporting again is the same answer twice, not two answers.
  chrome.sendFrameMessage({ type: "lavish:reviewDraftUnrestorable", selector: "#hero" });
  assert.ok(storage.get("lavish-axi:review-state:abc"));

  await reloadArtifactOnce(chrome);
  chrome.sendFrameMessage({ type: "lavish:reviewDraftUnrestorable", selector: "#hero" });

  assert.equal(storage.has("lavish-axi:review-state:abc"), false, "the retired draft is no longer stored");
  assert.deepEqual(JSON.parse(storage.get("lavish-axi:retired-drafts:abc")), ["needs a shorter headline"]);
  const notes = chrome.element("chatLog").children.filter((child) => child.className === "bubble note");
  assert.equal(notes.length, 1);
  assert.match(notes[0].innerHTML, /needs a shorter headline/);
  assert.equal(chrome.element("chatInput").value, "", "the handback never touches the composer");

  // The handback is the only copy left, so it survives a page reload too.
  const reloaded = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });
  const reloadedNotes = reloaded.element("chatLog").children.filter((child) => child.className === "bubble note");
  assert.equal(reloadedNotes.length, 1);
});

test("an anchor that comes back on a later revision keeps its draft", async () => {
  const storage = new Map();
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html", storage });

  chrome.sendFrameMessage({
    artifact_load_token: chrome.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  await flushPromises();
  chrome.sendFrameMessage({ type: "lavish:reviewDraftUnrestorable", selector: "#hero" });

  // The next load has the element again and the SDK reports the card as restored.
  await reloadArtifactOnce(chrome);
  chrome.sendFrameMessage({
    artifact_load_token: chrome.artifactLoadToken(),
    type: "lavish:reviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  await reloadArtifactOnce(chrome);
  chrome.sendFrameMessage({ type: "lavish:reviewDraftUnrestorable", selector: "#hero" });

  assert.equal(JSON.parse(storage.get("lavish-axi:review-state:abc")).card.text, "needs a shorter headline");
  assert.equal(storage.has("lavish-axi:retired-drafts:abc"), false);
});

test("a load that recovers after the failure card retires it even when the gate was bypassed", async () => {
  const beginLoadResponses = [];
  for (let i = 0; i < 15; i += 1) beginLoadResponses.push({ ok: false, status: 503 });
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  await exhaustOneBeginLoadAttempt(chrome);
  chrome.element("layoutGateAction").click();
  for (const delay of [1000, 3000, 8000, 20000]) {
    chrome.runTimers(delay);
    await exhaustOneBeginLoadAttempt(chrome);
  }
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("layoutGateTitle").textContent, "Lavish could not load this artifact.");

  chrome.element("reloadArtifact").click();
  await flushPromises();
  assert.match(chrome.frame.src, /artifact_load_token=/);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutGateAction").textContent, "Show anyway");
});

test("exhausted begin-load retries preserve the previous frame without waking the agent", async () => {
  const beginLoadResponses = [];
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    beginLoadResponses,
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  const previousSrc = chrome.frame.src;
  const previousToken = chrome.artifactLoadToken();
  beginLoadResponses.push({ ok: false, status: 503 }, { ok: false, status: 503 }, { ok: false, status: 503 });
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();
  chrome.runTimers(300);
  await flushPromises();

  assert.equal(chrome.frame.src, previousSrc);
  assert.equal(chrome.artifactLoadToken(), previousToken);
  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

test("a current load token accepts artifact messages before the frame load event", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  const currentToken = chrome.artifactLoadToken();
  chrome.sendFrameMessage({
    artifact_load_token: currentToken,
    type: "lavish:artifactAssetFailure",
    detail: "current asset before load",
  });
  await flushPromises();

  assert.equal(posts.filter((post) => post.url === "/api/abc/artifact-failures").length, 1);
  chrome.frame.dispatch("load");
});

test("a pre-load diagnostic silences the probe even while its response is delayed", async () => {
  const posts = [];
  /** @type {(() => void) | undefined} */
  let releaseDiagnostic;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/abc/layout-diagnostics") {
        return new Promise((resolve) => {
          releaseDiagnostic = () => resolve({ ok: true, json: async () => ({ warnings: [] }) });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, findings: [] });
  await flushPromises();
  chrome.frame.dispatch("load");
  chrome.runTimers(8000);

  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
  );
  assert.ok(releaseDiagnostic);
  releaseDiagnostic();
  await flushPromises();
});

test("stale artifact messages are ignored until the current frame load", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  const oldToken = chrome.artifactLoadToken();
  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:reviewState",
    state: { card: { selector: "h1", text: "stale" } },
  });
  chrome.sendFrameMessage({ artifact_load_token: oldToken, type: "lavish:scroll", x: 8, y: 44 });
  chrome.sendFrameMessage({
    artifact_load_token: oldToken,
    type: "lavish:artifactAssetFailure",
    detail: "stale asset",
  });
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
  chrome.frame.dispatch("load");
  assert.equal(
    chrome.postedToFrame.some((message) => message.type === "lavish:restoreReviewState"),
    false,
  );
  const restoredScroll = chrome.postedToFrame.filter((message) => message.type === "lavish:restoreScroll").at(-1);
  assert.equal(restoredScroll.x, 0);
  assert.equal(restoredScroll.y, 0);

  chrome.sendFrameMessage({ type: "lavish:artifactAssetFailure", detail: "current asset" });
  await flushPromises();
  assert.equal(posts.filter((post) => post.url === "/api/abc/artifact-failures").length, 1);
});

test("a delayed diagnostic response does not delay silencing the artifact probe", async () => {
  const posts = [];
  /** @type {(() => void) | undefined} */
  let releaseDiagnostic;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/abc/layout-diagnostics") {
        return new Promise((resolve) => {
          releaseDiagnostic = () => resolve({ ok: true, json: async () => ({ warnings: [] }) });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 1440, findings: [] });
  await flushPromises();
  chrome.runTimers(8000);
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
  );
  assert.ok(releaseDiagnostic);
  releaseDiagnostic();
  await flushPromises();
  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
  );
});

test("a stale artifact probe cannot report failure after a reload", async () => {
  const posts = [];
  /** @type {(() => void) | undefined} */
  let releaseProbe;
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("/artifact/abc/index.html?") && String(url).includes("probe=1")) {
        return new Promise((resolve) => {
          releaseProbe = () => resolve({ ok: false, status: 503 });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  chrome.runTimers(8000);
  await flushPromises();
  assert.equal(
    posts.filter((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")).length,
    1,
  );

  chrome.eventSource().listeners.get("reload")();
  await flushPromises();
  assert.ok(releaseProbe);
  releaseProbe();
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

test("a delayed older diagnostic response cannot repaint the inbox", async () => {
  const posts = [];
  const releases = [];
  const chrome = await createChromeHarness({
    fetchImpl: (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url !== "/api/abc/layout-diagnostics") return Promise.resolve({ ok: true, json: async () => ({}) });
      const requestIndex = releases.length;
      return new Promise((resolve) => {
        releases.push(() =>
          resolve({
            ok: true,
            json: async () => ({ warnings: [warningPayload({ id: requestIndex === 0 ? "old" : "new" })] }),
          }),
        );
      });
    },
  });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, findings: [] });
  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, findings: [] });
  releases[1]();
  await flushPromises();
  assert.deepEqual(
    chrome.warningRows().map((row) => row.dataset.warningId),
    ["new"],
  );

  releases[0]();
  await flushPromises();
  assert.deepEqual(
    chrome.warningRows().map((row) => row.dataset.warningId),
    ["new"],
  );
  assert.equal(posts.filter((post) => post.url === "/api/abc/layout-diagnostics").length, 2);
});

test("layout gate manual override reveals immediately", async () => {
  const chrome = await createChromeHarness();

  chrome.element("layoutGateAction").onclick();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
});

test("layout gate manual override stays bypassed on reload", async () => {
  const chrome = await createChromeHarness();

  chrome.element("layoutGateAction").onclick();
  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
});

test("layout gate stays skipped when the session disables it", async () => {
  const { fetchImpl } = diagnosticsHarness([[warningPayload()]]);
  const chrome = await createChromeHarness({
    fetchImpl,
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateEnabled: false },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutDiagnostics",
    complete: true,
    viewport_width: 720,
    findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 18, severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("warningsWrap").hidden, false, "the inbox still surfaces the finding");
});

test("a zero-warning review keeps the top bar unchanged", async () => {
  const { posts, fetchImpl } = diagnosticsHarness([[]]);
  const chrome = await createChromeHarness({ fetchImpl });

  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 1440, findings: [] });
  await flushPromises();

  assert.equal(chrome.element("warningsWrap").hidden, true);
  assert.equal(
    posts.some((post) => post.url === "/api/abc/prompts"),
    false,
  );
});

test("chrome client strips the internal queue key before posting prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.element("send").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/prompts");
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(chrome.queued().length, 0);
});

test("chrome client sends without a snapshot when the artifact frame never answers", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });
  chrome.element("sendHint").hidden = true;

  chrome.element("chatInput").value = "Looks good";
  chrome.element("send").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");
  await flushPromises();
  assert.equal(posts.length, 0);

  chrome.runTimers(5000);
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.domSnapshot, "");
  assert.equal(posts[0].body.prompts[0].prompt, "Looks good");
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("sendHint").hidden, false);
  assert.match(chrome.element("sendHint").textContent, /without a page snapshot/);

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);
});

test("a failed send keeps the prompts queued and shows an error in the composer", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });
  chrome.element("sendHint").hidden = true;

  chrome.element("chatInput").value = "Looks good";
  chrome.element("sendAndEnd").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(chrome.queued().length, 1);
  assert.equal(chrome.element("sendHint").hidden, false);
  assert.match(chrome.element("sendHint").textContent, /Could not send/);
  assert.equal(chrome.element("chatInput").disabled, false);
});

test("a 413 send retries once without the snapshot", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      if (posts.length === 1) return { ok: false, status: 413, json: async () => ({}) };
      return { ok: true };
    },
  });

  chrome.element("chatInput").value = "Looks good";
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "x".repeat(64) });
  await flushPromises();
  await flushPromises();

  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.domSnapshot, "x".repeat(64));
  assert.equal(posts[1].body.domSnapshot, "");
  assert.deepEqual(posts[1].body.prompts, posts[0].body.prompts);
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("sendHint").hidden, true);
});

test("chrome send and end carries the end intent with queued prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("sendAndEnd").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
    endSession: true,
  });
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("chrome send and end with an empty composer nudges instead of ending", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });
  chrome.element("sendHint").hidden = true;

  chrome.element("sendAndEnd").onclick();
  await flushPromises();

  assert.equal(posts.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
  assert.equal(chrome.element("sendHint").hidden, false);
  assert.equal(chrome.element("chatInput").focused, true);
  assert.equal(chrome.element("chatInput").disabled, false);
});

test("chrome send and end during an in-flight submit still ends after the submit drains the queue", async () => {
  const posts = [];
  let resolveFirstPost = () => {};
  const firstPost = new Promise((resolve) => {
    resolveFirstPost = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (posts.length === 1) await firstPost;
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  chrome.element("sendAndEnd").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  resolveFirstPost();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts", "/api/abc/end"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(posts[1].body, null);
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

// A tab left open across `lavish-axi end` (or the browser's own End in another tab) must go
// visibly read-only the moment the server tells it, instead of leaving Send enabled for feedback
// nobody will ever poll for.
test("chrome goes read-only when the server forwards an ended SSE event", async () => {
  const chrome = await createChromeHarness();

  assert.equal(chrome.element("chatInput").disabled, false);

  chrome.eventSource().listeners.get("ended")({ data: JSON.stringify({ ended_by: "agent" }) });

  assert.equal(chrome.element("chatInput").disabled, true);
  assert.equal(chrome.element("annotation").disabled, true);
  assert.equal(chrome.element("moreButton").disabled, true);
  assert.equal(chrome.element("send").disabled, true);
  assert.equal(chrome.element("sendAndEnd").disabled, true);
  assert.equal(chrome.element("endedOverlay").hidden, false);
});

// A page loaded (or reloaded) after the session already ended has no future `ended` SSE event to
// wait for - it must start read-only, not wait for a Send to be silently refused.
test("chrome boots read-only when the session already ended before this page load", async () => {
  const chrome = await createChromeHarness({
    sessionData: { ...defaultSessionData, initialEnded: true, initialEndedBy: "user" },
  });

  assert.equal(chrome.element("chatInput").disabled, true);
  assert.equal(chrome.element("annotation").disabled, true);
  assert.equal(chrome.element("moreButton").disabled, true);
  assert.equal(chrome.element("send").disabled, true);
  assert.equal(chrome.element("sendAndEnd").disabled, true);
  assert.equal(chrome.element("endedOverlay").hidden, false);
});

// A race between this tab's own in-flight Send and a session end elsewhere must not leave the
// queue looking sent when the server actually refused it.
test("a queued Send refused because the session already ended marks the chrome read-only", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ status: "ended", error: "session already ended", ended_by: "agent" }),
    }),
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Too late", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.element("chatInput").disabled, true);
  assert.equal(chrome.element("endedOverlay").hidden, false);
  // The rejected batch is not silently lost - it stays queued rather than looking delivered.
  assert.equal(chrome.queued().length, 1);
});

test("Cmd/Ctrl+I toggles annotation mode from the chrome document, regardless of focus", async () => {
  const chrome = await createChromeHarness();

  const metaEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(metaEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);

  const ctrlEvent = chrome.dispatchDocumentKeydown({ key: "I", ctrlKey: true });
  assert.equal(ctrlEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("plain 'i' and other modifier combos do not toggle annotation mode", async () => {
  const chrome = await createChromeHarness();
  const framePostCount = () => chrome.postedToFrame.length;
  const before = framePostCount();

  const bareEvent = chrome.dispatchDocumentKeydown({ key: "i" });
  assert.equal(bareEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const shiftEvent = chrome.dispatchDocumentKeydown({ key: "i", shiftKey: true });
  assert.equal(shiftEvent.defaultPrevented, false);

  const ctrlShiftEvent = chrome.dispatchDocumentKeydown({ key: "i", ctrlKey: true, shiftKey: true });
  assert.equal(ctrlShiftEvent.defaultPrevented, false);

  const metaAltEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true, altKey: true });
  assert.equal(metaAltEvent.defaultPrevented, false);

  const otherKeyEvent = chrome.dispatchDocumentKeydown({ key: "s", metaKey: true });
  assert.equal(otherKeyEvent.defaultPrevented, false);

  assert.equal(framePostCount(), before);
});

test("chrome client reads the mode toggle hotkey from the session bootstrap", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "k" },
  });

  const oldHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(oldHotkeyEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const bootstrapHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "K", metaKey: true });
  assert.equal(bootstrapHotkeyEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

test("chrome client toggles annotation mode when the artifact SDK requests it via postMessage", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("chrome client ignores annotation mode toggles after the session ends", async () => {
  const chrome = await createChromeHarness();

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");

  chrome.sendFrameMessage({ type: "lavish:endSession" });
  await flushPromises();
  const afterEndPostCount = chrome.postedToFrame.length;

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.length, afterEndPostCount);
});

test("a silent artifact is probed for a fatal failure, and a talking one is not", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("/artifact/abc/index.html?") && String(url).includes("probe=1"))
        return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.element("artifact").dispatch("load");
  chrome.runTimers(8000);
  await flushPromises();
  await flushPromises();

  const failure = posts.find((post) => post.url === "/api/abc/artifact-failures");
  assert.equal(failure.body.failures[0].kind, "artifact-unavailable");
  assert.match(failure.body.failures[0].detail, /HTTP 404/);
});

test("an artifact that reports diagnostics is never probed as unavailable", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({ warnings: [] }) };
    },
  });

  chrome.element("artifact").dispatch("load");
  chrome.sendFrameMessage({ type: "lavish:layoutDiagnostics", complete: true, viewport_width: 1440, findings: [] });
  await flushPromises();
  chrome.runTimers(8000);
  await flushPromises();

  assert.equal(
    posts.some((post) => post.url.includes("/artifact/abc/index.html?") && post.url.includes("probe=1")),
    false,
    "a healthy artifact costs exactly one document request",
  );
  assert.equal(
    posts.some((post) => post.url === "/api/abc/artifact-failures"),
    false,
  );
});

test("a local asset failure inside the artifact is reported as a fatal artifact failure", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:artifactAssetFailure",
    detail: "<img> could not load /artifact/abc/logo.png",
  });
  await flushPromises();

  const failure = posts.find((post) => post.url === "/api/abc/artifact-failures");
  assert.equal(failure.body.failures[0].kind, "artifact-asset-unavailable");
  assert.match(failure.body.failures[0].detail, /logo\.png/);
});

// ---- Phone-width conversation sheet ----

function sheetState(chrome) {
  const toggle = chrome.element("panelToggle");
  return {
    open: chrome.element("body").classList.contains("sheet-open"),
    scrollInert: Boolean(chrome.element("panelScroll").inert),
    composerInert: Boolean(chrome.element("chatComposer").inert),
    expanded: toggle["aria-expanded"],
    label: toggle["aria-label"],
    summary: chrome.element("panelSummary").textContent,
    summaryClass: String(chrome.element("panelSummary").classList),
    stored: chrome.storage.get("lavish-axi:sheet-open:abc") || null,
  };
}

test("desktop chrome never turns the conversation panel into a sheet", async () => {
  const chrome = await createChromeHarness();

  assert.deepEqual(chrome.mediaQueries, []);
  const before = sheetState(chrome);
  assert.equal(before.open, false);
  assert.equal(before.scrollInert, false);
  assert.equal(before.composerInert, false);

  // The heading is plain text on desktop: clicking it must not start hiding the panel.
  chrome.element("panelHead").dispatch("click", {});
  const after = sheetState(chrome);
  assert.equal(after.open, false);
  assert.equal(after.scrollInert, false);
  assert.equal(after.stored, null);
});

test("phone chrome boots with the conversation docked and raises it on tap", async () => {
  const chrome = await createChromeHarness({ mobile: true });

  assert.equal(chrome.mediaQueries.length, 1);
  assert.match(chrome.mediaQueries[0].media, /max-width/);
  const docked = sheetState(chrome);
  assert.equal(docked.open, false);
  // The hidden part of the sheet must be unreachable: a focus landing in the off-screen
  // composer would scroll the page into a state the layout cannot recover from.
  assert.equal(docked.scrollInert, true);
  assert.equal(docked.composerInert, true);
  assert.equal(docked.expanded, "false");
  assert.equal(docked.label, "Show conversation");

  chrome.element("panelHead").dispatch("click", {});
  const raised = sheetState(chrome);
  assert.equal(raised.open, true);
  assert.equal(raised.scrollInert, false);
  assert.equal(raised.composerInert, false);
  assert.equal(raised.expanded, "true");
  assert.equal(raised.label, "Hide conversation");
  assert.equal(raised.stored, "1");

  // The scrim behind the sheet is a tap-to-dismiss surface.
  chrome.element("panelScrim").dispatch("click", {});
  assert.equal(sheetState(chrome).open, false);
  assert.equal(sheetState(chrome).stored, null);

  // Escape also lowers it, after the menus and drawers that sit above it have had their turn.
  chrome.element("panelHead").dispatch("click", {});
  assert.equal(sheetState(chrome).open, true);
  chrome.dispatchDocumentKeydown({ key: "Escape" });
  assert.equal(sheetState(chrome).open, false);
});

test("phone chrome restores an open sheet across a chrome reload", async () => {
  const storage = new Map([["lavish-axi:sheet-open:abc", "1"]]);
  const chrome = await createChromeHarness({ mobile: true, storage });

  const state = sheetState(chrome);
  assert.equal(state.open, true);
  assert.equal(state.scrollInert, false);
  assert.equal(state.expanded, "true");
});

test("the dock summarizes what the user should know while the sheet is down", async () => {
  const chrome = await createChromeHarness({
    mobile: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  assert.equal(sheetState(chrome).summary, "Agent not listening");

  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "listening" }) });
  assert.equal(sheetState(chrome).summary, "Agent listening");

  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "working" }) });
  assert.equal(sheetState(chrome).summary, "Agent is working…");

  // A reply that lands behind the artifact is previewed on the dock until the sheet comes up.
  chrome.eventSource().listeners.get("agent-reply")({ data: JSON.stringify({ text: "Renamed the payment step." }) });
  let state = sheetState(chrome);
  assert.equal(state.summary, "Renamed the payment step.");
  assert.match(state.summaryClass, /is-unread/);

  // Work the user queued from the artifact outranks the unread preview: it is the thing they
  // still have to send.
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Call this Payment method", selector: "h2", tag: "element", text: "Payment" },
  });
  state = sheetState(chrome);
  assert.equal(state.summary, "1 queued");
  assert.match(state.summaryClass, /is-accent/);
  assert.doesNotMatch(state.summaryClass, /is-unread/);
  assert.match(String(chrome.element("panelHead").classList), /is-fresh/);

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Drop the map preview", selector: "p", tag: "element", text: "Autofill" },
  });
  assert.equal(sheetState(chrome).summary, "2 queued");

  // Raising the sheet shows the reply itself, so the preview is no longer owed; once the queue
  // is sent the dock is back to reporting the agent.
  chrome.element("panelHead").dispatch("click", {});
  chrome.element("send").click();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();
  assert.equal(chrome.queued().length, 0);
  assert.equal(sheetState(chrome).summary, "Agent is working…");
  assert.doesNotMatch(sheetState(chrome).summaryClass, /is-unread/);

  // A reply that arrives while the sheet is up was seen, so lowering it previews nothing.
  chrome.eventSource().listeners.get("agent-reply")({ data: JSON.stringify({ text: "Done." }) });
  chrome.element("panelHead").dispatch("click", {});
  assert.equal(sheetState(chrome).summary, "Agent is working…");
});

test("the dock reports an ended session and keeps the panel inert", async () => {
  const chrome = await createChromeHarness({
    mobile: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  chrome.element("panelHead").dispatch("click", {});
  chrome.element("chatInput").value = "Ship it";
  chrome.element("sendAndEnd").click();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();
  assert.equal(chrome.element("sendAndEnd").disabled, true, "the session ended");
  assert.equal(sheetState(chrome).summary, "Session ended");
  assert.equal(sheetState(chrome).scrollInert, true);
  assert.equal(sheetState(chrome).composerInert, true);

  chrome.setMobile(false);
  assert.equal(sheetState(chrome).scrollInert, true, "an ended panel never becomes interactive on desktop");
});

test("a swipe on the dock raises and lowers the sheet, and a tap after a swipe is not a second toggle", async () => {
  const chrome = await createChromeHarness({ mobile: true });

  // Upward travel past the threshold raises it; the click that ends the gesture is swallowed.
  chrome.dragDock(800, 700);
  assert.equal(sheetState(chrome).open, true);

  // A nudge short of the threshold is not a decision either way.
  chrome.dragDock(100, 130, { pointerId: 2 });
  assert.equal(sheetState(chrome).open, true);

  chrome.dragDock(100, 220, { pointerId: 3 });
  assert.equal(sheetState(chrome).open, false);

  // A pure tap (no travel) still toggles.
  chrome.dragDock(300, 300, { pointerId: 4 });
  assert.equal(sheetState(chrome).open, true);

  // Nothing the gesture set on the panel survives its end.
  const panel = chrome.element("panel");
  assert.equal(panel.style.transform, "");
  assert.equal(panel.classList.contains("is-dragging"), false);
});

test("a cancelled dock swipe leaves the sheet unchanged and the next tap active", async () => {
  const chrome = await createChromeHarness({ mobile: true });
  const panel = chrome.element("panel");

  chrome.cancelDock(800, 790, 0);

  assert.equal(sheetState(chrome).open, false);
  assert.equal(panel.style.transform, "");
  assert.equal(panel.classList.contains("is-dragging"), false);

  chrome.element("panelHead").dispatch("click", {});
  assert.equal(sheetState(chrome).open, true);
});

test("crossing the breakpoint in either direction leaves no sheet state behind", async () => {
  const chrome = await createChromeHarness({ mobile: true });
  chrome.element("panelHead").dispatch("click", {});
  assert.equal(sheetState(chrome).open, true);
  assert.equal(chrome.storage.get("lavish-axi:sheet-open:abc"), "1");

  // Widening to desktop: the panel is a plain side panel again, never inert, never "open".
  chrome.setMobile(false);
  let state = sheetState(chrome);
  assert.equal(state.open, false);
  assert.equal(state.scrollInert, false);
  assert.equal(state.composerInert, false);
  assert.equal(chrome.storage.has("lavish-axi:sheet-open:abc"), false);

  // Narrowing back docks it again and moves focus out of the content becoming inert.
  chrome.element("chatInput").focus();
  chrome.setMobile(true);
  state = sheetState(chrome);
  assert.equal(state.open, false);
  assert.equal(state.scrollInert, true);
  assert.equal(chrome.focusLog.at(-1), "panelToggle");
  assert.equal(chrome.storage.has("lavish-axi:sheet-open:abc"), false);
});
