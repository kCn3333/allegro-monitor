-- Schema from audited commit 5586ad54c9990f0eed8d98960ab29f3ce8c72de2, empty database.
BEGIN TRANSACTION;
CREATE TABLE extension_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        last_notification_event_id INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL
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
CREATE TABLE monitor_clients (
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        client_id INTEGER NOT NULL REFERENCES extension_clients(id) ON DELETE CASCADE,
        tab_open INTEGER NOT NULL DEFAULT 0,
        client_enabled INTEGER NOT NULL DEFAULT 1,
        notifications_enabled INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(monitor_id, client_id)
      );
CREATE TABLE monitor_exclusions (
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(monitor_id, external_id)
      );
CREATE TABLE monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(interval_minutes >= 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        initialized INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        next_check_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        new_listings_count INTEGER NOT NULL DEFAULT 0,
        last_check_new_count INTEGER NOT NULL DEFAULT 0
      );
CREATE TABLE notification_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        price TEXT,
        image_url TEXT,
        created_at TEXT NOT NULL
      );
CREATE TABLE web_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        credential_fingerprint TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE INDEX idx_web_sessions_expires ON web_sessions(expires_at);
CREATE INDEX idx_monitors_due ON monitors(enabled, next_check_at);
CREATE INDEX idx_listings_seen ON listings(first_seen_at DESC);
CREATE INDEX idx_listings_missing ON listings(monitor_id, missing_checks);
DELETE FROM "sqlite_sequence";
COMMIT;
