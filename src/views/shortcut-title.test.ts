// Tooltips mit Kuerzel (UX-Spec §8.4): "{label} ({shortcut})", das Kuerzel aus
// der aktiven Tabelle, ohne Literal im Code.
import { describe, expect, it } from "vitest";
import { DEFAULT_KEYMAP } from "../keymap";
import { titleWithShortcut } from "./shortcut-title";

describe("titleWithShortcut (UX-Spec §8.4)", () => {
  it("nennt das Kuerzel aus der Standardtabelle", () => {
    expect(titleWithShortcut("Maximize", "tile.maximize")).toBe("Maximize (Ctrl+Shift+M)");
    expect(titleWithShortcut("Settings", "settings.open")).toBe("Settings (Ctrl+,)");
    expect(titleWithShortcut("Close terminal", "session.close")).toBe("Close terminal (Ctrl+Shift+W)");
    expect(titleWithShortcut("Quick open", "quickOpen")).toBe("Quick open (Ctrl+Shift+P)");
  });

  it("folgt einer uebergebenen Tabelle", () => {
    expect(titleWithShortcut("New session", "session.new", { ...DEFAULT_KEYMAP, "session.new": "Ctrl+Shift+J" })).toBe(
      "New session (Ctrl+Shift+J)",
    );
  });

  it("laesst geschweifte Klammern in der Beschriftung stehen", () => {
    expect(titleWithShortcut("{shortcut}", "tile.maximize")).toBe("{shortcut} (Ctrl+Shift+M)");
  });
});
