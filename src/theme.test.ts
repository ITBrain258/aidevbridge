import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENTS, applyTheme, BASES, currentTheme, isThemeId, normalizeTheme, onThemeApplied, readCachedTheme,
  THEME_STORAGE_KEY, THEMES, themeIdOf, themeParts,
} from "./theme";

afterEach(() => {
  applyTheme("turquoise");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Farbwahl: Ids (Spec 2026-09-14 §4)", () => {
  it("14 Ids; die beiden UI-v2-Kombinationen heissen weiter turquoise und slate", () => {
    expect(THEMES).toHaveLength(14);
    expect(new Set(THEMES).size).toBe(14);
    expect(themeIdOf("turquoise", "graphite")).toBe("turquoise");
    expect(themeIdOf("blue", "slate")).toBe("slate");
    expect(themeIdOf("turquoise", "slate")).toBe("turquoise-slate");
    expect(themeIdOf("blue", "graphite")).toBe("blue-graphite");
    expect(themeIdOf("red", "graphite")).toBe("red-graphite");
  });

  it("themeParts kehrt themeIdOf fuer alle Kombinationen um", () => {
    for (const accent of ACCENTS) {
      for (const base of BASES) {
        expect(themeParts(themeIdOf(accent, base))).toEqual({ accent, base });
      }
    }
  });

  it("die Langformen der alten Kombinationen sind keine gueltigen Ids", () => {
    expect(isThemeId("turquoise-graphite")).toBe(false);
    expect(isThemeId("blue-slate")).toBe(false);
    expect(isThemeId("violet-slate")).toBe(true);
  });
});

describe("theme (Spec 12.2, 12.5)", () => {
  it("applyTheme setzt data-accent und data-base, speichert die Id lokal und ruft den Callback", () => {
    const cb = vi.fn();
    const off = onThemeApplied(cb);
    applyTheme("red-slate");
    expect(document.documentElement.dataset.accent).toBe("red");
    expect(document.documentElement.dataset.base).toBe("slate");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("red-slate");
    expect(cb).toHaveBeenCalledWith("red-slate");
    expect(currentTheme()).toBe("red-slate");
    off();
    applyTheme("turquoise");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("slate ist Blau auf Schiefer, turquoise Tuerkis auf Graphit; data-theme gibt es nicht mehr", () => {
    applyTheme("slate");
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(document.documentElement.dataset.base).toBe("slate");
    applyTheme("turquoise");
    expect(document.documentElement.dataset.accent).toBe("turquoise");
    expect(document.documentElement.dataset.base).toBe("graphite");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("turquoise");
  });

  it("normalizeTheme: unbekannt → turquoise mit Warnung; leer → turquoise ohne Warnung", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTheme("x")).toBe("turquoise");
    expect(normalizeTheme("blue-slate")).toBe("turquoise");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(normalizeTheme(undefined)).toBe("turquoise");
    expect(normalizeTheme(null)).toBe("turquoise");
    expect(normalizeTheme("")).toBe("turquoise");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(normalizeTheme("slate")).toBe("slate");
    expect(normalizeTheme("orange-graphite")).toBe("orange-graphite");
  });

  it("readCachedTheme liest localStorage, normalisiert und faellt bei Fehlern auf turquoise", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "slate");
    expect(readCachedTheme()).toBe("slate");
    localStorage.setItem(THEME_STORAGE_KEY, "pink-slate");
    expect(readCachedTheme()).toBe("pink-slate");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(THEME_STORAGE_KEY, "nope");
    expect(readCachedTheme()).toBe("turquoise");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readCachedTheme()).toBe("turquoise");
  });
});
