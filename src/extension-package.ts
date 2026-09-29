import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const assets = ["service-worker.js", "popup.js", "popup.html", "popup.css", "icon-128.png", "icon.svg"];

export function publicBackendUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("APP_PUBLIC_URL musi być publicznym adresem HTTPS serwera"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname.includes("*")) {
    throw new Error("APP_PUBLIC_URL wymaga HTTPS, bez danych logowania, ścieżki, query i fragmentu");
  }
  return url;
}

export async function buildExtensionPackage(publicUrl: string, directory: string): Promise<Buffer> {
  const url = publicBackendUrl(publicUrl);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "allegro-extension-"));
  try {
    for (const asset of assets) await fs.copyFile(path.join(directory, asset), path.join(temporary, asset));
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
    manifest.host_permissions = [...new Set(["https://allegro.pl/*", "https://*.allegro.pl/*", `https://${url.hostname}/*`])];
    await fs.writeFile(path.join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2));
    // Only the public origin is embedded. Never copy .env or serialize process.env.
    await fs.writeFile(path.join(temporary, "backend-config.js"), `export const BACKEND_URL = ${JSON.stringify(url.origin)};\n`);
    const archive = path.join(temporary, "extension.zip");
    await run("zip", ["-q", archive, ...assets, "manifest.json", "backend-config.js"], { cwd: temporary, timeout: 15000 });
    return await fs.readFile(archive);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
