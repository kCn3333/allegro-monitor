import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { tokenHash } from "../src/security.js";
import { presenceAckResources } from "./helpers/presence-ack-resources.js";

async function fixture(t: TestContext) {
  const { store, startApp } = presenceAckResources(t, "allegro-ack-validation-");
  const monitor = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  const a = store.addExtensionClient("A", tokenHash("a"));
  const b = store.addExtensionClient("B", tokenHash("b"));
  store.touchExtensionClient(tokenHash("a"));
  store.touchExtensionClient(tokenHash("b"));
  store.saveCheck(store.getMonitor(monitor)!, []);
  store.saveCheck(store.getMonitor(monitor)!, [
    {
      externalId: "offer:100001",
      title: "Book",
      url: "https://allegro.pl/oferta/book-100001",
      imageUrl: null,
      price: "10 zł",
    },
  ]);
  const batchA = store.notificationBatch(a);
  const batchB = store.notificationBatch(b);
  assert.equal(batchA.events.length, 1);
  assert.equal(batchB.events.length, 1);
  const { app, db } = await startApp();
  const ack = (payload: unknown, token = "a") =>
    app.inject({
      method: "POST",
      url: "/api/extension/notifications/ack",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  const snapshot = () => ({
    clients: db
      .prepare("SELECT * FROM extension_clients ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    batches: db.prepare("SELECT * FROM notification_batches ORDER BY client_id").all(),
  });
  return { app, ack, db, snapshot, a, b, batchA, batchB };
}

const invalidPayloads = [
  null,
  [],
  false,
  1,
  "text",
  {},
  ...[null, 1, true, [], {}, "x".repeat(101), "📚".repeat(50) + "x", "📚".repeat(51)].map((batchId) => ({ batchId })),
];

test("ACK schema rejects missing and invalid batchId without moving cursors or deleting batches", async (t) => {
  const { ack, snapshot } = await fixture(t);
  const before = snapshot();
  for (const payload of invalidPayloads) {
    const response = await ack(payload);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "Nieprawidłowy ACK" });
    assert.match(response.headers["content-type"]!, /application\/json/);
    assert.deepEqual(snapshot(), before);
  }
});

test("ACK accepts empty, opaque and UTF-16 boundary strings without altering unknown fields", async (t) => {
  const { ack, app, snapshot } = await fixture(t);
  let observed: unknown;
  app.addHook("preHandler", async (request) => {
    observed = structuredClone(request.body);
  });
  const before = snapshot();
  for (const batchId of [
    "",
    " ",
    "not-a-uuid",
    "x".repeat(99),
    "x".repeat(100),
    "📚".repeat(49) + "x",
    "📚".repeat(50),
  ]) {
    const payload = { batchId, unknown: { keep: [true, null, "text"] }, throughId: 999999 };
    const response = await ack(payload);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { acknowledged: false });
    assert.deepEqual(observed, payload, "no trimming, coercion, defaults or removal of fields");
    assert.deepEqual(snapshot(), before);
  }
});

test("ACK authenticates parsed JSON before schema errors without coercing invalid batchId types", async (t) => {
  const { ack, snapshot } = await fixture(t);
  const before = snapshot();
  for (const payload of [...invalidPayloads, { batchId: "" }]) {
    for (const token of ["", "wrong"]) {
      const response = await ack(payload, token);
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: "Nieprawidłowy token rozszerzenia" });
      assert.deepEqual(snapshot(), before);
    }
  }
});

test("ACK parser errors match presence locally and preserve pending batches and cursors", async (t) => {
  const { app, snapshot } = await fixture(t);
  const before = snapshot();
  for (const token of ["a", "wrong"]) {
    for (const [payload, status, message] of [
      ["", 400, "Nieprawidłowy JSON"],
      ['{"batchId": SECRET', 400, "Nieprawidłowy JSON"],
      [JSON.stringify({ batchId: "", extra: "x".repeat(256000) }), 413, "Zbyt duże żądanie"],
    ] as const) {
      for (const url of ["/api/extension/notifications/ack", "/api/extension/presence"]) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          payload,
        });
        assert.equal(response.statusCode, status);
        assert.deepEqual(response.json(), { error: message });
        assert.deepEqual(snapshot(), before);
      }
    }
  }
  const base = JSON.stringify({ batchId: "", extra: "" });
  const response = await app.inject({
    method: "POST",
    url: "/api/extension/notifications/ack",
    headers: { authorization: "Bearer a", "content-type": "application/json" },
    payload: JSON.stringify({ batchId: "", extra: "x".repeat(256000 - Buffer.byteLength(base)) }),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { acknowledged: false });
  assert.deepEqual(snapshot(), before);
});

test("ACK preserves client ownership, exact IDs, success and repeated-ACK cursor semantics", async (t) => {
  const { ack, snapshot, db, a, b, batchA, batchB } = await fixture(t);
  const before = snapshot();
  for (const [batchId, token] of [
    [batchA.batchId, "b"],
    [batchB.batchId, "a"],
    [` ${batchA.batchId} `, "a"],
    ["unknown", "a"],
  ]) {
    const response = await ack({ batchId }, token);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { acknowledged: false });
    assert.deepEqual(snapshot(), before);
  }
  const throughA = (
    db.prepare("SELECT through_id FROM notification_batches WHERE client_id=?").get(a) as { through_id: number }
  ).through_id;
  const success = await ack({ batchId: batchA.batchId, throughId: 999999, ignored: true });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), { acknowledged: true });
  const after = snapshot();
  assert.deepEqual(
    after.clients,
    before.clients.map((client) => (client.id === a ? { ...client, last_notification_event_id: throughA } : client)),
  );
  assert.deepEqual(
    after.batches,
    before.batches.filter((batch) => batch.client_id !== a),
  );
  for (const token of ["a", "b"]) {
    const response = await ack({ batchId: batchA.batchId }, token);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { acknowledged: false });
    assert.deepEqual(snapshot(), after);
  }
  // Opaque non-UUID and empty IDs are passed through unchanged to persistence.
  for (const batchId of ["not-a-uuid 📚", ""]) {
    db.prepare("UPDATE notification_batches SET batch_id=? WHERE client_id=?").run(batchId, b);
    const response = await ack({ batchId }, "b");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { acknowledged: true });
    if (batchId !== "")
      db.prepare(
        "INSERT INTO notification_batches(client_id,batch_id,through_id,events,created_at) VALUES(?,?,?,?,?)",
      ).run(b, "next", throughA, "[]", new Date(1800000000000).toISOString());
  }
  assert.equal(snapshot().batches.length, 0);
});
