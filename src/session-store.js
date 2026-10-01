import crypto from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyDiagnosticPass,
  dismissLayoutWarning as dismissWarningRecord,
  hasOutstandingRepairRequest,
  isSelectableLayoutWarning,
  layoutWarningPromptPayload,
  markObsoleteViewportWarnings,
  normalizeLayoutWarningsTarget,
  normalizeStoredWarnings,
  queueLayoutWarnings as queueWarningRecords,
  serializeLayoutWarnings,
} from "./layout-warnings.js";
import { AsyncMutex } from "./async-mutex.js";
import { chatEntryForPrompt, normalizePromptId } from "./chat-messages.js";
import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

export const LAYOUT_WARNINGS_TARGET_TYPE = "layout-warnings";
const MAX_ARTIFACT_FAILURES = 20;
// How long a delivered feedback batch stays leased to the poll that took it. A poll that dies
// before acknowledging (reaped harness job, background process nobody reads) leaves the lease to
// expire, after which the batch is delivered again instead of being lost.
export const FEEDBACK_LEASE_TTL_MS = 60_000;
// How long a delivered attachment stays referenced after its lease is retired (ack or agent
// reply). While the batch is leased the lease itself keeps the attachment referenced; this window
// covers the agent that acked the batch and is still opening the paths it was handed. It is a
// bounded read window, not a second lifetime: the TTL and the disk cap must still be able to
// reclaim delivered bytes eventually.
export const ATTACHMENT_DELIVERY_GRACE_MS = 60 * 60 * 1000; // 1 hour

// A whole POST /prompts batch is one user's queued annotations, so its total image
// count is small in every real use. Bounding it is what keeps the resolver work
// below O(payload size) while the store's global lock is held. It bounds ONE
// request; prompts accumulate across requests until a poll drains them, so it says
// nothing about how much a single delivery carries.
export const MAX_REQUEST_ATTACHMENT_REFS = 256;

// Bounds only the retained HISTORY of earlier deliveries - state.json is rewritten
// wholesale on every store operation, so the list cannot grow forever.
//
// It deliberately does NOT bound the current delivery. The invariant is structural,
// not numeric: whatever `takeFeedback` just handed the agent is retained in full,
// however large, and this cap only decides how much older history rides along. Any
// number chosen here would be wrong, because pending prompts accumulate across an
// unbounded number of accepted requests - so a single poll can legitimately deliver
// far more than any one request may queue. Trimming the current delivery to fit a
// constant is what reopens the hole this retention exists to close.
export const MAX_DELIVERED_ATTACHMENTS = 256;

export class SessionStore {
  constructor(file, { feedbackLeaseTtlMs = FEEDBACK_LEASE_TTL_MS, now = () => Date.now() } = {}) {
    this.file = file;
    this.feedbackLeaseTtlMs = feedbackLeaseTtlMs;
    this.now = now;
    // One mutex serializes every state.json read-modify-write and the server's
    // attachment disk lifecycle sections through runExclusive.
    this.lock = new AsyncMutex();
    // Hot copies of `session.artifact_load`, which is the durable record. A process that did not
    // issue the load reads it back through `#activeArtifactLoad` the first time it is asked for.
    this.artifactLoads = new Map();
    this.chromeLoadContexts = new Map();
  }

  // The one reader of the active load. It exists because the load outlives the process that
  // issued it: an upgrade restart replaces the server under a reviewer who never asked for it,
  // and a load this store merely forgot is not a load that ended. Whether a token is still
  // current is decided by `beginArtifactLoad` alone - nothing else may retire one.
  #activeArtifactLoad(session) {
    const cached = this.artifactLoads.get(session.key);
    if (cached) return cached;
    const restored = restoreArtifactLoad(session.artifact_load);
    if (!restored) return undefined;
    this.artifactLoads.set(session.key, restored);
    // The handoff that owns this load is part of the same record. Restoring the load without it
    // would hand the review to whichever tab re-handshakes first, so a restart would decide the
    // single-reviewer question that only an explicit takeover is allowed to decide. A handoff
    // this process has already issued is newer than the record and always wins.
    if (!this.chromeLoadContexts.has(session.key)) {
      this.chromeLoadContexts.set(session.key, restored.handoffToken);
    }
    return restored;
  }

  async listSessions() {
    return this.runExclusive(async () => {
      const state = await this.readState();
      return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
    });
  }

  async findByFile(file) {
    const absolute = await canonicalFile(file);
    return this.runExclusive(async () => {
      const state = await this.readState();
      return state.sessions[sessionKey(absolute)] || null;
    });
  }

  async findByKey(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      return state.sessions[key] || null;
    });
  }

  async upsertSession(file, url) {
    const absolute = await canonicalFile(file);
    const key = sessionKey(absolute);
    return this.runExclusive(async () => {
      const state = await this.readState();
      const existing = state.sessions[key] || {};
      const existingPrompts = existing.prompts || [];
      const existingStatus = existing.status === "ended" ? "open" : existing.status || "open";
      const session = {
        key,
        file: absolute,
        url,
        status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
        pending_prompts: existing.pending_prompts || 0,
        prompts: existingPrompts,
        leases: normalizeLeases(existing.leases),
        // The warning inbox is durable review state, not deliverable feedback: reopening a session
        // must never silently drop unresolved warnings the user has not triaged yet.
        layout_warnings: normalizeStoredWarnings(existing.layout_warnings),
        artifact_revision: normalizeRevision(existing.artifact_revision),
        // The reviewer's open tab is holding this token, so reopening the artifact must not retire
        // it: only a newer `beginArtifactLoad` retires a load.
        artifact_load: normalizeStoredArtifactLoad(existing.artifact_load),
        artifact_failures: Array.isArray(existing.artifact_failures) ? existing.artifact_failures : [],
        // Carried across a reopen on purpose: this list is what keeps a just-delivered
        // attachment out of the sweeper's reach, and re-opening the artifact during the
        // grace window would otherwise erase that protection while the agent is still
        // reading the path. Every field this constructor omits is silently dropped, so
        // any new session field must be added here too.
        delivered_attachments: Array.isArray(existing.delivered_attachments) ? existing.delivered_attachments : [],
        dom_snapshot: existing.dom_snapshot || "",
        chat: existing.chat || [],
        chat_revision: normalizeRevision(existing.chat_revision),
        // Compact prompt_id acks for entries no longer in `chat`. Reopening must keep them: they
        // are the settlement/dedup source once the visible entry is gone.
        chat_ack_ids: Array.isArray(existing.chat_ack_ids) ? existing.chat_ack_ids : [],
        updated_at: new Date().toISOString(),
      };
      state.sessions[key] = session;
      await this.writeState(state);
      return session;
    });
  }

  // `options.resolveAttachment(key, id) => Promise<metadata|null>` is the trust
  // boundary for image attachments: a prompt only ever carries the client's
  // claimed `id` (and display `name`); every authoritative field (absolute path,
  // mime, byte size, dimensions) is re-derived from disk here, so a crafted
  // `/prompts` POST cannot point an attachment at an arbitrary file. Without a
  // resolver, unresolved attachments are dropped rather than trusted.
  //
  // The whole read -> resolve -> write path runs under the store's single lock so
  // it is atomic against a concurrent poll's `takeFeedback` AND against the sweeper's
  // reference snapshot + delete and upload finalize, which the server runs under the
  // same lock via `runExclusive`.
  async queuePrompts(key, payload, options = {}) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      const shouldEndSession = Boolean(payload.endSession || payload.end_session);
      // A session already ended by someone else (an agent's `lavish-axi end`, or the user in
      // another tab) must not accept a further batch as if it were queued for delivery: no agent
      // will ever poll it again, so a 200 here would be a promise the server cannot keep. This
      // applies even to a batch that also requests `endSession` - a redundant end of an
      // already-ended session is still a late batch nobody will read.
      if (session.status === "ended") {
        return { ended: true, ended_by: session.ended_by };
      }
      // A prompt whose identity the transcript already acknowledges was accepted by an earlier
      // POST whose response was lost. Drop it here, before attachment resolution and
      // layout-warning planning, so the retry neither re-appends chat nor wakes a poll.
      const acknowledgedIds = new Set(
        [
          ...(session.chat || []).map((entry) => normalizePromptId(entry?.prompt_id)),
          ...(session.chat_ack_ids || []).map((id) => normalizePromptId(id)),
        ].filter(Boolean),
      );
      const normalized = prompts.map(normalizePrompt).filter(({ prompt }) => {
        const promptId = normalizePromptId(prompt.prompt_id);
        if (!promptId) return true;
        if (acknowledgedIds.has(promptId)) return false;
        acknowledgedIds.add(promptId);
        return true;
      });
      const normalizedPrompts = normalized.map((entry) => entry.prompt);
      // Resolve every attachment BEFORE mutating anything. If any prompt's images
      // can't be fully honored - malformed, an unknown id, or over the per-prompt
      // count/byte cap - reject the WHOLE batch and persist nothing. Silently
      // truncating here while returning success would drop images the user attached,
      // and the chrome would clear its queue believing they were delivered.
      const rejected = boundAttachmentRefs(normalized, options);
      if (!rejected.length) {
        for (const prompt of normalizedPrompts) {
          const { resolved, rejected: promptRejected } = await resolvePromptAttachments(
            prompt.attachments,
            key,
            options,
          );
          if (promptRejected.length) rejected.push(...promptRejected);
          if (resolved.length > 0) prompt.attachments = resolved;
          else delete prompt.attachments;
        }
      }
      if (rejected.length) {
        return {
          rejected: rejected.slice(0, MAX_REPORTED_ATTACHMENT_REJECTIONS),
          caps: {
            maxPerPrompt: Number.isFinite(options.maxPerPrompt) ? options.maxPerPrompt : null,
            maxPromptBytes: Number.isFinite(options.maxPromptBytes) ? options.maxPromptBytes : null,
          },
        };
      }
      const revision = normalizeRevision(session.artifact_revision);
      const at = new Date().toISOString();
      let warnings = normalizeStoredWarnings(session.layout_warnings);
      const layoutPlans = [];
      const conflicts = new Set();
      for (const prompt of normalizedPrompts) {
        const warningIds = layoutWarningPromptIds(prompt);
        if (warningIds === null) {
          layoutPlans.push({
            prompt,
            warningIds: null,
            expectedRevision: null,
            conflicts: [],
            queueIds: [],
            hadKnownWarning: false,
          });
          continue;
        }
        const plan = planLayoutWarningPrompt(warnings, prompt, revision);
        for (const id of plan.conflicts) conflicts.add(id);
        layoutPlans.push({ prompt, ...plan });
      }
      if (conflicts.size > 0) {
        return {
          conflict: true,
          session,
          warning_ids: [...conflicts],
          warnings: serializeLayoutWarnings(warnings),
        };
      }
      const acceptedPrompts = [];
      for (const plan of layoutPlans) {
        if (plan.warningIds === null) {
          acceptedPrompts.push(plan.prompt);
          continue;
        }
        const result = queueWarningRecords(warnings, plan.queueIds, { revision, at });
        warnings = result.warnings;
        if (result.queued.length > 0 || !plan.hadKnownWarning) acceptedPrompts.push(plan.prompt);
      }
      session.layout_warnings = warnings;
      // Every accepted prompt with something to display joins the transcript, not only composer
      // messages: the notes a reviewer sends are the half of the conversation the panel used to
      // lose on send.
      const userMessages = acceptedPrompts.map((prompt) => chatEntryForPrompt(prompt, at)).filter(Boolean);
      session.prompts = [...(session.prompts || []), ...acceptedPrompts.map(agentFacingPrompt)];
      session.chat = [...(session.chat || []), ...userMessages];
      if (userMessages.length > 0) session.chat_revision = normalizeRevision(session.chat_revision) + 1;
      session.pending_prompts = session.prompts.length;
      session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
      session.status = shouldEndSession ? "ended" : session.prompts.length > 0 ? "feedback" : "open";
      if (shouldEndSession) session.ended_by = "user";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { ...session, fresh_feedback: acceptedPrompts.length > 0 };
    });
  }

  async issueReviewerHandoff(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const chromeLoadToken = crypto.randomBytes(24).toString("base64url");
      this.chromeLoadContexts.set(key, chromeLoadToken);
      const activeLoad = this.#activeArtifactLoad(session);
      return {
        session,
        chrome_load_token: chromeLoadToken,
        artifact_revision: activeLoad?.artifactRevision ?? normalizeRevision(session.artifact_revision),
        artifact_load_token: activeLoad?.artifactLoadToken || "",
        artifact_load_sequence: activeLoad?.requestSequence || 0,
      };
    });
  }

  /** @returns {Promise<any>} */
  async beginArtifactLoad(key, { requestId = "", requestSequence = 0, handoffToken = "" } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const normalizedRequestId = String(requestId || "");
      const parsedRequestSequence = Number(requestSequence);
      const normalizedRequestSequence =
        Number.isSafeInteger(parsedRequestSequence) && parsedRequestSequence > 0 ? parsedRequestSequence : 0;
      const normalizedHandoffToken = String(handoffToken || "");
      // Read the load first: restoring it is also what re-establishes the handoff that owns it,
      // so a reviewer whose server was replaced is not answered `no-handoff` for holding a
      // capability that is still the current one.
      const activeLoad = this.#activeArtifactLoad(session);
      const activeHandoffToken = this.chromeLoadContexts.get(key) || "";
      const staleResult = (status) => ({
        session,
        stale: status,
        artifact_revision: activeLoad?.artifactRevision ?? normalizeRevision(session.artifact_revision),
        artifact_load_token: activeLoad?.artifactLoadToken || "",
      });
      if (!activeHandoffToken || !normalizedHandoffToken) {
        return staleResult("no-handoff");
      }
      if (normalizedHandoffToken !== activeHandoffToken) {
        return staleResult("superseded");
      }
      if (
        normalizedRequestId &&
        activeLoad?.requestId === normalizedRequestId &&
        activeLoad.handoffToken === normalizedHandoffToken
      ) {
        return {
          session,
          artifact_revision: activeLoad.artifactRevision,
          artifact_load_token: activeLoad.artifactLoadToken,
        };
      }
      if (
        normalizedRequestSequence > 0 &&
        activeLoad?.handoffToken === normalizedHandoffToken &&
        activeLoad.requestSequence > normalizedRequestSequence
      ) {
        return staleResult("out-of-order");
      }
      const artifactRevision = normalizeRevision(session.artifact_revision) + 1;
      const artifactLoadToken = crypto.randomBytes(24).toString("base64url");
      const load = {
        artifactRevision,
        artifactLoadToken,
        lastPassSequence: 0,
        requestId: normalizedRequestId,
        requestSequence: normalizedRequestSequence,
        handoffToken: normalizedHandoffToken,
      };
      this.artifactLoads.set(key, load);
      session.artifact_load = serializeArtifactLoad(load);
      session.artifact_revision = artifactRevision;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, artifact_revision: artifactRevision, artifact_load_token: artifactLoadToken };
    });
  }

  async verifyArtifactLoad(key, artifactLoadToken, artifactRevision) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const load = this.#activeArtifactLoad(session);
      const revision = parseRevisionValue(artifactRevision);
      const valid = Boolean(
        load &&
        String(artifactLoadToken || "") &&
        String(artifactLoadToken) === load.artifactLoadToken &&
        revision === load.artifactRevision,
      );
      return {
        session,
        valid,
        artifact_revision: load?.artifactRevision ?? normalizeRevision(session.artifact_revision),
        artifact_load_token: load?.artifactLoadToken || "",
      };
    });
  }

  // Fold one browser diagnostic pass into the passive warning inbox. This deliberately does NOT
  // touch session status or queue feedback: detection alone must never wake an agent.
  /**
   * @param {{ viewportClasses?: string[] }} [options]
   */
  async recordLayoutDiagnostics(key, payload, options = {}) {
    return this.runExclusive(async () => {
      const viewportClasses = options.viewportClasses;
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const revision = normalizeRevision(session.artifact_revision);
      const load = this.#activeArtifactLoad(session);
      const artifactLoadToken = String(payload?.artifact_load_token || payload?.artifactLoadToken || "");
      const reportedRevision = parseDiagnosticRevision(payload);
      const passSequence = parsePassSequence(payload);
      if (
        !load ||
        artifactLoadToken !== load.artifactLoadToken ||
        !reportedRevision.present ||
        reportedRevision.value !== load.artifactRevision ||
        !passSequence.present ||
        passSequence.value <= load.lastPassSequence
      ) {
        return {
          session,
          changed: false,
          stale: true,
          warnings: serializeLayoutWarnings(session.layout_warnings),
        };
      }
      load.lastPassSequence = passSequence.value;
      const at = new Date().toISOString();
      const pass = applyDiagnosticPass(session.layout_warnings, {
        complete: payload.complete !== false,
        targetPresenceComplete: payload.target_presence_complete === true || payload.targetPresenceComplete === true,
        viewportWidth: payload.viewport_width ?? payload.viewportWidth,
        findings: payload.findings || payload.layout_warnings || payload.layoutWarnings || [],
        revision,
        at,
      });
      let warnings = pass.warnings;
      let changed = pass.changed;
      if (viewportClasses) {
        const obsolete = markObsoleteViewportWarnings(warnings, viewportClasses, { at, revision });
        warnings = obsolete.warnings;
        changed = changed || obsolete.changed;
      }
      if (!changed) {
        return { session, changed: false, warnings: serializeLayoutWarnings(warnings) };
      }
      session.layout_warnings = warnings;
      // Ride along with a write this pass was already making. The pass fence is deliberately NOT
      // worth a write of its own: a repeat pass that changes no warning must not rewrite
      // state.json, and a fence restored one pass behind only re-admits a pass whose findings
      // `applyDiagnosticPass` already treats as the same answer.
      session.artifact_load = serializeArtifactLoad(load);
      session.updated_at = at;
      await this.writeState(state);
      return { session, changed: true, warnings: serializeLayoutWarnings(warnings) };
    });
  }

  // Prepare the user's explicit triage action. The ordinary prompt queue commits it when sent.
  async prepareLayoutWarningFixes(key, ids) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const revision = normalizeRevision(session.artifact_revision);
      const at = new Date().toISOString();
      const result = queueWarningRecords(session.layout_warnings, ids, { revision, at });
      if (!result.queued.length) {
        return { session, queued: [], prompt: null, warnings: serializeLayoutWarnings(session.layout_warnings) };
      }
      return {
        session,
        queued: result.queued,
        prompt: layoutWarningPromptPayload(result.queued),
        warnings: serializeLayoutWarnings(session.layout_warnings),
      };
    });
  }

  async dismissLayoutWarning(key, id) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const revision = normalizeRevision(session.artifact_revision);
      const result = dismissWarningRecord(session.layout_warnings, id, { revision });
      if (!result.changed) {
        return { session, changed: false, warnings: serializeLayoutWarnings(session.layout_warnings) };
      }
      session.layout_warnings = result.warnings;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: true, warnings: serializeLayoutWarnings(result.warnings) };
    });
  }

  // The narrow fatal path: failures that make the review itself unusable (the artifact cannot be
  // served, or one of its own local assets cannot be loaded). These are NOT layout findings and
  // do not enter the passive inbox - they still reach the agent immediately, because there is no
  // usable review for the user to triage from.
  async recordArtifactFailures(key, payload) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const load = this.#activeArtifactLoad(session);
      const artifactLoadToken = String(payload?.artifact_load_token || payload?.artifactLoadToken || "");
      const reportedRevision = parseDiagnosticRevision(payload);
      if (
        !load ||
        artifactLoadToken !== load.artifactLoadToken ||
        !reportedRevision.present ||
        reportedRevision.value !== load.artifactRevision
      ) {
        return { session, changed: false, stale: true };
      }
      const normalized = normalizeArtifactFailures(payload?.failures);
      const previous = Array.isArray(session.artifact_failures) ? session.artifact_failures : [];
      const merged = [...previous];
      let changed = false;
      for (const failure of normalized) {
        if (merged.some((item) => item.kind === failure.kind && item.detail === failure.detail)) continue;
        merged.push(failure);
        changed = true;
      }
      if (!changed) {
        return { session, changed: false };
      }
      session.artifact_failures = merged.slice(-MAX_ARTIFACT_FAILURES);
      if (session.status !== "ended") session.status = "feedback";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: true };
    });
  }

  async listLayoutWarnings(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      return {
        warnings: serializeLayoutWarnings(session.layout_warnings),
        revision: normalizeRevision(session.artifact_revision),
      };
    });
  }

  async hasOutstandingLayoutRepairs(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return false;
      return normalizeStoredWarnings(session.layout_warnings).some(hasOutstandingRepairRequest);
    });
  }

  /** @returns {Promise<any>} */
  async takeFeedback(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return { status: "missing" };
      }
      const now = this.now();
      const leases = normalizeLeases(session.leases);
      const expired = leases.filter((lease) => this.leaseExpired(lease, now));
      const live = leases.filter((lease) => !this.leaseExpired(lease, now));
      // Prompts queued before the session ended (a browser send-and-end) must still reach the
      // agent, so deliver them before reporting the ended state; the next poll then sees ended.
      // Batches whose lease expired without an ack were taken by a poll that never got to act on
      // them, so they go out again ahead of anything queued since.
      const prompts = [...expired.flatMap((lease) => lease.prompts), ...(session.prompts || [])];
      // Layout warnings are NOT delivered here. Detection is passive: the user decides which
      // warnings become work by queueing them, and that arrives as an ordinary prompt above.
      // Only artifact failures - a review that cannot be used at all - still reach the agent
      // without user action.
      const artifactFailures = dedupeArtifactFailures([
        ...expired.flatMap((lease) => lease.artifact_failures),
        ...(Array.isArray(session.artifact_failures) ? session.artifact_failures : []),
      ]);
      const alreadyEnded = session.status === "ended";
      if (prompts.length === 0 && artifactFailures.length === 0) {
        if (alreadyEnded) return { status: "ended", ended_by: session.ended_by };
        const retryAfterMs = this.nextLeaseExpiryMs(live, now);
        return retryAfterMs === null ? { status: "waiting" } : { status: "waiting", retry_after_ms: retryAfterMs };
      }
      const domSnapshot = session.dom_snapshot || expired.at(-1)?.dom_snapshot || "";
      const lease = {
        delivery_id: crypto.randomUUID(),
        leased_at: new Date(now).toISOString(),
        prompts,
        dom_snapshot: domSnapshot,
        artifact_failures: artifactFailures,
      };
      const result = {
        status: "feedback",
        delivery_id: lease.delivery_id,
        dom_snapshot: domSnapshot,
        prompts,
        ...(artifactFailures.length > 0 ? { artifact_failures: artifactFailures } : {}),
        // This is the final delivery before the session shows as ended - flag it so the agent
        // knows not to expect (or force) a reopened browser afterward.
        ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by } : {}),
      };
      // The lease keeps these attachments referenced until it is retired; the grace list takes
      // over from there while the agent that acked is still opening the paths it received.
      const deliveredIds = new Set();
      for (const prompt of prompts) {
        for (const attachment of prompt.attachments || []) {
          if (attachment?.id) deliveredIds.add(attachment.id);
        }
      }
      const carried = (session.delivered_attachments || [])
        .filter(
          (entry) =>
            entry && entry.id && !deliveredIds.has(entry.id) && now - Number(entry.at) <= ATTACHMENT_DELIVERY_GRACE_MS,
        )
        .map((entry) => ({ id: entry.id, at: Number(entry.at) }))
        .sort((a, b) => a.at - b.at);
      const current = [...deliveredIds].map((id) => ({ id, at: now }));
      const historyRoom = Math.max(0, MAX_DELIVERED_ATTACHMENTS - current.length);
      session.delivered_attachments = [...carried.slice(-historyRoom), ...current];
      session.leases = [...live, lease];
      session.prompts = [];
      session.artifact_failures = [];
      session.pending_prompts = 0;
      session.dom_snapshot = "";
      if (!alreadyEnded) {
        session.status = "open";
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return result;
    });
  }

  // Retires one delivered batch. The CLI acks only after the batch is fully on stdout, so an
  // unacked lease always means the consumer never got to act on it.
  async ackFeedback(key, deliveryId) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const leases = normalizeLeases(session.leases);
      const remaining = leases.filter((lease) => lease.delivery_id !== deliveryId);
      const retired = remaining.length !== leases.length;
      if (retired) {
        session.leases = remaining;
        session.updated_at = new Date().toISOString();
        await this.writeState(state);
      }
      return { session, retired };
    });
  }

  leaseExpired(lease, now) {
    const leasedAt = Date.parse(lease.leased_at);
    return !Number.isFinite(leasedAt) || now - leasedAt >= this.feedbackLeaseTtlMs;
  }

  nextLeaseExpiryMs(leases, now) {
    if (leases.length === 0) return null;
    const soonest = Math.min(...leases.map((lease) => Date.parse(lease.leased_at) + this.feedbackLeaseTtlMs));
    return Math.max(0, soonest - now);
  }

  // `endedBy` distinguishes a human ending review from the browser chrome ("user") from an
  // agent explicitly closing the loop via `lavish-axi end` ("agent"). Only a user-initiated end
  // blocks a plain reopen - see `SessionStore` callers in server.js.
  async endSession(key, endedBy = "agent") {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const existingEndedBy = session.status === "ended" ? session.ended_by : undefined;
      const nextEndedBy = endedBy === "user" || existingEndedBy === "user" ? "user" : "agent";
      session.status = "ended";
      session.ended_by = nextEndedBy;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async addAgentReply(key, text) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const at = new Date().toISOString();
      session.chat = [...(session.chat || []), { role: "agent", text: String(text || ""), at }];
      session.chat_revision = normalizeRevision(session.chat_revision) + 1;
      // A reply means the agent acted on everything delivered so far, so every lease is retired
      // even when the poll that took it never acked.
      session.leases = [];
      session.updated_at = at;
      await this.writeState(state);
      return session;
    });
  }

  /**
   * Drop every session `shouldRemove` accepts and persist the rest. `bytesFreed` is how much
   * smaller the serialized state becomes. With `dryRun`, nothing is written.
   *
   * @param {(session: any) => Promise<boolean> | boolean} shouldRemove
   * @param {{ dryRun?: boolean }} [options]
   */
  async removeSessions(shouldRemove, { dryRun = false } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const before = serializedStateBytes(state);
      const removed = [];
      const kept = [];
      for (const [key, session] of Object.entries(state.sessions)) {
        if (await shouldRemove(session)) {
          removed.push(session);
          delete state.sessions[key];
        } else {
          kept.push(session);
        }
      }
      if (removed.length > 0 && !dryRun) await this.writeState(state);
      return { removed, kept, bytesFreed: before - serializedStateBytes(state) };
    });
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  runExclusive(operation) {
    return this.lock.runExclusive(operation);
  }

  // `key/id` strings for every attachment the sweeper and delete must not touch, across all
  // sessions: those on a pending prompt, those on a leased batch (live or expired, since an
  // expired lease is redelivered with the same resolved paths), and those delivered within the
  // read grace. This is a pure read and must NOT take `this.lock`: the server calls it from
  // inside `runExclusive`, so self-locking would deadlock; running it there keeps its snapshot
  // atomic with the subsequent disk delete.
  async referencedAttachmentIds({ now = this.now() } = {}) {
    const state = await this.readState();
    const referenced = new Set();
    for (const session of Object.values(state.sessions)) {
      const leasedPrompts = normalizeLeases(session.leases).flatMap((lease) => lease.prompts);
      for (const prompt of [...(session.prompts || []), ...leasedPrompts]) {
        for (const attachment of prompt?.attachments || []) {
          if (attachment && attachment.id) referenced.add(`${session.key}/${attachment.id}`);
        }
      }
      for (const delivered of session.delivered_attachments || []) {
        if (!delivered || !delivered.id) continue;
        if (now - Number(delivered.at) <= ATTACHMENT_DELIVERY_GRACE_MS) {
          referenced.add(`${session.key}/${delivered.id}`);
        }
      }
    }
    return referenced;
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {} };
      }
      throw error;
    }
  }

  // Write-then-rename so a crash mid-write leaves the previous state.json intact instead of a
  // truncated file that loses every session.
  async writeState(state) {
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, serializeState(state));
    await rename(temp, this.file);
  }
}

function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function serializedStateBytes(state) {
  return Buffer.byteLength(serializeState(state));
}

function normalizeLeases(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((lease) => lease && typeof lease === "object" && typeof lease.delivery_id === "string")
    .map((lease) => ({
      delivery_id: lease.delivery_id,
      leased_at: String(lease.leased_at || ""),
      prompts: Array.isArray(lease.prompts) ? lease.prompts : [],
      dom_snapshot: typeof lease.dom_snapshot === "string" ? lease.dom_snapshot : "",
      artifact_failures: Array.isArray(lease.artifact_failures) ? lease.artifact_failures : [],
    }));
}

function dedupeArtifactFailures(failures) {
  const seen = new Set();
  return failures.filter((failure) => {
    const id = `${failure?.kind}\u0000${failure?.detail}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export async function canonicalFile(file) {
  const absolute = path.resolve(file);
  return realpath(absolute);
}

// Session records outlive the artifacts they point at, so any path that only has to ADDRESS a
// record must stay resolvable after the HTML file is deleted. `canonicalFile` cannot: `realpath`
// throws ENOENT on a missing file, which strands the record - `end` can never close it and `poll`
// can never drain it, and it sits in the bare-command listing forever. Rebuild the canonical path
// from the deepest ancestor that still exists instead, so a deleted artifact hashes to the same
// session key `open` stored for it while the file was there. Commands that genuinely need the
// bytes (`open`, `export`) keep using the strict resolver.
export async function canonicalSessionFile(file) {
  try {
    return await canonicalFile(file);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return canonicalizeMissingFile(path.resolve(file));
  }
}

async function canonicalizeMissingFile(absolute) {
  const missingSegments = [];
  let current = absolute;
  for (;;) {
    const parent = path.dirname(current);
    missingSegments.unshift(path.basename(current));
    // dirname() is its own fixed point at the filesystem root, so nothing above it can resolve:
    // hand back the plain absolute path rather than looping.
    if (parent === current) return absolute;
    try {
      return path.join(await realpath(parent), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      current = parent;
    }
  }
}

// ENOTDIR means an ancestor exists but is a file, so the path below it cannot exist either -
// the same "nothing here to resolve" case as ENOENT.
function isMissingPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

// Returns `{ prompt, malformed }`: `malformed` is non-empty when the payload's
// `attachments` field exists but cannot be honored as written, which fails the
// whole batch rather than being normalized away (see queuePrompts).
function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  const promptId = normalizePromptId(prompt.prompt_id);
  if (promptId) normalized.prompt_id = promptId;
  const { refs, malformed } = normalizeAttachmentRefs(prompt.attachments);
  if (refs.length > 0) normalized.attachments = refs;
  return { prompt: normalized, malformed };
}

// Settlement identity is transcript-owned. The agent-facing prompt list must not carry it: poll
// output stays the reviewer's words, and a lease redelivery never touches the transcript.
function agentFacingPrompt(prompt) {
  if (!prompt || typeof prompt !== "object" || prompt.prompt_id === undefined) return prompt;
  const rest = { ...prompt };
  delete rest.prompt_id;
  return rest;
}

function layoutWarningPromptIds(prompt) {
  if (prompt?.tag !== "layout-warnings" || prompt.target?.type !== LAYOUT_WARNINGS_TARGET_TYPE) return null;
  return Array.isArray(prompt.target.warnings)
    ? prompt.target.warnings.map((warning) => String(warning?.id || "")).filter(Boolean)
    : [];
}

// Client-supplied attachment refs are stripped to just the fields the client is
// allowed to influence: the content-hash `id` and a display-only `name`. Path,
// mime, size, and dimensions are never taken from the payload (see queuePrompts).
//
// Anything that cannot be read as a ref is reported as `malformed` rather than
// skipped: dropping it here would let the POST succeed while the images the user
// attached never arrive, and the chrome would clear its queue believing they were
// delivered. An ABSENT field is not malformed - it just means no images.
function normalizeAttachmentRefs(value) {
  if (value === undefined) return { refs: [], malformed: [] };
  if (!Array.isArray(value)) return { refs: [], malformed: [{ id: "", name: "", reason: "malformed" }] };
  const refs = [];
  const malformed = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      malformed.push({ id: "", name: "", reason: "malformed" });
      continue;
    }
    const name = item.name === undefined || item.name === null ? "" : String(item.name).slice(0, 200);
    const id = String(item.id || "");
    if (!id) {
      malformed.push({ id: "", name, reason: "malformed" });
      continue;
    }
    refs.push(name ? { id, name } : { id });
  }
  return { refs, malformed };
}

// Rejections are reported back to the chrome, so the list must not itself become
// a payload amplifier for a crafted batch.
const MAX_REPORTED_ATTACHMENT_REJECTIONS = 4;

// The cheap gate that must run BEFORE `resolvePromptAttachments` touches the
// filesystem: every check here is pure arithmetic over the parsed payload.
//
// The per-prompt cap inside the resolver counts RESOLVED refs, which a crafted
// batch never advances - thousands of well-formed ids for files that don't exist
// each cost a sequential `stat` and the count stays at zero. Because the whole
// path runs under the store's single mutex, that stalls polling and every
// state mutation. Counting the RAW refs first bounds the work a caller can buy.
function boundAttachmentRefs(normalized, options) {
  const maxPerPrompt = Number.isFinite(options.maxPerPrompt) ? options.maxPerPrompt : Infinity;
  const malformed = normalized.flatMap((entry) => entry.malformed);
  if (malformed.length) return malformed;

  // Per-prompt first: it is the more specific diagnosis, and the chrome turns it
  // into actionable wording ("more than N images on one annotation"). A single
  // crafted prompt trips both caps, and that message is the useful one.
  const rejected = [];
  for (const { prompt } of normalized) {
    const refs = prompt.attachments || [];
    // One rejection per over-cap prompt, not one per crafted ref.
    if (refs.length > maxPerPrompt) {
      rejected.push({ id: refs[0]?.id || "", name: refs[0]?.name || "", reason: "too-many" });
    }
  }
  if (rejected.length) return rejected;

  let requestRefs = 0;
  for (const { prompt } of normalized) requestRefs += prompt.attachments?.length || 0;
  if (requestRefs > MAX_REQUEST_ATTACHMENT_REFS) {
    return [{ id: "", name: "", reason: "too-many-in-request" }];
  }
  return rejected;
}

// Replace each client ref with server-vetted metadata, enforcing the per-prompt
// count and total-byte caps. Returns `{ resolved, rejected }`: every ref that
// can't be honored (unknown id, over the count cap, or over the total-byte cap)
// is reported in `rejected` with a machine-readable `reason` rather than silently
// dropped, so the caller can fail the batch atomically. The display `name` is
// the only client value carried through (it never touches a filesystem path).
async function resolvePromptAttachments(refs, key, options = {}) {
  const { resolveAttachment, maxPerPrompt = Infinity, maxPromptBytes = Infinity } = options;
  if (!Array.isArray(refs) || refs.length === 0 || typeof resolveAttachment !== "function") {
    return { resolved: [], rejected: [] };
  }
  const resolved = [];
  const rejected = [];
  let totalBytes = 0;
  for (const ref of refs) {
    if (resolved.length >= maxPerPrompt) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "too-many" });
      continue;
    }
    const metadata = await resolveAttachment(key, ref.id);
    if (!metadata) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "not-found" });
      continue;
    }
    const bytes = Number(metadata.bytes) || 0;
    if (totalBytes + bytes > maxPromptBytes) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "prompt-bytes-exceeded" });
      continue;
    }
    totalBytes += bytes;
    resolved.push(ref.name ? { ...metadata, name: ref.name } : metadata);
  }
  return { resolved, rejected };
}

function planLayoutWarningPrompt(warnings, prompt, revision) {
  const warningIds = layoutWarningPromptIds(prompt);
  const hasRevision = Object.hasOwn(prompt.target || {}, "artifact_revision");
  const expectedRevision = hasRevision ? parseRevisionValue(prompt.target.artifact_revision) : null;
  const conflicts = [];
  const queueIds = [];
  let hadKnownWarning = false;

  for (const id of warningIds) {
    const warning = warnings.find((candidate) => candidate.id === id);
    if (!warning) continue;
    hadKnownWarning = true;
    const duplicate =
      warning.status === "queued" &&
      Boolean(warning.queued_at) &&
      expectedRevision !== null &&
      warning.queued_revision === expectedRevision;
    if (duplicate) continue;
    if (hasRevision && (expectedRevision === null || expectedRevision !== revision)) {
      conflicts.push(id);
      continue;
    }
    if (isSelectableLayoutWarning(warning)) queueIds.push(id);
    else if (hasRevision) conflicts.push(id);
  }

  return { warningIds, expectedRevision, conflicts, queueIds, hadKnownWarning };
}

// The active artifact load, in the shape state.json carries it. Snake-cased like every other
// stored field, and complete: the fences a begin is judged against (`request_id`,
// `request_sequence`, `handoff_token`) belong to the same epoch as the token, so a process that
// restored the token without them would answer a reviewer's retry with a new epoch, or let a
// begin the previous process already overtook win.
function serializeArtifactLoad(load) {
  return {
    artifact_load_token: load.artifactLoadToken,
    artifact_revision: load.artifactRevision,
    last_pass_sequence: load.lastPassSequence,
    request_id: load.requestId,
    request_sequence: load.requestSequence,
    handoff_token: load.handoffToken,
  };
}

// Every key `serializeArtifactLoad` writes. A record this code wrote always carries all six, so a
// record missing one was not written by this code and cannot be read as a whole.
const STORED_ARTIFACT_LOAD_FIELDS = [
  "artifact_load_token",
  "artifact_revision",
  "last_pass_sequence",
  "request_id",
  "request_sequence",
  "handoff_token",
];

// All of the epoch or none of it. Restoring a partial record would honor the token while some
// fence it travels with defaulted away: without `handoff_token` the load answers 200 to everyone
// while its own reviewer's next begin is told `no-handoff`, and without `request_sequence` a begin
// the previous process already overtook wins. So an older or hand-edited state.json degrades to
// the pre-persistence behaviour - one re-handshake and a fresh epoch - rather than admitting a
// load the store can only partly describe. Presence and type are what is checked, not value:
// `request_id` is legitimately "" and both sequence fences are legitimately 0 on a just-begun
// load. The revision is not: `beginArtifactLoad` only mints positive ones, so 0 is a value this
// code never wrote and a load restored with it would be served at a revision that never existed.
// The two tokens are additionally required non-empty, which rejects nothing this code wrote
// (`beginArtifactLoad` only mints non-empty ones) and is load-bearing for `artifact_load_token`:
// diagnostics compare their own token against it, so an empty restored token would be matched by
// a token-less pass.
function restoreArtifactLoad(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  if (STORED_ARTIFACT_LOAD_FIELDS.some((field) => !Object.hasOwn(stored, field))) return null;
  const artifactLoadToken = stored.artifact_load_token;
  const handoffToken = stored.handoff_token;
  const requestId = stored.request_id;
  if (typeof artifactLoadToken !== "string" || !artifactLoadToken) return null;
  if (typeof handoffToken !== "string" || !handoffToken) return null;
  if (typeof requestId !== "string") return null;
  const artifactRevision = parseSequenceValue(stored.artifact_revision);
  if (artifactRevision === 0) return null;
  const lastPassSequence = parseSequenceValue(stored.last_pass_sequence);
  const requestSequence = parseSequenceValue(stored.request_sequence);
  if (artifactRevision === null || lastPassSequence === null || requestSequence === null) return null;
  return { artifactRevision, artifactLoadToken, lastPassSequence, requestId, requestSequence, handoffToken };
}

function normalizeStoredArtifactLoad(stored) {
  const restored = restoreArtifactLoad(stored);
  return restored ? serializeArtifactLoad(restored) : null;
}

// Null rather than 0 for anything unreadable: 0 is a real sequence, so coercing to it would turn a
// corrupt fence into an open one.
function parseSequenceValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeRevision(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function parseRevisionValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function parseDiagnosticRevision(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const present = Object.hasOwn(source, "artifact_revision") || Object.hasOwn(source, "artifactRevision");
  if (!present) return { present: false, value: null };
  return { present: true, value: parseRevisionValue(source.artifact_revision ?? source.artifactRevision) };
}

function parsePassSequence(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const present = Object.hasOwn(source, "artifact_pass_sequence") || Object.hasOwn(source, "artifactPassSequence");
  const value = Number(source.artifact_pass_sequence ?? source.artifactPassSequence);
  return { present, value: Number.isSafeInteger(value) && value > 0 ? value : null };
}

const ARTIFACT_FAILURE_KINDS = new Set(["artifact-unavailable", "artifact-asset-unavailable"]);

function normalizeArtifactFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures
    .filter((failure) => failure && typeof failure === "object" && !Array.isArray(failure))
    .map((failure) => ({
      kind: String(failure.kind || ""),
      detail: String(failure.detail || "").slice(0, 300),
      severity: "fatal",
    }))
    .filter((failure) => ARTIFACT_FAILURE_KINDS.has(failure.kind))
    .slice(0, MAX_ARTIFACT_FAILURES);
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "mermaid-node") return normalizeMermaidNodeTarget(target);
  if (target.type === EXCALIDRAW_SCENE_TARGET_TYPE) return normalizeExcalidrawSceneTarget(target);
  if (target.type === LAYOUT_WARNINGS_TARGET_TYPE) return normalizeLayoutWarningsTarget(target);
  // text-range and any other/legacy target shapes pass through unchanged.
  return JSON.parse(JSON.stringify(target));
}
