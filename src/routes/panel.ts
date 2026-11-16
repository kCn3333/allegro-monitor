import type { FastifyInstance } from "fastify";
import type { Store } from "../database.js";
import { renderFaq } from "../faq.js";
import { renderPage } from "../ui.js";

interface PanelRouteDependencies {
  store: Store;
  parseMonitorId: (value: string) => number | null;
}

export function registerPanelRoutes(app: FastifyInstance, { store, parseMonitorId }: PanelRouteDependencies): void {
  app.get("/", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(renderPage(store.listMonitors(), store.recentListings(), store.listExclusions())),
  );
  app.get("/faq", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderFaq()));

  app.post<{ Params: { id: string }; Body: { externalId?: string } }>(
    "/monitors/:id/exclusions",
    async (request, reply) => {
      const id = parseMonitorId(request.params.id);
      const externalId = String(request.body?.externalId || "").slice(0, 200);
      if (!id || !externalId) return reply.code(400).send("Nieprawidłowe dane wykluczenia");
      if (!store.addExclusion(id, externalId)) return reply.code(404).send("Pozycja nie istnieje w tym monitorze");
      return reply.redirect("/");
    },
  );

  app.post<{ Params: { id: string }; Body: { name?: unknown } }>("/monitors/:id/rename", async (request, reply) => {
    const id = parseMonitorId(request.params.id);
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!id || !name || name.length > 100 || !store.getMonitor(id))
      return reply.code(400).send("Nieprawidłowa nazwa monitora");
    store.renameMonitor(id, name);
    return reply.redirect("/");
  });

  app.post<{ Params: { id: string }; Body: { externalId?: string } }>(
    "/monitors/:id/exclusions/remove",
    async (request, reply) => {
      const id = parseMonitorId(request.params.id);
      const externalId = String(request.body?.externalId || "").slice(0, 200);
      if (!id || !externalId) return reply.code(400).send("Nieprawidłowe dane wykluczenia");
      store.removeExclusion(id, externalId);
      return reply.redirect("/");
    },
  );

  app.post<{ Params: { id: string } }>("/monitors/:id/toggle", async (request, reply) => {
    const id = parseMonitorId(request.params.id);
    if (!id) return reply.code(400).send("Nieprawidłowy identyfikator monitora");
    store.toggleMonitor(id);
    return reply.redirect("/");
  });
  app.post<{ Params: { id: string } }>("/monitors/:id/delete", async (request, reply) => {
    const id = parseMonitorId(request.params.id);
    if (!id) return reply.code(400).send("Nieprawidłowy identyfikator monitora");
    store.deleteMonitor(id);
    return reply.redirect("/");
  });
}
