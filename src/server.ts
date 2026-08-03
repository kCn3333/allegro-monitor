import crypto from "node:crypto";
import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { assertAllegroUrl } from "./allegro.js";
import { config } from "./config.js";
import { Store } from "./database.js";
import { Scheduler } from "./scheduler.js";
import { renderPage } from "./ui.js";

const app = Fastify({ logger: true, bodyLimit: 32_000 });
const store = new Store(config.databasePath);
const scheduler = new Scheduler(store);

await app.register(formbody);

app.addHook("onRequest", async (request, reply) => {
  if (!config.username || !config.password || request.url === "/health") return;
  const expected = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const actual = request.headers.authorization || "";
  const valid = actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  if (!valid) return reply.header("WWW-Authenticate", 'Basic realm="Allegro Monitor"').code(401).send("Logowanie wymagane");
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderPage(store.listMonitors(), store.recentListings())));

app.post<{ Body: { name?: string; url?: string; intervalMinutes?: string } }>("/monitors", async (request, reply) => {
  const name = request.body?.name?.trim();
  const rawUrl = request.body?.url?.trim();
  const interval = Number(request.body?.intervalMinutes);
  if (!name || !rawUrl || !Number.isInteger(interval) || interval < 2 || interval > 1440) return reply.code(400).send("Nieprawidłowe dane");
  let url: URL;
  try { url = assertAllegroUrl(rawUrl); } catch (error) { return reply.code(400).send(error instanceof Error ? error.message : "Nieprawidłowy URL"); }
  store.createMonitor(name, url.toString(), interval);
  return reply.redirect("/");
});

app.post<{ Params: { id: string } }>("/monitors/:id/check", async (request, reply) => { store.scheduleNow(Number(request.params.id)); void scheduler.tick(); return reply.redirect("/"); });
app.post<{ Params: { id: string } }>("/monitors/:id/toggle", async (request, reply) => { store.toggleMonitor(Number(request.params.id)); return reply.redirect("/"); });
app.post<{ Params: { id: string } }>("/monitors/:id/delete", async (request, reply) => { store.deleteMonitor(Number(request.params.id)); return reply.redirect("/"); });

const shutdown = async () => { scheduler.stop(); await app.close(); store.close(); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port: config.port, host: config.host });
scheduler.start();
