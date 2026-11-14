import assert from "node:assert/strict";
import test from "node:test";
import { renderFaq } from "../src/faq.js";

test("FAQ documents the operational and security limits", () => {
  const html = renderFaq();
  assert.match(html, /20 błędnych prób logowania/);
  assert.match(html, /12 prób w ciągu 15 minut/);
  assert.match(html, /potwierdza jej stan co minutę/);
  assert.match(html, /Co oznacza \+N\?/);
  assert.match(html, /dokładne wykluczenia/i);
  const disclosure = html.match(/<summary>Jakie dane są przekazywane przez rozszerzenie\?<\/summary><p>(.*?)<\/p>/)?.[1];
  assert.ok(disclosure);
  assert.match(disclosure, /wersję rozszerzenia, system i architekturę/);
  assert.match(disclosure, /dane o wersji systemu i przeglądarki/);
  assert.match(disclosure, /czas ostatniego kontaktu.*na stronie „Urządzenia”/);
  assert.doesNotMatch(disclosure, /\bIP\b/);
  assert.doesNotMatch(html, /SQLite|Portainer|Cloudflare|TELEGRAM_CHAT_IDS/);
});
