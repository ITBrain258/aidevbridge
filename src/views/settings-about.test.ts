import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appVersionLine } from "../version";
import { mountAboutSection } from "./settings-about";

// jsdom kennt `navigator.clipboard` nicht von sich aus (siehe
// sidebar.test.ts), darum derselbe Ersatz.
const writeText = vi.fn<(text: string) => Promise<void>>();
Object.defineProperty(globalThis.navigator, "clipboard", {
  value: { writeText },
  configurable: true,
  writable: true,
});

const SETTINGS_PATH = "C:\\Users\\U\\AppData\\Roaming\\io.github.itbrain258.aidevbridge\\settings.toml";

function mount(settingsPath: string | null = SETTINGS_PATH) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = mountAboutSection(container, { settingsPath });
  const button = container.querySelector<HTMLButtonElement>("button.settings-copy")!;
  return { container, handle, button };
}

/** Laesst die Zusage aus `writeText` und ihr `.then` ablaufen. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("settings-about (Einstellungs-Spec §7)", () => {
  it("eine Karte mit Produktname, Version, Commit, Lizenz und der Einstellungsdatei", () => {
    const { container } = mount();
    expect(container.querySelector(".settings-card > h3.settings-card-title")?.textContent).toBe("aidevbridge");
    const pairs = Array.from(container.querySelectorAll(".settings-row"), (row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);
    expect(pairs).toEqual([
      ["Version", "0.0.0-test"],
      ["Commit", "test"],
      ["License", "MIT or Apache-2.0"],
      ["Settings file", SETTINGS_PATH],
    ]);
    expect(container.querySelector("dd.settings-value--mono")?.textContent).toBe("test");
  });

  // UX-Spec §9.1: der Pfad steht markierbar in Monospace-Schrift.
  it("der Pfad steht in Monospace und ist markierbar", () => {
    const { container } = mount();
    const path = container.querySelector<HTMLElement>("dd.settings-value--path")!;

    expect(path.textContent).toBe(SETTINGS_PATH);
    expect(path.classList.contains("settings-value--mono")).toBe(true);
  });

  // Der Pfad kommt aus der ersten Antwort von `ui_settings`; scheitert sie,
  // gibt es keine Zeile statt einer leeren.
  it("ohne bekannten Pfad keine Zeile Settings file", () => {
    const { container } = mount(null);

    expect(Array.from(container.querySelectorAll(".settings-row dt"), (dt) => dt.textContent)).toEqual([
      "Version",
      "Commit",
      "License",
    ]);
  });

  it("der Knopf kopiert die Versionszeile und zeigt 2000 ms lang 'Copied'", async () => {
    vi.useFakeTimers();
    const { button } = mount();
    expect(button.textContent).toBe("Copy version info");
    button.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(appVersionLine());
    expect(button.textContent).toBe("Copied");
    vi.advanceTimersByTime(1999);
    expect(button.textContent).toBe("Copied");
    vi.advanceTimersByTime(1);
    expect(button.textContent).toBe("Copy version info");
  });

  it("ein erneuter Klick startet die Zeit neu", async () => {
    vi.useFakeTimers();
    const { button } = mount();
    button.click();
    await settle();
    vi.advanceTimersByTime(1500);
    button.click();
    await settle();
    vi.advanceTimersByTime(1500);
    expect(button.textContent).toBe("Copied");
    vi.advanceTimersByTime(500);
    expect(button.textContent).toBe("Copy version info");
  });

  it("ein Fehler beim Kopieren bleibt still", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { button } = mount();
    button.click();
    await settle();
    expect(button.textContent).toBe("Copy version info");
  });

  it("dispose loescht den Zeitgeber und entfernt die Karte", async () => {
    vi.useFakeTimers();
    const { container, handle, button } = mount();
    button.click();
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(container.childElementCount).toBe(0);
  });
});
