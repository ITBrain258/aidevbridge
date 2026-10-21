// Einstellungsdialog (Einstellungs-Spec §2-§4): links die Bereiche als
// senkrechte Tabs (WAI-ARIA APG, automatische Aktivierung -- jeder Bereich
// erscheint sofort und ohne Laden), rechts der gewaehlte Bereich. Ein neuer
// Bereich ist ein Eintrag in SETTINGS_SECTIONS plus eine Datei. Gemountet
// von main.ts ueber `openDialog({ ..., large: true }, ...)` (`dialog.ts`);
// Escape und Fokusrueckkehr erledigt die Huelle.
//
// Fuenf Bereiche in der Reihenfolge der UX-Spec §9.1: General, Appearance,
// Terminal, Shortcuts, About. Der Dialog oeffnet auf dem ersten.
import en from "../i18n/en.json";
import { DEFAULT_KEYMAP, type KeymapAction } from "../keymap";
import type { ThemeId } from "../theme";
import { mountAboutSection } from "./settings-about";
import { mountAppearanceSection } from "./settings-appearance";
import { mountGeneralSection } from "./settings-general";
import { mountShortcutsSection } from "./settings-shortcuts";
import { mountTerminalSection } from "./settings-terminal";

type TranslationKey = keyof typeof en;

/** Die Werte kommen als Lesefunktionen, gelesen bei jedem Mounten eines
 * Bereichs: ein Wechsel des Bereichs entsorgt den alten und mountet den neuen.
 * Mit Werten vom Oeffnen des Dialogs zeigte ein Bereich nach dem Rueckweg einen
 * veralteten Stand (ein umgelegter Schalter, eine gewaehlte Farbe), und eine
 * spaete Antwort von `ui_settings` kaeme nie an. Die Bereiche selbst bekommen
 * davon nur den Stand zum Zeitpunkt ihres Mountens. */
export interface SettingsDialogOptions {
  /** Das angewandte Thema (Appearance). */
  currentTheme: () => ThemeId;
  /** Rohwert aus settings.toml, wenn er kein bekanntes Thema war; sonst null. */
  unknownStoredTheme: () => string | null;
  /** Sofort bei jeder Wahl einer Farbe. */
  onThemeChange: (theme: ThemeId) => void;
  /** Nach 150 ms Ruhe, spaetestens beim Verlassen von Appearance. */
  onPersist: (theme: ThemeId) => void;
  /** "Restore hosts and terminals" (General). */
  restoreWorkspace: () => boolean;
  onRestoreWorkspaceChange: (value: boolean) => void;
  /** Pfad von settings.toml fuer About; `null`, solange er unbekannt ist. */
  settingsPath: () => string | null;
  /** Belegung fuer die Uebersicht; ohne Angabe die Standardbelegung. Ein
   * spaeterer Editor fuer eigene Kuerzel reicht hier seine Tabelle durch. */
  keymap?: Readonly<Record<KeymapAction, string>>;
}

export interface SettingsDialogHandle {
  dispose(): void;
}

interface SettingsSection {
  id: "general" | "appearance" | "terminal" | "shortcuts" | "about";
  labelKey: TranslationKey;
  mount(container: HTMLElement, opts: SettingsDialogOptions): { dispose(): void };
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    labelKey: "settings.general",
    mount: (c, o) =>
      mountGeneralSection(c, {
        restoreWorkspace: o.restoreWorkspace(),
        onRestoreWorkspaceChange: o.onRestoreWorkspaceChange,
      }),
  },
  {
    id: "appearance",
    labelKey: "settings.appearance",
    mount: (c, o) =>
      mountAppearanceSection(c, {
        current: o.currentTheme(),
        unknownStoredTheme: o.unknownStoredTheme(),
        onThemeChange: o.onThemeChange,
        onPersist: o.onPersist,
      }),
  },
  // Der Terminalbereich liest und schreibt `terminal-prefs` selbst; main.ts
  // fuehrt jede Aenderung von dort weiter.
  { id: "terminal", labelKey: "settings.terminal", mount: (c) => mountTerminalSection(c) },
  { id: "shortcuts", labelKey: "settings.shortcuts", mount: (c, o) => mountShortcutsSection(c, o.keymap ?? DEFAULT_KEYMAP) },
  { id: "about", labelKey: "settings.about", mount: (c, o) => mountAboutSection(c, { settingsPath: o.settingsPath() }) },
];

export function mountSettingsDialog(
  container: HTMLElement,
  opts: SettingsDialogOptions,
): SettingsDialogHandle {
  const root = document.createElement("div");
  root.className = "settings-view";

  const nav = document.createElement("div");
  nav.className = "settings-nav";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-orientation", "vertical");
  nav.setAttribute("aria-label", en["settings.sections"]);

  const panel = document.createElement("div");
  panel.className = "settings-panel";
  panel.id = "settings-panel";
  panel.setAttribute("role", "tabpanel");
  // Auch ohne eigene Bedienelemente (Shortcuts) per Tastatur scrollbar.
  panel.tabIndex = 0;

  let current = -1;
  let handle: { dispose(): void } | null = null;

  const tabs = SETTINGS_SECTIONS.map((section, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "settings-tab";
    tab.id = `settings-tab-${section.id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);
    tab.textContent = en[section.labelKey];
    tab.addEventListener("click", () => select(index));
    nav.appendChild(tab);
    return tab;
  });

  /** Entsorgt den offenen Bereich (Appearance schreibt dabei einen offenen
   * Themenwert sofort), mountet den neuen und haengt die Beschriftung um. */
  function select(index: number): void {
    if (index === current) return;
    handle?.dispose();
    handle = null;
    current = index;
    tabs.forEach((tab, i) => {
      const isSelected = i === index;
      tab.setAttribute("aria-selected", String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", tabs[index].id);
    panel.scrollTop = 0;
    handle = SETTINGS_SECTIONS[index].mount(panel, opts);
  }

  nav.addEventListener("keydown", (event) => {
    const last = tabs.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = current === last ? 0 : current + 1;
        break;
      case "ArrowUp":
        next = current === 0 ? last : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(next);
    tabs[next].focus();
  });

  select(0);
  root.append(nav, panel);
  container.appendChild(root);

  return {
    dispose() {
      handle?.dispose();
      handle = null;
      root.remove();
    },
  };
}
