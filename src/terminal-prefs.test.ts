// Terminal-Einstellungen (Spec §6.1, §6.3, §6.4, §6.7): ein Modulzustand wie
// `theme.ts`. Der Zustand ueberlebt Tests derselben Datei, deshalb setzt jeder
// Test auf die Standards zurueck.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_PREFS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampFontSize,
  onTerminalPrefsChanged,
  setTerminalPrefs,
  terminalPrefs,
} from "./terminal-prefs";

beforeEach(() => {
  setTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS });
});

describe("terminalPrefs", () => {
  it("startet mit den Standards der Spec: Strg+C/V an, Copy on select aus, Rechtsklick Menue, Schrift 13", () => {
    expect(DEFAULT_TERMINAL_PREFS).toEqual({
      ctrlCvClipboard: true,
      copyOnSelect: false,
      rightClick: "menu",
      fontSize: 13,
    });
    expect(terminalPrefs()).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("uebernimmt einen Teilpatch und laesst die uebrigen Werte stehen", () => {
    setTerminalPrefs({ ctrlCvClipboard: false });
    expect(terminalPrefs()).toEqual({ ctrlCvClipboard: false, copyOnSelect: false, rightClick: "menu", fontSize: 13 });

    setTerminalPrefs({ rightClick: "paste", copyOnSelect: true });
    expect(terminalPrefs()).toEqual({ ctrlCvClipboard: false, copyOnSelect: true, rightClick: "paste", fontSize: 13 });

    setTerminalPrefs({ fontSize: 16 });
    expect(terminalPrefs()).toEqual({ ctrlCvClipboard: false, copyOnSelect: true, rightClick: "paste", fontSize: 16 });
  });

  it("veraendert die Standards nicht", () => {
    setTerminalPrefs({ ctrlCvClipboard: false, rightClick: "paste", fontSize: 18 });
    expect(DEFAULT_TERMINAL_PREFS).toEqual({ ctrlCvClipboard: true, copyOnSelect: false, rightClick: "menu", fontSize: 13 });
    expect(Object.isFrozen(DEFAULT_TERMINAL_PREFS)).toBe(true);
  });

  it("ein Feld mit undefined im Patch gilt als nicht gesetzt", () => {
    setTerminalPrefs({ ctrlCvClipboard: false, fontSize: 15 });
    setTerminalPrefs({ ctrlCvClipboard: undefined, copyOnSelect: true, fontSize: undefined });
    expect(terminalPrefs()).toEqual({ ctrlCvClipboard: false, copyOnSelect: true, rightClick: "menu", fontSize: 15 });
  });

  // `ui_settings` scheitert an einer Bruchzahl (Rust `u8`), und jeder Schreiber
  // -- Rad, Tasten, Stepper -- geht hier durch.
  it("klemmt die Schriftgroesse auf eine ganze Zahl von 10 bis 20", () => {
    setTerminalPrefs({ fontSize: 25 });
    expect(terminalPrefs().fontSize).toBe(20);
    setTerminalPrefs({ fontSize: 3 });
    expect(terminalPrefs().fontSize).toBe(10);
    setTerminalPrefs({ fontSize: 13.6 });
    expect(terminalPrefs().fontSize).toBe(14);
  });
});

describe("clampFontSize (Spec §6.7)", () => {
  it("Grenzen und Standard wie settings.rs", () => {
    expect([DEFAULT_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE]).toEqual([13, 10, 20]);
  });

  it.each([
    [13, 13],
    [10, 10],
    [20, 20],
    [9, 10],
    [21, 20],
    [-5, 10],
    [300, 20],
    [12.4, 12],
    [12.5, 13],
    [19.6, 20],
  ])("%s -> %s", (input, expected) => {
    expect(clampFontSize(input)).toBe(expected);
  });

  it("ein Wert ohne Zahl faellt auf den Standard 13", () => {
    expect(clampFontSize(Number.NaN)).toBe(13);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(13);
  });
});

describe("onTerminalPrefsChanged", () => {
  it("meldet jede Aenderung mit dem neuen Stand und laesst sich abmelden", () => {
    const listener = vi.fn();
    const unsubscribe = onTerminalPrefsChanged(listener);

    setTerminalPrefs({ copyOnSelect: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ ctrlCvClipboard: true, copyOnSelect: true, rightClick: "menu", fontSize: 13 });

    setTerminalPrefs({ fontSize: 14 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ ctrlCvClipboard: true, copyOnSelect: true, rightClick: "menu", fontSize: 14 });

    unsubscribe();
    setTerminalPrefs({ copyOnSelect: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("meldet nichts, wenn der Patch nichts aendert", () => {
    const listener = vi.fn();
    const unsubscribe = onTerminalPrefsChanged(listener);
    try {
      setTerminalPrefs({ ctrlCvClipboard: true });
      setTerminalPrefs({});
      setTerminalPrefs({ fontSize: 13 });
      expect(listener).not.toHaveBeenCalled();

      // Geklemmt gleich dem Stand: 9 wird 10, und 10 ist es schon.
      setTerminalPrefs({ fontSize: 10 });
      listener.mockClear();
      setTerminalPrefs({ fontSize: 9 });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
