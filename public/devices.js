setInterval(async () => {
  if (document.hidden || document.querySelector(".device-list .rename[open]")) return;
  try {
    const response = await fetch("/devices");
    if (!response.ok || response.redirected) return;
    if (document.querySelector(".device-list .rename[open]")) return;
    const next = new DOMParser().parseFromString(await response.text(), "text/html");
    for (const selector of [".hero", ".device-list"]) {
      const current = document.querySelector(selector);
      const updated = next.querySelector(selector);
      if (current && updated) current.replaceWith(updated);
    }
  } catch {}
}, 60000);
