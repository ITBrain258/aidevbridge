// Der Arbeitsplatz in settings.toml (UX-Spec §7.1, §7.2, §9.2): Layout,
// eingeklappte Seitenleiste, aufgeklappte Hosts, die Hosts, die der Nutzer
// verbunden haben will, die Kacheln und je Host die Verzeichnisse.
//
// Dieses Modul leitet den Arbeitsplatz aus `AppState` ab, vergleicht ihn mit dem
// gespeicherten und schreibt ihn 500 ms nach der letzten Aenderung als ganzen
// Schnappschuss (`ui_settings` ersetzt `workspace` als Ganzes). Beim Start
// wendet es an, was der Nutzer zuletzt hatte. Daneben fuehrt es, was AppState
// nicht kennt:
//
// - `connected` folgt Ereignissen, nicht dem Zustand des Augenblicks: hinzu
//   nach jeder erfolgreichen Verbindung, weg nur, wenn der Nutzer trennt oder
//   den Host entfernt. Ein Host, der am Netz scheiterte, bleibt drin.
// - Gespeicherte Kacheln eines Hosts, der in diesem Lauf noch nicht verbunden
//   und gelistet ist, warten nach Sessionschluessel und gehen an ihrer
//   Position in jeden Schnappschuss. Kommt seine Liste, legt die App sie
//   einmal an ihre gespeicherte Position, hoechstens ans Ende -- nur, wenn die
//   Session noch existiert und keine Grenze erreicht ist. Oeffnet der Nutzer
//   die Session vorher selbst oder entfernt er den Host, verfaellt der
//   Eintrag; andere Kacheln nehmen ihr nichts weg (Spec 2026-10-19 §4.6). So
//   verliert ein Neustart die Kacheln der Passwort-Hosts nicht.
// - `dirs` fuehrt je Host die Verzeichnisse fuer "Neue Session" (§7.6):
//   gelesen beim Start, ersetzt nach jedem erfolgreichen Anlegen (`setDirs`).
//
// Ohne gelesenen Stand schreibt es nie: ein fluechtiger Lesefehler darf den
// gespeicherten Arbeitsplatz nicht mit einem leeren ueberschreiben.
import { sessionKey, type AppState, type Host } from "./app-state";
import { MAX_TILES } from "./tile-assignment";
import type { HostDirsDto, TileEntryDto, WorkspaceDto } from "../views/types";

/** UX-Spec §7.1: Ruhe vor dem Schreiben. */
export const WORKSPACE_PERSIST_MS = 500;
/** UX-Spec §7.2: so viele Verbindungen baut der Start hoechstens zugleich auf. */
export const RESTORE_CONNECT_LIMIT = 3;
/** Spec 2026-10-19 §4.6, Nachtrag vom 24.10.: so lange wartet der Start
 * hoechstens auf die Listen der Hosts, die er selbst verbindet, bevor er die
 * gespeicherten Kacheln anlegt. */
export const RESTORE_HOLD_MS = 5000;
/** UX-Spec §7.6: so viele letzte Verzeichnisse fuehrt jeder Host (Rust
 * `MAX_RECENT_DIRS`). */
export const RECENT_DIRS_LIMIT = 5;

/** Plaetze 0 bis 8 (Spec 2026-10-19 §4.6). */
const TILE_SLOTS = MAX_TILES;

/** `tiles_version` der Kachelliste; das schreibt das Frontend. */
export const TILES_VERSION = 2;

/** Spec 2026-10-19 §4.6: `layout` wird nur noch abgeleitet geschrieben -- 4 ab
 * vier Kacheln, 2 bei zwei oder drei, sonst 1 --, damit 0.1.2 die ersten vier
 * zeigt. Gelesen zaehlt es nur fuer die Altregel in `readWorkspace`. */
function layoutFor(count: number): 1 | 2 | 4 {
  return count >= 4 ? 4 : count >= 2 ? 2 : 1;
}

/** Wohin eine gespeicherte Kachel in die laufende Reihe gehoert (Spec
 * 2026-10-19 §4.6: an ihre gespeicherte Position, hoechstens ans Ende).
 * `anchors` nennt je Position den gespeicherten Platz der Kachel dort, `null`
 * fuer eine, die der Nutzer in diesem Lauf geoeffnet hat. Liegen schon
 * wiederhergestellte Kacheln, richtet sich die Position nach ihnen -- hinter
 * die letzte mit kleinerem Platz, sonst vor die erste mit groesserem --, damit
 * die Platzreihenfolge auch stimmt, wenn die Hosts in anderer Folge
 * verbinden. Sonst gilt der Platz selbst. */
export function insertionIndex(anchors: ReadonlyArray<number | null>, slot: number): number {
  for (let i = anchors.length - 1; i >= 0; i--) {
    const own = anchors[i];
    if (own !== null && own < slot) return i + 1;
  }
  const larger = anchors.findIndex((own) => own !== null && own > slot);
  return larger !== -1 ? larger : Math.min(slot, anchors.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Host-Ids, die es gibt, jede einmal, in der gelesenen Reihenfolge. */
function readHostIds(raw: unknown, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id === "string" && known.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Brauchbare Kacheln: ganzzahliger Platz 0 bis 8, bekannter Host, Session mit
 * Namen. Jeder Platz und jede Session hoechstens einmal (der erste Eintrag
 * gilt), nach Platz geordnet -- Rust erzwingt beides nicht. */
function readTiles(raw: unknown, known: ReadonlySet<string>): TileEntryDto[] {
  if (!Array.isArray(raw)) return [];
  const tiles: TileEntryDto[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { slot, host_id: hostId, session } = entry;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= TILE_SLOTS) continue;
    if (typeof hostId !== "string" || !known.has(hostId) || typeof session !== "string" || session === "") continue;
    if (tiles.some((tile) => tile.slot === slot || (tile.host_id === hostId && tile.session === session))) continue;
    tiles.push({ slot, host_id: hostId, session });
  }
  return tiles.sort((a, b) => a.slot - b.slot);
}

/** `dirs` unveraendert, auch fuer unbekannte Hosts (Rust verwirft sie beim
 * Speichern) -- als Kopie, damit eine spaetere Aenderung den gespeicherten
 * Stand nicht mitveraendert. Nur ein Eintrag ohne Liste `recent` faellt weg;
 * Rust liefert keinen solchen. */
function readDirs(raw: unknown): Record<string, HostDirsDto> {
  const dirs: Record<string, HostDirsDto> = {};
  if (!isRecord(raw)) return dirs;
  for (const [hostId, entry] of Object.entries(raw)) {
    if (isRecord(entry) && Array.isArray(entry.recent)) dirs[hostId] = { ...entry, recent: [...entry.recent] } as HostDirsDto;
  }
  return dirs;
}

function copyDirs(dirs: Readonly<Record<string, HostDirsDto>>): Record<string, HostDirsDto> {
  const copy: Record<string, HostDirsDto> = {};
  for (const [hostId, entry] of Object.entries(dirs)) copy[hostId] = { ...entry, recent: [...entry.recent] };
  return copy;
}

/** Ein Verzeichnis ohne Schraegstrich am Ende, damit `/srv/app/` und
 * `/srv/app` ein Eintrag sind; die Wurzel bleibt `/`. */
function withoutTrailingSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, "") || "/" : dir;
}

/** Die Verzeichnisse eines Hosts, nachdem eine Session in `dir` angelegt wurde
 * (UX-Spec §7.6): `dir` ist das zuletzt genutzte und steht vorn in `recent`,
 * jedes Verzeichnis hoechstens einmal, hoechstens fuenf. Ein Schraegstrich am
 * Ende zaehlt nicht -- auch nicht an aelteren Eintraegen. Ein neues Objekt. */
export function withRecentDir(entry: HostDirsDto | null, dir: string): HostDirsDto {
  const last = withoutTrailingSlash(dir);
  const recent = [...new Set([last, ...(entry?.recent ?? []).map(withoutTrailingSlash)])].slice(0, RECENT_DIRS_LIMIT);
  return { last, recent };
}

/** Prueft den gelesenen Arbeitsplatz (`UiSettingsDto.workspace`). `null`, wenn
 * es keiner ist: dann gibt es nichts wiederherzustellen und keinen Stand, an
 * dem sich ein Schreiben messen koennte. Jedes Feld einzeln, Unbrauchbares wird
 * zum Standard. Eintraege von Hosts, die es nicht mehr gibt, fallen weg -- Rust
 * verwirft sie erst beim Speichern. */
export function readWorkspace(raw: unknown, hostIds: readonly string[]): WorkspaceDto | null {
  if (!isRecord(raw)) return null;
  const known = new Set(hostIds);
  const layout = raw.layout === 2 ? 2 : raw.layout === 4 ? 4 : 1;
  const tiles = readTiles(raw.tiles, known);
  // Spec 2026-10-19 §4.6: aus einer alten Datei (Platzmodell) oeffnen nur die
  // Plaetze, die mit ihrem `layout` sichtbar waren; geparkte dahinter
  // entfallen. Danach gilt der Stand als neuer.
  const kept = raw.tiles_version === TILES_VERSION ? tiles : tiles.filter((tile) => tile.slot < layout);
  return {
    // Abgeleitet wie beim Schreiben: ein Start ohne Aenderung schreibt nichts,
    // auch wenn die Datei ein anderes `layout` traegt.
    layout: layoutFor(kept.length),
    tiles_version: TILES_VERSION,
    sidebar_collapsed: raw.sidebar_collapsed === true,
    expanded: readHostIds(raw.expanded, known),
    connected: readHostIds(raw.connected, known),
    tiles: kept,
    dirs: readDirs(raw.dirs),
  };
}

/** Host und Session hinter einem Kachelschluessel -- ueber `sessionKey`
 * verglichen, nicht zerlegt (ausserhalb von `app-state.ts` ist er opak). */
function tileOwner(hosts: readonly Host[], key: string): { hostId: string; name: string } | null {
  for (const host of hosts) {
    const session = host.sessions.find((candidate) => sessionKey(host.id, candidate.name) === key);
    if (session) return { hostId: host.id, name: session.name };
  }
  return null;
}

/** Was der Arbeitsplatz neben AppState fuehrt -- ausdruecklich KEIN frueherer
 * Schnappschuss: dessen Kacheln kaemen sonst als wartende zurueck, auch die,
 * die der Nutzer laengst geschlossen hat. */
export interface WorkspaceExtras {
  /** Die eingeklappte Seitenleiste (main.ts fuehrt sie). */
  sidebarCollapsed: boolean;
  /** Die Hosts, die der Nutzer verbunden haben will. */
  connected: readonly string[];
  /** Gespeicherte Kacheln, deren Host in diesem Lauf noch nicht gelistet ist. */
  pendingTiles: readonly TileEntryDto[];
  /** Je wiederhergestellter Kachel (`Tile.id`) ihr gespeicherter Platz: die
   * Anker, an denen sich wartende Kacheln einreihen (`insertionIndex`). */
  restoredSlots?: ReadonlyMap<number, number>;
  dirs: Readonly<Record<string, HostDirsDto>>;
}

/** Der Arbeitsplatz, wie die App ihn gerade zeigt. Aus `state`: die Kacheln in
 * Anzeigereihenfolge und die aufgeklappten Hosts (in der Reihenfolge der
 * Seitenleiste). Aus `extras` der Rest; jede wartende Kachel geht an ihrer
 * Position mit, solange ihre Session in keiner Kachel steht. `slot` ist
 * danach die Position 0 bis 8, `layout` abgeleitet. Keine Dubletten, keine
 * unbekannten Hosts; alles als Kopie. */
export function workspaceFromState(state: AppState, extras: WorkspaceExtras): WorkspaceDto {
  const known = new Set(state.hosts.map((host) => host.id));
  const rows: Array<{ anchor: number | null; host_id: string; session: string }> = [];
  for (const tile of state.tiles) {
    const owner = tileOwner(state.hosts, tile.sessionKey);
    if (owner) {
      rows.push({ anchor: extras.restoredSlots?.get(tile.id) ?? null, host_id: owner.hostId, session: owner.name });
    }
  }
  const shown = new Set(state.tiles.map((tile) => tile.sessionKey));
  for (const tile of [...extras.pendingTiles].sort((a, b) => a.slot - b.slot)) {
    // Hoechstens neun Plaetze: eine wartende Kachel schiebt nie eine offene
    // aus der Datei; sie selbst koennte `restoreTiles` an der Gesamtgrenze
    // ohnehin nicht mehr anlegen.
    if (rows.length >= TILE_SLOTS) break;
    const key = sessionKey(tile.host_id, tile.session);
    if (!known.has(tile.host_id) || shown.has(key)) continue;
    shown.add(key);
    const at = insertionIndex(rows.map((row) => row.anchor), tile.slot);
    rows.splice(at, 0, { anchor: tile.slot, host_id: tile.host_id, session: tile.session });
  }
  // `slice` bleibt als Wache: `state.tiles` haelt die Gesamtgrenze selbst ein.
  const tiles = rows.slice(0, TILE_SLOTS).map((row, slot) => ({ slot, host_id: row.host_id, session: row.session }));
  return {
    layout: layoutFor(tiles.length),
    tiles_version: TILES_VERSION,
    sidebar_collapsed: extras.sidebarCollapsed,
    expanded: state.hosts.filter((host) => host.expanded).map((host) => host.id),
    connected: extras.connected.filter((hostId) => known.has(hostId)),
    tiles,
    dirs: copyDirs(extras.dirs),
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((item) => set.has(item));
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameDirs(a: Record<string, HostDirsDto>, b: Record<string, HostDirsDto>): boolean {
  const hostIds = Object.keys(a);
  if (hostIds.length !== Object.keys(b).length) return false;
  return hostIds.every((hostId) => {
    const other = b[hostId];
    return other !== undefined && a[hostId].last === other.last && sameList(a[hostId].recent, other.recent);
  });
}

function tileKey(tile: TileEntryDto): string {
  return JSON.stringify([tile.slot, tile.host_id, tile.session]);
}

/** Gleich, wenn jedes gespeicherte Feld gleich ist. Die Reihenfolge in
 * `expanded`, `connected` und `tiles` traegt keine Bedeutung (der Start
 * verbindet in der Reihenfolge der Seitenleiste), die in `dirs.recent` schon
 * (neueste zuerst). */
export function sameWorkspace(a: WorkspaceDto, b: WorkspaceDto): boolean {
  return (
    a.layout === b.layout &&
    a.tiles_version === b.tiles_version &&
    a.sidebar_collapsed === b.sidebar_collapsed &&
    sameSet(a.expanded, b.expanded) &&
    sameSet(a.connected, b.connected) &&
    sameSet(a.tiles.map(tileKey), b.tiles.map(tileKey)) &&
    sameDirs(a.dirs, b.dirs)
  );
}

export interface WorkspaceWriter {
  /** Plant einen Schnappschuss. Geschrieben wird 500 ms nach der letzten
   * Aenderung, und nur, wenn er sich von dem unterscheidet, was settings.toml
   * haelt -- oder gleich halten wird, wenn gerade geschrieben wird. Derselbe
   * Stand noch einmal (etwa nach einem Status-Poll) schiebt nichts hinaus. */
  schedule(ws: WorkspaceDto): void;
  /** Schreibt einen geplanten Schnappschuss sofort (nach einem laufenden). */
  flush(): Promise<void>;
  /** Verwirft einen geplanten Schnappschuss; danach plant der Schreiber nichts mehr. */
  dispose(): void;
}

/** `write` schickt den Schnappschuss (in der App `ui_settings` mit
 * `{ workspace }`). `stored` ist der Stand, den settings.toml haelt -- der
 * erste Vergleich laeuft gegen ihn, so schreibt ein Start ohne Aenderung
 * nichts. Ohne ihn schreibt schon der erste Plan.
 *
 * Es laeuft hoechstens ein Schreiben zugleich, und solange es laeuft, gilt sein
 * Schnappschuss als der Stand der Datei: so geht auch eine Rueckkehr zum alten
 * Stand waehrend des Schreibens nicht verloren. Ein gescheitertes Schreiben
 * gilt nicht als gespeichert; derselbe Stand wird aber erst nach einer echten
 * Aenderung wieder versucht -- sonst loeste bei dauerhaft gesperrter Datei jede
 * Benachrichtigung, auch der Status-Poll, ein neues Schreiben aus (§7.1). */
export function createWorkspaceWriter(
  write: (ws: WorkspaceDto) => Promise<void>,
  delayMs = WORKSPACE_PERSIST_MS,
  stored: WorkspaceDto | null = null,
): WorkspaceWriter {
  /** Was settings.toml nach unserem Wissen haelt. */
  let saved = stored;
  /** Das laufende Schreiben. */
  let writing: { ws: WorkspaceDto; done: Promise<void> } | null = null;
  /** Der zuletzt gescheiterte Schnappschuss, bis sich der Stand aendert. */
  let failed: WorkspaceDto | null = null;
  let planned: WorkspaceDto | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const differs = (ws: WorkspaceDto, other: WorkspaceDto | null): boolean =>
    other === null || !sameWorkspace(ws, other);

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    // Erst das laufende Schreiben abwarten, dann gegen sein Ergebnis vergleichen.
    while (writing) await writing.done;
    const ws = planned;
    planned = null;
    if (ws === null || !differs(ws, saved)) return;
    // Ein neuer Versuch: ein frueheres Scheitern sagt ueber ihn nichts mehr.
    failed = null;
    const entry: { ws: WorkspaceDto; done: Promise<void> } = { ws, done: Promise.resolve() };
    writing = entry;
    // Ueber den Executor: auch ein Fehler, den `write` sofort wirft, endet als
    // Ablehnung -- sonst bliebe `writing` stehen, und kein Schreiben kaeme mehr.
    entry.done = new Promise<void>((resolve, reject) => {
      write(ws).then(resolve, reject);
    })
      .then(
        () => {
          saved = ws;
          failed = null;
        },
        (error: unknown) => {
          // Wie bei den [ui]-Feldern kein Banner. Ist inzwischen ein neuer
          // Stand geplant, sagt das Scheitern ueber ihn nichts: er entscheidet
          // selbst, ob er schreibt. Bliebe `failed` stehen, obwohl er zum
          // gespeicherten Stand zurueckfuehrt und darum nicht schreibt, hielte
          // es den naechsten echten Wechsel auf denselben Stand auf.
          failed = planned === null ? ws : null;
          console.warn(`[workspace] ui_settings write failed: ${String(error)}`);
        },
      )
      .finally(() => {
        if (writing === entry) writing = null;
      });
    await entry.done;
  }

  return {
    schedule(ws) {
      if (disposed) return;
      if (failed !== null) {
        if (planned === null && sameWorkspace(ws, failed)) return;
        failed = null;
      }
      if (planned !== null ? sameWorkspace(ws, planned) : !differs(ws, writing?.ws ?? saved)) return;
      planned = ws;
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
      planned = null;
    },
  };
}

/** Verbindet die Hosts in ihrer Reihenfolge, hoechstens `limit` zugleich
 * (UX-Spec §7.2). Der naechste beginnt, sobald einer fertig ist; ein
 * Fehlschlag haelt die uebrigen nicht auf. */
export async function connectInOrder(
  hostIds: readonly string[],
  connect: (hostId: string) => Promise<unknown>,
  limit = RESTORE_CONNECT_LIMIT,
): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    while (next < hostIds.length) {
      const hostId = hostIds[next];
      next += 1;
      try {
        await connect(hostId);
      } catch (error) {
        console.warn(`[workspace] restoring the connection to ${hostId} failed: ${String(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, hostIds.length) }, () => lane()));
}

export interface WorkspaceSyncDeps {
  state: AppState;
  /** Schickt einen ganzen Schnappschuss (in der App `ui_settings` mit `{ workspace }`). */
  write: (ws: WorkspaceDto) => Promise<void>;
  /** Die eingeklappte Seitenleiste fuehrt main.ts: gelesen fuer jeden
   * Schnappschuss, gesetzt beim Start. Jede Aenderung meldet main.ts mit
   * `changed()`. */
  sidebarCollapsed: () => boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  delayMs?: number;
  /** Frist des Starts fuer die Listen (`RESTORE_HOLD_MS`). */
  holdMs?: number;
}

export interface WorkspaceSync {
  /** Uebernimmt den gelesenen Arbeitsplatz, einmal je Lauf, nachdem die Hosts
   * geladen sind. Mit `restore` gelten Seitenleiste und aufgeklappte Hosts
   * sofort, die Kacheln warten auf ihre Hosts, und das Ergebnis nennt
   * die Hosts aus `connected`, die der Start verbindet: Schluessel oder
   * ssh-agent, in der Reihenfolge der Seitenleiste. Was der Nutzer vor der
   * Antwort verbunden, getrennt oder entfernt hat, gilt weiter. Ohne `restore`
   * startet die App leer, gespeichert wird trotzdem -- der erste Vergleich
   * laeuft dann gegen den leeren Start, damit der Start selbst nichts
   * ueberschreibt. Ab hier wird geschrieben; ohne brauchbaren Stand nie. */
  start(raw: unknown, restore: boolean): string[];
  /** Nach jeder Aenderung (AppState-Benachrichtigung, Seitenleiste): vergleicht
   * und plant das Schreiben. */
  changed(): void;
  /** Eine Verbindung ist gelungen, von Hand oder automatisch. */
  hostConnected(hostId: string): void;
  /** Der Nutzer hat getrennt -- nur dieser Weg nimmt einen Host aus `connected`. */
  hostDisconnectedByUser(hostId: string): void;
  /** Der Host ist entfernt: seine Eintraege in `connected`, den wartenden
   * Kacheln und `dirs` fallen weg. */
  hostRemoved(hostId: string): void;
  /** Will der Nutzer diesen Host verbunden haben? Die Warteschlange des Starts
   * fragt das, unmittelbar bevor sie ihn verbindet. */
  wantsConnected(hostId: string): boolean;
  /** Die Sessionliste dieses Hosts ist da: legt seine wartenden Kacheln an
   * ihre Positionen, ohne Fokus; sie warten danach nicht mehr. Waehrend der
   * Start noch auf einen Host wartet, den er selbst verbindet, legt es erst
   * an, wenn der letzte gelistet ist oder sein Versuch endete, oder nach
   * `RESTORE_HOLD_MS`: dann alle in einem Zug, und keine Kachel eines frueh
   * gelisteten Hosts aendert ihre Groesse, weil ein spaeterer dazukommt
   * (Spec 2026-10-19 §4.5, §4.6). */
  hostListed(hostId: string): void;
  /** Unmittelbar bevor der Nutzer selbst eine Session oeffnet: der Start
   * wartet nicht weiter, und was schon gelistet ist, kommt vor seiner Wahl.
   * Sonst naehme sie einer gespeicherten Kachel an der Grenze den Platz, und
   * die entfiele (`restoreTiles`). */
  beforeUserOpen(): void;
  /** Der Versuch des Starts, diesen Host zu verbinden, ist zu Ende, gelungen
   * oder nicht. Ohne Liste wartet der Start dann nicht mehr auf ihn. */
  hostSettled(hostId: string): void;
  /** Die Verzeichnisse dieses Hosts fuer "Neue Session" (UX-Spec §7.6) als
   * Kopie, `null` ohne Eintrag. */
  dirs(hostId: string): HostDirsDto | null;
  /** Ersetzt die Verzeichnisse dieses Hosts und plant das Schreiben des ganzen
   * Schnappschusses. Ohne Schreiber -- vor `start`, oder fuer den ganzen Lauf,
   * wenn kein Stand kam -- wirkt es nur im Speicher. */
  setDirs(hostId: string, entry: HostDirsDto): void;
  dispose(): void;
}

export function createWorkspaceSync(deps: WorkspaceSyncDeps): WorkspaceSync {
  const { state } = deps;
  /** `null` bis `start` -- und fuer den ganzen Lauf, wenn kein Stand kam. */
  let writer: WorkspaceWriter | null = null;
  let disposed = false;
  /** Folgt den Ereignissen von Anfang an, auch vor `start`. */
  let connected: string[] = [];
  /** Hosts, die der Nutzer vor `start` getrennt oder entfernt hat: der
   * gelesene Stand bringt sie nicht zurueck. */
  const droppedBeforeStart = new Set<string>();
  /** Gespeicherte Kacheln, deren Host in diesem Lauf noch nicht gelistet ist. */
  let pending: TileEntryDto[] = [];
  /** Je wiederhergestellter Kachel ihr gespeicherter Platz (`insertionIndex`).
   * Eine `id` wird nie wiederverwendet; Eintraege geschlossener Kacheln
   * stoeren darum nicht. */
  const restoredSlots = new Map<number, number>();
  let dirs: Record<string, HostDirsDto> = {};
  /** Hosts, die der Start selbst verbindet und die noch gespeicherte Kacheln
   * haben, solange weder ihre Liste kam noch ihr Versuch endete. */
  const awaited = new Set<string>();
  /** Hosts, deren Liste kam, waehrend der Start noch wartete. */
  const listedWhileHeld = new Set<string>();
  /** Die Frist des Wartens; gesetzt genau, solange der Start wartet. */
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  function snapshot(): WorkspaceDto {
    return workspaceFromState(state, {
      sidebarCollapsed: deps.sidebarCollapsed(),
      connected,
      pendingTiles: pending,
      restoredSlots,
      dirs,
    });
  }

  function changed(): void {
    if (!writer) return;
    // Ein wartender Eintrag verfaellt erst, wenn seine Session in einer
    // Kachel steht -- etwa weil der Nutzer sie selbst geoeffnet hat. Andere
    // Kacheln nehmen ihm nichts mehr weg (Spec 2026-10-19 §4.6).
    pending = pending.filter((tile) => state.tileForSession(sessionKey(tile.host_id, tile.session)) === null);
    writer.schedule(snapshot());
  }

  /** Legt die wartenden Kacheln dieser Hosts an, in Platzreihenfolge. */
  function restoreHosts(hostIds: readonly string[]): void {
    const mine = pending.filter((tile) => hostIds.includes(tile.host_id)).sort((a, b) => a.slot - b.slot);
    if (mine.length === 0) return;
    // Nur einmal: aus der Warteliste, bevor `restoreTiles` benachrichtigt. Was
    // nicht passt (Session fort, Grenze erreicht), entfaellt.
    pending = pending.filter((tile) => !hostIds.includes(tile.host_id));
    // Alle in einem Zug mit einer Benachrichtigung: jede Kachel montiert mit
    // ihrer Endgeometrie (Spec 2026-10-19 §4.5). Die Position jeder richtet
    // sich nach den schon angelegten; ihr Anker steht darum, bevor die naechste
    // gefragt wird.
    const slots = new Map(mine.map((tile) => [sessionKey(tile.host_id, tile.session), tile.slot]));
    state.restoreTiles(
      mine.map((tile) => ({ hostId: tile.host_id, name: tile.session })),
      ({ hostId, name }, id) => {
        const slot = slots.get(sessionKey(hostId, name))!;
        const at = insertionIndex(state.tiles.map((open) => restoredSlots.get(open.id) ?? null), slot);
        restoredSlots.set(id, slot);
        return at;
      },
    );
    changed();
  }

  /** Das Warten endet: was bis hier gelistet ist, kommt in einem Zug. */
  function release(): void {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    awaited.clear();
    const hostIds = [...listedWhileHeld];
    listedWhileHeld.clear();
    restoreHosts(hostIds);
  }

  /** Auf diesen Host wartet der Start nicht mehr. */
  function settle(hostId: string): void {
    if (holdTimer === undefined || !awaited.delete(hostId)) return;
    if (awaited.size === 0) release();
  }

  function hostListed(hostId: string): void {
    if (!writer) return;
    if (holdTimer === undefined) {
      restoreHosts([hostId]);
      return;
    }
    listedWhileHeld.add(hostId);
    settle(hostId);
  }

  /** Nimmt einen Host aus `connected`; vor `start` merkt es sich das. */
  function dropConnected(hostId: string): void {
    if (!writer) droppedBeforeStart.add(hostId);
    connected = connected.filter((id) => id !== hostId);
  }

  return {
    start(raw, restore) {
      if (disposed || writer) return [];
      const stored = readWorkspace(raw, state.hosts.map((host) => host.id));
      if (!stored) {
        console.warn("[workspace] ui_settings returned no usable workspace, nothing is restored or saved");
        return [];
      }
      // Was der Nutzer vor der Antwort getrennt oder entfernt hat, bleibt
      // draussen; was er verbunden hat, ist schon in `connected`.
      const wanted = restore ? stored.connected.filter((hostId) => !droppedBeforeStart.has(hostId)) : [];
      if (restore) {
        if (stored.sidebar_collapsed !== deps.sidebarCollapsed()) deps.setSidebarCollapsed(stored.sidebar_collapsed);
        for (const hostId of stored.expanded) state.setHostExpanded(hostId, true);
        connected = [...wanted, ...connected.filter((hostId) => !wanted.includes(hostId))];
        pending = stored.tiles.map((tile) => ({ ...tile }));
      }
      // Verzeichnisse, die dieser Lauf vor der Antwort schon gesetzt hat, sind
      // neuer als die gelesenen.
      dirs = { ...copyDirs(stored.dirs), ...dirs };
      writer = createWorkspaceWriter(deps.write, deps.delayMs, restore ? stored : snapshot());
      const connecting = state.hosts
        .filter((host) => wanted.includes(host.id) && (host.authKind === "agent" || host.authKind === "key"))
        .map((host) => host.id);
      for (const hostId of connecting) {
        if (pending.some((tile) => tile.host_id === hostId)) awaited.add(hostId);
      }
      if (awaited.size > 0) holdTimer = setTimeout(release, deps.holdMs ?? RESTORE_HOLD_MS);
      // Ein Host, dessen Liste schon vor der Antwort kam.
      for (const host of state.hosts) {
        if (host.state === "connected" && state.sessionListForHost(host.id).status === "current") hostListed(host.id);
      }
      changed();
      return connecting;
    },
    changed,
    hostConnected(hostId) {
      droppedBeforeStart.delete(hostId);
      if (connected.includes(hostId)) return;
      connected = [...connected, hostId];
      changed();
    },
    hostDisconnectedByUser(hostId) {
      dropConnected(hostId);
      // Seine Liste galt der Verbindung, die der Nutzer gerade trennt: seine
      // Kacheln warten weiter, wie vor der Liste. Sonst legte das Ende des
      // Wartens gesperrte Kacheln eines getrennten Hosts an.
      listedWhileHeld.delete(hostId);
      settle(hostId);
      changed();
    },
    hostRemoved(hostId) {
      dropConnected(hostId);
      pending = pending.filter((tile) => tile.host_id !== hostId);
      listedWhileHeld.delete(hostId);
      settle(hostId);
      const rest = { ...dirs };
      delete rest[hostId];
      dirs = rest;
      changed();
    },
    wantsConnected(hostId) {
      return connected.includes(hostId);
    },
    hostListed,
    beforeUserOpen() {
      if (holdTimer !== undefined) release();
    },
    hostSettled: settle,
    dirs(hostId) {
      const entry = dirs[hostId];
      return entry ? { ...entry, recent: [...entry.recent] } : null;
    },
    setDirs(hostId, entry) {
      dirs = { ...dirs, [hostId]: { ...entry, recent: [...entry.recent] } };
      changed();
    },
    dispose() {
      disposed = true;
      clearTimeout(holdTimer);
      holdTimer = undefined;
      writer?.dispose();
      writer = null;
    },
  };
}
