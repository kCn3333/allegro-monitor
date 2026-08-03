import assert from "node:assert/strict";
import test from "node:test";
import { assertAllegroUrl, parseListings } from "../src/allegro.js";

test("accepts an Allegro listing URL", () => {
  assert.equal(assertAllegroUrl("https://allegro.pl/listing?string=yukio%20mishima").hostname, "allegro.pl");
});

test("rejects external and non-listing URLs", () => {
  assert.throws(() => assertAllegroUrl("https://example.com/listing"));
  assert.throws(() => assertAllegroUrl("https://allegro.pl/moje-allegro"));
});

test("extracts and deduplicates offers", () => {
  const html = `<article><a href="/oferta/wyznanie-maski-yukio-mishima-1234567890" title="Wyznanie maski">książka</a><span>42,00 zł</span><img src="https://img.example/a.jpg"></article>
    <a href="https://allegro.pl/oferta/duplikat-1234567890">duplikat</a>`;
  assert.deepEqual(parseListings(html), [{
    externalId: "1234567890", title: "Wyznanie maski",
    url: "https://allegro.pl/oferta/wyznanie-maski-yukio-mishima-1234567890",
    price: "42,00 zł", imageUrl: "https://img.example/a.jpg"
  }]);
});
