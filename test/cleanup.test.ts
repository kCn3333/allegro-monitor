import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";

const start = Date.parse("2030-01-01T00:00:00.000Z");
const interval = 300_000;
const retention = 30 * 86400_000;
const iso = (time: number) => new Date(time).toISOString();
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-cleanup-"));
  const file = path.join(dir, "test.sqlite");
  const clock = { time: start, now: () => clock.time };
  let store = new Store(file, undefined, clock.now);
  const db = new DatabaseSync(file);
  t.after(() => { db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const row = (sql: string) => db.prepare(sql).get()!;
  const session = (token: string, expiresAt: number) => db.prepare(`INSERT INTO web_sessions
    (token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES(?,'fp',43200,?,?,?)`)
    .run(token, iso(expiresAt), iso(start), iso(start));
  const job = (status: string, finishedAt: number | null, availableAt = start + retention * 2) => Number(db.prepare(`INSERT INTO telegram_jobs
    (chat_id,payload,status,finished_at,available_at) VALUES('1','{}',?,?,?)`).run(status, finishedAt, availableAt).lastInsertRowid);
  return { get store() { return store; }, db, row, clock, session, job,
    restart() { store.close(); store = new Store(file, undefined, clock.now); } };
}

for (const offset of [-1, 0, 1]) {
  test(`session cleanup at five minutes ${offset}ms rejects expiry immediately and renews valid sessions`, t => {
    const { store, row, clock, session } = fixture(t);
    session("already-expired", start);
    session("short", start + 1000);
    store.createWebSession("valid", "fp", 43200);
    assert.equal(store.touchWebSession("valid", "fp"), 43200);
    assert.equal(row("SELECT COUNT(*) n FROM web_sessions").n, 2); // First call cleans immediately.
    clock.time += 1000;
    assert.equal(store.touchWebSession("short", "fp"), null);
    assert.equal(row("SELECT COUNT(*) n FROM web_sessions WHERE token_hash='short'").n, 1);
    assert.equal(row("SELECT expires_at FROM web_sessions WHERE token_hash='short'").expires_at, iso(start + 1000));
    assert.equal(store.touchWebSession("valid", "fp"), 43200);
    assert.equal(row("SELECT expires_at FROM web_sessions WHERE token_hash='valid'").expires_at, iso(clock.time + 43200_000));
    clock.time = start + interval + offset;
    assert.equal(store.touchWebSession("valid", "fp"), 43200);
    assert.equal(row("SELECT expires_at FROM web_sessions WHERE token_hash='valid'").expires_at, iso(clock.time + 43200_000));
    assert.equal(row("SELECT last_used_at FROM web_sessions WHERE token_hash='valid'").last_used_at, iso(clock.time));
    assert.equal(row("SELECT COUNT(*) n FROM web_sessions WHERE token_hash='short'").n, offset < 0 ? 1 : 0);
    // A request before the deadline must not postpone the cleanup.
    if (offset < 0) {
      clock.time++;
      assert.equal(store.touchWebSession("short", "fp"), null);
      assert.equal(row("SELECT COUNT(*) n FROM web_sessions WHERE token_hash='short'").n, 0);
    }
    session("later", clock.time);
    assert.equal(store.touchWebSession("later", "fp"), null);
    assert.equal(row("SELECT COUNT(*) n FROM web_sessions WHERE token_hash='later'").n, 1);
    clock.time += interval;
    store.touchWebSession("missing", "fp");
    assert.equal(row("SELECT COUNT(*) n FROM web_sessions WHERE token_hash='later'").n, 0);
  });

  test(`Telegram cleanup at five minutes ${offset}ms retains recent completions and active jobs`, t => {
    const { store, row, clock, job } = fixture(t);
    job("sent", start - retention - 1);
    job("failed", start - retention - 1);
    job("sent", start - retention); // Strictly older than 30 days, not >=.
    job("failed", start - retention);
    job("sent", start);
    const pending = job("pending", null), sending = job("sending", null);
    assert.equal(store.claimTelegramJob(), undefined);
    assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, 5);
    clock.time = start + 1;
    assert.equal(store.claimTelegramJob(), undefined);
    assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, 5);
    clock.time = start + interval + offset;
    assert.equal(store.claimTelegramJob(), undefined);
    assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, offset < 0 ? 5 : 3);
    if (offset < 0) {
      clock.time++;
      assert.equal(store.claimTelegramJob(), undefined);
      assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, 3);
    }
    assert.equal(row(`SELECT status FROM telegram_jobs WHERE id=${pending}`).status, "pending");
    assert.equal(row(`SELECT status FROM telegram_jobs WHERE id=${sending}`).status, "sending");
    assert.equal(row(`SELECT attempts FROM telegram_jobs WHERE id=${pending}`).attempts, 0);
    // Future work still becomes claimable in ID order; leases still recover it.
    clock.time = start + retention * 2;
    assert.equal(store.claimTelegramJob()!.id, pending);
    assert.equal(store.claimTelegramJob()!.id, sending);
    assert.equal(store.claimTelegramJob(), undefined);
    clock.time += 60_000;
    const recovered = store.claimTelegramJob()!;
    assert.equal(recovered.id, pending); assert.equal(recovered.attempts, 2);
  });
}

for (const area of ["sessions", "telegram"] as const) {
  test(`${area} cleanup runs again after restart before the old deadline`, t => {
    const f = fixture(t);
    const clean = () => area === "sessions" ? f.store.touchWebSession("missing", "fp") : f.store.claimTelegramJob();
    const count = () => f.row(`SELECT COUNT(*) n FROM ${area === "sessions" ? "web_sessions" : "telegram_jobs"}`).n;
    clean();
    if (area === "sessions") f.session("expired", start);
    else f.job("sent", start - retention - 1);
    f.clock.time++;
    clean(); assert.equal(count(), 1);
    f.restart();
    assert.equal(count(), 1); // Construction alone does not perform cleanup.
    clean(); assert.equal(count(), 0);
  });

  for (const firstCall of [true, false]) {
    test(`${area} failed cleanup does not advance its deadline (first call=${firstCall})`, t => {
      const f = fixture(t);
      const clean = () => area === "sessions" ? f.store.touchWebSession("missing", "fp") : f.store.claimTelegramJob();
      const table = area === "sessions" ? "web_sessions" : "telegram_jobs";
      if (!firstCall) { clean(); f.clock.time += interval; }
      if (area === "sessions") f.session("expired", start);
      else f.job("failed", start - retention - 1);
      f.db.exec(`CREATE TRIGGER reject_cleanup BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'cleanup failure'); END`);
      assert.throws(clean, /cleanup failure/);
      assert.equal(f.row(`SELECT COUNT(*) n FROM ${table}`).n, 1);
      f.db.exec("DROP TRIGGER reject_cleanup");
      f.clock.time++;
      clean(); assert.equal(f.row(`SELECT COUNT(*) n FROM ${table}`).n, 0);
    });
  }
}

test("cleanup schedules are independent and Telegram cleanup honors explicit time", t => {
  const { store, row, clock, session, job } = fixture(t);
  store.touchWebSession("missing", "fp");
  clock.time += 1000;
  job("sent", clock.time - retention - 1);
  store.claimTelegramJob(); // Session cleanup must not defer the first Telegram cleanup.
  assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, 0);
  session("expired", clock.time);
  job("sent", clock.time - retention);
  // Explicit time governs both retention cutoff and the next cleanup deadline.
  assert.equal(store.claimTelegramJob(start + interval + 999), undefined);
  assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, 1);
  store.claimTelegramJob(start + interval + 1000);
  assert.equal(row("SELECT COUNT(*) n FROM telegram_jobs").n, 0);
  assert.equal(row("SELECT COUNT(*) n FROM web_sessions").n, 1);
  clock.time = start + interval;
  store.touchWebSession("expired", "fp");
  assert.equal(row("SELECT COUNT(*) n FROM web_sessions").n, 0);
});
