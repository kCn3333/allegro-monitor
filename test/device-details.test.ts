import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { tokenHash } from "../src/security.js";
import { renderDevices } from "../src/devices.js";
import { renderFaq } from "../src/faq.js";
import { renderExtension } from "../src/extension-page.js";
import { renderPage } from "../src/ui.js";

function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-devices-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...config, databasePath: path.join(dir, "test.sqlite"), username: "test", password: "password", sessionSecret: "test".repeat(10), telegramBotToken: "" };
}

test("device status expires, counts only fresh enabled monitor tabs, and metadata survives restart", t => {
  const settings = fixture(t);
  let store = new Store(settings.databasePath);
  const id = store.addExtensionClient("<script>alert(1)</script>", "secret-hash");
  assert.equal(store.listExtensionClients()[0]!.active, 0);
  store.touchExtensionClient("secret-hash");
  store.updateExtensionClientInfo(id, { extensionVersion: "1.1.4", browser: "Chromium 140", os: "Linux", osVersion: null, arch: "x86-64" });
  const monitor = store.createMonitor("books", "https://allegro.pl/listing?string=books", 5);
  store.linkMonitorClient(monitor, id);
  let devices = store.listExtensionClients();
  assert.equal(devices[0]!.active, 1);
  assert.equal(devices[0]!.openMonitorsCount, 1);
  const html = renderDevices(devices);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /secret-hash/);
  devices = store.listExtensionClients(Date.now() + 181_000);
  assert.equal(devices[0]!.active, 0);
  assert.equal(devices[0]!.openMonitorsCount, 0);
  store.close(); store = new Store(settings.databasePath); t.after(() => store.close());
  assert.equal(store.listExtensionClients()[0]!.extensionVersion, "1.1.4");
});

test("device page is private and authenticated presence validates metadata, ignores spoofed IP and supports legacy clients", async t => {
  const settings = fixture(t);
  const store = new Store(settings.databasePath); t.after(() => store.close());
  store.addExtensionClient("test", tokenHash("test-token"));
  const app = await buildApp({ config: settings, startWorker: false }); t.after(() => app.close());
  assert.equal((await app.inject("/devices")).headers.location, "/login");
  const presence = (device?: unknown, token = "test-token") => app.inject({ method: "POST", url: "/api/extension/presence", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" }, payload: { monitors: [], device } });
  assert.equal((await presence({ extensionVersion: "1.1.4", os: "Linux" })).statusCode, 200);
  assert.equal((await presence({ os: "forged" }, "wrong")).statusCode, 401);
  assert.equal((await presence({ os: {} })).statusCode, 400);
  assert.equal((await presence({ browser: "x".repeat(161) })).statusCode, 400);
  assert.equal((await presence()).statusCode, 200);
  const device = store.listExtensionClients()[0]!;
  assert.equal(device.os, "Linux"); assert.equal(device.extensionVersion, "1.1.4");
  assert.equal("ip" in device, false);
  const login = await app.inject({ method: "POST", url: "/login", payload: { username: "test", password: "password" } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  assert.equal((await app.inject({ url: "/devices", headers: { cookie } })).statusCode, 200);
});

test("migration adds optional device fields without changing old pairings", t => {
  const settings = fixture(t); const db = new DatabaseSync(settings.databasePath);
  db.exec(`CREATE TABLE extension_clients(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,last_seen_at TEXT,created_at TEXT NOT NULL); INSERT INTO extension_clients(name,token_hash,created_at) VALUES('old','old-hash','2026-01-01T00:00:00Z')`); db.close();
  const store = new Store(settings.databasePath); t.after(() => store.close());
  assert.equal(store.touchExtensionClient("old-hash"), 1);
  assert.equal(store.listExtensionClients()[0]!.extensionVersion, null);
});

test("all pages share navigation, active page, theme and device entry point", () => {
  for (const [current, html] of [["/", renderPage([], [], [])], ["/devices", renderDevices([])], ["/faq", renderFaq()], ["/extension", renderExtension("1.1.5")]] as const) {
    assert.ok(html.includes(`href="${current}" aria-current="page"`));
    assert.match(html, /<nav[^>]*>.*href="\/devices"/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /<footer/);
  }
});
