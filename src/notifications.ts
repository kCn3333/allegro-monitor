import type { Listing } from "./types.js";

export async function notifyTelegram(token: string, chatIds: string[], monitorName: string, listing: Listing): Promise<void> {
  if (!token || !chatIds.length) return;
  const text = [`📚 Nowa oferta: ${monitorName}`, listing.title, listing.price || "Cena nieznana", listing.url].join("\n");
  const results = await Promise.allSettled(chatIds.map(async chatId => {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
    });
    if (!response.ok) throw new Error(`Telegram (${chatId}) odpowiedział kodem ${response.status}`);
  }));
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), `Nie udało się wysłać ${failures.length} powiadomień Telegram`);
}
