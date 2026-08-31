import assert from "node:assert/strict";
import test from "node:test";
import { credentialFingerprint, expiredSessionCookie, isSameOriginRequest, safeCredentialsEqual,
  sessionCookie, sessionTokenFromCookie, tokenHash } from "../src/security.js";

test("accepts browser mutations explicitly marked as same-origin", () => {
  assert.equal(isSameOriginRequest({
    "sec-fetch-site": "same-origin",
    origin: "https://allegro-monitor.kcn333.com",
    host: "app:3000"
  }), true);
});

test("rejects cross-site and same-site mutations", () => {
  assert.equal(isSameOriginRequest({ "sec-fetch-site": "cross-site" }), false);
  assert.equal(isSameOriginRequest({ "sec-fetch-site": "same-site" }), false);
});

test("uses the forwarded public host when Fetch Metadata is unavailable", () => {
  assert.equal(isSameOriginRequest({
    origin: "https://allegro-monitor.kcn333.com",
    host: "app:3000",
    "x-forwarded-host": "allegro-monitor.kcn333.com"
  }), true);
  assert.equal(isSameOriginRequest({
    origin: "https://attacker.example",
    "x-forwarded-host": "allegro-monitor.kcn333.com"
  }), false);
});

test("reads only a well-formed session token from cookies", () => {
  const token = "a".repeat(43);
  assert.equal(sessionTokenFromCookie(`theme=dark; allegro_monitor_session=${token}; x=1`), token);
  assert.equal(sessionTokenFromCookie("allegro_monitor_session=too-short"), null);
  assert.equal(sessionTokenFromCookie(undefined), null);
});

test("builds hardened persistent and expiring cookies", () => {
  const persistent = sessionCookie("a".repeat(43), true, true);
  assert.match(persistent, /HttpOnly/);
  assert.match(persistent, /SameSite=Strict/);
  assert.match(persistent, /Secure/);
  assert.match(persistent, /Max-Age=2592000/);
  assert.doesNotMatch(sessionCookie("a".repeat(43), false, false), /Max-Age|Secure/);
  assert.match(expiredSessionCookie(true), /Max-Age=0/);
});

test("compares credentials safely and binds sessions to current credentials", () => {
  assert.equal(safeCredentialsEqual("wiola", "sekret", "wiola", "sekret"), true);
  assert.equal(safeCredentialsEqual("wiola", "zle", "wiola", "sekret"), false);
  assert.equal(tokenHash("token"), tokenHash("token"));
  assert.notEqual(credentialFingerprint("wiola", "sekret", "signing-secret"), credentialFingerprint("wiola", "nowe", "signing-secret"));
});
