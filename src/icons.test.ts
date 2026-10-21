import { describe, expect, it } from "vitest";
import { ICON_NAMES, icon } from "./icons";

describe("icons (Spec 13.1)", () => {
  // 16 statt 15 seit Task 16: die Sessionaktionen sind Icon-Knoepfe
  // geworden, "End session…" braucht dafuer einen Papierkorb ("trash-2").
  // 18 seit der Suchleiste (UX-Spec §6.6): "chevron-up" fuer den vorigen
  // Treffer (der naechste ist "chevron-down"), "case-sensitive" fuer "Aa".
  it("kennt genau die 18 Namen", () => {
    expect([...ICON_NAMES].sort()).toEqual([
      "case-sensitive", "check", "chevron-down", "chevron-right", "chevron-up", "copy",
      "key-round", "lock", "maximize-2", "minimize-2", "plus", "refresh-cw", "search",
      "settings", "terminal", "trash-2", "triangle-alert", "x",
    ]);
  });

  it("liefert ein dekoratives SVG in currentColor, Strichstaerke 1,75, mit Groesse", () => {
    const svg = icon("plus");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("1.75");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(icon("x", 12).getAttribute("height")).toBe("12");
    expect(svg.classList.contains("ab-icon")).toBe(true);
  });

  it("hat fuer jeden Namen Zeicheninhalt und liefert bei jedem Aufruf ein neues Element", () => {
    for (const name of ICON_NAMES) expect(icon(name).childElementCount, name).toBeGreaterThan(0);
    expect(icon("check")).not.toBe(icon("check"));
  });
});
