# Numerisches tmux-Inventar: begrenzte Messung vom 12. September 2026

Der reine ID-/Zahlenteil lässt sich auf dem gemessenen **tmux 3.4** in einem
lesenden Kommandoverbund abfragen, auch auf einem lebenden Server ohne Sessions.
Drei gleichnamige Sessionersetzungen, drei Pane-Respawns und drei Serverneustarts
liefern die erwarteten unterschiedlichen Identitäten. Der gemessene Verbund
erzeugt bei abwesendem Server keine verbleibenden Server-/Socketressourcen oder
neu adoptierten Prozesse. Das ist ein begrenzter Nachweis für das Inventar-/
Identitätstor aus der [MVP-Spec, §4.2/4.3 und §5](../specs/2026-09-05-mvp-und-statuspunkt-design.md),
**keine Freigabe von tmux 3.0, Produktionsparser oder Statusadapter**.

## Umgebung und Ressourcen

- Autorisierter erster Testhost `u@192.0.2.20`, UID 1000. SSH ausschließlich
  mit `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ConnectTimeout=8` und der
  bestehenden Testanmeldung. Keine Installation, Agentstarts oder Änderungen an
  bestehenden Sockets, Benutzerkonfigurationen oder produktiven Sessions.
- `/usr/bin/tmux`, `tmux -V` mit Exit 0, stdout exakt `tmux 3.4\n`, stderr leer;
  Binary-SHA-256 `034b15c64035f783d43862f2775eb4828f61571ca62c8199796000b97d556ecd`.
  `tmux3.0` und `tmux-3.0` sind im PATH nicht vorhanden. Das ist keine umfassende
  Dateisystemsuche und kein Lauf einer Mindestversion.
- Der neue [Messhelfer](../../scripts/m1-tmux-inventory.py) lief per stdin mit
  Python 3 der VM. Er erzeugt genau einen neuen zufälligen privaten Ordner unter
  `/tmp/ab-m1-inventory-*`, prüft Abwesenheit vor der Anlage sowie UID, Modus 0700,
  Device und Inode danach. Alle tmux-Aufrufe adressieren dessen `tmux.sock` mit
  `-S`, `-f /dev/null`, `LC_ALL=C`; geerbtes `TMUX`, `TMUX_PANE` und `TMUX_TMPDIR`
  werden entfernt. Paneprogramme sind direkte `/bin/sleep 300`-Aufrufe.
- Finaler Lauf: **2026-09-12 07:35:49.911 bis 07:35:52.060 UTC** zwischen
  Versionsaufruf und Start der abschließenden NoServer-Abfrage. Shell/SSH und
  der finale lokale Fixtureexport kommen dazu. SSH-/Helferexit **0**.

Python, `/proc`, Subreaper und PIDfd sind ausschließlich Werkzeuge dieser
Linux-Messung. Sie sind keine neue Voraussetzung des Produktpolls oder des
späteren kopierbaren Hooks.

## Gemessener Verbund

`S` steht hier nur erklärend für den exakt adressierten eigenen Socket. Der
Helfer übergibt argv direkt an den Prozess, einschließlich separater `;`-Argumente.
Es gibt keinen Shelloperator zwischen den tmux-Kommandos und kein `eval`.

```sh
tmux -u -S "$S" -f /dev/null \
  display-message -p 'B|#{pid}|#{start_time}' ';' \
  list-sessions -F 'Q|#{session_id}|#{session_windows}' ';' \
  if-shell -F '#{session_id}' \
    "list-panes -a -F 'P|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{window_active}|#{pane_active}|#{pane_dead}|#{alternate_on}|#{session_attached}|#{window_activity}|#{window_bell_flag}|#{window_panes}'" ';' \
  display-message -p 'E|#{pid}|#{start_time}'
```

Der innere Kommandotext ist konstant. `if-shell -F` wertet hier ein tmux-Format
aus und fügt das statische `list-panes` ein, wenn eine Session vorhanden ist.
Es wird kein externer Shelltest gestartet. Diesen `-F`-Zweig und fehlende
Startflags zeigen auch die Primärquellen für
[tmux 3.4](https://raw.githubusercontent.com/tmux/tmux/3.4/cmd-if-shell.c) und
[tmux 3.0](https://raw.githubusercontent.com/tmux/tmux/3.0/cmd-if-shell.c).
Der Quellabgleich ersetzt keine tatsächliche Ausführung von 3.0. Ein globales
`-N` wird nicht vorausgesetzt; das [3.0-Handbuch](https://raw.githubusercontent.com/tmux/tmux/3.0/tmux.1)
führt diese Option nicht auf.

| Zeile | Inhalt und begrenzte Verwendung |
|---|---|
| `B`, `E` | Server-PID und `start_time`; beide Werte müssen am Anfang/Ende übereinstimmen |
| `Q` | Session-ID und Zahl ihrer Windows, auch zur Prüfung fehlender Inventarteile |
| `P` | Session-/Window-/Pane-ID, Pane-Start-PID, Auswahl-/Lebensdauerflags, Attachzahl, Ausgabezeit/Bellflag, Panezahl im Window |

Namen, Titel, Pfade, Prozessnamen, Versionsstrings und Hookwerte werden nicht
in diesen Wireteil aufgenommen. Die Version wird separat exakt festgestellt;
der adressierte Socket bleibt Bestandteil des Abfragekontexts. Die
Socket-Device-/Inodewerte im Messbericht dienen zusätzlich dem Besitz-/Cleanup-
Nachweis. Sie sind keine plattformübergreifende Produktgeneration.

Der kleine Messparser verlangt vollständiges EOF, expliziten Exit 0, leeres
stderr, gültige B/E-Grenzen, ID-/Zahlenzeilen und konsistente Session-/Window-/
Panezahlen mit eindeutiger aktiver Auswahl. Er lehnt duplizierte Pane-IDs ab;
verlinkte Windows über mehrere Sessions sind deshalb bewusst keine freigegebene
Topologie. Es ist kein Produktparser und er verwaltet keine Sessionliste.

## Tatsächliche Beobachtungen

Im finalen Lauf stehen **56 tmux-Kommandodatensätze**, zusätzlich der
Versionsaufruf. Davon liefern **20** den vollständigen Inventarsnapshot.
Alle 56 besitzen tatsächlichen Exitstatus und vollständiges EOF. Die 20
Snapshotkommandos dauerten **2,023–22,629 ms** lokal auf dem Host. Dies ist kein
SSH-, Last-, Poll-/UI-Latenzbeleg.

| Fall | Ergebnis im finalen Lauf |
|---|---|
| Socket anfangs abwesend, 3 Abfragen | Je Exit 1, stdout leer, exakte Diagnose `error connecting to <eigener Socket> (No such file or directory)` plus LF. Socket danach weiter abwesend, ECHILD, null neu geerntete adoptierte Kinder |
| Lebender leerer Server | `exit-empty off` tatsächlich bestätigt. Unbedingtes `list-panes -a` liefert Exit 1 / `no current target\n`; dies ist **kein NoServer** |
| Bedingter Verbund auf leerem Server, 3 Abfragen | Je Exit 0, stderr leer, genau B/E mit identischer PID/Startzeit und keine Q/P-Zeilen |
| Gleichnamiger Ersatz, 3-mal | Der Server bleibt `(2262370, 1789198549)`. Session-/Window-/Pane-IDs wechseln von `$0/@0/%0` über `$1/@1/%1`, `$2/@2/%2` zu `$3/@3/%3`; auch `pane_pid` wechselt jedes Mal |
| Respawn, 3-mal | `$3/@3/%3` bleibt, `pane_pid` wechselt von 2262396 über 2262400 und 2262404 zu 2262408. Pane-ID allein erkennt diesen Prozessersatz nicht |
| Separator-Titel | `alpha\|Q\|$999\|1` wird exakt gesetzt und wieder gelesen. Inventar bleibt gleich |
| Control-Titel | `select-pane -T` meldet Exit 0, übernimmt LF/CR/TAB aber nicht; der vorherige Separator-Titel bleibt. Kein erfolgreicher Titel-Kontrollzeichenfall behauptet |
| Echte LF/TAB in eigener Sessionoption | Exakt gelesener Wert `Q\|$999\|1\nP\|fake\tend\n` in JSON-Schreibweise. Diese freie Option erzeugt keine Inventarzeilen, weil sie nicht abgefragt wird |
| Zweiter Pane | Zwei P-Zeilen für dasselbe Window, `window_panes=2`, genau ein aktiver Pane. Keine Agentzustände oder Quellenpriorisierung gemessen |
| Partieller Verbundfehler | Gültiges B vor fehlschlagendem gezieltem `list-panes`: Exit 1, stdout nur `B\|2262370\|1789198549\n`, stderr `can't find pane: %999999999\n`, E fehlt. Als Fehler erhalten, kein leerer Snapshot |
| Inertes Socket nach Serverende, 3 Abfragen | Je Exit 1, stdout leer, exakt `no server running on <eigener Socket>\n`; ECHILD und null neu geerntete adoptierte Kinder |
| Neustart auf demselben Socketpfad, 3-mal | Neue Paare `(2262432,1789198550)`, `(2262444,1789198551)`, `(2262475,1789198552)`; PID **und** Startzeit ändern sich. IDs beginnen jedes Mal wieder bei `$0/@0/%0` |

Vor dem zweiten und dritten Neustart wartet die Messung 865,142 bzw. 964,676 ms
auf eine neue Unixsekunde; vor dem ersten war diese bereits gewechselt
(protokollierte 0,003 ms). So demonstriert der Lauf beide Generationsteile.
`start_time` bleibt sekundengenau und ist keine Boot-ID. Diese Messung löst
PID-/Uhrzeitwiederverwendung nach unbeobachteter Trennung nicht. Lokale
Verbindungsgeneration und erneute Quellenprüfung bleiben Teil des Specvertrags.

Die sechs gezielten NoServer-Proben zeigen weder neue Sockets noch bleibende
oder neu adoptierte Daemonprozesse. Sie sind keine Betriebssystem-Aufzeichnung
jeder theoretisch möglichen kurzlebigen internen Forkoperation.

## Synthetische Parserfälle und Helferreview

**22/22** reine Gegenfälle sind als eigener Parserlauf und erneut im finalen
Messbericht enthalten: gültiger Ein-Pane-/Leerfall, fehlender Exit/EOF,
Deadline-/Limitmarkierung, stderr-only, Exit 127, widersprüchlicher Erfolg,
fehlende End-/Panezeile, Serverwechsel, doppelte Pane-ID, TAB, Nicht-ASCII,
eingeschleuste freie Zeile sowie NoServer mit exaktem/falschem Socket,
übersetzter/unbekannter Diagnose, widersprechendem Payload oder fehlendem Exit.
Das sind synthetische Klassifikationstests. Sie belegen keine tatsächlich
ausgelöste Transportfrist, UTF-8-Decodierung, Berechtigungsverweigerung oder
256-KiB-Überschreitung. Der Helfer begrenzt Befehle auf fünf Sekunden und
je Stream 256 KiB; nach Frist ist ausschließlich sein Prozesscleanup gesondert
begrenzt. Keine pauschale Fünf-Sekunden-Garantie des gesamten Messlaufs.

Vor dem ersten tmux-Lauf prüfte eine unabhängige Durchsicht den neuen Helfer
statisch. Drei bestätigte Punkte wurden korrigiert: gesetzte freie Testwerte
müssen exakt gelesen werden; Cleanup-Verantwortung muss vor der Ordneranlage
bestehen; ein defekter Exportkanal darf die Entfernung eines nachweislich leeren
eigenen Ordners nicht verhindern. Ein Endexport-Rest wurde ebenfalls geschlossen.
Der abschließende Delta-Review bestätigte diese Änderungen. Es gab keine
erneute Gesamtarchitekturprüfung und keine Änderung der bestehenden Helfer durch
diesen Messauftrag.

Der **erste echte Lauf endete mit Exit 1**: `set-option -t =same_name` meldete
`no such session: =same_name`. Der Helfer hatte bis dorthin bereits Snapshots,
Ersatz- und Respawnfälle gemessen; Split und Neustarts waren noch nicht erreicht.
Die beiden Optionsaufrufe verwenden jetzt die zuvor gelesene numerische
Session-/Pane-ID. Der fehlgeschlagene Lauf bleibt unverändert als Initialfixture
erhalten und zählt nicht als vollständig bestandener Lauf.

Der anschließende unabhängige Evidenzreview bestätigt den engen ID-Delta,
Fixturehashes, Exitcodes, Zählungen, Identitätswechsel und Cleanup ohne weiteren
konkreten Befund. Er trennt ebenfalls den nicht übernommenen Control-Titel von
der tatsächlich gespeicherten LF-/TAB-Option. Der Reviewer hat dafür nur die
vorhandenen Dateien gelesen und keine weiteren VM-Läufe gestartet.

## Cleanup und Belege

Beide eigenen Messordner wurden vollständig bereinigt:

| Lauf | Exakter eigener Ordner | Abschluss |
|---|---|---|
| Initial, Exit 1 | `/tmp/ab-m1-inventory-63da7fe7c5cf4fe2a0c1d1acb59597ac` | Eigener Server regulär gestoppt, ECHILD, alle gemessenen Prozesse beendet, kein Fallbacksignal, Socket und Ordner entfernt |
| Final, Exit 0 | `/tmp/ab-m1-inventory-a6ec9a30daae4a50a9a39413542a0096` | Vier Servergenerationen und insgesamt 15 gemessene Prozessidentitäten beendet, ECHILD, kein Fallbacksignal, Socket und Ordner entfernt |

Socketunlink erfolgt erst nach exakter NoServer-Diagnose, fehlenden eigenen
Kindprozessen sowie UID-/Sockettyp-/Device-/Inodeprüfung. Der Ordner wird nur
mit `rmdir` nach erneuter Eigentums-/Leerprüfung entfernt. Es gibt keine
rekursive Löschung oder breit adressierte PID-/tmux-Signalisierung.
Eine separate lesende SSH-Nachprüfung bestätigt anschließend beide Ordner und
beide Socketpfade als abwesend.

Die JSONL-Zeilenenden sind für das Repository auf LF normalisiert; die
folgenden Hashes beziehen sich auf diese gesicherten Dateien. Die JSON-Daten
und tatsächlichen Ergebnisse wurden dadurch nicht verändert.

| Artefakt | SHA-256 |
|---|---|
| [Finaler Helfer](../../scripts/m1-tmux-inventory.py) | `ad5b347a527b6e142f29916cb7d9763070e06db68928f053854f86a06c87c23f` |
| [Parserfixture](fixtures/m1-tmux-inventory/2026-09-12-parser-selftest.jsonl) | `8a1ea13fdaf2a37491f25dfee2e166e2493ca0a96421c8b23d9d27d341005f09` |
| [Initialfixture](fixtures/m1-tmux-inventory/2026-09-12-tmux-3.4-initial.jsonl) | `75e513955766e436cb402ef9406777f3d37079beb0891fff759bbe6b45d38d24` |
| [Finalfixture](fixtures/m1-tmux-inventory/2026-09-12-tmux-3.4.jsonl) | `3e3ab5684189c8a1fc40be46521058a5906103858c3df4de1185346c7508bf93` |
| [Separate Abwesenheitsprüfung](fixtures/m1-tmux-inventory/2026-09-12-cleanup-check.jsonl) | `d78e6c32ce86a3b5ada6c85d9292f65e378c05c22ef3d68f71ead575d08b7e42` |

Die `.jsonl.exit`-Dateien enthalten jeweils den tatsächlichen SSH-/Helferexit
`1` bzw. `0`. Die Initialfixture entstand mit Helferhash
`40b152d5b7388ca27018e2697e9ae9d19bb36327a1a42a03f8810eb4377727ee`;
der dortige einzige spätere Codeunterschied sind die beiden Optionsziele.
Alle Rohwerte sind eigene synthetische Metadaten, IDs/Zahlen oder bounded
Befehlsdiagnosen, keine Nutzerprompts, Transcripts oder persönlichen Dateien.

## Was diese Messung offen lässt

tmux 3.0, zweiter Endpunkt, reale Fehler-/Limit-/Lastmessungen, geschlossene,
fokussierte und fremde Clients sowie Windows-/UI-Latenzen bleiben offen. Freie
UTF-8-Metadaten haben weiterhin keinen geprüften reversiblen Framingcodec;
der Durchstich muss sie auslassen. Eine sichere Zuordnung der bestehenden
namensbasierten Produktliste zu diesen numerischen Identitäten ist hier noch
nicht implementiert. Die Probe ändert keinen Inventarführer und prüft keine
Create/Kill-/Reload-/Rename-Races der Anwendung.

Der beobachtete Ein-/Zwei-Pane-Inventarvertrag ist eine Grundlage für den
begrenzten nächsten Produktentwurf. Er beweist keine Agentinstanzbindung,
Hooklebensdauer, fachliche Statusrichtigkeit oder vollständig bestandene
M1.0-Matrix. Es wurden keine Produktdateien geändert und kein Release erklärt.
