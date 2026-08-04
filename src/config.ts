import path from "node:path";

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
  extensionZipPath: path.resolve(process.env.EXTENSION_ZIP_PATH || "./extension.zip"),
  timeZone: process.env.APP_TIME_ZONE || "Europe/Warsaw",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatIds: chatIds(process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || ""),
  listingRetentionChecks: positiveInteger(process.env.LISTING_RETENTION_CHECKS, 5),
  username: process.env.APP_USERNAME || "",
  password: process.env.APP_PASSWORD || ""
};
