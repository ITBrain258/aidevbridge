import { describe, expect, it } from "vitest";
import { MAX_TILES, MAX_TILES_PER_HOST, planOpen, planReplace, type Tile } from "./tile-assignment";

/** Kacheln in Anzeigereihenfolge; der Host steht vor dem Schraegstrich. */
function list(keys: string[]): Tile[] {
  return keys.map((sessionKey, i) => ({ id: i + 1, sessionKey, lastFocusedAt: 0 }));
}
const hostOf = (key: string): string | null => key.split("/")[0] ?? null;

/** `n` Sessionschluessel eines Hosts, `${hostId}/1` bis `${hostId}/n`. Die
 * Zahlen folgen aus den Grenzen; nur der erste Grenztest nennt die Acht. */
function keysOf(hostId: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${hostId}/${i + 1}`);
}

describe("planOpen (Spec 2026-10-19 §5.1, §5.3)", () => {
  it("fokussiert die Kachel, in der die Session schon steht", () => {
    expect(planOpen(list(["h/a", "h/b"]), "h/b", "h", hostOf)).toEqual({ kind: "focus", tileId: 2 });
  });

  it("fuegt eine neue Session hinzu, statt eine Kachel zu ersetzen", () => {
    expect(planOpen(list(["h/a"]), "h/b", "h", hostOf)).toEqual({ kind: "add" });
  });

  it("meldet die Grenze je Host, bevor eine neunte Kachel desselben Hosts entsteht (Spec §8.1, ab Schritt 3)", () => {
    expect(MAX_TILES_PER_HOST).toBe(8);
    expect(planOpen(list(keysOf("h", MAX_TILES_PER_HOST - 1)), "h/neu", "h", hostOf)).toEqual({ kind: "add" });
    const full = list(keysOf("h", MAX_TILES_PER_HOST));
    expect(planOpen(full, "h/neu", "h", hostOf)).toEqual({ kind: "limit", scope: "host" });
    expect(planOpen(full, "g/1", "g", hostOf)).toEqual({ kind: "add" });
  });

  it("meldet die Gesamtgrenze bei neun Kacheln", () => {
    const tiles = list(["a/1", "a/2", "b/1", "b/2", "c/1", "c/2", "d/1", "d/2", "e/1"]);
    expect(tiles).toHaveLength(MAX_TILES);
    expect(planOpen(tiles, "f/1", "f", hostOf)).toEqual({ kind: "limit", scope: "total" });
  });

  it("fokussiert eine offene Session auch an der Grenze", () => {
    const tiles = list(keysOf("h", MAX_TILES_PER_HOST));
    expect(planOpen(tiles, "h/neu", "h", hostOf)).toEqual({ kind: "limit", scope: "host" });
    expect(planOpen(tiles, "h/3", "h", hostOf)).toEqual({ kind: "focus", tileId: 3 });
  });

  it("ohne Schluessel (eine Session, die es noch nicht gibt) zaehlen nur die beiden Grenzen", () => {
    expect(planOpen(list(keysOf("h", MAX_TILES_PER_HOST - 1)), null, "h", hostOf)).toEqual({ kind: "add" });
    expect(planOpen(list(keysOf("h", MAX_TILES_PER_HOST)), null, "h", hostOf)).toEqual({ kind: "limit", scope: "host" });
    const nine = list(["a/1", "a/2", "b/1", "b/2", "c/1", "c/2", "d/1", "d/2", "e/1"]);
    expect(planOpen(nine, null, "e", hostOf)).toEqual({ kind: "limit", scope: "total" });
  });

  it("acht Kacheln eines Hosts und eine eines anderen fuellen die Gesamtgrenze; die Grenze je Host geht vor (Spec §8.1, Review Focus 1)", () => {
    const nine = list([...keysOf("h", MAX_TILES_PER_HOST), "g/1"]);
    expect(nine).toHaveLength(MAX_TILES);
    // Der neunte Wunsch fuer h nennt dessen Grenze, ein zehnter anderswo die Gesamtgrenze.
    expect(planOpen(nine, "h/neu", "h", hostOf)).toEqual({ kind: "limit", scope: "host" });
    expect(planOpen(nine, "g/2", "g", hostOf)).toEqual({ kind: "limit", scope: "total" });
    expect(planOpen(nine, "f/1", "f", hostOf)).toEqual({ kind: "limit", scope: "total" });
  });
});

describe("planReplace (Spec 2026-10-19 §5.2, Review Focus 5)", () => {
  it("ersetzt die fokussierte Kachel", () => {
    expect(planReplace(list(["h/a", "h/b"]), "h/c", "h", hostOf, 2)).toEqual({ kind: "replace", tileId: 2 });
  });

  it("fuegt ohne fokussierte Kachel hinzu", () => {
    expect(planReplace(list(["h/a"]), "h/c", "h", hostOf, null)).toEqual({ kind: "add" });
  });

  it("fokussiert nur, wenn die Session schon offen ist", () => {
    expect(planReplace(list(["h/a", "h/b"]), "h/a", "h", hostOf, 2)).toEqual({ kind: "focus", tileId: 1 });
  });

  it("ersetzt auf demselben Host auch an dessen Grenze", () => {
    const tiles = list(keysOf("h", MAX_TILES_PER_HOST));
    expect(planOpen(tiles, "h/neu", "h", hostOf)).toEqual({ kind: "limit", scope: "host" });
    expect(planReplace(tiles, "h/neu", "h", hostOf, MAX_TILES_PER_HOST)).toEqual({ kind: "replace", tileId: MAX_TILES_PER_HOST });
  });

  it("meldet die Grenze, wenn die fokussierte Kachel zu einem anderen Host gehoert", () => {
    // Eine Kachel unter der Grenze: der andere Host ersetzt die fokussierte.
    const below = list([...keysOf("h", MAX_TILES_PER_HOST - 1), "g/x"]);
    expect(planReplace(below, "h/neu", "h", hostOf, MAX_TILES_PER_HOST)).toEqual({ kind: "replace", tileId: MAX_TILES_PER_HOST });
    const tiles = list([...keysOf("h", MAX_TILES_PER_HOST), "g/x"]);
    expect(planReplace(tiles, "h/neu", "h", hostOf, MAX_TILES_PER_HOST + 1)).toEqual({ kind: "limit", scope: "host" });
  });
});
