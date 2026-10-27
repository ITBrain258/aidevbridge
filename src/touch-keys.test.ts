import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearModifiers,
  consumeModifiers,
  ctrlChar,
  keySequence,
  latchedModifiers,
  onModifiersChanged,
  takeKeySequence,
  toggleModifier,
  TOUCH_KEYS,
} from "./touch-keys";

const NONE = { ctrl: false, alt: false };

afterEach(() => clearModifiers());

describe("keySequence", () => {
  it("schickt Pfeile als CSI und im Anwendungsmodus als SS3", () => {
    expect(keySequence("up", NONE, false)).toBe("\x1b[A");
    expect(keySequence("left", NONE, false)).toBe("\x1b[D");
    expect(keySequence("up", NONE, true)).toBe("\x1bOA");
    expect(keySequence("home", NONE, false)).toBe("\x1b[H");
    expect(keySequence("end", NONE, true)).toBe("\x1bOF");
  });

  it("traegt Umschalter an Pfeilen und Bild auf/ab nach xterm-Art", () => {
    expect(keySequence("right", { ctrl: true, alt: false }, true)).toBe("\x1b[1;5C");
    expect(keySequence("left", { ctrl: false, alt: true }, false)).toBe("\x1b[1;3D");
    expect(keySequence("up", { ctrl: true, alt: true }, false)).toBe("\x1b[1;7A");
    expect(keySequence("pageUp", NONE, false)).toBe("\x1b[5~");
    expect(keySequence("pageDown", { ctrl: true, alt: false }, false)).toBe("\x1b[6;5~");
  });

  it("schickt Esc, Tab und die Zeichen, Strg und Alt selbst nichts", () => {
    expect(keySequence("esc", NONE, false)).toBe("\x1b");
    expect(keySequence("tab", NONE, false)).toBe("\t");
    expect(keySequence("pipe", NONE, false)).toBe("|");
    expect(keySequence("tilde", NONE, false)).toBe("~");
    expect(keySequence("slash", { ctrl: false, alt: true }, false)).toBe("\x1b/");
    expect(keySequence("ctrl", NONE, false)).toBe("");
    expect(keySequence("alt", NONE, false)).toBe("");
  });

  it("hat fuer jede Taste der Leiste eine Beschriftung und eine eindeutige Id", () => {
    const ids = TOUCH_KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const key of TOUCH_KEYS) expect(key.label.length).toBeGreaterThan(0);
  });
});

describe("ctrlChar", () => {
  it("macht Buchstaben und @[\\]^_ zum Steuerzeichen", () => {
    expect(ctrlChar("c")).toBe("\x03");
    expect(ctrlChar("C")).toBe("\x03");
    expect(ctrlChar("a")).toBe("\x01");
    expect(ctrlChar("@")).toBe("\x00");
    expect(ctrlChar("[")).toBe("\x1b");
    expect(ctrlChar("_")).toBe("\x1f");
    expect(ctrlChar(" ")).toBe("\x00");
    expect(ctrlChar("?")).toBe("\x7f");
  });

  it("laesst alles andere ohne Strg", () => {
    expect(ctrlChar("1")).toBeNull();
    expect(ctrlChar("ä")).toBeNull();
    expect(ctrlChar("ab")).toBeNull();
  });
});

describe("Merker fuer Strg und Alt", () => {
  it("gilt fuer genau eine getippte Eingabe und faellt dann ab", () => {
    toggleModifier("ctrl");
    expect(consumeModifiers("c")).toBe("\x03");
    expect(latchedModifiers()).toEqual(NONE);
    expect(consumeModifiers("c")).toBe("c");
  });

  it("wirkt nur auf das erste Zeichen einer Eingabe aus mehreren", () => {
    toggleModifier("alt");
    expect(consumeModifiers("bc")).toBe("\x1bbc");
  });

  it("laesst Escape-Folgen unveraendert und den Merker stehen", () => {
    toggleModifier("ctrl");
    expect(consumeModifiers("\x1b[0n")).toBe("\x1b[0n");
    expect(latchedModifiers().ctrl).toBe(true);
  });

  it("geht an die naechste Taste der Leiste und loest sich dort", () => {
    expect(takeKeySequence("ctrl", false)).toBeNull();
    expect(latchedModifiers().ctrl).toBe(true);
    expect(takeKeySequence("left", false)).toBe("\x1b[1;5D");
    expect(latchedModifiers()).toEqual(NONE);
  });

  it("ein zweiter Tipp loest den Umschalter wieder", () => {
    takeKeySequence("alt", false);
    takeKeySequence("alt", false);
    expect(latchedModifiers()).toEqual(NONE);
  });

  it("meldet jede Aenderung, bis abgemeldet", () => {
    const listener = vi.fn();
    const off = onModifiersChanged(listener);
    toggleModifier("ctrl");
    consumeModifiers("x");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    toggleModifier("alt");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
