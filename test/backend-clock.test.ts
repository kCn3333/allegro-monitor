import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";
import { Store } from "../src/database.js";
import { buildApp } from "../src/server.js";

const start = Date.parse("2030-01-01T00:00:00.000Z");
const day = 86400_000;
const listing = {
  externalId: "offer:123456",
  title: "Book",
  url: "https://allegro.pl/oferta/book-123456",
  price: null,
  imageUrl: null,
};
const iso = (time: number) => new Date(time).toISOString();
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-clock-"));
  const clock = {
    time: start,
    reads: 0,
    now: () => {
      clock.reads += 1;
      return clock.time;
    },
  };
  const settings = {
    ...config,
    databasePath: path.join(dir, "test.sqlite"),
    username: "test",
    password: "password",
    sessionSecret: "s".repeat(32),
    telegramBotToken: "",
    telegramChatIds: [] as string[],
  };
  const store = new Store(settings.databasePath, undefined, clock.now);
  const db = new DatabaseSync(settings.databasePath);
  t.after(() => {
    db.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const row = (sql: string) => db.prepare(sql).get()!;
  const monitor = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const enqueue = () => {
    store.saveCheck(store.getMonitor(monitor)!, []);
    store.saveCheck(store.getMonitor(monitor)!, [listing], ["1"]);
  };
  return { store, db, row, clock, settings, monitor, enqueue };
}

test("Store timestamps follow the injected clock without rewriting historical timestamps", (t) => {
  const { store, row, clock, monitor, enqueue } = fixture(t);
  assert.equal(row("SELECT created_at FROM monitors").created_at, iso(start));
  assert.equal(row("SELECT next_check_at FROM monitors").next_check_at, iso(start));
  clock.time += 1000;
  const client = store.addExtensionClient("a", "hash");
  assert.equal(row("SELECT created_at FROM extension_clients").created_at, iso(clock.time));
  store.touchExtensionClient("hash");
  assert.equal(row("SELECT last_seen_at FROM extension_clients").last_seen_at, iso(clock.time));
  for (const link of [
    () => store.linkClientToAllMonitors(client),
    () => store.linkMonitorClient(monitor, client),
    () => store.setNotificationsForClient(monitor, client, true),
  ]) {
    clock.time += 1000;
    link();
    assert.equal(row("SELECT last_seen_at FROM monitor_clients").last_seen_at, iso(clock.time));
  }
  const second = store.addExtensionClient("b", "second");
  clock.time += 1000;
  store.linkMonitorToAllClients(monitor, second);
  assert.equal(row(`SELECT last_seen_at FROM monitor_clients WHERE client_id=${second}`).last_seen_at, iso(clock.time));
  clock.time += 1000;
  enqueue();
  const firstSeen = clock.time;
  for (const sql of [
    "SELECT first_seen_at timestamp FROM listings",
    "SELECT last_seen_at timestamp FROM listings",
    "SELECT last_checked_at timestamp FROM monitors",
    "SELECT created_at timestamp FROM notification_events",
  ]) {
    assert.equal(row(sql).timestamp, iso(clock.time));
  }
  assert.equal(row("SELECT available_at FROM telegram_jobs").available_at, clock.time);
  clock.time += 1000;
  store.notificationBatch(client);
  assert.equal(row("SELECT created_at FROM notification_batches").created_at, iso(clock.time));
  clock.time += 1000;
  store.addExclusion(monitor, listing.externalId);
  assert.equal(row("SELECT created_at FROM monitor_exclusions").created_at, iso(clock.time));
  clock.time += 1000;
  store.saveError(store.getMonitor(monitor)!, Error("test"));
  assert.equal(row("SELECT last_checked_at FROM monitors").last_checked_at, iso(clock.time));
  clock.time += 1000;
  store.saveCheck(store.getMonitor(monitor)!, [listing]);
  assert.equal(row("SELECT first_seen_at FROM listings").first_seen_at, iso(firstSeen));
  assert.equal(row("SELECT last_seen_at FROM listings").last_seen_at, iso(clock.time));
  assert.equal(row("SELECT created_at FROM monitors").created_at, iso(start));
});

for (const duration of [12 * 3600, 30 * 86400]) {
  for (const offset of [-1, 0, 1]) {
    test(`session ${duration}s at expiry ${offset}ms preserves expiry and sliding renewal`, (t) => {
      const { store, row, clock } = fixture(t);
      store.createWebSession("token", "fingerprint", duration);
      assert.equal(row("SELECT expires_at FROM web_sessions").expires_at, iso(start + duration * 1000));
      clock.time = start + duration * 1000 + offset;
      assert.equal(store.touchWebSession("token", "fingerprint"), offset < 0 ? duration : null);
      if (offset < 0) {
        assert.equal(row("SELECT created_at FROM web_sessions").created_at, iso(start));
        assert.equal(row("SELECT last_used_at FROM web_sessions").last_used_at, iso(clock.time));
        assert.equal(row("SELECT expires_at FROM web_sessions").expires_at, iso(clock.time + duration * 1000));
        clock.time += duration * 1000;
        assert.equal(store.touchWebSession("token", "fingerprint"), null);
      }
      assert.equal(row("SELECT COUNT(*) n FROM web_sessions").n, 0);
    });
  }
}

for (const offset of [-1, 0, 1]) {
  test(`device and open tab activity at three minutes ${offset}ms`, (t) => {
    const { store, clock, monitor } = fixture(t);
    const client = store.addExtensionClient("a", "hash");
    store.touchExtensionClient("hash");
    store.linkMonitorClient(monitor, client);
    clock.time = start + 180_000 + offset;
    const active = offset <= 0 ? 1 : 0;
    assert.equal(store.listMonitors()[0]!.activeClientsCount, active);
    assert.equal(store.listExtensionClients()[0]!.active, active);
    assert.equal(store.listExtensionClients()[0]!.openMonitorsCount, active);
    // Explicit observation times still override the Store clock.
    assert.equal(store.listExtensionClients(start)[0]!.active, 1);
    assert.equal(store.listExtensionClients(start + 180_001)[0]!.openMonitorsCount, 0);
  });

  test(`notification/ACK and completed Telegram retention at thirty days ${offset}ms`, (t) => {
    const { store, row, clock, enqueue } = fixture(t);
    const client = store.addExtensionClient("a", "hash");
    enqueue();
    const batch = store.notificationBatch(client);
    assert.equal(batch.events.length, 1);
    store.finishTelegramJob(store.claimTelegramJob()!);
    clock.time = start + 30 * day + offset;
    const next = store.notificationBatch(client);
    assert.equal(next.events.length, offset <= 0 ? 1 : 0);
    assert.equal(next.batchId === batch.batchId, offset <= 0);
    assert.equal(row("SELECT COUNT(*) n FROM notification_events").n, offset <= 0 ? 1 : 0);
    assert.equal(store.claimTelegramJob(), undefined);
    assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, offset <= 0 ? 1 : 0);
    assert.equal(store.acknowledgeNotifications(client, batch.batchId), offset <= 0);
  });

  test(`Telegram initial availability and lease at their deadlines ${offset}ms`, (t) => {
    const { store, clock, enqueue } = fixture(t);
    enqueue();
    clock.time = start + offset;
    const initial = store.claimTelegramJob();
    assert.equal(Boolean(initial), offset >= 0);
    clock.time = start;
    const job = initial || store.claimTelegramJob()!;
    assert.equal(job.attempts, 1);
    const claimedAt = start + Math.max(0, offset);
    clock.time = claimedAt + 60_000 + offset;
    const recovered = store.claimTelegramJob();
    assert.equal(Boolean(recovered), offset >= 0);
    if (recovered) {
      assert.equal(recovered.id, job.id);
      assert.equal(recovered.attempts, 2);
    }
  });

  for (const retryAfterMs of [0, 25_000]) {
    test(`Telegram retry_after=${retryAfterMs} at deadline ${offset}ms`, (t) => {
      const { store, row, clock, enqueue } = fixture(t);
      enqueue();
      const job = store.claimTelegramJob()!;
      clock.time += 100;
      store.finishTelegramJob(job, { permanent: false, retryAfterMs, message: "retry" });
      const deadline = clock.time + Math.max(retryAfterMs, 2000);
      assert.equal(row("SELECT available_at FROM telegram_jobs").available_at, deadline);
      clock.time = deadline + offset;
      const retried = store.claimTelegramJob();
      assert.equal(Boolean(retried), offset >= 0);
      if (retried) assert.equal(retried.attempts, 2);
    });
  }
}

test("explicit Telegram claim/completion times override the injected clock", (t) => {
  const { store, row, clock, enqueue } = fixture(t);
  enqueue();
  clock.time = start - 1000;
  const reads = clock.reads;
  assert.equal(store.claimTelegramJob(), undefined);
  assert.equal(clock.reads, reads + 1);
  const job = store.claimTelegramJob(start)!;
  assert.equal(row("SELECT available_at FROM telegram_jobs").available_at, start + 60_000);
  store.finishTelegramJob(job, undefined, start + 123);
  assert.equal(row("SELECT finished_at FROM telegram_jobs").finished_at, start + 123);
  assert.equal(clock.reads, reads + 1); // Both explicit times bypass the injected clock.
  store.finishTelegramJob(job);
  assert.equal(clock.reads, reads + 2);
  assert.equal(row("SELECT finished_at FROM telegram_jobs").finished_at, start + 123);
});

test("stale Telegram completions cannot overwrite a renewed lease, pending retry or completed job", (t) => {
  const { store, row, clock, enqueue } = fixture(t);
  enqueue();
  const original = store.claimTelegramJob()!;
  clock.time += 60000;
  const renewed = store.claimTelegramJob()!;
  assert.equal(renewed.id, original.id);
  assert.equal(renewed.attempts, original.attempts + 1);
  const leased = row("SELECT * FROM telegram_jobs");
  for (const error of [undefined, { permanent: true, retryAfterMs: 0, message: "late failure" }]) {
    store.finishTelegramJob(original, error);
    assert.deepEqual(row("SELECT * FROM telegram_jobs"), leased);
  }
  store.finishTelegramJob(renewed, { permanent: false, retryAfterMs: 25000, message: "retry" });
  const pending = row("SELECT * FROM telegram_jobs");
  assert.equal(pending.status, "pending");
  assert.equal(pending.available_at, clock.time + 25000);
  store.finishTelegramJob(renewed);
  assert.deepEqual(row("SELECT * FROM telegram_jobs"), pending);
  clock.time += 25000;
  const retried = store.claimTelegramJob()!;
  assert.equal(retried.attempts, renewed.attempts + 1);
  store.finishTelegramJob(retried);
  const finished = row("SELECT * FROM telegram_jobs");
  assert.equal(finished.status, "sent");
  store.finishTelegramJob(renewed, { permanent: true, retryAfterMs: 0, message: "late failure" });
  assert.deepEqual(row("SELECT * FROM telegram_jobs"), finished);
});

for (const remember of [false, true]) {
  test(`buildApp shares the login/session clock (remember=${remember})`, async (t) => {
    const { settings, clock, row } = fixture(t);
    const app = await buildApp({ config: settings, now: clock.now, startWorker: false });
    t.after(() => app.close());
    const login = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "test", password: "password", remember: remember ? "yes" : "no" },
    });
    assert.equal(login.statusCode, 302);
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const duration = remember ? 30 * day : 12 * 3600_000;
    assert.equal(row("SELECT created_at FROM web_sessions").created_at, iso(start));
    assert.equal(row("SELECT expires_at FROM web_sessions").expires_at, iso(start + duration));
    clock.time = start + duration - 1;
    assert.equal((await app.inject({ url: "/", headers: { cookie } })).statusCode, 200);
    assert.equal(row("SELECT expires_at FROM web_sessions").expires_at, iso(clock.time + duration));
    clock.time += duration;
    assert.equal((await app.inject({ url: "/", headers: { cookie } })).headers.location, "/login");
  });
}

for (const status of [200, 429]) {
  test(`buildApp shares its clock with the running Telegram worker (HTTP ${status})`, async (t) => {
    const { settings, clock, row, enqueue } = fixture(t);
    enqueue();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      clock.time += 400;
      return new Response(JSON.stringify({ ok: status === 200, parameters: { retry_after: 25 } }), { status });
    });
    // Control scheduling only; Date and the system clock are untouched.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const app = await buildApp({ config: { ...settings, telegramBotToken: "test" }, now: clock.now });
    t.after(() => app.close());
    clock.time += 1000;
    t.mock.timers.tick(1000);
    await app.close(); // Drain the actual worker without a sleep or network request.
    assert.equal(calls, 1);
    assert.equal(row("SELECT status FROM telegram_jobs").status, status === 200 ? "sent" : "pending");
    assert.equal(row("SELECT finished_at FROM telegram_jobs").finished_at, status === 200 ? clock.time : null);
    assert.equal(
      row("SELECT available_at FROM telegram_jobs").available_at,
      clock.time + (status === 200 ? 2000 : 25_000),
    );
  });
}
