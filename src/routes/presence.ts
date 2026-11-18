import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "../database.js";
import type { DeviceInfo } from "../types.js";

function deviceInfo(device: unknown): DeviceInfo | null {
  if (!device || typeof device !== "object" || Array.isArray(device)) return null;
  const info = {} as DeviceInfo;
  for (const key of ["extensionVersion", "browser", "os", "osVersion", "arch"] as const) {
    const value = (device as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 160)) return null;
    info[key] = typeof value === "string" ? value.trim() || null : null;
  }
  return info;
}

function jsonInputErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY")
    return reply.code(400).send({ error: "Nieprawidłowy JSON" });
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({ error: "Zbyt duże żądanie" });
  return reply.send(error);
}

interface PresenceRouteDependencies {
  store: Store;
  extensionClientId: (request: FastifyRequest, reply: FastifyReply) => number | null;
  latestExtensionVersion: string;
}

export function registerPresenceRoutes(
  app: FastifyInstance,
  { store, extensionClientId, latestExtensionVersion }: PresenceRouteDependencies,
): void {
  app.post<{
    Body: { monitors?: Array<{ id?: number; open?: boolean }>; notificationProtocol?: number; device?: unknown };
  }>(
    "/api/extension/presence",
    {
      errorHandler: jsonInputErrorHandler,
    },
    async (request, reply) => {
      const clientId = extensionClientId(request, reply);
      if (!clientId) return;
      const monitors = request.body?.monitors;
      if (!Array.isArray(monitors) || monitors.length > 100)
        return reply.code(400).send({ error: "Nieprawidłowa lista obecności" });
      const device = request.body?.device;
      if (device !== undefined) {
        const info = deviceInfo(device);
        if (!info) return reply.code(400).send({ error: "Nieprawidłowe dane urządzenia" });
        store.updateExtensionClientInfo(clientId, info);
      }
      let updated = 0;
      for (const presence of monitors) {
        const id = Number(presence?.id);
        if (!Number.isSafeInteger(id) || id <= 0 || !store.getMonitor(id)) continue;
        store.linkMonitorClient(id, clientId, presence.open === true);
        updated += 1;
      }
      const synchronized = store.listMonitors().map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        url: monitor.url,
        intervalMinutes: monitor.intervalMinutes,
        enabled: Boolean(monitor.enabled),
        newListingsCount: monitor.newListingsCount,
        lastCheckNewCount: monitor.lastCheckNewCount,
        activeClientsCount: monitor.activeClientsCount,
        notificationsEnabled: store.areNotificationsEnabledForClient(monitor.id, clientId),
      }));
      if (request.body.notificationProtocol === 2) {
        const batch = store.notificationBatch(clientId);
        return reply.send({
          updated,
          monitors: synchronized,
          notifications: batch.events,
          notificationBatch: batch.batchId,
          latestExtensionVersion,
        });
      }
      return reply.send({
        updated,
        monitors: synchronized,
        notifications: store.pullNotifications(clientId),
        latestExtensionVersion,
      });
    },
  );

  app.post<{ Body: { batchId: string } }>(
    "/api/extension/notifications/ack",
    {
      errorHandler: jsonInputErrorHandler,
    },
    async (request, reply) => {
      const clientId = extensionClientId(request, reply);
      if (!clientId) return;
      const batchId = request.body?.batchId;
      if (typeof batchId !== "string" || batchId.length > 100)
        return reply.code(400).send({ error: "Nieprawidłowy ACK" });
      // Repeated/unknown ACK is a safe no-op; it cannot advance any cursor.
      return { acknowledged: store.acknowledgeNotifications(clientId, batchId) };
    },
  );
}
