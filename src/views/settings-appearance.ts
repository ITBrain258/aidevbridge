// Einstellungen, Bereich "Appearance" (Farbwahl-Spec §6, Einstellungs-Spec
// §5): zwei Karten mit nativen Radiogruppen -- Akzent als sieben runde
// Farbfelder, Grundton als zwei Karten. Native Radios, weil sie Pfeiltasten,
// Home/End und "genau ein Tabstopp je Gruppe" ohne eigenes Roving liefern.
// Jedes Feld zeigt seine Farbe ueber `data-accent` bzw. `data-base` am
// eigenen Element (styles.css) -- keine zweite Kopie der Farbwerte. Die
// Karte ist ein `div` UM das fieldset: ein fieldset mit eigenem Rahmen
// setzte die Legende auf die Rahmenlinie.
import en from "../i18n/en.json";
import { icon } from "../icons";
import { ACCENTS, BASES, themeIdOf, themeParts, type AccentId, type BaseId, type ThemeId } from "../theme";

type TranslationKey = keyof typeof en;

function t(key: TranslationKey, params?: Record<string, string>): string {
  const template = en[key];
  if (!params) return template;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.split(`{${name}}`).join(value),
    template,
  );
}

export interface AppearanceOptions {
  current: ThemeId;
  /** Rohwert aus settings.toml, wenn er kein bekanntes Thema war; sonst null. */
  unknownStoredTheme: string | null;
  /** Sofort bei `change` -- wendet das Thema an (applyTheme). */
  onThemeChange: (theme: ThemeId) => void;
  /** Nach 150 ms Ruhe (Pfeilrunden schreiben nicht mehrfach), spaetestens bei dispose(). */
  onPersist: (theme: ThemeId) => void;
}

const PERSIST_DEBOUNCE_MS = 150;

const ACCENT_LABEL: Record<AccentId, TranslationKey> = {
  turquoise: "settings.accent.turquoise",
  blue: "settings.accent.blue",
  violet: "settings.accent.violet",
  pink: "settings.accent.pink",
  red: "settings.accent.red",
  orange: "settings.accent.orange",
  green: "settings.accent.green",
};

const BASE_LABEL: Record<BaseId, TranslationKey> = {
  graphite: "settings.background.graphite",
  slate: "settings.background.slate",
};

function radio(name: string, value: string, checked: boolean): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.className = "ab-visually-hidden";
  return input;
}

/** Karte mit einer Radiogruppe; die Legende ist der Kartentitel. */
function cardGroup(legendKey: TranslationKey): { card: HTMLDivElement; group: HTMLFieldSetElement } {
  const card = document.createElement("div");
  card.className = "settings-card";
  const group = document.createElement("fieldset");
  group.className = "settings-group";
  const legend = document.createElement("legend");
  legend.className = "settings-card-title";
  legend.textContent = t(legendKey);
  group.appendChild(legend);
  card.appendChild(group);
  return { card, group };
}

export function mountAppearanceSection(
  container: HTMLElement,
  opts: AppearanceOptions,
): { dispose(): void } {
  const root = document.createElement("div");
  root.className = "settings-appearance";

  let { accent, base } = themeParts(opts.current);
  let pending: ThemeId | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flushPersist(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending === null) return;
    const theme = pending;
    pending = null;
    opts.onPersist(theme);
  }

  /** Wendet die neue Kombination sofort an und schreibt sie nach 150 ms Ruhe. */
  function select(next: { accent?: AccentId; base?: BaseId }): void {
    accent = next.accent ?? accent;
    base = next.base ?? base;
    const theme = themeIdOf(accent, base);
    opts.onThemeChange(theme);
    pending = theme;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
  }

  // Akzent: runde Farbfelder ohne sichtbaren Text -- deshalb traegt jedes
  // Feld seinen Namen als `aria-label` und `title` (v1 §9 Nr. 11), und der
  // Name des gewaehlten steht daneben als Text.
  const accentCard = cardGroup("settings.accent");
  const accentRow = document.createElement("div");
  accentRow.className = "accent-row";
  const swatches = document.createElement("div");
  swatches.className = "accent-swatches";
  const currentName = document.createElement("span");
  currentName.className = "accent-current";
  currentName.textContent = t(ACCENT_LABEL[accent]);
  for (const id of ACCENTS) {
    const option = document.createElement("label");
    option.className = "accent-option";
    option.dataset.accent = id;
    option.title = t(ACCENT_LABEL[id]);
    const input = radio("accent", id, id === accent);
    input.setAttribute("aria-label", t(ACCENT_LABEL[id]));
    input.addEventListener("change", () => {
      if (!input.checked) return;
      currentName.textContent = t(ACCENT_LABEL[id]);
      select({ accent: id });
    });
    const dot = document.createElement("span");
    dot.className = "accent-dot";
    dot.setAttribute("aria-hidden", "true");
    dot.appendChild(icon("check", 14));
    option.append(input, dot);
    swatches.appendChild(option);
  }
  accentRow.append(swatches, currentName);
  accentCard.group.appendChild(accentRow);

  // Grundton: `data-base` an der Karte laesst Karte und Quadrate in IHREM
  // Grundton erscheinen; das vierte Quadrat zeigt den gewaehlten Akzent
  // darauf -- die Karte ist die Vorschau der Kombination.
  const baseCard = cardGroup("settings.background");
  const cards = document.createElement("div");
  cards.className = "base-cards";
  for (const id of BASES) {
    const card = document.createElement("label");
    card.className = "base-card";
    card.dataset.base = id;
    const input = radio("base", id, id === base);
    input.addEventListener("change", () => {
      if (input.checked) select({ base: id });
    });
    const swatchRow = document.createElement("span");
    swatchRow.className = "base-swatches";
    swatchRow.setAttribute("aria-hidden", "true");
    for (const part of ["canvas", "panel", "card", "accent"]) {
      const swatch = document.createElement("span");
      swatch.className = `base-swatch base-swatch--${part}`;
      swatchRow.appendChild(swatch);
    }
    const name = document.createElement("span");
    name.className = "base-card-name";
    name.textContent = t(BASE_LABEL[id]);
    const check = document.createElement("span");
    check.className = "base-card-check icon-box";
    check.appendChild(icon("check"));
    card.append(input, swatchRow, name, check);
    cards.appendChild(card);
  }
  baseCard.group.appendChild(cards);

  root.append(accentCard.card, baseCard.card);

  if (opts.unknownStoredTheme !== null) {
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = t("settings.themeUnknown", { name: opts.unknownStoredTheme });
    root.appendChild(hint);
  }

  container.appendChild(root);

  return {
    dispose() {
      flushPersist();
      root.remove();
    },
  };
}
