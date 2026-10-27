import { planOpen, planReplace, type OpenPlan, type Tile } from "./tile-assignment";

export type HostState = "disconnected" | "connecting" | "connected" | "failed";

export interface SessionListError {
  message: string;
  code?: string;
  controlGeneration?: number;
}

export interface SessionListObservation {
  status: "never_loaded" | "current" | "stale";
  lastSuccessAt: number | null;
  error: Readonly<SessionListError> | null;
}

const UNLOADED_SESSION_LIST: Readonly<SessionListObservation> = Object.freeze({
  status: "never_loaded", lastSuccessAt: null, error: null,
});

export interface ControlObservation {
  generation: number;
  state: "ready" | "degraded" | "reconnecting" | "authentication_required";
  message: string | null;
}
const INITIAL_CONTROL: Readonly<ControlObservation> = Object.freeze({ generation: 0, state: "ready", message: null });

export interface StatusFreshness {
  /** The shown status values are history, not a current observation. */
  stale: boolean;
  /** Time of the last successful status observation (list or poll). */
  observedAt: number | null;
}
const UNOBSERVED_STATUS: Readonly<StatusFreshness> = Object.freeze({ stale: false, observedAt: null });

/** Statuswerte, die eine Aussage ueber den Agenten JETZT machen. Nur sie
 * werden bei ausgefallener Quelle festgehalten (UX-Spec §5.2). */
function isLiveStatus(status: string | null | undefined): boolean {
  return status === "waiting" || status === "busy" || status === "idle";
}

/** Der Socket einer Session (Spec 2026-10-25 §5): der eigene der App oder
 * tmux' Standard-Socket des Nutzers. Ein fehlendes `socket` ist der eigene. */
export type SessionSocket = "app" | "default";

export interface Session {
  name: string;
  hostId: string;
  /** Nur bei einer Session des Standard-Sockets gesetzt. */
  socket?: SessionSocket;
  open: boolean;
  inputLocked: boolean;
  sessionId?: number | null;
  serverPid?: number | null;
  serverStartTime?: number | null;
  windowId?: number | null;
  paneId?: number | null;
  panePid?: number | null;
  status?: string | null;
  statusReason?: string | null;
  /** Warum die Liste keine Bindung lieferte (`SessionListItemDto.unverified`). */
  unverified?: string | null;
  /** Angehaengte Clients laut Inventar (Spec 2026-10-25 §10 Nr. 2). */
  attached?: number | null;
}

export interface Host {
  /** Die in `settings.toml` gespeicherte ID (`new_host_id()`,
   * `commands.rs`). Sie aendert sich NIE, solange der Eintrag lebt -- daran
   * haengen saemtliche Kachelschluessel (`sessionKey`) und saemtliche
   * Fokusschluessel der Seitenleiste (`focusKey`, `sidebar.ts`). */
  id: string;
  /** Die beim erfolgreichen Aufbau uebernommene Laufzeit-ID oder `null`.
   * `begin_connect` reserviert sie vor dem Netzwerkaufbau; bis zum Erfolg
   * besitzt der jeweilige Connect-Auftrag sie separat, damit Abbruch und
   * alte Kacheln nicht dieselbe Runtime-ID meinen.
   *
   * `null` heisst "unter dieser ID kann nichts mehr laufen" -- gesetzt beim
   * ausdruecklichen Trennen (`setRuntimeId` unten). Bei `failed` bleibt die
   * alte ID ABSICHTLICH stehen, obwohl die Verbindung tot ist: die Kachel
   * soll mit ihrer Sperrleiste offen bleiben, und erst der naechste
   * ERFOLGREICHE Aufbau tauscht die ID. Ein Feld, das nur "lebendig oder
   * nicht" hiesse, koennte das nicht.
   *
   * Nur die Aufrufe ins Backend, die eine LEBENDE VERBINDUNG meinen,
   * benutzen dieses Feld: `open_terminal`, `close_terminal`, `send_input`,
   * `ack_output`, `resize_terminal`, `list_sessions`, `create_session`,
   * `list_directories`, `disconnect_host`. Die Aufrufe, die einen
   * GESPEICHERTEN EINTRAG meinen (`remove_host`, `add_host`), nehmen `id`.
   *
   * Zwei getrennte Felder statt eines: truege `id` nach einem erfolgreichen
   * Verbinden die Laufzeit-ID, verschoebe ein blosses Verbinden die
   * Identitaet der Hostzeile unter dem Nutzer, denn `id` geht in jeden
   * Fokus- und Kachelschluessel ein. */
  runtimeId: string | null;
  label: string;
  hostname: string;
  user: string;
  port: number;
  keyPath: string | null;
  /** Anmeldeart (Spec §4.8) -- ohne dieses Feld unterschiede sich ein
   * per Passwort gespeicherter Host nach einem Neustart nicht von einem
   * ssh-agent-Host: `keyPath` allein sagt nur "kein Schluessel gespeichert",
   * nicht "der Nutzer wollte Passwort statt Agent". `hostFromEntry`
   * (`main.ts`) fuellt dieses Feld beim Laden aus `HostEntry.auth_kind`, das
   * nie `null`/fehlend ist (siehe dessen Kommentar, `types.ts`). Absichtlich
   * PFLICHT, nicht optional wie `tmuxSocket`/`historyLimit` unten: die
   * Anmeldeart steuert bereits die Laufzeitverbindung. Ein optionales Feld wuerde in
   * `sidebar.ts` einen `host.authKind ?? "agent"`-Rueckfall erzwingen und
   * damit genau den stillen Agent-Rueckfall wieder einfuehren, den dieses
   * Feld verhindert. */
  authKind: "key" | "agent" | "password";
  state: HostState;
  error: string | null;
  /** Code des Fehlers in `error`: `ConnectError.code` des Backends oder
   * `password_required` der lokalen Pruefung (`main.ts`). Er entscheidet, ob
   * die Hinweisleiste nach einem Geheimnis fragt (`sidebar.ts`). Fehlt er,
   * gilt der Fehler als keiner, dem ein Geheimnis hilft. Gesetzt wird er nur
   * zusammen mit `error` (`setHostState`). */
  errorCode?: string | null;
  sessions: Session[];
  expanded: boolean;
  /** Verzeichnis der zuletzt in diesem Lauf erfolgreich angelegten Session
   * (Spec §6.4), leer heisst Heimatverzeichnis. Das Feld selbst wird NICHT
   * gespeichert; ueber einen Neustart traegt der Arbeitsplatz das zuletzt
   * genutzte (`dirs[host].last`, UX-Spec §7.6). `main.ts` belegt den
   * Sitzungsdialog mit dem ersten der beiden vor, das es gibt. */
  lastCwd: string;
  /** `hostFromEntry` (`main.ts`) laedt beide Felder aus `list_hosts`;
   * `editHost` erhaelt damit auch manuell gespeicherte Sonderwerte.
   * Keine Laufzeitoptionen: Create/List/Attach/Kill nutzen den eigenen
   * Socket, neue Panes die globale History-Vorgabe; `HostEntry.tmux_socket`
   * bleibt ungelesen (Spec 2026-10-25 §2). Optional fuer Hosts, die ohne
   * persistierten Eintrag konstruiert werden. */
  tmuxSocket?: string;
  historyLimit?: number;
  /** Schalter "Show tmux sessions" (Spec 2026-10-25 §10.1): aus, liest die
   * App den Standard-Socket dieses Hosts gar nicht. Fehlt er, gilt an. */
  showDefaultSocket?: boolean;
}

/** Die gespeicherten Felder eines Hosts, die "Edit host" aendern kann (UX-Spec
 * §7.7): alles aus settings.toml ausser der Kennung. */
export type HostSettings = Pick<
  Host,
  "label" | "hostname" | "user" | "port" | "keyPath" | "authKind" | "tmuxSocket" | "historyLimit" | "showDefaultSocket"
>;

/** Host-qualifiziert, weil zwei Hosts gleichnamige tmux-Sessions haben
 * duerfen (Spec §4.3). Ein unqualifizierter Name waere mehrdeutig -- genau
 * der Fehler, den `terminal.ts:389` heute noch macht (Spec §11.1).
 *
 * Auch der Socket gehoert dazu (Spec 2026-10-25 §5): dieselbe Session kann auf
 * beiden heissen. Der eigene Schluessel bleibt "hostId/name", der des
 * Standard-Sockets ist "hostId/default:name"; ein tmux-Name enthaelt nie ":"
 * (tmux ersetzt es), also trifft keiner den anderen. Das Hostpraefix bleibt
 * fuer beide gleich, die Grenze je Host zaehlt sie zusammen. */
export function sessionKey(hostId: string, name: string, socket: SessionSocket = "app"): string {
  return socket === "default" ? `${hostId}/default:${name}` : `${hostId}/${name}`;
}

export function socketOf(session: { socket?: SessionSocket }): SessionSocket {
  return session.socket ?? "app";
}

/** Eine Session des Standard-Sockets oeffnet nur mit ihrer vollstaendigen
 * Bindung (Spec 2026-10-25 §6.4); ohne sie lehnte das Backend ab. Die EINE
 * Regel fuer jeden Weg in eine Kachel: Seitenleiste, Schnelloeffnen, Spur,
 * Strg+Umschalt+A, das Oeffnen nach dem Verbinden und der Arbeitsplatz. */
export function isOpenable(session: Session): boolean {
  if (socketOf(session) === "app") return true;
  return [session.sessionId, session.serverPid, session.serverStartTime, session.windowId, session.paneId, session.panePid]
    .every((value) => value != null);
}

/** `sessionKey` einer Session, mit ihrem Socket. */
export function sessionKeyOf(session: Pick<Session, "hostId" | "name" | "socket">): string {
  return sessionKey(session.hostId, session.name, socketOf(session));
}

/** Was eine Sessionwahl bewirkt hat (Spec 2026-10-19 §5.1, §5.2, §5.3). */
export type OpenResult =
  | { kind: "focused"; tileId: number }
  | { kind: "added"; tileId: number }
  | { kind: "replaced"; tileId: number; previousKey: string }
  | { kind: "limit"; scope: "host" | "total"; hostId: string };

export class AppState {
  hosts: Host[] = [];
  /** Die Kacheln in Anzeigereihenfolge (Spec 2026-10-19 §4.1): die Position
   * ist der Index, die Nummer im Kachelkopf Position + 1. Jede traegt eine
   * Session; leere Plaetze gibt es nicht. */
  tiles: Tile[] = [];
  /** `id` der maximierten Kachel. */
  maximizedTile: number | null = null;
  /** `id` der fokussierten Kachel. */
  focusedTile: number | null = null;
  /** Merkstelle fuer Schritt 2 der Zielhost-Kette von Strg+Umschalt+N (UX-Spec
   * §7.9): die zuletzt fokussierte Kachel und die Session, die sie dabei
   * zeigte. Schliesst diese Kachel, gilt die Merkstelle nicht mehr. */
  #lastOccupiedFocus: { id: number; key: string } | null = null;
  /** Naechste Kachel-`id`. Nie wiederverwendet: eine `id` meint fuer die
   * ganze Laufzeit genau eine Kachel, auch in Rueckrufen des Rasters. */
  #nextTileId = 1;

  // Monotoner Zaehler statt `Date.now()`: zwei Fokuswechsel in derselben
  // Millisekunde waeren sonst ununterscheidbar.
  #clock = 0;
  #subscribers = new Set<() => void>();
  #sessionLists = new Map<string, Readonly<SessionListObservation>>();
  #controls = new Map<string, Readonly<ControlObservation>>();
  #statusFreshness = new Map<string, Readonly<StatusFreshness>>();
  /** Je Host: Sessions, deren angezeigter Status festgehalten und damit
   * Geschichte ist, mit dem Zeitpunkt seiner letzten echten Beobachtung. */
  #keptStatus = new Map<string, Map<string, number | null>>();
  /** Hosts, deren Steuerverbindung gerade die Selbstreparatur durchlaeuft. */
  #controlSelfRepairs = new Set<string>();
  /** Hosts, die nach einem Verlust der Terminalverbindung neu verbunden werden. */
  #hostReconnects = new Set<string>();
  /** Je Host die Version eines Servers auf dem Standard-Socket, an dem die App
   * nicht anhaengt (Spec 2026-10-25 §6.2). */
  #unsupportedDefault = new Map<string, string>();

  /** Die Hostzeile nennt sie als Grund, warum die Gruppe leer bleibt. */
  unsupportedDefaultVersion(hostId: string): string | null {
    return this.#unsupportedDefault.get(hostId) ?? null;
  }

  setUnsupportedDefaultVersion(hostId: string, version: string | null): void {
    if (this.unsupportedDefaultVersion(hostId) === version) return;
    if (version === null) this.#unsupportedDefault.delete(hostId);
    else this.#unsupportedDefault.set(hostId, version);
    this.#notify();
  }

  controlForHost(hostId: string): Readonly<ControlObservation> {
    return this.#controls.get(hostId) ?? INITIAL_CONTROL;
  }

  /** Laeuft fuer diesen Host die Reihe des Neuverbindens (UX-Spec §5.4)? Die
   * Seitenleiste zeigt dann die ruhige Zeile "Reconnecting…" statt des
   * Kastens, die Kacheln den ruhigen Hinweis statt der Sperrleiste. Den Ablauf
   * fuehrt `state/reconnect.ts`; hier steht nur, was die Anzeige wissen muss.
   * Die Reihe uebersteht die Zwischenzustaende ihrer Versuche ("connecting",
   * "failed") und endet spaetestens, wenn der Host verbunden ist. */
  isHostReconnecting(hostId: string): boolean {
    return this.#hostReconnects.has(hostId);
  }

  setHostReconnecting(hostId: string, active: boolean): void {
    if (active && !this.hosts.some((host) => host.id === hostId && host.state !== "connected")) return;
    if (active === this.#hostReconnects.has(hostId)) return;
    if (active) this.#hostReconnects.add(hostId);
    else this.#hostReconnects.delete(hostId);
    this.#notify();
  }

  /** Laeuft fuer diesen Host die Reihe der Selbstreparatur (UX-Spec §5.3)?
   * Die Seitenleiste zeigt dann die ruhige Zeile statt des Kastens. Den Ablauf
   * fuehrt `main.ts`; hier steht nur, was die Anzeige wissen muss. */
  isControlSelfRepairing(hostId: string): boolean {
    return this.#controlSelfRepairs.has(hostId);
  }

  setControlSelfRepairing(hostId: string, active: boolean): void {
    if (active && !this.hosts.some((host) => host.id === hostId)) return;
    if (active === this.#controlSelfRepairs.has(hostId)) return;
    if (active) this.#controlSelfRepairs.add(hostId);
    else this.#controlSelfRepairs.delete(hostId);
    this.#notify();
  }

  /** Schluessel der Zustaende, die je (Host, Socket) gelten (Spec 2026-10-25
   * §6.3, §7): Listenzustand, Frische und gehaltener Status. Der eigene Socket
   * behaelt den blossen Host. */
  #scope(hostId: string, socket: SessionSocket): string {
    return socket === "default" ? `${hostId}\u0000default` : hostId;
  }

  /** Beide Sockets eines Hosts, fuer alles, was den ganzen Host trifft. */
  #scopes(hostId: string): string[] {
    return [this.#scope(hostId, "app"), this.#scope(hostId, "default")];
  }

  #session(hostId: string, name: string, socket: SessionSocket): Session | undefined {
    return this.hosts
      .find((h) => h.id === hostId)
      ?.sessions.find((s) => s.name === name && socketOf(s) === socket);
  }

  statusFreshnessForHost(hostId: string, socket: SessionSocket = "app"): Readonly<StatusFreshness> {
    return this.#statusFreshness.get(this.#scope(hostId, socket)) ?? UNOBSERVED_STATUS;
  }

  /** The ONE rule for "this host's agent status is current" (spec 4.4 step 1,
   * 4.6): the host is connected and a status query succeeded after the last
   * failed query, control breakdown or new connection. Otherwise the shown
   * values are history. Window title, Ctrl+Shift+A and tiles all use it.
   * Per socket (spec 2026-10-25 §6.3): a failure of the default socket never
   * makes the own sessions stale. */
  isStatusCurrent(hostId: string, socket: SessionSocket = "app"): boolean {
    const host = this.hosts.find((h) => h.id === hostId);
    return host?.state === "connected" && !this.statusFreshnessForHost(hostId, socket).stale;
  }

  /** Dieselbe Regel je Session: der Host ist aktuell UND ihr Wert wurde nicht
   * nach einem Quellenausfall festgehalten (`keepStatusStale`). Seitenleiste,
   * Kachel, Fenstertitel und Ctrl+Shift+A lesen den Status ueber diese Regel. */
  isSessionStatusCurrent(hostId: string, name: string, socket: SessionSocket = "app"): boolean {
    return (
      this.isStatusCurrent(hostId, socket) && !this.#keptStatus.get(this.#scope(hostId, socket))?.has(name)
    );
  }

  /** Zeitpunkt der letzten Beobachtung des angezeigten Werts ("As of"): bei
   * einem festgehaltenen Wert dessen eigene, sonst die des Hosts. */
  sessionStatusObservedAt(hostId: string, name: string, socket: SessionSocket = "app"): number | null {
    const kept = this.#keptStatus.get(this.#scope(hostId, socket));
    if (kept?.has(name)) return kept.get(name) ?? null;
    return this.statusFreshnessForHost(hostId, socket).observedAt;
  }

  /** Behaelt den bisherigen Status dieser Sessions und markiert ihn veraltet;
   * Seitenleiste und Kachel zeigen dann "As of HH:MM". Fuer eine Abfrage, deren
   * zustaendige Quelle ausfiel (UX-Spec §5.2). Nur Wartend, Beschaeftigt und
   * Leerlauf werden festgehalten; ein schon festgehaltener Wert behaelt seine
   * Zeit. Die naechste echte Beobachtung (`patchSessionStatus`, eine Liste)
   * hebt die Markierung auf. */
  keepStatusStale(hostId: string, sessionNames: string[], socket: SessionSocket = "app"): void {
    const observedAt = this.statusFreshnessForHost(hostId, socket).observedAt;
    if (this.#keepStatus(hostId, sessionNames, observedAt, socket)) this.#notify();
  }

  #keepStatus(hostId: string, names: string[], observedAt: number | null, socket: SessionSocket): boolean {
    const scope = this.#scope(hostId, socket);
    let kept = this.#keptStatus.get(scope);
    let changed = false;
    for (const name of names) {
      const session = this.#session(hostId, name, socket);
      if (!session || !isLiveStatus(session.status) || kept?.has(name)) continue;
      if (!kept) {
        kept = new Map();
        this.#keptStatus.set(scope, kept);
      }
      kept.set(name, observedAt);
      changed = true;
    }
    return changed;
  }

  /** Eine echte Beobachtung dieser Session; true, wenn sie festgehalten war. */
  #releaseKeptStatus(hostId: string, name: string, socket: SessionSocket): boolean {
    const scope = this.#scope(hostId, socket);
    const kept = this.#keptStatus.get(scope);
    if (!kept?.delete(name)) return false;
    if (kept.size === 0) this.#keptStatus.delete(scope);
    return true;
  }

  /** A status query failed. Only a later observation makes it current again. */
  markStatusStale(hostId: string, socket: SessionSocket = "app"): void {
    if (this.#setStatusStale(hostId, socket)) this.#notify();
  }

  #setStatusStale(hostId: string, socket: SessionSocket): boolean {
    const previous = this.statusFreshnessForHost(hostId, socket);
    if (previous.stale || !this.hosts.some((h) => h.id === hostId)) return false;
    this.#statusFreshness.set(this.#scope(hostId, socket), { stale: true, observedAt: previous.observedAt });
    return true;
  }

  /** Records a successful status observation; true when it ends staleness. */
  #markStatusObserved(hostId: string, observedAt: number, socket: SessionSocket): boolean {
    const wasStale = this.statusFreshnessForHost(hostId, socket).stale;
    this.#statusFreshness.set(this.#scope(hostId, socket), { stale: false, observedAt });
    return wasStale;
  }

  setControlState(hostId: string, observation: ControlObservation): void {
    if (!this.hosts.some((host) => host.id === hostId) ||
      observation.generation < this.controlForHost(hostId).generation) return;
    // UX-Spec §5.2: veraltet ist die Liste nur bei degraded, reconnecting und
    // authentication_required. Ein ready mit neuer Generation laesst sie, wie
    // sie ist; neu laedt sie `main.ts` bei einer neuen Generation. Die
    // Steuerverbindung traegt beide Sockets.
    if (observation.state !== "ready") {
      for (const socket of ["app", "default"] as const) {
        const list = this.sessionListForHost(hostId, socket);
        this.#sessionLists.set(this.#scope(hostId, socket), {
          ...list,
          status: list.lastSuccessAt === null ? "never_loaded" : "stale",
        });
        // Eine unterbrochene Steuerverbindung liefert keinen Status. Bei
        // "ready" markiert eine gescheiterte Abfrage die Veraltung selbst.
        this.#setStatusStale(hostId, socket);
      }
    }
    this.#controls.set(hostId, { ...observation });
    this.#notify();
  }

  sessionListForHost(hostId: string, socket: SessionSocket = "app"): Readonly<SessionListObservation> {
    return this.#sessionLists.get(this.#scope(hostId, socket)) ?? UNLOADED_SESSION_LIST;
  }

  setSessionListError(hostId: string, error: SessionListError, socket: SessionSocket = "app"): void {
    if (!this.hosts.some((host) => host.id === hostId)) return;
    const previous = this.sessionListForHost(hostId, socket);
    this.#sessionLists.set(this.#scope(hostId, socket), {
      status: previous.lastSuccessAt === null ? "never_loaded" : "stale",
      lastSuccessAt: previous.lastSuccessAt,
      error: { ...error },
    });
    this.#notify();
  }

  #invalidateSessionList(hostId: string): void {
    for (const socket of ["app", "default"] as const) {
      const previous = this.sessionListForHost(hostId, socket);
      this.#sessionLists.set(this.#scope(hostId, socket), {
        status: previous.lastSuccessAt === null ? "never_loaded" : "stale",
        lastSuccessAt: previous.lastSuccessAt,
        error: null,
      });
    }
  }

  subscribe(fn: () => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  /** Jeder Abonnent fuer sich: ein werfender haelt weder die uebrigen noch den
   * Aufrufer der Aenderung an, dessen Zustand schon geaendert ist. Es bleibt
   * die Iteration ueber das Set selbst, mit dessen Regeln: wer sich waehrend
   * der Benachrichtigung abmeldet, wird danach nicht mehr gerufen. */
  #notify(): void {
    for (const fn of this.#subscribers) {
      try {
        fn();
      } catch (error: unknown) {
        // Nicht verschluckt: in einer eigenen Mikroaufgabe neu geworfen, damit
        // er als unbehandelter Fehler in der Konsole steht. Bewusst das blosse
        // globale `queueMicrotask`: in der WebView ist es das des Fensters,
        // unter vitest das von Node, und dort laesst ein so geworfener Fehler
        // den Testlauf scheitern, statt nur in einer Konsole zu landen.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  /** Welche Kacheln der Nutzer gerade SIEHT: bei einer maximierten Kachel nur
   * diese, sonst alle in Anzeigereihenfolge. Die uebrigen verbirgt das Raster
   * nur, ihr Terminal bleibt (Spec 2026-10-19 §8.1, Schritt 3). */
  visibleTileIds(): number[] {
    if (this.maximizedTile !== null) return [this.maximizedTile];
    return this.tiles.map((tile) => tile.id);
  }

  /** Position einer Kachel (0-basiert), `null`, wenn es sie nicht gibt. */
  tilePosition(id: number): number | null {
    const position = this.tiles.findIndex((tile) => tile.id === id);
    return position === -1 ? null : position;
  }

  tileById(id: number | null): Tile | null {
    return id === null ? null : (this.tiles.find((tile) => tile.id === id) ?? null);
  }

  /** Die Kachel dieser Session -- es gibt hoechstens eine (§4.1). */
  tileForSession(key: string): Tile | null {
    return this.tiles.find((tile) => tile.sessionKey === key) ?? null;
  }

  /** Session der fokussierten Kachel, `null` ohne Fokus. */
  focusedSessionKey(): string | null {
    return this.tileById(this.focusedTile)?.sessionKey ?? null;
  }

  /** Host hinter einem Kachelschluessel. Das Format kommt aus `sessionKey`
   * in DIESER Datei; ausserhalb bleibt der Schluessel opak. Gesucht wird ueber
   * die Hosts, nicht ueber ihre Sessionlisten: die Grenze je Host zaehlt
   * Kacheln, auch die einer Session, die gerade aus der Liste fiel. */
  #hostOfKey(key: string): string | null {
    return this.hosts.find((host) => key.startsWith(`${host.id}/`))?.id ?? null;
  }

  upsertHost(h: Host): void {
    const i = this.hosts.findIndex((x) => x.id === h.id);
    // Ersetzen an gleicher Stelle statt entfernen+anhaengen: die
    // Seitenleiste (`views/sidebar.ts`) verlaesst sich auf stabile
    // Listenreihenfolge, sonst springt der Host beim naechsten Poll.
    //
    // Ersetzt DAS GANZE Host-Objekt, inklusive `sessions` -- also NICHT der
    // richtige Aufruf fuer einen tmux-Poll, der nur die Sessionliste eines
    // schon bekannten Hosts aktualisieren will. Dafuer ist `setSessions` da,
    // die bestehende `open`/`inputLocked`-Flags erhaelt. `upsertHost` ist fuer
    // neue Hosts und reine Metadatenaenderungen (Label, Zustand) gedacht.
    if (i === -1) this.hosts.push(h);
    else this.hosts[i] = h;
    this.#notify();
  }

  /** Uebernimmt die gespeicherten Felder eines bearbeiteten Hosts an Ort und
   * Stelle (UX-Spec §7.7): dasselbe Objekt, Verbindung, Sessions, Kacheln und
   * Aufklappzustand bleiben. Nicht `upsertHost`: das ersetzt den ganzen Host,
   * und sein Objekt ist in `main.ts` zugleich die Identitaet laufender
   * Verbindungs- und Listenauftraege -- ein blosses Umbenennen verwuerfe sie.
   * Feld fuer Feld zugewiesen, damit ein breiteres Objekt nie Kennung oder
   * Zustand ueberschreibt. */
  updateHostSettings(hostId: string, settings: HostSettings): void {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    host.label = settings.label;
    host.hostname = settings.hostname;
    host.user = settings.user;
    host.port = settings.port;
    host.keyPath = settings.keyPath;
    host.authKind = settings.authKind;
    host.tmuxSocket = settings.tmuxSocket;
    host.historyLimit = settings.historyLimit;
    host.showDefaultSocket = settings.showDefaultSocket;
    this.#notify();
  }

  /** Klappt einen Host in der Seitenleiste auf oder zu. Anzeigezustand, aber
   * gespeichert (UX-Spec §7.1): darum ueber AppState und mit Benachrichtigung,
   * damit der Arbeitsplatz davon erfaehrt. */
  setHostExpanded(hostId: string, expanded: boolean): void {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host || host.expanded === expanded) return;
    host.expanded = expanded;
    this.#notify();
  }

  removeHost(hostId: string): void {
    for (const scope of this.#scopes(hostId)) {
      this.#sessionLists.delete(scope);
      this.#statusFreshness.delete(scope);
      this.#keptStatus.delete(scope);
    }
    this.#controls.delete(hostId);
    this.#controlSelfRepairs.delete(hostId);
    this.#hostReconnects.delete(hostId);
    this.#unsupportedDefault.delete(hostId);
    this.hosts = this.hosts.filter((h) => h.id !== hostId);
    // Nimmt jede Kachel des Hosts weg, auch wenn der Aufrufer sie nicht vorher
    // geschlossen hat (`onRemoveHost` in `main.ts` trennt zuerst und schliesst
    // sie dabei schon). Ueber eine Kopie, weil `splice` die Liste verkuerzt.
    // Fokus und Maximiert raeumt `#forgetTile` wie beim Schliessen.
    for (const tile of [...this.tiles]) {
      if (!tile.sessionKey.startsWith(`${hostId}/`)) continue;
      const position = this.tiles.indexOf(tile);
      this.tiles.splice(position, 1);
      this.#forgetTile(tile.id, position);
    }
    this.#notify();
  }

  /** Eine Session, deren Kachel geraeumt wird, ist weder offen noch
   * gesperrt -- der Kanal, auf den sich BEIDE Flags beziehen, existiert
   * danach nicht mehr (`grid.ts::reconcile` disposed den
   * `TerminalHandle`, sobald `sessionKey` faellt). Bliebe `inputLocked`
   * stehen, truege `setSessions` es durch jeden tmux-Poll weiter, also auch
   * ueber ein "Sessions neu laden" hinweg. Die Seitenleiste
   * (`sessionIndicator`) prueft `inputLocked` VOR `open` und zeigte dann
   * dauerhaft Dreieck + "Input locked" statt des hohlen Quadrats + "Closed",
   * das Designsystem §8.4 fuer eine geschlossene Session vorschreibt.
   *
   * Ueber `sessionKey()` und nicht per String-Zerlegung gesucht: der
   * Schluessel ist ausserhalb dieser Datei ein opaker Wert, sein Format
   * ("hostId/name") ist ein Implementierungsdetail von `sessionKey`. */
  #releaseSession(key: string): void {
    for (const h of this.hosts) {
      const session = h.sessions.find((s) => sessionKeyOf(s) === key);
      if (session) {
        session.open = false;
        session.inputLocked = false;
        return;
      }
    }
  }

  setHostState(hostId: string, state: HostState, error?: string | null, errorCode?: string | null): void {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    if (host.state !== state && state !== "connected") this.#invalidateSessionList(hostId);
    // Die Selbstreparatur gilt nur, solange die Terminalverbindung lebt.
    if (state !== "connected") this.#controlSelfRepairs.delete(hostId);
    // Das Neuverbinden umgekehrt nur, solange sie fehlt.
    if (state === "connected") this.#hostReconnects.delete(hostId);
    host.state = state;
    // Fehlt `error` im Aufruf (undefined), wird er auf null zurueckgesetzt,
    // NICHT stehen gelassen: sonst ueberlebt eine alte Fehlermeldung einen
    // Zustandswechsel weg von "failed" und die UI zeigt einen Fehler an, der
    // laengst nicht mehr gilt. Ein explizites `null` verhaelt sich gleich --
    // beide Faelle heissen "kein Fehler".
    host.error = error ?? null;
    // Der Code nach derselben Regel: ein Anmeldecode darf keinen spaeteren
    // Netzfehler ueberleben, sonst fragte die Hinweisleiste dort nach einem
    // Geheimnis.
    host.errorCode = errorCode ?? null;
    this.#notify();
  }

  /** Nimmt die SETTINGS-ID (wie jeder Mutator dieser Klasse) und legt die
   * Laufzeit-ID daneben -- siehe `Host.runtimeId`.
   *
   * Ein eigener Mutator statt `upsertHost`: das ersetzt das GANZE
   * Host-Objekt samt `sessions` (siehe dort), beim Wiederverbinden eines
   * Hosts mit bereits stehender Sessionliste waere das ein Verlust.
   *
   * `null` heisst "keine lebende Verbindung mehr" und wird ausschliesslich beim
   * ausdruecklichen Trennen gesetzt. Bei `failed` bleibt die alte ID bewusst
   * STEHEN: die Kachel soll mit ihrer Sperrleiste offen bleiben (siehe
   * `Host.runtimeId`), und erst der naechste ERFOLGREICHE Verbindungsaufbau
   * tauscht die ID -- was `grid.ts::reconcile` als "andere Verbindung" erkennt
   * und die Kachel neu montieren laesst. */
  setRuntimeId(hostId: string, runtimeId: string | null): void {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const isNewConnection = runtimeId !== null && runtimeId !== host.runtimeId;
    if (runtimeId !== host.runtimeId) this.#controls.delete(hostId);
    if (runtimeId !== host.runtimeId) this.#controlSelfRepairs.delete(hostId);
    if (runtimeId !== host.runtimeId) this.#invalidateSessionList(hostId);
    // Values of the previous connection are history until the new one lists.
    // Der ganze Host ist jetzt Geschichte; Einzelmarken waeren doppelt.
    if (runtimeId !== host.runtimeId) {
      for (const socket of ["app", "default"] as const) {
        this.#setStatusStale(hostId, socket);
        this.#keptStatus.delete(this.#scope(hostId, socket));
      }
    }
    host.runtimeId = runtimeId;
    // Eine FRISCHE Verbindung hebt die Eingabesperren dieses Hosts auf.
    // `inputLocked` gehoert zum KANAL, und jeder Kanal der alten Verbindung
    // ist mit ihrem Transport gestorben; `grid.ts::reconcile` montiert
    // daraufhin neue, funktionierende Terminals. Ohne diese Zeile stuenden
    // Sperrchip, 32-px-Streifen und "Reconnect" ueber einem Terminal, das
    // laengst wieder Eingaben annimmt -- das Spiegelbild des Fehlers, den
    // `#releaseSession` oben beschreibt, und ein Verstoss gegen
    // Designsystem §8.4 (kein Zustand, den die Anzeige nicht meint).
    //
    // Nur bei einer ANDEREN ID: ein `setRuntimeId` mit demselben Wert ist
    // keine neue Verbindung und darf eine gerade gesetzte Sperre nicht
    // wegwischen.
    if (isNewConnection) {
      for (const session of host.sessions) session.inputLocked = false;
    }
    this.#notify();
  }

  /** Status overlay only. Does not add, remove or rename sessions.
   *
   * Identity is server plus session id. tmux reuses session ids only in a
   * new server, so a row of another server never updates a bound session,
   * and an ended identity is never revived. Only a numeric result (every row
   * carries a session id) may end a session; the name-only fallback of an
   * unmeasured tmux version cannot. Names never bind a numeric status.
   *
   * `keepUnknown` (UX-Spec §5.2): eine Quelle dieser Abfrage fiel aus. Eine
   * Zeile `unknown` ueberschreibt dann keinen Live-Wert; der alte Wert bleibt
   * und gilt als veraltet (`keepStatusStale`). Jede andere Zeile ist eine
   * echte Beobachtung und hebt eine solche Markierung auf, auch wenn der Wert
   * gleich bleibt.
   *
   * `socket` (Spec 2026-10-25 §6.3): die Abfrage eines Sockets trifft nur
   * dessen Sessions, und nur dessen Frische. */
  patchSessionStatus(
    hostId: string,
    updates: Array<{
      name: string;
      sessionId: number | null;
      serverPid: number | null;
      serverStartTime: number | null;
      status: string | null;
      statusReason: string | null;
    }>,
    observedAt?: number,
    options: { keepUnknown?: boolean; socket?: SessionSocket } = {},
  ): void {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const socket = options.socket ?? "app";
    const numeric = updates.every((row) => row.sessionId != null);
    const servers = new Set(
      updates
        .filter((row) => row.serverPid != null && row.serverStartTime != null)
        .map((row) => `${row.serverPid}:${row.serverStartTime}`),
    );
    // One inventory has one server. Without a bound row it stays unknown.
    const resultServer = servers.size === 1 ? [...servers][0] : null;
    // "As of" eines festgehaltenen Werts ist die Beobachtung VOR dieser Abfrage.
    const previousObservedAt = this.statusFreshnessForHost(hostId, socket).observedAt;
    // A successful query is an observation even when no value changed.
    let changed = observedAt !== undefined && this.#markStatusObserved(hostId, observedAt, socket);
    const kept: string[] = [];
    const apply = (session: Session, status: string | null, reason: string | null): void => {
      if (this.#releaseKeptStatus(hostId, session.name, socket)) changed = true;
      if (session.status === status && session.statusReason === reason) return;
      session.status = status;
      session.statusReason = reason;
      changed = true;
    };
    const observe = (session: Session, update: { status: string | null; statusReason: string | null }): void => {
      if (options.keepUnknown && update.status === "unknown" && isLiveStatus(session.status)) kept.push(session.name);
      else apply(session, update.status, update.statusReason);
    };
    for (const session of host.sessions) {
      if (socketOf(session) !== socket) continue;
      if (session.sessionId == null) {
        const update = updates.find((row) => row.sessionId == null && row.name === session.name);
        if (update) observe(session, update);
        continue;
      }
      if (session.status === "ended" || !numeric) continue;
      const bound = session.serverPid != null && session.serverStartTime != null;
      if (bound && resultServer !== null && resultServer !== `${session.serverPid}:${session.serverStartTime}`) {
        apply(session, "ended", "tmux server was replaced");
        continue;
      }
      const update = updates.find((row) => row.sessionId === session.sessionId);
      if (!update) {
        apply(session, "ended", "bound session is absent from a complete inventory");
      } else if (!bound || resultServer !== null) {
        // A bound session whose server this result cannot name stays as is:
        // the same id could belong to a replacement server.
        observe(session, update);
      }
    }
    if (this.#keepStatus(hostId, kept, previousObservedAt, socket)) changed = true;
    if (changed) this.#notify();
  }

  /** Der Schalter "Show tmux sessions" ist aus (Spec 2026-10-25 §10.1): die
   * Sessions dieses Sockets fallen weg samt ihren Kacheln, und sein
   * Listenzustand gilt wieder als nie geladen. Gespeicherte Kacheln warten
   * dann weiter, statt als gelistet und fehlend verworfen zu werden.
   * Benachrichtigt nur, wenn es Sessions gab. */
  clearSocket(hostId: string, socket: SessionSocket): void {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const gone = host.sessions.filter((s) => socketOf(s) === socket);
    for (const session of gone) {
      const tile = this.tileForSession(sessionKeyOf(session));
      if (tile) this.closeTile(tile.id);
    }
    const scope = this.#scope(hostId, socket);
    this.#sessionLists.delete(scope);
    this.#statusFreshness.delete(scope);
    this.#keptStatus.delete(scope);
    if (gone.length === 0) return;
    host.sessions = host.sessions.filter((s) => socketOf(s) !== socket);
    this.#notify();
  }

  setSessions(hostId: string, names: string[]): void {
    this.setSessionRecords(hostId, names.map((name) => ({ name })));
  }

  /** Accepted inventory with optional numeric identity and status per name.
   * The fields are applied BEFORE the one notification, so every subscriber
   * (attention, tiles, terminal mount) sees the complete record. A field a
   * record leaves undefined keeps its previous value; `null` clears it.
   *
   * Je Socket (Spec 2026-10-25 §7): die Liste eines Sockets ersetzt nur
   * dessen Sessions und schliesst nur dessen verschwundene Kacheln. Die
   * eigenen stehen vor denen des Standard-Sockets. */
  setSessionRecords(
    hostId: string,
    records: Array<
      Pick<
        Session,
        | "name"
        | "sessionId"
        | "serverPid"
        | "serverStartTime"
        | "windowId"
        | "paneId"
        | "panePid"
        | "status"
        | "statusReason"
        | "unverified"
        | "attached"
      >
    >,
    observedAt?: number,
    socket: SessionSocket = "app",
  ): void {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const scope = this.#scope(hostId, socket);
    const names = records.map((record) => record.name);
    // A list that carries status is a status observation; the one
    // notification below also renders the ended staleness. It observes every
    // kept session anew as well.
    if (observedAt !== undefined) {
      this.#markStatusObserved(hostId, observedAt, socket);
      this.#keptStatus.delete(scope);
    }
    for (const name of this.#keptStatus.get(scope)?.keys() ?? []) {
      if (!names.includes(name)) this.#releaseKeptStatus(hostId, name, socket);
    }
    // This is an accepted inventory response, including a confirmed empty list.
    // It says nothing about input locks or the health of either SSH transport.
    this.#sessionLists.set(scope, { status: "current", lastSuccessAt: Date.now(), error: null });
    // Eine Kachel, deren Session vom Host verschwunden ist, wird zur
    // Sackgasse: `grid.ts::resolveSession` liefert `null`, der Kachelkopf
    // zeigt einen LEEREN Titel ueber einem toten Terminal, und
    // `requestClose` wie `requestReconnect` brechen beide bei `!resolved`
    // ab -- weder das Kreuz im Kopf noch die beiden Knoepfe der Sperrleiste
    // tun dann noch irgendetwas.
    //
    // Ueber `closeTile` geraeumt und nicht per Hand: dort haengen
    // `#releaseSession`, das Aufheben einer Maximierung DIESER Kachel und
    // das Raeumen des Fokus mit dran. Ein zweiter Aufraeumweg daneben waere
    // genau die Divergenz zwischen `open` und `inputLocked`, vor der
    // `#releaseSession`s Kommentar warnt.
    //
    // VOR dem Neuaufbau von `host.sessions`, damit `closeTile`s
    // `#releaseSession` die Session noch findet -- danach waere sie aus der
    // Liste und der Aufruf liefe wirkungslos durch.
    //
    // `closeTile` benachrichtigt selbst; die zusaetzlichen
    // Benachrichtigungen sind hingenommen. Sie kosten ein Neuzeichnen, das
    // ohnehin gleich faellig ist, und sie zu vermeiden hiesse, `closeTile`s
    // Rumpf hier zu duplizieren.
    const mine = host.sessions.filter((s) => socketOf(s) === socket);
    const vanished = mine.filter((s) => !names.includes(s.name));
    for (const gone of vanished) {
      const tile = this.tileForSession(sessionKeyOf(gone));
      if (tile) this.closeTile(tile.id);
    }
    // Abgleich gegen das, was das Backend gerade gemeldet hat: bestehende
    // Sessions behalten ihre Flags (offen/gesperrt), damit ein tmux-Poll
    // nicht laufend Kacheln zufaellt oder Sperren aufhebt. Neue Namen
    // kommen frisch (beides false) dazu, verschwundene fallen raus.
    const known = new Map(mine.map((s) => [s.name, s]));
    const listed: Session[] = names.map(
      (name) =>
        known.get(name) ?? {
          name,
          hostId,
          ...(socket === "default" ? { socket } : {}),
          open: false,
          inputLocked: false,
          sessionId: null,
          serverPid: null,
          serverStartTime: null,
          windowId: null,
          paneId: null,
          panePid: null,
          status: null,
          statusReason: null,
        },
    );
    const others = host.sessions.filter((s) => socketOf(s) !== socket);
    host.sessions = socket === "app" ? [...listed, ...others] : [...others, ...listed];
    const byName = new Map(records.map((record) => [record.name, record]));
    for (const session of listed) {
      const record = byName.get(session.name);
      if (!record) continue;
      // Only fields the record carries; `name` is equal by construction.
      for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) Object.assign(session, { [key]: value });
      }
    }
    this.#notify();
  }

  /** Spec 2026-10-19 §5.1: Klick in Spur oder Liste, Enter im Schnelloeffnen,
   * Strg+Umschalt+A und "New session". Steht die Session schon in einer
   * Kachel, bekommt diese den Fokus, und ein Maximieren einer ANDEREN endet.
   * Sonst kommt eine neue Kachel ans Ende, mit Fokus. An einer Grenze (§5.3)
   * aendert sich nichts; das Ergebnis sagt, welche erreicht ist. */
  openSession(hostId: string, name: string, socket: SessionSocket = "app"): OpenResult {
    const plan = planOpen(this.tiles, sessionKey(hostId, name, socket), hostId, (other) => this.#hostOfKey(other));
    return this.#applyPlan(plan, hostId, name, socket);
  }

  /** Strg+Klick in Spur oder Liste, Strg+Enter im Schnelloeffnen (Spec
   * 2026-10-19 §5.2): die Session kommt in die fokussierte Kachel, an deren
   * Platz; die alte laeuft in tmux weiter. Ohne fokussierte Kachel, oder ist
   * die Session schon offen, gilt dasselbe wie bei `openSession`. */
  replaceFocusedTile(hostId: string, name: string, socket: SessionSocket = "app"): OpenResult {
    const key = sessionKey(hostId, name, socket);
    const plan = planReplace(this.tiles, key, hostId, (other) => this.#hostOfKey(other), this.focusedTile);
    if (plan.kind !== "replace") return this.#applyPlan(plan, hostId, name, socket);
    const tile = this.tileById(plan.tileId)!;
    const previousKey = tile.sessionKey;
    tile.sessionKey = key;
    // Der Kanal der alten Session geht mit (`grid.ts::reconcile` montiert in
    // derselben Kachel neu), sie selbst laeuft weiter.
    this.#releaseSession(previousKey);
    this.#markOpened(hostId, name, socket);
    this.#endOtherMaximize(tile.id);
    this.#focus(tile.id);
    this.#notify();
    return { kind: "replaced", tileId: tile.id, previousKey };
  }

  /** Spec 2026-10-19 §5.1 Nr. 2-3: die Grenze, an der `openSession` fuer diese
   * Session scheitern wuerde, sonst `null` -- dieselbe Regel (`planOpen`),
   * ohne etwas zu aendern. `main.ts` fragt so, bevor ein Klick einen
   * getrennten Host verbindet. */
  openLimit(hostId: string, name: string, socket: SessionSocket = "app"): Extract<OpenResult, { kind: "limit" }> | null {
    const plan = planOpen(this.tiles, sessionKey(hostId, name, socket), hostId, (other) => this.#hostOfKey(other));
    return plan.kind === "limit" ? { kind: "limit", scope: plan.scope, hostId } : null;
  }

  /** Dasselbe fuer "New session" (Spec 2026-10-19 §5.1 Nr. 3): eine neue
   * Session steht in keiner Kachel, also zaehlen nur die beiden Grenzen aus
   * `planOpen`. `main.ts` fragt so, bevor der Dialog aufgeht -- sonst legte
   * tmux die Session an, und erst danach kaeme der Hinweis. */
  newSessionLimit(hostId: string): Extract<OpenResult, { kind: "limit" }> | null {
    const plan = planOpen(this.tiles, null, hostId, (other) => this.#hostOfKey(other));
    return plan.kind === "limit" ? { kind: "limit", scope: plan.scope, hostId } : null;
  }

  /** Fuehrt einen Plan aus `planOpen` aus (Spec §5.1, §5.3). */
  #applyPlan(plan: OpenPlan, hostId: string, name: string, socket: SessionSocket): OpenResult {
    if (plan.kind === "limit") return { kind: "limit", scope: plan.scope, hostId };
    if (plan.kind === "focus") {
      this.#endOtherMaximize(plan.tileId);
      this.#focus(plan.tileId);
      this.#notify();
      return { kind: "focused", tileId: plan.tileId };
    }
    const tile: Tile = { id: this.#nextTileId++, sessionKey: sessionKey(hostId, name, socket), lastFocusedAt: 0 };
    this.tiles.push(tile);
    this.maximizedTile = null;
    this.#markOpened(hostId, name, socket);
    this.#focus(tile.id);
    this.#notify();
    return { kind: "added", tileId: tile.id };
  }

  /** Legt gespeicherte Kacheln an, der Reihe nach, fuer den
   * wiederhergestellten Arbeitsplatz (Spec 2026-10-19 §4.6), und benachrichtigt
   * danach einmal: so montiert das Raster jede gleich mit ihrer Endgeometrie
   * und meldet diese Groesse mit `open_terminal` (§4.5), statt die frueheren
   * mit jeder weiteren neu zu vermessen. Beim Start kommen so die Kacheln
   * aller Hosts, auf die er wartet, in einem Zug (`WorkspaceSync.hostListed`).
   * Ohne Fokus: waehrend die Hosts nacheinander verbinden, tippt der Nutzer
   * womoeglich schon in einer anderen Kachel. Je Session nur, wenn sie in der
   * Liste ihres Hosts steht, in keiner Kachel liegt und keine Grenze erreicht
   * ist (`planOpen`, die schon angelegten mitgezaehlt). `place` nennt die
   * Position der neuen Kachel `id`, gefragt unmittelbar vor dem Einfuegen,
   * also mit den schon angelegten in `tiles`; mehr als das Ende wird es nicht.
   * Ohne neue Kachel keine Benachrichtigung. */
  restoreTiles<E extends { hostId: string; name: string; socket?: SessionSocket }>(
    entries: ReadonlyArray<E>,
    place: (entry: E, id: number) => number,
  ): void {
    let added = false;
    for (const entry of entries) {
      const { hostId, name } = entry;
      const socket = socketOf(entry);
      const session = this.#session(hostId, name, socket);
      if (!session || !isOpenable(session)) continue;
      const key = sessionKey(hostId, name, socket);
      const plan = planOpen(this.tiles, key, hostId, (other) => this.#hostOfKey(other));
      if (plan.kind !== "add") continue;
      const tile: Tile = { id: this.#nextTileId++, sessionKey: key, lastFocusedAt: 0 };
      const position = place(entry, tile.id);
      this.tiles.splice(Math.max(0, Math.min(position, this.tiles.length)), 0, tile);
      session.open = true;
      added = true;
    }
    if (added) this.#notify();
  }

  /** Schliesst eine Kachel (Spec 2026-10-19 §5.5): die Session laeuft in tmux
   * weiter, die folgenden Kacheln ruecken auf. */
  closeTile(id: number): void {
    const position = this.tilePosition(id);
    if (position === null) return;
    const [tile] = this.tiles.splice(position, 1);
    this.#releaseSession(tile.sessionKey);
    this.#forgetTile(id, position);
    this.#notify();
  }

  /** Nach dem Entfernen einer Kachel: ein Maximieren dieser Kachel endet --
   * sonst zeigte das Raster eine leere Flaeche ohne Rueckweg --, und der
   * Fokus geht an die Kachel, die jetzt an ihrer Position steht, sonst an die
   * vorige (§5.5). */
  #forgetTile(id: number, position: number): void {
    if (this.maximizedTile === id) this.maximizedTile = null;
    if (this.#lastOccupiedFocus?.id === id) this.#lastOccupiedFocus = null;
    if (this.focusedTile !== id) return;
    this.focusedTile = null;
    const neighbor = this.tiles[position] ?? this.tiles[position - 1];
    if (neighbor) this.#focus(neighbor.id);
  }

  /** Nur der Fokus: der Weg von `focusin` und vom Klick auf den Kachelkopf. */
  focusTile(id: number): void {
    if (!this.tileById(id)) return;
    this.#focus(id);
    this.#notify();
  }

  /** Strg+Umschalt+1-9 (Spec 2026-10-19 §5.7): die Kachel an `position`. Ein
   * Maximieren einer anderen endet, sonst bliebe die gewaehlte unsichtbar.
   * Liefert, ob es die Kachel gibt. */
  focusTileAt(position: number): boolean {
    const tile = this.tiles[position];
    if (!tile) return false;
    this.#endOtherMaximize(tile.id);
    this.#focus(tile.id);
    this.#notify();
    return true;
  }

  /** Strg+Umschalt+Hoch/Runter (§5.7): Fokus zur vorigen oder naechsten
   * Kachel, mit Umlauf; ohne Fokus faengt Runter vorn an und Hoch hinten. */
  focusAdjacentTile(delta: 1 | -1): boolean {
    const count = this.tiles.length;
    if (count === 0) return false;
    const current = this.focusedTile === null ? null : this.tilePosition(this.focusedTile);
    const next = current === null ? (delta === 1 ? 0 : count - 1) : (current + delta + count) % count;
    return this.focusTileAt(next);
  }

  /** Spec 2026-10-19 §5.4: tauscht die Positionen zweier Kacheln. Ids, Fokus
   * und Maximieren bleiben; nur die Reihenfolge aendert sich. */
  swapTiles(a: number, b: number): void {
    const from = this.tilePosition(a);
    const to = this.tilePosition(b);
    if (from === null || to === null || from === to) return;
    [this.tiles[from], this.tiles[to]] = [this.tiles[to], this.tiles[from]];
    this.#notify();
  }

  /** Strg+Umschalt+Bild auf/ab (§5.4): eine Position nach vorn oder hinten,
   * ohne Umlauf. Liefert die neue Position, am Rand `null`. */
  moveTile(id: number, delta: 1 | -1): number | null {
    const from = this.tilePosition(id);
    if (from === null) return null;
    const other = this.tiles[from + delta];
    if (!other) return null;
    this.swapTiles(id, other.id);
    return from + delta;
  }

  /** Fokus mit frischem Zeitstempel; die Kachel wird die Merkstelle fuer
   * Strg+Umschalt+N (`#lastOccupiedFocus`). */
  #focus(id: number): void {
    const tile = this.tileById(id);
    if (!tile) return;
    this.focusedTile = id;
    tile.lastFocusedAt = ++this.#clock;
    this.#lastOccupiedFocus = { id, key: tile.sessionKey };
  }

  #endOtherMaximize(id: number): void {
    if (this.maximizedTile !== null && this.maximizedTile !== id) this.maximizedTile = null;
  }

  /** Die Session einer NEUEN Kachel bekommt einen frischen Kanal: offen, und
   * eine Sperre aus einem frueheren Kanal gilt nicht mehr. Wer eine schon
   * gezeigte Session waehlt, ersetzt keinen Kanal; dort bleibt die
   * Sperrleiste mit "Reconnect" stehen. */
  #markOpened(hostId: string, name: string, socket: SessionSocket): void {
    const session = this.#session(hostId, name, socket);
    if (!session) return;
    session.open = true;
    session.inputLocked = false;
  }

  /** Die zuletzt fokussierte Kachel (UX-Spec §7.9, Schritt 2), solange sie
   * noch dieselbe Session zeigt; sonst `null`. */
  lastFocusedOccupiedTile(): number | null {
    const memory = this.#lastOccupiedFocus;
    if (memory === null || this.tileById(memory.id)?.sessionKey !== memory.key) return null;
    return memory.id;
  }

  toggleMaximize(id: number): void {
    if (!this.tileById(id)) return;
    // Erneuter Aufruf mit derselben Kachel hebt die Maximierung wieder auf;
    // die Reihenfolge der Kacheln bleibt unberuehrt.
    this.maximizedTile = this.maximizedTile === id ? null : id;
    this.#notify();
  }

  /** Sperrt die Eingabe fuer EINE Session -- gerufen aus `main.ts`, wenn ein
   * Kanal stirbt (`terminal://connection-lost`) oder ein `open_terminal` gar
   * nicht erst aufgeht.
   *
   * Fruehausstieg statt bedingungsloser Benachrichtigung: beide Aufrufer
   * koennen mehrfach fuer dieselbe, bereits gesperrte Session feuern (ein
   * Transportabriss meldet jeden Kanal einzeln; ein erneutes Oeffnen
   * derselben toten Session scheitert erneut). Ein Mutator, der ohne
   * Aenderung benachrichtigt, kostet ein vollstaendiges Neuzeichnen fuer
   * nichts.
   *
   * Die Gegenrichtung liegt NICHT hier, sondern in `applyInputLocks`: das
   * Loesen haengt daran, ob eine Kachel gerade einen frischen Kanal bekommt,
   * und das weiss nur das Raster (`grid.ts`: `reconcile`, `requestReconnect`). */
  lockInput(hostId: string, name: string, socket: SessionSocket = "app"): void {
    const session = this.#session(hostId, name, socket);
    if (!session || session.inputLocked) return;
    session.inputLocked = true;
    this.#notify();
  }

  /** Gleicht die Sperren in BEIDE Richtungen mit der Wirklichkeit ab, in
   * einem Durchgang und mit hoechstens EINER Benachrichtigung.
   *
   * Die Aufrufer sitzen im Raster, denn nur dort steht die noetige Auskunft:
   * `inputLocked` gehoert zum KANAL, und ob eine Kachel gerade einen frischen
   * Kanal bekommt -- oder ob sie umgekehrt gar keinen bekommen KANN --,
   * entscheidet `grid.ts`. `render` ruft dies als allerletzte Anweisung eines
   * Neuzeichnens (dort steht die Begruendung fuer die Stelle);
   * `requestReconnect` loest die Sperre seiner Kachel unmittelbar bevor es
   * ihr einen frischen Kanal montiert (Spec 2026-10-19 §5.8), damit das
   * Terminal ohne Sperrleiste misst.
   *
   * `lock` und `release` in einem Aufruf statt zwei Mutatoren: sonst
   * benachrichtigten zwei aufeinanderfolgende Aufrufe zweimal, und der
   * verschachtelte Renderdurchgang des ersten saehe einen halb abgeglichenen
   * Zustand.
   *
   * Benachrichtigt NUR bei tatsaechlicher Aenderung. Das ist keine
   * Sparsamkeit, sondern Abbruchbedingung: der Aufruf aus `render` steht IN
   * einem Neuzeichnen, ein bedingungsloses `#notify()` waere eine
   * Endlosrekursion.
   *
   * Schluessel statt `hostId`/`name`-Paaren: zwei Hosts duerfen gleichnamige
   * tmux-Sessions haben (Spec §4.3), `sessionKey` ist die Unterscheidung. */
  applyInputLocks(lock: string[], release: string[]): void {
    let changed = false;
    for (const host of this.hosts) {
      for (const session of host.sessions) {
        const key = sessionKeyOf(session);
        const want = lock.includes(key) ? true : release.includes(key) ? false : session.inputLocked;
        if (want !== session.inputLocked) {
          session.inputLocked = want;
          changed = true;
        }
      }
    }
    if (changed) this.#notify();
  }
}
