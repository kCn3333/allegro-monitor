import { readFileSync } from "node:fs";

export const appVersion: string = JSON.parse(readFileSync("package.json", "utf8")).version;
export const brandLogo = '<img class="logo" src="/assets/logo.png" width="44" height="44" alt="">';
export const brandHead = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">';

// Only these public files are served; no arbitrary filesystem paths are accepted.
export const brandAssets = new Map([
  ["/assets/logo.png", { type: "image/png", body: readFileSync("public/logo.png") }],
  ["/favicon.ico", { type: "image/x-icon", body: readFileSync("public/favicon.ico") }],
  ["/apple-touch-icon.png", { type: "image/png", body: readFileSync("public/apple-touch-icon.png") }]
]);
