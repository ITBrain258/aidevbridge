import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAppearanceSection } from "./settings-appearance";
import { DEFAULT_KEYMAP } from "../keymap";
import { THEMES, type ThemeId } from "../theme";

function mount(current: ThemeId = "turquoise", unknownStoredTheme: string | null = null, sidebarRail = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onThemeChange = vi.fn();
  const onPersist = vi.fn();
  const onSidebarRailChange = vi.fn();
  const handle = mountAppearanceSection(container, {
    current,
    unknownStoredTheme,
    onThemeChange,
    onPersist,
    sidebarRail,
    onSidebarRailChange,
    keymap: DEFAULT_KEYMAP,
  });
  return { container, handle, onThemeChange, onPersist, onSidebarRailChange };
}

function radios(container: HTMLElement, name: "accent" | "base"): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`));
}

function radio(container: HTMLElement, name: "accent" | "base", value: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`)!;
}

function choose(input: HTMLInputElement): void {
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const ACCENT_NAMES = ["Turquoise", "Blue", "Violet", "Pink", "Red", "Orange", "Green"];

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

const BASE_IDS = ["graphite", "slate", "midnight", "mocha", "plum", "pine"];

describe("settings-appearance (Farbwahl-Spec §6, Einstellungs-Spec §5)", () => {
  it("zwei Farbkarten mit sieben Akzenten und sechs Grundtoenen; die Legende ist der Kartentitel", () => {
    const { container } = mount("red-slate");
    // Die Farbkarten tragen ihre Legende als Titel; eine Ueberschrift hat nur
    // die Karte mit dem Schalter darunter.
    expect(Array.from(container.querySelectorAll("h3"), (h) => h.textContent)).toEqual(["Sidebar"]);
    expect(
      Array.from(
        container.querySelectorAll(".settings-card > fieldset.settings-group > legend.settings-card-title"),
        (l) => l.textContent,
      ),
    ).toEqual(["Accent color", "Background"]);
    expect(radios(container, "accent").map((r) => r.value)).toEqual([
      "turquoise", "blue", "violet", "pink", "red", "orange", "green",
    ]);
    expect(radios(container, "base").map((r) => r.value)).toEqual(BASE_IDS);
    expect(radios(container, "accent").filter((r) => r.checked).map((r) => r.value)).toEqual(["red"]);
    expect(radios(container, "base").filter((r) => r.checked).map((r) => r.value)).toEqual(["slate"]);
  });

  it("jedes Farbfeld nennt seinen Namen als aria-label und title; daneben steht der gewaehlte als Text", () => {
    const { container } = mount("violet-graphite");
    const options = Array.from(container.querySelectorAll<HTMLElement>("label.accent-option"));
    expect(options.map((o) => o.title)).toEqual(ACCENT_NAMES);
    expect(options.map((o) => o.dataset.accent)).toEqual([
      "turquoise", "blue", "violet", "pink", "red", "orange", "green",
    ]);
    expect(radios(container, "accent").map((r) => r.getAttribute("aria-label"))).toEqual(ACCENT_NAMES);
    expect(container.querySelectorAll(".accent-dot[aria-hidden='true']")).toHaveLength(7);
    expect(container.querySelector(".accent-current")?.textContent).toBe("Violet");
    choose(radio(container, "accent", "green"));
    expect(container.querySelector(".accent-current")?.textContent).toBe("Green");
  });

  it("die Grundtonkarten tragen Namen und ihren Grundton als data-base", () => {
    const { container } = mount();
    const cards = Array.from(container.querySelectorAll<HTMLElement>("label.base-card"));
    expect(cards.map((c) => c.dataset.base)).toEqual(BASE_IDS);
    expect(Array.from(container.querySelectorAll(".base-card-name"), (n) => n.textContent)).toEqual([
      "Graphite",
      "Slate",
      "Midnight",
      "Mocha",
      "Plum",
      "Pine",
    ]);
    expect(container.querySelectorAll(".base-swatches[aria-hidden='true']")).toHaveLength(6);
  });

  // Spec 2026-11-14 §2: der Schalter der Symbolleiste.
  it("die Karte Sidebar steht unter den Farben und traegt den Schalter der Symbolleiste mit dem Kuerzel im Hinweis", () => {
    const { container } = mount();
    const cards = Array.from(container.querySelectorAll(".settings-appearance > .settings-card"));
    expect(cards).toHaveLength(3);
    const card = cards[2];
    expect(card.querySelector(".settings-card-title")?.textContent).toBe("Sidebar");
    const toggle = card.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(card.textContent).toContain("Icon rail when collapsed");
    expect(card.textContent).toContain(
      "Keeps a narrow strip with your hosts and their state when you collapse the sidebar. Off hides the sidebar completely and removes the collapse button; Ctrl+Shift+B hides the sidebar and brings it back.",
    );
  });

  it("der Schalter zeigt den gespeicherten Wert und meldet jedes Umschalten", () => {
    const { container, onSidebarRailChange, onPersist } = mount("turquoise", null, false);
    const toggle = container.querySelector<HTMLButtonElement>('.settings-card button[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    expect(onSidebarRailChange).toHaveBeenCalledTimes(1);
    expect(onSidebarRailChange).toHaveBeenLastCalledWith(true);
    toggle.click();
    expect(onSidebarRailChange).toHaveBeenLastCalledWith(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Der Schalter schreibt kein Thema.
    expect(onPersist).not.toHaveBeenCalled();
  });

  it("jeder Wechsel ruft onThemeChange sofort mit der Id aus beiden Gruppen", () => {
    const { container, onThemeChange } = mount("turquoise");
    choose(radio(container, "accent", "violet"));
    expect(onThemeChange).toHaveBeenLastCalledWith("violet-graphite");
    choose(radio(container, "base", "slate"));
    expect(onThemeChange).toHaveBeenLastCalledWith("violet-slate");
    choose(radio(container, "accent", "blue"));
    expect(onThemeChange).toHaveBeenLastCalledWith("slate");
    choose(radio(container, "base", "graphite"));
    expect(onThemeChange).toHaveBeenLastCalledWith("blue-graphite");
  });

  it("onPersist einmal nach 150 ms Ruhe, mit dem letzten Stand", () => {
    vi.useFakeTimers();
    const { container, onPersist } = mount("turquoise");
    choose(radio(container, "accent", "red"));
    vi.advanceTimersByTime(100);
    choose(radio(container, "base", "slate"));
    vi.advanceTimersByTime(149);
    expect(onPersist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onPersist).toHaveBeenCalledWith("red-slate");
  });

  it("dispose schreibt einen noch offenen Wert sofort, genau einmal", () => {
    vi.useFakeTimers();
    const { container, handle, onPersist } = mount("turquoise");
    choose(radio(container, "base", "slate"));
    handle.dispose();
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onPersist).toHaveBeenCalledWith("turquoise-slate");
    vi.advanceTimersByTime(500);
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
  });

  // DOM-Haelfte der Zusage "ein Tabstopp je Gruppe": eine native Radiogruppe
  // hat genau EINEN Tab-Halt, und zwar ueber ihr gewaehltes Mitglied -- das
  // setzt voraus, dass nach dem Mount in jeder Gruppe genau eines gewaehlt
  // ist. Die Fokusfallen-Haelfte steht in `main.test.ts`.
  it("je Gruppe ist nach dem Mount genau ein Radio gewaehlt, und jede Gruppe teilt ihren Namen", () => {
    for (const current of THEMES) {
      const { container } = mount(current);
      const all = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      // Sieben Akzente und sechs Grundtoene.
      expect(all).toHaveLength(13);
      expect(new Set(all.map((r) => r.name))).toEqual(new Set(["accent", "base"]));
      expect(all.filter((r) => r.checked).map((r) => r.name).sort(), current).toEqual(["accent", "base"]);
      document.body.replaceChildren();
    }
  });

  it("zeigt den Hinweis nur bei unbekanntem gespeichertem Wert", () => {
    expect(mount("turquoise", null).container.querySelector(".settings-hint")).toBeNull();
    const hint = mount("turquoise", "sepia").container.querySelector(".settings-hint");
    expect(hint?.textContent).toBe(
      "Your settings name a color theme this version doesn't know ('sepia'). Using Turquoise on Graphite.",
    );
  });
});
