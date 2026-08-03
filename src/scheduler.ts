import { AllegroClient } from "./allegro.js";
import { config } from "./config.js";
import type { Store } from "./database.js";
import { notifyTelegram } from "./notifications.js";

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly client = new AllegroClient();
  private browserReady: Promise<void> | null = null;

  constructor(private readonly store: Store) {}

  start(): void {
    this.browserReady = this.client.start();
    this.timer = setInterval(() => void this.tick(), config.tickSeconds * 1000);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const monitors = this.store.dueMonitors();
    if (monitors.length === 0) return;
    this.running = true;
    try {
      try {
        await this.browserReady;
      } catch (error) {
        for (const monitor of monitors) this.store.saveError(monitor, error);
        return;
      }
      for (const monitor of monitors) {
        try {
          const listings = await this.client.fetch(monitor.url);
          const fresh = this.store.saveCheck(monitor, listings);
          for (const listing of fresh) {
            await notifyTelegram(config.telegramBotToken, config.telegramChatId, monitor.name, listing);
          }
        } catch (error) {
          this.store.saveError(monitor, error);
          if (error instanceof Error && /captcha/i.test(error.message)) break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.client.stop().catch(() => undefined);
  }
}
