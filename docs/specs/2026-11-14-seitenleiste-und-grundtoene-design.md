# Seitenleiste einklappen, Marke im Fuß, sechs Grundtöne

**Datum:** 2026-11-14
**Anlass:** Der Auftraggeber möchte die Oberfläche schöner und in den Einstellungen mehr Auswahl für die Darstellung, die Seitenleiste mit der Maus einklappen können und unten die Marke ansprechender; die Commit-Kennung muss dort nicht stehen.
**Bezug:** UI-v2-Spec `specs/2026-09-05-ui-v2-design.md` (§7.2, §7.6); Farbwahl `specs/2026-09-14-farbwahl-design.md` (§1, §3, §6 bis §8); Raster `specs/2026-10-19-dynamisches-raster-design.md` (§8.5); UX-Spec `specs/2026-10-11-ux-ueberarbeitung-design.md` (§7.1, §9.1, §9.2); Android `specs/2026-10-27-android-design.md` (§5.1).

**Verhältnis zu den älteren Specs.** Dieses Dokument ergänzt Raster §8.5 um die Symbolleiste (das vollständige Ausblenden bleibt als Einstellung), ersetzt in UI v2 die Beschreibung des Fußes (`.sb-foot`, §7.6) und ändert in der Farbwahl die Zahl der Grundtöne von zwei auf sechs (§1, §3, §6, §7, §8). Alles andere dort gilt weiter.

## 1. Entscheidung

| Frage | Entscheidung |
|---|---|
| Einklappen | Ein Knopf im Fuß der Seitenleiste, derselbe Weg wie Strg+Umschalt+B |
| Eingeklappt | Eine 46 px breite Symbolleiste bleibt stehen; sie zeigt an und führt zurück |
| Einstellung | "Icon rail when collapsed" unter Appearance, Standard an; aus blendet wie bisher ganz aus |
| Fuß | Marke als Knopf: Zeichen im Akzent, Name, Version ohne Commit; öffnet About |
| Grundtöne | Vier neue: Midnight, Mocha, Plum, Pine; mit den sieben Akzenten 42 Varianten |
| Nicht dabei | Helles Thema, freie Farbwahl, Aktionen in der Symbolleiste (siehe §6) |

## 2. Einklappen und Symbolleiste

### 2.1 Der Knopf im Fuß

Rechts im Fuß der Seitenleiste steht ein Icon-Knopf (`panel-left-close`, Bauform `.sb-head-btn`, Klasse `.sb-collapse`) mit `aria-label` "Collapse sidebar" und dem Kürzel im `title`. Er ruft denselben Weg wie Strg+Umschalt+B (`setSidebarCollapsed`): Menü schließen, Ziehgriff verbergen, Terminals einmal anpassen, Arbeitsplatz speichern (`workspace.sidebar_collapsed`, UX-Spec §7.1).

Der Knopf verschwindet mit der Seitenleiste. Der Fokus geht deshalb auf sein Gegenstück in der Symbolleiste; ohne Symbolleiste in die fokussierte Kachel, wie nach dem Kürzel aus einem Terminal. Dasselbe gilt für Strg+Umschalt+B, wenn der Fokus in der Leiste steht, die das Kürzel wegnimmt: aus der Seitenleiste geht er auf den Ausklappknopf der Symbolleiste, aus der Symbolleiste auf den Einklappknopf. Stand er woanders, etwa in einem Terminal, bleibt er dort.

Der Knopf steht nur, solange die Symbolleiste eingeschaltet ist (§2.3). Ohne sie führt allein die Tastatur zurück, und ein Klick oder Tipp auf den Knopf nähme die Seitenleiste weg, ohne dass dieselbe Hand sie wiederbekäme, auf einem Tablet ohne Tastatur gar nicht mehr. `main.ts` setzt dafür `sidebar-no-rail` an `#app`, `styles.css` nimmt den Knopf heraus; Strg+Umschalt+B klappt weiter ein und aus.

In der kompakten Ansicht (Android-Spec §5.1) ist die Seitenleiste eine Schublade mit eigenem Schalter in der Kopfleiste. Dort gibt es weder den Knopf noch die Symbolleiste.

### 2.2 Die Symbolleiste

Ein eigenes Element `.sb-rail` (`views/sidebar-rail.ts`), Kind von `#app` hinter `#sidebar`. `main.ts` zeigt es genau dann, wenn die Seitenleiste eingeklappt ist und die Einstellung es will: Die Klasse `sidebar-rail` an `#app` kommt zu `sidebar-collapsed` hinzu und gibt dem Raster die Spalten `var(--ab-rail-w) 1fr`; `hidden` nimmt die Leiste sonst aus Boxbaum und Tab-Reihenfolge. Die Regeln von `sidebar-collapsed` aus Raster §8.5 bleiben unverändert. Mit Touch-Leiste reicht die Symbolleiste wie die Seitenleiste über beide Zeilen.

Aufbau von oben nach unten, alles Knöpfe von 32 px im Quadrat:

1. **Zähler der Wartenden**, nur wenn eine Session wartet: Raute und Zahl in den Farben der Waiting-Pille. Klick springt zur nächsten wartenden Session wie Strg+Umschalt+A.
2. **Hosts** in der Reihenfolge der Seitenleiste: das Kürzelquadrat der Hostzeile. Unten rechts die Zustandsform der Hostzeile (Online, Offline, Connecting, Failed; während des Neuverbindens die Form von Offline), oben rechts die Raute, wenn auf dem Host eine Session wartet. Der Host der fokussierten Kachel ist hinterlegt (`aria-current`); im Kontrastmodus trägt er wie die Sessionzeile eine gestrichelte Kontur in `Highlight`, weil die Hinterlegung dort entfällt. Klick klappt die Seitenleiste aus und setzt den Fokus auf die Zeile dieses Hosts. Bei vielen Hosts rollt dieser Teil ohne sichtbaren Balken (`scrollbar-width: none` und, für WebKit vor Safari 18.2, `::-webkit-scrollbar`).
3. **Unten:** Einstellungen (Zahnrad), Marke (öffnet About) und Ausklappen (`panel-left-open`) an der Stelle, an der ausgeklappt der Einklappknopf steht. Nach dem Ausklappen steht der Fokus auf dem Einklappknopf.

Die Leiste zeigt an und führt zurück. Verbinden, Sessions, Hinweise und Menüs bleiben in der Seitenleiste; Wege, die dort eine Antwort brauchen (Passwort, Passphrase, Hostschlüssel), klappen sie wie bisher auf.

**Zustand nie über Farbe allein.** In 32 px ist kein Platz für das Wort. Jeder Hostknopf trägt deshalb Form und Füllung sichtbar und den ganzen Satz als Namen und als `title`: "build-box: Online, 2 sessions", "gpu-lab: Online, 1 waiting", "home-nas: Offline". Die übrigen Knöpfe tragen ihren Namen ebenso, mit Kürzel im `title`.

**Kein Neuaufbau.** Die Seitenleiste baut ihre Liste bei jeder Benachrichtigung neu; ein Knopf, der zwischen Drücken und Loslassen aus dem Dokument fällt, bekommt in Chromium keinen Klick (gemessen am 13.11.2026). Die Symbolleiste behält je Host denselben Knopf und ändert nur Text und Attribute; umgehängt wird ein Knopf nur, wenn sich die Reihenfolge ändert. Verborgen zeichnet sie nicht mit und holt beim Zeigen auf.

### 2.3 Die Einstellung

Bereich Appearance, neue Karte **Sidebar** unter den Farben, Schalter **Icon rail when collapsed** mit dem Hinweis "Keeps a narrow strip with your hosts and their state when you collapse the sidebar. Off hides the sidebar completely and removes the collapse button; Ctrl+Shift+B hides the sidebar and brings it back." Das Kürzel kommt aus der aktiven Belegung.

Gespeichert als `sidebar_rail` unter `[ui]` in `settings.toml`, Standard `true`, über den vorhandenen Patch von `ui_settings` und die Feldtabelle (`state/ui-settings-sync.ts`, UX-Spec §9.2). Eine Datei ohne das Feld liest als an; ein älterer Build liest die Datei weiter und lässt das Feld beim nächsten Speichern weg, wie bei jedem Feld unter `[ui]`. Der Schalter wirkt sofort, auch auf eine gerade eingeklappte Seitenleiste hinter dem Dialog.

Aus ist das Verhalten bis 0.3.4: Die Seitenleiste verschwindet ganz, und zurück führt nur das Kürzel (oder Strg+Umschalt+E, das Schnellöffnen und jeder Weg, der sie von selbst aufklappt).

## 3. Marke im Fuß

`.sb-foot` ist eine Zeile hinter einer Haarlinie. Links ein Knopf `.sb-brand`, rechts der Einklappknopf (§2.1).

- **Zeichen** `.sb-brand-mark`: ein Quadrat von 18 px im Akzent mit dem Prompt-Zeichen `>_` (Icon `terminal`) in der Akzenttinte, das Motiv des App-Icons. Es folgt dem gewählten Akzent und ist Schmuck (`aria-hidden`).
- **Name** `aidevbridge`, 12 px halbfett. In einer schmalen Leiste kürzt zuerst der Name.
- **Version** `.sb-version` als umrandeter Chip mit Tabellenziffern: nur die Versionsnummer.

Die Commit-Kennung steht nicht mehr im Fuß. Sie bleibt unter About (Zeile "Commit", "Copy version info") und in jeder Zeile von "Copy diagnostics".

Ein Klick öffnet die Einstellungen auf **About** (`initialSection` des Einstellungsdialogs). `title` "About aidevbridge", `aria-label` "About aidevbridge, version …". Das Zahnrad im Kopf und Strg+, öffnen weiter den ersten Bereich. Bei 208 px, der schmalsten Seitenleiste, stehen Zeichen, Name, Version und Einklappknopf ungekürzt nebeneinander.

Die Seitenleiste hat damit zwei Tab-Halte mehr: Marke und Einklappknopf, hinter der Liste.

## 4. Sechs Grundtöne

Zu Graphite und Slate kommen vier Grundtöne. Sie folgen den Regeln der Farbwahl (§2 dort): fest, unabhängig vom Akzent, dunkle Flächen in fünf Stufen, Zustandsfarben unverändert. Ein Grundton heißt mit einem Wort ohne Bindestrich, weil die Themen-Id `<akzent>-<grundton>` an ihm getrennt wird.

| Token | Midnight | Mocha | Plum | Pine |
|---|---|---|---|---|
| `--ab-bg-canvas` | `#0C0D10` | `#181513` | `#17141C` | `#121816` |
| `--ab-bg-panel` | `#121418` | `#201C19` | `#1F1B26` | `#18201D` |
| `--ab-bg-card` | `#181B20` | `#282320` | `#272230` | `#1F2825` |
| `--ab-bg-hover` | `#1F2228` | `#302A26` | `#2E2939` | `#26302C` |
| `--ab-bg-active` | `#262A32` | `#38312C` | `#363043` | `#2D3934` |
| `--ab-text-primary` | `#ECEEF2` | `#F1EDE8` | `#EFECF4` | `#EAF0ED` |
| `--ab-text-secondary` | `#C5CBD4` | `#D4CCC3` | `#CFC9DA` | `#C4D0CA` |
| `--ab-text-muted` | `#8E96A3` | `#A1968B` | `#9B94AA` | `#8FA099` |
| `--ab-text-disabled` | `#565E69` | `#675E55` | `#665D73` | `#56645E` |
| `--ab-term-bg` | `#0A0B0D` | `#110F0D` | `#100E14` | `#0C110F` |
| `--ab-term-selection-inactive` | `#232830` | `#3A322C` | `#302B3B` | `#28332F` |

- **Midnight:** neutral und fast schwarz, für dunkle Räume und OLED-Bildschirme.
- **Mocha:** warmes Braungrau.
- **Plum:** violett getöntes Grau.
- **Pine:** grün getöntes Grau.

Die Terminalfläche bleibt bei jedem Grundton mindestens so hell wie `#0A0A0A`: Darunter verliert der Daumen des Scrollbalkens (`--ab-scrollbar`) seine 3:1 gegen die Fläche. Reines Schwarz gibt es deshalb nicht.

### 4.1 Gemessen (WCAG, je Grundton der schwächste der sieben Akzente)

| Paar | Graphite | Slate | Midnight | Mocha | Plum | Pine |
|---|---|---|---|---|---|---|
| Text auf Karte | 12,84 | 12,23 | 14,86 | 13,33 | 13,24 | 13,10 |
| Sekundärtext auf aktiver Fläche | 7,82 | 7,13 | 8,82 | 8,04 | 7,84 | 7,57 |
| Gedämpfter Text auf Hover | 4,85 | 4,79 | 5,34 | 4,88 | 4,83 | 4,97 |
| Gedämpfter Text auf Leinwand | 6,47 | 6,86 | 6,52 | 6,27 | 6,25 | 6,56 |
| Akzent auf Karte (Rot) | 5,11 | 4,97 | 5,97 | 5,38 | 5,35 | 5,23 |
| Waiting-Pille auf aktiver Fläche | 5,27 | 4,95 | 6,15 | 5,45 | 5,46 | 5,21 |
| Danger-Pille auf aktiver Fläche | 5,36 | 5,02 | 6,27 | 5,55 | 5,52 | 5,33 |
| Scrollbalken auf Terminalfläche | 3,09 | 3,09 | 3,03 | 3,08 | 3,07 | 3,08 |

Jeder neue Grundton liegt in diesen Paaren mindestens auf dem Niveau des schwächeren der beiden alten. `styles.test.ts` prüft alle Paare der Farbwahl für alle 42 Varianten.

### 4.2 Anwendung und Dialog

`BASES` in `theme.ts` nennt sechs Grundtöne; Ids, Speicherung und die alten Kurznamen `turquoise` und `slate` bleiben, wie sie sind (Farbwahl §4). `theme` ist in `settings.toml` eine freie Zeichenkette: Ein älterer Build kennt die neuen Ids nicht, zeigt den Hinweis auf ein unbekanntes Thema und fällt auf Türkis auf Graphit, ohne den gespeicherten Wert zu überschreiben, solange dort niemand eine Farbe wählt. `terminal.ts` trägt je Grundton die Werte der Terminalfläche; ein Test bindet sie an die Token.

Die Gruppe **Background** zeigt sechs Karten in drei Spalten, auf dem schmalen Telefon in zwei. Jede Karte erscheint wie bisher in ihrem eigenen Grundton, das vierte Quadrat zeigt den gewählten Akzent. i18n neu: `settings.background.midnight` "Midnight", `.mocha` "Mocha", `.plum` "Plum", `.pine` "Pine".

## 5. Tests

- `sidebar.test.ts`: Fuß mit Marke und Einklappknopf; Marke ohne Commit, öffnet About; Namen, `title`, Fokusschlüssel; die Knöpfe überleben das Neuzeichnen; sechs Tab-Halte.
- `sidebar-rail.test.ts`: Aufbau; je Host Kürzel, Form und Satz; Wartemarke und Zähler; `aria-current`; Neuverbinden; dieselben Knöpfe über Benachrichtigungen hinweg, auch wenn der erste Host wegfällt; verborgen zeichnet sie nicht mit; `focusExpand`; `dispose`.
- `main.test.ts`: Einklappen und Ausklappen über Knöpfe und Kürzel mit Fokus (auch: das Kürzel nimmt den Fokus mit, Einstellungen aus der Symbolleiste geben ihn nicht an einen verborgenen Knopf zurück, die Klasse `sidebar-no-rail`); Klick auf einen Host; gespeichert eingeklappt; `sidebar_rail = false`; der Schalter wirkt sofort und schreibt nur sein Feld; Marke und Zahnrad öffnen den richtigen Bereich.
- `settings-dialog.test.ts`, `settings-appearance.test.ts`: `initialSection`; Karte Sidebar mit Schalter und Kürzel; sechs Grundtonkarten.
- `ui-settings-sync.test.ts`, Rust (`settings.rs`, `commands/tests.rs`): `sidebar_rail` laden, prüfen, einzeln patchen, Standard an, Rundlauf durch die Datei.
- `styles.test.ts`: Kontrast aller 42 Varianten; Spalten mit Symbolleiste und ihre Reihenfolge nach `sidebar-collapsed`; Maße der Leiste; Fuß und Marke; kompakte Ansicht ohne Knopf und Leiste; drei Spalten der Grundtonkarten.
- `theme.test.ts`, `terminal.test.ts`: 42 Ids, Namen ohne Bindestrich, Terminalwerte je Variante an die Token gebunden.

## 6. Nicht in diesem Zuschnitt

- **Helles Thema.** Die Oberfläche ist seit UI v2 nur dunkel; ein helles Thema braucht eigene Zustandsfarben, Schatten, Terminalpalette und eine eigene Kontrastrunde.
- **Aktionen in der Symbolleiste** (verbinden, Session öffnen, Menü): Sie bräuchten dort Hinweisleisten und Rückfragen, für die 46 px nicht reichen.
- **Weitere Darstellungsoptionen** (Schriftart des Terminals, Cursorform, Dichte, gedimmte inaktive Kacheln, Größe der Oberfläche).
- **Bilder und README.** `docs/images` und die Zeile zu den Themen im README beschreiben das letzte Release und werden mit dem nächsten neu gerendert; `scripts/readme-images/render.mjs` schneidet das Bild der Farbwahl bereits passend zu.

## 7. Abnahme am Fenster

Am 14.11.2026 automatisiert im Headless-Browser gegen die Beispieldaten der README-Bilder geprüft, nicht im gebauten Fenster: Einklappen und Ausklappen über die Knöpfe (Terminals 615 px, 735 px und wieder 615 px breit), Fokus nach beiden Wegen, Schalter aus bei eingeklappter Seitenleiste (758 px, Leiste verborgen) und wieder an, Klick auf einen Host der Leiste (ausgeklappt, Fokus auf seiner Zeile), Marke öffnet About, Fuß bei 208 px ungekürzt, Telefon ohne Knopf und Leiste, Tablet-Maße mit Touch-Leiste (Symbolleiste über beide Zeilen, Touch-Leiste unter dem Raster), die vier neuen Grundtöne je einmal mit einem Akzent über die Schalter des Dialogs.

Offen von Hand:

1. Alle vier neuen Grundtöne bei laufenden Kacheln durchschalten: kein `resize_terminal`, Scrollposition und Auswahl bleiben (wie Farbwahl §8 Nr. 1).
2. Eingeklappt mit Symbolleiste: Zustandswechsel eines Hosts und eine neu wartende Session erscheinen in der Leiste; Tooltips lesbar.
3. Skalierung 100, 125, 150 Prozent: Formen auf den Ecken der Kürzel scharf, Marke mittig.
4. Bildschirmleser: Namen der Knöpfe in der Symbolleiste, Schalter unter Appearance.
5. Android-Tablet (nicht kompakt): Symbolleiste neben der Touch-Leiste am Gerät.
6. Windows-Kontrastdesign: gestrichelte Kontur am Host der fokussierten Kachel, Marke und Wartezähler erkennbar.
