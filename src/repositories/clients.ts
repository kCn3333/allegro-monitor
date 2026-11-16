import type { DatabaseSync } from "node:sqlite";
import type { DeviceInfo, ExtensionClient } from "../types.js";

export class ClientsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

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
}
