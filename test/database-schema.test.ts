import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";
import { initializeDatabaseSchema } from "../src/database-schema.js";

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-schema-version-"));
  const file = path.join(directory, "test.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { file, db };
}

function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

function snapshot(db: DatabaseSync) {
  return {
    version: db.prepare("PRAGMA user_version").get(),
    schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
    rows: tables(db).map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    sequences: db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
  };
}

function integrity(db: DatabaseSync) {
  assert.deepEqual(
    db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check),
    ["ok"],
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.equal(db.isTransaction, false);
}

function seed(db: DatabaseSync, legacy = false) {
  const schema = fs.readFileSync("test/fixtures/audited-schema.sql", "utf8");
  db.exec(legacy ? schema.replace("interval_minutes >= 1", "interval_minutes >= 2") : schema);
  db.exec(fs.readFileSync("test/fixtures/pr2-notification-schema.sql", "utf8"));
  db.exec(`
    INSERT INTO monitors(id,name,url,interval_minutes,next_check_at,created_at,initialized) VALUES(1,'kept','https://allegro.pl/listing?string=test',5,'2026-01-01','2026-01-01',1);
    INSERT INTO listings(id,monitor_id,external_id,title,url,first_seen_at,last_seen_at) VALUES(1,1,'offer:123456','Book','https://allegro.pl/oferta/book-123456','2026-01-01','2026-01-01');
    INSERT INTO extension_clients(id,name,token_hash,created_at,last_notification_event_id) VALUES(1,'device','hash','2026-01-01',0);
    INSERT INTO monitor_clients(monitor_id,client_id,notifications_enabled,last_seen_at) VALUES(1,1,0,'2026-01-01');
    INSERT INTO monitor_exclusions(monitor_id,external_id,title,created_at) VALUES(1,'excluded','kept','2026-01-01');
    INSERT INTO web_sessions(token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES('session','fp',3600,'2099-01-01','2026-01-01','2026-01-01');
    INSERT INTO notification_events(id,monitor_id,external_id,title,url,created_at) VALUES(1,1,'offer:123456','Book','https://allegro.pl/oferta/book-123456','2026-01-01');
    INSERT INTO notification_batches(client_id,batch_id,through_id,events,created_at) VALUES(1,'batch',1,'[]','2026-01-01');
    INSERT INTO telegram_jobs(chat_id,payload,available_at,attempts) VALUES('1','{}',123,2);
  `);
}

test("an empty unversioned database migrates once and current initialization executes no writes", (t) => {
  const { file, db } = fixture(t);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 0);
  initializeDatabaseSchema(db);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
  assert.equal(tables(db).length, 9);
  integrity(db);
  const before = snapshot(db);
  const exec = t.mock.method(db, "exec", () => assert.fail("completed migrations must not execute again"));
  initializeDatabaseSchema(db);
  assert.equal(exec.mock.callCount(), 0);
  exec.mock.restore();
  const store = new Store(file);
  store.close();
  assert.deepEqual(snapshot(db), before);
  integrity(db);
});

for (const mode of ["legacy", "audited", "current"] as const) {
  test(`unversioned ${mode} data and all table relations survive migration and restart`, (t) => {
    const { file, db } = fixture(t);
    seed(db, mode === "legacy");
    if (mode === "current") {
      initializeDatabaseSchema(db);
      db.exec(
        "PRAGMA user_version = 0; UPDATE monitors SET check_cycle=4,new_listings_count=7,last_check_new_count=1; UPDATE listings SET new_in_cycle=4; UPDATE extension_clients SET extension_version='1.2.0',browser='Chromium';",
      );
    }
    const queries = tables(db).map((table) => {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name)
        .join(",");
      return `SELECT ${columns} FROM ${table} ORDER BY rowid`;
    });
    const rows = () => queries.map((sql) => db.prepare(sql).all());
    const before = rows();
    for (let restart = 0; restart < 2; restart++) {
      const store = new Store(file);
      try {
        assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
        assert.deepEqual(rows(), before);
        integrity(db);
        assert.equal(db.prepare("SELECT next_check_at FROM monitors").get()!.next_check_at, "2026-01-01");
        assert.equal(
          db.prepare("SELECT new_in_cycle FROM listings").get()!.new_in_cycle,
          mode === "current" ? 4 : null,
        );
        assert.equal(store.hasMonitorClient(1, 1), true);
        assert.equal(store.areNotificationsEnabledForClient(1, 1), false);
      } finally {
        store.close();
      }
    }
  });
}

for (const legacy of [false, true]) {
  test(`failure after schema, data and version writes rolls back and can be retried (legacy=${legacy})`, (t) => {
    const { db } = fixture(t);
    seed(db, legacy);
    const before = snapshot(db);
    const exec = db.exec.bind(db);
    const fail = t.mock.method(db, "exec", (sql: string) => {
      if (sql === "COMMIT") {
        assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
        assert.ok(
          db
            .prepare("PRAGMA table_info(listings)")
            .all()
            .some((column) => column.name === "new_in_cycle"),
        );
        throw new Error("forced migration failure");
      }
      exec(sql);
    });
    assert.throws(() => initializeDatabaseSchema(db), /forced migration failure/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("PRAGMA legacy_alter_table").get()!.legacy_alter_table, 0);
    integrity(db);
    fail.mock.restore();
    initializeDatabaseSchema(db);
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
    integrity(db);
  });
}

test("a SQL-triggered rollback restores all changes and the migration can be retried", (t) => {
  const { db } = fixture(t);
  seed(db);
  db.exec(`ALTER TABLE monitor_clients DROP COLUMN notifications_enabled;
    UPDATE monitor_clients SET client_enabled=0;
    CREATE TRIGGER reject_migration BEFORE UPDATE ON monitor_clients BEGIN
      SELECT RAISE(ROLLBACK,'forced SQL migration rollback');
    END;`);
  const before = snapshot(db);
  assert.throws(() => initializeDatabaseSchema(db), /forced SQL migration rollback/);
  assert.deepEqual(snapshot(db), before);
  integrity(db);
  db.exec("DROP TRIGGER reject_migration");
  initializeDatabaseSchema(db);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
  assert.equal(db.prepare("SELECT notifications_enabled FROM monitor_clients").get()!.notifications_enabled, 0);
  integrity(db);
});

test("foreign key violations reject the migration without repairing or deleting data", (t) => {
  const { db } = fixture(t);
  seed(db);
  db.exec(`PRAGMA foreign_keys=OFF;
    INSERT INTO notification_events(monitor_id,external_id,title,url,created_at) VALUES(999,'orphan','orphan','https://allegro.pl/oferta/orphan','2026-01-01');
    PRAGMA foreign_keys=ON;`);
  const before = snapshot(db);
  assert.throws(() => initializeDatabaseSchema(db), /Migracja SQLite narusza integralność kluczy obcych/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(db.isTransaction, false);
  db.exec("DELETE FROM notification_events WHERE monitor_id=999");
  initializeDatabaseSchema(db);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
  integrity(db);
});

test("a future database is rejected without changes and Store closes the failed connection", (t) => {
  const { file, db } = fixture(t);
  seed(db);
  db.exec("PRAGMA user_version = 2;");
  const before = snapshot(db);
  assert.throws(() => initializeDatabaseSchema(db), /Nieobsługiwana wersja schematu SQLite: 2/);
  assert.deepEqual(snapshot(db), before);
  const closed: DatabaseSync[] = [];
  const close = DatabaseSync.prototype.close;
  const mock = t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closed.push(this);
    close.call(this);
  });
  assert.throws(() => new Store(file), /Nieobsługiwana wersja schematu SQLite: 2/);
  mock.mock.restore();
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.isOpen, false);
  assert.deepEqual(snapshot(db), before);
  integrity(db);
});

test("Store restores foreign keys, rolls back and closes its connection after a failed migration", (t) => {
  const { file, db } = fixture(t);
  seed(db, true);
  const before = snapshot(db);
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  const closed: Array<{ connection: DatabaseSync; foreignKeys: unknown; transaction: boolean }> = [];
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw new Error("forced Store migration failure");
    exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closed.push({
      connection: this,
      foreignKeys: this.prepare("PRAGMA foreign_keys").get()!.foreign_keys,
      transaction: this.isTransaction,
    });
    close.call(this);
  });
  assert.throws(() => new Store(file), /forced Store migration failure/);
  t.mock.restoreAll();
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.connection.isOpen, false);
  assert.equal(closed[0]!.foreignKeys, 1);
  assert.equal(closed[0]!.transaction, false);
  assert.deepEqual(snapshot(db), before);
  integrity(db);
  const store = new Store(file);
  store.close();
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
  integrity(db);
});
