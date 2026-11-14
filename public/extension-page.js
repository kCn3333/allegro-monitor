(() => {
  const generate = document.getElementById("generate");
  const code = document.getElementById("code");
  generate.addEventListener("click", async () => {
    generate.disabled = true;
    code.textContent = "Generowanie…";
    try {
      const response = await fetch("/api/extension/pairing-code", { method: "POST" });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error();
      const data = await response.json();
      code.textContent = data.code || "Nie udało się wygenerować kodu.";
    } catch {
      code.textContent = "Nie udało się wygenerować kodu. Odśwież stronę i spróbuj ponownie.";
    } finally {
      generate.disabled = false;
    }
  });
})();
