import assert from "node:assert/strict";
import test from "node:test";
import { deliverTelegram } from "../src/notifications.js";

const listing = {
  externalId: "offer:123",
  title: "Wyznanie maski – Yukio Mishima",
  url: "https://allegro.pl/oferta/wyznanie-maski-123",
  price: "42,90 zł",
  imageUrl: "https://a.allegroimg.com/original/example.jpg"
};

test("sends an offer as a photo card with a link button", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    await deliverTelegram("secret", "123", "Mishima", listing);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/sendPhoto$/);
    assert.equal(calls[0]!.body.photo, listing.imageUrl);
    assert.match(String(calls[0]!.body.caption), /Wyznanie maski/);
    assert.deepEqual(calls[0]!.body.reply_markup, {
      inline_keyboard: [[{ text: "Otwórz ofertę ↗", url: listing.url }]]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to a text card when Telegram rejects the image", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    calls.push(String(input));
    return new Response("{}", { status: calls.length === 1 ? 400 : 200 });
  }) as typeof fetch;
  try {
    await deliverTelegram("secret", "123", "Mishima", listing);
    assert.match(calls[0]!, /\/sendPhoto$/);
    assert.match(calls[1]!, /\/sendMessage$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
