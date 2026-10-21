// Gegenprobe fuer `src/views/quick-open.ts` (UX-Spec §7.5): die Eintraege aus
// `AppState`, der Filter und der Dialog in der echten Dialoghuelle
// (`mountDialogShell`, kein Nachbau) -- Fokus, Pfeiltasten, Enter, Klick,
// Escape und die ARIA-Verweise. Was eine Aktion danach bewirkt, prueft
// `main.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppState, type Host, type HostState } from "../state/app-state";
import { DEFAULT_KEYMAP } from "../keymap";
import { focusableElements, mountDialogShell, type DialogShell } from "./dialog";
import { filterQuickOpen, openQuickOpen, quickOpenItems, quickOpenLabels, type QuickOpenItem } from "./quick-open";

function makeHost(id: string, label: string, state: HostState, hostname = `${id}.example`): Host {
  return {
    id,
    runtimeId: state === "connected" ? `r-${id}` : null,
    label,
    hostname,
    user: "root",
    port: 22,
    keyPath: null,
    authKind: "agent",
    state,
    error: null,
    sessions: [],
    expanded: true,
    lastCwd: "",
  };
}

/** Drei Hosts in Seitenleistenreihenfolge: alpha verbunden ("db" wartet),
 * beta getrennt (seine wartende Session darf NICHT erscheinen), gamma
 * verbunden (eine wartende Session). */
function world(): AppState {
  const state = new AppState();
  state.upsertHost(makeHost("a", "alpha", "connected", "192.0.2.20"));
  state.upsertHost(makeHost("b", "beta", "disconnected", "192.0.2.21"));
  state.upsertHost(makeHost("g", "gamma", "connected", "192.0.2.22"));
  state.setSessionRecords("a", [
    { name: "web-api", status: "busy" },
    { name: "db", status: "waiting" },
    { name: "web-ui", status: "idle" },
  ]);
  state.setSessionRecords("b", [{ name: "offline-one", status: "waiting" }]);
  state.setSessionRecords("g", [{ name: "agent", status: "waiting" }]);
  return state;
}

/** Kurzform eines Eintrags fuer lesbare Zusicherungen ueber die Reihenfolge. */
function summary(item: QuickOpenItem): string {
  switch (item.kind) {
    case "session":
      return `session ${item.hostLabel}/${item.name}`;
    case "connect":
      return `connect ${item.hostLabel}`;
    case "newSession":
      return `new ${item.hostLabel}`;
    case "action":
      return `action ${item.id}`;
  }
}

const ACTIONS = ["action settings", "action toggleSidebar"];

describe("quickOpenItems (UX-Spec §7.5)", () => {
  it("wartende Sessions zuerst, dann die uebrigen verbundener Hosts, dann Hosts, dann Aktionen", () => {
    const items = quickOpenItems(world(), quickOpenLabels());
    expect(items.map(summary)).toEqual([
      "session alpha/db",
      "session gamma/agent",
      "session alpha/web-api",
      "session alpha/web-ui",
      "new alpha",
      "connect beta",
      "new gamma",
      ...ACTIONS,
    ]);
  });

  it("ein festgehaltenes 'waiting' ist Geschichte: kein Platz vorn, die Pille sagt es", () => {
    const state = world();
    state.markStatusStale("g");
    const items = quickOpenItems(state, quickOpenLabels());
    expect(items.map(summary).slice(0, 4)).toEqual([
      "session alpha/db",
      "session alpha/web-api",
      "session alpha/web-ui",
      "session gamma/agent",
    ]);
    const agent = items[3];
    if (agent.kind !== "session") throw new Error("expected a session");
    expect(agent.status).toBe("waiting");
    // Dieselbe Regel wie Seitenleiste und Kachel (`agentStatusView`).
    expect(agent.pill?.kind).toBe("stale");
  });

  it("Host offline oder fehlgeschlagen: 'Connect', verbunden: 'New session', waehrend des Verbindens nichts", () => {
    const state = world();
    state.upsertHost(makeHost("c", "delta", "connecting"));
    state.upsertHost(makeHost("f", "epsilon", "failed"));
    const hosts = quickOpenItems(state, quickOpenLabels())
      .filter((item) => item.kind === "connect" || item.kind === "newSession")
      .map(summary);
    expect(hosts).toEqual(["new alpha", "connect beta", "new gamma", "connect epsilon"]);
  });

  it("Aktionen mit Beschriftung, Kuerzel nur fuer Settings und Toggle sidebar", () => {
    const actions = quickOpenItems(new AppState(), quickOpenLabels());
    expect(actions).toEqual([
      { kind: "action", id: "settings", label: "Settings", shortcut: "Ctrl+," },
      { kind: "action", id: "toggleSidebar", label: "Toggle sidebar", shortcut: "Ctrl+Shift+B" },
    ]);
  });

  it("die Kuerzel kommen aus der uebergebenen Tabelle, nicht aus einem Literal", () => {
    const labels = quickOpenLabels({ ...DEFAULT_KEYMAP, "settings.open": "Ctrl+Shift+O", "sidebar.toggle": "Ctrl+Shift+J" });
    const shortcuts = quickOpenItems(new AppState(), labels).map((item) => (item.kind === "action" ? item.shortcut : null));
    expect(shortcuts).toEqual(["Ctrl+Shift+O", "Ctrl+Shift+J"]);
  });
});

describe("filterQuickOpen (UX-Spec §7.5)", () => {
  const items = quickOpenItems(world(), quickOpenLabels());

  it("jeder Begriff muss vorkommen, Gross/Klein egal", () => {
    expect(filterQuickOpen(items, "WEB ui").map(summary)).toEqual(["session alpha/web-ui"]);
    expect(filterQuickOpen(items, "web").map(summary)).toEqual(["session alpha/web-api", "session alpha/web-ui"]);
    expect(filterQuickOpen(items, "web zzz")).toEqual([]);
    expect(filterQuickOpen(items, "TOGGLE SIDE").map(summary)).toEqual(["action toggleSidebar"]);
  });

  it("prueft den Text samt Host daneben und den Hostnamen, nicht nur das Label", () => {
    expect(filterQuickOpen(items, "gamma agent").map(summary)).toEqual(["session gamma/agent"]);
    expect(filterQuickOpen(items, "192.0.2.22").map(summary)).toEqual(["session gamma/agent", "new gamma"]);
    expect(filterQuickOpen(items, "connect").map(summary)).toEqual(["connect beta"]);
    expect(filterQuickOpen(items, "192.0.2.21").map(summary)).toEqual(["connect beta"]);
    expect(filterQuickOpen(items, "new session").map(summary)).toEqual(["new alpha", "new gamma"]);
  });

  it("eine leere Anfrage liefert alles in der Reihenfolge der Eintraege", () => {
    expect(filterQuickOpen(items, "   ")).toEqual(items);
  });

  it("hoechstens 50 Eintraege, wenn nichts anderes verlangt ist", () => {
    const state = new AppState();
    state.upsertHost(makeHost("a", "alpha", "connected"));
    state.setSessions("a", Array.from({ length: 60 }, (_, i) => `s${i}`));
    const many = quickOpenItems(state, quickOpenLabels());
    expect(many).toHaveLength(63);
    const shown = filterQuickOpen(many, "");
    expect(shown).toHaveLength(50);
    expect(summary(shown[49])).toBe("session alpha/s49");
    expect(filterQuickOpen(many, "s", 3)).toHaveLength(3);
  });
});

describe("openQuickOpen (UX-Spec §7.5, §11)", () => {
  let shell: DialogShell;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app"><button type="button" id="opener">Open</button></div>
      <div id="dialog-root"></div>
    `;
    shell = mountDialogShell(document.getElementById("dialog-root")!, document.getElementById("app")!);
    opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
  });

  afterEach(() => {
    // Eine offen gebliebene Ueberlagerung naehme ihren Escape-Horcher sonst
    // nicht vom `document`.
    shell.closeDialog();
    document.body.replaceChildren();
  });

  function open(items: QuickOpenItem[], initialQuery?: string) {
    const onRun = vi.fn();
    openQuickOpen({ openDialog: shell.openDialog, items, initialQuery, onRun });
    return onRun;
  }

  function input(): HTMLInputElement {
    const el = document.querySelector<HTMLInputElement>(".dialog-panel .quick-open-input");
    if (!el) throw new Error("quick open is not open");
    return el;
  }

  function listbox(): HTMLElement {
    return document.querySelector<HTMLElement>('.dialog-panel [role="listbox"]')!;
  }

  function options(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.dialog-panel [role="option"]'));
  }

  function labels(): string[] {
    return options().map((option) => option.querySelector(".quick-open-label")?.textContent ?? "");
  }

  function selected(): HTMLElement[] {
    return options().filter((option) => option.getAttribute("aria-selected") === "true");
  }

  function press(key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    return event;
  }

  function type(text: string): void {
    input().value = text;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Genau ein Eintrag ist gewaehlt, und das Feld verweist auf ihn. */
  function expectSelected(label: string): void {
    const chosen = selected();
    expect(chosen).toHaveLength(1);
    expect(chosen[0].querySelector(".quick-open-label")?.textContent).toBe(label);
    expect(chosen[0].id).not.toBe("");
    expect(input().getAttribute("aria-activedescendant")).toBe(chosen[0].id);
  }

  it("oeffnet 'Quick open' ueber die Dialoghuelle: Fokus im Feld, listbox mit option, erster Eintrag gewaehlt", () => {
    const items = quickOpenItems(world(), quickOpenLabels());
    open(items);

    expect(document.querySelector(".dialog-panel .dialog-head h2")?.textContent).toBe("Quick open");
    expect(document.getElementById("app")!.inert).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-controls")).toBe(listbox().id);
    expect(listbox().id).not.toBe("");
    expect(options()).toHaveLength(items.length);
    expectSelected("db");
    // Die Eintraege sind keine Tab-Halte: in der Fokus-Falle stehen nur das
    // Schliessen-Kreuz und das Feld.
    const panel = document.querySelector<HTMLElement>(".dialog-panel")!;
    expect(focusableElements(panel)).toEqual([panel.querySelector(".dialog-close-btn"), input()]);
    // Jede Option hat ihre eigene ID.
    expect(new Set(options().map((option) => option.id)).size).toBe(items.length);
  });

  it("Pfeil runter und hoch bewegen die Auswahl mit Umlauf, aria-activedescendant folgt", () => {
    open(quickOpenItems(world(), quickOpenLabels()));

    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expectSelected("agent");
    press("ArrowUp");
    expectSelected("db");
    expect(press("ArrowUp").defaultPrevented).toBe(true);
    expectSelected("Toggle sidebar");
    press("ArrowDown");
    expectSelected("db");
  });

  it("Enter schliesst den Dialog und fuehrt dann den gewaehlten Eintrag aus", () => {
    const items = quickOpenItems(world(), quickOpenLabels());
    const onRun = open(items);
    const seen: Array<{ open: boolean; focus: Element | null }> = [];
    onRun.mockImplementation(() => {
      seen.push({ open: document.querySelector(".dialog-panel") !== null, focus: document.activeElement });
    });

    press("ArrowDown");
    expect(press("Enter").defaultPrevented).toBe(true);

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(items[1], { replace: false });
    // Erst zu, dann die Aktion: sie laeuft in der App, nicht hinter dem Scrim,
    // und der Fokus steht schon wieder dort, woher der Dialog kam.
    expect(seen).toEqual([{ open: false, focus: opener }]);
    expect(document.getElementById("app")!.inert).toBe(false);
  });

  it("ein Klick auf einen Eintrag fuehrt ihn aus", () => {
    const items = quickOpenItems(world(), quickOpenLabels());
    const onRun = open(items);

    options()[4].click();

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(items[4], { replace: false });
    expect(document.querySelector(".dialog-panel")).toBeNull();
  });

  it("Strg+Enter und Strg+Klick bitten um Ersetzen, Enter und Klick nicht (Spec 2026-10-19 §5.2)", () => {
    const items = quickOpenItems(world(), quickOpenLabels());
    let onRun = open(items);
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(onRun).toHaveBeenCalledExactlyOnceWith(items[0], { replace: true });

    onRun = open(items);
    options()[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(onRun).toHaveBeenCalledExactlyOnceWith(items[1], { replace: true });
  });

  // Ein `mousedown` ausserhalb eines fokussierbaren Elements legt den Fokus auf
  // <body>, danach liefen Tippen und Pfeiltasten ins Leere. jsdom bewegt den
  // Fokus bei `mousedown` nicht selbst; geprueft wird deshalb, welcher Druck
  // verhindert wird -- genau das haelt am Fenster den Fokus im Feld.
  it("ein Druck neben das Feld laesst den Fokus darin; nur Feld und Liste selbst (Scrollbalken) behalten ihren Druck", () => {
    open(quickOpenItems(world(), quickOpenLabels()));
    const prevented = (target: Element): boolean => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const body = document.querySelector<HTMLElement>(".dialog-panel .dialog-body")!;
    const root = document.querySelector<HTMLElement>(".dialog-panel .quick-open")!;

    // Das Polster des Dialogs, die Luecke zwischen Feld und Liste, eine Zeile.
    expect(prevented(body)).toBe(true);
    expect(prevented(root)).toBe(true);
    expect(prevented(options()[2].querySelector(".quick-open-label")!)).toBe(true);
    // Ein Druck auf den Scrollbalken trifft die Liste selbst; Blink reicht ihn
    // nur bei unverhindertem `mousedown` an den Scrollbalken weiter.
    expect(prevented(listbox())).toBe(false);
    // Im Feld setzt der Druck die Schreibmarke und markiert Text.
    expect(prevented(input())).toBe(false);

    type("zzz");
    expect(prevented(document.querySelector(".dialog-panel .quick-open-empty")!)).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("Escape schliesst, ohne etwas auszufuehren", () => {
    const onRun = open(quickOpenItems(world(), quickOpenLabels()));

    press("Escape");

    expect(document.querySelector(".dialog-panel")).toBeNull();
    expect(onRun).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("Tippen filtert; ohne Treffer steht 'No matches', nichts ist gewaehlt und Enter tut nichts", () => {
    const onRun = open(quickOpenItems(world(), quickOpenLabels()));
    const empty = document.querySelector<HTMLElement>(".dialog-panel .quick-open-empty")!;
    expect(empty.textContent).toBe("");

    type("web ui");
    expect(labels()).toEqual(["web-ui"]);
    expectSelected("web-ui");

    type("zzz");
    expect(options()).toHaveLength(0);
    expect(listbox().hidden).toBe(true);
    expect(empty.textContent).toBe("No matches");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    press("Enter");
    press("ArrowDown");
    expect(onRun).not.toHaveBeenCalled();
    expect(document.querySelector(".dialog-panel")).not.toBeNull();

    // Eine neue Eingabe faengt wieder beim ersten Treffer an.
    type("");
    expect(empty.textContent).toBe("");
    expect(listbox().hidden).toBe(false);
    expectSelected("db");
  });

  // Review zu Task 15: eine Live-Region, die mitsamt ihrem Inhalt eingefuegt
  // wird, sagen Screenreader oft nicht an. "No matches" steht deshalb in einer
  // Statusregion, die den ganzen Dialog ueber im Baum bleibt und nur ihren Text
  // wechselt.
  it("'No matches' steht in einer bleibenden Statusregion, die nur ihren Text wechselt", () => {
    open(quickOpenItems(world(), quickOpenLabels()));
    const status = (): HTMLElement | null => document.querySelector<HTMLElement>('.dialog-panel [role="status"]');
    const region = status()!;
    expect(region.classList.contains("quick-open-empty")).toBe(true);
    expect(region.hidden).toBe(false);
    expect(region.textContent).toBe("");

    type("zzz");
    expect(status()).toBe(region);
    expect(region.textContent).toBe("No matches");

    type("db");
    expect(status()).toBe(region);
    expect(region.textContent).toBe("");
  });

  it("die Vorgabe steht im Feld und filtert sofort", () => {
    open(quickOpenItems(world(), quickOpenLabels()), "New session");

    expect(input().value).toBe("New session");
    expect(labels()).toEqual(["New session on alpha", "New session on gamma"]);
    expectSelected("New session on alpha");
  });

  it("zeigt hoechstens 50 Eintraege", () => {
    const state = new AppState();
    state.upsertHost(makeHost("a", "alpha", "connected"));
    state.setSessions("a", Array.from({ length: 60 }, (_, i) => `s${i}`));
    open(quickOpenItems(state, quickOpenLabels()));

    expect(options()).toHaveLength(50);
  });

  it("Session: Name, daneben der Host gedaempft und die Statuspille; Hosts und Aktionen mit ihrem Text", () => {
    open(quickOpenItems(world(), quickOpenLabels()));
    const byLabel = (label: string) => options().find((o) => o.querySelector(".quick-open-label")?.textContent === label)!;

    const db = byLabel("db");
    expect(db.querySelector(".quick-open-host")?.textContent).toBe("alpha");
    expect(db.querySelector(".st.st-waiting")?.textContent).toBe("Waiting");

    expect(byLabel("Connect beta").querySelector(".quick-open-host")).toBeNull();
    expect(byLabel("New session on gamma")).toBeDefined();
    expect(byLabel("Settings").querySelector("kbd")?.textContent).toBe("Ctrl+,");
    expect(byLabel("Toggle sidebar").querySelector("kbd")?.textContent).toBe("Ctrl+Shift+B");
  });
});
