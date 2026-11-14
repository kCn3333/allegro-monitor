import assert from "node:assert/strict";
import test from "node:test";
import { deliverTelegram, TelegramError } from "../src/notifications.js";

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

test("photo fallback uses explicit status regardless of the error message", async () => {
  for (const status of [400, 408, 429, 500, 503, undefined]) {
    const error = new TelegramError(status === 400 ? "Inny opis błędu zdjęcia" : "Telegram HTTP 400", false, 0, status);
    const calls: string[] = [];
    const fetcher = (async input => {
      calls.push(String(input));
      if (calls.length === 1) throw error;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const delivery = deliverTelegram("secret", "123", "Mishima", listing, fetcher);
    if (status === 400) {
      await delivery;
      assert.equal(calls.length, 2);
      assert.match(calls[1]!, /\/sendMessage$/);
    } else {
      await assert.rejects(delivery, caught => caught === error);
      assert.equal(calls.length, 1, `status ${status} must not trigger a text fallback`);
    }
    assert.match(calls[0]!, /\/sendPhoto$/);
  }
});

test("Telegram error status keeps error_code precedence, HTTP fallback and classification", async () => {
  for (const [httpStatus, errorCode, expectedStatus, permanent, retryAfterMs] of [
    [500, 400, 400, true, 0],
    [400, 429, 429, false, 25000],
    [400, 408, 408, false, 0],
    [400, 503, 503, false, 0],
    [200, 403, 403, true, 0],
    [408, undefined, 408, false, 0],
    [429, 0, 429, false, 25000],
    [503, undefined, 503, false, 0]
  ] as const) {
    const fetcher = (async () => new Response(JSON.stringify({ ok: false, error_code: errorCode,
      parameters: { retry_after: 25 } }), { status: httpStatus })) as typeof fetch;
    await assert.rejects(deliverTelegram("secret", "123", "Mishima", { ...listing, imageUrl: null }, fetcher), error => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.status, expectedStatus);
      assert.equal(error.message, `Telegram HTTP ${expectedStatus}`);
      assert.equal(error.permanent, permanent);
      assert.equal(error.retryAfterMs, retryAfterMs);
      return true;
    });
  }
});

test("photo network and timeout errors never trigger fallback even with a matching message", async () => {
  for (const error of [new Error("Telegram HTTP 400"), new DOMException("Telegram HTTP 400", "TimeoutError")]) {
    let calls = 0;
    const fetcher = (async () => { calls++; throw error; }) as typeof fetch;
    await assert.rejects(deliverTelegram("secret", "123", "Mishima", listing, fetcher), caught => caught === error);
    assert.equal(calls, 1);
  }
});
