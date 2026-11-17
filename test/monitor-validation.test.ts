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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-validation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "test.sqlite");
  const now = () => 1800000000000;
  const store = new Store(databasePath, undefined, now);
  t.after(() => store.close());
  const first = store.addExtensionClient("First", tokenHash("first"));
  const second = store.addExtensionClient("Second", tokenHash("second"));
  store.touchExtensionClient(tokenHash("first"));
  store.touchExtensionClient(tokenHash("second"));
  const url = "https://allegro.pl/listing?a=1&string=existing&z=2";
  const id = store.createMonitor("Original", url, 15);
  store.linkMonitorClient(id, first, false);
  store.setNotificationsForClient(id, first, false);
  store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(store.getMonitor(id)!, [
    {
      externalId: "offer:100001",
      title: "Book",
      url: "https://allegro.pl/oferta/book-100001",
      price: "10 zł",
      imageUrl: null,
    },
  ]);
  const app = await buildApp({
    config: { ...config, databasePath, publicUrl: "", username: "", password: "", telegramBotToken: "" },
    startWorker: false,
    now,
  });
  t.after(() => app.close());
  const create = (payload: unknown, token = "second") =>
    app.inject({
      method: "POST",
      url: "/api/extension/monitors",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const snapshot = () =>
    [
      "monitors",
      "monitor_clients",
      "listings",
      "monitor_exclusions",
      "notification_events",
      "notification_batches",
      "telegram_jobs",
      "extension_clients",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { app, store, create, snapshot, db, id, url, first, second };
}

const invalidNames = [
  undefined,
  null,
  0,
  true,
  [],
  ["Books"],
  {},
  "",
  " \t\n ",
  "x".repeat(101),
  "📚".repeat(50) + "x",
  "📚".repeat(51),
];

test("monitor schema validates trimmed names and UTF-16 boundaries before changing monitors or links", async (t) => {
  const { create, snapshot, url } = await fixture(t);
  const before = snapshot();
  for (const target of [url, "https://allegro.pl/listing?string=new"]) {
    for (const name of invalidNames) {
      const response = await create({ name, url: target, intervalMinutes: 5 });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "Nieprawidłowe dane monitora" });
      assert.deepEqual(snapshot(), before);
    }
  }
  for (const payload of [null, [], false, 1, "text", {}]) {
    const response = await create(payload);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "Nieprawidłowe dane monitora" });
    assert.deepEqual(snapshot(), before);
  }
  for (const name of ["x".repeat(99), "x".repeat(100), "📚".repeat(49) + "x", "📚".repeat(50), "żółć 日本語"]) {
    const response = await create({ name: ` ${"\t".repeat(120)}${name}\n `, url, intervalMinutes: 5 });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().name, name);
  }
});

test("monitor creation and normalized URL updates preserve success fields, counters and all client relationships", async (t) => {
  const { create, store, db, id, url, first, second } = await fixture(t);
  const firstLink = db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, first);
  const created = await create({
    name: " New books ",
    url: "https://ALLEGRO.pl:443/listing?z=2&string=new&a=1#fragment",
    intervalMinutes: "5",
  });
  assert.equal(created.statusCode, 200);
  const newId = created.json().id;
  assert.deepEqual(created.json(), {
    id: newId,
    name: "New books",
    url: "https://allegro.pl/listing?a=1&string=new&z=2",
    intervalMinutes: 5,
    newListingsCount: 0,
    lastCheckNewCount: 0,
  });
  assert.equal(store.hasMonitorClient(newId, first), true);
  assert.equal(store.hasMonitorClient(newId, second), true);
  const updated = await create({
    name: " Updated books ",
    url: "https://ALLEGRO.pl:443/listing?z=2&string=existing&a=1#other",
    intervalMinutes: "30",
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json(), {
    id,
    name: "Updated books",
    url,
    intervalMinutes: 30,
    newListingsCount: 1,
    lastCheckNewCount: 1,
  });
  assert.equal(store.listMonitors().length, 2);
  assert.equal(store.hasMonitorClient(id, second), true);
  assert.deepEqual(
    db.prepare("SELECT * FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(id, first),
    firstLink,
  );
  assert.equal(store.areNotificationsEnabledForClient(id, first), false);
  assert.equal(store.getMonitor(id)!.newListingsCount, 1);
});

test("monitor schema preserves interval conversions, URL coercion and unknown fields without validator mutations", async (t) => {
  const { app, create, url, store, id } = await fixture(t);
  let observed: unknown;
  app.addHook("preHandler", async (request) => {
    observed = structuredClone(request.body);
  });
  for (const intervalMinutes of [1, 5, 15, 30, 60, "1", " 5 ", "15", "3e1", "0x3c", true, [5], ["15"]]) {
    const payload = {
      name: " Books ",
      url: [url],
      intervalMinutes,
      unknown: { keep: [null, true] },
      extra: "retained",
    };
    const response = await create(payload);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().id, id);
    assert.equal(response.json().intervalMinutes, Number(intervalMinutes));
    assert.deepEqual(observed, payload);
  }
  assert.equal(store.listMonitors().length, 1);
});

test("monitor interval and URL errors keep messages and leave all persisted data unchanged", async (t) => {
  const { create, snapshot, url } = await fixture(t);
  const before = snapshot();
  for (const intervalMinutes of [undefined, null, false, 0, 2, -1, 1.5, "wrong", "", [], {}, [5, 15]]) {
    const response = await create({ name: "Books", url, intervalMinutes });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "Nieprawidłowe dane monitora" });
    assert.deepEqual(snapshot(), before);
  }
  for (const [target, message] of [
    ["not a URL", "Invalid URL"],
    [null, "Invalid URL"],
    ["http://allegro.pl/listing?string=books", "Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl"],
    [
      "https://allegro.pl.attacker.example/listing?string=books",
      "Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl",
    ],
    ["https://allegro.pl/oferta/books", "Adres musi prowadzić do wyników wyszukiwania Allegro"],
    ["https://allegro.pl/listing?string=", "Adres musi prowadzić do wyników wyszukiwania Allegro"],
  ]) {
    const response = await create({ name: "Books", url: target, intervalMinutes: 5 });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: message });
    assert.deepEqual(snapshot(), before);
  }
});

test("monitor creation authenticates parsed JSON before schema, interval and URL errors", async (t) => {
  const { create, snapshot, url } = await fixture(t);
  const before = snapshot();
  for (const payload of [
    null,
    {},
    ...invalidNames.map((name) => ({ name, url, intervalMinutes: 5 })),
    { name: "Books", url, intervalMinutes: 2 },
    { name: "Books", url: "bad", intervalMinutes: 5 },
  ]) {
    for (const token of ["", "wrong"]) {
      const response = await create(payload, token);
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: "Nieprawidłowy token rozszerzenia" });
      assert.deepEqual(snapshot(), before);
    }
  }
});

test("monitor parser failures match presence and ACK with sanitized 400/413 and no writes", async (t) => {
  const { app, snapshot } = await fixture(t);
  const before = snapshot();
  for (const token of ["second", "wrong"]) {
    for (const [payload, status, error] of [
      ["", 400, "Nieprawidłowy JSON"],
      ['{"name": SECRET', 400, "Nieprawidłowy JSON"],
      [JSON.stringify({ extra: "x".repeat(256000) }), 413, "Zbyt duże żądanie"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/extension/monitors",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { error });
      assert.deepEqual(snapshot(), before);
    }
  }
});
