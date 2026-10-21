// Suchleiste im Terminal (UX-Spec §6.6): Aufbau, Suche beim Tippen (150 ms
// entprellt, mit `decorations`), Zaehler, Tasten und Schliessen. Echte
// DOM-Ereignisse unter jsdom, das SearchAddon ist durch eine Attrappe ersetzt:
// geprueft wird, WAS die Leiste dem Addon sagt und was sie aus dessen
// `onDidChangeResults` anzeigt, nicht die Suche selbst.

import css from "../styles.css?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISearchOptions, ISearchResultChangeEvent } from "@xterm/addon-search";
import {
  EMPTY_SEARCH_TEXTS,
  SEARCH_DEBOUNCE_MS,
  createTerminalSearch,
  type SearchDecorations,
  type TerminalSearchEngine,
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

const DECORATIONS: SearchDecorations = {
  matchBackground: "#2A323D",
  matchOverviewRuler: "#2DD4BF",
  activeMatchBackground: "#2B4A52",
  activeMatchBorder: "#2DD4BF",
  activeMatchColorOverviewRuler: "#2DD4BF",
};

/** Das Addon, soweit die Leiste es braucht. `fire` loest `onDidChangeResults`
 * aus wie das echte Addon nach einer Suche mit `decorations`. */
function fakeSearch() {
  const listeners = new Set<(event: ISearchResultChangeEvent) => void>();
  const onDidChangeResults: TerminalSearchEngine["onDidChangeResults"] = (listener) => {
    listeners.add(listener);
    return { dispose: () => void listeners.delete(listener) };
  };
  return {
    findNext: vi.fn<(term: string, options?: ISearchOptions) => boolean>(() => true),
    findPrevious: vi.fn<(term: string, options?: ISearchOptions) => boolean>(() => true),
    clearDecorations: vi.fn<() => void>(),
    onDidChangeResults,
    fire(event: ISearchResultChangeEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

const handles: TerminalSearchHandle[] = [];

function setup(over: { texts?: TerminalSearchTexts } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const search = fakeSearch();
  const onClose = vi.fn<() => void>();
  const decorations = vi.fn<() => SearchDecorations>(() => DECORATIONS);
  const handle = createTerminalSearch({
    host,
    search,
    texts: over.texts ?? TEXTS,
    decorations,
    onClose,
  });
  handles.push(handle);
  return { host, search, onClose, decorations, handle };
}

function overlay(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".terminal-search-overlay");
}

function control<T extends HTMLElement>(host: HTMLElement, selector: string): T {
  const found = host.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} fehlt`);
  return found;
}

const field = (host: HTMLElement) => control<HTMLInputElement>(host, ".terminal-search-input");
const counter = (host: HTMLElement) => control<HTMLElement>(host, ".terminal-search-count");
const button = (host: HTMLElement, action: "prev" | "next" | "matchCase" | "close") =>
  control<HTMLButtonElement>(host, `button[data-action="${action}"]`);

/** Tippt in das Feld: Wert setzen und `input` feuern, wie der Browser. */
function type(host: HTMLElement, text: string): void {
  const input = field(host);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(target: Element, init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  handles.splice(0).forEach((handle) => handle.dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("createTerminalSearch: Aufbau", () => {
  it("haengt nichts ein, solange die Leiste nicht geoeffnet ist", () => {
    const { host, handle } = setup();

    expect(overlay(host)).toBeNull();
    expect(handle.isOpen()).toBe(false);
  });

  it("baut das Overlay mit Feld, Zaehler und vier Knoepfen in dieser Reihenfolge", () => {
    const { host, handle } = setup();

    handle.openOrFocus();

    const root = overlay(host);
    expect(root?.tagName).toBe("DIV");
    expect(root?.parentElement).toBe(host);
    expect(handle.isOpen()).toBe(true);
    expect(
      Array.from(root?.children ?? []).map((child) =>
        child instanceof HTMLButtonElement ? child.dataset.action : child.className,
      ),
    ).toEqual(["terminal-search-input", "terminal-search-count", "prev", "next", "matchCase", "close"]);
  });

  it("gibt dem Feld den Platzhalter und einen eigenen Namen, ohne Browserhilfen", () => {
    const { host, handle } = setup();

    handle.openOrFocus();

    const input = field(host);
    expect(input.type).toBe("text");
    expect(input.placeholder).toBe("Find");
    // Ein Platzhalter allein ist kein verlaesslicher Name.
    expect(input.getAttribute("aria-label")).toBe("Find");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.spellcheck).toBe(false);
  });

  it("macht den Zaehler zur Live-Region und laesst ihn leer, bis es etwas zu sagen gibt", () => {
    const { host, handle } = setup();

    handle.openOrFocus();

    expect(counter(host).getAttribute("aria-live")).toBe("polite");
    expect(counter(host).textContent).toBe("");
  });

  it("beschriftet jeden Knopf mit Namen und Tooltip aus den Texten und gibt ihm sein Icon", () => {
    const { host, handle } = setup();

    handle.openOrFocus();

    const expected = {
      prev: ["Previous match", "chevron-up"],
      next: ["Next match", "chevron-down"],
      matchCase: ["Match case", "case-sensitive"],
      close: ["Close", "x"],
    } as const;
    for (const [action, [label, iconName]] of Object.entries(expected)) {
      const btn = button(host, action as keyof typeof expected);
      expect(btn.type, action).toBe("button");
      expect(btn.getAttribute("aria-label"), action).toBe(label);
      expect(btn.title, action).toBe(label);
      expect(btn.querySelector(`[data-icon="${iconName}"]`), action).not.toBeNull();
      expect(btn.querySelector("svg"), action).not.toBeNull();
    }
  });

  it("zeigt \"Aa\" als Schalter, der anfangs nicht gedrueckt ist", () => {
    const { host, handle } = setup();

    handle.openOrFocus();

    expect(button(host, "matchCase").getAttribute("aria-pressed")).toBe("false");
    for (const action of ["prev", "next", "close"] as const) {
      expect(button(host, action).hasAttribute("aria-pressed"), action).toBe(false);
    }
  });

  it("legt den Fokus in das Feld", () => {
    const { host, handle } = setup();

    handle.openOrFocus();

    expect(document.activeElement).toBe(field(host));
  });

  it("oeffnet ohne Texte mit leeren Beschriftungen statt zu scheitern", () => {
    const { host, handle } = setup({ texts: EMPTY_SEARCH_TEXTS });

    handle.openOrFocus();

    expect(field(host).placeholder).toBe("");
    expect(button(host, "close").title).toBe("");
  });
});

describe("createTerminalSearch: Oeffnen, Umschalten, Entsorgen", () => {
  it("openOrFocus() bei offener Leiste holt nur den Fokus zurueck, es schliesst nicht", () => {
    const { host, handle, onClose } = setup();
    handle.openOrFocus();
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    handle.openOrFocus();

    expect(host.querySelectorAll(".terminal-search-overlay")).toHaveLength(1);
    expect(document.activeElement).toBe(field(host));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("toggle() oeffnet eine zu und schliesst eine offene Leiste", () => {
    const { host, handle, onClose } = setup();

    handle.toggle();
    expect(overlay(host)).not.toBeNull();

    handle.toggle();
    expect(overlay(host)).toBeNull();
    expect(handle.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("oeffnet nach dem Schliessen frisch: leeres Feld, \"Aa\" aus, leerer Zaehler", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();
    type(host, "abc");
    button(host, "matchCase").click();
    search.fire({ resultIndex: 0, resultCount: 3 });
    handle.close();

    handle.openOrFocus();

    expect(field(host).value).toBe("");
    expect(button(host, "matchCase").getAttribute("aria-pressed")).toBe("false");
    expect(counter(host).textContent).toBe("");
  });

  it("close() bei geschlossener Leiste tut nichts", () => {
    const { handle, search, onClose } = setup();

    handle.close();

    expect(search.clearDecorations).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dispose() raeumt auf, ohne Rueckruf und ohne das Addon anzufassen", () => {
    const { host, handle, search, onClose } = setup();
    handle.openOrFocus();
    type(host, "abc");

    handle.dispose();

    expect(overlay(host)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(search.clearDecorations).not.toHaveBeenCalled();
    expect(search.listenerCount()).toBe(0);
    // Der noch ausstehende Suchlauf entfaellt.
    vi.advanceTimersByTime(1000);
    expect(search.findNext).not.toHaveBeenCalled();
  });

  it("oeffnet nach dem Entsorgen nicht mehr", () => {
    const { host, handle } = setup();
    handle.dispose();

    handle.openOrFocus();
    handle.toggle();

    expect(overlay(host)).toBeNull();
    expect(handle.isOpen()).toBe(false);
  });
});

describe("createTerminalSearch: Suche beim Tippen", () => {
  it("sucht erst 150 ms nach der letzten Eingabe, mit decorations und ohne Groesse/Kleinschreibung", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    type(host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(search.findNext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(SEARCH_DEBOUNCE_MS).toBe(150);
    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("abc", {
      caseSensitive: false,
      decorations: DECORATIONS,
    });
    expect(search.findPrevious).not.toHaveBeenCalled();
  });

  it("startet die Frist bei jeder weiteren Eingabe neu und sucht nur einmal, mit dem letzten Stand", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    type(host, "a");
    vi.advanceTimersByTime(100);
    type(host, "ab");
    vi.advanceTimersByTime(100);
    expect(search.findNext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);

    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("ab", expect.anything());
  });

  it("liest die Farben bei jeder Suche neu (ein Themenwechsel im Betrieb gilt sofort)", () => {
    const { host, handle, search, decorations } = setup();
    const other: SearchDecorations = { ...DECORATIONS, activeMatchBorder: "#FA9947" };
    decorations.mockReturnValueOnce(DECORATIONS).mockReturnValueOnce(other);
    handle.openOrFocus();

    type(host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    type(host, "abcd");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);

    expect(search.findNext.mock.calls.map(([, options]) => options?.decorations)).toEqual([DECORATIONS, other]);
  });

  it("raeumt bei leerem Feld sofort auf, ohne zu suchen und ohne \"No results\"", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();
    type(host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    search.fire({ resultIndex: 0, resultCount: 3 });
    search.findNext.mockClear();

    type(host, "");

    // Sofort, nicht erst nach der Frist: es gibt nichts mehr zu finden.
    expect(search.clearDecorations).toHaveBeenCalledOnce();
    expect(counter(host).textContent).toBe("");
    vi.advanceTimersByTime(1000);
    expect(search.findNext).not.toHaveBeenCalled();
  });

  it("verwirft eine ausstehende Suche, wenn das Feld vor Ablauf der Frist leer wird", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    type(host, "abc");
    vi.advanceTimersByTime(50);
    type(host, "");
    vi.advanceTimersByTime(1000);

    expect(search.findNext).not.toHaveBeenCalled();
  });
});

describe("createTerminalSearch: Zaehler", () => {
  function opened() {
    const ctx = setup();
    ctx.handle.openOrFocus();
    type(ctx.host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    return ctx;
  }

  it("zeigt den 1-basierten Treffer: resultIndex 2 von 17 ist \"3/17\"", () => {
    const { host, search } = opened();

    search.fire({ resultIndex: 2, resultCount: 17 });

    expect(counter(host).textContent).toBe("3/17");
  });

  it("zeigt ohne Treffer \"No results\"", () => {
    const { host, search } = opened();

    search.fire({ resultIndex: -1, resultCount: 0 });

    expect(counter(host).textContent).toBe("No results");
  });

  it("zeigt bei unbekannter Lage (ueber der Hervorhebungsgrenze) nur die Anzahl", () => {
    const { host, search } = opened();

    search.fire({ resultIndex: -1, resultCount: 1000 });

    expect(counter(host).textContent).toBe("1000");
  });

  it("folgt jeder weiteren Meldung des Addons", () => {
    const { host, search } = opened();

    search.fire({ resultIndex: 0, resultCount: 17 });
    search.fire({ resultIndex: 1, resultCount: 17 });
    expect(counter(host).textContent).toBe("2/17");
    search.fire({ resultIndex: -1, resultCount: 0 });
    expect(counter(host).textContent).toBe("No results");
  });

  it("zeigt bei leerem Feld nichts, auch wenn das Addon eine Meldung schickt", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    search.fire({ resultIndex: -1, resultCount: 0 });

    expect(counter(host).textContent).toBe("");
  });

  it("hoert nach dem Schliessen nicht mehr zu", () => {
    const { handle, search } = opened();
    expect(search.listenerCount()).toBe(1);

    handle.close();

    expect(search.listenerCount()).toBe(0);
    expect(() => search.fire({ resultIndex: 0, resultCount: 1 })).not.toThrow();
  });
});

describe("createTerminalSearch: Enter, Umschalt+Enter und die Pfeilknoepfe", () => {
  function opened() {
    const ctx = setup();
    ctx.handle.openOrFocus();
    type(ctx.host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    ctx.search.findNext.mockClear();
    return ctx;
  }

  const OPTIONS = { caseSensitive: false, decorations: DECORATIONS };

  it("Enter springt zum naechsten Treffer, sofort und ohne den Browser reagieren zu lassen", () => {
    const { host, search } = opened();

    const event = press(field(host), { key: "Enter" });

    expect(event.defaultPrevented).toBe(true);
    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("abc", OPTIONS);
    expect(search.findPrevious).not.toHaveBeenCalled();
  });

  it("Umschalt+Enter springt zum vorigen Treffer", () => {
    const { host, search } = opened();

    press(field(host), { key: "Enter", shiftKey: true });

    expect(search.findPrevious).toHaveBeenCalledExactlyOnceWith("abc", OPTIONS);
    expect(search.findNext).not.toHaveBeenCalled();
  });

  it("der Knopf nach unten sucht vorwaerts, der nach oben rueckwaerts", () => {
    const { host, search } = opened();

    button(host, "next").click();
    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("abc", OPTIONS);

    button(host, "prev").click();
    expect(search.findPrevious).toHaveBeenCalledExactlyOnceWith("abc", OPTIONS);
  });

  it("macht bei leerem Feld nichts: weder Enter noch die Knoepfe suchen", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    press(field(host), { key: "Enter" });
    press(field(host), { key: "Enter", shiftKey: true });
    button(host, "next").click();
    button(host, "prev").click();

    expect(search.findNext).not.toHaveBeenCalled();
    expect(search.findPrevious).not.toHaveBeenCalled();
  });

  it("Enter vor Ablauf der Frist sucht sofort und genau einmal (die Frist wird verworfen)", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    type(host, "abc");
    vi.advanceTimersByTime(50);
    press(field(host), { key: "Enter" });
    vi.advanceTimersByTime(1000);

    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("abc", expect.anything());
  });

  it("Enter waehrend einer IME-Eingabe bestaetigt nur die Eingabe", () => {
    const { host, search } = opened();

    const event = press(field(host), { key: "Enter", isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(search.findNext).not.toHaveBeenCalled();
  });

  it("Enter auf einem fokussierten Knopf bleibt dem Knopf: die Leiste faengt ihn nicht ab", () => {
    const { host, search } = opened();

    const event = press(button(host, "prev"), { key: "Enter" });

    expect(event.defaultPrevented).toBe(false);
    expect(search.findNext).not.toHaveBeenCalled();
    expect(search.findPrevious).not.toHaveBeenCalled();
  });

});

describe("createTerminalSearch: der Fokus bleibt im Feld", () => {
  /** Ein Mausdruck samt dem, was der Browser danach tut, wenn ihn niemand
   * anhaelt: der Fokus geht an das naechste fokussierbare Element ueber dem Ziel,
   * sonst weg vom Feld auf <body>. jsdom macht das nicht von selbst -- ohne diese
   * Nachbildung koennte keine der Zusicherungen unten fehlschlagen. */
  function mouseDown(target: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init });
    target.dispatchEvent(event);
    if (!event.defaultPrevented) {
      const focusable = target.closest<HTMLElement>("button, input, [tabindex]");
      if (focusable) focusable.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    }
    return event;
  }

  function opened() {
    const ctx = setup();
    ctx.handle.openOrFocus();
    return ctx;
  }

  const TARGETS: Array<[string, (host: HTMLElement) => Element]> = [
    ["den Zaehler", counter],
    ["den Rand der Leiste", (host) => overlay(host)!],
    ["den Knopf nach oben", (host) => button(host, "prev")],
    ["den Knopf nach unten", (host) => button(host, "next")],
    ["\"Aa\"", (host) => button(host, "matchCase")],
    ["den Knopf ✕", (host) => button(host, "close")],
  ];

  it.each(TARGETS)("ein Druck auf %s nimmt dem Feld den Fokus nicht", (_name, targetOf) => {
    const { host } = opened();
    expect(document.activeElement).toBe(field(host));

    const event = mouseDown(targetOf(host));

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field(host));
  });

  it("im Feld selbst bleibt der Druck, was er ist: Cursor setzen und markieren", () => {
    const { host } = opened();

    const event = mouseDown(field(host));

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field(host));
  });

  it("die mittlere und die rechte Taste bleiben beim Browser (natives Bearbeitungsmenue)", () => {
    const { host } = opened();

    for (const button of [1, 2]) {
      const event = mouseDown(counter(host), { button });
      expect(event.defaultPrevented, `Taste ${button}`).toBe(false);
    }
  });

  // Der Schaden, um den es geht: lag der Fokus nach dem Druck auf <body>, ging das
  // Escape am Dokument vorbei an der Leiste und stellte dort eine maximierte
  // Kachel wieder her, waehrend die Leiste offen blieb.
  it("Esc nach einem Druck auf den Zaehler schliesst die Leiste, statt am Dokument anzukommen", () => {
    const { host, onClose } = opened();
    const atDocument = vi.fn();
    document.addEventListener("keydown", atDocument);
    try {
      mouseDown(counter(host));

      press(document.activeElement ?? document.body, { key: "Escape" });

      expect(overlay(host)).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
      expect(atDocument).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", atDocument);
    }
  });
});

describe("createTerminalSearch: \"Aa\"", () => {
  it("schaltet aria-pressed um und sucht sofort neu, mit caseSensitive", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();
    type(host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    search.findNext.mockClear();
    search.clearDecorations.mockClear();

    button(host, "matchCase").click();

    expect(button(host, "matchCase").getAttribute("aria-pressed")).toBe("true");
    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("abc", {
      caseSensitive: true,
      decorations: DECORATIONS,
    });

    search.findNext.mockClear();
    button(host, "matchCase").click();

    expect(button(host, "matchCase").getAttribute("aria-pressed")).toBe("false");
    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("abc", {
      caseSensitive: false,
      decorations: DECORATIONS,
    });
  });

  // Dieselbe Eingabe mit anderen Optionen faengt das Addon als "weiter zum
  // naechsten" auf, solange es sich den Suchbegriff merkt. Wer die Option
  // umschaltet, will am aktuellen Treffer bleiben.
  it("vergisst vor dem erneuten Suchen den gemerkten Begriff, damit der Treffer stehen bleibt", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();
    type(host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    const order: string[] = [];
    search.clearDecorations.mockImplementation(() => void order.push("clear"));
    search.findNext.mockImplementation(() => {
      order.push("find");
      return true;
    });

    button(host, "matchCase").click();

    expect(order).toEqual(["clear", "find"]);
  });

  it("schaltet bei leerem Feld nur um und sucht nicht", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    button(host, "matchCase").click();

    expect(button(host, "matchCase").getAttribute("aria-pressed")).toBe("true");
    expect(search.findNext).not.toHaveBeenCalled();
  });

  it("gilt auch fuer die naechsten Eingaben, Enter und die Pfeilknoepfe", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();
    button(host, "matchCase").click();

    type(host, "abc");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    press(field(host), { key: "Enter", shiftKey: true });
    button(host, "next").click();

    expect(search.findNext.mock.calls.map(([, options]) => options?.caseSensitive)).toEqual([true, true]);
    expect(search.findPrevious.mock.calls.map(([, options]) => options?.caseSensitive)).toEqual([true]);
  });

  it("verwirft eine ausstehende Suche: das Umschalten innerhalb der Frist sucht genau einmal", () => {
    const { host, handle, search } = setup();
    handle.openOrFocus();

    type(host, "abc");
    vi.advanceTimersByTime(50);
    button(host, "matchCase").click();
    vi.advanceTimersByTime(1000);

    expect(search.findNext).toHaveBeenCalledExactlyOnceWith("abc", expect.objectContaining({ caseSensitive: true }));
  });
});

describe("createTerminalSearch: Schliessen", () => {
  function opened() {
    const ctx = setup();
    ctx.handle.openOrFocus();
    return ctx;
  }

  it("der Knopf ✕ schliesst, raeumt die Hervorhebung weg und meldet es", () => {
    const { host, handle, search, onClose } = opened();

    button(host, "close").click();

    expect(overlay(host)).toBeNull();
    expect(handle.isOpen()).toBe(false);
    expect(search.clearDecorations).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Esc im Feld schliesst und raeumt weg, haelt das Ereignis an und laesst es nicht zum Dokument", () => {
    const { host, search, onClose } = opened();
    const atDocument = vi.fn();
    document.addEventListener("keydown", atDocument);
    try {
      const event = press(field(host), { key: "Escape" });

      expect(overlay(host)).toBeNull();
      expect(search.clearDecorations).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      // Eine maximierte Kachel bleibt maximiert (UX-Spec §6.6, §8.2): beides,
      // damit weder ein Lauscher mit `defaultPrevented`-Pruefung noch einer
      // ohne sie das Escape noch sieht.
      expect(event.defaultPrevented).toBe(true);
      expect(atDocument).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", atDocument);
    }
  });

  it("Esc schliesst auch von einem Knopf der Leiste aus", () => {
    const { host, onClose } = opened();
    const atDocument = vi.fn();
    document.addEventListener("keydown", atDocument);
    try {
      const event = press(button(host, "next"), { key: "Escape" });

      expect(overlay(host)).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
      expect(atDocument).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", atDocument);
    }
  });

  it("Strg+Umschalt+F im Feld schliesst ebenfalls", () => {
    const { host, search, onClose } = opened();

    const event = press(field(host), { key: "F", ctrlKey: true, shiftKey: true });

    expect(overlay(host)).toBeNull();
    expect(search.clearDecorations).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("andere Akkorde und Tasten lassen die Leiste offen und das Zeichen beim Feld", () => {
    const { host, onClose } = opened();

    const events = [
      press(field(host), { key: "G", ctrlKey: true, shiftKey: true }),
      press(field(host), { key: "f", ctrlKey: true }),
      press(field(host), { key: "a" }),
      press(field(host), { key: "Tab" }),
      // AltGr+Q ergibt auf deutscher Tastatur @. Windows meldet AltGr als Strg+Alt,
      // Chromium je nach Stand als AltGraph allein: in jeder Fassung Eingabe, nie
      // ein Akkord der Leiste -- und nie angehalten, sonst fehlte das Zeichen im Feld.
      press(field(host), { key: "@", ctrlKey: true, altKey: true, modifierAltGraph: true }),
      press(field(host), { key: "@", ctrlKey: true, altKey: true }),
      press(field(host), { key: "@", modifierAltGraph: true }),
      // Auch mit Umschalt darauf: das ist kein Strg+Umschalt+F.
      press(field(host), { key: "F", ctrlKey: true, shiftKey: true, altKey: true, modifierAltGraph: true }),
    ];

    expect(overlay(host)).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    for (const event of events) expect(event.defaultPrevented, `${event.key} ${event.ctrlKey}`).toBe(false);
  });

  it("Esc waehrend einer IME-Eingabe bricht nur die Eingabe ab: die Leiste bleibt offen", () => {
    const { host, onClose } = opened();

    const event = press(field(host), { key: "Escape", isComposing: true });

    expect(overlay(host)).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("verwirft eine ausstehende Suche: nach dem Schliessen entsteht keine Hervorhebung mehr", () => {
    const { host, handle, search } = opened();

    type(host, "abc");
    vi.advanceTimersByTime(50);
    handle.close();
    vi.advanceTimersByTime(1000);

    expect(search.findNext).not.toHaveBeenCalled();
    // Genau das eine Aufraeumen beim Schliessen, kein spaeteres.
    expect(search.clearDecorations).toHaveBeenCalledOnce();
  });
});

describe("Suchleiste gegen das ausgelieferte Stylesheet", () => {
  /** Alle Regeln, deren Selektor die Leiste nennt, samt Rumpf. Ohne
   * Kommentare: sie nennen Selektoren und Farben woertlich. */
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...code.matchAll(/\n([^{}\n][^{}]*terminal-search[^{}]*)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));

  it("hat Regeln fuer Huelle, Feld, Zaehler, Knoepfe und den gedrueckten Schalter", () => {
    const selectors = rules.map((rule) => rule.selector);

    expect(selectors).toContain(".terminal-search-overlay");
    expect(selectors.some((s) => s.includes(".terminal-search-input"))).toBe(true);
    expect(selectors).toContain(".terminal-search-count");
    expect(selectors).toContain(".terminal-search-btn");
    expect(selectors).toContain('.terminal-search-btn[aria-pressed="true"]');
  });

  it("benutzt Farben nur ueber Token, nie als Literal", () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.body, rule.selector).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    }
  });

  // Der Zaehler reserviert seine Breite, damit die Leiste nicht springt, wenn der
  // erste Treffer eintrifft. Gemessen (WPF mit idealen Massen, 11 px, auf dem
  // Entwicklungsrechner): "No results" 51,1 px in Segoe UI Variable Small, 49,2 px
  // in Segoe UI; "999/999" 40,9 px. Die Zusicherung rechnet das Polster ab, denn
  // `min-width` gilt mit `box-sizing: border-box` samt Polster, und laesst 15 %
  // Luft fuer Ersatzschriften und Rundung.
  it("laesst dem Zaehler neben dem Polster Platz fuer No results", () => {
    const NO_RESULTS_PX = 51.1;
    const rule = rules.find((r) => r.selector === ".terminal-search-count");
    expect(rule?.body).toMatch(/box-sizing:\s*border-box/);

    const minWidth = Number(/min-width:\s*(\d+)px/.exec(rule?.body ?? "")?.[1]);
    const paddingToken = /padding:\s*0 var\((--ab-space-\d+)\)/.exec(rule?.body ?? "")?.[1];
    const padding = Number(new RegExp(`${paddingToken}:\\s*(\\d+)px`).exec(code)?.[1]);

    expect(minWidth, "min-width in px").toBeGreaterThan(0);
    expect(padding, `Polster ${paddingToken}`).toBeGreaterThan(0);
    expect(minWidth - 2 * padding).toBeGreaterThanOrEqual(NO_RESULTS_PX * 1.15);
  });

  it("setzt die Huelle auf position: absolute oben rechts in der Kachel", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    try {
      const { host, handle } = setup();
      handle.openOrFocus();

      expect(getComputedStyle(overlay(host)!).position).toBe("absolute");
    } finally {
      style.remove();
    }
  });
});
