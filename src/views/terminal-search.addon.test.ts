// Suchleiste gegen das ECHTE SearchAddon (UX-Spec §6.6): xterm.js und das Addon
// laufen hier unverspottet im Speicher, die Suchleiste sitzt davor. Die
// Attrappe in `terminal-search.test.ts` prueft, was die Leiste dem Addon sagt;
// diese Datei prueft, dass das Addon darauf so antwortet, wie die Leiste es
// anzeigt: Zaehler, Umlauf, "Aa" ohne Sprung, Treffer im Verlauf, Ruhe nach dem
// Schliessen.
//
// jsdom kennt weder `matchMedia` noch eine Zeichenflaeche; xterm fragt beides
// beim Oeffnen. Beide Ersatzstuecke stehen VOR den Importen (`vi.hoisted`), denn
// schon das Laden von xterm greift auf die Zeichenflaeche zu. Bild und Masse
// gibt es nicht -- die Spalten und Zeilen sind fest gesetzt, gerendert wird
// nichts. Das reicht fuer Puffer, Auswahl und Treffer, auf die es hier ankommt.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Die Ersatzstuecke gelten fuer alles, was diese Datei laedt. Sie sind nur
// deshalb harmlos, weil vitest jede Testdatei in einer eigenen Umgebung laufen
// laesst (`isolate`, die Voreinstellung); ohne Isolation griffen sie auf andere
// Dateien durch.
vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import {
  SEARCH_DEBOUNCE_MS,
  createTerminalSearch,
  type SearchDecorations,
  type TerminalSearchHandle,
  type TerminalSearchTexts,
} from "./terminal-search";

const TEXTS: TerminalSearchTexts = {
  placeholder: "Find",
  count: (current, total) => `${current}/${total}`,
  none: "No results",
  prev: "Previous match",
  next: "Next match",
  matchCase: "Match case",
  close: "Close",
};

/** Dieselbe Form wie die Farben aus `terminal.ts`: `#RRGGBB`. */
const DECORATIONS: SearchDecorations = {
  matchBackground: "#2A323D",
  matchOverviewRuler: "#2DD4BF",
  activeMatchBackground: "#2B4A52",
  activeMatchBorder: "#2DD4BF",
  activeMatchColorOverviewRuler: "#2DD4BF",
};

interface Rig {
  term: Terminal;
  addon: SearchAddon;
  host: HTMLElement;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  handle: TerminalSearchHandle;
}

const rigs: Rig[] = [];

/** Ein Terminal mit Inhalt und eine Suchleiste davor. Der Inhalt geht mit echten
 * Zeitgebern in den Puffer (xterm schreibt ueber `setTimeout`); erst danach
 * kommen die falschen, fuer die Frist der Suchleiste. */
async function rig(content: string, over: { rows?: number } = {}): Promise<Rig> {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: over.rows ?? 10, scrollback: 100 });
  const addon = new SearchAddon();
  term.loadAddon(addon);
  term.open(mount);
  await new Promise<void>((resolve) => term.write(content, resolve));
  vi.useFakeTimers();

  const host = document.createElement("div");
  document.body.appendChild(host);
  const onClose = vi.fn<() => void>();
  const handle = createTerminalSearch({
    host,
    search: addon,
    texts: TEXTS,
    decorations: () => DECORATIONS,
    onClose,
  });
  handle.openOrFocus();
  const made = { term, addon, host, onClose, handle };
  rigs.push(made);
  return made;
}

afterEach(() => {
  for (const { term, handle } of rigs.splice(0)) {
    handle.dispose();
    term.dispose();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});

const count = (host: HTMLElement) => host.querySelector(".terminal-search-count")?.textContent;

function type(host: HTMLElement, text: string): void {
  const input = host.querySelector<HTMLInputElement>(".terminal-search-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
}

function enter(host: HTMLElement, shift = false): void {
  host
    .querySelector(".terminal-search-input")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: shift, bubbles: true, cancelable: true }));
}

const click = (host: HTMLElement, action: string) =>
  host.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!.click();

/** Drei Treffer fuer "foo", einer davon gross geschrieben. */
const SAMPLE = "foo bar\r\nFoo baz foo\r\nnothing\r\n";

beforeEach(() => {
  // Kein Rest eines frueheren Tests: die Zeitgeber stehen vor `rig()` wieder
  // auf echt.
  vi.useRealTimers();
});

describe("Suchleiste mit dem echten SearchAddon", () => {
  it("zaehlt die Treffer 1-basiert und springt vorwaerts, rueckwaerts und im Kreis", async () => {
    const { host, term } = await rig(SAMPLE);

    type(host, "foo");
    expect(count(host)).toBe("1/3");
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 0 }, end: { x: 3, y: 0 } });

    enter(host);
    expect(count(host)).toBe("2/3");
    enter(host);
    expect(count(host)).toBe("3/3");
    // Nach dem letzten Treffer geht es vorn weiter.
    enter(host);
    expect(count(host)).toBe("1/3");
    // Und rueckwaerts hinter den ersten.
    enter(host, true);
    expect(count(host)).toBe("3/3");
    click(host, "prev");
    expect(count(host)).toBe("2/3");
    click(host, "next");
    expect(count(host)).toBe("3/3");
  });

  it("zeigt No results, wenn nichts passt, und findet wieder, wenn der Begriff passt", async () => {
    const { host } = await rig(SAMPLE);

    type(host, "zzz");
    expect(count(host)).toBe("No results");

    type(host, "baz");
    expect(count(host)).toBe("1/1");
  });

  it("bleibt beim Weitertippen am Treffer, solange er noch passt", async () => {
    const { host, term } = await rig(SAMPLE);
    type(host, "foo");
    enter(host); // zweiter Treffer: "Foo" in Zeile 1

    type(host, "foo b");

    // "foo bar" und "Foo baz" passen beide. Aktiv bleibt der bisherige Treffer
    // (der zweite), die Suche springt nicht an den Anfang zurueck.
    expect(count(host)).toBe("2/2");
    expect(term.getSelectionPosition()?.start).toEqual({ x: 0, y: 1 });
    expect(term.getSelection()).toBe("Foo b");
  });

  it("schaltet \"Aa\" um, ohne den Treffer zu wechseln, und zaehlt neu", async () => {
    const { host, term } = await rig(SAMPLE);
    type(host, "foo");
    enter(host);
    enter(host);
    expect(count(host)).toBe("3/3");
    const before = term.getSelectionPosition();
    expect(before?.start).toEqual({ x: 8, y: 1 });

    click(host, "matchCase");

    // "Foo" faellt weg; der Treffer in Zeile 1 bleibt der aktive.
    expect(count(host)).toBe("2/2");
    expect(term.getSelectionPosition()).toEqual(before);

    click(host, "matchCase");
    expect(count(host)).toBe("3/3");
    expect(term.getSelectionPosition()).toEqual(before);
  });

  it("zeigt bei \"Aa\" ohne Treffer No results", async () => {
    const { host } = await rig(SAMPLE);
    type(host, "FOO");
    expect(count(host)).toBe("1/3");

    click(host, "matchCase");

    expect(count(host)).toBe("No results");
  });

  it("durchsucht auch den Verlauf ausserhalb des sichtbaren Bereichs", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`);
    const { host, term } = await rig(lines.join("\r\n"), { rows: 10 });
    // Vorbedingung: row-05 ist laengst aus dem Bild gescrollt.
    expect(term.buffer.active.baseY).toBeGreaterThan(5);

    type(host, "row-05");

    expect(count(host)).toBe("1/1");
    expect(term.getSelection()).toBe("row-05");
  });

  it("folgt neuer Ausgabe, solange die Leiste offen ist", async () => {
    const { host, term } = await rig(SAMPLE);
    type(host, "foo");
    expect(count(host)).toBe("1/3");

    term.write("one more foo\r\n");
    // Die Schreibwarteschlange von xterm, danach die 200 ms des Addons.
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(250);

    expect(count(host)).toMatch(/^\d+\/4$/);
  });

  it("laesst nach dem Schliessen die Markierung stehen und hoert auf, neu zu suchen", async () => {
    const { host, term, addon, handle, onClose } = await rig(SAMPLE);
    type(host, "foo");
    const selected = term.getSelection();
    expect(selected).toBe("foo");

    handle.close();
    const afterClose = vi.fn();
    addon.onDidChangeResults(afterClose);
    term.write("another foo\r\n");
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(1000);

    expect(onClose).toHaveBeenCalledOnce();
    expect(host.querySelector(".terminal-search-overlay")).toBeNull();
    // Die Markierung des letzten Treffers bleibt (wie bei jedem Editor); es
    // kommt keine Meldung mehr, das Addon sucht nicht von selbst weiter.
    expect(term.getSelection()).toBe(selected);
    expect(afterClose).not.toHaveBeenCalled();
  });
});
