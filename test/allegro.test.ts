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
