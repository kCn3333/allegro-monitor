import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { tokenHash } from "../src/security.js";
import { renderDevices } from "../src/devices.js";

async function fixture(t: any, now?: () => number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-devices-"));
  const settings = { ...config, databasePath: path.join(dir, "test.sqlite"), username: "owner", password: "test-password", sessionSecret: "s".repeat(32), telegramBotToken: "" };
  const store = new Store(settings.databasePath);
  const monitor = store.createMonitor("Book", "https://allegro.pl/listing?string=book", 5);
  const first = store.addExtensionClient("First", tokenHash("first-token"));
  const second = store.addExtensionClient("Second", tokenHash("second-token"));
  store.linkMonitorToAllClients(monitor, first);
  store.setNotificationsForClient(monitor, second, false);
  const app = await buildApp({ config: settings, startWorker: false, now });
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
  const html = renderDevices([{ extensionVersion: null, browser: null, os: null, osVersion: null, arch: null, active: 0, openMonitorsCount: 0, id: 2, name: '<img src=x onerror="alert(1)">', createdAt: "2026-01-01T00:00:00Z", lastSeenAt: null }]);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Brak kontaktu/);
  assert.match(html, /method="post" action="\/devices\/2\/revoke"/);
  assert.match(html, /method="post" action="\/devices\/2\/rename"/);
  assert.match(html, /aria-label="Edytuj nazwę urządzenia"/);
  assert.doesNotMatch(html, /Adres IP/);
  assert.match(html, /method="post" action="\/devices\/revoke-all"/);
  assert.match(renderDevices([]), /Brak sparowanych urządzeń/);
});

test("device rename validates names, requires a same-origin web session and preserves pairing", async t => {
  const { app, store, settings, first, second, cookie } = await fixture(t);
  const url = `/devices/${first}/rename`;
  for (const headers of [{}, { authorization: "Bearer first-token" }]) {
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { name: "Changed" } })).headers.location, "/login");
  }
  assert.equal((await app.inject({ method: "POST", url, headers: { cookie, "sec-fetch-site": "cross-site" }, payload: { name: "Changed" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode, 404);
  for (const name of [undefined, "", "   ", "a".repeat(101), 123, {}]) {
    assert.equal((await app.inject({ method: "POST", url, headers: { cookie }, payload: { name } })).statusCode, 400);
  }
  for (const id of ["0", "bad", "9007199254740992"]) {
    assert.equal((await app.inject({ method: "POST", url: `/devices/${id}/rename`, headers: { cookie }, payload: { name: "Changed" } })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: "/devices/99999/rename", headers: { cookie }, payload: { name: "Changed" } })).statusCode, 404);
  const name = '<script>alert("x")</script>';
  assert.equal((await app.inject({ method: "POST", url, headers: { cookie }, payload: { name: `  ${name}  ` } })).headers.location, "/devices");
  assert.equal(store.listExtensionClients().find(device => device.id === first)!.name, name);
  assert.equal(store.listExtensionClients().find(device => device.id === second)!.name, "Second");
  assert.equal(store.touchExtensionClient(tokenHash("first-token")), first);
  const page = (await app.inject({ url: "/devices", headers: { cookie } })).body;
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /<script>alert/);
  const reopened = new Store(settings.databasePath); t.after(() => reopened.close());
  assert.equal(reopened.listExtensionClients().find(device => device.id === first)!.name, name);
});

test("device management fails closed when panel credentials are not configured", async t => {
  const { settings, store, first } = await fixture(t);
  const app = await buildApp({ config: { ...settings, username: "", password: "" }, startWorker: false });
  t.after(() => app.close());
  for (const url of ["/devices", `/devices/${first}/rename`, `/devices/${first}/revoke`, "/devices/revoke-all"]) {
    assert.equal((await app.inject({ method: "POST", url })).statusCode, 503);
  }
  assert.equal(store.listExtensionClients().length, 2);
});

for (const field of ["body", "code", "name"] as const) {
  test(`pairing rejects invalid ${field} types without creating a device or consuming the code`, async t => {
    const { app, store, cookie } = await fixture(t);
    const code = (await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } })).json().code;
    const before = store.listExtensionClients();
    const invalid: unknown[] = [null, false, true, 0, 1, [], {}];
    if (field === "body") invalid.push("text");
    if (field !== "name") invalid.push(undefined);
    for (const value of invalid) {
      const payload = field === "body" ? value : { code, [field]: value };
      const response = await app.inject({ method: "POST", url: "/api/extension/pair",
        ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) }) });
      assert.equal(response.statusCode, 400, `${field}: ${JSON.stringify(value)}`);
      assert.equal(response.body, "Nieprawidłowe dane parowania");
      assert.deepEqual(store.listExtensionClients(), before);
    }
    const paired = await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code, name: "Valid device" } });
    assert.equal(paired.statusCode, 200);
    assert.ok(store.touchExtensionClient(tokenHash(paired.json().token)));
    assert.equal(store.listExtensionClients().length, before.length + 1);
  });
}

test("successful pairing normalizes codes, preserves default names and is single-use", async t => {
  const { app, store, monitor, cookie } = await fixture(t);
  for (const name of [undefined, "", "Named device", "x".repeat(120)]) {
    const code = (await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } })).json().code;
    const payload = { code: `  ${code.toLowerCase()}  `, name };
    const before = store.listExtensionClients().length;
    const response = await app.inject({ method: "POST", url: "/api/extension/pair", payload });
    assert.equal(response.statusCode, 200);
    const clientId = store.touchExtensionClient(tokenHash(response.json().token));
    assert.ok(clientId);
    assert.equal(store.listExtensionClients().find(client => client.id === clientId)!.name, (name || "Vivaldi").slice(0, 100));
    assert.equal(store.hasMonitorClient(monitor, clientId), true);
    assert.equal((await app.inject({ method: "POST", url: "/api/extension/pair", payload })).statusCode, 400);
    assert.equal(store.listExtensionClients().length, before + 1);
  }
});

test("invalid pairing payloads count towards the 12-attempt limit, which expires and resets after success", async t => {
  let now = 1000;
  const { app, store, cookie } = await fixture(t, () => now);
  const code = (await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } })).json().code;
  const before = store.listExtensionClients().length;
  const pair = (payload: object) => app.inject({ method: "POST", url: "/api/extension/pair", payload });
  for (let i = 0; i < 12; i++) assert.equal((await pair({ code, name: {} })).statusCode, 400);
  assert.equal((await pair({ code })).statusCode, 429);
  assert.equal(store.listExtensionClients().length, before);
  now += 15 * 60_000;
  assert.equal((await pair({ code })).statusCode, 400);
  const fresh = (await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } })).json().code;
  assert.equal((await pair({ code: fresh })).statusCode, 200);
  assert.equal(store.listExtensionClients().length, before + 1);
  for (let i = 0; i < 12; i++) assert.equal((await pair({ code: "invalid" })).statusCode, 400);
  assert.equal((await pair({ code: "invalid" })).statusCode, 429);
});

for (const [age, status] of [[599_999, 200], [600_000, 400], [600_001, 400]] as const) {
  test(`pairing code at age ${age}ms uses the injected clock and returns ${status}`, async t => {
    let now = 1000;
    const { app, store, cookie } = await fixture(t, () => now);
    const response = await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    const { code, expiresInSeconds } = response.json();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(expiresInSeconds, 600);
    const before = store.listExtensionClients().length;
    now += age;
    const paired = await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code } });
    assert.equal(paired.statusCode, status);
    assert.equal(store.listExtensionClients().length, before + (status === 200 ? 1 : 0));
    assert.equal((await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code } })).statusCode, 400);
  });
}

test("100 active codes return Retry-After for the nearest expiry without evicting old codes; pairing frees a slot", async t => {
  let now = 1000;
  const { app, cookie } = await fixture(t, () => now);
  const generate = () => app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } });
  const first = (await generate()).json().code;
  now += 1500;
  const codes = [first];
  for (let i = 1; i < 100; i++) {
    const response = await generate();
    assert.equal(response.statusCode, 200);
    codes.push(response.json().code);
  }
  assert.equal(new Set(codes).size, 100);
  const blocked = await generate();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers["retry-after"], "599");
  now += 500;
  const stillBlocked = await generate();
  assert.equal(stillBlocked.statusCode, 429);
  assert.equal(stillBlocked.headers["retry-after"], "598");
  const pair = (code: string) => app.inject({ method: "POST", url: "/api/extension/pair", payload: { code } });
  assert.equal((await pair(first)).statusCode, 200);
  assert.equal((await generate()).statusCode, 200);
  assert.equal((await generate()).statusCode, 429);
  assert.equal((await pair(codes[1])).statusCode, 200);
  assert.equal((await pair(codes[99])).statusCode, 200);
});

test("expired codes are removed at the exact expiry boundary so the full capacity becomes available again", async t => {
  let now = 1000;
  const { app, cookie } = await fixture(t, () => now);
  const generate = () => app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } });
  for (let i = 0; i < 100; i++) {
    const response = await generate();
    assert.equal(response.statusCode, 200);
  }
  assert.equal((await generate()).statusCode, 429);
  now += 600_000;
  for (let i = 0; i < 100; i++) assert.equal((await generate()).statusCode, 200);
  assert.equal((await generate()).statusCode, 429);
});

test("a random code collision is retried without overwriting or extending the earlier code", async t => {
  let now = 1000;
  const { app, cookie } = await fixture(t, () => now);
  const original = crypto.randomBytes;
  let generated = 0;
  t.mock.method(crypto, "randomBytes", (size: number) => size === 8 ? Buffer.alloc(8, generated++ < 2 ? 0 : 1) : original(size));
  const generate = () => app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } });
  const first = (await generate()).json().code;
  now += 1000;
  const second = (await generate()).json().code;
  assert.notEqual(first, second);
  assert.equal(generated, 3);
  now = 601_000;
  assert.equal((await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code: first } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code: second } })).statusCode, 200);
});
