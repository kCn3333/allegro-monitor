import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { tokenHash } from "../src/security.js";
import { renderDevices } from "../src/devices.js";

async function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-devices-"));
  const settings = { ...config, databasePath: path.join(dir, "test.sqlite"), username: "owner", password: "test-password", sessionSecret: "s".repeat(32), telegramBotToken: "" };
  const store = new Store(settings.databasePath);
  const monitor = store.createMonitor("Book", "https://allegro.pl/listing?string=book", 5);
  const first = store.addExtensionClient("First", tokenHash("first-token"));
  const second = store.addExtensionClient("Second", tokenHash("second-token"));
  store.linkMonitorToAllClients(monitor, first);
  store.setNotificationsForClient(monitor, second, false);
  const app = await buildApp({ config: settings, startWorker: false });
  t.after(async () => { await app.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const login = await app.inject({ method: "POST", url: "/login", payload: { username: settings.username, password: settings.password } });
  assert.equal(login.statusCode, 302);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  return { app, store, settings, monitor, first, second, cookie };
}

test("device revocation requires a web session and same-origin POST, never a bearer token or GET", async t => {
  const { app, store, first, cookie } = await fixture(t);
  for (const url of [`/devices/${first}/revoke`, "/devices/revoke-all"]) {
    for (const headers of [{}, { authorization: "Bearer first-token" }]) {
      const response = await app.inject({ method: "POST", url, headers });
      assert.equal(response.statusCode, 302); assert.equal(response.headers.location, "/login");
    }
    for (const site of ["cross-site", "same-site"]) {
      assert.equal((await app.inject({ method: "POST", url, headers: { cookie, "sec-fetch-site": site } })).statusCode, 403);
    }
    assert.equal((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode, 404);
  }
  for (const id of ["0", "invalid", "9007199254740992"]) {
    assert.equal((await app.inject({ method: "POST", url: `/devices/${id}/revoke`, headers: { cookie } })).statusCode, 400);
  }
  assert.equal(store.listExtensionClients().length, 2);
});

test("revocation rejects every authenticated extension endpoint and preserves shared data and other devices", async t => {
  const { app, store, settings, first, second, monitor, cookie } = await fixture(t);
  const listing = { externalId: "offer:123456", title: "Book", url: "https://allegro.pl/oferta/book-123456", price: null, imageUrl: null };
  store.saveCheck(store.getMonitor(monitor)!, []);
  store.saveCheck(store.getMonitor(monitor)!, [listing], ["123"]);
  store.addExclusion(monitor, listing.externalId);
  store.notificationBatch(first);
  store.notificationBatch(second);
  const db = new DatabaseSync(settings.databasePath); t.after(() => db.close());
  const shared = () => ["monitors", "listings", "monitor_exclusions", "notification_events", "telegram_jobs"].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const before = shared();
  const response = await app.inject({ method: "POST", url: `/devices/${first}/revoke`, headers: { cookie, "sec-fetch-site": "same-origin" } });
  assert.equal(response.statusCode, 302);
  for (const url of ["/api/extension/presence", "/api/extension/monitors", "/api/extension/notifications/ack", ...["results", "error", "notification-state"].map(action => `/api/extension/monitors/${monitor}/${action}`)]) {
    assert.equal((await app.inject({ method: "POST", url, headers: { authorization: "Bearer first-token" }, payload: {} })).statusCode, 401);
  }
  assert.deepEqual(shared(), before);
  assert.equal(store.hasMonitorClient(monitor, first), false);
  assert.equal(db.prepare("SELECT 1 FROM notification_batches WHERE client_id=?").get(first), undefined);
  assert.ok(db.prepare("SELECT 1 FROM notification_batches WHERE client_id=?").get(second));
  assert.equal(store.areNotificationsEnabledForClient(monitor, second), false);
  assert.equal((await app.inject({ method: "POST", url: "/api/extension/presence", headers: { authorization: "Bearer second-token" }, payload: { monitors: [] } })).statusCode, 200);
  const reopened = new Store(settings.databasePath);
  assert.equal(reopened.touchExtensionClient(tokenHash("first-token")), null);
  assert.equal(reopened.touchExtensionClient(tokenHash("second-token")), second);
  reopened.close();
});

test("revoke-all clears pending pairing codes, preserves panel session and allows fresh pairing", async t => {
  const { app, store, monitor, cookie } = await fixture(t);
  const code = async () => (await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } })).json().code;
  const oldCode = await code();
  const revoke = await app.inject({ method: "POST", url: "/devices/revoke-all", headers: { cookie, "sec-fetch-site": "same-origin" } });
  assert.equal(revoke.statusCode, 302); assert.deepEqual(store.listExtensionClients(), []);
  for (const token of ["first-token", "second-token"]) assert.equal(store.touchExtensionClient(tokenHash(token)), null);
  assert.ok(store.getMonitor(monitor));
  assert.equal((await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code: oldCode } })).statusCode, 400);
  const paired = await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code: await code(), name: "Replacement" } });
  assert.equal(paired.statusCode, 200);
  assert.ok(store.touchExtensionClient(tokenHash(paired.json().token)));
  const panel = await app.inject({ url: "/devices", headers: { cookie } });
  assert.equal(panel.statusCode, 200); assert.match(panel.body, /Replacement/);
  assert.doesNotMatch(panel.body, new RegExp(paired.json().token));
  assert.doesNotMatch(panel.body, new RegExp(tokenHash(paired.json().token)));
});

test("device UI escapes names, handles unused devices and renders explicit POST controls", () => {
  const html = renderDevices([{ extensionVersion: null, browser: null, os: null, osVersion: null, arch: null, ip: null, active: 0, openMonitorsCount: 0, id: 2, name: '<img src=x onerror="alert(1)">', createdAt: "2026-01-01T00:00:00Z", lastSeenAt: null }]);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Brak kontaktu/);
  assert.match(html, /method="post" action="\/devices\/2\/revoke"/);
  assert.match(html, /method="post" action="\/devices\/revoke-all"/);
  assert.match(renderDevices([]), /Brak sparowanych urządzeń/);
});

test("device management fails closed when panel credentials are not configured", async t => {
  const { settings, store, first } = await fixture(t);
  const app = await buildApp({ config: { ...settings, username: "", password: "" }, startWorker: false });
  t.after(() => app.close());
  for (const url of ["/devices", `/devices/${first}/revoke`, "/devices/revoke-all"]) {
    assert.equal((await app.inject({ method: "POST", url })).statusCode, 503);
  }
  assert.equal(store.listExtensionClients().length, 2);
});
