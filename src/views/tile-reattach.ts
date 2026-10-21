// Stilles Wiederanhaengen einer Kachel (UX-Spec §5.5): verliert eine Kachel
// ihren Terminalkanal, waehrend die Verbindung ihres Hosts lebt (typisch der
// 30-s-Waechter des Backends bei minimiertem Fenster), haengt sie sich bis zu
// dreimal selbst neu an -- nach 0,5, 2 und 5 s. Ist das Fenster oder die
// Kachel verborgen (eine andere ist maximiert, Spec 2026-10-19 §8.1), wartet
// der faellige Versuch, bis beide wieder zu sehen sind, und laeuft dann sofort.
//
// Nur der Zeitplan einer Kachel, ohne DOM und ohne `AppState`: was ein Versuch
// ist (frisches `open_terminal` in derselben Kachel), ob er noch darf und was
// die Kachel dabei zeigt, entscheidet `grid.ts`.

export const REATTACH_DELAYS_MS: readonly number[] = [500, 2000, 5000];

/** So lange muss ein wieder angehaengter Kanal halten, bevor ein neuer
 * Verlust wieder von vorn zaehlt. Stirbt er frueher (etwa eine Pane, die
 * waehrend der Verlaufserfassung den Kanalpuffer flutet), geht die Reihe
 * weiter, statt sich endlos neu anzuhaengen. */
export const REATTACH_STABLE_MS = 10_000;

export interface TileReattachDeps {
  /** Haengt die Kachel neu an. Antwortet spaeter mit `opened` oder `failed`. */
  attach: () => void;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Ist das Fenster (`document.hidden`) oder die Kachel verborgen? */
  isHidden: () => boolean;
  /** Ruft `callback` beim naechsten Sichtbarwerden; liefert die Abmeldung. */
  onVisible: (callback: () => void) => () => void;
}

export interface TileReattach {
  /** Der Kanal ging verloren. `false`: alle drei Versuche sind verbraucht. */
  lost(): boolean;
  /** Der laufende Versuch ist gescheitert. `false`: alle drei sind verbraucht. */
  failed(): boolean;
  /** Der laufende Versuch hat angehaengt. */
  opened(): void;
  /** Beendet die Reihe ohne weiteren Versuch. */
  cancel(): void;
  /** Zeigt die Kachel "Reconnecting…"? Waehrend der Wartezeit, des Wartens
   * auf Sichtbarkeit und des laufenden Versuchs. */
  readonly active: boolean;
  /** Ist gerade ein Versuch unterwegs? */
  readonly attaching: boolean;
}

export function createTileReattach(deps: TileReattachDeps): TileReattach {
  /** Gestartete Versuche der laufenden Reihe. */
  let attempts = 0;
  /** idle: keine Reihe; waiting: Zeitgeber laeuft; hidden: wartet auf
   * Sichtbarkeit; attaching: Versuch unterwegs; attached: angehaengt, die
   * Reihe zaehlt bis `REATTACH_STABLE_MS` weiter. */
  let phase: "idle" | "waiting" | "hidden" | "attaching" | "attached" = "idle";
  let timer: unknown = null;
  let unwatch: (() => void) | null = null;

  function clear(): void {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    unwatch?.();
    unwatch = null;
  }

  function reset(): void {
    clear();
    phase = "idle";
    attempts = 0;
  }

  /** Plant den naechsten Versuch; `false`, wenn alle drei verbraucht sind. */
  function schedule(): boolean {
    clear();
    const delay = REATTACH_DELAYS_MS[attempts];
    if (delay === undefined) {
      reset();
      return false;
    }
    phase = "waiting";
    timer = deps.setTimer(due, delay);
    return true;
  }

  function due(): void {
    timer = null;
    if (phase !== "waiting") return;
    if (!deps.isHidden()) {
      begin();
      return;
    }
    phase = "hidden";
    unwatch = deps.onVisible(() => {
      unwatch?.();
      unwatch = null;
      if (phase === "hidden") begin();
    });
  }

  function begin(): void {
    attempts += 1;
    phase = "attaching";
    deps.attach();
  }

  return {
    lost() {
      // Eine zweite Meldung waehrend der Wartezeit aendert nichts.
      if (phase === "waiting" || phase === "hidden") return true;
      // Ein Verlust waehrend des Versuchs oder kurz nach ihm zaehlt weiter.
      if (phase === "idle") attempts = 0;
      return schedule();
    },
    failed() {
      if (phase !== "attaching") return phase !== "idle";
      return schedule();
    },
    opened() {
      if (phase !== "attaching") return;
      phase = "attached";
      timer = deps.setTimer(() => {
        timer = null;
        if (phase === "attached") reset();
      }, REATTACH_STABLE_MS);
    },
    cancel: reset,
    get active() {
      return phase === "waiting" || phase === "hidden" || phase === "attaching";
    },
    get attaching() {
      return phase === "attaching";
    },
  };
}
