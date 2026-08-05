const ALARM = "allegro-monitor-tick";
const DEFAULT_BACKEND = "https://allegro-monitor.kcn333.com";
let checking = false;
let presenceTimer = null;

async function state() {
  return chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND, token: "", watched: [], unread: [] });
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  await updateActionBadge();
}

async function updateActionBadge() {
  const { unread } = await state();
  await chrome.action.setBadgeBackgroundColor({ color: "#187a45" });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});
  await chrome.action.setBadgeText({ text: unread.length ? (unread.length > 99 ? "+99" : `+${unread.length}`) : "" });
}

async function initialize() { await ensureAlarm(); await reportPresence(); }
chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void tick(); });

function schedulePresence() {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => { presenceTimer = null; void reportPresence(); }, 500);
}

chrome.tabs.onRemoved.addListener(schedulePresence);
chrome.tabs.onCreated.addListener(schedulePresence);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => { if (changeInfo.status === "complete" || changeInfo.url) schedulePresence(); });

function normalizeBackend(value) { return value.trim().replace(/\/$/, ""); }
function isAllegroResultsPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith("allegro.pl")
      && (url.pathname === "/listing" || url.pathname.startsWith("/kategoria/"));
  } catch { return false; }
}

function canonicalSearchUrl(value) {
  try {
    const url = new URL(value);
    if (!isAllegroResultsPage(value) || !url.searchParams.get("string")) return null;
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

function matchesWatch(tabUrl, watchUrl) {
  const tabCanonical = canonicalSearchUrl(tabUrl);
  const watchCanonical = canonicalSearchUrl(watchUrl);
  return Boolean(tabCanonical && watchCanonical && tabCanonical === watchCanonical);
}

function searchTerm(value) {
  try { return new URL(value).searchParams.get("string")?.replace(/\s+/g, " ").trim().toLocaleLowerCase("pl") || null; }
  catch { return null; }
}

function findMatchingTab(tabs, watch) {
  const wantedTerm = searchTerm(watch.url);
  const knownTab = tabs.find(tab => tab.id === watch.tabId && tab.url && isAllegroResultsPage(tab.url)
    && (!searchTerm(tab.url) || searchTerm(tab.url) === wantedTerm));
  if (knownTab) return knownTab;
  const exact = tabs.find(tab => tab.url && matchesWatch(tab.url, watch.url));
  if (exact) return exact;
  const sameTerm = tabs.filter(tab => tab.url && wantedTerm && searchTerm(tab.url) === wantedTerm && canonicalSearchUrl(tab.url));
  return sameTerm.length === 1 ? sameTerm[0] : null;
}

async function resolveSearchUrl(tab) {
  if (canonicalSearchUrl(tab.url)) return tab.url;
  if (!tab.id || !isAllegroResultsPage(tab.url)) return null;
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const input = document.querySelector('input[name="string"], input[type="search"], input[data-role*="search"], input[placeholder*="Szukaj" i]');
      const term = input?.value?.trim() || "";
      const urls = [location.href, document.querySelector('link[rel="canonical"]')?.href,
        document.querySelector('meta[property="og:url"]')?.content,
        ...[...document.querySelectorAll('a[href*="string="]')].slice(0, 20).map(anchor => anchor.href)].filter(Boolean);
      return { term, urls };
    }
  }).catch(() => [{ result: null }]);
  const candidates = result?.urls || [];
  const matching = candidates.find(value => canonicalSearchUrl(value) && (!result.term || searchTerm(value) === result.term.toLocaleLowerCase("pl")));
  if (matching) return matching;
  if (!result?.term) return null;
  const reconstructed = new URL(tab.url);
  reconstructed.searchParams.set("string", result.term);
  return reconstructed.toString();
}
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
  const searchUrl = tab ? await resolveSearchUrl(tab) : null;
  if (!tab?.id || !searchUrl) throw new Error("Otwórz kartę z wynikami wyszukiwania Allegro");
  const created = await api("/api/extension/monitors", {
    method: "POST", body: JSON.stringify({ name: name.trim() || tab.title || "Allegro", url: searchUrl, intervalMinutes })
  });
  const data = await state();
  const watched = data.watched.filter(item => item.monitorId !== created.id && item.url !== searchUrl);
  watched.push({ monitorId: created.id, tabId: tab.id, url: searchUrl, name: created.name, intervalMinutes, newListingsCount: created.newListingsCount || 0, lastCheckNewCount: created.lastCheckNewCount || 0, nextCheckAt: Date.now() });
  await chrome.storage.local.set({ watched });
  return created;
}

async function findTab(watch) {
  const tabs = await chrome.tabs.query({});
  return findMatchingTab(tabs, watch);
}

async function reportPresence() {
  const data = await state();
  if (!data.token) return null;
  const tabs = await chrome.tabs.query({});
  const monitors = data.watched.map(watch => {
    const tab = findMatchingTab(tabs, watch);
    watch.tabId = tab?.id || null;
    watch.tabOpen = Boolean(tab);
    return { id: watch.monitorId, open: watch.tabOpen };
  });
  const response = await api("/api/extension/presence", { method: "POST", body: JSON.stringify({ monitors }) }).catch(() => null);
  if (!response?.monitors) return null;
  const localById = new Map(data.watched.map(watch => [watch.monitorId, watch]));
  const watched = response.monitors.map(monitor => {
    const local = localById.get(monitor.id) || {};
    const tab = findMatchingTab(tabs, { ...local, url: monitor.url });
    return { ...local, monitorId: monitor.id, name: monitor.name, url: monitor.url,
      intervalMinutes: monitor.intervalMinutes, enabled: monitor.enabled,
      notificationsEnabled: monitor.notificationsEnabled,
      newListingsCount: monitor.newListingsCount, lastCheckNewCount: monitor.lastCheckNewCount,
      activeClientsCount: monitor.activeClientsCount, tabId: tab?.id || null, tabOpen: Boolean(tab),
      nextCheckAt: local.nextCheckAt ?? Date.now() };
  });
  const incoming = Array.isArray(response.notifications) ? response.notifications : [];
  const current = await state();
  const knownEvents = new Set(current.unread.map(item => item.eventId).filter(Boolean));
  const freshNotifications = incoming.filter(item => !knownEvents.has(item.eventId));
  const unread = [...freshNotifications.map(item => ({ ...item, seenAt: new Date().toISOString() })), ...current.unread].slice(0, 100);
  await chrome.storage.local.set({ watched, unread });
  if (freshNotifications.length) {
    const first = freshNotifications[0];
    await chrome.notifications.create(`event-${first.eventId}`, {
      type: "basic", iconUrl: "icon-128.png",
      title: freshNotifications.length === 1 ? `Nowa oferta: ${first.monitorName}` : `Nowe oferty (${freshNotifications.length})`,
      message: `${first.title}${first.price ? ` — ${first.price}` : ""}`
    });
  }
  await updateActionBadge();
  return response;
}

async function tick() {
  await reportPresence();
  await checkDue();
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
  function findProductImage(card, anchor) {
    const candidates = [...new Set([...(anchor?.querySelectorAll("img") || []), ...(card?.querySelectorAll("img") || [])])];
    return candidates.map(image => {
      const src = image.currentSrc || image.src || "";
      const description = `${image.alt || ""} ${image.getAttribute("aria-label") || ""} ${image.className || ""} ${src}`;
      if (!src || /^data:/i.test(src) || /\.svg(?:[?#]|$)|serce|heart|favorite|favourite|polub|ulubion|smart|logo|icon/i.test(description)) return null;
      const width = image.naturalWidth || image.width || Number(image.getAttribute("width")) || 0;
      const height = image.naturalHeight || image.height || Number(image.getAttribute("height")) || 0;
      if (width > 0 && height > 0 && width <= 80 && height <= 80) return null;
      let score = Math.min(width * height, 1_000_000);
      if (/allegroimg\.com/i.test(src)) score += 2_000_000;
      if (anchor?.contains(image)) score += 500_000;
      if (image.closest("picture")) score += 100_000;
      if (image.alt?.trim()) score += 10_000;
      return { image, score };
    }).filter(Boolean).sort((left, right) => right.score - left.score)[0]?.image || null;
  }
  const anchors = [...document.querySelectorAll("a[href]")];
  const offerAnchors = anchors.filter(anchor => {
    try {
      const url = new URL(anchor.href, location.href);
      return url.hostname.endsWith("allegro.pl") && (/^\/oferta\//.test(url.pathname) || /^\/produkt\//.test(url.pathname));
    }
    catch { return false; }
  });
  for (const anchor of offerAnchors) {
    const url = new URL(anchor.href, location.href);
    const href = url.href;
    const numericId = url.searchParams.get("offerId") || url.pathname.match(/-(\d{6,})(?:\/)?$/)?.[1] || url.pathname.match(/\/(\d{6,})(?:\/)?$/)?.[1];
    const productId = url.pathname.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/)?$/i)?.[1];
    const id = numericId ? `offer:${numericId}` : productId ? `product:${productId.toLowerCase()}` : null;
    if (!id || found.has(id)) continue;
    const card = anchor.closest("article") || anchor.closest('[data-box-name="items-v3"] > div') || anchor.closest('[data-box-name]') || anchor.closest("section") || anchor.parentElement;
    const heading = card?.querySelector("h2, h3") || anchor.querySelector("h2, h3");
    const image = findProductImage(card, anchor);
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
  for (const anchor of document.querySelectorAll('a[href*="/oferta/"], a[href*="/produkt/"]')) {
    let url;
    try { url = new URL(anchor.href, location.href); } catch { continue; }
    const numericId = url.searchParams.get("offerId") || url.pathname.match(/-(\d{6,})(?:\/)?$/)?.[1] || url.pathname.match(/\/(\d{6,})(?:\/)?$/)?.[1];
    const productId = url.pathname.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/)?$/i)?.[1];
    const id = numericId ? `offer:${numericId}` : productId ? `product:${productId.toLowerCase()}` : null;
    if (!id || !wanted.has(id)) continue;
    const card = anchor.closest("article") || anchor.closest('[data-box-name]') || anchor.parentElement;
    if (card) { card.style.outline = "3px solid #d8612c"; card.style.outlineOffset = "3px"; }
  }
  if (ids.length && !document.title.startsWith(`[+${ids.length}]`)) document.title = `[+${ids.length}] ${document.title}`;
}

async function checkOne(watch) {
  const tab = await findTab(watch);
  if (!tab?.id) throw new Error(`Karta „${watch.name}” jest zamknięta`);
  watch.tabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const loaded = waitForLoad(tab.id);
  if (canonicalSearchUrl(tab.url)) await chrome.tabs.reload(tab.id);
  else await chrome.tabs.update(tab.id, { url: watch.url });
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
  watch.newListingsCount = Number(response.newListingsCount) || 0;
  watch.lastCheckNewCount = Number(response.lastCheckNewCount) || 0;
  if (fresh.length) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: markNewOffers, args: [fresh.map(item => item.externalId)] });
    await reportPresence();
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
      if (watch.enabled === false || watch.tabOpen === false) continue;
      if (forceMonitorId !== null ? watch.monitorId !== forceMonitorId : watch.nextCheckAt > Date.now()) continue;
      try { await checkOne(watch); }
      catch (error) {
        watch.nextCheckAt = Date.now() + Math.max(watch.intervalMinutes, 10) * 60_000;
        if (/jest zamknięta/i.test(error.message)) await reportPresence();
        else await api(`/api/extension/monitors/${watch.monitorId}/error`, { method: "POST", body: JSON.stringify({ message: error.message }) }).catch(() => {});
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
    if (message.type === "check") { await reportPresence(); await checkDue(message.monitorId ?? null); return true; }
    if (message.type === "sync") { await reportPresence(); return true; }
    if (message.type === "notification-state") {
      await api(`/api/extension/monitors/${message.monitorId}/notification-state`, { method: "POST", body: JSON.stringify({ enabled: message.enabled === true }) });
      await reportPresence();
      return true;
    }
    if (message.type === "clear-unread") { await chrome.storage.local.set({ unread: [] }); await updateActionBadge(); return true; }
    throw new Error("Nieznana operacja");
  })().then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

void initialize();
