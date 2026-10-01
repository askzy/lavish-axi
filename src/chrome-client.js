/* global EventSource, document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "lavish-axi:queued:" + key;
// Review-chrome state that must survive a browser refresh. Keyed per session so one review's
// triage can never leak into another artifact's.
const warningSelectionStorageKey = "lavish-axi:warning-selection:" + key;
// Unsent annotation-card text lives only in the sandboxed iframe, so a full page reload would
// destroy it unless the chrome persists what the SDK reports. Keyed per session like the queue,
// so a draft can never reappear over a different artifact.
const reviewStateStorageKey = "lavish-axi:review-state:" + key;
// Drafts Lavish could not replay. The text outlives the draft that carried it, so the user can
// still read and copy it after the anchor it was written against is gone for good.
const retiredDraftStorageKey = "lavish-axi:retired-drafts:" + key;
/** @type {any[]} */
const retiredDraftNodes = [];
const internalQueueKeyField = "_lavishQueueKey";
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const MODE_TOGGLE_HOTKEY_KEY = String(sessionData.modeToggleHotkeyKey || "").toLowerCase();

function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const panelScroll = /** @type {HTMLDivElement} */ (document.getElementById("panelScroll"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const chatComposer = /** @type {HTMLDivElement} */ (document.getElementById("chatComposer"));
const panel = /** @type {HTMLElement} */ (document.getElementById("panel"));
const panelHead = /** @type {HTMLDivElement} */ (document.getElementById("panelHead"));
const panelSummary = /** @type {HTMLSpanElement} */ (document.getElementById("panelSummary"));
const panelToggle = /** @type {HTMLButtonElement} */ (document.getElementById("panelToggle"));
const panelScrim = /** @type {HTMLDivElement} */ (document.getElementById("panelScrim"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const moreWrap = /** @type {HTMLDivElement} */ (document.getElementById("moreWrap"));
const moreButton = /** @type {HTMLButtonElement} */ (document.getElementById("moreButton"));
const moreMenu = /** @type {HTMLDivElement} */ (document.getElementById("moreMenu"));
const reloadArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("reloadArtifact"));
const copySnapshotButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySnapshot"));
const exportArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("exportArtifact"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const copyHint = /** @type {HTMLSpanElement} */ (document.getElementById("copyHint"));
const copyHintText = /** @type {HTMLSpanElement} */ (document.getElementById("copyHintText"));
const presenceBanner = /** @type {HTMLDivElement} */ (document.getElementById("presenceBanner"));
const handoffBanner = /** @type {HTMLDivElement} */ (document.getElementById("handoffBanner"));
const handoffTakeoverButton = /** @type {HTMLButtonElement} */ (document.getElementById("handoffTakeover"));
const outdatedBanner = /** @type {HTMLDivElement} */ (document.getElementById("outdatedBanner"));
const outdatedText = /** @type {HTMLSpanElement} */ (document.getElementById("outdatedText"));
const outdatedReloadButton = /** @type {HTMLButtonElement} */ (document.getElementById("outdatedReload"));
const outdatedDismissButton = /** @type {HTMLButtonElement} */ (document.getElementById("outdatedDismiss"));
const endedOverlay = /** @type {HTMLDivElement} */ (document.getElementById("endedOverlay"));
const layoutGateOverlay = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateOverlay"));
const layoutGateTitle = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateTitle"));
const layoutGateCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("layoutGateCopy"));
const layoutGateAction = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateAction"));
const layoutGateBypass = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateBypass"));
// Installed by the inline boot failsafe before this script ran; it owns the gate's bounded
// escape so the escape works even when this script or the server does not.
const layoutGateEscape = /** @type {any} */ (window).__lavishLayoutGateEscape;
const warningsWrap = /** @type {HTMLDivElement} */ (document.getElementById("warningsWrap"));
const warningsButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsButton"));
const warningsCount = /** @type {HTMLSpanElement} */ (document.getElementById("warningsCount"));
const warningsDrawer = /** @type {HTMLDivElement} */ (document.getElementById("warningsDrawer"));
const warningsSummary = /** @type {HTMLParagraphElement} */ (document.getElementById("warningsSummary"));
const warningsSelectAll = /** @type {HTMLInputElement} */ (document.getElementById("warningsSelectAll"));
const warningsSelected = /** @type {HTMLSpanElement} */ (document.getElementById("warningsSelected"));
const warningsList = /** @type {HTMLDivElement} */ (document.getElementById("warningsList"));
const warningsQueueButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsQueueButton"));
const sendHint = /** @type {HTMLDivElement} */ (document.getElementById("sendHint"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
let annotation = true;
let ended = false;
let agentPresence = "waiting";
let pendingSnapshot = "";
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
let chromeOutdatedReason = "";
let chromeOutdatedGeneration = 0;
let outdatedReloadInFlight = false;
/** @type {{ selector: string, revision: number } | null} */
let unrestorableDraftMiss = null;
let retiredDrafts = loadRetiredDrafts();
let layoutGateVisible = false;
let layoutGateManuallyBypassed = !layoutGateEnabled;
let layoutGateFailureActive = false;
// A failure only the user can retire. The artifact-load card clears itself once a load succeeds;
// the server-replacement card must not, because the page is still running the pre-upgrade client
// against the replacement server and nothing else would tell the user that. Stickiness governs
// the card's copy, never the visual reveal.
let layoutGateFailureSticky = false;
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
// The warning inbox is server-owned review state. The chrome renders it and posts triage
// actions; it never decides on its own that a warning went away.
let layoutWarnings = Array.isArray(sessionData.initialLayoutWarnings) ? sessionData.initialLayoutWarnings : [];
const selectedWarningIds = new Set(loadJsonState(warningSelectionStorageKey, []));
let warningsDrawerOpen = false;
// The snapshot is context; the reviewer's words are the payload. If the artifact frame stops
// answering, send the words without a snapshot instead of waiting forever.
const SNAPSHOT_REQUEST_TIMEOUT_MS = 5000;
const SEND_EMPTY_COPY = "Write a message or annotate an element first.";
const SNAPSHOT_SKIPPED_COPY = "Sent without a page snapshot because the artifact did not answer in time.";
const SEND_FAILED_COPY = "Could not send. Your feedback is still queued in this tab. Click Send to Agent to retry.";
const snapshotRequests = [];
let endAfterSubmit = false;
let workingBubble = null;
let submitQueuedPromise = null;
let submitQueuedAgain = false;
let lastScroll = { x: 0, y: 0 };
// In-iframe review context (an open annotation card's unsent text, Lavish-owned question
// answers). The sandbox means the chrome cannot read it back after a reload, so the SDK reports
// it as it changes and the chrome replays it once the new document is up. It is persisted per
// session so a full page reload replays it too.
let lastReviewState = loadJsonState(reviewStateStorageKey, null);
if (lastReviewState && typeof lastReviewState !== "object") lastReviewState = null;
const ARTIFACT_SILENCE_PROBE_MS = 8000;
const ARTIFACT_LOAD_BEGIN_RETRY_DELAYS_MS = [100, 300];
// Backoff for retrying a whole begin-load attempt after its in-call retries ran out. The
// in-call retries span 400ms, which only covers a slow response - not the multi-second window
// where the server is being replaced. Without these the chrome abandons the artifact for good:
// the frame is never navigated, `artifact_revision` never advances, and the page sits on the
// layout gate and then on an empty frame with nothing to click.
const ARTIFACT_LOAD_RECOVERY_DELAYS_MS = [1000, 3000, 8000, 20000];
// How long a chrome told to reload after a server restart keeps probing /health before giving
// up, and how long it waits for an outage to appear at all before treating a healthy answer as
// "the server never went away".
const CHROME_RESTART_SETTLE_MS = 5000;
const CHROME_RESTART_WAIT_MS = 60000;
// Probe fast while the replacement is expected to bind, then back off.
const CHROME_RESTART_PROBE_MS = 100;
const CHROME_RESTART_SLOW_PROBE_MS = 500;
// A probe must always settle, so the control that is waiting on it always comes back.
const HEALTH_PROBE_TIMEOUT_MS = 4000;
const HEALTH_NO_ANSWER_TITLE = "Lavish did not answer.";
const HEALTH_NO_ANSWER_COPY =
  "Lavish did not answer the check, so this page cannot tell whether it is running. Try again in a moment.";
let chromeRestartReloadPromise = null;
let artifactLoadToken = "";
let artifactLoadRevision = Number(sessionData.initialArtifactRevision) || 0;
let artifactLoadRequestSequence = Number(sessionData.initialArtifactLoadSequence) || 0;
let chromeLoadToken = String(sessionData.chromeLoadToken || "");
artifactLoadToken = String(sessionData.initialArtifactLoadToken || "");
let artifactSpokeToken = "";
let artifactMessageSequence = 0;
let layoutDiagnosticSequence = 0;
let artifactLoadRecoveryAttempt = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactLoadRecoveryTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactSilenceTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;

function artifactFrameSrcForLoad(load) {
  const separator = artifactSrc.includes("?") ? "&" : "?";
  return (
    artifactSrc +
    separator +
    "artifact_revision=" +
    encodeURIComponent(load.revision) +
    "&artifact_load_token=" +
    encodeURIComponent(load.token)
  );
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

function loadJsonState(storageKey, fallback) {
  try {
    const raw = sessionStorage.getItem(storageKey);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJsonState(storageKey, value) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    // The in-memory state still works if browser storage is unavailable.
    return false;
  }
}

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter((prompt) => prompt && typeof prompt === "object") : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

function promptTargetLabel(prompt) {
  if (prompt?.target?.type === "table-cell") {
    const semantic = [prompt.target.rowLabel, prompt.target.columnLabel].filter(Boolean).join(" → ");
    if (semantic) return semantic;
  }
  return String(prompt?.selector || "");
}

function render() {
  annotationPills.innerHTML = queued
    .map((prompt, index) => {
      const targetLabel = promptTargetLabel(prompt);
      const showLocator = targetLabel && prompt.selector && targetLabel !== prompt.selector;
      return (
        '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
        index +
        '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="pill-tooltip">' +
        (targetLabel
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(targetLabel) +
            "</div>"
          : "") +
        (showLocator
          ? '<div class="tooltip-label">Locator</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>"
      );
    })
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  updateSendState();
  scrollPanelToBottom();
  renderSheetSummary();
}

function updateSendState() {
  sendButton.disabled = ended || agentPresence === "working";
  sendAndEndButton.disabled = sendButton.disabled;
  if (warningsQueueButton) updateWarningSelectionState();
}

function showSendHint(copy = SEND_EMPTY_COPY) {
  sendHint.textContent = copy;
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
  }, 2600);
  chatInput.focus();
}

function showSendError(copy) {
  clearTimeout(sendHintTimer);
  sendHint.textContent = copy;
  sendHint.hidden = false;
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
}

function setMenuOpen(button, menu, open) {
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(moreButton, moreMenu, false);
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  setMenuOpen(button, menu, open);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea-based fallback below.
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
  return true;
}

function addChat(role, text, shouldScroll = true) {
  if (!text) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";
  chatLog.appendChild(el);
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  let lastChatBubble = null;
  for (const item of chat) lastChatBubble = addChat(item.role, item.text, false) || lastChatBubble;
  if (workingBubble) chatLog.appendChild(workingBubble);
  // Handed-back drafts were written at the end of the conversation, and a rebuild re-appends the
  // whole transcript - so without this they end up above it, where the scroll below would leave
  // them off-screen. They are the one thing here the user cannot recover anywhere else.
  for (const note of retiredDraftNodes) chatLog.appendChild(note);
  const anchor = retiredDraftNodes[retiredDraftNodes.length - 1] || workingBubble || lastChatBubble;
  if (anchor) scrollElementIntoView(anchor);
}

function setAgentPresence(state) {
  agentPresence = state === "listening" || state === "working" ? state : "waiting";
  updateSendState();
  renderSheetSummary();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";

  if (agentPresence !== "working") {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }

  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = '<span class="spinner"></span><span>Working...</span>';
    chatLog.appendChild(workingBubble);
  }
  scrollElementIntoView(workingBubble);
}

function setHandoffSuperseded(visible) {
  if (handoffBanner) handoffBanner.hidden = ended || !visible;
}

// The server this page was connected to went away. What is true beyond that depends on why, so
// the shutdown names its reason and each one gets its own line - a page told "Lavish was updated"
// after a deliberate stop is being told something false. An unnamed reason claims neither.
function shutdownEventReason(event) {
  try {
    return String(JSON.parse(event?.data || "{}").reason || "");
  } catch {
    return "";
  }
}

function chromeOutdatedCopy(reason) {
  if (reason === "upgrade") return "Lavish was updated. This page is running the previous version.";
  if (reason === "local-build") {
    return "Lavish was restarted to pick up a local build. This page is running the copy the previous server sent.";
  }
  if (reason === "stop") return "Lavish was stopped. Reload after you start it again.";
  return "The Lavish server this page was connected to is no longer running. Reloading will work once it is running again.";
}

// Say so where the user can dismiss it, and never reload on their behalf - a forced reload
// interrupts whatever they were reading or writing.
function setChromeOutdated(visible, reason = chromeOutdatedReason) {
  chromeOutdatedReason = String(reason || "");
  chromeOutdatedGeneration += 1;
  if (outdatedText) outdatedText.textContent = chromeOutdatedCopy(chromeOutdatedReason);
  outdatedReloadInFlight = false;
  if (outdatedReloadButton) outdatedReloadButton.disabled = false;
  if (outdatedBanner) outdatedBanner.hidden = ended || !visible;
}

function setReviewState(state) {
  lastReviewState = state;
  // The artifact reported a card, so its anchor exists: whatever miss was recorded is answered.
  if (state?.card) unrestorableDraftMiss = null;
  if (!state || (!state.card && !(Array.isArray(state.fields) && state.fields.length))) {
    try {
      sessionStorage.removeItem(reviewStateStorageKey);
    } catch {
      // The in-memory state still works if browser storage is unavailable.
    }
    return;
  }
  saveJsonState(reviewStateStorageKey, state);
}

function hasUnsentDraft() {
  return Boolean(lastReviewState && lastReviewState.card && String(lastReviewState.card.text || "").trim());
}

// The SDK looked for this draft's anchor in a loaded artifact and did not find it. Retiring a
// draft is itself data loss - the user may still be typing while the agent rewrites the element
// they anchored to - so one miss only records the answer. The draft is retired only when a
// SECOND artifact revision reports the same anchor missing: an element that is merely being
// rewritten comes back, and a report on the revision already recorded is the same answer twice,
// not two answers. Any report for a different draft, or for a draft that is no longer stored,
// leaves the stored text alone.
function discardUnrestorableDraft(selector) {
  if (!selector || !lastReviewState || !lastReviewState.card) return;
  if (String(lastReviewState.card.selector || "") !== selector) return;
  const revision = artifactLoadRevision;
  if (unrestorableDraftMiss?.selector !== selector) {
    unrestorableDraftMiss = { selector, revision };
    return;
  }
  if (unrestorableDraftMiss.revision === revision) return;
  unrestorableDraftMiss = null;
  keepRetiredDraft(String(lastReviewState.card.text || ""));
  setReviewState({ ...lastReviewState, card: null });
}

// Retiring a draft ends Lavish's ability to replay it, so the text itself is handed back to the
// user before it goes: it is written to the conversation panel verbatim, where it is selectable,
// nothing overwrites what they may already be typing, and no control can discard it by accident.
// It is persisted per session so a reload does not take the last copy with it.
function loadRetiredDrafts() {
  const stored = loadJsonState(retiredDraftStorageKey, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry) => typeof entry === "string" && entry.trim());
}

// No entry already handed back is ever dropped to make room for a new one. When browser storage
// refuses the write, the note says so on the spot instead of an older one quietly disappearing at
// the next page load.
function keepRetiredDraft(text) {
  if (!text.trim()) return;
  retiredDrafts = [...retiredDrafts, text];
  renderRetiredDraft(text, saveJsonState(retiredDraftStorageKey, retiredDrafts));
}

function renderRetiredDraft(text, stored = true) {
  if (!chatLog) return;
  const el = document.createElement("div");
  el.className = "bubble note";
  el.innerHTML =
    "<small>Unsent annotation</small><div>The element this note was attached to is no longer in the artifact, so Lavish could not reopen the card. Your text is kept here:</div>" +
    '<div class="note-draft">' +
    escapeHtml(text) +
    "</div>" +
    (stored
      ? ""
      : '<div class="note-warning">This browser refused to store it, so copy it before you reload this page.</div>');
  retiredDraftNodes.push(el);
  chatLog.appendChild(el);
  scrollElementIntoView(el);
}

async function refreshChromeLoadHandoff(requestSequence) {
  const response = await fetch("/api/" + key + "/chrome-loads/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  const token = String(data?.chrome_load_token || "");
  if (!response.ok || !token) throw new Error("failed to refresh chrome handoff");
  if (requestSequence !== artifactLoadRequestSequence || ended) return false;
  chromeLoadToken = token;
  const revision = Number(data?.artifact_revision);
  const loadToken = String(data?.artifact_load_token || "");
  if (Number.isSafeInteger(revision) && revision >= 0) artifactLoadRevision = revision;
  if (loadToken) artifactLoadToken = loadToken;
  return true;
}

function scrollPanelToBottom() {
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

// ---- Phone-width conversation sheet ----
// Below this width chrome.css turns the conversation panel into a dock the user raises as a
// bottom sheet over the artifact. This controller owns intent, accessibility state, gestures,
// visual-viewport measurements, and the dock summary; CSS owns the geometry. The query must match
// the one chrome.css lays the sheet out under.
const MOBILE_SHEET_MEDIA = "(max-width: 860px)";
// How far a drag on the dock must travel before it counts as a gesture rather than a tap.
const SHEET_DRAG_THRESHOLD_PX = 48;
const sheetStorageKey = "lavish-axi:sheet-open:" + key;
const sheetMedia = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_SHEET_MEDIA) : null;
// The user's intent, kept across a chrome reload so a live-reload or server upgrade does not drop
// them back onto a closed dock mid-conversation.
let sheetOpen = readSheetOpen();
// The latest agent reply that landed while the sheet was closed: the dock previews it until the
// user opens the sheet, so a reply never arrives silently behind the artifact.
let unreadAgentReply = "";
/** @type {{ pointerId: any, startY: number, moved: boolean } | null} */
let sheetDrag = null;
let suppressSheetClick = false;

function readSheetOpen() {
  try {
    return sessionStorage.getItem(sheetStorageKey) === "1";
  } catch {
    return false;
  }
}

function isMobileSheet() {
  return Boolean(sheetMedia && sheetMedia.matches);
}

function setSheetOpen(open) {
  const next = Boolean(open);
  const changed = next !== sheetOpen;
  sheetOpen = next;
  try {
    if (sheetOpen) sessionStorage.setItem(sheetStorageKey, "1");
    else sessionStorage.removeItem(sheetStorageKey);
  } catch {
    // Storage refused is not worth a broken sheet: the state just stops surviving a reload.
  }
  if (sheetOpen) unreadAgentReply = "";
  applySheetState();
  if (!changed || !isMobileSheet()) return;
  if (sheetOpen) scrollPanelToBottom();
}

// Re-derives every sheet attribute from the phone layout, sheet-open, and session-ended state so a
// viewport crossing the breakpoint in either direction cannot make an ended panel interactive or
// leave a closed dock trapping focus.
function applySheetState() {
  const mobile = isMobileSheet();
  const open = mobile && sheetOpen;
  document.body.classList.toggle("sheet-open", open);
  const docked = mobile && !open;
  panelScroll.inert = ended || docked;
  chatComposer.inert = ended || docked;
  const activeElement = document.activeElement;
  if (docked && activeElement && (panelScroll.contains(activeElement) || chatComposer.contains(activeElement))) {
    panelToggle.focus();
  }
  panelToggle.setAttribute("aria-expanded", open ? "true" : "false");
  panelToggle.setAttribute("aria-label", open ? "Hide conversation" : "Show conversation");
  renderSheetSummary();
}

// What the closed dock says. One line, most actionable state first: work the user has queued,
// then a reply they have not seen, then whether the agent is there to receive a send.
function sheetSummary() {
  if (ended) return { text: "Session ended", accent: false, unread: false };
  if (queued.length > 0) {
    return { text: queued.length === 1 ? "1 queued" : queued.length + " queued", accent: true, unread: false };
  }
  if (unreadAgentReply) return { text: unreadAgentReply, accent: false, unread: true };
  if (agentPresence === "working") return { text: "Agent is working…", accent: false, unread: false };
  if (agentPresence === "listening") return { text: "Agent listening", accent: false, unread: false };
  return { text: "Agent not listening", accent: false, unread: false };
}

function renderSheetSummary() {
  const summary = sheetSummary();
  panelSummary.textContent = summary.text;
  panelSummary.classList.toggle("is-accent", summary.accent);
  panelSummary.classList.toggle("is-unread", summary.unread);
}

// A brief pulse on the dock when something the user should notice lands while the sheet is
// closed: a prompt they queued from the artifact, or an agent reply.
function pulseSheetDock() {
  if (!isMobileSheet() || sheetOpen) return;
  panelHead.classList.remove("is-fresh");
  // Restart the animation even when the previous pulse is still running.
  void panelHead.offsetWidth;
  panelHead.classList.add("is-fresh");
}

function noteAgentReply(text) {
  if (!isMobileSheet() || sheetOpen) return;
  unreadAgentReply = String(text || "");
  renderSheetSummary();
  pulseSheetDock();
}

// The phone keyboard shrinks the visual viewport without touching the layout viewport on iOS, so
// the sheet reads its height and offset from here; chrome.css consumes these only under the phone
// breakpoint. Android reports the same numbers through the layout viewport thanks to the
// `interactive-widget=resizes-content` viewport meta, which makes this a no-op there.
function syncVisualViewport() {
  const root = document.documentElement;
  if (!root || !root.style || typeof root.style.setProperty !== "function") return;
  const viewport = window.visualViewport;
  const height = viewport ? viewport.height : window.innerHeight;
  const top = viewport ? viewport.offsetTop : 0;
  if (!(height > 0)) return;
  root.style.setProperty("--vv-height", Math.round(height) + "px");
  root.style.setProperty("--vv-top", Math.round(Math.max(0, top || 0)) + "px");
}

function sheetDragOffset(event) {
  return sheetDrag ? Number(event.clientY) - sheetDrag.startY : 0;
}

function clearSheetDrag() {
  sheetDrag = null;
  panel.classList.remove("is-dragging");
  panel.style.transform = "";
}

function finishSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const offset = sheetDragOffset(event);
  const moved = sheetDrag.moved;
  clearSheetDrag();
  if (!moved) return;
  // The click that follows a completed drag must not undo what the drag decided.
  suppressSheetClick = true;
  if (sheetOpen && offset > SHEET_DRAG_THRESHOLD_PX) setSheetOpen(false);
  else if (!sheetOpen && offset < -SHEET_DRAG_THRESHOLD_PX) setSheetOpen(true);
}

panelHead.addEventListener("click", () => {
  if (!isMobileSheet()) return;
  if (suppressSheetClick) {
    suppressSheetClick = false;
    return;
  }
  setSheetOpen(!sheetOpen);
});
panelScrim.addEventListener("click", () => setSheetOpen(false));
panelHead.addEventListener("pointerdown", (event) => {
  if (!isMobileSheet() || event.button) return;
  sheetDrag = { pointerId: event.pointerId, startY: Number(event.clientY), moved: false };
  if (typeof panelHead.setPointerCapture === "function") panelHead.setPointerCapture(event.pointerId);
});
panelHead.addEventListener("pointermove", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const offset = sheetDragOffset(event);
  if (Math.abs(offset) > 6) sheetDrag.moved = true;
  if (!sheetDrag.moved) return;
  panel.classList.add("is-dragging");
  // Follow the finger: an open sheet only moves down, a closed dock only up.
  panel.style.transform = sheetOpen
    ? "translateY(" + Math.max(0, offset) + "px)"
    : "translateY(calc(100% - var(--dock-h) - env(safe-area-inset-bottom, 0px) + " + Math.min(0, offset) + "px))";
});
panelHead.addEventListener("pointerup", finishSheetDrag);
panelHead.addEventListener("pointercancel", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  clearSheetDrag();
  suppressSheetClick = false;
});
if (sheetMedia && typeof sheetMedia.addEventListener === "function") {
  sheetMedia.addEventListener("change", (event) => {
    if (!event.matches) {
      sheetOpen = false;
      try {
        sessionStorage.removeItem(sheetStorageKey);
      } catch {
        // Storage refusal only prevents persistence; the in-memory state is already reset.
      }
    }
    applySheetState();
  });
}
if (window.visualViewport && typeof window.visualViewport.addEventListener === "function") {
  window.visualViewport.addEventListener("resize", syncVisualViewport);
  window.visualViewport.addEventListener("scroll", syncVisualViewport);
}
window.addEventListener("resize", syncVisualViewport);
syncVisualViewport();

function scrollElementIntoView(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  persistQueuedPrompts();
  render();
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function enqueuePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }

  persistQueuedPrompts();
  render();
}

function stripInternalPromptFields(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

function requestSnapshot(action) {
  const request = { action, timeout: setTimeout(() => expireSnapshotRequest(request), SNAPSHOT_REQUEST_TIMEOUT_MS) };
  snapshotRequests.push(request);
  postToFrame({ type: "lavish:requestSnapshot" });
}

function takeSnapshotRequest(request) {
  const index = snapshotRequests.indexOf(request);
  if (index === -1) return null;
  snapshotRequests.splice(index, 1);
  clearTimeout(request.timeout);
  return request;
}

function expireSnapshotRequest(request) {
  if (!takeSnapshotRequest(request) || request.action !== "submit") return;
  showSendHint(SNAPSHOT_SKIPPED_COPY);
  pendingSnapshot = "";
  submitQueued();
}

function sendQueued(endAfter) {
  if (ended || agentPresence === "working") return;
  closeMenus();

  const text = chatInput.value.trim();
  if (text) {
    queued.push({ uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" });
    persistQueuedPrompts();
    addChat("user", text);
    chatInput.value = "";
    render();
  }
  if (!queued.length) {
    showSendHint();
    return;
  }
  hideSendHint();

  if (endAfter) endAfterSubmit = true;
  requestSnapshot("submit");
}

async function submitQueued() {
  if (submitQueuedPromise) {
    submitQueuedAgain = true;
    return submitQueuedPromise;
  }

  let succeeded = false;
  submitQueuedPromise = submitQueuedOnce();
  try {
    const result = await submitQueuedPromise;
    succeeded = result !== false;
    return result;
  } finally {
    submitQueuedPromise = null;
    const shouldSubmitAgain = submitQueuedAgain;
    submitQueuedAgain = false;
    if (!succeeded) {
      endAfterSubmit = false;
    } else if (!ended && shouldSubmitAgain) {
      if (queued.length) {
        submitQueued();
      } else if (endAfterSubmit) {
        endAfterSubmit = false;
        endSession();
      }
    }
  }
}

function postPrompts(body) {
  return fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
}

async function submitQueuedOnce() {
  const prompts = queued.slice();
  const shouldEndSession = endAfterSubmit;
  const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: pendingSnapshot };
  if (shouldEndSession) body.endSession = true;
  let response = await postPrompts(body);
  if (response?.status === 413 && body.domSnapshot) {
    body.domSnapshot = "";
    response = await postPrompts(body);
  }
  if (!response?.ok) {
    if (response?.status === 409) {
      const data = await response.json().catch(() => null);
      // The session already ended before this batch arrived - most likely this chrome missed the
      // SSE `ended` event (a dropped connection). Go read-only now instead of leaving Send enabled
      // for another attempt that will be refused the same way.
      if (data?.status === "ended") {
        endAfterSubmit = false;
        markSessionEnded();
        return false;
      }
      if (Array.isArray(data?.warnings)) setLayoutWarnings(data.warnings);
      endAfterSubmit = false;
      return false;
    }
    showSendError(SEND_FAILED_COPY);
    return false;
  }
  for (const prompt of prompts) {
    const index = queued.indexOf(prompt);
    if (index !== -1) queued.splice(index, 1);
  }
  persistQueuedPrompts();
  render();
  if (shouldEndSession) {
    endAfterSubmit = false;
    markSessionEnded();
    return;
  }
  if (agentPresence === "listening") setAgentPresence("working");
}

function normalizeLayoutFindings(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && String(item.severity || "").toLowerCase() === "error")
    : [];
}

function clearLayoutGateTimer() {
  layoutGateEscape?.cancel?.();
  if (layoutGateTimer) clearTimeout(layoutGateTimer);
  layoutGateTimer = undefined;
}

function setLayoutGateCard(state) {
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = "Fixing a layout issue...";
    layoutGateCopy.textContent =
      "The browser found inaccessible or unusable content. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = "Checking layout.<br>One moment.";
  layoutGateCopy.textContent = "Lavish is waiting for fonts and final geometry before revealing this artifact.";
}

function setLayoutGateActive(active) {
  layoutGateVisible = active;
  if (layoutGateOverlay) layoutGateOverlay.hidden = !active;
  document.body?.classList?.toggle("layout-gate-active", active);
}

// Terminal, user-recoverable failure state for the one thing the chrome cannot work around on
// its own: the artifact never loaded and retrying stopped helping. The overlay is reused because
// it already covers the empty artifact area; without this the user is left looking at either a
// spinner that never resolves or a blank frame, with nothing explaining it and nothing to click.
// Bumping the cycle invalidates the previous timer; a fresh hold timer replaces it right away so
// the card cannot strand the visual gate.
function setLayoutGateFailure(title, copy, actionLabel = "Reload", onAction, { sticky = false } = {}) {
  if (ended) return;
  // A sticky card is the user's to retire, and that has to hold against being overwritten as
  // well as against being cleared: the version-skew warning is the only thing telling this page
  // it is running the pre-upgrade client, and a later ordinary load failure must not replace it.
  if (layoutGateFailureActive && layoutGateFailureSticky && !sticky) return;
  layoutGateFailureActive = true;
  layoutGateFailureSticky = sticky;
  layoutGateCycle += 1;
  if (layoutGateTitle) layoutGateTitle.textContent = title;
  if (layoutGateCopy) layoutGateCopy.textContent = copy;
  if (layoutGateAction) {
    layoutGateAction.disabled = false;
    layoutGateAction.textContent = actionLabel;
    layoutGateAction.onclick = onAction || (() => location.reload());
  }
  if (layoutGateBypass) {
    layoutGateBypass.hidden = false;
    layoutGateBypass.onclick = () => forceRevealLayoutGate("manual");
  }
  setLayoutGateActive(true);
  armLayoutGateTimer();
}

// Every failure card in this feature is raised in a state where the server may not be listening,
// so none of them may navigate on trust: a reload into a dead port replaces a recoverable page
// with the browser's own connection-error page. Ask first, and say so when nothing answers.
// Title and body are written together: a probe that timed out establishes neither that the server
// is running nor that it is gone, so a heading naming a definite cause may not stand over a line
// saying the cause is unknown.
function checkServerThenReload(failureTitle, stillDownCopy) {
  let checking = false;
  return async () => {
    if (checking) return;
    checking = true;
    if (layoutGateAction) layoutGateAction.disabled = true;
    // The card this click was made on. A probe can take until HEALTH_PROBE_TIMEOUT_MS, and the
    // overlay may have moved on to a different card by then; its copy is not this probe's to
    // overwrite.
    const cycle = layoutGateCycle;
    let outcome = "not-running";
    let navigating = false;
    try {
      outcome = await probeChromeHealth();
      if (outcome === "running") {
        navigating = true;
        location.reload();
      }
    } finally {
      // Every path that does not navigate hands the control back, including a probe that timed
      // out or threw: a button that stays disabled is worse than the reload it was guarding.
      if (!navigating) {
        checking = false;
        if (layoutGateAction) layoutGateAction.disabled = false;
        if (cycle === layoutGateCycle) {
          const answered = outcome !== "no-answer";
          if (layoutGateTitle) layoutGateTitle.textContent = answered ? failureTitle : HEALTH_NO_ANSWER_TITLE;
          if (layoutGateCopy) layoutGateCopy.textContent = answered ? stillDownCopy : HEALTH_NO_ANSWER_COPY;
        }
      }
    }
  };
}

// A load attempt that gets going again retires the failure card. This runs even when the gate is
// disabled or the user already bypassed it, because otherwise the card would keep covering an
// artifact that has since loaded.
function clearLayoutGateFailure() {
  if (!layoutGateFailureActive || layoutGateFailureSticky) return;
  layoutGateFailureActive = false;
  if (layoutGateAction) {
    layoutGateAction.textContent = "Show anyway";
    layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  }
  if (layoutGateBypass) layoutGateBypass.hidden = true;
  revealLayoutGate();
}

function revealLayoutGate() {
  clearLayoutGateTimer();
  layoutGateEscape?.reveal?.();
  setLayoutGateActive(false);
}

function forceRevealLayoutGate(reason) {
  if (ended) return;
  if (reason === "manual") {
    layoutGateManuallyBypassed = true;
    layoutGateEscape?.manualReveal?.();
  }
  revealLayoutGate();
}

function armLayoutGateTimer() {
  clearLayoutGateTimer();
  if (layoutGateEscape?.arm) {
    layoutGateEscape.arm(layoutGateMaxHoldMs, () => forceRevealLayoutGate("timeout"));
    return;
  }
  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, layoutGateMaxHoldMs);
  layoutGateTimer?.unref?.();
}

function startLayoutGateCycle() {
  clearLayoutGateFailure();
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  setLayoutGateActive(true);
  // A sticky failure owns the card copy, but never the reveal. Do not repaint it as a checking
  // card, and do arm a fresh timer for reloads that happen while the sticky card is present.
  if (!layoutGateFailureSticky) setLayoutGateCard("checking");
  armLayoutGateTimer();
}

// The gate only waits for fonts and final geometry now. It never holds the artifact hostage
// pending an agent repair: findings are the user's to triage, so a completed pass always reveals
// and hands the result to the passive inbox.
function handleLayoutGatePass() {
  if (ended || !layoutGateVisible) return;
  revealLayoutGate();
}

function initializeLayoutGate() {
  if (layoutGateEscape?.isManuallyBypassed?.()) layoutGateManuallyBypassed = true;
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    return;
  }

  if (layoutGateAction) layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  if (layoutGateBypass) layoutGateBypass.onclick = () => forceRevealLayoutGate("manual");
  startLayoutGateCycle();
}

// ---------------------------------------------------------------------------
// Passive layout-warning inbox
// ---------------------------------------------------------------------------

async function submitLayoutDiagnostics(pass) {
  const response = await fetch("/api/" + key + "/layout-diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      complete: pass?.complete !== false,
      target_presence_complete: pass?.targetPresenceComplete === true,
      artifact_revision: Number(pass?.artifactRevision) || 0,
      artifact_load_token: String(pass?.artifactLoadToken || artifactLoadToken),
      artifact_pass_sequence: Number(pass?.artifactPassSequence) || 0,
      viewport_width: Number(pass?.viewportWidth) || 0,
      findings: normalizeLayoutFindings(pass?.findings),
    }),
  });
  if (!response.ok) throw new Error("failed to submit layout diagnostics");
  return response.json();
}

async function reportArtifactFailures(failures, loadToken = artifactLoadToken) {
  if (loadToken !== artifactLoadToken) return;
  await fetch("/api/" + key + "/artifact-failures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failures, artifact_load_token: loadToken, artifact_revision: artifactLoadRevision }),
  });
}

// The narrow fatal probe. A healthy artifact boots its SDK and starts talking within seconds; if
// nothing ever arrives we ask the server whether the document is servable at all. Probing only on
// silence keeps the normal path to a single artifact request, and a non-OK answer is the one
// signal that separates "the review is unusable" from "the review has layout problems".
function armArtifactAvailabilityProbe(loadToken = artifactLoadToken) {
  clearTimeout(artifactSilenceTimer);
  artifactSilenceTimer = setTimeout(() => {
    if (loadToken !== artifactLoadToken) return;
    probeArtifactAvailability(loadToken).catch(() => {});
  }, ARTIFACT_SILENCE_PROBE_MS);
  artifactSilenceTimer?.unref?.();
}

function artifactProbeSrc() {
  const separator = artifactSrc.includes("?") ? "&" : "?";
  return (
    artifactSrc +
    separator +
    "probe=1&artifact_revision=" +
    encodeURIComponent(artifactLoadRevision) +
    "&artifact_load_token=" +
    encodeURIComponent(artifactLoadToken)
  );
}

async function probeArtifactAvailability(loadToken) {
  if (loadToken !== artifactLoadToken) return;
  try {
    const response = await fetch(artifactProbeSrc(), { cache: "no-store" });
    if (loadToken !== artifactLoadToken) return;
    if (response.status === 409) return;
    if (response.ok) return;
    await reportArtifactFailures(
      [{ kind: "artifact-unavailable", detail: "the artifact document responded with HTTP " + response.status }],
      loadToken,
    );
  } catch {
    // A transient fetch failure is uncertainty, not proof - stay silent.
  }
}

function activeWarnings() {
  return layoutWarnings.filter((warning) => warning && warning.active);
}

function pendingLayoutWarningIds() {
  const ids = new Set();
  for (const prompt of queued) {
    if (prompt?.tag !== "layout-warnings" || prompt.target?.type !== "layout-warnings") continue;
    for (const warning of Array.isArray(prompt.target.warnings) ? prompt.target.warnings : []) {
      if (warning?.id) ids.add(String(warning.id));
    }
  }
  return ids;
}

function setLayoutWarnings(next) {
  layoutWarnings = Array.isArray(next) ? next : [];
  // Selections only ever reference warnings the user may still act on.
  const pending = pendingLayoutWarningIds();
  const selectable = new Set(
    layoutWarnings.filter((warning) => warning.selectable && !pending.has(warning.id)).map((warning) => warning.id),
  );
  for (const id of [...selectedWarningIds]) {
    if (!selectable.has(id)) selectedWarningIds.delete(id);
  }
  persistWarningSelection();
  renderWarnings();
}

function persistWarningSelection() {
  saveJsonState(warningSelectionStorageKey, [...selectedWarningIds]);
}

function warningRelativeTime(value) {
  const at = Date.parse(String(value || ""));
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function createWarningChip(text, extraClass) {
  const chip = document.createElement("span");
  chip.className = "warning-chip" + (extraClass ? " " + extraClass : "");
  chip.textContent = text;
  return chip;
}

function createWarningRow(warning) {
  const row = document.createElement("div");
  row.className = "warning-row" + (warning.outstanding ? " is-outstanding" : "");
  row.dataset.warningId = warning.id;
  const pending = pendingLayoutWarningIds().has(warning.id);
  const selectable = warning.selectable && !pending;
  const unavailableLabel = pending ? "is queued to send" : "is already queued for a fix";
  const statusLabel = pending ? "Queued for send" : warning.status_label;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "warning-select";
  checkbox.checked = selectable && selectedWarningIds.has(warning.id);
  checkbox.disabled = !selectable;
  checkbox.setAttribute(
    "aria-label",
    selectable
      ? "Select " + warning.title + " on " + warning.viewport_label
      : warning.title + " on " + warning.viewport_label + " " + unavailableLabel,
  );
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedWarningIds.add(warning.id);
    else selectedWarningIds.delete(warning.id);
    persistWarningSelection();
    updateWarningSelectionState();
  });
  row.appendChild(checkbox);

  const body = document.createElement("div");
  body.className = "warning-body";

  const title = document.createElement("div");
  title.className = "warning-title";
  title.textContent = warning.title;
  body.appendChild(title);

  const explanation = document.createElement("p");
  explanation.className = "warning-explanation";
  explanation.textContent = warning.explanation;
  body.appendChild(explanation);

  const meta = document.createElement("div");
  meta.className = "warning-meta";
  meta.appendChild(createWarningChip("Severe", "severity"));
  meta.appendChild(createWarningChip(statusLabel, "status-" + warning.status));
  meta.appendChild(createWarningChip(warning.viewport_label + " · " + warning.viewport_width + "px"));
  const seen = warningRelativeTime(warning.last_seen_at);
  if (seen) meta.appendChild(createWarningChip("Seen " + seen));
  body.appendChild(meta);

  const target = document.createElement("code");
  target.className = "warning-target";
  target.textContent = warning.selector || "(whole page)";
  body.appendChild(target);

  const actions = document.createElement("div");
  actions.className = "warning-actions";
  if (warning.selector) {
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "warning-action";
    reveal.textContent = "Reveal";
    reveal.setAttribute("aria-label", "Reveal " + warning.title + " in the artifact");
    reveal.addEventListener("click", () => revealWarning(warning));
    actions.appendChild(reveal);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "warning-action";
  dismiss.textContent = "Dismiss";
  dismiss.disabled = !selectable;
  dismiss.setAttribute(
    "aria-label",
    selectable
      ? "Dismiss " + warning.title + " for this artifact revision"
      : warning.title + " cannot be dismissed while " + (pending ? "queued to send" : "a fix is queued"),
  );
  dismiss.addEventListener("click", () => dismissWarning(warning.id));
  actions.appendChild(dismiss);
  body.appendChild(actions);

  row.appendChild(body);
  return row;
}

function renderWarnings() {
  if (!warningsWrap) return;
  const pending = pendingLayoutWarningIds();
  let selectionChanged = false;
  for (const id of [...selectedWarningIds]) {
    if (pending.has(id)) {
      selectedWarningIds.delete(id);
      selectionChanged = true;
    }
  }
  if (selectionChanged) persistWarningSelection();
  const active = activeWarnings();
  const count = active.length;

  warningsWrap.hidden = count === 0 || ended;
  if (warningsWrap.hidden && warningsDrawerOpen) setWarningsDrawerOpen(false);
  warningsCount.textContent = String(count);
  warningsButton.setAttribute(
    "aria-label",
    count === 1 ? "1 unresolved layout issue" : count + " unresolved layout issues",
  );

  const outstanding = active.filter((warning) => warning.outstanding).length;
  warningsSummary.textContent =
    (count === 1 ? "1 unresolved issue" : count + " unresolved issues") +
    (outstanding > 0 ? " · " + outstanding + " already queued for a fix" : "");

  warningsList.replaceChildren();
  if (count === 0) {
    const empty = document.createElement("p");
    empty.className = "warnings-empty";
    empty.textContent = "No unresolved layout issues.";
    warningsList.appendChild(empty);
  } else {
    for (const warning of active) warningsList.appendChild(createWarningRow(warning));
  }
  updateWarningSelectionState();
}

function updateWarningSelectionState() {
  const pending = pendingLayoutWarningIds();
  const selectable = activeWarnings().filter((warning) => warning.selectable && !pending.has(warning.id));
  const selectedCount = selectable.filter((warning) => selectedWarningIds.has(warning.id)).length;
  warningsSelectAll.disabled = selectable.length === 0;
  // Default selection is never "everything": Select all is an explicit action.
  warningsSelectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
  warningsSelectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  warningsSelected.textContent = selectedCount === 0 ? "None selected" : selectedCount + " selected";
  warningsQueueButton.disabled = selectedCount === 0 || ended || agentPresence === "working";
}

function toggleSelectAllWarnings() {
  const pending = pendingLayoutWarningIds();
  const selectable = activeWarnings().filter((warning) => warning.selectable && !pending.has(warning.id));
  const shouldSelect = warningsSelectAll.checked;
  for (const warning of selectable) {
    if (shouldSelect) selectedWarningIds.add(warning.id);
    else selectedWarningIds.delete(warning.id);
  }
  persistWarningSelection();
  renderWarnings();
}

function setWarningsDrawerOpen(open) {
  warningsDrawerOpen = open && !ended;
  warningsDrawer.hidden = !warningsDrawerOpen;
  warningsButton.setAttribute("aria-expanded", String(warningsDrawerOpen));
  if (warningsDrawerOpen) {
    closeMenus();
    warningsSelectAll.focus();
  }
}

function toggleWarningsDrawer() {
  setWarningsDrawerOpen(warningsDrawer.hidden);
}

function closeWarningsDrawer({ restoreFocus = false } = {}) {
  if (!warningsDrawerOpen) return;
  setWarningsDrawerOpen(false);
  if (restoreFocus) warningsButton.focus();
}

function revealWarning(warning) {
  postToFrame({ type: "lavish:revealElement", selector: warning.selector });
}

async function dismissWarning(id) {
  try {
    const response = await fetch("/api/" + key + "/layout-warnings/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) throw new Error("failed to dismiss layout warning");
    const data = await response.json();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
  } catch {
    // Leave the warning in place - a failed dismissal must never look like a resolution.
  }
}

// One queued batch = one ordinary queued prompt. The CLI cannot tell it apart from any other
// feedback, which is exactly the point: no parallel agent protocol.
async function queueSelectedWarningFixes() {
  if (ended || agentPresence === "working") return;
  const ids = [...selectedWarningIds];
  if (ids.length === 0) return;
  warningsQueueButton.disabled = true;
  try {
    const response = await fetch("/api/" + key + "/layout-warnings/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error("failed to queue layout warning fixes");
    const data = await response.json();
    if (data.prompt) {
      enqueuePrompt({
        uid: "",
        prompt: data.prompt.prompt,
        selector: "",
        tag: "layout-warnings",
        text: data.prompt.text,
        target: data.prompt.target,
      });
    }
    selectedWarningIds.clear();
    persistWarningSelection();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
    closeWarningsDrawer({ restoreFocus: true });
  } catch {
    updateWarningSelectionState();
  }
}

async function refreshLayoutWarnings() {
  try {
    const response = await fetch("/api/" + key + "/layout-warnings");
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
  } catch {
    // Keep whatever the chrome already has; never clear on a failed refresh.
  }
}

async function endSession() {
  if (ended) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded();
}

function markSessionEnded() {
  if (ended) return;
  ended = true;
  cancelArtifactLoadRecovery();
  closeMenus();
  closeWarningsDrawer();
  renderWarnings();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  applySheetState();
  if (presenceBanner) presenceBanner.hidden = true;
  if (handoffBanner) handoffBanner.hidden = true;
  if (outdatedBanner) outdatedBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  layoutGateFailureSticky = false;
  revealLayoutGate();
  layoutGateEscape?.end?.();
  postToFrame({ type: "lavish:setAnnotationMode", enabled: false });
  endedOverlay.hidden = false;
}

function copyFilePath() {
  copyText(filePath);
  copyHint.classList.add("copied");
  copyHintText.textContent = "Copied";
  clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => {
    copyHint.classList.remove("copied");
    copyHintText.textContent = "Copy";
  }, 1600);
}

function copyDomSnapshot() {
  closeMenus();
  requestSnapshot("copy");
}

function exportFileName() {
  const base = (filePath.split(/[\\/]/).pop() || "artifact.html").replace(/\.html?$/i, "");
  return (base || "artifact") + ".export.html";
}

function setExportLabel(text) {
  const label = exportArtifactButton.querySelector("span");
  if (label) label.textContent = text;
}

function unresolvedAssetText(count) {
  return count === 1 ? "1 unresolved asset" : `${count} unresolved assets`;
}

function noticeText(count) {
  return count === 1 ? "1 notice" : `${count} notices`;
}

function exportWarningText(unresolvedCount, noticeCount) {
  if (unresolvedCount > 0 && noticeCount > 0) {
    return `${unresolvedAssetText(unresolvedCount)} and ${noticeText(noticeCount)}`;
  }
  if (unresolvedCount > 0) return unresolvedAssetText(unresolvedCount);
  return noticeText(noticeCount);
}

async function exportArtifact() {
  // The bundle inlines local assets server-side, so it can take a moment - keep the menu open
  // and narrate progress in place instead of closing it and leaving the user with no feedback.
  exportArtifactButton.disabled = true;
  setExportLabel("Exporting...");
  try {
    const response = await fetch("/api/" + key + "/export");
    if (!response.ok) throw new Error("export failed");
    const warningCount = Number(response.headers.get("x-lavish-export-warning-count") || "0");
    const noticeCount = Number(response.headers.get("x-lavish-export-notice-count") || "0");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (warningCount > 0 || noticeCount > 0) {
      setExportLabel(`Exported with ${exportWarningText(warningCount, noticeCount)}`);
    } else {
      setExportLabel("Export standalone HTML");
      closeMenus();
    }
  } catch {
    setExportLabel("Export failed - retry");
  } finally {
    exportArtifactButton.disabled = false;
  }
}

function cancelArtifactLoadRecovery() {
  if (artifactLoadRecoveryTimer) clearTimeout(artifactLoadRecoveryTimer);
  artifactLoadRecoveryTimer = undefined;
}

// Retry a begin-load attempt that failed for a recoverable reason. Returns false once the
// backoff is exhausted so the caller can surface the terminal failure. A `superseded` or
// `out-of-order` outcome never lands here: another reviewer or a newer request in this same
// chrome owns the artifact, and retrying would fight it.
function scheduleArtifactLoadRecovery() {
  if (ended) return false;
  const delay = ARTIFACT_LOAD_RECOVERY_DELAYS_MS[artifactLoadRecoveryAttempt];
  if (delay === undefined) return false;
  artifactLoadRecoveryAttempt += 1;
  const sequence = artifactLoadRequestSequence;
  cancelArtifactLoadRecovery();
  artifactLoadRecoveryTimer = setTimeout(() => {
    artifactLoadRecoveryTimer = undefined;
    if (ended || sequence !== artifactLoadRequestSequence) return;
    replaceArtifactFrame({ recoveryRetry: true }).catch(() => {});
  }, delay);
  artifactLoadRecoveryTimer?.unref?.();
  return true;
}

// The backoff budget belongs to the load attempt that started it, not to the page: anything
// asking for a fresh load - a live reload, Reload artifact, a takeover - gets the whole budget
// again, and only the recovery timer's own retries spend it down.
async function replaceArtifactFrame({ recoveryRetry = false } = {}) {
  cancelArtifactLoadRecovery();
  if (!recoveryRetry) artifactLoadRecoveryAttempt = 0;
  clearTimeout(artifactSilenceTimer);
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  if (!artifactSrc) {
    startLayoutGateCycle();
    const currentSrc = frame.src || "about:blank";
    frame.src = currentSrc + (currentSrc.includes("?") ? "&" : "?") + "lavish_reload=" + Date.now();
    return true;
  }
  const requestSequence = ++artifactLoadRequestSequence;
  const requestId = `lavish-load-${Date.now().toString(36)}-${requestSequence}-${Math.random().toString(36).slice(2)}`;
  const previousToken = artifactLoadToken;
  const preservePreviousLoad = () => {
    if (
      requestSequence === artifactLoadRequestSequence &&
      !ended &&
      previousToken &&
      artifactSpokeToken !== previousToken
    ) {
      armArtifactAvailabilityProbe(previousToken);
    }
    return false;
  };
  // Keep whatever is on screen, then try again later. A begin-load can fail for reasons that
  // clear on their own - the shared server is mid-restart, or its handoff map was reset by that
  // restart and this chrome's one re-handshake landed in the same outage window. Giving up here
  // is what leaves the review permanently unloaded.
  const recoverLater = () => {
    preservePreviousLoad();
    if (requestSequence !== artifactLoadRequestSequence || ended) return false;
    if (scheduleArtifactLoadRecovery()) return false;
    // Out of retries. Only say so when there is nothing on screen to say it over: a chrome that
    // already shows an artifact keeps showing it rather than losing a usable review.
    if (!artifactLoadToken) {
      setLayoutGateFailure(
        "Lavish could not load this artifact.",
        "The Lavish server did not answer this review's load request. It usually restarted while this page was opening. Check and reload to reconnect.",
        "Check and reload",
        checkServerThenReload(
          "Lavish could not load this artifact.",
          "Lavish is still not answering. Start it again with your agent, then use Check and reload.",
        ),
      );
    }
    return false;
  };
  let load;
  let transportAttempt = 0;
  let handoffRefreshAttempted = false;
  while (true) {
    if (requestSequence !== artifactLoadRequestSequence || ended) return false;
    try {
      const response = await fetch("/api/" + key + "/artifact-loads/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          request_sequence: requestSequence,
          chrome_load_token: chromeLoadToken,
        }),
      });
      const candidate = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = String(candidate?.status || "");
        if (status === "no-handoff") {
          // One re-handshake per attempt keeps a live reviewer from being ping-ponged; the
          // retry that follows is a whole fresh attempt, so the rule still holds.
          if (handoffRefreshAttempted) return recoverLater();
          handoffRefreshAttempted = true;
          try {
            const refreshed = await refreshChromeLoadHandoff(requestSequence);
            if (!refreshed) return false;
          } catch {
            return recoverLater();
          }
          continue;
        }
        if (status === "superseded") {
          setHandoffSuperseded(true);
          // The takeover banner sits in the conversation panel, which the layout gate overlay
          // covers whenever the gate is enabled. A chrome that never loaded the artifact would
          // otherwise show the checking spinner until the gate's max hold expires and then
          // reveal an empty frame, with the only recovery control hidden the whole time. Say it
          // on the overlay instead. Still no background retry: the reload is the user's to make.
          if (!artifactLoadToken) {
            setLayoutGateFailure(
              "This review is already open in another tab.",
              "Lavish loads an artifact in one tab at a time. Take over here to move the review into this tab, or switch back to the tab that already has it.",
              "Take over here",
            );
          }
          return preservePreviousLoad();
        }
        if (status === "out-of-order") return preservePreviousLoad();
        throw new Error("failed to begin artifact load");
      }
      const candidateRevision = Number(candidate?.artifact_revision);
      const candidateToken = String(candidate?.artifact_load_token || "");
      if (!Number.isSafeInteger(candidateRevision) || candidateRevision < 0 || !candidateToken) {
        throw new Error("invalid artifact load");
      }
      load = { artifact_revision: candidateRevision, artifact_load_token: candidateToken };
      break;
    } catch {
      const delay = ARTIFACT_LOAD_BEGIN_RETRY_DELAYS_MS[transportAttempt++];
      if (delay === undefined) return recoverLater();
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
  }
  if (requestSequence !== artifactLoadRequestSequence || ended) return false;
  const revision = Number(load?.artifact_revision);
  const token = String(load?.artifact_load_token || "");
  if (!Number.isSafeInteger(revision) || revision < 0 || !token) return recoverLater();
  artifactLoadRecoveryAttempt = 0;
  artifactLoadRevision = revision;
  artifactLoadToken = token;
  artifactSpokeToken = "";
  setHandoffSuperseded(false);
  startLayoutGateCycle();
  frame.src = artifactFrameSrcForLoad({ revision, token });
  return true;
}

function resetFrame() {
  // Upstream wraps this in an inline-whiteboard flush; this fork has not taken the whiteboard
  // work (#166), so a reset is just the artifact-frame replacement.
  return replaceArtifactFrame();
}

function loadFrame() {
  if (artifactSrc) {
    if (artifactLoadToken) {
      frame.src = artifactFrameSrcForLoad({ revision: artifactLoadRevision, token: artifactLoadToken });
    }
    replaceArtifactFrame().catch(() => {});
  }
}

function reloadArtifact() {
  closeMenus();
  resetFrame();
}

async function reloadAfterServerRestart(reason) {
  if (chromeRestartReloadPromise) return chromeRestartReloadPromise;
  chromeRestartReloadPromise = reloadChromeAfterServerRestart(reason);
  return chromeRestartReloadPromise;
}

// Three outcomes, not two: a port that accepts a connection and then says nothing proves neither
// that the server is running nor that it is gone, and a probe that never settles would leave the
// control the user is holding disabled for as long as the browser's own network timeout takes.
async function probeChromeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch("/health", { cache: "no-store", signal: controller.signal });
    return res.ok ? "running" : "not-running";
  } catch {
    return controller.signal.aborted ? "no-answer" : "not-running";
  } finally {
    clearTimeout(timer);
  }
}

// The replacement server usually binds within a second, but it is a fresh node process competing
// with whatever else the machine is doing, and several `lavish-axi` invocations can be racing for
// the same port. Reloading on a fixed short deadline regardless of whether anything is listening
// trades a recoverable page for the browser's connection-error page, which no Lavish code can
// recover from. So wait for the port to answer, and if it never does, say so instead.
async function reloadChromeAfterServerRestart(reason = "") {
  let sawOutage = false;
  let healthy = false;
  let settled = false;
  // Keep the pre-outage behavior: a server that never actually went away is reloaded promptly.
  const settleDeadline = Date.now() + CHROME_RESTART_SETTLE_MS;
  const deadline = Date.now() + CHROME_RESTART_WAIT_MS;

  while (Date.now() < deadline) {
    // The bounded probe is what keeps this loop honest: a port that accepts and then says nothing
    // would otherwise hold one iteration open past the deadline, and neither the reload nor the
    // card below would ever happen.
    const outcome = await probeChromeHealth();
    healthy = outcome === "running";
    if (!healthy) sawOutage = true;
    if (healthy && (sawOutage || Date.now() >= settleDeadline)) {
      settled = true;
      break;
    }

    const probeDelay = Date.now() < settleDeadline ? CHROME_RESTART_PROBE_MS : CHROME_RESTART_SLOW_PROBE_MS;
    await new Promise((resolve) => setTimeout(resolve, probeDelay));
  }

  // A loop that ended on the deadline carries whatever the last probe happened to see, and in a
  // hidden tab the browser clamps these timers to seconds or minutes - so a single probe can be
  // the only one that ran. Neither answer may be trusted then: a stale failure claims a running
  // server is gone, and a stale success reloads into a port nothing is listening on.
  if (!settled) healthy = (await probeChromeHealth()) === "running";

  if (!healthy) {
    chromeRestartReloadPromise = null;
    setLayoutGateFailure(
      "Lavish is not running.",
      "The Lavish server restarted and did not come back. Start it again with your agent, then check and reload this page.",
      "Check and reload",
      checkServerThenReload(
        "Lavish is not running.",
        "Lavish is still not running. Start it again with your agent, then use Check and reload.",
      ),
      { sticky: true },
    );
    return;
  }

  // Unsent annotation text is the user's writing. A reload replays it, but it is still their
  // call when to interrupt the card they are typing into, so offer the reload instead of taking
  // it.
  if (hasUnsentDraft()) {
    chromeRestartReloadPromise = null;
    setChromeOutdated(true, reason);
    return;
  }

  location.reload();
}

// The banner is shown at the moment a server goes away, and in the deliberate-stop case nothing
// is coming to replace it, so this button probes before it navigates for the same reason the
// not-running card does: a reload into a dead port lands on the browser's own error page.
async function reloadChromeForOutdatedBanner() {
  if (outdatedReloadInFlight) return;
  outdatedReloadInFlight = true;
  if (outdatedReloadButton) outdatedReloadButton.disabled = true;
  // The banner this click was made on: a later one carries a newer reason, and that line stands.
  const generation = chromeOutdatedGeneration;
  let outcome = "not-running";
  let navigating = false;
  try {
    outcome = await probeChromeHealth();
    if (outcome === "running") {
      navigating = true;
      location.reload();
    }
  } finally {
    if (!navigating) {
      outdatedReloadInFlight = false;
      if (outdatedReloadButton) outdatedReloadButton.disabled = false;
      if (outdatedText && generation === chromeOutdatedGeneration) {
        outdatedText.textContent =
          outcome === "no-answer"
            ? HEALTH_NO_ANSWER_COPY
            : "Lavish is still not running. Start it again, then use Check and reload.";
      }
    }
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  const messageToken = String(msg.artifact_load_token || "");
  if (messageToken !== artifactLoadToken) {
    // A pass can be stamped by the load that just lost a token race. Ask the current artifact
    // document to run the audit again instead of consuming the only pass for this cycle.
    if (msg.type === "lavish:layoutDiagnostics") postToFrame({ type: "lavish:requestLayoutDiagnostics" });
    return;
  }
  const messageSequence = ++artifactMessageSequence;
  artifactSpokeToken = messageToken;
  clearTimeout(artifactSilenceTimer);
  if (msg.type === "lavish:layoutDiagnostics") {
    const diagnosticSequence = ++layoutDiagnosticSequence;
    const complete = msg.complete !== false;
    // The gate is visual, so the client-side settled pass is the release signal. Reporting the
    // pass is deliberately fire-and-forget: a server restart or a diagnostics 4xx/5xx must not
    // hold a rendered artifact hostage to a network round-trip.
    if (complete) handleLayoutGatePass();
    submitLayoutDiagnostics({
      complete,
      targetPresenceComplete: msg.target_presence_complete === true,
      artifactRevision: msg.artifact_revision,
      artifactLoadToken: msg.artifact_load_token,
      artifactPassSequence: msg.artifact_pass_sequence,
      viewportWidth: msg.viewport_width,
      findings: msg.findings,
    })
      .then((result) => {
        if (messageToken !== artifactLoadToken || diagnosticSequence !== layoutDiagnosticSequence) return;
        if (Array.isArray(result?.warnings)) setLayoutWarnings(result.warnings);
        if (result?.status === "stale") {
          if (messageSequence === artifactMessageSequence) armArtifactAvailabilityProbe(messageToken);
        }
      })
      .catch(() => {
        // A failed report is still a completed client-side pass. Keep this fallback explicit so a
        // future change cannot accidentally make the network request the gate's release path.
        if (complete && messageToken === artifactLoadToken && diagnosticSequence === layoutDiagnosticSequence) {
          handleLayoutGatePass();
        }
      });
    return;
  }
  // The artifact spoke, so it rendered and ran its SDK - there is nothing fatal to probe for.
  if (msg.type === "lavish:queuePrompt") {
    enqueuePrompt(msg.prompt);
    // Queued from inside the artifact, where the closed dock is the only sign it landed.
    pulseSheetDock();
  }
  if (msg.type === "lavish:snapshot") {
    const request = takeSnapshotRequest(snapshotRequests[0]);
    if (request?.action === "copy") {
      copyText(msg.snapshot || "");
    } else if (queued.length) {
      pendingSnapshot = msg.snapshot || "";
      submitQueued();
    }
  }
  if (msg.type === "lavish:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "lavish:reviewState") {
    setReviewState(msg.state && typeof msg.state === "object" ? msg.state : null);
  }
  if (msg.type === "lavish:reviewDraftUnrestorable") {
    discardUnrestorableDraft(String(msg.selector || ""));
  }
  if (msg.type === "lavish:artifactAssetFailure") {
    reportArtifactFailures(
      [{ kind: "artifact-asset-unavailable", detail: String(msg.detail || "a local artifact asset failed to load") }],
      messageToken,
    ).catch(() => {});
  }
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession();
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
});

loadFrame();

function toggleAnnotationMode() {
  if (ended) return;
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
}

annotationSwitch.onclick = toggleAnnotationMode;

sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
moreButton.onclick = () => {
  closeWarningsDrawer();
  toggleMenu(moreButton, moreMenu);
};
warningsButton.onclick = toggleWarningsDrawer;
warningsSelectAll.onchange = toggleSelectAllWarnings;
warningsQueueButton.onclick = queueSelectedWarningFixes;
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendQueued(false);
  }
});
chatInput.addEventListener("input", hideSendHint);
copyPathButton.onclick = copyFilePath;
reloadArtifactButton.onclick = reloadArtifact;
copySnapshotButton.onclick = copyDomSnapshot;
exportArtifactButton.onclick = exportArtifact;
endButton.onclick = () => {
  closeMenus();
  endSession();
};
handoffTakeoverButton.onclick = () => location.reload();
if (outdatedReloadButton) outdatedReloadButton.onclick = () => reloadChromeForOutdatedBanner();
if (outdatedDismissButton) outdatedDismissButton.onclick = () => setChromeOutdated(false);
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
  if (warningsDrawerOpen && !warningsWrap.contains(target)) closeWarningsDrawer();
});
// A non-modal popover closes when focus leaves it, so keyboard users are never stranded inside a
// panel they cannot see the end of.
warningsWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (warningsDrawerOpen && next && !warningsWrap.contains(next)) closeWarningsDrawer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // The share dialog used to take precedence here; with it removed, Escape closes the layout
    // issues drawer when open and otherwise dismisses any open chrome menu.
    if (warningsDrawerOpen) {
      closeWarningsDrawer({ restoreFocus: true });
    } else if (!moreMenu.hidden) {
      closeMenus();
    } else if (sheetOpen && isMobileSheet()) {
      setSheetOpen(false);
    } else {
      closeMenus();
    }
  }
});
// Capture phase so the mode hotkey fires no matter where focus is in the chrome - including
// mid-keystroke in chatInput or an annotation-card textarea - without disturbing normal typing.
document.addEventListener(
  "keydown",
  (event) => {
    if (!isModeToggleHotkeyEvent(event)) return;
    event.preventDefault();
    toggleAnnotationMode();
  },
  true,
);
frame.addEventListener("load", () => {
  if (artifactSpokeToken !== artifactLoadToken) armArtifactAvailabilityProbe(artifactLoadToken);
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
  if (lastReviewState) postToFrame({ type: "lavish:restoreReviewState", state: lastReviewState });
});

initializeLayoutGate();

const events = new EventSource("/events/" + key);
events.addEventListener("reload", () => resetFrame());
events.addEventListener("chrome-reload", (event) => reloadAfterServerRestart(shutdownEventReason(event)));
// The replacement server serves a different artifact's review. This page keeps working against
// it; it is only running the previous version of the chrome, which is the user's to act on.
events.addEventListener("chrome-outdated", (event) => setChromeOutdated(true, shutdownEventReason(event)));
events.addEventListener("agent-reply", (event) => {
  const text = JSON.parse(event.data).text;
  addChat("agent", text);
  noteAgentReply(text);
});
events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
events.addEventListener("agent-presence", (event) => setAgentPresence(JSON.parse(event.data).state));
events.addEventListener("layout-warnings", (event) => setLayoutWarnings(JSON.parse(event.data).warnings || []));
events.addEventListener("ended", () => markSessionEnded());
// A reconnecting stream means this chrome may have missed updates while it was away.
events.addEventListener("open", () => refreshLayoutWarnings());

applySheetState();
render();
setChromeOutdated(false);
setWarningsDrawerOpen(false);
renderWarnings();
initialChat.forEach((item) => addChat(item.role, item.text));
retiredDrafts.forEach((text) => renderRetiredDraft(text));
setAgentPresence("waiting");
// The session already ended before this page (re)loaded, so there is no future SSE `ended` event
// to wait for - start read-only instead of looking live until a Send gets silently refused.
if (sessionData.initialEnded) markSessionEnded();

// Reaching this line is the only proof that this file parsed and ran to completion. The inline
// bootstrap already owns the gate's bounded escape if this script fails; retire only its separate
// boot-failure timer now that the full client has taken over.
const chromeBootWindow = /** @type {Record<string, any>} */ (/** @type {unknown} */ (window));
chromeBootWindow.__lavishChromeReady = true;
chromeBootWindow.__lavishCancelChromeBootFailsafe?.();
