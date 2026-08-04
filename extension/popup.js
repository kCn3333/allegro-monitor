const $ = selector => document.querySelector(selector);
const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));

function message(text, type = "") { $("#message").textContent = text; $("#message").className = type; }
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char])); }

async function render() {
  const data = await chrome.storage.local.get({ token: "", watched: [], unread: [] });
  $("#pairing").hidden = Boolean(data.token); $("#connected").hidden = !data.token;
  $("#connection").textContent = data.token ? "Połączono" : "Brak połączenia";
  $("#watched-section").hidden = !data.token || !data.watched.length;
  $("#new-section").hidden = !data.unread.length;
  $("#watched").innerHTML = data.watched.map(item => `<div class="watch"><div class="watch-head"><strong>${esc(item.name)}</strong>${Number(item.lastCheckNewCount) > 0 ? `<span class="new-count" title="Nowe w ostatnim sprawdzeniu">+${Number(item.lastCheckNewCount)}</span>` : ""}</div><span class="tab-status ${item.tabOpen === false ? "closed" : "open"}">${item.tabOpen === false ? "Karta zamknięta" : "Karta otwarta"}</span><span> · ${Number(item.activeClientsCount) || 0} aktywnych urządzeń · co ${item.intervalMinutes} min</span><div class="actions">${item.tabOpen === false ? `<button data-open="${item.monitorId}">Otwórz kartę</button>` : `<button data-check="${item.monitorId}">Sprawdź teraz</button>`}<button class="remove" data-remove="${item.monitorId}">Usuń</button></div></div>`).join("");
  $("#unread").innerHTML = data.unread.map(item => `<div class="offer"><a href="${esc(item.url)}" target="_blank">${esc(item.title)}</a><span>${esc(item.monitorName)} · ${esc(item.price || "Cena nieznana")}</span></div>`).join("");
}

$("#pair").addEventListener("click", async () => { message("Łączenie…"); const response = await send({ type:"pair", backendUrl:$("#backend").value, code:$("#code").value }); message(response.ok ? "Połączono" : response.error, response.ok ? "ok" : "error"); await render(); });
$("#add").addEventListener("click", async () => { message("Dodawanie…"); const response = await send({ type:"add-current", name:$("#name").value, intervalMinutes:Number($("#interval").value) }); message(response.ok ? "Karta jest monitorowana" : response.error, response.ok ? "ok" : "error"); await render(); });
$("#check-all").addEventListener("click", async () => { message("Rozpoczęto sprawdzanie", "ok"); await send({ type:"check" }); window.close(); });
$("#sync").addEventListener("click", async () => { message("Odświeżanie…"); const response=await send({type:"sync"}); message(response.ok ? "Lista odświeżona" : response.error,response.ok ? "ok" : "error"); await render(); });
$("#clear").addEventListener("click", async () => { await send({ type:"clear-unread" }); await render(); });
document.addEventListener("click", async event => { const open=event.target.dataset?.open,check=event.target.dataset?.check,remove=event.target.dataset?.remove;if(open){const data=await chrome.storage.local.get({watched:[]});const item=data.watched.find(w=>w.monitorId===Number(open));if(item?.tabId){await chrome.tabs.update(item.tabId,{active:true})}else if(item?.url){await chrome.tabs.create({url:item.url})}window.close()}if(check){await send({type:"check",monitorId:Number(check)});window.close()}if(remove&&confirm("Usunąć ten monitor z tego rozszerzenia?")){const response=await send({type:"remove",monitorId:Number(remove)});message(response.ok?"Monitor odłączony":response.error,response.ok?"ok":"error");await render()}});
void render();
