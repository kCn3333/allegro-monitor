import path from "node:path";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: positiveInteger(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  databasePath: path.resolve(process.env.DATABASE_PATH || "./data/monitor.sqlite"),
  tickSeconds: positiveInteger(process.env.CHECK_TICK_SECONDS, 30),
  browserProfilePath: path.resolve(process.env.BROWSER_PROFILE_PATH || "./data/browser-profile"),
  browserHeadless: process.env.BROWSER_HEADLESS?.toLowerCase() === "true",
  diagnosticsPath: path.resolve(process.env.DIAGNOSTICS_PATH || "./data/diagnostics"),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  username: process.env.APP_USERNAME || "",
  password: process.env.APP_PASSWORD || ""
};
