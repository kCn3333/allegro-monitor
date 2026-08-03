import { load } from "cheerio";
import { chromium, type Browser } from "playwright";
import type { Listing } from "./types.js";

const OFFER_ID = /(?:oferta\/[^/?#]*-|offerId=)(\d{6,})/i;

export function assertAllegroUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !/(^|\.)allegro\.pl$/i.test(url.hostname)) {
    throw new Error("Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl");
  }
  if (!url.pathname.startsWith("/listing")) throw new Error("Adres musi prowadzić do wyszukiwania Allegro (/listing)");
  return url;
}

export function parseListings(html: string): Listing[] {
  const $ = load(html);
  const found = new Map<string, Listing>();
  $('a[href*="/oferta/"]').each((_index, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) return;
    const match = href.match(OFFER_ID);
    if (!match?.[1] || found.has(match[1])) return;
    const container = anchor.closest("article").length ? anchor.closest("article") : anchor.parent();
    const title = (anchor.attr("title") || anchor.text()).replace(/\s+/g, " ").trim();
    if (!title) return;
    const text = container.text().replace(/\s+/g, " ");
    const price = text.match(/\d[\d\s]*(?:[,.]\d{2})?\s*zł/i)?.[0]?.trim() || null;
    const imageUrl = container.find("img").first().attr("src") || container.find("img").first().attr("data-src") || null;
    found.set(match[1], {
      externalId: match[1], title,
      url: new URL(href, "https://allegro.pl").toString(), price, imageUrl
    });
  });
  return [...found.values()];
}

export class AllegroClient {
  private browser: Browser | null = null;

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
  }

  async fetch(url: string): Promise<Listing[]> {
    if (!this.browser) throw new Error("Przeglądarka nie została uruchomiona");
    assertAllegroUrl(url);
    const context = await this.browser.newContext({
      locale: "pl-PL",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/127 Safari/537.36"
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if (!response || response.status() >= 400) throw new Error(`Allegro odpowiedziało kodem ${response?.status() ?? "brak"}`);
      await page.waitForTimeout(2500);
      const html = await page.content();
      if (/captcha-delivery|please enable js|verify you are human/i.test(html)) {
        throw new Error("Allegro zażądało weryfikacji captcha");
      }
      const listings = parseListings(html);
      if (listings.length === 0) throw new Error("Nie znaleziono ofert; struktura strony mogła się zmienić");
      return listings;
    } finally {
      await context.close();
    }
  }

  async stop(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
