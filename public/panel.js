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
})();
