// TerminalView (Task 11): xterm.js im WebView, Flow Control und entprelltes
// Resize. Siehe Spec §9.1 (Flow Control), §6.4 (Resize/V12), §11.1 (xterm 6:
// kein Canvas-Renderer mehr, Fallback ist der DOM-Renderer).

import { Terminal, type IBufferRange, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fontSizeKeyChange, isAppChord, isPlainCtrlAppKey, matchAction } from "./keymap";
import { clipboardKeyAction, decodeOsc52 } from "./terminal-clipboard";
import type { OpenQueue } from "./terminal-open-queue";
import { clampFontSize, setTerminalPrefs, terminalPrefs } from "./terminal-prefs";
import { currentTheme, themeParts, type AccentId, type BaseId, type ThemeId } from "./theme";
import { openTerminalMenu, type TerminalMenuItem, type TerminalMenuTexts } from "./views/terminal-menu";
import {
  EMPTY_SEARCH_TEXTS,
  createTerminalSearch,
  type SearchDecorations,
  type TerminalSearchTexts,
} from "./views/terminal-search";
import "@xterm/xterm/css/xterm.css";

/** Debounce-Fenster fuer Resize (Spec V12): ein inline rendernder Agent
 * (Codex) sendet bei jedem Resize `ESC[3J` und loescht damit den
 * SERVERSEITIGEN tmux-Scrollback unwiderruflich. Umgestellt wird deshalb
 * nur bei einer echten Fenstergroessenaenderung, nie beim Wechsel zwischen
 * Terminals -- diese Datei haengt `onResize` bewusst nur an
 * `window.addEventListener('resize', ...)`, niemals an einen
 * `ResizeObserver` auf dem Container: Letzterer feuert genau beim
 * Terminalwechsel (Ein-/Ausblenden des Containers aendert dessen Groesse),
 * also bei dem Ausloeser, den V12 verbietet. */
const RESIZE_DEBOUNCE_MS = 300;

/** UX-Spec §6.7: je 100 Einheiten Strg+Mausrad ein Schritt um 1 px. Eine
 * Rastung meldet in WebView2 100, ein Touchpad-Pinch kleine Deltas, die sich
 * aufsummieren. */
const WHEEL_UNITS_PER_STEP = 100;

/** Groesser geht Eingabe in Teilen dieser Groesse hinaus, der Reihe nach
 * (`enqueueInput` unten). */
export const INPUT_CHUNK_BYTES = 64 * 1024;

export interface TerminalHandle {
  dispose(): void;
  /** Task 10 (Kachelraster): startet/verlaengert denselben entprellten
   * `RESIZE_DEBOUNCE_MS`-Timer, den auch ein echtes `window`-Resize-Event
   * ausloest -- derselbe Pfad, nicht ein zweiter (Designsystem §5.5). Der
   * Kachelcontroller ruft dies nach jeder Aenderung auf, die die Pixelgroesse
   * EINER sichtbaren Kachel veraendert (Layoutwechsel, Maximieren,
   * Wiederherstellen, Seitenleisten-Ziehen) -- niemals `resize_terminal`
   * direkt. */
  refit(): void;
  /** Legt den Tastaturfokus in dieses Terminal (Designsystem §7.5: "ist sie
   * als Kachel sichtbar, folgt der Tastaturfokus dorthin"; §6.2: die drei
   * Fokussignale heissen "hier landen meine Tastendruecke").
   *
   * Wird AUSSCHLIESSLICH aus einer Benutzeraktion heraus gerufen (siehe
   * `GridHandle.focusActiveTile`) -- nie aus einem Neuzeichnen. Ein Terminal,
   * das sich den Fokus bei jeder Benachrichtigung selbst nimmt, risse ihn dem
   * Nutzer mitten im Tippen aus der Seitenleiste. */
  focus(): void;
  /** Spec §5.5/§12.2: wechselt `term.options.theme` an der laufenden Kachel --
   * ohne Neuanlage, ohne fit(), ohne resize_terminal. */
  setTheme(theme: ThemeId): void;
  /** UX-Spec §6.7: setzt `term.options.fontSize` (geklemmt auf 10 bis 20) an
   * der laufenden Kachel und passt sie ueber `scheduleRefit()` an, denselben
   * entprellten Pfad wie `refit()`: ein `resize_terminal` je Geste, und nur,
   * wenn sich Spalten oder Zeilen aendern. Dieselbe Groesse plant nichts. */
  setFontSize(size: number): void;
  /** UX-Spec §5.4, §5.5: der Aufrufer sperrt die Eingabe, solange die Kachel
   * "Reconnecting…" oder die Sperrleiste zeigt -- auch dann, wenn der Kanal
   * seinen Verlust noch gar nicht gemeldet hat. Freigeben hebt nur diese
   * Sperre auf: ein verlorener Kanal bleibt gesperrt. */
  setInputLocked(locked: boolean): void;
  /** Spec 2026-10-19 §8.1 (Schritt 3): die Kachel ist verborgen (eine andere
   * ist maximiert). Solange verborgen, misst ein Refit nicht und sendet nichts;
   * `setHidden(false)` plant selbst nichts, den Refit beim Zurueckholen loest
   * das Raster aus. */
  setHidden(hidden: boolean): void;
}

/** UX-Spec §6.9: jeder Fehlerpfad des Terminals hat seinen eigenen Text --
 * Oeffnen, Kopieren, Einfuegen, Eingabe und Groesse. Den Text waehlt der
 * Aufrufer nach dieser Art, denn diese Datei kennt `en.json` nicht. Ack-Fehler
 * haben keine Art: sie gehen nur in die Konsole. */
export type TerminalErrorKind = "open" | "copy" | "paste" | "input" | "resize";

/** Was `onError` meldet: die Art und den Rohtext der Ursache. Der Rohtext ist
 * nie der sichtbare Satz; er steht nur in "Copy details" am Banner (UX-Spec
 * §10). */
export interface TerminalError {
  kind: TerminalErrorKind;
  detail: string;
}

/** Task 12 (`Keymap`, Spec §7.4): Aktionen fuer die drei Ctrl+Shift-Akkorde,
 * die keinen Griff auf `term`/das Suchaddon selbst brauchen und deshalb dem
 * Aufrufer gehoeren, nicht `terminal.ts`. Kopieren und Suchen bleiben
 * dagegen HIER verdrahtet (siehe `attachCustomKeyEventHandler` unten), weil
 * sie `term`/`SearchAddon`-Instanzen brauchen, die der Aufrufer nicht hat.
 * Einfuegen erledigt Chromium selbst (UX-Spec §6.1); nur das Menue und der
 * Rechtsklick lesen die Zwischenablage selbst (§6.3). */
export interface MountOptions {
  /** Ctrl+Shift+W ("Terminal schliessen (Session laeuft weiter)", Spec
   * §7.4). Ruft NICHT selbst `dispose()` auf `TerminalHandle` auf -- der
   * Aufrufer haelt den `TerminalHandle` und entscheidet, was "geschlossen,
   * Session laeuft weiter" sichtbar bedeutet (z. B. eine
   * Wiedereroeffnen-Schaltflaeche zeigen). */
  onCloseTerminal?: () => void;
  /** Spec 2026-10-19 §5.4: die zwei Eintraege des Terminalmenues, die die
   * Kachel eine Position nach vorn (-1) oder hinten (1) schieben. Die Kachel
   * gehoert dem Aufrufer; ohne Rueckruf fehlen die Eintraege. */
  onMoveTile?: (delta: 1 | -1) => void;
  /** Ob es in diese Richtung eine Position gibt; sonst ist der Eintrag
   * ausgegraut. */
  canMoveTile?: (delta: 1 | -1) => boolean;
  /** UX-Spec §6.6: Beschriftungen der Suchleiste (Ctrl+Shift+F): Platzhalter,
   * Zaehler, Namen und Tooltips der Knoepfe. Kommen vom Aufrufer statt hier
   * literal zu stehen -- Spec §7.7/Task-11-Konvention: kein Text im Code, alle
   * Zeichenketten in `en.json`. Ohne Texte geht die Leiste trotzdem auf, mit
   * leeren Beschriftungen. */
  searchTexts?: TerminalSearchTexts;
  /** UX-Spec §6.5: der Tooltip ueber einem Link ("Ctrl+click to open"). Vom
   * Aufrufer wie `searchTexts`; ohne Text gibt es keinen Tooltip. */
  linkHint?: string;
  /** Die Rueckfrage vor einem OSC-8-Link, dessen sichtbarer Text nicht sein
   * Ziel zeigt -- der Eintrag, der ihn oeffnet ("Open link"), und die Zeile
   * darunter. Vom Aufrufer wie `linkHint`. Ohne Texte oeffnet so ein Link
   * nicht: nie, bevor der Nutzer das Ziel sah. */
  linkConfirmTexts?: { open: string; note: string };
  /** UX-Spec §6.1: nach jedem gelungenen Kopieren, ueber die Tasten oder
   * OSC 52 (§6.2). Der Aufrufer zeigt damit den Chip "Copied" im Kachelkopf. */
  onCopied?: () => void;
  /** UX-Spec §6.3: Beschriftungen, Kuerzel und Hinweiszeile des
   * Terminalmenues, das der Rechtsklick oeffnet. Vom Aufrufer wie
   * `searchTexts`. Ohne Texte oeffnet der Rechtsklick kein Menue; das
   * Browsermenue bleibt trotzdem aus. */
  menuTexts?: TerminalMenuTexts;
  /** M-C (Abschlussreview): die SSH-Verbindung dieser Session endete, OHNE
   * dass diese Ansicht selbst geschlossen wurde (`terminal://connection-
   * lost`, siehe Backend-Doc-Kommentar an `OutputSink::connection_lost`).
   * `mountTerminal` sperrt die Eingabe selbst (`term.options.disableStdin =
   * true`, braucht `term`); dieser Callback ist NUR fuer den sichtbaren
   * Zustand gedacht (der Aufrufer haelt das dafuer noetige DOM), dasselbe
   * Delegationsmuster wie `onError`. */
  onConnectionLost?: () => void;
  /** `open_terminal` wurde abgelehnt -- dieser Kanal ist gar nicht erst
   * entstanden (Session inzwischen weg, Kanalgrenze erreicht, Spec §2.5).
   *
   * Ein EIGENER Rueckruf, obwohl `onError` die Art `open` mitliefert: der
   * Aufrufer sperrt daraufhin die Eingabe, und genau dieser eine Anlass soll
   * das tun -- ein abgelehntes Kopieren sperrte sonst ein voellig gesundes
   * Terminal.
   *
   * `onError` feuert ZUSAETZLICH weiter: der Rueckruf beschreibt die Lage
   * der Kachel, das Banner nennt den Grund. */
  onOpenFailed?: () => void;
  /** `open_terminal` hat angehaengt -- das Gegenstueck zu `onOpenFailed`.
   * Die Kachel nimmt damit nach einem stillen Wiederanhaengen ihren Hinweis
   * "Reconnecting…" zurueck (UX-Spec §5.5). */
  onOpened?: () => void;
  /** Spec 2026-10-19 §8.4: Spalten und Zeilen nach jedem Fit -- beim Bau und
   * nach jedem entprellten Refit. Der Aufrufer zeigt damit, ob die Kachel zu
   * schmal ist; verkleinert wird nie. */
  onSize?: (cols: number, rows: number) => void;
  /** Spec 2026-10-19 §8.1 (Schritt 3): hoechstens 4 `open_terminal` je Host
   * zugleich. Ohne Schlange oeffnet die Ansicht sofort, wie bisher. Schluessel
   * ist das `hostId` dieses Aufrufs (die Laufzeit-ID). Die Ansicht reiht sich
   * beim Mounten ein und sendet, sobald ihr Platz zugeteilt ist und beide
   * Listener stehen; frei wird der Platz mit der Antwort auf `open_terminal`,
   * auch nach dem Entsorgen. Wer vor dem Senden entsorgt, verlaesst die
   * Schlange oder gibt seinen Platz gleich weiter. */
  openQueue?: OpenQueue;
  /** Meldet bei jedem Wechsel, ob die Ansicht auf einen Platz wartet: `true`
   * noch im Mounten, wenn keiner frei ist; `false`, sobald einer zugeteilt
   * ist (synchron im `release()` einer anderen Ansicht). Eine sofort
   * zugeteilte Ansicht meldet nichts, eine entsorgte nichts mehr. Wirft der
   * Rueckruf, landet der Fehler nur in der Konsole (`console.error`) und
   * schadet niemandem: bei `false` weder der Ansicht, die den Platz
   * freigibt, noch dem Oeffnen dieser Ansicht; bei `true` weder dem Mounten
   * noch dem eingereihten Ticket. */
  onQueued?: (queued: boolean) => void;
  /** Spec 2026-10-25 §6.4: Sessions des Standard-Sockets haengen nur ueber
   * die Bindung an. Fehlt der Socket, ist es der eigene; dann bleibt er auch
   * aus jedem Aufruf heraus, wie vor dem Standard-Socket. */
  socket?: "app" | "default";
  sessionId?: number | null;
  serverPid?: number | null;
  serverStartTime?: number | null;
  windowId?: number | null;
  paneId?: number | null;
  panePid?: number | null;
}

interface OutputEventPayload {
  host_id: string;
  session: string;
  open_id: string;
  bytes: number[];
}

/** Nutzlast von `terminal://connection-lost` (M-C, Abschlussreview). */
interface ConnectionLostEventPayload {
  host_id: string;
  session: string;
  open_id: string;
}

/** Vordergrund, Auswahlvordergrund und die 16 ANSI-Farben: in allen Themen
 * gleich (Spec §5.5), unveraendert die heutigen Werte. Die Flaeche dagegen
 * ist JE THEMA `--ab-term-bg` (siehe `TERMINAL_SURFACES` unten), nicht
 * identisch mit `--ab-bg-canvas` -- ohne gesetztes `theme.background` naehme
 * xterm sonst `#000` und die Kachel haette zwei verschiedene Schwarztoene. */
export const TERMINAL_ANSI = {
  foreground: "#C9D1D9",
  selectionForeground: "#F0F3F6",
  black: "#15181D",
  red: "#FF7B72",
  green: "#56D364",
  yellow: "#E3B341",
  blue: "#6CB0FF",
  magenta: "#D2A8FF",
  cyan: "#39C5CF",
  white: "#B9C2CC",
  brightBlack: "#6B7683",
  brightRed: "#FFA198",
  brightGreen: "#7EE787",
  brightYellow: "#F2CC60",
  brightBlue: "#9BCBFF",
  brightMagenta: "#E2C5FF",
  brightCyan: "#56D4DD",
  brightWhite: "#F0F3F6",
} as const;

type BaseSurfaces = Pick<
  ITheme,
  | "background" | "cursorAccent" | "selectionInactiveBackground"
  | "scrollbarSliderBackground" | "scrollbarSliderHoverBackground" | "scrollbarSliderActiveBackground"
>;
type AccentSurfaces = Pick<ITheme, "cursor" | "selectionBackground">;

/** Je Grundton (Farbwahl-Spec §5; Werte = Token in styles.css, der Test
 * "haengt an den Token" bindet beide). */
const TERMINAL_BASES: Record<BaseId, BaseSurfaces> = {
  graphite: {
    background: "#0F1115",
    cursorAccent: "#0F1115",
    selectionInactiveBackground: "#2A323D",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.34)",
    scrollbarSliderHoverBackground: "#939CAA",
    scrollbarSliderActiveBackground: "#C9D0DA",
  },
  slate: {
    background: "#0D111A",
    cursorAccent: "#0D111A",
    selectionInactiveBackground: "#283349",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.34)",
    scrollbarSliderHoverBackground: "#94A0B4",
    scrollbarSliderActiveBackground: "#C6CFDD",
  },
};

/** Je Akzent: der Cursor ist der Akzent, die Auswahl ist getoent -- bei Rot
 * und Gruen fast neutral (Farbwahl-Spec §2.5). */
const TERMINAL_ACCENTS: Record<AccentId, AccentSurfaces> = {
  turquoise: { cursor: "#2DD4BF", selectionBackground: "#2B4A52" },
  blue: { cursor: "#6FA8FF", selectionBackground: "#2B3E5C" },
  violet: { cursor: "#A193FC", selectionBackground: "#403D58" },
  pink: { cursor: "#F180B5", selectionBackground: "#543743" },
  red: { cursor: "#F66C69", selectionBackground: "#493E3D" },
  orange: { cursor: "#FA9947", selectionBackground: "#533B29" },
  green: { cursor: "#59D483", selectionBackground: "#3B443D" },
};

export function terminalTheme(id: ThemeId): ITheme {
  const { accent, base } = themeParts(id);
  return { ...TERMINAL_ANSI, ...TERMINAL_BASES[base], ...TERMINAL_ACCENTS[accent] };
}

/** Farben der Suchtreffer (UX-Spec §6.6) aus dem Terminalthema -- und damit aus
 * den Token von styles.css, an die `terminalTheme` gebunden ist. Es gibt hier
 * kein eigenes Farbliteral.
 *
 * Alle Treffer stehen auf der inaktiven Auswahlfarbe des Grundtons, der aktive
 * auf der Auswahlfarbe des Akzents, mit einem Rahmen im Akzent (dem Cursor).
 * Die Flaechen bleiben dunkel genug fuer den hellen Terminaltext; der Rahmen
 * traegt die Unterscheidung. Das Addon zeichnet nur `#RRGGBB`, und alle
 * Themenwerte, die hier eingehen, sind es. Die Randstreifen-Farben sind
 * Pflicht im Typ, auch wenn das Terminal keinen Randstreifen anzeigt. */
export function searchDecorations(theme: ITheme): SearchDecorations {
  const accent = theme.cursor ?? TERMINAL_ANSI.foreground;
  const active = theme.selectionBackground ?? accent;
  const others = theme.selectionInactiveBackground ?? active;
  return {
    matchBackground: others,
    matchOverviewRuler: accent,
    activeMatchBackground: active,
    activeMatchBorder: accent,
    activeMatchColorOverviewRuler: accent,
  };
}

/** Spec 2026-10-19 §8.2: gibt den WebGL-Kontext des Terminals in `container`
 * frei. xterm tut das beim Entsorgen nicht (`WebglRenderer.ts:144-150`), und
 * Chromium haelt hoechstens 16 Kontexte -- mit neun Kacheln und jedem
 * Ersetzen, Reconnect oder Wiederanhaengen zaehlten tote bis zur
 * Speicherbereinigung mit (Maximieren verbirgt seit Schritt 3 nur und
 * entsorgt nichts mehr, Spec 2026-10-19 §8.1). Das GL-Canvas
 * ist das Canvas ohne Klasse unter `.xterm-screen` (die Ebenen tragen
 * Klassen); ohne WebGL gibt es keins, und nichts geschieht. */
export function releaseWebglContext(container: HTMLElement): void {
  const canvas = container.querySelector<HTMLCanvasElement>(".xterm-screen canvas:not([class])");
  const gl = canvas?.getContext("webgl2") ?? null;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
}

/**
 * Mountet ein xterm.js-Terminal in `el` und verdrahtet es mit der Session
 * `session` auf Host `hostId`.
 *
 * Reihenfolge beim Aufbau ist eine Korrektheitsbedingung, keine Politur:
 * `open_terminal` wird erst aufgerufen, NACHDEM das Backend den
 * `terminal://output`-Listener registriert hat (`await` auf das von
 * `listen()` zurueckgegebene Promise). Ohne diese Reihenfolge koennten
 * Bytes emittiert werden, bevor ein Listener existiert -- diese Bytes
 * werden dann NIE geackt, `in_flight` im rueckseitigen `AckGate` sinkt
 * folglich nie wieder, und die Pumpaufgabe haengt fuer den Rest der
 * Prozesslaufzeit in `wait_for_room` (Spec §9.1, `ACK_WINDOW_BYTES`). Ein
 * tmux-Attach-Repaint auf einem grossen Fenster ist schnell sechsstellig --
 * das reicht, um das 1-MiB-Fenster sofort zu verbrauchen. Sichtbar waere
 * das nicht als fehlender Bildschirm, sondern als dauerhaft totes
 * Terminal.
 *
 * `dispose()` schliesst den PTY-Kanal per `close_terminal` -- und das ist
 * eine bewusste UMKEHR der urspruenglichen Plan-1-Entscheidung. Spec
 * §4.2/§6.8 verlangen, dass Kanaele nach einem Tab-Wechsel offen bleiben,
 * damit ein Rueckwechsel sofort ist und kein Resize ausgeloest wird. Diese
 * Eigenschaft liefert der Code hier aber NICHT: ein Wiedereroeffnen mountet
 * neu, `mountTerminal` ruft `open_terminal`, und `open_terminal_impl`
 * verdraengt den alten Eintrag und schliesst ihn -- ein frisches
 * `tmux attach` mit vollem Repaint findet ohnehin statt. Das Offenhalten
 * brachte also nichts und kostete den Freeze: der abgemeldete
 * `terminal://output`-Listener liess die Ausgabe unbestaetigt, das Ack-
 * Fenster lief voll, und ueber russhs GEMEINSAMEN Dispatch-Loop stand die
 * ganze Host-Verbindung (gemessen).
 *
 * Plan 2 holt die Eigenschaft ueber den Detached-Drain zurueck (Backend
 * bestaetigt selbst, wenn keine Ansicht haengt, plus `capture-pane`-Restore
 * nach Spec §6.2) -- NICHT durch Zurueckdrehen dieser Zeile. Ohne den
 * Restore waere verworfene Ausgabe echt verloren.
 *
 * `onError`, falls angegeben, wird mit der Art des Fehlers und seinem Rohtext
 * aufgerufen (`TerminalError`, UX-Spec §6.9), wenn einer der fire-and-forget
 * `invoke()`-Aufrufe fehlschlaegt: `open_terminal` (z. B. Kanal-Limit
 * erreicht, Session inzwischen verschwunden), `send_input` oder
 * `resize_terminal`. Dazu kommen ein gescheitertes Kopieren und ein
 * gescheitertes Lesen der Zwischenablage beim Einfuegen. Ohne diesen Weg
 * bliebe so ein Fehlschlag fuer den Aufrufer voellig unsichtbar -- am
 * gravierendsten bei `resize_terminal`: schlaegt der Aufruf fehl, bleibt das
 * entfernte PTY lautlos in falscher Groesse haengen. Ein abgelehntes
 * `ack_output` geht nur in die Konsole: der Nutzer kann damit nichts tun.
 */
export function mountTerminal(
  el: HTMLElement,
  hostId: string,
  session: string,
  onError?: (error: TerminalError) => void,
  options?: MountOptions,
): TerminalHandle {
  const socketArg = options?.socket === "default" ? { socket: "default" } : {};
  const term = new Terminal({
    allowProposedApi: true,
    scrollback: 5000,
    // M-Doc-2 (Abschlussreview): Terminal-Ausgabe ist angreiferbeeinflussbar
    // (Repo-Inhalte, Werkzeug-Output, Spec §8.3). Ohne eigenen `linkHandler`
    // faellt xterm.js bei OSC-8-Hyperlinks auf `defaultActivate` zurueck,
    // das KEIN Schema filtert -- ein `file://`- oder `javascript:`-Link
    // waere klickbar. Providing `linkHandler` ersetzt `defaultActivate`
    // VOLLSTAENDIG (siehe `ILinkHandler`s Doc-Kommentar in `@xterm/xterm`),
    // `activate` muss deshalb selbst oeffnen, nicht nur filtern.
    // `allowNonHttpProtocols` bleibt bewusst weg (Default `false`): xterm.js'
    // eigener Link-Provider soll non-http(s)-URLs schon gar nicht erst als
    // klickbaren Link erkennen, nicht erst `activate` sie verwerfen lassen
    // -- zwei unabhaengige Filterstufen statt einer. Dieselbe Regel gilt fuer
    // die vom WebLinks-Addon erkannten Links (`openLink` unten).
    // OSC-8-Links pruefen zusaetzlich, ob ihr Text das Ziel zeigt
    // (`activateOscLink`).
    linkHandler: { activate: activateOscLink, hover: showOscLinkHint, leave: hideLinkHint },
    theme: terminalTheme(currentTheme()),
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
    // UX-Spec §6.7: die Schriftgroesse gilt fuer alle Terminals, auch fuer
    // eine Kachel, die erst nach der Aenderung aufgeht (Standard 13).
    fontSize: terminalPrefs().fontSize,
    lineHeight: 1.15,
    letterSpacing: 0,
    fontWeight: 400,
    fontWeightBold: 600,
    cursorBlink: true,
    cursorStyle: "block",
  });

  // UX-Spec §6.5: geoeffnet wird nur mit Strg+Klick; ein Klick ohne Strg tut
  // nichts. Das gilt fuer beide Wege hierher: Links, die das WebLinks-Addon im
  // Text erkennt (unten geladen), und OSC-8-Links (`linkHandler` oben, mit der
  // Rueckfrage aus `activateOscLink`).
  function openLink(event: MouseEvent, text: string): void {
    if (isHttpLinkClick(event, text)) sendOpenLink(text);
  }

  /** Ein Strg+Klick der primaeren Taste auf eine http(s)-Adresse? */
  function isHttpLinkClick(event: MouseEvent, text: string): boolean {
    // Nur die primaere Taste: xterm ruft `activate` bei jedem losgelassenen
    // Knopf, auch dem mittleren.
    if (disposed || !event.ctrlKey || event.button > 0) return false;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      // Kein gueltiger URL-Text -- angreiferbeeinflusster Terminal-Inhalt darf
      // den Klick nicht zum Absturz bringen.
      return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
  }

  function sendOpenLink(text: string): void {
    // Der Text geht unveraendert hinaus (`url.href` haengte einen Schraegstrich
    // an). Rust prueft Schema, Zeichen und Laenge noch einmal und oeffnet den
    // Standardbrowser; ein eigenes Fenster der Seite wuerde WebView2 schlucken.
    void invoke("open_link", { url: text }).catch((error: unknown) => {
      // Eine abgelehnte URL ist kein Fehler des Nutzers und hat keine Wirkung:
      // nur die Konsole, kein Banner.
      console.warn(`[link] open_link rejected: ${String(error)}`);
    });
  }

  // Bei OSC 8 ist der sichtbare Text frei waehlbar, und Terminal-Ausgabe ist
  // angreiferbeeinflussbar (Spec §8.3) -- "docs" kann auf eine fremde Seite
  // zeigen. Zeigt der Text sein Ziel nicht, oeffnet der Strg+Klick noch
  // nichts, sondern die Rueckfrage mit dem vollen Ziel (`confirmLink`).
  function activateOscLink(event: MouseEvent, text: string, range: IBufferRange): void {
    if (!isHttpLinkClick(event, text)) return;
    if (linkShowsTarget(text, range)) sendOpenLink(text);
    else confirmLink(event.clientX, event.clientY, text);
  }

  /** Zeigt der sichtbare Text des OSC-8-Links genau sein Ziel `text`? Dieselbe
   * Adresse in anderer Schreibweise zaehlt mit (`new URL` vereinheitlicht Host
   * und Pfad); jeder andere Text, auch einer, der keine Adresse ist, nicht. */
  function linkShowsTarget(text: string, range: IBufferRange): boolean {
    try {
      return new URL(visibleLinkText(range)).href === new URL(text).href;
    } catch {
      return false;
    }
  }

  /** Der sichtbare Text im Bereich eines OSC-8-Links. xterm meldet ihn
   * 1-basiert und mit eingeschlossenem Ende; in xterm 6 liegt ein OSC-8-Link
   * auf einer Zeile, mehrere Zeilen haengt die Schleife trotzdem aneinander. */
  function visibleLinkText(range: IBufferRange): string {
    let visible = "";
    for (let y = range.start.y; y <= range.end.y; y++) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return "";
      const start = y === range.start.y ? range.start.x - 1 : 0;
      const end = y === range.end.y ? range.end.x : undefined;
      visible += line.translateToString(true, start, end);
    }
    return visible.trim();
  }

  // Der Tooltip ueber einem Link: ein `title` am Wurzelelement von xterm. Den
  // zeigt der Browser nach kurzer Ruhe des Zeigers selbst, ohne ein eigenes
  // Element im Terminal. Er steht nur, solange der Zeiger auf dem Link ist.
  function showLinkHint(): void {
    if (options?.linkHint) (term.element ?? el).title = options.linkHint;
  }

  // Zeigt ein OSC-8-Link sein Ziel nicht, nennt der Tooltip es vor dem
  // Hinweis -- schon beim Ueberfahren, nicht erst beim Klick.
  function showOscLinkHint(_event: MouseEvent, text: string, range: IBufferRange): void {
    const hint = options?.linkHint;
    if (!hint) return;
    (term.element ?? el).title = linkShowsTarget(text, range) ? hint : `${text}\n${hint}`;
  }

  function hideLinkHint(): void {
    (term.element ?? el).removeAttribute("title");
  }

  const fit = new FitAddon();
  term.loadAddon(fit);

  // Unicode Version 11 fuer korrekte Breiten von Breitzeichen/Emoji --
  // Terminal-Treue (Spec A1) betrifft nicht nur Farbe und Maus, sondern
  // auch, ob box-drawing- und Statuszeichen an der richtigen Spalte
  // stehen.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  // Der Linkprovider des Addons erkennt http(s)-Adressen im Text (xterm selbst
  // kennt nur OSC 8). Sein Klick-Rueckruf ist derselbe `openLink`.
  term.loadAddon(new WebLinksAddon(openLink, { hover: showLinkHint, leave: hideLinkHint }));

  // Das Such-Addon war bis Task 12 installiert, aber nicht geladen (kein
  // Konsument): jetzt gibt es einen, Ctrl+Shift+F unten.
  const search = new SearchAddon();
  term.loadAddon(search);

  try {
    const webgl = new WebglAddon();
    // Ein spaeter verlorener WebGL-Kontext (GPU-Reset, Treiberwechsel)
    // darf nicht in einem toten Canvas enden -- xterm 6 hat keinen
    // Canvas-Renderer mehr, also disposen wir den Addon und xterm faellt
    // von selbst auf den DOM-Renderer zurueck.
    //
    // Nach `releaseWebglContext` beim Entsorgen kommt der Verlust noch einmal
    // an; dann ist das Terminal schon fort, und es gibt nichts zu tauschen.
    webgl.onContextLoss(() => {
      if (!disposed) webgl.dispose();
    });
    term.loadAddon(webgl);
  } catch {
    // Kein WebGL verfuegbar: derselbe Fallback (DOM-Renderer). Das darf
    // die Anwendung nicht zum Absturz bringen.
  }

  term.open(el);
  fit.fit();
  options?.onSize?.(term.cols, term.rows);

  // Task 12 (`Keymap`, Spec §7.4) und UX-Spec §6.6: Ctrl+Shift+F oeffnet die
  // Suchleiste oben rechts in der Kachel (`views/terminal-search.ts`). Sie
  // entsteht mit jedem Oeffnen neu und haengt als Geschwister von xterms
  // Element im Container -- kein statisches Markup in `index.html`, weil sie an
  // `search`/`term` gebunden ist. Das Eingabefeld ist nicht xterm.js' eigenes
  // Element: `attachCustomKeyEventHandler` unten sieht seine Tastendruecke
  // nicht, die Leiste hat einen eigenen Tastaturpfad.
  const searchUi = createTerminalSearch({
    host: el,
    search,
    texts: options?.searchTexts ?? EMPTY_SEARCH_TEXTS,
    // Bei jeder Suche neu gelesen: `setTheme` ersetzt `term.options.theme` im
    // Betrieb, die naechste Suche faerbt schon im neuen Thema.
    decorations: () => searchDecorations(term.options.theme ?? terminalTheme(currentTheme())),
    onClose: () => {
      // Das Schliessen der Leiste gibt dem Terminal den Fokus zurueck. Wie beim
      // Terminalmenue gilt: ein entsorgtes bekommt keinen. (Die Leiste ruft
      // diesen Rueckruf nach ihrem `dispose()` nie; das ist reine Absicherung.)
      if (!disposed) term.focus();
    },
  });

  /** Ob die Markierung Text enthaelt, nicht bloss ob es eine gibt: xterm kappt
   * Leerzeichen am Zeilenende, eine Markierung aus lauter Leerraum ist fuer
   * `hasSelection()` eine Markierung und liefert trotzdem "". Strg+C schluckte
   * darauf das ^C und kopierte nichts. `hasSelection()` steht vorn, weil es
   * billig ist: `getSelection()` baut den Text der ganzen Markierung, und diese
   * Frage geht durch jedes Tastenereignis. */
  function hasSelectedText(): boolean {
    return term.hasSelection() && term.getSelection() !== "";
  }

  /** EIN Weg in die Zwischenablage fuer jedes Kopieren (Tasten, Menue,
   * Rechtsklick, Copy on select, OSC 52): die Pruefung auf ein inzwischen
   * entsorgtes Terminal und der Chip "Copied" stehen nur hier. Ein Fehler geht
   * als Art `copy` an `onError`, ausser der Aufrufer verwirft ihn still
   * (`reportFailure` aus, so bei OSC 52). */
  function writeToClipboard(text: string, reportFailure: boolean): void {
    void navigator.clipboard.writeText(text).then(
      () => {
        // Das Schreiben kann nach dem Entsorgen fertig werden; der Chip
        // gehoerte dann zu einer Kachel, die diese Ansicht nicht mehr zeigt.
        if (!disposed) options?.onCopied?.();
      },
      (error: unknown) => {
        // Aus demselben Grund kein Fehlerhinweis fuer eine Kachel, die es
        // nicht mehr gibt.
        if (reportFailure && !disposed) onError?.({ kind: "copy", detail: String(error) });
      },
    );
  }

  // UX-Spec §6.1: kopiert die Markierung und hebt sie auf. Ohne Markierung
  // wird nichts geschrieben -- ein leerer String ueberschriebe die
  // Zwischenablage des Nutzers, obwohl "nichts ausgewaehlt" keine
  // Kopieraktion ist.
  function copySelection(): void {
    const selection = term.getSelection();
    term.clearSelection();
    if (selection.length === 0) return;
    writeToClipboard(selection, true);
  }

  // UX-Spec §6.3: Einfuegen aus dem Menue und dem Rechtsklick liest die
  // Zwischenablage selbst (`readText`; das Leserecht gibt der Fensteraufbau,
  // UX-Spec §8.5) und fuegt per `term.paste` ein -- xterm klammert dann wie
  // beim nativen Einfuegen per Bracketed Paste. Die Tasten lesen nie, dort
  // fuegt Chromium selbst ein (siehe unten).
  function pasteFromClipboard(): void {
    void navigator.clipboard.readText().then(
      (text) => {
        // Leer nicht: bei Bracketed Paste schickte `term.paste("")` trotzdem
        // die Klammern ans Programm.
        if (disposed || text === "") return;
        term.paste(text);
      },
      (error: unknown) => {
        // Wie beim Kopieren: kein Hinweis fuer eine entsorgte Kachel.
        if (!disposed) onError?.({ kind: "paste", detail: String(error) });
      },
    );
  }

  // UX-Spec §6.2: tmux mit `mouse on` schickt die Kopie eines Ziehens per
  // OSC 52 (`ESC]52;;<base64>BEL`, gemessen auf tmux 3.6), und xterm 6
  // verwirft OSC 52 ohne eigenen Handler. Geschrieben wird nur, gelesen nie.
  // tmux bleibt bei `set-clipboard external` und reicht damit nur Kopien
  // weiter, die es selbst anstoesst; OSC 52 aus der Programmausgabe verwirft
  // tmux. Hat das Fenster keinen Fokus, lehnt der Browser das Schreiben ab --
  // das bleibt still. `true` auch fuer Verworfenes: es gibt keinen weiteren
  // Handler, und eine Antwort geht nie hinaus.
  term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data);
    if (text !== null) writeToClipboard(text, false);
    return true;
  });

  // Die eigentliche Grenze (Spec §7.4, UX-Spec §6.1). Zuerst die
  // Zwischenablage: Kopieren bekommt `preventDefault` und `false`; Einfuegen
  // nur `false`, OHNE `preventDefault` -- dann fuegt Chromium selbst in xterms
  // Textfeld ein, und xterms eigener `paste`-Lauscher klammert per Bracketed
  // Paste. Das braucht kein Leserecht, anders als
  // `navigator.clipboard.readText()`.
  //
  // Danach die App-Akkorde: xterm.js bekommt fuer jeden Ctrl+Shift-Akkord
  // `false` (nicht verarbeiten, nicht als Terminal-Eingabe interpretieren),
  // ebenso fuer Ctrl+, und die Tasten der Schriftgroesse (UX-Spec §8.3)
  // -- jede andere Kombination, auch Ctrl+C ohne Markierung, Ctrl+A, Alt+B
  // und jedes AltGr-Zeichen, bekommt `true` und geht unveraendert ans
  // Terminal. `isAppChord` prueft NUR die Modifikatoren, nicht ob der Akkord
  // an eine Aktion gebunden ist -- der gesamte Ctrl+Shift-Tastenraum gehoert
  // der App, auch ein (noch) unbelegter Akkord (siehe `src/keymap.ts`). Ohne
  // diese Unterscheidung wuerde entweder ein Terminal-Kuerzel von der App
  // geschluckt, oder ein App-Akkord als rohe Eingabe beim Agenten landen.
  term.attachCustomKeyEventHandler((event) => {
    switch (clipboardKeyAction(event, hasSelectedText(), terminalPrefs())) {
      case "copy":
        event.preventDefault();
        copySelection();
        return false;
      case "paste-native":
        return false;
      case "terminal":
        break;
    }
    // UX-Spec §8.3: Strg+, und die Tasten der Schriftgroesse gehoeren der App,
    // auch mit Fokus hier. xterm bekommt `false`, und das Ereignis laeuft ohne
    // preventDefault und ohne stopPropagation weiter zum Dokument, wo
    // `keyboard.ts` handelt. xterm 6 erzeugt fuer diese Tasten ohnehin keine
    // Eingabe. Strg+Alt und AltGr fallen in beiden Pruefungen heraus, `}` auf
    // AltGr+0 geht also weiter ans Terminal.
    if (isPlainCtrlAppKey(event) || fontSizeKeyChange(event) !== null) return false;
    if (!isAppChord(event)) return true;
    if (event.type === "keydown") {
      event.preventDefault();
      switch (matchAction(event)) {
        case "search.local":
          searchUi.toggle();
          break;
        case "session.close":
          options?.onCloseTerminal?.();
          break;
        default:
          // "clipboard.copy"/"clipboard.paste" kommen hier nicht mehr an:
          // `clipboardKeyAction` nimmt Ctrl+Shift+C/V oben ab.
          //
          // "session.new" (siehe unten), "session.prev"/"session.next"/
          // "session.select.N", "tile.maximize"/
          // "sidebar.toggle"/"sidebar.focus", "quickOpen"
          // und jeder unbelegte Ctrl+Shift-Akkord: kein Ziel HIER -- diese
          // Aktionen brauchen `AppState`/DOM-Zugriff (Sidebar, Kachelraster),
          // den dieses Modul bewusst nicht hat (Kopfkommentar: "Consumes:
          // nichts"). `event.preventDefault()` oben verhindert nur, dass
          // xterm.js die Taste als Terminal-Eingabe verarbeitet -- es
          // stoppt NICHT die Ereignis-Ausbreitung (`stopPropagation()`
          // faellt hier nirgends), das `keydown` erreicht darum trotzdem
          // `document`, wo `keyboard.ts`s eigener Akkord-Handler (Task 12)
          // dieselbe `matchAction`-Zuordnung ein zweites Mal auswertet und
          // genau diese Aktionen tatsaechlich ausfuehrt. Trotzdem `false`
          // oben, auch fuer einen unbelegten Akkord: der gesamte
          // Ctrl+Shift-Raum gehoert der App, nie dem Terminal.
          //
          // Abschlussreview (Important 5): `session.new` ist hier BEWUSST
          // ohne eigenen Zweig, und `MountOptions` hat kein
          // `onNewSession` mehr. Der Akkord legt eine Session auf dem
          // Zielhost aus UX-Spec §7.9 an (zuerst der Host der fokussierten
          // Kachel, dann der zuletzt fokussierten belegten, der aktive Host
          // der Seitenleiste, der einzige verbundene, sonst das
          // Schnelloeffnen) -- das braucht `AppState` und die Seitenleiste,
          // die dieses Modul nicht hat, und es gilt auch OHNE fokussiertes
          // Terminal. Verdrahtet ist er deshalb allein in `keyboard.ts`s
          // dokumentweitem Akkord-Handler (`main.ts`,
          // `newSessionOnTargetHost`). Beides zu
          // verdrahten waere ein Fehler, kein Guertel-und-Hosentraeger:
          // hier faellt kein `stopPropagation()`, das `keydown` erreicht
          // `document` also ZUSAETZLICH -- eine Session wuerde doppelt
          // angelegt.
          break;
      }
    }
    return false;
  });

  // --- Rechte Maustaste, Terminalmenue und Copy on select (UX-Spec §6.3, §6.4)
  //
  // Die Lauscher am Container `el` haengen in der CAPTURE-Phase, nicht an
  // xterms Element: ein Stopp dort schneidet xterms eigene Lauscher ab, bevor
  // sie das Ereignis sehen. Der eine am Dokument (Ziehen ueber den Rand, unten)
  // ist die Ausnahme. Abgemeldet werden alle ueber `listeners` beim Entsorgen:
  // `grid.ts` mountet dieselbe Kachel spaeter erneut in dasselbe Element, und
  // am Dokument bliebe ein Lauscher samt altem Terminal sonst fuer immer.
  const listeners = new AbortController();
  const { signal } = listeners;
  let menu: { close(): void } | null = null;

  /** Die Suchleiste samt Feld gehoert dem Browser: dort bleibt die rechte
   * Taste beim nativen Bearbeitungsmenue (UX-Spec §8.1), und ein Druck darin
   * ist keine Geste im Terminal. Der Selektor nennt die Leiste UND jedes Feld
   * im Container, damit auch ihre Knoepfe kein Terminalmenue oeffnen. Die
   * Klasse `terminal-search-overlay` setzt `views/terminal-search.ts`. */
  function inSearchOverlay(event: Event): boolean {
    return event.target instanceof Element && event.target.closest("input, .terminal-search-overlay") !== null;
  }

  function runMenuAction(id: TerminalMenuItem["id"]): void {
    if (disposed) return;
    switch (id) {
      case "copy":
        copySelection();
        break;
      case "paste":
        pasteFromClipboard();
        break;
      case "selectAll":
        term.selectAll();
        break;
      case "find":
        // Oeffnet die Leiste, oder holt den Fokus hinein, wenn sie schon offen
        // ist -- der Umschalter der Taste schlosse sie.
        searchUi.openOrFocus();
        break;
      case "moveEarlier":
        options?.onMoveTile?.(-1);
        break;
      case "moveLater":
        options?.onMoveTile?.(1);
        break;
    }
  }

  function openMenu(x: number, y: number): void {
    const texts = options?.menuTexts;
    if (!texts) return;
    menu?.close();
    // Gelesen, wenn das Menue aufgeht: die Einstellung kann sich im Betrieb aendern.
    const ctrlCv = terminalPrefs().ctrlCvClipboard;
    const { items } = texts;
    menu = openTerminalMenu({
      x,
      y,
      items: [
        {
          id: "copy",
          label: items.copy.label,
          // Strg+C und Strg+V gelten nur bei eingeschalteter Einstellung; sonst
          // zeigt das Menue die festen Tasten (beide Fassungen kommen vom
          // Aufrufer).
          shortcut: ctrlCv ? items.copy.shortcut : texts.fixedShortcuts.copy,
          disabled: !hasSelectedText(),
        },
        {
          id: "paste",
          label: items.paste.label,
          shortcut: ctrlCv ? items.paste.shortcut : texts.fixedShortcuts.paste,
        },
        { id: "selectAll", label: items.selectAll.label, shortcut: items.selectAll.shortcut },
        { id: "find", label: items.find.label, shortcut: items.find.shortcut },
        ...(options?.onMoveTile
          ? [
              {
                id: "moveEarlier" as const,
                label: items.moveEarlier.label,
                shortcut: items.moveEarlier.shortcut,
                disabled: !(options.canMoveTile?.(-1) ?? true),
              },
              {
                id: "moveLater" as const,
                label: items.moveLater.label,
                shortcut: items.moveLater.shortcut,
                disabled: !(options.canMoveTile?.(1) ?? true),
              },
            ]
          : []),
      ],
      // Nur, solange ein Programm die Maus nutzt: dann markiert erst
      // Umschalt+Ziehen lokal.
      hint: term.modes.mouseTrackingMode !== "none" ? texts.mouseHint : undefined,
      onSelect: runMenuAction,
      onClose: () => {
        menu = null;
        if (!disposed) term.focus();
      },
    });
  }

  /** Die Rueckfrage vor einem OSC-8-Link, dessen Text nicht sein Ziel zeigt.
   * Huelle und Schliessen wie das Terminalmenue (am Zeiger; Esc, Tab, Klick
   * daneben, Mausrad, Groessenaenderung), oben das volle Ziel, darunter
   * "Open link" und die Begruendung. Ein langes Ziel macht die Rueckfrage
   * hoch; dann haelt `placeTerminalMenu` sie oben im Fenster, und "Open link"
   * kann unter dem Zeiger liegen. Deshalb waehlen Klick, Enter und Leertaste
   * erst nach 500 ms (`armDelayMs`): Der zweite Klick eines Strg+Doppelklicks
   * und ein schnelles Enter oeffnen nichts. Ohne Texte oeffnet nichts. */
  function confirmLink(x: number, y: number, text: string): void {
    const texts = options?.linkConfirmTexts;
    if (!texts) return;
    menu?.close();
    menu = openTerminalMenu({
      x,
      y,
      heading: text,
      items: [{ id: "openLink", label: texts.open }],
      hint: texts.note,
      armDelayMs: 500,
      onSelect: () => {
        if (!disposed) sendOpenLink(text);
      },
      onClose: () => {
        menu = null;
        if (!disposed) term.focus();
      },
    });
  }

  // Die rechte Taste sehen weder xterm noch tmux: auf Hosts mit `mouse on`
  // oeffnete sonst tmux sein eigenes Menue unter unserem.
  function swallowRightButton(event: MouseEvent): void {
    if (event.button === 2 && !inSearchOverlay(event)) event.stopPropagation();
  }
  for (const type of ["mousedown", "mouseup", "auxclick"] as const) {
    el.addEventListener(type, swallowRightButton, { capture: true, signal });
  }

  // `contextmenu` bekommt preventDefault (kein WebView2-Menue) UND endet hier:
  // xterms eigener Handler schiebt sonst sein verstecktes Textfeld unter den
  // Zeiger und fuellt es mit der Markierung, fuer ein Browsermenue, das es nie
  // gibt.
  el.addEventListener(
    "contextmenu",
    (event) => {
      if (inSearchOverlay(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (disposed) return;
      // Die rechte Taste erreicht xterm nicht, also auch nicht dessen focus():
      // ohne diesen Aufruf bliebe die Kachel unter dem Menue unfokussiert.
      term.focus();
      // Bei jedem Rechtsklick gelesen, nicht beim Mounten.
      if (terminalPrefs().rightClick === "paste") {
        if (hasSelectedText()) copySelection();
        else pasteFromClipboard();
        return;
      }
      openMenu(event.clientX, event.clientY);
    },
    { capture: true, signal },
  );

  // Strg+Mausrad: Schriftgroesse aller Terminals (UX-Spec §6.7). Capture am
  // Container wie die rechte Taste, und aus demselben Grund mit Stopp: xterm
  // gaebe das Rad bei `mouse on` als Mausrad an tmux weiter (dieser Lauscher
  // prueft `defaultPrevented` nicht) und blaetterte sonst im Verlauf.
  // `passive: false`, sonst waere `preventDefault` wirkungslos. Geschrieben wird
  // nur `terminal-prefs`; jede Kachel, auch diese, bekommt die neue Groesse
  // ueber `main.ts` und das Raster (`setFontSize`). Das Menue schliesst sich am
  // Rad schon vorher, sein Lauscher sitzt in der Capture-Phase am Dokument.
  let wheelRest = 0;
  el.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY === 0) return;
      // Ein Richtungswechsel verwirft den Rest der anderen Richtung: sonst bliebe
      // die erste Rastung zurueck wirkungslos.
      if (Math.sign(event.deltaY) !== Math.sign(wheelRest)) wheelRest = 0;
      wheelRest += event.deltaY;
      const steps = Math.trunc(wheelRest / WHEEL_UNITS_PER_STEP);
      if (steps === 0) return;
      wheelRest -= steps * WHEEL_UNITS_PER_STEP;
      // Nach oben (negatives Delta) groesser.
      setTerminalPrefs({ fontSize: terminalPrefs().fontSize - steps });
    },
    { capture: true, passive: false, signal },
  );

  // Copy on select (UX-Spec §6.4): kopiert wird beim Loslassen der linken
  // Taste, NIE bei `onSelectionChange` -- auch die Suche setzt eine Markierung
  // und ueberschriebe sonst die Zwischenablage des Nutzers. Die Markierung
  // bleibt sichtbar (anders als bei Strg+C).
  function copyOnSelect(): void {
    if (disposed || !terminalPrefs().copyOnSelect) return;
    const selection = term.getSelection();
    if (selection === "") return;
    writeToClipboard(selection, true);
  }

  // Entscheidend ist, wo der Druck war, nicht wo losgelassen wird: zieht der
  // Nutzer die Markierung ueber den Rand, verfolgt xterm die Maus am Dokument,
  // und das mouseup trifft ein Element ausserhalb des Containers oder die
  // Nachbarkachel. Kopieren darf deshalb nur die Kachel, in der der Druck war
  // (`pressedInside`), und sie tut es an EINER Stelle: dem mouseup am Dokument
  // (Capture, damit kein Vorfahre es abfaengt). Ein zusaetzlicher Lauscher am
  // Container kopierte bei jedem Loslassen ueber der Kachel, also auch deren
  // alte, noch sichtbare Markierung ueber die der anderen Kachel.
  //
  // Jeder linke Druck entscheidet neu, ob diese Kachel scharf ist; ein mouseup,
  // das nie ankam, kann so nichts auf Dauer scharf lassen. Dasselbe gilt fuer
  // den Verlust des Fensterfokus (Alt+Tab mitten im Ziehen).
  let pressedInside = false;
  document.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) return;
      pressedInside = event.target instanceof Node && el.contains(event.target) && !inSearchOverlay(event);
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "mouseup",
    (event) => {
      if (event.button !== 0) return;
      const armed = pressedInside;
      pressedInside = false;
      if (armed) copyOnSelect();
    },
    { capture: true, signal },
  );
  window.addEventListener(
    "blur",
    () => {
      pressedInside = false;
    },
    { signal },
  );

  // Die Groesse, die das Backend zuletzt bekommen hat -- Wachhund gegen
  // Befund 1 (siehe `sendSizeIfChanged` unten). `open_terminal` setzt sie
  // beim Absenden auf genau die Groesse, die es mitschickt: ein Refit
  // zwischen dem Mounten und dem Absenden kann `term.cols`/`term.rows` schon
  // veraendert haben. Bis dahin steht hier die beim Mounten gefittete Groesse;
  // gelesen wird sie erst, wenn der Kanal angehaengt ist (`attached`,
  // Abnahme B1). Damit ist schon der ERSTE `resize`-Event nach dem Anhaengen
  // geschuetzt -- etwa "DevTools auf und zu" direkt
  // nach dem Verbinden, auf einer frisch angehaengten Session mit vollem
  // Scrollback.
  const openId = crypto.randomUUID();
  let lastSentCols = term.cols;
  let lastSentRows = term.rows;
  let attached = false;

  // Eingabe geht roh ans PTY -- keine Interpretation im Frontend.
  //
  // Eine grosse Einfuegung ging als EIN `send_input` mit einem Zahlenfeld
  // hinaus, bei 8 MB rund 33 MB JSON. Umwandeln und IPC-Aufruf hielten die
  // Seite Sekunden lang an (gemessen am 24.10.: rund 0,8 s je MB), und mit
  // ihr Eingabe, Groessenaenderung und Schliessen jedes anderen Terminals;
  // das Backend selbst bediente die anderen Kanaele weiter. Deshalb geht
  // Eingabe ueber `INPUT_CHUNK_BYTES` in Teilen hinaus, je Terminal der Reihe
  // nach: der naechste Teil erst, wenn der vorige angekommen ist, dazwischen
  // kommt die Seite zum Zug. Was waehrenddessen getippt wird, reiht sich
  // dahinter ein. Scheitert ein Teil -- etwa an der Frist des Backends, weil
  // das Programm stdin nicht liest --, entfaellt der Rest dieser Eingabe, mit
  // einer Meldung statt einer je Teil.
  let inputTail: Promise<void> | null = null;

  /** Eingabe, die vor dem Anhaengen ankommt: Tastendruecke, Einfuegungen und
   * die Antworten, die xterm selbst erzeugt (auf DA-, XTVERSION- oder
   * OSC-10/11-Anfragen, die tmux beim Anhaengen schickt). Das Backend kennt
   * diesen Kanal erst nach seiner Antwort auf `open_terminal`; ein
   * `send_input` davor scheiterte, und die Eingabe waere still verloren. Nach
   * dem Anhaengen geht der Puffer einmal hinaus, in Tipp-Reihenfolge und vor
   * allem Spaeteren (`flushPendingInput`). Er lebt nur bis zur Antwort auf
   * `open_terminal` oder bis zum Entsorgen; eine Obergrenze gibt es bewusst
   * nicht, sie fuehrte nur einen Modus ein, in dem ein Teil verloren geht.
   * Verworfen, ohne Senden und ohne Meldung, wird er bei abgelehntem Oeffnen,
   * beim Entsorgen, bei einer Sperre des Aufrufers vor dem Anhaengen (auch die
   * Antworten von xterm) und bei einem Kanalverlust vor der Antwort. `null`,
   * sobald nichts mehr gepuffert wird: nach dem Anhaengen geht Eingabe direkt
   * hinaus, nach einem gescheiterten Oeffnen nirgends hin. */
  let pendingInput: Uint8Array[] | null = [];

  /** Laeuft erst nach dem Anhaengen (`term.onData` puffert davor): das Backend
   * kennt den Kanal dann, jeder Fehlschlag ist ein echter. */
  function sendInput(bytes: Uint8Array, burst: { failed: boolean }): Promise<void> {
    if (burst.failed || disposed || channelClosed) return Promise.resolve();
    return invoke("send_input", { hostId, session, openId, bytes: Array.from(bytes), ...socketArg }).then(
      () => {},
      (error: unknown) => {
        burst.failed = true;
        // Ohne diesen Pfad bliebe ein fehlgeschlagener Tastendruck
        // unsichtbar verworfen -- kein Fehler, aber auch keine Wirkung.
        onError?.({ kind: "input", detail: String(error) });
      },
    );
  }

  /** Schickt Eingabe ab, die ein angehaengter Kanal annimmt. `forceChain`
   * schickt sie auch klein ueber die Kette: was danach getippt wird, wartet
   * dann, bis sie angekommen ist. */
  function enqueueInput(encoded: Uint8Array, forceChain: boolean): void {
    const burst = { failed: false };
    // Der gewoehnliche Tastendruck: sofort, wie bisher.
    if (!forceChain && inputTail === null && encoded.length <= INPUT_CHUNK_BYTES) {
      void sendInput(encoded, burst);
      return;
    }
    for (let offset = 0; offset < encoded.length; offset += INPUT_CHUNK_BYTES) {
      const part = encoded.subarray(offset, offset + INPUT_CHUNK_BYTES);
      const tail = (inputTail ?? Promise.resolve()).then(() => sendInput(part, burst));
      inputTail = tail;
      void tail.then(() => {
        if (inputTail === tail) inputTail = null;
      });
    }
  }

  /** Nach dem Anhaengen: der Puffer geht als eine Eingabe hinaus, ueber die
   * Kette, damit spaetere Tastendruecke sich dahinter einreihen. Danach puffert
   * nichts mehr. Ist die Eingabe gesperrt oder der Kanal schon zu, wird er
   * verworfen. */
  function flushPendingInput(): void {
    const parts = pendingInput ?? [];
    pendingInput = null;
    if (parts.length === 0 || inputLockedByCaller || channelClosed) return;
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    enqueueInput(bytes, true);
  }

  // Jede Eingabe kommt hier an, auch `term.paste` und xterms eigene Antworten
  // auf Anfragen des Programms.
  term.onData((data) => {
    if (disposed || channelClosed) return;
    const encoded = new TextEncoder().encode(data);
    if (!attached) {
      pendingInput?.push(encoded);
      return;
    }
    enqueueInput(encoded, false);
  });

  let disposed = false;
  // Befund 9 (Abschlussbewertung 2026-09-04): sobald `terminal://connection-lost`
  // fuer DIESE Kachel eintrifft, hat die Pumpaufgabe im Backend den
  // Terminaleintrag bereits entfernt. Ein Ack aus dem `write()`-Callback, das
  // gerade noch unterwegs war, oder ein `resize_terminal` aus einem
  // entprellten Refit (Sperrleiste loest den Refit aus) traefe dann auf einen
  // bereits entfernten Eintrag -- frueher ein rotes Fehlerbanner fuer einen
  // vollkommen normalen Kanalabbau. Das Backend ist inzwischen idempotent
  // (`ack_output_impl`), aber der Aufruf lohnt sich hier ohnehin nicht mehr:
  // dieses Flag haelt beide Aufrufe still.
  let channelClosed = false;
  /** Sperre des Aufrufers (`setInputLocked`, UX-Spec §5.4/§5.5). */
  let inputLockedByCaller = false;

  /** Die Eingabe ist gesperrt, solange der Kanal verloren ist ODER der
   * Aufrufer sperrt -- zwei Gruende, die einander nicht aufheben. */
  function applyInputLock(): void {
    term.options.disableStdin = channelClosed || inputLockedByCaller;
  }

  // Summe der Bytes, die bereits per `term.write()` an xterm.js uebergeben,
  // aber deren Callback noch nicht gefeuert hat (siehe Kommentar in
  // `dispose()` unten). Nur der `write()`-Callback selbst darf diesen
  // Zaehler wieder verringern -- `dispose()` nullt ihn separat, sobald er
  // die verbleibende Summe einmalig nachbestaetigt hat.
  let pendingAckBytes = 0;

  // Ausgabe: Bytes werden NIE vor `term.write()` in einen String dekodiert --
  // xterm.js hat einen zustandsbehafteten UTF-8-Dekoder, und ein Chunk, der
  // mitten in einem Mehrbyte-Zeichen endet, erzeugt beim Einzeldekodieren
  // Ersatzzeichen (Spec §9.1).
  const unlistenPromise = listen<OutputEventPayload>(
    "terminal://output",
    (event) => {
      // `dispose()` unlistened erst NACH einem `await` (das von `listen()`
      // zurueckgegebene Promise); ein Event, das genau in diesem Fenster
      // ankommt, darf nicht mehr auf dem bereits disposten `term` landen.
      if (disposed) return;
      // Zwei Hosts duerfen gleichnamige tmux-Sessions haben (Spec §4.3) --
      // derselbe Grund, aus dem der connection-lost-Listener unten den
      // Host vergleicht (Befund 2 der Bewertung 2026-09-04: hier fehlte
      // dieser Vergleich bislang, Ausgabe eines fremden Hosts landete in
      // dieser Kachel).
      if (event.payload.host_id !== hostId) return;
      if (event.payload.session !== session || event.payload.open_id !== openId) return;
      const chunk = new Uint8Array(event.payload.bytes);
      pendingAckBytes += chunk.length;
      term.write(chunk, () => {
        // `dispose()` kann zwischen diesem `write()`-Aufruf und dem
        // Feuern seines Callbacks gelaufen sein UND den ausstehenden
        // Betrag bereits in einer Sammel-Bestaetigung abgerechnet haben
        // (siehe dortiger Kommentar). Feuert dieser Callback trotzdem
        // noch nach, darf er NICHT ein zweites Mal fuer dieselben Bytes
        // bestaetigen.
        if (disposed) return;
        pendingAckBytes -= chunk.length;
        // Befund 9: nach connection-lost ist der Terminaleintrag im Backend
        // bereits entfernt (Pumpaufgabe). `ack_output_impl` ist zwar
        // inzwischen idempotent, aber dieser Aufruf haette ohnehin keine
        // Wirkung mehr -- er bleibt hier still.
        if (channelClosed) return;
        // Ack ERST im write()-Callback, nicht davor: das ist die Bremse,
        // die verhindert, dass xterm.js oberhalb von 50 MB Ausgabe still
        // verwirft (Spec V31). `byteCount` ist die Groesse DIESES Pakets
        // (inkrementell), nicht die kumulative Summe -- siehe
        // `ack_output_impl` im Backend. Ausgabe kann schon vor der Antwort auf
        // `open_terminal` eintreffen; ein Ack fuer einen Kanal, den das
        // Backend nicht (mehr) kennt, ist dort kein Fehler
        // (`ack_output_tagged_impl`).
        void invoke("ack_output", {
          hostId,
          session,
          openId,
          byteCount: chunk.length,
          ...socketArg,
        }).catch((error: unknown) => {
          // UX-Spec §6.9: nur die Konsole. Ein Ack betrifft die Flusskontrolle,
          // der Nutzer koennte mit einem Hinweis darauf nichts anfangen.
          console.warn(`[terminal] ack_output failed: ${String(error)}`);
        });
      });
    },
  );

  // M-C (Abschlussreview): zweiter Listener, registriert VOR `open_terminal`
  // aus demselben Grund wie `unlistenPromise` oben -- sonst koennte ein
  // Verbindungsverlust unmittelbar nach dem Attach eintreffen, bevor dieser
  // Listener existiert, und bliebe fuer diese Ansicht unsichtbar (Status
  // zeigte weiter "Connected", Eingabe bliebe frei).
  const unlistenLostPromise = listen<ConnectionLostEventPayload>(
    "terminal://connection-lost",
    (event) => {
      if (disposed) return;
      // Zwei Hosts duerfen gleichnamige tmux-Sessions haben (Spec §4.3) --
      // ohne den Host-Vergleich wuerde ein fremder Verbindungsverlust diese
      // Ansicht faelschlich sperren.
      if (event.payload.host_id !== hostId) return;
      if (event.payload.session !== session || event.payload.open_id !== openId) return;
      channelClosed = true;
      // Vor der Antwort auf `open_terminal`: der Kanal haengt nie an, der
      // Puffer hat kein Ziel mehr.
      pendingInput = null;
      // Eingabe sperren gehoert HIER hin (nicht in `options.onConnectionLost`):
      // nur `mountTerminal` haelt `term`. Der Aufrufer bekommt ueber den
      // Callback lediglich Gelegenheit, den sichtbaren Zustand zu aendern
      // (dasselbe Delegationsmuster wie `onError`).
      applyInputLock();
      options?.onConnectionLost?.();
    },
  );

  // Spec 2026-10-19 §8.1 (Schritt 3): mit Schlange (`MountOptions.openQueue`)
  // geht `open_terminal` erst hinaus, wenn drei Dinge zusammenkommen: ein Platz
  // in der Schlange dieses Hosts, beide Listener oben und eine noch nicht
  // entsorgte Ansicht. Eingereiht wird hier, synchron beim Mounten: so ist die
  // Reihenfolge der Schlange die des Aufrufers. Ohne Schlange gibt es kein
  // Ticket, und das Oeffnen folgt wie bisher im selben Mikrotask auf die
  // Listener.
  let listenersReady = false;
  let openSent = false;
  const ticket =
    options?.openQueue?.enter(hostId, () => {
      // Synchron im `release()` einer anderen Ansicht dieses Hosts. Eine
      // entsorgte Ansicht hat die Schlange da schon verlassen (`dispose()`).
      // Wirft der Aufrufer in `onQueued`, bleibt der Fehler hier: er wird
      // protokolliert, nicht weitergereicht. Das `release()`, in dem dieser
      // Rueckruf laeuft, steht am Anfang der Antwort auf `open_terminal` und
      // von `dispose()` der anderen Ansicht; ein Fehler im Aufrufer liesse
      // diese Ansicht unangehaengt (`attached`, Nachholen der Groesse,
      // `onOpened`) oder halb entsorgt zurueck. Das Oeffnen dieser Ansicht
      // geht trotzdem hinaus: der Platz ist schon gezaehlt, und frei wird er
      // nur mit der Antwort.
      try {
        options?.onQueued?.(false);
      } catch (error: unknown) {
        console.error("[terminal] onQueued(false) threw:", error);
      } finally {
        startOpen();
      }
    }) ?? null;
  if (ticket !== null && !ticket.granted) {
    // Wirft der Aufrufer schon hier, bleibt der Fehler auch hier: protokolliert,
    // nicht weitergereicht. Sonst braeche `mountTerminal` mitten im Aufbau ab
    // und lieferte keinen Handle: das eingereihte Ticket bliebe verwaist (es
    // bekaeme spaeter einen Platz, sendete nie und gaebe ihn nie zurueck, ein
    // Platz des Hosts waere verloren), und alles darunter -- das Abwarten der
    // Listener, der Refit -- fehlte.
    try {
      options?.onQueued?.(true);
    } catch (error: unknown) {
      console.error("[terminal] onQueued(true) threw:", error);
    }
  }

  /** Sendet `open_terminal` genau einmal, sobald Platz, Listener und Ansicht
   * es erlauben. Gerufen, wenn die Listener stehen, und bei der Zuteilung. */
  function startOpen(): void {
    if (openSent || disposed || !listenersReady) return;
    if (ticket !== null && !ticket.granted) return;
    openSent = true;
    // Mit dieser Groesse startet das PTY; gegen sie vergleicht das Nachholen
    // nach dem Anhaengen (Abnahme B1). Gelesen beim Absenden, nicht beim
    // Mounten: ein Refit in der Wartezeit hat nur gefittet und gemeldet.
    lastSentCols = term.cols;
    lastSentRows = term.rows;
    void invoke("open_terminal", {
      hostId,
      session,
      openId,
      ...socketArg,
      cols: lastSentCols,
      rows: lastSentRows,
      sessionId: options?.sessionId ?? null,
      serverPid: options?.serverPid ?? null,
      serverStartTime: options?.serverStartTime ?? null,
      windowId: options?.windowId ?? null,
      paneId: options?.paneId ?? null,
      panePid: options?.panePid ?? null,
    }).then(
      () => {
        // Spec 2026-10-19 §8.1: der Platz wird mit der Antwort frei, auch fuer
        // eine inzwischen entsorgte Ansicht. Das Backend nimmt seine offene
        // Einrichtung vor der Antwort heraus (`TerminalAttempt`, commands.rs);
        // nur so begrenzen die Plaetze hier auch seine Zahl.
        ticket?.release();
        if (disposed) return;
        attached = true;
        // Abnahme B1: ein Refit waehrend des Oeffnens hat nur gefittet und
        // gemeldet. Hat er die Groesse geaendert, geht sie jetzt hinaus, genau
        // einmal. Steht noch ein Refit aus, bleibt das ihm: sein Fit misst
        // gleich neu und vergleicht dann selbst -- hier zusaetzlich zu senden
        // ergaebe zwei Aufrufe, sobald sein Fit die Groesse weiter aendert.
        if (resizeTimer === undefined) sendSizeIfChanged();
        flushPendingInput();
        options?.onOpened?.();
      },
      (error: unknown) => {
        // Wie oben: auch eine Ablehnung beendet die Einrichtung im Backend.
        ticket?.release();
        // Der Kanal entsteht nie; was vorher getippt wurde, hat kein Ziel. Die
        // Meldung unten nennt das Oeffnen, nicht die Eingabe.
        pendingInput = null;
        // Fire-and-forget bis hierher waere ein leeres Terminal ohne jede
        // Erklaerung: Kanal-Limit, Session bereits verschwunden usw. bleiben
        // sonst unsichtbar (siehe `onError`-Kommentar oben).
        if (disposed) return;
        onError?.({ kind: "open", detail: String(error) });
        // Die `disposed`-Wache steht oben VOR dem `invoke` -- sie hilft hier
        // nicht: zwischen Absenden und Ablehnung liegt eine Netzrunde, und ein
        // Layoutwechsel unmittelbar nach dem Oeffnen entsorgt den Handle genau
        // darin. Ohne diese zweite Pruefung sperrte der Aufrufer eine Session,
        // die gar keine Kachel mehr hat -- `sessionIndicator` prueft
        // `inputLocked` VOR `open` (`app-state.ts`), die Seitenleiste zeigte
        // dann dauerhaft "Input locked" fuer eine geschlossene Session.
        if (disposed) return;
        options?.onOpenFailed?.();
      },
    );
  }

  void Promise.all([unlistenPromise, unlistenLostPromise]).then(
    () => {
      listenersReady = true;
      startOpen();
    },
    (error: unknown) => {
      // Ohne beide Listener geht `open_terminal` nie hinaus (siehe oben): die
      // Kachel wartete sonst still fuer immer, und ihr Platz in der Schlange
      // des Hosts bliebe belegt. Dieselbe Lage wie ein abgelehntes Oeffnen.
      if (!openSent) ticket?.release();
      pendingInput = null;
      if (disposed) return;
      onError?.({ kind: "open", detail: String(error) });
      options?.onOpenFailed?.();
    },
  );

  // Ohne den Vergleich unten loest JEDER `resize`-Event (Pixel-Ruckler,
  // Zoom hin und zurueck, DevTools auf/zu) nach der Entprellung einen
  // SSH-`window_change` aus, selbst wenn `cols`/`rows` sich gar nicht
  // geaendert haben -- `PtyHandle::resize` vergleicht selbst nicht gegen
  // die aktuelle Groesse, sondern sendet unbedingt. Bei einem inline
  // rendernden Agenten (Codex) loescht jeder Resize den SERVERSEITIGEN
  // tmux-Scrollback (`ESC[3J`, siehe Kommentar zu `RESIZE_DEBOUNCE_MS`
  // oben) -- ein Resize auf dieselbe Groesse darf deshalb keine Wirkung
  // haben. `lastSentCols`/`lastSentRows` sind oben (bei `fit.fit()`)
  // deklariert und geseedet.
  //
  // Der EINE Sendeweg fuer `resize_terminal`: nach dem entprellten Refit und
  // beim Nachholen nach dem Anhaengen (Abnahme B1). Vor dem Anhaengen gibt es
  // im Backend keinen Eintrag -- der Aufruf wurde abgewiesen, und die Groesse
  // galt trotzdem als gesendet; das PTY blieb in der Zwischengroesse stehen.
  // Ein gescheitertes Oeffnen haengt nie an und sendet darum nie.
  function sendSizeIfChanged(): void {
    if (!attached) return;
    if (term.cols === lastSentCols && term.rows === lastSentRows) return;
    lastSentCols = term.cols;
    lastSentRows = term.rows;
    // Befund 9: die Sperrleiste loest nach connection-lost oft einen
    // Refit aus (Layoutwechsel um die Sperranzeige herum) -- der
    // Terminaleintrag im Backend ist dann schon weg, ein `resize_terminal`
    // traefe also ohnehin ins Leere.
    if (channelClosed) return;
    void invoke("resize_terminal", {
      hostId,
      session,
      openId,
      cols: term.cols,
      rows: term.rows,
      ...socketArg,
    }).catch((error: unknown) => {
      // Ohne diesen Pfad bleibt das entfernte PTY lautlos in falscher
      // Groesse haengen -- kein sichtbares Signal ausser einem
      // verzerrten Redraw beim naechsten vollen Repaint.
      onError?.({ kind: "resize", detail: String(error) });
    });
  }

  let resizeTimer: ReturnType<typeof window.setTimeout> | undefined;
  /** Spec 2026-10-19 §8.1 (Schritt 3): eine andere Kachel ist maximiert, diese
   * steht in `display: none` (`setHidden`). Dort gibt es nichts zu messen:
   * FitAddon liest die berechnete Groesse des Containers, heute `auto` (dann
   * tut `fit()` nichts), mit einer festen Hoehe im CSS kaeme 2 x 1 heraus.
   * Darum die ausdrueckliche Marke statt eines Verlasses auf die Berechnung. */
  let hidden = false;
  // Umbenannt von `onResize` zu `scheduleRefit` (Task 10, Kachelraster):
  // dieselbe Funktion ist jetzt AUCH das Ziel von `refit()` unten, nicht nur
  // des `window`-Listeners. Beide Aufrufer teilen sich denselben Timer --
  // genau die Bedingung aus Designsystem §5.5 ("laeuft durch denselben
  // entprellten Pfad wie window.resize"). Gesendet wird ueber
  // `sendSizeIfChanged`.
  const scheduleRefit = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      // Ab hier steht kein Refit mehr aus (das Anhaengen oben fragt danach).
      resizeTimer = undefined;
      // Erst NACH dem Leeren von `resizeTimer`: sonst unterbliebe das
      // Nachholen beim Anhaengen (Abnahme B1) fuer eine Groesse, die die
      // Kachel noch sichtbar gemessen hat. Verborgen kein Fit, keine Meldung,
      // kein `resize_terminal`; gemessen wird beim Zurueckholen, dessen Refit
      // das Raster ausloest. Das deckt `refit()`, den `window`-Lauscher und
      // `setFontSize` ab.
      if (hidden) return;
      fit.fit();
      // Vor dem Senden: der Kopf zeigt die Groesse der Kachel, auch wenn kein
      // `resize_terminal` noetig ist, der Kanal zu ist oder das Oeffnen noch
      // aussteht.
      options?.onSize?.(term.cols, term.rows);
      sendSizeIfChanged();
    }, RESIZE_DEBOUNCE_MS);
  };
  window.addEventListener("resize", scheduleRefit);

  return {
    // Task 10 (Kachelraster): der Kachelcontroller darf Layoutwechsel,
    // Maximieren und Seitenleisten-Ziehen NIE ueber einen eigenen zweiten
    // Entpreller fuehren (Designsystem §5.5, "nie ein direkter
    // resize_terminal-Aufruf aus dem Layout-Code") -- das wuerde das V12-
    // Risiko (Codex loescht bei jedem Resize den serverseitigen Verlauf)
    // verdoppeln und liesse sich nicht gemeinsam entprellen. `refit()` startet
    // deshalb GENAU denselben Timer wie ein echtes `window`-Resize-Event,
    // nicht eine Kopie davon.
    refit() {
      scheduleRefit();
    },
    focus() {
      // Nach dem Entsorgen bewusst wirkungslos: `term.dispose()` hat das
      // Hilfstextfeld aus dem Dokument genommen, ein `focus()` darauf waere
      // ein Fokus ins Nichts (der Fokus fiele auf `<body>`) -- schlimmer als
      // gar nichts zu tun.
      if (disposed) return;
      term.focus();
    },
    setTheme(theme) {
      // Wache wie bei `focus()`: nach `dispose()` ist `term` bereits
      // entsorgt, ein Themenwechsel danach darf ihn nicht mehr anfassen
      // (Review zu Aufgabe 3).
      if (disposed) return;
      term.options.theme = terminalTheme(theme);
    },
    setFontSize(size) {
      // Wache wie bei `setTheme`.
      if (disposed) return;
      const next = clampFontSize(size);
      // Dieselbe Groesse plant nichts: kein fit() und kein verlaengerter Timer
      // fuer eine Kachel, an der sich nichts aendert.
      if (term.options.fontSize === next) return;
      term.options.fontSize = next;
      scheduleRefit();
    },
    setInputLocked(locked) {
      // Wache wie bei `setTheme`.
      if (disposed) return;
      inputLockedByCaller = locked;
      // Eine Sperre vor dem Anhaengen verwirft, was bis dahin gepuffert ist;
      // das Freigeben laesst nur neue Eingabe durch.
      if (locked) pendingInput?.splice(0);
      applyInputLock();
    },
    setHidden(value) {
      // Wache wie bei `setTheme`. Plant nichts: wann gemessen wird, entscheidet
      // das Raster (es refittet jede wieder sichtbare Kachel genau einmal), und
      // es ruft dies bei jeder Lage, auch waehrend die Seitenleiste gezogen wird.
      if (disposed) return;
      hidden = value;
    },
    dispose() {
      disposed = true;
      pendingInput = null;
      // Spec 2026-10-19 §8.1: noch nicht gesendet, verlaesst die Ansicht die
      // Schlange oder gibt ihren schon zugeteilten Platz sofort weiter; nach
      // dem Senden gibt erst die Antwort ihn frei (`startOpen`). Zuerst: das
      // Zuteilen laeuft synchron weiter in eine andere Ansicht und deren
      // Aufrufer, und was der dabei an diesem Handle anstoesst (ein `refit()`
      // plant einen Zeitgeber), raeumen die Zeilen darunter wieder ab.
      if (!openSent) ticket?.release();
      // Nach `disposed = true`: das Schliessen des Menues gibt dem entsorgten
      // Terminal sonst den Fokus.
      listeners.abort();
      menu?.close();
      window.removeEventListener("resize", scheduleRefit);
      window.clearTimeout(resizeTimer);
      // `term.dispose()` unten entfernt nur xterm.js' EIGENE Elemente aus
      // `el` -- die Suchleiste ist ein eigenstaendig angehaengtes
      // Geschwisterelement, das sonst haengen bliebe. Ohne Rueckruf, ohne
      // Fokus: das Terminal ist weg.
      searchUi.dispose();
      // Ein Listener, der nie stand, hat nichts abzumelden; seine Ablehnung hat
      // das Oeffnen schon gemeldet.
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      void unlistenLostPromise.then((unlisten) => unlisten()).catch(() => {});
      // xterm.js' `WriteBuffer.write()` plant die Verarbeitung ueber
      // `setTimeout`; `term.dispose()` storniert diese Timer NICHT und
      // garantiert kein Nachfeuern haengender Callbacks. Ein `write()`,
      // das kurz vor `dispose()` abgesetzt wurde, koennte seinen Callback
      // also nie ausloesen -- dann wird `ack_output` fuer diese Bytes nie
      // gesendet, und der `AckGate` dieser Session bleibt mit
      // ausstehenden Bytes haengen. In Task 11 heilt das ein sofortiges
      // `disconnect_host` unmittelbar nach `dispose()` selbst (das
      // entsperrt den Gate ohnehin). Sobald `dispose()` in Task 12 ohne
      // sofortiges Close zum Normalfall wird (Tab-Wechsel), stuende ein
      // weggeschaltetes Terminal mit ausstehender Bestaetigung bis zum
      // Wiederoeffnen still. Deshalb: die Summe der noch ausstehenden,
      // nie bestaetigten Bytes hier einmalig nachbestaetigen.
      if (pendingAckBytes > 0) {
        const byteCount = pendingAckBytes;
        pendingAckBytes = 0;
        void invoke("ack_output", { hostId, session, openId, byteCount, ...socketArg }).catch(() => {});
      }
      // Reihenfolge der INVOKE-Aufrufe: erst nachbestaetigen (Block oben),
      // dann schliessen -- die Sammel-Bestaetigung gilt dem Eintrag, den
      // `close_terminal` entfernt. Die Ausfuehrung im Backend ordnet das
      // nicht: beide Aufrufe laufen dort als eigenstaendige Aufgaben, und
      // nichts ordnet ihren Zugriff auf `state.terminals`. Drehen sie sich,
      // findet das Ack keinen Eintrag mehr und bleibt ohne Wirkung
      // (`ack_output_tagged_impl`); nach dem Schliessen ist das gleichgueltig.
      //
      // BEIDE Aufrufe schlucken ihren Fehler, statt ihn an `onError` zu
      // reichen: `onError` landet im globalen Hinweisbanner, und ein voellig
      // gewoehnliches Schliessen liesse dort eine rote Meldung stehen. Ein
      // Fehlschlag auf DIESEM Weg ist gegenstandslos: die Ansicht ist bereits
      // entsorgt, und der Kanal wird so oder so mit dem naechsten
      // `disconnect_host` abgeraeumt. Fehler VOR dem Entsorgen gehen an
      // `onError` -- `open_terminal`, `send_input` und `resize_terminal`; dort
      // kann der Nutzer noch etwas damit anfangen. Das laufende `ack_output`
      // aus dem Write-Callback oben geht nur in die Konsole (UX-Spec §6.9).
      //
      // Spec 2026-10-19 §8.1: das Backend lernt die openId erst mit dem
      // `open_terminal` dieser Ansicht kennen und vergleicht sie beim
      // Schliessen. Eine Ansicht, die nie gesendet hat -- etwa eine wartende,
      // die vor ihrer Zuteilung entsorgt wird --, hat dort nichts zu schliessen.
      // Nach dem Senden schliesst jede, auch solange die Antwort aussteht.
      if (openSent) void invoke("close_terminal", { hostId, session, openId, ...socketArg }).catch(() => {});
      // Vor `term.dispose()`: der Renderer nimmt das Canvas dabei aus dem DOM.
      releaseWebglContext(el);
      term.dispose();
    },
  };
}
