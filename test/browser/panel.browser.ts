import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { buildApp } from "../../src/server.js";
import { config } from "../../src/config.js";
import { Store } from "../../src/database.js";
import { tokenHash } from "../../src/security.js";

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-panel-browser-"));
  const settings = { ...config, databasePath: path.join(directory, "db.sqlite"), username: "owner",
    password: "test-password", sessionSecret: "s".repeat(32), telegramBotToken: "", publicUrl: "" };
  const store = new Store(settings.databasePath);
  const monitor = store.createMonitor("Rzadkie książki", "https://allegro.pl/listing?string=book", 5);
  const removable = store.createMonitor("Do usunięcia", "https://allegro.pl/listing?string=other", 15);
  store.saveCheck(store.getMonitor(monitor)!, [{ externalId: "offer:123456", title: "Rzadka książka",
    url: "https://allegro.pl/oferta/book-123456", price: "20 zł", imageUrl: null }]);
  const first = store.addExtensionClient("Pierwsze urządzenie", tokenHash("first-token"));
  store.addExtensionClient("Drugie urządzenie", tokenHash("second-token"));
  const app = await buildApp({ config: settings, startWorker: false });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch();
  const context = await browser.newContext({ colorScheme: "dark" });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => console.error("CSP violation:", event.violatedDirective));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /CSP|Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text());
  });
  t.after(async () => {
    await browser.close();
    await app.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], "No browser errors or CSP violations");
  });
  async function visit(route: string) {
    const response = await page.goto(base + route);
    assert.equal(response?.status(), 200);
    const csp = response!.headers()["content-security-policy"]!;
    assert.ok(csp.includes("script-src 'self';"));
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline';"));
    assert.ok(!csp.includes("unsafe-eval"));
    assert.equal(await page.locator("script:not([src])").count(), 0);
    assert.equal(await page.locator("*").evaluateAll(elements => elements.some(element =>
      [...element.attributes].some(attribute => /^on/i.test(attribute.name)))), false);
  }
  async function login() {
    await visit("/login");
    await page.getByLabel("Użytkownik").fill(settings.username);
    await page.getByLabel("Hasło", { exact: true }).fill(settings.password);
    await Promise.all([page.waitForURL(base + "/"), page.getByRole("button", { name: "Zaloguj się" }).click()]);
  }
  return { page, context, store, monitor, removable, first, base, visit, login };
}

async function confirmSubmit(page: Page, selector: string, accept: boolean, message: RegExp) {
  const dialog = page.waitForEvent("dialog");
  const click = page.locator(selector).click();
  const confirmation = await dialog;
  assert.equal(confirmation.type(), "confirm");
  assert.match(confirmation.message(), message);
  const navigation = accept ? page.waitForNavigation() : null;
  await (accept ? confirmation.accept() : confirmation.dismiss());
  await click;
  if (navigation) await navigation;
}

test("strict CSP preserves theme, login, navigation, icons and pairing", { timeout: 30000 }, async t => {
  const { page, context, visit, login, base, store } = await fixture(t);
  await visit("/login");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.locator(".logo").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
  await login();
  assert.equal(await page.locator('[data-theme-icon="sun"]').isVisible(), true);
  await page.getByRole("button", { name: "Włącz jasny motyw" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.locator('[data-theme-icon="moon"]').isVisible(), true);
  for (const route of ["/", "/devices", "/extension", "/faq"]) {
    await visit(route);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    assert.equal(await page.getByRole("button", { name: "Włącz ciemny motyw" }).getAttribute("title"), "Włącz ciemny motyw");
  }
  await page.locator(".questions summary").first().click();
  assert.equal(await page.locator(".questions details").first().getAttribute("open"), "");
  await visit("/extension");
  await page.getByRole("button", { name: "Wygeneruj kod parowania" }).click();
  await page.waitForFunction(() => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.getElementById("code")?.textContent || ""));
  const code = await page.locator("#code").innerText();
  const paired = await context.request.post(base + "/api/extension/pair", { data: { code, name: "Z przeglądarki" } });
  assert.equal(paired.status(), 200);
  assert.ok(store.listExtensionClients().some(device => device.name === "Z przeglądarki"));
  await Promise.all([page.waitForURL(base + "/login"), page.getByRole("button", { name: "Wyloguj" }).click()]);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
});

test("monitor forms toggle and rename; confirmation cancellation never submits mutations", { timeout: 30000 }, async t => {
  const { page, store, monitor, removable, visit, login } = await fixture(t);
  await login();
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  const toggle = `.toggle-form[action="/monitors/${monitor}/toggle"] input`;
  await Promise.all([page.waitForNavigation(), page.locator(toggle).uncheck({ force: true })]);
  assert.equal(store.getMonitor(monitor)?.enabled, 0);
  await Promise.all([page.waitForNavigation(), page.locator(toggle).check({ force: true })]);
  assert.equal(store.getMonitor(monitor)?.enabled, 1);
  const rename = page.locator(`form[action="/monitors/${monitor}/rename"]`);
  await rename.locator("..").locator("summary").click();
  await rename.locator('input[name="name"]').fill("Nowa nazwa");
  await Promise.all([page.waitForNavigation(), rename.getByRole("button", { name: "Zapisz" }).click()]);
  assert.equal(store.getMonitor(monitor)?.name, "Nowa nazwa");
  const before = posts.length;
  await confirmSubmit(page, `form[action="/monitors/${removable}/delete"] button`, false, /Usunąć monitor/);
  assert.ok(store.getMonitor(removable));
  await confirmSubmit(page, ".exclude-form button", false, /Ta dokładna pozycja/);
  assert.equal(store.listExclusions().length, 0);
  assert.equal(posts.length, before);
  await confirmSubmit(page, ".exclude-form button", true, /Ta dokładna pozycja/);
  assert.equal(store.listExclusions().length, 1);
  await page.locator(".exclusions summary").click();
  await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Przywróć", exact: true }).click()]);
  assert.equal(store.listExclusions().length, 0);
  await confirmSubmit(page, `form[action="/monitors/${removable}/delete"] button`, true, /Usunąć monitor/);
  assert.equal(store.getMonitor(removable), undefined);
  await visit("/");
});

test("device confirmations survive refresh, preserve editing and cancel or submit correctly", { timeout: 30000 }, async t => {
  const { page, store, first, visit, login } = await fixture(t);
  await login();
  await page.clock.install();
  await visit("/devices");
  const rename = page.locator(`form[action="/devices/${first}/rename"]`);
  await rename.locator("..").locator("summary").click();
  await rename.getByRole("textbox", { name: "Nazwa urządzenia" }).fill("Edytowana nazwa");
  await page.clock.fastForward(60000);
  assert.equal(await rename.getByRole("textbox").inputValue(), "Edytowana nazwa");
  await Promise.all([page.waitForNavigation(), rename.getByRole("button", { name: "Zapisz" }).click()]);
  assert.equal(store.listExtensionClients().find(device => device.id === first)?.name, "Edytowana nazwa");
  store.renameExtensionClient(first, "Odświeżone urządzenie");
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === "/devices" && response.request().resourceType() === "fetch");
  await page.clock.fastForward(60000);
  await refresh;
  await page.getByRole("heading", { name: "Odświeżone urządzenie" }).waitFor();
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(request.url()); });
  await confirmSubmit(page, `form[action="/devices/${first}/revoke"] button`, false, /Odłączyć to urządzenie/);
  await confirmSubmit(page, 'form[action="/devices/revoke-all"] button', false, /Odłączyć wszystkie urządzenia/);
  assert.equal(store.listExtensionClients().length, 2);
  assert.deepEqual(posts, []);
  await confirmSubmit(page, `form[action="/devices/${first}/revoke"] button`, true, /Odłączyć to urządzenie/);
  assert.equal(store.listExtensionClients().length, 1);
  await confirmSubmit(page, 'form[action="/devices/revoke-all"] button', true, /Odłączyć wszystkie urządzenia/);
  assert.equal(store.listExtensionClients().length, 0);
});
