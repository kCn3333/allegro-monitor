import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabaseSchema } from "./database-schema.js";
import { SessionsRepository } from "./repositories/sessions.js";
import { ClientsRepository } from "./repositories/clients.js";
import { NotificationsRepository } from "./repositories/notifications.js";
import { TelegramRepository, type TelegramJob } from "./repositories/telegram.js";
import type { DeviceInfo, ExtensionClient, Listing, Monitor, MonitorExclusion } from "./types.js";

export type { TelegramJob } from "./repositories/telegram.js";

const MONITOR_COLUMNS = `SELECT id, name, url, interval_minutes intervalMinutes,
      enabled, initialized, last_checked_at lastCheckedAt,
      last_error lastError, created_at createdAt, new_listings_count newListingsCount, last_check_new_count lastCheckNewCount,
      (SELECT COUNT(*) FROM listings l WHERE l.monitor_id=monitors.id AND l.missing_checks=0 AND NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)) currentListingsCount,
      (SELECT COUNT(*) FROM monitor_exclusions e WHERE e.monitor_id=monitors.id) excludedListingsCount`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly listingRetentionChecks: number;
  private readonly sessions: SessionsRepository;
  private readonly clients: ClientsRepository;
  private readonly notifications: NotificationsRepository;
  private readonly telegram: TelegramRepository;

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
    this.sessions = new SessionsRepository(this.db, this.now);
    this.clients = new ClientsRepository(this.db, this.now);
    this.notifications = new NotificationsRepository(this.db, this.now, (monitorId, clientId) =>
      this.clients.areNotificationsEnabledForClient(monitorId, clientId),
    );
    this.telegram = new TelegramRepository(this.db, this.now);
  }

  listMonitors(): Monitor[] {
    const activeSince = new Date(this.now() - 3 * 60_000).toISOString();
    return this.db
      .prepare(`${MONITOR_COLUMNS},
      (SELECT COUNT(*) FROM monitor_clients mc WHERE mc.monitor_id=monitors.id AND mc.tab_open=1 AND mc.last_seen_at>=?) activeClientsCount
      FROM monitors ORDER BY created_at DESC`)
      .all(activeSince) as unknown as Monitor[];
  }

  createMonitor(name: string, url: string, intervalMinutes: number): number {
    const now = new Date(this.now()).toISOString();
    const result = this.db
      .prepare("INSERT INTO monitors(name,url,interval_minutes,next_check_at,created_at) VALUES(?,?,?,?,?)")
      .run(name, url, intervalMinutes, now, now);
    return Number(result.lastInsertRowid);
  }

  getMonitor(id: number): Monitor | undefined {
    return this.db
      .prepare(`${MONITOR_COLUMNS},
      0 activeClientsCount
      FROM monitors WHERE id=?`)
      .get(id) as unknown as Monitor | undefined;
  }

  findMonitorByUrl(url: string): Monitor | undefined {
    return this.db
      .prepare(`${MONITOR_COLUMNS},
      0 activeClientsCount
      FROM monitors WHERE url=? ORDER BY id LIMIT 1`)
      .get(url) as unknown as Monitor | undefined;
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
    this.db.prepare("UPDATE monitors SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id = ?").run(id);
  }

  saveCheck(monitor: Monitor, listings: Listing[], telegramChatIds: string[] = []): Listing[] {
    const now = new Date(this.now()).toISOString();
    const excluded = new Set(
      (
        this.db
          .prepare("SELECT external_id externalId FROM monitor_exclusions WHERE monitor_id=?")
          .all(monitor.id) as Array<{ externalId: string }>
      ).map((item) => item.externalId),
    );
    const insert = this.db.prepare(`INSERT OR IGNORE INTO listings
      (monitor_id,external_id,title,url,price,image_url,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)`);
    const markSeen =
      this.db.prepare(`UPDATE listings SET title=?,url=?,price=?,image_url=?,last_seen_at=?,missing_checks=0
      WHERE monitor_id=? AND external_id=?`);
    const addEvent = this.db.prepare(`INSERT INTO notification_events
      (monitor_id,external_id,title,url,price,image_url,created_at) VALUES(?,?,?,?,?,?,?)`);
    const markNewInCycle = this.db.prepare("UPDATE listings SET new_in_cycle=? WHERE monitor_id=? AND external_id=?");
    const addTelegramJob = this.db.prepare("INSERT INTO telegram_jobs(chat_id,payload,available_at) VALUES(?,?,?)");
    const fresh: Listing[] = [];
    this.db.exec("BEGIN");
    try {
      const { cycle } = this.db
        .prepare("UPDATE monitors SET check_cycle=check_cycle+1 WHERE id=? RETURNING check_cycle cycle")
        .get(monitor.id) as { cycle: number };
      this.db.prepare("UPDATE listings SET missing_checks=missing_checks+1 WHERE monitor_id=?").run(monitor.id);
      for (const listing of listings) {
        const result = insert.run(
          monitor.id,
          listing.externalId,
          listing.title,
          listing.url,
          listing.price,
          listing.imageUrl,
          now,
          now,
        );
        markSeen.run(listing.title, listing.url, listing.price, listing.imageUrl, now, monitor.id, listing.externalId);
        if (result.changes > 0 && monitor.initialized === 1 && !excluded.has(listing.externalId)) {
          fresh.push(listing);
          markNewInCycle.run(cycle, monitor.id, listing.externalId);
          for (const chatId of new Set(telegramChatIds)) {
            addTelegramJob.run(chatId, JSON.stringify({ monitorName: monitor.name, listing }), this.now());
          }
          addEvent.run(
            monitor.id,
            listing.externalId,
            listing.title,
            listing.url,
            listing.price,
            listing.imageUrl,
            now,
          );
        }
      }
      this.db
        .prepare("DELETE FROM listings WHERE monitor_id=? AND missing_checks>=?")
        .run(monitor.id, this.listingRetentionChecks);
      this.db
        .prepare(`UPDATE monitors SET initialized=1,last_checked_at=?,last_error=NULL,
        new_listings_count=new_listings_count+?,last_check_new_count=? WHERE id=?`)
        .run(now, fresh.length, fresh.length, monitor.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return fresh;
  }

  addExclusion(monitorId: number, externalId: string): boolean {
    const listing = this.db
      .prepare("SELECT title FROM listings WHERE monitor_id=? AND external_id=?")
      .get(monitorId, externalId) as { title: string } | undefined;
    if (!listing) return false;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO monitor_exclusions(monitor_id,external_id,title,created_at) VALUES(?,?,?,?)")
        .run(monitorId, externalId, listing.title, new Date(this.now()).toISOString());
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
    return this.db
      .prepare(`SELECT monitor_id monitorId,external_id externalId,title,created_at createdAt
      FROM monitor_exclusions ORDER BY created_at DESC`)
      .all() as unknown as MonitorExclusion[];
  }

  saveError(monitor: Monitor, error: unknown): void {
    const now = new Date(this.now());
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare("UPDATE monitors SET last_checked_at=?,last_error=?,last_check_new_count=0 WHERE id=?")
      .run(now.toISOString(), message.slice(0, 1000), monitor.id);
  }

  addExtensionClient(name: string, tokenHash: string): number {
    return this.clients.addExtensionClient(name, tokenHash);
  }

  renameExtensionClient(id: number, name: string): boolean {
    return this.clients.renameExtensionClient(id, name);
  }

  revokeExtensionClient(id: number): boolean {
    return this.clients.revokeExtensionClient(id);
  }

  revokeAllExtensionClients(): void {
    this.clients.revokeAllExtensionClients();
  }

  touchExtensionClient(tokenHash: string): number | null {
    return this.clients.touchExtensionClient(tokenHash);
  }

  updateExtensionClientInfo(id: number, info: DeviceInfo): void {
    this.clients.updateExtensionClientInfo(id, info);
  }

  listExtensionClients(at = this.now()): ExtensionClient[] {
    return this.clients.listExtensionClients(at);
  }

  createWebSession(tokenHash: string, credentialFingerprint: string, durationSeconds: number): void {
    this.sessions.createWebSession(tokenHash, credentialFingerprint, durationSeconds);
  }

  touchWebSession(tokenHash: string, credentialFingerprint: string): number | null {
    return this.sessions.touchWebSession(tokenHash, credentialFingerprint);
  }

  deleteWebSession(tokenHash: string): void {
    this.sessions.deleteWebSession(tokenHash);
  }

  linkMonitorClient(monitorId: number, clientId: number, tabOpen = true): void {
    this.clients.linkMonitorClient(monitorId, clientId, tabOpen);
  }

  linkClientToAllMonitors(clientId: number): void {
    this.clients.linkClientToAllMonitors(clientId);
  }

  linkMonitorToAllClients(monitorId: number, openClientId: number): void {
    this.clients.linkMonitorToAllClients(monitorId, openClientId);
  }

  hasMonitorClient(monitorId: number, clientId: number): boolean {
    return this.clients.hasMonitorClient(monitorId, clientId);
  }

  areNotificationsEnabledForClient(monitorId: number, clientId: number): boolean {
    return this.clients.areNotificationsEnabledForClient(monitorId, clientId);
  }

  setNotificationsForClient(monitorId: number, clientId: number, enabled: boolean): void {
    this.clients.setNotificationsForClient(monitorId, clientId, enabled);
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
    return this.db
      .prepare(`SELECT l.external_id externalId,l.title,l.url,l.price,l.image_url imageUrl,l.monitor_id monitorId,
      l.first_seen_at firstSeenAt,m.name monitorName,
      CASE WHEN m.last_check_new_count>0 AND l.new_in_cycle=m.check_cycle THEN 1 ELSE 0 END fromLatestCheck
      FROM listings l JOIN monitors m ON m.id=l.monitor_id
      WHERE NOT EXISTS (SELECT 1 FROM monitor_exclusions e WHERE e.monitor_id=l.monitor_id AND e.external_id=l.external_id)
      ORDER BY l.first_seen_at DESC LIMIT ?`)
      .all(limit) as unknown as Array<
      Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }
    >;
  }

  close(): void {
    this.db.close();
  }
}
