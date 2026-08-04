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
  $("#watched").innerHTML = data.watched.map(item => `<div class="watch"><div class="watch-head"><strong>${esc(item.name)}</strong>${Number(item.lastCheckNewCount) > 0 ? `<span class="new-count" title="Nowe w ostatnim sprawdzeniu">+${Number(item.lastCheckNewCount)}</span>` : ""}</div><span class="tab-status ${item.tabOpen === false ? "closed" : "open"}">${item.tabOpen === false ? "Karta zamknięta" : "Karta otwarta"}</span><span> · co ${item.intervalMinutes} min</span><div class="actions"><button data-check="${item.monitorId}">Sprawdź teraz</button><button class="remove" data-remove="${item.monitorId}">Usuń</button></div></div>`).join("");
  $("#unread").innerHTML = data.unread.map(item => `<div class="offer"><a href="${esc(item.url)}" target="_blank">${esc(item.title)}</a><span>${esc(item.monitorName)} · ${esc(item.price || "Cena nieznana")}</span></div>`).join("");
}

$("#pair").addEventListener("click", async () => { message("Łączenie…"); const response = await send({ type:"pair", backendUrl:$("#backend").value, code:$("#code").value }); message(response.ok ? "Połączono" : response.error, response.ok ? "ok" : "error"); await render(); });
$("#add").addEventListener("click", async () => { message("Dodawanie…"); const response = await send({ type:"add-current", name:$("#name").value, intervalMinutes:Number($("#interval").value) }); message(response.ok ? "Karta jest monitorowana" : response.error, response.ok ? "ok" : "error"); await render(); });
$("#check-all").addEventListener("click", async () => { message("Rozpoczęto sprawdzanie", "ok"); await send({ type:"check" }); window.close(); });
$("#clear").addEventListener("click", async () => { await send({ type:"clear-unread" }); await render(); });
document.addEventListener("click", async event => { const check=event.target.dataset?.check, remove=event.target.dataset?.remove;if(check){await send({type:"check",monitorId:Number(check)});window.close()}if(remove&&confirm("Usunąć monitor?")){await send({type:"remove",monitorId:Number(remove)});await render()}});
void render();
