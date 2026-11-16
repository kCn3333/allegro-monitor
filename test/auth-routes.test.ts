import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { Store } from "../src/database.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { buildApp } from "../src/server.js";
import { credentialFingerprint, sessionTokenFromCookie, tokenHash } from "../src/security.js";
import { renderLogin } from "../src/ui.js";

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-auth-"));
  const clock = { time: 1800000000000, now: () => clock.time };
  const settings = {
    ...config,
    databasePath: path.join(directory, "test.sqlite"),
    username: "owner",
    password: "password",
    sessionSecret: "s".repeat(32),
    publicUrl: "",
    telegramBotToken: "",
  };
  const app = await buildApp({ config: settings, now: clock.now, startWorker: false });
  const db = new DatabaseSync(settings.databasePath);
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const login = (password = settings.password, remember = false, headers = {}) =>
    app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      payload: new URLSearchParams({
        username: settings.username,
        password,
        remember: remember ? "yes" : "no",
      }).toString(),
    });
  return { app, db, clock, settings, login };
}

for (const remember of [false, true]) {
  test(`auth form routes preserve HTML, cookies, renewal and logout (remember=${remember})`, async (t) => {
    const { app, db, clock, settings, login } = await fixture(t);
    const page = await app.inject("/login");
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(page.body, renderLogin());
    const failed = await login("wrong");
    assert.equal(failed.statusCode, 401);
    assert.equal(failed.body, renderLogin(true));
    assert.equal(failed.headers["set-cookie"], undefined);
    const success = await login(settings.password, remember);
    assert.equal(success.statusCode, 302);
    assert.equal(success.headers.location, "/");
    const cookieHeader = String(success.headers["set-cookie"]);
    const token = sessionTokenFromCookie(cookieHeader);
    assert.ok(token);
    assert.equal(
      cookieHeader,
      `allegro_monitor_session=${token}; Path=/; HttpOnly; SameSite=Strict${remember ? "; Max-Age=2592000" : ""}`,
    );
    const cookie = cookieHeader.split(";", 1)[0]!;
    const duration = remember ? 30 * 86400 : 12 * 3600;
    const session = () => db.prepare("SELECT * FROM web_sessions").get()!;
    const createdAt = new Date(clock.time).toISOString();
    assert.equal(session().token_hash, tokenHash(token));
    assert.equal(
      session().credential_fingerprint,
      credentialFingerprint(settings.username, settings.password, settings.sessionSecret),
    );
    assert.equal(session().duration_seconds, duration);
    assert.equal(session().created_at, createdAt);
    clock.time += 1000;
    const redirected = await app.inject({ url: "/login", headers: { cookie } });
    assert.equal(redirected.statusCode, 302);
    assert.equal(redirected.headers.location, "/");
    assert.equal(redirected.headers["set-cookie"], undefined);
    assert.equal(session().last_used_at, new Date(clock.time).toISOString());
    assert.equal(session().expires_at, new Date(clock.time + duration * 1000).toISOString());
    assert.equal(session().created_at, createdAt);
    const panel = await app.inject({ url: "/", headers: { cookie } });
    assert.equal(panel.statusCode, 200);
    assert.equal(panel.headers["set-cookie"], cookieHeader);
    assert.equal((await app.inject({ url: "/logout", headers: { cookie } })).statusCode, 404);
    const crossSite = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.statusCode, 403);
    assert.equal(crossSite.body, "Żądanie cross-site zostało odrzucone");
    assert.ok(session());
    const logout = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    assert.equal(logout.statusCode, 302);
    assert.equal(logout.headers.location, "/login");
    assert.equal(
      logout.headers["set-cookie"],
      "allegro_monitor_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    assert.equal(db.prepare("SELECT * FROM web_sessions").get(), undefined);
    assert.equal((await app.inject({ url: "/", headers: { cookie } })).headers.location, "/login");
    assert.equal((await app.inject({ url: "/login", headers: { cookie } })).body, renderLogin());
  });
}

test("successful login resets failures and the blocked form retains rounded Retry-After", async (t) => {
  const { login, clock } = await fixture(t);
  for (let i = 0; i < 19; i++) assert.equal((await login("wrong")).statusCode, 401);
  assert.equal((await login()).statusCode, 302);
  for (let i = 0; i < 20; i++) assert.equal((await login("wrong")).statusCode, 401);
  clock.time += 1001;
  const blocked = await login();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers["retry-after"], "899");
  assert.equal(blocked.body, renderLogin(true));
  assert.equal(blocked.headers["set-cookie"], undefined);
});

test("global auth hook preserves public endpoints, bearer protection and login CSRF", async (t) => {
  const { app, db, login } = await fixture(t);
  for (const site of ["cross-site", "same-site"]) {
    assert.equal((await login("password", false, { "sec-fetch-site": site })).statusCode, 403);
  }
  assert.equal(db.prepare("SELECT * FROM web_sessions").get(), undefined);
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/assets/theme-init.js")).statusCode, 200);
  assert.equal((await app.inject("/")).headers.location, "/login");
  const unauthenticatedLogout = await app.inject({ method: "POST", url: "/logout" });
  assert.equal(unauthenticatedLogout.headers.location, "/login");
  assert.equal(unauthenticatedLogout.headers["set-cookie"], undefined);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/extension/pair", payload: { code: "invalid" } })).statusCode,
    400,
  );
  for (const url of ["/api/extension/presence", "/api/extension/monitors", "/api/extension/notifications/ack"]) {
    assert.equal((await app.inject({ method: "POST", url, payload: {} })).statusCode, 401);
  }
  const unauthenticatedCode = await app.inject({ method: "POST", url: "/api/extension/pairing-code" });
  assert.equal(unauthenticatedCode.statusCode, 302);
  assert.equal(unauthenticatedCode.headers.location, "/login");
  const loggedIn = await login();
  const cookie = String(loggedIn.headers["set-cookie"]).split(";", 1)[0]!;
  for (const site of ["cross-site", "same-site"]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/extension/pairing-code",
      headers: { cookie, "sec-fetch-site": site },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.body, "Żądanie cross-site zostało odrzucone");
  }
  const generated = await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } });
  assert.equal(generated.statusCode, 200);
  const paired = await app.inject({
    method: "POST",
    url: "/api/extension/pair",
    payload: { code: generated.json().code },
  });
  assert.equal(paired.statusCode, 200);
  const headers = { authorization: `Bearer ${paired.json().token}` };
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/extension/presence", headers, payload: { monitors: [] } }))
      .statusCode,
    200,
  );
  assert.equal((await app.inject({ url: "/", headers })).headers.location, "/login");
});

test("auth routes use the supplied pairing attempts map and clock for shared capacity", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-auth-capacity-"));
  const now = 1800000000000;
  const store = new Store(path.join(directory, "test.sqlite"), undefined, () => now);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const attempts = new Map<string, { count: number; resetAt: number }>();
  for (let i = 0; i < 10000; i++) attempts.set(`pair:client-${i}`, { count: 1, resetAt: now + 7001 + i });
  registerAuthRoutes(app, {
    settings: { username: "owner", password: "password" },
    store,
    now: () => now,
    secureCookies: false,
    webCredentialFingerprint: "test-fingerprint",
    attempts,
    allowAttempt: () => assert.fail("a capacity-blocked or successful login must not record a failure"),
    pruneAttempts: () => {},
  });
  const login = () =>
    app.inject({ method: "POST", url: "/login", payload: { username: "owner", password: "password" } });
  const blocked = await login();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers["retry-after"], "8");
  assert.equal(blocked.headers["set-cookie"], undefined);
  attempts.clear();
  assert.equal((await login()).statusCode, 302);
});

test("login and pairing share limiter capacity and successful requests release their entries", async (t) => {
  const { app, db } = await fixture(t);
  app.log.level = "silent";
  const loggedIn = await app.inject({
    method: "POST",
    url: "/login",
    payload: { username: "owner", password: "password" },
  });
  assert.equal(loggedIn.statusCode, 302);
  const cookie = String(loggedIn.headers["set-cookie"]).split(";", 1)[0]!;
  const generated = await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } });
  assert.equal(generated.statusCode, 200);
  const code = generated.json().code;
  for (let i = 0; i < 9999; i++) {
    const failed = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: `192.0.${i >> 8}.${i % 256}`,
      payload: { username: "owner", password: "wrong" },
    });
    assert.equal(failed.statusCode, 401);
  }
  const pair = (value: string, remoteAddress = "198.51.100.1") =>
    app.inject({ method: "POST", url: "/api/extension/pair", remoteAddress, payload: { code: value } });
  assert.equal((await pair("invalid")).statusCode, 400);
  const blockedLogin = await app.inject({
    method: "POST",
    url: "/login",
    remoteAddress: "203.0.113.1",
    payload: { username: "owner", password: "password" },
  });
  assert.equal(blockedLogin.statusCode, 429);
  assert.equal(blockedLogin.headers["retry-after"], "900");
  const blockedPair = await pair(code, "198.51.100.2");
  assert.equal(blockedPair.statusCode, 429);
  assert.equal(blockedPair.body, "Zbyt wiele prób parowania");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM extension_clients").get()!.count, 0);
  const successfulLogin = await app.inject({
    method: "POST",
    url: "/login",
    remoteAddress: "192.0.0.0",
    payload: { username: "owner", password: "password" },
  });
  assert.equal(successfulLogin.statusCode, 302);
  const paired = await pair(code, "198.51.100.2");
  assert.equal(paired.statusCode, 200);
  assert.equal(typeof paired.json().token, "string");
  const afterPair = await app.inject({
    method: "POST",
    url: "/login",
    remoteAddress: "203.0.113.1",
    payload: { username: "owner", password: "wrong" },
  });
  assert.equal(afterPair.statusCode, 401);
});
