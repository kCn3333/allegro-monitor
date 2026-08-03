import path from "node:path";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: positiveInteger(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  databasePath: path.resolve(process.env.DATABASE_PATH || "./data/monitor.sqlite"),
  extensionZipPath: path.resolve(process.env.EXTENSION_ZIP_PATH || "./extension.zip"),
  timeZone: process.env.APP_TIME_ZONE || "Europe/Warsaw",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  username: process.env.APP_USERNAME || "",
  password: process.env.APP_PASSWORD || ""
};
