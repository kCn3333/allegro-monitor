import type { DatabaseSync } from "node:sqlite";

const migrations: ReadonlyArray<(db: DatabaseSync) => void> = [migrateUnversionedSchema];

function schemaVersion(db: DatabaseSync): number {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 0 || version > migrations.length)
    throw new Error(`Nieobsługiwana wersja schematu SQLite: ${version}; obsługiwana: ${migrations.length}`);
  return version;
}

export function initializeDatabaseSchema(db: DatabaseSync): void {
  let version = schemaVersion(db);
  if (version === migrations.length) return;
  const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  const legacyAlterTable = (db.prepare("PRAGMA legacy_alter_table").get() as { legacy_alter_table: number })
    .legacy_alter_table;
  try {
    // Keep references to rebuilt legacy tables pointing at their final names.
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
    while (version < migrations.length) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Another connection may have completed a migration before this write lock.
        version = schemaVersion(db);
        if (version < migrations.length) {
          migrations[version]!(db);
          if (db.prepare("PRAGMA foreign_key_check").get())
            throw new Error("Migracja SQLite narusza integralność kluczy obcych");
          db.exec(`PRAGMA user_version = ${version + 1}`);
          version += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacyAlterTable}; PRAGMA foreign_keys = ${foreignKeys};`);
  }
}

function migrateUnversionedSchema(db: DatabaseSync): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(interval_minutes >= 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        initialized INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        next_check_at TEXT NOT NULL, -- legacy compatibility; scheduling belongs to the extension
        last_error TEXT,
        created_at TEXT NOT NULL,
        new_listings_count INTEGER NOT NULL DEFAULT 0,
        last_check_new_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        price TEXT,
        image_url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        missing_checks INTEGER NOT NULL DEFAULT 0,
        UNIQUE(monitor_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS extension_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        last_notification_event_id INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        credential_fingerprint TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
    `);
  migrateLegacySchema(db);
  ensureCurrentColumns(db);
  db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_exclusions (
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(monitor_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS monitor_clients (
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        client_id INTEGER NOT NULL REFERENCES extension_clients(id) ON DELETE CASCADE,
        tab_open INTEGER NOT NULL DEFAULT 0,
        client_enabled INTEGER NOT NULL DEFAULT 1,
        notifications_enabled INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(monitor_id, client_id)
      );
      CREATE INDEX IF NOT EXISTS idx_listings_seen ON listings(first_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_listings_missing ON listings(monitor_id, missing_checks);
      CREATE TABLE IF NOT EXISTS notification_batches (
        client_id INTEGER PRIMARY KEY REFERENCES extension_clients(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL, through_id INTEGER NOT NULL, events TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telegram_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, finished_at INTEGER, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_due ON telegram_jobs(status,available_at);
      CREATE TABLE IF NOT EXISTS notification_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        price TEXT,
        image_url TEXT,
        created_at TEXT NOT NULL
      );
    `);
  const extensionColumns = new Set(
    (db.prepare("PRAGMA table_info(extension_clients)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!extensionColumns.has("last_notification_event_id"))
    db.exec("ALTER TABLE extension_clients ADD COLUMN last_notification_event_id INTEGER NOT NULL DEFAULT 0");
  for (const column of ["extension_version", "browser", "os", "os_version", "arch"]) {
    if (!extensionColumns.has(column)) db.exec(`ALTER TABLE extension_clients ADD COLUMN ${column} TEXT`);
  }
  const clientColumns = new Set(
    (db.prepare("PRAGMA table_info(monitor_clients)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!clientColumns.has("client_enabled"))
    db.exec("ALTER TABLE monitor_clients ADD COLUMN client_enabled INTEGER NOT NULL DEFAULT 1");
  if (!clientColumns.has("notifications_enabled")) {
    db.exec("ALTER TABLE monitor_clients ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1");
    db.exec("UPDATE monitor_clients SET notifications_enabled=client_enabled");
  }
}

function migrateLegacySchema(db: DatabaseSync): void {
  const monitorSql = String(
    (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='monitors'").get() as
        | { sql?: string }
        | undefined
    )?.sql || "",
  );
  if (monitorSql.includes("interval_minutes >= 2")) {
    db.exec(`
        DROP INDEX IF EXISTS idx_monitors_due;
        DROP INDEX IF EXISTS idx_listings_seen;
        ALTER TABLE listings RENAME TO listings_legacy;
        ALTER TABLE monitors RENAME TO monitors_legacy;
        CREATE TABLE monitors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(interval_minutes >= 1),
          enabled INTEGER NOT NULL DEFAULT 1,
          initialized INTEGER NOT NULL DEFAULT 0,
          last_checked_at TEXT,
          next_check_at TEXT NOT NULL, -- legacy compatibility; scheduling belongs to the extension
          last_error TEXT,
          created_at TEXT NOT NULL,
          new_listings_count INTEGER NOT NULL DEFAULT 0,
          last_check_new_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE listings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
          external_id TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          price TEXT,
          image_url TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          missing_checks INTEGER NOT NULL DEFAULT 0,
          UNIQUE(monitor_id, external_id)
        );
        INSERT INTO monitors(id,name,url,interval_minutes,enabled,initialized,last_checked_at,next_check_at,last_error,created_at)
          SELECT id,name,url,interval_minutes,enabled,initialized,last_checked_at,next_check_at,last_error,created_at FROM monitors_legacy;
        INSERT INTO listings(id,monitor_id,external_id,title,url,price,image_url,first_seen_at,last_seen_at)
          SELECT id,monitor_id,external_id,title,url,price,image_url,first_seen_at,first_seen_at FROM listings_legacy;
        DROP TABLE listings_legacy;
        DROP TABLE monitors_legacy;
      `);
  }
}

function ensureCurrentColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(monitors)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("check_cycle")) db.exec("ALTER TABLE monitors ADD COLUMN check_cycle INTEGER NOT NULL DEFAULT 0");
  const listingColumns = new Set(
    (db.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  // Historical timestamp labels are ambiguous. NULL clears only those labels, not data or counters.
  if (!listingColumns.has("new_in_cycle")) db.exec("ALTER TABLE listings ADD COLUMN new_in_cycle INTEGER");
  if (!columns.has("last_check_new_count"))
    db.exec("ALTER TABLE monitors ADD COLUMN last_check_new_count INTEGER NOT NULL DEFAULT 0");
}
