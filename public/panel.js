(() => {
  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  const resolvedTheme = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const updateThemeIcon = () => {
    if (!toggle) return;
    const dark = resolvedTheme() === "dark";
    for (const icon of toggle.querySelectorAll("[data-theme-icon]")) {
      icon.hidden = icon.dataset.themeIcon !== (dark ? "sun" : "moon");
    }
    const label = dark ? "Włącz jasny motyw" : "Włącz ciemny motyw";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  };
  updateThemeIcon();
  toggle?.addEventListener("click", () => {
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    updateThemeIcon();
  });

  // Delegation also covers device cards replaced by the periodic refresh.
  document.addEventListener("submit", event => {
    const form = event.target;
    if (form instanceof HTMLFormElement && form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
      event.preventDefault();
    }
  });
  document.addEventListener("change", event => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.matches('.toggle-form input[type="checkbox"]')) {
      input.form?.requestSubmit();
    }
  });

  if (!document.querySelector(".monitor-list")) return;
  let refreshing = false;
  setInterval(async () => {
    const editing = () => document.querySelector('.monitor-list .rename[open]')
      || document.activeElement?.matches(".monitor-list input, .monitor-list button, .monitor-list summary");
    if (refreshing || document.hidden || editing()) return;
    refreshing = true;
    try {
      const response = await fetch("/", { cache: "no-store" });
      if (!response.ok || response.redirected) return;
      const next = new DOMParser().parseFromString(await response.text(), "text/html");
      if (editing()) return;
      const animations = [];
      for (const current of document.querySelectorAll(".monitor-card[data-monitor-id]")) {
        const updated = next.querySelector(`.monitor-card[data-monitor-id="${current.dataset.monitorId}"]`);
        if (!updated) { current.remove(); continue; }
        const checked = updated.dataset.lastCheck && updated.dataset.lastCheck !== current.dataset.lastCheck;
        // Preserve focus and open controls when the server returned an unchanged card.
        if (current.outerHTML === updated.outerHTML) continue;
        current.replaceWith(updated);
        if (!checked) continue;
        updated.classList.add("is-checking");
        updated.setAttribute("aria-busy", "true");
        updated.querySelector(".check-feedback").hidden = false;
        // The status stays accessible; only interactive content is disabled.
        const controls = updated.querySelectorAll("a, button, input, summary");
        for (const control of controls) {
          control.inert = true;
          if ("disabled" in control) control.disabled = true;
        }
        animations.push(new Promise(resolve => setTimeout(() => {
          updated.classList.remove("is-checking");
          updated.removeAttribute("aria-busy");
          updated.querySelector(".check-feedback").hidden = true;
          for (const control of controls) {
            control.inert = false;
            if ("disabled" in control) control.disabled = false;
          }
          resolve();
        }, 3500)));
      }
      const list = document.querySelector(".monitor-list");
      for (const card of next.querySelectorAll(".monitor-card[data-monitor-id]")) {
        if (!list.querySelector(`.monitor-card[data-monitor-id="${card.dataset.monitorId}"]`)) list.append(card);
      }
      if (list.querySelector(".monitor-card")) list.querySelector(".empty")?.remove();
      else if (next.querySelector(".monitor-list .empty")) list.replaceChildren(next.querySelector(".monitor-list .empty"));
      for (const section of document.querySelectorAll("main > section")) {
        const heading = section.querySelector("h2");
        const updated = [...next.querySelectorAll("main > section")].find(item => item.querySelector("h2")?.textContent === heading?.textContent);
        if (!updated) continue;
        const count = section.querySelector(".section-head > span");
        if (count) count.textContent = updated.querySelector(".section-head > span")?.textContent || "";
        if (heading?.textContent === "Ostatnio znalezione oferty" && section.outerHTML !== updated.outerHTML) section.replaceWith(updated);
      }
      await Promise.all(animations);
    } catch {} finally { refreshing = false; }
  }, 5000);
})();
