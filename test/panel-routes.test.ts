import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";
import { Store } from "../src/database.js";
import { renderFaq } from "../src/faq.js";
import { buildApp } from "../src/server.js";
import { tokenHash } from "../src/security.js";
import { renderPage } from "../src/ui.js";

async function fixture(t: TestContext, authenticated = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-panel-routes-"));
  const now = () => 1800000000000;
  const settings = {
    ...config,
    databasePath: path.join(directory, "test.sqlite"),
    username: authenticated ? "owner" : "",
    password: authenticated ? "password" : "",
    sessionSecret: "s".repeat(32),
    publicUrl: "",
    telegramBotToken: "",
  };
  const store = new Store(settings.databasePath, undefined, now);
  const id = store.createMonitor("Books", "https://allegro.pl/listing?string=books", 5);
  const client = store.addExtensionClient("Browser", tokenHash("device-token"));
  store.linkMonitorClient(id, client);
  const listing = (externalId: string) => ({
    externalId,
    title: externalId,
    url: "https://allegro.pl/oferta/book-123456",
    price: "10 zł",
    imageUrl: null,
  });
  store.saveCheck(store.getMonitor(id)!, []);
  store.saveCheck(store.getMonitor(id)!, [listing("offer:123456"), listing("offer:234567")], ["1"]);
  store.addExclusion(id, "offer:234567");
  store.notificationBatch(client);
  const app = await buildApp({ config: settings, now, startWorker: false });
  const db = new DatabaseSync(settings.databasePath);
  t.after(async () => {
    await app.close();
    db.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let cookie = "";
  if (authenticated) {
    const login = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: settings.username, password: settings.password },
    });
    assert.equal(login.statusCode, 302);
    cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  }
  const snapshot = () =>
    [
      "monitors",
      "listings",
      "monitor_exclusions",
      "monitor_clients",
      "extension_clients",
      "notification_events",
      "notification_batches",
      "telegram_jobs",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const post = (
    action: string,
    target = String(id),
    payload: object = { name: "Changed", externalId: "offer:123456" },
    headers = { cookie },
  ) => app.inject({ method: "POST", url: `/monitors/${target}/${action}`, headers, payload });
  return { app, store, id, cookie, snapshot, post };
}

for (const authenticated of [true, false]) {
  test(`panel and FAQ retain exact renderer output and form parsing (login configured=${authenticated})`, async (t) => {
    const { app, store, id, cookie } = await fixture(t, authenticated);
    if (authenticated) {
      for (const url of ["/", "/faq"]) {
        const response = await app.inject(url);
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, "/login");
      }
    }
    for (const [url, expected] of [
      ["/", renderPage(store.listMonitors(), store.recentListings(), store.listExclusions())],
      ["/faq", renderFaq()],
    ]) {
      const response = await app.inject({ url, headers: authenticated ? { cookie } : {} });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(response.body, expected);
    }
    const original = store.getMonitor(id)!;
    const renamed = await app.inject({
      method: "POST",
      url: `/monitors/${id}/rename`,
      headers: {
        ...(authenticated ? { cookie } : {}),
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": authenticated ? "same-origin" : "cross-site",
      },
      payload: "name=++Nowa+nazwa++",
    });
    assert.equal(renamed.statusCode, 302);
    assert.equal(renamed.headers.location, "/");
    assert.deepEqual({ ...store.getMonitor(id) }, { ...original, name: "Nowa nazwa" });
  });
}

test("all panel mutations reject missing sessions, bearer-only access and cross-site requests without data changes", async (t) => {
  const { app, id, cookie, snapshot } = await fixture(t);
  const before = snapshot();
  for (const action of ["exclusions", "exclusions/remove", "rename", "toggle", "delete"]) {
    for (const headers of [{}, { authorization: "Bearer device-token" }]) {
      const response = await app.inject({
        method: "POST",
        url: `/monitors/${id}/${action}`,
        headers,
        payload: { name: "Changed", externalId: "offer:123456" },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, "/login");
      assert.deepEqual(snapshot(), before);
    }
    for (const site of ["cross-site", "same-site"]) {
      const response = await app.inject({
        method: "POST",
        url: `/monitors/${id}/${action}`,
        headers: { cookie, "sec-fetch-site": site },
        payload: { name: "Changed", externalId: "offer:123456" },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.body, "Żądanie cross-site zostało odrzucone");
      assert.deepEqual(snapshot(), before);
    }
    assert.equal((await app.inject({ url: `/monitors/${id}/${action}`, headers: { cookie } })).statusCode, 404);
    assert.deepEqual(snapshot(), before);
  }
});

test("panel form errors preserve distinct invalid-ID, missing-monitor and missing-offer contracts without mutation", async (t) => {
  const { post, snapshot } = await fixture(t);
  const before = snapshot();
  const invalidMessages = [
    ["exclusions", "Nieprawidłowe dane wykluczenia"],
    ["exclusions/remove", "Nieprawidłowe dane wykluczenia"],
    ["rename", "Nieprawidłowa nazwa monitora"],
    ["toggle", "Nieprawidłowy identyfikator monitora"],
    ["delete", "Nieprawidłowy identyfikator monitora"],
  ] as const;
  for (const target of ["0", "invalid", "9007199254740992"]) {
    for (const [action, message] of invalidMessages) {
      const response = await post(action, target);
      assert.equal(response.statusCode, 400);
      assert.equal(response.body, message);
      assert.deepEqual(snapshot(), before);
    }
  }
  for (const [action, status, message] of [
    ["exclusions", 404, "Pozycja nie istnieje w tym monitorze"],
    ["exclusions/remove", 302, undefined],
    ["rename", 400, "Nieprawidłowa nazwa monitora"],
    ["toggle", 302, undefined],
    ["delete", 302, undefined],
  ] as const) {
    const response = await post(action, "999999");
    assert.equal(response.statusCode, status);
    if (message) assert.equal(response.body, message);
    else assert.equal(response.headers.location, "/");
    assert.deepEqual(snapshot(), before);
  }
  for (const action of ["exclusions", "exclusions/remove"]) {
    const empty = await post(action, undefined, {});
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.body, "Nieprawidłowe dane wykluczenia");
    const missing = await post(action, undefined, { externalId: "missing-offer" });
    assert.equal(missing.statusCode, action === "exclusions" ? 404 : 302);
    if (action === "exclusions") assert.equal(missing.body, "Pozycja nie istnieje w tym monitorze");
    else assert.equal(missing.headers.location, "/");
    assert.deepEqual(snapshot(), before);
  }
});
