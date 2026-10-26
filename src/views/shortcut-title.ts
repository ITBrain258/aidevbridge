// Tooltips mit Kuerzel (UX-Spec §8.4): die `title`-Texte nennen das Kuerzel aus
// der aktiven Tabelle, nach dem Muster aus en.json ("{label} ({shortcut})"),
// ohne Literal im Code. Der zugaengliche Name (`aria-label`, sichtbarer Text)
// bleibt die blosse Beschriftung. Eigene Tooltip-Komponenten kommen spaeter.
import { t } from "../i18n/t";
import { DEFAULT_KEYMAP, type KeymapAction } from "../keymap";

export function titleWithShortcut(
  label: string,
  action: KeymapAction,
  keymap: Readonly<Record<KeymapAction, string>> = DEFAULT_KEYMAP,
): string {
  // `t` ersetzt in einem Durchgang: eine Beschriftung, die selbst
  // `{shortcut}` enthaelt, bleibt stehen, statt ein zweites Mal ersetzt zu werden.
  return t("app.titleWithShortcut", { label, shortcut: keymap[action] });
}
