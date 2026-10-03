import { renderLayout } from "./layout.js";
import type { Listing, Monitor, MonitorExclusion } from "./types.js";
import { config } from "./config.js";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]!));

function date(value: string | null): string {
  return value ? new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "short", timeStyle: "short", timeZone: config.timeZone
  }).format(new Date(value)) : "Jeszcze nie sprawdzono";
}

function day(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeZone: config.timeZone }).format(new Date(value));
}

function queryLabel(url: string): string {
  return new URL(url).searchParams.get("string") || "Wyszukiwanie Allegro";
}

function monitorCard(monitor: Monitor, exclusions: MonitorExclusion[]): string {
  const state = !monitor.enabled ? { label: "Wstrzymany", className: "paused" }
    : monitor.activeClientsCount === 0 ? { label: "Brak otwartej karty", className: "paused" }
      : monitor.lastError ? { label: "Wymaga uwagi", className: "failed" }
      : monitor.initialized ? { label: "Aktywne", className: "healthy" }
        : { label: "Pierwsze sprawdzenie", className: "waiting" };

  return `<article class="monitor-card">
    <div class="monitor-main">
      <div class="monitor-title"><span class="status-dot ${state.className}"></span><div>
        <span class="monitor-created">Dodano ${day(monitor.createdAt)}</span><div class="monitor-name"><h3>${esc(monitor.name)}</h3><details class="rename"><summary aria-label="Edytuj nazwę" title="Edytuj nazwę">✎</summary><form method="post" action="/monitors/${monitor.id}/rename"><input name="name" value="${esc(monitor.name)}" maxlength="100" required><button>Zapisz</button></form></details></div><p class="search-query">${esc(queryLabel(monitor.url))}</p>
      </div></div>
      <div class="monitor-status"><span class="last-attempt">Ostatnia próba: ${date(monitor.lastCheckedAt)}</span>${monitor.lastCheckNewCount > 0 ? `<span class="new-count" title="Nowe w ostatnim sprawdzeniu">+${monitor.lastCheckNewCount}</span>` : ""}<span class="status-pill ${state.className}">${state.label}</span><form class="toggle-form" method="post" action="/monitors/${monitor.id}/toggle"><label class="switch" title="${monitor.enabled ? "Wstrzymaj monitor" : "Wznów monitor"}"><input type="checkbox" ${monitor.enabled ? "checked" : ""} onchange="this.form.submit()" aria-label="${monitor.enabled ? "Wstrzymaj monitor" : "Wznów monitor"}"><span></span></label></form></div>
    </div>
    <dl class="monitor-meta">
      <div><dt>Sprawdzanie</dt><dd>co ${monitor.intervalMinutes} min</dd></div>
      <div><dt>Śledzone pozycje</dt><dd>${monitor.currentListingsCount}</dd></div>
      <div><dt>Wykryte nowości</dt><dd>${monitor.newListingsCount}</dd></div>
      <div><dt>Wykluczenia</dt><dd>${monitor.excludedListingsCount}</dd></div>
      <div><dt>Aktywne urządzenia</dt><dd>${monitor.activeClientsCount}</dd></div>
    </dl>
    ${monitor.lastError ? `<div class="alert"><strong>Rozszerzenie zgłosiło problem</strong><span>${esc(monitor.lastError)}</span></div>` : ""}
    ${exclusions.length ? `<details class="exclusions"><summary>Dokładne wykluczenia (${exclusions.length})</summary><div class="exclusion-items">${exclusions.map(exclusion => `<div><span>${esc(exclusion.title)}</span><form method="post" action="/monitors/${monitor.id}/exclusions/remove"><input type="hidden" name="externalId" value="${esc(exclusion.externalId)}"><button title="Przywróć tę pozycję">Przywróć</button></form></div>`).join("")}</div></details>` : ""}
    <div class="card-actions">
      <a class="button subtle" href="${esc(monitor.url)}" target="_blank" rel="noreferrer">Otwórz Allegro ↗</a>
      <form method="post" action="/monitors/${monitor.id}/delete" onsubmit="return confirm('Usunąć monitor wraz z historią ofert?')"><button class="button danger">Usuń</button></form>
    </div>
  </article>`;
}

function offerCard(listing: Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }): string {
  const exclusionLabel = listing.externalId.startsWith("product:") ? "Wyklucz to wydanie" : "Wyklucz tę ofertę";
  return `<article class="offer-card${listing.fromLatestCheck ? " latest" : ""}">
    <div class="offer-image">${listing.imageUrl ? `<img src="${esc(listing.imageUrl)}" alt="" loading="lazy">` : "<span>📖</span>"}</div>
    <div class="offer-content"><span class="eyebrow">${listing.fromLatestCheck ? `<span class="latest-label">Nowa</span> · ` : ""}${esc(listing.monitorName)} · ${date(listing.firstSeenAt)}</span>
      <a href="${esc(listing.url)}" target="_blank" rel="noreferrer">${esc(listing.title)}</a>
      <strong>${esc(listing.price || "Cena nieznana")}</strong><form class="exclude-form" method="post" action="/monitors/${listing.monitorId}/exclusions" onsubmit="return confirm('Ta dokładna pozycja nie będzie już uwzględniana. Kontynuować?')"><input type="hidden" name="externalId" value="${esc(listing.externalId)}"><button>${exclusionLabel}</button></form></div>
  </article>`;
}

export function renderPage(monitors: Monitor[], listings: Array<Listing & { monitorId: number; monitorName: string; firstSeenAt: string; fromLatestCheck: number }>, exclusions: MonitorExclusion[]): string {
  const activeMonitors = monitors.filter(monitor => monitor.enabled && monitor.initialized && monitor.activeClientsCount > 0 && !monitor.lastError).length;
  return renderLayout("Panel", `
    <section class="about"><span class="eyebrow">O aplikacji</span><h2>Lekki monitor nowych ofert Allegro</h2><p>Aplikacja współpracuje z rozszerzeniem Vivaldi, zapisuje znalezione oferty i wysyła powiadomienia o nowościach. Stworzyli ją wspólnie <strong>kCn</strong> i <strong>Codex</strong>.</p><p class="dedication">Powstała z inspiracji i specjalnie dla Wioli, która tak kocha książki 📚</p></section>
    <section><div class="section-head"><h2>Obserwowane wyszukiwania</h2><span>${activeMonitors}/${monitors.length} aktywnych</span></div>
      <div class="monitor-list">${monitors.length ? monitors.map(monitor => monitorCard(monitor, exclusions.filter(exclusion => exclusion.monitorId === monitor.id))).join("") : `<div class="empty"><strong>Jeszcze niczego nie obserwujesz</strong>Otwórz wyszukiwanie Allegro i dodaj je za pomocą rozszerzenia.</div>`}</div></section>
    <section><div class="section-head"><h2>Ostatnio znalezione oferty</h2><span>maksymalnie 50</span></div>
      ${listings.length ? `<div class="offers">${listings.map(offerCard).join("")}</div>` : `<div class="empty"><strong>Tu pojawią się książki</strong>Pierwsze sprawdzenie tworzy punkt odniesienia i nie wysyła powiadomień.</div>`}</section>
`);
}

export function renderLogin(error = false): string {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark"><title>Logowanie · Allegro Monitor</title>
  <script>try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch{}</script>
  <style>
  :root{--bg:#f3f4f6;--surface:#fff;--surface-2:#f8f8fa;--text:#17181a;--muted:#686c73;--line:#e2e4e8;--brand:#d8612c;--brand-hover:#bd4e20;--danger:#b42318;--danger-soft:#fff0ee;--shadow:0 18px 50px rgba(20,24,32,.12);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
  :root[data-theme="dark"]{--bg:#101113;--surface:#191b1f;--surface-2:#22252a;--text:#f2f3f4;--muted:#a5a9b0;--line:#31343a;--brand:#df7445;--brand-hover:#e58a63;--danger:#ff8a80;--danger-soft:#38201f;--shadow:0 20px 55px rgba(0,0,0,.38);color-scheme:dark}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 15%,color-mix(in srgb,var(--brand) 12%,transparent),transparent 36%),var(--bg);color:var(--text);font-size:15px;line-height:1.5}.shell{min-height:100vh;display:grid;place-items:center;padding:24px}.login{width:min(100%,430px);background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:30px;box-shadow:var(--shadow)}.brand{display:flex;gap:12px;align-items:center;margin-bottom:28px}.logo{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:var(--brand);color:#fff;font-size:22px;font-weight:700}.brand strong{display:block;font-size:17px}.brand span{color:var(--muted);font-size:12px}.welcome{margin-bottom:24px;text-align:center}.welcome h1{margin:0;font-size:27px;line-height:1.2;letter-spacing:-.02em}.welcome p{margin:6px 0 0;color:var(--muted);font-size:17px}.fields{display:grid;gap:15px}.field{display:grid;gap:6px}.field span{font-size:13px;font-weight:700}.field input{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);color:var(--text);font:inherit;padding:11px 12px;outline:none}.field input:focus{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 18%,transparent)}.remember{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:13px;cursor:pointer}.remember input{width:17px;height:17px;accent-color:var(--brand)}button{width:100%;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:750;padding:11px 15px;cursor:pointer}button:hover{background:var(--brand-hover)}.error{margin:0 0 16px;padding:10px 12px;border-radius:9px;background:var(--danger-soft);color:var(--danger);font-size:13px}.note{margin:18px 0 0;color:var(--muted);font-size:12px;text-align:center}@media(max-width:480px){.login{padding:24px}.welcome h1{font-size:24px}}
  </style></head><body><main class="shell"><section class="login"><div class="brand"><span class="logo">A</span><div><strong>Allegro Monitor</strong><span>Prywatny monitor książek</span></div></div><div class="welcome"><h1>Cześć, Wioluś 😘</h1><p>zechcesz się zalogować?</p></div>
  ${error ? '<p class="error" role="alert">Nieprawidłowa nazwa użytkownika lub hasło.</p>' : ""}
  <form method="post" action="/login" class="fields"><label class="field"><span>Użytkownik</span><input name="username" autocomplete="username" maxlength="100" required autofocus></label><label class="field"><span>Hasło</span><input type="password" name="password" autocomplete="current-password" maxlength="500" required></label><label class="remember"><input type="checkbox" name="remember" value="yes" checked> Zapamiętaj mnie na tym urządzeniu przez 30 dni</label><button type="submit">Zaloguj się</button></form><p class="note">Sesję możesz zakończyć przyciskiem „Wyloguj” w panelu.</p></section></main></body></html>`;
}
