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
const listing = (id: number) => ({ externalId: `offer:${100000 + id}`, title: `Book ${id}`, url: `https://allegro.pl/oferta/book-${100000 + id}`, imageUrl: null, price: "10 zł" });
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-reliability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, "test.sqlite");
  const settings = { ...config, databasePath, username: "test", password: "password", sessionSecret: "test".repeat(10), telegramBotToken: "", telegramChatIds: [] as string[] };
  return { dir, databasePath, settings };
}

test("real login endpoint blocks correct password after 20 failures, expires with controlled time and ignores spoofed IP headers", async t => {
  const { settings } = fixture(t); let now = 1000;
  const app = await buildApp({ config: settings, startWorker: false, now: () => now }); t.after(() => app.close());
  const login = (password: string, headers = {}) => app.inject({ method: "POST", url: "/login", headers, payload: { username: "test", password } });
  for (let i = 0; i < 20; i++) assert.equal((await login("wrong")).statusCode, 401);
  for (const headers of [{}, { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2", "cf-connecting-ip": "203.0.113.3", forwarded: "for=203.0.113.4" }]) {
    const blocked = await login("password", headers);
    assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers["retry-after"], "900"); assert.equal(blocked.headers["set-cookie"], undefined);
  }
  now += 900_000;
  const success = await login("password"); assert.equal(success.statusCode, 302); assert.ok(success.headers["set-cookie"]);
});

test("ACK is authenticated, client-bound, retry-safe and cannot skip future events; legacy pull advances", async t => {
  const { settings, databasePath } = fixture(t);
  const store = new Store(databasePath); t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const a = store.addExtensionClient("a", tokenHash("a")), b = store.addExtensionClient("b", tokenHash("b"));
  store.linkMonitorToAllClients(id, a); store.saveCheck(store.getMonitor(id)!, []); store.saveCheck(store.getMonitor(id)!, [listing(1)]);
  const app = await buildApp({ config: settings, startWorker: false }); t.after(() => app.close());
  const pull = async (token: string, protocol = 2) => (await app.inject({ method: "POST", url: "/api/extension/presence", headers: { authorization: `Bearer ${token}` }, payload: { monitors: [], notificationProtocol: protocol } })).json();
  const ack = (token: string, batchId: string) => app.inject({ method: "POST", url: "/api/extension/notifications/ack", headers: { authorization: `Bearer ${token}` }, payload: { batchId, throughId: 999999 } });
  const first = await pull("a"); assert.equal(first.notifications.length, 1);
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

test("notification batches are bounded, survive restart and honor per-client mute", t => {
  const { databasePath } = fixture(t); let store = new Store(databasePath);
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const a = store.addExtensionClient("a", "a"), b = store.addExtensionClient("b", "b");
  store.setNotificationsForClient(id, b, false); store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(store.getMonitor(id)!, Array.from({ length: 60 }, (_, i) => listing(i)));
  const batch = store.notificationBatch(a); assert.equal(batch.events.length, 50);
  assert.equal(store.notificationBatch(b).events.length, 0);
  store.close(); store = new Store(databasePath); t.after(() => store.close());
  assert.deepEqual(store.notificationBatch(a), JSON.parse(JSON.stringify(batch))); store.acknowledgeNotifications(a, batch.batchId);
  assert.equal(store.notificationBatch(a).events.length, 10);
});

test("Telegram success, photo fallback, network, timeout, rate limit and permanent failures", async () => {
  for (const status of [200, 400, 401, 403, 429, 500]) {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(JSON.stringify({ ok: status === 200 || calls === 2, parameters: { retry_after: 25 } }), { status: calls === 2 ? 200 : status }); }) as typeof fetch;
    const promise = deliverTelegram("test", "1", "test", { ...listing(1), imageUrl: "https://example.com/image.jpg" }, fetcher);
    if (status === 200 || status === 400) await promise;
    else await assert.rejects(promise, (error: TelegramError) => {
      assert.equal(error.permanent, status === 401 || status === 403);
      assert.equal(error.retryAfterMs, status === 429 ? 25000 : 0); return true;
    });
    assert.equal(calls, status === 400 ? 2 : 1);
  }
  await assert.rejects(deliverTelegram("test", "1", "test", listing(1), (async () => { throw Error("network"); }) as typeof fetch), /network/);
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(deliverTelegram("test", "1", "test", listing(1), ((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
    })) as typeof fetch, 5), /timeout/i);
  } finally { clearInterval(keepAlive); }
});

test("outbox persists partial success, retries with backoff/retry_after and recovers leased work after restart", async t => {
  const { databasePath } = fixture(t); let store = new Store(databasePath);
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  store.saveCheck(store.getMonitor(id)!, []); store.saveCheck(store.getMonitor(id)!, [listing(1)], ["1", "2", "3"]);
  let now = Date.now() + 1; const sent: string[] = [];
  const worker = new TelegramWorker(store, "test", async (_token, chat) => { sent.push(chat); if (chat === "2") throw new TelegramError("429", false, 25000); if (chat === "3") throw new TelegramError("403", true); }, () => now);
  await Promise.all([worker.runOnce(), worker.runOnce()]); assert.deepEqual(sent, ["1"]);
  await worker.runOnce(); await worker.runOnce(); await worker.runOnce(); assert.deepEqual(sent, ["1", "2", "3"]);
  now += 24999; await worker.runOnce(); assert.equal(sent.length, 3);
  now += 1;
  const interrupted = store.claimTelegramJob(now)!; assert.equal(interrupted.chatId, "2");
  store.close(); store = new Store(databasePath); t.after(() => store.close());
  const restarted = new TelegramWorker(store, "test", async (_token, chat) => { sent.push(chat); }, () => now);
  await restarted.runOnce(); assert.equal(sent.length, 3);
  now += 60000; await restarted.runOnce(); await restarted.runOnce(); assert.deepEqual(sent, ["1", "2", "3", "2"]);
});

test("results endpoint commits recipient jobs without contacting Telegram; no configuration still monitors", async t => {
  const { settings, databasePath } = fixture(t); const store = new Store(databasePath); t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5); const client = store.addExtensionClient("a", tokenHash("a"));
  store.linkMonitorClient(id, client); store.saveCheck(store.getMonitor(id)!, []);
  const app = await buildApp({ config: { ...settings, telegramBotToken: "test", telegramChatIds: ["1", "2"] }, startWorker: false }); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/api/extension/monitors/${id}/results`, headers: { authorization: "Bearer a" }, payload: { listings: [listing(1)] } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().newListings.length, 1);
  assert.equal(store.claimTelegramJob()!.chatId, "1"); assert.equal(store.claimTelegramJob()!.chatId, "2");
  assert.equal(store.saveCheck(store.getMonitor(id)!, [listing(1), listing(2)]).length, 1);
  assert.equal(store.claimTelegramJob(), undefined);
});

test("migration from audited schema preserves monitors, exclusions, paired devices, settings and sessions", async t => {
  const { dir, databasePath } = fixture(t);
  const baseline = new DatabaseSync(databasePath);
  baseline.exec(fs.readFileSync("test/fixtures/audited-schema.sql", "utf8")); baseline.close();
  // Seed the old schema before running the migration.
  const seed = new DatabaseSync(databasePath);
  seed.exec(`INSERT INTO monitors(id,name,url,interval_minutes,next_check_at,created_at,initialized,enabled) VALUES(1,'kept','https://allegro.pl/listing?string=test',15,'2026-01-01','2026-01-01',1,0);
    INSERT INTO extension_clients(id,name,token_hash,created_at) VALUES(1,'device','hash','2026-01-01');
    INSERT INTO monitor_clients(monitor_id,client_id,notifications_enabled,last_seen_at) VALUES(1,1,0,'2026-01-01');
    INSERT INTO monitor_exclusions(monitor_id,external_id,title,created_at) VALUES(1,'offer:100001','Book 1','2026-01-01');`);
  seed.prepare("INSERT INTO web_sessions(token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES('session','fingerprint',3600,?,'2026-01-01','2026-01-01')").run(new Date(Date.now()+3600000).toISOString());
  seed.close();
  const id = 1, client = 1;
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(databasePath);
    assert.equal(store.getMonitor(id)!.name, "kept"); assert.equal(store.getMonitor(id)!.enabled, 0); assert.equal(store.getMonitor(id)!.intervalMinutes, 15);
    assert.equal(store.touchExtensionClient("hash"), client); assert.equal(store.areNotificationsEnabledForClient(id, client), false);
    assert.equal(store.listExclusions().length, 1); assert.equal(store.touchWebSession("session", "fingerprint"), 3600); store.close();
  }
  const db = new DatabaseSync(databasePath); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []); db.close();
});

test("outbox insertion failure rolls back listings and events; completion retention and retry ceiling are bounded", t => {
  const { databasePath } = fixture(t); const store = new Store(databasePath); t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  store.saveCheck(store.getMonitor(id)!, []);
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_job BEFORE INSERT ON telegram_jobs BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => store.saveCheck(store.getMonitor(id)!, [listing(1)], ["1"]), /test failure/);
  assert.equal(store.recentListings().length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM notification_events").get() as { n: number }).n, 0);
  assert.equal(store.getMonitor(id)!.newListingsCount, 0);
  db.exec("DROP TRIGGER reject_job"); store.saveCheck(store.getMonitor(id)!, [listing(1)], ["1"]);
  db.exec("UPDATE telegram_jobs SET attempts=11");
  const now = Date.now() + 1; const job = store.claimTelegramJob(now)!;
  store.finishTelegramJob(job, { permanent: false, retryAfterMs: 0, message: "network" }, now);
  assert.equal((db.prepare("SELECT status FROM telegram_jobs").get() as { status: string }).status, "failed");
  assert.equal(store.claimTelegramJob(now + 31 * 86400_000), undefined);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM telegram_jobs").get() as { n: number }).n, 0);
});
