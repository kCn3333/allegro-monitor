import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabaseSchema } from "./database-schema.js";
import { NotificationsRepository } from "./repositories/notifications.js";
import { TelegramRepository, type TelegramJob } from "./repositories/telegram.js";
import { MonitorsRepository } from "./repositories/monitors.js";
import type { DeviceInfo, ExtensionClient, Listing, Monitor, MonitorExclusion } from "./types.js";

export type { TelegramJob } from "./repositories/telegram.js";

export class Store {
  private readonly db: DatabaseSync;
  private readonly listingRetentionChecks: number;
  private nextSessionCleanupAt?: number;
  private readonly notifications: NotificationsRepository;
  private readonly telegram: TelegramRepository;
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
    this.notifications = new NotificationsRepository(this.db, this.now, (monitorId, clientId) =>
      this.areNotificationsEnabledForClient(monitorId, clientId),
    );
    this.telegram = new TelegramRepository(this.db, this.now);
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
    return this.notifications.notificationBatch(clientId);
  }

  acknowledgeNotifications(clientId: number, batchId: string): boolean {
    return this.notifications.acknowledgeNotifications(clientId, batchId);
  }

  pullNotifications(clientId: number): Array<Listing & { eventId: number; monitorId: number; monitorName: string }> {
    return this.notifications.pullNotifications(clientId);
  }

  claimTelegramJob(now = this.now()): TelegramJob | undefined {
    return this.telegram.claimTelegramJob(now);
  }

  finishTelegramJob(
    job: TelegramJob,
    error?: { permanent: boolean; retryAfterMs: number; message: string },
    now = this.now(),
  ): void {
    this.telegram.finishTelegramJob(job, error, now);
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
