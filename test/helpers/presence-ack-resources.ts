import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/database.js";
import { config } from "../../src/config.js";
import { buildApp } from "../../src/server.js";

export function presenceAckResources(t: TestContext, prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(directory, "test.sqlite");
  const now = () => 1800000000000;
  let store: Store | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let db: DatabaseSync | undefined;
  t.after(() =>
    Promise.resolve()
      .then(() => app?.close())
      .finally(() => db?.close())
      .finally(() => store?.close())
      .finally(() => fs.rmSync(directory, { recursive: true, force: true })),
  );
  store = new Store(databasePath, undefined, now);
  async function startApp() {
    app = await buildApp({
      config: { ...config, databasePath, publicUrl: "", username: "", password: "", telegramBotToken: "" },
      startWorker: false,
      now,
    });
    db = new DatabaseSync(databasePath);
    return { app, db };
  }
  return { store, startApp };
}
