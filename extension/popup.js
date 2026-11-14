import { BACKEND_URL } from "./backend-config.js";
import { icons } from "./popup-icons.js";

const icon = name => icons[name] || "";
for (const element of document.querySelectorAll("[data-icon]")) element.innerHTML = icon(element.dataset.icon);

const $ = selector => document.querySelector(selector);
const send = payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
const localVersion = chrome.runtime.getManifest().version;

function message(text, type = "") { $("#message").textContent = text; $("#message").className = type; }
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char])); }
function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}
function showTab(name) {
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(panel => {
    const active = panel.dataset.panel === name;
    panel.hidden = !active; panel.classList.toggle("active", active);
  });
  message("");
}

async function render() {
  const data = await chrome.storage.local.get({ token:"", watched:[], unread:[], latestExtensionVersion:"", connection:"paired", lastSyncAt:null,
    notificationSnooze: { duration: "hour", until: 0 } });
  $("#backend").value = BACKEND_URL;
  $("#extension-version").textContent = `Wersja ${localVersion}`;
  const versionStatus = $("#version-status");
  if (!data.latestExtensionVersion) { versionStatus.textContent = "Nie udało się sprawdzić aktualności"; versionStatus.className = "version-status"; }
  else if (compareVersions(localVersion, data.latestExtensionVersion) >= 0) { versionStatus.textContent = "✓ Najnowsza wersja"; versionStatus.className = "version-status current"; }
  else { versionStatus.textContent = `Dostępna wersja ${data.latestExtensionVersion}`; versionStatus.className = "version-status outdated"; }
  $("#pairing").hidden = Boolean(data.token) && data.connection !== "unauthorized"; $("#connected").hidden = !data.token;
  $("#notification-settings").hidden = !data.token;
  const snooze = data.notificationSnooze;
  const paused = snooze.until === null || snooze.until > Date.now();
  $("#snooze-enabled").checked = paused;
  $("#snooze-duration").value = snooze.duration;
  $("#snooze-duration").disabled = paused;
  $("#snooze-status").textContent = paused
    ? `${snooze.until === null ? "Uśpione do odwołania." : `Uśpione do ${new Date(snooze.until).toLocaleString("pl", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`} Monitorowanie i lista nowych ofert nadal działają.`
    : "Monitorowanie i lista nowych ofert pozostają aktywne.";
  const connection = !data.token ? "unpaired" : data.connection === "online" ? "online" : data.connection === "unauthorized" ? "unauthorized" : "offline";
  $("#connection").dataset.state = connection;
  $("#connection-label").textContent = { unpaired: "Niesparowane", online: "Połączono", unauthorized: "Token odrzucony — sparuj ponownie", offline: "Serwer niedostępny" }[connection];
  const lastSync = $("#last-sync");
  lastSync.hidden = !data.token;
  if (data.lastSyncAt) {
    const date = new Date(data.lastSyncAt);
    lastSync.dateTime = date.toISOString();
    lastSync.textContent = `Ostatnia synchronizacja: ${date.toLocaleString("pl", { dateStyle: "short", timeStyle: "medium" })}`;
  } else {
    lastSync.removeAttribute("datetime");
    lastSync.textContent = "Brak udanej synchronizacji";
  }
  $("#watched-empty").hidden = data.watched.length > 0;
  $("#unread-empty").hidden = data.unread.length > 0;
  $("#clear").hidden = data.unread.length === 0;
  $("#unread-count").hidden = data.unread.length === 0;
  $("#unread-count").textContent = data.unread.length > 99 ? "99+" : String(data.unread.length);
  $("#watched").innerHTML = data.watched.map(item => {
    const notificationsEnabled = item.notificationsEnabled !== false;
    const tabOpen = item.tabOpen !== false;
    return `<div class="watch"><div class="watch-head"><strong>${esc(item.name)}</strong>${Number(item.lastCheckNewCount) > 0 ? `<span class="new-count" title="Nowe w ostatnim sprawdzeniu">+${Number(item.lastCheckNewCount)}</span>` : ""}</div><span class="tab-status ${tabOpen ? "open" : "closed"}">${tabOpen ? "Karta otwarta" : "Brak zgodnej karty"}</span><span> · ${Number(item.activeClientsCount) || 0} aktywnych urządzeń · co ${item.intervalMinutes} min</span><div class="actions"><button data-open="${item.monitorId}">${icon("external")}${tabOpen ? "Pokaż kartę" : "Otwórz kartę"}</button><button data-check="${item.monitorId}" ${!tabOpen || item.enabled === false ? "disabled" : ""} title="${item.enabled === false ? "Monitor wstrzymany" : !tabOpen ? "Najpierw otwórz kartę" : "Sprawdź teraz"}">${icon("check")}Sprawdź teraz</button><label class="notify-control"><span>Powiadomienia na tym urządzeniu</span><input type="checkbox" data-notifications="${item.monitorId}" ${notificationsEnabled ? "checked" : ""}><span class="switch-track"></span></label></div></div>`;
  }).join("");
  $("#unread").innerHTML = data.unread.map(item => `<div class="offer"><a href="${esc(item.url)}" target="_blank">${esc(item.title)}</a><span>${esc(item.monitorName)} · ${esc(item.price || "Cena nieznana")}</span></div>`).join("");
}

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
$("#pair").addEventListener("click", async () => { message("Łączenie…"); const response=await send({type:"pair",code:$("#code").value}); message(response.ok?"Połączono":response.error,response.ok?"ok":"error"); if(response.ok)await send({type:"sync"}); await render(); });
$("#add").addEventListener("click", async () => { message("Dodawanie…"); const response=await send({type:"add-current",name:$("#name").value,intervalMinutes:Number($("#interval").value)}); message(response.ok?"Karta jest monitorowana":response.error,response.ok?"ok":"error"); await render(); });
$("#sync").addEventListener("click", async () => { message("Odświeżanie…"); const response=await send({type:"sync"}); message(response.ok?"Lista odświeżona":response.error,response.ok?"ok":"error"); await render(); });
$("#clear").addEventListener("click", async () => { await send({type:"clear-unread"}); await render(); });
async function updateSnooze() {
  const enabled = $("#snooze-enabled").checked;
  const duration = $("#snooze-duration").value;
  $("#snooze-enabled").disabled = true;
  $("#snooze-duration").disabled = true;
  try {
    const response = await send({ type: "snooze-notifications", enabled, duration });
    message(response.ok ? enabled ? "Powiadomienia uśpione" : "Powiadomienia wznowione" : response.error, response.ok ? "ok" : "error");
    await render();
  } finally { $("#snooze-enabled").disabled = false; }
}
$("#snooze-enabled").addEventListener("change", updateSnooze);
$("#snooze-duration").addEventListener("change", updateSnooze);
setInterval(() => { void render(); }, 30000);
document.addEventListener("click", async event => {
  const button=event.target.closest?.("button[data-open],button[data-check]");
  const open=button?.dataset.open, check=button?.dataset.check;
  if(open){const data=await chrome.storage.local.get({watched:[]});const item=data.watched.find(watch=>watch.monitorId===Number(open));if(item?.tabId)await chrome.tabs.update(item.tabId,{active:true});else if(item?.url)await chrome.tabs.create({url:item.url});window.close();}
  if(check){message("Sprawdzanie…");const response=await send({type:"check",monitorId:Number(check)});message(response.ok?"Sprawdzono":response.error,response.ok?"ok":"error");await render();}
});
document.addEventListener("change", async event => {
  const monitorId=event.target.dataset?.notifications;if(!monitorId)return;
  event.target.disabled=true;const enabled=event.target.checked;
  const response=await send({type:"notification-state",monitorId:Number(monitorId),enabled});
  message(response.ok?`Powiadomienia ${enabled?"włączone":"wyłączone"}`:response.error,response.ok?"ok":"error");
  await render();
});

void (async()=>{await render();const {token}=await chrome.storage.local.get({token:""});if(token){await send({type:"sync"});await render();}})();
