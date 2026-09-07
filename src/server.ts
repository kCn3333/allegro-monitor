import crypto from "node:crypto";
import fs from "node:fs";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "./config.js";
import { Store } from "./database.js";
import { renderFaq } from "./faq.js";
import { TelegramWorker } from "./notifications.js";
import { credentialFingerprint, expiredSessionCookie, isSameOriginRequest, safeCredentialsEqual,
  sessionCookie, sessionTokenFromCookie, tokenHash } from "./security.js";
import { renderLogin, renderPage } from "./ui.js";
import { assertAllegroUrl, validateListings } from "./validation.js";

export async function buildApp(options: { now?: () => number; startWorker?: boolean; config?: typeof config } = {}) {
const settings = options.config || config;
const now = options.now || Date.now;
if (process.env.NODE_ENV === "production" && (!settings.username || !settings.password || settings.sessionSecret.length < 32)) {
  throw new Error("APP_USERNAME, APP_PASSWORD i APP_SESSION_SECRET (minimum 32 znaki) są wymagane w środowisku produkcyjnym");
}

const app = Fastify({ logger: true, bodyLimit: 256_000 });
const store = new Store(settings.databasePath, settings.listingRetentionChecks);
const pairingCodes = new Map<string, number>();
const worker = new TelegramWorker(store, settings.telegramBotToken);
if (options.startWorker !== false) worker.start();
app.addHook("onClose", async () => { await worker.stop(); store.close(); });
const attempts = new Map<string, { count: number; resetAt: number }>();
const allowedIntervals = new Set([1, 5, 15, 30, 60]);
const latestExtensionVersion = (() => {
  try { return String(JSON.parse(fs.readFileSync(settings.extensionManifestPath, "utf8")).version || ""); }
  catch { return ""; }
})();

await app.register(formbody);

const secureCookies = process.env.NODE_ENV === "production";
const webCredentialFingerprint = credentialFingerprint(settings.username, settings.password, settings.sessionSecret || "development-session-secret");

function extensionClientId(request: FastifyRequest, reply: FastifyReply): number | null {
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || "";
  const clientId = token && token.length <= 128 ? store.touchExtensionClient(tokenHash(token)) : null;
  if (!clientId) { void reply.code(401).send({ error: "Nieprawidłowy token rozszerzenia" }); return null; }
  return clientId;
}

function allowAttempt(key: string, maximum: number, windowMs: number): boolean {
  const time = now();
  pruneAttempts();
  const current = attempts.get(key);
  if (!current) { if (attempts.size >= 10000) return false; attempts.set(key, { count: 1, resetAt: time + windowMs }); return true; }
  current.count += 1;
  return current.count <= maximum;
}

function pruneAttempts() {
  for (const [key, entry] of attempts) if (entry.resetAt <= now()) attempts.delete(key);
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
  if (path === "/health" || path === "/api/extension/pair" || path === "/api/extension/presence" || path === "/api/extension/notifications/ack" || path?.startsWith("/api/extension/monitors")) return;
  if (path === "/login") {
    if (request.method === "POST" && !isSameOriginRequest(request.headers)) return reply.code(403).send("Żądanie cross-site zostało odrzucone");
    return;
  }
  if (!settings.username || !settings.password) return;
  const token = sessionTokenFromCookie(request.headers.cookie);
  const duration = token ? store.touchWebSession(tokenHash(token), webCredentialFingerprint) : null;
  if (!duration) return reply.redirect("/login");
  if (path !== "/logout") reply.header("Set-Cookie", sessionCookie(token!, duration > 24 * 60 * 60, secureCookies));
  if (request.method === "POST" && !isSameOriginRequest(request.headers)) return reply.code(403).send("Żądanie cross-site zostało odrzucone");
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/login", async (request, reply) => {
  if (!settings.username || !settings.password) return reply.redirect("/");
  const token = sessionTokenFromCookie(request.headers.cookie);
  if (token && store.touchWebSession(tokenHash(token), webCredentialFingerprint)) return reply.redirect("/");
  return reply.type("text/html; charset=utf-8").send(renderLogin());
});
app.post<{ Body: { username?: string; password?: string; remember?: string } }>("/login", async (request, reply) => {
  pruneAttempts();
  const attempt = attempts.get(`login:${request.ip}`);
  if ((attempt && attempt.count >= 20) || (!attempt && attempts.size >= 10000)) {
    const resetAt = attempt?.resetAt ?? Math.min(...[...attempts.values()].map(entry => entry.resetAt));
    return reply.code(429).header("Retry-After", Math.max(1, Math.ceil((resetAt - now()) / 1000)))
      .type("text/html; charset=utf-8").send(renderLogin(true));
  }
  const username = String(request.body?.username || "").slice(0, 100);
  const password = String(request.body?.password || "").slice(0, 500);
  if (!safeCredentialsEqual(username, password, settings.username, settings.password)) {
    allowAttempt(`login:${request.ip}`, 20, 15 * 60_000);
    return reply.code(401).type("text/html; charset=utf-8").send(renderLogin(true));
  }
  attempts.delete(`login:${request.ip}`);
  const remember = request.body?.remember === "yes";
  const duration = remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60;
  const token = crypto.randomBytes(32).toString("base64url");
  store.createWebSession(tokenHash(token), webCredentialFingerprint, duration);
  return reply.header("Set-Cookie", sessionCookie(token, remember, secureCookies)).redirect("/");
});
app.post("/logout", async (request, reply) => {
  const token = sessionTokenFromCookie(request.headers.cookie);
  if (token) store.deleteWebSession(tokenHash(token));
  return reply.header("Set-Cookie", expiredSessionCookie(secureCookies)).redirect("/login");
});
app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderPage(store.listMonitors(), store.recentListings(), store.listExclusions())));
app.get("/faq", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderFaq()));

app.get("/extension", async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rozszerzenie Allegro Monitor</title><style>:root{font-family:system-ui;color-scheme:light dark}body{max-width:720px;margin:50px auto;padding:0 20px;line-height:1.55}main{padding:28px;border:1px solid #8885;border-radius:16px}h1{margin-top:0}button,a.button{display:inline-block;background:#d8612c;color:#fff;border:0;border-radius:9px;padding:11px 16px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}code{background:#8882;padding:3px 6px;border-radius:5px}#code{font-size:28px;font-weight:800;letter-spacing:.08em;margin:20px 0}.muted{opacity:.7}li{margin:7px 0}</style></head><body><main><h1>Rozszerzenie dla Vivaldi</h1><p>Pobierz prototyp, zainstaluj go ręcznie, a następnie sparuj jednorazowym kodem.</p><p><a class="button" href="/extension/download">Pobierz rozszerzenie ZIP</a></p><ol><li>Rozpakuj ZIP w stałym katalogu.</li><li>Otwórz <code>vivaldi://extensions</code>.</li><li>Włącz Tryb dewelopera i kliknij „Załaduj rozpakowane”.</li><li>Wskaż rozpakowany katalog.</li><li>Wygeneruj kod poniżej i wpisz go w popupie rozszerzenia.</li></ol><button id="generate">Wygeneruj kod parowania</button><div id="code"></div><p class="muted">Kod jest jednorazowy i ważny przez 10 minut.</p><p><a href="/">← Wróć do panelu</a></p></main><script>document.querySelector('#generate').onclick=async()=>{const r=await fetch('/api/extension/pairing-code',{method:'POST'});const d=await r.json();document.querySelector('#code').textContent=d.code||d.error}</script></body></html>`));

app.get("/extension/download", async (_request, reply) => {
  if (!fs.existsSync(settings.extensionZipPath)) return reply.code(404).send("Paczka rozszerzenia nie została zbudowana");
  return reply.header("Content-Disposition", 'attachment; filename="allegro-monitor-extension.zip"').type("application/zip").send(fs.createReadStream(settings.extensionZipPath));
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

app.post<{ Body: { monitors?: Array<{ id?: number; open?: boolean }>; notificationProtocol?: number } }>("/api/extension/presence", async (request, reply) => {
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
  if (request.body.notificationProtocol === 2) {
    const batch = store.notificationBatch(clientId);
    return reply.send({ updated, monitors: synchronized, notifications: batch.events, notificationBatch: batch.batchId, latestExtensionVersion });
  }
  return reply.send({ updated, monitors: synchronized, notifications: store.pullNotifications(clientId), latestExtensionVersion });
});

app.post<{ Body: { batchId?: string } }>("/api/extension/notifications/ack", async (request, reply) => {
  const clientId = extensionClientId(request, reply);
  if (!clientId) return;
  const batchId = request.body?.batchId;
  if (typeof batchId !== "string" || batchId.length > 100) return reply.code(400).send({ error: "Nieprawidłowy ACK" });
  // Repeated/unknown ACK is a safe no-op; it cannot advance any cursor.
  return { acknowledged: store.acknowledgeNotifications(clientId, batchId) };
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
  const fresh = store.saveCheck(monitor, listings, settings.telegramBotToken ? settings.telegramChatIds : []);
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

return app;
}
