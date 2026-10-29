# AgentBridge — Designsystem v1

Stand: 2026-07-27 · Zielplattform: Windows 11, Tauri 2 + WebView2 (Chromium), xterm.js 6
Bezug: Spec §7 (Interaktion), §7.7 (Sprache und Bedienbarkeit), §9.1, §6.4/V12

**Entscheidung in einem Satz:** Richtung **A ("Werkstatt"), gehärtet** — als einzige der drei
stellt sie den Terminalinhalt an die Spitze der visuellen Hierarchie, und das ist bei einem
Werkzeug, das stundenlang vier fremdgerenderte Rechtecke rahmt, nicht Geschmack, sondern die
Funktion.

---

## Teil 1 — Kritik der drei Entwürfe

Vorbemerkung: Die Mockups sind 320 px hoch und 176 px Sidebar. Bei 1600×1000 ist die Grid-Fläche
das **Neunfache** dieser Fläche. Alles, was in einem Briefmarkenbild als „dezent" durchgeht,
wird dort entweder unsichtbar (Signale) oder unerträglich (Dekoration). Kein einziger px-Wert
aus jener CSS darf in die Implementierung übernommen werden — die Typoskala dort liegt bei
9,5–11 px, das sind Screenshot-Dekorationen.

### Gemeinsamer Fehler aller drei: der Punkt im Kachelkopf

`.ab-dot` trägt in allen drei Varianten **ausschließlich Farbe**. In der Sidebar steht daneben
noch `verbunden` / `getrennt` — dort ist Constraint 3 knapp erfüllt. Im Kachelkopf steht neben
dem Punkt nur `s2 · codex`, kein Zustandswort und keine Formunterscheidung: blau gefüllt vs.
grau gefüllt, identische Geometrie. Das ist der saubere, unstrittige Verstoß gegen Constraint 3,
und er sitzt ausgerechnet an der Stelle, die bei vier laufenden Terminals am häufigsten
abgelesen wird.

### A — „Werkstatt"

**Richtig:** Terminal (`#0d0f12`) ist dunkler als die Chrome (`#131619`). Der Blick fällt auf
den Inhalt. Hairlines statt Gaps. Ein einziger Akzent. Trägt Dichte: 20 Sessions in der Sidebar
bleiben lesbar, weil keine Zeile ein eigenes Kärtchen ist.

**Was bei 1600×1000 bricht — genau eine Sache, aber eine wichtige:**
Das Aktiv-Signal ist `box-shadow: inset 0 -1px 0 #4a9eff` unter dem Kachelkopf. Bei 320 px liegt
diese Linie 4 cm vom Auge des Betrachters entfernt in einem Bild, das man ohnehin am Stück
erfasst. Bei 1600×1000 in einem 2×2-Raster liegt sie bis zu **700 px** von der Stelle entfernt,
an der der Nutzer gerade liest — eine 1-px-Linie in einem 6:1-Kontrast, peripher schlicht nicht
wahrnehmbar. Dazu ist sie farbcodiert und sonst nichts. Bei einer App, deren Kernfrage „wo
landen meine Tastendrücke gerade?" ist, ist das die teuerste denkbare Schwäche. Sie ist
reparierbar (Teil 2 §6) und der einzige echte Einwand gegen A.

Zweiter, kleinerer Punkt: `.ab-sess` hat `margin-left: 15px` plus `padding-left: 9px` plus eine
`border-left`-Schiene. Bei drei Hosts ist das eine schöne Führungslinie; bei 20 Sessions unter
einem Host wird die Schiene zur dominanten Vertikalen und die Sidebar sieht aus wie ein
Baumdiagramm ohne Baum. Braucht Sticky-Host-Header, sonst weiß man beim Scrollen nicht mehr,
wessen Sessions man sieht.

### B — „Studio"

**Falsch für diese App.** Nicht knapp falsch, sondern in vier unabhängigen Punkten:

1. `backdrop-filter: blur(14px)` auf der Sidebar. Darunter liegt eine opake Tauri-Fensterfläche
   und daneben liegen bis zu vier **WebGL-Canvases** (`WebglAddon`, `src/terminal.ts`). Der
   Blur erzeugt bei jedem Frame Compositing-Arbeit für exakt null Information — es ist nichts
   Interessantes hinter der Sidebar. Bei einem Agenten, der eine Minute lang Build-Output
   scrollt, zahlt man das durchgehend.
2. `border-radius: 11px` auf einer Kachel, die xterm enthält. Das erzwingt `overflow: hidden`
   auf dem Container, und xterm rendert ein starres Zellraster bis an den Rand: die Ecken
   **beschneiden Glyphenzellen**. Ein `┌` einer Box-Drawing-Ausgabe wird angeschnitten. Bei
   einer App, die Terminal-Treue (Spec A1) als Kernversprechen führt, ist das kein Detail.
3. `box-shadow: 0 8px 26px rgba(0,0,0,.5)` auf der aktiven Kachel. Der Schatten fällt bei
   9 px Gap **auf den Inhalt des Nachbarterminals**. Man verdunkelt fremden Text, um einen
   Rahmen hervorzuheben.
4. `.ab-grid { gap: 9px; padding: 0 9px 9px }` plus 1-px-Border kostet bei 1600 px pro Kachel
   rund **3 Spalten** (85 statt 88, Rechnung in Teil 2 §5). Das ist für sich klein — aber es
   ist reiner Verlust, eingetauscht gegen Weichzeichnung.

Dazu: Violett `#8b5cf6` als Akzent kollidiert mit ANSI-Magenta/BrightMagenta, das Agenten-CLIs
für Hervorhebungen benutzen. Ein App-Signal, das aussieht wie Terminalinhalt, ist kein Signal.
Und die Chrome zieht mehr Aufmerksamkeit als der Inhalt — das Gegenteil der Anforderung.

### C — Windows-nativ (Fluent)

**Falsch, und zwar aus einem Grund, den das Mockup selbst nur zur Hälfte zeigt.**

`#f3f3f3` Chrome um `#1f1f1f` Viewports. Bei 320 px ist etwa 40 % des Bildes dunkel. Bei
1600×1000 im 2×2 ist es ein **heller Rahmen um vier dunkle Brunnen** — der Luminanzsprung an
jeder Kachelkante liegt bei rund 15:1. Nach zwei Stunden ist das kein Stilproblem mehr, sondern
Adaptationsarbeit für das Auge bei jedem Sakkadensprung zwischen zwei Kacheln. Es invertiert
exakt die Hierarchie, die dieses Werkzeug braucht.

Weiter: „Seitenleiste im Acryl-Stil" über einem opaken Fenster ist Blur ohne Hintergrund —
Rechenaufwand für ein Rauschmuster. Und Light+Dark verdoppelt jeden Token, ohne dass Light je
der Modus wäre, in dem jemand arbeitet.

Was C richtig hat und was ich übernehme: die *Erwartungskonformität*. Segoe UI, native
`<select>`-Popups, echte Fensterdekoration, keine erfundene Titelleiste, `Ctrl+Shift+…`
nach Windows-Terminal-Konvention. Diese Dinge sind orthogonal zur Helligkeit.

---

## Teil 2 — Das Designsystem

### 0. Grundsatz

Drei Sätze, aus denen sich alles Weitere ableitet:

1. **Der Terminalinhalt ist das Hellste im Bild.** Die Chrome liegt darüber im Grauwert, nie
   darunter. Alle Flächen der App bewegen sich in einem schmalen Band zwischen `#0B0D10` und
   `#262C34`.
2. **Die Chrome trägt Signale, nie Dekoration.** Jeder Farbfleck außerhalb des Terminals hat
   genau eine Bedeutung. Es gibt keinen Gradienten, keinen Schatten zur Erhebung, keine
   Rundung auf einer Kachel.
3. **Kein Zustand steckt in Farbe allein** (Constraint 3). Jeder Indikator trägt zusätzlich
   Form (gefüllt/hohl, Quadrat/Dreieck) **und** Text.

### 1. Farbtoken

Alle Werte sind für **Dark Mode**. Zu Light Mode siehe §1.5.

#### 1.1 Flächen

| Token | Hex | Rolle |
|---|---|---|
| `--ab-bg-canvas` | `#0B0D10` | Terminal-Well, App-Hintergrund, Rasterfuge. **Identisch mit `theme.background` von xterm.** |
| `--ab-bg-chrome` | `#131619` | Sidebar, Toolbar, Kachelkopf (unfokussiert) |
| `--ab-bg-raised` | `#191D22` | Eingabefelder, Track des Segmented Control, Hover auf Listenzeilen |
| `--ab-bg-hover` | `#1F242A` | Hover auf Schaltflächen und Segmenten |
| `--ab-bg-active` | `#262C34` | Kachelkopf **des fokussierten Terminals**, gedrückte Schaltfläche, ausgewählte Sidebar-Zeile **ohne** Tastaturfokus in der Sidebar |
| `--ab-bg-overlay` | `#1B1F25` | Modal (TOFU-Rückfrage), Such-Overlay, Popover |
| `--ab-bg-scrim` | `rgba(4,6,8,.66)` | Abdunkelung hinter einem Modal |

#### 1.2 Ränder

| Token | Hex | Rolle |
|---|---|---|
| `--ab-border-subtle` | `#21262D` | Hairlines: Sidebar/Grid-Trennung, Kachelfugen, Toolbar-Unterkante |
| `--ab-border-default` | `#2C333B` | Rand von Eingabefeldern, Schaltflächen, Segmented Control |
| `--ab-border-strong` | `#3A424C` | Hover-Rand von Bedienelementen, hohler Zustandsindikator |

#### 1.3 Text

| Token | Hex | Kontrast auf `--ab-bg-chrome` | Rolle |
|---|---|---|---|
| `--ab-text-primary` | `#E3E8EE` | 14,7:1 | Hostname, fokussierter Kacheltitel, Überschriften, Fließtext |
| `--ab-text-secondary` | `#A8B2BD` | 8,5:1 | Sessionname, Toolbar, Beschriftungen |
| `--ab-text-muted` | `#7B8794` | 5,0:1 | Meta: Zustandswörter, Zähler, `user@host`, Kürzelhinweise |
| `--ab-text-disabled` | `#4A545F` | 2,2:1 | **Nur** deaktivierte Bedienelemente (WCAG 1.4.3 nimmt inaktive Komponenten aus) |

> Regel: `--ab-text-muted` ist nur auf `--ab-bg-canvas`, `--ab-bg-chrome` und `--ab-bg-raised`
> zugelassen. Auf `--ab-bg-active` (3,8:1) ist die unterste erlaubte Stufe
> `--ab-text-secondary`.

#### 1.4 Akzent, Fokus, Semantik

| Token | Hex | Rolle |
|---|---|---|
| `--ab-accent` | `#4C9AFF` | **Auswahl / aktiv**: Kachel-Fokuskante, gewähltes Segment, ausgewählte Sidebar-Zeile, Primärschaltfläche, xterm-Cursor. 6,4:1 auf Chrome, 6,8:1 auf Canvas |
| `--ab-accent-hover` | `#69ACFF` | Hover auf Primärschaltfläche |
| `--ab-accent-quiet` | `#1B3255` | Flächige Akzentfüllung der ausgewählten Sidebar-Zeile, **während die Sidebar den Tastaturfokus hat** |
| `--ab-focus-ring` | `#A9D2FF` | **Tastaturfokus**, ausschließlich. Bewusst heller als `--ab-accent`, damit ein Ring auf einer bereits akzentuierten Fläche sichtbar bleibt. ≥ 8,9:1 gegen jede Fläche |
| `--ab-ok` | `#56D364` | verbunden / Preflight bestanden. 9,4:1 |
| `--ab-ok-bg` | `#12291A` | Fläche einer Erfolgsmeldung |
| `--ab-warn` | `#E3B341` | Eingabe gesperrt, Verbindung verloren, Kachel zu schmal. 9,3:1 |
| `--ab-warn-bg` | `#2A2314` | Fläche eines Warnbanners |
| `--ab-warn-border` | `#5C4A1F` | Rand eines Warnbanners |
| `--ab-danger` | `#FF7B72` | Verbindung fehlgeschlagen, Preflight blockiert, Host-Key abgelehnt. 7,2:1 |
| `--ab-danger-bg` | `#2A1517` | Fläche eines Fehlerbanners |
| `--ab-danger-border` | `#5C2B2B` | Rand eines Fehlerbanners |
| `--ab-neutral-off` | `#7B8794` | **getrennt / geschlossen** — bewusst grau, nicht rot. Getrennt ist kein Fehler |

> **Zur ausgewählten Sidebar-Zeile:** zwei Token, zwei Fälle, kein Widerspruch. Hat die Sidebar
> den Tastaturfokus, ist die Auswahl `--ab-accent-quiet` (die Auswahl ist gerade *bedienbar*);
> liegt der Fokus im Raster, fällt sie auf `--ab-bg-active` zurück (die Auswahl ist nur noch
> *Merkposten*). Dasselbe Muster wie `selectionBackground` / `selectionInactiveBackground` in
> §2. Der Text bleibt in beiden Fällen `--ab-text-primary` 600.
>
> **`--ab-neutral-off` ist wertgleich mit `--ab-text-muted` (`#7B8794`) — Absicht, kein
> Duplikat.** Der eine Name benennt eine Textstufe, der andere einen Zustand; sie dürfen später
> unabhängig auseinanderlaufen. Nicht „aufräumen".

**Warum getrennt nicht rot ist:** `vm-c getrennt` im Mockup ist ein Normalzustand, kein
Vorfall. Rot dafür zu verbrauchen macht echte Fehler unsichtbar. Getrennt = hohle Form + graue
Farbe + Wort `Disconnected`. Fehlgeschlagen = **andere Form** (Dreieck) + `--ab-danger` + Wort
`Failed`.

#### 1.5 Light Mode: bewusst nicht in v1

**Begründung, nicht Bequemlichkeit.** Der Bildschirm besteht bei dieser App zu 70–90 % aus
xterm-Viewports, deren Palette dunkel ist und die der Nutzer als Terminal-Palette pflegt. Eine
helle Chrome erzeugt an jeder Kachelkante einen dauerhaften Luminanzsprung von ~15:1 — exakt
der Befund gegen Richtung C. Eine helle Chrome *mit* hellem Terminal wäre konsistent, aber
niemand betreibt Agenten-CLIs auf hellem Grund, und die xterm-Palette gehört nicht der App.

`:root { color-scheme: dark; }` wird **explizit gesetzt** (die aktuelle `src/styles.css` hat
`light dark`). Das ist kein Kosmetikpunkt: das Auth-Dropdown ist ein natives `<select>`, dessen
aufgeklappte Liste nicht stylebar ist und `color-scheme` folgt — ohne diese Zeile blitzt sie
weiß auf. Dasselbe gilt für xterms Viewport-Scrollbalken und für native Kontextmenüs.

Die Token sind so geschnitten, dass Light ein reiner Variablentausch wäre: alle Regeln
referenzieren ausschließlich Token, kein Literal-Hex steht in einer Komponentenregel, und die
Flächenrampe ist als Rolle benannt (`canvas`/`chrome`/`raised`/`active`), nicht als Helligkeit
(`gray-900`).

---

### 2. xterm.js-Palette

Gepaart mit der Chrome oben. `background` ist identisch mit `--ab-bg-canvas`, damit die Fuge
zwischen Kachelkopf und Viewport nicht doppelt Kante wird.

```ts
// src/terminal.ts — an den Terminal-Konstruktor
const AB_TERMINAL_THEME = {
  background:                  "#0B0D10",
  foreground:                  "#C9D1D9",
  cursor:                      "#4C9AFF",
  cursorAccent:                "#0B0D10",
  selectionBackground:         "#31435C",
  selectionForeground:         "#F0F3F6",
  selectionInactiveBackground: "#2A323D",

  black:         "#15181D",
  red:           "#FF7B72",
  green:         "#56D364",
  yellow:        "#E3B341",
  blue:          "#6CB0FF",
  magenta:       "#D2A8FF",
  cyan:          "#39C5CF",
  white:         "#B9C2CC",

  brightBlack:   "#6B7683",
  brightRed:     "#FFA198",
  brightGreen:   "#7EE787",
  brightYellow:  "#F2CC60",
  brightBlue:    "#9BCBFF",
  brightMagenta: "#E2C5FF",
  brightCyan:    "#56D4DD",
  brightWhite:   "#F0F3F6",
};
```

Begleitende Terminal-Optionen:

```ts
new Terminal({
  theme: AB_TERMINAL_THEME,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
  fontSize: 13,
  lineHeight: 1.15,
  letterSpacing: 0,
  fontWeight: 400,
  fontWeightBold: 600,
  cursorBlink: true,
  cursorStyle: "block",
  // ... bestehende Optionen (allowProposedApi, scrollback, linkHandler) unverändert
});
```

Sechs Begründungen, die beim Implementieren zählen:

- **`background` muss gesetzt werden.** Ohne `theme.background` nimmt xterm `#000` und die
  Kachel hat zwei verschiedene Schwarztöne.
- **`blue` ist angehoben** (`#6CB0FF`, 8,6:1 auf Canvas statt der üblichen ~4:1). Agenten-CLIs
  drucken Pfade, Dateinamen und Diff-Header in Blau; das ist die am häufigsten gelesene
  Nicht-Weiß-Farbe im Bild.
- **`selectionBackground` ist bewusst nicht der Akzent.** `#4C9AFF` markiert „diese Kachel hat
  Fokus". Eine Selektion in derselben Farbe innerhalb des Terminals wäre ein zweites, falsches
  Fokussignal.
- **`selectionForeground` ist gesetzt** (`#F0F3F6`). Das kostet Syntaxfarbe innerhalb der
  Selektion, garantiert aber Lesbarkeit — ohne diesen Wert steht `brightBlack`-Kommentartext
  bei 2,2:1 auf der Selektionsfläche.
- **`black` ist `#15181D`, nicht `#000000`.** TUIs setzen `black` als Hintergrund; auf einem
  `#0B0D10`-Canvas wäre echtes Schwarz ein unsichtbarer Block.
- **Cursor = Akzent ist unbedenklich**, obwohl vier Terminals sichtbar sind: xterm zeichnet in
  unfokussierten Terminals einen **hohlen** Cursor-Umriss. Es gibt also nie vier gefüllte
  Akzent-Cursor.

**Implementierungshinweis:** Ein Theme-Wechsel zur Laufzeit erfordert die Neuzuweisung des
*gesamten* `options.theme`-Objekts (`term.options.theme = {...}`); Mutation einzelner Felder
löst kein Neuzeichnen aus.

---

### 3. Typografie

#### 3.1 Font-Stacks

```css
--ab-font-ui:   "Segoe UI Variable Text", "Segoe UI", system-ui, "Noto Sans", sans-serif;
--ab-font-ui-small: "Segoe UI Variable Small", "Segoe UI", system-ui, sans-serif;
--ab-font-mono: "Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Mono", ui-monospace, monospace;
```

- `Segoe UI Variable Text` ist die optische Größe für 12–18 px auf Windows 11; `Segoe UI Small`
  ist für ≤ 11 px gezeichnet und wird nur für `--ab-fs-xs` verwendet. Auf Windows 10 fällt
  beides auf `Segoe UI` zurück, ohne Layoutsprung.
- **`Cascadia Mono` vor `Cascadia Code`**: Mono ist die ligaturfreie Schnittvariante. Ligaturen
  (`=>`, `!=`, `->`) verändern in Agenten-Output und Diffs die Spaltenzuordnung optisch, obwohl
  die Zelle dieselbe bleibt — in einem Werkzeug, das Terminal-Treue verspricht, ist das der
  falsche Kompromiss. Wer Ligaturen will, setzt `Cascadia Code` in den Einstellungen.
- Kein Webfont, kein `@font-face`. Beides sind Systemschriften; jede Einbettung wäre Startzeit
  und Lizenzfläche für null Gewinn.

#### 3.2 Skala

Alle Größen in **px, fix**. Kein `rem`, kein `em`. Grund: Der WebView ist kein Dokument,
sondern eine Anwendungsfläche; Text muss sich an Zellmetriken und feste Zeilenhöhen anlegen,
und eine kaskadierende Skala macht jede Höhenberechnung (§5) unvorhersagbar.

| Token | px | Gewicht | Zeilenhöhe | Verwendung |
|---|---|---|---|---|
| `--ab-fs-xs` | 11 | 400 / 600 | 14px | Meta-Text, Zustandswörter, Kachelindex-Badge, Zähler, Kürzelhinweise. Abschnittslabels zusätzlich `text-transform: uppercase; letter-spacing: .04em` |
| `--ab-fs-sm` | 12 | 400 / 600 | 16px | Sidebar-**Session**, Kacheltitel, kleine Schaltflächen, Segmented-Control-Ziffern |
| `--ab-fs-md` | 13 | 400 / 600 | 18px | **Basis.** Sidebar-**Host**, Toolbar, Fließtext, Eingabefelder, Schaltflächen, Fehlertext |
| `--ab-fs-lg` | 15 | 600 | 20px | Dialogüberschrift, Überschrift eines Leerzustands |
| `--ab-fs-xl` | 20 | 600 | 26px | Nur Erststart-Überschrift |

**Nur zwei Gewichte: 400 und 600.** Kein 500, kein 700. Segoe UI (Windows 10) hat kein echtes
Medium; ein `font-weight: 500` würde dort synthetisch oder gar nicht gerendert und die
Hierarchie zwischen 10er- und 11er-Geräten verschieben.

Konkrete Zuweisungen:

| Element | Größe | Gewicht | Farbe |
|---|---|---|---|
| Sidebar-Host, verbunden | `--ab-fs-md` | 600 | `--ab-text-primary` |
| Sidebar-Host, getrennt | `--ab-fs-md` | 600 | `--ab-text-secondary` |
| Sidebar-Session | `--ab-fs-sm` | 400 | `--ab-text-secondary` |
| Sidebar-Session, ausgewählt | `--ab-fs-sm` | 600 | `--ab-text-primary` |
| Sidebar-Zustandswort (`Connected`) | `--ab-fs-xs` | 400 | `--ab-text-muted` |
| Sidebar-Abschnittslabel (`HOSTS`) | `--ab-fs-xs` | 600, uppercase | `--ab-text-muted` |
| Kacheltitel, unfokussiert | `--ab-fs-sm` | 400 | `--ab-text-muted` |
| Kacheltitel, **fokussiert** | `--ab-fs-sm` | **600** | `--ab-text-primary` |
| Toolbar-Pfad (`s1 — u@192.0.2.10`) | `--ab-fs-md` | 400 | `--ab-text-secondary` |
| Kachel-Index-Badge | `--ab-fs-xs` | 600 | s. §6 |

---

### 4. Raster, Maße, Radien

**Basiseinheit: 4 px.** Skala: `2 · 4 · 6 · 8 · 12 · 16 · 20 · 24 · 32 · 48`.

| Token | Wert | Anmerkung |
|---|---|---|
| `--ab-sidebar-w` | `240px` | Vorgabe. Ziehbar 180–420 px, Wert persistiert in `settings.toml`. Einklappbar auf 0 (`Ctrl+Shift+B`) |
| `--ab-toolbar-h` | `40px` | Auch die Höhe des Sidebar-Kopfes — beide Kanten fluchten |
| `--ab-tile-head-h` | `28px` | Fix. Wächst nie mit Inhalt; überlanger Titel wird `text-overflow: ellipsis` |
| `--ab-row-h-host` | `30px` | Sidebar-Hostzeile |
| `--ab-row-h-session` | `26px` | Sidebar-Sessionzeile. WCAG 2.5.8 verlangt 24×24 CSS-px Zielgröße — erfüllt |
| `--ab-tile-gap` | `0` | **Keine Lücke.** Kacheln trennt eine 1-px-Hairline |
| `--ab-tile-focus-w` | `3px` | Linke Kante der Kachel, Fokussignal |
| `--ab-border-w` | `1px` | Alle Hairlines |
| `--ab-focus-w` | `2px` | Fokusring |
| `--ab-radius-sm` | `3px` | Badges, Chips, Zustandsindikatoren |
| `--ab-radius-md` | `5px` | Eingabefelder, Schaltflächen, Segmented Control, Sidebar-Zeilen |
| `--ab-radius-lg` | `8px` | Modal, Leerzustandskarte, Such-Overlay |
| `--ab-radius-tile` | `0` | **Kacheln haben keine Rundung.** S. u. |

**Warum `--ab-radius-tile: 0`.** Eine gerundete Kachel um xterm erzwingt `overflow: hidden` und
beschneidet dadurch Glyphenzellen an vier Ecken — Box-Drawing, Fortschrittsbalken und
tmux-Statuszeilen enden dort angeschnitten. Zusätzlich kostet jede Rundung eine Fuge, und die
Fuge kostet Terminalspalten (§5). Rundung außerhalb des Rasters (Schaltflächen, Dialoge, Zeilen)
bleibt — sie ist dort gratis und macht Bedienelemente als Bedienelemente lesbar.

**Erhebung:** Es gibt genau **einen** `box-shadow` im ganzen System, und zwar am Modal:
`0 16px 48px rgba(0,0,0,.55)`. Kein Schatten auf Kacheln, Kärtchen, Popovers oder
Schaltflächen. Ebenen werden durch Flächenhelligkeit und Hairline unterschieden, nicht durch
Tiefenillusion.

**Scrollbalken:** Sidebar und Panels bekommen
`scrollbar-width: thin; scrollbar-color: var(--ab-border-strong) transparent`. Der
**xterm-Viewport-Scrollbalken bleibt unangetastet** — bei 5000 Zeilen Scrollback ist er eine
Positionsanzeige, kein Zierrat, und er darf nicht bei Nicht-Hover verschwinden. Durch
`color-scheme: dark` ist er ohne weiteres Zutun dunkel. *Seit 29.10.2026 entfällt der
Terminalbalken ganz (§9, Regel 9).*

---

### 5. Verhalten in der Fläche

#### 5.1 Die Spaltenrechnung — die harte Randbedingung

Alles in diesem Abschnitt folgt aus einer Zahl. `Cascadia Mono` hat eine Vorschubbreite von
1200/2048 em = **0,5859 em**, bei `fontSize: 13` also **7,62 px pro Spalte**; bei
`lineHeight: 1.15` sind das **15 px pro Zeile**. Der xterm-Viewport-Scrollbalken nimmt ~15 px.

Bei einem 1600×1000-Client, Sidebar 240 px + 1 px Trennung → Grid-Fläche **1359 × 960** px:

| Layout | Kachel px | **Spalten × Zeilen** |
|---|---|---|
| 1 | 1359 × 932 | **176 × 62** |
| 2 (nebeneinander) | 679 × 932 | **87 × 62** |
| 4 (2×2) | 679 × 451 | **87 × 30** |

87×30 im Viererraster bei 1600×1000. Über 80 Spalten, über 24 Zeilen — beides Schwellen, gegen
die Agenten-CLIs ihre Ausgabe layouten.

Damit ist entschieden, was sonst Geschmacksfrage wäre:

- **Warum 13 px Mono und nicht 14.** Bei 14 px (8,20 px/Spalte) fällt die Viererkachel auf
  **80 × 28** — exakt auf die Schwelle, ohne jede Reserve. Zieht der Nutzer die Sidebar auf
  280 px, rutscht sie auf 78 Spalten. 13 px hat 7 Spalten Luft, 14 px hat null.
- **Warum keine Lücken und keine Rundung.** Richtung Bs `gap: 9px` + `padding: 9px` + 2×1 px
  Border kostet dieselbe Kachel rund **3 Spalten** (85 statt 88). Klein — aber es ist reiner
  Verlust gegen Weichzeichnung eingetauscht.
- **Minimale sinnvolle Fenstergröße** für 4 Kacheln à 80×24: 625 px pro Kachel und 388 px pro
  Reihe → **1492 × 817**. Empfehlung für `tauri.conf.json`: `minWidth: 1100, minHeight: 700`
  (erlaubt 1er/2er komfortabel) und **kein** automatisches Herunterschalten des Layouts —
  stattdessen §5.4.

> **Genauigkeit dieser Zahlen — einmal empirisch prüfen.** Alles oben hängt an einer
> Vorschubbreite von 0,5859 em für `Cascadia Mono`. Trifft der Fallback (`Consolas`, ~0,55 em)
> oder ein anderer Wert (~0,6 em) zu, verschiebt sich die Viererkachel auf 92 bzw. 85 Spalten.
> **Die Entscheidungen überleben jede dieser Varianten** — 13 px statt 14 px, keine Lücken,
> keine Rundung, 2×2 statt 4×1 unter 3111 px sind in allen drei Fällen dieselben. Zu prüfen ist
> nur die Anzeige in §5.4: `term.cols`/`term.rows` beim ersten Start gegen die Tabelle halten
> und die Konstante `7.62` in der Layoutregel aus `term.element` messen statt hart zu
> verdrahten.

#### 5.2 Sidebar mit vertikalem Platz

Die Sidebar ist eine **Liste, kein gefülltes Panel**. Sie besteht aus drei Zonen:

```
┌ Kopf 40px ────────────┐  HOSTS                    [+]   (nicht scrollend)
├ Liste (flex:1, scroll)┤  ▾ ● vm-a       Connected
│                       │    │ s1 · claude      Open
│                       │    │ s2 · codex       Open
│                       │    │ s3               Closed
│                       │  ▾ ● vm-b       Connected
│                       │    │ s4 · bash        Open
│                       │  ▸ ○ vm-c       Disconnected
├ Fuß 36px ─────────────┤  + Add host   Ctrl+Shift+N   (nicht scrollend)
└───────────────────────┘
```

- **Bei 3 Hosts:** Die Liste ist oben ausgerichtet und füllt den Rest **nicht** auf. Darunter
  ist einfach `--ab-bg-chrome`. Kein Strecken der Zeilen, keine zentrierte Anordnung, keine
  Auffüll-Illustration.
- **Bei 20 Sessions:** Die Hostzeile ist `position: sticky; top: 0` mit
  `background: var(--ab-bg-chrome)` und einer Hairline unten. Beim Scrollen durch die Sessions
  eines Hosts bleibt sichtbar, wem sie gehören — das ist bei 176 px Mockup-Höhe unsichtbar und
  bei 1000 px die entscheidende Eigenschaft.
- **Jede Hostgruppe ist zusammenklappbar**, Disclosure-Dreieck links (`▾`/`▸`). Tastatur: `←`/`→`
  auf der Hostzeile — **einfache Pfeiltasten**, kein Konflikt mit Constraint 4, weil der Fokus
  hier in der Sidebar und nicht im Terminal liegt. Eine zugeklappte Gruppe zeigt rechts
  `7 sessions` (Text, `--ab-fs-xs`).
- Die Session-Führungsschiene ist **1 px `--ab-border-subtle`**, 12 px eingerückt, und endet an
  der letzten Session der Gruppe — sie darf keine durchgehende Vertikale über die ganze Sidebar
  bilden.
- **Fuß pinnt** `Add host`. Bei 20 Sessions darf die einzige Möglichkeit, einen Host
  hinzuzufügen, nicht aus dem Bild scrollen.
- Tastaturnavigation: die Liste ist **eine** Tab-Station mit Roving-Tabindex; `↑`/`↓` bewegen
  sich über Hosts und Sessions hinweg, `Home`/`End` an die Enden, Tippen springt per
  Erstbuchstabe. `Enter` öffnet, `Space` wählt aus.

#### 5.3 Das Raster auf großen und ultrabreiten Bildschirmen

Der Umschalter **1 / 2 / 4 bleibt** — er bestimmt, *wie viele* Kacheln sichtbar sind. Was sich
mit der Fläche ändert, ist die **Anordnung** derselben Anzahl. Regel, aus §5.1 abgeleitet, nicht
aus Seitenverhältnissen geraten:

```
COMFORT_COL = 100                          // Spalten, ab denen eine Spalte "voll" ist
TILE_MIN_W  = COMFORT_COL * 7.62 + 15 ≈ 777px

Layout 2:  gridW / gridH >= 1.1  →  nebeneinander (2×1),  sonst gestapelt (1×2)
Layout 4:  gridW >= 4 * TILE_MIN_W + 3 ≈ 3111px  →  4×1 (vier volle Spalten)
           sonst 2×2
```

Was das konkret bedeutet:

| Fenster | Layout 4 | Ergebnis pro Kachel |
|---|---|---|
| 1600×1000 | 2×2 | 87 × 30 |
| 2560×1080 | 2×2 | 150 × 30 |
| 3440×1440 | **4×1** | 102 × 62 |

Die Zahlen tragen die Entscheidung: Bei 2560 gäbe 4×1 nur **74 Spalten** — unter der
80er-Schwelle, also schlechter als 2×2 mit 150×30. Bei 3440 gibt 4×1 dagegen 102×62 gegen
207×30 — und für das Beobachten von Agenten ist Historie (Zeilen) mehr wert als 207 Spalten
Breite, die keine CLI ausnutzt. **Kein zweispaltiges Sidebar-Layout, keine dritte Spalte, kein
Inspector-Panel** auf Ultrawide: die gewonnene Fläche gehört den Terminals.

#### 5.4 Wenn eine Kachel zu schmal wird

Kein automatisches Herunterschalten des Layouts (unvorhersehbares Springen). Stattdessen: Fällt
eine Kachel unter 80 Spalten oder 20 Zeilen, erscheint rechts im Kachelkopf ein Chip in
`--ab-warn` mit dem **Text** `76×24 · narrow`. Der Nutzer sieht die Ursache und behält die
Kontrolle. (i18n: `tile.narrow`.)

#### 5.5 Ein einziger Refit-Pfad — gilt für jede Layoutänderung

§7.1 leitet für das Maximieren her, warum eine Größenänderung einer Kachel teuer ist
(`fit()` → `resize_terminal` → V12: Codex löscht per `ESC[3J` den serverseitigen
tmux-Scrollback). Maximieren ist aber nur der auffälligste Fall. Dieselbe Kette hängt an:

| Auslöser | Häufigkeit | Betroffen |
|---|---|---|
| Rasterumschalter 1/2/4 (`Ctrl+Shift+G`, Segmented Control) | **am häufigsten** | alle sichtbaren Kacheln gleichzeitig |
| Maximieren / Wiederherstellen (§7) | häufig | eine Kachel |
| Sidebar ziehen 180–420 px | selten, aber **kontinuierlich** | alle sichtbaren Kacheln, potenziell dutzendfach pro Zug |
| Sidebar ein-/ausklappen (`Ctrl+Shift+B`) | selten | alle sichtbaren Kacheln |
| Warnstreifen bei Verbindungsverlust (§8.3) | selten | eine Kachel |

**Verbindliche Regel, ein Satz:** Jede Änderung, die die Pixelgröße einer Kachel verändert,
läuft durch **denselben** entprellten Pfad wie `window.resize` — `RESIZE_DEBOUNCE_MS = 300`
plus den `lastSentCols`/`lastSentRows`-Vergleich aus `src/terminal.ts`. Nie ein direkter
`resize_terminal`-Aufruf aus dem Layout-Code.

Zwei Zusätze:

- **Der Ziehgriff der Sidebar committet auf `pointerup`, nicht während des Ziehens.** Während
  der Bewegung wird nur die CSS-Breite animiert; `fit()` läuft genau einmal, danach.
- Genau daraus folgt Verbot 12 in §9 (keine Transitions auf Layouteigenschaften): jeder
  Zwischenframe einer Breiten- oder Höhen-Transition wäre ein zusätzlicher `fit()`-Kandidat
  und würde die Entprellung unterlaufen.

#### 5.6 Wenn nichts verbunden ist

Die Grid-Fläche zeigt **keine** leeren Kachelrahmen. Sie zeigt eine zentrierte Karte,
`max-width: 440px`, `--ab-bg-chrome`, `--ab-radius-lg`, 1 px `--ab-border-subtle`, vertikal
etwas oberhalb der Mitte (bei 38 % Höhe — geometrische Mitte wirkt auf 1000 px zu tief). Inhalt
siehe §8.1. Der Umschalter 1/2/4 in der Toolbar ist in diesem Zustand `aria-disabled="true"`
und `--ab-text-disabled`.

---

### 6. Fokus und Aufmerksamkeit

#### 6.1 Was nicht geht — und warum es hier steht

Der naheliegende Griff wäre, die drei unfokussierten Terminals abzudunkeln. **Das ist nicht
verfügbar.** Der Viewport gehört xterm; eine `opacity`- oder Overlay-Schicht über einem
WebGL-Canvas erzwingt eine eigene Compositing-Ebene pro Kachel und verschlechtert genau den
Text, den der Nutzer im Augenwinkel mitliest. **Sämtliche Fokussignale leben in Kachelkopf und
Kachelrand.** Das ist die Randbedingung, aus der §6.2 folgt.

#### 6.2 Drei gestapelte Signale für „hier landen meine Tastendrücke"

Bei vier Terminals auf 1600×1000 muss das Signal aus 700 px peripherer Distanz erkennbar sein.
Ein Signal reicht dafür nicht; drei unabhängige tun es:

**1 — Akzentkante, 3 px, volle Kachelhöhe.**
Jede Kachel hat `border-left: 3px solid`. Unfokussiert `--ab-border-subtle` (#21262D, praktisch
unsichtbar), fokussiert `--ab-accent`. Volle Höhe statt einer 1-px-Linie unter dem Kopf: eine
451 px hohe Kante bei 6,8:1 Kontrast ist peripher erfassbar, eine 679 px breite 1-px-Linie
nicht. Weil die Kante immer da ist (nur die Farbe wechselt), gibt es **keinen Layoutsprung** und
damit kein `fit()`.

**2 — Der Kachelkopf hebt sich um eine Flächenstufe.**
Unfokussiert: `--ab-bg-chrome`, Titel `--ab-text-muted` 400.
Fokussiert: `--ab-bg-active`, Titel `--ab-text-primary` **600**.
Das ist Helligkeit **plus** Schriftgewicht — der Gewichtssprung allein trägt das Signal auch
ohne Farbwahrnehmung.

**3 — Index-Badge, gefüllt statt hohl.**
Links im Kachelkopf steht immer eine Ziffer `1`–`9`: der **Index der Session in der
Sidebar-Liste**, also exakt die Ziffer, die `Ctrl+Shift+N` auf diese Session wirft (§7.5). Sie
bleibt konstant, wenn der Nutzer zwischen 1/2/4 umschaltet — sie beschreibt die Session, nicht
den Kachelplatz. Sessions jenseits von 9 tragen kein Badge.

| | unfokussiert | fokussiert |
|---|---|---|
| Fläche | transparent | `--ab-accent` |
| Rand | 1 px `--ab-border-strong` | keiner |
| Text | `--ab-text-muted` | `--ab-bg-canvas` |
| Maße | 16×16, `--ab-radius-sm`, `--ab-fs-xs` 600 | dito |

Hohl → gefüllt ist eine **Formänderung** und erfüllt Constraint 3 unabhängig von Farbe.

Dazu, nicht sichtbar, aber gefordert: die fokussierte Kachel trägt `aria-current="true"` und im
Kopf ein `<span class="ab-visually-hidden">Focused</span>` (`tile.focused`).

#### 6.3 Selektor-Hinweis

xterms Fokus liegt auf einem internen `<textarea>`, das programmatisch fokussiert wird —
`:focus-visible` feuert dafür bei einem Mausklick **nicht**. Auf Kachelebene ist deshalb
`:focus-within` (bzw. eine vom Grid-Controller gesetzte Klasse `.ab-tile--focused`) die richtige
Bedingung, `:focus-visible` gilt nur für Schaltflächen, Zeilen und Eingaben.

#### 6.4 Der Fokusring

Ein einziger Ring, überall gleich, auf **jedem** interaktiven Element (Constraint 1):

```css
:where(button, a, input, select, [tabindex], .ab-row, .ab-seg-item):focus-visible {
  outline: var(--ab-focus-w) solid var(--ab-focus-ring);
  outline-offset: 2px;
  border-radius: inherit;
}
```

- `--ab-focus-ring` (#A9D2FF) ist bewusst **heller als der Akzent**: eine bereits ausgewählte
  Sidebar-Zeile (`--ab-accent-quiet`-Fläche) oder ein aktives Segment (`--ab-accent`-Fläche)
  muss zusätzlich einen sichtbaren Tastaturfokus zeigen können. Ein akzentfarbener Ring wäre
  dort unsichtbar.
- Kontrast des Rings gegen jede definierte Fläche: ≥ 8,9:1 (Canvas 12,4 · Chrome 11,5 · Raised
  10,7 · Active 8,9). Anforderung wäre 3:1.
- `outline-offset: 2px` erzeugt eine 2-px-Fuge in Flächenfarbe. Deshalb muss der Ring **nicht**
  3:1 gegen den Akzent erreichen, sondern gegen die Fuge — er tut es.
- **Ausnahme Kachel:** Elemente an der Rasterkante bekommen `outline-offset: -2px` (Ring nach
  innen), sonst schneidet die Nachbarkachel ihn ab.
- **Niemals** `outline: none` ohne Ersatz. Kein `:focus { outline: none }` irgendwo.

---

### 7. Maximieren

#### 7.1 Die technische Wahrheit zuerst

Maximieren ändert die Pixelgröße der Kachel, `FitAddon` rechnet neue `cols`/`rows`, und daraus
folgt `resize_terminal` → SSH `window_change` → tmux-Repaint. Laut Kommentar in
`src/terminal.ts` (zu `RESIZE_DEBOUNCE_MS`, Spec V12) **löscht ein inline rendernder Agent
(Codex) bei jedem Resize per `ESC[3J` den serverseitigen tmux-Scrollback**. Genau deshalb hängt
`onResize` dort ausschließlich an `window.addEventListener('resize', …)` und bewusst *nicht* an
einem `ResizeObserver` auf dem Container.

Maximieren ist damit exakt der Fall „Kachel ändert Größe ohne Fensteränderung", den der
bestehende Code nicht abdeckt. Es gibt zwei ehrliche Optionen:

| | (a) Refit | (b) Letterbox |
|---|---|---|
| Verhalten | `fit()` + `resize_terminal` nach dem Umschalten | `cols`/`rows` bleiben, Terminal zentriert in der größeren Fläche |
| Gewinn | 87×30 → 176×62 | keiner |
| Kosten | ein Repaint, bei Codex Scrollback-Verlust | breite Leerränder |

**Entscheidung: (a) Refit.** Ein maximiertes Terminal, das weiterhin 87×30 zeigt, verfehlt den
Zweck der Geste vollständig. Verbindliche Zusätze:

- Der Refit läuft über **denselben** entprellten Pfad wie `window.resize`
  (`RESIZE_DEBOUNCE_MS = 300`) und über denselben `lastSentCols`/`lastSentRows`-Vergleich.
  Schnelles Rein-Raus-Maximieren darf höchstens einen Resize erzeugen.
- Das Wiederherstellen refittet zurück — der Vergleich verhindert, dass identische Größen
  gesendet werden.
- Diese Kopplung ist der Grund, warum das Maximieren **nicht animiert wird**: jeder Frame einer
  Breiten-/Höhen-Transition wäre ein potenzieller `fit()`-Aufruf.

#### 7.2 Das Aussehen

Die maximierte Kachel füllt die **gesamte Grid-Fläche** (nicht das Fenster — Toolbar und
Sidebar bleiben sichtbar und bedienbar). Der Zustand ist an drei Stellen ablesbar:

1. **Kachelkopf, rechts:** ein Chip, `--ab-bg-active`, `--ab-radius-sm`, `--ab-fs-xs`, mit
   Kollaps-Glyphe und dem Text `Maximized · Esc`. Er ist ein echter `<button>` (`tile.restore`)
   — Klick stellt wieder her. Der Chip ist **Text plus Glyphe**, nie nur Icon.
2. **Toolbar:** der Umschalter 1/2/4 wird `aria-disabled="true"` und `--ab-text-disabled`;
   daneben erscheint `Maximized` in `--ab-text-secondary`. So ist klar, warum der Umschalter
   gerade nicht greift.
3. **Sidebar:** die zugehörige Sessionzeile behält ihre Auswahlmarkierung; die drei anderen
   sichtbaren Sessions verlieren ihre Kachelindex-Badges (sie sind nicht mehr sichtbar).

Zusätzlich meldet eine `aria-live="polite"`-Region einmalig `Terminal 2 maximized. Press Escape
to restore.` (`tile.maximized.announce`).

#### 7.3 Animation

- Kein Layout-Übergang. Keine `transform`-Skalierung, kein FLIP, keine Kachelbewegung.
- Erlaubt ist genau eine 100-ms-`opacity`-Blende auf dem Chip aus §7.2/1.
- `@media (prefers-reduced-motion: reduce)` schaltet auch diese ab.

#### 7.4 Tastatur — und wie `Esc` sauber bleibt

`Esc` stellt wieder her, aber **nur wenn der Fokus auf App-Chrome liegt** (Sidebar, Toolbar,
Kachelkopf, Dialog). Liegt er im xterm-Instanz, geht `Esc` unverändert ans Terminal — sonst
verliert vim seine Escape-Taste.

Der bestehende Code tut das bereits richtig und darf nicht angefasst werden:
`attachCustomKeyEventHandler` in `src/terminal.ts` gibt für alles außer `Ctrl+Shift`-Akkorden
`true` zurück, `Esc` erreicht die App also gar nicht, solange das Terminal Fokus hat. Der
App-`keydown`-Handler für `Esc` muss entsprechend auf `document` sitzen und früh aussteigen,
wenn `event.target` innerhalb eines `.xterm`-Teilbaums liegt.

Der Weg heraus **aus** einem fokussierten maximierten Terminal ist deshalb ein Akkord:

#### 7.5 Neue Tastenbelegungen

Die Ziffern `1`–`9` sind bereits durch `session.select.N` belegt; ein `Ctrl+Shift+1/2/4` für den
Rasterumschalter würde damit kollidieren. Freie Buchstaben, die nicht durch
`clipboard.copy/paste`, `search.local`, `session.new/close` belegt sind: **B, E, G, M**. Die
Vorschläge nutzen genau diese vier plus die noch freien Links/Rechts-Pfeile:

| Akkord | Neue Aktion | Wirkung |
|---|---|---|
| `Ctrl+Shift+M` | `tile.maximize` | Maximieren/Wiederherstellen der fokussierten Kachel. **Der Weg heraus, wenn der Fokus im Terminal liegt** |
| `Ctrl+Shift+G` | `grid.cycle` | Rasterumschalter zyklisch 1 → 2 → 4 → 1 |
| `Ctrl+Shift+B` | `sidebar.toggle` | Sidebar ein-/ausblenden |
| `Ctrl+Shift+E` | `sidebar.focus` | Fokus in die Sidebar-Liste setzen |
| `Ctrl+Shift+Left` | `grid.focus.left` | Fokus zur Kachel links |
| `Ctrl+Shift+Right` | `grid.focus.right` | Fokus zur Kachel rechts |

Und die drei in Plan 1 validierten, aber unverdrahteten Aktionen bekommen endlich ihr Ziel:

- `session.prev` / `session.next` (`Ctrl+Shift+Up/Down`) → bewegen die Auswahl durch die
  **Sidebar-Liste** (hostübergreifend) und fokussieren die zugehörige Kachel, falls sichtbar.
- `session.select.1…9` (`Ctrl+Shift+1…9`) → wählt **immer die N-te Session in der
  Sidebar-Liste**; ist sie als Kachel sichtbar, folgt der Tastaturfokus dorthin, sonst öffnet
  sie im aktiven Kachelplatz. Bewusst *nicht* „die N-te sichtbare Kachel": sonst hieße
  `Ctrl+Shift+3` im Viererraster etwas anderes als im Zweierraster, und ein Akkord, dessen
  Bedeutung mit dem Layout wandert, ist im Muskelgedächtnis nicht haltbar. Die Index-Badges in
  den Kachelköpfen (§6.2) zeigen deshalb den **Sidebar-Index** der Session, nicht die
  Kachelposition.

**Implementierungsumfang — geprüft, nicht geschätzt:** Nur **zwei** Stellen in TypeScript:
die Union `KeymapAction` und `DEFAULT_KEYMAP` in `src/keymap.ts` (`KNOWN_ACTIONS` leitet sich
aus dessen Schlüsseln ab, driftet also nicht). `src-tauri/src/keymap.rs` braucht **keine**
Änderung: es exportiert nur `is_reserved_for_app` und `validate`, beide arbeiten
aktionsnamen-agnostisch über `HashMap<String, String>` — es gibt dort keine Aktionsliste. Dazu
die Tabelle in Spec §7.4 nachziehen.

---

### 8. Leer- und Fehlerzustände

#### 8.1 Erststart, kein Host

**Sidebar:** Kopf `HOSTS`, darunter eine einzelne Zeile in `--ab-text-muted`, `--ab-fs-sm`:
`No hosts yet`. Kein Platzhalter-Skelett, keine Geisterzeilen.

**Grid-Fläche:** die Karte aus §5.6.

```
              No hosts yet
   AgentBridge connects over SSH and runs your
   agents in tmux sessions on the host.

        [ Add a host ]   [ Import from ~/.ssh/config ]

        New session   Ctrl+Shift+N
```

- Überschrift `--ab-fs-lg` 600 `--ab-text-primary`; Fließtext `--ab-fs-md` 400
  `--ab-text-secondary`, `max-width: 46ch`.
- Primärschaltfläche: `--ab-accent`-Fläche, `--ab-bg-canvas`-Text. Sekundär: `--ab-bg-raised`,
  1 px `--ab-border-default`. Beide `--ab-radius-md`, Höhe 32 px.
- Der Kürzelhinweis unten: `--ab-fs-xs` `--ab-text-muted`, Akkord in `<kbd>` mit
  `--ab-bg-raised`, 1 px `--ab-border-default`, `--ab-radius-sm`, `--ab-font-mono` 11 px.
- **Autofokus** liegt auf `Add a host`. Ein Erststart, bei dem `Tab` erst durch die Sidebar
  muss, verfehlt Constraint 1 im Geist.
- Kein Bild, keine Illustration, kein Onboarding-Karussell.

#### 8.2 Host, der nicht verbinden konnte

Nach Spec §7.5 ist das **kein Modal** — es ist keine Entscheidung nötig, nur eine Information
mit nächstem Schritt.

**Sidebar-Hostzeile:** Zustandsindikator wird zum **Dreieck** in `--ab-danger` (s. §8.4), das
Zustandswort rechts zu `Failed` in `--ab-danger`, `--ab-fs-xs`. Der Hostname bleibt
`--ab-text-primary` — die Zeile bleibt anklickbar.

**Direkt darunter, eingerückt wie eine Session, eine Hinweiszeile:**
Fläche `--ab-danger-bg`, linke Kante 2 px `--ab-danger`, `--ab-radius-md`, Padding 8 px.
Enthält die konkrete Ursachenmeldung (`hostList.error` liefert sie bereits differenziert, Spec
§13) in `--ab-fs-xs` `--ab-text-secondary`, darunter drei kleine Textschaltflächen:
`Retry` · `Copy diagnostics` · `Edit host`.

**Grid-Fläche**, falls dieser Host gerade ausgewählt ist: dieselbe Meldung als Banner (volle
Breite, 1 px `--ab-danger-border`, `--ab-danger-bg`) oberhalb der Leerzustandskarte. Die
Meldung existiert zweimal, weil die Sidebar bei eingeklappter Ansicht unsichtbar sein kann.

#### 8.3 Terminal, dessen Verbindung abriss (stdin gesperrt)

Der Auslöser ist `terminal://connection-lost`; `mountTerminal` setzt bereits
`term.options.disableStdin = true`. Der Viewport zeigt weiterhin den letzten Bildschirm —
**dieser Inhalt wird nicht überlagert und nicht abgedunkelt**, er ist die Information darüber,
woran es lag.

Alles Sichtbare sitzt oberhalb des Viewports:

1. **Kachelkopf** wechselt die Fläche auf `--ab-warn-bg`, Titel bleibt lesbar, und rechts
   erscheint ein Chip: Warndreieck + Text `Input locked`.
2. **Direkt unter dem Kopf** ein 32-px-Streifen, `--ab-warn-bg`, 1 px `--ab-warn-border` unten,
   `--ab-fs-xs` `--ab-text-secondary`, mit dem vorhandenen Satz aus
   `terminal.connectionLost` und zwei Schaltflächen: `Reconnect` (primär) ·
   `Close terminal` (sekundär).
3. **Sidebar:** die Sessionzeile bekommt dasselbe Warndreieck und das Wort `Input locked`.

**Kanaltrennung — wichtige Regel:** Die linke Kachelkante gehört *ausschließlich* dem Fokus,
der Kachelkopf *ausschließlich* dem Zustand. Ein warnender Zustand färbt niemals die Fokuskante
um, und Fokus färbt niemals den Kopf zurück auf Normal. Zwei orthogonale Informationen, zwei
getrennte Flächen — sonst kann der Nutzer bei einer abgerissenen, fokussierten Kachel nicht mehr
beides gleichzeitig ablesen.

Der 32-px-Streifen kostet Terminalzeilen (2 Zeilen bei 15 px) und löst damit einen Refit aus.
Das ist zulässig: die Verbindung ist ohnehin weg, ein Repaint kann nicht mehr schaden, und der
Streifen verschwindet beim Reconnect wieder.

#### 8.4 Die Zustandsindikatoren — Formvokabular

**Bewusste Abweichung von Spec §7.1:** Dort steht `● ◐ ○ ✕ ?` — diese Glyphen tragen in der
Spec **Agenten-Aktivität** („wartet auf dich" / „arbeitet"). Da v1 keine Agenten-Erkennung hat
und in diesem Repo beide Dokumente nebeneinander liegen, wird für Verbindungszustände ein
**anderes Vokabular** benutzt, damit ein späterer Leser die beiden Bedeutungen nicht
verwechselt.

Alle Indikatoren sind 8×8 px CSS-Formen mit `--ab-radius-sm`, gefolgt von einem Textlabel:

| Zustand | Form | Farbe | Text (EN) |
|---|---|---|---|
| verbunden | **gefülltes** Quadrat | `--ab-ok` | `Connected` |
| getrennt | **hohles** Quadrat, 1,5 px Rand | `--ab-neutral-off` | `Disconnected` |
| verbindet | hohles Quadrat + rotierender Viertelbogen | `--ab-accent` | `Connecting…` |
| fehlgeschlagen | **Dreieck** (andere Geometrie) | `--ab-danger` | `Failed` |
| Terminal offen | gefülltes Quadrat, 6×6 | `--ab-ok` | `Open` |
| Terminal geschlossen | hohles Quadrat, 6×6 | `--ab-neutral-off` | `Closed` |
| Eingabe gesperrt | Dreieck, 8×8 | `--ab-warn` | `Input locked` |

Drei unabhängige Kanäle: **Geometrie** (Quadrat vs. Dreieck), **Füllung** (voll vs. hohl),
**Text**. Constraint 3 ist damit doppelt übererfüllt. Der rotierende Bogen respektiert
`prefers-reduced-motion` und wird dort zu einem halbgefüllten statischen Quadrat.

#### 8.5 Neue i18n-Schlüssel (Constraint 2)

`src/i18n/en.json` enthält heute nichts für Sidebar, Raster, Maximieren und Leerzustände. Diese
Schlüssel kommen dazu:

```jsonc
"sidebar.heading": "Hosts",
"sidebar.empty": "No hosts yet",
"sidebar.addHost": "Add host",
"sidebar.toggle": "Toggle sidebar",
"sidebar.host.connected": "Connected",
"sidebar.host.disconnected": "Disconnected",
"sidebar.host.connecting": "Connecting…",
"sidebar.host.failed": "Failed",
"sidebar.host.sessionCount": "{count} sessions",
"sidebar.host.expand": "Expand {host}",
"sidebar.host.collapse": "Collapse {host}",
"sidebar.session.open": "Open",
"sidebar.session.closed": "Closed",
"sidebar.session.inputLocked": "Input locked",

"grid.layout.label": "Visible terminals",
"grid.layout.one": "Show one terminal",
"grid.layout.two": "Show two terminals",
"grid.layout.four": "Show four terminals",
"grid.empty.heading": "No terminal open",
"grid.empty.body": "Pick a session on the left, or press {shortcut} to create one.",

"tile.index": "Terminal {index}",
"tile.focused": "Focused",
"tile.maximize": "Maximize",
"tile.restore": "Restore",
"tile.maximized.badge": "Maximized",
"tile.maximized.hint": "Maximized · Esc",
"tile.maximized.announce": "Terminal {index} maximized. Press Escape to restore.",
"tile.narrow": "{cols}×{rows} · narrow",

"empty.firstRun.heading": "No hosts yet",
"empty.firstRun.body": "AgentBridge connects over SSH and runs your agents in tmux sessions on the host.",
"empty.firstRun.primary": "Add a host",
"empty.firstRun.secondary": "Import from ~/.ssh/config",
"empty.firstRun.shortcutHint": "New session",

"error.host.heading": "Could not connect to {host}",
"error.host.retry": "Retry",
"error.host.copyDiagnostics": "Copy diagnostics",
"error.host.edit": "Edit host",
"error.terminal.reconnect": "Reconnect",
"error.terminal.close": "Close terminal",

"auth.method.label": "Authentication",
"auth.method.keyGroup": "Keys in %USERPROFILE%\\.ssh",
"auth.method.agent": "ssh-agent",
"auth.method.password": "Password",
"auth.method.chooseFile": "Choose file…"
```

#### 8.6 Das Auth-Dropdown

Ein natives `<select>`, kein nachgebautes Listbox-Widget — die Bedienung per Tastatur,
Erstbuchstabensprung und Screenreader-Anbindung ist dort geschenkt (Constraint 1), und ein
Nachbau wäre reine Fehlerfläche.

- Geschlossener Zustand: `appearance: none`, `--ab-bg-raised`, 1 px `--ab-border-default`,
  `--ab-radius-md`, Höhe 30 px, Padding `0 28px 0 10px`, `--ab-fs-md`; Chevron als
  `background-image` (Inline-SVG, `currentColor`), rechts 10 px.
- Aufgeklappte Liste: **nicht stylebar**, folgt `color-scheme: dark`. Deshalb ist §1.5 zwingend.
- Struktur mit `<optgroup>`:
  `Keys in %USERPROFILE%\.ssh` (gefundene Schlüssel, Dateiname als Label, voller Pfad im
  `title`) — dann die Einzeloptionen `ssh-agent`, `Password`, `Choose file…`.
- Ein Passphrase-Feld erscheint nur bei einer Schlüsseloption, ein Passwortfeld nur bei
  `Password`. Das Feld wird eingeblendet, nicht deaktiviert — ein deaktiviertes Feld ist
  Tastaturnavigations-Rauschen.

---

### 9. Was ich ausdrücklich nicht tue

Zwölf Bewegungen, die 2026 naheliegen und hier falsch wären:

1. **Kein `backdrop-filter` / Glassmorphism.** Hinter der Sidebar liegt ein opakes Fenster —
   es gibt nichts durchscheinen zu lassen. Neben ihr liegen vier WebGL-Canvases, für die der
   Filter dauerhaft Compositing-Arbeit erzeugt. (Der Befund gegen B und gegen Cs „Acryl".)
2. **Keine Rundung auf Terminalkacheln.** Beschneidet Glyphenzellen. §4.
3. **Keine Lücken zwischen Kacheln.** Sie kosten Terminalspalten. §5.1.
4. **Kein violetter/magentafarbener „KI"-Akzent.** Er kollidiert mit ANSI-Magenta im
   Agenten-Output — ein App-Signal darf nicht aussehen wie Inhalt.
5. **Keine Agenten-Statusanzeigen** („wartet auf dich" / „arbeitet"). Die Messung existiert
   nicht; ein geratener Status ist schlimmer als keiner, weil der Nutzer ihn zu glauben lernt.
6. **Kein Light Mode in v1.** §1.5.
7. **Keine Schatten zur Erhebung** außer am Modal. Ebenen entstehen aus Flächenhelligkeit.
8. **Keine Skeleton-Loader, keine Shimmer-Animation.** Eine SSH-Verbindung steht in unter zwei
   Sekunden oder meldet einen Fehler. Ein Skeleton wäre eine Lüge über die Wartezeit.
9. **Keine ausblendenden Scrollbalken im xterm-Viewport.** Bei 5000 Zeilen Scrollback ist der
   Balken eine Positionsanzeige. *Aufgehoben am 29.10.2026 (Entscheidung des Maintainers): Das
   Terminal hat keinen Scrollbalken mehr. Gescrollt wird mit dem Mausrad, durch Wischen oder in
   tmux; das Ziehen durch den Verlauf war ohne Nutzen. Die 14 px gehen an die Spalten
   (`terminal-fit.ts`).*
10. **Keine eigene Fensterdekoration / kein Frameless-Fenster mit nachgebauter Titelleiste.**
    Bricht Snap Layouts, Aero Snap, Fenster-Rundung und die Systemmenü-Konventionen von
    Windows 11 — für ein Werkzeug, das neben Explorer und Windows Terminal steht, ist das
    reiner Verlust.
11. **Keine Icon-only-Schaltflächen ohne Text oder Tooltip**, insbesondere nicht für Maximieren,
    Trennen und Schließen. Constraint 3 gilt auch für Aktionen, nicht nur für Zustände.
12. **Keine Transitions auf Layouteigenschaften** (`width`, `height`, `grid-template`, `flex`).
    Jeder Zwischenframe wäre ein `fit()`-Kandidat und damit ein `resize_terminal`-Risiko (V12).
    Erlaubt sind ausschließlich `opacity`, `color`, `background-color`, `border-color` mit
    ≤ 120 ms.

Und einer, der weniger offensichtlich ist: **keine `em`/`rem`-Typoskala.** Der WebView ist kein
Dokument. Feste px halten Kachelkopf, Zeilenhöhe und Zellmetrik in einer nachrechenbaren
Beziehung (§5.1) — genau die Beziehung, aus der die Spaltenzahlen folgen.

---

## Anhang A — Token-Block zum Einfügen

Ersetzt den `:root`-Block in `src/styles.css`.

```css
:root {
  /* --- Modus: Dark only. Siehe Designsystem §1.5. Diese Zeile steuert auch
         native <select>-Popups, Kontextmenues und den xterm-Viewport-
         Scrollbalken -- ohne sie blitzen sie hell auf. --- */
  color-scheme: dark;

  /* --- Flaechen --- */
  --ab-bg-canvas:   #0B0D10;
  --ab-bg-chrome:   #131619;
  --ab-bg-raised:   #191D22;
  --ab-bg-hover:    #1F242A;
  --ab-bg-active:   #262C34;
  --ab-bg-overlay:  #1B1F25;
  --ab-bg-scrim:    rgba(4, 6, 8, .66);

  /* --- Raender --- */
  --ab-border-subtle:  #21262D;
  --ab-border-default: #2C333B;
  --ab-border-strong:  #3A424C;

  /* --- Text --- */
  --ab-text-primary:   #E3E8EE;
  --ab-text-secondary: #A8B2BD;
  --ab-text-muted:     #7B8794;
  --ab-text-disabled:  #4A545F;

  /* --- Akzent und Fokus --- */
  --ab-accent:       #4C9AFF;
  --ab-accent-hover: #69ACFF;
  --ab-accent-quiet: #1B3255;
  --ab-focus-ring:   #A9D2FF;

  /* --- Semantik --- */
  --ab-ok:            #56D364;
  --ab-ok-bg:         #12291A;
  --ab-warn:          #E3B341;
  --ab-warn-bg:       #2A2314;
  --ab-warn-border:   #5C4A1F;
  --ab-danger:        #FF7B72;
  --ab-danger-bg:     #2A1517;
  --ab-danger-border: #5C2B2B;
  --ab-neutral-off:   #7B8794;

  /* --- Schrift --- */
  --ab-font-ui:       "Segoe UI Variable Text", "Segoe UI", system-ui, "Noto Sans", sans-serif;
  --ab-font-ui-small: "Segoe UI Variable Small", "Segoe UI", system-ui, sans-serif;
  --ab-font-mono:     "Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Mono", ui-monospace, monospace;

  --ab-fs-xs: 11px;  --ab-lh-xs: 14px;
  --ab-fs-sm: 12px;  --ab-lh-sm: 16px;
  --ab-fs-md: 13px;  --ab-lh-md: 18px;
  --ab-fs-lg: 15px;  --ab-lh-lg: 20px;
  --ab-fs-xl: 20px;  --ab-lh-xl: 26px;

  --ab-fw-regular: 400;
  --ab-fw-semibold: 600;

  /* --- Abstaende (Basis 4px) --- */
  --ab-space-0: 0;
  --ab-space-1: 2px;
  --ab-space-2: 4px;
  --ab-space-3: 6px;
  --ab-space-4: 8px;
  --ab-space-5: 12px;
  --ab-space-6: 16px;
  --ab-space-7: 20px;
  --ab-space-8: 24px;
  --ab-space-9: 32px;
  --ab-space-10: 48px;

  /* --- Masse --- */
  --ab-sidebar-w:     240px;
  --ab-sidebar-min-w: 180px;
  --ab-sidebar-max-w: 420px;
  --ab-toolbar-h:      40px;
  --ab-tile-head-h:    28px;
  --ab-row-h-host:     30px;
  --ab-row-h-session:  26px;
  --ab-control-h:      30px;
  --ab-button-h:       32px;
  --ab-tile-gap:        0px;

  /* --- Linien und Radien --- */
  --ab-border-w:     1px;
  --ab-focus-w:      2px;
  --ab-tile-focus-w: 3px;
  --ab-radius-sm:    3px;
  --ab-radius-md:    5px;
  --ab-radius-lg:    8px;
  --ab-radius-tile:  0;

  /* --- Erhebung: genau EIN Schatten im ganzen System --- */
  --ab-shadow-modal: 0 16px 48px rgba(0, 0, 0, .55);

  /* --- Bewegung: nur Farbe und Deckkraft, nie Layout --- */
  --ab-motion-fast: 100ms;
  --ab-motion-ease: cubic-bezier(.2, 0, .38, .9);

  /* --- Terminal-Metrik (muss zu AB_TERMINAL_THEME in terminal.ts passen) --- */
  --ab-term-font-size:   13px;
  --ab-term-line-height: 1.15;

  font-family: var(--ab-font-ui);
  font-size: var(--ab-fs-md);
  line-height: var(--ab-lh-md);
  color: var(--ab-text-primary);
  background-color: var(--ab-bg-canvas);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -webkit-text-size-adjust: 100%;
}

@media (prefers-reduced-motion: reduce) {
  :root { --ab-motion-fast: 0ms; }

  /* `:not(.xterm *)` ist hier KEINE Politur, sondern notwendig: xterm.js hat
     seit Version 6 keinen Canvas-Renderer mehr, und `src/terminal.ts` faellt
     ausdruecklich auf den DOM-Renderer zurueck (kein WebGL verfuegbar, oder
     `onContextLoss` disposed den Addon). Der DOM-Renderer blinkt den Cursor
     ueber eine CSS-`animation` -- ein globales `animation-duration: 1ms`
     wuerde genau diesen Cursor stilllegen. Der Terminalinhalt gehoert xterm,
     auch beim Bewegungs-Reset. */
  *:not(.xterm *), *:not(.xterm *)::before, *:not(.xterm *)::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

## Anhang B — Umsetzungsreihenfolge

1. `:root`-Block aus Anhang A einsetzen, `color-scheme: light dark` → `dark` (die aktuelle
   `src/styles.css` ist noch das Tauri-Template: `Inter`, `#f6f6f6`, 15 px — vollständig
   ersetzen).
2. `AB_TERMINAL_THEME` + Font-Optionen in `src/terminal.ts`s `new Terminal({...})`.
3. Grundgerüst: `#app` → `grid-template-columns: var(--ab-sidebar-w) 1fr`,
   `grid-template-rows: 1fr`. `#app-header` entfällt — die Toolbar sitzt in der rechten Spalte,
   der Sidebar-Kopf in der linken; beide `var(--ab-toolbar-h)`.
   **Achtung:** Der Kommentar am Kopf von `src/styles.css` gilt weiter — jeder Vorfahr von
   `#terminal-container` braucht eine explizite Höhe, sonst rechnet `fit()` gegen eine
   kollabierte Box. Bei Grid heißt das `min-height: 0` auf jedem Grid-Item in der Kette.
4. Fokusring-Regel (§6.4) global, bevor irgendeine Komponente gebaut wird.
5. Sidebar (§5.2) inkl. Sticky-Hostzeilen und Roving-Tabindex.
6. Kachelkopf mit Index-Badge und Zustands-Chip (§6.2, §8.4).
7. Rasterlogik (§5.3) und Maximieren (§7) — zusammen, weil beide denselben entprellten
   Refit-Pfad benutzen.
8. Leer- und Fehlerzustände (§8), zusammen mit den i18n-Schlüsseln aus §8.5.
9. Keymap-Erweiterung (§7.5): `KeymapAction` + `DEFAULT_KEYMAP` in `src/keymap.ts`, Spec-§7.4-
   Tabelle nachziehen. Kein Rust-Anteil.
