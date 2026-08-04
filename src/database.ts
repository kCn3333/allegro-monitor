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
        last_seen_at TEXT,
        created_at TEXT NOT NULL
      );
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
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(monitor_id, client_id)
      );
      CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(enabled, next_check_at);
      CREATE INDEX IF NOT EXISTS idx_listings_seen ON listings(first_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_listings_missing ON listings(monitor_id, missing_checks);
    `);
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

  saveCheck(monitor: Monitor, listings: Listing[]): Listing[] {
    const now = new Date().toISOString();
    const excluded = new Set((this.db.prepare("SELECT external_id externalId FROM monitor_exclusions WHERE monitor_id=?").all(monitor.id) as Array<{ externalId: string }>).map(item => item.externalId));
    const insert = this.db.prepare(`INSERT OR IGNORE INTO listings
      (monitor_id,external_id,title,url,price,image_url,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)`);
    const markSeen = this.db.prepare(`UPDATE listings SET title=?,url=?,price=?,image_url=?,last_seen_at=?,missing_checks=0
      WHERE monitor_id=? AND external_id=?`);
    const fresh: Listing[] = [];
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE listings SET missing_checks=missing_checks+1 WHERE monitor_id=?").run(monitor.id);
      for (const listing of listings) {
        const result = insert.run(monitor.id, listing.externalId, listing.title, listing.url,
          listing.price, listing.imageUrl, now, now);
        markSeen.run(listing.title, listing.url, listing.price, listing.imageUrl, now, monitor.id, listing.externalId);
        if (result.changes > 0 && monitor.initialized === 1 && !excluded.has(listing.externalId)) fresh.push(listing);
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

  addExtensionClient(name: string, tokenHash: string): void {
    this.db.prepare("INSERT INTO extension_clients(name,token_hash,created_at) VALUES(?,?,?)")
      .run(name.slice(0, 100), tokenHash, new Date().toISOString());
  }

  touchExtensionClient(tokenHash: string): number | null {
    const client = this.db.prepare("SELECT id FROM extension_clients WHERE token_hash=?").get(tokenHash) as { id: number } | undefined;
    if (!client) return null;
    this.db.prepare("UPDATE extension_clients SET last_seen_at=? WHERE id=?").run(new Date().toISOString(), client.id);
    return client.id;
  }

  linkMonitorClient(monitorId: number, clientId: number, tabOpen = true): void {
    this.db.prepare(`INSERT INTO monitor_clients(monitor_id,client_id,tab_open,last_seen_at) VALUES(?,?,?,?)
      ON CONFLICT(monitor_id,client_id) DO UPDATE SET tab_open=excluded.tab_open,last_seen_at=excluded.last_seen_at`)
      .run(monitorId, clientId, tabOpen ? 1 : 0, new Date().toISOString());
    if (tabOpen) this.db.prepare("UPDATE monitors SET last_error=NULL WHERE id=? AND last_error LIKE 'Karta % jest zamknięta'").run(monitorId);
  }

  hasMonitorClient(monitorId: number, clientId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(monitorId, clientId));
  }

  unlinkMonitorClient(monitorId: number, clientId: number): void {
    this.db.prepare("DELETE FROM monitor_clients WHERE monitor_id=? AND client_id=?").run(monitorId, clientId);
  }

  recentListings(limit = 50): Array<Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }> {
    return this.db.prepare(`SELECT l.external_id externalId,l.title,l.url,l.price,l.image_url imageUrl,l.monitor_id monitorId,
      l.first_seen_at firstSeenAt,m.name monitorName,
      CASE WHEN m.last_check_new_count>0 AND l.first_seen_at=m.last_checked_at THEN 1 ELSE 0 END fromLatestCheck
      FROM listings l JOIN monitors m ON m.id=l.monitor_id
      WHERE NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)
      ORDER BY l.first_seen_at DESC LIMIT ?`).all(limit) as unknown as Array<Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }>;
  }

  close(): void { this.db.close(); }
}
