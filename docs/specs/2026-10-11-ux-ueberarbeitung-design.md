# UX-Überarbeitung: Design

Stand 2026-10-11. Auftrag des Nutzers: Die App entspricht nicht mehr den
Standards vergleichbarer Werkzeuge. Akut stören zwei Fehler: Unter Windows lässt
sich aus den Terminals nicht kopieren und einfügen (manchmal mit gedrückter
Umschalttaste), und in der Hostzeile erscheint immer wieder eine
Verbindungsmeldung, obwohl die Verbindung steht und das Terminal weiterläuft.
Das Gesamtpaket soll so überarbeitet werden, dass ein IT-Administrator und
Entwickler mit mehreren VMs und Projekten im Alltag produktiv arbeitet.

Grundlage sind sechs Analysen vom 11.10.2026: Terminal, Verbindung,
Alltagsabläufe, Einstellungen und Texte, Marktvergleich und tmux 3.6. Die
Rohberichte liegen nicht im Repo. Ihre Befund-IDs (T-, V-, A-, E-) stehen hier
zur Nachverfolgung. Diese Spec geht den älteren Specs vor, wo sie ihnen
widerspricht (§4).

## 1. Ziel und Leitlinien

1. **Windows-Gewohnheiten im Terminal.** Kopieren, Einfügen, Rechtsklick und
   Tasten verhalten sich wie in Windows Terminal. Die Terminaltreue bleibt:
   Strg+C ohne Markierung unterbricht weiter das Programm.
2. **Kein falscher Alarm.** „Getrennt“ zeigt die App nur bei einem echten
   Verbindungsverlust. Langsame Lesebefehle sind kein Verlust.
3. **Selbstheilung ohne Geheimnisse.** Hosts mit Schlüsseldatei oder ssh-agent
   verbinden sich nach einem Abriss selbst neu. Passwörter und Passphrasen
   speichert die App weiterhin nirgends.
4. **Arbeitsplatz für viele VMs.** Die App merkt sich Layout, Kacheln und
   verbundene Hosts, stellt sie beim Start wieder her und findet Hosts und
   Sessions per Schnellöffnen.
5. **Schlank.** Kein Bereich ohne Inhalt, keine Funktion außerhalb des
   Produktkerns (§14).

## 2. Belegte Ursachen

### 2.1 Falsche Verbindungsmeldung (V-01, V-02, V-03)

- `CommandTransport::execute()` meldet jedes Befehlsergebnis an
  `HostConnection::observe()` (`connection.rs:638-640`). Das gilt auch für
  verzichtbare Lesungen der Statusabfrage: `claude agents --json` (bis 4 s),
  Panetitel (bis 1 s) und `/proc` (bis 1 s, `commands.rs:3279-3335`). Diese
  verwerfen ihren Fehler zwar mit `.ok()`, eine Zeitüberschreitung zählt aber
  trotzdem als Strike.
- Ein Strike setzt `ControlHealth::Suspect`, die Seitenleiste zeigt dann
  „Session updates need attention“ (`sidebar.ts:984-995`). Der nächste Erfolg
  setzt `Ready`. Die Meldung kommt und geht also.
- Drei Strikes in Folge setzen `Degraded` und brechen die Steuerverbindung ab.
  Dasselbe passiert, wenn eine Teilfrist während des Kanalöffnens abläuft
  (`owned_operations.rs:165-175`, `429-437`). Dafür genügt eine Restzeit von
  wenigen Millisekunden, weil die Statusabfrage nur auf exakt null prüft.
- Dann bleibt „Control connection interrupted“ stehen, bis der Nutzer von Hand
  repariert. Die Terminals laufen über die zweite SSH-Verbindung weiter.
- Jeder Wechsel zurück auf `Ready` lädt die ganze Sessionliste neu
  (`main.ts:2020-2022`). Das belastet genau die VM, die gerade zu langsam war.
- Zweiter Pfad, nur an der Kachel: Kommt 30 s lang keine Bestätigung des
  Frontends, baut der Wächter der Ausgabepumpe den Kanal ab
  (`commands.rs:144`, `2074-2124`). WebView2 drosselt Timer in einem
  minimierten Fenster, und dann zeigt die Kachel „Not attached“.

### 2.2 Kopieren und Einfügen (T-01 bis T-05)

- Die App kennt nur Strg+Umschalt+C/V (`keymap.ts:55-56`). Strg+C geht als ^C
  an den Agenten und bricht ihn ab, Strg+V geht als ^V hinaus
  (`terminal.ts:391-440`).
- Die App startet tmux ohne `-f`. Damit gilt `~/.tmux.conf` auch auf dem
  App-Socket, auf 192.0.2.20 also `set -g mouse on`.
- tmux bekommt dann jedes Ziehen, kopiert beim Loslassen in seinen Puffer und
  schickt die Kopie per OSC 52 (`ESC]52;;<base64>BEL`, gemessen auf tmux 3.6).
  xterm.js 6 verwirft OSC 52.
- Lokal markiert nur Umschalt+Ziehen. Daher kommt „manchmal mit Shift“.
- Rechtsklick öffnet das WebView2-Standardmenü, obwohl die Gesamtspec §7.4
  „Rechtsklick fügt ein“ verlangt.
- Einfügen läuft über `navigator.clipboard.readText()` und braucht eine
  WebView2-Berechtigung, die Tauri nicht erteilt. Beim ersten Einfügen erscheint
  deshalb eine Abfrage.
- Jeder Fehler beim Kopieren oder Einfügen erscheint als „Could not open this
  terminal …“ (`main.ts:467`).

### 2.3 Weitere Befunde

| ID | Befund | Schwere | Abschnitt |
| --- | --- | --- | --- |
| A-01 | Layout, Kacheln und Hosts überleben keinen Neustart | S1 | §7.1 |
| A-02 | kein Verbinden beim Start | S1 | §7.2 |
| V-04, V-08 | Reparatur und Neuverbinden nur von Hand | S1 | §5.3, §5.4 |
| E-01 | F5/Strg+R laden die App neu, Browsermenü außerhalb des Terminals | S1 | §8.1 |
| A-03 | zweite Sessionwahl verdrängt die erste, obwohl Kacheln frei sind | S2 | §7.4 |
| A-04 | keine Schnellsuche für 15 Hosts | S2 | §7.5 |
| A-05 | neue Session ohne Projektbezug, Fokus falsch | S2 | §7.6 |
| A-06, E-04 | Hinweise versprechen Kürzel ohne Wirkung | S2 | §7.9 |
| A-07 | wartende Agents am zugeklappten Host unsichtbar, laute Hinweise | S2 | §7.8 |
| A-08 | kein Anzeigename, „Connect“ beim Bearbeiten trennt | S2 | §7.7 |
| V-05 | ein claude-Fehler setzt Unknown und lässt die Taskleiste erneut blinken | S2 | §5.2 |
| V-09, T-08 | Verlauf fehlt nach Maximieren, Layoutwechsel, Wiederanhängen | S2 | §5.6 |
| T-06 | Links nicht klickbar | S2 | §6.5 |
| T-07 | Suche ohne Zähler und Knöpfe | S2 | §6.6 |
| E-06, T-09 | keine Schriftgröße, kein Zoom | S2 | §6.7 |
| E-02, E-03 | App-Akkorde schlucken Textbearbeitung, Esc doppelt | S2 | §8.2 |
| E-08, A-14 | Rohtexte und falsche Rahmentexte in Fehlermeldungen | S2 | §10 |
| E-09 | Mindesthöhe 700 passt bei 150 % nicht | S2 | §8.5 |
| E-10 | optische Mitte der Schrift nicht nachgewiesen | S2 | §11 |
| A-10, A-11 | Seitenleiste fest 240 px, Reload nur über ⋯ | S3 | §7.8 |
| E-05 | kein Kürzel für Einstellungen, Tooltips ohne Kürzel | S3 | §8.3, §8.4 |
| E-11, E-12, E-13 | Barrierefreiheit, Desktop-Anmutung, CSS-Altlasten | S3 | §11 |
| T-10 | `terminal-overrides` ersetzt die tmux-Standardliste | S3 | §6.8 |
| tmux 3.6 | 192.0.2.20 läuft mit tmux 3.6, Status zeigt dort nur Unknown | S1 | §12 |

## 3. Feste Vorgaben

Unverändert aus `docs/stand.md` und den Specs:

- Windows-Client: nur die App, kein Python, kein weiterer Installer.
- Auf den VMs nur SSH, tmux und ein von Hand gestarteter Agent. Kein Hook, kein
  Watcher, keine Konfigurationsänderung, kein eigener Startdialog. Die App
  installiert nichts.
- Eigene tmux-Serveroptionen auf dem App-Socket sind erlaubt, wie bisher
  `history-limit`, `remain-on-exit` und `terminal-overrides`.
- Status nur aus lesenden Quellen. Der Poll führt die Sessionliste nicht.
- Passwörter und Passphrasen werden nicht gespeichert, auch nicht im
  Arbeitsspeicher über einen Verbindungsversuch hinaus.
- Kein helles Thema. Farbwahl: 7 Akzente auf 2 Grundtönen.
- Aufmerksamkeit über Fenstertitel und Taskleiste, kein Toast.
- Einstellungen im Termius-Stil: Navigation links, Inhalt in Karten, keine
  leeren Bereiche.
- Oberflächensprache Englisch.
- Tests gegen die VMs nur mit eigenem Testsocket, nie mit produktiven Sessions.

## 4. Ablöse älterer Regeln

| Quelle | Bisher | Neu |
| --- | --- | --- |
| Gesamtspec §7.4 (Z. 514) | Strg+C und Strg+V gehen unverändert ans Terminal | Strg+C mit Markierung kopiert, Strg+V fügt ein; abschaltbar (§6.1) |
| Gesamtspec §7.4 (Z. 528) | Rechtsklick fügt ein | Rechtsklick öffnet das Terminalmenü; „Copy/Paste“ als Einstellung (§6.3) |
| Gesamtspec §8.3 | Links mit Bestätigungsdialog | Strg+Klick ist die Bestätigung (§6.5) |
| Gesamtspec §5.1 | Sessionnamen nicht aus dem Repo ableiten | sichtbarer, änderbarer Namensvorschlag aus dem Ordner (§7.6) |
| MVP-Spec, Zuschnitt vom 05.09. | Links öffnen (S0.6) gestrichen | Links mit Strg+Klick (§6.5) |
| MVP-Spec §4.3, §4.7, §6 | Strikes, `Suspect`, drei Fehlschläge brechen ab | nur echter Verlust zählt (§5.1) |
| MVP-Spec §3.3 M2.2, Roadmap S2.2 | Auto-Reconnect hält das Geheimnis im Speicher | Selbstheilung nur für Schlüssel und ssh-agent, nichts im Speicher (§5.3, §5.4) |
| Roadmap M2.1 | History-Restore später | jetzt (§5.6) |
| UI-v2 §2, §6.7, §20 | keine Terminal-Schriftgröße, Zellmaße fest | Schriftgröße 10–20 px (§6.7) |
| UI-v2 §2, §20 | Seitenleiste fest 240 px | ziehbar 208–480 px (§7.8) |
| UI-v2 §10 | Leerzustand nennt N, F, B, M, G | nur wirksame Kürzel (§7.9) |
| UI-v2 §15, Roadmap S3.2 | Mindestgröße 1100×700 | 1100×600 (§8.5) |
| UI-v2 §21 | bestehende Oberflächentexte unverändert | Texte nach §10 |
| Einstellungs-Spec §1.3, §1.6 | drei Bereiche, nur Frontend | fünf Bereiche, Rust-Schema erweitert (§9) |
| Einstellungs-Spec §6.1 (`en.json:211`) | „App shortcuts always use Ctrl+Shift … including Ctrl+C“ | Regel mit Ausnahmen (§8.3) |
| Designsystem §6.4 | `.ab-seg-item` | entfällt (§11) |
| `settings.rs:1-4` | kein Session-Zustand in `settings.toml` | Arbeitsplatz als `[workspace]` (§9.2); Gesamtspec §5.3 erlaubt UI-Layout ausdrücklich |

## 5. Verbindung und Status

### 5.1 Steuerzustand

`ControlHealth` behält `Ready`, `Degraded`, `Reconnecting` und
`AuthenticationRequired`. `Suspect` und der Strike-Zähler entfallen, in Rust und
im Frontend (`types.ts`, `app-state.ts`, `sidebar.ts`).

`observe(generation, result)` folgt einer einzigen Regel, unabhängig von Phase
und Befehl:

| Lage nach dem Befehl | Neuer Zustand |
| --- | --- |
| Steuertransport nicht mehr nutzbar (`!is_usable()`) | `Degraded`, Transport wird abgelegt |
| Befehl erfolgreich | `Ready` |
| Befehl gescheitert, Transport nutzbar | unverändert |

- Ereignisse `control://state` gehen nur bei einem Wechsel hinaus.
- Ein gescheiterter Befehl meldet seinen Fehler weiter nur seinem Aufrufer: der
  Poll mit „As of“, die Liste mit ihrem Hinweis.
- Einen toten Pfad erkennt das SSH-Keepalive (15 s, nach drei unbeantworteten
  Keepalives beendet russh die Sitzung) oder ein Abbruch beim Kanalöffnen. Beide
  machen den Transport unbenutzbar.
- Die Meldung beim Wechsel auf `Degraded` nennt Phase und Grund des auslösenden
  Fehlers, ohne Debug-Formatierung (V-07). „Copy diagnostics“ gibt es auch im
  Steuerhinweis.

### 5.2 Statusabfrage

Gesamtfrist bleibt 5 s (`STATUS_POLL_TIMEOUT`). Die verzichtbaren Lesungen
starten nur mit genug Restzeit:

| Lesung | Start nur bei Restzeit | Frist |
| --- | --- | --- |
| Panetitel (`read_pane_details`) | ≥ 500 ms | min(1 s, Restzeit) |
| `claude agents --json` | ≥ 1500 ms | min(4 s, Restzeit − 700 ms) |
| Elternprozesse aus `/proc` | ≥ 500 ms | min(1 s, Restzeit) |

`StatusPollDto` bekommt zwei Felder:

- `agents_ok`: `false`, wenn der claude-Befehl übersprungen wurde oder ohne
  Antwort scheiterte. Ein Exitcode ≠ 0 (etwa 127, nicht installiert) ist eine
  gültige Antwort, dann ist `agents_ok` `true`. Nennt claude Agenten, braucht die
  Bindung an die Pane auch die Elternprozesse. Wird deren Lesung übersprungen
  oder scheitert sie ohne Antwort, ist `agents_ok` ebenfalls `false`.
- `titles_ok`: dieselbe Regel für die Panetitel.

Das Frontend übernimmt eine Zeile mit Status `unknown` nicht, wenn die zuständige
Quelle ausfiel (`agents_ok` oder `titles_ok` ist `false`) und die Session vorher
`waiting`, `busy` oder `idle` war. Es behält dann den alten Wert und markiert
ihn veraltet („As of HH:MM“). Ein Übergang von veraltetem zu aktuellem `waiting`
gilt nicht als neu wartend: kein erneutes Blinken der Taskleiste.

Polltakt: Je Host beginnt der nächste Poll frühestens 2 s nach dem Ende des
vorigen. Läuft für den Host gerade `list_sessions`, setzt der Poll aus. Die Liste
wartet nie auf den Poll.

Die Sessionliste lädt nur bei einer neuen Kontrollgeneration neu (nach einer
Reparatur), nicht bei jedem Zustandswechsel. Veraltet ist sie nur bei
`degraded`, `reconnecting` und `authentication_required`.

### 5.3 Selbstreparatur der Steuerung (V-04)

- **Auslöser:** Ereignis `degraded` für einen Host, dessen Terminalverbindung
  lebt (`host.state === "connected"`) und dessen Anmeldeart `agent` oder `key`
  ist.
- **Ablauf:** Versuche nach 2, 5, 15, 30 und 60 s (je ±20 % Streuung), höchstens
  5 je Ausfall. Ein Versuch ist `begin_control_repair` plus `repair_control`
  ohne Geheimnis.
- **Abbruch:**
  - Meldet ein Versuch `authentication_required` (Schlüssel mit Passphrase),
    endet die Reihe, und das bisherige Formular erscheint.
  - Trennt der Nutzer den Host oder entfernt er ihn, endet die Reihe ebenfalls.
- **Fensterfokus:** Bekommt das Fenster den Fokus, während ein Versuch wartet,
  startet er sofort.
- **Anzeige während der Reihe:** eine ruhige Zeile „Reconnecting live updates…“
  unter der Hostzeile, kein Kasten. Die Statuspillen zeigen „As of“, die
  Terminals bleiben bedienbar.
- **Nach dem fünften Fehlschlag:** der Kasten aus §10 mit Knopf.
- **Passwort-Hosts:** unverändert der Knopf mit Feld.

### 5.4 Neuverbinden nach Verlust der Terminalverbindung (V-08)

- **Auslöser:** `terminal://transport-lost`, etwa nach Standby, Netzwechsel oder
  VPN-Abbruch. Betroffen sind Hosts mit Anmeldeart `agent` oder `key`.
- **Ablauf:** Die App verbindet den Host vollständig neu, mit derselben Reihe
  von Wartezeiten wie in §5.3 und sofort bei Fensterfokus oder dem Ereignis
  `online`. Nach Erfolg hängen sich alle Kacheln des Hosts wieder an, mit
  Verlauf (§5.6).
- **Kein Wiederholen bei Sicherheits- und Anmeldefehlern:** Ein geänderter
  Hostschlüssel, ein abgelehnter Schlüssel oder eine nötige Passphrase beenden
  die Reihe sofort und zeigen den Fehler. Wiederholt wird nur bei Netzfehlern
  (nicht erreichbar, Zeitüberschreitung, Verbindung verweigert).
- **Anzeige:** Die Hostzeile zeigt „Reconnecting…“, die Kacheln einen ruhigen
  Hinweis „Reconnecting…“ statt der Sperrleiste. Nach dem fünften Fehlschlag
  folgt der bisherige Fehlerzustand mit „Retry“.
- **Passwort- und Passphrase-Hosts:** unverändert von Hand.
- **ssh-agent mit Bestätigung:** fragt bei jedem Versuch; das ist hinnehmbar.

### 5.5 Stilles Wiederanhängen einer Kachel

- **Auslöser:** `terminal://connection-lost` für eine Kachel, während die
  Terminalverbindung ihres Hosts lebt. Typisch ist der Wächter aus §2.1 bei
  minimiertem Fenster.
- **Ablauf:** Die Kachel hängt sich bis zu dreimal selbst wieder an, nach
  0,5 s, 2 s und 5 s, über dieselbe Aktion wie heute der Knopf „Reconnect“. Ist
  `document.hidden`, wartet sie auf `visibilitychange` und versucht es dann.
- **Anzeige:** Während der Versuche zeigt die Kachel einen ruhigen Hinweis
  „Reconnecting…“; die Eingabe ist gesperrt.
- **Fehlschlag:** Ist die Session auf dem Host beendet, erscheint die
  Sperrleiste mit diesem Grund. Nach drei anderen Fehlschlägen erscheint die
  Sperrleiste mit „Reconnect“.
- Der 30-s-Wächter bleibt unverändert. Er schützt die gemeinsame Verbindung.

### 5.6 Verlauf beim Anhängen (V-09)

Jedes `open_terminal` liefert den Verlauf der Pane mit: beim ersten Öffnen, beim
Wiederanhängen und nach einem Layoutwechsel.

- **Wann:** nur, wenn die Pane-Id aus der Sessionbindung bekannt ist. Sonst ohne
  Verlauf.
- **Befehl:** ein einziger tmux-Aufruf über die Steuerverbindung, verzichtbar,
  Frist 2 s:
  `display-message -p -t %N '#{?history_size,#{alternate_on},1}' ; capture-pane -p -e -J -S -5000 -E -1 -t %N`.
  Ist die erste Zeile `1`, entfällt der Verlauf: Vollbildprogramm oder leerer
  Verlauf. Ohne die Prüfung von `history_size` liefert tmux 3.6 bei leerem
  Verlauf für `-E -1` die erste sichtbare Zeile, die dann doppelt stünde
  (gemessen bei Aufgabe 11).
- **Zeitpunkt:** nach dem bestätigten Attach. Das Attach ändert die Fenstergröße,
  und tmux verschiebt dabei Zeilen zwischen Verlauf und Bildschirm. Erfasst man
  vorher, entstehen doppelte oder fehlende Zeilen (gemessen bei Aufgabe 11). Die
  Reihenfolge sichert die Pumpe: Sie liefert den Verlauf vor dem ersten
  Kanalstück aus.
- **Aufbereitung:** `\n` wird `\r\n`. Höchstens 2 MiB; ist es mehr, fallen die
  ältesten Zeilen weg. Enthält der Verlauf Escape-Folgen, folgt `\e[m`, damit
  keine Hintergrundfarbe in die Vorschubzeilen läuft. Danach folgen genau
  `rows − 1` × `\r\n`. Der Grund: Das Neuzeichnen beim tmux-Attach
  überschreibt den sichtbaren Bereich, und ED2 schiebt in xterm.js nichts in den
  Verlauf. Ohne diesen Vorschub verschwänden die letzten Zeilen des Verlaufs.
  Mit `rows` statt `rows − 1` bliebe eine Leerzeile zwischen Verlauf und
  Bildschirm.
- **Restzeit:** Die Erfassung startet nur, wenn von der Frist des Öffnens mehr
  als 2 s plus 300 ms Rest bleiben. Sonst öffnet das Terminal ohne Verlauf. Die
  Erfassung darf das Öffnen nie scheitern lassen.
- **Ist der Verlauf leer:** kein Vorschub.
- **Auslieferung:** als erste `terminal://output`-Ereignisse derselben `open_id`,
  in Stücken von höchstens 32 KiB. Sie laufen durch dasselbe Ack-Fenster wie die
  Live-Ausgabe, und zwar bevor die Pumpe Kanaldaten weitergibt. Ein
  Rückgabewert von `open_terminal` wäre ein Wettlauf mit der Pumpe und ist
  deshalb nicht erlaubt.
- Die lokale Scrollback-Grenze bleibt 5000 Zeilen.

### 5.7 Anzeige in der Seitenleiste

- Hinweisblöcke (Verbindung, Sessionliste, Steuerung) zeigen Titel, höchstens
  zwei Zeilen Meldung (`line-clamp: 2`) und ihre Knöpfe. „Details“ klappt die
  volle Meldung und „Copy diagnostics“ auf.
- Der Verbindungskasten zeigt ein Passwort- bzw. Passphrase-Feld nur nach einem
  Anmeldefehler (fehlendes oder abgelehntes Passwort, nötige Passphrase); bei
  Netz- und anderen Fehlern stehen dort nur „Retry“ und „Details“.
- Der Kasten der Sessionliste zeigt einen eigenen Satz
  (`sidebar.sessions.loadFailed`), den Backend-Text nur hinter „Details“.
  Solange die Steuerung nicht bereit ist (ruhige Zeile), erscheint für
  `control_unavailable` kein Kasten.
- Die ruhige Zeile aus §5.3 und §5.4 ist ein Text in `--ab-text-muted` mit
  Drehsymbol, ohne Rahmen.

## 6. Terminal

### 6.1 Tastatur und Zwischenablage

Fokus im Terminal:

| Eingabe | Wirkung | Einstellung, Standard |
| --- | --- | --- |
| Strg+C mit Markierung | kopiert, hebt die Markierung auf, nichts geht ans Terminal | „Use Ctrl+C and Ctrl+V“, an |
| Strg+C ohne Markierung | ^C ans Terminal | – |
| Strg+V | Einfügen über das native Einfügen von Chromium; xterm klammert per Bracketed Paste | dieselbe; aus: ^V ans Terminal |
| Strg+Umschalt+C | kopiert die Markierung, ohne Markierung nichts | fest |
| Strg+Umschalt+V, Umschalt+Einfg | Einfügen, nativ | fest |
| Strg+Einfg | kopiert die Markierung wie Strg+Umschalt+C | fest |
| Strg+Alt+… und AltGr+… | nie abgefangen (deutsche Tastatur) | fest |

- **Nativ einfügen:** Der Tastenhandler von xterm gibt `false` zurück, ohne
  `preventDefault`. Dann fügt Chromium selbst in xterms Textfeld ein, und das
  braucht keine Berechtigung. `main.ts` darf für `clipboard.paste` kein
  `preventDefault` setzen, wenn das Ziel in `.xterm` liegt.
- **Kopieren:** `navigator.clipboard.writeText`.
- **Rückmeldung:** Nach jedem Kopieren, auch über OSC 52 (§6.2), zeigt der
  Kachelkopf 1200 ms lang den Chip „Copied“ mit Häkchen (`aria-live="polite"`).
- **Fehlertexte:** `terminal.copyFailed` und `terminal.pasteFailed` statt
  `terminal.openFailed` (§10).

### 6.2 OSC 52

- `term.parser.registerOscHandler(52, …)`, eigener Handler ohne neues Paket.
- **Format** `Pc;Pd`: `Pc` darf leer sein oder aus `c`, `p`, `q`, `s` und `0`–`7`
  bestehen.
- **Was verworfen wird, ohne Antwort:**
  - `Pd` gleich `?`: Lesen wird nie beantwortet.
  - leeres `Pd`
  - ungültiges Base64
  - mehr als 1 MiB nach dem Dekodieren
- **Schreiben:** Base64 wird dekodiert, dann UTF-8 (`TextDecoder`), dann
  `navigator.clipboard.writeText`. Hat das Fenster keinen Fokus, lehnt der
  Browser ab; der Fehler wird still verworfen.
- **Keine Einstellung.** tmux behält `set-clipboard external` (Standard). Damit
  erreichen uns nur Kopien, die tmux selbst anstößt, also das Ziehen und der
  Doppelklick des Nutzers. OSC 52 aus der Programmausgabe verwirft tmux, sodass
  angreiferbeeinflusste Ausgabe (Gesamtspec §8.3) die Zwischenablage nicht
  ersetzen kann.
- **Bewusster Preis:** Die eingebauten Kopierbefehle der Agents erreichen
  Windows nicht.

### 6.3 Rechtsklick

- **Abfangen:** Lauscher in der Capture-Phase am Terminalcontainer der Kachel.
  `mousedown`, `mouseup` und `auxclick` mit Taste 2 werden gestoppt
  (`stopPropagation`), weder xterm noch tmux sehen die rechte Taste. Sonst
  stünden auf Hosts mit `mouse on` zwei Menüs übereinander. `contextmenu`
  bekommt `preventDefault`.
- **Einstellung „Right click“:**
  - **„Menu“** (Standard): öffnet das Terminalmenü.
  - **„Copy/Paste“:** Mit Markierung kopieren und Markierung aufheben, sonst
    einfügen.
- **Terminalmenü:** neue Datei `src/views/terminal-menu.ts`, Stil wie das
  ⋯-Menü der Seitenleiste.
  - Lage am Zeiger, mit `menu-position.ts` im Fenster gehalten.
  - Einträge:
    - „Copy“ mit Kürzel `Ctrl+C`, ohne Markierung deaktiviert
    - „Paste“ mit `Ctrl+V`
    - „Select all“
    - „Find…“ mit `Ctrl+Shift+F`
  - Darunter eine nicht wählbare Hinweiszeile „Shift+drag selects text while a
    program uses the mouse“, aber nur, wenn `term.modes.mouseTrackingMode` nicht
    `none` ist.
  - Bedienung: Pfeile, Enter und Esc. Es schließt bei Klick daneben, Fokusverlust,
    Scrollen und Größenänderung.
- **Einfügen aus Menü und Copy/Paste-Modus:** `navigator.clipboard.readText()`,
  dann `term.paste(text)`. Das braucht den Fensteraufbau aus §8.5.

### 6.4 Maus und Markieren

- **„Copy on select“** (Einstellung, Standard aus): Beim `mouseup` der linken
  Taste im Terminal wird kopiert, wenn `term.hasSelection()` gilt.
  - Nie bei `onSelectionChange`, denn die Suche setzt die Markierung.
  - Die Markierung bleibt sichtbar. Doppel- und Dreifachklick kopieren ebenso.
- **Umschalt+Ziehen** markiert lokal, auch wenn ein Programm die Maus nutzt
  (xterm-Standard). Der Hinweis steht im Terminalmenü und unter Shortcuts.
- **Hosts mit `mouse on`:** Ziehen markiert in tmux, beim Loslassen kopiert tmux
  per OSC 52 (§6.2). Das ist das Verhalten der Nutzerkonfiguration.
- Das Mausrad bleibt unverändert.

### 6.5 Links

- `@xterm/addon-web-links` 0.12.0, passend zu xterm 6.
- **Geöffnet wird nur mit Strg+Klick.** Ein Klick ohne Strg tut nichts. Der
  Tooltip beim Überfahren lautet „Ctrl+click to open“.
- OSC-8-Links (`linkHandler`) folgen derselben Regel.
- **Neuer Command `open_link(url)`:**
  - Rust prüft: Schema `http` oder `https`, keine Leer- und Steuerzeichen,
    höchstens 2048 Zeichen.
  - Danach `tauri_plugin_opener::open_url`.
  - Andere Schemata ergeben einen Fehler ohne Wirkung.
- **ACL:** Die fünf Command-Listen werden nachgezogen: `lib.rs`, `build.rs`,
  `capabilities/default.json`, `tests/capabilities_acl.rs`
  (`EXPECTED_COMMAND_COUNT` 25 → 26) und `tests/acl_runtime.rs`.
- `window.open` entfällt.

### 6.6 Suche

- **Overlay oben rechts in der Kachel**, von links nach rechts:
  - Feld (Platzhalter „Find“)
  - Zähler: „3/17“, ohne Treffer „No results“
  - ↑ (voriger), ↓ (nächster)
  - „Aa“ (Groß/Klein, `aria-pressed`)
  - ✕ (schließen)
- **Suche beim Tippen**, 150 ms entprellt, mit `decorations` aus den
  Thementoken. Sonst feuert `onDidChangeResults` nicht.
- **Tasten:** Enter springt zum nächsten Treffer, Umschalt+Enter zum vorigen.
  Esc schließt mit `stopPropagation`, damit ein maximiertes Terminal maximiert
  bleibt. Strg+Umschalt+F im Feld schließt ebenfalls.
- Durchsucht wird der lokale Puffer, nach §5.6 samt Verlauf.

### 6.7 Schriftgröße

- **Wert:** `ui.terminal_font_size`, ganzzahlig 10–20, Standard 13. Er gilt für
  alle Terminals. Zeilenhöhe 1,15, Laufweite 0 und Schriftfamilie bleiben.
- **Strg+Mausrad über einem Terminal:**
  - Lauscher in der Capture-Phase, `passive: false`, `preventDefault`.
  - Die Rad-Deltas werden aufsummiert. Je 100 Einheiten gibt es einen Schritt
    um 1 px, nach oben größer. Touchpad-Pinch läuft über denselben Weg.
- **Tasten** (Taste nach `event.key`, damit US- und DE-Layout gehen):

  | Taste | Wirkung |
  | --- | --- |
  | Strg+`=`, Strg+`+`, Strg+Num+ | +1 |
  | Strg+`-`, Strg+Num− | −1 |
  | Strg+`0`, Strg+Num0 | zurück auf 13 |

  Die Tasten wirken überall, auch mit Fokus im Terminal (dessen Hilfstextfeld
  zählt nicht als Eingabefeld). Ausnahmen sind Eingabefelder außerhalb von
  `.xterm` und ein offener Dialog.
- **Anwenden:** `TerminalHandle.setFontSize(n)` setzt `term.options.fontSize`
  und ruft `scheduleRefit()`. Das ist der bestehende entprellte Pfad: ein
  `resize_terminal` je Kachel und Geste, und nur, wenn sich Spalten oder Zeilen
  ändern.
- **Speichern:** entprellt nach 500 ms (§9.2).
- **Bekannt:** Ein Zoom in einer Codex-Kachel löst deren `ESC[3J` aus (V12), wie
  jede Größenänderung.

### 6.8 tmux-Serveroptionen der App

- `terminal-overrides` wird angehängt statt ersetzt:
  `set -ga terminal-overrides ',*:smcup@:rmcup@'`.
  - Grund: Auf tmux 3.0 und 3.1 stand `Ms` (OSC 52) für `xterm*` in der
    Standardliste. Beim Ersetzen ginge OSC 52 dort verloren.
  - Wiederholtes Anhängen bei jeder neuen Session auf demselben Server ist
    harmlos. Gleiche Einträge wirken nur einmal, und die Liste beginnt mit jedem
    neuen Server von vorn.
- `set-clipboard` bleibt beim tmux-Standard `external` (§6.2).
- `mouse` setzt die App nicht. Die Nutzerkonfiguration gilt.

### 6.9 Fehlertexte im Terminal

Jeder Fehlerpfad hat einen eigenen Text (§10): Öffnen, Kopieren, Einfügen,
Eingabe und Größe. Ack-Fehler gehen nur in die Konsole.

## 7. Arbeitsplatz und Navigation

### 7.1 Arbeitsplatz merken

Die App speichert in `settings.toml` (§9.2):

- `layout` (1, 2 oder 4)
- `tiles`: je Platz 0–3 Host-Id und Sessionname
- `expanded`: aufgeklappte Hosts
- `connected`: Hosts, die der Nutzer verbunden haben will
- `sidebar_collapsed`
- `sidebar_width`
- je Host das zuletzt genutzte Verzeichnis und die letzten fünf Verzeichnisse

Geschrieben wird entprellt nach 500 ms und nur, wenn sich ein gespeichertes Feld
ändert. Der Status-Poll löst nie ein Schreiben aus.

Pflege von `connected`:

- **Hinzu:** nach jeder erfolgreichen Verbindung, ob von Hand oder automatisch.
- **Weg:** wenn der Nutzer trennt oder den Host entfernt.
- **Bleibt:** ein Host, der am Netz scheiterte.

Wird ein Host entfernt, fallen auch seine Einträge in `tiles`, `expanded` und
`dirs` weg (`remove_host_impl`).

### 7.2 Start

Ist „Restore hosts and terminals“ an (Standard), läuft der Start so:

1. Layout, Seitenleistenbreite, eingeklappter Zustand und aufgeklappte Hosts
   gelten sofort nach dem Laden der Hosts.
2. Hosts aus `connected` mit Anmeldeart `agent` oder `key` werden verbunden,
   höchstens 3 gleichzeitig, in der Reihenfolge der Seitenleiste.
   - Braucht ein Schlüssel eine Passphrase, zeigt der Host das Passphrasefeld
     und wird nicht wiederholt.
   - Passwort-Hosts bleiben offline.
3. Sobald ein Host verbunden ist und `list_sessions` geliefert hat, belegt die
   App dessen gespeicherte Kacheln.
   - Nur, wenn der Platz noch leer ist und die Session noch existiert. Sonst
     bleibt der Platz leer.
   - Wiederhergestellte Kacheln nehmen keinen Fokus.

Ist die Einstellung aus, startet die App wie bisher leer. Gespeichert wird
trotzdem.

### 7.3 Klick auf eine Session eines getrennten Hosts

Der Klick verbindet den Host wie „Connect“ und öffnet die Session, sobald die
Liste sie enthält. Braucht der Host ein Passwort, erscheint das Feld, und die
Session öffnet nach erfolgreicher Verbindung.

### 7.4 Kachelziel (A-03)

- Ziel für die nächste Sessionwahl wird eine Kachel nur durch:
  - einen ausdrücklichen Zeigerklick (`pointerdown`) auf ihren Kopf oder auf
    eine leere Kachel,
  - Strg+Umschalt+1–4.
- `focusin` setzt nur noch den Fokus, kein Ziel. Damit ist der Fokuswechsel ins
  Terminal nach jedem Öffnen kein Zielklick mehr.
- Ein Ziel verfällt, sobald eine Session darin geöffnet wurde. Ohne Ziel gilt
  die bestehende Regel aus `tile-assignment.ts`.

### 7.5 Schnellöffnen (A-04)

- **Aufruf:** Strg+Umschalt+P öffnet den Dialog „Quick open“ über `openDialog`,
  mit Eingabefeld und Ergebnisliste. Neue Datei `src/views/quick-open.ts`.
- **Einträge**, in dieser Reihenfolge:
  1. Wartende Sessions, dann übrige Sessions verbundener Hosts, in der
     Reihenfolge der Seitenleiste. Text: Sessionname, daneben der Host in
     `--ab-text-muted` und die Statuspille. Aktion: Session öffnen wie per
     Klick in der Seitenleiste.
  2. Hosts. Offline: „Connect {host}“. Verbunden: „New session on {host}“.
  3. Aktionen: „Settings“ (`Ctrl+,`), „Layout: 1 terminal“, „Layout: 2
     terminals“, „Layout: 4 terminals“, „Toggle sidebar“ (`Ctrl+Shift+B`).
- **Filter:** Groß/Klein egal. Jeder durch Leerzeichen getrennte Begriff muss
  als Teilstring in Text oder Hostname vorkommen. Höchstens 50 Einträge, ohne
  Treffer „No matches“.
- **Bedienung:** ↑/↓ mit Umlauf, Enter führt aus, Esc schließt, Klick führt aus.
- **ARIA:** `role="listbox"` und `option` mit `aria-selected`, im Feld
  `aria-activedescendant`.

### 7.6 Neue Session (A-05)

- **Fokus:** Er startet im Namensfeld.
- **Namensvorschlag:** Bei jeder Änderung des gewählten Verzeichnisses (Baum,
  Liste der letzten, getippter Pfad) bekommt das Namensfeld den Vorschlag, wenn
  es leer ist oder noch den letzten Vorschlag enthält.
  - Grundlage ist der Ordnername.
  - Zeichen außerhalb von `[A-Za-z0-9 _-]` werden zu `-`, Wiederholungen
    zusammengefasst, Rand-`-` und Leerzeichen entfernt.
  - Der Vorschlag ist höchstens 40 Zeichen lang, das Suffix eingeschlossen;
    getippte Namen bleiben ohne Grenze (es gibt keine bestehende). Ist das
    Ergebnis leer, bleibt das Feld leer.
  - Gibt es den Namen auf dem Host schon, wird `-2`, `-3` … angehängt.
  - Ein Anhängen an fremde Sessions ist ausgeschlossen, denn das Backend lehnt
    Duplikate mit `duplicate` ab.
- **Letzte Verzeichnisse:** höchstens fünf je Host, neueste zuerst, ohne
  Dubletten.
  - Sie stehen als kompakte Liste „Recent“ über dem Baum. Ein Klick wählt.
  - Aktualisiert wird nach jedem erfolgreichen Anlegen.
- **Zuletzt genutztes Verzeichnis:** Der Baum öffnet dort, wie heute, nun auch
  nach einem Neustart.

### 7.7 Host bearbeiten (A-08)

- **Feld „Name“:** optional, oben im Formular. Platzhalter ist der Hostname; ein
  leeres Feld ergibt den Hostnamen als `label`. Gilt für Anlegen und Bearbeiten.
- **Absendeknopf** im Bearbeiten-Modus: „Save“.
- **Speichern, wenn sich nur der Name ändert:** `update_host`, Verbindung und
  Kacheln bleiben.
- **Speichern, wenn sich Hostname, Benutzer, Port, Anmeldeart oder
  Schlüsselpfad ändern:** Zuerst wird gespeichert; scheitert das, bleiben
  Verbindung und Kacheln unberührt. Nach dem Speichern wird ein Host, der
  verbunden sein soll (verbunden, verbindend, fehlgeschlagen oder in einer
  Neuverbindungsreihe), getrennt und einmal mit den neuen Angaben wieder
  verbunden; seine Kacheln bleiben. Ein im Formular getipptes Passwort oder
  eine Passphrase gilt nur für diesen einen Versuch. Fehlt es, erscheint bei
  Passwort-Hosts das Feld in der Seitenleiste.

### 7.8 Seitenleiste

- **Wartende am zugeklappten Host:** Statt „N sessions“ steht eine Waiting-Pille
  mit Zahl, etwa „2 waiting“, im Stil von `status-pill.ts`. Sie steht auch an
  der Stelle der Zustandspille (ein aktueller Wartestatus heißt „Online“), damit
  der Hostname bei 240 px lesbar bleibt.
- **Neu laden:** Der Icon-Knopf `refresh-cw` „Reload sessions“ steht in der
  Aktionsleiste des Hosts, nur bei verbundenem Host mit bereiter Steuerung
  bedienbar. Der Eintrag im
  ⋯-Menü entfällt.
- **Neue Session** in der Aktionsleiste ist ein Icon-Knopf `plus` mit Tooltip
  „New session (Ctrl+Shift+N)“ aus der aktiven Tabelle; Connect/Disconnect
  bleiben Textknöpfe. So bleibt die Leiste ab 208 px einzeilig.
- **Breite:**
  - Ziehgriff von 6 px am rechten Rand, `cursor: col-resize`,
    `role="separator"` mit `aria-orientation="vertical"` und
    `aria-valuenow/min/max`.
  - Grenzen 208–480 px (darunter bricht die Aktionsleiste mit Scrollbalken um;
    gespeicherte 200–207 zeigt das Frontend als 208). Während des Ziehens
    folgt nur die CSS-Breite. Die
    Terminals passen sich einmal beim Loslassen an (`gridHandle.refit()`).
  - Doppelklick setzt 240 zurück. Mit Fokus auf dem Griff ändern ←/→ um ±16 px,
    Pos1 setzt 240.
  - Gespeichert wird `ui.sidebar_width`.
- **Hinweisblöcke:** kompakt nach §5.7.

### 7.9 Strg+Umschalt+N, Leerzustand, Maximiert (A-06, E-04)

**Zielhost von Strg+Umschalt+N**, der erste zutreffende:

1. Host der fokussierten belegten Kachel
2. Host der zuletzt fokussierten belegten Kachel
3. aktiver Host der Seitenleiste, wenn verbunden
4. der einzige verbundene Host
5. sonst Schnellöffnen mit der Vorgabe „New session“; ist kein Host
   verbunden, ohne Vorgabe, damit die Zeilen „Connect {host}“ oben stehen

**Leeres Raster:** zeigt nur wirksame Kürzel: New session (`Ctrl+Shift+N`), Quick
open (`Ctrl+Shift+P`), Sidebar (`Ctrl+Shift+B`), Layout (`Ctrl+Shift+G`), All
shortcuts (`Ctrl+,`).

**Leere Kachel:** „No session here“ / „Pick a session in the sidebar, or press
Ctrl+Shift+N for a new one.“

**Maximiert:**

- Kopf „Maximized · Ctrl+Shift+M“, Ansage „Terminal {index} maximized. Press
  Ctrl+Shift+M to restore.“
- Esc außerhalb des Terminals stellt weiterhin wieder her.

## 8. Tastatur und Fenster

### 8.1 Browser-Tasten und Browsermenü (E-01)

- **Ein Lauscher** `keydown` in der Capture-Phase am `window`.
- **Blockiert** (`preventDefault`) wird außerhalb von `.xterm`, auch in
  Eingabefeldern:
  - F5, Strg+F5, Strg+R
  - Strg+P, Strg+F, F3, Strg+G
  - Strg+S, Strg+O, Strg+U, Strg+J
  - F7, Alt+←, Alt+→
  - BrowserBack, BrowserForward, BrowserRefresh, BrowserSearch
- **Strg+H** wird nur außerhalb von Eingabefeldern blockiert.
- **Bleiben frei:** Bearbeitungstasten (Strg+C/V/X/A/Z/Y, Pfeile) und F12.
- **Im Terminal:** schickt xterm diese Tasten ans Programm.
- **Medientasten** BrowserBack, BrowserForward, BrowserRefresh, BrowserSearch,
  BrowserHome, BrowserStop und BrowserFavorites werden überall blockiert, auch
  im Terminal. xterm schickt sie nicht ans Programm; ohne Sperre fielen sie zu
  WebView2 durch, und BrowserRefresh lüde die App neu.
- **Lesart:** Die Funktionstasten und Medientasten gelten mit jedem
  Modifikator, die Buchstaben auch mit Umschalt (Strg+Umschalt+R lädt sonst hart
  neu). „Eingabefeld“ heißt textartige `input`-Typen und `textarea`.
- **`contextmenu`** wird überall unterdrückt, außer in `input`/`textarea`
  (natives Bearbeitungsmenü) und im Terminal (§6.3).

### 8.2 Kürzel in Eingabefeldern (E-02, E-03)

- **In editierbaren Feldern außerhalb `.xterm`:** Ein Strg+Umschalt-Akkord wird
  nur abgefangen, wenn `matchAction` eine Aktion liefert. Sonst bleibt er beim
  Feld, etwa Strg+Umschalt+←/→/Pos1/Ende/Z. Ausnahme: Strg+Umschalt+V
  (`clipboard.paste`) bleibt beim Feld, damit Chromium nativ als reiner Text
  einfügt. Strg+Umschalt+C bleibt abgefangen.
- **Esc:** Der Handler für Esc beim Maximieren übergeht Ereignisse mit
  `defaultPrevented`.

### 8.3 Kürzelregel und neue Kürzel

**Neue Regel**, Text der Shortcuts-Seite: „App shortcuts use Ctrl+Shift. Ctrl+C
copies when text is selected and Ctrl+V pastes; you can turn both off under
Terminal. Ctrl+, / Ctrl+= / Ctrl+− / Ctrl+0 never reach the terminal.“

**`DEFAULT_KEYMAP` bekommt:**

- `quickOpen`: `Ctrl+Shift+P`
- `settings.open`: `Ctrl+,`

**Ausnahmeliste:** `isReservedForApp` und `validate` in TypeScript und in
`keymap.rs` lassen Strg ohne Umschalt für genau die Tasten `,`, `=`, `-` und `0`
zu. Für diese Tasten erzeugt xterm 6 keine Terminaleingabe (`Keyboard.ts`).
Diese Tests ändern sich:

- `plain_ctrl_bindings_are_rejected` (`keymap.rs`)
- `keymap.test.ts:24-26` und `:120`

**Feste Tasten außerhalb der Tabelle**, weil sie Aliasse brauchen:

- Schriftgröße (§6.7)
- Zwischenablage (§6.1)

**Terminalfokus:** Der Tastenhandler des Terminals lässt Strg+, Strg+= Strg+−
und Strg+0 zum Dokument durch: `false` für xterm, ohne `stopPropagation`.

### 8.4 Tooltips

- Die `title`-Texte nennen das Kürzel aus der aktiven Tabelle, ohne Literal im
  Code, etwa „Maximize (Ctrl+Shift+M)“, „Settings (Ctrl+,)“, „New session
  (Ctrl+Shift+N)“, „Close terminal (Ctrl+Shift+W)“, „Layout (Ctrl+Shift+G)“,
  „Toggle sidebar (Ctrl+Shift+B)“.
- Eigene Tooltip-Komponenten bleiben später.

### 8.5 Fenster

- **Fensteraufbau:** `tauri.conf.json` setzt für das Fenster `main`
  `"create": false`. `setup` baut es mit
  `WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?.enable_clipboard_access().build()?`.
  - Damit erteilt wry die Leseberechtigung, und es erscheint keine Abfrage.
  - Die DevTools im Debug-Bau öffnen erst nach `build()`.
  - Das Label bleibt `main` (`capabilities_acl.rs`).
  - window-state muss die Lage weiter herstellen. Das ist am Fenster zu prüfen.
- **Rückfall:** `tauri-plugin-clipboard-manager` 2.3.3 (die letzte Version für
  tauri ^2.10). Nur, falls `enable_clipboard_access` nicht reicht.
- **Mindestgröße:** 1100×600.
- **Startfläche:** `backgroundColor` `#15171C` im Fenster.
  `<meta name="color-scheme" content="dark">` und Hintergrund am `html`
  verhindern den weißen Blitz.

## 9. Einstellungen

### 9.1 Bereiche

Reihenfolge: General, Appearance, Terminal, Shortcuts, About.

**General** (neu):

- Karte „Startup“ mit dem Schalter „Restore hosts and terminals“ (an).
- Hinweis: „Reconnects hosts that use a key file or the SSH agent and reopens
  your terminals. Hosts with a password stay offline until you connect them.“

**Appearance:** unverändert.

**Terminal** (neu):

- Karte „Text“:
  - „Font size“ als Stepper `−` Wert `+` (10–20) und „Reset“ (13).
  - Hinweis: „Ctrl+mouse wheel or Ctrl+= / Ctrl+− / Ctrl+0 over a terminal.“
- Karte „Clipboard“:
  - Schalter „Copy on select“ (aus).
  - Schalter „Use Ctrl+C and Ctrl+V“ (an), Hinweis: „Ctrl+C copies only when
    text is selected; otherwise it interrupts the program as usual.“
  - „Right click“ als Segmentwahl „Menu“ / „Copy/Paste“ (Menu).
  - Hinweis: „Shift+drag selects text while a program uses the mouse.“

**Shortcuts:**

- Neue Zeilen: Quick open, Open settings, Text size (`Ctrl+=` / `Ctrl+−` /
  `Ctrl+0` und Ctrl+wheel), Copy (`Ctrl+C` with selection, `Ctrl+Shift+C`,
  `Ctrl+Insert`), Paste (`Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert`), Select while
  a program uses the mouse (`Shift+drag`).
- Einleitung nach §8.3.

**About:** neue Zeile „Settings file“ mit dem Pfad, markierbar, in
Monospace-Schrift.

**Schalter:** neue Komponente `button[role="switch"][aria-checked]` im Stil der
Token. Leertaste und Enter schalten um.

### 9.2 `settings.toml`

Die Dateiversion bleibt 1. Alle neuen Felder haben einen serde-Default. Ältere
Builds überlesen sie und lassen sie beim nächsten Speichern weg (hingenommen,
wie in UI-v2 §12.3).

```toml
[ui]
theme = "turquoise"
terminal_font_size = 13      # 10..=20, sonst 13
copy_on_select = false
ctrl_cv_clipboard = true
right_click = "menu"         # "menu" | "paste", sonst "menu"
restore_workspace = true
sidebar_width = 240          # 200..=480, sonst 240

[workspace]
layout = 1                   # 1 | 2 | 4, sonst 1
sidebar_collapsed = false
expanded = ["host_…"]
connected = ["host_…"]
tiles = [{ slot = 0, host_id = "host_…", session = "name" }]   # slot 0..=3, höchstens 4

[workspace.dirs.host_…]
last = "/home/u/projekt"
recent = ["/home/u/projekt"]                              # höchstens 5, nur absolute Pfade
```

- **Command:** `ui_settings` bleibt der einzige, also gibt es keine neuen
  Command-Listen.
  - `UiSettingsDto` liefert alle Felder aus `[ui]`, dazu `workspace` und
    `settings_path`.
  - Der Patch `UiSettingsPatchDto` hat nur optionale Felder und wendet jedes
    einzeln an. `workspace` wird als Ganzes ersetzt, wenn es mitkommt.
  - `{ patch: { theme } }` funktioniert unverändert.
- **Rust klemmt** ungültige Werte auf den Standard und verwirft
  Workspace-Einträge unbekannter Hosts beim Speichern.
- **Fehlermeldungen** der Settings-Commands nennen die volle Ursachenkette
  (`format!("{e:#}")`) und den Pfad.

### 9.3 Testisolation für die Fensterabnahme

Nur im Debug-Bau (`cfg(debug_assertions)`):

- `AGENTBRIDGE_SETTINGS_DIR` ersetzt den Ordner von `settings.toml`.
- `AGENTBRIDGE_TMUX_SOCKET` ersetzt den Socket `agentbridge`. Der Name muss die
  Testsocket-Regeln erfüllen: 1–48 Zeichen `[A-Za-z0-9_-]`, nicht `default`,
  nicht `agentbridge`.

Der Release-Bau überliest beide.

## 10. Texte

Muster: „Was ist passiert. Was tun.“ Rohtexte des Backends stehen nur noch in
„Copy diagnostics“ bzw. „Copy details“ am globalen Banner. Ausnahme: Ist der
Backend-Satz selbst der Hinweis, was zu tun ist, bleibt er sichtbar — die
Ursache beim Entfernen und Bearbeiten eines Hosts (Datei, Pfad), ein
unbestätigtes Beenden einer Session und `outcome_unknown` beim Anlegen
(„erst die Liste neu laden“). Namen stehen immer in '…', Gedankenstrich ist „—“.

| Schlüssel | Neu |
| --- | --- |
| `terminal.openFailed` | Couldn't open '{session}'. It may have ended on the host — reload sessions and try again. |
| `terminal.copyFailed` (neu) | Couldn't copy to the clipboard. |
| `terminal.pasteFailed` (neu) | Couldn't read the clipboard. |
| `terminal.inputFailed` (neu) | Your typing didn't reach '{session}'. Reconnect the terminal. |
| `terminal.resizeFailed` (neu) | Couldn't resize '{session}' on the host. The layout may look off until the next resize. |
| `terminal.connectionLost` | This terminal lost its connection to the session. Reconnect to continue — if the session has ended, you'll see why. |
| `terminal.reconnecting` (neu) | Reconnecting… |
| `terminal.sessionEnded` (neu) | This session has ended on the host. Close the terminal. |
| `sidebar.state.reconnecting` (neu) | Reconnecting… |
| `connect.error` (Code ≠ `other`) | nur die Nutzermeldung des Backends |
| `connect.error` (Code `other`) | Couldn't connect to {host}: {message} |
| `connect.connected` | Connected to {alias}. Checking the host… |
| `firstRun.preflight.failed` (neu) | Connected, but the host check failed: {message}. Go back and try again. |
| `app.hostsLoadFailed` | entfällt: das Backend liefert schon einen vollständigen Satz mit Pfad und Ursache („could not load {path}: {reason}“, auch für eine neuere Datei); das Frontend zeigt ihn unverändert, ohne zweiten Satz drumherum. |
| `sidebar.sessions.loadFailed` (neu) | Couldn't load the session list. Retry — your terminals keep working. |
| `control.unavailable` | Live updates stopped |
| `control.explanation` | The session list and status can't update right now. Your terminals keep working. |
| `control.reconnecting` | Reconnecting live updates… |
| `control.repairSubmit` | Restore updates |
| `control.cancelled` | Cancelled. Updates are still stopped. |
| `sidebar.state.inputLocked`, `tile.inputLocked` | Disconnected |
| `sidebar.state.sessionClosed` | Not open |
| `tile.empty.heading` | No session here |
| `tile.empty.body` | Pick a session in the sidebar, or press {newSession} for a new one. |
| `tile.maximized.hint` | Maximized · {maximize} |
| `settings.themeUnknown` | Your settings name a color theme this version doesn't know ('{name}'). Using Turquoise on Graphite. |
| `sessionDialog.error.nameChars` | Use only letters, digits, spaces, _ and -. tmux would change other characters. |

Rust-Texte:

| Ort | Neu |
| --- | --- |
| Hostschlüssel geändert (`commands.rs:777`) | The host key of {host} has changed. Someone may be intercepting the connection — or the server was reinstalled. If you're sure, remove its old entry from ~/.ssh/known_hosts, for example with ssh-keygen -R "{host}", and connect again. |
| Hostschlüssel nicht bestätigt (`commands.rs:771-773`) | The host key wasn't confirmed, so AgentBridge didn't connect. |
| Hostschlüsselfrage abgelaufen (`connect_control.rs`, Code `connect_timeout`) | The host key wasn't confirmed in time, so AgentBridge didn't connect. |
| Paarprüfung (`connection.rs:55`) | This server answered with a different host key than the open connection. For safety, the second connection was refused. |
| neuere Datei (`settings.rs:186`) | Your settings were saved by a newer AgentBridge. Update AgentBridge to use them — the file was not changed. |

Kürzel stehen in Texten als Platzhalter, die aus der aktiven Tabelle gefüllt
werden, nicht als Literal.

## 11. Barrierefreiheit und Optik

- **Dialoge:** `aria-labelledby` zeigt auf die Überschrift.
- **Formulare:** Feldfehler in Host- und Sessionformular setzen `aria-invalid`
  und `aria-describedby`.
- **Kontrastmodus:** `@media (forced-colors: active)`: Auswahl (Tab, Session,
  Farbfeld, Grundtonkarte) als `outline` in `Highlight`, Farbfelder mit
  `forced-color-adjust: none`.
- **Live-Region:** Die Region für Wartende liegt außerhalb von `#app`, damit sie
  bei offenem Dialog (`inert`) weiter ansagt.
- **Markieren:** `user-select: none` an der Oberfläche. `text` an Feldern, am
  Terminal, an Fehlertexten, am Fingerabdruck, an Pfaden und am
  Einstellungspfad.
- **Erststart:** `.first-run-view` zentriert mit `justify-content: safe center`
  und bekommt den gestalteten Scrollbalken.
- **CSS-Altlasten:**
  - weg: `--ab-space-0`, `--ab-space-9`, `--ab-space-10`,
    `--ab-term-font-size`, `--ab-term-line-height`, `.ab-seg-item` und
    `border-radius: inherit` in der globalen Fokusregel
  - `.base-card` zeichnet die Auswahl als `box-shadow`, damit der Fokusring sie
    nicht verdrängt
- **Optische Mitte (E-10):**
  - Am Fenster messen, ob `text-box` an Flex-Containern wirkt:
    `getComputedStyle(el).textBoxTrim` und Bildschirmfotos bei 100, 125 und
    150 %.
  - Wirkt es nicht, wandert der Trim auf eine innere Textspanne.
- `styles.test.ts` bleibt grün.

## 12. tmux 3.6

Messung vom 11.10.2026 auf 192.0.2.20 (Ubuntu 26.04.1, Paket
`tmux 3.6a-2ubuntu0.1`), mit den bytegenauen Produktbefehlen auf eigenen
Testsockets. Ergebnis: 53 von 53 Prüfungen bestanden.

- **Inventar:** Die Matrix hat dieselben 28 Fälle wie `tmux-3.4.json`, mit
  gleicher Klasse und Form.
- **Sessionbindung:** Alle 14 Sessions werden gebunden. Umbenennen ergibt
  `ListingChanged`, Ersatz unter gleichem Namen `CreationMismatch`.
- **Client:** Die Client-Flags lauten `attached,focused,UTF-8`, mit und ohne
  `~/.tmux.conf`. Der Client ist im ersten Abfrageversuch registriert.
- **Titelbefehl:** liefert die Titel bytegenau.

Entscheidung:

- `MeasuredVersion::V3_6` kommt hinzu, nur für die exakte Ausgabe `tmux 3.6\n`.
  Sie wird überall wie `V3_4` verarbeitet: DirectDisplay-Hülle, bestätigte
  Öffnung, Abwesenheitsbeweis.
- **Fixtures** aus der Messung: `tmux-3.6.json` und
  `2026-10-11-tmux-3.6.jsonl` unter
  `src-tauri/tests/fixtures/tmux-inventory/`. Eine Kopie kommt nach
  `docs/messungen/fixtures/m1-tmux-inventory/`, dazu der Messbericht
  `docs/messungen/messung-2026-10-11-tmux36.md`.
- **Neues Client-Flag:** `attach_confirmation.rs` kennt künftig auch das Flag
  `no-detach-on-destroy` von tmux 3.6. Ein fremder Client mit diesem Flag lässt
  die Auswertung von `list-clients` sonst scheitern.
- **Bleiben bei „Unknown“:** `tmux 3.6a\n` (unverändert gebautes
  Upstream-Release), `tmux 3.5`, `tmux 3.5a` und `tmux 3.6\r\n`. Zulassen erst
  nach eigener Messung.

Abweichungen ohne Folgen für die App:

- tmux 3.6 gibt Befehlsausgaben roh statt maskiert aus.
- Fremde Sessionnamen mit `\` oder `$` erscheinen anders. Die numerische Bindung
  ist davon nicht berührt.

## 13. Tests und Abnahme

- **Je Aufgabe TDD.** Grün sein müssen: `npm test`, `npm run test:scripts`,
  `npm run build`, `cargo fmt --all -- --check`,
  `cargo clippy --locked --all-targets -- -D warnings` und
  `cargo test --locked --all`.
- **Live-Suiten** gegen 192.0.2.20 (tmux 3.6) mit eigenem Testsocket, nach den
  Backend-Aufgaben: Statusabfrage, Verlauf, tmux 3.6. Nie gegen 192.0.2.10,
  solange dort produktive Sessions laufen.
- **Fensterabnahme** mit eigener Instanz: `AGENTBRIDGE_SETTINGS_DIR`,
  `AGENTBRIDGE_TMUX_SOCKET`, eigener WebView2-Datenordner
  (`WEBVIEW2_USER_DATA_FOLDER`; vorher prüfen, dass er wirkt) und
  `--remote-debugging-port`. Geprüft wird bei 100, 125 und 150 %:
  - Strg+C/V
  - Terminalmenü
  - Drag-Kopie per OSC 52 auf einem Host mit `mouse on`
  - Verlauf nach Maximieren
  - Zoom
  - Schnellöffnen
  - Wiederherstellen beim Start
  - Selbstreparatur nach künstlichem Abbruch
  - E-10
- **Dokumentation:** Die Handabnahme (`docs/abnahme-handarbeit.md` §2, §5, §6,
  §9.6) folgt den neuen Regeln.

## 14. Nicht in dieser Überarbeitung

| Thema | Grund |
| --- | --- |
| Editor für eigene Kürzel (E-07) | der Nutzer will ihn später; die Ausnahmeliste und die neuen Aktionen bereiten ihn vor |
| Lebendprobe per SSH-Ping, kein Abbruch beim Kanalöffnen (V-06) | 5–8 h, berührt die russh-Transportschicht; die Selbstreparatur fängt die Folgen ab |
| Hosts gesammelt aus `~/.ssh/config` anlegen (A-09) | widerspricht der Prüfung vor dem Speichern (Gesamtspec §7.6) |
| Gruppen und Tags für Hosts | Schnellöffnen deckt das Finden ab; später bei Bedarf |
| mehr als 4 Kacheln, Tabs, Sessions umbenennen | UI-v2 §8; Umbenennen hieße zusätzlich auf die VM schreiben |
| Snippets, Broadcast, SFTP, Portweiterleitung, Jump-Host | außerhalb des Produktkerns, teils schreibend auf der VM |
| Warnung vor großem Einfügen, Cursorform, Schriftfamilie | Bracketed Paste genügt; kein Alltagsgewinn |
| Taskleisten-Overlay mit Zahl der Wartenden | später; Titel und Blinken genügen vorerst |
| Fortschritt beim Verbindungsaufbau (V-10) | später |
| OSC 52 aus Programmen (`set-clipboard on`) | Sicherheit (§6.2) |

## 15. Umsetzungsreihenfolge

1. Steuerzustand und Statusabfrage, Rust (§5.1, §5.2)
2. Zwischenablage im Terminal (§6.1, §6.2)
3. Steuerzustand in der Oberfläche, Selbstreparatur, kompakte Hinweise (§5.2
   Frontendteil, §5.3, §5.7)
4. Kleine Backend-Bausteine: Fensteraufbau mit Zwischenablage, Mindestgröße,
   Startfläche, `terminal-overrides`, `open_link`, Testisolation (§6.5, §6.8,
   §8.5, §9.3)
5. tmux 3.6 (§12)
6. Einstellungsschema in Rust (§9.2)
7. Schnitt in `main.ts`: Dialoghülle, Tastatur, Arbeitsplatzzustand in eigene
   Module
8. Tastaturgrenzen außerhalb des Terminals (§8.1, §8.2)
9. Terminalmenü und Copy on select (§6.3, §6.4)
10. Links und Suche (§6.5, §6.6)
11. Verlauf beim Anhängen (§5.6)
12. Neuverbinden und stilles Wiederanhängen (§5.4, §5.5)
13. Einstellungsbereiche, Schriftgröße, neue Kürzel, Tooltips (§6.7, §8.3, §8.4,
    §9.1)
14. Arbeitsplatz merken und wiederherstellen, Klick auf getrennten Host (§7.1–7.3)
15. Kachelziel, Strg+Umschalt+N, Leerzustand (§7.4, §7.9)
16. Schnellöffnen (§7.5)
17. Neue Session (§7.6)
18. Host bearbeiten und Seitenleiste (§7.7, §7.8)
19. Texte (§10)
20. Barrierefreiheit und Optik (§11)
21. Doku, Fensterabnahme, Abschluss
