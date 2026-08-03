import assert from "node:assert/strict";
import test from "node:test";
import { assertAllegroUrl, validateListings } from "../src/validation.js";

test("accepts an Allegro listing URL", () => {
  assert.equal(assertAllegroUrl("https://allegro.pl/listing?string=yukio%20mishima").hostname, "allegro.pl");
});

test("rejects external and non-listing URLs", () => {
  assert.throws(() => assertAllegroUrl("https://example.com/listing"));
  assert.throws(() => assertAllegroUrl("https://allegro.pl/moje-allegro"));
});

test("validates results received from the extension", () => {
  assert.deepEqual(validateListings([{
    externalId: "1234567890", title: "Wyznanie maski",
    url: "https://allegro.pl/oferta/wyznanie-maski-yukio-mishima-1234567890",
    price: "42,00 zł", imageUrl: "https://img.example/a.jpg"
  }]), [{ externalId: "1234567890", title: "Wyznanie maski", url: "https://allegro.pl/oferta/wyznanie-maski-yukio-mishima-1234567890", price: "42,00 zł", imageUrl: "https://img.example/a.jpg" }]);
});

test("accepts a grouped Allegro product reported by the extension", () => {
  const productId = "25a97dc8-fdcd-41fd-b9de-7a7247d83e95";
  const [listing] = validateListings([{
    externalId: `product:${productId}`,
    title: "Słońce i stal Yukio Mishima",
    url: `https://allegro.pl/produkt/slonce-i-stal-yukio-mishima-${productId}`
  }]);
  assert.ok(listing);
  assert.equal(listing.externalId, `product:${productId}`);
  assert.equal(listing.title, "Słońce i stal Yukio Mishima");
});
