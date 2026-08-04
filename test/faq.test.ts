import assert from "node:assert/strict";
import test from "node:test";
import { renderFaq } from "../src/faq.js";

test("FAQ documents the operational and security limits", () => {
  const html = renderFaq();
  assert.match(html, /20 błędnych prób Basic Auth/);
  assert.match(html, /12 prób w ciągu 15 minut/);
  assert.match(html, /heartbeat co minutę/);
  assert.match(html, /Co oznacza \+N\?/);
  assert.match(html, /dokładne wykluczenia/i);
});
