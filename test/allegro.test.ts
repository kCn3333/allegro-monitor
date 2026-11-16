import assert from "node:assert/strict";
import test from "node:test";
import { assertAllegroUrl, validateListings } from "../src/validation.js";

test("accepts an Allegro listing URL", () => {
  assert.equal(assertAllegroUrl("https://allegro.pl/listing?string=yukio%20mishima").hostname, "allegro.pl");
});

test("accepts an Allegro category search URL", () => {
  const url = assertAllegroUrl("https://allegro.pl/kategoria/ksiazki-7?order=n&string=yukio%20mishima");
  assert.equal(url.pathname, "/kategoria/ksiazki-7");
  assert.equal(url.searchParams.get("string"), "yukio mishima");
});

test("rejects external and non-listing URLs", () => {
  assert.throws(() => assertAllegroUrl("https://example.com/listing"));
  assert.throws(() => assertAllegroUrl("https://allegro.pl/moje-allegro"));
  assert.throws(() => assertAllegroUrl("https://allegro.pl/listing"));
});

test("validates results received from the extension", () => {
  assert.deepEqual(
    validateListings([
      {
        externalId: "1234567890",
        title: "Wyznanie maski",
        url: "https://allegro.pl/oferta/wyznanie-maski-yukio-mishima-1234567890",
        price: "42,00 zł",
        imageUrl: "https://a.allegroimg.com/a.jpg",
      },
    ]),
    [
      {
        externalId: "1234567890",
        title: "Wyznanie maski",
        url: "https://allegro.pl/oferta/wyznanie-maski-yukio-mishima-1234567890",
        price: "42,00 zł",
        imageUrl: "https://a.allegroimg.com/a.jpg",
      },
    ],
  );
});

test("accepts a grouped Allegro product reported by the extension", () => {
  const productId = "25a97dc8-fdcd-41fd-b9de-7a7247d83e95";
  const [listing] = validateListings([
    {
      externalId: `product:${productId}`,
      title: "Słońce i stal Yukio Mishima",
      url: `https://allegro.pl/produkt/slonce-i-stal-yukio-mishima-${productId}`,
    },
  ]);
  assert.ok(listing);
  assert.equal(listing.externalId, `product:${productId}`);
  assert.equal(listing.title, "Słońce i stal Yukio Mishima");
});

const validateOffer = (url: string) => validateListings([{ externalId: "offer:123456", title: "Book", url }])[0]!;

test("both URL validators preserve HTTPS Allegro host, port and userinfo policy", () => {
  const accepted = [
    "https://allegro.pl",
    "https://www.allegro.pl",
    "https://a.b.allegro.pl",
    "HTTPS://WWW.ALLEGRO.PL",
    "https://allegro.pl:443",
    "https://a.allegro.pl:8443",
    "https://reader:password@allegro.pl",
    "https://user@ALLEGRO.PL:8443",
    "https://:password@allegro.pl",
    "https://allegro.pl@a.allegro.pl",
  ];
  for (const origin of accepted) {
    const search = `${origin}/listing?string=books`;
    const offer = `${origin}/oferta/book-123456`;
    assert.equal(assertAllegroUrl(search).toString(), new URL(search).toString(), origin);
    assert.equal(validateOffer(offer).url, new URL(offer).toString(), origin);
  }
  const rejected = [
    "https://notallegro.pl",
    "https://sub-allegro.pl",
    "https://allegro.pl.evil.example",
    "https://allegro.pl-evil.example",
    "https://evil.example",
    "https://allegro.pl@evil.example",
    "http://allegro.pl",
    "http://a.allegro.pl",
    "ftp://allegro.pl",
    "https://allegro.pl.",
    "https://a.allegro.pl.",
  ];
  for (const origin of rejected) {
    assert.throws(
      () => assertAllegroUrl(`${origin}/listing?string=books`),
      { message: "Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl" },
      origin,
    );
    assert.throws(
      () => validateOffer(`${origin}/oferta/book-123456`),
      { message: "Nieprawidłowe dane oferty" },
      origin,
    );
  }
});

test("both URL validators retain native errors for malformed URLs", () => {
  for (const raw of [
    "",
    "not a URL",
    "/listing?string=books",
    "https://",
    "https://[invalid]/listing?string=books",
    "https://allegro.pl:invalid/listing?string=books",
  ]) {
    const error = { name: "TypeError", code: "ERR_INVALID_URL" };
    assert.throws(() => assertAllegroUrl(raw), error, raw);
    assert.throws(() => validateOffer(raw), error, raw);
  }
});

test("only search URL validation requires a search path and a nonempty string parameter", () => {
  for (const path of [
    "/",
    "/oferta/book-123456",
    "/produkt/book",
    "/listing",
    "/listing?string=",
    "/moje-allegro?string=books",
  ]) {
    const raw = `https://allegro.pl${path}`;
    assert.equal(validateOffer(raw).url, raw);
    assert.throws(
      () => assertAllegroUrl(raw),
      { message: "Adres musi prowadzić do wyników wyszukiwania Allegro" },
      raw,
    );
  }
});

test("search and listing URL normalization retain their distinct query and fragment handling", () => {
  const raw = "HTTPS://User:Pass@WWW.ALLEGRO.PL:443/listing?z=2&string=rare%20books&a=1#fragment";
  const search = assertAllegroUrl(raw);
  assert.equal(search.toString(), "https://User:Pass@www.allegro.pl/listing?a=1&string=rare+books&z=2");
  assert.equal(search.searchParams.get("string"), "rare books");
  assert.equal(validateOffer(raw).url, "https://User:Pass@www.allegro.pl/listing?z=2&string=rare%20books&a=1#fragment");
});

test("validation errors retain their existing precedence", () => {
  assert.throws(() => assertAllegroUrl("http://evil.example/not-search"), {
    message: "Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl",
  });
  assert.throws(() => validateListings([{ externalId: "", title: "", url: "invalid URL" }]), {
    name: "TypeError",
    code: "ERR_INVALID_URL",
  });
  assert.throws(() => validateListings([{ externalId: "", title: "", url: "https://allegro.pl/" }]), {
    message: "Nieprawidłowe dane oferty",
  });
});
