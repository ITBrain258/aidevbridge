// Suchleiste im Terminal (UX-Spec §6.6): Feld, Zaehler, vorheriger und
// naechster Treffer, "Aa" und Schliessen, oben rechts in der Kachel. Die
// Leiste sucht beim Tippen (150 ms entprellt) und zeigt, was das SearchAddon
// ueber `onDidChangeResults` meldet; sie kennt weder `Terminal` noch `en.json`.
// `terminal.ts` reicht das Addon, die Farben der Treffer und alle Texte herein
// und legt beim Schliessen den Fokus zurueck ins Terminal.
//
// Das Wurzelelement traegt die Klasse `terminal-search-overlay`. `terminal.ts`
// erkennt daran, dass ein Druck oder Rechtsklick der Leiste gehoert (natives
// Bearbeitungsmenue im Feld, kein Terminalmenue, kein Kopieren beim Loslassen);
// die Klasse zu aendern heisst, diese Pruefung mitzuziehen.

import type { ISearchOptions, ISearchResultChangeEvent, SearchAddon } from "@xterm/addon-search";
import type { IDisposable } from "@xterm/xterm";
import { icon, type IconName } from "../icons";
import { isAppChord, matchAction } from "../keymap";

/** So lange ruht die Eingabe, bevor gesucht wird. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Farben der Treffer. Das Addon verlangt `#RRGGBB` und feuert
 * `onDidChangeResults` nur, wenn eine Suche `decorations` mitbringt -- ohne sie
 * stuende der Zaehler still. */
export type SearchDecorations = NonNullable<ISearchOptions["decorations"]>;

/** Der Teil des SearchAddon, den die Leiste braucht. */
export type TerminalSearchEngine = Pick<
  SearchAddon,
  "findNext" | "findPrevious" | "clearDecorations" | "onDidChangeResults"
>;

/** Alle Texte der Leiste. Sie kommen vom Aufrufer, weil dieses Modul kein i18n
 * kennt. */
export interface TerminalSearchTexts {
  placeholder: string;
  /** "3/17": Treffer `current` von `total`, `current` zaehlt ab 1. */
  count(current: number, total: number): string;
  /** Steht im Zaehler, wenn es keinen Treffer gibt. */
  none: string;
  prev: string;
  next: string;
  matchCase: string;
  close: string;
}

/** Fuer Aufrufer ohne Texte (Tests): die Leiste geht auf, die Beschriftungen
 * bleiben leer. Die Anwendung gibt immer Texte mit. */
export const EMPTY_SEARCH_TEXTS: TerminalSearchTexts = {
  placeholder: "",
  count: (current, total) => `${current}/${total}`,
  none: "",
  prev: "",
  next: "",
  matchCase: "",
  close: "",
};

export interface TerminalSearchOptions {
  /** Hier haengt die Leiste ihr Wurzelelement ein: der Kachelcontainer, in dem
   * sie per `position: absolute` oben rechts steht. */
  host: HTMLElement;
  search: TerminalSearchEngine;
  texts: TerminalSearchTexts;
  /** Wird bei JEDER Suche neu gerufen, damit ein Themenwechsel im Betrieb
   * schon fuer die naechste Suche gilt. */
  decorations(): SearchDecorations;
  /** Die Leiste ist zu (Knopf, Esc, Tastenkuerzel, `toggle()`, `close()`).
   * Nicht nach `dispose()`: dort ist das Terminal ohnehin weg. */
  onClose(): void;
}

export interface TerminalSearchHandle {
  isOpen(): boolean;
  /** Oeffnet die Leiste, oder holt den Fokus in die offene -- ein Umschalter
   * schlosse sie. So arbeitet "Find…" im Terminalmenue. */
  openOrFocus(): void;
  /** Das Tastenkuerzel: zu -> auf, auf -> zu. */
  toggle(): void;
  close(): void;
  /** Baut die Leiste ab, ohne Rueckruf und ohne das Addon anzufassen. */
  dispose(): void;
}

interface Bar {
  root: HTMLDivElement;
  input: HTMLInputElement;
  count: HTMLSpanElement;
  matchCase: HTMLButtonElement;
  results: IDisposable;
  caseSensitive: boolean;
  /** Die ausstehende Suche nach dem Tippen. */
  timer: number | undefined;
}

function iconButton(action: string, label: string, name: IconName): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "terminal-search-btn";
  button.dataset.action = action;
  // Der Name steht doppelt, wie bei den Kopfknoepfen der Kachel: das Icon ist
  // nur Ornament, den Namen tragen `aria-label` und `title`.
  button.setAttribute("aria-label", label);
  button.title = label;
  const box = document.createElement("span");
  box.className = "icon-box";
  box.dataset.icon = name;
  box.setAttribute("aria-hidden", "true");
  box.appendChild(icon(name));
  button.appendChild(box);
  return button;
}

export function createTerminalSearch(opts: TerminalSearchOptions): TerminalSearchHandle {
  const { host, search, texts } = opts;
  let bar: Bar | null = null;
  let disposed = false;

  function cancelPending(b: Bar): void {
    window.clearTimeout(b.timer);
    b.timer = undefined;
  }

  /** Raeumt Hervorhebung und Zaehler weg. */
  function clear(b: Bar): void {
    cancelPending(b);
    search.clearDecorations();
    b.count.textContent = "";
  }

  /** Eine Suche mit dem Stand des Feldes. Die Optionen gehen bei JEDEM Aufruf
   * mit (auch bei Enter und den Pfeilen): ohne `decorations` bliebe der Zaehler
   * stehen und die Hervorhebung folgte nicht mehr. */
  function find(b: Bar, direction: "next" | "prev"): void {
    // Eine noch ausstehende Suche gilt als erledigt: sie liefe sonst NACH diesem
    // Aufruf noch einmal und sprang einen Treffer zu weit.
    cancelPending(b);
    const term = b.input.value;
    if (term === "") return;
    const options: ISearchOptions = { caseSensitive: b.caseSensitive, decorations: opts.decorations() };
    if (direction === "next") search.findNext(term, options);
    else search.findPrevious(term, options);
  }

  function toggleMatchCase(b: Bar): void {
    b.caseSensitive = !b.caseSensitive;
    b.matchCase.setAttribute("aria-pressed", String(b.caseSensitive));
    cancelPending(b);
    if (b.input.value === "") return;
    // Ohne diesen Aufruf stimmt nach dem Umschalten nichts mehr (addon-search
    // 0.16.0, gegen das echte Addon geprueft): `findNext` legt die neuen
    // Optionen ab, BEVOR es sie mit den alten vergleicht, erkennt eine blosse
    // Optionsaenderung also nie und laesst Zaehler und Hervorhebung des alten
    // Stands stehen. Dazu liest es dieselbe Eingabe als "weiter zum naechsten
    // Treffer". `clearDecorations` vergisst den gemerkten Begriff: die Suche
    // gilt als neu, beginnt am Anfang der Markierung und bleibt so am aktiven
    // Treffer, falls er noch passt. Die Markierung selbst bleibt stehen.
    search.clearDecorations();
    find(b, "next");
  }

  /** Zeigt, was das Addon meldet. Bei leerem Feld nichts: ein Begriff, der nie
   * gesucht wurde, hat auch kein "No results". */
  function showResults(b: Bar, event: ISearchResultChangeEvent): void {
    if (b.input.value === "") {
      b.count.textContent = "";
    } else if (event.resultCount === 0) {
      b.count.textContent = texts.none;
    } else if (event.resultIndex < 0) {
      // Ueber der Hervorhebungsgrenze des Addons kennt es die Lage des
      // aktiven Treffers nicht. Die Anzahl allein stimmt trotzdem.
      b.count.textContent = String(event.resultCount);
    } else {
      b.count.textContent = texts.count(event.resultIndex + 1, event.resultCount);
    }
  }

  function open(): void {
    const root = document.createElement("div");
    root.className = "terminal-search-overlay";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "terminal-search-input";
    input.placeholder = texts.placeholder;
    // Ein Platzhalter allein ist kein verlaesslicher Name.
    input.setAttribute("aria-label", texts.placeholder);
    input.autocomplete = "off";
    input.spellcheck = false;

    const count = document.createElement("span");
    count.className = "terminal-search-count";
    count.setAttribute("aria-live", "polite");

    const prev = iconButton("prev", texts.prev, "chevron-up");
    const next = iconButton("next", texts.next, "chevron-down");
    const matchCase = iconButton("matchCase", texts.matchCase, "case-sensitive");
    matchCase.setAttribute("aria-pressed", "false");
    const close = iconButton("close", texts.close, "x");

    root.append(input, count, prev, next, matchCase, close);

    const b: Bar = {
      root,
      input,
      count,
      matchCase,
      results: search.onDidChangeResults((event) => showResults(b, event)),
      caseSensitive: false,
      timer: undefined,
    };

    input.addEventListener("input", () => {
      cancelPending(b);
      if (input.value === "") {
        clear(b);
        return;
      }
      b.timer = window.setTimeout(() => {
        b.timer = undefined;
        find(b, "next");
      }, SEARCH_DEBOUNCE_MS);
    });

    prev.addEventListener("click", () => find(b, "prev"));
    next.addEventListener("click", () => find(b, "next"));
    matchCase.addEventListener("click", () => toggleMatchCase(b));
    close.addEventListener("click", closeBar);
    // Ein Druck auf die Leiste soll dem Feld den Fokus nicht nehmen -- weder auf
    // einen Knopf noch auf den Zaehler noch auf den Rand. Sonst liegt der Fokus
    // danach auf <body>: Enter ist tot, und Esc geht an der Leiste vorbei zum
    // Dokument (keyboard.ts) und stellt dort eine maximierte Kachel wieder her,
    // waehrend die Leiste offen bleibt. Im Feld selbst bleibt der Druck, was er
    // ist (Cursor setzen, markieren); die mittlere und die rechte Taste bleiben
    // beim Browser (natives Bearbeitungsmenue im Feld, UX-Spec §8.1). Die
    // Tastatur erreicht die Knoepfe weiter per Tab.
    root.addEventListener("mousedown", (event) => {
      if (event.button === 0 && event.target !== input) event.preventDefault();
    });

    // Am Wurzelelement, nicht am Feld: Esc und das Tastenkuerzel sollen auch
    // von einem Knopf der Leiste aus schliessen. Enter dagegen gehoert dem
    // Feld -- auf einem Knopf loest es dessen Klick aus.
    root.addEventListener("keydown", (event) => {
      // Waehrend einer IME-Eingabe gehoert Esc der Eingabe (es bricht sie ab),
      // nicht der Leiste.
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        // Sonst stellt das Escape am Dokument (keyboard.ts) eine maximierte
        // Kachel wieder her, obwohl es nur die Leiste schliessen sollte.
        event.stopPropagation();
        closeBar();
        return;
      }
      if (isAppChord(event) && matchAction(event) === "search.local") {
        event.preventDefault();
        closeBar();
        return;
      }
      // Waehrend einer IME-Eingabe bestaetigt Enter nur die Eingabe.
      if (event.target === input && event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        find(b, event.shiftKey ? "prev" : "next");
      }
    });

    bar = b;
    host.appendChild(root);
    input.focus();
  }

  function closeBar(): void {
    const b = bar;
    if (!b) return;
    bar = null;
    cancelPending(b);
    b.results.dispose();
    b.root.remove();
    search.clearDecorations();
    opts.onClose();
  }

  return {
    isOpen: () => bar !== null,
    openOrFocus() {
      if (disposed) return;
      if (bar) bar.input.focus();
      else open();
    },
    toggle() {
      if (disposed) return;
      if (bar) closeBar();
      else open();
    },
    close: closeBar,
    dispose() {
      disposed = true;
      const b = bar;
      bar = null;
      if (!b) return;
      cancelPending(b);
      b.results.dispose();
      b.root.remove();
    },
  };
}
