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
import { deliverTelegram, TelegramError, TelegramWorker } from "../src/notifications.js";
import type { Listing } from "../src/types.js";
const listing = (id: number) => ({
  externalId: `offer:${100000 + id}`,
  title: `Book ${id}`,
  url: `https://allegro.pl/oferta/book-${100000 + id}`,
  imageUrl: null,
  price: "10 zł",
});
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-reliability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, "test.sqlite");
  const settings = {
    ...config,
    databasePath,
    username: "test",
    password: "password",
    sessionSecret: "test".repeat(10),
    telegramBotToken: "",
    telegramChatIds: [] as string[],
  };
  const clock = { time: 1800000000000, now: () => clock.time };
  return { dir, databasePath, settings, clock };
}

test("real login endpoint blocks correct password after 20 failures, expires with controlled time and ignores spoofed IP headers", async (t) => {
  const { settings } = fixture(t);
  let now = 1000;
  const app = await buildApp({ config: settings, startWorker: false, now: () => now });
  t.after(() => app.close());
  const login = (password: string, headers = {}) =>
    app.inject({ method: "POST", url: "/login", headers, payload: { username: "test", password } });
  for (let i = 0; i < 20; i++) assert.equal((await login("wrong")).statusCode, 401);
  for (const headers of [
    {},
    {
      "x-forwarded-for": "203.0.113.1",
      "x-real-ip": "203.0.113.2",
      "cf-connecting-ip": "203.0.113.3",
      forwarded: "for=203.0.113.4",
    },
  ]) {
    const blocked = await login("password", headers);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers["retry-after"], "900");
    assert.equal(blocked.headers["set-cookie"], undefined);
  }
  now += 900_000;
  const success = await login("password");
  assert.equal(success.statusCode, 302);
  assert.ok(success.headers["set-cookie"]);
});

test("ACK is authenticated, client-bound, retry-safe and cannot skip future events; legacy pull advances", async (t) => {
  const { settings, databasePath, clock } = fixture(t);
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const a = store.addExtensionClient("a", tokenHash("a")),
    b = store.addExtensionClient("b", tokenHash("b"));
  store.linkMonitorToAllClients(id, a);
  store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(store.getMonitor(id)!, [listing(1)]);
  const app = await buildApp({ config: settings, startWorker: false, now: clock.now });
  t.after(() => app.close());
  const pull = async (token: string, protocol = 2) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/extension/presence",
        headers: { authorization: `Bearer ${token}` },
        payload: { monitors: [], notificationProtocol: protocol },
      })
    ).json();
  const ack = (token: string, batchId: string) =>
    app.inject({
      method: "POST",
      url: "/api/extension/notifications/ack",
      headers: { authorization: `Bearer ${token}` },
      payload: { batchId, throughId: 999999 },
    });
  const first = await pull("a");
  assert.equal(first.notifications.length, 1);
  const login = await app.inject({
    method: "POST",
    url: "/login",
    payload: { username: settings.username, password: settings.password },
  });
  assert.equal(login.statusCode, 302);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const snapshot = () =>
    ["extension_clients", "monitor_clients", "notification_batches", "notification_events"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  const before = snapshot();
  for (const url of ["/api/extension/presence", "/api/extension/notifications/ack"]) {
    for (const headers of [{}, { cookie }, { cookie, authorization: "Bearer invalid" }]) {
      const rejected = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { monitors: [{ id, open: false }], device: { os: "forged" }, batchId: first.notificationBatch },
      });
      assert.equal(rejected.statusCode, 401);
      assert.deepEqual(rejected.json(), { error: "Nieprawidłowy token rozszerzenia" });
      assert.deepEqual(snapshot(), before);
    }
  }
  for (const batchId of [undefined, null, 1, false, [], {}, "x".repeat(101)]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/extension/notifications/ack",
      headers: { authorization: "Bearer a" },
      payload: { batchId },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: "Nieprawidłowy ACK" });
    assert.deepEqual(snapshot(), before);
  }
  assert.deepEqual(await pull("a"), first); // response loss replays the persisted batch
  assert.equal((await ack("invalid", first.notificationBatch)).statusCode, 401);
  assert.equal((await ack("b", first.notificationBatch)).json().acknowledged, false);
  assert.equal((await ack("a", "999999")).json().acknowledged, false);
  assert.deepEqual(await pull("a"), first);
  assert.equal((await ack("a", first.notificationBatch)).json().acknowledged, true);
  assert.equal((await ack("a", first.notificationBatch)).json().acknowledged, false);
  assert.equal((await pull("a")).notifications.length, 0);
  assert.equal((await pull("b", 1)).notifications.length, 1);
  assert.equal((await pull("b", 1)).notifications.length, 0);
  assert.notEqual(a, b);
});

test("presence preserves synchronized fields, ID conversion, device metadata and strict protocol selection", async (t) => {
  const { settings, databasePath, clock } = fixture(t);
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const id = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  clock.time += 1;
  const paused = store.createMonitor("Paused", "https://allegro.pl/listing?string=paused", 15);
  store.toggleMonitor(paused);
  const client = store.addExtensionClient("a", tokenHash("a"));
  store.setNotificationsForClient(paused, client, false);
  store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(store.getMonitor(id)!, [listing(1)]);
  const app = await buildApp({ config: settings, startWorker: false, now: clock.now });
  t.after(() => app.close());
  const presence = (payload: object) =>
    app.inject({ method: "POST", url: "/api/extension/presence", headers: { authorization: "Bearer a" }, payload });
  for (const monitors of [undefined, null, {}, "text", Array.from({ length: 101 }, () => ({ id }))]) {
    const rejected = await presence({ monitors, device: { os: "forged" } });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: "Nieprawidłowa lista obecności" });
    assert.equal(store.listExtensionClients()[0]!.os, null);
    assert.equal(store.hasMonitorClient(id, client), false);
  }
  const payload = {
    monitors: [
      { id: String(id), open: true },
      { id, open: true },
      { id: 0 },
      { id: 99999 },
      { id: "invalid" },
      { id: paused, open: "true" },
    ],
    device: { extensionVersion: " 1.2.0 ", browser: " Chromium ", os: " Linux ", osVersion: " ", arch: null },
    notificationProtocol: 2,
  };
  const response = await presence(payload);
  assert.equal(response.statusCode, 200);
  const first = response.json();
  const version = String(
    JSON.parse(fs.readFileSync(path.join(settings.extensionDirectory, "manifest.json"), "utf8")).version,
  );
  assert.deepEqual(Object.keys(first).sort(), [
    "latestExtensionVersion",
    "monitors",
    "notificationBatch",
    "notifications",
    "updated",
  ]);
  assert.equal(first.updated, 3);
  assert.equal(first.latestExtensionVersion, version);
  assert.deepEqual(first.monitors, [
    {
      id: paused,
      name: "Paused",
      url: "https://allegro.pl/listing?string=paused",
      intervalMinutes: 15,
      enabled: false,
      newListingsCount: 0,
      lastCheckNewCount: 0,
      activeClientsCount: 0,
      notificationsEnabled: false,
    },
    {
      id,
      name: "Books",
      url: "https://allegro.pl/listing?string=books",
      intervalMinutes: 5,
      enabled: true,
      newListingsCount: 1,
      lastCheckNewCount: 1,
      activeClientsCount: 1,
      notificationsEnabled: true,
    },
  ]);
  const device = store.listExtensionClients()[0]!;
  assert.deepEqual(
    [device.extensionVersion, device.browser, device.os, device.osVersion, device.arch],
    ["1.2.0", "Chromium", "Linux", null, null],
  );
  assert.equal(first.notifications.length, 1);
  assert.equal(typeof first.notificationBatch, "string");
  assert.deepEqual((await presence(payload)).json(), first);
  const legacy = await presence({ ...payload, notificationProtocol: "2" });
  assert.equal(legacy.statusCode, 200);
  const { notificationBatch, ...withoutBatch } = first;
  assert.deepEqual(legacy.json(), withoutBatch);
  assert.equal((await presence({ monitors: [] })).json().notifications.length, 0);
});

test("notification batches are bounded, survive restart and honor per-client mute", (t) => {
  const { databasePath, clock } = fixture(t);
  let store = new Store(databasePath, undefined, clock.now);
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const a = store.addExtensionClient("a", "a"),
    b = store.addExtensionClient("b", "b");
  store.setNotificationsForClient(id, b, false);
  store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(
    store.getMonitor(id)!,
    Array.from({ length: 60 }, (_, i) => listing(i)),
  );
  const batch = store.notificationBatch(a);
  assert.equal(batch.events.length, 50);
  assert.equal(store.notificationBatch(b).events.length, 0);
  store.close();
  store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  assert.deepEqual(store.notificationBatch(a), JSON.parse(JSON.stringify(batch)));
  store.acknowledgeNotifications(a, batch.batchId);
  assert.equal(store.notificationBatch(a).events.length, 10);
});

test("muted events count towards the scan limit and pending batches use current notification settings", (t) => {
  const { databasePath, clock } = fixture(t);
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const muted = store.createMonitor("Muted", "https://allegro.pl/listing?string=muted", 5);
  const audible = store.createMonitor("Audible", "https://allegro.pl/listing?string=audible", 5);
  const client = store.addExtensionClient("device", "hash");
  store.setNotificationsForClient(muted, client, false);
  store.saveCheck(store.getMonitor(muted)!, []);
  store.saveCheck(store.getMonitor(audible)!, []);
  store.saveCheck(
    store.getMonitor(muted)!,
    Array.from({ length: 55 }, (_, i) => listing(i)),
  );
  store.saveCheck(store.getMonitor(audible)!, [listing(99)]);
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const cursor = () =>
    db.prepare("SELECT last_notification_event_id n FROM extension_clients WHERE id=?").get(client)!.n;
  const first = store.notificationBatch(client);
  assert.deepEqual(first.events, []);
  assert.equal(db.prepare("SELECT through_id n FROM notification_batches WHERE client_id=?").get(client)!.n, 50);
  assert.equal(cursor(), 0);
  assert.deepEqual(store.notificationBatch(client), first);
  assert.equal(store.acknowledgeNotifications(client, first.batchId), true);
  assert.equal(cursor(), 50);
  const second = store.notificationBatch(client);
  assert.notEqual(second.batchId, first.batchId);
  assert.deepEqual(
    second.events.map((event) => event.externalId),
    [listing(99).externalId],
  );
  store.setNotificationsForClient(audible, client, false);
  assert.deepEqual(store.notificationBatch(client), { batchId: second.batchId, events: [] });
  store.setNotificationsForClient(audible, client, true);
  assert.deepEqual(store.notificationBatch(client), JSON.parse(JSON.stringify(second)));
  assert.equal(cursor(), 50);
  assert.equal(store.acknowledgeNotifications(client, second.batchId), true);
  assert.equal(cursor(), 56);
  const empty = store.notificationBatch(client);
  assert.deepEqual(empty.events, []);
  assert.deepEqual(store.notificationBatch(client), empty);
  assert.equal(store.acknowledgeNotifications(client, empty.batchId), true);
  assert.equal(cursor(), 56);
});

test("failed ACK rolls back the cursor and batch deletion; retry preserves a cursor already advanced", (t) => {
  const { databasePath, clock } = fixture(t);
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const monitor = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  const client = store.addExtensionClient("device", "hash");
  store.saveCheck(store.getMonitor(monitor)!, []);
  store.saveCheck(store.getMonitor(monitor)!, [listing(1)]);
  const batch = store.notificationBatch(client);
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const snapshot = () => [
    db.prepare("SELECT * FROM extension_clients").all(),
    db.prepare("SELECT * FROM notification_batches").all(),
  ];
  const before = snapshot();
  db.exec(
    "CREATE TRIGGER reject_ack BEFORE DELETE ON notification_batches BEGIN SELECT RAISE(ABORT,'ACK rollback'); END",
  );
  assert.throws(() => store.acknowledgeNotifications(client, batch.batchId), /ACK rollback/);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(store.notificationBatch(client), JSON.parse(JSON.stringify(batch)));
  db.exec("DROP TRIGGER reject_ack");
  store.saveCheck(store.getMonitor(monitor)!, [listing(1), listing(2)]);
  db.prepare(
    "UPDATE extension_clients SET last_notification_event_id=(SELECT MAX(id) FROM notification_events) WHERE id=?",
  ).run(client);
  const advanced = db.prepare("SELECT last_notification_event_id n FROM extension_clients WHERE id=?").get(client)!.n;
  assert.equal(advanced, 2);
  assert.equal(store.acknowledgeNotifications(client, batch.batchId), true);
  assert.equal(store.acknowledgeNotifications(client, batch.batchId), false);
  assert.equal(
    db.prepare("SELECT last_notification_event_id n FROM extension_clients WHERE id=?").get(client)!.n,
    advanced,
  );
  assert.deepEqual(db.prepare("SELECT * FROM notification_batches").all(), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Telegram success, photo fallback, network, timeout, rate limit and permanent failures", async () => {
  for (const status of [200, 400, 401, 403, 429, 500]) {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ ok: status === 200 || calls === 2, parameters: { retry_after: 25 } }), {
        status: calls === 2 ? 200 : status,
      });
    }) as typeof fetch;
    const promise = deliverTelegram(
      "test",
      "1",
      "test",
      { ...listing(1), imageUrl: "https://a.allegroimg.com/image.jpg" },
      fetcher,
    );
    if (status === 200 || status === 400) await promise;
    else
      await assert.rejects(promise, (error: TelegramError) => {
        assert.equal(error.permanent, status === 401 || status === 403);
        assert.equal(error.retryAfterMs, status === 429 ? 25000 : 0);
        return true;
      });
    assert.equal(calls, status === 400 ? 2 : 1);
  }
  await assert.rejects(
    deliverTelegram("test", "1", "test", listing(1), (async () => {
      throw Error("network");
    }) as typeof fetch),
    /network/,
  );
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(
      deliverTelegram(
        "test",
        "1",
        "test",
        listing(1),
        ((_input, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
          })) as typeof fetch,
        5,
      ),
      /timeout/i,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test("outbox persists partial success, retries with backoff/retry_after and recovers leased work after restart", async (t) => {
  const { databasePath, clock } = fixture(t);
  let store = new Store(databasePath, undefined, clock.now);
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(store.getMonitor(id)!, [listing(1)], ["1", "2", "3"]);
  const sent: string[] = [];
  const worker = new TelegramWorker(
    store,
    "test",
    async (_token, chat) => {
      sent.push(chat);
      if (chat === "2") throw new TelegramError("429", false, 25000);
      if (chat === "3") throw new TelegramError("403", true);
    },
    clock.now,
  );
  await Promise.all([worker.runOnce(), worker.runOnce()]);
  assert.deepEqual(sent, ["1"]);
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  assert.deepEqual(sent, ["1", "2", "3"]);
  clock.time += 24999;
  await worker.runOnce();
  assert.equal(sent.length, 3);
  clock.time += 1;
  const interrupted = store.claimTelegramJob(clock.now())!;
  assert.equal(interrupted.chatId, "2");
  store.close();
  store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const restarted = new TelegramWorker(
    store,
    "test",
    async (_token, chat) => {
      sent.push(chat);
    },
    clock.now,
  );
  await restarted.runOnce();
  assert.equal(sent.length, 3);
  clock.time += 60000;
  await restarted.runOnce();
  await restarted.runOnce();
  assert.deepEqual(sent, ["1", "2", "3", "2"]);
});

test("results endpoint commits recipient jobs without contacting Telegram; no configuration still monitors", async (t) => {
  const { settings, databasePath, clock } = fixture(t);
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const client = store.addExtensionClient("a", tokenHash("a"));
  store.linkMonitorClient(id, client);
  store.saveCheck(store.getMonitor(id)!, []);
  const app = await buildApp({
    config: { ...settings, telegramBotToken: "test", telegramChatIds: ["1", "2"] },
    now: clock.now,
    startWorker: false,
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: `/api/extension/monitors/${id}/results`,
    headers: { authorization: "Bearer a" },
    payload: { listings: [listing(1)] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().newListings.length, 1);
  assert.equal(store.claimTelegramJob()!.chatId, "1");
  assert.equal(store.claimTelegramJob()!.chatId, "2");
  assert.equal(store.saveCheck(store.getMonitor(id)!, [listing(1), listing(2)]).length, 1);
  assert.equal(store.claimTelegramJob(), undefined);
});

test("without Telegram token the backend serves extension notifications and leaves existing Telegram jobs untouched", async (t) => {
  const { settings, databasePath, clock } = fixture(t);
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const client = store.addExtensionClient("a", tokenHash("a"));
  store.linkMonitorClient(id, client);
  store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(store.getMonitor(id)!, [listing(1)], ["1"]);
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const queued = () => db.prepare("SELECT * FROM telegram_jobs ORDER BY id").all();
  const before = queued();
  assert.equal(before.length, 1);
  let sent = 0;
  const worker = new TelegramWorker(
    store,
    "",
    async () => {
      sent++;
    },
    clock.now,
  );
  worker.start();
  await worker.runOnce();
  await worker.stop();
  assert.equal(sent, 0);
  assert.deepEqual(queued(), before);
  const app = await buildApp({
    config: { ...settings, publicUrl: "https://monitor.example", telegramBotToken: "", telegramChatIds: ["1"] },
    now: clock.now,
  });
  t.after(() => app.close());
  assert.equal((await app.inject("/health")).statusCode, 200);
  const headers = { authorization: "Bearer a" };
  const response = await app.inject({
    method: "POST",
    url: `/api/extension/monitors/${id}/results`,
    headers,
    payload: { listings: [listing(1), listing(2)] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().accepted, 2);
  assert.deepEqual(
    response.json().newListings.map((item: Listing) => item.externalId),
    [listing(2).externalId],
  );
  const presence = (
    await app.inject({
      method: "POST",
      url: "/api/extension/presence",
      headers,
      payload: { monitors: [{ id, open: true }], notificationProtocol: 2 },
    })
  ).json();
  assert.deepEqual(
    presence.notifications.map((item: Listing) => item.externalId),
    [listing(1).externalId, listing(2).externalId],
  );
  const ack = await app.inject({
    method: "POST",
    url: "/api/extension/notifications/ack",
    headers,
    payload: { batchId: presence.notificationBatch },
  });
  assert.equal(ack.statusCode, 200);
  assert.equal(ack.json().acknowledged, true);
  assert.deepEqual(queued(), before);
});

test("migration from audited schema preserves monitors, exclusions, paired devices, settings and sessions", async (t) => {
  const { databasePath, clock } = fixture(t);
  const baseline = new DatabaseSync(databasePath);
  baseline.exec(fs.readFileSync("test/fixtures/audited-schema.sql", "utf8"));
  baseline.close();
  // Seed the old schema before running the migration.
  const seed = new DatabaseSync(databasePath);
  seed.exec(`INSERT INTO monitors(id,name,url,interval_minutes,next_check_at,created_at,initialized,enabled) VALUES(1,'kept','https://allegro.pl/listing?string=test',15,'2026-01-01','2026-01-01',1,0);
    INSERT INTO extension_clients(id,name,token_hash,created_at) VALUES(1,'device','hash','2026-01-01');
    INSERT INTO monitor_clients(monitor_id,client_id,notifications_enabled,last_seen_at) VALUES(1,1,0,'2026-01-01');
    INSERT INTO monitor_exclusions(monitor_id,external_id,title,created_at) VALUES(1,'offer:100001','Book 1','2026-01-01');`);
  seed
    .prepare(
      "INSERT INTO web_sessions(token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES('session','fingerprint',3600,?,'2026-01-01','2026-01-01')",
    )
    .run(new Date(clock.now() + 3600000).toISOString());
  seed.close();
  const id = 1,
    client = 1;
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(databasePath, undefined, clock.now);
    assert.equal(store.getMonitor(id)!.name, "kept");
    assert.equal(store.getMonitor(id)!.enabled, 0);
    assert.equal(store.getMonitor(id)!.intervalMinutes, 15);
    assert.equal(store.touchExtensionClient("hash"), client);
    assert.equal(store.areNotificationsEnabledForClient(id, client), false);
    assert.equal(store.listExclusions().length, 1);
    assert.equal(store.touchWebSession("session", "fingerprint"), 3600);
    store.close();
  }
  const db = new DatabaseSync(databasePath);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("outbox insertion failure rolls back listings and events; completion retention and retry ceiling are bounded", (t) => {
  const { databasePath, clock } = fixture(t);
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  store.saveCheck(store.getMonitor(id)!, []);
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_job BEFORE INSERT ON telegram_jobs BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => store.saveCheck(store.getMonitor(id)!, [listing(1)], ["1"]), /test failure/);
  assert.equal(store.recentListings().length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM notification_events").get() as { n: number }).n, 0);
  assert.equal(store.getMonitor(id)!.newListingsCount, 0);
  db.exec("DROP TRIGGER reject_job");
  store.saveCheck(store.getMonitor(id)!, [listing(1)], ["1"]);
  db.exec("UPDATE telegram_jobs SET attempts=11");
  const now = clock.now();
  const job = store.claimTelegramJob(now)!;
  store.finishTelegramJob(job, { permanent: false, retryAfterMs: 0, message: "network" }, now);
  assert.equal((db.prepare("SELECT status FROM telegram_jobs").get() as { status: string }).status, "failed");
  assert.equal(store.claimTelegramJob(now + 31 * 86400_000), undefined);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM telegram_jobs").get() as { n: number }).n, 0);
});
