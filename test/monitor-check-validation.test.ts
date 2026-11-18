import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { tokenHash } from "../src/security.js";

const offer = (id: number) => ({
  externalId: `offer:${100000 + id}`,
  title: `Book ${id}`,
  url: `https://allegro.pl/oferta/book-${100000 + id}`,
  price: "10 zł",
  imageUrl: null,
});
async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-check-validation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "test.sqlite");
  const clock = { time: 1800000000000, now: () => clock.time };
  const store = new Store(databasePath, undefined, clock.now);
  t.after(() => store.close());
  const id = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  const a = store.addExtensionClient("A", tokenHash("a"));
  store.addExtensionClient("B", tokenHash("b"));
  store.touchExtensionClient(tokenHash("a"));
  store.touchExtensionClient(tokenHash("b"));
  store.linkMonitorClient(id, a, false);
  store.setNotificationsForClient(id, a, false);
  store.saveCheck(store.getMonitor(id)!, []);
  const app = await buildApp({
    config: {
      ...config,
      databasePath,
      publicUrl: "",
      username: "",
      password: "",
      telegramBotToken: "test",
      telegramChatIds: ["1", "2"],
    },
    startWorker: false,
    now: clock.now,
  });
  t.after(() => app.close());
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const post = (action: string, payload?: unknown, monitor = String(id), token = "a") =>
    app.inject({
      method: "POST",
      url: `/api/extension/monitors/${monitor}/${action}`,
      headers:
        payload === undefined
          ? { authorization: `Bearer ${token}` }
          : { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const data = () =>
    ["listings", "notification_events", "notification_batches", "telegram_jobs", "monitor_exclusions"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  const state = () => [
    ...data(),
    db.prepare("SELECT * FROM monitors ORDER BY id").all(),
    db.prepare("SELECT * FROM monitor_clients ORDER BY monitor_id,client_id").all(),
  ];
  return { app, store, db, id, a, clock, post, data, state };
}

test("check APIs preserve Bearer, ID and ownership error precedence over invalid bodies", async (t) => {
  const { post, state, id, store } = await fixture(t);
  const before = state();
  for (const action of ["results", "error"]) {
    const missing =
      action === "results"
        ? "Monitor nie istnieje lub jest wyłączony"
        : "Monitor nie istnieje lub nie należy do tego rozszerzenia";
    for (const payload of [null, [], { listings: null }, { listings: Array(201).fill(null) }]) {
      for (const [monitors, token, status, error] of [
        [["invalid", "99999", String(id)], "wrong", 401, "Nieprawidłowy token rozszerzenia"],
        [["0", "-1", "1.5", "invalid", "9007199254740992"], "a", 400, "Nieprawidłowy identyfikator monitora"],
        [["99999"], "a", 404, missing],
        [[String(id)], "b", 404, missing],
      ] as const) {
        for (const monitor of monitors) {
          const context = `${action}, id=${monitor}, token=${token}, payload=${JSON.stringify(payload)}`;
          const response = await post(action, payload, monitor, token);
          assert.equal(response.statusCode, status, context);
          assert.deepEqual(response.json(), { error }, context);
          assert.deepEqual(state(), before, context);
        }
      }
    }
  }
  store.toggleMonitor(id);
  const paused = state();
  const rejected = await post("results", { listings: null });
  assert.equal(rejected.statusCode, 404);
  assert.deepEqual(rejected.json(), { error: "Monitor nie istnieje lub jest wyłączony" });
  assert.deepEqual(state(), paused);
  const accepted = await post("error", { message: 123 });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), { saved: true });
  assert.equal(store.getMonitor(id)!.lastError, "123");
});

test("invalid results refresh the tab and clear closed-tab errors but do not save offers, events or jobs", async (t) => {
  const { post, data, store, db, clock, id, a } = await fixture(t);
  const cases: [unknown, string][] = [
    [undefined, "Nieprawidłowa lista ofert"],
    [null, "Nieprawidłowa lista ofert"],
    [[], "Nieprawidłowa lista ofert"],
    [{}, "Nieprawidłowa lista ofert"],
    [{ listings: {} }, "Nieprawidłowa lista ofert"],
    [{ listings: Array(201).fill(null) }, "Nieprawidłowa lista ofert"],
    [{ listings: [offer(1), null, { url: "bad" }] }, "Nieprawidłowa oferta"],
    [{ listings: [{ externalId: "", title: "", url: "bad" }, null] }, "Invalid URL"],
    [{ listings: [{ ...offer(1), title: " " }, null] }, "Nieprawidłowe dane oferty"],
    [{ listings: [[]] }, "Invalid URL"],
  ];
  for (const [payload, message] of cases) {
    store.linkMonitorClient(id, a, false);
    store.saveError(store.getMonitor(id)!, new Error("Karta monitora jest zamknięta"));
    const before = store.getMonitor(id)!;
    const unchanged = data();
    clock.time += 1000;
    const response = await post("results", payload);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: message });
    assert.deepEqual(data(), unchanged);
    assert.deepEqual({ ...store.getMonitor(id) }, { ...before, lastError: null });
    const link = db
      .prepare(
        "SELECT tab_open,last_seen_at,notifications_enabled FROM monitor_clients WHERE monitor_id=? AND client_id=?",
      )
      .get(id, a);
    assert.deepEqual(
      { ...link },
      { tab_open: 1, last_seen_at: new Date(clock.time).toISOString(), notifications_enabled: 0 },
    );
  }
});

test("results retain offer normalization, unknown fields, invalid thumbnail fallback and delivery writes", async (t) => {
  const { post, app, store, db, id } = await fixture(t);
  let observed: unknown;
  app.addHook("preHandler", async (request) => {
    observed = structuredClone(request.body);
  });
  const payload = {
    unknown: { keep: true },
    listings: [
      {
        externalId: "x".repeat(201),
        title: ` ${"📚".repeat(251)} `,
        url: "https://ALLEGRO.PL:443/oferta/book?z=2&a=1#fragment",
        price: "p".repeat(101),
        imageUrl: "javascript:bad",
        extra: "kept",
      },
      {
        externalId: 123,
        title: 999,
        url: ["https://allegro.pl/oferta/123"],
        price: false,
        imageUrl: "https://a.allegroimg.com/book.jpg",
      },
      {
        externalId: [1, 2],
        title: true,
        url: "https://allegro.pl/oferta/other",
        price: null,
        imageUrl: { url: "https://allegroimg.com/book.jpg" },
      },
    ],
  };
  const response = await post("results", payload, "0x1");
  const expected = [
    {
      externalId: "x".repeat(200),
      title: "📚".repeat(250),
      url: "https://allegro.pl/oferta/book?z=2&a=1#fragment",
      price: "p".repeat(100),
      imageUrl: null,
    },
    {
      externalId: "123",
      title: "999",
      url: "https://allegro.pl/oferta/123",
      price: "false",
      imageUrl: "https://a.allegroimg.com/book.jpg",
    },
    { externalId: "1,2", title: "true", url: "https://allegro.pl/oferta/other", price: null, imageUrl: null },
  ];
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { accepted: 3, newListings: expected, newListingsCount: 3, lastCheckNewCount: 3 });
  assert.deepEqual(observed, payload);
  assert.equal(store.getMonitor(id)!.newListingsCount, 3);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_events").get()!.count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM telegram_jobs").get()!.count, 6);
  const again = await post("results", payload, "1e0");
  assert.deepEqual(again.json(), { accepted: 3, newListings: [], newListingsCount: 3, lastCheckNewCount: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM telegram_jobs").get()!.count, 6);
});

test("results accept zero and exactly 200 offers and preserve ID conversions", async (t) => {
  const { post, data } = await fixture(t);
  for (const monitor of ["01", "%2B1", "%201%20"]) {
    const response = await post("results", { listings: [] }, monitor);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { accepted: 0, newListings: [], newListingsCount: 0, lastCheckNewCount: 0 });
  }
  const listings = Array.from({ length: 200 }, (_, i) => offer(i));
  const response = await post("results", { listings });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    accepted: 200,
    newListings: listings,
    newListingsCount: 200,
    lastCheckNewCount: 200,
  });
  const before = data();
  const rejected = await post("results", { listings: [...listings, offer(201)] });
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(rejected.json(), { error: "Nieprawidłowa lista ofert" });
  assert.deepEqual(data(), before);
});

test("error reports keep missing bodies, legacy message conversion and UTF-16 truncation without linking tabs", async (t) => {
  const { post, store, db, id } = await fixture(t);
  const links = () => db.prepare("SELECT * FROM monitor_clients ORDER BY monitor_id,client_id").all();
  const before = links();
  for (const payload of [
    undefined,
    null,
    [],
    1,
    true,
    "text",
    {},
    ...[undefined, null, false, 0, "", "   ", 123, true, [], ["a", 2], {}, "x".repeat(1001), "📚".repeat(501)].map(
      (message) => ({ message, unknown: { keep: true } }),
    ),
  ]) {
    const response = await post("error", payload, "1e0");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { saved: true });
    const message = (payload as { message?: unknown } | null)?.message;
    assert.equal(store.getMonitor(id)!.lastError, String(message || "Nieznany błąd rozszerzenia").slice(0, 1000));
    assert.equal(store.getMonitor(id)!.lastCheckNewCount, 0);
    assert.deepEqual(links(), before);
  }
});

test("check API parser errors stay local, sanitized and preserve data before handler writes", async (t) => {
  const { app, state, id } = await fixture(t);
  const before = state();
  for (const action of ["results", "error"]) {
    for (const token of ["a", "wrong"]) {
      for (const [payload, status, error] of [
        ["", 400, "Nieprawidłowy JSON"],
        ['{"value": SECRET', 400, "Nieprawidłowy JSON"],
        [JSON.stringify({ extra: "x".repeat(256000) }), 413, "Zbyt duże żądanie"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/extension/monitors/${id}/${action}`,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          payload,
        });
        assert.equal(response.statusCode, status);
        assert.deepEqual(response.json(), { error });
        assert.deepEqual(state(), before);
      }
    }
  }
});
