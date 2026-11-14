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
import { icon } from "../../src/icons.js";

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

test("all panel button styles give hover feedback in both themes, including login and secondary actions", { timeout: 60000 }, async t => {
  const { page, store, monitor, login, visit } = await fixture(t);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const first = { externalId: "offer:123456", title: "Rzadka książka", url: "https://allegro.pl/oferta/book-123456", price: "20 zł", imageUrl: null };
  store.saveCheck(store.getMonitor(monitor)!, [first, { ...first, externalId: "offer:654321", title: "Inna książka" }]);
  store.addExclusion(monitor, first.externalId);
  const checkHover = async (control: ReturnType<Page["locator"]>) => {
    await page.mouse.move(0, 0);
    const before = await control.evaluate(el => {
      const style = getComputedStyle(el);
      return [style.backgroundColor, style.borderColor, style.color, style.boxShadow].join("|");
    });
    await control.hover();
    const after = await control.evaluate(el => {
      const style = getComputedStyle(el);
      return [style.backgroundColor, style.borderColor, style.color, style.boxShadow].join("|");
    });
    assert.notEqual(after, before, `hover feedback: ${await control.evaluate(el => el.outerHTML.slice(0, 160))}`);
  };
  await visit("/login");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await checkHover(page.getByRole("button", { name: "Zaloguj się" }));
  }
  await login();
  for (const theme of ["light", "dark"]) {
    for (const route of ["/", "/devices", "/extension", "/faq"]) {
      await visit(route);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const control of await page.locator("button, a.button, .github-link, summary").all()) {
        if (await control.isVisible() && await control.isEnabled()) await checkHover(control);
      }
      for (const rename of await page.locator(".rename").all()) {
        await rename.locator("summary").click();
        await checkHover(rename.getByRole("button", { name: "Zapisz" }));
        await rename.locator("summary").click();
      }
      if (route === "/") {
        await page.locator(".exclusions summary").click();
        await checkHover(page.getByRole("button", { name: "Przywróć", exact: true }));
        await page.mouse.move(0, 0);
        const track = page.locator(".switch span").first();
        const before = await track.evaluate(el => getComputedStyle(el).boxShadow);
        await page.locator(".switch").first().hover();
        assert.notEqual(await track.evaluate(el => getComputedStyle(el).boxShadow), before);
      }
    }
  }
});

test("panel refresh highlights only a checked monitor for 3.5 seconds and preserves open editing", { timeout: 30000 }, async t => {
  const { page, store, monitor, removable, login, visit } = await fixture(t);
  await login();
  await page.clock.install({ time: new Date("2026-11-14T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-14T12:00:01Z"));
  await visit("/");
  const card = page.locator(`[data-monitor-id="${monitor}"]`);
  const other = page.locator(`[data-monitor-id="${removable}"]`);
  assert.match(await page.locator(".about blockquote").innerText(), /specjalnie dla Wioli/);
  assert.equal(await page.locator(".about figcaption").innerText(), "kCn & Codex");
  const open = await card.getByRole("link", { name: "Otwórz Allegro" }).boundingBox();
  const remove = await card.getByRole("button", { name: "Usuń" }).boundingBox();
  assert.ok(open && remove && open.x < remove.x);
  assert.notEqual(await card.locator(".monitor-meta").evaluate(el => getComputedStyle(el).backgroundColor), await card.evaluate(el => getComputedStyle(el).backgroundColor));
  store.saveCheck(store.getMonitor(monitor)!, [
    { externalId: "offer:123456", title: "Rzadka książka", url: "https://allegro.pl/oferta/book-123456", price: "20 zł", imageUrl: null },
    { externalId: "offer:654321", title: "Nowa książka", url: "https://allegro.pl/oferta/book-654321", price: "25 zł", imageUrl: null }
  ]);
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === "/" && response.request().resourceType() === "fetch");
  await page.clock.fastForward(5000);
  await refresh;
  await card.locator(".check-feedback:visible").waitFor();
  assert.equal(await card.getAttribute("aria-busy"), "true");
  assert.equal(await other.getAttribute("aria-busy"), null);
  assert.equal(await card.getByRole("button", { name: "Usuń" }).isDisabled(), true);
  assert.equal(await card.locator(".switch input").isDisabled(), true);
  assert.equal(await card.getByRole("link", { name: "Otwórz Allegro" }).evaluate(el => (el as HTMLElement).inert), true);
  assert.equal(await page.getByRole("link", { name: "Nowa książka", exact: true }).count(), 1);
  await page.clock.fastForward(3499);
  assert.equal(await card.getAttribute("aria-busy"), "true");
  await page.clock.fastForward(1);
  assert.equal(await card.getAttribute("aria-busy"), null);
  assert.equal(await card.getByRole("button", { name: "Usuń" }).isDisabled(), false);
  assert.equal(await card.locator(".switch input").isDisabled(), false);
  assert.equal(await card.getByRole("link", { name: "Otwórz Allegro" }).evaluate(el => (el as HTMLElement).inert), false);
  await card.locator(".rename summary").click();
  await card.locator('input[name="name"]').fill("Niezapisana nazwa");
  store.renameMonitor(monitor, "Nazwa na serwerze");
  await page.clock.fastForward(10000);
  assert.equal(await card.locator('input[name="name"]').inputValue(), "Niezapisana nazwa");
});

test("popup exposes a persistent notification snooze switch with timed expiry and manual resume", { timeout: 30000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("https://popup.example/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1) || "popup.html";
    const types: Record<string, string> = { "popup.html": "text/html", "popup.css": "text/css", "popup.js": "text/javascript", "popup-icons.js": "text/javascript", "icon-128.png": "image/png" };
    if (file === "backend-config.js") return route.fulfill({ contentType: "text/javascript", body: 'export const BACKEND_URL = "https://monitor.example";' });
    if (file === "popup-icons.js") {
      const icons = Object.fromEntries((["panel", "eye", "bell", "pair", "add", "refresh", "trash", "external", "check"] as const).map(name => [name, icon(name)]));
      return route.fulfill({ contentType: "text/javascript", body: `export const icons = ${JSON.stringify(icons)};` });
    }
    if (!types[file]) return route.abort();
    return route.fulfill({ contentType: types[file], body: fs.readFileSync(path.join("extension", file)) });
  });
  await context.addInitScript({ content: `
    const data = JSON.parse(sessionStorage.getItem("popup-test-state") || JSON.stringify({ token: "existing-token", watched: [], unread: [], connection: "online", lastSyncAt: Date.now() - 60000, latestExtensionVersion: "1.1.9" }));
    window.chrome = {
      storage: { local: { get: async (defaults) => structuredClone({ ...defaults, ...data }) } },
      runtime: { getManifest: () => ({ version: "1.1.9" }), sendMessage: (message, respond) => {
        if (message.type === "snooze-notifications") {
          data.notificationSnooze = { duration: message.duration, until: !message.enabled ? 0 : message.duration === "forever" ? null : Date.now() + (message.duration === "day" ? 86400_000 : 3600_000) };
          sessionStorage.setItem("popup-test-state", JSON.stringify(data));
        }
        respond({ ok: true, result: true });
      } }
    };
` });
  await page.clock.install({ time: new Date("2026-11-14T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-14T12:00:01Z"));
  await page.goto("https://popup.example/popup.html");
  await page.locator('#connection[data-state="online"]').waitFor();
  assert.equal(await page.locator("#connection-label").innerText(), "Połączono");
  assert.match(await page.locator("#last-sync").innerText(), /Ostatnia synchronizacja:/);
  assert.ok(await page.locator("#last-sync").getAttribute("datetime"));
  assert.equal(await page.locator(".connection-dot").evaluate(el => getComputedStyle(el).animationName), "connection-pulse");
  for (const id of ["name", "interval"]) {
    const label = await page.locator(`label[for="${id}"] > span`).boundingBox();
    const input = await page.locator(`#${id}`).boundingBox();
    assert.ok(label && input && label.x < input.x && Math.abs(label.y + label.height / 2 - input.y - input.height / 2) < 1, `${id} label and field share a row`);
  }
  assert.equal(await page.locator(".popup-footer").innerText(), "kCn & Codex · dla Wioli 📚");
  assert.ok(await page.locator(".popup-footer").isVisible());
  const toggle = page.getByRole("switch", { name: "Uśpij powiadomienia" });
  const duration = page.getByLabel("Czas uśpienia");
  assert.equal(await toggle.isChecked(), false);
  assert.deepEqual(await duration.locator("option").allTextContents(), ["na godzinę", "na dobę", "do odwołania"]);
  await page.locator('label[for="snooze-enabled"]').click();
  await page.locator("#snooze-enabled:not(:disabled)").waitFor();
  await page.locator("#snooze-duration:disabled").waitFor();
  assert.equal(await duration.isDisabled(), true);
  await page.reload();
  assert.equal(await toggle.isChecked(), true);
  await page.clock.fastForward(3600_000);
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await duration.isDisabled(), false);
  await duration.selectOption("day");
  await page.locator('label[for="snooze-enabled"]').click();
  await page.locator("#snooze-enabled:not(:disabled)").waitFor();
  assert.match(await page.locator("#snooze-status").innerText(), /Uśpione do/);
  await page.locator('label[for="snooze-enabled"]').click();
  await page.locator("#snooze-enabled:not(:disabled)").waitFor();
  await duration.selectOption("forever");
  await page.locator('label[for="snooze-enabled"]').click();
  await page.locator("#snooze-enabled:not(:disabled)").waitFor();
  await page.clock.fastForward(365 * 86400_000);
  assert.equal(await toggle.isChecked(), true);
  assert.match(await page.locator("#snooze-status").innerText(), /do odwołania/);
  await page.locator('label[for="snooze-enabled"]').click();
  await page.locator("#snooze-enabled:not(:disabled)").waitFor();
  assert.equal(await toggle.isChecked(), false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".connection-dot").evaluate(el => getComputedStyle(el).animationName), "none");
  for (const connection of ["offline", "unauthorized"]) {
    await page.evaluate(connection => {
      const data = JSON.parse(sessionStorage.getItem("popup-test-state")!);
      data.connection = connection;
      sessionStorage.setItem("popup-test-state", JSON.stringify(data));
    }, connection);
    await page.reload();
    await page.locator(`#connection[data-state="${connection}"]`).waitFor();
    assert.notEqual(await page.locator("#connection-label").innerText(), "Połączono");
    assert.equal(await page.locator(".connection-dot").evaluate(el => getComputedStyle(el).animationName), "none");
    assert.ok(await page.locator("#last-sync").getAttribute("datetime"), "connection errors retain the date of the last successful sync");
  }
  assert.deepEqual(errors, []);
});

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
