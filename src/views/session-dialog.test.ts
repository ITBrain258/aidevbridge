// Gegenprobe fuer `session-dialog.ts` (Shell-Task 9b, Spec §6.4/§9.3; ab
// Verzeichnisauswahl-Task 4 zusaetzlich der eingebundene Verzeichnisbaum).
// Die Faelle des ersten Blocks stammen aus Shell-Task 9b (Schritt 1) und
// Verzeichnisauswahl-Task 4.
//
// Der frueher hier stehende Satz "bewusst OHNE `@tauri-apps/api/core`-Mock
// in diesem Block: `mountSessionDialog` darf `invoke` nie aufrufen" ist mit
// Task 4 HINFAELLIG: der Dialog bindet `mountDirectoryTree` ein, und der
// ruft `list_directories`. Die Attrappe gilt (`vi.mock` wird gehoisted)
// ohnehin fuer die ganze Datei; seit Task 4 wird sie im ersten Block auch
// bestueckt.
//
// Zu den drei Faellen aus Task 4:
//  - Fall 1 braucht den geladenen Baum und wartet auf `mountDialog(...)`,
//    die Faelle 2 und 3 kaemen mit einem synchronen `const { el } =
//    mountDialog(...)` aus. Beides zugleich ginge nur mit
//    einem Objekt, das nebenbei ein `then` traegt. Stattdessen dasselbe
//    Paar wie in `directory-tree.test.ts`: `openDialog` synchron,
//    `mountDialog` als abwartende Huelle darum -- Faelle 2 und 3 sind
//    deshalb `async`.
//  - Die Faelle 2 und 3 sind wortgleich mit zwei bereits bestehenden
//    Faellen dieser Datei. Sie stehen NICHT ein zweites Mal da; die
//    bestehenden tragen jetzt die Titel aus Task 4 und behalten ihre
//    staerkeren Zusicherungen.
//
// `editHost` (zweiter Block) prueft die Absendereihenfolge aus Schritt 5
// von Shell-Task 9b.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changesConnection,
  editHost,
  mountSessionDialog,
  reconnectSecret,
  suggestSessionName,
  type SessionDialogHandle,
} from "./session-dialog";
import type { Host } from "../state/app-state";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

/** Das Dateisystem der Attrappe -- klein gehalten, der Baum selbst ist in
 * `directory-tree.test.ts` abgedeckt. Hier zaehlt nur, was der DIALOG mit
 * ihm macht. */
const FS: Record<string, string[]> = {
  "/": ["home", "srv", "tmp"],
  "/home": ["u"],
  "/home/u": ["repo"],
  "/home/u/repo": [],
  "/srv": ["projekt"],
  "/srv/projekt": [],
  "/tmp": [],
};

/** Was `list_directories` bei leerem Pfad aufloest (Spec §3.3).
 *
 * Bewusst NICHT der Feldwert irgendeines Falls: sonst landete ein Baum, der
 * faelschlich mit leerem `initialPath` startet, zufaellig am selben Ort, und
 * die Zusicherung ueber die Ahnenkette fasste ihn nur noch an der einen
 * ueberzaehligen Runde (Befund aus dem Review dieser Aufgabe). */
const HOME = "/srv/projekt";

interface Call {
  hostId: string;
  path: string;
}

let calls: Call[] = [];
let handles: SessionDialogHandle[] = [];

/** Eine Makrotask: die Attrappe loest sofort auf, also ist die gesamte
 * Mikrotask-Schlange danach abgearbeitet -- auch die Ahnenkette, die der
 * Baum Glied fuer Glied abwartet. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  calls = [];
  handles = [];
  document.body.replaceChildren();
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, params?: Record<string, unknown>) => {
    if (cmd !== "list_directories") return Promise.resolve(null);
    const path = params?.path as string;
    calls.push({ hostId: params?.hostId as string, path });
    const resolved = path === "" ? HOME : path;
    return Promise.resolve({ path: resolved, entries: FS[resolved] ?? [] });
  });
});

afterEach(() => {
  // Jede gemountete Ansicht wird entsorgt, BEVOR der naechste Fall die
  // Attrappe zuruecksetzt. Ein stehengelassener Baum liefe sonst spaeter in
  // ein `invoke`, das kein Versprechen mehr liefert -- eine unbehandelte
  // Ablehnung, die einen fremden Fall rot faerbt.
  for (const handle of handles) handle.dispose();
});

interface DialogArgs {
  initialCwd?: string;
  hostId?: string;
  existingSessions?: string[];
  recentDirs?: string[];
}

interface Parts {
  el: HTMLElement;
  handle: SessionDialogHandle;
  onSubmit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  calls: Call[];
}

/** Mountet, OHNE abzuwarten -- fuer den Entsorgungsfall, der genau den
 * Zustand vor der ersten Antwort braucht. */
function openDialog(args: DialogArgs = {}): Parts {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const handle = mountSessionDialog(el, {
    hostId: args.hostId ?? "h1",
    initialCwd: args.initialCwd ?? "/tmp",
    existingSessions: args.existingSessions ?? [],
    recentDirs: args.recentDirs ?? [],
    onSubmit,
    onCancel,
  });
  handles.push(handle);
  return { el, handle, onSubmit, onCancel, calls };
}

async function mountDialog(args: DialogArgs = {}): Promise<Parts> {
  const parts = openDialog(args);
  await flush();
  return parts;
}

function cwdInput(el: HTMLElement): HTMLInputElement {
  // Ueber den Namen, nicht ueber die Position: der Baum bringt eine zweite
  // `<input>` mit (den Versteckt-Schalter), `querySelector("input")` waere
  // seit Task 4 nur noch zufaellig richtig.
  return el.querySelector("input[name=cwd]") as HTMLInputElement;
}

function submit(el: HTMLElement): void {
  (el.querySelector("form") as HTMLFormElement).dispatchEvent(
    new Event("submit", { cancelable: true, bubbles: true }),
  );
}

function hiddenToggle(el: HTMLElement): HTMLInputElement {
  return el.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

function alertText(el: HTMLElement): string {
  return el.querySelector("[role=alert]")?.textContent ?? "";
}

/** Ueber die Eigenschaft verglichen statt per Attributselektor -- ein
 * Verzeichnisname darf jedes Zeichen tragen (dasselbe Vorgehen wie in
 * `directory-tree.test.ts`). */
function selectInTree(el: HTMLElement, path: string): void {
  const row = Array.from(el.querySelectorAll<HTMLElement>("[data-path]")).find(
    (node) => node.dataset.path === path,
  );
  if (row === undefined) throw new Error(`keine Baumzeile fuer ${path}`);
  row.click();
}

// B2: Sessionnamen. Ohne eigenen Namen weiss nach zwei Tagen niemand mehr,
// was `ab_64d3b4` war -- und erst mit sprechenden Namen bekommt
// Ctrl+Shift+1..9 eine Bedeutung, die man sich merken kann.
describe("mountSessionDialog: eigener Sessionname", () => {
  function nameInput(el: HTMLElement): HTMLInputElement {
    return el.querySelector("input[name=sessionName]") as HTMLInputElement;
  }

  it("gibt null weiter, wenn das Feld leer bleibt -- das Backend erzeugt dann einen Namen", async () => {
    const { el, onSubmit } = await mountDialog({ initialCwd: "/tmp" });
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/tmp", null);
  });

  it("gibt einen eingetippten Namen unveraendert weiter", async () => {
    const { el, onSubmit } = await mountDialog({ initialCwd: "/tmp" });
    nameInput(el).value = "deploy log 2";
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/tmp", "deploy log 2");
  });

  it("behandelt einen nach dem Trimmen leeren Namen als 'kein Name'", async () => {
    // `list_session_names` trimmt jede Zeile und filtert leere -- ein
    // Nur-Leerzeichen-Name verschwaende komplett aus jeder Liste, und ein
    // Name mit Randleerzeichen hiesse dort anders als bei der Anlage.
    const { el, onSubmit } = await mountDialog({ initialCwd: "/tmp" });
    nameInput(el).value = "   ";
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/tmp", null);
  });

  it("trimmt Randleerzeichen eines sonst gueltigen Namens", async () => {
    const { el, onSubmit } = await mountDialog({ initialCwd: "/tmp" });
    nameInput(el).value = "  deploy  ";
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/tmp", "deploy");
  });

  // Zugesichert wird, dass GAR NICHT abgesendet wird -- nicht nur, dass eine
  // Meldung erscheint. Ein Formular, das ablehnt UND absendet, saehe an der
  // Meldung allein richtig aus.
  //
  // Jeder Fall ist an der VM gemessen (siehe `tmux::names`): `#H` wird zum
  // Hostnamen, `#(...)` fuehrt ein Kommando aus, `$` erzeugt eine Session,
  // die diese Anwendung weder oeffnen noch beenden kann, `.`/`:` werden
  // still ersetzt, und ein Umlaut heisst je nach tmux-Version anders.
  for (const [beschreibung, hostile] of [
    ["ein #", "log#H"],
    ["ein $", "log$x"],
    ["einen Punkt", "log.1"],
    ["einen Doppelpunkt", "log:1"],
    ["einen Umlaut", "büro"],
  ] as const) {
    it(`lehnt ${beschreibung} ab, BEVOR abgesendet wird`, async () => {
      const { el, onSubmit } = await mountDialog({ initialCwd: "/tmp" });
      nameInput(el).value = hostile;
      submit(el);
      expect(onSubmit).not.toHaveBeenCalled();
      // Die Meldung nennt die REGEL, nicht nur "ungueltig" (UX-Spec §10).
      expect(alertText(el)).toBe("Use only letters, digits, spaces, _ and -. tmux would change other characters.");
    });
  }

  it("lehnt einen bereits vergebenen Namen ab, BEVOR abgesendet wird", async () => {
    const { el, onSubmit } = await mountDialog({
      initialCwd: "/tmp",
      existingSessions: ["deploy", "ab_64d3b4"],
    });
    nameInput(el).value = "deploy";
    submit(el);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(alertText(el)).toContain("deploy");
  });
});

describe("mountSessionDialog", () => {
  it("uebernimmt den vorbelegten Wert", async () => {
    const { el } = await mountDialog({ initialCwd: "/home/u/repo" });
    expect(cwdInput(el).value).toBe("/home/u/repo");
  });

  it("schreibt eine Auswahl aus dem Baum ins Feld", async () => {
    // Abnahmekriterium 6, erste Haelfte: der Baum ist der zweite Weg zum
    // Pfad, das Feld bleibt der erste.
    const { el } = await mountDialog({ initialCwd: "/home/u" });
    selectInTree(el, "/home/u/repo");
    expect(cwdInput(el).value).toBe("/home/u/repo");
  });

  it("oeffnet den Baum auf dem Feldwert und mit der Host-ID des Aufrufers", async () => {
    // Die beiden Werte, die diese Datei durchreicht -- und beide sind still
    // falsch zu bekommen. Ein Baum, der auf dem Heimatverzeichnis statt auf
    // dem Feldwert oeffnet (Abnahmekriterium 2), sieht bedienbar aus; eine
    // durchgereichte settings.toml-ID statt der LAUFZEIT-ID (`main.ts`,
    // Kopfkommentar zu den zwei ID-Raeumen) faellt erst auf der VM auf, mit
    // "host not connected" an jeder Zeile.
    const { calls } = await mountDialog({ initialCwd: "/home/u", hostId: "h7" });
    expect(calls.map((c) => c.path)).toEqual(["/", "/home", "/home/u"]);
    expect(calls.map((c) => c.hostId)).toEqual(["h7", "h7", "h7"]);
  });

  it("laesst den Baum unberuehrt, waehrend im Feld getippt wird", async () => {
    // Ein Baum, der dem Feld nachfuehrt, kostet eine SSH-Runde JE ZEICHEN.
    // Das Feld bleibt der Weg fuer alle, die den Pfad
    // kennen -- es fuehrt den Baum nicht.
    const { el, calls } = await mountDialog({ initialCwd: "/tmp" });
    const before = calls.length;

    cwdInput(el).value = "/home/u/repo";
    cwdInput(el).dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    expect(calls.slice(before)).toEqual([]);
  });

  it("nimmt der Ablehnung ihre Grundlage, wenn der Baum den Pfad ersetzt", async () => {
    // Zweite Haelfte von `onSelect`: der Baum schreibt am `input`-Ereignis
    // VORBEI (eine Zuweisung an `.value` loest keines aus), die
    // Frischentscheidung des Feldes greift hier also nicht von selbst.
    // Ohne die Zeile bliebe die rote Ablehnung ueber einem Pfad stehen, den
    // der Nutzer gerade durch einen gueltigen ersetzt hat.
    const { el } = await mountDialog({ initialCwd: "/home/u" });
    cwdInput(el).value = "repo/unterordner";
    submit(el);
    expect(alertText(el)).not.toBe("");

    selectInTree(el, "/home/u/repo");

    expect(alertText(el)).toBe("");
  });

  it("haelt Enter auf dem Versteckt-Schalter an", async () => {
    // Der Schalter steht IM `<form>`, und ein echter Browser macht aus
    // `Enter` auf einem Formularelement die implizite Absendung: Tabulator
    // auf "Show hidden entries", `Enter` in der Erwartung umzuschalten --
    // und die Session ist angelegt. jsdom bildet die implizite Absendung
    // NICHT ab, eine Zusicherung auf "hat nicht abgesendet" waere hier also
    // leer. Zugesichert ist die Abwehr, die es verhindert (der Behandler
    // sitzt in `directory-tree.ts`, die Gefahr entsteht durch diese
    // Einbettung).
    const { el } = await mountDialog({ initialCwd: "/home/u" });
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    hiddenToggle(el).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("laesst Space auf dem Versteckt-Schalter durch", async () => {
    // Die andere Haelfte derselben Abwehr, und ohne sie ist die erste
    // gefaehrlich: angehalten wird NUR `Enter`. `Space` ist die einzige
    // Taste, mit der eine Checkbox ueberhaupt bedient wird -- eine Wache
    // ohne Tastenpruefung (`if (disposed) return`) legte den Schalter fuer
    // Tastaturnutzer still, und der Fall darueber bliebe dabei gruen
    // (nachgemessen, Review dieser Aufgabe: 268/268).
    const { el } = await mountDialog({ initialCwd: "/home/u" });
    const event = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });

    hiddenToggle(el).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("laesst den Fokus im Feld, waehrend der Baum sich oeffnet", async () => {
    // Die andere Haelfte von "das Feld bleibt der erste Weg": es reicht
    // nicht, dass der getippte Wert stehen bleibt -- er muss auch weiter
    // tippbar sein. Der Baum klappt sich waehrenddessen selbst auf und
    // ruft dabei `applyRoving`, das eine Zeile fokussieren KANN. Genau
    // dieser Fall entsteht erst dadurch, dass der Baum neben einem
    // Textfeld steht; `directory-tree.test.ts` mountet ihn allein.
    //
    // In `main.ts` ist es die Schliessen-Schaltflaeche, die den Fokus beim
    // Oeffnen bekommt (`openDialog` ruft `closeButton.focus()` NACH
    // `build(body)`) -- das Feld hier ist der schaerfere Fall: der Nutzer
    // tippt bereits, waehrend die Ahnenkette noch unterwegs ist.
    const { el } = openDialog({ initialCwd: "/home/u" });
    cwdInput(el).focus();
    expect(document.activeElement).toBe(cwdInput(el));

    await flush();

    expect(document.activeElement).toBe(cwdInput(el));
  });

  it("laesst einen direkt getippten Pfad unveraendert durch", async () => {
    // Spec E4, und zugleich der zweite Fall aus Task 4: der Umbau
    // darf den getippten Pfad nicht anfassen. Frueherer Titel: "laesst
    // einen absoluten Pfad durch" -- selbe Zusicherung, schaerferer Name.
    const { el, onSubmit } = await mountDialog();
    cwdInput(el).value = "/srv/projekt";
    submit(el);
    // Zweites Argument seit B2: der Sessionname, hier ungesetzt.
    expect(onSubmit).toHaveBeenCalledWith("/srv/projekt", null);
  });

  it("weist einen relativen Pfad weiterhin ab", async () => {
    // `remote::command::build_in_dir` prueft `cwd.starts_with('/')` mit
    // einem `assert!`. Ein relativer Pfad wuerde den Rust-Prozess ZUM
    // ABSTURZ bringen -- es gaebe keine Fehlermeldung, das Fenster waere
    // einfach weg. Deshalb muss der Dialog abfangen, nicht das Backend;
    // "weiterhin" ist die Auflage an Task 4, diese Pruefung beim Einbinden
    // des Baums nicht zu verlieren.
    const { el, onSubmit } = await mountDialog();
    cwdInput(el).value = "repo/unterordner";
    submit(el);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(el.querySelector("[role=alert]")?.textContent ?? "").not.toBe("");
  });

  it("lehnt eine Tilde ab", async () => {
    // `~` wird nirgends aufgeloest: die Argumente werden base64
    // transportiert (Spec §8.2), eine Tilde kaeme WOERTLICH auf der VM an
    // und `build_in_dir` wuerde ohnehin auf dem fehlenden `/` scheitern.
    // KEINE eigene Tilde-Regel in der Implementierung -- die Ablehnung
    // FOLGT aus `startsWith("/")` (kein String beginnt mit beidem), siehe
    // `isAcceptableRemotePath` in `session-dialog.ts` samt Gegenprobe.
    const { el, onSubmit } = await mountDialog();
    cwdInput(el).value = "~/repo";
    submit(el);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ruft onCancel beim Abbrechen-Knopf, ohne das Formular abzusenden", async () => {
    // Auf `.session-dialog-actions` eingeschraenkt: seit Task 4 ist die
    // ERSTE `type="button"`-Schaltflaeche im Teilbaum eine Baumzeile, nicht
    // mehr "Cancel".
    const { el, onSubmit, onCancel } = await mountDialog();
    const cancelButton = Array.from(
      el.querySelectorAll<HTMLButtonElement>(".session-dialog-actions button"),
    ).find((b) => b.type === "button") as HTMLButtonElement;
    cancelButton.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("entsorgt den Baum mit dem Dialog", async () => {
    // `dispose()` des Baums haelt die noch offenen SSH-Runden auf (siehe
    // dessen Doc-Kommentar). Der LEERE Startpfad ist der laengste Weg
    // dorthin: beim Mounten steht nur `list_directories("")` an, und erst
    // aus dessen Antwort entsteht die ganze Ahnenkette. Mit "/tmp" waeren
    // beide Anfragen schon vor dem Entsorgen abgesetzt -- der Fall haette
    // keine Zaehne.
    //
    // In `main.ts` fuehren ALLE Wege aus dem Dialog (Abbrechen, Escape, das
    // Kreuz in der Kopfzeile, erfolgreiches Absenden) durch `closeDialog()`
    // und damit durch genau dieses `dispose()`.
    const { handle, calls } = openDialog({ initialCwd: "" });
    handle.dispose();
    const before = calls.length;

    await flush();

    expect(calls.slice(before)).toEqual([]);
  });
});

function host(overrides: Partial<Host> = {}): Host {
  return {
    id: "h1",
    runtimeId: "r-h1",
    label: "alt",
    hostname: "10.0.0.1",
    user: "u",
    port: 22,
    keyPath: null,
    authKind: "agent",
    state: "connected",
    error: null,
    sessions: [],
    expanded: true,
    lastCwd: "/tmp",
    ...overrides,
  };
}

describe("editHost", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  // Paket 2.5: hier standen drei Tests, die `["disconnect_host",
  // "remove_host", "add_host"]` verlangten. Sie prueften nur die
  // BEFEHLSNAMEN und blieben deshalb gruen, obwohl der Aufruf seit der
  // Identitaetsumkehr garantiert wirkungslos war: er nahm `host.id`, und das
  // ist jetzt immer die `settings.toml`-ID, unter der das Backend keine
  // Verbindung kennt. `main.ts` ruderte mit einer Kopie (`state:
  // "disconnected"`) ausdruecklich an dem Zweig vorbei.
  //
  // Getrennt wird jetzt beim Aufrufer, wo die Laufzeit-ID lebt (`main.ts::
  // submitEdit` ueber `onDisconnectHost`, mit eigenem Test dort). Diese
  // Funktion trennt gar nicht mehr -- und DAS ist die Zusicherung, die hier
  // haelt, ueber jeden Zustand hinweg.
  it("trennt selbst NICHT, in keinem Hostzustand", async () => {
    for (const state of ["connected", "connecting", "disconnected", "failed"] as const) {
      const rufe: string[] = [];
      invokeMock.mockReset();
      invokeMock.mockImplementation((cmd: string) => {
        rufe.push(cmd);
        return Promise.resolve();
      });
      await editHost(host({ state }), {
        label: "neu",
        hostname: "10.0.0.2",
        user: "m",
        port: 22,
        auth: { kind: "agent" },
      });
      expect(rufe).toEqual(["update_host"]);
    }
  });

  it("updates the existing ID once and returns the saved entry without secrets", async () => {
    const saved = { id: "h1", hostname: "10.0.0.2" };
    invokeMock.mockResolvedValue(saved);
    const result = await editHost(host({ id: "h1", state: "disconnected" }), {
      label: "neu",
      hostname: "10.0.0.2",
      user: "m",
      port: 2222,
      auth: { kind: "key", path: "C:\\Users\\U\\.ssh\\id_ed25519", passphrase: "x" },
    });
    expect(result).toBe(saved);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("update_host", {
      id: "h1",
      entry: {
        label: "neu",
        hostname: "10.0.0.2",
        user: "m",
        port: 2222,
        tmux_socket: null,
        history_limit: null,
        key_path: "C:\\Users\\U\\.ssh\\id_ed25519",
        auth_kind: "key",
      },
    });
  });

  it("reicht tmux_socket/history_limit vom gespeicherten Host durch, statt sie zurueckzusetzen", async () => {
    // Review-Nachtrag: ein per Hand in `settings.toml` gesetzter Wert ging
    // vorher beim ersten "Edit" stillschweigend auf die Vorgabe verloren
    // (Durchreichen statt Zuruecksetzen).
    invokeMock.mockResolvedValue(undefined);
    await editHost(
      host({ id: "h1", state: "disconnected", tmuxSocket: "custom-sock", historyLimit: 5000 }),
      {
        label: "neu",
        hostname: "10.0.0.2",
        user: "m",
        port: 22,
        auth: { kind: "agent" },
      },
    );
    expect(invokeMock).toHaveBeenCalledWith("update_host", {
      id: "h1",
      entry: {
        label: "neu",
        hostname: "10.0.0.2",
        user: "m",
        port: 22,
        tmux_socket: "custom-sock",
        history_limit: 5000,
        key_path: null,
        auth_kind: "agent",
      },
    });
  });
});

// UX-Spec §7.7 (Aufgabe 18): nur Hostname, Benutzer, Port, Anmeldeart und
// Schluesselpfad betreffen die Verbindung -- der Name nicht.
describe("changesConnection", () => {
  const saved = host({ hostname: "10.0.0.1", user: "u", port: 22, authKind: "key", keyPath: "C:/keys/a" });
  const same = {
    label: "alt",
    hostname: "10.0.0.1",
    user: "u",
    port: 22,
    auth: { kind: "key", path: "C:/keys/a", passphrase: "" },
  } as const;

  it("nein, wenn sich nur der Name aendert -- auch nicht durch eine eingetippte Passphrase", () => {
    expect(changesConnection(saved, { ...same, label: "Build VM" })).toBe(false);
    expect(changesConnection(saved, { ...same, auth: { kind: "key", path: "C:/keys/a", passphrase: "geheim" } })).toBe(false);
  });

  it("ja bei Hostname, Benutzer, Port, Anmeldeart oder Schluesselpfad", () => {
    expect(changesConnection(saved, { ...same, hostname: "10.0.0.2" })).toBe(true);
    expect(changesConnection(saved, { ...same, user: "root" })).toBe(true);
    expect(changesConnection(saved, { ...same, port: 2222 })).toBe(true);
    expect(changesConnection(saved, { ...same, auth: { kind: "agent" } })).toBe(true);
    expect(changesConnection(saved, { ...same, auth: { kind: "key", path: "C:/keys/b", passphrase: "" } })).toBe(true);
  });
});

// Fix-Runde 1 (Aufgabe 18): ein im Bearbeiten-Formular
// getipptes Passwort oder eine Passphrase traegt genau den einen Aufbau nach
// "Save"; ein leeres Feld ist keins.
describe("reconnectSecret", () => {
  const base = { label: "alt", hostname: "10.0.0.1", user: "u", port: 22 };

  it("nimmt ein getipptes Passwort oder eine getippte Passphrase", () => {
    expect(reconnectSecret({ ...base, auth: { kind: "password", password: "pw" } })).toEqual({ password: "pw" });
    expect(reconnectSecret({ ...base, auth: { kind: "key", path: "C:/keys/a", passphrase: "pp" } })).toEqual({
      passphrase: "pp",
    });
  });

  it("liefert nichts fuer leere Felder und fuer ssh-agent", () => {
    expect(reconnectSecret({ ...base, auth: { kind: "password", password: "" } })).toBeUndefined();
    expect(reconnectSecret({ ...base, auth: { kind: "key", path: "C:/keys/a", passphrase: "" } })).toBeUndefined();
    expect(reconnectSecret({ ...base, auth: { kind: "agent" } })).toBeUndefined();
  });
});

// --- Startwert Heimatverzeichnis --------------------------------------
//
// `main.ts` gibt neuen Hosts einen LEEREN `lastCwd` mit. Leer heisst fuer
// Baum und Fernskript "Heimatverzeichnis" -- aber das Textfeld weiss davon
// nichts, und die Absendepruefung verlangt einen Pfad mit fuehrendem `/`.
// Ohne die Meldung des aufgeloesten Pfades stuende der Baum also richtig,
// waehrend "Anlegen" blockiert bliebe.
describe("mountSessionDialog: leerer Startpfad", () => {
  it("traegt das aufgeloeste Heimatverzeichnis ins Feld", async () => {
    const { el } = await mountDialog({ initialCwd: "" });
    expect(cwdInput(el).value).toBe(HOME);
  });

  it("laesst danach absenden, ohne dass der Nutzer etwas tippen muss", async () => {
    const { el, onSubmit } = await mountDialog({ initialCwd: "" });
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith(HOME, null);
  });

  it("ueberschreibt eine Eingabe nicht, die vor der Aufloesung kam", async () => {
    // Der Baum braucht zwei SSH-Runden, bis er das Heimatverzeichnis kennt.
    // Wer in dieser Zeit selbst tippt, hat entschieden -- eine nachtraeglich
    // eintreffende Aufloesung darf das nicht wegwischen.
    const { el } = openDialog({ initialCwd: "" });
    const input = cwdInput(el);
    // MUSS ein anderer Pfad als `HOME` sein, sonst unterscheidet die
    // Zusicherung nichts: die erste Fassung tippte hier `/srv/projekt` --
    // exakt den Wert, den der Baum gleich meldet -- und bestand deshalb auch
    // ohne die Wache. Gefunden von der Gegenprobe, die nicht rot wurde.
    input.value = "/home/u/repo";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(input.value).toBe("/home/u/repo");
    expect(input.value).not.toBe(HOME);
  });

  it("meldet nichts, wenn ein Pfad vorgegeben war", async () => {
    // Der Feldwert IST dann schon der Startpfad -- eine Meldung darueber
    // waere bestenfalls wirkungslos und schlimmstenfalls ein zweiter
    // Schreiber auf demselben Feld.
    const { el } = await mountDialog({ initialCwd: "/home/u" });
    expect(cwdInput(el).value).toBe("/home/u");
  });
});

// --- Aufgabe 17 (UX-Spec §7.6): Namensvorschlag, Liste "Recent", Fokus ---

function nameField(el: HTMLElement): HTMLInputElement {
  return el.querySelector("input[name=sessionName]") as HTMLInputElement;
}

/** Tippt einen Pfad ins Feld: jede Eingabe loest ein `input` aus. */
function typePath(el: HTMLElement, value: string): void {
  cwdInput(el).value = value;
  cwdInput(el).dispatchEvent(new Event("input", { bubbles: true }));
}

describe("suggestSessionName", () => {
  it("nimmt den Ordnernamen und macht Zeichen ausserhalb der Regel zu '-'", () => {
    expect(suggestSessionName("/home/u/Projekt/agent bridge.v2", new Set())).toBe("agent bridge-v2");
    expect(suggestSessionName("/srv/my_app", new Set())).toBe("my_app");
  });

  it("haengt -2, -3 an, wenn es den Namen auf dem Host schon gibt", () => {
    expect(suggestSessionName("/home/u/Projekt/agent bridge.v2", new Set(["agent bridge-v2"]))).toBe(
      "agent bridge-v2-2",
    );
    expect(suggestSessionName("/srv/app", new Set(["app", "app-2"]))).toBe("app-3");
  });

  it("liefert nichts fuer die Wurzel und fuer einen Ordner ohne ein erlaubtes Zeichen", () => {
    expect(suggestSessionName("/", new Set())).toBe("");
    expect(suggestSessionName("", new Set())).toBe("");
    expect(suggestSessionName("/srv/...", new Set())).toBe("");
  });

  it("fasst Wiederholungen zusammen und nimmt Rand-'-' und Leerzeichen weg", () => {
    expect(suggestSessionName("/srv/--my..app--", new Set())).toBe("my-app");
    expect(suggestSessionName("/srv/ (draft) ", new Set())).toBe("draft");
    // Ein Schraegstrich am Ende gehoert nicht zum Ordnernamen.
    expect(suggestSessionName("/home/u/repo/", new Set())).toBe("repo");
  });

  it("haelt die Laengengrenze von 40 Zeichen ein, das Suffix eingeschlossen", () => {
    const long = "a".repeat(50);
    expect(suggestSessionName(`/srv/${long}`, new Set())).toBe("a".repeat(40));
    expect(suggestSessionName(`/srv/${long}`, new Set(["a".repeat(40)]))).toBe(`${"a".repeat(38)}-2`);
    // Endet der gekuerzte Name auf einem Leerzeichen oder '-', faellt es weg --
    // auch dann, wenn erst das Suffix den Schnitt dorthin legt.
    expect(suggestSessionName(`/srv/${"x".repeat(39)} yy`, new Set())).toBe("x".repeat(39));
    const taken = new Set([`${"x".repeat(37)}-yy`]);
    expect(suggestSessionName(`/srv/${"x".repeat(37)}-yy`, taken)).toBe(`${"x".repeat(37)}-2`);
  });
});

describe("mountSessionDialog: Namensvorschlag (UX-Spec §7.6)", () => {
  it("schlaegt beim Oeffnen nichts vor: das Verzeichnis hat sich noch nicht geaendert", async () => {
    const { el } = await mountDialog({ initialCwd: "/home/u/repo" });
    expect(nameField(el).value).toBe("");
  });

  it("die Wahl eines Ordners im Baum setzt den Vorschlag", async () => {
    const { el, onSubmit } = await mountDialog({ initialCwd: "/home/u" });
    selectInTree(el, "/home/u/repo");
    expect(nameField(el).value).toBe("repo");
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/home/u/repo", "repo");
  });

  it("ein stehender Vorschlag folgt dem naechsten Verzeichnis, auch einem getippten", async () => {
    const { el } = await mountDialog({ initialCwd: "/home/u" });
    selectInTree(el, "/home/u/repo");
    typePath(el, "/srv/projekt");
    expect(nameField(el).value).toBe("projekt");
    // Jede Eingabe zaehlt; der Ordnername ist das letzte Glied.
    typePath(el, "/srv/proj");
    expect(nameField(el).value).toBe("proj");
  });

  it("ueberschreibt keinen eigenen Namen", async () => {
    const { el, onSubmit } = await mountDialog({ initialCwd: "/home/u" });
    nameField(el).value = "deploy";
    selectInTree(el, "/home/u/repo");
    typePath(el, "/srv/projekt");
    expect(nameField(el).value).toBe("deploy");
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/srv/projekt", "deploy");
  });

  it("fuellt ein Feld, das der Nutzer wieder geleert hat", async () => {
    const { el } = await mountDialog({ initialCwd: "/home/u" });
    nameField(el).value = "deploy";
    selectInTree(el, "/home/u/repo");
    nameField(el).value = "";
    typePath(el, "/srv/projekt");
    expect(nameField(el).value).toBe("projekt");
  });

  it("vermeidet die Namen, die der Dialog auf dem Host kennt", async () => {
    const { el } = await mountDialog({ initialCwd: "/home/u", existingSessions: ["repo"] });
    selectInTree(el, "/home/u/repo");
    expect(nameField(el).value).toBe("repo-2");
  });

  it("leert ein Feld mit altem Vorschlag, wenn das neue Verzeichnis keinen Namen hergibt", async () => {
    const { el, onSubmit } = await mountDialog({ initialCwd: "/home/u" });
    selectInTree(el, "/home/u/repo");
    selectInTree(el, "/");
    expect(nameField(el).value).toBe("");
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/", null);
  });
});

describe("mountSessionDialog: Liste 'Recent' (UX-Spec §7.6)", () => {
  function recentRows(el: HTMLElement): HTMLButtonElement[] {
    return Array.from(el.querySelectorAll<HTMLButtonElement>(".session-dialog-recent button"));
  }

  it("zeigt hoechstens fuenf Eintraege in der gegebenen Reihenfolge, zwischen Feld und Baum", async () => {
    const { el } = await mountDialog({ recentDirs: ["/a", "/b", "/c", "/d", "/e", "/f", "/g"] });
    expect(recentRows(el).map((row) => row.textContent)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
    const list = el.querySelector(".session-dialog-recent")!;
    expect(list.textContent).toContain("Recent");
    expect(cwdInput(el).compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(el.querySelector(".dir-tree")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Im Formular: ein Klick darf nicht absenden.
    expect(recentRows(el).every((row) => row.type === "button")).toBe(true);
  });

  it("fehlt ohne letzte Verzeichnisse", async () => {
    const { el } = await mountDialog({ recentDirs: [] });
    expect(el.querySelector(".session-dialog-recent")).toBeNull();
  });

  it("ein Klick waehlt wie im Baum: Pfad, Vorschlag, und der Baum oeffnet dort", async () => {
    const { el, calls, onSubmit } = await mountDialog({
      initialCwd: "/home/u",
      recentDirs: ["/srv/projekt", "/tmp"],
    });
    cwdInput(el).value = "repo/unterordner";
    submit(el);
    expect(alertText(el)).not.toBe("");
    const before = calls.length;

    recentRows(el)[0].click();
    await flush();

    expect(cwdInput(el).value).toBe("/srv/projekt");
    expect(nameField(el).value).toBe("projekt");
    expect(alertText(el)).toBe("");
    expect(calls.slice(before).map((c) => c.path)).toEqual(["/", "/srv", "/srv/projekt"]);
    expect(el.querySelector<HTMLElement>('.dir-tree-rows [tabindex="0"]')?.dataset.path).toBe("/srv/projekt");
    submit(el);
    expect(onSubmit).toHaveBeenCalledWith("/srv/projekt", "projekt");
  });

  it("ein Klick laesst einen eigenen Namen stehen", async () => {
    const { el } = await mountDialog({ recentDirs: ["/srv/projekt"] });
    nameField(el).value = "deploy";
    recentRows(el)[0].click();
    expect(nameField(el).value).toBe("deploy");
  });
});

describe("mountSessionDialog: Fokus (UX-Spec §7.6)", () => {
  it("focusName legt den Fokus ins Namensfeld", async () => {
    const { el, handle } = await mountDialog({ initialCwd: "/home/u" });
    handle.focusName();
    expect(document.activeElement).toBe(nameField(el));
  });
});

// UX-Spec §11: ein Feldfehler markiert genau sein Feld -- `aria-invalid` und
// `aria-describedby` auf die eine Meldung des Dialogs.
describe("mountSessionDialog: Feldfehler (UX-Spec §11)", () => {
  function describedText(field: HTMLElement): string | undefined {
    const id = field.getAttribute("aria-describedby");
    return id ? (document.getElementById(id)?.textContent ?? undefined) : undefined;
  }

  it.each([
    ["ein ungueltiges Zeichen", { name: "log#H" }, "Use only letters, digits, spaces, _ and -. tmux would change other characters."],
    [
      "einen vergebenen Namen",
      { name: "deploy", existing: ["deploy"] },
      "A session named 'deploy' already exists on this host. Pick a different name, or open the existing session from the sidebar.",
    ],
  ] as const)("markiert das Namensfeld fuer %s", async (_label, args, text) => {
    const { el } = await mountDialog({ initialCwd: "/tmp", existingSessions: "existing" in args ? [...args.existing] : [] });
    nameField(el).value = args.name;
    submit(el);

    expect(nameField(el).getAttribute("aria-invalid")).toBe("true");
    expect(describedText(nameField(el))).toBe(text);
    expect(cwdInput(el).hasAttribute("aria-invalid")).toBe(false);
  });

  it("markiert das Verzeichnisfeld fuer einen relativen Pfad, und die Markierung faellt mit der naechsten Eingabe", async () => {
    const { el } = await mountDialog();
    cwdInput(el).value = "repo";
    submit(el);

    expect(cwdInput(el).getAttribute("aria-invalid")).toBe("true");
    expect(describedText(cwdInput(el))).toContain("must be an absolute path");
    expect(nameField(el).hasAttribute("aria-invalid")).toBe(false);

    cwdInput(el).value = "/srv";
    cwdInput(el).dispatchEvent(new Event("input", { bubbles: true }));

    expect(cwdInput(el).hasAttribute("aria-invalid")).toBe(false);
    expect(cwdInput(el).hasAttribute("aria-describedby")).toBe(false);
  });

  it("ein neuer Fehler nimmt die Markierung vom vorigen Feld", async () => {
    const { el } = await mountDialog();
    nameField(el).value = "log#H";
    submit(el);
    expect(nameField(el).getAttribute("aria-invalid")).toBe("true");

    nameField(el).value = "log";
    cwdInput(el).value = "repo";
    submit(el);

    expect(nameField(el).hasAttribute("aria-invalid")).toBe(false);
    expect(cwdInput(el).getAttribute("aria-invalid")).toBe("true");
  });

  // Wie beim Verzeichnisfeld: wer den Namen aendert, hat entschieden, und die
  // Ablehnung ist gegenstandslos -- nicht erst beim naechsten Absenden.
  it("eine Eingabe ins Namensfeld nimmt dessen Fehler zurueck, einen Fehler des Verzeichnisfelds nicht", async () => {
    const { el } = await mountDialog();
    nameField(el).value = "log#H";
    submit(el);
    expect(nameField(el).getAttribute("aria-invalid")).toBe("true");

    nameField(el).value = "log";
    nameField(el).dispatchEvent(new Event("input", { bubbles: true }));

    expect(nameField(el).hasAttribute("aria-invalid")).toBe(false);
    expect(nameField(el).hasAttribute("aria-describedby")).toBe(false);
    expect(alertText(el)).toBe("");

    cwdInput(el).value = "repo";
    submit(el);
    expect(cwdInput(el).getAttribute("aria-invalid")).toBe("true");
    nameField(el).value = "logs";
    nameField(el).dispatchEvent(new Event("input", { bubbles: true }));
    expect(cwdInput(el).getAttribute("aria-invalid")).toBe("true");
    expect(alertText(el)).not.toBe("");
  });
});
