// Kompakte Ansicht fuer schmale Bildschirme, vor allem Telefone (Spec
// 2026-10-27 §5.1).
//
// Unter `COMPACT_QUERY` hat `#app` nur eine Spalte: oben eine Kopfleiste,
// darunter das Raster ueber die ganze Breite. Die Seitenleiste wird eine
// Schublade, die das Raster ueberdeckt, statt es zu verkleinern -- so behalten
// die Terminals ihre Groesse, und Oeffnen und Schliessen schickt kein
// `resize_terminal` (V12). Das Raster zeigt genau eine Kachel: die
// fokussierte, maximiert. Die Kacheln selbst bleiben, wie sie sind; die
// Seitenleiste fuehrt sie mit Nummer, ein Tipp auf eine Session holt sie nach
// vorn und schliesst die Schublade.
//
// Breitere Fenster (Tablet quer, jeder Desktop: dort ist das Fenster
// mindestens 1100 px breit) sehen davon nichts.

import { onBackButtonPress } from "@tauri-apps/api/app";
import type { AppState } from "../state/app-state";
import { icon } from "../icons";
import { t } from "../i18n/t";

/** Bis zu dieser Breite ist die Ansicht kompakt: jedes Telefon hochkant und
 * die meisten quer. Dieselbe Grenze steht in `styles.css`. */
export const COMPACT_QUERY = "(max-width: 720px)";

export interface CompactShellOptions {
  /** `#app`: traegt die Klassen `compact` und `compact-sessions-open`. */
  app: HTMLElement;
  state: AppState;
  /** Zahl der wartenden Sessions, wie sie der Fenstertitel zaehlt. */
  waitingCount(): number;
  /** Name der Session in der fokussierten Kachel, sonst `null`. */
  focusedLabel(): string | null;
  /** Fuer Tests: der Abgleich mit der Medienabfrage. */
  matchMedia?: (query: string) => MediaQueryList;
  /** Fuer Tests: die Zurueck-Geste von Android. */
  onBackButton?: typeof onBackButtonPress;
}

export interface CompactShellHandle {
  /** Ist die Ansicht gerade kompakt? */
  isCompact(): boolean;
  /** Ist die Schublade offen? Ausserhalb der kompakten Ansicht nie. */
  sessionsOpen(): boolean;
  setSessionsOpen(open: boolean): void;
  dispose(): void;
}

export function mountCompactShell(opts: CompactShellOptions): CompactShellHandle {
  const { app, state } = opts;
  const query = (opts.matchMedia ?? window.matchMedia.bind(window))(COMPACT_QUERY);
  const onBack = opts.onBackButton ?? onBackButtonPress;

  const bar = document.createElement("div");
  bar.id = "compact-bar";
  bar.className = "compact-bar";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "compact-bar-toggle btn btn--text";
  toggle.appendChild(icon("menu"));
  const toggleLabel = document.createElement("span");
  toggleLabel.className = "compact-bar-label";
  toggleLabel.textContent = t("compact.sessions");
  toggle.appendChild(toggleLabel);
  const waitingBadge = document.createElement("span");
  waitingBadge.className = "compact-bar-waiting";
  waitingBadge.hidden = true;
  toggle.appendChild(waitingBadge);

  const title = document.createElement("span");
  title.className = "compact-bar-title";

  bar.append(toggle, title);
  app.prepend(bar);

  /** Die Wahl des Nutzers, solange es Kacheln gibt; ohne Kachel gilt
   * `sessionsShown()`. */
  let open = false;
  /** Die Kachel, die diese Ansicht selbst maximiert hat; nur sie gibt sie beim
   * Verlassen wieder frei. */
  let ownMaximize: number | null = null;
  let lastFocused = state.focusedTile;
  let lastTileCount = state.tiles.length;
  let backListener: { unregister(): Promise<void> } | null = null;
  let backPending = false;
  let disposed = false;

  function compact(): boolean {
    return query.matches;
  }

  /** Ist die Schublade offen? Ohne Kachel liegt hinter ihr nichts zu sehen:
   * Dann ist sie offen, sobald es Hosts gibt, und ohne Host zu, damit der
   * Erststart im Raster sichtbar ist. */
  function sessionsShown(): boolean {
    if (!compact()) return false;
    if (state.tiles.length === 0) return state.hosts.length > 0;
    return open;
  }

  toggle.addEventListener("click", () => setOpen(!sessionsShown()));

  function setOpen(next: boolean): void {
    open = next;
    render();
  }

  /** Genau eine Kachel sichtbar: die fokussierte, sonst die erste. Maximiert
   * nur, wo es mehr als eine gibt; eine einzelne fuellt das Raster ohnehin. */
  function keepOneTile(): void {
    if (!compact() || state.tiles.length < 2) return;
    const target = state.focusedTile ?? state.tiles[0].id;
    if (state.maximizedTile === target) return;
    ownMaximize = target;
    state.toggleMaximize(target);
  }

  /** Beim Verlassen der kompakten Ansicht zeigt das Raster wieder alle
   * Kacheln, ausser jemand hat inzwischen selbst maximiert. */
  function releaseMaximize(): void {
    if (ownMaximize !== null && state.maximizedTile === ownMaximize) state.toggleMaximize(ownMaximize);
    ownMaximize = null;
  }

  function onStateChanged(): void {
    if (disposed) return;
    const focusedChanged = state.focusedTile !== null && state.focusedTile !== lastFocused;
    const tileAdded = state.tiles.length > lastTileCount;
    lastFocused = state.focusedTile;
    lastTileCount = state.tiles.length;
    // Eine gewaehlte oder neu geoeffnete Session soll man sehen.
    if (focusedChanged || tileAdded) open = false;
    keepOneTile();
    render();
  }

  function onQueryChanged(): void {
    if (disposed) return;
    if (compact()) keepOneTile();
    else releaseMaximize();
    render();
  }

  function render(): void {
    const isCompact = compact();
    const showSessions = sessionsShown();
    app.classList.toggle("compact", isCompact);
    app.classList.toggle("compact-sessions-open", showSessions);
    toggle.setAttribute("aria-expanded", String(showSessions));
    toggle.title = showSessions ? t("compact.sessions.hide") : t("compact.sessions.show");
    const waiting = opts.waitingCount();
    waitingBadge.hidden = waiting === 0;
    waitingBadge.textContent = waiting === 0 ? "" : t("attention.waiting", { count: String(waiting) });
    title.textContent = opts.focusedLabel() ?? "";
    syncBackButton(showSessions && state.tiles.length > 0);
  }

  /** Solange die Schublade offen ist und eine Kachel dahinter liegt, schliesst
   * die Zurueck-Geste sie. Sonst ist kein Zuhoerer angemeldet, und Android
   * tut, was es immer tut: die App in den Hintergrund legen. */
  function syncBackButton(wanted: boolean): void {
    if (backPending) return;
    if (wanted && backListener === null) {
      backPending = true;
      onBack(() => setOpen(false))
        .then((listener) => {
          backPending = false;
          backListener = listener;
          if (disposed || !(sessionsShown() && state.tiles.length > 0)) releaseBack();
        })
        .catch(() => {
          // Auf dem Desktop gibt es die Geste nicht; der Knopf genuegt.
          backPending = false;
        });
    } else if (!wanted && backListener !== null) {
      releaseBack();
    }
  }

  function releaseBack(): void {
    const listener = backListener;
    backListener = null;
    void listener?.unregister().catch(() => {});
  }

  const unsubscribe = state.subscribe(onStateChanged);
  query.addEventListener("change", onQueryChanged);
  keepOneTile();
  render();

  return {
    isCompact: compact,
    sessionsOpen: sessionsShown,
    setSessionsOpen: setOpen,
    dispose() {
      disposed = true;
      unsubscribe();
      query.removeEventListener("change", onQueryChanged);
      releaseBack();
      bar.remove();
      app.classList.remove("compact", "compact-sessions-open");
    },
  };
}
