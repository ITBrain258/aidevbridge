// Tastenleiste fuer Touch-Geraete (Spec 2026-10-27 §5.2): Tasten, die eine
// Bildschirmtastatur nicht hat oder nur umstaendlich erreicht -- Esc, Tab,
// Pfeile, Pos1/Ende, Bild auf/ab und ein paar Zeichen der Shell --, und die
// beiden Umschalter Strg und Alt.
//
// Strg und Alt rasten ein: Ein Tipp merkt den Umschalter vor, er gilt fuer die
// naechste Taste, ob aus der Leiste oder von der Bildschirmtastatur, und faellt
// danach von selbst ab. Der Merker ist einer fuer die ganze App, denn es gibt
// nur eine Leiste und nur eine fokussierte Kachel. `terminal.ts` wendet ihn in
// `term.onData` an (`consumeModifiers`), die Leiste zeigt ihn an
// (`onModifiersChanged`).

export type TouchKeyId =
  | "esc"
  | "tab"
  | "ctrl"
  | "alt"
  | "left"
  | "down"
  | "up"
  | "right"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "pipe"
  | "tilde"
  | "slash"
  | "dash";

export type Modifier = "ctrl" | "alt";

export interface TouchKey {
  id: TouchKeyId;
  /** Die Beschriftung auf der Taste; Zeichen und Pfeile sind sprachneutral. */
  label: string;
}

/** Die Reihenfolge der Leiste: zuerst, was die Shell und die Agenten am
 * haeufigsten brauchen. Die Leiste rollt waagerecht, wenn sie nicht passt. */
export const TOUCH_KEYS: readonly TouchKey[] = [
  { id: "esc", label: "Esc" },
  { id: "tab", label: "Tab" },
  { id: "ctrl", label: "Ctrl" },
  { id: "alt", label: "Alt" },
  { id: "left", label: "←" },
  { id: "down", label: "↓" },
  { id: "up", label: "↑" },
  { id: "right", label: "→" },
  { id: "home", label: "Home" },
  { id: "end", label: "End" },
  { id: "pageUp", label: "PgUp" },
  { id: "pageDown", label: "PgDn" },
  { id: "pipe", label: "|" },
  { id: "tilde", label: "~" },
  { id: "slash", label: "/" },
  { id: "dash", label: "-" },
];

export function isModifier(id: TouchKeyId): id is Modifier {
  return id === "ctrl" || id === "alt";
}

const CURSOR_FINAL: Partial<Record<TouchKeyId, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};

const TILDE_CODE: Partial<Record<TouchKeyId, string>> = {
  pageUp: "5",
  pageDown: "6",
};

const CHARACTER: Partial<Record<TouchKeyId, string>> = {
  pipe: "|",
  tilde: "~",
  slash: "/",
  dash: "-",
};

/** Die Bytes einer Taste der Leiste, wie xterm sie fuer die echte Taste
 * schickte: Pfeile im Anwendungsmodus (DECCKM) als SS3, sonst als CSI, mit
 * Umschaltern als `CSI 1;<m>` nach xterm-Art. Fuer Strg und Alt selbst `""`:
 * sie senden nichts. */
export function keySequence(id: TouchKeyId, mods: Readonly<Record<Modifier, boolean>>, applicationCursor: boolean): string {
  const modifierParam = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  const final = CURSOR_FINAL[id];
  if (final !== undefined) {
    if (modifierParam > 1) return `\x1b[1;${modifierParam}${final}`;
    return applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
  }
  const code = TILDE_CODE[id];
  if (code !== undefined) {
    return modifierParam > 1 ? `\x1b[${code};${modifierParam}~` : `\x1b[${code}~`;
  }
  switch (id) {
    case "esc":
      return mods.alt ? "\x1b\x1b" : "\x1b";
    case "tab":
      // Umschalt+Tab hat keine Taste; Alt+Tab schickt, was xterm schickt.
      return mods.alt ? "\x1b\t" : "\t";
    case "ctrl":
    case "alt":
      return "";
  }
  const character = CHARACTER[id] ?? "";
  return applyToFirst(character, mods);
}

/** Strg plus Zeichen nach der Tabelle der Terminals: Buchstaben und `@[\]^_`
 * werden zum Steuerzeichen, Leertaste zu NUL, `?` zu DEL und `/` wie `_` zu
 * US. Fuer alles andere `null`: das Zeichen geht dann ohne Strg hinaus. */
export function ctrlChar(ch: string): string | null {
  if (ch === " ") return "\x00";
  if (ch === "?") return "\x7f";
  if (ch === "/") return "\x1f";
  // Nur ASCII: `toUpperCase` machte sonst aus dem scharfen S (U+00DF) ein
  // `SS` und daraus ^S.
  if (ch.length !== 1 || ch.charCodeAt(0) > 0x7f) return null;
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  return null;
}

/** Wendet die Umschalter auf das erste Zeichen von `data` an; der Rest bleibt.
 * Eine Bildschirmtastatur liefert nach einem Wort mitunter mehrere Zeichen auf
 * einmal, gemeint ist trotzdem nur das erste. */
function applyToFirst(data: string, mods: Readonly<Record<Modifier, boolean>>): string {
  const first = Array.from(data)[0];
  if (first === undefined) return data;
  const rest = data.slice(first.length);
  let head = first;
  if (mods.ctrl) head = ctrlChar(first) ?? first;
  if (mods.alt) head = `\x1b${head}`;
  return head + rest;
}

const latched: Record<Modifier, boolean> = { ctrl: false, alt: false };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Der aktuelle Merker, zum Anzeigen. */
export function latchedModifiers(): Readonly<Record<Modifier, boolean>> {
  return { ...latched };
}

/** Ein Tipp auf Strg oder Alt: vormerken oder, wenn schon vorgemerkt, wieder
 * loesen. */
export function toggleModifier(modifier: Modifier): void {
  latched[modifier] = !latched[modifier];
  notify();
}

/** Loest beide Umschalter, etwa wenn die Leiste verschwindet. */
export function clearModifiers(): void {
  if (!latched.ctrl && !latched.alt) return;
  latched.ctrl = false;
  latched.alt = false;
  notify();
}

export function onModifiersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Die Bytes einer Taste der Leiste mit dem Merker; danach ist er geloest.
 * Fuer Strg und Alt `null`: sie schalten nur den Merker um. */
export function takeKeySequence(id: TouchKeyId, applicationCursor: boolean): string | null {
  if (isModifier(id)) {
    toggleModifier(id);
    return null;
  }
  const sequence = keySequence(id, latched, applicationCursor);
  clearModifiers();
  return sequence;
}

/** Fuer `term.onData`: getippte Eingabe mit dem Merker, danach ist er
 * geloest. Ohne Merker unveraendert. Eine Escape-Folge bleibt immer
 * unveraendert und loest nichts: sie ist eine Antwort von xterm an das
 * Programm (etwa auf eine Abfrage der Cursorposition) oder eine Taste einer
 * echten Tastatur, die ihre Umschalter schon traegt. */
export function consumeModifiers(data: string): string {
  if ((!latched.ctrl && !latched.alt) || data.startsWith("\x1b") || data.length === 0) return data;
  const result = applyToFirst(data, latched);
  clearModifiers();
  return result;
}
