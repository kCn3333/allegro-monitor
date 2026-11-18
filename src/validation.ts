import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { Listing } from "./types.js";

export function validateImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.hostname !== "allegroimg.com" && !url.hostname.endsWith(".allegroimg.com"))
    )
      return null;
    const normalized = url.toString();
    return normalized.length <= 2000 ? normalized : null;
  } catch {
    return null;
  }
}

function isHttpsAllegroUrl(url: URL): boolean {
  return url.protocol === "https:" && /(^|\.)allegro\.pl$/i.test(url.hostname);
}

export function assertAllegroUrl(raw: string): URL {
  const url = new URL(raw);
  if (!isHttpsAllegroUrl(url)) {
    throw new Error("Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl");
  }
  const isSearchPath = url.pathname === "/listing" || url.pathname.startsWith("/kategoria/");
  if (!isSearchPath || !url.searchParams.get("string"))
    throw new Error("Adres musi prowadzić do wyników wyszukiwania Allegro");
  url.hash = "";
  url.searchParams.sort();
  return url;
}

export function validateListings(input: unknown): Listing[] {
  if (!Array.isArray(input) || input.length > 200) throw new Error("Nieprawidłowa lista ofert");
  return input.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Nieprawidłowa oferta");
    const value = item as Record<string, unknown>;
    const externalId = String(value.externalId || "").slice(0, 200);
    const title = String(value.title || "")
      .trim()
      .slice(0, 500);
    const rawUrl = String(value.url || "");
    const url = new URL(rawUrl);
    if (!externalId || !title || !isHttpsAllegroUrl(url)) throw new Error("Nieprawidłowe dane oferty");
    return {
      externalId,
      title,
      url: url.toString(),
      price: value.price == null ? null : String(value.price).slice(0, 100),
      imageUrl: validateImageUrl(value.imageUrl),
    };
  });
}

export function jsonInputErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY")
    return reply.code(400).send({ error: "Nieprawidłowy JSON" });
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({ error: "Zbyt duże żądanie" });
  return reply.send(error);
}
