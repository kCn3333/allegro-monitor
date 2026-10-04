import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildExtensionPackage, publicBackendUrl } from "../src/extension-package.js";
import { buildApp } from "../src/server.js";
import { config } from "../src/config.js";

function temporary(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-package-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("public backend URL accepts HTTPS origins and rejects credentials, paths and wildcards", () => {
  assert.equal(publicBackendUrl("https://monitor.example/").origin, "https://monitor.example");
  assert.equal(publicBackendUrl("https://monitor.example:8443").origin, "https://monitor.example:8443");
  for (const url of ["", "http://monitor.example", "https://u:p@monitor.example", "https://monitor.example/api", "https://monitor.example?q=x", "https://monitor.example#x", "https://*.example"]) {
    assert.throws(() => publicBackendUrl(url), /APP_PUBLIC_URL/);
  }
});

test("downloaded archives contain only selected assets and use deployment-specific origins and permissions", async t => {
  const dir = temporary(t);
  const source = path.join(dir, "source");
  fs.cpSync("extension", source, { recursive: true });
  fs.writeFileSync(path.join(source, ".env"), "APP_PASSWORD=must-not-leak");
  for (const origin of ["https://first.example", "https://second.example:8443"]) {
    const archive = path.join(dir, "extension.zip");
    fs.writeFileSync(archive, await buildExtensionPackage(origin, source));
    const read = (name: string) => execFileSync("unzip", ["-p", archive, name], { encoding: "utf8" });
    const manifest = JSON.parse(read("manifest.json"));
    assert.deepEqual(manifest.host_permissions, ["https://allegro.pl/*", "https://*.allegro.pl/*", `https://${new URL(origin).hostname}/*`]);
    assert.equal(read("backend-config.js"), `export const BACKEND_URL = ${JSON.stringify(origin)};\n`);
    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n");
    assert.equal(entries.length, 10); assert.ok(!entries.includes(".env"));
    for (const asset of ["popup.js", "service-worker.js"]) assert.match(read(asset), /import \{ BACKEND_URL \} from "\.\/backend-config.js"/);
    assert.match(read("popup-icons.js"), /export const icons =/);
    assert.match(read("popup-icons.js"), /aria-hidden/);
    assert.match(read("fontawesome-license.txt"), /CC BY 4.0/);
    assert.match(read("popup.js"), /import \{ icons \} from "\.\/popup-icons.js"/);
    assert.match(read("popup.html"), /type="module" src="popup.js"/);
    assert.doesNotMatch(read("popup.html"), /kcn333/);
  }
  assert.equal(fs.readFileSync("extension/backend-config.js", "utf8"), fs.readFileSync(path.join(source, "backend-config.js"), "utf8"));
});

test("config reads .env while explicit process environment takes precedence", t => {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, ".env"), "APP_PUBLIC_URL=https://env-file.example\nAPP_PASSWORD=private-value\n");
  const env = { ...process.env }; delete env.APP_PUBLIC_URL;
  const script = `import {config} from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)}; console.log(config.publicUrl)`;
  const args = ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script];
  assert.equal(execFileSync(process.execPath, args, { cwd: dir, env, encoding: "utf8" }).trim(), "https://env-file.example");
  assert.equal(execFileSync(process.execPath, args, { cwd: dir, env: { ...env, APP_PUBLIC_URL: "https://override.example" }, encoding: "utf8" }).trim(), "https://override.example");
});

test("download uses configured origin rather than request Host or forwarded headers", async t => {
  const dir = temporary(t);
  const app = await buildApp({ startWorker: false, config: { ...config, publicUrl: "https://configured.example", databasePath: path.join(dir, "db.sqlite"), username: "", password: "", telegramBotToken: "" } });
  t.after(() => app.close());
  const response = await app.inject({ url: "/extension/download", headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" } });
  assert.equal(response.statusCode, 200);
  const archive = path.join(dir, "download.zip"); fs.writeFileSync(archive, response.rawPayload);
  assert.match(execFileSync("unzip", ["-p", archive, "backend-config.js"], { encoding: "utf8" }), /https:\/\/configured.example/);
});

test("missing configuration cannot silently serve an archive with a built-in address", async t => {
  const dir = temporary(t);
  const app = await buildApp({ startWorker: false, config: { ...config, publicUrl: "", databasePath: path.join(dir, "db.sqlite"), username: "", password: "", telegramBotToken: "" } });
  t.after(() => app.close());
  assert.equal((await app.inject("/extension/download")).statusCode, 503);
});
