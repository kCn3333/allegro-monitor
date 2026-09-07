const ALARM = "allegro-monitor-tick";
const DEFAULT_BACKEND = "https://allegro-monitor.kcn333.com";
let checking = false;
let presenceTimer = null;
let writes = Promise.resolve();
let synchronization = Promise.resolve();
// Only this service worker writes storage. Never hold the storage queue across network I/O.
function mutateState(update) {
  const operation = writes.then(async () => {
    const current = await state();
    const patch = update(current);
    await chrome.storage.local.set(patch);
    return patch;
  });
  writes = operation.catch(() => {});
  return operation;
}
function synchronize(operation) {
  const pending = synchronization.then(operation);
  synchronization = pending.catch(() => {});
  return pending;
}
const backgroundPresence = () => reportPresence().catch(() => {});

async function state() {
  const current = await chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND, token: "", watched: [], unread: [] });
  current.receivedThrough ??= Math.max(0, ...current.unread.map(item => Number(item.eventId) || 0));
  return current;
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

async function initialize() { await ensureAlarm(); await backgroundPresence(); }
chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void tick(); });

function schedulePresence() {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => { presenceTimer = null; void backgroundPresence(); }, 500);
}

chrome.tabs.onRemoved.addListener(schedulePresence);
chrome.tabs.onCreated.addListener(schedulePresence);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => { if (changeInfo.status === "complete" || changeInfo.url) schedulePresence(); });

function normalizeBackend(value) { return value.trim().replace(/\/$/, ""); }
function isAllegroResultsPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "allegro.pl" || url.hostname.endsWith(".allegro.pl"))
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
  return tabs.find(tab => tab.id === watch.tabId && matchesWatch(tab.url, watch.url))
    || tabs.find(tab => matchesWatch(tab.url, watch.url)) || null;
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
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? "Token odrzucony — sparuj ponownie" : `Błąd serwera ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function pair(backendUrl, code) { return synchronize(async () => {
  const url = normalizeBackend(backendUrl || DEFAULT_BACKEND);
  const response = await fetch(`${url}/api/extension/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim().toUpperCase(), name: `Vivaldi ${navigator.platform}` })
  });
  if (!response.ok) throw new Error((await response.text()) || "Nie udało się sparować");
  const { token } = await response.json();
  await mutateState(() => ({ backendUrl: url, token, unread: [], receivedThrough: 0, connection: "paired", lastSyncAt: null }));
  return true;
}); }

async function addCurrentTab(name, intervalMinutes) { return synchronize(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const searchUrl = tab ? await resolveSearchUrl(tab) : null;
  if (!tab?.id || !searchUrl) throw new Error("Otwórz kartę z wynikami wyszukiwania Allegro");
  const created = await api("/api/extension/monitors", {
    method: "POST", body: JSON.stringify({ name: name.trim() || tab.title || "Allegro", url: searchUrl, intervalMinutes })
  });
  await mutateState(data => {
  const watched = data.watched.filter(item => item.monitorId !== created.id && item.url !== searchUrl);
  watched.push({ monitorId: created.id, tabId: tab.id, url: searchUrl, name: created.name, intervalMinutes, newListingsCount: created.newListingsCount || 0, lastCheckNewCount: created.lastCheckNewCount || 0, nextCheckAt: Date.now() });
  return { watched };
  });
  return created;
}); }

async function findTab(watch) {
  const tabs = await chrome.tabs.query({});
  return findMatchingTab(tabs, watch);
}

function reportPresence() { return synchronize(async () => {
  try { return await performPresence(); }
  catch (error) {
    await mutateState(() => ({ connection: error.status === 401 ? "unauthorized" : "offline" }));
    throw error;
  }
}); }
async function performPresence() {
  const data = await state();
  if (!data.token) throw new Error("Rozszerzenie nie jest sparowane");
  const tabs = await chrome.tabs.query({});
  const monitors = data.watched.map(watch => {
    const tab = findMatchingTab(tabs, watch);
    watch.tabId = tab?.id || null;
    watch.tabOpen = Boolean(tab);
    return { id: watch.monitorId, open: watch.tabOpen };
  });
  const response = await api("/api/extension/presence", { method: "POST", body: JSON.stringify({ monitors, notificationProtocol: 2 }) });
  if (!Array.isArray(response?.monitors)) throw new Error("Nieprawidłowa odpowiedź synchronizacji");
  let freshNotifications = [];
  const patch = await mutateState(current => {
  const localById = new Map(current.watched.map(watch => [watch.monitorId, watch]));
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
  // Keep a durable high-water mark even after the unread list is cleared.
  // Apply backpressure instead of silently discarding received events.
  const capacity = Math.max(0, 100 - current.unread.length);
  freshNotifications = incoming.filter(item => item.eventId > current.receivedThrough).slice(0, capacity);
  const unread = [...freshNotifications.map(item => ({ ...item, seenAt: new Date().toISOString() })), ...current.unread];
  const receivedThrough = Math.max(current.receivedThrough, ...freshNotifications.map(item => item.eventId));
  return { watched, unread, receivedThrough, latestExtensionVersion: response.latestExtensionVersion || "" };
  });
  const incoming = Array.isArray(response.notifications) ? response.notifications : [];
  const batch = response.notificationBatch;
  if (batch && incoming.every(item => item.eventId <= patch.receivedThrough)) {
    await api("/api/extension/notifications/ack", { method: "POST", body: JSON.stringify({ batchId: batch }) });
  }
  await mutateState(() => ({ connection: "online", lastSyncAt: Date.now() }));
  if (freshNotifications.length) {
    const first = freshNotifications[0];
    await chrome.notifications.create(`event-${first.eventId}`, {
      type: "basic", iconUrl: "icon-128.png",
      title: freshNotifications.length === 1 ? `Nowa oferta: ${first.monitorName}` : `Nowe oferty (${freshNotifications.length})`,
      message: `${first.title}${first.price ? ` — ${first.price}` : ""}`
    }).catch(() => {});
  }
  await updateActionBadge();
  return response;
}

async function tick() {
  await backgroundPresence();
  await checkDue();
}

function waitForLoad(tabId, timeoutMs = 45000, trigger = () => {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Przekroczono czas ładowania karty")); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
    Promise.resolve().then(trigger).catch(error => {
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); reject(error);
    });
  });
}

function extractListings() {
  const text = document.body?.innerText || "";
  if (/potwierd(?:ź|z).{0,40}(?:człowiekiem|czlowiekiem)|zostałeś zablokowany|zostales zablokowany|captcha/i.test(text)) {
    return { blocked: true, listings: [] };
  }
  const normalizedText = text.replace(/\s+/g, " ");
  const explicitEmpty = /teraz nie mamy dokładnie tego, czego szukasz|nie znaleźliśmy (?:żadnych )?(?:wyników|ofert)|nie znaleziono (?:żadnych )?(?:wyników|ofert)|brak (?:wyników|ofert) dla/i.test(normalizedText);
  const recommendationHeading = [...document.querySelectorAll("h1, h2, h3, h4")].find(element =>
    /^(?:rekomendacje dla ciebie|znaleźliśmy podobne oferty)$/i.test((element.textContent || "").replace(/\s+/g, " ").trim())
  );
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
      const isOffer = (url.hostname === "allegro.pl" || url.hostname.endsWith(".allegro.pl")) && (/^\/oferta\//.test(url.pathname) || /^\/produkt\//.test(url.pathname));
      const belowRecommendations = recommendationHeading && Boolean(recommendationHeading.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING);
      return isOffer && !belowRecommendations;
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
    empty: explicitEmpty || (Boolean(recommendationHeading) && found.size === 0),
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
    if (lastResult?.blocked || lastResult?.empty || lastResult?.listings?.length) return lastResult;
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
  if (!tab?.id) throw new Error(`Brak zgodnej karty „${watch.name}”: karta zamknięta lub zmienione filtry`);
  watch.tabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  if (!matchesWatch((await chrome.tabs.get(tab.id)).url, watch.url)) throw new Error("Adres karty zmienił się przed odświeżeniem");
  await waitForLoad(tab.id, 45000, () => chrome.tabs.reload(tab.id));
  if (!matchesWatch((await chrome.tabs.get(tab.id)).url, watch.url)) throw new Error("Adres karty zmienił się przed odczytem");
  const result = await readListings(tab.id);
  if (!result) throw new Error("Nie udało się odczytać zawartości karty Allegro");
  if (result.blocked) {
    await chrome.notifications.create(`blocked-${watch.monitorId}`, { type: "basic", iconUrl: "icon-128.png", title: "Allegro wymaga uwagi", message: `Sprawdź kartę: ${watch.name}` });
    throw new Error("Captcha lub blokada w karcie Allegro");
  }
  if (!result.empty && !result.listings.length) {
    const details = result.diagnostic || {};
    throw new Error(`Nie znaleziono ofert (linki: ${details.anchors ?? 0}, linki ofert: ${details.offerAnchors ?? 0}, strona: ${details.title || details.url || "nieznana"})`);
  }
  const currentTab = await chrome.tabs.get(tab.id);
  if (!matchesWatch(currentTab.url, watch.url) || !matchesWatch(result.diagnostic?.url, watch.url)) {
    throw new Error("Adres karty zmienił się podczas odczytu — wyniki pominięte");
  }
  const currentWatch = (await state()).watched.find(item => item.monitorId === watch.monitorId);
  if (!currentWatch || currentWatch.enabled === false || !matchesWatch(currentWatch.url, watch.url)) return 0;
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
  if (checking) { if (forceMonitorId !== null) throw new Error("Sprawdzanie już trwa"); return; }
  checking = true;
  try {
    const data = await state();
    if (!data.token) throw new Error("Rozszerzenie nie jest sparowane");
    if (forceMonitorId !== null) {
      const selected = data.watched.find(item => item.monitorId === forceMonitorId);
      if (!selected || selected.enabled === false) throw new Error("Monitor usunięty lub wstrzymany");
    }
    for (const snapshot of data.watched) {
      const watch = (await state()).watched.find(item => item.monitorId === snapshot.monitorId);
      if (!watch || watch.enabled === false) continue;
      if (forceMonitorId !== null ? watch.monitorId !== forceMonitorId : watch.nextCheckAt > Date.now()) continue;
      try { await checkOne(watch); }
      catch (error) {
        watch.nextCheckAt = Date.now() + Math.max(watch.intervalMinutes, 10) * 60_000;
        if (/Brak zgodnej karty/i.test(error.message)) await backgroundPresence();
        else await api(`/api/extension/monitors/${watch.monitorId}/error`, { method: "POST", body: JSON.stringify({ message: error.message }) }).catch(() => {});
        if (forceMonitorId !== null) throw error;
        if (/captcha|blokada/i.test(error.message)) break;
      }
      await mutateState(current => ({ watched: current.watched.map(item => item.monitorId === watch.monitorId && matchesWatch(item.url, watch.url)
        ? { ...item, nextCheckAt: watch.nextCheckAt } : item) }));
      if (forceMonitorId !== null) break;
      await new Promise(resolve => setTimeout(resolve, 12000 + Math.random() * 10000));
    }

  } finally { checking = false; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "pair") return pair(message.backendUrl, message.code);
    if (message.type === "add-current") return addCurrentTab(message.name, Number(message.intervalMinutes));
    if (message.type === "check") { await reportPresence(); await checkDue(message.monitorId ?? null); return true; }
    if (message.type === "sync") { await reportPresence(); return true; }
    if (message.type === "notification-state") {
      await synchronize(() => api(`/api/extension/monitors/${message.monitorId}/notification-state`, { method: "POST", body: JSON.stringify({ enabled: message.enabled === true }) }));
      await reportPresence();
      return true;
    }
    if (message.type === "clear-unread") { await mutateState(() => ({ unread: [] })); await updateActionBadge(); return true; }
    throw new Error("Nieznana operacja");
  })().then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

void initialize();
