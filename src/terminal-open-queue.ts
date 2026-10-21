// Oeffnen ueber eine Schlange je Host (Spec 2026-10-19 §8.1, Schritt 3): bei
// bis zu acht Kacheln je Host gehen hoechstens vier `open_terminal` zugleich
// hinaus, die uebrigen Kacheln warten und zeigen "Opening…". Die Vier gehoert
// zu zwei gleichen Grenzen im Backend, und alle drei bleiben gleich: hoechstens
// vier offene Einrichtungen je Host (`TerminalAttempt::reserve`,
// src-tauri/src/commands.rs) und vier noch nicht veroeffentlichte Kanaele je
// Verbindung (`unpublished`, src-tauri/src/transport/russh_transport/
// owned_operations.rs).
//
// Nur die Buchhaltung, ohne DOM, Zeitgeber und `invoke`: wann eine Ansicht
// eintritt, sendet und freigibt, entscheidet `terminal.ts`. Die Schlange
// gehoert dem Aufrufer (eine je `mountGrid`), nicht diesem Modul -- ein
// Modulzustand liesse die Plaetze haengender Oeffnungen in alles Spaetere
// durchsickern.

export const MAX_OPENS_PER_HOST = 4;

export interface OpenTicket {
  /** true, sobald der Platz zugeteilt ist (sofort bei `enter` oder spaeter).
   * Nach `release()` bleibt der Wert stehen: `true` fuer ein Ticket, das
   * einen Platz hatte, `false` fuer eines, das die Schlange wartend verliess. */
  readonly granted: boolean;
  /** Gibt den Platz frei oder verlaesst die Schlange; mehrfach aufrufbar, ab
   * dem zweiten Mal wirkungslos. */
  release(): void;
}

export interface OpenQueue {
  /** Reiht ein. Ist ein Platz frei, ist das Ticket sofort zugeteilt und
   * `onGrant` wird NICHT gerufen. Sonst ruft die Schlange `onGrant`
   * hoechstens einmal: sobald ein Platz frei wird (FIFO je Schluessel),
   * synchron innerhalb des `release()`, das ihn frei macht. Ein Ticket, das
   * vorher freigegeben wird, bekommt keinen Aufruf mehr. */
  enter(key: string, onGrant: () => void): OpenTicket;
  /** Zugeteilte Plaetze je Schluessel (fuer Tests und Messung). */
  inFlight(key: string): number;
  /** Wartende je Schluessel. */
  waiting(key: string): number;
}

interface Waiter {
  onGrant: () => void;
  granted: boolean;
  released: boolean;
}

/** Die Plaetze eines Schluessels. */
interface Lane {
  /** Zugeteilte, noch nicht freigegebene Tickets. */
  inFlight: number;
  /** Wartende in der Reihenfolge des Eintritts. */
  waiting: Waiter[];
}

export function createOpenQueue(limit = MAX_OPENS_PER_HOST): OpenQueue {
  const lanes = new Map<string, Lane>();

  function laneFor(key: string): Lane {
    let lane = lanes.get(key);
    if (lane === undefined) {
      lane = { inFlight: 0, waiting: [] };
      lanes.set(key, lane);
    }
    return lane;
  }

  /** Vergisst eine leere Bahn: jede Verbindung bekommt eine neue Laufzeit-ID,
   * die Karte wuechse sonst mit jedem Neuverbinden. Nur, wenn die Karte noch
   * DIESE Bahn fuehrt -- ein Rueckruf kann sie geleert und unter demselben
   * Schluessel schon eine neue angelegt haben. */
  function forgetIfIdle(key: string, lane: Lane): void {
    if (lane.inFlight === 0 && lane.waiting.length === 0 && lanes.get(key) === lane) lanes.delete(key);
  }

  /** Teilt freie Plaetze in der Reihenfolge des Eintritts zu. Jede Runde liest
   * die Zaehler neu: ein `onGrant`, der selbst eintritt oder freigibt, hat sie
   * vielleicht schon veraendert. Gezaehlt wird VOR dem Rueckruf, damit er
   * einen stimmigen Stand sieht. */
  function grantWaiting(key: string, lane: Lane): void {
    while (lane.inFlight < limit) {
      const next = lane.waiting.shift();
      if (next === undefined) break;
      next.granted = true;
      lane.inFlight += 1;
      next.onGrant();
    }
    forgetIfIdle(key, lane);
  }

  return {
    enter(key, onGrant) {
      // Jedes Ticket haelt seine Bahn selbst, statt sie beim Freigeben ueber
      // den Schluessel zu suchen: die Karte kann bis dahin eine andere fuehren.
      const lane = laneFor(key);
      const waiter: Waiter = { onGrant, granted: false, released: false };
      // Auch ein freier Platz ueberholt keine Wartenden.
      if (lane.inFlight < limit && lane.waiting.length === 0) {
        waiter.granted = true;
        lane.inFlight += 1;
      } else {
        lane.waiting.push(waiter);
      }
      return {
        get granted() {
          return waiter.granted;
        },
        release() {
          if (waiter.released) return;
          waiter.released = true;
          if (waiter.granted) {
            lane.inFlight -= 1;
            grantWaiting(key, lane);
            return;
          }
          const index = lane.waiting.indexOf(waiter);
          if (index !== -1) lane.waiting.splice(index, 1);
          forgetIfIdle(key, lane);
        },
      };
    },
    inFlight(key) {
      return lanes.get(key)?.inFlight ?? 0;
    },
    waiting(key) {
      return lanes.get(key)?.waiting.length ?? 0;
    },
  };
}
