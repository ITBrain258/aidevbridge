// Tooltips mit Kuerzel (UX-Spec §8.4): die `title`-Texte nennen das Kuerzel aus
// der aktiven Tabelle, nach dem Muster aus en.json ("{label} ({shortcut})"),
// ohne Literal im Code. Der zugaengliche Name (`aria-label`, sichtbarer Text)
// bleibt die blosse Beschriftung. Eigene Tooltip-Komponenten kommen spaeter.
import en from "../i18n/en.json";
import { DEFAULT_KEYMAP, type KeymapAction } from "../keymap";

export function titleWithShortcut(
  label: string,
  action: KeymapAction,
  keymap: Readonly<Record<KeymapAction, string>> = DEFAULT_KEYMAP,
): string {
  const values: Record<string, string> = { label, shortcut: keymap[action] };
  // Ein Durchgang: eine Beschriftung, die selbst `{shortcut}` enthaelt, bleibt
  // stehen, statt ein zweites Mal ersetzt zu werden.
  return en["app.titleWithShortcut"].replace(/\{(label|shortcut)\}/g, (_match, name: string) => values[name]);
}
