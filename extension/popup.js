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
  const data = await chrome.storage.local.get({ token:"", watched:[], unread:[], latestExtensionVersion:"" });
  $("#extension-version").textContent = `Wersja ${localVersion}`;
  const versionStatus = $("#version-status");
  if (!data.latestExtensionVersion) { versionStatus.textContent = "Nie udało się sprawdzić aktualności"; versionStatus.className = "version-status"; }
  else if (compareVersions(localVersion, data.latestExtensionVersion) >= 0) { versionStatus.textContent = "✓ Najnowsza wersja"; versionStatus.className = "version-status current"; }
  else { versionStatus.textContent = `Dostępna wersja ${data.latestExtensionVersion}`; versionStatus.className = "version-status outdated"; }
  $("#pairing").hidden = Boolean(data.token); $("#connected").hidden = !data.token;
  $("#connection").textContent = data.token ? "Połączono" : "Brak połączenia";
  $("#watched-empty").hidden = data.watched.length > 0;
  $("#unread-empty").hidden = data.unread.length > 0;
  $("#clear").hidden = data.unread.length === 0;
  $("#unread-count").hidden = data.unread.length === 0;
  $("#unread-count").textContent = data.unread.length > 99 ? "99+" : String(data.unread.length);
  $("#watched").innerHTML = data.watched.map(item => {
    const notificationsEnabled = item.notificationsEnabled !== false;
    const tabOpen = item.tabOpen !== false;
    return `<div class="watch"><div class="watch-head"><strong>${esc(item.name)}</strong>${Number(item.lastCheckNewCount) > 0 ? `<span class="new-count" title="Nowe w ostatnim sprawdzeniu">+${Number(item.lastCheckNewCount)}</span>` : ""}</div><span class="tab-status ${tabOpen ? "open" : "closed"}">${tabOpen ? "Karta otwarta" : "Karta zamknięta"}</span><span> · ${Number(item.activeClientsCount) || 0} aktywnych urządzeń · co ${item.intervalMinutes} min</span><div class="actions"><button data-open="${item.monitorId}">${tabOpen ? "Pokaż kartę" : "Otwórz kartę"}</button><button data-check="${item.monitorId}" ${!tabOpen || !notificationsEnabled ? "disabled" : ""} title="${!notificationsEnabled ? "Włącz powiadomienia, aby sprawdzić ręcznie" : !tabOpen ? "Najpierw otwórz kartę" : "Sprawdź teraz"}">Sprawdź teraz</button><label class="notify-control"><span>Powiadomienia na tym urządzeniu</span><input type="checkbox" data-notifications="${item.monitorId}" ${notificationsEnabled ? "checked" : ""}><span class="switch-track"></span></label></div></div>`;
  }).join("");
  $("#unread").innerHTML = data.unread.map(item => `<div class="offer"><a href="${esc(item.url)}" target="_blank">${esc(item.title)}</a><span>${esc(item.monitorName)} · ${esc(item.price || "Cena nieznana")}</span></div>`).join("");
}

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
$("#pair").addEventListener("click", async () => { message("Łączenie…"); const response=await send({type:"pair",backendUrl:$("#backend").value,code:$("#code").value}); message(response.ok?"Połączono":response.error,response.ok?"ok":"error"); if(response.ok)await send({type:"sync"}); await render(); });
$("#add").addEventListener("click", async () => { message("Dodawanie…"); const response=await send({type:"add-current",name:$("#name").value,intervalMinutes:Number($("#interval").value)}); message(response.ok?"Karta jest monitorowana":response.error,response.ok?"ok":"error"); await render(); });
$("#sync").addEventListener("click", async () => { message("Odświeżanie…"); const response=await send({type:"sync"}); message(response.ok?"Lista odświeżona":response.error,response.ok?"ok":"error"); await render(); });
$("#clear").addEventListener("click", async () => { await send({type:"clear-unread"}); await render(); });
document.addEventListener("click", async event => {
  const open=event.target.dataset?.open, check=event.target.dataset?.check;
  if(open){const data=await chrome.storage.local.get({watched:[]});const item=data.watched.find(watch=>watch.monitorId===Number(open));if(item?.tabId)await chrome.tabs.update(item.tabId,{active:true});else if(item?.url)await chrome.tabs.create({url:item.url});window.close();}
  if(check){await send({type:"check",monitorId:Number(check)});window.close();}
});
document.addEventListener("change", async event => {
  const monitorId=event.target.dataset?.notifications;if(!monitorId)return;
  event.target.disabled=true;const enabled=event.target.checked;
  const response=await send({type:"notification-state",monitorId:Number(monitorId),enabled});
  message(response.ok?`Powiadomienia ${enabled?"włączone":"wyłączone"}`:response.error,response.ok?"ok":"error");
  await render();
});

void (async()=>{await render();const {token}=await chrome.storage.local.get({token:""});if(token){await send({type:"sync"});await render();}})();
