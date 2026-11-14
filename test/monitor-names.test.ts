import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { config } from "../src/config.js";
import { Store } from "../src/database.js";
import { tokenHash } from "../src/security.js";
import { buildApp } from "../src/server.js";

async function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-names-"));
  const settings = { ...config, databasePath: path.join(dir, "db.sqlite"), username: "owner", password: "password",
    sessionSecret: "s".repeat(32), publicUrl: "", telegramBotToken: "" };
  const store = new Store(settings.databasePath);
  const url = "https://allegro.pl/listing?string=existing";
  const id = store.createMonitor("Original", url, 15);
  const first = store.addExtensionClient("First", tokenHash("first-token"));
  const second = store.addExtensionClient("Second", tokenHash("second-token"));
  store.linkMonitorClient(id, first, false);
  store.setNotificationsForClient(id, first, false);
  const app = await buildApp({ config: settings, startWorker: false });
  const db = new DatabaseSync(settings.databasePath);
  t.after(async () => { await app.close(); db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const login = await app.inject({ method: "POST", url: "/login", payload: { username: "owner", password: "password" } });
  assert.equal(login.statusCode, 302);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const snapshot = () => [db.prepare("SELECT * FROM monitors ORDER BY id").all(),
    db.prepare("SELECT * FROM monitor_clients ORDER BY monitor_id,client_id").all()];
  return { app, store, url, id, first, second, cookie, snapshot };
}

const invalidNames: unknown[] = [undefined, null, false, true, 0, 123, [], ["Valid text"], {}, { name: "Valid text" }, "", " \t\n ", "a".repeat(101)];

test("invalid API monitor names return a generic 400 without creating, updating or linking monitors", async t => {
  const { app, url, snapshot } = await fixture(t);
  const before = snapshot();
  for (const target of [url, "https://allegro.pl/listing?string=new"]) {
    for (const name of invalidNames) {
      const response = await app.inject({ method: "POST", url: "/api/extension/monitors",
        headers: { authorization: "Bearer second-token" }, payload: { name, url: target, intervalMinutes: 60 } });
      assert.equal(response.statusCode, 400, JSON.stringify(name));
      assert.equal(response.body, "Nieprawidłowe dane monitora");
      assert.deepEqual(snapshot(), before);
    }
  }
  const response = await app.inject({ method: "POST", url: "/api/extension/monitors",
    headers: { authorization: "Bearer second-token" },
    payload: { name: 123, url, intervalMinutes: { toString: null, valueOf: null } } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body, "Nieprawidłowe dane monitora");
  assert.deepEqual(snapshot(), before);
});

test("invalid rename names and duplicate form fields return a generic 400 without changing settings or links", async t => {
  const { app, id, cookie, snapshot } = await fixture(t);
  const before = snapshot();
  for (const name of invalidNames) {
    const response = await app.inject({ method: "POST", url: `/monitors/${id}/rename`, headers: { cookie }, payload: { name } });
    assert.equal(response.statusCode, 400, JSON.stringify(name));
    assert.equal(response.body, "Nieprawidłowa nazwa monitora");
    assert.deepEqual(snapshot(), before);
  }
  const duplicate = await app.inject({ method: "POST", url: `/monitors/${id}/rename`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "name=First&name=Second" });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.body, "Nieprawidłowa nazwa monitora");
  assert.deepEqual(snapshot(), before);
});

test("API creates and updates existing URLs with trimmed names up to 100 characters and all supported intervals", async t => {
  const { app, store, id, url, first, second } = await fixture(t);
  const headers = { authorization: "Bearer second-token" };
  const maximum = "ą".repeat(100);
  const update = await app.inject({ method: "POST", url: "/api/extension/monitors", headers,
    payload: { name: ` \t${maximum}\n `, url, intervalMinutes: 30 } });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json(), { id, name: maximum, url, intervalMinutes: 30, newListingsCount: 0, lastCheckNewCount: 0 });
  assert.equal(store.getMonitor(id)!.name, maximum);
  assert.equal(store.getMonitor(id)!.intervalMinutes, 30);
  assert.equal(store.hasMonitorClient(id, second), true);
  const newUrl = "https://allegro.pl/listing?string=new";
  let newId: number | undefined;
  for (const intervalMinutes of [1, 5, 15, 30, 60]) {
    const name = intervalMinutes === 1 ? maximum : `Books ${intervalMinutes}`;
    const response = await app.inject({ method: "POST", url: "/api/extension/monitors", headers,
      payload: { name: ` \t${name}\n `, url: newUrl, intervalMinutes } });
    assert.equal(response.statusCode, 200);
    newId ??= response.json().id;
    assert.deepEqual(response.json(), { id: newId, name, url: newUrl, intervalMinutes, newListingsCount: 0, lastCheckNewCount: 0 });
    assert.equal(store.getMonitor(newId!)!.name, name);
    assert.equal(store.getMonitor(newId!)!.intervalMinutes, intervalMinutes);
    assert.equal(store.listMonitors().length, 2);
  }
  assert.equal(store.hasMonitorClient(newId!, first), true);
  assert.equal(store.hasMonitorClient(newId!, second), true);
});

test("form rename trims whitespace and accepts 100 characters without changing other monitor fields or links", async t => {
  const { app, store, id, cookie, snapshot } = await fixture(t);
  const before = snapshot();
  const original = store.getMonitor(id)!;
  const name = "ą".repeat(100);
  const response = await app.inject({ method: "POST", url: `/monitors/${id}/rename`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    payload: new URLSearchParams({ name: ` \t${name}\n ` }).toString() });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, "/");
  assert.deepEqual({ ...store.getMonitor(id) }, { ...original, name });
  assert.deepEqual(snapshot()[1], before[1]);
});

test("monitor creation keeps bearer authentication and interval validation, while rename keeps session and CSRF protection", async t => {
  const { app, id, cookie, url, snapshot } = await fixture(t);
  const before = snapshot();
  for (const headers of [{}, { authorization: "Bearer invalid" }, { cookie }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/extension/monitors", headers,
      payload: { name: "Valid", url, intervalMinutes: 5 } })).statusCode, 401);
  }
  for (const intervalMinutes of [0, 2, 10, 61]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/extension/monitors", headers: { authorization: "Bearer second-token" },
      payload: { name: "Valid", url, intervalMinutes } })).statusCode, 400);
  }
  for (const headers of [{}, { authorization: "Bearer first-token" }]) {
    const response = await app.inject({ method: "POST", url: `/monitors/${id}/rename`, headers, payload: { name: "Valid" } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/login");
  }
  for (const site of ["cross-site", "same-site"]) {
    assert.equal((await app.inject({ method: "POST", url: `/monitors/${id}/rename`,
      headers: { cookie, "sec-fetch-site": site }, payload: { name: "Valid" } })).statusCode, 403);
  }
  assert.deepEqual(snapshot(), before);
});
