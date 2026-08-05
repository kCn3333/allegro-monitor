const $ = selector => document.querySelector(selector);
const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
$("#extension-version").textContent = `Wersja ${chrome.runtime.getManifest().version}`;

function message(text, type = "") { $("#message").textContent = text; $("#message").className = type; }
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char])); }

async function render() {
  const data = await chrome.storage.local.get({ token: "", watched: [], unread: [] });
  $("#pairing").hidden = Boolean(data.token); $("#connected").hidden = !data.token;
  $("#connection").textContent = data.token ? "Połączono" : "Brak połączenia";
  $("#watched-section").hidden = !data.token || !data.watched.length;
  $("#new-section").hidden = !data.unread.length;
  $("#watched").innerHTML = data.watched.map(item => {
    const notificationsEnabled = item.notificationsEnabled !== false;
    const status = item.tabOpen === false ? "Karta zamknięta" : "Karta otwarta";
    const primary = item.tabOpen === false
      ? `<button data-open="${item.monitorId}">Otwórz kartę</button>`
      : `<button data-check="${item.monitorId}">Sprawdź teraz</button>`;
    const notifications = `<button class="deactivate" data-notifications="${item.monitorId}" data-enabled="${notificationsEnabled ? "false" : "true"}">${notificationsEnabled ? "Wyłącz powiadomienia" : "Włącz powiadomienia"}</button>`;
    return `<div class="watch"><div class="watch-head"><strong>${esc(item.name)}</strong>${Number(item.lastCheckNewCount) > 0 ? `<span class="new-count" title="Nowe w ostatnim sprawdzeniu">+${Number(item.lastCheckNewCount)}</span>` : ""}</div><span class="tab-status ${item.tabOpen === false ? "closed" : "open"}">${status}</span><span> · powiadomienia ${notificationsEnabled ? "włączone" : "wyłączone"} · ${Number(item.activeClientsCount) || 0} aktywnych urządzeń · co ${item.intervalMinutes} min</span><div class="actions">${primary}${notifications}</div></div>`;
  }).join("");
  $("#unread").innerHTML = data.unread.map(item => `<div class="offer"><a href="${esc(item.url)}" target="_blank">${esc(item.title)}</a><span>${esc(item.monitorName)} · ${esc(item.price || "Cena nieznana")}</span></div>`).join("");
}

$("#pair").addEventListener("click", async () => { message("Łączenie…"); const response = await send({ type:"pair", backendUrl:$("#backend").value, code:$("#code").value }); message(response.ok ? "Połączono" : response.error, response.ok ? "ok" : "error"); await render(); });
$("#add").addEventListener("click", async () => { message("Dodawanie…"); const response = await send({ type:"add-current", name:$("#name").value, intervalMinutes:Number($("#interval").value) }); message(response.ok ? "Karta jest monitorowana" : response.error, response.ok ? "ok" : "error"); await render(); });
$("#check-all").addEventListener("click", async () => { message("Rozpoczęto sprawdzanie", "ok"); await send({ type:"check" }); window.close(); });
$("#sync").addEventListener("click", async () => { message("Odświeżanie…"); const response=await send({type:"sync"}); message(response.ok ? "Lista odświeżona" : response.error,response.ok ? "ok" : "error"); await render(); });
$("#clear").addEventListener("click", async () => { await send({ type:"clear-unread" }); await render(); });
document.addEventListener("click", async event => {
  const open = event.target.dataset?.open;
  const notifications = event.target.dataset?.notifications;
  const check = event.target.dataset?.check;
  if (open) {
    const monitorId = Number(open);
    const data = await chrome.storage.local.get({ watched:[] });
    const item = data.watched.find(watch => watch.monitorId === monitorId);
    if (item?.tabId) await chrome.tabs.update(item.tabId, { active:true });
    else if (item?.url) await chrome.tabs.create({ url:item.url });
    window.close();
  }
  if (notifications) {
    const enabled = event.target.dataset.enabled === "true";
    const response = await send({ type:"notification-state", monitorId:Number(notifications), enabled });
    message(response.ok ? `Powiadomienia ${enabled ? "włączone" : "wyłączone"}` : response.error, response.ok ? "ok" : "error");
    await render();
  }
  if (check) { await send({ type:"check", monitorId:Number(check) }); window.close(); }
});
void render();
