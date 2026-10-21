# Farbwahl: Akzent × Grundton

**Datum:** 2026-09-14, Gutachten eines neutralen Agenten am selben Tag eingearbeitet
**Anlass:** Der Auftraggeber möchte die Oberfläche in seiner Lieblingsfarbe einstellen können, ausdrücklich auch in Rot, Grün und Violett, mit höchstens 16 Varianten. Die Einstellungen sollen später mehrere Bereiche bekommen; die Farbwahl ist dann einer davon.
**Bezug:** UI-v2-Spec `specs/2026-09-05-ui-v2-design.md` (§4, §5, §12, §16, §19); Designsystem v1 `specs/2026-07-27-agent-management-shell-designsystem.md` §9 Nr. 4.

**Verhältnis zur UI-v2-Spec.** Dieses Dokument ersetzt in UI v2 die Festlegung auf zwei Tokensätze (§2 Zeile "Farbwelt", §5.2/§5.3 als vollständige Themen), den Inhalt des Dialogs (§12.1), die Themenliste (§12.2) und die Zählung in §4 Grundsatz 4. Die Werte aus §5.2 und §5.3 bleiben als Anker unverändert gültig. Alles andere in UI v2 gilt weiter.

## 1. Entscheidung

| Frage | Entscheidung |
|---|---|
| Modell | Zwei Achsen: Akzent × Grundton, 7 × 2 = 14 Varianten |
| Akzente | Türkis (Standard), Blau, Violett, Pink, Rot, Orange, Grün |
| Grundtöne | Graphit (Standard), Schiefer; beide fest, unabhängig vom Akzent |
| Alte Themen | Türkis + Graphit ist exakt das heutige `turquoise`, Blau + Schiefer exakt das heutige `slate` |
| Nicht dabei | Gelb (entweder senffarben oder praktisch `--ab-warn`), Silber (Tönung gleicht `--ab-bg-hover`, Auswahl sähe aus wie Hover), akzentgetönte Grundtöne (werden bei warmen Tönen braun oder oliv) |

## 2. Regeln

1. **Zustandsfarben bleiben fest.** `--ab-ok`, `--ab-warn`, `--ab-danger`, `--ab-idle` samt Tönungen sind in allen 14 Varianten gleich. Zustände tragen weiter Form und Text (UI v2 §4 Grundsatz 3).
2. **Der Akzent trägt keinen Zustand mehr.** "Connecting" nutzt die festen, neutralen Token `--ab-connecting` und `--ab-connecting-bg`: Punkt `.ind-connecting` (auch die statische Fassung unter `prefers-reduced-motion`) und Pille `.state-pill--connecting`. UI v2 §4 Grundsatz 4 zählt damit vier Dinge: Fokus und Auswahl, Primäraktion, Nummernchip der fokussierten Kachel, Terminalcursor.
3. **Der Fokusring ist neutral und fest** (`--ab-focus-ring` im gemeinsamen Block). Ein blassroter oder blassgelber Ring sähe aus wie ein Fehlerrand (UI v2 §11.3) oder wie `--ab-warn`.
4. **Gefahr-Knöpfe tragen ein Warndreieck.** `.btn--danger` zeigt in allen Varianten `triangle-alert` vor dem Text, als CSS-Maske in `currentColor` im 16-px-Kasten. Grund: Im Fingerabdruck-Dialog stehen Reject (Gefahr) und Accept (primär) nebeneinander; bei rotem Akzent darf die Sicherheitsentscheidung nicht allein an "gefüllt gegen umrandet" hängen.
5. **Entsättigte Tönungen, wo der Akzent einem Zustand zu nahe käme.** Rot und Pink: Auswahltönung `--ab-accent-soft` entsättigt. Rot: Kürzelquadrat fast neutral. Rot und Grün: Terminalauswahl fast neutral, weil Agenten-Diffs selbst rote und grüne Hintergründe zeigen.
6. **Das Violett-Verbot fällt** (v1 §9 Nr. 4). Der Akzent erscheint im Terminal nur als Cursor und Auswahl. Türkis liegt heute schon so nah an ANSI-Cyan (ΔE_OK 0,055) und Blau an ANSI-Blau (0,021) wie Violett an ANSI-Magenta (0,094). Der Violett-Ton sitzt bei h 288, weg vom Magenta (h 306).
7. **Bewusst akzeptierte Nähen**, dokumentiert statt getestet: Grün ≈ ok (ΔE der Tönungen 0,016), Blau ≈ idle (0,021), Türkis ≈ ok (0,024), Rot/Pink/Orange ≈ danger (0,020–0,022). Grün und Blau sind ausdrücklich gewünscht; Türkis ≈ ok ist der Stand seit UI v2.
8. **Native Bedienelemente folgen dem Akzent** (`accent-color: var(--ab-accent)` am `:root`).

## 3. Token

`src/styles.css` teilt die Farben in drei Arten von Blöcken:

- **`:root`** – alles Gemeinsame wie bisher (Zustände, Linien, Scrollbalken, Maße, Schrift, Bewegung), neu `--ab-focus-ring`, `--ab-connecting`, `--ab-connecting-bg` und `accent-color`.
- **Grundton** – `:root, [data-base="graphite"]` und `[data-base="slate"]`: `--ab-bg-canvas`, `-panel`, `-card`, `-hover`, `-active`, `--ab-text-primary`, `-secondary`, `-muted`, `-disabled`, `--ab-term-bg`, `--ab-term-selection-inactive`.
- **Akzent** – `:root, [data-accent="turquoise"]` bis `[data-accent="green"]`: `--ab-accent`, `-hover`, `-ink`, `-soft`, `--ab-avatar-bg`, `-fg`, `--ab-term-selection`.

Jeder Grundton-Block nennt genau dieselben Token, jeder Akzent-Block ebenso. Die Selektoren gelten auch unterhalb von `<html>`: Der Dialog zeigt jede Farbe über `data-accent` bzw. `data-base` am Element selbst und braucht dafür keine zweite Kopie der Werte.

### 3.1 Feste Werte

| Token | Wert |
|---|---|
| `--ab-focus-ring` | `#E6EAF0` |
| `--ab-connecting` / `-bg` | `#DCE3EC` / `rgba(220,227,236,.10)` |
| `--ab-term-selection-inactive` | Graphit `#2A323D`, Schiefer `#283349` (die heutigen Werte) |

Graphit trägt die heutigen `:root`-Flächen und -Texte (§5.2), Schiefer die heutigen `slate`-Werte (§5.3).

### 3.2 Akzente (Startwerte nach UI v2 §19)

| Akzent | accent | hover | ink | soft | avatar bg / fg | term-selection |
|---|---|---|---|---|---|---|
| turquoise | `#2DD4BF` | `#5EE3D2` | `#0F172A` | `rgba(45,212,191,.13)` | `#1F3A44` / `#7EE8DC` | `#2B4A52` |
| blue | `#6FA8FF` | `#92BDFF` | `#0B1220` | `rgba(111,168,255,.14)` | `#233656` / `#A9C8FF` | `#2B3E5C` |
| violet | `#A193FC` | `#B2A9FE` | `#151325` | `rgba(161,147,252,.13)` | `#34324B` / `#CECAFF` | `#403D58` |
| pink | `#F180B5` | `#F79BC4` | `#220F18` | `rgba(194,160,174,.13)` | `#472C38` / `#FFBAD7` | `#543743` |
| red | `#F66C69` | `#FA8B85` | `#240F0E` | `rgba(179,151,148,.13)` | `#403130` / `#EDC6C3` | `#493E3D` |
| orange | `#FA9947` | `#FFB277` | `#221205` | `rgba(250,153,71,.13)` | `#472F1D` / `#FEC396` | `#533B29` |
| green | `#59D483` | `#85E19F` | `#081B0E` | `rgba(89,212,131,.13)` | `#233C2A` / `#A5E3B4` | `#3B443D` |

**Methode.** OKLCH, Türkis und Blau als unveränderte Anker. Die neuen Akzente liegen bei L 0,70–0,78 und C 0,15–0,17. Statt gleicher Helligkeit gilt ein Kontrastband: Tinte/Akzent mindestens 6,3, Akzent/Karte mindestens 4,9 auf beiden Grundtönen. Hover: L +0,055, C × 0,8. Tinte: L 0,20, C 0,035 im Akzentton. Tönung 13 %, bei Pink aus C × 0,3, bei Rot aus C × 0,2. Das Rechenskript lag im Scratchpad der Sitzung und ist nicht Teil des Repos; die Tests unten sichern das Ergebnis.

### 3.3 Gemessen (WCAG, schwächerer der beiden Grundtöne)

| Akzent | Tinte/Akzent | Akzent/Karte | sekundär/Tönung | Kürzel | ΔE Tönung ~ Hover |
|---|---|---|---|---|---|
| turquoise | 9,59 | 7,72 | 6,99 | 8,28 | 0,042 |
| blue | 7,78 | 5,97 | 7,10 | 7,15 | 0,035 |
| violet | 7,03 | 5,54 | 7,33 | 7,93 | 0,029 |
| pink | 7,39 | 5,81 | 7,23 | 7,87 | 0,032 |
| red | 6,32 | 4,97 | 7,40 | 7,92 | 0,027 |
| orange | 8,40 | 6,65 | 7,26 | 7,95 | 0,047 |
| green | 9,52 | 7,64 | 6,99 | 8,14 | 0,047 |

## 4. Speicherung

`settings.toml` behält `[ui] theme` als einen String (UI v2 §12.3); Rust bleibt unverändert. Gültige Ids:

- `turquoise` = Türkis + Graphit, `slate` = Blau + Schiefer. Beide Namen werden auch **geschrieben**, damit ältere Builds sie weiter lesen.
- sonst `<akzent>-<grundton>`, zum Beispiel `red-graphite`, `turquoise-slate`, `blue-graphite`.
- `turquoise-graphite` und `blue-slate` sind keine gültigen Ids. Wie jeder andere unbekannte Wert führen sie zum Hinweis im Dialog und zu Türkis.

Der `localStorage`-Vorlauf (§12.5) nutzt denselben Parser.

## 5. Anwendung

- `src/theme.ts`: `ACCENTS`, `BASES`, `THEMES` (die 14 Ids), `themeIdOf(accent, base)`, `themeParts(id)`. `applyTheme(id)` setzt immer beide Attribute `data-accent` und `data-base` an `<html>`; `data-theme` entfällt. `isThemeId`, `normalizeTheme`, `currentTheme`, `onThemeApplied` und `readCachedTheme` behalten ihre Signatur, `src/main.ts` bleibt unverändert.
- `src/terminal.ts`: Flächen je Grundton (`background`, `cursorAccent`, `selectionInactiveBackground`, Daumen hover/aktiv), je Akzent (`cursor` = Akzent, `selectionBackground`). `terminalTheme(id)` setzt beides zusammen. Der Wechsel läuft wie in §5.5 ohne `fit()` und ohne `resize_terminal`.

## 6. Dialog (ersetzt den Inhalt von UI v2 §12.1)

- Bereich **Appearance** als `<section>` mit Überschrift. Eine Bereichsnavigation gibt es erst mit dem zweiten Bereich.
- Gruppe **Accent color**: sieben runde Farbfelder als native Radios (`name="accent"`, visuell versteckt). Jedes Feld trägt `title` und `aria-label` mit dem Namen. Das gewählte Feld bekommt einen neutralen Ring und ein Häkchen in der Akzenttinte. Rechts neben den Feldern steht der Name des gewählten Akzents als Text.
- Gruppe **Background**: zwei Karten Graphite und Slate als native Radios (`name="base"`). Jede Karte zeigt drei Farbquadrate (Canvas, Panel, Karte) und den Namen. Die gewählte Karte bekommt Akzentkontur 2 px, Häkchen und Name 600, wie bisher.
- Zwei Radiogruppen ergeben zwei Tabstopps. `change` wendet sofort an, geschrieben wird entprellt nach 150 ms, der Hinweis bei unbekanntem Wert bleibt, alles wie bisher.
- i18n neu: `settings.accent` "Accent color", `settings.background` "Background", `settings.accent.<id>` Turquoise/Blue/Violet/Pink/Red/Orange/Green, `settings.background.graphite` "Graphite", `settings.background.slate` "Slate". `settings.theme.turquoise` und `settings.theme.slate` entfallen.

## 7. Tests

- `theme.test.ts`: 14 Ids, Parser, alte Namen beim Schreiben, Attribute, unbekannte Werte.
- `settings-dialog.test.ts`: zwei Gruppen mit je genau einem gewählten Radio; Namen, `aria-label`, `title`; die Id setzt sich aus beiden Gruppen zusammen; Entprellung; Hinweis.
- `styles.test.ts`: Kontrast für alle 14 Kombinationen. Das Paar "Akzent auf Akzent-Tönung" entfällt, weil es nur die Connecting-Pille beschrieb; die neuen Connecting-Paare stehen in einer eigenen Liste. Jeder Grundton- und Akzentblock nennt dieselben Token. `.btn--danger` trägt das Warndreieck.
- `terminal.test.ts`: Werte je Kombination und Bindung an die Token, jetzt einschließlich Auswahl.
- `main.test.ts`: Attribute statt `data-theme`; die Fokusfalle zählt zwei Radios, je Gruppe das gewählte.

## 8. Abnahme am Fenster

1. Alle 14 Varianten einmal durchschalten, bei laufenden Kacheln: kein `resize_terminal`, Scrollposition und Auswahl bleiben (UI v2 §17.5).
2. Fokusring überall sichtbar, auch auf Primärpillen.
3. Connecting beim Verbinden eines Hosts: Punkt und Pille neutral, vom ruhenden "Disconnected" klar zu unterscheiden.
4. Fingerabdruck-Dialog mit rotem Akzent: Reject mit Warndreieck, Accept gefüllt.
5. Skalierung 100, 125, 150 Prozent: Farbfelder rund, Häkchen mittig, Warndreieck auf der Textmitte.

## 9. Nicht in diesem Zuschnitt

Bereichsnavigation und weitere Einstellungen, freier Farbwähler, eigene Terminalpaletten, helles Thema.
