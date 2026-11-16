import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Store } from "../database.js";
import {
  expiredSessionCookie,
  safeCredentialsEqual,
  sessionCookie,
  sessionTokenFromCookie,
  tokenHash,
} from "../security.js";
import { renderLogin } from "../ui.js";

interface AuthRouteDependencies {
  settings: { username: string; password: string };
  store: Store;
  now: () => number;
  secureCookies: boolean;
  webCredentialFingerprint: string;
  attempts: Map<string, { count: number; resetAt: number }>;
  allowAttempt: (key: string, maximum: number, windowMs: number) => boolean;
  pruneAttempts: () => void;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  {
    settings,
    store,
    now,
    secureCookies,
    webCredentialFingerprint,
    attempts,
    allowAttempt,
    pruneAttempts,
  }: AuthRouteDependencies,
): void {
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
      const resetAt = attempt?.resetAt ?? Math.min(...[...attempts.values()].map((entry) => entry.resetAt));
      return reply
        .code(429)
        .header("Retry-After", Math.max(1, Math.ceil((resetAt - now()) / 1000)))
        .type("text/html; charset=utf-8")
        .send(renderLogin(true));
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
}
