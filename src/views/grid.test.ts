// Automatisierte Gegenprobe fuer die drei Eigenschaften
// (Task 10), die sich ohne echtes WebView pruefen lassen:
//   1. Ein sichtbar bleibendes Terminal wird NICHT erneut gemountet.
//   2. Eine verborgene Kachel (Maximieren einer anderen) behaelt ihren
//      TerminalHandle und misst nicht (`setHidden`); Zurueckholen montiert
//      und entsorgt nichts (Spec 2026-10-19 §8.1, Schritt 3).
//   3. JEDE Layoutaenderung laeuft ueber denselben entprellten Refit-Pfad.
// Dazu Test 4 (Maximieren aendert die Kachelzuordnung nicht).
// Die Lage selbst rechnet `tile-layout.ts` mit blossen Zahlen (eigene Tests);
// hier gibt `stubGridSize` der Rasterflaeche feste Masse, weil jsdom
// `clientWidth`/`clientHeight` sonst immer als 0 liefert (siehe
// `terminal.test.ts`s Kommentar zum selben Befund).
//
// `../terminal` wird komplett gemockt (dieselbe Technik wie
// `src/terminal.test.ts` fuer `@xterm/xterm`/die Tauri-API): `grid.ts`
// importiert nur `mountTerminal`/`TerminalHandle` von dort, xterm.js selbst
// taucht in dieser Datei nirgends auf. Der gemockte `refit()` bildet
// `terminal.ts`s eigenen 300-ms-Entpreller nach (derselbe Wert wie
// `RESIZE_DEBOUNCE_MS`) -- NICHT, weil `grid.ts` selbst einen Entpreller
// braeuchte (Anforderung 3 verlangt das Gegenteil: GENAU EINEN Pfad, der in
// `terminal.ts` lebt), sondern damit Test 3 die reale Verkabelung prueft
// (`grid.refit()` ruft `handle.refit()` auf jeder sichtbaren Kachel auf,
// ungebremst -- die Buendelung entsteht im Mock/in `terminal.ts`, nicht in
// `grid.ts`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  return {
    mountTerminalSpy: vi.fn(),
    disposeSpy: vi.fn(),
    /** Mit dem Sessionnamen gerufen: ein Test kann so sagen, WELCHE Kachel
     * gemessen hat, nicht nur wie viele. */
    fitSpy: vi.fn(),
    /** Spec 2026-10-19 §8.1 (Schritt 3): mit Sessionname und Wert, damit
     * pruefbar ist, welche Kachel das Raster verbirgt und wieder zeigt. */
    setHiddenSpy: vi.fn(),
    /** Mit dem Sessionnamen gerufen, nicht blank: eine blosse Zaehlung
     * koennte nicht sagen, WELCHE Kachel den Fokus bekommen hat -- und genau
     * das ist die Zusage aus Designsystem §7.5. */
    focusSpy: vi.fn(),
    /** Task 3: mit dem Thema gerufen, damit die Weiterreichung
     * (`GridHandle.applyTerminalTheme` -> `TerminalHandle.setTheme`)
     * pruefbar ist, nicht nur die blosse Aufrufzahl. */
    setThemeSpy: vi.fn(),
    /** UX-Spec §6.7: mit Sessionname und Groesse, damit pruefbar ist, dass
     * JEDE gemountete Kachel die Schriftgroesse bekommt. */
    setFontSizeSpy: vi.fn(),
    /** Die Schriftgroesse aus `terminal-prefs` im Augenblick jedes Mounts --
     * genau die liest das echte `mountTerminal` beim Bau (`terminal.test.ts`). */
    fontSizeAtMount: [] as number[],
    /** Je Mount (in Reihenfolge) die zuletzt per `setInputLocked` gesetzte
     * Sperre -- `false`, solange das Raster nichts gesetzt hat. */
    inputLockedByMount: [] as boolean[],
    /** Legt `focus()` den Dokumentfokus wirklich in die Kachel, wie xterm sein
     * Hilfstextfeld fokussiert? Nur fuer die Tests, in denen genau dieser
     * Dokumentfokus die Frage ist (Fokus nach dem Schliessen, Spec 2026-10-19
     * §5.5). Sonst bleibt der Mock stumm, wie die uebrigen Tests ihn kennen. */
    focusMovesDom: false,
    /** Spec 2026-10-19 §8.1 (Schritt 3): Sessions, deren Terminal schon beim
     * Bau meldet, dass es auf einen Platz wartet (`onQueued(true)`, bevor
     * `mountTerminal` zurueckkehrt) -- so tut es das echte, wenn die Schlange
     * seines Hosts voll ist. Den Platz teilt der Test zu, ueber die
     * mitgeschnittenen Optionen (`onQueued(false)`). */
    queuedSessions: new Set<string>(),
    /** Spec 2026-10-19 §8.1 (Schritt 3): laeuft in `dispose()` jedes gemockten
     * Terminals, vor `disposeSpy`, mit dem Namen seiner Session. So gibt das
     * echte `dispose()` zuerst seinen Platz in der Schlange frei, und die
     * Schlange teilt ihn synchron einem Wartenden zu (`onQueued(false)`), also
     * mitten im Neuzeichnen des Rasters. Wen es trifft, bestimmt der Test: er
     * ruft die mitgeschnittenen Optionen des Wartenden. */
    onDispose: null as ((session: string) => void) | null,
  };
});

vi.mock("../terminal", async () => {
  const prefs = await import("../terminal-prefs");
  return {
    mountTerminal: (...args: unknown[]) => {
      hoisted.mountTerminalSpy(...args);
      hoisted.fontSizeAtMount.push(prefs.terminalPrefs().fontSize);
      const mountIndex = hoisted.inputLockedByMount.length;
      hoisted.inputLockedByMount.push(false);
      let refitTimer: ReturnType<typeof setTimeout> | undefined;
      const sessionName = args[2] as string;
      if (hoisted.queuedSessions.has(sessionName)) {
        (args[4] as { onQueued?: (queued: boolean) => void } | undefined)?.onQueued?.(true);
      }
      return {
        setInputLocked: (locked: boolean) => {
          hoisted.inputLockedByMount[mountIndex] = locked;
        },
        dispose: () => {
          hoisted.onDispose?.(sessionName);
          hoisted.disposeSpy();
        },
        focus: () => {
          hoisted.focusSpy(sessionName);
          if (!hoisted.focusMovesDom) return;
          const container = args[0] as HTMLElement;
          let helper = container.querySelector("textarea");
          if (!helper) {
            helper = document.createElement("textarea");
            container.appendChild(helper);
          }
          helper.focus();
        },
        // Nachbildung von `terminal.ts::scheduleRefit` (300 ms, letzter
        // Aufruf gewinnt) -- siehe Kopfkommentar oben.
        refit: () => {
          clearTimeout(refitTimer);
          refitTimer = setTimeout(() => {
            hoisted.fitSpy(sessionName);
          }, 300);
        },
        // Bewusst ohne Wirkung auf `refit` oben: misst das Raster eine
        // verborgene Kachel, soll `fitSpy` das zeigen, statt es zu verschlucken.
        setHidden: (hidden: boolean) => {
          hoisted.setHiddenSpy(sessionName, hidden);
        },
        setTheme: (theme: string) => {
          hoisted.setThemeSpy(theme);
        },
        setFontSize: (size: number) => {
          hoisted.setFontSizeSpy(sessionName, size);
        },
      };
    },
  };
});

import en from "../i18n/en.json";
import { AppState, type Host } from "../state/app-state";
import { MAX_TILES_PER_HOST } from "../state/tile-assignment";
import { createWorkspaceSync, type WorkspaceSync } from "../state/workspace";
import { DEFAULT_KEYMAP } from "../keymap";
import { DEFAULT_TERMINAL_PREFS, setTerminalPrefs, terminalPrefs } from "../terminal-prefs";
import { isCapacityError, mountGrid, type GridHandle, type GridOptions } from "./grid";
import type { TerminalError } from "../terminal";
import type { OpenQueue } from "../terminal-open-queue";

/** `runtimeId` ist ABSICHTLICH gesetzt und ungleich `id`: ohne Laufzeit-ID
 * montiert `reconcile` gar nichts (siehe dort), saemtliche Mount-Zaehlungen
 * dieser Datei liefen dann ins Leere. Ein von `id` VERSCHIEDENER Wert, weil
 * die beiden ID-Raeume in der Anwendung nie zusammenfallen -- eine
 * Vorrichtung, in der sie es taeten, koennte eine Verwechslung nicht
 * sichtbar machen. Der optionale zweite Parameter ist fuer den Test da, der
 * zwei aufeinanderfolgende Verbindungen desselben Hosts durchspielt. */
function makeHost(id: string, label: string, runtimeId: string | null = `r-${id}`): Host {
  return {
    id,
    runtimeId,
    label,
    hostname: `${id}.example`,
    user: "root",
    port: 22,
    keyPath: null,
    authKind: "agent",
    state: "connected",
    error: null,
    sessions: [],
    expanded: true,
    lastCwd: "/tmp",
  };
}

const activeHandles: GridHandle[] = [];
function mount(el: HTMLElement, state: AppState, opts?: Partial<GridOptions>): GridHandle {
  const handle = mountGrid(el, state, {
    onTerminalError: vi.fn(),
    onCloseTerminal: vi.fn(),
    onReconnectHost: vi.fn(),
    onNewSession: vi.fn(),
    onConnectionLost: vi.fn(),
    onTerminalOpenFailed: vi.fn(),
    onTerminalCapacity: vi.fn(),
    ...opts,
  });
  activeHandles.push(handle);
  return handle;
}

/** Die Kacheln in Anzeigereihenfolge. Die DOM-Reihenfolge folgt der
 * Entstehung, nicht der Anzeige (Spec 2026-10-19 §4.3). */
function tilesByPosition(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(".tile")).sort(
    (a, b) => Number(a.dataset.position) - Number(b.dataset.position),
  );
}

/** jsdom misst nichts, `clientWidth` ist dort immer 0. Die Rasterflaeche
 * bekommt hier feste Masse, alles andere bleibt 0. `afterEach` nimmt die
 * beiden Eigenschaften wieder weg; danach gilt wieder die von `Element`. */
function stubGridSize(width: number, height: number): void {
  for (const [name, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("grid") ? value : 0;
      },
    });
  }
}

/** Ein verbundener Host, jede Session in einer eigenen Kachel. */
function stateWithTiles(names: string[]): AppState {
  const state = new AppState();
  state.upsertHost(makeHost("h1", "vm-1"));
  state.setSessions("h1", names);
  for (const name of names) state.openSession("h1", name);
  return state;
}

beforeEach(() => {
  hoisted.mountTerminalSpy.mockReset();
  hoisted.disposeSpy.mockReset();
  hoisted.fitSpy.mockReset();
  hoisted.setHiddenSpy.mockReset();
  hoisted.focusSpy.mockReset();
  hoisted.setThemeSpy.mockReset();
  hoisted.setFontSizeSpy.mockReset();
  hoisted.fontSizeAtMount.length = 0;
  hoisted.inputLockedByMount.length = 0;
  hoisted.focusMovesDom = false;
  hoisted.queuedSessions.clear();
  hoisted.onDispose = null;
  setTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS });
});

afterEach(() => {
  activeHandles.splice(0).forEach((h) => h.dispose());
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

describe("mountGrid: Remount-Vermeidung (Anforderung 1)", () => {
  it("eine weitere Kachel montiert die erste nicht neu (Spec 2026-10-19 §4.3)", () => {
    const state = stateWithTiles(["s1"]);
    mount(document.createElement("div"), state);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s2");
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
  });

  it("Schliessen einer Kachel entsorgt nur ihr Terminal", () => {
    const state = stateWithTiles(["s1", "s2", "s3"]);
    mount(document.createElement("div"), state);
    state.closeTile(state.tiles[1].id);
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);
  });
});

// Paket 2.5, Aufgabe 1, Teil 2: der Schluessel allein sagt nicht, ob die
// Kachel noch an der Verbindung haengt, die sie geoeffnet hat. Nach einem
// Abriss und einem erneuten "Connect" ist die Session dieselbe -- der
// PTY-Kanal darunter ist mit dem alten Transport gestorben. Ohne den
// zweiten Vergleich saehe die Kachel gesund aus (Titel, Hostname,
// Sperrleiste alle wieder da) und verschluckte trotzdem jede Eingabe.
describe("mountGrid: die Kachel montiert neu, wenn die Verbindung eine andere ist", () => {
  it("entsorgt den alten Handle und montiert neu, wenn derselbe Sessionschluessel an einer NEUEN Laufzeit-ID haengt", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1", "r1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");

    mount(document.createElement("div"), state);
    // Vorbedingung: der erste Handle haengt tatsaechlich an "r1" -- ohne sie
    // koennte der Vergleich unten auch dann gruen sein, wenn `mountTerminal`
    // die Laufzeit-ID gar nie bekommen haette.
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.mountTerminalSpy.mock.calls[0][1]).toBe("r1");

    // Der Wiederverbindungsfall: `connect_host` stellt eine FRISCHE
    // Laufzeit-ID aus (`next_host_id`, ein Atomic-Zaehler), der
    // Sessionschluessel "h1/s1" bleibt dabei woertlich derselbe.
    state.setRuntimeId("h1", "r2");

    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    expect(hoisted.mountTerminalSpy.mock.calls[1][1]).toBe("r2");
  });

  it("montiert NICHT neu, wenn zwei aufeinanderfolgende Abgleiche dieselbe Laufzeit-ID sehen", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1", "r1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");

    mount(document.createElement("div"), state);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);

    // ZWEI weitere Abgleiche, und zwar der realistische Ausloeser: eine im
    // Hintergrund eintreffende Sessionliste, die nichts aendert. Mit nur
    // EINEM Abgleich prueft diese Zusicherung nichts -- eine Umsetzung, die
    // bei jeder Benachrichtigung neu montiert, montiert bei einem einzigen
    // Neuzeichnen ebenfalls genau einmal, und die Beobachtung kann die
    // beiden nicht trennen (dasselbe Strukturmuster wie der behobene
    // "ein Zeichen, ohne Puffer"-Test in `terminal.test.ts`).
    state.setSessions("h1", ["s1"]);
    state.setSessions("h1", ["s1"]);

    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
  });

  it("montiert gar nichts, solange der Host keine Laufzeit-ID hat", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1", null));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");

    mount(document.createElement("div"), state);

    // `open_terminal` scheiterte ohne lebende Verbindung sicher; eine Kachel
    // mit Handle an einer nicht existierenden Verbindung waere genau der
    // Zustand, den dieses Paket beseitigt.
    expect(hoisted.mountTerminalSpy).not.toHaveBeenCalled();
  });
});

// Paket 2.5, Aufgabe 2: Designsystem §7.5 verspricht "ist sie als Kachel
// sichtbar, folgt der Tastaturfokus dorthin". Die Ansicht liefert dafuer das
// Werkzeug; WANN es benutzt wird, entscheidet `main.ts` (siehe dort und den
// Doc-Kommentar an `GridHandle.focusActiveTile`).
describe("mountGrid: focusActiveTile", () => {
  it("legt den Fokus in das Terminal GENAU der fokussierten Kachel", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s1"); // Kachel 0
    state.openSession("h1", "s2"); // Kachel 1, und damit die fokussierte

    const grid = mount(document.createElement("div"), state);
    // Vorbedingung: das blosse Montieren fokussiert NICHTS -- der
    // Fokuswunsch reist mit der Aktion, nicht mit dem Zustand.
    expect(hoisted.focusSpy).not.toHaveBeenCalled();

    grid.focusActiveTile();

    expect(hoisted.focusSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.focusSpy).toHaveBeenCalledWith("s2");
  });

  // Eine reine VERHALTENSaussage, kein Mechanismus: die `null`-Wache in
  // `focusActiveTile` ist fuer TypeScript da (`handles[null]` ist kein
  // gueltiger Index), und ohne sie verstummte zur Laufzeit ohnehin das `?.`.
  // Der Test kann sie also nicht pinnen und behauptet das auch nicht --
  // ausgeschrieben, damit ihn niemand fuer eine Gegenprobe haelt, die er
  // nicht ist (Gutachten zu diesem Paket).
  it("tut nichts, wenn gar keine Kachel fokussiert ist", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);

    const grid = mount(document.createElement("div"), state);
    // `focusedTile` startet als `null` (`app-state.ts`) -- ohne diese
    // Vorbedingung liefe der Test an seiner eigenen Aussage vorbei.
    expect(state.focusedTile).toBeNull();

    grid.focusActiveTile();

    expect(hoisted.focusSpy).not.toHaveBeenCalled();
  });

  it("legt den Fokus in das frisch montierte Terminal, wenn die Sperrleiste 'Reconnect' meldet", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);
    state.lockInput("h1", "s1");
    hoisted.focusSpy.mockClear();

    // Vorbedingung: die Sperrleiste ist wirklich da -- ohne sie klickte der
    // Test auf nichts und bliebe stumm gruen.
    const reconnect = el.querySelector<HTMLButtonElement>(".tile-lock-reconnect");
    if (!reconnect) throw new Error("lock strip has no reconnect button");
    reconnect.click();

    // Dieselbe Benutzerabsicht wie jede andere Sessionwahl, also derselbe
    // Fokusweg (Designsystem §7.5) -- dieser Knopf laeuft an
    // `main.ts::openSessionByUser` vorbei und braucht ihn deshalb selbst.
    expect(hoisted.focusSpy).toHaveBeenCalledWith("s1");
  });

  it("fokussiert nach dem Entsorgen des Rasters nichts mehr", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");

    const grid = mount(document.createElement("div"), state);
    grid.dispose();
    hoisted.focusSpy.mockClear();

    // Eine entsorgte Ansicht darf den Fokus nicht mehr anfassen: ihre
    // Terminals sind entsorgt, ihr DOM ist geraeumt -- ein `focus()` waere
    // ein Griff ins Nichts.
    grid.focusActiveTile();

    expect(hoisted.focusSpy).not.toHaveBeenCalled();
  });

  // Spec 2026-10-19 §8.1 (Schritt 3): eine verborgene Kachel behaelt ihr
  // Terminal. Dass die maximierte die fokussierte ist, sichern nur die Wege des
  // Nutzers, `AppState` erzwingt es nicht.
  it("fokussiert keine verborgene Kachel, auch wenn sie in AppState den Fokus hat", () => {
    const state = stateWithTiles(["s1", "s2"]);
    const grid = mount(document.createElement("div"), state);
    // s2 hat den Fokus (zuletzt geoeffnet), maximiert wird s1.
    state.toggleMaximize(state.tiles[0].id);
    expect(state.focusedTile).toBe(state.tiles[1].id);

    grid.focusActiveTile();

    expect(hoisted.focusSpy).not.toHaveBeenCalled();
  });
});

describe("mountGrid: verborgene Kacheln behalten ihr Terminal (Anforderung 2, Spec 2026-10-19 §8.1)", () => {
  it("Maximieren und Zurueckholen mit drei Kacheln montieren und entsorgen nichts; jede wieder sichtbare Kachel refittet genau einmal", () => {
    vi.useFakeTimers();
    try {
      const state = stateWithTiles(["s1", "s2", "s3"]);
      mount(document.createElement("div"), state);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      hoisted.setHiddenSpy.mockClear();

      state.toggleMaximize(state.tiles[0].id);
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);
      expect(hoisted.disposeSpy).not.toHaveBeenCalled();
      // Die beiden anderen sind verborgen und messen nicht; nur die maximierte refittet.
      expect(hoisted.setHiddenSpy).toHaveBeenCalledWith("s2", true);
      expect(hoisted.setHiddenSpy).toHaveBeenCalledWith("s3", true);
      expect(hoisted.setHiddenSpy).not.toHaveBeenCalledWith("s1", true);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy.mock.calls).toEqual([["s1"]]);

      hoisted.fitSpy.mockClear();
      hoisted.setHiddenSpy.mockClear();
      state.toggleMaximize(state.tiles[0].id);
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);
      expect(hoisted.disposeSpy).not.toHaveBeenCalled();
      expect(hoisted.setHiddenSpy).toHaveBeenCalledWith("s2", false);
      expect(hoisted.setHiddenSpy).toHaveBeenCalledWith("s3", false);
      expect(hoisted.setHiddenSpy).not.toHaveBeenCalledWith(expect.anything(), true);
      vi.advanceTimersByTime(300);
      // Jede Kachel aendert ihre Groesse -- die maximierte schrumpft, die beiden
      // anderen kommen zurueck --, und jede refittet genau einmal. Ein
      // `resize_terminal` schickt `terminal.ts` nur bei geaenderten Spalten oder
      // Zeilen.
      expect(hoisted.fitSpy.mock.calls.map(([name]) => name).sort()).toEqual(["s1", "s2", "s3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Wie `hostListed` beim Start: die Kacheln eines spaeter verbundenen Hosts
  // kommen ueber `restoreTiles`, und das beendet ein Maximieren nicht.
  it("eine Kachel, die maximiert dazukommt, wartet ohne Terminal und montiert beim Zurueckholen mit ihrer Endgeometrie (Spec §4.5)", () => {
    vi.useFakeTimers();
    try {
      stubGridSize(1662, 997);
      const state = stateWithTiles(["s1", "s2"]);
      state.upsertHost(makeHost("h2", "vm-2"));
      state.setSessions("h2", ["t1"]);
      const geometry = (tile: HTMLElement) =>
        `${tile.style.left} ${tile.style.top} ${tile.style.width} ${tile.style.height}`;
      const atMount = new Map<string, string>();
      hoisted.mountTerminalSpy.mockImplementation((container: HTMLElement, _runtimeId: string, name: string) => {
        atMount.set(name, geometry(container.closest<HTMLElement>(".tile")!));
      });
      const el = document.createElement("div");
      mount(el, state);
      state.toggleMaximize(state.tiles[0].id);

      state.restoreTiles([{ hostId: "h2", name: "t1" }], () => state.tiles.length);

      expect(state.maximizedTile).toBe(state.tiles[0].id);
      expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s1", "h1/s2", "h2/t1"]);
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();

      state.toggleMaximize(state.tiles[0].id);

      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);
      // 3 Kacheln auf 1662 x 997: die dritte liegt allein in der zweiten Reihe.
      expect(atMount.get("t1")).toBe("0px 503px 1662px 494px");
      expect(atMount.get("t1")).toBe(geometry(tilesByPosition(el)[2]));
      vi.advanceTimersByTime(300);
      // Die beiden anderen refitten, die frisch montierte nicht.
      expect(hoisted.fitSpy.mock.calls.map(([name]) => name).sort()).toEqual(["s1", "s2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Etwa das Aufwachen aus dem Standby (M2), waehrend eine Kachel maximiert ist.
  it("eine verborgene Kachel, deren Kanal mit einer neuen Verbindung geht, wartet ohne Sperre und montiert erst beim Zurueckholen", () => {
    const state = stateWithTiles(["s1", "s2"]);
    mount(document.createElement("div"), state);
    state.toggleMaximize(state.tiles[0].id);

    // Wie main.ts den Host neu verbindet (UX-Spec §5.4): die neue Laufzeit-ID
    // kommt noch waehrend "connecting", beide alten Kanaele gehen.
    state.setHostState("h1", "connecting");
    state.setRuntimeId("h1", "r-h1-new");
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(2);
    // Die sichtbare kann gerade nicht montieren und traegt die Sperre (Satz 4
    // des Sperrvertrags); die verborgene wartet ohne.
    expect(state.hosts[0].sessions.map((session) => session.inputLocked)).toEqual([true, false]);

    state.setHostState("h1", "connected");
    expect(hoisted.mountTerminalSpy.mock.calls.map((call) => call[2])).toEqual(["s1", "s2", "s1"]);
    expect(state.hosts[0].sessions.map((session) => session.inputLocked)).toEqual([false, false]);

    state.toggleMaximize(state.tiles[0].id);
    expect(hoisted.mountTerminalSpy.mock.calls.map((call) => call[2])).toEqual(["s1", "s2", "s1", "s2"]);
    expect(hoisted.mountTerminalSpy.mock.calls[3][1]).toBe("r-h1-new");
  });

  // UX-Spec §6.7: sonst kaeme eine verborgene Kachel mit der alten Schrift
  // zurueck. Messen wird sie erst wieder sichtbar (`setHidden`, terminal.ts).
  it("eine neue Schriftgroesse erreicht auch die verborgenen Kacheln", () => {
    const state = stateWithTiles(["s1", "s2"]);
    const grid = mount(document.createElement("div"), state);
    state.toggleMaximize(state.tiles[0].id);

    grid.applyTerminalFontSize(15);

    expect(hoisted.setFontSizeSpy.mock.calls.sort()).toEqual([
      ["s1", 15],
      ["s2", 15],
    ]);
  });
});

describe("mountGrid: ein einziger entprellter Refit-Pfad (Anforderung 3)", () => {
  it("faehrt JEDE Layoutaenderung ueber denselben entprellten Refit-Pfad", () => {
    // Spec §7.4: zwei Pfade verdoppeln das V12-Risiko (Codex loescht bei
    // jedem Resize den serverseitigen Verlauf) und lassen sich nicht
    // gemeinsam entprellen.
    vi.useFakeTimers();
    try {
      const state = new AppState();
      state.upsertHost(makeHost("h1", "vm-1"));
      state.setSessions("h1", ["s1"]);
      state.openSession("h1", "s1"); // Kachel 0

      const grid = mount(document.createElement("div"), state);

      grid.refit();
      grid.refit();
      grid.refit();
      vi.advanceTimersByTime(300);

      expect(hoisted.fitSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Paket 2.5, Aufgabe 5: der Test darueber heisst "JEDE Layoutaenderung",
  // ruft aber dreimal `grid.refit()` und nie `setLayout`/`toggleMaximize`.
  // Der gesamte Refit-Block in `render()` liess sich ersatzlos loeschen, ohne
  // dass die Suite es merkte -- und mit ihm die Eigenschaft, die der
  // Dateikopf oben als abgedeckt auffuehrt (Designsystem §5.5).
  //
  // `fitSpy` statt eines eigenen Spions auf `refit()`: der Mock oben bildet
  // `terminal.ts`s 300-ms-Entpreller nach, ein Feuern von `fitSpy` beweist
  // also, dass der Weg tatsaechlich durch DENSELBEN entprellten Pfad lief.
  it("refittet beim Hinzufuegen und Schliessen die schon montierten, nie die frisch montierte (Spec §4.5)", () => {
    vi.useFakeTimers();
    try {
      const state = new AppState();
      state.upsertHost(makeHost("h1", "vm-1"));
      state.setSessions("h1", ["s1", "s2", "s3"]);
      state.openSession("h1", "s1");
      mount(document.createElement("div"), state);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();

      state.openSession("h1", "s2");
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).toHaveBeenCalledTimes(1);

      hoisted.fitSpy.mockClear();
      state.openSession("h1", "s3");
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).toHaveBeenCalledTimes(2);

      hoisted.fitSpy.mockClear();
      state.closeTile(state.tiles[0].id);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ein blosser Fokuswechsel refittet nichts", () => {
    vi.useFakeTimers();
    try {
      const state = stateWithTiles(["s1", "s2"]);
      mount(document.createElement("div"), state);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      state.focusTile(state.tiles[0].id);
      state.focusTileAt(1);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refittet nach dem Maximieren", () => {
    vi.useFakeTimers();
    try {
      const state = new AppState();
      state.upsertHost(makeHost("h1", "vm-1"));
      state.setSessions("h1", ["s1"]);
      state.openSession("h1", "s1");
      mount(document.createElement("div"), state);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();

      state.toggleMaximize(state.tiles[0].id);
      vi.advanceTimersByTime(300);

      expect(hoisted.fitSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refittet bei UNVERAENDERTEM Layout, wenn eine Kachel ihre Sperrleiste bekommt", () => {
    // Designsystem §8.3: "Der 32-px-Streifen kostet Terminalzeilen (2 Zeilen
    // bei 15 px) und loest damit einen Refit aus. Das ist zulaessig." Dieser
    // dritte Fall trifft den Sperr-Zweig des Blocks -- ohne ihn bliebe genau
    // ein Drittel weiterhin ersatzlos loeschbar.
    vi.useFakeTimers();
    try {
      const state = new AppState();
      state.upsertHost(makeHost("h1", "vm-1"));
      state.setSessions("h1", ["s1"]);
      state.openSession("h1", "s1");
      mount(document.createElement("div"), state);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();

      // Weder `layout` noch `maximizedTile` aendern sich hier.
      state.lockInput("h1", "s1");
      vi.advanceTimersByTime(300);

      expect(hoisted.fitSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Paket 2.5, Aufgabe 5, rein additiv: `dispose()` hatte gar keinen Test --
// weder fuer das Abmelden noch fuer das Entsorgen der Handles. Ohne das
// Abmelden zeichnete die entsorgte Ansicht bei jeder Zustandsaenderung
// weiter; ohne das Entsorgen bliebe je Kachel ein PTY-Kanal offen (Spec
// §2.5, Grenze acht je Host).
describe("mountGrid: dispose", () => {
  it("meldet sich vom Zustand ab und entsorgt jeden gemounteten Handle", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s1");
    state.openSession("h1", "s2");

    // Der Abonnent selbst wird beobachtet, nicht seine DOM-Wirkung: `render()`
    // kehrt wegen `if (disposed) return;` ohnehin um, eine Beobachtung am DOM
    // pruefte also das ODER beider Mechanismen (siehe denselben Umbau in
    // `sidebar.test.ts`).
    let subscriberRuns = 0;
    const realSubscribe = state.subscribe.bind(state);
    state.subscribe = (fn: () => void) =>
      realSubscribe(() => {
        subscriberRuns++;
        fn();
      });

    const grid = mount(document.createElement("div"), state);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    state.setSessions("h1", ["s1", "s2"]);
    expect(subscriberRuns).toBeGreaterThan(0);
    const runsBeforeDispose = subscriberRuns;

    grid.dispose();

    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(2);
    state.setSessions("h1", ["s1", "s2"]);
    expect(subscriberRuns).toBe(runsBeforeDispose);
  });

  // Spec 2026-10-19 §8.1 (Schritt 3): verborgene Kacheln behalten ihr
  // Terminal; ohne das Entsorgen bliebe ihr PTY-Kanal offen.
  it("entsorgt auch die Terminals verborgener Kacheln", () => {
    const state = stateWithTiles(["s1", "s2", "s3"]);
    const grid = mount(document.createElement("div"), state);
    state.toggleMaximize(state.tiles[0].id);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();

    grid.dispose();

    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(3);
  });
});

// Gemeldet aus dem laufenden Fenster: eine Kachel zeigt "Input locked",
// waehrend der Nutzer darin voellig normal tippt. Auf der VM nachgemessen:
// der tmux-Klient dieser Sitzung war ueber zehn Minuten durchgehend
// angehaengt -- der Kanal lebte also.
//
// Der Weg dorthin brauchte keinen Wettlauf, nur den Umschalter oben rechts:
//   1. Die Sitzung verliert ihre Verbindung. `terminal.ts` setzt
//      `disableStdin` auf DIESER xterm-Instanz, `lockInput` setzt das Flag
//      am Sessioneintrag. Beides stimmt, die Sperrleiste ist ehrlich.
//   2. Der Nutzer schaltete das Layout um. Die Kachel wurde unsichtbar,
//      `reconcile` entsorgte ihren Handle -- ihr `sessionKey` blieb aber
//      stehen (sie war nur versteckt, nicht geraeumt), und damit blieb auch
//      `inputLocked` stehen.
//   3. Zurueckgeschaltet montierte `reconcile` ein FRISCHES Terminal. Eine
//      neue xterm-Instanz hat `disableStdin` nicht gesetzt -- die Eingabe
//      ging wieder durch. Der Sessioneintrag wusste davon nichts.
//
// Ergebnis: ein funktionierendes Terminal unter einem Streifen, der das
// Gegenteil behauptet. Die Regel dahinter: die Eingabesperre gehoert zum
// KANAL, nicht zum Sessioneintrag -- ein frisch montiertes Terminal ist ein
// neuer Kanal, und mit ihm ist die Sperre gegenstandslos.
//
// Seit Spec 2026-10-19 §8.1 (Schritt 3) behaelt eine verborgene Kachel ihr
// Terminal; Maximieren und Zurueckholen montieren nichts mehr. Ein frisches
// Terminal unter stehender Sperre bringt heute vor allem die neue Verbindung
// eines Hosts (UX-Spec §5.4): die alten Kanaele gehen mit der neuen
// Laufzeit-ID, montiert wird erst bei "connected".
describe("mountGrid: die Eingabesperre gehoert zum Kanal", () => {
  it("hebt die Sperre auf, wenn die Kachel ein frisches Terminal bekommt", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s1"); // Kachel 0
    state.openSession("h1", "s2"); // Kachel 1

    const el = document.createElement("div");
    mount(el, state);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);

    state.lockInput("h1", "s2");
    const lockedTile = () => tilesByPosition(el)[1];
    // Vorbedingung: die Sperrleiste ist wirklich da -- an dieser Stelle zu
    // Recht, der Kanal ist tot.
    expect(lockedTile().querySelector<HTMLElement>(".tile-lock")?.hidden).toBe(false);

    // Wie main.ts den Host neu verbindet: Transportverlust, ein Versuch
    // ("connecting"), die neue Laufzeit-ID noch waehrend "connecting". Die
    // alten Handles fallen; montiert werden kann noch nicht, und die Kacheln
    // tragen die Sperre weiter (Satz 4 des Sperrvertrags).
    state.setHostState("h1", "failed", "transport lost");
    state.setHostState("h1", "connecting");
    state.setRuntimeId("h1", "r-h1-new");
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(2);
    expect(state.hosts[0].sessions[1].inputLocked).toBe(true);

    // Verbunden: ein FRISCHES Terminal fuer dieselbe Session.
    state.setHostState("h1", "connected");
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(4);

    // Und damit ist die Sperre gegenstandslos: die neue xterm-Instanz nimmt
    // Eingaben an (`disableStdin` ist nur auf der alten gesetzt worden).
    // Bleibt der Streifen stehen, behauptet die Kachel das Gegenteil dessen,
    // was ihr Terminal tut.
    expect(state.hosts[0].sessions[1].inputLocked).toBe(false);
    expect(lockedTile().querySelector<HTMLElement>(".tile-lock")?.hidden).toBe(true);
  });

  // Spec 2026-10-19 §4.5: das frische Terminal misst mit seiner Endgeometrie.
  // Mit sichtbarer Sperrleiste maesse es 32 px zu niedrig, und deren
  // Verschwinden im verschachtelten Durchgang kostete ein zweites
  // `resize_terminal` -- "Reconnect" loest die Sperre schon vor dem Montieren.
  it("misst das frische Terminal einer gesperrten Kachel nach dem Neuverbinden ohne Sperrleiste", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);
    state.lockInput("h1", "s1");
    const strip = () => tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-lock")!;
    expect(strip().hidden).toBe(false);

    const stripAtMount: boolean[] = [];
    hoisted.mountTerminalSpy.mockImplementation((container: HTMLElement) => {
      stripAtMount.push(container.closest<HTMLElement>(".tile")!.querySelector<HTMLElement>(".tile-lock")!.hidden);
    });
    state.setHostState("h1", "failed", "transport lost");
    state.setHostState("h1", "connecting");
    state.setRuntimeId("h1", "r-h1-new");
    state.setHostState("h1", "connected");

    expect(stripAtMount).toEqual([true]);
    expect(state.hosts[0].sessions[0].inputLocked).toBe(false);
    expect(strip().hidden).toBe(true);
  });

  // Der Fall, der beide vorigen Entwuerfe gekippt haette: bei `failed` bleibt
  // die Laufzeit-ID ABSICHTLICH stehen (Zusage aus Paket 1, die Kachel soll
  // mit ihrer Sperrleiste offen bleiben). Eine Montagebedingung, die nur die
  // ID prueft, montiert dort gegen eine TOTE Verbindung -- und die frische
  // xterm-Instanz nimmt dann jeden Tastendruck an, der als scheiterndes
  // `send_input` zurueckkommt. Erreichbar ist das mit einer Kachel ohne
  // Terminal: einer verborgenen, deren Kanal mit der vorigen Verbindung ging
  // (Spec 2026-10-19 §8.1).
  it("montiert auf einem fehlgeschlagenen Host gar nicht erst und laesst die Sperre stehen", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s1");
    state.openSession("h1", "s2");

    const el = document.createElement("div");
    mount(el, state);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);

    // s1 maximiert, s2 verborgen. Eine neue Verbindung nimmt beiden den Kanal;
    // s1 montiert frisch, die verborgene s2 wartet ohne Terminal.
    state.toggleMaximize(state.tiles[0].id);
    state.setRuntimeId("h1", "r-h1-new");
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(2);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);

    state.lockInput("h1", "s2");
    // Die Verbindung ist gescheitert -- die Laufzeit-ID steht weiter da.
    state.setHostState("h1", "failed", "boom");
    expect(state.hosts[0].runtimeId).toBe("r-h1-new");

    const lockedTile = () => tilesByPosition(el)[1];
    const mountsBefore = hoisted.mountTerminalSpy.mock.calls.length;

    // Zurueckholen: s2 ist wieder zu sehen, hat kein Terminal, und ihr Host ist tot.
    state.toggleMaximize(state.tiles[0].id);

    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(mountsBefore);
    expect(state.hosts[0].sessions[1].inputLocked).toBe(true);
    expect(lockedTile().querySelector<HTMLElement>(".tile-lock")?.hidden).toBe(false);
  });

  // Spec 2026-10-19 §8.1 (Schritt 3): die verborgene Kachel behaelt ihr
  // Terminal und damit ihren toten Kanal. Die Sperre bleibt, der Weg zurueck
  // ist "Reconnect" -- frueher hob das Zurueckholen sie mit einem frisch
  // montierten Terminal nebenbei auf.
  it("Maximieren und Zurueckholen heben eine Sperre nicht auf: dasselbe Terminal, derselbe tote Kanal", () => {
    const state = stateWithTiles(["s1", "s2"]);
    const el = document.createElement("div");
    mount(el, state);
    state.lockInput("h1", "s2");
    const lockedTile = () => tilesByPosition(el)[1];

    state.toggleMaximize(state.tiles[0].id);
    state.toggleMaximize(state.tiles[0].id);

    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
    expect(state.hosts[0].sessions[1].inputLocked).toBe(true);
    expect(hoisted.inputLockedByMount[1]).toBe(true);
    expect(lockedTile().querySelector<HTMLElement>(".tile-lock")?.hidden).toBe(false);
    expect(lockedTile().querySelector<HTMLButtonElement>(".tile-lock-reconnect")?.hidden).toBe(false);
  });

  it.each(["failed", "disconnected"] as const)("delegiert Reconnect bei %s an den Host und behaelt die Kachel", (hostState) => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");

    const el = document.createElement("div");
    const onReconnectHost = vi.fn();
    mount(el, state, { onReconnectHost });

    state.lockInput("h1", "s1");
    state.setHostState("h1", hostState, "boom");
    const tile = () => tilesByPosition(el)[0];
    const strip = () => tile().querySelector<HTMLElement>(".tile-lock");
    expect(strip()?.hidden).toBe(false);

    tile().querySelector<HTMLButtonElement>(".tile-lock-reconnect")?.click();

    expect(onReconnectHost).toHaveBeenCalledExactlyOnceWith("h1");
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
    expect(state.tiles[0].sessionKey).toBe("h1/s1");
    expect(state.hosts[0].sessions[0].inputLocked).toBe(true);
    expect(strip()?.hidden).toBe(false);
    expect(tile().querySelector<HTMLButtonElement>(".tile-lock-reconnect")).not.toBeNull();
  });

  it("startet waehrend connecting keinen zweiten Reconnect und entsorgt die Ausgabe nicht", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    const onReconnectHost = vi.fn();
    mount(el, state, { onReconnectHost });
    state.lockInput("h1", "s1");
    state.setHostState("h1", "connecting");

    el.querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.click();

    expect(onReconnectHost).not.toHaveBeenCalled();
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
    expect(state.hosts[0].sessions[0].inputLocked).toBe(true);
  });

  // Die Gegenrichtung: die Sperre faellt beim frischen KANAL, nicht bei jedem
  // Neuzeichnen. Ein pauschales Loeschen im Render saehe in Test 1 genauso
  // gruen aus und naehme dem Nutzer die Sperrleiste bei der naechsten
  // eintreffenden Sessionliste weg -- also mitten im gesperrten Zustand.
  it("behaelt die Sperre bei einem blossen Neuzeichnen ohne neue Montage", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");

    const el = document.createElement("div");
    mount(el, state);
    const mountsBefore = hoisted.mountTerminalSpy.mock.calls.length;

    state.lockInput("h1", "s1");
    // Ein Neuzeichnen ohne jede Kachelaenderung -- genau das, was eine im
    // Hintergrund eintreffende Sessionliste ausloest.
    state.setSessions("h1", ["s1"]);
    state.focusTile(state.tiles[0].id);

    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(mountsBefore);
    expect(state.hosts[0].sessions[0].inputLocked).toBe(true);
    expect(tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-lock")?.hidden).toBe(false);
  });

  // Der Sperrabgleich steht IN einem Neuzeichnen und benachrichtigt --
  // `render` faehrt also einen verschachtelten Durchgang. Dass der nichts
  // mehr zu tun findet, ist ein Beweis ueber den Code von HEUTE (die Sperren
  // stimmen danach, also sammelt der zweite Durchgang nichts). Die Wache in
  // `render` gilt auch fuer den naechsten, der die Montagebedingung anfasst.
  //
  // Diese Vorrichtung faehrt den schaedlichen Zustand wirklich, statt ihn
  // vorauszusetzen: der Abgleich benachrichtigt hier, OHNE etwas zu aendern
  // -- genau die Konstellation, in der der Beweis nicht mehr traegt. Ohne
  // die Wache reisst der Aufrufstapel.
  it("verhakt sich nicht, wenn der Sperrabgleich benachrichtigt, ohne etwas zu aendern", () => {
    class NotifyingState extends AppState {
      applyCalls = 0;
      override applyInputLocks(): void {
        this.applyCalls++;
        // Benachrichtigt bedingungslos (`upsertHost` tut das), aendert an den
        // Sperren aber nichts -- der naechste `reconcile` sammelt also
        // denselben Schluessel erneut ein.
        this.upsertHost(this.hosts[0]);
      }
    }

    const state = new NotifyingState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.setHostState("h1", "failed", "boom");

    const el = document.createElement("div");
    mount(el, state);
    // Belegt die Kachel mit einer Session, die nicht montiert werden kann --
    // damit sammelt `reconcile` bei JEDEM Durchgang eine zu setzende Sperre.
    state.openSession("h1", "s1");

    expect(state.applyCalls).toBe(1);
  });
});

describe("mountGrid: Maximieren und Kachelzuordnung", () => {
  it("Maximieren aendert die Kachelzuordnung nicht", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s1");
    state.openSession("h1", "s2");

    mount(document.createElement("div"), state);

    const vorher = state.tiles.map((t) => t.sessionKey);
    state.toggleMaximize(state.tiles[1].id);
    expect(state.tiles.map((t) => t.sessionKey)).toEqual(vorher);
  });
});

describe("mountGrid: Lage und Nummer der Kacheln (Spec 2026-10-19 §4.1-§4.3)", () => {
  it("legt zwei Kacheln nebeneinander, mit 8 px Luecke, absolut", () => {
    stubGridSize(1662, 997);
    const state = stateWithTiles(["s1", "s2"]);
    const el = document.createElement("div");
    mount(el, state);
    const rects = tilesByPosition(el).map(({ style }) => [style.left, style.top, style.width, style.height]);
    expect(rects).toEqual([
      ["0px", "0px", "827px", "997px"],
      ["835px", "0px", "827px", "997px"],
    ]);
  });

  it("eine neue Kachel montiert mit ihrer Endgeometrie (Review-Befund M-1)", () => {
    stubGridSize(1662, 997);
    const state = stateWithTiles(["s1"]);
    const atMount: string[] = [];
    hoisted.mountTerminalSpy.mockImplementation((container: HTMLElement) => {
      const tile = container.closest<HTMLElement>(".tile")!;
      atMount.push(`${tile.style.left} ${tile.style.width} ${tile.style.height}`);
    });
    mount(document.createElement("div"), state);
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s2");
    expect(atMount).toEqual(["0px 1662px 997px", "835px 827px 997px"]);
  });

  // Derselbe Satz fuer den Start: die gespeicherten Kacheln eines Hosts kommen
  // in einer Benachrichtigung (`hostListed`, `restoreTiles`). Kaeme jede
  // einzeln, oeffnete jede bis auf die letzte in einer fremden Groesse und
  // braeuchte danach ein `resize_terminal` (Spec §1 Nr. 6). Ab Schritt 3 so
  // viele, wie ein Host haben darf (Spec §8.1, Review Focus 1).
  it("die wiederhergestellten Kacheln eines Hosts montieren alle mit ihrer Endgeometrie, keine wird refittet (Spec §4.5)", () => {
    vi.useFakeTimers();
    let restore: WorkspaceSync | null = null;
    try {
      stubGridSize(1662, 997);
      const names = Array.from({ length: MAX_TILES_PER_HOST }, (_, i) => `s${i + 1}`);
      const state = new AppState();
      state.upsertHost(makeHost("h1", "vm-1"));
      state.setSessions("h1", names);
      const geometry = (tile: HTMLElement) =>
        `${tile.style.left} ${tile.style.top} ${tile.style.width} ${tile.style.height}`;
      const atMount = new Map<string, string>();
      hoisted.mountTerminalSpy.mockImplementation((container: HTMLElement, _runtimeId: string, name: string) => {
        atMount.set(name, geometry(container.closest<HTMLElement>(".tile")!));
      });
      const el = document.createElement("div");
      mount(el, state);

      restore = createWorkspaceSync({
        state,
        write: () => Promise.resolve(),
        sidebarCollapsed: () => false,
        setSidebarCollapsed: () => {},
      });
      // Der Host ist schon verbunden und gelistet: `start` legt die Kacheln an.
      restore.start(
        {
          layout: 4,
          tiles_version: 2,
          sidebar_collapsed: false,
          expanded: [],
          connected: [],
          tiles: names.map((session, slot) => ({ slot, host_id: "h1", session })),
          dirs: {},
        },
        true,
      );

      const final = new Map(
        tilesByPosition(el).map((tile) => [tile.querySelector(".tile-title")!.textContent!, geometry(tile)]),
      );
      expect([...final.keys()]).toEqual(names);
      expect(atMount).toEqual(final);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
    } finally {
      restore?.dispose();
      vi.useRealTimers();
    }
  });

  it("Abzeichen und data-position folgen der Position, wenn davor eine Kachel schliesst", () => {
    const state = stateWithTiles(["s1", "s2", "s3"]);
    const el = document.createElement("div");
    mount(el, state);
    state.closeTile(state.tiles[0].id);
    const tiles = tilesByPosition(el);
    expect(tiles.map((tile) => tile.querySelector(".tile-title")?.textContent)).toEqual(["s2", "s3"]);
    expect(tiles.map((tile) => tile.querySelector(".badge")?.textContent)).toEqual(["1", "2"]);
    expect(tiles.map((tile) => tile.dataset.tileId)).toEqual(state.tiles.map((tile) => String(tile.id)));
  });

  it("schliesst die maximierte Kachel: die uebrigen erscheinen wieder (Review Focus 1)", () => {
    const state = stateWithTiles(["s1", "s2", "s3"]);
    const el = document.createElement("div");
    mount(el, state);
    state.toggleMaximize(state.tiles[1].id);
    expect(tilesByPosition(el).map((tile) => tile.style.display)).toEqual(["none", "", "none"]);
    state.closeTile(state.tiles[1].id);
    expect(tilesByPosition(el).map((tile) => tile.style.display)).toEqual(["", ""]);
    expect(el.querySelector<HTMLElement>(".grid-empty")?.hidden).toBe(true);
    // Sie behielten ihr Terminal (Spec 2026-10-19 §8.1): nur die geschlossene
    // Kachel entsorgt ihres, montiert wird nichts.
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("ein Klick auf den Kachelkopf fokussiert; Kopfknoepfe und rechte Taste nicht (Spec §4.7)", () => {
    const state = stateWithTiles(["s1", "s2"]);
    const el = document.createElement("div");
    mount(el, state);
    const [first, second] = tilesByPosition(el);
    const press = (target: Element, button = 0) =>
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button }));
    press(first.querySelector(".tile-title")!);
    expect(state.focusedTile).toBe(state.tiles[0].id);
    press(second.querySelector(".tile-title")!, 2);
    press(second.querySelector(".tile-btn")!);
    press(second.querySelector(".tile-terminal")!);
    expect(state.focusedTile).toBe(state.tiles[0].id);
  });

  it("relayout folgt der Seitenleiste beim Ziehen, ohne ein Terminal zu vermessen (Spec §4.5)", () => {
    vi.useFakeTimers();
    try {
      stubGridSize(1662, 997);
      const state = stateWithTiles(["s1", "s2"]);
      const el = document.createElement("div");
      const grid = mount(el, state);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      // Die Seitenleiste ist 200 px breiter geworden.
      stubGridSize(1462, 997);
      grid.relayout();
      vi.advanceTimersByTime(300);
      expect(tilesByPosition(el).map(({ style }) => [style.left, style.width])).toEqual([
        ["0px", "727px"],
        ["735px", "727px"],
      ]);
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mountGrid: Spalt zwischen Kacheln (Spec 2026-10-19 §4.4)", () => {
  beforeEach(() => {
    stubGridSize(1662, 997);
    // jsdom kennt keine Zeigererfassung (wie in sidebar-resize.test.ts).
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  });

  function pointer(target: Element, type: string, clientX: number, clientY = 0): void {
    const buttons = type === "pointerdown" || type === "pointermove" ? 1 : 0;
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, pointerId: 1, clientX, clientY }),
    );
  }

  function widths(el: HTMLElement): string[] {
    return tilesByPosition(el).map((tile) => tile.style.width);
  }

  function visibleSplits(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>(".tile-split")).filter((split) => !split.hidden);
  }

  it("legt zwischen zwei Kacheln einen Spalt in die Luecke", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [split] = visibleSplits(el);
    expect([split.dataset.kind, split.style.left, split.style.width, split.style.height]).toEqual([
      "col",
      "827px",
      "8px",
      "997px",
    ]);
  });

  it("verschiebt die Grenze mit dem Zeiger und vermisst erst beim Loslassen, einmal je Kachel", () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement("div");
      mount(el, stateWithTiles(["s1", "s2"]));
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      const [split] = visibleSplits(el);
      pointer(split, "pointerdown", 831);
      pointer(split, "pointermove", 881);
      pointer(split, "pointermove", 931);
      expect(widths(el)).toEqual(["927px", "727px"]);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
      pointer(split, "pointerup", 931);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("haelt das Mindestmass von 200 px", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [split] = visibleSplits(el);
    pointer(split, "pointerdown", 831);
    pointer(split, "pointermove", -2000);
    pointer(split, "pointerup", -2000);
    expect(widths(el)).toEqual(["200px", "1454px"]);
  });

  it("nimmt beim Loslassen die Lage des Loslassens (wie der Griff der Seitenleiste)", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [split] = visibleSplits(el);
    pointer(split, "pointerdown", 831);
    pointer(split, "pointermove", 881);
    expect(widths(el)).toEqual(["877px", "777px"]);
    pointer(split, "pointerup", 931);
    expect(widths(el)).toEqual(["927px", "727px"]);
  });

  it("Esc bricht den Zug ab und stellt die Anteile wieder her", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [split] = visibleSplits(el);
    pointer(split, "pointerdown", 831);
    pointer(split, "pointermove", 931);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(widths(el)).toEqual(["827px", "827px"]);
  });

  it("ein Doppelklick auf den Spalt setzt alle wieder gleich", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [split] = visibleSplits(el);
    pointer(split, "pointerdown", 831);
    pointer(split, "pointermove", 931);
    pointer(split, "pointerup", 931);
    split.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(widths(el)).toEqual(["827px", "827px"]);
  });

  it("eine neue Kachelzahl setzt die Anteile zurueck", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const [split] = visibleSplits(el);
    pointer(split, "pointerdown", 831);
    pointer(split, "pointermove", 931);
    pointer(split, "pointerup", 931);
    state.setSessions("h1", ["s1", "s2", "s3"]);
    state.openSession("h1", "s3");
    expect(widths(el)).toEqual(["827px", "827px", "1662px"]);
  });

  it("zwischen zwei Reihen aendert der Spalt die Hoehen", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2", "s3"]));
    const row = visibleSplits(el).find((split) => split.dataset.kind === "row")!;
    pointer(row, "pointerdown", 100, 499);
    pointer(row, "pointermove", 100, 599);
    pointer(row, "pointerup", 100, 599);
    const [top, , bottom] = tilesByPosition(el).map((tile) => Number.parseInt(tile.style.height, 10));
    expect(top + bottom).toBe(989);
    expect(Math.abs(top - 595)).toBeLessThanOrEqual(1);
  });

  it("zwischen zwei Reihen haelt der Spalt das Mindestmass von 120 px", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2", "s3"]));
    const row = visibleSplits(el).find((split) => split.dataset.kind === "row")!;
    pointer(row, "pointerdown", 100, 499);
    pointer(row, "pointermove", 100, -2000);
    pointer(row, "pointerup", 100, -2000);
    const [top, , bottom] = tilesByPosition(el).map((tile) => Number.parseInt(tile.style.height, 10));
    expect([top, bottom]).toEqual([120, 869]);
  });

  it("die Linie des Spalts steht nur waehrend des Zugs, auch nach Esc", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [split] = visibleSplits(el);
    const dragging = () => split.classList.contains("tile-split--dragging");
    pointer(split, "pointerdown", 831);
    expect(dragging()).toBe(false);
    pointer(split, "pointermove", 881);
    expect(dragging()).toBe(true);
    pointer(split, "pointerup", 881);
    expect(dragging()).toBe(false);
    pointer(split, "pointerdown", 831);
    pointer(split, "pointermove", 881);
    expect(dragging()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dragging()).toBe(false);
  });

  it("zieht nur die linke Maustaste, und ihr Druck markiert keinen Text", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [split] = visibleSplits(el);
    const press = (button: number, buttons: number): PointerEvent => {
      const event = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button,
        buttons,
        pointerId: 1,
        clientX: 831,
      });
      split.dispatchEvent(event);
      return event;
    };
    expect(press(2, 2).defaultPrevented).toBe(false);
    pointer(split, "pointermove", 931);
    expect(widths(el)).toEqual(["827px", "827px"]);
    expect(press(0, 1).defaultPrevented).toBe(true);
    pointer(split, "pointermove", 931);
    expect(widths(el)).toEqual(["927px", "727px"]);
    pointer(split, "pointerup", 931);
  });

  it("ein Doppelklick auf den Spalt vermisst jede Kachel einmal, ein weiterer nichts mehr (Spec §4.5)", () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement("div");
      mount(el, stateWithTiles(["s1", "s2"]));
      const [split] = visibleSplits(el);
      pointer(split, "pointerdown", 831);
      pointer(split, "pointermove", 931);
      pointer(split, "pointerup", 931);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      split.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).toHaveBeenCalledTimes(2);
      hoisted.fitSpy.mockClear();
      split.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("eine neue Kachelzahl mitten im Zug setzt alle gleich; Bewegung und Loslassen aendern daran nichts", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3", "s4"]);
    mount(el, state);
    const row = visibleSplits(el).find((split) => split.dataset.kind === "row")!;
    pointer(row, "pointerdown", 100, 499);
    pointer(row, "pointermove", 100, 599);
    // Eine Session verschwindet vom Host: aus vier werden drei Kacheln.
    state.closeTile(state.tiles[3].id);
    pointer(row, "pointermove", 100, 649);
    pointer(row, "pointerup", 100, 649);
    expect(tilesByPosition(el).map((tile) => tile.style.height)).toEqual(["495px", "495px", "494px"]);
    expect(row.classList.contains("tile-split--dragging")).toBe(false);
  });

  it("Esc nach einer neuen Kachelzahl mitten im Zug stellt keine alten Anteile wieder her", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3", "s4"]);
    mount(el, state);
    const row = visibleSplits(el).find((split) => split.dataset.kind === "row")!;
    pointer(row, "pointerdown", 100, 499);
    pointer(row, "pointermove", 100, 599);
    pointer(row, "pointerup", 100, 599);
    pointer(row, "pointerdown", 100, 599);
    pointer(row, "pointermove", 100, 649);
    state.closeTile(state.tiles[3].id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(tilesByPosition(el).map((tile) => tile.style.height)).toEqual(["495px", "495px", "494px"]);
  });

  it("maximiert gibt es keinen Spalt", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    state.toggleMaximize(state.tiles[0].id);
    expect(visibleSplits(el)).toEqual([]);
  });
});

describe("mountGrid: Tauschen und Verschieben (Spec 2026-10-19 §5.4)", () => {
  beforeEach(() => {
    stubGridSize(1662, 997);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  });

  function pointer(target: Element, type: string, clientX: number, clientY: number): void {
    const buttons = type === "pointerdown" || type === "pointermove" ? 1 : 0;
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, pointerId: 1, clientX, clientY }),
    );
  }

  function liveText(el: HTMLElement): string | null | undefined {
    return el.querySelector(".ab-visually-hidden[aria-live]")?.textContent;
  }

  it("ein Zug am Kopf tauscht zwei Kacheln, ohne ein Terminal neu zu montieren", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3"]);
    mount(el, state);
    const [first, second] = tilesByPosition(el);
    const head = first.querySelector<HTMLElement>(".tile-head")!;

    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 110, 10);
    expect(first.classList.contains("tile--drag-source")).toBe(true);
    pointer(head, "pointermove", 1000, 100);
    expect(second.classList.contains("tile--drop-target")).toBe(true);
    pointer(head, "pointerup", 1000, 100);

    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s2", "h1/s1", "h1/s3"]);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
    expect(first.classList.contains("tile--drag-source")).toBe(false);
    expect(second.classList.contains("tile--drop-target")).toBe(false);
    // Die verschobene Kachel leuchtet auf (Spec 2026-10-19 §6.2).
    expect(first.classList.contains("tile--flash")).toBe(true);
    expect(liveText(el)).toBe("s1 moved to position 2");
    // Die DOM-Reihenfolge folgt der Entstehung, die Anzeige der Position.
    const dom = Array.from(el.querySelectorAll<HTMLElement>(".tile"));
    expect(dom.map((tile) => tile.querySelector(".tile-title")?.textContent)).toEqual(["s1", "s2", "s3"]);
    expect(tilesByPosition(el).map((tile) => tile.querySelector(".tile-title")?.textContent)).toEqual(["s2", "s1", "s3"]);
  });

  it("unter 4 px bleibt es ein Klick, Esc und pointercancel brechen ab", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const head = tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-head")!;
    const before = state.tiles.map((tile) => tile.id);

    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 102, 11);
    pointer(head, "pointerup", 1000, 100);
    expect(state.tiles.map((tile) => tile.id)).toEqual(before);

    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 1000, 100);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    pointer(head, "pointerup", 1000, 100);
    expect(state.tiles.map((tile) => tile.id)).toEqual(before);

    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 1000, 100);
    pointer(head, "pointercancel", 1000, 100);
    expect(state.tiles.map((tile) => tile.id)).toEqual(before);
    expect(el.querySelector(".tile--drag-source, .tile--drop-target")).toBeNull();
  });

  it("ein Zug an einem Kopfknopf tauscht nichts", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const button = tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-btn")!;
    const before = state.tiles.map((tile) => tile.id);
    pointer(button, "pointerdown", 100, 10);
    pointer(button, "pointermove", 1000, 100);
    pointer(button, "pointerup", 1000, 100);
    expect(state.tiles.map((tile) => tile.id)).toEqual(before);
  });

  it("das Ziel ist die Kachel unter dem Loslassen, nicht unter der letzten Bewegung", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3"]);
    mount(el, state);
    const head = tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-head")!;
    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 1000, 100);
    // Losgelassen ueber der breiten Kachel unten (3 Kacheln: 2 + 1).
    pointer(head, "pointerup", 100, 700);
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s3", "h1/s2", "h1/s1"]);
    expect(el.querySelector(".tile--drag-source, .tile--drop-target")).toBeNull();
  });

  it("ein Klick auf den Kopf legt den Tastaturfokus in diese Kachel (Spec §4.7)", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    hoisted.focusSpy.mockClear();
    const head = tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-head")!;
    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointerup", 100, 10);
    expect(hoisted.focusSpy).toHaveBeenCalledExactlyOnceWith("s1");
  });

  // Der Druck setzt den Fokus in `state`, bevor das Terminal ihn bekommt: dessen
  // `focusin` sieht keinen Wechsel und bliebe stumm. Darum sagt der Druck selbst
  // an -- einmal, und ohne Aufleuchten, das gehoert der Wahl (§6.2).
  it("ein Druck auf den Kopf einer nicht fokussierten Kachel sagt Nummer und Session einmal an, ohne Aufleuchten; auf die fokussierte sagt er nichts an (Spec §4.3)", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const state = stateWithTiles(["s1", "s2"]);
      mount(el, state);
      const [first] = tilesByPosition(el);
      const head = first.querySelector<HTMLElement>(".tile-head")!;
      const live = el.querySelector<HTMLElement>(".ab-visually-hidden[aria-live]")!;
      // Jedes Setzen des Textes ergibt einen Eintrag, auch ein gleicher: so zeigt
      // sich eine doppelte Ansage, die der Text allein nicht verriete.
      const writes = new MutationObserver(() => {});
      writes.observe(live, { childList: true });
      try {
        live.textContent = "";
        writes.takeRecords();

        // s2 hat den Fokus; der Druck auf den Kopf von s1 holt ihn nach s1.
        pointer(head, "pointerdown", 100, 10);
        pointer(head, "pointerup", 100, 10);
        expect(state.focusedTile).toBe(state.tiles[0].id);
        expect(first.contains(document.activeElement)).toBe(true);
        expect(live.textContent).toBe("Terminal 1: s1");
        expect(writes.takeRecords().filter((record) => record.addedNodes.length > 0)).toHaveLength(1);
        expect(el.querySelector(".tile--flash")).toBeNull();

        // Ein weiterer Druck auf die nun fokussierte Kachel sagt nichts an.
        live.textContent = "";
        writes.takeRecords();
        pointer(head, "pointerdown", 100, 10);
        pointer(head, "pointerup", 100, 10);
        expect(live.textContent).toBe("");
        expect(writes.takeRecords()).toHaveLength(0);
      } finally {
        writes.disconnect();
      }
    } finally {
      el.remove();
    }
  });

  it("der Druck auf den Kopf haelt den Browserfokus an (preventDefault), der auf einen Kopfknopf nicht", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const tile = tilesByPosition(el)[0];
    const press = (target: Element): PointerEvent => {
      const event = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 1,
        clientX: 100,
        clientY: 10,
      });
      target.dispatchEvent(event);
      return event;
    };
    const head = tile.querySelector<HTMLElement>(".tile-head")!;
    expect(press(head).defaultPrevented).toBe(true);
    pointer(head, "pointerup", 100, 10);
    expect(press(tile.querySelector(".tile-btn")!).defaultPrevented).toBe(false);
  });

  // Hat die gedrueckte Kachel kein Terminal (Host ausgefallen, getrennt oder noch
  // beim Verbinden), liesse `preventDefault` den Browserfokus in der vorher
  // fokussierten Kachel: Eingabe und die Terminal-Akkorde (Strg+Umschalt+W/F/C)
  // gingen weiter dorthin, waehrend die gedrueckte Kachel fokussiert aussieht.
  it("ein Druck auf den Kopf einer Kachel ohne Terminal nimmt dem vorher fokussierten Terminal den Tastaturfokus", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.upsertHost({ ...makeHost("h2", "vm-2"), state: "failed", error: "gone" });
    state.setSessions("h1", ["s1"]);
    state.setSessions("h2", ["s2"]);
    state.openSession("h1", "s1");
    state.openSession("h2", "s2");
    const el = document.createElement("div");
    // jsdom fokussiert nur Elemente im Dokument.
    document.body.appendChild(el);
    try {
      mount(el, state);
      // Nur s1 hat ein Terminal: der Host von s2 ist ausgefallen.
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
      const [first, second] = tilesByPosition(el);
      // Wo xterm den Tastaturfokus haelt: sein Hilfstextfeld im Terminal der ersten Kachel.
      const xtermInput = document.createElement("textarea");
      first.querySelector(".tile-terminal")!.appendChild(xtermInput);
      xtermInput.focus();
      state.focusTile(state.tiles[0].id);
      expect(document.activeElement).toBe(xtermInput);
      hoisted.focusSpy.mockClear();

      const head = second.querySelector<HTMLElement>(".tile-head")!;
      pointer(head, "pointerdown", 900, 10);
      pointer(head, "pointerup", 900, 10);

      expect(state.focusedTile).toBe(state.tiles[1].id);
      expect(document.activeElement).toBe(document.body);
      expect(hoisted.focusSpy).not.toHaveBeenCalled();
    } finally {
      el.remove();
    }
  });

  // Auch ohne Terminal wechselt der Fokus in `state` (der Rahmen zeigt es), und
  // es gibt kein `focusin`, das ihn ansagen koennte (Spec §4.3).
  it("ein Druck auf den Kopf einer Kachel ohne Terminal sagt Nummer und Session an, ohne Aufleuchten", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.upsertHost({ ...makeHost("h2", "vm-2"), state: "failed", error: "gone" });
    state.setSessions("h1", ["s1"]);
    state.setSessions("h2", ["s2"]);
    state.openSession("h1", "s1");
    state.openSession("h2", "s2");
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      mount(el, state);
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
      const [first, second] = tilesByPosition(el);
      const xtermInput = document.createElement("textarea");
      first.querySelector(".tile-terminal")!.appendChild(xtermInput);
      xtermInput.focus();
      state.focusTile(state.tiles[0].id);
      const live = el.querySelector<HTMLElement>(".ab-visually-hidden[aria-live]")!;
      live.textContent = "";

      const head = second.querySelector<HTMLElement>(".tile-head")!;
      pointer(head, "pointerdown", 900, 10);
      pointer(head, "pointerup", 900, 10);

      expect(state.focusedTile).toBe(state.tiles[1].id);
      expect(document.activeElement).toBe(document.body);
      expect(live.textContent).toBe("Terminal 2: s2");
      expect(el.querySelector(".tile--flash")).toBeNull();

      // Ein weiterer Druck auf die nun fokussierte Kachel sagt nichts an.
      live.textContent = "";
      pointer(head, "pointerdown", 900, 10);
      pointer(head, "pointerup", 900, 10);
      expect(live.textContent).toBe("");
    } finally {
      el.remove();
    }
  });

  it("mit Terminal in der gedrueckten Kachel entscheidet dessen focus() ueber den Tastaturfokus; das Raster nimmt ihn nicht vorher weg", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    document.body.appendChild(el);
    try {
      mount(el, state);
      const [first, second] = tilesByPosition(el);
      const xtermInput = document.createElement("textarea");
      second.querySelector(".tile-terminal")!.appendChild(xtermInput);
      xtermInput.focus();
      state.focusTile(state.tiles[1].id);
      hoisted.focusSpy.mockClear();

      const head = first.querySelector<HTMLElement>(".tile-head")!;
      pointer(head, "pointerdown", 100, 10);
      pointer(head, "pointerup", 100, 10);

      // Das gemockte `focus()` bewegt den DOM-Fokus nicht: bliebe er nicht, hat das Raster ihn weggenommen.
      expect(hoisted.focusSpy).toHaveBeenCalledExactlyOnceWith("s1");
      expect(document.activeElement).toBe(xtermInput);
      expect(state.focusedTile).toBe(state.tiles[0].id);
    } finally {
      el.remove();
    }
  });

  it("maximiert beginnt ein Zug am Kopf keinen Tausch: es ist nur eine Kachel zu sehen", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    state.toggleMaximize(state.tiles[0].id);
    const first = tilesByPosition(el)[0];
    const head = first.querySelector<HTMLElement>(".tile-head")!;
    const before = state.tiles.map((tile) => tile.id);
    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 1000, 100);
    expect(first.classList.contains("tile--drag-source")).toBe(false);
    pointer(head, "pointerup", 1000, 100);
    expect(state.tiles.map((tile) => tile.id)).toEqual(before);
  });

  it("das Ziel wechselt mit dem Zeiger; ueber der eigenen Kachel gibt es keins, und ein Loslassen dort tauscht nichts", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3"]);
    mount(el, state);
    const [first, second, third] = tilesByPosition(el);
    const head = first.querySelector<HTMLElement>(".tile-head")!;
    const before = state.tiles.map((tile) => tile.id);
    const targets = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(".tile--drop-target"));

    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 110, 10);
    expect(targets()).toEqual([]);
    pointer(head, "pointermove", 1000, 100);
    expect(targets()).toEqual([second]);
    pointer(head, "pointermove", 100, 700);
    expect(targets()).toEqual([third]);
    pointer(head, "pointermove", 110, 10);
    expect(targets()).toEqual([]);
    pointer(head, "pointerup", 110, 10);
    expect(state.tiles.map((tile) => tile.id)).toEqual(before);
    expect(first.classList.contains("tile--drag-source")).toBe(false);
    // Nichts getauscht, also sagt die Live-Region nichts vom Verschieben, nur
    // den Fokuswechsel des Drucks (§4.3).
    expect(liveText(el)).toBe("Terminal 1: s1");
  });

  it("Loslassen im Spalt zwischen Kacheln tauscht nichts, auf dem ersten Pixel einer Kachel schon", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3"]);
    mount(el, state);
    // 3 Kacheln auf 1662 x 997: s1 {0, 0, 827, 495}, s2 {835, 0, 827, 495}, s3 {0, 503, 1662, 494}.
    const head = tilesByPosition(el)[2].querySelector<HTMLElement>(".tile-head")!;
    const dragTo = (x: number, y: number): void => {
      pointer(head, "pointerdown", 100, 510);
      pointer(head, "pointermove", x, y);
      pointer(head, "pointerup", x, y);
    };
    const before = state.tiles.map((tile) => tile.sessionKey);

    dragTo(827, 100); // Spalt zwischen s1 und s2
    dragTo(100, 495); // Spalt zwischen den Reihen
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(before);

    dragTo(835, 100); // erster Pixel von s2
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s1", "h1/s3", "h1/s2"]);
  });

  it("das Ziel wird vom Ursprung des Rasters aus gemessen, nicht vom Fenster", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3"]);
    mount(el, state);
    // Seitenleiste und Rand schieben das Raster im Fenster nach rechts und unten.
    const origin = { left: 300, top: 40, right: 1962, bottom: 1037, width: 1662, height: 997, x: 300, y: 40 };
    vi.spyOn(el.querySelector<HTMLElement>(".grid")!, "getBoundingClientRect").mockReturnValue({
      ...origin,
      toJSON: () => origin,
    });
    // Von der zweiten Kachel auf einen Punkt, der im Raster ueber der ersten liegt
    // (x: 900 - 300 = 600 < 827, y: 520 - 40 = 480 < 495), ungerechnet aber ueber
    // der zweiten (x: 900 >= 835) bzw. der breiten dritten (y: 520 >= 503).
    const head = tilesByPosition(el)[1].querySelector<HTMLElement>(".tile-head")!;
    pointer(head, "pointerdown", 1200, 60);
    pointer(head, "pointermove", 900, 520);
    pointer(head, "pointerup", 900, 520);
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s2", "h1/s1", "h1/s3"]);
  });

  it("ein Maximieren mitten im Zug: nur die sichtbare Kachel kann Ziel sein, verborgene haben keine Lage mehr", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2", "s3"]);
    mount(el, state);
    const [first, second, third] = tilesByPosition(el);
    const head = first.querySelector<HTMLElement>(".tile-head")!;

    pointer(head, "pointerdown", 100, 10);
    pointer(head, "pointermove", 110, 10);
    // Strg+Umschalt+M waehrend des Zugs: nur s3 ist noch zu sehen, und sie fuellt die Flaeche.
    state.toggleMaximize(state.tiles[2].id);
    pointer(head, "pointermove", 1000, 100);
    expect(second.classList.contains("tile--drop-target")).toBe(false);
    expect(third.classList.contains("tile--drop-target")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(el.querySelector(".tile--drag-source, .tile--drop-target")).toBeNull();
  });

  it("moveFocusedTile schiebt die fokussierte Kachel und sagt es an; am Rand nichts", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    const grid = mount(el, state);
    grid.moveFocusedTile(-1);
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s2", "h1/s1"]);
    expect(liveText(el)).toBe("s2 moved to position 1");
    // Auch die mit der Tastatur verschobene Kachel leuchtet auf (§6.2).
    const [moved, other] = tilesByPosition(el);
    expect(moved.querySelector(".tile-title")?.textContent).toBe("s2");
    expect(moved.classList.contains("tile--flash")).toBe(true);
    expect(other.classList.contains("tile--flash")).toBe(false);
    grid.moveFocusedTile(-1);
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s2", "h1/s1"]);
  });

  it("am Rand bleibt die Live-Region stumm, auch ohne fokussierte Kachel", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    const grid = mount(el, state);
    grid.moveFocusedTile(1);
    expect(liveText(el)).toBe("");
    state.closeTile(state.tiles[0].id);
    state.closeTile(state.tiles[0].id);
    grid.moveFocusedTile(1);
    expect(liveText(el)).toBe("");
  });

  it("ein Tausch schickt jede sichtbare Kachel durch den entprellten Pfad; resize_terminal nur bei geaenderter Groesse (Spec §4.5)", () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement("div");
      const state = stateWithTiles(["s1", "s2", "s3"]);
      mount(el, state);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      state.swapTiles(state.tiles[0].id, state.tiles[2].id);
      vi.advanceTimersByTime(300);
      // Alle sichtbaren gehen durch den entprellten Pfad, auch die mittlere,
      // deren Platz bleibt; `resize_terminal` schickt `terminal.ts` nur fuer
      // die, deren Spalten oder Zeilen sich aendern -- das sichert dort der
      // Test "ruft resize_terminal kein zweites Mal auf …", auch fuer einen
      // Tausch gleich grosser Kacheln.
      expect(hoisted.fitSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ein Tausch gleich grosser Kacheln aendert keine Groesse (Spec §10.1; resize_terminal entfaellt dann in terminal.ts)", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const sizeById = (): Record<string, string> => {
      const sizes: Record<string, string> = {};
      for (const tile of Array.from(el.querySelectorAll<HTMLElement>(".tile"))) {
        sizes[tile.dataset.tileId ?? ""] = `${tile.style.width} x ${tile.style.height}`;
      }
      return sizes;
    };
    const before = sizeById();
    const [first, second] = state.tiles.map((tile) => tile.id);
    state.swapTiles(first, second);
    // Getauscht ist wirklich: die Positionen wechseln, die Groessen nicht.
    expect(tilesByPosition(el).map((tile) => tile.dataset.tileId)).toEqual([String(second), String(first)]);
    expect(sizeById()).toEqual(before);
  });

  it("reicht dem Terminal die zwei Menueeintraege zum Verschieben, am Rand ausgegraut", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const options = hoisted.mountTerminalSpy.mock.calls[0][4] as {
      onMoveTile: (delta: 1 | -1) => void;
      canMoveTile: (delta: 1 | -1) => boolean;
      menuTexts: { items: Record<string, { label: string; shortcut?: string }> };
    };
    expect(options.canMoveTile(-1)).toBe(false);
    expect(options.canMoveTile(1)).toBe(true);
    expect(options.menuTexts.items.moveLater).toEqual({ label: "Move to next position", shortcut: "Ctrl+Shift+PageDown" });
    options.onMoveTile(1);
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s2", "h1/s1"]);
  });

  it("die Verschiebe-Eintraege der Kachel hinten: nach vorn geht, nach hinten nicht; beide Beschriftungen kommen aus der Tabelle", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const options = hoisted.mountTerminalSpy.mock.calls[1][4] as {
      onMoveTile: (delta: 1 | -1) => void;
      canMoveTile: (delta: 1 | -1) => boolean;
      menuTexts: { items: Record<string, { label: string; shortcut?: string }> };
    };
    expect(options.canMoveTile(-1)).toBe(true);
    expect(options.canMoveTile(1)).toBe(false);
    expect(options.menuTexts.items.moveEarlier).toEqual({ label: "Move to previous position", shortcut: "Ctrl+Shift+PageUp" });
    options.onMoveTile(-1);
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s2", "h1/s1"]);
    expect(liveText(el)).toBe("s2 moved to position 1");
  });
});

describe("mountGrid: Wiederfinden (Spec 2026-10-19 §6.2, §6.3, Schritt 1)", () => {
  it("revealTile laesst die Kontur 600 ms aufleuchten und nennt Nummer und Session", () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement("div");
      const state = stateWithTiles(["s1", "s2"]);
      const grid = mount(el, state);
      const second = tilesByPosition(el)[1];
      grid.revealTile(state.tiles[1].id);
      expect(second.classList.contains("tile--flash")).toBe(true);
      expect(el.querySelector(".ab-visually-hidden[aria-live]")?.textContent).toBe("Terminal 2: s2");
      vi.advanceTimersByTime(599);
      expect(second.classList.contains("tile--flash")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(second.classList.contains("tile--flash")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ein zweites revealTile startet die 600 ms neu; eine unbekannte id tut nichts", () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement("div");
      const state = stateWithTiles(["s1", "s2"]);
      const grid = mount(el, state);
      const first = tilesByPosition(el)[0];
      grid.revealTile(state.tiles[0].id);
      vi.advanceTimersByTime(400);
      grid.revealTile(state.tiles[0].id);
      vi.advanceTimersByTime(400);
      expect(first.classList.contains("tile--flash")).toBe(true);
      vi.advanceTimersByTime(200);
      expect(first.classList.contains("tile--flash")).toBe(false);

      const live = el.querySelector(".ab-visually-hidden[aria-live]")!;
      live.textContent = "";
      grid.revealTile(999);
      expect(live.textContent).toBe("");
      expect(el.querySelector(".tile--flash")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("der Zeitgeber des Aufleuchtens geht mit der Kachel und mit dem Raster", () => {
    vi.useFakeTimers();
    try {
      const state = stateWithTiles(["s1"]);
      const grid = mount(document.createElement("div"), state);
      const idle = vi.getTimerCount();
      grid.revealTile(state.tiles[0].id);
      expect(vi.getTimerCount()).toBe(idle + 1);
      state.closeTile(state.tiles[0].id);
      expect(vi.getTimerCount()).toBe(idle);

      const other = stateWithTiles(["s1"]);
      const second = mount(document.createElement("div"), other);
      second.revealTile(other.tiles[0].id);
      expect(vi.getTimerCount()).toBe(idle + 1);
      second.dispose();
      expect(vi.getTimerCount()).toBe(idle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schliesst die Kachel mit dem Tastaturfokus, bekommt ihn die Kachel, die jetzt den Fokus hat (Spec §5.5)", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const state = stateWithTiles(["s1", "s2"]);
      const grid = mount(el, state);
      grid.focusActiveTile();
      hoisted.focusSpy.mockClear();
      state.closeTile(state.tiles[1].id);
      expect(hoisted.focusSpy).toHaveBeenCalledExactlyOnceWith("s1");
    } finally {
      el.remove();
    }
  });

  // Die Nachbarin ist verborgen und behaelt ihr Terminal (Spec 2026-10-19 §8.1);
  // sichtbar wird sie im selben Neuzeichnen, das den Fokus weiterreichen soll.
  it("schliesst die maximierte Kachel mit dem Tastaturfokus, bekommt ihn die wieder sichtbare Nachbarin (Spec §5.5)", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const state = stateWithTiles(["s1", "s2"]);
      const grid = mount(el, state);
      state.toggleMaximize(state.tiles[1].id);
      grid.focusActiveTile();
      expect(tilesByPosition(el)[1].contains(document.activeElement)).toBe(true);
      hoisted.focusSpy.mockClear();
      state.closeTile(state.tiles[1].id);
      expect(hoisted.focusSpy).toHaveBeenCalledExactlyOnceWith("s1");
      expect(tilesByPosition(el)[0].contains(document.activeElement)).toBe(true);
      // Ihr eigenes Terminal, kein frisch montiertes.
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    } finally {
      el.remove();
    }
  });

  it("schliesst eine Kachel ohne den Tastaturfokus, bleibt er, wo er ist", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const state = stateWithTiles(["s1", "s2"]);
      mount(el, state);
      hoisted.focusSpy.mockClear();
      state.closeTile(state.tiles[1].id);
      expect(hoisted.focusSpy).not.toHaveBeenCalled();
    } finally {
      el.remove();
    }
  });

  // Der Fokus wechselt in `AppState` schon beim Schliessen; das `focusin` der
  // Nachbarin sieht darum keinen Wechsel und bliebe stumm. Wer den Fokus mit
  // einem Screenreader verfolgt, erfuehre nicht, in welchem Terminal er landet.
  it("schliesst die Kachel mit dem Tastaturfokus, nennt die Live-Region die Kachel, die ihn bekommt, ohne Aufleuchten (Spec §4.3, §5.5)", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const state = stateWithTiles(["s1", "s2", "s3"]);
      const grid = mount(el, state);
      state.focusTile(state.tiles[1].id);
      grid.focusActiveTile();
      expect(tilesByPosition(el)[1].contains(document.activeElement)).toBe(true);
      const live = el.querySelector<HTMLElement>(".ab-visually-hidden[aria-live]")!;
      live.textContent = "";

      state.closeTile(state.tiles[1].id);

      // s3 rueckt von Position 3 auf 2 auf, und die Ansage nennt die neue Nummer.
      const neighbour = tilesByPosition(el)[1];
      expect(neighbour.querySelector(".tile-title")?.textContent).toBe("s3");
      expect(neighbour.contains(document.activeElement)).toBe(true);
      expect(live.textContent).toBe("Terminal 2: s3");
      expect(el.querySelector(".tile--flash")).toBeNull();
    } finally {
      el.remove();
    }
  });

  it("schliesst die maximierte Kachel mit dem Tastaturfokus, nennt die Live-Region die wieder sichtbare Nachbarin", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const state = stateWithTiles(["s1", "s2"]);
      const grid = mount(el, state);
      state.toggleMaximize(state.tiles[1].id);
      grid.focusActiveTile();
      const live = el.querySelector<HTMLElement>(".ab-visually-hidden[aria-live]")!;
      live.textContent = "";

      state.closeTile(state.tiles[1].id);

      expect(live.textContent).toBe("Terminal 1: s1");
      expect(el.querySelector(".tile--flash")).toBeNull();
    } finally {
      el.remove();
    }
  });

  // Spec 2026-10-19 §8.1 (Schritt 3): auch eine verborgene Kachel behaelt ihr
  // Terminal, und `AppState` gibt beim Schliessen den Fokus an die Nachbarin,
  // sichtbar oder nicht. Er folgt aber nur einer sichtbaren (wie in
  // `focusActiveTile`), und die Live-Region nennt keine, die niemand sieht.
  // Ein Browser nimmt einer verborgenen Kachel den Tastaturfokus, jsdom nicht:
  // dort bleibt er in s2 stehen, und der Test erreicht den Pfad. Schliesst die
  // maximierte Kachel, endet das Maximieren, und alle sind sichtbar (der Test
  // darueber).
  it("schliesst eine verborgene Kachel, die den Tastaturfokus noch haelt, bekommt ihn die verborgene Nachbarin nicht, und die Live-Region sagt sie nicht an", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const state = stateWithTiles(["s1", "s2", "s3"]);
      const grid = mount(el, state);
      state.focusTile(state.tiles[1].id);
      grid.focusActiveTile();
      // s1 maximiert: s2 und s3 sind verborgen, der Fokus liegt weiter in s2.
      state.toggleMaximize(state.tiles[0].id);
      expect(tilesByPosition(el)[1].contains(document.activeElement)).toBe(true);
      const live = el.querySelector<HTMLElement>(".ab-visually-hidden[aria-live]")!;
      live.textContent = "";
      hoisted.focusSpy.mockClear();

      state.closeTile(state.tiles[1].id);

      // Der Fokus in `AppState` geht an s3, und die ist verborgen ...
      expect(state.focusedTile).toBe(state.tiles[1].id);
      expect(state.visibleTileIds()).toEqual([state.tiles[0].id]);
      // ... ihr Terminal bleibt, bekommt ihn aber nicht, und niemand sagt sie an.
      expect(hoisted.focusSpy).not.toHaveBeenCalled();
      expect(live.textContent).toBe("");
    } finally {
      el.remove();
    }
  });

  it("schliesst eine Kachel, ohne den Tastaturfokus zu bewegen, sagt die Live-Region nichts an", () => {
    hoisted.focusMovesDom = true;
    const el = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(el, outside);
    try {
      const state = stateWithTiles(["s1", "s2", "s3"]);
      const grid = mount(el, state);
      const live = el.querySelector<HTMLElement>(".ab-visually-hidden[aria-live]")!;

      // Der Fokus liegt ausserhalb des Rasters (etwa in der Seitenleiste), und
      // die Kachel, die den Fokus in `AppState` hat, schliesst.
      outside.focus();
      live.textContent = "";
      state.closeTile(state.tiles[2].id);
      expect(state.focusedTile).toBe(state.tiles[1].id);
      expect(document.activeElement).toBe(outside);
      expect(live.textContent).toBe("");

      // Der Fokus liegt in einer Kachel, die bleibt, und eine andere schliesst.
      state.focusTile(state.tiles[0].id);
      grid.focusActiveTile();
      expect(tilesByPosition(el)[0].contains(document.activeElement)).toBe(true);
      live.textContent = "";
      state.closeTile(state.tiles[1].id);
      expect(tilesByPosition(el)[0].contains(document.activeElement)).toBe(true);
      expect(live.textContent).toBe("");
    } finally {
      el.remove();
      outside.remove();
    }
  });

  it("wandert der Tastaturfokus in eine andere Kachel, nennt die Live-Region Nummer und Session, ohne Aufleuchten (Spec §4.3)", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const live = el.querySelector<HTMLElement>(".ab-visually-hidden[aria-live]")!;
    const first = tilesByPosition(el)[0];
    live.textContent = "";
    // Etwa per Tab aus der zweiten Kachel in die erste.
    first.querySelector(".tile-terminal")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(state.focusedTile).toBe(state.tiles[0].id);
    expect(live.textContent).toBe("Terminal 1: s1");
    expect(first.classList.contains("tile--flash")).toBe(false);
    // Lag der Fokus schon in dieser Kachel (eine Wahl, Strg+Umschalt+1-9, der
    // Kopf), sagt ein weiteres `focusin` nichts doppelt an.
    live.textContent = "";
    first.querySelector(".tile-terminal")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(live.textContent).toBe("");
  });
});

describe("mountGrid: Doppelklick auf den Kachelkopf maximiert (Spec §7.2)", () => {
  it("maximiert die Kachel bei einem Doppelklick auf den Kopf", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);

    const head = tilesByPosition(el)[0].querySelector<HTMLDivElement>(".tile-head");
    head?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(state.maximizedTile).toBe(state.tiles[0].id);
  });

  it("maximiert NICHT zusaetzlich, wenn der Doppelklick auf eine Kopf-Schaltflaeche faellt", () => {
    // Sonst wuerde ein Doppelklick auf "Schliessen" die Kachel gleichzeitig
    // maximieren -- zwei Wirkungen fuer eine Geste.
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);

    // Letztes `.tile-btn` im Kopf ist die Schliessen-Schaltflaeche (siehe
    // Baureihenfolge in `grid.ts::buildTile`: Maximieren vor Schliessen).
    const closeBtn = tilesByPosition(el)[0].querySelector<HTMLButtonElement>(".tile-acts .tile-btn:last-child");
    closeBtn?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(state.maximizedTile).toBeNull();
  });
});

// Spec 2026-10-19 §8.1 (Schritt 3): Maximieren verbirgt die uebrigen Kacheln,
// ihre Terminals bleiben. Strg+Umschalt+W und Strg+Umschalt+M wirken auf die
// fokussierte Kachel in `AppState`; die muss die Kachel des Knopfes sein, nicht
// eine, die er gerade verbirgt. Ein Druck auf einen Kopfknopf setzt den Fokus
// nicht selbst (`pointerdown` nimmt die Knoepfe aus), und `click()` -- aus der
// Hilfstechnik etwa -- fokussiert den Knopf nicht in jedem Weg.
describe("mountGrid: der Maximieren-Knopf fokussiert zuerst seine Kachel (Spec 2026-10-19 §8.1)", () => {
  /** Der Knopf Maximieren/Wiederherstellen der Kachel an `position` (der erste
   * Knopf im Kopf, vor "Schliessen"). */
  function maximizeButton(el: HTMLElement, position: number): HTMLButtonElement {
    return tilesByPosition(el)[position].querySelector<HTMLButtonElement>(".tile-btn")!;
  }

  it("mit Kachel 1 im Fokus macht der Knopf von Kachel 3 sie zur fokussierten und maximierten; ihr Terminal bekommt den Tastaturfokus, die Ansage nennt das Maximieren", () => {
    const state = stateWithTiles(["s1", "s2", "s3"]);
    const el = document.createElement("div");
    mount(el, state);
    state.focusTile(state.tiles[0].id);
    expect(state.focusedTile).toBe(state.tiles[0].id);
    hoisted.focusSpy.mockClear();
    const live = el.querySelector<HTMLElement>('.tile-grid-view > .ab-visually-hidden[aria-live="polite"]')!;
    // Jedes Setzen des Textes ergibt einen Eintrag: so zeigt sich eine zweite
    // Ansage, die der Text allein nicht verriete.
    const writes = new MutationObserver(() => {});
    writes.observe(live, { childList: true });
    try {
      writes.takeRecords();

      maximizeButton(el, 2).click();

      expect(state.maximizedTile).toBe(state.tiles[2].id);
      expect(state.focusedTile).toBe(state.tiles[2].id);
      expect(hoisted.focusSpy).toHaveBeenCalledExactlyOnceWith("s3");
      // Die Ansage des Maximierens nennt die Kachel schon; die Wahl der Kachel
      // sagt nichts davor an, sie wuerde sofort ueberschrieben.
      expect(live.textContent).toBe("Terminal 3 maximized. Press Ctrl+Shift+M to restore.");
      expect(writes.takeRecords().filter((record) => record.addedNodes.length > 0)).toHaveLength(1);
    } finally {
      writes.disconnect();
    }
  });

  it("der Knopf der maximierten Kachel stellt wieder her und laesst sie fokussiert, auch wenn der Fokus in AppState woanders lag", () => {
    const state = stateWithTiles(["s1", "s2", "s3"]);
    const el = document.createElement("div");
    mount(el, state);
    state.toggleMaximize(state.tiles[2].id);
    state.focusTile(state.tiles[0].id);
    expect(state.visibleTileIds()).toEqual([state.tiles[2].id]);

    maximizeButton(el, 2).click();

    expect(state.maximizedTile).toBeNull();
    expect(state.focusedTile).toBe(state.tiles[2].id);
  });

  it("auch eine Kachel ohne Terminal (Host ausgefallen) wird fokussiert und maximiert", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.upsertHost({ ...makeHost("h2", "vm-2"), state: "failed", error: "gone" });
    state.setSessions("h1", ["s1"]);
    state.setSessions("h2", ["s2"]);
    state.openSession("h1", "s1");
    state.openSession("h2", "s2");
    const el = document.createElement("div");
    mount(el, state);
    // Nur s1 hat ein Terminal: der Host von s2 ist ausgefallen.
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
    state.focusTile(state.tiles[0].id);
    hoisted.focusSpy.mockClear();

    maximizeButton(el, 1).click();

    expect(state.maximizedTile).toBe(state.tiles[1].id);
    expect(state.focusedTile).toBe(state.tiles[1].id);
    expect(hoisted.focusSpy).not.toHaveBeenCalled();
  });
});

describe("mountGrid: Leerzustand 'Host verbunden, keine Session' (Nachtrag B, Punkt 2, Design §11.2)", () => {
  it("zeigt die Karte statt leerer Kachelrahmen; ihr Knopf fragt main.ts, wo die Session hin soll", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    const el = document.createElement("div");
    const onNewSession = vi.fn();
    mount(el, state, { onNewSession });

    // §5.6: KEINE leeren Kachelrahmen -- `.grid` selbst ist unsichtbar,
    // nicht nur leer.
    expect(el.querySelector<HTMLElement>(".grid")?.hidden).toBe(true);
    const card = el.querySelector<HTMLElement>(".grid-empty-card");
    expect(card).not.toBeNull();
    expect(el.querySelector<HTMLElement>(".grid-empty")?.hidden).toBe(false);
    expect(card?.textContent).toContain("No terminal open");

    const button = card?.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    // UX-Spec §7.9: den Zielhost waehlt dieselbe Kette wie Strg+Umschalt+N
    // (main.ts), nicht dieses Raster -- sonst stimmte der Tooltip
    // "New session (Ctrl+Shift+N)" nicht.
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onNewSession).toHaveBeenCalledWith();
  });

  it("versteckt die Karte wieder, sobald eine Session sichtbar eine Kachel belegt", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    const el = document.createElement("div");
    mount(el, state);

    expect(el.querySelector<HTMLElement>(".grid-empty")?.hidden).toBe(false);

    state.openSession("h1", "s1");

    expect(el.querySelector<HTMLElement>(".grid-empty")?.hidden).toBe(true);
    expect(el.querySelector<HTMLElement>(".grid")?.hidden).toBe(false);
  });
});

describe("mountGrid: Sperrleiste bei gesperrter Eingabe (Nachtrag B, Punkt 3, Designsystem §8.3)", () => {
  it("zeigt die Sperrleiste erst NACH dem Sperren, mit Text ueber die weiterlaufende Session -- nicht nur Farbe", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);

    const strip = tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-lock");
    expect(strip).not.toBeNull();
    // Vorbedingung ausdruecklich geprueft: die Leiste existiert bereits im
    // DOM (dasselbe Muster wie `focusedFlag`/`maximizedHint`), ist aber
    // versteckt -- sonst pruefte der Vergleich unten nur "existiert jetzt",
    // nicht "wurde sichtbar".
    expect(strip?.hidden).toBe(true);

    state.lockInput("h1", "s1");

    expect(strip?.hidden).toBe(false);
    // Randbedingung 3 (kein Zustand allein ueber Farbe): der TEXT ist die
    // eigentliche Absicherung, nicht die Klasse `.tile-lock` oder ihre Farbe.
    expect(strip?.textContent).toContain("Disconnected");
    // Und sie verspricht NICHT mehr unbedingt, dass die Sitzung weiterlaeuft:
    // derselbe Streifen erscheint seit B1 auch, wenn `open_terminal`
    // abgelehnt wurde ("diese Session gibt es nicht mehr" ist dort der
    // haeufigste Grund) und wenn die Montage auf einem fehlgeschlagenen Host
    // verweigert wurde. Ein unbedingtes "keeps running on the host" haette
    // dem Banner daneben widersprochen, das im selben Moment "may have
    // ended" sagt.
    expect(strip?.textContent).not.toContain("keeps running");
    // Und POSITIV, sonst haelt der Schluessel nichts mehr: eine reine
    // `not.toContain`-Zusicherung bleibt auch dann wahr, wenn der Text durch
    // Unsinn ersetzt wird -- gemessen, als B4s Deckungsgegenprobe nach
    // dieser Aenderung fuer `terminal.connectionLost` gruen blieb.
    expect(strip?.textContent).toContain(
      "This terminal lost its connection to the session. Reconnect to continue — if the session has ended, you'll see why.",
    );
    // B4: die Meldung darf den HOST nicht beschuldigen. Gemessen ist das im
    // haeufigen Fall falsch -- der Host antwortet, die Sessionliste kommt
    // durch, andere Kacheln desselben Hosts arbeiten weiter. Verloren war
    // EIN Kanal.
    expect(strip?.textContent).not.toContain("Connection to");
    // Und sie nennt den Rueckweg, statt nur einen Zustand zu behaupten.
    expect(strip?.textContent).toContain("Reconnect");
  });

  // Abnahme B5: in einer schmalen Kachel kuerzt die Meldung auf einer Zeile
  // (styles.css); ihr voller Text steht im Tooltip -- auf jedem Weg, der sie
  // setzt: verlorene Verbindung, beendete Session, wieder frei.
  it("der volle Text der Meldung ist ihr Tooltip, auch wenn der Grund wechselt (Abnahme B5)", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);
    const message = () => tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-lock > .tile-lock-message")!;
    expect(message().hasAttribute("title")).toBe(false);

    state.lockInput("h1", "s1");
    const lost = `${en["tile.inputLocked"]} — ${en["terminal.connectionLost"]}`;
    expect(message().textContent).toBe(lost);
    expect(message().title).toBe(lost);

    state.setSessionRecords("h1", [{ name: "s1", status: "ended", statusReason: "tmux server was replaced" }]);
    const ended = `${en["tile.inputLocked"]} — ${en["terminal.sessionEnded"]}`;
    expect(message().textContent).toBe(ended);
    expect(message().title).toBe(ended);

    state.applyInputLocks([], ["h1/s1"]);
    expect(message().hasAttribute("title")).toBe(false);
  });
});

describe("mountGrid: Reconnect in der Sperrleiste (Nachtrag C, Befund 2, Designsystem §8.3 Punkt 2)", () => {
  it("haengt an Ort und Stelle neu an: Position, Fokus und Maximieren bleiben, die Sperre faellt (Spec §5.8)", () => {
    vi.useFakeTimers();
    try {
      const state = stateWithTiles(["s1", "s2", "s3"]);
      const el = document.createElement("div");
      mount(el, state);
      const middle = state.tiles[1].id;
      state.focusTile(middle);
      state.toggleMaximize(middle);
      state.lockInput("h1", "s2");
      const mounts = hoisted.mountTerminalSpy.mock.calls.length;
      const disposals = hoisted.disposeSpy.mock.calls.length;
      // Offene Refits aus Maximieren und Sperre abraeumen.
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      // Primitiver Schnappschuss im Augenblick des Mounts (siehe
      // "eine neue Kachel montiert mit ihrer Endgeometrie").
      let stripHiddenAtMount: boolean | undefined;
      hoisted.mountTerminalSpy.mockImplementationOnce((container: HTMLElement) => {
        stripHiddenAtMount = container.closest(".tile")?.querySelector<HTMLElement>(".tile-lock")?.hidden;
      });

      el.querySelector<HTMLButtonElement>(`.tile[data-tile-id="${middle}"] .tile-lock-reconnect`)!.click();

      expect(state.tiles[1].id).toBe(middle);
      expect(state.focusedTile).toBe(middle);
      expect(state.maximizedTile).toBe(middle);
      expect(hoisted.mountTerminalSpy.mock.calls.length).toBe(mounts + 1);
      expect(hoisted.disposeSpy.mock.calls.length).toBe(disposals + 1);
      expect(state.hosts[0].sessions.find((row) => row.name === "s2")?.inputLocked).toBe(false);
      // Das frische Terminal misst ohne den 32-px-Streifen und meldet so seine
      // Endgroesse mit `open_terminal`; danach kein Refit (Spec §4.5).
      expect(stripHiddenAtMount).toBe(true);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Validierung (Important 2): `openSession` loeschte `inputLocked`
// BEDINGUNGSLOS. Sitzt die Session in ihrer Kachel aber schon, liefert
// `assignTile` ueber Punkt 1 denselben Index zurueck, `#releaseSession`
// laeuft nicht, und `reconcile()` bricht bei `mountedKeys[i] === wantKey`
// ab -- es wird NICHTS neu gemountet, der `TerminalHandle` behaelt sein
// `disableStdin = true`. Uebrig blieb ein Terminal, das normal aussieht und
// jeden Tastendruck verschluckt: Chip, Streifen, `.locked` und die
// "Reconnect"-Schaltflaeche (der einzige Weg zurueck) waren verschwunden.
// Ausloeser sind ein Klick auf die Sessionzeile der Seitenleiste UND
// Ctrl+Shift+1..9 / Ctrl+Shift+Hoch/Runter -- alle drei landen in
// `AppState.openSession`.
describe("mountGrid: Sperre und tatsaechlicher Eingabezustand duerfen nicht auseinanderlaufen (Validierung, Important 2)", () => {
  it("laesst Sperre, Streifen und Reconnect stehen, wenn eine bereits sichtbare gesperrte Session erneut ausgewaehlt wird -- es wird ja nichts neu gemountet", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);

    state.lockInput("h1", "s1");
    const tile = tilesByPosition(el)[0];
    const strip = tile.querySelector<HTMLElement>(".tile-lock") as HTMLElement;
    // Vorbedingung: gesperrt und sichtbar gemacht.
    expect(strip.hidden).toBe(false);
    expect(tile.classList.contains("locked")).toBe(true);

    // Der Klick auf die Sessionzeile (sidebar.ts) bzw. der Akkord --
    // beide rufen genau das hier.
    state.openSession("h1", "s1");

    // Kein zweiter Mount, kein Dispose: derselbe Kanal wie vorher, mit
    // demselben `disableStdin`. DAS ist der Grund, warum die Sperre bleiben
    // muss -- die Zusicherung darunter waere ohne diese hier nur die halbe
    // Aussage.
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();

    expect(state.hosts[0].sessions[0].inputLocked).toBe(true);
    expect(tile.classList.contains("locked")).toBe(true);
    expect(strip.hidden).toBe(false);
    // Der Weg zurueck bleibt erreichbar -- er sitzt IM Streifen und ginge
    // mit ihm verloren.
    expect(strip.querySelector<HTMLButtonElement>(".tile-lock-reconnect")?.textContent).toBe(
      "Reconnect",
    );
  });

  it("loescht die Sperre weiterhin, wenn die Session tatsaechlich frisch in eine Kachel gemountet wird", () => {
    // Die andere Haelfte derselben Regel: ohne sie waere "Sperre bleibt
    // stehen" auch dann erfuellt, wenn sie NIE mehr verschwaende -- der
    // Streifen behauptete dann eine Sperre auf einem frischen Kanal, der
    // gar keine hat.
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);

    state.lockInput("h1", "s1");
    // Die blosse Wahl aendert nichts (Test oben) ...
    state.openSession("h1", "s1");
    expect(state.hosts[0].sessions[0].inputLocked).toBe(true);

    // ... ein frischer Kanal schon. Seit Spec 2026-10-19 §8.1 montieren
    // Maximieren und Zurueckholen nichts mehr; frisch montiert die neue
    // Verbindung des Hosts (UX-Spec §5.4): die Laufzeit-ID kommt noch waehrend
    // "connecting", montiert wird bei "connected".
    state.setHostState("h1", "connecting");
    state.setRuntimeId("h1", "r-h1-new");
    state.setHostState("h1", "connected");
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);

    expect(state.hosts[0].sessions[0].inputLocked).toBe(false);
    expect(tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-lock")?.hidden).toBe(true);
  });
});

describe("mountGrid: Verbindungsverlust", () => {
  it("meldet einen Verbindungsverlust nach oben, statt selbst zu sperren", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1"); // Kachel 0
    const onConnectionLost = vi.fn();
    mount(document.createElement("div"), state, { onConnectionLost });

    // Fuenftes Argument von `mountTerminal` ist das Optionsobjekt
    // (grid.ts:571-585). Ueber `length - 1` statt `at(-1)`: `at` ist ES2022,
    // `tsconfig.json`s `lib` steht auf ES2020 (`npm run build` faellt sonst).
    const calls = hoisted.mountTerminalSpy.mock.calls;
    const opts = calls[calls.length - 1][4] as {
      onConnectionLost: () => void;
    };
    opts.onConnectionLost();

    // Der Host lebt: die Kachel haengt sich still neu an (UX-Spec §5.5) und
    // sagt das mit dem dritten Argument dazu.
    expect(onConnectionLost).toHaveBeenCalledWith("h1", "s1", true, "app");
    // Die Ansicht darf die Sperre NICHT mehr selbst setzen. Taete sie es
    // zusaetzlich, gaebe es zwei Wege zum selben Zustand -- und main.ts's
    // Probe haenge nur an einem davon.
    expect(state.hosts[0].sessions[0].inputLocked).toBe(false);
  });
});

// UX-Spec §5.5: verliert eine Kachel ihren Kanal, waehrend die Verbindung
// ihres Hosts lebt (typisch: der 30-s-Waechter bei minimiertem Fenster), haengt
// sie sich bis zu dreimal selbst neu an -- nach 0,5, 2 und 5 s, ueber ein
// frisches `open_terminal` wie der Knopf "Reconnect". Solange steht im Kopf
// ein ruhiger Hinweis "Reconnecting…" statt der Sperrleiste.
describe("mountGrid: stilles Wiederanhaengen (UX-Spec §5.5)", () => {
  interface MountOptionsLike {
    onConnectionLost: () => void;
    onOpenFailed: () => void;
    onOpened?: () => void;
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    // Eine aufgegebene Reihe nennt ihren Grund in der Konsole (siehe dort);
    // stumm, damit das Testprotokoll sauber bleibt.
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    warn.mockRestore();
    Reflect.deleteProperty(document, "hidden");
  });

  function setHidden(value: boolean): void {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
  }

  function mounts(): number {
    return hoisted.mountTerminalSpy.mock.calls.length;
  }

  /** Optionen des zuletzt gemounteten Terminals. */
  function lastOpts(): MountOptionsLike {
    const calls = hoisted.mountTerminalSpy.mock.calls;
    return calls[calls.length - 1][4] as MountOptionsLike;
  }

  /** Fehlerkanal (`onError`) des zuletzt gemounteten Terminals. */
  function lastOnError(): (error: TerminalError) => void {
    const calls = hoisted.mountTerminalSpy.mock.calls;
    return calls[calls.length - 1][3] as (error: TerminalError) => void;
  }

  function setup(
    opts: Partial<GridOptions> = {},
    before?: (state: AppState) => void,
  ): { state: AppState; el: HTMLElement; options: GridOptions } {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    before?.(state);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    const options: GridOptions = {
      onTerminalError: vi.fn(),
      onCloseTerminal: vi.fn(),
      onReconnectHost: vi.fn(),
      onNewSession: vi.fn(),
      onConnectionLost: vi.fn(),
      // Wie main.ts: ein abgelehntes Oeffnen sperrt die Eingabe.
      onTerminalOpenFailed: vi.fn((hostId: string, name: string) => state.lockInput(hostId, name)),
      onTerminalCapacity: vi.fn(),
      ...opts,
    };
    mount(el, state, options);
    return { state, el, options };
  }

  function quiet(el: HTMLElement): HTMLElement {
    return tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-quiet")!;
  }
  function strip(el: HTMLElement): HTMLElement {
    return tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-lock")!;
  }

  it("haengt bei lebendem Host nach 500 ms still neu an und zeigt solange Reconnecting…", () => {
    const { state, el, options } = setup();
    expect(mounts()).toBe(1);
    expect(quiet(el).hidden).toBe(true);

    lastOpts().onConnectionLost();

    expect(options.onConnectionLost).toHaveBeenCalledWith("h1", "s1", true, "app");
    expect(quiet(el).hidden).toBe(false);
    expect(quiet(el).textContent).toBe("Reconnecting…");
    expect(quiet(el).querySelector(".ind-connecting")).not.toBeNull();
    // Statt der Sperrleiste, nicht zusaetzlich zu ihr.
    expect(strip(el).hidden).toBe(true);
    expect(tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-lock-chip")!.hidden).toBe(true);
    expect(state.hosts[0].sessions[0].inputLocked).toBe(false);
    // Solange der Hinweis steht, sperrt das Raster die Eingabe selbst.
    expect(hoisted.inputLockedByMount[0]).toBe(true);

    vi.advanceTimersByTime(499);
    expect(mounts()).toBe(1);
    vi.advanceTimersByTime(1);
    // Derselbe Weg wie "Reconnect": der alte Handle geht, ein frischer kommt --
    // in derselben Kachel, ohne Platzwechsel.
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(mounts()).toBe(2);
    expect(state.tiles[0].sessionKey).toBe("h1/s1");
    // Die Eingabe bleibt gesperrt, bis der neue Kanal angehaengt ist.
    expect(hoisted.inputLockedByMount[1]).toBe(true);
    expect(quiet(el).hidden).toBe(false);

    lastOpts().onOpened?.();
    expect(quiet(el).hidden).toBe(true);
    expect(strip(el).hidden).toBe(true);
    expect(hoisted.inputLockedByMount[1]).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(2);
    expect(options.onTerminalOpenFailed).not.toHaveBeenCalled();
  });

  it("wartet bei verborgenem Fenster auf visibilitychange", () => {
    const { el } = setup();
    setHidden(true);
    lastOpts().onConnectionLost();
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(1);
    expect(quiet(el).hidden).toBe(false);

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mounts()).toBe(2);
  });

  it("zeigt nach drei Fehlschlaegen die Sperrleiste mit Reconnect und meldet die Fehler nicht als Banner", () => {
    const { state, el, options } = setup();
    lastOpts().onConnectionLost();
    for (const [attempt, delay] of [500, 2000, 5000].entries()) {
      const before = mounts();
      vi.advanceTimersByTime(delay - 1);
      expect(mounts()).toBe(before);
      vi.advanceTimersByTime(1);
      expect(mounts()).toBe(before + 1);
      // Was terminal.ts bei einem abgelehnten Oeffnen meldet: erst onError,
      // dann onOpenFailed. Beides bleibt still, solange die Reihe laeuft.
      lastOnError()({ kind: "open", detail: `attempt ${attempt + 1}: tmux binding query failed (exit 1)` });
      lastOpts().onOpenFailed();
    }
    expect(options.onTerminalError).not.toHaveBeenCalled();
    // Der Grund des letzten Versuchs bleibt fuer die Diagnose in der Konsole.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("attempt 3: tmux binding query failed (exit 1)");
    expect(options.onTerminalOpenFailed).toHaveBeenCalledTimes(1);
    expect(options.onTerminalOpenFailed).toHaveBeenCalledWith("h1", "s1", "app");
    expect(state.hosts[0].sessions[0].inputLocked).toBe(true);
    expect(quiet(el).hidden).toBe(true);
    expect(strip(el).hidden).toBe(false);
    const reconnect = strip(el).querySelector<HTMLButtonElement>(".tile-lock-reconnect")!;
    expect(reconnect.hidden).toBe(false);
    expect(reconnect.textContent).toBe("Reconnect");
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(4);
  });

  it("gibt die Reihe an einer Kanalgrenze auf: das Banner nennt den Satz mit dem Rohtext, die Sperre bleibt (Spec 2026-10-19 §8.3)", () => {
    const { state, el, options } = setup();
    lastOpts().onConnectionLost();
    const detail = "Terminal operation failed during Admission: Capacity";
    for (const delay of [500, 2000, 5000]) {
      vi.advanceTimersByTime(delay);
      lastOnError()({ kind: "open", detail });
      lastOpts().onOpenFailed();
    }
    expect(options.onTerminalError).toHaveBeenCalledExactlyOnceWith(
      "vm-1 has no free terminal channel right now. Close a terminal and try again.",
      detail,
    );
    expect(options.onTerminalCapacity).not.toHaveBeenCalled();
    expect(options.onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
    expect(state.hosts[0].sessions[0].inputLocked).toBe(true);
    expect(strip(el).hidden).toBe(false);
    // Der Grund steht im Banner; die Konsole bleibt still.
    expect(warn).not.toHaveBeenCalled();
  });

  it("nennt bei einer inzwischen beendeten Session keine Kanalgrenze, auch wenn ein Versuch daran scheiterte", () => {
    const { state, el, options } = setup();
    lastOpts().onConnectionLost();
    vi.advanceTimersByTime(500);
    lastOnError()({ kind: "open", detail: "Terminal operation failed during Admission: Capacity" });
    lastOpts().onOpenFailed();
    // Die Statusabfrage hat die Session inzwischen als beendet erkannt.
    state.setSessionRecords("h1", [{ name: "s1", status: "ended", statusReason: "tmux server was replaced" }]);
    vi.advanceTimersByTime(2000);
    expect(options.onTerminalError).not.toHaveBeenCalled();
    expect(options.onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
    // Die Sperrleiste nennt den Grund; die Konsole bleibt still.
    expect(strip(el).textContent).toContain("This session has ended on the host.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("meldet Fehler eines angehaengten Terminals wieder als Banner", () => {
    const { options } = setup();
    lastOpts().onConnectionLost();
    vi.advanceTimersByTime(500);
    lastOpts().onOpened?.();
    lastOnError()({ kind: "input", detail: "send_input failed" });
    expect(options.onTerminalError).toHaveBeenCalledWith(
      "Your typing didn't reach 's1'. Reconnect the terminal.",
      "send_input failed",
    );
  });

  it("zeigt bei beendeter Session die Sperrleiste mit dem Grund und versucht es nicht mehr", () => {
    const { state, el, options } = setup();
    lastOpts().onConnectionLost();
    vi.advanceTimersByTime(500);
    lastOpts().onOpenFailed();
    // Die Statusabfrage hat die Session inzwischen als beendet erkannt.
    state.setSessionRecords("h1", [
      { name: "s1", status: "ended", statusReason: "bound session is absent from a complete inventory" },
    ]);
    vi.advanceTimersByTime(2000);
    // Kein zweiter Versuch: die Sperrleiste nennt den Grund, ohne "Reconnect".
    expect(mounts()).toBe(2);
    expect(options.onTerminalOpenFailed).toHaveBeenCalledWith("h1", "s1", "app");
    expect(quiet(el).hidden).toBe(true);
    expect(strip(el).hidden).toBe(false);
    expect(strip(el).textContent).toContain("This session has ended on the host.");
    expect(strip(el).textContent).not.toContain("lost its connection");
    expect(strip(el).querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.hidden).toBe(true);
    expect(strip(el).querySelector<HTMLButtonElement>(".tile-lock-close")!.hidden).toBe(false);
    // Der Grund steht in der Leiste; die Konsole bleibt still.
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(2);
  });

  // M1-Tor, Schritt 7 (2026-10-23): kill-session und new-session gleichen
  // Namens. Die Probe nach dem Verlust liest die Liste neu, und unter dem
  // Namen haengt eine neue Session; die Kachel hing sich an sie. Der Name ist
  // nie Identitaet: die alte Session ist beendet.
  describe("Neuanlage gleichen Namens", () => {
    const bound = { name: "s1", sessionId: 1, serverPid: 50, serverStartTime: 1000 };
    const bindOld = (state: AppState): void => state.setSessionRecords("h1", [bound]);

    function expectEnded(el: HTMLElement): void {
      expect(quiet(el).hidden).toBe(true);
      expect(strip(el).hidden).toBe(false);
      expect(strip(el).textContent).toContain("This session has ended on the host.");
      expect(strip(el).textContent).not.toContain("lost its connection");
      expect(strip(el).querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.hidden).toBe(true);
    }

    it("haengt sich nicht an eine gleichnamige neue Session und nennt die alte beendet", () => {
      const { state, el, options } = setup({}, bindOld);
      lastOpts().onConnectionLost();
      state.setSessionRecords("h1", [
        { ...bound, sessionId: 9, status: "unknown", statusReason: "no agent source is attached yet" },
      ]);
      vi.advanceTimersByTime(60_000);
      expect(mounts()).toBe(1);
      expect(options.onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
      expectEnded(el);
      expect(warn).not.toHaveBeenCalled();
    });

    it("gibt auf, wenn die Neuanlage erst nach einem gescheiterten Versuch in der Liste steht", () => {
      const { state, el, options } = setup({}, bindOld);
      lastOpts().onConnectionLost();
      vi.advanceTimersByTime(500);
      expect(mounts()).toBe(2);
      // Die alte Pane gibt es nicht mehr: das gebundene Oeffnen scheitert.
      lastOnError()({ kind: "open", detail: "bound pane is gone" });
      lastOpts().onOpenFailed();
      state.setSessionRecords("h1", [{ ...bound, sessionId: 9 }]);
      vi.advanceTimersByTime(60_000);
      expect(mounts()).toBe(2);
      expect(options.onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
      expectEnded(el);
    });

    it("nennt die Session auch beendet, wenn derselbe Name auf einem neuen tmux-Server liegt", () => {
      const { state, el } = setup({}, bindOld);
      lastOpts().onConnectionLost();
      state.setSessionRecords("h1", [{ ...bound, serverStartTime: 2000 }]);
      vi.advanceTimersByTime(60_000);
      expect(mounts()).toBe(1);
      expectEnded(el);
    });

    it("haengt bei derselben Identitaet weiter an, und ein neuer Kanal hebt die Marke auf", () => {
      const { state, el, options } = setup({}, bindOld);
      lastOpts().onConnectionLost();
      state.setSessionRecords("h1", [{ ...bound, status: "idle", statusReason: "agent is idle" }]);
      vi.advanceTimersByTime(500);
      expect(mounts()).toBe(2);
      lastOpts().onOpened?.();
      expect(quiet(el).hidden).toBe(true);
      expect(strip(el).hidden).toBe(true);
      expect(options.onTerminalOpenFailed).not.toHaveBeenCalled();
    });
  });

  it("haengt eine beendete Session gar nicht erst an und laesst die letzte Ausgabe stehen", () => {
    const { state, el } = setup();
    lastOpts().onConnectionLost();
    state.setSessionRecords("h1", [{ name: "s1", status: "ended", statusReason: "tmux server was replaced" }]);
    vi.advanceTimersByTime(500);
    expect(mounts()).toBe(1);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
    expect(strip(el).textContent).toContain("This session has ended on the host.");
  });

  it("haengt sich nicht an, wenn der Host beim Verlust keine Verbindung hat", () => {
    const { state, el, options } = setup();
    state.setHostState("h1", "failed", "gone");
    lastOpts().onConnectionLost();
    expect(options.onConnectionLost).toHaveBeenCalledWith("h1", "s1", false, "app");
    expect(quiet(el).hidden).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(1);
  });

  it("bricht ab, wenn der Host waehrend der Wartezeit seine Verbindung verliert", () => {
    const { state, el } = setup();
    lastOpts().onConnectionLost();
    state.lockInput("h1", "s1");
    state.setHostState("h1", "failed", "transport lost");
    expect(quiet(el).hidden).toBe(true);
    expect(strip(el).hidden).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(1);
  });

  it("bricht ab, wenn die Kachel geschlossen wird", () => {
    const { state } = setup();
    lastOpts().onConnectionLost();
    state.closeTile(state.tiles[0].id);
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(1);
  });

  it("weicht einer Sperre, die jemand anderes setzt", () => {
    const { state, el } = setup();
    lastOpts().onConnectionLost();
    expect(quiet(el).hidden).toBe(false);
    state.lockInput("h1", "s1");
    expect(quiet(el).hidden).toBe(true);
    expect(strip(el).hidden).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(1);
  });

  it("raeumt eine laufende Reihe beim Entsorgen des Rasters ab", () => {
    setup();
    lastOpts().onConnectionLost();
    activeHandles.splice(0).forEach((handle) => handle.dispose());
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(1);
  });

  // Spec 2026-10-19 §8.1 (Schritt 3): eine verborgene Kachel behaelt ihr
  // Terminal und damit auch ihre Reihe. Ihr faelliger Versuch wartet, bis sie
  // wieder zu sehen ist -- verborgen montiert das Raster nichts.
  it("eine verborgene Kachel, die ihren Kanal verliert, zeigt Reconnecting… und haengt sich erst nach dem Zurueckholen an", () => {
    const state = stateWithTiles(["s1", "s2"]);
    const el = document.createElement("div");
    const onConnectionLost = vi.fn();
    mount(el, state, { onConnectionLost });
    // s2 maximiert: s1 ist verborgen, behaelt aber Terminal und Kanal.
    state.toggleMaximize(state.tiles[1].id);
    expect(mounts()).toBe(2);

    (hoisted.mountTerminalSpy.mock.calls[0][4] as MountOptionsLike).onConnectionLost();

    expect(onConnectionLost).toHaveBeenCalledWith("h1", "s1", true, "app");
    expect(state.hosts[0].sessions[0].inputLocked).toBe(false);
    expect(quiet(el).hidden).toBe(false);
    expect(quiet(el).textContent).toBe("Reconnecting…");
    expect(strip(el).hidden).toBe(true);
    // Verborgen versucht sie nichts, auch nicht nach allen drei Wartezeiten.
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(2);
    expect(hoisted.disposeSpy).not.toHaveBeenCalled();
    expect(quiet(el).hidden).toBe(false);

    // Zurueckholen: der faellige Versuch laeuft sofort, in derselben Kachel.
    state.toggleMaximize(state.tiles[1].id);
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(mounts()).toBe(3);
    expect(hoisted.mountTerminalSpy.mock.calls[2][2]).toBe("s1");
    lastOpts().onOpened?.();
    expect(quiet(el).hidden).toBe(true);
    expect(strip(el).hidden).toBe(true);
  });

  it("wartet nach dem Zurueckholen bei verborgenem Fenster weiter auf visibilitychange", () => {
    const state = stateWithTiles(["s1", "s2"]);
    mount(document.createElement("div"), state);
    state.toggleMaximize(state.tiles[1].id);
    (hoisted.mountTerminalSpy.mock.calls[0][4] as MountOptionsLike).onConnectionLost();
    vi.advanceTimersByTime(500);

    setHidden(true);
    state.toggleMaximize(state.tiles[1].id);
    expect(mounts()).toBe(2);

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mounts()).toBe(3);
    expect(hoisted.mountTerminalSpy.mock.calls[2][2]).toBe("s1");
  });

  it("haengt mit der aktuellen Schriftgroesse an, nicht mit 13", () => {
    setTerminalPrefs({ fontSize: 16 });
    setup();
    lastOpts().onConnectionLost();
    vi.advanceTimersByTime(500);
    expect(hoisted.fontSizeAtMount).toEqual([16, 16]);
    expect(terminalPrefs().fontSize).toBe(16);
    expect(hoisted.setFontSizeSpy).not.toHaveBeenCalledWith("s1", 13);
  });

  it("zeigt bei einem neu verbindenden Host Reconnecting… statt der Sperrleiste", () => {
    const { state, el } = setup();
    state.lockInput("h1", "s1");
    state.setHostState("h1", "failed", "transport lost");
    state.setHostReconnecting("h1", true);
    expect(quiet(el).hidden).toBe(false);
    expect(quiet(el).textContent).toBe("Reconnecting…");
    expect(strip(el).hidden).toBe(true);
    // Ohne eigene Versuche gegen einen toten Host.
    vi.advanceTimersByTime(60_000);
    expect(mounts()).toBe(1);
    // Gibt die Reihe auf, steht wieder die Sperrleiste mit "Reconnect".
    state.setHostReconnecting("h1", false);
    expect(quiet(el).hidden).toBe(true);
    expect(strip(el).hidden).toBe(false);
  });

  /** Wie das Hilfstextfeld von xterm: ein fokussiertes Feld im Terminal der
   * Kachel, das `dispose()` mitnimmt -- danach laege der Fokus auf <body>. */
  function focusInsideTerminal(el: HTMLElement): void {
    const textarea = document.createElement("textarea");
    tilesByPosition(el)[0].querySelector(".tile-terminal")!.appendChild(textarea);
    textarea.focus();
    hoisted.disposeSpy.mockImplementationOnce(() => textarea.remove());
  }

  /** Fokus braucht ein Raster im Dokument; danach wird aufgeraeumt. */
  function inDocument(el: HTMLElement, run: (outside: HTMLButtonElement) => void): void {
    const outside = document.createElement("button");
    document.body.append(el, outside);
    try {
      run(outside);
    } finally {
      el.remove();
      outside.remove();
    }
  }

  it.each(["inside", "outside"] as const)("haelt beim stillen Wiederanhaengen den Fokus nur, wenn er in der Kachel lag (%s)", (where) => {
    const { el } = setup();
    inDocument(el, (outside) => {
      if (where === "inside") focusInsideTerminal(el);
      else outside.focus();
      lastOpts().onConnectionLost();
      vi.advanceTimersByTime(500);
      expect(mounts()).toBe(2);
      if (where === "inside") {
        // Der frische Kanal derselben Kachel bekommt den Fokus zurueck.
        expect(hoisted.focusSpy).toHaveBeenCalledTimes(1);
        expect(hoisted.focusSpy).toHaveBeenCalledWith("s1");
      } else {
        // Nie genommen: der Fokus bleibt, wo der Nutzer ihn hatte.
        expect(hoisted.focusSpy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(outside);
      }
    });
  });

  it.each(["inside", "outside"] as const)("haelt beim Neumontieren auf einer neuen Verbindung den Fokus nur, wenn er in der Kachel lag (%s)", (where) => {
    const { state, el } = setup();
    inDocument(el, (outside) => {
      if (where === "inside") focusInsideTerminal(el);
      else outside.focus();
      // Wie main.ts den Host neu verbindet (UX-Spec §5.4): Transportverlust,
      // ein Versuch ("connecting"), die neue Laufzeit-ID -- noch waehrend
      // "connecting", der alte Kanal geht dabei schon --, dann "connected",
      // und erst jetzt montiert die Kachel ihr frisches Terminal.
      state.lockInput("h1", "s1");
      state.setHostState("h1", "failed", "transport lost");
      state.setHostState("h1", "connecting");
      state.setRuntimeId("h1", "r-h1-new");
      expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
      expect(mounts()).toBe(1);
      state.setHostState("h1", "connected");
      expect(mounts()).toBe(2);
      if (where === "inside") {
        expect(hoisted.focusSpy).toHaveBeenCalledWith("s1");
      } else {
        expect(hoisted.focusSpy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(outside);
      }
    });
  });

  it("sperrt die Eingabe einer Kachel, die Reconnecting… zeigt, auch ohne Verlustmeldung ihres Kanals", () => {
    const { state } = setup();
    expect(hoisted.inputLockedByMount[0]).toBe(false);
    // Der Host verliert seine Verbindung, bevor der Kanal seinen Verlust meldet.
    state.lockInput("h1", "s1");
    state.setHostState("h1", "failed", "transport lost");
    state.setHostReconnecting("h1", true);
    expect(hoisted.inputLockedByMount[0]).toBe(true);
    // Die neue Verbindung montiert ein frisches Terminal; es nimmt Eingaben an.
    state.setRuntimeId("h1", "r-h1-new");
    state.setHostState("h1", "connected");
    expect(mounts()).toBe(2);
    expect(hoisted.inputLockedByMount[1]).toBe(false);
  });

  it("sperrt die Eingabe einer Kachel mit Sperrleiste, bis ein frisches Terminal kommt", () => {
    const { state, el } = setup();
    state.lockInput("h1", "s1");
    expect(hoisted.inputLockedByMount[0]).toBe(true);
    strip(el).querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.click();
    expect(mounts()).toBe(2);
    expect(hoisted.inputLockedByMount[1]).toBe(false);
  });
});

// Spec 2026-10-19 §8.1 (Schritt 3): hoechstens vier `open_terminal` je Host
// zugleich. Die Schlange lebt in `terminal-open-queue.ts`; das Raster legt eine
// je `mountGrid` an und reicht sie jedem Terminal. Ob ein Terminal auf seinen
// Platz wartet, meldet es selbst (`onQueued`); solange steht "Opening…" im
// ruhigen Chip, die Kachel traegt `tile--opening`, und ihre Eingabe ist
// gesperrt. Schlange und Einreihen pruefen ihre eigenen Tests; hier zaehlt,
// was das Raster aus den Meldungen macht. Der Mock oben meldet das Warten beim
// Bau fuer die Sessions in `hoisted.queuedSessions`, wie das echte
// `mountTerminal` bei voller Schlange, und den Platz teilt der Test ueber die
// mitgeschnittenen Optionen zu. Fuenf Kacheln eines Hosts braucht dieser Block
// nicht: die Schlange steckt im echten `mountTerminal`, und das ist hier
// gemockt.
describe("mountGrid: Oeffnen ueber die Schlange je Host (Spec 2026-10-19 §8.1)", () => {
  interface QueueOptions {
    openQueue: OpenQueue;
    onQueued: (queued: boolean) => void;
    onOpened: () => void;
    onConnectionLost: () => void;
  }

  /** Die Optionen des `mountIndex`-ten Mounts, wie `grid.ts` sie reicht. */
  function optionsOf(mountIndex: number): QueueOptions {
    return hoisted.mountTerminalSpy.mock.calls[mountIndex][4] as QueueOptions;
  }

  /** Was der Kopf der Kachel an `position` zeigt: den Text des ruhigen Chips
   * (`null`, solange er verborgen ist), ob die Kachel `tile--opening` traegt
   * und ob die Sperrleiste steht. */
  function head(el: HTMLElement, position = 0): { quiet: string | null; opening: boolean; strip: boolean } {
    const tile = tilesByPosition(el)[position];
    const quiet = tile.querySelector<HTMLElement>(".tile-quiet")!;
    return {
      quiet: quiet.hidden ? null : quiet.textContent,
      opening: tile.classList.contains("tile--opening"),
      strip: !tile.querySelector<HTMLElement>(".tile-lock")!.hidden,
    };
  }

  /** Die Gegenrichtung zum Bau: dort meldet ein Terminal sein Warten, hier gibt
   * eine entsorgte Kachel ihren Platz frei, und die Schlange teilt ihn einem
   * Wartenden zu (`onQueued(false)`) -- synchron im `dispose()`, also INNERHALB
   * des Neuzeichnens, in `syncViews` oder in `reconcile`. Das Raster darf dort
   * nicht selbst neu zeichnen (`rendering`): das Terminal der Kachel steht dann
   * noch in `view.handle`, ein verschachtelter Durchgang entsorgte es ein
   * zweites Mal und montierte eine neu zu montierende Kachel doppelt.
   *
   * Zwei Kacheln eines Hosts: das Terminal von s1 haelt einen Platz der
   * Schlange, s2 wartet dahinter ("Opening…", Eingabe gesperrt). Entsorgt das
   * Raster das Terminal von s1, teilt der Mock den Platz zu
   * (`hoisted.onDispose`): synchron als `onQueued(false)` an die Optionen von
   * s2, einmal, wie `release()` (ab dem zweiten Mal wirkungslos). Er tut das
   * auch dort, wo das echte Terminal seinen Platz schon zurueckgegeben haette:
   * geprueft wird die Reaktion des Rasters auf eine Zuteilung mitten im
   * Durchgang, nicht die Buchhaltung der Schlange
   * (`terminal-open-queue.test.ts`, `terminal.test.ts`).
   *
   * s2 meldet sein Warten erst nach dem Bau, ausserhalb jedes Neuzeichnens
   * (wie im Test oben). So haengt der Aufbau nicht von dem Fall ab, den die
   * Tests darueber pruefen -- dem Warten beim Bau --, und nur die Zuteilung
   * mitten im Durchgang steht hier zur Probe. */
  function holderAndWaiter(): { state: AppState; el: HTMLElement } {
    const state = stateWithTiles(["s1", "s2"]);
    const el = document.createElement("div");
    mount(el, state);
    optionsOf(1).onQueued(true);
    let granted = false;
    hoisted.onDispose = (session) => {
      if (session !== "s1" || granted) return;
      granted = true;
      optionsOf(1).onQueued(false);
    };
    expect(head(el, 1)).toEqual({ quiet: "Opening…", opening: true, strip: false });
    expect(hoisted.inputLockedByMount).toEqual([false, true]);
    return { state, el };
  }

  it("eine wartende Kachel zeigt Opening… samt tile--opening schon im Durchgang, der sie montiert, und nimmt keine Eingabe an, solange sie wartet (Review Focus 5)", () => {
    hoisted.queuedSessions.add("s2");
    const state = stateWithTiles(["s1", "s2"]);
    state.hosts[0].sessions.forEach((s, i) => {
      s.sessionId = i + 1;
      s.status = "busy";
    });
    const el = document.createElement("div");
    mount(el, state);

    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    expect(head(el, 0)).toEqual({ quiet: null, opening: false, strip: false });
    expect(head(el, 1)).toEqual({ quiet: "Opening…", opening: true, strip: false });
    // Dieselbe Form wie "Reconnecting…": Drehsymbol, der Text in
    // `.tile-chip-text` (Abnahme B4).
    const quiet = tilesByPosition(el)[1].querySelector<HTMLElement>(".tile-quiet")!;
    expect(quiet.querySelector(".ind-connecting")).not.toBeNull();
    expect(quiet.querySelector(".tile-chip-text")!.textContent).toBe("Opening…");
    // Review Focus 5: solange die Kachel wartet, geht keine Eingabe hinaus --
    // das Raster sperrt sie (`setInputLocked` -> `disableStdin`, terminal.ts);
    // die andere bleibt frei.
    expect(hoisted.inputLockedByMount).toEqual([false, true]);
    // Warten ist keine Sperre: am Sessioneintrag aendert sich nichts.
    expect(state.hosts[0].sessions.map((session) => session.inputLocked)).toEqual([false, false]);
    // Wie "Reconnecting…" steht auch "Opening…" allein: die wartende Kachel
    // zeigt keine Agentenpille, die andere schon.
    expect(tilesByPosition(el)[0].querySelector(".tile-agent:not([hidden]) .st.st-busy")).not.toBeNull();
    expect(tilesByPosition(el)[1].querySelector(".tile-agent:not([hidden]) .st")).toBeNull();
  });

  it.each([
    ["onQueued(false)", (options: QueueOptions) => options.onQueued(false)],
    ["onOpened", (options: QueueOptions) => options.onOpened()],
  ] as const)("mit %s geht Opening…, ohne neues Terminal und ohne Refit; die Eingabe ist wieder frei", (_name, grant) => {
    vi.useFakeTimers();
    try {
      hoisted.queuedSessions.add("s1");
      const el = document.createElement("div");
      mount(el, stateWithTiles(["s1"]));
      expect(head(el)).toEqual({ quiet: "Opening…", opening: true, strip: false });
      expect(hoisted.inputLockedByMount).toEqual([true]);

      // Ausserhalb jedes Neuzeichnens, wie das Zuteilen, wenn ein anderes
      // Oeffnen desselben Hosts antwortet.
      grant(optionsOf(0));

      expect(head(el)).toEqual({ quiet: null, opening: false, strip: false });
      expect(hoisted.inputLockedByMount).toEqual([false]);
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
      expect(hoisted.disposeSpy).not.toHaveBeenCalled();
      // Der Chip sitzt im Kopf: sein Kommen und Gehen aendert keine Groesse.
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("meldet ein Terminal sein Warten erst nach dem Bau, zeichnet das Raster neu", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1"]));
    expect(head(el)).toEqual({ quiet: null, opening: false, strip: false });

    optionsOf(0).onQueued(true);

    expect(head(el)).toEqual({ quiet: "Opening…", opening: true, strip: false });
    expect(hoisted.inputLockedByMount).toEqual([true]);
  });

  it("Vorrang: Reconnecting… vor Disconnected vor Opening…; das Warten ueberdauert beide", () => {
    hoisted.queuedSessions.add("s1");
    const state = stateWithTiles(["s1"]);
    const el = document.createElement("div");
    mount(el, state);
    expect(head(el)).toEqual({ quiet: "Opening…", opening: true, strip: false });

    // Gesperrt: die Sperrleiste mit dem Weg zurueck, kein "Opening…".
    state.lockInput("h1", "s1");
    expect(head(el)).toEqual({ quiet: null, opening: false, strip: true });

    // Der Host wird neu verbunden: "Reconnecting…" steht vor der Sperre.
    state.setHostState("h1", "failed", "transport lost");
    state.setHostReconnecting("h1", true);
    expect(head(el)).toEqual({ quiet: "Reconnecting…", opening: false, strip: false });

    state.setHostReconnecting("h1", false);
    expect(head(el)).toEqual({ quiet: null, opening: false, strip: true });

    // Faellt beides weg, wartet das Terminal noch: "Opening…" kommt zurueck.
    state.setHostState("h1", "connected");
    state.applyInputLocks([], ["h1/s1"]);
    expect(head(el)).toEqual({ quiet: "Opening…", opening: true, strip: false });
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
    // Auch wieder wartend nimmt die Kachel keine Eingabe an.
    expect(hoisted.inputLockedByMount).toEqual([true]);
  });

  it("jedes Terminal des Rasters bekommt dieselbe Schlange -- beim Bau, mit Reconnect, beim stillen Wiederanhaengen, auf einer neuen Verbindung --, ein zweites Raster eine eigene", () => {
    vi.useFakeTimers();
    try {
      const state = stateWithTiles(["s1", "s2"]);
      const el = document.createElement("div");
      mount(el, state);
      // Reconnect in der Sperrleiste von s1 (Spec 2026-10-19 §5.8).
      state.lockInput("h1", "s1");
      tilesByPosition(el)[0].querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.click();
      // Stilles Wiederanhaengen von s2 (UX-Spec §5.5): der Kanal geht, nach
      // 500 ms kommt der Versuch.
      optionsOf(1).onConnectionLost();
      vi.advanceTimersByTime(500);
      // Eine neue Verbindung des Hosts montiert beide neu.
      state.setRuntimeId("h1", "r-h1-new");

      const calls = hoisted.mountTerminalSpy.mock.calls;
      expect(calls).toHaveLength(6);
      const queue = optionsOf(0).openQueue;
      expect(typeof queue.enter).toBe("function");
      for (let i = 0; i < calls.length; i++) {
        expect(optionsOf(i).openQueue, `Mount ${i}`).toBe(queue);
        expect(typeof optionsOf(i).onQueued, `Mount ${i}`).toBe("function");
      }

      // Eine Schlange je Raster: ein zweites zaehlt fuer sich.
      mount(document.createElement("div"), stateWithTiles(["s1"]));
      expect(optionsOf(6).openQueue).not.toBe(queue);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("eine neue Verbindung entsorgt die wartende Kachel samt ihrem Warten; das frische Terminal wartet nur, wenn es das selbst meldet (Review Focus 2)", () => {
    hoisted.queuedSessions.add("s1");
    const state = stateWithTiles(["s1"]);
    const el = document.createElement("div");
    mount(el, state);
    expect(head(el).opening).toBe(true);

    hoisted.queuedSessions.delete("s1");
    state.setRuntimeId("h1", "r-h1-new");

    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    expect(hoisted.mountTerminalSpy.mock.calls[1][1]).toBe("r-h1-new");
    // Schon im selben Durchgang: kein "Opening…" vom entsorgten Terminal.
    expect(head(el)).toEqual({ quiet: null, opening: false, strip: false });
    expect(hoisted.inputLockedByMount).toEqual([true, false]);
  });

  it("ein Zuteilen fuer das entsorgte Terminal trifft die Kachel nicht mehr; nach dem Neuverbinden reiht sich das frische selbst ein (Review Focus 2)", () => {
    hoisted.queuedSessions.add("s1");
    const state = stateWithTiles(["s1"]);
    const el = document.createElement("div");
    mount(el, state);
    expect(head(el).opening).toBe(true);

    // Wie main.ts den Host neu verbindet (UX-Spec §5.4): Transportverlust samt
    // Sperre, ein Versuch, die neue Laufzeit-ID noch waehrend "connecting" --
    // der wartende Handle geht dabei --, dann "connected".
    state.lockInput("h1", "s1");
    state.setHostState("h1", "failed", "transport lost");
    state.setHostState("h1", "connecting");
    state.setRuntimeId("h1", "r-h1-new");
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(head(el)).toEqual({ quiet: null, opening: false, strip: true });
    state.setHostState("h1", "connected");
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    expect(optionsOf(1).openQueue).toBe(optionsOf(0).openQueue);
    expect(head(el)).toEqual({ quiet: "Opening…", opening: true, strip: false });

    // Kaeme fuer das entsorgte Terminal doch noch ein Platz, aendert das an der
    // Kachel nichts.
    optionsOf(0).onQueued(false);
    expect(head(el).opening).toBe(true);
    expect(hoisted.inputLockedByMount[1]).toBe(true);

    optionsOf(1).onQueued(false);
    expect(head(el)).toEqual({ quiet: null, opening: false, strip: false });
    expect(hoisted.inputLockedByMount[1]).toBe(false);
  });

  it("schliesst der Nutzer die Kachel, die einen Platz haelt, ist die wartende im selben Durchgang frei, und die geschlossene wird genau einmal entsorgt (syncViews)", () => {
    const { state, el } = holderAndWaiter();

    // `syncViews` entsorgt die Kachel; ihr Terminal gibt dabei den Platz frei,
    // und die wartende Nachbarin erfaehrt es mitten im Durchgang.
    state.closeTile(state.tiles[0].id);

    // Genau einmal: zeichnete das Raster in `setQueued` mitten in `syncViews`
    // neu, fande es die Kachel noch in `views` und entsorgte sie ein zweites Mal.
    expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    // Die Nachbarin steht jetzt an Position 0 und wartet nicht mehr: kein
    // Opening…, keine Sperre -- schon im Durchgang, der die Kachel schloss. Die
    // Koepfe, die `render` nach `syncViews` berechnet, sehen die Zuteilung.
    expect(tilesByPosition(el)).toHaveLength(1);
    expect(head(el)).toEqual({ quiet: null, opening: false, strip: false });
    expect(hoisted.inputLockedByMount[1]).toBe(false);
  });

  it("haengt sich die Kachel, die einen Platz haelt, still neu an, ist die wartende im selben Durchgang frei, und nichts wird doppelt entsorgt oder montiert (reconcile)", () => {
    vi.useFakeTimers();
    try {
      const { el } = holderAndWaiter();

      // Stilles Wiederanhaengen von s1 (UX-Spec §5.5): der Kanal geht, nach
      // 500 ms kommt der Versuch, und `attemptReattach` zeichnet genau einmal.
      // In diesem Durchgang entsorgt `reconcile` das alte Terminal und montiert
      // in derselben Kachel ein frisches. Das alte gibt dabei den Platz frei;
      // s2 (derselbe Host, bleibt montiert) erfaehrt es mitten im Abgleich,
      // nachdem ihr Kopf schon berechnet war. (Der Knopf "Reconnect" taugte
      // dafuer nicht: `requestReconnect` zeichnet danach noch einmal und holte
      // einen fehlenden Nachzug des Kopfes unbemerkt nach.)
      optionsOf(0).onConnectionLost();
      vi.advanceTimersByTime(500);

      // Genau ein Terminal entsorgt, genau eines neu montiert. Zeichnete das
      // Raster in `setQueued` mitten in `reconcile` neu, stuende das alte
      // Terminal noch in `view.handle`: es wuerde ein zweites Mal entsorgt, und
      // s1 bekaeme vom verschachtelten Durchgang ein frisches Terminal und vom
      // aeusseren gleich noch eines.
      expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
      expect(hoisted.mountTerminalSpy.mock.calls.map((call) => call[2])).toEqual(["s1", "s2", "s1"]);
      expect(head(el, 0)).toEqual({ quiet: "Reconnecting…", opening: false, strip: false });
      // s2 wartet nicht mehr: `render` zieht ihren Kopf nach dem Abgleich nach
      // und gibt ihre Eingabe frei -- im selben Durchgang, kein spaeteres
      // Neuzeichnen holt das nach.
      expect(head(el, 1)).toEqual({ quiet: null, opening: false, strip: false });
      expect(hoisted.inputLockedByMount[1]).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // Review Focus 3 am Raster: Maximieren einer anderen Kachel verbirgt eine
  // wartende, ohne ihr Terminal zu entsorgen. Sie behaelt ihren Platz in der
  // Schlange und bekommt ihn auch verborgen zugeteilt (`onQueued(false)`,
  // ausserhalb jedes Neuzeichnens). Ihr Kopf folgt sofort, gemessen wird dabei
  // nicht, und das Zurueckholen kostet genau einen Refit. Mit welcher Groesse
  // das Terminal dann oeffnet und dass danach hoechstens ein `resize_terminal`
  // hinausgeht, pinnt `terminal.test.ts` (Block "verborgene Kachel").
  it("eine wartende Kachel, die verborgen wird, verliert Opening… mit der Zuteilung, ohne zu messen; nach dem Zurueckholen refittet sie genau einmal (Review Focus 3)", () => {
    vi.useFakeTimers();
    try {
      hoisted.queuedSessions.add("s2");
      const state = stateWithTiles(["s1", "s2"]);
      const el = document.createElement("div");
      mount(el, state);
      expect(head(el, 1)).toEqual({ quiet: "Opening…", opening: true, strip: false });
      expect(hoisted.inputLockedByMount).toEqual([false, true]);
      vi.advanceTimersByTime(300);
      hoisted.fitSpy.mockClear();
      hoisted.setHiddenSpy.mockClear();

      // s1 maximiert, s2 verborgen: sie wartet weiter, mit Terminal.
      state.toggleMaximize(state.tiles[0].id);
      expect(hoisted.setHiddenSpy).toHaveBeenCalledWith("s2", true);
      expect(tilesByPosition(el)[1].style.display).toBe("none");
      expect(head(el, 1)).toEqual({ quiet: "Opening…", opening: true, strip: false });
      expect(hoisted.inputLockedByMount[1]).toBe(true);

      // Der Platz wird frei, etwa weil ein anderes Oeffnen desselben Hosts
      // antwortet: der Kopf der verborgenen Kachel folgt, ihre Eingabe ist frei.
      optionsOf(1).onQueued(false);
      expect(head(el, 1)).toEqual({ quiet: null, opening: false, strip: false });
      expect(hoisted.inputLockedByMount).toEqual([false, false]);
      // Gemessen wird weder dabei noch danach: nur die maximierte refittet.
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy.mock.calls).toEqual([["s1"]]);

      // Zurueckholen: genau ein Refit fuer s2, ohne zu montieren oder zu entsorgen.
      hoisted.fitSpy.mockClear();
      hoisted.setHiddenSpy.mockClear();
      state.toggleMaximize(state.tiles[0].id);
      expect(hoisted.setHiddenSpy).toHaveBeenCalledWith("s2", false);
      expect(hoisted.setHiddenSpy).not.toHaveBeenCalledWith(expect.anything(), true);
      expect(tilesByPosition(el)[1].style.display).toBe("");
      vi.advanceTimersByTime(300);
      expect(hoisted.fitSpy.mock.calls.filter(([name]) => name === "s2")).toEqual([["s2"]]);
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
      expect(hoisted.disposeSpy).not.toHaveBeenCalled();
      expect(head(el, 1)).toEqual({ quiet: null, opening: false, strip: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

// UX-Spec §6.1: nach jedem Kopieren zeigt der Kachelkopf 1200 ms lang den
// Chip "Copied". Der Chip ist die Live-Region selbst und bleibt dauerhaft im
// Baum; nur sein Inhalt kommt und geht -- ein eben erst eingeblendeter
// aria-live-Knoten wird nicht zuverlaessig vorgelesen (siehe `announce`).
describe("mountGrid: Chip Copied im Kachelkopf (UX-Spec §6.1)", () => {
  function mountWithSession(): { el: HTMLElement; handle: GridHandle; state: AppState } {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2"]);
    state.openSession("h1", "s1"); // Kachel 0
    const el = document.createElement("div");
    const handle = mount(el, state);
    return { el, handle, state };
  }

  function lastMountOptions(): { onCopied: () => void } {
    const calls = hoisted.mountTerminalSpy.mock.calls;
    return calls[calls.length - 1][4] as { onCopied: () => void };
  }

  function copiedChip(el: HTMLElement): HTMLElement {
    const chip = tilesByPosition(el)[0]?.querySelector<HTMLElement>(".tile-head .tile-copied");
    if (!chip) throw new Error("Chip fehlt");
    return chip;
  }

  it("zeigt nach onCopied den Chip mit Haekchen und leert ihn nach 1200 ms", () => {
    vi.useFakeTimers();
    try {
      const { el } = mountWithSession();
      const chip = copiedChip(el);
      expect(chip.getAttribute("aria-live")).toBe("polite");
      expect(chip.hidden).toBe(false);
      expect(chip.textContent).toBe("");

      lastMountOptions().onCopied();
      expect(chip.textContent).toBe("Copied");
      expect(chip.querySelector('[data-icon="check"]')).not.toBeNull();

      vi.advanceTimersByTime(1199);
      expect(chip.textContent).toBe("Copied");
      vi.advanceTimersByTime(1);
      expect(chip.childNodes).toHaveLength(0);
      expect(chip.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ein zweites Kopieren verlaengert die Anzeige", () => {
    vi.useFakeTimers();
    try {
      const { el } = mountWithSession();
      const chip = copiedChip(el);
      const { onCopied } = lastMountOptions();

      onCopied();
      vi.advanceTimersByTime(600);
      onCopied();
      vi.advanceTimersByTime(800);
      expect(chip.textContent).toBe("Copied");
      vi.advanceTimersByTime(400);
      expect(chip.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leert den Chip, wenn die Kachel ihr Terminal entsorgt", () => {
    vi.useFakeTimers();
    try {
      const { el, state } = mountWithSession();
      lastMountOptions().onCopied();
      expect(copiedChip(el).textContent).toBe("Copied");

      // Eine neue Verbindung des Hosts: das Terminal geht, ein frisches kommt
      // (Maximieren entsorgt seit Spec 2026-10-19 §8.1 nichts mehr).
      state.setRuntimeId("h1", "r-h1-new");
      expect(hoisted.disposeSpy).toHaveBeenCalledTimes(1);
      expect(copiedChip(el).textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("raeumt den Timer beim Entsorgen des Rasters ab", () => {
    vi.useFakeTimers();
    try {
      const { handle } = mountWithSession();
      lastMountOptions().onCopied();
      expect(vi.getTimerCount()).toBe(1);

      handle.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Spec 2026-10-19 §8.4: unter 80 Spalten oder 20 Zeilen nach dem Fit sagt der
// Kachelkopf "{cols}×{rows} · narrow". Die Zahlen meldet das Terminal
// (`onSize`); die Kachel verkleinert nie selbst und schliesst nichts.
describe("mountGrid: schmale Kachel (Spec 2026-10-19 §8.4)", () => {
  /** Die Groessenmeldung des `mountIndex`-ten Mounts, wie `terminal.ts` sie
   * nach jedem Fit ruft. */
  function reportSize(cols: number, rows: number, mountIndex = 0): void {
    const options = hoisted.mountTerminalSpy.mock.calls[mountIndex][4] as { onSize: (c: number, r: number) => void };
    options.onSize(cols, rows);
  }

  it("zeigt unter 80 Spalten oder 20 Zeilen den Chip, sonst nicht", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1"]));
    const chip = el.querySelector<HTMLElement>(".tile-narrow")!;
    reportSize(120, 40);
    expect(chip.hidden).toBe(true);
    reportSize(70, 30);
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("70×30 · narrow");
    reportSize(100, 19);
    expect(chip.textContent).toBe("100×19 · narrow");
    reportSize(80, 20);
    expect(chip.hidden).toBe(true);
  });

  it("die Grenze liegt genau bei 80 Spalten und 20 Zeilen", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1"]));
    const chip = el.querySelector<HTMLElement>(".tile-narrow")!;
    reportSize(79, 24);
    expect(chip.textContent).toBe("79×24 · narrow");
    reportSize(80, 24);
    expect(chip.hidden).toBe(true);
    reportSize(100, 19);
    expect(chip.textContent).toBe("100×19 · narrow");
    reportSize(100, 20);
    expect(chip.hidden).toBe(true);
  });

  // Optik-Runde vom 24.10.: in einer schmalen Kachel zeigt der Chip nur die
  // Groesse (styles.css); der ganze Satz steht im Tooltip.
  it("traegt Groesse und Rest des Satzes in eigenen Teilen, den ganzen Satz im Tooltip", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1"]));
    const chip = el.querySelector<HTMLElement>(".tile-narrow")!;
    reportSize(62, 13);
    expect(chip.querySelector(".tile-narrow-size")?.textContent).toBe("62×13");
    expect(chip.querySelector(".tile-narrow-rest")?.textContent).toBe(" · narrow");
    expect(chip.title).toBe("62×13 · narrow");
    reportSize(120, 40);
    expect(chip.hasAttribute("title")).toBe(false);
    expect(chip.textContent).toBe("");
  });

  it("bleibt ohne Meldung verborgen, etwa in einer Kachel ohne Terminal", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1", null));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    const el = document.createElement("div");
    mount(el, state);
    // Ohne Laufzeit-ID gibt es kein Terminal und damit nie eine Meldung; ein
    // leerer, sichtbarer Chip nahme im Kopf trotzdem Luecke und Platz.
    expect(hoisted.mountTerminalSpy).not.toHaveBeenCalled();
    const chip = el.querySelector<HTMLElement>(".tile-head .tile-narrow")!;
    expect(chip.hidden).toBe(true);
    expect(chip.textContent).toBe("");
  });

  it("jede Kachel zeigt ihre eigene Groesse", () => {
    const el = document.createElement("div");
    mount(el, stateWithTiles(["s1", "s2"]));
    const [first, second] = tilesByPosition(el).map((tile) => tile.querySelector<HTMLElement>(".tile-head .tile-narrow")!);
    reportSize(70, 30, 1);
    expect(first.hidden).toBe(true);
    expect(second.textContent).toBe("70×30 · narrow");
    reportSize(60, 15, 0);
    expect(first.textContent).toBe("60×15 · narrow");
    expect(second.textContent).toBe("70×30 · narrow");
  });

  it("der Bericht einer geschlossenen Kachel aendert nichts mehr", () => {
    const el = document.createElement("div");
    const state = stateWithTiles(["s1", "s2"]);
    mount(el, state);
    const chip = tilesByPosition(el)[1].querySelector<HTMLElement>(".tile-narrow")!;
    reportSize(70, 30, 1);
    expect(chip.textContent).toBe("70×30 · narrow");

    state.closeTile(state.tiles[1].id);
    expect(el.contains(chip)).toBe(false);
    // Ein Refit-Zeitgeber kann nach dem Schliessen noch eine Groesse melden.
    reportSize(120, 40, 1);
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("70×30 · narrow");
  });
});

// Abnahme B4: in einer schmalen Kachel geben die Kopfchips zuletzt nach, mit
// Ellipse. `text-overflow` wirkt aber nur in einem Blockcontainer; ein Text
// direkt im Flex-Chip waere ein anonymes Element und wuerde nur abgeschnitten.
// Deshalb steht jeder Chiptext in `.tile-chip-text` (styles.css kuerzt dort).
describe("mountGrid: Kopfchips kuerzen ihren Text (Abnahme B4)", () => {
  it("Groesse, Copied, Reconnecting und Disconnected stehen je in .tile-chip-text", () => {
    const state = stateWithTiles(["s1"]);
    const el = document.createElement("div");
    mount(el, state);
    const head = tilesByPosition(el)[0].querySelector<HTMLElement>(".tile-head")!;
    const options = hoisted.mountTerminalSpy.mock.calls[0][4] as {
      onSize: (cols: number, rows: number) => void;
      onCopied: () => void;
    };
    options.onSize(70, 30);
    options.onCopied();
    state.lockInput("h1", "s1");

    const text = (chip: string) => head.querySelector<HTMLElement>(`${chip} > .tile-chip-text`)?.textContent;
    expect(text(".tile-narrow")).toBe("70×30 · narrow");
    expect(text(".tile-copied")).toBe("Copied");
    expect(text(".tile-quiet")).toBe("Reconnecting…");
    expect(text(".tile-lock-chip")).toBe("Disconnected");

    // Wieder breit genug: der Chip verschwindet samt Text.
    options.onSize(120, 40);
    expect(head.querySelector<HTMLElement>(".tile-narrow")!.hidden).toBe(true);
    expect(head.querySelector<HTMLElement>(".tile-narrow")!.textContent).toBe("");
  });
});

// UX-Spec §6.9, §10: jeder Fehlerpfad des Terminals hat seinen eigenen Text.
// `terminal.ts` meldet die Art und den Rohtext; den Text waehlt diese Ansicht,
// der Rohtext geht nur in "Copy details" am Banner.
describe("mountGrid: Fehlertexte des Terminals je Art (UX-Spec §6.9, §10)", () => {
  function mountWithError() {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["build"]);
    state.openSession("h1", "build");
    const onTerminalError = vi.fn();
    mount(document.createElement("div"), state, { onTerminalError });
    const calls = hoisted.mountTerminalSpy.mock.calls;
    return { onTerminalError, onError: calls[calls.length - 1][3] as (error: TerminalError) => void };
  }

  it.each([
    ["open", "Couldn't open 'build'. It may have ended on the host — reload sessions and try again."],
    ["copy", "Couldn't copy to the clipboard."],
    ["paste", "Couldn't read the clipboard."],
    ["input", "Your typing didn't reach 'build'. Reconnect the terminal."],
    ["resize", "Couldn't resize 'build' on the host. The layout may look off until the next resize."],
  ] as const)("Art %s: eigener Text, der Rohtext nur als Detail", (kind, text) => {
    const { onTerminalError, onError } = mountWithError();
    onError({ kind, detail: "raw backend text" });
    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(text, "raw backend text");
  });

  it("ein Kopierfehler zeigt nicht mehr den Text fuers Oeffnen", () => {
    const { onTerminalError, onError } = mountWithError();
    onError({ kind: "copy", detail: "NotAllowedError: Document is not focused." });
    const [text] = onTerminalError.mock.calls[0] as [string, string];
    expect(text).not.toContain("Couldn't open");
    expect(text).toBe("Couldn't copy to the clipboard.");
  });
});

describe("mountGrid: Kanalgrenze beim Oeffnen (Spec 2026-10-19 §8.3)", () => {
  it("erkennt die vier Rohtexte der Kanalgrenzen und sonst nichts", () => {
    for (const detail of [
      "too many terminal setups are already pending for this host",
      "too many terminal output tasks are still closing",
      "The SSH command failed (admission, capacity).",
      "Terminal operation failed during Admission: Capacity",
    ]) {
      expect(isCapacityError(detail), detail).toBe(true);
    }
    expect(isCapacityError("Terminal operation failed during Admission: Unavailable")).toBe(false);
    expect(isCapacityError("no terminal open for this session")).toBe(false);
  });

  it("erkennt den Rohtext auch mit Text davor", () => {
    // Das Backend stellt dem Satz einer Befehlsstoerung mitunter einen Hinweis voran.
    expect(
      isCapacityError("The remote operation may have taken effect. Refresh before trying again. The SSH command failed (admission, capacity)."),
    ).toBe(true);
  });

  it("ein Fehler anderer Art mit dem Kapazitaetstext bleibt ein Fehler dieser Art und geht nicht verloren", () => {
    const onTerminalError = vi.fn();
    const onTerminalCapacity = vi.fn();
    mount(document.createElement("div"), stateWithTiles(["s1"]), { onTerminalError, onTerminalCapacity });
    const onError = hoisted.mountTerminalSpy.mock.calls[0][3] as (error: { kind: string; detail: string }) => void;
    const detail = "Terminal operation failed during Admission: Capacity";
    onError({ kind: "input", detail });
    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith("Your typing didn't reach 's1'. Reconnect the terminal.", detail);
    expect(onTerminalCapacity).not.toHaveBeenCalled();
  });

  it("meldet eine Kanalgrenze als eigenen Fall, ohne Banner fuers Oeffnen und ohne Sperre", () => {
    const onTerminalError = vi.fn();
    const onTerminalOpenFailed = vi.fn();
    const onTerminalCapacity = vi.fn();
    mount(document.createElement("div"), stateWithTiles(["s1"]), { onTerminalError, onTerminalOpenFailed, onTerminalCapacity });
    const [, , , onError, options] = hoisted.mountTerminalSpy.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      (error: { kind: string; detail: string }) => void,
      { onOpenFailed: () => void },
    ];
    const detail = "Terminal operation failed during Admission: Capacity";
    onError({ kind: "open", detail });
    options.onOpenFailed();
    expect(onTerminalCapacity).toHaveBeenCalledExactlyOnceWith("h1", "s1", detail, "app");
    expect(onTerminalError).not.toHaveBeenCalled();
    expect(onTerminalOpenFailed).not.toHaveBeenCalled();
  });

  it("ein anderer Fehler beim Oeffnen bleibt beim bisherigen Weg", () => {
    const onTerminalError = vi.fn();
    const onTerminalOpenFailed = vi.fn();
    const onTerminalCapacity = vi.fn();
    mount(document.createElement("div"), stateWithTiles(["s1"]), { onTerminalError, onTerminalOpenFailed, onTerminalCapacity });
    const [, , , onError, options] = hoisted.mountTerminalSpy.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      (error: { kind: string; detail: string }) => void,
      { onOpenFailed: () => void },
    ];
    onError({ kind: "open", detail: "invalid session name" });
    options.onOpenFailed();
    expect(onTerminalCapacity).not.toHaveBeenCalled();
    expect(onTerminalError).toHaveBeenCalledTimes(1);
    expect(onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
  });

  /** Wie nach dem Neustart: die Liste meldet die tote Pane schon als beendet,
   * und die wiederhergestellte Kachel montiert mit diesem Status. */
  function endedTile() {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessionRecords("h1", [{ name: "s1", status: "ended", statusReason: "the session's pane is dead" }]);
    state.openSession("h1", "s1");
    const onTerminalError = vi.fn();
    const onTerminalCapacity = vi.fn();
    // Wie main.ts: ein abgelehntes Oeffnen sperrt die Eingabe.
    const onTerminalOpenFailed = vi.fn((hostId: string, name: string) => state.lockInput(hostId, name));
    const el = document.createElement("div");
    mount(el, state, { onTerminalError, onTerminalOpenFailed, onTerminalCapacity });
    const [, , , onError, options] = hoisted.mountTerminalSpy.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      (error: { kind: string; detail: string }) => void,
      { onOpenFailed: () => void; onOpened: () => void },
    ];
    return { el, onTerminalError, onTerminalCapacity, onTerminalOpenFailed, onError, options };
  }

  it("eine beendete Session nennt ihr gescheitertes Oeffnen nur in der Sperrleiste (M1-Tor, Schritt 8)", () => {
    const { el, onTerminalError, onTerminalCapacity, onTerminalOpenFailed, onError, options } = endedTile();
    onError({ kind: "open", detail: "Terminal operation failed during Admission: Capacity" });
    options.onOpenFailed();
    expect(onTerminalError).not.toHaveBeenCalled();
    expect(onTerminalCapacity).not.toHaveBeenCalled();
    expect(onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
    const strip = el.querySelector<HTMLElement>(".tile-lock")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain("This session has ended on the host.");
    expect(strip.querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.hidden).toBe(true);
  });

  it("haengt eine als beendet gemeldete Session doch an, melden ihre Fehler wieder ein Banner", () => {
    const { onTerminalError, onError, options } = endedTile();
    options.onOpened();
    onError({ kind: "input", detail: "send_input failed" });
    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(
      "Your typing didn't reach 's1'. Reconnect the terminal.",
      "send_input failed",
    );
  });

  it("eine Kachel, die schon einen Kanal hatte, bleibt nach Reconnect mit Sperrleiste; der Satz steht im Banner (Spec §1 Nr. 1, §5.8)", () => {
    const onTerminalError = vi.fn();
    const onTerminalCapacity = vi.fn();
    const state = stateWithTiles(["s1"]);
    // Wie main.ts: ein abgelehntes Oeffnen sperrt die Eingabe.
    const onTerminalOpenFailed = vi.fn((hostId: string, name: string) => state.lockInput(hostId, name));
    const el = document.createElement("div");
    mount(el, state, { onTerminalError, onTerminalOpenFailed, onTerminalCapacity });
    // Das erste Oeffnen gelingt: die Kachel hat einen Kanal.
    (hoisted.mountTerminalSpy.mock.calls[0][4] as { onOpened: () => void }).onOpened();
    state.lockInput("h1", "s1");
    el.querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.click();
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    const [, , , onError, options] = hoisted.mountTerminalSpy.mock.calls[1] as [
      unknown,
      unknown,
      unknown,
      (error: { kind: string; detail: string }) => void,
      { onOpenFailed: () => void },
    ];
    const detail = "Terminal operation failed during Admission: Capacity";
    onError({ kind: "open", detail });
    options.onOpenFailed();
    expect(onTerminalCapacity).not.toHaveBeenCalled();
    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(
      "vm-1 has no free terminal channel right now. Close a terminal and try again.",
      detail,
    );
    expect(onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s1"]);
    expect(el.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(false);
  });

  /** Fehlerkanal und Optionen des `index`-ten Mounts: was `terminal.ts` nach
   * einem abgelehnten `open_terminal` ruft (erst `onError`, dann `onOpenFailed`). */
  function openCall(index: number): {
    onError: (error: { kind: string; detail: string }) => void;
    options: { onOpenFailed: () => void };
  } {
    const call = hoisted.mountTerminalSpy.mock.calls[index];
    return { onError: call[3], options: call[4] };
  }

  // Zurueckholen nach dem Maximieren oeffnet seit Spec 2026-10-19 §8.1 nichts
  // mehr. Ein neues `open_terminal` ohne Sperre und ohne Reconnect-Druck in
  // einer Kachel, die schon einen Kanal hatte, bringt das Ersetzen (§5.2).
  it("eine Kachel, die schon einen Kanal hatte, bleibt auch nach dem Ersetzen per Strg+Klick (Spec §1 Nr. 1, §5.2, §8.3)", () => {
    // Ohne Reconnect-Druck: nur der gelungene erste Kanal haelt die Kachel.
    const onTerminalError = vi.fn();
    const onTerminalCapacity = vi.fn();
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2", "s3"]);
    state.openSession("h1", "s1");
    state.openSession("h1", "s2");
    const onTerminalOpenFailed = vi.fn((hostId: string, name: string) => state.lockInput(hostId, name));
    const el = document.createElement("div");
    mount(el, state, { onTerminalError, onTerminalOpenFailed, onTerminalCapacity });
    (hoisted.mountTerminalSpy.mock.calls[0][4] as { onOpened: () => void }).onOpened();
    // Strg+Klick auf s3, waehrend s1 fokussiert ist: s3 kommt in deren Kachel.
    state.focusTile(state.tiles[0].id);
    state.replaceFocusedTile("h1", "s3");
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(3);
    expect(hoisted.mountTerminalSpy.mock.calls[2][2]).toBe("s3");
    const detail = "Terminal operation failed during Admission: Capacity";
    const replaced = openCall(2);
    replaced.onError({ kind: "open", detail });
    replaced.options.onOpenFailed();
    expect(onTerminalCapacity).not.toHaveBeenCalled();
    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(
      "vm-1 has no free terminal channel right now. Close a terminal and try again.",
      detail,
    );
    expect(onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s3", "app");
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s3", "h1/s2"]);
  });

  describe("eine gesperrte Kachel ohne je einen Kanal bleibt an einer Kanalgrenze (Spec 2026-10-19 §1 Nr. 1, §8.3)", () => {
    const detail = "Terminal operation failed during Admission: Capacity";
    const sentence = "vm-1 has no free terminal channel right now. Close a terminal and try again.";

    /** Eine Kachel, deren erstes Oeffnen NICHT an einer Kanalgrenze scheiterte:
     * sie hatte nie einen Kanal und steht mit Sperrleiste und "Reconnect" da. */
    function lockedWithoutChannel() {
      const onTerminalError = vi.fn();
      const onTerminalCapacity = vi.fn();
      const onReconnectHost = vi.fn();
      const state = stateWithTiles(["s1"]);
      // Wie main.ts: ein abgelehntes Oeffnen sperrt die Eingabe.
      const onTerminalOpenFailed = vi.fn((hostId: string, name: string) => state.lockInput(hostId, name));
      const el = document.createElement("div");
      mount(el, state, { onTerminalError, onTerminalOpenFailed, onTerminalCapacity, onReconnectHost });
      const first = openCall(0);
      first.onError({ kind: "open", detail: "invalid session name" });
      first.options.onOpenFailed();
      expect(el.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(false);
      onTerminalError.mockClear();
      onTerminalOpenFailed.mockClear();
      return { state, el, onTerminalError, onTerminalCapacity, onTerminalOpenFailed, onReconnectHost };
    }

    it("nach Reconnect: Sperrleiste bleibt, der Satz steht im Banner", () => {
      const { state, el, onTerminalError, onTerminalCapacity, onTerminalOpenFailed } = lockedWithoutChannel();
      el.querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.click();
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
      const second = openCall(1);
      second.onError({ kind: "open", detail });
      second.options.onOpenFailed();
      expect(onTerminalCapacity).not.toHaveBeenCalled();
      expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(sentence, detail);
      expect(onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
      expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s1"]);
      expect(el.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(false);
    });

    it("nach Reconnect, das zuerst den ausgefallenen Host neu verbindet", () => {
      const { state, el, onTerminalError, onTerminalCapacity, onTerminalOpenFailed, onReconnectHost } = lockedWithoutChannel();
      state.setHostState("h1", "failed", "transport lost");
      el.querySelector<HTMLButtonElement>(".tile-lock-reconnect")!.click();
      expect(onReconnectHost).toHaveBeenCalledExactlyOnceWith("h1");
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(1);
      // Wie main.ts den Host neu verbindet (UX-Spec §5.4): ein Versuch, die neue
      // Laufzeit-ID, verbunden -- erst jetzt montiert die Kachel ein frisches Terminal.
      state.setHostState("h1", "connecting");
      state.setRuntimeId("h1", "r-h1-new");
      state.setHostState("h1", "connected");
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
      const second = openCall(1);
      second.onError({ kind: "open", detail });
      second.options.onOpenFailed();
      expect(onTerminalCapacity).not.toHaveBeenCalled();
      expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(sentence, detail);
      expect(onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
      expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s1"]);
      expect(el.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(false);
    });

    it("ohne Druck, wenn sich der ausgefallene Host von selbst neu verbindet", () => {
      const { state, el, onTerminalError, onTerminalCapacity, onTerminalOpenFailed, onReconnectHost } = lockedWithoutChannel();
      // Niemand drueckt "Reconnect": die Kachel zeigt die Sperrleiste, und der Host
      // verbindet sich selbst neu (UX-Spec §5.4). Beim Montieren des frischen
      // Terminals ist sie noch gesperrt -- sie bietet den Weg zurueck schon an.
      state.setHostState("h1", "failed", "transport lost");
      state.setHostState("h1", "connecting");
      state.setRuntimeId("h1", "r-h1-new");
      state.setHostState("h1", "connected");
      expect(onReconnectHost).not.toHaveBeenCalled();
      expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
      const second = openCall(1);
      second.onError({ kind: "open", detail });
      second.options.onOpenFailed();
      expect(onTerminalCapacity).not.toHaveBeenCalled();
      expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(sentence, detail);
      expect(onTerminalOpenFailed).toHaveBeenCalledExactlyOnceWith("h1", "s1", "app");
      expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/s1"]);
      expect(el.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(false);
    });
  });
});

// UX-Spec §6.3: `terminal.ts` kennt `en.json` nicht -- Beschriftungen und
// Kuerzel des Terminalmenues kommen aus dieser Ansicht.
describe("mountGrid: Texte fuer das Terminalmenue (UX-Spec §6.3)", () => {
  interface MenuMountOptions {
    menuTexts: {
      items: Record<"copy" | "paste" | "selectAll" | "find", { label: string; shortcut?: string }>;
      fixedShortcuts: { copy: string; paste: string };
      mouseHint: string;
    };
  }

  function mountedOptions(): MenuMountOptions {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    mount(document.createElement("div"), state);
    const calls = hoisted.mountTerminalSpy.mock.calls;
    return calls[calls.length - 1][4] as MenuMountOptions;
  }

  it("reicht die Beschriftungen der vier Eintraege und die Hinweiszeile an das Terminal", () => {
    const { items, mouseHint } = mountedOptions().menuTexts;

    expect(items.copy.label).toBe("Copy");
    expect(items.paste.label).toBe("Paste");
    expect(items.selectAll.label).toBe("Select all");
    expect(items.find.label).toBe("Find…");
    expect(mouseHint).toBe("Shift+drag selects text while a program uses the mouse");
  });

  it("nennt Strg+C und Strg+V als feste Tasten und Suchen aus der Kuerzeltabelle", () => {
    const { items } = mountedOptions().menuTexts;

    expect(items.copy.shortcut).toBe("Ctrl+C");
    expect(items.paste.shortcut).toBe("Ctrl+V");
    expect(items.selectAll.shortcut).toBeUndefined();
    expect(items.find.shortcut).toBe(DEFAULT_KEYMAP["search.local"]);
    expect(items.find.shortcut).toBe("Ctrl+Shift+F");
  });

  it("reicht die festen Tasten mit, die gelten, solange Strg+C/V abgeschaltet ist", () => {
    // Beide Fassungen kommen von hier: terminal.ts liest keine Kuerzeltabelle.
    const { fixedShortcuts } = mountedOptions().menuTexts;

    expect(fixedShortcuts).toEqual({ copy: "Ctrl+Shift+C", paste: "Ctrl+Shift+V" });
  });
});

// UX-Spec §6.5, §6.6: `terminal.ts` kennt `en.json` nicht -- Platzhalter,
// Zaehler, Namen der Knoepfe der Suchleiste und der Tooltip ueber einem Link
// kommen aus dieser Ansicht.
describe("mountGrid: Texte fuer Suchleiste und Links (UX-Spec §6.5, §6.6)", () => {
  interface SearchMountOptions {
    searchTexts: {
      placeholder: string;
      count(current: number, total: number): string;
      none: string;
      prev: string;
      next: string;
      matchCase: string;
      close: string;
    };
    linkHint: string;
    linkConfirmTexts: { open: string; note: string };
  }

  function mountedOptions(): SearchMountOptions {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    state.openSession("h1", "s1");
    mount(document.createElement("div"), state);
    const calls = hoisted.mountTerminalSpy.mock.calls;
    return calls[calls.length - 1][4] as SearchMountOptions;
  }

  it("reicht den Platzhalter Find und die Namen der vier Knoepfe an das Terminal", () => {
    const { searchTexts } = mountedOptions();

    expect(searchTexts.placeholder).toBe("Find");
    expect(searchTexts.prev).toBe("Previous match");
    expect(searchTexts.next).toBe("Next match");
    expect(searchTexts.matchCase).toBe("Match case");
    expect(searchTexts.close).toBe("Close");
  });

  it("formt den Zaehler aus der Vorlage {current}/{total} und sagt No results", () => {
    const { searchTexts } = mountedOptions();

    expect(searchTexts.count(3, 17)).toBe("3/17");
    expect(searchTexts.count(1, 1)).toBe("1/1");
    expect(searchTexts.none).toBe("No results");
  });

  it("reicht den Tooltip ueber einem Link", () => {
    expect(mountedOptions().linkHint).toBe("Ctrl+click to open");
  });

  it("reicht die Texte der Rueckfrage vor einem Link, dessen Text nicht sein Ziel zeigt", () => {
    expect(mountedOptions().linkConfirmTexts).toEqual({
      open: "Open link",
      note: "The link text differs from this address.",
    });
  });

  it("reicht den alten Platzhalter allein nicht mehr", () => {
    expect(mountedOptions()).not.toHaveProperty("searchPlaceholder");
  });
});

describe("mountGrid: applyTerminalTheme (Spec §12.2)", () => {
  it("applyTerminalTheme erreicht jede gemountete Kachel, ohne den Refit-Pfad (resize_terminal) anzustossen", () => {
    vi.useFakeTimers();
    try {
      const state = new AppState();
      state.upsertHost(makeHost("h1", "vm-1"));
      state.setSessions("h1", ["a", "b"]);
      const el = document.createElement("div");
      const handle = mount(el, state);
      state.openSession("h1", "a");
      state.openSession("h1", "b");
      vi.advanceTimersByTime(1000); // offene Refits aus dem Hinzufuegen abraeumen
      hoisted.fitSpy.mockClear();
      handle.applyTerminalTheme("slate");
      vi.advanceTimersByTime(1000);
      expect(hoisted.setThemeSpy).toHaveBeenCalledTimes(2);
      expect(hoisted.setThemeSpy).toHaveBeenCalledWith("slate");
      expect(hoisted.fitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// UX-Spec §6.7: die Schriftgroesse gilt fuer alle Terminals. Das Raster reicht
// sie nur weiter; die Anpassung entprellt jede Kachel selbst (`setFontSize`).
describe("mountGrid: applyTerminalFontSize (UX-Spec §6.7)", () => {
  it("erreicht jede gemountete Kachel mit derselben Groesse", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["a", "b"]);
    const handle = mount(document.createElement("div"), state);
    state.openSession("h1", "a");
    state.openSession("h1", "b");

    handle.applyTerminalFontSize(15);

    expect(hoisted.setFontSizeSpy.mock.calls.sort()).toEqual([
      ["a", 15],
      ["b", 15],
    ]);
  });

  it("ist nach dispose() wirkungslos", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["a"]);
    const handle = mount(document.createElement("div"), state);
    state.openSession("h1", "a");

    handle.dispose();
    handle.applyTerminalFontSize(15);

    expect(hoisted.setFontSizeSpy).not.toHaveBeenCalled();
  });
});

// UX-Spec §8.4: die `title`-Texte nennen das Kuerzel aus der aktiven Tabelle;
// der zugaengliche Name (`aria-label`) bleibt die blosse Beschriftung.
describe("mountGrid: Tooltips nennen ihr Kuerzel (UX-Spec §8.4)", () => {
  function openOne(): { state: AppState; el: HTMLElement } {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    const el = document.createElement("div");
    mount(el, state);
    state.openSession("h1", "s1");
    return { state, el };
  }

  it("Maximieren, Wiederherstellen und Schliessen am Kachelkopf", () => {
    const { state, el } = openOne();
    const [maximize, close] = Array.from(el.querySelector(".tile")!.querySelectorAll<HTMLButtonElement>(".tile-btn"));

    expect(maximize.title).toBe("Maximize (Ctrl+Shift+M)");
    expect(maximize.getAttribute("aria-label")).toBe("Maximize");
    expect(close.title).toBe("Close terminal (Ctrl+Shift+W)");
    expect(close.getAttribute("aria-label")).toBe("Close terminal");

    state.toggleMaximize(state.tiles[0].id);
    expect(maximize.title).toBe("Restore (Ctrl+Shift+M)");
  });

  it("der Knopf im Leerzustand nennt New session", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    const el = document.createElement("div");
    mount(el, state);

    expect(el.querySelector(".grid-empty-card button.btn--primary")?.getAttribute("title")).toBe(
      "New session (Ctrl+Shift+N)",
    );
  });

  it("die Kuerzel kommen aus DEFAULT_KEYMAP, nicht aus einem Literal", () => {
    const saved = { ...DEFAULT_KEYMAP };
    DEFAULT_KEYMAP["tile.maximize"] = "Ctrl+Shift+X";
    DEFAULT_KEYMAP["session.close"] = "Ctrl+Shift+Q";
    try {
      const { el } = openOne();
      const [maximize, close] = Array.from(el.querySelectorAll<HTMLButtonElement>(".tile-btn"));
      expect(maximize.title).toBe("Maximize (Ctrl+Shift+X)");
      expect(close.title).toBe("Close terminal (Ctrl+Shift+Q)");
    } finally {
      Object.assign(DEFAULT_KEYMAP, saved);
    }
  });
});

// Aufgabe 10 (UI v2): der Leerzustand traegt ein Icon, eine Primaerpille NUR
// bei verbundenem Host und die dort wirksamen Kuerzel, die Kopfknoepfe echte
// Icons statt Glyphen.
describe("UI v2: Kacheln und Leerzustand (Spec 8, 10)", () => {
  it("Leerzustand mit verbundenem Host: Icon, Primaerpille 'New session', genau die vier wirksamen Kuerzel (UX-Spec §7.9)", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    const el = document.createElement("div");
    const onNewSession = vi.fn();
    mount(el, state, { onNewSession });
    const card = el.querySelector<HTMLElement>(".grid-empty-card")!;
    expect(card.querySelector(".grid-empty-icon svg")).not.toBeNull();
    const button = card.querySelector<HTMLButtonElement>("button.btn.btn--primary")!;
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe("New session");
    expect(card.querySelector<HTMLElement>(".grid-empty-connect-first")?.hidden).toBe(true);
    // Task 16, Punkt D: MIT verbundenem Host steht der erklaerende Satz
    // ("Pick a session ...") -- er sagt dann etwas, das man auch tun kann.
    expect(
      el.querySelector<HTMLElement>(".grid-empty-card p:not(.grid-empty-connect-first)")?.hidden,
    ).toBe(false);
    button.click();
    expect(onNewSession).toHaveBeenCalledTimes(1);
    // Suchen und Maximieren wirken im leeren Raster nicht und fehlen deshalb.
    const keys = Array.from(card.querySelectorAll(".grid-empty-keys li"));
    expect(keys.map((k) => k.querySelector("kbd")?.textContent)).toEqual([
      "Ctrl+Shift+N",
      "Ctrl+Shift+P",
      "Ctrl+Shift+B",
      "Ctrl+,",
    ]);
    expect(keys.map((k) => k.querySelector("span")?.textContent)).toEqual([
      "New session", "Quick open", "Sidebar", "All shortcuts",
    ]);
  });

  it("die Kuerzel des Leerzustands und des Maximiert-Hinweises kommen aus DEFAULT_KEYMAP", () => {
    const saved = { ...DEFAULT_KEYMAP };
    DEFAULT_KEYMAP["session.new"] = "Ctrl+Shift+J";
    DEFAULT_KEYMAP.quickOpen = "Ctrl+Shift+K";
    DEFAULT_KEYMAP["sidebar.toggle"] = "Ctrl+Shift+Y";
    DEFAULT_KEYMAP["settings.open"] = "Ctrl+Shift+O";
    DEFAULT_KEYMAP["tile.maximize"] = "Ctrl+Shift+X";
    try {
      const state = new AppState();
      state.upsertHost(makeHost("h1", "vm-1"));
      state.setSessions("h1", ["s1"]);
      const el = document.createElement("div");
      mount(el, state);
      const keys = Array.from(el.querySelectorAll(".grid-empty-keys li kbd"), (kbd) => kbd.textContent);
      expect(keys).toEqual(["Ctrl+Shift+J", "Ctrl+Shift+K", "Ctrl+Shift+Y", "Ctrl+Shift+O"]);

      state.openSession("h1", "s1");

      state.toggleMaximize(state.tiles[0].id);
      expect(el.querySelector(".tile.focused .tile-btn")?.textContent).toBe("Maximized · Ctrl+Shift+X");
      expect(el.querySelector('.tile-grid-view > .ab-visually-hidden[aria-live="polite"]')?.textContent).toBe(
        "Terminal 1 maximized. Press Ctrl+Shift+X to restore.",
      );
    } finally {
      Object.assign(DEFAULT_KEYMAP, saved);
    }
  });

  it("maximiert: Kopf 'Maximized · Ctrl+Shift+M', Ansage nennt dasselbe Kuerzel (UX-Spec §7.9)", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1", "s2"]);
    const el = document.createElement("div");
    mount(el, state);
    state.openSession("h1", "s1");
    state.openSession("h1", "s2");

    state.toggleMaximize(state.tiles[1].id);

    const maximize = tilesByPosition(el)[1].querySelector<HTMLButtonElement>(".tile-btn")!;
    expect(maximize.textContent).toBe("Maximized · Ctrl+Shift+M");
    expect(maximize.title).toBe("Restore (Ctrl+Shift+M)");
    // Die Nummer ist die Position + 1, auch maximiert (Spec 2026-10-19 §4.1).
    expect(el.querySelector('.tile-grid-view > .ab-visually-hidden[aria-live="polite"]')?.textContent).toBe(
      "Terminal 2 maximized. Press Ctrl+Shift+M to restore.",
    );
  });

  it("Leerzustand ohne verbundenen Host: keine Pille, dafuer der Hinweis", () => {
    const state = new AppState();
    state.upsertHost({ ...makeHost("h1", "vm-1"), state: "disconnected" });
    const el = document.createElement("div");
    mount(el, state);
    expect(el.querySelector<HTMLButtonElement>(".grid-empty-card button.btn--primary")?.hidden).toBe(true);
    const hint = el.querySelector<HTMLElement>(".grid-empty-connect-first")!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("Connect a host in the sidebar to begin.");
    // Task 16, Punkt D: EIN Satz, nicht zwei. "Pick a session from the
    // sidebar" verweist auf etwas, das es ohne Verbindung nicht gibt.
    expect(
      el.querySelector<HTMLElement>(".grid-empty-card p:not(.grid-empty-connect-first)")?.hidden,
    ).toBe(true);
  });

  it("Kopfknoepfe tragen Icons; das Maximieren-Icon wechselt mit dem Zustand", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    const el = document.createElement("div");
    mount(el, state);
    state.openSession("h1", "s1");
    const tile = el.querySelector<HTMLElement>(".tile")!;
    const [maximize, close] = Array.from(tile.querySelectorAll<HTMLButtonElement>(".tile-btn"));
    expect(maximize.querySelector(".icon-box")?.getAttribute("data-icon")).toBe("maximize-2");
    expect(close.querySelector(".icon-box")?.getAttribute("data-icon")).toBe("x");
    expect(close.getAttribute("aria-label")).toBe("Close terminal");
    state.toggleMaximize(state.tiles[0].id);
    expect(maximize.querySelector(".icon-box")?.getAttribute("data-icon")).toBe("minimize-2");
  });

  it("genau eine Kachel ist fokussiert (Chip gefuellt, Titel 600 per CSS)", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["a", "b"]);
    const el = document.createElement("div");
    mount(el, state);
    state.openSession("h1", "a");
    state.openSession("h1", "b");
    expect(el.querySelectorAll(".tile.focused")).toHaveLength(1);
    expect(el.querySelectorAll('.tile[aria-current="true"]')).toHaveLength(1);
  });

  it("shows the agent status pill between title and host and hides it while input is locked", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setHostState("h1", "connected");
    state.setSessions("h1", ["s1"]);
    const session = state.hosts[0].sessions[0];
    session.sessionId = 1;
    session.status = "busy";
    const el = document.createElement("div");
    mount(el, state);
    state.openSession("h1", "s1");
    const head = el.querySelector<HTMLElement>(".tile .tile-head")!;
    // UI v2 8.2: chip, title, agent slot, host, then the buttons.
    const order = Array.from(head.children).map((child) => child.className.split(" ")[0]);
    expect(order.indexOf("tile-agent")).toBe(order.indexOf("tile-title") + 1);
    expect(order.indexOf("tile-host")).toBe(order.indexOf("tile-agent") + 1);
    expect(head.querySelector<HTMLElement>(".tile-agent:not([hidden]) .st.st-busy")?.textContent).toBe("Busy");
    state.lockInput("h1", "s1");
    expect(head.querySelector(".tile-agent:not([hidden]) .st")).toBeNull();
    expect(el.querySelector<HTMLElement>(".tile-lock-chip:not([hidden])")?.textContent).toBe("Disconnected");
  });

  // Optik-Runde vom 24.10.: in einer schmalen Kachel zeigt die Pille nur ihren
  // Punkt (styles.css); ihr Wort steht deshalb im Tooltip, vor dem Grund.
  it("puts the pill's word in its own element and, in the tile head, in front of the reason in its tooltip", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessions("h1", ["s1"]);
    const session = state.hosts[0].sessions[0];
    session.sessionId = 1;
    session.status = "waiting";
    session.statusReason = "permission prompt";
    const el = document.createElement("div");
    mount(el, state);
    state.openSession("h1", "s1");
    const pill = el.querySelector<HTMLElement>(".tile-head .tile-agent .st")!;
    expect(pill.querySelector(".st-word")?.textContent).toBe("Waiting");
    expect(pill.title).toBe("Waiting · permission prompt");
  });
});

describe("mountGrid: Sessions des Standard-Sockets (Spec 2026-10-25 §5, §6.4)", () => {
  it("montiert die fremde Kachel mit ihrem Socket und meldet ihn in jedem Rueckruf", () => {
    const state = new AppState();
    state.upsertHost(makeHost("h1", "vm-1"));
    state.setSessionRecords("h1", [{ name: "main" }]);
    state.setSessionRecords(
      "h1",
      [{ name: "main", sessionId: 1, serverPid: 2, serverStartTime: 3, windowId: 4, paneId: 5, panePid: 6 }],
      undefined,
      "default",
    );
    state.openSession("h1", "main");
    state.openSession("h1", "main", "default");
    const onCloseTerminal = vi.fn();
    const onTerminalOpenFailed = vi.fn();
    mount(document.createElement("div"), state, { onCloseTerminal, onTerminalOpenFailed });
    expect(hoisted.mountTerminalSpy).toHaveBeenCalledTimes(2);
    const [own, foreign] = hoisted.mountTerminalSpy.mock.calls as Array<
      [HTMLElement, string, string, unknown, { socket?: string; sessionId?: number | null; onCloseTerminal?: () => void; onOpenFailed?: () => void }]
    >;
    expect([own[1], own[2], own[4].socket]).toEqual(["r-h1", "main", undefined]);
    expect([foreign[1], foreign[2], foreign[4].socket, foreign[4].sessionId]).toEqual(["r-h1", "main", "default", 1]);
    foreign[4].onCloseTerminal?.();
    expect(onCloseTerminal).toHaveBeenCalledWith("h1", "main", "default");
    own[4].onOpenFailed?.();
    expect(onTerminalOpenFailed).toHaveBeenCalledWith("h1", "main", "app");
  });
});
