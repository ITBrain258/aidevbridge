// Reine Entscheidungen der Zwischenablage im Terminal (Spec §6.1, §6.2):
// OSC 52 dekodieren und je Tastendruck waehlen, ob die App kopiert, Chromium
// nativ einfuegt oder xterm die Taste bekommt. Echte `KeyboardEvent`s aus
// jsdom, kein Mock.

import { describe, expect, it } from "vitest";
import { OSC52_MAX_BYTES, clipboardKeyAction, decodeOsc52 } from "./terminal-clipboard";
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs } from "./terminal-prefs";

describe("decodeOsc52", () => {
  it("dekodiert das Format von tmux 3.6 mit leerem Pc", () => {
    expect(decodeOsc52(";aGVsbG8=")).toBe("hello");
  });

  it("nimmt jede erlaubte Auswahl in Pc an: c, p, q, s, 0 bis 7 und Kombinationen", () => {
    for (const pc of ["c", "p", "q", "s", "0", "1", "2", "3", "4", "5", "6", "7", "cs", "s0"]) {
      expect(decodeOsc52(`${pc};aGVsbG8=`), pc).toBe("hello");
    }
  });

  it("dekodiert UTF-8 nach dem Base64", () => {
    expect(decodeOsc52("c;w6TDtsO8")).toBe("äöü");
  });

  it("beantwortet keine Leseanfrage", () => {
    expect(decodeOsc52("c;?")).toBeNull();
    expect(decodeOsc52(";?")).toBeNull();
  });

  it("verwirft leeres Pd", () => {
    expect(decodeOsc52("c;")).toBeNull();
    expect(decodeOsc52(";")).toBeNull();
  });

  it("verwirft ungueltiges Base64", () => {
    expect(decodeOsc52("c;not base64!")).toBeNull();
    expect(decodeOsc52("c;a")).toBeNull();
    expect(decodeOsc52("c;aGVs;bG8=")).toBeNull();
  });

  it("verwirft unbekannte Auswahlzeichen in Pc", () => {
    expect(decodeOsc52("x;aGVsbG8=")).toBeNull();
    expect(decodeOsc52("c8;aGVsbG8=")).toBeNull();
  });

  it("verwirft Daten ohne Trennzeichen", () => {
    expect(decodeOsc52("aGVsbG8=")).toBeNull();
    expect(decodeOsc52("")).toBeNull();
  });

  it("nimmt genau 1 MiB nach dem Dekodieren an und verwirft ein Byte mehr", () => {
    expect(OSC52_MAX_BYTES).toBe(1_048_576);
    expect(decodeOsc52(`;${btoa("a".repeat(OSC52_MAX_BYTES))}`)).toHaveLength(OSC52_MAX_BYTES);
    expect(decodeOsc52(`;${btoa("a".repeat(OSC52_MAX_BYTES + 1))}`)).toBeNull();
  });
});

describe("clipboardKeyAction", () => {
  const ON: TerminalPrefs = { ...DEFAULT_TERMINAL_PREFS, ctrlCvClipboard: true };
  const OFF: TerminalPrefs = { ...DEFAULT_TERMINAL_PREFS, ctrlCvClipboard: false };

  function key(init: KeyboardEventInit & { key: string }, type = "keydown"): KeyboardEvent {
    return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  }

  it("Strg+C kopiert nur mit Markierung und nur bei eingeschalteter Einstellung", () => {
    expect(clipboardKeyAction(key({ key: "c", ctrlKey: true }), true, ON)).toBe("copy");
    expect(clipboardKeyAction(key({ key: "c", ctrlKey: true }), false, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "c", ctrlKey: true }), true, OFF)).toBe("terminal");
  });

  it("Strg+C mit Feststelltaste (key \"C\") zaehlt wie Strg+C", () => {
    expect(clipboardKeyAction(key({ key: "C", ctrlKey: true }), true, ON)).toBe("copy");
  });

  it("Strg+V fuegt nativ ein, ausgeschaltet geht es als ^V ans Terminal", () => {
    expect(clipboardKeyAction(key({ key: "v", ctrlKey: true }), false, ON)).toBe("paste-native");
    expect(clipboardKeyAction(key({ key: "v", ctrlKey: true }), false, OFF)).toBe("terminal");
  });

  it("Strg+Umschalt+C kopiert immer, auch ohne Markierung und bei ausgeschalteter Einstellung", () => {
    for (const prefs of [ON, OFF]) {
      expect(clipboardKeyAction(key({ key: "C", ctrlKey: true, shiftKey: true }), true, prefs)).toBe("copy");
      expect(clipboardKeyAction(key({ key: "C", ctrlKey: true, shiftKey: true }), false, prefs)).toBe("copy");
    }
  });

  it("Strg+Umschalt+V und Umschalt+Einfg fuegen immer nativ ein", () => {
    for (const prefs of [ON, OFF]) {
      expect(clipboardKeyAction(key({ key: "V", ctrlKey: true, shiftKey: true }), false, prefs)).toBe("paste-native");
      expect(clipboardKeyAction(key({ key: "Insert", shiftKey: true }), false, prefs)).toBe("paste-native");
    }
  });

  it("Strg+Einfg kopiert immer", () => {
    expect(clipboardKeyAction(key({ key: "Insert", ctrlKey: true }), true, OFF)).toBe("copy");
    expect(clipboardKeyAction(key({ key: "Insert", ctrlKey: true }), false, ON)).toBe("copy");
  });

  it("Strg+Alt wird nie abgefangen", () => {
    expect(clipboardKeyAction(key({ key: "c", ctrlKey: true, altKey: true }), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "v", ctrlKey: true, altKey: true }), false, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "C", ctrlKey: true, shiftKey: true, altKey: true }), true, ON)).toBe("terminal");
  });

  // Auf deutscher Tastatur kommen @ (AltGr+Q), das Euro-Zeichen und die
  // Klammern ueber AltGr. Windows meldet AltGr als Strg+Alt; aktuelles
  // Chromium loescht beide Flags und laesst nur AltGraph stehen. Beide
  // Formen und der unbelegte Mischfall bleiben beim Terminal.
  it("AltGr wird nie abgefangen, in keiner der Formen, die Chromium meldet (Strg+Alt+Q -> @)", () => {
    const shapes: KeyboardEventInit[] = [
      { ctrlKey: true, altKey: true, modifierAltGraph: true },
      { modifierAltGraph: true },
      { ctrlKey: true, modifierAltGraph: true },
      { ctrlKey: true, shiftKey: true, modifierAltGraph: true },
    ];
    for (const shape of shapes) {
      for (const k of ["@", "q", "c", "v", "C", "V", "Insert"]) {
        const event = key({ key: k, ...shape });
        expect(event.getModifierState("AltGraph")).toBe(true);
        expect(clipboardKeyAction(event, true, ON), `${k} ${JSON.stringify(shape)}`).toBe("terminal");
      }
    }
  });

  it("die Windows-Taste zusaetzlich ist kein Kopieren oder Einfuegen", () => {
    expect(clipboardKeyAction(key({ key: "c", ctrlKey: true, metaKey: true }), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "v", ctrlKey: true, metaKey: true }), false, ON)).toBe("terminal");
  });

  it("nur keydown entscheidet; keyup und keypress gehen den bisherigen Weg", () => {
    expect(clipboardKeyAction(key({ key: "c", ctrlKey: true }, "keyup"), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "v", ctrlKey: true }, "keyup"), false, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "C", ctrlKey: true, shiftKey: true }, "keyup"), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "v", ctrlKey: true }, "keypress"), false, ON)).toBe("terminal");
  });

  it("andere Tasten bleiben beim Terminal", () => {
    expect(clipboardKeyAction(key({ key: "c" }), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "Insert" }), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "a", ctrlKey: true }), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "F", ctrlKey: true, shiftKey: true }), true, ON)).toBe("terminal");
    expect(clipboardKeyAction(key({ key: "Insert", ctrlKey: true, shiftKey: true }), true, ON)).toBe("terminal");
  });
});
