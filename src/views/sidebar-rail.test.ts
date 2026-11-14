// Symbolleiste der eingeklappten Seitenleiste (Spec 2026-11-14 §2).
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppState, type Host } from "../state/app-state";
import { mountSidebarRail, type SidebarRailHandle } from "./sidebar-rail";

function host(id: string, sessions: string[] = [], patch: Partial<Host> = {}): Host {
  return {
    id, runtimeId: `r-${id}`, label: id, hostname: "192.0.2.10", user: "u", port: 22, keyPath: null,
    authKind: "agent",
    state: "connected", error: null, expanded: true, lastCwd: "/tmp",
    sessions: sessions.map((name) => ({ name, hostId: id, open: false, inputLocked: false })),
    ...patch,
  };
}

function handlers() {
  return { onExpand: vi.fn(), onShowHost: vi.fn(), onNextWaiting: vi.fn(), onOpenSettings: vi.fn() };
}

const handles: SidebarRailHandle[] = [];

/** `#app` mit `#sidebar` und `#grid` wie in index.html; die Leiste haengt sich
 * hinter `#sidebar`. `shown` nimmt ihr gleich das `hidden`. */
function mount(state: AppState, shown = true, h = handlers()) {
  const app = document.createElement("div");
  app.id = "app";
  const sidebar = document.createElement("div");
  sidebar.id = "sidebar";
  const grid = document.createElement("div");
  grid.id = "grid";
  app.append(sidebar, grid);
  document.body.appendChild(app);
  const handle = mountSidebarRail(sidebar, state, h);
  handles.push(handle);
  if (shown) handle.setHidden(false);
  const rail = app.querySelector<HTMLElement>(".sb-rail")!;
  return { app, sidebar, grid, rail, handle, h };
}

const hostButtons = (rail: HTMLElement) => Array.from(rail.querySelectorAll<HTMLButtonElement>(".sb-rail-host"));
const waitingButton = (rail: HTMLElement) => rail.querySelector<HTMLButtonElement>(".sb-rail-waiting")!;

/** Zwei Hosts, auf h1 wartet eine Session mit aktuellem Status. */
function stateWithWaiting(): AppState {
  const s = new AppState();
  s.upsertHost(host("h1", ["a", "b"], { label: "build-box" }));
  s.upsertHost(host("h2", ["c"], { label: "gpu-lab" }));
  s.setSessionRecords("h1", [{ name: "a", status: "waiting" }, { name: "b", status: "busy" }], Date.now());
  s.setSessionRecords("h2", [{ name: "c", status: "busy" }], Date.now());
  return s;
}

afterEach(() => {
  while (handles.length > 0) handles.pop()!.dispose();
  document.body.replaceChildren();
});

describe("sidebar-rail: Aufbau", () => {
  it("haengt als eigenes Kind hinter #sidebar und beginnt verborgen", () => {
    const { app, rail } = mount(new AppState(), false);
    expect(Array.from(app.children).map((c) => c.id || c.className)).toEqual(["sidebar", "sb-rail", "grid"]);
    expect(rail.hidden).toBe(true);
    expect(rail.getAttribute("role")).toBe("group");
    expect(rail.getAttribute("aria-label")).toBe("Sidebar, collapsed");
  });

  it("von oben: Zaehler, Hosts, unten Einstellungen, Marke und Ausklappen", () => {
    const { rail } = mount(new AppState());
    expect(Array.from(rail.children).map((c) => c.className)).toEqual(["sb-rail-waiting", "sb-rail-hosts", "sb-rail-bottom"]);
    const bottom = Array.from(rail.querySelectorAll<HTMLButtonElement>(".sb-rail-bottom > button"));
    expect(bottom.map((b) => b.title)).toEqual(["Settings (Ctrl+,)", "About aidevbridge", "Expand sidebar (Ctrl+Shift+B)"]);
    // Der zugaengliche Name ist die blosse Beschriftung, ohne Kuerzel.
    expect(bottom.map((b) => b.querySelector(".ab-visually-hidden")?.textContent)).toEqual([
      "Settings",
      "About aidevbridge",
      "Expand sidebar",
    ]);
    expect(bottom[1].querySelector(".sb-brand-mark[aria-hidden='true']")).not.toBeNull();
    expect(bottom[2].classList.contains("sb-rail-expand")).toBe(true);
    for (const button of bottom) expect(button.type).toBe("button");
  });

  it("die unteren Knoepfe melden: Einstellungen ohne Bereich, Marke mit About, Ausklappen", () => {
    const { rail, h } = mount(new AppState());
    const [settings, brand, expand] = Array.from(rail.querySelectorAll<HTMLButtonElement>(".sb-rail-bottom > button"));
    settings.click();
    expect(h.onOpenSettings.mock.calls[0]).toEqual([]);
    brand.click();
    expect(h.onOpenSettings).toHaveBeenLastCalledWith("about");
    expand.click();
    expect(h.onExpand).toHaveBeenCalledTimes(1);
  });
});

describe("sidebar-rail: Hosts", () => {
  it("je Host ein Knopf mit Kuerzel, Zustandsform und dem Wort dazu in Name und Tooltip", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"], { label: "build-box" }));
    s.upsertHost(host("h2", [], { label: "home-nas", state: "disconnected" }));
    s.upsertHost(host("h3", ["x"], { label: "gpu-lab", state: "failed", error: "boom" }));
    s.upsertHost(host("h4", [], { label: "edge", state: "connecting" }));
    const { rail } = mount(s);
    const buttons = hostButtons(rail);
    expect(buttons.map((b) => b.dataset.hostId)).toEqual(["h1", "h2", "h3", "h4"]);
    expect(buttons.map((b) => b.querySelector(".sb-avatar")?.textContent)).toEqual(["BB", "HN", "GL", "ED"]);
    expect(buttons.map((b) => b.title)).toEqual([
      "build-box: Online, 2 sessions",
      "home-nas: Offline",
      "gpu-lab: Failed, 1 session",
      "edge: Connecting…",
    ]);
    // Der Name des Knopfs ist derselbe Satz wie der Tooltip.
    expect(buttons.map((b) => b.querySelector(".ab-visually-hidden")?.textContent)).toEqual(buttons.map((b) => b.title));
    // Zustand nie ueber die Farbe allein: je Zustand eine eigene Form.
    expect(buttons.map((b) => b.querySelector(".sb-rail-state > span")?.className)).toEqual([
      "ind ind-sm ind-on",
      "ind ind-sm ind-off",
      "ind ind-fail",
      "ind ind-connecting",
    ]);
    expect(buttons.map((b) => b.dataset.state)).toEqual(["connected", "disconnected", "failed", "connecting"]);
    // Quadrat und Formen sind Schmuck neben dem Text.
    for (const button of buttons) {
      expect(button.querySelector(".sb-avatar")?.getAttribute("aria-hidden")).toBe("true");
      expect(button.querySelector(".sb-rail-state")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("ein Klick meldet den Host", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { rail, h } = mount(s);
    hostButtons(rail)[1].click();
    expect(h.onShowHost).toHaveBeenCalledTimes(1);
    expect(h.onShowHost).toHaveBeenCalledWith("h2");
  });

  it("ein Host mit wartender Session traegt die Raute und nennt die Zahl statt der Sessions", () => {
    const { rail } = mount(stateWithWaiting());
    const [first, second] = hostButtons(rail);
    expect(first.querySelector<HTMLElement>(".sb-rail-flag")!.hidden).toBe(false);
    expect(first.querySelector(".sb-rail-flag .ag-waiting")).not.toBeNull();
    expect(first.title).toBe("build-box: Online, 1 waiting");
    expect(second.querySelector<HTMLElement>(".sb-rail-flag")!.hidden).toBe(true);
    expect(second.title).toBe("gpu-lab: Online, 1 session");
  });

  it("der Host der fokussierten Kachel ist als aktuell markiert", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2", ["c"]));
    const { rail } = mount(s);
    expect(hostButtons(rail).map((b) => b.getAttribute("aria-current"))).toEqual([null, null]);
    s.openSession("h2", "c");
    expect(hostButtons(rail).map((b) => b.getAttribute("aria-current"))).toEqual([null, "true"]);
  });

  // Ein Knopf, der zwischen Druecken und Loslassen aus dem Dokument faellt,
  // bekommt keinen Klick: die Leiste baut bei einer Benachrichtigung nicht neu.
  it("behaelt bei jeder Benachrichtigung dieselben Knoepfe und aendert nur ihren Inhalt", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"], { label: "build-box" }));
    s.upsertHost(host("h2", [], { label: "gpu-lab" }));
    const { rail } = mount(s);
    const before = hostButtons(rail);
    before[0].focus();

    s.setHostState("h1", "disconnected");
    s.upsertHost(host("h2", ["c"], { label: "gpu-lab" }));

    const after = hostButtons(rail);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(document.activeElement).toBe(before[0]);
    expect(after[0].title).toBe("build-box: Offline, 1 session");
    expect(after[1].title).toBe("gpu-lab: Online, 1 session");
  });

  // UX-Spec §5.4, wie die Hostzeile: verbindet die App selbst neu, steht
  // zwischen zwei Versuchen die Form von "Offline" statt des Dreiecks.
  it("waehrend des Neuverbindens zeigt ein gescheiterter Host die Form von Offline und sagt Reconnecting", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"], { label: "build-box", state: "failed", error: "boom" }));
    s.upsertHost(host("h2", [], { label: "gpu-lab", state: "connecting" }));
    s.upsertHost(host("h3", [], { label: "home-nas" }));
    const { rail } = mount(s);
    expect(hostButtons(rail)[0].title).toBe("build-box: Failed, 1 session");

    s.setHostReconnecting("h1", true);
    s.setHostReconnecting("h2", true);
    s.setHostReconnecting("h3", true);

    const [failed, connecting, connected] = hostButtons(rail);
    expect(failed.querySelector(".sb-rail-state > span")?.className).toBe("ind ind-sm ind-off");
    expect(failed.dataset.state).toBe("disconnected");
    expect(failed.title).toBe("build-box: Reconnecting…, 1 session");
    // Ein laufender Versuch behaelt seine Form.
    expect(connecting.querySelector(".sb-rail-state > span")?.className).toBe("ind ind-connecting");
    expect(connecting.title).toBe("gpu-lab: Reconnecting…");
    // Ein verbundener Host verbindet nicht neu, was auch vermerkt ist.
    expect(connected.title).toBe("home-nas: Online");

    s.setHostReconnecting("h1", false);
    expect(hostButtons(rail)[0].title).toBe("build-box: Failed, 1 session");
    expect(hostButtons(rail)[0].querySelector(".sb-rail-state > span")?.className).toBe("ind ind-fail");
  });

  // Die Knoepfe dahinter bleiben, wo sie sind: umgehaengt wird nur, was nicht
  // schon an seiner Stelle steht.
  it("faellt der erste Host weg, wird kein anderer Knopf umgehaengt", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    s.upsertHost(host("h3"));
    const { rail } = mount(s);
    const hostsEl = rail.querySelector<HTMLElement>(".sb-rail-hosts")!;
    const insertBefore = vi.spyOn(hostsEl, "insertBefore");

    s.removeHost("h1");

    expect(hostButtons(rail).map((b) => b.dataset.hostId)).toEqual(["h2", "h3"]);
    expect(insertBefore).not.toHaveBeenCalled();
  });

  it("ein neuer Host kommt hinten dazu, ein entfernter verschwindet; die uebrigen bleiben", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.upsertHost(host("h2"));
    const { rail } = mount(s);
    const [first, second] = hostButtons(rail);
    s.upsertHost(host("h3"));
    expect(hostButtons(rail).map((b) => b.dataset.hostId)).toEqual(["h1", "h2", "h3"]);
    s.removeHost("h1");
    const left = hostButtons(rail);
    expect(left.map((b) => b.dataset.hostId)).toEqual(["h2", "h3"]);
    expect(left[0]).toBe(second);
    expect(first.isConnected).toBe(false);
  });
});

describe("sidebar-rail: Zaehler der Wartenden", () => {
  it("ohne Wartende ist er nicht da", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const { rail } = mount(s);
    expect(waitingButton(rail).hidden).toBe(true);
  });

  it("zeigt Raute und Zahl, nennt die Zahl mit Wort und Kuerzel und springt zur naechsten", () => {
    const { rail, h } = mount(stateWithWaiting());
    const button = waitingButton(rail);
    expect(button.hidden).toBe(false);
    expect(button.querySelector(".ag-waiting")).not.toBeNull();
    expect(button.querySelector(".sb-rail-count")?.textContent).toBe("1");
    expect(button.querySelector(".sb-rail-count")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.querySelector(".ab-visually-hidden")?.textContent).toBe("1 waiting");
    expect(button.title).toBe("1 waiting (Ctrl+Shift+A)");
    button.click();
    expect(h.onNextWaiting).toHaveBeenCalledTimes(1);
  });

  it("folgt dem Zustand: eine zweite Wartende zaehlt mit, ohne Wartende verschwindet er", () => {
    const s = stateWithWaiting();
    const { rail } = mount(s);
    const button = waitingButton(rail);
    s.setSessionRecords("h2", [{ name: "c", status: "waiting" }], Date.now());
    expect(waitingButton(rail)).toBe(button);
    expect(button.querySelector(".sb-rail-count")?.textContent).toBe("2");
    s.setSessionRecords("h1", [{ name: "a", status: "busy" }, { name: "b", status: "busy" }], Date.now());
    s.setSessionRecords("h2", [{ name: "c", status: "busy" }], Date.now());
    expect(button.hidden).toBe(true);
  });

  // Ein verborgener Knopf haelt keinen Fokus: er fiele sonst aus der Leiste.
  it("verschwindet er mit dem Fokus, geht der Fokus auf den Ausklappknopf", () => {
    const s = stateWithWaiting();
    const { rail } = mount(s);
    const button = waitingButton(rail);
    button.focus();
    expect(document.activeElement).toBe(button);

    s.setSessionRecords("h1", [{ name: "a", status: "busy" }, { name: "b", status: "busy" }], Date.now());

    expect(button.hidden).toBe(true);
    expect(document.activeElement).toBe(rail.querySelector(".sb-rail-expand"));
  });

  it("verschwindet er ohne Fokus, bleibt der Fokus, wo er ist", () => {
    const s = stateWithWaiting();
    const { rail } = mount(s);
    const first = hostButtons(rail)[0];
    first.focus();

    s.setSessionRecords("h1", [{ name: "a", status: "busy" }, { name: "b", status: "busy" }], Date.now());

    expect(waitingButton(rail).hidden).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});

describe("sidebar-rail: zeigen und verbergen", () => {
  it("verborgen zeichnet sie nicht mit und holt beim Zeigen auf", () => {
    const s = new AppState();
    const { rail, handle } = mount(s, false);
    s.upsertHost(host("h1", ["a"], { label: "build-box" }));
    expect(hostButtons(rail)).toHaveLength(0);

    handle.setHidden(false);
    expect(rail.hidden).toBe(false);
    expect(hostButtons(rail).map((b) => b.title)).toEqual(["build-box: Online, 1 session"]);

    handle.setHidden(true);
    expect(rail.hidden).toBe(true);
    s.upsertHost(host("h2"));
    expect(hostButtons(rail)).toHaveLength(1);
    handle.setHidden(false);
    expect(hostButtons(rail)).toHaveLength(2);
  });

  it("focusExpand setzt den Fokus auf den Ausklappknopf, verborgen nicht", () => {
    const { rail, handle } = mount(new AppState(), false);
    const expand = rail.querySelector<HTMLButtonElement>(".sb-rail-expand")!;
    expect(handle.focusExpand()).toBe(false);
    expect(document.activeElement).not.toBe(expand);
    handle.setHidden(false);
    expect(handle.focusExpand()).toBe(true);
    expect(document.activeElement).toBe(expand);
  });

  it("contains kennt die Knoepfe der Leiste, nicht die der Seitenleiste", () => {
    const { rail, sidebar, handle } = mount(new AppState());
    expect(handle.contains(rail.querySelector(".sb-rail-expand"))).toBe(true);
    expect(handle.contains(rail)).toBe(true);
    expect(handle.contains(sidebar)).toBe(false);
    expect(handle.contains(document.body)).toBe(false);
    expect(handle.contains(null)).toBe(false);
  });

  it("dispose nimmt die Leiste aus dem Dokument und hoert auf zu hoeren", () => {
    const s = new AppState();
    const { app, rail, handle, h } = mount(s);
    handle.dispose();
    expect(app.querySelector(".sb-rail")).toBeNull();
    s.upsertHost(host("h1"));
    expect(hostButtons(rail)).toHaveLength(0);
    rail.querySelector<HTMLButtonElement>(".sb-rail-expand")!.click();
    expect(h.onExpand).not.toHaveBeenCalled();
    expect(handle.focusExpand()).toBe(false);
  });
});
