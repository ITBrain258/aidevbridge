// Automatisierte Gegenprobe fuer die drei Eigenschaften, die
// sich ueberhaupt ohne echtes WebView pruefen lassen:
//   1. Bytes werden nie vor `term.write()` dekodiert (Spec §9.1).
//   2. `ack_output` feuert nur im `write()`-Callback, mit der Groesse DIESES
//      Pakets -- nicht kumulativ (Spec V31, `ack_output_impl`-Kommentar).
//   3. `open_terminal` wird erst aufgerufen, nachdem der Backend-Listener
//      registriert ist -- sonst verhungert die Ack-Bremse von Anfang an
//      (siehe Kommentar in `terminal.ts`).
// Terminal-Treue selbst (Alternate Screen, Maus, Truecolor) und Flow
// Control unter echter Last lassen sich damit NICHT pruefen -- das bleibt
// dem manuellen Durchlauf am echten Fenster vorbehalten.
//
// xterm.js, seine Addons und die Tauri-API werden komplett gemockt: uns
// interessiert hier ausschliesslich die Verdrahtung in `mountTerminal`,
// nicht xterm.js' eigenes Rendering (das kann kein Mock pruefen).

// `node:fs`/`node:path`/`process` sind Node-Globals ohne Typdeklaration in
// diesem browserorientierten Projekt (kein `@types/node` installiert, kein
// `"node"`-Lib in `tsconfig.json`) -- Vitest fuehrt Tests unter Node aus
// (Typen egal zur Laufzeit), `tsc` (via `npm run build`) kennt sie aber
// nicht. Gleiches Muster wie `process.env` in `vite.config.ts`
// ("@ts-expect-error process is a nodejs global").
// @ts-expect-error 'node:fs' ist ein Node-Global, siehe Kommentar oben
import { readFileSync } from "node:fs";
// @ts-expect-error 'node:path' ist ein Node-Global, siehe Kommentar oben
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { THEMES, themeParts, type AccentId, type BaseId } from "./theme";

/** `@xterm/xterm`s `IBufferRange`: 1-basiert, das Ende eingeschlossen. */
interface MockBufferRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

// M-Doc-2 (Abschlussreview): Form des `linkHandler`, den `terminal.ts` an
// den echten `Terminal`-Konstruktor uebergibt (`@xterm/xterm`s
// `ILinkHandler`). Bei OSC 8 reicht xterm immer den Bereich des sichtbaren
// Texts mit.
interface MockTerminalOptions {
  disableStdin: boolean;
  /** Das Thema, mit dem `terminal.ts` das Terminal baut und spaeter per
   * `setTheme` ersetzt -- die Suchleiste liest die Farben der Treffer daraus. */
  theme?: Record<string, string | undefined>;
  linkHandler?: {
    activate: (event: MouseEvent, text: string, range: MockBufferRange) => void;
    hover?: (event: MouseEvent, text: string, range: MockBufferRange) => void;
    leave?: (event: MouseEvent, text: string, range: MockBufferRange) => void;
  };
}

const hoisted = vi.hoisted(() => {
  return {
    writeCalls: [] as Array<{ data: string | Uint8Array; callback?: () => void }>,
    webglShouldThrow: false,
    /** Der WebGL-Addon des Mocks: die an `onContextLoss` angemeldeten Rueckrufe
     * und wie oft jemand ihn entsorgt hat (Spec 2026-10-19 §8.2). */
    webgl: { lossListeners: [] as Array<() => void>, disposeCalls: 0 },
    // Veraenderlich (nicht als feste Klassenfelder), damit Tests fuer
    // Befund 1 (Resize-Wachhund) zwischen "Groesse hat sich wirklich
    // geaendert" und "Resize-Event ohne Groessenaenderung" unterscheiden
    // koennen -- `terminal.ts` liest `term.cols`/`term.rows` bei jedem
    // `fit()`-Aufruf neu.
    size: { cols: 80, rows: 24 },
    /** Wie oft `FitAddon.fit()` lief, ueber alle Terminals: eine verborgene
     * Kachel misst nicht (Spec 2026-10-19 §8.1, Schritt 3). Der Mock-`fit`
     * aendert selbst nichts; `term.cols`/`term.rows` liest der Mock immer
     * aus `size`. */
    fitCalls: 0,
    // Task 12 (`Keymap`): der von `mountTerminal` an
    // `attachCustomKeyEventHandler` uebergebene Handler -- die Tests unten
    // rufen ihn direkt mit synthetischen `KeyboardEvent`s auf, um die
    // App/Terminal-Grenze ohne echtes WebView zu pruefen.
    customKeyEventHandler: undefined as ((event: KeyboardEvent) => boolean) | undefined,
    selection: "",
    /** `true` laesst `hasSelection()` wahr melden, auch wenn `getSelection()`
     * "" liefert: xterm kappt Leerzeichen am Zeilenende, eine Markierung aus
     * lauter Leerraum ist fuer `hasSelection()` eine Markierung und liefert
     * trotzdem keinen Text. */
    blankSelection: false,
    /** Jedes erzeugte `Terminal` in Mount-Reihenfolge. `ownSelection` gibt
     * einem Terminal eine eigene Markierung statt der gemeinsamen
     * `selection` -- noetig, sobald zwei Kacheln gleichzeitig stehen. */
    terminals: [] as Array<{
      ownSelection: string | null;
      element: HTMLElement | undefined;
      /** Dasselbe Objekt wie `term.options`: Schriftgroesse beim Bau und nach
       * `setFontSize` (UX-Spec §6.7). */
      options: Record<string, unknown>;
    }>,
    clearSelectionCalls: 0,
    selectAllCalls: 0,
    /** Was `term.modes.mouseTrackingMode` meldet; "none", solange kein
     * Programm die Maus anfordert. */
    mouseTrackingMode: "none" as "none" | "x10" | "vt200" | "drag" | "any",
    /** `term.onSelectionChange`-Rueckrufe. Die Anwendung haengt sich daran
     * bewusst nicht (Copy on select, UX-Spec §6.4); der Mock fuehrt sie nur,
     * damit ein Test eine Umsetzung ueber dieses Ereignis ertappen kann. */
    selectionListeners: new Set<() => void>(),
    /** Spec §6.2: die ueber `term.parser.registerOscHandler` angemeldeten
     * Handler, nach OSC-Nummer. */
    oscHandlers: new Map<number, (data: string) => boolean | Promise<boolean>>(),
    /** Der an `term.onData` uebergebene Rueckruf (siehe `input()` im Mock). */
    dataListener: undefined as ((data: string) => void) | undefined,
    pasteCalls: [] as string[],
    focusCalls: 0,
    searchCalls: [] as Array<{ type: "next" | "prev"; term: string }>,
    /** Die Optionen (`caseSensitive`, `decorations`) je Suche, in derselben
     * Reihenfolge wie `searchCalls` -- getrennt, damit deren Form stabil bleibt. */
    searchOptions: [] as Array<Record<string, unknown> | undefined>,
    /** `search.onDidChangeResults`-Rueckrufe: der Test feuert sie wie das echte
     * Addon nach einer Suche mit `decorations`. */
    resultListeners: new Set<(event: { resultIndex: number; resultCount: number }) => void>(),
    clearDecorationsCalls: 0,
    /** Was `terminal.ts` dem WebLinks-Addon uebergibt: den Klick-Rueckruf und
     * die Optionen mit Hover und Leave. */
    webLinks: {
      handler: undefined as ((event: MouseEvent, uri: string) => void) | undefined,
      options: undefined as
        | {
            hover?: (event: MouseEvent, uri: string) => void;
            leave?: (event: MouseEvent, uri: string) => void;
          }
        | undefined,
    },
    // M-C (Abschlussreview): `terminal.ts` sperrt Eingabe bei
    // Verbindungsverlust ueber `term.options.disableStdin = true` --
    // xterm.js' echtes `Terminal` haelt `options` als direkt zuweisbares
    // Objekt (kein `setOption()` mehr seit v5). Der Mock haelt eine Referenz
    // auf dasselbe Objekt, damit Tests die Zuweisung von aussen beobachten
    // koennen, ohne `mountTerminal`s Rueckgabewert (nur `dispose()`) dafuer
    // erweitern zu muessen.
    // M-Doc-2 (Abschlussreview): jetzt auch `linkHandler` erfassend (nicht
    // nur `disableStdin`) -- derselbe Objekt-Verweis wie `term.options`
    // selbst (siehe Konstruktor unten), damit Tests sowohl die spaeter per
    // `term.options.disableStdin = true` gesetzte Sperre ALS AUCH den beim
    // Konstruieren uebergebenen `linkHandler` direkt aufrufen koennen.
    lastOptions: undefined as MockTerminalOptions | undefined,
    /** Die Zeilen des Puffers, aus dem `terminal.ts` den sichtbaren Text eines
     * OSC-8-Links liest (`buffer.active.getLine`). */
    bufferLines: [] as string[],
  };
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    unicode = { activeVersion: "6" };
    options: Record<string, unknown>;
    // M-Doc-2 (Abschlussreview): nimmt die an `new Terminal(...)`
    // uebergebenen Optionen jetzt tatsaechlich entgegen (vorher komplett
    // ignoriert) -- `disableStdin` bleibt mit Default `false` vorbelegt,
    // ein `linkHandler` aus der Produktion landet unveraendert (per
    // Objekt-Referenz) in `this.options`, damit Tests ihn direkt aufrufen
    // koennen.
    ownSelection: string | null = null;
    constructor(options?: Record<string, unknown>) {
      this.options = { disableStdin: false, ...(options ?? {}) };
      hoisted.lastOptions = this.options as unknown as MockTerminalOptions;
      hoisted.terminals.push(this);
    }
    get cols(): number {
      return hoisted.size.cols;
    }
    get rows(): number {
      return hoisted.size.rows;
    }
    loadAddon(): void {
      // no-op
    }
    textarea: HTMLTextAreaElement | null = null;
    /** Wie xterm.js: das Wurzelelement `.xterm`, nach `open()`. Hover und Leave
     * eines Links setzen den Tooltip hier. */
    element: HTMLElement | undefined;
    open(parent: HTMLElement): void {
      this.element = document.createElement("div");
      this.element.className = "xterm";
      parent.appendChild(this.element);
      // Wie xterm.js: ein verstecktes Textfeld nimmt den Fokus des Terminals
      // auf. Nur damit sehen Tests, wohin `focus()` den Fokus wirklich legt
      // (und wem ein Menue, das sich schliesst, ihn entreissen kann).
      this.textarea = document.createElement("textarea");
      this.textarea.className = "xterm-helper-textarea";
      parent.appendChild(this.textarea);
    }
    onData(callback: (data: string) => void): void {
      // Der Eingabepfad selbst ist trivial (roher `TextEncoder`, keine
      // zustandsbehaftete Dekodierung); der Mock haelt den Rueckruf nur,
      // damit `input()` unten wie in xterm.js bis zu `send_input` durchreicht.
      hoisted.dataListener = callback;
    }
    /** Wie xterm.js: Eingabe, die `term.input()` erhaelt, erreicht `onData`.
     * Nur so kann ein Test sehen, dass die Anwendung dem Programm etwas
     * geschickt haette (etwa eine Antwort auf OSC 52). */
    input(data: string): void {
      hoisted.dataListener?.(data);
    }
    write(data: string | Uint8Array, callback?: () => void): void {
      hoisted.writeCalls.push({ data, callback });
    }
    dispose(): void {
      // no-op
    }
    /** Wie xterm.js `buffer.active`, soweit `terminal.ts` ihn liest: `getLine(y)`
     * (0-basiert) mit `translateToString(trimRight, start, end)` -- der
     * sichtbare Text eines OSC-8-Links. */
    get buffer() {
      return {
        active: {
          getLine: (y: number) => {
            const text = hoisted.bufferLines[y];
            if (text === undefined) return undefined;
            return {
              translateToString: (trimRight = false, start = 0, end = text.length) => {
                const part = text.slice(start, end);
                return trimRight ? part.trimEnd() : part;
              },
            };
          },
        },
      };
    }
    getSelection(): string {
      return this.ownSelection ?? hoisted.selection;
    }
    hasSelection(): boolean {
      return hoisted.blankSelection || this.getSelection().length > 0;
    }
    clearSelection(): void {
      hoisted.clearSelectionCalls += 1;
    }
    selectAll(): void {
      hoisted.selectAllCalls += 1;
    }
    get modes(): { mouseTrackingMode: typeof hoisted.mouseTrackingMode } {
      return { mouseTrackingMode: hoisted.mouseTrackingMode };
    }
    onSelectionChange(callback: () => void): { dispose(): void } {
      hoisted.selectionListeners.add(callback);
      return { dispose: () => hoisted.selectionListeners.delete(callback) };
    }
    parser = {
      registerOscHandler: (ident: number, callback: (data: string) => boolean | Promise<boolean>) => {
        hoisted.oscHandlers.set(ident, callback);
        return { dispose: () => hoisted.oscHandlers.delete(ident) };
      },
    };
    paste(data: string): void {
      hoisted.pasteCalls.push(data);
    }
    focus(): void {
      hoisted.focusCalls += 1;
      this.textarea?.focus();
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      hoisted.customKeyEventHandler = handler;
    }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit(): void {
      // Die reale Fit-Berechnung ist xterm.js' Sache, nicht Gegenstand
      // dieser Verdrahtungstests; gezaehlt wird nur, OB gemessen wird.
      hoisted.fitCalls += 1;
    }
  }
  return { FitAddon };
});

vi.mock("@xterm/addon-webgl", () => {
  class WebglAddon {
    constructor() {
      if (hoisted.webglShouldThrow) {
        throw new Error("WebGL2 not supported in this environment");
      }
    }
    onContextLoss(listener: () => void): void {
      hoisted.webgl.lossListeners.push(listener);
    }
    dispose(): void {
      hoisted.webgl.disposeCalls += 1;
    }
  }
  return { WebglAddon };
});

vi.mock("@xterm/addon-unicode11", () => {
  class Unicode11Addon {}
  return { Unicode11Addon };
});

vi.mock("@xterm/addon-search", () => {
  class SearchAddon {
    // Wie das echte Addon: ein Treffer wird markiert (`term.select()`), und
    // xterm meldet die neue Markierung ueber `onSelectionChange`.
    findNext(term: string, options?: Record<string, unknown>): boolean {
      hoisted.searchCalls.push({ type: "next", term });
      hoisted.searchOptions.push(options);
      hoisted.selection = term;
      hoisted.selectionListeners.forEach((listener) => listener());
      return true;
    }
    findPrevious(term: string, options?: Record<string, unknown>): boolean {
      hoisted.searchCalls.push({ type: "prev", term });
      hoisted.searchOptions.push(options);
      hoisted.selection = term;
      hoisted.selectionListeners.forEach((listener) => listener());
      return true;
    }
    clearDecorations(): void {
      hoisted.clearDecorationsCalls += 1;
    }
    onDidChangeResults(listener: (event: { resultIndex: number; resultCount: number }) => void) {
      hoisted.resultListeners.add(listener);
      return { dispose: () => void hoisted.resultListeners.delete(listener) };
    }
  }
  return { SearchAddon };
});

vi.mock("@xterm/addon-web-links", () => {
  class WebLinksAddon {
    constructor(
      handler: (event: MouseEvent, uri: string) => void,
      options?: { hover?: (event: MouseEvent, uri: string) => void; leave?: (event: MouseEvent, uri: string) => void },
    ) {
      hoisted.webLinks.handler = handler;
      hoisted.webLinks.options = options;
    }
  }
  return { WebLinksAddon };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import en from "./i18n/en.json";
import { installKeyboard } from "./keyboard";
import {
  INPUT_CHUNK_BYTES,
  mountTerminal,
  searchDecorations,
  terminalTheme,
  type MountOptions,
  type TerminalError,
  type TerminalHandle,
} from "./terminal";
import { createOpenQueue, type OpenQueue } from "./terminal-open-queue";
import { DEFAULT_TERMINAL_PREFS, onTerminalPrefsChanged, setTerminalPrefs, terminalPrefs } from "./terminal-prefs";
import type { TerminalMenuTexts } from "./views/terminal-menu";
import type { TerminalSearchTexts } from "./views/terminal-search";
import { mountSidebar } from "./views/sidebar";
import { AppState } from "./state/app-state";

// Jeder `mountTerminal()`-Aufruf haengt einen `window`-Resize-Listener ein
// (siehe `terminal.ts`). Ohne Aufraeumen ueberlebt der Listener eines
// Tests bis in den naechsten hinein und liesse dessen Resize-Zaehlung
// (Test "Resize-Entprellung") falsch aussehen -- deshalb hier zentral
// erfasst und in `afterEach` disposed, statt es jedem Testkoerper
// einzeln zu ueberlassen.
const activeHandles: TerminalHandle[] = [];
function mount(
  el: HTMLElement,
  hostId: string,
  session: string,
  onError?: (error: TerminalError) => void,
  options?: MountOptions,
): TerminalHandle {
  const handle = mountTerminal(el, hostId, session, onError, options);
  activeHandles.push(handle);
  return handle;
}

/** Feuert den an `attachCustomKeyEventHandler` uebergebenen Handler direkt
 * mit einem synthetischen `KeyboardEvent` -- so laesst sich die App/
 * Terminal-Grenze (Spec §7.4) pruefen, ohne ein echtes WebView zu brauchen. */
function fireKey(init: Partial<KeyboardEventInit> & { key: string }): boolean | undefined {
  return fireKeyEvent(init).handled;
}

/** Wie `fireKey`, liefert aber auch das Ereignis -- die Zwischenablage-Tests
 * pruefen `defaultPrevented`: ohne `preventDefault` fuegt Chromium nativ ein. */
function fireKeyEvent(init: Partial<KeyboardEventInit> & { key: string }): {
  handled: boolean | undefined;
  event: KeyboardEvent;
} {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  return { handled: hoisted.customKeyEventHandler?.(event), event };
}

type Listener = (event: {
  payload: { host_id: string; open_id: string; session: string; bytes: number[] };
}) => void;
// M-C (Abschlussreview): zweiter Ereignistyp, den `mountTerminal` jetzt
// registriert.
type LostListener = (event: { payload: { host_id: string; open_id: string; session: string } }) => void;

/** Ein Promise, dessen Aufloesung der Test von aussen ausloest -- damit
 * sich die Reihenfolge "Listener registriert, DANN `open_terminal`"
 * beobachten laesst, statt sie durch sofortige Aufloesung zu verschleiern. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

// jsdom kennt die Clipboard-API nicht von sich aus -- `terminal.ts` ruft
// `navigator.clipboard.writeText` zum Kopieren auf. `readText` steht nur
// bereit, damit die Tests zeigen koennen, dass Einfuegen es NICHT ruft.
const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
const clipboardReadText = vi.fn().mockResolvedValue("");
Object.defineProperty(globalThis.navigator, "clipboard", {
  value: { writeText: clipboardWriteText, readText: clipboardReadText },
  configurable: true,
  writable: true,
});

function invokedOpenTerminal(): boolean {
  return invokeMock.mock.calls.some(([command]) => command === "open_terminal");
}

const FIXED_OPEN_ID = "10000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXED_OPEN_ID);
  hoisted.writeCalls.length = 0;
  hoisted.webglShouldThrow = false;
  hoisted.webgl.lossListeners.length = 0;
  hoisted.webgl.disposeCalls = 0;
  hoisted.size = { cols: 80, rows: 24 };
  hoisted.fitCalls = 0;
  hoisted.customKeyEventHandler = undefined;
  hoisted.selection = "";
  hoisted.blankSelection = false;
  hoisted.terminals.length = 0;
  hoisted.clearSelectionCalls = 0;
  hoisted.selectAllCalls = 0;
  hoisted.mouseTrackingMode = "none";
  hoisted.selectionListeners.clear();
  hoisted.oscHandlers.clear();
  hoisted.dataListener = undefined;
  hoisted.pasteCalls.length = 0;
  hoisted.focusCalls = 0;
  hoisted.searchCalls.length = 0;
  hoisted.searchOptions.length = 0;
  hoisted.resultListeners.clear();
  hoisted.clearDecorationsCalls = 0;
  hoisted.webLinks.handler = undefined;
  hoisted.webLinks.options = undefined;
  hoisted.lastOptions = undefined;
  hoisted.bufferLines = [];
  // `mockReset()`, nicht nur `mockClear()`: mindestens ein Test unten setzt
  // eine eigene `invoke`-Implementierung (Fehlerpfad-Test fuer
  // `open_terminal`). `mockClear()` loescht nur den Aufrufverlauf, nicht
  // eine per `mockImplementation` gesetzte Implementierung -- die wuerde
  // sonst in den naechsten Test durchsickern.
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(vi.fn()));
  clipboardWriteText.mockReset().mockResolvedValue(undefined);
  clipboardReadText.mockReset().mockResolvedValue("");
  // Modulzustand: ein Test, der Strg+C/V abschaltet, darf den naechsten nicht
  // mitnehmen.
  setTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS });
});

afterEach(() => {
  activeHandles.splice(0).forEach((handle) => handle.dispose());
  // Entsorgen schliesst ein offenes Terminalmenue; bliebe eines in body
  // stehen, zaehlten die Menueabfragen im naechsten Test falsch. Erst
  // aufraeumen, dann pruefen: scheitert die Zusicherung, darf das Menue samt
  // seinen Lauschern an Dokument und Fenster nicht in den naechsten Test
  // durchschlagen. Die Groessenaenderung schliesst jedes noch offene Menue.
  const leaked = document.querySelector(".terminal-menu") !== null;
  window.dispatchEvent(new Event("resize"));
  document.body.replaceChildren();
  expect(leaked).toBe(false);
});

describe("mountTerminal: Bytes bleiben Bytes", () => {
  it("trennt gleichnamige Remounts schon vor der open-Antwort nach openId", async () => {
    const nextOpenId = "20000000-0000-4000-8000-000000000002";
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(FIXED_OPEN_ID).mockReturnValueOnce(nextOpenId);
    const outputs: Listener[] = [];
    const losses: LostListener[] = [];
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") outputs.push(handler as Listener);
      if (event === "terminal://connection-lost") losses.push(handler as LostListener);
      return Promise.resolve(vi.fn());
    });
    const opening = deferred<void>();
    invokeMock.mockImplementation((command) => command === "open_terminal" ? opening.promise : Promise.resolve());
    const first = mount(document.createElement("div"), "host-1", "same");
    await Promise.resolve();
    await Promise.resolve();
    outputs[0]({ payload: { host_id: "host-1", session: "same", open_id: FIXED_OPEN_ID, bytes: [1, 2] } });
    const oldWrite = hoisted.writeCalls[0];
    first.dispose();
    const onLoss = vi.fn();
    mount(document.createElement("div"), "host-1", "same", undefined, { onConnectionLost: onLoss });
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("close_terminal", { hostId: "host-1", session: "same", openId: FIXED_OPEN_ID });
    expect(invokeMock).toHaveBeenCalledWith("open_terminal", expect.objectContaining({ openId: nextOpenId }));
    invokeMock.mockClear();
    hoisted.writeCalls.length = 0;

    // Delayed old events reach both listeners, including the current view.
    for (const output of outputs) output({ payload: { host_id: "host-1", session: "same", open_id: FIXED_OPEN_ID, bytes: [3] } });
    for (const loss of losses) loss({ payload: { host_id: "host-1", session: "same", open_id: FIXED_OPEN_ID } });
    oldWrite.callback?.();
    expect(hoisted.writeCalls).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalledWith("ack_output", expect.anything());
    expect(onLoss).not.toHaveBeenCalled();
    expect(hoisted.lastOptions?.disableStdin).toBe(false);

    // The matching event is usable even while open_terminal remains pending.
    outputs[1]({ payload: { host_id: "host-1", session: "same", open_id: nextOpenId, bytes: [4, 5, 6] } });
    expect(hoisted.writeCalls).toHaveLength(1);
    hoisted.writeCalls[0].callback?.();
    expect(invokeMock).toHaveBeenCalledWith("ack_output", { hostId: "host-1", session: "same", openId: nextOpenId, byteCount: 3 });
    losses[1]({ payload: { host_id: "host-1", session: "same", open_id: nextOpenId } });
    expect(onLoss).toHaveBeenCalledOnce();
    expect(hoisted.lastOptions?.disableStdin).toBe(true);
    opening.resolve();
  });

  it("meldet eine abgelehnte alte open-Antwort nach Remount nicht an die neue Ansicht", async () => {
    let rejectOld!: (error: unknown) => void;
    const oldOpening = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    let opens = 0;
    invokeMock.mockImplementation((command) => command === "open_terminal" && ++opens === 1 ? oldOpening : Promise.resolve());
    const onError = vi.fn();
    const onOpenFailed = vi.fn();
    const first = mount(document.createElement("div"), "host-1", "same", onError, { onOpenFailed });
    await Promise.resolve();
    await Promise.resolve();
    first.dispose();
    vi.mocked(crypto.randomUUID).mockReturnValue("20000000-0000-4000-8000-000000000002");
    mount(document.createElement("div"), "host-1", "same", onError, { onOpenFailed });
    rejectOld("obsolete open failed");
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    expect(onOpenFailed).not.toHaveBeenCalled();
    expect(hoisted.lastOptions?.disableStdin).toBe(false);
  });

  it("reicht rohe Bytes unveraendert an term.write() weiter, auch an einer Mehrbyte-Chunk-Grenze", () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    mount(document.createElement("div"), "host-1", "sess-1");
    expect(capturedListener).toBeDefined();

    // 'à' ist in UTF-8 zwei Byte: 0xC3 0xA0. Zwei Events liefern je ein
    // Byte -- ein String-Dekodieren PRO EVENT wuerde hier ein
    // Ersatzzeichen (U+FFFD) fuer das erste, verwaiste Byte erzeugen.
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [0xc3] } });
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [0xa0] } });

    expect(hoisted.writeCalls).toHaveLength(2);
    expect(hoisted.writeCalls[0].data).toBeInstanceOf(Uint8Array);
    expect(Array.from(hoisted.writeCalls[0].data as Uint8Array)).toEqual([0xc3]);
    expect(Array.from(hoisted.writeCalls[1].data as Uint8Array)).toEqual([0xa0]);
  });

  it("ignoriert Events fuer eine andere Session", () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    mount(document.createElement("div"), "host-1", "sess-1");
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-OTHER", bytes: [0x41] } });

    expect(hoisted.writeCalls).toHaveLength(0);
  });

  it("schreibt nicht mehr, wenn ein Event ankommt, nachdem dispose() bereits lief", () => {
    // `dispose()` unlistened erst NACH einem `await` (dem von `listen()`
    // zurueckgegebenen Promise) -- ein Event, das genau in diesem Fenster
    // ankommt, wird hier ueber denselben, weiterhin aufrufbaren Handler
    // simuliert (unser `listen`-Mock respektiert die Unlisten-Zeitpunkte
    // nicht selbst, anders als ein echter Tauri-Eventbus).
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    handle.dispose();

    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [0x41] } });

    expect(hoisted.writeCalls).toHaveLength(0);
  });
});

describe("mountTerminal: Ack erst im write()-Callback", () => {
  it("ruft ack_output NICHT auf, bevor der write()-Callback gefeuert hat", () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    mount(document.createElement("div"), "host-1", "sess-1");
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } });

    expect(
      invokeMock.mock.calls.some(([command]) => command === "ack_output"),
    ).toBe(false);
  });

  it("acked genau die Groesse DIESES Pakets, nicht die kumulative Summe", () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    mount(document.createElement("div"), "host-1", "sess-1");

    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } }); // 3 Byte
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [4, 5] } }); // 2 Byte

    expect(hoisted.writeCalls).toHaveLength(2);
    // Erst jetzt "verarbeitet" xterm.js die beiden Pakete -- in beliebiger
    // Reihenfolge, das ist der Punkt: die Bremse haengt an write(), nicht
    // an der Ankunft des Events.
    hoisted.writeCalls[1].callback?.();
    hoisted.writeCalls[0].callback?.();

    const ackCalls = invokeMock.mock.calls.filter(([command]) => command === "ack_output");
    expect(ackCalls).toHaveLength(2);
    const byteCounts = ackCalls
      .map(([, args]) => (args as { byteCount: number }).byteCount)
      .sort((a, b) => a - b);
    expect(byteCounts).toEqual([2, 3]);
  });
});

describe("mountTerminal: open_terminal erst nach Listener-Registrierung", () => {
  it("ruft open_terminal nicht auf, solange listen() noch nicht aufgeloest ist", async () => {
    const gate = deferred<() => void>();
    listenMock.mockImplementation(() => gate.promise);

    mount(document.createElement("div"), "host-1", "sess-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(invokedOpenTerminal()).toBe(false);

    gate.resolve(vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(invokedOpenTerminal()).toBe(true);
    const call = invokeMock.mock.calls.find(([command]) => command === "open_terminal");
    expect(call?.[1]).toEqual({
      hostId: "host-1",
      openId: FIXED_OPEN_ID,
      session: "sess-1",
      cols: 80,
      rows: 24,
      sessionId: null,
      serverPid: null,
      serverStartTime: null,
      windowId: null,
      paneId: null,
      panePid: null,
    });
  });

  // Paket 2.5, Aufgabe 5: die `disposed`-Wache in derselben Fortsetzung hatte
  // keinen Test. Alle bestehenden Faelle, die vor dem Aufloesen der
  // `listen()`-Zusagen entsorgen, pruefen SYNCHRON und sehen den
  // nachlaufenden Mikrotask nie. Ohne die Wache oeffnet er einen PTY-Kanal
  // fuer eine bereits entsorgte Ansicht -- dessen Ausgabe niemand mehr
  // bestaetigt, und dessen Platz in der Grenze von acht Kanaelen je Host
  // (Spec §2.5) bis zum Trennen belegt bleibt.
  it("oeffnet KEINEN Kanal mehr, wenn die Ansicht entsorgt wurde, bevor listen() aufloeste", async () => {
    const gate = deferred<() => void>();
    listenMock.mockImplementation(() => gate.promise);

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    await Promise.resolve();
    await Promise.resolve();
    // Vorbedingung: der Aufruf steht wirklich noch aus -- sonst pruefte der
    // Test unten einen Kanal, der ohnehin nie kommen konnte.
    expect(invokedOpenTerminal()).toBe(false);

    handle.dispose();

    gate.resolve(vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(invokedOpenTerminal()).toBe(false);
  });
});

describe("mountTerminal: Fehlerpfad fuer open_terminal", () => {
  it("ruft onError auf, wenn der fire-and-forget open_terminal-Aufruf fehlschlaegt", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "open_terminal") {
        return Promise.reject("no terminal open for this session");
      }
      return Promise.resolve(undefined);
    });

    const onError = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", onError);

    // Zwei Mikrotask-Runden: eine fuer die `.then()`-Sequenzierung nach
    // `listen()`, eine fuer den `.catch()` auf `invoke('open_terminal')`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith({ kind: "open", detail: "no terminal open for this session" });
  });

  it("ruft onError NICHT auf, wenn open_terminal erfolgreich ist", async () => {
    const onError = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", onError);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });
});

// UX-Spec §6.9: jeder Fehlerpfad hat seinen eigenen Text. Den waehlt der
// Aufrufer (`grid.ts`) nach der Art des Fehlers; `onError` traegt dafuer die
// Art und den Rohtext der Ursache, der nur in "Copy details" erscheint.
// Ack-Fehler gehen nur in die Konsole.
describe("mountTerminal: jeder Fehlerpfad meldet seine Art (UX-Spec §6.9)", () => {
  it("meldet ein abgelehntes send_input als Art input", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "send_input" ? Promise.reject("channel closed") : Promise.resolve(undefined));
    const onError = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", onError);

    hoisted.dataListener?.("a");
    await flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "input", detail: "channel closed" });
  });

  it("meldet ein abgelehntes resize_terminal als Art resize", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation((command: string) =>
        command === "resize_terminal" ? Promise.reject("resize failed") : Promise.resolve(undefined));
      const onError = vi.fn();
      mount(document.createElement("div"), "host-1", "sess-1", onError);
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)

      hoisted.size = { cols: 100, rows: 30 };
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);
      await flush();

      expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "resize", detail: "resize failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("schreibt ein abgelehntes ack_output nur in die Konsole, nie an onError", async () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });
    invokeMock.mockImplementation((command: string) =>
      command === "ack_output" ? Promise.reject("ack failed") : Promise.resolve(undefined));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const onError = vi.fn();
      mount(document.createElement("div"), "host-1", "sess-1", onError);
      await flush();

      capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2] } });
      hoisted.writeCalls[0].callback?.();
      await flush();

      // Positivkontrolle: das Ack ist wirklich hinausgegangen.
      expect(invokeMock.mock.calls.some(([command]) => command === "ack_output")).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain("ack failed");
    } finally {
      warn.mockRestore();
    }
  });
});

// Bekannte Fehler des Rasters, behoben am 24.10.: eine grosse Einfuegung ging
// als ein `send_input` hinaus und hielt die Seite Sekunden lang an.
describe("mountTerminal: grosse Eingabe geht in Teilen der Reihe nach", () => {
  /** Jeder `send_input` wartet, bis der Test ihn beantwortet. */
  function heldSends(): { bytes: () => number[][]; answer: (ok?: boolean) => Promise<void> } {
    const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
    invokeMock.mockImplementation((command: string) =>
      command === "send_input"
        ? new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
        : Promise.resolve(undefined));
    return {
      bytes: () =>
        invokeMock.mock.calls
          .filter(([command]) => command === "send_input")
          .map(([, args]) => (args as { bytes: number[] }).bytes),
      answer: async (ok = true) => {
        const next = pending.shift()!;
        if (ok) next.resolve();
        else next.reject("input timed out");
        await flush();
      },
    };
  }

  it("schickt den naechsten Teil erst, wenn der vorige angekommen ist, und nichts geht verloren", async () => {
    const sends = heldSends();
    mount(document.createElement("div"), "host-1", "sess-1");
    const text = "ab".repeat(INPUT_CHUNK_BYTES + 5);

    hoisted.dataListener?.(text);
    await flush();
    expect(sends.bytes().map((part) => part.length)).toEqual([INPUT_CHUNK_BYTES]);
    await sends.answer();
    expect(sends.bytes().map((part) => part.length)).toEqual([INPUT_CHUNK_BYTES, INPUT_CHUNK_BYTES]);
    await sends.answer();
    expect(sends.bytes().map((part) => part.length)).toEqual([INPUT_CHUNK_BYTES, INPUT_CHUNK_BYTES, 10]);
    await sends.answer();
    expect(new TextDecoder().decode(Uint8Array.from(sends.bytes().flat()))).toBe(text);
  });

  it("was waehrenddessen getippt wird, kommt nach der Einfuegung", async () => {
    const sends = heldSends();
    mount(document.createElement("div"), "host-1", "sess-1");

    hoisted.dataListener?.("x".repeat(INPUT_CHUNK_BYTES + 1));
    await flush();
    hoisted.dataListener?.("q");
    await flush();
    expect(sends.bytes()).toHaveLength(1);
    await sends.answer();
    await sends.answer();
    expect(sends.bytes().map((part) => part.length)).toEqual([INPUT_CHUNK_BYTES, 1, 1]);
    expect(sends.bytes()[2]).toEqual([113]);
    await sends.answer();
    // Danach geht ein Tastendruck wieder sofort hinaus.
    hoisted.dataListener?.("r");
    expect(sends.bytes()).toHaveLength(4);
  });

  it("scheitert ein Teil, entfaellt der Rest dieser Eingabe, und es gibt eine Meldung", async () => {
    const sends = heldSends();
    const onError = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", onError);

    hoisted.dataListener?.("x".repeat(3 * INPUT_CHUNK_BYTES));
    await flush();
    await sends.answer(false);
    await flush();

    expect(sends.bytes()).toHaveLength(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "input", detail: "input timed out" });
  });
});

// UX-Spec §5.4, §5.5: die Kachel haengt sich nach einem Kanalverlust still neu
// an. Sie muss wissen, wann der frische Kanal steht (dann verschwindet der
// Hinweis "Reconnecting…"), und solange sie den Hinweis zeigt, sperrt sie die
// Eingabe selbst -- unabhaengig davon, ob der Kanal seinen Verlust schon
// gemeldet hat.
describe("mountTerminal: Wiederanhaengen (UX-Spec §5.5)", () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }

  it("meldet onOpened, sobald open_terminal angehaengt hat", async () => {
    const opening = deferred<void>();
    invokeMock.mockImplementation((command: string) => command === "open_terminal" ? opening.promise : Promise.resolve());
    const onOpened = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onOpened });
    await settle();
    expect(invokedOpenTerminal()).toBe(true);
    expect(onOpened).not.toHaveBeenCalled();
    opening.resolve();
    await settle();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("meldet onOpened nicht, wenn open_terminal scheitert", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "open_terminal" ? Promise.reject("tmux binding query failed (exit 1)") : Promise.resolve());
    const onOpened = vi.fn();
    const onOpenFailed = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onOpened, onOpenFailed });
    await settle();
    expect(onOpenFailed).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("meldet onOpened nicht mehr, wenn die Ansicht vorher entsorgt wurde", async () => {
    const opening = deferred<void>();
    invokeMock.mockImplementation((command: string) => command === "open_terminal" ? opening.promise : Promise.resolve());
    const onOpened = vi.fn();
    const handle = mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onOpened });
    await settle();
    handle.dispose();
    opening.resolve();
    await settle();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("baut wie bisher mit freier Eingabe", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    expect(hoisted.lastOptions?.disableStdin).toBe(false);
  });

  it("sperrt die Eingabe auf Wunsch des Aufrufers und gibt sie wieder frei", async () => {
    const opening = deferred<void>();
    invokeMock.mockImplementation((command: string) => command === "open_terminal" ? opening.promise : Promise.resolve());
    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    handle.setInputLocked(true);
    expect(hoisted.lastOptions?.disableStdin).toBe(true);
    // Das Anhaengen allein hebt die Sperre des Aufrufers nicht auf.
    opening.resolve();
    await settle();
    expect(hoisted.lastOptions?.disableStdin).toBe(true);
    handle.setInputLocked(false);
    expect(hoisted.lastOptions?.disableStdin).toBe(false);
  });

  it("gibt die Eingabe eines verlorenen Kanals nicht frei", async () => {
    const losses: LostListener[] = [];
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://connection-lost") losses.push(handler as LostListener);
      return Promise.resolve(vi.fn());
    });
    const handle = mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onConnectionLost: vi.fn() });
    await settle();
    handle.setInputLocked(true);
    losses[0]({ payload: { host_id: "host-1", session: "sess-1", open_id: FIXED_OPEN_ID } });
    handle.setInputLocked(false);
    expect(hoisted.lastOptions?.disableStdin).toBe(true);
  });

  it("ist nach dem Entsorgen wirkungslos", () => {
    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    handle.dispose();
    handle.setInputLocked(true);
    expect(hoisted.lastOptions?.disableStdin).toBe(false);
  });
});

// B1, Teil 3. Der Aufrufer sperrt auf `onOpenFailed` hin die Eingabe --
// deshalb muss dieser Rueckruf GENAU einen Anlass haben. `onError` feuert an
// mehreren Stellen in `terminal.ts`; eine blosse Kennung daran unterschiede
// "der Kanal ist tot" nicht von "die Zwischenablage nahm nichts an", und
// ein abgelehntes Kopieren sperrte ein voellig gesundes Terminal.
//
// Diese Unterscheidung ist NUR hier pruefbar: `grid.test.ts` und
// `main.test.ts` mocken `terminal` vollstaendig, dort entscheidet der Mock,
// welcher Rueckruf feuert -- ein Test dort bewiese nur, dass er sich selbst
// richtig aufgerufen hat.
describe("mountTerminal: onOpenFailed hat genau einen Anlass", () => {
  it("feuert, wenn open_terminal abgelehnt wird", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "open_terminal") return Promise.reject("channel limit reached");
      return Promise.resolve(undefined);
    });

    const onOpenFailed = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onOpenFailed });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenFailed).toHaveBeenCalledTimes(1);
  });

  it("feuert NICHT, wenn nur das Kopieren in die Zwischenablage scheitert", async () => {
    clipboardWriteText.mockRejectedValue(new Error("clipboard denied"));

    const onError = vi.fn();
    const onOpenFailed = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", onError, { onOpenFailed });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    hoisted.selection = "some output";
    fireKey({ key: "c", ctrlKey: true, shiftKey: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Positivkontrolle: der Fehler ist wirklich passiert -- ohne sie waere
    // dieser Test auch dann gruen, wenn Ctrl+Shift+C gar nicht ankam.
    expect(onError).toHaveBeenCalled();
    expect(onOpenFailed).not.toHaveBeenCalled();
  });

  it("zeigt no terminal open von resize nicht, solange open_terminal noch laeuft", async () => {
    vi.useFakeTimers();
    try {
      const opening = deferred<void>();
      invokeMock.mockImplementation((command: string) => {
        if (command === "open_terminal") return opening.promise;
        if (command === "resize_terminal") {
          return Promise.reject("no terminal open for this session");
        }
        return Promise.resolve(undefined);
      });
      const onError = vi.fn();
      mount(document.createElement("div"), "host-1", "sess-1", onError);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      hoisted.size = { cols: 100, rows: 30 };
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).not.toHaveBeenCalled();
      opening.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("feuert NICHT, wenn resize_terminal scheitert", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation((command: string) => {
        if (command === "resize_terminal") return Promise.reject("resize failed");
        return Promise.resolve(undefined);
      });

      const onError = vi.fn();
      const onOpenFailed = vi.fn();
      mount(document.createElement("div"), "host-1", "sess-1", onError, { onOpenFailed });
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)

      hoisted.size = { cols: 100, rows: 30 };
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);

      // Positivkontrolle wie oben: der Aufruf ist wirklich rausgegangen.
      expect(
        invokeMock.mock.calls.some(([command]) => command === "resize_terminal"),
      ).toBe(true);
      expect(onOpenFailed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Die `disposed`-Wache VOR dem `invoke` hilft hier nicht: zwischen
  // Absenden und Ablehnung liegt eine Netzrunde, und ein Layoutwechsel
  // unmittelbar nach dem Oeffnen entsorgt den Handle genau darin. Ohne die
  // zweite Pruefung im `.catch` sperrte der Aufrufer eine Session, die gar
  // keine Kachel mehr hat -- die Seitenleiste zeigte dann dauerhaft
  // "Input locked" fuer eine geschlossene Session.
  it("feuert NICHT, wenn der Handle vor der Ablehnung entsorgt wurde", async () => {
    // `deferred()` oben kann nur aufloesen; hier wird die ABLEHNUNG von
    // aussen ausgeloest, nachdem der Handle entsorgt ist.
    let rejectOpen!: (reason: unknown) => void;
    const pending = new Promise<never>((_, reject) => {
      rejectOpen = reject;
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "open_terminal") return pending;
      return Promise.resolve(undefined);
    });

    const onOpenFailed = vi.fn();
    const handle = mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), {
      onOpenFailed,
    });
    await Promise.resolve();
    await Promise.resolve();

    handle.dispose();
    rejectOpen("too late");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenFailed).not.toHaveBeenCalled();
  });
});

describe("mountTerminal: Ack-Nachbestaetigung bei dispose()", () => {
  it("bestaetigt beim dispose() die Summe der noch ausstehenden, nie gefeuerten write()-Callbacks in einem Aufruf", () => {
    // Gegenprobe zu Befund 2: xterm.js' WriteBuffer plant `write()` per
    // `setTimeout`; `term.dispose()` storniert diesen Timer nicht und
    // garantiert kein Nachfeuern. Ohne die Nachbestaetigung in
    // `dispose()` bliebe `ack_output` fuer diese Bytes fuer immer aus --
    // dieser Test simuliert genau das, indem der Callback absichtlich NIE
    // aufgerufen wird.
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } }); // 3 Byte
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [4, 5] } }); // 2 Byte

    expect(hoisted.writeCalls).toHaveLength(2);
    expect(
      invokeMock.mock.calls.some(([command]) => command === "ack_output"),
    ).toBe(false);

    handle.dispose();

    const ackCalls = invokeMock.mock.calls.filter(([command]) => command === "ack_output");
    expect(ackCalls).toHaveLength(1);
    expect((ackCalls[0][1] as { byteCount: number }).byteCount).toBe(5);
  });

  it("bestaetigt nicht doppelt, wenn ein write()-Callback nach dispose() doch noch feuert", () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } }); // 3 Byte

    handle.dispose();
    // dispose() hat die 3 Byte bereits nachbestaetigt. xterm.js' Timer
    // koennte trotzdem noch nachfeuern -- simuliert durch expliziten
    // Aufruf des gespeicherten Callbacks.
    hoisted.writeCalls[0].callback?.();

    const ackCalls = invokeMock.mock.calls.filter(([command]) => command === "ack_output");
    expect(ackCalls).toHaveLength(1);
    expect((ackCalls[0][1] as { byteCount: number }).byteCount).toBe(3);
  });

  it("bestaetigt beim dispose() nichts, wenn keine Bytes ausstehen", () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } });
    hoisted.writeCalls[0].callback?.(); // regulaer bestaetigt, bevor dispose() laeuft

    invokeMock.mockClear();
    handle.dispose();

    expect(
      invokeMock.mock.calls.some(([command]) => command === "ack_output"),
    ).toBe(false);
  });

  it("schliesst beim dispose() den PTY-Kanal per close_terminal", async () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    // Nur eine Ansicht, die ihr `open_terminal` gesendet hat, schliesst beim
    // Entsorgen (das Backend kennt ihre openId erst damit).
    await flush();
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } });
    hoisted.writeCalls[0].callback?.(); // regulaer bestaetigt

    invokeMock.mockClear();
    handle.dispose();

    expect(invokeMock).toHaveBeenCalledWith("close_terminal", {
      hostId: "host-1",
      openId: FIXED_OPEN_ID,
      session: "sess-1",
    });
  });

  // Die Reihenfolge ist Teil der Zusicherung, nicht nur der Aufruf:
  // `ack_output_impl` liefert fuer einen fehlenden Map-Eintrag
  // `Err("no terminal open for this session")`. Kaeme `close_terminal`
  // ZUERST, wuerde die Sammel-Bestaetigung fehlschlagen und ueber `onError`
  // eine irrefuehrende Meldung erzeugen -- fuer einen Vorgang, der voellig
  // in Ordnung war. Ein Test, der nur "close_terminal wurde gerufen" prueft,
  // bliebe bei genau dieser Vertauschung gruen.
  it("bestaetigt ausstehende Bytes VOR dem close_terminal", async () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    await flush(); // open_terminal ist hinaus: erst dann schliesst das Entsorgen
    // Bytes ankommen lassen, Callback NICHT feuern -> sie bleiben ausstehend
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3, 4] } });

    invokeMock.mockClear();
    handle.dispose();

    const order = invokeMock.mock.calls
      .map(([command]) => command)
      .filter((command) => command === "ack_output" || command === "close_terminal");
    expect(order).toEqual(["ack_output", "close_terminal"]);
  });

  // Paket 2.5, Aufgabe 2: das letzte Glied der Fokuskette. `grid.test.ts` und
  // `main.test.ts` mocken `./terminal` dateiweit -- sie pruefen, DASS
  // `focus()` gerufen wird, nie, dass es etwas tut. Ohne diesen Test liess
  // sich der Rumpf durch `focus() {}` ersetzen, ohne dass ein einziger der
  // 383 Tests es merkte (Gutachten zu diesem Paket).
  it("reicht focus() an das Terminal weiter -- und nach dem Entsorgen nicht mehr", () => {
    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    // Vorbedingung: das Montieren allein fokussiert nicht (der Fokuswunsch
    // reist mit der Aktion, siehe `GridHandle.focusActiveTile`).
    expect(hoisted.focusCalls).toBe(0);

    handle.focus();
    expect(hoisted.focusCalls).toBe(1);

    // Nach dem Entsorgen hat xterm sein Hilfstextfeld aus dem Dokument
    // genommen -- ein `focus()` darauf waere ein Fokus ins Nichts, der
    // Fokus fiele auf `<body>`.
    handle.dispose();
    handle.focus();
    expect(hoisted.focusCalls).toBe(1);
  });

  // Paket 2.5, Aufgabe 6, Punkt 1: die Begruendung fuer das Weiterreichen an
  // `onError` stuetzte sich auf `closeTerminalView` (main.ts), das es seit
  // Shell-Task 11 nicht mehr gibt. Heute landet `onError` im globalen
  // Hinweisbanner -- ein voellig gewoehnliches Schliessen erzeugte dort ein
  // rot stehen bleibendes "Could not open the terminal: no terminal open for
  // this session".
  it("meldet einen Fehlschlag auf dem Entsorgungsweg NICHT als Terminalfehler", async () => {
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });
    const onError = vi.fn();
    const handle = mount(document.createElement("div"), "host-1", "sess-1", onError);
    await flush(); // open_terminal ist hinaus: erst dann schliesst das Entsorgen
    // Ausstehende Bytes, damit BEIDE Aufrufe des Entsorgungswegs fallen.
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } });

    invokeMock.mockImplementation((command: string) => {
      if (command === "ack_output" || command === "close_terminal") {
        return Promise.reject("no terminal open for this session");
      }
      return Promise.resolve(undefined);
    });

    handle.dispose();
    await Promise.resolve();
    await Promise.resolve();

    // Vorbedingung: die beiden Aufrufe sind wirklich gefallen (und
    // gescheitert) -- sonst pruefte die Zusicherung darunter nichts.
    const attempted = invokeMock.mock.calls
      .map(([command]) => command)
      .filter((command) => command === "ack_output" || command === "close_terminal");
    expect(attempted).toEqual(["ack_output", "close_terminal"]);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("mountTerminal: Resize-Entprellung", () => {
  it("loest resize_terminal nicht beim Mounten aus und buendelt mehrere Resize-Events bei einer echten Groessenaenderung in einen einzigen Aufruf nach 300 ms", async () => {
    vi.useFakeTimers();
    try {
      mount(document.createElement("div"), "host-1", "sess-1");
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)
      expect(
        invokeMock.mock.calls.some(([command]) => command === "resize_terminal"),
      ).toBe(false);

      // Echte Groessenaenderung simulieren -- ohne sie waere jeder der
      // folgenden `resize`-Events vom Wachhund (Befund 1) zu Recht
      // verschluckt, weil `fit()` dieselbe Groesse liefern wuerde, die
      // bereits per `open_terminal` gemeldet wurde (siehe Testfall unten).
      hoisted.size = { cols: 100, rows: 30 };

      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(100);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(100);
      window.dispatchEvent(new Event("resize"));

      expect(
        invokeMock.mock.calls.some(([command]) => command === "resize_terminal"),
      ).toBe(false);

      vi.advanceTimersByTime(300);

      const resizeCalls = invokeMock.mock.calls.filter(
        ([command]) => command === "resize_terminal",
      );
      expect(resizeCalls).toHaveLength(1);
      expect(resizeCalls[0][1]).toEqual({
        hostId: "host-1",
        openId: FIXED_OPEN_ID,
        session: "sess-1",
        cols: 100,
        rows: 30,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ruft resize_terminal NICHT auf, wenn ein Resize-Event ankommt, ohne dass sich die Groesse gegenueber der beim Mounten gefitteten (= an open_terminal gemeldeten) Groesse geaendert hat", async () => {
    // Konkretes Szenario: DevTools auf und zu (oder ein
    // Pixel-Ruckler) loest ein `resize`-Event aus, direkt nach dem
    // Verbinden -- `fit()` liefert danach aber dieselbe Groesse wie beim
    // Mounten (`hoisted.size` bleibt unveraendert). Das ist der Test, der
    // den Wachhund am haertesten prueft: der `lastSentCols`/
    // `lastSentRows`-Wachhund muss bereits VOR dem allerersten
    // `resize`-Event geseedet sein (mit der gefitteten Groesse aus dem
    // Mounten, nicht erst beim ersten tatsaechlichen
    // `resize_terminal`-Aufruf) -- sonst waere ausgerechnet dieser erste
    // Event ungeschuetzt.
    vi.useFakeTimers();
    try {
      mount(document.createElement("div"), "host-1", "sess-1");
      // Angehaengt: vorher sendet ein Refit ohnehin nichts (Abnahme B1), der
      // Test bewiese dann nichts ueber den Wachhund.
      await flush();

      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);

      expect(
        invokeMock.mock.calls.some(([command]) => command === "resize_terminal"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ruft resize_terminal kein zweites Mal auf, wenn cols/rows gegenueber dem zuletzt gesendeten Wert unveraendert sind", async () => {
    // Gegenprobe zum Wachhund (Befund 1): nach einer echten
    // Groessenaenderung (die den ersten Aufruf ausloest) bleibt die
    // Groesse fuer ein zweites, unabhaengiges Entprellungsfenster
    // unveraendert -- das darf keinen zweiten Aufruf ausloesen. Ohne den
    // `lastSentCols`/`lastSentRows`-Vergleich in `terminal.ts` wuerde
    // dieser Test rot: zwei separate 300-ms-Fenster ergaeben zwei
    // Aufrufe statt einem.
    vi.useFakeTimers();
    try {
      mount(document.createElement("div"), "host-1", "sess-1");
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)

      hoisted.size = { cols: 100, rows: 30 };
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "resize_terminal"),
      ).toHaveLength(1);

      // Zweites, unabhaengiges Entprellungsfenster -- keine neue Groesse.
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);

      const resizeCalls = invokeMock.mock.calls.filter(
        ([command]) => command === "resize_terminal",
      );
      expect(resizeCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Task 10 (Kachelraster): `TerminalHandle.refit()` ist der Weg, ueber den der
// Kachelcontroller Layoutwechsel/Maximieren/Seitenleisten-Ziehen entprellt --
// OHNE einen zweiten, eigenen Timer zu fuehren (Designsystem §5.5). Diese
// beiden Tests pruefen genau die Eigenschaft, auf die sich `grid.ts` verlaesst:
// `refit()` startet/verlaengert DENSELBEN Timer wie `window`-Resize, statt
// sofort zu senden oder einen unabhaengigen zweiten Pfad zu eroeffnen.
describe("mountTerminal: refit() (Task 10, Kachelraster)", () => {
  it("sendet resize_terminal nicht sofort, sondern erst nach 300 ms, und buendelt mehrere refit()-Aufrufe in einen einzigen", async () => {
    vi.useFakeTimers();
    try {
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)
      hoisted.size = { cols: 120, rows: 40 };

      handle.refit();
      expect(
        invokeMock.mock.calls.some(([command]) => command === "resize_terminal"),
      ).toBe(false);

      vi.advanceTimersByTime(100);
      handle.refit();
      vi.advanceTimersByTime(100);
      handle.refit();
      expect(
        invokeMock.mock.calls.some(([command]) => command === "resize_terminal"),
      ).toBe(false);

      vi.advanceTimersByTime(300);
      const resizeCalls = invokeMock.mock.calls.filter(
        ([command]) => command === "resize_terminal",
      );
      expect(resizeCalls).toHaveLength(1);
      expect(resizeCalls[0][1]).toEqual({
        hostId: "host-1",
        openId: FIXED_OPEN_ID,
        session: "sess-1",
        cols: 120,
        rows: 40,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("teilt sich den Timer mit einem echten window-Resize-Event -- kein zweiter, unabhaengiger Aufruf", async () => {
    // Gegenprobe zur "ein einziger Pfad"-Anforderung: ruft `refit()` UND
    // dispatcht kurz danach ein echtes `resize`-Event, muss das EINE
    // Entprellungsfenster ergeben, nicht zwei. Waere `refit()` ein
    // eigenstaendiger zweiter Timer, kaeme hier zweimal `resize_terminal`.
    vi.useFakeTimers();
    try {
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)
      hoisted.size = { cols: 90, rows: 26 };

      handle.refit();
      vi.advanceTimersByTime(150);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);

      const resizeCalls = invokeMock.mock.calls.filter(
        ([command]) => command === "resize_terminal",
      );
      expect(resizeCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Spec 2026-10-19 §8.4: `onSize` meldet Spalten und Zeilen nach jedem Fit; der
// Aufrufer zeigt damit, ob die Kachel schmaler als 80 x 20 ist. Die Meldung
// steht im Refit VOR beiden vorzeitigen Ausgaengen (gleiche Groesse, Kanal
// zu): der Kopf zeigt die Groesse der Kachel, nicht ob ein `resize_terminal`
// noetig war.
describe("mountTerminal: Groesse nach dem Fit (Spec 2026-10-19 §8.4)", () => {
  it("meldet Spalten und Zeilen nach dem ersten Fit und nach jedem Refit", () => {
    vi.useFakeTimers();
    try {
      const onSize = vi.fn();
      const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, { onSize });
      expect(onSize).toHaveBeenLastCalledWith(80, 24);
      hoisted.size = { cols: 70, rows: 18 };
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(onSize).toHaveBeenLastCalledWith(70, 18);
    } finally {
      vi.useRealTimers();
    }
  });

  it("meldet auch einen Refit, der die Groesse nicht aendert", () => {
    vi.useFakeTimers();
    try {
      const onSize = vi.fn();
      const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, { onSize });
      expect(onSize).toHaveBeenCalledTimes(1);
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(onSize).toHaveBeenCalledTimes(2);
      expect(onSize).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("meldet auch nach connection-lost: die Sperrleiste aendert die Groesse der Kachel", () => {
    vi.useFakeTimers();
    try {
      let lost: LostListener | undefined;
      listenMock.mockImplementation((event, handler) => {
        if (event === "terminal://connection-lost") lost = handler as LostListener;
        return Promise.resolve(vi.fn());
      });
      const onSize = vi.fn();
      const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, { onSize });
      lost?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1" } });
      hoisted.size = { cols: 70, rows: 18 };
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(onSize).toHaveBeenLastCalledWith(70, 18);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Abnahme B1 (Spec 2026-10-19 §4.5, §10.2): solange `open_terminal` aussteht,
// kennt das Backend den Kanal nicht -- ein `resize_terminal` aus diesem Fenster
// wurde abgewiesen und verschluckt, die neue Groesse galt aber als gesendet.
// Neun Kacheln nach einem Neustart blieben so in der Zwischengroesse stehen.
describe("mountTerminal: Groesse waehrend open_terminal (Abnahme B1)", () => {
  function resizeCalls(): unknown[][] {
    return invokeMock.mock.calls.filter(([command]) => command === "resize_terminal");
  }

  function resizeTo(cols: number, rows: number): unknown[] {
    return ["resize_terminal", { hostId: "host-1", session: "sess-1", openId: FIXED_OPEN_ID, cols, rows }];
  }

  /** `open_terminal` haengt, bis der Test es aufloest; alles andere gelingt. */
  function holdOpen(): { resolve: () => void } {
    const opening = deferred<void>();
    invokeMock.mockImplementation((command: string) =>
      command === "open_terminal" ? opening.promise : Promise.resolve(undefined));
    return { resolve: () => opening.resolve() };
  }

  it("ein Refit vor dem Anhaengen fittet und meldet die Groesse, sendet aber nichts; danach geht sie genau einmal hinaus", async () => {
    vi.useFakeTimers();
    try {
      const opening = holdOpen();
      const onSize = vi.fn();
      const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, { onSize });
      await flush();
      expect(invokedOpenTerminal()).toBe(true);

      hoisted.size = { cols: 100, rows: 30 };
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(onSize).toHaveBeenLastCalledWith(100, 30);
      expect(resizeCalls()).toEqual([]);

      opening.resolve();
      await flush();
      expect(resizeCalls()).toEqual([resizeTo(100, 30)]);

      // Dieselbe Groesse geht kein zweites Mal hinaus.
      handle.refit();
      vi.advanceTimersByTime(1000);
      expect(resizeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kehrt die Groesse vor dem Anhaengen zur geoeffneten zurueck, geht nichts hinaus", async () => {
    vi.useFakeTimers();
    try {
      const opening = holdOpen();
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush();

      hoisted.size = { cols: 100, rows: 30 };
      handle.refit();
      vi.advanceTimersByTime(300);
      hoisted.size = { cols: 80, rows: 24 };
      handle.refit();
      vi.advanceTimersByTime(300);
      opening.resolve();
      await flush();
      vi.advanceTimersByTime(1000);

      expect(resizeCalls()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("open_terminal traegt die Groesse zum Zeitpunkt des Absendens; ein Refit davor sendet nichts und holt nichts nach", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<() => void>();
      listenMock.mockImplementation(() => gate.promise);
      const handle = mount(document.createElement("div"), "host-1", "sess-1");

      hoisted.size = { cols: 100, rows: 30 };
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(resizeCalls()).toEqual([]);

      gate.resolve(vi.fn());
      await flush();
      const open = invokeMock.mock.calls.find(([command]) => command === "open_terminal");
      expect(open?.[1]).toEqual(expect.objectContaining({ cols: 100, rows: 30 }));
      vi.advanceTimersByTime(1000);
      expect(resizeCalls()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("steht beim Anhaengen noch ein Refit aus, geht genau ein resize_terminal hinaus, mit der Groesse nach dessen Fit", async () => {
    vi.useFakeTimers();
    try {
      const opening = holdOpen();
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush();

      // Ein erster Refit fittet waehrend des Oeffnens (Zwischenlage) ...
      hoisted.size = { cols: 100, rows: 30 };
      handle.refit();
      vi.advanceTimersByTime(300);
      // ... die Flaeche aendert sich erneut, ihr Refit steht noch aus.
      handle.refit();
      opening.resolve();
      await flush();
      // Was der ausstehende Fit misst (der Mock liest `hoisted.size`).
      hoisted.size = { cols: 120, rows: 40 };
      vi.advanceTimersByTime(300);

      expect(resizeCalls()).toEqual([resizeTo(120, 40)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ein abgelehntes open_terminal sendet nie ein resize_terminal, auch nicht bei spaeteren Refits", async () => {
    vi.useFakeTimers();
    try {
      let rejectOpen!: (reason: unknown) => void;
      const opening = new Promise<never>((_, reject) => {
        rejectOpen = reject;
      });
      invokeMock.mockImplementation((command: string) =>
        command === "open_terminal" ? opening : Promise.resolve(undefined));
      const onOpenFailed = vi.fn();
      const handle = mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onOpenFailed });
      await flush();

      hoisted.size = { cols: 100, rows: 30 };
      handle.refit();
      vi.advanceTimersByTime(300);
      rejectOpen("channel limit reached");
      await flush();
      expect(onOpenFailed).toHaveBeenCalledOnce();

      hoisted.size = { cols: 120, rows: 40 };
      handle.refit();
      vi.advanceTimersByTime(300);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);

      expect(resizeCalls()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("eine vor dem Anhaengen entsorgte Ansicht sendet kein resize_terminal", async () => {
    vi.useFakeTimers();
    try {
      const opening = holdOpen();
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush();

      hoisted.size = { cols: 100, rows: 30 };
      handle.refit();
      vi.advanceTimersByTime(300);
      // Kein Refit steht mehr aus: sonst liesse schon dessen Zeitgeber-Kennung
      // das Nachholen aus, und die Wache gegen das Entsorgen bliebe ungeprueft.
      handle.dispose();
      opening.resolve();
      await flush();
      vi.advanceTimersByTime(1000);

      expect(resizeCalls()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Spec 2026-10-19 §8.1 (Schritt 3): bei bis zu acht Kacheln je Host gehen
// hoechstens vier `open_terminal` zugleich hinaus. Die Schlange reicht der
// Aufrufer herein (`MountOptions.openQueue`); ohne sie bleibt alles wie oben,
// und die Tests dort zaehlen weiter Mikroaufgaben. Jeder Test baut seine
// eigene Schlange: ein gesendetes, nie beantwortetes Oeffnen haelt seinen
// Platz auch ueber das Entsorgen in `afterEach` hinaus.
describe("mountTerminal: Oeffnen ueber die Schlange je Host (Spec 2026-10-19 §8.1)", () => {
  interface HeldOpen {
    resolve: () => void;
    reject: (reason: unknown) => void;
  }

  /** Jedes `open_terminal` haengt, bis der Test es aufloest oder ablehnt;
   * alles andere gelingt sofort. Schluessel ist "hostId/session". */
  function holdOpens(): Map<string, HeldOpen> {
    const held = new Map<string, HeldOpen>();
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command !== "open_terminal") return Promise.resolve(undefined);
      const { hostId, session } = args as { hostId: string; session: string };
      return new Promise<void>((resolve, reject) => {
        held.set(`${hostId}/${session}`, { resolve: () => resolve(), reject });
      });
    });
    return held;
  }

  /** Die gesendeten `open_terminal` als "hostId/session", in Sendereihenfolge. */
  function opened(): string[] {
    return invokeMock.mock.calls
      .filter(([command]) => command === "open_terminal")
      .map(([, args]) => {
        const { hostId, session } = args as { hostId: string; session: string };
        return `${hostId}/${session}`;
      });
  }

  /** Die gesendeten `close_terminal` als "hostId/session", in Sendereihenfolge. */
  function closed(): string[] {
    return invokeMock.mock.calls
      .filter(([command]) => command === "close_terminal")
      .map(([, args]) => {
        const { hostId, session } = args as { hostId: string; session: string };
        return `${hostId}/${session}`;
      });
  }

  /** Die gesendeten `resize_terminal` mit Sitzung und Groesse, in Sendereihenfolge. */
  function resized(): Array<{ session: string; cols: number; rows: number }> {
    return invokeMock.mock.calls
      .filter(([command]) => command === "resize_terminal")
      .map(([, args]) => {
        const { session, cols, rows } = args as { session: string; cols: number; rows: number };
        return { session, cols, rows };
      });
  }

  function mountOnQueue(
    queue: OpenQueue,
    hostId: string,
    session: string,
    extra: Partial<MountOptions> = {},
  ): TerminalHandle {
    return mount(document.createElement("div"), hostId, session, undefined, { openQueue: queue, ...extra });
  }

  it("mit freiem Platz geht open_terminal so frueh hinaus wie ohne Schlange", async () => {
    mountOnQueue(createOpenQueue(), "host-1", "sess-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(invokedOpenTerminal()).toBe(true);
  });

  it("acht Kacheln eines Hosts senden genau vier open_terminal, in der Reihenfolge des Mountens (Review Focus 1)", async () => {
    holdOpens();
    const queue = createOpenQueue(4);
    for (let i = 1; i <= 8; i++) mountOnQueue(queue, "host-1", `sess-${i}`);
    await flush();
    expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-2", "host-1/sess-3", "host-1/sess-4"]);
    expect(queue.inFlight("host-1")).toBe(4);
    expect(queue.waiting("host-1")).toBe(4);
  });

  it.each([
    ["angenommen", (open: HeldOpen) => open.resolve()],
    ["abgelehnt", (open: HeldOpen) => open.reject("tmux binding query failed (exit 1)")],
  ])("jede Antwort auf open_terminal laesst genau ein weiteres los: %s", async (_name, settle) => {
    const held = holdOpens();
    const queue = createOpenQueue(4);
    for (let i = 1; i <= 8; i++) mountOnQueue(queue, "host-1", `sess-${i}`);
    await flush();

    settle(held.get("host-1/sess-2")!);
    await flush();
    expect(opened()).toHaveLength(5);
    expect(opened()[4]).toBe("host-1/sess-5");

    settle(held.get("host-1/sess-1")!);
    settle(held.get("host-1/sess-4")!);
    await flush();
    expect(opened().slice(5)).toEqual(["host-1/sess-6", "host-1/sess-7"]);
    expect(queue.inFlight("host-1")).toBe(4);
    expect(queue.waiting("host-1")).toBe(1);

    for (const key of ["host-1/sess-3", "host-1/sess-5", "host-1/sess-6", "host-1/sess-7"]) settle(held.get(key)!);
    await flush();
    expect(opened()).toHaveLength(8);
    settle(held.get("host-1/sess-8")!);
    await flush();
    expect(queue.inFlight("host-1")).toBe(0);
    expect(queue.waiting("host-1")).toBe(0);
  });

  it("ein wartendes Oeffnen traegt die Groesse beim Absenden; ein Refit in der Wartezeit fittet und meldet nur (Abnahme B1)", async () => {
    vi.useFakeTimers();
    try {
      const held = holdOpens();
      const queue = createOpenQueue(1);
      mountOnQueue(queue, "host-1", "sess-1");
      const onSize = vi.fn();
      const waiting = mountOnQueue(queue, "host-1", "sess-2", { onSize });
      await flush();
      expect(opened()).toEqual(["host-1/sess-1"]);

      hoisted.size = { cols: 100, rows: 30 };
      waiting.refit();
      vi.advanceTimersByTime(300);
      expect(onSize).toHaveBeenLastCalledWith(100, 30);

      // Der Mock kennt nur eine Groesse fuer alle Terminals; ein angehaengtes
      // erstes Terminal holte sie per B1 nach. Darum macht hier ein
      // abgelehntes Oeffnen den Platz frei.
      held.get("host-1/sess-1")!.reject("session not found");
      await flush();
      const open = invokeMock.mock.calls.find(
        ([command, args]) => command === "open_terminal" && (args as { session: string }).session === "sess-2",
      );
      expect(open?.[1]).toEqual(expect.objectContaining({ cols: 100, rows: 30 }));

      held.get("host-1/sess-2")!.resolve();
      await flush();
      vi.advanceTimersByTime(1000);
      // Mit dieser Groesse angehaengt: nichts nachzuholen.
      expect(invokeMock.mock.calls.filter(([command]) => command === "resize_terminal")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("eine zugeteilte Ansicht holt eine Groesse, die sich nach dem Senden aendert, nach der Antwort genau einmal nach (Abnahme B1)", async () => {
    vi.useFakeTimers();
    try {
      const held = holdOpens();
      const queue = createOpenQueue(1);
      mountOnQueue(queue, "host-1", "sess-1");
      const granted = mountOnQueue(queue, "host-1", "sess-2");
      await flush();
      expect(opened()).toEqual(["host-1/sess-1"]);

      // Die Antwort der ersten Ansicht teilt der zweiten ihren Platz zu; sie
      // sendet mit der Groesse von jetzt. Die erste ist angehaengt, bevor sich
      // die gemeinsame Groesse des Mocks aendert, und holt darum nichts nach.
      held.get("host-1/sess-1")!.resolve();
      await flush();
      expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-2"]);
      expect(resized()).toEqual([]);

      // Waehrend ihr Oeffnen laeuft, aendert sich die Groesse: der Refit fittet
      // und meldet nur, vor der Antwort geht nichts hinaus.
      hoisted.size = { cols: 100, rows: 30 };
      granted.refit();
      vi.advanceTimersByTime(300);
      expect(resized()).toEqual([]);

      held.get("host-1/sess-2")!.resolve();
      await flush();
      expect(resized()).toEqual([{ session: "sess-2", cols: 100, rows: 30 }]);
      // Dieselbe Groesse geht kein zweites Mal hinaus.
      vi.advanceTimersByTime(1000);
      expect(resized()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("eine wartende Ansicht, die entsorgt wird, sendet nie ein open_terminal und gibt keinen Platz frei (Review Focus 2)", async () => {
    const held = holdOpens();
    const queue = createOpenQueue(1);
    mountOnQueue(queue, "host-1", "sess-1");
    const onQueued = vi.fn();
    const waiting = mountOnQueue(queue, "host-1", "sess-2", { onQueued });
    mountOnQueue(queue, "host-1", "sess-3");
    await flush();
    expect(queue.waiting("host-1")).toBe(2);

    waiting.dispose();
    expect(queue.waiting("host-1")).toBe(1);
    expect(queue.inFlight("host-1")).toBe(1);
    await flush();
    expect(opened()).toEqual(["host-1/sess-1"]);

    // Der naechste freie Platz geht an die naechste wartende Ansicht.
    held.get("host-1/sess-1")!.resolve();
    await flush();
    expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-3"]);
    expect(onQueued.mock.calls).toEqual([[true]]);
  });

  // Das Backend lernt die openId einer Ansicht erst mit ihrem `open_terminal`
  // kennen und vergleicht sie beim Schliessen; ein `close_terminal` fuer eine
  // Ansicht, die nie gesendet hat, traefe nichts und kostete nur einen Aufruf.
  // Der zweite Teil haelt fest, dass eine gesendete weiter schliesst, auch
  // solange ihre Antwort aussteht.
  it("eine wartende Ansicht, die vor ihrer Zuteilung entsorgt wird, sendet kein close_terminal; eine Ansicht mit gesendetem open_terminal schliesst beim Entsorgen", async () => {
    holdOpens();
    const queue = createOpenQueue(1);
    const sent = mountOnQueue(queue, "host-1", "sess-1");
    const waiting = mountOnQueue(queue, "host-1", "sess-2");
    await flush();
    expect(opened()).toEqual(["host-1/sess-1"]);

    waiting.dispose();
    await flush();
    expect(closed()).toEqual([]);

    sent.dispose();
    expect(closed()).toEqual(["host-1/sess-1"]);
  });

  it.each([
    ["angenommen", (open: HeldOpen) => open.resolve()],
    ["abgelehnt", (open: HeldOpen) => open.reject("session not found")],
  ])("nach dem Absenden gibt erst die Antwort den Platz frei, nicht das Entsorgen: %s", async (_name, settle) => {
    const held = holdOpens();
    const queue = createOpenQueue(1);
    const onOpened = vi.fn();
    const onOpenFailed = vi.fn();
    const sent = mountOnQueue(queue, "host-1", "sess-1", { onOpened, onOpenFailed });
    mountOnQueue(queue, "host-1", "sess-2");
    await flush();
    expect(opened()).toEqual(["host-1/sess-1"]);

    // Das Backend haelt die Einrichtung, bis es antwortet: der Platz bleibt belegt.
    sent.dispose();
    expect(queue.inFlight("host-1")).toBe(1);
    expect(queue.waiting("host-1")).toBe(1);
    await flush();
    expect(opened()).toEqual(["host-1/sess-1"]);

    settle(held.get("host-1/sess-1")!);
    await flush();
    expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-2"]);
    // Die entsorgte Ansicht meldet nichts mehr.
    expect(onOpened).not.toHaveBeenCalled();
    expect(onOpenFailed).not.toHaveBeenCalled();
  });

  it("ein anderer Host wartet nicht auf die volle Schlange des ersten", async () => {
    holdOpens();
    const queue = createOpenQueue(4);
    for (let i = 1; i <= 5; i++) mountOnQueue(queue, "host-1", `sess-${i}`);
    const onQueued = vi.fn();
    mountOnQueue(queue, "host-2", "sess-1", { onQueued });
    await flush();
    expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-2", "host-1/sess-3", "host-1/sess-4", "host-2/sess-1"]);
    expect(onQueued).not.toHaveBeenCalled();
    expect(queue.waiting("host-1")).toBe(1);
    expect(queue.inFlight("host-2")).toBe(1);
  });

  it("nach dem Neuverbinden reihen sich die Ansichten unter der neuen Laufzeit-ID ein; spaete Antworten der alten geben nur deren Plaetze frei (Review Focus 2)", async () => {
    const held = holdOpens();
    const queue = createOpenQueue(4);
    const before = [1, 2, 3, 4, 5].map((i) => mountOnQueue(queue, "rt-1", `sess-${i}`));
    await flush();
    // Die Verbindung stirbt; das Raster entsorgt alle Ansichten des Hosts.
    for (const handle of before) handle.dispose();
    expect(queue.inFlight("rt-1")).toBe(4);
    expect(queue.waiting("rt-1")).toBe(0);

    for (let i = 1; i <= 5; i++) mountOnQueue(queue, "rt-2", `sess-${i}`);
    await flush();
    expect(opened().filter((key) => key.startsWith("rt-2/"))).toEqual([
      "rt-2/sess-1",
      "rt-2/sess-2",
      "rt-2/sess-3",
      "rt-2/sess-4",
    ]);

    // Die alten Oeffnungen scheitern spaet an der toten Verbindung.
    for (let i = 1; i <= 4; i++) held.get(`rt-1/sess-${i}`)!.reject("host disconnected during terminal setup");
    await flush();
    expect(queue.inFlight("rt-1")).toBe(0);
    expect(queue.waiting("rt-2")).toBe(1);
    expect(opened()).toHaveLength(8);
    expect(opened()).not.toContain("rt-1/sess-5");
  });

  it("onQueued meldet true noch im Mounten und false bei der Zuteilung; eine sofort zugeteilte Ansicht meldet nichts", async () => {
    const held = holdOpens();
    const queue = createOpenQueue(1);
    const firstQueued = vi.fn();
    mountOnQueue(queue, "host-1", "sess-1", { onQueued: firstQueued });
    const onQueued = vi.fn();
    mountOnQueue(queue, "host-1", "sess-2", { onQueued });
    // Synchron, noch vor dem ersten Mikrotask.
    expect(onQueued.mock.calls).toEqual([[true]]);
    await flush();
    expect(onQueued.mock.calls).toEqual([[true]]);

    held.get("host-1/sess-1")!.resolve();
    await flush();
    expect(onQueued.mock.calls).toEqual([[true], [false]]);
    expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-2"]);

    // Das Anhaengen selbst meldet nichts mehr.
    held.get("host-1/sess-2")!.resolve();
    await flush();
    expect(onQueued.mock.calls).toEqual([[true], [false]]);
    expect(firstQueued).not.toHaveBeenCalled();
  });

  it("onQueued(false) laeuft vor dem Senden: entsorgt der Aufrufer die Ansicht darin, sendet sie nie und gibt ihren Platz weiter", async () => {
    const held = holdOpens();
    const queue = createOpenQueue(1);
    mountOnQueue(queue, "host-1", "sess-1");
    // Die zweite Ansicht entsorgt sich selbst, sobald ihr Platz zugeteilt ist --
    // wie ein Raster, das beim Zuteilen neu zeichnet und sie dabei verwirft.
    const second: TerminalHandle = mountOnQueue(queue, "host-1", "sess-2", {
      onQueued: (queued) => {
        if (!queued) second.dispose();
      },
    });
    mountOnQueue(queue, "host-1", "sess-3");
    await flush();
    expect(opened()).toEqual(["host-1/sess-1"]);
    expect(queue.waiting("host-1")).toBe(2);

    held.get("host-1/sess-1")!.resolve();
    await flush();
    // Liefe das Senden vor dem Rueckruf, ginge sess-2 hinaus, und ihr Platz
    // bliebe bis zu einer Antwort belegt, die nie kommt.
    expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-3"]);
    expect(queue.inFlight("host-1")).toBe(1);
    expect(queue.waiting("host-1")).toBe(0);
  });

  it("eine zugeteilte Ansicht sendet erst, wenn beide Listener stehen; entsorgt vor dem Senden gibt sie ihren Platz sofort weiter", async () => {
    const gate = deferred<() => void>();
    listenMock.mockImplementation(() => gate.promise);
    const queue = createOpenQueue(1);
    const first = mountOnQueue(queue, "host-1", "sess-1");
    const onQueued = vi.fn();
    mountOnQueue(queue, "host-1", "sess-2", { onQueued });
    await flush();
    expect(invokedOpenTerminal()).toBe(false);

    // Die erste Ansicht hat ihren Platz, aber noch nichts gesendet.
    first.dispose();
    expect(onQueued.mock.calls).toEqual([[true], [false]]);
    expect(queue.inFlight("host-1")).toBe(1);
    expect(queue.waiting("host-1")).toBe(0);
    await flush();
    // Zugeteilt, aber ohne Listener: noch kein Kanal.
    expect(invokedOpenTerminal()).toBe(false);

    gate.resolve(vi.fn());
    await flush();
    expect(opened()).toEqual(["host-1/sess-2"]);
  });

  it("wirft der Aufrufer in onQueued(false), landet das in der Konsole: die freigebende Ansicht wird ganz entsorgt, die zugeteilte oeffnet trotzdem", async () => {
    holdOpens();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Nur die zwei listen()-Aufrufe der ersten Ansicht haengen, die der zweiten
      // loesen sofort auf. So wartet die zweite mit stehenden Listenern auf den
      // Platz der ersten: beim Zuteilen bleibt ihr als einziger Ausloeser der
      // Rueckruf der Schlange selbst.
      const gate = deferred<() => void>();
      listenMock.mockImplementationOnce(() => gate.promise).mockImplementationOnce(() => gate.promise);
      const queue = createOpenQueue(1);
      const first = mountOnQueue(queue, "host-1", "sess-1");
      // Das Ende des Entsorgens: das Terminal von sess-1 (`close_terminal`
      // sendet eine Ansicht ohne gesendetes `open_terminal` nicht).
      const firstTermDispose = vi.fn();
      (hoisted.terminals[0] as unknown as { dispose: () => void }).dispose = firstTermDispose;
      const failure = new Error("onQueued wirft");
      const onQueued = vi.fn((queued: boolean) => {
        if (!queued) throw failure;
      });
      mountOnQueue(queue, "host-1", "sess-2", { onQueued });
      await flush();
      expect(opened()).toEqual([]);
      expect(queue.waiting("host-1")).toBe(1);

      // Das Entsorgen der ersten Ansicht (noch nichts gesendet) gibt ihren Platz
      // weiter. Der Fehler des Aufrufers bleibt bei ihm: das Entsorgen laeuft
      // bis zum Ende (`term.dispose` ist gerufen), und das Oeffnen der
      // zweiten Ansicht geht noch in diesem Aufruf hinaus.
      expect(() => first.dispose()).not.toThrow();
      expect(firstTermDispose).toHaveBeenCalledOnce();
      expect(closed()).toEqual([]);
      expect(onQueued.mock.calls).toEqual([[true], [false]]);
      expect(opened()).toEqual(["host-1/sess-2"]);
      expect(queue.inFlight("host-1")).toBe(1);
      expect(queue.waiting("host-1")).toBe(0);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onQueued"), failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("wirft der Aufrufer in onQueued(false) mitten in der Antwort einer anderen Ansicht, haengt sich diese trotzdem an, und die zugeteilte oeffnet", async () => {
    const held = holdOpens();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const queue = createOpenQueue(1);
      const onOpened = vi.fn();
      mountOnQueue(queue, "host-1", "sess-1", { onOpened });
      const failure = new Error("onQueued wirft");
      mountOnQueue(queue, "host-1", "sess-2", {
        onQueued: (queued) => {
          if (!queued) throw failure;
        },
      });
      await flush();
      expect(opened()).toEqual(["host-1/sess-1"]);

      // Die Antwort gibt den Platz frei, und der Rueckruf der zweiten Ansicht
      // wirft mitten darin. An der ersten darf davon nichts haengen bleiben:
      // `release()` steht am Anfang ihrer Antwort, vor `attached = true`, dem
      // Nachholen der Groesse und `onOpened`.
      held.get("host-1/sess-1")!.resolve();
      await flush();
      expect(onOpened).toHaveBeenCalledOnce();
      expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-2"]);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onQueued"), failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("wirft der Aufrufer in onQueued(true), landet das in der Konsole: mountTerminal liefert den Handle, und das Ticket oeffnet und gibt seinen Platz zurueck", async () => {
    const held = holdOpens();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const queue = createOpenQueue(1);
      mountOnQueue(queue, "host-1", "sess-1");
      const failure = new Error("onQueued wirft");
      const onQueued = vi.fn((queued: boolean) => {
        if (queued) throw failure;
      });
      // Der Rueckruf wirft schon beim Mounten, mitten in `mountTerminal`. Das
      // bricht das Mounten nicht ab, und das eingereihte Ticket bleibt in der
      // Schlange.
      expect(() => mountOnQueue(queue, "host-1", "sess-2", { onQueued })).not.toThrow();
      await flush();
      expect(opened()).toEqual(["host-1/sess-1"]);
      expect(queue.waiting("host-1")).toBe(1);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onQueued"), failure);

      // Frei wird der Platz mit der Antwort der ersten Ansicht: die zweite
      // oeffnet, und erst ihre eigene Antwort gibt den Platz zurueck.
      held.get("host-1/sess-1")!.resolve();
      await flush();
      expect(opened()).toEqual(["host-1/sess-1", "host-1/sess-2"]);
      expect(onQueued.mock.calls).toEqual([[true], [false]]);
      expect(queue.inFlight("host-1")).toBe(1);
      expect(queue.waiting("host-1")).toBe(0);

      held.get("host-1/sess-2")!.resolve();
      await flush();
      expect(queue.inFlight("host-1")).toBe(0);
      expect(queue.waiting("host-1")).toBe(0);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// Spec 2026-10-19 §8.1 (Schritt 3): Maximieren verbirgt die anderen Kacheln
// (`display: none`), statt sie zu entsorgen. Eine verborgene Kachel misst
// nicht, meldet keine Groesse und sendet kein `resize_terminal`; den Refit beim
// Zurueckholen loest das Raster aus. Der Mock liest `term.cols`/`term.rows`
// immer aus `hoisted.size`, auch ohne Fit -- eine neue Fenstergroesse setzen
// die Tests darum erst dort, wo das echte xterm sie messen wuerde.
describe("mountTerminal: verborgene Kachel (Spec 2026-10-19 §8.1, Schritt 3)", () => {
  function resizeCalls(): unknown[][] {
    return invokeMock.mock.calls.filter(([command]) => command === "resize_terminal");
  }

  function resizeTo(cols: number, rows: number): unknown[] {
    return ["resize_terminal", { hostId: "host-1", session: "sess-1", openId: FIXED_OPEN_ID, cols, rows }];
  }

  /** `open_terminal` haengt, bis der Test es aufloest; alles andere gelingt. */
  function holdOpen(): { resolve: () => void } {
    const opening = deferred<void>();
    invokeMock.mockImplementation((command: string) =>
      command === "open_terminal" ? opening.promise : Promise.resolve(undefined));
    return { resolve: () => opening.resolve() };
  }

  it("ein Fenster-Resize und eine neue Schriftgroesse messen verborgen nicht und senden nichts; setHidden(false) plant nichts", async () => {
    vi.useFakeTimers();
    try {
      const onSize = vi.fn();
      const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, { onSize });
      await flush(); // angehaengt: sichtbar sendete ein Refit jetzt (Abnahme B1)
      const fits = hoisted.fitCalls;
      onSize.mockClear();

      handle.setHidden(true);
      // Das Fenster aendert seine Groesse, waehrend eine andere Kachel maximiert ist.
      hoisted.size = { cols: 100, rows: 30 };
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);
      handle.setFontSize(16);
      vi.advanceTimersByTime(300);
      expect(hoisted.fitCalls).toBe(fits);
      expect(onSize).not.toHaveBeenCalled();
      expect(resizeCalls()).toEqual([]);

      // Wieder sichtbar: das allein misst nichts ...
      handle.setHidden(false);
      vi.advanceTimersByTime(1000);
      expect(hoisted.fitCalls).toBe(fits);
      // ... den Refit beim Zurueckholen loest das Raster aus: ein Fit, ein resize_terminal.
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(hoisted.fitCalls).toBe(fits + 1);
      expect(onSize).toHaveBeenCalledExactlyOnceWith(100, 30);
      expect(resizeCalls()).toEqual([resizeTo(100, 30)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("verborgen waehrend open_terminal: der uebersprungene Refit sendet beim Anhaengen nichts, nach dem Zurueckholen geht genau ein resize_terminal hinaus (Review Focus 3)", async () => {
    vi.useFakeTimers();
    try {
      const opening = holdOpen();
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush();
      expect(invokedOpenTerminal()).toBe(true);
      const fits = hoisted.fitCalls;

      handle.setHidden(true);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);
      expect(hoisted.fitCalls).toBe(fits);

      opening.resolve();
      await flush();
      vi.advanceTimersByTime(1000);
      expect(resizeCalls()).toEqual([]);

      // Zurueckholen: erst jetzt misst die Kachel die Flaeche, die sie inzwischen hat.
      hoisted.size = { cols: 100, rows: 30 };
      handle.setHidden(false);
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(resizeCalls()).toEqual([resizeTo(100, 30)]);
      vi.advanceTimersByTime(1000);
      expect(resizeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ein verborgen uebersprungener Refit laesst das Nachholen beim Anhaengen stehen: die vorher sichtbar gemessene Groesse geht genau einmal hinaus (Abnahme B1)", async () => {
    vi.useFakeTimers();
    try {
      const opening = holdOpen();
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush();

      // Sichtbar gemessen, waehrend open_terminal aussteht: nur gefittet.
      hoisted.size = { cols: 100, rows: 30 };
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(resizeCalls()).toEqual([]);

      // Dann verborgen; ein Fenster-Resize laeuft ins Leere. Steht danach noch
      // ein Zeitgeber im Weg, unterbliebe das Nachholen.
      handle.setHidden(true);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);

      opening.resolve();
      await flush();
      expect(resizeCalls()).toEqual([resizeTo(100, 30)]);
      vi.advanceTimersByTime(1000);
      expect(resizeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("eine wartende Kachel, die verborgen wird, misst nicht, oeffnet nach der Zuteilung, und nach dem Zurueckholen geht genau ein resize_terminal hinaus (Review Focus 3)", async () => {
    vi.useFakeTimers();
    try {
      const queue = createOpenQueue(1);
      // Ein anderes Oeffnen desselben Hosts haelt den einzigen Platz.
      const blocker = queue.enter("host-1", () => {});
      const onSize = vi.fn();
      const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, { openQueue: queue, onSize });
      await flush();
      expect(invokedOpenTerminal()).toBe(false);
      const fits = hoisted.fitCalls;
      onSize.mockClear();

      handle.setHidden(true);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(300);
      expect(hoisted.fitCalls).toBe(fits);
      expect(onSize).not.toHaveBeenCalled();

      // Der Platz wird frei: die verborgene Kachel oeffnet, ohne zu messen. Die
      // Groesse beim Absenden pinnt der Test "ein wartendes Oeffnen traegt die
      // Groesse beim Absenden ..." im Block der Schlange oben; dieser Mock liest
      // sie live.
      blocker.release();
      await flush();
      const open = invokeMock.mock.calls.find(([command]) => command === "open_terminal");
      expect(open?.[1]).toEqual(expect.objectContaining({ cols: 80, rows: 24 }));
      expect(resizeCalls()).toEqual([]);

      // Zurueckholen: ein Fit, hoechstens ein resize_terminal.
      hoisted.size = { cols: 100, rows: 30 };
      handle.setHidden(false);
      handle.refit();
      vi.advanceTimersByTime(300);
      expect(resizeCalls()).toEqual([resizeTo(100, 30)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// UX-Spec §6.7: eine Schriftgroesse fuer alle Terminals. Strg+Mausrad ueber
// einem Terminal schreibt sie in `terminal-prefs`; `main.ts` reicht sie ueber
// das Raster an jede Kachel (`setFontSize`), und die passt sich ueber den
// bestehenden entprellten Pfad an -- ein `resize_terminal` je Kachel und Geste.
describe("mountTerminal: Schriftgroesse (UX-Spec §6.7)", () => {
  function wheel(target: EventTarget, init: WheelEventInit): WheelEvent {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  function resizeCalls(): unknown[][] {
    return invokeMock.mock.calls.filter(([command]) => command === "resize_terminal");
  }

  it("baut das Terminal mit der eingestellten Schriftgroesse, ohne Einstellung mit 13", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    expect(hoisted.terminals[0].options.fontSize).toBe(13);

    setTerminalPrefs({ fontSize: 16 });
    mount(document.createElement("div"), "host-1", "sess-2");
    expect(hoisted.terminals[1].options.fontSize).toBe(16);
  });

  it("Strg+Mausrad nach oben (-100) macht die Schrift groesser, nach unten (+100) kleiner", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    const xtermEl = hoisted.terminals[0].element!;

    const up = wheel(xtermEl, { ctrlKey: true, deltaY: -100 });
    expect(up.defaultPrevented).toBe(true);
    expect(terminalPrefs().fontSize).toBe(14);

    wheel(xtermEl, { ctrlKey: true, deltaY: 100 });
    wheel(xtermEl, { ctrlKey: true, deltaY: 100 });
    expect(terminalPrefs().fontSize).toBe(12);
  });

  // xterm gaebe das Rad sonst weiter: bei `mouse on` als Mausrad an tmux (der
  // Lauscher prueft `defaultPrevented` nicht), sonst blaetterte es im Verlauf.
  it("haelt das Ereignis vor xterm an: Lauscher im Terminal und am Dokument sehen es nicht", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mount(container, "host-1", "sess-1");
    const xtermEl = hoisted.terminals[0].element!;
    const inXterm = vi.fn();
    const atDocument = vi.fn();
    xtermEl.addEventListener("wheel", inXterm);
    document.addEventListener("wheel", atDocument);
    try {
      wheel(xtermEl, { ctrlKey: true, deltaY: -100 });
      expect(inXterm).not.toHaveBeenCalled();
      expect(atDocument).not.toHaveBeenCalled();

      // Kontrolle: ohne Strg kommt das Rad bei beiden an.
      wheel(xtermEl, { deltaY: -100 });
      expect(inXterm).toHaveBeenCalledTimes(1);
      expect(atDocument).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("wheel", atDocument);
    }
  });

  it("laesst das Rad ohne Strg unberuehrt: kein preventDefault, Schrift bleibt", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    const plain = wheel(hoisted.terminals[0].element!, { deltaY: -300 });

    expect(plain.defaultPrevented).toBe(false);
    expect(terminalPrefs().fontSize).toBe(13);
  });

  // Touchpad-Pinch kommt als Strg+Rad mit kleinen Deltas (Spec §6.7).
  it("summiert kleine Deltas: je volle 100 Einheiten ein Schritt", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    const xtermEl = hoisted.terminals[0].element!;

    wheel(xtermEl, { ctrlKey: true, deltaY: -40 });
    wheel(xtermEl, { ctrlKey: true, deltaY: -40 });
    expect(terminalPrefs().fontSize).toBe(13);
    wheel(xtermEl, { ctrlKey: true, deltaY: -40 });
    expect(terminalPrefs().fontSize).toBe(14);
    // Ein grosser Schub zaehlt mehrfach: -230 plus Rest -20 sind zwei Schritte.
    wheel(xtermEl, { ctrlKey: true, deltaY: -230 });
    expect(terminalPrefs().fontSize).toBe(16);
  });

  it("ein Richtungswechsel verwirft den Rest der anderen Richtung", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    const xtermEl = hoisted.terminals[0].element!;

    wheel(xtermEl, { ctrlKey: true, deltaY: -60 });
    // Ohne Verwerfen bliebe die erste Rastung nach unten wirkungslos (-60 + 100 = 40).
    wheel(xtermEl, { ctrlKey: true, deltaY: 100 });
    expect(terminalPrefs().fontSize).toBe(12);
  });

  it("haelt die Grenzen 10 und 20", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    const xtermEl = hoisted.terminals[0].element!;

    setTerminalPrefs({ fontSize: 20 });
    wheel(xtermEl, { ctrlKey: true, deltaY: -100 });
    expect(terminalPrefs().fontSize).toBe(20);

    setTerminalPrefs({ fontSize: 10 });
    const down = wheel(xtermEl, { ctrlKey: true, deltaY: 100 });
    expect(terminalPrefs().fontSize).toBe(10);
    // Auch an der Grenze gehoert das Rad der Schrift, nicht dem Verlauf.
    expect(down.defaultPrevented).toBe(true);
  });

  it("setFontSize setzt die Schrift und passt das Terminal einmal nach der Entprellung an", async () => {
    vi.useFakeTimers();
    try {
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)

      handle.setFontSize(16);
      expect(hoisted.terminals[0].options.fontSize).toBe(16);
      // Die neue Zellgroesse ergibt weniger Spalten und Zeilen (der Mock-`fit`
      // liest `hoisted.size`).
      hoisted.size = { cols: 66, rows: 20 };
      expect(resizeCalls()).toHaveLength(0);

      vi.advanceTimersByTime(300);
      expect(resizeCalls()).toEqual([
        ["resize_terminal", { hostId: "host-1", session: "sess-1", openId: FIXED_OPEN_ID, cols: 66, rows: 20 }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setFontSize mit der aktuellen Groesse plant keine Anpassung", async () => {
    vi.useFakeTimers();
    try {
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      // Angehaengt: vorher sendet ein Refit ohnehin nichts (Abnahme B1), der
      // Test bewiese dann nichts ueber das ausbleibende Planen.
      await flush();
      hoisted.size = { cols: 66, rows: 20 };

      handle.setFontSize(13);
      vi.advanceTimersByTime(300);

      expect(resizeCalls()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setFontSize klemmt auf 10 bis 20 und ist nach dispose() wirkungslos", () => {
    const handle = mount(document.createElement("div"), "host-1", "sess-1");

    handle.setFontSize(30);
    expect(hoisted.terminals[0].options.fontSize).toBe(20);

    handle.dispose();
    handle.setFontSize(12);
    expect(hoisted.terminals[0].options.fontSize).toBe(20);
  });

  it("nach dispose() ist das Rad nicht mehr belegt", () => {
    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    const xtermEl = hoisted.terminals[0].element!;
    handle.dispose();

    const event = wheel(xtermEl, { ctrlKey: true, deltaY: -100 });

    expect(event.defaultPrevented).toBe(false);
    expect(terminalPrefs().fontSize).toBe(13);
  });

  // Die Kette aus der Spec, ohne main.ts: der Abonnent unten steht fuer
  // `main.ts` und `GridHandle.applyTerminalFontSize`.
  it("eine Geste aus drei Rastungen ergibt genau ein resize_terminal je Kachel", async () => {
    vi.useFakeTimers();
    const handles: TerminalHandle[] = [];
    const off = onTerminalPrefsChanged((prefs) => {
      for (const handle of handles) handle.setFontSize(prefs.fontSize);
    });
    try {
      handles.push(mount(document.createElement("div"), "host-1", "left"));
      handles.push(mount(document.createElement("div"), "host-1", "right"));
      await flush(); // angehaengt: erst dann sendet ein Refit (Abnahme B1)
      const xtermEl = hoisted.terminals[0].element!;

      for (let notch = 0; notch < 3; notch++) {
        wheel(xtermEl, { ctrlKey: true, deltaY: -100 });
        vi.advanceTimersByTime(50);
      }
      expect(hoisted.terminals.map((terminal) => terminal.options.fontSize)).toEqual([16, 16]);
      hoisted.size = { cols: 60, rows: 18 };
      vi.advanceTimersByTime(300);

      expect(resizeCalls().map(([, args]) => (args as { session: string }).session).sort()).toEqual([
        "left",
        "right",
      ]);
    } finally {
      off();
      vi.useRealTimers();
    }
  });
});

describe("mountTerminal: WebGL-Fallback", () => {
  it("wirft nicht, wenn WebglAddon im Konstruktor scheitert (Fallback: DOM-Renderer)", () => {
    hoisted.webglShouldThrow = true;
    expect(() =>
      mount(document.createElement("div"), "host-1", "sess-1"),
    ).not.toThrow();
  });
});

describe("mountTerminal: WebGL-Kontext beim Entsorgen (Spec 2026-10-19 §8.2)", () => {
  it("gibt den Kontext des GL-Canvas frei; Ebenen-Canvas mit Klasse bleiben unberuehrt", () => {
    const el = document.createElement("div");
    const handle = mount(el, "host-1", "sess-1");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const loseContext = vi.fn();
    const glCanvas = document.createElement("canvas");
    glCanvas.getContext = vi.fn(() => ({ getExtension: () => ({ loseContext }) })) as unknown as HTMLCanvasElement["getContext"];
    const layer = document.createElement("canvas");
    layer.className = "xterm-link-layer";
    layer.getContext = vi.fn() as unknown as HTMLCanvasElement["getContext"];
    screen.append(layer, glCanvas);
    el.appendChild(screen);

    handle.dispose();

    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(layer.getContext).not.toHaveBeenCalled();
  });

  it("tut ohne WebGL-Canvas nichts", () => {
    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    expect(() => handle.dispose()).not.toThrow();
  });

  it("gibt den webgl2-Kontext ueber WEBGL_lose_context frei, bevor xterm entsorgt wird", () => {
    // Der Renderer nimmt sein Canvas beim Entsorgen aus dem DOM; danach faende
    // die Suche nichts mehr, und der Kontext lebte bis zur Speicherbereinigung.
    const el = document.createElement("div");
    const handle = mount(el, "host-1", "sess-1");
    const order: string[] = [];
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const glCanvas = document.createElement("canvas");
    // Wie ein echtes Canvas: xterm erzeugt "webgl2", und nur diese Art liefert
    // den Kontext zurueck; die Erweiterung hat genau diesen Namen.
    const gl = {
      getExtension: (name: string) =>
        name === "WEBGL_lose_context" ? { loseContext: () => order.push("loseContext") } : null,
    };
    glCanvas.getContext = vi.fn((type: string) => (type === "webgl2" ? gl : null)) as unknown as HTMLCanvasElement["getContext"];
    screen.appendChild(glCanvas);
    el.appendChild(screen);
    (hoisted.terminals[0] as unknown as { dispose: () => void }).dispose = () => order.push("term.dispose");

    handle.dispose();

    expect(order).toEqual(["loseContext", "term.dispose"]);
  });
});

describe("mountTerminal: Kontextverlust des WebGL-Renderers (Spec 2026-10-19 §8.2)", () => {
  it("entsorgt den Addon bei einem Verlust im Betrieb, xterm faellt auf den DOM-Renderer zurueck", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    expect(hoisted.webgl.lossListeners).toHaveLength(1);
    hoisted.webgl.lossListeners[0]();
    expect(hoisted.webgl.disposeCalls).toBe(1);
  });

  it("ein Verlust nach dem Entsorgen des Terminals tauscht nichts mehr", () => {
    // `releaseWebglContext` loest den Verlust beim Entsorgen selbst aus; er kommt
    // zurueck, wenn das Terminal schon fort ist.
    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    handle.dispose();
    hoisted.webgl.lossListeners[0]();
    expect(hoisted.webgl.disposeCalls).toBe(0);
  });
});

describe("mountTerminal: Keymap-Grenze (Task 12, Spec §7.4)", () => {
  it("registriert einen attachCustomKeyEventHandler beim Mounten", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    expect(hoisted.customKeyEventHandler).toBeTypeOf("function");
  });

  it("laesst klassische Terminal-Kuerzel unveraendert durch (liefert true, xterm.js verarbeitet sie)", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    // Ctrl+V fehlt hier mit Absicht: es fuegt seit Spec §6.1 ein (siehe
    // "Zwischenablage wie Windows Terminal" unten).
    expect(fireKey({ key: "c", ctrlKey: true })).toBe(true); // Ctrl+C ohne Markierung: Interrupt
    expect(fireKey({ key: "a", ctrlKey: true })).toBe(true); // Ctrl+A: Zeilenanfang (readline)
    expect(fireKey({ key: "b", altKey: true })).toBe(true); // Alt+B: Wort zurueck (readline)
  });

  it("schluckt jeden Ctrl+Shift-Akkord (liefert false, xterm.js bekommt ihn NICHT)", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    expect(fireKey({ key: "f", ctrlKey: true, shiftKey: true })).toBe(false);
    // Auch ein (noch) unbelegter Ctrl+Shift-Akkord gehoert der App, nicht
    // dem Terminal -- siehe Kommentar in `src/keymap.ts::isAppChord`.
    expect(fireKey({ key: "z", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it("laesst Ctrl+Alt+Shift (drei Modifikatoren gleichzeitig) unveraendert ans Terminal durch, statt es als App-Akkord zu schlucken", () => {
    // Review-Befund (Task 12): die alte `isAppChord`-Fassung pruefte nur
    // "enthaelt Ctrl UND Shift" -- ein Ctrl+Alt+Shift+F-Tastendruck (drei
    // Tasten gleichzeitig; oder auf einer AltGr-Tastatur ein AltGr+Shift-
    // Akkord auf AELTEREN Chromium-Versionen, siehe Forschungsnotiz in
    // `keymap.ts::isAppChord`) haette `false` von
    // `attachCustomKeyEventHandler` zurueckbekommen (App uebernimmt),
    // `matchAction` haette aber `null` geliefert ("Ctrl+Alt+Shift+F" ist an
    // keine Aktion gebunden) -- das erzeugte Zeichen waere ersatzlos
    // verschwunden: weder im Terminal (xterm.js bekam es nie) noch als
    // App-Aktion (keine gefunden). Jetzt liefert `isAppChord` fuer diese
    // Kombination `false` -> der Handler gibt `true` zurueck -> xterm.js
    // bekommt das Event unveraendert, wie jedes andere Terminal-Kuerzel.
    const container = document.createElement("div");
    mount(container, "host-1", "sess-1");

    expect(fireKey({ key: "f", ctrlKey: true, shiftKey: true, altKey: true })).toBe(true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(hoisted.pasteCalls).toEqual([]);
    expect(container.querySelector("input")).toBeNull(); // Such-Overlay NICHT geoeffnet
  });

  // UX-Spec §8.3: Strg+, und die Tasten der Schriftgroesse gehoeren der App,
  // auch mit Fokus im Terminal. xterm bekommt `false`; das Ereignis laeuft ohne
  // preventDefault und ohne stopPropagation weiter zum Dokument, wo
  // `keyboard.ts` handelt. xterm 6 erzeugt fuer diese Tasten ohnehin keine
  // Eingabe.
  it.each([
    ["Strg+,", { key: ",", code: "Comma", ctrlKey: true }],
    ["Strg+=", { key: "=", code: "Equal", ctrlKey: true }],
    ["Strg++", { key: "+", code: "BracketRight", ctrlKey: true }],
    ["Strg+Num+", { key: "+", code: "NumpadAdd", ctrlKey: true }],
    ["Strg+-", { key: "-", code: "Minus", ctrlKey: true }],
    ["Strg+0", { key: "0", code: "Digit0", ctrlKey: true }],
    ["Strg+Num0", { key: "0", code: "Numpad0", ctrlKey: true }],
  ] as [string, KeyboardEventInit & { key: string }][])(
    "laesst %s zum Dokument durch: false fuer xterm, ohne preventDefault und stopPropagation",
    (_name, init) => {
      mount(document.createElement("div"), "host-1", "sess-1");

      const { handled, event } = fireKeyEvent(init);

      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(event.cancelBubble).toBe(false);
      expect(hoisted.customKeyEventHandler?.(new KeyboardEvent("keyup", init))).toBe(false);
      expect(clipboardWriteText).not.toHaveBeenCalled();
    },
  );

  // Review Focus 1: AltGr unter Windows ist Strg+Alt. Die deutschen Zeichen
  // darauf -- `}` auf der 0, `@` auf dem Q, die Tilde auf dem Plus -- gehen
  // weiter ans Terminal, auch nach der Ausnahme fuer Strg+0 und Strg++.
  it.each([
    ["Strg+Alt+0", { key: "0", code: "Digit0", ctrlKey: true, altKey: true }],
    ["AltGr+0 (})", { key: "}", code: "Digit0", ctrlKey: true, altKey: true, modifierAltGraph: true }],
    ["AltGr+0 (}) ohne Strg/Alt", { key: "}", code: "Digit0", modifierAltGraph: true }],
    ["AltGr++ (~)", { key: "~", code: "BracketRight", ctrlKey: true, altKey: true, modifierAltGraph: true }],
    ["AltGr+Q (@)", { key: "@", code: "KeyQ", ctrlKey: true, altKey: true, modifierAltGraph: true }],
    ["Strg mit AltGraph auf der 0", { key: "0", code: "Digit0", ctrlKey: true, modifierAltGraph: true }],
    ["Strg+1 (nicht in der Ausnahmeliste)", { key: "1", code: "Digit1", ctrlKey: true }],
  ] as [string, KeyboardEventInit & { key: string }][])("%s geht weiter ans Terminal", (_name, init) => {
    mount(document.createElement("div"), "host-1", "sess-1");

    const { handled, event } = fireKeyEvent(init);

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it("laesst Ctrl+Shift+Meta (Windows-Taste zusaetzlich zu Ctrl+Shift) unveraendert ans Terminal durch", () => {
    // Dieselbe Eigenschaft wie oben, fuer den zweiten in `isAppChord`
    // ausgeschlossenen Modifikator (`metaKey`) statt `altKey`.
    mount(document.createElement("div"), "host-1", "sess-1");

    expect(fireKey({ key: "f", ctrlKey: true, shiftKey: true, metaKey: true })).toBe(true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("kopiert die aktuelle Selektion bei Ctrl+Shift+C in die Zwischenablage", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    hoisted.selection = "hello world";

    fireKey({ key: "c", ctrlKey: true, shiftKey: true });

    expect(clipboardWriteText).toHaveBeenCalledWith("hello world");
  });

  it("kopiert NICHT, wenn keine Selektion besteht -- sonst wuerde eine leere Selektion die Zwischenablage des Nutzers ueberschreiben", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    hoisted.selection = "";

    fireKey({ key: "c", ctrlKey: true, shiftKey: true });

    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("oeffnet und schliesst den Such-Overlay bei Ctrl+Shift+F (toggle) und fokussiert das Terminal beim Schliessen", () => {
    const container = document.createElement("div");
    mount(container, "host-1", "sess-1");

    expect(container.querySelector("input")).toBeNull();
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    expect(container.querySelector("input")).not.toBeNull();

    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    expect(container.querySelector("input")).toBeNull();
    expect(hoisted.focusCalls).toBeGreaterThan(0);
  });

  it("Escape im Sucheingabefeld schliesst den Overlay", () => {
    const container = document.createElement("div");
    mount(container, "host-1", "sess-1");
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });

    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(container.querySelector("input")).toBeNull();
  });

  it("Enter im Sucheingabefeld sucht vorwaerts, Shift+Enter rueckwaerts", () => {
    const container = document.createElement("div");
    mount(container, "host-1", "sess-1");
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });

    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "needle";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );

    expect(hoisted.searchCalls).toEqual([
      { type: "next", term: "needle" },
      { type: "prev", term: "needle" },
    ]);
  });

  it("schluckt Ctrl+Shift+N (false), verdrahtet es aber NICHT selbst", () => {
    // Abschlussreview (Important 5): `MountOptions.onNewSession` ist
    // entfallen. Design §10 gibt dem Akkord die Bedeutung "Session auf dem
    // Host der FOKUSSIERTEN KACHEL anlegen" -- das braucht `AppState` und
    // gilt auch ohne fokussiertes Terminal, verdrahtet ist er deshalb
    // allein in `main.ts` (`newSessionOnFocusedTile`). Hier darf er nur
    // eines: nicht als Terminaleingabe durchgehen. Waere er ZUSAETZLICH
    // hier verdrahtet, entstuende die Session doppelt -- dieses Modul ruft
    // nirgends `stopPropagation()`, das `keydown` erreicht `document` also
    // ohnehin.
    mount(document.createElement("div"), "host-1", "sess-1");

    expect(fireKey({ key: "n", ctrlKey: true, shiftKey: true })).toBe(false);

    expect(invokeMock.mock.calls.some(([command]) => command === "create_session")).toBe(false);
  });

  it("ruft options.onCloseTerminal bei Ctrl+Shift+W auf, OHNE selbst dispose() oder close_terminal auszuloesen", () => {
    // Spec §7.4: "Terminal schliessen (Session laeuft weiter)". Der
    // Aufrufer (main.ts) entscheidet, was das sichtbar bedeutet --
    // `mountTerminal` selbst darf hier weder den PTY-Kanal schliessen noch
    // sich selbst disposen.
    const onCloseTerminal = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", undefined, { onCloseTerminal });

    fireKey({ key: "w", ctrlKey: true, shiftKey: true });

    expect(onCloseTerminal).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.some(([command]) => command === "close_terminal"),
    ).toBe(false);
  });

  it("Ctrl+Shift+Up/Down/1..9 werden geschluckt (false), aber loesen keine der verdrahteten Aktionen aus", () => {
    // Spec §14: Plan 1 hat keine Sidebar, also kein Ziel fuer
    // session.prev/next/select.N -- sie bleiben in DEFAULT_KEYMAP
    // validiert, aber ohne Wirkung. Wichtig ist nur, dass sie NICHT ans
    // Terminal durchgereicht werden.
    const onCloseTerminal = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", undefined, {
      onCloseTerminal,
    });

    expect(fireKey({ key: "ArrowUp", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(fireKey({ key: "ArrowDown", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(fireKey({ key: "5", ctrlKey: true, shiftKey: true })).toBe(false);

    expect(onCloseTerminal).not.toHaveBeenCalled();
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(hoisted.pasteCalls).toEqual([]);
  });
});

// Spec §6.1/§6.2. Einfuegen laeuft nativ: der Tastenhandler gibt `false`
// zurueck, OHNE `preventDefault`, dann fuegt Chromium selbst in xterms
// Textfeld ein, und xterms eigener `paste`-Lauscher klammert per Bracketed
// Paste. Das braucht kein Leserecht -- `readText` faellt deshalb nie.
describe("mountTerminal: Zwischenablage wie Windows Terminal (Spec §6.1, §6.2)", () => {
  function sentInput(): boolean {
    return invokeMock.mock.calls.some(([command]) => command === "send_input");
  }

  // Kontrolle fuer jede Zusicherung "nichts gesendet" in diesem Block: ohne
  // sie koennte `sentInput()` gar nicht wahr werden.
  it("Eingabe, die xterm meldet, geht roh als send_input ans PTY", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    hoisted.dataListener?.("ab");

    expect(invokeMock).toHaveBeenCalledWith("send_input", {
      hostId: "host-1",
      session: "sess-1",
      openId: FIXED_OPEN_ID,
      bytes: [97, 98],
    });
  });

  it("Strg+C mit Markierung kopiert, hebt die Markierung auf und geht nicht ans Terminal", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    hoisted.selection = "selected text";

    const { handled, event } = fireKeyEvent({ key: "c", ctrlKey: true });

    // `false` ist der Vertrag mit xterm: Tasten, die der Handler ablehnt,
    // werden nicht zu Terminaleingabe -- das ^C erreicht das Programm nicht.
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWriteText).toHaveBeenCalledWith("selected text");
    expect(hoisted.clearSelectionCalls).toBe(1);
  });

  it("Strg+C ohne Markierung bleibt ^C: xterm bekommt die Taste", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    const { handled, event } = fireKeyEvent({ key: "c", ctrlKey: true });

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("Strg+C bei einer Markierung aus lauter Leerraum bleibt ^C: sie liefert keinen Text, also gibt es nichts zu kopieren", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    // xterm kappt Leerzeichen am Zeilenende: `hasSelection()` ist wahr, der
    // markierte Text leer. Entschiede der Handler auf `hasSelection()`, ginge
    // das ^C verloren und die Zwischenablage bliebe unberuehrt.
    hoisted.blankSelection = true;

    const { handled, event } = fireKeyEvent({ key: "c", ctrlKey: true });

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(hoisted.clearSelectionCalls).toBe(0);
  });

  it("Strg+C mit Markierung bleibt ^C, wenn \"Use Ctrl+C and Ctrl+V\" aus ist", () => {
    setTerminalPrefs({ ctrlCvClipboard: false });
    mount(document.createElement("div"), "host-1", "sess-1");
    hoisted.selection = "selected text";

    expect(fireKey({ key: "c", ctrlKey: true })).toBe(true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(hoisted.clearSelectionCalls).toBe(0);
  });

  it("Strg+V fuegt nativ ein: false fuer xterm, kein preventDefault, kein readText", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    const { handled, event } = fireKeyEvent({ key: "v", ctrlKey: true });

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardReadText).not.toHaveBeenCalled();
    expect(hoisted.pasteCalls).toEqual([]);
  });

  it("Strg+V geht als ^V ans Terminal, wenn \"Use Ctrl+C and Ctrl+V\" aus ist", () => {
    setTerminalPrefs({ ctrlCvClipboard: false });
    mount(document.createElement("div"), "host-1", "sess-1");

    expect(fireKey({ key: "v", ctrlKey: true })).toBe(true);
  });

  // Die Einstellung kann sich im laufenden Betrieb aendern (Einstellungsdialog);
  // ein beim Mounten gemerkter Wert wirkte erst in neuen Kacheln.
  it("liest \"Use Ctrl+C and Ctrl+V\" bei jedem Tastendruck, auch nach dem Mounten", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    hoisted.selection = "selected text";

    expect(fireKey({ key: "c", ctrlKey: true })).toBe(false);
    expect(fireKey({ key: "v", ctrlKey: true })).toBe(false);

    setTerminalPrefs({ ctrlCvClipboard: false });
    expect(fireKey({ key: "c", ctrlKey: true })).toBe(true);
    expect(fireKey({ key: "v", ctrlKey: true })).toBe(true);

    setTerminalPrefs({ ctrlCvClipboard: true });
    expect(fireKey({ key: "c", ctrlKey: true })).toBe(false);
    expect(fireKey({ key: "v", ctrlKey: true })).toBe(false);
  });

  it("Strg+Umschalt+V und Umschalt+Einfg fuegen nativ ein, ohne preventDefault und ohne readText", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    for (const init of [
      { key: "V", ctrlKey: true, shiftKey: true },
      { key: "Insert", shiftKey: true },
    ]) {
      const { handled, event } = fireKeyEvent(init);
      expect(handled, init.key).toBe(false);
      expect(event.defaultPrevented, init.key).toBe(false);
    }
    expect(clipboardReadText).not.toHaveBeenCalled();
    expect(hoisted.pasteCalls).toEqual([]);
  });

  it("Strg+Einfg kopiert die Markierung", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    hoisted.selection = "selected text";

    const { handled, event } = fireKeyEvent({ key: "Insert", ctrlKey: true });

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWriteText).toHaveBeenCalledWith("selected text");
  });

  it("Strg+Umschalt+C ohne Markierung schluckt den Akkord, schreibt aber nichts", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    const { handled, event } = fireKeyEvent({ key: "C", ctrlKey: true, shiftKey: true });

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  // AltGr+Q ergibt auf deutscher Tastatur @, Windows meldet das als Strg+Alt.
  // Mit einer Markierung im Terminal darf daraus weder ein Kopieren noch ein
  // verschlucktes Zeichen werden.
  it("Strg+Alt+Q (AltGr+Q, @) wird nicht abgefangen, auch nicht bei Markierung", () => {
    mount(document.createElement("div"), "host-1", "sess-1");
    hoisted.selection = "selected text";

    expect(fireKey({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true, modifierAltGraph: true })).toBe(true);
    expect(fireKey({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true })).toBe(true);
    expect(fireKey({ key: "c", ctrlKey: true, altKey: true })).toBe(true);
    expect(fireKey({ key: "v", ctrlKey: true, modifierAltGraph: true })).toBe(true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(hoisted.clearSelectionCalls).toBe(0);
  });

  it("meldet ein gelungenes Kopieren ueber onCopied", async () => {
    const onCopied = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onCopied });
    hoisted.selection = "selected text";

    fireKey({ key: "c", ctrlKey: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("meldet einen Kopierfehler ueber onError als Art copy, nicht als Fehler beim Oeffnen", async () => {
    clipboardWriteText.mockRejectedValue(new Error("Document is not focused."));
    const onError = vi.fn();
    const onCopied = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", onError, { onCopied });
    hoisted.selection = "selected text";

    fireKey({ key: "c", ctrlKey: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith({ kind: "copy", detail: "Error: Document is not focused." });
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("meldet kein onCopied mehr, wenn die Ansicht vor dem Abschluss entsorgt wurde", async () => {
    const onCopied = vi.fn();
    const handle = mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onCopied });
    hoisted.selection = "selected text";

    fireKey({ key: "c", ctrlKey: true });
    handle.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboardWriteText).toHaveBeenCalledWith("selected text");
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("meldet keinen Kopierfehler mehr, wenn die Ansicht vor dem Abschluss entsorgt wurde", async () => {
    // Kein Fehlerbanner fuer eine Kachel, die es nicht mehr gibt.
    let rejectWrite!: (reason: Error) => void;
    clipboardWriteText.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectWrite = reject;
      }),
    );
    const onError = vi.fn();
    const handle = mount(document.createElement("div"), "host-1", "sess-1", onError);
    hoisted.selection = "selected text";

    fireKey({ key: "c", ctrlKey: true });
    handle.dispose();
    rejectWrite(new Error("Document is not focused."));
    await flush();

    expect(clipboardWriteText).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("OSC 52 meldet kein onCopied mehr, wenn die Ansicht vor dem Abschluss entsorgt wurde", async () => {
    const onCopied = vi.fn();
    const handle = mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onCopied });

    hoisted.oscHandlers.get(52)?.(";aGVsbG8=");
    handle.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboardWriteText).toHaveBeenCalledWith("hello");
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("OSC 52 von tmux (leeres Pc) schreibt in die Zwischenablage und meldet onCopied einmal", async () => {
    const onCopied = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onCopied });
    const osc52 = hoisted.oscHandlers.get(52);
    expect(osc52).toBeTypeOf("function");

    expect(osc52?.(";aGVsbG8=")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboardWriteText).toHaveBeenCalledWith("hello");
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("OSC 52 mit ? wird nie beantwortet: nichts geschrieben, nichts gesendet", async () => {
    const onCopied = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", vi.fn(), { onCopied });

    expect(hoisted.oscHandlers.get(52)?.("c;?")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(clipboardReadText).not.toHaveBeenCalled();
    expect(sentInput()).toBe(false);
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("verwirft einen Schreibfehler aus OSC 52 still", async () => {
    clipboardWriteText.mockRejectedValue(new Error("Document is not focused."));
    const onError = vi.fn();
    const onCopied = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", onError, { onCopied });

    hoisted.oscHandlers.get(52)?.(";aGVsbG8=");
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboardWriteText).toHaveBeenCalledWith("hello");
    expect(onError).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });
});

// UX-Spec §6.3: die rechte Taste gehoert der App -- Terminalmenue oder
// Kopieren/Einfuegen, nie das WebView2-Menue und nie ein Menue von tmux.
const MENU_TEXTS: TerminalMenuTexts = {
  items: {
    copy: { label: en["terminalMenu.copy"], shortcut: "Ctrl+C" },
    paste: { label: en["terminalMenu.paste"], shortcut: "Ctrl+V" },
    selectAll: { label: en["terminalMenu.selectAll"] },
    find: { label: en["terminalMenu.find"], shortcut: "Ctrl+Shift+F" },
    moveEarlier: { label: "Move to previous position", shortcut: "Ctrl+Shift+PageUp" },
    moveLater: { label: "Move to next position", shortcut: "Ctrl+Shift+PageDown" },
  },
  fixedShortcuts: { copy: "Ctrl+Shift+C", paste: "Ctrl+Shift+V" },
  mouseHint: en["terminalMenu.mouseHint"],
};

/** Genug Mikroaufgaben fuer `readText().then(...)` bzw. `writeText().then(...)`. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Ein eingehaengter Container mit einem Platzhalter fuer das Element, das
 * xterm hineinsetzt -- das Ziel der Mausereignisse. Eingehaengt, weil Fokus
 * und `document`-Lauscher nur im Dokument wirken. */
function setupTile(extra: Partial<MountOptions> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const xtermEl = document.createElement("div");
  xtermEl.className = "xterm";
  container.appendChild(xtermEl);
  const onError = vi.fn();
  const onCopied = vi.fn();
  const handle = mount(container, "host-1", "sess-1", onError, {
    menuTexts: MENU_TEXTS,
    onCopied,
    ...extra,
  });
  return { container, xtermEl, onError, onCopied, handle };
}

function rightClick(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 60, ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function terminalMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".terminal-menu");
}

function menuItem(label: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (i) => i.querySelector(".terminal-menu-label")?.textContent === label,
  );
  if (!found) throw new Error(`Menueeintrag "${label}" fehlt`);
  return found;
}

function pressInMenu(key: string): void {
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("mountTerminal: rechte Maustaste (UX-Spec §6.3)", () => {
  it.each(["mousedown", "mouseup", "auxclick"] as const)(
    "%s der rechten Taste erreicht xterm nicht, die der anderen Tasten schon",
    (type) => {
      const { xtermEl } = setupTile();
      const bubbled: number[] = [];
      const captured: number[] = [];
      xtermEl.addEventListener(type, (e) => bubbled.push((e as MouseEvent).button));
      xtermEl.addEventListener(type, (e) => captured.push((e as MouseEvent).button), true);

      for (const button of [0, 1, 2]) {
        xtermEl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button }));
      }

      // Ein Stopp am Container schneidet beide Phasen am Ziel ab. Dass 0 und 1
      // ankommen, haelt den Stopp auf die rechte Taste beschraenkt.
      expect(bubbled).toEqual([0, 1]);
      expect(captured).toEqual([0, 1]);
    },
  );

  it("verhindert das Browsermenue und laesst xterms eigenen contextmenu-Handler nicht laufen", () => {
    const { xtermEl } = setupTile();
    const atXterm = vi.fn();
    xtermEl.addEventListener("contextmenu", atXterm);

    const event = rightClick(xtermEl);

    expect(event.defaultPrevented).toBe(true);
    // xterms Handler schiebt sein verstecktes Textfeld unter den Zeiger und
    // fuellt es mit der Markierung -- fuer das Browsermenue, das es hier nicht gibt.
    expect(atXterm).not.toHaveBeenCalled();
  });

  it("oeffnet das Menue am Zeiger, mit vier Eintraegen samt Kuerzeln", () => {
    const { xtermEl } = setupTile();

    rightClick(xtermEl, { clientX: 140, clientY: 90 });

    expect(terminalMenu()?.style.left).toBe("140px");
    expect(terminalMenu()?.style.top).toBe("90px");
    const rows = Array.from(document.querySelectorAll('[role="menuitem"]')).map((i) => [
      i.querySelector(".terminal-menu-label")?.textContent,
      i.querySelector(".terminal-menu-shortcut")?.textContent ?? null,
    ]);
    expect(rows).toEqual([
      ["Copy", "Ctrl+C"],
      ["Paste", "Ctrl+V"],
      ["Select all", null],
      ["Find…", "Ctrl+Shift+F"],
    ]);
  });

  it("zeigt Copy nur mit markiertem Text aktiv: ohne Markierung und bei lauter Leerraum ausgegraut", () => {
    const { xtermEl } = setupTile();
    const copyDisabled = () => menuItem("Copy").getAttribute("aria-disabled");

    rightClick(xtermEl);
    expect(copyDisabled()).toBe("true");
    pressInMenu("Escape");

    // `hasSelection()` ist hier wahr, der Text leer (siehe Strg+C weiter oben).
    hoisted.blankSelection = true;
    rightClick(xtermEl);
    expect(copyDisabled()).toBe("true");
    pressInMenu("Escape");

    hoisted.blankSelection = false;
    hoisted.selection = "selected text";
    rightClick(xtermEl);
    expect(copyDisabled()).toBeNull();
  });

  // Strg+C kopiert bei ausgeschalteter Einstellung nicht mehr; ein Kuerzel,
  // das nichts tut, waere gelogen. Beide Fassungen kommen aus den Menuetexten
  // (hier bewusst unverwechselbar), nicht aus einer Tabelle in dieser Datei.
  const TEXTS_WITH_OWN_FIXED_KEYS: TerminalMenuTexts = {
    ...MENU_TEXTS,
    fixedShortcuts: { copy: "fixed-copy", paste: "fixed-paste" },
  };
  const shortcutOf = (label: string) => menuItem(label).querySelector(".terminal-menu-shortcut")?.textContent;

  it("zeigt bei ausgeschaltetem Strg+C/V die festen Kuerzel aus den Menuetexten", () => {
    setTerminalPrefs({ ctrlCvClipboard: false });
    const { xtermEl } = setupTile({ menuTexts: TEXTS_WITH_OWN_FIXED_KEYS });

    rightClick(xtermEl);

    expect(shortcutOf("Copy")).toBe("fixed-copy");
    expect(shortcutOf("Paste")).toBe("fixed-paste");
    expect(shortcutOf("Find…")).toBe("Ctrl+Shift+F");
  });

  it("zeigt bei eingeschaltetem Strg+C/V deren Kuerzel, nicht die festen", () => {
    const { xtermEl } = setupTile({ menuTexts: TEXTS_WITH_OWN_FIXED_KEYS });

    rightClick(xtermEl);

    expect(shortcutOf("Copy")).toBe("Ctrl+C");
    expect(shortcutOf("Paste")).toBe("Ctrl+V");
  });

  it("zeigt die Hinweiszeile nicht, solange kein Programm die Maus nutzt", () => {
    const { xtermEl } = setupTile();

    rightClick(xtermEl);

    expect(terminalMenu()?.querySelector(".terminal-menu-hint")).toBeNull();
  });

  it.each(["x10", "vt200", "drag", "any"] as const)(
    "zeigt die Hinweiszeile, solange ein Programm die Maus nutzt (%s)",
    (mode) => {
      hoisted.mouseTrackingMode = mode;
      const { xtermEl } = setupTile();

      rightClick(xtermEl);

      expect(terminalMenu()?.querySelector(".terminal-menu-hint")?.textContent).toBe(
        "Shift+drag selects text while a program uses the mouse",
      );
    },
  );

  it("fokussiert das Terminal beim Rechtsklick und gibt ihm den Fokus beim Schliessen zurueck", () => {
    const { xtermEl } = setupTile();

    rightClick(xtermEl);
    // Die rechte Taste erreicht xterm nicht, also auch nicht dessen focus() --
    // ohne diesen Aufruf bliebe die Kachel unter dem Menue unfokussiert.
    expect(hoisted.focusCalls).toBe(1);

    pressInMenu("Escape");
    expect(terminalMenu()).toBeNull();
    expect(hoisted.focusCalls).toBe(2);
  });

  // Ohne diese Rueckgabe landete der naechste Tastendruck auf <body>. Die
  // Eintraege "Find…" (Fokus ins Suchfeld) und "Paste" lesen den Fokus anders
  // und haben eigene Tests.
  it.each([
    ["Escape", () => pressInMenu("Escape")],
    ["Tab", () => pressInMenu("Tab")],
    ["ein gewaehlter Eintrag", () => menuItem("Select all").click()],
    ["ein Mausdruck ausserhalb", () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))],
  ])("legt den Fokus ins Terminal zurueck: %s", (_name, closeMenu) => {
    const { container, xtermEl } = setupTile();
    rightClick(xtermEl);
    expect(container.contains(document.activeElement)).toBe(false); // im Menue

    closeMenu();

    expect(terminalMenu()).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".xterm-helper-textarea"));
  });

  it("schliesst ein offenes Menue beim Entsorgen und gibt dem entsorgten Terminal keinen Fokus", () => {
    const { xtermEl, handle } = setupTile();
    rightClick(xtermEl);
    const focusBefore = hoisted.focusCalls;

    handle.dispose();

    expect(terminalMenu()).toBeNull();
    expect(hoisted.focusCalls).toBe(focusBefore);
  });

  it("oeffnet ohne Menuetexte kein Menue, verhindert aber das Browsermenue", () => {
    const { xtermEl } = setupTile({ menuTexts: undefined });

    const event = rightClick(xtermEl);

    expect(event.defaultPrevented).toBe(true);
    expect(terminalMenu()).toBeNull();
  });

  it("laesst die rechte Taste in der Sucheingabe beim Browser (natives Bearbeitungsmenue)", () => {
    const { container } = setupTile();
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    const input = container.querySelector("input") as HTMLInputElement;
    let mouseDownReached = false;
    input.addEventListener("mousedown", () => {
      mouseDownReached = true;
    });

    const event = rightClick(input);
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));

    expect(event.defaultPrevented).toBe(false);
    expect(terminalMenu()).toBeNull();
    expect(mouseDownReached).toBe(true);
  });

  // Die Leiste hat neben dem Feld Knoepfe und einen Zaehler; ein Rechtsklick darauf
  // oeffnet das Terminalmenue so wenig wie einer ins Feld.
  it("laesst die rechte Taste im ganzen Such-Overlay beim Browser, nicht nur im Feld", () => {
    const { container } = setupTile();
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    const overlay = container.querySelector(".terminal-search-overlay") as HTMLElement;
    let mouseDownReached = false;
    overlay.addEventListener("mousedown", () => {
      mouseDownReached = true;
    });

    const event = rightClick(overlay);
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));

    expect(event.defaultPrevented).toBe(false);
    expect(terminalMenu()).toBeNull();
    expect(mouseDownReached).toBe(true);
  });

  it.each([
    ["einem Knopf", 'button[data-action="next"]'],
    ["dem Zaehler", ".terminal-search-count"],
  ])("laesst die rechte Taste auf %s der Leiste beim Browser", (_name, selector) => {
    const { container } = setupTile();
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    const target = container.querySelector(selector) as HTMLElement;
    let mouseDownReached = false;
    target.addEventListener("mousedown", () => {
      mouseDownReached = true;
    });

    const event = rightClick(target);
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));

    expect(event.defaultPrevented).toBe(false);
    expect(terminalMenu()).toBeNull();
    expect(mouseDownReached).toBe(true);
  });

  // Vertrag der beiden Module: `terminal.ts` haelt die rechte Taste samt
  // `auxclick` von allem darueber fern, ein Rechtsklick erzeugt also kein
  // `click`, auf das das Hostmenue der Seitenleiste wartet. Mit dem echten
  // Terminal und der echten Seitenleiste geprueft, nicht mit Attrappen beider.
  it("schliesst ein offenes Hostmenue der Seitenleiste, wenn im Terminal rechts geklickt wird", () => {
    const state = new AppState();
    state.upsertHost({
      id: "h1", runtimeId: "r-h1", label: "h1", hostname: "10.0.0.1", user: "u", port: 22,
      keyPath: null, authKind: "agent", state: "connected", error: null, expanded: true,
      lastCwd: "/tmp", sessions: [],
    });
    const sidebarEl = document.createElement("div");
    document.body.appendChild(sidebarEl);
    const sidebar = mountSidebar(sidebarEl, state, {
      onConnectHost: vi.fn(), onDisconnectHost: vi.fn(), onEditHost: vi.fn(), onRemoveHost: vi.fn(),
      onReloadSessions: vi.fn(), onNewSession: vi.fn(), onOpenSession: vi.fn(), onCloseSession: vi.fn(),
      onKillSession: vi.fn(), onAddHost: vi.fn(), onOpenSettings: vi.fn(),
    });
    try {
      const { xtermEl } = setupTile();
      sidebarEl.querySelector<HTMLElement>(".host-menu-btn")?.click();
      const hostMenu = () => document.querySelector(".sb-menu:not(.terminal-menu)");
      expect(hostMenu()).not.toBeNull();

      // Die echte Folge eines Rechtsklicks, ohne `click`.
      xtermEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));
      xtermEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 2 }));
      rightClick(xtermEl);

      expect(hostMenu()).toBeNull();
      expect(terminalMenu()).not.toBeNull();
    } finally {
      sidebar.dispose();
    }
  });

  it("ein zweiter Rechtsklick bei offenem Menue ersetzt es: genau ein Menue, am neuen Zeiger, mit dem Fokus darin", () => {
    const { xtermEl } = setupTile();
    rightClick(xtermEl, { clientX: 120, clientY: 60 });
    const first = terminalMenu();

    // Ohne vorherigen Mausdruck, wie bei einem Rechtsklick per Tastatur.
    rightClick(xtermEl, { clientX: 300, clientY: 200 });

    expect(document.querySelectorAll(".terminal-menu")).toHaveLength(1);
    expect(first?.isConnected).toBe(false);
    expect(terminalMenu()?.style.left).toBe("300px");
    expect(terminalMenu()?.style.top).toBe("200px");
    // Schlosse das alte Menue erst NACH dem Aufbau des neuen, risse sein
    // onClose den Fokus ins Terminal, und das neue schlosse sich selbst.
    expect(terminalMenu()?.contains(document.activeElement)).toBe(true);
  });

  // `grid.ts` mountet dieselbe Kachel nach einem Layoutwechsel erneut in
  // dasselbe Element. Ein Lauscher des entsorgten Handles bliebe mit seinem
  // Terminal im Speicher haengen und hielte weiter die rechte Taste auf.
  it("gibt dem Element beim Entsorgen die rechte Taste zurueck", () => {
    const { xtermEl, handle } = setupTile();
    const reached: number[] = [];
    xtermEl.addEventListener("mousedown", (e) => reached.push((e as MouseEvent).button));
    handle.dispose();

    const event = rightClick(xtermEl);
    xtermEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));

    expect(event.defaultPrevented).toBe(false);
    expect(reached).toEqual([2]);
  });

  // Die Lauscher am Dokument und am Fenster sind die, die sich nicht von selbst
  // erledigen: ein Element wird irgendwann mit entsorgt, `document` und
  // `window` nie. Von aussen sichtbar ist nur, dass jeder an ein Signal
  // gebunden ist, das `dispose()` abbricht.
  it("bindet jeden Lauscher an Dokument und Fenster an ein Signal, das das Entsorgen abbricht", () => {
    const atDocument = vi.spyOn(document, "addEventListener");
    const atWindow = vi.spyOn(window, "addEventListener");
    try {
      const { handle } = setupTile();
      const added = [
        ...atDocument.mock.calls.filter(([type]) => type === "mousedown" || type === "mouseup"),
        ...atWindow.mock.calls.filter(([type]) => type === "blur"),
      ];
      // Druck und Loslassen am Dokument, Fokusverlust am Fenster.
      expect(added.map(([type]) => type).sort()).toEqual(["blur", "mousedown", "mouseup"]);
      const signals = added.map(([, , options]) => (options as AddEventListenerOptions).signal);
      expect(signals.every((signal) => signal?.aborted === false)).toBe(true);

      handle.dispose();

      expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    } finally {
      atDocument.mockRestore();
      atWindow.mockRestore();
    }
  });
});

describe("mountTerminal: Menueeintraege und Modus Copy/Paste (UX-Spec §6.3)", () => {
  it("Copy kopiert die Markierung, hebt sie auf und meldet onCopied", async () => {
    const { xtermEl, onCopied } = setupTile();
    hoisted.selection = "selected text";
    rightClick(xtermEl);

    menuItem("Copy").click();
    await flush();

    expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected text");
    expect(hoisted.clearSelectionCalls).toBe(1);
    expect(onCopied).toHaveBeenCalledOnce();
    expect(terminalMenu()).toBeNull();
  });

  it("ein ausgegrautes Copy kopiert nichts und laesst das Menue offen", () => {
    const { xtermEl } = setupTile();
    rightClick(xtermEl);

    menuItem("Copy").click();

    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(terminalMenu()).not.toBeNull();
  });

  it("Paste liest die Zwischenablage und fuegt sie per term.paste ein", async () => {
    clipboardReadText.mockResolvedValue("from clipboard");
    const { xtermEl } = setupTile();
    rightClick(xtermEl);

    menuItem("Paste").click();
    await flush();

    expect(clipboardReadText).toHaveBeenCalledOnce();
    expect(hoisted.pasteCalls).toEqual(["from clipboard"]);
  });

  it("Paste meldet einen Lesefehler als Art paste und fuegt nichts ein", async () => {
    clipboardReadText.mockRejectedValue(new Error("Read permission denied."));
    const { xtermEl, onError } = setupTile();
    rightClick(xtermEl);

    menuItem("Paste").click();
    await flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "paste", detail: "Error: Read permission denied." });
    expect(hoisted.pasteCalls).toEqual([]);
  });

  it("Paste fuegt eine leere Zwischenablage nicht ein (sonst gingen leere Bracketed-Paste-Marken ans Programm)", async () => {
    clipboardReadText.mockResolvedValue("");
    const { xtermEl } = setupTile();
    rightClick(xtermEl);

    menuItem("Paste").click();
    await flush();

    expect(hoisted.pasteCalls).toEqual([]);
  });

  it("Paste meldet nach dem Entsorgen keinen Lesefehler mehr", async () => {
    let rejectRead!: (reason: Error) => void;
    clipboardReadText.mockReturnValue(
      new Promise<string>((_, reject) => {
        rejectRead = reject;
      }),
    );
    const { xtermEl, handle, onError } = setupTile();
    rightClick(xtermEl);
    menuItem("Paste").click();

    handle.dispose();
    rejectRead(new Error("Read permission denied."));
    await flush();

    expect(clipboardReadText).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("Paste fuegt nach dem Entsorgen nichts mehr ein", async () => {
    const reading = deferred<string>();
    clipboardReadText.mockReturnValue(reading.promise);
    const { xtermEl, handle } = setupTile();
    rightClick(xtermEl);
    menuItem("Paste").click();

    handle.dispose();
    reading.resolve("late");
    await flush();

    expect(hoisted.pasteCalls).toEqual([]);
  });

  it("Select all markiert den ganzen Puffer", () => {
    const { xtermEl } = setupTile();
    rightClick(xtermEl);

    menuItem("Select all").click();

    expect(hoisted.selectAllCalls).toBe(1);
  });

  it("Find… oeffnet das Suchfeld mit dem Fokus darin; ein offenes Feld bleibt offen", () => {
    const { container, xtermEl } = setupTile();
    rightClick(xtermEl);

    menuItem("Find…").click();

    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    // Zweiter Anlauf bei offenem Feld: ein Umschalter schlosse es.
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    rightClick(xtermEl);
    menuItem("Find…").click();

    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(document.activeElement).toBe(input);
  });

  it("zeigt mit onMoveTile zwei Eintraege zum Verschieben, am Rand ausgegraut (Spec 2026-10-19 §5.4)", () => {
    const onMoveTile = vi.fn();
    const { xtermEl } = setupTile({ onMoveTile, canMoveTile: (delta) => delta === 1 });
    rightClick(xtermEl);
    expect(menuItem("Move to previous position").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("Move to next position").getAttribute("aria-disabled")).not.toBe("true");
    menuItem("Move to next position").click();
    expect(onMoveTile).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("ohne onMoveTile bleibt es bei den vier Eintraegen", () => {
    const { xtermEl } = setupTile();
    rightClick(xtermEl);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
  });

  it("Move to previous position ruft onMoveTile mit -1; ohne canMoveTile sind beide Eintraege aktiv", () => {
    const onMoveTile = vi.fn();
    const { xtermEl } = setupTile({ onMoveTile });
    rightClick(xtermEl);
    expect(menuItem("Move to previous position").getAttribute("aria-disabled")).not.toBe("true");
    expect(menuItem("Move to next position").getAttribute("aria-disabled")).not.toBe("true");
    const shortcutOf = (label: string) => menuItem(label).querySelector(".terminal-menu-shortcut")?.textContent;
    expect(shortcutOf("Move to previous position")).toBe("Ctrl+Shift+PageUp");
    expect(shortcutOf("Move to next position")).toBe("Ctrl+Shift+PageDown");
    menuItem("Move to previous position").click();
    expect(onMoveTile).toHaveBeenCalledExactlyOnceWith(-1);
  });

  it("Modus Copy/Paste: mit Markierung kopieren und die Markierung aufheben, ohne Menue", async () => {
    setTerminalPrefs({ rightClick: "paste" });
    const { xtermEl, onCopied } = setupTile();
    hoisted.selection = "selected text";

    const event = rightClick(xtermEl);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(terminalMenu()).toBeNull();
    expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected text");
    expect(hoisted.clearSelectionCalls).toBe(1);
    expect(clipboardReadText).not.toHaveBeenCalled();
    expect(onCopied).toHaveBeenCalledOnce();
  });

  it.each([
    ["ohne Markierung", false],
    ["bei einer Markierung aus lauter Leerraum", true],
  ])("Modus Copy/Paste: %s einfuegen", async (_name, blank) => {
    setTerminalPrefs({ rightClick: "paste" });
    clipboardReadText.mockResolvedValue("from clipboard");
    const { xtermEl } = setupTile();
    hoisted.blankSelection = blank;

    rightClick(xtermEl);
    await flush();

    expect(terminalMenu()).toBeNull();
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(clipboardReadText).toHaveBeenCalledOnce();
    expect(hoisted.pasteCalls).toEqual(["from clipboard"]);
  });

  it("Modus Copy/Paste: ein Lesefehler geht als Art paste an onError", async () => {
    setTerminalPrefs({ rightClick: "paste" });
    clipboardReadText.mockRejectedValue(new Error("Read permission denied."));
    const { xtermEl, onError } = setupTile();

    rightClick(xtermEl);
    await flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "paste", detail: "Error: Read permission denied." });
  });

  it("liest die Einstellung \"Right click\" bei jedem Rechtsklick, auch nach dem Mounten", async () => {
    const { xtermEl } = setupTile();
    clipboardReadText.mockResolvedValue("from clipboard");

    rightClick(xtermEl);
    expect(terminalMenu()).not.toBeNull();
    pressInMenu("Escape");

    setTerminalPrefs({ rightClick: "paste" });
    rightClick(xtermEl);
    await flush();
    expect(terminalMenu()).toBeNull();
    expect(hoisted.pasteCalls).toEqual(["from clipboard"]);

    setTerminalPrefs({ rightClick: "menu" });
    rightClick(xtermEl);
    expect(terminalMenu()).not.toBeNull();
  });
});

describe("mountTerminal: Copy on select (UX-Spec §6.4)", () => {
  // Kopiert wird nach einem Druck IN DIESER Kachel, nie nach einem bloss
  // eintreffenden mouseup: eine zweite Kachel mit noch sichtbarer Markierung
  // wuerde sonst bei jedem Loslassen ueber ihr die Zwischenablage ueberschreiben.
  function press(target: EventTarget, init: MouseEventInit = {}): void {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
  }

  function mouseUp(target: EventTarget, init: MouseEventInit = {}): void {
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, ...init }));
  }

  /** Ein Klick oder Ziehen innerhalb einer Kachel: Druck und Loslassen am selben Element. */
  function click(target: EventTarget, init: MouseEventInit = {}): void {
    press(target, init);
    mouseUp(target, init);
  }

  it.each([1, 2, 3])("kopiert beim Loslassen der linken Taste (Klick %i), laesst die Markierung stehen und meldet onCopied", async (detail) => {
    setTerminalPrefs({ copyOnSelect: true });
    const { xtermEl, onCopied } = setupTile();
    hoisted.selection = "selected text";

    click(xtermEl, { detail });
    await flush();

    expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected text");
    // Anders als Strg+C: die Markierung bleibt sichtbar (Spec §6.4).
    expect(hoisted.clearSelectionCalls).toBe(0);
    expect(onCopied).toHaveBeenCalledOnce();
  });

  it("kopiert nichts ohne markierten Text, auch nicht bei einer Markierung aus lauter Leerraum", () => {
    setTerminalPrefs({ copyOnSelect: true });
    const { xtermEl } = setupTile();

    click(xtermEl);
    hoisted.blankSelection = true;
    click(xtermEl);

    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("kopiert in der Voreinstellung (aus) nie", () => {
    const { xtermEl } = setupTile();
    hoisted.selection = "selected text";

    click(xtermEl);

    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("liest die Einstellung bei jedem Loslassen, auch nach dem Mounten", () => {
    const { xtermEl } = setupTile();
    hoisted.selection = "selected text";

    click(xtermEl);
    expect(clipboardWriteText).not.toHaveBeenCalled();

    setTerminalPrefs({ copyOnSelect: true });
    click(xtermEl);
    expect(clipboardWriteText).toHaveBeenCalledOnce();

    setTerminalPrefs({ copyOnSelect: false });
    click(xtermEl);
    expect(clipboardWriteText).toHaveBeenCalledOnce();
  });

  it("kopiert nur beim Loslassen der LINKEN Taste", () => {
    setTerminalPrefs({ copyOnSelect: true });
    const { xtermEl } = setupTile();
    hoisted.selection = "selected text";

    press(xtermEl);
    mouseUp(xtermEl, { button: 1 });
    mouseUp(xtermEl, { button: 2 });
    expect(clipboardWriteText).not.toHaveBeenCalled();

    // Die fremden Tasten verbrauchen den Druck nicht.
    mouseUp(xtermEl);
    expect(clipboardWriteText).toHaveBeenCalledOnce();
  });

  it("kopiert nicht, wenn die Suche eine Markierung setzt: kopiert wird nur beim Loslassen", () => {
    setTerminalPrefs({ copyOnSelect: true });
    const { container, xtermEl } = setupTile();
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "needle";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // Die Suche hat den Treffer markiert und onSelectionChange gefeuert.
    expect(hoisted.searchCalls).toEqual([{ type: "next", term: "needle" }]);
    expect(hoisted.selection).toBe("needle");
    expect(clipboardWriteText).not.toHaveBeenCalled();

    // Kontrolle: dieselbe Markierung kopiert ein Klick im Terminal sehr wohl.
    click(xtermEl);
    expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("needle");
  });

  it("kopiert nicht nach einem Druck in der Suche", () => {
    setTerminalPrefs({ copyOnSelect: true });
    const { container, xtermEl } = setupTile();
    hoisted.selection = "selected text";
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    const input = container.querySelector("input") as HTMLInputElement;
    const overlay = container.querySelector(".terminal-search-overlay") as HTMLElement;

    click(input);
    click(overlay);
    press(input);
    mouseUp(xtermEl);

    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("kopiert, wenn die Maus nach einem Druck im Terminal ueber der Suche losgelassen wird", () => {
    setTerminalPrefs({ copyOnSelect: true });
    const { container, xtermEl } = setupTile();
    hoisted.selection = "dragged text";
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });

    press(xtermEl);
    mouseUp(container.querySelector("input") as HTMLInputElement);

    // Ueber das Ziel entscheidet, wo der Druck war, nicht das Loslassen.
    expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("dragged text");
  });

  it("meldet einen Schreibfehler als Art copy", async () => {
    setTerminalPrefs({ copyOnSelect: true });
    clipboardWriteText.mockRejectedValue(new Error("Document is not focused."));
    const { xtermEl, onError, onCopied } = setupTile();
    hoisted.selection = "selected text";

    click(xtermEl);
    await flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "copy", detail: "Error: Document is not focused." });
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("meldet kein onCopied mehr, wenn die Ansicht vor dem Abschluss entsorgt wurde", async () => {
    setTerminalPrefs({ copyOnSelect: true });
    const { xtermEl, onCopied, handle } = setupTile();
    hoisted.selection = "selected text";

    click(xtermEl);
    handle.dispose();
    await flush();

    expect(clipboardWriteText).toHaveBeenCalledOnce();
    expect(onCopied).not.toHaveBeenCalled();
  });

  // Ziehen ueber den Rand: xterm verfolgt die Maus dann am Dokument, das
  // mouseup trifft ein Element AUSSERHALB des Containers.
  describe("Loslassen ausserhalb des Terminals", () => {
    it("kopiert, wenn der Druck im Terminal war", () => {
      setTerminalPrefs({ copyOnSelect: true });
      const { xtermEl } = setupTile();
      hoisted.selection = "dragged text";

      press(xtermEl);
      mouseUp(document.body);

      expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("dragged text");
    });

    it("kopiert nicht, wenn der Druck nicht im Terminal war", () => {
      setTerminalPrefs({ copyOnSelect: true });
      setupTile();
      hoisted.selection = "old selection";

      mouseUp(document.body);

      expect(clipboardWriteText).not.toHaveBeenCalled();
    });

    it("gilt nur fuer EIN Loslassen: das naechste ausserhalb kopiert nichts", () => {
      setTerminalPrefs({ copyOnSelect: true });
      const { xtermEl } = setupTile();
      hoisted.selection = "dragged text";

      press(xtermEl);
      mouseUp(document.body);
      mouseUp(document.body);

      expect(clipboardWriteText).toHaveBeenCalledOnce();
    });

    it("kopiert beim Loslassen im selben Terminal genau einmal", () => {
      setTerminalPrefs({ copyOnSelect: true });
      const { xtermEl } = setupTile();
      hoisted.selection = "selected text";

      press(xtermEl);
      mouseUp(xtermEl);

      expect(clipboardWriteText).toHaveBeenCalledOnce();
    });

    it("kopiert nicht, wenn die Maus ausserhalb gedrueckt und im Terminal losgelassen wird", () => {
      setTerminalPrefs({ copyOnSelect: true });
      const { xtermEl } = setupTile();
      // Die noch sichtbare Markierung gehoert nicht zu dieser Geste.
      hoisted.selection = "old selection";

      press(document.body);
      mouseUp(xtermEl);

      expect(clipboardWriteText).not.toHaveBeenCalled();
    });
  });

  // Mehrere Kacheln stehen gleichzeitig im Dokument, jede mit eigener,
  // womoeglich noch sichtbarer Markierung. Jede hoert am Dokument mit -- die
  // Kachel, in der der Druck war, kopiert, keine andere.
  describe("zwei Kacheln nebeneinander", () => {
    function twoTiles() {
      setTerminalPrefs({ copyOnSelect: true });
      const a = setupTile();
      const b = setupTile();
      hoisted.terminals[0].ownSelection = "text of A";
      hoisted.terminals[1].ownSelection = "stale selection of B";
      return { a, b };
    }

    it("Druck in A, Loslassen ueber B: kopiert nur A, und nur A meldet Copied", async () => {
      const { a, b } = twoTiles();

      press(a.xtermEl);
      mouseUp(b.xtermEl);
      await flush();

      // Die alte Markierung von B darf die Kopie von A nicht ueberschreiben.
      expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("text of A");
      expect(a.onCopied).toHaveBeenCalledOnce();
      expect(b.onCopied).not.toHaveBeenCalled();
    });

    it("Druck und Loslassen in B: kopiert nur B", async () => {
      const { a, b } = twoTiles();

      click(b.xtermEl);
      await flush();

      expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("stale selection of B");
      expect(a.onCopied).not.toHaveBeenCalled();
      expect(b.onCopied).toHaveBeenCalledOnce();
    });

    it("Druck ausserhalb jeder Kachel, Loslassen ueber B: kopiert nichts", () => {
      const { b } = twoTiles();

      press(document.body);
      mouseUp(b.xtermEl);

      expect(clipboardWriteText).not.toHaveBeenCalled();
    });
  });

  // Ein mouseup, das nie ankommt (Alt+Tab mitten im Ziehen), darf keine
  // Kachel auf Dauer scharf lassen: sonst kopierte das naechste Loslassen
  // irgendwo ihre alte Markierung.
  describe("verlorenes Loslassen", () => {
    it("der Verlust des Fensterfokus stellt nichts mehr scharf", () => {
      setTerminalPrefs({ copyOnSelect: true });
      const { xtermEl } = setupTile();
      hoisted.selection = "dragged text";

      press(xtermEl);
      window.dispatchEvent(new Event("blur"));
      mouseUp(document.body);

      expect(clipboardWriteText).not.toHaveBeenCalled();
    });

    it("der naechste Druck anderswo entscheidet neu: dann kopiert nur die Kachel, in der er war", () => {
      setTerminalPrefs({ copyOnSelect: true });
      const a = setupTile();
      const b = setupTile();
      hoisted.terminals[0].ownSelection = "text of A";
      hoisted.terminals[1].ownSelection = "text of B";

      press(a.xtermEl); // das mouseup dazu kommt nie an
      click(b.xtermEl);

      expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("text of B");
    });
  });
});

describe("mountTerminal: Such-Overlay darf die von FitAddon gemessene Box nicht veraendern (Review-Befund)", () => {
  // Befund: die Suchleiste (`views/terminal-search.ts`) haengt sich in `el` (das Element,
  // in das der Aufrufer mountet -- in Produktion `.tile-terminal`,
  // `grid.ts`s Kachel-Mountpunkt seit Shell-Task 10/11, dasselbe Element,
  // dessen `clientWidth`/`clientHeight` `FitAddon.fit()` beim naechsten
  // Resize abliest -- siehe Kommentar in `terminal.ts::mountTerminal`). NUR
  // `position: absolute`
  // (die Regel `.terminal-search-overlay` in `src/styles.css`) haelt den
  // Overlay aus dem normalen Layoutfluss; ohne sie wuerde ein statisch
  // positionierter Block-Kindknoten `el`s eigene Inhaltsbox beeinflussen
  // koennen, ein nachfolgender Resize haette eine andere gemessene Groesse
  // zur Grundlage, und `resize_terminal` wuerde ausgeloest -- genau das
  // ESC[3J-Risiko (Spec V12), um das es in Task 12 geht.
  //
  // jsdom berechnet KEIN echtes Boxlayout (`getBoundingClientRect`/
  // `clientWidth`/`clientHeight` sind fuer jedes Element immer 0,
  // unabhaengig vom CSS -- empirisch mit jsdom 29.1.1 geprueft) -- ein
  // Test, der die "gemessene Groesse" selbst vergleicht,
  // waere deshalb vor UND nach einer Regression identisch (immer 0) und
  // koennte nichts beweisen. jsdom LOEST aber `getComputedStyle` korrekt
  // gegen ein echtes, per `<style>` eingehaengtes Stylesheet auf (ebenfalls
  // empirisch geprueft) -- dieser Test laedt deshalb den ECHTEN Inhalt von
  // `src/styles.css` (nicht eine Kopie/Abschrift der Regel) und prueft den
  // ursaechlichen Mechanismus selbst: dass die ausgelieferte Regel den
  // Overlay tatsaechlich auf `position: absolute` setzt. Das faengt BEIDE
  // Regressionsrichtungen -- die Regel wird aus dem Stylesheet entfernt,
  // ODER `terminal.ts` vergibt eine andere `className` -- weil in beiden
  // Faellen die Regel nicht mehr greift und `getComputedStyle(...).position`
  // auf den Default (`"static"`) zurueckfaellt.
  beforeAll(() => {
    // Pfad ist bewusst `cwd`-relativ (nicht `import.meta.url` -- das lieferte
    // unter diesem Vitest-Setup keine gueltige `file:`-URL, empirisch
    // geprueft) und `npm test`/`vitest run` laeuft immer aus dem
    // Projekt-Wurzelverzeichnis (siehe `package.json`).
    // @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar beim Import oben
    const cssText = readFileSync(path.resolve(process.cwd(), "src/styles.css"), "utf-8");
    const styleEl = document.createElement("style");
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);
  });

  it("setzt .terminal-search-overlay auf position: absolute -- die eigentliche Resize-Sicherheits-Invariante", () => {
    const container = document.createElement("div");
    mount(container, "host-1", "sess-1");

    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    const overlay = container.querySelector(".terminal-search-overlay");
    expect(overlay).not.toBeNull();
    expect(getComputedStyle(overlay as Element).position).toBe("absolute");
  });

  it("setzt .tile-terminal auf position: relative -- nur der visuelle Anker, KEINE eigene Resize-Sicherheits-Eigenschaft", () => {
    // Getrennt von der Assertion oben: `position: relative` auf dem
    // Container legt nur fest, WOHIN sich `position: absolute` auf dem
    // Overlay bezieht (oben rechts IM Container statt im naechsten
    // positionierten Vorfahren). Ginge diese Regel verloren, veraenderte
    // sich nur die Bildschirmposition des Overlays -- NICHT die von
    // `FitAddon` gemessene Box, weil `absolute` allein schon aus dem
    // Layoutfluss heraustritt.
    //
    // `.tile-terminal`, nicht die vor Shell-Task 11 entfernte `#terminal-
    // container`-ID (die gehoerte main.ts' altem Einzel-Terminal-Markup,
    // das mit diesem Task entfallen ist): `grid.ts` mountet seit Shell-Task
    // 10 jede Kachel in ein Element dieser Klasse, das ist seither der
    // tatsaechliche Produktions-Mountpunkt, dessen CSS-Regel dieser Test
    // pruefen soll.
    const container = document.createElement("div");
    container.className = "tile-terminal";
    document.body.appendChild(container);
    try {
      expect(getComputedStyle(container).position).toBe("relative");
    } finally {
      container.remove();
    }
  });
});

describe("mountTerminal: kein Resize beim Wechsel (dispose() + erneutes mounten derselben Session)", () => {
  it("loest beim erneuten Mounten derselben Session nach dispose() keinen resize_terminal-Aufruf aus", async () => {
    // Genau dieses Szenario: Ctrl+Shift+W disposed die Ansicht
    // (ohne close_terminal), main.ts mountet dieselbe Session spaeter erneut
    // (Wiedereroeffnen-Schaltflaeche). `open_terminal` beim Remount traegt
    // die Groesse bereits im PTY-Request -- ein zusaetzlicher
    // `resize_terminal`-Aufruf allein durch den Wechsel waere ein
    // ESC[3J-Risiko (V12) ohne jeden Nutzen.
    const container = document.createElement("div");
    const first = mount(container, "host-1", "sess-1");
    await Promise.resolve();
    await Promise.resolve();
    first.dispose();

    mount(container, "host-1", "sess-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.some(([command]) => command === "resize_terminal"),
    ).toBe(false);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "open_terminal"),
    ).toHaveLength(2);
  });

  it("bestaetigt beim Wechsel (dispose waehrend Bytes ausstehen) und schliesst den Kanal", async () => {
    // Wiederholt (nicht ersetzt) die bestehende Ack-Nachbestaetigungs-
    // Pruefung aus Task 11 explizit im Rahmen des in Task 12 zum
    // Normalfall werdenden Tab-Wechsel-Szenarios -- die Nachbestaetigung muss
    // beim Wechsel tatsaechlich greifen, nicht nur bestehen. Task 3
    // vervollstaendigt das: dispose() schliesst nun auch den PTY-Kanal.
    let capturedListener: Listener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedListener = handler as Listener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-1", "sess-1");
    await flush(); // open_terminal ist hinaus: erst dann schliesst das Entsorgen
    capturedListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1", bytes: [1, 2, 3] } });

    handle.dispose();

    const ackCalls = invokeMock.mock.calls.filter(([command]) => command === "ack_output");
    expect(ackCalls).toHaveLength(1);
    expect((ackCalls[0][1] as { byteCount: number }).byteCount).toBe(3);
    expect(
      invokeMock.mock.calls.some(([command]) => command === "close_terminal"),
    ).toBe(true);
  });
});

// M-C (Abschlussreview): Rust emittiert `terminal://connection-lost`, wenn
// die Pumpaufgabe beim Aufraeumen feststellt, dass niemand sonst den Eintrag
// zuvor entfernt hat (siehe commands.rs' `OutputSink::connection_lost`).
// Diese Tests pruefen ausschliesslich die Verdrahtung im WebView: Eingabe
// sperren (`term.options.disableStdin = true`) und `onConnectionLost`
// aufrufen -- fuer die RICHTIGE Session, nicht fuer jede.
describe("mountTerminal: terminal://connection-lost (M-C, Abschlussreview)", () => {
  it("sperrt die Eingabe und ruft onConnectionLost auf, wenn ein Verbindungsverlust fuer diese Session ankommt", () => {
    let capturedLostListener: LostListener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://connection-lost") capturedLostListener = handler as LostListener;
      return Promise.resolve(vi.fn());
    });

    const onConnectionLost = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", undefined, { onConnectionLost });
    expect(capturedLostListener).toBeDefined();

    expect(hoisted.lastOptions?.disableStdin).toBe(false);
    capturedLostListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1" } });

    expect(hoisted.lastOptions?.disableStdin).toBe(true);
    expect(onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it("ignoriert ein Verbindungsverlust-Ereignis fuer eine andere Session", () => {
    let capturedLostListener: LostListener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://connection-lost") capturedLostListener = handler as LostListener;
      return Promise.resolve(vi.fn());
    });

    const onConnectionLost = vi.fn();
    mount(document.createElement("div"), "host-1", "sess-1", undefined, { onConnectionLost });

    capturedLostListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-OTHER" } });

    expect(hoisted.lastOptions?.disableStdin).toBe(false);
    expect(onConnectionLost).not.toHaveBeenCalled();
  });

  /// Der dritte Pfad (Ctrl+Shift+W): der Aufrufer entsorgt
  /// den `TerminalHandle` (heute `grid.ts::reconcile`, damals ein
  /// `closeTerminalView` in main.ts, das es seit Shell-Task 11 nicht mehr
  /// gibt). Stirbt die
  /// Verbindung ECHT, waehrend die View bereits disposed ist (z. B. der
  /// Nutzer hat kurz vorher Ctrl+Shift+W gedrueckt), darf das spaeter
  /// ankommende Ereignis weder auf das bereits entsorgte `term` zugreifen
  /// noch `onConnectionLost` aufrufen -- dasselbe Guard-Muster wie beim
  /// bestehenden Test "schreibt nicht mehr, wenn ein Event ankommt, nachdem
  /// dispose() bereits lief" fuer `terminal://output`.
  it("reagiert nicht mehr auf ein Verbindungsverlust-Ereignis, das ankommt, nachdem dispose() bereits lief", () => {
    let capturedLostListener: LostListener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://connection-lost") capturedLostListener = handler as LostListener;
      return Promise.resolve(vi.fn());
    });

    const onConnectionLost = vi.fn();
    const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, {
      onConnectionLost,
    });
    handle.dispose();

    capturedLostListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1" } });

    expect(hoisted.lastOptions?.disableStdin).toBe(false);
    expect(onConnectionLost).not.toHaveBeenCalled();
  });

  it("sperrt die Eingabe NICHT, wenn der Verbindungsverlust einen anderen Host betrifft", () => {
    let capturedLostListener: LostListener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://connection-lost") capturedLostListener = handler as LostListener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-2", "gleich", undefined, {});

    // Zwei Hosts duerfen gleichnamige tmux-Sessions haben (Spec §4.3). Ein
    // Filter, der nur `session` vergleicht, wuerde dieses Ereignis
    // faelschlich auch auf das Terminal von "host-2" anwenden -- genau der
    // Fehler, den Shell-Task 7 behoben hat: `terminal.ts` vergleicht seither
    // `event.payload.host_id` mit dem eigenen `hostId`. Der Satz stand hier
    // im Praesens und beschrieb damit einen laengst vergangenen Zustand.
    capturedLostListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "gleich" } });

    expect(hoisted.lastOptions?.disableStdin).not.toBe(true);
    handle.dispose();
  });

  // Befund 9 (Abschlussbewertung 2026-09-04): der Refit, den die Sperrleiste
  // nach einem Verbindungsverlust ausloest (Layoutwechsel um die Anzeige
  // herum), trifft im Backend auf einen bereits entfernten Terminaleintrag --
  // `resize_terminal` darf danach fuer DIESE Kachel gar nicht mehr gesendet
  // werden.
  it("sendet nach connection-lost kein resize_terminal mehr", async () => {
    vi.useFakeTimers();
    let lost: LostListener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://connection-lost") lost = handler as LostListener;
      return Promise.resolve(vi.fn());
    });
    const handle = mount(document.createElement("div"), "host-1", "sess-1", undefined, {});
    // Angehaengt: vorher sendet ein Refit ohnehin nichts (Abnahme B1), und
    // der Test waere auch ohne das `channelClosed`-Flag gruen.
    await flush();
    lost?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "sess-1" } });
    invokeMock.mockClear();
    // Die Zeile `hoisted.size = ...` unten ist noetig: ohne eine ECHTE
    // Groessenaenderung greift bereits der
    // bestehende Wachhund (`lastSentCols`/`lastSentRows`, Befund 1) und
    // verhindert den `resize_terminal`-Aufruf -- der Test waere dann auch
    // OHNE das `channelClosed`-Flag gruen, also kein echter Beleg fuer den
    // Fix. Gleiche Werte wie die anderen Resize-Tests oben (Zeile ~767/834).
    hoisted.size = { cols: 100, rows: 30 };
    handle.refit();
    vi.advanceTimersByTime(1000);
    expect(invokeMock).not.toHaveBeenCalledWith("resize_terminal", expect.anything());
    handle.dispose();
    vi.useRealTimers();
  });
});

// Befund 2 (Bewertung 2026-09-04): `terminal://connection-lost` vergleicht
// den Host bereits (Test oben), `terminal://output` tat es nicht -- zwei
// Hosts duerfen gleichnamige tmux-Sessions haben (Spec §4.3), ein Filter,
// der nur `session` prueft, schriebe fremde Ausgabe in diese Kachel.
describe("mountTerminal: terminal://output vergleicht auch den Host (Befund 2)", () => {
  it("schreibt Ausgabe eines anderen Hosts mit gleichnamiger Session NICHT ins Terminal", () => {
    type OutputListener = (event: {
      payload: { host_id: string; open_id: string; session: string; bytes: number[] };
    }) => void;
    let capturedOutputListener: OutputListener | undefined;
    listenMock.mockImplementation((event, handler) => {
      if (event === "terminal://output") capturedOutputListener = handler as OutputListener;
      return Promise.resolve(vi.fn());
    });

    const handle = mount(document.createElement("div"), "host-2", "gleich", undefined, {});
    hoisted.writeCalls.length = 0;

    capturedOutputListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-1", session: "gleich", bytes: [65] } });
    expect(hoisted.writeCalls).toHaveLength(0);

    capturedOutputListener?.({ payload: { open_id: FIXED_OPEN_ID, host_id: "host-2", session: "gleich", bytes: [65] } });
    expect(hoisted.writeCalls).toHaveLength(1);
    handle.dispose();
  });
});

/** Legt `visible` als einzige Pufferzeile ab und liefert den Bereich, den xterm
 * fuer einen OSC-8-Link ueber genau diesen Text meldet (1-basiert, Ende
 * eingeschlossen). */
function showInBuffer(visible: string): MockBufferRange {
  hoisted.bufferLines = [visible];
  return { start: { x: 1, y: 1 }, end: { x: visible.length, y: 1 } };
}

// UX-Spec §6.5: Links oeffnen nur mit Strg+Klick, ueber den Command `open_link`
// (Rust prueft Schema, Zeichen und Laenge noch einmal). Zwei Wege fuehren
// dorthin: das WebLinks-Addon fuer Text, der wie eine URL aussieht, und der
// `linkHandler` fuer OSC-8-Links (`ESC]8;;url`). Beide folgen derselben Regel.
// Ein Klick ohne Strg tut nichts, und der Browser wird nie ueber ein eigenes
// Fenster geoeffnet: WebView2 schluckt das.
//
// Terminal-Ausgabe ist angreiferbeeinflussbar (Spec §8.3). Der `linkHandler`
// ersetzt `defaultActivate` von xterm VOLLSTAENDIG (siehe `ILinkHandler` in
// `@xterm/xterm`) -- deshalb pruefen die Tests sowohl die Ablehnung unsicherer
// Schemata ALS AUCH, dass http/https tatsaechlich ankommt.
describe("mountTerminal: Links nur mit Strg+Klick (UX-Spec §6.5)", () => {
  type LinkEvent = (event: MouseEvent, uri: string) => void;
  type OscLinkEvent = (event: MouseEvent, uri: string, range: MockBufferRange) => void;

  /** Der Rueckruf, oder ein lauter Fehler: ein nicht angemeldeter Rueckruf liesse
   * jede Zusicherung "tut nichts" unten von selbst bestehen. */
  function must(callback: LinkEvent | undefined, what: string): LinkEvent {
    if (!callback) throw new Error(`${what} ist nicht angemeldet`);
    return callback;
  }

  /** Wie `must`, fuer den `linkHandler`: xterm ruft ihn bei OSC 8 mit dem
   * Bereich des sichtbaren Texts. Hier zeigt der Text genau das Ziel -- der
   * Fall, in dem dieselbe Regel gilt wie beim Addon. */
  function mustShowingUri(callback: OscLinkEvent | undefined, what: string): LinkEvent {
    if (!callback) throw new Error(`${what} ist nicht angemeldet`);
    return (event, uri) => callback(event, uri, showInBuffer(uri));
  }

  const ways: Array<{
    name: string;
    activate: () => LinkEvent;
    hover: () => LinkEvent;
    leave: () => LinkEvent;
  }> = [
    {
      name: "WebLinks-Addon",
      activate: () => must(hoisted.webLinks.handler, "WebLinks-Addon"),
      hover: () => must(hoisted.webLinks.options?.hover, "hover des WebLinks-Addons"),
      leave: () => must(hoisted.webLinks.options?.leave, "leave des WebLinks-Addons"),
    },
    {
      name: "OSC-8-Link (linkHandler)",
      activate: () => mustShowingUri(hoisted.lastOptions?.linkHandler?.activate, "linkHandler.activate"),
      hover: () => mustShowingUri(hoisted.lastOptions?.linkHandler?.hover, "linkHandler.hover"),
      leave: () => mustShowingUri(hoisted.lastOptions?.linkHandler?.leave, "linkHandler.leave"),
    },
  ];

  const mouseUp = (init: MouseEventInit = {}) =>
    new MouseEvent("mouseup", { bubbles: true, cancelable: true, ...init });
  const openLinkCalls = () => invokeMock.mock.calls.filter(([command]) => command === "open_link");

  /** `window.open` darf nie gerufen werden; der Spion steht in jedem Test. */
  let windowOpen: MockInstance<typeof window.open>;
  beforeEach(() => {
    windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
  });
  afterEach(() => {
    expect(windowOpen).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it("laedt das WebLinks-Addon und den linkHandler", () => {
    mount(document.createElement("div"), "host-1", "sess-1");

    for (const way of ways) expect(way.activate(), way.name).toBeTypeOf("function");
  });

  describe.each(ways)("$name", (way) => {
    it("ein Klick ohne Strg tut nichts", () => {
      mount(document.createElement("div"), "host-1", "sess-1");

      way.activate()(mouseUp(), "https://example.com");

      expect(openLinkCalls()).toEqual([]);
    });

    it("Strg+Klick oeffnet die URL ueber open_link, unveraendert", () => {
      mount(document.createElement("div"), "host-1", "sess-1");

      way.activate()(mouseUp({ ctrlKey: true }), "https://example.com");

      // Ohne abschliessenden Schraegstrich: `new URL(...).href` haette ihn
      // angehaengt, gesendet wird der Text, wie er im Terminal steht.
      expect(openLinkCalls()).toEqual([["open_link", { url: "https://example.com" }]]);
    });

    it("Strg+Klick oeffnet auch http mit Pfad, Abfrage und Anker", () => {
      mount(document.createElement("div"), "host-1", "sess-1");

      way.activate()(mouseUp({ ctrlKey: true }), "http://localhost:3000/a/b?x=1&y=2#frag");

      expect(openLinkCalls()).toEqual([["open_link", { url: "http://localhost:3000/a/b?x=1&y=2#frag" }]]);
    });

    it("Strg+Mittelklick oder Strg+Rechtsklick oeffnet nichts: nur die primaere Taste klickt", () => {
      mount(document.createElement("div"), "host-1", "sess-1");

      way.activate()(mouseUp({ ctrlKey: true, button: 1 }), "https://example.com");
      way.activate()(mouseUp({ ctrlKey: true, button: 2 }), "https://example.com");

      expect(openLinkCalls()).toEqual([]);
    });

    it.each([
      "file:///etc/passwd",
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/file",
      "not a url at all",
      "",
    ])("Strg+Klick auf %j oeffnet nichts und wirft nicht", (text) => {
      mount(document.createElement("div"), "host-1", "sess-1");

      expect(() => way.activate()(mouseUp({ ctrlKey: true }), text)).not.toThrow();

      expect(openLinkCalls()).toEqual([]);
    });

    it("eine abgelehnte Anfrage bleibt still: nur die Konsole, kein Fehlerbanner", async () => {
      invokeMock.mockImplementation((command: string) =>
        command === "open_link" ? Promise.reject("invalid link") : Promise.resolve(undefined),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const onError = vi.fn();
        mount(document.createElement("div"), "host-1", "sess-1", onError);

        expect(() => way.activate()(mouseUp({ ctrlKey: true }), "https://example.com")).not.toThrow();
        await flush();

        expect(openLinkCalls()).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    });

    it("nach dem Entsorgen oeffnet ein spaeter Klick nichts mehr", () => {
      const handle = mount(document.createElement("div"), "host-1", "sess-1");
      const activate = way.activate();
      handle.dispose();

      activate(mouseUp({ ctrlKey: true }), "https://example.com");

      expect(openLinkCalls()).toEqual([]);
    });

    it("zeigt beim Ueberfahren den Hinweis als Tooltip am Terminalelement und nimmt ihn beim Verlassen weg", () => {
      mount(document.createElement("div"), "host-1", "sess-1", undefined, {
        linkHint: en["terminal.link.hint"],
      });
      const element = hoisted.terminals[0].element;
      expect(element).toBeDefined();
      expect(element?.hasAttribute("title")).toBe(false);

      way.hover()(new MouseEvent("mousemove"), "https://example.com");
      expect(element?.title).toBe("Ctrl+click to open");

      way.leave()(new MouseEvent("mousemove"), "https://example.com");
      expect(element?.hasAttribute("title")).toBe(false);
    });

    it("setzt ohne Hinweistext keinen Tooltip", () => {
      mount(document.createElement("div"), "host-1", "sess-1");

      way.hover()(new MouseEvent("mousemove"), "https://example.com");

      expect(hoisted.terminals[0].element?.hasAttribute("title")).toBe(false);
    });
  });
});

// Bei OSC 8 ist der sichtbare Text frei waehlbar, und Terminal-Ausgabe ist
// angreiferbeeinflussbar. Zeigt der Text das Ziel nicht, oeffnet Strg+Klick
// noch nichts: am Zeiger erscheint die Rueckfrage mit dem vollen Ziel (Huelle
// des Terminalmenues, `views/terminal-menu.ts`). Sie waehlt erst nach 500 ms
// aus (`armDelayMs`).
const LINK_CONFIRM_TEXTS = {
  open: en["terminal.link.open"],
  note: en["terminal.link.differs"],
};

describe("mountTerminal: OSC-8-Link, dessen Text nicht sein Ziel zeigt", () => {
  const TARGET = "https://evil.example/login";
  const mouseUp = (init: MouseEventInit = {}) =>
    new MouseEvent("mouseup", { bubbles: true, cancelable: true, ...init });
  const openLinkCalls = () => invokeMock.mock.calls.filter(([command]) => command === "open_link");

  /** Wie xterm bei einem Klick auf einen OSC-8-Link: Ziel und Bereich des
   * sichtbaren Texts. */
  function activate(event: MouseEvent, uri: string, range: MockBufferRange): void {
    const callback = hoisted.lastOptions?.linkHandler?.activate;
    if (!callback) throw new Error("linkHandler.activate ist nicht angemeldet");
    callback(event, uri, range);
  }

  function heading(): string | null | undefined {
    return terminalMenu()?.querySelector(".terminal-menu-heading")?.textContent;
  }

  it("Strg+Klick oeffnet nichts, sondern zeigt am Zeiger das volle Ziel und Open link", () => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });

    activate(mouseUp({ ctrlKey: true, clientX: 150, clientY: 70 }), TARGET, showInBuffer("Click here"));

    expect(openLinkCalls()).toEqual([]);
    expect(heading()).toBe(TARGET);
    expect(terminalMenu()?.style.left).toBe("150px");
    expect(terminalMenu()?.style.top).toBe("70px");
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent)).toEqual([
      "Open link",
    ]);
    expect(terminalMenu()?.querySelector(".terminal-menu-hint")?.textContent).toBe(
      "The link text differs from this address.",
    );
    expect(document.activeElement).toBe(menuItem("Open link"));
  });

  it("Open link oeffnet genau das Ziel ueber open_link und gibt den Fokus ans Terminal zurueck", () => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });
    vi.useFakeTimers();
    try {
      activate(mouseUp({ ctrlKey: true }), TARGET, showInBuffer("Click here"));
      vi.advanceTimersByTime(500);

      menuItem("Open link").click();

      expect(openLinkCalls()).toEqual([["open_link", { url: TARGET }]]);
      expect(terminalMenu()).toBeNull();
      expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Ein langes Ziel macht die Rueckfrage hoch, `placeTerminalMenu` haelt sie
  // dann oben im Fenster, und "Open link" kann unter dem Zeiger liegen: Der
  // zweite Klick eines Strg+Doppelklicks oder ein schnelles Enter gehoeren
  // noch zur Geste, die die Rueckfrage oeffnete.
  it("ein Klick oder Enter direkt nach dem Oeffnen oeffnet nichts, erst nach 500 ms", () => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });
    vi.useFakeTimers();
    try {
      activate(mouseUp({ ctrlKey: true }), TARGET, showInBuffer("Click here"));

      menuItem("Open link").click();
      pressInMenu("Enter");
      vi.advanceTimersByTime(499);
      menuItem("Open link").click();

      expect(openLinkCalls()).toEqual([]);
      expect(heading()).toBe(TARGET);

      vi.advanceTimersByTime(1);
      menuItem("Open link").click();

      expect(openLinkCalls()).toEqual([["open_link", { url: TARGET }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Escape schliesst die Rueckfrage, ohne zu oeffnen", () => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });
    activate(mouseUp({ ctrlKey: true }), TARGET, showInBuffer("Click here"));

    pressInMenu("Escape");

    expect(terminalMenu()).toBeNull();
    expect(openLinkCalls()).toEqual([]);
  });

  // Ein spaeteres Vereinfachen (etwa nur den Host vergleichen) darf weder
  // http statt https noch eine Adresse ohne Schema oder mit Anker durchlassen.
  it.each([
    "Click here",
    "https://example.com",
    "http://evil.example/login",
    "evil.example/login",
    "https://evil.example/login#x",
  ])("ein Text, der nicht genau das Ziel zeigt, gilt als abweichend: %s", (visible) => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });

    activate(mouseUp({ ctrlKey: true }), TARGET, showInBuffer(visible));

    expect(openLinkCalls()).toEqual([]);
    expect(heading()).toBe(TARGET);
  });

  it("liest den Text aus dem gemeldeten Bereich: dieselbe Adresse mitten in der Zeile oeffnet sofort", () => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });
    hoisted.bufferLines = ["go https://example.com now"];

    // Spalten 4 bis 22 (1-basiert, eingeschlossen) sind genau die Adresse.
    activate(mouseUp({ ctrlKey: true }), "https://example.com", { start: { x: 4, y: 1 }, end: { x: 22, y: 1 } });

    expect(terminalMenu()).toBeNull();
    expect(openLinkCalls()).toEqual([["open_link", { url: "https://example.com" }]]);
  });

  it("zaehlt dieselbe Adresse in anderer Schreibweise als ihr Ziel", () => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });

    activate(mouseUp({ ctrlKey: true }), "https://example.com/", showInBuffer("https://EXAMPLE.com"));

    expect(terminalMenu()).toBeNull();
    expect(openLinkCalls()).toEqual([["open_link", { url: "https://example.com/" }]]);
  });

  it("ohne Strg zeigt auch ein abweichender Link keine Rueckfrage", () => {
    setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });

    activate(mouseUp(), TARGET, showInBuffer("Click here"));

    expect(terminalMenu()).toBeNull();
    expect(openLinkCalls()).toEqual([]);
  });

  it("ohne Texte oeffnet ein abweichender Link gar nicht, auch nicht ungefragt", () => {
    setupTile();

    activate(mouseUp({ ctrlKey: true }), TARGET, showInBuffer("Click here"));

    expect(terminalMenu()).toBeNull();
    expect(openLinkCalls()).toEqual([]);
  });

  it("Entsorgen schliesst eine offene Rueckfrage, ohne zu oeffnen", () => {
    const { handle } = setupTile({ linkConfirmTexts: LINK_CONFIRM_TEXTS });
    activate(mouseUp({ ctrlKey: true }), TARGET, showInBuffer("Click here"));

    handle.dispose();

    expect(terminalMenu()).toBeNull();
    expect(openLinkCalls()).toEqual([]);
  });

  it("nennt das Ziel schon im Tooltip, vor dem Hinweis", () => {
    setupTile({ linkHint: en["terminal.link.hint"] });
    const hover = hoisted.lastOptions?.linkHandler?.hover;
    if (!hover) throw new Error("linkHandler.hover ist nicht angemeldet");

    hover(new MouseEvent("mousemove"), TARGET, showInBuffer("Click here"));

    expect(hoisted.terminals[0].element?.title).toBe(`${TARGET}\nCtrl+click to open`);
  });
});

// UX-Spec §6.6: die Suchleiste (`views/terminal-search.ts`) ist hier an das
// Terminal gehaengt. Ihr eigenes Verhalten pruefen `terminal-search.test.ts`
// (gegen eine Attrappe) und `terminal-search.addon.test.ts` (gegen das echte
// Addon); hier geht es um die Verdrahtung in `mountTerminal`: Texte, Farben aus
// dem Thema, Fokus, Entsorgen und die Tasten.
const SEARCH_TEXTS: TerminalSearchTexts = {
  placeholder: en["terminal.search.placeholder"],
  count: (current, total) =>
    en["terminal.search.count"].replace("{current}", String(current)).replace("{total}", String(total)),
  none: en["terminal.search.none"],
  prev: en["terminal.search.prev"],
  next: en["terminal.search.next"],
  matchCase: en["terminal.search.matchCase"],
  close: en["terminal.search.close"],
};

describe("mountTerminal: Suchleiste (UX-Spec §6.6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function openSearch(extra: Partial<MountOptions> = {}) {
    const tile = setupTile({ searchTexts: SEARCH_TEXTS, ...extra });
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    const input = tile.container.querySelector<HTMLInputElement>(".terminal-search-input");
    if (!input) throw new Error("Suchfeld fehlt");
    return { ...tile, input };
  }

  function typeInto(input: HTMLInputElement, text: string): void {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const counterText = (container: HTMLElement) =>
    container.querySelector(".terminal-search-count")?.textContent;

  function press(target: Element, init: KeyboardEventInit & { key: string }): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("haengt die Leiste in den Kachelcontainer und gibt ihr die Texte aus MountOptions", () => {
    const { container, input } = openSearch();

    const overlay = container.querySelector(".terminal-search-overlay");
    expect(overlay?.parentElement).toBe(container);
    expect(input.placeholder).toBe("Find");
    const labels = Array.from(overlay?.querySelectorAll("button") ?? []).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Previous match", "Next match", "Match case", "Close"]);
  });

  it("sucht beim Tippen nach 150 ms, mit den Farben aus dem Thema und ohne Groesse/Kleinschreibung", () => {
    const { input } = openSearch();

    typeInto(input, "needle");
    vi.advanceTimersByTime(149);
    expect(hoisted.searchCalls).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(hoisted.searchCalls).toEqual([{ type: "next", term: "needle" }]);
    // Tuerkis auf Graphit: Treffer in der Farbe der inaktiven Auswahl, der aktive
    // in der Auswahlfarbe des Akzents mit Rahmen im Akzent (`cursor`). Alles
    // `#RRGGBB`, wie das Addon es verlangt.
    expect(hoisted.searchOptions).toEqual([
      {
        caseSensitive: false,
        decorations: {
          matchBackground: "#2A323D",
          matchOverviewRuler: "#2DD4BF",
          activeMatchBackground: "#2B4A52",
          activeMatchBorder: "#2DD4BF",
          activeMatchColorOverviewRuler: "#2DD4BF",
        },
      },
    ]);
  });

  it("liest die Farben bei jeder Suche vom gerade gueltigen Thema, auch nach setTheme()", () => {
    const { input, handle } = openSearch();
    typeInto(input, "needle");
    vi.advanceTimersByTime(150);

    handle.setTheme("slate");
    typeInto(input, "needles");
    vi.advanceTimersByTime(150);

    const decorations = hoisted.searchOptions.map((options) => options?.decorations);
    expect(decorations).toHaveLength(2);
    expect(decorations[1]).toEqual({
      matchBackground: "#283349",
      matchOverviewRuler: "#6FA8FF",
      activeMatchBackground: "#2B3E5C",
      activeMatchBorder: "#6FA8FF",
      activeMatchColorOverviewRuler: "#6FA8FF",
    });
    expect(decorations[1]).not.toEqual(decorations[0]);
  });

  it("zeigt den Zaehler aus onDidChangeResults: 3/17 und No results", () => {
    const { container, input } = openSearch();
    typeInto(input, "needle");
    vi.advanceTimersByTime(150);

    hoisted.resultListeners.forEach((listener) => listener({ resultIndex: 2, resultCount: 17 }));
    expect(counterText(container)).toBe("3/17");

    hoisted.resultListeners.forEach((listener) => listener({ resultIndex: -1, resultCount: 0 }));
    expect(counterText(container)).toBe("No results");
  });

  it("Enter und Umschalt+Enter springen zum naechsten und zum vorigen Treffer", () => {
    const { input } = openSearch();
    typeInto(input, "needle");
    vi.advanceTimersByTime(150);
    hoisted.searchCalls.length = 0;

    press(input, { key: "Enter" });
    press(input, { key: "Enter", shiftKey: true });

    expect(hoisted.searchCalls).toEqual([
      { type: "next", term: "needle" },
      { type: "prev", term: "needle" },
    ]);
  });

  // Review Focus 5: die Suche setzt Markierungen, kopiert wird nur beim
  // Loslassen der Maus.
  it("Treffer beim Tippen markieren, ohne die Zwischenablage zu beruehren", () => {
    setTerminalPrefs({ copyOnSelect: true });
    const { input } = openSearch();

    typeInto(input, "needle");
    vi.advanceTimersByTime(150);

    expect(hoisted.searchCalls).toEqual([{ type: "next", term: "needle" }]);
    expect(hoisted.selection).toBe("needle");
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("der Knopf ✕ schliesst, raeumt die Hervorhebung weg und legt den Fokus ins Terminal", () => {
    const { container } = openSearch();
    const focusBefore = hoisted.focusCalls;

    container.querySelector<HTMLButtonElement>('button[data-action="close"]')?.click();

    expect(container.querySelector(".terminal-search-overlay")).toBeNull();
    expect(hoisted.clearDecorationsCalls).toBe(1);
    expect(hoisted.focusCalls).toBe(focusBefore + 1);
    expect(document.activeElement).toBe(container.querySelector(".xterm-helper-textarea"));
  });

  it("Esc im Feld schliesst die Leiste und haelt das Ereignis an", () => {
    const { container, input } = openSearch();
    const atDocument = vi.fn();
    document.addEventListener("keydown", atDocument);
    try {
      const event = press(input, { key: "Escape" });

      expect(container.querySelector(".terminal-search-overlay")).toBeNull();
      expect(hoisted.clearDecorationsCalls).toBe(1);
      expect(event.defaultPrevented).toBe(true);
      expect(atDocument).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", atDocument);
    }
  });

  // Der Tastenlauscher fuer die maximierte Kachel (keyboard.ts) ist hier echt.
  it("Esc im Feld laesst eine maximierte Kachel maximiert", () => {
    const restoreMaximized = vi.fn(() => true);
    const uninstall = installKeyboard({
      newSession: vi.fn(),
      toggleSidebar: vi.fn(),
      focusSidebar: vi.fn(),
      toggleMaximize: vi.fn(),
      moveTile: vi.fn(),
      selectTile: vi.fn(),
      prevSession: vi.fn(),
      nextSession: vi.fn(),
      nextWaiting: vi.fn(),
      openSettings: vi.fn(),
      openQuickOpen: vi.fn(),
      changeFontSize: vi.fn(),
      restoreMaximized,
      isDialogOpen: () => false,
    });
    try {
      const { input } = openSearch();

      press(input, { key: "Escape" });

      expect(restoreMaximized).not.toHaveBeenCalled();

      // Kontrolle: derselbe Lauscher stellt bei einem Escape ausserhalb wieder
      // her -- ohne sie bewiese die Zusicherung oben nichts.
      const elsewhere = document.createElement("input");
      document.body.appendChild(elsewhere);
      press(elsewhere, { key: "Escape" });
      expect(restoreMaximized).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });

  it("Strg+Umschalt+F im Feld schliesst ebenfalls", () => {
    const { container, input } = openSearch();

    press(input, { key: "F", ctrlKey: true, shiftKey: true });

    expect(container.querySelector(".terminal-search-overlay")).toBeNull();
    expect(hoisted.clearDecorationsCalls).toBe(1);
  });

  it("dispose() baut die offene Leiste ab, ohne dem entsorgten Terminal den Fokus zu geben, und verwirft die ausstehende Suche", () => {
    const { container, input, handle } = openSearch();
    typeInto(input, "needle");
    vi.advanceTimersByTime(50);
    const focusBefore = hoisted.focusCalls;

    handle.dispose();
    vi.advanceTimersByTime(1000);

    expect(container.querySelector(".terminal-search-overlay")).toBeNull();
    expect(hoisted.focusCalls).toBe(focusBefore);
    expect(hoisted.searchCalls).toEqual([]);
    expect(hoisted.resultListeners.size).toBe(0);
  });
});

// Das Addon verlangt `#RRGGBB` fuer die Hintergruende und wuerde jeden anderen
// Wert nicht zeichnen. Neue Farbliterale gibt es hier nicht: alles stammt aus
// dem Terminalthema, das seinerseits an die Token aus styles.css gebunden ist.
describe("searchDecorations (UX-Spec §6.6)", () => {
  it("Treffer in der inaktiven Auswahlfarbe, der aktive in der Auswahlfarbe mit Akzentrahmen", () => {
    expect(searchDecorations(terminalTheme("turquoise"))).toEqual({
      matchBackground: "#2A323D",
      matchOverviewRuler: "#2DD4BF",
      activeMatchBackground: "#2B4A52",
      activeMatchBorder: "#2DD4BF",
      activeMatchColorOverviewRuler: "#2DD4BF",
    });
    expect(searchDecorations(terminalTheme("red-slate"))).toEqual({
      matchBackground: "#283349",
      matchOverviewRuler: "#F66C69",
      activeMatchBackground: "#493E3D",
      activeMatchBorder: "#F66C69",
      activeMatchColorOverviewRuler: "#F66C69",
    });
  });

  for (const id of THEMES) {
    it(`${id}: nur #RRGGBB und nur Farben, die das Thema schon hat`, () => {
      const theme = terminalTheme(id);
      const decorations = searchDecorations(theme);
      const own = new Set(Object.values(theme).map((value) => value?.toLowerCase()));

      for (const [name, value] of Object.entries(decorations)) {
        expect(value, name).toMatch(/^#[0-9A-F]{6}$/i);
        expect(own.has(value.toLowerCase()), `${name} ${value}`).toBe(true);
      }
    });
  }
});

describe("terminalTheme (Spec 5.5)", () => {
  it("wechselt je Thema nur Flaechen, Cursor, Auswahl und Daumen; ANSI und Vordergrund bleiben", async () => {
    const { terminalTheme, TERMINAL_ANSI } = await import("./terminal");
    const t = terminalTheme("turquoise");
    const s = terminalTheme("slate");
    expect(t.background).toBe("#0F1115");
    expect(t.cursor).toBe("#2DD4BF");
    expect(t.cursorAccent).toBe(t.background);
    expect(s.background).toBe("#0D111A");
    expect(s.cursor).toBe("#6FA8FF");
    expect(s.cursorAccent).toBe(s.background);
    expect(t.foreground).toBe("#C9D1D9");
    expect(s.foreground).toBe(t.foreground);
    for (const key of Object.keys(TERMINAL_ANSI) as (keyof typeof TERMINAL_ANSI)[]) {
      expect(s[key], key).toBe(t[key]);
    }
    expect(t.selectionBackground).toBe("#2B4A52");
    expect(s.selectionBackground).toBe("#2B3E5C");
    expect(t.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.34)");
  });

  it("setzt neue Kombinationen aus Grundton und Akzent zusammen (Farbwahl §5)", async () => {
    const { terminalTheme } = await import("./terminal");
    const red = terminalTheme("red-graphite");
    expect(red.cursor).toBe("#F66C69");
    expect(red.selectionBackground).toBe("#493E3D");
    expect(red.background).toBe("#0F1115");
    const violet = terminalTheme("violet-slate");
    expect(violet.cursor).toBe("#A193FC");
    expect(violet.background).toBe("#0D111A");
    expect(violet.selectionInactiveBackground).toBe("#283349");
  });
});

// Gesamt-Review, Important 2: `TERMINAL_SURFACES` in `terminal.ts` ist eine
// DRITTE Kopie der Palette -- xterm zeichnet seine Flaeche selbst und liest
// keine CSS-Variablen, also muessen die Werte doppelt gepflegt werden. Der
// Literaltest darueber pinnt nur Kopie gegen Kopie: eine Tokenaenderung in
// `styles.css` liesse beide Suiten gruen, waehrend die Kachel weiter in der
// alten Farbe rendert. Diese Zusicherung bindet die Kopie an die Quelle und
// faellt genau dann um, wenn die beiden auseinanderlaufen.
describe("terminalTheme haengt an den Token aus styles.css (Spec 5.5)", () => {
  // Gleicher Pfadausdruck wie oben im Overlay-Block (cwd-relativ, siehe
  // dessen Begruendung).
  // @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar beim Import oben
  const cssText: string = readFileSync(path.resolve(process.cwd(), "src/styles.css"), "utf-8");

  /** Rumpf einer Regel, die am Zeilenanfang beginnt -- dasselbe Verfahren
   * wie in `styles.test.ts`. */
  function ruleBody(selector: string): string {
    const start = cssText.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`Regel ${selector} fehlt`);
    return cssText.slice(start, cssText.indexOf("}", start));
  }

  function tokenBlock(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of ruleBody(selector).matchAll(/(--ab-[a-z0-9-]+):\s*([^;]+);/g)) {
      out[m[1]] = m[2].trim();
    }
    return out;
  }

  /** Loest EINE Stufe `var(--ab-…)` auf; mehr braucht die Palette nicht
   * (`--ab-scrollbar-hover: var(--ab-text-muted)` ist der einzige Fall). */
  function resolveOnce(tokens: Record<string, string>, value: string): string {
    return value.replace(/var\((--ab-[a-z0-9-]+)\)/g, (_, name: string) => {
      const token = tokens[name];
      if (token === undefined) throw new Error(`Token ${name} fehlt`);
      return token;
    });
  }

  /** `rgba(255, 255, 255, 0.34)` und `rgba(255,255,255,0.34)` sind dieselbe
   * Farbe -- verglichen wird ohne Leerraum. */
  const norm = (value: string): string => value.replace(/\s+/g, "");

  // Farbwahl-Spec §5: jede der 14 Varianten ist `:root` + Grundton + Akzent
  // (`--ab-scrollbar` und `--ab-scrollbar-hover` stehen nur in `:root`).
  const baseBlock = (id: BaseId) =>
    tokenBlock(id === "graphite" ? ':root, [data-base="graphite"]' : `[data-base="${id}"]`);
  const accentBlock = (id: AccentId) =>
    tokenBlock(id === "turquoise" ? ':root, [data-accent="turquoise"]' : `[data-accent="${id}"]`);

  for (const id of THEMES) {
    it(`${id}: Flaeche, Cursor, Auswahl und Daumen tragen die Tokenwerte`, async () => {
      const { terminalTheme } = await import("./terminal");
      const { accent, base } = themeParts(id);
      const tokens = { ...tokenBlock(":root"), ...baseBlock(base), ...accentBlock(accent) };
      const theme = terminalTheme(id);
      expect(norm(theme.background ?? "")).toBe(norm(tokens["--ab-term-bg"]));
      expect(norm(theme.cursor ?? "")).toBe(norm(tokens["--ab-accent"]));
      expect(norm(theme.cursorAccent ?? "")).toBe(norm(tokens["--ab-term-bg"]));
      expect(norm(theme.selectionBackground ?? "")).toBe(norm(tokens["--ab-term-selection"]));
      expect(norm(theme.selectionInactiveBackground ?? "")).toBe(norm(tokens["--ab-term-selection-inactive"]));
      expect(norm(theme.scrollbarSliderBackground ?? "")).toBe(norm(tokens["--ab-scrollbar"]));
      expect(norm(theme.scrollbarSliderHoverBackground ?? "")).toBe(
        norm(resolveOnce(tokens, tokens["--ab-scrollbar-hover"])),
      );
      expect(norm(theme.scrollbarSliderActiveBackground ?? "")).toBe(norm(tokens["--ab-text-secondary"]));
    });
  }
});
