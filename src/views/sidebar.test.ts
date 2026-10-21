import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppState, type Host } from "../state/app-state";
import { waitingKey } from "../state/attention";
import { mountSidebar, type SidebarHandle } from "./sidebar";
import { appVersionLine } from "../version";
import css from "../styles.css?raw";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

function host(id: string, sessions: string[] = []): Host {
  return {
    id, runtimeId: `r-${id}`, label: id, hostname: "10.0.0.1", user: "u", port: 22, keyPath: null,
    authKind: "agent",
    state: "connected", error: null, expanded: true, lastCwd: "/tmp",
    sessions: sessions.map((name) => ({ name, hostId: id, open: false, inputLocked: false })),
  };
}

function handlers() {
  return {
    onConnectHost: vi.fn(), onDisconnectHost: vi.fn(), onEditHost: vi.fn(),
    onRemoveHost: vi.fn(), onReloadSessions: vi.fn(), onNewSession: vi.fn(),
    onOpenSession: vi.fn(), onCloseSession: vi.fn(), onKillSession: vi.fn(),
    onAddHost: vi.fn(),
    onOpenSettings: vi.fn(),
  };
}

const handles: SidebarHandle[] = [];

/** Baut die Leiste INS DOKUMENT, nicht in einen losen Baum: ein Klick in
 * einem losen Baum erreicht das Dokument nie, und jeder Test auf "Klick
 * ausserhalb" liefe wirkungslos gruen. `focus()` waere dort ebenfalls ein
 * Nichts -- darum braucht auch die Roving-Gruppe genau diese Hilfsfunktion,
 * und sie steht seither hier oben statt in der Menuegruppe. */
function mount(s: AppState, h = handlers()): { el: HTMLElement; h: ReturnType<typeof handlers> } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  handles.push(mountSidebar(el, s, h));
  return { el, h };
}

/** Der `⋯`-Knopf eines Hosts. Stand bis Task 5 in der Menuegruppe; die
 * Rueckfragegruppe braucht ihn ebenso (sie oeffnet ueber das Menue), und eine
 * zweite Abschrift davon waere dieselbe Regel zweimal. */
function moreButton(el: HTMLElement, hostId: string): HTMLButtonElement {
  const block = el.querySelector(`[data-host-id="${hostId}"]`)!.parentElement as HTMLElement;
  return block.querySelector(".host-menu-btn") as HTMLButtonElement;
}

afterEach(() => {
  while (handles.length) handles.pop()!.dispose();
  document.body.replaceChildren();
});

describe("mountSidebar", () => {
  it("zeigt jeden Zustand mit Form UND Text, nie mit Farbe allein", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "failed", error: "agent unavailable" });
    mountSidebar(el, s, handlers());

    const row = el.querySelector('[data-host-id="h1"]') as HTMLElement;
    // Der Text ist die eigentliche Absicherung von Randbedingung 3. Eine
    // Pruefung auf die Farbe waere hier sinnlos -- Farbe ist genau das, was
    // nicht genuegen darf.
    expect(row.textContent).toContain("Failed");
    expect(row.querySelector(".ind-fail")).not.toBeNull();
  });

  // Nachtrag B, Punkt 3 (Designsystem §8.4): eine gesperrte Eingabe traegt
  // eine EIGENE Form (Dreieck, nicht das kleine Quadrat von offen/
  // geschlossen) und das Wort "Input locked" -- geprueft ueber Text, nicht
  // Farbe, aus demselben Grund wie der Test oben.
  it("zeigt eine gesperrte Session mit Dreieck und dem Wort 'Disconnected', nicht mit dem Offen-Indikator", () => {
    const el = document.createElement("div");
    const s = new AppState();
    const h = host("h1", ["a"]);
    h.sessions[0].open = true;
    h.sessions[0].inputLocked = true;
    s.upsertHost(h);
    mountSidebar(el, s, handlers());

    const row = el.querySelector('[data-session-key="h1/a"]') as HTMLElement;
    expect(row.textContent).toContain("Disconnected");
    expect(row.querySelector(".ind-warn")).not.toBeNull();
    expect(row.querySelector(".ind-on")).toBeNull();
  });

  // Nachtrag C (Befund 3): der sichtbare Teil desselben Fehlers -- eine
  // geschlossene Session zeigte dauerhaft das Warndreieck, weil `closeTile`
  // `inputLocked` stehen liess und `sessionIndicator` es VOR `open` prueft.
  it("zeigt eine gesperrte Session nach dem Schliessen wieder als 'Not open' -- die Sperre ueberlebt das Schliessen nicht", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    s.lockInput("h1", "a");
    mountSidebar(el, s, handlers());

    // Vorbedingung: der gesperrte Zustand ist tatsaechlich zu sehen, sonst
    // pruefte der Vergleich unten nur einen nie erreichten Ausgangszustand.
    const vorher = el.querySelector('[data-session-key="h1/a"]') as HTMLElement;
    expect(vorher.textContent).toContain("Disconnected");

    s.closeTile(s.tiles[0].id);

    // Neu abgefragt: `render()` baut die Zeilen bei jeder Aenderung neu auf.
    const row = el.querySelector('[data-session-key="h1/a"]') as HTMLElement;
    expect(row.textContent).toContain("Not open");
    expect(row.textContent).not.toContain("Disconnected");
    // Designsystem §8.4: hohles Quadrat, nicht Dreieck -- Geometrie, nicht
    // nur Text (dieselbe Doppelung wie in den beiden Tests darueber).
    expect(row.querySelector(".ind-warn")).toBeNull();
    expect(row.querySelector(".ind-off")).not.toBeNull();
  });

  it("meldet den host-qualifizierten Schluessel beim Klick auf eine Session", () => {
    const el = document.createElement("div");
    const s = new AppState();
    // Gleichnamige Sessions auf zwei Hosts -- genau der Fall, in dem ein
    // unqualifizierter Name mehrdeutig waere.
    s.upsertHost(host("h1", ["gleich"]));
    s.upsertHost(host("h2", ["gleich"]));
    const h = handlers();
    mountSidebar(el, s, h);

    const zeile = el.querySelector('[data-session-key="h2/gleich"]') as HTMLButtonElement;
    expect(zeile).not.toBeNull();
    zeile.click();

    expect(h.onOpenSession).toHaveBeenCalledWith("h2", "gleich", { replace: false });
    expect(h.onOpenSession).not.toHaveBeenCalledWith("h1", "gleich", expect.anything());
  });

  it("Strg+Klick ersetzt die fokussierte Kachel (Spec 2026-10-19 §5.2)", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el, h } = mount(s);
    el.querySelector<HTMLElement>('[data-session-key="h1/a"]')!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(h.onOpenSession).toHaveBeenCalledWith("h1", "a", { replace: true });
  });

  it("der Tooltip sagt, was Klick und Strg+Klick tun", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.openSession("h1", "a");
    const { el } = mount(s);
    expect(el.querySelector<HTMLElement>('[data-session-key="h1/a"]')!.title).toBe("Click: show its terminal");
    expect(el.querySelector<HTMLElement>('[data-session-key="h1/b"]')!.title).toBe(
      "Click: open as a new terminal · Ctrl+click: replace the focused terminal",
    );
  });

  it("ist per Tastatur erreichbar: jede Zeile ist eine Schaltflaeche", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    mountSidebar(el, s, handlers());

    const zeilen = el.querySelectorAll(".ab-row");
    expect(zeilen.length).toBeGreaterThan(0);
    zeilen.forEach((r) => expect(r.tagName).toBe("BUTTON"));
  });

  it("zeichnet neu, wenn sich der Zustand aendert", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(host("h1"));
    mountSidebar(el, s, handlers());
    expect(el.querySelectorAll('[data-session-key]')).toHaveLength(0);

    s.setSessions("h1", ["neu"]);
    expect(el.querySelectorAll('[data-session-key]')).toHaveLength(1);
  });

  it("meldet sich bei dispose() vom Zustand ab", () => {
    // Paket 2.5, Aufgabe 5: dieser Test sah frueher auf die DOM-Wirkung
    // (`[data-session-key]` bleibt leer) -- und pruefte damit das ODER
    // ZWEIER Mechanismen. Loeschte man `unsubscribe()`, blieb er gruen, weil
    // `render()` wegen `if (disposed) return;` ohnehin umkehrt und das DOM
    // leer bleibt. Beobachtet wird deshalb jetzt DER ABONNENT SELBST: laeuft
    // er nach dem Entsorgen noch, ist die Ansicht nicht abgemeldet, ganz
    // gleich, was sie danach tut. (Dasselbe Strukturmuster wie der behobene
    // "ein Zeichen, ohne Puffer"-Test in `terminal.test.ts`.)
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(host("h1"));

    let subscriberRuns = 0;
    const realSubscribe = s.subscribe.bind(s);
    s.subscribe = (fn: () => void) =>
      realSubscribe(() => {
        subscriberRuns++;
        fn();
      });

    const handle = mountSidebar(el, s, handlers());
    // Vorbedingung: der Abonnent laeuft ueberhaupt -- sonst waere die
    // Zusicherung unten auch dann wahr, wenn sich die Ansicht nie
    // angemeldet haette.
    s.setSessions("h1", ["vorher"]);
    expect(subscriberRuns).toBeGreaterThan(0);
    const runsBeforeDispose = subscriberRuns;

    handle.dispose();
    s.setSessions("h1", ["neu"]);

    // Ohne Abmelden liefe die entsorgte Ansicht bei JEDER Zustandsaenderung
    // weiter mit -- ein Leck, das erst unter vielen Hosts auffaellt.
    expect(subscriberRuns).toBe(runsBeforeDispose);
  });

  // Nachtrag (Review-Erfahrung aus Task 3 dieses Repos: fuenf oeffentliche
  // Methoden ohne jeden Test waren dort ein eigener Befund): die Aktionen an
  // JEDEM Host muessen ihren EIGENEN Host melden, nicht "irgendeinen" oder
  // den erstbesten. Ein Klick bei h2 darf h1 nicht treffen.
  //
  // Fuehrte urspruenglich ueber "Remove"; der Knopf liegt seit dem
  // Aufklappmenue (Entwurf §1.2) nicht mehr flach in der Leiste. Die
  // Zusicherung selbst bleibt richtig und bleibt deshalb stehen -- ueber den
  // verbliebenen flachen Knopf. Ihre Menue-Entsprechung steht in "meldet den
  // richtigen Host beim Menueeintrag, nicht den erstbesten".
  it("meldet den richtigen Host bei einem Aktionsknopf, nicht den erstbesten", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const h = handlers();
    mountSidebar(el, s, h);

    const h2Block = el.querySelector('[data-host-id="h2"]')!.parentElement as HTMLElement;
    const newSessionButton = Array.from(h2Block.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "New session",
    ) as HTMLButtonElement;
    newSessionButton.click();

    expect(h.onNewSession).toHaveBeenCalledWith("h2");
    expect(h.onNewSession).not.toHaveBeenCalledWith("h1");
  });

  it("traegt im Kopf ein Zahnrad mit title und aria-label, das die Einstellungen oeffnet", () => {
    const s = new AppState();
    const h = handlers();
    const { el } = mount(s, h);
    const gear = el.querySelector<HTMLButtonElement>(".sb-head .sb-head-btn");
    expect(gear?.getAttribute("aria-label")).toBe("Settings");
    // UX-Spec §8.4: der Tooltip nennt das Kuerzel, der Name bleibt schlicht.
    expect(gear?.title).toBe("Settings (Ctrl+,)");
    expect(gear?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    gear!.click();
    expect(h.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  // Aufgabe 19, Fixrunde 1: "New session" ist an der
  // Hostleiste ein Icon-Knopf `plus`, damit die Leiste bei 240 px in eine Zeile
  // passt. Der Name steht in `aria-label`, der Tooltip nennt das Kuerzel aus der
  // aktiven Tabelle (UX-Spec §8.4) -- der fruehere Entscheid "kein Kuerzel am
  // Host" ist damit abgeloest.
  it("New session am Host ist ein Icon-Knopf mit Namen und Kuerzel im Tooltip", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    const button = Array.from(el.querySelectorAll<HTMLButtonElement>(".host-action-btn")).find(
      (candidate) => candidate.getAttribute("aria-label") === "New session",
    )!;

    expect(button.classList.contains("host-icon-btn")).toBe(true);
    expect(button.title).toBe("New session (Ctrl+Shift+N)");
    expect(button.textContent).toBe("");
    const box = button.querySelector<HTMLElement>(".icon-box")!;
    expect(box.dataset.icon).toBe("plus");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.querySelector("svg")).not.toBeNull();
    expect(button.tabIndex).toBe(-1);
  });
});

// =====================================================================
// Abschlussreview (Important 1): der Wiederverbindungsversuch auf einen
// gespeicherten, passphrasegeschuetzten Schluessel war eine Sackgasse --
// `onConnectHost` reichte fest `passphrase: null` durch, und die
// Seitenleiste bot kein Feld dafuer. Unter Windows 11 ist das der
// Normalfall (ssh-agent-Dienst ab Werk deaktiviert).
// =====================================================================

describe("mountSidebar: Passphrase beim erneuten Verbinden", () => {
  function failedHostWithKey(id: string) {
    return {
      ...host(id),
      state: "failed" as const,
      error: "This key is passphrase-protected. Enter the passphrase.",
      errorCode: "passphrase_required",
      keyPath: "C:\\Users\\U\\.ssh\\id_ed25519",
      authKind: "key" as const,
    };
  }

  it("bietet bei einem fehlgeschlagenen Host mit gespeichertem Schluessel ein Passphrase-Feld und reicht es an Retry weiter", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(failedHostWithKey("h1"));
    const h = handlers();
    mountSidebar(el, s, h);

    const input = el.querySelector(".host-notice input[name=passphrase]") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe("password");

    input.value = "geheim";
    const retry = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    retry.click();

    expect(h.onConnectHost).toHaveBeenCalledWith("h1", { passphrase: "geheim" });
  });

  it("meldet bei leerem Feld KEINE Passphrase -- die Nutzlast bleibt wie zuvor", () => {
    // Ein leerer String waere auf der Rust-Seite eine ANGEGEBENE (leere)
    // Passphrase, kein Weglassen -- `resolve_auth_method` reichte sie an
    // `load_secret_key` durch.
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(failedHostWithKey("h1"));
    const h = handlers();
    mountSidebar(el, s, h);

    const retry = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    retry.click();

    expect(h.onConnectHost).toHaveBeenCalledWith("h1", undefined);
  });

  it("zeigt kein Passphrase-Feld ohne gespeicherten Schluesselpfad", () => {
    // Ohne `keyPath` verbindet der Host per ssh-agent oder Passwort -- eine
    // Passphrase ist dort bedeutungslos (`resolve_auth_method` verwirft sie).
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "failed", error: "ssh-agent not reachable.", errorCode: "auth_rejected" });
    mountSidebar(el, s, handlers());

    expect(el.querySelector(".host-notice")).not.toBeNull();
    expect(el.querySelector("input[name=passphrase]")).toBeNull();
  });
});

// =====================================================================
// Ein Geheimnis hilft nur nach einem Anmeldefehler. Bei Netz-,
// Hostschluessel- und anderen Fehlern stehen nur "Retry" und "Details" da,
// sonst laege die Ursache scheinbar bei Passwort oder Passphrase.
// =====================================================================

describe("mountSidebar: Feld fuer das Geheimnis nur nach einem Anmeldefehler", () => {
  const AUTH_KINDS = {
    key: { authKind: "key" as const, keyPath: "C:\\Users\\U\\.ssh\\id_ed25519" },
    password: { authKind: "password" as const, keyPath: null },
    agent: { authKind: "agent" as const, keyPath: null },
  };

  function noticeButtons(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll<HTMLButtonElement>(".host-notice button"))
      .filter((b) => !b.hidden)
      .map((b) => b.textContent ?? "");
  }

  it.each([
    ["host_unreachable", "key"], ["host_unreachable", "password"], ["host_unreachable", "agent"],
    ["connect_timeout", "key"], ["connect_timeout", "password"], ["connect_timeout", "agent"],
    ["host_key_rejected", "key"], ["host_key_rejected", "agent"],
    ["other", "key"], [null, "password"], [null, "key"],
  ] as const)("zeigt nach %s am %s-Host kein Feld, nur Retry und Details", (code, kind) => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1"), ...AUTH_KINDS[kind], state: "failed", error: "SSH connection timed out.", errorCode: code });
    const h = handlers();
    mountSidebar(el, s, h);

    const notice = el.querySelector(".host-notice")!;
    expect(notice.textContent).toContain("SSH connection timed out.");
    expect(notice.querySelector("input")).toBeNull();
    expect(noticeButtons(el)).toEqual(["Retry", "Details"]);
    Array.from(el.querySelectorAll<HTMLButtonElement>(".host-notice button")).find((b) => b.textContent === "Retry")!.click();
    expect(h.onConnectHost).toHaveBeenCalledWith("h1", undefined);
  });

  it.each([
    ["passphrase_required", "key", "passphrase"],
    ["auth_rejected", "key", "passphrase"],
    ["password_required", "password", "password"],
    ["auth_rejected", "agent", "password"],
  ] as const)("zeigt nach %s am %s-Host das Feld %s vor Retry", (code, kind, field) => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1"), ...AUTH_KINDS[kind], state: "failed", error: "Authentication failed.", errorCode: code });
    mountSidebar(el, s, handlers());

    const inputs = Array.from(el.querySelectorAll<HTMLInputElement>(".host-notice input"));
    expect(inputs.map((input) => input.name)).toEqual([field]);
    // Das Feld steht vor den Knoepfen: es ist das erste Bedienelement.
    expect(el.querySelector(".host-notice")!.querySelector("input, button")).toBe(inputs[0]);
  });

  it("ein spaeterer Netzfehler nimmt das Feld wieder weg", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1"), ...AUTH_KINDS.password, state: "disconnected" });
    mountSidebar(el, s, handlers());
    s.setHostState("h1", "failed", "Password required. Enter it below and retry.", "password_required");
    expect(el.querySelector(".host-notice input[name=password]")).not.toBeNull();
    s.setHostState("h1", "connecting");
    s.setHostState("h1", "failed", "SSH connection timed out.", "connect_timeout");
    expect(el.querySelector(".host-notice input")).toBeNull();
  });
});

// =====================================================================
// Task 8 (Spec §4.8): ein per Passwort gespeicherter Host fiel nach einem
// Neustart still auf ssh-agent zurueck -- `host.authKind` unterscheidet ihn
// jetzt von einem Agent-Host, und die Hinweisleiste zeigt fuer JEDE
// Anmeldeart das richtige Feld (oder keins).
// =====================================================================

describe("mountSidebar: Passwort beim erneuten Verbinden (Task 8)", () => {
  it("bietet bei einem fehlgeschlagenen Passwort-Host ein Passwortfeld und reicht es an Retry weiter", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({
      ...host("h1"),
      state: "failed",
      error: "Wrong password for this account.",
      errorCode: "password_required",
      authKind: "password",
    });
    const h = handlers();
    mountSidebar(el, s, h);

    const input = el.querySelector(".host-notice input[name=password]") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe("password");
    expect(el.querySelector("input[name=passphrase]")).toBeNull();

    input.value = "geheim";
    const retry = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    retry.click();

    expect(h.onConnectHost).toHaveBeenCalledWith("h1", { password: "geheim" });
  });

  it("bietet bei einem fehlgeschlagenen Schluessel-Host weiterhin das Passphrasefeld und reicht es an Retry weiter", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({
      ...host("h1"),
      state: "failed",
      error: "Wrong passphrase for this key.",
      errorCode: "passphrase_required",
      authKind: "key",
      keyPath: "C:\\Users\\U\\.ssh\\id_ed25519",
    });
    const h = handlers();
    mountSidebar(el, s, h);

    const input = el.querySelector(".host-notice input[name=passphrase]") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(el.querySelector("input[name=password]")).toBeNull();

    input.value = "geheim";
    const retry = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    retry.click();

    expect(h.onConnectHost).toHaveBeenCalledWith("h1", { passphrase: "geheim" });
  });

  // Gesamtreview M0 (Befund 1): ein Host ohne gespeicherte Anmeldeart UND
  // ohne `key_path` gilt per `effective_auth_kind()` (Rust) als "agent" --
  // das trifft jeden Host, der VOR Task 8 per Passwort angelegt wurde
  // (seine `settings.toml` kennt `auth_kind` schlicht nicht). Bis hierher
  // zeigte die Hinweisleiste ihm dann NUR die Agent-Fehlermeldung und keinen
  // Ausweg zum Passwort -- dieser Test stand vorher umgekehrt (erwartete
  // KEIN Feld) und wurde mit dem Fix umgedreht.
  it("bietet bei einem fehlgeschlagenen Agent-Host ebenfalls ein Passwortfeld und reicht es an Retry weiter", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({
      ...host("h1"),
      state: "failed",
      error: "ssh-agent not reachable.",
      errorCode: "auth_rejected",
      authKind: "agent",
    });
    const h = handlers();
    mountSidebar(el, s, h);

    const input = el.querySelector(".host-notice input[name=password]") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe("password");
    expect(el.querySelector("input[name=passphrase]")).toBeNull();

    input.value = "geheim";
    const retry = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    retry.click();

    expect(h.onConnectHost).toHaveBeenCalledWith("h1", { password: "geheim" });
  });

  it("meldet bei einem fehlgeschlagenen Agent-Host ohne Eingabe weiterhin KEIN Passwort -- der Versuch bleibt beim Agent", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({
      ...host("h1"),
      state: "failed",
      error: "ssh-agent not reachable.",
      errorCode: "auth_rejected",
      authKind: "agent",
    });
    const h = handlers();
    mountSidebar(el, s, h);

    const retry = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    retry.click();

    expect(h.onConnectHost).toHaveBeenCalledWith("h1", undefined);
  });
});

// =====================================================================
// Task 8 (Spec §4.8), Befund 11: ein Neuzeichnen (z. B. durch eine
// Zustandsaenderung an einem ANDEREN Host) darf den bereits getippten Wert
// eines fokussierten Eingabefelds in der Hinweisleiste nicht verwerfen.
// =====================================================================

describe("mountSidebar: Eingabefeld der Hinweisleiste uebersteht ein Neuzeichnen (Befund 11)", () => {
  it("behaelt Wert und Cursorposition, wenn ein Neuzeichnen waehrend der Eingabe passiert", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const s = new AppState();
    s.upsertHost({
      ...host("h1"),
      state: "failed",
      error: "Wrong password for this account.",
      errorCode: "password_required",
      authKind: "password",
    });
    s.upsertHost({ ...host("h2"), state: "connected" });
    mountSidebar(el, s, handlers());

    const input = el.querySelector(".host-notice input[name=password]") as HTMLInputElement;
    input.focus();
    input.value = "abc";
    input.setSelectionRange(3, 3);
    expect(document.activeElement).toBe(input);

    // Ein Neuzeichnen ausloesen, das mit dem getippten Wert NICHTS zu tun
    // hat -- ein Statuswechsel an einem ANDEREN Host.
    s.setHostState("h2", "disconnected");

    const after = el.querySelector(".host-notice input[name=password]") as HTMLInputElement;
    expect(after).not.toBeNull();
    expect(after.value).toBe("abc");
    expect(after.selectionStart).toBe(3);
    expect(after.selectionEnd).toBe(3);
    expect(document.activeElement).toBe(after);
  });
});

// =====================================================================
// Abschlussreview (Important 3): `render()` baut bei JEDER Benachrichtigung
// alles neu auf -- das fokussierte Element verschwand dabei aus dem DOM und
// der Fokus fiel auf `<body>`. Der Tab-Weg begann nach jeder Aktion wieder
// ganz oben, hinter 5xN Host-Schaltflaechen.
// =====================================================================

describe("mountSidebar: Tastaturfokus ueberlebt das Neuzeichnen", () => {
  it("haelt den Fokus auf der Hostzeile, wenn das Aufklappen ein Neuzeichnen ausloest", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    mountSidebar(el, s, handlers());

    const row = el.querySelector('[data-host-id="h1"]') as HTMLButtonElement;
    row.focus();
    expect(el.contains(document.activeElement)).toBe(true);

    row.click(); // klappt zu/auf und ruft render() selbst auf

    expect(el.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.hostId).toBe("h1");
    el.remove();
  });

  it("haelt den Fokus auf dem Umschaltknopf, obwohl dessen Beschriftung von Connect auf Disconnect wechselt", () => {
    // Der Bezeichner darf die Beschriftung NICHT tragen -- genau dieser
    // Zustandswechsel ist der Fall, ueber den er hinweg gelten muss.
    const el = document.createElement("div");
    document.body.appendChild(el);
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "disconnected" });
    mountSidebar(el, s, handlers());

    const toggle = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Connect",
    ) as HTMLButtonElement;
    toggle.focus();

    s.setHostState("h1", "connecting");

    expect(el.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe("Disconnect");
    el.remove();
  });

  // Im echten Chrome belegt: die Knopfleiste ist per CSS `display: none`,
  // solange ihr Block weder aktiv noch `:focus-within` ist (styles.css), und
  // `render()` baut die Bloecke ohne `sb-host-block--active`. Ein `focus()` auf
  // einen Knopf darin verpuffte, der Fokus fiel auf <body>, und der naechste
  // Tabulator begann oben im Dokument. jsdom laedt styles.css nicht und
  // fokussiert auch Unsichtbares -- geprueft wird deshalb, dass der Block des
  // Knopfs im Augenblick des `focus()` schon aktiv markiert ist.
  it.each([
    ["den Umschaltknopf, wenn sein Host verbindet", "host:h1:toggle", false, (s: AppState) => s.setHostState("h1", "connecting")],
    ["den ⋯-Knopf, wenn ein anderer Host zuklappt", "host:h1:more", false, (s: AppState) => s.setHostExpanded("h2", false)],
    [
      "den Umschaltknopf, waehrend eine Kachel eines anderen Hosts die fokussierte ist",
      "host:h1:toggle",
      true,
      (s: AppState) => s.setHostState("h1", "connecting"),
    ],
  ] as const)("zeigt die Leiste, bevor die Rettung %s fokussiert", (_label, key, tileOfOtherHost, change) => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2", ["b"]));
    if (tileOfOtherHost) s.openSession("h2", "b");
    const { el } = mount(s);
    const byKey = (wanted: string) =>
      Array.from(el.querySelectorAll<HTMLElement>("[data-focus-key]")).find((node) => node.dataset.focusKey === wanted)!;
    // Wie ein Nutzer mit der Tastatur: erst die Hostzeile, dann der Knopf.
    byKey("host:h1:row").focus();
    byKey(key).focus();
    expect(document.activeElement).toBe(byKey(key));

    const focusedWhileActive: boolean[] = [];
    const nativeFocus = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      if (this.dataset.focusKey === key) {
        focusedWhileActive.push(this.closest(".sb-host-block")?.classList.contains("sb-host-block--active") ?? false);
      }
      nativeFocus.call(this, options);
    });
    try {
      change(s);
    } finally {
      spy.mockRestore();
    }

    expect(document.activeElement).toBe(byKey(key));
    expect(focusedWhileActive).toEqual([true]);
    // Danach traegt genau dieser Host die Markierung.
    expect(Array.from(el.querySelectorAll(".sb-host-block--active .row-host")).map((row) => (row as HTMLElement).dataset.hostId))
      .toEqual(["h1"]);
  });

  it("reisst den Fokus NICHT an sich, wenn er ausserhalb der Seitenleiste steht", () => {
    // Wichtiger als die Rettung selbst: `render()` laeuft bei jeder
    // Zustandsaenderung, auch waehrend ein Terminal oder ein Dialog den
    // Fokus haelt. Ein bedingungsloses Fokussieren waere eine schlimmere
    // Regression als der behobene Fehler.
    const el = document.createElement("div");
    document.body.appendChild(el);
    const aussen = document.createElement("button");
    document.body.appendChild(aussen);

    const s = new AppState();
    s.upsertHost(host("h1"));
    mountSidebar(el, s, handlers());

    aussen.focus();
    expect(document.activeElement).toBe(aussen);

    s.setHostState("h1", "connecting");

    expect(document.activeElement).toBe(aussen);
    el.remove();
    aussen.remove();
  });

  // Aufgabe 19, Fixrunde 3 (D): `focus()` auf einem deaktivierten Knopf tut
  // nichts, und der Fokus fiele auf <body> -- der naechste Tabulator begaenne
  // ganz oben. Die Hostzeile desselben Hosts faengt ihn auf; sie ist kein
  // zerstoererisches Ziel.
  it.each(["New session", "Reload sessions"])(
    "faellt auf die Hostzeile zurueck, wenn der fokussierte Knopf '%s' deaktiviert wird",
    (name) => {
      const s = new AppState();
      s.upsertHost(host("h1", ["a"]));
      const { el } = mount(s);
      const button = () => Array.from(el.querySelectorAll<HTMLButtonElement>(".host-actions button")).find(
        (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
      )!;
      button().focus();
      expect(document.activeElement).toBe(button());

      s.setHostState("h1", "disconnected");

      expect(button().disabled).toBe(true);
      expect(document.activeElement).toBe(el.querySelector('[data-host-id="h1"]'));
    },
  );

  it.each([
    ["Retry in einem Hinweis, der verschwindet", "notice"],
    ["eine Sessionzeile, deren Session verschwindet", "session"],
  ] as const)("faellt auf die Hostzeile zurueck, wenn %s den Fokus hatte", (_label, kind) => {
    const s = new AppState();
    s.upsertHost(kind === "notice" ? { ...host("h1"), state: "failed", error: "boom" } : host("h1", ["a", "b"]));
    const { el } = mount(s);
    const focused = kind === "notice"
      ? Array.from(el.querySelectorAll<HTMLButtonElement>(".host-notice button")).find((b) => b.textContent === "Retry")!
      : el.querySelector<HTMLElement>('[data-session-key="h1/b"]')!;
    focused.focus();
    expect(document.activeElement).toBe(focused);

    if (kind === "notice") s.setHostState("h1", "connected");
    else s.setSessions("h1", ["a"]);

    expect(el.contains(focused)).toBe(false);
    expect(document.activeElement).toBe(el.querySelector('[data-host-id="h1"]'));
  });

  it("fokussiert nichts, wenn mit dem zuvor fokussierten Element sein Host verschwunden ist", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    mountSidebar(el, s, handlers());

    const row = el.querySelector('[data-host-id="h2"]') as HTMLButtonElement;
    row.focus();

    s.removeHost("h2");

    // Kein geratener Nachbar: der Fokus darf nicht auf einer Schaltflaeche
    // landen, die der Nutzer nie angesteuert hat -- "Remove" liegt in
    // Reichweite.
    expect(el.contains(document.activeElement)).toBe(false);
    el.remove();
  });
});

describe("mountSidebar und der Session-Zaehler", () => {
  it("zeigt die Sessionzahl an einem zugeklappten Host", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["a", "b", "c"]), expanded: false });
    mountSidebar(el, s, handlers());
    const row = el.querySelector('[data-host-id="h1"]') as HTMLElement;
    // Designsystem 5.2: eine zugeklappte Gruppe zeigt rechts "7 sessions".
    expect(row.textContent).toContain("3 sessions");
  });

  it("zeigt sie NICHT, wenn der Host aufgeklappt ist", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c"]));
    mountSidebar(el, s, handlers());
    const row = el.querySelector('[data-host-id="h1"]') as HTMLElement;
    // Aufgeklappt stehen die Sessions darunter -- die Zahl waere Rauschen.
    expect(row.textContent).not.toContain("3 sessions");
  });

  it("sagt bei einer einzigen Session 'session', nicht 'sessions'", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["a"]), expanded: false });
    mountSidebar(el, s, handlers());
    const row = el.querySelector('[data-host-id="h1"]') as HTMLElement;
    expect(row.textContent).toContain("1 session");
    // Die scharfe Haelfte: "1 sessions" enthaelt "1 session" als
    // Teilzeichenkette, die Zusicherung oben allein wuerde beides bestehen.
    expect(row.textContent).not.toContain("1 sessions");
  });

  it("zeigt an einem zugeklappten Host ohne Sessions keinen Zaehler", () => {
    const el = document.createElement("div");
    const s = new AppState();
    s.upsertHost({ ...host("h1"), expanded: false });
    mountSidebar(el, s, handlers());
    const row = el.querySelector('[data-host-id="h1"]') as HTMLElement;
    // "0 sessions" fuellt eine Stelle mit einem Wort, ohne etwas zu sagen.
    expect(row.querySelector(".row-session-count")).toBeNull();
  });
});

// UX-Spec §7.8: am zugeklappten Host steht statt "N sessions" eine
// Waiting-Pille mit Zahl, gezaehlt nach derselben Regel wie Fenstertitel und
// Schnelloeffnen -- nur ein aktueller, nicht veralteter `waiting`-Status.
describe("mountSidebar: Wartende am zugeklappten Host (UX-Spec §7.8)", () => {
  /** Ein zugeklappter, verbundener Host mit einer frischen Statusbeobachtung. */
  function collapsedHost(statuses: Array<[name: string, status: string]>): AppState {
    const s = new AppState();
    s.upsertHost({ ...host("h1", statuses.map(([name]) => name)), expanded: false });
    s.setSessionRecords("h1", statuses.map(([name, status]) => ({ name, status, statusReason: "" })), Date.now());
    return s;
  }

  function hostRowOf(el: HTMLElement): HTMLElement {
    return el.querySelector('[data-host-id="h1"]') as HTMLElement;
  }

  /** Die Zustandspille der Hostzeile ("Online", "Offline", ...) oder `null`. */
  function statePill(el: HTMLElement): HTMLElement | null {
    return hostRowOf(el).querySelector<HTMLElement>(".row-meta .state-pill");
  }

  it("zeigt statt 'N sessions' eine Waiting-Pille mit der Zahl", () => {
    const { el } = mount(collapsedHost([["a", "waiting"], ["b", "busy"], ["c", "waiting"]]));
    const row = hostRowOf(el);
    const pill = row.querySelector<HTMLElement>(".row-meta .st.st-waiting")!;
    expect(pill.textContent).toBe("2 waiting");
    // Im Stil der Statuspille: dieselbe Raute im 14er-Kasten.
    expect(pill.querySelector(".icon-box .ag.ag-waiting")).not.toBeNull();
    expect(row.querySelector(".row-session-count")).toBeNull();
    expect(row.textContent).not.toContain("3 sessions");
  });

  // Aufgabe 19, Fixrunde 1: die Waiting-Pille tritt an
  // die Stelle der Zustandspille -- ein aktueller Wartestatus setzt "Online"
  // voraus. Die Zeile behaelt ihr `data-state`.
  it("ersetzt mit der Waiting-Pille die Zustandspille; die Zeile behaelt data-state", () => {
    const { el } = mount(collapsedHost([["a", "waiting"], ["b", "busy"]]));
    const row = hostRowOf(el);
    expect(statePill(el)).toBeNull();
    expect(row.textContent).not.toContain("Online");
    expect(row.querySelector(".row-meta")!.children).toHaveLength(1);
    expect(row.dataset.state).toBe("connected");
  });

  it("ohne Wartende stehen Sessionzahl und Zustandspille wie bisher", () => {
    const { el } = mount(collapsedHost([["a", "busy"], ["b", "idle"], ["c", "busy"]]));
    const row = hostRowOf(el);
    expect(row.querySelector(".st")).toBeNull();
    expect(row.querySelector(".row-session-count")!.textContent).toBe("3 sessions");
    expect(statePill(el)!.textContent).toBe("Online");
    expect(row.dataset.state).toBe("connected");
  });

  it("zaehlt einen veralteten Status nicht", () => {
    const s = collapsedHost([["a", "waiting"], ["b", "waiting"]]);
    s.markStatusStale("h1");
    const { el } = mount(s);
    const row = hostRowOf(el);
    expect(row.querySelector(".st")).toBeNull();
    expect(row.querySelector(".row-session-count")!.textContent).toBe("2 sessions");
    expect(statePill(el)!.textContent).toBe("Online");
  });

  it("zaehlt einen nach einem Quellenausfall festgehaltenen Wert nicht mit", () => {
    const s = collapsedHost([["a", "waiting"], ["b", "waiting"]]);
    s.keepStatusStale("h1", ["b"]);
    const { el } = mount(s);
    expect(hostRowOf(el).querySelector(".st-waiting")!.textContent).toBe("1 waiting");
  });

  it("zaehlt an einem getrennten Host nichts", () => {
    const s = collapsedHost([["a", "waiting"]]);
    s.setHostState("h1", "disconnected");
    const { el } = mount(s);
    const row = hostRowOf(el);
    expect(row.querySelector(".st")).toBeNull();
    expect(row.querySelector(".row-session-count")!.textContent).toBe("1 session");
    expect(statePill(el)!.textContent).toBe("Offline");
  });

  it("folgt dem Status: wartet die letzte nicht mehr, kommen Sessionzahl und Zustandspille zurueck", () => {
    const s = collapsedHost([["a", "waiting"], ["b", "idle"]]);
    const { el } = mount(s);
    expect(hostRowOf(el).querySelector(".st-waiting")!.textContent).toBe("1 waiting");
    expect(statePill(el)).toBeNull();
    s.setSessionRecords("h1", [{ name: "a", status: "busy" }, { name: "b", status: "idle" }], Date.now());
    const row = hostRowOf(el);
    expect(row.querySelector(".st")).toBeNull();
    expect(row.querySelector(".row-session-count")!.textContent).toBe("2 sessions");
    expect(statePill(el)!.textContent).toBe("Online");
  });

  it("zeigt die Pille nicht am aufgeklappten Host -- dort tragen die Sessionzeilen ihre eigene", () => {
    const s = collapsedHost([["a", "waiting"], ["b", "waiting"]]);
    s.setHostExpanded("h1", true);
    const { el } = mount(s);
    expect(hostRowOf(el).querySelector(".st")).toBeNull();
    expect(statePill(el)!.textContent).toBe("Online");
    expect(el.querySelectorAll(".row-session .st-waiting")).toHaveLength(2);
  });
});

describe("mountSidebar: Wartet-Spur (Spec 2026-10-19 §7)", () => {
  const NOW = new Date("2026-10-19T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Ein verbundener Host, dessen Sessions warten; `ago` in ms je Name. */
  function waiting(ago: Record<string, number>, reason: string | null = null) {
    const names = Object.keys(ago);
    const s = new AppState();
    s.upsertHost(host("h1", [...names, "idle"]));
    s.setSessionRecords("h1", names.map((name) => ({ name, status: "waiting", statusReason: reason })), Date.now());
    const since = new Map(
      s.hosts[0].sessions.filter((row) => row.name in ago).map((row) => [waitingKey(row), NOW - ago[row.name]]),
    );
    const h = { ...handlers(), waitingSince: (key: string) => since.get(key) };
    const { el } = mount(s, h);
    return { s, el, h, since };
  }

  function laneNames(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll<HTMLElement>(".row-lane .row-label")).map((label) => label.textContent ?? "");
  }

  function laneTimes(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll<HTMLElement>(".row-lane .row-lane-time")).map((time) => time.textContent ?? "");
  }

  it("steht nur, wenn jemand wartet, ganz oben; der Kopf nennt Zahl und Ctrl+Shift+A", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    expect(el.querySelector(".sb-lane")).toBeNull();
    s.setSessionRecords("h1", [{ name: "a", status: "waiting" }], Date.now());
    expect(el.querySelector(".sb-list")!.firstElementChild?.classList.contains("sb-lane")).toBe(true);
    expect(el.querySelector(".sb-lane-title")?.textContent).toBe("Waiting · 1");
    expect(el.querySelector(".sb-lane-head kbd")?.textContent).toBe("Ctrl+Shift+A");
  });

  it("die aelteste oben, mit Wartezeit now, 12m und 2h, je Minute neu", () => {
    const { el } = waiting({ a: 30_000, b: 2 * 3_600_000 + 5_000, c: 12 * 60_000 });
    expect(laneNames(el)).toEqual(["b", "c", "a"]);
    expect(laneTimes(el)).toEqual(["2h", "12m", "now"]);
    vi.advanceTimersByTime(60_000);
    expect(laneTimes(el)).toEqual(["2h", "13m", "1m"]);
  });

  it("zeigt den Grund in der zweiten Zeile", () => {
    const { el } = waiting({ a: 0 }, "permission prompt");
    expect(el.querySelector(".row-lane .row-lane-reason")?.textContent).toBe("permission prompt");
  });

  it("hoechstens fuenf Zeilen, dann +n more, das auf- und zuklappt", () => {
    const { el } = waiting({ a: 7, b: 6, c: 5, d: 4, e: 3, f: 2, g: 1 });
    expect(laneNames(el)).toEqual(["a", "b", "c", "d", "e"]);
    const more = el.querySelector<HTMLButtonElement>(".row-lane-more")!;
    expect([more.textContent, more.getAttribute("aria-expanded")]).toEqual(["+2 more", "false"]);
    more.click();
    expect(laneNames(el)).toHaveLength(7);
    expect(el.querySelector(".row-lane-more")?.textContent).toBe("Show less");
  });

  it("Klick oeffnet, Strg+Klick ersetzt; von selbst oeffnet die Spur nichts", () => {
    const { s, el, h } = waiting({ a: 0 });
    expect(s.tiles).toEqual([]);
    expect(h.onOpenSession).not.toHaveBeenCalled();
    const row = el.querySelector<HTMLElement>(".row-lane")!;
    row.click();
    expect(h.onOpenSession).toHaveBeenLastCalledWith("h1", "a", { replace: false });
    el.querySelector<HTMLElement>(".row-lane")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(h.onOpenSession).toHaveBeenLastCalledWith("h1", "a", { replace: true });
  });

  it("eine offene Session zeigt ihre Kachelnummer", () => {
    const { s, el } = waiting({ a: 0, b: 0 });
    s.openSession("h1", "b");
    const row = Array.from(el.querySelectorAll<HTMLElement>(".row-lane")).find(
      (candidate) => candidate.querySelector(".row-label")?.textContent === "b",
    )!;
    expect(row.querySelector(".tile-number.tile-number--focused")?.textContent).toBe("1");
  });

  it("solange der Zeiger in der Spur ist, steht die Reihenfolge; danach sortiert sie neu", () => {
    const { s, el, since } = waiting({ a: 20_000, b: 10_000 });
    expect(laneNames(el)).toEqual(["a", "b"]);
    el.querySelector<HTMLElement>(".row-lane")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    since.set(waitingKey(s.hosts[0].sessions[1]), NOW - 90_000);
    s.setHostExpanded("h1", false);
    expect(laneNames(el)).toEqual(["a", "b"]);
    el.querySelector<HTMLElement>(".sb-list")!.dispatchEvent(new PointerEvent("pointerleave"));
    expect(laneNames(el)).toEqual(["b", "a"]);
  });

  it("ohne fokussierte Kachel zeigt weiter genau ein Host seine Leiste, nicht die Spur (Spec §7: die Liste bleibt wie heute)", () => {
    const { el } = waiting({ a: 0 });
    expect(el.querySelector<HTMLElement>(".row-lane")!.dataset.ownerHostId).toBe("h1");
    // Der Roving-Halt liegt auf der ersten Hostzeile, nicht auf der ersten
    // Zeile der Spur.
    expect(el.querySelector<HTMLElement>(".row-host")!.tabIndex).toBe(0);
    expect(el.querySelector<HTMLElement>(".row-lane")!.tabIndex).toBe(-1);
    const active = Array.from(el.querySelectorAll<HTMLElement>(".sb-host-block--active .row-host"));
    expect(active.map((row) => row.dataset.hostId)).toEqual(["h1"]);
    expect(handles[handles.length - 1].activeHostId()).toBe("h1");
  });

  // --- Ueber die Vorgabe hinaus: Faelle, die die Tests oben offen lassen ---

  function rowOf(el: HTMLElement, name: string): HTMLElement {
    return Array.from(el.querySelectorAll<HTMLElement>(".row-lane")).find(
      (candidate) => candidate.querySelector(".row-label")?.textContent === name,
    )!;
  }

  function press(key: string): void {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }

  it("ohne waitingSince zaehlt jede Wartende als now, in der Reihenfolge der Seitenleiste", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.setSessionRecords("h1", [{ name: "a", status: "waiting" }, { name: "b", status: "waiting" }], Date.now());
    const { el } = mount(s);
    expect(laneNames(el)).toEqual(["a", "b"]);
    expect(laneTimes(el)).toEqual(["now", "now"]);
  });

  it("zeigt nur aktuell Wartende: ein veralteter Status steht nicht in der Spur", () => {
    const { s, el } = waiting({ a: 0 });
    expect(laneNames(el)).toEqual(["a"]);
    s.markStatusStale("h1");
    expect(el.querySelector(".sb-lane")).toBeNull();
  });

  it("solange der Fokus in der Spur ist, steht die Reihenfolge und er bleibt auf seiner Zeile; danach sortiert sie neu", () => {
    const { s, el, since } = waiting({ a: 20_000, b: 10_000 });
    rowOf(el, "b").focus();
    since.set(waitingKey(s.hosts[0].sessions[1]), NOW - 90_000);
    s.setHostExpanded("h1", false);
    expect(laneNames(el)).toEqual(["a", "b"]);
    // Die Seitenleiste hat die Zeile neu gebaut und den Fokus zurueckgeholt.
    expect(document.activeElement).toBe(rowOf(el, "b"));
    (document.activeElement as HTMLElement).blur();
    vi.advanceTimersByTime(1);
    expect(laneNames(el)).toEqual(["b", "a"]);
  });

  it("Show less klappt die Spur wieder auf fuenf Zeilen zu, der Fokus bleibt auf dem Knopf", () => {
    const { el } = waiting({ a: 7, b: 6, c: 5, d: 4, e: 3, f: 2, g: 1 });
    el.querySelector<HTMLButtonElement>(".row-lane-more")!.focus();
    el.querySelector<HTMLButtonElement>(".row-lane-more")!.click();
    expect(laneNames(el)).toHaveLength(7);
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe("lane:more:toggle");
    el.querySelector<HTMLButtonElement>(".row-lane-more")!.click();
    expect(laneNames(el)).toEqual(["a", "b", "c", "d", "e"]);
    expect(el.querySelector(".row-lane-more")?.textContent).toBe("+2 more");
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe("lane:more:toggle");
  });

  it("die Pfeiltasten laufen von der Spur in die Hostliste und zurueck", () => {
    const { el } = waiting({ a: 20_000, b: 10_000 });
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".sb-list .ab-row"));
    expect(rows.slice(0, 2).map((row) => row.classList.contains("row-lane"))).toEqual([true, true]);
    expect(rows[2].classList.contains("row-host")).toBe(true);
    // Ueber den Bezeichner, nicht ueber das Element: verlaesst der Fokus die
    // Spur, sortiert sie neu und die Seitenleiste baut die Zeilen neu.
    const focused = () => (document.activeElement as HTMLElement).dataset.focusKey;
    rows[0].focus();
    press("ArrowDown");
    expect(focused()).toBe("lane:h1/b:row");
    press("ArrowDown");
    expect(focused()).toBe("host:h1:row");
    press("ArrowUp");
    expect(focused()).toBe("lane:h1/b:row");
    press("Home");
    expect(focused()).toBe("lane:h1/a:row");
  });

  it("mit dem Fokus auf einer Zeile der Spur gehoert die Knopfleiste dem Host dieser Zeile", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["x"]));
    s.upsertHost(host("h2", ["a"]));
    s.setSessionRecords("h2", [{ name: "a", status: "waiting" }], Date.now());
    const { el } = mount(s);
    const activeHosts = () =>
      Array.from(el.querySelectorAll<HTMLElement>(".sb-host-block--active .row-host")).map((row) => row.dataset.hostId);
    const barStops = (hostId: string) =>
      Array.from(
        el.querySelector<HTMLElement>(`[data-host-id="${hostId}"]`)!.parentElement!.querySelectorAll<HTMLElement>(
          ".host-actions button",
        ),
      ).filter((button) => button.tabIndex === 0);
    // Ohne Fokus in der Liste: der Halt liegt auf der ersten Hostzeile.
    expect(activeHosts()).toEqual(["h1"]);
    el.querySelector<HTMLElement>(".row-lane")!.focus();
    expect(activeHosts()).toEqual(["h2"]);
    expect(handles[handles.length - 1].activeHostId()).toBe("h2");
    expect(barStops("h2")).toHaveLength(1);
    expect(barStops("h1")).toHaveLength(0);
  });

  it("der Minutentakt laeuft nur, solange jemand wartet, und endet mit dem Abbau", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    expect(vi.getTimerCount()).toBe(0);
    s.setSessionRecords("h1", [{ name: "a", status: "waiting" }], Date.now());
    expect(vi.getTimerCount()).toBe(1);
    s.setSessionRecords("h1", [{ name: "a", status: "busy" }], Date.now());
    expect(el.querySelector(".sb-lane")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    s.setSessionRecords("h1", [{ name: "a", status: "waiting" }], Date.now());
    expect(vi.getTimerCount()).toBe(1);
    handles.pop()!.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wartet die Session der fokussierten Zeile nicht mehr, nimmt ihre Hostzeile den Fokus, und das Festhalten endet", () => {
    const { s, el, since } = waiting({ a: 20_000, b: 10_000, c: 5_000 });
    rowOf(el, "b").focus();
    // b hoert auf zu warten, c wartet laenger als alle -- die Seitenleiste
    // findet die Zeile von b nicht wieder; statt auf <body> geht der Fokus auf
    // die Hostzeile von b.
    since.set(waitingKey(s.hosts[0].sessions[2]), NOW - 90_000);
    s.setSessionRecords(
      "h1",
      [{ name: "a", status: "waiting" }, { name: "b", status: "busy" }, { name: "c", status: "waiting" }],
      Date.now(),
    );
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe("host:h1:row");
    // Der Fokus hat die Spur verlassen: sie sortiert gleich neu.
    expect(laneNames(el)).toEqual(["c", "a"]);
    vi.advanceTimersByTime(1);
    expect(laneNames(el)).toEqual(["c", "a"]);
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe("host:h1:row");
  });

  it("verschwindet '+n more' mit dem Fokus darauf, nimmt die Hostzeile den Fokus", () => {
    const { s, el } = waiting({ a: 6, b: 5, c: 4, d: 3, e: 2, f: 1 });
    el.querySelector<HTMLButtonElement>(".row-lane-more")!.focus();
    s.setSessionRecords(
      "h1",
      [...["a", "b", "c", "d", "e"].map((name) => ({ name, status: "waiting" })), { name: "f", status: "busy" }],
      Date.now(),
    );
    expect(el.querySelector(".row-lane-more")).toBeNull();
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe("host:h1:row");
  });

  it("leert sich die Spur mit dem Fokus darin, nimmt die Hostzeile der Zeile den Fokus", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["x"]));
    s.upsertHost(host("h2", ["a"]));
    s.setSessionRecords("h2", [{ name: "a", status: "waiting" }], Date.now());
    const { el } = mount(s);
    rowOf(el, "a").focus();
    s.setSessionRecords("h2", [{ name: "a", status: "busy" }], Date.now());
    expect(el.querySelector(".sb-lane")).toBeNull();
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe("host:h2:row");
  });

  it("die Spur ist eine benannte Gruppe; der Tooltip der Zeile sagt, was Klick und Strg+Klick tun (Spec §5.2)", () => {
    const { s, el } = waiting({ a: 0, b: 0 });
    const lane = el.querySelector(".sb-lane")!;
    expect([lane.getAttribute("role"), lane.getAttribute("aria-label")]).toEqual(["group", "Waiting sessions"]);
    expect(rowOf(el, "a").title).toBe("Click: open as a new terminal · Ctrl+click: replace the focused terminal");
    s.openSession("h1", "b");
    expect(rowOf(el, "b").title).toBe("Click: show its terminal");
  });
});

// UX-Spec §7.8: "Reload sessions" ist ein Icon-Knopf `refresh-cw` in der
// Aktionsleiste des Hosts; der Eintrag im ⋯-Menue entfaellt.
describe("mountSidebar: Reload sessions in der Aktionsleiste (UX-Spec §7.8)", () => {
  function reloadButton(el: HTMLElement, hostId: string): HTMLButtonElement {
    const block = el.querySelector(`[data-host-id="${hostId}"]`)!.parentElement as HTMLElement;
    const button = Array.from(block.querySelectorAll<HTMLButtonElement>(".host-actions button")).find(
      (b) => b.textContent === "Reload sessions",
    );
    if (!button) throw new Error(`reload button not found for ${hostId}`);
    return button;
  }

  it("ist ein Icon-Knopf mit refresh-cw, Tooltip und zugaenglichem Namen, ohne eigenen Tabstopp", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const button = reloadButton(el, "h1");
    expect(button.classList.contains("host-action-btn")).toBe(true);
    expect(button.title).toBe("Reload sessions");
    const box = button.querySelector<HTMLElement>(".icon-box")!;
    expect(box.dataset.icon).toBe("refresh-cw");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.querySelector("svg")).not.toBeNull();
    // Der Name ist versteckter Text: `textContent` und Ansage bleiben die
    // Beschriftung (wie an den Icon-Knoepfen der Sessionzeile).
    expect(button.querySelector(".ab-visually-hidden")!.textContent).toBe("Reload sessions");
    // Roving: den Halt vergibt allein `applyToolbarRoving`.
    expect(button.tabIndex).toBe(-1);
    // Direkt vor dem ⋯-Knopf.
    expect(button.nextElementSibling).toBe(moreButton(el, "h1"));
  });

  it("ruft onReloadSessions fuer den eigenen Host, nicht den erstbesten", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { el, h } = mount(s);
    reloadButton(el, "h2").click();
    expect(h.onReloadSessions).toHaveBeenCalledExactlyOnceWith("h2");
  });

  it("behaelt den Fokus ueber ein Neuzeichnen hinweg", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    reloadButton(el, "h1").focus();
    s.setSessions("h1", ["a", "b"]); // baut die Leiste neu
    expect(document.activeElement).toBe(reloadButton(el, "h1"));
  });

  // Fixrunde 1, F: an einem nicht verbundenen Host taete der Knopf nichts --
  // die Absage gehoert an den Knopf, wie bei "New session" (Task 16, Punkt E).
  it.each(["disconnected", "connecting", "failed"] as const)("ist am Host im Zustand %s deaktiviert", (hostState) => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: hostState, error: hostState === "failed" ? "boom" : null });
    const { el, h } = mount(s);
    const button = reloadButton(el, "h1");
    expect(button.disabled).toBe(true);
    button.click();
    expect(h.onReloadSessions).not.toHaveBeenCalled();

    s.setHostState("h1", "connected");
    expect(reloadButton(el, "h1").disabled).toBe(false);
  });

  // UX-Spec §5.3: solange die Steuerung nicht bereit ist, scheitert jedes
  // Neuladen an ihr. Die Absage gehoert an den Knopf wie am getrennten Host.
  it.each(["degraded", "reconnecting", "authentication_required"] as const)(
    "ist deaktiviert, solange die Steuerung %s ist", (control) => {
      const s = new AppState();
      s.upsertHost(host("h1"));
      s.setControlState("h1", { generation: 1, state: control, message: null });
      const { el, h } = mount(s);
      const button = reloadButton(el, "h1");
      expect(button.disabled).toBe(true);
      button.click();
      expect(h.onReloadSessions).not.toHaveBeenCalled();

      s.setControlState("h1", { generation: 2, state: "ready", message: null });
      expect(reloadButton(el, "h1").disabled).toBe(false);
    },
  );

  it("ist waehrend der Selbstreparatur der Steuerung deaktiviert", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setControlState("h1", { generation: 1, state: "degraded", message: null });
    s.setControlSelfRepairing("h1", true);
    const { el } = mount(s);
    expect(el.querySelector(".control-quiet")).not.toBeNull();
    expect(reloadButton(el, "h1").disabled).toBe(true);
  });
});

describe("mountSidebar und das Hostmenue", () => {
  function menu(): HTMLElement | null {
    return document.querySelector('[role="menu"]');
  }

  function items(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }

  it("zeigt in der Knopfleiste Umschalter, New session, Reload sessions und ⋯", () => {
    const s = new AppState();
    // `disconnected`, damit der Umschalter wirklich "Connect" zeigt: die
    // Vorgabe von `host()` ist "connected", und dort heisst derselbe Knopf
    // "Disconnect" (siehe `buildConnectToggle`). Geprueft werden soll die
    // AUFTEILUNG, nicht der Zustand -- die eindeutigere Beschriftung ist
    // dafuer die bessere Vorlage. Verglichen werden die zugaenglichen Namen:
    // seit UX-Spec §7.8 sind "New session" (`aria-label`) und "Reload
    // sessions" (versteckter Text) Icon-Knoepfe, der ⋯-Knopf heisst "More
    // actions".
    s.upsertHost({ ...host("h1"), state: "disconnected" });
    const { el } = mount(s);
    const actions = el.querySelector(".host-actions") as HTMLElement;
    const labels = Array.from(actions.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
    expect(labels).toEqual(["Connect", "New session", "Reload sessions", "More actions"]);
  });

  it("hat kein Menue im DOM, solange es geschlossen ist", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    mount(s);
    // Auf ABWESENHEIT gepruegt, nicht auf `hidden` oder eine CSS-Klasse:
    // `focusableElements` (main.ts) filtert allein ueber die
    // `hidden`-EIGENSCHAFT, ein per CSS verstecktes Menue mit einem
    // `tabindex="0"`-Eintrag waere also ein vierter Tabulator-Halt, den
    // der Zaehltest aus Task 4 nicht sehen koennte.
    expect(menu()).toBeNull();
  });

  it("oeffnet mit einem Klick auf ⋯ und bleibt offen", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    // Der oeffnende Klick blubbert bis zum Dokument -- und der
    // Ausserhalb-Horcher haengt zu diesem Zeitpunkt bereits dort (er wird
    // synchron angemeldet, nachgemessen). Dass das Menue trotzdem offen
    // bleibt, leistet allein die `.host-menu-btn`-Haelfte der Wache in
    // `onDocumentPointerDown`.
    expect(menu()).not.toBeNull();
    // "Reload sessions" ist seit UX-Spec §7.8 ein Knopf der Leiste, kein
    // Eintrag mehr.
    expect(items().map((i) => i.textContent)).toEqual(["Edit…", "Remove…"]);
  });

  it("haengt das Menue an die Seitenleiste, nicht in die Liste", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    const list = el.querySelector(".sb-list") as HTMLElement;
    // Nur so ueberlebt es das Neuzeichnen: `render()` ersetzt allein die
    // Kinder von `.sb-list`.
    expect(list.contains(menu())).toBe(false);
    expect(menu()!.parentElement).toBe(el.querySelector(".sidebar"));
  });

  it("ueberlebt das Neuzeichnen der Seitenleiste", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    s.setSessions("h1", ["a", "b"]); // synchrones Neuzeichnen
    expect(menu()).not.toBeNull();
    expect(items()).toHaveLength(2);
  });

  it("setzt aria-expanded und traegt einen zugaenglichen Namen", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const btn = moreButton(el, "h1");
    expect(btn.getAttribute("aria-label")).toBe("More actions");
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.querySelector("[aria-hidden='true']")?.textContent).toBe("⋯");
    btn.click();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("setzt aria-expanded nach einem Neuzeichnen erneut", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    s.setHostState("h1", "connecting"); // baut den Knopf neu
    // NEU abfragen: eine vor dem Neuzeichnen gemerkte Referenz zeigt auf
    // einen entfernten Knoten und truege das Attribut ohnehin.
    expect(moreButton(el, "h1").getAttribute("aria-expanded")).toBe("true");
  });

  it("meldet den richtigen Host beim Menueeintrag, nicht den erstbesten", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { el, h } = mount(s);
    moreButton(el, "h2").click();
    items().find((i) => i.textContent === "Edit…")!.click();
    expect(h.onEditHost).toHaveBeenCalledWith("h2");
    expect(h.onEditHost).not.toHaveBeenCalledWith("h1");
  });

  it("schliesst und gibt den Fokus zurueck, BEVOR der Eintrag handelt", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const h = handlers();
    let menuAtCall: Element | null = null;
    let activeAtCall: Element | null = null;
    h.onEditHost = vi.fn(() => {
      menuAtCall = menu();
      activeAtCall = document.activeElement;
    });
    const { el } = mount(s, h);
    const btn = moreButton(el, "h1");
    btn.click();
    items().find((i) => i.textContent === "Edit…")!.click();
    // `openDialog` merkt sich beim Oeffnen `document.activeElement` als
    // Rueckkehrziel (main.ts). Handelt der Eintrag VOR der Fokusrueckgabe,
    // merkt sich der Dialog einen Menueeintrag, den es dann nicht mehr gibt.
    expect(menuAtCall).toBeNull();
    expect(activeAtCall).toBe(btn);
  });

  it("schliesst bei Escape und fokussiert den ⋯-Knopf", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const btn = moreButton(el, "h1");
    btn.click();
    items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("laesst Escape NICHT bis zum Dokument durch", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const spy = vi.fn();
    document.addEventListener("keydown", spy);
    moreButton(el, "h1").click();
    items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.removeEventListener("keydown", spy);
    // main.ts haengt einen dauerhaften Dokument-Horcher, der eine maximierte
    // Kachel zurueckholt. Ohne `stopPropagation()` schloesse ein Escape das
    // Menue UND holte das Terminal ins Raster zurueck.
    expect(spy).not.toHaveBeenCalled();
  });

  it("gibt den Fokus auch nach einem Neuzeichnen auf den NEUEN ⋯-Knopf", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    s.setHostState("h1", "connecting"); // Knopf wird neu gebaut
    items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    // Eine gemerkte Elementreferenz zeigte hier auf einen entfernten Knoten;
    // `.focus()` darauf ist ein Nichts und der Fokus landete auf <body>.
    expect(document.activeElement).toBe(moreButton(el, "h1"));
  });

  it("schliesst bei einem Klick ausserhalb", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    moreButton(el, "h1").click();
    outside.click();
    expect(menu()).toBeNull();
  });

  // Rechts- und Mittelklick erzeugen kein `click`, der Horcher darauf sieht sie
  // nie. Ein Rechtsklick ins Terminal liesse dieses Menue sonst neben dem
  // Terminalmenue stehen (`terminal.ts` haelt die rechte Taste auch von
  // `auxclick` fern). Das Terminal stoppt sie an seinem Container in der
  // Capture-Phase -- das Hostmenue muss sie vorher sehen.
  it.each([1, 2])("schliesst bei einem Mausdruck mit Taste %i ausserhalb, auch wenn ein Vorfahre die Weitergabe stoppt", (button) => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const terminalLike = document.createElement("div");
    terminalLike.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    const inner = document.createElement("div");
    terminalLike.appendChild(inner);
    document.body.appendChild(terminalLike);
    moreButton(el, "h1").click();
    expect(menu()).not.toBeNull();

    inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button }));

    expect(menu()).toBeNull();
  });

  it("schliesst NICHT bei einem Rechtsklick im Menue oder auf dem ⋯-Knopf", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const btn = moreButton(el, "h1");
    btn.click();

    items()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));

    expect(menu()).not.toBeNull();
  });

  it("schliesst bei einem Mausdruck mit der linken Taste erst beim Klick, wie bisher", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    moreButton(el, "h1").click();

    // Die linke Taste erzeugt ein `click`; dessen Weg (samt Fokus zurueck an
    // den ⋯-Knopf) bleibt der einzige.
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(menu()).not.toBeNull();
    outside.click();
    expect(menu()).toBeNull();
  });

  it("schliesst NICHT bei einem Klick im Menue neben einem Eintrag", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    menu()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu()).not.toBeNull();
  });

  it("schliesst beim Bildlauf der Liste", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    const list = el.querySelector(".sb-list") as HTMLElement;
    // OHNE `bubbles`: `scroll` blubbert nicht. Ein blubberndes Kunstereignis
    // am Dokument bestuende auch gegen einen Horcher am Fenster -- dieses
    // hier erreicht ausschliesslich Horcher an genau diesem Element.
    list.dispatchEvent(new Event("scroll"));
    expect(menu()).toBeNull();
  });

  it("schliesst bei einer Groessenaenderung des Fensters", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    window.dispatchEvent(new Event("resize"));
    expect(menu()).toBeNull();
  });

  it("schliesst, wenn der Host verschwindet, und fokussiert nichts", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { el } = mount(s);
    moreButton(el, "h2").click();
    s.removeHost("h2");
    expect(menu()).toBeNull();
    // Kein geratener Nachbar -- dieselbe Regel wie bei der bestehenden
    // Fokusrettung, die aus demselben Grund NICHTS fokussiert.
    expect(el.contains(document.activeElement)).toBe(false);
  });

  it("schliesst bei Tab, ohne den Tabulator zu verschlucken", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    items()[0].dispatchEvent(ev);
    expect(menu()).toBeNull();
    // jsdom bewegt den Fokus bei Tab nicht -- dass der Tabulator
    // weiterzieht, ist so nicht pruefbar. `defaultPrevented` ist der eine
    // maschinell sichtbare Unterschied zu der Umsetzung, die ihn im echten
    // Browser einsperren wuerde.
    expect(ev.defaultPrevented).toBe(false);
  });

  it("oeffnet per Tastatur mit dem Fokus auf dem ersten bzw. letzten Eintrag", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const btn = moreButton(el, "h1");
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items()[0]);
    items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items()[1]);
  });

  it("wandert mit den Pfeiltasten umlaufend durch die Eintraege", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    moreButton(el, "h1").click();
    const press = (key: string) =>
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    // Zwei Eintraege seit UX-Spec §7.8: jede Taste muss den Fokus bewegen,
    // sonst bewiese die Zusicherung danach nichts.
    press("End");
    expect(document.activeElement).toBe(items()[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(items()[1]);
    press("Home");
    expect(document.activeElement).toBe(items()[0]);
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    // Genau EIN Eintrag ist ansteuerbar.
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
  });

  it("meldet alle VIER Horcher an Dokument, Fenster und Liste beim dispose() wieder ab", () => {
    // AN `EventTarget.prototype`, NICHT an `document`: `vi.spyOn(document,
    // …)` legt eine EIGENE Eigenschaft auf dem `document`-Objekt an.
    // `window.addEventListener` und `list.addEventListener` loesen ueber
    // ihre eigenen Prototypen auf und wurden davon nie aufgezeichnet -- die
    // Schleife unten lief fuer `resize` und `scroll` also leer, ausgerechnet
    // fuer die zwei, die `el.replaceChildren()` ueberleben.
    //
    // Und ZUSAETZLICH an `window`, weil der Prototyp allein nicht genuegt:
    // `window` ist hier gar kein jsdom-`Window`, sondern Nodes `globalThis`
    // -- VITEST kopiert die Eigenschaften des jsdom-Fensters beim Aufbau der
    // Umgebung dorthin. `addEventListener` liegt damit als EIGENE
    // Eigenschaft auf dem globalen Objekt, und der Aufruf laeuft nicht ueber
    // `EventTarget.prototype`. Nachgemessen in genau dieser Umgebung:
    // `window === globalThis` ist `true`,
    // `Object.getOwnPropertyNames(window).includes("addEventListener")` ist
    // `true`, und auf dem Prototyp von `window` steht der Name NICHT.
    // (Der Satz schrieb das frueher jsdom zu; in echtem jsdom ist `window`
    // eine `Window`-Instanz und die Methode kaeme vom Prototyp.) Ohne diese
    // zweite Attrappe fehlte ausgerechnet `resize` -- der Horcher, der eine
    // entsorgte Seitenleiste am laengsten ueberlebt.
    //
    // Jede Attrappe reicht an IHR eigenes Original durch, nicht an das des
    // Prototyps: jsdoms `window`-Methode ist nicht dieselbe Funktion, und
    // `EventTarget.prototype.removeEventListener.call(window, …)` wirft
    // ("called on an object that is not a valid instance of EventTarget").
    type Rec = { target: EventTarget; type: string; fn: unknown; capture: boolean };
    type Listen = (type: string, fn: unknown, opts?: unknown) => void;
    const added: Rec[] = [];
    const removed: Rec[] = [];
    // Die Capture-Phase gehoert zum Schluessel einer Anmeldung: ein Abmelden
    // ohne sie traefe einen Capture-Horcher nicht und liesse ihn stehen.
    const captureOf = (opts: unknown): boolean =>
      typeof opts === "boolean" ? opts : Boolean((opts as { capture?: boolean } | undefined)?.capture);
    function passThrough(into: Rec[], real: Listen): Listen {
      return function (this: EventTarget, type: string, fn: unknown, opts?: unknown): void {
        into.push({ target: this, type, fn, capture: captureOf(opts) });
        // DURCHGEREICHT, nicht verschluckt: sonst haenge nie ein echter
        // Horcher, und `closeMenu`s Abmelden liefe gegen nichts.
        real.call(this, type, fn, opts);
      };
    }
    const realProtoAdd = EventTarget.prototype.addEventListener as unknown as Listen;
    const realProtoRemove = EventTarget.prototype.removeEventListener as unknown as Listen;
    const realWindowAdd = window.addEventListener as unknown as Listen;
    const realWindowRemove = window.removeEventListener as unknown as Listen;

    const s = new AppState();
    s.upsertHost(host("h1"));
    const el = document.createElement("div");
    document.body.appendChild(el);
    const handle = mountSidebar(el, s, handlers());
    const list = el.querySelector(".sb-list") as HTMLElement;

    // ERST NACH dem Mount aufgezeichnet: gemeint sind die Horcher, die das
    // OEFFNEN anmeldet. Die dauerhaften Horcher an `list` aus `mountSidebar`
    // gehoeren nicht dazu -- sie werden absichtlich nie abgemeldet.
    const spies = [
      vi.spyOn(EventTarget.prototype, "addEventListener")
        .mockImplementation(passThrough(added, realProtoAdd) as never),
      vi.spyOn(EventTarget.prototype, "removeEventListener")
        .mockImplementation(passThrough(removed, realProtoRemove) as never),
      vi.spyOn(window, "addEventListener")
        .mockImplementation(passThrough(added, realWindowAdd) as never),
      vi.spyOn(window, "removeEventListener")
        .mockImplementation(passThrough(removed, realWindowRemove) as never),
    ];

    try {
      moreButton(el, "h1").click();
      handle.dispose();
    } finally {
      // UNBEDINGT -- `EventTarget.prototype` und `window` sind global.
      // Bliebe eine Attrappe nach einer fehlgeschlagenen Zusicherung stehen,
      // liefe `afterEach` (und jeder Test danach) in sie hinein, und das
      // Fehlerbild haette mit der Ursache nichts mehr zu tun.
      for (const spy of spies) spy.mockRestore();
    }

    // Nur die Ziele, die das Raeumen von `el` ueberdauern -- an ihnen haengt
    // die Gefahr: ein zurueckgelassener Horcher schliesst spaeter das Menue
    // eines ANDEREN Tests, die Sorte Fehler, die als
    // Reihenfolgeabhaengigkeit auftaucht.
    const survivors: EventTarget[] = [document, window, list];
    const relevant = added.filter((r) => survivors.includes(r.target));
    // Erst die Zahl: eine Schleife ueber eine leere Menge ist gruen, ohne
    // etwas geprueft zu haben -- genau der Fehler, den diese Fassung ersetzt.
    expect(relevant.map((r) => r.type).sort()).toEqual(["click", "mousedown", "resize", "scroll"]);
    for (const rec of relevant) {
      // Ueber Identitaet, nicht ueber Tiefenvergleich: `target` ist ein
      // DOM-Knoten, und verglichen werden soll genau DIESE Anmeldung.
      expect(
        removed.some(
          (r) => r.target === rec.target && r.type === rec.type && r.fn === rec.fn && r.capture === rec.capture,
        ),
      ).toBe(true);
    }
  });
});

// =====================================================================
// Entwurf §3: die Liste ist EINE Tabulatorstation mit Roving-Tabindex.
// Vorher trug kein Element in `sidebar.ts` ein `tabindex` -- bei drei Hosts
// mit zusammen 60 Sessions waren das ueber 70 Haltestellen.
// =====================================================================

describe("mountSidebar: die Liste als ein Tabstopp", () => {
  function rows(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>(".sb-list .ab-row"));
  }
  function press(key: string): void {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }

  it("gibt genau EINER Zeile den Tabstopp, allen anderen -1", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    const { el } = mount(s);
    const r = rows(el);
    expect(r.filter((x) => x.tabIndex === 0)).toHaveLength(1);
    expect(r.filter((x) => x.tabIndex === -1)).toHaveLength(r.length - 1);
  });

  it("nimmt auch den Schliessknopf einer offenen Session aus der Reihenfolge", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    const { el } = mount(s);
    const close = el.querySelector(".session-close-btn") as HTMLButtonElement;
    expect(close.tabIndex).toBe(-1);
  });

  it("wandert mit Hoch/Runter ueber Host- UND Sessionzeilen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.upsertHost(host("h2", ["c"]));
    const { el } = mount(s);
    const r = rows(el);
    r[0].focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(r[1]); // Session a
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(r[3]); // Hostzeile h2 -- Grenze ueberschritten
    press("End");
    expect(document.activeElement).toBe(r[r.length - 1]);
    press("Home");
    expect(document.activeElement).toBe(r[0]);
  });

  it("klappt mit Rechts auf und steigt mit einem zweiten Rechts hinein", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["a"]), expanded: false });
    const { el } = mount(s);
    rows(el)[0].focus();
    press("ArrowRight");
    expect((el.querySelector('[data-host-id="h1"]') as HTMLElement).getAttribute("aria-expanded")).toBe("true");
    press("ArrowRight");
    expect((document.activeElement as HTMLElement).classList.contains("row-session")).toBe(true);
  });

  it("klappt mit Links zu und tut auf einer zugeklappten Zeile nichts", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    const row = rows(el)[0];
    row.focus();
    press("ArrowLeft");
    expect((el.querySelector('[data-host-id="h1"]') as HTMLElement).getAttribute("aria-expanded")).toBe("false");
    const before = document.activeElement;
    press("ArrowLeft");
    expect(document.activeElement).toBe(before);
  });

  // UX-Spec §7.1: aufgeklappte Hosts werden gespeichert -- also muss jeder
  // Wechsel ueber AppState gehen, damit der Arbeitsplatz davon erfaehrt.
  it("klappt per Klick und Pfeiltasten ueber AppState auf und zu", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["a"]), expanded: false });
    const { el } = mount(s);
    const notified = vi.fn();
    s.subscribe(notified);

    rows(el)[0].click();
    expect(s.hosts[0].expanded).toBe(true);
    expect(notified).toHaveBeenCalledTimes(1);

    rows(el)[0].focus();
    press("ArrowLeft");
    expect(s.hosts[0].expanded).toBe(false);
    press("ArrowRight");
    expect(s.hosts[0].expanded).toBe(true);
    expect(notified).toHaveBeenCalledTimes(3);
    // Der Fokus bleibt auf der Hostzeile, obwohl das Neuzeichnen nun aus der
    // Benachrichtigung kommt.
    expect((document.activeElement as HTMLElement).dataset.hostId).toBe("h1");
  });

  it("steigt mit Rechts in den Schliessknopf und mit Links zurueck", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    const { el } = mount(s);
    const sessionRow = rows(el).find((r) => r.classList.contains("row-session"))!;
    sessionRow.focus();
    press("ArrowRight");
    expect((document.activeElement as HTMLElement).classList.contains("session-close-btn")).toBe(true);
    press("ArrowLeft");
    expect(document.activeElement).toBe(sessionRow);
  });

  // Bis B3 tat `→` auf einer geschlossenen Session NICHTS -- es gab dort
  // keinen Knopf. Seit B3 gibt es einen: "End session" erscheint unabhaengig
  // von `session.open`, und das ist der Punkt. Die verwaisten Sessions, um
  // die es geht, sind nie offen.
  it("erreicht auf einer GESCHLOSSENEN Session den Beenden-Knopf und zurueck", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    const sessionRow = rows(el).find((r) => r.classList.contains("row-session"))!;
    sessionRow.focus();
    press("ArrowRight");
    expect((document.activeElement as HTMLElement).classList.contains("session-kill-btn")).toBe(
      true,
    );
    press("ArrowLeft");
    expect(document.activeElement).toBe(sessionRow);
  });

  // Und auf einer OFFENEN Session sind es zwei Knoepfe. Die Reihenfolge ist
  // eine Entscheidung, keine Nebensache: der zerstoererische steht hinten,
  // `→` von der Zeile aus darf nicht zuerst auf ihm landen.
  it("laeuft auf einer OFFENEN Session ueber beide Knoepfe, den zerstoererischen zuletzt", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    const { el } = mount(s);
    const sessionRow = rows(el).find((r) => r.classList.contains("row-session"))!;
    sessionRow.focus();

    press("ArrowRight");
    const first = document.activeElement as HTMLElement;
    expect(first.classList.contains("session-close-btn")).toBe(true);

    press("ArrowRight");
    expect((document.activeElement as HTMLElement).classList.contains("session-kill-btn")).toBe(
      true,
    );

    press("ArrowLeft");
    expect(document.activeElement).toBe(first);
    press("ArrowLeft");
    expect(document.activeElement).toBe(sessionRow);
  });

  it("beendet eine Session erst nach der Rueckfrage", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el, h } = mount(s);

    const killBtn = () => el.querySelector<HTMLButtonElement>(".session-kill-btn")!;
    killBtn().click();

    // Zugesichert wird, dass die AKTION noch nicht gefallen ist -- nicht
    // nur, dass eine Leiste erschienen ist. Ein Knopf, der fragt UND
    // ausfuehrt, saehe an der Leiste allein richtig aus.
    expect(h.onKillSession).not.toHaveBeenCalled();
    const bar = el.querySelector(".session-confirm-kill");
    expect(bar).not.toBeNull();
    // Der Satz muss sagen, was wirklich passiert -- "Close terminal"
    // daneben schliesst ausdruecklich nur die Ansicht.
    expect(bar!.textContent).toContain("terminated on the host");

    const confirm = el.querySelector<HTMLButtonElement>(
      ".session-confirm-kill .host-confirm-btn-danger",
    )!;
    confirm.click();
    expect(h.onKillSession).toHaveBeenCalledWith("h1", "a");
    expect(el.querySelector(".session-confirm-kill")).toBeNull();
  });

  it("laesst beim Abbrechen alles stehen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el, h } = mount(s);

    el.querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    const cancel = el.querySelector<HTMLButtonElement>(
      ".session-confirm-kill .host-confirm-btn:not(.host-confirm-btn-danger)",
    )!;
    cancel.click();

    expect(h.onKillSession).not.toHaveBeenCalled();
    expect(el.querySelector(".session-confirm-kill")).toBeNull();
    // Die Zeile steht noch, und der Fokus kam dorthin zurueck, von wo die
    // Rueckfrage kam -- sonst laege er auf <body>.
    expect(el.querySelectorAll(".row-session")).toHaveLength(1);
    expect(
      (document.activeElement as HTMLElement).classList.contains("session-kill-btn"),
    ).toBe(true);
  });

  it("springt per Erstbuchstabe, ab dem Eintrag NACH dem aktuellen, umlaufend", () => {
    const s = new AppState();
    s.upsertHost(host("alpha"));
    s.upsertHost(host("beta"));
    s.upsertHost(host("bravo"));
    const { el } = mount(s);
    rows(el)[0].focus();
    press("b");
    expect((document.activeElement as HTMLElement).textContent).toContain("beta");
    press("b");
    expect((document.activeElement as HTMLElement).textContent).toContain("bravo");
    press("b");
    expect((document.activeElement as HTMLElement).textContent).toContain("beta");
    press("B"); // Gross/Klein gleich
    expect((document.activeElement as HTMLElement).textContent).toContain("bravo");
  });

  it("nimmt genau EIN Zeichen, ohne Puffer", () => {
    // Zwei Tastendruecke, und der dritte Host ist der Zeuge: die fruehere
    // Fassung drueckte NUR "r" aus dem Stand, gegen "beta"/"bravo". Eine
    // gepufferte Umsetzung haette dort den Puffer "r" gehalten, keinen
    // Treffer gefunden und waere ebenfalls auf "beta" stehen geblieben --
    // buchstabengleicher Ausgang, also kein Zeuge. Ein einziger
    // Tastendruck kann gepuffert und ungepuffert gar nicht unterscheiden.
    const s = new AppState();
    s.upsertHost(host("beta"));
    s.upsertHost(host("bravo"));
    s.upsertHost(host("rho"));
    const { el } = mount(s);
    rows(el)[0].focus();
    press("b");
    // TRAGEND, keine Zwischenbeobachtung: erst dieser Sprung stellt den
    // Zeiger auf "bravo". Ohne ihn liefe der zweite Druck wieder ab "beta"
    // und faende "rho" auch mit Puffer.
    expect((document.activeElement as HTMLElement).textContent).toContain("bravo");
    press("r");
    // Ungepuffert: "r" -> "rho". Gepuffert ergaebe die Folge "br" -- und
    // damit bliebe der Zeiger auf "bravo" stehen, denn "bravo" ist der
    // EINZIGE Treffer auf "br" und der Umlauf findet den aktuellen Eintrag
    // wieder. (Der Kommentar behauptete hier frueher, kein Host beginne mit
    // "br"; "bravo" tut es. Die Schlussfolgerung stimmt trotzdem, nur ueber
    // den Umlauf statt ueber einen fehlenden Treffer.) Und ein Puffer
    // braeuchte einen Zeitgeber, der ihn wieder leert -- Designsystem 5.5
    // laesst genau EINEN entprellten Pfad zu, diesen nicht.
    expect((document.activeElement as HTMLElement).textContent).toContain("rho");
  });

  it("laesst die Liste nach dem Entfernen des Zeiger-Eintrags ansteuerbar", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { el } = mount(s);
    rows(el)[1].focus(); // Zeiger auf h2
    s.removeHost("h2");
    // Der ZEIGER faellt auf einen Ueberlebenden -- sonst haette die Liste
    // gar keinen Tabstopp mehr und waere mit dem Tabulator unerreichbar.
    expect(el.querySelector('.sb-list [tabindex="0"]')).not.toBeNull();
    // Der FOKUS folgt ihm ausdruecklich NICHT (bestehende Regel, mit
    // "Remove in Reichweite" begruendet).
    expect(el.contains(document.activeElement)).toBe(false);
  });

  it("uebernimmt eine von aussen fokussierte Zeile als Zeiger", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    // Ein DRITTER Host, damit unter der betretenen Zeile ueberhaupt noch
    // eine liegt: `moveListTo` begrenzt und laeuft nicht um (wie
    // `directory-tree.ts`, anders als das Menue), auf der letzten Zeile
    // waere `↓` also folgenlos und die Zusicherung unten unhaltbar.
    s.upsertHost(host("h3"));
    const { el } = mount(s);
    const r = rows(el);
    r[1].focus(); // wie `focusSidebar()` es tut: ohne Ruecksicht auf tabindex
    // DIE tragende Zusicherung: ohne den `focusin`-Abgleich bliebe der
    // Tabstopp auf h1, waehrend der Fokus auf h2 steht -- und das naechste
    // Neuzeichnen gaebe ihn dorthin zurueck.
    expect(r[1].tabIndex).toBe(0);
    press("ArrowDown");
    // Bestaetigt nur, dass die Liste ab der BETRETENEN Zeile weiterwandert.
    expect(document.activeElement).not.toBe(r[1]);
  });
});

// =====================================================================
// Entwurf §3.2/§3.3: die Knopfleiste des BESITZENDEN Hosts ist der zweite
// Halt. Nach Task 3 war die Liste ein Halt, aber jede `.host-actions` trug
// noch drei -- das Drei-Halte-Versprechen ist diese Gruppe.
// =====================================================================

describe("mountSidebar: die Knopfleiste als zweiter Tabstopp", () => {
  /** Der Selektor aus `main.ts`s `focusableElements`, abzueglich dessen, was
   * `tabindex="-1"` traegt. NICHT ueber `[tabindex="0"]` gezaehlt: ein
   * `<button>` OHNE `tabindex`-Attribut ist ein Halt, matcht diesen Selektor
   * aber nicht -- der Zaehler meldete 3, waehrend die echte Reihenfolge 10
   * lang ist. */
  function tabStops(el: HTMLElement): HTMLElement[] {
    const candidates = Array.from(
      el.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    // Verborgenes ist kein Halt -- etwa "Copy diagnostics", bis "Details"
    // es aufklappt (UX-Spec §5.7).
    return candidates.filter((c) => c.tabIndex !== -1 && !c.closest("[hidden]"));
  }

  it("hat bei gesunden Hosts genau vier Haltestellen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.upsertHost(host("h2", ["c"]));
    s.openSession("h1", "a"); // erzeugt einen Schliessknopf, der -1 tragen muss
    const { el } = mount(s);
    const stops = tabStops(el);
    expect(stops).toHaveLength(4);
    // Die Zahl allein ist blind dafuer, WELCHE Leiste den Halt traegt --
    // eine Umsetzung, die ihn fest an den ersten Host haengt, zaehlt auch 4.
    // Seit Aufgabe 8 steht der Add-Knopf im Kopf, VOR dem Zahnrad (UI v2
    // §7.2) -- die zwei Kopfknoepfe sind damit die ersten beiden Halte. Der
    // Knopf ist nur umgezogen, die Zahl bleibt darum 4.
    expect(stops[0].classList.contains("sb-btn")).toBe(true); // Kopf
    expect(stops[1].classList.contains("sb-head-btn")).toBe(true);
    expect(stops[2].classList.contains("ab-row")).toBe(true);
    expect(stops[3].closest(".host-actions")).not.toBeNull();
  });

  it("gibt den Halt der Leiste des Hosts, zu dem die aktuelle Zeile gehoert", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2", ["b"]));
    const { el } = mount(s);
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".sb-list .ab-row"));
    const sessionOfH2 = rows[3];
    sessionOfH2.focus();
    const blocks = Array.from(el.querySelectorAll<HTMLElement>(".host-actions"));
    // Eine SESSIONzeile zaehlt zu ihrem Host.
    expect(tabStops(blocks[1])).toHaveLength(1);
    expect(tabStops(blocks[0])).toHaveLength(0);
    rows[0].focus();
    expect(tabStops(blocks[0])).toHaveLength(1);
    expect(tabStops(blocks[1])).toHaveLength(0);
  });

  it("wandert mit Links/Rechts durch die Knopfleiste", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const actions = el.querySelector(".host-actions") as HTMLElement;
    const buttons = Array.from(actions.querySelectorAll("button"));
    buttons[0].focus();
    const press = (key: string) =>
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    press("ArrowRight");
    expect(document.activeElement).toBe(buttons[1]);
    // Der letzte ist der ⋯-Knopf, hinter "Reload sessions" (UX-Spec §7.8).
    press("End");
    expect(document.activeElement).toBe(buttons[3]);
    press("Home");
    expect(document.activeElement).toBe(buttons[0]);
  });

  // Die zwei Haelften des gemerkten Platzes INNERHALB einer Leiste (der
  // besitzende Host wird dagegen nie gemerkt, sondern abgeleitet). Ohne
  // Zeugen waere beides ungedeckt: ein "nie zuruecksetzen" truege den Platz
  // ueber Hosts hinweg, ein "bei jedem Neuzeichnen zuruecksetzen" vergaesse
  // ihn dauernd -- `render()` laeuft bei JEDER Zustandsaenderung.
  it("merkt sich den Platz in der Leiste ueber ein Neuzeichnen hinweg", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const actions = () => el.querySelector(".host-actions") as HTMLElement;
    const buttons = () => Array.from(actions().querySelectorAll<HTMLElement>("button"));
    buttons()[0].focus();
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons()[3]);

    s.setHostState("h1", "connecting"); // baut die ganze Leiste neu

    // NEU abgefragt: die alten Knoepfe sind aus dem Dokument entfernt.
    const stops = tabStops(actions());
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(buttons()[3]);
  });

  it("faengt beim Hostwechsel in der neuen Leiste wieder beim ersten Knopf an", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { el } = mount(s);
    const blocks = () => Array.from(el.querySelectorAll<HTMLElement>(".host-actions"));
    const buttonsOf = (b: HTMLElement) => Array.from(b.querySelectorAll<HTMLElement>("button"));
    buttonsOf(blocks()[0])[0].focus();
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttonsOf(blocks()[0])[3]);

    // Die Hostzeile von h2 -- der besitzende Host wechselt.
    Array.from(el.querySelectorAll<HTMLElement>(".sb-list .ab-row"))[1].focus();

    const stops = tabStops(blocks()[1]);
    expect(stops).toHaveLength(1);
    // Die scharfe Haelfte: ohne den Ruecksetzer ueberlebte die 3 den Wechsel
    // und der Halt saesse in der neuen Leiste auf dem ⋯-Knopf.
    expect(stops[0]).toBe(buttonsOf(blocks()[1])[0]);
  });

  // Abschlussreview (Critical): `moveToolbarTo` begrenzte gegen die
  // FOKUSSIERTE Leiste, `applyToolbarRoving` fokussierte anschliessend die
  // des BESITZENDEN Hosts -- zwei Quellen fuer dieselbe Frage. Wo sie
  // auseinanderliefen, sprang der Fokus zum falschen Host, und dort liegt
  // Connect/Disconnect einen Knopf neben "New session".
  //
  // Der Weg dorthin ist alltaeglich und braucht keine Tastatur: das Menue
  // eines Hosts oeffnen und mit Escape schliessen. `closeMenu` gibt den
  // Fokus an dessen `⋯`-Knopf, ohne den Zeiger der LISTE zu bewegen -- der
  // steht danach immer noch beim ersten Host.
  it("bleibt mit Links in der Leiste des Hosts, dessen Knopf den Fokus hat", () => {
    const s = new AppState();
    // h1 mit Session, und der Zeiger startet auf deren SESSIONzeile: der
    // schaerfere Ausgangspunkt. Er nimmt zusaetzlich den Weg durch
    // `setRovingKey`s Ruecksetzer mit (der besitzende Host wechselt von h1
    // auf h2, `toolbarIndex` faellt dabei auf 0 und muss danach auf den
    // uebernommenen Platz gesetzt werden -- die Reihenfolge im Abgleich).
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2"));
    const { el } = mount(s);
    const sessionOfH1 = Array.from(el.querySelectorAll<HTMLElement>(".sb-list .ab-row"))
      .find((r) => r.classList.contains("row-session"))!;
    sessionOfH1.focus();
    // Vorbedingung: der Zeiger der Liste steht bei h1 -- sonst pruefte der
    // Test einen Fall, in dem die zwei Quellen ohnehin dasselbe sagen. Eine
    // Sessionzeile zaehlt zu ihrem Host (§3.3), h1s Leiste traegt den Halt.
    const blocks = Array.from(el.querySelectorAll<HTMLElement>(".host-actions"));
    expect(blocks[0].querySelector('[tabindex="0"]')).not.toBeNull();
    expect(blocks[1].querySelector('[tabindex="0"]')).toBeNull();

    moreButton(el, "h2").click();
    document.querySelector<HTMLElement>('[role="menuitem"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    // Der Fokus steht jetzt auf h2s `⋯`-Knopf (`closeMenu` gibt ihn zurueck).
    expect(document.activeElement).toBe(moreButton(el, "h2"));

    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    );

    // Ueber den HOST gepruegt, nicht ueber die Beschriftung: der linke
    // Nachbar des ⋯-Knopfs ("Reload sessions" seit UX-Spec §7.8) steht an
    // beiden Hosts, und der Host ist hier die ganze Aussage.
    const landed = document.activeElement as HTMLElement;
    expect(landed.closest(".sb-host-block")!.querySelector(".row-host")!
      .getAttribute("data-host-id")).toBe("h2");
    expect(landed.textContent).toBe("Reload sessions");
  });

  // Die Kehrseite des Abgleichs: er darf den Zeiger NUR bei einem echten
  // Hostwechsel bewegen. Eine Sessionzeile zaehlt zu ihrem Host (§3.3) --
  // wer von ihr aus kurz in die Knopfleiste und zurueckgeht, muss dort
  // wieder herauskommen, wo er losgegangen ist.
  it("laesst den Zeiger auf der Sessionzeile, wenn der Fokus in die Leiste DESSELBEN Hosts geht", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    const sessionRow = Array.from(el.querySelectorAll<HTMLElement>(".sb-list .ab-row"))
      .find((r) => r.classList.contains("row-session"))!;
    sessionRow.focus();
    expect(sessionRow.tabIndex).toBe(0);

    const actions = el.querySelector(".host-actions") as HTMLElement;
    Array.from(actions.querySelectorAll<HTMLElement>("button"))[1].focus();

    // Der Zeiger der LISTE steht unveraendert auf der Sessionzeile ...
    expect(sessionRow.tabIndex).toBe(0);
    // ... und der Platz IN der Leiste ist trotzdem uebernommen worden.
    expect(tabStops(actions)).toEqual([
      Array.from(actions.querySelectorAll<HTMLElement>("button"))[1],
    ]);
  });

  it("laesst die Bedienelemente eines fehlgeschlagenen Hosts als eigene Halte", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "failed", error: "agent unavailable", errorCode: "auth_rejected" });
    const { el } = mount(s);
    // Agent-Host (Vorgabe der `host()`-Fabrik) nach einem Anmeldefehler:
    // Passwortfeld + Retry + Details; "Copy diagnostics" erscheint erst mit
    // Details (UX-Spec §5.7).
    // Gesamtreview M0 (Befund 1): das Passwortfeld gilt seither auch fuer
    // `authKind === "agent"` (ein Host ohne gespeicherte Anmeldeart und ohne
    // `key_path` gilt als "agent", das trifft auch Passwort-Hosts von vor
    // Task 8).
    expect(tabStops(el)).toHaveLength(4 + 3);
  });

  it("zaehlt bei einem fehlgeschlagenen Schluesselhost das Passphrasenfeld mit", () => {
    const s = new AppState();
    s.upsertHost({
      ...host("h1"),
      state: "failed",
      error: "bad passphrase",
      errorCode: "passphrase_required",
      keyPath: "/home/m/.ssh/id_ed25519",
      authKind: "key",
    });
    const { el } = mount(s);
    expect(tabStops(el)).toHaveLength(4 + 3);
  });

  it("zaehlt nach einem Netzfehler nur Retry und Details", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "failed", error: "SSH connection timed out.", errorCode: "connect_timeout" });
    const { el } = mount(s);
    expect(tabStops(el)).toHaveLength(4 + 2);
  });
});

// =====================================================================
// Task 5: "Remove…" fragt in der Zeile nach, statt sofort zu entfernen.
// Die Leiste haengt am Menueeintrag und ist die eine Ausnahme von der Regel
// aus §1.6 (schliessendes Menue gibt den Fokus an den ⋯-Knopf zurueck).
// =====================================================================

describe("mountSidebar: Remove mit Rueckfrage", () => {
  function openConfirm(el: HTMLElement, hostId: string): HTMLElement {
    moreButton(el, hostId).click();
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((i) => i.textContent === "Remove…")!.click();
    return el.querySelector(".host-confirm-remove") as HTMLElement;
  }

  it("oeffnet statt sofort zu entfernen und nennt den Host beim Namen", () => {
    const s = new AppState();
    s.upsertHost(host("vm-build"));
    const { el, h } = mount(s);
    const bar = openConfirm(el, "vm-build");
    expect(h.onRemoveHost).not.toHaveBeenCalled();
    expect(bar.textContent).toContain("Remove vm-build?");
    // Pflicht, nicht Zierde: "Remove" trennt die Verbindung und entfernt den
    // Eintrag, es beendet KEINE tmux-Session.
    expect(bar.textContent).toContain("Sessions on the host keep running.");
  });

  it("setzt den Fokus auf Cancel", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const bar = openConfirm(el, "h1");
    const cancel = Array.from(bar.querySelectorAll("button")).find((b) => b.textContent === "Cancel");
    // Ohne das waere die Rueckfrage sichtbar, aber mit der Tastatur
    // unbeantwortbar: ihre Knoepfe tragen `tabindex="-1"`.
    expect(document.activeElement).toBe(cancel);
  });

  it("steht ueber der Hinweisleiste eines fehlgeschlagenen Hosts", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "failed", error: "nope" });
    const { el } = mount(s);
    openConfirm(el, "h1");
    const block = el.querySelector('[data-host-id="h1"]')!.parentElement as HTMLElement;
    const kids = Array.from(block.children);
    const bar = kids.findIndex((c) => c.classList.contains("host-confirm-remove"));
    const notice = kids.findIndex((c) => c.classList.contains("host-notice"));
    // Vorbedingung, sonst bestuende der Vergleich unten auch ohne Leiste:
    // `findIndex` liefert dann -1, und -1 ist kleiner als jeder Index.
    expect(bar).not.toBe(-1);
    expect(notice).not.toBe(-1);
    expect(bar).toBeLessThan(notice);
  });

  it("laesst hoechstens EINE Rueckfrage gleichzeitig offen", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { el } = mount(s);
    openConfirm(el, "h1");
    openConfirm(el, "h2");
    expect(el.querySelectorAll(".host-confirm-remove")).toHaveLength(1);
    expect(el.querySelector(".host-confirm-remove")!.textContent).toContain("h2");
  });

  it("bricht mit Escape ab und gibt den Fokus auf ⋯ zurueck", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el, h } = mount(s);
    const bar = openConfirm(el, "h1");
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(el.querySelector(".host-confirm-remove")).toBeNull();
    expect(h.onRemoveHost).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(moreButton(el, "h1"));
  });

  it("laesst Escape NICHT bis zum Dokument durch", () => {
    // Die Entsprechung zum gleichnamigen Test der Menuegruppe. Ohne ihn war
    // das `stopPropagation()` der Leiste ungedeckt: es liess sich loeschen,
    // ohne dass ein Test rot wurde -- und ein Escape schloss dann die
    // Rueckfrage UND holte die maximierte Kachel ins Raster zurueck.
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    const bar = openConfirm(el, "h1");
    const spy = vi.fn();
    document.addEventListener("keydown", spy);
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.removeEventListener("keydown", spy);
    expect(spy).not.toHaveBeenCalled();
  });

  // Entwurf §2.1/§2.3: der Fokus springt beim Oeffnen programmatisch auf
  // "Cancel". Ein Screenreader liest dabei nur den Knopf vor -- ohne
  // `aria-describedby` kaemen weder der Hostname noch der Satz ueber die
  // weiterlaufenden Sessions je an, und genau der ist "Pflicht, nicht
  // Zierde".
  it("beschreibt beide Knoepfe mit der Frage und dem Satz ueber die Sessions", () => {
    const s = new AppState();
    s.upsertHost(host("vm-build"));
    const { el } = mount(s);
    const bar = openConfirm(el, "vm-build");
    const buttons = Array.from(bar.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Remove"]);

    for (const button of buttons) {
      const tokens = (button.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      expect(tokens).toHaveLength(2);
      // Die Kennungen muessen sich AUFLOESEN: ein `aria-describedby` auf eine
      // nicht vorhandene Kennung ist wirkungslos, und eine blosse Pruefung
      // auf das Attribut saehe den Unterschied nicht.
      const described = tokens.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      expect(described).toContain("Remove vm-build?");
      expect(described).toContain("Sessions on the host keep running.");
    }
  });

  it("fokussiert nach dem Bestaetigen den Fuss, wenn der Host fort ist", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const h = handlers();
    // Also support a caller that removes the host synchronously.
    h.onRemoveHost = vi.fn((id: string) => s.removeHost(id));
    const { el } = mount(s, h);
    const bar = openConfirm(el, "h1");
    Array.from(bar.querySelectorAll("button")).find((b) => b.textContent === "Remove")!.click();
    expect(h.onRemoveHost).toHaveBeenCalledWith("h1");
    expect((document.activeElement as HTMLElement).classList.contains("sb-btn")).toBe(true);
  });

  it("moves focus after deferred removal without stealing it from another host", async () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const h = handlers();
    let finishRemoval!: () => void;
    h.onRemoveHost = vi.fn(() => new Promise<void>((resolve) => { finishRemoval = resolve; }));
    const { el } = mount(s, h);
    const bar = openConfirm(el, "h1");
    Array.from(bar.querySelectorAll("button")).find((b) => b.textContent === "Remove")!.click();
    expect(el.querySelector(".host-confirm-remove")).toBeNull();
    s.removeHost("h1");
    expect((document.activeElement as HTMLElement).classList.contains("sb-btn")).toBe(true);

    finishRemoval();
    await Promise.resolve();
    s.upsertHost(host("h1"));
    const again = openConfirm(el, "h1");
    Array.from(again.querySelectorAll("button")).find((b) => b.textContent === "Remove")!.click();
    const other = el.querySelector<HTMLElement>('.row-host[data-host-id="h2"]')!;
    other.focus();
    s.removeHost("h1");
    expect((document.activeElement as HTMLElement).dataset.hostId).toBe("h2");
    finishRemoval();
    await Promise.resolve();
  });

  it("verwirft die Rueckfrage, wenn der Host anderweitig verschwindet", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { el } = mount(s);
    // Vorbedingung: die Leiste steht wirklich. Ohne sie pruefte der Test nur
    // einen nie erreichten Ausgangszustand und bliebe auch dann gruen, wenn
    // es die Rueckfrage gar nicht gaebe.
    expect(openConfirm(el, "h2")).not.toBeNull();
    s.removeHost("h2");
    expect(el.querySelector(".host-confirm-remove")).toBeNull();
    s.setHostState("h1", "connecting"); // noch ein Neuzeichnen
    expect(el.querySelector(".host-confirm-remove")).toBeNull();
  });
});

// Befunde aus dem Abschlussgutachten (Nutzersicht). Jeder dieser Tests
// entstand, WEIL der Gutachter einen Ablauf gefunden hat, in dem die
// Rueckfrage ihre Zusage nicht haelt. Sie fahren deshalb bewusst Namen mit
// Leerzeichen -- alle uebrigen Sidebar-Tests dieser Datei benutzen "a", und
// genau daran ist Befund 1 vorbeigelaufen.
describe("mountSidebar: die Beenden-Rueckfrage haelt ihre Zusage", () => {
  it("haelt aria-describedby aufloesbar, auch bei einem Namen mit Leerzeichen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["deploy log 2"]));
    const { el } = mount(s);

    el.querySelector<HTMLButtonElement>(".session-kill-btn")!.click();

    const cancel = el.querySelector<HTMLButtonElement>(
      ".session-confirm-kill .host-confirm-btn",
    )!;
    const ids = (cancel.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    // Die eigentliche Zusicherung: JEDE Kennung loest auf. Bei einem
    // Bezeichner mit Leerzeichen zerfaellt die Liste in Bruchstuecke, von
    // denen keines etwas trifft -- der Screenreader saegt dann nur "Cancel".
    for (const id of ids) {
      expect(document.getElementById(id), `unaufloesbare Kennung: ${id}`).not.toBeNull();
    }
    // Und der Satz, der wirklich zaehlt, haengt an einer davon.
    const beschreibung = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(beschreibung).toContain("cannot be undone");
  });

  it("schliesst die Rueckfrage, wenn der Tabulator sie verlaesst", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el, h } = mount(s);

    el.querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    const bar = el.querySelector<HTMLElement>(".session-confirm-kill")!;
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    // Ohne diesen Zweig bliebe sie stehen -- und waere unbeantwortbar:
    // beide Knoepfe tragen tabindex="-1", der Fokus kaeme nicht zurueck.
    expect(el.querySelector(".session-confirm-kill")).toBeNull();
    expect(h.onKillSession).not.toHaveBeenCalled();
  });

  it("laesst den Fokus nach dem Bestaetigen nicht auf <body> fallen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el, h } = mount(s);

    el.querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    el.querySelector<HTMLButtonElement>(
      ".session-confirm-kill .host-confirm-btn-danger",
    )!.click();
    expect(h.onKillSession).toHaveBeenCalledWith("h1", "a");

    // Der Aufruf ist in der Anwendung ASYNCHRON: die Sessionzeile
    // verschwindet erst, wenn die frische Liste eintrifft. Genau das hier
    // nachgestellt -- und danach muss der Fokus noch irgendwo sitzen.
    s.setSessions("h1", []);
    expect(document.activeElement).not.toBe(document.body);
    expect(el.contains(document.activeElement)).toBe(true);
  });

  it("bietet auf einem GETRENNTEN Host gar kein Beenden an", () => {
    const s = new AppState();
    const h1 = host("h1", ["a"]);
    h1.state = "disconnected";
    s.upsertHost(h1);
    const { el } = mount(s);

    // `kill_session` braucht die Laufzeit-ID. Stuende der Knopf hier, laese
    // der Nutzer "This cannot be undone", bestaetigte -- und bekaeme einen
    // Satz ueber das OEFFNEN einer Session zurueck.
    expect(el.querySelector(".session-kill-btn")).toBeNull();
    expect(el.querySelectorAll(".row-session")).toHaveLength(1);
  });

  it("verwirft eine offene Rueckfrage, wenn ihre Session verschwindet", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);

    el.querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    expect(el.querySelector(".session-confirm-kill")).not.toBeNull();

    // Ein "Reload sessions", oder ein Kollege war schneller.
    s.setSessions("h1", []);
    // Und jetzt taucht wieder eine gleichnamige auf.
    s.setSessions("h1", ["a"]);

    // Ohne die Aufraeumung stuende hier eine Frage "This cannot be undone",
    // nach der niemand gefragt hat.
    expect(el.querySelector(".session-confirm-kill")).toBeNull();
  });

  it("beschriftet den fragenden Knopf mit Ellipse, den ausfuehrenden ohne", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);

    // Die Konvention dieser Datei seit Task 2: das Ellipsenzeichen ist ein
    // Versprechen, dass nachgefragt wird. Zwei Knoepfe mit demselben
    // Wortlaut in derselben Zeile -- einer harmlos, einer zerstoererisch --
    // waeren fuer einen Screenreader ununterscheidbar.
    const kill = el.querySelector<HTMLButtonElement>(".session-kill-btn")!;
    expect(kill.textContent).toContain("…");
    kill.click();
    const confirm = el.querySelector<HTMLButtonElement>(
      ".session-confirm-kill .host-confirm-btn-danger",
    )!;
    expect(confirm.textContent).not.toContain("…");
    expect(confirm.textContent).not.toBe(kill.textContent);
  });
});

// Die Gegenprobe zu `focusByKey`. Der Attributselektor, den diese Funktion
// frueher benutzte, wirft bei einem `"` im Namen eine DOMException -- mitten
// im Klickbehandler, mit einer Rueckfrage, die dann ohne Fokus dasteht.
//
// Der Name kann nicht aus dieser Anwendung stammen (B2s Allowlist blockt
// ihn), sondern aus einer FREMDEN tmux-Sitzung auf demselben Socket -- und
// genau die verwaisten Fremdsitzungen sind der Anlass des ganzen Knopfes.
// Ohne diesen Test ist der Rueckbau auf `querySelector` unsichtbar: er macht
// keinen der uebrigen 78 Tests rot (gemessen).
describe("mountSidebar: Sessionnamen aus fremden Sitzungen brechen den Fokus nicht", () => {
  it("oeffnet die Rueckfrage auch bei einem Namen mit Anfuehrungszeichen und setzt den Fokus", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ['a"b']));
    const { el } = mount(s);

    el.querySelector<HTMLButtonElement>(".session-kill-btn")!.click();

    expect(el.querySelector(".session-confirm-kill")).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(el.contains(document.activeElement)).toBe(true);
  });
});

// Task 9: Version und Commit im Diagnosetext, den "Copy diagnostics" in die
// Zwischenablage legt -- dieselbe Quelle (`appVersionLine()`) wie die Zeile
// am Fuss der Leiste. jsdom kennt `navigator.clipboard` nicht von sich aus
// (siehe dieselbe Begruendung in `terminal.test.ts`), darum hier derselbe
// Ersatz.
describe("mountSidebar: Diagnosetext beginnt mit Version und Commit", () => {
  const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: clipboardWriteText },
    configurable: true,
    writable: true,
  });

  afterEach(() => {
    clipboardWriteText.mockClear();
  });

  it("legt die Versionszeile vor die Fehlermeldung in die Zwischenablage", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "failed", error: "agent unavailable" });
    const { el } = mount(s);

    const copyButton = Array.from(el.querySelectorAll<HTMLButtonElement>(".host-notice-link"))
      .find((b) => b.textContent === "Copy diagnostics")!;
    copyButton.click();

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    const [written] = clipboardWriteText.mock.calls[0] as [string];
    expect(written.startsWith(appVersionLine())).toBe(true);
    expect(written).toBe(`${appVersionLine()}\nagent unavailable`);
  });
});

// UI v2, Aufgabe 8: der Aufbau der Seitenleiste nach Spec 7. Geprueft wird
// die DOM-STRUKTUR (Reihenfolge der Kinder, Klassen, `aria-hidden`), nicht
// das Aussehen -- die Neuform der Regeln folgt in Aufgabe 9 und darf diese
// Tests nicht beruehren.
describe("UI v2: Kopf, Kuerzel, Pille, aktive Aktionsleiste (Spec 7)", () => {
  it("der Add-Knopf steht im Kopf, behaelt Klasse und Fokusschluessel; der Fuss traegt nur die Version", () => {
    const s = new AppState();
    const { el } = mount(s);
    const add = el.querySelector<HTMLButtonElement>(".sb-head .sb-btn");
    expect(add).not.toBeNull();
    expect(add?.dataset.focusKey).toBe("foot::add");
    expect(add?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(el.querySelector(".sb-foot .sb-btn")).toBeNull();
    expect(el.querySelector(".sb-foot .sb-version")).not.toBeNull();
    const headChildren = Array.from(el.querySelector(".sb-head")!.children).map((c) => c.className);
    expect(headChildren).toEqual(["", "sb-btn", "sb-head-btn"]);
  });

  it("zeigt ohne Hosts den Leerhinweis in der Liste", () => {
    const s = new AppState();
    const { el } = mount(s);
    expect(el.querySelector(".sb-list .sb-empty-hint")?.textContent).toBe(
      "Your hosts appear here. Connect the first one on the right.",
    );
    s.upsertHost(host("h1"));
    expect(el.querySelector(".sb-list > .sb-empty-hint")).toBeNull();
  });

  it("Hostzeile: Chevron-Icon, Kuerzelquadrat nur Identitaet (aria-hidden), Name, Pille mit Form und Text", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["a"]), label: "vm-build-01" });
    s.setHostState("h1", "connected");
    const { el } = mount(s);
    const row = el.querySelector<HTMLElement>(".row-host")!;
    const children = Array.from(row.children);
    expect(children.map((c) => c.className.split(" ")[0])).toEqual(["chev", "sb-avatar", "row-label", "row-meta"]);
    expect(children[0].getAttribute("aria-hidden")).toBe("true");
    expect(children[0].querySelector("svg")).not.toBeNull();
    expect(children[1].getAttribute("aria-hidden")).toBe("true");
    expect(children[1].textContent).toBe("B1");
    expect(row.dataset.state).toBe("connected");
    const pill = row.querySelector<HTMLElement>(".row-meta .state-pill")!;
    expect(pill.classList.contains("state-pill--connected")).toBe(true);
    expect(pill.querySelector(".ind.ind-on")).not.toBeNull();
    // Task 16, Punkt B: kurze Pillenwoerter -- bei 240 px blieben dem
    // Hostnamen neben "Disconnected" nur noch rund 40 px.
    expect(pill.textContent).toBe("Online");
  });

  it("Pille und data-state folgen jedem Hostzustand", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    const { el } = mount(s);
    for (const [state, text] of [
      ["connecting", "Connecting…"],
      ["failed", "Failed"],
      ["disconnected", "Offline"],
    ] as const) {
      s.setHostState("h1", state, state === "failed" ? "boom" : null);
      const row = el.querySelector<HTMLElement>(".row-host")!;
      expect(row.dataset.state).toBe(state);
      const pill = row.querySelector<HTMLElement>(".state-pill")!;
      expect(pill.classList.contains(`state-pill--${state}`)).toBe(true);
      expect(pill.textContent).toBe(text);
    }
  });

  it("der Chevron wechselt mit dem Aufklappzustand", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    const row = () => el.querySelector<HTMLButtonElement>(".row-host")!;
    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(row().querySelector<HTMLElement>(".chev")!.dataset.icon).toBe("chevron-down");
    row().click();
    expect(row().getAttribute("aria-expanded")).toBe("false");
    expect(row().querySelector<HTMLElement>(".chev")!.dataset.icon).toBe("chevron-right");
  });

  it("Sessionzeile: Indikator links im 14er-Kasten, Wort rechts im Meta-Feld", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);
    const row = el.querySelector<HTMLElement>(".row-session")!;
    const children = Array.from(row.children);
    expect(children.map((c) => c.className.split(" ")[0])).toEqual(["ind-box", "row-label", "row-meta"]);
    expect(children[0].getAttribute("aria-hidden")).toBe("true");
    expect(children[0].querySelector(".ind.ind-sm.ind-off")).not.toBeNull();
    expect(row.querySelector(".row-meta .row-state-word")?.textContent).toBe("Not open");
    // Without agent data the slot is not rendered and the channel word stays.
    expect(row.querySelector(".row-meta .st")).toBeNull();
    expect(row.querySelector(".row-state-word")!.classList.contains("ab-visually-hidden")).toBe(false);
  });

  it("Sessionzeile mit Agentenstatus: Pille im Meta-Feld, Kanalwort nur noch im Tooltip", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.setSessionRecords("h1", [{ name: "a", status: "waiting", statusReason: "permission prompt" }], Date.now());
    const { el } = mount(s);
    const row = el.querySelector<HTMLElement>(".row-session")!;
    const pill = row.querySelector<HTMLElement>(".row-meta .st.st-waiting")!;
    expect(pill.textContent).toBe("Waiting");
    expect(pill.title).toBe("permission prompt");
    // Still read out, still in the tooltip, no longer printed next to the pill.
    const word = row.querySelector<HTMLElement>(".row-meta .row-state-word")!;
    expect(word.textContent).toBe("Not open");
    expect(word.classList.contains("ab-visually-hidden")).toBe(true);
    expect(row.title).toBe("Not open\nClick: open as a new terminal · Ctrl+click: replace the focused terminal");
  });

  it("Sessionzeile eines Hosts ohne aktuellen Status zeigt den letzten Wert als veraltet", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.setSessionRecords("h1", [{ name: "a", status: "busy", statusReason: "agent is busy" }], Date.now());
    s.markStatusStale("h1");
    const { el } = mount(s);
    const pill = el.querySelector<HTMLElement>(".row-session .row-meta .st")!;
    expect(pill.className).toBe("st st-stale");
    expect(pill.textContent).toMatch(/^As of /);
  });

  it("markiert die Session der fokussierten Kachel mit aria-current", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.setHostState("h1", "connected");
    const { el } = mount(s);
    s.openSession("h1", "b");
    s.focusTile(s.tiles[0].id);
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".row-session"));
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual([null, "true"]);
  });

  it("eine Session in einer Kachel zeigt deren Nummer statt des Punkts, fokussiert gefuellt (Spec 2026-10-19 §7)", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c"]));
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    const { el } = mount(s);
    const box = (name: string) => el.querySelector<HTMLElement>(`[data-session-key="h1/${name}"] .ind-box`)!;
    expect(box("a").querySelector(".tile-number")?.textContent).toBe("1");
    expect(box("a").querySelector(".tile-number--focused")).toBeNull();
    expect(box("b").querySelector(".tile-number.tile-number--focused")?.textContent).toBe("2");
    expect(box("c").querySelector(".tile-number")).toBeNull();
    expect(box("c").querySelector(".ind.ind-off")).not.toBeNull();
    // Das Wort bleibt wie heute.
    expect(el.querySelector('[data-session-key="h1/a"] .row-state-word')?.textContent).toBe("Open");
  });

  it("ein gesperrter Kanal behaelt das Warndreieck, auch in einer Kachel", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    s.lockInput("h1", "a");
    const { el } = mount(s);
    const row = el.querySelector<HTMLElement>('[data-session-key="h1/a"]')!;
    expect(row.querySelector(".ind-warn")).not.toBeNull();
    expect(row.querySelector(".tile-number")).toBeNull();
  });

  // Die Nummer ist Position + 1, nicht die `id` der Kachel: im Test oben
  // stimmen beide ueberein. Tausch und Schliessen trennen sie, und die Liste
  // zeichnet bei jeder Aenderung neu.
  it("die Nummer folgt Tausch, Fokus und Schliessen der Kacheln (Position + 1, nicht die id)", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c"]));
    for (const name of ["a", "b", "c"]) s.openSession("h1", name);
    const { el } = mount(s);
    const chip = (name: string) => el.querySelector<HTMLElement>(`[data-session-key="h1/${name}"] .tile-number`);
    const focusedNames = () =>
      ["a", "b", "c"].filter((name) => chip(name)?.classList.contains("tile-number--focused"));

    s.swapTiles(s.tiles[0].id, s.tiles[2].id);
    expect(["a", "b", "c"].map((name) => chip(name)?.textContent)).toEqual(["3", "2", "1"]);
    expect(focusedNames()).toEqual(["c"]);

    s.focusTile(s.tileForSession("h1/a")!.id);
    expect(focusedNames()).toEqual(["a"]);

    // "b" faellt aus der Mitte von [c, b, a]: "a" rueckt von 3 auf 2, "c" bleibt 1.
    // Die ids (a = 1, c = 3) sagen davon nichts.
    s.closeTile(s.tileForSession("h1/b")!.id);
    expect(chip("b")).toBeNull();
    expect(el.querySelector('[data-session-key="h1/b"] .ind-box .ind.ind-off')).not.toBeNull();
    expect(["a", "c"].map((name) => chip(name)?.textContent)).toEqual(["2", "1"]);
  });

  it("waehrend ein Host neu verbindet, zeigt eine Session in einer Kachel ihre Nummer, danach wieder das Dreieck", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    s.lockInput("h1", "a");
    s.setHostState("h1", "failed", "The terminal connection was lost.");
    const { el } = mount(s);
    const row = () => el.querySelector<HTMLElement>('[data-session-key="h1/a"]')!;
    expect(row().querySelector(".ind-warn")).not.toBeNull();
    s.setHostReconnecting("h1", true);
    // Ruhig wie Hostzeile und Kachel: die Session bleibt "Open" und zeigt ihre Nummer.
    expect(row().querySelector(".ind-warn")).toBeNull();
    expect(row().querySelector(".tile-number")?.textContent).toBe("1");
    s.setHostReconnecting("h1", false);
    expect(row().querySelector(".ind-warn")).not.toBeNull();
    expect(row().querySelector(".tile-number")).toBeNull();
  });

  it("die Aktionsleiste ist nur am aktiven Host markiert: Roving-Fokus, sonst fokussierte Kachel", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2", ["b"]));
    s.setHostState("h1", "connected");
    s.setHostState("h2", "connected");
    const { el } = mount(s);
    const blocks = () => Array.from(el.querySelectorAll<HTMLElement>(".sb-host-block"));
    // Ohne Fokus: Kachel entscheidet.
    s.openSession("h2", "b");
    s.focusTile(s.tiles[0].id);
    expect(blocks().map((b) => b.classList.contains("sb-host-block--active"))).toEqual([false, true]);
    // Roving-Fokus auf h1 gewinnt (`.focus()` loest in jsdom `focusin` aus,
    // den die Liste abgleicht -- derselbe Weg wie in den Roving-Tests oben).
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".sb-list .ab-row"));
    rows[0].focus();
    expect(blocks().map((b) => b.classList.contains("sb-host-block--active"))).toEqual([true, false]);
  });

  // UX-Spec §7.9, Schritt 3 der Zielhost-Kette: main.ts fragt den aktiven Host
  // am Handle ab -- dieselbe Ableitung wie die Markierung oben, keine zweite.
  it("activeHostId nennt den markierten Host: Roving-Fokus, sonst fokussierte Kachel, sonst der Zeiger", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2", ["b"]));
    s.upsertHost(host("h3", ["c"]));
    const el = document.createElement("div");
    document.body.appendChild(el);
    const handle = mountSidebar(el, s, handlers());
    handles.push(handle);
    const marked = () =>
      el.querySelector<HTMLElement>(".sb-host-block--active .row-host")?.dataset.hostId ?? null;

    // Ohne Fokus und ohne Kachel: der Zeiger der Liste, anfangs der erste Host.
    expect(handle.activeHostId()).toBe("h1");

    s.openSession("h3", "c");
    expect(handle.activeHostId()).toBe("h3");
    expect(marked()).toBe("h3");

    const rows = Array.from(el.querySelectorAll<HTMLElement>(".sb-list .row-host"));
    rows[1].focus();
    expect(handle.activeHostId()).toBe("h2");
    expect(marked()).toBe("h2");
  });
});

// Abnahme B2: die Zeile nimmt beim Druck den Fokus, `focusin` markierte ihren
// Host sofort als aktiv, und dessen Knopfleiste schob die Zeilen um 38 px nach
// unten, noch vor dem Loslassen. Der Klick ging dann an einen gemeinsamen
// Vorfahren, und der erste Klick auf eine Zeile eines nicht aktiven Hosts war
// verloren. Waehrend des Drucks bleibt deshalb die Markierung stehen; sie holt
// nach dem Klick auf. jsdom fokussiert beim Druck nicht von selbst -- die Tests
// tun, was der Browser tut, und rufen `focus()`.
describe("mountSidebar: ein Druck in der Liste verschiebt die Zeilen nicht (Abnahme B2)", () => {
  function setup(): {
    el: HTMLElement;
    s: AppState;
    h: ReturnType<typeof handlers>;
    handle: SidebarHandle;
    row: HTMLElement;
  } {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2", ["b"]));
    s.openSession("h1", "a");
    s.openSession("h2", "b");
    s.focusTile(s.tileForSession("h2/b")!.id);
    const { el, h } = mount(s);
    const handle = handles[handles.length - 1];
    return { el, s, h, handle, row: el.querySelector<HTMLElement>('[data-session-key="h1/a"]')! };
  }

  function marked(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll<HTMLElement>(".sb-host-block--active .row-host")).map(
      (row) => row.dataset.hostId ?? "",
    );
  }

  function pressing(el: HTMLElement): boolean {
    return el.querySelector(".sb-list")!.classList.contains("sb-list--pressing");
  }

  function pointer(type: string, target: EventTarget, button = 0): void {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waehrend des Drucks bleibt der Host markiert, der beim Druck aktiv war; nach dem Klick folgt die Markierung wieder", () => {
    const { el, handle, row } = setup();
    // Vorbedingung: die fokussierte Kachel gehoert h2.
    expect(marked(el)).toEqual(["h2"]);

    pointer("pointerdown", row);
    row.focus();
    expect(document.activeElement).toBe(row);
    expect(marked(el)).toEqual(["h2"]);
    expect(pressing(el)).toBe(true);

    // Losgelassen wird am Fenster, der Klick folgt in derselben Aufgabe: erst
    // danach holt die Markierung auf.
    pointer("pointerup", window);
    expect(marked(el)).toEqual(["h2"]);
    vi.advanceTimersByTime(0);
    expect(marked(el)).toEqual(["h1"]);
    expect(handle.activeHostId()).toBe("h1");
    expect(pressing(el)).toBe(false);
  });

  it("auch eine Neuzeichnung waehrend des Drucks gibt den neu gebauten Bloecken die eingefrorene Markierung", () => {
    const { el, s, row } = setup();
    pointer("pointerdown", row);
    row.focus();

    s.setSessions("h2", ["b", "c"]);
    // Neu gebaut, und der Fokus steht wieder auf der Zeile von h1.
    expect(el.querySelector('[data-session-key="h2/c"]')).not.toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset.sessionKey).toBe("h1/a");
    expect(marked(el)).toEqual(["h2"]);

    pointer("pointerup", window);
    vi.advanceTimersByTime(0);
    expect(marked(el)).toEqual(["h1"]);
  });

  it("ein Druck, der mit pointercancel endet, holt ebenso auf", () => {
    const { el, row } = setup();
    pointer("pointerdown", row);
    row.focus();
    expect(marked(el)).toEqual(["h2"]);

    pointer("pointercancel", window);
    vi.advanceTimersByTime(0);
    expect(marked(el)).toEqual(["h1"]);
    expect(pressing(el)).toBe(false);
  });

  it("nur die primaere Taste friert ein; sonst folgt die Markierung dem Fokus wie bisher", () => {
    const { el, row } = setup();
    pointer("pointerdown", row, 2);
    row.focus();
    expect(pressing(el)).toBe(false);
    expect(marked(el)).toEqual(["h1"]);
  });

  /** Ein Klick, wie der Browser ihn ausliefert: Druck, Fokus, Loslassen am
   * Fenster, Klick, dann der Zeitgeber des Aufholens. */
  function clickLikeBrowser(target: HTMLElement): void {
    pointer("pointerdown", target);
    target.focus();
    pointer("pointerup", window);
    target.click();
    vi.advanceTimersByTime(0);
  }

  // Nachtrag zu B2: das `⋯`-Menue haengt an der Seitenleiste, nicht an der
  // Liste. Nimmt es nach dem Klick den Fokus, sah das Aufholen keinen Fokus in
  // der Liste und markierte den Host der fokussierten Kachel -- dessen Leiste
  // erschien unter dem offenen Menue.
  it("ein Klick auf ⋯ laesst nach dem Aufholen den Host des Menues markiert, nicht den der Kachel", () => {
    const { el, handle } = setup();
    clickLikeBrowser(el.querySelector<HTMLElement>('.row-host[data-host-id="h1"]')!);
    expect(marked(el)).toEqual(["h1"]);

    clickLikeBrowser(moreButton(el, "h1"));
    // Das Menue ist offen und hat den Fokus.
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    expect(marked(el)).toEqual(["h1"]);
    expect(handle.activeHostId()).toBe("h1");
  });

  it("auch ein Neuzeichnen bei offenem ⋯-Menue haelt dessen Host markiert", () => {
    const { el, s } = setup();
    el.querySelector<HTMLElement>('.row-host[data-host-id="h1"]')!.focus();
    moreButton(el, "h1").click();
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();

    s.setSessions("h2", ["b", "c"]);
    expect(el.querySelector('[data-session-key="h2/c"]')).not.toBeNull();
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    expect(marked(el)).toEqual(["h1"]);
  });

  // Nachtrag zu B2: ging das Loslassen verloren (Alt+Tab mitten im Druck),
  // bliebe die Markierung sonst bis zum naechsten Loslassen eingefroren.
  it("ein Druck endet auch, wenn das Fenster den Fokus verliert", () => {
    const { el, handle, row } = setup();
    pointer("pointerdown", row);
    row.focus();
    expect(marked(el)).toEqual(["h2"]);

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(0);
    expect(marked(el)).toEqual(["h1"]);
    expect(handle.activeHostId()).toBe("h1");
    expect(pressing(el)).toBe(false);
  });

  // Der Druck selbst verschiebt den Fokus (etwa aus dem Terminal auf die
  // Zeile), und das Element, das ihn abgibt, bekommt ein `blur`. Beendete das
  // den Druck, taute die Markierung vor dem Loslassen auf, und B2 kaeme
  // zurueck.
  it("der Fokuswechsel beim Druck selbst beendet ihn nicht, nur der Fokusverlust des Fensters", () => {
    const { el, row } = setup();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    pointer("pointerdown", row);
    row.focus();
    vi.advanceTimersByTime(0);
    expect(pressing(el)).toBe(true);
    expect(marked(el)).toEqual(["h2"]);

    pointer("pointerup", window);
    vi.advanceTimersByTime(0);
    expect(marked(el)).toEqual(["h1"]);
  });

  // --- Runde 2 der Nachpruefung ---------------------------------------------

  /** Wessen Knopfleiste die zwei Regeln in styles.css zeigen: markiert, beim
   * Druck gehalten, das eigene Menue offen, oder der Fokus steht darin -- das
   * Letzte nicht waehrend eines Drucks. jsdom wertet weder `:focus-within`
   * noch `:has()` aus; die Regeln selbst haelt styles.test.ts fest. */
  function shownBars(el: HTMLElement): string[] {
    const active = document.activeElement;
    return Array.from(el.querySelectorAll<HTMLElement>(".sb-host-block"))
      .filter((block) =>
        block.classList.contains("sb-host-block--active") ||
        block.classList.contains("sb-host-block--held") ||
        block.querySelector('.host-actions [aria-expanded="true"]') !== null ||
        (!pressing(el) && active !== null && block.contains(active)))
      .map((block) => block.querySelector<HTMLElement>(".row-host")!.dataset.hostId ?? "");
  }

  /** Drei Hosts ohne Kachel; h2 ist gescheitert und zeigt seine Hinweisleiste
   * mit Passwortfeld, "Retry" und "Details". Markiert ist h1 (der
   * Roving-Zeiger). */
  function setupNotice(): { el: HTMLElement; s: AppState; h: ReturnType<typeof handlers>; block: (id: string) => HTMLElement } {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost({
      ...host("h2"),
      state: "failed",
      error: "Wrong password for this account.",
      errorCode: "password_required",
      authKind: "password",
    });
    s.upsertHost(host("h3", ["c"]));
    const { el, h } = mount(s);
    const block = (id: string) =>
      el.querySelector<HTMLElement>(`.row-host[data-host-id="${id}"]`)!.closest<HTMLElement>(".sb-host-block")!;
    return { el, s, h, block };
  }

  function buttonIn(block: HTMLElement, text: string): HTMLButtonElement {
    return Array.from(block.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text)!;
  }

  // Nachpruefung, Befund "wichtig" (Nachstellung A): ein Feld der Hinweisleiste
  // bewegt den Roving-Zeiger nicht -- h2 zeigt seine Leiste nur ueber den Fokus
  // darin. Der Druck auf "Retry" versteckte sie, alles darunter rueckte hoch,
  // und der Klick ging verloren, jedes Mal.
  it("ein Druck auf einen zweiten Knopf im Block, dessen Leiste nur der Fokus zeigt, laesst sie stehen", () => {
    const { el, h, block } = setupNotice();
    block("h2").querySelector<HTMLInputElement>("input[name=password]")!.focus();
    expect(marked(el)).toEqual(["h1"]);
    const before = shownBars(el);
    expect(before).toEqual(["h1", "h2"]);

    const retry = buttonIn(block("h2"), "Retry");
    pointer("pointerdown", retry);
    retry.focus();
    expect(shownBars(el)).toEqual(before);

    pointer("pointerup", window);
    retry.click();
    expect(h.onConnectHost).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(0);
    expect(shownBars(el)).toEqual(before);
    expect(block("h2").classList.contains("sb-host-block--held")).toBe(false);
  });

  // Nachstellung B: der Fokus steht in h2, gedrueckt wird eine Zeile weiter
  // unten. Der Fokus verlaesst h2, und schon die Grundregel versteckte dessen
  // Leiste vor dem Loslassen -- auch ueber ein Neuzeichnen hinweg nicht.
  it("verlaesst der Fokus beim Druck den Block, behaelt er seine Leiste bis nach dem Klick, auch ueber ein Neuzeichnen", () => {
    const { el, s, block } = setupNotice();
    buttonIn(block("h2"), "Details").focus();
    const before = shownBars(el);
    expect(before).toEqual(["h1", "h2"]);

    const below = el.querySelector<HTMLElement>('[data-session-key="h3/c"]')!;
    pointer("pointerdown", below);
    below.focus();
    expect(shownBars(el)).toEqual(before);

    s.setSessions("h1", ["a", "a2"]);
    expect(el.querySelector('[data-session-key="h1/a2"]')).not.toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset.sessionKey).toBe("h3/c");
    expect(shownBars(el)).toEqual(before);

    pointer("pointerup", window);
    el.querySelector<HTMLElement>('[data-session-key="h3/c"]')!.click();
    vi.advanceTimersByTime(0);
    // Erst jetzt folgt alles dem Fokus: h3 ist markiert, h2 gibt seine Leiste ab.
    expect(marked(el)).toEqual(["h3"]);
    expect(shownBars(el)).toEqual(["h3"]);
  });

  // Nachpruefung, Befund "gering": ein Druck auf den Rollbalken der Liste
  // (Ziel ist die Liste selbst) oder in ein `select` bekommt sein Loslassen
  // nicht verlaesslich ans Fenster; die Markierung bliebe eingefroren.
  it("ein Druck auf die Liste selbst, ihren Rollbalken, friert nichts ein", () => {
    const { el, row } = setup();
    pointer("pointerdown", el.querySelector<HTMLElement>(".sb-list")!);
    expect(pressing(el)).toBe(false);
    row.focus();
    expect(marked(el)).toEqual(["h1"]);
  });

  it("ein Druck in ein select friert nichts ein", async () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["a"]), authKind: "agent" });
    s.setControlState("h1", { generation: 2, state: "degraded", message: "Control unavailable" });
    // Wie "explicit control repair": ohne diesen Rueckruf gibt es den Knopf nicht.
    const withRepair = { ...handlers(), onRepairControl: vi.fn() };
    const { el } = mount(s, withRepair);
    el.querySelector<HTMLButtonElement>(".control-notice button")!.click();
    await Promise.resolve();
    await Promise.resolve();
    const select = el.querySelector<HTMLSelectElement>(".sb-list select")!;
    expect(select).not.toBeNull();

    pointer("pointerdown", select);
    expect(pressing(el)).toBe(false);
  });

  // Nachpruefung, Befund "gering": zwischen den beiden Klicks eines
  // Doppelklicks holt die Markierung auf, die Zeilen ruecken, und der zweite
  // Klick traf die Nachbarzeile. Ein zweiter Klick (detail 2) tut in der Liste
  // nichts; ein Klick von der Tastatur hat detail 0 und bleibt.
  it("ein Doppelklick handelt einmal; ein Klick von der Tastatur bleibt", () => {
    const { el, h, row } = setup();
    clickLikeBrowser(row);
    expect(h.onOpenSession).toHaveBeenCalledOnce();

    const other = el.querySelector<HTMLElement>('[data-session-key="h2/b"]')!;
    other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }));
    expect(h.onOpenSession).toHaveBeenCalledOnce();

    other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    expect(h.onOpenSession).toHaveBeenCalledTimes(2);
    expect(h.onOpenSession).toHaveBeenLastCalledWith("h2", "b", { replace: false });
  });

  // --- Runde 3 (Nachpruefung am Fenster, B6) ---------------------------------

  /** Ein `mousedown` wie im Browser: ohne `preventDefault` nimmt das Ziel den
   * Fokus. jsdom tut das nicht von selbst. */
  function mousedownLikeBrowser(target: HTMLElement, detail: number): MouseEvent {
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail });
    target.dispatchEvent(event);
    if (!event.defaultPrevented) target.focus();
    return event;
  }

  // B6: der zweite Klick eines Doppelklicks tut nichts (Runde 2), sein Druck
  // nahm aber noch den Fokus -- die Zeile darunter, nach dem Aufholen die
  // Nachbarzeile oder "New session". Getippte Buchstaben bewegten dann den
  // Zeiger der Liste, und Enter handelte auf dieser Zeile.
  it("beim Doppelklick nimmt der zweite Druck keinen Fokus und handelt nicht; der Fokus bleibt, wo der erste Klick ihn hinsetzte", () => {
    const { el, h, row } = setup();
    clickLikeBrowser(row);
    expect(h.onOpenSession).toHaveBeenCalledOnce();
    // Wie die App: der Klick legt den Fokus ins Terminal der gewaehlten Kachel.
    const terminal = document.createElement("textarea");
    document.body.appendChild(terminal);
    terminal.focus();

    // Nach dem Aufholen liegt unter dem zweiten Druck die Nachbarzeile.
    const neighbour = el.querySelector<HTMLElement>('[data-session-key="h2/b"]')!;
    pointer("pointerdown", neighbour);
    const press = mousedownLikeBrowser(neighbour, 2);
    pointer("pointerup", window);
    neighbour.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }));
    vi.advanceTimersByTime(0);

    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(terminal);
    expect(h.onOpenSession).toHaveBeenCalledOnce();
  });

  it("ein zweiter Druck auf eine Zeile, eine andere Zeile oder einen Knopf der Leiste nimmt keinen Fokus", () => {
    const { el, row } = setup();
    const bar = el.querySelector<HTMLElement>('.row-host[data-host-id="h2"]')!
      .closest(".sb-host-block")!.querySelector<HTMLButtonElement>(".host-actions button")!;
    for (const target of [row, el.querySelector<HTMLElement>('[data-session-key="h2/b"]')!, bar]) {
      const before = document.activeElement;
      expect(mousedownLikeBrowser(target, 2).defaultPrevented, target.className).toBe(true);
      expect(document.activeElement, target.className).toBe(before);
    }
  });

  it("ein erster Druck (detail 1) nimmt den Fokus wie bisher", () => {
    const { row } = setup();
    expect(mousedownLikeBrowser(row, 1).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  // Runde 3, Nachtrag: Text, den styles.css markierbar haelt (`user-select:
  // text`, die Liste nach `html, body`), behaelt seinen zweiten Druck --
  // Doppel- und Dreifachklick markieren dort Wort und Zeile wie zuvor. Die
  // Antwort steht allein im Stylesheet, darum laedt der Test das echte. jsdom
  // rechnet `user-select` daraus aus, vererbt es aber wie die Spec nicht: ein
  // Element im markierbaren Text hat selbst `auto`, die Pruefung laeuft darum
  // aufwaerts.
  it("ein zweiter Druck auf markierbaren Text der Hinweisleiste bleibt, auf einer Zeile nicht", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    try {
      const s = new AppState();
      s.upsertHost(host("h1", ["a"]));
      s.setControlState("h1", { generation: 2, state: "degraded", message: "Control unavailable" });
      const { el } = mount(s);
      const notice = el.querySelector<HTMLElement>(".control-notice")!;
      buttonIn(notice, "Details").click();
      const detail = notice.querySelector<HTMLElement>(".host-notice-detail")!;
      expect(detail.hidden).toBe(false);
      expect(getComputedStyle(detail).getPropertyValue("user-select")).toBe("text");
      expect(mousedownLikeBrowser(detail, 2).defaultPrevented).toBe(false);

      // Ein Element darin, wie es Auszeichnung im Text waere.
      const inner = document.createElement("span");
      inner.textContent = "unavailable";
      detail.appendChild(inner);
      expect(getComputedStyle(inner).getPropertyValue("user-select")).toBe("auto");
      expect(mousedownLikeBrowser(inner, 2).defaultPrevented).toBe(false);

      const row = el.querySelector<HTMLElement>('[data-session-key="h1/a"]')!;
      expect(mousedownLikeBrowser(row, 2).defaultPrevented).toBe(true);
    } finally {
      style.remove();
    }
  });

  // Im Feld gehoert der zweite Druck dem Text: Doppelklick markiert ein Wort.
  it("ein zweiter Druck in das Passwortfeld der Hinweisleiste bleibt", () => {
    const { block } = setupNotice();
    const password = block("h2").querySelector<HTMLInputElement>("input[name=password]")!;
    expect(mousedownLikeBrowser(password, 2).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(password);
  });

  it("nach dispose() faengt die Liste keinen zweiten Druck mehr ab", () => {
    const { row } = setup();
    handles.pop()!.dispose();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 2 });
    row.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
  });

  it("meldet die Lauscher am Fenster beim dispose() wieder ab", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const s = new AppState();
      s.upsertHost(host("h1", ["a"]));
      const el = document.createElement("div");
      document.body.appendChild(el);
      mountSidebar(el, s, handlers()).dispose();
      for (const type of ["pointerup", "pointercancel", "blur"]) {
        const registered = add.mock.calls.filter(([t]) => t === type).map(([, fn]) => fn);
        expect(registered, type).toHaveLength(1);
        expect(remove.mock.calls.some(([t, fn]) => t === type && fn === registered[0]), type).toBe(true);
      }
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

// Task 16 (Sichtpruefung des Auftraggebers am Fenster, 2026-09-07): die zwei
// Sessionaktionen hingen als Textknoepfe neben bzw. unter der Zeile, die
// dadurch mal schmal, mal breit war. Sie sind jetzt zwei Icon-Knoepfe 26x26
// rechts IN der Zeile, gesammelt in `span.session-acts`. Sichtbar werden sie
// per CSS (`:hover`/`:focus-within`/`[aria-current]`) -- jsdom wertet weder
// `:has()` noch `:focus-within` aus, geprueft wird deshalb die DOM-Struktur.
describe("Task 16 A: Sessionaktionen als Icon-Knoepfe in der Zeile", () => {
  it("sammelt beide Knoepfe in span.session-acts NACH der Zeile", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    const { el } = mount(s);

    const wrap = el.querySelector<HTMLElement>(".sb-session-row")!;
    expect(Array.from(wrap.children).map((c) => c.className.split(" ")[0])).toEqual([
      "ab-row",
      "session-acts",
    ]);
    const acts = wrap.querySelector<HTMLElement>(".session-acts")!;
    expect(acts.tagName).toBe("SPAN");
    expect(Array.from(acts.children).map((c) => c.className.split(" ")[0])).toEqual([
      "session-close-btn",
      "session-kill-btn",
    ]);
  });

  it("traegt an jedem Knopf sein Icon, den Namen als title und weiterhin als Text", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    const { el } = mount(s);

    const close = el.querySelector<HTMLButtonElement>(".session-close-btn")!;
    const kill = el.querySelector<HTMLButtonElement>(".session-kill-btn")!;
    expect(close.querySelector<HTMLElement>(".icon-box")!.dataset.icon).toBe("x");
    expect(kill.querySelector<HTMLElement>(".icon-box")!.dataset.icon).toBe("trash-2");
    expect(close.querySelector(".icon-box svg")).not.toBeNull();
    expect(kill.querySelector(".icon-box svg")).not.toBeNull();
    expect(close.querySelector(".icon-box")!.getAttribute("aria-hidden")).toBe("true");
    // Icon UND Name: der Name steht in einem visuell versteckten Span, damit
    // `textContent` (und die Ansage) die Beschriftung bleibt (v2 §13.2). Kein
    // Kuerzel im Tooltip: Strg+Umschalt+W schliesst die fokussierte Kachel,
    // nicht die Session dieser Zeile (UX-Spec §8.4).
    expect(close.title).toBe("Close terminal");
    expect(kill.title).toBe("End session…");
    expect(close.textContent).toBe("Close terminal");
    expect(kill.textContent).toBe("End session…");
    expect(close.querySelector(".ab-visually-hidden")!.textContent).toBe("Close terminal");
    // Die Rolle aus dem Knopfsystem (Spec 11.2) plus die Geometrieklasse.
    expect(close.classList.contains("session-icon-btn")).toBe(true);
    expect(close.classList.contains("btn")).toBe(true);
    expect(close.classList.contains("btn--text")).toBe(true);
  });

  it("gibt Host- und Sessionnamen einen title, damit ein abgeschnittener Name lesbar bleibt", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["deploy log 2"]), label: "192.0.2.20" });
    const { el } = mount(s);

    expect(el.querySelector<HTMLElement>(".row-host .row-label")!.title).toBe("192.0.2.20");
    // Der Hinweis steht auch am Namen, der den groessten Teil der Zeile deckt:
    // sein eigener `title` verdeckte sonst den der Zeile.
    expect(el.querySelector<HTMLElement>(".row-session .row-label")!.title).toBe(
      "deploy log 2\nClick: open as a new terminal · Ctrl+click: replace the focused terminal",
    );
  });

  it("laesst die Beenden-Rueckfrage Kind der Zeile bleiben, hinter den Aktionen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { el } = mount(s);

    el.querySelector<HTMLButtonElement>(".session-kill-btn")!.click();
    const wrap = el.querySelector<HTMLElement>(".sb-session-row")!;
    expect(Array.from(wrap.children).map((c) => c.className.split(" ")[0])).toEqual([
      "ab-row",
      "session-acts",
      "host-confirm-remove",
    ]);
    expect(wrap.querySelector(".session-confirm-kill")).not.toBeNull();
  });
});

// Task 16, Punkt E: "New session" braucht eine lebende Verbindung. Bis hierher
// stand der Knopf an JEDEM Host, und ein Klick auf einen getrennten lief in
// eine Fehlermeldung, die man erst produzieren musste, um sie zu lesen.
describe("Task 16 E: New session nur bei verbundenem Host", () => {
  function actionButtons(el: HTMLElement): HTMLButtonElement[] {
    return Array.from(el.querySelectorAll<HTMLButtonElement>(".host-actions button"));
  }
  function press(key: string): void {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }

  it("deaktiviert den Knopf an einem getrennten Host und laesst ihn am verbundenen", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "disconnected" });
    const { el } = mount(s);
    const newSession = () => actionButtons(el)[1];
    expect(newSession().getAttribute("aria-label")).toBe("New session");
    expect(newSession().disabled).toBe(true);

    s.setHostState("h1", "connected");
    expect(newSession().disabled).toBe(false);
  });

  // Seit Fixrunde 1 der Aufgabe 19 (F) ist auch "Reload sessions" am getrennten
  // Host deaktiviert: `→` springt vom Umschalter ueber beide hinweg zum ⋯-Knopf.
  it("ueberspringt die deaktivierten Knoepfe beim Roving und laesst ihnen keinen Tabstopp", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "disconnected" });
    const { el } = mount(s);
    const [toggle, newSession, reload, more] = actionButtons(el);

    toggle.focus();
    press("ArrowRight");
    expect(document.activeElement).toBe(more);
    press("ArrowLeft");
    expect(document.activeElement).toBe(toggle);
    press("End");
    expect(document.activeElement).toBe(more);
    press("Home");
    expect(document.activeElement).toBe(toggle);

    // Die deaktivierten Knoepfe stehen in keiner der beiden Mengen -- weder im
    // Roving noch als Tabstopp. Ohne das ausdrueckliche `-1` bliebe eine
    // frueher vergebene `0` an ihnen haengen.
    expect(newSession.tabIndex).toBe(-1);
    expect(reload.tabIndex).toBe(-1);
    expect(actionButtons(el).filter((b) => b.tabIndex === 0)).toEqual([toggle]);
  });
});


describe("mountSidebar: inventory freshness", () => {
  const LIST_EXPLANATION = "Couldn't load the session list. Retry — your terminals keep working.";

  it("shows an initial list failure independently of Online and retries only the list", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setSessionListError("a", { message: "List permission denied" });
    const { el, h } = mount(state);
    const notice = el.querySelector(".session-list-notice")!;
    expect(notice.textContent).toContain("Session list unavailable");
    // UX-Spec §10: sichtbar ist der Satz, der Rohtext steht nur hinter "Details".
    expect(notice.querySelector(".host-notice-message")!.textContent).toBe(LIST_EXPLANATION);
    const detail = notice.querySelector<HTMLElement>(".host-notice-detail")!;
    expect(detail.textContent).toBe("List permission denied");
    expect(detail.hidden).toBe(true);
    expect(el.textContent).not.toContain("No sessions");
    expect(el.querySelector(".state-pill")!.textContent).toContain("Online");
    expect(notice.querySelector("input")).toBeNull();
    notice.querySelector<HTMLButtonElement>("button")!.click();
    expect(h.onReloadSessions).toHaveBeenCalledExactlyOnceWith("a");
    expect(h.onConnectHost).not.toHaveBeenCalled();
    state.setSessions("a", []);
    expect(el.querySelector(".session-list-notice")).toBeNull();
    expect(el.querySelector(".session-list-hint")!.textContent).toBe("No sessions");
  });

  it("keeps last-success time and session rows visible when a reload fails", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setSessions("a", ["one", "two"]);
    const lastSuccess = state.sessionListForHost("a").lastSuccessAt!;
    const { el } = mount(state);
    state.setSessionListError("a", { message: "Incomplete response" });
    const notice = el.querySelector(".session-list-notice")!;
    expect(notice.textContent).toContain("Session list out of date");
    expect(notice.querySelector("time")!.dateTime).toBe(new Date(lastSuccess).toISOString());
    expect(el.querySelectorAll(".sb-session-row")).toHaveLength(2);
    state.setSessions("a", ["one", "two"]);
    expect(el.querySelector(".session-list-notice")).toBeNull();
  });

  it("does not present an unloaded or reconnected list as confirmed empty", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    const { el } = mount(state);
    expect(el.querySelector(".session-list-hint")!.textContent).toBe("Sessions have not been loaded yet.");
    state.setSessions("a", []);
    expect(el.querySelector(".session-list-hint")!.textContent).toBe("No sessions");
    state.setRuntimeId("a", "different-runtime");
    expect(el.querySelector(".session-list-hint")!.textContent).not.toBe("No sessions");
  });

  it("keeps the backend text of a list failure behind Details and in the diagnostics", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText }, configurable: true, writable: true,
    });
    const raw = "The SSH command failed (read, timeout).";
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setSessions("a", ["one"]);
    state.setSessionListError("a", { code: "command_timeout", message: raw });
    const { el } = mount(state);
    const notice = el.querySelector<HTMLElement>(".session-list-notice")!;
    expect(notice.querySelector(".host-notice-message")!.textContent).toBe(LIST_EXPLANATION);
    // Sichtbar ist der Rohtext nirgends: nur im verborgenen Detail.
    const shown = Array.from(notice.querySelectorAll<HTMLElement>("*"))
      .filter((node) => node.closest("[hidden]") === null && node.childElementCount === 0)
      .map((node) => node.textContent ?? "");
    expect(shown.some((text) => text.includes(raw))).toBe(false);
    const details = Array.from(notice.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Details")!;
    details.click();
    expect(notice.querySelector<HTMLElement>(".host-notice-detail")!.hidden).toBe(false);
    Array.from(notice.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Copy diagnostics")!.click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`command_timeout\n${raw}`));
  });

  // UX-Spec §5.3, §5.7: solange die Steuerung nicht bereit ist, sagt ihre
  // ruhige Zeile bzw. ihr Kasten schon, dass die Liste nicht nachkommt. Ein
  // Listenfehler, der nur das meldet, bekommt keinen eigenen Kasten.
  it.each([
    ["self-repairing (quiet line)", (s: AppState) => {
      s.setControlState("a", { generation: 1, state: "degraded", message: "The control connection has ended." });
      s.setControlSelfRepairing("a", true);
    }],
    ["degraded", (s: AppState) => s.setControlState("a", { generation: 1, state: "degraded", message: null })],
    ["reconnecting", (s: AppState) => s.setControlState("a", { generation: 1, state: "reconnecting", message: null })],
    ["authentication_required", (s: AppState) =>
      s.setControlState("a", { generation: 1, state: "authentication_required", message: null })],
  ] as const)("shows no list box for control_unavailable while control is %s", (_label, setup) => {
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setSessions("a", ["one"]);
    setup(state);
    const { el } = mount(state);
    state.setSessionListError("a", {
      code: "control_unavailable", message: "The SSH command failed (admission, unavailable).", controlGeneration: 1,
    });
    expect(el.querySelector(".session-list-notice")).toBeNull();
    expect(el.textContent).not.toContain("The SSH command failed");
    // Die Sessionzeilen bleiben stehen.
    expect(el.querySelectorAll(".sb-session-row")).toHaveLength(1);
  });

  it("shows no hint either while the quiet control line stands", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setControlState("a", { generation: 1, state: "degraded", message: null });
    state.setControlSelfRepairing("a", true);
    state.setSessionListError("a", { code: "control_unavailable", message: "unavailable", controlGeneration: 1 });
    const { el } = mount(state);
    expect(el.querySelector(".control-quiet")!.textContent).toBe("Reconnecting live updates…");
    expect(el.querySelector(".session-list-notice")).toBeNull();
    expect(el.querySelector(".session-list-hint")).toBeNull();
  });

  it("shows the list box for control_unavailable once control is ready, and for other codes meanwhile", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setSessions("a", ["one"]);
    state.setSessionListError("a", { code: "control_unavailable", message: "unavailable" });
    const { el } = mount(state);
    expect(el.querySelector(".session-list-notice .host-notice-message")!.textContent).toBe(LIST_EXPLANATION);

    state.setControlState("a", { generation: 1, state: "degraded", message: null });
    expect(el.querySelector(".session-list-notice")).toBeNull();
    state.setSessionListError("a", { code: "command_timeout", message: "timed out" });
    expect(el.querySelector(".session-list-notice")).not.toBeNull();
  });
});


describe("mountSidebar: explicit control repair", () => {
  async function setupEditor(authKind: "password" | "agent" = "password") {
    const state = new AppState();
    state.upsertHost({ ...host("a"), authKind });
    state.setControlState("a", { generation: 2, state: "degraded", message: "Control unavailable" });
    const onRepairControl = vi.fn();
    const onCancelControlRepair = vi.fn();
    const h = { ...handlers(), onRepairControl, onCancelControlRepair };
    const { el } = mount(state, h);
    el.querySelector<HTMLButtonElement>(".control-notice button")!.click();
    await Promise.resolve(); await Promise.resolve();
    return { state, el, onRepairControl, onCancelControlRepair };
  }

  it("opens an auth-only inline form without starting repair or blocking terminals", async () => {
    const { state, el, onRepairControl } = await setupEditor();
    expect(onRepairControl).not.toHaveBeenCalled();
    expect(el.inert).not.toBe(true);
    const root = el.querySelector<HTMLElement>(".control-repair-form")!;
    for (const name of ["hostname", "user", "port"]) {
      const input = root.querySelector<HTMLInputElement>('input[name="' + name + '"]')!;
      expect(input.disabled).toBe(true);
      expect(input.parentElement!.hidden).toBe(true);
    }
    const password = root.querySelector<HTMLInputElement>('input[name="password"]')!;
    password.value = "fresh-secret";
    state.setSessions("a", ["one"]); // unrelated render retains the same live editor
    expect(el.querySelector('input[name="password"]')).toBe(password);
    expect(password.value).toBe("fresh-secret");
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(onRepairControl).toHaveBeenCalledExactlyOnceWith("a", { kind: "password", password: "fresh-secret" });
    expect(password.value).toBe("");
    expect(el.querySelector(".control-repair-form")).toBeNull();
  });

  it("retains password focus and selection across a list render after changing authentication", async () => {
    const { state, el } = await setupEditor("agent");
    const select = el.querySelector<HTMLSelectElement>('select[name="auth"]')!;
    select.value = "password";
    select.dispatchEvent(new Event("change"));
    const password = el.querySelector<HTMLInputElement>('input[name="password"]')!;
    password.value = "still-typing";
    password.focus();
    password.setSelectionRange(3, 5);
    state.setSessions("a", ["one"]);
    expect(document.activeElement).toBe(password);
    expect(password.value).toBe("still-typing");
    expect([password.selectionStart, password.selectionEnd]).toEqual([3, 5]);
  });

  it.each(["runtime", "ready", "remove"] as const)("disposes secrets on %s change without needing a key event", async (change) => {
    const { state, el } = await setupEditor();
    const password = el.querySelector<HTMLInputElement>('input[name="password"]')!;
    password.value = "do-not-reuse";
    if (change === "runtime") state.setRuntimeId("a", "replacement-runtime");
    else if (change === "ready") state.setControlState("a", { generation: 2, state: "ready", message: null });
    else state.removeHost("a");
    expect(password.value).toBe("");
    expect(el.querySelector(".control-repair-form")).toBeNull();
    if (change === "remove") state.upsertHost({ ...host("a"), authKind: "password" });
    state.setControlState("a", { generation: 3, state: "degraded", message: "new failure" });
    expect(el.querySelector(".control-repair-form")).toBeNull();
  });
});

describe("mountSidebar: kompakte Hinweise (UX-Spec §5.7)", () => {
  const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

  afterEach(() => {
    clipboardWriteText.mockClear();
  });

  function useClipboard(): void {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true,
      writable: true,
    });
  }

  function button(notice: Element, text: string): HTMLButtonElement | undefined {
    return Array.from(notice.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);
  }

  const LONG = "ssh-agent is not reachable. Start the OpenSSH Authentication Agent service " +
    "(Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent) and try again.";
  const EXPLANATION = "The session list and status can't update right now. Your terminals keep working.";
  const LIST_EXPLANATION = "Couldn't load the session list. Retry — your terminals keep working.";

  /** `body`: die auf zwei Zeilen begrenzte Meldung; `detail`: was erst
   * "Details" zeigt. Steuer- und Listenhinweis zeigen den Rohtext des Backends
   * nur dort (UX-Spec §10), der Verbindungshinweis begrenzt seine Meldung
   * selbst. */
  const kinds = {
    connection: {
      setup: (s: AppState) => s.upsertHost({ ...host("h1"), state: "failed", error: LONG }),
      body: LONG, detail: null,
    },
    sessionList: {
      setup: (s: AppState) => {
        s.upsertHost(host("h1"));
        s.setSessionListError("h1", { code: "list_failed", message: LONG });
      },
      body: LIST_EXPLANATION, detail: LONG,
    },
    control: {
      setup: (s: AppState) => {
        s.upsertHost(host("h1"));
        s.setControlState("h1", { generation: 3, state: "degraded", message: LONG });
      },
      body: EXPLANATION, detail: LONG,
    },
  } as const;

  it.each(Object.keys(kinds) as Array<keyof typeof kinds>)(
    "%s: Meldung auf zwei Zeilen begrenzt, Details klappt sie und Copy diagnostics auf",
    (kind) => {
      useClipboard();
      const { setup, body, detail } = kinds[kind];
      const s = new AppState();
      setup(s);
      const { el } = mount(s);
      const notice = () => el.querySelector<HTMLElement>(".host-notice")!;
      const detailText = () => notice().querySelector<HTMLElement>(".host-notice-detail");
      expect(notice().querySelector<HTMLElement>(".host-notice-message")!.textContent).toBe(body);
      if (detail === null) {
        expect(detailText()).toBeNull();
      } else {
        expect(detailText()!.textContent).toBe(detail);
        expect(detailText()!.hidden).toBe(true);
      }
      expect(notice().classList.contains("host-notice--expanded")).toBe(false);
      const copy = () => button(notice(), "Copy diagnostics")!;
      expect(copy().hidden).toBe(true);
      const details = () => button(notice(), "Details")!;
      expect(details().getAttribute("aria-expanded")).toBe("false");
      // Dieselbe Rolle wie "Copy diagnostics", samt Unterstreichung bei Hover.
      expect(details().classList.contains("host-notice-link")).toBe(true);

      details().click();
      expect(notice().classList.contains("host-notice--expanded")).toBe(true);
      expect(details().getAttribute("aria-expanded")).toBe("true");
      expect(copy().hidden).toBe(false);
      if (detail !== null) expect(detailText()!.hidden).toBe(false);
      // Das Neuzeichnen bei jeder Zustandsaenderung klappt nichts wieder zu.
      s.upsertHost({ ...host("h2") });
      expect(notice().classList.contains("host-notice--expanded")).toBe(true);
      if (detail !== null) expect(detailText()!.hidden).toBe(false);
      copy().click();
      expect(clipboardWriteText).toHaveBeenCalledTimes(1);
      expect((clipboardWriteText.mock.calls[0] as [string])[0]).toContain(LONG);

      details().click();
      expect(notice().classList.contains("host-notice--expanded")).toBe(false);
      expect(copy().hidden).toBe(true);
      if (detail !== null) expect(detailText()!.hidden).toBe(true);
    },
  );

  it("ein neuer Hinweis beginnt wieder zugeklappt", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), state: "failed", error: "first failure" });
    const { el } = mount(s);
    button(el.querySelector(".host-notice")!, "Details")!.click();
    s.setHostState("h1", "connected");
    s.setHostState("h1", "failed", "second failure");
    expect(el.querySelector(".host-notice")!.classList.contains("host-notice--expanded")).toBe(false);
  });

  it("die Hauptknoepfe stehen vor Details", () => {
    const s = new AppState();
    kinds.control.setup(s);
    const { el } = mount(s, { ...handlers(), onRepairControl: vi.fn() } as ReturnType<typeof handlers>);
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>(".control-notice button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Restore updates", "Details", "Copy diagnostics"]);
  });
});

describe("mountSidebar: Steuerung und Selbstreparatur (UX-Spec §5.3, §10)", () => {
  it.each([null, "Host unreachable"])("zeigt nach dem Ende der Reihe den Kasten mit den neuen Texten (Meldung %j)", (message) => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setControlState("h1", { generation: 5, state: "degraded", message });
    const { el } = mount(s, { ...handlers(), onRepairControl: vi.fn() } as ReturnType<typeof handlers>);
    const notice = el.querySelector(".control-notice")!;
    expect(notice.querySelector("strong")!.textContent).toBe("Live updates stopped");
    // UX-Spec §10: die Erklaerung traegt den Kasten, der Rohtext steht hinter "Details".
    expect(notice.querySelector(".host-notice-message")!.textContent).toBe(
      "The session list and status can't update right now. Your terminals keep working.",
    );
    expect(notice.querySelector(".host-notice-detail")?.textContent ?? null).toBe(message);
    expect(Array.from(notice.querySelectorAll("button")).map((b) => b.textContent)).toContain("Restore updates");
    expect(el.querySelector(".control-quiet")).toBeNull();
  });

  it.each(["series", "reconnecting"] as const)("zeigt waehrend %s keinen Hinweis auf die alte Sessionliste", (phase) => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.setSessions("h1", ["a"]);
    s.setControlState("h1", { generation: 1, state: phase === "series" ? "degraded" : "reconnecting", message: null });
    if (phase === "series") s.setControlSelfRepairing("h1", true);
    const { el } = mount(s, { ...handlers(), onRepairControl: vi.fn(), onCancelControlRepair: vi.fn() } as ReturnType<typeof handlers>);
    // Die Steuerzeile traegt den Zustand allein; die Sessionzeilen bleiben.
    expect(el.querySelector(".session-list-hint")).toBeNull();
    expect(el.querySelectorAll(".sb-session-row")).toHaveLength(1);
    // Nach der Reihe steht der Kasten, und die Liste ist weiter veraltet.
    s.setControlSelfRepairing("h1", false);
    s.setControlState("h1", { generation: 1, state: "degraded", message: null });
    expect(el.querySelector(".session-list-hint")!.textContent).toBe(
      "Showing the last session list. It has not been refreshed for this connection.",
    );
  });

  it.each(["degraded", "reconnecting"] as const)("zeigt waehrend der Reihe (%s) nur die ruhige Zeile", (control) => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setControlState("h1", { generation: 1, state: control, message: "Control connection lost" });
    s.setControlSelfRepairing("h1", true);
    const { el } = mount(s);
    const quiet = el.querySelector<HTMLElement>(".control-quiet")!;
    expect(quiet.textContent).toBe("Reconnecting live updates…");
    expect(quiet.querySelector(".ind-connecting")!.getAttribute("aria-hidden")).toBe("true");
    expect(quiet.querySelector("button")).toBeNull();
    expect(el.querySelector(".control-notice")).toBeNull();
    s.setControlSelfRepairing("h1", false);
    expect(el.querySelector(".control-quiet")).toBeNull();
    expect(el.querySelector(".control-notice")).not.toBeNull();
  });

  it("die ruhige Zeile verschwindet mit ready und an einem getrennten Host", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setControlState("h1", { generation: 1, state: "degraded", message: null });
    s.setControlSelfRepairing("h1", true);
    const { el } = mount(s);
    s.setControlState("h1", { generation: 2, state: "ready", message: null });
    expect(el.querySelector(".control-quiet")).toBeNull();
    s.setControlState("h1", { generation: 2, state: "degraded", message: null });
    s.setControlSelfRepairing("h1", true);
    s.setHostState("h1", "failed", "lost");
    expect(el.querySelector(".control-quiet")).toBeNull();
  });

  it("openControlRepair zeigt das Formular, ohne den Fokus zu nehmen", async () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), authKind: "key", keyPath: "C:/keys/id_ed25519" });
    s.setControlState("h1", { generation: 1, state: "authentication_required", message: "Passphrase required" });
    const onRepairControl = vi.fn();
    const { el } = mount(s, { ...handlers(), onRepairControl } as ReturnType<typeof handlers>);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    handles[handles.length - 1].openControlRepair("h1");
    const form = el.querySelector<HTMLElement>(".control-notice .control-repair-form")!;
    expect(form).not.toBeNull();
    // Die Vorauswahl des Schluessels (und damit das Passphrasenfeld) kommt
    // nach der Schluesselliste.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(form.querySelector('input[name="passphrase"]')).not.toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(onRepairControl).not.toHaveBeenCalled();
  });
});

// UX-Spec §5.4, §5.7: waehrend die App einen Host nach einem Verlust der
// Terminalverbindung selbst neu verbindet, steht unter der Hostzeile die
// ruhige Zeile "Reconnecting…" statt des Kastens mit "Retry".
describe("mountSidebar: Neuverbinden eines Hosts (UX-Spec §5.4)", () => {
  function lostHost(): AppState {
    const s = new AppState();
    s.upsertHost({ ...host("h1", ["a"]), state: "failed", error: "The terminal connection was lost." });
    return s;
  }
  function pill(el: HTMLElement): HTMLElement {
    return el.querySelector<HTMLElement>('[data-host-id="h1"] .state-pill')!;
  }

  it("zeigt die ruhige Zeile statt des Kastens und zwischen zwei Versuchen Offline statt Failed", () => {
    const s = lostHost();
    const { el } = mount(s);
    expect(el.querySelector(".host-notice")).not.toBeNull();
    s.setHostReconnecting("h1", true);
    const quiet = el.querySelector<HTMLElement>(".host-quiet")!;
    expect(quiet.textContent).toBe("Reconnecting…");
    expect(quiet.querySelector(".ind-connecting")!.getAttribute("aria-hidden")).toBe("true");
    expect(quiet.querySelector("button")).toBeNull();
    expect(el.querySelector(".host-notice")).toBeNull();
    expect(pill(el).textContent).toBe("Offline");
    expect(pill(el).querySelector(".ind-off")).not.toBeNull();
    // Zwischen zwei Versuchen ist "Connect" der Weg von Hand.
    expect(Array.from(el.querySelectorAll(".host-action-btn")).map((b) => b.textContent)).toContain("Connect");
  });

  it("zeigt waehrend eines Versuchs Connecting… und die ruhige Zeile", () => {
    const s = lostHost();
    s.setHostReconnecting("h1", true);
    s.setHostState("h1", "connecting");
    const { el } = mount(s);
    expect(el.querySelector(".host-quiet")).not.toBeNull();
    expect(pill(el).textContent).toBe("Connecting…");
    expect(el.querySelector(".host-notice")).toBeNull();
  });

  it("zeigt nach dem Ende der Reihe wieder den Kasten mit Retry", () => {
    const s = lostHost();
    s.setHostReconnecting("h1", true);
    const { el } = mount(s);
    s.setHostReconnecting("h1", false);
    expect(el.querySelector(".host-quiet")).toBeNull();
    expect(el.querySelector(".host-notice")!.textContent).toContain("The terminal connection was lost.");
    expect(Array.from(el.querySelectorAll(".host-notice button")).map((b) => b.textContent)).toContain("Retry");
    expect(pill(el).textContent).toBe("Failed");
  });

  it("zeigt die offenen Sessions eines neu verbindenden Hosts ohne Warnung", () => {
    const s = lostHost();
    s.hosts[0].sessions[0].open = true;
    s.lockInput("h1", "a");
    const { el } = mount(s);
    const row = () => el.querySelector<HTMLElement>('[data-session-key="h1/a"]')!;
    // Ohne Reihe: der Kanal ist fort, die Zeile warnt "Disconnected".
    expect(row().querySelector(".ind-warn")).not.toBeNull();
    s.setHostReconnecting("h1", true);
    // Waehrend der Reihe ruhig wie Hostzeile und Kachel: keine Warnung.
    expect(row().querySelector(".ind-warn")).toBeNull();
    expect(row().querySelector(".row-state-word")!.textContent).toBe("Open");
    // Endet die Reihe ohne Verbindung, warnt die Zeile wieder.
    s.setHostReconnecting("h1", false);
    expect(row().querySelector(".ind-warn")).not.toBeNull();
  });

  it("nimmt die ruhige Zeile weg, sobald der Host verbunden ist", () => {
    const s = lostHost();
    s.setHostReconnecting("h1", true);
    const { el } = mount(s);
    s.setHostState("h1", "connected");
    expect(el.querySelector(".host-quiet")).toBeNull();
    expect(pill(el).textContent).toBe("Online");
  });
});
