// Einstellungen, Bereich "Shortcuts" (Einstellungs-Spec §6, UX-Spec §9.1): eine
// reine Uebersicht der App-Kuerzel. Katalog (Karten, Zeilen, Texte) und Tasten
// sind getrennt: die Tasten kommen aus der uebergebenen Belegung, nie direkt aus
// `DEFAULT_KEYMAP` -- ein spaeterer Editor fuer eigene Kuerzel reicht hier
// seine Tabelle durch (dasselbe Muster wie `matchAction(event, bindings)`).
import { t } from "../i18n/t";
import type { TranslationKey } from "../i18n/t";
import type { KeymapAction } from "../keymap";

/** Eine Taste einer festen Belegung: ihr Name (`"Ctrl"`, `"Insert"`, `"Esc"`)
 * oder ein Wort aus en.json fuer eine Mausgeste (`Wheel`, `Drag`). */
export type CatalogKey = string | { textKey: TranslationKey };

/** Eine von mehreren Belegungen einer Zeile: aus der Belegung (`action`) oder
 * fest (`keys`), mit einem Zusatz wie "with selection" (`noteKey`). */
export type KeyAlternative = { action: KeymapAction } | { keys: readonly CatalogKey[]; noteKey?: TranslationKey };

/** `action`: eine Aktion. `range`: mehrere Aktionen in einer Zeile, gezeigt
 * als Modifikatoren der ersten plus "erste–letzte" Taste; der Bereich muss
 * zusammenhaengen, ein Editor zeigt die Aktionen spaeter einzeln. `fixed`:
 * Tasten, die nicht aus der Belegung kommen und auch spaeter nicht belegbar
 * sind (Esc, Umschalt+Ziehen). `alternatives`: mehrere Belegungen in einer
 * Zeile, je eine Chipgruppe (UX-Spec §9.1: Kopieren, Einfuegen,
 * Schriftgroesse). Getrennt durch "or", wenn es Alternativen fuer dieselbe
 * Wirkung sind; `separatorKey` waehlt ein anderes Trennzeichen, etwa " / " fuer
 * die Schriftgroesse (groesser, kleiner, zurueck). */
export type ShortcutRow =
  | { kind: "action"; action: KeymapAction; labelKey: TranslationKey }
  | { kind: "range"; actions: readonly KeymapAction[]; labelKey: TranslationKey }
  | { kind: "fixed"; keys: readonly CatalogKey[]; labelKey: TranslationKey }
  | {
      kind: "alternatives";
      alternatives: readonly KeyAlternative[];
      labelKey: TranslationKey;
      separatorKey?: TranslationKey;
    };

export interface ShortcutGroup {
  titleKey: TranslationKey;
  noteKey?: TranslationKey;
  rows: readonly ShortcutRow[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    // Kuerzel, die ueberall gelten (UX-Spec §8.3), auch das Schnelloeffnen (§7.5).
    titleKey: "settings.shortcuts.group.general",
    rows: [
      { kind: "action", action: "settings.open", labelKey: "settings.shortcut.settings.open" },
      { kind: "action", action: "quickOpen", labelKey: "settings.shortcut.quickOpen" },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.sessions",
    rows: [
      { kind: "action", action: "session.new", labelKey: "settings.shortcut.session.new" },
      { kind: "action", action: "session.nextWaiting", labelKey: "settings.shortcut.session.nextWaiting" },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.terminals",
    rows: [
      {
        kind: "range",
        actions: [
          "session.select.1",
          "session.select.2",
          "session.select.3",
          "session.select.4",
          "session.select.5",
          "session.select.6",
          "session.select.7",
          "session.select.8",
          "session.select.9",
        ],
        labelKey: "settings.shortcut.session.select",
      },
      { kind: "action", action: "session.prev", labelKey: "settings.shortcut.session.prev" },
      { kind: "action", action: "session.next", labelKey: "settings.shortcut.session.next" },
      { kind: "action", action: "tile.moveEarlier", labelKey: "settings.shortcut.tile.moveEarlier" },
      { kind: "action", action: "tile.moveLater", labelKey: "settings.shortcut.tile.moveLater" },
      { kind: "action", action: "tile.maximize", labelKey: "settings.shortcut.tile.maximize" },
      { kind: "fixed", keys: ["Esc"], labelKey: "settings.shortcut.tile.restoreEsc" },
      // UX-Spec §6.7: feste Tasten ausserhalb der Belegung, sie wirken ueberall
      // ausser in Feldern und Dialogen; das Rad ueber einem Terminal. Das Minus
      // als Rechenzeichen wie in der Spec, auf der Taste steht `-`. Getrennt
      // durch " / " wie in UX-Spec §9.1: groesser, kleiner und zurueck sind
      // keine Alternativen.
      {
        kind: "alternatives",
        alternatives: [
          { keys: ["Ctrl", "="] },
          { keys: ["Ctrl", "−"] },
          { keys: ["Ctrl", "0"] },
          { keys: ["Ctrl", { textKey: "settings.shortcuts.key.wheel" }] },
        ],
        labelKey: "settings.shortcut.textSize",
        separatorKey: "settings.shortcuts.slash",
      },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.sidebar",
    rows: [
      { kind: "action", action: "sidebar.toggle", labelKey: "settings.shortcut.sidebar.toggle" },
      { kind: "action", action: "sidebar.focus", labelKey: "settings.shortcut.sidebar.focus" },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.terminal",
    noteKey: "settings.shortcuts.group.terminal.note",
    rows: [
      // UX-Spec §6.1: Strg+C und Strg+V sind die festen Tasten der
      // Zwischenablage (abschaltbar, `terminal-clipboard.ts`), Strg+Umschalt+C/V
      // kommen aus der Belegung, Strg+Einfg und Umschalt+Einfg sind fest.
      {
        kind: "alternatives",
        alternatives: [
          { keys: ["Ctrl", "C"], noteKey: "settings.shortcuts.withSelection" },
          { action: "clipboard.copy" },
          { keys: ["Ctrl", "Insert"] },
        ],
        labelKey: "settings.shortcut.clipboard.copy",
      },
      {
        kind: "alternatives",
        alternatives: [{ keys: ["Ctrl", "V"] }, { action: "clipboard.paste" }, { keys: ["Shift", "Insert"] }],
        labelKey: "settings.shortcut.clipboard.paste",
      },
      { kind: "action", action: "search.local", labelKey: "settings.shortcut.search.local" },
      { kind: "action", action: "session.close", labelKey: "settings.shortcut.session.close" },
      // UX-Spec §6.4: xterm markiert mit Umschalt lokal, auch wenn ein Programm
      // die Maus nutzt.
      {
        kind: "fixed",
        keys: ["Shift", { textKey: "settings.shortcuts.key.drag" }],
        labelKey: "settings.shortcut.mouseSelect",
      },
    ],
  },
];

/** "Ctrl+Shift+N" -> ["Ctrl", "Shift", "N"], ohne Leerraum und leere Teile. */
export function bindingKeys(binding: string): string[] {
  return binding
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Eine Chipgruppe einer Zeile: je Taste ein Chip, dazu ein Zusatz. */
interface KeyGroup {
  keys: string[];
  note?: string;
}

function catalogKeyText(key: CatalogKey): string {
  return typeof key === "string" ? key : t(key.textKey);
}

function rowGroups(row: ShortcutRow, keymap: Readonly<Record<KeymapAction, string>>): KeyGroup[] {
  switch (row.kind) {
    case "action":
      return [{ keys: bindingKeys(keymap[row.action]) }];
    case "fixed":
      return [{ keys: row.keys.map(catalogKeyText) }];
    case "range": {
      const first = bindingKeys(keymap[row.actions[0]]);
      const last = bindingKeys(keymap[row.actions[row.actions.length - 1]]);
      return [{ keys: [...first.slice(0, -1), `${first[first.length - 1]}–${last[last.length - 1]}`] }];
    }
    case "alternatives":
      return row.alternatives.map((alternative) =>
        "action" in alternative
          ? { keys: bindingKeys(keymap[alternative.action]) }
          : {
              keys: alternative.keys.map(catalogKeyText),
              note: alternative.noteKey === undefined ? undefined : t(alternative.noteKey),
            },
      );
  }
}

export function mountShortcutsSection(
  container: HTMLElement,
  keymap: Readonly<Record<KeymapAction, string>>,
): { dispose(): void } {
  const root = document.createElement("div");
  root.className = "settings-shortcuts";

  // UX-Spec §8.3: die Regel samt Ausnahmen. Strg+, steht in der Belegung und
  // kommt deshalb von dort; die Tasten der Schriftgroesse und der
  // Zwischenablage sind fest und stehen im Text.
  const intro = document.createElement("p");
  intro.className = "settings-intro";
  intro.textContent = t("settings.shortcuts.intro", { settings: keymap["settings.open"] });
  root.appendChild(intro);

  for (const group of SHORTCUT_GROUPS) {
    const card = document.createElement("div");
    card.className = "settings-card";
    const title = document.createElement("h3");
    title.className = "settings-card-title settings-card-title--rows";
    title.textContent = t(group.titleKey);
    card.appendChild(title);
    if (group.noteKey) {
      const note = document.createElement("p");
      note.className = "settings-card-note";
      note.textContent = t(group.noteKey);
      card.appendChild(note);
    }
    const list = document.createElement("dl");
    list.className = "settings-rows";
    for (const row of group.rows) {
      const item = document.createElement("div");
      item.className = "settings-row";
      const label = document.createElement("dt");
      label.textContent = t(row.labelKey);
      const value = document.createElement("dd");
      const groups = rowGroups(row, keymap);
      if (groups.length > 1) value.className = "settings-keys-alternatives";
      const separator = t((row.kind === "alternatives" && row.separatorKey) || "settings.shortcuts.or");
      groups.forEach((group, index) => {
        if (index > 0) {
          const sep = document.createElement("span");
          sep.className = "settings-keys-sep";
          sep.textContent = separator;
          value.appendChild(sep);
        }
        const keys = document.createElement("span");
        keys.className = "settings-keys";
        for (const key of group.keys) {
          const kbd = document.createElement("kbd");
          kbd.textContent = key;
          keys.appendChild(kbd);
        }
        if (group.note !== undefined) {
          const note = document.createElement("span");
          note.className = "settings-keys-note";
          note.textContent = group.note;
          keys.appendChild(note);
        }
        value.appendChild(keys);
      });
      item.append(label, value);
      list.appendChild(item);
    }
    card.appendChild(list);
    root.appendChild(card);
  }

  container.appendChild(root);
  return {
    dispose() {
      root.remove();
    },
  };
}
