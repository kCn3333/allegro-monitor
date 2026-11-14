import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { config } from "../src/config.js";
import { Store } from "../src/database.js";
import { deliverTelegram, TelegramWorker } from "../src/notifications.js";
import { tokenHash } from "../src/security.js";
import { buildApp } from "../src/server.js";
import { renderPage } from "../src/ui.js";
import { validateImageUrl } from "../src/validation.js";

const valid = ["https://allegroimg.com/image.jpg", "https://a.allegroimg.com/original/image.jpg",
  "https://cdn.a.allegroimg.com/image.jpg?width=200", "https://A.ALLEGROIMG.COM/image.jpg"];
const invalid: unknown[] = [undefined, null, "", " \t ", false, true, 0, 123, [], {},
  { url: valid[0] }, "not a URL", "https://notallegroimg.com/image.jpg", "https://cdn-allegroimg.com/image.jpg",
  "https://allegroimg.com.evil.example/image.jpg", "https://evil.example/allegroimg.com/image.jpg",
  "https://evil.example/?image=https://a.allegroimg.com/image.jpg", "https://evil.example/#allegroimg.com",
  "https://allegroimg.com@evil.example/image.jpg", "https://user@allegroimg.com/image.jpg",
  "https://user:password@a.allegroimg.com/image.jpg", "https://:password@allegroimg.com/image.jpg",
  "http://a.allegroimg.com/image.jpg", "data:image/png;base64,aW1hZ2U=", "javascript:alert('allegroimg.com')"];
const listing = (id: number) => ({ externalId: `offer:${100000 + id}`, title: `Book ${id}`,
  url: `https://allegro.pl/oferta/book-${100000 + id}`, price: "10 zł", imageUrl: null as string | null });

async function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-thumbnails-"));
  const settings = { ...config, databasePath: path.join(dir, "db.sqlite"), username: "", password: "", publicUrl: "",
    telegramBotToken: "test", telegramChatIds: ["123"] };
  const store = new Store(settings.databasePath);
  const id = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  store.saveCheck(store.getMonitor(id)!, []);
  const client = store.addExtensionClient("test", tokenHash("test-token"));
  store.linkMonitorClient(id, client);
  const app = await buildApp({ config: settings, startWorker: false });
  const db = new DatabaseSync(settings.databasePath);
  t.after(async () => { await app.close(); db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, store, id, db, settings };
}

function captureTelegram() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (url, init) => {
    calls.push({ method: String(url).split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const deliver: typeof deliverTelegram = (token, chat, name, item) => deliverTelegram(token, chat, name, item, fetcher);
  return { calls, deliver };
}

test("thumbnail validation accepts HTTPS CDN hostnames and rejects spoofing, userinfo, types and other schemes", () => {
  for (const url of valid) assert.equal(validateImageUrl(url), new URL(url).toString());
  for (const value of invalid) assert.equal(validateImageUrl(value), null, JSON.stringify(value));
  assert.equal(validateImageUrl({ toString() { throw Error("must not coerce"); } }), null);
});

test("thumbnail length is capped at 2000 characters without truncating invalid input", () => {
  const prefix = "https://a.allegroimg.com/";
  const maximum = prefix + "a".repeat(2000 - prefix.length);
  assert.equal(validateImageUrl(maximum), maximum);
  assert.equal(validateImageUrl(maximum + "a"), null);
  assert.equal(validateImageUrl(prefix + "ą".repeat(400)), null); // URL encoding also respects the limit.
});

test("results accept every offer despite invalid thumbnails and send text notifications for those offers", async t => {
  const { app, store, id, db } = await fixture(t);
  const images = [...invalid, ...valid];
  const listings = images.map((imageUrl, index) => ({ ...listing(index), imageUrl }));
  const response = await app.inject({ method: "POST", url: `/api/extension/monitors/${id}/results`,
    headers: { authorization: "Bearer test-token" }, payload: { listings } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().accepted, images.length);
  assert.equal(response.json().newListings.length, images.length);
  assert.deepEqual(response.json().newListings.map((item: { imageUrl: string | null }) => item.imageUrl),
    [...invalid.map(() => null), ...valid.map(url => new URL(url).toString())]);
  assert.equal(store.recentListings().length, images.length);
  const { calls, deliver } = captureTelegram();
  const worker = new TelegramWorker(store, "test", deliver);
  t.after(() => worker.stop());
  for (let i = 0; i < images.length; i++) await worker.runOnce();
  assert.equal(calls.length, images.length);
  assert.equal(calls.filter(call => call.method === "sendPhoto").length, valid.length);
  const messages = calls.filter(call => call.method === "sendMessage");
  assert.equal(messages.length, invalid.length);
  for (let i = 0; i < invalid.length; i++) {
    assert.ok(messages.some(call => String(call.body.text).includes(`\nBook ${i}\n`)));
  }
  for (const call of messages) {
    assert.equal(call.body.photo, undefined);
    assert.equal(call.body.disable_web_page_preview, true);
    assert.ok(call.body.reply_markup);
  }
  assert.equal((db.prepare("SELECT COUNT(*) count FROM telegram_jobs WHERE status='sent'").get() as { count: number }).count, images.length);
});

test("historical thumbnails and existing queue payloads are validated at use without deleting or rewriting stored data", async t => {
  const { store, id, db, settings } = await fixture(t);
  const badUrl = "https://evil.example/image.jpg?cdn=allegroimg.com";
  store.saveCheck(store.getMonitor(id)!, [{ ...listing(1), imageUrl: badUrl }, { ...listing(2), imageUrl: valid[1]! }], ["123"]);
  const jobs = db.prepare("SELECT id,payload FROM telegram_jobs ORDER BY id").all() as Array<{ id: number; payload: string }>;
  const oldPayload = JSON.parse(jobs[1]!.payload);
  oldPayload.listing.imageUrl = { url: valid[1] }; // Legacy queue payload with an invalid type.
  db.prepare("UPDATE telegram_jobs SET payload=? WHERE id=?").run(JSON.stringify(oldPayload), jobs[1]!.id);
  const beforeHistory = store.recentListings();
  const beforeJobs = db.prepare("SELECT id,payload FROM telegram_jobs ORDER BY id").all();
  const html = renderPage([], beforeHistory, []);
  assert.ok(html.includes(`<img src="${valid[1]}"`));
  assert.ok(!html.includes(badUrl));
  assert.ok(html.includes('<div class="offer-image"><span>📖</span></div>'));
  assert.ok(html.includes("Book 1"));
  const reopened = new Store(settings.databasePath);
  t.after(() => reopened.close());
  const { calls, deliver } = captureTelegram();
  const worker = new TelegramWorker(reopened, "test", deliver);
  t.after(() => worker.stop());
  await worker.runOnce();
  await worker.runOnce();
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "sendMessage"]);
  assert.deepEqual(store.recentListings(), beforeHistory);
  assert.deepEqual(db.prepare("SELECT id,payload FROM telegram_jobs ORDER BY id").all(), beforeJobs);
  assert.deepEqual(db.prepare("SELECT status FROM telegram_jobs ORDER BY id").all().map(row => row.status), ["sent", "sent"]);
});
