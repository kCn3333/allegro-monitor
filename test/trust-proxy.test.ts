import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config, parseTrustProxy } from "../src/config.js";
import { buildApp } from "../src/server.js";

async function fixture(t: any, trusted?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-proxy-"));
  const app = await buildApp({ startWorker: false, config: { ...config, databasePath: path.join(dir, "db.sqlite"),
    trustProxy: parseTrustProxy(trusted), username: "owner", password: "password", sessionSecret: "s".repeat(32),
    publicUrl: "", telegramBotToken: "" } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const login = await app.inject({ method: "POST", url: "/login", payload: { username: "owner", password: "password" } });
  assert.equal(login.statusCode, 302);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const code = (await app.inject({ method: "POST", url: "/api/extension/pairing-code", headers: { cookie } })).json().code;
  const request = (url: string, remoteAddress: string, forwarded: string, payload: object) => app.inject({
    method: "POST", url, remoteAddress, headers: { "x-forwarded-for": forwarded }, payload
  });
  return { request, code };
}

test("TRUST_PROXY accepts only explicit IPv4/IPv6 addresses and CIDRs, defaulting to false", () => {
  for (const value of [undefined, "", " \t "]) assert.equal(parseTrustProxy(value), false);
  assert.deepEqual(parseTrustProxy(" 192.0.2.10,198.51.100.0/24,2001:db8::1, 2001:db8:10::/64 "),
    ["192.0.2.10", "198.51.100.0/24", "2001:db8::1", "2001:db8:10::/64"]);
  assert.deepEqual(parseTrustProxy("192.0.2.10/32,2001:db8::1/128"), ["192.0.2.10/32", "2001:db8::1/128"]);
  for (const value of ["true", "false", "1", "0", "2", "-1", "1.5", "localhost", "loopback", "uniquelocal", "linklocal",
    "*", "https://proxy.example", "proxy.example", "192.0.2.999", "192.0.2.10:443", "[2001:db8::1]", "fe80::1%eth0",
    "192.0.2.0/0", "2001:db8::/0", "192.0.2.0/33", "2001:db8::/129", "192.0.2.0/-1", "192.0.2.0/foo", "192.0.2.0/", "192.0.2.0/24/1",
    ",", "192.0.2.10,", ",192.0.2.10", "192.0.2.10,,2001:db8::1", "192.0.2.10,true"]) {
    assert.throws(() => parseTrustProxy(value), /Nieprawidłowe TRUST_PROXY:.*IP\/CIDR/, value);
  }
});

test("TRUST_PROXY is loaded from the environment and invalid configuration fails at startup", () => {
  const script = `import {config} from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)}; console.log(JSON.stringify(config.trustProxy))`;
  const args = ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script];
  for (const [value, expected] of [["", false], ["192.0.2.10,2001:db8::/64", ["192.0.2.10", "2001:db8::/64"]]] as const) {
    const result = spawnSync(process.execPath, args, { env: { ...process.env, TRUST_PROXY: value }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  const invalid = spawnSync(process.execPath, args, { env: { ...process.env, TRUST_PROXY: "true" }, encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Nieprawidłowe TRUST_PROXY:.*IP\/CIDR/);
});

for (const peer of ["192.0.2.10", "2001:db8:10::10"]) {
  test(`clients behind trusted proxy ${peer} have independent login and pairing limits`, async t => {
    const { request, code } = await fixture(t, "192.0.2.10,2001:db8:10::/64");
    const login = (client: string, password: string) => request("/login", peer, client, { username: "owner", password });
    for (let i = 0; i < 20; i++) assert.equal((await login("203.0.113.1", "wrong")).statusCode, 401);
    const blocked = await login("203.0.113.1", "password");
    assert.equal(blocked.statusCode, 429);
    assert.ok(blocked.headers["retry-after"]);
    assert.equal((await login("203.0.113.2", "password")).statusCode, 302);
    for (let i = 0; i < 12; i++) {
      assert.equal((await request("/api/extension/pair", peer, "203.0.113.1", { code: "invalid" })).statusCode, 400);
    }
    assert.equal((await request("/api/extension/pair", peer, "203.0.113.1", { code })).statusCode, 429);
    const paired = await request("/api/extension/pair", peer, "203.0.113.2", { code });
    assert.equal(paired.statusCode, 200);
    assert.equal(typeof paired.json().token, "string");
  });
}

for (const trusted of [undefined, "192.0.2.10"]) {
  test(`${trusted ? "untrusted peer" : "no TRUST_PROXY"}: forged X-Forwarded-For cannot evade either limit`, async t => {
    const { request, code } = await fixture(t, trusted);
    const peer = "198.51.100.20";
    for (let i = 0; i < 20; i++) {
      assert.equal((await request("/login", peer, `203.0.113.${i + 1}`, { username: "owner", password: "wrong" })).statusCode, 401);
    }
    assert.equal((await request("/login", peer, "203.0.113.100", { username: "owner", password: "password" })).statusCode, 429);
    for (let i = 0; i < 12; i++) {
      assert.equal((await request("/api/extension/pair", peer, `203.0.113.${i + 1}`, { code: "invalid" })).statusCode, 400);
    }
    assert.equal((await request("/api/extension/pair", peer, "203.0.113.100", { code })).statusCode, 429);
  });
}

test("forwarded chain stops at the nearest untrusted hop for login and pairing limits", async t => {
  const { request, code } = await fixture(t, "192.0.2.10,192.0.2.11");
  const peer = "192.0.2.10";
  const chain = (client: string) => `${client}, 198.51.100.20, 192.0.2.11`;
  for (let i = 0; i < 20; i++) {
    assert.equal((await request("/login", peer, chain(`203.0.113.${i + 1}`), { username: "owner", password: "wrong" })).statusCode, 401);
  }
  assert.equal((await request("/login", peer, chain("203.0.113.100"), { username: "owner", password: "password" })).statusCode, 429);
  for (let i = 0; i < 12; i++) {
    assert.equal((await request("/api/extension/pair", peer, chain(`203.0.113.${i + 1}`), { code: "invalid" })).statusCode, 400);
  }
  assert.equal((await request("/api/extension/pair", peer, chain("203.0.113.100"), { code })).statusCode, 429);
  const legitimateChain = "203.0.113.200, 192.0.2.11";
  assert.equal((await request("/login", peer, legitimateChain, { username: "owner", password: "password" })).statusCode, 302);
  assert.equal((await request("/api/extension/pair", peer, legitimateChain, { code })).statusCode, 200);
});
