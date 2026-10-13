import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";
import { serializeChatSync } from "../src/chat-messages.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-receipts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "artifact.html");
  const stateFile = path.join(dir, "state.json");
  await writeFile(file, "<p>Receipt test</p>");
  let now = Date.parse("2026-10-13T12:00:00Z");
  const options = { feedbackLeaseTtlMs: 1000, now: () => now };
  const store = new SessionStore(stateFile, options);
  const { key } = await store.upsertSession(file, "http://localhost/session/test");
  const queue = (text, extra = {}) => store.queuePrompts(key, { prompts: [{ prompt: text, ...extra }] });
  const chat = async () => serializeChatSync(await store.findByKey(key), now).chat;
  return { store, key, file, stateFile, options, queue, chat, advance: (ms) => (now += ms) };
}

test("receipts confirm only the acknowledged batch and hide transport identity", async (t) => {
  const f = await fixture(t);
  await f.queue("first");
  assert.deepEqual((await f.chat())[0].delivery_receipt, { state: "queued" });
  const first = await f.store.takeFeedback(f.key);
  assert.deepEqual(first.prompts, [{ uid: "", prompt: "first", selector: "", tag: "", text: "" }]);
  assert.deepEqual((await f.chat())[0].delivery_receipt, { state: "delivering", remaining_ms: 1000 });
  await f.queue("second", { prompt_id: "second-id" });
  const second = await f.store.takeFeedback(f.key);
  await f.store.ackFeedback(f.key, first.delivery_id);
  let chat = await f.chat();
  assert.equal(chat[0].delivery_receipt.state, "delivered");
  assert.equal(chat[0].delivery_receipt.delivered_at, "2026-10-13T12:00:00.000Z");
  assert.equal(chat[1].delivery_receipt.state, "delivering");
  assert.equal(JSON.stringify(chat).includes("delivery_id"), false);
  assert.equal(JSON.stringify(chat).includes('"receipt"'), false);
  await f.store.ackFeedback(f.key, second.delivery_id);
  chat = await f.chat();
  assert.equal(chat[1].delivery_receipt.state, "delivered");
});

test("expiry projects queued and stale ACK cannot confirm a newer attempt", async (t) => {
  const f = await fixture(t);
  await f.queue("first");
  const first = await f.store.takeFeedback(f.key);
  f.advance(1000);
  assert.deepEqual((await f.chat())[0].delivery_receipt, { state: "queued" });
  const second = await f.store.takeFeedback(f.key);
  assert.notEqual(first.delivery_id, second.delivery_id);
  assert.equal((await f.store.ackFeedback(f.key, first.delivery_id)).retired, false);
  assert.equal((await f.chat())[0].delivery_receipt.state, "delivering");
  await f.store.releaseFeedback(f.key, second.delivery_id);
  assert.deepEqual((await f.chat())[0].delivery_receipt, { state: "queued" });
  assert.equal((await f.store.ackFeedback(f.key, second.delivery_id)).retired, false);
  assert.equal((await f.chat())[0].delivery_receipt.state, "queued");
});

test("reply retires only leased receipts as unconfirmed including expired attempts", async (t) => {
  const f = await fixture(t);
  await f.queue("confirmed");
  const confirmed = await f.store.takeFeedback(f.key);
  await f.store.ackFeedback(f.key, confirmed.delivery_id);
  await f.queue("unconfirmed");
  const lease = await f.store.takeFeedback(f.key);
  f.advance(1001);
  await f.queue("pending");
  await f.store.addAgentReply(f.key, "Reply");
  const chat = await f.chat();
  assert.deepEqual(
    chat.slice(0, 3).map((entry) => entry.delivery_receipt.state),
    ["delivered", "unconfirmed", "queued"],
  );
  assert.equal((await f.store.ackFeedback(f.key, lease.delivery_id)).retired, false);
  assert.equal((await f.chat())[1].delivery_receipt.state, "unconfirmed");
});

test("restart and reopen preserve queued and leased identities", async (t) => {
  const f = await fixture(t);
  await f.queue("leased");
  const lease = await f.store.takeFeedback(f.key);
  await f.queue("pending");
  const restarted = new SessionStore(f.stateFile, f.options);
  await restarted.upsertSession(f.file, "http://localhost/reopened");
  await restarted.ackFeedback(f.key, lease.delivery_id);
  const second = await restarted.takeFeedback(f.key);
  await restarted.ackFeedback(f.key, second.delivery_id);
  assert.deepEqual(
    (await f.chat()).map((entry) => entry.delivery_receipt.state),
    ["delivered", "delivered"],
  );
});

test("legacy entries remain unknown alongside new receipts", async (t) => {
  const f = await fixture(t);
  const state = JSON.parse(await readFile(f.stateFile, "utf8"));
  state.sessions[f.key].chat = [{ role: "user", text: "legacy" }];
  state.sessions[f.key].prompts = [{ prompt: "legacy" }];
  await writeFile(f.stateFile, JSON.stringify(state));
  await f.queue("new");
  const delivery = await f.store.takeFeedback(f.key);
  assert.deepEqual(delivery.prompts, [
    { prompt: "legacy" },
    { uid: "", prompt: "new", selector: "", tag: "", text: "" },
  ]);
  await f.store.ackFeedback(f.key, delivery.delivery_id);
  const chat = await f.chat();
  assert.equal(chat[0].delivery_receipt, undefined);
  assert.equal(chat[1].delivery_receipt.state, "delivered");
});

test("end preserves receipts and Send & End final delivery can be acknowledged", async (t) => {
  const f = await fixture(t);
  await f.queue("leased");
  const lease = await f.store.takeFeedback(f.key);
  await f.store.endSession(f.key, "user");
  assert.equal((await f.chat())[0].delivery_receipt.state, "delivering");
  await f.store.addAgentReply(f.key, "rejected", { requireOpen: true });
  await f.store.ackFeedback(f.key, lease.delivery_id);
  assert.equal((await f.chat())[0].delivery_receipt.state, "delivered");
  await f.store.upsertSession(f.file, "http://localhost/reopened");
  await f.store.queuePrompts(f.key, { prompts: [{ prompt: "final" }], endSession: true });
  const final = await f.store.takeFeedback(f.key);
  assert.equal(final.session_ended, true);
  await f.store.ackFeedback(f.key, final.delivery_id);
  assert.equal((await f.chat())[1].delivery_receipt.state, "delivered");
});

test("dedup and transcript eviction do not shift receipt association", async (t) => {
  const f = await fixture(t);
  await f.queue("first", { prompt_id: "first-id" });
  await f.queue("first", { prompt_id: "first-id" });
  assert.equal((await f.chat()).length, 1);
  const first = await f.store.takeFeedback(f.key);
  const state = JSON.parse(await readFile(f.stateFile, "utf8"));
  state.sessions[f.key].chat = [];
  await writeFile(f.stateFile, JSON.stringify(state));
  await f.queue("new");
  await f.store.ackFeedback(f.key, first.delivery_id);
  assert.deepEqual((await f.chat())[0].delivery_receipt, { state: "queued" });
});

test("legacy lease redelivery never assigns receipt identity to legacy chat", async (t) => {
  const f = await fixture(t);
  const state = JSON.parse(await readFile(f.stateFile, "utf8"));
  state.sessions[f.key].chat = [{ role: "user", text: "legacy leased" }];
  state.sessions[f.key].leases = [
    { delivery_id: "legacy-delivery", leased_at: new Date(0).toISOString(), prompts: [{ prompt: "legacy leased" }] },
  ];
  await writeFile(f.stateFile, JSON.stringify(state));
  await f.queue("new");
  const batch = await f.store.takeFeedback(f.key);
  assert.deepEqual(
    batch.prompts.map((prompt) => prompt.prompt),
    ["legacy leased", "new"],
  );
  await f.store.ackFeedback(f.key, batch.delivery_id);
  const chat = await f.chat();
  assert.equal(chat[0].delivery_receipt, undefined);
  assert.equal(chat[1].delivery_receipt.state, "delivered");
});

test("late matching ACK after expiry confirms output until redelivery replaces it", async (t) => {
  const f = await fixture(t);
  await f.queue("delayed acknowledgement");
  const batch = await f.store.takeFeedback(f.key);
  f.advance(1001);
  assert.equal((await f.chat())[0].delivery_receipt.state, "queued");
  assert.equal((await f.store.ackFeedback(f.key, batch.delivery_id)).retired, true);
  assert.equal((await f.chat())[0].delivery_receipt.state, "delivered");
  assert.equal((await f.store.takeFeedback(f.key)).status, "waiting");
});

test("released attempt refuses ACK after restart and remains available for redelivery", async (t) => {
  const f = await fixture(t);
  await f.queue("retry me");
  const batch = await f.store.takeFeedback(f.key);
  await f.store.releaseFeedback(f.key, batch.delivery_id);
  const restarted = new SessionStore(f.stateFile, f.options);
  await restarted.upsertSession(f.file, "http://localhost/reopened");
  assert.equal((await restarted.ackFeedback(f.key, batch.delivery_id)).retired, false);
  assert.equal((await f.chat())[0].delivery_receipt.state, "queued");
  const next = await restarted.takeFeedback(f.key);
  assert.notEqual(next.delivery_id, batch.delivery_id);
  assert.equal((await restarted.ackFeedback(f.key, batch.delivery_id)).retired, false);
  assert.equal((await restarted.ackFeedback(f.key, next.delivery_id)).retired, true);
  assert.equal((await f.chat())[0].delivery_receipt.state, "delivered");
});

test("explicit reply retires a released attempt as unconfirmed", async (t) => {
  const f = await fixture(t);
  await f.queue("retry me");
  const batch = await f.store.takeFeedback(f.key);
  await f.store.releaseFeedback(f.key, batch.delivery_id);
  await f.store.addAgentReply(f.key, "Reply");
  assert.equal((await f.chat())[0].delivery_receipt.state, "unconfirmed");
  assert.equal((await f.store.takeFeedback(f.key)).status, "waiting");
  assert.equal((await f.store.ackFeedback(f.key, batch.delivery_id)).retired, false);
});
