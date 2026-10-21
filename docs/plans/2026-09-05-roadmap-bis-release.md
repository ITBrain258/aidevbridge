# Roadmap bis zum nutzbaren Release

**Datum:** 2026-09-05
**Stand:** `main` am 2026-09-05
**Anlass:** Bewertung vom 2026-09-04 (41 Einzelprüfungen, jeder Befund mit Gegenprobe). Die Frage: Was zuerst, wann, wo und wie, bis andere Leute das Werkzeug herunterladen und benutzen können.
**Fassung:** nach genau einer Kritikrunde (fünf Prüfer: Abhängigkeiten, Aufwand, Fremdnutzer-Durchlauf, Spec-Abgleich, Vollständigkeit). Die Kritik hat rund zehn Netto-Tage Arbeit gefunden, die der Entwurf nicht hatte. Sie stehen jetzt drin.
**Bezug:** frühere Stand- und Analysedokumente (nicht im öffentlichen Repository), Spec `2026-07-25-agentbridge-design.md` §4.2, §6, §9, §11, §14, Designsystem 2026-07-27 §7.1.

---

## 1. Ziel und Meilensteine

Der Kernsatz der Spec ist das Produkt: bei sechs Agents erkennen, welcher wartet. Nichts davon ist heute gebaut. Deshalb steht der Statuspunkt vor jeder Politur, und die Härtung vor M1 wird auf das beschränkt, was einen Erstnutzer tatsächlich trifft oder eine Weitergabe an Fremde verbietet.

Vier Meilensteine, jeder mit einem Tor, das man am laufenden Fenster prüft. Die Freigabestufen stammen aus dem Stand-Dokument.

| M | Name | Version | Bedeutet | Netto-Tage, auf halbe Tage gerundet |
|---|---|---|---|---|
| M0 | Fundament | 0.1.1 | Der Entwickler benutzt es täglich ohne bekannte Stolperer. Der Baum ist weitergabefähig: Name fest, russh aktuell, Version sichtbar, Abnahme einmal ausgefüllt | 6 |
| M1 | Statuspunkt | 0.2.0 | Das Produktversprechen existiert. Interne Beta unter Freunden | 11,5 |
| M2 | Verlässlichkeit | 0.3.0 | Laptop zu, Laptop auf, weiterlesen. Ohne Handarbeit. Fremde Hosts verbinden oder erklären, warum nicht | 10 |
| M3 | Öffentlich | 0.4.0 | Ein Fremder lädt herunter, installiert, verbindet, sieht Status. Ohne Chat mit dem Entwickler | 13 |

Die Schritte in Abschnitt 3 summieren sich auf 39,6 Netto-Tage, mit 15 % Puffer rund 46. 1.0 gibt es erst, wenn der Wartezustand von Claude Code gemessen und erkannt ist und das Binary signiert ist.

Die Reihenfolge kehrt das Stand-Dokument um: Dort steht Phase 1 (CI, Härtung, Abnahme) vor dem Statuspoll. Mit dieser Reihenfolge hat das Projekt 41 Tage verbracht. Was von Phase 1 einen Erstnutzer trifft, liegt in M0. Der Rest wandert nach M3 oder ins Backlog.

**Kürzbar, ohne das Ziel zu verletzen:** S2.3 (A2 sichtbar, 1,5 d), S1.7 (PTY-Signale, 0,5 d, falls die Messung zeigt, dass tmux BEL und OSC 9 nicht durchreicht), S1.10 (Hook-Snippet, 0,5 d), S3.8 (winget, nach dem Release). Zusammen bis zu 3 Tage.

---

## 2. Entscheidungen mit Vorgabe

Diese Punkte kann nur der Auftraggeber entscheiden. Der Plan läuft unter der Vorgabe weiter und nennt, was sich bei Umkehr ändert.

| Entscheidung | Vorgabe im Plan | Bei Umkehr ändert sich |
|---|---|---|
| Name | Umbenennen in M0 (eine Marktanalyse schlug `Vigil` vor; entschieden ist aidevbridge, siehe `docs/stand.md`). Frist ist der Tag `v0.2.0`: Danach liegen bei Beta-Nutzern `settings.toml` und laufende Sessions unter dem alten Namen, eine Umbenennung kostet dann eine Migration von Einstellungspfad und Socket (0,5 d) und bricht ihre Sitzungen bis S3.1 | S0.8 entfällt. `agentbridge` muss vor `v0.2.0` bewusst bestätigt werden |
| Einstellungsverzeichnis | Am Tauri-Identifier (`app_config_dir`), einmalige Migration des alten Pfads, damit der Deinstaller es kennt | Getrennt lassen und im README als Rest nach Deinstallation nennen |
| Produktlesart | Agent-Werkzeug, Termius nur Maßstab für die Hülle | Der gesamte Plan ab M1 ist gegenstandslos |
| Hooks | Nur Snippet: Die App zeigt die tmux-Zeile, schreibt nie auf die VM | S1.10 wächst um 2 bis 3 Tage (Merge in fremde Konfiguration, Vorschau, Rücknahme) |
| Benachrichtigung | Weicht von Spec §7.1 bewusst ab: Fenstertitel-Zähler und einmalige Taskleisten-Aufmerksamkeit ja, Toast nein | S1.8 wächst um 1 Tag und eine Plugin-Abhängigkeit |
| Fremde Sessions | Bedienbar, Kill gesperrt, nie `attach -d`, nie Serveroptionen, nie Hooks | S3.1 schrumpft um 0,5 Tage, verliert aber das Argument "wir docken an dein tmux an" |
| Diff | Nicht-Ziel bleibt. Einzige spätere Konzession: git-status-Badge je Session | Backlog, nicht dieser Plan |

---

## 3. Ablauf

Jeder Schritt: Was, Wo, Wie, Tor, Netto-Tage. Die Stellen stammen aus der Bewertung und der Kritikrunde und sind am Code vom 2026-09-04 geprüft. Der Detailplan je Schritt entsteht, wenn der Schritt beginnt, nicht hier.

### M0 Fundament (6 Tage)

Reihenfolge wie nummeriert. S0.10 läuft als Letztes, weil die Abnahme alles davor am Fenster prüft.

**S0.1 Sperrleiste sichtbar (0,1 d).** Wo: `src/styles.css:1329` und `:1238`. Wie: `display: flex` aus den Basisregeln in `.tile-lock:not([hidden])` und `.tile-lock-chip:not([hidden])` verschieben, das Muster steht dreimal in derselben Datei. Tor: Eine gesunde Kachel zeigt im laufenden Fenster keine Sperrleiste.

**S0.2 Ausgabe ohne Host-ID (0,25 d).** Wo: `src-tauri/src/commands.rs:454` (Struct), `:491` (Emit), `:1304` (Pumpe), `src/terminal.ts:433`, dazu die fünf `OutputSink`-Implementierungen in Code und Tests. Wie: `host_id` in `OutputEvent`, im Frontend derselbe Vergleich wie beim connection-lost-Listener in Zeile 474. Test "zwei Hosts, gleichnamige Session" nach `terminal.test.ts:1309`. Tor: Zwei Kacheln `dev` auf zwei Hosts zeigen getrennte Ströme.

**S0.3 RSA und russh (0,75 d).** Wo: `src-tauri/src/ssh/auth.rs:410` und `:368`, `russh_transport.rs:23` (`check_server_key`) und `:96` (Handle), `src-tauri/Cargo.toml:37`, `Cargo.lock:3629`. Wie: russh auf 0.63.x heben, `check_server_key` auf die neue Signatur, dann `best_supported_rsa_hash()` nach dem Connect abfragen und an beide Aufrufstellen geben, Rückfall SHA-256. Beides in einem Schritt, weil es dieselbe Datei und dieselbe VM-Testrunde ist, und weil zwei client-relevante Advisories nicht in eine Beta gehören. Tor: `id_rsa` gegen Ubuntu 22.04 verbindet, Integrationstests gegen die VM grün.

**S0.4 Härtung H5 bis H9 und TOFU-Dialog (1 d).** Wo: `commands.rs:989` (H5), `preflight.rs:95` (H7), `known_hosts.rs:165` und `:199` (H8, `lookup` bekommt den Schlüsseltyp als Parameter, Hinweis über `HostKeyRequest` bis in `host-key-prompt.ts`), `remote/command.rs:12`, `:26`, `:67` (H6 und H9: `assert!` wird `Result`, Aufrufer zeigen den Fehler im Dialog), `main.ts:1559` und `host-key-prompt.ts:282` (TOFU-Dialog setzt `#app` inert, bekommt `aria-modal` und `aria-labelledby`; Analyse-Befund 14 vom 2026-08-03). Tor: die Tests aus der Analyse, dazu "relatives cwd ergibt Fehlertext, keinen Panic" und "hinter dem offenen TOFU-Dialog ist per Tab nichts erreichbar".

**S0.5 Rotes Banner bei jedem Kanalende (0,15 d).** Wo: `commands.rs:1462` (`ack_output_impl`), `src/terminal.ts:450` und `:528`. Wie: Ack für einen unbekannten Schlüssel ist im Backend `Ok`, wie `disconnect_host_impl` idempotent ist. Im Frontend ein `channelClosed`-Flag, das den Refit überspringt. Tor: `kill-session` von außen erzeugt Sperrleiste, kein Fehlerbanner. Unit-Test im commands-Testmodul.

**S0.6 Links richtig öffnen (0,35 d).** Wo: `src/terminal.ts:205` (`window.open` ist unter Tauri ein No-op), `src-tauri/capabilities/default.json`, deren Kopfkommentar "GENAU EIN Recht darüber hinaus" mitzieht. Wie: Das Opener-Plugin bleibt, `openUrl` statt `window.open`, Recht `opener:allow-open-url` auf http und https beschränkt, vorher ein Bestätigungsdialog mit der vollen URL (Spec §8.3). Test im Block `terminal.test.ts:1331`. Tor: Ein OSC-8-Link öffnet erst nach Bestätigung im Standardbrowser.

**S0.7 CI-Tor (0,75 d).** Wo: `.github/workflows/ci.yml`, `src-tauri/tests/common/mod.rs:78`, neue `.gitattributes`. Wie: `npm test` in den Frontend-Job. `cargo audit` als eigener Job. Im ubuntu-Job einen ed25519-Schlüssel erzeugen, `sshd` auf localhost starten und `AGENTBRIDGE_TEST_HOST=localhost` setzen, damit die Integrationstests der Ebene 2 zum ersten Mal in der CI laufen (Spec §11.3). Ohne Host melden sich Skips mit einer Zeile wie in `integration_preflight.rs:9`. `.gitattributes` mit `* text=auto eol=lf`, `*.sh eol=lf`, `*.ps1 eol=crlf`, bevor S1.1 das erste Shell-Skript ins Repo legt. Tor: Ein grüner Lauf hat sshd und tmux gesehen, und er sagt, was er nicht geprüft hat.

**S0.8 Umbenennung und SignPath (0,75 d, nach Entscheidung).** Wo: `tauri.conf.json:5` (identifier) und `productName`, `settings.rs:121` (Einstellungspfad, künftig `app_config_dir` mit Migration), `settings.rs:82` (`default_socket`), `tmux/client.rs:36`, `Cargo.toml`, `package.json`, Fenstertitel, Tests mit dem String (`settings.rs:237`, `commands.rs:3273`), rund 110 Treffer außerhalb von `docs/`, Repo-Name mit GitHub-Weiterleitung. Wie: Grep-Liste, ein Commit. Danach sofort **SignPath Foundation beantragen** (Wochen Vorlauf, braucht Name und Repo-URL, Spec §11.2).

**S0.9 Release-Hygiene und CSP (0,75 d).** Wo: neues Skript `scripts/bump-version`, `CHANGELOG.md`, `vite.config.ts` (`define` für Version und Commit-Hash), `sidebar.ts:783` (Diagnosetext), `tauri.conf.json` (`csp`). Wie: Ein Bump hebt `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package.json` und `package-lock.json` in einem Commit, sonst wird die CI mit `--locked` rot. CHANGELOG beginnt bei 0.1.1. Version und Commit stehen in der Seitenleiste und im Diagnosetext, damit Beta-Berichte einem Build zuzuordnen sind. CSP von `null` auf eine Richtlinie, die xterm.js mit Inline-Styles und WebGL trägt. Tor: S0.10 prüft die CSP am Fenster, mit Suche, Dialogen und TOFU.

**S0.10 Manuelle Abnahme und Fixdurchgang (1 d).** Wo: `docs/abnahme-handarbeit.md`. Wie: die sechs Spalten des Dokuments einmal am echten Tauri-Fenster ausfüllen, dazu Punkt 7 "einmal nur mit Tastatur, inklusive TOFU". Das ist die einzige Prüfung, die den Startfehler vom 29.07. (die App startete nicht, wenn `DOMContentLoaded` schon gefeuert hatte) und die Dauersperre vor dem Nutzer gefunden hätte. Ein halber Tag ist für die Stolperer reserviert, die dabei auftauchen. Tor M0: Tabelle ausgefüllt, Stolperer behoben, Tag `v0.1.1`.

### M1 Statuspunkt (11,5 Tage)

**S1.1 VM-Messung (1 d).** Wo: die beiden VMs mit tmux 3.3a und 3.4, Claude Code und Codex. Wie: Ein Skript zeichnet je Zustand `pane_title`, `alternate_on`, `window_bell_flag` auf, prüft, ob BEL und OSC 9/777 durch tmux gehen, ob der Titel im Alternate Screen weiter aktualisiert wird, und was `set-titles` für den äußeren Client tut. Ergebnis als `messung-<datum>-statussignale.md` plus Profiltabelle. Tor: V16b und V16c haben eine Antwort, auch wenn sie "nicht erkennbar" lautet. Ohne diese Messung beginnt S1.4 nicht. S1.2 und S1.3 laufen parallel dazu.

**S1.2 Zweite Verbindung je Host (1,5 d).** Wo: `commands.rs:100` (Map-Wert), neun Zugriffe auf `.hosts`, `:1048` (Connect), `:820` (TOFU). Wie: `HostConnection { control, terminal }`, exec-Aufrufer auf `control`, `open_terminal_impl` auf `terminal`. Die TOFU-Policy führt den akzeptierten Schlüssel nach, sonst fragt der zweite Aufbau beim Erstkontakt noch einmal. Tor: Integrationstest "1 MiB unbestätigt auf einer Kachel, `create_session` antwortet unter einer Sekunde" (heute 20 Sekunden) und "zwei Verbindungen, eine Rückfrage".

**S1.3 Poll und Parser (1,25 d).** Wo: `transport/mod.rs:31` und `russh_transport.rs:248` (`exec` lernt eine Deadline, die INNERHALB der Warteschleife greift und auf jedem Ausgang `ch.close()` ruft, sonst leckt jeder Abbruch einen Kanal-Slot, V2), `tmux/client.rs` neben `list_sessions`, neues `tmux/poll.rs`. Wie: Eine verkettete tmux-Zeile: `display -p '#{pid}'` als Epoche, dann `list-panes -a -f '#{pane_active}' -F` mit `\x1f`-Trenner. Felder: `session_name`, `window_active`, `pane_dead`, `pane_current_command`, `alternate_on`, `session_attached`, `pane_current_path`, `window_activity`, `window_bell_flag`, `@agent_status`, `pane_title` zuletzt. Socket als Parameter von Anfang an, damit S3.1 nur den Schlüssel erweitert. Alle 2 Sekunden auf der Kontrollverbindung, Deadline 15 Sekunden, ein Poll in Flug, Abbruch über `Notify` wie `OpenTerminal.cancel`. Zeilenvalidierung mit der Regel aus `names.rs:49`. Tests mit `ScriptedTransport`, auch "zwei Zeilen je Session". Abweichung von Spec §6.1: kein `read -t`-Dauerkanal. Grund: kein neuer Kanaltyp, keine bash-Abhängigkeit, zwischen zwei Polls läuft nichts auf der VM.

**S1.4 StatusDetector (1 d).** Wo: neues Modul `src-tauri/src/status/`, Crate `regex` in `Cargo.toml`. Wie: reine Funktion mit Vorrang `pane_dead`, dann frischer `@agent_status`, dann `window_bell_flag`, dann Titelmuster aus der Profiltabelle, dann Login-Shell als untätig, sonst unbekannt. Bei mehreren Panes zählt der aktive Pane des aktiven Fensters, ein Flag `split` für den Hinweis aus Spec §6.7. Regel: Ein Profil, dessen Wartezustand nicht gemessen ist, bildet seinen Ruhemarker auf unbekannt ab, nie auf untätig. Tor: Unit-Tests mit den gemessenen Strings aus S1.1.

**S1.5 Poll-Task, Sink, Ereignis (1 d).** Wo: `commands.rs` neben `OutputSink` (Zeile 468), Lebenszyklus an `HostConnection`, Abbau in `disconnect_host_impl` (Zeile 1597). Wie: ein Task je Host, `StatusSink` nach dem Muster der beiden vorhandenen Sinks, Ereignis `status://update` mit `host_id`, `socket` und Epoche. Ein Poll, der scheitert, meldet den Hostzustand, kein Sessionende. Der Task erkennt eine tote Kontrollverbindung und ist damit der Auslöser für S2.2. Ein Ereignis braucht keine ACL-Änderung. Tor: Trennen hinterlässt keinen Prozess und keinen Task.

**S1.6 Frontend Status (3 d).** Wo: `src/state/app-state.ts` (`Session` bekommt `status`, `socket`, `epoch`), `src/views/sidebar.ts:125` (Indikator), `grid.ts` (Kachelkopf), `src/i18n/en.json`, neues `src/i18n/t.ts` (die achtfache Kopie von `t()`), Designsystem-Nachtrag zu Verbot 5 und §8.4. Wie: diffender Mutator nach dem Muster `applyInputLocks` (`app-state.ts:459`), zweiter Indikator-Slot mit fünf Formen und Text, Tooltip des "?"-Zustands verweist auf das Hook-Snippet. Regel aus Spec §9.3: Poll erfolgreich und Session fehlt ergibt "beendet (Server)", bis der Nutzer sie entfernt. Poll gescheitert lässt die Liste unverändert. Klick auf eine beendete Session öffnet kein Terminal und zeigt "Entfernen". Passphrase-Feld übersteht ein Neuzeichnen (`sidebar.ts:1483`, Befund 11). Tor: Sechs Sessions, ein Poll-Tick, keine Fokus- und keine Eingabeverluste.

**S1.7 PTY-Signale der sichtbaren Kachel (0,5 d).** Wo: `src/terminal.ts` (`registerOscHandler(9)`, `(777)`, `onBell`), `app-state.ts`. Wie: ein Aufmerksamkeitsflag mit Zeitstempel je Kachel, zurückgesetzt bei Eingabe (Spec §6.1 "seit letzter Eingabe"), im Frontend vor dem Titelmuster gewertet. Grund: `window_bell_flag` setzt tmux nie für das aktuelle Fenster einer angehängten Session, die offene Kachel braucht den Strom. Entfällt, wenn S1.1 zeigt, dass tmux die Sequenzen nicht durchreicht.

**S1.8 Sprung, Titel, Taskleiste (1 d).** Wo: `src/keymap.ts` (neue Aktion `session.nextWaiting`, `sidebarSessionOrder` existiert; Zeile 221 für Befund 7, Ziffern über `event.code`), `main.ts` (Fenstertitel), `capabilities/default.json` (`core:window:allow-request-user-attention`, bei Bedarf `allow-set-title`), `aria-live` für Verbindungszustand und "wartet" (Analyse-Befund 15). Wie: Fenstertitel "(2 waiting) …", einmaliges `requestUserAttention` beim Übergang nach wartet. Tor: Aus dem Editor heraus sieht man in der Taskleiste, dass jemand wartet, ein Akkord bringt einen hin, ein Screenreader sagt es an.

**S1.9 Auth-Absicht speichern (0,5 d).** Wo: `settings.rs:41` (`HostEntry`), `main.ts:569` (`password: null`, im Kommentar als "bekannte Grenze aus Plan 1" benannt), `commands.rs:432`, `sidebar.ts:750` (Hinweisleiste). Wie: `HostEntry.auth_kind` mit `key`, `agent`, `password`, serde-Default aus `key_path`, damit alte `settings.toml` lesbar bleibt. Für Passwort-Hosts zeigt die Hinweisleiste ein Passwortfeld statt des Agent-Fehlers. Grund: Heute ist ein per Passwort angelegter Host nach dem ersten App-Neustart nicht mehr verbindbar, die App fällt still auf den Agent zurück und schickt den Nutzer zu `Set-Service ssh-agent`. Tor: Passwort-Host verbindet nach Neustart aus der Seitenleiste.

**S1.10 Hook-Snippet (0,5 d).** Wo: Hostmenü oder Session-Dialog. Wie: Dialog zeigt die Zeile `tmux set -p -t "$TMUX_PANE" @agent_status waiting` für die Hook-Konfiguration von Claude Code und Codex, zum Kopieren. Der Poll liest das Feld ohnehin. Die App schreibt nichts auf die VM.

**Tor M1 (aus Spec §14 Plan 2, angepasst):** Acht Sessions über zwei Hosts. Codex zeigt alle drei Zustände richtig, unbekannte Muster zeigen unbekannt, Claude Code zeigt, was S1.1 erlaubt. Vier flutende Kacheln, der Status der übrigen Sessions aktualisiert sich binnen 4 Sekunden. Ein Abriss hinterlässt keinen Prozess auf der VM. Layoutwechsel und Maximieren sind der bewusst erlaubte Resize (Designsystem §7.1), ein Kachelwechsel ohne Größenänderung sendet kein `resize_terminal`. Passwort-Host verbindet nach Neustart. Tag `v0.2.0` als Pre-Release, nackte `.exe` an zwei bis drei Freunde.

### M2 Verlässlichkeit (10 Tage)

**S2.1 History-Restore (1,75 d).** Wo: `tmux/client.rs` (`capture_history`), `commands.rs` `open_terminal_impl` vor `open_attach`, `grid.ts` (Kachelkopf). Wie: In einem tmux-Aufruf `display-message -p -t =name '#{alternate_on}'` und `capture-pane -e -p -J -S -5000 -E -1`, erste Zeile ist der Guard, kein Poll-Zustand nötig. `\n` zu `\r\n` (V8), toter Pane ist Normalfall (V23), Deadline aus S1.3. Nach jedem tatsächlich gesendeten `resize_terminal` einmalig der Hinweis aus Spec §6.4, dass älterer Verlauf verloren sein kann. `terminal-overrides` und `scrollback: 5000` stehen schon. Tor: Nach Reattach ist der Verlauf ohne Lücke und ohne Dopplung lesbar.

**S2.2 Auto-Reconnect (4 d).** Wo: `commands.rs` (Geheimnis je Host als `Zeroizing` für die Lebensdauer der Verbindung, Auslöser aus dem Poll-Task von S1.5 oder dem Keepalive), `main.ts` (Generationenmodell existiert ab Zeile 247), `abnahme-handarbeit.md` Punkt 6. Wie: Backoff mit Jitter, global serialisiert (V25), offene Kacheln werden automatisch neu montiert, ein geänderter Host-Key bleibt modal. Vor dem ersten Codetag entscheiden, ob der Wiederaufbau ein neuer Command oder eine Umdeutung von `connect_host` ist. Tor: Ruhezustand 10 Minuten, aufwachen, ohne Klick wieder verbunden mit Verlauf. Toter Kontrollkanal endet nach 15 Sekunden in der Sperrleiste, nicht im Hänger.

**S2.3 A2 sichtbar (1,5 d).** Wo: `sidebar.ts` (Badge aus `session_attached`), `tmux/client.rs:101` (`prepare_server`), `commands.rs:1435` (`resize_terminal_impl` braucht dafür Zugriff auf die Kontrollverbindung). Wie: Badge "anderswo geöffnet", Rückfrage vor `attach -d` (Spec §6.6), `set -g window-size manual` plus `resize-window` im Resize-Pfad (V11, Befund 10). Tor: Ein zweiter Client per `tmux attach` lässt die Größe nicht mehr springen.

**S2.4 Host-Kompatibilität (2,5 d).** Wo: `preflight.rs:88`, `tmux/client.rs:37`, `russh_transport.rs:178` (tmux-Pfad), `remote/command.rs:61` und `:75` (Fernzeile), `ssh/auth.rs:360` und `:136` (Agent), `ssh/config_parser.rs:46` und `first-run.ts:263` (Vorschläge), `ssh/keys.rs:82` und `host-form.ts:371` (Schlüsseldatei). Wie: `HostEntry.tmux_path` mit Vorgabe `tmux` und Preflight-Hinweis, wenn tmux nur außerhalb des sshd-PATH liegt (Befund 12). Fernzeile als Ganzes base64-kodiert und über `sh` gestartet, damit fish und csh nicht parsen müssen (Befund 13). Beim Agenten zuerst den Schlüssel aus `IdentityFile`, nach fünf Fehlversuchen abbrechen, Meldung nennt 1Password und KeeAgent, statt zum Windows-Dienst zu schicken (Befund 14). Vorschläge aus `ssh_config` mit `ProxyJump` oder `ProxyCommand` erscheinen ausgegraut mit dem Grund, statt später mit "Host not reachable" zu scheitern. Eine `.ppk`-Datei wird an der ersten Zeile erkannt und mit dem PuTTYgen-Exportweg abgelehnt. Tor: fish-Host, Linuxbrew-tmux, 1Password-Agent mit sieben Schlüsseln, ProxyJump-Eintrag, `.ppk`-Datei. Alle fünf verbinden oder sagen vor dem Scheitern, warum nicht.

**Tor M2:** Tag `v0.3.0`. Die Beta-Nutzer aus M1 bestätigen zwei Wochen täglichen Gebrauch ohne Neustart der App.

### M3 Öffentlich (13 Tage)

**S3.1 Standard-Socket (3,5 d).** Wo: `commands.rs:2008` (der Kommentar, der die Lücke benennt), `commands.rs:302` und `:311` (`session_key` wird host, socket, session), `russh_transport.rs:176` (attach hängt `-L` an), `tmux/client.rs:36` (ein Modus ohne `-L` und ohne `prepare_server`), die drei Aufrufer von `list_sessions`, die Signatur von `setSessions`, `sessionKey` im Frontend (Socket steckt seit S1.6 im Objekt, hier nur noch im Schlüssel). Wie: Sidebar-Gruppe "vorhandene Sessions". Regel für fremde Sockets: keine Serveroption, nie `attach -d`, nie Hooks, Kill gesperrt, Tippen erlaubt. Warum hier und nicht in M2: Der Entwickler braucht es täglich nicht, ein Fremder mit handgestartetem tmux sieht ohne diesen Schritt am ersten Tag eine leere Seitenleiste. Es ist die größte verbleibende Strukturänderung und gehört vor die externe Abnahme. Tor: Eine per Hand gestartete Session erscheint mit Status, Kill ist ausgegraut.

**S3.2 Windows-Politur und Diagnose (2,5 d).** Wo: `src-tauri/src/lib.rs:46`, `tauri.conf.json:14`, `capabilities/default.json` (`windows: ["main"]` bleibt), `sidebar.ts:783`, `host-form.ts:122`. Wie: Fenster über `WebviewWindowBuilder::from_config` mit `enable_clipboard_access` (Befund 4). Kontextmenü außerhalb des Terminals unterdrücken, F5, Ctrl+R und die übrigen Browser-Tasten abfangen (Befund 8). Mindestgröße 1100x700 und Fensterzustand merken (Designsystem §5.1). Eigenes Icon per `npx tauri icon`, die 1024er-Vorlage ist Vorbedingung dieses Schritts (Befund 15). Protokolldatei unter dem App-Datenordner mit Version, Commit, OS-Build, WebView2-Version, Preflight-Ergebnis und Fehlerkette, ohne Geheimnisse, dazu ein globaler "Copy diagnostics" im Seitenleistenkopf, nicht nur je Host. `user@host` im Hostnamen-Feld wird zerlegt oder klar abgelehnt. Tor: Rechtsklick, F5, Einfügen und Links verhalten sich wie in einer Desktop-App. Jeder Stolperer der Abnahme lässt sich aus der Protokolldatei rekonstruieren.

**S3.3 Abhängigkeits-Hygiene (1,25 d).** Wo: neue `deny.toml`, `about.toml`, `.github/dependabot.yml`, `tauri.conf.json` (`bundle.licenseFile`). Wie: `cargo deny` mit Lizenz-Allowlist und begründeter Ausnahme für RUSTSEC-2023-0071. `cargo about` erzeugt die Drittlizenzdatei für rund 590 Crates, dazu die npm-Lizenzen, als CI-Artefakt und im Installer mitgeliefert. Ein handgeschriebener Hinweis mit drei Einträgen wäre kein Lizenzhinweis. Dependabot für cargo, npm und Actions. Tor: CI meldet die nächste Advisory von selbst, der Installer trägt die Lizenzdatei.

**S3.4 Release-Job (1 d).** Wo: `.github/workflows/release.yml`, `tauri.conf.json` (`bundle`). Wie: Auf Tag `v*` baut `windows-latest` mit `tauri build` NSIS und MSI (`targets: all` steht schon, `--no-bundle` fällt weg), NSIS per-user ohne Adminrechte als empfohlener Weg, `webviewInstallMode` als Bootstrapper für Rechner ohne WebView2, `SHA256SUMS`, `attest-build-provenance`, Release-Entwurf aus dem CHANGELOG mit dem SmartScreen- und Smart-App-Control-Text aus S3.5. Jede CI-Runde mit `tauri build` dauert 15 bis 20 Minuten, Iterationen einplanen. Tor: Ein Tag erzeugt ohne Handarbeit einen Release mit Installer, Prüfsummen und Attestation.

**S3.5 Dokumentation und Projektdateien (1,5 d).** Wo: `README.md` (Englisch), neue Dateien im Wurzelverzeichnis und unter `.github/`, `.gitignore`. Wie: README in dieser Reihenfolge: Screenshot. "Before you download": Smart App Control prüfen, bei "Ein" startet diese unsignierte Version nicht, SmartScreen-Klickfolge, winget und Scoop umgehen SmartScreen und Mark-of-the-Web, nicht Smart App Control. Voraussetzungen auf der VM (Linux, OpenSSH, tmux ab 3.0, base64, POSIX-Shell). Installation. "Supported agents and detected states" mit der Profiltabelle aus S1.1 und dem Snippet aus S1.10. Speicherort der Einstellungen und was die Deinstallation zurücklässt (`known_hosts`-Einträge bleiben, weil mit OpenSSH geteilt). Updates: kein Auto-Update, `winget upgrade` oder Releases beobachten. Passwörter und Passphrasen werden nie gespeichert. Die App selbst sendet nichts außer SSH. Grenzen: kein 2FA, kein ProxyJump, kein `.ppk`. Support über Issues und Discussions. Dazu `CONTRIBUTING.md` (Bauen, Tests, eine Review-Runde, Sprachregel: Dokumente und Kommentare deutsch, Oberfläche und README englisch), `SECURITY.md` mit privatem Meldeweg und dem Repo-Schalter dafür, `CHANGELOG.md`, Issue-Vorlagen mit Pfad der Protokolldatei, die beiden internen Dateien `.superpowers/sdd/progress.md` und `.vscode/extensions.json` aus dem Index. Tor: Ein Leser findet ohne den Entwickler heraus, ob die App für ihn taugt und was sie nicht kann.

**S3.6 Externe Abnahme (1 d).** Wo: ein frischer Windows-11-Rechner, nicht der des Entwicklers. Wie: Eine fremde Person installiert nur mit dem README. Protokoll mit Pflichtfeld Smart-App-Control-Zustand, ein Fehlschlag durch Smart App Control ist kein Codebefund. Vier Auth-Wege: `id_rsa`, ed25519, Agent, Passwort. Eine per Hand gestartete tmux-Session mit Status. Deinstallation, danach `%APPDATA%` und `%LOCALAPPDATA%` prüfen. Die Testperson erklärt ohne Rückfrage, warum ein Punkt "?" zeigt.

**S3.7 Fixdurchgang und zweiter Anlauf (1,5 d).** Wie: Jeder Stolperer aus S3.6 wird aus der Protokolldatei rekonstruiert und behoben, dann ein zweiter Durchlauf. Tor M3: zweiter Durchlauf ohne Stolperer, Tag `v0.4.0`, öffentlicher Release.

**S3.8 winget und Scoop (0,5 d, nach dem Release).** Wo: `microsoft/winget-pkgs`, eigenes Scoop-Bucket. Wie: Manifest mit Download-URL und Hash aus S3.4. Der Review von winget-pkgs dauert Kalendertage.

---

## 4. Kalender

Netto-Tage sind Arbeitstage am Code mit einer Review-Runde je Schritt. Die Historie zeigt, dass Netto-Zahlen halten: Spec bis laufendes Terminal an einem Tag, die gesamte Seitenleiste in drei. Das Risiko ist der Prozess, nicht das Programmieren. Der Puffer von 15 % ist eingerechnet.

| Szenario | M0 | M1 | M2 | M3 | Öffentlicher Release |
|---|---|---|---|---|---|
| Vollzeit, 5 Tage/Woche | Woche 1 bis 2 | Woche 2 bis 5 | Woche 5 bis 7 | Woche 7 bis 10 | Ende Woche 10 |
| Nebenbei, 2 Tage/Woche | Woche 1 bis 4 | Woche 4 bis 11 | Woche 11 bis 16 | Woche 16 bis 24 | Ende Woche 24 |

Gegenüber dem ersten Entwurf sind das rund zehn Netto-Tage mehr. Die Kritikrunde hat sie gefunden: russh-Sprung und CI-sshd vor der ersten Weitergabe, Auth-Absicht für Passwort-Hosts, PTY-Signale, Epochenregel, Lizenzinventar, Protokolldatei, zwei Fixdurchgänge nach den Abnahmen. Nichts davon ist Politur.

SignPath hat Wochen Vorlauf und wird deshalb direkt nach der Umbenennung beantragt. Der erste öffentliche Release ist unsigniert mit Prüfsummen und Attestation, so wie Spec §11.2 es für diese Phase vorsieht.

---

## 5. Bewusst nicht vor M3

Die Spec verspricht in §14 mehr, als dieser Plan liefert. Das ist Absicht, nicht Vergessen.

| Aus der Spec | Warum später |
|---|---|
| A5 git worktree beim Anlegen | Kein Glied der Position, Orca und Conductor haben es. Nach M3 |
| Semaphore, FIFO und LRU (§4.2) | Vier Kacheln plus ein Poll bleiben unter zehn Kanälen. Die 15-Sekunden-Deadline aus §4.2 wird gebaut (S1.3), die Warteschlange nicht |
| Kanonische Größe für alle Kanäle (§6.4) | Mit dem 1/2/4-Raster aufgegeben (Designsystem §7.1). Preis ist V12, dafür der einmalige Hinweis in S2.1 |
| `SessionStore`, `session.json`, Metadaten (§5.2) | Der Poll liefert `pane_current_path` passiv, die Epochenregel (§9.3) deckt "beendet (Server)". Der Rest des Cache nach M3 |
| Klick auf beendete Session mit "Neu starten" (§7.2) | In M1 nur "Entfernen". Neu starten braucht die Metadaten von oben |
| `AgentProfiles` als Datei (§12.2) | In M1 eine feste Tabelle im Code, editierbar nach M3 |
| Frei konfigurierbare Tastenbelegung (§7.4, §12.1) | `[keymap]` in `settings.toml` wird weiterhin nicht gelesen. Nach M3 |
| DPAPI-Secrets (§8.5) | Passphrase wird pro Aufruf gereicht und für Reconnect im Speicher gehalten. Speichern auf Platte nach M3 |
| Diagnostics-Bundle | S3.2 liefert Protokolldatei und globalen Diagnosetext, kein Bundle |
| Updater-Plugin | Braucht signiertes Manifest. Nach SignPath |
| Windows ARM64 | x64-Emulation reicht. Nach M3 |
| Windows-Kontrastmodus (`forced-colors`) | `prefers-reduced-motion` ist umgesetzt, Kontrastmodus nach M3 |
| Hooks schreiben, OS-Toast, Diff-Ansicht | Entscheidungen in Abschnitt 2 |
| `keyboard-interactive`, ProxyJump | Nicht-Ziele der Spec. S2.4 sagt es dem Nutzer vor dem Scheitern, das README danach |

---

## 6. Prozessregeln für diesen Plan

1. **Eine Review-Runde je Schritt.** Ein Plan, der eine vierte Fassung braucht, ist zu groß und wird geteilt.
2. **Der Detailplan eines Schritts entsteht, wenn der Schritt beginnt**, höchstens eine Seite je Netto-Tag.
3. **Jeder Schritt endet am laufenden Fenster.** Die jsdom-Tests sehen kein CSS, und 82 Diff-Reviews haben den Startfehler vom 29.07. nicht gesehen.
4. **Fortschrittsprotokoll nur am Meilenstein-Ende.** Die Commit-Nachricht trägt den Inhalt.
5. **Dieses Dokument wird nicht neu gefasst.** Änderungen kommen als datierter Nachtrag ans Ende. Die Ausführung beginnt mit S0.1.

---

## Anhang A: Befunde der Bewertung vom 2026-09-04

Alle mit Gegenprobe bestätigt, Stellen am Code vom 2026-09-04. Referenziert als "Befund n" in Abschnitt 3.

| # | Befund | Stelle | Schritt |
|---|---|---|---|
| 1 | Sperrleiste und Chip immer sichtbar, `display: flex` ohne `:not([hidden])` | `src/styles.css:1329`, `:1238` | S0.1 |
| 2 | Ausgabe-Ereignis ohne Host-ID, gleichnamige Sessions mischen Ströme | `commands.rs:454`, `terminal.ts:433` | S0.2 |
| 3 | RSA nur ssh-rsa/SHA-1, OpenSSH ab 8.8 lehnt ab | `ssh/auth.rs:410`, `:368` | S0.3 |
| 4 | Ctrl+Shift+V löst WebView2-Berechtigungsabfrage aus | `terminal.ts:319`, `lib.rs:46` | S3.2 |
| 5 | Eine SSH-Verbindung je Host, Statuskanal würde mit PTY-Kanälen blockieren | `commands.rs:100` | S1.2 |
| 6 | russh seit 28.07. auf 0.62.4, zwei client-relevante Advisories in 0.63.1 behoben | `Cargo.lock:3629` | S0.3 |
| 7 | Ctrl+Shift+Ziffern feuern nie, Akkord wird geschluckt | `keymap.ts:221` | S1.8 |
| 8 | WebView2-Vorgaben: Browsermenü, F5 lädt neu, `window.open` tot | `lib.rs:46`, `terminal.ts:205` | S0.6, S3.2 |
| 9 | Rotes Banner bei jedem Kanalende | `terminal.ts:450`, `commands.rs:1462` | S0.5 |
| 10 | `window-size manual` fehlt, Größe springt mit zweitem Client | `tmux/client.rs:107` | S2.3 |
| 11 | Seitenleiste baut DOM komplett neu, Passphrase-Eingabe geht verloren | `sidebar.ts:1487` | S1.6 |
| 12 | tmux muss im sshd-PATH liegen | `preflight.rs:88` | S2.4 |
| 13 | Fernzeilen setzen POSIX-Shell voraus, fish scheitert | `remote/command.rs:61` | S2.4 |
| 14 | Agent mit sieben Schlüsseln läuft in MaxAuthTries | `ssh/auth.rs:360` | S2.4 |
| 15 | Tauri-Vorlagen-Icon | `tauri.conf.json:28` | S3.2 |
| 16 | Opener-Plugin registriert, aber tot | `Cargo.toml:23` | S0.6 |

Aus der Kritikrunde dazugekommen, ohne eigene Nummer: Passwort-Host nach Neustart nicht verbindbar (`main.ts:569`, S1.9), `Transport::exec` ohne Deadline (`russh_transport.rs:248`, S1.3), TOFU-Dialog nicht modal für Tastatur (`main.ts:1559`, S0.4), H6 und H9 aus dem Stand (`remote/command.rs:26`, S0.4), ProxyJump-Vorschläge unmarkiert (`config_parser.rs:46`, S2.4), `.ppk`-Dateien falsch gemeldet (`keys.rs:82`, S2.4), keine Protokolldatei (`main.rs:2`, S3.2), Lizenzinventar für 590 Crates (S3.3).

Checklistenpunkte ohne eigenen Befund, in S0.9, S3.2 und S3.5 enthalten: Mindestgröße und Fensterzustand, Versionsanzeige, README-Nutzerteil.

---

## Nachtrag 2026-09-05: Zuschnitt nach dem Gespräch mit dem Auftraggeber

Die Punkte wurden einzeln durchgesprochen. Verbindlich ist ab jetzt die Spec `specs/2026-09-05-mvp-und-statuspunkt-design.md`, Abschnitt 3. Gegenüber diesem Plan geändert:

- Gestrichen: S0.6 (Links öffnen), S0.7 (CI-Tor), S2.3 (A2 sichtbar), S2.4 (Host-Kompatibilität), aus S3.3 `deny.toml`, aus S3.5 `CONTRIBUTING.md`, Scoop, `user@host`-Zerlegung. Die Diff-Konzession (Badge) entfällt ganz.
- Vorgezogen: die Messung (S1.1) als Schritt 0 vor M0, in Kurzform von einer halben Stunde je Agent; S1.9 (Anmeldeart speichern) nach M0, weil der Auftraggeber Passwort-Anmeldung nutzt.
- Ersatz für das CI-Tor: Vor jedem Commit laufen die Integrationstests lokal gegen 192.0.2.20.
- M1 wird als Durchstich gebaut (zwei Felder bis zur Seitenleiste), dann verbreitert.
- Gutachten nur noch für drei Strukturschritte, sonst Tests und Lauf am Fenster.
- Externe Abnahme auf dem Zweitrechner des Auftraggebers.
- Neue Summe rund 34 Netto-Tage, mit Puffer 39 (nach der Kritikrunde zur Spec).

## Nachtrag 2026-09-14: Stand und Abweichungen

- M0 (Tag `v0.1.1`) und UI v2 (Tag `v0.1.2`) sind abgeschlossen. M1 ist bis auf das Tor gebaut. Den aktuellen Stand und die Reihenfolge der offenen Punkte führt [`docs/stand.md`](../stand.md).
- Die Statusquelle weicht von S1.3, S1.4 und S1.10 ab: kein `@agent_status`, kein Hook-Snippet, keine Glocke als Status. Claude Code läuft über `claude agents --json`, Codex und Grok über den Panetitel (MVP-Spec, Nachträge vom 13.09. und 14.09.). S1.10 entfällt.
- Der Poll läuft als Overlay im Frontend über `poll_status`, nicht als Backend-Task mit `status://update` (S1.5).
- S3.3 und S3.4: Lizenzinventar und Windows-Pakete entstehen über eigene Skripte (`scripts/release-*.mjs`) und den lokalen Lieferlauf `npm run build:windows`. Einen Release-Job gibt es nicht; GitHub Actions ist im Repository abgeschaltet.
- S3.5: `.superpowers/sdd/progress.md` ist aus dem Index genommen. Die unter „Bezug“ genannten Dokumente `stand-2026-08-09.md` und `analyse-2026-08-03-verbesserungen.md` liegen wie die übrigen abgeschlossenen Pläne und Analysen nicht im öffentlichen Repository.
