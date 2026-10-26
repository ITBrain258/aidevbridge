// Kachelraster: rechter Hauptbereich mit bis zu neun Kacheln, die sich nach
// ihrer Zahl selbst anordnen (Spec 2026-10-19 §4), und Maximieren. Jede
// Kachel hat eine feste `id`; dieses Modul fuehrt alles je `id` (`views`
// unten), legt die Kacheln absolut nach `layoutTiles` und mountet
// `TerminalHandle`s nur fuer sichtbare Kacheln; eine verborgene behaelt ihren
// (Spec 2026-10-19 §8.1, Schritt 3). `state.tiles` ruehrt es nie an --
// welche Session wohin kommt, entscheiden `AppState` und `tile-assignment.ts`.
//
// Drei Punkte, die dieses Modul falsch machen KANN, ohne dass ein Test
// sofort rot wird:
//  1. Ein sichtbar bleibendes Terminal darf NIE erneut gemountet werden --
//     auch nicht, wenn sich seine Position aendert. `dispose()` schliesst den
//     PTY-Kanal (`terminal.ts`), ein Remount waere ein frischer `tmux attach`
//     mit vollem Repaint fuer nichts.
//  2. Eine Kachel, die verborgen wird (Maximieren einer ANDEREN), behaelt
//     ihren TerminalHandle samt Kanal und WebGL-Kontext; `setHidden` haelt nur
//     das Messen an. Zurueckholen schliesst nichts und oeffnet nur, was
//     inzwischen keinen lebenden Kanal mehr hat (Neuverbinden des Hosts,
//     abgerissener Kanal; Spec 2026-10-19 §8.1, §10.2): Entsorgen und
//     Neumontieren braeuchte mit N Kacheln eines Hosts bis zu 2N - 1 Kanaele,
//     mit acht also 15 gegen acht PTY-Plaetze je Verbindung.
//  3. Jede Aenderung, die die Pixelgroesse einer Kachel aendert, laeuft ueber
//     GENAU EINEN entprellten Pfad: `TerminalHandle.refit()` (`terminal.ts`)
//     -- niemals ein zweiter, eigener Entpreller hier und niemals ein
//     direkter `resize_terminal`-Aufruf (Designsystem §5.5).

import {
  AppState,
  sessionKey,
  sessionKeyOf,
  socketOf,
  type HostState,
  type SessionSocket,
} from "../state/app-state";
import { mountTerminal, type TerminalErrorKind, type TerminalHandle } from "../terminal";
import { createOpenQueue } from "../terminal-open-queue";
import type { ThemeId } from "../theme";
import { icon, type IconName } from "../icons";
import { DEFAULT_KEYMAP, type KeymapAction } from "../keymap";
import { titleWithShortcut } from "./shortcut-title";
import { agentStatusView, buildStatusPill } from "./status-pill";
import type { TerminalMenuTexts } from "./terminal-menu";
import type { TerminalSearchTexts } from "./terminal-search";
import { createTileReattach, type TileReattach } from "./tile-reattach";
import {
  EQUAL_FRACTIONS,
  MIN_TILE_HEIGHT,
  MIN_TILE_WIDTH,
  equalShares,
  layoutTiles,
  moveBoundary,
  rowCounts,
  spaceFor,
  type Rect,
  type Split,
  type TileFractions,
} from "./tile-layout";
import { trackPointerDrag } from "./tile-drag";
import { t } from "../i18n/t";
import type { TranslationKey } from "../i18n/t";

export interface GridOptions {
  /** Ein Fehler eines Terminals: `text` ist der Satz fuer seine Art (UX-Spec
   * §6.9, §10), `detail` der Rohtext der Ursache fuer "Copy details". */
  onTerminalError: (text: string, detail: string) => void;
  /** Alle Rueckrufe zu einer Session nennen zuletzt ihren Socket (Spec
   * 2026-10-25 §5): gleichnamige Sessions beider Sockets sind verschiedene. */
  onCloseTerminal: (hostId: string, name: string, socket: SessionSocket) => void;
  /** Eine ausgefallene Hostverbindung wieder aufbauen; Anmeldung lebt in main.ts. */
  onReconnectHost: (hostId: string) => void;
  /** Nachtrag B, Punkt 2 (Design §11.2): "New session" aus dem Leerzustand
   * der Rasterflaeche. Den Host waehlt main.ts mit derselben Zielhost-Kette
   * wie Strg+Umschalt+N (UX-Spec §7.9) -- sonst stimmte der Tooltip "New
   * session (Ctrl+Shift+N)" am Knopf nicht. Diese Datei entscheidet weder den
   * Host noch, was der Klick bewirkt. */
  onNewSession: () => void;
  /** Ein Terminalkanal endete, ohne dass ihn jemand geschlossen hat
   * (`terminal://connection-lost`). Die Sperre setzt diese Datei nicht
   * selbst -- sie meldet den Verlust; daran haengt eine Rueckfrage beim Host,
   * und Backend-Aufrufe leben in main.ts.
   *
   * `reattaching`: die Verbindung des Hosts lebt, und die Kachel haengt sich
   * still neu an (UX-Spec §5.5). Dann zeigt sie "Reconnecting…" und darf
   * nicht gesperrt werden; scheitert die Reihe, meldet sie das ueber
   * `onTerminalOpenFailed`. */
  onConnectionLost: (hostId: string, name: string, reattaching: boolean, socket: SessionSocket) => void;
  /** `open_terminal` wurde abgelehnt -- dieser Kanal ist gar nicht erst
   * entstanden. Getrennt von `onTerminalError`, weil dort auch eine
   * abgelehnte Zwischenablage und ein fehlgeschlagenes `resize_terminal`
   * landen (siehe `MountOptions.onOpenFailed`); der Aufrufer sperrt daraufhin
   * die Eingabe, und das darf ein Ctrl+Shift+V nicht ausloesen. Diese Datei
   * entscheidet daraus wieder NICHTS -- sie meldet es, wie bei
   * `onConnectionLost`. */
  onTerminalOpenFailed: (hostId: string, name: string, socket: SessionSocket) => void;
  /** Spec 2026-10-19 §8.3: das allererste `open_terminal` einer frisch
   * geoeffneten Kachel scheiterte an einer Kanalgrenze. Statt `onTerminalError`
   * und `onTerminalOpenFailed`; `detail` ist der Rohtext fuer "Copy details".
   * Jede andere Kachel bleibt und meldet den Satz ueber `onTerminalError` samt
   * Sperre (Spec §1 Nr. 1): eine, die schon einen Kanal hatte, die beim
   * Montieren schon gesperrt war oder die der Nutzer mit "Reconnect" neu
   * anhaengen liess. Ein stilles Wiederanhaengen meldet das nicht (seine Reihe
   * entscheidet). */
  onTerminalCapacity: (hostId: string, name: string, detail: string, socket: SessionSocket) => void;
}

export interface GridHandle {
  dispose(): void;
  /** Der EINE entprellte Refit-Pfad (Designsystem §5.5) fuer alles, was diese
   * Datei selbst nicht ausloest -- vor allem das Ziehen der Seitenleiste
   * (Shell-Task 11): der Ziehgriff committet auf `pointerup`, ruft danach
   * dies hier. Ruft die Lage neu und `TerminalHandle.refit()` auf jeder
   * sichtbaren Kachel auf -- der eigentliche Entpreller lebt in `terminal.ts`,
   * nicht hier (ein zweiter eigener Timer waere der zweite Pfad, den §5.5
   * verbietet). */
  refit(): void;
  /** Nur die Lage neu, ohne ein Terminal zu vermessen: `main.ts` ruft sie,
   * solange die Seitenleiste gezogen wird (`SidebarResizeOptions.onInput`,
   * Spec 2026-10-19 §4.5); vermessen wird einmal beim Loslassen ueber
   * `refit`. */
  relayout(): void;
  /** Legt den Tastaturfokus in das Terminal der aktuell fokussierten Kachel
   * (Designsystem §7.5). Wirkungslos, wenn keine Kachel fokussiert ist, die
   * fokussierte gerade unsichtbar ist oder in ihr kein Terminal montiert ist.
   *
   * Der Aufrufer entscheidet WANN -- und das ist der ganze Auftrag: gerufen
   * wird nur aus einer BENUTZERABSICHT heraus (`main.ts`: Sessionwahl,
   * Maximieren, eine frisch angelegte Session), NIE aus `render()`,
   * `reconcile()` oder dem Abonnenten. Der vierte Fokusweg liegt in dieser
   * Datei selbst und braucht diesen Einstieg nicht: `requestReconnect`
   * fokussiert seinen frischen Handle direkt, aus demselben Grund. Die eine
   * Ausnahme in `reconcile` nimmt keinen Fokus, sie haelt ihn: lag er im
   * Terminal einer Kachel, das gerade entsorgt wird, bekommt ihn das frische
   * Terminal derselben Kachel (stilles Wiederanhaengen, neue Verbindung). Ein Fokusaufruf im Neuzeichnen
   * bestuende zwar jede naive Zusicherung ("nach Ctrl+Shift+2 hat Terminal B
   * den Fokus") und risse dem Nutzer trotzdem bei jeder im Hintergrund
   * eintreffenden Sessionliste den Cursor aus der Seitenleiste. Dasselbe
   * Vokabular wie das `takeFocus`-Flag der Roving-Umsetzungen
   * (`sidebar.ts`, `directory-tree.ts`): der Fokuswunsch reist mit der
   * Aktion, nicht mit dem Zustand. Ein Kachelziel setzt er nicht (UX-Spec
   * §7.4): das `focusin` des Terminals ist nur ein Fokuswechsel. */
  focusActiveTile(): void;
  /** Spec §12.2: reicht das Thema an jede gemountete Kachel durch. Kein fit(),
   * kein resize_terminal -- xterm zeichnet nur den sichtbaren Schirm neu. */
  applyTerminalTheme(theme: ThemeId): void;
  /** UX-Spec §6.7: reicht die Schriftgroesse an jede gemountete Kachel durch.
   * Anders als das Thema aendert sie Spalten und Zeilen; jede Kachel passt sich
   * deshalb selbst ueber ihren entprellten Pfad an (`TerminalHandle.setFontSize`),
   * hier gibt es keinen zweiten Timer. Eine spaeter gemountete Kachel liest die
   * Groesse beim Bau aus `terminal-prefs`. */
  applyTerminalFontSize(size: number): void;
  /** Spec 2026-10-19 §5.4: schiebt die fokussierte Kachel eine Position nach
   * vorn (-1) oder hinten (1); die Live-Region sagt es an. Der Tastaturfokus
   * bleibt im Terminal: sein Knoten bewegt sich nicht. */
  moveFocusedTile(delta: 1 | -1): void;
  /** Spec 2026-10-19 §6.2: macht eine gewaehlte Kachel wiederfindbar. Gerufen
   * nur aus einer Benutzerabsicht (Wahl einer Session, Strg+Umschalt+1-9,
   * Hoch/Runter), nie aus `render`; ein Klick in eine Kachel loest es nicht
   * aus. */
  revealTile(id: number): void;
}

/** UX-Spec §6.1: so lange steht der Chip "Copied" im Kachelkopf. */
const COPIED_CHIP_MS = 1200;

/** Spec 2026-10-19 §5.4: erst ab so viel Bewegung wird ein Druck auf den
 * Kachelkopf ein Zug; darunter bleibt er ein Klick. */
const HEAD_DRAG_THRESHOLD = 4;

/** Spec 2026-10-19 §6.3: so lange leuchtet die Kontur beim Wiederfinden. */
const FLASH_MS = 600;

/** Spec 2026-10-19 §8.4: darunter gilt eine Kachel als schmal. */
const NARROW_COLS = 80;
const NARROW_ROWS = 20;

/** Feste Tasten der Zwischenablage (UX-Spec §8.3): sie stehen nicht in
 * `DEFAULT_KEYMAP`, weil sie ohne Umschalt gelten (`terminal-clipboard.ts`) --
 * wie die Esc-Zeile der Shortcuts-Seite. */
const CLIPBOARD_COPY_KEY = "Ctrl+C";
const CLIPBOARD_PASTE_KEY = "Ctrl+V";

/** UX-Spec §6.9, §10: der Satz fuer jeden Fehlerpfad des Terminals.
 * `terminal.ts` meldet nur die Art; Texte und Sessionname kennt diese Datei. */
function terminalErrorText(kind: TerminalErrorKind, session: string): string {
  switch (kind) {
    case "open":
      return t("terminal.openFailed", { session });
    case "copy":
      return t("terminal.copyFailed");
    case "paste":
      return t("terminal.pasteFailed");
    case "input":
      return t("terminal.inputFailed", { session });
    case "resize":
      return t("terminal.resizeFailed", { session });
  }
}

/** Spec 2026-10-19 §8.3: die Rohtexte der Kanalgrenzen, wie das Frontend sie
 * sieht (`open_terminal` liefert `Result<(), String>`): Oeffnungen je Host
 * (commands.rs), schliessende Pumpen (connection.rs), Exec- und PTY-Kanaele
 * (owned_operations.rs). Backend-Tests legen den Wortlaut aller vier fest
 * (`terminal_ownership_tests.rs`, `connection/tests.rs`, `operation_control.rs`,
 * `operation_tests.rs`); aendert er sich trotzdem, faellt die Meldung auf den
 * allgemeinen Satz zurueck. */
const CAPACITY_ERRORS = [
  "too many terminal setups are already pending for this host",
  "too many terminal output tasks are still closing",
  "The SSH command failed (admission, capacity).",
  "Terminal operation failed during Admission: Capacity",
];

export function isCapacityError(detail: string): boolean {
  return CAPACITY_ERRORS.some((text) => detail.includes(text));
}

/** Texte und Kuerzel des Terminalmenues (UX-Spec §6.3). `terminal.ts` kennt
 * weder `en.json` noch eine Kuerzeltabelle und bekommt alles von hier: die
 * Kuerzel fuer Suchen und die festen Tasten mit Umschalt kommen aus der
 * Tabelle, Strg+C und Strg+V sind die festen Tasten oben. */
function terminalMenuTexts(): TerminalMenuTexts {
  return {
    items: {
      copy: { label: t("terminalMenu.copy"), shortcut: CLIPBOARD_COPY_KEY },
      paste: { label: t("terminalMenu.paste"), shortcut: CLIPBOARD_PASTE_KEY },
      selectAll: { label: t("terminalMenu.selectAll") },
      find: { label: t("terminalMenu.find"), shortcut: DEFAULT_KEYMAP["search.local"] },
      moveEarlier: { label: t("terminalMenu.moveEarlier"), shortcut: DEFAULT_KEYMAP["tile.moveEarlier"] },
      moveLater: { label: t("terminalMenu.moveLater"), shortcut: DEFAULT_KEYMAP["tile.moveLater"] },
    },
    fixedShortcuts: {
      copy: DEFAULT_KEYMAP["clipboard.copy"],
      paste: DEFAULT_KEYMAP["clipboard.paste"],
    },
    mouseHint: t("terminalMenu.mouseHint"),
  };
}

/** Texte der Suchleiste (UX-Spec §6.6). `terminal.ts` kennt weder `en.json` noch
 * die Platzhalterersetzung und bekommt alles fertig von hier; den Zaehler als
 * Funktion, damit die Vorlage `{current}/{total}` durch `t` geht wie jede
 * andere. */
function terminalSearchTexts(): TerminalSearchTexts {
  return {
    placeholder: t("terminal.search.placeholder"),
    count: (current, total) =>
      t("terminal.search.count", { current: String(current), total: String(total) }),
    none: t("terminal.search.none"),
    prev: t("terminal.search.prev"),
    next: t("terminal.search.next"),
    matchCase: t("terminal.search.matchCase"),
    close: t("terminal.search.close"),
  };
}

interface ResolvedSession {
  /** Die `settings.toml`-ID -- geht an die Rueckrufe zurueck, die in
   * `main.ts`/`app-state.ts` landen (`AppState` denkt ausschliesslich in
   * diesem Raum, siehe `Host.runtimeId`). */
  hostId: string;
  /** Die Laufzeit-ID derselben Verbindung, oder `null`, wenn dieser Host
   * gerade keine hat. Geht an `mountTerminal`, weil JEDER Aufruf dort eine
   * lebende Verbindung meint -- und sie ist zugleich das Merkmal, an dem
   * `reconcile` erkennt, dass eine Kachel an einer ANDEREN Verbindung haengt
   * als der aktuellen. */
  runtimeHostId: string | null;
  /** Der Zustand dieses Hosts, aus derselben Quelle wie `runtimeHostId` --
   * kein zweiter Suchlauf.
   *
   * `reconcile` montiert nur bei `connected`. Eine Laufzeit-ID allein reicht
   * nicht: bei `failed` bleibt die alte ID ABSICHTLICH stehen (Zusage aus
   * Paket 1, siehe `Host.runtimeId`), eine Kachel ohne Terminal -- etwa eine
   * verborgene, deren Kanal mit der vorigen Verbindung ging -- montierte beim
   * Zurueckholen sonst gegen eine TOTE Verbindung.
   *
   * VERBOT, ausgesprochen statt vorausgesetzt: dieses Feld beeinflusst
   * AUSSCHLIESSLICH die Montagebedingung -- nie den zweiteiligen Early-Out
   * in `reconcile`, nie `mountedKey`/`mountedRuntimeId`. Geriete es in den
   * Vergleich, waere die Folge unmittelbar zerstoererisch: `onConnectHost`
   * setzt `setHostState(..., "connecting")` VOR dem `connect_host`-Aufruf --
   * ein Druck auf "Retry" entsorgte dann sofort jede Kachel dieses Hosts,
   * samt der letzten sichtbaren Ausgabe, fuer die die Sperrleiste ueberhaupt
   * existiert. */
  hostState: HostState;
  /** UX-Spec §5.4: der Host wird gerade neu verbunden. Seine Kacheln zeigen
   * dann "Reconnecting…" statt der Sperrleiste. */
  hostReconnecting: boolean;
  name: string;
  /** Spec 2026-10-25 §5: der Socket der Session, fuer Montage und Rueckrufe. */
  socket: SessionSocket;
  hostLabel: string;
  /** Nachtrag B, Punkt 3: `updateTileHead` braucht dieses Feld, um die
   * Sperrleiste zu zeigen -- ueber denselben Aufloeser wie Titel/Hostname,
   * statt eines zweiten Suchlaufs durch `state.hosts`. */
  inputLocked: boolean;
  sessionId: number | null;
  serverPid: number | null;
  serverStartTime: number | null;
  windowId: number | null;
  paneId: number | null;
  panePid: number | null;
  status: string | null;
  statusReason: string | null;
}

/** Die numerische Identitaet, mit der eine Kachel montiert wurde. */
interface BoundIdentity {
  sessionId: number;
  serverPid: number | null;
  serverStartTime: number | null;
}

function boundIdentity(session: ResolvedSession): BoundIdentity | null {
  return session.sessionId === null
    ? null
    : { sessionId: session.sessionId, serverPid: session.serverPid, serverStartTime: session.serverStartTime };
}

/** Steht unter dem Namen inzwischen eine andere Session -- eine andere ID
 * oder ein anderer tmux-Server? Der Name ist nie Identitaet (MVP-Spec,
 * Nachtrag 2026-09-13): eine Neuanlage gleichen Namens ist eine neue
 * Session, die alte ist beendet. Ohne numerische Bindung auf einer der
 * beiden Seiten laesst sich das nicht sagen. */
function replacedSince(identity: BoundIdentity | null, now: ResolvedSession): boolean {
  if (identity === null || now.sessionId === null) return false;
  if (now.sessionId !== identity.sessionId) return true;
  const servers = [identity.serverPid, identity.serverStartTime, now.serverPid, now.serverStartTime];
  return (
    servers.every((value) => value !== null) &&
    (now.serverPid !== identity.serverPid || now.serverStartTime !== identity.serverStartTime)
  );
}

/** Ueber `sessionKey()` verglichen, nicht per String-Zerlegung -- der
 * Schluessel ist ausserhalb von `app-state.ts` ein opaker Wert (dasselbe
 * Muster wie `AppState.closeTile`). */
function resolveSession(state: AppState, key: string): ResolvedSession | null {
  for (const host of state.hosts) {
    const session = host.sessions.find((s) => sessionKeyOf(s) === key);
    if (session) {
      return {
        hostId: host.id,
        runtimeHostId: host.runtimeId,
        hostState: host.state,
        hostReconnecting: host.state !== "connected" && state.isHostReconnecting(host.id),
        name: session.name,
        socket: socketOf(session),
        hostLabel: host.label,
        inputLocked: session.inputLocked,
        sessionId: session.sessionId ?? null,
        serverPid: session.serverPid ?? null,
        serverStartTime: session.serverStartTime ?? null,
        windowId: session.windowId ?? null,
        paneId: session.paneId ?? null,
        panePid: session.panePid ?? null,
        status: session.status ?? null,
        statusReason: session.statusReason ?? null,
      };
    }
  }
  return null;
}

interface TileRefs {
  root: HTMLDivElement;
  head: HTMLDivElement;
  badge: HTMLSpanElement;
  focusedFlag: HTMLSpanElement;
  title: HTMLSpanElement;
  host: HTMLSpanElement;
  /** Spec 2026-10-25 §7: "tmux" neben dem Host bei einer Session des
   * Standard-Sockets; im schmalen Kopf bleibt nur das Symbol. */
  tmuxMark: HTMLSpanElement;
  /** Nachtrag B, Punkt 3 (Designsystem §8.3, Punkt 1): Warndreieck + Text
   * rechts im Kachelkopf, neben den Kopf-Schaltflaechen. */
  lockChip: HTMLSpanElement;
  /** UX-Spec §5.4, §5.5: der ruhige Hinweis "Reconnecting…" mit Drehsymbol,
   * an der Stelle von `lockChip` und STATT der Sperrleiste. Er sitzt im Kopf,
   * damit sein Kommen und Gehen die Terminalgroesse nicht aendert: ein
   * Resize direkt nach dem Wiederanhaengen kostete einen inline rendernden
   * Agenten den Verlauf (V12) und verschoebe den gerade gelieferten Verlauf
   * (§5.6). */
  quietChip: HTMLSpanElement;
  /** Sein Text: "Reconnecting…" oder, solange das Terminal auf einen Platz
   * wartet, "Opening…" (Spec 2026-10-19 §8.1, `updateTileHead`). */
  quietText: HTMLSpanElement;
  /** UX-Spec §6.1: Haekchen + "Copied" nach jedem Kopieren, links vom
   * `lockChip`. Leer, solange nichts anzuzeigen ist (`showCopied`). */
  copiedChip: HTMLSpanElement;
  /** Spec 2026-10-19 §8.4: "{cols}×{rows} · narrow" im Kopf. */
  narrowChip: HTMLSpanElement;
  /** Sein Text, der in einer schmalen Kachel kuerzt (`chipText`). */
  narrowText: HTMLSpanElement;
  /** UI v2 8.2: der Agentenplatz zwischen Titel und Host (M1.2-Pille). */
  agentSlot: HTMLSpanElement;
  maximizeBtn: HTMLButtonElement;
  /** Spec 8.2: der Icon-Kasten, dessen Inhalt zwischen `maximize-2` und
   * `minimize-2` wechselt (`swapIcon`) -- frueher eine Textglyphe. */
  maximizeIcon: HTMLSpanElement;
  maximizeLabel: Text;
  closeBtn: HTMLButtonElement;
  /** Nachtrag B, Punkt 3 (Designsystem §8.3, Punkt 2): der 32-px-Streifen
   * zwischen Kopf und Terminal-Viewport. */
  lockStrip: HTMLDivElement;
  /** Die Meldungszeile der Leiste: fettes "Disconnected" plus `lockMessage`.
   * Sie kuerzt in einer schmalen Kachel und traegt dafuer ihren vollen Text
   * als Tooltip (Abnahme B5). */
  lockText: HTMLSpanElement;
  lockMessage: Text;
  /** Fehlt bei einer beendeten Session: dort gibt es nichts mehr anzuhaengen
   * (UX-Spec §5.5). */
  lockReconnectBtn: HTMLButtonElement;
  terminal: HTMLDivElement;
}

/** Tastenhinweis als Chip: <kbd>Ctrl+Shift+N</kbd> plus Wort (Spec 8.1, 10).
 *
 * `wrap` ist der TRAEGER des Chips, nicht bloss ein Vorgabewert: im
 * Leerzustand das `<li>` selbst, ohne Angabe ein eigenes `<span>`. Die
 * Schnittstelle verlangt dort `li > kbd + span` -- eine
 * zusaetzliche Huelle im `<li>` waere der erste `span`-Nachfahre und damit
 * genau das, was ein `li.querySelector("span")` faende: die Huelle mit
 * Kuerzel UND Wort statt des Wortes allein. */
function keyHint(
  action: KeymapAction,
  wordKey: TranslationKey,
  wrap: HTMLElement = document.createElement("span"),
): HTMLElement {
  wrap.classList.add("key-hint");
  const kbd = document.createElement("kbd");
  kbd.textContent = DEFAULT_KEYMAP[action];
  wrap.appendChild(kbd);
  const word = document.createElement("span");
  word.textContent = t(wordKey);
  wrap.appendChild(word);
  return wrap;
}

/** Der Text eines Kopfchips (Abnahme B4): in eigenem Element, denn
 * `text-overflow` wirkt nur in einem Blockcontainer. Direkt im Flex-Chip waere
 * der Text ein anonymes Element und wuerde in einer schmalen Kachel bloss
 * abgeschnitten statt mit Ellipse gekuerzt (styles.css, `.tile-chip-text`). */
function chipText(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "tile-chip-text";
  span.textContent = text;
  return span;
}

/** Icon im 16er-Kasten mit `data-icon` fuer Tests und Wechsel. Dasselbe
 * Muster wie der Aufklapppfeil der Seitenleiste: das SVG selbst traegt nur
 * Pfade, der Name gehoert deshalb als Datenattribut daneben. */
function iconBox(name: IconName, size = 16): HTMLSpanElement {
  const box = document.createElement("span");
  box.className = "icon-box";
  box.dataset.icon = name;
  box.setAttribute("aria-hidden", "true");
  box.appendChild(icon(name, size));
  return box;
}

function swapIcon(box: HTMLSpanElement, name: IconName): void {
  if (box.dataset.icon === name) return;
  box.dataset.icon = name;
  box.replaceChildren(icon(name));
}

export function mountGrid(el: HTMLElement, state: AppState, opts: GridOptions): GridHandle {
  let disposed = false;
  el.replaceChildren();

  const root = document.createElement("div");
  root.className = "tile-grid-view";

  const gridEl = document.createElement("div");
  gridEl.className = "grid";
  root.appendChild(gridEl);

  // Nachtrag B, Punkt 2 (Design §11.2, Designsystem §5.6): "Host verbunden,
  // keine Session" zeigte bislang eine schwarze, leere Rasterflaeche -- kein
  // Text, keine Aktion. §5.6 verbietet ausdruecklich leere Kachelrahmen in
  // diesem Zustand ("Die Grid-Flaeche zeigt KEINE leeren Kachelrahmen"), also
  // ersetzt diese Karte das GANZE Raster, nicht nur eine einzelne Kachel.
  // `.grid-empty[hidden]` (styles.css) sorgt dafuer, dass `hidden` hier
  // tatsaechlich greift -- eine Autoren-`display`-Regel wuerde die
  // UA-`[hidden]`-Regel sonst ueberstimmen (derselbe Befund wie beim globalen
  // Fehlerbanner, siehe dessen Kommentar). `.grid` hat keine eigene
  // `display`-Regel, dort greift die UA-Regel ohnehin.
  const emptyState = document.createElement("div");
  emptyState.className = "grid-empty";
  emptyState.hidden = true;

  // Vertikale Position "etwas oberhalb der Mitte" (Designsystem §5.6, 38%
  // statt 50% Hoehe) -- zwei Abstandshalter mit Wachstumsverhaeltnis 38:62
  // teilen die verfuegbare HOEHE korrekt auf (anders als prozentuales
  // Padding, das sich laut Spezifikation auf die BREITE des umgebenden
  // Blocks bezieht, hier also die falsche Achse traefe).
  const emptySpacerTop = document.createElement("div");
  emptySpacerTop.className = "grid-empty-spacer";
  emptySpacerTop.style.flexGrow = "38";
  emptyState.appendChild(emptySpacerTop);

  const emptyCard = document.createElement("div");
  emptyCard.className = "grid-empty-card";
  const emptyIcon = document.createElement("span");
  emptyIcon.className = "grid-empty-icon";
  emptyIcon.setAttribute("aria-hidden", "true");
  emptyIcon.appendChild(icon("terminal", 32));
  emptyCard.appendChild(emptyIcon);
  const emptyHeading = document.createElement("h2");
  emptyHeading.textContent = t("grid.empty.heading");
  emptyCard.appendChild(emptyHeading);
  const emptyBody = document.createElement("p");
  emptyBody.textContent = t("grid.empty.body");
  emptyCard.appendChild(emptyBody);
  const emptyButton = document.createElement("button");
  emptyButton.type = "button";
  emptyButton.className = "btn btn--primary";
  emptyButton.textContent = t("grid.empty.newSession");
  // UX-Spec §8.4: der Tooltip nennt Strg+Umschalt+N, und das stimmt, weil der
  // Klick dieselbe Zielhost-Kette nimmt wie das Kuerzel (§7.9, main.ts).
  emptyButton.title = titleWithShortcut(t("grid.empty.newSession"), "session.new");
  emptyButton.addEventListener("click", () => {
    if (!disposed) opts.onNewSession();
  });
  emptyCard.appendChild(emptyButton);
  // Spec 10: ohne verbundenen Host statt der Pille ein gedaempfter Satz. Ein
  // ausgegrauter Knopf verspraeche eine Handlung, die hier nicht bloss gerade
  // gesperrt ist -- es gibt nichts, worauf sie wirken koennte.
  const emptyConnectFirst = document.createElement("p");
  emptyConnectFirst.className = "grid-empty-connect-first";
  emptyConnectFirst.textContent = t("grid.empty.connectFirst");
  emptyCard.appendChild(emptyConnectFirst);
  // UX-Spec §7.9: der Leerzustand zeigt nur Kuerzel, die hier wirken -- Suchen
  // und Maximieren brauchen ein Terminal und fehlen deshalb. "All shortcuts"
  // ist Strg+,: die Einstellungen fuehren die ganze Liste. Das `<li>` IST der
  // Chip (siehe `keyHint`), keine zusaetzliche Huelle.
  const emptyKeys = document.createElement("ul");
  emptyKeys.className = "grid-empty-keys";
  const KEY_ROWS: ReadonlyArray<readonly [KeymapAction, TranslationKey]> = [
    ["session.new", "grid.empty.keys.newSession"],
    ["quickOpen", "grid.empty.keys.quickOpen"],
    ["sidebar.toggle", "grid.empty.keys.sidebar"],
    ["settings.open", "grid.empty.keys.allShortcuts"],
  ];
  for (const [action, wordKey] of KEY_ROWS) {
    emptyKeys.appendChild(keyHint(action, wordKey, document.createElement("li")));
  }
  emptyCard.appendChild(emptyKeys);
  emptyState.appendChild(emptyCard);

  const emptySpacerBottom = document.createElement("div");
  emptySpacerBottom.className = "grid-empty-spacer";
  emptySpacerBottom.style.flexGrow = "62";
  emptyState.appendChild(emptySpacerBottom);

  root.appendChild(emptyState);

  /** Steht der Knopf "New session" oder der Satz "Connect a host ..." (Spec
   * 10)? Welcher Host die Session bekommt, entscheidet main.ts (§7.9). */
  function hasConnectedHost(): boolean {
    return state.hosts.some((h) => h.state === "connected");
  }

  // Designsystem §7.2: einmalige Ansage beim Maximieren. Eigenes,
  // dauerhaftes Element statt eines pro Ereignis neu erzeugten Knotens --
  // ein neu eingefuegter `aria-live`-Knoten wird nicht zuverlaessig
  // vorgelesen, nur eine Textaenderung an einem bereits vorhandenen.
  const announce = document.createElement("div");
  announce.className = "ab-visually-hidden";
  announce.setAttribute("aria-live", "polite");
  root.appendChild(announce);

  el.appendChild(root);

  /** Eine laufende Reihe des stillen Wiederanhaengens (siehe unten). */
  interface ReattachEntry {
    key: string;
    hostId: string;
    name: string;
    socket: SessionSocket;
    /** Die Verbindung, auf der der Kanal verloren ging. */
    runtimeId: string;
    /** Die Session, an der der verlorene Kanal hing. Haengt unter dem Namen
     * inzwischen eine andere, ist diese beendet (`replacedSince`). */
    identity: BoundIdentity | null;
    series: TileReattach;
    /** Die zuletzt still gehaltene Fehlermeldung eines Versuchs -- fuer die
     * Konsole, wenn die Reihe aufgibt. */
    lastError: string | null;
  }

  /** Alles, was das Raster je Kachel fuehrt -- je `id`, nicht je Position:
   * Tauschen und Verschieben aendern die Position, nie diese Buchhaltung
   * (Spec 2026-10-19 §4.3). `mountedKey` und `mountedRuntimeId` bewegen sich
   * IMMER zusammen (gesetzt beim Mounten, geleert beim Entsorgen); den Grund
   * fuer beide nennt `reconcile`. */
  interface TileView {
    id: number;
    refs: TileRefs;
    handle: TerminalHandle | null;
    /** Der Schluessel, MIT dem `handle` gemountet wurde. */
    mountedKey: string | null;
    /** Die Laufzeit-ID, mit der `handle` gemountet wurde. */
    mountedRuntimeId: string | null;
    /** Sessionschluessel, dessen entsorgtes Terminal den Tastaturfokus hatte,
     * bis dort ein frisches Terminal derselben Session montiert ist. */
    refocus: string | null;
    reattach: ReattachEntry | null;
    /** Der Timer, der den Chip "Copied" wieder leert. */
    copiedTimer: number | undefined;
    /** Timer, der das Aufleuchten beendet. */
    flashTimer: number | undefined;
    /** Sperrzustand aus dem vorigen Render (`render` refittet bei Wechsel). */
    lastLocked: boolean;
    /** Hatte diese Kachel je einen Kanal (ein gelungenes `open_terminal`)? Eine
     * Kachel mit Kanal bleibt an einer Kanalgrenze mit Sperrleiste und
     * "Reconnect" (`closesOnCapacity`; Spec 2026-10-19 §1 Nr. 1, §5.8, §8.3). */
    hadChannel: boolean;
    /** Wurde die Session dieser Kachel durch eine gleichnamige ersetzt? Dann
     * nennt die Sperrleiste sie beendet und bietet kein "Reconnect" an, das an
     * die neue haengen wuerde. Faellt mit dem naechsten angehaengten Kanal. */
    replaced: boolean;
    /** Hat der Nutzer diese Kachel mit "Reconnect" neu anhaengen lassen? Die
     * Sperre faellt dabei vor dem frischen Terminal (`requestReconnect`), das
     * Montieren sieht sie also nicht mehr; die Marke haelt fest, dass die Kachel
     * den Weg zurueck angeboten hat, auch wenn sie nie einen Kanal hatte, weil
     * ihr erstes Oeffnen anders scheiterte (`closesOnCapacity`; Spec 2026-10-19
     * §1 Nr. 1, §8.3). */
    reconnectRequested: boolean;
    /** Spec 2026-10-19 §8.1 (Schritt 3): wartet das Terminal dieser Kachel auf
     * einen Platz fuer sein `open_terminal` (`MountOptions.onQueued`)? Dann
     * steht "Opening…" im Kopf, und die Eingabe ist gesperrt
     * (`updateTileHead`). Gehoert zum Handle: wo `view.handle = null` steht,
     * steht auch `view.queued = false`. */
    queued: boolean;
    /** Lage der letzten `updateLayout`, `null`, solange verborgen. */
    rect: Rect | null;
  }
  const views = new Map<number, TileView>();

  /** Spec 2026-10-19 §8.1 (Schritt 3): hoechstens vier `open_terminal` je Host
   * zugleich, der Rest wartet. EINE Schlange fuer alle Terminals dieses
   * Rasters; Schluessel ist die Laufzeit-ID, unter der `mountTerminal`
   * einreiht. Erstes Montieren, "Reconnect", stilles Wiederanhaengen und eine
   * neue Verbindung montieren alle in `reconcile` und reihen sich darum alle
   * hier ein. */
  const openQueue = createOpenQueue();

  /** Lebt diese Ansicht noch? Rueckrufe eines Terminals koennen nach dem
   * Schliessen seiner Kachel eintreffen. */
  function isLive(view: TileView): boolean {
    return !disposed && views.get(view.id) === view;
  }

  function buildTile(id: number): TileRefs {
    const tileRoot = document.createElement("div");
    tileRoot.className = "tile";
    tileRoot.dataset.tileId = String(id);
    // `focusin` bubbelt sowohl bei einem Klick (xterm fokussiert sein
    // internes `<textarea>` programmatisch, das loest `focusin` aus) als
    // auch bei Tab-Navigation zu einer der beiden Kopf-Schaltflaechen --
    // EIN Mechanismus fuer Maus UND Tastatur statt zweier getrennter
    // Click-/Keydown-Pfade. Er setzt NUR den Fokus, kein Kachelziel (UX-Spec
    // §7.4): auch `focusActiveTile` nach jedem Oeffnen kommt hier an, und als
    // Zielklick ersetzte die naechste Sessionwahl die eben geoeffnete (A-03).
    tileRoot.addEventListener("focusin", () => {
      if (disposed) return;
      // Spec 2026-10-19 §4.3: die DOM-Reihenfolge folgt der Entstehung, nicht
      // der Anzeige. Wandert der Tastaturfokus (etwa per Tab) in eine ANDERE
      // Kachel, nennt die Live-Region darum Nummer und Session -- ohne
      // Aufleuchten, das gehoert der Wahl (§6.2). Wege, die den Fokus in `state`
      // schon vorher gesetzt haben, sagen selbst an und hier nichts doppelt an:
      // eine Wahl und Strg+Umschalt+1-9 (`revealTile`, mit Aufleuchten), der
      // Druck auf den Kopf (`pointerdown` unten) und das Schliessen einer
      // Kachel (`render`).
      const entering = state.focusedTile !== id;
      state.focusTile(id);
      if (entering) announceTile(id);
    });
    // Spec 2026-10-19 §4.7, §5.4: ein Druck auf den Kopf fokussiert die Kachel
    // und kann ein Zug zum Tauschen werden. Nicht die Kopfknoepfe (Befehle),
    // nicht das Terminal (das fokussiert ueber `focusin`), nur die Haupttaste.
    tileRoot.addEventListener("pointerdown", (event) => {
      if (disposed || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".tile-head") || target.closest(".tile-btn")) return;
      // `preventDefault` laesst den Tastaturfokus, wo er war (wie am Griff der
      // Seitenleiste, `sidebar-resize.ts`); ohne es schoebe der Browser ihn
      // nach diesem Lauscher auf <body> und machte das `focus()` unten
      // zunichte. Darum legt der Klick ihn selbst in diese Kachel (Spec
      // 2026-10-19 §4.7 "fokussiert", wie Strg+Umschalt+1-9) -- sonst gingen
      // die Tasten weiter in das Terminal der vorher fokussierten Kachel,
      // waehrend diese hier fokussiert aussieht. Klick und Doppelklick kommen
      // trotzdem durch.
      //
      // Ohne Terminal in dieser Kachel (der Host ist ausgefallen, getrennt oder
      // verbindet noch) gibt es nichts zu fokussieren, und `preventDefault`
      // liesse den Fokus im Terminal der vorigen Kachel: Eingabe und die
      // Terminal-Akkorde (Strg+Umschalt+W/F/C, in `terminal.ts`) wirkten dort
      // weiter. Darum faellt er wie ohne `preventDefault` auf <body>.
      //
      // Der Fokus steht in `state`, bevor das Terminal ihn bekommt: dessen
      // `focusin` sieht keinen Wechsel, und ohne Terminal gibt es keins. Wechselt
      // der Druck die Kachel, sagt darum er selbst Nummer und Session an (Spec
      // §4.3), ohne Aufleuchten, das gehoert der Wahl (§6.2).
      event.preventDefault();
      const entering = state.focusedTile !== id;
      state.focusTile(id);
      const handle = views.get(id)?.handle;
      if (handle) handle.focus();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (entering) announceTile(id);
      startHeadDrag(id, event);
    });

    const head = document.createElement("div");
    head.className = "tile-head";
    // Spec §7.2: "Doppelklick auf den Kachelkopf ODER Ctrl+Shift+M"
    // maximiert -- der Knopf unten deckt dieselbe Aktion bereits ab, aber
    // der Doppelklick ist die im Entwurf vorgefuehrte, von Kachelsystemen
    // erwartete Geste. `closest(".tile-btn")` schliesst Doppelklicks AUF
    // eine der beiden Kopf-Schaltflaechen aus -- sonst wuerde ein
    // Doppelklick auf "Schliessen" zusaetzlich die Kachel maximieren, und
    // ein Doppelklick auf "Maximieren" den Zustand zweimal umschalten
    // (deren eigener `click`-Handler feuert dabei ohnehin schon zweimal).
    head.addEventListener("dblclick", (event) => {
      if (disposed) return;
      if (event.target instanceof Element && event.target.closest(".tile-btn")) return;
      state.toggleMaximize(id);
    });

    const badge = document.createElement("span");
    badge.className = "badge";
    head.appendChild(badge);

    // Designsystem §6.2: "nicht sichtbar, aber gefordert" -- Screenreader-
    // Text zusaetzlich zu `aria-current` auf der Kachel selbst.
    const focusedFlag = document.createElement("span");
    focusedFlag.className = "ab-visually-hidden";
    focusedFlag.hidden = true;
    head.appendChild(focusedFlag);

    const title = document.createElement("span");
    title.className = "tile-title";
    head.appendChild(title);

    // UI v2 8.2: der Agentenplatz steht zwischen Titel und Host. Ohne
    // Statusdaten ist er `hidden` und nimmt so auch keine Flex-Luecke ein.
    const agentSlot = document.createElement("span");
    agentSlot.className = "tile-agent";
    agentSlot.hidden = true;
    head.appendChild(agentSlot);

    const host = document.createElement("span");
    host.className = "tile-host";
    head.appendChild(host);

    const tmuxMark = document.createElement("span");
    tmuxMark.className = "tile-tmux";
    tmuxMark.title = t("tile.tmux.title");
    tmuxMark.hidden = true;
    const tmuxWord = document.createElement("span");
    tmuxWord.className = "tile-tmux-word";
    tmuxWord.textContent = t("tile.tmux");
    tmuxMark.append(icon("terminal", 12), tmuxWord);
    head.appendChild(tmuxMark);

    // Nachtrag B, Punkt 3 (Designsystem §8.3, Punkt 1): "rechts erscheint ein
    // Chip: Warndreieck + Text 'Input locked'" -- vor den Kopf-Schaltflaechen
    // eingefuegt, damit er wie diese von `.tile-acts`s `margin-left: auto`
    // an den rechten Rand gezogen wird (dasselbe Prinzip wie der
    // Maximiert-Chip, der stattdessen in `maximizeBtn` selbst lebt).
    const lockChip = document.createElement("span");
    lockChip.className = "tile-lock-chip";
    lockChip.hidden = true;
    const lockChipInd = document.createElement("span");
    lockChipInd.className = "ind ind-warn";
    lockChip.appendChild(lockChipInd);
    lockChip.appendChild(chipText(t("tile.inputLocked")));
    // UX-Spec §6.1: "Copied" nach jedem Kopieren, auch ueber OSC 52. Der Chip
    // ist selbst die Live-Region und bleibt dauerhaft im Baum, nur sein
    // Inhalt kommt und geht (`showCopied`) -- ein eben erst eingeblendeter
    // aria-live-Knoten wird nicht zuverlaessig vorgelesen (siehe `announce`).
    const copiedChip = document.createElement("span");
    copiedChip.className = "tile-copied";
    copiedChip.setAttribute("aria-live", "polite");
    // Dieselbe Form wie die ruhige Zeile der Seitenleiste (UX-Spec §5.7):
    // gedaempfter Text mit Drehsymbol, ohne Rahmen und ohne Flaeche.
    const quietChip = document.createElement("span");
    quietChip.className = "tile-quiet";
    quietChip.hidden = true;
    const quietSpinner = document.createElement("span");
    quietSpinner.className = "ind ind-connecting";
    quietSpinner.setAttribute("aria-hidden", "true");
    const quietText = chipText(t("terminal.reconnecting"));
    quietChip.append(quietSpinner, quietText);
    const acts = document.createElement("span");
    acts.className = "tile-acts";
    // Spec 2026-10-19 §8.4: zeigt die Groesse, solange die Kachel nach dem Fit
    // unter 80 Spalten oder 20 Zeilen hat (`updateNarrow`); sonst verborgen.
    const narrowChip = document.createElement("span");
    narrowChip.className = "tile-narrow";
    narrowChip.hidden = true;
    const narrowText = chipText("");
    narrowChip.appendChild(narrowText);
    acts.appendChild(narrowChip);
    acts.appendChild(copiedChip);
    acts.appendChild(quietChip);
    acts.appendChild(lockChip);

    const maximizeBtn = document.createElement("button");
    maximizeBtn.type = "button";
    maximizeBtn.className = "tile-btn btn btn--text";
    const maximizeIcon = iconBox("maximize-2");
    maximizeBtn.appendChild(maximizeIcon);
    const maximizeLabel = document.createTextNode("");
    maximizeBtn.appendChild(maximizeLabel);
    maximizeBtn.addEventListener("click", () => {
      if (disposed) return;
      // Spec 2026-10-19 §8.1 (Schritt 3): Maximieren verbirgt die uebrigen
      // Kacheln, ihre Terminals bleiben. Strg+Umschalt+W und Strg+Umschalt+M
      // wirken auf die fokussierte Kachel in `AppState`; die muss die dieses
      // Knopfes sein, nicht eine, die er gleich verbirgt. Ein Druck auf einen
      // Kopfknopf setzt den Fokus nicht selbst (`pointerdown` nimmt die Knoepfe
      // aus), und der Knopf nimmt ihn nicht in jedem Weg an (`click()` aus der
      // Hilfstechnik). Darum wie der Druck auf den Kopf: Fokus in `state`, dann
      // ins Terminal -- bevor maximiert wird. Ohne Ansage der Kachel: die des
      // Maximierens nennt sie schon.
      state.focusTile(id);
      views.get(id)?.handle?.focus();
      // Direkt auf `AppState`, keine Rueckruf-Vermittlung: Maximieren ist
      // reiner UI-Zustand ohne Backend-Seiteneffekt (anders als Schliessen
      // unten, das den PTY-Kanal betrifft und deshalb dem Aufrufer gehoert).
      state.toggleMaximize(id);
    });
    acts.appendChild(maximizeBtn);

    // Gemeinsame Schliessen-Logik fuer die Kopf-Schaltflaeche UND die
    // Sperrleiste (Nachtrag B, Punkt 3, §8.3 Punkt 2, "Close terminal"
    // sekundaer) -- dieselbe Aufloesung, ein einziger Aufrufer von
    // `opts.onCloseTerminal`.
    function requestClose(): void {
      if (disposed) return;
      const key = state.tileById(id)?.sessionKey;
      if (!key) return;
      const resolved = resolveSession(state, key);
      // Delegiert an den Aufrufer statt selbst `state.closeTile` zu rufen:
      // main.ts (Shell-Task 11) entscheidet, was "geschlossen" ausser der
      // Zustandsaenderung noch bedeutet (z. B. eine Wiedereroeffnen-Anzeige
      // wie im alten Plan-1-`main.ts`). Die eigentliche Entsorgung des
      // `TerminalHandle` laeuft trotzdem ueber `render()`: sobald der
      // Aufrufer die Kachel schliesst, sieht die naechste
      // Zustandsbenachrichtigung das und entsorgt hier (`syncViews`).
      if (resolved) opts.onCloseTerminal(resolved.hostId, resolved.name, resolved.socket);
    }

    /** Lebender Host: den Kanal an Ort und Stelle ersetzen. Ausgefallener
     * Host: die Verbindung samt Anmeldung wieder aufbauen und die letzte
     * Ausgabe bis dahin behalten. Ein laufender Verbindungsversuch wird nicht
     * verdoppelt. */
    function requestReconnect(): void {
      if (disposed) return;
      const key = state.tileById(id)?.sessionKey;
      if (!key) return;
      const resolved = resolveSession(state, key);
      if (!resolved) return;
      if (resolved.hostState === "connecting") return;
      const view = views.get(id);
      if (!view) return;
      // Spec 2026-10-19 §1 Nr. 1, §8.3: ab hier hat der Nutzer diese Kachel neu
      // anhaengen lassen. Scheitert das an einer Kanalgrenze, bleibt sie
      // stehen, selbst wenn sie nie einen Kanal hatte, weil ihr erstes Oeffnen
      // anders scheiterte: sie bietet den Weg zurueck schon an
      // (`closesOnCapacity`). Die Marke gilt fuer beide Wege unten: bei einem
      // lebenden Host faellt die Sperre noch VOR dem frischen Terminal und ist
      // beim Montieren nicht mehr zu sehen; beim ausgefallenen bleibt sie bis
      // zur neuen Verbindung, und das Montieren sieht sie selbst.
      view.reconnectRequested = true;
      if (resolved.hostState !== "connected") {
        opts.onReconnectHost(resolved.hostId);
        return;
      }
      // Spec 2026-10-19 §5.8: wie das stille Wiederanhaengen -- `reconcile`
      // entsorgt das gesperrte Terminal und montiert in DIESER Kachel ein
      // frisches. Position, Fokus und Maximieren bleiben; frueher lief das
      // ueber `closeTile` und `openSession` und konnte die Kachel verschieben.
      //
      // Die Reihenfolge ist eine Korrektheitsbedingung: erst `mountedKey`
      // leeren, dann die Sperre loesen. Deren Benachrichtigung faehrt das
      // Neuzeichnen, das die Sperrleiste ausblendet, BEVOR `reconcile`
      // montiert -- das frische Terminal misst ohne den 32-px-Streifen, meldet
      // seine Endgroesse mit `open_terminal` und braucht keinen Refit (Spec
      // §4.5). Umgekehrt refittete jenes Neuzeichnen den alten, toten Handle.
      // Das `render()` danach wirkt nur, wenn keine Sperre zu loesen war: dann
      // benachrichtigt `applyInputLocks` nicht.
      view.mountedKey = null;
      state.applyInputLocks([], [key]);
      render();
      // Dieselbe Benutzerabsicht wie jede andere Sessionwahl, also derselbe
      // Fokusweg (Designsystem §7.5); der Handle ist hier schon der neue.
      view.handle?.focus();
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tile-btn btn btn--text";
    closeBtn.setAttribute("aria-label", t("tile.close"));
    // UX-Spec §8.4: der Tooltip nennt das Kuerzel, der Name bleibt schlicht.
    closeBtn.title = titleWithShortcut(t("tile.close"), "session.close");
    // Icon statt Textglyphe (Spec 13.1) -- reines Ornament, der Name steckt
    // weiterhin in `aria-label`/`title`.
    closeBtn.appendChild(iconBox("x"));
    closeBtn.addEventListener("click", requestClose);
    acts.appendChild(closeBtn);

    head.appendChild(acts);
    tileRoot.appendChild(head);

    // Nachtrag C (Befund 2, Designsystem §8.3, Punkt 2): "Reconnect"
    // (primaer) neben "Close terminal" (sekundaer). Ein `TerminalHandle`
    // laesst sich nicht an Ort und Stelle entsperren -- aber genau dafuer
    // gibt es das Entsorgen-und-neu-Mounten, das `reconcile()` ohnehin
    // ueberall benutzt. Reconnect ersetzt den Kanal an Ort und Stelle
    // (`requestReconnect`, Spec 2026-10-19 §5.8).
    //
    // Darum laeuft der Knopf nicht ueber `openSession` (Validierung,
    // Important 2): `openSession` loescht `inputLocked` seit demselben Befund
    // NICHT mehr fuer eine Session, die schon in einer Kachel steht -- sonst
    // haette ein blosser Klick auf die Sessionzeile die Sperre optisch
    // aufgehoben, ohne einen Kanal zu ersetzen. Die Sperre faellt nur, wo
    // tatsaechlich ein frischer Kanal kommt: hier unmittelbar davor
    // (`requestReconnect`), sonst nach der Montage in `reconcile`.
    //
    // Ob das `open_terminal` danach ERFOLGREICH ist, entscheidet das
    // Backend: die Pumpaufgabe entfernt bei einem Verbindungsverlust nur den
    // `terminals`-Eintrag, NIE den Transport aus `AppState::hosts`
    // (commands.rs) -- `open_terminal_impl` findet ihn also und ruft
    // `open_attach` -> `channel_open_session()`. Ist die SSH-Verbindung
    // wirklich tot, schlaegt das fehl, die Ablehnung laeuft ueber
    // `terminal.ts`s `onError` in `opts.onTerminalError` und damit sichtbar
    // in den globalen Fehlerhinweis (main.ts) -- kein stiller Fehlschlag,
    // der nur so AUSSIEHT, als haette er gewirkt.
    //
    // Der i18n-Schluessel heisst `tile.reconnect`, nicht wie in Designsystem
    // §8.5 aufgefuehrt `error.terminal.reconnect`: `en.json` hat keinen
    // `error.*`-Namensraum, und §8.5s Namen wurden bei der Umsetzung
    // durchgehend an die tatsaechliche Struktur angeglichen (dort
    // `sidebar.session.open`, hier `sidebar.state.sessionOpen`). Dieser
    // Knopf sitzt im selben Streifen wie `tile.close` und traegt deshalb
    // dessen Praefix -- Angleichung, keine Abweichung aus Versehen.
    const lockStrip = document.createElement("div");
    lockStrip.className = "tile-lock";
    lockStrip.hidden = true;
    const lockStripInd = document.createElement("span");
    lockStripInd.className = "ind ind-warn";
    lockStrip.appendChild(lockStripInd);

    const lockText = document.createElement("span");
    lockText.className = "tile-lock-message";
    const lockBold = document.createElement("b");
    lockBold.textContent = t("tile.inputLocked");
    lockText.appendChild(lockBold);
    const lockMessage = document.createTextNode("");
    lockText.appendChild(lockMessage);
    lockStrip.appendChild(lockText);

    const lockReconnectBtn = document.createElement("button");
    lockReconnectBtn.type = "button";
    lockReconnectBtn.className = "tile-lock-reconnect btn btn--primary btn--row";
    lockReconnectBtn.textContent = t("tile.reconnect");
    lockReconnectBtn.addEventListener("click", requestReconnect);
    lockStrip.appendChild(lockReconnectBtn);

    const lockCloseBtn = document.createElement("button");
    lockCloseBtn.type = "button";
    lockCloseBtn.className = "tile-lock-close btn btn--secondary btn--row";
    lockCloseBtn.textContent = t("tile.close");
    lockCloseBtn.addEventListener("click", requestClose);
    lockStrip.appendChild(lockCloseBtn);

    tileRoot.appendChild(lockStrip);

    const terminal = document.createElement("div");
    terminal.className = "tile-terminal";
    tileRoot.appendChild(terminal);

    return {
      root: tileRoot,
      head,
      badge,
      focusedFlag,
      title,
      host,
      tmuxMark,
      lockChip,
      quietChip,
      quietText,
      copiedChip,
      narrowChip,
      narrowText,
      agentSlot,
      maximizeBtn,
      maximizeIcon,
      maximizeLabel,
      closeBtn,
      lockStrip,
      lockText,
      lockMessage,
      lockReconnectBtn,
      terminal,
    };
  }

  function showCopied(view: TileView): void {
    if (!isLive(view)) return;
    const chip = view.refs.copiedChip;
    window.clearTimeout(view.copiedTimer);
    // Ein zweites Kopieren, solange der Chip steht, verlaengert nur die
    // Anzeige -- der Inhalt bleibt, die Region sagt nichts doppelt an.
    if (!chip.hasChildNodes()) {
      const check = iconBox("check", 14);
      check.classList.add("icon-box--sm");
      chip.replaceChildren(check, chipText(t("tile.copied")));
    }
    view.copiedTimer = window.setTimeout(() => hideCopied(view), COPIED_CHIP_MS);
  }

  function hideCopied(view: TileView): void {
    window.clearTimeout(view.copiedTimer);
    view.copiedTimer = undefined;
    view.refs.copiedChip.replaceChildren();
  }

  /** Spec 2026-10-19 §8.4: unter 80 Spalten oder 20 Zeilen sagt der Kopf es.
   * Die App verkleinert nie selbst und schliesst nichts. */
  function updateNarrow(view: TileView, cols: number, rows: number): void {
    if (!isLive(view)) return;
    const narrow = cols < NARROW_COLS || rows < NARROW_ROWS;
    view.refs.narrowChip.hidden = !narrow;
    if (!narrow) {
      view.refs.narrowText.replaceChildren();
      view.refs.narrowChip.removeAttribute("title");
      return;
    }
    // Zwei Teile, damit eine schmale Kachel nur die Groesse zeigt (styles.css):
    // die Groesse und der Rest des Satzes. Steht die Groesse in einer
    // Uebersetzung nicht vorn, bleibt der Satz ganz.
    const params = { cols: String(cols), rows: String(rows) };
    const full = t("tile.narrow", params);
    const size = t("tile.narrow.size", params);
    const sizeText = document.createElement("span");
    sizeText.className = "tile-narrow-size";
    if (full.startsWith(size)) {
      sizeText.textContent = size;
      const rest = document.createElement("span");
      rest.className = "tile-narrow-rest";
      rest.textContent = full.slice(size.length);
      view.refs.narrowText.replaceChildren(sizeText, rest);
    } else {
      sizeText.textContent = full;
      view.refs.narrowText.replaceChildren(sizeText);
    }
    view.refs.narrowChip.title = full;
  }

  /** Spec 2026-10-19 §8.1 (Schritt 3): das Terminal der Kachel wartet auf
   * einen Platz fuer sein `open_terminal` oder hat ihn bekommen. Waehrend
   * `render` laeuft (ein Terminal reiht sich beim Montieren ein; eine
   * entsorgte Kachel gibt ihren Platz frei) zeichnet das nicht selbst neu
   * (`rendering`), und die Koepfe stimmen trotzdem: Kommt die Meldung in
   * `syncViews`, sehen die Koepfe, die `render` danach berechnet, sie schon;
   * kommt sie in `reconcile`, stehen die Koepfe davor schon, und `render`
   * zieht sie nach dem Abgleich nach. Sonst, etwa wenn ein anderes Oeffnen
   * antwortet und den Platz freigibt, zeichnet es neu. */
  function setQueued(view: TileView, queued: boolean): void {
    if (view.queued === queued) return;
    view.queued = queued;
    if (!rendering) render();
  }

  // --- Stilles Wiederanhaengen (UX-Spec §5.5) ---------------------------
  //
  // Verliert eine Kachel ihren Kanal, waehrend die Verbindung ihres Hosts
  // lebt, haengt sie sich bis zu dreimal selbst neu an (Zeitplan in
  // `tile-reattach.ts`). Ein Versuch ist ein frisches Terminal in DERSELBEN
  // Kachel, also ein neues `open_terminal` mit Verlauf (§5.6) -- dieselbe
  // Aktion wie "Reconnect" (`requestReconnect`), nur ohne dessen
  // Fokuswechsel: ein Versuch im Hintergrund darf den Platz der Kachel nicht
  // aendern und den Fokus nirgends hinziehen. Lag der Fokus im alten
  // Terminal, bekommt ihn das frische zurueck (`reconcile`) -- sonst fiele er
  // mit dem entsorgten auf <body>.
  // Gegen einen toten Host versucht die Kachel nichts; dort verbindet main.ts
  // den Host neu (§5.4), und die neue Laufzeit-ID montiert die Kachel ohnehin.
  // Eine verborgene Kachel (eine andere ist maximiert) behaelt ihre Reihe; der
  // faellige Versuch wartet, bis Fenster und Kachel wieder zu sehen sind
  // (Spec 2026-10-19 §8.1, Schritt 3): verborgen montiert `reconcile` nicht.

  /** Kann die Kachel gerade nicht angehaengt werden, weil man sie nicht sieht?
   * Das Fenster ist verborgen, oder eine andere Kachel ist maximiert. */
  function reattachHidden(view: TileView): boolean {
    return document.hidden || !state.visibleTileIds().includes(view.id);
  }

  /** Ruft `callback` einmal, sobald Fenster UND Kachel wieder zu sehen sind:
   * beim naechsten `visibilitychange` oder bei der naechsten Benachrichtigung
   * des Zustands, die die Kachel zeigt (Zurueckholen). Dieser Abonnent kommt
   * erst nach `render` an die Reihe, das Neuzeichnen steht dann schon. Liefert
   * die Abmeldung. */
  function whenVisible(view: TileView, callback: () => void): () => void {
    const check = (): void => {
      if (reattachHidden(view)) return;
      stop();
      callback();
    };
    const unsubscribe = state.subscribe(check);
    document.addEventListener("visibilitychange", check);
    function stop(): void {
      unsubscribe();
      document.removeEventListener("visibilitychange", check);
    }
    return stop;
  }

  /** `terminal://connection-lost` einer Kachel. */
  function onTerminalLost(view: TileView, mounted: ResolvedSession, runtimeId: string): void {
    if (!isLive(view)) return;
    const key = sessionKey(mounted.hostId, mounted.name, mounted.socket);
    const host = state.hosts.find((candidate) => candidate.id === mounted.hostId);
    const alive = host?.state === "connected" && host.runtimeId === runtimeId;
    let entry = view.reattach;
    if (alive && (!entry || entry.key !== key || entry.runtimeId !== runtimeId)) {
      entry?.series.cancel();
      entry = {
        key, hostId: mounted.hostId, name: mounted.name, socket: mounted.socket, runtimeId, lastError: null,
        identity: boundIdentity(mounted),
        series: createTileReattach({
          attach: () => attemptReattach(view),
          setTimer: (callback, ms) => window.setTimeout(callback, ms),
          clearTimer: (handle) => window.clearTimeout(handle as number),
          isHidden: () => reattachHidden(view),
          onVisible: (callback) => whenVisible(view, callback),
        }),
      };
      view.reattach = entry;
    }
    const reattaching = alive && entry !== null && entry.series.lost();
    if (!reattaching) cancelReattach(view);
    opts.onConnectionLost(mounted.hostId, mounted.name, reattaching, mounted.socket);
    // Der Hinweis erscheint ohne Zustandsaenderung in `AppState`.
    render();
  }

  /** Der faellige Versuch. Eine beendete Session wird gar nicht erst
   * angehaengt, auch keine, an deren Namen inzwischen eine neue haengt; ihre
   * Kachel behaelt die letzte Ausgabe. */
  function attemptReattach(view: TileView): void {
    const entry = view.reattach;
    if (!isLive(view) || !entry) return;
    const target = reattachTarget(view, entry);
    if (!target) {
      cancelReattach(view);
      render();
      return;
    }
    const replaced = replacedSince(entry.identity, target);
    if (target.status === "ended" || replaced) {
      view.replaced = replaced;
      giveUpReattach(view, entry, true);
      return;
    }
    // Der Abgleich entsorgt den alten Kanal und montiert in derselben Kachel
    // einen frischen -- samt Fokus, wenn er im alten lag (siehe `reconcile`).
    view.mountedKey = null;
    render();
  }

  /** Das frische Terminal eines Versuchs konnte nicht anhaengen. */
  function onReattachFailed(view: TileView, entry: ReattachEntry): void {
    const resolved = resolveSession(state, entry.key);
    const replaced = resolved !== null && replacedSince(entry.identity, resolved);
    const ended = resolved?.status === "ended" || replaced;
    if (!ended && entry.series.failed()) {
      render();
      return;
    }
    view.replaced = replaced;
    giveUpReattach(view, entry, ended);
  }

  /** Drei Fehlschlaege oder eine beendete Session: die Sperrleiste erscheint.
   * Sperren ist Sache von main.ts, derselbe Weg wie ein abgelehntes Oeffnen.
   * Ein Banner gibt es nicht -- die Reihe war still; den Grund des letzten
   * Versuchs nennt die Konsole. Nur eine Kanalgrenze bekommt ihr Banner (Spec
   * 2026-10-19 §8.3). Eine beendete Session nennt ihren Grund in der
   * Sperrleiste. */
  function giveUpReattach(view: TileView, entry: ReattachEntry, ended: boolean): void {
    cancelReattach(view);
    if (!ended && entry.lastError !== null && isCapacityError(entry.lastError)) {
      // Spec 2026-10-19 §8.3: auch nach einer stillen Reihe nennt das Banner
      // die Kanalgrenze, der Rohtext steht hinter "Copy details"; die
      // Sperrleiste bleibt, wie die Reihe es vorsieht.
      const host = state.hosts.find((candidate) => candidate.id === entry.hostId);
      opts.onTerminalError(t("terminal.capacity", { host: host?.label ?? entry.hostId }), entry.lastError);
    } else if (!ended) {
      console.warn(`[terminal] reattaching '${entry.name}' failed three times: ${entry.lastError ?? "no error reported"}`);
    }
    opts.onTerminalOpenFailed(entry.hostId, entry.name, entry.socket);
    render();
  }

  function cancelReattach(view: TileView): void {
    view.reattach?.series.cancel();
    view.reattach = null;
  }

  /** Zeigt die Kachel noch diese Session auf derselben, lebenden Verbindung?
   * Eine Sperre, die inzwischen jemand anderes gesetzt hat, beendet die Reihe
   * ebenfalls: die Reihe sperrt selbst nie, und ueber einer Sperre steht die
   * Sperrleiste, nicht "Reconnecting…". */
  function reattachTarget(view: TileView, entry: ReattachEntry): ResolvedSession | null {
    if (state.tileById(view.id)?.sessionKey !== entry.key) return null;
    const resolved = resolveSession(state, entry.key);
    if (!resolved || resolved.hostState !== "connected" || resolved.runtimeHostId !== entry.runtimeId) return null;
    return resolved.inputLocked ? null : resolved;
  }

  /** Vor jedem Neuzeichnen: eine Reihe endet, sobald ihre Kachel etwas
   * anderes zeigt oder der Host seine Verbindung verliert. Den Host uebernimmt
   * dann das Neuverbinden (§5.4) oder die Sperrleiste. Verborgen zu werden
   * beendet sie nicht: der faellige Versuch wartet (`reattachHidden`). */
  function dropStaleReattaches(): void {
    for (const view of views.values()) {
      const entry = view.reattach;
      if (entry && !reattachTarget(view, entry)) cancelReattach(view);
    }
  }

  /** Spec 2026-10-19 §1 Nr. 1, §8.3: geht die Kachel, wenn ihr `open_terminal`
   * an einer Kanalgrenze scheitert? Nur beim allerersten Oeffnen einer frisch
   * geoeffneten Kachel: sie zeigt noch nichts, und ein neuer Klick auf die
   * Session versucht es wieder. Jede Kachel, die schon einen Weg zurueck
   * bietet, bleibt -- mit Sperrleiste, dem Satz im Banner und dem Rohtext hinter
   * "Copy details". Nicht mehr frisch ist eine Kachel, die
   *  - je einen Kanal hatte (`hadChannel`),
   *  - beim Montieren schon gesperrt war (`lockedAtMount`: die Sperre in
   *    `resolved` von damals, `reconcile` loest sie erst mit dem frischen
   *    Terminal) und damit die Sperrleiste mit "Reconnect" zeigte, etwa weil ihr
   *    Host sich selbst neu verband, oder
   *  - der Nutzer mit "Reconnect" neu anhaengen liess (`reconnectRequested`);
   *    die Sperre faellt dabei schon VOR dem Montieren (`requestReconnect`). */
  function closesOnCapacity(view: TileView, lockedAtMount: boolean): boolean {
    return !view.hadChannel && !view.reconnectRequested && !lockedAtMount;
  }

  /** Der EINE Ort, an dem `TerminalHandle`s entstehen und -- ausser beim
   * Schliessen einer Kachel (`syncViews`) -- vergehen. Fuer jede Kachel: welche
   * Session zeigt sie, und haengt ihr Terminal noch an DERSELBEN Verbindung?
   * Weicht eines von beidem vom zuletzt Gemounteten ab, wird genau einmal
   * entsorgt -- auch bei einer verborgenen Kachel, ihr Kanal gehoert dann zu
   * einer anderen Session oder starb mit der alten Verbindung -- und neu
   * gemountet, aber nur, wenn die Kachel sichtbar ist. Eine verborgene (eine
   * andere ist maximiert) wartet ohne Terminal und ohne Sperre aufs
   * Zurueckholen und montiert dann mit ihrer Endgeometrie: verborgen gibt es
   * nichts zu messen, sie oeffnete in einer Groesse, die sie nie hat, und das
   * Zurueckholen kostete ein `resize_terminal` (Spec 2026-10-19 §4.5, §8.1).
   * Sonst bleibt der bestehende Handle unangetastet, sichtbar oder verborgen
   * (Anforderung 1 und 2).
   *
   * Ehrlich dazugesagt: der `resolveSession`-Suchlauf steht seit Paket 2.5
   * VOR dem Abkuerzen und laeuft damit auch fuer unveraenderte Kacheln, bei
   * jeder Benachrichtigung -- vorher nur im Aenderungsfall. Bewusst
   * hingenommen: der Lauf geht ueber eine Handvoll Hosts mal eine Handvoll
   * Sessions, einmal je Kachel und Neuzeichnen. Die Alternative waere ein drittes
   * Buchhaltungsfeld (die settings.toml-ID je Kachel, um den Host ohne
   * Sessionsuche zu finden); das kostet mehr Verstaendlichkeit, als es an
   * Arbeit spart. Wer das spaeter misst und anders entscheidet, findet hier
   * die Begruendung, die er umstossen muss. */
  function reconcile(): { lock: string[]; release: string[]; mounted: Set<number> } {
    const lock: string[] = [];
    const release: string[] = [];
    /** Kacheln, die in diesem Durchgang frisch montiert wurden: sie haben mit
     * ihrer Endgeometrie gemessen, `render` refittet sie nicht. */
    const mounted = new Set<number>();
    const visible = new Set(state.visibleTileIds());
    for (const tile of state.tiles) {
      const view = views.get(tile.id);
      if (!view) continue;
      // Spec 2026-10-19 §8.1 (Schritt 3): auch eine verborgene Kachel will ihre
      // Session -- ihr Terminal bleibt, waehrend eine andere maximiert ist.
      const wantKey = tile.sessionKey;
      // `resolved` ist nur `null`, wenn `state.hosts` und `state.tiles`
      // kurzzeitig auseinanderlaufen -- sollte ueber die bestehenden
      // `AppState`-Mutatoren nicht vorkommen, ein fehlender Eintrag darf
      // hier aber nie werfen.
      const resolved = resolveSession(state, wantKey);
      // Zweiteilig: derselbe Schluessel an einer ANDEREN Laufzeit-ID heisst,
      // dass die Session zwar dieselbe ist, die VERBINDUNG darunter aber eine
      // neue -- der alte PTY-Kanal ist mit dem alten Transport gestorben.
      // Ohne diesen zweiten Vergleich saehe die Kachel nach einem erneuten
      // Verbinden gesund aus und verschluckte trotzdem jede Eingabe.
      if (view.mountedKey === wantKey && view.mountedRuntimeId === (resolved?.runtimeHostId ?? null)) {
        continue;
      }

      const stale = view.handle;
      // Lag der Tastaturfokus in diesem Terminal (im Hilfstextfeld von xterm
      // oder im Suchfeld), nimmt `dispose()` ihn mit, und er fiele auf
      // <body>. Das frische Terminal derselben Session in DERSELBEN Kachel
      // bekommt ihn unten zurueck -- beim stillen Wiederanhaengen (§5.5) im
      // selben Durchgang, nach einer neuen Verbindung des Hosts (§5.4) erst im
      // naechsten: dort kommt die Laufzeit-ID noch waehrend "connecting", und
      // montiert wird erst bei "connected". Das haelt den Fokus, es nimmt ihn
      // nicht: lag er woanders, oder hat ihn inzwischen etwas anderes, bleibt
      // er dort.
      if (stale && view.refs.terminal.contains(document.activeElement)) view.refocus = wantKey;
      else if (view.refocus !== wantKey) view.refocus = null;
      if (stale) {
        // Spec 2026-10-19 §8.1 (Schritt 3): das Warten gehoert dem Terminal und
        // endet mit ihm; ein frisches meldet sich selbst (`onQueued`). Vor
        // `dispose()`: meldet das entsorgte dabei noch etwas, aendert es nichts.
        view.queued = false;
        stale.dispose();
        view.handle = null;
        view.mountedKey = null;
        view.mountedRuntimeId = null;
        // Ein "Copied" der alten Ansicht gehoert nicht ueber die naechste.
        hideCopied(view);
      }

      // Verborgen wartet die Kachel ohne Terminal aufs Zurueckholen (Spec
      // 2026-10-19 §8.1): kein Montieren, und auch keine Sperre -- montieren
      // kann sie, nur nicht jetzt. Sichtbar geworden, kommt sie wieder hier
      // vorbei, mit ihrer Endgeometrie.
      if (!visible.has(tile.id)) continue;

      // Ohne Laufzeit-ID gibt es nichts zu oeffnen: `open_terminal`
      // scheiterte sicher, und eine Kachel mit einem Handle an einer toten
      // Verbindung ist genau der Zustand, den dieses Paket beseitigt.
      //
      // Der Hostzustand kommt seit B1 dazu: bei `failed` bleibt die
      // Laufzeit-ID absichtlich stehen (siehe `ResolvedSession.hostState`),
      // die ID allein beweist also nichts. Montiert wird nur, wenn ein
      // LEBENDER Kanal moeglich ist.
      const runtimeHostId = resolved?.runtimeHostId;
      const canMount = Boolean(resolved && runtimeHostId && resolved.hostState === "connected");
      if (resolved && !canMount && !resolved.inputLocked) {
        // Satz 4 des Sperrvertrags: eine Kachel, die gerade nicht montiert
        // werden kann, traegt die Sperre. Ohne ihn naehme die
        // Montagebedingung dem Nutzer den Rueckweg: Sperrleiste und
        // "Reconnect", der einzige Knopf, der zurueckfuehrt, waeren weg, und
        // uebrig blieben Kachelkopf und ein leeres schwarzes Rechteck, ohne
        // jede Meldung. "Reconnect" selbst loest die Sperre nur auf einem
        // verbundenen Host, an Ort und Stelle und unmittelbar vor dem frischen
        // Kanal (`requestReconnect`, Spec 2026-10-19 §5.8); auf einem
        // ausgefallenen Host verbindet es den Host neu, und die Sperre bleibt.
        // Faellt sie auf anderem Weg, ohne dass ein Kanal kommen kann (etwa
        // durch eine neue Laufzeit-ID, die `setRuntimeId` noch vor
        // "connected" setzt), setzt diese Zeile sie wieder.
        lock.push(wantKey);
      }
      if (resolved && runtimeHostId && canMount) {
        // Ein Versuch des stillen Wiederanhaengens (`attemptReattach`): seine
        // Fehler bleiben bis zum Anhaengen still -- ob es weitergeht,
        // entscheidet die Reihe, nicht das Banner. Die letzte Meldung behaelt
        // sie fuer die Konsole. Die Eingabe sperrt `render` (Hinweis steht).
        const reattach = view.reattach;
        const attempt = reattach !== null && reattach.series.attaching &&
          reattach.key === wantKey && reattach.runtimeId === runtimeHostId;
        // Ebenso still: eine beendete Session, etwa die wiederhergestellte
        // Kachel einer toten Pane nach dem Neustart. Ihr Oeffnen scheitert am
        // Waechter, und die Sperrleiste nennt den Grund schon (UX-Spec §5.5);
        // ein Banner daneben sagte dasselbe noch einmal (M1-Tor, Schritt 8).
        let quietErrors = attempt || resolved.status === "ended";
        const ownAttempt = (): ReattachEntry | null =>
          attempt && view.reattach === reattach && reattach.series.attaching ? reattach : null;
        let capacityDetail: string | null = null;
        // Das Terminal, dem die Rueckrufe unten gehoeren. `null`, solange
        // `mountTerminal` noch baut: bei voller Schlange meldet es dort schon
        // `onQueued(true)`, und `handle` liesse sich da noch nicht lesen (eine
        // `const` vor ihrer Zuweisung wirft).
        let own: TerminalHandle | null = null;
        // Die Sperre faellt mit diesem Terminal (`release` unten), die
        // Sperrleiste darum schon vor dem Messen: sonst maesse `mountTerminal`
        // 32 px zu niedrig, und ihr Verschwinden im verschachtelten Durchgang
        // kostete ein zweites `resize_terminal`, etwa nach dem Neuverbinden des
        // Hosts (Spec 2026-10-19 §4.5). "Reconnect" loest die Sperre schon vor
        // dem Montieren (`requestReconnect`).
        if (resolved.inputLocked) view.refs.lockStrip.hidden = true;
        const handle = mountTerminal(
          view.refs.terminal,
          // Hier verlaeuft die Grenze: unterhalb von `mountTerminal` gilt
          // die LAUFZEIT-ID (jeder `invoke` dort meint eine lebende
          // Verbindung, und `terminal://connection-lost` meldet ebenfalls
          // sie), oberhalb -- in den beiden Rueckrufen unten -- die
          // settings.toml-ID.
          runtimeHostId,
          resolved.name,
          (error) => {
            if (!quietErrors && error.kind === "open" && isCapacityError(error.detail)) {
              // `terminal.ts` ruft danach `onOpenFailed`; dort geht es weiter.
              capacityDetail = error.detail;
              return;
            }
            if (!quietErrors) opts.onTerminalError(terminalErrorText(error.kind, resolved.name), error.detail);
            else if (reattach) reattach.lastError = error.detail;
          },
          {
            searchTexts: terminalSearchTexts(),
            linkHint: t("terminal.link.hint"),
            linkConfirmTexts: { open: t("terminal.link.open"), note: t("terminal.link.differs") },
            menuTexts: terminalMenuTexts(),
            onCopied: () => showCopied(view),
            onSize: (cols, rows) => updateNarrow(view, cols, rows),
            onCloseTerminal: () => opts.onCloseTerminal(resolved.hostId, resolved.name, resolved.socket),
            onMoveTile: (delta) => moveTileByUser(view.id, delta),
            canMoveTile: (delta) => {
              const position = state.tilePosition(view.id);
              return position !== null && state.tiles[position + delta] !== undefined;
            },
            // Diese Ansicht ist der einzige Ort, der `mountTerminal`
            // aufruft und das Signal damit ueberhaupt aufnehmen kann. Sie
            // entscheidet nur, ob die Kachel sich still neu anhaengt
            // (UX-Spec §5.5), und meldet es weiter (siehe
            // `GridOptions.onConnectionLost`).
            onConnectionLost: () => onTerminalLost(view, resolved, runtimeHostId),
            onOpened: () => {
              quietErrors = false;
              view.hadChannel = true;
              view.replaced = false;
              const entry = ownAttempt();
              entry?.series.opened();
              // Spec 2026-10-19 §8.1 (Schritt 3): wer angehaengt hat, wartet
              // nicht mehr. Gewoehnlich hat `onQueued(false)` das schon vor dem
              // Senden gemeldet; ohne diese Zeilen bliebe "Opening…" sonst
              // stehen, bis etwas anderes neu zeichnet.
              const wasQueued = view.queued;
              view.queued = false;
              if (entry || wasQueued) render();
            },
            // Spec 2026-10-19 §8.1 (Schritt 3): dieselbe Schlange fuer jedes
            // Terminal dieses Rasters (`openQueue`). Ob es auf einen Platz
            // wartet, meldet es selbst; ein entsorgtes Terminal meldet nichts
            // mehr, das diese Kachel angeht (Review Focus 2).
            openQueue,
            onQueued: (queued) => {
              if (!isLive(view) || (own !== null && view.handle !== own)) return;
              setQueued(view, queued);
            },
            ...(resolved.socket === "default" ? { socket: "default" as const } : {}),
            sessionId: resolved.sessionId,
            serverPid: resolved.serverPid,
            serverStartTime: resolved.serverStartTime,
            windowId: resolved.windowId,
            paneId: resolved.paneId,
            panePid: resolved.panePid,
            // Dieselbe Closure wie `onCloseTerminal` daher auch dieselbe
            // Zusicherung: Host und Session stehen vom MOUNTZEITPUNKT fest,
            // nicht vom Zeitpunkt der Ablehnung. Der Rueckruf kann also
            // keine inzwischen andere Kachel treffen. Ein gescheiterter
            // Versuch der Reihe sperrt erst, wenn sie aufgibt.
            onOpenFailed: () => {
              const entry = ownAttempt();
              if (entry) onReattachFailed(view, entry);
              else if (capacityDetail !== null && closesOnCapacity(view, resolved.inputLocked)) {
                opts.onTerminalCapacity(resolved.hostId, resolved.name, capacityDetail, resolved.socket);
              } else if (capacityDetail !== null) {
                // Spec 2026-10-19 §1 Nr. 1, §5.8: keine frische Kachel (siehe
                // `closesOnCapacity`) geht. Sie bleibt -- mit Sperrleiste und
                // "Reconnect"; das Banner nennt die Kanalgrenze, der Rohtext
                // steht hinter "Copy details".
                opts.onTerminalError(t("terminal.capacity", { host: resolved.hostLabel }), capacityDetail);
                opts.onTerminalOpenFailed(resolved.hostId, resolved.name, resolved.socket);
              } else opts.onTerminalOpenFailed(resolved.hostId, resolved.name, resolved.socket);
            },
          },
        );
        own = handle;
        view.handle = handle;
        // Beide Buchhaltungsfelder zusammen -- siehe `TileView`.
        view.mountedKey = wantKey;
        view.mountedRuntimeId = runtimeHostId;
        mounted.add(view.id);
        const active = document.activeElement;
        if (view.refocus === wantKey && (active === null || active === document.body)) handle.focus();
        view.refocus = null;
        // Satz 2 des Sperrvertrags: eine frisch montierte xterm-Instanz hat
        // `disableStdin` NIE gesetzt -- sie nimmt Eingaben an, ganz gleich,
        // was am Sessioneintrag steht. Genau daher kam das gemeldete
        // dauerhafte "Input locked" ueber einem Terminal, in dem der Nutzer
        // voellig normal tippte: der Handle ging (damals beim Layoutwechsel,
        // heute etwa mit der alten Verbindung eines neu verbundenen Hosts),
        // der `sessionKey` (und mit ihm die Sperre) blieb stehen, und
        // montiert wurde frisch.
        //
        // Gesammelt werden nur die Schluessel, deren Sperre dadurch
        // TATSAECHLICH faellt -- nicht alle frisch montierten. Sonst liefe
        // bei jedem gewoehnlichen Oeffnen ein zweiter, leerer
        // Renderdurchgang.
        //
        // Eine Zustandsbedingung braucht es hier nicht: wegen `canMount`
        // impliziert ein frischer Kanal einen verbundenen Host.
        if (resolved.inputLocked) release.push(wantKey);
      }
    }
    return { lock, release, mounted };
  }

  /** Lag der Tastaturfokus in einer Kachel, die gerade entfernt wurde? */
  let focusAfterClose = false;

  /** Legt fuer jede neue Kachel ihre Ansicht an und entsorgt die jeder
   * geschlossenen -- der einzige Ort, an dem Kachelknoten entstehen und
   * vergehen. Neue Knoten haengen hinten an: die DOM-Reihenfolge folgt der
   * Entstehung, nicht der Anzeige (Spec 2026-10-19 §4.3); darum nennt die
   * Live-Region bei jedem Wechsel Nummer und Session (Task 8). */
  function syncViews(): void {
    const live = new Set(state.tiles.map((tile) => tile.id));
    for (const [id, view] of views) {
      if (live.has(id)) continue;
      if (view.refs.root.contains(document.activeElement)) focusAfterClose = true;
      disposeView(view);
      views.delete(id);
    }
    for (const tile of state.tiles) {
      if (views.has(tile.id)) continue;
      const refs = buildTile(tile.id);
      gridEl.appendChild(refs.root);
      views.set(tile.id, {
        id: tile.id,
        refs,
        handle: null,
        mountedKey: null,
        mountedRuntimeId: null,
        refocus: null,
        reattach: null,
        copiedTimer: undefined,
        flashTimer: undefined,
        lastLocked: false,
        hadChannel: false,
        replaced: false,
        reconnectRequested: false,
        queued: false,
        rect: null,
      });
    }
  }

  function disposeView(view: TileView): void {
    cancelReattach(view);
    // Wie in `reconcile`: das Warten geht mit dem Terminal.
    view.queued = false;
    view.handle?.dispose();
    view.handle = null;
    window.clearTimeout(view.copiedTimer);
    window.clearTimeout(view.flashTimer);
    view.refs.root.remove();
  }

  /** Spalt-Anteile (Spec 2026-10-19 §4.4): sie leben im Raster, nicht in der
   * Datei, und gelten nur fuer die Kachelzahl, fuer die sie gezogen wurden. */
  let fractions: TileFractions = EQUAL_FRACTIONS;
  let fractionsCount = 0;
  /** Die Spalte der letzten Lage; ein Spalt-Element nennt seinen Index. */
  let currentSplits: Split[] = [];
  const splitEls: HTMLDivElement[] = [];

  /** Jede sichtbare Kachel durch den EINEN entprellten Pfad (`terminal.ts`). */
  function refitVisible(): void {
    for (const id of state.visibleTileIds()) views.get(id)?.handle?.refit();
  }

  function splitElement(index: number): HTMLDivElement {
    const existing = splitEls[index];
    if (existing) return existing;
    const el = document.createElement("div");
    el.className = "tile-split";
    // Nur fuer den Zeiger. Die Tastatur ordnet ueber Strg+Umschalt+Bild auf/ab
    // (Task 7), die Groesse folgt sonst der Kachelzahl.
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("pointerdown", (event) => onSplitPointerDown(event, el));
    el.addEventListener("dblclick", resetFractions);
    gridEl.appendChild(el);
    splitEls[index] = el;
    return el;
  }

  /** Die Anteile nach einem Zug am Spalt `split` um `deltaPx`. */
  function movedFractions(base: TileFractions, split: Split, deltaPx: number): TileFractions {
    const counts = rowCounts(state.tiles.length);
    if (split.kind === "row") {
      const shares = base.rows ?? equalShares(counts.length);
      const space = spaceFor(gridEl.clientHeight, counts.length);
      return { ...base, rows: moveBoundary(shares, split.index, deltaPx, space, MIN_TILE_HEIGHT) };
    }
    const row = split.row ?? 0;
    const shares = base.cols[row] ?? equalShares(counts[row]);
    const space = spaceFor(gridEl.clientWidth, counts[row]);
    const cols = [...base.cols];
    cols[row] = moveBoundary(shares, split.index, deltaPx, space, MIN_TILE_WIDTH);
    return { ...base, cols };
  }

  function onSplitPointerDown(event: PointerEvent, el: HTMLDivElement): void {
    if (disposed || event.button !== 0) return;
    const split = currentSplits[Number(el.dataset.split)];
    if (!split) return;
    // Sonst markierte der Zug Text in den Kacheln (wie am Seitenleistengriff).
    event.preventDefault();
    const start = fractions;
    // Eine andere Kachelzahl mitten im Zug (eine Session verschwindet, eine
    // Kachel kommt dazu): `updateLayout` hat die Anteile schon zurueckgesetzt
    // (Spec §4.4), und `start` und `split` beschreiben eine Lage, die es nicht
    // mehr gibt. Der Zug aendert dann nichts mehr; vermessen hat die neue Zahl.
    const count = state.tiles.length;
    const outdated = (): boolean => state.tiles.length !== count;
    trackPointerDrag(el, event, 0, {
      start() {
        el.classList.add("tile-split--dragging");
      },
      move(_moveEvent, dx, dy) {
        if (outdated()) return;
        // Die Kacheln folgen dem Zeiger; vermessen wird erst beim Loslassen.
        fractions = movedFractions(start, split, split.kind === "col" ? dx : dy);
        updateLayout();
      },
      end(_upEvent, dx, dy) {
        el.classList.remove("tile-split--dragging");
        if (outdated()) return;
        // Die Lage des Loslassens gilt, nicht die der letzten (womoeglich
        // zusammengefassten) Bewegung -- wie am Griff der Seitenleiste.
        fractions = movedFractions(start, split, split.kind === "col" ? dx : dy);
        updateLayout();
        refitVisible();
      },
      cancel() {
        el.classList.remove("tile-split--dragging");
        if (outdated()) return;
        fractions = start;
        updateLayout();
      },
    });
  }

  /** Doppelklick auf einen Spalt (Spec §4.4): wieder alle gleich gross. */
  function resetFractions(): void {
    if (disposed || fractions === EQUAL_FRACTIONS) return;
    fractions = EQUAL_FRACTIONS;
    updateLayout();
    refitVisible();
  }

  /** Spec 2026-10-19 §5.4: ein Zug am Kachelkopf tauscht zwei Kacheln. Die
   * Quelle wird blass, das Ziel bekommt die Kontur; erst beim Loslassen
   * aendert sich die Reihenfolge. */
  function startHeadDrag(id: number, event: PointerEvent): void {
    const view = views.get(id);
    // Maximiert ist nur eine Kachel zu sehen, es gibt nichts zum Tauschen.
    if (!view || state.maximizedTile !== null) return;
    let target: TileView | null = null;
    const setTarget = (next: TileView | null): void => {
      if (next === target) return;
      target?.refs.root.classList.remove("tile--drop-target");
      target = next;
      target?.refs.root.classList.add("tile--drop-target");
    };
    const clear = (): void => {
      view.refs.root.classList.remove("tile--drag-source");
      setTarget(null);
    };
    trackPointerDrag(view.refs.head, event, HEAD_DRAG_THRESHOLD, {
      start() {
        view.refs.root.classList.add("tile--drag-source");
      },
      move(moveEvent) {
        const hit = viewAt(moveEvent.clientX, moveEvent.clientY);
        setTarget(hit !== view ? hit : null);
      },
      end(upEvent) {
        // Das Ziel ist die Kachel unter dem Loslassen, nicht unter der
        // letzten (womoeglich zusammengefassten) Bewegung.
        const hit = viewAt(upEvent.clientX, upEvent.clientY);
        setTarget(hit !== view ? hit : null);
        const other = target;
        clear();
        if (!other || !isLive(view) || !isLive(other)) return;
        state.swapTiles(view.id, other.id);
        announceMoved(view.id);
        flashTile(view);
      },
      cancel: clear,
    });
  }

  /** Die sichtbare Kachel unter einem Punkt in Fensterkoordinaten -- ueber die
   * Lage aus `updateLayout`, nicht ueber `elementFromPoint`: die Quelle liegt
   * selbst unter dem Zeiger. */
  function viewAt(clientX: number, clientY: number): TileView | null {
    const origin = gridEl.getBoundingClientRect();
    const x = clientX - origin.left;
    const y = clientY - origin.top;
    for (const view of views.values()) {
      const rect = view.rect;
      if (rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return view;
    }
    return null;
  }

  /** Spec §5.4: nach einem Tausch oder Verschieben nennt die Live-Region
   * Session und neue Position. Die DOM-Reihenfolge folgt der Entstehung, ein
   * Screenreader erfuehre den Wechsel sonst nicht. */
  function announceMoved(id: number): void {
    const position = state.tilePosition(id);
    const key = state.tileById(id)?.sessionKey;
    if (position === null || !key) return;
    const name = resolveSession(state, key)?.name ?? "";
    announce.textContent = t("tile.moved", { session: name, index: String(position + 1) });
  }

  /** Spec 2026-10-19 §6.3, Schritt 1: die Kontur leuchtet 600 ms in
   * `--ab-focus-ring` auf. Das Zeichnen des Rahmens folgt in Schritt 2. */
  function flashTile(view: TileView): void {
    window.clearTimeout(view.flashTimer);
    view.refs.root.classList.add("tile--flash");
    view.flashTimer = window.setTimeout(() => {
      view.flashTimer = undefined;
      view.refs.root.classList.remove("tile--flash");
    }, FLASH_MS);
  }

  /** Spec 2026-10-19 §4.3, §6.3: die Live-Region nennt Nummer und Session
   * einer Kachel ("Terminal 2: api"). */
  function announceTile(id: number): void {
    const position = state.tilePosition(id);
    const key = state.tileById(id)?.sessionKey;
    if (position === null || !key) return;
    const name = resolveSession(state, key)?.name ?? "";
    announce.textContent = t("tile.revealed", { index: String(position + 1), session: name });
  }

  /** Wiederfinden (§6.2): eine gewaehlte Kachel leuchtet auf, und die
   * Live-Region nennt Nummer und Session -- auch im Kontrastmodus, in dem
   * die Kontur kaum zu sehen ist. */
  function revealTile(id: number): void {
    const view = views.get(id);
    if (!view || state.tilePosition(id) === null) return;
    flashTile(view);
    announceTile(id);
  }

  /** Strg+Umschalt+Bild auf/ab und das Terminalmenue (§5.4). */
  function moveTileByUser(id: number, delta: 1 | -1): void {
    if (disposed) return;
    if (state.moveTile(id, delta) === null) return;
    announceMoved(id);
    // Auch die verschobene Kachel leuchtet auf (§6.2).
    const moved = views.get(id);
    if (moved) flashTile(moved);
  }

  /** Lage aller Kacheln aus der gemessenen Flaeche (Spec 2026-10-19 §4.2,
   * §4.3): sichtbare absolut nach `layoutTiles`, verborgene mit
   * `display: none` und angehaltenem Messen (`setHidden`, §8.1 Schritt 3),
   * dazu die Spalte dazwischen. Muss vor `reconcile` laufen -- `mountTerminal`
   * misst beim Bau synchron (siehe `render`). */
  function updateLayout(): void {
    // Eine neue Kachelzahl: wieder alle gleich gross (Spec §4.4). Maximieren
    // aendert die Zahl der Kacheln nicht, nur die der sichtbaren.
    if (state.tiles.length !== fractionsCount) {
      fractions = EQUAL_FRACTIONS;
      fractionsCount = state.tiles.length;
    }
    const visible = state.visibleTileIds();
    const { rects, splits } = layoutTiles(
      visible.length,
      gridEl.clientWidth,
      gridEl.clientHeight,
      state.maximizedTile === null ? fractions : EQUAL_FRACTIONS,
    );
    const shown = new Set(visible);
    visible.forEach((id, i) => {
      const view = views.get(id);
      if (!view) return;
      const style = view.refs.root.style;
      const rect = rects[i];
      style.display = "";
      // Wieder sichtbar misst sie beim naechsten Refit; den loest `render`
      // aus, denn mit dem Maximieren aendert sich die Signatur.
      view.handle?.setHidden(false);
      style.left = `${rect.x}px`;
      style.top = `${rect.y}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;
      view.rect = rect;
    });
    for (const [id, view] of views) {
      if (shown.has(id)) continue;
      view.refs.root.style.display = "none";
      // Terminal und Kanal bleiben; verborgen misst und sendet es nur nicht.
      view.handle?.setHidden(true);
      view.rect = null;
    }
    currentSplits = splits;
    splits.forEach((split, i) => {
      const el = splitElement(i);
      el.hidden = false;
      el.dataset.split = String(i);
      el.dataset.kind = split.kind;
      el.style.left = `${split.rect.x}px`;
      el.style.top = `${split.rect.y}px`;
      el.style.width = `${split.rect.width}px`;
      el.style.height = `${split.rect.height}px`;
    });
    for (let i = splits.length; i < splitEls.length; i++) splitEls[i].hidden = true;
  }

  /** Was die Pixelgroesse der Kacheln bestimmt, ausser Fenster und
   * Seitenleiste: Zahl und Reihenfolge der Kacheln und das Maximieren. */
  function layoutSignature(): string {
    return `${state.tiles.map((tile) => tile.id).join(",")}|${state.maximizedTile ?? ""}`;
  }

  /** Liefert, ob die Kachel gerade eine gesperrte Eingabe zeigt (`locked`,
   * mit Sperrleiste) oder den ruhigen Hinweis -- "Reconnecting…" oder,
   * solange ihr Terminal auf einen Platz wartet, "Opening…" (`quiet`) --, und
   * mit welchem `view.queued` das berechnet ist (`queued`: aendert der Abgleich
   * es, zieht `render` den Kopf nach). `render()` sammelt das ueber alle
   * Kacheln (Nachtrag B, Punkt 3), um danach GENAU die Kacheln zu refitten,
   * deren Sperrzustand sich in diesem Render geaendert hat (Designsystem §8.3:
   * der Streifen kostet zwei Terminalzeilen, sein Erscheinen/Verschwinden
   * AENDERT die Kachelgroesse tatsaechlich; der Hinweis im Kopf aendert sie
   * nicht), und um in beiden Faellen die Eingabe zu sperren. */
  function updateTileHead(view: TileView): { locked: boolean; quiet: boolean; queued: boolean } {
    const refs = view.refs;
    const position = state.tilePosition(view.id);
    refs.root.dataset.position = position === null ? "" : String(position);
    // Spec 2026-10-19 §4.1: die Nummer ist Position + 1 -- dieselbe, die
    // Strg+Umschalt+1-9 trifft.
    if (position !== null) {
      refs.badge.textContent = String(position + 1);
      refs.badge.setAttribute("aria-label", t("tile.index", { index: String(position + 1) }));
    } else {
      refs.badge.textContent = "";
      refs.badge.removeAttribute("aria-label");
    }

    const key = state.tileById(view.id)?.sessionKey ?? null;
    const resolved = key === null ? null : resolveSession(state, key);
    refs.title.textContent = resolved?.name ?? "";
    refs.host.textContent = resolved?.hostLabel ?? "";
    refs.tmuxMark.hidden = resolved?.socket !== "default";

    // Spec 8.4, Signal 1+2 (Akzentkontur innen per CSS ueber `.tile.focused`,
    // Kopf-Flaechenstufe+Titelgewicht ebenfalls per CSS ueber dieselbe
    // Klasse). Signal 3 (Abzeichen hohl->gefuellt) folgt unten aus derselben
    // Klasse -- alle drei aus EINER Quelle, nicht drei einzeln gepflegten.
    const focused = state.focusedTile === view.id;
    refs.root.classList.toggle("focused", focused);
    if (focused) {
      refs.root.setAttribute("aria-current", "true");
      refs.focusedFlag.hidden = false;
      refs.focusedFlag.textContent = t("tile.focused");
    } else {
      refs.root.removeAttribute("aria-current");
      refs.focusedFlag.hidden = true;
      refs.focusedFlag.textContent = "";
    }

    const maximized = state.maximizedTile === view.id;
    swapIcon(refs.maximizeIcon, maximized ? "minimize-2" : "maximize-2");
    refs.maximizeBtn.classList.toggle("tile-btn--wide", maximized);
    if (maximized) {
      // Designsystem §7.2: "Chip ist Text plus Glyphe, nie nur Icon" --
      // anders als beim allgemeinen Icon-plus-Tooltip-Fall unten (Designsystem
      // §9 Punkt 11 erlaubt dort Tooltip ODER Text) ist hier sichtbarer Text
      // verbindlich. Kein separates `aria-label`: der zugaengliche Name
      // ergibt sich aus dem sichtbaren Text selbst (WCAG 2.5.3, "Label in
      // Name") -- ein davon abweichendes `aria-label` waere fuer
      // Sprachsteuerung irrefuehrend.
      // UX-Spec §7.9: "Maximized · Ctrl+Shift+M", das Kuerzel aus der Tabelle.
      // Escape ausserhalb des Terminals stellt weiterhin auch wieder her.
      refs.maximizeLabel.textContent = t("tile.maximized.hint", { maximize: DEFAULT_KEYMAP["tile.maximize"] });
      refs.maximizeBtn.removeAttribute("aria-label");
      refs.maximizeBtn.title = titleWithShortcut(t("tile.restore"), "tile.maximize");
    } else {
      refs.maximizeLabel.textContent = "";
      refs.maximizeBtn.setAttribute("aria-label", t("tile.maximize"));
      // UX-Spec §8.4: Tooltip mit Kuerzel, der zugaengliche Name ohne.
      refs.maximizeBtn.title = titleWithShortcut(t("tile.maximize"), "tile.maximize");
    }

    // Nachtrag B, Punkt 3 (Designsystem §8.3): drei Kanaele fuer denselben
    // Zustand -- Kachelkopf-Flaeche (CSS ueber `.tile.locked`), der Chip im
    // Kopf, der Streifen darunter. "Kein Zustand allein ueber Farbe" gilt
    // auch hier: Geometrie (Dreieck statt Quadrat, siehe `.ind-warn`) UND
    // Text ("Disconnected", UX-Spec §10 -- vorher "Not attached" und davor
    // "Input locked", was einen MECHANISMUS benannte statt einer Lage) tragen
    // es zusaetzlich zur `--ab-warn`-Faerbung.
    //
    // Kanaltrennung (Designsystem §8.3, letzter Absatz): `.locked` faerbt
    // NUR den Kopf um (CSS), nie die Fokuskontur der Kachel -- die bleibt
    // ausschliesslich `.tile.focused`s Sache, unabhaengig davon, ob diese
    // Kachel zusaetzlich gesperrt ist.
    // UX-Spec §5.4, §5.5: haengt sich die Kachel still neu an oder wird ihr
    // Host neu verbunden, steht der ruhige Hinweis "Reconnecting…" im Kopf --
    // STATT der Sperre, nicht zusaetzlich zu ihr. Die Eingabe bleibt dabei
    // gesperrt (`render`, nach dem Abgleich).
    const reconnecting = resolved !== null && (resolved.hostReconnecting || (view.reattach?.series.active ?? false));
    const locked = !reconnecting && (resolved?.inputLocked ?? false);
    // Spec 2026-10-19 §8.1 (Schritt 3): wartet das Terminal auf einen Platz
    // fuer sein `open_terminal`, sagt derselbe Chip "Opening…", und die Kachel
    // traegt `tile--opening` (fuer Abnahme und Messung). "Reconnecting…" und
    // "Disconnected" gehen vor, in dieser Reihenfolge: eine wartende Kachel
    // eines ausgefallenen Hosts zeigt "Reconnecting…" oder die Sperrleiste mit
    // dem Weg zurueck, und ihr Warten besteht dahinter weiter. Die Eingabe ist
    // auch beim Warten gesperrt (`render`).
    const opening = view.queued && !locked && !reconnecting;
    const quiet = reconnecting || opening;
    refs.quietChip.hidden = !quiet;
    // Auch verborgen gesetzt: der Chip traegt immer einen der beiden Texte.
    refs.quietText.textContent = t(opening ? "terminal.opening" : "terminal.reconnecting");
    refs.root.classList.toggle("tile--opening", opening);
    refs.root.classList.toggle("locked", locked);
    refs.lockChip.hidden = !locked;
    // Dieselbe Pille wie in der Seitenleiste (status-pill.ts). Eine gesperrte
    // Kachel zeigt nur die Sperre; ihr Kanal ist fort, der Status waere dort
    // ohnehin keine Aussage ueber das, was man sieht. Ebenso steht der ruhige
    // Chip allein -- auch "Opening…": die wartende Kachel zeigt noch nichts.
    const pill =
      locked || quiet || resolved === null
        ? null
        : agentStatusView(
            resolved.status,
            resolved.statusReason,
            state.isSessionStatusCurrent(resolved.hostId, resolved.name, resolved.socket),
            state.sessionStatusObservedAt(resolved.hostId, resolved.name, resolved.socket),
          );
    refs.agentSlot.hidden = pill === null;
    if (pill) {
      // In einer schmalen Kachel zeigt die Pille nur ihren Punkt (styles.css);
      // ihr Wort steht darum auch im Tooltip, vor dem Grund.
      const element = buildStatusPill(pill);
      if (pill.title !== pill.word) element.title = `${pill.word} · ${pill.title}`;
      refs.agentSlot.replaceChildren(element);
    } else refs.agentSlot.replaceChildren();
    refs.lockStrip.hidden = !locked;
    // Ohne `{host}` seit B4, und das ist die Aussage: die Meldung nannte den
    // Host als Schuldigen ("Connection to {host} was lost"), obwohl im
    // haeufigen Fall genau EIN Kanal gestorben ist -- der Host antwortet,
    // die Sessionliste kommt durch, andere Kacheln desselben Hosts arbeiten
    // weiter. Sie sagt jetzt, was gilt und was zurueckfuehrt.
    //
    // UX-Spec §5.5: ist die Session auf dem Host beendet (die Statusabfrage
    // fand sie in keiner vollstaendigen Liste mehr), nennt die Leiste diesen
    // Grund, und "Reconnect" faellt weg -- es gibt nichts mehr anzuhaengen.
    const ended = locked && (resolved?.status === "ended" || view.replaced);
    refs.lockMessage.textContent = locked
      ? ` — ${t(ended ? "terminal.sessionEnded" : "terminal.connectionLost")}`
      : "";
    // Abnahme B5: die Meldung bleibt auf einer Zeile und kuerzt in einer
    // schmalen Kachel (styles.css); den vollen Text samt "Disconnected" traegt
    // der Tooltip, hier an der einzigen Stelle, die ihn setzt.
    if (locked) refs.lockText.title = refs.lockText.textContent ?? "";
    else refs.lockText.removeAttribute("title");
    refs.lockReconnectBtn.hidden = ended;
    return { locked, quiet, queued: view.queued };
  }

  let lastMaximizedAnnounced: number | null = null;
  function maybeAnnounceMaximize(): void {
    if (state.maximizedTile !== null && state.maximizedTile !== lastMaximizedAnnounced) {
      const position = state.tilePosition(state.maximizedTile);
      const maximize = DEFAULT_KEYMAP["tile.maximize"];
      announce.textContent =
        position === null
          ? t("tile.maximized.announceNoIndex", { maximize })
          : t("tile.maximized.announce", { index: String(position + 1), maximize });
    }
    lastMaximizedAnnounced = state.maximizedTile;
  }

  let lastSignature = "";

  /** Steht auf `true`, waehrend der Sperrabgleich am Ende von `render()`
   * laeuft -- siehe dort. */
  let syncingLocks = false;

  /** Spec 2026-10-19 §8.1 (Schritt 3): steht auf `true`, solange `render()`
   * laeuft. Meldet ein Terminal darin, ob es auf einen Platz wartet (beim
   * Montieren in `reconcile`, oder weil eine entsorgte Kachel ihren Platz
   * freigibt, in `syncViews` und `reconcile`), zeichnet `setQueued` nicht
   * selbst neu: ein Neuzeichnen mitten im Abgleich montierte dieselbe Kachel
   * ein zweites Mal, denn ihr `mountTerminal` ist dann noch nicht
   * zurueckgekehrt; und gibt die Kachel beim Entsorgen ihren Platz frei,
   * entsorgte es sie ein zweites Mal, denn ihr `handle` steht dann noch. Was
   * `syncViews` meldet, sehen die Koepfe danach schon; was `reconcile`
   * meldet, zieht `renderPass` nach dem Abgleich nach. */
  let rendering = false;

  function render(): void {
    if (disposed) return;
    // Gesichert statt bloss geleert: der Sperrabgleich am Ende faehrt einen
    // verschachtelten Durchgang, und erst danach endet der aeussere.
    const outer = rendering;
    rendering = true;
    try {
      renderPass();
    } finally {
      rendering = outer;
    }
  }

  function renderPass(): void {
    // Vor dem Kachelkopf: der Hinweis "Reconnecting…" darf eine Reihe nicht
    // ueberleben, die mit diesem Zustand endet (siehe dort).
    dropStaleReattaches();
    syncViews();

    // Nachtrag B, Punkt 2: MUSS vor `updateLayout()` entschieden UND
    // angewendet werden -- dieselbe Korrektheitsbedingung wie der Kommentar
    // darunter beschreibt, nur eine Ebene hoeher. Wechselt dieses Render von
    // leer auf belegt (die erste Session wird angelegt), muss `.grid` schon
    // VOR `updateLayout()`s Messung sichtbar sein -- sonst maesse
    // `updateLayout()` gegen eine per `hidden` kollabierte Box, und
    // `reconcile()`s `mountTerminal` fittete direkt im Anschluss gegen
    // dieselbe falsche Groesse (der Fall, den `Review-Befund M-1` unten
    // eigentlich schon einmal geschlossen hat).
    const gridEmpty = state.tiles.length === 0;
    gridEl.hidden = gridEmpty;
    emptyState.hidden = !gridEmpty;
    // Spec 10: die Pille steht NUR bei verbundenem Host, sonst der Satz, der
    // sagt, was zuerst zu tun ist -- nie beides, nie keins von beidem.
    const connected = hasConnectedHost();
    emptyButton.hidden = !connected;
    emptyConnectFirst.hidden = connected;
    // Task 16, Punkt D: ohne verbundenen Host bleibt EIN Satz stehen. "Pick a
    // session from the sidebar, or start a new one." verweist dann auf zwei
    // Dinge, die es noch gar nicht gibt -- zwei Saetze uebereinander, von
    // denen der erste in die Irre fuehrt.
    emptyBody.hidden = !connected;

    // Reihenfolge ist eine Korrektheitsbedingung (Review-Befund M-1): Lage
    // und Kachelkopf stehen fest, BEVOR `reconcile` montiert. `mountTerminal`
    // misst beim Bau synchron und meldet genau diese Groesse mit
    // `open_terminal` (Spec 2026-10-19 §4.5: eine neue Kachel montiert mit
    // ihrer Endgeometrie).
    updateLayout();
    const heads = new Map<number, { locked: boolean; quiet: boolean; queued: boolean }>();
    for (const view of views.values()) heads.set(view.id, updateTileHead(view));

    const locks = reconcile();

    // Spec 2026-10-19 §8.1 (Schritt 3): der Abgleich kann eine Kachel in die
    // Schlange stellen (ihr frisches Terminal meldet das noch in
    // `mountTerminal`) oder herausnehmen (entsorgt, oder eine entsorgte gab
    // ihr den Platz). Ihr Kopf stand dann auf dem Stand davor und zieht hier
    // nach, im selben Durchgang. Lage und Sperrleiste bleiben dabei, wie
    // `mountTerminal` sie gemessen hat: das Warten zeigt nur der Chip im Kopf.
    for (const view of views.values()) {
      if (heads.get(view.id)?.queued !== view.queued) heads.set(view.id, updateTileHead(view));
    }

    // UX-Spec §5.4, §5.5: wo "Reconnecting…" oder die Sperrleiste steht, nimmt
    // das Terminal keine Eingabe an -- auch wenn sein Kanal den Verlust noch
    // nicht selbst gemeldet hat (etwa weil ein Versuch die alte Verbindung
    // trennt, bevor jedes Terminal ihn melden konnte). Nach `reconcile`, damit
    // auch ein eben montiertes Terminal die Sperre bekommt; der verschachtelte
    // Durchgang am Ende (`applyInputLocks`) zieht sie fuer frisch entsperrte
    // Kacheln wieder zurueck. Ebenso bei "Opening…" (`quiet`, Spec 2026-10-19
    // §8.1): das wartende Terminal hat noch keinen Kanal, und solange es
    // wartet, geht keine Eingabe hinaus (Review Focus 5).
    for (const view of views.values()) {
      const head = heads.get(view.id);
      view.handle?.setInputLocked(Boolean(head?.locked || head?.quiet));
    }

    // Spec 2026-10-19 §5.5: lag der Tastaturfokus in einer geschlossenen
    // Kachel, folgt er der Kachel, die jetzt den Fokus hat; sonst fiele er auf
    // <body>. Das haelt den Fokus, es nimmt ihn nicht (wie `refocus`). Den
    // Fokuswechsel hat `AppState` beim Schliessen schon gemacht, das `focusin`
    // der Nachbarin sieht darum keinen und bliebe stumm (§4.3): hier nennt die
    // Live-Region Nummer und Session, ohne Aufleuchten, das gehoert der Wahl
    // (§6.2). Hat die Nachbarin kein Terminal, faellt der Fokus auf <body>;
    // dann folgt ihm nichts, und es gibt nichts anzusagen.
    //
    // Spec 2026-10-19 §8.1 (Schritt 3): wie in `focusActiveTile` bekommt nur
    // eine sichtbare Kachel Fokus und Ansage. Verborgene behalten ihr Terminal,
    // und `AppState` gibt den Fokus beim Schliessen auch an eine verborgene
    // Nachbarin. Schliesst die maximierte Kachel, endet das Maximieren, und alle
    // sind sichtbar; die Wache greift nur, wenn eine verborgene den Fokus hielt.
    if (focusAfterClose) {
      focusAfterClose = false;
      const id = state.focusedTile;
      const handle = id === null ? null : views.get(id)?.handle;
      if (id !== null && handle && state.visibleTileIds().includes(id)) {
        handle.focus();
        announceTile(id);
      }
    }

    maybeAnnounceMaximize();

    // Spec 2026-10-19 §4.5: neu vermessen nach jeder Aenderung von Zahl oder
    // Reihenfolge der Kacheln und beim Maximieren, und je Kachel, deren
    // Sperrleiste kommt oder geht (der 32-px-Streifen kostet Zeilen,
    // Designsystem §8.3). Ein Fokuswechsel aendert nichts davon. `refit()`
    // laeuft durch den EINEN entprellten Pfad in `terminal.ts`, und der
    // schickt `resize_terminal` nur, wenn sich Spalten oder Zeilen aendern --
    // "alle sichtbaren" heisst darum genau "jede Kachel, deren Groesse sich
    // aendert". Frisch montierte haben schon mit ihrer Endgeometrie gemessen.
    // Verborgene refittet das Raster nie; Zurueckholen aendert die Signatur
    // und refittet so jede wieder sichtbare Kachel genau einmal (Spec
    // 2026-10-19 §8.1).
    const signature = layoutSignature();
    const sizeRelevantChange = signature !== lastSignature;
    for (const id of state.visibleTileIds()) {
      const view = views.get(id);
      if (!view?.handle || locks.mounted.has(id)) continue;
      const locked = heads.get(id)?.locked ?? false;
      if (sizeRelevantChange || locked !== view.lastLocked) view.handle.refit();
    }
    for (const view of views.values()) view.lastLocked = heads.get(view.id)?.locked ?? false;
    lastSignature = signature;

    // ALLERLETZTE Anweisung, und das ist eine Korrektheitsbedingung, keine
    // Ordnungsliebe: `applyInputLocks` benachrichtigt, `render` ist der
    // Abonnent -- der Aufruf faehrt einen verschachtelten Renderdurchgang.
    // Stuende er vor den Buchhaltungsschreibern darueber,
    // ueberschriebe der AEUSSERE Durchlauf nach der Rueckkehr des
    // verschachtelten dessen frische Werte mit veralteten, und das naechste
    // Render faehrt einen ueberfluessigen Refit.
    //
    // Genau dieser verschachtelte Durchlauf ist auch der Grund, warum der
    // Nutzer die Sperrleiste nicht kurz flackern sieht: beide Durchlaeufe
    // liegen in EINEM JS-Task, dazwischen wird nicht gemalt. Und er ist es,
    // der die frisch entsperrte Kachel refittet (der 32-px-Streifen
    // verschwindet, die Kachel gewinnt zwei Zeilen) -- `view.lastLocked`
    // steht dafuer schon auf dem Wert DIESES Durchlaufs.
    //
    // Die Wache ist bewusst KEIN Verlass auf den Terminierungsbeweis
    // ("der zweite Durchgang sammelt nichts mehr, weil die Sperren jetzt
    // stimmen"). Der Beweis gilt fuer den Code von heute; die Wache gilt
    // auch fuer den naechsten, der die Montagebedingung anfasst. Ohne sie
    // waere eine Endlosrekursion eine stille Aenderung an einer ganz
    // anderen Zeile.
    if (!syncingLocks && (locks.lock.length > 0 || locks.release.length > 0)) {
      syncingLocks = true;
      try {
        state.applyInputLocks(locks.lock, locks.release);
      } finally {
        syncingLocks = false;
      }
    }
  }

  // Ein echter Fenster-Resize aendert `state` nicht, `render()` liefe also
  // nicht erneut. Hier entsteht nur die neue Lage; jedes Terminal refittet
  // ueber seinen eigenen `window`-Lauscher in `terminal.ts` (derselbe
  // entprellte Pfad), ein verborgenes misst dabei nicht (`setHidden`) und holt
  // es beim Zurueckholen nach. Bewusst kein `ResizeObserver` (Spec §4.5).
  const onWindowResize = () => {
    if (!disposed) updateLayout();
  };
  window.addEventListener("resize", onWindowResize);

  const unsubscribe = state.subscribe(render);
  render();

  return {
    // Seitenleiste losgelassen oder eingeklappt (`main.ts`): neue Flaeche,
    // neue Lage, und jede sichtbare Kachel durch den entprellten Pfad.
    refit() {
      if (disposed) return;
      updateLayout();
      refitVisible();
    },
    // Spec 2026-10-19 §4.5, §6.1: waehrend die Seitenleiste gezogen wird,
    // folgen die Kacheln der Flaeche sofort -- ihre Lage steht inline in px,
    // CSS ordnet nichts mehr nach. Vermessen wird erst beim Loslassen (`refit`).
    relayout() {
      if (disposed) return;
      updateLayout();
    },
    focusActiveTile() {
      if (disposed) return;
      const id = state.focusedTile;
      if (id === null) return;
      // Spec 2026-10-19 §8.1 (Schritt 3): eine verborgene Kachel behaelt ihr
      // Terminal. Fokussiert wird trotzdem nur eine sichtbare -- Tasten in ein
      // Terminal, das niemand sieht, waeren Eingabe ohne Rueckmeldung. Die
      // Wege des Nutzers fokussieren eine Kachel, bevor sie sie maximieren;
      // `AppState` erzwingt das aber nicht.
      if (!state.visibleTileIds().includes(id)) return;
      views.get(id)?.handle?.focus();
    },
    applyTerminalTheme(theme) {
      // Wache wie bei `focusActiveTile`: nach dem Entsorgen sind die Handles
      // veraltete Referenzen, ein Themenwechsel danach darf sie nicht mehr
      // anfassen (Review zu Aufgabe 3).
      if (disposed) return;
      for (const view of views.values()) view.handle?.setTheme(theme);
    },
    applyTerminalFontSize(size) {
      // Wache wie bei `applyTerminalTheme`.
      if (disposed) return;
      for (const view of views.values()) view.handle?.setFontSize(size);
    },
    moveFocusedTile(delta) {
      const id = state.focusedTile;
      if (id !== null) moveTileByUser(id, delta);
    },
    revealTile(id) {
      if (!disposed) revealTile(id);
    },
    dispose() {
      disposed = true;
      window.removeEventListener("resize", onWindowResize);
      unsubscribe();
      // Zeitgeber und `visibilitychange`-Lauscher laufender Reihen gehen mit.
      for (const view of views.values()) {
        cancelReattach(view);
        view.handle?.dispose();
        window.clearTimeout(view.copiedTimer);
        window.clearTimeout(view.flashTimer);
      }
      views.clear();
      el.replaceChildren();
    },
  };
}
