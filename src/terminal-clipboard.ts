// Reine Entscheidungen der Zwischenablage im Terminal (Spec §6.1, §6.2): kein
// DOM-Zugriff, kein xterm. `terminal.ts` fuehrt aus, was hier entschieden
// wird.

import type { TerminalPrefs } from "./terminal-prefs";

/** Spec §6.2: mehr als 1 MiB nach dem Dekodieren wird verworfen. */
export const OSC52_MAX_BYTES = 1_048_576;

/** `Pc` ist leer oder besteht aus c, p, q, s und 0-7. Welche Auswahl gemeint
 * ist, spielt keine Rolle: Windows hat nur eine Zwischenablage. */
const OSC52_SELECTION = /^[cpqs0-7]*$/;

/** OSC 52 `Pc;Pd` -> Text zum Schreiben, oder null (verwerfen). Verworfen wird
 * ohne Antwort: eine Leseanfrage (`?`), leeres `Pd`, ungueltiges Base64 und
 * mehr als `OSC52_MAX_BYTES` nach dem Dekodieren. */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const selection = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (!OSC52_SELECTION.test(selection)) return null;
  if (payload === "" || payload === "?") return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  if (binary.length > OSC52_MAX_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export type ClipboardKeyAction = "copy" | "paste-native" | "terminal";

/** Entscheidet fuer ein keydown im Terminal (Tabelle in Spec §6.1).
 * `hasSelection` heisst: markierter TEXT ist da, nicht bloss ein Bereich --
 * xterm kappt Leerzeichen am Zeilenende, eine Markierung aus Leerraum liefert
 * "" (der Aufrufer fragt `getSelection() !== ""`).
 *
 * - `"copy"`: Strg+C mit Markierung (abschaltbar), Strg+Umschalt+C und
 *   Strg+Einfg. Die beiden festen Tasten liefern das auch ohne Markierung;
 *   der Aufrufer kopiert dann nichts, schluckt die Taste aber.
 * - `"paste-native"`: Strg+V (abschaltbar), Strg+Umschalt+V und Umschalt+Einfg.
 *   Chromium fuegt selbst ein, sobald niemand `preventDefault` ruft.
 * - `"terminal"`: alles andere, auch keyup und keypress -- der Aufrufer geht
 *   seinen bisherigen Weg. */
export function clipboardKeyAction(
  event: KeyboardEvent,
  hasSelection: boolean,
  prefs: Readonly<TerminalPrefs>,
): ClipboardKeyAction {
  if (event.type !== "keydown") return "terminal";
  // Strg+Alt und AltGr nie: auf deutscher Tastatur entstehen so @, das
  // Euro-Zeichen, \, {, }, [, ], | und ~, und Windows meldet AltGr als
  // Strg+Alt (siehe `isAppChord` in `keymap.ts`). Die Windows-Taste dazu
  // macht daraus ebenfalls kein Kopieren.
  if (event.altKey || event.metaKey || event.getModifierState("AltGraph")) return "terminal";
  // Buchstaben nach dem Zeichen des Layouts wie in `keymap.ts`; mit Umschalt
  // oder Feststelltaste kommt "C" statt "c".
  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.shiftKey) {
    if (key === "c") return "copy";
    if (key === "v") return "paste-native";
    return "terminal";
  }
  if (event.ctrlKey) {
    if (key === "insert") return "copy";
    if (key === "c") return prefs.ctrlCvClipboard && hasSelection ? "copy" : "terminal";
    if (key === "v") return prefs.ctrlCvClipboard ? "paste-native" : "terminal";
    return "terminal";
  }
  if (event.shiftKey && key === "insert") return "paste-native";
  return "terminal";
}
