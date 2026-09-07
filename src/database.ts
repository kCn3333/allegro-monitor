import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Listing, Monitor, MonitorExclusion } from "./types.js";

export class Store {
  private readonly db: DatabaseSync;
  private readonly listingRetentionChecks: number;

  constructor(databasePath: string, listingRetentionChecks = 5) {
    this.listingRetentionChecks = Math.max(2, listingRetentionChecks);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitors (
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
    this.migrateLegacySchema();
    this.ensureCurrentColumns();
    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(enabled, next_check_at);
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
    const extensionColumns = new Set((this.db.prepare("PRAGMA table_info(extension_clients)").all() as Array<{ name: string }>).map(column => column.name));
    if (!extensionColumns.has("last_notification_event_id")) this.db.exec("ALTER TABLE extension_clients ADD COLUMN last_notification_event_id INTEGER NOT NULL DEFAULT 0");
    const clientColumns = new Set((this.db.prepare("PRAGMA table_info(monitor_clients)").all() as Array<{ name: string }>).map(column => column.name));
    if (!clientColumns.has("client_enabled")) this.db.exec("ALTER TABLE monitor_clients ADD COLUMN client_enabled INTEGER NOT NULL DEFAULT 1");
    if (!clientColumns.has("notifications_enabled")) {
      this.db.exec("ALTER TABLE monitor_clients ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1");
      this.db.exec("UPDATE monitor_clients SET notifications_enabled=client_enabled");
    }
  }

  private migrateLegacySchema(): void {
    const monitorSql = String((this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='monitors'").get() as { sql?: string } | undefined)?.sql || "");
    if (monitorSql.includes("interval_minutes >= 2")) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP INDEX IF EXISTS idx_monitors_due;
        DROP INDEX IF EXISTS idx_listings_seen;
        BEGIN;
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
          next_check_at TEXT NOT NULL,
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
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }
  }

  private ensureCurrentColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(monitors)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("check_cycle")) this.db.exec("ALTER TABLE monitors ADD COLUMN check_cycle INTEGER NOT NULL DEFAULT 0");
    const listingColumns = new Set((this.db.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>).map(column => column.name));
    // Historical timestamp labels are ambiguous. NULL clears only those labels, not data or counters.
    if (!listingColumns.has("new_in_cycle")) this.db.exec("ALTER TABLE listings ADD COLUMN new_in_cycle INTEGER");
    if (!columns.has("last_check_new_count")) this.db.exec("ALTER TABLE monitors ADD COLUMN last_check_new_count INTEGER NOT NULL DEFAULT 0");
  }

  listMonitors(): Monitor[] {
    const activeSince = new Date(Date.now() - 3 * 60_000).toISOString();
    return this.db.prepare(`SELECT id, name, url, interval_minutes intervalMinutes,
      enabled, initialized, last_checked_at lastCheckedAt, next_check_at nextCheckAt,
      last_error lastError, created_at createdAt, new_listings_count newListingsCount, last_check_new_count lastCheckNewCount,
      (SELECT COUNT(*) FROM listings l WHERE l.monitor_id=monitors.id AND l.missing_checks=0 AND NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)) currentListingsCount,
      (SELECT COUNT(*) FROM monitor_exclusions e WHERE e.monitor_id=monitors.id) excludedListingsCount,
      (SELECT COUNT(*) FROM monitor_clients mc WHERE mc.monitor_id=monitors.id AND mc.tab_open=1 AND mc.last_seen_at>=?) activeClientsCount
      FROM monitors ORDER BY created_at DESC`).all(activeSince) as unknown as Monitor[];
  }

  createMonitor(name: string, url: string, intervalMinutes: number): number {
    const now = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO monitors(name,url,interval_minutes,next_check_at,created_at) VALUES(?,?,?,?,?)")
      .run(name, url, intervalMinutes, now, now);
    return Number(result.lastInsertRowid);
  }

  getMonitor(id: number): Monitor | undefined {
    return this.db.prepare(`SELECT id, name, url, interval_minutes intervalMinutes,
      enabled, initialized, last_checked_at lastCheckedAt, next_check_at nextCheckAt,
      last_error lastError, created_at createdAt, new_listings_count newListingsCount, last_check_new_count lastCheckNewCount,
      (SELECT COUNT(*) FROM listings l WHERE l.monitor_id=monitors.id AND l.missing_checks=0 AND NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)) currentListingsCount,
      (SELECT COUNT(*) FROM monitor_exclusions e WHERE e.monitor_id=monitors.id) excludedListingsCount,
      0 activeClientsCount
      FROM monitors WHERE id=?`).get(id) as unknown as Monitor | undefined;
  }

  findMonitorByUrl(url: string): Monitor | undefined {
    return this.db.prepare(`SELECT id, name, url, interval_minutes intervalMinutes,
      enabled, initialized, last_checked_at lastCheckedAt, next_check_at nextCheckAt,
      last_error lastError, created_at createdAt, new_listings_count newListingsCount, last_check_new_count lastCheckNewCount,
      (SELECT COUNT(*) FROM listings l WHERE l.monitor_id=monitors.id AND l.missing_checks=0 AND NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)) currentListingsCount,
      (SELECT COUNT(*) FROM monitor_exclusions e WHERE e.monitor_id=monitors.id) excludedListingsCount,
      0 activeClientsCount
      FROM monitors WHERE url=? ORDER BY id LIMIT 1`).get(url) as unknown as Monitor | undefined;
  }

  updateMonitorSettings(id: number, name: string, intervalMinutes: number): void {
    this.db.prepare("UPDATE monitors SET name=?, interval_minutes=? WHERE id=?").run(name, intervalMinutes, id);
  }

  renameMonitor(id: number, name: string): void {
    this.db.prepare("UPDATE monitors SET name=? WHERE id=?").run(name, id);
  }

  deleteMonitor(id: number): void {
    this.db.prepare("DELETE FROM monitors WHERE id = ?").run(id);
  }

  toggleMonitor(id: number): void {
    this.db.prepare("UPDATE monitors SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END, next_check_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  scheduleNow(id: number): void {
    this.db.prepare("UPDATE monitors SET next_check_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  dueMonitors(): Monitor[] {
    return this.db.prepare(`SELECT id, name, url, interval_minutes intervalMinutes,
      enabled, initialized, last_checked_at lastCheckedAt, next_check_at nextCheckAt,
      last_error lastError, created_at createdAt, new_listings_count newListingsCount, last_check_new_count lastCheckNewCount,
      (SELECT COUNT(*) FROM listings l WHERE l.monitor_id=monitors.id AND l.missing_checks=0 AND NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)) currentListingsCount,
      (SELECT COUNT(*) FROM monitor_exclusions e WHERE e.monitor_id=monitors.id) excludedListingsCount,
      0 activeClientsCount FROM monitors
      WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at LIMIT 10`)
      .all(new Date().toISOString()) as unknown as Monitor[];
  }

  saveCheck(monitor: Monitor, listings: Listing[], telegramChatIds: string[] = []): Listing[] {
    const now = new Date().toISOString();
    const excluded = new Set((this.db.prepare("SELECT external_id externalId FROM monitor_exclusions WHERE monitor_id=?").all(monitor.id) as Array<{ externalId: string }>).map(item => item.externalId));
    const insert = this.db.prepare(`INSERT OR IGNORE INTO listings
      (monitor_id,external_id,title,url,price,image_url,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)`);
    const markSeen = this.db.prepare(`UPDATE listings SET title=?,url=?,price=?,image_url=?,last_seen_at=?,missing_checks=0
      WHERE monitor_id=? AND external_id=?`);
    const addEvent = this.db.prepare(`INSERT INTO notification_events
      (monitor_id,external_id,title,url,price,image_url,created_at) VALUES(?,?,?,?,?,?,?)`);
    const fresh: Listing[] = [];
    this.db.exec("BEGIN");
    try {
      const { cycle } = this.db.prepare("UPDATE monitors SET check_cycle=check_cycle+1 WHERE id=? RETURNING check_cycle cycle")
        .get(monitor.id) as { cycle: number };
      this.db.prepare("UPDATE listings SET missing_checks=missing_checks+1 WHERE monitor_id=?").run(monitor.id);
      for (const listing of listings) {
        const result = insert.run(monitor.id, listing.externalId, listing.title, listing.url,
          listing.price, listing.imageUrl, now, now);
        markSeen.run(listing.title, listing.url, listing.price, listing.imageUrl, now, monitor.id, listing.externalId);
        if (result.changes > 0 && monitor.initialized === 1 && !excluded.has(listing.externalId)) {
          fresh.push(listing);
          this.db.prepare("UPDATE listings SET new_in_cycle=? WHERE monitor_id=? AND external_id=?")
            .run(cycle, monitor.id, listing.externalId);
          for (const chatId of new Set(telegramChatIds)) {
            this.db.prepare("INSERT INTO telegram_jobs(chat_id,payload,available_at) VALUES(?,?,?)")
              .run(chatId, JSON.stringify({ monitorName: monitor.name, listing }), Date.now());
          }
          addEvent.run(monitor.id, listing.externalId, listing.title, listing.url, listing.price, listing.imageUrl, now);
        }
      }
      this.db.prepare("DELETE FROM listings WHERE monitor_id=? AND missing_checks>=?").run(monitor.id, this.listingRetentionChecks);
      const next = new Date(Date.now() + monitor.intervalMinutes * 60_000).toISOString();
      this.db.prepare(`UPDATE monitors SET initialized=1,last_checked_at=?,next_check_at=?,last_error=NULL,
        new_listings_count=new_listings_count+?,last_check_new_count=? WHERE id=?`).run(now, next, fresh.length, fresh.length, monitor.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return fresh;
  }

  addExclusion(monitorId: number, externalId: string): boolean {
    const listing = this.db.prepare("SELECT title FROM listings WHERE monitor_id=? AND external_id=?").get(monitorId, externalId) as { title: string } | undefined;
    if (!listing) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT OR IGNORE INTO monitor_exclusions(monitor_id,external_id,title,created_at) VALUES(?,?,?,?)")
        .run(monitorId, externalId, listing.title, new Date().toISOString());
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeExclusion(monitorId: number, externalId: string): void {
    this.db.prepare("DELETE FROM monitor_exclusions WHERE monitor_id=? AND external_id=?").run(monitorId, externalId);
  }

  listExclusions(): MonitorExclusion[] {
    return this.db.prepare(`SELECT monitor_id monitorId,external_id externalId,title,created_at createdAt
      FROM monitor_exclusions ORDER BY created_at DESC`).all() as unknown as MonitorExclusion[];
  }

  saveError(monitor: Monitor, error: unknown): void {
    const now = new Date();
    const next = new Date(now.getTime() + Math.max(monitor.intervalMinutes, 10) * 60_000).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare("UPDATE monitors SET last_checked_at=?,next_check_at=?,last_error=?,last_check_new_count=0 WHERE id=?")
      .run(now.toISOString(), next, message.slice(0, 1000), monitor.id);
  }

  addExtensionClient(name: string, tokenHash: string): number {
    const result = this.db.prepare(`INSERT INTO extension_clients(name,token_hash,last_notification_event_id,created_at)
      VALUES(?,?,(SELECT COALESCE(MAX(id),0) FROM notification_events),?)`)
      .run(name.slice(0, 100), tokenHash, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  touchExtensionClient(tokenHash: string): number | null {
    const client = this.db.prepare("SELECT id FROM extension_clients WHERE token_hash=?").get(tokenHash) as { id: number } | undefined;
    if (!client) return null;
    this.db.prepare("UPDATE extension_clients SET last_seen_at=? WHERE id=?").run(new Date().toISOString(), client.id);
    return client.id;
  }

  createWebSession(tokenHash: string, credentialFingerprint: string, durationSeconds: number): void {
    const now = new Date();
    this.db.prepare(`INSERT INTO web_sessions
      (token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES(?,?,?,?,?,?)`)
      .run(tokenHash, credentialFingerprint, durationSeconds,
        new Date(now.getTime() + durationSeconds * 1000).toISOString(), now.toISOString(), now.toISOString());
  }

  touchWebSession(tokenHash: string, credentialFingerprint: string): number | null {
    const now = new Date();
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at<=?").run(now.toISOString());
    const session = this.db.prepare(`SELECT id,duration_seconds durationSeconds FROM web_sessions
      WHERE token_hash=? AND credential_fingerprint=? AND expires_at>?`)
      .get(tokenHash, credentialFingerprint, now.toISOString()) as { id: number; durationSeconds: number } | undefined;
    if (!session) return null;
    this.db.prepare("UPDATE web_sessions SET expires_at=?,last_used_at=? WHERE id=?")
      .run(new Date(now.getTime() + session.durationSeconds * 1000).toISOString(), now.toISOString(), session.id);
    return session.durationSeconds;
  }

  deleteWebSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash=?").run(tokenHash);
  }

  linkMonitorClient(monitorId: number, clientId: number, tabOpen = true): void {
    this.db.prepare(`INSERT INTO monitor_clients(monitor_id,client_id,tab_open,last_seen_at) VALUES(?,?,?,?)
      ON CONFLICT(monitor_id,client_id) DO UPDATE SET tab_open=excluded.tab_open,last_seen_at=excluded.last_seen_at`)
      .run(monitorId, clientId, tabOpen ? 1 : 0, new Date().toISOString());
    if (tabOpen) this.db.prepare("UPDATE monitors SET last_error=NULL WHERE id=? AND last_error LIKE 'Karta % jest zamknięta'").run(monitorId);
  }

  linkClientToAllMonitors(clientId: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO monitor_clients(monitor_id,client_id,tab_open,last_seen_at)
      SELECT id,?,0,? FROM monitors`).run(clientId, now);
  }

  linkMonitorToAllClients(monitorId: number, openClientId: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO monitor_clients(monitor_id,client_id,tab_open,last_seen_at)
      SELECT ?,id,CASE WHEN id=? THEN 1 ELSE 0 END,? FROM extension_clients`).run(monitorId, openClientId, now);
  }

  listMonitorsForClient(clientId: number): Monitor[] {
    return this.listMonitors().filter(monitor => this.hasMonitorClient(monitor.id, clientId));
  }

  hasMonitorClient(monitorId: number, clientId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(monitorId, clientId));
  }

  areNotificationsEnabledForClient(monitorId: number, clientId: number): boolean {
    const row = this.db.prepare("SELECT notifications_enabled notificationsEnabled FROM monitor_clients WHERE monitor_id=? AND client_id=?")
      .get(monitorId, clientId) as { notificationsEnabled: number } | undefined;
    return row ? Boolean(row.notificationsEnabled) : true;
  }

  setNotificationsForClient(monitorId: number, clientId: number, enabled: boolean): void {
    this.db.prepare(`INSERT INTO monitor_clients(monitor_id,client_id,tab_open,notifications_enabled,last_seen_at) VALUES(?,?,0,?,?)
      ON CONFLICT(monitor_id,client_id) DO UPDATE SET notifications_enabled=excluded.notifications_enabled,last_seen_at=excluded.last_seen_at`)
      .run(monitorId, clientId, enabled ? 1 : 0, new Date().toISOString());
  }

  notificationBatch(clientId: number): { batchId: string; events: Array<Listing & { eventId: number; monitorId: number; monitorName: string }> } {
    this.pruneNotifications();
    const existing = this.db.prepare("SELECT batch_id batchId,events FROM notification_batches WHERE client_id=?")
      .get(clientId) as { batchId: string; events: string } | undefined;
    if (existing) return { batchId: existing.batchId, events: JSON.parse(existing.events).filter((event: { monitorId: number }) => this.areNotificationsEnabledForClient(event.monitorId, clientId)) };
    const client = this.db.prepare("SELECT last_notification_event_id cursor FROM extension_clients WHERE id=?").get(clientId) as { cursor: number } | undefined;
    if (!client) throw new Error("Unknown notification client");
    // Bound scanned rows too; muted events advance only when this batch is acknowledged.
    const rows = this.db.prepare(`SELECT e.id eventId,e.monitor_id monitorId,m.name monitorName,e.external_id externalId,
      e.title,e.url,e.price,e.image_url imageUrl FROM notification_events e JOIN monitors m ON m.id=e.monitor_id
      WHERE e.id>? ORDER BY e.id LIMIT 50`).all(client.cursor) as unknown as Array<Listing & { eventId: number; monitorId: number; monitorName: string }>;
    const events = rows.filter(event => this.areNotificationsEnabledForClient(event.monitorId, clientId));
    const batchId = randomUUID();
    this.db.prepare("INSERT INTO notification_batches(client_id,batch_id,through_id,events,created_at) VALUES(?,?,?,?,?)")
      .run(clientId, batchId, rows.at(-1)?.eventId ?? client.cursor, JSON.stringify(events), new Date().toISOString());
    return { batchId, events };
  }

  acknowledgeNotifications(clientId: number, batchId: string): boolean {
    // Opaque capability bound to an authenticated client; never accept a caller-supplied cursor.
    const batch = this.db.prepare("SELECT through_id cursor FROM notification_batches WHERE client_id=? AND batch_id=?")
      .get(clientId, batchId) as { cursor: number } | undefined;
    if (!batch) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE extension_clients SET last_notification_event_id=MAX(last_notification_event_id,?) WHERE id=?").run(batch.cursor, clientId);
      this.db.prepare("DELETE FROM notification_batches WHERE client_id=?").run(clientId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return true;
  }

  private pruneNotifications(): void {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    this.db.prepare("DELETE FROM notification_events WHERE created_at<?").run(cutoff);
    this.db.prepare("DELETE FROM notification_batches WHERE created_at<?").run(cutoff);
  }

  pullNotifications(clientId: number): Array<Listing & { eventId: number; monitorId: number; monitorName: string }> {
    const batch = this.notificationBatch(clientId);
    this.acknowledgeNotifications(clientId, batch.batchId);
    return batch.events;
  }

  claimTelegramJob(now = Date.now()): TelegramJob | undefined {
    this.db.prepare("DELETE FROM telegram_jobs WHERE finished_at<?").run(now - 30 * 86400_000);
    // Lease also recovers work interrupted by process termination. One bounded worker per process.
    const row = this.db.prepare(`UPDATE telegram_jobs SET status='sending',attempts=attempts+1,available_at=?
      WHERE id=(SELECT id FROM telegram_jobs WHERE status IN ('pending','sending') AND available_at<=? ORDER BY id LIMIT 1)
      RETURNING id,chat_id chatId,payload,attempts`).get(now + 60_000, now) as { id: number; chatId: string; payload: string; attempts: number } | undefined;
    return row ? { ...row, ...JSON.parse(row.payload) } : undefined;
  }

  finishTelegramJob(job: TelegramJob, error?: { permanent: boolean; retryAfterMs: number; message: string }, now = Date.now()): void {
    const terminal = !error || error.permanent || job.attempts >= 12;
    this.db.prepare("UPDATE telegram_jobs SET status=?,available_at=?,finished_at=?,last_error=? WHERE id=? AND attempts=? AND status='sending'")
      .run(!error ? "sent" : terminal ? "failed" : "pending",
        now + Math.max(error?.retryAfterMs || 0, Math.min(3600_000, 1000 * 2 ** job.attempts)),
        terminal ? now : null, error?.message || null, job.id, job.attempts);
  }

  unlinkMonitorClient(monitorId: number, clientId: number): void {
    this.db.prepare("DELETE FROM monitor_clients WHERE monitor_id=? AND client_id=?").run(monitorId, clientId);
  }

  recentListings(limit = 50): Array<Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }> {
    return this.db.prepare(`SELECT l.external_id externalId,l.title,l.url,l.price,l.image_url imageUrl,l.monitor_id monitorId,
      l.first_seen_at firstSeenAt,m.name monitorName,
      CASE WHEN m.last_check_new_count>0 AND l.new_in_cycle=m.check_cycle THEN 1 ELSE 0 END fromLatestCheck
      FROM listings l JOIN monitors m ON m.id=l.monitor_id
      WHERE NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)
      ORDER BY l.first_seen_at DESC LIMIT ?`).all(limit) as unknown as Array<Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }>;
  }

  close(): void { this.db.close(); }
}

export interface TelegramJob {
  id: number; chatId: string; monitorName: string; listing: Listing; attempts: number;
}
