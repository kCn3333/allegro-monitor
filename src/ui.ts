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
        <div class="monitor-name"><h3>${esc(monitor.name)}</h3><details class="rename"><summary aria-label="Edytuj nazwę" title="Edytuj nazwę">✎</summary><form method="post" action="/monitors/${monitor.id}/rename"><input name="name" value="${esc(monitor.name)}" maxlength="100" required><button>Zapisz</button></form></details></div><p>${esc(queryLabel(monitor.url))}</p>
      </div></div>
      <div class="monitor-status">${monitor.lastCheckNewCount > 0 ? `<span class="new-count" title="Nowe w ostatnim sprawdzeniu">+${monitor.lastCheckNewCount}</span>` : ""}<span class="status-pill ${state.className}">${state.label}</span><form class="toggle-form" method="post" action="/monitors/${monitor.id}/toggle"><label class="switch" title="${monitor.enabled ? "Wstrzymaj monitor" : "Wznów monitor"}"><input type="checkbox" ${monitor.enabled ? "checked" : ""} onchange="this.form.submit()" aria-label="${monitor.enabled ? "Wstrzymaj monitor" : "Wznów monitor"}"><span></span></label></form></div>
    </div>
    <dl class="monitor-meta">
      <div><dt>Sprawdzanie</dt><dd>co ${monitor.intervalMinutes} min</dd></div>
      <div><dt>Śledzone pozycje</dt><dd>${monitor.currentListingsCount}</dd></div>
      <div><dt>Wykryte nowości</dt><dd>${monitor.newListingsCount}</dd></div>
      <div><dt>Wykluczenia</dt><dd>${monitor.excludedListingsCount}</dd></div>
      <div><dt>Aktywne urządzenia</dt><dd>${monitor.activeClientsCount}</dd></div>
      <div><dt>Ostatnia próba</dt><dd>${date(monitor.lastCheckedAt)}</dd></div>
      <div><dt>Monitor dodany</dt><dd>${day(monitor.createdAt)}</dd></div>
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
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark"><title>Allegro Monitor</title>
  <script>try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch{}</script>
  <style>
  :root{--bg:#f3f4f6;--surface:#fff;--surface-2:#f8f8fa;--text:#17181a;--muted:#686c73;--line:#e2e4e8;--brand:#d8612c;--brand-hover:#bd4e20;--brand-soft:#faeee8;--danger:#b42318;--danger-soft:#fff0ee;--shadow:0 8px 26px rgba(20,24,32,.07);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
  :root[data-theme="dark"]{--bg:#101113;--surface:#191b1f;--surface-2:#22252a;--text:#f2f3f4;--muted:#a5a9b0;--line:#31343a;--brand:#df7445;--brand-hover:#e58a63;--brand-soft:#35251e;--danger:#ff8a80;--danger-soft:#38201f;--shadow:0 10px 30px rgba(0,0,0,.28);color-scheme:dark}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:15px;line-height:1.5}.shell{width:min(1180px,calc(100% - 32px));margin:auto;padding:32px 0 64px}.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.brand{display:flex;gap:12px;align-items:center}.logo{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:var(--brand);color:white;font-size:22px}.brand h1{font-size:20px;margin:0}.brand p{margin:1px 0 0;color:var(--muted);font-size:13px}.theme-toggle{display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:10px;padding:0;cursor:pointer;font-size:19px}.theme-toggle:hover{border-color:var(--brand);color:var(--brand)}.about{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px 24px;box-shadow:var(--shadow);margin-bottom:34px}.about h2{font-size:20px;margin:0 0 6px}.about p{color:var(--muted);margin:4px 0;max-width:850px}.about .dedication{color:var(--text);margin-top:12px}.eyebrow{display:block;color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:1px solid transparent;border-radius:9px;padding:7px 12px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer;white-space:nowrap}.primary{background:var(--brand);color:#fff}.primary:hover{background:var(--brand-hover)}.subtle{border-color:var(--line);background:var(--surface);color:var(--text)}.danger{background:transparent;color:var(--danger)}.section-head{display:flex;justify-content:space-between;align-items:end;margin:34px 0 14px}.section-head h2{font-size:21px;margin:0}.section-head span{color:var(--muted);font-size:13px}.monitor-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.monitor-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.monitor-main{display:flex;justify-content:space-between;gap:12px}.monitor-title{display:flex;align-items:flex-start;gap:9px;min-width:0}.monitor-title>div{min-width:0}.monitor-title h3{margin:0;font-size:16px}.monitor-title p{margin:2px 0 0;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status-dot{width:9px;height:9px;border-radius:50%;margin-top:7px;flex:0 0 auto}.status-dot.healthy{background:#22a35a}.status-dot.failed{background:#e5484d}.status-dot.waiting{background:#e5a000}.status-dot.paused{background:#858b94}.status-pill{font-size:11px;padding:4px 8px;border-radius:99px;height:max-content;white-space:nowrap}.status-pill.healthy{color:#168044;background:#e6f7ed}.status-pill.failed{color:var(--danger);background:var(--danger-soft)}.status-pill.waiting{color:#8a6200;background:#fff5d6}.status-pill.paused{color:var(--muted);background:var(--surface-2)}[data-theme="dark"] .status-pill.healthy{background:#173525;color:#76d99b}[data-theme="dark"] .status-pill.waiting{background:#382f16;color:#f2c85b}.monitor-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 14px;margin:15px 0}.monitor-meta div{display:grid;gap:1px}.monitor-meta dt{font-size:11px;color:var(--muted)}.monitor-meta dd{margin:0;font-size:13px;font-weight:650}.alert{display:grid;gap:3px;background:var(--danger-soft);color:var(--danger);padding:9px 11px;border-radius:9px;font-size:12px;margin-bottom:12px}.alert span{overflow-wrap:anywhere}.card-actions{display:flex;gap:7px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:11px}.card-actions form{margin:0}.empty{padding:38px;text-align:center;color:var(--muted);background:var(--surface);border:1px dashed var(--line);border-radius:14px}.empty strong{display:block;color:var(--text);font-size:16px;margin-bottom:4px}.offers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.offer-card{display:flex;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:13px}.offer-image{display:grid;place-items:center;width:72px;height:82px;flex:0 0 auto;border-radius:8px;background:var(--surface-2);overflow:hidden;font-size:25px}.offer-image img{width:100%;height:100%;object-fit:contain}.offer-content{display:flex;min-width:0;flex-direction:column;gap:4px}.offer-content a{color:var(--text);font-weight:700;text-decoration:none;line-height:1.35}.offer-content a:hover{color:var(--brand)}.offer-content strong{margin-top:auto;color:var(--brand)}
  .top-actions,.monitor-status{display:flex;align-items:center;gap:8px}.new-count{display:inline-flex;align-items:center;justify-content:center;min-width:29px;padding:4px 9px;border-radius:99px;background:#dff6e8;color:#157a43;font-size:12px;font-weight:800}[data-theme="dark"] .new-count{background:#173a27;color:#7bdda2}.exclusions{margin:0 0 14px;color:var(--muted);font-size:12px}.exclusions summary{cursor:pointer;font-weight:700}.exclusion-items{display:grid;gap:6px;margin-top:8px}.exclusion-items>div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 9px;background:var(--surface-2);border-radius:8px}.exclusion-items span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.exclusion-items form,.exclude-form{margin:0}.exclusion-items button,.exclude-form button{border:0;background:transparent;color:var(--muted);font:inherit;cursor:pointer;padding:2px}.exclusion-items button:hover,.exclude-form button:hover{color:var(--brand)}.exclude-form{margin-top:4px}.exclude-form button{font-size:11px;text-align:left}
  .toggle-form{margin:0}.switch{display:block;position:relative;width:34px;height:20px;cursor:pointer}.switch input{position:absolute;opacity:0;pointer-events:none}.switch span{position:absolute;inset:0;border-radius:99px;background:#a9adb3;transition:.18s}.switch span:after{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0004;transition:.18s}.switch input:checked+span{background:#238a51}.switch input:checked+span:after{transform:translateX(14px)}.switch input:focus-visible+span{outline:2px solid var(--brand);outline-offset:2px}
  .offer-card.latest{border-color:#8dcfab;background:linear-gradient(135deg,var(--surface),#edf9f2)}[data-theme="dark"] .offer-card.latest{border-color:#376e4d;background:linear-gradient(135deg,var(--surface),#17271e)}.latest-label{color:#157a43;font-weight:850}[data-theme="dark"] .latest-label{color:#7bdda2}.monitor-name{display:flex;align-items:center;gap:6px}.rename{position:relative}.rename summary{display:grid;place-items:center;width:25px;height:25px;border-radius:7px;color:var(--muted);cursor:pointer;list-style:none;font-size:15px}.rename summary::-webkit-details-marker{display:none}.rename summary:hover{color:var(--brand);background:var(--surface-2)}.rename form{position:absolute;z-index:5;top:30px;left:-120px;display:flex;gap:6px;width:280px;padding:9px;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow)}.rename input{min-width:0;flex:1;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--text);font:inherit;padding:7px 8px}.rename button{border:0;border-radius:7px;background:var(--brand);color:#fff;font:inherit;font-weight:700;padding:7px 9px;cursor:pointer}
  @media(max-width:900px){.monitor-list{grid-template-columns:1fr}}
  @media(max-width:760px){.shell{width:min(100% - 20px,1080px);padding-top:18px}.about{padding:20px}.offers{grid-template-columns:1fr}.monitor-main{align-items:flex-start}.monitor-meta{grid-template-columns:repeat(2,minmax(0,1fr))}.card-actions{display:grid;grid-template-columns:1fr 1fr}.card-actions .button,.card-actions form button{width:100%}.brand p{display:none}.monitor-status{flex-wrap:wrap;justify-content:flex-end}}
  @media(max-width:760px){.rename form{position:fixed;top:110px;left:20px;right:20px;width:auto}}
  </style></head><body><main class="shell">
    <header class="topbar"><div class="brand"><span class="logo">A</span><div><h1>Allegro Monitor</h1><p>Obserwuj rzadkie książki bez ciągłego odświeżania</p></div></div><div class="top-actions"><a class="button subtle" href="/faq">FAQ</a><a class="button primary" href="/extension">Rozszerzenie</a><button class="theme-toggle" type="button" id="theme-toggle" aria-label="Włącz ciemny motyw" title="Włącz ciemny motyw"><span aria-hidden="true">☾</span></button></div></header>
    <section class="about"><span class="eyebrow">O aplikacji</span><h2>Lekki monitor nowych ofert Allegro</h2><p>Aplikacja współpracuje z rozszerzeniem Vivaldi, zapisuje znalezione oferty i wysyła powiadomienia o nowościach. Stworzyli ją wspólnie <strong>kCn</strong> i <strong>Codex</strong>.</p><p class="dedication">Powstała z inspiracji i specjalnie dla Wioli, która tak kocha książki 📚</p></section>
    <section><div class="section-head"><h2>Obserwowane wyszukiwania</h2><span>${activeMonitors}/${monitors.length} aktywnych</span></div>
      <div class="monitor-list">${monitors.length ? monitors.map(monitor => monitorCard(monitor, exclusions.filter(exclusion => exclusion.monitorId === monitor.id))).join("") : `<div class="empty"><strong>Jeszcze niczego nie obserwujesz</strong>Otwórz wyszukiwanie Allegro i dodaj je za pomocą rozszerzenia.</div>`}</div></section>
    <section><div class="section-head"><h2>Ostatnio znalezione oferty</h2><span>maksymalnie 50</span></div>
      ${listings.length ? `<div class="offers">${listings.map(offerCard).join("")}</div>` : `<div class="empty"><strong>Tu pojawią się książki</strong>Pierwsze sprawdzenie tworzy punkt odniesienia i nie wysyła powiadomień.</div>`}</section>
  </main><script>
  const root=document.documentElement,toggle=document.getElementById('theme-toggle');
  const resolvedTheme=()=>root.dataset.theme||((matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light');
  const updateThemeIcon=()=>{if(!toggle)return;const dark=resolvedTheme()==='dark';toggle.querySelector('span').textContent=dark?'☀':'☾';toggle.setAttribute('aria-label',dark?'Włącz jasny motyw':'Włącz ciemny motyw');toggle.title=toggle.getAttribute('aria-label')};
  updateThemeIcon();toggle?.addEventListener('click',()=>{const next=resolvedTheme()==='dark'?'light':'dark';root.dataset.theme=next;localStorage.setItem('theme',next);updateThemeIcon()});
  </script></body></html>`;
}
