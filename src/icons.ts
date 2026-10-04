import { faWindows, faLinux, faApple, faAndroid } from "@fortawesome/free-brands-svg-icons";
import { faTableCellsLarge, faLaptop, faCircleQuestion, faPuzzlePiece, faRightFromBracket,
  faPen, faLinkSlash, faDownload, faArrowUpRightFromSquare, faTrashCan, faLink,
  faMoon, faSun, faRightToBracket, faFloppyDisk, faEye, faBell, faPlus, faRotate, faCheck } from "@fortawesome/free-solid-svg-icons";

// Font Awesome Free by Fonticons, Inc. — CC BY 4.0. See THIRD_PARTY_NOTICES.md.
// Render only selected SVGs on the server; no browser library, fonts or CDN needed.
const icons = {
  windows: faWindows, linux: faLinux, apple: faApple, android: faAndroid,
  panel: faTableCellsLarge, devices: faLaptop, help: faCircleQuestion,
  extension: faPuzzlePiece, logout: faRightFromBracket, edit: faPen,
  unlink: faLinkSlash, download: faDownload, external: faArrowUpRightFromSquare,
  trash: faTrashCan, pair: faLink, moon: faMoon, sun: faSun,
  login: faRightToBracket, save: faFloppyDisk, eye: faEye, bell: faBell, add: faPlus, refresh: faRotate, check: faCheck
};

export function icon(name: keyof typeof icons): string {
  const [width, height, , , path] = icons[name].icon;
  const paths = Array.isArray(path) ? path : [path];
  return `<svg class="icon icon-${name}" viewBox="0 0 ${width} ${height}" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">${paths.map(d => `<path d="${d}"/>`).join("")}</svg>`;
}

export function systemIcon(system: string | null): string {
  const value = system || "";
  if (/^(windows|win32|win64|win)/i.test(value)) return icon("windows");
  if (/android/i.test(value)) return icon("android");
  if (/linux|ubuntu|debian|fedora/i.test(value)) return icon("linux");
  if (/mac|darwin|ios/i.test(value)) return icon("apple");
  return "";
}
