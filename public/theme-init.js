// Run before styles and body are parsed to avoid flashing the wrong theme.
(() => {
  let theme;
  try { theme = localStorage.getItem("theme"); } catch {}
  document.documentElement.dataset.theme = theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
})();
