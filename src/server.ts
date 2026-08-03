import crypto from "node:crypto";
import fs from "node:fs";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "./config.js";
import { Store } from "./database.js";
import { notifyTelegram } from "./notifications.js";
import { renderPage } from "./ui.js";
import { assertAllegroUrl, validateListings } from "./validation.js";

const app = Fastify({ logger: true, bodyLimit: 256_000 });
const store = new Store(config.databasePath);
const pairingCodes = new Map<string, number>();

await app.register(formbody);

function validBasic(request: FastifyRequest): boolean {
  if (!config.username || !config.password) return true;
  const expected = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const actual = request.headers.authorization || "";
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function tokenHash(token: string): string { return crypto.createHash("sha256").update(token).digest("hex"); }
function extensionAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || "";
  if (!token || !store.touchExtensionClient(tokenHash(token))) { void reply.code(401).send({ error: "Nieprawidłowy token rozszerzenia" }); return false; }
  return true;
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health" || request.url === "/api/extension/pair" || request.url.startsWith("/api/extension/monitors")) return;
  if (!validBasic(request)) return reply.header("WWW-Authenticate", 'Basic realm="Allegro Monitor"').code(401).send("Logowanie wymagane");
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderPage(store.listMonitors(), store.recentListings())));

app.get("/extension", async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rozszerzenie Allegro Monitor</title><style>:root{font-family:system-ui;color-scheme:light dark}body{max-width:720px;margin:50px auto;padding:0 20px;line-height:1.55}main{padding:28px;border:1px solid #8885;border-radius:16px}h1{margin-top:0}button,a.button{display:inline-block;background:#ff5a00;color:#fff;border:0;border-radius:9px;padding:11px 16px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}code{background:#8882;padding:3px 6px;border-radius:5px}#code{font-size:28px;font-weight:800;letter-spacing:.08em;margin:20px 0}.muted{opacity:.7}li{margin:7px 0}</style></head><body><main><h1>Rozszerzenie dla Vivaldi</h1><p>Pobierz prototyp, zainstaluj go ręcznie, a następnie sparuj jednorazowym kodem.</p><p><a class="button" href="/extension/download">Pobierz rozszerzenie ZIP</a></p><ol><li>Rozpakuj ZIP w stałym katalogu.</li><li>Otwórz <code>vivaldi://extensions</code>.</li><li>Włącz Tryb dewelopera i kliknij „Załaduj rozpakowane”.</li><li>Wskaż rozpakowany katalog.</li><li>Wygeneruj kod poniżej i wpisz go w popupie rozszerzenia.</li></ol><button id="generate">Wygeneruj kod parowania</button><div id="code"></div><p class="muted">Kod jest jednorazowy i ważny przez 10 minut.</p><p><a href="/">← Wróć do panelu</a></p></main><script>document.querySelector('#generate').onclick=async()=>{const r=await fetch('/api/extension/pairing-code',{method:'POST'});const d=await r.json();document.querySelector('#code').textContent=d.code||d.error}</script></body></html>`));

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
  const code = request.body?.code?.trim().toUpperCase() || "";
  const expires = pairingCodes.get(code);
  if (!expires || expires < Date.now()) { pairingCodes.delete(code); return reply.code(400).send("Kod jest nieprawidłowy lub wygasł"); }
  pairingCodes.delete(code);
  const token = crypto.randomBytes(32).toString("base64url");
  store.addExtensionClient(request.body?.name || "Vivaldi", tokenHash(token));
  return reply.send({ token });
});

app.post<{ Body: { name?: string; url?: string; intervalMinutes?: number } }>("/api/extension/monitors", async (request, reply) => {
  if (!extensionAuth(request, reply)) return;
  const name = request.body?.name?.trim();
  const interval = Number(request.body?.intervalMinutes);
  if (!name || !Number.isInteger(interval) || interval < 5 || interval > 1440) return reply.code(400).send("Nieprawidłowe dane monitora");
  let url: URL; try { url = assertAllegroUrl(request.body?.url || ""); } catch (error) { return reply.code(400).send(error instanceof Error ? error.message : "Nieprawidłowy URL"); }
  const existing = store.findMonitorByUrl(url.toString());
  if (existing) return reply.send({ id: existing.id, name: existing.name, url: existing.url, intervalMinutes: existing.intervalMinutes });
  const id = store.createMonitor(name, url.toString(), interval);
  return reply.send({ id, name, url: url.toString(), intervalMinutes: interval });
});

app.post<{ Params: { id: string }; Body: { listings?: unknown } }>("/api/extension/monitors/:id/results", async (request, reply) => {
  if (!extensionAuth(request, reply)) return;
  const monitor = store.getMonitor(Number(request.params.id));
  if (!monitor || !monitor.enabled) return reply.code(404).send("Monitor nie istnieje lub jest wyłączony");
  let listings; try { listings = validateListings(request.body?.listings); } catch (error) { return reply.code(400).send(error instanceof Error ? error.message : "Nieprawidłowe wyniki"); }
  const fresh = store.saveCheck(monitor, listings);
  for (const listing of fresh) await notifyTelegram(config.telegramBotToken, config.telegramChatId, monitor.name, listing);
  return reply.send({ accepted: listings.length, newListings: fresh });
});

app.post<{ Params: { id: string }; Body: { message?: string } }>("/api/extension/monitors/:id/error", async (request, reply) => {
  if (!extensionAuth(request, reply)) return;
  const monitor = store.getMonitor(Number(request.params.id));
  if (!monitor) return reply.code(404).send("Monitor nie istnieje");
  store.saveError(monitor, new Error(String(request.body?.message || "Nieznany błąd rozszerzenia").slice(0, 1000)));
  return reply.send({ saved: true });
});

app.delete<{ Params: { id: string } }>("/api/extension/monitors/:id", async (request, reply) => {
  if (!extensionAuth(request, reply)) return;
  store.deleteMonitor(Number(request.params.id));
  return reply.send({ deleted: true });
});

app.post<{ Body: { name?: string; url?: string; intervalMinutes?: string } }>("/monitors", async (request, reply) => {
  const name = request.body?.name?.trim(); const interval = Number(request.body?.intervalMinutes);
  if (!name || !Number.isInteger(interval) || interval < 5 || interval > 1440) return reply.code(400).send("Nieprawidłowe dane");
  let url: URL; try { url = assertAllegroUrl(request.body?.url || ""); } catch (error) { return reply.code(400).send(error instanceof Error ? error.message : "Nieprawidłowy URL"); }
  store.createMonitor(name, url.toString(), interval); return reply.redirect("/");
});
app.post<{ Params: { id: string } }>("/monitors/:id/toggle", async (request, reply) => { store.toggleMonitor(Number(request.params.id)); return reply.redirect("/"); });
app.post<{ Params: { id: string } }>("/monitors/:id/delete", async (request, reply) => { store.deleteMonitor(Number(request.params.id)); return reply.redirect("/"); });

const shutdown = async () => { await app.close(); store.close(); };
process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
await app.listen({ port: config.port, host: config.host });
