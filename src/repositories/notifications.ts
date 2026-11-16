import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../types.js";

export class NotificationsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly areNotificationsEnabledForClient: (monitorId: number, clientId: number) => boolean,
  ) {}

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
}
