import assert from "node:assert/strict";
import test from "node:test";
import { renderLogin } from "../src/ui.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server.js";
import { config } from "../src/config.js";

test("renders the personalized login panel and remember-me control", () => {
  const html = renderLogin();
  assert.match(html, /Cześć, Wioluś 😘/);
  assert.match(html, /zechcesz się zalogować\?/);
  assert.match(html, /\.welcome\{margin-bottom:24px;text-align:center\}/);
  assert.match(html, /name="remember"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /<img class="logo" src="\/assets\/logo.png"/);
  assert.match(html, /rel="icon" href="\/favicon.ico"/);
  assert.doesNotMatch(html, /Nieprawidłowa nazwa/);
  assert.match(renderLogin(true), /Nieprawidłowa nazwa/);
});

test("only allowlisted branding and script assets load before login with correct MIME", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-branding-"));
  const app = await buildApp({ startWorker: false, config: { ...config, databasePath: path.join(dir, "db.sqlite"),
    username: "test", password: "password", publicUrl: "", telegramBotToken: "" } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const [url, file, type] of [["/assets/logo.png", "logo.png", "image/png"],
    ["/favicon.ico", "favicon.ico", "image/x-icon"], ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"]] as const) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], type);
    assert.deepEqual(response.rawPayload, fs.readFileSync(`public/${file}`));
    assert.equal((await app.inject({ method: "HEAD", url })).statusCode, 200);
  }
  for (const file of ["theme-init.js", "panel.js", "devices.js", "extension-page.js"]) {
    const url = `/assets/${file}`;
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(response.rawPayload, fs.readFileSync(`public/${file}`));
    assert.equal((await app.inject({ method: "HEAD", url })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url })).headers.location, "/login");
  }
  for (const url of ["/", "/devices", "/extension", "/faq", "/extension/download", "/assets/package.json", "/assets/logo-source.png", "/assets/../package.json", "/assets/%2e%2e%2fpackage.json", "/assets/panel.js.map", "/assets/unknown.js"]) {
    assert.equal((await app.inject(url)).headers.location, "/login");
  }
  assert.equal((await app.inject({ method: "POST", url: "/assets/logo.png" })).headers.location, "/login");
  const expectedCsp = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  assert.equal((await app.inject("/login")).headers["content-security-policy"], expectedCsp);
});
