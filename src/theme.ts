// Farbwahl (Spec `2026-09-14-farbwahl-design.md`, UI-v2-Spec §12.5): Akzent
// x Grundton, 7 x 2 = 14 Varianten. Die Attribute `data-accent` und
// `data-base` an <html> waehlen die Tokenbloecke in styles.css;
// `localStorage["ab.theme"]` ist nur der Vorlauf fuer den ersten Anstrich --
// die Wahrheit liegt in settings.toml (`ui_settings`, main.ts).

export const ACCENTS = ["turquoise", "blue", "violet", "pink", "red", "orange", "green"] as const;
export type AccentId = (typeof ACCENTS)[number];
export const BASES = ["graphite", "slate"] as const;
export type BaseId = (typeof BASES)[number];

/** Die beiden Kombinationen aus UI v2 behalten ihre Namen -- auch beim
 * Schreiben, damit aeltere Builds sie weiter lesen (Farbwahl-Spec §4). Ihre
 * Langformen sind deshalb keine gueltigen Ids. */
type LegacyLongForm = "turquoise-graphite" | "blue-slate";
export type ThemeId = "turquoise" | "slate" | Exclude<`${AccentId}-${BaseId}`, LegacyLongForm>;

export const DEFAULT_THEME: ThemeId = "turquoise";
export const THEME_STORAGE_KEY = "ab.theme";

export function themeIdOf(accent: AccentId, base: BaseId): ThemeId {
  if (accent === "turquoise" && base === "graphite") return "turquoise";
  if (accent === "blue" && base === "slate") return "slate";
  return `${accent}-${base}` as ThemeId;
}

export function themeParts(id: ThemeId): { accent: AccentId; base: BaseId } {
  if (id === "turquoise") return { accent: "turquoise", base: "graphite" };
  if (id === "slate") return { accent: "blue", base: "slate" };
  const [accent, base] = id.split("-") as [AccentId, BaseId];
  return { accent, base };
}

export const THEMES: readonly ThemeId[] = ACCENTS.flatMap((accent) =>
  BASES.map((base) => themeIdOf(accent, base)),
);

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Gueltiges Thema oder `turquoise`. Warnt nur bei einem GESETZTEN unbekannten
 * Wert -- `undefined`/`null`/`""` sind "kein Wert" (Erststart, Testmocks). */
export function normalizeTheme(raw: unknown): ThemeId {
  if (isThemeId(raw)) return raw;
  if (raw !== undefined && raw !== null && raw !== "") {
    console.warn(`[theme] unknown theme ${JSON.stringify(raw)}, using ${DEFAULT_THEME}`);
  }
  return DEFAULT_THEME;
}

let current: ThemeId = DEFAULT_THEME;
const listeners = new Set<(theme: ThemeId) => void>();

export function currentTheme(): ThemeId {
  return current;
}

export function onThemeApplied(fn: (theme: ThemeId) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function applyTheme(theme: ThemeId): void {
  current = theme;
  const { accent, base } = themeParts(theme);
  const root = document.documentElement;
  root.dataset.accent = accent;
  root.dataset.base = base;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Speicher gesperrt oder voll: der Wert lebt dann nur in settings.toml.
  }
  for (const fn of listeners) fn(theme);
}

export function readCachedTheme(): ThemeId {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY) ?? undefined);
  } catch {
    return DEFAULT_THEME;
  }
}
