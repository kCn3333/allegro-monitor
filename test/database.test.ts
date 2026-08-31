import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";

const offer = (id: string) => ({
  externalId: id,
  title: `Oferta ${id}`,
  url: `https://allegro.pl/oferta/test-${id.replace(/\D/g, "") || "123456"}`,
  price: "10 zł",
  imageUrl: null
});

test("counts new listings and removes entries missing from consecutive checks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-"));
  const store = new Store(path.join(directory, "test.sqlite"), 2);
  try {
    const id = store.createMonitor("Test", "https://allegro.pl/listing?string=test", 1);
    let monitor = store.getMonitor(id)!;
    assert.deepEqual(store.saveCheck(monitor, [offer("offer:111111")]), []);

    monitor = store.getMonitor(id)!;
    assert.equal(store.saveCheck(monitor, [offer("offer:111111"), offer("offer:222222")]).length, 1);
    assert.equal(store.getMonitor(id)?.newListingsCount, 1);
    assert.equal(store.getMonitor(id)?.lastCheckNewCount, 1);
    assert.equal(store.recentListings().find(item => item.externalId === "offer:222222")?.fromLatestCheck, 1);
    assert.equal(store.recentListings().find(item => item.externalId === "offer:111111")?.fromLatestCheck, 0);

    monitor = store.getMonitor(id)!;
    store.saveCheck(monitor, [offer("offer:111111")]);
    assert.equal(store.getMonitor(id)?.lastCheckNewCount, 0);
    assert.equal(store.recentListings().some(item => item.fromLatestCheck === 1), false);
    monitor = store.getMonitor(id)!;
    store.saveCheck(monitor, [offer("offer:111111")]);
    assert.equal(store.recentListings().some(item => item.externalId === "offer:222222"), false);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("stores, renews and revokes hashed web sessions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-session-"));
  const databasePath = path.join(directory, "test.sqlite");
  let store = new Store(databasePath);
  try {
    store.createWebSession("token-hash", "credentials-v1", 3600);
    assert.equal(store.touchWebSession("token-hash", "credentials-v1"), 3600);
    store.close();
    store = new Store(databasePath);
    assert.equal(store.touchWebSession("token-hash", "credentials-v1"), 3600);
    assert.equal(store.touchWebSession("raw-token", "credentials-v1"), null);
    assert.equal(store.touchWebSession("token-hash", "credentials-v2"), null);
    store.deleteWebSession("token-hash");
    assert.equal(store.touchWebSession("token-hash", "credentials-v1"), null);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("excludes one exact product without treating it as new after restore", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-exclusion-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try {
    const id = store.createMonitor("Test", "https://allegro.pl/listing?string=test", 5);
    const product = offer("product:25a97dc8-fdcd-41fd-b9de-7a7247d83e95");
    store.saveCheck(store.getMonitor(id)!, [product]);
    assert.equal(store.addExclusion(id, product.externalId), true);
    assert.equal(store.getMonitor(id)?.currentListingsCount, 0);
    assert.equal(store.listExclusions()[0]?.externalId, product.externalId);
    assert.equal(store.recentListings().length, 0);
    assert.deepEqual(store.saveCheck(store.getMonitor(id)!, [product]), []);

    store.removeExclusion(id, product.externalId);
    assert.equal(store.recentListings()[0]?.externalId, product.externalId);
    assert.deepEqual(store.saveCheck(store.getMonitor(id)!, [product]), []);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("keeps a shared monitor active while another extension still has its tab open", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-presence-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try {
    const monitorId = store.createMonitor("Wspólny", "https://allegro.pl/listing?string=test", 5);
    store.addExtensionClient("Vivaldi 1", "hash-1");
    store.addExtensionClient("Vivaldi 2", "hash-2");
    const firstClient = store.touchExtensionClient("hash-1")!;
    const secondClient = store.touchExtensionClient("hash-2")!;
    store.linkMonitorToAllClients(monitorId, firstClient);
    store.linkMonitorClient(monitorId, secondClient, true);
    assert.equal(store.listMonitors()[0]?.activeClientsCount, 2);
    assert.equal(store.listMonitorsForClient(firstClient).length, 1);
    assert.equal(store.listMonitorsForClient(secondClient).length, 1);
    assert.equal(store.areNotificationsEnabledForClient(monitorId, firstClient), true);
    store.setNotificationsForClient(monitorId, firstClient, false);
    assert.equal(store.areNotificationsEnabledForClient(monitorId, firstClient), false);
    store.setNotificationsForClient(monitorId, firstClient, true);
    assert.equal(store.areNotificationsEnabledForClient(monitorId, firstClient), true);
    store.renameMonitor(monitorId, "Nowa nazwa");
    assert.equal(store.getMonitor(monitorId)?.name, "Nowa nazwa");

    store.linkMonitorClient(monitorId, firstClient, false);
    assert.equal(store.listMonitors()[0]?.activeClientsCount, 1);
    store.unlinkMonitorClient(monitorId, firstClient);
    assert.ok(store.getMonitor(monitorId));
    store.unlinkMonitorClient(monitorId, secondClient);
    assert.ok(store.getMonitor(monitorId));
    assert.equal(store.listMonitors()[0]?.activeClientsCount, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("delivers new-offer events independently of which extension checked the monitor", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-notifications-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try {
    const monitorId = store.createMonitor("Wspólny", "https://allegro.pl/listing?string=test", 5);
    const quietClient = store.addExtensionClient("Bez powiadomień", "hash-quiet");
    const notifiedClient = store.addExtensionClient("Z powiadomieniami", "hash-notified");
    store.linkMonitorToAllClients(monitorId, quietClient);
    store.setNotificationsForClient(monitorId, quietClient, false);
    store.saveCheck(store.getMonitor(monitorId)!, [offer("offer:111111")]);
    store.saveCheck(store.getMonitor(monitorId)!, [offer("offer:111111"), offer("offer:222222")]);

    assert.deepEqual(store.pullNotifications(quietClient), []);
    assert.equal(store.pullNotifications(notifiedClient)[0]?.externalId, "offer:222222");
    store.setNotificationsForClient(monitorId, quietClient, true);
    store.saveCheck(store.getMonitor(monitorId)!, [offer("offer:111111"), offer("offer:222222"), offer("offer:333333")]);
    assert.equal(store.pullNotifications(quietClient)[0]?.externalId, "offer:333333");
    assert.equal(store.pullNotifications(notifiedClient)[0]?.externalId, "offer:333333");
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("links an extension paired later to all existing monitors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-late-client-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try {
    store.createMonitor("Istniejący", "https://allegro.pl/listing?string=test", 5);
    const clientId = store.addExtensionClient("Nowy Vivaldi", "hash-late");
    store.linkClientToAllMonitors(clientId);
    assert.equal(store.listMonitorsForClient(clientId).length, 1);
    assert.equal(store.listMonitors()[0]?.activeClientsCount, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("migrates the previous database schema without losing data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-legacy-"));
  const databasePath = path.join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE monitors (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,url TEXT NOT NULL,interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK(interval_minutes >= 2),enabled INTEGER NOT NULL DEFAULT 1,initialized INTEGER NOT NULL DEFAULT 0,last_checked_at TEXT,next_check_at TEXT NOT NULL,last_error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE listings (id INTEGER PRIMARY KEY AUTOINCREMENT,monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,external_id TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,price TEXT,image_url TEXT,first_seen_at TEXT NOT NULL,UNIQUE(monitor_id,external_id));
    CREATE INDEX idx_monitors_due ON monitors(enabled,next_check_at);
    CREATE INDEX idx_listings_seen ON listings(first_seen_at DESC);
    INSERT INTO monitors(name,url,interval_minutes,next_check_at,created_at) VALUES('Stary','https://allegro.pl/listing?string=stary',10,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO listings(monitor_id,external_id,title,url,first_seen_at) VALUES(1,'offer:123456','Stara oferta','https://allegro.pl/oferta/stara-123456','2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new Store(databasePath);
  try {
    store.updateMonitorSettings(1, "Stary", 1);
    assert.equal(store.getMonitor(1)?.intervalMinutes, 1);
    assert.equal(store.recentListings()[0]?.externalId, "offer:123456");
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("adds the latest-check counter to an existing current database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-current-"));
  const databasePath = path.join(directory, "current.sqlite");
  const current = new DatabaseSync(databasePath);
  current.exec(`
    CREATE TABLE monitors (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,url TEXT NOT NULL,interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(interval_minutes >= 1),enabled INTEGER NOT NULL DEFAULT 1,initialized INTEGER NOT NULL DEFAULT 0,last_checked_at TEXT,next_check_at TEXT NOT NULL,last_error TEXT,created_at TEXT NOT NULL,new_listings_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE listings (id INTEGER PRIMARY KEY AUTOINCREMENT,monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,external_id TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,price TEXT,image_url TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,missing_checks INTEGER NOT NULL DEFAULT 0,UNIQUE(monitor_id,external_id));
    INSERT INTO monitors(name,url,next_check_at,created_at,new_listings_count) VALUES('Obecny','https://allegro.pl/listing?string=test','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',7);
  `);
  current.close();

  const store = new Store(databasePath);
  try {
    assert.equal(store.getMonitor(1)?.newListingsCount, 7);
    assert.equal(store.getMonitor(1)?.lastCheckNewCount, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("migrates per-device settings from version 0.8", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-v08-"));
  const databasePath = path.join(directory, "v08.sqlite");
  const previous = new DatabaseSync(databasePath);
  previous.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE monitors (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,url TEXT NOT NULL,interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(interval_minutes >= 1),enabled INTEGER NOT NULL DEFAULT 1,initialized INTEGER NOT NULL DEFAULT 0,last_checked_at TEXT,next_check_at TEXT NOT NULL,last_error TEXT,created_at TEXT NOT NULL,new_listings_count INTEGER NOT NULL DEFAULT 0,last_check_new_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE listings (id INTEGER PRIMARY KEY AUTOINCREMENT,monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,external_id TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,price TEXT,image_url TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,missing_checks INTEGER NOT NULL DEFAULT 0,UNIQUE(monitor_id,external_id));
    CREATE TABLE extension_clients (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,last_seen_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE monitor_clients (monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,client_id INTEGER NOT NULL REFERENCES extension_clients(id) ON DELETE CASCADE,tab_open INTEGER NOT NULL DEFAULT 0,client_enabled INTEGER NOT NULL DEFAULT 1,last_seen_at TEXT NOT NULL,PRIMARY KEY(monitor_id,client_id));
    INSERT INTO monitors(name,url,next_check_at,created_at) VALUES('Test','https://allegro.pl/listing?string=test','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO extension_clients(name,token_hash,created_at) VALUES('Vivaldi','hash-v08','2026-01-01T00:00:00.000Z');
    INSERT INTO monitor_clients(monitor_id,client_id,client_enabled,last_seen_at) VALUES(1,1,0,'2026-01-01T00:00:00.000Z');
  `);
  previous.close();

  const store = new Store(databasePath);
  try {
    assert.equal(store.areNotificationsEnabledForClient(1, 1), false);
    assert.deepEqual(store.pullNotifications(1), []);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});
