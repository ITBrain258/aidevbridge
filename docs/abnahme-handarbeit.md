# Abnahme von Hand

Was die automatischen Tests nicht prüfen können: Wahrnehmungsfragen wie
Farben, Maus und Bracketed Paste, ob das Fenster unter Dauerlast einfriert,
was beim harten Verbindungsabriss und beim Wiederverbinden auf dem Bildschirm
passiert und ob Status und Aufmerksamkeit richtig ankommen. Dazu kommen die
echte Windows-Zwischenablage, Tastatur und Skalierung, Standby und
Netzwechsel, Bildschirmleser und Kontrastdesign. Dafür muss ein Mensch einmal
vor dem echten Fenster sitzen.

Die Liste bleibt kurz: nur, was `src-tauri/tests/acceptance_vm.rs` und die
Frontendtests strukturell nicht erreichen. Befehle, Anmeldezweige, TOFU und
Sitzungsablauf deckt `acceptance_vm.rs` ab.

## Voraussetzungen

- Die Release-EXE (`npm run build:app`, dann `target/release/aidevbridge.exe`)
  oder `npm run tauri dev`. Beides öffnet ein echtes WebView2-Fenster, keinen
  Browser-Tab.
- Ein erreichbarer Testhost mit entbehrlichen Testsessions. Keine produktiven
  Agent-Sessions beenden. `192.0.2.10` (tmux 3.3a) und `192.0.2.20` (tmux 3.6)
  stehen hier und im Log für die beiden eigenen Test-VMs (Platzhalter nach
  RFC 5737).
- Für den Verbindungsabriss (Punkt 5) eine Möglichkeit, die Route zur VM kurz
  zu kappen, etwa eine Firewall-Regel für ihre IP oder den getrennten
  Netzwerkadapter der VM. Die App zu beenden ist kein Abriss.
- Für Punkt 5 und 6 ein Host mit Schlüsseldatei oder ssh-agent ohne
  Passphrase (er heilt sich selbst), nach Möglichkeit dazu ein Passwort-Host.
- Für Punkt 2 ein Host mit `set -g mouse on` in `~/.tmux.conf`, etwa
  192.0.2.20 (tmux 3.6), und ein zweites Windows-Programm zum Einfügen, etwa
  den Editor.
- Windows-Skalierung 100, 125 und 150 % (Einstellungen → System →
  Bildschirm) für Punkt 1 und 2.
- Wer die eigene `settings.toml` und den Socket `agentbridge` schonen will,
  startet einen Debug-Bau mit `AIDEVBRIDGE_SETTINGS_DIR` und
  `AIDEVBRIDGE_TMUX_SOCKET` (UX-Spec §9.3). Eine solche Testinstanz übernimmt
  keine alten Einstellungen, außer `AIDEVBRIDGE_LEGACY_SETTINGS_DIR` nennt
  einen alten Testordner (absoluter Pfad, darin eine `settings.toml` wie in
  `%APPDATA%\agentbridge\`). Der Release-Bau überliest alle drei.

## Wo das Ergebnis eingetragen wird

Im Log am Ende: je Durchlauf eine Zeile mit Datum, Person und Build (Version
und Commit aus der Seitenleiste), jeder Punkt mit bestanden oder abweichend.
Ein Befund, der den Release blockiert, kommt zusätzlich unter „Offen bis zum
Release“ in [`docs/stand.md`](stand.md).

---

## 1. Farben und Darstellung

**Was zu tun ist:** Unter Einstellungen → Appearance beide Grundtöne (Graphit,
Schiefer) und die sieben Akzente durchschalten. Die App hat nur dunkle
Varianten und folgt nicht dem Windows-Design. Je Variante Seitenleiste,
Kachelraster, Terminaltext, Statuspillen, Suchtreffer (Ctrl+Shift+F), die
TOFU-Rückfrage (provozieren wie in Punkt 7) und den Verbindungsverlust
(Punkt 5) ansehen. Einmal ein Windows-Kontrastdesign einschalten
(Einstellungen → Barrierefreiheit → Kontrastdesigns). Bei 100, 125 und 150 %
Skalierung das Terminalmenü (Rechtsklick), Einstellungen → Terminal sowie
Knöpfe, Pillen und Chips ansehen.

**Was zu sehen sein muss:** Text ist auf jedem Grund lesbar. Terminalgrund und
xterm-Palette passen zur Oberfläche, kein Element bleibt in einer anderen
Variante hängen. Suchtreffer sind in allen 14 Varianten zu erkennen.
Gefahrknöpfe bleiben auch mit rotem Akzent erkennbar (Warnsymbol),
„Connecting“ wirkt auch mit grünem Akzent nicht wie verbunden. Im
Kontrastdesign ist der Fokus durchgezogen und die Auswahl (Tab, Session,
Farbfeld, Grundtonkarte) gestrichelt, beides in der Systemfarbe Highlight;
die Linie des Seitenleisten-Griffs bleibt sichtbar. Bei jeder Skalierung
liegen Menü, Schalter, Stepper und Segmentwahl sauber und ungeschnitten, und
Text sitzt in Knöpfen, Pillen und Chips optisch mittig (E-10,
`text-box-trim`). Unterlängen (g, j, p, y) und Klammern in Host- und
Sessionnamen, im Verzeichnisbaum und in den Kachelköpfen sind vollständig;
lange Namen enden in der Seitenleiste und in schmalen Kachelköpfen (fünf oder
mehr Kacheln, drei in einer Reihe) mit „…“.

**Wo eintragen:** Spalte „Farben“: geprüfte Varianten und Skalierungen und ob
etwas unlesbar war oder schief saß, mit Screenshot-Pfad, falls einer gemacht
wurde.

## 2. Maus und Zwischenablage

**Was zu tun ist:**

- Eine Kachel per Klick fokussieren, eine Kachel über ihren Knopf maximieren
  und wiederherstellen.
- Im Terminal mit der Maus markieren, mit Ctrl+C kopieren und im Editor
  einfügen; ohne Markierung Ctrl+C in einem laufenden `sleep 100` drücken.
  Text aus dem Editor mit Ctrl+V, Ctrl+Shift+V und Shift+Insert ins Terminal
  einfügen. Ctrl+Shift+C und Ctrl+Insert kopieren ebenso.
- Rechts ins Terminal klicken, das Menü mit Pfeilen, Enter und Esc bedienen,
  einmal „Paste“ wählen; einmal mit der Menütaste der Tastatur öffnen. Unter
  Einstellungen → Terminal „Right click“ auf „Copy/Paste“ stellen, je einmal
  mit und ohne Markierung rechts klicken, danach zurück auf „Menu“.
- „Copy on select“ einschalten und markieren. Dann im Terminal drücken, mitten
  im Ziehen per Alt+Tab das Fenster wechseln und dort loslassen.
- Auf dem Host mit `mouse on` ohne Shift ziehen, danach mit Shift.
- AltGr-Zeichen (`@ € \ { } [ ] | ~`) eingeben, während im Terminal eine
  Markierung besteht.
- Fenster über 30 s minimieren, während ein Agent arbeitet; danach stimmt die
  Anzeige und die Kachel ist ohne Neuaufbau da.
- Mit `echo https://example.org` einen Link ausgeben, ihn überfahren, einmal
  klicken, dann mit Ctrl klicken.
- Die Suche (Ctrl+Shift+F) bedienen: tippen, ↑ und ↓, „Aa“, ✕; einmal auf den
  Zähler klicken, weiter tippen, Enter und Esc drücken; einmal in einer
  schmalen Kachel (fünf oder mehr Kacheln, drei in einer Reihe).
- Ctrl+Mausrad über einem Terminal Rastung für Rastung drehen, einmal per
  Touchpad zoomen; Ctrl+Mausrad auch über der Seitenleiste.
- Den Griff am rechten Rand der Seitenleiste bis zum Anschlag ziehen und per
  Doppelklick zurücksetzen, mit so vielen Hosts, dass die Liste scrollt.
- Text in der Sperrleiste einer Kachel und im Hinweis zum Schlüsselordner im
  Hostformular zu markieren versuchen.

**Was zu sehen sein muss:**

- Jede Aktion reagiert sofort und eindeutig. Die Markierung sieht aus wie in
  jedem anderen Terminal (zusammenhängender Block, keine abgeschnittenen
  Zeilen).
- Ctrl+C mit Markierung kopiert, hebt die Markierung auf und schickt nichts
  ans Terminal; ohne Markierung bricht es `sleep` ab. Einfügen fragt nie nach
  einer Erlaubnis. Jede Kopie zeigt im Kachelkopf kurz „Copied“, ein
  Bildschirmleser (Sprachausgabe) sagt es an.
- Rechtsklick zeigt nie das Browsermenü und auf `mouse on`-Hosts kein
  tmux-Menü darüber; das Menü kommt, obwohl die App das rechte `mouseup`
  abfängt. Es liegt bei 100, 125 und 150 % ganz im Fenster und zeigt einen
  Fokusring; die Menütaste öffnet es an einer sinnvollen Stelle.
  „Copy/Paste“ kopiert mit Markierung und fügt sonst ein.
- Copy on select kopiert beim Loslassen. Nach Alt+Tab mitten im Ziehen bleibt
  die Zwischenablage unverändert.
- `mouse on`: Ziehen markiert in tmux, beim Loslassen liegt der Text in der
  Windows-Zwischenablage. Shift+Ziehen markiert lokal, und das Menü nennt
  dort „Shift+drag selects text while a program uses the mouse“.
- Auf einem Host mit `mouse on` markiert Ziehen in tmux und kopiert beim
  Loslassen (Chip „Copied“). Ein Strg+C direkt danach findet keine Markierung
  im Terminal und geht als ^C an die Shell (Spec §6.1/§6.4). Beurteilen, ob
  das im Alltag stört.
- Mit bestehender Markierung kommen die AltGr-Zeichen ebenso im Terminal an;
  das Tippen selbst löst kein neues „Copied“ aus.
- Der Link zeigt das Windows-Tooltip „Ctrl+click to open“; ein Klick ohne
  Ctrl tut nichts, Ctrl+Klick öffnet den Standardbrowser.
- Die Suche zeigt „n/m“ oder „No results“; nach dem Klick auf den Zähler
  landen Tippen, Enter und Esc weiter in der Suche. Die Leiste passt in die
  schmale Kachel.
- Ctrl+Mausrad ändert die Schrift genau eine Stufe je Rastung, bei 100, 125
  und 150 %; Touchpad-Zoom wirkt ebenso. Die Seite selbst zoomt nie, auch
  nicht über der Seitenleiste.
- Die Liste der Seitenleiste scrollt. Beim Ziehen des Griffs wird kein Text
  markiert, der Zeiger bleibt der Doppelpfeil (`col-resize`), die Linie ist
  beim Überfahren gut zu sehen. Die Aktionsleiste jedes Hosts bleibt bei 208
  und 240 px einzeilig, mit und ohne Scrollbalken.
- Die Sperrleiste ist absichtlich nicht markierbar, der Hinweis zum
  Schlüsselordner schon.

**Wo eintragen:** Spalte „Maus“.

## 3. Bracketed Paste

**Was zu tun ist:** Mehrzeiligen Text in die Zwischenablage legen, etwa ein
kleines Shell-Skript mit drei oder vier Zeilen, darunter mindestens eine
eingerückte. Per Ctrl+V in ein laufendes Terminal einfügen, einmal in eine
reine Shell (`bash`), einmal in ein Programm, das Bracketed Paste selbst
auswertet (etwa ein Python-REPL, `nano` oder `vim`). Einmal zusätzlich über
„Paste“ im Rechtsklickmenü.

**Was zu sehen sein muss:** Der Text kommt als ein zusammenhängender Block an
und wird nicht Zeile für Zeile ausgeführt. Im Programm mit Bracketed Paste
bringt er Einrückung und Vervollständigung des Editors nicht durcheinander.

**Wo eintragen:** Spalte „Bracketed Paste“: welches Programm, ob der Text als
Block ankam.

## 4. Fenster mehr als 10 Minuten minimiert unter Dauerausgabe

**Was zu tun ist:** Eine Session öffnen und eine Dauerausgabe starten, die
mindestens 10 Minuten läuft (etwa `yes | pv -L 200k` oder
`while true; do date; sleep 0.2; done`). Das Fenster minimieren, nicht
schließen, mindestens 10 Minuten warten, dann wiederherstellen.

**Was zu sehen sein muss:** Die App reagiert nach dem Wiederherstellen sofort,
ohne mehrsekündiges Einfrieren; Windows meldet währenddessen nie „Keine
Rückmeldung“ (im Task-Manager prüfbar). Das Terminal zeigt den aktuellen Stand
der Ausgabe. Hat die Kachel im minimierten Fenster ihren Kanal verloren, zeigt
sie nach dem Wiederherstellen kurz „Reconnecting…“ und hängt sich ohne Klick
mit Verlauf wieder an; die Sperrleiste „Disconnected“ erscheint dabei nicht.
Der Arbeitsspeicher von `aidevbridge.exe` und den WebView2-Prozessen ist nach
den 10 Minuten nicht um ein Vielfaches gewachsen (grobe Kontrolle der
Rückstaubremse aus Spec §9.1 unter echter Minimierung).

**Wo eintragen:** Spalte „Dauerlast“: Speicherwert vorher und nachher, ob ein
Einfrieren auftrat.

## 5. Harter Verbindungsabriss

**Was zu tun ist:** Auf dem Host mit Schlüsseldatei oder ssh-agent eine
Session öffnen, etwas tippen, dann die Route zur VM hart kappen. Nicht über
„Disconnect“ in der Oberfläche; diesen gewollten Pfad decken
`acceptance_vm.rs` und `integration_commands.rs` ab. Danach im Terminal weiter
tippen und die Route mindestens fünf Minuten gekappt lassen. Falls vorhanden,
mit dem Passwort-Host wiederholen.

**Was zu sehen sein muss:** Die App friert nicht ein; andere Kacheln und die
Seitenleiste bleiben bedienbar, kein unbehandelter Fehlerdialog. Die
Statuspillen zeigen „As of HH:MM“ statt des letzten Werts. Binnen weniger
Sekunden steht unter der Hostzeile die ruhige Zeile
„Reconnecting live updates…“, kein Kasten. Spätestens nach rund einer Minute
ohne Antwort (SSH-Keepalive alle 15 s) steht dort „Reconnecting…“, und jede
Kachel des Hosts zeigt im Kopf „Reconnecting…“ statt der Sperrleiste;
Eingaben sind gesperrt, die Zeilenzahl des Terminals bleibt gleich. Die
Versuche laufen nach 2, 5, 15, 30 und 60 s (je ±20 %). Nach dem fünften
Fehlschlag steht am Host „Connection failed“ mit „Retry“, an den Kacheln die
Sperrleiste „Disconnected“ mit „Reconnect“. Der Passwort-Host versucht nichts
selbst: Binnen weniger Sekunden erscheint der Kasten „Live updates stopped“
mit „Restore updates“, mit dem Ende der Terminalverbindung gleich
„Connection failed“ mit „Retry“ und an den Kacheln die Sperrleiste.

**Wo eintragen:** Spalte „Abriss“: wie lange bis „Reconnecting…“ und bis zum
Ende der Versuche, ob die App bedienbar blieb.

## 6. Wiederverbinden

**Was zu tun ist:**

- Punkt 5 wiederholen und die Route freigeben, solange der Host
  „Reconnecting…“ zeigt; nichts anklicken. Einmal das Fenster direkt nach der
  Freigabe in den Vordergrund holen.
- Nach dem Ende der Versuche (Punkt 5) die Route freigeben und „Retry“ in der
  Seitenleiste oder „Reconnect“ in der Kachel wählen. Beim Passwort-Host zeigt
  das erste „Retry“ das Passwortfeld; Passwort eingeben und erneut „Retry“.
- Nur die Steuerung trennen: auf der VM den sshd-Prozess der
  Kontrollverbindung beenden (wie in Punkt 9, Schritt 6), einmal am Schlüssel-
  oder Agent-Host, einmal am Passwort-Host.
- Den Rechner mit offenen Kacheln mindestens 10 Minuten in den Standby
  schicken und aufwecken; einmal das WLAN oder das VPN wechseln.
- Bei einem verbundenen Passwort-Host eine Verbindungsangabe ändern und
  „Save“ wählen, während das Speichern scheitert (etwa mit
  schreibgeschützter `settings.toml`; den Pfad zeigt Einstellungen → About).
  Danach ohne Schutz erneut „Save“ wählen.
- Mindestens einen Arbeitstag mit laufenden Terminals arbeiten.

**Was zu sehen sein muss:**

- Der Schlüssel- oder Agent-Host verbindet sich ohne Klick wieder, beim
  nächsten Versuch oder sofort, sobald das Fenster den Fokus bekommt oder das
  Netz zurück ist. Seine Kacheln hängen sich mit Verlauf wieder an (nach oben
  scrollen: die alte Ausgabe ist da, keine Zeile doppelt) und behalten den
  Fokus. Nach der ersten gelungenen Abfrage zeigen die Pillen wieder aktuelle
  Werte; kein Neustart der App nötig.
- „Retry“ und „Reconnect“ ergeben eine funktionierende Verbindung; eine neue
  Session anlegen oder eine bestehende öffnen gelingt. Bei Passwort oder
  Passphrase erscheint die passende Abfrage. Eine tote Kachel bleibt als
  verloren erkennbar oder lässt sich schließen und sieht nie lebendig aus,
  ohne es zu sein.
- Nur Steuerung: Am Schlüssel- oder Agent-Host steht unter der Hostzeile
  „Reconnecting live updates…“, kein Kasten; Terminals bleiben bedienbar,
  nach wenigen Sekunden sind die Werte wieder aktuell. Am Passwort-Host
  erscheint der Kasten „Live updates stopped“ mit „Restore updates“.
- Nach Standby und Netzwechsel dasselbe ohne Klick: verbunden, der Verlauf ist
  lesbar (Tor von M2).
- Das gescheiterte Speichern nennt Datei und Ursache, Verbindung und Kacheln
  bleiben unberührt. Beim zweiten „Save“ trennt der Host, behält seine
  Kacheln und fragt in der Seitenleiste nach dem Passwort.
- Über den Arbeitstag erscheint in der Hostzeile keine Verbindungsmeldung,
  solange das Terminal läuft.

**Wo eintragen:** Spalte „Wiederverbinden“.

## 7. Nur Tastatur, mit TOFU

**Was zu tun ist:** Maus weglegen. Den Host per Tab und Enter verbinden, eine
TOFU-Rückfrage provozieren (den Eintrag aus einer Kopie von `known_hosts`
entfernen, nie aus dem Original) und bei offener Rückfrage mit Tab durch das
Fenster gehen. Danach mit Ctrl+Shift+1 bis 9 und Ctrl+Shift+↑/↓ zwischen den
Kacheln wechseln, mit Ctrl+Shift+Bild↑/↓ eine verschieben, mit Ctrl+Shift+A
zur nächsten wartenden Session springen und die Einstellungen mit Ctrl+,
öffnen: Pfeiltasten, Pos1 und Ende wechseln dort den Bereich; einen Schalter
einmal mit der Leertaste und einmal mit Enter umschalten. Weiter:

- Ctrl+Shift+P: tippen, mit ↑ und ↓ wählen, Enter. Ctrl+Shift+N, im Dialog
  mit Tab über die bis zu fünf Einträge „Recent“ gehen.
- Im Terminal auf deutscher Tastatur mit AltGr `@ € \ { } [ ] | ~` tippen,
  dann Ctrl+= Ctrl+- und Ctrl+0 drücken, zuletzt Ctrl+, (öffnet die
  Einstellungen; mit Esc schließen). Ctrl+= und Ctrl+- auch einmal mit Fokus
  in der Seitenleiste drücken.
- Außerhalb des Terminals, auch in einem Eingabefeld, F5, Ctrl+R und
  Ctrl+Shift+R drücken; im Terminal Ctrl+R. Hat die Tastatur Medientasten für
  Zurück, Vor oder Aktualisieren, diese drücken.
- Die App schließen und neu starten.

**Was zu sehen sein muss:** Hinter dem Dialog bekommt kein Element den Fokus.
Escape oder „Reject“ schließt, der Fokus kehrt an den Ausgangspunkt zurück.
Die Kürzel treffen die Kachel mit dieser Nummer, im Terminal erscheint dabei
kein Zeichen. Ein Schalter wechselt je Druck genau einmal. Alle AltGr-Zeichen
kommen im Terminal an; Ctrl+= Ctrl+- Ctrl+0 und Ctrl+, erzeugen dort keine
Eingabe, Ctrl+= und Ctrl+- ändern nur die Schrift der Terminals und zoomen nie
die Seite, auch nicht mit Fokus in der Seitenleiste. F5, Ctrl+R und
Ctrl+Shift+R laden außerhalb des Terminals nichts neu, im Terminal startet
Ctrl+R die Rückwärtssuche der Shell. Medientasten lösen nichts aus. Ob die
fünf „Recent“-Einträge als einzelne Tab-Halte stören, notieren. Nach dem
Neustart stehen Fenstergröße und -lage wie zuvor, Schlüssel- und Agent-Hosts
verbinden sich, ihre Kacheln kommen zurück, Passwort-Hosts bleiben offline.

**Wo eintragen:** Spalte „Tastatur“.

## 8. Status und Aufmerksamkeit

**Was zu tun ist:** Auf dem Testhost je eine entbehrliche Session mit Claude
Code und Codex (Grok vorerst nicht, Entscheidung vom 23.10.) von Hand
starten, mit Rückfragen wie in Punkt 9, und jeden Agent einmal arbeiten, auf
eine Freigabe warten und ruhen lassen; mindestens einen davon auf einem Host
mit tmux 3.6 (192.0.2.20). Das Fenster zwischendurch in den Hintergrund legen.
Einen Host mit wartender Session in der Seitenleiste zuklappen, bei 208 und
240 px Breite. Zum Schluss einen Agent beenden und eine Pane schließen.

**Was zu sehen sein muss:** Die Pille in Sessionzeile und Kachelkopf zeigt
Busy, Waiting und Idle mit Form und Wort, der Tooltip nennt den Grund. Auf
tmux 3.6 öffnet die Session ohne Verzögerung, nimmt Eingaben an und zeigt
einen Status statt „Unknown“. Nach dem Beenden des Agents steht „Unknown“,
nach dem Ende der Pane „Ended“. Der Fenstertitel zählt die wartenden
Sessions, beim ersten Warten blinkt die Taskleiste einmal, Ctrl+Shift+A
springt hin. Der zugeklappte Host zeigt „1 waiting“ an der Stelle der
Zustandspille, sein Name bleibt daneben lesbar. Die Sessionliste ändert sich
dabei nicht von selbst. Oben in der Seitenleiste führt die Wartet-Spur die
wartenden Sessions, die älteste zuerst, mit Wartezeit und Grund; sie öffnet von
selbst keine Kachel.

**Wo eintragen:** Spalte „Status“: Agent und Version, welche Zustände richtig
ankamen.

## 9. M1-Tor

Einmal vor dem Tag `v0.2.0`, zu zweit: eine Person am Fenster, eine per SSH
auf den VMs (nur mitlesend, außer in Schritt 6). Die Bedingungen stehen in der
[MVP-Spec](specs/2026-09-05-mvp-und-statuspunkt-design.md) §3.4 mit den
Nachträgen vom 13.09. und 14.09., für das Raster (Schritte 3, 4 und 10 bis 12)
in der [Raster-Spec](specs/2026-10-19-dynamisches-raster-design.md) §10.2.
Zuletzt gemessen am 23.10.: Claude Code 2.1.309, Codex 0.163.0 und 0.164.0
([Messung](messungen/messung-2026-10-23-agentversionen.md)); Schritt 1 belegt
die Versionen am Tag des Tors. Grok ist vorerst nicht Teil des Tors
(Entscheidung des Maintainers vom 23.10.). API-Fehler lassen sich am Fenster
nicht auslösen, dafür gelten die Fehlermessungen vom 12.09. (nicht im
öffentlichen Repository).

**Vorbereitung**

- Frische Release-EXE vom aktuellen `main`, Version und Commit aus der
  Seitenleiste ins Log.
- Beide VMs verbinden: `192.0.2.10` (tmux 3.3a) und `192.0.2.20` (tmux 3.6).
- Für Schritt 10 einen dritten Hosteintrag anlegen: `192.0.2.20` ein zweites
  Mal unter dem Namen `m1-drei` (die App fragt nach, ob ein zweiter Eintrag
  für dieselbe Verbindung gewollt ist), mit Schlüssel oder ssh-agent; ein
  Passwort-Host bliebe beim Neustart in Schritt 10 offline. Den Eintrag erst in
  Schritt 10 verbinden: er teilt den tmux-Server mit `192.0.2.20`, verbunden
  zeigte er dieselben Sessions ein zweites Mal und zählte Wartende doppelt.
- Eine Uhr mit Sekunden sichtbar halten, etwa die Taskleistenuhr
  (Einstellungen → Personalisierung → Taskleiste).
- Dreizehn Sessions über „New session“ anlegen, Arbeitsordner `/tmp`, und in
  den Agent-Sessions den Agent von Hand starten. Jede neue Session öffnet
  eine Kachel; zeigt „New session“ an einer Grenze statt des Dialogs den
  Hinweis, erst Kacheln schließen:

  | Host | Flut | Agents |
  |---|---|---|
  | 192.0.2.10 | `m1-f1`, `m1-f2` | `m1-claude1` (`claude`), `m1-codex1` (`codex`) |
  | 192.0.2.20 | `m1-f3` bis `m1-f9` | `m1-claude2` (`claude`), `m1-codex` (`codex`) |

  `m1-f5` ist die eigene Session von `m1-drei`: Sie liegt auf demselben
  tmux-Server, geöffnet wird sie aber nur in Schritt 10 und nur über `m1-drei`.
  `m1-f6` bis `m1-f9` braucht erst Schritt 10: Mit ihnen zeigt 192.0.2.20 acht
  Kacheln.

  Die Agents so starten, dass sie zurückfragen: `claude --permission-mode
  default` und `codex -a on-request`. Ein Auto-Modus gibt Befehle selbst
  frei, und es gibt nichts zu warten.
- Vor Schritt 3 alle übrigen Kacheln schließen; danach öffnet jeder Klick eine
  Kachel dazu.

**Schritte**

1. **Claude-Zustände.** In `m1-claude1`: „Führe
   `sleep 20 && touch /tmp/m1-probe && echo fertig` mit Bash aus.“
   Freigeben. Danach denselben Auftrag mit „No“ ablehnen, ein drittes Mal
   freigeben und während der Arbeit Esc drücken. (Ohne `touch` führt Claude
   Code 2.1.309 den Befehl ohne Rückfrage aus.)
   Erwartung: Busy beim Nachdenken, Waiting bei jeder Freigabe, Busy
   während `sleep`, Idle nach dem Ende, nach „No“ und nach Esc. Pille in
   Sessionzeile und Kachelkopf gleich, der Tooltip nennt den Grund. Per SSH
   werden dabei `claude agents --json` und der Pane-Inhalt mit Zeitstempel
   aufgezeichnet; daraus folgt die Signalverzögerung des Agents getrennt von
   der App.
2. **Freigabe bei geschlossener Kachel.** In `m1-claude1`: „Führe
   nacheinander einzeln mit Bash aus: `sleep 15 && touch /tmp/m1-a`,
   `sleep 15 && touch /tmp/m1-b`, `touch /tmp/m1-c`.“ Die erste Freigabe
   erteilen, die Kachel schließen, das Fenster in den Hintergrund legen.
   Erwartung: Bei der zweiten Freigabe zeigt die Sessionzeile Waiting, der
   Fenstertitel zählt sie, die Taskleiste blinkt einmal, Ctrl+Shift+A
   springt hin. Freigeben, Kachel wieder schließen; bei der dritten
   Freigabe dasselbe.
3. **BEL und Resize.** In `m1-f1`: `printf '\a'`. In `m1-f2`:
   `trap 'echo WINCH' WINCH; while :; do sleep 1; done`. Nur `m1-f1` und
   `m1-f2` sind offen. Mit Ctrl+Shift+1 und 2 und per Klick zwischen den
   Kacheln wechseln, danach `m1-f2` maximieren und wiederherstellen, dann
   `m1-f3` öffnen und wieder schließen.
   Erwartung: BEL ändert keinen Status. Beim Wechsel erscheint in `m1-f2`
   kein „WINCH“; beim Maximieren, beim Wiederherstellen und beim Öffnen und
   Schließen von `m1-f3` je eines, denn dabei ändert sich die Größe der
   Kachel (Spec 2026-10-19 §4.5). Danach die Schleife mit Ctrl+C beenden.
4. **Vier flutende Kacheln.** In `m1-claude2`: „Schreibe ein Gedicht mit
   40 Zeilen über Leuchttürme und speichere es als `/tmp/m1-gedicht.txt`.“
   Gleich danach `m1-f3` und `m1-f4` per Klick öffnen (`m1-f1` und `m1-f2`
   sind aus Schritt 3 noch offen) und in allen vier Flut-Kacheln `yes`
   starten.
   Erwartung: Die Sessionzeile von `m1-claude2` springt auf Waiting und
   steht oben in der Wartet-Spur, sobald Claude um Freigabe fragt; die
   Sekunde notieren. Per SSH wird sie mit dem Zeitpunkt aus
   `claude agents --json` verglichen, der Uhrabstand der VMs wird
   herausgerechnet.
   Ziel: binnen 4 s. Das Fenster bleibt bedienbar. Danach `yes` in allen
   vier Kacheln mit Ctrl+C beenden und Claude mit „No“ antworten.
5. **Codex.** In `m1-codex1` und `m1-codex` je eine kleine Aufgabe geben,
   in `m1-codex` eine mit Freigabe: „Lege `/var/tmp/m1-codex-probe.txt` mit
   dem Inhalt ok an, mit einem einzigen Shellbefehl.“ Falls vorhanden, kurz
   `opencode` oder `agy` in einer Flut-Session starten.
   Erwartung: Codex vor dem ersten Auftrag Unknown, Busy während der
   Arbeit, Waiting bei der Freigabe, danach Idle; `opencode` und `agy`
   Unknown mit Grund.
6. **Kontrollausfall.** Per SSH wird auf 192.0.2.20 gezielt der sshd-Prozess
   der Kontrollverbindung der App beendet; vorher wird er der Person am
   Fenster gezeigt.
   Erwartung: Die Pillen des Hosts zeigen „As of hh:mm“, Liste und
   Terminals bleiben, Tippen in einer Kachel wirkt weiter. Mit Schlüssel
   oder ssh-agent steht unter der Hostzeile nur die ruhige Zeile
   „Reconnecting live updates…“, kein Kasten; ohne Klick ist die Steuerung
   nach wenigen Sekunden zurück, nach der ersten Abfrage stimmen die Werte
   wieder. Erst nach fünf gescheiterten Versuchen, bei einem Passwort-Host
   sofort, erscheint der Kasten „Live updates stopped“ mit „Restore
   updates“.
7. **Neuanlage gleichen Namens.** In `m1-f3`:
   `tmux -L agentbridge kill-session -t m1-f4 && tmux -L agentbridge new-session -d -s m1-f4`.
   Erwartung: Die alte Zeile `m1-f4` zeigt Ended, ihre Kachel lebt nicht
   weiter. Nach „Reload sessions“ steht `m1-f4` als neue Session da, ohne
   den alten Status.
8. **Neustart.** In `m1-claude1` Claude mit `/exit` beenden, dann wieder
   `claude` starten. Die Shell in `m1-f1` mit `exit` beenden. Die App
   schließen, neu starten und beide Hosts verbinden.
   Erwartung: Unknown nach dem Beenden, Idle nach dem Neustart, Ended für
   `m1-f1`; nach dem App-Neustart ist der Status wieder da.
9. **Kein Überwachungsprozess.** Per SSH wird während des Laufs und nach
   „Disconnect“ auf beiden Hosts mit `ps` geprüft, dass zwischen den
   Abfragen und nach dem Trennen kein Prozess der App auf der VM bleibt.
10. **Neun Kacheln.** Beide Hosts und den Eintrag `m1-drei` verbinden und
    alle offenen Kacheln schließen. Auf 192.0.2.20 acht Kacheln öffnen:
    `m1-f3`, `m1-f4`, `m1-f6` bis `m1-f9`, `m1-claude2` und `m1-codex`; dazu
    `m1-f5` über `m1-drei`. Die App neu starten (einen Passwort-Host danach
    von Hand verbinden; seine Kacheln erscheinen dann an ihrem Platz).
    Erwartung: alle neun öffnen in ihrer Reihenfolge, keine Abweisung, kein
    „Capacity“, keine Kachel schließt sich. Von den acht Kacheln von
    192.0.2.20 öffnen höchstens vier zugleich; die übrigen zeigen kurz
    „Opening…“, bis sie dran sind. Ein Klick auf `m1-f5` in der Liste von
    192.0.2.20, die neunte Kachel dieses Hosts, zeigt den Hinweis an der
    Grenze je Host („… already shows 8 terminals, the limit per host.“);
    eine zehnte Wahl auf einem anderen Eintrag (etwa `m1-codex` über
    `m1-drei`) den an der Gesamtgrenze („9 terminals are open, the
    limit.“). Beide neutral, nichts schließt.
11. **Tausch und Maximieren.** In zwei gleich großen Kacheln
    `trap 'echo WINCH' WINCH; while :; do sleep 1; done` starten, die
    beiden per Zug am Kopf tauschen, dann eine Kachel maximieren und
    zurückholen. Per SSH läuft vor und nach dem Tausch auf den VMs
    `tmux -L agentbridge list-clients -F '#{client_tty} #{client_created}'`.
    Erwartung: Beim Tausch erscheint in keiner der beiden „WINCH“ (kein
    `resize_terminal`), und `list-clients` zeigt vor und nach dem Tausch
    dieselben Clients (kein neues `open_terminal`); Maximieren und
    Zurückholen ohne „Capacity“.
12. **M2-Aufwachen mit neun Kacheln, acht davon auf einem Host.** Das
    Notebook 10 Minuten in den Standby legen, mit den neun Kacheln aus
    Schritt 10 (acht auf 192.0.2.20, eine über `m1-drei`).
    Erwartung: alle Kacheln hängen sich wieder an, ohne Sperrleiste und ohne
    „Capacity“; solange die Kacheln von 192.0.2.20 nacheinander anhängen,
    zeigen die wartenden kurz „Reconnecting…“ oder „Opening…“.

Zum Schluss die `m1-*`-Sessions über „End session…“ beenden, danach den
Eintrag `m1-drei` entfernen und die Probedateien löschen (`/tmp/m1-*`,
`/var/tmp/m1-codex-probe.txt`).

| Schritt | Ergebnis | Notiz |
|---|---|---|
| Datum, Build, Versionen (Claude, Codex, tmux) | | |
| 1 Claude-Zustände | | |
| 2 Geschlossene Kachel | | |
| 3 BEL und Resize | | |
| 4 Vier flutende Kacheln | | |
| 5 Codex | | |
| 6 Kontrollausfall | | |
| 7 Neuanlage gleichen Namens | | |
| 8 Neustart | | |
| 9 Kein Überwachungsprozess | | |
| 10 Neun Kacheln | | |
| 11 Tausch und Maximieren | | |
| 12 M2-Aufwachen | | |

---

## Log

| Datum | Person | Build | Farben | Maus | Bracketed Paste | Dauerlast | Abriss | Wiederverbinden | Tastatur | Status | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-12 | automatisierter Lauf (Fensterabnahme über CDP, keine Handabnahme) | 0.1.2, Debug-Bau vom 12.10. (Code nach der letzten Korrekturrunde) | teilweise: 125 % am echten Bildschirm, 100/150 % emuliert; Kontrastmodus (emuliert) und volle Unterlängen bestanden; 14 Themen nicht geprüft | teilweise: Umschalt+Ziehen + Strg+C legt den Text in die Windows-Zwischenablage (per PowerShell gelesen) und schickt kein ^C; Ziehen kopiert über tmux ebenfalls in die Windows-Zwischenablage, mit „Copied“; Rechtsklick nicht geprüft | bestanden: Strg+V und Umschalt+Einfg fügen geklammert ein, auch Text aus der Windows-Zwischenablage (per PowerShell gesetzt); nichts ausgeführt | nicht geprüft | nicht geprüft | teilweise: Neustart stellt Host, Kachel mit Verlauf, Layout und Seitenleiste her; nicht mehr vorhandene Session ergibt einen leeren Platz ohne Banner; echter Standby nicht geprüft | teilweise: Strg+Umschalt+P/N, Strg+„,“, Strg+=/0, F5 außerhalb des Terminals bestanden; AltGr-Zeichen `@ € \ { [ ] } \| ~` bei bestehender Markierung (als Strg+Alt-Ereignisse über CDP) kommen an und kopieren nichts; echte Tastatur nicht geprüft | teilweise: Host rund 35 min „Online“ ohne Fehlalarm, tmux-Uhr lief | Testinstanz isoliert (eigene `settings.toml`, Sockets `abtest_20261012_w1`/`_w2`). Echte Tastatur, Rechtsklick, 100/150 % am echten Bildschirm, Standby, VPN-Wechsel und Bildschirmleser bleiben Handabnahme. Strg+C direkt nach dem Ziehen auf einem Host mit `mouse on` geht als ^C an die Shell (Spec §6.1/§6.4) — im Alltag beurteilen. |
| | | | | | | | | | | | |
