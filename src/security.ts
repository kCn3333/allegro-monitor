import crypto from "node:crypto";

export interface OriginHeaders {
  "sec-fetch-site"?: string;
  origin?: string;
  host?: string;
  "x-forwarded-host"?: string | string[];
}

export function isSameOriginRequest(headers: OriginHeaders): boolean {
  const fetchSite = headers["sec-fetch-site"];
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
  if (fetchSite === "same-origin" || fetchSite === "none") return true;
  if (!headers.origin) return true;
  const rawForwardedHost = headers["x-forwarded-host"];
  const forwardedHost = String(Array.isArray(rawForwardedHost) ? rawForwardedHost[0] : rawForwardedHost || "").split(",", 1)[0]?.trim();
  const expectedHost = forwardedHost || headers.host;
  try { return Boolean(expectedHost) && new URL(headers.origin).host === expectedHost; } catch { return false; }
}

export const SESSION_COOKIE = "allegro_monitor_session";

export function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function credentialFingerprint(username: string, password: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(username).update("\0").update(password).digest("hex");
}

export function safeCredentialsEqual(actualUsername: string, actualPassword: string, username: string, password: string): boolean {
  const actual = Buffer.from(`${actualUsername}\0${actualPassword}`);
  const expected = Buffer.from(`${username}\0${password}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function sessionTokenFromCookie(cookieHeader: string | undefined): string | null {
  for (const part of (cookieHeader || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== SESSION_COOKIE) continue;
    const value = rawValue.join("=");
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(token: string, remember: boolean, secure: boolean): string {
  const attributes = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (secure) attributes.push("Secure");
  if (remember) attributes.push(`Max-Age=${30 * 24 * 60 * 60}`);
  return attributes.join("; ");
}

export function expiredSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;
}
