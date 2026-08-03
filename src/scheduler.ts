import { AllegroClient } from "./allegro.js";
import { config } from "./config.js";
import type { Store } from "./database.js";
import { notifyTelegram } from "./notifications.js";

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly store: Store) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), config.tickSeconds * 1000);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const monitors = this.store.dueMonitors();
    if (monitors.length === 0) return;
    this.running = true;
    const client = new AllegroClient();
    try {
      try {
        await client.start();
      } catch (error) {
        for (const monitor of monitors) this.store.saveError(monitor, error);
        return;
      }
      for (const monitor of monitors) {
        try {
          const listings = await client.fetch(monitor.url);
          const fresh = this.store.saveCheck(monitor, listings);
          for (const listing of fresh) {
            await notifyTelegram(config.telegramBotToken, config.telegramChatId, monitor.name, listing);
          }
        } catch (error) {
          this.store.saveError(monitor, error);
        }
      }
    } finally {
      await client.stop().catch(() => undefined);
      this.running = false;
    }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}
