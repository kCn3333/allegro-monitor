import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "playwright";
import { buildApp } from "../../src/server.js";
import { config } from "../../src/config.js";
import { Store } from "../../src/database.js";

const withoutTabs = process.env.ALLEGRO_EXTENSION_WITHOUT_TABS === "1";
const backendOrigin = "https://backend.test";
const searchUrl = "https://allegro.pl/listing?price_to=50&string=books";
interface Watched {
  monitorId: number;
  tabId: number | null;
  url: string;
  tabOpen: boolean;
}
interface ExtensionState {
  token: string;
  watched: Watched[];
  unread: Array<{ title: string }>;
}

async function state(popup: Page): Promise<ExtensionState> {
  return popup.evaluate(() => (globalThis as any).chrome.storage.local.get({ token: "", watched: [], unread: [] }));
}

async function waitForWatch(popup: Page, monitorId: number, tabId: number | null) {
  const deadline = Date.now() + 10_000;
  do {
    const watch = (await state(popup)).watched.find((item) => item.monitorId === monitorId);
    if (watch?.tabId === tabId && watch.tabOpen === (tabId !== null)) return watch;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`Monitor ${monitorId} did not reach expected tab ID ${tabId}`);
}

async function popupMessage(popup: Page, text: string) {
  await popup.waitForFunction((expected) => document.querySelector("#message")?.textContent === expected, text);
}

async function sync(popup: Page) {
  await popup.locator('[data-tab="watched"]').click();
  await popup.locator("#sync").click();
  await popupMessage(popup, "Lista odświeżona");
}

// The exact same lifecycle can be run diagnostically against a disposable manifest without tabs.
// The default, production-permissions variant is mandatory in test:browser and CI.
test(`loaded MV3 lifecycle (${withoutTabs ? "diagnostic without tabs" : "production permissions"})`, {
  timeout: 120_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-loaded-extension-"));
  const unpacked = path.join(directory, "extension");
  const profile = path.join(directory, "profile");
  let context: BrowserContext | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let store: Store | undefined;
  const sockets = new Set<import("node:net").Socket>();
  // Fail closed even for browser/worker traffic that does not pass through Playwright routing.
  const proxy = http.createServer((_request, response) => response.writeHead(502).end());
  proxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    try {
      await context?.close();
    } finally {
      try {
        try {
          store?.close();
        } finally {
          await app?.close();
        }
      } finally {
        for (const socket of sockets) socket.destroy();
        if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as import("node:net").AddressInfo).port;
  const settings = {
    ...config,
    publicUrl: backendOrigin,
    extensionDirectory: path.resolve("extension"),
    databasePath: path.join(directory, "db.sqlite"),
    username: "",
    password: "",
    sessionSecret: "loaded-extension-test-secret".repeat(2),
    trustProxy: false as const,
    telegramBotToken: "",
    telegramChatIds: [],
  };
  app = await buildApp({ config: settings, startWorker: false });
  const localOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
  store = new Store(settings.databasePath);
  const archiveResponse = await fetch(`${localOrigin}/extension/download`);
  assert.equal(archiveResponse.status, 200);
  const archive = path.join(directory, "extension.zip");
  fs.writeFileSync(archive, Buffer.from(await archiveResponse.arrayBuffer()));
  execFileSync("unzip", ["-q", archive, "-d", unpacked]);
  const originalManifest = fs.readFileSync("extension/manifest.json", "utf8");
  const manifestPath = path.join(unpacked, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.version, JSON.parse(originalManifest).version);
  assert.deepEqual(manifest.permissions, JSON.parse(originalManifest).permissions);
  assert.equal(
    fs.readFileSync(path.join(unpacked, "service-worker.js"), "utf8"),
    fs.readFileSync("extension/service-worker.js", "utf8"),
  );
  assert.equal(
    fs.readFileSync(path.join(unpacked, "backend-config.js"), "utf8"),
    `export const BACKEND_URL = "${backendOrigin}";\n`,
  );
  if (withoutTabs) {
    manifest.permissions = manifest.permissions.filter((permission: string) => permission !== "tabs");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  const calls: Array<{ path: string; worker: boolean }> = [];
  const visits = new Map<string, number>();
  const blocked: string[] = [];
  let offerIds = [111111];
  const syntheticHosts = new Set([
    "allegro.pl",
    "www.allegro.pl",
    "nested.shop.allegro.pl",
    "foreign.test",
    "allegro.pl.evil.test",
  ]);
  async function launch() {
    let releaseBackend!: () => void;
    const networkReady = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
      args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
    });
    context.setDefaultTimeout(10_000);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.protocol === "chrome-extension:") {
        await route.continue();
      } else if (url.origin === backendOrigin) {
        await networkReady;
        // Transport the real extension request to the real local application, not a mock API response.
        const headers = request.headers();
        const response = await fetch(`${localOrigin}${url.pathname}${url.search}`, {
          method: request.method(),
          headers: {
            "content-type": headers["content-type"] || "application/json",
            authorization: headers.authorization || "",
          },
          body: request.postData() || undefined,
          signal: AbortSignal.timeout(10_000),
        });
        calls.push({ path: url.pathname, worker: Boolean(request.serviceWorker()) });
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      } else if (syntheticHosts.has(url.hostname) && ["https:", "http:"].includes(url.protocol)) {
        visits.set(url.href, (visits.get(url.href) || 0) + 1);
        await route.fulfill({
          contentType: "text/html",
          body: `<title>Synthetic search</title>${offerIds.map((id) => `<article id="offer-${id}"><a href="https://allegro.pl/oferta/book-${id}" title="Book ${id}">Book ${id}</a><span>10 zł</span></article>`).join("")}`,
        });
      } else {
        blocked.push(url.href);
        await route.abort();
      }
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
    assert.match(worker.url(), /^chrome-extension:\/\/[a-z]+\/service-worker\.js$/);
    const id = new URL(worker.url()).hostname;
    // Read the native persisted state before startup presence can restore monitors from the backend.
    const persisted: ExtensionState = await worker
      .evaluate(() => (globalThis as any).chrome.storage.local.get({ token: "", watched: [], unread: [] }))
      .finally(releaseBackend);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const permissions = await popup.evaluate(() => (globalThis as any).chrome.runtime.getManifest().permissions);
    assert.equal(permissions.includes("tabs"), !withoutTabs);
    return { popup, id, persisted };
  }
  let { popup, id: extensionId } = await launch();
  t.diagnostic(`Chromium ${context!.browser()!.version()}; tabs permission: ${!withoutTabs}`);
  const pages: Page[] = [];
  let token = "";
  let monitored: Watched[] = [];
  let rootId = 0;

  await t.test("pair through packaged popup and add the actual active Allegro tab", async () => {
    const response = await fetch(`${localOrigin}/api/extension/pairing-code`, { method: "POST" });
    const { code } = (await response.json()) as { code: string };
    await popup.locator("#code").fill(code);
    await popup.locator("#pair").click();
    await popupMessage(popup, "Połączono");
    token = (await state(popup)).token;
    assert.ok(token.length > 20);
    assert.equal(store!.listExtensionClients().length, 1);
    const page = await context!.newPage();
    await page.goto(searchUrl);
    pages.push(page);
    await popup.locator("#name").fill("Books");
    await popup.locator("#interval").selectOption("60");
    await page.bringToFront();
    // Dispatch on the real popup DOM without focusing its tab instead of the Allegro tab.
    await popup.locator("#add").dispatchEvent("click");
    await popupMessage(popup, "Karta jest monitorowana");
    const [watch] = (await state(popup)).watched;
    assert.equal(watch!.url, searchUrl);
    assert.ok(watch!.tabId);
    rootId = watch!.monitorId;
    assert.equal(store!.getMonitor(rootId)!.url, searchUrl);
    assert.ok(calls.some((call) => call.path === "/api/extension/pair" && call.worker));
    assert.ok(calls.some((call) => call.path === "/api/extension/monitors" && call.worker));
  });

  await t.test("synchronize multiple tabs with exact filters, pagination and subdomains", async () => {
    const urls = [
      searchUrl.replace("price_to=50", "price_to=100"),
      searchUrl + "&p=2",
      searchUrl.replace("allegro.pl", "www.allegro.pl"),
      searchUrl.replace("allegro.pl", "nested.shop.allegro.pl"),
    ].map((value) => {
      const url = new URL(value);
      url.searchParams.sort();
      return url.toString();
    });
    for (const [index, url] of urls.entries()) {
      const page = await context!.newPage();
      await page.goto(url);
      pages.push(page);
      await popup.locator('[data-tab="home"]').click();
      await popup.locator("#name").fill(`Books ${index}`);
      await page.bringToFront();
      await popup.locator("#add").dispatchEvent("click");
      await popupMessage(popup, "Karta jest monitorowana");
    }
    for (const url of [
      searchUrl.replace("allegro.pl", "foreign.test"),
      searchUrl.replace("allegro.pl", "allegro.pl.evil.test"),
      searchUrl.replace("https://allegro.pl", "http://foreign.test"),
    ]) {
      const page = await context!.newPage();
      await page.goto(url);
    }
    await sync(popup);
    monitored = (await state(popup)).watched;
    assert.equal(monitored.length, 5);
    assert.ok(monitored.every((watch) => watch.tabOpen && watch.tabId));
    assert.equal(new Set(monitored.map((watch) => watch.tabId)).size, 5);
    assert.ok(store!.listMonitors().every((monitor) => monitor.activeClientsCount === 1));
    for (const index of [1, 2, 3]) await pages[index]!.goto(pages[index]!.url() + "&p=9");
    await sync(popup);
    const changed = (await state(popup)).watched;
    for (const index of [1, 2, 3]) assert.equal(changed.find((watch) => watch.url === urls[index - 1])!.tabOpen, false);
    assert.equal(changed.find((watch) => watch.monitorId === rootId)!.tabOpen, true);
    for (const index of [1, 2, 3]) await pages[index]!.goto(urls[index - 1]!);
    await sync(popup);
    assert.ok((await state(popup)).watched.every((watch) => watch.tabOpen));
  });

  await t.test("reload, extract baseline and new offers, submit results and highlight only new cards", async () => {
    const page = pages[0]!;
    const before = visits.get(searchUrl)!;
    const check = async () => {
      await popup.locator(`[data-check="${rootId}"]`).click();
      await popupMessage(popup, "Sprawdzono");
    };
    await check();
    assert.equal(visits.get(searchUrl), before + 1, "worker really reloads the tab");
    assert.equal(store!.getMonitor(rootId)!.currentListingsCount, 1);
    assert.equal(store!.getMonitor(rootId)!.lastCheckNewCount, 0, "baseline is not a new offer");
    offerIds = [111111, 222222];
    await check();
    assert.equal(visits.get(searchUrl), before + 2);
    assert.equal(store!.getMonitor(rootId)!.currentListingsCount, 2);
    assert.equal(store!.getMonitor(rootId)!.lastCheckNewCount, 1);
    assert.equal(
      await page.locator("#offer-222222").evaluate((element) => (element as HTMLElement).style.outlineWidth),
      "3px",
    );
    assert.equal(
      await page.locator("#offer-111111").evaluate((element) => (element as HTMLElement).style.outlineWidth),
      "",
    );
    assert.equal(await page.title(), "[+1] Synthetic search");
    assert.deepEqual(
      (await state(popup)).unread.map((offer) => offer.title),
      ["Book 222222"],
    );
    assert.ok(calls.some((call) => call.path === `/api/extension/monitors/${rootId}/results` && call.worker));
    assert.ok(calls.some((call) => call.path === "/api/extension/notifications/ack" && call.worker));
  });

  await t.test("tab events report closure and recover the same search with a different native tab ID", async () => {
    const original = (await state(popup)).watched.find((watch) => watch.monitorId === rootId)!;
    await pages[0]!.close();
    await waitForWatch(popup, rootId, null);
    assert.equal(
      store!.listMonitors().find((monitor) => monitor.id === rootId)!.activeClientsCount,
      0,
      "foreign, HTTP and subdomain tabs cannot replace this search",
    );
    const replacement = await context!.newPage();
    await replacement.goto("https://allegro.pl/listing?string=books&price_to=50#restored");
    const replacementId = await popup.evaluate(async (url) => {
      const tabs = await (globalThis as any).chrome.tabs.query({ url: ["https://allegro.pl/*"] });
      return tabs.find((tab: { id: number; url: string }) => tab.url === url)?.id;
    }, replacement.url());
    assert.ok(replacementId);
    assert.notEqual(replacementId, original.tabId, "new page has a different native ID");
    const recovered = await waitForWatch(popup, rootId, replacementId);
    assert.notEqual(recovered.tabId, original.tabId);
    assert.equal(recovered.url, searchUrl);
    assert.equal(store!.listMonitors().find((monitor) => monitor.id === rootId)!.activeClientsCount, 1);
  });

  await t.test("restart Chromium with the same isolated profile retains token and monitors", async () => {
    const before = await state(popup);
    await context!.close();
    context = undefined;
    const restarted = await launch();
    popup = restarted.popup;
    assert.equal(restarted.id, extensionId);
    assert.equal(restarted.persisted.token, token);
    assert.deepEqual(
      restarted.persisted.watched.map(({ monitorId, url }) => ({ monitorId, url })),
      before.watched.map(({ monitorId, url }) => ({ monitorId, url })),
      "monitors must be persisted before any startup response from the backend",
    );
    await popup.locator("#connected").waitFor();
    await sync(popup);
    const after = await state(popup);
    assert.equal(after.token, token);
    assert.deepEqual(
      after.watched.map(({ monitorId, url }) => ({ monitorId, url })),
      before.watched.map(({ monitorId, url }) => ({ monitorId, url })),
    );
    assert.equal(store!.listExtensionClients().length, 1, "restart must not pair a new client");
    assert.equal(calls.filter((call) => call.path === "/api/extension/pair").length, 1);
    assert.deepEqual(blocked, [], "unexpected browser requests are blocked, never sent to the internet");
    assert.equal(fs.readFileSync("extension/manifest.json", "utf8"), originalManifest);
  });
});
