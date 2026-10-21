import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYMAP } from "../keymap";
import { DEFAULT_TERMINAL_PREFS, setTerminalPrefs } from "../terminal-prefs";
import type { ThemeId } from "../theme";
import { mountSettingsDialog, type SettingsDialogOptions } from "./settings-dialog";

function mount(extra: Partial<SettingsDialogOptions> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onThemeChange = vi.fn();
  const onPersist = vi.fn();
  const onRestoreWorkspaceChange = vi.fn();
  const handle = mountSettingsDialog(container, {
    currentTheme: () => "turquoise",
    unknownStoredTheme: () => null,
    onThemeChange,
    onPersist,
    restoreWorkspace: () => true,
    onRestoreWorkspaceChange,
    settingsPath: () => null,
    ...extra,
  });
  return { container, handle, onPersist, onRestoreWorkspaceChange };
}

const SECTIONS = ["General", "Appearance", "Terminal", "Shortcuts", "About"];
const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const tab = (c: HTMLElement, name: string) => tabs(c)[SECTIONS.indexOf(name)];
const panel = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="tabpanel"]')!;
const selected = (c: HTMLElement) => tabs(c).map((t) => t.getAttribute("aria-selected"));
const only = (name: string) => SECTIONS.map((section) => String(section === name));

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function choose(input: HTMLInputElement): void {
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  setTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("settings-dialog: Rahmen mit senkrechten Tabs (Einstellungs-Spec §3, UX-Spec §9.1)", () => {
  it("fuenf Tabs in fester Reihenfolge; der erste ist gewaehlt und zeigt General", () => {
    const { container } = mount();
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(list.getAttribute("aria-label")).toBe("Settings sections");
    expect(tabs(container).map((t) => t.textContent)).toEqual(SECTIONS);
    expect(selected(container)).toEqual(only("General"));
    expect(tabs(container).map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(panel(container).querySelector(".settings-card-title")?.textContent).toBe("Startup");
  });

  it("Tabs und Panel sind verdrahtet", () => {
    const { container } = mount();
    const p = panel(container);
    expect(tabs(container).map((t) => t.getAttribute("aria-controls"))).toEqual(SECTIONS.map(() => p.id));
    expect(p.getAttribute("aria-labelledby")).toBe(tabs(container)[0].id);
    expect(p.tabIndex).toBe(0);
  });

  it("Klick wechselt den Bereich und entsorgt den alten; ein offener Themenwert wird sofort geschrieben", () => {
    vi.useFakeTimers();
    const { container, onPersist } = mount();
    tab(container, "Appearance").click();
    choose(container.querySelector<HTMLInputElement>('input[name="base"][value="slate"]')!);
    tab(container, "Shortcuts").click();
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onPersist).toHaveBeenCalledWith("turquoise-slate");
    expect(selected(container)).toEqual(only("Shortcuts"));
    expect(tabs(container).map((t) => t.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
    expect(panel(container).getAttribute("aria-labelledby")).toBe(tab(container, "Shortcuts").id);
    expect(panel(container).querySelector('input[type="radio"]')).toBeNull();
    expect(panel(container).querySelector(".settings-shortcuts")).not.toBeNull();
  });

  it("Pfeiltasten wechseln mit Umlauf, Home/End springen an die Enden, der Fokus folgt", () => {
    const { container } = mount();
    const all = tabs(container);
    const [first, second] = all;
    const last = all[all.length - 1];
    first.focus();
    press(first, "ArrowUp");
    expect(selected(container)).toEqual(only("About"));
    expect(document.activeElement).toBe(last);
    press(last, "ArrowDown");
    expect(selected(container)).toEqual(only("General"));
    expect(document.activeElement).toBe(first);
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    expect(panel(container).querySelector('input[name="accent"]')).not.toBeNull();
    press(second, "End");
    expect(selected(container)).toEqual(only("About"));
    press(last, "Home");
    expect(selected(container)).toEqual(only("General"));
  });

  it("andere Tasten auf einem Tab tun nichts", () => {
    const { container } = mount();
    const [first] = tabs(container);
    first.focus();
    press(first, "a");
    press(first, "ArrowRight");
    expect(selected(container)).toEqual(only("General"));
  });

  it("General zeigt den gespeicherten Schalter und meldet eine Aenderung", () => {
    const { container, onRestoreWorkspaceChange } = mount({ restoreWorkspace: () => false });
    const toggle = panel(container).querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    toggle.click();

    expect(onRestoreWorkspaceChange).toHaveBeenCalledWith(true);
  });

  it("Terminal zeigt die Karten Text und Clipboard", () => {
    const { container } = mount();
    tab(container, "Terminal").click();
    expect(
      Array.from(panel(container).querySelectorAll(".settings-card-title"), (title) => title.textContent),
    ).toEqual(["Text", "Clipboard"]);
  });

  it("eine uebergebene Belegung erreicht die Uebersicht", () => {
    const { container } = mount({ keymap: { ...DEFAULT_KEYMAP, "session.new": "Ctrl+Shift+J" } });
    tab(container, "Shortcuts").click();
    const newSessionRow = Array.from(panel(container).querySelectorAll(".settings-row")).find(
      (row) => row.querySelector("dt")?.textContent === "New session",
    )!;
    expect(Array.from(newSessionRow.querySelectorAll("kbd"), (k) => k.textContent)).toEqual(["Ctrl", "Shift", "J"]);
  });

  it("About zeigt die Versionskarte mit der Einstellungsdatei", () => {
    const { container } = mount({ settingsPath: () => "C:\\settings.toml" });
    tab(container, "About").click();
    expect(panel(container).querySelector(".settings-card-title")?.textContent).toBe("aidevbridge");
    expect(panel(container).querySelector(".settings-value--path")?.textContent).toBe("C:\\settings.toml");
  });

  // Review Fix-Runde 1: ein Wechsel des Bereichs entsorgt den alten und mountet
  // den neuen. Jeder Bereich liest seinen Wert deshalb beim Mounten aus der
  // Quelle, nicht aus einem Wert vom Oeffnen des Dialogs.
  it("General steht nach einem Wechsel des Bereichs, wie er zuletzt gestellt wurde", () => {
    let restore = true;
    const { container } = mount({
      restoreWorkspace: () => restore,
      onRestoreWorkspaceChange: (value) => {
        restore = value;
      },
    });
    panel(container).querySelector<HTMLButtonElement>('button[role="switch"]')!.click();

    tab(container, "Terminal").click();
    tab(container, "General").click();

    expect(panel(container).querySelector('button[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
  });

  it("Appearance zeigt nach einem Wechsel des Bereichs die zuletzt gewaehlte Farbe", () => {
    let theme: ThemeId = "turquoise";
    const { container } = mount({
      currentTheme: () => theme,
      onThemeChange: (next) => {
        theme = next;
      },
    });
    tab(container, "Appearance").click();
    choose(panel(container).querySelector<HTMLInputElement>('input[name="base"][value="slate"]')!);

    tab(container, "Shortcuts").click();
    tab(container, "Appearance").click();

    expect(panel(container).querySelector<HTMLInputElement>('input[name="base"][value="slate"]')!.checked).toBe(true);
    expect(panel(container).querySelector<HTMLInputElement>('input[name="accent"][value="turquoise"]')!.checked).toBe(true);
  });

  it("der Hinweis auf ein unbekanntes Thema folgt seiner Quelle", () => {
    let unknown: string | null = "fancy";
    const { container } = mount({ unknownStoredTheme: () => unknown });
    tab(container, "Appearance").click();
    expect(panel(container).querySelector(".settings-hint")).not.toBeNull();

    unknown = null;
    tab(container, "Shortcuts").click();
    tab(container, "Appearance").click();

    expect(panel(container).querySelector(".settings-hint")).toBeNull();
  });

  it("About zeigt den Pfad, sobald er bekannt ist, beim naechsten Mounten", () => {
    let path: string | null = null;
    const { container } = mount({ settingsPath: () => path });
    tab(container, "About").click();
    expect(panel(container).querySelector(".settings-value--path")).toBeNull();

    path = "C:\\settings.toml";
    tab(container, "General").click();
    tab(container, "About").click();

    expect(panel(container).querySelector(".settings-value--path")?.textContent).toBe("C:\\settings.toml");
  });

  it("dispose entsorgt den offenen Bereich und leert den Container", () => {
    vi.useFakeTimers();
    const { container, handle, onPersist } = mount();
    tab(container, "Appearance").click();
    choose(container.querySelector<HTMLInputElement>('input[name="accent"][value="red"]')!);
    handle.dispose();
    expect(onPersist).toHaveBeenCalledWith("red-graphite");
    expect(container.childElementCount).toBe(0);
  });
});
