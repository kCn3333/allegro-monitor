import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { tokenHash } from "../src/security.js";

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-notification-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "test.sqlite");
  const now = () => 1800000000000;
  const store = new Store(databasePath, undefined, now);
  t.after(() => store.close());
  const id = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  const a = store.addExtensionClient("A", tokenHash("a"));
  const b = store.addExtensionClient("B", tokenHash("b"));
  store.touchExtensionClient(tokenHash("a"));
  store.touchExtensionClient(tokenHash("b"));
  store.linkMonitorClient(id, a, true);
  const app = await buildApp({
    config: { ...config, databasePath, publicUrl: "", username: "", password: "", telegramBotToken: "" },
    startWorker: false,
    now,
  });
  t.after(() => app.close());
  const post = (payload?: unknown, monitor = String(id), token = "a") =>
    app.inject({
      method: "POST",
      url: `/api/extension/monitors/${monitor}/notification-state`,
      headers:
        payload === undefined
          ? { authorization: `Bearer ${token}` }
          : { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const snapshot = () =>
    [
      "monitors",
      "monitor_clients",
      "extension_clients",
      "notification_events",
      "notification_batches",
      "telegram_jobs",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { app, post, store, db, snapshot, id, a, b };
}

const invalid = [
  undefined,
  null,
  [],
  false,
  1,
  "text",
  {},
  ...[undefined, null, "true", "false", 0, 1, [], {}, [true]].map((enabled) => ({ enabled })),
];

test("notification settings preserve Bearer then ID/body then existence error precedence without mutations", async (t) => {
  const { post, snapshot, id } = await fixture(t);
  const before = snapshot();
  for (const payload of [...invalid, { enabled: true }, { enabled: false }]) {
    for (const monitor of [String(id), "invalid", "99999"]) {
      for (const token of ["", "wrong"]) {
        const response = await post(payload, monitor, token);
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { error: "Nieprawidłowy token rozszerzenia" });
        assert.deepEqual(snapshot(), before);
      }
    }
    for (const monitor of ["invalid", "0", "-1", "1.5", "9007199254740992"]) {
      const response = await post(payload, monitor);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "Nieprawidłowy stan monitora" });
      assert.deepEqual(snapshot(), before);
    }
  }
  for (const monitor of [String(id), "99999"]) {
    for (const payload of invalid) {
      const response = await post(payload, monitor);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "Nieprawidłowy stan monitora" });
      assert.deepEqual(snapshot(), before);
    }
  }
  for (const enabled of [false, true]) {
    const response = await post({ enabled }, "99999");
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "Monitor nie istnieje" });
    assert.deepEqual(snapshot(), before);
  }
});

test("notification settings preserve booleans, unknown fields, ID conversion and other clients", async (t) => {
  const { app, post, store, db, id, a, b } = await fixture(t);
  let observed: unknown;
  app.addHook("preHandler", async (request) => {
    observed = structuredClone(request.body);
  });
  const monitor = store.getMonitor(id);
  const firstLink = db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, a);
  assert.equal(store.hasMonitorClient(id, b), false);
  for (const encodedId of ["01", "1e0", "0x1", "%2B1", "%201%20"]) {
    for (const enabled of [false, true]) {
      const payload = { enabled, unknown: { keep: [true, null, "text"] } };
      const response = await post(payload, encodedId, "b");
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { enabled });
      assert.deepEqual(observed, payload, "schema must not coerce, remove or default fields");
      assert.equal(store.hasMonitorClient(id, b), true);
      assert.equal(store.areNotificationsEnabledForClient(id, b), enabled);
      assert.deepEqual(
        db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, a),
        firstLink,
      );
      assert.deepEqual(store.getMonitor(id), monitor);
    }
  }
  const secondLink = db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, b);
  assert.equal((await post({ enabled: false })).statusCode, 200);
  assert.equal(store.areNotificationsEnabledForClient(id, a), false);
  assert.deepEqual(
    db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, b),
    secondLink,
  );
});

test("notification settings accept disabled monitors and unlinked clients without opening tabs", async (t) => {
  const { post, store, db, id, a, b } = await fixture(t);
  store.toggleMonitor(id);
  const monitor = store.getMonitor(id);
  const firstLink = db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, a);
  assert.equal(store.hasMonitorClient(id, b), false);
  for (const enabled of [false, true]) {
    const response = await post({ enabled }, String(id), "b");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { enabled });
    assert.equal(store.areNotificationsEnabledForClient(id, b), enabled);
    const row = db
      .prepare("SELECT tab_open,notifications_enabled FROM monitor_clients WHERE monitor_id=? AND client_id=?")
      .get(id, b);
    assert.deepEqual({ ...row }, { tab_open: 0, notifications_enabled: Number(enabled) });
    assert.deepEqual(store.getMonitor(id), monitor);
    assert.deepEqual(
      db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, a),
      firstLink,
    );
  }
});

test("notification settings JSON parser and body-limit failures match local errors without writes", async (t) => {
  const { app, snapshot, id } = await fixture(t);
  const before = snapshot();
  for (const token of ["a", "wrong"]) {
    for (const [payload, status, error] of [
      ["", 400, "Nieprawidłowy JSON"],
      ['{"enabled": SECRET', 400, "Nieprawidłowy JSON"],
      [JSON.stringify({ enabled: true, extra: "x".repeat(256000) }), 413, "Zbyt duże żądanie"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/extension/monitors/${id}/notification-state`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { error });
      assert.deepEqual(snapshot(), before);
    }
  }
});
