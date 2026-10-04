import { config } from "./config.js";
import { escapeHtml as esc, renderLayout } from "./layout.js";
import type { ExtensionClient } from "./types.js";
import { icon, systemIcon } from "./icons.js";

const timestamp = (value: string | null) => value ? new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "medium", timeStyle: "short", timeZone: config.timeZone
}).format(new Date(value)) : "Brak kontaktu";

export function renderDevices(devices: ExtensionClient[]): string {
  const field = (label: string, value: unknown, leadingIcon = "") => `<div><dt>${label}</dt><dd>${leadingIcon ? `<span class="system-value">${leadingIcon}${esc(value ?? "Brak danych")}</span>` : esc(value ?? "Brak danych")}</dd></div>`;
  return renderLayout("Urządzenia", `<section class="hero"><span class="eyebrow">Połączenia z rozszerzeniem</span><h1>Sparowane urządzenia</h1></section>
  <section class="device-list" aria-label="Lista urządzeń">${devices.length ? devices.map(device => `<article class="device-card"><div class="device-head"><div class="device-name"><h2>${esc(device.name)}</h2><details class="rename"><summary aria-label="Edytuj nazwę urządzenia" title="Edytuj nazwę urządzenia">${icon("edit")}</summary><form method="post" action="/devices/${device.id}/rename"><input aria-label="Nazwa urządzenia" name="name" value="${esc(device.name)}" maxlength="100" required><button>${icon("save")}Zapisz</button></form></details></div><span class="device-status"><span class="status-dot ${device.active ? "healthy" : "paused"}" aria-hidden="true"></span>${device.active ? "Aktywne" : "Nieaktywne"}</span></div><dl class="device-meta">
  ${field("Wersja rozszerzenia", device.extensionVersion)}${field("Przeglądarka / silnik", device.browser)}${field("System", device.os, systemIcon(device.os))}${field("Wersja systemu (wg przeglądarki)", device.osVersion)}${field("Architektura", device.arch)}${field("Ostatni kontakt", timestamp(device.lastSeenAt))}${field("Sparowano", timestamp(device.createdAt))}${field("Otwarte karty monitorów", device.openMonitorsCount)}
  </dl><div class="card-actions device-actions"><form method="post" action="/devices/${device.id}/revoke" onsubmit="return confirm('Odłączyć to urządzenie?')"><button class="button danger">${icon("unlink")}Odłącz urządzenie</button></form></div></article>`).join("") : `<div class="empty"><strong>Brak sparowanych urządzeń</strong><p>Dodaj pierwsze urządzenie za pomocą kodu parowania.</p><a class="button primary" href="/extension">${icon("pair")}Sparuj rozszerzenie</a></div>`}</section>${devices.length ? `<form method="post" action="/devices/revoke-all" style="margin-top:20px" onsubmit="return confirm('Odłączyć wszystkie urządzenia i unieważnić oczekujące kody parowania?')"><button class="button subtle danger">${icon("unlink")}Odłącz wszystkie urządzenia</button></form>` : ""}`, "/devices", `
setInterval(async()=>{if(document.hidden||document.querySelector('.device-list .rename[open]'))return;try{const response=await fetch('/devices');if(!response.ok||response.redirected)return;if(document.querySelector('.device-list .rename[open]'))return;const next=new DOMParser().parseFromString(await response.text(),'text/html');for(const selector of ['.hero','.device-list']){const current=document.querySelector(selector),updated=next.querySelector(selector);if(current&&updated)current.replaceWith(updated)}}catch{}},60000);`);
}
