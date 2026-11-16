import type { FastifyInstance } from "fastify";
import type { Store } from "../database.js";
import { renderDevices } from "../devices.js";

interface DeviceRouteDependencies {
  store: Store;
  parseMonitorId: (value: string) => number | null;
  clearPairingCodes: () => void;
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  { store, parseMonitorId, clearPairingCodes }: DeviceRouteDependencies,
): void {
  app.post("/devices/revoke-all", async (_request, reply) => {
    store.revokeAllExtensionClients();
    clearPairingCodes();
    return reply.redirect("/devices");
  });
  app.post<{ Params: { id: string } }>("/devices/:id/revoke", async (request, reply) => {
    const id = parseMonitorId(request.params.id);
    if (!id) return reply.code(400).send("Nieprawidłowy identyfikator urządzenia");
    if (!store.revokeExtensionClient(id)) return reply.code(404).send("Urządzenie nie istnieje");
    return reply.redirect("/devices");
  });
  app.post<{ Params: { id: string }; Body: { name?: unknown } }>("/devices/:id/rename", async (request, reply) => {
    const id = parseMonitorId(request.params.id);
    if (!id) return reply.code(400).send("Nieprawidłowy identyfikator urządzenia");
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name || name.length > 100) return reply.code(400).send("Nazwa urządzenia musi mieć od 1 do 100 znaków");
    if (!store.renameExtensionClient(id, name)) return reply.code(404).send("Urządzenie nie istnieje");
    return reply.redirect("/devices");
  });

  app.get("/devices", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(renderDevices(store.listExtensionClients())),
  );
}
