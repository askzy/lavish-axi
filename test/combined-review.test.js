import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalFile, sessionKey } from "../src/session-store.js";
import { nativeReviewHarness, openCommand, VERSION } from "../src/cli.js";
import { setTimeout as delay } from "node:timers/promises";
import { readReviewAttempt } from "../src/review-attempts.js";
import { serve } from "../src/server.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

test("review readiness owns the listener without leasing startup feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-review-"));
  const file = path.join(dir, "review.html");
  await writeFile(file, "<!doctype html><h1>Review</h1>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json") });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (url, body) =>
    fetch(base + url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });
  const controller = new AbortController();
  try {
    const attemptId = randomUUID();
    const session = await (await post("/api/sessions", { file, reviewAttempt: attemptId })).json();
    await post(`/api/${session.key}/prompts`, {
      prompts: [{ uid: "startup", prompt: "Startup feedback", selector: "h1", tag: "h1", text: "Review" }],
    });
    const response = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&reviewAttempt=${attemptId}`, {
      signal: controller.signal,
    });
    assert.equal(response.headers.get("x-lavish-review-attempt"), attemptId);
    const conflict = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=50`);
    assert.equal(conflict.status, 409);
    const health = await (await fetch(base + "/health")).json();
    assert.equal(health.listeners.length, 1);
    const drained = await (await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`)).json();
    assert.equal(drained.prompts[0].prompt, "Startup feedback");
    await post(`/api/${session.key}/ack`, { delivery_id: drained.delivery_id });
    assert.equal((await post(`/api/poll/${attemptId}/ready`, {})).status, 200);
    await post(`/api/${session.key}/prompts`, {
      prompts: [{ uid: "after", prompt: "After readiness", selector: "h1", tag: "h1", text: "Review" }],
    });
    const delivered = await response.json();
    assert.equal(delivered.prompts[0].prompt, "After readiness");
    const record = readReviewAttempt(path.join(dir, "state.json"), attemptId);
    assert.ok(record.listenerStartedAt);
    assert.ok(record.finishedAt);
    assert.equal(record.outcome, "feedback");
  } finally {
    controller.abort();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("combined open confirms ownership before browser launch and refuses a competing open", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-combined-"));
  const file = path.join(dir, "review.html");
  await writeFile(file, "<!doctype html><h1>Review</h1>");
  const stateFile = path.join(dir, "state.json");
  const server = await serve({ port: 0, stateFile, version: VERSION });
  const base = `http://127.0.0.1:${server.port}`;
  const priorEnv = { ...process.env };
  Object.assign(process.env, {
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_NO_OPEN: "0",
    CODEX_THREAD_ID: "test-native-thread",
  });
  let opened = 0;
  let callbackError = null;
  const key = sessionKey(await canonicalFile(file));
  try {
    const result = await openCommand([file], {
      openBrowser: async () => {
        opened++;
        try {
          const health = await (await fetch(base + "/health")).json();
          assert.equal(health.listeners.length, 1);
          await assert.rejects(
            openCommand([file], {
              openBrowser: async () => {
                opened++;
              },
            }),
            (error) => error instanceof Error && "code" in error && error.code === "LISTENER_ACTIVE",
          );
        } catch (error) {
          callbackError = error;
        }
        const response = await fetch(`${base}/api/${key}/prompts`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify({
            prompts: [
              { uid: "callback", prompt: "Sent during browser launch", selector: "h1", tag: "h1", text: "Review" },
            ],
          }),
        });
        assert.equal(response.status, 200);
      },
    });
    if (callbackError) throw callbackError;
    assert.equal(opened, 1);
    assert.equal(result.session.status, "feedback");
    assert.ok("prompts" in result);
    assert.equal(result.prompts[0].prompt, "Sent during browser launch");
    const viewed = await openCommand([file, "--view-only"], {
      openBrowser: async () => {
        opened++;
      },
    });
    assert.equal(viewed.session.status, "view-only");
    assert.equal((await (await fetch(base + "/health")).json()).listeners.length, 0);
    const waiting = openCommand([file, "--no-open"], {
      openBrowser: async () => {
        opened++;
      },
    });
    for (let i = 0; i < 100; i++) {
      if ((await (await fetch(base + "/health")).json()).listeners.length) break;
      await delay(5);
    }
    assert.equal((await (await fetch(base + "/health")).json()).listeners.length, 1);
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [{ uid: "no-open", prompt: "No open still listens", selector: "h1", tag: "h1", text: "Review" }],
      }),
    });
    const received = await waiting;
    assert.ok("prompts" in received);
    assert.equal(received.prompts[0].prompt, "No open still listens");
    assert.equal(opened, 2);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in priorEnv)) delete process.env[name];
    Object.assign(process.env, priorEnv);
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("native Claude identity takes precedence over inherited Codex identity", () => {
  assert.deepEqual(nativeReviewHarness({ CLAUDE_CODE_SESSION_ID: "claude", CODEX_THREAD_ID: "outer-codex" }), {
    name: "claude",
    sessionId: "claude",
  });
  assert.deepEqual(nativeReviewHarness({ CODEX_THREAD_ID: "codex" }), { name: "codex", sessionId: "codex" });
  assert.equal(nativeReviewHarness({}), null);
});
