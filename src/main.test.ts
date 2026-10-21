// Gegenprobe fuer die drei Review-Befunde (Important 1-3) aus der
// Abschlussrunde von Shell-Task 11 -- main.ts hatte bis dahin keine
// automatisierte Verdeckung. `main()` ist fuer diese Datei exportiert, sonst
// bliebe die gesamte Verdrahtung (Zwei-ID-Versoehnung, das neue "Disconnect
// waehrend connecting" und die Fokus-Falle) unerreichbar.
//
// Die Important-1-bis-3-Faelle brauchen KEIN xterm-Mock: keiner von ihnen
// erreicht `grid.ts::reconcile()`s Terminal-Mount-Pfad (dafuer muesste eine
// Session tatsaechlich geoeffnet werden) -- `mountGrid` selbst mountet ohne
// zugewiesene Session kein `TerminalHandle`. Der Task-12-Block weiter unten
// ("Tastatur") oeffnet dagegen absichtlich Sessions (Badge/Chord-
// Gegenprobe) und mockt `./terminal` dafuer nach demselben Muster wie
// `views/grid.test.ts` -- der Mock gilt fuer die GESAMTE Datei (`vi.mock`
// wird gehoisted), aendert an den Important-1-bis-3-Faellen aber nichts:
// die rufen `mountTerminal` ohnehin nie auf.

// `node:fs`/`node:path`/`process` sind Node-Globals ohne Typdeklaration in
// diesem browserorientierten Projekt -- dasselbe Muster wie in
// `terminal.test.ts` (dort zuerst eingefuehrt, siehe dessen Kommentar).
// @ts-expect-error 'node:fs' ist ein Node-Global, siehe Kommentar oben
import { readFileSync } from "node:fs";
// @ts-expect-error 'node:path' ist ein Node-Global, siehe Kommentar oben
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
// EIN geteiltes Fensterobjekt statt eines frischen je Aufruf: sonst waeren die
// Aufrufe von `requestUserAttention` (Taskleiste blinkt) nicht zaehlbar.
const windowHoisted = vi.hoisted(() => ({
  setTitle: vi.fn((_title: string) => Promise.resolve()),
  requestUserAttention: vi.fn((_type: unknown) => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowHoisted,
  UserAttentionType: { Critical: 1, Informational: 2 },
}));
const terminalHoisted = vi.hoisted(() => ({
  // Nach `${hostId}/${name}` abgelegt, nicht "letzter Aufruf gewinnt":
  // die Tests unten oeffnen mehrere Sessions und muessen GENAU eine davon
  // verlieren lassen. Dieselbe Ueberlegung wie bei `listeners` weiter unten.
  lostByKey: new Map<string, () => void>(),
  /** Wie `lostByKey`, aber fuer den Rueckruf, den AUSSCHLIESSLICH ein
   * abgelehntes `open_terminal` ausloest. Zwei getrennte Karten, weil genau
   * ihre Trennung die Zusage ist: ein Fehler aus der Zwischenablage oder aus
   * `resize_terminal` darf hier NICHT landen (geprueft wird das in
   * `terminal.test.ts`, wo das echte `mountTerminal` laeuft -- hier
   * entschiede der Mock, und der Test bewiese nur, dass er sich selbst
   * richtig aufgerufen hat). */
  openFailedByKey: new Map<string, () => void>(),
  /** Der GENERISCHE Fehlerkanal (`onError`), ueber den `terminal.ts` unter
   * anderem eine abgelehnte `open_terminal`-Antwort meldet -- mit der Art des
   * Fehlers und dem Rohtext (UX-Spec §6.9). Getrennt von `openFailedByKey`:
   * das eine faerbt die Kachel, das andere schreibt das Banner -- B1 hat sie
   * ausdruecklich auseinandergezogen. */
  errorByKey: new Map<string, (error: { kind: string; detail: string }) => void>(),
  /** Wie oft `focus()` auf dem Handle dieser Session gerufen wurde. Unter
   * jsdom bewegt ein gemocktes Terminal keinen echten Dokumentfokus (es hat
   * gar kein xterm-Hilfstextfeld) -- beobachtbar ist deshalb, OB das Raster
   * den Fokus an sich zieht, nicht wo er danach sichtbar sitzt. Genau das
   * ist auch die Frage, um die es geht. */
  focusCountByKey: new Map<string, number>(),
  /** UX-Spec §6.7: jede Schriftgroesse, die das Raster an diese Kachel
   * weiterreicht (`setFontSize`), in Reihenfolge. */
  fontSizesByKey: new Map<string, number[]>(),
  /** Wie oft das Raster fuer diese Session ein Terminal gebaut hat -- ein
   * Umbenennen des Hosts darf keines neu bauen (UX-Spec §7.7). */
  mountsByKey: new Map<string, number>(),
  /** Wie oft das Raster das Terminal dieser Session neu einpassen liess
   * (`refit()`) -- der Ziehgriff der Seitenleiste tut das genau einmal beim
   * Loslassen (UX-Spec §7.8). */
  refitCountByKey: new Map<string, number>(),
  /** Legt `focus()` den Dokumentfokus wirklich in die Kachel, wie xterm sein
   * Hilfstextfeld fokussiert? Nur fuer die Tests des Kachelziels (UX-Spec
   * §7.4, A-03): genau dieses `focusin` war der Fehler. Sonst zaehlt der Mock
   * nur, wie die uebrigen Tests ihn kennen. */
  focusMovesDom: false,
}));

vi.mock("./terminal", () => ({
  mountTerminal: (
    el: unknown,
    hostId: string,
    name: string,
    onError: ((error: { kind: string; detail: string }) => void) | undefined,
    opts?: { onConnectionLost?: () => void; onOpenFailed?: () => void },
  ) => {
    const key = `${hostId}/${name}`;
    // Nur Kacheln des laufenden Tests (dieselbe Wache wie bei `focus()` unten).
    if ((el as HTMLElement | null)?.isConnected) {
      terminalHoisted.mountsByKey.set(key, (terminalHoisted.mountsByKey.get(key) ?? 0) + 1);
    }
    if (onError) terminalHoisted.errorByKey.set(key, onError);
    if (opts?.onConnectionLost) {
      terminalHoisted.lostByKey.set(key, opts.onConnectionLost);
    }
    if (opts?.onOpenFailed) {
      terminalHoisted.openFailedByKey.set(key, opts.onOpenFailed);
    }
    return {
      dispose: vi.fn(),
      refit: () => {
        // Dieselbe Wache wie bei `focus()` unten: nur Kacheln des laufenden Tests.
        if (!(el as HTMLElement | null)?.isConnected) return;
        terminalHoisted.refitCountByKey.set(key, (terminalHoisted.refitCountByKey.get(key) ?? 0) + 1);
      },
      setTheme: () => {},
      setInputLocked: () => {},
      // Spec 2026-10-19 §8.1 (Schritt 3): das Raster verbirgt die Kacheln
      // hinter einer maximierten, statt sie zu entsorgen.
      setHidden: () => {},
      setFontSize: (size: number) => {
        // Dieselbe Wache wie bei `focus()` unten: nur Kacheln des laufenden Tests.
        if (!(el as HTMLElement | null)?.isConnected) return;
        terminalHoisted.fontSizesByKey.set(key, [...(terminalHoisted.fontSizesByKey.get(key) ?? []), size]);
      },
      focus: () => {
        // NUR Kacheln des laufenden Tests zaehlen. `main()` haengt seinen
        // Akkord-Handler an `document`, und `document` ueberlebt den Test
        // (nur `document.body.innerHTML` wird geleert) -- ein `Ctrl+Shift+2`
        // erreicht deshalb AUCH die Handler aller frueheren `main()`-Laeufe
        // dieser Datei. Deren Kacheln haengen aber in einem abgehaengten
        // Baum; `isConnected` trennt sie sauber ab. Ohne diese Wache haetten
        // die Zaehlungen unten von der Reihenfolge der Tests abgehangen.
        if (!(el as HTMLElement | null)?.isConnected) return;
        terminalHoisted.focusCountByKey.set(key, (terminalHoisted.focusCountByKey.get(key) ?? 0) + 1);
        if (!terminalHoisted.focusMovesDom) return;
        const container = el as HTMLElement;
        let helper = container.querySelector("textarea");
        if (!helper) {
          helper = document.createElement("textarea");
          container.appendChild(helper);
        }
        helper.focus();
      },
    };
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { focusableElements, main, stopSessionStatusPoll } from "./main";
import { MAX_TILES_PER_HOST } from "./state/tile-assignment";
import { DEFAULT_TERMINAL_PREFS, setTerminalPrefs, terminalPrefs } from "./terminal-prefs";
import { appVersionLine } from "./version";
import type { UiSettingsDto, WorkspaceDto } from "./views/types";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

interface HostEntryLike {
  id: string;
  label: string;
  hostname: string;
  user: string;
  port: number;
  tmux_socket: string;
  history_limit: number;
  key_path: string | null;
  auth_kind: "key" | "agent" | "password";
}

function hostEntry(overrides: Partial<HostEntryLike> = {}): HostEntryLike {
  return {
    id: "s1",
    label: "h1",
    hostname: "10.0.0.1",
    user: "m",
    port: 22,
    tmux_socket: "agentbridge",
    history_limit: 10000,
    key_path: null,
    auth_kind: "agent",
    ...overrides,
  };
}

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div id="sidebar"></div>
      <div id="grid"></div>
    </div>
    <div id="host-key-prompt-root"></div>
    <div id="dialog-root"></div>
  `;
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** Nach EVENTNAMEN abgelegte Handler, dieselbe Technik wie in
 * `host-key-prompt.test.ts` (siehe dortigen Kommentar): `mountHostKeyPrompt`
 * registriert ZWEI `listen()`-Aufrufe, eine "letzter Aufruf gewinnt"-
 * Zuordnung wuerde den ersten stillschweigend verlieren. Ohne diese
 * Weiterleitung koennte diese Datei ueberhaupt keine `hostkey://request`
 * ausloesen -- die vorige Vorgabe (`() => Promise.resolve(vi.fn())`) warf
 * die Handler weg. */
const listeners = new Map<string, (event: { payload: unknown }) => void>();

interface HostKeyRequestLike {
  request_id: number;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  expires_at_unix_ms: number;
  known_key_types: string[];
}

const SAMPLE_FINGERPRINT = "SHA256:cd4xJCbJywoyJ+atpjT31411tIy9KUZajEpme8VfVOc";

function hostKeyRequest(overrides: Partial<HostKeyRequestLike> = {}): HostKeyRequestLike {
  return {
    request_id: 1,
    host: "192.0.2.10",
    port: 22,
    key_type: "ssh-ed25519",
    fingerprint: SAMPLE_FINGERPRINT,
    // Weit in der Zukunft -- der Verfall selbst ist Sache von
    // `host-key-prompt.test.ts`, hier geht es um die Ueberlagerung.
    expires_at_unix_ms: Date.now() + 60_000,
    // Standardmaessig leer -- der Hinweis auf einen anderen bereits
    // bekannten Typ ist Sache von `host-key-prompt.test.ts`, hier geht es
    // um die Ueberlagerung.
    known_key_types: [],
    ...overrides,
  };
}

function emitTransportLost(runtimeId: string): void {
  listeners.get("terminal://transport-lost")?.({ payload: { host_id: runtimeId } });
}

function emitControlState(runtimeId: string, generation: number, state: string, message?: string): void {
  listeners.get("control://state")?.({ payload: { host_id: runtimeId, control_generation: generation, state, message } });
}

function emitHostKeyRequest(payload: HostKeyRequestLike): void {
  listeners.get("hostkey://request")?.({ payload });
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  listeners.clear();
  windowHoisted.setTitle.mockClear();
  windowHoisted.requestUserAttention.mockClear();
  // Sonst traegt ein Test die Verlusthandler des vorigen (der Mock oben
  // haelt sie ueber die gesamte Datei).
  terminalHoisted.lostByKey.clear();
  terminalHoisted.openFailedByKey.clear();
  terminalHoisted.errorByKey.clear();
  terminalHoisted.focusCountByKey.clear();
  terminalHoisted.fontSizesByKey.clear();
  terminalHoisted.mountsByKey.clear();
  terminalHoisted.refitCountByKey.clear();
  terminalHoisted.focusMovesDom = false;
  // Modulzustand (`terminal-prefs.ts`): ein Test, der die Schrift vergroessert
  // oder einen Schalter umlegt, darf den naechsten nicht mitnehmen.
  setTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS });
  // Eine aufloesende Abmeldefunktion (main.ts haengt `mountHostKeyPrompt`
  // unbedingt ein) UND der Handler bleibt erreichbar, siehe `listeners`.
  listenMock.mockImplementation((eventName, handler) => {
    listeners.set(eventName, handler as (event: { payload: unknown }) => void);
    return Promise.resolve(vi.fn());
  });
  setupDom();
  // Der Standard-Mock beantwortet `ui_settings` mit `undefined`, und
  // `loadStoredTheme` warnt laut Spec genau dann -- ohne diesen Stummschalter
  // schriebe jeder bestehende Test (der `ui_settings` nie erwaehnt) eine
  // Warnung ins Testprotokoll.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  stopSessionStatusPoll();
  document.body.innerHTML = "";
  vi.restoreAllMocks(); // sonst stapelt sich je Test ein weiterer Spy auf console.warn
  localStorage.clear();
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.base;
});

// --- DOM-Helfer, dieselbe Abfragestruktur wie sidebar.ts/host-form.ts sie
// erzeugen (siehe deren Quelltexte) -- keine Kopie ihrer Bezeichner, nur
// ihrer bereits getesteten Klassennamen. ---

function hostRow(label: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>("#sidebar .row-host")).find(
    (r) => r.querySelector(".row-label")?.textContent === label,
  );
  if (!row) throw new Error(`host row not found: ${label}`);
  return row;
}

function hostIndicatorClass(label: string): string {
  return hostRow(label).querySelector(".row-meta .ind")?.className ?? "";
}

/** Ein Knopf der Hostleiste nach seinem zugaenglichen Namen: Icon-Knoepfe
 * tragen ihn in `aria-label` ("New session") oder als versteckten Text
 * ("Reload sessions"), die uebrigen als sichtbaren Text. */
function hostActionButton(label: string, actionText: string): HTMLButtonElement {
  const block = hostRow(label).parentElement as HTMLElement;
  const button = Array.from(block.querySelectorAll<HTMLButtonElement>(".host-action-btn")).find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === actionText,
  );
  if (!button) throw new Error(`action "${actionText}" not found for host "${label}"`);
  return button;
}

/** Der `⋯`-Knopf einer Hostzeile (Entwurf §1.2). */
function hostMenuButton(label: string): HTMLButtonElement {
  const block = hostRow(label).parentElement as HTMLElement;
  const button = block.querySelector<HTMLButtonElement>(".host-menu-btn");
  if (!button) throw new Error(`host menu button not found for "${label}"`);
  return button;
}

/** Oeffnet das Hostmenue und liefert den Eintrag mit dieser Beschriftung.
 * "Edit…" und "Remove…" liegen seit dem Aufklappmenue nicht mehr flach in der
 * Knopfleiste -- `hostActionButton` faende sie dort nicht mehr (und wuerfe,
 * statt still danebenzugreifen). "Reload sessions" ist seit UX-Spec §7.8
 * wieder ein Knopf der Leiste (Icon mit verstecktem Text), also ein Fall fuer
 * `hostActionButton`. */
function hostMenuItem(label: string, itemText: string): HTMLElement {
  hostMenuButton(label).click();
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (i) => i.textContent === itemText,
  );
  if (!item) throw new Error(`menu item "${itemText}" not found for host "${label}"`);
  return item;
}

function dialogHostFormView(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".dialog-body .host-form-view");
  if (!el) throw new Error("host-form is not mounted in the dialog overlay");
  return el;
}

function fillHostForm(view: HTMLElement, hostname: string, user: string, port: string): void {
  (view.querySelector("input[name=hostname]") as HTMLInputElement).value = hostname;
  (view.querySelector("input[name=user]") as HTMLInputElement).value = user;
  (view.querySelector("input[name=port]") as HTMLInputElement).value = port;
}

function chooseAgentAuth(view: HTMLElement): void {
  const select = view.querySelector("select[name=auth]") as HTMLSelectElement;
  select.value = "agent";
  select.dispatchEvent(new Event("change"));
}

function submitDialogForm(): void {
  document
    .querySelector(".dialog-body form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function fireKeydown(target: EventTarget, key: string, shiftKey = false): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
}

describe("main: getrennte Kontrollgesundheit und Inventar", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function calls(command: string) { return invokeMock.mock.calls.filter(([name]) => name === command); }
  function notice() { return hostRow("h1").parentElement!.querySelector<HTMLElement>(".control-notice"); }
  /** Die Faelle unten pruefen die Reparatur VON HAND. Key- und Agent-Hosts
   * reparieren seit UX-Spec §5.3 selbst und zeigen dabei keinen Kasten; der
   * Weg von Hand bleibt der der Passwort-Hosts. */
  const PASSWORD_HOSTS: Partial<HostEntryLike> = { auth_kind: "password" };
  async function repairForm(): Promise<HTMLElement> {
    Array.from(notice()!.querySelectorAll("button")).find((button) => button.textContent === "Restore updates")!.click();
    await flush();
    return notice()!.querySelector<HTMLElement>(".control-repair-form")!;
  }
  function submitRepair(form: HTMLElement, password = "fresh-only") {
    const select = form.querySelector<HTMLSelectElement>("select[name=auth]")!;
    select.value = "password";
    select.dispatchEvent(new Event("change"));
    form.querySelector<HTMLInputElement>("input[name=password]")!.value = password;
    form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it.each(["old legacy error", { code: "control_unavailable", message: "old structured error", control_generation: 0 }])(
    "ignoriert eine alte Listenablehnung nach Controlwechsel vor der frischen Antwort (%j)", async (failure) => {
      await setupTwoHostsThreeSessions();
      expandHost("h1");
      const old = deferred<string[]>();
      const current = deferred<string[]>();
      const previous = invokeMock.getMockImplementation();
      let lists = 0;
      invokeMock.mockImplementation(((command: string, args: never) => {
        if (command === "list_sessions") return ++lists === 1 ? old.promise : current.promise;
        return previous?.(command, args) ?? Promise.resolve();
      }) as typeof invoke);
      hostActionButton("h1", "Reload sessions").click();
      await flush();
      emitControlState("r-h1", 1, "reconnecting");
      emitControlState("r-h1", 1, "ready");
      await flush();
      old.reject(failure);
      await flush(20);
      expect(document.querySelector(".session-list-notice")).toBeNull();
      expect(() => sessionButton("h1", "s1")).not.toThrow();
      current.resolve(["s1", "new-current"]);
      await flush(20);
      expect(() => sessionButton("h1", "new-current")).not.toThrow();
      expect(hostIndicatorClass("h1")).toContain("ind-on");
    },
  );

  it.each(["create", "kill"] as const)("holt nach einem durch Reparatur ueberholten %s-Listenabschluss einmal lesend nach", async (mutation) => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    const oldTail = deferred<string[]>();
    const previous = invokeMock.getMockImplementation();
    let lists = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") return ++lists === 1 ? oldTail.promise : Promise.resolve(["s2", "fresh"]);
      if (command === "create_session") return Promise.resolve("fresh");
      if (command === "kill_session") return Promise.resolve();
      return previous?.(command, args) ?? Promise.resolve();
    }) as typeof invoke);
    if (mutation === "create") {
      hostActionButton("h1", "New session").click();
      await flush();
      const panel = document.querySelector(".dialog-panel")!;
      panel.querySelector<HTMLInputElement>("input[name=sessionName]")!.value = "fresh";
      Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Create session")!.click();
    } else {
      const row = () => sessionButton("h1", "s1").closest(".sb-session-row")!;
      row().querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
      row().querySelector<HTMLButtonElement>(".session-confirm-kill .host-confirm-btn-danger")!.click();
    }
    await flush(20);
    expect(lists).toBe(1);
    emitControlState("r-h1", 1, "reconnecting");
    emitControlState("r-h1", 1, "ready");
    await flush(20);
    expect(lists).toBe(2);
    expect(() => sessionButton("h1", "fresh")).toThrow();
    oldTail.resolve(["s1", "obsolete"]);
    await flush(30);
    expect(lists).toBe(3);
    expect(() => sessionButton("h1", "fresh")).not.toThrow();
    expect(() => sessionButton("h1", "obsolete")).toThrow();
    expect(calls(`${mutation}_session`)).toHaveLength(1);
    expect(document.querySelector(".session-list-notice")).toBeNull();
  });

  it.each(["fresh-only", ""])("reserviert Reparatur erst beim Auth-Submit, bewahrt die Passwortmethode (%j) und heilt nur durch ready", async (password) => {
    await setupTwoHostsThreeSessions(PASSWORD_HOSTS);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "begin_control_repair") return Promise.resolve(1);
      if (command === "repair_control") return Promise.resolve();
      return previous?.(command, args) ?? Promise.resolve();
    }) as typeof invoke);
    emitControlState("r-h1", 0, "degraded", "control query stopped");
    const form = await repairForm();
    expect(calls("begin_control_repair")).toHaveLength(0);
    expect(document.getElementById("app")!.inert).not.toBe(true);
    expect(document.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(true);
    expect(tileTitles()).toContain("s1");
    const connects = calls("connect_host").length;
    submitRepair(form, password);
    await flush(20);
    expect(calls("begin_control_repair")).toEqual([["begin_control_repair", { hostId: "r-h1" }]]);
    expect(calls("repair_control")).toEqual([["repair_control", {
      hostId: "r-h1", controlGeneration: 1, auth: { key_path: null, passphrase: null, password },
    }]]);
    expect(notice()?.textContent).toContain("Reconnecting live updates…");
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush(20);
    // Der Host lebt: die Kachel haengt sich still neu an (UX-Spec §5.5),
    // unabhaengig von der Reparatur der Steuerung.
    const tileQuiet = () => document.querySelector<HTMLElement>(".tile-quiet")!;
    expect(document.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(true);
    expect(tileQuiet().hidden).toBe(false);
    emitControlState("r-h1", 1, "ready");
    await flush(20);
    expect(notice()).toBeNull();
    expect(tileTitles()).toContain("s1");
    // Das ready der Steuerung beendet das Wiederanhaengen der Kachel nicht.
    expect(tileQuiet().hidden).toBe(false);
    expect(calls("connect_host")).toHaveLength(connects);
    expect(calls("disconnect_host")).toHaveLength(0);
  });

  it("cancel vor begin-Antwort beendet nur deren spaete Reservierung, nicht einen neuen Versuch", async () => {
    await setupTwoHostsThreeSessions(PASSWORD_HOSTS);
    const firstBegin = deferred<number>();
    const previous = invokeMock.getMockImplementation();
    let begins = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "begin_control_repair") return ++begins === 1 ? firstBegin.promise : Promise.resolve(2);
      if (command === "repair_control") return Promise.resolve();
      return previous?.(command, args) ?? Promise.resolve();
    }) as typeof invoke);
    emitControlState("r-h1", 0, "degraded");
    submitRepair(await repairForm(), "abandoned");
    await flush();
    Array.from(notice()!.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!.click();
    submitRepair(await repairForm(), "new-password");
    await flush(20);
    emitControlState("r-h1", 2, "ready");
    firstBegin.resolve(1);
    await flush(20);
    expect(calls("repair_control")).toHaveLength(1);
    expect(calls("repair_control")[0][1]).toEqual({ hostId: "r-h1", controlGeneration: 2, auth: { key_path: null, passphrase: null, password: "new-password" } });
    expect(calls("cancel_control_repair")).toEqual([["cancel_control_repair", { hostId: "r-h1", controlGeneration: 1 }]]);
    expect(notice()).toBeNull();
  });

  it("nimmt nach einem fruehen Authfehler frische Daten an und ignoriert die alte IPC-Ablehnung", async () => {
    await setupTwoHostsThreeSessions(PASSWORD_HOSTS);
    const oldRepair = deferred<void>();
    const previous = invokeMock.getMockImplementation();
    let begins = 0;
    let repairs = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "begin_control_repair") return Promise.resolve(++begins);
      if (command === "repair_control") return ++repairs === 1 ? oldRepair.promise : Promise.resolve();
      return previous?.(command, args) ?? Promise.resolve();
    }) as typeof invoke);
    emitControlState("r-h1", 0, "degraded");
    submitRepair(await repairForm(), "first-password");
    await flush(20);
    emitControlState("r-h1", 1, "authentication_required", "first rejected");
    submitRepair(await repairForm(), "second-password");
    await flush(20);
    expect(calls("repair_control")).toHaveLength(2);
    emitControlState("r-h1", 2, "ready");
    oldRepair.reject({ code: "auth_rejected", message: "obsolete rejection" });
    await flush(20);
    expect(notice()).toBeNull();
    expect(hostRow("h1").parentElement!.textContent).not.toContain("obsolete rejection");
    expect(calls("cancel_control_repair")).toEqual([["cancel_control_repair", { hostId: "r-h1", controlGeneration: 1 }]]);
  });

  it("behaelt einen Verlust waehrend connect_host und ignoriert spaete Events der verworfenen Runtime", async () => {
    setupSavedHost();
    const connecting = deferred<string>();
    const previous = invokeMock.getMockImplementation();
    let connects = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "begin_connect") return Promise.resolve(connects === 0 ? "r-early" : "r-next");
      if (command === "connect_host") return ++connects === 1 ? connecting.promise : Promise.resolve("r-next");
      return previous?.(command, args) ?? Promise.resolve();
    }) as typeof invoke);
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush();
    emitTransportLost("r-early");
    connecting.resolve("r-early");
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-fail");
    expect(calls("list_sessions")).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r-early" });
    hostRetryButton("h1").click();
    await flush(20);
    emitTransportLost("r-early");
    emitControlState("r-early", 100, "degraded", "old runtime");
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(notice()).toBeNull();
  });

  it("gibt beim kompletten Host-Reconnect den alten Reparaturbesitz frei", async () => {
    await setupTwoHostsThreeSessions(PASSWORD_HOSTS);
    const oldRepair = deferred<void>();
    const previous = invokeMock.getMockImplementation();
    let repairs = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "begin_control_repair") return Promise.resolve(1);
      if (command === "repair_control") return ++repairs === 1 ? oldRepair.promise : Promise.resolve();
      if (command === "begin_connect" || command === "connect_host") return Promise.resolve("r-replacement");
      return previous?.(command, args) ?? Promise.resolve();
    }) as typeof invoke);
    emitControlState("r-h1", 0, "degraded");
    submitRepair(await repairForm());
    await flush(20);
    emitTransportLost("r-h1");
    // Nach dem Abriss zuerst nur "Retry"; die lokale Pruefung fragt dann nach
    // dem Passwort, ohne einen Versuch zu starten.
    expect(hostRow("h1").parentElement!.querySelector(".host-notice input")).toBeNull();
    hostRetryButton("h1").click();
    await flush(20);
    expect(calls("cancel_control_repair")).toHaveLength(0);
    hostRow("h1").parentElement!.querySelector<HTMLInputElement>(".host-notice input[name=password]")!.value = "host-password";
    hostRetryButton("h1").click();
    await flush(20);
    expect(calls("cancel_control_repair")).toEqual([["cancel_control_repair", { hostId: "r-h1", controlGeneration: 1 }]]);
    emitControlState("r-replacement", 0, "degraded");
    submitRepair(await repairForm(), "replacement-password");
    await flush(20);
    expect(calls("repair_control")).toHaveLength(2);
    expect(calls("repair_control")[1][1]).toEqual({ hostId: "r-replacement", controlGeneration: 1,
      auth: { key_path: null, passphrase: null, password: "replacement-password" } });
    emitControlState("r-replacement", 1, "ready");
    oldRepair.reject({ code: "connect_cancelled", message: "old runtime disconnected" });
    await flush(20);
    expect(notice()).toBeNull();
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_control_repair", { hostId: "r-replacement", controlGeneration: 1 });
  });

  it.each(["transport", "control"] as const)("behaelt fruehe %s-Ereignisse bis zum Erststart-Save-Handoff", async (kind) => {
    const saved = deferred<HostEntryLike>();
    invokeMock.mockImplementation((command: string) => {
      if (["list_hosts", "list_ssh_keys", "suggest_hosts"].includes(command)) return Promise.resolve([]);
      if (command === "begin_connect" || command === "connect_host") return Promise.resolve("r-first");
      if (command === "run_preflight") return Promise.resolve({ tmux_version: "3.4", has_base64: true, socket_dir_writable: true, blocking_problem: null });
      if (command === "add_host") return saved.promise;
      if (command === "list_sessions") return Promise.resolve([]);
      return Promise.resolve();
    });
    main();
    await flush();
    const view = document.querySelector<HTMLElement>("#grid .host-form-view")!;
    fillHostForm(view, "10.0.0.1", "m", "22");
    chooseAgentAuth(view);
    view.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush(20);
    Array.from(document.querySelectorAll<HTMLButtonElement>("#grid button")).find((button) => button.textContent === "Continue")!.click();
    await flush();
    if (kind === "transport") emitTransportLost("r-first");
    else emitControlState("r-first", 0, "degraded", "early control loss");
    saved.resolve(hostEntry());
    await flush(20);
    if (kind === "transport") {
      // Der fruehe Verlust ist angekommen: der Agent-Host ist nicht verbunden
      // und wird selbst neu verbunden (UX-Spec §5.4).
      expect(hostIndicatorClass("h1")).not.toContain("ind-on");
      expect(hostRow("h1").parentElement!.querySelector(".host-quiet")?.textContent).toBe("Reconnecting…");
      expect(calls("list_sessions")).toHaveLength(0);
    } else {
      expect(hostIndicatorClass("h1")).toContain("ind-on");
      // Der fruehe Abbruch ist angekommen: der Agent-Host repariert selbst
      // (UX-Spec §5.3) und zeigt dabei nur die ruhige Zeile, keinen Kasten.
      expect(hostRow("h1").parentElement!.querySelector(".control-quiet")?.textContent).toBe("Reconnecting live updates…");
      expect(notice()).toBeNull();
    }
  });
});

describe("main: Recovery und Verbindungslebensdauer", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  function reconnectButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(".tile-lock-reconnect")!;
  }

  async function createNamed(name: string): Promise<void> {
    hostActionButton("h1", "New session").click();
    await flush();
    const panel = document.querySelector(".dialog-panel")!;
    panel.querySelector<HTMLInputElement>("input[name=sessionName]")!.value = name;
    Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Create session")!.click();
    await flush(20);
  }

  async function killNamed(name: string): Promise<void> {
    const row = () => sessionButton("h1", name).closest(".sb-session-row")!;
    row().querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    row().querySelector<HTMLButtonElement>(".session-confirm-kill .host-confirm-btn-danger")!.click();
    await flush(20);
  }

  async function disconnectOrRemove(action: "disconnect" | "remove"): Promise<void> {
    if (action === "disconnect") hostActionButton("h1", "Disconnect").click();
    else {
      hostMenuItem("h1", "Remove…").click();
      Array.from(document.querySelectorAll<HTMLButtonElement>(".host-confirm-remove button"))
        .find((button) => button.textContent === "Remove")!.click();
    }
    await flush(20);
  }

  it("baut vom gesperrten Terminal aus die Hostverbindung einmalig wieder auf", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    const connect = deferred<string>();
    const previous = invokeMock.getMockImplementation();
    let failed = true;
    let connects = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions" && failed) return Promise.reject("network down");
      if (command === "begin_connect") return Promise.resolve("r-new");
      if (command === "connect_host") {
        return ++connects === 1 ? Promise.reject({ code: "host_unreachable", message: "network down" }) : connect.promise;
      }
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    emitTransportLost("r-h1");
    await flush(20);
    // Der Agent-Host wird erst selbst neu verbunden (UX-Spec §5.4). Ein
    // Versuch von Hand beendet die Reihe; scheitert er, steht die Sperrleiste.
    expect(hostRow("h1").parentElement!.querySelector(".host-quiet")).not.toBeNull();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-fail");
    expect(reconnectButton().closest<HTMLElement>(".tile-lock")!.hidden).toBe(false);
    invokeMock.mockClear();

    reconnectButton().click();
    reconnectButton().click();
    await flush();
    expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(1);
    expect(tileTitles()).toContain("s1");

    failed = false;
    // Der Testhost liefert sonst nur Listen fuer r-h1. Die neue Verbindung
    // muss sowohl neue Kanaele als auch eine passende Sessionliste bekommen.
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") return Promise.resolve(["s1", "s2"]);
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    connect.resolve("r-new");
    await flush(30);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(terminalHoisted.lostByKey.has("r-new/s1")).toBe(true);
    expect(document.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(true);
  });

  it("haengt bei lebendem Host nur den betroffenen Terminalkanal neu an", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    const oldLost = terminalHoisted.lostByKey.get("r-h1/s1")!;
    oldLost();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    invokeMock.mockClear();
    reconnectButton().click();
    await flush();
    expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(0);
    expect(terminalHoisted.lostByKey.get("r-h1/s1")).not.toBe(oldLost);
    expect(document.querySelector<HTMLElement>(".tile-lock")!.hidden).toBe(true);
  });

  it.each(["password", "key"] as const)("fokussiert beim Kachel-Reconnect die benoetigte %s-Eingabe", async (kind) => {
    const entry = hostEntry({ auth_kind: kind, key_path: kind === "key" ? "C:/keys/id_ed25519" : null });
    let networkFailed = false;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([entry]);
      if (command === "begin_connect") return Promise.resolve(networkFailed ? "r-failed" : "r-h1");
      if (command === "connect_host") return networkFailed
        ? Promise.reject({ code: "auth_rejected", message: "Enter the key passphrase." })
        : Promise.resolve("r-h1");
      if (command === "list_sessions") return networkFailed ? Promise.reject("network down") : Promise.resolve(["s1"]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush();
    if (kind === "password") {
      document.querySelector<HTMLInputElement>(".host-notice input")!.value = "initial-secret";
      document.querySelector<HTMLButtonElement>(".host-notice button")!.click();
      await flush(20);
    }
    expandHost("h1");
    openViaSidebar("h1", "s1");
    networkFailed = true;
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    emitTransportLost("r-h1");
    await flush(20);
    invokeMock.mockClear();
    reconnectButton().click();
    await flush(20);

    const input = document.querySelector<HTMLInputElement>(".host-notice input")!;
    expect(document.activeElement).toBe(input);
    expect(input.name).toBe(kind === "password" ? "password" : "passphrase");
    expect(document.querySelector(".host-notice")!.textContent).toContain(
      kind === "password" ? "Password required" : "Enter the key passphrase.",
    );
    if (kind === "password") {
      expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(0);
    }
  });

  it("laesst einen alten Probe-Fehler kein juengeres erfolgreiches Lebenszeichen ueberschreiben", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    const probe = deferred<string[]>();
    const previous = invokeMock.getMockImplementation();
    let lists = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") return ++lists === 1 ? probe.promise : Promise.resolve(["s1", "s2", "fresh"]);
      if (command === "create_session") return Promise.resolve("fresh");
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();
    expect(lists).toBe(1);
    await createNamed("fresh");
    expect(tileTitles()).toContain("fresh");
    probe.reject("obsolete probe failed");
    await flush(30);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(tileTitles()).toContain("fresh");
  });

  it("zaehlt einen erfolgreichen Refresh auch waehrend einer Mutation als Lebenszeichen", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    const oldProbe = deferred<string[]>();
    const create = deferred<string>();
    const previous = invokeMock.getMockImplementation();
    let lists = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") {
        if (++lists === 1) return oldProbe.promise;
        if (lists === 2) return Promise.resolve(["s1", "s2", "uncommitted"]);
        return Promise.resolve(["s1", "s2", "fresh"]);
      }
      if (command === "create_session") return create.promise;
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();
    await createNamed("fresh");
    hostActionButton("h1", "Reload sessions").click();
    await flush(20);
    expect(lists).toBe(2);
    expect(() => sessionButton("h1", "uncommitted")).toThrow();

    oldProbe.reject("obsolete probe failed");
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    create.resolve("fresh");
    await flush(30);
    expect(tileTitles()).toContain("fresh");
    expect(() => sessionButton("h1", "fresh")).not.toThrow();
  });

  it("prueft eine neue Verbindung auch wenn die Probe der alten Verbindung noch haengt", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    const oldProbe = deferred<string[]>();
    const newProbe = deferred<string[]>();
    const previous = invokeMock.getMockImplementation();
    let lists = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") {
        if (++lists === 1) return oldProbe.promise;
        if (lists === 2) return Promise.resolve(["s1", "s2"]);
        return newProbe.promise;
      }
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();
    await disconnectOrRemove("disconnect");
    hostActionButton("h1", "Connect").click();
    await flush(20);
    openViaSidebar("h1", "s1");
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();
    expect(lists).toBe(3);

    oldProbe.resolve(["obsolete"]);
    await flush(20);
    // Das finally der alten Probe darf die laufende neue Probe nicht aus
    // der Deduplizierung loeschen; ein weiterer Kanalverlust teilt sie.
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();
    expect(lists).toBe(3);
    newProbe.reject("new connection failed");
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(hostRow("h1").parentElement!.textContent).toContain("new connection failed");
  });

  it.each(["success", "failure"] as const)("uebergeht nach Reconnect-%s keine spaetere Fokussierung eines anderen Hosts", async (outcome) => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    const connect = deferred<string>();
    const previous = invokeMock.getMockImplementation();
    let recovering = false;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") return recovering ? Promise.resolve(["s1", "s2"]) : Promise.reject("network down");
      if (command === "begin_connect") return Promise.resolve(recovering ? "r-new" : "r-rejected");
      if (command === "connect_host") {
        return recovering ? connect.promise : Promise.reject({ code: "auth_rejected", message: "h2 needs a password" });
      }
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    emitTransportLost("r-h1");
    await flush(20);
    hostActionButton("h2", "Disconnect").click();
    hostActionButton("h2", "Connect").click();
    await flush(20);
    recovering = true;
    reconnectButton().focus();
    reconnectButton().click();
    await flush();
    const otherInput = hostRow("h2").parentElement!.querySelector<HTMLInputElement>(".host-notice input")!;
    otherInput.focus();
    otherInput.value = "still typing";
    if (outcome === "success") connect.resolve("r-new");
    else connect.reject({ code: "auth_rejected", message: "h1 also needs a password" });
    await flush(30);

    const currentInput = hostRow("h2").parentElement!.querySelector<HTMLInputElement>(".host-notice input")!;
    expect(document.activeElement).toBe(currentInput);
    expect(currentInput.value).toBe("still typing");
    expect(terminalHoisted.focusCountByKey.get("r-new/s1") ?? 0).toBe(0);
  });

  it.each(["disconnect", "remove"] as const)("ignoriert eine Create-Listenantwort nach %s", async (action) => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    const list = deferred<string[]>();
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "create_session") return Promise.resolve("new-session");
      if (command === "list_sessions") return list.promise;
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    await createNamed("new-session");
    expect(invokeMock.mock.calls.some(([command]) => command === "create_session")).toBe(true);
    await disconnectOrRemove(action);
    list.resolve(["s1", "s2", "new-session"]);
    await flush(30);
    expect(tileTitles()).not.toContain("new-session");
    expect(document.querySelectorAll('.tile:not(.tile-empty)')).toHaveLength(0);
    if (action === "disconnect") expect(() => sessionButton("h1", "new-session")).toThrow();
  });

  it("fragt nach einem veralteten Create-Erfolg keine Liste mehr an", async () => {
    await setupTwoHostsThreeSessions();
    const create = deferred<string>();
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "create_session") return create.promise;
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    await createNamed("late");
    await disconnectOrRemove("remove");
    invokeMock.mockClear();
    create.resolve("late");
    await flush(30);
    expect(invokeMock.mock.calls.filter(([command]) => command === "list_sessions")).toHaveLength(0);
    expect(document.querySelectorAll('.tile:not(.tile-empty)')).toHaveLength(0);
  });

  it.each(["refresh", "create", "kill"] as const)("laesst eine alte %s-Liste keine neue Verbindung ueberschreiben", async (action) => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    const oldList = deferred<string[]>();
    const freshList = deferred<string[]>();
    const previous = invokeMock.getMockImplementation();
    let lists = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") return ++lists === 1 ? oldList.promise : freshList.promise;
      if (command === "create_session") return Promise.resolve("old-created");
      if (command === "kill_session") return Promise.resolve(undefined);
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    if (action === "refresh") { hostActionButton("h1", "Reload sessions").click(); await flush(); }
    if (action === "create") await createNamed("old-created");
    if (action === "kill") await killNamed("s1");
    expect(lists).toBe(1);
    await disconnectOrRemove("disconnect");
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expect(lists).toBe(2);
    // Absichtlich zuerst die alte Antwort: ohne Generationswache wuerde
    // sie auch den Versionszaehler erhoehen und die frische Liste entwerten.
    oldList.resolve(["old-created"]);
    await flush(20);
    freshList.resolve(["fresh"]);
    await flush(30);
    expect(() => sessionButton("h1", "fresh")).not.toThrow();
    expect(() => sessionButton("h1", "old-created")).toThrow();
    expect(tileTitles()).not.toContain("old-created");
  });

  it.each(["create", "kill"] as const)("zeigt keinen veralteten %s-Fehler nach Hostentfernung", async (action) => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    const mutation = deferred<string>();
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === `${action}_session`) return mutation.promise;
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    if (action === "create") await createNamed("late");
    else await killNamed("s1");
    await disconnectOrRemove("remove");
    mutation.reject("obsolete operation failed");
    await flush(30);
    expect(globalErrorText()).not.toContain("obsolete operation failed");
    expect(document.querySelectorAll('.tile:not(.tile-empty)')).toHaveLength(0);
  });

  it("laesst neue Mutationen nach Reconnect nicht auf die alte Verbindung warten", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    const oldCreate = deferred<string>();
    const previous = invokeMock.getMockImplementation();
    let creates = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "create_session") return ++creates === 1 ? oldCreate.promise : Promise.resolve("fresh");
      if (command === "list_sessions") return Promise.resolve(creates >= 2 ? ["s1", "s2", "fresh"] : ["s1", "s2"]);
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    await createNamed("old-pending");
    // Wartet hinter dem ersten Create, darf nach Reconnect ebenfalls nicht
    // mehr gestartet werden. Der neue Auftrag gehoert zur neuen Generation.
    await createNamed("old-queued");
    expect(creates).toBe(1);
    await disconnectOrRemove("disconnect");
    hostActionButton("h1", "Connect").click();
    await flush(20);
    await createNamed("fresh");
    expect(creates).toBe(2);
    expect(tileTitles()).toContain("fresh");

    oldCreate.resolve("old-pending");
    await flush(40);
    expect(creates).toBe(2);
    expect(tileTitles()).toContain("fresh");
    expect(tileTitles()).not.toContain("old-pending");
  });

  it("ordnet konkurrierende Create/Kill-Auftraege samt Liste und verwirft Refreshes dazwischen", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    const createList = deferred<string[]>();
    const previous = invokeMock.getMockImplementation();
    let lists = 0;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "create_session") return Promise.resolve("new-session");
      if (command === "kill_session") return Promise.resolve(undefined);
      if (command === "list_sessions") {
        if (++lists === 1) return createList.promise;
        // Ein manuell angeforderter Refresh sieht noch den alten Stand.
        if (lists === 2) return Promise.resolve(["s1", "s2"]);
        return Promise.resolve(["s2", "new-session"]);
      }
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    await createNamed("new-session");
    await killNamed("s1");
    expect(invokeMock.mock.calls.filter(([command]) => command === "kill_session")).toHaveLength(0);
    hostActionButton("h1", "Reload sessions").click();
    await flush(20);
    createList.resolve(["s1", "s2", "new-session"]);
    await flush(40);
    expect(invokeMock.mock.calls.filter(([command]) => command === "kill_session")).toHaveLength(1);
    expect(tileTitles()).toContain("new-session");
    expect(() => sessionButton("h1", "new-session")).not.toThrow();
    expect(() => sessionButton("h1", "s1")).toThrow();
  });
});

describe("main: atomic host persistence", () => {
  const dialogRoot = () => document.getElementById("dialog-root")!;
  it("returns focus to the saved host when a failed edit is cancelled", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "update_host") return Promise.reject("cannot replace settings");
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostMenuItem("h1", "Edit…").click();
    await flush();
    const view = dialogHostFormView();
    fillHostForm(view, "10.0.0.2", "m", "22");
    chooseAgentAuth(view);
    submitDialogForm();
    await flush(20);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialogRoot().childElementCount).toBe(0);
    // "Save" speichert zuerst (Aufgabe 18): ein
    // gescheitertes Speichern baut die Seitenleiste nicht neu, also steht der
    // `⋯`-Knopf, der den Dialog geoeffnet hat, noch -- der Fokus geht an ihn
    // zurueck. Die Zeile des Hosts ist nur der Rueckfall, wenn er fort ist.
    expect(document.activeElement).toBe(hostMenuButton("h1"));
  });

  it.each(["success", "failure"])("keeps pending edit focus inside its active controls and ignores late %s for a replacement dialog", async (outcome) => {
    let resolveUpdate!: (entry: HostEntryLike) => void;
    let rejectUpdate!: (error: string) => void;
    const pendingUpdate = new Promise<HostEntryLike>((resolve, reject) => { resolveUpdate = resolve; rejectUpdate = reject; });
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "suggest_hosts") return Promise.resolve([]);
      if (command === "update_host") return pendingUpdate;
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostMenuItem("h1", "Edit…").click();
    await flush();
    const view = dialogHostFormView();
    fillHostForm(view, "10.0.0.2", "m", "22");
    chooseAgentAuth(view);
    submitDialogForm();
    const panel = dialogRoot().querySelector<HTMLElement>(".dialog-panel")!;
    const close = panel.querySelector<HTMLButtonElement>(".dialog-close-btn")!;
    expect(focusableElements(panel)).toEqual([close]);
    close.focus();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(close);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // Waehrend des Speicherns ist nichts getrennt und nichts neu gezeichnet:
    // der Fokus geht an den `⋯`-Knopf zurueck, der den Dialog geoeffnet hat.
    expect(document.activeElement).toBe(hostMenuButton("h1"));
    document.querySelector<HTMLButtonElement>("#sidebar .sb-btn")!.click();
    await flush();
    const replacement = dialogRoot().firstElementChild;
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(panel);
    if (outcome === "success") resolveUpdate(hostEntry({ hostname: "10.0.0.2" }));
    else rejectUpdate("late save failure");
    await flush(20);
    expect(dialogRoot().firstElementChild).toBe(replacement);
    expect(hostIndicatorClass("h1")).toContain("ind-off");
  });

  it("keeps the saved host and edit draft after a failed update, then retries with the same ID", async () => {
    const entry = hostEntry();
    let listHostsCalls = 0;
    let updates = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") {
        listHostsCalls++;
        return listHostsCalls === 1 ? Promise.resolve([entry]) : Promise.reject("read failed");
      }
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "update_host") {
        return ++updates === 1 ? Promise.reject("disk full") : Promise.resolve(hostEntry({ hostname: "10.0.0.2" }));
      }
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostMenuItem("h1", "Edit…").click();
    await flush();

    const view = dialogHostFormView();
    fillHostForm(view, "10.0.0.2", "m", "22");
    chooseAgentAuth(view);
    submitDialogForm();
    await flush(20);

    expect(dialogRoot().textContent).toContain("disk full");
    expect(dialogHostFormView().querySelector<HTMLInputElement>('input[name="hostname"]')!.value).toBe("10.0.0.2");
    expect(hostRow("h1").dataset.hostId).toBe("s1");
    expect(hostIndicatorClass("h1")).toContain("ind-off");
    expect(listHostsCalls).toBe(1);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "remove_host" || cmd === "add_host")).toBe(false);

    submitDialogForm();
    await flush(20);
    expect(dialogRoot().childElementCount).toBe(0);
    expect(hostRow("h1").dataset.hostId).toBe("s1");
    hostMenuItem("h1", "Edit…").click();
    await flush();
    expect(dialogHostFormView().querySelector<HTMLInputElement>('input[name="hostname"]')!.value).toBe("10.0.0.2");
    expect(updates).toBe(2);
  });

  it("keeps a disconnected row on failed removal, blocks overlapping actions, and permits retry", async () => {
    let rejectRemove!: (error: string) => void;
    const pendingRemove = new Promise<void>((_resolve, reject) => { rejectRemove = reject; });
    let removes = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      if (command === "remove_host") return ++removes === 1 ? pendingRemove : Promise.resolve();
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    expect(tileTitles()).toContain("s1");

    hostMenuItem("h1", "Remove…").click();
    document.querySelector<HTMLButtonElement>(".host-confirm-btn-danger")!.click();
    await flush();
    expect(hostIndicatorClass("h1")).toContain("ind-off");
    expect(tileTitles()).not.toContain("s1");
    hostActionButton("h1", "Connect").click();
    hostMenuItem("h1", "Edit…").click();
    expect(dialogRoot().childElementCount).toBe(0);
    hostMenuItem("h1", "Remove…").click();
    document.querySelector<HTMLButtonElement>(".host-confirm-btn-danger")!.click();
    expect(removes).toBe(1);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "connect_host")).toHaveLength(1);

    rejectRemove("read-only settings");
    await flush(20);
    // Der Grund des Backends steht im Satz: ohne ihn wuesste niemand, warum.
    expect(document.querySelector(".global-error-banner > span")?.textContent).toBe(
      "Could not remove 'h1': read-only settings. The saved host was kept and is disconnected.",
    );
    expect(hostIndicatorClass("h1")).toContain("ind-off");
    expect(tileTitles()).not.toContain("s1");
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    hostMenuItem("h1", "Remove…").click();
    document.querySelector<HTMLButtonElement>(".host-confirm-btn-danger")!.click();
    await flush(20);
    expect(document.querySelectorAll("#sidebar .row-host")).toHaveLength(0);
    expect((document.activeElement as HTMLElement).classList.contains("sb-btn")).toBe(true);
  });

  it("rejects a late connect after failed removal even when a new connect has started", async () => {
    let resolveOld!: (id: string) => void;
    const oldConnect = new Promise<string>((resolve) => { resolveOld = resolve; });
    let connects = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "begin_connect") return Promise.resolve(connects === 0 ? "old-runtime" : "new-runtime");
      if (command === "connect_host") return ++connects === 1 ? oldConnect : Promise.resolve("new-runtime");
      if (command === "list_sessions") return Promise.resolve([]);
      if (command === "remove_host") return Promise.reject("cannot replace settings");
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush();
    hostMenuItem("h1", "Remove…").click();
    document.querySelector<HTMLButtonElement>(".host-confirm-btn-danger")!.click();
    await flush(20);
    hostActionButton("h1", "Connect").click();
    await flush(20);
    resolveOld("old-runtime");
    await flush(20);
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "old-runtime" });
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", { hostId: "new-runtime" });
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });
});

describe("main: Important 2 -- Disconnect waehrend connecting", () => {
  it("laesst den Zustand nicht kommentarlos auf 'connected' zurueckspringen und schliesst die dann doch entstehende Verbindung", async () => {
    const entry = hostEntry();
    let resolveConnect!: (id: string) => void;
    const connectPromise = new Promise<string>((resolve) => {
      resolveConnect = resolve;
    });

    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([entry]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return connectPromise;
      if (command === "disconnect_host") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostActionButton("h1", "Connect").click();
    await flush();

    expect(hostIndicatorClass("h1")).toContain("ind-connecting");

    // Waehrend `connect_host` noch aussteht: "Disconnect" (derselbe
    // Umschaltknopf zeigt jetzt diesen Text, siehe `sidebar.ts::
    // buildConnectToggle`).
    hostActionButton("h1", "Disconnect").click();
    await flush();

    expect(hostIndicatorClass("h1")).toContain("ind-off");
    // Cancel reaches the reserved runtime before connect has returned.
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", { hostId: "s1" });

    // `connect_host` loest jetzt doch noch auf.
    resolveConnect("r1");
    await flush(15);

    // Der Zustand bleibt getrennt -- kein Zurueckspringen auf "connected".
    expect(hostIndicatorClass("h1")).toContain("ind-off");
    // Die inzwischen tatsaechlich entstandene Verbindung wird sofort wieder
    // geschlossen, MIT der echten Laufzeit-ID -- kein Leck im Backend.
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
  });
});

// Review-Nachtrag (zweite Runde): ein `Set<string>` mit der Vor-
// Verbindungs-ID als Schluessel (erste Fassung von Important 2) identifiziert
// den HOST, nicht den VERSUCH -- fuer einen nie erfolgreich verbundenen Host
// ist die Vor-Verbindungs-ID bei JEDEM Versuch dieselbe. Abgebrochener
// Versuch A gefolgt von einem NEUEN Versuch B loeschte As Abbruchmarkierung
// versehentlich mit (beide teilten denselben Schluessel) -- loeste A danach
// auf, wurde er faelschlich als gueltig gefuehrt, OHNE dass je
// `disconnect_host` fuer seine Laufzeit-ID fiel. Der Generationszaehler
// (siehe `connectGenerationByHostId`s Kopfkommentar in main.ts) behebt das
// strukturell: beide Tests unten fahren GENAU dieses Szenario (Connect A ->
// Disconnect (waehrend A haengt) -> Connect B), einmal mit A vor B
// aufloesend, einmal umgekehrt -- in BEIDEN Faellen muss `disconnect_host`
// fuer As Laufzeit-ID fallen, nie fuer B.
describe("main: Review-Runde 2 -- Generationszaehler statt einer ID-Menge (ueberholter Connect-Versuch)", () => {
  function setupOverlappingAttempts(): {
    resolveA: (id: string) => void;
    resolveB: (id: string) => void;
  } {
    const entry = hostEntry();
    let resolveA!: (id: string) => void;
    let resolveB!: (id: string) => void;
    const promiseA = new Promise<string>((resolve) => {
      resolveA = resolve;
    });
    const promiseB = new Promise<string>((resolve) => {
      resolveB = resolve;
    });
    let connectCalls = 0;

    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([entry]);
      if (command === "begin_connect") return Promise.resolve(connectCalls === 0 ? "runtime-a" : "runtime-b");
      if (command === "connect_host") {
        connectCalls++;
        return connectCalls === 1 ? promiseA : promiseB;
      }
      if (command === "disconnect_host") return Promise.resolve(undefined);
      if (command === "list_sessions") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    return { resolveA, resolveB };
  }

  async function driveConnectDisconnectConnect(): Promise<{
    resolveA: (id: string) => void;
    resolveB: (id: string) => void;
  }> {
    const { resolveA, resolveB } = setupOverlappingAttempts();

    main();
    await flush();

    hostActionButton("h1", "Connect").click(); // Versuch A
    await flush();
    hostActionButton("h1", "Disconnect").click(); // Abbruch, waehrend A haengt
    await flush();
    hostActionButton("h1", "Connect").click(); // Versuch B, dieselbe Vor-Verbindungs-ID
    await flush();

    return { resolveA, resolveB };
  }

  it("schliesst As Verbindung ueber ihre Laufzeit-ID, wenn A VOR B aufloest", async () => {
    const { resolveA, resolveB } = await driveConnectDisconnectConnect();

    resolveA("runtime-a");
    await flush(15);

    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "runtime-a" });
    // B haengt noch -- der Host zeigt weiterhin "connecting", nicht "failed"
    // oder "disconnected" durch As (ueberholtes) Ergebnis.
    expect(hostIndicatorClass("h1")).toContain("ind-connecting");

    resolveB("runtime-b");
    await flush(15);

    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", { hostId: "runtime-b" });
  });

  it("schliesst As Verbindung ueber ihre Laufzeit-ID auch dann, wenn B VOR A aufloest", async () => {
    const { resolveA, resolveB } = await driveConnectDisconnectConnect();

    resolveB("runtime-b");
    await flush(15);

    expect(hostIndicatorClass("h1")).toContain("ind-on");

    resolveA("runtime-a");
    await flush(15);

    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "runtime-a" });
    // B bleibt verbunden -- As verspaetetes (ueberholtes) Ergebnis darf den
    // bereits gueltigen Zustand von B nicht ueberschreiben.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });
});

describe("main: 'New session' ist zustandsabhaengig (Review-Nachtrag, Minor)", () => {
  // Task 16, Punkt E: die Absage steht seither AM Knopf, nicht dahinter --
  // `sidebar.ts::buildHostActions` setzt `disabled`, solange der Host nicht
  // verbunden ist. Der Test prueft deshalb, dass gar nichts passiert, statt
  // die Meldung zu zaehlen, die frueher auf den Klick folgte; `onNewSession`s
  // Wache in main.ts bleibt bestehen (Tastaturweg `Ctrl+Shift+N`, und die
  // Verbindung kann zwischen Oeffnen und Absenden des Dialogs fallen).
  it("bietet den Sitzungsdialog fuer einen nicht verbundenen Host gar nicht erst an", async () => {
    const entry = hostEntry();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([entry]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    const button = hostActionButton("h1", "New session");
    expect(button.disabled).toBe(true);
    button.click();
    await flush();

    expect(document.querySelector(".dialog-panel")).toBeNull();
    // Und nicht etwa doch mit einer Meldung beantwortet: ein deaktivierter
    // Knopf sagt seine Absage selbst, ein Banner daneben waere Rauschen.
    expect(document.querySelector<HTMLElement>(".global-error-banner")?.hidden).toBe(true);
  });
});

describe("main: gemeinsame Dialoghuelle (Spec 11.1)", () => {
  it("UI v2: Schliessen-Kreuz mit Icon; Sessiondialog breit, Add-host-Dialog nicht", async () => {
    const entry = hostEntry(); // label "h1"
    invokeMock.mockImplementation((command: string, rawArgs?: unknown) => {
      const args = rawArgs as Record<string, unknown> | undefined;
      if (command === "list_hosts") return Promise.resolve([entry]);
      if (command === "list_ssh_keys" || command === "suggest_hosts" || command === "list_sessions") {
        return Promise.resolve([]);
      }
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      // Der Sitzungsdialog bindet den Verzeichnisbaum ein, der beim Oeffnen
      // `list_directories` ruft -- siehe die ausfuehrliche Begruendung an
      // derselben Zeile weiter unten in dieser Datei: eine `undefined`-
      // Antwort ergaebe eine unbehandelte Ablehnung im Baum.
      if (command === "list_directories") {
        return Promise.resolve({ path: (args?.path as string) || "/tmp", entries: [] });
      }
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    document.querySelector<HTMLButtonElement>(".sb-btn")!.click(); // Add host
    await flush();
    const close = document.querySelector<HTMLButtonElement>(".dialog-close-btn")!;
    expect(close.getAttribute("aria-label")).toBe("Close");
    expect(close.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(document.querySelector(".dialog-panel")!.classList.contains("dialog-panel--wide")).toBe(false);
    close.click();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush();
    hostActionButton("h1", "New session").click();
    await flush();
    expect(document.querySelector(".dialog-panel .dialog-head h2")?.textContent).toContain("New session");
    expect(document.querySelector(".dialog-panel")!.classList.contains("dialog-panel--wide")).toBe(true);
    expect(document.querySelector(".dialog-panel")!.classList.contains("dialog-panel--large")).toBe(false);
  });
});

describe("main: Important 3 -- Fokus-Falle in der Dialog-Ueberlagerung", () => {
  it("faengt Tab/Shift+Tab im Dialog, schliesst ueber ein am document haengendes Escape, markiert #app als inert und gibt den Fokus beim Schliessen zurueck", async () => {
    const entry = hostEntry();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([entry]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    // Seit dem Aufklappmenue oeffnet den Dialog nicht mehr ein flacher
    // "Edit"-Knopf, sondern der Menueeintrag -- und der gibt den Fokus
    // ZUERST an den `⋯`-Knopf zurueck und handelt dann erst
    // (`sidebar.ts::buildMenuItem`). Das Element, das `openDialog` sich als
    // Rueckkehrziel merkt, ist deshalb dieser Knopf.
    const opener = hostMenuButton("h1");
    opener.focus();
    hostMenuItem("h1", "Edit…").click();
    await flush();

    const panel = document.querySelector<HTMLElement>(".dialog-panel");
    expect(panel).not.toBeNull();
    const closeButton = document.querySelector<HTMLButtonElement>(".dialog-close-btn")!;

    // Fokus wandert beim Oeffnen auf das erste Bedienelement (die
    // Schliessen-Schaltflaeche, Kopfzeile vor Koerper).
    expect(document.activeElement).toBe(closeButton);
    // #app ist tatsaechlich inert, nicht nur behauptet (aria-modal).
    expect(document.getElementById("app")!.inert).toBe(true);

    const focusables = Array.from(
      panel!.querySelectorAll<HTMLElement>("button, input, select"),
    );
    const lastFocusable = focusables[focusables.length - 1];
    expect(lastFocusable).not.toBe(closeButton);

    // Tab am letzten Element wickelt zurueck auf das erste.
    lastFocusable.focus();
    fireKeydown(document, "Tab");
    expect(document.activeElement).toBe(closeButton);

    // Shift+Tab am ersten Element wickelt zurueck auf das letzte.
    fireKeydown(document, "Tab", true);
    expect(document.activeElement).toBe(lastFocusable);

    // Escape haengt am document, nicht am Panel -- greift unabhaengig davon,
    // wo der Fokus INNERHALB des Dialogs gerade steht.
    fireKeydown(document, "Escape");

    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(document.getElementById("app")!.inert).toBe(false);
    // Fokus kehrt zum Element zurueck, das den Dialog geoeffnet hat.
    expect(document.activeElement).toBe(opener);
  });
});

// H-Nachtrag: `elements.dialogRoot.inert` allein legt nur die
// Dialog-Ueberlagerung selbst still, nicht `#app` (die Seitenleiste). Waehrend
// eine TOFU-Rueckfrage offen ist, muss aber die GESAMTE Anwendung dahinter
// fuer Tastatur und Hilfstechnik unerreichbar sein -- sonst bliebe die
// Seitenleiste per Tab erreichbar, bis hin zu "Remove". `onOpenChange` muss
// deshalb zusaetzlich `elements.app.inert` setzen, und zwar so, dass weder
// die TOFU-Rueckfrage noch eine gleichzeitig offene generische Ueberlagerung
// es allein freigeben kann -- erst wenn BEIDE zu sind.
describe("main: TOFU-Rueckfrage legt auch #app still, nicht nur #dialog-root (H-Nachtrag)", () => {
  it("markiert #app als inert, sobald eine TOFU-Rueckfrage eintrifft, auch ohne offene generische Ueberlagerung, und gibt es beim Ablehnen wieder frei", async () => {
    const entry = hostEntry();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([entry]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    // Vor jeder Rueckfrage/Ueberlagerung setzt main.ts `elements.app.inert`
    // nie explizit -- jsdom reflektiert `inert` nicht als IDL-Attribut mit
    // einem Default (siehe Kommentar zu `document.getElementById("app")!
    // .inert` in der "Important 3"-Testgruppe oben), ein frischer Knoten
    // liefert deshalb `undefined`, nicht `false`. Die eigentliche Zusicherung
    // beginnt hier erst mit der ersten TOFU-Rueckfrage.
    emitHostKeyRequest(hostKeyRequest());
    await flush();
    expect(document.getElementById("app")!.inert).toBe(true);

    const rejectButton = Array.from(
      document.getElementById("host-key-prompt-root")!.querySelectorAll("button"),
    ).find((b) => b.textContent === "Reject")!;
    rejectButton.click();
    await flush();

    expect(document.getElementById("app")!.inert).toBe(false);
  });

  it("haelt #app inert, wenn waehrend einer offenen TOFU-Rueckfrage eine gleichzeitig offene generische Ueberlagerung geschlossen wird -- frei erst, wenn auch die Rueckfrage beantwortet ist", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "suggest_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      // Loest nie auf -- bildet die Blockade in TofuPolicy::decide nach.
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return new Promise<string>(() => {});
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    document.querySelector<HTMLButtonElement>(".sb-btn")!.click(); // "+ Add host"
    await flush();
    const view = document.querySelector<HTMLElement>(".dialog-body .host-form-view")!;
    (view.querySelector("input[name=hostname]") as HTMLInputElement).value = "192.0.2.10";
    (view.querySelector("input[name=user]") as HTMLInputElement).value = "m";
    (view.querySelector("input[name=port]") as HTMLInputElement).value = "22";
    const select = view.querySelector("select[name=auth]") as HTMLSelectElement;
    select.value = "agent";
    select.dispatchEvent(new Event("change"));
    document
      .querySelector(".dialog-body form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    // Generische Ueberlagerung ("Add host") ist offen -- #app bereits inert.
    // Beide Abfragen auf `#dialog-root` eingeschraenkt (UI v2): seit der
    // gemeinsamen Dialoghuelle traegt auch die TOFU-Rueckfrage
    // `.dialog-panel` (neben `.host-key-prompt`), eine dokumentweite Abfrage
    // faende hier also die Rueckfrage und behauptete, die generische
    // Ueberlagerung stuende noch.
    expect(document.getElementById("dialog-root")!.querySelector(".dialog-panel")).not.toBeNull();
    expect(document.getElementById("app")!.inert).toBe(true);

    emitHostKeyRequest(hostKeyRequest({ request_id: 9 }));
    await flush();
    expect(document.getElementById("app")!.inert).toBe(true);

    // Die generische Ueberlagerung wird geschlossen (z. B. ueber ihre
    // Schliessen-Schaltflaeche), WAEHREND die TOFU-Rueckfrage noch offen
    // ist -- #app darf trotzdem NICHT frei werden.
    document.querySelector<HTMLButtonElement>(".dialog-close-btn")!.click();
    await flush();
    expect(document.getElementById("dialog-root")!.querySelector(".dialog-panel")).toBeNull();
    expect(document.getElementById("app")!.inert).toBe(true);

    // Erst das Ablehnen der Rueckfrage -- jetzt ist auch kein generischer
    // Dialog mehr offen -- gibt #app frei.
    const rejectButton = Array.from(
      document.getElementById("host-key-prompt-root")!.querySelectorAll("button"),
    ).find((b) => b.textContent === "Reject")!;
    rejectButton.click();
    await flush();

    expect(document.getElementById("app")!.inert).toBe(false);
  });
});

// Validierung (Critical): die TOFU-Rueckfrage war hinter JEDER offenen
// Dialog-Ueberlagerung unerreichbar. Beide Wurzeln trugen `z-index: 100`;
// bei Gleichstand entscheidet die Dokumentreihenfolge, und `#dialog-root`
// steht in index.html spaeter. Der Scrim der Ueberlagerung schluckte jeden
// Klick, und `onDialogKeydown` holte den Fokus in `.dialog-panel` zurueck --
// der Fingerabdruck war gerendert, aber weder zu sehen noch zu bedienen.
// Das Backend blockiert waehrenddessen den Handshake (`recv_timeout`,
// `HOST_KEY_PROMPT_TIMEOUT` = 60 s, Zeitablauf = Ablehnung), der normale Weg
// endete also nach einer Minute Nichts in "Connection failed".
//
// Kein Test fiel darueber, weil der ERSTE Host ueber `showFirstRunInGrid`
// laeuft -- dort ist `#dialog-root` leer und die Rueckfrage funktioniert.
// Erst ab dem zweiten Host geht es durch die Ueberlagerung, und genau das
// fahren die Tests hier: ein bereits gespeicherter Host, dann
// "+ Add host".
describe("main: Critical -- die TOFU-Rueckfrage gewinnt gegen die Dialog-Ueberlagerung", () => {
  /** Genau der gemeldete Ablauf bis unmittelbar vor die Rueckfrage:
   * gespeicherter Host vorhanden -> Seitenleiste "+ Add host" -> Formular
   * ausfuellen -> absenden. `connect_host` loest NIE auf: das bildet die
   * Blockade in `TofuPolicy::decide` nach, die den Handshake anhaelt,
   * solange die Rueckfrage offen ist. */
  async function openAddHostAndSubmit(): Promise<void> {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "suggest_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return new Promise<string>(() => {});
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    document.querySelector<HTMLButtonElement>(".sb-btn")!.click(); // "+ Add host"
    await flush();

    const view = dialogHostFormView();
    fillHostForm(view, "192.0.2.10", "m", "22");
    chooseAgentAuth(view);
    submitDialogForm();
    await flush();
  }

  function promptRoot(): HTMLElement {
    return document.getElementById("host-key-prompt-root")!;
  }

  function dialogRoot(): HTMLElement {
    return document.getElementById("dialog-root")!;
  }

  function promptButton(text: string): HTMLButtonElement {
    const btn = Array.from(promptRoot().querySelectorAll("button")).find(
      (b) => b.textContent === text,
    );
    if (!btn) throw new Error(`host-key prompt button not found: ${text}`);
    return btn;
  }

  it("zeigt den Fingerabdruck, legt die Ueberlagerung stille und laesst den Fokus nicht mehr aus der Rueckfrage ziehen", async () => {
    await openAddHostAndSubmit();

    // Vorbedingung: die Ueberlagerung steht, ihre Fokus-Falle ist scharf --
    // ohne sie pruefte alles darunter einen Fall, den es gar nicht gibt.
    expect(dialogRoot().querySelector(".dialog-panel")).not.toBeNull();
    expect(dialogRoot().inert).toBe(false);
    expect(promptRoot().childElementCount).toBe(0);

    emitHostKeyRequest(hostKeyRequest());

    // 1. Der Fingerabdruck ist tatsaechlich da -- was der Nutzer nicht sehen
    //    kann, kann er nicht entscheiden.
    expect(
      promptRoot().querySelector(".host-key-prompt-fingerprint-value")?.textContent,
    ).toBe(SAMPLE_FINGERPRINT);
    // 2. Die Ueberlagerung wird NICHT geschlossen (sie haelt das laufende
    //    `connect_host` samt Eingaben, siehe main.ts) ...
    expect(dialogRoot().querySelector(".dialog-panel")).not.toBeNull();
    // 3. ... aber sie ist stillgelegt: kein Klick, kein Tab-Stopp, fuer
    //    Hilfstechnik weg.
    expect(dialogRoot().inert).toBe(true);
    // 4. Der Fokus steht IN der Rueckfrage.
    expect(promptRoot().contains(document.activeElement)).toBe(true);

    // 5. Tab und Shift+Tab holen ihn nicht in die Fokus-Falle der
    //    Ueberlagerung zurueck -- das war der zweite Riegel vor der
    //    Rueckfrage, und ein z-index allein loest ihn nicht.
    fireKeydown(document, "Tab");
    expect(promptRoot().contains(document.activeElement)).toBe(true);
    fireKeydown(document, "Tab", true);
    expect(promptRoot().contains(document.activeElement)).toBe(true);

    // 6. Escape schliesst waehrenddessen NICHT die Ueberlagerung. Genau das
    //    war vorher der einzige (voellig unbeschilderte) Weg zu einer
    //    bedienbaren Rueckfrage -- und er wirft die Verbindung weg, ueber
    //    die gerade entschieden wird.
    fireKeydown(document, "Escape");
    expect(dialogRoot().querySelector(".dialog-panel")).not.toBeNull();
  });

  it("beantwortet die Rueckfrage per Klick und gibt die Ueberlagerung danach wieder frei", async () => {
    await openAddHostAndSubmit();
    emitHostKeyRequest(hostKeyRequest({ request_id: 7 }));

    // Der Klick geht an die Rueckfrage, nicht an den Scrim darueber -- das
    // ist die Maus-Haelfte desselben Befunds.
    promptButton("Trust and continue").click();
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("respond_host_key", { requestId: 7, accept: true });
    expect(promptRoot().childElementCount).toBe(0);
    // Die Ueberlagerung ist wieder bedienbar -- sonst waere die Rueckfrage
    // von einer Sackgasse in die naechste gelaufen.
    expect(dialogRoot().inert).toBe(false);
    expect(dialogRoot().querySelector(".dialog-panel")).not.toBeNull();
  });
});

/** Fuellt das Bearbeiten-Formular der offenen Ueberlagerung und sendet ab. */
function submitEditForm(hostname: string): void {
  const view = dialogHostFormView();
  fillHostForm(view, hostname, "m", "22");
  chooseAgentAuth(view);
  submitDialogForm();
}

// Validierung (Important 1): `submitEdit` pruefte "verbunden ODER
// verbindend" in EINER Bedingung und rief `disconnect_host` mit `host.id`.
// Waehrend "connecting" ist das noch die settings.toml-ID -- unter ihr
// existiert im Backend keine Verbindung, und `disconnect_host_impl` liefert
// fuer eine unbekannte ID `Ok(())`, ohne etwas zu tun. Der laufende Versuch
// trug danach weiterhin seine gueltige Generation, setzte `host.id =
// runtimeId` auf einem laengst fallen gelassenen Objekt und galt als
// geglueckt: die russh-Sitzung lief mit Keepalive bis zum Programmende
// weiter, von keiner Oberflaeche mehr erreichbar. `onDisconnectHost`
// behandelt denselben Fall seit dem Abschlussreview richtig -- `submitEdit`
// zog nicht nach.
describe("main: Validierung Important 1 -- 'Edit' waehrend 'connecting' darf keine Sitzung zuruecklassen", () => {
  it("bricht den laufenden Versuch ueber den Generationszaehler ab und schliesst die dann doch entstehende Verbindung mit ihrer LAUFZEIT-ID", async () => {
    const entry = hostEntry(); // settings.toml-ID "s1"
    const renamed = hostEntry({ hostname: "10.0.0.9" });
    let resolveConnect!: (id: string) => void;
    const connectPromise = new Promise<string>((resolve) => {
      resolveConnect = resolve;
    });
    let saved = false;

    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve(saved ? [renamed] : [entry]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return connectPromise;
      if (command === "update_host") {
        saved = true;
        return Promise.resolve(renamed);
      }
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostActionButton("h1", "Connect").click();
    await flush();
    // Vorbedingung: der Versuch haengt tatsaechlich noch.
    expect(hostIndicatorClass("h1")).toContain("ind-connecting");

    // "Edit…" bietet die Seitenleiste in JEDEM Zustand an -- zwei
    // gewoehnliche Klicks, mehr braucht der Fall nicht.
    hostMenuItem("h1", "Edit…").click();
    await flush();
    submitEditForm("10.0.0.9");
    await flush(20);

    // Kein wirkungsloser Aufruf mit der settings.toml-ID -- der war das
    // Symptom: er sah nach Aufraeumen aus und tat nichts.
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", { hostId: "s1" });

    // `connect_host` loest jetzt doch noch auf: die Verbindung entsteht
    // wirklich, gehoert aber niemandem mehr.
    resolveConnect("r1");
    await flush(20);

    // Sie wird mit ihrer LAUFZEIT-ID geschlossen -- die einzige, unter der
    // das Backend sie kennt.
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
  });
});

// Validierung (Important 3): die Zwei-ID-Versoehnung hatte KEINEN Test --
// damals eine Uebersetzungstabelle `settingsIdFor`, deren Mutation auf
// `return hostId;` alle 218 Tests gruen liess. Der bestehende
// Bearbeiten-Test faehrt einen NIE verbundenen Host, bei dem beide IDs
// zufaellig zusammenfallen. Unter der Mutation adressierte `remove_host` die
// Laufzeit-ID, der Eintrag in `settings.toml` ueberlebte, und der Host
// tauchte beim naechsten Start wieder auf -- bis dahin unsichtbar. Beide
// Wege ("Remove" und "Edit") brauchen deshalb je einen Test NACH einem
// erfolgreichen `connect_host`.
//
// Seit Paket 2.5 gibt es die Tabelle nicht mehr (`host.id` IST die
// settings.toml-ID, `host.runtimeId` traegt die andere) -- diese beiden
// Tests bleiben trotzdem woertlich gueltig: sie pruefen, welche ID bei
// welchem `invoke` ankommt, nicht, wie sie zustande kommt.
describe("main: Validierung Important 3 -- Remove/Edit treffen nach erfolgreichem connect_host die richtige der beiden IDs", () => {
  /** Ein gespeicherter Host (settings.toml-ID "s1"), erfolgreich verbunden;
   * `connect_host` vergibt dabei die davon unabhaengige Laufzeit-ID "r1". */
  async function connectSavedHost(): Promise<void> {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      if (command === "list_sessions") return Promise.resolve([]);
      // Was `update_host_impl` zurueckgibt: seit "zuerst speichern" (Aufgabe 18)
      // trennt "Save" erst nach einem gelungenen Speichern.
      if (command === "update_host") return Promise.resolve(hostEntry({ hostname: "10.0.0.9" }));
      return Promise.resolve(undefined);
    });

    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    // Vorbedingung: wirklich verbunden -- sonst faellt `host.id` gar nicht
    // erst auf die Laufzeit-ID, und der Test pruefte den alten, harmlosen
    // Fall, in dem beide IDs uebereinstimmen.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  }

  it("'Remove' loescht den settings.toml-Eintrag unter der SETTINGS-ID und trennt unter der LAUFZEIT-ID", async () => {
    await connectSavedHost();

    hostMenuItem("h1", "Remove…").click();
    // Seit der Rueckfrageleiste ist "Remove…" ein OEFFNEN, kein Entfernen --
    // erst dieser Knopf entfernt. Der Weg dorthin ist synchron (Menueeintrag
    // -> `render()` -> Leiste), es braucht kein `flush()` dazwischen. Wirft
    // laut, statt still danebenzugreifen: waere die Leiste nicht da, pruefte
    // der Test unten nur einen nie ausgeloesten Aufruf.
    const confirmButton = Array.from(
      document.querySelectorAll<HTMLElement>(".host-confirm-remove button"),
    ).find((b) => b.textContent === "Remove");
    if (!confirmButton) throw new Error('confirm bar for host "h1" did not open');
    confirmButton.click();
    await flush(20);

    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    expect(invokeMock).toHaveBeenCalledWith("remove_host", { id: "s1" });
    // Die Verwechslung selbst, ausdruecklich ausgeschlossen: mit der
    // Laufzeit-ID faende `remove_host` nichts und bliebe folgenlos.
    expect(invokeMock).not.toHaveBeenCalledWith("remove_host", { id: "r1" });
    expect(document.querySelectorAll("#sidebar .row-host")).toHaveLength(0);
  });

  it("'Edit' trennt unter der LAUFZEIT-ID und ersetzt den Eintrag unter der SETTINGS-ID", async () => {
    await connectSavedHost();

    hostMenuItem("h1", "Edit…").click();
    await flush();
    submitEditForm("10.0.0.9");
    await flush(20);

    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    expect(invokeMock).toHaveBeenCalledWith("update_host", expect.objectContaining({ id: "s1" }));
    expect(invokeMock).not.toHaveBeenCalledWith("update_host", expect.objectContaining({ id: "r1" }));
  });
});

// --- Task 12 (Tastatur): Verdrahtung von session.prev/next/select.N,
// tile.maximize, sidebar.toggle, sidebar.focus -- ueber die
// ECHTE main()-Verdrahtung (dokumentweiter Akkord-Handler), nicht ueber
// AppState direkt. Das ist bewusst: die Gegenprobe muss zeigen, dass
// Kachel-Badge UND Ctrl+Shift+N tatsaechlich dieselbe Ziffer meinen -- ein
// Test, der nur `sidebarSessionOrder` aufruft, koennte das nicht zeigen,
// weil er `grid.ts`/`main.ts`s tatsaechliche Verkabelung gar nicht
// beruehrt. ---

function chord(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
  );
}

/** Klickt im offenen Schnelloeffnen (UX-Spec §7.5) die Zeile mit diesem Text. */
function runQuickOpenOption(label: string): void {
  const option = Array.from(document.querySelectorAll<HTMLElement>(".dialog-panel .quick-open-option")).find(
    (candidate) => candidate.querySelector(".quick-open-label")?.textContent === label,
  );
  if (!option) throw new Error(`quick open has no option "${label}"`);
  option.click();
}

/** `target` bestimmt `event.target` fuer die gesamte Bubble-Phase (auch auf
 * `document`, wo `main.ts`s Handler sitzen) -- so laesst sich die
 * `.xterm`-Teilbaum-Waeche in `onMaximizedEscapeKeydown` pruefen, ohne ein
 * echtes xterm.js zu brauchen (`./terminal` ist in dieser Datei ohnehin
 * komplett gemockt, siehe Kopfkommentar). */
function escapeFrom(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

function escape(): void {
  escapeFrom(document);
}

function expandHost(label: string): void {
  hostRow(label).click();
}

function sessionButton(hostLabel: string, sessionName: string): HTMLButtonElement {
  const block = hostRow(hostLabel).parentElement as HTMLElement;
  const btn = Array.from(block.querySelectorAll<HTMLButtonElement>(".row-session")).find(
    (b) => b.querySelector(".row-label")?.textContent === sessionName,
  );
  if (!btn) throw new Error(`session row not found: ${hostLabel}/${sessionName}`);
  return btn;
}

function openViaSidebar(hostLabel: string, sessionName: string): void {
  sessionButton(hostLabel, sessionName).click();
}

function badgeForTitle(title: string): string {
  const tile = Array.from(document.querySelectorAll<HTMLElement>("#grid .tile")).find(
    (el) => el.querySelector(".tile-title")?.textContent === title,
  );
  if (!tile) throw new Error(`tile not found for title: ${title}`);
  return tile.querySelector(".badge")?.textContent ?? "";
}

function focusedTileTitle(): string | undefined {
  return document.querySelector("#grid .tile.focused .tile-title")?.textContent ?? undefined;
}

/** Alle Kacheltitel, die das Raster gerade zeigt. Bewusst eine LISTE und
 * nicht ein "Kachel mit Titel X gefunden?": eine Zusicherung auf die Liste
 * sagt POSITIV, welche Kachel ueberlebt hat, und bleibt aussagekraeftig,
 * wenn sich die Kachelstruktur einmal aendert (dieselbe Ueberlegung wie
 * Befund 3 dieses Reviews an der Generationswache unten). */
function tileTitles(): string[] {
  return tilesInOrder().map((tile) => tile.querySelector(".tile-title")?.textContent ?? "");
}

/** Die Kacheln in Anzeigereihenfolge (die DOM-Reihenfolge folgt der
 * Entstehung, Spec 2026-10-19 §4.3). */
function tilesInOrder(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#grid .tile")).sort(
    (a, b) => Number(a.dataset.position) - Number(b.dataset.position),
  );
}

/** Titel der maximierten Kachel, `undefined` ohne. Ersetzt den Hinweis der
 * gestrichenen Werkzeugleiste: maximiert traegt der Knopf der Kachel
 * "Maximized · …" und die Klasse `tile-btn--wide`. */
function maximizedTileTitle(): string | undefined {
  return document.querySelector(".tile .tile-btn--wide")?.closest(".tile")?.querySelector(".tile-title")?.textContent ?? undefined;
}

/** Zwei verbundene Hosts, drei Sessions (h1: s1, s2; h2: s3) -- Sidebar-
 * Reihenfolge damit h1/s1=1, h1/s2=2, h2/s3=3 (Reihenfolge von
 * `list_hosts`/`state.hosts`). `connect_host` loest je nach `spec.hostname`
 * mit einer STABILEN Laufzeit-ID auf ("r-h1"/"r-h2"), `list_sessions`
 * antwortet danach fuer diese ID -- ohne diese Unterscheidung koennten
 * beide Hosts nicht unabhaengig verbunden werden. `h1Sessions` ersetzt die
 * zwei Sessions von h1, etwa um dessen Grenze je Host (`MAX_TILES_PER_HOST`)
 * zu erreichen. */
async function setupTwoHostsThreeSessions(
  overrides: Partial<HostEntryLike> = {},
  h1Sessions: string[] = ["s1", "s2"],
): Promise<void> {
  const h1 = hostEntry({ id: "s-h1", label: "h1", hostname: "10.0.0.1", ...overrides });
  const h2 = hostEntry({ id: "s-h2", label: "h2", hostname: "10.0.0.2", ...overrides });

  let reservations = 0;
  invokeMock.mockImplementation((command: string, rawArgs?: unknown) => {
    const args = rawArgs as Record<string, unknown> | undefined;
    if (command === "list_hosts") return Promise.resolve([h1, h2]);
    if (command === "begin_connect") return Promise.resolve(++reservations % 2 === 1 ? "r-h1" : "r-h2");
    if (command === "connect_host") {
      const spec = args?.spec as { hostname: string } | undefined;
      return Promise.resolve(spec?.hostname === h1.hostname ? "r-h1" : "r-h2");
    }
    if (command === "list_sessions") {
      const hostId = args?.hostId as string;
      if (hostId === "r-h1") return Promise.resolve(h1Sessions);
      if (hostId === "r-h2") return Promise.resolve(["s3"]);
      return Promise.resolve([]);
    }
    if (command === "disconnect_host") return Promise.resolve(undefined);
    // Der Sitzungsdialog bindet seit der Verzeichnisauswahl einen
    // Verzeichnisbaum ein (`session-dialog.ts` -> `directory-tree.ts`), und
    // der ruft `list_directories` schon beim Oeffnen. Die generische
    // `undefined`-Antwort unten reicht dafuer NICHT: der Baum liest
    // `dto.path`, das ergaebe einen `TypeError` in einer Zusage, die
    // niemand abwartet -- eine unbehandelte Ablehnung, die den ganzen Lauf
    // anschwaerzt. Der Inhalt ist gleichgueltig; der Baum selbst ist in
    // `views/directory-tree.test.ts` abgedeckt.
    if (command === "list_directories") {
      return Promise.resolve({ path: (args?.path as string) || "/tmp", entries: [] });
    }
    // "Add host" (einige Task-12-Tests unten oeffnen den Dialog, um Escape
    // gegen einen offenen Dialog zu pruefen) mountet first-run.ts erneut --
    // dessen `loadInitialData` erwartet ein ARRAY, kein `undefined` (siehe
    // dortigen Array.isArray-Kommentar zu `existingResult`; `suggest_hosts`
    // ist ungeschuetzt und wuerde mit dem generischen `undefined` unten
    // abstuerzen).
    if (command === "suggest_hosts") return Promise.resolve([]);
    if (command === "list_ssh_keys") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });

  main();
  await flush();

  await connectFromSidebar("h1");
  await connectFromSidebar("h2");
}

/** "Connect" in der Seitenleiste. Ein Passwort-Host fragt vor dem ersten
 * Versuch nach dem Passwort (Spec §4.8); dann geht es ueber die Hinweisleiste. */
async function connectFromSidebar(label: string): Promise<void> {
  hostActionButton(label, "Connect").click();
  await flush(20);
  const password = hostRow(label).parentElement!.querySelector<HTMLInputElement>(".host-notice input[name=password]");
  if (!password || hostIndicatorClass(label).includes("ind-on")) return;
  password.value = "host-password";
  hostRetryButton(label).click();
  await flush(20);
}

describe("main: Tastatur -- Kachel-Badge und session.select.N teilen den Platz", () => {
  it("Ctrl+Shift+<Badge-Ziffer> fokussiert GENAU die Kachel mit dieser Ziffer", async () => {
    await setupTwoHostsThreeSessions();

    expandHost("h1");
    expandHost("h2");

    openViaSidebar("h2", "s3");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");

    for (const title of ["s3", "s1", "s2"]) {
      const digit = badgeForTitle(title);
      expect(digit).not.toBe("");
      chord(digit);
      expect(focusedTileTitle()).toBe(title);
    }
  });
});

describe("main: Abschlussreview (Minor 1) -- Ansage und Abzeichen nennen dieselbe Ziffer", () => {
  it("sagt beim Maximieren die Platzziffer der Kachel an", async () => {
    await setupTwoHostsThreeSessions();

    expandHost("h1");
    expandHost("h2");

    openViaSidebar("h2", "s3");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");

    expect(badgeForTitle("s3")).toBe("1");

    chord("1");
    expect(focusedTileTitle()).toBe("s3");
    chord("m");

    // Die unsichtbare Ansage des Rasters -- seit UX-Spec §6.1 traegt auch der
    // Chip "Copied" jeder Kachel `aria-live`.
    const announce = document.querySelector<HTMLElement>('#grid .ab-visually-hidden[aria-live="polite"]');
    expect(announce?.textContent).toContain("Terminal 1");
  });
});

describe("main: Ersetzen, Grenze und Wiederfinden (Spec 2026-10-19 §5.2, §5.3, §6.3)", () => {
  function ctrlClick(hostLabel: string, sessionName: string): void {
    sessionButton(hostLabel, sessionName).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
  }

  function flashedTitles(): string[] {
    return Array.from(document.querySelectorAll("#grid .tile--flash .tile-title"), (title) => title.textContent ?? "");
  }

  /** Das Aufleuchten haelt 600 ms; was eine fruehere Wahl desselben Tests
   * angestossen hat, soll die Zusicherung auf die naechste nicht verdecken. */
  function clearFlashes(): void {
    for (const tile of document.querySelectorAll("#grid .tile--flash")) tile.classList.remove("tile--flash");
  }

  function liveRegionText(): string {
    return document.querySelector<HTMLElement>('#grid .ab-visually-hidden[aria-live="polite"]')?.textContent ?? "";
  }

  /** Sessions von h1 bis an dessen Grenze je Host (`a1`, `a2`, ...) und eine
   * dazu. Eigene Namen, weil `tileTitles()` keinen Host nennt und h2 schon
   * `s3` hat. */
  const h1Full = Array.from({ length: MAX_TILES_PER_HOST }, (_, i) => `a${i + 1}`);
  const h1Over = "a-over";
  /** Der Hinweis an der Grenze je Host, die Zahl aus der Konstante; woertlich
   * steht sie nur im Test "an der Grenze je Host steht der neutrale Hinweis". */
  const hostLimitText = `h1 already shows ${MAX_TILES_PER_HOST} terminals, the limit per host.`;

  it("Strg+Klick setzt die Session in die fokussierte Kachel; ohne Kachel fuegt er hinzu", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    expandHost("h2");
    ctrlClick("h1", "s1");
    expect(tileTitles()).toEqual(["s1"]);
    openViaSidebar("h1", "s2");
    ctrlClick("h2", "s3");
    expect(tileTitles()).toEqual(["s1", "s3"]);
    expect(focusedTileTitle()).toBe("s3");
  });

  it("Strg+Klick auf eine schon offene Session fokussiert sie nur (Review Focus 5)", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    expandHost("h2");
    openViaSidebar("h1", "s1");
    openViaSidebar("h2", "s3");
    expect(focusedTileTitle()).toBe("s3");

    ctrlClick("h1", "s1");

    expect(tileTitles()).toEqual(["s1", "s3"]);
    expect(focusedTileTitle()).toBe("s1");
  });

  it("Strg+Klick an der Grenze eines anderen Hosts zeigt den Hinweis, und nichts aendert sich (Review Focus 5)", async () => {
    await setupTwoHostsThreeSessions({}, [...h1Full, h1Over]);
    expandHost("h1");
    expandHost("h2");
    for (const name of h1Full) openViaSidebar("h1", name);
    openViaSidebar("h2", "s3");
    expect(focusedTileTitle()).toBe("s3");

    ctrlClick("h1", h1Over);

    expect(tileTitles()).toEqual([...h1Full, "s3"]);
    expect(focusedTileTitle()).toBe("s3");
    const banner = document.querySelector<HTMLElement>(".global-error-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains("global-error-banner--neutral")).toBe(true);
    // Die fokussierte Kachel (s3) gehoert zu h2: ein Ersetzen gaebe h1 eine
    // neunte Kachel, also nennt der Hinweis die Grenze je Host (Spec §5.2,
    // §5.3). Die Gesamtzahl bleibt beim Ersetzen gleich; `planReplace` prueft
    // sie nicht.
    expect(banner.textContent).toContain(hostLimitText);
  });

  it("Strg+Klick laesst die Kachel der gewaehlten Session aufleuchten und sagt sie an", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    expandHost("h2");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    clearFlashes();
    ctrlClick("h2", "s3");
    expect(tileTitles()).toEqual(["s1", "s3"]);
    expect(flashedTitles()).toEqual(["s3"]);
    expect(liveRegionText()).toBe("Terminal 2: s3");
  });

  it("an der Grenze je Host steht der neutrale Hinweis, und nichts schliesst", async () => {
    await setupTwoHostsThreeSessions({}, [...h1Full, h1Over]);
    expandHost("h1");
    for (const name of [...h1Full, h1Over]) openViaSidebar("h1", name);
    await flush();
    expect(tileTitles()).toEqual(h1Full);
    const banner = document.querySelector<HTMLElement>(".global-error-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains("global-error-banner--neutral")).toBe(true);
    // Der einzige woertliche Stift fuer die Zahl, die der Nutzer liest (Spec
    // 2026-10-19 §8.1: acht je Host); die uebrigen Tests nehmen `hostLimitText`.
    expect(banner.textContent).toContain("h1 already shows 8 terminals, the limit per host.");
  });

  // Spec 2026-10-19 §5.1 Nr. 3: auch "New session" endet an einer Grenze im
  // Hinweis und in nichts sonst -- kein Dialog, und tmux bekommt keine Session,
  // fuer die danach keine Kachel kaeme. Alle Wege laufen durch `onNewSession`:
  // Strg+Umschalt+N, der Knopf der Seitenleiste und "New session on …" im
  // Schnelloeffnen. Den Knopf im leeren Raster gibt es nur ohne Kacheln.
  it.each<[string, () => void]>([
    ["Strg+Umschalt+N", () => chord("n")],
    ["den Knopf der Seitenleiste", () => hostActionButton("h1", "New session").click()],
    [
      "das Schnelloeffnen",
      () => {
        chord("p");
        const input = document.querySelector<HTMLInputElement>(".dialog-panel .quick-open-input")!;
        input.value = "New session on h1";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        runQuickOpenOption("New session on h1");
      },
    ],
  ])("an der Grenze je Host oeffnet New session ueber %s keinen Dialog und legt nichts an", async (_way, run) => {
    await setupTwoHostsThreeSessions({}, h1Full);
    expandHost("h1");
    for (const name of h1Full) openViaSidebar("h1", name);
    expect(focusedTileTitle()).toBe(h1Full[h1Full.length - 1]);
    invokeMock.mockClear();

    run();
    await flush(20);

    expect(document.querySelector(".dialog-panel")).toBeNull();
    const banner = document.querySelector<HTMLElement>(".global-error-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains("global-error-banner--neutral")).toBe(true);
    expect(banner.textContent).toContain(hostLimitText);
    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(commands).not.toContain("list_directories");
    expect(commands).not.toContain("create_session");
    expect(tileTitles()).toEqual(h1Full);
  });

  it("ein Fehler nach dem Grenzhinweis ist wieder gefaehrlich getoent", async () => {
    await setupTwoHostsThreeSessions({}, [...h1Full, h1Over]);
    expandHost("h1");
    for (const name of [...h1Full, h1Over]) openViaSidebar("h1", name);
    const banner = document.querySelector<HTMLElement>(".global-error-banner")!;
    expect(banner.classList.contains("global-error-banner--neutral")).toBe(true);

    terminalHoisted.errorByKey.get(`r-h1/${h1Full[0]}`)!({ kind: "open", detail: "no terminal open for this session" });

    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains("global-error-banner--neutral")).toBe(false);
  });

  it("an einer Grenze verbindet ein Klick auf eine Session eines getrennten Hosts nicht erst (Spec §5.1 Nr. 3)", async () => {
    await setupTwoHostsThreeSessions({}, [...h1Full, h1Over]);
    expandHost("h1");
    for (const name of h1Full) openViaSidebar("h1", name);
    // Der Transport von h1 bricht ab: seine Kacheln bleiben (gesperrt), der
    // Host ist nicht mehr verbunden, und sein eigenes Neuverbinden (UX-Spec
    // §5.4) wartet noch rund 2 s. Ohne Grenzpruefung verbaende der Klick
    // ihn jetzt.
    emitTransportLost("r-h1");
    await flush(20);
    invokeMock.mockClear();
    openViaSidebar("h1", h1Over);
    await flush(20);
    expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(0);
    const banner = document.querySelector<HTMLElement>(".global-error-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains("global-error-banner--neutral")).toBe(true);
    expect(banner.textContent).toContain(hostLimitText);
    expect(tileTitles()).toEqual(h1Full);
  });

  it("Strg+Klick auf eine Session eines getrennten Hosts verbindet ihn und ersetzt danach die fokussierte Kachel", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    expandHost("h2");
    openViaSidebar("h2", "s3");
    hostActionButton("h1", "Disconnect").click();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-off");
    expect(tileTitles()).toEqual(["s3"]);
    clearFlashes();

    ctrlClick("h1", "s1");
    await flush(30);

    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(tileTitles()).toEqual(["s1"]);
    expect(focusedTileTitle()).toBe("s1");
    expect(flashedTitles()).toEqual(["s1"]);
  });

  it("Strg+Enter im Schnelloeffnen ersetzt die fokussierte Kachel, Enter fuegt hinzu", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    const pickInQuickOpen = (query: string, init: KeyboardEventInit): void => {
      chord("p");
      const input = document.querySelector<HTMLInputElement>(".dialog-panel .quick-open-input")!;
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    };

    pickInQuickOpen("s3", { ctrlKey: true });
    await flush();
    expect(tileTitles()).toEqual(["s1", "s3"]);
    expect(focusedTileTitle()).toBe("s3");

    pickInQuickOpen("s2", {});
    await flush();
    expect(tileTitles()).toEqual(["s1", "s3", "s2"]);
  });

  it("Ctrl+Shift+2 laesst die zweite Kachel aufleuchten, ein Klick hinein nicht", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    clearFlashes();
    // Ein Klick in die erste Kachel: auf den Kopf und ins Terminal.
    const first = tilesInOrder()[0];
    first
      .querySelector(".tile-title")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    first.querySelector(".tile-terminal")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(focusedTileTitle()).toBe("s1");
    expect(document.querySelector("#grid .tile--flash")).toBeNull();
    // Der Druck sagt die Kachel an (Spec §4.3), ohne sie aufleuchten zu lassen.
    expect(liveRegionText()).toBe("Terminal 1: s1");
    chord("2");
    expect(document.querySelector("#grid .tile--flash .tile-title")?.textContent).toBe("s2");
  });

  it("Ctrl+Shift+Pfeil laesst die Kachel aufleuchten, zu der der Fokus wandert, und sagt sie an", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    clearFlashes();

    chord("ArrowDown"); // Umlauf zur ersten Kachel
    expect(flashedTitles()).toEqual(["s1"]);
    expect(liveRegionText()).toBe("Terminal 1: s1");
  });

  it("eine neu angelegte Session leuchtet auf", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
      const args = rawArgs as Record<string, unknown> | undefined;
      if (command === "create_session") return "s9";
      if (command === "list_sessions") return args?.hostId === "r-h1" ? ["s1", "s2", "s9"] : ["s3"];
      if (command === "list_directories") return { path: "/tmp", entries: [] };
      return undefined;
    });
    hostActionButton("h1", "New session").click();
    await flush();
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>(".dialog-panel button")).find(
      (button) => button.textContent === "Create session",
    )!;
    submit.click();
    await flush(30);

    expect(tileTitles()).toEqual(["s9"]);
    expect(flashedTitles()).toEqual(["s9"]);
    expect(liveRegionText()).toBe("Terminal 1: s9");
  });
});

describe("main: Tastatur (Task 12) -- session.prev/next", () => {
  it("Ctrl+Shift+Down/Up fuehren den Fokus durch die Kacheln, mit Umlauf, und oeffnen nichts (Spec 2026-10-19 §5.7)", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    expandHost("h2");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    openViaSidebar("h2", "s3");
    expect(focusedTileTitle()).toBe("s3");

    // event.key ist "ArrowDown"/"ArrowUp" (echte Tastenschreibweise): prueft
    // die Pfeiltasten-Normalisierung in keymap.ts mit.
    chord("ArrowDown"); // Umlauf: nach der letzten Kachel kommt die erste
    expect(focusedTileTitle()).toBe("s1");
    chord("ArrowDown");
    expect(focusedTileTitle()).toBe("s2");
    chord("ArrowUp");
    expect(focusedTileTitle()).toBe("s1");
    chord("ArrowUp"); // Umlauf rueckwaerts
    expect(focusedTileTitle()).toBe("s3");
    expect(tileTitles()).toEqual(["s1", "s2", "s3"]);
  });

  it("Ctrl+Shift+PageUp/PageDown schieben die fokussierte Kachel (Spec 2026-10-19 §5.4)", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    chord("PageUp");
    expect(tileTitles()).toEqual(["s2", "s1"]);
    chord("PageDown");
    expect(tileTitles()).toEqual(["s1", "s2"]);
    expect(focusedTileTitle()).toBe("s2");
  });
});

describe("main: Tastatur (Task 12) -- die vier neuen Aktionen", () => {
  it("Ctrl+Shift+M maximiert die fokussierte Kachel, Escape stellt sie wieder her", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");

    expect(maximizedTileTitle()).toBeUndefined();
    chord("m");
    expect(maximizedTileTitle()).toBe("s1");
    escape();
    expect(maximizedTileTitle()).toBeUndefined();
  });

  it("Escape aus einem Ziel INNERHALB eines .xterm-Teilbaums laesst eine maximierte Kachel maximiert (Designsystem §7.4)", async () => {
    // Review-Nachtrag: `event.target.closest(".xterm")` prueft nur, ob
    // IRGENDEIN Vorfahre des Ereignisziels die Klasse "xterm" traegt -- ein
    // schlichtes Div reicht dafuer, ein echtes xterm.js ist nicht noetig
    // (`./terminal` ist in dieser Datei ohnehin komplett gemockt). xterm.js
    // selbst verschachtelt sein fokussierbares `<textarea>` immer INNERHALB
    // eines Wurzelelements mit genau dieser Klasse (`this.element.
    // classList.add("xterm")`, `node_modules/@xterm/xterm/lib/xterm.js`) --
    // diese Struktur hier nachgebildet.
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    chord("m");
    expect(maximizedTileTitle()).toBe("s1");

    const xtermRoot = document.createElement("div");
    xtermRoot.className = "xterm";
    const textarea = document.createElement("div");
    xtermRoot.appendChild(textarea);
    document.querySelector<HTMLElement>("#grid .tile.focused .tile-terminal")!.appendChild(xtermRoot);

    escapeFrom(textarea);

    // Ein laufendes vim in dieser Kachel bekommt sein eigenes Escape (nicht
    // Teil dieses Tests, siehe terminal.ts) -- die Kachel selbst darf sich
    // NICHT zusaetzlich wiederherstellen.
    expect(maximizedTileTitle()).toBe("s1");
  });

  it("Escape von AUSSERHALB des .xterm-Teilbaums stellt eine maximierte Kachel wieder her", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    chord("m");
    expect(maximizedTileTitle()).toBe("s1");

    // "Add host" (Seitenleistenfuss) liegt garantiert ausserhalb jedes
    // `.xterm`-Teilbaums.
    escapeFrom(document.querySelector<HTMLElement>(".sb-btn")!);

    expect(maximizedTileTitle()).toBeUndefined();
  });

  // UX-Spec §6.1: Strg+Umschalt+V im Terminal fuegt nativ ein. Chromium tut
  // das nur, wenn niemand `preventDefault` ruft -- auch nicht dieser
  // dokumentweite Akkord-Handler, den das keydown aus xterms Hilfstextfeld
  // heraus erreicht. Dieselbe `.xterm`-Nachbildung wie im Escape-Test oben.
  it("Strg+Umschalt+V aus einem .xterm-Ziel bleibt ohne preventDefault, ausserhalb nicht", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();

    const xtermRoot = document.createElement("div");
    xtermRoot.className = "xterm";
    const helperTextarea = document.createElement("textarea");
    xtermRoot.appendChild(helperTextarea);
    document.body.appendChild(xtermRoot);

    function chordFrom(target: EventTarget, key: string): KeyboardEvent {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    }

    expect(chordFrom(helperTextarea, "V").defaultPrevented).toBe(false);
    expect(chordFrom(document.body, "V").defaultPrevented).toBe(true);
    // Nur das Einfuegen ist ausgenommen: jeder andere Akkord aus dem
    // Terminal bleibt der App.
    expect(chordFrom(helperTextarea, "C").defaultPrevented).toBe(true);
  });

  it("Escape schliesst einen offenen Dialog, statt gleichzeitig eine maximierte Kachel wiederherzustellen", async () => {
    // Ist ein Dialog offen ODER eine Kachel maximiert, muss Escape das
    // jeweils Naheliegende tun -- bei BEIDEM gleichzeitig gewinnt der
    // Dialog (er liegt buchstaeblich oben).
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    chord("m");
    expect(maximizedTileTitle()).toBe("s1");

    document.querySelector<HTMLButtonElement>(".sb-btn")!.click(); // "Add host"
    await flush();
    expect(document.querySelector(".dialog-panel")).not.toBeNull();

    escape();

    expect(document.querySelector(".dialog-panel")).toBeNull(); // Dialog zu
    expect(maximizedTileTitle()).toBe("s1"); // Kachel bleibt maximiert
  });

  it("Akkorde bleiben wirkungslos, waehrend ein Dialog offen ist, und arbeiten danach normal weiter", async () => {
    await setupTwoHostsThreeSessions();
    // Ohne fokussierte Kachel bliebe Strg+Umschalt+M ohnehin wirkungslos.
    expandHost("h1");
    openViaSidebar("h1", "s1");
    chord("m");
    expect(maximizedTileTitle()).toBe("s1");

    document.querySelector<HTMLButtonElement>(".sb-btn")!.click();
    await flush();
    expect(document.querySelector(".dialog-panel")).not.toBeNull();

    chord("m"); // stellte sonst wieder her, muss aber wirkungslos bleiben
    expect(maximizedTileTitle()).toBe("s1");

    escape();
    expect(document.querySelector(".dialog-panel")).toBeNull();

    chord("m"); // Handler arbeitet nach dem Schliessen wieder normal
    expect(maximizedTileTitle()).toBeUndefined();
  });

  it("Ctrl+Shift+B blendet die Seitenleiste aus/ein; Ctrl+Shift+E blendet sie bei Bedarf ein und fokussiert sie", async () => {
    await setupTwoHostsThreeSessions();
    const app = document.getElementById("app")!;

    expect(app.classList.contains("sidebar-collapsed")).toBe(false);
    chord("b");
    expect(app.classList.contains("sidebar-collapsed")).toBe(true);
    chord("b");
    expect(app.classList.contains("sidebar-collapsed")).toBe(false);

    chord("b"); // wieder ausblenden, damit sidebar.focus das Einblenden zeigen muss
    expect(app.classList.contains("sidebar-collapsed")).toBe(true);
    chord("e");
    expect(app.classList.contains("sidebar-collapsed")).toBe(false);
    expect(document.getElementById("sidebar")!.contains(document.activeElement)).toBe(true);
    // Abschlussreview Task 5 (Important): das Zahnrad im Kopf (Task 5, UI v2
    // §7.2) ist seither ebenfalls ein `#sidebar`-Nachfahre -- die Zusage
    // oben allein liesse einen Regress unbemerkt, der Ctrl+Shift+E auf das
    // Zahnrad statt auf die Hostliste lenkt. `Ctrl+Shift+E` meint laut
    // Entwurf (§1.5) die Hostliste, nicht den Kopf.
    expect(document.activeElement).toBe(hostRow("h1"));
    expect(document.activeElement?.classList.contains("sb-head-btn")).toBe(false);
  });

  it("Ctrl+Shift+E landet ohne Hosts auf dem Add-Knopf im Kopf, nicht auf dem Zahnrad daneben", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();

    expect(document.querySelectorAll("#sidebar .row-host")).toHaveLength(0);
    chord("e");
    const addButton = document.querySelector<HTMLButtonElement>("#sidebar .sb-btn");
    expect(addButton).not.toBeNull();
    expect(document.activeElement).toBe(addButton);
    expect(document.activeElement?.classList.contains("sb-head-btn")).toBe(false);
  });

  it("schliesst ein offenes Hostmenue beim Einklappen der Seitenleiste", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    hostMenuButton("h1").click();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    chord("b");
    await flush();

    // Auf ABWESENHEIT, nicht auf Unsichtbarkeit: `display: none` allein
    // liesse die Horcher an `document`/`window` zurueck.
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  // Abschlussreview (Important): `closeMenu()` war NUR ueber den
  // Einklappweg erreichbar (`setSidebarCollapsed`). Bei einer bereits
  // ausgeklappten Seitenleiste lief der gar nicht -- Ctrl+Shift+E setzte den
  // Fokus auf die erste Hostzeile und liess das Menue offen zurueck.
  //
  // Die ABWESENHEIT des Menues ist hier die ganze Zusicherung, und das ist
  // Absicht: die Folge des Fehlers -- ein Escape, das statt des sichtbaren
  // Menues die maximierte Kachel zurueckholt -- laesst sich NICHT als
  // eigener Test fassen. Nach der Behebung gibt es kein Menue mehr, ein
  // Escape am Dokument holt die Kachel dann voellig zu Recht zurueck (das
  // ist `onMaximizedEscapeKeydown`s Zweck). Vorher wie nachher stellt das
  // Escape die Kachel wieder her; der einzige maschinell sichtbare
  // Unterschied ist, ob das Menue noch dasteht. Der Test darunter deckt die
  // andere Haelfte: solange das Menue steht, kommt das Escape gar nicht erst
  // am Dokument an.
  it("schliesst ein offenes Hostmenue auch beim Anspringen der ausgeklappten Seitenleiste", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    hostMenuButton("h1").click();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // AUSGEKLAPPT -- kein `chord("b")` davor. Genau der Weg, der
    // `setSidebarCollapsed` nicht beruehrt.
    expect(document.getElementById("app")!.classList.contains("sidebar-collapsed")).toBe(false);
    chord("e");
    await flush();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Der Fokusgriff darf davon unberuehrt bleiben: `closeMenu(false)` gibt
    // den Fokus nicht zurueck, `focusableElements(...)[0]` setzt ihn danach.
    expect(document.getElementById("sidebar")!.contains(document.activeElement)).toBe(true);
  });

  it("laesst bei Escape im Menue die maximierte Kachel gross", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    chord("m");
    await flush();
    hostMenuButton("h1").click();

    // Vom Menueeintrag aus, NICHT ueber `escape()` am Dokument: die Aussage
    // ist gerade, dass das Ereignis dort nie ankommt.
    document.querySelector<HTMLElement>('[role="menuitem"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(maximizedTileTitle()).toBe("s1");
  });
});

// UX-Spec §8.1, §8.2: die Browsertasten, das Browsermenue und die Akkorde in
// Feldern gelten in der echten Verdrahtung; die Einzelfaelle prueft
// `keyboard.test.ts`. Hier geht es darum, dass `main()` die Lauscher haengt und
// beim Abraeumen wieder abnimmt.
describe("main: Browsertasten und Tastenlauscher", () => {
  async function startWithoutHosts(): Promise<void> {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
  }

  function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  function rightClick(target: EventTarget): MouseEvent {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    target.dispatchEvent(event);
    return event;
  }

  it("haelt F5, Strg+R und das Browsermenue aus der App heraus", async () => {
    await startWithoutHosts();

    expect(press(document.body, { key: "F5" }).defaultPrevented).toBe(true);
    expect(press(document.body, { key: "r", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(rightClick(document.body).defaultPrevented).toBe(true);
  });

  it("laesst Strg+R dem Terminal, dem Textfeld sein Menue und seine Strg+Umschalt-Tasten", async () => {
    await startWithoutHosts();
    // Dieselbe `.xterm`-Nachbildung wie bei Strg+Umschalt+V oben.
    const xtermRoot = document.createElement("div");
    xtermRoot.className = "xterm";
    const helperTextarea = document.createElement("textarea");
    xtermRoot.appendChild(helperTextarea);
    const field = document.createElement("input");
    document.body.append(xtermRoot, field);

    expect(press(helperTextarea, { key: "r", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(rightClick(field).defaultPrevented).toBe(false);
    expect(press(field, { key: "ArrowLeft", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    // F5 ist auch im Feld verhindert; Strg+Umschalt+B hat eine Aktion und laeuft.
    expect(press(field, { key: "F5" }).defaultPrevented).toBe(true);
    expect(document.getElementById("app")!.classList.contains("sidebar-collapsed")).toBe(false);
    expect(press(field, { key: "B", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.getElementById("app")!.classList.contains("sidebar-collapsed")).toBe(true);
  });

  it("stopSessionStatusPoll nimmt die Tastenlauscher von document und window wieder ab", async () => {
    await startWithoutHosts();
    expect(press(document.body, { key: "F5" }).defaultPrevented).toBe(true);

    stopSessionStatusPoll();

    expect(press(document.body, { key: "F5" }).defaultPrevented).toBe(false);
    expect(rightClick(document.body).defaultPrevented).toBe(false);
  });

  // Der Escape-Lauscher uebergeht ein Ereignis mit `defaultPrevented`. Bliebe der
  // Lauscher eines frueheren Laufs am `document`, holte er seine eigene, noch
  // maximierte Kachel zuerst zurueck, riefe `preventDefault()`, und der aktuelle
  // Lauf ginge leer aus.
  it("Escape: ein frueherer main()-Lauf mit maximierter Kachel nimmt dem aktuellen das Ereignis nicht weg", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    chord("m");
    expect(maximizedTileTitle()).toBe("s1");

    // Zweiter Lauf auf frischem DOM; der erste bleibt maximiert zurueck.
    setupDom();
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    chord("m");
    expect(maximizedTileTitle()).toBe("s1");

    escape();

    expect(maximizedTileTitle()).toBeUndefined();
  });
});

// =====================================================================
// Abschlussreview (Important 5): Ctrl+Shift+N war app-weit TOT.
// `MountOptions.onNewSession` existierte in `terminal.ts`, aber `grid.ts`
// reichte nie einen Rueckruf durch, und `main.ts` liess `session.new` in
// `default: break` laufen -- der Akkord rief `preventDefault()` und tat
// nichts. Design §10: "legt eine Session auf dem Host der FOKUSSIERTEN
// Kachel an".
// =====================================================================

describe("main: Tastatur -- Ctrl+Shift+N legt eine Session auf dem Host der fokussierten Kachel an", () => {
  it("oeffnet den Sitzungsdialog fuer den Host der fokussierten Kachel und legt die Session dort an", async () => {
    await setupTwoHostsThreeSessions();

    // Bewusst h2 und nicht h1: bei h1 fielen "erster Host in state.hosts"
    // und "der wirklich gemeinte Host" zusammen -- eine Verwechslung waere
    // unsichtbar (dasselbe Argument wie in `app-state.test.ts`s lockInput-
    // Test).
    expandHost("h2");
    openViaSidebar("h2", "s3");
    await flush();
    expect(focusedTileTitle()).toBe("s3");

    chord("n");
    await flush();

    // Derselbe Dialog wie die "New session"-Schaltflaeche der Seitenleiste
    // (Design §6.4: "Beide Wege oeffnen denselben kleinen Dialog"), kein
    // zweiter Pfad.
    const panel = document.querySelector(".dialog-panel");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("h2");

    // Der Verzeichnisbaum im Dialog haengt an DERSELBEN Laufzeit-ID wie das
    // `create_session` unten. Das ist die einzige Stelle, an der die Wahl
    // zwischen den zwei ID-Raeumen ueberhaupt beobachtbar ist:
    // `session-dialog.test.ts` mountet mit einer erfundenen ID, und ob
    // `main.ts` die Laufzeit- oder die settings.toml-ID durchreicht, sieht
    // dort niemand.
    expect(invokeMock).toHaveBeenCalledWith(
      "list_directories",
      expect.objectContaining({ hostId: "r-h2" }),
    );

    const submit = Array.from(panel!.querySelectorAll("button")).find(
      (b) => b.textContent === "Create session",
    ) as HTMLButtonElement;
    submit.click();
    await flush(20);

    // Die LAUFZEIT-ID von h2, nicht die von h1 und nicht die
    // settings.toml-ID.
    expect(invokeMock).toHaveBeenCalledWith(
      "create_session",
      expect.objectContaining({ hostId: "r-h2" }),
    );
  });

});

// UX-Spec §7.9: der Zielhost von Strg+Umschalt+N ist der erste zutreffende aus
// (1) Host der fokussierten belegten Kachel, (2) Host der zuletzt fokussierten
// belegten Kachel, (3) aktiver Host der Seitenleiste, wenn verbunden, (4) der
// einzige verbundene Host, (5) sonst Schnelloeffnen mit der Vorgabe "New
// session". Schritt 1 deckt der Block darueber ab. Der Knopf "New session" im
// leeren Raster nimmt dieselbe Kette, damit sein Tooltip
// "New session (Ctrl+Shift+N)" stimmt.
describe("main: Strg+Umschalt+N findet einen Zielhost (UX-Spec §7.9)", () => {
  function dialogTitle(): string | undefined {
    return document.querySelector(".dialog-panel .dialog-head h2")?.textContent ?? undefined;
  }

  function tileElement(index: number): HTMLElement {
    return document.querySelector<HTMLElement>(`#grid .tile[data-position="${index}"]`)!;
  }

  it("Schritt 3: ohne Kachel der aktive verbundene Host der Seitenleiste", async () => {
    await setupTwoHostsThreeSessions();
    // Bewusst h2: h1 waere zugleich der erste Host und damit kein Beweis.
    hostRow("h2").focus();

    chord("n");
    await flush();

    expect(dialogTitle()).toBe("New session on h2");
    expect(invokeMock).toHaveBeenCalledWith("list_directories", expect.objectContaining({ hostId: "r-h2" }));
  });

  it("Schritt 4: ist der aktive Host der Seitenleiste getrennt, der einzige verbundene", async () => {
    await setupTwoHostsThreeSessions();
    hostActionButton("h1", "Disconnect").click();
    await flush(20);
    hostRow("h1").focus();

    chord("n");
    await flush();

    expect(dialogTitle()).toBe("New session on h2");
  });

  // Schritt 5: ohne verbundenen Host fuehrte die Vorgabe
  // "New session" ins Leere ("No matches"). Dann ohne Vorgabe -- die Zeilen
  // "Connect …" stehen vorn.
  it("Schritt 5: ohne verbundenen Host Schnelloeffnen ohne Vorgabe, 'Connect …' vorn", async () => {
    setupSavedHost();
    main();
    await flush();

    chord("n");
    await flush();

    expect(dialogTitle()).toBe("Quick open");
    const input = document.querySelector<HTMLInputElement>(".dialog-panel .quick-open-input")!;
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    const first = document.querySelector<HTMLElement>(".dialog-panel .quick-open-option")!;
    expect(first.querySelector(".quick-open-label")?.textContent).toBe("Connect h1");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(invokeMock).not.toHaveBeenCalledWith("list_directories", expect.anything());
  });

  it("Schritt 5 auch bei zwei verbundenen Hosts, wenn der aktive getrennt ist: die Liste bietet beide an", async () => {
    const entries = [
      hostEntry({ id: "s-h1", label: "h1", hostname: "10.0.0.1" }),
      hostEntry({ id: "s-h2", label: "h2", hostname: "10.0.0.2" }),
      hostEntry({ id: "s-h3", label: "h3", hostname: "10.0.0.3" }),
    ];
    let reservations = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve(entries);
      if (command === "begin_connect") return Promise.resolve(`r${++reservations}`);
      if (command === "list_sessions") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    await connectFromSidebar("h2");
    await connectFromSidebar("h3");
    // Der Zeiger der Seitenleiste steht auf h1, dem getrennten ersten Host.

    chord("n");
    await flush();

    expect(dialogTitle()).toBe("Quick open");
    expect(
      Array.from(document.querySelectorAll(".dialog-panel .quick-open-option .quick-open-label"), (label) => label.textContent),
    ).toEqual(["New session on h2", "New session on h3"]);
  });

  it("schliesst die fokussierte Kachel, bekommt die Nachbarkachel den Fokus, und Strg+Umschalt+N nimmt deren Host (Schritt 1, Spec 2026-10-19 §5.5)", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    expandHost("h2");
    openViaSidebar("h1", "s1");
    openViaSidebar("h2", "s3");
    await flush();
    expect(focusedTileTitle()).toBe("s3");

    chord("n");
    await flush();
    expect(dialogTitle()).toBe("New session on h2");
    escape();

    tileElement(1).querySelector<HTMLButtonElement>('.tile-btn[aria-label="Close terminal"]')!.click();
    await flush();
    expect(tileTitles()).toEqual(["s1"]);
    expect(focusedTileTitle()).toBe("s1");

    // Der Zeiger der Seitenleiste steht auf h2: ohne Fokus in der
    // Nachbarkachel naehme Schritt 3 diesen Host.
    hostRow("h2").focus();
    chord("n");
    await flush();
    expect(dialogTitle()).toBe("New session on h1");
  });

  it("der Knopf 'New session' im leeren Raster nimmt dieselbe Kette", async () => {
    await setupTwoHostsThreeSessions();
    hostRow("h2").focus();
    const button = document.querySelector<HTMLButtonElement>("#grid .grid-empty-card button.btn--primary")!;
    expect(button.title).toBe("New session (Ctrl+Shift+N)");

    // Wie am Fenster: der Klick nimmt dem Zeiger der Seitenleiste den Fokus,
    // der Zeiger selbst bleibt auf h2.
    button.focus();
    button.click();
    await flush();

    expect(dialogTitle()).toBe("New session on h2");
  });
});

// UX-Spec §7.4 (A-03): nach dem Oeffnen geht der Fokus ins Terminal. Das war
// bis hierher ein Zielklick, und die naechste Wahl aus der Seitenleiste ersetzte
// die eben geoeffnete Session, statt die naechste freie Kachel zu belegen.
describe("main: Kachelziel (UX-Spec §7.4, A-03)", () => {
  it("Layout 4: zwei Sessionwahlen aus der Seitenleiste belegen zwei Kacheln", async () => {
    terminalHoisted.focusMovesDom = true;
    await setupTwoHostsThreeSessions();
    expandHost("h1");

    openViaSidebar("h1", "s1");
    await flush();
    // Vorbedingung: der Fokus liegt wirklich im Terminal der ersten Kachel.
    expect(document.querySelector('#grid .tile[data-position="0"] .tile-terminal')!.contains(document.activeElement)).toBe(true);

    openViaSidebar("h1", "s2");
    await flush();

    expect(tileTitles()).toEqual(["s1", "s2"]);
  });
});

describe("main: globaler Fehlerhinweis ist im Ausgangszustand nicht sichtbar (Nachtrag A, zweiter Fund)", () => {
  // Derselbe Befund wie bei `host-key-prompt.ts`s Persistenzfehler-Banner
  // (siehe dessen Test): `mountGlobalErrorBanner` erzeugt den Banner mit
  // `hidden = true`, aber die (frueher ungated) `.global-error-banner`-Regel
  // in styles.css setzt `display: flex` bedingungslos -- eine Autoren-Regel
  // gewinnt gegen die `[hidden]`-UA-Regel immer, unabhaengig von der
  // Spezifitaet. Laedt deshalb den echten Inhalt von `src/styles.css`
  // (Muster aus `terminal.test.ts`), nicht eine Abschrift der Regel.
  beforeAll(() => {
    // @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar oben
    const cssText = readFileSync(path.resolve(process.cwd(), "src/styles.css"), "utf-8");
    const styleEl = document.createElement("style");
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);
  });

  it("hat computed display:none direkt nach dem Start, bevor je ein Fehler aufgetreten ist", async () => {
    invokeMock.mockImplementation((command: string) => {
      // `list_hosts: []` fuehrt zum Erststart im Rasterbereich
      // (`showFirstRunInGrid`) -- der ruft seinerseits `suggest_hosts`/
      // `list_ssh_keys` auf; ohne Array-Antworten hier wuerfe
      // `first-run.ts`/`host-form.ts` eine unbehandelte Ablehnung, die
      // nichts mit DIESEM Test zu tun hat.
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "suggest_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    const banner = document.querySelector(".global-error-banner") as HTMLElement;
    expect(banner).not.toBeNull();
    // Vorbedingung: das Attribut war schon vorher `true` -- der eigentliche
    // Fehler lag im CSS, nicht hier (siehe Kommentar oben).
    expect(banner.hidden).toBe(true);
    // Die eigentliche Zusicherung: die sichtbare Wirkung, nicht das Attribut.
    expect(getComputedStyle(banner).display).toBe("none");
  });

  // Nachtrag C (Befund 5): die ANDERE Haelfte derselben Regel. Der Test oben
  // bewacht nur "versteckt bleibt versteckt"; seit der
  // `:not([hidden])`-Umstellung traegt die Basisregel flex-abhaengige
  // Eigenschaften (`align-items`, `gap`), die stillschweigend wirkungslos
  // wuerden, ginge die `:not([hidden])`-Regel je verloren -- z. B. durch
  // einen versehentlich falsch geschriebenen Selektor. Dasselbe Paar
  // existiert fuer `.host-key-persist-failure-banner`
  // (`host-key-prompt.test.ts`); die dortige Begruendung, `main.test.ts`
  // decke diese Haelfte bereits ab, stimmte nicht: die uebrigen Tests hier
  // pruefen `textContent`/`hidden`, beide direkt per JS gesetzt und von der
  // Kaskade unabhaengig, und liegen in `describe`-Bloecken ohne Stylesheet.
  it("hat computed display:flex, sobald ein Fehler gezeigt wird", async () => {
    const entry = hostEntry();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([entry]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    const banner = document.querySelector(".global-error-banner") as HTMLElement;
    // Vorbedingung im selben Test: der Banner startet versteckt, der
    // Vergleich unten prueft also einen echten Uebergang.
    expect(getComputedStyle(banner).display).toBe("none");

    // Ein kurzer Weg zu `showGlobalError`: das Terminal einer geoeffneten
    // Session meldet einen Fehler (`GridOptions.onTerminalError`). Der Klick
    // auf eine Session eines getrennten Hosts fuehrt seit UX-Spec §7.3 nicht
    // mehr hierher -- er verbindet den Host --, und "New session" seit Task 16,
    // Punkt E auch nicht: der Knopf ist an einem getrennten Host deaktiviert.
    hostActionButton("h1", "Connect").click();
    await flush();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    terminalHoisted.errorByKey.get("r1/s1")!({ kind: "open", detail: "no terminal open for this session" });

    expect(banner.hidden).toBe(false);
    expect(getComputedStyle(banner).display).toBe("flex");
  });
});

describe("main: Probe nach einem verlorenen Terminal", () => {
  it("laesst den Host verbunden, wenn er noch antwortet", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    invokeMock.mockClear();

    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush(20);

    // Ursache 2/3 aus dem Entwurf: die Verbindung lebt, nur dieser Kanal ist
    // tot. Der Host darf dabei NICHT angeschwaerzt werden.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });

  it("zeigt einen Listenfehler ohne den Hosttransport als ausgefallen zu behaupten", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    invokeMock.mockImplementation((command: string) => {
      if (command === "list_sessions") return Promise.reject(new Error("transport closed"));
      return Promise.resolve(undefined);
    });

    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush(20);

    expect(hostIndicatorClass("h1")).toContain("ind-on");
    // Absicherung 4: der Fehlertext wird DURCHGEREICHT, nicht erfunden --
    // sonst hat "Copy diagnostics" nichts zu kopieren.
    expect(hostRow("h1").parentElement!.textContent).toContain("transport closed");
  });

  // B1, Teil 3: ein Kanal, der gar nicht erst entsteht. `open_terminal`
  // laeuft asynchron NACH dem Mount -- scheitert es (Session inzwischen weg,
  // Kanalgrenze erreicht), stand bisher nur ein globales Banner da, waehrend
  // die Kachel ein aufnahmebereites Terminal zeigte.
  it("sperrt die Kachel, wenn open_terminal nach dem Mount abgelehnt wird", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    invokeMock.mockClear();

    const strip = () =>
      Array.from(document.querySelectorAll<HTMLElement>("#grid .tile")).find(
        (el) => el.querySelector(".tile-title")?.textContent === "s1",
      )?.querySelector<HTMLElement>(".tile-lock");
    expect(strip()?.hidden).toBe(true);

    terminalHoisted.openFailedByKey.get("r-h1/s1")!();
    await flush(20);

    expect(strip()?.hidden).toBe(false);
    // Und ausdruecklich OHNE Probe, anders als bei `onConnectionLost`: dass
    // EIN `open_terminal` abgelehnt wurde, sagt ueber den Host nichts -- der
    // haeufigste Grund ist "diese tmux-Session gibt es nicht mehr", und der
    // Host antwortet dabei tadellos.
    expect(invokeMock.mock.calls.filter(([c]) => c === "list_sessions")).toHaveLength(0);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });

  it("eine Kanalgrenze nennt den eigenen Satz; die Kachel geht, statt als Disconnected zu bleiben (Spec 2026-10-19 §8.3)", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    const detail = "Terminal operation failed during Admission: Capacity";
    terminalHoisted.errorByKey.get("r-h1/s1")!({ kind: "open", detail });
    terminalHoisted.openFailedByKey.get("r-h1/s1")!();
    await flush(20);
    expect(tileTitles()).toEqual([]);
    const banner = document.querySelector<HTMLElement>(".global-error-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains("global-error-banner--neutral")).toBe(false);
    expect(banner.textContent).toContain("h1 has no free terminal channel right now. Close a terminal and try again.");
    expect(sessionButton("h1", "s1").querySelector(".ind-warn")).toBeNull();
  });

  it("fragt bei mehreren gleichzeitig verlorenen Terminals nur EINMAL nach", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    await flush();
    invokeMock.mockClear();

    // Der Normalfall bei einem echten Abriss: ALLE Terminals dieses Hosts
    // sterben zugleich. Ohne Absicherung 2 liefe je Kachel eine eigene
    // `list_sessions`-Runde ueber eine Verbindung, die vielleicht gar nicht
    // mehr antwortet.
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    terminalHoisted.lostByKey.get("r-h1/s2")!();
    await flush(20);

    const probes = invokeMock.mock.calls.filter(([c]) => c === "list_sessions");
    expect(probes).toHaveLength(1);
  });

  it("fragt gar nicht nach, wenn der Host nicht auf 'connected' steht", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    // "Disconnect" setzt den Zustand auf `disconnected`. Eine Probe wuerde
    // hier einen Zustand ueberschreiben, den der Nutzer gerade selbst
    // gewaehlt hat.
    hostActionButton("h1", "Disconnect").click();
    await flush(20);
    invokeMock.mockClear();

    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush(20);

    expect(invokeMock.mock.calls.filter(([c]) => c === "list_sessions")).toHaveLength(0);
  });

  it("schwaerzt einen inzwischen neu verbundenen Host nicht an", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    // Die Probe scheitert erst, NACHDEM der Nutzer neu verbunden hat: eine
    // langsame Ablehnung darf den frischen Zustand nicht ueberschreiben
    // (Absicherung 3, Generationswache).
    //
    // NUR der ERSTE `list_sessions`-Aufruf haengt, danach wird normal
    // geantwortet -- und `rejectProbe` bleibt damit die Ablehnung GENAU
    // dieser Probe. Der Entwurf legte den Fangarm bei jedem Aufruf neu, und
    // `onConnectHost` ruft nach erfolgreichem `connect_host` selbst
    // `refreshSessions` (main.ts): `rejectProbe` zeigte danach auf DESSEN
    // Zusage, die Ablehnung landete in `refreshSessions`s eigenem `catch`,
    // die Zusage der Probe blieb fuer immer offen -- `probeHost` waere nie
    // hinter sein `await` gekommen und der Test haette bestanden, ohne die
    // Wache je zu beruehren. Zaehler statt einer zweiten Zusage-Variable:
    // dasselbe Muster wie `connectCalls`/`listHostsCalls` weiter oben.
    let rejectProbe!: (reason: Error) => void;
    let sessionCalls = 0;
    invokeMock.mockImplementation((command: string, rawArgs?: unknown) => {
      const args = rawArgs as Record<string, unknown> | undefined;
      if (command === "list_sessions") {
        if (++sessionCalls > 1) return Promise.resolve(["s1", "s2"]);
        return new Promise((_resolve, reject) => {
          rejectProbe = reject;
        });
      }
      if (command === "begin_connect") return Promise.resolve("r-h1");
      if (command === "connect_host") {
        const spec = args?.spec as { hostname: string } | undefined;
        return Promise.resolve(spec?.hostname === "10.0.0.1" ? "r-h1" : "r-h2");
      }
      return Promise.resolve(undefined);
    });

    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();

    // Vorbedingung, damit dieser Test nicht still leer laufen kann: die
    // Probe ist tatsaechlich abgesetzt und haengt.
    expect(sessionCalls).toBe(1);

    hostActionButton("h1", "Disconnect").click();
    await flush(20);
    hostActionButton("h1", "Connect").click();
    await flush(20);

    // Zweite Vorbedingung: der Host steht wieder auf "connected". Damit ist
    // die zweite Wache (`state !== "connected"`) in DIESEM Augenblick
    // wirkungslos -- was unten haelt, kann nur die Generationswache sein.
    expect(hostIndicatorClass("h1")).toContain("ind-on");

    rejectProbe(new Error("zu spaet"));
    await flush(20);

    expect(hostIndicatorClass("h1")).not.toContain("ind-fail");
    // Abschlussreview (Befund 3): die negative Zusicherung allein waere auch
    // gruen, wenn die Zeile oder die Indikator-Klasse ganz verschwaende --
    // der gemeinte Endzustand steht deshalb POSITIV daneben. Die Vorbedingung
    // weiter oben deckt das nicht ab: sie laeuft VOR `rejectProbe`.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });

  it("schwaerzt einen Host nicht an, den der Nutzer waehrend der Probe getrennt hat", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    // Abschlussreview (Befund 2): der Fall der ZWEITEN Wache in `probeHost`
    // (`state !== "connected"` NACH dem `await`). Der Nutzer drueckt
    // "Disconnect", waehrend die Probe haengt, und verbindet NICHT neu. Die
    // Generationswache darueber kann das nicht auffangen:
    // `onDisconnectHost` erhoeht die Generation nur im `connecting`-Zweig,
    // ein verbundener Host wird ohne Generationswechsel getrennt.
    //
    // Dieselbe Mockform wie im Test darueber: NUR der ERSTE
    // `list_sessions`-Aufruf haengt, `rejectProbe` ist damit die Ablehnung
    // GENAU dieser Probe (siehe die dortige Begruendung).
    let rejectProbe!: (reason: Error) => void;
    let sessionCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        if (++sessionCalls > 1) return Promise.resolve(["s1", "s2"]);
        return new Promise((_resolve, reject) => {
          rejectProbe = reject;
        });
      }
      return Promise.resolve(undefined);
    });

    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();

    // Vorbedingung, damit dieser Test nicht still leer laufen kann: die Probe
    // ist tatsaechlich abgesetzt und haengt.
    expect(sessionCalls).toBe(1);

    hostActionButton("h1", "Disconnect").click();
    await flush(20);

    // Zweite Vorbedingung: der Host steht auf "disconnected" -- und die
    // Generation ist dabei NICHT gestiegen. Was unten haelt, kann also nur
    // die zweite Wache sein.
    expect(hostIndicatorClass("h1")).toContain("ind-off");

    rejectProbe(new Error("zu spaet"));
    await flush(20);

    // Der Nutzer hat diesen Zustand selbst gewaehlt; die Probe darf ihn nicht
    // in ein "failed" umschreiben, das nach einem Defekt aussieht.
    expect(hostIndicatorClass("h1")).not.toContain("ind-fail");
    expect(hostIndicatorClass("h1")).toContain("ind-off");
  });
});

describe("main: Frischewache der Sessionliste (Abschlussreview Important 1)", () => {
  it("laesst eine ueberholte list_sessions-Antwort die Kachel der neueren Session nicht schliessen", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s2");
    await flush();

    // Vorbedingung: die Kachel, um die es geht, ist tatsaechlich da.
    expect(tileTitles()).toContain("s2");

    // NUR der ERSTE `list_sessions`-Aufruf haengt (dasselbe Muster und
    // derselbe Grund wie im Generationswache-Test oben: ein bei jedem Aufruf
    // neu gelegter Fangarm zeigte am Ende auf die Zusage eines SPAETEREN
    // Aufrufs). Dieser erste ist der AELTERE Refresh, und er antwortet mit
    // der kuerzeren Liste -- dem Stand VOR `s2`.
    let resolveStale!: (names: string[]) => void;
    let sessionCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        if (++sessionCalls > 1) return Promise.resolve(["s1", "s2"]);
        return new Promise<string[]>((resolve) => {
          resolveStale = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    hostActionButton("h1", "Reload sessions").click();
    await flush();
    // Vorbedingung: der aeltere Refresh ist abgesetzt und haengt.
    expect(sessionCalls).toBe(1);

    // Der juengere Refresh laeuft ganz durch und schreibt die Liste MIT `s2`.
    // In der Anwendung ist dieses juengere Schreiben typischerweise
    // `createSession`s eigene `list_sessions`-Runde -- dieselbe Wache, ueber
    // dieselbe Tabelle, denn `createSession` schreibt ueber `writeSessions`.
    hostActionButton("h1", "Reload sessions").click();
    await flush(20);
    expect(sessionCalls).toBe(2);

    resolveStale(["s1"]);
    await flush(20);

    // Ohne die Wache schreibt die alte Antwort jetzt `["s1"]`: `s2` gilt als
    // verschwunden, `setSessions` schliesst ihre Kachel (dieses Paket, Task
    // 2), `grid.ts::reconcile` entsorgt den Handle und `close_terminal`
    // faellt -- das gerade geoeffnete Terminal des Nutzers ist weg.
    expect(tileTitles()).toContain("s2");
    // Und die Session steht auch in der Seitenleiste noch.
    expect(() => sessionButton("h1", "s2")).not.toThrow();
  });

  it("meldet einen ueberholten Refresh als GEGLUECKT -- die Probe schwaerzt den Host nicht an", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    let resolveStale!: (names: string[]) => void;
    let sessionCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        if (++sessionCalls > 1) return Promise.resolve(["s1", "s2"]);
        return new Promise<string[]>((resolve) => {
          resolveStale = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    // Der haengende Refresh gehoert hier der PROBE (verlorenes Terminal) --
    // sie ist der einzige Aufrufer, der den Rueckgabewert von
    // `refreshSessions` ueberhaupt auswertet.
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();
    expect(sessionCalls).toBe(1);

    // Ein juengeres Schreiben ueberholt die Probe ...
    hostActionButton("h1", "Reload sessions").click();
    await flush(20);
    expect(sessionCalls).toBe(2);

    // ... und dann antwortet der Host der Probe doch noch: ERFOLGREICH, nur
    // veraltet.
    resolveStale(["s1"]);
    await flush(20);

    // Der Host HAT geantwortet, er lebt. Meldete die Frischewache ihren
    // Verzicht auf das Schreiben als `{ ok: false }` (oder als einen dritten
    // Zustand, den `probeHost` als Fehlschlag deutet), waere sie ein NEUER
    // Weg, einen lebenden Host anzuschwaerzen -- genau die Fehlerklasse,
    // gegen die dieses Paket angetreten ist.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(hostIndicatorClass("h1")).not.toContain("ind-fail");
  });

  it("laesst die Kachel einer waehrend der Probe angelegten Session stehen", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    // Der Ablauf aus dem Befund, in seiner ECHTEN Form: das juengere
    // Schreiben ist `createSession`s eigene `list_sessions`-Runde, nicht ein
    // zweiter `refreshSessions`. Genau deshalb zaehlt die Wache GELANDETE
    // SCHREIBVORGAENGE und nicht abgesetzte Abfragen -- ein Zaehler, den nur
    // `refreshSessions` erhoeht, liefe an diesem Ablauf vorbei, und der Test
    // darueber (zwei Refreshes) wuerde das nicht merken.
    let resolveStale!: (names: string[]) => void;
    let sessionCalls = 0;
    invokeMock.mockImplementation((command: string, rawArgs?: unknown) => {
      const args = rawArgs as Record<string, unknown> | undefined;
      if (command === "list_sessions") {
        if (++sessionCalls > 1) return Promise.resolve(["s1", "s2", "s3new"]);
        return new Promise<string[]>((resolve) => {
          resolveStale = resolve;
        });
      }
      if (command === "create_session") return Promise.resolve("s3new");
      // Der Verzeichnisbaum des Dialogs ruft das beim Oeffnen; die generische
      // `undefined`-Antwort unten ergaebe eine unbehandelte Ablehnung, die
      // nichts mit diesem Test zu tun hat (siehe denselben Kommentar in
      // `setupTwoHostsThreeSessions`).
      if (command === "list_directories") {
        return Promise.resolve({ path: (args?.path as string) || "/tmp", entries: [] });
      }
      return Promise.resolve(undefined);
    });

    // Die Probe setzt ihre Abfrage ab und haengt (stockende Verbindung).
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush();
    expect(sessionCalls).toBe(1);

    // Der Nutzer legt in derselben Zeit eine Session an. Der Host steht noch
    // auf "connected", der Dialog geht also auf.
    hostActionButton("h1", "New session").click();
    await flush();
    const panel = document.querySelector(".dialog-panel");
    expect(panel).not.toBeNull();
    const submit = Array.from(panel!.querySelectorAll("button")).find(
      (b) => b.textContent === "Create session",
    ) as HTMLButtonElement;
    submit.click();
    await flush(20);

    // Vorbedingung: die neue Session hat ihre Kachel wirklich bekommen.
    expect(tileTitles()).toContain("s3new");

    // Jetzt landet die Antwort von vorher -- ohne `s3new`.
    resolveStale(["s1", "s2"]);
    await flush(20);

    expect(tileTitles()).toContain("s3new");
    expect(() => sessionButton("h1", "s3new")).not.toThrow();
    // Und der Host bleibt verbunden: die Probe hat eine Antwort bekommen.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });
});

// Validierung (Critical + M6): die zweite Haelfte desselben Befunds -- die
// BILDEBENE. `#host-key-prompt-root` und `#dialog-root` trugen beide
// `z-index: 100`, `.global-error-banner` lag mit 90 sogar unter beiden.
// Echtes Stapeln (wer malt ueber wem) ist unter jsdom nicht beobachtbar --
// der berechnete `z-index` selbst dagegen schon, solange er literal in der
// Datei steht (`getComputedStyle` loest `var()` unter jsdom NICHT auf, siehe
// den Kommentar an der Stapelleiter in styles.css). Geprueft wird deshalb
// die ORDNUNG der Ebenen, nicht ihre Zahlenwerte: ein spaeteres Verschieben
// der ganzen Leiter soll diesen Test nicht rot faerben, ein Gleichstand oder
// eine Umkehrung dagegen sofort.
//
// Laedt den ECHTEN Inhalt von `src/styles.css` (Muster aus
// `terminal.test.ts`), keine Abschrift.
describe("main: Critical + M6 -- die Stapelleiter in styles.css", () => {
  beforeAll(() => {
    // @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar oben
    const cssText = readFileSync(path.resolve(process.cwd(), "src/styles.css"), "utf-8");
    const styleEl = document.createElement("style");
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);
  });

  it("legt die TOFU-Rueckfrage ueber die Dialog-Ueberlagerung und beide Hinweisbanner darueber", () => {
    // Beide Wurzeln BEFUELLT: die Regeln haengen an `:not(:empty)`, eine
    // leere Wurzel traegt gar keinen z-index (und `Number("auto")` waere
    // NaN -- jeder Vergleich unten schluege dann fehl, was richtig ist).
    document.body.innerHTML = `
      <div id="host-key-prompt-root"><div class="host-key-prompt"></div></div>
      <div id="dialog-root"><div class="dialog-panel"></div></div>
      <div class="global-error-banner"></div>
      <div class="host-key-persist-failure-banner"></div>
    `;

    const layer = (selector: string): number => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      return Number(getComputedStyle(el).zIndex);
    };

    const dialog = layer("#dialog-root");
    const prompt = layer("#host-key-prompt-root");
    const errorBanner = layer(".global-error-banner");
    const persistBanner = layer(".host-key-persist-failure-banner");

    // Vorbedingung: alle vier Ebenen sind ueberhaupt gesetzt -- sonst
    // verglichen die Zusicherungen unten NaN mit NaN und behaupteten nichts.
    for (const value of [dialog, prompt, errorBanner, persistBanner]) {
      expect(Number.isNaN(value)).toBe(false);
    }

    // Der Critical: die Rueckfrage MUSS oben liegen, Gleichstand genuegt
    // nicht (bei Gleichstand gewinnt die Dokumentreihenfolge, und dort steht
    // `#dialog-root` hinten -- genau der gemeldete Fehler).
    expect(prompt).toBeGreaterThan(dialog);
    // M6: ein asynchron eintreffender Fehler darf hinter keiner der beiden
    // Ueberlagerungen landen.
    expect(errorBanner).toBeGreaterThan(dialog);
    expect(errorBanner).toBeGreaterThan(prompt);
    // Der Nachklang der Entscheidung aus Ebene 200 bleibt zuoberst.
    expect(persistBanner).toBeGreaterThan(errorBanner);
  });

  it("legt das Hostmenue ueber die klebende Hostzeile und unter die Dialog-Ueberlagerung", () => {
    document.body.innerHTML = `
      <div id="dialog-root"><div class="dialog-panel"></div></div>
      <div class="ab-row row-host"></div>
      <div class="sb-menu"></div>
    `;

    const layer = (selector: string): number => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      return Number(getComputedStyle(el).zIndex);
    };

    const dialog = layer("#dialog-root");
    const stickyHostRow = layer(".row-host");
    const hostMenu = layer(".sb-menu");

    // Vorbedingung wie oben: alle drei Ebenen sind ueberhaupt gesetzt --
    // sonst verglichen die Zusicherungen unten NaN mit NaN.
    for (const value of [dialog, stickyHostRow, hostMenu]) {
      expect(Number.isNaN(value)).toBe(false);
    }

    // Das Menue klappt aus der Knopfleiste heraus ueber die Sessionzeilen
    // UND ueber die klebende Hostzeile darunter -- ein Menue, durch das eine
    // angeheftete Zeile hindurchmalt, waere unlesbar.
    expect(hostMenu).toBeGreaterThan(stickyHostRow);
    // Und darunter: bei offenem Dialog ist `#app` inert, ein Menue kann dann
    // gar nicht offen sein -- bliebe doch eines stehen, muss der Dialog es
    // zudecken statt umgekehrt.
    expect(dialog).toBeGreaterThan(hostMenu);
  });
});

// --- Paket 2.5, Aufgabe 1: die Host-Identitaet steht still ---
//
// Bis hierher tauschte `onConnectHost` `host.id` gegen die Laufzeit-ID aus
// (`main.ts`, alter Kopfkommentar zu den zwei ID-Raeumen). Weil `host.id` in
// JEDEN Fokusschluessel der Seitenleiste und in JEDEN Kachelschluessel
// eingeht, verschob ein blosses Verbinden die Identitaet der Hostzeile unter
// dem Nutzer weg. Seit diesem Paket traegt `host.id` immer die
// settings.toml-ID, und die Laufzeit-ID lebt in `host.runtimeId` daneben.

/** Der "Retry"-Knopf der Hinweisleiste eines fehlgeschlagenen Hosts. Wirft
 * laut, statt still danebenzugreifen -- ohne Leiste pruefte der Test
 * darunter einen nie ausgeloesten Verbindungsversuch. */
function hostRetryButton(label: string): HTMLButtonElement {
  const block = hostRow(label).parentElement as HTMLElement;
  const button = Array.from(block.querySelectorAll<HTMLButtonElement>(".host-notice-link")).find(
    (b) => b.textContent === "Retry",
  );
  if (!button) throw new Error(`notice bar for host "${label}" has no Retry button`);
  return button;
}

/** Ein gespeicherter Host (settings.toml-ID "s1", Beschriftung "h1"), dessen
 * `connect_host` bei JEDEM Aufruf eine frische Laufzeit-ID ausstellt ("r1",
 * "r2", ...) -- genau wie `next_host_id()` im Backend. Die beiden ID-Raeume
 * fallen hier also nie zufaellig zusammen.
 *
 * `onLostProbe`: der wievielte `list_sessions`-Aufruf scheitern soll. Damit
 * laesst sich der Host ueber eine fehlschlagende Probe auf "failed" bringen,
 * OHNE dass seine Laufzeit-ID verworfen wird -- der einzige Weg, auf dem der
 * Trennschritt beim Wiederverbinden ueberhaupt beobachtbar ist. */
function setupSavedHost(
  opts: { failSessionCall?: number; hangConnectFrom?: number } = {},
): { connects: () => number } {
  let connects = 0;
  let sessionCalls = 0;
  invokeMock.mockImplementation((command: string, rawArgs?: unknown) => {
    const args = rawArgs as Record<string, unknown> | undefined;
    if (command === "list_hosts") return Promise.resolve([hostEntry()]);
    if (command === "list_ssh_keys") return Promise.resolve([]);
    if (command === "begin_connect") return Promise.resolve(`r${connects + 1}`);
    if (command === "connect_host") {
      // `hangConnectFrom`: ab diesem Versuch loest `connect_host` nie auf --
      // der Host bleibt auf "connecting" stehen, waehrend seine ALTE
      // Laufzeit-ID noch im Feld liegt. Anders ist dieser Zustand nicht
      // herstellbar, und ohne ihn ist der `connecting`-Zweig von
      // `onDisconnectHost` nicht pruefbar.
      connects++;
      if (opts.hangConnectFrom !== undefined && connects >= opts.hangConnectFrom) {
        return new Promise<string>(() => {});
      }
      return Promise.resolve(`r${connects}`);
    }
    if (command === "list_sessions") {
      if (++sessionCalls === opts.failSessionCall) return Promise.reject(new Error("connection is dead"));
      return Promise.resolve(["s1"]);
    }
    if (command === "create_session") return Promise.resolve("s2new");
    // Siehe `setupTwoHostsThreeSessions`: der Verzeichnisbaum des Dialogs
    // ruft das schon beim Oeffnen, die generische `undefined`-Antwort unten
    // ergaebe eine unbehandelte Ablehnung.
    if (command === "list_directories") {
      return Promise.resolve({ path: (args?.path as string) || "/tmp", entries: [] });
    }
    return Promise.resolve(undefined);
  });
  return { connects: () => connects };
}

describe("main: A1 -- die Host-Identitaet steht still", () => {
  it("laesst den Bezeichner der Hostzeile ueber einen erfolgreichen Verbindungsaufbau hinweg unveraendert und faehrt list_sessions trotzdem auf der Laufzeit-ID", async () => {
    setupSavedHost();
    main();
    await flush();

    // Vorbedingung: vor dem Verbinden traegt die Zeile die settings.toml-ID.
    expect(hostRow("h1").dataset.focusKey).toBe("host:s1:row");

    hostActionButton("h1", "Connect").click();
    await flush(20);

    // Vorbedingung: wirklich verbunden -- sonst entstuende gar keine
    // Laufzeit-ID und der Test pruefte den harmlosen Fall.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    // Der Kern: die Identitaet, an der SAEMTLICHE Fokus- und
    // Kachelschluessel haengen, steht still.
    expect(hostRow("h1").dataset.focusKey).toBe("host:s1:row");
    // Und der Aufruf, der eine LEBENDE VERBINDUNG meint, faehrt trotzdem auf
    // der Laufzeit-ID -- die Uebersetzung ist da, sie steht nur nicht mehr
    // in `host.id`.
    expect(invokeMock).toHaveBeenCalledWith("list_sessions", { hostId: "r1" });
    expect(invokeMock).not.toHaveBeenCalledWith("list_sessions", { hostId: "s1" });
  });

  it("haelt den Tastaturfokus auf dem Umschaltknopf, wenn der Host verbindet", async () => {
    setupSavedHost();
    main();
    await flush();

    const toggle = hostActionButton("h1", "Connect");
    toggle.focus();
    // Vorbedingung: der Fokus steht wirklich dort (jsdom fokussiert nur
    // Elemente, die im Dokument haengen).
    expect(document.activeElement).toBe(toggle);

    toggle.click();
    await flush(20);

    // Die Seitenleiste rettet den Fokus ueber ein Neuzeichnen per
    // `data-focus-key`-WERT (`sidebar.ts`). Wechselt `host.id` beim
    // Verbinden, findet sie den gemerkten Bezeichner im frisch gebauten
    // Baum nicht wieder und fokussiert -- bewusst -- gar nichts: der Fokus
    // faellt auf `<body>` zurueck, mitten in einer ganz gewoehnlichen
    // Bedienung.
    expect(document.activeElement).toBe(hostActionButton("h1", "Disconnect"));
  });

  it("trennt beim erneuten Verbinden die vorige Laufzeit-ID", async () => {
    // Der zweite Verbindungsaufbau MUSS ueber "failed" laufen, nicht ueber
    // Disconnect -> Connect: dort hat `onDisconnectHost` `disconnect_host`
    // bereits mit der alten Laufzeit-ID gerufen, die Zusicherung unten waere
    // auch ohne den neuen Trennschritt wahr und das Transport-Leck bliebe
    // ungepinnt.
    const fixture = setupSavedHost({ failSessionCall: 2 });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);

    // Vorbedingung: das Terminal haengt tatsaechlich an der ersten
    // Laufzeit-ID.
    const lost = terminalHoisted.lostByKey.get("r1/s1");
    expect(lost).toBeDefined();
    lost!();
    emitTransportLost("r1");
    await flush(20);

    // Vorbedingung: der Host ist nicht mehr verbunden -- und die Laufzeit-ID
    // "r1" ist dabei NICHT verworfen worden (Paket 1: die Kachel bleibt
    // stehen). Bis hierher darf nichts getrennt worden sein, sonst behauptete
    // die Zusicherung darunter nichts.
    expect(hostIndicatorClass("h1")).not.toContain("ind-on");
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });

    // Der Agent-Host wird selbst neu verbunden (UX-Spec §5.4); zwischen zwei
    // Versuchen ist "Connect" der Weg von Hand, wie sonst "Retry".
    hostActionButton("h1", "Connect").click();
    await flush(20);

    // Der Kern: die alte russh-Sitzung wird geschlossen. Ohne diesen Schritt
    // stapelt jeder Abriss-Retry-Zyklus eine Sitzung samt Keepalive bis zum
    // Programmende -- `disconnect_host_impl` ist die einzige Stelle, die
    // einen Transport aus der Backend-Tabelle nimmt.
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    // Vorbedingung zur Vorbedingung: es gab wirklich einen zweiten Versuch.
    expect(fixture.connects()).toBe(2);
  });

  // Der `connecting`-Zweig von `onDisconnectHost` kehrte frueher um, BEVOR er
  // raeumte. Das reichte, solange "connecting" nur den allerersten Aufbau
  // meinte -- ein Host kann aber sehr wohl mit einer ALTEN Laufzeit-ID und
  // offenen Kacheln in diesem Zustand stehen: Abriss -> "failed" -> "Retry".
  // Dann liess ein "Disconnect" den Transport liegen und die Kachel auf einer
  // toten Verbindung montiert (Gutachten zu diesem Paket).
  it("raeumt beim Trennen auch dann auf, wenn der Host gerade wieder verbindet", async () => {
    setupSavedHost({ failSessionCall: 2, hangConnectFrom: 2 });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    terminalHoisted.lostByKey.get("r1/s1")!();
    emitTransportLost("r1");
    await flush(20);
    expect(hostIndicatorClass("h1")).not.toContain("ind-on");

    // Wie im Test darueber: "Connect" ist waehrend des Neuverbindens der Weg
    // von Hand (UX-Spec §5.4).
    hostActionButton("h1", "Connect").click();
    await flush(20);

    // Vorbedingungen: der zweite Versuch haengt wirklich, die Kachel steht
    // noch, und getrennt wurde bis hierher nichts.
    expect(hostIndicatorClass("h1")).toContain("ind-connecting");
    expect(tileTitles()).toContain("s1");
    invokeMock.mockClear();

    hostActionButton("h1", "Disconnect").click();
    await flush(20);

    // Beides gehoert zusammen und ist genau das, was "trennen" in diesem
    // Programm heisst: der alte Transport geht zu, und die Kachel, die auf
    // ihm haengt, wird geraeumt.
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    expect(tileTitles()).not.toContain("s1");
  });

  it("trennt beim Entfernen auch einen fehlgeschlagenen Host", async () => {
    setupSavedHost({ failSessionCall: 2 });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    terminalHoisted.lostByKey.get("r1/s1")!();
    emitTransportLost("r1");
    await flush(20);
    // Auch waehrend des Neuverbindens (UX-Spec §5.4) traegt der Host noch "r1".
    expect(hostIndicatorClass("h1")).not.toContain("ind-on");

    hostMenuItem("h1", "Remove…").click();
    const confirmButton = Array.from(
      document.querySelectorAll<HTMLElement>(".host-confirm-remove button"),
    ).find((b) => b.textContent === "Remove");
    if (!confirmButton) throw new Error('confirm bar for host "h1" did not open');
    confirmButton.click();
    await flush(20);

    // Der Trennzweig deckte bislang nur "connected"/"connecting" -- ein
    // entfernter fehlgeschlagener Host liess seinen Transport liegen, ohne
    // dass ihn danach noch irgendeine Oberflaeche erreichen konnte.
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    expect(invokeMock).toHaveBeenCalledWith("remove_host", { id: "s1" });
  });

  // Aus dem Gutachten zu diesem Paket, und es war die gewichtigste Luecke:
  // saemtliche Tests darueber verbinden ueber die SEITENLEISTE. Der zweite
  // Weg, auf dem ein verbundener Host entsteht -- Erststart und
  // "+ Add host", beide ueber `handleHostReady` --, hielt die Invariante
  // ungeprueft. Ein wiedereingesetztes `host.id = runtimeId` blieb dort
  // unsichtbar, obwohl es das ganze Paket rueckgaengig macht.
  it("laesst auch auf dem 'Add host'-Weg die settings.toml-ID die Identitaet sein", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "suggest_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      if (command === "run_preflight") {
        return Promise.resolve({
          tmux_version: "3.4",
          has_base64: true,
          socket_dir_writable: true,
          blocking_problem: null,
        });
      }
      // `add_host` liefert den gespeicherten Eintrag MIT der
      // settings.toml-ID zurueck -- und die ist eine andere als "r1".
      if (command === "add_host") return Promise.resolve(hostEntry({ id: "s1", label: "h1" }));
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    // Erststart im Rasterbereich: kein Host gespeichert, das Formular steht
    // direkt da.
    const view = document.querySelector<HTMLElement>("#grid .host-form-view");
    if (!view) throw new Error("first-run form is not mounted in the grid area");
    fillHostForm(view, "192.0.2.10", "m", "22");
    chooseAgentAuth(view);
    view.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush(20);

    const continueButton = Array.from(document.querySelectorAll<HTMLButtonElement>("#grid button")).find(
      (b) => b.textContent === "Continue",
    );
    if (!continueButton) throw new Error("preflight did not offer 'Continue'");
    continueButton.click();
    await flush(20);

    // Dieselbe Zusicherung wie auf dem Seitenleisten-Weg, an genau derselben
    // beobachtbaren Stelle: der Bezeichner, an dem jeder Fokusschluessel
    // haengt, ist die settings.toml-ID.
    expect(hostRow("h1").dataset.focusKey).toBe("host:s1:row");
    // Und die Sessionliste faehrt trotzdem auf der Laufzeit-ID. Beide
    // Haelften zusammen: ohne die erste bliebe die Identitaet ungepruef,
    // ohne die zweite koennte `handleHostReady` die Uebersetzung verlieren
    // und die Liste bliebe still leer.
    expect(invokeMock).toHaveBeenCalledWith("list_sessions", { hostId: "r1" });
    expect(invokeMock).not.toHaveBeenCalledWith("list_sessions", { hostId: "s1" });
  });

  it("faehrt create_session auf der Laufzeit-ID, waehrend die Seitenleiste den Host unter der settings.toml-ID fuehrt", async () => {
    setupSavedHost();
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);

    hostActionButton("h1", "New session").click();
    await flush();
    const panel = document.querySelector(".dialog-panel");
    expect(panel).not.toBeNull();
    const submit = Array.from(panel!.querySelectorAll("button")).find(
      (b) => b.textContent === "Create session",
    ) as HTMLButtonElement;
    submit.click();
    await flush(20);

    // `name: null` seit B2 -- leer gelassen heisst "erzeug mir einen".
    expect(invokeMock).toHaveBeenCalledWith("create_session", {
      hostId: "r1",
      cwd: expect.any(String),
      name: null,
    });
    expect(hostRow("h1").dataset.focusKey).toBe("host:s1:row");
  });

  // B2, Test 9: der Fehlertyp kommt STRUKTURIERT an. Ohne ihn braeuchte das
  // Frontend eine Musterung auf Prosa, die das Backend formuliert -- eine
  // Kopplung, die bei der naechsten Formulierungsaenderung still bricht.
  it("zeigt fuer ein Namensduplikat einen ANDEREN Satz als fuer sonstige Fehler", async () => {
    async function createWith(error: unknown): Promise<string> {
      setupDom();
      setupSavedHost();
      main();
      await flush();
      hostActionButton("h1", "Connect").click();
      await flush(20);

      const previous = invokeMock.getMockImplementation();
      invokeMock.mockImplementation(((command: string, args: never) => {
        if (command === "create_session") return Promise.reject(error);
        // Der Verzeichnisbaum im Dialog laeuft weiter -- ohne diese Zeile
        // wirft er beim Auswerten einer undefinierten Antwort, und der Test
        // scheiterte an etwas ganz anderem als der Meldung.
        return previous?.(command, args) ?? Promise.resolve(undefined);
      }) as typeof invoke);

      hostActionButton("h1", "New session").click();
      await flush();
      const panel = document.querySelector(".dialog-panel")!;
      const nameField = panel.querySelector<HTMLInputElement>("input[name=sessionName]")!;
      nameField.value = "deploy";
      (
        Array.from(panel.querySelectorAll("button")).find(
          (b) => b.textContent === "Create session",
        ) as HTMLButtonElement
      ).click();
      await flush(20);
      return globalErrorText();
    }

    const duplicate = await createWith({
      kind: "duplicate",
      message: 'a session named "deploy" already exists on this host',
    });
    const other = await createWith({ kind: "other", message: "no route to host" });

    expect(duplicate).toContain("deploy");
    expect(duplicate).not.toBe(other);
    // Der Rohtext steht nicht mehr im Banner (UX-Spec §10), sondern in "Copy
    // details" -- geprueft im Block "die Meldungen nennen eine Handlung".
    expect(other).not.toContain("no route to host");
  });
});

// --- Paket 2.5, Aufgabe 3: `submitEdit` haelt den Trennvertrag ---
//
// `onDisconnectHost` definiert, was Trennen heisst: Kacheln raeumen, Zustand
// auf "disconnected", dann `invoke`. `submitEdit` rief nur das nackte
// `invoke` -- ohne beides. Scheitert danach `editHost` und ist der Eintrag
// noch gespeichert, stand der Host dauerhaft als "Connected", der Umschalter
// sagte "Disconnect", und die Kacheln zeigten normal aussehende Terminals,
// deren Kanaele das Backend laengst abgebaut hatte -- ohne
// `terminal://connection-lost` (derselbe Entfernen-vor-Schliessen-Weg wie
// `close_terminal_impl`), also auch ohne Sperrleiste.
//
// Seit Aufgabe 18 (UX-Spec §7.7) speichert "Save"
// ZUERST und trennt erst danach. Scheitert `update_host`, ist am Host nichts
// geschehen -- und genau das muss die Oberflaeche sagen: wirklich verbunden,
// die Kachel ohne Sperre.
describe("main: A3 -- ein gescheitertes 'Edit' laesst keinen scheinbar verbundenen Host zurueck", () => {
  it("laesst Verbindung und Kachel unberuehrt, wenn das Speichern scheitert", async () => {
    let connects = 0;
    invokeMock.mockImplementation((command: string, rawArgs?: unknown) => {
      const args = rawArgs as Record<string, unknown> | undefined;
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve(`r${connects + 1}`);
      if (command === "connect_host") return Promise.resolve(`r${++connects}`);
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      // A failed atomic update leaves the original saved host intact.
      if (command === "update_host") return Promise.reject(new Error("read-only file system"));
      if (command === "list_directories") {
        return Promise.resolve({ path: (args?.path as string) || "/tmp", entries: [] });
      }
      return Promise.resolve(undefined);
    });

    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);

    // Vorbedingungen: verbunden, mit einer sichtbaren Kachel -- ohne beides
    // koennte dieser Test seinen eigenen Titel nicht pruefen.
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(tileTitles()).toContain("s1");

    hostMenuItem("h1", "Edit…").click();
    await flush();
    submitEditForm("10.0.0.9");
    await flush(20);

    // Nichts getrennt: Host, Kachel und Terminal stehen, wie sie standen.
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", expect.anything());
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(tileTitles()).toContain("s1");
    const strip = Array.from(document.querySelectorAll<HTMLElement>("#grid .tile")).find(
      (tile) => tile.querySelector(".tile-title")?.textContent === "s1",
    )?.querySelector<HTMLElement>(".tile-lock");
    expect(strip?.hidden).toBe(true);
    // Und der Host ist noch da (der Eintrag ist ja gespeichert geblieben) --
    // sonst pruefte der Test oben nur, dass gar nichts mehr existiert.
    expect(() => hostRow("h1")).not.toThrow();
  });
});

// --- Paket 2.5, Aufgabe 4: dieselbe Frage, dieselbe Antwort ---
//
// "Darf diese Aktion auf einem nicht verbundenen Host laufen?" bekam an zwei
// Nachbar-Rueckrufen die gegenteilige Antwort: `onNewSession` faengt den Fall
// ab, das Oeffnen einer Sessionzeile reichte ungeprueft an
// `state.openSession` durch. Folge: die Kachel wird belegt (und verdraengt
// womoeglich eine LAUFENDE Session), die Seitenleiste zeigt gruen "Open", und
// im Kachelkopf stehen Titel und Hostname ueber einem leeren Rechteck.

/** Verbindet den gespeicherten Host, klappt ihn auf und trennt ihn wieder --
 * die Sessionzeilen bleiben dabei stehen (nur die Kacheln werden geraeumt).
 * Genau diese Vorrichtung braucht die Wache: ein getrennter Host mit LEERER
 * Sessionliste koennte sie nicht von "es ist ohnehin nichts zu oeffnen"
 * unterscheiden. */
async function connectExpandThenDisconnect(): Promise<void> {
  setupSavedHost();
  main();
  await flush();
  hostActionButton("h1", "Connect").click();
  await flush(20);
  expandHost("h1");
  hostActionButton("h1", "Disconnect").click();
  await flush(20);

  // Vorbedingungen: getrennt, und die Zeile ist trotzdem noch da.
  expect(hostIndicatorClass("h1")).toContain("ind-off");
  expect(() => sessionButton("h1", "s1")).not.toThrow();
  expect(tileTitles()).not.toContain("s1");
}

function globalErrorText(): string {
  return document.querySelector(".global-error-banner")?.textContent ?? "";
}

// --- Paket 2.5, Aufgabe 2: der Tastaturfokus folgt der Kachel ---
//
// Designsystem §7.5: "ist sie als Kachel sichtbar, FOLGT DER TASTATURFOKUS
// DORTHIN". §6.2 definiert die drei Fokussignale als "hier landen meine
// Tastendruecke". Beide Zusagen waren unwahr: `grid.ts` enthielt keinen
// einzigen `.focus()`-Aufruf. `Ctrl+Shift+2` verschob Kante, Kopf, Badge und
// `aria-current` -- und jeder Tastendruck landete weiter im vorigen Terminal.

/** Wie oft `focus()` auf dem Terminal dieser Session gerufen wurde.
 *
 * Gemessen wird durchweg in DIFFERENZEN, nie gegen einen absoluten Wert:
 * `main()` laeuft je Test frisch, aber Zusagen aus FRUEHEREN Tests dieser
 * Datei koennen waehrend eines `flush()` noch aufloesen und dabei die
 * Fortsetzung ihres eigenen (laengst vergessenen) `main()`-Laufs ausfuehren.
 * Ein absoluter Zaehler haette also von der Reihenfolge der Tests abgehangen
 * -- diese Datei mockt `./terminal` bewusst dateiweit. */
function focusCount(key: string): number {
  return terminalHoisted.focusCountByKey.get(key) ?? 0;
}

describe("main: A2 -- der Tastaturfokus folgt der Kachel", () => {
  it("legt den Fokus nach Ctrl+Shift+2 in das Terminal der zweiten sichtbaren Kachel", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");
    await flush();

    const beforeS1 = focusCount("r-h1/s1");
    const beforeS2 = focusCount("r-h1/s2");

    chord("2");
    await flush();

    expect(focusCount("r-h1/s2")).toBe(beforeS2 + 1);
    expect(focusCount("r-h1/s1")).toBe(beforeS1);
  });

  it("legt den Fokus in das frisch montierte Terminal, wenn eine Session aus der Seitenleiste geoeffnet wird", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    const before = focusCount("r-h1/s2");

    openViaSidebar("h1", "s2");
    await flush();

    expect(focusCount("r-h1/s2")).toBe(before + 1);
  });

  it("zieht den Fokus NICHT an sich, wenn im Hintergrund eine Sessionliste eintrifft", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    // Der Refresh wird abgesetzt und HAENGT -- so laesst sich der Fokus
    // danach dorthin legen, wo ihn der Nutzer haette, und die Antwort trifft
    // erst ein, wenn er dort steht. (Ein Klick auf "Reload sessions" nach dem
    // Fokussieren bewegte den Fokus im Fenster selbst; er taugt hier deshalb
    // nicht als Ausloeser.)
    let resolveList!: (names: string[]) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        return new Promise<string[]>((resolve) => {
          resolveList = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    hostActionButton("h1", "Reload sessions").click();
    await flush();

    // Vorbedingung, ohne die dieser Test nichts pruefen koennte: es gibt
    // ueberhaupt eine fokussierte Kachel mit montiertem Terminal. Bei
    // `focusedTile === null` (dem Startwert) waere auch die FALSCHE Umsetzung
    // -- bei jedem Neuzeichnen fokussieren -- ein Nichtstun, der Test waere
    // gruen und die Gegenprobe liefe leer.
    expect(state1FocusedTileHasTerminal()).toBe(true);
    const before = focusCount("r-h1/s1");
    const sidebarButton = hostActionButton("h1", "New session");
    sidebarButton.focus();
    expect(document.activeElement).toBe(sidebarButton);

    // Jetzt landet die Liste: ein vollstaendiges Neuzeichnen, ohne dass der
    // Nutzer irgendetwas getan haette.
    resolveList(["s1", "s2"]);
    await flush(20);

    // Der Fokuswunsch reist mit der AKTION, nicht mit dem Zustand. Ein
    // `focus()` in `render()`/`reconcile` bestuende die beiden Tests darueber
    // und risse dem Nutzer trotzdem mitten im Tippen den Cursor aus der
    // Seitenleiste.
    expect(focusCount("r-h1/s1")).toBe(before);
    expect(document.activeElement).toBe(hostActionButton("h1", "New session"));
  });
});

/** Traegt die Kachel, die gerade den Fokusrahmen zeigt, ueberhaupt eine
 * Session? Ueber das DOM gefragt, weil `main.test.ts` keinen Griff auf den
 * `AppState` dieses Laufs hat -- `.tile.focused` setzt `grid.ts` genau fuer
 * `state.focusedTile`, und ein nichtleerer Titel heisst, dass dort ein
 * Terminal montiert ist. */
function state1FocusedTileHasTerminal(): boolean {
  const title = document.querySelector("#grid .tile.focused .tile-title")?.textContent ?? "";
  return title.length > 0;
}

describe("main: A4 -- eine Session eines getrennten Hosts: die Tastatur oeffnet nichts, der Klick verbindet erst", () => {
  // UX-Spec §7.3 ersetzt die fruehere Meldung "Connect to 'h1' before opening
  // a session.": der Klick verbindet den Host wie "Connect" und oeffnet die
  // Session, sobald die Liste sie enthaelt.
  it("verbindet per Klick auf die Sessionzeile und oeffnet die Session danach, mit Fokus", async () => {
    await connectExpandThenDisconnect();
    const connects = () => invokeMock.mock.calls.filter(([command]) => command === "connect_host").length;
    expect(connects()).toBe(1);

    openViaSidebar("h1", "s1");
    await flush(30);

    expect(connects()).toBe(2);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(tileTitles()).toContain("s1");
    // Der Klick war die Absicht des Nutzers: der Fokus folgt in die Kachel.
    expect(focusCount("r2/s1")).toBe(1);
    expect(globalErrorText()).not.toContain("Connect to 'h1'");
  });

  it("session.next oeffnet nie eine Session, auch keine eines getrennten Hosts (Spec 2026-10-19 §5.7)", async () => {
    await connectExpandThenDisconnect();
    const connects = () => invokeMock.mock.calls.filter(([command]) => command === "connect_host").length;
    expect(connects()).toBe(1);

    chord("ArrowDown");
    await flush();

    expect(tileTitles()).toEqual([]);
    expect(connects()).toBe(1);
  });

  // Die zweite Haelfte derselben Frage, aus dem Gutachten zu diesem Paket:
  // die erste Fassung der Wache sperrte AUCH den Fall aus, in dem gar nichts
  // zu oeffnen ist. Beide Tests darueber fahren `disconnected` -- den einen
  // Zustand, in dem keine Kachel dieses Hosts sichtbar sein KANN. Der
  // schaedliche Fall ist `failed`: dort bleibt die Kachel mitsamt Sperrleiste
  // stehen (Zusage aus Paket 1), und genau zu ihr muss der Nutzer
  // zurueckkommen koennen.
  it("wechselt zu einer bereits sichtbaren Kachel, auch wenn der Host fehlgeschlagen ist", async () => {
    setupSavedHost({ failSessionCall: 2 });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    terminalHoisted.lostByKey.get("r1/s1")!();
    emitTransportLost("r1");
    await flush(20);

    // Vorbedingungen: Host ohne Verbindung (er wird selbst neu verbunden,
    // UX-Spec §5.4) UND die Kachel steht noch.
    expect(hostIndicatorClass("h1")).not.toContain("ind-on");
    expect(tileTitles()).toContain("s1");
    const before = focusCount("r1/s1");

    chord("1");
    await flush();

    // Kein Belegen, sondern ein reiner Fokuswechsel -- `assignTile` Punkt 1.
    // Die Wache darf hier nicht greifen, sonst ist die Kachel per Tastatur
    // unerreichbar und §7.5 gebrochen.
    expect(focusCount("r1/s1")).toBe(before + 1);
    expect(globalErrorText()).not.toContain("Connect to 'h1'");
    expect(tileTitles()).toContain("s1");
  });

  // Die drei Wachen, die den Backend-Aufruf gar nicht erst absetzen. Ohne
  // diese Tests liessen sie sich ersatzlos loeschen (Gutachten zu diesem
  // Paket): das Ergebnis waere zwar dasselbe -- das Backend antwortet auf
  // eine unbekannte ID mit "host not connected" --, aber jeweils ueber einen
  // sinnlosen IPC-Weg, und im Fall von `createSession` mit einer Meldung, die
  // der Nutzer nicht deuten kann.
  it("setzt fuer einen getrennten Host gar kein list_sessions ab", async () => {
    await connectExpandThenDisconnect();
    invokeMock.mockClear();

    // Seit Aufgabe 19, Fixrunde 1 (F) ist "Reload sessions" an einem
    // getrennten Host deaktiviert, ein echter Klick kommt nicht an. Die Wache
    // in `refreshSessions` bleibt die zweite Linie; ein ausgeloestes
    // Klickereignis erreicht den Horcher trotz `disabled` und prueft sie.
    const reload = hostActionButton("h1", "Reload sessions");
    expect(reload.disabled).toBe(true);
    reload.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush(20);

    expect(invokeMock).not.toHaveBeenCalledWith("list_sessions", expect.anything());
  });

  it("setzt kein create_session ab, wenn der Host waehrend des offenen Dialogs wegbricht", async () => {
    setupSavedHost();
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    hostActionButton("h1", "New session").click();
    await flush();
    const panel = document.querySelector(".dialog-panel");
    expect(panel).not.toBeNull();

    // Der Dialog steht -- und in dieser Zeit trennt der Nutzer den Host
    // ueber die Seitenleiste. Genau das Fenster, in dem `createSession` mit
    // einem Host ohne Laufzeit-ID aufgerufen werden kann.
    hostActionButton("h1", "Disconnect").click();
    await flush(20);
    invokeMock.mockClear();

    const submit = Array.from(panel!.querySelectorAll("button")).find(
      (b) => b.textContent === "Create session",
    ) as HTMLButtonElement;
    submit.click();
    await flush(20);

    expect(invokeMock).not.toHaveBeenCalledWith("create_session", expect.anything());
    expect(globalErrorText()).toContain("Connect to 'h1'");
  });
});

// B4, Test 3: drei Meldungen waren in KEINEM Test gepinnt --
// `session.error`, `terminal.openFailed` und `app.hostsLoadFailed`. Genau
// die drei, die den Rohtext des Backends als erste Zeile zeigten. Ein
// Textdurchgang ohne Deckung koennte sie beim naechsten Mal wieder
// verlieren, ohne dass etwas rot wird.
//
// Geprueft wird beides: die HANDLUNG steht im Banner, der Rohtext bleibt
// erreichbar -- seit UX-Spec §10 nur noch ueber "Copy details" am Banner,
// nicht mehr im sichtbaren Satz. Nur das eine zu pruefen liesse die jeweils
// andere Haelfte still verschwinden. Den Schluessel `app.hostsLoadFailed` gibt
// es seither nicht mehr: dort steht der Satz des Backends ganz.
describe("main: B4 -- die Meldungen nennen eine Handlung und behalten den Rohtext", () => {
  let written: string[] = [];
  beforeEach(() => {
    written = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  /** Nur der Satz des Banners, ohne die Beschriftungen seiner Knoepfe. */
  function bannerMessage(): string {
    return document.querySelector(".global-error-banner > span")?.textContent ?? "";
  }
  function copyDetailsButton(): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(".global-error-banner button")).find(
      (b) => b.textContent === "Copy details",
    );
  }
  /** Klickt "Copy details" und liefert, was in der Zwischenablage landet. */
  async function copyDetails(): Promise<string | undefined> {
    const button = copyDetailsButton();
    expect(button?.hidden).toBe(false);
    button!.click();
    await flush();
    return written[written.length - 1];
  }

  it("session.error: sagt, was zu tun ist; der Backend-Text steht in Copy details", async () => {
    setupDom();
    setupSavedHost();
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);

    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "create_session") {
        return Promise.reject({ kind: "other", message: "no route to host" });
      }
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);

    hostActionButton("h1", "New session").click();
    await flush();
    const panel = document.querySelector(".dialog-panel")!;
    (
      Array.from(panel.querySelectorAll("button")).find(
        (b) => b.textContent === "Create session",
      ) as HTMLButtonElement
    ).click();
    await flush(20);

    expect(bannerMessage()).toBe("Could not create the session. Check that the host is still connected, then try again.");
    expect(await copyDetails()).toBe(`${appVersionLine()}\nno route to host`);
  });

  it("terminal.openFailed: nennt die Session und was zu tun ist; der Backend-Text steht in Copy details", async () => {
    setupDom();
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    // Der Weg, auf dem diese Meldung im Betrieb entsteht: `terminal.ts`
    // reicht die Ablehnung von `open_terminal` an `onTerminalError` weiter.
    terminalHoisted.errorByKey.get("r-h1/s1")!({ kind: "open", detail: "no terminal open for this session" });
    await flush();

    expect(bannerMessage()).toBe("Couldn't open 's1'. It may have ended on the host — reload sessions and try again.");
    expect(await copyDetails()).toBe(`${appVersionLine()}\nno terminal open for this session`);
  });

  it("terminal.capacity: nennt den Host und was zu tun ist; der Backend-Text steht in Copy details (Spec 2026-10-19 §8.3)", async () => {
    setupDom();
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    const detail = "too many terminal setups are already pending for this host";
    terminalHoisted.errorByKey.get("r-h1/s1")!({ kind: "open", detail });
    terminalHoisted.openFailedByKey.get("r-h1/s1")!();
    await flush(20);

    expect(bannerMessage()).toBe("h1 has no free terminal channel right now. Close a terminal and try again.");
    expect(await copyDetails()).toBe(`${appVersionLine()}\n${detail}`);
  });

  // UX-Spec §6.9: frueher landete jeder Fehler aus `terminal.ts` im Text fuers
  // Oeffnen, auch ein abgelehntes Kopieren.
  it("ein Kopierfehler zeigt den Text fuers Kopieren, nicht den fuers Oeffnen", async () => {
    setupDom();
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    terminalHoisted.errorByKey.get("r-h1/s1")!({ kind: "copy", detail: "NotAllowedError: Document is not focused." });
    await flush();

    expect(bannerMessage()).toBe("Couldn't copy to the clipboard.");
    expect(globalErrorText()).not.toContain("Couldn't open");
    expect(await copyDetails()).toBe(`${appVersionLine()}\nNotAllowedError: Document is not focused.`);
  });

  // Wie das Beenden ausging, ist nicht immer bekannt (`outcome_unknown`): der
  // Satz behauptet deshalb nicht selbst, die Session laufe noch, und zeigt den
  // Satz des Backends, der sagt, was zu tun ist.
  it("session.killFailed: nennt die Session und den Grund des Backends, ohne eigene Behauptung", async () => {
    const OUTCOME_UNKNOWN =
      "The remote operation may have taken effect, but its final outcome could not be confirmed. " +
      "Refresh the session list before trying again. command timed out";
    setupDom();
    await setupTwoHostsThreeSessions();
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "kill_session") return Promise.reject(OUTCOME_UNKNOWN);
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);
    expandHost("h1");
    const row = () => sessionButton("h1", "s1").closest(".sb-session-row") as HTMLElement;
    row().querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    row().querySelector<HTMLButtonElement>(".session-confirm-kill .host-confirm-btn-danger")!.click();
    await flush(20);

    expect(bannerMessage()).toBe(`Couldn't confirm that the session 's1' ended: ${OUTCOME_UNKNOWN}`);
    expect(bannerMessage()).not.toContain("is still running");
    expect(await copyDetails()).toBe(`${appVersionLine()}\n${OUTCOME_UNKNOWN}`);
  });

  // Der Satz des Backends nennt Ursache und Pfad -- ohne ihn wuesste niemand,
  // welche Datei warum nicht geschrieben werden konnte.
  it("sidebar.removeFailed: zeigt den Grund des Backends im Satz", async () => {
    const CAUSE = "could not replace C:\\x\\settings.toml: Access is denied. (os error 5)";
    setupDom();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "remove_host") return Promise.reject(CAUSE);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostMenuItem("h1", "Remove…").click();
    document.querySelector<HTMLButtonElement>(".host-confirm-btn-danger")!.click();
    await flush(20);

    expect(bannerMessage()).toBe(`Could not remove 'h1': ${CAUSE}. The saved host was kept and is disconnected.`);
    expect(await copyDetails()).toBe(`${appVersionLine()}\n${CAUSE}`);
  });

  // `outcome_unknown`: das Anlegen hat vielleicht gewirkt. "Try again" ohne
  // Blick in die Liste legte eine zweite Session an -- der Satz des Backends
  // sagt, erst die Liste neu zu laden, und steht deshalb ganz da.
  it("session.error bei outcome_unknown: zeigt den Satz des Backends ganz, ohne 'try again'", async () => {
    const OUTCOME_UNKNOWN =
      "The remote operation may have taken effect, but its final outcome could not be confirmed. " +
      "Refresh the session list before trying again. command timed out";
    setupDom();
    setupSavedHost();
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "create_session") return Promise.reject({ kind: "outcome_unknown", message: OUTCOME_UNKNOWN });
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);

    hostActionButton("h1", "New session").click();
    await flush();
    (
      Array.from(document.querySelector(".dialog-panel")!.querySelectorAll("button")).find(
        (b) => b.textContent === "Create session",
      ) as HTMLButtonElement
    ).click();
    await flush(20);

    expect(bannerMessage()).toBe(OUTCOME_UNKNOWN);
    expect(bannerMessage()).not.toContain("then try again");
  });

  it("ein Banner ohne Backend-Text bietet kein Copy details an", async () => {
    setupDom();
    listenMock.mockImplementation((eventName, handler) => {
      listeners.set(eventName, handler as (event: { payload: unknown }) => void);
      return eventName === "terminal://transport-lost" ? Promise.reject(new Error("listen failed")) : Promise.resolve(vi.fn());
    });
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    main();
    await flush(20);

    expect(bannerMessage()).toBe("Host key confirmation is unavailable. Restart aidevbridge before connecting.");
    expect(copyDetailsButton()?.hidden).toBe(true);
  });

  // Das Backend schickt einen ganzen Satz (`could not load <path>: <reason>`,
  // auch fuer die neuere Datei), und das Frontend zeigt ihn ganz -- ohne
  // zweiten Satz davor oder dahinter, der fuer die neuere Datei falsch waere.
  it("unlesbare Einstellungsdatei: zeigt den Satz des Backends ganz", async () => {
    setupDom();
    const sentence =
      "could not load C:\\Users\\x\\AppData\\Roaming\\io.github.itbrain258.aidevbridge\\settings.toml: Your settings were saved by a newer " +
      "aidevbridge. Update aidevbridge to use them — the file was not changed.";
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.reject(sentence);
      return Promise.resolve(undefined);
    });
    main();
    await flush(20);

    expect(document.querySelector("#grid [role=alert]")?.textContent).toBe(sentence);
  });

  // UX-Spec §10: fuer eine abgelaufene Hostschluesselfrage genau EIN sichtbarer
  // Text -- ihn liefert das Backend mit `connect_timeout`, und er steht dort,
  // wo jeder Verbindungsfehler steht. Die Rueckfrage selbst schliesst still.
  // Der Hinweis der Seitenleiste ist kein Alert (er wird bei jedem Neuzeichnen
  // neu gebaut); angesagt wird der Satz deshalb einmal ueber die hoefliche
  // Live-Region, wie frueher ueber die Meldung der Rueckfrage.
  const EXPIRED = "The host key wasn't confirmed in time, so aidevbridge didn't connect.";

  function expireHostKeyPrompt(request: HostKeyRequestLike): void {
    // Das Backend gibt die Frage auf: erst das Ereignis, dann die Antwort auf
    // `connect_host`.
    listeners.get("hostkey://request-closed")?.({
      payload: { request_id: request.request_id, expires_at_unix_ms: request.expires_at_unix_ms, reason: "expired" },
    });
  }

  function politeRegionsWith(text: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[aria-live="polite"]')).filter(
      (region) => region.textContent === text,
    );
  }

  it("eine abgelaufene Hostschluesselfrage zeigt genau einen Text, den aus §10, und sagt ihn einmal an", async () => {
    let failConnect!: (error: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return new Promise<string>((_, reject) => { failConnect = reject; });
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    const request = hostKeyRequest({ host: "10.0.0.1", port: 22 });
    emitHostKeyRequest(request);
    await flush();
    expect(document.querySelector(".host-key-prompt")).not.toBeNull();

    expireHostKeyPrompt(request);
    failConnect({ code: "connect_timeout", message: EXPIRED });
    await flush(20);

    expect(document.getElementById("host-key-prompt-root")!.textContent).toBe("");
    // Sichtbar genau einmal: im Hinweis der Seitenleiste.
    expect(hostRow("h1").parentElement!.querySelector(".host-notice-message")?.textContent).toBe(EXPIRED);
    // Angesagt genau einmal: die hoefliche Live-Region ausserhalb von #app, kein Alert.
    const live = politeRegionsWith(EXPIRED);
    expect(live).toHaveLength(1);
    expect(document.getElementById("app")!.contains(live[0])).toBe(false);
    expect(Array.from(document.querySelectorAll('[role="alert"]')).some((n) => n.textContent?.includes(EXPIRED))).toBe(false);
    // Ein spaeteres Neuzeichnen (hier das Aufklappen) leert die Ansage nicht --
    // geleert wird nur die Zahl der Wartenden, wenn niemand mehr wartet.
    expandHost("h1");
    expect(politeRegionsWith(EXPIRED)).toHaveLength(1);
  });

  // Erststart und "Add host" sagen den Satz schon ueber ihre Alert-Zeile an;
  // die Live-Region schweigt dort, sonst kaeme er zweimal.
  it("auf dem Weg des Erststarts sagt nur die Alert-Zeile die abgelaufene Frage an", async () => {
    let failConnect!: (error: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "suggest_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return new Promise<string>((_, reject) => { failConnect = reject; });
      return Promise.resolve(undefined);
    });
    main();
    await flush(20);
    const view = document.querySelector<HTMLElement>("#grid .host-form-view")!;
    fillHostForm(view, "192.0.2.10", "m", "22");
    chooseAgentAuth(view);
    view.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush(20);
    const request = hostKeyRequest({ host: "192.0.2.10", port: 22 });
    emitHostKeyRequest(request);
    await flush();

    expireHostKeyPrompt(request);
    failConnect({ code: "connect_timeout", message: EXPIRED });
    await flush(20);

    expect(document.querySelector("#grid .first-run-card > p[role=alert]")?.textContent).toBe(EXPIRED);
    expect(politeRegionsWith(EXPIRED)).toEqual([]);
  });
});

// B4, Test 4: Seitenleiste und Kachel duerfen sich nicht widersprechen.
//
// Nachpruefbares Kriterium statt Absichtserklaerung, und ausdruecklich NICHT
// ueber die Wortlaute: der 32-px-Streifen traegt einen Satz, das
// Meta-Label der Seitenleistenzeile ein kurzes Wort -- sie DUERFEN
// verschieden klingen. Gleich sein muss der ZUSTAND, den beide zeigen.
//
// Die Fehlerklasse dahinter ist real: es gibt ZWEI i18n-Schluessel
// (`sidebar.state.inputLocked` und `tile.inputLocked`), und wer nur einen
// aendert, bekommt zwei Ansichten, die dasselbe verschieden behaupten --
// ohne dass ein Test rot wird, denn jeder pinnt seinen eigenen.
describe("main: B4 -- Seitenleiste und Kachel zeigen denselben Zustand", () => {
  const sidebarWarn = () =>
    sessionButton("h1", "s1").querySelector(".ind-warn") !== null;
  const tileStrip = () =>
    Array.from(document.querySelectorAll<HTMLElement>("#grid .tile")).find(
      (el) => el.querySelector(".tile-title")?.textContent === "s1",
    )?.querySelector<HTMLElement>(".tile-lock")?.hidden === false;

  it("zeigt Warndreieck UND Sperrstreifen zusammen, und keines von beidem ohne Sperre", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    // Ausgangszustand: beide sagen "nicht gesperrt".
    expect(sidebarWarn()).toBe(false);
    expect(tileStrip()).toBe(false);

    // Ein verlorener Kanal sperrt bei lebendem Host nicht mehr, die Kachel
    // haengt sich still neu an (UX-Spec §5.5) -- und auch dabei sagen beide
    // dasselbe: nicht gesperrt.
    terminalHoisted.lostByKey.get("r-h1/s1")!();
    await flush(20);
    expect(sidebarWarn()).toBe(false);
    expect(tileStrip()).toBe(false);

    // Gesperrt wird ein Kanal, der gar nicht erst aufgeht.
    terminalHoisted.openFailedByKey.get("r-h1/s1")!();
    await flush(20);

    // Und jetzt beide dasselbe -- nicht die eine ohne die andere.

    expect(sidebarWarn()).toBe(true);
    expect(tileStrip()).toBe(true);
  });

  // UX-Spec §5.4: waehrend die App den Host selbst neu verbindet, ist alles
  // ruhig -- Hostzeile, Kachel und Sessionzeile; erst wenn die Reihe ohne
  // Verbindung endet, zeigen Seitenleiste und Kachel wieder gemeinsam die Sperre.
  it("zeigt waehrend des Neuverbindens weder Warndreieck noch Sperrstreifen, danach beide", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    const previous = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(((command: string, args: never) => command === "connect_host"
      ? Promise.reject({ code: "auth_rejected", message: "The agent has no key for this host." })
      : previous(command, args)) as typeof invoke);

    emitTransportLost("r-h1");
    await flush(20);
    expect(hostRow("h1").parentElement!.querySelector(".host-quiet")).not.toBeNull();
    expect(sidebarWarn()).toBe(false);
    expect(tileStrip()).toBe(false);

    // Der Versuch scheitert an der Anmeldung: die Reihe endet.
    window.dispatchEvent(new Event("focus"));
    await flush(20);
    expect(hostRow("h1").parentElement!.querySelector(".host-quiet")).toBeNull();
    expect(sidebarWarn()).toBe(true);
    expect(tileStrip()).toBe(true);
  });
});

// Die beiden Fehlerpfade von `killSession`. Sie waren nach dem
// Gutachten-Fixdurchgang ungedeckt: B4s Deckungsgegenprobe (jeden Schluessel
// auf Unsinn setzen) blieb fuer `session.killFailed` UND
// `session.killedListStale` gruen -- gemessen, nicht vermutet.
describe("main: B3 -- was passiert, wenn das Beenden schiefgeht", () => {
  async function killFirstSession(): Promise<void> {
    expandHost("h1");
    const row = () => sessionButton("h1", "s1").closest(".sb-session-row") as HTMLElement;
    row().querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    // NEU abgefragt: der Klick oben hat ein `render()` ausgeloest, die alte
    // Referenz haengt seither in einem abgehaengten Baum -- dieselbe Regel,
    // die `sidebar.ts` fuer seine eigenen Fokusrettungen niederlegt (ueber
    // WERTE suchen, nie ueber gemerkte Elemente).
    row()
      .querySelector<HTMLButtonElement>(".session-confirm-kill .host-confirm-btn-danger")!
      .click();
    await flush(20);
  }

  it("nennt nach einem gescheiterten kill_session die Session und den Grund des Backends", async () => {
    await setupTwoHostsThreeSessions();
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "kill_session") {
        return Promise.reject("the session is still running on the host");
      }
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);

    await killFirstSession();

    // Die Kachel ist zu -- das Backend hat den Kanal vor dem Toeten
    // geschlossen, ein stehengelassenes Terminal waere ein totes. Ob die
    // Session noch laeuft, weiss nur das Backend: die Meldung nennt die Session
    // und seinen Satz, statt es selbst zu behaupten.
    expect(document.querySelector(".global-error-banner > span")?.textContent).toBe(
      "Couldn't confirm that the session 's1' ended: the session is still running on the host",
    );
  });

  it("meldet KEIN gescheitertes Beenden, wenn nur das Nachladen der Liste scheitert", async () => {
    await setupTwoHostsThreeSessions();
    const previous = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "kill_session") return Promise.resolve(undefined);
      if (command === "list_sessions") return Promise.reject("network hiccup");
      return previous?.(command, args) ?? Promise.resolve(undefined);
    }) as typeof invoke);

    await killFirstSession();

    // Die Sitzung IST beendet. Ein "Could not end the session" schickte den
    // Nutzer auf die Suche nach einem Problem, das es nicht gibt.
    expect(globalErrorText()).not.toContain("Could not end");
    expect(globalErrorText()).toContain("Reload sessions");
  });
});

// =====================================================================
// Task 8 (Spec §4.8): `HostEntry.auth_kind` unterscheidet seit diesem Task
// einen per Passwort gespeicherten Host von einem ssh-agent-Host -- vorher
// verdrahtete `onConnectHost` `password: null` fest, und ein per Passwort
// angelegter Host fiel nach dem naechsten Programmstart still auf ssh-agent
// zurueck (kein Fehler, keine Meldung -- nur eine Verbindung, die nie
// zustande kam). `connect_host` liefert ausserdem einen typisierten
// `ConnectError { code, message }` statt einer blossen Zeichenkette.
//
// Fix-Runde 1 (Befund 1, Review): "Connect" bei einem Passwort-Host ohne
// eingegebenes Passwort rief trotzdem `connect_host` mit `password: null`
// auf -- das lief auf ssh-agent und scheiterte mit einer Agent-Meldung,
// BEVOR ueberhaupt ein Passwortfeld erschien. `onConnectHost` verweigert
// diesen ersten Versuch jetzt, solange kein Passwort eingegeben ist (siehe
// die drei Tests unten).
// =====================================================================

describe("main: Task 8 -- Anmeldeart speichern, Passwort-Hosts verbinden nach Neustart", () => {
  // Deckt zugleich Fix-Runde 1s Befund-1-Fall (b) ab: Retry MIT `{ password:
  // "geheim" }` ruft `connect_host` mit `password: "geheim"`. Der erste Klick
  // hier oben loest seit dem Fix ohnehin keinen `connect_host`-Aufruf mehr
  // aus (siehe den Test direkt unter diesem Block, Fall (a)) -- der
  // Fehlschlag-Zustand entsteht jetzt ohne jeden Versuch.
  it("traegt das in der Hinweisleiste getippte Passwort in den naechsten connect_host-Aufruf", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") {
        return Promise.resolve([hostEntry({ auth_kind: "password" })]);
      }
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") {
        return Promise.reject({
          code: "password_required",
          message: "Wrong password for this account.",
        });
      }
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostActionButton("h1", "Connect").click();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-fail");

    const passwordInput = hostRow("h1").parentElement!.querySelector(
      "input[name=password]",
    ) as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    passwordInput.value = "geheim";
    hostRetryButton("h1").click();
    await flush(20);

    expect(invokeMock).toHaveBeenCalledWith("connect_host", {
      hostId: "r1",
      spec: expect.objectContaining({ password: "geheim", passphrase: null }),
    });
  });

  // Fix-Runde 1 (Befund 1): ersetzt den vormaligen Test "laesst password auf
  // null, solange die Hinweisleiste kein Passwort eingetippt bekommt" -- der
  // pinnte genau das Verhalten, das dieser Fix beseitigt (ein `connect_host`-
  // Aufruf mit `password: null` ohne jede Eingabe). Jetzt gilt: KEIN Versuch
  // ohne Passwort, egal ob beim ersten Klick oder bei einem Retry mit
  // weiterhin leerem Feld.
  it("versucht bei einem Passwort-Host ohne eingegebenes Passwort keinen connect_host-Aufruf", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") {
        return Promise.resolve([hostEntry({ auth_kind: "password" })]);
      }
      if (command === "list_ssh_keys") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostActionButton("h1", "Connect").click();
    await flush(20);

    expect(invokeMock).not.toHaveBeenCalledWith("connect_host", expect.anything());
    expect(hostIndicatorClass("h1")).toContain("ind-fail");
    const noticeText = hostRow("h1").parentElement!.textContent ?? "";
    expect(noticeText).toContain("Password required. Enter it below and retry.");
    expect(
      hostRow("h1").parentElement!.querySelector("input[name=password]"),
    ).not.toBeNull();

    // Ein Retry bei weiterhin leerem Feld ist ebenfalls kein Versuch --
    // derselbe Schutz greift erneut, nicht nur beim ersten Klick.
    hostRetryButton("h1").click();
    await flush(20);
    expect(invokeMock).not.toHaveBeenCalledWith("connect_host", expect.anything());
  });

  it("versucht bei einem Schluessel-Host auch ohne eingegebene Passphrase weiterhin connect_host", async () => {
    // Gegenprobe zu den beiden Tests oben: Befund 1 gilt ausdruecklich NICHT
    // fuer `authKind: "key"` -- ein Schluessel kann, muss aber keine
    // Passphrase haben, der erste Versuch ohne Eingabe bleibt dort richtig.
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") {
        return Promise.resolve([
          hostEntry({ auth_kind: "key", key_path: "C:\\Users\\U\\.ssh\\id_ed25519" }),
        ]);
      }
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      if (command === "list_sessions") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostActionButton("h1", "Connect").click();
    await flush(20);

    expect(invokeMock).toHaveBeenCalledWith("connect_host", {
      hostId: "r1",
      spec: expect.objectContaining({
        key_path: "C:\\Users\\U\\.ssh\\id_ed25519",
        passphrase: null,
      }),
    });
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });

  it("zeigt die Meldung eines typisierten ConnectError in der Hinweisleiste, nicht '[object Object]'", async () => {
    // `authKind: "agent"` (statt "password"): dieser Test prueft die
    // Fehlerobjekt-Auswertung von `onConnectHost`s catch-Zweig, nicht Befund
    // 1 -- ein Passwort-Host wuerde den `connect_host`-Aufruf hier gar nicht
    // erst ausloesen.
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") {
        return Promise.resolve([hostEntry({ auth_kind: "agent" })]);
      }
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") {
        return Promise.reject({
          code: "auth_rejected",
          message: "Wrong password for this account.",
        });
      }
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostActionButton("h1", "Connect").click();
    await flush(20);

    const noticeText = hostRow("h1").parentElement!.textContent ?? "";
    expect(noticeText).toContain("Wrong password for this account.");
    expect(noticeText).not.toContain("[object Object]");
  });

  it("uebernimmt beim Bearbeiten eines Agent-Hosts die gespeicherte Anmeldeart, auch wenn Schluessel gefunden werden", async () => {
    // Regression: `onEditHost` setzte `initial.auth` vorher NUR fuer
    // `host.keyPath` -- ein Agent-Host liess das Feld leer, und
    // `host-form.ts`s `applyPreselection()` griff dann zum ERSTEN
    // gefundenen Schluessel, statt "ssh-agent" zu zeigen (Spec §9.2 verlangt
    // ausdruecklich KEINE geratene Vorauswahl).
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry({ auth_kind: "agent" })]);
      if (command === "list_ssh_keys") {
        return Promise.resolve([
          { path: "C:\\Users\\U\\.ssh\\id_ed25519", file_name: "id_ed25519", key_type: "ed25519", comment: "" },
        ]);
      }
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostMenuItem("h1", "Edit…").click();
    await flush();
    const select = dialogHostFormView().querySelector("select[name=auth]") as HTMLSelectElement;
    expect(select.value).toBe("agent");
  });

  it("uebernimmt beim Bearbeiten eines Passwort-Hosts die gespeicherte Anmeldeart und zeigt das Passwortfeld", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry({ auth_kind: "password" })]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    main();
    await flush();

    hostMenuItem("h1", "Edit…").click();
    await flush();
    const view = dialogHostFormView();
    const select = view.querySelector("select[name=auth]") as HTMLSelectElement;
    expect(select.value).toBe("password");
    expect(view.querySelector("input[name=password]")).not.toBeNull();
  });
});

describe("Themen (UI v2 §12)", () => {
  function themeMocks(uiSettings: () => Promise<unknown>) {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      if (command === "ui_settings") return uiSettings();
      return Promise.resolve(undefined);
    });
  }

  it("wendet das lokal gemerkte Thema VOR dem ersten Rendern an", () => {
    localStorage.setItem("ab.theme", "slate");
    themeMocks(() => new Promise(() => {}));
    main();
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(document.documentElement.dataset.base).toBe("slate");
  });

  it("korrigiert den Vorlauf nach ui_settings und fragt es genau einmal lesend ab", async () => {
    localStorage.setItem("ab.theme", "slate");
    themeMocks(() => Promise.resolve({ theme: "turquoise" }));
    main();
    await flush();
    expect(document.documentElement.dataset.accent).toBe("turquoise");
    expect(document.documentElement.dataset.base).toBe("graphite");
    const reads = invokeMock.mock.calls.filter((c) => c[0] === "ui_settings");
    expect(reads).toEqual([["ui_settings", { patch: null }]]);
  });

  it("behaelt bei fehlgeschlagenem ui_settings den lokalen Wert, ohne Banner", async () => {
    localStorage.setItem("ab.theme", "slate");
    themeMocks(() => Promise.reject("io error"));
    main();
    await flush();
    expect(document.documentElement.dataset.base).toBe("slate");
    expect(document.querySelector<HTMLElement>(".global-error-banner")?.hidden ?? true).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it("Zahnrad oeffnet die Einstellungen, ein Wechsel wendet an und schreibt ui_settings; Escape schliesst und gibt den Fokus zurueck", async () => {
    themeMocks(() => Promise.resolve({ theme: "turquoise" }));
    main();
    await flush();
    const gear = document.querySelector<HTMLButtonElement>(".sb-head-btn")!;
    gear.focus(); // `click()` bewegt in jsdom keinen Fokus; die Huelle merkt sich activeElement
    gear.click();
    expect(document.querySelector(".dialog-panel .dialog-head h2")?.textContent).toBe("Settings");
    expect(document.querySelector(".dialog-panel")!.classList.contains("dialog-panel--large")).toBe(true);
    // Der Dialog oeffnet auf General (UX-Spec §9.1); die Farben stehen unter Appearance.
    document.querySelector<HTMLButtonElement>("#settings-tab-appearance")!.click();
    const slate = document.querySelector<HTMLInputElement>('input[name="base"][value="slate"]')!;
    slate.checked = true;
    slate.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.documentElement.dataset.base).toBe("slate");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(document.activeElement).toBe(gear);
    const writes = invokeMock.mock.calls.filter((c) => c[0] === "ui_settings");
    expect(writes[writes.length - 1]).toEqual(["ui_settings", { patch: { theme: "turquoise-slate" } }]);
  });

  // Review Fix-Runde 1: Appearance mountet nach einem Bereichswechsel neu und
  // muss das angewandte Thema zeigen, nicht das vom Oeffnen des Dialogs.
  it("die gewaehlte Farbe steht nach einem Wechsel des Bereichs noch da", async () => {
    themeMocks(() => Promise.resolve({ theme: "turquoise" }));
    main();
    await flush();
    document.querySelector<HTMLButtonElement>(".sb-head-btn")!.click();
    document.querySelector<HTMLButtonElement>("#settings-tab-appearance")!.click();
    const slate = document.querySelector<HTMLInputElement>('input[name="base"][value="slate"]')!;
    slate.checked = true;
    slate.dispatchEvent(new Event("change", { bubbles: true }));

    document.querySelector<HTMLButtonElement>("#settings-tab-shortcuts")!.click();
    document.querySelector<HTMLButtonElement>("#settings-tab-appearance")!.click();

    expect(document.querySelector<HTMLInputElement>('input[name="base"][value="slate"]')!.checked).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
  });

  // Spec 16.2, Farbwahl-Spec §6 ("je Gruppe genau ein fokussierbares Radio") -- die Zusage der
  // Fokusfalle, nicht die des Dialogs: `focusableElements` waehlte per
  // nacktem `input`-Selektor BEIDE Themenradios, und `last` war damit im
  // Standardthema das nicht gewaehlte Schiefer-Radio. Der Browser fokussiert
  // das nie (HTML: nur das gewaehlte Mitglied einer Gruppe steht in der
  // sequentiellen Reihenfolge), also griff die Falle nicht: Tab aus dem
  // gewaehlten Radio verliess das Panel, Shift+Tab aus "Close" landete auf
  // der falschen Karte. Gegen die Falle geprueft, nicht gegen den DOM --
  // die DOM-Haelfte steht in `views/settings-dialog.test.ts`.
  it("die Fokusfalle zaehlt im Einstellungsdialog je Gruppe genau ein Radio: das gewaehlte", async () => {
    themeMocks(() => Promise.resolve({ theme: "turquoise" }));
    main();
    await flush();
    document.querySelector<HTMLButtonElement>(".sb-head-btn")!.click();
    document.querySelector<HTMLButtonElement>("#settings-tab-appearance")!.click();
    const panel = document.querySelector<HTMLElement>(".dialog-panel")!;
    const radio = (name: string, value: string) =>
      panel.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;

    const focusableRadios = () =>
      focusableElements(panel).filter(
        (el) => el instanceof HTMLInputElement && el.type === "radio",
      );

    expect(focusableRadios()).toEqual([radio("accent", "turquoise"), radio("base", "graphite")]);

    // Wandert die Wahl, wandert der Tab-Halt ihrer Gruppe mit -- jsdom setzt
    // beim Setzen von `checked` die Gegenseite selbst zurueck (Radiogruppe).
    const slate = radio("base", "slate");
    slate.checked = true;
    slate.dispatchEvent(new Event("change", { bubbles: true }));
    expect(focusableRadios()).toEqual([radio("accent", "turquoise"), slate]);

    // Aufraeumen wie im Test darueber: Escape entsorgt den Dialog und
    // schreibt den offenen Wert sofort, statt den 150-ms-Nachlauf in den
    // naechsten Test zu tragen.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
  });
});

// UX-Spec §6.7: eine Schriftgroesse fuer alle Terminals. Wer sie aendert (Rad,
// Tasten, Einstellungen), schreibt `terminal-prefs`; main.ts reicht sie ueber
// das Raster an jede offene Kachel.
describe("main: Schriftgroesse der Terminals (UX-Spec §6.7)", () => {
  it("eine neue Schriftgroesse erreicht jede offene Kachel, andere Einstellungen nicht", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    openViaSidebar("h1", "s2");

    setTerminalPrefs({ fontSize: 15 });
    setTerminalPrefs({ copyOnSelect: true });

    expect(terminalHoisted.fontSizesByKey.get("r-h1/s1")).toEqual([15]);
    expect(terminalHoisted.fontSizesByKey.get("r-h1/s2")).toEqual([15]);
    expect(terminalPrefs().fontSize).toBe(15);
  });

  it("nach stopSessionStatusPoll hoert der Lauf nicht mehr zu", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");

    stopSessionStatusPoll();
    setTerminalPrefs({ fontSize: 17 });

    expect(terminalHoisted.fontSizesByKey.get("r-h1/s1")).toBeUndefined();
  });

  it("Strg+= und Strg+- aendern die Schrift, Strg+0 setzt sie zurueck; im Eingabefeld nicht", async () => {
    await startWithoutHostsForKeys();

    pressKey(document.body, { key: "=", ctrlKey: true });
    pressKey(document.body, { key: "=", ctrlKey: true });
    expect(terminalPrefs().fontSize).toBe(15);
    pressKey(document.body, { key: "-", ctrlKey: true });
    expect(terminalPrefs().fontSize).toBe(14);
    pressKey(document.body, { key: "0", code: "Digit0", ctrlKey: true });
    expect(terminalPrefs().fontSize).toBe(13);

    const field = document.createElement("input");
    document.getElementById("sidebar")!.appendChild(field);
    pressKey(field, { key: "=", ctrlKey: true });
    expect(terminalPrefs().fontSize).toBe(13);
  });

  it("die Tasten der Schriftgroesse erreichen die offenen Kacheln", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");

    pressKey(document.body, { key: "+", code: "NumpadAdd", ctrlKey: true });

    expect(terminalHoisted.fontSizesByKey.get("r-h1/s1")).toEqual([14]);
  });
});

async function startWithoutHostsForKeys(): Promise<void> {
  invokeMock.mockImplementation((command: string) => {
    if (command === "list_hosts") return Promise.resolve([]);
    if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  main();
  await flush();
}

function pressKey(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

// UX-Spec §8.3: `settings.open` ist Strg+,. Mit Fokus im Terminal laesst
// `terminal.ts` die Taste zum Dokument durch; hier steht dafuer ein Ziel im
// `.xterm`-Teilbaum (`./terminal` ist in dieser Datei gemockt).
describe("main: Strg+, oeffnet die Einstellungen (UX-Spec §8.3)", () => {
  const CTRL_COMMA: KeyboardEventInit = { key: ",", code: "Comma", ctrlKey: true };

  it("auch mit Fokus im Terminal", async () => {
    await startWithoutHostsForKeys();
    const xtermRoot = document.createElement("div");
    xtermRoot.className = "xterm";
    const helperTextarea = document.createElement("textarea");
    xtermRoot.appendChild(helperTextarea);
    document.getElementById("grid")!.appendChild(xtermRoot);

    const event = pressKey(helperTextarea, CTRL_COMMA);

    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector(".dialog-panel .dialog-head h2")?.textContent).toBe("Settings");
    expect(document.querySelector(".dialog-panel")!.classList.contains("dialog-panel--large")).toBe(true);
  });

  it("ein zweites Strg+, ersetzt den offenen Dialog nicht", async () => {
    await startWithoutHostsForKeys();
    pressKey(document.body, CTRL_COMMA);
    const panel = document.querySelector(".dialog-panel");
    expect(panel).not.toBeNull();

    pressKey(document.body, CTRL_COMMA);

    expect(document.querySelectorAll(".dialog-panel")).toHaveLength(1);
    expect(document.querySelector(".dialog-panel")).toBe(panel);
  });
});

// UX-Spec §7.5: Strg+Umschalt+P oeffnet "Quick open". Jede Aktion nimmt den
// bestehenden Weg der Seitenleiste bzw. der Tastatur:
// Session wie der Klick auf die Zeile, "Connect" wie der Umschalter, "New
// session" wie der Knopf, dazu Einstellungen, Layout und Seitenleiste.
describe("main: Schnelloeffnen (UX-Spec §7.5)", () => {
  const CTRL_SHIFT_P: KeyboardEventInit = { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true };

  function quickOpenInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>(".dialog-panel .quick-open-input");
  }

  function dialogTitle(): string | undefined {
    return document.querySelector(".dialog-panel .dialog-head h2")?.textContent ?? undefined;
  }

  function optionLabels(): string[] {
    return Array.from(document.querySelectorAll(".dialog-panel .quick-open-option .quick-open-label"), (label) => label.textContent ?? "");
  }

  const runOption = runQuickOpenOption;

  it("Strg+Umschalt+P oeffnet den Dialog mit Fokus im Feld -- auch aus dem Terminal und aus einem Textfeld", async () => {
    await startWithoutHostsForKeys();

    const fromBody = pressKey(document.body, CTRL_SHIFT_P);
    expect(fromBody.defaultPrevented).toBe(true);
    expect(dialogTitle()).toBe("Quick open");
    expect(document.activeElement).toBe(quickOpenInput());
    escape();
    expect(document.querySelector(".dialog-panel")).toBeNull();

    // Fokus im Terminal: `terminal.ts` laesst den Akkord zum Dokument durch.
    const xtermRoot = document.createElement("div");
    xtermRoot.className = "xterm";
    const helperTextarea = document.createElement("textarea");
    xtermRoot.appendChild(helperTextarea);
    document.getElementById("grid")!.appendChild(xtermRoot);
    pressKey(helperTextarea, CTRL_SHIFT_P);
    expect(dialogTitle()).toBe("Quick open");
    escape();

    // UX-Spec §8.2: ein belegter Strg+Umschalt-Akkord gehoert auch im Feld der App.
    const field = document.createElement("input");
    document.getElementById("sidebar")!.appendChild(field);
    const fromField = pressKey(field, CTRL_SHIFT_P);
    expect(fromField.defaultPrevented).toBe(true);
    expect(dialogTitle()).toBe("Quick open");
  });

  it("eine Session oeffnet wie der Klick in der Seitenleiste: in eine Kachel, mit Fokus", async () => {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();

    chord("p");
    expect(optionLabels()).toEqual([
      "s1",
      "s2",
      "s3",
      "New session on h1",
      "New session on h2",
      "Settings",
      "Toggle sidebar",
    ]);
    const before = focusCount("r-h2/s3");

    runOption("s3");
    await flush();

    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(tileTitles().filter((title) => title !== "")).toEqual(["s1", "s3"]);
    expect(focusedTileTitle()).toBe("s3");
    expect(focusCount("r-h2/s3")).toBe(before + 1);
  });

  it("'New session on {host}' oeffnet denselben Sessiondialog wie der Knopf der Seitenleiste", async () => {
    await setupTwoHostsThreeSessions();

    chord("p");
    runOption("New session on h2");
    await flush();

    expect(dialogTitle()).toBe("New session on h2");
    expect(invokeMock).toHaveBeenCalledWith("list_directories", expect.objectContaining({ hostId: "r-h2" }));
  });

  it("'Connect {host}' verbindet wie der Umschalter der Seitenleiste; Sessions erscheinen erst danach", async () => {
    const { connects } = setupSavedHost();
    main();
    await flush();

    chord("p");
    expect(optionLabels()).toEqual(expect.arrayContaining(["Connect h1"]));
    expect(optionLabels()).not.toContain("s1");
    runOption("Connect h1");
    await flush(20);

    expect(connects()).toBe(1);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    chord("p");
    expect(optionLabels().slice(0, 2)).toEqual(["s1", "New session on h1"]);
  });

  it("'Connect {host}' bei einem Passwort-Host zeigt das Passwortfeld der Seitenleiste, ohne Verbindungsversuch", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry({ auth_kind: "password" })]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();

    chord("p");
    runOption("Connect h1");
    await flush(20);

    expect(invokeMock).not.toHaveBeenCalledWith("connect_host", expect.anything());
    expect(hostRow("h1").parentElement!.querySelector(".host-notice input[name=password]")).not.toBeNull();
    expect(document.querySelector(".dialog-panel")).toBeNull();
  });

  // Die Liste ist ein Schnappschuss vom Oeffnen. Verbindet der Host, waehrend
  // sie offen steht (hier ueber die Seitenleiste nachgestellt, in der App etwa
  // der Start), baut ein spaeter Klick auf "Connect" die lebende Verbindung
  // nicht ab -- der Umschalter der Seitenleiste boete dann "Disconnect" an.
  it("ein veraltetes 'Connect {host}' laesst einen inzwischen verbundenen Host in Ruhe", async () => {
    const { connects } = setupSavedHost();
    main();
    await flush();

    chord("p");
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expect(connects()).toBe(1);

    runOption("Connect h1");
    await flush(20);

    expect(connects()).toBe(1);
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", expect.anything());
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });

  it("Aktionen: Seitenleiste und Einstellungen", async () => {
    await setupTwoHostsThreeSessions();
    const app = document.getElementById("app")!;

    chord("p");
    runOption("Toggle sidebar");
    expect(app.classList.contains("sidebar-collapsed")).toBe(true);

    chord("p");
    runOption("Settings");
    expect(dialogTitle()).toBe("Settings");
  });
});

const STORED_SETTINGS_PATH = "C:\\Users\\U\\AppData\\Roaming\\io.github.itbrain258.aidevbridge\\settings.toml";

/** Eine vollstaendige Antwort von `ui_settings`, wie Rust sie liefert. */
function uiSettingsDto(overrides: Partial<UiSettingsDto> = {}): UiSettingsDto {
  return {
    theme: "turquoise",
    terminal_font_size: 13,
    copy_on_select: false,
    ctrl_cv_clipboard: true,
    right_click: "menu",
    restore_workspace: true,
    sidebar_width: 240,
    workspace: { layout: 1, tiles_version: 2, sidebar_collapsed: false, expanded: [], connected: [], tiles: [], dirs: {} },
    settings_path: STORED_SETTINGS_PATH,
    ...overrides,
  };
}

// UX-Spec §9.2: die [ui]-Felder kommen beim Start aus `ui_settings`, und jede
// Aenderung geht entprellt nach 500 ms hinaus -- mit nur den geaenderten
// Feldern, als ganze Zahlen. Den Arbeitsplatz schreibt diese Aufgabe nicht.
describe("main: Einstellungen laden und entprellt schreiben (UX-Spec §9.2)", () => {
  let stored: UiSettingsDto;

  beforeEach(() => {
    vi.useFakeTimers();
    stored = uiSettingsDto();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      if (command === "ui_settings") return Promise.resolve(stored);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function settingsCalls(): unknown[][] {
    return invokeMock.mock.calls.filter(([command]) => command === "ui_settings");
  }

  function writes(): unknown[] {
    return settingsCalls()
      .map(([, args]) => (args as { patch: unknown }).patch)
      .filter((patch) => patch !== null);
  }

  function openSettingsTab(name: string): HTMLElement {
    pressKey(document.body, { key: ",", code: "Comma", ctrlKey: true });
    const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('.dialog-panel [role="tab"]')).find(
      (candidate) => candidate.textContent === name,
    )!;
    tab.click();
    return document.querySelector<HTMLElement>('.dialog-panel [role="tabpanel"]')!;
  }

  function switchNamed(root: HTMLElement, name: string): HTMLButtonElement {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button[role="switch"]')).find((el) => {
      const id = el.getAttribute("aria-labelledby");
      return id !== null && document.getElementById(id)?.textContent === name;
    })!;
  }

  it("uebernimmt die gespeicherten Terminal-Einstellungen und schreibt sie nicht zurueck", async () => {
    stored = uiSettingsDto({ terminal_font_size: 16, copy_on_select: true, ctrl_cv_clipboard: false, right_click: "paste" });
    main();
    await flush();

    expect(terminalPrefs()).toEqual({ fontSize: 16, copyOnSelect: true, ctrlCvClipboard: false, rightClick: "paste" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsCalls()).toEqual([["ui_settings", { patch: null }]]);
  });

  it("eine Aenderung geht nach 500 ms Ruhe hinaus, mit nur dem geaenderten Feld", async () => {
    main();
    await flush();

    setTerminalPrefs({ fontSize: 14 });
    await vi.advanceTimersByTimeAsync(300);
    setTerminalPrefs({ fontSize: 15 });
    await vi.advanceTimersByTimeAsync(499);
    expect(writes()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes()).toEqual([{ terminal_font_size: 15 }]);
  });

  it("Strg+= schreibt die neue Schriftgroesse als ganze Zahl", async () => {
    main();
    await flush();

    pressKey(document.body, { key: "=", ctrlKey: true });
    await vi.advanceTimersByTimeAsync(500);

    expect(writes()).toEqual([{ terminal_font_size: 14 }]);
    expect(Number.isInteger((writes()[0] as { terminal_font_size: number }).terminal_font_size)).toBe(true);
  });

  it("Terminal-Bereich: Copy on select schreibt nur copy_on_select", async () => {
    main();
    await flush();

    switchNamed(openSettingsTab("Terminal"), "Copy on select").click();
    await vi.advanceTimersByTimeAsync(500);

    expect(writes()).toEqual([{ copy_on_select: true }]);
  });

  it("zurueck auf den gespeicherten Wert binnen 500 ms schreibt nichts", async () => {
    main();
    await flush();
    const toggle = switchNamed(openSettingsTab("Terminal"), "Copy on select");

    toggle.click();
    toggle.click();
    await vi.advanceTimersByTimeAsync(500);

    expect(writes()).toEqual([]);
  });

  it("nach dem Schreiben gilt der neue Wert als gespeichert: der Rueckweg schreibt erneut", async () => {
    main();
    await flush();

    setTerminalPrefs({ rightClick: "paste" });
    await vi.advanceTimersByTimeAsync(500);
    setTerminalPrefs({ rightClick: "menu" });
    await vi.advanceTimersByTimeAsync(500);

    expect(writes()).toEqual([{ right_click: "paste" }, { right_click: "menu" }]);
  });

  it("General: Restore hosts and terminals zeigt den gespeicherten Wert und schreibt restore_workspace", async () => {
    stored = uiSettingsDto({ restore_workspace: false });
    main();
    await flush();
    const toggle = switchNamed(openSettingsTab("General"), "Restore hosts and terminals");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    toggle.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(writes()).toEqual([{ restore_workspace: true }]);

    // Geschlossen und wieder geoeffnet zeigt der Dialog den neuen Stand.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(switchNamed(openSettingsTab("General"), "Restore hosts and terminals").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("About zeigt den Pfad aus ui_settings", async () => {
    main();
    await flush();

    const panel = openSettingsTab("About");

    expect(panel.querySelector(".settings-value--path")?.textContent).toBe(STORED_SETTINGS_PATH);
  });

  // Review Fix-Runde 1: der Bereichswechsel mountet neu; der Schalter muss den
  // Stand von main.ts zeigen, nicht den vom Oeffnen des Dialogs.
  it("der Schalter steht nach einem Wechsel des Bereichs, wie er zuletzt gestellt wurde", async () => {
    main();
    await flush();
    switchNamed(openSettingsTab("General"), "Restore hosts and terminals").click();

    const tabNamed = (name: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.dialog-panel [role="tab"]')).find(
        (candidate) => candidate.textContent === name,
      )!;
    tabNamed("Terminal").click();
    tabNamed("General").click();

    const panel = document.querySelector<HTMLElement>('.dialog-panel [role="tabpanel"]')!;
    expect(switchNamed(panel, "Restore hosts and terminals").getAttribute("aria-checked")).toBe("false");
  });

  it("eine spaete Antwort von ui_settings erreicht General und About beim naechsten Mounten", async () => {
    let answer!: (dto: UiSettingsDto) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      if (command === "ui_settings") return new Promise<UiSettingsDto>((resolve) => (answer = resolve));
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    const before = openSettingsTab("About");
    expect(before.querySelector(".settings-value--path")).toBeNull();

    answer(uiSettingsDto({ restore_workspace: false }));
    await flush();

    const tabNamed = (name: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.dialog-panel [role="tab"]')).find(
        (candidate) => candidate.textContent === name,
      )!;
    tabNamed("General").click();
    const general = document.querySelector<HTMLElement>('.dialog-panel [role="tabpanel"]')!;
    expect(switchNamed(general, "Restore hosts and terminals").getAttribute("aria-checked")).toBe("false");
    tabNamed("About").click();
    const about = document.querySelector<HTMLElement>('.dialog-panel [role="tabpanel"]')!;
    expect(about.querySelector(".settings-value--path")?.textContent).toBe(STORED_SETTINGS_PATH);
  });

  it("ein gescheiterter Schreibvorgang bleibt still bis auf die Konsole", async () => {
    main();
    await flush();
    invokeMock.mockImplementation((command: string) => {
      if (command === "ui_settings") return Promise.reject("disk full");
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    setTerminalPrefs({ copyOnSelect: true });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(writes()).toEqual([{ copy_on_select: true }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(document.querySelector<HTMLElement>(".global-error-banner")?.hidden ?? true).toBe(true);
  });

  it("ohne Antwort von ui_settings geht nur das geaenderte Feld hinaus", async () => {
    // Ein gescheitertes Lesen kennt keinen gespeicherten Stand: die uebrigen
    // Felder gehen trotzdem nicht mit, sonst ueberschrieben ihre Standards die
    // Datei.
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "list_hosts") return Promise.resolve([]);
      // Der Erststart liest beide als Liste; `undefined` liesse ihn im
      // Hintergrund scheitern.
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      if (command === "ui_settings" && (args as { patch: unknown }).patch === null) return Promise.reject("io error");
      return Promise.resolve(undefined);
    });
    main();
    await flush();

    setTerminalPrefs({ fontSize: 12 });
    await vi.advanceTimersByTimeAsync(500);

    expect(writes()).toEqual([{ terminal_font_size: 12 }]);
  });

  it("stopSessionStatusPoll verwirft einen ausstehenden Schreibvorgang", async () => {
    main();
    await flush();

    setTerminalPrefs({ copyOnSelect: true });
    stopSessionStatusPoll();
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes()).toEqual([]);
  });
});

// UX-Spec §7.8: die Breite der Seitenleiste ist ein [ui]-Feld. Gelesen wird sie
// aus derselben Antwort von `ui_settings` wie die Terminal-Einstellungen,
// geschrieben ueber denselben entprellten Schreiber -- nur `sidebar_width`.
// Den Griff selbst (Klemmen, Tasten, Doppelklick) prueft
// `views/sidebar-resize.test.ts`; hier geht es um die Verdrahtung: Token an
// `#app`, ein `refit()` je abgeschlossener Aenderung, das Speichern.
describe("main: Breite der Seitenleiste (UX-Spec §7.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function settingsCalls(): unknown[][] {
    return invokeMock.mock.calls.filter(([command]) => command === "ui_settings");
  }

  function widthWrites(): unknown[] {
    return settingsCalls()
      .map(([, args]) => (args as { patch: Record<string, unknown> | null }).patch)
      .filter((patch) => patch !== null && "sidebar_width" in patch);
  }

  /** Der Griff, mit nachgebildeter Zeigererfassung: jsdom kennt
   * `setPointerCapture` nicht, der Griff ruft sie beim Druecken. */
  function resizeHandle(): HTMLElement {
    const handle = document.querySelector<HTMLElement>("#sidebar > .sb-resize");
    if (!handle) throw new Error("sidebar resize handle not found");
    handle.setPointerCapture = vi.fn();
    return handle;
  }

  function widthToken(): string {
    return document.getElementById("app")!.style.getPropertyValue("--ab-sidebar-w");
  }

  function pointer(handle: HTMLElement, type: string, clientX: number): void {
    // Waehrend des Zugs ist die Haupttaste gedrueckt, beim Loslassen nicht mehr.
    const buttons = type === "pointerdown" || type === "pointermove" ? 1 : 0;
    handle.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, pointerId: 1, clientX }),
    );
  }

  function press(handle: HTMLElement, key: string): void {
    handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  function refitCount(key: string): number {
    return terminalHoisted.refitCountByKey.get(key) ?? 0;
  }

  /** Ohne Hosts, mit dieser Antwort auf das Lesen von `ui_settings`. */
  async function startWithoutHosts(read: () => Promise<unknown>): Promise<void> {
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      if (command === "ui_settings" && (args as { patch: unknown }).patch === null) return read();
      return Promise.resolve(undefined);
    });
    main();
    await flush();
  }

  /** Zwei verbundene Hosts, `h1/s1` offen in einer Kachel. */
  async function startWithOpenTerminal(): Promise<void> {
    await setupTwoHostsThreeSessions();
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    expect(tileTitles()).toContain("s1");
  }

  it("wendet die gespeicherte Breite an, sobald ui_settings antwortet, und schreibt sie nicht zurueck", async () => {
    await startWithoutHosts(() => Promise.resolve(uiSettingsDto({ sidebar_width: 320 })));

    expect(widthToken()).toBe("320px");
    expect(resizeHandle().getAttribute("aria-valuenow")).toBe("320");
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsCalls()).toEqual([["ui_settings", { patch: null }]]);
  });

  // Fixrunde 2: Rust laesst 200 bis 207 stehen, die Seitenleiste zeigt
  // hoechstens bis 208 hinunter. Die Datei behaelt ihren Wert, bis der Nutzer
  // selbst eine Breite waehlt.
  it("zeigt eine gespeicherte 200 als 208 und plant kein Schreiben", async () => {
    await startWithoutHosts(() => Promise.resolve(uiSettingsDto({ sidebar_width: 200 })));

    expect(widthToken()).toBe("208px");
    expect(resizeHandle().getAttribute("aria-valuenow")).toBe("208");
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsCalls()).toEqual([["ui_settings", { patch: null }]]);
  });

  it("behaelt 240, wenn das Lesen von ui_settings scheitert", async () => {
    await startWithoutHosts(() => Promise.reject("io error"));

    // Kein Wert am Element: es gilt die Vorgabe aus styles.css.
    expect(widthToken()).toBe("");
    expect(resizeHandle().getAttribute("aria-valuenow")).toBe("240");
    await vi.advanceTimersByTimeAsync(1000);
    expect(widthWrites()).toEqual([]);
  });

  it("passt offene Terminals einmal an, wenn die gespeicherte Breite erst nach dem Raster eintrifft", async () => {
    let answer!: (dto: UiSettingsDto) => void;
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      if (command === "begin_connect" || command === "connect_host") return Promise.resolve("r1");
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      if (command === "ui_settings" && (args as { patch: unknown }).patch === null) {
        return new Promise<UiSettingsDto>((resolve) => (answer = resolve));
      }
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    expect(tileTitles()).toContain("s1");
    const before = refitCount("r1/s1");

    answer(uiSettingsDto({ sidebar_width: 320 }));
    await flush(20);

    expect(widthToken()).toBe("320px");
    expect(refitCount("r1/s1")).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(widthWrites()).toEqual([]);
  });

  it("Ziehen von 240 auf 300: das Token folgt, refit genau einmal beim Loslassen, gespeichert wird 300", async () => {
    await startWithOpenTerminal();
    const before = refitCount("r-h1/s1");
    const handle = resizeHandle();

    // Ein Zug, der die Breite nicht aendert, passt nichts an und speichert
    // nichts -- ohne gelesenen Stand ginge ein geplantes 240 hinaus.
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 530);
    pointer(handle, "pointermove", 500);
    pointer(handle, "pointerup", 500);
    pointer(handle, "lostpointercapture", 0);
    expect(refitCount("r-h1/s1")).toBe(before);

    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 530);
    pointer(handle, "pointermove", 560);
    expect(widthToken()).toBe("300px");
    expect(refitCount("r-h1/s1")).toBe(before);

    pointer(handle, "pointerup", 560);
    pointer(handle, "lostpointercapture", 0);
    expect(refitCount("r-h1/s1")).toBe(before + 1);
    expect(widthWrites()).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(widthWrites()).toEqual([{ sidebar_width: 300 }]);
  });

  it("Tasten und Doppelklick: je Aenderung ein refit, gespeichert wird entprellt der letzte Stand", async () => {
    await startWithOpenTerminal();
    const before = refitCount("r-h1/s1");
    const handle = resizeHandle();

    press(handle, "ArrowRight");
    press(handle, "ArrowRight");
    press(handle, "ArrowLeft");
    expect(widthToken()).toBe("256px");
    expect(refitCount("r-h1/s1")).toBe(before + 3);
    await vi.advanceTimersByTimeAsync(500);
    expect(widthWrites()).toEqual([{ sidebar_width: 256 }]);

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(widthToken()).toBe("240px");
    expect(refitCount("r-h1/s1")).toBe(before + 4);
    // Schon 240: Pos1 aendert nichts, passt nichts an, speichert nichts.
    press(handle, "Home");
    expect(refitCount("r-h1/s1")).toBe(before + 4);
    await vi.advanceTimersByTimeAsync(500);
    expect(widthWrites()).toEqual([{ sidebar_width: 256 }, { sidebar_width: 240 }]);
  });

  it("der Griff haengt in #sidebar hinter der Leiste und ist bei eingeklappter Seitenleiste verborgen", async () => {
    await setupTwoHostsThreeSessions();
    const handle = resizeHandle();
    expect(handle.previousElementSibling?.classList.contains("sidebar")).toBe(true);
    expect(handle.hidden).toBe(false);

    chord("b");
    expect(handle.hidden).toBe(true);
    chord("b");
    expect(handle.hidden).toBe(false);
  });

  // Fixrunde 1, G: das Einklappen setzt nur eine Klasse an `#app`; das Token
  // daneben bleibt stehen und gilt nach dem Aufklappen wieder.
  it("die Breite uebersteht Einklappen und Aufklappen", async () => {
    await setupTwoHostsThreeSessions();
    const handle = resizeHandle();
    press(handle, "ArrowRight");
    expect(widthToken()).toBe("256px");

    chord("b");
    chord("b");
    expect(widthToken()).toBe("256px");
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    await vi.advanceTimersByTimeAsync(500);
    expect(widthWrites()).toEqual([{ sidebar_width: 256 }]);
  });

  // Fixrunde 1, E: hat der Nutzer in diesem Lauf schon eine Breite gewaehlt,
  // ersetzt eine spaeter eintreffende gespeicherte sie nicht mehr.
  it("eine spaet eintreffende gespeicherte Breite ersetzt eine schon gewaehlte nicht", async () => {
    let answer!: (dto: UiSettingsDto) => void;
    await startWithoutHosts(() => new Promise<UiSettingsDto>((resolve) => (answer = resolve)));
    const handle = resizeHandle();
    press(handle, "ArrowRight");
    expect(widthToken()).toBe("256px");

    answer(uiSettingsDto({ sidebar_width: 320 }));
    await flush(20);

    expect(widthToken()).toBe("256px");
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    await vi.advanceTimersByTimeAsync(500);
    expect(widthWrites()).toEqual([{ sidebar_width: 256 }]);
  });
});


describe("main: reserved connection attempts", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  it("releases a late reservation without connecting it over a newer successful attempt", async () => {
    const oldBegin = deferred<string>();
    let begins = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "begin_connect") return ++begins === 1 ? oldBegin.promise : Promise.resolve("new-reservation");
      if (command === "connect_host") return Promise.resolve("new-reservation");
      if (command === "list_sessions") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("begin_connect", {});
    hostActionButton("h1", "Disconnect").click();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    oldBegin.resolve("old-reservation");
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "old-reservation" });
    const connects = invokeMock.mock.calls.filter(([command]) => command === "connect_host");
    expect(connects).toHaveLength(1);
    expect(connects[0][1]).toEqual(expect.objectContaining({ hostId: "new-reservation" }));
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", { hostId: "new-reservation" });
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });

  it("does not let a cancelled connect rejection fail its newer successful generation", async () => {
    const oldConnect = deferred<string>();
    let begins = 0;
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "begin_connect") return Promise.resolve(++begins === 1 ? "old-runtime" : "new-runtime");
      if (command === "connect_host") return (args as {hostId: string}).hostId === "old-runtime" ? oldConnect.promise : Promise.resolve("new-runtime");
      if (command === "list_sessions") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main(); await flush();
    hostActionButton("h1", "Connect").click(); await flush();
    hostActionButton("h1", "Disconnect").click();
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "old-runtime" });
    hostActionButton("h1", "Connect").click(); await flush(20);
    oldConnect.reject({ code: "connect_cancelled", message: "Old attempt cancelled." });
    await flush();
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(hostRow("h1").parentElement!.textContent).not.toContain("Old attempt cancelled.");
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", { hostId: "new-runtime" });
  });

  it("shows reservation capacity failure without starting an unowned connection", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "begin_connect") return Promise.reject({ code: "connect_capacity", message: "Too many connection attempts." });
      return Promise.resolve(undefined);
    });
    main(); await flush();
    hostActionButton("h1", "Connect").click(); await flush();
    expect(hostIndicatorClass("h1")).toContain("ind-fail");
    expect(hostRow("h1").parentElement!.textContent).toContain("Too many connection attempts.");
    expect(invokeMock).not.toHaveBeenCalledWith("connect_host", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", expect.anything());
  });

  it("holds an early Add host submission until every TOFU listener is ready", async () => {
    const closedListener = deferred<() => void>();
    listenMock.mockImplementation((name, handler) => {
      listeners.set(name, handler as (event: { payload: unknown }) => void);
      return name === "hostkey://request-closed" ? closedListener.promise : Promise.resolve(vi.fn());
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "suggest_hosts" || command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("early-runtime");
      if (command === "connect_host") return new Promise<string>(() => {});
      return Promise.resolve(undefined);
    });
    main(); await flush();
    document.querySelector<HTMLButtonElement>(".sb-btn")!.click(); await flush();
    const view = document.querySelector<HTMLElement>(".dialog-body .host-form-view")!;
    fillHostForm(view, "early-host", "test-user", "22");
    chooseAgentAuth(view);
    submitDialogForm(); await flush();
    expect(invokeMock).not.toHaveBeenCalledWith("begin_connect", expect.anything());
    closedListener.resolve(vi.fn()); await flush(20);
    expect(invokeMock).toHaveBeenCalledWith("connect_host", expect.objectContaining({ hostId: "early-runtime" }));
  });
});

function sessionItem(overrides: {
  display_name: string;
  session_id?: number | null;
  status?: string | null;
  status_reason?: string | null;
}): Record<string, unknown> {
  return {
    display_name: overrides.display_name,
    session_id: overrides.session_id ?? null,
    server_pid: overrides.session_id == null ? null : 50,
    server_start_time: overrides.session_id == null ? null : 1000,
    window_id: overrides.session_id == null ? null : 0,
    pane_id: overrides.session_id == null ? null : 0,
    pane_pid: overrides.session_id == null ? null : 10,
    unverified: overrides.session_id == null ? "unmeasured_tmux_version" : null,
    status: overrides.status ?? "unknown",
    status_reason: overrides.status_reason ?? null,
  };
}

/** `poll_status` answer: one complete numeric inventory of one tmux server.
 * Both optional sources answered unless `sources` says otherwise -- without
 * the flags every poll would look like a failed source (UX spec 5.2). */
function statusPoll(
  rows: Array<{ session_id: number; status: string; status_reason?: string }>,
  server: { pid: number; start: number } = { pid: 50, start: 1000 },
  sources: { agents_ok?: boolean; titles_ok?: boolean } = {},
): Record<string, unknown> {
  return {
    complete: true,
    server_pid: server.pid,
    server_start_time: server.start,
    sessions: rows.map((row) => ({
      session_id: row.session_id,
      status: row.status,
      status_reason: row.status_reason ?? "",
    })),
    agents_ok: sources.agents_ok ?? true,
    titles_ok: sources.titles_ok ?? true,
  };
}

describe("main: session status overlay poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function connectWithItems(items: Array<Record<string, unknown> | string>): Promise<void> {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry()]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      if (command === "list_sessions") return Promise.resolve(items);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
  }

  it("does not add a session that appears only in a later poll", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "unknown", status_reason: "no agent source is attached yet" }),
    ]);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    const names = () => Array.from(document.querySelectorAll("#sidebar .row-session .row-label")).map((el) => el.textContent);
    expect(names()).toEqual(["s1"]);
    invokeMock.mockClear();
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") {
        return Promise.resolve(
          statusPoll([
            { session_id: 1, status: "idle", status_reason: "agent is idle" },
            { session_id: 2, status: "busy", status_reason: "agent is busy" },
          ]),
        );
      }
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    // The poll is the slim query, not the full list with its name binding.
    expect(invokeMock.mock.calls.filter(([command]) => command === "poll_status")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "list_sessions")).toHaveLength(0);
    expect(names()).toEqual(["s1"]);
    expect(document.querySelector(".tile-agent:not([hidden]) .st")?.textContent).toBe("Idle");
  });

  it("marks a missing bound session ended without closing its tile", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "unknown" }),
    ]);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    expect(tileTitles()).toContain("s1");
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") return Promise.resolve(statusPoll([]));
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(tileTitles()).toContain("s1");
    expect(document.querySelector(".tile-agent:not([hidden]) .st")?.textContent).toBe("Ended");
  });

  it("does not invent ended when a poll fails", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") return Promise.reject(new Error("control down"));
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    // The last value is history now (spec 4.6): shown as not updated, not as current.
    expect(document.querySelector(".tile-agent:not([hidden]) .st")?.textContent).toMatch(/^As of /);
    expect(Array.from(document.querySelectorAll("#sidebar .row-session .row-label")).map((el) => el.textContent)).toEqual(["s1"]);
  });

  // UX-Spec §11: die Ansage der Wartenden liegt ausserhalb von #app. Ein
  // offener Dialog legt #app per `inert` still, und eine Live-Region darin
  // saehe Hilfstechnik dann nicht mehr.
  it("sagt neu Wartende ausserhalb von #app an, auch waehrend ein Dialog #app stilllegt", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    chord("p"); // Schnelloeffnen: ein Dialog, der nichts vom Backend braucht
    expect(document.querySelector(".dialog-panel")).not.toBeNull();
    expect(document.getElementById("app")!.inert).toBe(true);
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(
        command === "poll_status"
          ? statusPoll([{ session_id: 1, status: "waiting", status_reason: "permission prompt" }])
          : undefined,
      ),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);

    const live = Array.from(document.querySelectorAll<HTMLElement>('[aria-live="polite"]')).filter(
      (region) => region.textContent === "1 waiting",
    );
    expect(live).toHaveLength(1);
    expect(document.getElementById("app")!.contains(live[0])).toBe(false);
  });

  it("drops the waiting count when a status poll fails", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "waiting", status_reason: "permission prompt" }),
    ]);
    expect(document.title).toBe("(1) aidevbridge");
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") return Promise.reject(new Error("control down"));
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(document.title).toBe("aidevbridge");
  });

  it("puts the waiting count in the window title after a status poll", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") {
        return Promise.resolve(statusPoll([{ session_id: 1, status: "waiting", status_reason: "permission prompt" }]));
      }
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(document.title).toBe("(1) aidevbridge");
  });

  it("Strg+Umschalt+A und die Wartet-Spur nehmen die zuerst wartende Session (Spec 2026-10-19 §7)", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
      sessionItem({ display_name: "s3", session_id: 3, status: "idle", status_reason: "agent is idle" }),
    ]);
    const poll = (rows: Array<{ session_id: number; status: string; status_reason?: string }>): void => {
      invokeMock.mockImplementation((command: string) =>
        Promise.resolve(command === "poll_status" ? statusPoll(rows) : undefined),
      );
    };
    // Erst wartet s3, einen Poll spaeter auch s1.
    poll([
      { session_id: 1, status: "idle", status_reason: "agent is idle" },
      { session_id: 3, status: "waiting", status_reason: "permission prompt" },
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    poll([
      { session_id: 1, status: "waiting", status_reason: "permission prompt" },
      { session_id: 3, status: "waiting", status_reason: "permission prompt" },
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);

    // In der Reihenfolge der Seitenleiste stuende s1 vorn.
    const lane = Array.from(document.querySelectorAll("#sidebar .sb-lane .row-label")).map((el) => el.textContent);
    expect(lane).toEqual(["s3", "s1"]);
    chord("a");
    await flush(20);
    expect(focusedTileTitle()).toBe("s3");
  });

  // Spec 2026-10-19 §7 "Sonst bleibt die Liste wie heute": Strg+Umschalt+E springt
  // in die Hostliste, nie in die Wartet-Spur, und nimmt den Halt der Liste nicht
  // dorthin mit. Die Spur erreicht man mit Pfeil hoch und Pos1.
  it("Strg+Umschalt+E landet bei wartenden Sessions auf der Hostzeile, nicht in der Wartet-Spur", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "waiting", status_reason: "permission prompt" }),
    ]);
    const laneRow = () => document.querySelector<HTMLElement>("#sidebar .sb-lane .row-lane")!;
    expect(laneRow()).not.toBeNull();

    chord("e");
    await flush(20);
    expect(document.activeElement).toBe(hostRow("h1"));
    expect(document.activeElement?.closest(".sb-lane")).toBeNull();
    // Der Halt der Liste liegt auf der Hostzeile, nicht in der Spur.
    expect([hostRow("h1").tabIndex, laneRow().tabIndex]).toEqual([0, -1]);

    // Stand der Halt zuvor in der Spur, geht der Sprung trotzdem auf die
    // Hostzeile und nimmt den Halt von dort mit.
    laneRow().focus();
    expect(laneRow().tabIndex).toBe(0);
    (document.activeElement as HTMLElement).blur();
    await vi.advanceTimersByTimeAsync(1);
    chord("e");
    await flush(20);
    expect(document.activeElement).toBe(hostRow("h1"));
    expect([hostRow("h1").tabIndex, laneRow().tabIndex]).toEqual([0, -1]);
  });

  it("counts a session that is already waiting when the list first loads", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "waiting", status_reason: "permission prompt" }),
    ]);
    expect(document.title).toBe("(1) aidevbridge");
  });

  it("drops the waiting count when the host connection is lost", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") {
        return Promise.resolve(statusPoll([{ session_id: 1, status: "waiting", status_reason: "permission prompt" }]));
      }
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(document.title).toBe("(1) aidevbridge");
    emitTransportLost("r1");
    await flush(20);
    expect(document.title).toBe("aidevbridge");
  });

  it("ends a bound session when the poll shows a replaced tmux server", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") {
        return Promise.resolve(
          statusPoll([{ session_id: 1, status: "busy", status_reason: "agent is busy" }], { pid: 77, start: 2000 }),
        );
      }
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(document.querySelector(".tile-agent:not([hidden]) .st")?.textContent).toBe("Ended");
  });

  it("treats an incomplete poll as not current instead of guessing", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    invokeMock.mockImplementation((command: string) => {
      if (command === "poll_status") {
        return Promise.resolve({
          complete: false, server_pid: null, server_start_time: null, sessions: [], agents_ok: false, titles_ok: false,
        });
      }
      return Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(document.querySelector(".tile-agent:not([hidden]) .st")?.textContent).toMatch(/^As of /);
  });

  // --- UX-Spec §5.2: Frontendteil der Statusabfrage ---

  function calls(command: string) { return invokeMock.mock.calls.filter(([name]) => name === command); }

  /** Blinken der Taskleiste; `requestUserAttention(null)` beendet es nur. */
  function attentionRequests(): number {
    return windowHoisted.requestUserAttention.mock.calls.filter(([type]) => type !== null).length;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
  }

  it("behaelt bei ausgefallener claude-Quelle den wartenden Status veraltet und blinkt danach nicht erneut", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    expandHost("h1");
    const polls = [
      statusPoll([{ session_id: 1, status: "waiting", status_reason: "permission prompt" }]),
      statusPoll([{ session_id: 1, status: "unknown", status_reason: "no agent source is attached yet" }], undefined, { agents_ok: false }),
      statusPoll([{ session_id: 1, status: "waiting", status_reason: "permission prompt" }]),
    ];
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "poll_status" ? polls.shift() : undefined));
    const pill = () => sessionButton("h1", "s1").querySelector<HTMLElement>(".st")!;

    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(pill().textContent).toBe("Waiting");
    expect(document.title).toBe("(1) aidevbridge");
    expect(attentionRequests()).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    // Der alte Wert bleibt, als Geschichte markiert -- nicht "Unknown".
    expect(pill().textContent).toMatch(/^As of /);
    expect(pill().querySelector(".ag-waiting")).not.toBeNull();
    expect(document.title).toBe("aidevbridge");

    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(pill().textContent).toBe("Waiting");
    expect(document.title).toBe("(1) aidevbridge");
    // Veraltet -> aktuell wartend ist keine neue Wartephase.
    expect(attentionRequests()).toBe(1);
    expect(polls).toEqual([]);
  });

  it("zeigt den festgehaltenen Wert auch an der Kachel als 'As of'", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "busy", status_reason: "agent is busy" }),
    ]);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
    invokeMock.mockImplementation((command: string) => Promise.resolve(command === "poll_status"
      ? statusPoll([{ session_id: 1, status: "unknown", status_reason: "" }], undefined, { titles_ok: false })
      : undefined));
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    const tilePill = document.querySelector(".tile-agent:not([hidden]) .st")!;
    expect(tilePill.textContent).toMatch(/^As of /);
    expect(tilePill.querySelector(".ag-busy")).not.toBeNull();
  });

  it("uebernimmt unknown, wenn beide Quellen geantwortet haben", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "busy", status_reason: "agent is busy" }),
    ]);
    expandHost("h1");
    invokeMock.mockImplementation((command: string) => Promise.resolve(command === "poll_status"
      ? statusPoll([{ session_id: 1, status: "unknown", status_reason: "no agent source is attached yet" }])
      : undefined));
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(sessionButton("h1", "s1").querySelector(".st")!.textContent).toBe("Unknown");
  });

  it("pollt nicht, solange die Sessionliste laedt, und fruehestens 2 s nach dem Ende des vorigen Polls", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    const list = deferred<unknown>();
    const polls: Array<(value: unknown) => void> = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_sessions") return list.promise;
      if (command === "poll_status") return new Promise((resolve) => { polls.push(resolve); });
      return Promise.resolve(undefined);
    });
    const listsBefore = calls("list_sessions").length;
    hostActionButton("h1", "Reload sessions").click();
    await flush();
    expect(calls("list_sessions")).toHaveLength(listsBefore + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls("poll_status")).toHaveLength(0);

    list.resolve([sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" })]);
    await flush(20);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls("poll_status")).toHaveLength(1);
    // Kein zweiter Poll, solange der erste laeuft ...
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls("poll_status")).toHaveLength(1);
    // ... und der naechste erst 2 s nach seinem Ende.
    polls[0](statusPoll([{ session_id: 1, status: "idle", status_reason: "agent is idle" }]));
    await flush(20);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls("poll_status")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls("poll_status")).toHaveLength(2);
  });

  it("laedt die Sessionliste nur bei einer neuen Kontrollgeneration neu", async () => {
    await connectWithItems([
      sessionItem({ display_name: "s1", session_id: 1, status: "idle", status_reason: "agent is idle" }),
    ]);
    const before = calls("list_sessions").length;
    emitControlState("r1", 0, "reconnecting");
    emitControlState("r1", 0, "ready");
    await flush(20);
    expect(calls("list_sessions")).toHaveLength(before);
    emitControlState("r1", 1, "reconnecting");
    emitControlState("r1", 1, "ready");
    await flush(20);
    expect(calls("list_sessions")).toHaveLength(before + 1);
    emitControlState("r1", 1, "ready");
    await flush(20);
    expect(calls("list_sessions")).toHaveLength(before + 1);
  });
});

describe("main: Selbstreparatur der Steuerung (UX-Spec §5.3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ohne Streuung: die Versuche liegen genau bei 2, 5, 15, 30 und 60 s.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const KEY_HOST: Partial<HostEntryLike> = { auth_kind: "key", key_path: "C:/keys/id_ed25519" };
  const TEN_MINUTES = 10 * 60_000;

  function calls(command: string) { return invokeMock.mock.calls.filter(([name]) => name === command); }
  function block(): HTMLElement { return hostRow("h1").parentElement as HTMLElement; }
  function quietLine(): HTMLElement | null { return block().querySelector<HTMLElement>(".control-quiet"); }
  function controlBox(): HTMLElement | null { return block().querySelector<HTMLElement>(".control-notice"); }
  function boxButtons(): string[] {
    return Array.from(controlBox()?.querySelectorAll("button") ?? []).map((button) => button.textContent ?? "");
  }
  const EXPLANATION = "The session list and status can't update right now. Your terminals keep working.";
  /** UX-Spec §10: die Erklaerung traegt den Kasten, der Rohtext des Backends steht hinter "Details". */
  function expectBoxWithDetail(detail: string): void {
    expect(controlBox()!.querySelector(".host-notice-message")!.textContent).toBe(EXPLANATION);
    const hidden = controlBox()!.querySelector<HTMLElement>(".host-notice-detail")!;
    expect(hidden.textContent).toBe(detail);
    expect(hidden.hidden).toBe(true);
  }
  function submitRepairForm(fields: Record<string, string>): void {
    const form = controlBox()!.querySelector<HTMLElement>(".control-repair-form")!;
    for (const [name, value] of Object.entries(fields)) {
      form.querySelector<HTMLInputElement>(`input[name=${name}]`)!.value = value;
    }
    form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  /** Ein verbundener Host "h1" auf "r1"; `repair` beantwortet jedes `repair_control`. */
  async function connectHost(
    entry: Partial<HostEntryLike>,
    repair: () => Promise<unknown> = () => Promise.resolve(),
  ): Promise<void> {
    let generation = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry(entry)]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect" || command === "connect_host") return Promise.resolve("r1");
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      if (command === "begin_control_repair") return Promise.resolve(++generation);
      if (command === "repair_control") return repair();
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    await connectFromSidebar("h1");
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  }

  it("repariert einen Key-Host nach 2 s ohne Geheimnis und zeigt dabei nur die ruhige Zeile", async () => {
    await connectHost(KEY_HOST);
    emitControlState("r1", 0, "degraded", "The control connection has ended.");
    await flush();
    expect(quietLine()?.textContent).toBe("Reconnecting live updates…");
    expect(controlBox()).toBeNull();
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls("begin_control_repair")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush(20);
    expect(calls("begin_control_repair")).toEqual([["begin_control_repair", { hostId: "r1" }]]);
    expect(calls("repair_control")).toEqual([["repair_control", {
      hostId: "r1", controlGeneration: 1, auth: { key_path: "C:/keys/id_ed25519", passphrase: null, password: null },
    }]]);
    expect(quietLine()).not.toBeNull();
    expect(controlBox()).toBeNull();
    const lists = calls("list_sessions").length;
    emitControlState("r1", 1, "ready");
    await flush(20);
    expect(quietLine()).toBeNull();
    expect(controlBox()).toBeNull();
    // Die neue Generation laedt die Liste genau einmal.
    expect(calls("list_sessions")).toHaveLength(lists + 1);
  });

  // UX-Spec §5.3: "kein Kasten" waehrend der Reihe -- auch nicht fuer einen
  // Listenfehler, der nur sagt, dass die Steuerung fehlt. "Reload sessions"
  // ist so lange gesperrt, es scheiterte ohnehin an ihr.
  it("zeigt waehrend der ruhigen Zeile keinen Listenkasten und sperrt 'Reload sessions'", async () => {
    await connectHost(KEY_HOST);
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush();
    emitControlState("r1", 0, "degraded", "The control connection has ended.");
    await flush();
    const reload = () => hostActionButton("h1", "Reload sessions");
    expect(quietLine()).not.toBeNull();
    expect(reload().disabled).toBe(true);

    // Die Probe nach einem verlorenen Kanal scheitert an der fehlenden Steuerung.
    const previous = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(((command: string, args: never) => {
      if (command === "list_sessions") {
        return Promise.reject({
          code: "control_unavailable", message: "The SSH command failed (admission, unavailable).", control_generation: 0,
        });
      }
      return previous(command, args);
    }) as typeof invoke);
    const lists = calls("list_sessions").length;
    terminalHoisted.lostByKey.get("r1/s1")!();
    await flush(20);
    expect(calls("list_sessions")).toHaveLength(lists + 1);
    expect(block().querySelector(".session-list-notice")).toBeNull();
    expect(block().textContent).not.toContain("The SSH command failed");
    expect(quietLine()).not.toBeNull();

    invokeMock.mockImplementation(previous);
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    emitControlState("r1", 1, "ready");
    await flush(20);
    expect(quietLine()).toBeNull();
    expect(block().querySelector(".session-list-notice")).toBeNull();
    expect(reload().disabled).toBe(false);
  });

  it("repariert einen Agent-Host ohne Schluessel und ohne Geheimnis", async () => {
    await connectHost({ auth_kind: "agent" });
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("repair_control")[0][1]).toEqual({
      hostId: "r1", controlGeneration: 1, auth: { key_path: null, passphrase: null, password: null },
    });
  });

  it("zeigt nach dem fuenften Netzfehler den Kasten und versucht es dann nicht mehr", async () => {
    await connectHost(KEY_HOST, () => Promise.reject({ code: "host_unreachable", message: "Host unreachable" }));
    emitControlState("r1", 0, "degraded");
    let attempt = 0;
    for (const delay of [2000, 5000, 15000, 30000, 60000]) {
      expect(quietLine()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(calls("begin_control_repair")).toHaveLength(attempt);
      await vi.advanceTimersByTimeAsync(1);
      await flush(20);
      attempt += 1;
      expect(calls("begin_control_repair")).toHaveLength(attempt);
      // Das Backend meldet den Fehlschlag zusaetzlich als Ereignis; das
      // startet keine zweite Reihe und keinen zusaetzlichen Versuch.
      emitControlState("r1", attempt, "degraded", "Host unreachable");
      await flush();
    }
    expect(quietLine()).toBeNull();
    expect(controlBox()!.querySelector("strong")!.textContent).toBe("Live updates stopped");
    expect(boxButtons()).toContain("Restore updates");
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("begin_control_repair")).toHaveLength(5);
  });

  it.each(["ipc", "event"] as const)("beendet die Reihe bei authentication_required (%s) sofort und zeigt das Formular", async (path) => {
    let rejectRepair!: (reason: unknown) => void;
    await connectHost(KEY_HOST, () => new Promise((_, reject) => { rejectRepair = reject; }));
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("repair_control")).toHaveLength(1);
    const failure = { code: "passphrase_required", message: "The key needs its passphrase." };
    if (path === "event") emitControlState("r1", 1, "authentication_required", failure.message);
    rejectRepair(failure);
    await flush(20);
    expect(quietLine()).toBeNull();
    expectBoxWithDetail(failure.message);
    expect(controlBox()!.querySelector(".control-repair-form input[name=passphrase]")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("begin_control_repair")).toHaveLength(1);
    // Das Formular fuehrt mit der Passphrase weiter -- nur fuer diesen Versuch.
    submitRepairForm({ passphrase: "key-passphrase" });
    await flush(20);
    expect(calls("repair_control")[1][1]).toEqual({
      hostId: "r1", controlGeneration: 2, auth: { key_path: "C:/keys/id_ed25519", passphrase: "key-passphrase", password: null },
    });
  });

  it.each(["ipc", "event"] as const)("beendet die Reihe bei einem Hostschluesselfehler (%s) sofort und zeigt den Kasten", async (path) => {
    let rejectRepair!: (reason: unknown) => void;
    await connectHost(KEY_HOST, () => new Promise((_, reject) => { rejectRepair = reject; }));
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    const failure = {
      code: "host_key_rejected",
      message: "This server answered with a different host key than the open connection.",
    };
    // Das Backend meldet den Fehlschlag als degraded, nicht als Anmeldefehler.
    if (path === "event") emitControlState("r1", 1, "degraded", failure.message);
    rejectRepair(failure);
    await flush(20);
    expect(quietLine()).toBeNull();
    expectBoxWithDetail(failure.message);
    expect(boxButtons()).toContain("Restore updates");
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("begin_control_repair")).toHaveLength(1);
  });

  it("zaehlt nur Versuche, die das Backend erreichen", async () => {
    await connectHost(KEY_HOST, () => Promise.reject({ code: "host_unreachable", message: "Host unreachable" }));
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(1);
    // Als der zweite Versuch faellig wird, laeuft schon eine andere Reparatur:
    // er erreicht das Backend nicht und verbraucht keinen der fuenf Versuche.
    emitControlState("r1", 2, "reconnecting");
    await vi.advanceTimersByTimeAsync(5000);
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(1);
    expect(quietLine()).not.toBeNull();
    emitControlState("r1", 2, "degraded", "Host unreachable");
    await flush(20);
    for (const delay of [5000, 15000, 30000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await flush(20);
      expect(quietLine()).not.toBeNull();
    }
    await vi.advanceTimersByTimeAsync(60000);
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(5);
    expect(quietLine()).toBeNull();
    expect(controlBox()!.querySelector("strong")!.textContent).toBe("Live updates stopped");
  });

  it("wertet einen Versuch ohne entscheidendes Ereignis nach 20 s als gescheitert", async () => {
    // `repair_control` antwortet, aber das ready-Ereignis bleibt aus.
    await connectHost(KEY_HOST);
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls("cancel_control_repair")).toHaveLength(0);
    expect(quietLine()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await flush(20);
    // Die haengende Reparatur wird beendet, damit der naechste Versuch beginnen kann.
    expect(calls("cancel_control_repair")).toEqual([["cancel_control_repair", { hostId: "r1", controlGeneration: 1 }]]);
    expect(quietLine()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(2);
    for (const delay of [15000, 30000, 60000]) {
      await vi.advanceTimersByTimeAsync(20_000 + delay);
      await flush(20);
    }
    expect(calls("begin_control_repair")).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(20_000);
    await flush(20);
    expect(quietLine()).toBeNull();
    expect(controlBox()!.querySelector("strong")!.textContent).toBe("Live updates stopped");
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("begin_control_repair")).toHaveLength(5);
  });

  it("repariert nach dem Ende der Reihe von Hand mit Passphrase ueber Restore updates", async () => {
    let repairs = 0;
    await connectHost(KEY_HOST, () => (++repairs <= 5
      ? Promise.reject({ code: "host_unreachable", message: "Host unreachable" })
      : Promise.resolve()));
    emitControlState("r1", 0, "degraded");
    for (const delay of [2000, 5000, 15000, 30000, 60000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await flush(20);
    }
    expect(calls("begin_control_repair")).toHaveLength(5);
    Array.from(controlBox()!.querySelectorAll("button")).find((button) => button.textContent === "Restore updates")!.click();
    await flush(20);
    submitRepairForm({ passphrase: "key-passphrase" });
    await flush(20);
    expect(calls("repair_control")).toHaveLength(6);
    expect(calls("repair_control")[5][1]).toEqual({
      hostId: "r1", controlGeneration: 6, auth: { key_path: "C:/keys/id_ed25519", passphrase: "key-passphrase", password: null },
    });
    const lists = calls("list_sessions").length;
    emitControlState("r1", 6, "ready");
    await flush(20);
    expect(controlBox()).toBeNull();
    expect(quietLine()).toBeNull();
    expect(calls("list_sessions")).toHaveLength(lists + 1);
  });

  it("versucht es bei einem Passwort-Host nicht selbst", async () => {
    await connectHost({ auth_kind: "password" });
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("begin_control_repair")).toHaveLength(0);
    expect(quietLine()).toBeNull();
    expect(boxButtons()).toContain("Restore updates");
  });

  it("startet den wartenden Versuch sofort, wenn das Fenster den Fokus bekommt", async () => {
    await connectHost(KEY_HOST);
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("begin_control_repair")).toHaveLength(0);
    window.dispatchEvent(new Event("focus"));
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(1);
    // Der vorgezogene Versuch laeuft nicht ein zweites Mal ab.
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls("begin_control_repair")).toHaveLength(1);
  });

  it.each(["disconnect", "transport lost"] as const)("bricht die Reihe ab: %s", async (end) => {
    await connectHost(KEY_HOST);
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(1000);
    if (end === "disconnect") hostActionButton("h1", "Disconnect").click();
    else emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("begin_control_repair")).toHaveLength(0);
    expect(quietLine()).toBeNull();
  });

  it("bricht die Reihe ab, wenn der Nutzer den Host entfernt", async () => {
    await connectHost(KEY_HOST);
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(1000);
    hostMenuItem("h1", "Remove…").click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".host-confirm-remove button"))
      .find((button) => button.textContent === "Remove")!.click();
    await flush(20);
    expect(calls("remove_host")).toEqual([["remove_host", { id: "s1" }]]);
    expect(document.querySelectorAll("#sidebar .row-host")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("begin_control_repair")).toHaveLength(0);
    expect(document.querySelector(".control-quiet")).toBeNull();
  });

  it("zaehlt nach ready einen neuen Ausfall wieder von vorn", async () => {
    await connectHost(KEY_HOST, () => Promise.reject({ code: "host_unreachable", message: "Host unreachable" }));
    emitControlState("r1", 0, "degraded");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(1);
    emitControlState("r1", 1, "ready");
    await flush(20);
    expect(quietLine()).toBeNull();
    emitControlState("r1", 1, "degraded");
    await flush();
    expect(quietLine()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("begin_control_repair")).toHaveLength(2);
  });
});

// UX-Spec §5.4: verliert ein Host mit Schluessel oder ssh-agent seine
// Terminalverbindung (Standby, Netzwechsel, VPN), verbindet die App ihn selbst
// neu -- nach 2, 5, 15, 30 und 60 s, sofort bei Fensterfokus oder `online`, und
// nur bei Netzfehlern. Danach haengen sich seine Kacheln wieder an.
describe("main: Neuverbinden nach Verlust der Terminalverbindung (UX-Spec §5.4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ohne Streuung: die Versuche liegen genau bei 2, 5, 15, 30 und 60 s.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const KEY_HOST: Partial<HostEntryLike> = { auth_kind: "key", key_path: "C:/keys/id_ed25519" };
  const TEN_MINUTES = 10 * 60_000;
  const NETWORK = { code: "host_unreachable", message: "The host 10.0.0.1 is unreachable." };

  function calls(command: string) { return invokeMock.mock.calls.filter(([name]) => name === command); }
  function block(): HTMLElement { return hostRow("h1").parentElement as HTMLElement; }
  /** Die ruhige Zeile unter der Hostzeile (UX-Spec §5.7). */
  function quietLine(): HTMLElement | null { return block().querySelector<HTMLElement>(".host-quiet"); }
  /** Der Kasten eines fehlgeschlagenen Hosts mit "Retry". */
  function failedNotice(): HTMLElement | null {
    return block().querySelector<HTMLElement>(".host-notice:not(.control-notice):not(.session-list-notice)");
  }
  function tileQuiet(): HTMLElement | null { return document.querySelector<HTMLElement>("#grid .tile-quiet:not([hidden])"); }
  function tileStrip(): HTMLElement { return document.querySelector<HTMLElement>("#grid .tile:not(.tile-empty) .tile-lock")!; }

  /** Ein gespeicherter Host "h1", verbunden auf "r1", mit offener Kachel "s1".
   * `begin_connect` vergibt je Versuch eine frische Laufzeit-ID (r1, r2, ...);
   * `reconnect(n)` beantwortet das n-te `connect_host` NACH dem ersten. */
  async function connectAndOpen(entry: Partial<HostEntryLike>, reconnect: (attempt: number) => Promise<unknown>): Promise<void> {
    let reservations = 0;
    let connects = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([hostEntry(entry)]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve(`r${++reservations}`);
      if (command === "connect_host") return ++connects === 1 ? Promise.resolve("ok") : reconnect(connects - 1);
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    await connectFromSidebar("h1");
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expandHost("h1");
    openViaSidebar("h1", "s1");
    await flush(20);
  }

  function pending(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it("verbindet einen Key-Host selbst neu und haengt danach die Kacheln wieder an", async () => {
    let attempt = 0;
    await connectAndOpen(KEY_HOST, () => (++attempt < 3 ? Promise.reject(NETWORK) : Promise.resolve("ok")));
    expect(terminalHoisted.lostByKey.has("r1/s1")).toBe(true);
    emitTransportLost("r1");
    await flush();

    // Die Hostzeile zeigt die ruhige Zeile statt des Kastens, die Kachel den
    // ruhigen Hinweis statt der Sperrleiste.
    expect(quietLine()?.textContent).toBe("Reconnecting…");
    expect(quietLine()?.querySelector(".ind-connecting")).not.toBeNull();
    expect(failedNotice()).toBeNull();
    expect(hostIndicatorClass("h1")).not.toContain("ind-fail");
    expect(tileQuiet()?.textContent).toBe("Reconnecting…");
    expect(tileStrip().hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls("connect_host")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    // Wie beim Klick auf "Retry": der alte Transport geht vorher zu.
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r1" });
    // Ein Netzfehler laesst die Reihe weiterlaufen, ohne Kasten.
    expect(quietLine()).not.toBeNull();
    expect(failedNotice()).toBeNull();
    expect(tileQuiet()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4999);
    expect(calls("connect_host")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(15000);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(4);

    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(quietLine()).toBeNull();
    // Die Kachel haengt an der neuen Verbindung, ohne Hinweis und ohne Sperre.
    expect(terminalHoisted.lostByKey.has("r4/s1")).toBe(true);
    expect(tileQuiet()).toBeNull();
    expect(tileStrip().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(4);
  });

  it("verbindet auch einen Agent-Host selbst neu", async () => {
    await connectAndOpen({ auth_kind: "agent" }, () => Promise.resolve("ok"));
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    expect(calls("connect_host")[1][1]).toEqual({
      hostId: "r2",
      spec: { hostname: "10.0.0.1", port: 22, user: "m", key_path: null, passphrase: null, password: null },
    });
    expect(hostIndicatorClass("h1")).toContain("ind-on");
  });

  it("ueberlaesst eine Kachel, deren Kanal kurz vor dem Transport stirbt, dem Neuverbinden des Hosts", async () => {
    await connectAndOpen(KEY_HOST, () => Promise.resolve("ok"));
    // Der Kanal meldet sich zuerst; der Host lebt da noch, die Kachel will
    // sich still neu anhaengen. Dann faellt der Transport.
    terminalHoisted.lostByKey.get("r1/s1")!();
    emitTransportLost("r1");
    await flush(20);
    terminalHoisted.lostByKey.clear();
    await vi.advanceTimersByTimeAsync(500);
    // Kein eigener Versuch der Kachel gegen den toten Host.
    expect(terminalHoisted.lostByKey.has("r1/s1")).toBe(false);
    expect(tileQuiet()?.textContent).toBe("Reconnecting…");
    await vi.advanceTimersByTimeAsync(1500);
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(terminalHoisted.lostByKey.has("r2/s1")).toBe(true);
    expect(tileQuiet()).toBeNull();
    expect(tileStrip().hidden).toBe(true);
  });

  it("zeigt nach dem fuenften Netzfehler den bisherigen Fehlerzustand mit Retry", async () => {
    await connectAndOpen(KEY_HOST, () => Promise.reject(NETWORK));
    emitTransportLost("r1");
    await flush();
    for (const delay of [2000, 5000, 15000, 30000, 60000]) {
      expect(quietLine()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(delay);
      await flush(20);
    }
    expect(calls("connect_host")).toHaveLength(6);
    expect(quietLine()).toBeNull();
    expect(failedNotice()?.textContent).toContain(NETWORK.message);
    expect(hostRetryButton("h1").textContent).toBe("Retry");
    expect(hostIndicatorClass("h1")).toContain("ind-fail");
    expect(tileQuiet()).toBeNull();
    expect(tileStrip().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(6);
  });

  it.each([
    ["host_key_rejected", "The host key of 10.0.0.1 has changed. Someone may be intercepting the connection.", false],
    ["auth_rejected", "The server rejected the key.", true],
    ["passphrase_required", "The key needs its passphrase.", true],
    ["password_required", "The server wants a password.", true],
  ])("beendet die Reihe bei %s sofort und zeigt den Fehler", async (code, message, asksForSecret) => {
    await connectAndOpen(KEY_HOST, () => Promise.reject({ code, message }));
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    expect(quietLine()).toBeNull();
    expect(failedNotice()?.textContent).toContain(message);
    // Nach einem Anmeldefehler der Weg zum Geheimnis: das Passphrasenfeld des
    // Key-Hosts. Ein geaenderter Hostschluessel braucht kein Geheimnis.
    if (asksForSecret) {
      expect(failedNotice()!.querySelector("input[name=passphrase]")).not.toBeNull();
    } else {
      expect(failedNotice()!.querySelector("input")).toBeNull();
      expect(hostRetryButton("h1").textContent).toBe("Retry");
    }
    expect(tileStrip().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(2);
  });

  it("versucht es bei einem Passwort-Host nicht selbst", async () => {
    await connectAndOpen({ auth_kind: "password" }, () => Promise.resolve("ok"));
    emitTransportLost("r1");
    await flush();
    expect(quietLine()).toBeNull();
    expect(failedNotice()).not.toBeNull();
    expect(hostIndicatorClass("h1")).toContain("ind-fail");
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(1);
  });

  it("versucht es bei einem Key-Host nicht selbst, dessen letzte Verbindung die Passphrase brauchte", async () => {
    let reservations = 0;
    invokeMock.mockImplementation((command: string, rawArgs?: unknown) => {
      const args = rawArgs as { spec?: { passphrase: string | null } } | undefined;
      if (command === "list_hosts") return Promise.resolve([hostEntry(KEY_HOST)]);
      if (command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve(`r${++reservations}`);
      if (command === "connect_host") {
        return args?.spec?.passphrase
          ? Promise.resolve("ok")
          : Promise.reject({ code: "passphrase_required", message: "The key needs its passphrase." });
      }
      if (command === "list_sessions") return Promise.resolve(["s1"]);
      return Promise.resolve(undefined);
    });
    main();
    await flush();
    hostActionButton("h1", "Connect").click();
    await flush(20);
    block().querySelector<HTMLInputElement>(".host-notice input[name=passphrase]")!.value = "key-passphrase";
    hostRetryButton("h1").click();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-on");

    emitTransportLost("r2");
    await flush();
    expect(quietLine()).toBeNull();
    // Der Abriss ist kein Anmeldefehler: zuerst nur "Retry". Erst wenn der
    // Versuch die Passphrase verlangt, erscheint ihr Feld.
    expect(failedNotice()?.querySelector("input")).toBeNull();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(2);
    hostRetryButton("h1").click();
    await flush(20);
    expect(calls("connect_host")).toHaveLength(3);
    expect(failedNotice()?.querySelector("input[name=passphrase]")).not.toBeNull();
  });

  it.each(["focus", "online"] as const)("startet den wartenden Versuch bei %s sofort und zaehlt danach weiter", async (event) => {
    await connectAndOpen(KEY_HOST, () => Promise.reject(NETWORK));
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("connect_host")).toHaveLength(1);
    window.dispatchEvent(new Event(event));
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    // Der vorgezogene Versuch laeuft nicht noch einmal ab; der naechste
    // wartet die zweite Stufe (5 s) ab, nicht wieder die erste.
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls("connect_host")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(3);
  });

  it("startet bei einem Schwall von focus und online genau einen Versuch und nie zwei zugleich", async () => {
    const attempt = pending();
    await connectAndOpen(KEY_HOST, () => attempt.promise);
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(500);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    // Solange der Versuch laeuft, startet weder die Zeit noch ein Ereignis einen zweiten.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    window.dispatchEvent(new Event("online"));
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    attempt.reject(NETWORK);
    await flush(20);
    expect(quietLine()).not.toBeNull();
  });

  it("beendet die Reihe bei einem Klick auf Connect und verbindet genau einmal von Hand", async () => {
    const manual = pending();
    await connectAndOpen(KEY_HOST, () => manual.promise);
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(500);
    // Zwischen zwei Versuchen bietet der Umschalter "Connect".
    hostActionButton("h1", "Connect").click();
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    expect(quietLine()).toBeNull();
    // Waehrend der Versuch von Hand laeuft, kommt kein zweiter dazu.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    window.dispatchEvent(new Event("focus"));
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    manual.reject(NETWORK);
    await flush(20);
    // Ein Fehlschlag von Hand zeigt den Fehler mit "Retry" -- und die Reihe
    // nimmt ihn nicht wieder auf.
    expect(failedNotice()?.textContent).toContain(NETWORK.message);
    expect(quietLine()).toBeNull();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(2);
  });

  it("beendet die Reihe beim Trennen waehrend eines laufenden Versuchs", async () => {
    const attempt = pending();
    await connectAndOpen(KEY_HOST, () => attempt.promise);
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    expect(hostIndicatorClass("h1")).toContain("ind-connecting");
    hostActionButton("h1", "Disconnect").click();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-off");
    expect(quietLine()).toBeNull();
    attempt.resolve("late");
    await flush(20);
    // Der ueberholte Versuch wird geschlossen und nie angezeigt.
    expect(hostIndicatorClass("h1")).toContain("ind-off");
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "r2" });
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(2);
  });

  it("beendet die Reihe, wenn der Nutzer den Host entfernt", async () => {
    await connectAndOpen(KEY_HOST, () => Promise.reject(NETWORK));
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(500);
    hostMenuItem("h1", "Remove…").click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".host-confirm-remove button"))
      .find((button) => button.textContent === "Remove")!.click();
    await flush(20);
    expect(calls("remove_host")).toEqual([["remove_host", { id: "s1" }]]);
    expect(document.querySelectorAll("#sidebar .row-host")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(1);
  });

  it("haengt bei lebendem Host nur den verlorenen Kanal still neu an, ohne den Host neu zu verbinden", async () => {
    await connectAndOpen(KEY_HOST, () => Promise.resolve("ok"));
    const oldLost = terminalHoisted.lostByKey.get("r1/s1")!;
    oldLost();
    await flush(20);
    expect(hostIndicatorClass("h1")).toContain("ind-on");
    expect(tileQuiet()?.textContent).toBe("Reconnecting…");
    expect(tileStrip().hidden).toBe(true);
    // Die Probe der Sessionliste laeuft weiter; sie sperrt die Kachel nicht.
    expect(calls("list_sessions").length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(terminalHoisted.lostByKey.get("r1/s1")).not.toBe(oldLost);
    expect(calls("connect_host")).toHaveLength(1);
  });

  it("verbindet weiter, wenn die neue Verbindung verloren geht, bevor ihr Versuch zurueck ist", async () => {
    await connectAndOpen(KEY_HOST, (attempt) => (attempt === 1 ? Promise.resolve("ok") : Promise.reject(NETWORK)));
    // Die Sessionliste der neuen Verbindung (r2) haengt: der Versuch hat schon
    // verbunden, ist aber noch nicht zurueck.
    const list = pending();
    const previous = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(((command: string, args?: { hostId?: string }) =>
      command === "list_sessions" && args?.hostId === "r2" ? list.promise : previous(command, args)) as typeof invoke);
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    expect(hostIndicatorClass("h1")).toContain("ind-on");

    emitTransportLost("r2");
    await flush();
    // Sofort wieder die ruhige Zeile, kein Kasten -- und noch kein zweiter Versuch.
    expect(quietLine()?.textContent).toBe("Reconnecting…");
    expect(failedNotice()).toBeNull();
    expect(calls("connect_host")).toHaveLength(2);
    list.resolve(["s1"]);
    await flush(20);
    expect(quietLine()).not.toBeNull();
    expect(failedNotice()).toBeNull();
    // Die Reihe zaehlt weiter: der naechste Versuch wartet die zweite Stufe ab.
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls("connect_host")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(3);
  });

  it("gibt einen Host, der jede neue Verbindung gleich wieder verliert, nach dem fuenften Versuch auf", async () => {
    await connectAndOpen(KEY_HOST, () => Promise.resolve("ok"));
    emitTransportLost("r1");
    let runtime = 1;
    for (const delay of [2000, 5000, 15000, 30000, 60000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await flush(20);
      runtime += 1;
      expect(hostIndicatorClass("h1")).toContain("ind-on");
      // Die neue Verbindung haelt keine 10 s.
      await vi.advanceTimersByTimeAsync(1000);
      emitTransportLost(`r${runtime}`);
      await flush(20);
    }
    expect(calls("connect_host")).toHaveLength(6);
    // Kein endloses Neuverbinden (und keine endlose Rueckfrage eines ssh-agent
    // mit Bestaetigung): nach dem fuenften Versuch steht der Kasten mit Retry.
    expect(quietLine()).toBeNull();
    expect(hostRetryButton("h1").textContent).toBe("Retry");
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(6);
  });
});

// UX-Spec §7.1-§7.3: der Arbeitsplatz -- Layout, Seitenleiste, aufgeklappte
// Hosts, gewuenschte Verbindungen und Kacheln -- kommt beim Start aus derselben
// Antwort von `ui_settings` zurueck und geht entprellt als ganzer Schnappschuss
// hinaus. Review Focus 4: gespeicherte Kacheln zu verschwundenen Sessions,
// entfernten Hosts oder Passwort-Hosts ergeben leere Plaetze, keine Fehler und
// keinen Fokusraub.
describe("main: Arbeitsplatz merken und wiederherstellen (UX-Spec §7.1-§7.3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ohne Streuung: das Neuverbinden aus §5.4 versucht es genau nach 2 s.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const KEY_A = hostEntry({ id: "host_a", label: "A", hostname: "10.0.0.1", auth_kind: "key", key_path: "C:/keys/a" });
  const PASSWORD_B = hostEntry({ id: "host_b", label: "B", hostname: "10.0.0.2", auth_kind: "password" });
  const AGENT_C = hostEntry({ id: "host_c", label: "C", hostname: "10.0.0.3", auth_kind: "agent" });
  const NETWORK = { code: "host_unreachable", message: "The host is unreachable." };
  const TEN_MINUTES = 10 * 60_000;

  interface World {
    hosts: HostEntryLike[];
    workspace?: Partial<WorkspaceDto>;
    restore?: boolean;
    /** Antwort von `list_sessions` je Hostname. */
    sessions?: Record<string, Array<string | Record<string, unknown>>>;
    /** Antwort auf `connect_host` je Versuch; Standard: verbunden. */
    connect?: (hostname: string) => Promise<unknown>;
    /** Antwort auf das lesende `ui_settings`; Standard: der gespeicherte Stand. */
    read?: () => Promise<unknown>;
    /** Antwort auf ein schreibendes `ui_settings`; Standard: angenommen. */
    write?: () => Promise<unknown>;
    /** Antwort auf `remove_host`; Standard: entfernt. */
    remove?: () => Promise<unknown>;
    poll?: () => Promise<unknown>;
    /** Antwort auf `create_session`; Standard: angelegt unter dem gewuenschten Namen. */
    create?: () => Promise<unknown>;
    /** Antwort auf `update_host`; Standard: gespeichert, wie geschickt (`saved`). */
    update?: (saved: Record<string, unknown>) => Promise<unknown>;
  }

  function emptyWorkspace(): WorkspaceDto {
    return { layout: 1, tiles_version: 2, sidebar_collapsed: false, expanded: [], connected: [], tiles: [], dirs: {} };
  }

  /** Startet die App mit gespeicherten Hosts und Arbeitsplatz. `begin_connect`
   * vergibt je Versuch eine frische Laufzeit-ID (r1, r2, ...); die
   * Sessionliste antwortet fuer den Host, den der Versuch verbunden hat. */
  async function start(world: World): Promise<void> {
    const stored = uiSettingsDto({
      restore_workspace: world.restore ?? true,
      workspace: { ...emptyWorkspace(), ...world.workspace },
    });
    const hostnameByRuntime = new Map<string, string>();
    let reservations = 0;
    invokeMock.mockImplementation(((command: string, rawArgs?: unknown) => {
      const args = rawArgs as Record<string, unknown> | undefined;
      if (command === "list_hosts") return Promise.resolve(world.hosts);
      if (command === "ui_settings") {
        return args?.patch === null ? (world.read?.() ?? Promise.resolve(stored)) : (world.write?.() ?? Promise.resolve(stored));
      }
      if (command === "remove_host") return world.remove?.() ?? Promise.resolve(undefined);
      if (command === "begin_connect") return Promise.resolve(`r${++reservations}`);
      if (command === "connect_host") {
        const hostname = (args?.spec as { hostname: string }).hostname;
        hostnameByRuntime.set(args?.hostId as string, hostname);
        return world.connect?.(hostname) ?? Promise.resolve("ok");
      }
      if (command === "list_sessions") {
        return Promise.resolve(world.sessions?.[hostnameByRuntime.get(args?.hostId as string) ?? ""] ?? []);
      }
      if (command === "poll_status") return world.poll?.() ?? Promise.resolve(statusPoll([]));
      if (command === "list_ssh_keys" || command === "suggest_hosts") return Promise.resolve([]);
      // Der Baum im Sitzungsdialog; sein Inhalt ist hier gleichgueltig.
      if (command === "list_directories") return Promise.resolve({ path: (args?.path as string) || "/home/m", entries: [] });
      if (command === "create_session") return world.create?.() ?? Promise.resolve((args?.name as string | null) ?? "ab_1a2b3c");
      if (command === "update_host") {
        // Wie `update_host_impl`: die Kennung bleibt, fehlende Sonderwerte
        // behalten den Standard.
        const entry = args?.entry as Omit<HostEntryLike, "id" | "tmux_socket" | "history_limit">;
        const saved = { ...entry, id: args?.id, tmux_socket: "agentbridge", history_limit: 10000 };
        return world.update?.(saved) ?? Promise.resolve(saved);
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);
    main();
    await flush(30);
  }

  function calls(command: string) { return invokeMock.mock.calls.filter(([name]) => name === command); }
  /** Hostnamen der `connect_host`-Aufrufe, in ihrer Reihenfolge. */
  function connectedHostnames(): string[] {
    return calls("connect_host").map(([, args]) => (args as { spec: { hostname: string } }).spec.hostname);
  }
  /** Jeder geschriebene Arbeitsplatz, in Reihenfolge. */
  function workspaceWrites(): WorkspaceDto[] {
    return calls("ui_settings")
      .map(([, args]) => (args as { patch: { workspace?: WorkspaceDto } | null }).patch?.workspace)
      .filter((ws): ws is WorkspaceDto => ws !== undefined);
  }
  /** Die Titel der Kacheln in Anzeigereihenfolge; leere Plaetze gibt es
   * nicht mehr (Spec 2026-10-19 §4.1). */
  function slots(): string[] {
    return tileTitles();
  }
  function bannerShown(): boolean {
    return document.querySelector<HTMLElement>(".global-error-banner")?.hidden === false;
  }
  function terminalFocusCalls(): number {
    return [...terminalHoisted.focusCountByKey.values()].reduce((sum, count) => sum + count, 0);
  }

  it("stellt Layout, Seitenleiste und aufgeklappte Hosts sofort her, verbindet nur den Key-Host und belegt dessen Plaetze ohne Fokus", async () => {
    await start({
      hosts: [KEY_A, PASSWORD_B],
      workspace: {
        layout: 4,
        sidebar_collapsed: true,
        expanded: ["host_a"],
        connected: ["host_a", "host_b"],
        tiles: [
          { slot: 0, host_id: "host_a", session: "a1" },
          { slot: 1, host_id: "host_b", session: "b1" },
          { slot: 2, host_id: "host_a", session: "a2" },
        ],
      },
      sessions: { "10.0.0.1": ["a1", "a2", "a3"], "10.0.0.2": ["b1"] },
    });

    expect(document.getElementById("app")!.classList.contains("sidebar-collapsed")).toBe(true);
    expect(hostRow("A").getAttribute("aria-expanded")).toBe("true");
    expect(hostRow("B").getAttribute("aria-expanded")).toBe("false");
    // Nur der Key-Host; der Passwort-Host bleibt offline, sein Platz leer.
    expect(connectedHostnames()).toEqual(["10.0.0.1"]);
    expect(hostIndicatorClass("A")).toContain("ind-on");
    expect(hostIndicatorClass("B")).toContain("ind-off");
    expect(slots()).toEqual(["a1", "a2"]);
    expect([...terminalHoisted.lostByKey.keys()].sort()).toEqual(["r1/a1", "r1/a2"]);
    // Kein Fokusraub: keine Kachel fokussiert, kein Terminal fokussiert.
    expect(focusedTileTitle()).toBeUndefined();
    expect(terminalFocusCalls()).toBe(0);
    expect(document.getElementById("grid")!.contains(document.activeElement)).toBe(false);
    expect(bannerShown()).toBe(false);
    // Alles wie gespeichert (B wartet noch): nichts zu schreiben.
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceWrites()).toEqual([]);

    openViaSidebar("A", "a3");
    await flush(20);
    expect(slots()).toEqual(["a1", "a2", "a3"]);
  });

  it("laesst eine verschwundene Session weg, ohne Hinweis, und speichert danach ohne sie", async () => {
    await start({
      hosts: [KEY_A],
      workspace: {
        layout: 2,
        connected: ["host_a"],
        tiles: [
          { slot: 0, host_id: "host_a", session: "gone" },
          { slot: 1, host_id: "host_a", session: "a1" },
        ],
      },
      sessions: { "10.0.0.1": ["a1"] },
    });

    expect(slots()).toEqual(["a1"]);
    expect(bannerShown()).toBe(false);
    expect(focusedTileTitle()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([
      { ...emptyWorkspace(), connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
    ]);
  });

  it("uebergeht die Eintraege eines entfernten Hosts: kein Verbindungsversuch, kein Platz, und gespeichert wird ohne sie", async () => {
    await start({
      hosts: [AGENT_C],
      workspace: {
        layout: 2,
        expanded: ["host_gone", "host_c"],
        connected: ["host_gone"],
        tiles: [{ slot: 0, host_id: "host_gone", session: "x" }],
      },
    });

    expect(calls("begin_connect")).toEqual([]);
    expect(calls("connect_host")).toEqual([]);
    expect(slots()).toEqual([]);
    expect(bannerShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceWrites()).toEqual([]);

    chord("b");
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([{ ...emptyWorkspace(), sidebar_collapsed: true, expanded: ["host_c"] }]);
  });

  it("verbindet fuenf gespeicherte Hosts in der Reihenfolge der Seitenleiste, hoechstens drei zugleich", async () => {
    const hosts = [1, 2, 3, 4, 5].map((n) =>
      hostEntry({ id: `host_${n}`, label: `H${n}`, hostname: `10.0.1.${n}`, auth_kind: "agent" }),
    );
    const answers = new Map<string, () => void>();
    let inFlight = 0;
    let most = 0;
    await start({
      hosts,
      workspace: { connected: ["host_5", "host_3", "host_1", "host_4", "host_2"] },
      connect: (hostname) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        return new Promise((resolve) => answers.set(hostname, () => {
          inFlight -= 1;
          resolve("ok");
        }));
      },
    });

    expect(connectedHostnames()).toEqual(["10.0.1.1", "10.0.1.2", "10.0.1.3"]);
    answers.get("10.0.1.2")!();
    await flush(30);
    expect(connectedHostnames()).toEqual(["10.0.1.1", "10.0.1.2", "10.0.1.3", "10.0.1.4"]);
    answers.get("10.0.1.1")!();
    answers.get("10.0.1.3")!();
    await flush(30);
    answers.get("10.0.1.4")!();
    answers.get("10.0.1.5")!();
    await flush(30);
    expect(connectedHostnames()).toHaveLength(5);
    expect(most).toBe(3);
    expect(hosts.every((entry) => hostIndicatorClass(entry.label).includes("ind-on"))).toBe(true);
  });

  it("ein Status-Poll schreibt nie; ein Einklappen der Seitenleiste schreibt genau einmal nach 500 ms", async () => {
    let busy = false;
    await start({
      hosts: [AGENT_C],
      workspace: { expanded: ["host_c"], connected: ["host_c"], tiles: [{ slot: 0, host_id: "host_c", session: "c1" }] },
      sessions: { "10.0.0.3": [sessionItem({ display_name: "c1", session_id: 1, status: "idle" })] },
      // Jeder Poll aendert den Status: AppState meldet sich jedes Mal.
      poll: () => {
        busy = !busy;
        return Promise.resolve(statusPoll([{ session_id: 1, status: busy ? "busy" : "idle" }]));
      },
    });
    expect(slots()[0]).toBe("c1");

    const shown = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      await flush(20);
      shown.add(document.querySelector(".tile-agent:not([hidden]) .st")?.textContent ?? "");
    }
    expect(shown).toEqual(new Set(["Busy", "Idle"]));
    expect(workspaceWrites()).toEqual([]);

    chord("b");
    await vi.advanceTimersByTimeAsync(499);
    expect(workspaceWrites()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(workspaceWrites()).toEqual([
      {
        ...emptyWorkspace(),
        sidebar_collapsed: true,
        expanded: ["host_c"],
        connected: ["host_c"],
        tiles: [{ slot: 0, host_id: "host_c", session: "c1" }],
      },
    ]);
  });

  it("Trennen durch den Nutzer nimmt den Host aus connected", async () => {
    await start({ hosts: [AGENT_C], workspace: { connected: ["host_c"] }, sessions: { "10.0.0.3": ["c1"] } });
    expect(hostIndicatorClass("C")).toContain("ind-on");

    hostActionButton("C", "Disconnect").click();
    await vi.advanceTimersByTimeAsync(500);

    expect(workspaceWrites()).toEqual([emptyWorkspace()]);
  });

  it("ein Netzfehler laesst den Host in connected, mitsamt seiner Kachel", async () => {
    let attempts = 0;
    await start({
      hosts: [KEY_A],
      workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
      sessions: { "10.0.0.1": ["a1"] },
      connect: () => (++attempts === 1 ? Promise.resolve("ok") : Promise.reject(NETWORK)),
    });
    expect(slots()[0]).toBe("a1");

    emitTransportLost("r1");
    for (const delay of [2000, 5000, 15000, 30000, 60000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await flush(20);
    }
    expect(hostIndicatorClass("A")).toContain("ind-fail");
    chord("b");
    await vi.advanceTimersByTimeAsync(500);

    expect(workspaceWrites()).toEqual([
      { ...emptyWorkspace(), sidebar_collapsed: true, connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
    ]);
  });

  it("restore_workspace aus: nichts wiederhergestellt, beim Start nichts geschrieben, Aenderungen aber gespeichert", async () => {
    const dirs = { host_a: { last: "/srv", recent: ["/srv", "/tmp"] } };
    await start({
      hosts: [KEY_A],
      restore: false,
      workspace: {
        layout: 4,
        sidebar_collapsed: true,
        expanded: ["host_a"],
        connected: ["host_a"],
        tiles: [{ slot: 0, host_id: "host_a", session: "a1" }],
        dirs,
      },
      sessions: { "10.0.0.1": ["a1"] },
    });

    expect(document.getElementById("app")!.classList.contains("sidebar-collapsed")).toBe(false);
    expect(hostRow("A").getAttribute("aria-expanded")).toBe("false");
    expect(calls("connect_host")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceWrites()).toEqual([]);

    // Auch ein Verbinden von Hand belegt die gespeicherte Kachel nicht ...
    await connectFromSidebar("A");
    expect(slots()).toEqual([]);
    // ... aber gespeichert wird: der Stand dieses Laufs, die Verzeichnisse unveraendert.
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([{ ...emptyWorkspace(), connected: ["host_a"], dirs }]);
  });

  it("bei einem Passwort-Host erscheint erst das Feld; die Session oeffnet nach der Verbindung", async () => {
    await start({ hosts: [PASSWORD_B], sessions: { "10.0.0.2": ["b1"] } });
    await connectFromSidebar("B");
    expandHost("B");
    hostActionButton("B", "Disconnect").click();
    await flush(20);
    expect(calls("connect_host")).toHaveLength(1);

    openViaSidebar("B", "b1");
    await flush(30);
    // Kein Versuch ohne Passwort, nur das Feld; noch nichts geoeffnet.
    expect(calls("connect_host")).toHaveLength(1);
    const password = hostRow("B").parentElement!.querySelector<HTMLInputElement>(".host-notice input[name=password]");
    expect(password).not.toBeNull();
    expect(slots()[0]).toBeUndefined();
    expect(bannerShown()).toBe(false);

    password!.value = "host-password";
    hostRetryButton("B").click();
    await flush(30);
    expect(calls("connect_host")).toHaveLength(2);
    expect(slots()[0]).toBe("b1");
  });

  it("oeffnet die Session nach dem Verbinden, holt aber keinen Fokus, den der Nutzer inzwischen woanders hat", async () => {
    let release!: () => void;
    let attemptsC = 0;
    await start({
      hosts: [KEY_A, AGENT_C],
      workspace: { layout: 2, connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
      sessions: { "10.0.0.1": ["a1"], "10.0.0.3": ["c1"] },
      connect: (hostname) =>
        hostname === "10.0.0.3" && ++attemptsC === 2
          ? new Promise((resolve) => (release = () => resolve("ok")))
          : Promise.resolve("ok"),
    });
    await connectFromSidebar("C");
    expandHost("C");
    hostActionButton("C", "Disconnect").click();
    await flush(20);

    openViaSidebar("C", "c1");
    await flush(20);
    // Waehrend der Aufbau laeuft, arbeitet der Nutzer in der anderen Kachel.
    const elsewhere = document.querySelector<HTMLElement>('#grid .tile[data-position="0"] .tile-btn')!;
    elsewhere.focus();
    release();
    await flush(30);

    expect(tileTitles()).toContain("c1");
    expect(focusCount("r3/c1")).toBe(0);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("ein Klick waehrend eines Versuchs des Neuverbindens laesst die Reihe laufen und oeffnet nach deren Erfolg", async () => {
    let release!: () => void;
    let attempts = 0;
    await start({
      hosts: [KEY_A],
      workspace: {
        layout: 2,
        expanded: ["host_a"],
        connected: ["host_a"],
        tiles: [{ slot: 0, host_id: "host_a", session: "a1" }],
      },
      sessions: { "10.0.0.1": ["a1", "a2"] },
      connect: () => (++attempts === 2 ? new Promise((resolve) => (release = () => resolve("ok"))) : Promise.resolve("ok")),
    });
    emitTransportLost("r1");
    await vi.advanceTimersByTimeAsync(2000);
    await flush(20);
    expect(calls("connect_host")).toHaveLength(2);
    expect(hostIndicatorClass("A")).toContain("ind-connecting");

    openViaSidebar("A", "a2");
    await flush(20);
    // Kein zweiter Aufbau, und die Reihe laeuft weiter.
    expect(calls("connect_host")).toHaveLength(2);
    expect(hostRow("A").parentElement!.querySelector(".host-quiet")?.textContent).toBe("Reconnecting…");

    release();
    await flush(30);
    expect(hostIndicatorClass("A")).toContain("ind-on");
    expect(slots()).toEqual(["a1", "a2"]);
  });

  it("ein gescheiterter Aufbau nach dem Klick oeffnet nichts, auch nicht beim naechsten Verbinden", async () => {
    let attempts = 0;
    await start({
      hosts: [AGENT_C],
      sessions: { "10.0.0.3": ["c1"] },
      connect: () => (++attempts === 2 ? Promise.reject(NETWORK) : Promise.resolve("ok")),
    });
    await connectFromSidebar("C");
    expandHost("C");
    hostActionButton("C", "Disconnect").click();
    await flush(20);

    openViaSidebar("C", "c1");
    await flush(30);
    expect(hostIndicatorClass("C")).toContain("ind-fail");
    expect(slots()[0]).toBeUndefined();

    hostRetryButton("C").click();
    await flush(30);
    expect(hostIndicatorClass("C")).toContain("ind-on");
    expect(slots()[0]).toBeUndefined();
  });

  it("scheitert das Lesen, startet die App leer und schreibt den Arbeitsplatz in diesem Lauf nie", async () => {
    await start({
      hosts: [AGENT_C],
      workspace: { layout: 4, connected: ["host_c"] },
      sessions: { "10.0.0.3": ["c1"] },
      read: () => Promise.reject("io error"),
    });

    expect(calls("connect_host")).toEqual([]);
    expect(bannerShown()).toBe(false);
    chord("b");
    await connectFromSidebar("C");
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceWrites()).toEqual([]);
  });

  it("faellt die Verbindung beim Start am Netz, uebernimmt das Neuverbinden (das VPN steht noch nicht)", async () => {
    let attempts = 0;
    await start({
      hosts: [KEY_A],
      workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
      sessions: { "10.0.0.1": ["a1"] },
      connect: () => (++attempts === 1 ? Promise.reject(NETWORK) : Promise.resolve("ok")),
    });
    expect(hostRow("A").parentElement!.querySelector(".host-quiet")?.textContent).toBe("Reconnecting…");

    await vi.advanceTimersByTimeAsync(2000);
    await flush(30);

    expect(calls("connect_host")).toHaveLength(2);
    expect(hostIndicatorClass("A")).toContain("ind-on");
    expect(slots()[0]).toBe("a1");
    expect(focusedTileTitle()).toBeUndefined();
  });

  it("braucht der Schluessel beim Start eine Passphrase, zeigt der Host das Feld und wird nicht wiederholt", async () => {
    await start({
      hosts: [KEY_A],
      workspace: { connected: ["host_a"] },
      connect: () => Promise.reject({ code: "passphrase_required", message: "The key needs its passphrase." }),
    });

    const block = hostRow("A").parentElement!;
    expect(block.querySelector(".host-notice input[name=passphrase]")).not.toBeNull();
    expect(block.querySelector(".host-quiet")).toBeNull();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(calls("connect_host")).toHaveLength(1);
  });

  // Task 15/16: ein Verbindungsaufbau von ausserhalb der
  // Seitenleiste (heute Schnelloeffnen "Connect …"), der in ihr eine Antwort
  // braucht -- Passwort, Passphrase, oder die Hinweisleiste nach einer
  // Hostschluessel-Rueckfrage --, klappt eine eingeklappte Seitenleiste auf.
  // Derselbe Weg wie Strg+Umschalt+B, also auch gespeichert; der Fokus geht in
  // das erste Bedienelement der Antwort. Start und Neuverbinden tun das nie.
  it("Schnelloeffnen 'Connect' auf einen Passwort-Host klappt die Seitenleiste auf und fokussiert das Passwortfeld", async () => {
    await start({ hosts: [PASSWORD_B], workspace: { sidebar_collapsed: true } });
    const app = document.getElementById("app")!;
    expect(app.classList.contains("sidebar-collapsed")).toBe(true);

    chord("p");
    runQuickOpenOption("Connect B");
    await flush(20);

    expect(calls("connect_host")).toHaveLength(0);
    expect(app.classList.contains("sidebar-collapsed")).toBe(false);
    expect(document.activeElement).toBe(hostRow("B").parentElement!.querySelector(".host-notice input[name=password]"));
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([{ ...emptyWorkspace(), sidebar_collapsed: false }]);
  });

  it("ebenso, wenn erst der Versuch eines Key-Hosts die Passphrase verlangt", async () => {
    await start({
      hosts: [KEY_A],
      workspace: { sidebar_collapsed: true },
      connect: () => Promise.reject({ code: "passphrase_required", message: "The key needs its passphrase." }),
    });
    const app = document.getElementById("app")!;

    chord("p");
    runQuickOpenOption("Connect A");
    await flush(30);

    expect(calls("connect_host")).toHaveLength(1);
    expect(app.classList.contains("sidebar-collapsed")).toBe(false);
    expect(document.activeElement).toBe(hostRow("A").parentElement!.querySelector(".host-notice input[name=passphrase]"));
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([{ ...emptyWorkspace(), sidebar_collapsed: false }]);
  });

  it("nach einem Netzfehler steht kein Feld in der Hinweisleiste, der Fokus geht auf Retry", async () => {
    await start({
      hosts: [KEY_A],
      workspace: { sidebar_collapsed: true },
      connect: () => Promise.reject({ code: "connect_timeout", message: "SSH connection timed out." }),
    });

    chord("p");
    runQuickOpenOption("Connect A");
    await flush(30);

    const notice = hostRow("A").parentElement!.querySelector<HTMLElement>(".host-notice")!;
    expect(notice.textContent).toContain("SSH connection timed out.");
    expect(notice.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(hostRetryButton("A"));
  });

  it("ebenso nach einer Hostschluessel-Rueckfrage: die Rueckfrage nimmt den Fokus, danach geht er in die Hinweisleiste", async () => {
    let failConnect!: (reason: unknown) => void;
    await start({
      hosts: [AGENT_C],
      workspace: { sidebar_collapsed: true },
      connect: () => new Promise((_resolve, reject) => {
        failConnect = reject;
      }),
    });
    const app = document.getElementById("app")!;

    chord("p");
    runQuickOpenOption("Connect C");
    await flush(20);
    emitHostKeyRequest(hostKeyRequest({ host: "10.0.0.3" }));
    await flush();
    const prompt = document.querySelector<HTMLElement>("#host-key-prompt-root .host-key-prompt")!;
    expect(prompt.contains(document.activeElement)).toBe(true);
    // Waehrend die Rueckfrage steht, bleibt die Seitenleiste, wie sie ist.
    expect(app.classList.contains("sidebar-collapsed")).toBe(true);

    Array.from(prompt.querySelectorAll("button")).find((button) => button.textContent === "Reject")!.click();
    await flush();
    failConnect({ code: "host_key_rejected", message: "The host key wasn't confirmed, so aidevbridge didn't connect." });
    await flush(20);

    expect(app.classList.contains("sidebar-collapsed")).toBe(false);
    // Ein abgelehnter Hostschluessel ist kein Anmeldefehler: kein Feld, der
    // Fokus steht auf "Retry".
    expect(hostRow("C").parentElement!.querySelector(".host-notice input")).toBeNull();
    expect(document.activeElement).toBe(hostRetryButton("C"));
  });

  it("der Start klappt eine eingeklappte Seitenleiste nicht auf, auch wenn ein Host seine Passphrase braucht", async () => {
    await start({
      hosts: [KEY_A],
      workspace: { connected: ["host_a"], sidebar_collapsed: true },
      connect: () => Promise.reject({ code: "passphrase_required", message: "The key needs its passphrase." }),
    });

    expect(calls("connect_host")).toHaveLength(1);
    expect(hostRow("A").parentElement!.querySelector(".host-notice input[name=passphrase]")).not.toBeNull();
    expect(document.getElementById("app")!.classList.contains("sidebar-collapsed")).toBe(true);
    expect(document.getElementById("sidebar")!.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites().every((workspace) => workspace.sidebar_collapsed)).toBe(true);
  });

  it("verbindet einen Host, den der Nutzer vor der Antwort schon verbunden hat, nicht noch einmal", async () => {
    let answer!: (dto: unknown) => void;
    await start({
      hosts: [AGENT_C],
      sessions: { "10.0.0.3": ["c1"] },
      read: () => new Promise((resolve) => (answer = resolve)),
    });
    await connectFromSidebar("C");
    expect(calls("connect_host")).toHaveLength(1);

    answer(uiSettingsDto({ workspace: { ...emptyWorkspace(), connected: ["host_c"] } }));
    await flush(30);

    expect(calls("connect_host")).toHaveLength(1);
    expect(hostIndicatorClass("C")).toContain("ind-on");
  });

  it("die Kachel eines Passwort-Hosts wartet und erscheint nach dem Verbinden von Hand an ihrer Position, vor einer inzwischen geoeffneten (Spec 2026-10-19 §4.6)", async () => {
    await start({
      hosts: [KEY_A, PASSWORD_B],
      workspace: {
        expanded: ["host_a"],
        connected: ["host_a", "host_b"],
        tiles: [
          { slot: 0, host_id: "host_a", session: "a1" },
          { slot: 1, host_id: "host_b", session: "b1" },
        ],
      },
      sessions: { "10.0.0.1": ["a1", "a2"], "10.0.0.2": ["b1"] },
    });
    expect(slots()).toEqual(["a1"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceWrites()).toEqual([]);

    // Vor dem Verbinden von B oeffnet der Nutzer eine andere Session von A.
    openViaSidebar("A", "a2");
    await flush(20);
    expect(slots()).toEqual(["a1", "a2"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([
      {
        ...emptyWorkspace(),
        layout: 2,
        expanded: ["host_a"],
        connected: ["host_a", "host_b"],
        tiles: [
          { slot: 0, host_id: "host_a", session: "a1" },
          { slot: 1, host_id: "host_b", session: "b1" },
          { slot: 2, host_id: "host_a", session: "a2" },
        ],
      },
    ]);

    const focusCalls = terminalFocusCalls();
    await connectFromSidebar("B");
    expect(slots()).toEqual(["a1", "b1", "a2"]);
    // Kein Fokusraub: die wiederhergestellte Kachel holt sich nichts.
    expect(focusedTileTitle()).toBe("a2");
    expect(terminalFocusCalls()).toBe(focusCalls);
  });

  it("entfernt der Nutzer einen Host, verschwinden seine wartenden Kacheln und er aus connected", async () => {
    await start({
      hosts: [AGENT_C, PASSWORD_B],
      workspace: { layout: 2, connected: ["host_c", "host_b"], tiles: [{ slot: 1, host_id: "host_b", session: "b1" }] },
      sessions: { "10.0.0.3": ["c1"] },
    });

    hostMenuItem("B", "Remove…").click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".host-confirm-remove button"))
      .find((button) => button.textContent === "Remove")!.click();
    await flush(20);
    await vi.advanceTimersByTimeAsync(500);

    expect(calls("remove_host")).toEqual([["remove_host", { id: "host_b" }]]);
    expect(workspaceWrites()).toEqual([{ ...emptyWorkspace(), connected: ["host_c"] }]);
  });

  it("ein frisch hinzugefuegter Host kommt nach connected", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_hosts") return Promise.resolve([]);
      if (command === "ui_settings") return Promise.resolve(uiSettingsDto());
      if (command === "suggest_hosts" || command === "list_ssh_keys") return Promise.resolve([]);
      if (command === "begin_connect") return Promise.resolve("r1");
      if (command === "connect_host") return Promise.resolve("r1");
      if (command === "run_preflight") {
        return Promise.resolve({ tmux_version: "3.4", has_base64: true, socket_dir_writable: true, blocking_problem: null });
      }
      if (command === "add_host") return Promise.resolve(hostEntry({ id: "host_new", label: "new" }));
      if (command === "list_sessions") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    main();
    await flush(30);
    const view = document.querySelector<HTMLElement>("#grid .host-form-view")!;
    fillHostForm(view, "192.0.2.10", "m", "22");
    chooseAgentAuth(view);
    view.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush(20);
    Array.from(document.querySelectorAll<HTMLButtonElement>("#grid button"))
      .find((button) => button.textContent === "Continue")!.click();
    await flush(20);
    expect(hostIndicatorClass("new")).toContain("ind-on");

    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([{ ...emptyWorkspace(), connected: ["host_new"] }]);
  });

  // --- Fix-Runde 1 ------------------------------------------------------

  function agentHosts(count: number): HostEntryLike[] {
    return Array.from({ length: count }, (_, i) =>
      hostEntry({ id: `host_${i + 1}`, label: `H${i + 1}`, hostname: `10.0.1.${i + 1}`, auth_kind: "agent" }),
    );
  }

  function confirmRemove(label: string): void {
    hostMenuItem(label, "Remove…").click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".host-confirm-remove button"))
      .find((button) => button.textContent === "Remove")!.click();
  }

  it("Trennen waehrend eines Verbindens beim Start: der naechste Host kommt dran, ohne Hinweis und ohne Neuverbinden", async () => {
    const answers = new Map<string, (value: unknown) => void>();
    await start({
      hosts: agentHosts(4),
      workspace: { connected: ["host_1", "host_2", "host_3", "host_4"] },
      // Die ersten drei haengen, der vierte verbindet sofort.
      connect: (hostname) =>
        hostname === "10.0.1.4" ? Promise.resolve("ok") : new Promise((resolve) => answers.set(hostname, resolve)),
    });
    expect(connectedHostnames()).toEqual(["10.0.1.1", "10.0.1.2", "10.0.1.3"]);
    expect(hostIndicatorClass("H1")).toContain("ind-connecting");

    hostActionButton("H1", "Disconnect").click();
    await flush(20);
    // Der ueberholte Aufbau kommt zurueck und gibt seinen Platz frei.
    answers.get("10.0.1.1")!("ok");
    await flush(30);

    expect(connectedHostnames()).toEqual(["10.0.1.1", "10.0.1.2", "10.0.1.3", "10.0.1.4"]);
    expect(hostIndicatorClass("H4")).toContain("ind-on");
    expect(hostIndicatorClass("H1")).toContain("ind-off");
    const block = hostRow("H1").parentElement!;
    expect(block.querySelector(".host-quiet")).toBeNull();
    expect(block.querySelector(".host-notice:not(.control-notice):not(.session-list-notice)")).toBeNull();
    expect(bannerShown()).toBe(false);
    // Laenger als die ganze Reihe aus §5.4 (2 + 5 + 15 + 30 + 60 s): kein Neuverbinden.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(connectedHostnames()).toHaveLength(4);
    expect([...workspaceWrites().slice(-1)[0].connected].sort()).toEqual(["host_2", "host_3", "host_4"]);
  });

  it("eine wartende Kachel behaelt ihren Platz, wenn ein Klick eine Session desselben Hosts oeffnen will", async () => {
    let answer!: (dto: unknown) => void;
    await start({
      hosts: [KEY_A, PASSWORD_B],
      sessions: { "10.0.0.1": ["a1", "a2"], "10.0.0.2": ["b-x", "b-y"] },
      read: () => new Promise((resolve) => (answer = resolve)),
    });
    // Vor der Antwort: B einmal verbunden und gelistet, dann getrennt -- seine
    // Sessionzeilen bleiben stehen, seine gespeicherte Kachel wartet gleich.
    await connectFromSidebar("B");
    hostActionButton("B", "Disconnect").click();
    await flush(20);
    answer(uiSettingsDto({
      workspace: {
        ...emptyWorkspace(),
        layout: 4,
        expanded: ["host_b"],
        connected: ["host_a"],
        tiles: [
          { slot: 0, host_id: "host_a", session: "a1" },
          { slot: 1, host_id: "host_a", session: "a2" },
          { slot: 2, host_id: "host_b", session: "b-y" },
        ],
      },
    }));
    await flush(30);
    expect(slots()).toEqual(["a1", "a2"]);

    openViaSidebar("B", "b-x");
    await flush(20);
    hostRow("B").parentElement!.querySelector<HTMLInputElement>(".host-notice input[name=password]")!.value = "host-password";
    hostRetryButton("B").click();
    await flush(30);

    // Erst die gespeicherte Kachel an ihrem Platz, dann die Wahl des Nutzers am Ende.
    expect(slots()).toEqual(["a1", "a2", "b-y", "b-x"]);
  });

  it("schlaegt das Schreiben dauerhaft fehl, schreibt der Status-Poll nicht immer wieder", async () => {
    let busy = false;
    await start({
      hosts: [AGENT_C],
      workspace: { connected: ["host_c"], tiles: [{ slot: 0, host_id: "host_c", session: "c1" }] },
      sessions: { "10.0.0.3": [sessionItem({ display_name: "c1", session_id: 1, status: "idle" })] },
      poll: () => {
        busy = !busy;
        return Promise.resolve(statusPoll([{ session_id: 1, status: busy ? "busy" : "idle" }]));
      },
      write: () => Promise.reject("settings.toml is read-only"),
    });

    chord("b");
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      await flush(20);
    }
    expect(calls("poll_status").length).toBeGreaterThanOrEqual(4);
    expect(workspaceWrites()).toHaveLength(1);

    // Eine echte Aenderung versucht es wieder.
    expandHost("C");
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toHaveLength(2);
  });

  it("verbindet einen Host der Warteschlange nicht, den der Nutzer inzwischen verbunden und wieder getrennt hat", async () => {
    const answers = new Map<string, () => void>();
    await start({
      hosts: agentHosts(4),
      workspace: { connected: ["host_1", "host_2", "host_3", "host_4"] },
      connect: (hostname) =>
        hostname === "10.0.1.4"
          ? Promise.resolve("ok")
          : new Promise((resolve) => answers.set(hostname, () => resolve("ok"))),
    });
    expect(connectedHostnames()).toEqual(["10.0.1.1", "10.0.1.2", "10.0.1.3"]);

    await connectFromSidebar("H4");
    hostActionButton("H4", "Disconnect").click();
    await flush(20);
    answers.get("10.0.1.1")!();
    await flush(30);

    // Die Warteschlange ist bei H4 angekommen -- der Nutzer will ihn getrennt.
    expect(connectedHostnames().filter((hostname) => hostname === "10.0.1.4")).toHaveLength(1);
    expect(hostIndicatorClass("H4")).toContain("ind-off");
  });

  it("ein Trennen vor der Antwort gilt: der Start verbindet den Host nicht wieder und speichert ihn nicht", async () => {
    let answer!: (dto: unknown) => void;
    await start({
      hosts: [AGENT_C],
      sessions: { "10.0.0.3": ["c1"] },
      read: () => new Promise((resolve) => (answer = resolve)),
    });
    await connectFromSidebar("C");
    hostActionButton("C", "Disconnect").click();
    await flush(20);

    answer(uiSettingsDto({ workspace: { ...emptyWorkspace(), connected: ["host_c"] } }));
    await flush(30);

    expect(calls("connect_host")).toHaveLength(1);
    expect(hostIndicatorClass("C")).toContain("ind-off");
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceWrites()).toEqual([emptyWorkspace()]);
  });

  it("ein Entfernen vor der Antwort gilt: keine Eintraege, kein Verbindungsversuch", async () => {
    let answer!: (dto: unknown) => void;
    await start({ hosts: [AGENT_C, KEY_A], read: () => new Promise((resolve) => (answer = resolve)) });
    confirmRemove("C");
    await flush(20);
    expect(calls("remove_host")).toEqual([["remove_host", { id: "host_c" }]]);

    answer(uiSettingsDto({
      workspace: {
        ...emptyWorkspace(),
        layout: 2,
        connected: ["host_c", "host_a"],
        tiles: [{ slot: 0, host_id: "host_c", session: "c1" }],
      },
    }));
    await flush(30);

    expect(connectedHostnames()).toEqual(["10.0.0.1"]);
    expect(slots()).toEqual([]);
  });

  it("ein Klick, waehrend das Entfernen gespeichert wird, oeffnet spaeter nichts", async () => {
    let failRemove!: (reason: unknown) => void;
    await start({
      hosts: [AGENT_C],
      workspace: { expanded: ["host_c"], connected: ["host_c"] },
      sessions: { "10.0.0.3": ["c1"] },
      remove: () => new Promise((_, reject) => (failRemove = reject)),
    });
    confirmRemove("C");
    await flush(20);

    // Die Zeile steht noch, solange das Entfernen laeuft; ein Aufbau kommt nicht zustande.
    openViaSidebar("C", "c1");
    await flush(20);
    expect(calls("connect_host")).toHaveLength(1);
    failRemove("settings.toml is locked");
    await flush(20);

    await connectFromSidebar("C");
    expect(hostIndicatorClass("C")).toContain("ind-on");
    expect(slots()).toEqual([]);
  });

  // UX-Spec §7.6 (Aufgabe 17): der Sitzungsdialog liest und pflegt `dirs`.
  describe("Neue Session (UX-Spec §7.6)", () => {
    const DIRS = { host_a: { last: "/srv/app", recent: ["/srv/app", "/tmp"] } };

    function sessionDialog(): HTMLElement {
      const view = document.querySelector<HTMLElement>(".dialog-body .session-dialog-view");
      if (!view) throw new Error("session dialog is not open");
      return view;
    }
    function recentRow(path: string): HTMLButtonElement {
      const row = Array.from(sessionDialog().querySelectorAll<HTMLButtonElement>(".session-dialog-recent button")).find(
        (candidate) => candidate.textContent === path,
      );
      if (!row) throw new Error(`no recent row ${path}`);
      return row;
    }
    async function openNewSession(): Promise<void> {
      hostActionButton("A", "New session").click();
      await flush(20);
    }

    it("oeffnet mit dem Fokus im Namensfeld, auf dem zuletzt genutzten Verzeichnis und mit der Liste 'Recent'", async () => {
      await start({ hosts: [KEY_A], workspace: { connected: ["host_a"], dirs: DIRS } });
      expect(hostIndicatorClass("A")).toContain("ind-on");

      await openNewSession();

      const view = sessionDialog();
      expect(document.activeElement).toBe(view.querySelector("input[name=sessionName]"));
      expect(view.querySelector<HTMLInputElement>("input[name=cwd]")!.value).toBe("/srv/app");
      expect(Array.from(view.querySelectorAll(".session-dialog-recent button")).map((row) => row.textContent)).toEqual([
        "/srv/app",
        "/tmp",
      ]);
    });

    it("Strg+Umschalt+N oeffnet denselben Dialog, ebenfalls mit dem Fokus im Namensfeld", async () => {
      await start({ hosts: [KEY_A], workspace: { connected: ["host_a"] } });
      chord("n");
      await flush(20);
      expect(document.activeElement).toBe(sessionDialog().querySelector("input[name=sessionName]"));
    });

    // Spec 2026-10-19 §5.1 Nr. 3: an der Gesamtgrenze steht der Hinweis statt
    // des Dialogs, und tmux bekommt keine Session, fuer die keine Kachel kaeme.
    // Der Start belegt die neun Kacheln (4 + 1 + 4); C haette Platz je Host.
    it("Strg+Umschalt+N an der Gesamtgrenze zeigt den Hinweis statt des Dialogs und legt nichts an", async () => {
      const AGENT_D = hostEntry({ id: "host_d", label: "D", hostname: "10.0.0.4", auth_kind: "agent" });
      const saved = [
        ["host_a", "a1"], ["host_a", "a2"], ["host_a", "a3"], ["host_a", "a4"],
        ["host_c", "c1"],
        ["host_d", "d1"], ["host_d", "d2"], ["host_d", "d3"], ["host_d", "d4"],
      ];
      await start({
        hosts: [KEY_A, AGENT_C, AGENT_D],
        workspace: {
          connected: ["host_a", "host_c", "host_d"],
          tiles: saved.map(([host_id, session], slot) => ({ slot, host_id, session })),
        },
        sessions: { "10.0.0.1": ["a1", "a2", "a3", "a4"], "10.0.0.3": ["c1"], "10.0.0.4": ["d1", "d2", "d3", "d4"] },
      });
      await flush(30);
      expect(slots()).toEqual(saved.map(([, session]) => session));
      invokeMock.mockClear();

      hostRow("C").focus();
      chord("n");
      await flush(20);

      expect(document.querySelector(".dialog-panel")).toBeNull();
      const banner = document.querySelector<HTMLElement>(".global-error-banner")!;
      expect(banner.hidden).toBe(false);
      expect(banner.classList.contains("global-error-banner--neutral")).toBe(true);
      expect(banner.textContent).toContain("9 terminals are open, the limit.");
      expect(calls("list_directories")).toEqual([]);
      expect(calls("create_session")).toEqual([]);
    });

    it("nach dem Anlegen steht das Verzeichnis vorn in dirs[host].recent und ist das zuletzt genutzte", async () => {
      await start({ hosts: [KEY_A], workspace: { connected: ["host_a"], dirs: DIRS }, sessions: { "10.0.0.1": ["a1"] } });
      await openNewSession();
      recentRow("/tmp").click();
      await flush(20);
      submitDialogForm();
      await flush(30);

      expect(calls("create_session").map(([, args]) => args)).toEqual([{ hostId: "r1", cwd: "/tmp", name: "tmp" }]);
      await vi.advanceTimersByTimeAsync(500);
      expect(workspaceWrites().map((ws) => ws.dirs)).toEqual([{ host_a: { last: "/tmp", recent: ["/tmp", "/srv/app"] } }]);

      // Der naechste Dialog oeffnet dort, die Liste folgt.
      await openNewSession();
      expect(sessionDialog().querySelector<HTMLInputElement>("input[name=cwd]")!.value).toBe("/tmp");
      expect(Array.from(sessionDialog().querySelectorAll(".session-dialog-recent button")).map((row) => row.textContent))
        .toEqual(["/tmp", "/srv/app"]);
    });

    it("ein gescheitertes Anlegen aendert die gespeicherten Verzeichnisse nicht", async () => {
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], dirs: DIRS },
        create: () => Promise.reject({ kind: "duplicate", message: "duplicate session" }),
      });
      await openNewSession();
      recentRow("/tmp").click();
      await flush(20);
      submitDialogForm();
      await flush(30);
      expect(calls("create_session")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(workspaceWrites()).toEqual([]);
      // Fix-Runde 1, Minor 5: auch im Lauf zaehlt nur ein gelungenes Anlegen --
      // der naechste Dialog oeffnet am zuletzt genutzten Verzeichnis.
      await openNewSession();
      expect(sessionDialog().querySelector<HTMLInputElement>("input[name=cwd]")!.value).toBe("/srv/app");
    });

    // Fix-Runde 1, Minor 4: gemerkt wird nach JEDEM gelungenen Anlegen.
    it("ein Anlegen, das gelingt, waehrend der Host neu verbindet, merkt sich das Verzeichnis trotzdem", async () => {
      let finishCreate!: (name: string) => void;
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], dirs: DIRS },
        create: () => new Promise((resolve) => (finishCreate = resolve)),
      });
      await openNewSession();
      recentRow("/tmp").click();
      await flush(20);
      submitDialogForm();
      await flush(20);

      // Die Verbindung faellt, bevor die Antwort kommt; die Session gibt es trotzdem.
      emitTransportLost("r1");
      await flush(20);
      finishCreate("tmp");
      await flush(30);
      await vi.advanceTimersByTimeAsync(500);
      expect(workspaceWrites().map((ws) => ws.dirs)).toEqual([{ host_a: { last: "/tmp", recent: ["/tmp", "/srv/app"] } }]);
    });
  });

  // UX-Spec §7.7 (Aufgabe 18): "Edit host" mit Feld "Name" und "Save". Nur der
  // Name: speichern, sonst nichts. Verbindungsfelder an einem verbundenen Host:
  // trennen, speichern, wieder verbinden -- kein Trennen durch den Nutzer.
  describe("Host bearbeiten (UX-Spec §7.7)", () => {
    const CONNECTION_COMMANDS = ["disconnect_host", "update_host", "begin_connect", "connect_host"];

    async function openEdit(label: string): Promise<HTMLElement> {
      hostMenuItem(label, "Edit…").click();
      await flush(20);
      return dialogHostFormView();
    }
    function setField(view: HTMLElement, name: string, value: string): void {
      const input = view.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    async function save(): Promise<void> {
      submitDialogForm();
      await flush(40);
    }
    /** Die Verbindungs- und Speicherbefehle ab dem `index`-ten Aufruf, in Reihenfolge. */
    function commandsSince(index: number): string[] {
      return invokeMock.mock.calls.slice(index).map(([name]) => name).filter((name) => CONNECTION_COMMANDS.includes(name));
    }
    function dialogOpen(): boolean {
      return document.querySelector(".dialog-panel") !== null;
    }
    function quickOpenTexts(): string[] {
      return Array.from(document.querySelectorAll(".dialog-panel .quick-open-label")).map((label) => label.textContent ?? "");
    }
    /** Der letzte Eintrag (`Array.prototype.at` kennt das Ziel-`lib` nicht). */
    function lastOf<T>(items: readonly T[]): T | undefined {
      return items[items.length - 1];
    }

    it("nur der Name: update_host ohne Trennen; Kachel, Terminal und Aufklappen bleiben, ueberall steht der neue Name", async () => {
      await start({
        hosts: [KEY_A],
        workspace: { expanded: ["host_a"], connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
        sessions: { "10.0.0.1": ["a1"] },
      });
      expect(slots()[0]).toBe("a1");
      const before = invokeMock.mock.calls.length;

      const view = await openEdit("A");
      expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe("Save");
      setField(view, "label", "Build VM");
      await save();

      expect(dialogOpen()).toBe(false);
      expect(commandsSince(before)).toEqual(["update_host"]);
      expect(calls("update_host")[0][1]).toMatchObject({ id: "host_a", entry: { label: "Build VM", hostname: "10.0.0.1", port: 22 } });
      expect(hostIndicatorClass("Build VM")).toContain("ind-on");
      expect(hostRow("Build VM").getAttribute("aria-expanded")).toBe("true");
      expect(slots()[0]).toBe("a1");
      expect(terminalHoisted.mountsByKey.get("r1/a1")).toBe(1);
      expect(document.querySelector("#grid .tile:not(.tile-empty) .tile-host")?.textContent).toBe("Build VM");
      chord("p");
      expect(quickOpenTexts()).toContain("New session on Build VM");
      escape();
      // Am Arbeitsplatz aendert ein neuer Name nichts.
      await vi.advanceTimersByTimeAsync(500);
      expect(workspaceWrites()).toEqual([]);
    });

    // Nach einem GELUNGENEN Speichern hat das Neuzeichnen der Seitenleiste den
    // Oeffner (den ⋯-Knopf) ersetzt; die Huelle gibt den Fokus dann ueber
    // `fallbackFocus` an die Hostzeile.
    it("nach einem gelungenen Speichern steht der Fokus auf der Hostzeile", async () => {
      await start({ hosts: [KEY_A], workspace: { connected: ["host_a"] } });
      const view = await openEdit("A");
      setField(view, "label", "Build VM");
      await save();

      expect(dialogOpen()).toBe(false);
      expect(document.activeElement).toBe(hostRow("Build VM"));
    });

    it("ein geleertes Namensfeld macht den Hostnamen zum Namen, ebenfalls ohne Trennen", async () => {
      await start({ hosts: [KEY_A], workspace: { connected: ["host_a"] } });
      const view = await openEdit("A");
      expect(view.querySelector<HTMLInputElement>("input[name=label]")!.value).toBe("A");
      setField(view, "label", "");
      await save();

      expect(calls("update_host")[0][1]).toMatchObject({ entry: { label: "10.0.0.1" } });
      expect(calls("disconnect_host")).toEqual([]);
      expect(hostIndicatorClass("10.0.0.1")).toContain("ind-on");
    });

    it("Port geaendert am verbundenen Key-Host: speichern, trennen, wieder verbinden -- die Kachel haengt sich wieder an", async () => {
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
        sessions: { "10.0.0.1": ["a1"] },
      });
      expect(slots()[0]).toBe("a1");
      const before = invokeMock.mock.calls.length;

      const view = await openEdit("A");
      setField(view, "port", "2222");
      await save();

      expect(dialogOpen()).toBe(false);
      // Aufgabe 18: zuerst gespeichert, erst danach getrennt.
      expect(commandsSince(before)).toEqual(["update_host", "disconnect_host", "begin_connect", "connect_host"]);
      expect(lastOf(calls("disconnect_host"))?.[1]).toEqual({ hostId: "r1" });
      expect(calls("update_host")[0][1]).toMatchObject({ id: "host_a", entry: { port: 2222 } });
      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ hostId: "r2", spec: { port: 2222 } });
      expect(hostIndicatorClass("A")).toContain("ind-on");
      expect(slots()[0]).toBe("a1");
      expect(terminalHoisted.mountsByKey.get("r2/a1")).toBe(1);
      // Kein Trennen durch den Nutzer (§7.1): der Host bleibt in connected.
      chord("b");
      await vi.advanceTimersByTimeAsync(500);
      expect(lastOf(workspaceWrites())?.connected).toEqual(["host_a"]);
    });

    it("scheitert das Wiederverbinden, steht der gewohnte Fehler da -- ohne Neuverbinden, und der Host bleibt in connected", async () => {
      let attempts = 0;
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"] },
        connect: () => (++attempts === 1 ? Promise.resolve("ok") : Promise.reject(NETWORK)),
      });
      const view = await openEdit("A");
      setField(view, "port", "2222");
      await save();

      expect(hostIndicatorClass("A")).toContain("ind-fail");
      expect(hostRow("A").parentElement!.querySelector(".host-quiet")).toBeNull();
      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      expect(calls("connect_host")).toHaveLength(2);
      chord("b");
      await vi.advanceTimersByTimeAsync(500);
      expect(lastOf(workspaceWrites())?.connected).toEqual(["host_a"]);
    });

    it("Passwort-Host: nach dem Speichern erscheint das Passwortfeld, und der Fokus geht hinein, sobald der Dialog zu ist", async () => {
      await start({ hosts: [PASSWORD_B], sessions: { "10.0.0.2": ["b1"] } });
      await connectFromSidebar("B");
      expect(hostIndicatorClass("B")).toContain("ind-on");
      const before = invokeMock.mock.calls.length;

      const view = await openEdit("B");
      setField(view, "port", "2222");
      await save();

      expect(dialogOpen()).toBe(false);
      // Ohne Passwort kein Versuch: nur das Feld.
      expect(commandsSince(before)).toEqual(["update_host", "disconnect_host"]);
      const password = hostRow("B").parentElement!.querySelector<HTMLInputElement>(".host-notice input[name=password]");
      expect(password).not.toBeNull();
      expect(document.activeElement).toBe(password);
    });

    it("ebenso, wenn erst der Versuch die Passphrase des Schluessels verlangt", async () => {
      let attempts = 0;
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"] },
        connect: () =>
          ++attempts === 1
            ? Promise.resolve("ok")
            : Promise.reject({ code: "passphrase_required", message: "The key needs its passphrase." }),
      });
      const view = await openEdit("A");
      setField(view, "port", "2222");
      await save();

      expect(calls("connect_host")).toHaveLength(2);
      expect(document.activeElement).toBe(hostRow("A").parentElement!.querySelector(".host-notice input[name=passphrase]"));
    });

    it("ein getrennter Host wird nur gespeichert, nicht verbunden", async () => {
      await start({ hosts: [KEY_A] });
      const before = invokeMock.mock.calls.length;
      const view = await openEdit("A");
      setField(view, "port", "2222");
      await save();

      expect(commandsSince(before)).toEqual(["update_host"]);
      expect(hostIndicatorClass("A")).toContain("ind-off");
    });

    it("ein Umbenennen, waehrend die App den Host neu verbindet, laesst das Neuverbinden laufen", async () => {
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
        sessions: { "10.0.0.1": ["a1"] },
      });
      emitTransportLost("r1");
      await flush(20);
      expect(hostRow("A").parentElement!.querySelector(".host-quiet")?.textContent).toBe("Reconnecting…");

      const view = await openEdit("A");
      setField(view, "label", "Build VM");
      await save();
      expect(hostRow("Build VM").parentElement!.querySelector(".host-quiet")?.textContent).toBe("Reconnecting…");

      await vi.advanceTimersByTimeAsync(2000);
      await flush(30);
      expect(calls("connect_host")).toHaveLength(2);
      expect(hostIndicatorClass("Build VM")).toContain("ind-on");
      expect(slots()[0]).toBe("a1");
    });

    it("ein Versuch des Neuverbindens, der faellig wird, waehrend der neue Name gespeichert wird, laeuft trotzdem", async () => {
      let finishUpdate!: (entry: unknown) => void;
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"] },
        update: () => new Promise((resolve) => (finishUpdate = resolve)),
      });
      emitTransportLost("r1");
      await flush(20);
      const view = await openEdit("A");
      setField(view, "label", "Build VM");
      submitDialogForm();
      await flush(20);

      // `update_host` laeuft noch, als der Versuch kommt: er gilt nicht als ueberholt.
      await vi.advanceTimersByTimeAsync(2000);
      await flush(30);
      expect(calls("connect_host")).toHaveLength(2);
      expect(hostIndicatorClass("A")).toContain("ind-on");

      finishUpdate({ ...KEY_A, label: "Build VM" });
      await flush(30);
      expect(dialogOpen()).toBe(false);
      expect(hostIndicatorClass("Build VM")).toContain("ind-on");
    });

    // Fix-Runde 1: zuerst speichern; danach verbindet
    // jeder Host neu, der eine Verbindung will (nur ein getrennter nicht), und
    // ein im Formular getipptes Geheimnis traegt genau diesen einen Aufbau.
    it("waehrend des Neuverbindens Port geaendert: die Reihe endet, genau ein Aufbau mit dem neuen Port, die Kachel bleibt", async () => {
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
        sessions: { "10.0.0.1": ["a1"] },
      });
      emitTransportLost("r1");
      await flush(20);
      expect(hostRow("A").parentElement!.querySelector(".host-quiet")?.textContent).toBe("Reconnecting…");

      const view = await openEdit("A");
      setField(view, "port", "2222");
      await save();

      expect(calls("connect_host")).toHaveLength(2);
      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ hostId: "r2", spec: { port: 2222 } });
      expect(hostIndicatorClass("A")).toContain("ind-on");
      expect(slots()[0]).toBe("a1");
      expect(terminalHoisted.mountsByKey.get("r2/a1")).toBe(1);
      // Keine neue Reihe, und der Host bleibt mitsamt Kachel im Arbeitsplatz.
      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      expect(calls("connect_host")).toHaveLength(2);
      chord("b");
      await vi.advanceTimersByTimeAsync(500);
      expect(lastOf(workspaceWrites())?.connected).toEqual(["host_a"]);
      expect(lastOf(workspaceWrites())?.tiles).toEqual([{ slot: 0, host_id: "host_a", session: "a1" }]);
    });

    it("scheitert das Speichern, bleibt alles, wie es war -- ein zweites Save gelingt wie ein erstes", async () => {
      let updates = 0;
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
        sessions: { "10.0.0.1": ["a1"] },
        update: (saved) => (++updates === 1 ? Promise.reject("disk full") : Promise.resolve(saved)),
      });
      const before = invokeMock.mock.calls.length;
      const view = await openEdit("A");
      setField(view, "port", "2222");
      await save();

      // Nichts getrennt: Verbindung, Kachel und Terminal unberuehrt, der Fehler steht im Dialog.
      expect(commandsSince(before)).toEqual(["update_host"]);
      expect(document.querySelector(".dialog-panel")?.textContent).toContain("disk full");
      expect(hostIndicatorClass("A")).toContain("ind-on");
      expect(slots()[0]).toBe("a1");
      expect(terminalHoisted.mountsByKey.get("r1/a1")).toBe(1);

      submitDialogForm();
      await flush(40);
      expect(commandsSince(before)).toEqual(["update_host", "update_host", "disconnect_host", "begin_connect", "connect_host"]);
      expect(dialogOpen()).toBe(false);
      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ hostId: "r2", spec: { port: 2222 } });
      expect(hostIndicatorClass("A")).toContain("ind-on");
      expect(slots()[0]).toBe("a1");
      expect(terminalHoisted.mountsByKey.get("r2/a1")).toBe(1);
    });

    it("bis das Speichern gelingt, laeuft ein faelliges Neuverbinden -- und scheitert es, bleibt alles stehen", async () => {
      let failUpdate!: (reason: unknown) => void;
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
        sessions: { "10.0.0.1": ["a1"] },
        update: () => new Promise((_, reject) => (failUpdate = reject)),
      });
      emitTransportLost("r1");
      await flush(20);
      const view = await openEdit("A");
      setField(view, "port", "2222");
      submitDialogForm();
      await flush(20);

      // Der Versuch der Reihe kommt, waehrend `update_host` laeuft -- noch mit den alten Werten.
      await vi.advanceTimersByTimeAsync(2000);
      await flush(30);
      expect(calls("connect_host")).toHaveLength(2);
      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ spec: { port: 22 } });
      expect(hostIndicatorClass("A")).toContain("ind-on");
      const disconnects = calls("disconnect_host").length;

      failUpdate("disk full");
      await flush(30);
      expect(document.querySelector(".dialog-panel")?.textContent).toContain("disk full");
      expect(calls("disconnect_host")).toHaveLength(disconnects);
      expect(calls("connect_host")).toHaveLength(2);
      expect(hostIndicatorClass("A")).toContain("ind-on");
      expect(slots()[0]).toBe("a1");
    });

    it("ein gescheiterter Host ohne Neuverbinden: Port geaendert -- ein Aufbau mit dem neuen Port", async () => {
      let attempts = 0;
      await start({
        hosts: [KEY_A],
        connect: () => (++attempts === 1 ? Promise.reject({ code: "other", message: "Something broke." }) : Promise.resolve("ok")),
      });
      await connectFromSidebar("A");
      expect(hostIndicatorClass("A")).toContain("ind-fail");
      expect(hostRow("A").parentElement!.querySelector(".host-quiet")).toBeNull();

      const view = await openEdit("A");
      setField(view, "port", "2222");
      await save();

      expect(calls("connect_host")).toHaveLength(2);
      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ spec: { port: 2222 } });
      expect(hostIndicatorClass("A")).toContain("ind-on");
    });

    it("ein im Formular getipptes Passwort traegt genau diesen Aufbau -- gelingt er, fragt die Seitenleiste nicht", async () => {
      await start({ hosts: [PASSWORD_B], sessions: { "10.0.0.2": ["b1"] } });
      await connectFromSidebar("B");
      const view = await openEdit("B");
      setField(view, "port", "2222");
      setField(view, "password", "new-secret");
      await save();

      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ spec: { port: 2222, password: "new-secret" } });
      expect(hostIndicatorClass("B")).toContain("ind-on");
      expect(hostRow("B").parentElement!.querySelector(".host-notice input[name=password]")).toBeNull();
    });

    it("ebenso eine getippte Passphrase des Schluessels", async () => {
      await start({ hosts: [KEY_A], workspace: { connected: ["host_a"] } });
      const view = await openEdit("A");
      setField(view, "port", "2222");
      setField(view, "passphrase", "key-pass");
      await save();

      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ spec: { port: 2222, passphrase: "key-pass" } });
      expect(hostIndicatorClass("A")).toContain("ind-on");
    });

    it("ohne Wiederverbinden verfaellt ein getipptes Passwort: nur der Name, kein Aufbau", async () => {
      await start({ hosts: [PASSWORD_B], sessions: { "10.0.0.2": ["b1"] } });
      await connectFromSidebar("B");
      const before = invokeMock.mock.calls.length;
      const view = await openEdit("B");
      setField(view, "label", "Build VM");
      setField(view, "password", "new-secret");
      await save();

      expect(commandsSince(before)).toEqual(["update_host"]);
      expect(hostIndicatorClass("Build VM")).toContain("ind-on");
    });

    // Fix-Runde 1, Minor 6b: eine stehen gebliebene Kachel haengt sich nur dort
    // wieder an, wo es ihre Session noch gibt; sonst schliesst sie die neue Liste.
    it("eine Kachel, deren Session es nach dem Wiederverbinden nicht mehr gibt, schliesst mit der neuen Sessionliste", async () => {
      await start({
        hosts: [KEY_A],
        workspace: { connected: ["host_a"], tiles: [{ slot: 0, host_id: "host_a", session: "a1" }] },
        sessions: { "10.0.0.1": ["a1"], "10.0.0.9": ["b1"] },
      });
      expect(slots()[0]).toBe("a1");
      const view = await openEdit("A");
      setField(view, "hostname", "10.0.0.9");
      await save();

      expect(lastOf(calls("connect_host"))?.[1]).toMatchObject({ spec: { hostname: "10.0.0.9" } });
      expect(hostIndicatorClass("A")).toContain("ind-on");
      expect(slots()[0]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(500);
      expect(lastOf(workspaceWrites())?.tiles).toEqual([]);
    });
  });
});
