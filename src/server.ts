import crypto from "node:crypto";
import fs from "node:fs";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "./config.js";
import { Store } from "./database.js";
import { renderFaq } from "./faq.js";
import { notifyTelegram } from "./notifications.js";
import { isSameOriginRequest } from "./security.js";
import { renderPage } from "./ui.js";
import { assertAllegroUrl, validateListings } from "./validation.js";

if (process.env.NODE_ENV === "production" && (!config.username || !config.password)) {
  throw new Error("APP_USERNAME i APP_PASSWORD są wymagane w środowisku produkcyjnym");
}

const app = Fastify({ logger: true, bodyLimit: 256_000 });
const store = new Store(config.databasePath, config.listingRetentionChecks);
const pairingCodes = new Map<string, number>();
const attempts = new Map<string, { count: number; resetAt: number }>();
const allowedIntervals = new Set([1, 5, 15, 30, 60]);

await app.register(formbody);

function validBasic(request: FastifyRequest): boolean {
  if (!config.username || !config.password) return true;
  const expected = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const actual = request.headers.authorization || "";
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function tokenHash(token: string): string { return crypto.createHash("sha256").update(token).digest("hex"); }
function extensionClientId(request: FastifyRequest, reply: FastifyReply): number | null {
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || "";
  const clientId = token && token.length <= 128 ? store.touchExtensionClient(tokenHash(token)) : null;
  if (!clientId) { void reply.code(401).send({ error: "Nieprawidłowy token rozszerzenia" }); return null; }
  return clientId;
}

function allowAttempt(key: string, maximum: number, windowMs: number): boolean {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) { attempts.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  current.count += 1;
  return current.count <= maximum;
}

function parseMonitorId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

app.addHook("onRequest", async (request, reply) => {
  reply.headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  const path = request.url.split("?", 1)[0];
  if (path === "/health" || path === "/api/extension/pair" || path === "/api/extension/presence" || path?.startsWith("/api/extension/monitors")) return;
  if (!validBasic(request)) {
    if (!allowAttempt(`basic:${request.ip}`, 20, 15 * 60_000)) return reply.code(429).send("Zbyt wiele prób logowania");
    return reply.header("WWW-Authenticate", 'Basic realm="Allegro Monitor"').code(401).send("Logowanie wymagane");
  }
  attempts.delete(`basic:${request.ip}`);
  if (request.method === "POST" && path?.startsWith("/monitors/") && !isSameOriginRequest(request.headers)) return reply.code(403).send("Żądanie cross-site zostało odrzucone");
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderPage(store.listMonitors(), store.recentListings(), store.listExclusions())));
app.get("/faq", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderFaq()));

app.get("/extension", async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rozszerzenie Allegro Monitor</title><style>:root{font-family:system-ui;color-scheme:light dark}body{max-width:720px;margin:50px auto;padding:0 20px;line-height:1.55}main{padding:28px;border:1px solid #8885;border-radius:16px}h1{margin-top:0}button,a.button{display:inline-block;background:#d8612c;color:#fff;border:0;border-radius:9px;padding:11px 16px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}code{background:#8882;padding:3px 6px;border-radius:5px}#code{font-size:28px;font-weight:800;letter-spacing:.08em;margin:20px 0}.muted{opacity:.7}li{margin:7px 0}</style></head><body><main><h1>Rozszerzenie dla Vivaldi</h1><p>Pobierz prototyp, zainstaluj go ręcznie, a następnie sparuj jednorazowym kodem.</p><p><a class="button" href="/extension/download">Pobierz rozszerzenie ZIP</a></p><ol><li>Rozpakuj ZIP w stałym katalogu.</li><li>Otwórz <code>vivaldi://extensions</code>.</li><li>Włącz Tryb dewelopera i kliknij „Załaduj rozpakowane”.</li><li>Wskaż rozpakowany katalog.</li><li>Wygeneruj kod poniżej i wpisz go w popupie rozszerzenia.</li></ol><button id="generate">Wygeneruj kod parowania</button><div id="code"></div><p class="muted">Kod jest jednorazowy i ważny przez 10 minut.</p><p><a href="/">← Wróć do panelu</a></p></main><script>document.querySelector('#generate').onclick=async()=>{const r=await fetch('/api/extension/pairing-code',{method:'POST'});const d=await r.json();document.querySelector('#code').textContent=d.code||d.error}</script></body></html>`));

app.get("/extension/download", async (_request, reply) => {
  if (!fs.existsSync(config.extensionZipPath)) return reply.code(404).send("Paczka rozszerzenia nie została zbudowana");
  return reply.header("Content-Disposition", 'attachment; filename="allegro-monitor-extension.zip"').type("application/zip").send(fs.createReadStream(config.extensionZipPath));
});

app.post("/api/extension/pairing-code", async (_request, reply) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = Array.from(crypto.randomBytes(8), byte => alphabet[byte % alphabet.length]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  pairingCodes.set(code, Date.now() + 10 * 60_000);
  return reply.send({ code, expiresInSeconds: 600 });
});

app.post<{ Body: { code?: string; name?: string } }>("/api/extension/pair", async (request, reply) => {
  if (!allowAttempt(`pair:${request.ip}`, 12, 15 * 60_000)) return reply.code(429).send("Zbyt wiele prób parowania");
  const code = request.body?.code?.trim().toUpperCase() || "";
  const expires = pairingCodes.get(code);
  if (!expires || expires < Date.now()) { pairingCodes.delete(code); return reply.code(400).send("Kod jest nieprawidłowy lub wygasł"); }
  pairingCodes.delete(code);
  attempts.delete(`pair:${request.ip}`);
  const token = crypto.randomBytes(32).toString("base64url");
  const clientId = store.addExtensionClient(request.body?.name || "Vivaldi", tokenHash(token));
  store.linkClientToAllMonitors(clientId);
  return reply.send({ token });
});

app.post<{ Body: { name?: string; url?: string; intervalMinutes?: number } }>("/api/extension/monitors", async (request, reply) => {
  const clientId = extensionClientId(request, reply);
  if (!clientId) return;
  const name = request.body?.name?.trim();
  const interval = Number(request.body?.intervalMinutes);
  if (!name || name.length > 100 || !allowedIntervals.has(interval)) return reply.code(400).send("Nieprawidłowe dane monitora");
  let url: URL; try { url = assertAllegroUrl(request.body?.url || ""); } catch (error) { return reply.code(400).send(error instanceof Error ? error.message : "Nieprawidłowy URL"); }
  const existing = store.findMonitorByUrl(url.toString());
  if (existing) {
    store.updateMonitorSettings(existing.id, name, interval);
    store.linkMonitorClient(existing.id, clientId);
    return reply.send({ id: existing.id, name, url: existing.url, intervalMinutes: interval, newListingsCount: existing.newListingsCount, lastCheckNewCount: existing.lastCheckNewCount });
  }
  const id = store.createMonitor(name, url.toString(), interval);
  store.linkMonitorToAllClients(id, clientId);
  return reply.send({ id, name, url: url.toString(), intervalMinutes: interval, newListingsCount: 0, lastCheckNewCount: 0 });
});

app.post<{ Body: { monitors?: Array<{ id?: number; open?: boolean }> } }>("/api/extension/presence", async (request, reply) => {
  const clientId = extensionClientId(request, reply);
  if (!clientId) return;
  const monitors = request.body?.monitors;
  if (!Array.isArray(monitors) || monitors.length > 100) return reply.code(400).send("Nieprawidłowa lista obecności");
  let updated = 0;
  for (const presence of monitors) {
    const id = Number(presence?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !store.getMonitor(id)) continue;
    store.linkMonitorClient(id, clientId, presence.open === true);
    updated += 1;
  }
  const synchronized = store.listMonitors().map(monitor => ({
    id: monitor.id, name: monitor.name, url: monitor.url, intervalMinutes: monitor.intervalMinutes,
    enabled: Boolean(monitor.enabled), newListingsCount: monitor.newListingsCount,
    lastCheckNewCount: monitor.lastCheckNewCount, activeClientsCount: monitor.activeClientsCount,
    notificationsEnabled: store.areNotificationsEnabledForClient(monitor.id, clientId)
  }));
  return reply.send({ updated, monitors: synchronized, notifications: store.pullNotifications(clientId) });
});

app.post<{ Params: { id: string }; Body: { listings?: unknown } }>("/api/extension/monitors/:id/results", async (request, reply) => {
  const clientId = extensionClientId(request, reply);
  if (!clientId) return;
  const id = parseMonitorId(request.params.id);
  if (!id) return reply.code(400).send("Nieprawidłowy identyfikator monitora");
  const monitor = store.getMonitor(id);
  if (!monitor || !monitor.enabled || !store.hasMonitorClient(id, clientId)) return reply.code(404).send("Monitor nie istnieje lub jest wyłączony");
  store.linkMonitorClient(id, clientId, true);
  let listings; try { listings = validateListings(request.body?.listings); } catch (error) { return reply.code(400).send(error instanceof Error ? error.message : "Nieprawidłowe wyniki"); }
  const fresh = store.saveCheck(monitor, listings);
  for (const listing of fresh) {
    try { await notifyTelegram(config.telegramBotToken, config.telegramChatIds, monitor.name, listing); }
    catch (error) { request.log.error({ err: error }, "Telegram notification failed"); }
  }
  return reply.send({ accepted: listings.length, newListings: fresh, newListingsCount: monitor.newListingsCount + fresh.length, lastCheckNewCount: fresh.length });
});

app.post<{ Params: { id: string }; Body: { message?: string } }>("/api/extension/monitors/:id/error", async (request, reply) => {
  const clientId = extensionClientId(request, reply);
  if (!clientId) return;
  const id = parseMonitorId(request.params.id);
  if (!id) return reply.code(400).send("Nieprawidłowy identyfikator monitora");
  const monitor = store.getMonitor(id);
  if (!monitor || !store.hasMonitorClient(id, clientId)) return reply.code(404).send("Monitor nie istnieje lub nie należy do tego rozszerzenia");
  store.saveError(monitor, new Error(String(request.body?.message || "Nieznany błąd rozszerzenia").slice(0, 1000)));
  return reply.send({ saved: true });
});

app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/extension/monitors/:id/notification-state", async (request, reply) => {
  const clientId = extensionClientId(request, reply);
  if (!clientId) return;
  const id = parseMonitorId(request.params.id);
  if (!id || typeof request.body?.enabled !== "boolean") return reply.code(400).send("Nieprawidłowy stan monitora");
  if (!store.getMonitor(id)) return reply.code(404).send("Monitor nie istnieje");
  store.setNotificationsForClient(id, clientId, request.body.enabled);
  return reply.send({ enabled: request.body.enabled });
});

app.post<{ Params: { id: string }; Body: { externalId?: string } }>("/monitors/:id/exclusions", async (request, reply) => {
  const id = parseMonitorId(request.params.id);
  const externalId = String(request.body?.externalId || "").slice(0, 200);
  if (!id || !externalId) return reply.code(400).send("Nieprawidłowe dane wykluczenia");
  if (!store.addExclusion(id, externalId)) return reply.code(404).send("Pozycja nie istnieje w tym monitorze");
  return reply.redirect("/");
});

app.post<{ Params: { id: string }; Body: { name?: string } }>("/monitors/:id/rename", async (request, reply) => {
  const id = parseMonitorId(request.params.id);
  const name = request.body?.name?.trim() || "";
  if (!id || !name || name.length > 100 || !store.getMonitor(id)) return reply.code(400).send("Nieprawidłowa nazwa monitora");
  store.renameMonitor(id, name);
  return reply.redirect("/");
});

app.post<{ Params: { id: string }; Body: { externalId?: string } }>("/monitors/:id/exclusions/remove", async (request, reply) => {
  const id = parseMonitorId(request.params.id);
  const externalId = String(request.body?.externalId || "").slice(0, 200);
  if (!id || !externalId) return reply.code(400).send("Nieprawidłowe dane wykluczenia");
  store.removeExclusion(id, externalId);
  return reply.redirect("/");
});

app.post<{ Params: { id: string } }>("/monitors/:id/toggle", async (request, reply) => { const id = parseMonitorId(request.params.id); if (!id) return reply.code(400).send("Nieprawidłowy identyfikator monitora"); store.toggleMonitor(id); return reply.redirect("/"); });
app.post<{ Params: { id: string } }>("/monitors/:id/delete", async (request, reply) => { const id = parseMonitorId(request.params.id); if (!id) return reply.code(400).send("Nieprawidłowy identyfikator monitora"); store.deleteMonitor(id); return reply.redirect("/"); });

const shutdown = async () => { await app.close(); store.close(); };
process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
await app.listen({ port: config.port, host: config.host });
