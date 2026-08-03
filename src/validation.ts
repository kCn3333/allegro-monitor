import type { Listing } from "./types.js";

export function assertAllegroUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !/(^|\.)allegro\.pl$/i.test(url.hostname)) {
    throw new Error("Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl");
  }
  if (!url.pathname.startsWith("/listing")) throw new Error("Adres musi prowadzić do wyszukiwania Allegro (/listing)");
  return url;
}

export function validateListings(input: unknown): Listing[] {
  if (!Array.isArray(input) || input.length > 200) throw new Error("Nieprawidłowa lista ofert");
  return input.map(item => {
    if (!item || typeof item !== "object") throw new Error("Nieprawidłowa oferta");
    const value = item as Record<string, unknown>;
    const externalId = String(value.externalId || "").slice(0, 200);
    const title = String(value.title || "").trim().slice(0, 500);
    const rawUrl = String(value.url || "");
    const url = new URL(rawUrl);
    if (!externalId || !title || url.protocol !== "https:" || !/(^|\.)allegro\.pl$/i.test(url.hostname)) throw new Error("Nieprawidłowe dane oferty");
    return {
      externalId, title, url: url.toString(),
      price: value.price == null ? null : String(value.price).slice(0, 100),
      imageUrl: value.imageUrl == null ? null : String(value.imageUrl).slice(0, 2000)
    };
  });
}
