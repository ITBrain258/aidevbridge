# MVP-Zuschnitt und Statuspunkt: Design

**Datum:** 2026-09-05
**Stand:** `main` am 2026-09-05
**Anlass:** Die Roadmap vom selben Tag (`plans/2026-09-05-roadmap-bis-release.md`) wurde Punkt für Punkt mit dem Auftraggeber durchgesprochen. Dieses Dokument hält fest, was davon gebaut wird, in welcher Reihenfolge, und wie der Statuspunkt (A4) entworfen ist. Es ersetzt für den Statuspunkt die Abschnitte 6.1 und 4.2 der Gesamtspec vom 2026-07-25, wo es abweicht.
**Fassung:** korrigiert am 2026-09-08 nach Quellen- und Entwurfsprüfung. Diese M1-Fassung ersetzt die früheren Regeln zu Bell als Wartezustand, Claude-Arbeitsregex, alleiniger Server-PID-Identität und Kontrollausfall als Hostausfall. Die Messung vom 2026-09-05 bleibt historischer Befund; ihre damaligen Empfehlungen sind kein Implementierungsvertrag. M1 ist weiterhin ein Entwurf, keine Beschreibung bereits implementierter Statusfunktionen.
**Bezug:** Gesamtspec `2026-07-25-agentbridge-design.md` (A1 bis A8, V1 bis V34), Roadmap 2026-09-05, Bewertung 2026-09-04 (Befunde 1 bis 16), Designsystem 2026-07-27.

---

## 1. Zweck und Zuschnitt

Das Produkt ist ein Agent-Werkzeug: Bei mehreren Coding-Agents in tmux-Sessions auf Linux-VMs sehen, welcher gerade auf eine Antwort wartet, und dort mit einem Tastendruck hin. Termius ist Maßstab für die Bedienqualität der Hülle, nicht das Ziel.

MVP heißt: Ein Fremder installiert das Windows-Binary, verbindet seine Linux-VM, sieht handgestartete tmux-Sessions mit belegbarem Status und kann nach Zuklappen und Aufwachen weiterarbeiten. Die App installiert auf dem Host kein Programm und schreibt keine Agent-Konfiguration; ein vom Nutzer eingetragenes Hook-Snippet ist optional. Zwischen Polls läuft kein zusätzlicher Überwachungsprozess. Die aktuelle Remote-Ausführung setzt eine POSIX-kompatible Login-Shell sowie tmux ab 3.0 und `base64` im SSH-Kommando-PATH voraus; fish/csh werden nicht unterstützt. Für die Statusmessung geprüft ist bisher nur tmux 3.4. Die Unterstützung der Mindestversion wird vor Freigabe geprüft. Fehlende Signale ergeben unbekannt.

Bewusst nicht im MVP, jeweils mit Grund in Abschnitt 8: Links im Terminal öffnen, Badge "anderswo geöffnet", Host-Kompatibilität für fish, tmux außerhalb des PATH, ProxyJump und PuTTY-Schlüssel, ssh-agent-Verbesserungen, Diff-/git-Anzeige, `deny.toml`, `CONTRIBUTING.md`, Scoop. Die frühere pauschale Streichung der CI ist durch das am 2026-09-08 freigegebene Stabilitätspaket überholt.

---

## 2. Entscheidungen

| Frage | Entscheidung | Folge |
|---|---|---|
| Produktlesart | Agent-Werkzeug | Statuspunkt ist der Kern, die Reihenfolge unten gilt |
| Name | Umbenennen, Name noch offen | Frist ist der Tag `v0.2.0`. Fehlt der Name am Ende von M0, erscheint `v0.1.1` unter dem alten Namen und Identifier, M0.6 rückt vor M1.7. Danach kostet eine Umbenennung eine Migration von Einstellungspfad und Socket |
| Einstellungsverzeichnis | Am Tauri-Identifier, einmalige Migration des alten Pfads | Läuft zusammen mit der Umbenennung, damit genau einmal migriert wird |
| Hooks | Nur versionsgeprüftes Snippet | Namespaced Statussignal mit Besitzer und Ereignismetadaten (4.10); die App schreibt keine Agent-Konfiguration |
| Aufmerksamkeit | Fenstertitel-Zähler, einmaliges Taskleisten-Blinken, Akkord "nächste wartende Session" | Kein Toast, kein Ton, kein Plugin. Weicht von Gesamtspec §7.1 bewusst ab |
| Fremde Sessions | Sehen und bedienen | Kill gesperrt, nie `attach -d`, keine Serveroptionen, keine Hooks auf dem Standard-Socket. Schließen heißt detach |
| Diff | Nichts | Kein Panel, kein Badge. Die Prüfung von Code passiert in der IDE |
| Anmeldung | Schlüsseldatei und Passwort | Passwort-Hosts müssen nach Neustart verbinden (Abschnitt 4.8). ssh-agent bleibt wie heute; die zweite Verbindung (4.1) kostet Agent-Nutzer eine zweite Bestätigung, das README sagt es. Kein 2FA |
| Agents | Claude Code, Codex, Grok CLI | Adapter für geprüfte Versionen/Konfigurationen; Titelprofile als zusätzliche Heuristik. Groks Herstellerzuordnung ist zunächst zu bestätigen |
| tmux-Untergrenze | Bleibt 3.0 | Poll ohne `-f`, Hook als Fensteroption statt Pane-Option (4.2, 4.10) |
| Commits | Direkt auf `main` | Kleine Commits je Schritt, Tests grün, Push nur nach Nachfrage |

---

## 3. Ablauf

### 3.1 Was gegenüber der Roadmap anders läuft

1. **Signale vor Zusage prüfen.** Die Kurzmessung vom 2026-09-05 ist abgeschlossen. M1.0 ergänzt Lebenszyklen, Fehlerfälle, wiederholte Freigaben und Hook-Latenz (5); erst dann stehen unterstützte Adapter fest.
2. **Durchstich statt Schichten.** Nach M1.0 folgt ein dünner Pfad mit sicherem Inventar, beendet/unbekannt und Status-Overlay auf bekannte Sessions. Danach folgt ein geprüfter Hook-Adapter. Die Sessionliste wechselt nicht automatisch mit M1.3 zum Poll.
3. **Passwort-Hosts in M0.** Die beim Entwurf fehlende Verbindung nach App-Neustart wurde in M0 behandelt; Abschnitt 4.8 dokumentiert diesen bereits umgesetzten Teil. Alte Codezeilen in M0-/Verbindungsabschnitten beziehen sich auf den Entwurfsstand, nicht auf aktuelle Zeilennummern.
4. **Integrationstests auf eigenem Socket.** Der in M0 eingeführte injizierbare `AppState.default_socket` trennt Tests von Produkt-Sessions. Ein VM-Lauf verwendet einen eingerichteten `AGENTBRIDGE_TEST_HOST` und eigenen `AGENTBRIDGE_TEST_SOCKET`; der Test-Harness darf den Produktionssocket `agentbridge` nicht als Rückfall verwenden. Ein Test pinnt weiterhin die Produktionsvorgabe. Vor Commit gelten die vereinbarten Projektprüfungen; fehlende VM-Integration wird ausdrücklich als ungetestet ausgewiesen (6).
5. **Gutachten nur für Strukturschritte.** Zweite Verbindung plus Poll (M1), Auto-Reconnect (M2) und Standard-Socket (M3) bekommen eine Kritikrunde mit Widerlegern. H8 in M0.3 bekommt eine kurze Runde mit drei Fällen, weil der Fix die MITM-Entscheidung berührt. Alle anderen Schritte bekommen Tests und einen Lauf am Fenster.
6. **Zehn Minuten am Fenster je Meilenstein, gemeinsam.** Der Umsetzer gibt vor, der Auftraggeber schaut und berichtet.
7. **Namens-Erinnerung am M1-Tor.**

### 3.2 Zerlegung

Ein Umsetzungsplan je Meilenstein: Messung plus M0 (`plans/2026-09-05-m0-fundament.md`, nicht im Repository), dann M1, dann M2, dann M3. Abschnitt 4 ist das Design für M1 und M0.4. M2.2 (Auto-Reconnect) und M3.1 (Standard-Socket) bekommen vor ihrem Plan je einen eigenen Design-Abschnitt als Nachtrag zu diesem Dokument. Für alle Schritte, die Abschnitt 4 nicht behandelt, gelten die Wo- und Wie-Angaben der Roadmap.

### 3.3 Reihenfolge

| Schritt | Inhalt | Netto |
|---|---|---|
| **Messung** | Kurzmessung für drei Agents und tmux-Durchreichung auf 192.0.2.20 (Abschnitt 5), Ergebnisdokument | 0,5 d |
| **M0.1** | Sperrleiste (Befund 1), Ausgabe-Host-ID (Befund 2), Banner bei Kanalende (Befund 9), `AppState.default_socket` für den Test-Harness | 0,75 d |
| **M0.2** | RSA mit SHA-2 auf russh 0.62.4 als eigener Commit (Befund 3), danach russh 0.63.x als eigener Commit (Befund 6) | 0,75 d |
| **M0.3** | Härtung H5, H7, H8, H6 und H9 an der Command-Grenze, TOFU-Dialog modal für Tastatur, kurze Kritikrunde zu H8 mit drei Fällen, Punkt 7 "nur Tastatur" in `abnahme-handarbeit.md` | 1,25 d |
| **M0.4** | Anmeldeart speichern mit Lese- und Schreibpfad, Passwort-Hosts verbinden nach Neustart (4.8). Eingabefelder der Hinweisleiste überstehen ein Neuzeichnen (Befund 11) | 0,75 d |
| **M0.5** | Release-Hygiene: `.gitattributes` als erster Commit, Bump-Skript, CHANGELOG, Version und Commit in Seitenleiste und Diagnosetext, CSP mit `devCsp` | 0,75 d |
| **M0.6** | Umbenennung (153 Fundstellen in 28 Codedateien) und Einstellungspfad, sobald der Name feststeht, dann SignPath beantragen. Fehlt der Name, rückt der Schritt vor M1.7 | 0,75 d |
| **M0.7** | Gemeinsame Abnahme am Fenster nach `abnahme-handarbeit.md`, Fixdurchgang. Tag `v0.1.1` | 1 d |
| **M1.0** | Signalvertrag und Messdurchstich: Besitzer, Lebenszyklus, Latenz, sichere Framing-Regeln, Versionsmatrix (5) | 1 bis 2 d Prüfbudget |
| **M1.1** | Zweite Verbindung, TOFU-Schlüsselbindung, Deadline und getrennter Kontrollzustand (4.1, 4.7) | 1,75 d, vorläufig |
| **M1.2** | UI-v2-Formen definieren; Poll/Parser mit stabilen IDs; beendet/unbekannt als Overlay auf bekannte Sessions. Kein Wechsel der Listen-Autorität | 2 d, vorläufig |
| **M1.3** | Erster geprüfter Hook-Adapter, Besitzer/Freshness und gemeinsamer Reducer. Weitere Adapter und Titelprofile nur nach Messmatrix; Liste bleibt Overlay | 2 d, nach M1.0 neu schätzen |
| **M1.4** | Frontend vollständig: Kachelkopf, i18n, Tooltip, Klick auf beendete Session, Hostzuordnung (4.6) | 1,75 d |
| **M1.5** | Aufmerksamkeit: Akkord, Fenstertitel, Taskleiste, Rechte, aria-live, Ctrl+Shift-Ziffern (4.9) | 1 d |
| **M1.6** | Kopierdialog/Diagnose für den in M1.3 geprüften Hook. Optional BEL-Aufmerksamkeit über denselben Reducer; keine Statusüberschreibung (4.10, 4.11) | 0,5 bis 1 d, nach M1.0 neu schätzen |
| **M1.7** | Kritikrunde, gemeinsame Sichtprüfung, Namens-Nachfrage. Tag `v0.2.0` als Pre-Release | 0,5 d |
| **M2.1** | History-Restore per `capture-pane`, Guard im selben tmux-Aufruf, Hinweis nach Resize | 1,75 d |
| **M2.2** | Auto-Reconnect mit Backoff, Geheimnis im Speicher, Kacheln neu montieren. Eigener Design-Nachtrag, Kritikrunde. Tag `v0.3.0` | 4 d |
| **M3.1** | Standard-Socket: Host/Socket plus stabile Objektidentität aus M1; Namen bleiben Anzeige. Modus ohne `-L`; Regeln für fremde Sockets. Eigener Design-Nachtrag, Kritikrunde | 4 d |
| **M3.2** | Windows-Politur: Clipboard ohne Berechtigungsabfrage, F5 und Kontextmenü, Mindestgröße, Icon, Protokolldatei, globaler Diagnosetext | 2,5 d |
| **M3.3** | Lizenzinventar per `cargo about` und npm, im Installer mitgeliefert. Dependabot | 0,75 d |
| **M3.4** | Release-Job: Tag baut NSIS und MSI, Bootstrapper für WebView2, SHA256, Attestation, Release-Entwurf | 1 d |
| **M3.5** | README mit "Before you download", Voraussetzungen, erkannte Agents und Zustände, Grenzen. SECURITY, CHANGELOG, Issue-Vorlage | 1 d |
| **M3.6** | Abnahme auf dem Zweitrechner des Auftraggebers nur nach README, Fixdurchgang, zweiter Anlauf. Tag `v0.4.0` | 2,5 d |
| **M3.7** | winget-Manifest nach dem Release | 0,5 d |

Die frühere Summe von 34 Netto-Tagen (39 mit Puffer, ohne den später ergänzten UI-v2-Schritt) ist keine aktuelle Restaufwandsschätzung. M0 und UI v2 sind separat abgenommen; das Stabilitätspaket ist separat freigegeben. Für M1 stehen zunächst 1 bis 2 Tage Prüfbudget. Die übrigen M1-Werte sind Planungsannahmen und werden nach M1.0 neu geschätzt. Kürzbar sind BEL-Aufmerksamkeit und zusätzliche Titelprofile, nicht die Lebenszyklusprüfung des ersten Hooks. Der spätere Wechsel zur Inventarführung durch den Poll erhält einen eigenen Schritt mit Tests.

### 3.4 Tore

| Tor | Bedingung, am Fenster geprüft |
|---|---|
| M0 | Abnahmetabelle ausgefüllt, inklusive Punkt 7 "nur Tastatur, mit TOFU". Passwort-Host verbindet nach Neustart aus der Seitenleiste. CSP geprüft mit Terminal, Suche, Dialogen und TOFU. Name umgesetzt, oder "agentbridge bleibt bis `v0.2.0`" protokolliert. Tag `v0.1.1` |
| M1 | Acht Sessions über zwei unabhängige SSH-/tmux-Endpunkte; zwei Einträge auf demselben VM-Port zählen nicht doppelt. Mindestens ein versionsgeprüfter Hook-Adapter besteht Abschnitt 5 inklusive wiederholter Freigabe bei geschlossener Kachel, Unterbrechung, Fehler und Neustart. Nicht unterstützte Fälle zeigen unbekannt mit Grund. BEL allein ergibt nie wartet/arbeitet. Reiner Kontrollausfall markiert Status veraltet, erhält Liste und nutzbare Terminals. Neuanlage wird auch bei gleichem Namen anhand IDs erkannt. Vier flutende Kacheln: eine bereits veröffentlichte gültige Statusänderung erscheint binnen 4 Sekunden; Agent-Signalverzögerung wird getrennt genannt. Kein zusätzlicher Überwachungsprozess zwischen Polls/nach Trennen. Kachelwechsel ohne Größenänderung sendet kein Resize. Tag `v0.2.0` nach protokolliertem Tor |
| M2 | Ruhezustand 10 Minuten, aufwachen, ohne Klick wieder verbunden mit lesbarem Verlauf. Kontrollausfall wird binnen 25 Sekunden als solcher erkannt. Nur nachgewiesener Terminal-/Hostausfall oder ungültige Pane-Identität sperrt Eingabe. Wiederaufbau beider Verbindungen wird im M2-Design getrennt geprüft. Tag `v0.3.0` |
| M3 | Zweitrechner: Installation nur nach README, Verbindung mit `id_rsa`, ed25519 und Passwort, handgestartete Session mit Status, Deinstallation geprüft, zweiter Anlauf ohne Stolperer. Tag `v0.4.0` |

---

## 4. Design des Statuspunkts

### 4.1 Zwei Verbindungen je Host

`AppState.hosts` hält heute `Arc<RusshTransport>` je Laufzeit-ID (`commands.rs:100`). Künftig:

```rust
struct HostConnection {
    control: Arc<RusshTransport>,   // exec: tmux-Befehle, Poll, Preflight, Verzeichnisse
    terminal: Arc<RusshTransport>,  // PTY-Kanäle der Kacheln
    poll_cancel: Arc<tokio::sync::Notify>,
    poll_task: tokio::task::JoinHandle<()>,
}
```

Grund für zwei Verbindungen: russh bedient alle Kanäle einer Verbindung über einen Dispatch-Loop. Sobald eine Kachel 1 MiB unbestätigte Ausgabe hält, blockiert die Leseaufgabe und mit ihr jeder exec auf derselben Verbindung, gemessen 20 Sekunden (`plan1-haertung-design.md` §2.2, nicht im Repository). Ein Poll auf dieser Verbindung würde genau dann "Host hängt" melden, wenn ein Agent arbeitet.

Aufbau: `connect_host_with_known_hosts` (`commands.rs:1048`) baut beide Verbindungen nacheinander mit denselben Zugangsdaten, alles oder nichts. Scheitert die zweite, wird die erste geschlossen und der Fehler der zweiten zurückgegeben, kein Eintrag in `hosts`. `TofuPolicy` (`commands.rs:820`) bekommt `accepted: Mutex<Option<(String, u16, String)>>` für Host, Port und Schlüssel der ersten Verbindung; `decide` prüft zuerst dieses Feld: gleicher Schlüssel heißt `true` mit Entscheidung `Known`, anderer Schlüssel heißt `false` mit `Mismatch`, ohne Rückfrage. Agent-Anmeldung bestätigt der Nutzer damit zweimal im Agent-Dialog; das README nennt es. Alle exec-Aufrufer nutzen `control`, `open_terminal_impl` nutzt `terminal`. `disconnect_host_impl` (`commands.rs:1597`) ruft `poll_cancel.notify_one()`, wartet den Task ab, schließt beide Verbindungen; ein letztes Ereignis gibt es nicht.

Deadline: Der Trait `Transport` (`transport/mod.rs:31`) bekommt die Pflichtmethode `exec_with_deadline(&self, line: &str, deadline: Duration) -> anyhow::Result<ExecResult>`; das vorhandene `exec(&self, line)` bleibt als Default-Methode und ruft sie mit `DEFAULT_EXEC_DEADLINE = 15 s`. So bleiben die rund 30 Aufrufer unverändert, und die drei Test-Transporte implementieren nur die neue Methode. `RusshTransport` legt die Frist um den gesamten Rumpf: Kanal öffnen, exec, EOF, Warteschleife. Bei totem TCP nach dem Ruhezustand hängt schon das Öffnen, eine Frist nur um die Warteschleife würde das nicht sehen. Läuft die Frist ab, zählt der Aufruf sofort als gescheitert mit dem eigenen Fehlertyp `ExecTimedOut`; das nachgelagerte `ch.close()` läuft abgekoppelt in einem eigenen Task mit 2 Sekunden Frist, damit es die Rechnung in 4.7 nicht verlängert. Grund für das Schließen ist V2: Ein Kanal, der nicht geschlossen wird, gibt seinen Slot nicht frei, nach zehn ist die Verbindung tot. Fristen: 5 Sekunden für den Poll, 15 Sekunden für Capture und andere exec-Aufrufe (Gesamtspec §4.2 nennt 15 für Kontrolle und Capture).

### 4.2 Poll, Identität und Datenvertrag

Ein cancellable Task je Host und Socket nutzt ausschließlich die Kontrollverbindung; höchstens ein Poll ist aktiv. Vorgabe: zwei Sekunden Pause nach einem Poll, fünf Sekunden Deadline einschließlich Kanalöffnung. Der Task besitzt Snapshot und Reducer-Zustand und emittiert über einen testbaren Sink. Disconnect wartet den Task ab. Kein Dauerkanal, kein `read -t`, kein externer Watcher auf dem Host.

Ein Poll fragt Server-Metadaten und `list-panes -a -F` in einem tmux-Kommandoverbund ab. Das Semikolon ist ein von `remote::build` gequotetes argv-Element, kein Shell-Operator. Kein `list-panes -f`, da tmux 3.0 unterstützt werden soll. Der Poll startet keinen tmux-Server.

| Daten | Verwendung |
|---|---|
| `pid`, `start_time`, `version`, Socket-Identität | Servergeneration und Fähigkeiten; PID allein ist keine Generation |
| `session_id`, `window_id`, `pane_id`, `pane_pid` | Identität und Erkennen ersetzter Objekte; `pane_pid` ist der Pane-Startprozess, nicht automatisch der aktuelle Agent |
| `window_active`, `pane_active`, `pane_dead`, `alternate_on`, `session_attached` | Auswahl, Lebensdauer, Reattach-Guard und Clients |
| `window_activity`, `window_bell_flag` | Ausgabezeit bzw. unspezifischer Aufmerksamkeitshinweis; keine Arbeits-/Wartebeweise |
| Sessionname, `pane_current_command`, `pane_current_path`, `pane_title` | Anzeigename, konservative Prozess-/Titelheuristik und Tooltip; freie Werte sind untrusted |
| Versioniertes `@agentbridge_status_v1` | Optionaler Hook-Datensatz (4.10); unbekannte/ungültige Version liefert kein Statussignal |

Identität in Backend und Frontend: Laufzeit-Host-ID, Socket, Servergeneration und Session-/Pane-IDs. Namen sind Anzeigenamen/Aufrufparameter, keine Generation. Gleicher Name mit neuer Session-/Pane-ID übernimmt weder Status noch Hook-Besitzer oder Profilcache. Jeder Connect erhält zusätzlich eine lokale Verbindungsgeneration; verspätete Ereignisse alter Tasks werden verworfen. `start_time` ergänzt die PID, ersetzt keine echte Boot-ID. Nach unbeobachteter Trennung gelten frühere Signalbindungen bis zur erneuten Prüfung als unverifiziert.

**Framing-Tor in M1.0:** Die bisherige Zwölf-Feld-Zeile mit `splitn` und zwei unescaped Freifeldern ist kein freigegebener Wire-Vertrag. Titel/Pfad dürfen durch Trennzeichen oder Zeilenumbrüche keine Inventarzeilen erzeugen. Der erste Durchstich verwendet einen getrennten Inventarteil nur mit strukturierten IDs/Zahlen. Freie Metadaten dürfen erst nach einem unter tmux 3.0/3.4 geprüften reversiblen Framing-/Escaping-Verfahren in dieselbe Antwort aufgenommen werden; alternativ bleiben sie zunächst aus dem Durchstich heraus. Größenlimit, UTF-8-Behandlung, eindeutige Zuordnung zur Inventar-ID und Kontrollzeichen-Tests gehören vor die Adapterfreigabe. Kein `eval` zur Dekodierung. Nicht sicher abgrenzbare Antworten sind unvollständig und begründen kein Sessionende.

### 4.3 Parser und Fehlerklassifikation

Der Parser bekommt den vollständigen Exec-Ausgang: optionalen Exitstatus, stdout, stderr sowie Transport-/Deadline-Fehler. Fehlender Exitstatus wird niemals zu Erfolg oder NoServer umgedeutet. Ausgaben werden begrenzt erfasst; Überschreitung/Abbruch ist ein Fehler, kein vollständiger Snapshot.

| Ergebnis | Notwendige Evidenz | Folge |
|---|---|---|
| Snapshot | Expliziter Exit 0, gültige Serveridentität und vollständiger Inventarteil; keine ungeklärte Fehlerausgabe | Beobachtungen anwenden |
| NoServer | Expliziter Fehlerexit und versionsgeprüfte Diagnose, die exakt den adressierten Socket als nicht vorhanden bzw. ohne lauschenden Server identifiziert; kein widersprechender Payload | Normaler leerer Snapshot; niemals Server starten |
| TmuxError | Anderer Fehlerexit, unbekannte Diagnose, Berechtigungsfehler, fehlendes Programm oder widersprüchliche stdout/stderr-Antwort | Liste erhalten, Status als nicht aktuell kennzeichnen |
| Incomplete | Exitstatus fehlt, Framing/Identität ungültig, Ausgabe abgeschnitten oder Inventar unvollständig | Liste erhalten; keine Abwesenheits-/Endeaussage |
| Transport / Deadline | SSH-Fehler bzw. Fristablauf | Kontrollgesundheit aktualisieren; keine Abwesenheits-/Endeaussage |

**`exit != 0 && stdout leer` ist kein NoServer-Nachweis.** Programm-/Socket-Berechtigungsfehler können nur auf stderr stehen. Die NoServer-Allowlist wird mit echten Diagnosen, Pfadabgleich und fremden/übersetzten Meldungen als Fixture getestet. Unbekannter Wortlaut bleibt Fehler; keine Teilstringregel wie nur `No such file`. Das vorhandene Verhalten von `list_session_names` ist kein Argument, es ungeprüft zu übernehmen.

Ungültige optionale Metadaten entwerten nur ihre Quelle, sofern der getrennte Inventarteil nachweislich vollständig bleibt. Sonst ist die ganze Antwort unvollständig. Doppelte/widersprüchliche aktive Panes oder IDs werden nicht durch den ersten Treffer entschieden. Mehrere Panes ergeben `split = true`; der Ein-Pane-Fall ist der erste Abnahmeumfang. Verdeckte Panes dürfen keine aktive Pane-Statusquelle überschreiben.

### 4.4 Statusdetektor und gemeinsamer Reducer

Fünf fachliche Zustände bleiben: **wartet, arbeitet, untätig, beendet, unbekannt**. Daneben bestehen getrennte Aufmerksamkeit (etwa Bell) und Datenaktualität. Es gibt keine Statusquelle `Bell`. Ein Hinweis kann Aufmerksamkeit verlangen, ohne Nutzerwartezeit zu behaupten.

Eine zentrale, testbare Reduktion erhält Snapshot-, Hook-, PTY-Aufmerksamkeits-, Verbindungs- und Identitätsereignisse mit Herkunft/Reihenfolge. Sie entscheidet Status und Aufmerksamkeit; das Frontend rendert das Ergebnis. Ob sie technisch im Backend liegt oder eine reine, vom Frontend aufgerufene Funktion ist, entscheidet der Umsetzungsplan. Zwei unabhängig priorisierte Zustandsmodelle sind ausgeschlossen.

Reihenfolge:

1. Veraltete Verbindungs-/Objektidentität verwerfen. Ungültige/veraltete Quellen begründen keinen aktuellen Status. Einen bisherigen Wert allenfalls als ausdrücklich letzte bekannte Beobachtung zeigen; aktueller Status ist dann unbekannt.
2. `pane_dead` mit gültiger aktueller Identität ergibt beendet. Abwesenheit begründet ein Ende nur bei vollständigem Snapshot (4.6).
3. Gültiger Hook-Datensatz mit aktueller Agent-Instanz und Pane-Bindung ergibt den belegten Zustand. Neue Instanz, ungeklärte Reihenfolge, fehlende Lebenszyklusereignisse oder widersprechende Evidenz entwerten das Signal; kein ewiger letzter Wert.
4. Eine sicher identifizierte leere interaktive Shell kann untätig ergeben. Der Prozessname allein beweist keinen sichtbaren Shell-Prompt: Wrapper ohne `exec`, Shell-Skripte und andere Mehrdeutigkeiten ergeben unbekannt. Eine gültige Agent-Ownership wird nicht allein wegen eines Shell-Prozessnamens gelöscht.
5. Ein Titelprofil darf nur innerhalb seiner geprüften Agent-/Versions-/Konfigurationsbindung einen Zustand liefern. Unbekannte Prozesse/Muster oder erinnerte Titel ohne gültige Instanzbindung ergeben unbekannt. Ein breites Idle-Muster darf kein Profil auswählen.
6. Sonst unbekannt.

**Claude Code 2.1.261:** Die Messung liefert kein fachliches Titelprofil. `^✳ .+$` (U+2733) trifft arbeitet, wartet und untätig. Es ist als `working` zurückgenommen; `idle_measured = false` hätte den Arbeitszweig nicht geschützt. Output-Aktivität macht dieses Muster nicht zum Arbeitsbeweis. Ohne geprüften Hook ist Claude unbekannt; BEL kann getrennt Aufmerksamkeit erzeugen.

Codex läuft in der Messung als `node`; dieser Name identifiziert es nicht. Das sehr breite Codex-Ruhemuster ist keine universelle Idle-Regel. Grok zeigte kurzes Idle während Hintergrundarbeit. Beide Titelprofile bleiben Kandidaten bis zur erweiterten Messung. Profile brauchen Quelle, geprüfte Version/Konfiguration und explizite Zustandsmuster statt eines einzigen `idle_measured`-Gütesiegels.

`window_activity` misst Ausgabezeit, keine fachliche Agent-Aktivität. Das erste Lesen eines gesetzten `window_bell_flag` beweist keine gerade erfolgte Bell; wiederholtes Lesen löst nicht erneut Aufmerksamkeit aus. Weder Flag-Löschen noch erneute Ausgabe bedeuten, dass eine Freigabe beantwortet ist.

### 4.5 Ereignis und Aktualität

`status://update` enthält mindestens:

- Host-ID, Socket, lokale Verbindungsgeneration, Servergeneration und monotone Update-Sequenz;
- Pollzeit, Zeitpunkt des letzten vollständigen Snapshots, `snapshot_complete`, Kontrollgesundheit und Fehlerklasse;
- Session-/Window-/Pane-ID, Anzeigename und Zustand mit Quelle, Beobachtungszeit, Ereigniszeit sofern vorhanden, Besitzer/Instanzbindung, Aktualität und Grund;
- getrennte Aufmerksamkeit mit Quelle/Ereignisidentität sowie Clients, sicher dekodierten Pfad, Ausgabezeit und Split-Hinweis.

Die Pollzeit erneuert nicht das Alter eines unveränderten Hook-Ereignisses. TTL-Ablauf beweist weder Fertigstellung noch Hängen. Wird eine Quelle wegen fehlender Lebensdauerevidenz verworfen, ist das Ergebnis unbekannt. Lange legitime Arbeits-/Wartephasen gehören vor Einführung fester Quellenfristen zur Abnahme.

Erster Poll und relevante Änderungen werden emittiert; spätestens nach 30 Sekunden kommt ein Lebenszeichen. Verglichen werden auch Aktualität, Verbindungsgeneration, Kontrollgesundheit und Aufmerksamkeitsübergänge. Der Renderer verwirft alte Generationen/Sequenzen. Fehlgeschlagene Polls aktualisieren Fehler/Aktualität, nicht die erfolgreich beobachtete Sessionliste. Zähler/Taskleiste nutzen das reduzierte Ergebnis, nicht rohe BEL-Bytes.

### 4.6 Frontend und Session-Inventar in Phasen

**Im gesamten ersten M1-Durchstich bleibt `applyStatus` ein Overlay auf bekannte Sessions.** Es setzt Status/Identität, fügt keine fremden Namen hinzu und löscht nichts. Die vorhandenen Listen-/Create-/Kill-Pfade bleiben Inventarführer. Ein vollständiger Snapshot darf einer eindeutig gebundenen bekannten Session ein Ende zuordnen; ein fehlgeschlagener/unvollständiger Poll darf das nicht.

Zum Poll als einziger Inventarquelle wird erst nach Signal-/Fehlertor und eigenem geprüften Plan gewechselt. Dieser behandelt alle Listenschreiber, Seed, Create/Kill-Races, Reload, externe Neuanlage/Rename, gleichnamigen Ersatz und unvollständige Antworten. M1.3 löst den Wechsel nicht automatisch aus.

Erfolgreiches Kill über die App entfernt nur den eigenen Eintrag. Bei `pane_dead`/`remain-on-exit` muss Entfernen die eigene existierende tmux-Session beenden, sonst erscheint sie erneut. Bei belegter Abwesenheit entfernt der Nutzer nur den lokalen Eintrag. Fremde Sessions bleiben gegen Kill geschützt. Socket und stabile IDs gehören von Beginn an zur Zuordnung; sichtbare Namen bleiben erhalten.

Kontrollgesundheit und Terminal-/Hostzustand sind getrennte Felder. Bei reinem Pollfehler: „Status seit hh:mm nicht aktualisiert“, Liste erhalten, funktionierende Terminals weiter bedienbar. Drei Kontrollfehler rufen weder `setHostState(..., failed)` noch eine pauschale Eingabesperre hervor. Control-Retry darf funktionierende Terminalkanäle nicht schließen. Ein erfolgreicher Poll darf umgekehrt eine tote Terminalverbindung nicht als verbunden markieren.

UI v2 reserviert Sessionzeile/Kachelkopf: fünf Formen mit Wort, nie Farbe allein. Agentenzustand vor Kanalzustand, 14 px Form plus Wort 11/14 (§7.6/§8.2). Ohne Beobachtung noch kein Agentenslot; danach unbekannt mit Grund und optionaler Hook-Hilfe. Tooltip zeigt Herkunft/Aktualität. Bell ist ein benannter Aufmerksamkeitshinweis, kein sechster Zustand. Eingaben/Fokus überstehen Render.

### 4.7 Fehlerfälle und Gesundheitsmodell

| Fall | Verhalten |
|---|---|
| Verifiziertes NoServer | Gültige Abwesenheit, keine Störung. Nur bekannte Identitäten dürfen beendet erscheinen; Overlay löscht die Liste nicht |
| TmuxError / Incomplete | Liste erhalten, Status veraltet/unbekannt, begrenzte Diagnose. Kein Host-/Terminalende behaupten |
| Transport / Deadline | Ein Kontroll-Strike; letzter vollständiger Snapshot bleibt erkennbar historisch |
| Drei Kontroll-Strikes | Kontrollverbindung gestört; Poll/Reparatur läuft weiter. Keine pauschale Terminal-Eingabesperre |
| Vollständiger Snapshot, bekannte ID fehlt | Beendet für diese Identität; gleichnamiger Ersatz erbt keine Daten |
| Servergeneration oder Pane-Identität geändert | Quellen/Ownership/Profile verwerfen. Alte Kachel sperren: „tmux-Server/Pane ersetzt“. Nicht still am Ersatz weiterschreiben |
| Agent ersetzt/beendet, Hook bleibt | Besitzerbindung entwerten; kein fortgeschriebenes arbeitet/wartet |
| Host bewusst getrennt | Task canceln/abwarten, beide Verbindungen schließen; keine verspäteten Updates |

Bei zwei Sekunden Pollpause/fünf Sekunden Deadline: dritter Timeout spätestens 19 Sekunden nach erstem betroffenen Pollstart, mit zwei Sekunden Startversatz etwa 21 Sekunden nach Unterbrechung. Das 25-Sekunden-Tor betrifft **Kontrollgesundheit**. Nachgelagertes Schließen verlängert diese Frist nicht (4.1). Fachliche tmux-/Parserfehler sind keine Aussage über TCP-Liveness, machen aber das Statusalter sichtbar.

### 4.8 Anmeldeart speichern

**Stand 2026-09-08:** In M0 bereits umgesetzt. Die folgenden Absätze bewahren den damaligen Entwurf mit historischen Codezeilen; sie sind keine offene M1-Aufgabe.

`HostEntry` (`settings.rs:41`) bekommt `auth_kind: Option<AuthKind>` mit `#[serde(default)]` und den Werten `key`, `agent`, `password`. Ein serde-Default kann nicht vom Nachbarfeld abhängen, deshalb liefert `HostEntry::effective_auth_kind()` bei `None` den Wert aus `key_path`: gesetzt heißt `key`, sonst `agent`. Vorhandene `settings.toml` bleibt ohne Migration lesbar, ein Test lädt eine alte Datei.

Schreibpfad: `HostDto` (`commands.rs:1785`) und `types.ts` bekommen `auth_kind`; `first-run.ts` und `host-form.ts` schreiben die gewählte Anmeldeart in den DTO, `list_hosts` liefert `effective_auth_kind()`, damit das Frontend nie `null` sieht. `app-state.ts` `Host` bekommt `authKind`, `main.ts` bildet es beim Laden ab.

Lesepfad: `onConnectHost(hostId, secret?: { passphrase?: string; password?: string })` durch `sidebar.ts`, `main.ts:519` und `:1566`; `main.ts:569` trägt das Passwort. `connect_host` liefert statt eines Strings einen typisierten `ConnectError { code, message }` mit den Codes `passphrase_required`, `password_required`, `auth_rejected`, `host_unreachable`, `host_key_rejected`, `other`, damit die Seitenleiste das richtige Feld zeigt. Für `password` zeigt die Hinweisleiste das Passwortfeld, für `key` mit Passphrase das Passphrasefeld. Passwörter und Passphrasen werden nie gespeichert, das steht so im README.

### 4.9 Aufmerksamkeit und Latenz

`session.nextWaiting` springt nur zu aktuell als wartet reduzierten Sessions. Fenstertitel-Zähler und einmalige Taskleisten-Aufmerksamkeit nutzen dieselbe Menge. BEL kann einen gesonderten Hinweis „Terminalglocke empfangen“ erzeugen; es erhöht nicht den Waiting-Zähler. Wiederholte Polls, Reconnect und doppelte PTY-/Poll-Beobachtung dürfen keine Benachrichtigungsschleife bilden. Aufmerksamkeitsquittierung ändert keinen fachlichen Hook-Status.

Tauris `setTitle` und `requestUserAttention` benötigen passende Capability-Rechte. `aria-live` meldet relevante Übergänge ohne jeden Poll vorzulesen. Ctrl+Shift-Ziffern werden über `event.code` erkannt. Command-/Capability-Änderungen folgen dem tatsächlichen Umsetzungsplan; die frühere feste Command-Anzahl ist keine Vorgabe.

**Vier Sekunden gelten ab Veröffentlichung eines verwertbaren Signals**, bei gesunder Kontrolle unter dem Flutlasttest. End-to-End-Latenz = Agent-Signalverzögerung + Pollwartezeit + Exec/Verarbeitung/UI. Die am 2026-09-08 abgerufene Claude-Referenz nennt für `Notification(permission_prompt)` ungefähr sechs Sekunden Wartezeit, für `idle_prompt` 60 Sekunden. Eine Vier-Sekunden-Zusage ab sichtbarem Claude-Freigabedialog ist damit unmöglich. `PermissionRequest` liegt früher, kann aber durch einen anderen Hook automatisch entschieden werden und beweist keinen tatsächlich wartenden Dialog. M1.0 dokumentiert pro Adapter diese Abwägung und misst beide Zeitpunkte. Keine Genauigkeitszusage durch Weglassen der Agent-Verzögerung.

### 4.10 Hook-Snippet und Quellenvertrag

Die App zeigt geprüfte, versionsgebundene Snippets zum Kopieren; sie installiert weder Skript noch Agent-Konfiguration auf dem Host. Ein einfacher `@agent_status waiting`-Wert ohne Besitzer ist kein hinreichender M1-Vertrag. Der Name `@agentbridge_status_v1` vermeidet zufällige Kollisionen. Alte `@agent_status`-Werte werden nicht still als aktuelle verifizierte Quelle übernommen.

Der versionierte Datensatz braucht Quelle/Agent, Agent-Instanz-ID, Pane-Bindung, Ereignisname/Grund, Zustand und eine prüfbare Ereignisreihenfolge/-zeit. Zustände/IDs erhalten eine Allowlist und Größenbegrenzung; Prompt, Toolargumente und Transcript werden nicht übertragen. Der Vertrag muss atomar lesbar sein und konkurrierende/späte Writer erkennen. SessionStart initialisiert den Besitzer; SessionEnd darf nur den eigenen Besitzer freigeben. Child-/Subagent-Ereignisse dürfen den Hauptagenten nicht beenden. Prozessabbruch ohne SessionEnd muss die Lebensdauer-/Identitätsprüfung abfangen. Kann das kleine Snippet diese Bindung unter den Abhängigkeiten nicht erfüllen, bleibt der Fall unbekannt.

Fensteroptionen bleiben wegen tmux 3.0 möglich, die Payload muss trotzdem den meldenden Pane identifizieren. Ein zweiter Pane im Fenster darf den aktiven nicht umetikettieren. Ohne `TMUX`/`TMUX_PANE` ist das Snippet ein No-op. Es endet schnell, mit begrenzter Laufzeit und ohne Ausgabe in den Modellkontext. Der künftige Hook-Vertrag darf keine ungeprüfte Abhängigkeit von `jq`, Python oder impliziter Shell-Auswahl einführen. Die bestehende Remote-Voraussetzung bleibt eine POSIX-kompatible Login-Shell mit tmux und `base64` im PATH (1); daraus folgt keine Unterstützung beliebiger Login-Shells. Zusätzliche Hilfswerkzeuge werden nicht still vorausgesetzt. Encoding, expliziter Hook-Interpreter und Snippet werden in M1.0 vor dem Kopierdialog geprüft.

Aktuelle Recherche, Abruf 2026-09-08; keine rückwirkende Zusage für die Messversionen:

| Adapter | Ansatzpunkte und Grenzen |
|---|---|
| Claude Code | Notification-Typen trennen: `permission_prompt`/`elicitation_dialog` können Eingabebedarf melden, `idle_prompt`/`auth_success` nicht pauschal. Prompt/Tool/Stop/Fehler/Ende gesondert prüfen. Stop ist nicht Prozessende, kann Hintergrundarbeit/weitere Stop-Hooks begleiten; Nutzerinterrupt löst keinen normalen Stop aus. Sechs-Sekunden-Latenz gehört zum Vertrag |
| Codex | Aktuelle Doku nennt `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PermissionRequest`, `PreToolUse`, `PostToolUse`, `Stop`, `Interrupt`, Compaction- und Subagent-Hooks. `hooks.json` oder `[hooks]` plus Hook-Vertrauen. Unterstützung in der gemessenen **0.93.0 ist nicht belegt**. Legacy `notify` mit `agent-turn-complete` liefert allein keinen vollständigen Status |
| Grok | Version 1.0.13 und `~/.grok/bin/grok` sprechen für xAI Grok Build, beweisen den Hersteller nicht. Erst Binary/Hersteller bestätigen. Das aktuelle xAI-Repo beschreibt Prompt-/Notification-/Stop-/Fehler-/Cancelled-/Start-/End-Hooks und Claude-Konfig-Kompatibilität; gegen die installierte Version prüfen |

[Claude-Hooks](https://code.claude.com/docs/en/hooks), [Codex-Hooks](https://learn.chatgpt.com/docs/hooks), [Codex-Notifications](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications), [Grok-Hooks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md), [xAI-Changelog](https://x.ai/build/changelog).

Codex-Titel bestehen heute aus konfigurierbaren Elementen. [HTML-Konfigreferenz](https://learn.chatgpt.com/docs/config-file/config-reference) und [offizielles JSON-Schema](https://learn.chatgpt.com/docs/config-schema.json) widersprechen sich bei Default/Abschaltung; deshalb kein `terminal_title = null`-Snippet und keine Annahme unveränderlicher Titel. Entscheidend ist der Test der unterstützten Version/Konfiguration.

### 4.11 Optionale Terminalsignale und weitere Forschung

Die Messung belegt BEL-Durchreichung für tmux 3.4 bei angehängtem PTY-Client, OSC 9 dagegen nicht. `term.onBell` darf ein Aufmerksamkeitsereignis mit Kachel-/Pane-/Verbindungsgeneration an denselben Reducer melden. Es setzt keinen lokalen Status vor die Backend-Regeln. Unbekannte Herkunft/alte Generation wird verworfen. Routing/Deduplizierung werden vor M1.6 getestet; OSC-9-/777-Handler gehören ohne neuen Transportnachweis nicht zum Durchstich.

Übersehener Kandidat: tmux 3.0 kennt native `alert-bell`-Hooks; 3.4 löst sie auch bei vorhandenem Bell-Flag erneut aus. Ein eigener Hook könnte wiederholbare Aufmerksamkeit in tmux-Metadaten ablegen, ohne dauernden Hilfsprozess. Zunächst nur eine Messoption auf isoliertem Testsocket, keine Erlaubnis zur Änderung fremder Sockets/Hooks. BEL bleibt semantisch unspezifisch. `kill-session -C` kann Alerts löschen, wird aber nicht als Poll-Quittierung eingesetzt: Es verändert Aufmerksamkeit anderer Clients. [tmux-3.0-Handbuch](https://raw.githubusercontent.com/tmux/tmux/3.0/tmux.1), [tmux-3.4-Alerts](https://raw.githubusercontent.com/tmux/tmux/3.4/alerts.c).

OSC 133 markiert Shell-Prompt-/Kommandogrenzen, keinen Agenten-Freigabevertrag. tmux 3.4 ergänzt Prompt-Markierungen; neuere Event-APIs sind kein tmux-3.0-Vertrag. Für interne Promptmarker der gemessenen CLIs liegt kein geprüfter Nachweis vor. `pane_in_mode`, Alternate Screen, DEC-Modi und Prozess-Wartezustände sind ebenfalls keine fachlichen Statusquellen. `capture-pane`/Transcripts bleiben außerhalb der M1-Erkennungslogik; History-Restore-Aufgaben sind getrennt. [OSC-133-Semantik](https://iterm2.com/documentation-escape-codes.html#shell-integrationfinalterm), [tmux-3.4-Änderungen](https://github.com/tmux/tmux/blob/3.4/CHANGES).

---

## 5. Messung und M1.0-Tor

Die [Messung vom 2026-09-05](../messungen/messung-2026-09-05-statussignale.md) lief auf 192.0.2.20 mit tmux 3.4, Claude Code 2.1.261, Codex 0.93.0 und „Grok 1.0.13“. Sie zeigt konkrete Titel/Bell-Beobachtungen unter einem Setup. Sie beweist weder allgemeinen Titelvertrag noch Hook-Verfügbarkeit, wiederholte Bell-Flanken oder vollständige Fehler-/Interruptabdeckung.

**Nachtrag 2026-09-08:** Der [reale Claude-Hook-Messblock](../messungen/messung-2026-09-08-claude-hooks.md) prüft die inzwischen installierte Version 2.1.263. Freigabe-Benachrichtigungen kamen nach ungefähr sechs Sekunden; Ablehnung und Arbeitsabbruch zeigten Lücken bei den Folgeereignissen. Daraus folgt noch kein freigegebener Produktionsadapter und kein vollständig bestandenes M1.0-Tor. Die [tmux-3.4-Gegenproben](../messungen/messung-2026-09-08-tmux-framing.md) belegen zusätzlich den Fehler bei `list-panes` auf einem lebenden leeren Server und widerlegen `q:` als Einzeilen-Framing. Ein nachgeschaltetes Base64 behebt nicht automatisch das bereits erfolgte tmux-Ausgabeescaping. Mindestversion 3.0 und vollständiger Codec bleiben offen.

M1.0 protokolliert Binary-Herkunft, Version, Betriebs-/Freigabemodus, relevante Einstellungen, tmux-Version und Attach/Fokus. Grok-Hersteller und abweichende Zeichen/Titel in der Übergabe vom 2026-09-08 sind zu klären. Kein Upgrade wird still zur Voraussetzung gemacht; eine neue unterstützte Version wird genannt.

| Bereich | Mindestfälle |
|---|---|
| Erster Hook-Adapter | Start, erste Aufgabe, lange Arbeit ohne Tool-Ereignis, echte Freigabe, genehmigt, abgelehnt, fertig, nächste Aufgabe |
| Aufmerksamkeit | Zweite/dritte Freigabe bei geschlossener Kachel; offen/fokussiert/unfokussiert; anderer tmux-Client; alte Bell beim ersten Poll; BEL eines gewöhnlichen Programms |
| Lebensdauer | Ctrl+C/Esc, API-/Auth-Fehler, harter Abbruch, fehlender/verspäteter Hook, `/clear`/Resume, gleichnamiger Sessionersatz, Pane-Respawn, Serverneustart |
| Konkurrenz | Subagent/Hintergrundarbeit, weiterer Stop-Hook, konkurrierende/späte Writer, zwei Panes |
| Latenz | Sichtbarer Zustand, Hook-Ereignis, Poll-Empfang und UI getrennt; lange Wartephase wird nicht allein wegen Alters untätig |
| Parser/Versionen | tmux 3.0/3.4: Identität, NoServer-Diagnosen, stderr-only-Fehler, fehlender Exitstatus, Metadatenframing, Kontrollzeichen, Größenlimit |

Zustandsfälle mindestens dreimal; Zuordnung manuell am Terminal prüfen. Minimierte Rohereignisse ohne Nutzer-/Promptinhalte als reproduzierbare Fixtures erhalten. Isolierten Testsocket nach Lauf entfernen; Produkt-/Standard-Socket nicht anfassen. Das historische Messdokument bekommt keine neu erfundenen Rohdaten.

Tor: Ein Adapter hat Zustands-/Versionsmatrix, Fehler-/Ownership-Regel und gemessene Latenz. Unbelegte Übergänge ergeben unbekannt. Ist kein Adapter unter den Randbedingungen tragfähig, endet M1.0 mit diesem Ergebnis und neuem Zuschnitt vor der restlichen Statusoberfläche. Weitere Profile ersetzen nicht die Prüfung des ersten Adapters.

---

## 6. Tests

| Ebene | Mindestprüfung |
|---|---|
| Parser | Erfolg/NoServer; stderr-only, Exit 127, Permission denied, fehlender Exitstatus, unbekannte lokalisierte Diagnose, PID ohne vollständiges Inventar, falsche IDs/Duplikate, Kontrollzeichen, abgeschnittene Antwort/Größenlimit. Kein Fehler darf Abwesenheit vortäuschen |
| Reducer | Fünf Zustände; alle gemessenen Claude-Titel ohne Hook unbekannt; BEL ändert keinen Status; Notification-Typen; alter Besitzer; Child-Ende; lange Phasen; atomare Hook-Werte; alte Generation/Sequenz; PTY-/Poll-Duplikate |
| Skript-Transport | Deadline um Kanalöffnung/Warten; kein Slot-Leak; ein Poll aktiv; Strikes betreffen Kontrolle; Erfolg heilt nur Kontrolle; unvollständiger Poll erhält Inventar; gleicher Name/neue IDs; Disconnect beendet Task; Heartbeat/Aktualitätsänderungen |
| Integration | Vier flutende Terminals, Kontrolle ansprechbar; TOFU-Schlüsselbindung/abweichender zweiter Schlüssel. Identität/NoServer auf 3.0/3.4. Echte Hooks gegen dokumentierte Versionen, nicht nur manuell gesetzte Werte |
| Frontend | Overlay fügt keine unbekannten Sessions hinzu/löscht nichts; Socket/IDs/Generation verhindern Fehlzuordnung; Kontrollausfall erhält nutzbare Terminals; Formen plus Text, Quelle/Aktualität und getrennte Aufmerksamkeit; Fokus/Eingaben; Waiting-Aktionen nutzen reduzierten Zustand |
| Fenster | Tore 3.4 und Matrix 5 protokollieren; End-to-End-Latenz und Vier-Sekunden-Pollziel getrennt ausweisen |

Vor Commit gelten Projektprüfungen und Stabilitätspaket. VM-Integration nur mit eingerichtetem Testhost/eigenem `AGENTBRIDGE_TEST_SOCKET`; ein Skip ist kein bestandener Integrationstest. Nicht verfügbare tmux-/Agent-Versionen bleiben ungetestet in der Freigabematrix. Der spätere Wechsel des Inventarführers braucht eigene Create/Kill/Reload-/Extern-Race-Tests; Overlay-Tests ersetzen sie nicht.

---

## 7. Offene Punkte

| Punkt | Bis wann |
|---|---|
| Neuer Name | Vor Tag `v0.2.0`, Nachfrage am M1-Tor. Rückfall in Abschnitt 2 |
| tmux-Mindestversion | Bisher nur 3.4 gemessen. Vor Freigabe der 3.0-Unterstützung Identitäts-/Framing-/Fehlerverträge auf 3.0 prüfen; nicht als bestandenen Test behandeln |
| Agent-/Hook-Versionen und Grok-Herkunft | M1.0: lokal gemessene Versionen sind kein Beweis für aktuelle dokumentierte Hook-Fähigkeiten; genaue unterstützte Versionen festhalten |
| Wortlaut der Position im README | M3.5: "nichts installiert, kein Daemon, kein Konto", mit ehrlicher Nennung des optionalen Hook-Snippets |

---

## 8. Nicht in diesem Zuschnitt

| Punkt | Grund |
|---|---|
| Links im Terminal öffnen (Roadmap S0.6) | Vom Auftraggeber gestrichen. Links bleiben wirkungslos, das Opener-Plugin bleibt totes Gewicht |
| CI (ehemals gestrichenes S0.7) | Die pauschale Streichung ist seit Freigabe des Stabilitätspakets am 2026-09-08 überholt. Tatsächlich ausgeführte Checks und nicht verfügbare VM-Integration getrennt ausweisen |
| Badge "anderswo geöffnet", `window-size manual` (S2.3) | Kein MVP. `session_attached` steht trotzdem in der Poll-Zeile, Abnehmer ist der Tooltip |
| fish, tmux außerhalb des PATH, ProxyJump, `.ppk`, ssh-agent-Reihenfolge (S2.4) | Kein MVP. Im README als Grenzen genannt |
| Diff-Panel, git-Badge | Entscheidung: nichts |
| `deny.toml`, `CONTRIBUTING.md`, Scoop, `user@host`-Zerlegung | Gestrichen für M3 |
| Dauerkanal nach Gesamtspec §6.1 | Ersetzt durch Exec-Poll (4.2) |
| `build` und `build_in_dir` als `Result` (H6 in der Roadmap-Form) | Die `assert!`s bleiben Programmier-Invarianten; Hostdaten werden an der Command-Grenze geprüft (`create_session_impl` für `cwd`, `list_directories_impl` für `path`, Sessionnamen über die Namensregel, Verzeichnisparser verwirft Steuerzeichen). Das trifft, was ein Nutzer auslösen kann, ohne 30 Aufrufer zu ändern |
| Profile als Datei (§12.2), Cache mit `session.json` (§5.3), A5 Worktrees, DPAPI, Updater, LRU, konfigurierbare Tastenbelegung, Windows ARM64, Kontrastmodus | Nach M3, wie in der Roadmap Abschnitt 5 |

---

## Einordnung der Messung vom 2026-09-05, korrigiert 2026-09-08

Die Rohbefunde bleiben im [Messdokument](../messungen/messung-2026-09-05-statussignale.md). Maßgeblich sind Abschnitte 4 bis 6 oben. Die alten Nachtragsregeln „BEL ergibt wartet“, „Arbeitsmuster verbraucht Bell“ und „Profilcache bleibt je Name bestehen“ sind zurückgenommen.

Claude hatte keinen unterscheidbaren Statustitel; `✳` (U+2733) ist kein Arbeitsbeweis. Codex/Grok-Titel waren in der damaligen Konfiguration unterscheidbar, werden aber erst nach Erweiterungsmessung freigegeben. Grok zeigte bereits Idle während Hintergrundarbeit. BEL kam bei tmux 3.4 am Client an, OSC 9 nicht; das rechtfertigt nur optionale Aufmerksamkeit. Die unverändert gesetzte Bell belegt keine weiteren Flanken. Freigabemodus und tatsächlicher Eingabebedarf gehören zur Versions-/Konfigurationsmatrix.

## Nachtrag 2026-09-05, zweiter: UI v2 vor M1

Der Auftraggeber hat am selben Tag die Oberfläche neu entschieden (`specs/2026-09-05-ui-v2-design.md`, Mockup `specs/2026-09-05-ui-v2-mockup.html`). Folgen für dieses Dokument:

- **§3.3, neue Zeile vor M1.1:** **UI v2** — Designsystem v2 (Türkis auf Graphit als Standard, Blau auf Schiefer, nur dunkel), Hostkarten, Kacheln mit Radius und Abstand, Erststart "Willkommen mit Vorschlägen", Einstellungsdialog mit Themenwechsler, Fenster 1280 x 800. 8 Tage. Tor nach UI-v2-Spec §17, danach Tag `v0.1.2`. Beginn nach dem Tag `v0.1.1`.
- **§3.3 M1.2:** "Designsystem-Nachtrag mit den fünf Formen als erste Handlung" bezieht sich auf die UI-v2-Spec (§7.6, §8.2), nicht mehr auf v1. Platz und Geometrie des Agentenzustands stehen dort fest; M1.2 definiert nur die fünf Formen und die Wörter.
- **§4.6:** Die aktuelle Fassung integriert den UI-v2-Slot: Agentenzustand vor Kanalzustand, 14 px Form plus Wort 11/14. Der Slot wird erst mit Beobachtungsdaten gerendert.
- **§3.3 M3.2 / Roadmap S3.2:** Die Mindestgröße des Fensters (1100 x 700) zieht UI v2 vor (UI-v2-Spec §15); S3.2 behält nur das Merken von Fensterlage und Größe.
- **§4.9:** UI v2 hatte `ui_settings` ergänzt. Die spätere M1-Implementierung prüft ihre Commands/Capabilities gegen den tatsächlichen Code; die frühere feste Anzahl ist keine Vorgabe mehr.
- **§3.4 Tor M1:** Maßgeblich ist das am 2026-09-08 korrigierte Tor oben, geprüft in UI v2.

## Nachtrag 2026-09-13: Statusquelle und Umsetzungsstand

Festgehalten nach der Vorgabe des Auftraggebers in der Übergabe vom 13.09.2026. Der Quellencheck 16 hatte verlangt, eine CLI-Quelle ausdrücklich in die Spec zu schreiben statt sie stillschweigend einzuführen. Dieser Nachtrag ersetzt, wo er abweicht, §2 (Zeile „Hooks“), §3.3 M1.3/M1.6, §3.4 (Adaptersatz im Tor M1), §4.4 Schritt 3, §4.10 und §5 (Zeile „Erster Hook-Adapter“).

**Quelle:** kombiniert. Das Inventar liefert unbekannt und beendet. Ein lesender Aufruf `claude agents --json` über die Kontrollverbindung liefert arbeitet, wartet und untätig, nur aus Zeilen mit `kind: interactive`, gültigem `status` und bekanntem `waitingFor`. Eine Zeile bindet nur an eine Pane, wenn ihre `pid` gleich `pane_pid` ist oder ihr `PPid` aus `/proc` gleich `pane_pid` (Handstart in der Pane-Shell). Mehrere Treffer ergeben unbekannt. Der Sessionname ist nie Identität. Hintergrundzeilen (etwa `state: blocked` ohne `status`) werden ohne eigene Messung nicht auf einen interaktiven Zustand abgebildet.

**Aus dem Produkt:** Hook-Snippet, Kopierdialog, Hook-Writer und das optionale Python-Profil. Auf der VM bleibt das Minimum: SSH, tmux und ein von Hand gestarteter Agent. Kein Watcher, keine SessionStart-Probe als Dienst, keine Konfigurationsänderung, kein eigener Startdialog für Claude Code. Die Messhelfer unter `scripts/m1-*.py` sind Nachweiswerkzeuge, keine Produktteile.

**Poll:** Er führt die Sessionliste weiterhin nicht (§4.6). Umgesetzt ist er als Overlay im Frontend alle 2 s über das schlanke Kommando `poll_status` (seit 14.09.: `tmux -V`, ein numerisches Inventar, `claude agents --json`, bei Treffern `/proc`; vier Befehle je Host, 5 s Frist nach §4.1), nicht als Backend-Task mit `status://update` nach §4.2/§4.5. Jede Session gilt über ihre einzige aktive Pane; eine tote aktive Pane ist beendet (§4.4 Schritt 2); eine unbekannte Claude-Zeile macht nur ihre Session unbekannt. Nach gescheiterter Abfrage, gestörter Kontrolle oder neuer Verbindung zeigt die Statuspille „As of hh:mm“ statt des letzten Werts, und der Host zählt nicht als wartend, bis eine Abfrage wieder gelingt. Formen, Wörter, Sessionzeile und Tooltip regelt der UI-v2-Nachtrag vom 14.09. Gegenüber §4.5 offen: Heartbeat und Sequenz.

**Tor M1:** Im Adaptersatz tritt an die Stelle von „mindestens ein versionsgeprüfter Hook-Adapter“ die gebundene CLI-Quelle für Claude Code in den gemessenen Versionen (2.1.269, 2.1.270). Die übrigen Bedingungen des Tors bleiben unverändert.

## Nachtrag 2026-09-14: Titelquelle für Codex und Grok

Wunsch des Auftraggebers vom 14.09.: Status auch für andere Agents. Nach der [Titelmessung](../messungen/messung-2026-09-14-titel.md) entschieden: Codex und Grok bekommen den Terminaltitel als Quelle, Claude Code bleibt bei `claude agents --json`. agy, OpenCode und Gemini CLI bleiben vorerst unbekannt, bis es ein tragfähiges Signal gibt. Im Poll-Absatz des Nachtrags vom 13.09. werden damit aus vier Befehlen je Host fünf.

**Quelle:** Ein zusätzlicher lesender Befehl liest für die einzige lebende aktive Pane jeder Session den Titel (`display-message -p '#{pane_title}'`, hex-kodiert) und die Programmnamen der Kinder und Enkel der Pane-Shell aus `/proc/<pid>/comm`, keine Kommandozeilen. Der Titel zählt nur, solange das Agentprogramm dort läuft: als Kind, bei Codex über npm als Enkel unter `node`. Zwei verschiedene Agents auf einer Ebene ergeben keine Zuordnung. Nur die gemessenen Titelformen ergeben arbeitet, wartet oder untätig, jede andere ergibt unbekannt. Eine gebundene Claude-Zeile hat Vorrang; eine tote aktive Pane bleibt beendet. Die Sessionliste liest dieselbe Quelle für die gewählte Pane, damit ein Neuladen den Status nicht zurücksetzt.

**Frist:** Der Titelbefehl hat höchstens 1 s innerhalb der 5-s-Frist und läuft vor dem Claude-Aufruf. Ein Fehler bedeutet „keine Titelquelle“, nie einen gescheiterten Poll.

**Grenzen:** Codex gilt nur in der Form `<thread> | <project>` als untätig; ein frisch gestartetes Codex ohne Thread bleibt unbekannt, weil ein bloßer Name auch von tmux oder der Shell stammen kann. Eine offene Grok-Freigabe (`⚠ Action Required - <spinner> - … - grok`, gemessen am 05.09. mit 1.0.13, der Text steht auch in 1.0.30) ergibt wartet; ein Titel mit „Action Required“ ergibt nie untätig. Schiebt Grok einen langen Shell-Befehl in den Hintergrund, zeigt der Titel zeitweise untätig (Messung vom 05.09.). Codex-Einstellungen abseits der Voreinstellung (`tui.animations`, `tui.terminal_title`) können den Spinner ausblenden; eine Bindung an diese Einstellungen steht vor dem Release-Kandidaten aus. Es gibt keine Versionsprüfung je Poll; eine geänderte Titelform fällt auf unbekannt zurück.

## Nachtrag 2026-09-15: NoServer am benannten Socket

Befund der Vorprüfung zum M1-Tor: Seit dem 13.09. liest `list_sessions` über die numerische Beobachtung. Der benannte Socket (`-L agentbridge`) konnte dort nie NoServer ergeben, weil sein Diagnosepfad nicht belegt war (§4.3). Auf einem Host ohne laufenden Server der App scheiterte deshalb die Sessionliste. Das numerische Beenden der letzten Session meldete einen Fehler, obwohl die Session beendet war.

**Regel:** Unter tmux 3.3a und 3.4 hat der benannte Socket keinen Server, wenn zwei Bedingungen zusammen gelten. Erstens liefert die erste Listenabfrage Exit 1, leeres stdout und genau eine der beiden gemessenen Diagnosen: `no server running on <Pfad>\n` oder `error connecting to <Pfad> (No such file or directory)\n`. Zweitens sagt eine zweite, rein lesende Abfrage in derselben Umgebung genau diesen Pfad voraus: aufgelöstes `$TMUX_TMPDIR` oder `/tmp`, dann `tmux-<uid>/<Name>`, wie `make_label` in tmux 3.4. Jede Abweichung bleibt TmuxError. Es gibt keine Namens- oder Teilstringregel.

**Folge:** `list_sessions` liefert dann eine leere Liste, das numerische Beenden gilt als bestätigt. Eine leere Beobachtung braucht weiterhin einen lebenden Server. Der Statuspoll bleibt unverändert; sein Fehlschlag markiert den Status als nicht aktuell und hat auf einem Host ohne Sessions keine sichtbare Folge.

**Messung vom 15.09.** in der exakten Produktform auf 192.0.2.10 (tmux 3.3a) und 192.0.2.20 (tmux 3.4), beide Versionen mit demselben Ergebnis:

| Fall | Ergebnis |
|---|---|
| Socket-Datei fehlt | Diagnose gleich Vorhersage: kein Server |
| Datei liegt noch, Server beendet | Diagnose gleich Vorhersage: kein Server |
| Gewöhnliche Datei am Socket-Pfad | Diagnose gleich Vorhersage: kein Server |
| Laufender Server | Liste normal, keine Vorhersage nötig |
| Socket-Verzeichnis mit unsicheren Rechten | andere Diagnose: Fehler |
| `TMUX_TMPDIR` zeigt ins Leere | tmux weicht auf `/tmp` aus, die Vorhersage bleibt leer: Fehler |

Frisches `TMUX_TMPDIR`, abschließender Schrägstrich und Symlink ergaben dieselbe Übereinstimmung. tmux 3.0 bildet den Pfad beim allerersten Aufruf als `/tmp//tmux-<uid>` und ist nicht erneut gemessen; dort bleibt eine fehlgeschlagene erste Liste ein Fehler.

## Nachtrag 2026-10-23: Agentversionen und gehärtete Titelquelle

Nach der [Messung vom 23.10.](../messungen/messung-2026-10-23-agentversionen.md) mit Claude Code 2.1.309 und Codex 0.163.0 und 0.164.0. Dieser Nachtrag ersetzt, wo er abweicht, die Nachträge vom 13.09. und 14.09.; Grok bleibt dort unverändert, ist aber nicht erneut gemessen und vorerst nicht Teil des Tors (Entscheidung des Maintainers vom 23.10.).

**Versionen:** Keine feste Versionsbindung. Die Formen werden gegen die jeweils neueste Version gemessen; jede Version zählt, solange ihre Ausgabe eine gemessene Form hat, jede andere Form ergibt unbekannt. Im Tor M1 tritt an die Stelle von „in den gemessenen Versionen (2.1.269, 2.1.270)“ die zuletzt gemessene Version, am 23.10. Claude Code 2.1.309 und Codex 0.164.0. `waitingFor: "goal proposal"` (2.1.309, dort eine Freigabe) gehört zum bekannten Vokabular.

**Identität:** Der Lesebefehl liest statt `/proc/<pid>/comm` den Pfad aus `/proc/<pid>/exe`. Es zählt der Dateiname; ein Pfad in `…/claude/versions/` gilt als Claude Code, ein angehängtes ` (deleted)` wird übergangen, `<name>.<Ziffern>.old` (agy 1.4.6 nach seinem Selbstupdate) zählt als `<name>`.

**Grenzen:** Titel bis 1024 Byte, Programmpfade bis 4096 Byte, je Einstellungsdatei bis 16384 Byte. Das Skript liest je Wert ein Byte mehr; was darüber hinausgeht, verwirft der Parser. Ein verworfener Titel ergibt bei Codex und Grok unbekannt.

**Codex-Einstellungen:** Nur wenn unter einer gelesenen Pane ein Programm namens `codex` läuft, gibt derselbe Befehl `/etc/codex/config.toml` und `${CODEX_HOME:-$HOME/.codex}/config.toml` aus, je auf die `tui`-Schlüssel gefiltert (Zeilen `tui…` vor der ersten Tabelle und die Tabellen `[tui]` und `[tui.*]`). Die Benutzerdatei überschreibt die Systemdatei Schlüssel für Schlüssel. Ohne Spinner (`tui.animations` oder `tui.effects.progress` aus) ergibt nur „Action Required“ wartet, jede andere Form unbekannt. Eigene Titelelemente (`tui.terminal_title` abweichend von `activity`/`spinner`, `thread-name`, `project-name`) ergeben unbekannt, eine unlesbare Datei ebenso. Projektdateien, `-c`-Optionen und die reduzierte Bewegung des Desktops bleiben ungelesen. Ein Codex-Titel mit „Action Required“ oder dem Mikrofonzeichen „●“ vorn ergibt nie untätig.

**Test:** `src-tauri/tests/integration_status_title.rs` prüft Lesebefehl und Parser an einem echten Host mit Attrappen (Kopien der Shell unter Agentnamen), nur auf dem eigenen Testsocket.
