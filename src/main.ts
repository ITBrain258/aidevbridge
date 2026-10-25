// Verdrahtung (Shell-Task 11, Spec §4.2): main.ts ist nur noch Klebstoff --
// `AppState` anlegen, `mountSidebar`/`mountGrid`/`mountHostKeyPrompt`
// mounten, Ereignisse verbinden. Alle bisherigen Modulvariablen (`hostId`,
// `terminalHandle`, `currentSession`, `hostChooserHandle`) sind ERSATZLOS
// entfallen -- `AppState` (`src/state/app-state.ts`) ist die einzige
// Wahrheitsquelle fuer Hosts/Sessions/Kacheln, `sidebar.ts`/`grid.ts` lesen
// nur noch aus ihr.
//
// Zwei Waechter aus der Vorgaenger-Fassung dieser Datei (`if (!terminalHandle)
// return` in `closeTerminalView`, sowie ein Waechter auf
// `sessionSection.hidden` in `onNewSession`) sind mit diesem Umbau ENTFERNT
// -- nicht neu geprueft und stehen gelassen, sondern tatsaechlich geloescht,
// zusammen mit den Funktionen, die sie trugen (`closeTerminalView`,
// `terminalActions()`, `reopenTerminal`, `createSessionAndOpenTerminal`).
// Deren Begruendung ("kein Menue kann sie erreichen") ist durch die
// Seitenleiste nachweislich falsch geworden -- aber genau deshalb existieren
// die Funktionen selbst in dieser Architektur nicht mehr: `grid.ts` mountet/
// entsorgt jeden `TerminalHandle` jetzt SELBST, in seinem eigenen
// `reconcile()` (Shell-Task 10) -- main.ts ruft `mountTerminal` nirgends
// mehr auf, haelt keinen `TerminalHandle` und keine `sessionSection` mehr.
// Der Ctrl+Shift+N-Akkord legt eine Session auf dem Zielhost aus UX-Spec §7.9
// an (zuerst der Host der fokussierten Kachel), verdrahtet in
// `newSessionOnTargetHost()` unten -- und zwar AUSSCHLIESSLICH dort; der Knopf
// "New session" im leeren Raster ruft dieselbe Funktion. `terminal.ts`s
// `MountOptions` hat dafuer kein `onNewSession` mehr (es hatte nie einen
// Durchreicher in `grid.ts`s `GridOptions`, der Akkord war app-weit tot);
// zwei Verdrahtungen wuerden die Session doppelt anlegen, weil im Terminal
// kein `stopPropagation()` faellt. Der zweite, ebenfalls erreichbare Weg zu
// "Neue Session" ist
// `sidebar.ts`s
// `onNewSession(hostId)` -- siehe dessen Verdrahtung unten; die einzige
// Pruefung, die dafuer noch noetig ist, ist eine simple TypeScript-Verengung
// (`if (!host) return`, die Seitenleiste liefert nur IDs aus `state.hosts`),
// keine Reichweiten-Behauptung, die ein kuenftiger Leser erneut pruefen
// muesste.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import en from "./i18n/en.json";
import {
  AppState,
  sessionKey,
  sessionKeyOf,
  socketOf,
  type Host,
  type HostSettings,
  type OpenResult,
  type Session,
  type SessionListError,
  type SessionSocket,
} from "./state/app-state";
import { MAX_TILES, MAX_TILES_PER_HOST } from "./state/tile-assignment";
import {
  nextWaitingSession,
  updateSeenWaiting,
  updateWaitingSince,
  waitingKey,
  waitingSessions,
  windowTitle,
} from "./state/attention";
import { retryDelay } from "./state/retry-schedule";
import { createHostReconnector, isRetryableConnectError, type ReconnectAttemptResult } from "./state/reconnect";
import { connectInOrder, createWorkspaceSync, withRecentDir } from "./state/workspace";
import { installKeyboard } from "./keyboard";
import { focusableElements, mountDialogShell } from "./views/dialog";
import { mountSidebar } from "./views/sidebar";
import { mountSidebarResize } from "./views/sidebar-resize";
import { mountGrid, type GridHandle } from "./views/grid";
import { mountFirstRun, type FirstRunHandle } from "./views/first-run";
import { mountHostForm, type AuthChoice, type HostFormValue } from "./views/host-form";
import {
  changesConnection,
  editHost,
  mountSessionDialog,
  reconnectSecret,
  type SessionDialogHandle,
} from "./views/session-dialog";
import { mountHostKeyPrompt } from "./views/host-key-prompt";
import type {
  ControlStateEventDto,
  HostEntry,
  SessionListDto,
  SessionListErrorDto,
  SessionListItemDto,
  SocketPollDto,
  SocketSessionsDto,
  StatusPollDto,
  StatusPollsDto,
} from "./views/types";
import { applyTheme, currentTheme, isThemeId, normalizeTheme, onThemeApplied, readCachedTheme, type ThemeId } from "./theme";
import type { FontSizeChange } from "./keymap";
import { DEFAULT_TERMINAL_FONT_SIZE, onTerminalPrefsChanged, setTerminalPrefs, terminalPrefs } from "./terminal-prefs";
import { createUiSettingsSync } from "./state/ui-settings-sync";
import { mountSettingsDialog } from "./views/settings-dialog";
import { openQuickOpen, quickOpenItems, quickOpenLabels, type QuickOpenItem } from "./views/quick-open";
import type { UiSettingsDto } from "./views/types";
import { appVersionLine } from "./version";

type TranslationKey = keyof typeof en;

function t(key: TranslationKey, params?: Record<string, string>): string {
  const template = en[key];
  if (!params) return template;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.split(`{${name}}`).join(value),
    template,
  );
}

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

interface Elements {
  app: HTMLElement;
  sidebar: HTMLElement;
  grid: HTMLElement;
  hostKeyPromptRoot: HTMLElement;
  dialogRoot: HTMLElement;
}

function collectElements(): Elements {
  return {
    app: required("app"),
    sidebar: required("sidebar"),
    grid: required("grid"),
    hostKeyPromptRoot: required("host-key-prompt-root"),
    dialogRoot: required("dialog-root"),
  };
}

// Die Tab-Zaehlung der Fokus-Falle lebt mit der Dialoghuelle in
// `views/dialog.ts`; weitergereicht, damit `main.test.ts` sie unveraendert
// von hier pruefen kann (Spec 16.2).
export { focusableElements };

/** Deckungsgleich mit `HostEntry` (`views/types.ts`, Rust `settings::HostEntry`)
 * -- der Lader, den Shell-Task 3 (`app-state.ts`) noch nicht hatte (siehe
 * dessen Doc-Kommentar an `Host.tmuxSocket`/`.historyLimit`: "Sache von
 * Shell-Task 11"). `tmux_socket`/`history_limit` OHNE Umweg uebernommen --
 * `add_host_impl` ehrt bereits einen gesetzten Wert (`Some`) und faellt nur
 * bei `None` auf die Vorgabe zurueck, ein frisch geladener Host reicht seine
 * gespeicherten Werte also unveraendert durch `editHost` (`session-
 * dialog.ts`) hindurch, sobald sie hier ankommen. `state` startet immer bei
 * `"disconnected"` -- `list_hosts` liest nur `settings.toml`, es baut keine
 * Verbindung auf. */
function hostFromEntry(entry: HostEntry): Host {
  return {
    id: entry.id,
    ...settingsFromEntry(entry),
    state: "disconnected",
    error: null,
    errorCode: null,
    sessions: [],
    expanded: false,
    // Leer heisst "Heimatverzeichnis": das Fernskript setzt bei leerem Pfad
    // `d=$HOME` (`remote/dirs.rs`), und der Baum loest es auf und meldet es
    // dem Sitzungsdialog zurueck. Frueher stand hier `/tmp` -- eine Vorgabe,
    // die keine Anmeldung der Welt setzt, welt-schreibbar ist und auf vielen
    // Systemen beim Neustart geleert wird.
    //
    // Nur der STARTWERT: sobald eine Session angelegt wurde, traegt
    // `host.lastCwd` das zuletzt benutzte Verzeichnis dieses Hosts in diesem
    // Lauf (siehe `rememberSessionDir` unten). Ueber einen Neustart hinweg
    // traegt es der Arbeitsplatz (`dirs[host].last`, UX-Spec §7.6); erst ohne
    // beides beginnt der Dialog im Heimatverzeichnis.
    lastCwd: "",
    runtimeId: null,
  };
}

/** Die gespeicherten Felder eines `HostEntry` in der Form von `AppState` --
 * fuer `hostFromEntry` und fuer `updateHostSettings` nach einem gespeicherten
 * "Edit" (UX-Spec §7.7). */
function settingsFromEntry(entry: HostEntry): HostSettings {
  return {
    label: entry.label,
    hostname: entry.hostname,
    user: entry.user,
    port: entry.port,
    keyPath: entry.key_path,
    authKind: entry.auth_kind,
    tmuxSocket: entry.tmux_socket,
    historyLimit: entry.history_limit,
    showDefaultSocket: entry.show_default_socket ?? true,
  };
}

/* Zwei getrennte ID-Raeume treffen aufeinander: `list_hosts`/`add_host`/
 * `remove_host` adressieren einen Host ueber die in `settings.toml`
 * gespeicherte `id`; `begin_connect` reserviert fuer JEDEN Versuch
 * eine frische, davon unabhaengige Laufzeit-ID.
 *
 * Die Regel dafuer steht an `Host.runtimeId` (`app-state.ts`) und gilt im
 * ganzen Programm: `host.id` IST die settings.toml-ID und aendert sich nie,
 * `host.runtimeId` traegt die Laufzeit-ID daneben. Jeder `invoke`, der eine
 * LEBENDE VERBINDUNG meint, uebersetzt auf `host.runtimeId`; alles andere --
 * `AppState`, Kachelschluessel, Fokusschluessel, `remove_host` -- laeuft auf
 * `host.id`.
 *
 * Uebersetzt wird DICHT AM `invoke`, nicht bei dessen Aufrufern: ein
 * Fehlgriff INS Backend meldet zwar "host not connected" und ist damit laut,
 * ein Fehlgriff in der Gegenrichtung dagegen ist STILL -- `setHostState` und
 * `setSessions` finden ihren Host per `id` nicht und kehren kommentarlos um
 * (`app-state.ts`). Ein Aufrufer, der eine Funktion mit dem falschen ID-Raum
 * fuettert, soll deshalb gar nicht erst entstehen koennen.
 *
 * Eine Uebersetzung liegt ausserhalb dieser Datei: `grid.ts::reconcile` gibt
 * `mountTerminal` die Laufzeit-ID mit -- unterhalb dieser Grenze meint jeder
 * Aufruf eine lebende Verbindung (siehe `ResolvedSession.runtimeHostId`). */

/** Polltakt je Host (UX-Spec §5.2): der naechste Poll beginnt fruehestens so
 * lange nach dem Ende des vorigen. */
const SESSION_STATUS_POLL_MS = 2000;
/** Raeumt die Hintergrundarbeit des laufenden `main()` ab, gesetzt von dort. */
let stopBackgroundWork: (() => void) | null = null;

/** So lange steht ein neutraler Hinweis wie die Grenze (Spec 2026-10-19 §5.3),
 * bevor er sich selbst schliesst (`mountGlobalErrorBanner`). */
export const NEUTRAL_NOTICE_MS = 6000;

/** Stops the per-host status polls, the self-repair and reconnect timers with
 * their window listeners, disposes the grid (its quiet reattach timers), and
 * removes the keyboard listeners. `main()` calls this on re-entry so tests do
 * not stack timers or listeners; the app itself runs `main()` once. */
export function stopSessionStatusPoll(): void {
  stopBackgroundWork?.();
  stopBackgroundWork = null;
}

export function main(): void {
  stopSessionStatusPoll();
  // UI v2 §12.5: erster Anstrich aus localStorage, VOR dem ersten Mount.
  applyTheme(readCachedTheme());

  const elements = collectElements();
  document.title = t("app.title");

  const state = new AppState();
  let seenWaiting = new Set<string>();
  /** Spec 2026-10-19 §7: Beginn jeder Warte-Episode (`waitingKey`), ab der
   * ersten Beobachtung in diesem Lauf. Die Wartet-Spur zeigt daraus die
   * Wartezeit und ordnet die aelteste nach oben. */
  let waitingSince = new Map<string, number>();
  const statusCurrent = (host: Host, session: Session): boolean =>
    state.isSessionStatusCurrent(host.id, session.name, socketOf(session));
  const attentionLive = document.createElement("div");
  attentionLive.className = "ab-visually-hidden";
  attentionLive.setAttribute("aria-live", "polite");
  // AUSSERHALB von `#app` (UX-Spec §11): ein offener Dialog legt `#app` per
  // `inert` still, und eine Live-Region darin saehe Hilfstechnik dann nicht
  // mehr -- gerade waehrend eines Dialogs kaeme die Ansage nie an.
  document.body.appendChild(attentionLive);
  /** Zeigt die Region gerade die Zahl der Wartenden? Nur sie wird wieder
   * geleert, wenn niemand mehr wartet; eine einzelne Ansage (`announce`)
   * bleibt stehen, bis die naechste sie ersetzt -- sonst leerte sie schon das
   * naechste Neuzeichnen, bevor Hilfstechnik sie vorgelesen hat. */
  let liveShowsWaiting = false;

  /** Sagt einen Satz ueber dieselbe hoefliche Live-Region an. */
  function announce(text: string): void {
    attentionLive.textContent = text;
    liveShowsWaiting = false;
  }

  function applyWaitingAttention(): void {
    const waiting = waitingSessions(state.hosts, statusCurrent);
    const title = windowTitle(t("app.title"), waiting.length);
    if (document.title !== title) document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
    const focusedKey = state.focusedSessionKey();
    const episodes = updateSeenWaiting(seenWaiting, state.hosts, statusCurrent);
    seenWaiting = episodes.seen;
    waitingSince = updateWaitingSince(waitingSince, episodes.seen, Date.now());
    const newcomers = episodes.newcomers.filter((key) => {
      const session = waiting.find((row) => waitingKey(row) === key);
      return session !== undefined && sessionKeyOf(session) !== focusedKey;
    });
    if (newcomers.length > 0) {
      attentionLive.textContent = t("attention.waiting", { count: String(waiting.length) });
      liveShowsWaiting = true;
      if (!document.hasFocus()) {
        void getCurrentWindow()
          .requestUserAttention(UserAttentionType.Informational)
          .catch(() => {});
      }
    } else if (waiting.length === 0 && liveShowsWaiting) {
      attentionLive.textContent = "";
      liveShowsWaiting = false;
    }
  }

  state.subscribe(applyWaitingAttention);
  // Der Fensterfokus beendet das Blinken und zieht einen wartenden Versuch der
  // Selbstreparatur vor (`onWindowFocus`, angemeldet unten mit dem Abbau).

  // Laufzeit-Handles der aktuell gemounteten Ueberlagerungen. Kein Ersatz
  // fuer die entfallenen Modulvariablen aus der Kopfkommentar-Erklaerung
  // oben (die hielten ANWENDUNGSZUSTAND, den `AppState` jetzt haelt) --
  // diese drei halten nur, WELCHE ANSICHT gerade gemountet ist, damit sie
  // vor der naechsten wieder sauber entsorgt wird. `gridHandle` wird GENAU
  // EINMAL gesetzt (beim ersten Host, der je verbunden ist oder war) und
  // danach nie wieder disposed, solange die App laeuft -- ein Dispose
  // wuerde jedes gerade sichtbare Terminal mit abraeumen (`GridHandle.dispose()`
  // schliesst jeden gemounteten `TerminalHandle`), nur um Platz fuer eine
  // Ueberlagerung zu machen, die das gar nicht braucht (siehe
  // `openDialog` in `views/dialog.ts`: Ueberlagerungen liegen
  // AUSSERHALB von `elements.grid`, sie verdraengen das Raster nicht).
  let gridHandle: GridHandle | null = null;

  /** Rohwert aus settings.toml, wenn er kein bekanntes Thema war (Hinweis im Dialog, §12.1). */
  let unknownStoredTheme: string | null = null;

  // §12.2: jeder Themenwechsel erreicht die offenen Kacheln; ohne fit(), ohne resize.
  // Die Abmeldefunktion wird bewusst nirgends aufgerufen -- `main()` kennt
  // keine eigene Stillegung, die Anwendung laeuft bis zum Prozessende.
  const offThemeApplied = onThemeApplied((theme) => gridHandle?.applyTerminalTheme(theme));
  void offThemeApplied;

  /** "Restore hosts and terminals" (`ui.restore_workspace`, UX-Spec §7.2, §9.1);
   * bis zur Antwort von `ui_settings` der Standard. */
  let restoreWorkspace = true;
  /** Pfad von settings.toml fuer About (UX-Spec §9.1), aus der ersten Antwort
   * von `ui_settings`; `null`, solange sie fehlt. */
  let settingsPath: string | null = null;
  /** Hat der Nutzer die Breite der Seitenleiste in diesem Lauf schon gewaehlt
   * (UX-Spec §7.8)? Dann ersetzt eine spaeter eintreffende gespeicherte sie
   * nicht mehr; gespeichert wird ohnehin seine. */
  let sidebarWidthChosen = false;

  // UX-Spec §9.2: die [ui]-Felder gehen entprellt hinaus, mit nur den
  // geaenderten Feldern (`state/ui-settings-sync.ts`). Das Thema hat seinen
  // eigenen Weg (`persistTheme`), den Arbeitsplatz schreibt `workspaceSync`.
  const uiSettingsSync = createUiSettingsSync((patch) => invoke<UiSettingsDto>("ui_settings", { patch }));

  // UX-Spec §7.1: der Arbeitsplatz geht entprellt als ganzer Schnappschuss
  // hinaus, mit einem eigenen Schreiber neben dem der [ui]-Felder. Beide
  // schicken Teil-Patches; Rust fuehrt `ui_settings` nacheinander aus. Bis
  // `start` (aus `bootstrap`) schreibt er nichts, ohne gelesenen Stand nie.
  const workspaceSync = createWorkspaceSync({
    state,
    write: (snapshot) => invoke<UiSettingsDto>("ui_settings", { patch: { workspace: snapshot } }).then(() => {}),
    // `sidebarCollapsed` steht weiter unten; gelesen wird erst nach `start`.
    sidebarCollapsed: () => sidebarCollapsed,
    setSidebarCollapsed: (collapsed) => setSidebarCollapsed(collapsed),
  });
  state.subscribe(() => workspaceSync.changed());

  // UX-Spec §6.7: eine neue Schriftgroesse erreicht jede offene Kachel, wer sie
  // auch geaendert hat (Strg+Mausrad in `terminal.ts`, die Tasten, die
  // Einstellungen). Eine spaeter gemountete Kachel liest sie beim Bau selbst.
  // Jede Aenderung der Terminal-Einstellungen geht an den Schreiber. Anders als
  // beim Thema wird hier abgemeldet (`stopBackgroundWork`): `main()` laeuft in
  // Tests mehrfach, und ein alter Lauf reichte sonst an sein Raster und
  // schriebe mit.
  let lastPrefs = terminalPrefs();
  const offTerminalPrefs = onTerminalPrefsChanged((prefs) => {
    const previous = lastPrefs;
    lastPrefs = prefs;
    if (prefs.fontSize !== previous.fontSize) gridHandle?.applyTerminalFontSize(prefs.fontSize);
    uiSettingsSync.prefsChanged(previous, prefs);
  });

  /** §12.5, UX-Spec §9.2: liest die gespeicherten Einstellungen, korrigiert den
   * Vorlauf des Themas und uebernimmt die Terminal-Einstellungen. Fehlt ein
   * brauchbares Ergebnis, bleiben die lokalen Werte -- kein Banner, nur
   * console.warn -- und es gibt `null`: dann stellt der Start nichts wieder her
   * und schreibt den Arbeitsplatz nie. Sonst liefert sie aus DERSELBEN Antwort,
   * was der Start dafuer braucht (UX-Spec §7.2). */
  async function loadStoredSettings(): Promise<{ restore: boolean; workspace: unknown } | null> {
    let dto: Partial<UiSettingsDto> | null | undefined;
    try {
      dto = await invoke<UiSettingsDto | null | undefined>("ui_settings", { patch: null });
    } catch (error) {
      console.warn(`[settings] ui_settings failed: ${String(error)}`);
      return null;
    }
    if (!dto) {
      console.warn("[settings] ui_settings returned nothing, keeping the local values");
      return null;
    }
    applyStoredTheme(dto.theme);
    applyStoredUi(dto);
    return { restore: restoreWorkspace, workspace: dto.workspace };
  }

  function applyStoredTheme(raw: unknown): void {
    if (typeof raw !== "string") {
      console.warn("[theme] ui_settings returned no theme, keeping the local value");
      return;
    }
    if (isThemeId(raw)) {
      unknownStoredTheme = null;
      if (raw !== currentTheme()) applyTheme(raw);
    } else {
      unknownStoredTheme = raw;
      applyTheme(normalizeTheme(raw)); // warnt einmal, faellt auf turquoise
    }
  }

  /** Jedes Feld einzeln geprueft (`ui-settings-sync.ts`): eine aeltere oder
   * unvollstaendige Antwort laesst die uebrigen Werte stehen. Der Schreiber
   * kennt den gespeicherten Stand VOR `setTerminalPrefs`, damit das Echo des
   * Abonnenten oben nichts schreibt. */
  function applyStoredUi(dto: Partial<UiSettingsDto>): void {
    if (typeof dto.settings_path === "string") settingsPath = dto.settings_path;
    const stored = uiSettingsSync.applyStored(dto);
    if (stored.fields.restore_workspace !== undefined) restoreWorkspace = stored.fields.restore_workspace;
    setTerminalPrefs(stored.prefs);
    // UX-Spec §7.8: die gespeicherte Breite gilt, sobald die Antwort da ist --
    // ohne `onCommit`, also ohne Schreiben, und nur, solange der Nutzer in
    // diesem Lauf noch keine gewaehlt hat. Kommt sie vor dem Raster, messen
    // die Terminals beim Mounten schon richtig; steht es bereits, passt es
    // sich einmal an. `sidebarResize` steht weiter unten; gerufen wird erst
    // nach dem `await` in `loadStoredSettings`, also nach dem Mount.
    const width = stored.fields.sidebar_width;
    if (width !== undefined && !sidebarWidthChosen && sidebarResize.setWidth(width)) gridHandle?.refit();
  }

  function onRestoreWorkspaceChange(value: boolean): void {
    restoreWorkspace = value;
    uiSettingsSync.schedule("restore_workspace", value);
  }

  function persistTheme(theme: ThemeId): void {
    void invoke<UiSettingsDto>("ui_settings", { patch: { theme } })
      .then(() => {
        unknownStoredTheme = null;
      })
      .catch((error: unknown) => {
        console.warn(`[theme] ui_settings write failed: ${String(error)}`);
      });
  }

  function onOpenSettings(): void {
    openDialog(
      { title: t("settings.title"), large: true },
      (container) =>
        // Lesefunktionen statt Werte: jeder Bereich liest beim Mounten den
        // Stand von jetzt (siehe `SettingsDialogOptions`).
        mountSettingsDialog(container, {
          currentTheme,
          unknownStoredTheme: () => unknownStoredTheme,
          onThemeChange: applyTheme,
          onPersist: persistTheme,
          restoreWorkspace: () => restoreWorkspace,
          onRestoreWorkspaceChange,
          settingsPath: () => settingsPath,
        }),
    );
  }

  let firstRunInGridHandle: FirstRunHandle | null = null;
  // Die Dialoghuelle dieses Laufs (`views/dialog.ts`): je `main()` eine
  // eigene, damit die offene Ueberlagerung, ihr Fokus-Rueckkehrziel und die
  // TOFU-Sperre wie zuvor an diesem Lauf haengen und nicht am Modul.
  const dialogs = mountDialogShell(elements.dialogRoot, elements.app);
  const { openDialog, closeDialog } = dialogs;

  // Generations guard all asynchronous results. Each pending runtime ID owns
  // cancellation before connect_host returns; late reservations are released.
  const connectGenerationByHostId = new Map<string, number>();
  const connectReservations = new Map<string, { generation: number; runtimeId: string }>();
  // Only explicitly owned, not-yet-handed-over runtimes can retain early events.
  // Ready host state owns them after handoff; release removes the entire record.
  const pendingRuntimeEvents = new Map<string, { lost: boolean; control: ControlStateEventDto | null }>();

  function trackRuntimeOwnership(runtimeId: string, owned: boolean): void {
    if (owned) pendingRuntimeEvents.set(runtimeId, { lost: false, control: null });
    else pendingRuntimeEvents.delete(runtimeId);
  }

  function markTerminalTransportLost(host: Host): void {
    // Ohne Terminalverbindung keine Selbstreparatur der Steuerung (§5.3).
    cancelSelfRepair(host.id);
    for (const session of host.sessions) {
      if (session.open) state.lockInput(host.id, session.name);
    }
    state.setHostState(host.id, "failed", t("terminal.transportLost"));
    // UX-Spec §5.4: Hosts mit Schluessel oder ssh-agent verbindet die App
    // selbst neu; bis dahin zeigen Hostzeile und Kacheln "Reconnecting…".
    if (reconnectsByItself(host)) hostReconnects.start(host.id);
  }

  function applyControlEvent(host: Host, event: ControlStateEventDto): void {
    state.setControlState(host.id, {
      generation: event.control_generation, state: event.state, message: event.message ?? null,
    });
    followControlForSelfRepair(host);
  }

  function applyPendingRuntimeEvents(host: Host): void {
    if (!host.runtimeId) return;
    const pending = pendingRuntimeEvents.get(host.runtimeId);
    pendingRuntimeEvents.delete(host.runtimeId);
    if (pending?.control) applyControlEvent(host, pending.control);
    if (pending?.lost) markTerminalTransportLost(host);
  }
  // A saved row remains visible until persistence completes. Its metadata must
  // not change underneath an outstanding edit/removal. `keepsConnection`: die
  // Verbindung darf derweil weiterlaufen und auch neu aufgebaut werden -- bei
  // jedem Bearbeiten, denn "Save" speichert zuerst und trennt erst nach dem
  // Erfolg (UX-Spec §7.7, Aufgabe 18); ein Versuch des
  // Neuverbindens (§5.4) endete sonst als `superseded`. Nur das Entfernen
  // haelt Verbindungen an.
  const hostChangesInFlight = new Map<string, { keepsConnection: boolean }>();
  interface ControlRepairAttempt {
    connection: SessionConnection;
    startedGeneration: number;
    generation?: number;
    cancelled: boolean;
  }
  const controlRepairs = new Map<string, ControlRepairAttempt>();

  /** Was ein Reparaturaufruf fuer die Selbstreparatur bedeutet: `started`, wenn
   * er das Backend erreicht hat (nur dann zaehlt er als Versuch), und der
   * Fehlercode einer Ablehnung -- daran bricht die Reihe bei einem
   * Hostschluesselfehler ab, auch wenn dessen Ereignis zuerst kam. */
  interface RepairOutcome {
    started: boolean;
    failure: string | null;
  }

  async function onRepairControl(hostId: string, auth: AuthChoice): Promise<RepairOutcome> {
    const connection = sessionConnection(hostId);
    const previous = state.controlForHost(hostId);
    if (!connection || controlRepairs.has(hostId) ||
      (previous.state !== "degraded" && previous.state !== "authentication_required")) {
      return { started: false, failure: null };
    }
    const attempt: ControlRepairAttempt = { connection, startedGeneration: previous.generation, cancelled: false };
    controlRepairs.set(hostId, attempt);
    // A local pending state enables Cancel before begin's answer, without
    // inventing or advancing a backend control generation.
    state.setControlState(hostId, { ...previous, state: "reconnecting", message: null });
    try {
      const generation = await invoke<number>("begin_control_repair", { hostId: connection.runtimeId });
      attempt.generation = generation;
      if (attempt.cancelled || !isCurrentConnection(connection) || controlRepairs.get(hostId) !== attempt ||
        state.controlForHost(hostId).generation > generation) {
        void invoke("cancel_control_repair", { hostId: connection.runtimeId, controlGeneration: generation }).catch(() => {});
        return { started: true, failure: null };
      }
      state.setControlState(hostId, { generation, state: "reconnecting", message: null });
      await invoke("repair_control", {
        hostId: connection.runtimeId, controlGeneration: generation,
        auth: {
          key_path: auth.kind === "key" ? auth.path : null,
          passphrase: auth.kind === "key" ? auth.passphrase || null : null,
          password: auth.kind === "password" ? auth.password : null,
        },
      });
      // Only the generation-bound ready event confirms control recovery.
      return { started: true, failure: null };
    } catch (error) {
      if (attempt.generation !== undefined) {
        void invoke("cancel_control_repair", { hostId: connection.runtimeId, controlGeneration: attempt.generation }).catch(() => {});
      }
      const dto = error as { code?: string; message?: string } | null;
      const failure = typeof dto?.code === "string" ? dto.code : null;
      const current = state.controlForHost(hostId);
      if (attempt.cancelled || !isCurrentConnection(connection) || controlRepairs.get(hostId) !== attempt ||
        current.generation !== (attempt.generation ?? previous.generation) || current.state === "ready") {
        return { started: true, failure };
      }
      state.setControlState(hostId, {
        generation: current.generation,
        state: failure === "passphrase_required" || failure === "password_required" || failure === "auth_rejected"
          ? "authentication_required" : "degraded",
        message: dto?.message ?? String(error),
      });
      return { started: true, failure };
    } finally {
      if (controlRepairs.get(hostId) === attempt) controlRepairs.delete(hostId);
    }
  }

  function onCancelControlRepair(hostId: string): void {
    const attempt = controlRepairs.get(hostId);
    if (!attempt) return;
    attempt.cancelled = true;
    controlRepairs.delete(hostId);
    if (attempt.generation !== undefined) {
      void invoke("cancel_control_repair", { hostId: attempt.connection.runtimeId, controlGeneration: attempt.generation }).catch(() => {});
    }
    const current = state.controlForHost(hostId);
    if (isCurrentConnection(attempt.connection) &&
      current.generation === (attempt.generation ?? attempt.startedGeneration) && current.state === "reconnecting") {
      state.setControlState(hostId, { ...current, state: "degraded", message: t("control.cancelled") });
    }
  }

  // --- Selbstreparatur der Steuerung (UX-Spec §5.3) ----------------------
  //
  // Hosts mit Schluessel oder ssh-agent reparieren eine abgebrochene
  // Steuerverbindung selbst, solange ihre Terminalverbindung lebt: Versuche
  // nach 2, 5, 15, 30 und 60 s (je +-20 %), hoechstens fuenf je Ausfall, ueber
  // denselben Weg wie "Restore updates", aber ohne Geheimnis. Die Reihe endet
  // mit `ready` (der Ausfall ist vorbei), mit `authentication_required` (das
  // Formular erscheint), nach dem fuenften Fehlschlag (der Kasten erscheint)
  // und wenn die Verbindung endet. Bis `ready` beginnt kein neuer Ausfall:
  // weitere `degraded` desselben Ausfalls starten keine zweite Reihe.
  interface SelfRepair {
    connection: SessionConnection;
    /** Versuche dieses Ausfalls, die das Backend erreicht haben. */
    attempts: number;
    /** waiting: Zeitgeber laeuft; running: Versuch unterwegs; settling: der
     * Versuch ist zurueck, sein Ergebnis kommt noch als Ereignis; stopped:
     * Reihe zu Ende, Kasten oder Formular stehen bis `ready`. */
    phase: "waiting" | "running" | "settling" | "stopped";
    /** Wartezeit bis zum naechsten Versuch bzw. Frist fuer "settling". */
    timer: ReturnType<typeof setTimeout> | null;
  }
  const selfRepairs = new Map<string, SelfRepair>();
  /** Bleibt nach einem Versuch das entscheidende Ereignis aus, gilt er nach
   * dieser Frist als gescheitert. Der Aufruf ist dann schon zurueck, und sein
   * Ereignis kommt sonst im selben Augenblick. */
  const SELF_REPAIR_SETTLE_MS = 20_000;

  function selfRepairAuth(host: Host): AuthChoice {
    // Dieselbe Wahl wie das Formular, ohne Passphrase und ohne Passwort.
    return host.authKind === "key" && host.keyPath
      ? { kind: "key", path: host.keyPath, passphrase: "" }
      : { kind: "agent" };
  }

  /** Folgt dem gerade angewandten Steuerzustand eines Ereignisses. */
  function followControlForSelfRepair(host: Host): void {
    const stale = selfRepairs.get(host.id);
    if (stale && !isCurrentConnection(stale.connection)) cancelSelfRepair(host.id);
    const repair = selfRepairs.get(host.id);
    const control = state.controlForHost(host.id).state;
    if (control === "ready") finishSelfRepair(host.id);
    else if (!repair) {
      if (control === "degraded") startSelfRepair(host);
    } else if (control === "authentication_required" && repair.phase !== "stopped") {
      stopSelfRepair(host.id, repair, true);
    } else if (repair.phase === "settling") {
      settleSelfRepair(host.id, repair);
    }
  }

  function startSelfRepair(host: Host): void {
    const connection = sessionConnection(host.id);
    if (!connection || (host.authKind !== "agent" && host.authKind !== "key")) return;
    const repair: SelfRepair = { connection, attempts: 0, phase: "waiting", timer: null };
    selfRepairs.set(host.id, repair);
    state.setControlSelfRepairing(host.id, true);
    scheduleSelfRepair(host.id, repair);
  }

  function clearSelfRepairTimer(repair: SelfRepair): void {
    if (repair.timer !== null) clearTimeout(repair.timer);
    repair.timer = null;
  }

  /** Wartet auf den naechsten Versuch, oder beendet die Reihe nach dem fuenften. */
  function scheduleSelfRepair(hostId: string, repair: SelfRepair): void {
    clearSelfRepairTimer(repair);
    const delay = retryDelay(repair.attempts);
    if (delay === null) {
      stopSelfRepair(hostId, repair, false);
      return;
    }
    repair.phase = "waiting";
    if (!backgroundStopped) repair.timer = setTimeout(() => void runSelfRepair(hostId, repair), delay);
  }

  async function runSelfRepair(hostId: string, repair: SelfRepair): Promise<void> {
    if (backgroundStopped || selfRepairs.get(hostId) !== repair || repair.phase !== "waiting") return;
    clearSelfRepairTimer(repair);
    if (!isCurrentConnection(repair.connection)) {
      cancelSelfRepair(hostId);
      return;
    }
    repair.phase = "running";
    const outcome = await onRepairControl(hostId, selfRepairAuth(repair.connection.host));
    if (selfRepairs.get(hostId) !== repair || repair.phase !== "running") return;
    // Nur ein Versuch, der das Backend erreicht hat, verbraucht einen der fuenf.
    if (outcome.started) repair.attempts += 1;
    // Nie weiter bei einem Hostschluesselfehler (Plan, Review Focus 2): das
    // Backend meldet ihn als degraded, er darf aber keinen Versuch mehr ausloesen.
    if (outcome.failure === "host_key_rejected") stopSelfRepair(hostId, repair, false);
    else settleSelfRepair(hostId, repair);
  }

  /** Wertet den Steuerzustand nach einem Versuch aus. */
  function settleSelfRepair(hostId: string, repair: SelfRepair): void {
    const control = state.controlForHost(hostId).state;
    if (control === "ready") finishSelfRepair(hostId);
    else if (control === "authentication_required") stopSelfRepair(hostId, repair, true);
    else if (control === "degraded") scheduleSelfRepair(hostId, repair);
    else {
      // reconnecting: der Aufruf kam vor seinem Ereignis zurueck, oder eine
      // andere Reparatur laeuft noch. Das naechste Ereignis entscheidet; bleibt
      // es aus, gilt der Versuch nach der Frist als gescheitert.
      clearSelfRepairTimer(repair);
      repair.phase = "settling";
      if (!backgroundStopped) repair.timer = setTimeout(() => giveUpSettling(hostId, repair), SELF_REPAIR_SETTLE_MS);
    }
  }

  /** Das entscheidende Ereignis blieb aus: der Versuch gilt als gescheitert.
   * Ein stehengebliebenes `reconnecting` wird beendet, sonst koennte der
   * naechste Versuch nicht beginnen, zaehlte nicht, und die Reihe kaeme nie
   * zu ihrem Ende. */
  function giveUpSettling(hostId: string, repair: SelfRepair): void {
    if (backgroundStopped || selfRepairs.get(hostId) !== repair || repair.phase !== "settling") return;
    repair.timer = null;
    if (!isCurrentConnection(repair.connection)) {
      cancelSelfRepair(hostId);
      return;
    }
    // Eine noch laufende Reparatur gibt ihren Besitz frei (ohne Besitzer folgenlos).
    onCancelControlRepair(hostId);
    const control = state.controlForHost(hostId);
    if (control.state === "reconnecting") {
      void invoke("cancel_control_repair", { hostId: repair.connection.runtimeId, controlGeneration: control.generation })
        .catch(() => {});
      state.setControlState(hostId, { ...control, state: "degraded", message: null });
    }
    scheduleSelfRepair(hostId, repair);
  }

  /** Ende der Reihe innerhalb des Ausfalls; der Eintrag bleibt bis `ready`,
   * damit derselbe Ausfall keine neue Reihe beginnt. */
  function stopSelfRepair(hostId: string, repair: SelfRepair, showForm: boolean): void {
    clearSelfRepairTimer(repair);
    repair.phase = "stopped";
    state.setControlSelfRepairing(hostId, false);
    // Ohne Fokuswechsel: das Ereignis kommt im Hintergrund, der Nutzer tippt
    // womoeglich gerade im Terminal.
    if (showForm) sidebarHandle.openControlRepair(hostId);
  }

  /** Der Ausfall ist vorbei. */
  function finishSelfRepair(hostId: string): void {
    cancelSelfRepair(hostId);
    state.setControlSelfRepairing(hostId, false);
  }

  /** Raeumt Zeitgeber und Eintrag. Endet die Verbindung, nimmt AppState die
   * Anzeige selbst zurueck (`setRuntimeId`, `setHostState`, `removeHost`). */
  function cancelSelfRepair(hostId: string): void {
    const repair = selfRepairs.get(hostId);
    if (!repair) return;
    clearSelfRepairTimer(repair);
    selfRepairs.delete(hostId);
  }

  // --- Neuverbinden nach Verlust der Terminalverbindung (UX-Spec §5.4) ----
  //
  // Den Zeitplan fuehrt `state/reconnect.ts`. Hier steht, welcher Host neu
  // verbunden wird (Schluessel oder ssh-agent, und die letzte Verbindung in
  // diesem Lauf brauchte kein Geheimnis) und was ein Versuch ist: derselbe
  // volle Aufbau wie "Retry", ohne Geheimnis. Verbinden von Hand, Trennen und
  // Entfernen beenden die Reihe (`onConnectHost`, `onDisconnectHost`). Die
  // Selbstreparatur der Steuerung kommt ihr nicht in die Quere: die ist beim
  // Transportverlust schon abgebrochen (`markTerminalTransportLost`) und
  // beginnt erst wieder auf einer lebenden Verbindung.
  const hostReconnects = createHostReconnector({
    attempt: (hostId) => connectHost(hostId),
    onActiveChange: (hostId, active) => state.setHostReconnecting(hostId, active),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  /** Hosts, deren letzte erfolgreiche Verbindung in diesem Lauf eine
   * Passphrase oder ein Passwort brauchte. Sie bleiben von Hand (§5.4). */
  const hostsConnectedWithSecret = new Set<string>();
  /** "hostname:port" jeder Hostschluesselfrage, die abgelaufen ist
   * (`mountHostKeyPrompt`s `onExpired`). Scheitert danach ein Aufbau von
   * `connectHost` an diesem Ziel mit `connect_timeout`, war es die Frage: ihr
   * Satz steht dann im Hinweis der Seitenleiste, der kein Alert ist, und wird
   * deshalb einmal angesagt. Erststart und "Add host" verbinden nicht hier --
   * ihre Alert-Zeile sagt ihn selbst an. */
  const expiredHostKeyPrompts = new Set<string>();

  function reconnectsByItself(host: Host): boolean {
    return (host.authKind === "agent" || host.authKind === "key") && !hostsConnectedWithSecret.has(host.id);
  }

  function onWindowFocus(): void {
    void getCurrentWindow()
      .requestUserAttention(null)
      .catch(() => {});
    // §5.3: bekommt das Fenster den Fokus, startet ein wartender Versuch sofort.
    for (const [hostId, repair] of selfRepairs) {
      if (repair.phase === "waiting") void runSelfRepair(hostId, repair);
    }
    // §5.4: ebenso ein wartender Versuch des Neuverbindens.
    hostReconnects.wake();
  }

  /** §5.4: das Ereignis `online` zieht einen wartenden Versuch vor. */
  function onOnline(): void {
    hostReconnects.wake();
  }

  function bumpConnectGeneration(hostId: string): number {
    const next = (connectGenerationByHostId.get(hostId) ?? 0) + 1;
    connectGenerationByHostId.set(hostId, next);
    return next;
  }

  function ensureGridMounted(): void {
    firstRunInGridHandle?.dispose();
    firstRunInGridHandle = null;
    if (!gridHandle) {
      gridHandle = mountGrid(elements.grid, state, {
        onTerminalError: (text, detail) => showGlobalError(text, detail),
        onCloseTerminal: closeSessionTile,
        onReconnectHost: (hostId) => void reconnectHostFromTile(hostId),
        // Nachtrag B, Punkt 2, UX-Spec §7.9: dieselbe Zielhost-Kette wie
        // Strg+Umschalt+N; mit Host landet sie im selben Dialog wie die
        // Seitenleiste (`onNewSession`, inklusive dessen "nicht
        // verbunden"-Meldung).
        onNewSession: newSessionOnTargetHost,
        onConnectionLost: onTerminalConnectionLost,
        // Ohne Probe, anders als bei `onConnectionLost`: dass EIN
        // `open_terminal` abgelehnt wurde, sagt ueber den Host nichts --
        // der haeufigste Grund ist "diese tmux-Session gibt es nicht mehr",
        // und der Host antwortet dabei tadellos. Eine Probe wuerde eine
        // Sessionliste holen, die alles bestaetigt, und nichts aendern.
        onTerminalOpenFailed: (hostId, name, socket) => state.lockInput(hostId, name, socket),
        onTerminalCapacity: (hostId, name, detail, socket) => {
          // Spec 2026-10-19 §8.3: die Kachel bekam nie einen Kanal. Sie geht,
          // statt als "Disconnected" stehen zu bleiben; ein neuer Klick auf die
          // Session versucht es wieder. Der Rohtext steht hinter "Copy details".
          closeSessionTile(hostId, name, socket);
          const host = state.hosts.find((candidate) => candidate.id === hostId);
          showGlobalError(t("terminal.capacity", { host: host?.label ?? hostId }), detail);
        },
      });
    }
  }

  /** Spec §11.2: "Kein Host angelegt -> Erststart ... im Rasterbereich,
   * damit die Seitenleiste sichtbar bleibt" -- NICHT `mountGrid` UND
   * `mountFirstRun` gleichzeitig in `elements.grid`, `mountGrid` wird schlicht
   * noch gar nicht gemountet (siehe `gridHandle`s Kommentar oben: mit null
   * Hosts gibt es ohnehin nichts, dessen Kachelzuordnung ein Dispose
   * gefaehrden koennte). */
  function showFirstRunInGrid(): void {
    firstRunInGridHandle = mountFirstRun(elements.grid, {
      beforeConnect: () => connectionListenersReady,
      onRuntimeOwnershipChange: trackRuntimeOwnership,
      onHostReady: handleHostReady,
    });
  }

  function showHostsLoadError(message: string): void {
    // Eine unlesbare `settings.toml` (z. B. aus einer neueren Version, siehe
    // `settings::parse_settings`) darf nicht stillschweigend als "keine
    // Hosts" (Erststart) durchgehen -- das wuerde dem Nutzer einen frischen
    // Zustand vortaeuschen, obwohl seine bestehenden Hosts in Wirklichkeit
    // nur unlesbar sind. Sichtbar machen statt verschlucken.
    //
    // Der Satz kommt ganz vom Backend (`could not load <pfad>: <grund>`, Spec
    // §9.2 verlangt Pfad und Ursachenkette) und steht hier ohne einen zweiten
    // Satz davor oder dahinter: fuer eine Datei aus einer neueren Version sagt
    // er selbst, was zu tun ist, und "Datei reparieren oder verschieben"
    // waere dort falsch.
    elements.grid.replaceChildren();
    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = message;
    elements.grid.appendChild(notice);
  }

  /** Ein Host ist frisch verbunden UND dauerhaft gespeichert (aus dem
   * Erststart im Rasterbereich ODER aus der Seitenleisten-"+ Add
   * host"-Ueberlagerung, siehe `onAddHost` unten -- beide rufen
   * `mountFirstRun`, derselbe getestete Weg, keine zweite Kopie der
   * Verbinden/Preflight/Speichern-Logik). `entry.id` ist die
   * SETTINGS.TOML-ID, `runtimeId` die LAUFZEIT-ID (siehe Kopfkommentar) --
   * `hostFromEntry` setzt bereits die erste, die zweite kommt daneben. */
  function handleHostReady(runtimeId: string, entry: HostEntry, usedSecret: boolean): void {
    const host = hostFromEntry(entry);
    host.runtimeId = runtimeId;
    host.state = "connected";
    // Vor den fruehen Ereignissen unten: ein Transportverlust gleich nach dem
    // Speichern fragt schon, ob der Host selbst neu verbunden wird (§5.4).
    if (usedSecret) hostsConnectedWithSecret.add(entry.id);
    else hostsConnectedWithSecret.delete(entry.id);
    state.upsertHost(host);
    // UX-Spec §7.1: auch dies ist eine gelungene Verbindung von Hand.
    workspaceSync.hostConnected(entry.id);
    applyPendingRuntimeEvents(host);
    ensureGridMounted();
    closeDialog();
    void refreshSessions(entry.id);
    scheduleStatusPoll(entry.id);
  }

  /** List errors describe inventory freshness, never terminal transport health. */
  type SessionRefresh = { ok: true } | { ok: false; error: string };

  function sessionListError(error: unknown): SessionListError {
    const dto = error as Partial<SessionListErrorDto> | null;
    return {
      message: typeof dto?.message === "string" ? dto.message : String(error),
      ...(typeof dto?.code === "string" ? { code: dto.code } : {}),
      ...(typeof dto?.control_generation === "number" && Number.isSafeInteger(dto.control_generation)
        ? { controlGeneration: dto.control_generation } : {}),
    };
  }

  /** Refreshes duerfen weder einen neueren Listenstand noch eine gerade
   * laufende Create/Kill-Folge ueberschreiben. Die Revision steigt bei
   * Mutationsbeginn und bei jedem Schreiben der Sessionliste. */
  const sessionListVersionByHostId = new Map<string, number>();
  // Erfolgreiche Snapshots sind zugleich ein Lebenszeichen. Ein davor
  // gestarteter Probe-Fehler darf dieses juengere Lebenszeichen nicht ersetzen.
  const successfulSessionLists = new WeakMap<Host, number>();

  function recordSessionListSuccess(host: Host): void {
    successfulSessionLists.set(host, (successfulSessionLists.get(host) ?? 0) + 1);
  }

  interface SessionConnection {
    host: Host;
    runtimeId: string;
    generation: number;
  }

  function sessionConnection(hostId: string): SessionConnection | null {
    const host = state.hosts.find((candidate) => candidate.id === hostId);
    if (!host || host.state !== "connected" || !host.runtimeId) return null;
    return { host, runtimeId: host.runtimeId, generation: connectGenerationByHostId.get(hostId) ?? 0 };
  }

  // Jede Antwort gehoert zur Verbindung, auf der sie angefordert wurde.
  // Auch Fehler einer entfernten oder neu verbundenen Hostzeile sind veraltet.
  function isCurrentConnection(connection: SessionConnection): boolean {
    const { host, runtimeId, generation } = connection;
    return (
      state.hosts.includes(host) &&
      host.state === "connected" &&
      host.runtimeId === runtimeId &&
      (connectGenerationByHostId.get(host.id) ?? 0) === generation
    );
  }

  const sessionMutations = new Map<string, { connection: SessionConnection; tail: Promise<void> }>();
  const overlayStatusInFlight = new Set<string>();

  /** Create/Kill samt anschliessender Liste bilden je Verbindung eine Folge.
   * So kann die Liste einer frueheren Mutation keine spaeter angelegte Kachel
   * entfernen. Ein Verbindungswechsel wartet nicht auf die alte Folge. */
  function mutateSessions(connection: SessionConnection, operation: () => Promise<void>): Promise<void> {
    const hostId = connection.host.id;
    const controlGeneration = state.controlForHost(hostId).generation;
    sessionListVersionByHostId.set(hostId, (sessionListVersionByHostId.get(hostId) ?? 0) + 1);
    const previous = sessionMutations.get(hostId);
    const ready = previous && isCurrentConnection(previous.connection) ? previous.tail : Promise.resolve();
    const tail = ready.then(async () => {
      if (isCurrentConnection(connection)) await operation();
    }).finally(() => {
      if (sessionMutations.get(hostId)?.tail !== tail) return;
      sessionMutations.delete(hostId);
      // A repaired control's ready refresh may have completed while this older
      // mutation still owned the inventory. Reconcile once after releasing it.
      const control = state.controlForHost(hostId);
      if (isCurrentConnection(connection) && control.generation !== controlGeneration &&
        control.state === "ready" && state.sessionListForHost(hostId).status !== "current") {
        void refreshSessions(hostId);
      }
    });
    sessionMutations.set(hostId, { connection, tail });
    return tail;
  }

  /** Kontrollgeneration, unter der die Sessionliste der aktuellen Verbindung
   * zuletzt geschrieben wurde. Eine frische Verbindung beginnt bei 0, wie das
   * Backend. Neu geladen wird nur bei einer anderen Generation (UX-Spec §5.2). */
  const listedGenerations = new Map<string, { runtimeId: string | null; generation: number }>();

  function listedGeneration(host: Host): number {
    const listed = listedGenerations.get(host.id);
    return listed && listed.runtimeId === host.runtimeId ? listed.generation : 0;
  }

  /** Membership, numeric identity and status in ONE state write: attention
   * and a tile that mounts on this notification must already see the ids and
   * the status, not the name-only intermediate state. */
  function writeSessionRecords(hostId: string, listed: SessionListDto): void {
    const host = state.hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    // Jeder Aufrufer schreibt nur unter der Generation, unter der er fragte.
    listedGenerations.set(hostId, { runtimeId: host.runtimeId, generation: state.controlForHost(hostId).generation });
    sessionListVersionByHostId.set(hostId, (sessionListVersionByHostId.get(hostId) ?? 0) + 1);
    state.setSessionRecords(hostId, sessionRecords(listed.own.sessions), Date.now());
    writeDefaultSessions(hostId, listed.default);
    // Jede angenommene Liste landet hier, gleich auf welchem Weg. Erst jetzt
    // gibt es die Sessions: die gespeicherten Kacheln dieses Hosts belegen ihre
    // Plaetze (UX-Spec §7.2), und eine per Klick gewuenschte Session oeffnet
    // (§7.3). Die Reihenfolge ist Absicht: gespeicherte Kacheln tragen ihren
    // Platz, die Wahl des Nutzers nimmt danach den naechsten freien.
    workspaceSync.hostListed(hostId);
    openSessionAfterConnect(hostId);
  }

  function sessionRecords(items: SessionListItemDto[]): Parameters<AppState["setSessionRecords"]>[1] {
    return items.map((item) => ({
      name: item.display_name,
      sessionId: item.session_id,
      serverPid: item.server_pid,
      serverStartTime: item.server_start_time,
      windowId: item.window_id,
      paneId: item.pane_id,
      panePid: item.pane_pid,
      status: item.status,
      statusReason: item.status_reason,
    }));
  }

  /** Die Liste des Standard-Sockets (Spec 2026-10-25 §6.2, §7): ihr Fehler
   * gilt nur fuer sie; ist der Schalter aus, hat der Host dort keine Sessions.
   * Ohne Teil trotz Verlangen (die Antwortform vor dem Standard-Socket) bleibt
   * sein Stand, wie er war. Eine Serverversion ohne Messung ergibt eine leere
   * Gruppe. */
  function writeDefaultSessions(hostId: string, listed: SocketSessionsDto | null): void {
    if (listed === null) {
      if (!showsDefaultSocket(hostId)) state.setSessionRecords(hostId, [], Date.now(), "default");
      return;
    }
    if (listed.error) {
      state.setSessionListError(hostId, sessionListError(listed.error), "default");
      return;
    }
    state.setSessionRecords(hostId, sessionRecords(listed.sessions), Date.now(), "default");
  }

  function asSessionItems(items: Array<SessionListItemDto | string>): SessionListItemDto[] {
    return items.map((item) =>
      typeof item === "string"
        ? {
            display_name: item,
            session_id: null,
            server_pid: null,
            server_start_time: null,
            window_id: null,
            pane_id: null,
            pane_pid: null,
            unverified: null,
            status: "unknown",
            status_reason: null,
          }
        : {
            display_name: item.display_name,
            session_id: item.session_id ?? null,
            server_pid: item.server_pid ?? null,
            server_start_time: item.server_start_time ?? null,
            window_id: item.window_id ?? null,
            pane_id: item.pane_id ?? null,
            pane_pid: item.pane_pid ?? null,
            unverified: item.unverified ?? null,
            status: item.status ?? "unknown",
            status_reason: item.status_reason ?? null,
          },
    );
  }

  /** Die Antwort von `list_sessions` je Socket (Spec 2026-10-25 §6.2). Ein
   * blosses Array, die Form vor dem Standard-Socket, ist die Liste des
   * eigenen Sockets allein. */
  function asSessionList(value: unknown): SessionListDto {
    const socket = (part: Partial<SocketSessionsDto>): SocketSessionsDto => ({
      sessions: asSessionItems(part.sessions ?? []),
      error: part.error ?? null,
      unsupported_version: part.unsupported_version ?? null,
    });
    if (Array.isArray(value)) return { own: socket({ sessions: value }), default: null };
    const dto = (value ?? {}) as Partial<SessionListDto>;
    return { own: socket(dto.own ?? {}), default: dto.default ? socket(dto.default) : null };
  }

  /** Die Antwort von `poll_status` je Socket (Spec 2026-10-25 §6.3). Ein
   * einzelnes Ergebnis, die Form vor dem Standard-Socket, ist das des eigenen. */
  function asStatusPolls(value: unknown): StatusPollsDto {
    const dto = (value ?? {}) as Partial<StatusPollsDto> & Partial<StatusPollDto>;
    if (typeof dto.complete === "boolean") return { own: { poll: value as StatusPollDto, error: null }, default: null };
    return { own: dto.own ?? { poll: null, error: null }, default: dto.default ?? null };
  }

  /** Schalter "Show tmux sessions" (Spec 2026-10-25 §10.1): ist er aus, liest
   * die App den Standard-Socket dieses Hosts gar nicht. Fehlt er, gilt an. */
  function showsDefaultSocket(hostId: string): boolean {
    return state.hosts.find((host) => host.id === hostId)?.showDefaultSocket !== false;
  }

  function includeDefaultArg(hostId: string): { includeDefault?: true } {
    return showsDefaultSocket(hostId) ? { includeDefault: true } : {};
  }

  /** Status overlay only, via the slim poll_status query; membership of
   * the sidebar list stays with writeSessionRecords (connect/create/kill/reload).
   * Je Socket (Spec 2026-10-25 §6.3): ein Ausfall des Standard-Sockets macht
   * nur dessen Sessions veraltet. */
  async function overlaySessionStatus(hostId: string): Promise<void> {
    if (!document.getElementById("app")) return;
    const connection = sessionConnection(hostId);
    if (!connection) return;
    if (overlayStatusInFlight.has(hostId)) return;
    const mutation = sessionMutations.get(hostId);
    if (mutation && isCurrentConnection(mutation.connection)) return;
    overlayStatusInFlight.add(hostId);
    const controlGeneration = state.controlForHost(hostId).generation;
    const version = sessionListVersionByHostId.get(hostId) ?? 0;
    try {
      const polls = asStatusPolls(
        await invoke<unknown>("poll_status", { hostId: connection.runtimeId, ...includeDefaultArg(hostId) }),
      );
      if (!document.getElementById("app")) return;
      if (!isCurrentConnection(connection) || state.controlForHost(hostId).generation !== controlGeneration) return;
      if ((sessionListVersionByHostId.get(hostId) ?? 0) !== version) return;
      const mutationAfter = sessionMutations.get(hostId);
      if (mutationAfter && isCurrentConnection(mutationAfter.connection)) return;
      applyStatusPoll(hostId, polls.own, "app");
      if (polls.default) {
        applyStatusPoll(hostId, polls.default, "default");
        const poll = polls.default.poll;
        if (poll?.complete) reloadDefaultListOnNews(hostId, poll);
      }
    } catch {
      // A failed poll must not rewrite the list or invent ended. It does make
      // the shown values history until a later query succeeds (spec 4.6).
      if (isCurrentConnection(connection)) {
        state.markStatusStale(hostId);
        state.markStatusStale(hostId, "default");
      }
    } finally {
      overlayStatusInFlight.delete(hostId);
    }
  }

  function applyStatusPoll(hostId: string, result: SocketPollDto, socket: SessionSocket): void {
    const poll = result.poll;
    if (!poll?.complete) {
      // A failed socket, or an unmeasured tmux version that answers without
      // numeric rows: nothing is observed, so shown live values become
      // history, not guesses.
      state.markStatusStale(hostId, socket);
      return;
    }
    state.patchSessionStatus(
      hostId,
      poll.sessions.map((row) => ({
        // Numeric rows never bind by name (patchSessionStatus).
        name: "",
        sessionId: row.session_id,
        serverPid: poll.server_pid,
        serverStartTime: poll.server_start_time,
        status: row.status,
        statusReason: row.status_reason,
      })),
      Date.now(),
      // UX-Spec §5.2: fiel eine Quelle aus, ueberschreibt ihr "unknown"
      // keinen Live-Wert; der alte Wert bleibt, als veraltet markiert.
      { keepUnknown: !poll.agents_ok || !poll.titles_ok, ...(socket === "default" ? { socket } : {}) },
    );
  }

  /** Spec 2026-10-25 §6.3: Sessions des Standard-Sockets entstehen ausserhalb
   * der App. Zeigt seine Abfrage eine unbekannte Session-ID oder einen neuen
   * Server, laedt die App die Liste neu, hoechstens alle 10 s je Host. */
  const DEFAULT_LIST_RELOAD_MS = 10_000;
  const defaultListReloads = new Map<string, number>();

  function reloadDefaultListOnNews(hostId: string, poll: StatusPollDto): void {
    const host = state.hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    const known = host.sessions.filter((session) => socketOf(session) === "default");
    const ids = new Set(known.map((session) => session.sessionId).filter((id) => id != null));
    const server = known.find((session) => session.serverPid != null && session.serverStartTime != null);
    const newServer =
      poll.server_pid !== null &&
      server !== undefined &&
      (server.serverPid !== poll.server_pid || server.serverStartTime !== poll.server_start_time);
    const unknownSession = poll.sessions.some((row) => !ids.has(row.session_id));
    if (!newServer && !unknownSession) return;
    const now = Date.now();
    const last = defaultListReloads.get(hostId);
    if (last !== undefined && now - last < DEFAULT_LIST_RELOAD_MS) return;
    defaultListReloads.set(hostId, now);
    void refreshSessions(hostId);
  }

  // Polltakt je Host (UX-Spec §5.2): der naechste Poll beginnt fruehestens
  // 2 s nach dem Ende des vorigen. Laeuft fuer den Host gerade
  // `list_sessions`, setzt er aus; die Liste wartet nie auf den Poll. Jede
  // Verbindung startet die Kette, ohne Verbindung endet sie von selbst.
  let backgroundStopped = false;
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listsInFlight = new Map<string, number>();

  function scheduleStatusPoll(hostId: string): void {
    if (backgroundStopped || pollTimers.has(hostId)) return;
    pollTimers.set(hostId, setTimeout(() => {
      pollTimers.delete(hostId);
      void runStatusPoll(hostId);
    }, SESSION_STATUS_POLL_MS));
  }

  async function runStatusPoll(hostId: string): Promise<void> {
    if (!sessionConnection(hostId)) return;
    try {
      if (!listsInFlight.has(hostId)) await overlaySessionStatus(hostId);
    } finally {
      if (sessionConnection(hostId)) scheduleStatusPoll(hostId);
    }
  }

  function stopStatusPoll(hostId: string): void {
    const timer = pollTimers.get(hostId);
    if (timer !== undefined) clearTimeout(timer);
    pollTimers.delete(hostId);
  }

  /** `list_sessions` auf der lebenden Verbindung; waehrenddessen pausiert der Poll. */
  async function listSessions(hostId: string, runtimeId: string): Promise<SessionListDto> {
    listsInFlight.set(hostId, (listsInFlight.get(hostId) ?? 0) + 1);
    try {
      const listed = asSessionList(
        await invoke<unknown>("list_sessions", { hostId: runtimeId, ...includeDefaultArg(hostId) }),
      );
      // Ob die Liste gelang, entscheidet der eigene Socket (Spec 2026-10-25
      // §7): sein Fehler nimmt den Weg jedes gescheiterten Aufrufs, und die
      // Liste des Standard-Sockets bleibt dann, wie sie war.
      if (listed.own.error) throw listed.own.error;
      return listed;
    } finally {
      const left = (listsInFlight.get(hostId) ?? 1) - 1;
      if (left > 0) listsInFlight.set(hostId, left);
      else listsInFlight.delete(hostId);
    }
  }

  /** `hostId` ist die SETTINGS-ID -- die Uebersetzung auf die Laufzeit-ID
   * geschieht hier drinnen und nirgends sonst. Diese Funktion benutzt beide
   * Raeume in einem Atemzug: `list_sessions` meint die lebende Verbindung,
   * `writeSessions`/`sessionListVersionByHostId` meinen den gespeicherten
   * Host. Ein einziger Parameter fuer beides waere die eine Stelle, an der
   * ein Aufrufer den falschen Raum liefern KANN -- deshalb nimmt sie den
   * Raum, in dem der Rest des Programms denkt.
   *
   * Ohne lebende Verbindung wird gar nicht erst gefragt: das Backend
   * antwortete auf eine unbekannte ID ohnehin mit "host not connected", der
   * Rueckgabewert ist derselbe. */
  async function refreshSessions(hostId: string): Promise<SessionRefresh> {
    const connection = sessionConnection(hostId);
    if (!connection) return { ok: false, error: "host not connected" };
    const { runtimeId } = connection;
    const version = sessionListVersionByHostId.get(hostId) ?? 0;
    const lastSuccess = successfulSessionLists.get(connection.host) ?? 0;
    const controlGeneration = state.controlForHost(hostId).generation;
    try {
      const listed = await listSessions(hostId, runtimeId);
      if (!isCurrentConnection(connection) || state.controlForHost(hostId).generation !== controlGeneration) return { ok: true };
      // Ein aktueller Erfolg bestaetigt die Verbindung auch dann, wenn eine
      // laufende Mutation oder juengere Liste das Inventarschreiben sperrt.
      recordSessionListSuccess(connection.host);
      // Die Wache gilt AUSSCHLIESSLICH dem Schreiben. Ein ueberholter Refresh
      // bleibt ein GEGLUECKTER Refresh und meldet `{ ok: true }` -- der Host
      // hat geantwortet, und das ist alles, was `probeHost` unten aus diesem
      // Rueckgabewert liest. Ein `{ ok: false }` (oder ein dritter Zustand,
      // den die Probe als Fehlschlag deutete) waere ein NEUER Weg, einen
      // lebenden Host anzuschwaerzen -- genau die Fehlerklasse, gegen die
      // dieses Paket angetreten ist.
      const mutation = sessionMutations.get(hostId);
      if (
        !(mutation && isCurrentConnection(mutation.connection)) &&
        (sessionListVersionByHostId.get(hostId) ?? 0) === version
      ) writeSessionRecords(hostId, listed);
      return { ok: true };
    } catch (error) {
      if (!isCurrentConnection(connection) || state.controlForHost(hostId).generation !== controlGeneration) return { ok: true };
      if ((successfulSessionLists.get(connection.host) ?? 0) !== lastSuccess) return { ok: true };
      if ((sessionListVersionByHostId.get(hostId) ?? 0) !== version) return { ok: true };
      const mutation = sessionMutations.get(hostId);
      if (mutation && isCurrentConnection(mutation.connection)) return { ok: true };
      const failure = sessionListError(error);
      if (failure.controlGeneration !== undefined && failure.controlGeneration !== controlGeneration) return { ok: true };
      state.setSessionListError(hostId, failure);
      return { ok: false, error: failure.message };
    }
  }

  // Eine Probe pro lebender Verbindung. Ein haengender Aufruf der alten
  // Verbindung darf die erste Probe nach Reconnect nicht unterdruecken.
  const hostProbesInFlight = new Map<string, SessionConnection>();

  // A lost PTY and a failed control query do not prove terminal transport loss.
  // Keep the affected tile locked; the probe only updates the inventory notice.
  // UX-Spec §5.5: a tile that reattaches quietly shows "Reconnecting…" and
  // stays unlocked; the grid reports a failed series via onTerminalOpenFailed.
  function onTerminalConnectionLost(
    hostId: string,
    name: string,
    reattaching: boolean,
    socket: SessionSocket = "app",
  ): void {
    if (!reattaching) state.lockInput(hostId, name, socket);
    void probeHost(hostId);
  }

  async function probeHost(hostId: string): Promise<void> {
    const connection = sessionConnection(hostId);
    if (!connection) return;
    const inFlight = hostProbesInFlight.get(hostId);
    if (inFlight && isCurrentConnection(inFlight)) return;
    hostProbesInFlight.set(hostId, connection);
    try {
      await refreshSessions(hostId);
    } finally {
      // Ein spaeter Abschluss darf nur SEINE Probe entfernen, niemals die
      // inzwischen laufende Probe einer neueren Verbindung.
      if (hostProbesInFlight.get(hostId) === connection) hostProbesInFlight.delete(hostId);
    }
  }

  function closeSessionTile(hostId: string, name: string, socket: SessionSocket = "app"): void {
    const tile = state.tileForSession(sessionKey(hostId, name, socket));
    if (tile) state.closeTile(tile.id);
  }

  /** Beendet die tmux-Session auf dem Host. Die Rueckfrage liegt in der
   * Seitenleiste; wer hier ankommt, hat bestaetigt.
   *
   * Die Kachel wird ZUERST geraeumt, aus demselben Grund, aus dem das
   * Backend seinen Terminaleintrag vor dem `kill-session` entfernt: sonst
   * stuende die Kachel einen Wimpernschlag lang an einer Sitzung, die es
   * nicht mehr gibt.
   *
   * Danach die Liste neu holen -- die beendete Session verschwindet dadurch
   * aus der Seitenleiste. Bewusst ueber `writeSessions` mit erhoehter
   * Frischewache, wie in `createSession`: dieses Schreiben ist per Bauart
   * das juengste. */
  async function killSession(hostId: string, name: string, socket: SessionSocket = "app"): Promise<void> {
    // Spec 2026-10-25 §3: Sessions des Standard-Sockets beendet die App nie;
    // die Seitenleiste bietet es dort nicht an, und das Backend lehnt ab.
    if (socket === "default") return;
    const connection = sessionConnection(hostId);
    if (!connection) {
      const label = state.hosts.find((h) => h.id === hostId)?.label ?? hostId;
      showGlobalError(t("session.hostNotConnected", { host: label }));
      return;
    }
    const { runtimeId } = connection;
    await mutateSessions(connection, async () => {
      closeSessionTile(hostId, name);
      // ZWEI getrennte `try`, nicht eines um beide Aufrufe: sonst meldete ein
      // Netzruckler beim blossen Nachladen der Liste "Could not end the
      // session" -- ueber eine Sitzung, die sehr wohl beendet wurde. Der
      // Nutzer suchte dann nach einem Problem, das es nicht gibt.
      try {
        const row = state.hosts
          .find((h) => h.id === hostId)
          ?.sessions.find((s) => s.name === name && socketOf(s) === "app");
        await invoke("kill_session", {
          hostId: runtimeId,
          session: name,
          sessionId: row?.sessionId ?? null,
          serverPid: row?.serverPid ?? null,
          serverStartTime: row?.serverStartTime ?? null,
        });
      } catch (error) {
        if (!isCurrentConnection(connection)) return;
        // Die Kachel ist an dieser Stelle schon zu, und das bleibt sie: das
        // Backend hat seinen Terminaleintrag entfernt und den Kanal
        // geschlossen, BEVOR es das `kill-session` abgesetzt hat (siehe
        // `kill_session_impl`). Ein stehengelassenes Terminal waere ein totes.
        // Ob die Session noch laeuft, weiss nur das Backend -- der Ausgang kann
        // sogar unbekannt sein (`outcome_unknown`). Die Meldung behauptet es
        // deshalb nicht selbst, sondern nennt die Session und den Satz des
        // Backends, der Grund und naechsten Schritt traegt.
        showGlobalError(t("session.killFailed", { name, message: String(error) }), String(error));
        return;
      }
      if (!isCurrentConnection(connection)) return;
      const controlGeneration = state.controlForHost(hostId).generation;
      const lastSuccess = successfulSessionLists.get(connection.host) ?? 0;
      try {
        const listed = await listSessions(hostId, runtimeId);
        if (isCurrentConnection(connection) && state.controlForHost(hostId).generation === controlGeneration) {
          recordSessionListSuccess(connection.host);
          writeSessionRecords(hostId, listed);
        }
      } catch (error) {
        if (!isCurrentConnection(connection) || state.controlForHost(hostId).generation !== controlGeneration ||
          (successfulSessionLists.get(connection.host) ?? 0) !== lastSuccess) return;
        const failure = sessionListError(error);
        if (failure.controlGeneration !== undefined && failure.controlGeneration !== controlGeneration) return;
        state.setSessionListError(hostId, failure);
        showGlobalError(t("session.killedListStale", { name }), failure.message);
      }
    });
  }

  /** Verbinden von Hand: "Connect" und "Retry" der Seitenleiste, "Reconnect"
   * der Kachel, der Klick auf eine Session eines getrennten Hosts (§7.3) --
   * und derselbe Weg fuer die Hosts, die der Start verbindet (§7.2). Eine
   * laufende Reihe des Neuverbindens endet damit (UX-Spec §5.4): der Nutzer hat
   * uebernommen. Laeuft gerade einer ihrer Versuche, kommt kein zweiter dazu
   * (`connectHost` kehrt bei "connecting" um) -- der laufende gilt dann als
   * dieser, und sein Fehlschlag steht mit "Retry" da, ohne dass die Reihe
   * weiterlaeuft. */
  async function onConnectHost(
    hostId: string,
    secret?: { passphrase?: string; password?: string },
  ): Promise<ReconnectAttemptResult> {
    hostReconnects.stop(hostId);
    return connectHost(hostId, secret);
  }

  /** UX-Spec §7.2: ein Host aus `connected` beim Start, ueber denselben Weg
   * wie "Connect". Ein Host, der schon verbunden ist, gerade verbindet oder
   * selbst neu verbunden wird, wird nicht ein zweites Mal verbunden -- und einer,
   * den der Nutzer inzwischen getrennt hat, gar nicht. Scheitert
   * der Aufbau am Netz -- typisch: die App startet, bevor das VPN steht --,
   * uebernimmt das Neuverbinden aus §5.4, sofern der Host selbst neu verbunden
   * werden darf. Jeder andere Fehler zeigt den gewohnten Zustand; eine
   * fehlende Passphrase ihr Feld, ohne Wiederholung. Danach wartet der Start
   * mit den gespeicherten Kacheln nicht mehr auf diesen Host; ein gelungener
   * Versuch hat seine Liste da schon gemeldet (`connectHost`). */
  async function connectRestoredHost(hostId: string): Promise<void> {
    const host = state.hosts.find((candidate) => candidate.id === hostId);
    if (backgroundStopped || !host || host.state === "connected" || host.state === "connecting" ||
      hostReconnects.isActive(hostId) || !workspaceSync.wantsConnected(hostId)) return;
    try {
      const result = await onConnectHost(hostId);
      if (result.kind === "failed" && isRetryableConnectError(result.error) && state.hosts.includes(host) &&
        reconnectsByItself(host)) {
        hostReconnects.start(hostId);
      }
    } finally {
      workspaceSync.hostSettled(hostId);
    }
  }

  /** Ein voller Verbindungsaufbau, von Hand oder als Versuch der Reihe aus
   * §5.4. Der Ausgang sagt der Reihe, ob es weitergeht: `superseded` heisst,
   * ein anderer Weg hat den Host inzwischen uebernommen. */
  async function connectHost(
    hostId: string,
    secret?: { passphrase?: string; password?: string },
  ): Promise<ReconnectAttemptResult> {
    const host = state.hosts.find((h) => h.id === hostId);
    // Narrowing; die Seitenleiste liefert nur IDs aus state.hosts.
    if (!host) return { kind: "superseded" };
    if (host.state === "connecting" || hostChangesInFlight.get(hostId)?.keepsConnection === false) {
      return { kind: "superseded" };
    }

    // Fix-Runde 1 (Befund 1, Spec §4.8): ein Passwort-Host ohne eingegebenes
    // Passwort lief bisher trotzdem auf den ersten Versuch -- das Backend
    // fiel dabei auf ssh-agent zurueck und scheiterte zuverlaessig mit einer
    // Agent-Fehlermeldung; erst danach erschien das Passwortfeld ueberhaupt.
    // Spec 4.8 will das Feld VOR dem ersten Versuch. Kein Versuch bedeutet
    // hier auch: kein Generationssprung und kein Best-effort-`disconnect_host`
    // fuer eine alte Laufzeit-ID (beides unten) -- deshalb steht diese
    // Verzweigung VOR beidem, nicht nur vor dem `connect_host`-Aufruf selbst.
    // Ein `authKind: "key"`-Host bleibt unangetastet: der erste Versuch ohne
    // Passphrase ist dort weiterhin richtig, weil ein Schluessel keine
    // Passphrase haben MUSS.
    if (host.authKind === "password" && !secret?.password) {
      // Derselbe Code wie ein abgelehntes Passwort: die Hinweisleiste zeigt
      // dann ihr Passwortfeld ("Enter it below and retry").
      state.setHostState(hostId, "failed", t("sidebar.notice.passwordRequired"), "password_required");
      return { kind: "failed", error: null };
    }

    // Reconnecting a failed terminal transport also retires any unfinished
    // control repair owned by that runtime, even before its IPC reply arrives.
    onCancelControlRepair(hostId);
    cancelSelfRepair(hostId);

    // Erhoeht (nicht: setzt) die Generation dieses Hosts UND merkt sich den
    // neuen Wert lokal, VOR dem `connect_host`-Aufruf -- dieser lokale Wert
    // ist der "war ich beim Start noch der juengste Versuch"-Vergleichswert
    // fuer BEIDE Ausgaenge unten (Erfolg und Fehlschlag). Siehe
    // `connectGenerationByHostId`s Kopfkommentar fuer die volle Begruendung.
    const generation = bumpConnectGeneration(hostId);

    // Best effort, VOR dem neuen Versuch: nach einem Verbindungsabriss bleibt
    // `host.runtimeId` bewusst stehen (siehe dort -- die Kachel soll mit
    // ihrer Sperrleiste offen bleiben). Ohne diesen Schritt verloere das
    // Programm mit dem Ueberschreiben unten nur den ZEIGER auf den alten
    // Transport, nicht den Transport selbst: `disconnect_host_impl` ist die
    // einzige Stelle, die einen aus der Backend-Tabelle nimmt, und sie wuerde
    // fuer die alte ID nie mehr gerufen. Jeder Abriss-Retry-Zyklus stapelte
    // so eine russh-Sitzung samt Keepalive bis zum Programmende.
    //
    // Nicht abgewartet und `host.runtimeId` dabei NICHT geleert: ein
    // Fehlschlag dieses Aufrufs darf den Verbindungsversuch nicht aufhalten,
    // und die Kachel behaelt bis zum Erfolg ihre Sperrleiste.
    const previousRuntimeId = host.runtimeId;
    if (previousRuntimeId) {
      void invoke("disconnect_host", { hostId: previousRuntimeId }).catch(() => {});
    }

    // Eine abgelaufene Frage zaehlt nur fuer DIESEN Aufbau (siehe
    // `expiredHostKeyPrompts`): ein Rest von frueher oder vom Erststart darf
    // keinen spaeteren Zeitablauf als abgelaufene Frage ansagen.
    const endpoint = `${host.hostname}:${host.port}`;
    expiredHostKeyPrompts.delete(endpoint);
    state.setHostState(hostId, "connecting");
    let reservation: { generation: number; runtimeId: string } | undefined;
    const isCurrent = () => state.hosts.includes(host) && connectGenerationByHostId.get(hostId) === generation;
    try {
      await connectionListenersReady;
      if (!isCurrent()) return { kind: "superseded" };
      const runtimeId = await invoke<string>("begin_connect", {});
      if (!isCurrent()) {
        trackRuntimeOwnership(runtimeId, false);
        void invoke("disconnect_host", { hostId: runtimeId }).catch(() => {});
        return { kind: "superseded" };
      }
      trackRuntimeOwnership(runtimeId, true);
      reservation = { generation, runtimeId };
      connectReservations.set(hostId, reservation);
      await invoke<string>("connect_host", {
        hostId: runtimeId,
        spec: {
          hostname: host.hostname,
          port: host.port,
          user: host.user,
          key_path: host.keyPath,
          // Abschlussreview (Important 1): stand hier fest auf `null` und
          // machte jeden Wiederverbindungsversuch auf einen
          // passphrasegeschuetzten, gespeicherten Schluessel zur Sackgasse.
          // Der Wert kommt aus der Hinweisleiste des fehlgeschlagenen Hosts
          // (`sidebar.ts`s `buildHostNotice`) und lebt ausschliesslich im
          // Arbeitsspeicher -- `settings.toml` sieht ihn nie (`add_host`
          // bekommt ihn gar nicht erst uebergeben, siehe `HostEntry`).
          //
          // `null` statt `undefined` bei leerer Eingabe: `HostSpecDto.
          // passphrase` ist `Option<Zeroizing<String>>` mit
          // `#[serde(default)]` -- beides ergibt dort `None`, aber `null`
          // haelt die Nutzlast fuer einen Host ohne Passphrase
          // byte-identisch zu vorher.
          passphrase: secret?.passphrase ?? null,
          // Task 8 (Spec §4.8): traegt jetzt tatsaechlich das Passwort aus
          // der Hinweisleiste durch -- `HostEntry.auth_kind` unterscheidet
          // seit diesem Task einen per Passwort gespeicherten Host von einem
          // Agent-Host (`sidebar.ts`s `buildHostNotice` zeigt das Passwortfeld
          // entsprechend), die vormalige Sackgasse ("weder gespeichert noch
          // unterscheidbar") ist damit geschlossen.
          password: secret?.password ?? null,
        },
      });

      if (!isCurrent()) {
        // Review-Nachtrag (zweite Runde): dieser Versuch ist ueberholt --
        // entweder durch einen Disconnect waehrend "connecting" (derselbe
        // Fall wie zuvor) ODER durch einen NEUEN Connect-Versuch, der
        // inzwischen angelaufen ist (der Fall, den die erste Fassung
        // uebersah). Die Verbindung ist jetzt tatsaechlich da, gehoert aber
        // nicht mehr zum aktuellen Versuch -- sofort wieder schliessen,
        // NIE anzeigen, unabhaengig davon, ob ein juengerer Versuch bereits
        // aufgeloest hat oder noch aussteht.
        void invoke("disconnect_host", { hostId: runtimeId }).catch(() => {});
        return { kind: "superseded" };
      }

      // `host.id` bleibt unangetastet -- daran haengen die Kachel- und
      // Fokusschluessel. Die frische Laufzeit-ID kommt daneben; ist sie eine
      // ANDERE als die bisherige, montiert `grid.ts::reconcile` die Kacheln
      // dieses Hosts daraufhin neu (ihre PTY-Kanaele sind mit dem alten
      // Transport gestorben).
      if (pendingRuntimeEvents.get(runtimeId)?.lost) {
        throw { code: "host_unreachable", message: t("terminal.transportLost") };
      }
      state.setRuntimeId(hostId, runtimeId);
      connectReservations.delete(hostId);
      reservation = undefined; // Ready ownership is now in AppState.
      // §5.4: ob dieser Host nach einem Transportverlust selbst neu verbunden
      // wird, haengt an dieser, der letzten erfolgreichen Verbindung.
      if (secret?.passphrase || secret?.password) hostsConnectedWithSecret.add(hostId);
      else hostsConnectedWithSecret.delete(hostId);
      state.setHostState(hostId, "connected");
      // UX-Spec §7.1: jede gelungene Verbindung, von Hand, beim Start oder
      // durch das Neuverbinden, kommt nach `connected`.
      workspaceSync.hostConnected(hostId);
      applyPendingRuntimeEvents(host);
      ensureGridMounted();
      scheduleStatusPoll(hostId);
      await refreshSessions(hostId);
      return { kind: "connected" };
    } catch (error) {
      if (reservation) {
        trackRuntimeOwnership(reservation.runtimeId, false);
        void invoke("disconnect_host", { hostId: reservation.runtimeId }).catch(() => {});
        if (connectReservations.get(hostId) === reservation) connectReservations.delete(hostId);
      }
      // Derselbe Vergleich wie beim Erfolg: ein veralteter Fehlschlag darf
      // den Zustand eines inzwischen neueren, noch laufenden (oder bereits
      // erfolgreichen) Versuchs nicht ueberschreiben.
      if (isCurrent()) {
        // Task 8 (Spec §4.8): `connect_host` liefert seit diesem Task
        // `ConnectError { code, message }` statt einer blossen Zeichenkette
        // -- ein bloßes `String(error)` zeigte dann `"[object Object]"`
        // statt der Meldung. Dasselbe Muster wie `onNewSession`s
        // `SessionError`-Auswertung weiter oben in dieser Datei: `message`
        // ausgelesen, wenn vorhanden, sonst der Fehler selbst als Text.
        // `code` steht neben der Meldung am Host: OB die Hinweisleiste nach
        // einem Geheimnis fragt, entscheidet er (nur nach Anmeldefehlern),
        // WELCHES Feld sie zeigt, `host.authKind`. Die Reihe aus §5.4 liest
        // den Code ebenfalls: nur Netzfehler wiederholt sie.
        const message = (error as { message?: unknown } | null)?.message;
        const code = (error as { code?: unknown } | null)?.code;
        state.setHostState(hostId, "failed", String(message ?? error), typeof code === "string" ? code : null);
        // Die Hostschluesselfrage dieses Aufbaus ist abgelaufen und still
        // verschwunden; ihren Satz traegt jetzt nur der Hinweis der
        // Seitenleiste, und der ist kein Alert. Einmal ansagen.
        if (expiredHostKeyPrompts.delete(endpoint) && code === "connect_timeout") announce(String(message ?? error));
        // UX-Spec §7.3: ein gescheiterter Aufbau oeffnet nichts, auch nicht
        // spaeter. Nur wenn der Host erst sein Geheimnis braucht (das Feld
        // steht dann in der Seitenleiste), oeffnet die Session nach dem Erfolg.
        if (code !== "password_required" && code !== "passphrase_required") sessionsAfterConnect.delete(hostId);
        return { kind: "failed", error };
      }
      return { kind: "superseded" };
    }
  }

  /** Ein Verbindungsaufbau, den der Nutzer AUSSERHALB der Seitenleiste
   * ausgeloest hat: "Reconnect" in der Kachel, "Connect …" im Schnelloeffnen
   * oder "Save" an geaenderten Verbindungsfeldern (UX-Spec §7.7). Liefert nach
   * dem Aufbau den Host, wenn danach noch etwas fokussiert werden darf, sonst
   * `null`: der Aufbau ist noch der eigene, kein Dialog steht offen, und der
   * Nutzer hat den Fokus waehrenddessen nicht selbst bewegt. Die
   * Hostschluessel-Rueckfrage zaehlt dabei nicht als Bewegung -- sie nimmt den
   * Fokus selbst und gibt ihn beim Schliessen zurueck --, und ebenso wenig die
   * Seitenleiste, die sich bei jedem Zustandswechsel neu baut und den Fokus an
   * das gleichwertige neue Element gibt (derselbe `data-focus-key`). Der Start
   * (§7.2) und das Neuverbinden (§5.4) gehen nicht hier durch und klappen
   * deshalb nie etwas auf. `secret` gilt nur fuer diesen einen Aufbau, wie
   * das Feld der Hinweisleiste. */
  async function connectFromOutsideSidebar(
    hostId: string,
    secret?: { passphrase?: string; password?: string },
  ): Promise<Host | null> {
    const host = state.hosts.find((candidate) => candidate.id === hostId);
    if (!host || host.state === "connecting") return null;
    const originalFocus = document.activeElement;
    const originalKey = originalFocus instanceof HTMLElement ? originalFocus.dataset.focusKey : undefined;
    let focusMoved = false;
    const trackFocus = (event: FocusEvent) => {
      if (event.target === originalFocus) return;
      if (originalKey !== undefined && event.target instanceof HTMLElement &&
        event.target.dataset.focusKey === originalKey) return;
      if (event.target instanceof Node && elements.hostKeyPromptRoot.contains(event.target)) return;
      focusMoved = true;
    };
    document.addEventListener("focusin", trackFocus);
    const attempt = onConnectHost(hostId, secret);
    const generation = connectGenerationByHostId.get(hostId);
    try {
      await attempt;
    } finally {
      document.removeEventListener("focusin", trackFocus);
    }
    if (!state.hosts.includes(host) || connectGenerationByHostId.get(hostId) !== generation) return null;
    // Der urspruengliche Klick erlaubt einen Fokuswechsel nach dem Aufbau,
    // aber keine spaetere Benutzerwahl oder inzwischen geoeffnete Dialoge
    // zu uebergehen. Gilt auch fuer die Passwort-/Passphrasen-Hinweisleiste.
    if (focusMoved || elements.app.inert) return null;
    return host;
  }

  /** Die Antwort, die ein fehlgeschlagener Host in der Seitenleiste braucht:
   * ihre Hinweisleiste mit Passwort- oder Passphrasefeld, sonst "Retry" -- der
   * Anmeldeweg wie bei Retry der Seitenleiste. Eine eingeklappte Seitenleiste
   * klappt dafuer auf, ueber denselben Weg wie Strg+Umschalt+B: der
   * Arbeitsplatz speichert den neuen Zustand, die Terminals passen sich einmal
   * an. Der Fokus geht in das erste Bedienelement der Hinweisleiste. */
  function focusHostNotice(hostId: string): void {
    if (sidebarCollapsed) toggleSidebar();
    const row = Array.from(elements.sidebar.querySelectorAll<HTMLElement>(".row-host"))
      .find((candidate) => candidate.dataset.hostId === hostId);
    const notice = row?.closest(".sb-host-block")?.querySelector(".host-notice");
    notice?.querySelector<HTMLElement>("input, button")?.focus();
  }

  async function reconnectHostFromTile(hostId: string): Promise<void> {
    const originalTile = state.focusedTile;
    const host = await connectFromOutsideSidebar(hostId);
    // Eine inzwischen andere Kachel ist ebenfalls eine Benutzerwahl.
    if (!host || state.focusedTile !== originalTile) return;
    // Der Wiederaufbau braucht ggf. ein neues Passwort/eine Passphrase.
    if (host.state === "failed") focusHostNotice(hostId);
    else if (host.state === "connected") gridHandle?.focusActiveTile();
  }

  /** "Connect …" im Schnelloeffnen (UX-Spec §7.5) und das Wiederverbinden nach
   * "Save" an geaenderten Verbindungsfeldern (§7.7): derselbe Aufbau wie
   * "Connect" der Seitenleiste. Braucht der Host danach eine Antwort -- ein
   * Passwort-Host sofort, ein Key-Host nach `passphrase_required`, jeder nach
   * einer abgelehnten Hostschluessel-Rueckfrage --, zeigt die Seitenleiste sie,
   * auch wenn sie eingeklappt war, und der Fokus geht hinein (Task 15/16
   * und 18). Ein mitgegebenes Geheimnis aus dem
   * Bearbeiten-Formular traegt nur diesen Aufbau; verlangt er eine neue
   * Antwort, fragt die Hinweisleiste. */
  async function connectAndFocusNotice(
    hostId: string,
    secret?: { passphrase?: string; password?: string },
  ): Promise<void> {
    const host = await connectFromOutsideSidebar(hostId, secret);
    if (host?.state === "failed") focusHostNotice(hostId);
  }

  /** "Disconnect" der Seitenleiste: der Nutzer will den Host nicht mehr
   * verbunden haben (UX-Spec §7.1). Nur dieser Weg nimmt ihn aus `connected`
   * -- Entfernen hat seinen eigenen (`onRemoveHost`), und Bearbeiten trennt,
   * ohne ihn herauszunehmen, und verbindet danach selbst neu (`submitEdit`). */
  function onUserDisconnectHost(hostId: string): void {
    workspaceSync.hostDisconnectedByUser(hostId);
    onDisconnectHost(hostId);
  }

  /** Trennt einen Host und raeumt alles ab, was an seiner Verbindung haengt.
   * `keepTiles`: seine Kacheln bleiben stehen (Bearbeiten mit Wiederverbinden,
   * UX-Spec §7.7) -- das Raster sperrt sie, bis die neue Verbindung sie auf dem
   * gewohnten Weg wieder anhaengt; eine Session, die es dann nicht mehr gibt,
   * raeumt die neue Sessionliste ab. */
  function onDisconnectHost(hostId: string, keepTiles = false): void {
    const host = state.hosts.find((h) => h.id === hostId);
    if (!host) return;
    // Ein abgebrochener Aufbau oeffnet nichts mehr (UX-Spec §7.3).
    sessionsAfterConnect.delete(hostId);
    onCancelControlRepair(hostId);
    // Trennen und Entfernen beenden die Selbstreparatur, das Neuverbinden
    // (§5.4) und den Polltakt.
    cancelSelfRepair(hostId);
    hostReconnects.stop(hostId);
    stopStatusPoll(hostId);
    const reservation = connectReservations.get(hostId);
    connectReservations.delete(hostId);
    if (reservation) {
      trackRuntimeOwnership(reservation.runtimeId, false);
      void invoke("disconnect_host", { hostId: reservation.runtimeId }).catch(() => {});
    }

    if (host.state === "connecting") {
      // Invalidate even while begin_connect has not delivered its ID yet.
      bumpConnectGeneration(hostId);
    }

    // `disconnect_host_impl` meldet kein `terminal://connection-lost` fuer
    // die Terminals, die es schliesst (derselbe Entfernen-vor-Schliessen-Weg
    // wie `close_terminal_impl`, siehe dessen Doc-Kommentar) -- ohne dieses
    // Aufraeumen wuerden Kacheln, die Sessions dieses Hosts zeigen, einen
    // `sessionKey` behalten, der auf einen bereits geschlossenen PTY-Kanal
    // zeigt. Mit `keepTiles` behalten sie ihn absichtlich: ohne Laufzeit-ID
    // montiert das Raster nichts, es sperrt die Kachel.
    if (!keepTiles) {
      // Ueber eine Kopie: `closeTile` nimmt die Kachel aus der Liste, ein
      // Zaehler ueber die Liste selbst uebersprange jede zweite.
      for (const tile of state.tiles.filter((candidate) => candidate.sessionKey.startsWith(`${hostId}/`))) {
        state.closeTile(tile.id);
      }
    }
    const runtimeId = host.runtimeId;
    // Vor dem `invoke` geleert, nicht danach: `runtimeId` heisst "es gibt
    // eine lebende Verbindung". Ab hier gibt es keine mehr, und der naechste
    // Verbindungsaufbau soll nicht noch einmal dieselbe ID trennen.
    state.setRuntimeId(hostId, null);
    state.setHostState(hostId, "disconnected");
    if (runtimeId) {
      void invoke("disconnect_host", { hostId: runtimeId }).catch(() => {
        // Best effort, dasselbe Muster wie die alte `disconnect()`-Funktion:
        // der Host steht in der Seitenleiste ohnehin schon als getrennt.
      });
    }
  }

  async function onRemoveHost(hostId: string): Promise<void> {
    const host = state.hosts.find((h) => h.id === hostId);
    if (!host || hostChangesInFlight.has(hostId)) return;
    hostChangesInFlight.set(hostId, { keepsConnection: false });
    // Disconnect even a failed host: it can still carry a runtime ID and tiles.
    // Keep its generation on failure so a late connect can never become current.
    onDisconnectHost(hostId);
    try {
      await invoke("remove_host", { id: hostId });
      connectGenerationByHostId.delete(hostId);
      hostsConnectedWithSecret.delete(hostId);
      hostProbesInFlight.delete(hostId);
      sessionListVersionByHostId.delete(hostId);
      listedGenerations.delete(hostId);
      state.removeHost(hostId);
      workspaceSync.hostRemoved(hostId);
    } catch (error) {
      // Der Satz des Backends nennt Datei und Ursache -- ohne ihn wuesste
      // niemand, was am Entfernen scheiterte. Er steht deshalb im Banner.
      showGlobalError(t("sidebar.removeFailed", { label: host.label, message: String(error) }), String(error));
    } finally {
      hostChangesInFlight.delete(hostId);
    }
  }

  function onReloadSessions(hostId: string): void {
    void refreshSessions(hostId);
  }

  function onNewSession(hostId: string): void {
    const host = state.hosts.find((h) => h.id === hostId);
    // Ersetzt das alte `if (!terminalHandle) return`/`sessionSection.hidden`-
    // Waechterpaar (siehe Kopfkommentar): dies hier ist die Pruefung fuer den
    // neuen, tatsaechlich erreichbaren Aufrufer -- eine reine TS-Verengung,
    // keine Reichweiten-Behauptung, die ein kuenftiger Leser nachpruefen
    // muesste.
    if (!host) return;

    // Spec 2026-10-19 §5.1 Nr. 3: an einer Grenze der Hinweis und nichts sonst
    // -- vor dem Dialog, sonst legte tmux die Session an, und erst danach kaeme
    // der Hinweis. Vor der Verbindungswache wie beim Klick auf eine Session
    // (`openSessionFromSidebar`): an der Grenze hilft Verbinden nicht. Hier
    // laufen alle Wege durch (Strg+Umschalt+N, die Knoepfe in Seitenleiste und
    // leerem Raster, "New session on …" im Schnelloeffnen); die Pruefung nach
    // dem Anlegen in `createSession` bleibt fuer den Fall, dass sich die Kacheln
    // inzwischen geaendert haben.
    const limit = state.newSessionLimit(hostId);
    if (limit) {
      showTileLimit(limit);
      return;
    }

    // Review-Nachtrag (Minor): ein Aufruf fuer einen getrennten oder noch
    // verbindenden Host liefe mit der (moeglicherweise laengst veralteten) ID
    // ins Leere, mit einer fuer den Nutzer nicht deutbaren Backend-Meldung
    // ("host not connected"). Sichtbar erklaeren statt das ins Backend
    // durchreichen.
    // Seit Task 16, Punkt E deaktiviert `sidebar.ts` den Knopf "New session"
    // an einem nicht verbundenen Host -- diese Wache bleibt trotzdem: der
    // Akkord `Ctrl+Shift+N` (`newSessionOnTargetHost`, Schritt 1 und 2 der
    // Kette nehmen auch einen getrennten Host) kommt nicht ueber jenen Knopf,
    // und die Verbindung kann zwischen Oeffnen und Absenden des Dialogs fallen
    // (siehe `createSession`s gleichlautende Wache).
    // `!host.runtimeId` gehoert in DIESELBE Bedingung, nicht in eine zweite
    // darunter: beides heisst fuer den Nutzer dasselbe ("dieser Host hat
    // gerade keine Verbindung"), und die Verengung macht die Laufzeit-ID fuer
    // den Dialog unten ueberhaupt erst benutzbar. Ein "connected" ohne
    // Laufzeit-ID kann es nach `onConnectHost` nicht geben -- diese Haelfte
    // ist eine TS-Verengung, keine zweite Zustandsbehauptung.
    if (host.state !== "connected" || !host.runtimeId) {
      showGlobalError(t("sessionDialog.hostNotConnected", { host: host.label }));
      return;
    }

    // In eine lokale Konstante gezogen: die Verengung oben traegt nicht in
    // den Rueckruf unten hinein (`host.runtimeId` ist ein veraenderliches
    // Feld).
    const runtimeId = host.runtimeId;
    // UX-Spec §7.6: die letzten Verzeichnisse dieses Hosts aus dem Arbeitsplatz.
    const dirs = workspaceSync.dirs(host.id);

    let dialog: SessionDialogHandle | undefined;
    openDialog({
      title: t("sessionDialog.heading", { host: host.label }),
      // Breite Huelle (Spec 11.1): dieser Dialog traegt als einziger den
      // Verzeichnisbaum.
      wide: true,
    }, (container) => {
      dialog = mountSessionDialog(container, {
        // Die LAUFZEIT-ID: der Verzeichnisbaum im Dialog ruft
        // `list_directories`, und das schlaegt den Host in derselben Tabelle
        // nach wie `create_session` (siehe den Kopfkommentar zu den zwei
        // ID-Raeumen). `onSubmit` unten geht dagegen ueber `createSession`,
        // und das nimmt die settings-ID -- die Grenze verlaeuft an der
        // Backend-Kante, nicht hier.
        hostId: runtimeId,
        // Das Verzeichnis der zuletzt erfolgreich angelegten Session -- aus
        // diesem Lauf, sonst gespeichert --, sonst das Heimatverzeichnis
        // (leer).
        initialCwd: host.lastCwd || dirs?.last || "",
        recentDirs: dirs?.recent ?? [],
        // Der Stand, den diese Anwendung KENNT -- mehr kann sie nicht
        // anbieten, und der Dialog sagt in seinem Kommentar auch, dass das
        // best effort ist. Verbindlich prueft das Backend. Auch der
        // Namensvorschlag meidet genau diese Namen.
        existingSessions: host.sessions.map((s) => s.name),
        onSubmit: (cwd, name) => {
          // Das Zurueckschreiben des Verzeichnisses ist Sache des Aufrufers
          // (`session-dialog.ts`s eigener Kopfkommentar), und zwar erst nach
          // dem gelungenen Anlegen (`rememberSessionDir`).
          closeDialog();
          void createSession(hostId, cwd, name);
        },
        onCancel: () => closeDialog(),
      });
      return dialog;
    });
    // Erst jetzt (UX-Spec §7.6): `openDialog` legt den Fokus NACH dem Aufbau
    // auf das Schliessen-Kreuz, ein Fokus im Aufbau ginge verloren.
    dialog?.focusName();
  }

  /** UX-Spec §7.6: nach JEDEM gelungenen Anlegen ist `cwd` das zuletzt genutzte
   * Verzeichnis dieses Hosts und steht vorn in den letzten -- im Lauf
   * (`host.lastCwd`) wie im Arbeitsplatz (`dirs[host]`, auch nach einem
   * Neustart); ein gescheitertes Anlegen aendert keins von beiden. Ein
   * inzwischen entfernter Host bekommt keine Verzeichnisse zurueck. */
  function rememberSessionDir(hostId: string, cwd: string): void {
    const host = state.hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    const dirs = withRecentDir(workspaceSync.dirs(hostId), cwd);
    workspaceSync.setDirs(hostId, dirs);
    host.lastCwd = dirs.last ?? cwd;
  }

  /** `hostId` ist die SETTINGS-ID, wie bei `refreshSessions` und aus
   * demselben Grund: `create_session`/`list_sessions` meinen die lebende
   * Verbindung, `writeSessions`/`openSession` den gespeicherten Host. Die
   * Uebersetzung bleibt in dieser Funktion. */
  async function createSession(
    hostId: string,
    cwd: string,
    name: string | null = null,
  ): Promise<void> {
    const connection = sessionConnection(hostId);
    if (!connection) {
      // Erreichbar, obwohl `onNewSession` den Zustand schon geprueft hat:
      // zwischen dem Oeffnen des Dialogs und dem Absenden kann der Nutzer den
      // Host getrennt haben. Dieselbe Meldung wie beim Oeffnen einer Session
      // -- sie sagt, was zu tun ist, statt "host not connected" aus dem
      // Backend durchzureichen.
      const label = state.hosts.find((h) => h.id === hostId)?.label ?? hostId;
      showGlobalError(t("session.hostNotConnected", { host: label }));
      return;
    }
    const { runtimeId } = connection;
    await mutateSessions(connection, async () => {
      try {
        const session = await invoke<string>("create_session", { hostId: runtimeId, cwd, name });
        // Vor der Wache: die Session gibt es auf dem Host, auch wenn die
        // Verbindung inzwischen gewechselt hat (Fix-Runde 1, Minor 4).
        rememberSessionDir(hostId, cwd);
        if (!isCurrentConnection(connection)) return;
        // Reihenfolge verbindlich: `list_sessions` MUSS vor `openSession`
        // laufen. `AppState.openSession` markiert nur eine BEREITS in
        // `host.sessions` vorhandene Session als offen; `resolveSession`
        // (`grid.ts`) faende die frisch angelegte Session sonst nicht, und
        // `reconcile()` mountete still gar kein Terminal -- eine Kachel mit
        // gesetztem `sessionKey`, aber ohne sichtbaren Inhalt.
        let listed: SessionListDto;
        const controlGeneration = state.controlForHost(hostId).generation;
        const lastSuccess = successfulSessionLists.get(connection.host) ?? 0;
        try {
          listed = await listSessions(hostId, runtimeId);
        } catch (error) {
          if (!isCurrentConnection(connection) || state.controlForHost(hostId).generation !== controlGeneration ||
            (successfulSessionLists.get(connection.host) ?? 0) !== lastSuccess) return;
          const failure = sessionListError(error);
          if (failure.controlGeneration !== undefined && failure.controlGeneration !== controlGeneration) return;
          state.setSessionListError(hostId, failure);
          showGlobalError(t("session.createdListStale", { name: session }), failure.message);
          return;
        }
        if (!isCurrentConnection(connection) || state.controlForHost(hostId).generation !== controlGeneration) return;
        recordSessionListSuccess(connection.host);
        // Diese Liste ist der Abschluss der aktuellen Mutation. Schreiben
        // entwertet noch offene Refreshes, bevor die neue Kachel erscheint.
        writeSessionRecords(hostId, listed);
        workspaceSync.beforeUserOpen();
        const opened = state.openSession(hostId, session);
        if (opened.kind === "limit") {
          showTileLimit(opened);
          return;
        }
        // Wie beim Oeffnen aus der Seitenleiste: der Nutzer hat diese Session
        // gerade selbst angelegt, sie ist sichtbar, also gehoert der Fokus
        // hinein (Designsystem §7.5), und die Kachel leuchtet auf (§6.2).
        gridHandle?.focusActiveTile();
        gridHandle?.revealTile(opened.tileId);
      } catch (error) {
        if (!isCurrentConnection(connection)) return;
        // STRUKTURIERT unterschieden, nicht per Textmusterung: `create_session`
        // liefert `{ kind, message }` (siehe `SessionError` in `commands.rs`).
        // Eine Musterung auf Prosa, die das Backend formuliert, braeche still,
        // sobald dort jemand ein Wort aendert.
        //
        // `message` bleibt trotzdem erreichbar -- als Rohtext in "Copy
        // details" (UX-Spec §10). Nur bei `outcome_unknown` ist er selbst der
        // Satz, den der Nutzer liest (siehe unten).
        const kind = (error as { kind?: unknown } | null)?.kind;
        if (kind === "duplicate" && name) {
          const label = state.hosts.find((h) => h.id === hostId)?.label ?? hostId;
          showGlobalError(t("session.error.duplicate", { name, host: label }));
          return;
        }
        const message = String((error as { message?: unknown } | null)?.message ?? error);
        if (kind === "outcome_unknown") {
          // Das Anlegen hat vielleicht gewirkt. Der Satz des Backends sagt, erst
          // die Sessionliste neu zu laden; "try again" aus `session.error`
          // legte sonst eine zweite Session an. Er steht deshalb ganz da.
          showGlobalError(message, message);
          return;
        }
        showGlobalError(t("session.error"), message);
      }
    });
  }

  function onEditHost(hostId: string): void {
    const host = state.hosts.find((h) => h.id === hostId);
    if (!host || hostChangesInFlight.has(hostId)) return;

    const initial: Partial<HostFormValue> = {
      label: host.label,
      hostname: host.hostname,
      user: host.user,
      port: host.port,
    };
    // Task 8 (Spec §4.8): vorher NUR fuer `host.keyPath` gesetzt -- ein per
    // Passwort oder ausdruecklich per ssh-agent gespeicherter Host liess
    // `initial.auth` unbelegt, und `host-form.ts`s `applyPreselection()`
    // ratete dann anhand gefundener Schluessel/Platzhalter, statt die
    // TATSAECHLICH gespeicherte Anmeldeart zu zeigen -- derselbe stille
    // Verlust wie beim erneuten Verbinden aus der Seitenleiste, nur im
    // Bearbeiten-Dialog. `host.authKind` ist nie `null`/fehlend (siehe dessen
    // Kommentar, `app-state.ts`), jeder der drei Zweige greift.
    if (host.authKind === "key" && host.keyPath) {
      initial.auth = { kind: "key", path: host.keyPath, passphrase: "" } satisfies AuthChoice;
    } else if (host.authKind === "password") {
      initial.auth = { kind: "password", password: "" } satisfies AuthChoice;
    } else {
      initial.auth = { kind: "agent" } satisfies AuthChoice;
    }

    openDialog({
      title: t("hostForm.heading.edit"),
      // Ein gelungenes Speichern (und das Trennen danach) zeichnet die
      // Seitenleiste neu und haengt den Oeffner ab; dann ist diese Zeile das
      // Rueckkehrziel. Ein laufendes oder gescheitertes Speichern zeichnet
      // nichts neu, der Oeffner selbst bekommt den Fokus zurueck (es wird
      // zuerst gespeichert, erst danach getrennt).
      fallbackFocus: () => Array.from(elements.sidebar.querySelectorAll<HTMLElement>(".row-host"))
        .find((row) => row.dataset.hostId === hostId) ?? null,
    }, (container) => {
      let disposed = false;
      let pending = false;
      const formHost = document.createElement("div");
      const errorEl = document.createElement("p");
      errorEl.setAttribute("role", "alert");
      container.append(formHost, errorEl);
      const form = mountHostForm(formHost, {
        mode: "edit",
        initial,
        existing: state.hosts
          .filter((h) => h.id !== hostId)
          .map((h) => ({ hostname: h.hostname, user: h.user, port: h.port })),
        onSubmit: (values) => {
          if (pending) return;
          pending = true;
          errorEl.textContent = "";
          formHost.inert = true;
          formHost.setAttribute("aria-busy", "true");
          void submitEdit(host, values).then((outcome) => {
            if (outcome.saved) {
              // Erst schliessen: die Huelle gibt den Fokus zurueck. Danach
              // verbindet ein Host neu, dessen Verbindungsfelder sich
              // geaendert haben, auf dem Weg von "Connect …" -- einmal, mit
              // dem im Formular getippten Passwort oder der Passphrase, wenn
              // es eins gibt (Aufgabe 18). Braucht er
              // danach noch eine Antwort, erscheint das Feld, und der Fokus
              // geht hinein (UX-Spec §7.7). Auch dann, wenn Escape
              // den Dialog waehrend des Speicherns schon geschlossen hat --
              // der Host wollte verbunden sein.
              if (!disposed) closeDialog();
              if (outcome.reconnect) void connectAndFocusNotice(hostId, reconnectSecret(values));
              return;
            }
            if (disposed) return;
            errorEl.textContent = outcome.error;
            formHost.inert = false;
            formHost.removeAttribute("aria-busy");
            pending = false;
            formHost.querySelector<HTMLElement>('button[type="submit"]')?.focus();
          });
        },
      });
      return {
        dispose() {
          disposed = true;
          form.dispose();
        },
      };
    });
  }

  /** Was ein "Save" im Bearbeiten-Dialog ergab: gespeichert, und ob der Host
   * danach neu verbunden wird -- oder die Meldung fuer den Dialog. */
  type EditOutcome = { saved: true; reconnect: boolean } | { saved: false; error: string };

  /** UX-Spec §7.7 (Aufgabe 18). Gespeichert
   * wird ZUERST -- `update_host` schreibt nur settings.toml und beruehrt keine
   * Verbindung. Scheitert es, ist nichts getrennt: Verbindung, Kacheln und ein
   * laufendes Neuverbinden bleiben, und ein neues "Save" verlaeuft wie das
   * erste.
   *
   * Erst nach dem Erfolg zaehlt, was sich geaendert hat. Nur der Name: nichts
   * weiter, auch ein laufendes Neuverbinden (§5.4) laeuft weiter.
   * Verbindungsfelder (`changesConnection`) an einem Host, der eine Verbindung
   * will -- verbunden, verbindend, gescheitert oder mitten im Neuverbinden --:
   * das Neuverbinden endet, der Host wird getrennt, seine Kacheln bleiben
   * gesperrt stehen, und `onEditHost` verbindet ihn einmal mit den neuen
   * Werten neu. Das ist kein Trennen durch den Nutzer: er bleibt in
   * `connected` (§7.1). Ein getrennter Host wird nur gespeichert. */
  async function submitEdit(host: Host, values: HostFormValue): Promise<EditOutcome> {
    if (!state.hosts.includes(host) || hostChangesInFlight.has(host.id)) {
      return { saved: false, error: t("hostForm.editFailed", { label: host.label, message: t("hostForm.editBusy") }) };
    }
    const connectionChanged = changesConnection(host, values);
    hostChangesInFlight.set(host.id, { keepsConnection: true });
    try {
      const saved = await editHost(host, values);
      // An Ort und Stelle, nicht `upsertHost`: dasselbe Objekt, damit laufende
      // Auftraege dieses Hosts (Sessionliste, Statusabfrage) ihn weiter als
      // ihren erkennen. Vor dem Trennen, damit das Wiederverbinden die neuen
      // Werte liest.
      state.updateHostSettings(host.id, settingsFromEntry(saved));
      // Der Zustand von JETZT: hat der Nutzer waehrend des Speicherns getrennt
      // (Escape, dann "Disconnect"), bleibt es beim Speichern.
      const reconnect = connectionChanged && host.state !== "disconnected";
      if (reconnect) onDisconnectHost(host.id, true);
      return { saved: true, reconnect };
    } catch (error) {
      // Der Satz nennt den Grund, denn er steht auch im Dialog, der kein
      // "Copy details" hat; das Banner bietet den Rohtext zusaetzlich an.
      const message = t("hostForm.editFailed", { label: host.label, message: String(error) });
      showGlobalError(message, String(error));
      return { saved: false, error: message };
    } finally {
      hostChangesInFlight.delete(host.id);
    }
  }

  function onAddHost(): void {
    // Dieselbe Verbinden-Preflight-Speichern-Ansicht wie beim Erststart,
    // nur in der Ueberlagerung statt im Rasterbereich (dort laeuft ja schon
    // das Raster mit ggf. laufenden Terminals) -- kein zweiter Code-Pfad
    // fuer "einen Host hinzufuegen", ob es der erste oder der fuenfte ist.
    openDialog({ title: t("firstRun.heading") }, (container) =>
      // `compact` (Spec 9.6): Logo, Name, Satz und Anforderungszeile
      // entfallen hier -- der Dialogkopf traegt den Titel bereits.
      mountFirstRun(container, {
        onHostReady: handleHostReady,
        compact: true,
        beforeConnect: () => connectionListenersReady,
      onRuntimeOwnershipChange: trackRuntimeOwnership,
      }),
    );
  }

  // Tastatur (Task 12, Designsystem §7.5): die Aktionen hinter den
  // Akkorden. Die Lauscher selbst haengt `installKeyboard` (keyboard.ts)
  // weiter unten ans `document`.
  /** Darf diese Session gerade in eine Kachel -- oder ist es ueberhaupt keine
   * Belegung, sondern nur ein Fokuswechsel?
   *
   * Die Unterscheidung ist der ganze Punkt, und die erste Fassung dieser
   * Wache hatte sie nicht (Gutachten zu diesem Paket): eine Session, die
   * BEREITS in einer sichtbaren Kachel liegt, wird von `openSession` nur
   * fokussiert -- da ist nichts zu oeffnen, nichts zu verdraengen und kein
   * `open_terminal` im Spiel. Ein Zustandswaechter davor sperrte
   * genau den Fall aus, fuer den Designsystem §7.5 den Tastaturweg
   * verspricht: die Kachel eines FEHLGESCHLAGENEN Hosts bleibt mit
   * Sperrleiste sichtbar (Zusage aus Paket 1), und der Nutzer muss zu ihr
   * zurueckkommen koennen, um die letzte Ausgabe zu lesen.
   *
   * Fuer alles andere gilt die Wache: die Seitenleiste zeigt Sessionzeilen
   * auch fuer einen getrennten Host (die Liste bleibt beim Trennen stehen),
   * und ohne sie belegte ein Klick darauf eine Kachel -- verdraengte
   * womoeglich eine LAUFENDE Session --, setzte `open = true`, und im
   * Kachelkopf standen Titel und Hostname ueber einem leeren Rechteck.
   * `!host.runtimeId` gehoert in dieselbe Bedingung: ohne lebende Verbindung
   * montiert `grid.ts::reconcile` ohnehin nichts. */
  function canOpenSession(host: Host, name: string, socket: SessionSocket = "app"): boolean {
    const shown = state.tileForSession(sessionKey(host.id, name, socket)) !== null;
    return shown || (host.state === "connected" && host.runtimeId !== null);
  }

  /** Spec 2026-10-19 §5.3: an einer Grenze erscheint ein Hinweis, und es
   * schliesst nichts. Er steht im globalen Banner, in der neutralen Fassung
   * ohne Gefahrentoenung. */
  function showTileLimit(result: Extract<OpenResult, { kind: "limit" }>): void {
    const host = state.hosts.find((candidate) => candidate.id === result.hostId);
    showGlobalError(
      result.scope === "host"
        ? t("tile.limit.host", { host: host?.label ?? result.hostId, count: String(MAX_TILES_PER_HOST) })
        : t("tile.limit.total", { count: String(MAX_TILES) }),
      undefined,
      "neutral",
    );
  }

  /** Wie die Wahl ausgeloest wurde: Strg+Klick und Strg+Enter ersetzen die
   * fokussierte Kachel (Spec 2026-10-19 §5.2). */
  interface OpenRequest {
    replace?: boolean;
    /** Spec 2026-10-25 §5: fehlt er, ist es der eigene Socket. */
    socket?: SessionSocket;
  }

  /** Der Weg, auf dem eine Session auf WUNSCH DES NUTZERS in eine Kachel
   * kommt: Klick auf die Sidebar-Zeile (ueber `openSessionFromSidebar`).
   *
   * Die Wache steht HIER und nicht im Rueckruf der Seitenleiste, weil die
   * Tastaturwege `state.openSession` frueher direkt riefen -- eine Wache im
   * Rueckruf haette den Mausweg gedeckt und `Ctrl+Shift+1..9` weiterhin
   * offen gelassen.
   *
   * Zwei weitere Stellen rufen `state.openSession`, bewusst an dieser Wache
   * vorbei, damit niemand sie fuer vergessen haelt: `createSession` (die
   * Session ist gerade erst auf einem verbundenen Host entstanden) und
   * `openSessionAfterConnect` (der Host ist eben verbunden und gelistet).
   * "Reconnect" in der Sperrleiste (`grid.ts::requestReconnect`) ruft
   * `openSession` nicht mehr: es ersetzt den Kanal an Ort und Stelle. */
  function openSessionByUser(hostId: string, name: string, request: OpenRequest = {}): void {
    const host = state.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const socket = request.socket ?? "app";
    if (!canOpenSession(host, name, socket)) {
      showGlobalError(t("session.hostNotConnected", { host: host.label }));
      return;
    }
    workspaceSync.beforeUserOpen();
    const result = request.replace
      ? state.replaceFocusedTile(hostId, name, socket)
      : state.openSession(hostId, name, socket);
    if (result.kind === "limit") {
      showTileLimit(result);
      return;
    }
    // Designsystem §7.5 und Spec 2026-10-19 §6.2: der Tastaturfokus folgt
    // der Kachel, und sie leuchtet auf. Hier und nicht in `grid.ts`s
    // `render()`: DIES ist die Benutzerabsicht (siehe
    // `GridHandle.focusActiveTile`, `GridHandle.revealTile`).
    gridHandle?.focusActiveTile();
    gridHandle?.revealTile(result.tileId);
  }

  function openSidebarSession(session: Session): void {
    openSessionByUser(session.hostId, session.name, socketOf(session) === "default" ? { socket: "default" } : {});
  }

  /** UX-Spec §7.3: je Host die Session, die ein Klick auf ihre Zeile oeffnen
   * will, sobald der Host verbunden und seine Liste da ist -- und ob sie die
   * fokussierte Kachel ersetzen soll (Strg+Klick, Spec 2026-10-19 §5.2). */
  const sessionsAfterConnect = new Map<string, { name: string; replace: boolean; socket: SessionSocket }>();

  /** Klick auf eine Sessionzeile der Seitenleiste. Ist der Host nicht verbunden
   * und die Session nicht schon sichtbar, verbindet der Klick ihn wie "Connect"
   * und oeffnet die Session, sobald die Liste sie enthaelt (UX-Spec §7.3).
   * An einer Grenze verbindet der Klick nicht erst, er zeigt gleich den
   * Hinweis (Spec 2026-10-19 §5.1 Nr. 3).
   * Braucht der Host ein Passwort, steht danach das Feld da, und die Session
   * oeffnet nach dem Erfolg; ein gescheiterter Aufbau oeffnet nichts
   * (`connectHost`). Nur dieser Weg verbindet; Strg+Umschalt+A uebergeht eine
   * Session, die sich nicht oeffnen laesst. */
  function openSessionFromSidebar(hostId: string, name: string, request: OpenRequest = {}): void {
    const host = state.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const socket = request.socket ?? "app";
    if (canOpenSession(host, name, socket)) {
      openSessionByUser(hostId, name, request);
      return;
    }
    // Spec 2026-10-19 §5.1 Nr. 2-3: eine neue Kachel gibt es nur unterhalb der
    // Grenzen. Ist eine erreicht, verbindet der Klick den Host gar nicht erst
    // -- sonst fragte ein Passwort-Host nach dem Passwort, und die Kachel kaeme
    // danach doch nicht. Dieselbe Regel wie beim Oeffnen (`openLimit`, also
    // `planOpen`). Ersetzen (Strg+Klick) aendert die Zahl der Kacheln nicht;
    // seine Grenze prueft `openSessionAfterConnect` nach dem Verbinden.
    if (!request.replace) {
      const limit = state.openLimit(hostId, name, socket);
      if (limit) {
        showTileLimit(limit);
        return;
      }
    }
    sessionsAfterConnect.set(hostId, { name, replace: request.replace === true, socket });
    // Verbindet der Host gerade (etwa ein Versuch des Neuverbindens aus §5.4),
    // bringt der laufende Aufbau die Liste. "Connect" kaeme hier ohnehin nicht
    // durch (`connectHost` kehrt bei "connecting" um) und beendete nur die Reihe.
    if (host.state === "connecting") return;
    void onConnectHost(hostId).then((result) => {
      // Kam gar kein Aufbau zustande (etwa waehrend Bearbeiten oder Entfernen
      // gespeichert wird) und laeuft auch keiner, bringt keiner die Liste:
      // dann wartet auch nichts darauf.
      const current = state.hosts.find((candidate) => candidate.id === hostId);
      if (result.kind === "superseded" && current?.state !== "connecting" && sessionsAfterConnect.get(hostId)?.name === name) {
        sessionsAfterConnect.delete(hostId);
      }
    });
  }

  /** Oeffnet die per Klick gewuenschte Session, sobald die Liste ihres Hosts da
   * ist (`writeSessionRecords`), einmal. Den Fokus nimmt sie nur, wenn er noch
   * in der Seitenleiste liegt, wo der Klick war: arbeitet der Nutzer inzwischen
   * in einer Kachel oder einem Dialog, bleibt er dort. */
  function openSessionAfterConnect(hostId: string): void {
    const wanted = sessionsAfterConnect.get(hostId);
    if (wanted === undefined) return;
    sessionsAfterConnect.delete(hostId);
    const host = state.hosts.find((h) => h.id === hostId);
    if (!host?.sessions.some((session) => session.name === wanted.name && socketOf(session) === wanted.socket)) return;
    workspaceSync.beforeUserOpen();
    const result = wanted.replace
      ? state.replaceFocusedTile(hostId, wanted.name, wanted.socket)
      : state.openSession(hostId, wanted.name, wanted.socket);
    if (result.kind === "limit") {
      showTileLimit(result);
      return;
    }
    gridHandle?.revealTile(result.tileId);
    const active = document.activeElement;
    const focusFree = active === null || active === document.body || elements.sidebar.contains(active);
    if (focusFree && !elements.app.inert) gridHandle?.focusActiveTile();
  }

  /** Strg+Umschalt+1-9 (Spec 2026-10-19 §5.7): fokussiert die Kachel an
   * Position N; ein Kachelziel gibt es nicht mehr. Die Kachel leuchtet auf
   * (§6.2). */
  function focusTileByNumber(n: number): void {
    if (!state.focusTileAt(n - 1)) return;
    gridHandle?.focusActiveTile();
    if (state.focusedTile !== null) gridHandle?.revealTile(state.focusedTile);
  }

  /** Strg+Umschalt+Hoch/Runter (§5.7): Fokus zur vorigen oder naechsten
   * Kachel. Frueher blaetterten die Tasten durch die Liste; nach §5.1 legte
   * das je Tastendruck eine Kachel an. Die Kachel leuchtet auf (§6.2). */
  function focusAdjacentTileByUser(delta: 1 | -1): void {
    if (!state.focusAdjacentTile(delta)) return;
    gridHandle?.focusActiveTile();
    if (state.focusedTile !== null) gridHandle?.revealTile(state.focusedTile);
  }

  /** Host der Session in dieser Kachel; `null` ohne Kachel. Ueber
   * `sessionKey()` verglichen statt per String-Zerlegung -- der Schluessel ist
   * ausserhalb von `app-state.ts` ein opaker Wert (dasselbe Muster wie
   * `grid.ts`s `resolveSession`). */
  function hostIdOfTile(id: number | null): string | null {
    const key = state.tileById(id)?.sessionKey;
    if (!key) return null;
    return state.hosts.find((h) => h.sessions.some((s) => sessionKeyOf(s) === key))?.id ?? null;
  }

  /** Der Zielhost von Strg+Umschalt+N (UX-Spec §7.9), der erste zutreffende:
   *  1. Host der fokussierten belegten Kachel,
   *  2. Host der zuletzt fokussierten belegten Kachel (die Merkstelle in
   *     `AppState`; schloss diese Kachel, geht es mit 3 weiter),
   *  3. aktiver Host der Seitenleiste, wenn verbunden,
   *  4. der einzige verbundene Host.
   * Sonst `null`. Ein Host aus 1 oder 2 muss nicht verbunden sein: dann sagt
   * `onNewSession`, was zu tun ist. */
  function newSessionTargetHostId(): string | null {
    const fromTile = hostIdOfTile(state.focusedTile) ?? hostIdOfTile(state.lastFocusedOccupiedTile());
    if (fromTile !== null) return fromTile;
    // `sidebarHandle` steht weiter unten; gerufen wird erst nach dem Mount, aus
    // einem Tastendruck oder einem Klick (dasselbe Muster wie
    // `setSidebarCollapsed`).
    const active = state.hosts.find((h) => h.id === sidebarHandle.activeHostId());
    if (active?.state === "connected") return active.id;
    const connected = state.hosts.filter((h) => h.state === "connected");
    return connected.length === 1 ? connected[0].id : null;
  }

  /** Strg+Umschalt+N und der Knopf "New session" im leeren Raster -- EINE
   * Funktion fuer beide, damit der Tooltip des Knopfes "New session
   * (Ctrl+Shift+N)" stimmt. Mit Zielhost derselbe Dialog wie die "New
   * session"-Schaltflaeche der Seitenleiste (Design §6.4: "Beide Wege oeffnen
   * denselben kleinen Dialog"), kein zweiter Pfad; ohne (UX-Spec §7.9, Schritt
   * 5) das Schnelloeffnen. Bei mindestens zwei verbundenen Hosts mit der Vorgabe
   * "New session", die je Host "New session on {host}" uebrig laesst; ohne
   * verbundenen Host fuehrte sie ins Leere ("No matches") -- dann ohne Vorgabe,
   * und die Zeilen "Connect …" stehen vorn. */
  function newSessionOnTargetHost(): void {
    const hostId = newSessionTargetHostId();
    if (hostId !== null) {
      onNewSession(hostId);
      return;
    }
    const anyConnected = state.hosts.some((h) => h.state === "connected");
    showQuickOpen(anyConnected ? t("quickOpen.newSessionQuery") : undefined);
  }

  // UI-Anzeigezustand dieser Datei -- kein `AppState`-Feld, weil ihn ausser
  // dieser Datei niemand braucht. Gespeichert wird er trotzdem (UX-Spec §7.1):
  // `setSidebarCollapsed` meldet jede Aenderung dem Arbeitsplatz.
  let sidebarCollapsed = false;

  function setSidebarCollapsed(collapsed: boolean): void {
    sidebarCollapsed = collapsed;
    elements.app.classList.toggle("sidebar-collapsed", collapsed);
    // Die Seitenleiste kann das Einklappen nicht selbst bemerken: hier faellt
    // nur eine Klasse an `#app`, kein Zustandssignal. `display: none` nimmt
    // das Menue-DOM zwar mit, aber die Horcher an `document`/`window` blieben
    // zurueck und der Offen-Zustand veraltete.
    //
    // `sidebarHandle` wird erst weiter unten in `main()` deklariert --
    // zulaessig, weil `setSidebarCollapsed` nur aus einem Tastaturereignis
    // oder aus dem Start (`workspaceSync.start`, nach den `await`s in
    // `bootstrap`) heraus laeuft, also lange nach dem Mount (nachgeprueft:
    // zwischen der Anmeldung des Akkord-Horchers und dem Mount steht kein
    // `await`, es kann dazwischen also kein Ereignis zugestellt werden).
    sidebarHandle.closeMenu();
    // UX-Spec §7.8: eingeklappt ist der Ziehgriff weder zu sehen noch zu
    // erreichen. `display: none` an `#sidebar` nimmt ihn schon mit; `hidden`
    // sieht auch die Fokus-Falle (dieselbe Begruendung wie fuer `sidebarHandle`
    // oben: gerufen wird erst nach dem Mount).
    sidebarResize.setHidden(collapsed);
    // `#app`s Spalten aendern sich mit der Klasse: neue Rasterflaeche, also
    // neue Lage und ein Refit ueber den EINEN entprellten Pfad
    // (`GridHandle.refit`).
    gridHandle?.refit();
    workspaceSync.changed();
  }

  function toggleSidebar(): void {
    setSidebarCollapsed(!sidebarCollapsed);
  }

  function focusSidebar(): void {
    // UNBEDINGT und ZUERST, nicht nur ueber den Einklappweg unten: bei einer
    // bereits ausgeklappten Seitenleiste lief `setSidebarCollapsed` gar nicht,
    // das Menue blieb offen stehen -- und der Fokus sprang darunter auf die
    // erste Hostzeile. Ein folgendes Escape erreichte dann `onMenuKeyDown`
    // nicht (der haengt am Menue) und lief bis `onMaximizedEscapeKeydown`
    // durch, das die maximierte Kachel zurueckholte. Genau die Regression,
    // gegen die Entwurf §1.5 geschrieben ist.
    //
    // `closeMenu()` ist idempotent und stellt den Fokus NICHT wieder her
    // (`closeMenu(false)` im Handle) -- der Zugriff unten bleibt also der,
    // der den Fokus setzt.
    sidebarHandle.closeMenu();
    // Eine ausgeblendete Seitenleiste kann keinen Fokus tragen -- erst
    // wieder einblenden, dann hineinfokussieren (ein Nutzer, der
    // Ctrl+Shift+E drueckt, will offensichtlich beides).
    if (sidebarCollapsed) setSidebarCollapsed(false);
    // Ctrl+Shift+E meint ausdruecklich die Hostliste (Entwurf §1.5), darum
    // ZUERST `.sb-list` (ihr aktueller Rovingpunkt, siehe sidebar.ts).
    // Ausgenommen ist die Wartet-Spur: "Sonst bleibt die Liste wie heute"
    // (Spec 2026-10-19 §7) -- der Sprung geht auf die erste Zeile AUSSERHALB
    // von ihr, und der Halt der Liste wandert nicht in die Spur. Die Spur
    // erreicht man mit Pfeil hoch und Pos1.
    // Stehen dort noch keine Hosts, faengt die ganze Seitenleiste den Fokus:
    // ihr erster Tab-Halt ist seit UI v2 §7.2 der "Add host"-Knopf
    // (`.sb-btn`) im Kopf, der dort VOR dem Zahnrad steht -- also genau das
    // gewuenschte Ziel. Der Fuss traegt seit Aufgabe 8 nur noch die
    // Versionszeile und damit ueberhaupt keinen Tab-Halt mehr; der Umweg
    // ueber ihn war ein toter Zweig (Gesamt-Review, Minor 4).
    const list = elements.sidebar.querySelector<HTMLElement>(".sb-list");
    const target =
      (list && focusableElements(list).find((node) => node.closest(".sb-lane") === null)) ??
      focusableElements(elements.sidebar)[0];
    target?.focus();
  }

  /** `session.nextWaiting`: die naechste wartende Session nach der
   * fokussierten Kachel in der Reihenfolge der Wartet-Spur (die aelteste
   * zuerst, Spec 2026-10-19 §7), sofern sie sich gerade oeffnen laesst. */
  function openNextWaitingSession(): void {
    const focusedKey = state.focusedSessionKey();
    const next = nextWaitingSession(state.hosts, focusedKey, statusCurrent, (key) => waitingSince.get(key), Date.now());
    if (!next) return;
    const host = state.hosts.find((candidate) => candidate.id === next.hostId);
    if (host && canOpenSession(host, next.name, socketOf(next))) openSidebarSession(next);
  }

  function toggleMaximizeFocusedTile(): void {
    // "Maximieren/Wiederherstellen der FOKUSSIERTEN Kachel" (Designsystem
    // §7.5) -- ohne fokussierte Kachel gibt es nichts Eindeutiges zu
    // maximieren.
    if (state.focusedTile !== null) {
      state.toggleMaximize(state.focusedTile);
      // Ebenfalls eine Benutzerabsicht: nach dem Maximieren ist diese
      // Kachel die einzige sichtbare, ihr Terminal soll die Tastendruecke
      // bekommen. Der Akkord kann aus der Seitenleiste heraus gedrueckt
      // worden sein (er haengt am `document`).
      gridHandle?.focusActiveTile();
    }
  }

  /** Escape ausserhalb des Terminals (siehe `onMaximizedEscapeKeydown` in
   * keyboard.ts): holt die maximierte Kachel zurueck; `false`, wenn keine
   * maximiert ist. */
  function restoreMaximizedTile(): boolean {
    if (state.maximizedTile === null) return false;
    state.toggleMaximize(state.maximizedTile);
    return true;
  }

  /** Die Tasten der Schriftgroesse (UX-Spec §6.7, keyboard.ts): eins groesser,
   * eins kleiner oder zurueck auf 13. Die Grenzen 10 und 20 haelt
   * `setTerminalPrefs`; die Kacheln bekommen die Groesse ueber den Abonnenten
   * oben. */
  function changeTerminalFontSize(change: FontSizeChange): void {
    const size = terminalPrefs().fontSize;
    const next = change === "reset" ? DEFAULT_TERMINAL_FONT_SIZE : change === "larger" ? size + 1 : size - 1;
    setTerminalPrefs({ fontSize: next });
  }

  /** Strg+Umschalt+P (UX-Spec §7.5). `initialQuery` steht als Vorgabe im Feld:
   * so zeigt der letzte Schritt der Zielhost-Kette von Strg+Umschalt+N das
   * Schnelloeffnen mit "New session" (§7.9). Die Eintraege sind ein
   * Schnappschuss von jetzt. */
  function showQuickOpen(initialQuery?: string): void {
    openQuickOpen({
      openDialog,
      items: quickOpenItems(state, quickOpenLabels()),
      initialQuery,
      onRun: runQuickOpenItem,
    });
  }

  /** Jeder Eintrag nimmt den bestehenden Weg (§7.5): eine
   * Session wie der Klick auf ihre Zeile in der Seitenleiste, samt
   * Kachelzuweisung; "Connect" wie der Umschalter der Seitenleiste, deren
   * Passwort- oder Passphrasefeld dort erscheint -- eingeklappt klappt sie dafuer
   * auf (`connectAndFocusNotice`); "New session" derselbe Dialog wie ihr Knopf;
   * die Aktionen wie Strg+, und Strg+Umschalt+B. Strg+Enter und Strg+Klick
   * ersetzen mit einer Session die fokussierte Kachel (Spec 2026-10-19 §5.2).
   * Den Dialog hat `openQuickOpen` vorher geschlossen. */
  function runQuickOpenItem(item: QuickOpenItem, request: { replace: boolean }): void {
    switch (item.kind) {
      case "session":
        openSessionFromSidebar(item.hostId, item.name, item.socket ? { ...request, socket: item.socket } : request);
        return;
      case "connect": {
        // Die Liste stammt vom Oeffnen. Ist der Host inzwischen verbunden (etwa
        // durch den Start) oder verbindet er gerade, bietet der Umschalter der
        // Seitenleiste kein "Connect" mehr an: ein Aufbau risse sonst eine
        // lebende Verbindung ab oder beendete eine laufende Reihe.
        const host = state.hosts.find((candidate) => candidate.id === item.hostId);
        if (host && host.state !== "connected" && host.state !== "connecting") void connectAndFocusNotice(item.hostId);
        return;
      }
      case "newSession":
        onNewSession(item.hostId);
        return;
      case "action":
        switch (item.id) {
          case "settings":
            onOpenSettings();
            return;
          case "toggleSidebar":
            toggleSidebar();
            return;
        }
    }
  }

  // Abgemeldet wird ueber `stopBackgroundWork` unten. In der App laeuft
  // `main()` nur einmal, aber in Tests lebt `document` ueber viele Laeufe, und
  // der Escape-Lauscher uebergeht ein Ereignis mit `defaultPrevented` (UX-Spec
  // §8.2): der Lauscher eines frueheren Laufs mit noch maximierter Kachel holte
  // sie zuerst zurueck, riefe `preventDefault()` und nahm dem aktuellen Lauf
  // das Escape weg.
  const uninstallKeyboard = installKeyboard({
    newSession: newSessionOnTargetHost,
    toggleSidebar,
    focusSidebar,
    toggleMaximize: toggleMaximizeFocusedTile,
    moveTile: (delta) => gridHandle?.moveFocusedTile(delta),
    selectTile: focusTileByNumber,
    prevSession: () => focusAdjacentTileByUser(-1),
    nextSession: () => focusAdjacentTileByUser(1),
    nextWaiting: openNextWaitingSession,
    openSettings: onOpenSettings,
    openQuickOpen: () => showQuickOpen(),
    changeFontSize: changeTerminalFontSize,
    restoreMaximized: restoreMaximizedTile,
    isDialogOpen: dialogs.isDialogOpen,
  });

  /** Spec 2026-10-19 §5.3: neutral fuer einen Hinweis, der kein Fehler ist. */
  type BannerTone = "danger" | "neutral";

  /** Banner fuer `GridOptions.onTerminalError` und fehlgeschlagene
   * `create_session`-Aufrufe (`createSession` oben) -- beide sind nicht
   * host- oder kachel-spezifisch adressierbar (`onTerminalError` liefert
   * keine Kachel-ID), ein globaler, wegklickbarer Hinweis ist deshalb der
   * einzige Ort, der beide ohne Verrenkung traegt.
   * Dasselbe Muster wie `host-key-prompt.ts`s `persistFailureBanner` --
   * eigener, von `elements` unabhaengiger Knoten direkt in `document.body`.
   *
   * UX-Spec §10: der Satz sagt, was passiert ist und was zu tun ist; der
   * Rohtext des Backends (`details`) steht nur hinter "Copy details", mit der
   * Versionszeile davor wie bei "Copy diagnostics". Ohne Rohtext fehlt der
   * Knopf. */
  function mountGlobalErrorBanner(): (message: string, details?: string, tone?: BannerTone) => void {
    const banner = document.createElement("div");
    banner.className = "global-error-banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;

    const text = document.createElement("span");
    banner.appendChild(text);

    let currentDetails: string | null = null;
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "btn btn--text btn--row";
    copyButton.textContent = t("app.copyDetails");
    copyButton.hidden = true;
    copyButton.addEventListener("click", () => {
      // Best effort wie "Copy diagnostics": ohne Zwischenablage geschieht nichts.
      if (currentDetails === null || !navigator.clipboard) return;
      void navigator.clipboard.writeText(`${appVersionLine()}\n${currentDetails}`).catch(() => {});
    });
    banner.appendChild(copyButton);

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    // Zeilenknopf im Streifen (Spec 11.2): sekundaer, 26 Pixel hoch -- ein
    // 32er Knopf sprengte den schmalen Bannerstreifen.
    dismissButton.className = "btn btn--secondary btn--row";
    dismissButton.textContent = t("app.dismiss");
    banner.appendChild(dismissButton);

    document.body.appendChild(banner);

    // Optik-Runde vom 24.10.: der neutrale Hinweis (die Grenze, Spec
    // 2026-10-19 §5.3) verdeckte bei 9 Kacheln die Koepfe der ersten beiden,
    // bis der Nutzer ihn schloss. Er schliesst sich jetzt nach
    // `NEUTRAL_NOTICE_MS` selbst und beim naechsten Druck in eine Kachel. Ein
    // Fehler bleibt stehen, bis der Nutzer ihn schliesst.
    let neutral = false;
    let hideTimer: number | undefined;
    const hide = () => {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
      banner.hidden = true;
    };
    dismissButton.addEventListener("click", hide);
    elements.grid.addEventListener(
      "pointerdown",
      (event) => {
        if (neutral && !banner.hidden && event.target instanceof Element && event.target.closest(".tile")) hide();
      },
      true,
    );

    return (message: string, details?: string, tone: BannerTone = "danger") => {
      text.textContent = message;
      currentDetails = details ?? null;
      copyButton.hidden = currentDetails === null;
      neutral = tone === "neutral";
      banner.classList.toggle("global-error-banner--neutral", neutral);
      window.clearTimeout(hideTimer);
      hideTimer = neutral ? window.setTimeout(hide, NEUTRAL_NOTICE_MS) : undefined;
      banner.hidden = false;
    };
  }

  const showGlobalError = mountGlobalErrorBanner();

  // Global, unabhaengig von der aktuell sichtbaren Ansicht -- ein
  // `connect_host`-Aufruf (aus Erststart, "Add host" oder der Seitenleiste)
  // kann jederzeit eine TOFU-Rueckfrage ausloesen, die den SSH-Handshake auf
  // der Rust-Seite blockiert (siehe `commands::TofuPolicy`).
  const hostKeyPromptHandle = mountHostKeyPrompt(elements.hostKeyPromptRoot, {
    // Legt die Dialogebene und `#app` still, solange eine Rueckfrage steht;
    // die volle Begruendung steht an `hostKeyPromptOpen` und
    // `setHostKeyPromptOpen` in `views/dialog.ts`.
    onOpenChange: (open) => dialogs.setHostKeyPromptOpen(open),
    // Gelesen von `connectHost` (siehe `expiredHostKeyPrompts`).
    onExpired: ({ host, port }) => expiredHostKeyPrompts.add(`${host}:${port}`),
  });

  const transportEventsReady = listen<{ host_id: string }>("terminal://transport-lost", ({ payload }) => {
    const pending = pendingRuntimeEvents.get(payload.host_id);
    if (pending) { pending.lost = true; return; }
    const host = state.hosts.find((candidate) => candidate.runtimeId === payload.host_id && candidate.state === "connected");
    if (host) markTerminalTransportLost(host);
  });
  const controlEventsReady = listen<ControlStateEventDto>("control://state", ({ payload }) => {
    const pending = pendingRuntimeEvents.get(payload.host_id);
    if (pending) {
      if (!pending.control || payload.control_generation >= pending.control.control_generation) pending.control = payload;
      return;
    }
    const host = state.hosts.find((candidate) => candidate.runtimeId === payload.host_id && candidate.state === "connected");
    if (!host) return;
    const previous = state.controlForHost(host.id);
    if (payload.control_generation < previous.generation) return;
    const attempt = controlRepairs.get(host.id);
    if (attempt && isCurrentConnection(attempt.connection) &&
      (payload.state === "ready" || payload.state === "degraded" || payload.state === "authentication_required") &&
      (attempt.generation !== undefined ? payload.control_generation === attempt.generation
        : payload.control_generation > attempt.startedGeneration)) {
      // The backend can publish a completed attempt before its IPC reply. Free
      // only that owner now so a visible Retry accepts fresh credentials.
      controlRepairs.delete(host.id);
    }
    applyControlEvent(host, payload);
    // UX-Spec §5.2: neu laden nur bei einer neuen Kontrollgeneration (nach
    // einer Reparatur), nicht bei jedem Wechsel auf ready -- das belastete
    // genau die VM, die gerade zu langsam war.
    if (payload.state === "ready" && payload.control_generation !== listedGeneration(host)) {
      void refreshSessions(host.id);
    }
  });
  const connectionListenersReady = Promise.all([hostKeyPromptHandle.ready, transportEventsReady, controlEventsReady]).then(() => {});
  void connectionListenersReady.catch(() => {});

  const sidebarHandle = mountSidebar(elements.sidebar, state, {
    onConnectHost: (hostId, secret) => void onConnectHost(hostId, secret),
    onDisconnectHost: onUserDisconnectHost,
    onEditHost,
    onRemoveHost,
    onReloadSessions,
    onRepairControl: (hostId, auth) => void onRepairControl(hostId, auth),
    onCancelControlRepair,
    onNewSession,
    onOpenSession: openSessionFromSidebar,
    onCloseSession: closeSessionTile,
    onKillSession: killSession,
    onAddHost,
    onOpenSettings,
    waitingSince: (key) => waitingSince.get(key),
  });

  // UX-Spec §7.8: der Ziehgriff am rechten Rand der Seitenleiste, hinter
  // `.sidebar` in `#sidebar` -- erst nach `mountSidebar`, das `#sidebar` beim
  // Mounten leert. Er setzt das Token `--ab-sidebar-w` an `#app`; waehrend
  // des Ziehens folgen die Kacheln der neuen Flaeche (`GridHandle.relayout`),
  // je abgeschlossener Aenderung passen sich die Terminals einmal an, und die
  // Breite geht entprellt in `[ui]`. Faellt das Fenster schmaler aus als Leiste
  // plus Raster, schreibt niemand zurueck: `minWidth` 1100 laesst dem Raster
  // auch bei 480 px Leiste genug Platz.
  const sidebarResize = mountSidebarResize(elements.sidebar, {
    target: elements.app,
    onInput: () => gridHandle?.relayout(),
    onCommit: (width) => {
      sidebarWidthChosen = true;
      gridHandle?.refit();
      uiSettingsSync.schedule("sidebar_width", width);
    },
  });

  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("online", onOnline);
  stopBackgroundWork = () => {
    backgroundStopped = true;
    uninstallKeyboard();
    offTerminalPrefs();
    // Ein ausstehender Schreibvorgang gehoert diesem Lauf; in der App laeuft
    // `main()` nur einmal, in Tests schriebe er sonst in den naechsten hinein.
    uiSettingsSync.dispose();
    workspaceSync.dispose();
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("online", onOnline);
    for (const hostId of [...pollTimers.keys()]) stopStatusPoll(hostId);
    for (const hostId of [...selfRepairs.keys()]) cancelSelfRepair(hostId);
    hostReconnects.dispose();
    // Das Raster dieses Laufs traegt die Zeitgeber des stillen
    // Wiederanhaengens (§5.5); ein spaeter feuernder Versuch montierte sonst
    // in den naechsten Lauf hinein.
    gridHandle?.dispose();
  };

  void bootstrap();

  /** Entscheidet beim Start zwischen Erststart (null Hosts) und dem Raster
   * (mindestens einer) -- die Seitenleiste ist in BEIDEN Faellen bereits
   * gemountet (Spec §11.2: "nicht in einer eigenen Vollbildansicht ...
   * damit die Seitenleiste sichtbar bleibt"). Danach stellt er den
   * Arbeitsplatz her (UX-Spec §7.2). */
  async function bootstrap(): Promise<void> {
    const storedSettings = loadStoredSettings();
    try {
      await connectionListenersReady;
    } catch {
      showGlobalError(t("hostKeyPrompt.listenerError"));
      return;
    }

    let entries: HostEntry[];
    try {
      entries = await invoke<HostEntry[]>("list_hosts");
    } catch (error) {
      showHostsLoadError(String(error));
      return;
    }

    for (const entry of entries) state.upsertHost(hostFromEntry(entry));

    if (entries.length === 0) {
      showFirstRunInGrid();
    } else {
      ensureGridMounted();
    }

    // Erst wenn Hosts UND gespeicherte Einstellungen da sind: Layout,
    // Seitenleiste und aufgeklappte Hosts auf einmal, dann die Hosts aus
    // `connected`, hoechstens drei zugleich. Ohne Antwort startet die App leer
    // und schreibt den Arbeitsplatz in diesem Lauf nie.
    const stored = await storedSettings;
    if (!stored) return;
    void connectInOrder(workspaceSync.start(stored.workspace, stored.restore), connectRestoredHost);
  }
}

/** Startet `main()` und macht ein Scheitern SICHTBAR.
 *
 * Zwei Fehler steckten hier, beide unsichtbar fuer die Testsuite, weil
 * `main.test.ts` `main()` direkt aufruft und diese Zeilen nie ausfuehrt:
 *
 * 1. `addEventListener("DOMContentLoaded", main)` allein genuegt nicht.
 *    Laeuft das Modul erst, NACHDEM das Ereignis gefeuert hat -- was bei
 *    Vite passiert, sobald es Abhaengigkeiten neu buendelt und die Seite
 *    dabei neu laedt --, wird `main` nie gerufen. `index.html` traegt seit
 *    dem Umbau keine statischen Kindelemente mehr, also bleibt exakt ein
 *    schwarzes Fenster zurueck: kein Fehler, kein Inhalt, angewandtes CSS.
 *    `document.readyState` deckt beide Reihenfolgen ab.
 *
 * 2. Ohne Auffangnetz endet JEDER Startfehler genauso -- schwarz und
 *    stumm, mit der Ursache in einer Konsole, die niemand offen hat. Die
 *    Meldung gehoert ins Fenster.
 */
function reportFatalStartupError(error: unknown): void {
  // Bewusst ohne `en.json` und ohne `--ab-*`-Tokens: dieser Pfad laeuft
  // gerade WEIL etwas beim Start nicht funktioniert hat -- ein fehlender
  // Uebersetzungsschluessel oder ein nicht geladenes Stylesheet duerfen
  // die Fehleranzeige nicht ihrerseits verschlucken.
  const box = document.createElement("pre");
  box.setAttribute("role", "alert");
  box.style.cssText =
    "margin:0;padding:16px;font:13px/1.5 Consolas,monospace;" +
    "color:#FF7B72;background:#0B0D10;white-space:pre-wrap;min-height:100vh";
  box.textContent = `aidevbridge could not start.\n\n${String(error)}\n\n${
    error instanceof Error && error.stack ? error.stack : ""
  }`;
  document.body.replaceChildren(box);
}

function startApp(): void {
  try {
    main();
  } catch (error) {
    reportFatalStartupError(error);
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
