// Der Arbeitsplatz (UX-Spec §7.1, §7.2): gelesenen Stand pruefen, aus AppState
// ableiten, vergleichen, entprellt schreiben; gespeicherte Kacheln warten auf
// ihren Host, `connected` folgt den Ereignissen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppState, type Host } from "./app-state";
import { MAX_TILES, MAX_TILES_PER_HOST } from "./tile-assignment";
import type { WorkspaceDto } from "../views/types";
import {
  RESTORE_HOLD_MS,
  WORKSPACE_PERSIST_MS,
  connectInOrder,
  createWorkspaceSync,
  createWorkspaceWriter,
  insertionIndex,
  readWorkspace,
  sameWorkspace,
  withRecentDir,
  workspaceFromState,
  type WorkspaceExtras,
  type WorkspaceSync,
} from "./workspace";

function host(id: string, overrides: Partial<Host> = {}, sessions: string[] = []): Host {
  return {
    id,
    runtimeId: null,
    label: id,
    hostname: `${id}.example`,
    user: "u",
    port: 22,
    keyPath: null,
    authKind: "agent",
    state: "disconnected",
    error: null,
    expanded: false,
    lastCwd: "",
    sessions: sessions.map((name) => ({ name, hostId: id, open: false, inputLocked: false })),
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceDto> = {}): WorkspaceDto {
  return {
    layout: 1,
    tiles_version: 2,
    sidebar_collapsed: false,
    expanded: [],
    connected: [],
    tiles: [],
    dirs: {},
    ...overrides,
  };
}

/** Was der Arbeitsplatz neben AppState fuehrt. */
function extras(overrides: Partial<WorkspaceExtras> = {}): WorkspaceExtras {
  return { sidebarCollapsed: false, connected: [], pendingTiles: [], dirs: {}, ...overrides };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Ein Host ist verbunden und seine Liste ist da -- wie nach `connectHost`. */
function listHost(state: AppState, hostId: string, sessions: string[]): void {
  state.setRuntimeId(hostId, `r-${hostId}`);
  state.setHostState(hostId, "connected");
  state.setSessions(hostId, sessions);
}

describe("readWorkspace: der gelesene Stand", () => {
  it("liefert null ohne brauchbares Objekt", () => {
    for (const raw of [undefined, null, "workspace", 4, []]) expect(readWorkspace(raw, ["a"])).toBeNull();
  });

  it("setzt fehlende oder unbrauchbare Felder auf den Standard", () => {
    expect(readWorkspace({}, ["a"])).toEqual(workspace());
    expect(
      readWorkspace(
        { layout: 3, sidebar_collapsed: "yes", expanded: "a", connected: null, tiles: {}, dirs: [] },
        ["a"],
      ),
    ).toEqual(workspace());
  });

  it("uebernimmt einen vollstaendigen Stand", () => {
    const stored = workspace({
      layout: 2,
      sidebar_collapsed: true,
      expanded: ["a"],
      connected: ["a", "b"],
      tiles: [
        { slot: 0, host_id: "a", session: "s1" },
        { slot: 2, host_id: "b", session: "s2" },
      ],
      dirs: { a: { last: "/home/m", recent: ["/home/m"] } },
    });
    expect(readWorkspace(stored, ["a", "b"])).toEqual(stored);
  });

  it("laesst Eintraege unbekannter Hosts weg, reicht dirs aber unveraendert durch", () => {
    const dirs = { a: { last: "/srv", recent: ["/srv", "/tmp"] }, gone: { last: null, recent: ["/opt"] } };
    const read = readWorkspace(
      {
        layout: 2,
        sidebar_collapsed: false,
        expanded: ["a", "gone"],
        connected: ["gone", "a"],
        tiles: [
          { slot: 0, host_id: "a", session: "s1" },
          { slot: 1, host_id: "gone", session: "s1" },
        ],
        dirs,
      },
      ["a"],
    );
    expect(read).toEqual(
      workspace({
        layout: 1,
        expanded: ["a"],
        connected: ["a"],
        tiles: [{ slot: 0, host_id: "a", session: "s1" }],
        dirs,
      }),
    );
  });

  it("haelt jeden Platz eindeutig und jede Session in hoechstens einem Platz, nach Platz geordnet", () => {
    const read = readWorkspace(
      {
        tiles_version: 2,
        tiles: [
          { slot: 3, host_id: "a", session: "s4" },
          { slot: 0, host_id: "a", session: "s1" },
          { slot: 0, host_id: "a", session: "s2" },
          { slot: 1, host_id: "a", session: "s1" },
          { slot: 2, host_id: "b", session: "s1" },
        ],
      },
      ["a", "b"],
    );
    expect(read?.tiles).toEqual([
      { slot: 0, host_id: "a", session: "s1" },
      { slot: 2, host_id: "b", session: "s1" },
      { slot: 3, host_id: "a", session: "s4" },
    ]);
  });

  it("verwirft Plaetze ausserhalb 0 bis 8, Bruchzahlen und Eintraege ohne Session", () => {
    const read = readWorkspace(
      {
        tiles_version: 2,
        tiles: [
          { slot: 9, host_id: "a", session: "s1" },
          { slot: -1, host_id: "a", session: "s2" },
          { slot: 1.5, host_id: "a", session: "s3" },
          { slot: "1", host_id: "a", session: "s4" },
          { slot: 1, host_id: "a", session: "" },
          { slot: 2, host_id: "a" },
          null,
          { slot: 3, host_id: "a", session: "ok" },
        ],
      },
      ["a"],
    );
    expect(read?.tiles).toEqual([{ slot: 3, host_id: "a", session: "ok" }]);
  });

  it("nimmt jeden Host in expanded und connected hoechstens einmal", () => {
    const read = readWorkspace({ expanded: ["a", "a", "b", 7, "a"], connected: ["b", "a", "b"] }, ["a", "b"]);
    expect(read?.expanded).toEqual(["a", "b"]);
    expect(read?.connected).toEqual(["b", "a"]);
  });

  it("oeffnet aus einer alten Datei nur die Plaetze, die ihr layout zeigte (Spec 2026-10-19 §4.6)", () => {
    const tiles = [0, 1, 2, 3].map((slot) => ({ slot, host_id: "a", session: `s${slot}` }));
    expect(readWorkspace({ layout: 1, tiles }, ["a"])).toEqual(workspace({ tiles: [tiles[0]] }));
    expect(readWorkspace({ layout: 2, tiles, tiles_version: 1 }, ["a"])?.tiles).toEqual(tiles.slice(0, 2));
    // Nur die Zahl 2 kennzeichnet die Kachelliste; die Zeichenkette gilt als alt.
    expect(readWorkspace({ layout: 2, tiles, tiles_version: "2" }, ["a"])?.tiles).toEqual(tiles.slice(0, 2));
    expect(readWorkspace({ layout: 4, tiles }, ["a"])?.tiles).toEqual(tiles);
  });

  it("oeffnet aus einer neuen Datei alle Kacheln, drei wie neun, unabhaengig vom layout (Spec §10.1)", () => {
    const tiles = Array.from({ length: 9 }, (_, slot) => ({ slot, host_id: "a", session: `s${slot}` }));
    expect(readWorkspace({ layout: 4, tiles_version: 2, tiles }, ["a"])?.tiles).toEqual(tiles);
    expect(readWorkspace({ layout: 1, tiles_version: 2, tiles }, ["a"])?.tiles).toEqual(tiles);
    // Drei Kacheln schreibt die App mit dem abgeleiteten layout 2; nur
    // tiles_version haelt Platz 2 offen.
    expect(readWorkspace({ layout: 2, tiles_version: 2, tiles: tiles.slice(0, 3) }, ["a"])?.tiles).toEqual(tiles.slice(0, 3));
  });
});

describe("insertionIndex (Spec 2026-10-19 §4.6)", () => {
  it("ohne Anker: an den gespeicherten Platz, hoechstens ans Ende", () => {
    expect(insertionIndex([], 3)).toBe(0);
    expect(insertionIndex([null, null], 1)).toBe(1);
    expect(insertionIndex([null, null], 8)).toBe(2);
  });

  it("hinter die letzte Kachel mit kleinerem Platz, sonst vor die erste mit groesserem", () => {
    expect(insertionIndex([3, 5], 4)).toBe(1);
    expect(insertionIndex([3, 5], 0)).toBe(0);
    expect(insertionIndex([3, 5], 8)).toBe(2);
    expect(insertionIndex([0, null, 2], 1)).toBe(1);
  });
});

describe("workspaceFromState: der Stand aus AppState", () => {
  function stateWithHosts(): AppState {
    const state = new AppState();
    state.upsertHost(host("a", { expanded: true }, ["s1", "s2"]));
    state.upsertHost(host("b", {}, ["s3"]));
    state.upsertHost(host("c", { expanded: true }, ["s4"]));
    return state;
  }

  it("leitet das Layout ab, liest aufgeklappte Hosts in der Reihenfolge der Seitenleiste und die Kacheln in Anzeigereihenfolge", () => {
    const state = stateWithHosts();
    state.openSession("c", "s4");
    state.openSession("a", "s2");

    const ws = workspaceFromState(state, extras());

    expect(ws.layout).toBe(2);
    expect(ws.expanded).toEqual(["a", "c"]);
    expect(ws.tiles).toEqual([
      { slot: 0, host_id: "c", session: "s4" },
      { slot: 1, host_id: "a", session: "s2" },
    ]);
  });

  it("nimmt Seitenleiste, connected und dirs aus den extras und gibt Kopien heraus", () => {
    const state = stateWithHosts();
    const held = extras({
      sidebarCollapsed: true,
      connected: ["b", "a"],
      dirs: { a: { last: "/srv", recent: ["/srv"] } },
    });

    const ws = workspaceFromState(state, held);
    ws.connected.push("c");
    ws.dirs.a.recent.push("/tmp");

    expect(ws.sidebar_collapsed).toBe(true);
    expect(ws.connected).toEqual(["b", "a", "c"]);
    expect(held.connected).toEqual(["b", "a"]);
    expect(held.dirs).toEqual({ a: { last: "/srv", recent: ["/srv"] } });
  });

  it("mischt wartende Kacheln an ihrer Position ein, hoechstens ans Ende (Spec 2026-10-19 §4.6)", () => {
    const state = stateWithHosts();
    state.openSession("a", "s1");

    const ws = workspaceFromState(
      state,
      extras({
        pendingTiles: [
          { slot: 3, host_id: "c", session: "s4" },
          { slot: 0, host_id: "b", session: "s3" },
        ],
      }),
    );

    expect(ws.tiles).toEqual([
      { slot: 0, host_id: "b", session: "s3" },
      { slot: 1, host_id: "c", session: "s4" },
      { slot: 2, host_id: "a", session: "s1" },
    ]);
    expect(ws.layout).toBe(2);
  });

  it("layout: 4 ab vier Kacheln, 2 bei zwei oder drei, sonst 1", () => {
    const state = new AppState();
    state.upsertHost(host("a", {}, ["s1", "s2", "s3", "s4"]));
    const layouts = [workspaceFromState(state, extras()).layout];
    for (const name of ["s1", "s2", "s3", "s4"]) {
      state.openSession("a", name);
      layouts.push(workspaceFromState(state, extras()).layout);
    }
    expect(layouts).toEqual([1, 1, 2, 2, 4]);
  });

  it("eine wartende Kachel verdraengt keine offene aus der Datei: hoechstens neun Plaetze (Spec 2026-10-19 §4.6)", () => {
    const state = new AppState();
    for (const id of ["a", "b", "c"]) state.upsertHost(host(id, {}, ["s1", "s2", "s3"]));
    for (const id of ["a", "b", "c"]) for (const name of ["s1", "s2", "s3"]) state.openSession(id, name);
    expect(state.tiles).toHaveLength(9);

    const ws = workspaceFromState(state, extras({ pendingTiles: [{ slot: 0, host_id: "c", session: "waiting" }] }));

    expect(ws.tiles.map((tile) => `${tile.host_id}/${tile.session}`)).toEqual(state.tiles.map((tile) => tile.sessionKey));
  });

  it("ohne wartende Kacheln gibt es nur die belegten: eine geschlossene Kachel kommt nicht zurueck", () => {
    const state = stateWithHosts();
    state.openSession("a", "s1");
    const before = workspaceFromState(state, extras());
    state.closeTile(state.tiles[0].id);

    expect(before.tiles).toEqual([{ slot: 0, host_id: "a", session: "s1" }]);
    expect(workspaceFromState(state, extras()).tiles).toEqual([]);
  });

  it("schreibt keine Dubletten und keine unbekannten Hosts", () => {
    const state = stateWithHosts();
    state.openSession("a", "s1");

    const ws = workspaceFromState(
      state,
      extras({
        connected: ["a", "gone"],
        pendingTiles: [
          { slot: 2, host_id: "a", session: "s1" },
          { slot: 3, host_id: "gone", session: "x" },
        ],
      }),
    );

    expect(ws.tiles).toEqual([{ slot: 0, host_id: "a", session: "s1" }]);
    expect(ws.connected).toEqual(["a"]);
  });

  it("schreibt tiles_version 2", () => {
    expect(workspaceFromState(stateWithHosts(), extras()).tiles_version).toBe(2);
  });
});

describe("sameWorkspace", () => {
  const base = workspace({
    layout: 2,
    expanded: ["a", "b"],
    connected: ["a", "c"],
    tiles: [
      { slot: 0, host_id: "a", session: "s1" },
      { slot: 1, host_id: "c", session: "s2" },
    ],
    dirs: { a: { last: "/srv", recent: ["/srv", "/tmp"] } },
  });

  it("ist gleich bei gleichem Inhalt, unabhaengig von der Reihenfolge in expanded, connected und tiles", () => {
    expect(
      sameWorkspace(
        base,
        workspace({
          layout: 2,
          expanded: ["b", "a"],
          connected: ["c", "a"],
          tiles: [
            { slot: 1, host_id: "c", session: "s2" },
            { slot: 0, host_id: "a", session: "s1" },
          ],
          dirs: { a: { last: "/srv", recent: ["/srv", "/tmp"] } },
        }),
      ),
    ).toBe(true);
  });

  it.each<[string, Partial<WorkspaceDto>]>([
    ["layout", { layout: 4 }],
    ["sidebar_collapsed", { sidebar_collapsed: true }],
    ["expanded", { expanded: ["a"] }],
    ["connected", { connected: ["a", "c", "b"] }],
    ["Session einer Kachel", { tiles: [{ slot: 0, host_id: "a", session: "s9" }, { slot: 1, host_id: "c", session: "s2" }] }],
    ["Platz einer Kachel", { tiles: [{ slot: 0, host_id: "a", session: "s1" }, { slot: 3, host_id: "c", session: "s2" }] }],
    ["dirs.last", { dirs: { a: { last: "/tmp", recent: ["/srv", "/tmp"] } } }],
    ["Reihenfolge in dirs.recent", { dirs: { a: { last: "/srv", recent: ["/tmp", "/srv"] } } }],
    ["ein neuer Host in dirs", { dirs: { a: { last: "/srv", recent: ["/srv", "/tmp"] }, b: { last: null, recent: [] } } }],
  ])("erkennt eine Aenderung an %s", (_name, change) => {
    expect(sameWorkspace(base, { ...base, ...change })).toBe(false);
  });

  it("unterscheidet tiles_version", () => {
    expect(sameWorkspace(workspace(), workspace({ tiles_version: 1 }))).toBe(false);
  });
});

describe("createWorkspaceWriter: entprellt und nur bei Aenderung", () => {
  let write: ReturnType<typeof vi.fn<(ws: WorkspaceDto) => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    write = vi.fn<(ws: WorkspaceDto) => Promise<void>>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function written(): WorkspaceDto[] {
    return write.mock.calls.map(([ws]) => ws);
  }

  it("schreibt nichts, solange der Stand dem gespeicherten gleicht", async () => {
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace({ layout: 2 }));
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("schreibt 500 ms nach der letzten Aenderung genau einmal, mit dem letzten Stand", async () => {
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(300);
    writer.schedule(workspace({ layout: 4 }));
    await vi.advanceTimersByTimeAsync(499);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(written()).toEqual([workspace({ layout: 4 })]);
  });

  it("ein gleichbleibender Stand schiebt das Schreiben nicht hinaus", async () => {
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(400);
    // Etwa ein Status-Poll: AppState meldet sich, der Arbeitsplatz ist derselbe.
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(written()).toEqual([workspace({ layout: 2 })]);
  });

  it("zurueck auf den gespeicherten Stand binnen 500 ms schreibt nichts", async () => {
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    writer.schedule(workspace());
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("nach dem Schreiben gilt der neue Stand als gespeichert", async () => {
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    writer.schedule(workspace());
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 }), workspace()]);
  });

  it("ohne gespeicherten Stand schreibt schon der erste Plan", async () => {
    const writer = createWorkspaceWriter(write);
    writer.schedule(workspace());
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()).toEqual([workspace()]);
  });

  // UX-Spec §7.1: der Status-Poll loest nie ein Schreiben aus -- auch nicht,
  // wenn settings.toml dauerhaft nicht schreibbar ist.
  it("nach einem gescheiterten Schreiben versucht derselbe Stand es erst nach einer echten Aenderung wieder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write.mockRejectedValue("read-only folder");
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("read-only folder"));

    // Jede weitere Benachrichtigung mit demselben Stand, etwa ein Status-Poll.
    for (let i = 0; i < 3; i++) {
      writer.schedule(workspace({ layout: 2 }));
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(written()).toEqual([workspace({ layout: 2 })]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Eine echte Aenderung schreibt -- auch die zurueck zum gescheiterten Stand.
    writer.schedule(workspace({ layout: 4 }));
    await vi.advanceTimersByTimeAsync(500);
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 }), workspace({ layout: 4 }), workspace({ layout: 2 })]);
    warn.mockRestore();
  });

  it("nach einem gescheiterten Schreiben haelt die Datei den alten Stand: zurueck dorthin schreibt nichts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write.mockRejectedValueOnce("disk full");
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);

    writer.schedule(workspace());
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 })]);

    // Der gescheiterte Stand gilt nicht als gespeichert: kommt er wieder, wird geschrieben.
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 }), workspace({ layout: 2 })]);
    warn.mockRestore();
  });

  it("schreibt hoechstens einmal zugleich und geht eine Rueckkehr waehrend des Schreibens nicht verloren", async () => {
    let finish!: () => void;
    write.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 })]);

    // Zurueck zum alten Stand, waehrend das Schreiben laeuft: die Datei haelt
    // gleich Layout 2, also ist das eine Aenderung ...
    writer.schedule(workspace());
    await vi.advanceTimersByTimeAsync(500);
    // ... die erst nach dem laufenden Schreiben hinausgeht.
    expect(write).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(written()).toEqual([workspace({ layout: 2 }), workspace()]);
  });

  it("ein neues Schreiben vergisst ein frueheres Scheitern: die Rueckkehr waehrend des Schreibens geht hinaus", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failFirst!: (reason: unknown) => void;
    let finishSecond!: () => void;
    write
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (failFirst = reject)))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishSecond = resolve)));
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    writer.schedule(workspace({ layout: 4 }));
    failFirst("disk full");
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 }), workspace({ layout: 4 })]);

    // Zurueck zu Layout 2, waehrend Layout 4 geschrieben wird.
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    finishSecond();
    await settle();
    expect(written()).toEqual([workspace({ layout: 2 }), workspace({ layout: 4 }), workspace({ layout: 2 })]);
    warn.mockRestore();
  });

  it("scheitert das laufende Schreiben, schreibt die Rueckkehr zum alten Stand nichts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail!: (reason: unknown) => void;
    write.mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)));
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    writer.schedule(workspace());
    await vi.advanceTimersByTimeAsync(500);

    fail("disk full");
    await settle();

    // Die Datei haelt weiter den alten Stand -- genau den, den die App zeigt.
    expect(written()).toEqual([workspace({ layout: 2 })]);
    warn.mockRestore();
  });

  it("nach einer Rueckkehr waehrend eines scheiternden Schreibens schreibt derselbe Wechsel wieder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail!: (reason: unknown) => void;
    write.mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)));
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    // Zurueck zum gespeicherten Stand, waehrend Layout 2 noch geschrieben wird.
    writer.schedule(workspace());
    fail("disk full");
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 })]);

    // Die Datei haelt den alten Stand: ein neuer Wechsel auf Layout 2 ist eine
    // echte Aenderung und kein Wiederholen des gescheiterten Schreibens.
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(written()).toEqual([workspace({ layout: 2 }), workspace({ layout: 2 })]);
    warn.mockRestore();
  });

  it("flush schreibt sofort und nur einmal", async () => {
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 4 }));
    await writer.flush();
    expect(written()).toEqual([workspace({ layout: 4 })]);
    await vi.advanceTimersByTimeAsync(1000);
    await writer.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("dispose verwirft einen ausstehenden Schreibvorgang", async () => {
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 4 }));
    writer.dispose();
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("dispose waehrend eines laufenden Schreibens: danach geht nichts mehr hinaus", async () => {
    let finish!: () => void;
    write.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const writer = createWorkspaceWriter(write, WORKSPACE_PERSIST_MS, workspace());
    writer.schedule(workspace({ layout: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    // Geplant, waehrend Layout 2 geschrieben wird; das Schreiben wartet darauf.
    writer.schedule(workspace({ layout: 4 }));
    await vi.advanceTimersByTimeAsync(500);

    writer.dispose();
    finish();
    await settle();
    writer.schedule(workspace());
    await vi.advanceTimersByTimeAsync(1000);
    expect(written()).toEqual([workspace({ layout: 2 })]);
  });
});

describe("withRecentDir: die Verzeichnisse nach einem Anlegen (UX-Spec §7.6)", () => {
  it("setzt das Verzeichnis als zuletzt genutztes und vorn in recent", () => {
    expect(withRecentDir(null, "/srv/app")).toEqual({ last: "/srv/app", recent: ["/srv/app"] });
    expect(withRecentDir({ last: "/a", recent: ["/a", "/b"] }, "/c")).toEqual({ last: "/c", recent: ["/c", "/a", "/b"] });
  });

  it("fuehrt jedes Verzeichnis hoechstens einmal: ein schon bekanntes rueckt nach vorn", () => {
    expect(withRecentDir({ last: "/a", recent: ["/a", "/b", "/c"] }, "/b")).toEqual({ last: "/b", recent: ["/b", "/a", "/c"] });
    // Auch eine Dublette aus einer von Hand bearbeiteten Datei verschwindet.
    expect(withRecentDir({ last: "/a", recent: ["/a", "/b", "/a"] }, "/c").recent).toEqual(["/c", "/a", "/b"]);
  });

  it("behaelt hoechstens fuenf, die aeltesten fallen weg", () => {
    const entry = { last: "/1", recent: ["/1", "/2", "/3", "/4", "/5"] };
    expect(withRecentDir(entry, "/6").recent).toEqual(["/6", "/1", "/2", "/3", "/4"]);
  });

  it("veraendert den alten Eintrag nicht", () => {
    const entry = { last: "/a", recent: ["/a"] };
    withRecentDir(entry, "/b");
    expect(entry).toEqual({ last: "/a", recent: ["/a"] });
  });

  // Fix-Runde 1, Minor 3: `/srv/app/` und `/srv/app` sind dasselbe Verzeichnis.
  it("fuehrt ein Verzeichnis mit und ohne Schraegstrich am Ende als eines; die Wurzel bleibt die Wurzel", () => {
    expect(withRecentDir({ last: "/srv/app", recent: ["/srv/app", "/tmp"] }, "/srv/app/")).toEqual({
      last: "/srv/app",
      recent: ["/srv/app", "/tmp"],
    });
    // Auch aeltere Eintraege mit Schraegstrich werden eins mit dem neuen.
    expect(withRecentDir({ last: "/a/", recent: ["/a/", "/b//"] }, "/a").recent).toEqual(["/a", "/b"]);
    expect(withRecentDir(null, "/")).toEqual({ last: "/", recent: ["/"] });
    expect(withRecentDir(null, "//")).toEqual({ last: "/", recent: ["/"] });
  });
});

describe("connectInOrder: hoechstens drei Verbindungen zugleich", () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it("startet hoechstens drei zugleich, in der gegebenen Reihenfolge", async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    let done = false;
    void connectInOrder(["a", "b", "c", "d", "e"], (hostId) => {
      started.push(hostId);
      const entry = deferred();
      pending.set(hostId, entry);
      return entry.promise;
    }).then(() => {
      done = true;
    });
    await settle();
    expect(started).toEqual(["a", "b", "c"]);

    pending.get("b")!.resolve();
    await settle();
    expect(started).toEqual(["a", "b", "c", "d"]);

    pending.get("a")!.resolve();
    pending.get("c")!.resolve();
    await settle();
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(done).toBe(false);

    pending.get("d")!.resolve();
    pending.get("e")!.resolve();
    await settle();
    expect(done).toBe(true);
  });

  it("macht nach einem Fehlschlag mit den uebrigen weiter", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started: string[] = [];
    await connectInOrder(["a", "b", "c", "d"], async (hostId) => {
      started.push(hostId);
      if (hostId === "a") throw new Error("boom");
    });
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    warn.mockRestore();
  });
});

describe("createWorkspaceSync: gespeicherter Arbeitsplatz im laufenden Betrieb", () => {
  let state: AppState;
  let collapsed: boolean;
  let write: ReturnType<typeof vi.fn<(ws: WorkspaceDto) => Promise<void>>>;
  let sync: WorkspaceSync;

  beforeEach(() => {
    vi.useFakeTimers();
    state = new AppState();
    state.upsertHost(host("a", { authKind: "key", keyPath: "C:/keys/a" }));
    state.upsertHost(host("b", { authKind: "password" }));
    state.upsertHost(host("c", { authKind: "agent" }));
    collapsed = false;
    write = vi.fn<(ws: WorkspaceDto) => Promise<void>>().mockResolvedValue(undefined);
    sync = createWorkspaceSync({
      state,
      write,
      sidebarCollapsed: () => collapsed,
      setSidebarCollapsed: (value) => {
        collapsed = value;
        sync.changed();
      },
    });
    state.subscribe(() => sync.changed());
  });

  afterEach(() => {
    sync.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function written(): WorkspaceDto[] {
    return write.mock.calls.map(([ws]) => ws);
  }

  const SAVED = workspace({
    layout: 2,
    sidebar_collapsed: true,
    expanded: ["c", "a"],
    connected: ["c", "b", "a"],
    tiles: [
      { slot: 0, host_id: "a", session: "s1" },
      { slot: 1, host_id: "b", session: "x" },
      { slot: 2, host_id: "a", session: "s2" },
    ],
    dirs: { a: { last: "/srv", recent: ["/srv"] } },
  });

  it("wendet beim Start Seitenleiste und aufgeklappte Hosts an und nennt die Hosts zum Verbinden", () => {
    const connect = sync.start(SAVED, true);

    expect(collapsed).toBe(true);
    expect(state.hosts.map((h) => h.expanded)).toEqual([true, false, true]);
    // Reihenfolge der Seitenleiste, ohne den Passwort-Host.
    expect(connect).toEqual(["a", "c"]);
    // Nichts belegt, solange kein Host gelistet ist.
    expect(state.tiles).toEqual([]);
  });

  it("schreibt beim Start nichts, solange sich nichts aendert", async () => {
    sync.start(SAVED, true);
    sync.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("legt die wartenden Kacheln eines Hosts an, sobald seine Liste da ist -- ohne Fokus", async () => {
    sync.start(SAVED, true);
    listHost(state, "a", ["s1", "s2", "s3"]);
    sync.hostListed("a");

    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1", "a/s2"]);
    expect(state.focusedTile).toBeNull();
    // Vollstaendig wiederhergestellt: der Stand gleicht dem gespeicherten.
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
    // Die naechste Wahl des Nutzers kommt als neue Kachel ans Ende (Spec
    // 2026-10-19 §5.1).
    expect(state.openSession("a", "s3").kind).toBe("added");
    expect(state.tiles[state.tiles.length - 1]?.sessionKey).toBe("a/s3");
  });

  // Spec 2026-10-19 §4.5: eine neue Kachel montiert mit ihrer Endgeometrie.
  // Kaeme jede einzeln, oeffnete jede bis auf die letzte in einer Groesse, die
  // nicht ihre ist, und braeuchte danach ein `resize_terminal`.
  it("legt alle wartenden Kacheln eines Hosts in einem Zug an: eine Benachrichtigung", () => {
    sync.start(
      workspace({
        connected: ["a"],
        tiles: ["s1", "s2", "s3", "s4"].map((session, slot) => ({ slot, host_id: "a", session })),
      }),
      true,
    );
    listHost(state, "a", ["s1", "s2", "s3", "s4"]);
    const notified = vi.fn();
    state.subscribe(notified);

    sync.hostListed("a");

    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1", "a/s2", "a/s3", "a/s4"]);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("laesst eine fehlende Session weg und schreibt das ohne sie", async () => {
    sync.start(SAVED, true);
    listHost(state, "a", ["s1"]);
    sync.hostListed("a");

    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1"]);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()).toHaveLength(1);
    expect(written()[0].tiles).toEqual([
      { slot: 0, host_id: "a", session: "s1" },
      { slot: 1, host_id: "b", session: "x" },
    ]);
  });

  it("wendet einen Eintrag nur einmal an: eine spaetere Liste belegt nichts mehr", () => {
    sync.start(SAVED, true);
    listHost(state, "a", ["s1", "s2"]);
    sync.hostListed("a");
    state.closeTile(state.tiles[0].id);
    sync.hostListed("a");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s2"]);
  });

  it("eine wartende Kachel ueberlebt eine vorher geoeffnete andere und erscheint an ihrer Position (Review Focus 4)", async () => {
    sync.start(SAVED, true);
    listHost(state, "a", ["s1", "s2"]);
    sync.hostListed("a");
    listHost(state, "c", ["mine"]);
    state.openSession("c", "mine");
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()[written().length - 1]?.tiles).toEqual([
      { slot: 0, host_id: "a", session: "s1" },
      { slot: 1, host_id: "b", session: "x" },
      { slot: 2, host_id: "a", session: "s2" },
      { slot: 3, host_id: "c", session: "mine" },
    ]);

    listHost(state, "b", ["x"]);
    sync.hostListed("b");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1", "b/x", "a/s2", "c/mine"]);
  });

  it("die Platzreihenfolge stimmt auch, wenn die Hosts in anderer Folge verbinden", () => {
    sync.start(
      workspace({
        connected: ["a", "c"],
        tiles: [
          { slot: 0, host_id: "c", session: "c0" },
          { slot: 1, host_id: "a", session: "a1" },
          { slot: 2, host_id: "c", session: "c2" },
          { slot: 3, host_id: "a", session: "a3" },
        ],
      }),
      true,
    );
    listHost(state, "a", ["a1", "a3"]);
    sync.hostListed("a");
    listHost(state, "c", ["c0", "c2"]);
    sync.hostListed("c");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["c/c0", "a/a1", "c/c2", "a/a3"]);
  });

  // Spec 2026-10-19 §4.6, Nachtrag vom 24.10.: kaemen die Kacheln je Host,
  // aenderte die Liste des spaeteren Hosts die Groesse jeder Kachel des
  // frueheren, je Kachel ein `resize_terminal`; Codex verlor dabei den Verlauf.
  describe("der Start wartet auf die Hosts, die er selbst verbindet", () => {
    const TWO_HOSTS = workspace({
      connected: ["a", "c"],
      tiles: [
        { slot: 0, host_id: "a", session: "a0" },
        { slot: 1, host_id: "c", session: "c1" },
        { slot: 2, host_id: "a", session: "a2" },
      ],
    });

    it("legt die Kacheln erst mit der letzten Liste an, alle in einer Benachrichtigung", () => {
      expect(sync.start(TWO_HOSTS, true)).toEqual(["a", "c"]);
      const notified = vi.fn();
      listHost(state, "a", ["a0", "a2"]);
      state.subscribe(notified);
      sync.hostListed("a");
      expect(state.tiles).toEqual([]);

      listHost(state, "c", ["c1"]);
      notified.mockClear();
      sync.hostListed("c");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/a0", "c/c1", "a/a2"]);
      expect(notified).toHaveBeenCalledTimes(1);
      expect(state.focusedTile).toBeNull();
    });

    it("wartet nicht weiter auf einen Host, dessen Versuch ohne Liste endete", () => {
      sync.start(TWO_HOSTS, true);
      listHost(state, "a", ["a0", "a2"]);
      sync.hostListed("a");
      sync.hostSettled("a");
      expect(state.tiles).toEqual([]);

      sync.hostSettled("c");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/a0", "a/a2"]);
    });

    it("legt nach der Frist an, was gelistet ist; ein spaeterer Host reiht sich an seinen Plaetzen ein", () => {
      sync.start(TWO_HOSTS, true);
      listHost(state, "a", ["a0", "a2"]);
      sync.hostListed("a");
      vi.advanceTimersByTime(RESTORE_HOLD_MS - 1);
      expect(state.tiles).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/a0", "a/a2"]);

      listHost(state, "c", ["c1"]);
      sync.hostListed("c");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/a0", "c/c1", "a/a2"]);
    });

    it("wartet nicht auf einen Host, den der Nutzer trennt oder entfernt", () => {
      sync.start(TWO_HOSTS, true);
      listHost(state, "a", ["a0", "a2"]);
      sync.hostListed("a");
      sync.hostDisconnectedByUser("c");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/a0", "a/a2"]);
    });

    it("wartet nicht auf einen Host ohne gespeicherte Kacheln oder einen, den der Start nicht verbindet", () => {
      // SAVED: Kacheln auf a und dem Passwort-Host b; c hat keine.
      sync.start(SAVED, true);
      listHost(state, "a", ["s1", "s2"]);
      sync.hostListed("a");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1", "a/s2"]);
    });

    it("ein Host, der waehrend des Wartens gelistet wird, kommt im selben Zug mit", () => {
      sync.start(SAVED, true);
      // Der Nutzer verbindet den Passwort-Host b von Hand, bevor a gelistet ist.
      listHost(state, "b", ["x"]);
      sync.hostListed("b");
      expect(state.tiles).toEqual([]);
      listHost(state, "a", ["s1", "s2"]);
      sync.hostListed("a");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1", "b/x", "a/s2"]);
    });

    it("trennt der Nutzer einen schon gelisteten Host, warten seine Kacheln weiter, statt gesperrt zu erscheinen", async () => {
      sync.start(TWO_HOSTS, true);
      listHost(state, "a", ["a0", "a2"]);
      sync.hostListed("a");
      // Wie main.ts: getrennt, die Sessionliste bleibt stehen.
      state.setRuntimeId("a", null);
      state.setHostState("a", "disconnected");
      sync.hostDisconnectedByUser("a");
      listHost(state, "c", ["c1"]);
      sync.hostListed("c");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(["c/c1"]);
      // Gespeichert bleiben sie an ihren Plaetzen.
      await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
      expect(written()[written().length - 1]?.tiles).toEqual(TWO_HOSTS.tiles);
    });

    // Spec 2026-10-19 §8.1: an der Grenze entfaellt, was nicht mehr passt.
    // Kaeme die Wahl des Nutzers vor die gespeicherten Kacheln, verloere eine
    // von ihnen den Platz.
    it("oeffnet der Nutzer selbst, endet das Warten: Gelistetes kommt vor seiner Wahl", () => {
      const mine = Array.from({ length: MAX_TILES_PER_HOST }, (_, i) => `s${i + 1}`);
      sync.start(
        workspace({
          connected: ["a", "c"],
          tiles: [
            ...mine.map((session, slot) => ({ slot, host_id: "a", session })),
            { slot: MAX_TILES_PER_HOST, host_id: "c", session: "c1" },
          ],
        }),
        true,
      );
      listHost(state, "a", [...mine, "extra"]);
      sync.hostListed("a");
      expect(state.tiles).toEqual([]);

      sync.beforeUserOpen();
      expect(state.tiles.map((t) => t.sessionKey)).toEqual(mine.map((name) => `a/${name}`));
      expect(state.openSession("a", "extra").kind).toBe("limit");

      listHost(state, "c", ["c1"]);
      sync.hostListed("c");
      expect(state.tiles.map((t) => t.sessionKey)).toEqual([...mine.map((name) => `a/${name}`), "c/c1"]);
    });
  });

  // Spec 2026-10-19 §8.1 (ab Schritt 3), Review Focus 1: acht gespeicherte
  // Kacheln eines Hosts und eine eines anderen kommen alle zurueck, in welcher
  // Folge die Hosts auch verbinden. Mit vier je Host entfielen die Kacheln
  // fuenf bis acht und mit dem naechsten Schreiben auch aus der Datei.
  it.each<[string, string[]]>([
    ["erst der Host mit acht", ["a", "c"]],
    ["erst der Host mit einer", ["c", "a"]],
  ])("stellt acht Kacheln eines Hosts und eine eines anderen vollstaendig her, %s (Spec §8.1, Review Focus 1)", async (_order, order) => {
    const mine = Array.from({ length: MAX_TILES_PER_HOST }, (_, i) => `s${i + 1}`);
    const tiles = [
      ...mine.map((session, slot) => ({ slot, host_id: "a", session })),
      { slot: MAX_TILES_PER_HOST, host_id: "c", session: "c1" },
    ];
    expect(tiles).toHaveLength(MAX_TILES);
    const lists: Record<string, string[]> = { a: mine, c: ["c1"] };
    sync.start(workspace({ connected: ["a", "c"], tiles }), true);
    for (const hostId of order) {
      listHost(state, hostId, lists[hostId]);
      sync.hostListed(hostId);
    }
    expect(state.tiles.map((t) => t.sessionKey)).toEqual([...mine.map((name) => `a/${name}`), "c/c1"]);
    expect(state.focusedTile).toBeNull();
    // Nichts entfiel: der Stand gleicht dem gespeicherten, geschrieben wird nichts.
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
    // Die naechste Aenderung schreibt alle neun an ihren Plaetzen.
    state.setHostExpanded("a", true);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()).toHaveLength(1);
    expect(written()[0].tiles).toEqual(tiles);
  });

  it("eine wartende Kachel haelt die Grenze je Host ein: an der Grenze entfaellt sie (Review Focus 4)", async () => {
    sync.start(SAVED, true);
    const mine = Array.from({ length: MAX_TILES_PER_HOST }, (_, i) => `t${i + 1}`);
    listHost(state, "a", ["s1", "s2", ...mine]);
    for (const name of mine) state.openSession("a", name);
    sync.hostListed("a");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(mine.map((name) => `a/${name}`));
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()[written().length - 1]?.tiles.map((t) => t.session)).toEqual([mine[0], "x", ...mine.slice(1)]);
  });

  it("ein wartender Eintrag verfaellt erst, wenn seine Session in einer Kachel steht", async () => {
    sync.start(SAVED, true);
    listHost(state, "b", ["x"]);
    state.openSession("b", "x");
    sync.hostListed("b");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["b/x"]);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()[written().length - 1]?.tiles.filter((t) => t.host_id === "b")).toHaveLength(1);
  });

  // Seit Task 4 nimmt `readWorkspace` Plaetze bis 8 an. Wartende Kacheln
  // haengen am Sessionschluessel, nicht an einem Platz der laufenden Liste:
  // eine auf Platz 5 darf beim ersten Abgleich nicht verfallen, nur weil die
  // Liste noch keine sechs Kacheln hat.
  it("eine wartende Kachel auf Platz 5 ueberlebt den Start und geht an ihrer Position zurueck in die Datei (Spec 2026-10-19 §4.6)", async () => {
    const tiles = [
      { slot: 0, host_id: "a", session: "s1" },
      { slot: 1, host_id: "c", session: "c1" },
      { slot: 2, host_id: "a", session: "s2" },
      { slot: 3, host_id: "c", session: "c2" },
      { slot: 4, host_id: "a", session: "s3" },
      { slot: 5, host_id: "b", session: "x" },
    ];
    sync.start(workspace({ connected: ["a", "c"], tiles }), true);
    listHost(state, "a", ["s1", "s2", "s3"]);
    sync.hostListed("a");
    listHost(state, "c", ["c1", "c2"]);
    sync.hostListed("c");
    // Der Stand gleicht dem gespeicherten, die wartende Kachel eingerechnet.
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(write).not.toHaveBeenCalled();

    state.setHostExpanded("a", true);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()[written().length - 1]?.tiles).toEqual(tiles);

    listHost(state, "b", ["x"]);
    sync.hostListed("b");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1", "c/c1", "a/s2", "c/c2", "a/s3", "b/x"]);
  });

  it("ein entfernter Host nimmt seine Eintraege in connected, tiles und dirs mit", async () => {
    sync.start({ ...SAVED, dirs: { a: { last: "/srv", recent: ["/srv"] }, b: { last: "/x", recent: ["/x"] } } }, true);
    state.removeHost("b");
    sync.hostRemoved("b");
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    const [ws] = written();
    expect(ws.connected).toEqual(["c", "a"]);
    expect(ws.tiles.map((t) => t.host_id)).toEqual(["a", "a"]);
    expect(ws.dirs).toEqual({ a: { last: "/srv", recent: ["/srv"] } });
  });

  it("connected: hinzu bei jeder Verbindung, weg nur beim Trennen durch den Nutzer", async () => {
    sync.start(workspace(), true);
    sync.hostConnected("c");
    sync.hostConnected("c");
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    sync.hostDisconnectedByUser("c");
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written().map((ws) => ws.connected)).toEqual([["c"], []]);
  });

  it("wantsConnected sagt der Warteschlange des Starts, ob der Nutzer den Host noch verbunden haben will", () => {
    sync.start(SAVED, true);
    expect(["a", "b", "c"].map((id) => sync.wantsConnected(id))).toEqual([true, true, true]);

    sync.hostDisconnectedByUser("c");
    expect(sync.wantsConnected("c")).toBe(false);
    sync.hostConnected("c");
    expect(sync.wantsConnected("c")).toBe(true);
    sync.hostRemoved("a");
    expect(sync.wantsConnected("a")).toBe(false);
  });

  it("ein Trennen vor dem Start gilt: der gelesene Stand bringt den Host nicht zurueck", async () => {
    sync.hostDisconnectedByUser("c");

    expect(sync.start(SAVED, true)).toEqual(["a"]);
    expect(sync.wantsConnected("c")).toBe(false);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written().map((ws) => ws.connected)).toEqual([["b", "a"]]);
  });

  it("ein Verbinden vor dem Start gilt, auch nach einem Trennen davor", async () => {
    sync.hostDisconnectedByUser("c");
    sync.hostConnected("c");

    // Gelesen ist nur der Passwort-Host; den verbindet der Start nicht.
    expect(sync.start(workspace({ connected: ["b"] }), true)).toEqual([]);
    expect(sync.wantsConnected("c")).toBe(true);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written().map((ws) => ws.connected)).toEqual([["b", "c"]]);
  });

  it("ein vor dem Start getrennter und wieder verbundener Host zaehlt beim Start wie jeder gelesene", () => {
    sync.hostDisconnectedByUser("a");
    sync.hostConnected("a");

    // "a" steht im gelesenen Stand: das Trennen davor haelt ihn nicht mehr heraus.
    expect(sync.start(SAVED, true)).toEqual(["a", "c"]);
    expect(sync.wantsConnected("a")).toBe(true);
  });

  it("ohne restore fuehren allein die Ereignisse dieses Laufs connected", async () => {
    sync.hostConnected("c");

    expect(sync.start(SAVED, false)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();

    state.setHostExpanded("a", true);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written().map((ws) => ws.connected)).toEqual([["c"]]);
  });

  it("die Seitenleiste meldet ihren Zustand, und er wird geschrieben", async () => {
    sync.start(workspace(), true);
    collapsed = true;
    sync.changed();
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written()).toEqual([workspace({ sidebar_collapsed: true })]);
  });

  it("restore aus: wendet nichts an und schreibt beim Start nichts, speichert aber jede Aenderung", async () => {
    const connect = sync.start(SAVED, false);

    expect(connect).toEqual([]);
    expect(collapsed).toBe(false);
    expect(state.hosts.every((h) => !h.expanded)).toBe(true);
    listHost(state, "a", ["s1", "s2"]);
    sync.hostListed("a");
    expect(state.tiles.length === 0).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();

    state.setHostExpanded("a", true);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    // Der Stand dieses Laufs; dirs gehen unveraendert mit.
    expect(written()).toEqual([workspace({ expanded: ["a"], dirs: SAVED.dirs })]);
  });

  it("ohne brauchbaren Stand bleibt sie fuer den ganzen Lauf still", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sync.changed();
    expect(sync.start(undefined, true)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no usable workspace"));
    state.setHostExpanded("a", true);
    sync.hostConnected("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uebernimmt beim Start einen Host, der schon verbunden und gelistet ist", () => {
    listHost(state, "a", ["s1", "s2"]);
    sync.start(SAVED, true);
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/s1", "a/s2"]);
  });

  it("nach dispose schreibt sie nicht mehr", async () => {
    sync.start(workspace(), true);
    state.setHostExpanded("a", true);
    sync.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
  });

  // UX-Spec §7.6: die Verzeichnisse je Host fuer "Neue Session".
  it("dirs liefert die gelesenen Verzeichnisse eines Hosts als Kopie, ohne Eintrag null", () => {
    sync.start(SAVED, true);
    const dirs = sync.dirs("a");
    expect(dirs).toEqual({ last: "/srv", recent: ["/srv"] });
    dirs!.recent.push("/changed");
    expect(sync.dirs("a")).toEqual({ last: "/srv", recent: ["/srv"] });
    expect(sync.dirs("c")).toBeNull();
  });

  it("setDirs schreibt den ganzen Schnappschuss mit den neuen Verzeichnissen, entprellt", async () => {
    sync.start(SAVED, true);
    sync.setDirs("c", { last: "/opt", recent: ["/opt"] });
    expect(sync.dirs("c")).toEqual({ last: "/opt", recent: ["/opt"] });
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS - 1);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(written()).toEqual([
      { ...SAVED, expanded: ["a", "c"], dirs: { a: { last: "/srv", recent: ["/srv"] }, c: { last: "/opt", recent: ["/opt"] } } },
    ]);
  });

  it("ohne gelesenen Stand wirkt setDirs nur im Speicher", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sync.start(undefined, true);
    sync.setDirs("a", { last: "/opt", recent: ["/opt"] });
    expect(sync.dirs("a")).toEqual({ last: "/opt", recent: ["/opt"] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("Verzeichnisse aus diesem Lauf gelten auch, wenn der gelesene Stand erst danach kommt", async () => {
    sync.setDirs("a", { last: "/opt", recent: ["/opt", "/srv"] });
    sync.start(SAVED, true);
    expect(sync.dirs("a")).toEqual({ last: "/opt", recent: ["/opt", "/srv"] });
    await vi.advanceTimersByTimeAsync(WORKSPACE_PERSIST_MS);
    expect(written().map((ws) => ws.dirs)).toEqual([{ a: { last: "/opt", recent: ["/opt", "/srv"] } }]);
  });
});

describe("Arbeitsplatz: Kacheln des Standard-Sockets (Spec 2026-10-25 §5, §7)", () => {
  const FOREIGN = { slot: 1, host_id: "a", session: "", foreign_session: "main", socket: "default" as const };

  it("liest die fremde Form und verwirft jede gemischte", () => {
    const read = readWorkspace(
      workspace({
        tiles: [
          { slot: 0, host_id: "a", session: "main" },
          FOREIGN,
          { slot: 2, host_id: "a", session: "own", foreign_session: "both", socket: "default" },
          { slot: 3, host_id: "a", session: "", foreign_session: "no-socket" } as never,
          { slot: 4, host_id: "a", session: "", foreign_session: "main", socket: "default" },
        ],
      }),
      ["a"],
    );
    expect(read?.tiles).toEqual([{ slot: 0, host_id: "a", session: "main" }, FOREIGN]);
  });

  it("speichert gleichnamige Kacheln beider Sockets nebeneinander, die fremde in ihrer Form", () => {
    const state = new AppState();
    state.upsertHost(host("a", { state: "connected", runtimeId: "r-a" }));
    state.setSessionRecords("a", [{ name: "main" }]);
    state.setSessionRecords("a", [{ name: "main" }], undefined, "default");
    state.openSession("a", "main");
    state.openSession("a", "main", "default");
    expect(workspaceFromState(state, extras()).tiles).toEqual([{ slot: 0, host_id: "a", session: "main" }, FOREIGN]);
  });

  it("stellt eine fremde Kachel erst her, wenn die Liste des Standard-Sockets da ist", () => {
    vi.useFakeTimers();
    const state = new AppState();
    state.upsertHost(host("a", { authKind: "agent" }));
    const sync = createWorkspaceSync({
      state,
      write: vi.fn().mockResolvedValue(undefined),
      sidebarCollapsed: () => false,
      setSidebarCollapsed: () => {},
    });
    sync.start(workspace({ tiles: [{ slot: 0, host_id: "a", session: "main" }, FOREIGN] }), true);
    listHost(state, "a", ["main"]);
    sync.hostListed("a");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/main"]);
    state.setSessionRecords(
      "a",
      [{ name: "main", sessionId: 1, serverPid: 2, serverStartTime: 3, windowId: 4, paneId: 5, panePid: 6 }],
      undefined,
      "default",
    );
    sync.hostListed("a");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/main", "a/default:main"]);
    sync.dispose();
    vi.useRealTimers();
  });
});

describe("Arbeitsplatz: fremde Kacheln bei ausgeschaltetem Schalter (Review von PR #5)", () => {
  it("laesst sie warten, statt sie zu verwerfen", () => {
    vi.useFakeTimers();
    const state = new AppState();
    state.upsertHost(host("a", { authKind: "agent" }));
    const write = vi.fn().mockResolvedValue(undefined);
    const sync = createWorkspaceSync({ state, write, sidebarCollapsed: () => false, setSidebarCollapsed: () => {} });
    const foreign = { slot: 1, host_id: "a", session: "", foreign_session: "main", socket: "default" as const };
    sync.start(workspace({ tiles: [{ slot: 0, host_id: "a", session: "own" }, foreign] }), true);
    listHost(state, "a", ["own"]);
    state.clearSocket("a", "default");
    sync.hostListed("a");
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(["a/own"]);
    expect(workspaceFromState(state, extras({ pendingTiles: [foreign] })).tiles).toContainEqual(foreign);
    sync.dispose();
    vi.useRealTimers();
  });
});
