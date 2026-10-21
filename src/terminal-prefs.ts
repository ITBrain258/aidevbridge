// Einstellungen der Terminals (Spec §6.1, §6.3, §6.4, §6.7). Modulzustand nach
// dem Muster von `theme.ts`: `terminal.ts` liest den Stand bei jedem
// Tastendruck, die Einstellungen, das Mausrad und die Tasten der Schriftgroesse
// schreiben ihn, und `main.ts` reicht jede Aenderung weiter (Kacheln,
// `settings.toml`). Bis die Werte aus `settings.toml` kommen (Spec §9.2),
// gelten die Standards.

export type RightClickMode = "menu" | "paste";

export interface TerminalPrefs {
  /** "Use Ctrl+C and Ctrl+V": Strg+C mit Markierung kopiert, Strg+V fuegt ein. */
  ctrlCvClipboard: boolean;
  /** "Copy on select": kopiert beim Loslassen der linken Maustaste. */
  copyOnSelect: boolean;
  /** "Right click": Terminalmenue oder Kopieren/Einfuegen. */
  rightClick: RightClickMode;
  /** "Font size" aller Terminals in px: ganzzahlig 10 bis 20 (Spec §6.7). */
  fontSize: number;
}

/** Spec §6.7 und `settings.rs`: Standard und Grenzen der Schriftgroesse. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 20;

export const DEFAULT_TERMINAL_PREFS: Readonly<TerminalPrefs> = Object.freeze({
  ctrlCvClipboard: true,
  copyOnSelect: false,
  rightClick: "menu",
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
});

/** Haelt eine Schriftgroesse in den Grenzen 10 bis 20 und macht sie ganzzahlig:
 * `ui_settings` lehnt eine Bruchzahl ab (`u8` in Rust). Ein Wert ohne Zahl
 * (NaN, unendlich) faellt auf den Standard, weil keine Grenze naeher liegt. */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(n)));
}

let current: Readonly<TerminalPrefs> = DEFAULT_TERMINAL_PREFS;
const listeners = new Set<(prefs: Readonly<TerminalPrefs>) => void>();

export function terminalPrefs(): Readonly<TerminalPrefs> {
  return current;
}

/** Uebernimmt die gesetzten Felder des Patches. Ein Feld mit `undefined`
 * gilt als nicht gesetzt -- ein fehlendes Feld in einer aelteren Antwort des
 * Backends darf keinen Wert loeschen. Die Schriftgroesse wird hier geklemmt,
 * damit jeder Schreiber (Rad, Tasten, Stepper, `settings.toml`) dieselbe
 * Regel bekommt. Gemeldet wird nur eine echte Aenderung. */
export function setTerminalPrefs(patch: Partial<TerminalPrefs>): void {
  const next: TerminalPrefs = {
    ctrlCvClipboard: patch.ctrlCvClipboard ?? current.ctrlCvClipboard,
    copyOnSelect: patch.copyOnSelect ?? current.copyOnSelect,
    rightClick: patch.rightClick ?? current.rightClick,
    fontSize: patch.fontSize === undefined ? current.fontSize : clampFontSize(patch.fontSize),
  };
  if (
    next.ctrlCvClipboard === current.ctrlCvClipboard &&
    next.copyOnSelect === current.copyOnSelect &&
    next.rightClick === current.rightClick &&
    next.fontSize === current.fontSize
  ) {
    return;
  }
  current = Object.freeze(next);
  for (const fn of listeners) fn(current);
}

export function onTerminalPrefsChanged(fn: (prefs: Readonly<TerminalPrefs>) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
