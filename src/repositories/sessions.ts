import type { DatabaseSync } from "node:sqlite";

export class SessionsRepository {
  private nextSessionCleanupAt?: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  createWebSession(tokenHash: string, credentialFingerprint: string, durationSeconds: number): void {
    const now = new Date(this.now());
    this.db
      .prepare(`INSERT INTO web_sessions
      (token_hash,credential_fingerprint,duration_seconds,expires_at,last_used_at,created_at) VALUES(?,?,?,?,?,?)`)
      .run(
        tokenHash,
        credentialFingerprint,
        durationSeconds,
        new Date(now.getTime() + durationSeconds * 1000).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
  }

  touchWebSession(tokenHash: string, credentialFingerprint: string): number | null {
    const time = this.now();
    const now = new Date(time);
    if (this.nextSessionCleanupAt === undefined || time >= this.nextSessionCleanupAt) {
      this.db.prepare("DELETE FROM web_sessions WHERE expires_at<=?").run(now.toISOString());
      this.nextSessionCleanupAt = time + 5 * 60_000;
    }
    const session = this.db
      .prepare(`SELECT id,duration_seconds durationSeconds FROM web_sessions
      WHERE token_hash=? AND credential_fingerprint=? AND expires_at>?`)
      .get(tokenHash, credentialFingerprint, now.toISOString()) as { id: number; durationSeconds: number } | undefined;
    if (!session) return null;
    this.db
      .prepare("UPDATE web_sessions SET expires_at=?,last_used_at=? WHERE id=?")
      .run(new Date(now.getTime() + session.durationSeconds * 1000).toISOString(), now.toISOString(), session.id);
    return session.durationSeconds;
  }

  deleteWebSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash=?").run(tokenHash);
  }
}
