import css from "./styles.css?raw";
import { describe, expect, it } from "vitest";
import { SIDEBAR_WIDTH_DEFAULT } from "./views/sidebar-resize";

function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`Regel ${selector} fehlt`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

describe("hidden-Gates fuer per `.hidden` geschaltete Elemente", () => {
  // Die UA-Regel `[hidden] { display: none }` verliert gegen JEDE
  // Autorenregel mit `display` -- deshalb darf `display` nur in der
  // `:not([hidden])`-Variante stehen (dasselbe Muster wie
  // `.global-error-banner:not([hidden])`).
  for (const selector of [
    ".tile-lock",
    ".tile-lock-chip",
    ".tile-quiet",
    ".tile-narrow",
    ".first-run-suggested-list",
  ]) {
    it(`${selector} setzt display nur ohne hidden`, () => {
      expect(ruleBody(selector)).not.toMatch(/display\s*:/);
      expect(ruleBody(`${selector}:not([hidden])`)).toMatch(/display:\s*flex/);
    });
  }
});

/** Kommentarfreie Fassung fuer dateiweite Regex-Zusicherungen: Kommentare
 * nennen Selektoren und Eigenschaften woertlich (z. B. ":focus-visible" im
 * Kommentar vor `.dir-tree-hidden input[type="checkbox"]`). `ruleBody()`
 * bleibt auf `css`, weil es Selektoren am Zeilenanfang sucht. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("[hidden] gewinnt gegen jede Autorenregel", () => {
  it("setzt display: none !important", () => {
    expect(ruleBody("[hidden]")).toMatch(/display:\s*none\s*!important/);
  });
});

// --- Token lesen -----------------------------------------------------------

/** Alle `--ab-*`-Deklarationen eines Blocks als Name → Rohwert. */
function tokenBlock(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of ruleBody(selector).matchAll(/(--ab-[a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** Löst `var(--x)` bis zu drei Stufen tief auf. */
function resolveVar(tokens: Record<string, string>, value: string): string {
  let v = value;
  for (let i = 0; i < 3 && /var\(/.test(v); i++) {
    v = v.replace(/var\((--ab-[a-z0-9-]+)\)/g, (_, name: string) => {
      const t = tokens[name];
      if (t === undefined) throw new Error(`Token ${name} fehlt`);
      return t;
    });
  }
  return v;
}

type Rgb = { r: number; g: number; b: number };

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }, alpha: 1 };
  }
  const fn = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (fn) {
    return {
      rgb: { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) },
      alpha: fn[4] === undefined ? 1 : parseFloat(fn[4]),
    };
  }
  throw new Error(`Farbe nicht lesbar: ${value}`);
}

/** Mischt eine (ggf. durchscheinende) Farbe über eine deckende Fläche. */
function over(top: string, under: Rgb): Rgb {
  const { rgb, alpha } = parseColor(top);
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha);
  return { r: mix(rgb.r, under.r), g: mix(rgb.g, under.g), b: mix(rgb.b, under.b) };
}

function luminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Kontrast von `fg` auf `bg`, optional mit einer Tönung `tint` über `bg`. */
function contrastOf(tokens: Record<string, string>, fg: string, bg: string, tint: string | null): number {
  const base = parseColor(resolveVar(tokens, tokens[bg])).rgb;
  const surface = tint ? over(resolveVar(tokens, tokens[tint]), base) : base;
  return contrast(over(resolveVar(tokens, tokens[fg]), surface), surface);
}

// [Vordergrund, Fläche, Tönung über der Fläche, Mindestkontrast] -- Spec 5.4.
const CONTRAST_PAIRS: ReadonlyArray<readonly [string, string, string | null, number]> = [
  ["--ab-text-primary", "--ab-bg-panel", null, 4.5],
  ["--ab-text-primary", "--ab-bg-card", null, 4.5],
  ["--ab-text-primary", "--ab-bg-hover", null, 4.5],
  ["--ab-text-muted", "--ab-bg-hover", null, 4.5],
  ["--ab-text-secondary", "--ab-bg-card", null, 4.5],
  ["--ab-text-secondary", "--ab-bg-card", "--ab-accent-soft", 4.5],
  ["--ab-text-secondary", "--ab-bg-hover", null, 4.5],
  ["--ab-text-muted", "--ab-bg-card", null, 4.5],
  ["--ab-text-muted", "--ab-bg-panel", null, 4.5],
  ["--ab-accent-ink", "--ab-accent", null, 4.5],
  ["--ab-accent", "--ab-bg-card", null, 4.5],
  ["--ab-ok", "--ab-bg-card", "--ab-ok-bg", 4.5],
  ["--ab-warn", "--ab-bg-card", "--ab-warn-bg", 4.5],
  ["--ab-danger", "--ab-bg-card", "--ab-danger-bg", 4.5],
  ["--ab-idle", "--ab-bg-card", "--ab-idle-bg", 4.5],
  // Statuspillen (M1.2) auch im fokussierten Kachelkopf.
  ["--ab-warn", "--ab-bg-active", "--ab-warn-bg", 4.5],
  ["--ab-ok", "--ab-bg-active", "--ab-ok-bg", 4.5],
  ["--ab-idle", "--ab-bg-active", "--ab-idle-bg", 4.5],
  ["--ab-danger", "--ab-bg-active", "--ab-danger-bg", 4.5],
  ["--ab-text-secondary", "--ab-bg-active", null, 4.5],
  ["--ab-text-secondary", "--ab-bg-card", "--ab-danger-bg", 4.5],
  ["--ab-text-secondary", "--ab-bg-panel", "--ab-warn-bg", 4.5],
  ["--ab-avatar-fg", "--ab-avatar-bg", null, 4.5],
  ["--ab-focus-ring", "--ab-bg-panel", null, 3.0],
  ["--ab-scrollbar", "--ab-bg-panel", null, 3.0],
  ["--ab-scrollbar", "--ab-term-bg", null, 3.0],
  // Einstellungen (Einstellungs-Spec §9): gewaehlter Tab, Einleitungssatz,
  // Fokus auf dem Panel.
  ["--ab-text-primary", "--ab-bg-panel", "--ab-accent-soft", 4.5],
  ["--ab-text-muted", "--ab-bg-canvas", null, 4.5],
  ["--ab-focus-ring", "--ab-bg-canvas", null, 3.0],
  // Schnelloeffnen (UX-Spec §7.5): der Host auf der gewaehlten Zeile im Dialog.
  ["--ab-text-secondary", "--ab-bg-panel", "--ab-accent-soft", 4.5],
];

// Farbwahl (Spec 2026-09-14 §3): jede Variante ist `:root` + Grundtonblock +
// Akzentblock. Die Standardblöcke tragen `:root` im Selektor.
const BASE_IDS = ["graphite", "slate"] as const;
const ACCENT_IDS = ["turquoise", "blue", "violet", "pink", "red", "orange", "green"] as const;
const baseBlock = (id: string) =>
  tokenBlock(id === "graphite" ? ':root, [data-base="graphite"]' : `[data-base="${id}"]`);
const accentBlock = (id: string) =>
  tokenBlock(id === "turquoise" ? ':root, [data-accent="turquoise"]' : `[data-accent="${id}"]`);
const variantTokens = (accent: string, base: string) => ({
  ...tokenBlock(":root"),
  ...baseBlock(base),
  ...accentBlock(accent),
});

// Connecting trägt eigene, feste Token (Farbwahl-Spec §2.2): Pille in der
// Hostzeile auf Karte und Panel.
const CONNECTING_PAIRS: ReadonlyArray<readonly [string, string, string | null, number]> = [
  ["--ab-connecting", "--ab-bg-card", "--ab-connecting-bg", 4.5],
  ["--ab-connecting", "--ab-bg-panel", "--ab-connecting-bg", 4.5],
];

describe("Kontrast aller 14 Farbvarianten (Spec 5.4, Farbwahl §3)", () => {
  for (const base of BASE_IDS) {
    for (const accent of ACCENT_IDS) {
      const tokens = variantTokens(accent, base);
      for (const [fg, bg, tint, min] of [...CONTRAST_PAIRS, ...CONNECTING_PAIRS]) {
        it(`${accent}/${base}: ${fg} auf ${bg}${tint ? ` + ${tint}` : ""} ≥ ${min}`, () => {
          expect(contrastOf(tokens, fg, bg, tint)).toBeGreaterThanOrEqual(min);
        });
      }
    }
  }
  it("jeder Grundtonblock nennt dieselben Token, jeder Akzentblock ebenso", () => {
    const names = (block: Record<string, string>) => Object.keys(block).sort();
    for (const id of BASE_IDS) expect(names(baseBlock(id)), id).toEqual(names(baseBlock("graphite")));
    for (const id of ACCENT_IDS) expect(names(accentBlock(id)), id).toEqual(names(accentBlock("turquoise")));
  });
  it("Grundton, Akzent und :root teilen sich kein Token", () => {
    const root = Object.keys(tokenBlock(":root"));
    const base = Object.keys(baseBlock("graphite"));
    const accent = Object.keys(accentBlock("turquoise"));
    expect(base.filter((name) => accent.includes(name) || root.includes(name))).toEqual([]);
    expect(accent.filter((name) => root.includes(name))).toEqual([]);
  });
  it("der Fokusring ist fest und neutral", () => {
    expect(tokenBlock(":root")["--ab-focus-ring"]).toBe("#E6EAF0");
  });
});

describe("Farbwahl: Zustand und Gefahr ohne Akzent (Spec 2026-09-14 §2)", () => {
  it("Connecting nutzt die festen Token und nirgends den Akzent", () => {
    expect(ruleBody(".ind-connecting")).toMatch(/border:\s*1\.5px solid var\(--ab-connecting\)/);
    expect(ruleBody(".ind-connecting::after")).toMatch(/border-top-color:\s*var\(--ab-connecting\)/);
    expect(code).toMatch(
      /\.state-pill--connecting\s*\{\s*background-color:\s*var\(--ab-connecting-bg\);\s*color:\s*var\(--ab-connecting\);\s*\}/,
    );
    for (const m of code.matchAll(/([^{}]*connecting[^{}]*)\{([^}]*)\}/g)) {
      expect(m[2], m[1].trim()).not.toMatch(/--ab-accent/);
    }
  });
  it("Gefahr-Knöpfe tragen das Warndreieck als Maske in currentColor", () => {
    const body = ruleBody(".btn--danger::before");
    expect(body).toMatch(/content:\s*""/);
    expect(body).toMatch(/background-color:\s*currentColor/);
    expect(body).toMatch(/\bmask:\s*url\("data:image\/svg\+xml,[^"]+"\)/);
  });
  it("native Bedienelemente folgen dem Akzent", () => {
    expect(ruleBody(":root")).toMatch(/accent-color:\s*var\(--ab-accent\);/);
  });
});

describe("Bewegung (Spec 14)", () => {
  const ALLOWED = new Set(["color", "background-color", "border-color", "outline-color", "opacity"]);
  it("transition nur auf erlaubten Eigenschaften, höchstens 120 ms", () => {
    const decls = [...code.matchAll(/\btransition:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length).toBeGreaterThan(0);
    for (const decl of decls) {
      // `none !important` (an `#app` unter reduzierter Bewegung, Abnahme B3)
      // heisst ebenso: kein Uebergang.
      if (/^none(\s*!important)?$/.test(decl)) continue;
      for (const part of decl.split(",")) {
        const m = part
          .trim()
          .match(/^([a-z-]+)\s+(var\(--ab-motion-fast\)|(\d+)ms)(?:\s+var\(--ab-motion-ease\))?$/);
        expect(m, part).not.toBeNull();
        expect(ALLOWED.has(m![1]), part).toBe(true);
        if (m![3] !== undefined) expect(Number(m![3]), part).toBeLessThanOrEqual(120);
      }
    }
    expect(code).not.toMatch(/\btransition-(property|delay|timing-function):/);
  });
  it("--ab-motion-fast ist höchstens 120 ms", () => {
    expect(Number(tokenBlock(":root")["--ab-motion-fast"].replace("ms", ""))).toBeLessThanOrEqual(120);
  });
  it("die einzige animation ist ab-sidebar-spin", () => {
    for (const m of code.matchAll(/\banimation(?:-name)?:\s*([^;]+);/g)) {
      expect(m[1].trim().split(/\s+/)[0]).toBe("ab-sidebar-spin");
    }
    expect([...code.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1])).toEqual(["ab-sidebar-spin"]);
  });
  // Abnahme B3: der Reset unter reduzierter Bewegung gibt jedem Element einen
  // 1-ms-Uebergang ueber `all` -- auch `#app` und damit der Spalte der
  // Seitenleiste. Das Raster liest seine Flaeche synchron (Spec §4.5) und lag
  // dann einen Schritt zurueck. `#app` nimmt sich deshalb aus, mit ID und
  // `!important`, sonst gewinnt der Reset.
  it("unter reduzierter Bewegung hat #app gar keinen Uebergang, auch nicht den 1-ms-Reset", () => {
    const block = mediaBlock("(prefers-reduced-motion: reduce)");
    expect(block).toMatch(/transition-duration:\s*1ms\s*!important;/);
    expect(blockRule(block, "#app")).toMatch(/transition:\s*none\s*!important;/);
  });
});

describe("Schrift (Spec 6.2)", () => {
  const SCALE: Record<string, string> = {
    "10px": "12px", "11px": "14px", "12px": "16px", "13px": "18px", "15px": "20px", "18px": "24px",
  };
  const root = tokenBlock(":root");
  const afterTokens = code.slice(code.indexOf("\n}", code.indexOf("\n:root {")));

  it("jede Tokenstufe ist ein Paar aus der Stufenliste", () => {
    for (const step of ["2xs", "xs", "sm", "md", "lg", "xl"]) {
      expect(SCALE[root[`--ab-fs-${step}`]], step).toBe(root[`--ab-lh-${step}`]);
    }
  });
  it("außerhalb des Tokenblocks keine losen Schriftgrößen oder Zeilenhöhen in px/em/rem/%", () => {
    expect(afterTokens.match(/font-size:\s*[\d.]+(px|em|rem|%)/g) ?? []).toEqual([]);
    expect(afterTokens.match(/line-height:\s*[\d.]+px/g) ?? []).toEqual([]);
    expect(afterTokens.match(/\bfont:\s*[\d.]+(px|em|rem|%)/g) ?? []).toEqual([]);
  });
  it("Gewichte nur über Token; 700 nur am Kürzelquadrat", () => {
    // Lookahead direkt hinter dem Doppelpunkt, `\s*` INNERHALB -- sonst
    // backtrackt die Engine auf null Leerzeichen und jede Deklaration passt.
    expect(afterTokens.match(/font-weight:(?!\s*var\(--ab-fw-)[^;]+;/g) ?? []).toEqual([]);
    for (const m of afterTokens.matchAll(/\n([^{}]+)\{[^}]*var\(--ab-fw-bold\)/g)) {
      expect(m[1], m[1]).toMatch(/avatar/);
    }
  });
  it("jede Regel, die Schriftgröße UND Zeilenhöhe setzt, nimmt beide aus derselben Stufe", () => {
    for (const m of afterTokens.matchAll(/\n([^{}]+)\{([^}]*)\}/g)) {
      const fs = m[2].match(/font-size:\s*var\(--ab-fs-([a-z0-9]+)\)/);
      const lh = m[2].match(/line-height:\s*var\(--ab-lh-([a-z0-9]+)\)/);
      if (fs && lh) expect(lh[1], m[1].trim()).toBe(fs[1]);
    }
  });
});

// --- Optische Mitte (v2 §6.4) ------------------------------------------------

/** Selektorliste an Kommas der obersten Ebene getrennt (`:where(a, b)` bleibt ganz). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth += 1;
    else if (list[i] === ")") depth -= 1;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

/** Das Element, das ein Selektor meint: sein letzter Verbund hinter dem letzten Kombinator. */
function subjectOf(selector: string): string {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(c)) last = i + 1;
  }
  return selector.slice(last);
}

/** Meint `selector` dasselbe Element wie ein Eintrag der Trimmliste? */
function targetsTrimmed(selector: string, trimmed: string): boolean {
  const norm = (s: string) => s.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
  if (/[\s>+~]/.test(trimmed)) return norm(selector).endsWith(norm(trimmed));
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${trimmed.startsWith(".") ? "" : "^"}${escaped}(?![\\w-])`).test(subjectOf(selector));
}

describe("Optische Mitte: getrimmte Beschriftungen zeigen ganze Zeichen (v2 §6.4)", () => {
  const head = "@supports (text-box: trim-both cap alphabetic) {";
  /** Die Elemente, deren Textkasten auf Versal- und Grundlinie getrimmt ist. */
  function trimmed(): string[] {
    const start = code.indexOf(head);
    if (start < 0) throw new Error(`Block ${head} fehlt`);
    const list = code.slice(start + head.length, code.indexOf("{", start + head.length));
    return splitSelectors(list);
  }

  it("die Trimmliste wird gelesen", () => {
    expect(trimmed()).toEqual(expect.arrayContaining([".row-label", ".tile-title", ".tile-host", "kbd", ".settings-row > dt"]));
  });

  it("die Kachelnummer in Liste und Spur steht in der Liste wie das Abzeichen im Kachelkopf", () => {
    expect(trimmed()).toEqual(expect.arrayContaining([".badge", ".tile-number"]));
  });

  it("die Beschriftungen der Wartet-Spur stehen in der Liste, der Grund kuerzt nur waagerecht (Spec 2026-10-19 §7)", () => {
    expect(trimmed()).toEqual(
      expect.arrayContaining([".sb-lane-title", ".row-lane-time", ".row-lane-reason", ".row-lane-more"]),
    );
    const reason = ruleBody(".row-lane-reason");
    expect(reason).toMatch(/overflow-x:\s*clip;/);
    expect(reason).toMatch(/overflow-y:\s*visible;/);
    expect(reason).toMatch(/text-overflow:\s*ellipsis;/);
  });

  // Der getrimmte Kasten endet an der Grundlinie: was senkrecht beschneidet,
  // schneidet Unterlaengen und Klammern ab ("(accept)" liest sich "(accent)").
  it("kein getrimmtes Element beschneidet senkrecht", () => {
    const offenders: string[] = [];
    for (const [, list, body] of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      // `\w` nach `\s*`: sonst liesse das Zuruecksetzen ueber das Leerzeichen
      // `overflow-y: visible` als Treffer durch.
      const clips = /(?:^|[;\s])overflow\s*:\s*(?!visible\s*(?:;|$))\w/.test(body) ||
        /overflow-y\s*:\s*(?!visible\b)\w/.test(body);
      if (!clips) continue;
      for (const selector of splitSelectors(list)) {
        if (trimmed().some((entry) => targetsTrimmed(selector, entry))) offenders.push(selector);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("die gekuerzten Beschriftungen schneiden nur waagerecht ab und behalten die Ellipse", () => {
    for (const selector of [".row-label", ".tile-title", ".tile-host", ".first-run-suggestion-alias", ".first-run-suggestion-detail"]) {
      const body = ruleBody(selector);
      expect(body, selector).toMatch(/overflow-x:\s*clip;/);
      expect(body, selector).toMatch(/overflow-y:\s*visible;/);
      expect(body, selector).toMatch(/text-overflow:\s*ellipsis;/);
      expect(body, selector).toMatch(/white-space:\s*nowrap;/);
    }
  });

  // `clip` macht kein Rollelement: ohne `min-width: 0` waere die Mindestbreite
  // eines Flex-Elements in der Zeile sein Inhalt, und die Ellipse kaeme nie.
  it("Kachel- und Zeilenbeschriftungen duerfen in ihrer Flex-Zeile schrumpfen", () => {
    for (const selector of [".row-label", ".tile-title", ".tile-host"]) {
      expect(ruleBody(selector), selector).toMatch(/min-width:\s*0;/);
    }
  });
});

describe("Zielzeile der Link-Rueckfrage", () => {
  it("zeigt das volle Ziel: bricht an jeder Stelle um, hoechstens 480 px breit, nichts abgeschnitten", () => {
    const body = ruleBody(".terminal-menu-heading");
    expect(body).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(body).toMatch(/max-width:\s*480px;/);
    expect(body).not.toMatch(/white-space:\s*nowrap|text-overflow|overflow:\s*hidden/);
  });
});

describe("Fokus (Spec 6.9)", () => {
  it("nirgends outline: none oder outline: 0", () => {
    expect(code).not.toMatch(/outline:\s*(none|0)\s*[;!]/);
  });
  it("jede :focus-visible-Regel setzt outline oder outline-offset", () => {
    const rules = [...code.matchAll(/\n([^{}]*:focus-visible[^{]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const m of rules) expect(m[2], m[1]).toMatch(/\boutline(-color|-offset)?:/);
  });
});

describe("viertes Gate: xterm-Scrollbalken bleibt sichtbar (Spec 13.3)", () => {
  it("ueberschreibt .invisible mit opacity 1, pointer-events auto, transition none", () => {
    const body = ruleBody(".tile-terminal .xterm .xterm-scrollable-element > .invisible");
    expect(body).toMatch(/opacity:\s*1;/);
    expect(body).toMatch(/pointer-events:\s*auto;/);
    expect(body).toMatch(/transition:\s*none;/);
  });
});

describe("Seitenleiste v2 (Spec 7)", () => {
  it("die Hostkarte ist die Karte, die Hostzeile klebt mit Kartenflaeche", () => {
    expect(ruleBody(".sb-host-block")).toMatch(/background-color:\s*var\(--ab-bg-card\)/);
    expect(ruleBody(".sb-host-block")).toMatch(/border-radius:\s*var\(--ab-radius-md\)/);
    expect(ruleBody(".sb-host-block")).not.toMatch(/overflow:/); // sticky braucht den Scrollbehaelter .sb-list
    const row = ruleBody(".row-host");
    expect(row).toMatch(/position:\s*sticky/);
    expect(row).toMatch(/background-color:\s*var\(--ab-bg-card\)/);
    expect(row).toMatch(/height:\s*var\(--ab-row-h-host\)/);
    expect(ruleBody(".sb-list")).toMatch(/padding:\s*0;/);
  });
  it("Hostaktionen sind nur am aktiven Host oder bei Fokus darin sichtbar, aber nicht hinter dem eigenen offenen Menue versteckt", () => {
    // Bewusst .host-actions [aria-expanded="true"] statt des weiteren
    // .sb-host-block [aria-expanded="true"]: .row-host traegt ein eigenes
    // aria-expanded fuer den Aufklapp-Zustand der Sessionliste
    // (buildHostBlock in views/sidebar.ts), das mit dem Menue nichts zu tun
    // hat.
    // `--held`: der Block, in dem beim Druck der Fokus stand (Abnahme B2).
    expect(
      ruleBody(
        '.sb-host-block:not(.sb-host-block--active):not(.sb-host-block--held):not(:focus-within):not(:has(.host-actions [aria-expanded="true"])) .host-actions',
      ),
    ).toMatch(/display:\s*none/);
  });
  // Abnahme B2: waehrend eines Drucks in der Liste (`sidebar.ts` setzt die
  // Klasse) zeigt der Fokus in einem Block dessen Leiste nicht -- sie schoebe
  // die Zeilen vor dem Loslassen weg. Stehen bleiben der markierte Block, der
  // beim Druck fokussierte (`--held`) und der mit offenem eigenem Menue.
  it("waehrend eines Drucks in der Liste bleibt die Leiste eines nicht aktiven, nicht gehaltenen Hosts verborgen, auch mit Fokus darin", () => {
    expect(
      ruleBody(
        '.sb-list--pressing .sb-host-block:not(.sb-host-block--active):not(.sb-host-block--held):not(:has(.host-actions [aria-expanded="true"])) .host-actions',
      ),
    ).toMatch(/display:\s*none/);
  });
  it("Sessionzeile: 26 px, Einzug 34 px, Auswahl mit Akzent-Toenung", () => {
    const row = ruleBody(".row-session");
    expect(row).toMatch(/height:\s*var\(--ab-row-h-session\)/);
    expect(row).toMatch(/padding-left:\s*34px/);
    expect(ruleBody('.row-session[aria-current="true"]')).toMatch(/background-color:\s*var\(--ab-accent-soft\)/);
  });
  it("gewaehlte Sessionzeile bleibt in Primaerfarbe (Spec 7.4) -- .sb-session-row setzt kein eigenes color mehr", () => {
    // .sb-session-row .ab-row.row-session (0,3,0) schlug bisher
    // .row-session[aria-current="true"] (0,2,0) und hielt die gewaehlte
    // Zeile faelschlich in der sekundaeren Farbe. Die Sekundaerfarbe
    // gehoert nur noch der Basisregel .row-session.
    expect(ruleBody(".sb-session-row .ab-row.row-session")).not.toMatch(/color:/);
    expect(ruleBody(".row-session")).toMatch(/color:\s*var\(--ab-text-secondary\)/);
    expect(ruleBody('.row-session[aria-current="true"]')).toMatch(/color:\s*var\(--ab-text-primary\)/);
  });
  // Task 16, Punkt A: die zwei Sessionaktionen liegen als Icon-Knoepfe rechts
  // IN der Zeile und erscheinen nur bei Auswahl, Fokus oder Hover -- per
  // `visibility`, damit die Zeile nicht springt.
  it("Sessionaktionen liegen unsichtbar in der Zeile und erscheinen bei Auswahl, Fokus oder Hover", () => {
    const acts = ruleBody(".session-acts");
    expect(acts).toMatch(/visibility:\s*hidden/);
    expect(acts).toMatch(/position:\s*absolute/);
    expect(
      ruleBody(
        '.sb-session-row:hover .session-acts,\n.sb-session-row:focus-within .session-acts,\n.sb-session-row:has(.row-session[aria-current="true"]) .session-acts',
      ),
    ).toMatch(/visibility:\s*visible/);
  });

  // Review Runde 1, Befund 2 (gering): ohne Aktionsknoepfe (getrennter Host,
  // geschlossene Session) blieb `.session-acts` leer, aber die drei
  // Hover/Fokus/Auswahl-Regeln versteckten `.row-meta` trotzdem -- das
  // Zustandswort verschwand ohne Ersatz. `:has(.session-acts button)`
  // beschraenkt das Verstecken auf Zeilen mit tatsaechlichen Knoepfen.
  it("Zustandswort der Sessionzeile bleibt sichtbar, wenn keine Aktionsknoepfe vorhanden sind", () => {
    expect(
      ruleBody(
        '.sb-session-row:hover:has(.session-acts button) .row-meta,\n.sb-session-row:focus-within:has(.session-acts button) .row-meta,\n.sb-session-row:has(.row-session[aria-current="true"]):has(.session-acts button) .row-meta',
      ),
    ).toMatch(/visibility:\s*hidden/);
  });

  // Review Runde 1, Befund 1 (wichtig): lange Sessionnamen liefen unter den
  // durchsichtigen Aktionsknoepfen durch, weil `.session-acts` absolut gesetzt
  // ist und `.row-label` dadurch keine Breite abzieht -- die Ellipse wurde nur
  // gegen `.row-meta` berechnet. Das Zustandswort-Feld reserviert hier die
  // Breite der zwei 26-px-Knoepfe, die Ellipse des Namens endet davor.
  it("Zustandswort-Feld der Sessionzeile reserviert die Breite der Aktionsknoepfe", () => {
    const meta = ruleBody(".sb-session-row .row-meta");
    expect(meta).toMatch(/min-width:\s*calc\(2 \* var\(--ab-row-h-session\) \+ 2px\)/);
    expect(meta).toMatch(/justify-content:\s*flex-end/);
  });

  it("Statuspille (M1.2): 18 px hoch, Pillenradius, Stufe 11/14 halbfett", () => {
    const pill = ruleBody(".st");
    expect(pill).toMatch(/height:\s*18px/);
    expect(pill).toMatch(/border-radius:\s*var\(--ab-radius-pill\)/);
    expect(pill).toMatch(/font-size:\s*var\(--ab-fs-xs\)/);
    expect(pill).toMatch(/font-weight:\s*var\(--ab-fw-semibold\)/);
  });

  it("Fokusring innen an Host- und Sessionzeile (Spec 6.9)", () => {
    expect(ruleBody(".row-host:focus-visible,\n.row-session:focus-visible")).toMatch(/outline-offset:\s*-2px/);
  });
  it("Wartet-Spur (Spec 2026-10-19 §7): Zeile 38 px, Kopf und \"+n more\" so hoch wie eine Sessionzeile, Fokusring innen", () => {
    expect(tokenBlock(":root")["--ab-row-h-lane"]).toBe("38px");
    expect(ruleBody(".row-lane")).toMatch(/height:\s*var\(--ab-row-h-lane\)/);
    expect(ruleBody(".sb-lane-head")).toMatch(/height:\s*var\(--ab-row-h-session\)/);
    expect(ruleBody(".row-lane-more")).toMatch(/height:\s*var\(--ab-row-h-session\)/);
    expect(ruleBody(".row-lane:focus-visible,\n.row-lane-more:focus-visible")).toMatch(/outline-offset:\s*-2px/);
  });
  it("Wartet-Spur: ihre Trennlinie liegt einen Hostkarten-Abstand ueber der ersten Karte, nicht auf deren Kante", () => {
    const cardGap = ruleBody(".sb-host-block").match(/margin:\s*0 0 (var\(--ab-space-\d+\));/)?.[1];
    const laneGap = ruleBody(".sb-lane").match(/margin-bottom:\s*(var\(--ab-space-\d+\));/)?.[1];
    expect(cardGap).toBeDefined();
    expect(laneGap).toBe(cardGap);
  });
  it("Titel, Wartezeit, Grund und \"+n more\" der Wartet-Spur tragen die Kleinschrift (Spec 6.1)", () => {
    const small = [...code.matchAll(/([^{}]+)\{\s*font-family:\s*var\(--ab-font-ui-small\);\s*\}/g)].flatMap((rule) =>
      splitSelectors(rule[1]),
    );
    expect(small).toEqual(
      expect.arrayContaining([".sb-lane-title", ".row-lane-time", ".row-lane-reason", ".row-lane-more"]),
    );
  });
  it("Feldbeschriftung in der Hinweisleiste ist sekundaer, nicht gedaempft (Kontrast auf danger-bg)", () => {
    expect(ruleBody(".host-notice label,\n.host-notice .credential-field")).toMatch(/color:\s*var\(--ab-text-secondary\)/);
  });
  it("Scrollbalken 8 px mit Token-Daumen an Liste, Dialogkoerper, Baum, Einstellungspanel und Erststart", () => {
    expect(
      ruleBody(".sb-list::-webkit-scrollbar, .dialog-body::-webkit-scrollbar, .dir-tree-rows::-webkit-scrollbar, .settings-panel::-webkit-scrollbar,\n.first-run-view::-webkit-scrollbar"),
    ).toMatch(/width:\s*8px/);
    expect(
      ruleBody(".sb-list::-webkit-scrollbar-thumb, .dialog-body::-webkit-scrollbar-thumb, .dir-tree-rows::-webkit-scrollbar-thumb, .settings-panel::-webkit-scrollbar-thumb,\n.first-run-view::-webkit-scrollbar-thumb"),
    ).toMatch(/background-color:\s*var\(--ab-scrollbar\)/);
  });
  it("#app und .sidebar rechnen ihr Polster in die Kastengroesse ein (ohne globalen Reset in dieser Datei)", () => {
    // #app: 100vh + 8px Rand-Polster (content-box) sprengte die Ansicht um
    // 16px; .sidebar: height 100% + Polster/Rahmen (content-box) sprengte
    // die Kartenhoehe um 10px und schnitt Fuss/Schatten am #sidebar-
    // Elternteil ab. Diese Datei hat keinen globalen `box-sizing`-Reset,
    // darum je Regel explizit.
    expect(ruleBody("#app")).toMatch(/box-sizing:\s*border-box/);
    expect(ruleBody(".sidebar")).toMatch(/box-sizing:\s*border-box/);
  });
  it("#sidebar beschneidet den Kartenschatten nicht mehr (min-width haelt die Grid-Spalte, kein overflow: hidden)", () => {
    expect(ruleBody("#sidebar")).toMatch(/min-width:\s*0/);
    expect(ruleBody("#sidebar")).not.toMatch(/overflow:/);
  });
  // Aufgabe 19, Fixrunde 3 (A): ohne `min-height: 0` wuchs die Zeile von
  // `#app` mit dem Inhalt der Liste, `#app { overflow: hidden }` schnitt den
  // Rest ab, und `.sb-list` rollte nie. Die Kette darunter ist schon richtig:
  // `.sidebar` nimmt die volle Hoehe, `.sb-list` fuellt den Rest und rollt.
  it("#sidebar haelt die Zeile von #app: min-height 0, damit die Liste rollt", () => {
    expect(ruleBody("#sidebar")).toMatch(/min-height:\s*0;/);
    expect(ruleBody("#app")).toMatch(/height:\s*100vh;/);
    expect(ruleBody(".sidebar")).toMatch(/height:\s*100%;/);
    expect(ruleBody(".sidebar")).toMatch(/display:\s*flex;/);
    expect(ruleBody(".sidebar")).toMatch(/flex-direction:\s*column;/);
    expect(ruleBody(".sb-list")).toMatch(/flex:\s*1;/);
    expect(ruleBody(".sb-list")).toMatch(/overflow-y:\s*auto;/);
  });
});

describe("Ziehgriff und Breite der Seitenleiste (UX-Spec §7.8)", () => {
  it("die Spalte liest das Token --ab-sidebar-w; seine Vorgabe ist die des Griffs", () => {
    expect(tokenBlock(":root")["--ab-sidebar-w"]).toBe(`${SIDEBAR_WIDTH_DEFAULT}px`);
    expect(ruleBody("#app")).toMatch(/grid-template-columns:\s*var\(--ab-sidebar-w\) 1fr;/);
    // Kein zweites Token daneben (Aufgabe 19).
    expect(code).not.toMatch(/--ab-sidebar-width/);
  });
  it("Griff: 6 px am rechten Rand von #sidebar, col-resize, ohne Bildlauf bei Beruehrung", () => {
    const handle = ruleBody(".sb-resize");
    expect(handle).toMatch(/position:\s*absolute;/);
    expect(handle).toMatch(/left:\s*100%;/);
    // Er fuellt genau den Spalt zwischen Leiste und Raster; der ist die 6 px
    // breite Leinwandluecke (Fixrunde 1, I).
    expect(handle).toMatch(/width:\s*var\(--ab-canvas-gap\);/);
    expect(tokenBlock(":root")["--ab-canvas-gap"]).toBe("6px");
    expect(handle).toMatch(/cursor:\s*col-resize;/);
    expect(handle).toMatch(/touch-action:\s*none;/);
    expect(ruleBody("#sidebar")).toMatch(/position:\s*relative;/);
  });
  it("eingeklappt verschwindet der Griff mit #sidebar", () => {
    expect(ruleBody("#app.sidebar-collapsed #sidebar")).toMatch(/display:\s*none;/);
  });
  it("eingeklappt bekommt #grid die ganze Breite (Spec 2026-10-19 §8.5)", () => {
    // Mit `0 1fr` landete #grid als einziges Rasterelement per
    // Auto-Platzierung in der 0-px-Spur, FitAddon klemmte auf 2 Spalten.
    const rule = ruleBody("#app.sidebar-collapsed");
    expect(rule).toMatch(/grid-template-columns:\s*1fr;/);
    expect(rule).not.toMatch(/grid-template-columns:\s*0\s+1fr/);
  });
  it("Reload sessions ist ein quadratischer Zeilenknopf der Leiste", () => {
    const button = ruleBody(".host-icon-btn");
    expect(button).toMatch(/width:\s*var\(--ab-row-btn-h\);/);
    expect(button).toMatch(/padding:\s*0;/);
  });
  // Fixrunde 3 (C): `.host-action-btn:hover` (0,2,0) schlug `button:disabled`
  // (0,1,1) -- ein deaktiviertes "New session" oder "Reload sessions" hellte
  // beim Zeigen auf und bekam die Hover-Flaeche.
  it("ein deaktivierter Knopf der Hostleiste reagiert nicht auf Hover", () => {
    const hover = ruleBody(".host-action-btn:not(:disabled):hover");
    expect(hover).toMatch(/background-color:\s*var\(--ab-bg-hover\);/);
    expect(hover).toMatch(/color:\s*var\(--ab-text-primary\);/);
    expect(code).not.toMatch(/\.host-action-btn:(hover|active)\b/);
  });
});

describe("Werkzeugleiste, Kacheln, Knopfsystem -- Nachbesserung Runde 1 (Spec 8, 10, 11)", () => {
  it("feste Boxen mit moeglichem Rahmen rechnen ihn in die Kastengroesse ein (border-box), sonst rendern sie zu hoch/breit", () => {
    // Ohne border-box rendert z. B. .btn 34px statt 32px (Rahmen 1px x2).
    // `.tile-btn` und die Sperrleistenknoepfe (`.tile-lock-reconnect`,
    // `.tile-lock-close`) tragen seit Aufgabe 17 additiv `.btn`/`.btn--*`
    // und beziehen `box-sizing` von dort -- eigene Pins braeuchten sie nur,
    // wenn sie ohne die Knopfklassen auskaemen.
    for (const s of [".btn", ".tile-lock", ".badge", ".tile-number", "kbd", ".tile"]) {
      expect(ruleBody(s)).toMatch(/box-sizing:\s*border-box/);
    }
  });

  it("Nummernchip bleibt auf gesperrtem, unfokussiertem Kopf sekundaer statt gedaempft (Spec 5.4)", () => {
    expect(ruleBody(".tile.locked .badge")).toMatch(/color:\s*var\(--ab-text-secondary\)/);
  });

  it("die Kachelnummer in Liste und Spur ist 14 px und fokussiert gefuellt wie das Abzeichen im Kachelkopf (Spec 2026-10-19 §7)", () => {
    const plain = ruleBody(".tile-number");
    expect(plain).toMatch(/width:\s*14px;/);
    expect(plain).toMatch(/height:\s*14px;/);
    const focused = ruleBody(".tile-number--focused");
    expect(focused).toMatch(/background-color:\s*var\(--ab-accent\);/);
    expect(focused).toMatch(/color:\s*var\(--ab-accent-ink\);/);
  });

  it("deaktivierte Sekundaer- und Gefahrknoepfe bleiben als deaktiviert erkennbar (Rahmenfarbe UND Text gedaempft)", () => {
    const disabled = ruleBody(".btn:disabled");
    expect(disabled).toMatch(/color:\s*var\(--ab-text-disabled\)/);
    expect(disabled).not.toMatch(/opacity:/); // kein No-op mehr, button:disabled daempft ohnehin keine Deckkraft
    expect(ruleBody(".btn--secondary:disabled,\n.btn--danger:disabled")).toMatch(
      /border-color:\s*var\(--ab-line\)/,
    );
  });

  it("#grid und .tile-grid-view beschneiden den Kartenschatten und die Fokuskontur nicht mehr", () => {
    for (const s of ["#grid", ".tile-grid-view"]) {
      expect(ruleBody(s)).not.toMatch(/overflow:/);
      expect(ruleBody(s)).toMatch(/min-height:\s*0/);
    }
  });

  it("Fokuskontur der Kachel ist immer da (transparent im Ruhezustand), sonst kann outline-color nicht animieren", () => {
    expect(ruleBody(".tile")).toMatch(/outline:\s*2px solid transparent/);
    expect(ruleBody(".tile")).toMatch(/outline-offset:\s*-2px/);
    const focused = ruleBody(".tile.focused");
    expect(focused).toMatch(/outline-color:\s*var\(--ab-accent\)/);
    expect(focused).not.toMatch(/outline-offset/); // steht schon an .tile, nicht doppelt noetig
  });

  it("Kacheln liegen absolut im Raster, das ihr Bezugsrahmen ist (Spec 2026-10-19 §4.3)", () => {
    expect(ruleBody(".grid")).toMatch(/position:\s*relative/);
    expect(ruleBody(".grid")).not.toMatch(/display:\s*grid/);
    expect(ruleBody(".tile")).toMatch(/position:\s*absolute/);
    expect(code).not.toMatch(/\.toolbar|\.seg\b|\.tile-empty/);
  });
});

// Abnahme B4: bei 200 px Breite und sichtbarer Statuspille brauchte der Kopf
// 261 px, und Maximieren und Schliessen lagen ueber der Nachbarkachel. Die
// Reihenfolge des Nachgebens: zuerst Titel und Host, zuletzt die Chips (mit
// Ellipse); Abzeichen und Knoepfe nie. Das Layout selbst prueft erst das
// Fenster -- jsdom rechnet keine Boxen.
describe("Kachelkopf in schmalen Kacheln (Abnahme B4)", () => {
  // Grundmass 0: Titel und Host bekommen nur den Platz, der neben allem
  // anderen frei bleibt, hoechstens ihren Inhalt -- sie nehmen der Knopfgruppe
  // nichts weg, solange ihnen selbst noch etwas bleibt.
  it("Titel und Host wachsen aus 0 bis zu ihrem Inhalt und geben zuerst nach", () => {
    for (const selector of [".tile-title", ".tile-host"]) {
      const body = ruleBody(selector);
      expect(body, selector).toMatch(/flex:\s*1 1 0;/);
      expect(body, selector).toMatch(/max-width:\s*max-content;/);
      expect(body, selector).toMatch(/min-width:\s*0;/);
    }
  });

  it("die Knopfgruppe schrumpft erst danach; Abzeichen und Kopfknoepfe behalten ihre Groesse", () => {
    const acts = ruleBody(".tile-acts");
    expect(acts).toMatch(/flex:\s*0 1 auto;/);
    expect(acts).toMatch(/min-width:\s*0;/);
    expect(acts).not.toMatch(/flex:\s*none/);
    expect(ruleBody(".badge")).toMatch(/flex:\s*none;/);
    expect(ruleBody(".tile-btn")).toMatch(/flex:\s*none;/);
  });

  it("die Kopfchips duerfen schrumpfen, ihr Text kuerzt mit Ellipse", () => {
    for (const selector of [".tile-narrow", ".tile-lock-chip", ".tile-quiet", ".tile-copied"]) {
      expect(ruleBody(selector), selector).toMatch(/min-width:\s*0;/);
    }
    const text = ruleBody(".tile-chip-text");
    expect(text).toMatch(/min-width:\s*0;/);
    expect(text).toMatch(/overflow-x:\s*clip;/);
    expect(text).toMatch(/overflow-y:\s*visible;/);
    expect(text).toMatch(/text-overflow:\s*ellipsis;/);
    expect(text).toMatch(/white-space:\s*nowrap;/);
  });

  // Das letzte Netz sitzt am Kopf, nicht an der Kachel: deren Beschnitt
  // rundete die Ecken des Terminals ab. Die Kopfknoepfe tragen ihren
  // Fokusring innen, der Beschnitt erreicht ihn nicht.
  it("der Kopf schneidet als letztes Netz ab, die Kachel nicht", () => {
    expect(ruleBody(".tile-head")).toMatch(/overflow:\s*clip;/);
    expect(ruleBody(".tile-head :where(button):focus-visible")).toMatch(/outline-offset:\s*-2px;/);
    expect(ruleBody(".tile")).not.toMatch(/overflow/);
  });
});

// Abnahme B5: in einer 420 px breiten Kachel brach die Meldung der
// Sperrleiste auf vier Zeilen um (56 px in 32 px), lag ueber dem Kopf und
// wurde vom Terminal abgeschnitten.
describe("Sperrleiste in schmalen Kacheln (Abnahme B5)", () => {
  it("die Leiste bleibt 32 px hoch und schneidet nur waagerecht ab; ihre Knoepfe behalten die Groesse", () => {
    const strip = ruleBody(".tile-lock");
    expect(strip).toMatch(/height:\s*32px;/);
    expect(strip).toMatch(/overflow-x:\s*clip;/);
    // Senkrecht nicht: der Fokusring der Knoepfe ragt 4 px nach aussen, und
    // ueber und unter dem 26-px-Knopf bleiben nur 2,5 px.
    expect(strip).not.toMatch(/overflow(-y)?:\s*(clip|hidden)/);
    expect(ruleBody(".tile-lock-reconnect,\n.tile-lock-close")).toMatch(/flex:\s*none;/);
  });

  it("die Meldung bleibt auf einer Zeile und gibt zuerst nach, mit Ellipse", () => {
    const message = ruleBody(".tile-lock-message");
    expect(message).toMatch(/min-width:\s*0;/);
    expect(message).toMatch(/overflow-x:\s*clip;/);
    expect(message).toMatch(/overflow-y:\s*visible;/);
    expect(message).toMatch(/text-overflow:\s*ellipsis;/);
    expect(message).toMatch(/white-space:\s*nowrap;/);
  });
});

describe("Aliase entfernt (Spec 5.6, Anhang A Schritt 9)", () => {
  const V1 = [
    "--ab-bg-chrome", "--ab-bg-raised", "--ab-bg-overlay", "--ab-border-subtle", "--ab-border-default",
    "--ab-border-strong", "--ab-accent-quiet", "--ab-neutral-off", "--ab-warn-border", "--ab-danger-border",
    "--ab-radius-tile", "--ab-tile-focus-w", "--ab-sidebar-min-w", "--ab-sidebar-max-w",
  ];
  for (const name of V1) {
    it(`${name} kommt nicht mehr vor`, () => {
      expect(code.includes(name)).toBe(false);
    });
  }
});

describe("Dialoge, Felder, Knoepfe (Spec 11)", () => {
  it("Huelle: Panel 480/520/440, Kopf 44 px, kein .primary mehr", () => {
    expect(ruleBody(".dialog-panel")).toMatch(/width:\s*min\(480px/);
    expect(ruleBody(".dialog-panel--wide")).toMatch(/width:\s*min\(520px/);
    expect(ruleBody(".host-key-prompt")).toMatch(/width:\s*min\(440px/);
    expect(ruleBody(".dialog-head")).toMatch(/height:\s*var\(--ab-dialog-head-h\)/);
    expect(code).not.toMatch(/\n\.primary\s*\{/);
  });
  it("Felder: 32 px, Radius 7, Canvas-Flaeche", () => {
    const field = ruleBody('input:not([type="checkbox"]):not([type="radio"]), select');
    expect(field).toMatch(/height:\s*var\(--ab-control-h\)/);
    expect(field).toMatch(/border-radius:\s*var\(--ab-radius-sm\)/);
    expect(field).toMatch(/background-color:\s*var\(--ab-bg-canvas\)/);
  });
  // B10 (Aufgabe 17): `.host-form-actions` (Aufgabe 14, Hostformular) hing
  // bisher an keinem Test -- die rechtsbuendige Aktionenzeile teilt sich die
  // Regel mit den beiden Dialogvarianten.
  it("Aktionenzeilen (Hostformular, Schluesselabfrage, Sessiondialog) sind rechtsbuendig", () => {
    expect(ruleBody(".host-key-prompt-actions,\n.session-dialog-actions,\n.host-form-actions")).toMatch(
      /justify-content:\s*flex-end/,
    );
  });
});

describe("Einstellungen (Einstellungs-Spec §2, §6.3)", () => {
  it("grosse Huelle: 760 breit, 540 fest hoch, Koerper ohne Polster und ohne eigenes Scrollen", () => {
    expect(ruleBody(".dialog-panel--large")).toMatch(/width:\s*min\(760px/);
    expect(ruleBody(".dialog-panel--large")).toMatch(/height:\s*min\(540px/);
    const body = ruleBody(".dialog-panel--large .dialog-body");
    expect(body).toMatch(/padding:\s*0;/);
    expect(body).toMatch(/overflow:\s*hidden;/);
  });
  it("Navigation 200 px; gewaehlter Tab wie die gewaehlte Session; Fokusring innen", () => {
    expect(ruleBody(".settings-view")).toMatch(/grid-template-columns:\s*200px minmax\(0, 1fr\)/);
    expect(ruleBody(".settings-view")).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
    expect(ruleBody(".settings-tab")).toMatch(/height:\s*var\(--ab-control-h\)/);
    const chosen = ruleBody('.settings-tab[aria-selected="true"]');
    expect(chosen).toMatch(/background-color:\s*var\(--ab-accent-soft\)/);
    expect(chosen).toMatch(/color:\s*var\(--ab-text-primary\)/);
    expect(ruleBody(".settings-tab:focus-visible,\n.settings-panel:focus-visible")).toMatch(/outline-offset:\s*-2px/);
  });
  it("Panel auf Canvas und scrollbar; Karten auf Kartenflaeche", () => {
    const panel = ruleBody(".settings-panel");
    expect(panel).toMatch(/background-color:\s*var\(--ab-bg-canvas\)/);
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(ruleBody(".settings-card")).toMatch(/background-color:\s*var\(--ab-bg-card\)/);
    expect(ruleBody(".settings-card")).toMatch(/border-radius:\s*var\(--ab-radius-lg\)/);
  });
  it("Tastenchip in den Einstellungen: 20 px, heller Grund, Unterkante 2 px", () => {
    const chip = ruleBody(".settings-keys kbd");
    expect(chip).toMatch(/height:\s*20px/);
    expect(chip).toMatch(/min-width:\s*20px/);
    expect(chip).toMatch(/background-color:\s*var\(--ab-bg-hover\)/);
    expect(chip).toMatch(/border-bottom-width:\s*2px/);
  });
});

describe("Einstellungen mit Bedienelementen (UX-Spec §9.1)", () => {
  it("Schalter: Pille auf der Hover-Flaeche, an im Akzent mit Tinte; der Knopf springt ohne Uebergang", () => {
    const off = ruleBody(".ab-switch");
    expect(off).toMatch(/border-radius:\s*var\(--ab-radius-pill\)/);
    expect(off).toMatch(/background-color:\s*var\(--ab-bg-hover\)/);
    expect(ruleBody(".ab-switch-thumb")).toMatch(/background-color:\s*var\(--ab-text-muted\)/);
    // Nur Farbe wechselt weich; die Lage des Knopfs aendert sich ohne Bewegung.
    expect(ruleBody(".ab-switch-thumb")).toMatch(/transition:\s*background-color /);
    expect(ruleBody('.ab-switch[aria-checked="true"]')).toMatch(/background-color:\s*var\(--ab-accent\)/);
    expect(ruleBody('.ab-switch[aria-checked="true"] .ab-switch-thumb')).toMatch(
      /background-color:\s*var\(--ab-accent-ink\)/,
    );
  });
  it("Segmentwahl: gewaehlt im Akzent mit Tinte und halbfett, der Fokusring sitzt am Segment", () => {
    const chosen = ruleBody(".settings-seg-option:has(input:checked)");
    expect(chosen).toMatch(/background-color:\s*var\(--ab-accent\)/);
    expect(chosen).toMatch(/color:\s*var\(--ab-accent-ink\)/);
    expect(chosen).toMatch(/font-weight:\s*var\(--ab-fw-semibold\)/);
    expect(ruleBody(".settings-seg-option:has(input:focus-visible)")).toMatch(/outline:\s*var\(--ab-focus-w\)/);
  });
  it("Beschriftungen ersetzen die globale label-Regel: 13 px in Sekundaerfarbe", () => {
    const label = ruleBody(".settings-label");
    expect(label).toMatch(/display:\s*block/);
    expect(label).toMatch(/font-size:\s*var\(--ab-fs-md\)/);
    expect(label).toMatch(/color:\s*var\(--ab-text-secondary\)/);
  });
  it("der Pfad der Einstellungsdatei ist markierbar und bricht um", () => {
    const path = ruleBody(".settings-value--path");
    expect(path).toMatch(/user-select:\s*text/);
    expect(path).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe("Kompakte Hinweise und ruhige Zeile (UX-Spec §5.7)", () => {
  it("die Meldung steht auf hoechstens zwei Zeilen, aufgeklappt ganz", () => {
    const message = ruleBody(".host-notice-message");
    expect(message).toMatch(/display:\s*-webkit-box;/);
    expect(message).toMatch(/-webkit-box-orient:\s*vertical;/);
    expect(message).toMatch(/-webkit-line-clamp:\s*2;/);
    expect(message).toMatch(/\bline-clamp:\s*2;/);
    expect(message).toMatch(/overflow:\s*hidden;/);
    const expanded = ruleBody(".host-notice--expanded .host-notice-message");
    expect(expanded).toMatch(/-webkit-line-clamp:\s*none;/);
    expect(expanded).toMatch(/overflow:\s*visible;/);
  });
  it("die Knopfzeile eines Hinweises bricht um, statt die schmale Leiste zu sprengen", () => {
    const acts = ruleBody(".host-notice .acts");
    expect(acts).toMatch(/flex-wrap:\s*wrap;/);
    // Zeilen- und Spaltenabstand: umgebrochene Knoepfe kleben nicht aneinander.
    expect(acts).toMatch(/\bgap:\s*var\(--ab-space-2\)\s+var\(--ab-space-4\);/);
  });
  it("die ruhige Zeile ist gedaempfter Text ohne Rahmen und Flaeche", () => {
    const quiet = ruleBody(".control-quiet");
    expect(quiet).toMatch(/color:\s*var\(--ab-text-muted\);/);
    expect(quiet).not.toMatch(/border|background/);
  });

  it("die Zeile des Neuverbindens und der Hinweis in der Kachel tragen dieselbe Form (§5.4, §5.5)", () => {
    // Die Zeile der Seitenleiste teilt sich die Regel mit der Selbstreparatur.
    expect(css).toMatch(/\n\.host-quiet,\n\.control-quiet \{/);
    const tile = ruleBody(".tile-quiet");
    expect(tile).toMatch(/color:\s*var\(--ab-text-muted\);/);
    expect(tile).not.toMatch(/border|background/);
  });
});

/** Inhalt eines `@media`-Blocks samt verschachtelter Regeln (ohne die
 * aeusseren Klammern), aus der kommentarfreien Fassung. */
function mediaBlock(query: string): string {
  const head = `@media ${query} {`;
  const start = code.indexOf(head);
  if (start < 0) throw new Error(`Block ${head} fehlt`);
  let depth = 1;
  let i = start + head.length;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
  }
  return code.slice(start + head.length, i - 1);
}

/** Die Deklarationen der Regel `selector` innerhalb eines Blocks. */
function blockRule(block: string, selector: string): string {
  const start = block.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Regel ${selector} fehlt im Block`);
  return block.slice(start, block.indexOf("}", start));
}

describe("Barrierefreiheit und Optik (UX-Spec §11)", () => {
  it("die toten Token und `.ab-seg-item` sind fort", () => {
    for (const name of ["--ab-space-0", "--ab-space-9", "--ab-space-10", "--ab-term-font-size", "--ab-term-line-height"]) {
      expect(code.includes(name), name).toBe(false);
    }
    expect(code.includes(".ab-seg-item")).toBe(false);
  });

  it("die globale Fokusregel erbt keinen Radius mehr", () => {
    const focus = ruleBody(":where(button, a, input, select, [tabindex], .ab-row):focus-visible");
    expect(focus).toMatch(/outline:\s*var\(--ab-focus-w\) solid var\(--ab-focus-ring\);/);
    expect(focus).not.toMatch(/border-radius/);
  });

  it("die Grundtonkarte zeichnet die Auswahl als box-shadow, der Fokusring bleibt die outline", () => {
    const chosen = ruleBody(".base-card:has(input:checked)");
    expect(chosen).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--ab-accent\);/);
    expect(chosen).toMatch(/border-color:\s*var\(--ab-accent\);/);
    expect(chosen).not.toMatch(/outline/);
    expect(ruleBody(".base-card:has(input:focus-visible)")).toMatch(/outline:\s*var\(--ab-focus-w\)/);
  });

  it("der Erststart zentriert mit safe center, damit Ueberlauf oben erreichbar bleibt", () => {
    expect(ruleBody(".first-run-view")).toMatch(/justify-content:\s*safe center;/);
  });

  // UX-Spec §8.5: kein weisser Blitz beim Start. Das Fenster setzt
  // `backgroundColor` (tauri.conf.json), index.html `color-scheme: dark`, und
  // `html` (= `:root`) traegt die Flaeche -- ueber das Token, dessen
  // Graphitwert genau der Startwert ist.
  it("html traegt die Startflaeche #15171C ueber das Token", () => {
    expect(ruleBody(":root")).toMatch(/background-color:\s*var\(--ab-bg-canvas\);/);
    expect(baseBlock("graphite")["--ab-bg-canvas"]).toBe("#15171C");
  });

  it("markieren laesst sich nur Text, der etwas bedeutet", () => {
    expect(ruleBody("html,\nbody")).toMatch(/user-select:\s*none;/);
    // `.host-form-hint` nennt den Schluesselordner `%USERPROFILE%\.ssh` -- ein Pfad.
    const text = ruleBody(
      'input,\ntextarea,\n.tile-terminal,\n[role="alert"],\n.host-notice-message,\n.host-notice-detail,\n.first-run-followup-message,\n.host-key-prompt-fingerprint-value,\n.dir-tree-notice,\n.host-form-hint',
    );
    expect(text).toMatch(/user-select:\s*text;/);
    // Der Pfad der Einstellungsdatei hat seine eigene Regel (UX-Spec §9.1).
    expect(ruleBody(".settings-value--path")).toMatch(/user-select:\s*text;/);
  });

  it("ein Feld mit aria-invalid zeigt den Gefahrrand, auch gegen die Feldregel", () => {
    const invalid = ruleBody(
      'input[aria-invalid="true"]:not([type="checkbox"]):not([type="radio"]),\nselect[aria-invalid="true"]',
    );
    expect(invalid).toMatch(/border-color:\s*var\(--ab-danger\);/);
  });

  describe("Kontrastmodus", () => {
    // Erst im Test gelesen: fehlt der Block, scheitert der Test, nicht das Laden.
    const block = () => mediaBlock("(forced-colors: active)");

    it("es gibt genau einen forced-colors-Block", () => {
      expect(code.split("@media (forced-colors: active)").length - 1).toBe(1);
    });

    // Der Browser zeichnet auch den Fokusring hier in Highlight und durchgezogen.
    // Fokus und Auswahl koennen auf verschiedenen Zeilen stehen (Zeiger der
    // Liste gegen `aria-current`); die Auswahl ist deshalb gestrichelt.
    it("Auswahl von Tab, Session, Schnelloeffnen-Zeile und Grundtonkarte als gestrichelte outline in Highlight", () => {
      const chosen = blockRule(
        block(),
        ':where(.settings-tab[aria-selected="true"], .row-session[aria-current="true"], .quick-open-option[aria-selected="true"], .base-card:has(input:checked))',
      );
      expect(chosen).toMatch(/outline:\s*var\(--ab-focus-w\) dashed Highlight;/);
      expect(chosen).toMatch(/outline-offset:\s*-2px;/);
    });

    it("Farbfelder behalten ihre Farbe, die Auswahl am Akzentfeld ist gestrichelt in Highlight", () => {
      expect(blockRule(block(), ".accent-dot,\n  .base-swatch")).toMatch(/forced-color-adjust:\s*none;/);
      const dot = blockRule(block(), ".accent-option:has(input:checked) .accent-dot");
      expect(dot).toMatch(/outline-color:\s*Highlight;/);
      expect(dot).toMatch(/outline-style:\s*dashed;/);
    });

    it("die Linie des Ziehgriffs bleibt sichtbar", () => {
      expect(blockRule(block(), ".sb-resize:hover,\n  .sb-resize--dragging")).toMatch(/background-color:\s*Highlight;/);
    });

    it("Systemfarben nur in diesem Block", () => {
      const outside = code.replace(block(), "");
      expect(outside).not.toMatch(/\b(Highlight|HighlightText|CanvasText|Canvas|ButtonText|ButtonFace|ButtonBorder|GrayText|LinkText|FieldText|SelectedItem|SelectedItemText|AccentColor|AccentColorText)\b/);
    });
  });
});
