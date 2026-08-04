import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginRequest } from "../src/security.js";

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
