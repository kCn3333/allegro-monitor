import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabaseSchema } from "./database-schema.js";
import { ClientsRepository } from "./repositories/clients.js";
import { NotificationsRepository } from "./repositories/notifications.js";
import { TelegramRepository, type TelegramJob } from "./repositories/telegram.js";
import { MonitorsRepository } from "./repositories/monitors.js";
import type { DeviceInfo, ExtensionClient, Listing, Monitor, MonitorExclusion } from "./types.js";

export type { TelegramJob } from "./repositories/telegram.js";

export class Store {
  private readonly db: DatabaseSync;
  private readonly listingRetentionChecks: number;
  private nextSessionCleanupAt?: number;
  private readonly clients: ClientsRepository;
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
    this.clients = new ClientsRepository(this.db, this.now);
    this.notifications = new NotificationsRepository(this.db, this.now, (monitorId, clientId) =>
      this.clients.areNotificationsEnabledForClient(monitorId, clientId),
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
    return this.monitors.recentListings(limit);
  }

  close(): void {
    this.db.close();
  }
}
