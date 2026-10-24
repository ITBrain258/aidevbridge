# Dynamisches Raster und Wartet-Spur: Design

Stand 2026-10-19. Auftrag des Nutzers (diktiert, gekürzt): Im geteilten
Bildschirm sollen sich die Fenster hin- und herziehen lassen. Es sollen mehr
als vier Kacheln gehen, die sich je nach Anzahl selbst anordnen. Ein Klick auf
eine andere Session schließt das aktuelle Fenster nicht, sondern öffnet einen
zusätzlichen Platz. In der Seitenleiste stehen links oben die wartenden
Sessions. Ein Klick fügt eine davon hinzu oder zeigt ihre offene Kachel, deren
Umrandung dabei aufläuft.

Grundlage sind die Vergleichsseite vom 18. und 19.10., fünf Prüfberichte mit
einem Faktenblatt vom 19.10. (nicht im Repo) und ein klickbarer Prototyp, an
dem der Nutzer am 19.10. die Varianten gewählt hat (§2). `Datei:Zeile` bezieht
sich auf den Stand von `main` am 13.10.2026. Diese Spec geht den älteren Specs vor, wo sie ihnen
widerspricht (§11).

## 1. Ziel und Leitlinien

1. **Ein Klick fügt hinzu.** Keine Aktion schließt oder ersetzt eine Kachel,
   außer der Nutzer verlangt es ausdrücklich (Schließen, Strg+Klick).
2. **Wiederfinden.** Wer eine Session wählt, sieht sofort, welche Kachel sie
   zeigt.
3. **So viele Kacheln wie sinnvoll.** Bis zu 9 insgesamt, je Host zuerst 4,
   später 8.
4. **Wartende zuerst.** Was auf eine Antwort wartet, steht links oben.
5. **Das Terminal bleibt angehängt.** Tauschen, Verschieben und Größe ändern
   hängen keine Session neu an tmux an.
6. **Ehrliche Kosten.** Jede Größenänderung einer Kachel ist ein
   `resize_terminal`. Codex löscht dabei den tmux-Verlauf (V12,
   `docs/specs/2026-07-25-agentbridge-design.md:68`). Der Nutzer nimmt das für
   die lückenlose Anordnung und den Spalt in Kauf (§2).

## 2. Entscheidungen des Nutzers (19.10.2026)

| Frage | Wahl | Abschnitt |
| --- | --- | --- |
| Was soll Ziehen können? | Plätze tauschen und Größe ziehen | §5.4, §4.4 |
| Anordnung | lückenlos, die Kacheln füllen immer die Fläche | §4.2 |
| Neue Kachel | schiebt sich ein | §6 |
| Wiederfinden | der Rahmen zeichnet sich einmal rundherum | §6.2 |
| Wenn voll | Hinweis, nichts schließt | §5.3 |
| Kacheln je Host | 8 ab Schritt 3, bis dahin 4 | §8.1, §9 |
| Werkzeugleiste | streichen | §4.7 |
| Wartezeit in der Spur | zeigen | §7 |
| Größe ziehen trotz Verlust des Codex-Verlaufs | behalten | §1 Nr. 6 |
| Bauweg | die App rechnet die Lage jeder Kachel selbst aus | §4 |
| Optik (Hostköpfe, Farben, Schriftstandard) | eigene Runde später | §12 |

Die Entwurfsabschnitte Kacheln und Anordnung, Bedienung, Bewegung,
Seitenleiste sowie Grenzen und Reihenfolge hat der Nutzer einzeln bestätigt.

## 3. Ausgangslage im Code

- **Vier feste Plätze.** `AppState` hält immer vier Plätze, sichtbar sind die
  ersten 1, 2 oder 4 (`src/state/app-state.ts:177-180`, `:393-396`). Fokus,
  Maximiert und Kachelziel sind Platzindizes. Das Raster führt Handles und
  Schlüssel je Index, `reconcile` vergleicht je Index
  (`src/views/grid.ts:566-588`, `:1082-1118`). Eine Session zwischen Indizes
  zu tauschen hieße, beide Terminals samt Verlauf neu anzuhängen.
- **Zuordnung** (`src/state/tile-assignment.ts:34-58`): maximierte Kachel;
  schon sichtbar → nur Fokus; Ziel; kleinster freier Platz; sonst die am
  längsten nicht fokussierte. Das Ziel setzt jeder primäre `pointerdown` auf
  den Kopf (`grid.ts:611-616`) und Strg+Umschalt+1–9
  (`src/main.ts:2165-2171`), ohne Anzeige.
- **Anordnung** nur 1/2/4 mit `1fr`-Spuren (`grid.ts:197-213`). Neu vermessen
  wird nur bei Layout-, Maximier- oder Sperrwechsel (`grid.ts:1570-1581`),
  300 ms entprellt, `resize_terminal` nur bei geänderter Größe
  (`src/terminal.ts:35`, `:997-1024`). Es gibt keinen `ResizeObserver`.
- **Gespeichert** werden `layout` (1/2/4) und `tiles` mit `slot` 0–3
  (`src-tauri/src/settings.rs:46-50`, `:200-202`, `:270-282`). Das DTO verlangt
  alle Felder (`src-tauri/src/commands.rs:3125-3138`). Wartende Kacheln
  (Passwort-Hosts) hängen am Platz (`src/state/workspace.ts:162`, `:413`,
  `:417-426`).
- **Grenzen je Host:** höchstens 4 gleichzeitige Öffnungen
  (`commands.rs:518-527`), 8 PTY-Kanäle je SSH-Verbindung, abgewiesen statt
  gewartet (`src-tauri/src/transport/russh_transport/owned_operations.rs:85-87`,
  `:196-203`), höchstens 8 Pumpen einschließlich schließender
  (`src-tauri/src/connection.rs:249-253`). Ein PTY-Platz wird erst mit dem
  Close des Servers frei (`owned_operations.rs:505-508`). sshd `MaxSessions`
  (Standard 10) erreicht die App nicht. Seit Schritt 3 wartet ein Öffnen bis
  zu 2 s auf einen freien PTY-Platz, statt sofort abgewiesen zu werden, und
  die Pumpengrenze liegt bei 16.
- **WebGL:** Chromium erlaubt 16 aktive Kontexte, darüber geht der älteste
  verloren. Ein entsorgtes Terminal ruft kein `loseContext`, sein Kontext zählt
  bis zur Speicherbereinigung mit
  (`node_modules/@xterm/addon-webgl/src/WebglRenderer.ts:144-150`). Nach einem
  Verlust rendert xterm per DOM mit breiterer Zelle (7,617 statt 7 px), also
  mit einem Resize (`src/terminal.ts:400-413`).
- **Maximieren** entsorgt die anderen Terminals, Zurückholen hängt sie neu an
  (`grid.ts:9-17`). Die Spitze je Host ist 2N − 1 PTY-Kanäle. Seit Schritt 3
  verbirgt Maximieren die anderen Kacheln nur; ihre Terminals bleiben, und
  Zurückholen hängt nur an, was inzwischen keinen lebenden Kanal mehr hat.
- **Kapazitätsfehler** erscheinen als „It may have ended on the host“ mit
  Sperrleiste „Disconnected“ (`src/terminal.ts:961-976`, `grid.ts:1193-1196`).
- **Bewegung:** nur Farb- und Deckkraftübergänge bis 120 ms, einzige Animation
  `ab-sidebar-spin` (UI v2 §14, `docs/specs/2026-09-05-ui-v2-design.md:399-401`;
  Test `src/styles.test.ts:221-247`). UI v2 §19 zählt die Regel zu den nicht
  verhandelbaren (`:467`). Designsystem §7.3: kein FLIP, keine Kachelbewegung
  (`docs/specs/2026-07-27-agent-management-shell-designsystem.md:650-654`).
- **Strg+Umschalt+B** ist ein CSS-Fehler: eingeklappt gelten `0 1fr` und
  `#sidebar { display: none }`, `#grid` landet in der 0-px-Spur, und FitAddon
  klemmt auf 2 Spalten (`src/styles.css:371-377`, `index.html:21-24`).
- **Wartezeit** misst die App nicht; `attention.ts` führt Warte-Episoden ohne
  Startzeit (`src/state/attention.ts:29-48`). Der Grund liegt als
  `statusReason` vor (`app-state.ts:54`).

## 4. Kacheln und Anordnung

### 4.1 Modell

- Eine Kachel ist `{ id, sessionKey, lastFocusedAt }`. Die `id` bleibt für die
  Lebensdauer der Kachel gleich.
- `AppState` führt `tiles: Tile[]` in Anzeigereihenfolge, höchstens
  `MAX_TILES = 9`. Fokus und Maximiert verweisen auf die `id`.
- Die Position ist der Index in `tiles`, die Nummer ist Position + 1. Sie steht
  im Kachelkopf, in Spur und Liste und gilt für Strg+Umschalt+1–9.
- Eine Session steht wie heute in höchstens einer Kachel.

### 4.2 Lage

- Eine reine Funktion `layoutTiles(anzahl, fläche, anteile)` liefert die
  Rechtecke.
- Reihen: 1–2 Kacheln eine, 3–6 zwei, 7–9 drei. Geht die Zahl nicht auf,
  bekommen die oberen Reihen eine Kachel mehr: 3 = 2 + 1, 5 = 3 + 2,
  7 = 3 + 2 + 2, 8 = 3 + 3 + 2.
- In einer Reihe sind die Kacheln gleich breit und alle Reihen gleich hoch,
  solange kein Spalt verschoben ist (§4.4). Abstand 8 px wie heute.
- Bei 0 Kacheln bleibt der heutige Leerzustand. Eine maximierte Kachel füllt
  die ganze Fläche.
- Die Fläche ist das Fensterinnenmaß ohne Seitenleiste und Ränder; die
  Werkzeugleiste entfällt (§4.7).

### 4.3 Darstellung

- Jede Kachel ist ein eigener DOM-Knoten, absolut im Raster positioniert
  (`left`, `top`, `width`, `height` aus §4.2). Der Knoten lebt so lange wie
  die Kachel.
- `reconcile` arbeitet je `id`: neue Kachel montieren, geschlossene
  entsorgen. Tauschen, Verschieben, Spalt und Maximieren montieren nichts neu.
- Die DOM-Reihenfolge folgt der Entstehung, nicht der Anzeige. Deshalb nennt
  die Live-Region bei jedem Wechsel Nummer und Session.

### 4.4 Spalt

- Ein Spalt zwischen zwei Kacheln einer Reihe ändert deren Breiten, einer
  zwischen zwei Reihen deren Höhen. Mindestmaß je Kachel 200 × 120 px
  (Startwert).
- Die Anteile leben im Rasterzustand, nicht in der Datei. Ändert sich die
  Kachelzahl, sind wieder alle gleich groß; ebenso nach einem Doppelklick auf
  einen Spalt.
- Gezogen wird per Zeigerereignis mit `setPointerCapture` wie am
  Seitenleistengriff (`src/views/sidebar-resize.ts:108-120`). Vermessen wird
  erst beim Loslassen.

### 4.5 Vermessen

- Neu vermessen wird nach einer Änderung von Kachelzahl oder Reihenfolge, nach
  dem Loslassen am Spalt, bei einer neuen Fenstergröße (auch Ab- und
  Andocken), wenn die Seitenleiste ein- oder ausklappt oder ihre Breite ändert,
  und beim Maximieren und Zurückholen.
- Je Kachel, deren Spalten oder Zeilen sich ändern, geht genau ein
  `resize_terminal` hinaus. Während einer Bewegung (§6) wird nicht vermessen,
  sondern einmal danach.
- Eine neue Kachel montiert mit ihrer Endgeometrie und meldet diese Größe mit
  `open_terminal`.
- `layoutTiles` braucht kein Zellmaß, Spalten und Zeilen liefert der Fit.

### 4.6 Persistenz

- `[workspace] tiles = [{ slot, host_id, session }]`, `slot` ist die Position
  0–8. Rust: `MAX_TILES` 4 → 9, `MAX_TILE_SLOT` 3 → 8 (`settings.rs:49-50`).
- `layout` bleibt im Schema und wird aus der Anzahl abgeleitet geschrieben: 4
  ab 4 Kacheln, 2 bei 2–3, sonst 1. Version 0.1.2 liest damit die ersten vier
  Kacheln und verwirft die Plätze über 3 (`settings.rs:200-202`).
- Neuer Schlüssel `tiles_version = 2` in `[workspace]` kennzeichnet das neue
  Modell; fehlt er, stammt die Datei aus dem alten Platzmodell. Die globale
  `version` bleibt 1, sonst startete 0.1.2 schreibgeschützt
  (`settings.rs:466-473`). 0.1.2 ignoriert den unbekannten Schlüssel (kein
  `deny_unknown_fields`) und lässt ihn beim Schreiben weg; danach gilt die
  Datei wieder als alt.
- Beim Start öffnen aus einer Datei mit `tiles_version = 2` alle Kacheln in
  Platzreihenfolge. Aus einer alten Datei öffnen nur die Plätze, die mit ihrem
  `layout` sichtbar waren (Platz < `layout`); geparkte Plätze dahinter
  entfallen.
- Wartende Kacheln (Host noch nicht verbunden) führt die App nach
  Sessionschlüssel und mischt ihre Position erst beim Schreiben ein. Sonst ginge
  eine wartende Kachel verloren, sobald der Nutzer vorher eine andere öffnet.
  Verbindet sich der Host, erscheint die Kachel an ihrer gespeicherten
  Position, höchstens am Ende.
- **Nachtrag 2026-10-24:** Beim Start legt die App die gespeicherten Kacheln
  erst an, wenn jeder Host, den sie selbst verbindet und der gespeicherte
  Kacheln hat, gelistet ist oder sein Versuch endete, höchstens nach 5 s
  (`RESTORE_HOLD_MS`). Dann kommen alle in einem Zug und montieren mit ihrer
  Endgeometrie (§4.5). Bisher kamen sie je Host, und die Liste eines später
  verbindenden Hosts änderte die Größe jeder Kachel der früheren, je Kachel
  ein `resize_terminal`; Codex verlor dabei seinen Verlauf. Ein Host, den
  der Nutzer während des Wartens von Hand verbindet und der dabei gelistet
  wird, kommt im selben Zug mit. Trennt der Nutzer einen schon gelisteten
  Host, warten dessen Kacheln weiter. Öffnet der Nutzer selbst eine Session,
  endet das Warten: Was gelistet ist, kommt vor seiner Wahl, damit sie an
  der Grenze (§8.1) keiner gespeicherten Kachel den Platz nimmt. Ein Host,
  der erst nach dem Warten gelistet wird, reiht seine Kacheln wie zuvor ein,
  und die übrigen ändern dabei ihre Größe.
- Spalt-Anteile, Maximiert und Fokus werden nicht gespeichert.

### 4.7 Entfällt

- Der Umschalter 1/2/4, `grid.cycle` (Strg+Umschalt+G ist danach unbelegt),
  die Schnellöffnen-Aktionen „Layout: 1/2/4 terminals“ und der leere Platz als
  Konzept. Nur der Leerzustand bei 0 Kacheln bleibt.
- Das Kachelziel. Ein Klick auf den Kachelkopf und Strg+Umschalt+1–9
  fokussieren nur noch.
- Die Werkzeugleiste. Der Hinweis „Maximized · …“ (`tile.maximized.hint`)
  steht künftig im Kopf der maximierten Kachel.

## 5. Bedienung

### 5.1 Session wählen

Gilt für den Klick in Spur und Liste, Enter im Schnellöffnen, Strg+Umschalt+A
und „New session“:

1. Steht die Session in einer Kachel, endet ein Maximieren einer anderen
   Kachel. Die Kachel bekommt den Fokus, ihr Rahmen zeichnet sich (§6.2).
2. Sonst, solange die Grenze nicht erreicht ist (§8.1), kommt eine neue Kachel
   ans Ende und bekommt Fokus und Rahmen. Einen getrennten Host verbindet die
   App wie heute zuerst.
3. Sonst erscheint der Hinweis aus §5.3.

### 5.2 Ersetzen

- Strg+Klick in Spur oder Liste und Strg+Enter im Schnellöffnen setzen die
  Session in die fokussierte Kachel, an deren Platz. Die alte Session läuft in
  tmux weiter.
- Liegt die fokussierte Kachel auf einem anderen Host und hat der neue Host
  seine Grenze erreicht, erscheint der Hinweis aus §5.3.
- Ohne fokussierte Kachel gilt §5.1.
- Tooltip der Zeilen: „Click: open as a new terminal · Ctrl+click: replace the
  focused terminal“; bei offener Session „Click: show its terminal“.

### 5.3 Grenze erreicht

- Der Hinweis nutzt das globale Banner (`src/main.ts:2436`) in einer neutralen
  Fassung ohne Gefahrentönung. Startwerte: „vm-agents-02 already shows 8
  terminals, the limit per host. Close one first, or Ctrl+click a session to
  replace the focused terminal.“ und „9 terminals are open, the limit. …“.
- Geschlossen wird nichts.

### 5.4 Tauschen und Verschieben

- Zeigerzug am Kachelkopf außer an dessen Knöpfen, Start nach 4 px Bewegung.
  Die Quelle erscheint mit Deckkraft 0,4, die Zielkachel mit Kontur
  `--ab-focus-ring`. Loslassen über einer anderen Kachel tauscht die beiden
  Positionen. Esc und `pointercancel` brechen ab. Ein Klick ohne Bewegung
  fokussiert, ein Doppelklick maximiert.
- Kein HTML5-Drag-and-drop; `dragDropEnabled` bleibt unverändert.
- Ohne Ziehen schiebt Strg+Umschalt+Bild↑/Bild↓ die fokussierte Kachel eine
  Position nach vorn oder hinten. Dieselben zwei Einträge stehen im
  Rechtsklickmenü des Terminals (`src/views/terminal-menu.ts`). Damit ist
  WCAG 2.5.7 erfüllt.
- Die Live-Region sagt „{session} moved to position {n}“.
- Ein Tausch zwischen ungleich großen Plätzen ist eine Größenänderung (§4.5).

### 5.5 Schließen

✕ im Kopf, Strg+Umschalt+W und „Close terminal“ in der Leiste wie heute. Die
Session läuft weiter, die folgenden Kacheln rücken auf. Den Fokus bekommt die
Kachel, die nun an der Position der geschlossenen steht, sonst die vorige.

### 5.6 Maximieren

Knopf, Doppelklick auf den Kopf und Strg+Umschalt+M wie heute. Eine Session zu
wählen beendet das Maximieren (§5.1). In Schritt 1 entsorgt Maximieren die
anderen Terminals wie heute, ab Schritt 3 verbirgt es sie nur (§8.1).

### 5.7 Tasten

| Kürzel | Neu |
| --- | --- |
| Strg+Umschalt+1–9 | fokussiert die Kachel an Position 1–9, setzt kein Ziel mehr |
| Strg+Umschalt+↑/↓ | Fokus zur vorigen oder nächsten Kachel; das bisherige Blättern durch die Liste legte nach §5.1 je Tastendruck eine Kachel an |
| Strg+Umschalt+A | nächste wartende Session nach §5.1 |
| Strg+Umschalt+Bild↑/Bild↓ | fokussierte Kachel eine Position nach vorn oder hinten |
| Strg+Umschalt+G | unbelegt |

Strg+Umschalt+←/→ bleiben frei: Ein belegter Akkord bräche die Wortmarkierung
in Dialogfeldern, weil `preventDefault` vor der Dialogwache läuft
(`src/keyboard.ts:163`, `:176`, `:182`). Einstellungen › Shortcuts und die
Hinweistexte zeigen die neue Belegung.

### 5.8 Neu anhängen

„Reconnect“ in der Sperrleiste hängt die Kachel an ihrer Position neu an, wie
das stille Wiederanhängen. Heute ist es `closeTile` plus `openSession` und kann
die Kachel verschieben (`grid.ts:749-750`).

## 6. Bewegung

### 6.1 Neue Regel (löst UI v2 §14 ab)

Erlaubt sind:

1. wie bisher Übergänge auf `color`, `background-color`, `border-color`,
   `outline-color` und `opacity`, höchstens 120 ms;
2. neu Übergänge auf `left`, `top`, `width` und `height` des Kachelrahmens,
   höchstens 250 ms, nur beim Hinzufügen, Schließen, Tauschen und Verschieben;
3. neu das Aufdecken einer neuen Kachel über `opacity` und `clip-path`,
   höchstens 250 ms. Die Kachel steht dabei schon in Endgröße, das Terminal
   wird nicht skaliert;
4. die Animationen `ab-sidebar-spin` und neu `ab-tile-ring` (§6.2).

Nicht animiert werden das Ziehen am Spalt (folgt direkt dem Zeiger), jede
Fenstergröße einschließlich Ab- und Andocken und die Seitenleiste.
`transform` auf Kacheln bleibt verboten. Der Nutzer hat diese Änderung am
19.10. entschieden; die Klausel „nicht verhandelbar“ aus UI v2 §19 gilt für
die neue Fassung.

### 6.2 Der Rahmen zeichnet sich

- Auslöser: eine Session wählen (§5.1 und §5.2), Strg+Umschalt+1–9, ↑/↓ und
  die verschobene Kachel nach einem Tausch. Ein Klick in eine Kachel löst ihn
  nicht aus.
- Für 750 ms ist der Fokusrahmen der Kachel durchsichtig. An seiner Stelle
  zeichnet sich ein 3 px breites Band von oben im Uhrzeigersinn im Akzent, vorn
  mit hellem Kopf (`--ab-focus-ring`). Danach steht der normale Fokusrahmen.
- Umsetzung: `@keyframes ab-tile-ring` über eine registrierte Eigenschaft
  (`@property`, Winkel) und einen `conic-gradient`, der per Maske auf das
  Rahmenband beschränkt ist. Der Prototyp zeigt die Wirkung.
- Eine neue Kachel zeichnet ihren Rahmen nach dem Aufdecken.

### 6.3 Reduzierte Bewegung und Ansage

- Bei `prefers-reduced-motion: reduce` entfallen die Punkte 2–4 aus §6.1;
  `ab-sidebar-spin` bleibt wie heute geregelt. Statt des Rahmens leuchtet die
  Kontur 600 ms in `--ab-focus-ring` auf, ohne Übergang.
- Die Live-Region nennt bei jeder Wahl „Terminal {n}: {session}“. Sie trägt das
  Wiederfinden auch im Kontrastmodus, in dem Kontur und Band kaum zu sehen
  sind.

### 6.4 Vermessen nach der Bewegung

Die Bewegung ändert nur den Rahmen. Das Terminal behält bis zum Ende seine
Größe; am Rand schneidet `.tile-terminal` ab, oder es bleibt ein Streifen in
Terminalfarbe. Nach dem Ende läuft genau ein Refit (§4.5).

### 6.5 Test

`src/styles.test.ts` prüft die Regel aus §6.1: erlaubte Eigenschaften je
Gruppe mit Höchstdauer, als Animationen genau `ab-sidebar-spin` und
`ab-tile-ring`.

## 7. Seitenleiste: Wartet-Spur

- **Lage:** ganz oben in der Liste der Seitenleiste, über den Hosts. Die Spur
  erscheint nur, wenn mindestens eine Session wartet.
- **Kopf:** Raute, „WAITING · n“, Kürzel „Ctrl+Shift+A“.
- **Zeile (38 px):** Raute, Host-Kürzel, Sessionname, Kachelnummer (wenn
  offen, fokussiert gefüllt) und Wartezeit; darunter der Grund aus
  `statusReason`.
- **Reihenfolge:** die älteste oben. Solange Zeiger oder Fokus in der Spur
  sind, bleibt die Reihenfolge stehen (Muster `src/views/quick-open.ts:148-150`).
- **Wartezeit:** Startzeit je Warte-Episode ab der ersten Beobachtung im Poll
  (Erweiterung von `attention.ts`). Anzeige „now“ unter einer Minute, „12m“
  unter einer Stunde, sonst „2h“, aktualisiert je Minute. Ein Neustart der App
  beginnt neu.
- **Höhe:** höchstens 5 Zeilen. Warten mehr, folgt die Zeile „+n more“, die
  die Spur auf- und zuklappt. Mit Kopf, dieser Zeile und Trennlinie bleibt die
  Spur zugeklappt bei höchstens rund 260 px; das Dichte-Tor aus UI v2 gilt
  weiter für die Liste.
- **Klick** nach §5.1, **Strg+Klick** nach §5.2.
- **Die Spur öffnet nie selbst Kacheln** (`docs/stand.md`, „Feste Vorgaben“).
- **Liste darunter:** Eine offene Session zeigt statt des Kanalpunkts ihre
  Kachelnummer (14 px, fokussiert gefüllt). Sonst bleibt die Liste wie heute;
  die Hostköpfe gehören zur Optik-Runde.

## 8. Grenzen und Fehler

### 8.1 Grenzen

| | Schritt 1 | ab Schritt 3 |
| --- | --- | --- |
| Kacheln gesamt | 9 | 9 |
| Kacheln je Host | 4 | 8 |
| gleichzeitige Öffnungen je Host | ≤ 4, bei höchstens 4 Kacheln je Host immer erfüllt | Warteschlange je Host im Frontend: höchstens 4 `open_terminal` zugleich, die übrigen Kacheln zeigen „Opening…“ |
| Maximieren | entsorgt die anderen (Spitze 7 ≤ 8 PTY) | verbirgt die anderen; Kanäle und WebGL-Kontexte bleiben |
| Ersetzen an der Grenze | sofort | wartet, bis der alte Kanal geschlossen ist |

Ersetzen an der Grenze: umgesetzt (Schritt 3) als Warten im Backend von
höchstens 2 s (`SLOT_WAIT`); schließt der alte Kanal bis dahin nicht,
erscheint die Kapazitätsmeldung (§8.3).

Vor dem Abschluss von Schritt 3 misst die App 4, 6 und 8 Kacheln je Host, die
gleichzeitig viel ausgeben: Speicher von `msedgewebview2`, Statuslatenz,
Kanalverluste.

### 8.2 Grafikspeicher

Beim Entsorgen eines Terminals ruft die App `WEBGL_lose_context.loseContext()`
am Canvas, bevor sie xterm entsorgt. Das gehört zu Schritt 1: 9 Kacheln mit
Maximieren und Zurückholen können sonst 9 lebende und 8 tote Kontexte halten,
17 > 16.

### 8.3 Kapazitätsmeldung

Die Rohtexte der Kanalgrenzen („too many terminal setups are already pending
for this host“, „The SSH command failed (admission, capacity).“, „Terminal
operation failed during Admission: Capacity“, „too many terminal output tasks
are still closing“) bekommen eine eigene Meldung, Startwert: „{host} has no
free terminal channel right now. Close a terminal and try again.“ Die
Sperrleiste „Disconnected“ entfällt dafür; der Rohtext bleibt hinter „Copy
details“.

### 8.4 Schmale Kacheln

Unter 80 Spalten oder 20 Zeilen nach dem Fit zeigt der Kachelkopf den Chip
„{cols}×{rows} · narrow“ in `--ab-warn` (Designsystem §5.4, i18n
`tile.narrow`). Die App verkleinert nie selbst und schließt beim Abdocken
nichts.

### 8.5 Strg+Umschalt+B

Eingeklappt bekommt `#grid` eine feste Spalte (`grid-template-columns: 1fr`
oder `#grid { grid-column: 2 }`). Ein- und Ausklappen rechnet die Lage neu
(§4.5). Test in `src/styles.test.ts`.

### 8.6 Lesbarkeit in Zahlen

Schwächste Kachel bei 13 px ohne Werkzeugleiste, gerechnet mit der Formel aus
§4.5 und den Innenmaßen 1920 × 1009 (Monitor, 100 %) und 1536 × 793
(Notebook, 125 %). Innenmaße und Zelle bei 125 % sind am Fenster ungeprüft.

| Kacheln | Monitor | Notebook |
| --- | --- | --- |
| 1 | 234 × 56 | 174 × 44 |
| 2 | 115 × 56 | 85 × 44 |
| 3–4 | 115 × 27 | 85 × 20 |
| 5–6 | 75 × 27 | 55 × 20 |
| 7–9 | 75 × 17 | 55 × 13 |

Lesbar (mindestens 80 × 20) sind damit auf beiden Bildschirmen bis zu 4
Kacheln. Mit 11 px sind auf dem Monitor alle 9 lesbar (88 × 20), auf dem
Notebook weiter 4 (96 × 23).

## 9. Lieferschritte

| Schritt | Inhalt | h |
| --- | --- | --- |
| 0 | Strg+Umschalt+B (§8.5) | 0,5–1 |
| 1 Kern | §4, §5, §7, §8.1 mit 4 je Host, §8.2–§8.4, Werkzeugleiste weg; der Rahmen leuchtet vorerst nur auf (§6.3) | 46–75 |
| 2 Bewegung | §6.1 Punkte 2–4, §6.2, §6.5 | 5–8 |
| 3 Acht je Host | §8.1 rechte Spalte mit Messung | 7–12 |
| **Zusammen** | | **58–96** |

- Die Stunden sind Schätzungen aus den Berichten vom 19.10. Schritt 1 enthält
  die Kachelnummern in der Liste (2–3 h) und die WebGL-Freigabe (1–2 h).
- Das offene M1-Tor (`docs/stand.md`) wird nach Schritt 1 am neuen Raster
  abgenommen, mit den Kriterien aus §10.2.
- Jeder Schritt endet mit grünen Prüfungen (tsc, vitest, cargo) und einem
  Eintrag in `docs/stand.md`.

## 10. Prüfung und Abnahme

### 10.1 Automatische Tests

- **`layoutTiles`:** Reihenverteilung für 0–9 Kacheln, Rechtecke für feste
  Flächen, Anteile mit Mindestmaß, Rücksetzen.
- **Modell:** Hinzufügen; Fokus auf eine offene Session; Ersetzen auf gleichem
  und anderem Host an der Grenze; Grenzen 8 je Host und 9 gesamt; Schließen mit
  Nachbarfokus; Tauschen; Verschieben; Wahl beendet Maximieren.
- **Raster:** Tauschen montiert nichts neu; eine neue Kachel montiert mit
  Endgeometrie; genau ein `resize_terminal` je Kachel mit geänderter Größe beim
  Öffnen, Schließen, Loslassen am Spalt und Tausch ungleicher Plätze; keins
  beim Fokuswechsel und beim Tausch gleich großer Plätze; Zug mit Schwelle,
  Esc und Doppelklick.
- **Tasten** aus §5.7, die zwei Einträge im Terminalmenü, die Texte der
  Live-Region.
- **Persistenz** in TS und Rust: 9 Kacheln, Positionen, abgeleitetes
  `layout`, `tiles_version`; eine neue Datei mit 3 und mit 9 Kacheln öffnet
  alle; eine alte Datei mit geparkten Plätzen öffnet nur die sichtbaren;
  wartende Kachel überlebt eine vorher geöffnete andere; Rückweg zu 0.1.2 mit
  den ersten vier (Test gegen die Dateiform des Vorgängers wie
  `settings.rs:979-995`).
- **Spur:** Reihenfolge, Schnappschuss, Format der Wartezeit, höchstens 5
  Zeilen, Kachelnummer.
- **Fehler:** Kapazitätsmeldung aus den Rohtexten, `loseContext` beim
  Entsorgen.
- **`styles.test.ts`:** Regel aus §6.1 und das Gate für §8.5.

### 10.2 M1-Tor und Handabnahme

Die Kriterien der MVP-Spec §3.4 bleiben. Dazu kommen:

- Öffnen und Schließen: genau ein `resize_terminal` je Kachel, deren Größe sich
  ändert.
- Tausch gleich großer Kacheln: kein `open_terminal`, kein `resize_terminal`.
- Start mit 9 Kacheln (bis 8 je Host; in Schritt 1 höchstens 4) ohne
  Abweisung.
- Maximieren und Zurückholen ohne „Capacity“.
- M2-Aufwachen mit 8 Kacheln je Host.

`docs/abnahme-handarbeit.md` §9, Schritte 3 und 4, wird neu gefasst: vorher
andere Kacheln schließen, WINCH beim Öffnen einer Kachel ist erwartet.

### 10.3 Am Fenster

Abgeschottete Testinstanz über CDP. Der Nutzer prüft Schrift und Bewegung bei
125 % und 150 %:

- Der Rahmen zeichnet sich sichtbar; Aufdecken und Gleiten ohne unscharfe
  Schrift.
- Mit ausgeschalteten Windows-Animationseffekten meldet WebView2
  `prefers-reduced-motion`.
- Innenmaß sowie `term.cols` und `term.rows` maximiert auf beiden
  Bildschirmen (§8.6).
- Strg+Umschalt+B, Ab- und Andocken.

## 11. Ablöse älterer Regeln

| Quelle | Bisher | Neu |
| --- | --- | --- |
| UX-Spec §14 (Z. 974) | „mehr als 4 Kacheln“ ausgeschlossen | bis 9 Kacheln (§4.1); Tabs bleiben ausgeschlossen |
| UX-Spec §7.4 (Z. 529 ff.) | Kopfklick und Strg+Umschalt+1–4 setzen ein Ziel; ohne Ziel gilt `tile-assignment.ts` | ein Klick fügt hinzu, Ersetzen nur per Strg+Klick (§5.1, §5.2) |
| UX-Spec §7.5 (Z. 550-551) | Schnellöffnen-Aktionen „Layout: 1/2/4 terminals“ | entfallen |
| UX-Spec §7.9 (Z. 634-636), §8.4 (Z. 713) | Leerzustand und Tooltip nennen „Layout (Ctrl+Shift+G)“ | G entfällt |
| UX-Spec §7.2 (Z. 514-518), §9.2 (Z. 789-794) | Wiederherstellen nach Platz; `layout = 1 \| 2 \| 4`, `slot` 0–3, höchstens 4 | §4.6 |
| UI v2 §8.1, §8.4, §11.2 | Umschalter 1/2/4 in der Werkzeugleiste, leerer Platz im 4er-Raster, `aria-disabled` am Umschalter | entfallen, Werkzeugleiste gestrichen (§4.7) |
| UI v2 §14 (Z. 399-401), §16.1, §19 (Z. 467) | nur Farbe und Deckkraft bis 120 ms, eine Animation, nicht verhandelbar | §6.1; die Klausel gilt für die neue Fassung |
| Designsystem §5.3 (Z. 450 ff.) | „Der Umschalter 1 / 2 / 4 bleibt“, Regel mit 7,62 px | §4.2 |
| Designsystem §5.5 (Z. 505-511) | keine Übergänge auf Layouteigenschaften, weil jeder Zwischenframe ein Fit wäre | der Rahmen darf gleiten, vermessen wird genau einmal danach (§6.4) |
| Designsystem §7.2 (Z. 641-643), §7.5 (Z. 680) | Umschalter `aria-disabled`, `grid.cycle` | entfallen |
| Designsystem §7.3 (Z. 650-654) | kein FLIP, keine Kachelbewegung | §6.1 |
| MVP-Spec §3.4 M1 (Z. 92) | „Kachelwechsel ohne Größenänderung sendet kein Resize“ | bleibt, ergänzt um §10.2 |
| Gesamtspec §4.2 (Z. 183-185) | TerminalConn „hart ≤8, LRU-Verdrängung“ | 8 je Host ab Schritt 3, keine Verdrängung (§5.3, §8.1) |
| Gesamtspec §6.4 (Z. 404 ff.) | Resize nur bei echter Größenänderung des Fensters | auch beim Öffnen, Schließen, am Spalt und beim Tausch ungleicher Plätze (§4.5) |
| Gesamtspec §7.4 (Z. 524) | Strg+Umschalt+1…9 wählt die Session direkt | Kachel an Position 1–9 (§5.7) |

## 12. Offen und ungeprüft

- **Schrift:** Der Nutzer hat im Prototyp 11 px eingestellt. Ob das der
  Standard wird oder je Bildschirm gilt, klärt die Optik-Runde.
- **Optik-Runde:** Hostköpfe (Entwurf sa), Farben und die übrigen Punkte der
  Vergleichsseite.
- **Am Fenster ungeprüft:** Innenmaße und Zelle bei 125 %, die WebGL-Grenze in
  WebView2 samt Speicherbereinigung, `prefers-reduced-motion` aus Windows,
  Schärfe beim Aufdecken über WebGL, Kontrastmodus.
- **Hosts:** ob eine `~/.tmux.conf` die Statuszeile abschaltet (sonst je Kachel
  eine Zeile weniger).
- **Agenten:** Mindestbreiten von Grok, agy und OpenCode sind unbelegt.
- **Last:** gemessen am 21.10.2026 mit 4, 6 und 8 Kacheln je Host
  ([Messbericht](../messungen/messung-2026-10-21-acht-kacheln.md)); offen
  bleibt, was der Bericht unter „Was diese Messung offen lässt“ nennt.
