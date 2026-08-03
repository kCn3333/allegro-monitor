const ALARM = "allegro-monitor-tick";
const DEFAULT_BACKEND = "https://allegro-monitor.kcn333.com";
let checking = false;

async function state() {
  return chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND, token: "", watched: [], unread: [] });
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void checkDue(); });

function normalizeBackend(value) { return value.trim().replace(/\/$/, ""); }
async function api(path, options = {}) {
  const { backendUrl, token } = await state();
  if (!token) throw new Error("Rozszerzenie nie jest sparowane");
  const response = await fetch(`${normalizeBackend(backendUrl)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error((await response.text()) || `Błąd serwera ${response.status}`);
  return response.json();
}

async function pair(backendUrl, code) {
  const url = normalizeBackend(backendUrl || DEFAULT_BACKEND);
  const response = await fetch(`${url}/api/extension/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim().toUpperCase(), name: `Vivaldi ${navigator.platform}` })
  });
  if (!response.ok) throw new Error((await response.text()) || "Nie udało się sparować");
  const { token } = await response.json();
  await chrome.storage.local.set({ backendUrl: url, token });
  return true;
}

async function addCurrentTab(name, intervalMinutes) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://allegro.pl/listing")) throw new Error("Otwórz kartę z wynikami wyszukiwania Allegro");
  const created = await api("/api/extension/monitors", {
    method: "POST", body: JSON.stringify({ name: name.trim() || tab.title || "Allegro", url: tab.url, intervalMinutes })
  });
  const data = await state();
  const watched = data.watched.filter(item => item.monitorId !== created.id && item.url !== tab.url);
  watched.push({ monitorId: created.id, tabId: tab.id, url: tab.url, name: created.name, intervalMinutes, nextCheckAt: Date.now() });
  await chrome.storage.local.set({ watched });
  return created;
}

async function findTab(watch) {
  if (watch.tabId) {
    const tab = await chrome.tabs.get(watch.tabId).catch(() => null);
    if (tab) return tab;
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find(tab => tab.url === watch.url) || null;
}

function waitForLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Przekroczono czas ładowania karty")); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function extractListings() {
  const text = document.body?.innerText || "";
  if (/potwierd(?:ź|z).{0,40}(?:człowiekiem|czlowiekiem)|zostałeś zablokowany|zostales zablokowany|captcha/i.test(text)) {
    return { blocked: true, listings: [] };
  }
  const found = new Map();
  const anchors = [...document.querySelectorAll("a[href]")];
  const offerAnchors = anchors.filter(anchor => {
    try { return new URL(anchor.href, location.href).hostname.endsWith("allegro.pl") && new URL(anchor.href, location.href).pathname.includes("/oferta/"); }
    catch { return false; }
  });
  for (const anchor of offerAnchors) {
    const url = new URL(anchor.href, location.href);
    const href = url.href;
    const id = url.searchParams.get("offerId") || url.pathname.match(/-(\d{6,})(?:\/)?$/)?.[1] || url.pathname.match(/\/(\d{6,})(?:\/)?$/)?.[1];
    if (!id || found.has(id)) continue;
    const card = anchor.closest("article") || anchor.closest('[data-box-name="items-v3"] > div') || anchor.closest('[data-box-name]') || anchor.closest("section") || anchor.parentElement;
    const heading = card?.querySelector("h2, h3") || anchor.querySelector("h2, h3");
    const image = card?.querySelector("img") || anchor.querySelector("img");
    const title = (anchor.getAttribute("title") || anchor.getAttribute("aria-label") || heading?.textContent || image?.getAttribute("alt") || anchor.textContent || "").replace(/\s+/g, " ").trim();
    if (!title || /^przejdź|^przejdz$/i.test(title)) continue;
    const cardText = (card?.textContent || "").replace(/\s+/g, " ");
    const price = cardText.match(/\d[\d\s]*(?:[,.]\d{2})?\s*zł/i)?.[0]?.trim() || null;
    found.set(id, { externalId: id, title, url: href, price, imageUrl: image?.currentSrc || image?.src || null });
  }
  return {
    blocked: false,
    listings: [...found.values()],
    diagnostic: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      anchors: anchors.length,
      offerAnchors: offerAnchors.length,
      sampleHrefs: offerAnchors.slice(0, 3).map(anchor => anchor.href)
    }
  };
}

async function readListings(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  do {
    const execution = await chrome.scripting.executeScript({ target: { tabId }, func: extractListings });
    lastResult = execution[0]?.result;
    if (lastResult?.blocked || lastResult?.listings?.length) return lastResult;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  return lastResult;
}

function markNewOffers(ids) {
  const wanted = new Set(ids);
  for (const anchor of document.querySelectorAll('a[href*="/oferta/"]')) {
    const id = anchor.href.match(/(?:oferta\/[^/?#]*-|offerId=)(\d{6,})/i)?.[1];
    if (!id || !wanted.has(id)) continue;
    const card = anchor.closest("article") || anchor.closest('[data-box-name]') || anchor.parentElement;
    if (card) { card.style.outline = "3px solid #ff5a00"; card.style.outlineOffset = "3px"; }
  }
  if (ids.length && !document.title.startsWith(`[+${ids.length}]`)) document.title = `[+${ids.length}] ${document.title}`;
}

async function checkOne(watch) {
  const tab = await findTab(watch);
  if (!tab?.id) throw new Error(`Karta „${watch.name}” jest zamknięta`);
  watch.tabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const loaded = waitForLoad(tab.id);
  await chrome.tabs.reload(tab.id);
  await loaded;
  const result = await readListings(tab.id);
  if (!result) throw new Error("Nie udało się odczytać zawartości karty Allegro");
  if (result.blocked) {
    await chrome.notifications.create(`blocked-${watch.monitorId}`, { type: "basic", iconUrl: "icon-128.png", title: "Allegro wymaga uwagi", message: `Sprawdź kartę: ${watch.name}` });
    throw new Error("Captcha lub blokada w karcie Allegro");
  }
  if (!result.listings.length) {
    const details = result.diagnostic || {};
    throw new Error(`Nie znaleziono ofert (linki: ${details.anchors ?? 0}, linki ofert: ${details.offerAnchors ?? 0}, strona: ${details.title || details.url || "nieznana"})`);
  }
  const response = await api(`/api/extension/monitors/${watch.monitorId}/results`, { method: "POST", body: JSON.stringify({ listings: result.listings }) });
  const fresh = response.newListings || [];
  if (fresh.length) {
    const current = await state();
    const unread = [...fresh.map(item => ({ ...item, monitorName: watch.name, seenAt: new Date().toISOString() })), ...current.unread].slice(0, 100);
    await chrome.storage.local.set({ unread });
    await chrome.action.setBadgeBackgroundColor({ color: "#ff5a00" });
    await chrome.action.setBadgeText({ text: unread.length > 99 ? "+99" : `+${unread.length}` });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: markNewOffers, args: [fresh.map(item => item.externalId)] });
    const first = fresh[0];
    await chrome.notifications.create(`new-${watch.monitorId}-${Date.now()}`, { type: "basic", iconUrl: "icon-128.png", title: `${fresh.length === 1 ? "Nowa oferta" : `Nowe oferty (${fresh.length})`}: ${watch.name}`, message: `${first.title}${first.price ? ` — ${first.price}` : ""}` });
  }
  watch.nextCheckAt = Date.now() + watch.intervalMinutes * 60_000;
  return fresh.length;
}

async function checkDue(forceMonitorId = null) {
  if (checking) return;
  checking = true;
  try {
    const data = await state();
    if (!data.token) return;
    for (const watch of data.watched) {
      if (forceMonitorId !== null ? watch.monitorId !== forceMonitorId : watch.nextCheckAt > Date.now()) continue;
      try { await checkOne(watch); }
      catch (error) {
        watch.nextCheckAt = Date.now() + Math.max(watch.intervalMinutes, 10) * 60_000;
        await api(`/api/extension/monitors/${watch.monitorId}/error`, { method: "POST", body: JSON.stringify({ message: error.message }) }).catch(() => {});
        if (/captcha|blokada/i.test(error.message)) break;
      }
      await new Promise(resolve => setTimeout(resolve, 12000 + Math.random() * 10000));
    }
    await chrome.storage.local.set({ watched: data.watched });
  } finally { checking = false; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "pair") return pair(message.backendUrl, message.code);
    if (message.type === "add-current") return addCurrentTab(message.name, Number(message.intervalMinutes));
    if (message.type === "check") { await checkDue(message.monitorId ?? null); return true; }
    if (message.type === "remove") {
      const data = await state();
      await api(`/api/extension/monitors/${message.monitorId}`, { method: "DELETE" });
      await chrome.storage.local.set({ watched: data.watched.filter(item => item.monitorId !== message.monitorId) });
      return true;
    }
    if (message.type === "clear-unread") { await chrome.storage.local.set({ unread: [] }); await chrome.action.setBadgeText({ text: "" }); return true; }
    throw new Error("Nieznana operacja");
  })().then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

void ensureAlarm();
