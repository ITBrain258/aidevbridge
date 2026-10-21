import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_KEYMAP, type KeymapAction } from "../keymap";
import { SHORTCUT_GROUPS, bindingKeys, mountShortcutsSection } from "./settings-shortcuts";

function mount(keymap: Readonly<Record<KeymapAction, string>> = DEFAULT_KEYMAP) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = mountShortcutsSection(container, keymap);
  return { container, handle };
}

function rows(container: HTMLElement): Array<[string, string[]]> {
  return Array.from(container.querySelectorAll(".settings-row"), (row): [string, string[]] => [
    row.querySelector("dt")?.textContent ?? "",
    Array.from(row.querySelectorAll("dd > .settings-keys > kbd"), (k) => k.textContent ?? ""),
  ]);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("settings-shortcuts (Einstellungs-Spec §6)", () => {
  it("jede Aktion steht genau einmal im Katalog", () => {
    const listed: string[] = [];
    for (const group of SHORTCUT_GROUPS) {
      for (const row of group.rows) {
        if (row.kind === "action") listed.push(row.action);
        if (row.kind === "range") listed.push(...row.actions);
        if (row.kind === "alternatives") {
          for (const alternative of row.alternatives) {
            if ("action" in alternative) listed.push(alternative.action);
          }
        }
      }
    }
    expect(listed.sort()).toEqual(Object.keys(DEFAULT_KEYMAP).sort());
  });

  it("bindingKeys zerlegt eine Belegung in einzelne Tasten", () => {
    expect(bindingKeys("Ctrl+Shift+N")).toEqual(["Ctrl", "Shift", "N"]);
    expect(bindingKeys(" Ctrl + Shift+ Up ")).toEqual(["Ctrl", "Shift", "Up"]);
    expect(bindingKeys("Ctrl++Shift+F")).toEqual(["Ctrl", "Shift", "F"]);
  });

  it("Einleitungssatz, fuenf Karten mit Titel und der Hinweis an der Terminal-Karte", () => {
    const { container } = mount();
    // UX-Spec §8.3; die Kuerzel am Ende wie im Hinweis zur Schriftgroesse
    // durch " / " getrennt.
    expect(container.querySelector(".settings-intro")?.textContent).toBe(
      "App shortcuts use Ctrl+Shift. Ctrl+C copies when text is selected and Ctrl+V pastes; you can turn both off under Terminal. Ctrl+, / Ctrl+= / Ctrl+− / Ctrl+0 never reach the terminal.",
    );
    const cards = Array.from(container.querySelectorAll<HTMLElement>(".settings-card"));
    expect(cards.map((c) => c.querySelector("h3.settings-card-title")?.textContent)).toEqual([
      "General",
      "Sessions",
      "Terminals",
      "Sidebar",
      "Inside a terminal",
    ]);
    expect(cards.map((c) => c.querySelector(".settings-card-note")?.textContent ?? null)).toEqual([
      null,
      null,
      null,
      null,
      "Only while a terminal has focus.",
    ]);
  });

  it("jede Zeile nennt ihre Aktion und zeigt jede Taste als eigenen Chip", () => {
    const { container } = mount();
    expect(rows(container)).toEqual([
      ["Open settings", ["Ctrl", ","]],
      ["Quick open", ["Ctrl", "Shift", "P"]],
      ["New session", ["Ctrl", "Shift", "N"]],
      ["Jump to next waiting session", ["Ctrl", "Shift", "A"]],
      ["Focus terminal 1–9", ["Ctrl", "Shift", "1–9"]],
      ["Focus previous terminal", ["Ctrl", "Shift", "Up"]],
      ["Focus next terminal", ["Ctrl", "Shift", "Down"]],
      ["Move terminal to previous position", ["Ctrl", "Shift", "PageUp"]],
      ["Move terminal to next position", ["Ctrl", "Shift", "PageDown"]],
      ["Maximize or restore terminal", ["Ctrl", "Shift", "M"]],
      ["Restore from outside the terminal", ["Esc"]],
      ["Text size", ["Ctrl", "=", "Ctrl", "−", "Ctrl", "0", "Ctrl", "Wheel"]],
      ["Show or hide sidebar", ["Ctrl", "Shift", "B"]],
      ["Move focus to sidebar", ["Ctrl", "Shift", "E"]],
      ["Copy", ["Ctrl", "C", "Ctrl", "Shift", "C", "Ctrl", "Insert"]],
      ["Paste", ["Ctrl", "V", "Ctrl", "Shift", "V", "Shift", "Insert"]],
      ["Search", ["Ctrl", "Shift", "F"]],
      ["Close terminal (session keeps running)", ["Ctrl", "Shift", "W"]],
      ["Select while a program uses the mouse", ["Shift", "Drag"]],
    ]);
  });

  // UX-Spec §9.1: Zeilen mit mehreren Belegungen zeigen jede als eigene
  // Chipgruppe. Kopieren und Einfuegen trennen Alternativen durch "or" (Strg+C
  // kopiert nur mit Markierung); die Schriftgroesse reiht groesser, kleiner und
  // zurueck mit " / " wie in der Spec -- das sind keine Alternativen.
  it("Zeilen mit mehreren Belegungen: 'or' fuer Alternativen, ' / ' fuer die Schriftgroesse", () => {
    const { container } = mount();
    const row = (label: string) =>
      Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
        (item) => item.querySelector("dt")?.textContent === label,
      )!;
    const parts = (label: string) =>
      Array.from(row(label).querySelector("dd")!.children, (child) =>
        child.classList.contains("settings-keys-sep")
          ? `(${child.textContent})`
          : Array.from(child.childNodes, (node) => node.textContent).join(" "),
      );

    expect(parts("Copy")).toEqual(["Ctrl C with selection", "(or)", "Ctrl Shift C", "(or)", "Ctrl Insert"]);
    expect(parts("Paste")).toEqual(["Ctrl V", "(or)", "Ctrl Shift V", "(or)", "Shift Insert"]);
    expect(parts("Text size")).toEqual(["Ctrl =", "(/)", "Ctrl −", "(/)", "Ctrl 0", "(/)", "Ctrl Wheel"]);
    expect(row("Copy").querySelector(".settings-keys-note")?.textContent).toBe("with selection");
  });

  it("der Einleitungssatz nennt Strg+, aus der uebergebenen Belegung", () => {
    const { container } = mount({ ...DEFAULT_KEYMAP, "settings.open": "Ctrl+Shift+O" });
    expect(container.querySelector(".settings-intro")?.textContent).toContain(
      "Ctrl+Shift+O / Ctrl+= / Ctrl+− / Ctrl+0 never reach the terminal.",
    );
  });

  it("Kopieren und Einfuegen mit Umschalt kommen aus der uebergebenen Belegung", () => {
    const { container } = mount({ ...DEFAULT_KEYMAP, "clipboard.copy": "Ctrl+Shift+Y" });
    expect(new Map(rows(container)).get("Copy")).toEqual(["Ctrl", "C", "Ctrl", "Shift", "Y", "Ctrl", "Insert"]);
  });

  it("die Tasten kommen aus der uebergebenen Belegung, nicht aus der Standardtabelle", () => {
    const { container } = mount({
      ...DEFAULT_KEYMAP,
      "session.new": "Ctrl+Shift+J",
      "session.select.1": "Ctrl+Shift+5",
      "session.select.9": "Ctrl+Shift+8",
    });
    const byLabel = new Map(rows(container));
    expect(byLabel.get("New session")).toEqual(["Ctrl", "Shift", "J"]);
    expect(byLabel.get("Focus terminal 1–9")).toEqual(["Ctrl", "Shift", "5–8"]);
  });

  it("auch Strg+, kommt aus der uebergebenen Belegung", () => {
    const { container } = mount({ ...DEFAULT_KEYMAP, "settings.open": "Ctrl+Shift+O" });
    expect(new Map(rows(container)).get("Open settings")).toEqual(["Ctrl", "Shift", "O"]);
  });

  it("dispose entfernt die Uebersicht", () => {
    const { container, handle } = mount();
    handle.dispose();
    expect(container.childElementCount).toBe(0);
  });
});
