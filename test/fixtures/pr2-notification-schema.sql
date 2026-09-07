-- Additions to audited-schema.sql from PR #2, commit 4e4f16dfc4607fc32cefc4d78254e28b717a0c6c.
CREATE TABLE notification_batches (
        client_id INTEGER PRIMARY KEY REFERENCES extension_clients(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL, through_id INTEGER NOT NULL, events TEXT NOT NULL, created_at TEXT NOT NULL
      );
CREATE TABLE telegram_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, finished_at INTEGER, last_error TEXT
      );
CREATE INDEX idx_telegram_due ON telegram_jobs(status,available_at);
