import { Ajv } from "ajv";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "../database.js";
import { assertAllegroUrl, validateListings } from "../validation.js";

const monitorSchema = {
  type: "object",
  required: ["name"],
  additionalProperties: true,
  properties: {
    name: { type: "string", format: "monitor-name" },
    // Keep Number(intervalMinutes) and assertAllegroUrl conversions in the handler.
    intervalMinutes: {},
    url: {},
  },
};

const resultsSchema = {
  type: "object",
  required: ["listings"],
  additionalProperties: true,
  // Individual offers remain permissive; validateListings owns their validation and normalization.
  properties: { listings: { type: "array", maxItems: 200, items: {} } },
};

// Legacy error reports accept any body and message type, including a missing body.
const errorReportSchema = {};

function jsonInputErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY")
    return reply.code(400).send({ error: "Nieprawidłowy JSON" });
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({ error: "Zbyt duże żądanie" });
  return reply.send(error);
}

interface ExtensionMonitorRouteDependencies {
  store: Store;
  extensionClientId: (request: FastifyRequest, reply: FastifyReply) => number | null;
  parseMonitorId: (value: string) => number | null;
  allowedIntervals: ReadonlySet<number>;
  settings: { telegramBotToken: string; telegramChatIds: string[] };
}

export function registerExtensionMonitorRoutes(
  app: FastifyInstance,
  { store, extensionClientId, parseMonitorId, allowedIntervals, settings }: ExtensionMonitorRouteDependencies,
): void {
  const validator = new Ajv({ coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: false });
  validator.addFormat("monitor-name", (value: string) => {
    // Validate the trimmed UTF-16 length without modifying the request payload.
    const length = value.trim().length;
    return length > 0 && length <= 100;
  });
  app.post<{ Body: { name?: unknown; url?: string; intervalMinutes?: number } }>(
    "/api/extension/monitors",
    {
      schema: { body: monitorSchema },
      validatorCompiler: ({ schema }) => validator.compile(schema),
      attachValidation: true,
      errorHandler: jsonInputErrorHandler,
    },
    async (request, reply) => {
      const clientId = extensionClientId(request, reply);
      if (!clientId) return;
      const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
      if (request.validationError) return reply.code(400).send({ error: "Nieprawidłowe dane monitora" });
      const interval = Number(request.body?.intervalMinutes);
      if (!allowedIntervals.has(interval)) return reply.code(400).send({ error: "Nieprawidłowe dane monitora" });
      let url: URL;
      try {
        url = assertAllegroUrl(request.body?.url || "");
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Nieprawidłowy URL" });
      }
      const existing = store.findMonitorByUrl(url.toString());
      if (existing) {
        store.updateMonitorSettings(existing.id, name, interval);
        store.linkMonitorClient(existing.id, clientId);
        return reply.send({
          id: existing.id,
          name,
          url: existing.url,
          intervalMinutes: interval,
          newListingsCount: existing.newListingsCount,
          lastCheckNewCount: existing.lastCheckNewCount,
        });
      }
      const id = store.createMonitor(name, url.toString(), interval);
      store.linkMonitorToAllClients(id, clientId);
      return reply.send({
        id,
        name,
        url: url.toString(),
        intervalMinutes: interval,
        newListingsCount: 0,
        lastCheckNewCount: 0,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { listings?: unknown } }>(
    "/api/extension/monitors/:id/results",
    {
      schema: { body: resultsSchema },
      validatorCompiler: ({ schema }) => validator.compile(schema),
      attachValidation: true,
      errorHandler: jsonInputErrorHandler,
    },
    async (request, reply) => {
      const clientId = extensionClientId(request, reply);
      if (!clientId) return;
      const id = parseMonitorId(request.params.id);
      if (!id) return reply.code(400).send({ error: "Nieprawidłowy identyfikator monitora" });
      const monitor = store.getMonitor(id);
      if (!monitor || !monitor.enabled || !store.hasMonitorClient(id, clientId))
        return reply.code(404).send({ error: "Monitor nie istnieje lub jest wyłączony" });
      store.linkMonitorClient(id, clientId, true);
      if (request.validationError) return reply.code(400).send({ error: "Nieprawidłowa lista ofert" });
      let listings;
      try {
        listings = validateListings(request.body?.listings);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Nieprawidłowe wyniki" });
      }
      const fresh = store.saveCheck(monitor, listings, settings.telegramBotToken ? settings.telegramChatIds : []);
      return reply.send({
        accepted: listings.length,
        newListings: fresh,
        newListingsCount: monitor.newListingsCount + fresh.length,
        lastCheckNewCount: fresh.length,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/api/extension/monitors/:id/error",
    {
      schema: { body: errorReportSchema },
      validatorCompiler: ({ schema }) => validator.compile(schema),
      attachValidation: true,
      errorHandler: jsonInputErrorHandler,
    },
    async (request, reply) => {
      const clientId = extensionClientId(request, reply);
      if (!clientId) return;
      const id = parseMonitorId(request.params.id);
      if (!id) return reply.code(400).send({ error: "Nieprawidłowy identyfikator monitora" });
      const monitor = store.getMonitor(id);
      if (!monitor || !store.hasMonitorClient(id, clientId))
        return reply.code(404).send({ error: "Monitor nie istnieje lub nie należy do tego rozszerzenia" });
      store.saveError(monitor, new Error(String(request.body?.message || "Nieznany błąd rozszerzenia").slice(0, 1000)));
      return reply.send({ saved: true });
    },
  );

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    "/api/extension/monitors/:id/notification-state",
    async (request, reply) => {
      const clientId = extensionClientId(request, reply);
      if (!clientId) return;
      const id = parseMonitorId(request.params.id);
      if (!id || typeof request.body?.enabled !== "boolean") return reply.code(400).send("Nieprawidłowy stan monitora");
      if (!store.getMonitor(id)) return reply.code(404).send("Monitor nie istnieje");
      store.setNotificationsForClient(id, clientId, request.body.enabled);
      return reply.send({ enabled: request.body.enabled });
    },
  );
}
