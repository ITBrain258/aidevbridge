// Lage der Kacheln (Spec 2026-10-19 §4.2, §4.4): reine Funktionen ohne DOM,
// pruefbar mit blossen Zahlen -- jsdom misst keine Groessen. `grid.ts` misst
// die Flaeche einmal je Neuzeichnen und legt die Rechtecke absolut an.

/** Abstand zwischen zwei Kacheln, 8 px (Spec 2026-10-19 §4.2). */
export const TILE_GAP = 8;
/** Mindestmass einer Kachel beim Ziehen am Spalt (Startwert, Spec §4.4). */
export const MIN_TILE_WIDTH = 200;
export const MIN_TILE_HEIGHT = 120;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ein Spalt zwischen zwei Kacheln einer Reihe (`col`) oder zwischen zwei
 * Reihen (`row`). `index` ist die Grenze zwischen Anteil `index - 1` und
 * `index`; `row` nennt bei `col` die Reihe, bei `row` ist es `null`. */
export interface Split {
  kind: "col" | "row";
  row: number | null;
  index: number;
  rect: Rect;
}

/** Vom Nutzer gesetzte Anteile; `null` heisst gleich verteilt. Gilt nur,
 * solange die Kachelzahl gleich bleibt (Spec §4.4) -- das haelt `grid.ts`. */
export interface TileFractions {
  rows: number[] | null;
  cols: Array<number[] | null>;
}

export const EQUAL_FRACTIONS: TileFractions = Object.freeze({ rows: null, cols: [] }) as TileFractions;

/** Kacheln je Reihe: 1-2 eine Reihe, 3-6 zwei, 7-9 drei; geht die Zahl nicht
 * auf, bekommen die oberen Reihen eine mehr (3 = 2 + 1, 7 = 3 + 2 + 2). */
export function rowCounts(count: number): number[] {
  if (count <= 0) return [];
  const rows = count <= 2 ? 1 : count <= 6 ? 2 : 3;
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, row) => base + (row < extra ? 1 : 0));
}

/** Verfuegbare Laenge fuer `parts` Teile ohne die Luecken dazwischen. */
export function spaceFor(total: number, parts: number): number {
  return Math.max(0, total - TILE_GAP * Math.max(0, parts - 1));
}

/** Gleiche Anteile fuer `parts` Teile. */
export function equalShares(parts: number): number[] {
  return Array.from({ length: parts }, () => 1 / parts);
}

function sharesFor(fractions: readonly number[] | null | undefined, parts: number): readonly number[] {
  return fractions && fractions.length === parts ? fractions : equalShares(parts);
}

/** Anfang und Groesse je Teil in ganzen Pixeln: gerundet werden die Kanten,
 * nicht die Groessen -- so summieren sich Teile und Luecken genau auf `total`. */
function spans(total: number, shares: readonly number[]): Array<{ start: number; size: number }> {
  const space = spaceFor(total, shares.length);
  const out: Array<{ start: number; size: number }> = [];
  let position = 0;
  for (const share of shares) {
    const start = Math.round(position);
    const end = Math.round(position + share * space);
    out.push({ start, size: Math.max(0, end - start) });
    position += share * space + TILE_GAP;
  }
  return out;
}

/** Rechtecke je Position (Reihen von oben, in der Reihe von links) und die
 * Spalte dazwischen, alles relativ zur Rasterflaeche. */
export function layoutTiles(
  count: number,
  width: number,
  height: number,
  fractions: TileFractions = EQUAL_FRACTIONS,
): { rects: Rect[]; splits: Split[] } {
  const counts = rowCounts(count);
  const rects: Rect[] = [];
  const splits: Split[] = [];
  const rowSpans = spans(height, sharesFor(fractions.rows, counts.length));
  counts.forEach((tilesInRow, row) => {
    const { start: y, size: rowHeight } = rowSpans[row];
    if (row > 0) {
      const above = rowSpans[row - 1];
      const top = above.start + above.size;
      splits.push({ kind: "row", row: null, index: row, rect: { x: 0, y: top, width, height: y - top } });
    }
    const colSpans = spans(width, sharesFor(fractions.cols[row], tilesInRow));
    colSpans.forEach(({ start: x, size: tileWidth }, col) => {
      if (col > 0) {
        const left = colSpans[col - 1];
        const edge = left.start + left.size;
        splits.push({ kind: "col", row, index: col, rect: { x: edge, y, width: x - edge, height: rowHeight } });
      }
      rects.push({ x, y, width: tileWidth, height: rowHeight });
    });
  });
  // Spalte in fester Reihenfolge: erst alle Spalten-Spalte je Reihe, dann
  // die Reihen-Spalte -- das ist die Reihenfolge der Tests und des DOM.
  splits.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "col" ? -1 : 1));
  return { rects, splits };
}

/** Verschiebt die Grenze `index` (zwischen Anteil `index - 1` und `index`)
 * um `deltaPx`. Beide Seiten behalten mindestens `minPx`, solange die beiden
 * zusammen dafuer reichen; die uebrigen Anteile bleiben unberuehrt. */
export function moveBoundary(
  shares: readonly number[],
  index: number,
  deltaPx: number,
  spacePx: number,
  minPx: number,
): number[] {
  const next = [...shares];
  if (spacePx <= 0 || index <= 0 || index >= shares.length) return next;
  const pair = shares[index - 1] + shares[index];
  const min = Math.min(minPx / spacePx, pair / 2);
  const before = Math.max(min, Math.min(pair - min, shares[index - 1] + deltaPx / spacePx));
  next[index - 1] = Math.round(before * 1e9) / 1e9;
  next[index] = Math.round((pair - before) * 1e9) / 1e9;
  return next;
}
