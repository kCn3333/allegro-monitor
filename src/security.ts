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
