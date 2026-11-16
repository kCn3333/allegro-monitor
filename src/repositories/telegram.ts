import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../types.js";

export class TelegramRepository {
  private nextTelegramCleanupAt?: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  claimTelegramJob(now = this.now()): TelegramJob | undefined {
    if (this.nextTelegramCleanupAt === undefined || now >= this.nextTelegramCleanupAt) {
      this.db.prepare("DELETE FROM telegram_jobs WHERE finished_at<?").run(now - 30 * 86400_000);
      this.nextTelegramCleanupAt = now + 5 * 60_000;
    }
    // Lease also recovers work interrupted by process termination. One bounded worker per process.
    const row = this.db
      .prepare(`UPDATE telegram_jobs SET status='sending',attempts=attempts+1,available_at=?
      WHERE id=(SELECT id FROM telegram_jobs WHERE status IN ('pending','sending') AND available_at<=? ORDER BY id LIMIT 1)
      RETURNING id,chat_id chatId,payload,attempts`)
      .get(now + 60_000, now) as { id: number; chatId: string; payload: string; attempts: number } | undefined;
    return row ? { ...row, ...JSON.parse(row.payload) } : undefined;
  }

  finishTelegramJob(
    job: TelegramJob,
    error?: { permanent: boolean; retryAfterMs: number; message: string },
    now = this.now(),
  ): void {
    const terminal = !error || error.permanent || job.attempts >= 12;
    this.db
      .prepare(
        "UPDATE telegram_jobs SET status=?,available_at=?,finished_at=?,last_error=? WHERE id=? AND attempts=? AND status='sending'",
      )
      .run(
        !error ? "sent" : terminal ? "failed" : "pending",
        now + Math.max(error?.retryAfterMs || 0, Math.min(3600_000, 1000 * 2 ** job.attempts)),
        terminal ? now : null,
        error?.message || null,
        job.id,
        job.attempts,
      );
  }
}

export interface TelegramJob {
  id: number;
  chatId: string;
  monitorName: string;
  listing: Listing;
  attempts: number;
}
