import { afterEach, describe, expect, it, vi } from "vitest";
import { AppState, type Host } from "../state/app-state";
import { COMPACT_QUERY, mountCompactShell } from "./compact-shell";

function host(id: string, sessions: string[] = []): Host {
  return {
    id, runtimeId: `r-${id}`, label: id, hostname: "10.0.0.1", user: "u", port: 22, keyPath: null,
    authKind: "agent",
    state: "connected", error: null, expanded: true, lastCwd: "/tmp",
    sessions: sessions.map((name) => ({ name, hostId: id, open: false, inputLocked: false })),
  };
}

/** Eine Medienabfrage, deren Ergebnis der Test umschaltet. */
function fakeQuery(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    media: COMPACT_QUERY,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  } as unknown as MediaQueryList & { matches: boolean };
  return {
    query,
    set(value: boolean) {
      (query as { matches: boolean }).matches = value;
      for (const listener of listeners) listener();
    },
  };
}

function setup(options: { compact?: boolean; sessions?: string[]; noHost?: boolean } = {}) {
  const app = document.createElement("div");
  app.id = "app";
  document.body.appendChild(app);
  const state = new AppState();
  if (!options.noHost) state.upsertHost(host("h1", options.sessions ?? ["a", "b", "c"]));
  const media = fakeQuery(options.compact ?? true);
  const unregister = vi.fn(() => Promise.resolve());
  let backHandler: (() => void) | null = null;
  const onBackButton = vi.fn((handler: () => void) => {
    backHandler = handler;
    return Promise.resolve({ unregister } as never);
  });
  const shell = mountCompactShell({
    app,
    state,
    waitingCount: () => 0,
    focusedLabel: () => state.focusedSessionKey(),
    matchMedia: () => media.query,
    onBackButton: onBackButton as never,
  });
  return { app, state, media, shell, onBackButton, unregister, back: () => backHandler?.() };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("kompakte Ansicht (Spec 2026-10-27 §5.1)", () => {
  it("setzt die Kopfleiste vor alles andere in #app", () => {
    const { app } = setup();
    expect(app.firstElementChild?.id).toBe("compact-bar");
    expect(app.classList.contains("compact")).toBe(true);
  });

  it("zeigt ohne Kachel die Seitenleiste und laesst sie nicht schliessen", () => {
    const { app, shell } = setup();
    expect(app.classList.contains("compact-sessions-open")).toBe(true);
    shell.setSessionsOpen(false);
    expect(shell.sessionsOpen()).toBe(true);
  });

  it("laesst ohne Host die Schublade zu, damit der Erststart im Raster sichtbar ist", () => {
    const { app, state } = setup({ noHost: true });
    expect(app.classList.contains("compact-sessions-open")).toBe(false);
    state.upsertHost(host("h1", ["a"]));
    expect(app.classList.contains("compact-sessions-open")).toBe(true);
  });

  it("schliesst die Schublade, sobald eine Session aufgeht", () => {
    const { app, state } = setup();
    state.openSession("h1", "a");
    expect(app.classList.contains("compact-sessions-open")).toBe(false);
  });

  it("zeigt genau eine Kachel: die fokussierte ist maximiert", () => {
    const { state } = setup();
    state.openSession("h1", "a");
    state.openSession("h1", "b");
    expect(state.maximizedTile).toBe(state.focusedTile);
    expect(state.visibleTileIds()).toEqual([state.focusedTile]);
    const first = state.tiles[0].id;
    state.focusTile(first);
    expect(state.maximizedTile).toBe(first);
  });

  it("maximiert bei einer einzigen Kachel nichts", () => {
    const { state } = setup();
    state.openSession("h1", "a");
    expect(state.maximizedTile).toBeNull();
  });

  it("gibt beim Wechsel in die breite Ansicht nur das eigene Maximieren frei", () => {
    const { app, state, media } = setup();
    state.openSession("h1", "a");
    state.openSession("h1", "b");
    media.set(false);
    expect(app.classList.contains("compact")).toBe(false);
    expect(state.maximizedTile).toBeNull();
    media.set(true);
    expect(state.maximizedTile).toBe(state.focusedTile);
  });

  it("aendert in der breiten Ansicht nichts", () => {
    const { app, state } = setup({ compact: false });
    state.openSession("h1", "a");
    state.openSession("h1", "b");
    expect(state.maximizedTile).toBeNull();
    expect(app.classList.contains("compact")).toBe(false);
    expect(app.classList.contains("compact-sessions-open")).toBe(false);
  });

  it("der Knopf oeffnet und schliesst die Schublade", () => {
    const { app, state } = setup();
    state.openSession("h1", "a");
    const toggle = app.querySelector<HTMLButtonElement>(".compact-bar-toggle")!;
    toggle.click();
    expect(app.classList.contains("compact-sessions-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(app.classList.contains("compact-sessions-open")).toBe(false);
  });

  it("die Zurueck-Geste schliesst die offene Schublade, sonst hoert niemand zu", async () => {
    const { app, state, onBackButton, unregister, back } = setup();
    // Ohne Kachel bleibt die Geste bei Android: die App geht in den Hintergrund.
    expect(onBackButton).not.toHaveBeenCalled();
    state.openSession("h1", "a");
    app.querySelector<HTMLButtonElement>(".compact-bar-toggle")!.click();
    expect(onBackButton).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    back();
    expect(app.classList.contains("compact-sessions-open")).toBe(false);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("nennt die fokussierte Session in der Kopfleiste", () => {
    const { app, state } = setup();
    state.openSession("h1", "b");
    expect(app.querySelector(".compact-bar-title")?.textContent).toBe("h1/b");
  });

  it("raeumt beim Entsorgen Leiste und Klassen ab", () => {
    const { app, shell } = setup();
    shell.dispose();
    expect(app.querySelector("#compact-bar")).toBeNull();
    expect(app.className).toBe("");
  });
});
