import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalFile, canonicalSessionFile, SessionStore, sessionKey } from "../src/session-store.js";

let beginRequestSequence = 0;

async function beginArtifactLoad(store, key) {
  const context = await store.issueReviewerHandoff(key);
  const requestSequence = context.artifact_load_sequence + 1;
  const load = await store.beginArtifactLoad(key, {
    requestId: `test-load-${++beginRequestSequence}`,
    requestSequence,
    handoffToken: context.chrome_load_token,
  });
  assert.ok(load?.artifact_load_token);
  return load;
}

function diagnosticPayload(load, sequence, body = {}) {
  return {
    artifact_load_token: load.artifact_load_token,
    artifact_revision: load.artifact_revision,
    artifact_pass_sequence: sequence,
    ...body,
  };
}

function feedbackResult(result) {
  assert.equal(result.status, "feedback");
  return /** @type {{ status: string, delivery_id: string, dom_snapshot: string, prompts: any[], artifact_failures?: any[], session_ended?: boolean, ended_by?: string }} */ (
    result
  );
}

test("queued prompts are returned with DOM snapshot context and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" }],
    });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');
    assert.deepEqual(first.prompts, [
      { uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued text selection prompts preserve range anchors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<p id='intro'>Hello <strong>bright</strong> world</p>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "text-range",
      text: "lo bright wo",
      selector: "p#intro",
      start: { selector: "p#intro", path: [0], offset: 3 },
      end: { selector: "p#intro", path: [2], offset: 3 },
    };

    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(result.prompts, [
      { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued mermaid node prompts preserve node identity and drop unknown fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<div class='mermaid'>graph TD; A-->B;</div>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "mermaid-node",
      diagramId: "mermaid-7",
      nodeId: "flowchart-HomeAgentChat-3",
      label: "HomeAgentChat",
      selector: "svg#mermaid-7 > g > g.node",
      // A hostile/legacy field that must be stripped by the normalizer:
      injected: { nested: "should not survive" },
    };

    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "",
          prompt: "This is where the orphan happens",
          selector: target.selector,
          tag: "mermaid-node",
          text: target.label,
          target,
        },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.prompts.length, 1);
    assert.deepEqual(result.prompts[0].target, {
      type: "mermaid-node",
      diagramId: "mermaid-7",
      nodeId: "flowchart-HomeAgentChat-3",
      label: "HomeAgentChat",
      selector: "svg#mermaid-7 > g > g.node",
    });
    assert.equal(result.prompts[0].tag, "mermaid-node");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a diagnostic pass records warnings passively and never becomes agent feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const result = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [
          {
            selector: "html",
            kind: "page-horizontal-overflow",
            overflowPx: 24.5,
            viewportWidth: 720,
            severity: "error",
          },
        ],
      }),
    );

    assert.equal(result.changed, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].status, "open");
    assert.equal(result.warnings[0].active, true);
    assert.equal(result.warnings[0].selectable, true);
    // The whole point of the passive inbox: detection alone must not make poll return.
    const feedback = await store.takeFeedback(session.key);
    assert.equal(feedback.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a newer begun load invalidates an older diagnostic atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const newerContext = await store.issueReviewerHandoff(session.key);
    await Promise.all([
      store.beginArtifactLoad(session.key, {
        requestId: "newer-load",
        requestSequence: newerContext.artifact_load_sequence + 1,
        handoffToken: newerContext.chrome_load_token,
      }),
      store.recordLayoutDiagnostics(
        session.key,
        diagnosticPayload(load, 1, {
          complete: true,
          viewport_width: 1440,
          findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 24, severity: "error" }],
        }),
      ),
    ]);

    const updated = await store.findByKey(session.key);
    assert.equal(updated.artifact_revision, 2);
    assert.equal(updated.layout_warnings.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a retried begin request reuses the same load epoch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const context = await store.issueReviewerHandoff(session.key);
    const first = await store.beginArtifactLoad(session.key, {
      requestId: "request-1",
      requestSequence: 1,
      handoffToken: context.chrome_load_token,
    });
    const retry = await store.beginArtifactLoad(session.key, {
      requestId: "request-1",
      requestSequence: 1,
      handoffToken: context.chrome_load_token,
    });
    const next = await store.beginArtifactLoad(session.key, {
      requestId: "request-2",
      requestSequence: 2,
      handoffToken: context.chrome_load_token,
    });

    assert.equal(retry.artifact_revision, first.artifact_revision);
    assert.equal(retry.artifact_load_token, first.artifact_load_token);
    assert.equal(next.artifact_revision, first.artifact_revision + 1);
    assert.notEqual(next.artifact_load_token, first.artifact_load_token);

    const stale = await store.beginArtifactLoad(session.key, {
      requestId: "request-1",
      requestSequence: 1,
      handoffToken: context.chrome_load_token,
    });
    assert.equal(stale.stale, "out-of-order");
    assert.equal(stale.artifact_revision, next.artifact_revision);
    assert.equal(stale.artifact_load_token, next.artifact_load_token);
    assert.equal((await store.findByKey(session.key)).artifact_revision, next.artifact_revision);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reopening a session preserves the live reviewer handoff and artifact load", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const handoff = await store.issueReviewerHandoff(session.key);
    const load = await store.beginArtifactLoad(session.key, {
      requestId: "live-load",
      requestSequence: 1,
      handoffToken: handoff.chrome_load_token,
    });
    const before = await store.verifyArtifactLoad(session.key, load.artifact_load_token, load.artifact_revision);

    await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const after = await store.verifyArtifactLoad(session.key, load.artifact_load_token, load.artifact_revision);
    const next = await store.beginArtifactLoad(session.key, {
      requestId: "next-load",
      requestSequence: 2,
      handoffToken: handoff.chrome_load_token,
    });

    assert.equal(before.valid, true);
    assert.equal(after.valid, true);
    assert.equal(next.artifact_revision, load.artifact_revision + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("typed handoff outcomes separate superseded and no-handoff begins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const noHandoff = await store.beginArtifactLoad(session.key, {
      requestId: "missing",
      requestSequence: 1,
      handoffToken: "",
    });
    assert.equal(noHandoff.stale, "no-handoff");
    const unknownNoHandoff = await store.beginArtifactLoad(session.key, {
      requestId: "unknown",
      requestSequence: 1,
      handoffToken: "unknown",
    });
    assert.equal(unknownNoHandoff.stale, "no-handoff");

    const firstHandoff = await store.issueReviewerHandoff(session.key);
    const firstLoad = await store.beginArtifactLoad(session.key, {
      requestId: "first",
      requestSequence: 1,
      handoffToken: firstHandoff.chrome_load_token,
    });
    const secondHandoff = await store.issueReviewerHandoff(session.key);
    const superseded = await store.beginArtifactLoad(session.key, {
      requestId: "old",
      requestSequence: 2,
      handoffToken: firstHandoff.chrome_load_token,
    });
    const current = await store.beginArtifactLoad(session.key, {
      requestId: "current",
      requestSequence: secondHandoff.artifact_load_sequence + 1,
      handoffToken: secondHandoff.chrome_load_token,
    });

    assert.equal(firstLoad.artifact_revision, 1);
    assert.equal(superseded.stale, "superseded");
    assert.equal(current.artifact_revision, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-severe observations never enter the inbox", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const result = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [
          {
            selector: ".accent",
            kind: "element-parent-overflow",
            overflowPx: 20,
            viewportWidth: 720,
            severity: "warning",
          },
          { selector: ".unproven", kind: "clipped-text", overflowPx: 200, viewportWidth: 720 },
        ],
      }),
    );

    assert.equal(result.warnings.length, 0);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queueing a warning produces one ordinary prompt and leaves the warning unresolved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 1440,
        findings: [
          { selector: "button", kind: "clipped-control", axis: "horizontal", overflowPx: 20, severity: "error" },
          { selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 27, severity: "error" },
        ],
      }),
    );
    const [first, second] = recorded.warnings;

    const queued = await store.prepareLayoutWarningFixes(session.key, [first.id]);
    assert.equal(queued.queued.length, 1);
    assert.match(queued.prompt.prompt, /Fix this layout issue/);
    assert.equal(queued.prompt.target.type, "layout-warnings");
    assert.equal(queued.prompt.target.warnings[0].id, first.id);

    const prepared = queued.warnings.find((warning) => warning.id === first.id);
    assert.equal(prepared.status, "open");
    assert.equal(prepared.selectable, true);
    assert.equal(queued.warnings.find((warning) => warning.id === second.id).status, "open");
    await store.queuePrompts(session.key, { prompts: [{ ...queued.prompt, uid: "", tag: "layout-warnings" }] });
    const after = (await store.listLayoutWarnings(session.key)).warnings.find((warning) => warning.id === first.id);
    assert.equal(after.status, "queued");
    assert.equal(after.active, true);
    assert.equal(after.selectable, false);
    assert.equal(after.outstanding, true);
    const retry = await store.queuePrompts(session.key, {
      prompts: [{ ...queued.prompt, uid: "", tag: "layout-warnings" }],
    });
    assert.equal(retry.conflict, undefined);
    assert.equal(retry.prompts.length, 1);
    const feedback = await store.takeFeedback(session.key);
    assert.equal(feedback.status, "feedback");
    assert.equal(feedback.prompts[0].tag, "layout-warnings");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a prepared layout prompt conflicts when its warning changes before sending", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const firstLoad = await beginArtifactLoad(store, session.key);
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 1, {
        complete: true,
        viewport_width: 1440,
        findings: [{ selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 27, severity: "error" }],
      }),
    );
    const prepared = await store.prepareLayoutWarningFixes(session.key, [recorded.warnings[0].id]);

    const secondLoad = await beginArtifactLoad(store, session.key);
    const resolved = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(secondLoad, 1, {
        complete: true,
        target_presence_complete: true,
        viewport_width: 1440,
        findings: [],
      }),
    );
    assert.equal(resolved.warnings[0].status, "resolved");

    const conflict = await store.queuePrompts(session.key, {
      prompts: [{ ...prepared.prompt, uid: "", selector: "", tag: "layout-warnings" }],
    });
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.warning_ids, [recorded.warnings[0].id]);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale diagnostic pass cannot mutate the current revision", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const firstLoad = await beginArtifactLoad(store, session.key);
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 1, {
        complete: true,
        viewport_width: 1440,
        findings: [{ selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 27, severity: "error" }],
      }),
    );

    const secondLoad = await beginArtifactLoad(store, session.key);
    const stale = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(secondLoad, 1, {
        artifact_load_token: firstLoad.artifact_load_token,
        artifact_revision: firstLoad.artifact_revision,
        complete: true,
        viewport_width: 1440,
        findings: [],
      }),
    );
    assert.equal(stale.stale, true);
    assert.equal(stale.warnings[0].status, "open");
    assert.equal(stale.warnings[0].last_seen_revision, 1);
    assert.equal(recorded.warnings[0].id, stale.warnings[0].id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a queued layout-warnings prompt is normalized like ordinary feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "",
          prompt: "Fix these layout issues",
          selector: "",
          tag: "layout-warnings",
          text: "Layout issues: 1 selected",
          target: {
            type: "layout-warnings",
            warnings: [{ id: "abc", rule: "clipped-text", selector: "p", axis: "vertical", overflow_px: 27 }],
          },
        },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].tag, "layout-warnings");
    assert.equal(result.prompts[0].target.warnings[0].id, "abc");
    assert.equal("artifact_failures" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the inbox survives reopening the same artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 24, severity: "error" }],
      }),
    );

    const reopened = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    assert.equal(reopened.status, "open");
    assert.equal(reopened.layout_warnings.length, 1);
    assert.equal((await store.listLayoutWarnings(session.key)).warnings[0].status, "open");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dismissing a warning lasts only for the current artifact revision", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const firstLoad = await beginArtifactLoad(store, session.key);
    const finding = { selector: "html", kind: "page-horizontal-overflow", overflowPx: 40, severity: "error" };
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 1, {
        complete: true,
        viewport_width: 720,
        findings: [finding],
      }),
    );
    const id = recorded.warnings[0].id;

    const dismissed = await store.dismissLayoutWarning(session.key, id);
    assert.equal(dismissed.warnings[0].status, "dismissed");
    assert.equal(dismissed.warnings[0].active, false);

    // Same revision: still dismissed even though the pass keeps seeing it.
    const sameRevision = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 2, {
        complete: true,
        viewport_width: 720,
        findings: [finding],
      }),
    );
    assert.equal(sameRevision.warnings[0].status, "dismissed");

    const secondLoad = await beginArtifactLoad(store, session.key);
    const laterRevision = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(secondLoad, 1, {
        complete: true,
        viewport_width: 720,
        findings: [finding],
      }),
    );
    assert.equal(laterRevision.warnings[0].status, "open");
    assert.equal(laterRevision.warnings[0].active, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fatal artifact failures still reach the agent without user action", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const result = await store.recordArtifactFailures(session.key, {
      ...diagnosticPayload(load, 1),
      failures: [
        { kind: "artifact-asset-unavailable", detail: "<img> could not load /artifact/x/logo.png" },
        { kind: "not-a-real-kind", detail: "ignored" },
      ],
    });
    assert.equal(result.changed, true);

    const feedback = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(feedback.artifact_failures.length, 1);
    assert.equal(feedback.artifact_failures[0].severity, "fatal");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale artifact failures and duplicate diagnostic sequences have no side effects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const finding = { selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 20, severity: "error" };
    const first = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        target_presence_complete: true,
        viewport_width: 1440,
        findings: [finding],
      }),
    );
    const duplicate = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        target_presence_complete: true,
        viewport_width: 1440,
        findings: [],
      }),
    );
    assert.equal(first.changed, true);
    assert.equal(duplicate.stale, true);
    assert.equal(duplicate.warnings[0].status, "open");

    const staleFailure = await store.recordArtifactFailures(session.key, {
      failures: [{ kind: "artifact-asset-unavailable", detail: "missing token" }],
    });
    assert.equal(staleFailure.stale, true);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session makes feedback return ended", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);

    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session defaults to agent-initiated and takeFeedback reports who ended it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const ended = await store.endSession(session.key);

    assert.equal(ended.ended_by, "agent");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "agent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session as the user is recorded distinctly from an agent end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const ended = await store.endSession(session.key, "user");

    assert.equal(ended.ended_by, "user");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent cleanup cannot overwrite an existing user end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key, "user");
    const ended = await store.endSession(session.key, "agent");

    assert.equal(ended.ended_by, "user");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the final feedback batch before an end flags session_ended with who ended it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // Browser send-and-end: prompts land first, then the session ends before delivery.
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });
    await store.endSession(session.key, "user");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued prompts can atomically carry a browser end intent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      endSession: true,
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");
    assert.equal(first.prompts.length, 1);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late prompts after a user end preserve the ended session state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key, "user");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Late feedback", selector: "", tag: "message", text: "Freeform message" }],
    });

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");
    assert.equal(updated.ended_by, "user");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");
    assert.equal(first.prompts[0].prompt, "Late feedback");

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late layout diagnostics do not reopen ended sessions or become feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);
    const load = await beginArtifactLoad(store, session.key);
    await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 24, severity: "error" }],
      }),
    );

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");
    assert.equal((await store.takeFeedback(session.key)).status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompts queued before ending are still delivered before the ended status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // Browser send-and-end with no agent listening: prompts land first, then the session ends.
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });
    await store.endSession(session.key);

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.prompts.length, 1);
    assert.equal(first.prompts[0].prompt, "Parting feedback");
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');

    // Delivering the final batch must not resurrect the session.
    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent replies are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.addAgentReply(session.key, "Applied the requested changes.");

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["agent", "Applied the requested changes."]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("freeform user prompts are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Please make this clearer", selector: "", tag: "message", text: "Freeform message" },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["user", "Please make this clearer"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent queue and layout-diagnostic writes do not drop queued feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);

    // Reproduces the send-message race: a POST /prompts (queued annotation + freeform message)
    // overlapping a POST /layout-diagnostics triggered by the same snapshot/render cycle. Without
    // `runExclusive` serializing the store's read-modify-write over state.json, the diagnostic
    // write reads a pre-queue snapshot and, on an unlucky interleave, clobbers session.prompts
    // back to [] - silently dropping the user's feedback. Detection is passive now, but it still
    // writes to the same file as the queue, so the lost-update race is unchanged.
    await Promise.all([
      store.queuePrompts(session.key, {
        domSnapshot: 'uid=1 h1 "Hello"',
        prompts: [
          { uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
          { uid: "", prompt: "Also ship it", selector: "", tag: "message", text: "Freeform message" },
        ],
      }),
      store.recordLayoutDiagnostics(
        session.key,
        diagnosticPayload(load, 1, {
          complete: true,
          viewport_width: 390,
          findings: [{ selector: "h1", kind: "text-overflow", severity: "error", overflowPx: 12, viewportWidth: 390 }],
        }),
      ),
    ]);

    const delivered = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(
      delivered.prompts.map((prompt) => prompt.prompt),
      ["Make this warmer", "Also ship it"],
    );
    // The diagnostic write must survive too: neither side of the race may be lost.
    const updated = await store.findByKey(session.key);
    assert.equal(updated.layout_warnings.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session stays addressable by path after its artifact file is deleted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");
    const whileOnDisk = await canonicalSessionFile(artifact);
    assert.equal(whileOnDisk, await canonicalFile(artifact));

    await rm(artifact);

    // The record outlives the file it points at, so the key `open` stored has to stay computable
    // once the artifact is gone - otherwise `end` can never close the session and `poll` can never
    // drain it, and it sits in the bare-command listing forever.
    assert.equal(await canonicalSessionFile(artifact), whileOnDisk);
    assert.equal(sessionKey(await canonicalSessionFile(artifact)), sessionKey(whileOnDisk));
    // The strict resolver stays strict: commands that need the artifact's bytes still fail loudly.
    await assert.rejects(() => canonicalFile(artifact), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a deleted artifact resolves through symlinked and deleted ancestor directories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    // Mirrors the real shape of the bug: an artifact under a `.lavish` directory reached through a
    // symlinked parent, where the whole directory - not just the HTML file - has been removed.
    const realRoot = path.join(dir, "real");
    const linkRoot = path.join(dir, "link");
    const artifactDir = path.join(realRoot, ".lavish");
    await mkdir(artifactDir, { recursive: true });
    await symlink(realRoot, linkRoot, "dir");
    const artifact = path.join(realRoot, ".lavish", "artifact.html");
    const throughSymlink = path.join(linkRoot, ".lavish", "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");
    const stored = await canonicalSessionFile(throughSymlink);
    assert.equal(stored, await canonicalFile(artifact));

    await rm(artifactDir, { recursive: true });

    assert.equal(await canonicalSessionFile(throughSymlink), stored);
    assert.equal(await canonicalSessionFile(artifact), stored);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function leaseFixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  const stateFile = path.join(dir, "state.json");
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<h1>Hello</h1>");
  let clock = 1_000_000;
  const store = new SessionStore(stateFile, { feedbackLeaseTtlMs: 60_000, now: () => clock, ...options });
  const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
  return {
    dir,
    stateFile,
    store,
    session,
    advance(ms) {
      clock += ms;
    },
  };
}

const notePrompt = { uid: "", prompt: "important note", selector: "", tag: "message", text: "Freeform message" };

test("taken feedback stays leased and is delivered again once the lease expires unacked", async () => {
  const { dir, store, session, advance } = await leaseFixture();
  try {
    await store.queuePrompts(session.key, { domSnapshot: "snap", prompts: [notePrompt] });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.ok(first.delivery_id);
    assert.equal(first.prompts[0].prompt, "important note");

    // Inside the lease window the batch belongs to the poll that took it.
    advance(30_000);
    const inFlight = await store.takeFeedback(session.key);
    assert.equal(inFlight.status, "waiting");
    assert.equal(inFlight.retry_after_ms, 30_000);

    // Nobody acked: the poll died. The next poll gets the same prompts under a new lease.
    advance(30_000);
    const redelivered = feedbackResult(await store.takeFeedback(session.key));
    assert.notEqual(redelivered.delivery_id, first.delivery_id);
    assert.deepEqual(redelivered.prompts, first.prompts);
    assert.equal(redelivered.dom_snapshot, "snap");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acking a delivery retires its lease so the batch is never delivered again", async () => {
  const { dir, store, session, advance } = await leaseFixture();
  try {
    await store.queuePrompts(session.key, { prompts: [notePrompt] });
    const first = feedbackResult(await store.takeFeedback(session.key));

    const ack = await store.ackFeedback(session.key, first.delivery_id);
    assert.equal(ack.retired, true);
    assert.equal((await store.ackFeedback(session.key, first.delivery_id)).retired, false);
    assert.equal((await store.ackFeedback(session.key, "unknown")).retired, false);
    assert.equal(await store.ackFeedback("missing-session", first.delivery_id), null);

    advance(120_000);
    const after = await store.takeFeedback(session.key);
    assert.equal(after.status, "waiting");
    assert.equal(after.retry_after_ms, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompts queued during a lease are delivered ahead of the lease expiring", async () => {
  const { dir, store, session, advance } = await leaseFixture();
  try {
    await store.queuePrompts(session.key, { prompts: [notePrompt] });
    const first = feedbackResult(await store.takeFeedback(session.key));
    await store.queuePrompts(session.key, { prompts: [{ ...notePrompt, prompt: "second" }] });

    const second = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(
      second.prompts.map((prompt) => prompt.prompt),
      ["second"],
    );

    // Both leases expire: the redelivery keeps the original order.
    advance(60_000);
    const redelivered = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(
      redelivered.prompts.map((prompt) => prompt.prompt),
      ["important note", "second"],
    );
    assert.notEqual(redelivered.delivery_id, first.delivery_id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an agent reply retires every outstanding lease", async () => {
  const { dir, store, session, advance } = await leaseFixture();
  try {
    await store.queuePrompts(session.key, { prompts: [notePrompt] });
    feedbackResult(await store.takeFeedback(session.key));

    await store.addAgentReply(session.key, "Done, take a look");

    advance(120_000);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an ended session delivers its final batch under a lease and reports ended once acked", async () => {
  const { dir, store, session, advance } = await leaseFixture();
  try {
    await store.queuePrompts(session.key, { prompts: [notePrompt] });
    await store.endSession(session.key, "user");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");

    // In flight: the session reads as ended, the batch is not duplicated.
    assert.equal((await store.takeFeedback(session.key)).status, "ended");

    // The poll that took it died: the final batch comes back after the lease expires.
    advance(60_000);
    const redelivered = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(redelivered.session_ended, true);
    assert.deepEqual(redelivered.prompts, first.prompts);

    await store.ackFeedback(session.key, redelivered.delivery_id);
    advance(60_000);
    const final = await store.takeFeedback(session.key);
    assert.equal(final.status, "ended");
    assert.equal(final.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reopening a session keeps its outstanding leases", async () => {
  const { dir, store, session, advance } = await leaseFixture();
  try {
    await store.queuePrompts(session.key, { prompts: [notePrompt] });
    feedbackResult(await store.takeFeedback(session.key));

    await store.upsertSession(session.file, session.url);

    advance(60_000);
    const redelivered = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(redelivered.prompts[0].prompt, "important note");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a state file written before leases existed still loads and delivers its prompts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");
    const key = sessionKey(await canonicalFile(artifact));
    await writeFile(
      stateFile,
      JSON.stringify({
        sessions: {
          [key]: {
            key,
            file: await canonicalFile(artifact),
            url: "http://localhost:4387/session/old",
            status: "feedback",
            pending_prompts: 1,
            prompts: [notePrompt],
            dom_snapshot: "legacy snapshot",
            chat: [],
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const store = new SessionStore(stateFile);
    const result = feedbackResult(await store.takeFeedback(key));
    assert.deepEqual(result.prompts, [notePrompt]);
    assert.equal(result.dom_snapshot, "legacy snapshot");
    assert.ok(result.delivery_id);
    assert.equal((await store.takeFeedback(key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state is written through a temp file and renamed into place", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");
    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, { prompts: [notePrompt] });

    const before = await readFile(stateFile, "utf8");
    assert.equal(JSON.parse(before).sessions[session.key].prompts.length, 1);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      [],
    );

    // A write that cannot complete must leave the previous state.json untouched rather than a
    // truncated file: the temp file fails to be created, so nothing ever touches state.json.
    // Windows ignores directory mode bits, so the failure cannot be forced there.
    if (process.platform !== "win32") {
      await chmod(dir, 0o500);
      try {
        await assert.rejects(store.queuePrompts(session.key, { prompts: [notePrompt] }));
      } finally {
        await chmod(dir, 0o700);
      }
      assert.equal(await readFile(stateFile, "utf8"), before);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
