import path from "node:path";
import { loadEnvFile } from "node:process";
import { isIP } from "node:net";

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

export function parseTrustProxy(value: string | undefined): false | string[] {
  if (!value?.trim()) return false;
  const addresses = value.split(",").map(item => item.trim());
  for (const entry of addresses) {
    const parts = entry.split("/");
    const address = parts[0] || "";
    const family = isIP(address);
    const prefix = parts[1];
    if (!family || address.includes("%") || parts.length > 2 ||
      (prefix !== undefined && (!/^(0|[1-9]\d*)$/.test(prefix) || (Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128))))) {
      throw new Error("Nieprawidłowe TRUST_PROXY: wymagana lista adresów IP/CIDR rozdzielonych przecinkami; wartości logiczne, liczba hopów i zakresy /0 nie są dozwolone");
    }
  }
  return addresses;
}

export const config = {
  port: positiveInteger(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
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
