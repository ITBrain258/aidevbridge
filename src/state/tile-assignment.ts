// Die Regeln aus Spec 2026-10-19 §5.1-§5.3. Bewusst REINE Funktionen ohne
// Zustand und ohne DOM: sie entscheiden, ob eine Wahl eine Kachel anlegt,
// fokussiert, ersetzt oder an einer Grenze scheitert -- die Stelle, an der eine
// falsche Entscheidung dem Nutzer sichtbar wehtut, und sie muss deshalb ohne
// Fenster und ohne Backend pruefbar sein.

/** Eine Kachel (Spec 2026-10-19 §4.1). */
export interface Tile {
  /** Fest fuer die Lebensdauer der Kachel. Fokus und Maximiert verweisen
   * darauf; die Position ist der Index in `AppState.tiles`. */
  id: number;
  /** `${hostId}/${name}` -- host-qualifiziert, weil zwei Hosts gleichnamige
   * tmux-Sessions haben duerfen. Leere Plaetze gibt es nicht. */
  sessionKey: string;
  /** Monoton steigender Zaehler, NICHT `Date.now()`: zwei Fokuswechsel
   * innerhalb derselben Millisekunde waeren sonst ununterscheidbar.
   * `app-state.ts` vergibt ihn. */
  lastFocusedAt: number;
}

/** Spec 2026-10-19 §8.1, ab Schritt 3: hoechstens neun Kacheln
 * (Strg+Umschalt+1-9), hoechstens acht je Host -- so viele PTY-Kanaele hat die
 * Terminalverbindung eines Hosts (`owned_operations.rs`); ein Ersetzen an der
 * Grenze wartet dort, bis der alte Kanal frei ist (`SLOT_WAIT`). Mehr als vier
 * je Host tragen erst die Oeffnungs-Warteschlange (`terminal-open-queue.ts`,
 * hoechstens vier `open_terminal` je Host zugleich) und das Verbergen beim
 * Maximieren: die anderen Kacheln behalten ihre Kanaele. Zurueckholen
 * schliesst nichts und oeffnet nur, was inzwischen keinen lebenden Kanal mehr
 * hat (Neuverbinden des Hosts, abgerissener Kanal). */
export const MAX_TILES = 9;
export const MAX_TILES_PER_HOST = 8;

export interface TileLimits {
  total: number;
  perHost: number;
}

export const TILE_LIMITS: TileLimits = Object.freeze({ total: MAX_TILES, perHost: MAX_TILES_PER_HOST });

/** Was eine Sessionwahl bewirkt (Spec §5.1). Ersetzen kennt nur Strg+Klick
 * und Strg+Enter (§5.2), darum ein eigener, weiterer Typ: `openSession` muss
 * den Fall gar nicht erst behandeln. */
export type OpenPlan =
  | { kind: "focus"; tileId: number }
  | { kind: "add" }
  | { kind: "limit"; scope: "host" | "total" };

export type ReplacePlan = OpenPlan | { kind: "replace"; tileId: number };

function hostCount(tiles: readonly Tile[], hostId: string, hostOf: (key: string) => string | null): number {
  return tiles.filter((tile) => hostOf(tile.sessionKey) === hostId).length;
}

/** Klick in Spur oder Liste, Enter im Schnelloeffnen, Strg+Umschalt+A, New
 * session (Spec §5.1): offen -> fokussieren, sonst hinzufuegen, an einer
 * Grenze nichts (§5.3). Die Grenze je Host geht vor der Gesamtgrenze, weil
 * ihr Hinweis den genaueren Grund nennt. `key` ist `null` fuer eine Session,
 * die es noch nicht gibt ("New session"): sie steht in keiner Kachel, es
 * zaehlen nur die beiden Grenzen. */
export function planOpen(
  tiles: readonly Tile[],
  key: string | null,
  hostId: string,
  hostOf: (key: string) => string | null,
  limits: TileLimits = TILE_LIMITS,
): OpenPlan {
  const open = key === null ? undefined : tiles.find((tile) => tile.sessionKey === key);
  if (open) return { kind: "focus", tileId: open.id };
  if (hostCount(tiles, hostId, hostOf) >= limits.perHost) return { kind: "limit", scope: "host" };
  if (tiles.length >= limits.total) return { kind: "limit", scope: "total" };
  return { kind: "add" };
}

/** Strg+Klick, Strg+Enter (Spec §5.2): ersetzt die fokussierte Kachel an
 * ihrem Platz. Die Gesamtzahl aendert sich dabei nicht; die Grenze je Host nur,
 * wenn die fokussierte Kachel zu einem anderen Host gehoert. */
export function planReplace(
  tiles: readonly Tile[],
  key: string,
  hostId: string,
  hostOf: (key: string) => string | null,
  focusedTile: number | null,
  limits: TileLimits = TILE_LIMITS,
): ReplacePlan {
  const open = tiles.find((tile) => tile.sessionKey === key);
  if (open) return { kind: "focus", tileId: open.id };
  const focused = tiles.find((tile) => tile.id === focusedTile);
  if (!focused) return planOpen(tiles, key, hostId, hostOf, limits);
  const sameHost = hostOf(focused.sessionKey) === hostId;
  if (!sameHost && hostCount(tiles, hostId, hostOf) >= limits.perHost) return { kind: "limit", scope: "host" };
  return { kind: "replace", tileId: focused.id };
}
