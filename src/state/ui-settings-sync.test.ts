// Der Schreiber der [ui]-Felder (UX-Spec §6.7, §9.2): eine Feldtabelle fuer
// Pruefen, Laden und Vergleichen, und ein Schreibvorgang 500 ms nach der
// letzten Aenderung mit nur den Feldern, die settings.toml noch nicht haelt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs } from "../terminal-prefs";
import { UI_SETTINGS_PERSIST_MS, createUiSettingsSync, type UiFieldsPatch, type UiSettingsSync } from "./ui-settings-sync";

let write: ReturnType<typeof vi.fn<(patch: UiFieldsPatch) => Promise<unknown>>>;
let sync: UiSettingsSync;

beforeEach(() => {
  vi.useFakeTimers();
  write = vi.fn<(patch: UiFieldsPatch) => Promise<unknown>>().mockResolvedValue(undefined);
  sync = createUiSettingsSync(write);
});

afterEach(() => {
  sync.dispose();
  vi.useRealTimers();
});

function prefs(patch: Partial<TerminalPrefs> = {}): TerminalPrefs {
  return { ...DEFAULT_TERMINAL_PREFS, ...patch };
}

function writes(): UiFieldsPatch[] {
  return write.mock.calls.map(([patch]) => patch);
}

describe("ui-settings-sync: Laden", () => {
  it("uebernimmt jedes brauchbare Feld und liefert dieselben Werte fuer terminal-prefs", () => {
    const stored = sync.applyStored({
      terminal_font_size: 16,
      copy_on_select: true,
      ctrl_cv_clipboard: false,
      right_click: "paste",
      restore_workspace: false,
      sidebar_width: 300,
    });

    expect(stored.fields).toEqual({
      terminal_font_size: 16,
      copy_on_select: true,
      ctrl_cv_clipboard: false,
      right_click: "paste",
      restore_workspace: false,
      sidebar_width: 300,
    });
    expect(stored.prefs).toEqual({ fontSize: 16, copyOnSelect: true, ctrlCvClipboard: false, rightClick: "paste" });
  });

  it("prueft jedes Feld einzeln: Unbrauchbares bleibt weg, Zahlen kommen ganz und in Grenzen", () => {
    const stored = sync.applyStored({
      terminal_font_size: 99,
      copy_on_select: "yes" as unknown as boolean,
      right_click: "context" as unknown as "menu",
      sidebar_width: 250.6,
    });

    expect(stored.fields).toEqual({ terminal_font_size: 20, sidebar_width: 251 });
    expect(stored.prefs).toEqual({ fontSize: 20 });
  });

  it("eine leere Antwort liefert nichts", () => {
    expect(sync.applyStored({})).toEqual({ fields: {}, prefs: {} });
  });
});

describe("ui-settings-sync: entprellt schreiben", () => {
  it("schreibt 500 ms nach der letzten Aenderung, mit nur den geaenderten Feldern", async () => {
    sync.prefsChanged(prefs(), prefs({ fontSize: 14 }));
    await vi.advanceTimersByTimeAsync(300);
    sync.prefsChanged(prefs({ fontSize: 14 }), prefs({ fontSize: 15 }));
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS - 1);
    expect(writes()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes()).toEqual([{ terminal_font_size: 15 }]);
  });

  it("mehrere Felder binnen der Ruhezeit gehen zusammen hinaus", async () => {
    sync.prefsChanged(prefs(), prefs({ copyOnSelect: true, rightClick: "paste" }));
    sync.schedule("restore_workspace", false);
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);

    expect(writes()).toEqual([{ copy_on_select: true, right_click: "paste", restore_workspace: false }]);
  });

  it("das Echo des Ladens schreibt nichts", async () => {
    const stored = sync.applyStored({ terminal_font_size: 16, copy_on_select: true });
    sync.prefsChanged(prefs(), prefs(stored.prefs));
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes()).toEqual([]);
  });

  it("zurueck auf den gespeicherten Wert binnen der Ruhezeit schreibt nichts", async () => {
    sync.applyStored({ copy_on_select: false });
    sync.prefsChanged(prefs(), prefs({ copyOnSelect: true }));
    sync.prefsChanged(prefs({ copyOnSelect: true }), prefs());
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);

    expect(writes()).toEqual([]);
  });

  it("nach einem gelungenen Schreiben gilt der neue Wert als gespeichert", async () => {
    sync.applyStored({ right_click: "menu" });
    sync.prefsChanged(prefs(), prefs({ rightClick: "paste" }));
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);
    sync.prefsChanged(prefs({ rightClick: "paste" }), prefs());
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);

    expect(writes()).toEqual([{ right_click: "paste" }, { right_click: "menu" }]);
  });

  // Ohne gelesenen Stand ueberschrieben die Standards der uebrigen Felder sonst
  // die Datei.
  it("ohne geladenen Stand geht nur das geaenderte Feld hinaus", async () => {
    sync.prefsChanged(prefs(), prefs({ fontSize: 12 }));
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);

    expect(writes()).toEqual([{ terminal_font_size: 12 }]);
  });

  it("ein gescheiterter Schreibvorgang landet nur in der Konsole und zaehlt nicht als gespeichert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      write.mockRejectedValueOnce("disk full");
      sync.schedule("copy_on_select", true);
      await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));

      // Derselbe Wert noch einmal: er war ja nie gespeichert.
      sync.schedule("copy_on_select", true);
      await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);
      expect(writes()).toEqual([{ copy_on_select: true }, { copy_on_select: true }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("dispose verwirft einen ausstehenden Schreibvorgang", async () => {
    sync.schedule("restore_workspace", false);
    sync.dispose();
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes()).toEqual([]);
  });
});

// Aufgabe 19 schreibt die Breite der Seitenleiste ueber diesen Weg.
describe("ui-settings-sync: ein einzelnes Feld planen", () => {
  it("Zahlen gehen ganzzahlig hinaus", async () => {
    sync.schedule("sidebar_width", 301.6);
    sync.schedule("terminal_font_size", 13.6);
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);

    expect(writes()).toEqual([{ sidebar_width: 302, terminal_font_size: 14 }]);
  });

  it("ein Wert ohne Zahl wird verworfen", async () => {
    sync.schedule("sidebar_width", Number.NaN);
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);

    expect(writes()).toEqual([]);
  });

  it("ein schon gespeicherter Wert geht nicht noch einmal hinaus", async () => {
    sync.applyStored({ sidebar_width: 300 });
    sync.schedule("sidebar_width", 300);
    await vi.advanceTimersByTimeAsync(UI_SETTINGS_PERSIST_MS);

    expect(writes()).toEqual([]);
  });
});
