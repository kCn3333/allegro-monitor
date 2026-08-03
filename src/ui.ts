import type { Listing, Monitor } from "./types.js";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]!));

function date(value: string | null): string {
  return value ? new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
}

export function renderPage(monitors: Monitor[], listings: Array<Listing & { monitorName: string; firstSeenAt: string }>): string {
  const rows = monitors.map(m => `<tr>
    <td><strong>${esc(m.name)}</strong><small>${esc(new URL(m.url).searchParams.get("string") || m.url)}</small></td>
    <td><span class="badge ${m.enabled ? "on" : "off"}">${m.enabled ? "aktywny" : "wyłączony"}</span></td>
    <td>co ${m.intervalMinutes} min</td><td>${date(m.lastCheckedAt)}</td>
    <td class="status ${m.lastError ? "error" : ""}">${esc(m.lastError || (m.initialized ? "OK" : "oczekuje"))}</td>
    <td class="actions">
      <form method="post" action="/monitors/${m.id}/check"><button>Sprawdź</button></form>
      <form method="post" action="/monitors/${m.id}/toggle"><button>${m.enabled ? "Wyłącz" : "Włącz"}</button></form>
      <form method="post" action="/monitors/${m.id}/delete" onsubmit="return confirm('Usunąć monitor i jego historię?')"><button class="danger">Usuń</button></form>
    </td></tr>`).join("");

  const cards = listings.map(l => `<article class="offer">
    ${l.imageUrl ? `<img src="${esc(l.imageUrl)}" alt="" loading="lazy">` : ""}
    <div><small>${esc(l.monitorName)} · ${date(l.firstSeenAt)}</small>
      <a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.title)}</a>
      <strong>${esc(l.price || "Cena nieznana")}</strong></div></article>`).join("");

  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Allegro Monitor</title><style>
  :root{font-family:system-ui,sans-serif;color:#202124;background:#f6f7f9}body{max-width:1100px;margin:0 auto;padding:24px}h1{margin-bottom:4px}p{color:#62666d}section{background:white;padding:20px;border-radius:12px;margin:20px 0;box-shadow:0 1px 4px #0001}form.add{display:grid;grid-template-columns:1fr 2fr 120px auto;gap:10px}input,button{font:inherit;padding:9px;border:1px solid #d3d6da;border-radius:7px}button{cursor:pointer;background:#fff}button.primary{background:#ff5a00;color:#fff;border-color:#ff5a00}button.danger{color:#b3261e}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #eee;vertical-align:top}td small{display:block;color:#777;margin-top:4px}.actions{display:flex;gap:5px}.badge{padding:3px 7px;border-radius:20px;font-size:12px}.on{background:#d9f5e3;color:#176b38}.off{background:#eee}.error{color:#b3261e;max-width:260px}.offer{display:flex;gap:12px;border-bottom:1px solid #eee;padding:12px 0}.offer img{width:64px;height:64px;object-fit:contain}.offer div{display:grid;gap:4px}.offer a{color:#174ea6;text-decoration:none}.offer small{color:#777}@media(max-width:800px){form.add{grid-template-columns:1fr}section{overflow:auto}.actions{display:grid}body{padding:12px}}
  </style></head><body><header><h1>📚 Allegro Monitor</h1><p>Powiadomienia o nowych ofertach poszukiwanych książek</p></header>
  <section><h2>Dodaj wyszukiwanie</h2><form class="add" method="post" action="/monitors">
    <input name="name" placeholder="np. Yukio Mishima" required maxlength="100">
    <input name="url" type="url" placeholder="https://allegro.pl/listing?..." required>
    <input name="intervalMinutes" type="number" value="10" min="2" max="1440" required>
    <button class="primary">Dodaj</button></form></section>
  <section><h2>Monitory</h2>${monitors.length ? `<table><thead><tr><th>Nazwa</th><th>Status</th><th>Interwał</th><th>Ostatnio</th><th>Wynik</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : "<p>Nie masz jeszcze żadnych monitorów.</p>"}</section>
  <section><h2>Ostatnio znalezione</h2>${cards || "<p>Pierwsze sprawdzenie zapisze bieżące oferty bez powiadomień.</p>"}</section>
  </body></html>`;
}
