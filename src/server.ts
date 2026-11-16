import fs from "node:fs";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "./config.js";
import { publicAssets } from "./branding.js";
import { buildExtensionPackage } from "./extension-package.js";
import { Store } from "./database.js";
import { TelegramWorker } from "./notifications.js";
import {
  credentialFingerprint,
  isSameOriginRequest,
  sessionCookie,
  sessionTokenFromCookie,
  tokenHash,
} from "./security.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPanelRoutes } from "./routes/panel.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerExtensionPageRoutes } from "./routes/extension-page.js";
import { registerPairingRoutes } from "./routes/pairing.js";
import { registerPresenceRoutes } from "./routes/presence.js";
import { registerExtensionMonitorRoutes } from "./routes/extension-monitors.js";

export async function buildApp(options: { now?: () => number; startWorker?: boolean; config?: typeof config } = {}) {
  const settings = options.config || config;
  const now = options.now || Date.now;
  if (
    process.env.NODE_ENV === "production" &&
    (!settings.username || !settings.password || settings.sessionSecret.length < 32)
  ) {
    throw new Error(
      "APP_USERNAME, APP_PASSWORD i APP_SESSION_SECRET (minimum 32 znaki) są wymagane w środowisku produkcyjnym",
    );
  }

  if (process.env.NODE_ENV === "production" && !settings.publicUrl)
    throw new Error("APP_PUBLIC_URL jest wymagane w środowisku produkcyjnym");
  const extensionPackage = settings.publicUrl
    ? await buildExtensionPackage(settings.publicUrl, settings.extensionDirectory)
    : null;

  const app = Fastify({ logger: true, bodyLimit: 256_000, trustProxy: settings.trustProxy });
  const store = new Store(settings.databasePath, settings.listingRetentionChecks, now);
  const pairingCodes = new Map<string, number>();
  const worker = new TelegramWorker(store, settings.telegramBotToken, undefined, now);
  if (options.startWorker !== false) worker.start();
  app.addHook("onClose", async () => {
    await worker.stop();
    store.close();
  });
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const allowedIntervals = new Set([1, 5, 15, 30, 60]);
  const latestExtensionVersion = (() => {
    try {
      return String(JSON.parse(fs.readFileSync(`${settings.extensionDirectory}/manifest.json`, "utf8")).version || "");
    } catch {
      return "";
    }
  })();

  await app.register(formbody);

  const secureCookies = process.env.NODE_ENV === "production";
  const webCredentialFingerprint = credentialFingerprint(
    settings.username,
    settings.password,
    settings.sessionSecret || "development-session-secret",
  );

  function extensionClientId(request: FastifyRequest, reply: FastifyReply): number | null {
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || "";
    const clientId = token && token.length <= 128 ? store.touchExtensionClient(tokenHash(token)) : null;
    if (!clientId) {
      void reply.code(401).send({ error: "Nieprawidłowy token rozszerzenia" });
      return null;
    }
    return clientId;
  }

  function allowAttempt(key: string, maximum: number, windowMs: number): boolean {
    const time = now();
    pruneAttempts();
    const current = attempts.get(key);
    if (!current) {
      if (attempts.size >= 10000) return false;
      attempts.set(key, { count: 1, resetAt: time + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= maximum;
  }

  function pruneAttempts() {
    for (const [key, entry] of attempts) if (entry.resetAt <= now()) attempts.delete(key);
  }

  function prunePairingCodes(time: number) {
    for (const [code, expiresAt] of pairingCodes) if (expiresAt <= time) pairingCodes.delete(code);
  }

  function parseMonitorId(value: string): number | null {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    const path = request.url.split("?", 1)[0];
    if ((request.method === "GET" || request.method === "HEAD") && publicAssets.has(path || "")) return;
    if (
      path === "/health" ||
      path === "/api/extension/pair" ||
      path === "/api/extension/presence" ||
      path === "/api/extension/notifications/ack" ||
      path?.startsWith("/api/extension/monitors")
    )
      return;
    if (path === "/login") {
      if (request.method === "POST" && !isSameOriginRequest(request.headers))
        return reply.code(403).send("Żądanie cross-site zostało odrzucone");
      return;
    }
    if (!settings.username || !settings.password) {
      if (path === "/devices" || path?.startsWith("/devices/"))
        return reply.code(503).send("Zarządzanie urządzeniami wymaga skonfigurowanego logowania");
      return;
    }
    const token = sessionTokenFromCookie(request.headers.cookie);
    const duration = token ? store.touchWebSession(tokenHash(token), webCredentialFingerprint) : null;
    if (!duration) return reply.redirect("/login");
    if (path !== "/logout") reply.header("Set-Cookie", sessionCookie(token!, duration > 24 * 60 * 60, secureCookies));
    if (request.method === "POST" && !isSameOriginRequest(request.headers))
      return reply.code(403).send("Żądanie cross-site zostało odrzucone");
  });

  app.get("/health", async () => ({ status: "ok" }));
  for (const [url, asset] of publicAssets) {
    app.get(url, async (_request, reply) => reply.type(asset.type).send(asset.body));
  }
  registerAuthRoutes(app, {
    settings,
    store,
    now,
    secureCookies,
    webCredentialFingerprint,
    attempts,
    allowAttempt,
    pruneAttempts,
  });
  registerPanelRoutes(app, { store, parseMonitorId });
  registerDeviceRoutes(app, { store, parseMonitorId, clearPairingCodes: () => pairingCodes.clear() });

  registerExtensionPageRoutes(app, { latestExtensionVersion, extensionPackage });

  registerPairingRoutes(app, { store, now, pairingCodes, attempts, allowAttempt, prunePairingCodes });

  registerExtensionMonitorRoutes(app, { store, extensionClientId, parseMonitorId, allowedIntervals, settings });

  registerPresenceRoutes(app, { store, extensionClientId, latestExtensionVersion });

  return app;
}
