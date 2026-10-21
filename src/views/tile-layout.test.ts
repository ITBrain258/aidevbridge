import { describe, expect, it } from "vitest";
import {
  EQUAL_FRACTIONS,
  MIN_TILE_WIDTH,
  TILE_GAP,
  layoutTiles,
  moveBoundary,
  rowCounts,
  spaceFor,
} from "./tile-layout";

describe("rowCounts (Spec 2026-10-19 §4.2)", () => {
  it("verteilt 0 bis 9 Kacheln auf Reihen, obere Reihen bekommen den Rest", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(rowCounts)).toEqual([
      [],
      [1],
      [2],
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
      [3, 2, 2],
      [3, 3, 2],
      [3, 3, 3],
    ]);
  });
});

describe("layoutTiles", () => {
  it("eine Kachel fuellt die ganze Flaeche", () => {
    expect(layoutTiles(1, 1662, 997)).toEqual({ rects: [{ x: 0, y: 0, width: 1662, height: 997 }], splits: [] });
  });

  it("drei Kacheln: zwei oben, eine breite unten, ganze Pixel, Luecke 8", () => {
    const { rects, splits } = layoutTiles(3, 1662, 997);
    expect(rects).toEqual([
      { x: 0, y: 0, width: 827, height: 495 },
      { x: 835, y: 0, width: 827, height: 495 },
      { x: 0, y: 503, width: 1662, height: 494 },
    ]);
    expect(splits).toEqual([
      { kind: "col", row: 0, index: 1, rect: { x: 827, y: 0, width: 8, height: 495 } },
      { kind: "row", row: null, index: 1, rect: { x: 0, y: 495, width: 1662, height: 8 } },
    ]);
  });

  it("neun Kacheln: drei mal drei, jede Reihe gleich hoch", () => {
    const { rects } = layoutTiles(9, 1662, 997);
    expect(rects).toHaveLength(9);
    expect(new Set(rects.map((r) => r.height)).size).toBeLessThanOrEqual(2);
    expect(rects.every((r) => r.width >= 548 && r.width <= 549)).toBe(true);
  });

  it("uebernimmt Spalt-Anteile je Reihe und je Reihenhoehe", () => {
    const { rects } = layoutTiles(2, 1000, 500, { rows: null, cols: [[0.25, 0.75]] });
    expect(rects).toEqual([
      { x: 0, y: 0, width: 248, height: 500 },
      { x: 256, y: 0, width: 744, height: 500 },
    ]);
  });

  it("verwirft Anteile, deren Laenge nicht zur Reihe passt", () => {
    expect(layoutTiles(2, 1000, 500, { rows: [0.2, 0.8], cols: [[0.1, 0.2, 0.7]] })).toEqual(layoutTiles(2, 1000, 500));
  });

  it("liefert in einer winzigen Flaeche nie negative Masse (Review Focus 3)", () => {
    const { rects } = layoutTiles(9, 10, 10);
    expect(rects).toHaveLength(9);
    expect(rects.every((r) => r.width >= 0 && r.height >= 0)).toBe(true);
  });

  it("liefert ohne Kacheln nichts", () => {
    expect(layoutTiles(0, 1662, 997, EQUAL_FRACTIONS)).toEqual({ rects: [], splits: [] });
  });
});

describe("moveBoundary", () => {
  it("verschiebt die Grenze um Pixel, die Summe bleibt", () => {
    expect(moveBoundary([0.5, 0.5], 1, 100, 1000, MIN_TILE_WIDTH)).toEqual([0.6, 0.4]);
  });

  it("haelt auf beiden Seiten das Mindestmass", () => {
    expect(moveBoundary([0.5, 0.5], 1, 450, 1000, MIN_TILE_WIDTH)).toEqual([0.8, 0.2]);
    expect(moveBoundary([0.5, 0.5], 1, -450, 1000, MIN_TILE_WIDTH)).toEqual([0.2, 0.8]);
  });

  it("laesst die uebrigen Anteile unberuehrt", () => {
    const shares = [1 / 3, 1 / 3, 1 / 3];
    const next = moveBoundary(shares, 2, -50, 900, MIN_TILE_WIDTH);
    expect(next[0]).toBe(shares[0]);
    expect(next[1] + next[2]).toBeCloseTo(2 / 3, 6);
  });

  it("spaceFor zieht die Luecken ab und wird nie negativ", () => {
    expect(spaceFor(1662, 3)).toBe(1662 - 2 * TILE_GAP);
    expect(spaceFor(5, 3)).toBe(0);
  });
});
