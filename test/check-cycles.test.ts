import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";

const now = () => 1800000000000;
const listing = (id: string) => ({
  externalId: id,
  title: id,
  url: `https://allegro.pl/oferta/${id}`,
  price: "10 zł",
  imageUrl: null,
});
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-cycles-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "test.sqlite");
}
function labels(store: Store) {
  return Object.fromEntries(store.recentListings().map((item) => [item.externalId, item.fromLatestCheck]));
}

test("identical timestamps across baseline, multiple cycles and restart label only genuinely new offers", (t) => {
  const file = fixture(t);
  let store = new Store(file, undefined, now);
  t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  const client = store.addExtensionClient("test", "test-hash");
  const check = (ids: string[]) => store.saveCheck(store.getMonitor(id)!, ids.map(listing), ["1"]);
  assert.deepEqual(check(["A"]), []);
  assert.deepEqual(labels(store), { A: 0 });
  assert.equal(store.notificationBatch(client).events.length, 0);
  assert.equal(store.claimTelegramJob(), undefined);
  assert.deepEqual(
    check(["A", "B"]).map((item) => item.externalId),
    ["B"],
  );
  assert.deepEqual(labels(store), { A: 0, B: 1 });
  store.close();
  store = new Store(file, undefined, now);
  assert.deepEqual(labels(store), { A: 0, B: 1 });
  assert.deepEqual(
    check(["A", "B", "C"]).map((item) => item.externalId),
    ["C"],
  );
  assert.deepEqual(labels(store), { A: 0, B: 0, C: 1 });
  assert.deepEqual(check(["A", "B", "C"]), []);
  assert.deepEqual(labels(store), { A: 0, B: 0, C: 0 });
  assert.equal(store.getMonitor(id)!.newListingsCount, 2);
  assert.equal(store.getMonitor(id)!.lastCheckNewCount, 0);
  const db = new DatabaseSync(file);
  assert.equal((db.prepare("SELECT COUNT(DISTINCT first_seen_at) n FROM listings").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT check_cycle n FROM monitors").get() as { n: number }).n, 4);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM notification_events").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM telegram_jobs").get() as { n: number }).n, 2);
  db.close();
});

for (const target of ["notification_events", "telegram_jobs"]) {
  test(`failed ${target} insert rolls back the whole check after partial event/job writes; retry uses next cycle`, (t) => {
    const file = fixture(t);
    const store = new Store(file, undefined, now);
    t.after(() => store.close());
    const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
    store.saveCheck(store.getMonitor(id)!, [listing("A")]);
    store.saveCheck(store.getMonitor(id)!, [listing("A"), listing("B")], ["1"]);
    const db = new DatabaseSync(file);
    t.after(() => db.close());
    const snapshot = () =>
      ["monitors", "listings", "notification_events", "telegram_jobs", "sqlite_sequence"].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      );
    const before = snapshot();
    const condition =
      target === "notification_events"
        ? "NEW.external_id='D'"
        : "NEW.chat_id='2' AND json_extract(NEW.payload,'$.listing.externalId')='D'";
    db.exec(
      `CREATE TRIGGER reject_check BEFORE INSERT ON ${target} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'test rollback'); END`,
    );
    const input = [{ ...listing("A"), title: "changed" }, listing("B"), listing("C"), listing("D")];
    assert.throws(() => store.saveCheck(store.getMonitor(id)!, input, ["1", "2", "1"]), /test rollback/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(labels(store), { A: 0, B: 1 });
    db.exec("DROP TRIGGER reject_check");
    assert.deepEqual(
      store.saveCheck(store.getMonitor(id)!, input, ["1", "2", "1"]).map((item) => item.externalId),
      ["C", "D"],
    );
    assert.deepEqual(labels(store), { A: 0, B: 0, C: 1, D: 1 });
    assert.equal((db.prepare("SELECT check_cycle n FROM monitors").get() as { n: number }).n, 3);
    assert.equal(store.getMonitor(id)!.newListingsCount, 3);
    assert.equal(store.getMonitor(id)!.lastCheckNewCount, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_events").get()!.n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM telegram_jobs").get()!.n, 5);
  });
}

test("failed exclusion insertion leaves data unchanged and permits a successful retry", (t) => {
  const file = fixture(t);
  const store = new Store(file, undefined, now);
  t.after(() => store.close());
  const id = store.createMonitor("test", "https://allegro.pl/listing?string=test", 5);
  store.saveCheck(store.getMonitor(id)!, [listing("A")]);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  const snapshot = () =>
    ["monitors", "listings", "monitor_exclusions"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  db.exec(
    "CREATE TRIGGER reject_exclusion AFTER INSERT ON monitor_exclusions BEGIN SELECT RAISE(ABORT,'exclusion rollback'); END",
  );
  assert.throws(() => store.addExclusion(id, "A"), /exclusion rollback/);
  assert.deepEqual(snapshot(), before);
  db.exec("DROP TRIGGER reject_exclusion");
  assert.equal(store.addExclusion(id, "A"), true);
  assert.equal(store.listExclusions().length, 1);
  assert.equal(store.getMonitor(id)!.currentListingsCount, 0);
});

test("PR #2 migration clears only ambiguous labels and preserves all existing rows across restarts", (t) => {
  const file = fixture(t);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(fs.readFileSync("test/fixtures/audited-schema.sql", "utf8"));
  db.exec(fs.readFileSync("test/fixtures/pr2-notification-schema.sql", "utf8"));
  const timestamp = new Date(now()).toISOString();
  db.prepare(
    "INSERT INTO monitors(id,name,url,interval_minutes,enabled,initialized,last_checked_at,next_check_at,created_at,new_listings_count,last_check_new_count) VALUES(1,'kept','https://allegro.pl/listing?string=test',30,1,1,?,?,?,7,1)",
  ).run(timestamp, timestamp, timestamp);
  db.prepare(
    "INSERT INTO listings(monitor_id,external_id,title,url,first_seen_at,last_seen_at) VALUES(1,'A','A','https://allegro.pl/oferta/A',?,?)",
  ).run(timestamp, timestamp);
  db.exec(`INSERT INTO extension_clients(id,name,token_hash,created_at) VALUES(1,'device','hash','2026-01-01');
    INSERT INTO monitor_clients(monitor_id,client_id,notifications_enabled,last_seen_at) VALUES(1,1,0,'2026-01-01');
    INSERT INTO monitor_exclusions(monitor_id,external_id,title,created_at) VALUES(1,'excluded','kept','2026-01-01');
    INSERT INTO web_sessions(token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES('session','fp',3600,'2099-01-01','2026-01-01','2026-01-01');
    INSERT INTO notification_events(monitor_id,external_id,title,url,created_at) VALUES(1,'A','A','https://allegro.pl/oferta/A','2026-01-01');
    INSERT INTO notification_batches(client_id,batch_id,through_id,events,created_at) VALUES(1,'batch',1,'[]','2026-01-01');
    INSERT INTO telegram_jobs(chat_id,payload,available_at) VALUES('1','{}',123);`);
  const tables = [
    "monitors",
    "listings",
    "extension_clients",
    "monitor_clients",
    "monitor_exclusions",
    "web_sessions",
    "notification_events",
    "notification_batches",
    "telegram_jobs",
  ];
  const queries = tables.map((table) => {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name)
      .join(",");
    return `SELECT ${columns} FROM ${table}`;
  });
  const before = queries.map((sql) => db.prepare(sql).all());
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(file, undefined, now);
    assert.deepEqual(
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"],
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
    assert.deepEqual(
      queries.map((sql) => db.prepare(sql).all()),
      before,
    );
    assert.deepEqual(labels(store), { A: 0 });
    assert.equal(store.getMonitor(1)!.initialized, 1);
    assert.equal(store.getMonitor(1)!.newListingsCount, 7);
    if (restart === 1) {
      assert.deepEqual(store.saveCheck(store.getMonitor(1)!, [listing("A")]), []);
      assert.equal(store.getMonitor(1)!.newListingsCount, 7);
      assert.deepEqual(labels(store), { A: 0 });
      assert.equal((db.prepare("SELECT COUNT(*) n FROM notification_events").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM telegram_jobs").get() as { n: number }).n, 1);
    }
    store.close();
  }
});
