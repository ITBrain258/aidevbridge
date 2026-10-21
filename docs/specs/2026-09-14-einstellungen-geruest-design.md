# Einstellungen: Grundgerüst mit Bereichen

Stand 2026-09-14. Baut auf der Farbwahl-Spec (`2026-09-14-farbwahl-design.md`, §6
Dialog) auf und ersetzt deren Dialogaufbau; Verhalten und Speicherung der
Farbwahl bleiben, wie sie dort stehen. Die Entwürfe hat der Nutzer im
Browser-Begleiter gewählt: Karten-Stil (B) und Tasten einzeln (B).

## 1. Entscheidungen

1. Der Einstellungsdialog bekommt links eine Navigation mit Bereichen und rechts
   den Inhalt, wie bei Termius.
2. Der Inhalt steht in Karten auf einem dunkleren Grund. Jedes Thema ist eine
   Karte mit Titel, es gibt keinen Seitentitel.
3. Zum Start gibt es drei Bereiche: Appearance, Shortcuts, About. In der Liste
   steht nur, was Inhalt hat, keine Platzhalter und kein "Coming soon".
4. Shortcuts ist eine reine Übersicht. Eigene Belegungen kommen später. Jetzt
   entsteht nur die Infrastruktur dafür (§6.2).
5. Die Übersicht zeigt jede Taste als eigenen Chip. Werkzeugleiste und leere
   Kachelfläche behalten den kompakten Chip `Ctrl+Shift+N`: ein Kurzhinweis im
   Text ist etwas anderes als eine Nachschlagetabelle.
6. Nur Frontend. Kein Rust, kein neuer Befehl, `settings.toml` unverändert.

## 2. Dialog

- **Größe:** `openDialog` in `main.ts` bekommt die Option `large`, die dem
  Panel die Klasse `dialog-panel--large` gibt. Breite
  `min(760px, calc(100vw - 2 * var(--ab-space-6)))`, Höhe fest
  `min(540px, calc(100vh - 2 * var(--ab-space-8)))`. Die feste Höhe verhindert,
  dass der Dialog beim Wechsel des Bereichs springt. Die Größe gehört der Hülle,
  wie schon `wide` (UI-v2-Spec 11.1).
- **Kopf:** wie jeder Dialog, Titel `settings.title` "Settings" und
  Schließen-Knopf. Escape, Fokusfalle und `inert` liefert die Hülle.
- **Körper:** `.dialog-panel--large .dialog-body` hat kein Polster und scrollt
  nicht selbst. Darin liegt `.settings-view` als Raster `200px 1fr` über die
  volle Höhe.
- **Navigation** (`.settings-nav`): Grund `--ab-bg-panel`, Trennlinie rechts
  `--ab-line`, Innenabstand 8, Einträge untereinander mit Abstand 2.
  - Eintrag (`.settings-tab`): Höhe 32, Polster `0 12px`, Radius
    `--ab-radius-sm`, Text 13/18 `--ab-text-secondary`, linksbündig.
  - Hover: `--ab-bg-hover`.
  - Gewählt (`aria-selected="true"`): Grund `--ab-accent-soft`, Text
    `--ab-text-primary`, wie die gewählte Session in der Seitenleiste.
  - Fokusring innen (`outline-offset: -2px`), damit ihn die Spalte nicht
    beschneidet.
- **Inhalt** (`.settings-panel`): Grund `--ab-bg-canvas`, Polster 20, scrollt
  senkrecht. Scrollbalken wie `.dialog-body` (8 px, `--ab-scrollbar`). Hat das
  Panel selbst den Fokus, steht der Fokusring innen.
- **Karte** (`.settings-card`): Grund `--ab-bg-card`, Rahmen `--ab-line`, Radius
  `--ab-radius-lg`, Polster 16, Abstand zur nächsten Karte 12.
  - Titel (`.settings-card-title`): 13/18 semibold `--ab-text-primary`, darunter
    12 Abstand, bei Karten mit Zeilen 4.
  - Hinweis (`.settings-card-note`): 12/16 `--ab-text-muted`.
- **Zeilen** (`dl.settings-rows > div.settings-row > dt + dd`):
  - Mindesthöhe 32, Beschriftung links in `--ab-text-secondary`, Wert oder
    Tasten rechts.
  - Zwischen den Zeilen eine Trennlinie `--ab-line`.
  - `dt` und `dd` ohne Standardabstände.

## 3. Navigation und Tastatur

Muster "Tabs" nach WAI-ARIA APG, senkrecht, mit automatischer Aktivierung. Das
passt hier, weil jeder Bereich sofort und ohne Laden erscheint.

- `div.settings-nav[role="tablist"][aria-orientation="vertical"]` mit
  `aria-label` = `settings.sections` "Settings sections".
- Je Bereich ein `button.settings-tab[role="tab"]`:
  - `id="settings-tab-<id>"` und `aria-controls="settings-panel"`.
  - `aria-selected`: `true` am gewählten, `false` an den anderen.
  - `tabindex`: `0` am gewählten, `-1` an den anderen.
- `div.settings-panel[role="tabpanel"]` mit `id="settings-panel"`,
  `aria-labelledby` = Id des gewählten Tabs und `tabindex="0"`. So lässt sich
  ein Bereich ohne Bedienelemente (Shortcuts) mit der Tastatur scrollen.
- **Tasten auf einem Tab:**
  - Pfeil runter/hoch wählt den nächsten/vorigen Tab mit Umlauf und fokussiert
    ihn.
  - Home/End wählt den ersten/letzten.
  - Klick wählt.
- **Wechsel:** Der alte Bereich wird mit `dispose()` entsorgt, der neue
  gemountet, `aria-labelledby` umgehängt und das Panel nach oben gescrollt. Der
  Fokus bleibt auf dem Tab.
- **Öffnen:** immer auf "Appearance". Der Fokus geht wie bei jeder Hülle
  zuerst auf den Schließen-Knopf.
- **Tab-Reihenfolge:** Schließen → gewählter Tab → Panel → Bedienelemente des
  Bereichs.
- **Bekannte Grenze:** `focusableElements` (`main.ts`) zählt Knöpfe unabhängig
  von `tabindex`, also auch die nicht gewählten Tabs. Das ist hier harmlos,
  weil die Falle nur das erste und das letzte Element benutzt und ein Tab nie
  an einem Ende steht: vorne steht Schließen, hinten das Panel oder sein
  Inhalt. `focusableElements` bleibt unverändert, weil die Seitenleiste die
  Funktion ebenfalls benutzt.

## 4. Aufbau im Code

| Datei | Inhalt |
|---|---|
| `src/views/settings-dialog.ts` | Rahmen. `mountSettingsDialog(container, opts)` mit unveränderter Signatur. `SettingsDialogOptions` bekommt `keymap?: Readonly<Record<KeymapAction, string>>`, Standard `DEFAULT_KEYMAP`. Die Liste `SETTINGS_SECTIONS` enthält Einträge `{ id, labelKey, mount(container, opts) }`. Ein neuer Bereich ist ein Eintrag plus eine Datei. |
| `src/views/settings-appearance.ts` | Der heutige Inhalt als `mountAppearanceSection(container, opts)`. |
| `src/views/settings-shortcuts.ts` | Katalog, `bindingKeys()` und `mountShortcutsSection(container, keymap)`. |
| `src/views/settings-about.ts` | `mountAboutSection(container)`. |
| `src/version.ts` | Zusätzlich `appVersion()` und `appCommit()`. `appVersionLine()` baut auf beiden auf. |
| `src/main.ts` | `openDialog` bekommt die Option `large`, `onOpenSettings` übergibt `{ large: true }`. Sonst nichts. |

Jede Datei hat ihre eigene kleine `t()`-Funktion, wie die übrigen Ansichten.
Jeder Bereich liefert `{ dispose(): void }`. `dispose()` des Rahmens entsorgt
den offenen Bereich und entfernt den Rahmen.

## 5. Appearance

- Zwei Karten, "Accent color" und "Background".
- In jeder Karte bleibt das `fieldset.settings-group` mit seiner `legend`. Die
  Legende wird zum Kartentitel: 13/18 semibold primär statt 11 px Versalien
  gedämpft.
- Die Karte ist ein `div.settings-card` um das fieldset. Ein fieldset mit
  eigenem Rahmen würde die Legende auf die Rahmenlinie setzen.
- `section.settings-section` und `h3.settings-section-title` entfallen, das
  Panel ist über seinen Tab beschriftet.
- Der Hinweis bei unbekanntem Thema (`settings.themeUnknown`) steht wie bisher
  unter den Karten.
- Verhalten unverändert (Farbwahl-Spec §6):
  - `onThemeChange` sofort.
  - `onPersist` nach 150 ms Ruhe, spätestens bei `dispose()`. Ein Wechsel des
    Bereichs schreibt deshalb einen offenen Wert sofort.

## 6. Shortcuts

### 6.1 Inhalt

Über den Karten steht ein Satz in 12/16 `--ab-text-muted`
(`settings.shortcuts.intro`): "App shortcuts always use Ctrl+Shift. Every other
key goes to the terminal unchanged, including Ctrl+C."

| Karte | Zeile (Text) | Quelle |
|---|---|---|
| Sessions | New session | `session.new` |
| | Open previous session | `session.prev` |
| | Open next session | `session.next` |
| | Jump to next waiting session | `session.nextWaiting` |
| Terminals and layout | Focus terminal 1–4 | Bereich `session.select.1` bis `.4` |
| | Maximize or restore terminal | `tile.maximize` |
| | Restore from outside the terminal | fest: `Esc` |
| | Switch layout (1, 2, 4 terminals) | `grid.cycle` |
| Sidebar | Show or hide sidebar | `sidebar.toggle` |
| | Move focus to sidebar | `sidebar.focus` |
| Inside a terminal, Hinweis "Only while a terminal has focus." | Copy selection | `clipboard.copy` |
| | Paste | `clipboard.paste` |
| | Search | `search.local` |
| | Close terminal (session keeps running) | `session.close` |

Ausgeblendet sind `session.select.5` bis `.9`: Es sind höchstens vier Kacheln
sichtbar, die Kürzel tun also nichts.

### 6.2 Infrastruktur für eigene Belegungen

- **Katalog:** `SHORTCUT_GROUPS` (Karten mit Zeilen) und `HIDDEN_SHORTCUTS`.
  Zeilenarten:
  - `action`: eine Aktion.
  - `range`: mehrere Aktionen in einer Zeile. Gezeigt werden die Modifikatoren
    der ersten und dann "erste–letzte" Taste, zum Beispiel `1–4`. Der Bereich
    muss zusammenhängen; ein späterer Editor zeigt die Aktionen einzeln.
  - `fixed`: Tasten, die nicht aus der Belegung kommen (`Esc`). Sie sind auch
    später nicht belegbar.
- **Belegung als Eingabe:** Die Tasten kommen aus der übergebenen Tabelle
  `keymap`, nie direkt aus `DEFAULT_KEYMAP`. `main.ts` übergibt heute nichts,
  also gilt der Standard. Das ist dasselbe Muster wie
  `matchAction(event, bindings = DEFAULT_KEYMAP)`.
- **Tasten zerlegen:** `bindingKeys("Ctrl+Shift+N")` liefert
  `["Ctrl", "Shift", "N"]`, ohne Leerzeichen und leere Teile.
- **Vollständigkeit:** Ein Test prüft, dass jede `KeymapAction` genau einmal im
  Katalog oder in `HIDDEN_SHORTCUTS` steht. Ein neues Kürzel kann in der
  Übersicht nicht fehlen.
- **Nicht jetzt:**
  - Abschnitt `[keymap]` in `settings.toml` lesen und mit dem vorhandenen
    `validate()` prüfen.
  - Die Tabelle an `main.ts`, `terminal.ts` und `grid.ts` reichen.
  - Editor mit Aufnahme, Konfliktanzeige und Zurücksetzen.
  - Klären, ob Buchstaben nach Zeichen oder nach Position zählen: heute zählen
    Buchstaben nach Zeichen, Ziffern nach Position.

### 6.3 Darstellung der Tasten

- Jede Taste ist ein `<kbd>` in `span.settings-keys` (Abstand 4). Screenreader
  lesen die Tasten der Reihe nach vor.
- In den Einstellungen gilt ein eigener Chip (`.settings-keys kbd`):
  - Maße: Höhe 20, Mindestbreite 20, Inhalt mittig, Polster `0 6px`.
  - Farben: Grund `--ab-bg-hover`, Rahmen `--ab-line-strong` mit 2 px
    Unterkante, Radius `--ab-radius-xs`.
  - Text: 11/14 in `--ab-text-secondary`, Kleinschrift.
- Der globale `kbd` (Werkzeugleiste, Leerzustand) bleibt unverändert.
- Die Bereichstaste zeigt `1–4` mit Halbgeviertstrich.

## 7. About

- Eine Karte. Titel ist `app.title` "AgentBridge"; eine Umbenennung ändert ihn
  dort.
- Zeilen:
  - Version: `appVersion()`.
  - Commit: `appCommit()`, in `--ab-font-mono` 12 px.
  - License: "MIT or Apache-2.0", wie in `package.json`.
- Knopf `btn btn--secondary` mit Icon `copy` und Text "Copy version info".
  - Ein Klick schreibt `appVersionLine()` in die Zwischenablage. Das ist genau
    die Zeile, mit der auch "Copy diagnostics" beginnt.
  - Gelingt das, zeigt der Knopf 2000 ms lang "Copied" und dann wieder seinen
    Text. Ein erneuter Klick startet die Zeit neu.
  - Ein Fehler bleibt still, wie bei "Copy diagnostics".
  - `dispose()` löscht den Zeitgeber.
- Eine Liste der Fremdlizenzen gehört nicht in diesen Zuschnitt (§12).

## 8. Texte (`src/i18n/en.json`)

Neue Schlüssel:

| Schlüssel | Text |
|---|---|
| `settings.sections` | Settings sections |
| `settings.shortcuts` | Shortcuts |
| `settings.shortcuts.intro` | App shortcuts always use Ctrl+Shift. Every other key goes to the terminal unchanged, including Ctrl+C. |
| `settings.shortcuts.group.sessions` | Sessions |
| `settings.shortcuts.group.terminals` | Terminals and layout |
| `settings.shortcuts.group.sidebar` | Sidebar |
| `settings.shortcuts.group.terminal` | Inside a terminal |
| `settings.shortcuts.group.terminal.note` | Only while a terminal has focus. |
| `settings.shortcut.session.new` | New session |
| `settings.shortcut.session.prev` | Open previous session |
| `settings.shortcut.session.next` | Open next session |
| `settings.shortcut.session.nextWaiting` | Jump to next waiting session |
| `settings.shortcut.session.select` | Focus terminal 1–4 |
| `settings.shortcut.tile.maximize` | Maximize or restore terminal |
| `settings.shortcut.tile.restoreEsc` | Restore from outside the terminal |
| `settings.shortcut.grid.cycle` | Switch layout (1, 2, 4 terminals) |
| `settings.shortcut.sidebar.toggle` | Show or hide sidebar |
| `settings.shortcut.sidebar.focus` | Move focus to sidebar |
| `settings.shortcut.clipboard.copy` | Copy selection |
| `settings.shortcut.clipboard.paste` | Paste |
| `settings.shortcut.search.local` | Search |
| `settings.shortcut.session.close` | Close terminal (session keeps running) |
| `settings.about` | About |
| `settings.about.version` | Version |
| `settings.about.commit` | Commit |
| `settings.about.license` | License |
| `settings.about.licenseValue` | MIT or Apache-2.0 |
| `settings.about.copy` | Copy version info |
| `settings.about.copied` | Copied |

`settings.appearance` bleibt und ist jetzt die Beschriftung des Tabs.

## 9. Kontraste

Drei neue Paare im Test "Kontrast aller 14 Farbvarianten" (`styles.test.ts`):

| Vordergrund | Fläche | Tönung | Mindestwert | Wofür |
|---|---|---|---|---|
| `--ab-text-primary` | `--ab-bg-panel` | `--ab-accent-soft` | 4,5 | gewählter Tab |
| `--ab-text-muted` | `--ab-bg-canvas` | – | 4,5 | Einleitungssatz |
| `--ab-focus-ring` | `--ab-bg-canvas` | – | 3,0 | Fokus auf dem Panel |

Schon abgedeckt sind:

- `--ab-text-secondary` auf `--ab-bg-hover` (Tastenchip),
- `--ab-text-muted` auf `--ab-bg-card` (Kartenhinweis),
- `--ab-text-secondary` auf `--ab-bg-card` (Zeilen).

## 10. Tests

- **`settings-dialog.test.ts` (Rahmen):**
  - Drei Tabs in der Reihenfolge Appearance, Shortcuts, About.
  - Der erste ist gewählt, das Panel zeigt Appearance.
  - Nur der gewählte Tab hat `tabindex="0"`, `aria-controls` und
    `aria-labelledby` sind verdrahtet.
  - Klick wechselt und entsorgt den alten Bereich: ein offener Themenwert wird
    sofort geschrieben.
  - Pfeil runter/hoch mit Umlauf, Home/End.
  - `dispose()` entsorgt den offenen Bereich und leert den Container.
  - Eine übergebene `keymap` erreicht die Übersicht.
- **`settings-appearance.test.ts`:** Die acht Tests aus dem heutigen
  `settings-dialog.test.ts` wandern hierher. Statt der `h3` werden die
  Kartentitel geprüft, und jede Gruppe muss in einer `.settings-card` liegen.
- **`settings-shortcuts.test.ts`:**
  - Der Katalog ist vollständig (§6.2).
  - `bindingKeys`.
  - Die vier Karten mit Titeln, Zeilen und Hinweis.
  - Die Tasten folgen einer übergebenen Tabelle.
  - Die Bereichszeile zeigt `Ctrl`, `Shift`, `1–4`, die feste Zeile `Esc`.
  - Der Einleitungssatz.
- **`settings-about.test.ts`:**
  - Version und Commit aus den Testkonstanten (`0.0.0-test`, `test`) und die
    Lizenz.
  - Der Knopf kopiert `appVersionLine()`, zeigt "Copied" und nach 2000 ms
    wieder seinen Text.
  - Ein Fehler bleibt still.
  - `dispose()` löscht den Zeitgeber.
- **`version.test.ts`:** `appVersion()` und `appCommit()`.
- **`main.test.ts`:**
  - Der Einstellungsdialog hat `dialog-panel--large`, der Sessiondialog nicht.
  - Die bestehenden Tests für Zahnrad, Escape und Fokusfalle bleiben grün.
- **`styles.test.ts`:**
  - `.dialog-panel--large` mit 760 und 540 und der Körper ohne Polster.
  - Gewählter Tab auf `--ab-accent-soft`, Fokusring innen.
  - Das Panel auf `--ab-bg-canvas` und scrollbar.
  - Der Tastenchip in den Einstellungen.
  - Die Kontrastpaare aus §9.

Jeder Commit ist grün (Vitest und `tsc`).

## 11. Abnahme am Fenster

Bei 100, 125 und 150 % Windows-Skalierung:

1. Die Texte der Navigation sitzen mittig in ihren 32-px-Zeilen, die Tasten
   mittig in ihren Chips, und die Karten stehen bündig.
2. Beim Wechsel des Bereichs springt der Dialog nicht. Shortcuts scrollt innen,
   und ein anderer Bereich beginnt danach wieder oben. Das prüft nur das
   Fenster, weil jsdom kein Layout kennt.
3. Tastatur: Tab-Reihenfolge wie in §3, Pfeile, Home/End, Escape schließt.
4. Eine Farbe in Appearance wirkt sofort und ist nach einem Bereichswechsel und
   einem Neustart gespeichert.
5. "Copy version info", dann Einfügen in einen Editor ergibt
   `agentbridge <Version> (<Commit>)`.
6. Bei einem kleinen Fenster schrumpft der Dialog, statt überzustehen.

## 12. Nicht im Zuschnitt

- Eigene Kürzel samt Speicherung, Editor, Konflikten und Zurücksetzen (§6.2).
- Einzelne Tastenchips in Werkzeugleiste und Leerzustand.
- Eine Liste der Fremdlizenzen. Sie gehört vor dem Release automatisch erzeugt.
- Den zuletzt offenen Bereich merken.
- Weitere Bereiche (Terminal, Schlüssel, Logs). Sie kommen jeweils mit ihrem
  Inhalt.
- `focusableElements` auf `tabindex` umstellen (§3).

## 13. Branch und die andere Session

- Der Branch `einstellungen` setzt auf `farbwahl` auf und liegt in einem eigenen
  Worktree.
- Die Änderungen, die andere Dateien berühren:
  - `main.ts`: zwei kleine Stellen (Option `large`, Aufruf in
    `onOpenSettings`).
  - `styles.css`: ein neuer Block, der den heutigen Einstellungsblock ersetzt.
  - `en.json`: neue Schlüssel am Ende des Einstellungsblocks.
- `grid.ts`, `terminal.ts` und `keymap.ts` bleiben unberührt.
