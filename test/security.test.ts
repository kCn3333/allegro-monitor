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

test("compares both credential fields and handles different lengths", () => {
  assert.equal(safeCredentialsEqual("wiola", "sekret", "wiola", "sekret"), true);
  assert.equal(safeCredentialsEqual("wiola", "bledne", "wiola", "sekret"), false);
  assert.equal(safeCredentialsEqual("inna!", "sekret", "wiola", "sekret"), false);
  assert.equal(safeCredentialsEqual("wiola", "zle", "wiola", "sekret"), false);
  assert.equal(safeCredentialsEqual("w".repeat(10000), "sekret", "wiola", "sekret"), false);
  assert.equal(safeCredentialsEqual("wiola", "sekret", "w".repeat(10000), "sekret"), false);
  assert.equal(safeCredentialsEqual("ab", "c", "a", "bc"), false);
});

test("compares Unicode credentials without normalizing them", () => {
  assert.equal(safeCredentialsEqual("żółw📚", "密碼🔑", "żółw📚", "密碼🔑"), true);
  assert.equal(safeCredentialsEqual("żółw📚", "密碼🔒", "żółw📚", "密碼🔑"), false);
  assert.equal(safeCredentialsEqual("é", "hasło", "e\u0301", "hasło"), false);
});

test("compares empty credential fields without conflating them", () => {
  assert.equal(safeCredentialsEqual("", "", "", ""), true);
  assert.equal(safeCredentialsEqual("", "hasło", "", "hasło"), true);
  assert.equal(safeCredentialsEqual("login", "", "login", ""), true);
  assert.equal(safeCredentialsEqual("", "", "login", "hasło"), false);
  assert.equal(safeCredentialsEqual("", "x", "x", ""), false);
  assert.equal(safeCredentialsEqual("x", "", "", "x"), false);
});

test("distinguishes credential field boundaries containing NUL", () => {
  assert.equal(safeCredentialsEqual("a\0b", "c", "a\0b", "c"), true);
  assert.equal(safeCredentialsEqual("a", "b\0c", "a", "b\0c"), true);
  assert.equal(safeCredentialsEqual("a\0b", "c", "a", "b\0c"), false);
  assert.equal(safeCredentialsEqual("a", "b\0c", "a\0b", "c"), false);
});

test("binds sessions to current credentials", () => {
  assert.equal(tokenHash("token"), tokenHash("token"));
  assert.notEqual(credentialFingerprint("wiola", "sekret", "signing-secret"), credentialFingerprint("wiola", "nowe", "signing-secret"));
});
