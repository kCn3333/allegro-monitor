import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { tokenHash } from "../src/security.js";
import { presenceAckResources } from "./helpers/presence-ack-resources.js";

async function fixture(t: TestContext) {
  const { store, startApp } = presenceAckResources(t, "allegro-presence-validation-");
  const monitor = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  const client = store.addExtensionClient("Device", tokenHash("test-token"));
  store.touchExtensionClient(tokenHash("test-token"));
  const { app, db } = await startApp();
  const presence = (payload: unknown, token = "test-token") =>
    app.inject({
      method: "POST",
      url: "/api/extension/presence",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  const snapshot = () =>
    [
      "monitors",
      "extension_clients",
      "monitor_clients",
      "notification_events",
      "notification_batches",
      "telegram_jobs",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { app, store, monitor, client, presence, snapshot };
}

test("presence schema rejects invalid shapes with compatible JSON messages and no payload writes", async (t) => {
  const { presence, snapshot } = await fixture(t);
  const before = snapshot();
  for (const payload of [
    null,
    false,
    1,
    "text",
    [],
    {},
    { monitors: null },
    { monitors: {} },
    { monitors: "[]" },
    { monitors: Array(101).fill(null), device: null },
  ]) {
    const response = await presence(payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(response.json(), { error: "Nieprawidłowa lista obecności" });
    assert.match(response.headers["content-type"]!, /application\/json/);
    assert.deepEqual(snapshot(), before);
  }
  for (const device of [null, false, 1, "text", [], { os: 22 }, { browser: true }, { arch: [] }, { osVersion: {} }]) {
    const response = await presence({ monitors: [{ id: 1, open: true }], device });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "Nieprawidłowe dane urządzenia" });
    assert.deepEqual(snapshot(), before);
  }
});

test("presence metadata preserves optional fields, null, whitespace and UTF-16 length boundaries", async (t) => {
  const { presence, store, snapshot } = await fixture(t);
  const keys = ["extensionVersion", "browser", "os", "osVersion", "arch"] as const;
  for (const value of ["x".repeat(159), "x".repeat(160), "📚".repeat(79) + "x", "📚".repeat(80), "żółć 日本語"]) {
    const response = await presence({ monitors: [], device: Object.fromEntries(keys.map((key) => [key, value])) });
    assert.equal(response.statusCode, 200);
    for (const key of keys) assert.equal(store.listExtensionClients()[0]![key], value);
  }
  const before = snapshot();
  for (const key of keys) {
    for (const value of ["x".repeat(161), "📚".repeat(80) + "x", "📚".repeat(81), " ".repeat(161)]) {
      const response = await presence({ monitors: [], device: { [key]: value } });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "Nieprawidłowe dane urządzenia" });
      assert.deepEqual(snapshot(), before);
    }
  }
  assert.equal((await presence({ monitors: [] })).statusCode, 200);
  assert.deepEqual(snapshot(), before, "omitting device must not reset metadata");
  assert.equal(
    (await presence({ monitors: [], device: { extensionVersion: " 1.2.1 ", browser: " \t ", os: null } })).statusCode,
    200,
  );
  const device = store.listExtensionClients()[0]!;
  assert.deepEqual(
    keys.map((key) => device[key]),
    ["1.2.1", null, null, null, null],
  );
  assert.equal((await presence({ monitors: [], device: {} })).statusCode, 200);
  assert.deepEqual(
    keys.map((key) => store.listExtensionClients()[0]![key]),
    [null, null, null, null, null],
  );
});

test("presence keeps unknown fields and permissive monitor entries without coercing or defaulting payloads", async (t) => {
  const { presence, app, store, monitor, client } = await fixture(t);
  let observed: unknown;
  app.addHook("preHandler", async (request) => {
    observed = structuredClone(request.body);
  });
  const payload = {
    unknown: { nested: [null, "kept"] },
    device: { os: null, extra: { keep: true } },
    notificationProtocol: "2",
    monitors: [
      null,
      false,
      2,
      "text",
      [],
      {},
      { id: "invalid" },
      { id: 999999 },
      { id: -1 },
      { id: null },
      { id: false },
      { id: [] },
      { id: "" },
      { id: Number.MAX_SAFE_INTEGER + 1 },
      { id: 1.5 },
      { id: { value: monitor } },
      { id: ` ${monitor} `, open: "true", unknown: 7 },
      { id: [monitor], open: 1 },
      { id: true, open: null },
    ],
  };
  const response = await presence(payload);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().updated, 3);
  assert.equal("notificationBatch" in response.json(), false);
  assert.deepEqual(observed, payload, "validation must not convert, remove or add fields");
  assert.equal(store.hasMonitorClient(monitor, client), true);
  assert.equal(store.listMonitors()[0]!.activeClientsCount, 0, "only boolean true opens a tab");
  const full = { monitors: Array.from({ length: 100 }, () => ({ id: String(monitor), open: true })) };
  const boundary = await presence(full);
  assert.equal(boundary.statusCode, 200);
  assert.equal(boundary.json().updated, 100);
  assert.deepEqual(observed, full);
  assert.equal(store.listMonitors()[0]!.activeClientsCount, 1);
  for (const protocol of [undefined, null, 1, "2", true, {}, [], 2]) {
    const result = await presence({ monitors: [], notificationProtocol: protocol });
    assert.equal(result.statusCode, 200);
    assert.equal("notificationBatch" in result.json(), protocol === 2);
  }
});

test("presence checks Bearer before schema errors for parsed JSON", async (t) => {
  const { presence, snapshot } = await fixture(t);
  const before = snapshot();
  for (const payload of [
    null,
    [],
    {},
    { monitors: "[]" },
    { monitors: [], device: null },
    { monitors: [], device: { os: 123 } },
  ]) {
    for (const token of ["", "wrong"]) {
      const response = await presence(payload, token);
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: "Nieprawidłowy token rozszerzenia" });
      assert.deepEqual(snapshot(), before);
    }
  }
});

test("presence malformed JSON and body limit errors stay sanitized and do not mutate data", async (t) => {
  const { app, snapshot } = await fixture(t);
  const before = snapshot();
  for (const token of ["test-token", "wrong"]) {
    for (const [payload, status, message] of [
      ["", 400, "Nieprawidłowy JSON"],
      ['{"monitors": [SECRET', 400, "Nieprawidłowy JSON"],
      [JSON.stringify({ monitors: [], extra: "x".repeat(256000) }), 413, "Zbyt duże żądanie"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/extension/presence",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { error: message });
      assert.deepEqual(snapshot(), before);
    }
  }
  const exact = JSON.stringify({ monitors: [], extra: "" });
  const response = await app.inject({
    method: "POST",
    url: "/api/extension/presence",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    payload: JSON.stringify({ monitors: [], extra: "x".repeat(256000 - Buffer.byteLength(exact)) }),
  });
  assert.equal(response.statusCode, 200, "the existing 256000-byte body limit is inclusive");
});
