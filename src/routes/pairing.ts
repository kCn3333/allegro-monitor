import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Store } from "../database.js";
import { tokenHash } from "../security.js";

interface PairingRouteDependencies {
  store: Store;
  now: () => number;
  pairingCodes: Map<string, number>;
  attempts: Map<string, { count: number; resetAt: number }>;
  allowAttempt: (key: string, maximum: number, windowMs: number) => boolean;
  prunePairingCodes: (time: number) => void;
}

export function registerPairingRoutes(
  app: FastifyInstance,
  { store, now, pairingCodes, attempts, allowAttempt, prunePairingCodes }: PairingRouteDependencies,
): void {
  app.post("/api/extension/pairing-code", async (_request, reply) => {
    const time = now();
    prunePairingCodes(time);
    if (pairingCodes.size >= 100) {
      const retryAfter = Math.max(1, Math.ceil((Math.min(...pairingCodes.values()) - time) / 1000));
      return reply.code(429).header("Retry-After", retryAfter).send("Zbyt wiele aktywnych kodów parowania");
    }
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code: string;
    do {
      const raw = Array.from(crypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("");
      code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    } while (pairingCodes.has(code));
    pairingCodes.set(code, time + 10 * 60_000);
    return reply.send({ code, expiresInSeconds: 600 });
  });

  app.post<{ Body: unknown }>("/api/extension/pair", async (request, reply) => {
    const time = now();
    prunePairingCodes(time);
    if (!allowAttempt(`pair:${request.ip}`, 12, 15 * 60_000)) return reply.code(429).send("Zbyt wiele prób parowania");
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      return reply.code(400).send("Nieprawidłowe dane parowania");
    const { code: rawCode, name } = body as Record<string, unknown>;
    if (typeof rawCode !== "string" || (name !== undefined && typeof name !== "string")) {
      return reply.code(400).send("Nieprawidłowe dane parowania");
    }
    const code = rawCode.trim().toUpperCase();
    const expires = pairingCodes.get(code);
    if (expires === undefined || expires <= time) return reply.code(400).send("Kod jest nieprawidłowy lub wygasł");
    pairingCodes.delete(code);
    attempts.delete(`pair:${request.ip}`);
    const token = crypto.randomBytes(32).toString("base64url");
    const clientId = store.addExtensionClient(name || "Vivaldi", tokenHash(token));
    store.linkClientToAllMonitors(clientId);
    return reply.send({ token });
  });
}
