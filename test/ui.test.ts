import assert from "node:assert/strict";
import test from "node:test";
import { renderLogin } from "../src/ui.js";

test("renders the personalized login panel and remember-me control", () => {
  const html = renderLogin();
  assert.match(html, /Cześć, Wioluś :\*/);
  assert.match(html, /zechcesz się zalogować\?/);
  assert.match(html, /name="remember"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.doesNotMatch(html, /Nieprawidłowa nazwa/);
  assert.match(renderLogin(true), /Nieprawidłowa nazwa/);
});
