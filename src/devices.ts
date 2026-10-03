import { config } from "./config.js";
import { escapeHtml as esc, renderLayout } from "./layout.js";
import type { ExtensionClient } from "./types.js";

const timestamp = (value: string | null) => value ? new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "medium", timeStyle: "short", timeZone: config.timeZone
}).format(new Date(value)) : "Brak kontaktu";

export function renderDevices(devices: ExtensionClient[]): string {
  const active = devices.filter(device => device.active).length;
  const field = (label: string, value: unknown) => `<div><dt>${label}</dt><dd>${esc(value ?? "Brak danych")}</dd></div>`;
  return renderLayout("Urządzenia", `<section class="hero"><span class="eyebrow">Połączenia z rozszerzeniem</span><h1>Sparowane urządzenia</h1><p>Aktywne: ${active} · Sparowane: ${devices.length}. Zielona dioda oznacza kontakt z rozszerzeniem w ciągu ostatnich 3 minut, niezależnie od otwartych kart.</p></section>
  <section class="device-list" aria-label="Lista urządzeń">${devices.length ? devices.map(device => `<article class="device-card"><div class="device-head"><h2>${esc(device.name)}</h2><span class="device-status"><span class="status-dot ${device.active ? "healthy" : "paused"}" aria-hidden="true"></span>${device.active ? "Aktywne" : "Nieaktywne"}</span></div><dl class="device-meta">
  ${field("Wersja rozszerzenia", device.extensionVersion)}${field("Przeglądarka / silnik", device.browser)}${field("System", device.os)}${field("Wersja systemu (wg przeglądarki)", device.osVersion)}${field("Architektura", device.arch)}${field("Adres IP widziany przez serwer", device.ip)}${field("Ostatni kontakt", timestamp(device.lastSeenAt))}${field("Sparowano", timestamp(device.createdAt))}${field("Otwarte karty monitorów", device.openMonitorsCount)}
  </dl><div class="card-actions" style="margin-top:20px"><form method="post" action="/devices/${device.id}/revoke" onsubmit="return confirm('Odłączyć to urządzenie?')"><button class="button danger">Odłącz urządzenie</button></form></div></article>`).join("") : `<div class="empty"><strong>Brak sparowanych urządzeń</strong><p>Dodaj pierwsze urządzenie za pomocą kodu parowania.</p><a class="button primary" href="/extension">Sparuj rozszerzenie</a></div>`}</section>${devices.length ? `<form method="post" action="/devices/revoke-all" style="margin-top:20px" onsubmit="return confirm('Odłączyć wszystkie urządzenia i unieważnić oczekujące kody parowania?')"><button class="button subtle danger">Odłącz wszystkie urządzenia</button></form>` : ""}<p class="muted">Dane uzupełniają się po aktualizacji rozszerzenia i jego synchronizacji. Przeglądarka może nie udostępniać wersji systemu. Za proxy widoczny adres IP może należeć do proxy.</p>`, "/devices", `
setInterval(async()=>{if(document.hidden)return;try{const response=await fetch('/devices');if(!response.ok||response.redirected)return;const next=new DOMParser().parseFromString(await response.text(),'text/html');for(const selector of ['.hero','.device-list']){const current=document.querySelector(selector),updated=next.querySelector(selector);if(current&&updated)current.replaceWith(updated)}}catch{}},60000);`);
}
