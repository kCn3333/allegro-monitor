import type { Listing } from "./types.js";

export async function notifyTelegram(token: string, chatId: string, monitorName: string, listing: Listing): Promise<void> {
  if (!token || !chatId) return;
  const text = [`📚 Nowa oferta: ${monitorName}`, listing.title, listing.price || "Cena nieznana", listing.url].join("\n");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
  });
  if (!response.ok) throw new Error(`Telegram odpowiedział kodem ${response.status}`);
}
