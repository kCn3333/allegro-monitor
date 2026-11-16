import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";

interface PageResult {
  blocked: boolean;
  empty?: boolean;
  listings: Array<{ externalId: string; title: string }>;
}

// Serialize only the injected function: no imports, worker globals or surrounding helpers.
const source = ts.createSourceFile(
  "service-worker.js",
  fs.readFileSync("extension/service-worker.js", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const declaration = source.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "processListings",
);
assert.ok(declaration);
const injected = vm.runInNewContext(`(${declaration.getText(source)})`) as (options: {
  operation: "extract" | "mark";
  ids?: string[];
}) => PageResult | undefined;

const cases: Array<{ path: string; id: string | null }> = [
  { path: "/oferta/book-123456?offerId=987654", id: "offer:987654" },
  { path: "/oferta/book?offerId=not-numeric", id: "offer:not-numeric" },
  { path: "/oferta/book?offerId=0", id: "offer:0" },
  { path: "/oferta/book?offerId=first&offerId=second", id: "offer:first" },
  { path: "/oferta/book?offerId=%20", id: "offer: " },
  { path: "/oferta/book-123456?offerId=", id: "offer:123456" },
  { path: "/oferta/book-234567", id: "offer:234567" },
  { path: "/oferta/345678", id: "offer:345678" },
  { path: "/oferta/book-234567/", id: "offer:234567" },
  { path: "/oferta/345678/", id: "offer:345678" },
  { path: "/oferta/book-000001", id: "offer:000001" },
  { path: "/produkt/book-25A97DC8-FDCD-41FD-B9DE-7A7247D83E95", id: "product:25a97dc8-fdcd-41fd-b9de-7a7247d83e95" },
  { path: "/produkt/book-25A97DC8-FDCD-41FD-B9DE-7A7247D83E95/", id: "product:25a97dc8-fdcd-41fd-b9de-7a7247d83e95" },
  { path: "/produkt/book-25A97DC8-FDCD-41FD-B9DE-7A7247D83E95?offerId=456789", id: "offer:456789" },
  { path: "/produkt/book-AAAAAAAA-BBBB-CCCC-DDDD-123456789012", id: "offer:123456789012" },
  { path: "/oferta/no-id", id: null },
  { path: "/oferta/book-12345", id: null },
  { path: "/oferta/book-123456//", id: null },
  { path: "/produkt/25A97DC8-FDCD-41FD-B9DE-7A7247D83E95", id: null },
];

test("serialized injected operations share exact listing identity rules without worker globals", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    `<title>Books</title>${cases
      .map(
        (item, index) =>
          `<article id="case-${index}"><h2>Book ${index}</h2><a href="https://allegro.pl${item.path}" title="Book ${index}">Read</a><span>10 zł</span></article>`,
      )
      .join("")}`,
  );
  const result = await page.evaluate(injected, { operation: "extract" as const });
  assert.ok(result);
  const expected = [...new Set(cases.map((item) => item.id).filter((id): id is string => id !== null))];
  assert.equal(result.blocked, false);
  assert.equal(result.empty, false);
  assert.deepEqual(
    result.listings.map((listing) => listing.externalId),
    expected,
  );
  for (const listing of result.listings) {
    const index = cases.findIndex((item) => item.id === listing.externalId);
    assert.equal(listing.title, `Book ${index}`, "deduplication retains the first matching offer");
  }
  // All cases, including duplicate links and missing IDs, go through the same serialized function.
  assert.equal(await page.evaluate(injected, { operation: "mark" as const, ids: expected }), undefined);
  for (const [index, item] of cases.entries()) {
    assert.equal(
      await page.locator(`#case-${index}`).evaluate((element) => (element as HTMLElement).style.outlineWidth),
      item.id === null ? "" : "3px",
      item.path,
    );
    assert.equal(
      await page.locator(`#case-${index}`).evaluate((element) => (element as HTMLElement).style.outlineOffset),
      item.id === null ? "" : "3px",
      item.path,
    );
  }
  assert.equal(await page.title(), `[+${expected.length}] Books`);
  await page.evaluate(injected, { operation: "mark" as const, ids: expected });
  assert.equal(await page.title(), `[+${expected.length}] Books`, "the existing prefix is not duplicated");
});

test("serialized operations preserve recommendations, domain filtering, blocking, empty results and selective marking", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const offer = (id: string, host = "allegro.pl") =>
    `<article id="offer-${id}"><a href="https://${host}/oferta/book-${id}" title="Book ${id}">Book ${id}</a></article>`;
  await page.setContent(
    `<title>Books</title>${offer("123456")}${offer("123456")}${offer("234567")}${offer("345678", "evil.example")}<h2>Rekomendacje dla ciebie</h2>${offer("456789")}`,
  );
  const result = await page.evaluate(injected, { operation: "extract" as const });
  assert.ok(result);
  assert.deepEqual(
    result.listings.map((listing) => listing.externalId),
    ["offer:123456", "offer:234567"],
  );
  await page.evaluate(injected, { operation: "mark" as const, ids: ["offer:123456"] });
  assert.deepEqual(
    await page.locator("article").evaluateAll((elements) => elements.map((element) => element.style.outlineWidth)),
    ["3px", "3px", "", "", ""],
  );
  // Marking deliberately retains its original selectors, without extraction-only filters.
  await page.evaluate(injected, { operation: "mark" as const, ids: ["offer:345678", "offer:456789"] });
  assert.equal(await page.locator("#offer-345678").evaluate((element) => element.style.outlineWidth), "3px");
  assert.equal(await page.locator("#offer-456789").evaluate((element) => element.style.outlineWidth), "3px");
  await page.setContent(`<title>Books</title><h2>Znaleźliśmy podobne oferty</h2>${offer("123456")}`);
  const recommendations = await page.evaluate(injected, { operation: "extract" as const });
  assert.ok(recommendations);
  assert.equal(recommendations.empty, true);
  assert.deepEqual(recommendations.listings, []);
  await page.setContent("<title>Books</title><p>Nie znaleźliśmy żadnych wyników</p>");
  const empty = await page.evaluate(injected, { operation: "extract" as const });
  assert.ok(empty);
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.listings, []);
  await page.setContent(`<title>Books</title><p>captcha</p>${offer("123456")}`);
  assert.deepEqual(await page.evaluate(injected, { operation: "extract" as const }), { blocked: true, listings: [] });
  await page.evaluate(injected, { operation: "mark" as const, ids: ["offer:123456"] });
  assert.equal(await page.locator("article").evaluate((element) => element.style.outlineWidth), "3px");
  assert.equal(await page.title(), "[+1] Books");
  await page.setContent(`<title>Books</title>${offer("123456")}`);
  await page.evaluate(injected, { operation: "mark" as const, ids: [] });
  assert.equal(await page.title(), "Books");
  assert.equal(await page.locator("article").evaluate((element) => element.style.outlineWidth), "");
});
