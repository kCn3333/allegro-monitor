import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Listing, Monitor } from "./types.js";

export class Store {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK(interval_minutes >= 2),
        enabled INTEGER NOT NULL DEFAULT 1,
        initialized INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        next_check_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL
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
        UNIQUE(monitor_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(enabled, next_check_at);
      CREATE INDEX IF NOT EXISTS idx_listings_seen ON listings(first_seen_at DESC);
    `);
  }

  listMonitors(): Monitor[] {
    return this.db.prepare(`SELECT id, name, url, interval_minutes intervalMinutes,
      enabled, initialized, last_checked_at lastCheckedAt, next_check_at nextCheckAt,
      last_error lastError, created_at createdAt FROM monitors ORDER BY created_at DESC`).all() as unknown as Monitor[];
  }

  createMonitor(name: string, url: string, intervalMinutes: number): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO monitors(name,url,interval_minutes,next_check_at,created_at) VALUES(?,?,?,?,?)")
      .run(name, url, intervalMinutes, now, now);
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
      last_error lastError, created_at createdAt FROM monitors
      WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at LIMIT 10`)
      .all(new Date().toISOString()) as unknown as Monitor[];
  }

  saveCheck(monitor: Monitor, listings: Listing[]): Listing[] {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO listings
      (monitor_id,external_id,title,url,price,image_url,first_seen_at) VALUES(?,?,?,?,?,?,?)`);
    const fresh: Listing[] = [];
    for (const listing of listings) {
      const result = insert.run(monitor.id, listing.externalId, listing.title, listing.url,
        listing.price, listing.imageUrl, now);
      if (result.changes > 0 && monitor.initialized === 1) fresh.push(listing);
    }
    const next = new Date(Date.now() + monitor.intervalMinutes * 60_000).toISOString();
    this.db.prepare(`UPDATE monitors SET initialized=1,last_checked_at=?,next_check_at=?,last_error=NULL WHERE id=?`)
      .run(now, next, monitor.id);
    return fresh;
  }

  saveError(monitor: Monitor, error: unknown): void {
    const now = new Date();
    const next = new Date(now.getTime() + Math.max(monitor.intervalMinutes, 10) * 60_000).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare("UPDATE monitors SET last_checked_at=?,next_check_at=?,last_error=? WHERE id=?")
      .run(now.toISOString(), next, message.slice(0, 1000), monitor.id);
  }

  recentListings(limit = 50): Array<Listing & { monitorName: string; firstSeenAt: string }> {
    return this.db.prepare(`SELECT l.external_id externalId,l.title,l.url,l.price,l.image_url imageUrl,
      l.first_seen_at firstSeenAt,m.name monitorName FROM listings l JOIN monitors m ON m.id=l.monitor_id
      ORDER BY l.first_seen_at DESC LIMIT ?`).all(limit) as unknown as Array<Listing & { monitorName: string; firstSeenAt: string }>;
  }

  close(): void { this.db.close(); }
}
