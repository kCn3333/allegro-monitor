import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { config } from "../src/config.js";
import { Store } from "../src/database.js";
import { tokenHash } from "../src/security.js";
import { buildApp } from "../src/server.js";

async function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-monitor-names-"));
  const settings = {
    ...config,
    databasePath: path.join(dir, "db.sqlite"),
    username: "owner",
    password: "password",
    sessionSecret: "s".repeat(32),
    publicUrl: "",
    telegramBotToken: "",
  };
  const store = new Store(settings.databasePath);
  const url = "https://allegro.pl/listing?string=existing";
  const id = store.createMonitor("Original", url, 15);
  const first = store.addExtensionClient("First", tokenHash("first-token"));
  const second = store.addExtensionClient("Second", tokenHash("second-token"));
  store.linkMonitorClient(id, first, false);
  store.setNotificationsForClient(id, first, false);
  const app = await buildApp({ config: settings, startWorker: false });
  const db = new DatabaseSync(settings.databasePath);
  t.after(async () => {
    await app.close();
    db.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({
    method: "POST",
    url: "/login",
    payload: { username: "owner", password: "password" },
  });
  assert.equal(login.statusCode, 302);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const snapshot = () => [
    db.prepare("SELECT * FROM monitors ORDER BY id").all(),
    db.prepare("SELECT * FROM monitor_clients ORDER BY monitor_id,client_id").all(),
  ];
  return { app, store, url, id, first, second, cookie, snapshot };
}

const invalidNames: unknown[] = [
  undefined,
  null,
  false,
  true,
  0,
  123,
  [],
  ["Valid text"],
  {},
  { name: "Valid text" },
  "",
  " \t\n ",
  "a".repeat(101),
];

test("invalid API monitor names return a generic 400 without creating, updating or linking monitors", async (t) => {
  const { app, url, snapshot } = await fixture(t);
  const before = snapshot();
  for (const target of [url, "https://allegro.pl/listing?string=new"]) {
    for (const name of invalidNames) {
      const response = await app.inject({
        method: "POST",
        url: "/api/extension/monitors",
        headers: { authorization: "Bearer second-token" },
        payload: { name, url: target, intervalMinutes: 60 },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(name));
      assert.deepEqual(response.json(), { error: "Nieprawidłowe dane monitora" });
      assert.deepEqual(snapshot(), before);
    }
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/extension/monitors",
    headers: { authorization: "Bearer second-token" },
    payload: { name: 123, url, intervalMinutes: { toString: null, valueOf: null } },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "Nieprawidłowe dane monitora" });
  assert.deepEqual(snapshot(), before);
});

test("invalid rename names and duplicate form fields return a generic 400 without changing settings or links", async (t) => {
  const { app, id, cookie, snapshot } = await fixture(t);
  const before = snapshot();
  for (const name of invalidNames) {
    const response = await app.inject({
      method: "POST",
      url: `/monitors/${id}/rename`,
      headers: { cookie },
      payload: { name },
    });
    assert.equal(response.statusCode, 400, JSON.stringify(name));
    assert.equal(response.body, "Nieprawidłowa nazwa monitora");
    assert.deepEqual(snapshot(), before);
  }
  const duplicate = await app.inject({
    method: "POST",
    url: `/monitors/${id}/rename`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: "name=First&name=Second",
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.body, "Nieprawidłowa nazwa monitora");
  assert.deepEqual(snapshot(), before);
});

test("API creates and updates existing URLs with trimmed names up to 100 characters and all supported intervals", async (t) => {
  const { app, store, id, url, first, second } = await fixture(t);
  const headers = { authorization: "Bearer second-token" };
  const maximum = "ą".repeat(100);
  const update = await app.inject({
    method: "POST",
    url: "/api/extension/monitors",
    headers,
    payload: { name: ` \t${maximum}\n `, url, intervalMinutes: 30 },
  });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json(), {
    id,
    name: maximum,
    url,
    intervalMinutes: 30,
    newListingsCount: 0,
    lastCheckNewCount: 0,
  });
  assert.equal(store.getMonitor(id)!.name, maximum);
  assert.equal(store.getMonitor(id)!.intervalMinutes, 30);
  assert.equal(store.hasMonitorClient(id, second), true);
  const newUrl = "https://allegro.pl/listing?string=new";
  let newId: number | undefined;
  for (const intervalMinutes of [1, 5, 15, 30, 60]) {
    const name = intervalMinutes === 1 ? maximum : `Books ${intervalMinutes}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/extension/monitors",
      headers,
      payload: { name: ` \t${name}\n `, url: newUrl, intervalMinutes },
    });
    assert.equal(response.statusCode, 200);
    newId ??= response.json().id;
    assert.deepEqual(response.json(), {
      id: newId,
      name,
      url: newUrl,
      intervalMinutes,
      newListingsCount: 0,
      lastCheckNewCount: 0,
    });
    assert.equal(store.getMonitor(newId!)!.name, name);
    assert.equal(store.getMonitor(newId!)!.intervalMinutes, intervalMinutes);
    assert.equal(store.listMonitors().length, 2);
  }
  assert.equal(store.hasMonitorClient(newId!, first), true);
  assert.equal(store.hasMonitorClient(newId!, second), true);
});

test("form rename trims whitespace and accepts 100 characters without changing other monitor fields or links", async (t) => {
  const { app, store, id, cookie, snapshot } = await fixture(t);
  const before = snapshot();
  const original = store.getMonitor(id)!;
  const name = "ą".repeat(100);
  const response = await app.inject({
    method: "POST",
    url: `/monitors/${id}/rename`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    payload: new URLSearchParams({ name: ` \t${name}\n ` }).toString(),
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, "/");
  assert.deepEqual({ ...store.getMonitor(id) }, { ...original, name });
  assert.deepEqual(snapshot()[1], before[1]);
});

test("monitor creation keeps bearer authentication and interval validation, while rename keeps session and CSRF protection", async (t) => {
  const { app, id, cookie, url, snapshot } = await fixture(t);
  const before = snapshot();
  for (const headers of [{}, { authorization: "Bearer invalid" }, { cookie }]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/extension/monitors",
          headers,
          payload: { name: "Valid", url, intervalMinutes: 5 },
        })
      ).statusCode,
      401,
    );
  }
  for (const invalidUrl of ["not a URL", "http://allegro.pl/listing?string=book"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/extension/monitors",
      headers: { authorization: "Bearer second-token" },
      payload: { name: "Valid", url: invalidUrl, intervalMinutes: 5 },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: invalidUrl === "not a URL" ? "Invalid URL" : "Dozwolone są wyłącznie adresy HTTPS w domenie allegro.pl",
    });
    assert.deepEqual(snapshot(), before);
  }
  for (const intervalMinutes of [0, 2, 10, 61]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/extension/monitors",
          headers: { authorization: "Bearer second-token" },
          payload: { name: "Valid", url, intervalMinutes },
        })
      ).statusCode,
      400,
    );
  }
  for (const headers of [{}, { authorization: "Bearer first-token" }]) {
    const response = await app.inject({
      method: "POST",
      url: `/monitors/${id}/rename`,
      headers,
      payload: { name: "Valid" },
    });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/login");
  }
  for (const site of ["cross-site", "same-site"]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/monitors/${id}/rename`,
          headers: { cookie, "sec-fetch-site": site },
          payload: { name: "Valid" },
        })
      ).statusCode,
      403,
    );
  }
  assert.deepEqual(snapshot(), before);
});

test("monitor API routes require Bearer and preserve endpoint-specific ID and access errors", async (t) => {
  const { app, id, cookie, snapshot } = await fixture(t);
  const before = snapshot();
  for (const [action, payload, missingMessage] of [
    ["results", { listings: [] }, "Monitor nie istnieje lub jest wyłączony"],
    ["error", { message: "failed" }, "Monitor nie istnieje lub nie należy do tego rozszerzenia"],
    ["notification-state", { enabled: false }, "Monitor nie istnieje"],
  ] as const) {
    for (const headers of [{}, { cookie }, { authorization: "Bearer invalid" }]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/extension/monitors/${id}/${action}`,
        headers,
        payload,
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: "Nieprawidłowy token rozszerzenia" });
      assert.deepEqual(snapshot(), before);
    }
    for (const invalidId of ["0", "invalid", "9007199254740992", "99999"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/extension/monitors/${invalidId}/${action}`,
        headers: { authorization: "Bearer first-token" },
        payload,
      });
      assert.equal(response.statusCode, invalidId === "99999" ? 404 : 400);
      const message =
        invalidId === "99999"
          ? missingMessage
          : action === "notification-state"
            ? "Nieprawidłowy stan monitora"
            : "Nieprawidłowy identyfikator monitora";
      assert.deepEqual(response.json(), { error: message });
      assert.deepEqual(snapshot(), before);
    }
  }
});

test("results renew presence and clear a closed-tab error before rejecting invalid listings", async (t) => {
  const { app, store, id } = await fixture(t);
  store.saveError(store.getMonitor(id)!, new Error("Karta monitora jest zamknięta"));
  const before = store.getMonitor(id)!;
  assert.equal(store.listMonitors()[0]!.activeClientsCount, 0);
  const response = await app.inject({
    method: "POST",
    url: `/api/extension/monitors/${id}/results`,
    headers: { authorization: "Bearer first-token" },
    payload: { listings: {} },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "Nieprawidłowa lista ofert" });
  assert.equal(store.listMonitors()[0]!.activeClientsCount, 1);
  assert.deepEqual({ ...store.getMonitor(id) }, { ...before, lastError: null });
  assert.deepEqual(store.recentListings(), []);
  assert.equal(store.claimTelegramJob(), undefined);
});

test("notification state links an unlinked client, while errors accept paused monitors and preserve message conversion", async (t) => {
  const { app, store, id, first, second, snapshot } = await fixture(t);
  const post = (action: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/api/extension/monitors/${id}/${action}`,
      headers: { authorization: "Bearer second-token" },
      payload,
    });
  const before = snapshot();
  for (const action of ["results", "error"]) {
    const response = await post(action, { listings: [], message: "failed" });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error:
        action === "results"
          ? "Monitor nie istnieje lub jest wyłączony"
          : "Monitor nie istnieje lub nie należy do tego rozszerzenia",
    });
    assert.deepEqual(snapshot(), before);
  }
  for (const enabled of [undefined, null, 0, "false", [], {}]) {
    const response = await post("notification-state", { enabled });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "Nieprawidłowy stan monitora" });
    assert.deepEqual(snapshot(), before);
  }
  const state = await post("notification-state", { enabled: true });
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json(), { enabled: true });
  assert.equal(store.hasMonitorClient(id, second), true);
  assert.equal(store.areNotificationsEnabledForClient(id, second), true);
  assert.equal(store.areNotificationsEnabledForClient(id, first), false);
  store.toggleMonitor(id);
  assert.equal((await post("results", { listings: [] })).statusCode, 404);
  const links = snapshot()[1];
  for (const [message, expected] of [
    [undefined, "Nieznany błąd rozszerzenia"],
    [0, "Nieznany błąd rozszerzenia"],
    [123, "123"],
    ["x".repeat(1001), "x".repeat(1000)],
  ] as const) {
    const response = await post("error", { message });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { saved: true });
    assert.equal(store.getMonitor(id)!.lastError, expected);
    assert.equal(store.getMonitor(id)!.lastCheckNewCount, 0);
    assert.deepEqual(snapshot()[1], links);
  }
});
