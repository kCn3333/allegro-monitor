import path from "node:path";
import { loadEnvFile } from "node:process";

try { loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function chatIds(value: string): string[] {
  return [...new Set(value.split(",").map(item => item.trim()).filter(item => /^-?\d+$/.test(item)))];
}

export const config = {
  port: positiveInteger(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  databasePath: path.resolve(process.env.DATABASE_PATH || "./data/monitor.sqlite"),
  publicUrl: process.env.APP_PUBLIC_URL || "",
  extensionDirectory: path.resolve(process.env.EXTENSION_DIRECTORY || "./extension"),
  timeZone: process.env.APP_TIME_ZONE || "Europe/Warsaw",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatIds: chatIds(process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || ""),
  listingRetentionChecks: positiveInteger(process.env.LISTING_RETENTION_CHECKS, 5),
  username: process.env.APP_USERNAME || "",
  password: process.env.APP_PASSWORD || "",
  sessionSecret: process.env.APP_SESSION_SECRET || ""
};
