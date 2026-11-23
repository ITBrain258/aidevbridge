// `Keymap`: trennt Tastenkombinationen, die der App gehoeren, von
// allem, was dem Terminal gehoert (Spec §7.4).
//
// Alles Einfache geht ans Terminal, wie ein Agent-CLI es erwartet. Die
// Belegungstabelle kennt Ctrl+Shift+...-Akkorde (Windows-Terminal-/VS-Code-
// Konvention: eine einzelne Ctrl- oder Alt-Kombination zu beanspruchen wuerde
// die Terminal-Treue verletzen, die dieses Projekt garantiert -- Spec A1) und
// Ctrl allein auf genau den vier Tasten der Ausnahmeliste `PLAIN_CTRL_KEYS`
// (UX-Spec §8.3), fuer die xterm keine Terminaleingabe erzeugt. Ausserhalb der
// Tabelle stehen die festen Tasten der Zwischenablage (`terminal-clipboard.ts`,
// UX-Spec §6.1: Ctrl+C kopiert dort nur bei Markierung, ohne bleibt es ^C) und
// der Schriftgroesse (`fontSizeKeyChange`, UX-Spec §6.7), weil beide Aliasse
// brauchen.
//
// Keine Abhaengigkeiten: dieses Modul importiert absichtlich nichts
// aus `@tauri-apps/*` oder `terminal.ts` -- reine String-/KeyboardEvent-
// Logik, testbar mit einem echten `KeyboardEvent` aus jsdom, ohne jeden
// Mock. `terminal.ts` konsumiert dieses Modul (nicht umgekehrt).

export type KeymapAction =
  | "clipboard.copy"
  | "clipboard.paste"
  | "search.local"
  | "session.new"
  | "session.close"
  | "session.prev"
  | "session.next"
  | "session.nextWaiting"
  | "session.select.1"
  | "session.select.2"
  | "session.select.3"
  | "session.select.4"
  | "session.select.5"
  | "session.select.6"
  | "session.select.7"
  | "session.select.8"
  | "session.select.9"
  | "tile.maximize"
  | "tile.moveEarlier"
  | "tile.moveLater"
  | "sidebar.toggle"
  | "sidebar.focus"
  | "settings.open"
  | "quickOpen";

/** Vorgabebelegung aus Spec §7.4 und die einzige Quelle: Eine eigene Belegung
 * (`[keymap]` in `settings.toml`, Spec §12.1) ist mit dem Kuerzeleditor
 * aufgegeben (UX-Spec §14, Nachtrag vom 23.11.2026).
 *
 * `session.prev`/`.next` (Strg+Umschalt+Hoch/Runter) fuehren den Fokus zur
 * vorigen oder naechsten Kachel; die Namen stammen aus der Zeit, als sie die
 * Liste der Seitenleiste blaetterten (Spec 2026-10-19 §5.7). `session.select.N`
 * fokussiert die Kachel an Position N; dieselbe Ziffer steht im Kachelkopf.
 *
 * `tile.maximize`/`sidebar.toggle`/`sidebar.focus` stammen aus dem
 * Designsystem §7.5; Strg+Umschalt+G ist nach Spec 2026-10-19 §4.7 unbelegt.
 * `tile.moveEarlier`/`.moveLater` schieben die fokussierte Kachel eine Position
 * (Spec 2026-10-19 §5.4).
 *
 * `settings.open` (UX-Spec §8.3) ist die erste Belegung mit Ctrl allein, aus
 * der Ausnahmeliste `PLAIN_CTRL_KEYS`. `quickOpen` (UX-Spec §7.5, §8.3) ist ein
 * gewoehnlicher Ctrl+Shift-Akkord und braucht keine Ausnahme; der Name folgt der
 * Spec, ohne Punkt. */
export const DEFAULT_KEYMAP: Record<KeymapAction, string> = {
  "clipboard.copy": "Ctrl+Shift+C",
  "clipboard.paste": "Ctrl+Shift+V",
  "search.local": "Ctrl+Shift+F",
  "session.new": "Ctrl+Shift+N",
  "session.close": "Ctrl+Shift+W",
  "session.prev": "Ctrl+Shift+Up",
  "session.next": "Ctrl+Shift+Down",
  "session.nextWaiting": "Ctrl+Shift+A",
  "session.select.1": "Ctrl+Shift+1",
  "session.select.2": "Ctrl+Shift+2",
  "session.select.3": "Ctrl+Shift+3",
  "session.select.4": "Ctrl+Shift+4",
  "session.select.5": "Ctrl+Shift+5",
  "session.select.6": "Ctrl+Shift+6",
  "session.select.7": "Ctrl+Shift+7",
  "session.select.8": "Ctrl+Shift+8",
  "session.select.9": "Ctrl+Shift+9",
  "tile.maximize": "Ctrl+Shift+M",
  "tile.moveEarlier": "Ctrl+Shift+PageUp",
  "tile.moveLater": "Ctrl+Shift+PageDown",
  "sidebar.toggle": "Ctrl+Shift+B",
  "sidebar.focus": "Ctrl+Shift+E",
  "settings.open": "Ctrl+,",
  quickOpen: "Ctrl+Shift+P",
};

/** Bewusst keine Aliase ("control", "cmd", "meta") und kein eigener
 * Tastennamen-Validator -- das waere mehr Oberflaeche, als Spec §7.4
 * verlangt. */
const MODIFIERS = new Set(["ctrl", "shift", "alt"]);

/** Die Ausnahmeliste (UX-Spec §8.3): Ctrl ohne Umschalt und ohne Alt gehoert der
 * App genau fuer diese Tasten. xterm.js 6 erzeugt fuer sie keine
 * Terminaleingabe (`Keyboard.ts`), die App nimmt also keinem Programm etwas
 * weg: `Ctrl+,` (Einstellungen) und die Schriftgroesse (`Ctrl+=`, `Ctrl+-`,
 * `Ctrl+0`). Jede andere Taste hinter Ctrl bleibt dem Terminal (auch `Ctrl+1`
 * bis `Ctrl+9`), solange nicht belegt ist, dass xterm fuer sie nichts erzeugt.
 *
 * Kleinschreibung wie die Tasten nach `canonicalize`. `Ctrl++` ist keine
 * gueltige Belegung: der Plus traegt die Zerlegung. */
export const PLAIN_CTRL_KEYS: readonly string[] = [",", "=", "-", "0"];

/** DOM-`KeyboardEvent.key`-Schreibweise (links) -> Spec-Schreibweise aus
 * Spec §7.4/`DEFAULT_KEYMAP` (rechts). Einzige Quelle fuer beide Richtungen:
 * `normalizeKeyName` unten (echtes Event -> kanonischer String) UND
 * `canonicalize` (Konfigurationsstring -> kanonische Form) leiten sich
 * beide hieraus ab -- ohne das wuerde `canonicalize("Ctrl+Shift+ArrowUp")`
 * einen anderen Vergleichsschluessel liefern als `canonicalize("Ctrl+Shift+Up")`,
 * obwohl ein echter Tastendruck auf der Pfeiltaste-hoch IMMER "Up" erzeugt,
 * nie "ArrowUp" (eine Belegung "Ctrl+Shift+ArrowUp" loeste sonst durch keinen
 * echten Tastendruck je etwas aus). */
const ARROW_KEY_NAMES: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/** Lowercase-Variante von `ARROW_KEY_NAMES` fuer `canonicalize` unten, das
 * bereits alles lowercased hat, bevor es den Alias braucht. Aus
 * `ARROW_KEY_NAMES` abgeleitet statt ein zweites Mal von Hand aufgeschrieben
 * -- eine einzige Quelle, kein Drift-Risiko zwischen beiden Schreibweisen. */
const ARROW_KEY_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(ARROW_KEY_NAMES).map(([domName, specName]) => [
    domName.toLowerCase(),
    specName.toLowerCase(),
  ]),
);

interface Canonical {
  /** Sortiert und dedupliziert -- Reihenfolge/Wiederholung im Eingabetext
   * duerfen keine Rolle spielen. */
  mods: string[];
  key: string;
}

/** Zerlegt eine Belegung in Modifikatoren und die eigentliche Taste. `null`,
 * wenn keine genau eine Nicht-Modifikator-Taste uebrig bleibt -- das deckt
 * sowohl den leeren String als auch eine reine Modifikator-Belegung wie
 * "Ctrl+Shift" (kein Ziel zum Draufdruecken) ab. */
function canonicalize(binding: string): Canonical | null {
  const parts = binding
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  const mods = parts.filter((part) => MODIFIERS.has(part));
  const keys = parts.filter((part) => !MODIFIERS.has(part));
  if (keys.length !== 1) return null;

  const sortedMods = Array.from(new Set(mods)).sort();
  const key = ARROW_KEY_ALIASES[keys[0]] ?? keys[0];
  return { mods: sortedMods, key };
}

/** String-Form fuer den Duplikat-Vergleich, z. B. "ctrl+shift+f". */
function comparisonKey(c: Canonical): string {
  return c.mods.length > 0 ? `${c.mods.join("+")}+${c.key}` : c.key;
}

/** Buchstaben und Pfeiltasten folgen dem Zeichen des Tastaturlayouts.
 * Die Ziffernreihe fuer Session-Akkorde behandelt `eventBinding` separat. */
function normalizeKeyName(key: string): string {
  const arrow = ARROW_KEY_NAMES[key];
  if (arrow) return arrow;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Wandelt ein echtes `KeyboardEvent` in dieselbe kanonische Form wie
 * `DEFAULT_KEYMAP`s Werte, z. B. Ctrl+Umschalt+F -> "Ctrl+Shift+F". */
export function eventBinding(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  // Shift+1 liefert z. B. "!", Shift+3 auf Deutsch "§". Die Sessionwahl
  // meint die Zifferntasten 1..9; alle anderen Tasten bleiben zeichenbasiert.
  const digit = isAppChord(event) ? /^Digit([1-9])$/.exec(event.code)?.[1] : undefined;
  parts.push(digit ?? normalizeKeyName(event.key));
  return parts.join("+");
}

/** `true`, wenn `event` ausschliesslich der App gehoert (Ctrl+Shift-Akkord,
 * Spec §7.4) -- UNABHAENGIG davon, ob er aktuell an eine Aktion gebunden
 * ist. `terminal.ts`s `attachCustomKeyEventHandler` nutzt genau diese
 * Funktion: Ctrl+C/Ctrl+V/Ctrl+A/Alt+B usw. liefern `false` -> gehen roh ans
 * Terminal; jeder Ctrl+Shift-Akkord liefert `true` -> die App entscheidet,
 * nie xterm.js. Bewusst weiter gefasst als "ist an eine Aktion gebunden":
 * auch ein (noch) unbelegter Ctrl+Shift-Akkord darf niemals als
 * Terminal-Eingabe durchrutschen -- sonst waere die Grenze von der
 * aktuellen Konfiguration abhaengig statt fest.
 *
 * EXAKT `ctrl && shift && !alt && !meta` -- nicht bloss "enthaelt Ctrl UND
 * Shift" (`ctrlKey && shiftKey`). Sonst lieferte ein physischer
 * Ctrl+Alt+Shift+F-Tastendruck (drei Tasten, kein AltGr noetig) `true`:
 * `preventDefault()` feuerte, `matchAction` faende aber keine Bindung
 * (`null`) -- das erzeugte Zeichen verschwaende ersatzlos, weder im Terminal
 * noch als App-Aktion.
 *
 * `getModifierState("AltGraph")`: auf AltGr-Tastaturen (z. B. deutsches Layout)
 * synthetisiert Windows AltGr traditionell als Left-Ctrl+Right-Alt; Chromium
 * spiegelte das bis zu einem Fix (~2018, Intent-to-Ship "modifier flags on
 * AltGraph-shifted events") unveraendert in `ctrlKey`/`altKey` -- seitdem
 * werden beide fuer AltGr-erzeugte druckbare Zeichen GELOESCHT, nur
 * `getModifierState("AltGraph")` bleibt gesetzt (UI Events Spec,
 * `KeyboardEvent.getModifierState`). Damit ist die rein boolesche
 * Modifikator-Pruefung ohne diese Zeile fuer AltGr+Shift auf AKTUELLEM
 * Chromium/WebView2 schon "zufaellig" sicher (`ctrlKey` ist dort bereits
 * `false`) -- aber nicht auf dem HISTORISCHEN Chromium-Verhalten
 * (`ctrlKey=true, altKey=true`, dort bereits durch `!altKey` abgedeckt) UND
 * nicht fuer einen denkbaren, unbeobachteten Zwischenfall (`ctrlKey=true,
 * altKey=false, AltGraph=true`), den weder Recherche noch Spec belegen, den die
 * reine Modifikator-Pruefung aber auch nicht ausschliessen wuerde. Diese Zeile
 * haertet genau gegen diesen unbelegten Fall ab -- **nicht** auf echtem
 * WebView2 gemessen, aber ein einzeiliger, laut Spec breit unterstuetzter
 * Zusatz-Check ohne bekannten Nachteil. */
export function isAppChord(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.getModifierState("AltGraph")
  );
}

/** `true` fuer Ctrl allein auf einer Taste der Ausnahmeliste (UX-Spec §8.3),
 * das Gegenstueck zu `isAppChord` fuer `PLAIN_CTRL_KEYS`: dieselbe Pruefung auf
 * Alt, Meta und AltGr, dazu kein Umschalt. `Ctrl+Alt+0` ist auf deutscher
 * Tastatur AltGr+0, also `}`, und gehoert dem Terminal. */
export function isPlainCtrlAppKey(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.getModifierState("AltGraph") &&
    PLAIN_CTRL_KEYS.includes(event.key)
  );
}

/** Wirkung einer Taste der Schriftgroesse (UX-Spec §6.7). */
export type FontSizeChange = "larger" | "smaller" | "reset";

/** Die festen Tasten der Schriftgroesse (UX-Spec §6.7): Ctrl+= und Ctrl++
 * vergroessern, Ctrl+- verkleinert, Ctrl+0 setzt zurueck; der Ziffernblock
 * liefert dieselben Zeichen. Sie stehen ausserhalb der Tabelle, weil sie
 * Aliasse brauchen. Massgeblich ist `event.key`, damit US- und DE-Layout gehen,
 * und Umschalt zaehlt deshalb nicht: US erreicht `+` nur mit Umschalt. Alt,
 * Meta und AltGr schliessen aus wie bei `isPlainCtrlAppKey`. Ohne NumLock meldet
 * Num0 `Insert` -- das bleibt Strg+Einfg (Kopieren, UX-Spec §6.1). */
export function fontSizeKeyChange(event: KeyboardEvent): FontSizeChange | null {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.getModifierState("AltGraph")) return null;
  switch (event.key) {
    case "=":
    case "+":
      return "larger";
    case "-":
      return "smaller";
    case "0":
      return "reset";
    default:
      return null;
  }
}

/** Die Aktionsnamen, die `matchAction` als `KeymapAction` erkennt -- aus
 * `DEFAULT_KEYMAP`s Schluesseln abgeleitet, keine zweite Aufzaehlung (kein
 * Drift-Risiko, falls `KeymapAction` um eine Aktion erweitert wird). */
const KNOWN_ACTIONS = new Set<string>(Object.keys(DEFAULT_KEYMAP));

function isKnownAction(action: string): action is KeymapAction {
  return KNOWN_ACTIONS.has(action);
}

/** Liefert die Aktion, deren Bindung `event` entspricht, oder `null` --
 * unabhaengig von Gross-/Kleinschreibung und Modifikator-Reihenfolge in der
 * konfigurierten Belegung (Normalisierung ueber `canonicalize`).
 *
 * Die App ruft es nur mit `DEFAULT_KEYMAP`; `bindings` ist fuer Tests da,
 * die die Normalisierung pruefen. Der RUECKGABETYP ist `KeymapAction | null`:
 * ein unbekannter Aktionsname liefert `null`, und ein verschriebenes
 * `case`-Label im `switch` von `terminal.ts` ist ein Compile-Fehler (TS2678
 * "not comparable"), keine leise nie erreichte Verzweigung. */
export function matchAction(
  event: KeyboardEvent,
  bindings: Record<string, string> = DEFAULT_KEYMAP,
): KeymapAction | null {
  const target = canonicalize(eventBinding(event));
  if (!target) return null;
  const targetKey = comparisonKey(target);

  for (const [action, binding] of Object.entries(bindings)) {
    const c = canonicalize(binding);
    if (c && comparisonKey(c) === targetKey && isKnownAction(action)) return action;
  }
  return null;
}
