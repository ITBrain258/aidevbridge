// Neuverbinden nach Verlust der Terminalverbindung (UX-Spec §5.4): ein Host
// mit Schluessel oder ssh-agent, dessen Terminalverbindung abriss (Standby,
// Netzwechsel, VPN), wird vollstaendig neu verbunden -- nach 2, 5, 15, 30 und
// 60 s (je +-20 %, `retryDelay`), hoechstens fuenfmal je Ausfall, sofort bei
// Fensterfokus oder dem Ereignis `online` (`wake`). Wiederholt wird nur bei
// Netzfehlern; ein Hostschluessel-, Anmelde- oder Passphrasefehler beendet die
// Reihe sofort.
//
// Dieses Modul fuehrt nur den Zeitplan. Welcher Host neu verbunden wird, was
// ein Versuch ist und wie die Reihe angezeigt wird, reicht `main.ts` hinein.
// Je Host laeuft hoechstens ein Versuch: der naechste wird erst geplant, wenn
// der vorige zurueck ist.

import { RETRY_DELAYS_MS, retryDelay } from "./retry-schedule";

/** Fehlercodes aus `connect_host` (`ConnectError.code`, commands.rs), bei
 * denen ein neuer Versuch lohnt: der Host war nicht erreichbar (dazu gehoeren
 * auch eine gescheiterte Namensaufloesung und ein abgewiesener TCP-Aufbau,
 * beide als `AuthError::HostUnreachable`), die Verbindung lief in eine
 * Zeitueberschreitung (auch die einer abgelaufenen Hostschluesselfrage -- bei
 * einem bekannten Host kommt keine Frage vor), oder es waren schon zu viele
 * Verbindungsversuche oder Aufloesungen unterwegs. Alles andere
 * (`auth_rejected`, `password_required`, `passphrase_required`,
 * `host_key_rejected`, `connect_cancelled`, `other` -- dazu gehoert ein
 * abgestuerzter Aufloesungs-Worker) braucht den Nutzer. */
const RETRYABLE_CONNECT_CODES: readonly string[] = ["host_unreachable", "connect_timeout", "connect_capacity"];

/** So lange muss eine neu aufgebaute Verbindung halten, bevor ein neuer
 * Verlust wieder eine frische Reihe beginnt. Faellt sie frueher, zaehlt die
 * Reihe weiter: ein Host, der die Verbindung annimmt und gleich wieder
 * verliert, erreicht so nach fuenf Versuchen das Ende, statt endlos neu
 * verbunden zu werden -- und ein ssh-agent mit Bestaetigung fragt nicht
 * endlos. Derselbe Gedanke und Wert wie `REATTACH_STABLE_MS` der Kacheln. */
export const RECONNECT_STABLE_MS = 10_000;

export function isRetryableConnectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_CONNECT_CODES.includes(code);
}

/** Ausgang eines Versuchs. `superseded`: ein anderer Weg hat den Host
 * inzwischen uebernommen (Verbinden von Hand, Trennen, Entfernen). */
export type ReconnectAttemptResult =
  | { kind: "connected" }
  | { kind: "failed"; error: unknown }
  | { kind: "superseded" };

export interface HostReconnectDeps {
  /** Ein vollstaendiger Verbindungsaufbau ohne Geheimnis. */
  attempt: (hostId: string) => Promise<ReconnectAttemptResult>;
  /** Die Reihe beginnt (`true`) oder endet (`false`) -- fuer die Anzeige. */
  onActiveChange: (hostId: string, active: boolean) => void;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Zufallsquelle der Streuung, wie bei `retryDelay`. */
  random?: () => number;
}

export interface HostReconnector {
  /** Die Terminalverbindung dieses Hosts ging verloren. Beginnt die Reihe,
   * oder setzt sie fort, wenn die Verbindung aus ihrem letzten Versuch
   * stammte und keine `RECONNECT_STABLE_MS` gehalten hat -- auch dann, wenn
   * dieser Versuch noch gar nicht zurueck ist. */
  start(hostId: string): void;
  /** Beendet die Reihe und vergisst ihren Zaehler. Ein Versuch, der gerade
   * laeuft, bleibt unbeachtet. */
  stop(hostId: string): void;
  /** Fensterfokus oder `online`: wartende Versuche starten sofort. Laeuft
   * schon einer, geschieht nichts -- ein Schwall von Ereignissen startet
   * genau einen Versuch. Der Zaehler laeuft weiter. */
  wake(): void;
  isActive(hostId: string): boolean;
  /** Raeumt alle Zeitgeber ab, ohne `onActiveChange` (der Lauf endet). */
  dispose(): void;
}

interface Series {
  /** Versuche dieses Ausfalls, die zurueck sind. */
  attempts: number;
  /** waiting: Zeitgeber laeuft; running: ein Versuch ist unterwegs; stable:
   * der letzte Versuch hat verbunden, die Reihe ist nicht mehr zu sehen und
   * zaehlt bis `RECONNECT_STABLE_MS` weiter. */
  phase: "waiting" | "running" | "stable";
  /** Waehrend des laufenden Versuchs ging seine neue Verbindung schon wieder
   * verloren: ist er zurueck, geht die Reihe weiter. */
  restart: boolean;
  timer: unknown;
}

export function createHostReconnector(deps: HostReconnectDeps): HostReconnector {
  const series = new Map<string, Series>();
  let disposed = false;

  function clearTimer(entry: Series): void {
    if (entry.timer !== null) deps.clearTimer(entry.timer);
    entry.timer = null;
  }

  /** Wartet auf den naechsten Versuch, oder beendet die Reihe nach dem fuenften. */
  function schedule(hostId: string, entry: Series): void {
    const delay = retryDelay(entry.attempts, deps.random);
    if (delay === null) {
      end(hostId, entry);
      return;
    }
    entry.phase = "waiting";
    entry.timer = deps.setTimer(() => {
      entry.timer = null;
      void run(hostId, entry);
    }, delay);
  }

  /** Ein neuer Verlust innerhalb der Reihe: weiter mit dem naechsten Versuch,
   * oder Ende, wenn alle fuenf verbraucht sind. */
  function resume(hostId: string, entry: Series): void {
    if (entry.attempts >= RETRY_DELAYS_MS.length) {
      end(hostId, entry);
      return;
    }
    deps.onActiveChange(hostId, true);
    schedule(hostId, entry);
  }

  async function run(hostId: string, entry: Series): Promise<void> {
    if (disposed || series.get(hostId) !== entry || entry.phase !== "waiting") return;
    clearTimer(entry);
    entry.phase = "running";
    let result: ReconnectAttemptResult;
    try {
      result = await deps.attempt(hostId);
    } catch (error) {
      result = { kind: "failed", error };
    }
    // Inzwischen beendet (stop, dispose): das Ergebnis gehoert keiner Reihe mehr.
    if (disposed || series.get(hostId) !== entry) return;
    entry.attempts += 1;
    if (entry.restart) {
      // Der Versuch hatte schon verbunden, als dessen Verbindung verloren
      // ging (`start` mitten im Versuch). Sein Ergebnis ist ueberholt.
      entry.restart = false;
      resume(hostId, entry);
    } else if (result.kind === "connected") {
      settle(hostId, entry);
    } else if (result.kind === "failed" && isRetryableConnectError(result.error)) {
      schedule(hostId, entry);
    } else {
      end(hostId, entry);
    }
  }

  /** Verbunden: die Reihe ist nicht mehr zu sehen, haelt ihren Zaehler aber
   * noch `RECONNECT_STABLE_MS` lang fest. */
  function settle(hostId: string, entry: Series): void {
    entry.phase = "stable";
    deps.onActiveChange(hostId, false);
    entry.timer = deps.setTimer(() => {
      entry.timer = null;
      if (series.get(hostId) === entry && entry.phase === "stable") series.delete(hostId);
    }, RECONNECT_STABLE_MS);
  }

  function end(hostId: string, entry: Series): void {
    clearTimer(entry);
    if (series.get(hostId) === entry) series.delete(hostId);
    deps.onActiveChange(hostId, false);
  }

  return {
    start(hostId) {
      if (disposed) return;
      const entry = series.get(hostId);
      if (!entry) {
        const fresh: Series = { attempts: 0, phase: "waiting", restart: false, timer: null };
        series.set(hostId, fresh);
        deps.onActiveChange(hostId, true);
        schedule(hostId, fresh);
      } else if (entry.phase === "running") {
        // Ein Verlust kann nur von einer verbundenen Verbindung kommen: der
        // Versuch ist schon an `connect_host` vorbei und wartet nur noch auf
        // die Sessionliste. Kein zweiter Versuch jetzt -- die Reihe geht
        // weiter, sobald er zurueck ist, und zeigt sich gleich wieder.
        if (!entry.restart) {
          entry.restart = true;
          deps.onActiveChange(hostId, true);
        }
      } else if (entry.phase === "stable") {
        clearTimer(entry);
        resume(hostId, entry);
      }
      // waiting: die Reihe laeuft schon.
    },
    stop(hostId) {
      const entry = series.get(hostId);
      if (entry) end(hostId, entry);
    },
    wake() {
      for (const [hostId, entry] of series) {
        if (entry.phase === "waiting") void run(hostId, entry);
      }
    },
    isActive(hostId) {
      const entry = series.get(hostId);
      return entry !== undefined && entry.phase !== "stable";
    },
    dispose() {
      disposed = true;
      for (const entry of series.values()) clearTimer(entry);
      series.clear();
    },
  };
}
