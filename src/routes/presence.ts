import { Ajv } from "ajv";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "../database.js";
import type { DeviceInfo } from "../types.js";

const metadataSchema = { type: ["string", "null"], maxCodeUnits: 160 };
const presenceSchema = {
  type: "object",
  required: ["monitors"],
  additionalProperties: true,
  properties: {
    // Entries and protocol stay permissive: the handler retains Number(id), open === true and protocol === 2.
    monitors: { type: "array", maxItems: 100, items: {} },
    notificationProtocol: {},
    device: {
      type: "object",
      additionalProperties: true,
      properties: {
        extensionVersion: metadataSchema,
        browser: metadataSchema,
        os: metadataSchema,
        osVersion: metadataSchema,
        arch: metadataSchema,
      },
    },
  },
};

interface PresenceRouteDependencies {
  store: Store;
  extensionClientId: (request: FastifyRequest, reply: FastifyReply) => number | null;
  latestExtensionVersion: string;
}

export function registerPresenceRoutes(
  app: FastifyInstance,
  { store, extensionClientId, latestExtensionVersion }: PresenceRouteDependencies,
): void {
  const validator = new Ajv({ coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: false });
  // JSON Schema maxLength counts code points; the existing API counts UTF-16 code units.
  validator.addKeyword({
    keyword: "maxCodeUnits",
    type: "string",
    schemaType: "number",
    validate: (limit: number, value: string) => value.length <= limit,
    errors: false,
  });
  app.post<{
    Body: { monitors?: Array<{ id?: number; open?: boolean }>; notificationProtocol?: number; device?: unknown };
  }>(
    "/api/extension/presence",
    {
      schema: { body: presenceSchema },
      validatorCompiler: ({ schema }) => validator.compile(schema),
      attachValidation: true,
      errorHandler(error, _request, reply) {
        if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY")
          return reply.code(400).send({ error: "Nieprawidłowy JSON" });
        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({ error: "Zbyt duże żądanie" });
        return reply.send(error);
      },
    },
    async (request, reply) => {
      const clientId = extensionClientId(request, reply);
      if (!clientId) return;
      // Authenticate before reporting schema errors, as with the original manual validation.
      if (request.validationError) {
        const deviceError = request.validationError.validation?.[0]?.instancePath?.startsWith("/device");
        return reply
          .code(400)
          .send({ error: deviceError ? "Nieprawidłowe dane urządzenia" : "Nieprawidłowa lista obecności" });
      }
      const monitors = request.body.monitors!;
      const device = request.body?.device;
      if (device !== undefined) {
        const info = {} as DeviceInfo;
        for (const key of ["extensionVersion", "browser", "os", "osVersion", "arch"] as const) {
          const value = (device as Record<string, unknown>)[key];
          info[key] = typeof value === "string" ? value.trim() || null : null;
        }
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

  app.post<{ Body: { batchId?: string } }>("/api/extension/notifications/ack", async (request, reply) => {
    const clientId = extensionClientId(request, reply);
    if (!clientId) return;
    const batchId = request.body?.batchId;
    if (typeof batchId !== "string" || batchId.length > 100)
      return reply.code(400).send({ error: "Nieprawidłowy ACK" });
    // Repeated/unknown ACK is a safe no-op; it cannot advance any cursor.
    return { acknowledged: store.acknowledgeNotifications(clientId, batchId) };
  });
}
