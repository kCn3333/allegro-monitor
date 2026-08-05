import type { Listing } from "./types.js";

async function send(token: string, method: "sendPhoto" | "sendMessage", body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function notifyTelegram(token: string, chatIds: string[], monitorName: string, listing: Listing): Promise<void> {
  if (!token || !chatIds.length) return;
  const caption = [`📚 Nowa oferta · ${monitorName}`, "", listing.title, `💰 ${listing.price || "Cena nieznana"}`].join("\n");
  const replyMarkup = { inline_keyboard: [[{ text: "Otwórz ofertę ↗", url: listing.url }]] };
  const results = await Promise.allSettled(chatIds.map(async chatId => {
    let response: Response | null = null;
    if (listing.imageUrl) {
      response = await send(token, "sendPhoto", {
        chat_id: chatId,
        photo: listing.imageUrl,
        caption,
        reply_markup: replyMarkup
      });
    }
    if (!response?.ok) {
      response = await send(token, "sendMessage", {
        chat_id: chatId,
        text: caption,
        reply_markup: replyMarkup,
        disable_web_page_preview: true
      });
    }
    if (!response.ok) throw new Error(`Telegram (${chatId}) odpowiedział kodem ${response.status}`);
  }));
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), `Nie udało się wysłać ${failures.length} powiadomień Telegram`);
}
