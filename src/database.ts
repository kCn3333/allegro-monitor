import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabaseSchema } from "./database-schema.js";
import { MonitorsRepository } from "./repositories/monitors.js";
import type { DeviceInfo, ExtensionClient, Listing, Monitor, MonitorExclusion } from "./types.js";

export interface TelegramJob {
  id: number;
  chatId: string;
  monitorName: string;
  listing: Listing;
  attempts: number;
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly listingRetentionChecks: number;
  private nextSessionCleanupAt?: number;
  private nextTelegramCleanupAt?: number;
  private readonly monitors: MonitorsRepository;

  constructor(
    databasePath: string,
    listingRetentionChecks = 5,
    private readonly now: () => number = Date.now,
  ) {
    this.listingRetentionChecks = Math.max(2, listingRetentionChecks);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      initializeDatabaseSchema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.monitors = new MonitorsRepository(this.db, this.now, this.listingRetentionChecks);
  }

  listMonitors(): Monitor[] {
    return this.monitors.listMonitors();
  }

  createMonitor(name: string, url: string, intervalMinutes: number): number {
    return this.monitors.createMonitor(name, url, intervalMinutes);
  }

  getMonitor(id: number): Monitor | undefined {
    return this.monitors.getMonitor(id);
  }

  findMonitorByUrl(url: string): Monitor | undefined {
    return this.monitors.findMonitorByUrl(url);
  }

  updateMonitorSettings(id: number, name: string, intervalMinutes: number): void {
    this.monitors.updateMonitorSettings(id, name, intervalMinutes);
  }

  renameMonitor(id: number, name: string): void {
    this.monitors.renameMonitor(id, name);
  }

  deleteMonitor(id: number): void {
    this.monitors.deleteMonitor(id);
  }

  toggleMonitor(id: number): void {
    this.monitors.toggleMonitor(id);
  }

  saveCheck(monitor: Monitor, listings: Listing[], telegramChatIds: string[] = []): Listing[] {
    return this.monitors.saveCheck(monitor, listings, telegramChatIds);
  }

  addExclusion(monitorId: number, externalId: string): boolean {
    return this.monitors.addExclusion(monitorId, externalId);
  }

  removeExclusion(monitorId: number, externalId: string): void {
    this.monitors.removeExclusion(monitorId, externalId);
  }

  listExclusions(): MonitorExclusion[] {
    return this.monitors.listExclusions();
  }

  saveError(monitor: Monitor, error: unknown): void {
    this.monitors.saveError(monitor, error);
  }

  addExtensionClient(name: string, tokenHash: string): number {
    const result = this.db
      .prepare(`INSERT INTO extension_clients(name,token_hash,last_notification_event_id,created_at)
      VALUES(?,?,(SELECT COALESCE(MAX(id),0) FROM notification_events),?)`)
      .run(name.slice(0, 100), tokenHash, new Date(this.now()).toISOString());
    return Number(result.lastInsertRowid);
  }

  renameExtensionClient(id: number, name: string): boolean {
    return this.db.prepare("UPDATE extension_clients SET name=? WHERE id=?").run(name, id).changes > 0;
  }

  revokeExtensionClient(id: number): boolean {
    // Foreign keys remove only this device's links and pending batch, not shared data.
    return this.db.prepare("DELETE FROM extension_clients WHERE id=?").run(id).changes > 0;
  }

  revokeAllExtensionClients(): void {
    this.db.prepare("DELETE FROM extension_clients").run();
  }

  touchExtensionClient(tokenHash: string): number | null {
    const client = this.db.prepare("SELECT id FROM extension_clients WHERE token_hash=?").get(tokenHash) as
      | { id: number }
      | undefined;
    if (!client) return null;
    this.db
      .prepare("UPDATE extension_clients SET last_seen_at=? WHERE id=?")
      .run(new Date(this.now()).toISOString(), client.id);
    return client.id;
  }

  updateExtensionClientInfo(id: number, info: DeviceInfo): void {
    this.db
      .prepare(`UPDATE extension_clients SET extension_version=?,browser=?,os=?,os_version=?,arch=? WHERE id=?`)
      .run(info.extensionVersion, info.browser, info.os, info.osVersion, info.arch, id);
  }

  listExtensionClients(at = this.now()): ExtensionClient[] {
    const since = new Date(at - 3 * 60_000).toISOString();
    return this.db
      .prepare(`SELECT id,name,extension_version extensionVersion,browser,os,os_version osVersion,arch,
      created_at createdAt,last_seen_at lastSeenAt,
      CASE WHEN last_seen_at>=? THEN 1 ELSE 0 END active,
      (SELECT COUNT(*) FROM monitor_clients mc JOIN monitors m ON m.id=mc.monitor_id
        WHERE mc.client_id=extension_clients.id AND mc.tab_open=1 AND mc.last_seen_at>=? AND m.enabled=1) openMonitorsCount
      FROM extension_clients ORDER BY active DESC, last_seen_at DESC, id DESC`)
      .all(since, since) as unknown as ExtensionClient[];
  }

  createWebSession(tokenHash: string, credentialFingerprint: string, durationSeconds: number): void {
    const now = new Date(this.now());
    this.db
      .prepare(`INSERT INTO web_sessions
      (token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES(?,?,?,?,?,?)`)
      .run(
        tokenHash,
        credentialFingerprint,
        durationSeconds,
        new Date(now.getTime() + durationSeconds * 1000).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
  }

  touchWebSession(tokenHash: string, credentialFingerprint: string): number | null {
    const time = this.now();
    const now = new Date(time);
    if (this.nextSessionCleanupAt === undefined || time >= this.nextSessionCleanupAt) {
      this.db.prepare("DELETE FROM web_sessions WHERE expires_at<=?").run(now.toISOString());
      this.nextSessionCleanupAt = time + 5 * 60_000;
    }
    const session = this.db
      .prepare(`SELECT id,duration_seconds durationSeconds FROM web_sessions
      WHERE token_hash=? AND credential_fingerprint=? AND expires_at>?`)
      .get(tokenHash, credentialFingerprint, now.toISOString()) as { id: number; durationSeconds: number } | undefined;
    if (!session) return null;
    this.db
      .prepare("UPDATE web_sessions SET expires_at=?,last_used_at=? WHERE id=?")
      .run(new Date(now.getTime() + session.durationSeconds * 1000).toISOString(), now.toISOString(), session.id);
    return session.durationSeconds;
  }

  deleteWebSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash=?").run(tokenHash);
  }

  linkMonitorClient(monitorId: number, clientId: number, tabOpen = true): void {
    this.db
      .prepare(`INSERT INTO monitor_clients(monitor_id,client_id,tab_open,last_seen_at) VALUES(?,?,?,?)
      ON CONFLICT(monitor_id,client_id) DO UPDATE SET tab_open=excluded.tab_open,last_seen_at=excluded.last_seen_at`)
      .run(monitorId, clientId, tabOpen ? 1 : 0, new Date(this.now()).toISOString());
    if (tabOpen)
      this.db
        .prepare("UPDATE monitors SET last_error=NULL WHERE id=? AND last_error LIKE 'Karta % jest zamknięta'")
        .run(monitorId);
  }

  linkClientToAllMonitors(clientId: number): void {
    const now = new Date(this.now()).toISOString();
    this.db
      .prepare(`INSERT OR IGNORE INTO monitor_clients(monitor_id,client_id,tab_open,last_seen_at)
      SELECT id,?,0,? FROM monitors`)
      .run(clientId, now);
  }

  linkMonitorToAllClients(monitorId: number, openClientId: number): void {
    const now = new Date(this.now()).toISOString();
    this.db
      .prepare(`INSERT OR IGNORE INTO monitor_clients(monitor_id,client_id,tab_open,last_seen_at)
      SELECT ?,id,CASE WHEN id=? THEN 1 ELSE 0 END,? FROM extension_clients`)
      .run(monitorId, openClientId, now);
  }

  hasMonitorClient(monitorId: number, clientId: number): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM monitor_clients WHERE monitor_id=? AND client_id=?").get(monitorId, clientId),
    );
  }

  areNotificationsEnabledForClient(monitorId: number, clientId: number): boolean {
    const row = this.db
      .prepare(
        "SELECT notifications_enabled notificationsEnabled FROM monitor_clients WHERE monitor_id=? AND client_id=?",
      )
      .get(monitorId, clientId) as { notificationsEnabled: number } | undefined;
    return row ? Boolean(row.notificationsEnabled) : true;
  }

  setNotificationsForClient(monitorId: number, clientId: number, enabled: boolean): void {
    this.db
      .prepare(`INSERT INTO monitor_clients(monitor_id,client_id,tab_open,notifications_enabled,last_seen_at) VALUES(?,?,0,?,?)
      ON CONFLICT(monitor_id,client_id) DO UPDATE SET notifications_enabled=excluded.notifications_enabled,last_seen_at=excluded.last_seen_at`)
      .run(monitorId, clientId, enabled ? 1 : 0, new Date(this.now()).toISOString());
  }

  notificationBatch(clientId: number): {
    batchId: string;
    events: Array<Listing & { eventId: number; monitorId: number; monitorName: string }>;
  } {
    this.pruneNotifications();
    const existing = this.db
      .prepare("SELECT batch_id batchId,events FROM notification_batches WHERE client_id=?")
      .get(clientId) as { batchId: string; events: string } | undefined;
    if (existing)
      return {
        batchId: existing.batchId,
        events: JSON.parse(existing.events).filter((event: { monitorId: number }) =>
          this.areNotificationsEnabledForClient(event.monitorId, clientId),
        ),
      };
    const client = this.db
      .prepare("SELECT last_notification_event_id cursor FROM extension_clients WHERE id=?")
      .get(clientId) as { cursor: number } | undefined;
    if (!client) throw new Error("Unknown notification client");
    // Bound scanned rows too; muted events advance only when this batch is acknowledged.
    const rows = this.db
      .prepare(`SELECT e.id eventId,e.monitor_id monitorId,m.name monitorName,e.external_id externalId,
      e.title,e.url,e.price,e.image_url imageUrl FROM notification_events e JOIN monitors m ON m.id=e.monitor_id
      WHERE e.id>? ORDER BY e.id LIMIT 50`)
      .all(client.cursor) as unknown as Array<Listing & { eventId: number; monitorId: number; monitorName: string }>;
    const events = rows.filter((event) => this.areNotificationsEnabledForClient(event.monitorId, clientId));
    const batchId = randomUUID();
    this.db
      .prepare("INSERT INTO notification_batches(client_id,batch_id,through_id,events,created_at) VALUES(?,?,?,?,?)")
      .run(
        clientId,
        batchId,
        rows.at(-1)?.eventId ?? client.cursor,
        JSON.stringify(events),
        new Date(this.now()).toISOString(),
      );
    return { batchId, events };
  }

  acknowledgeNotifications(clientId: number, batchId: string): boolean {
    // Opaque capability bound to an authenticated client; never accept a caller-supplied cursor.
    const batch = this.db
      .prepare("SELECT through_id cursor FROM notification_batches WHERE client_id=? AND batch_id=?")
      .get(clientId, batchId) as { cursor: number } | undefined;
    if (!batch) return false;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE extension_clients SET last_notification_event_id=MAX(last_notification_event_id,?) WHERE id=?")
        .run(batch.cursor, clientId);
      this.db.prepare("DELETE FROM notification_batches WHERE client_id=?").run(clientId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  private pruneNotifications(): void {
    const cutoff = new Date(this.now() - 30 * 24 * 60 * 60_000).toISOString();
    this.db.prepare("DELETE FROM notification_events WHERE created_at<?").run(cutoff);
    this.db.prepare("DELETE FROM notification_batches WHERE created_at<?").run(cutoff);
  }

  pullNotifications(clientId: number): Array<Listing & { eventId: number; monitorId: number; monitorName: string }> {
    const batch = this.notificationBatch(clientId);
    this.acknowledgeNotifications(clientId, batch.batchId);
    return batch.events;
  }

  claimTelegramJob(now = this.now()): TelegramJob | undefined {
    if (this.nextTelegramCleanupAt === undefined || now >= this.nextTelegramCleanupAt) {
      this.db.prepare("DELETE FROM telegram_jobs WHERE finished_at<?").run(now - 30 * 86400_000);
      this.nextTelegramCleanupAt = now + 5 * 60_000;
    }
    // Lease also recovers work interrupted by process termination. One bounded worker per process.
    const row = this.db
      .prepare(`UPDATE telegram_jobs SET status='sending',attempts=attempts+1,available_at=?
      WHERE id=(SELECT id FROM telegram_jobs WHERE status IN ('pending','sending') AND available_at<=? ORDER BY id LIMIT 1)
      RETURNING id,chat_id chatId,payload,attempts`)
      .get(now + 60_000, now) as { id: number; chatId: string; payload: string; attempts: number } | undefined;
    return row ? { ...row, ...JSON.parse(row.payload) } : undefined;
  }

  finishTelegramJob(
    job: TelegramJob,
    error?: { permanent: boolean; retryAfterMs: number; message: string },
    now = this.now(),
  ): void {
    const terminal = !error || error.permanent || job.attempts >= 12;
    this.db
      .prepare(
        "UPDATE telegram_jobs SET status=?,available_at=?,finished_at=?,last_error=? WHERE id=? AND attempts=? AND status='sending'",
      )
      .run(
        !error ? "sent" : terminal ? "failed" : "pending",
        now + Math.max(error?.retryAfterMs || 0, Math.min(3600_000, 1000 * 2 ** job.attempts)),
        terminal ? now : null,
        error?.message || null,
        job.id,
        job.attempts,
      );
  }

  recentListings(
    limit = 50,
  ): Array<Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }> {
    return this.monitors.recentListings(limit);
  }

  close(): void {
    this.db.close();
  }
}
