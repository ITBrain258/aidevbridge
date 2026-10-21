// Gegenprobe fuer `first-run.ts` (Task 13; Umbau Shell-Task 11):
// Vorschlagsliste, Anmeldungsformular (jetzt `host-form.ts`, siehe
// dortigen Kopfkommentar), sichtbarer Preflight-Ablauf mit blockierendem
// Befund.
//
// Vollstaendig neu geschrieben fuer den Umbau: das fruehere manuelle
// Formular (feste Feldreihenfolge hostname/user/port/keyPath/passphrase/
// password) existiert nicht mehr, `host-form.ts`s Anmeldungsmenue ersetzt
// es. Abfragen ueber `input[name=...]`/`select[name=auth]`, dasselbe Muster
// wie `host-form.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { mountFirstRun, type FirstRunHandle } from "./first-run";
import type { HostEntry } from "./types";

const invokeMock = vi.mocked(invoke);

const activeHandles: FirstRunHandle[] = [];
function mount(
  onHostReady: (hostId: string, entry: HostEntry) => void = () => {},
  compact = false,
  beforeConnect?: () => Promise<void>,
  onRuntimeOwnershipChange?: (runtimeId: string, owned: boolean) => void,
): { container: HTMLElement; handle: FirstRunHandle } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = mountFirstRun(container, { onHostReady, compact, beforeConnect, onRuntimeOwnershipChange });
  activeHandles.push(handle);
  return { container, handle };
}

/** Zwei Vorschlaege, die sich in genau dem Punkt unterscheiden, an dem der
 * Umbau (Aufgabe 11) verzweigt: `JUMP` traegt einen `user` und verbindet
 * deshalb direkt, `NO_USER` traegt keinen und muss stattdessen das
 * vorbelegte Formular oeffnen (Rust verlangt `user`). */
const JUMP = { alias: "jump", hostname: "bastion.example", user: "ops", port: 2222, identity_file: null };
const NO_USER = { alias: "192.0.2.10", hostname: "192.0.2.10", user: null, port: null, identity_file: null };

function fillForm(container: HTMLElement, hostname: string, user: string, port: string) {
  (container.querySelector("input[name=hostname]") as HTMLInputElement).value = hostname;
  (container.querySelector("input[name=user]") as HTMLInputElement).value = user;
  (container.querySelector("input[name=port]") as HTMLInputElement).value = port;
}

function authSelect(container: HTMLElement): HTMLSelectElement {
  return container.querySelector("select[name=auth]") as HTMLSelectElement;
}

function chooseAuth(container: HTMLElement, value: string) {
  const select = authSelect(container);
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

/** Die Fehlerzeile der Karte (nicht die Warnung des eingebetteten Formulars,
 * die ebenfalls `role="alert"` traegt). */
function errorText(container: HTMLElement): string {
  return container.querySelector(".first-run-card > p[role=alert]")?.textContent ?? "";
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector("form");
  form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** Skript fuer `list_ssh_keys`/`suggest_hosts`/`list_hosts`/`connect_host`/
 * `run_preflight`/`add_host` -- gemeinsame Grundlage fuer alle Tests unten,
 * mit `overrides` fuer die Faelle, die von den Vorgaben abweichen muessen.
 * `list_ssh_keys` MUSS hier behandelt werden (Vorgabe: leere Liste) --
 * `host-form.ts::loadKeys` ruft es beim Mounten auf; ein unbehandelter
 * Befehl faellt sonst auf `undefined` zurueck, und `for (const key of keys)`
 * dort wuerde an einem nicht iterierbaren Wert werfen. */
function scriptedInvoke(overrides: Record<string, unknown> = {}) {
  return (command: string, args?: unknown) => {
    if (command === "list_ssh_keys") {
      return (overrides.list_ssh_keys as Promise<unknown>) ?? Promise.resolve([]);
    }
    if (command === "suggest_hosts") {
      return (overrides.suggest_hosts as Promise<unknown>) ?? Promise.resolve([]);
    }
    if (command === "list_hosts") {
      return (overrides.list_hosts as Promise<unknown>) ?? Promise.resolve([]);
    }
    if (command === "begin_connect") {
      return (overrides.begin_connect as Promise<unknown>) ?? Promise.resolve("h0");
    }
    if (command === "connect_host") {
      return (overrides.connect_host as Promise<unknown>) ?? Promise.resolve("h0");
    }
    if (command === "run_preflight") {
      return (
        (overrides.run_preflight as Promise<unknown>) ??
        Promise.resolve({
          tmux_version: "3.4",
          has_base64: true,
          socket_dir_writable: true,
          blocking_problem: null,
        })
      );
    }
    if (command === "add_host") {
      return (
        (overrides.add_host as Promise<unknown>) ??
        Promise.resolve({
          id: "host_1",
          label: "192.0.2.10",
          hostname: "192.0.2.10",
          user: "u",
          port: 22,
          tmux_socket: "agentbridge",
          history_limit: 10000,
          key_path: null,
        })
      );
    }
    void args;
    return Promise.resolve(undefined);
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  activeHandles.splice(0).forEach((handle) => handle.dispose());
  document.body.replaceChildren();
});

describe("mountFirstRun: Vorschlagsliste aus suggest_hosts", () => {
  // Aufgabe 11 (Spec 9.2): der Vorschlagsklick fuehrt nicht mehr ins
  // Formular, sondern verbindet DIREKT mit den Werten des Vorschlags -- das
  // Formular bleibt dabei zugeklappt.
  it("zeigt die vorgeschlagenen Hosts und verbindet bei Klick direkt mit deren hostname/user/port", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        suggest_hosts: Promise.resolve([
          { alias: "192.0.2.10", hostname: "192.0.2.10", user: "u", port: null, identity_file: null },
          JUMP,
        ]),
      }),
    );

    const { container } = mount();
    await flush();

    const items = Array.from(container.querySelectorAll<HTMLLIElement>("li.first-run-suggestion"));
    expect(items).toHaveLength(2);

    const jumpItem = items.find((li) => li.textContent?.includes("bastion.example"));
    jumpItem?.querySelector("button")?.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("connect_host", {
      hostId: "h0",
      spec: {
        hostname: "bastion.example",
        port: 2222,
        user: "ops",
        key_path: null,
        passphrase: null,
        password: null,
      },
    });
    // Das Formular ist nicht nur versteckt, es wurde gar nicht erst
    // gemountet -- der Vorschlag fuehrt nicht mehr durch das Formular.
    expect(container.querySelector<HTMLElement>(".first-run-host-form")?.hidden).toBe(true);
    expect(container.querySelector(".host-form-view")).toBeNull();
  });

  it("zeigt einen leeren Hinweis, wenn ~/.ssh/config keine Hosts liefert", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([]) }));

    const { container } = mount();
    await flush();

    expect(container.textContent).toContain("No hosts found in ~/.ssh/config");
  });

  // Der Schluesselpfad eines Vorschlags mit gesetzter `identity_file`
  // landet unveraendert als `key_path` in `connect_host` -- seit Aufgabe 11
  // fuehrt dieser Weg nicht mehr ueber das Anmeldungsmenue des Formulars,
  // `list_ssh_keys` wird hier also gar nicht gelesen.
  it("reicht die identity_file eines angeklickten Vorschlags direkt als key_path an connect_host", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        suggest_hosts: Promise.resolve([
          {
            alias: "vm-build-01",
            hostname: "192.0.2.10",
            user: "u",
            port: null,
            identity_file: "C:\\Users\\U\\.ssh\\id_ed25519",
          },
        ]),
        list_ssh_keys: Promise.resolve([
          { path: "C:\\Users\\U\\.ssh\\id_rsa", file_name: "id_rsa", key_type: "rsa", comment: "" },
        ]),
      }),
    );

    const { container } = mount();
    await flush();

    const button = container.querySelector(".first-run-suggested-list button") as HTMLButtonElement;
    button.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith(
      "connect_host",
      expect.objectContaining({
        spec: expect.objectContaining({ key_path: "C:\\Users\\U\\.ssh\\id_ed25519", port: 22 }),
      }),
    );
  });
});

// UX-Spec §7.7 (Aufgabe 18): das Feld "Name" gilt auch fuer das Anlegen, mit
// derselben Regel -- leer ergibt der Hostname das Label.
describe("mountFirstRun: Feld 'Name' im Anlegen-Formular (UX-Spec §7.7)", () => {
  async function addThroughForm(name: string): Promise<{ label: unknown }> {
    invokeMock.mockImplementation(scriptedInvoke());
    const { container } = mount();
    await flush();
    (container.querySelector("input[name=label]") as HTMLInputElement).value = name;
    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Continue")!.click();
    await flush(3);
    const call = invokeMock.mock.calls.find(([command]) => command === "add_host")!;
    return (call[1] as { entry: { label: unknown } }).entry;
  }

  it("speichert einen eingetragenen Namen als Label", async () => {
    expect((await addThroughForm("Build VM")).label).toBe("Build VM");
  });

  it("speichert ohne Namen den Hostnamen als Label", async () => {
    expect((await addThroughForm("")).label).toBe("192.0.2.10");
  });
});

describe("mountFirstRun: Verbinden und Preflight", () => {
  it("laesst bei bestandenem Preflight fortfahren -- add_host wird aufgerufen und onHostReady feuert mit hostId UND dem gespeicherten Eintrag", async () => {
    invokeMock.mockImplementation(scriptedInvoke());

    const onHostReady = vi.fn();
    const { container } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    expect(container.textContent).toContain("✓ base64");
    expect(container.textContent).toContain("✓ tmux (>= 3.0)");
    expect(container.textContent).toContain("✓ tmux socket directory");

    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue",
    ) as HTMLButtonElement;
    expect(continueButton.hidden).toBe(false);

    continueButton.click();
    await flush(3);

    expect(invokeMock).toHaveBeenCalledWith(
      "add_host",
      expect.objectContaining({
        entry: expect.objectContaining({ hostname: "192.0.2.10", user: "u", port: 22 }),
      }),
    );
    expect(onHostReady).toHaveBeenCalledWith(
      "h0",
      expect.objectContaining({ id: "host_1", hostname: "192.0.2.10" }),
      // ssh-agent: die Verbindung brauchte kein Geheimnis (UX-Spec §5.4).
      false,
    );
  });

  it("speichert den Schluesselpfad beim Speichern des Hosts, wenn ein Schluessel gewaehlt wurde", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        list_ssh_keys: Promise.resolve([
          { path: "~/.ssh/id_ed25519", file_name: "id_ed25519", key_type: "ed25519", comment: "" },
        ]),
      }),
    );

    const { container } = mount();
    await flush();

    // Vorauswahl trifft bereits den einzigen gefundenen Schluessel (siehe
    // `host-form.ts::applyPreselection`) -- kein zusaetzlicher `chooseAuth`-
    // Aufruf noetig.
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue",
    ) as HTMLButtonElement;
    continueButton.click();
    await flush(3);

    expect(invokeMock).toHaveBeenCalledWith(
      "add_host",
      expect.objectContaining({
        entry: expect.objectContaining({ key_path: "~/.ssh/id_ed25519" }),
      }),
    );
  });

  /// Gegenprobe zum Test oben: ssh-agent gewaehlt darf nicht stillschweigend
  /// zu einem GERATENEN Pfad werden -- `null`, nicht ein leerer String.
  it("speichert key_path als null, wenn ssh-agent gewaehlt wurde", async () => {
    invokeMock.mockImplementation(scriptedInvoke());

    const { container } = mount();
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue",
    ) as HTMLButtonElement;
    continueButton.click();
    await flush(3);

    expect(invokeMock).toHaveBeenCalledWith(
      "add_host",
      expect.objectContaining({ entry: expect.objectContaining({ key_path: null }) }),
    );
  });

  it("laesst bei blockierendem Preflight-Befund NICHT fortfahren", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        run_preflight: Promise.resolve({
          tmux_version: null,
          has_base64: true,
          socket_dir_writable: true,
          blocking_problem: "tmux is not installed on this host (need >= 3.0)",
        }),
      }),
    );

    const onHostReady = vi.fn();
    const { container } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    expect(container.textContent).toContain(
      "Cannot continue: tmux is not installed on this host (need >= 3.0)",
    );
    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue",
    ) as HTMLButtonElement;
    expect(continueButton.hidden).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("add_host", expect.anything());
    expect(onHostReady).not.toHaveBeenCalled();
  });

  it("zeigt eine Fehlermeldung, wenn connect_host fehlschlaegt, und ruft weder run_preflight noch onHostReady auf", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({ connect_host: Promise.reject("connection refused") }),
    );

    const onHostReady = vi.fn();
    const { container } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    // UX-Spec §10: ein Fehler ohne eigenen Code (wie `other`) nennt den Host
    // und haengt die Meldung des Backends an.
    expect(errorText(container)).toBe("Couldn't connect to 192.0.2.10: connection refused");
    expect(invokeMock.mock.calls.some(([command]) => command === "run_preflight")).toBe(false);
    expect(onHostReady).not.toHaveBeenCalled();
  });

  // --- Nachtrag A, Review Important 2: der Absenden-Knopf blieb waehrend
  // eines laufenden connect_host aktiv (Formular wird erst NACH dessen
  // Aufloesung versteckt) -- ein gewoehnlicher Doppelklick (oder ein
  // zweites Enter) startete einen zweiten, ueberlappenden connect_host-
  // Aufruf. Loest der AELTERE der beiden spaeter auf als der juengere,
  // ueberschreibt er `connectedHostId` kommentarlos -- derselbe Lecktyp wie
  // der dispose()-waehrend-in-flight-Fall oben, nur ueber einen anderen
  // Ausloeser erreicht.
  it("startet bei zwei unmittelbar aufeinanderfolgenden Absendungen nur EINEN connect_host-Aufruf", async () => {
    invokeMock.mockImplementation(scriptedInvoke());

    const { container } = mount();
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    // Zwei Absendungen ohne jeden `await` dazwischen -- genau der
    // Doppelklick-Fall: die zweite trifft `host-form.ts`s eigenen
    // `submitButton.disabled`-Waechter, weil `connect()` den Knopf
    // SYNCHRON sperrt, bevor die erste Absendung ueberhaupt zu ihrem
    // ersten `await` kommt.
    submitForm(container);
    submitForm(container);
    await flush(6);

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "connect_host"),
    ).toHaveLength(1);
  });

  // Nachtrag C (Befund 4): die verbleibende Luecke desselben Waechters.
  // `mountForm` hat ZWEI Aufrufer -- den Erstmount ohne Vorschlaege und den
  // Umschalter "Add a host manually" (vor Aufgabe 11: den Klick auf einen
  // Vorschlag). Der zweite ist mitten in einem laufenden `connect_host`
  // erreichbar und ersetzte das gesperrte Formular durch ein frisches mit
  // FREIGEGEBENEM Knopf: der Mount war eben doch keine Versuchsgrenze.
  // Aufgabe 11 legt zwei weitere Schichten darueber, die dieser Test
  // gleich mitprueft: die Sperre ALLER Connect-Knoepfe und `connectInFlight`
  // im Knopf-Handler selbst.
  it("laesst einen Vorschlagsklick MITTEN in einem laufenden connect_host keinen zweiten Versuch oeffnen", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        suggest_hosts: Promise.resolve([
          JUMP,
          // Traegt einen `user`, wuerde also tatsaechlich verbinden -- ein
          // Vorschlag ohne `user` oeffnete nur das Formular, und der Test
          // waere aus dem falschen Grund gruen.
          { alias: "vm-build-01", hostname: "192.0.2.10", user: "u", port: 22, identity_file: null },
        ]),
        // Loest NIE auf: haelt das Fenster offen, in dem der zweite
        // Vorschlag angeklickt wird. Genau dieses Fenster ist der Befund.
        connect_host: new Promise<string>(() => {}),
      }),
    );

    const { container } = mount();
    await flush();

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("li.first-run-suggestion button"),
    );
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    await flush();
    expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(1);

    // Erste Schicht: ALLE Connect-Knoepfe sind fuer die Dauer des Versuchs
    // gesperrt -- `click()` auf einem gesperrten Bedienelement loest in
    // jsdom (wie im Browser) gar kein Ereignis aus.
    expect(buttons.every((b) => b.disabled)).toBe(true);
    buttons[1].click();
    await flush();
    expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(1);

    // Zweite Schicht: ein Ereignis, das die Sperre umgeht (direkt
    // dispatcht), trifft `connectInFlight` -- der Waechter lebt ausserhalb
    // des DOM und ueberlebt jede Neuzeichnung.
    buttons[1].dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(1);

    // Dritte Schicht (Nachtrag C, Befund 4): das Formular wird MITTEN im
    // laufenden Versuch frisch gemountet (Umschalter) und brachte frueher
    // einen FREIGEGEBENEN Absenden-Knopf mit -- der Mount ist eben keine
    // Versuchsgrenze.
    container.querySelector<HTMLButtonElement>(".first-run-manual-toggle")!.click();
    await flush();
    const submitButton = container.querySelector<HTMLButtonElement>(
      ".first-run-host-form button[type=submit]",
    )!;
    expect(submitButton.disabled).toBe(true);

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    expect(invokeMock.mock.calls.filter(([command]) => command === "connect_host")).toHaveLength(1);
  });

  it("gibt den Absenden-Knopf nach einem fehlgeschlagenen connect_host wieder frei -- das Formular ist nach einem Tippfehler nicht tot", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({ connect_host: Promise.reject("connection refused") }),
    );

    const { container } = mount();
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Connect",
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
  });
});

describe("mountFirstRun: Passwort und Passphrase ueber das Anmeldungsmenue", () => {
  it("sendet die Passphrase an connect_host, wenn ein Schluessel gewaehlt ist", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        list_ssh_keys: Promise.resolve([
          { path: "~/.ssh/id_ed25519", file_name: "id_ed25519", key_type: "ed25519", comment: "" },
        ]),
      }),
    );

    const { container } = mount();
    await flush();

    fillForm(container, "192.0.2.10", "u", "22");
    (container.querySelector("input[name=passphrase]") as HTMLInputElement).value = "hunter2";
    submitForm(container);
    await flush(6);

    expect(invokeMock).toHaveBeenCalledWith(
      "connect_host",
      expect.objectContaining({
        spec: expect.objectContaining({ key_path: "~/.ssh/id_ed25519", passphrase: "hunter2" }),
      }),
    );
  });

  // UX-Spec §5.4: neu verbunden wird nach einem Transportverlust nur ein Host,
  // dessen letzte Verbindung kein Geheimnis brauchte. Fuer einen frisch
  // angelegten Host weiss das nur diese Ansicht.
  it.each([
    ["hunter2", true],
    ["", false],
  ])("sagt onHostReady, ob die Verbindung ein Geheimnis brauchte (Passphrase %j)", async (passphrase, usedSecret) => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        list_ssh_keys: Promise.resolve([
          { path: "~/.ssh/id_ed25519", file_name: "id_ed25519", key_type: "ed25519", comment: "" },
        ]),
      }),
    );
    const onHostReady = vi.fn();
    const { container } = mount(onHostReady);
    await flush();

    fillForm(container, "192.0.2.10", "u", "22");
    (container.querySelector("input[name=passphrase]") as HTMLInputElement).value = passphrase;
    submitForm(container);
    await flush(6);
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Continue")!.click();
    await flush(3);

    expect(onHostReady).toHaveBeenCalledWith("h0", expect.objectContaining({ id: "host_1" }), usedSecret);
  });

  it("sendet KEINE Passphrase und KEIN Passwort, wenn ssh-agent gewaehlt ist", async () => {
    invokeMock.mockImplementation(scriptedInvoke());

    const { container } = mount();
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    expect(invokeMock).toHaveBeenCalledWith(
      "connect_host",
      expect.objectContaining({
        spec: expect.objectContaining({ key_path: null, passphrase: null, password: null }),
      }),
    );
  });

  it("sendet das Passwort an connect_host, wenn Password gewaehlt ist", async () => {
    invokeMock.mockImplementation(scriptedInvoke());

    const { container } = mount();
    await flush();

    chooseAuth(container, "password");
    fillForm(container, "192.0.2.10", "u", "22");
    (container.querySelector("input[name=password]") as HTMLInputElement).value = "hunter2";
    submitForm(container);
    await flush(6);

    expect(invokeMock).toHaveBeenCalledWith(
      "connect_host",
      expect.objectContaining({
        spec: expect.objectContaining({ key_path: null, password: "hunter2" }),
      }),
    );
  });
});

describe("mountFirstRun: Weg zurueck aus einem blockierten Preflight (Review-Befund, Important 2)", () => {
  it("fuehrt nach einem blockierenden Befund per 'Back' zum Formular zurueck und schliesst die bereits geoeffnete Verbindung", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        run_preflight: Promise.resolve({
          tmux_version: null,
          has_base64: true,
          socket_dir_writable: true,
          blocking_problem: "tmux is not installed on this host (need >= 3.0)",
        }),
      }),
    );

    const onHostReady = vi.fn();
    const { container } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    const hostFormContainer = container.querySelector(".first-run-host-form") as HTMLElement;
    const preflightSection = container.querySelector("section") as HTMLElement;
    expect(hostFormContainer.hidden).toBe(true);
    expect(preflightSection.hidden).toBe(false);

    const backButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Back",
    ) as HTMLButtonElement;
    expect(backButton).toBeDefined();
    backButton.click();
    await flush(3);

    expect(hostFormContainer.hidden).toBe(false);
    expect(preflightSection.hidden).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "h0" });
    expect(onHostReady).not.toHaveBeenCalled();
  });

  it("bietet auch nach einem Preflight-Fehlschlag (run_preflight wirft) denselben Weg zurueck", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({ run_preflight: Promise.reject("preflight probe crashed") }),
    );

    const onHostReady = vi.fn();
    const { container } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    const hostFormContainer = container.querySelector(".first-run-host-form") as HTMLElement;
    const preflightSection = container.querySelector("section") as HTMLElement;
    expect(hostFormContainer.hidden).toBe(true);
    expect(preflightSection.hidden).toBe(false);
    expect(container.textContent).toContain("preflight probe crashed");

    const backButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Back",
    ) as HTMLButtonElement;
    expect(backButton).toBeDefined();
    backButton.click();
    await flush(3);

    expect(hostFormContainer.hidden).toBe(false);
    expect(preflightSection.hidden).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "h0" });
    expect(onHostReady).not.toHaveBeenCalled();
  });

  // B9 (Aufgabe 17): `goBack()` hielt Ueberschrift und Liste bisher an
  // `lastSuggestions.length > 0` fest -- ohne Vorschlaege blieben beide nach
  // "Back" versteckt, obwohl die "No hosts found"-Zeile beim Mounten sichtbar
  // war. Nur der Umschalter (`manualToggle`) bleibt an Vorschlaege gebunden.
  it("'Back' ohne Vorschlaege zeigt Ueberschrift und Liste (mit der 'No hosts found'-Zeile) wieder", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        run_preflight: Promise.resolve({
          tmux_version: null,
          has_base64: true,
          socket_dir_writable: true,
          blocking_problem: "tmux is not installed on this host (need >= 3.0)",
        }),
      }),
    );

    const { container } = mount();
    await flush();

    const suggestedList = container.querySelector(".first-run-suggested-list") as HTMLElement;
    expect(suggestedList.hidden).toBe(false);
    expect(suggestedList.textContent).toContain("No hosts found");

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    expect(suggestedList.hidden).toBe(true);

    const backButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Back",
    ) as HTMLButtonElement;
    expect(backButton).toBeDefined();
    backButton.click();
    await flush(3);

    expect(suggestedList.hidden).toBe(false);
    expect(suggestedList.textContent).toContain("No hosts found");
  });

  // --- Abschlussreview (Critical): `dispose()` liess die per `connect_host`
  // geoeffnete Verbindung offen. Nur der Zurueck-Knopf raeumte auf; die
  // beiden SPAETER ergaenzten Fluchtwege aus der Ueberlagerung (Schliessen-
  // Schaltflaeche, dokumentweites Escape) laufen ausschliesslich ueber
  // `main.ts`s `closeDialog()` -> `FirstRunHandle.dispose()`.

  it("schliesst die offene Verbindung auch, wenn die Ansicht ohne 'Back' entsorgt wird", async () => {
    invokeMock.mockImplementation(scriptedInvoke());

    const onHostReady = vi.fn();
    const { container, handle } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    // Vorbedingung ausdruecklich gepruefte: es GIBT hier eine offene
    // Verbindung, sonst pruefte die Zusicherung unten nichts.
    expect(invokeMock).toHaveBeenCalledWith("connect_host", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", expect.anything());

    // Genau das, was Escape/Schliessen in `main.ts` ausloesen.
    handle.dispose();
    await flush(3);

    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "h0" });
    expect(onHostReady).not.toHaveBeenCalled();
  });

  it("trennt einen bereits uebergebenen Host NICHT, wenn der Aufrufer aus onHostReady heraus entsorgt", async () => {
    invokeMock.mockImplementation(scriptedInvoke());

    // Stellt BEIDE Entsorgungswege aus `main.ts` nach: sowohl
    // `closeDialog()` (Ueberlagerung "Add host") als auch
    // `ensureGridMounted()` (Erststart im Rasterbereich) entsorgen diese
    // Ansicht SYNCHRON aus `handleHostReady` heraus. Ohne die
    // Besitzuebergabe in `finishAndPersist` wuerde `dispose()` dabei genau
    // die Verbindung schliessen, die der Aufrufer gerade uebernommen hat --
    // der Host stuende in der Seitenleiste als "connected", waehrend seine
    // russh-Sitzung schon tot waere.
    let mounted: FirstRunHandle | null = null;
    const onHostReady = vi.fn(() => {
      mounted?.dispose();
    });
    const { container, handle } = mount(onHostReady);
    mounted = handle;
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue",
    ) as HTMLButtonElement;
    continueButton.click();
    await flush(3);

    expect(onHostReady).toHaveBeenCalledWith("h0", expect.objectContaining({ id: "host_1" }), false);
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", expect.anything());
  });

  // --- Nachtrag A (zweites Fenster desselben Lecks): die obige Behebung
  // (Abschlussreview, Critical) deckt `dispose()`, NACHDEM `connect_host`
  // bereits aufgeloest hat -- `connectedHostId` ist dann gesetzt,
  // `releaseConnection()` greift. Loest `connect_host` dagegen ERST NACH
  // `dispose()` auf, greift `releaseConnection()` ins Leere (`connectedHostId`
  // ist zu diesem Zeitpunkt noch `null`), und der bereits vorhandene
  // `if (disposed) return;` direkt danach verwirft den frisch zurueckgelie-
  // ferten `hostId` kommentarlos -- die Verbindung existiert auf der
  // Rust-Seite, ist aber ab hier von der Oberflaeche aus nirgends mehr
  // erreichbar. Ausloesen laesst sich das genau so:
  // "Add host" oeffnen, Connect druecken, Escape druecken, bevor
  // `connect_host` aufloest.
  it("schliesst eine Verbindung, die ERST NACH dispose() aufloest -- kein Waechter griff bislang in genau diesem Fenster", async () => {
    // `scriptedInvoke`s Vorgabe fuer `connect_host` loest sofort auf --
    // dieser Test braucht stattdessen ein Versprechen, das er selbst in der
    // Hand haelt, um es NACH `dispose()` aufzuloesen.
    let resolveConnect!: (id: string) => void;
    const pendingConnect = new Promise<string>((resolve) => {
      resolveConnect = resolve;
    });
    invokeMock.mockImplementation(scriptedInvoke({ connect_host: pendingConnect }));

    const onHostReady = vi.fn();
    const { container, handle } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    // Vorbedingung, ausdruecklich geprueft: `connect_host` haengt tatsaechlich
    // noch (kein `disconnect_host` bislang) -- sonst pruefte die Zusicherung
    // unten nichts.
    expect(invokeMock).toHaveBeenCalledWith("connect_host", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("disconnect_host", expect.anything());

    // Genau das, was Escape in main.ts waehrend eines haengenden connect_host
    // ausloest.
    handle.dispose();
    await flush(3);
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "h0" });

    // `connect_host` loest ERST JETZT auf -- nach `dispose()`.
    resolveConnect("h0");
    await flush(6);

    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "h0" });
    expect(onHostReady).not.toHaveBeenCalled();
    // `run_preflight` darf fuer eine bereits entsorgte Ansicht nie folgen --
    // sonst liefe ein weiterer Aufruf gegen eine nicht mehr existierende
    // Verbindung ins Leere.
    expect(invokeMock.mock.calls.some(([command]) => command === "run_preflight")).toBe(false);
  });

  it("gibt die Verbindung bei dispose() frei, wenn add_host fehlschlaegt -- der Besitz bleibt bis dahin hier", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({ add_host: Promise.reject("settings.toml read-only") }),
    );

    const onHostReady = vi.fn();
    const { container, handle } = mount(onHostReady);
    await flush();

    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(6);

    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue",
    ) as HTMLButtonElement;
    continueButton.click();
    await flush(3);

    expect(onHostReady).not.toHaveBeenCalled();
    handle.dispose();
    await flush(3);

    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "h0" });
  });
});

// --- Aufgabe 11 (UI v2): der Erststart ist ein Willkommen mit Markenblock,
// einer Karte aus Vorschlagszeilen (je EIN Connect-Knopf), zugeklapptem
// Formular und einer Fusszeile mit den Anforderungen; im "Add host"-Dialog
// faellt alles weg, was der Dialogkopf schon traegt (`compact`).
describe("Erststart: Versuch, Preflight und Speicherbesitz", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  const ok = { tmux_version: "3.4", has_base64: true, socket_dir_writable: true, blocking_problem: null };
  const blocked = { ...ok, blocking_problem: "tmux missing on B" };
  const saved: HostEntry = {
    id: "saved_A", label: "A", hostname: "a.example", user: "ops", port: 22,
    tmux_socket: "agentbridge", history_limit: 10000, key_path: null, auth_kind: "agent",
  };
  function actions(container: HTMLElement) {
    return {
      back: container.querySelector<HTMLButtonElement>(".first-run-preflight-actions .btn--secondary")!,
      next: container.querySelector<HTMLButtonElement>(".first-run-preflight-actions .btn--primary")!,
    };
  }
  async function start(container: HTMLElement, hostname: string) {
    chooseAuth(container, "agent");
    fillForm(container, hostname, "ops", "22");
    submitForm(container);
    await flush();
  }

  it("verlangt nach Back fuer B einen neuen erfolgreichen Preflight, auch wenn A bestanden hatte", async () => {
    const preflightB = deferred<typeof ok>();
    let connects = 0;
    const script = scriptedInvoke();
    invokeMock.mockImplementation((command, args) => {
      if (command === "begin_connect") return Promise.resolve(connects === 0 ? "runtime_A" : "runtime_B");
      if (command === "connect_host") return Promise.resolve(++connects === 1 ? "runtime_A" : "runtime_B");
      if (command === "run_preflight") return connects === 1 ? Promise.resolve(ok) : preflightB.promise;
      return script(command, args);
    });
    const ready = vi.fn();
    const { container } = mount(ready);
    await flush();
    await start(container, "a.example");
    const { back, next } = actions(container);
    expect(next.hidden).toBe(false);
    back.click();
    await start(container, "b.example");
    expect(next.hidden).toBe(true);
    // Der Handler muss dieselbe Invariante wahren wie die Anzeige.
    next.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "add_host")).toHaveLength(0);
    preflightB.reject("B preflight failed");
    await flush();
    expect(next.hidden).toBe(true);
    expect(container.textContent).toContain("B preflight failed");
    expect(ready).not.toHaveBeenCalled();
  });

  it.each(["success", "error"])("ignoriert einen alten Preflight-%s nach Back und blockiertem B", async (outcome) => {
    const preflightA = deferred<typeof ok>();
    let connects = 0;
    const script = scriptedInvoke();
    invokeMock.mockImplementation((command, args) => {
      if (command === "begin_connect") return Promise.resolve(connects === 0 ? "runtime_A" : "runtime_B");
      if (command === "connect_host") return Promise.resolve(++connects === 1 ? "runtime_A" : "runtime_B");
      if (command === "run_preflight") return connects === 1 ? preflightA.promise : Promise.resolve(blocked);
      return script(command, args);
    });
    const { container } = mount();
    await flush();
    await start(container, "a.example");
    const { back, next } = actions(container);
    back.click();
    await start(container, "b.example");
    const before = container.textContent;
    const focus = document.activeElement;
    if (outcome === "success") preflightA.resolve(ok);
    else preflightA.reject("old A error");
    await flush();
    expect(container.textContent).toBe(before);
    expect(next.hidden).toBe(true);
    expect(document.activeElement).toBe(focus);
    next.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "add_host")).toHaveLength(0);
  });

  it("bindet den laufenden Save an A und sperrt Back sowie doppelte Saves bis zur Uebergabe", async () => {
    const save = deferred<HostEntry>();
    invokeMock.mockImplementation(scriptedInvoke({ begin_connect: Promise.resolve("runtime_A"), connect_host: Promise.resolve("runtime_A"), add_host: save.promise }));
    const ready = vi.fn();
    const { container, handle } = mount(ready);
    await flush();
    await start(container, "a.example");
    const { back, next } = actions(container);
    next.click();
    expect(back.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    back.dispatchEvent(new MouseEvent("click"));
    next.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "disconnect_host")).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "add_host")).toHaveLength(1);
    save.resolve(saved);
    await flush();
    expect(ready).toHaveBeenCalledExactlyOnceWith("runtime_A", saved, false);
    handle.dispose();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "disconnect_host")).toHaveLength(0);
  });

  it("schliesst beim Dispose waehrend Save genau die eigene Verbindung und uebergibt spaeter nichts", async () => {
    const save = deferred<HostEntry>();
    invokeMock.mockImplementation(scriptedInvoke({ begin_connect: Promise.resolve("runtime_A"), connect_host: Promise.resolve("runtime_A"), add_host: save.promise }));
    const ready = vi.fn();
    const { container, handle } = mount(ready);
    await flush();
    await start(container, "a.example");
    actions(container).next.click();
    handle.dispose();
    save.resolve(saved);
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "disconnect_host")).toEqual([["disconnect_host", { hostId: "runtime_A" }]]);
  });

  it("gibt nach einem Speicherfehler Back und Retry frei und uebergibt beim Retry dieselbe Verbindung", async () => {
    const save = deferred<HostEntry>();
    const script = scriptedInvoke({ begin_connect: Promise.resolve("runtime_A"), connect_host: Promise.resolve("runtime_A") });
    let saves = 0;
    invokeMock.mockImplementation((command, args) => command === "add_host"
      ? ++saves === 1 ? save.promise : Promise.resolve(saved)
      : script(command, args));
    const ready = vi.fn();
    const { container } = mount(ready);
    await flush();
    await start(container, "a.example");
    const { back, next } = actions(container);
    next.click();
    save.reject("settings read-only");
    await flush();
    expect(back.disabled).toBe(false);
    expect(next.disabled).toBe(false);
    expect(container.textContent).toContain("settings read-only");
    expect(ready).not.toHaveBeenCalled();
    next.click();
    await flush();
    expect(ready).toHaveBeenCalledExactlyOnceWith("runtime_A", saved, false);
    expect(container.textContent).not.toContain("settings read-only");
  });
});

describe("UI v2 Erststart, Aufbau (Spec 9.2, 9.5, 9.6)", () => {
  it("Willkommen: Logo, Name, Satz; Karte; Anforderungszeile mit Disclosure", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([JUMP]) }));
    const { container } = mount();
    await flush();
    expect(container.querySelector(".first-run-heading")).toBeNull();
    expect(container.querySelector(".first-run-brand .first-run-logo")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".first-run-brand .first-run-name")?.textContent).toBe("aidevbridge");
    expect(container.querySelector(".first-run-brand .first-run-tagline")?.textContent).toBe(
      "Your coding agents in tmux, on your machines. Nothing gets installed on the host.",
    );
    expect(container.querySelector(".first-run-footer .first-run-requirements")?.textContent).toBe(
      "Linux host · OpenSSH · tmux 3.0+",
    );
    const disclosure = container.querySelector<HTMLButtonElement>(".first-run-disclosure")!;
    expect(disclosure.textContent).toBe("What gets checked");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    const list = container.querySelector<HTMLElement>(`#${disclosure.getAttribute("aria-controls")}`)!;
    expect(list.hidden).toBe(true);
    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);
    expect(list.querySelectorAll("li")).toHaveLength(3);
  });

  it("jeder Vorschlag ist ein <li> mit Kuerzel, Text und genau einem Connect-Knopf; Startfokus auf dem ersten", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([JUMP, NO_USER]) }));
    const { container } = mount();
    await flush();
    const items = Array.from(container.querySelectorAll<HTMLLIElement>("li.first-run-suggestion"));
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".sb-avatar")?.textContent).toBe("JU");
    expect(items[0].querySelector(".sb-avatar")?.getAttribute("aria-hidden")).toBe("true");
    expect(items[0].querySelector(".first-run-suggestion-alias")?.textContent).toBe("jump");
    expect(items[0].querySelector(".first-run-suggestion-detail")?.textContent).toBe("ops@bastion.example:2222");
    expect(items[1].querySelector(".sb-avatar")?.textContent).toBe("10");
    const buttons = items[0].querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe("Connect jump");
    expect(buttons[0].textContent).toBe("Connect");
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("mit Vorschlaegen ist das Formular zugeklappt; der Umschalter klappt es auf und fokussiert das erste Feld", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([JUMP]) }));
    const { container } = mount();
    await flush();
    const form = container.querySelector<HTMLElement>(".first-run-host-form")!;
    const toggle = container.querySelector<HTMLButtonElement>(".first-run-manual-toggle")!;
    expect(form.hidden).toBe(true);
    expect(toggle.textContent).toBe("Add a host manually");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await flush();
    expect(form.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(container.querySelector("input[name=hostname]"));
  });

  it("ohne Vorschlaege ist das Formular offen, der Umschalter fehlt, Startfokus im ersten Feld", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([]) }));
    const { container } = mount();
    await flush();
    expect(container.querySelector<HTMLElement>(".first-run-host-form")?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>(".first-run-manual-toggle")?.hidden).toBe(true);
    expect(container.querySelector(".first-run-suggested-list")?.textContent).toContain("No hosts found");
    expect(document.activeElement).toBe(container.querySelector("input[name=hostname]"));
  });

  it("Connect am Vorschlag verbindet direkt mit dessen Werten und sperrt den Knopf waehrenddessen", async () => {
    let resolveConnect: (id: string) => void = () => {};
    const pending = new Promise<string>((r) => { resolveConnect = r; });
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([JUMP]), connect_host: pending }));
    const { container } = mount();
    await flush();
    const li = container.querySelector<HTMLLIElement>("li.first-run-suggestion")!;
    const button = li.querySelector<HTMLButtonElement>("button")!;
    button.click();
    await flush();
    expect(button.disabled).toBe(true);
    expect(li.querySelector(".first-run-suggestion-detail")?.textContent).toBe("Connecting…");
    expect(invokeMock).toHaveBeenCalledWith("connect_host", {
      hostId: "h0",
      spec: { hostname: "bastion.example", port: 2222, user: "ops", key_path: null, passphrase: null, password: null },
    });
    resolveConnect("h0");
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("run_preflight", { hostId: "h0" });
  });

  it("Klick auf die Zeile (nicht den Knopf) leitet an den Knopf weiter -- genau ein connect_host", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([JUMP]) }));
    const { container } = mount();
    await flush();
    container.querySelector<HTMLElement>(".first-run-suggestion-text")!.click();
    await flush();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "connect_host")).toHaveLength(1);
  });

  it("Vorschlag ohne user oeffnet das vorbelegte Formular mit Fokus im user-Feld statt zu verbinden", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([NO_USER]) }));
    const { container } = mount();
    await flush();
    container.querySelector<HTMLButtonElement>("li.first-run-suggestion button")!.click();
    await flush();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "connect_host")).toHaveLength(0);
    expect((container.querySelector("input[name=hostname]") as HTMLInputElement).value).toBe("192.0.2.10");
    expect(document.activeElement).toBe(container.querySelector("input[name=user]"));
  });

  it("die Detailzeile nennt bei einem Schluessel-Vorschlag den Dateinamen (Spec 9.2, Ruling 4)", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({ suggest_hosts: Promise.resolve([{ ...JUMP, identity_file: "C:/Users/x/.ssh/id_ed25519" }]) }),
    );
    const { container } = mount();
    await flush();
    expect(container.querySelector(".first-run-suggestion-detail")?.textContent).toBe(
      "ops@bastion.example:2222 · id_ed25519",
    );
  });

  it("compact blendet Marke und Fusszeile aus", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ suggest_hosts: Promise.resolve([JUMP]) }));
    const { container } = mount(() => {}, true);
    await flush();
    expect(container.querySelector(".first-run-view")?.classList.contains("first-run-view--compact")).toBe(true);
    expect(container.querySelector<HTMLElement>(".first-run-brand")?.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>(".first-run-footer")?.hidden).toBe(true);
    expect(container.querySelector(".first-run-card")).not.toBeNull();
  });

  // Fix-Runde 1, Befund 1 (Important): der Vorschlagspfad ging
  // bislang direkt in `connect()`, OHNE `existingHosts` (nur `host-form.ts`
  // ueber `mountForm` sah diese Liste) -- ein bereits gespeicherter Host
  // liess sich per Vorschlag ein ZWEITES Mal verbinden, ohne je die
  // Duplikat-Warnung aus Spec 9.4 zu sehen. `bastion.example`/`ops`/`2222`
  // steckt hier ABSICHTLICH sowohl in `JUMP` als auch im gescripteten
  // `list_hosts`-Eintrag `h9` -- exakt der Fall aus dem Fehlschlagsszenario
  // des Befunds.
  it("Vorschlag eines bereits gespeicherten Hosts oeffnet das Formular mit Duplikatwarnung statt blind zu verbinden", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        suggest_hosts: Promise.resolve([JUMP]),
        list_hosts: Promise.resolve([
          {
            id: "h9",
            label: "jump",
            hostname: "bastion.example",
            user: "ops",
            port: 2222,
            tmux_socket: "agentbridge",
            history_limit: 10000,
            key_path: null,
            auth_kind: "agent",
          },
        ]),
      }),
    );
    const { container } = mount();
    await flush();

    container.querySelector<HTMLButtonElement>("li.first-run-suggestion button")!.click();
    await flush();

    expect(invokeMock.mock.calls.filter((c) => c[0] === "connect_host")).toHaveLength(0);
    expect(container.querySelector<HTMLElement>(".first-run-host-form")?.hidden).toBe(false);
    expect((container.querySelector("input[name=hostname]") as HTMLInputElement).value).toBe(
      "bastion.example",
    );
    expect((container.querySelector("input[name=user]") as HTMLInputElement).value).toBe("ops");
    expect(document.activeElement).toBe(container.querySelector("input[name=hostname]"));
    // `host-form.ts` zeigt die Duplikat-Warnung ERST beim Absenden
    // (`form.addEventListener("submit", ...)`), nicht synchron beim Mounten
    // -- ein `[role=alert]`-Text ist an dieser Stelle also noch leer. Diese
    // Zusicherung haette nichts zu pruefen und bleibt deshalb aus.
  });

  // Fix-Runde 1, Befund 3 (Minor): war bislang ungetestet -- nur der Sperr-
  // zustand WAEHREND eines laufenden Versuchs hatte einen Test, nicht die
  // Freigabe DANACH. Der `finally`-Block soll das bereits erledigen --
  // dieser Test ist die Gegenprobe dazu (Regressions-Anker).
  it("gibt nach einem fehlgeschlagenen Vorschlag-Connect die Knoepfe wieder frei und zeigt die Detailzeile erneut", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        suggest_hosts: Promise.resolve([JUMP]),
        connect_host: Promise.reject({ code: "other", message: "boom" }),
      }),
    );
    const { container } = mount();
    await flush();

    const li = container.querySelector<HTMLLIElement>("li.first-run-suggestion")!;
    const button = li.querySelector<HTMLButtonElement>("button")!;
    button.click();
    await flush();

    for (const b of container.querySelectorAll<HTMLButtonElement>("li.first-run-suggestion button")) {
      expect(b.disabled).toBe(false);
    }
    expect(li.querySelector(".first-run-suggestion-detail")?.textContent).toBe("ops@bastion.example:2222");
    expect(li.classList.contains("is-connecting")).toBe(false);
  });
});

// --- Aufgabe 12 (UI v2, Spec 9.3 bis 9.5): was NACH dem Connect passiert.
// `ConnectError.code` entscheidet zwischen einem Geheimnisfeld unter der
// angeklickten Zeile (Passphrase/Passwort, aus `credential-field.ts`) und
// einer Fehlerflaeche mit Retry und Copy diagnostics; die Pruefliste traegt
// die Ueberschrift "Checking {alias}", Zeilen mit Icon und verstecktem
// Zustandswort, und der Fokus laeuft weiter auf Continue bzw. Back.
describe("UI v2 Erststart, Anmeldezweig und Pruefliste (Spec 9.3-9.5)", () => {
  const KEYED = { ...JUMP, identity_file: "C:/Users/x/.ssh/id_ed25519" };

  /** Laesst den ERSTEN `connect_host`-Aufruf scheitern und jeden weiteren
   * gelingen -- genau der Ablauf "Fehler, Geheimnis nachreichen, Erfolg".
   * NUR EINMAL je Test bauen: der Zaehler lebt in dieser Closure. */
  function rejectOnce(code: string, message: string) {
    let calls = 0;
    return (command: string, args?: unknown) => {
      if (command === "connect_host") {
        calls++;
        return calls === 1 ? Promise.reject({ code, message }) : Promise.resolve("h0");
      }
      return scriptedInvoke()(command, args);
    };
  }

  it("password_required zeigt das Passwortfeld unter der Zeile; erneutes Connect sendet das Passwort; Continue speichert auth_kind password", async () => {
    const onHostReady = vi.fn();
    const script = rejectOnce("password_required", "auth failed"); // EINMAL bauen: der Zaehler lebt in der Closure
    invokeMock.mockImplementation((command: string, args?: unknown) =>
      command === "suggest_hosts" ? Promise.resolve([JUMP]) : script(command, args),
    );
    const { container } = mount(onHostReady);
    await flush();
    container.querySelector<HTMLButtonElement>("li.first-run-suggestion button")!.click();
    await flush();
    const followup = container.querySelector<HTMLElement>(".first-run-suggestion-followup")!;
    const input = followup.querySelector<HTMLInputElement>("input[name=password]")!;
    expect(followup.querySelector(".first-run-followup-message")?.textContent).toBe("auth failed");
    expect(document.activeElement).toBe(input);
    input.value = "pw";
    followup.querySelector<HTMLButtonElement>("button.btn--primary")!.click();
    await flush();
    const calls = invokeMock.mock.calls.filter((c) => c[0] === "connect_host");
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual({
      hostId: "h0",
      spec: { hostname: "bastion.example", port: 2222, user: "ops", key_path: null, passphrase: null, password: "pw" },
    });
    expect(container.querySelector(".first-run-preflight .first-run-section-label")?.textContent).toBe("Checking jump");
    const cont = container.querySelector<HTMLButtonElement>(".first-run-preflight-actions .btn--primary")!;
    expect(document.activeElement).toBe(cont);
    cont.click();
    await flush();
    const addCall = invokeMock.mock.calls.find((c) => c[0] === "add_host")!;
    expect((addCall[1] as { entry: { auth_kind: string; key_path: string | null } }).entry.auth_kind).toBe("password");
    expect(onHostReady).toHaveBeenCalledTimes(1);
  });

  it("passphrase_required bei einem Schluessel-Vorschlag zeigt das Passphrasenfeld; Enter sendet", async () => {
    const script = rejectOnce("passphrase_required", "locked key");
    invokeMock.mockImplementation((command: string, args?: unknown) =>
      command === "suggest_hosts" ? Promise.resolve([KEYED]) : script(command, args),
    );
    const { container } = mount();
    await flush();
    container.querySelector<HTMLButtonElement>("li.first-run-suggestion button")!.click();
    await flush();
    const input = container.querySelector<HTMLInputElement>(".first-run-suggestion-followup input[name=passphrase]")!;
    input.value = "pp";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    const calls = invokeMock.mock.calls.filter((c) => c[0] === "connect_host");
    expect(calls[1][1]).toEqual({
      hostId: "h0",
      spec: { hostname: "bastion.example", port: 2222, user: "ops", key_path: KEYED.identity_file, passphrase: "pp", password: null },
    });
  });

  it("auth_rejected ohne Schluessel oeffnet das Passwortfeld (Ruling), mit Schluessel die Fehlerflaeche", async () => {
    const script = rejectOnce("auth_rejected", "agent not reachable");
    invokeMock.mockImplementation((command: string, args?: unknown) =>
      command === "suggest_hosts" ? Promise.resolve([JUMP, KEYED]) : script(command, args),
    );
    const { container } = mount();
    await flush();
    const [plain, keyed] = Array.from(container.querySelectorAll<HTMLButtonElement>("li.first-run-suggestion > .first-run-suggestion-row > button"));
    plain.click();
    await flush();
    expect(container.querySelector(".first-run-suggestion-followup input[name=password]")).not.toBeNull();
    invokeMock.mockImplementation((command: string, args?: unknown) =>
      command === "suggest_hosts" ? Promise.resolve([]) : command === "connect_host" ? Promise.reject({ code: "auth_rejected", message: "key unreadable" }) : scriptedInvoke()(command, args),
    );
    keyed.click();
    await flush();
    const error = container.querySelectorAll<HTMLElement>(".first-run-suggestion")[1].querySelector(".first-run-suggestion-followup--error")!;
    expect(error.querySelector(".first-run-followup-message")?.textContent).toBe("key unreadable");
    expect(Array.from(error.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Retry", "Copy diagnostics"]);
  });

  it("host_unreachable zeigt die Fehlerflaeche; Retry versucht es erneut; kein run_preflight", async () => {
    invokeMock.mockImplementation((command: string, args?: unknown) =>
      command === "suggest_hosts" ? Promise.resolve([JUMP]) : command === "connect_host" ? Promise.reject({ code: "host_unreachable", message: "timeout" }) : scriptedInvoke()(command, args),
    );
    const { container } = mount();
    await flush();
    container.querySelector<HTMLButtonElement>("li.first-run-suggestion button")!.click();
    await flush();
    const retry = container.querySelector<HTMLButtonElement>(".first-run-suggestion-followup--error .btn--secondary")!;
    expect(document.activeElement).toBe(retry);
    retry.click();
    await flush();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "connect_host")).toHaveLength(2);
    expect(invokeMock.mock.calls.filter((c) => c[0] === "run_preflight")).toHaveLength(0);
    expect(container.querySelector("[role=alert]")?.textContent ?? "").toBe("");
  });

  it("Pruefzeilen: 26er-Zeile mit Icon, verstecktem Zustandswort und Text; blockierend fokussiert Back", async () => {
    invokeMock.mockImplementation(
      scriptedInvoke({
        suggest_hosts: Promise.resolve([JUMP]),
        run_preflight: Promise.resolve({ tmux_version: null, has_base64: true, socket_dir_writable: true, blocking_problem: "tmux missing" }),
      }),
    );
    const { container } = mount();
    await flush();
    container.querySelector<HTMLButtonElement>("li.first-run-suggestion button")!.click();
    await flush();
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".preflight-check"));
    expect(rows).toHaveLength(3);
    expect(rows[1].querySelector(".icon-box[data-icon='x']")).not.toBeNull();
    expect(rows[1].querySelector(".preflight-check-glyph")?.classList.contains("ab-visually-hidden")).toBe(true);
    expect(rows[1].textContent).toContain("✗ tmux (>= 3.0)");
    expect(document.activeElement).toBe(container.querySelector(".first-run-preflight-actions .btn--secondary"));
  });
});


describe("mountFirstRun: reservation ownership", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
  }
  it("announces owned runtime before connect can emit events and releases it on dispose", async () => {
    const connecting = deferred<string>();
    const ownership = vi.fn();
    const script = scriptedInvoke({ connect_host: connecting.promise });
    invokeMock.mockImplementation((command, args) => {
      if (command === "connect_host") expect(ownership.mock.calls).toEqual([["h0", true]]);
      return script(command, args);
    });
    const onReady = vi.fn();
    const { container, handle } = mount(onReady, false, undefined, ownership);
    await flush();
    chooseAuth(container, "agent");
    fillForm(container, "test-host", "test-user", "22");
    submitForm(container);
    await flush();
    expect(ownership.mock.calls).toEqual([["h0", true]]);
    handle.dispose();
    expect(ownership.mock.calls).toEqual([["h0", true], ["h0", false]]);
    connecting.resolve("h0");
    await flush();
    expect(onReady).not.toHaveBeenCalled();
    expect(ownership.mock.calls).toEqual([["h0", true], ["h0", false]]);
  });

  it("releases a reservation delivered after dispose without starting connect", async () => {
    const begin = deferred<string>();
    invokeMock.mockImplementation(scriptedInvoke({ begin_connect: begin.promise }));
    const onReady = vi.fn();
    const { container, handle } = mount(onReady);
    await flush();
    chooseAuth(container, "agent");
    fillForm(container, "test-host", "test-user", "22");
    submitForm(container);
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("begin_connect", {});
    handle.dispose();
    begin.resolve("late-reservation");
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "late-reservation" });
    expect(invokeMock).not.toHaveBeenCalledWith("connect_host", expect.anything());
    expect(onReady).not.toHaveBeenCalled();
  });

  it("releases the failed reservation before allowing a credential retry", async () => {
    invokeMock.mockImplementation(scriptedInvoke({ connect_host: Promise.reject({ code: "connect_timeout", message: "Connection timed out." }) }));
    const { container } = mount();
    await flush();
    chooseAuth(container, "agent");
    fillForm(container, "test-host", "test-user", "22");
    submitForm(container);
    await flush(12);
    expect(invokeMock).toHaveBeenCalledWith("connect_host", expect.objectContaining({ hostId: "h0" }));
    expect(invokeMock).toHaveBeenCalledWith("disconnect_host", { hostId: "h0" });
    expect(invokeMock).not.toHaveBeenCalledWith("run_preflight", expect.anything());
    expect(container.textContent).toContain("Connection timed out.");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it("does not reserve when disposed while TOFU listeners are still being installed", async () => {
    const ready = deferred<void>();
    invokeMock.mockImplementation(scriptedInvoke());
    const { container, handle } = mount(undefined, false, () => ready.promise);
    await flush();
    chooseAuth(container, "agent");
    fillForm(container, "test-host", "test-user", "22");
    submitForm(container);
    await flush();
    expect(invokeMock).not.toHaveBeenCalledWith("begin_connect", expect.anything());
    handle.dispose();
    ready.resolve();
    await flush();
    expect(invokeMock).not.toHaveBeenCalledWith("begin_connect", expect.anything());
  });
});

// UX-Spec §10: "Was ist passiert. Was tun." `connect.error` nennt nur bei
// Code `other` (oder ohne Code) den Host vor der Meldung; jeder andere Code
// traegt schon die Nutzermeldung des Backends. Die Pruefung hat ihren eigenen
// Text, und ein gescheitertes Speichern zeigt den Satz des Backends ganz.
describe("UX-Spec §10: Texte beim Verbinden, Pruefen und Speichern", () => {
  async function submitWith(overrides: Record<string, unknown>): Promise<HTMLElement> {
    invokeMock.mockImplementation(scriptedInvoke(overrides));
    const { container } = mount();
    await flush();
    chooseAuth(container, "agent");
    fillForm(container, "192.0.2.10", "u", "22");
    submitForm(container);
    await flush(8);
    return container;
  }

  it("Code other: Couldn't connect to {host}: {message}", async () => {
    const container = await submitWith({ connect_host: Promise.reject({ code: "other", message: "resolver crashed" }) });
    expect(errorText(container)).toBe("Couldn't connect to 192.0.2.10: resolver crashed");
  });

  it("jeder andere Code: nur die Nutzermeldung des Backends", async () => {
    const message = "The host key wasn't confirmed in time, so aidevbridge didn't connect.";
    const container = await submitWith({ connect_host: Promise.reject({ code: "connect_timeout", message }) });
    expect(errorText(container)).toBe(message);
  });

  it("nach dem Verbinden: Connected to {alias}. Checking the host…", async () => {
    const container = await submitWith({ run_preflight: new Promise(() => {}) });
    // Die Statuszeile der Karte, nicht der Ladehinweis davor (gleiche Klasse).
    expect(container.querySelector('.first-run-card > .first-run-notice[aria-live="polite"]')?.textContent).toBe(
      "Connected to 192.0.2.10. Checking the host…",
    );
  });

  it("eine gescheiterte Pruefung hat ihren eigenen Text", async () => {
    const container = await submitWith({ run_preflight: Promise.reject("preflight probe crashed") });
    expect(errorText(container)).toBe(
      "Connected, but the host check failed: preflight probe crashed. Go back and try again.",
    );
  });

  it("ein gescheitertes Speichern zeigt den Satz des Backends ganz, ohne Verbindungstext", async () => {
    const sentence = "could not write C:\\Users\\x\\settings.toml.tmp: Access is denied. (os error 5)";
    const container = await submitWith({ add_host: Promise.reject(sentence) });
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Continue")!.click();
    await flush(6);
    expect(errorText(container)).toBe(sentence);
  });

  it("ein Vorschlag mit Code other nennt ebenso den Host vor der Meldung", async () => {
    invokeMock.mockImplementation((command: string, args?: unknown) =>
      command === "suggest_hosts"
        ? Promise.resolve([JUMP])
        : command === "connect_host"
          ? Promise.reject({ code: "other", message: "resolver crashed" })
          : scriptedInvoke()(command, args),
    );
    const { container } = mount();
    await flush();
    container.querySelector<HTMLButtonElement>("li.first-run-suggestion button")!.click();
    await flush();
    expect(container.querySelector(".first-run-followup-message")?.textContent).toBe(
      "Couldn't connect to jump: resolver crashed",
    );
  });
});
