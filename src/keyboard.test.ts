// Gegenprobe fuer `src/keyboard.ts`: die dokumentweiten Tastenlauscher allein,
// ohne `main()`. Jede Aktion landet in genau einer Abhaengigkeit; was diese
// dahinter bewirkt (Seitenleiste, Raster, Dialoge), prueft weiter
// `main.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installKeyboard } from "./keyboard";
import type { FontSizeChange } from "./keymap";

function makeDeps() {
  return {
    newSession: vi.fn(),
    toggleSidebar: vi.fn(),
    focusSidebar: vi.fn(),
    toggleMaximize: vi.fn(),
    moveTile: vi.fn((_delta: 1 | -1) => {}),
    selectTile: vi.fn((_n: number) => {}),
    prevSession: vi.fn(),
    nextSession: vi.fn(),
    nextWaiting: vi.fn(),
    openSettings: vi.fn(),
    openQuickOpen: vi.fn(),
    changeFontSize: vi.fn((_change: FontSizeChange) => {}),
    restoreMaximized: vi.fn(() => false),
    isDialogOpen: vi.fn(() => false),
  };
}

let deps: ReturnType<typeof makeDeps>;
let uninstall: () => void;

beforeEach(() => {
  deps = makeDeps();
  uninstall = installKeyboard(deps);
});

afterEach(() => {
  uninstall();
  document.body.replaceChildren();
});

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function chord(key: string, extra: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  return keydown(target, { key, ctrlKey: true, shiftKey: true, ...extra });
}

/** Ein Ziel im `.xterm`-Teilbaum, wie xterms Hilfstextfeld. */
function terminalTarget(): HTMLElement {
  document.body.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`;
  return document.querySelector<HTMLElement>(".xterm-helper-textarea")!;
}

/** Ein `<input>` ausserhalb des Terminals, bereits im Dokument. */
function textField(type = "text"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = type;
  document.body.appendChild(input);
  return input;
}

/** Ein `<textarea>` ausserhalb des Terminals, bereits im Dokument. */
function textArea(): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  document.body.appendChild(area);
  return area;
}

function contextmenu(target: EventTarget): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  target.dispatchEvent(event);
  return event;
}

describe("keyboard: Akkorde rufen ihre Abhaengigkeit", () => {
  it.each([
    ["B", "toggleSidebar"],
    ["E", "focusSidebar"],
    ["M", "toggleMaximize"],
    ["N", "newSession"],
    ["ArrowUp", "prevSession"],
    ["ArrowDown", "nextSession"],
    ["A", "nextWaiting"],
    ["P", "openQuickOpen"],
    ["PageUp", "moveTile"],
    ["PageDown", "moveTile"],
  ] as const)("Ctrl+Shift+%s ruft %s und sonst keine Aktion", (key, name) => {
    const event = chord(key);

    expect(deps[name]).toHaveBeenCalledTimes(1);
    for (const [other, fn] of Object.entries(deps)) {
      if (other === name || other === "isDialogOpen") continue;
      expect(fn, other).not.toHaveBeenCalled();
    }
    expect(event.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+PageUp/PageDown schieben die Kachel nach vorn und hinten (Spec 2026-10-19 §5.4)", () => {
    chord("PageUp");
    chord("PageDown");
    expect(deps.moveTile.mock.calls).toEqual([[-1], [1]]);
  });

  it("Ctrl+Shift+3 waehlt die dritte sichtbare Kachel, auch wenn das Layout ein anderes Zeichen liefert", () => {
    chord("§", { code: "Digit3" });

    expect(deps.selectTile).toHaveBeenCalledTimes(1);
    expect(deps.selectTile).toHaveBeenCalledWith(3);
  });

  it("bei offenem Dialog schluckt ein Akkord nur das Browserverhalten und loest nichts aus", () => {
    deps.isDialogOpen.mockReturnValue(true);

    const event = chord("B");

    expect(event.defaultPrevented).toBe(true);
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+V im Terminal bleibt unverhindert (natives Einfuegen), ausserhalb nicht", () => {
    const inTerminal = chord("V", {}, terminalTarget());
    expect(inTerminal.defaultPrevented).toBe(false);

    const outside = chord("V");
    expect(outside.defaultPrevented).toBe(true);
  });
});

// UX-Spec §8.2: ein Strg+Umschalt-Akkord in einem Textfeld ausserhalb des
// Terminals gehoert der App nur, wenn `matchAction` eine Aktion liefert. Sonst
// bleibt er beim Feld (Wortweise markieren, Zeilenanfang/-ende, Wiederholen).
describe("keyboard: Akkorde in Eingabefeldern (Spec §8.2)", () => {
  it.each(["ArrowLeft", "ArrowRight", "Home", "End", "Z"])(
    "Strg+Umschalt+%s im <input> bleibt beim Feld und ruft keine Aktion",
    (key) => {
      const event = chord(key, {}, textField());

      expect(event.defaultPrevented).toBe(false);
      for (const [name, fn] of Object.entries(deps)) {
        if (name === "isDialogOpen") continue;
        expect(fn, name).not.toHaveBeenCalled();
      }
    },
  );

  it("Strg+Umschalt+Pfeil im <textarea> bleibt ebenfalls beim Feld", () => {
    expect(chord("ArrowLeft", {}, textArea()).defaultPrevented).toBe(false);
  });

  it("Strg+Umschalt+N im <input> ist eine Aktion: sie wird ausgefuehrt und das Vorgabeverhalten verhindert", () => {
    const event = chord("N", {}, textField());

    expect(deps.newSession).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Strg+Umschalt+R im <input> bleibt verhindert: kein Hard Reload aus einem Feld", () => {
    // Ohne Aktion gaebe §8.2 den Akkord ans Feld, und Chromium laedt die ganze
    // App neu. Der Browsertasten-Lauscher haelt ihn trotzdem an.
    expect(chord("R", {}, textField()).defaultPrevented).toBe(true);
  });

  it("ausserhalb eines Feldes gehoert der ganze Strg+Umschalt-Raum weiter der App", () => {
    const event = chord("ArrowLeft");

    expect(event.defaultPrevented).toBe(true);
    expect(deps.prevSession).not.toHaveBeenCalled();
  });

  it("xterms Hilfstextfeld zaehlt nicht als Feld: ein unbelegter Akkord im Terminal bleibt der App", () => {
    // Das Hilfsfeld ist ein <textarea>, liegt aber in `.xterm`. Dort verhindert
    // schon `terminal.ts` jeden Strg+Umschalt-Akkord, und der Handler am
    // Dokument darf daran nichts aendern.
    expect(chord("ArrowLeft", {}, terminalTarget()).defaultPrevented).toBe(true);
  });

  it("ein <input> ohne Text (Schalter) hat nichts zu bearbeiten: der Akkord bleibt der App", () => {
    expect(chord("ArrowLeft", {}, textField("checkbox")).defaultPrevented).toBe(true);
  });

  it("bei offenem Dialog bleibt ein unbelegter Akkord im Feld trotzdem beim Feld", () => {
    deps.isDialogOpen.mockReturnValue(true);

    const unbound = chord("ArrowLeft", {}, textField());
    const bound = chord("B", {}, textField());

    expect(unbound.defaultPrevented).toBe(false);
    expect(bound.defaultPrevented).toBe(true);
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
  });

  // Einfuegen (`clipboard.paste`) ist die eine Ausnahme von "Aktion heisst
  // abfangen": Chromium soll in einem Textfeld nativ als reinen Text einfuegen,
  // so wie die Taste im Terminal unverhindert bleibt. Strg+Umschalt+C bleibt
  // abgefangen.
  it.each([
    ["<input>", () => textField()],
    ["<input type=password>", () => textField("password")],
    ["<textarea>", () => textArea()],
  ] as [string, () => HTMLElement][])(
    "Strg+Umschalt+V im %s bleibt beim Feld (natives Einfuegen) und ruft keine Abhaengigkeit",
    (_name, makeField) => {
      const event = chord("V", {}, makeField());

      expect(event.defaultPrevented).toBe(false);
      for (const [name, fn] of Object.entries(deps)) {
        if (name === "isDialogOpen") continue;
        expect(fn, name).not.toHaveBeenCalled();
      }
    },
  );

  it("Strg+Umschalt+V im Feld bleibt auch bei offenem Dialog beim Feld", () => {
    // Die Hostformulare liegen in Dialogen: dort wird am ehesten eingefuegt.
    deps.isDialogOpen.mockReturnValue(true);

    const event = chord("V", {}, textField("password"));

    expect(event.defaultPrevented).toBe(false);
    for (const [name, fn] of Object.entries(deps)) {
      if (name === "isDialogOpen") continue;
      expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it("Strg+Umschalt+C im Feld bleibt abgefangen", () => {
    expect(chord("C", {}, textField()).defaultPrevented).toBe(true);
    expect(chord("C", {}, textArea()).defaultPrevented).toBe(true);
  });

  it("Strg+Umschalt+V auf einem Schalter bleibt abgefangen: dort gibt es nichts einzufuegen", () => {
    expect(chord("V", {}, textField("checkbox")).defaultPrevented).toBe(true);
  });
});

// UX-Spec §8.1: ein Capture-Lauscher am window haelt die Browsertasten aus
// der App heraus. Er verhindert nur das Vorgabeverhalten (WebView2 laedt
// sonst bei F5/Strg+R die ganze App samt aller Terminals neu), er stoppt das
// Ereignis nicht.
const BROWSER_KEYS: [string, KeyboardEventInit][] = [
  ["F5", { key: "F5" }],
  ["Ctrl+F5", { key: "F5", ctrlKey: true }],
  ["Ctrl+R", { key: "r", ctrlKey: true }],
  ["Ctrl+P", { key: "p", ctrlKey: true }],
  ["Ctrl+F", { key: "f", ctrlKey: true }],
  ["F3", { key: "F3" }],
  ["Ctrl+G", { key: "g", ctrlKey: true }],
  ["Ctrl+S", { key: "s", ctrlKey: true }],
  ["Ctrl+O", { key: "o", ctrlKey: true }],
  ["Ctrl+U", { key: "u", ctrlKey: true }],
  ["Ctrl+J", { key: "j", ctrlKey: true }],
  ["F7", { key: "F7" }],
  ["Alt+ArrowLeft", { key: "ArrowLeft", altKey: true }],
  ["Alt+ArrowRight", { key: "ArrowRight", altKey: true }],
];

/** Die Medientasten des Browsers: anders als die Tasten oben gesperrt, wo
 * immer sie ankommen, auch im Terminal (Spec §8.1). */
const MEDIA_KEYS: [string, KeyboardEventInit][] = [
  "BrowserBack",
  "BrowserForward",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserHome",
  "BrowserStop",
  "BrowserFavorites",
].map((key): [string, KeyboardEventInit] => [key, { key }]);

/** Jede Modifikatorlage, die eine Medientaste tragen kann. */
const MODIFIER_SETS: KeyboardEventInit[] = [
  {},
  { ctrlKey: true },
  { shiftKey: true },
  { altKey: true },
  { metaKey: true },
  { ctrlKey: true, shiftKey: true, altKey: true },
  { modifierAltGraph: true },
];

/** Bearbeitungstasten und F12 gehoeren nicht zu den Browsertasten. */
const FREE_KEYS: [string, KeyboardEventInit][] = [
  ["Ctrl+C", { key: "c", ctrlKey: true }],
  ["Ctrl+V", { key: "v", ctrlKey: true }],
  ["Ctrl+X", { key: "x", ctrlKey: true }],
  ["Ctrl+A", { key: "a", ctrlKey: true }],
  ["Ctrl+Z", { key: "z", ctrlKey: true }],
  ["Ctrl+Y", { key: "y", ctrlKey: true }],
  ["ArrowLeft", { key: "ArrowLeft" }],
  ["ArrowRight", { key: "ArrowRight" }],
  ["ArrowUp", { key: "ArrowUp" }],
  ["ArrowDown", { key: "ArrowDown" }],
  ["Ctrl+ArrowLeft", { key: "ArrowLeft", ctrlKey: true }],
  ["Home", { key: "Home" }],
  ["End", { key: "End" }],
  ["F12", { key: "F12" }],
  ["Alt+F", { key: "f", altKey: true }],
  ["Alt+Shift+ArrowLeft", { key: "ArrowLeft", altKey: true, shiftKey: true }],
  ["Ctrl+Alt+ArrowLeft", { key: "ArrowLeft", ctrlKey: true, altKey: true }],
  // Getippte Zeichen: ohne Strg ist r, f oder s nur ein Buchstabe.
  ["r", { key: "r" }],
  ["Shift+F", { key: "F", shiftKey: true }],
  ["s", { key: "s" }],
];

describe("keyboard: Browsertasten bleiben ausserhalb der App (Spec §8.1)", () => {
  it.each([...BROWSER_KEYS, ...MEDIA_KEYS])("%s ist ausserhalb des Terminals verhindert", (_name, init) => {
    expect(keydown(document.body, init).defaultPrevented).toBe(true);
  });

  it.each([...BROWSER_KEYS, ...MEDIA_KEYS])("%s ist auch in einem Eingabefeld verhindert", (_name, init) => {
    expect(keydown(textField(), init).defaultPrevented).toBe(true);
  });

  it.each(BROWSER_KEYS)("%s gehoert im Terminal dem Programm und bleibt unverhindert", (_name, init) => {
    expect(keydown(terminalTarget(), init).defaultPrevented).toBe(false);
  });

  // xterm schickt eine Medientaste nicht ans Programm; ohne Sperre fiele sie zu
  // WebView2 durch, und BrowserRefresh luede die App neu.
  it.each(MEDIA_KEYS)("%s ist ueberall verhindert, auch im Terminal und mit jedem Modifikator", (_name, init) => {
    const targets: [string, () => EventTarget][] = [
      ["ausserhalb", () => document.body],
      ["im Eingabefeld", () => textField()],
      ["im Terminal", () => terminalTarget()],
    ];

    for (const [where, makeTarget] of targets) {
      for (const modifiers of MODIFIER_SETS) {
        const event = keydown(makeTarget(), { ...init, ...modifiers });
        expect(event.defaultPrevented, `${where}, ${JSON.stringify(modifiers)}`).toBe(true);
      }
    }
  });

  it("Ctrl+R im Terminal bleibt unverhindert: es ist die Rueckwaertssuche der Shell", () => {
    const event = keydown(terminalTarget(), { key: "r", ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it("Ctrl+H ist nur ausserhalb von Eingabefeldern verhindert", () => {
    const init = { key: "h", ctrlKey: true };

    expect(keydown(document.body, init).defaultPrevented).toBe(true);
    expect(keydown(textField(), init).defaultPrevented).toBe(false);
    expect(keydown(textArea(), init).defaultPrevented).toBe(false);
    expect(keydown(terminalTarget(), init).defaultPrevented).toBe(false);
  });

  it.each(FREE_KEYS)("%s bleibt frei, im Eingabefeld wie ausserhalb", (_name, init) => {
    expect(keydown(textField(), init).defaultPrevented).toBe(false);
    expect(keydown(document.body, init).defaultPrevented).toBe(false);
  });

  it.each([
    ["Ctrl+R mit grossem R (Feststelltaste)", { key: "R", ctrlKey: true }],
    ["Shift+F5", { key: "F5", shiftKey: true }],
    ["Ctrl+Shift+F5", { key: "F5", ctrlKey: true, shiftKey: true }],
  ] as [string, KeyboardEventInit][])(
    "jede Neuladen-Variante bleibt auch im Eingabefeld verhindert: %s",
    (_name, init) => {
      expect(keydown(textField(), init).defaultPrevented).toBe(true);
    },
  );

  // AltGr unter Windows (siehe `isAppChord` und `keymap.test.ts`): Chromium
  // meldet es je nach Fassung als Strg+Alt mit AltGraph oder nur als AltGraph.
  // Ein Zeichen daraus (auf anderen Layouts etwa Buchstaben mit Akzent) ist
  // Eingabe, nie eine Browsertaste.
  it.each([
    ["Strg+Alt mit AltGraph (altes Chromium)", { key: "s", ctrlKey: true, altKey: true, modifierAltGraph: true }],
    ["Strg mit AltGraph", { key: "o", ctrlKey: true, modifierAltGraph: true }],
    ["AltGraph allein", { key: "s", modifierAltGraph: true }],
    ["Strg+Alt ohne AltGraph", { key: "s", ctrlKey: true, altKey: true }],
  ] as [string, KeyboardEventInit][])(
    "ein Zeichen per AltGr ist nie eine Browsertaste: %s",
    (_name, init) => {
      expect(keydown(textField(), init).defaultPrevented).toBe(false);
      expect(keydown(document.body, init).defaultPrevented).toBe(false);
    },
  );

  it("verhindert nur das Vorgabeverhalten und laesst das Ereignis weiterlaufen", () => {
    const seen = vi.fn();
    document.addEventListener("keydown", seen);

    keydown(document.body, { key: "F5" });
    document.removeEventListener("keydown", seen);

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("greift in der Capture-Phase und damit auch, wenn ein Lauscher der Oberflaeche die Weitergabe stoppt", () => {
    const field = textField();
    field.addEventListener("keydown", (event) => event.stopPropagation());

    expect(keydown(field, { key: "F5" }).defaultPrevented).toBe(true);
  });

  it("ein keydown, das kein KeyboardEvent ist (etwa von Autofill), loest keinen Fehler aus", () => {
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);

    const plain = new Event("keydown", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(plain);
    window.removeEventListener("error", onError);

    expect(errors).toEqual([]);
    expect(plain.defaultPrevented).toBe(false);
  });
});

// UX-Spec §8.1: kein WebView2-Menue ("Reload", "Print"). Ausgenommen sind
// Textfelder (natives Bearbeitungsmenue) und das Terminal, das sein eigenes
// Menue hat (§6.3).
describe("keyboard: contextmenu (Spec §8.1)", () => {
  it("wird auf dem Dokument verhindert", () => {
    expect(contextmenu(document.body).defaultPrevented).toBe(true);
  });

  it("wird auf einem Knopf verhindert", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);

    expect(contextmenu(button).defaultPrevented).toBe(true);
  });

  it.each(["text", "password", "number", "search"])(
    "bleibt in einem <input type=%s> beim nativen Bearbeitungsmenue",
    (type) => {
      expect(contextmenu(textField(type)).defaultPrevented).toBe(false);
    },
  );

  it("bleibt in einem <textarea> beim nativen Bearbeitungsmenue", () => {
    expect(contextmenu(textArea()).defaultPrevented).toBe(false);
  });

  it("gibt einem <input> ohne Text (Schalter) kein Browsermenue", () => {
    expect(contextmenu(textField("checkbox")).defaultPrevented).toBe(true);
  });

  it("laesst das Terminal in Ruhe: ohne dessen Lauscher bleibt das Ereignis unberuehrt", () => {
    expect(contextmenu(terminalTarget()).defaultPrevented).toBe(false);
  });

  it("stoert den Lauscher des Terminals nicht und braucht ihn auch nicht", () => {
    // Der Container der Kachel faengt `contextmenu` in der Capture-Phase,
    // verhindert es und stoppt die Weitergabe (`terminal.ts`, Spec §6.3). Hier
    // eine Nachbildung davon.
    document.body.innerHTML = `<div class="tile-terminal"><div class="xterm"><textarea></textarea></div></div>`;
    const container = document.querySelector<HTMLElement>(".tile-terminal")!;
    const own = vi.fn((event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    container.addEventListener("contextmenu", own, true);

    const inTerminal = contextmenu(container.querySelector(".xterm")!);
    // Ausserhalb des Terminals sorgt der globale Lauscher allein dafuer.
    const outside = contextmenu(document.body);

    expect(own).toHaveBeenCalledTimes(1);
    expect(inTerminal.defaultPrevented).toBe(true);
    expect(outside.defaultPrevented).toBe(true);
  });
});

/** Keine Abhaengigkeit ausser `isDialogOpen` wurde gerufen. */
function expectNoAction(): void {
  for (const [name, fn] of Object.entries(deps)) {
    if (name === "isDialogOpen") continue;
    expect(fn, name).not.toHaveBeenCalled();
  }
}

// UX-Spec §8.3: `settings.open` ist Strg+, -- die erste Belegung mit Strg
// allein. Sie wirkt auch mit Fokus im Terminal, dessen Tastenhandler die Taste
// zum Dokument durchlaesst (`terminal.ts`).
describe("keyboard: Strg+, oeffnet die Einstellungen (Spec §8.3)", () => {
  const CTRL_COMMA: KeyboardEventInit = { key: ",", code: "Comma", ctrlKey: true };

  it("ruft openSettings und verhindert das Vorgabeverhalten", () => {
    const event = keydown(document.body, CTRL_COMMA);

    expect(deps.openSettings).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("wirkt auch mit Fokus im Terminal", () => {
    keydown(terminalTarget(), CTRL_COMMA);

    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });

  // Wie ein belegter Strg+Umschalt-Akkord (Spec §8.2): eine Aktion gehoert der
  // App auch im Feld, und Strg+, bedeutet dort nichts.
  it("wirkt auch in einem Eingabefeld ausserhalb des Terminals", () => {
    keydown(textField(), CTRL_COMMA);

    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });

  it("bei offenem Dialog oeffnet Strg+, nichts", () => {
    deps.isDialogOpen.mockReturnValue(true);

    keydown(document.body, CTRL_COMMA);

    expect(deps.openSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["Strg+Umschalt+,", { key: ",", code: "Comma", ctrlKey: true, shiftKey: true }],
    ["Strg+Alt+,", { key: ",", code: "Comma", ctrlKey: true, altKey: true }],
    ["Strg mit AltGraph", { key: ",", code: "Comma", ctrlKey: true, modifierAltGraph: true }],
    ["Komma allein", { key: ",", code: "Comma" }],
  ] as [string, KeyboardEventInit][])("%s oeffnet die Einstellungen nicht", (_name, init) => {
    keydown(document.body, init);

    expect(deps.openSettings).not.toHaveBeenCalled();
  });
});

// UX-Spec §7.5: Strg+Umschalt+P oeffnet das Schnelloeffnen -- auch mit Fokus
// im Terminal und in einem Textfeld ausserhalb (§8.2: ein belegter Akkord
// gehoert dort der App). Strg+P allein ist eine Browsertaste und bleibt nur
// verhindert.
describe("keyboard: Strg+Umschalt+P oeffnet das Schnelloeffnen (Spec §7.5)", () => {
  it("wirkt mit Fokus im Terminal", () => {
    const event = chord("P", {}, terminalTarget());

    expect(deps.openQuickOpen).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("wirkt in einem Eingabefeld ausserhalb des Terminals und verhindert dort das Drucken", () => {
    const event = chord("P", {}, textField());

    expect(deps.openQuickOpen).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Strg+P ohne Umschalt oeffnet nichts", () => {
    const event = keydown(document.body, { key: "p", ctrlKey: true });

    expect(deps.openQuickOpen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});

// UX-Spec §6.7: feste Tasten ausserhalb der Tabelle, nach `event.key`. Sie
// wirken ueberall, auch mit Fokus im Terminal; ausgenommen sind Eingabefelder
// ausserhalb von `.xterm` und ein offener Dialog.
describe("keyboard: Schriftgroesse (Spec §6.7)", () => {
  const FONT_KEYS: [string, KeyboardEventInit, FontSizeChange][] = [
    ["Strg+=", { key: "=", code: "Equal", ctrlKey: true }, "larger"],
    ["Strg++", { key: "+", code: "BracketRight", ctrlKey: true }, "larger"],
    ["Strg+Umschalt+= (US: +)", { key: "+", code: "Equal", ctrlKey: true, shiftKey: true }, "larger"],
    ["Strg+Num+", { key: "+", code: "NumpadAdd", ctrlKey: true }, "larger"],
    ["Strg+-", { key: "-", code: "Minus", ctrlKey: true }, "smaller"],
    ["Strg+Num-", { key: "-", code: "NumpadSubtract", ctrlKey: true }, "smaller"],
    ["Strg+0", { key: "0", code: "Digit0", ctrlKey: true }, "reset"],
    ["Strg+Num0", { key: "0", code: "Numpad0", ctrlKey: true }, "reset"],
  ];

  it.each(FONT_KEYS)("%s ruft changeFontSize(%s) und verhindert das Vorgabeverhalten", (_name, init, change) => {
    const event = keydown(document.body, init);

    expect(deps.changeFontSize).toHaveBeenCalledTimes(1);
    expect(deps.changeFontSize).toHaveBeenCalledWith(change);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(FONT_KEYS)("%s wirkt auch mit Fokus im Terminal", (_name, init, change) => {
    keydown(terminalTarget(), init);

    expect(deps.changeFontSize).toHaveBeenCalledWith(change);
  });

  it.each(FONT_KEYS)("%s bleibt in einem Eingabefeld ausserhalb des Terminals ohne Wirkung", (_name, init) => {
    const inInput = keydown(textField(), init);
    const inTextArea = keydown(textArea(), init);

    expect(deps.changeFontSize).not.toHaveBeenCalled();
    expect(inInput.defaultPrevented).toBe(false);
    expect(inTextArea.defaultPrevented).toBe(false);
  });

  it("bei offenem Dialog ohne Wirkung", () => {
    deps.isDialogOpen.mockReturnValue(true);

    const event = keydown(document.body, { key: "0", code: "Digit0", ctrlKey: true });

    expect(deps.changeFontSize).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  // Review Focus 1: AltGr unter Windows ist Strg+Alt; AltGr+0 ergibt auf der
  // deutschen Tastatur `}` und muss ins Terminal.
  it.each([
    ["Strg+Alt+0", { key: "0", code: "Digit0", ctrlKey: true, altKey: true }],
    ["AltGr+0 als Strg+Alt mit AltGraph", { key: "}", code: "Digit0", ctrlKey: true, altKey: true, modifierAltGraph: true }],
    ["Strg mit AltGraph", { key: "0", code: "Digit0", ctrlKey: true, modifierAltGraph: true }],
    ["Strg+Alt+= ", { key: "=", code: "Equal", ctrlKey: true, altKey: true }],
    ["Strg+Meta+0", { key: "0", code: "Digit0", ctrlKey: true, metaKey: true }],
    ["0 ohne Strg", { key: "0", code: "Digit0" }],
    ["Strg+Num0 ohne NumLock (Insert)", { key: "Insert", code: "Numpad0", ctrlKey: true }],
  ] as [string, KeyboardEventInit][])("%s ist ohne Wirkung, im Terminal wie ausserhalb", (_name, init) => {
    const inTerminal = keydown(terminalTarget(), init);
    const outside = keydown(document.body, init);

    expectNoAction();
    expect(inTerminal.defaultPrevented).toBe(false);
    expect(outside.defaultPrevented).toBe(false);
  });
});

describe("keyboard: Escape holt eine maximierte Kachel zurueck", () => {
  it("stellt ausserhalb des Terminals wieder her und verhindert dann das Vorgabeverhalten", () => {
    deps.restoreMaximized.mockReturnValue(true);

    const event = keydown(document.body, { key: "Escape" });

    expect(deps.restoreMaximized).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("laesst Escape ohne maximierte Kachel unverhindert", () => {
    const event = keydown(document.body, { key: "Escape" });

    expect(deps.restoreMaximized).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("greift weder im Terminal noch bei offenem Dialog", () => {
    deps.restoreMaximized.mockReturnValue(true);

    const inTerminal = keydown(terminalTarget(), { key: "Escape" });
    deps.isDialogOpen.mockReturnValue(true);
    const withDialog = keydown(document.body, { key: "Escape" });

    expect(deps.restoreMaximized).not.toHaveBeenCalled();
    expect(inTerminal.defaultPrevented).toBe(false);
    expect(withDialog.defaultPrevented).toBe(false);
  });

  it("uebergeht ein Escape, das schon jemand bearbeitet hat (defaultPrevented)", () => {
    // Das Suchfeld, ein Menue oder ein Eingabefeld hat dieses Escape fuer sich
    // gebraucht und `preventDefault()` gerufen; die maximierte Kachel bleibt.
    deps.restoreMaximized.mockReturnValue(true);
    const field = textField();
    field.addEventListener("keydown", (event) => {
      if (event.key === "Escape") event.preventDefault();
    });

    const event = keydown(field, { key: "Escape" });

    expect(event.defaultPrevented).toBe(true);
    expect(deps.restoreMaximized).not.toHaveBeenCalled();
  });
});

describe("keyboard: Abmelden", () => {
  it("nimmt alle Lauscher wieder von document und window", () => {
    deps.restoreMaximized.mockReturnValue(true);
    uninstall();

    const chordEvent = chord("B");
    const escapeEvent = keydown(document.body, { key: "Escape" });
    const browserKey = keydown(document.body, { key: "F5" });
    const menu = contextmenu(document.body);
    const settings = keydown(document.body, { key: ",", ctrlKey: true });
    const fontKey = keydown(document.body, { key: "=", ctrlKey: true });

    expect(deps.toggleSidebar).not.toHaveBeenCalled();
    expect(deps.restoreMaximized).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(deps.changeFontSize).not.toHaveBeenCalled();
    expect(chordEvent.defaultPrevented).toBe(false);
    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(browserKey.defaultPrevented).toBe(false);
    expect(menu.defaultPrevented).toBe(false);
    expect(settings.defaultPrevented).toBe(false);
    expect(fontKey.defaultPrevented).toBe(false);
  });
});
