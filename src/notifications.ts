import type { Listing } from "./types.js";
import type { Store } from "./database.js";

export class TelegramError extends Error {
  constructor(message: string, readonly permanent = false, readonly retryAfterMs = 0) { super(message); }
}

export async function deliverTelegram(token: string, chatId: string, monitorName: string, listing: Listing,
  fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<void> {
  const caption = [`📚 Nowa oferta · ${monitorName}`, "", listing.title, `💰 ${listing.price || "Cena nieznana"}`].join("\n");
  const common = { chat_id: chatId, reply_markup: { inline_keyboard: [[{ text: "Otwórz ofertę ↗", url: listing.url }]] } };
  async function send(method: string, body: object) {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...common, ...body }), signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };
    const status = data.error_code || response.status;
    if (response.ok && data.ok !== false) return;
    throw new TelegramError(`Telegram HTTP ${status}`, status >= 400 && status < 500 && status !== 429 && status !== 408,
      status === 429 ? Math.max(1000, Number(data.parameters?.retry_after || 1) * 1000) : 0);
  }
  if (listing.imageUrl) {
    try { await send("sendPhoto", { photo: listing.imageUrl, caption }); return; }
    catch (error) {
      // Only a bad image request permits text fallback, never rate limits or ambiguous network failures.
      if (!(error instanceof TelegramError) || error.message !== "Telegram HTTP 400") throw error;
    }
  }
  await send("sendMessage", { text: caption, disable_web_page_preview: true });
}

export async function notifyTelegram(token: string, chatIds: string[], monitorName: string, listing: Listing): Promise<void> {
  if (!token) return;
  for (const chatId of chatIds) await deliverTelegram(token, chatId, monitorName, listing);
}

export class TelegramWorker {
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: Store, private token: string,
    private deliver: typeof deliverTelegram = deliverTelegram, private now = Date.now) {}
  runOnce(): Promise<void> {
    if (!this.token) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.process().finally(() => { this.running = null; });
    return this.running;
  }
  private async process(): Promise<void> {
    const job = this.store.claimTelegramJob(this.now());
    if (!job) return;
    try {
      await this.deliver(this.token, job.chatId, job.monitorName, job.listing);
      this.store.finishTelegramJob(job, undefined, this.now());
    } catch (error) {
      this.store.finishTelegramJob(job, error instanceof TelegramError ? error
        : { permanent: false, retryAfterMs: 0, message: "Telegram network failure or timeout" }, this.now());
    }
  }
  start(): void {
    if (!this.token || this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => {}); }, 1000);
    this.timer.unref();
  }
  async stop(): Promise<void> { clearInterval(this.timer); await this.running; }
}
