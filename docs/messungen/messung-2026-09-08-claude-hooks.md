# M1.0: echte Claude-Hooks, 2026-09-08

**Ergebnis: belastbarer Teilnachweis, kein freigegebener Statusadapter.** Claude
liefert echte Start-, Prompt-, Freigabe-, Tool-, Stop-, Fehler- und Ende-Ereignisse.
Die gemessenen Hooks lassen aber entscheidende Übergänge offen: nach Ablehnung und
nach Esc konnte die Oberfläche wieder Eingaben annehmen, ohne dass ein abschließender
Hook den vorherigen Wartewert aufgehoben hätte. Auch die Genehmigung selbst erzeugte
in diesem Recorder kein eigenes Ereignis vor dem Ende des Tools.

Damit ist das [M1.0-Tor der Spec](../specs/2026-09-05-mvp-und-statuspunkt-design.md#5-messung-und-m10-tor)
noch nicht bestanden. Keine Freigabe eines installierbaren Produktionssnippets und
keine Ableitung neuer Titelprofile aus diesem Lauf.

## Aufbau und Grenzen des Nachweises

| Merkmal | Tatsächlich geprüft |
|---|---|
| Host | `u@192.0.2.20`, SSH mit `StrictHostKeyChecking=yes`, `BatchMode=yes` |
| Claude | Native Installation **2.1.263**, nicht die am 2026-09-05 gemessene 2.1.261 |
| Binary | `~/.local/bin/claude` zeigte auf `~/.local/share/claude/versions/2.1.263`; Eigenangabe `2.1.263 (Claude Code)` |
| SHA-256 | `26d020351e8112f4006790f3cfce43b4c9df0c1bb1d0e542364d64151b81d5ba` |
| Modellanzeige | Opus 5, 1M context, low effort; aus der künstlichen Testoberfläche, keine Modellportabilitätszusage |
| Umgebung | tmux **3.4**, Python **3.12.3**, kein angehängter tmux-Client in allen gespeicherten Beobachtungen |
| Isolation | `/tmp/ab-m1-hooks-20260908-NxsQ0Xbx`, eigener Socket darin, tmux-Start mit `-f /dev/null` |
| Zeitraum | Fixture: 2026-09-08 13:39:45–14:32:25 UTC; darin Bedien-/Freigabepausen, kein durchgängiger Lasttest |

Der [Mess-Harness](../../scripts/m1-claude-hooks.py) startete drei neue Sessions
`case-a`, `case-b`, `case-c`. Jede erhielt eine neue UUID; die Fixture speichert nur
deren Hash. Die tmux-Objekte waren `$0/@0/%0`, `$1/@1/%1`, `$2/@2/%2` auf demselben
Testserver. Dies prüft neue Instanzen, keinen Serverneustart oder gleichnamigen Ersatz.

Prozessoptionen: `--restricted --tools Bash --permission-mode manual`, leere
`--setting-sources`, temporäre `--settings`, `--strict-mcp-config` mit leerer
MCP-Datei, `--disable-slash-commands --no-chrome --effort low`, festes `--session-id`
und künstlicher Systemprompt. Die Oberfläche zeigte manual mode; die Hook-Payloads
nannten dafür `permission_mode=default`. Keine Konto-/Schutzregeln wurden geändert,
keine Upgrades oder zusätzlichen Dienste installiert. `DISABLE_AUTOUPDATER=1` war
nur für den Testprozess gesetzt. Die Aufrufe verwendeten die vorhandene Anmeldung;
Credentials wurden nicht gelesen, kopiert oder exportiert.

Der Harness schreibt keine bestehenden User-/Projekt-Einstellungen oder Hooks.
Claude kann durch normale Sitzungsnutzung eigene Laufzeit-/Sitzungsmetadaten erzeugen;
diese wurden nicht aus fremden Sessions gelesen und nicht bereinigt. `--restricted`
und `--setting-sources` begrenzen die Quellen dieses Laufs; das ist kein Beweis über
alle möglichen organisationsverwalteten Einstellungen auf anderen Hosts.

**Python und `pgrep` sind Messwerkzeuge.** Sie werden nicht als neue Voraussetzung
des Produkts oder als fertiger tmux-only-Hook-Vertrag eingeführt. Der Recorder liest
Hook-JSON, behält nur erlaubte Ereignisnamen, Typen, boolesche Werte, Zähler,
Identitätshashes und Zeit-/Prozessmetadaten. Kein Prompt, Toolinput/-output,
Nachrichtentext, Transcriptpfad oder Credential steht in der
[Fixture mit 61 Datensätzen](fixtures/m1-claude-hooks/2026-09-08-claude-2.1.263.json).
`screen` ist ein separater Diagnosebefehl ausschließlich für die künstliche Testsession;
sein Terminaltext wird nicht in die Fixture geschrieben.

## Beobachtungen

`seq` bezeichnet die Schreibreihenfolge des Recorders, keine bewiesene kausale
Reihenfolge paralleler Claude-Callbacks. Zeitpunkte messen Recorderstart/-schreiben
auf der VM; sie sind weder die interne Erzeugungszeit noch die UI-Latenz in AgentBridge.

| Fall | Evidenz in der Fixture | Ergebnis |
|---|---|---|
| Start | `SessionStart(startup)` 3, 27, 49 | Drei Starts mit passenden unterschiedlichen Sessionhashes und Panes |
| Eingabe/Tool/Freigabe | A: 6/7/8; B: 29/30/31; C: 51/52/53 | `UserPromptSubmit`, `PreToolUse(Bash)`, `PermissionRequest(Bash)` tatsächlich empfangen |
| Benachrichtigung | 8→9: **6039 ms**; 31→33: **5997 ms**; 53→55: **5995 ms** | `Notification(permission_prompt)` ungefähr sechs Sekunden später, je erste Freigabe einer neuen Instanz |
| Genehmigung/Fertigstellung A | Enter 11 → `PostToolUse` 12 → `Stop` 13 | Harmloser Drei-Sekunden-Befehl lief; sichtbares DONE; Stop enthielt leere Hintergrund-/Cron-Listen |
| Bell nach Ende A | Beobachtungen 10 und 14 | `bell=1` beim Warten und weiterhin nach DONE; kein Zustandsbeweis |
| Späte Child-Meldung | `SubagentStop` 15 nach Stop 13; erneut 41 nach Stop 40 | Eigene `agent_id` vorhanden; kein `SubagentStart` in diesem Mitschnitt. Ursache nicht geklärt, kein Hauptagent-Ende daraus ableiten |
| Folgeaufgabe/Fehler A | 17→18, 22→23 | `UserPromptSubmit` gefolgt von `StopFailure(error=invalid_request)`; Oberfläche zeigte API-Schutzfehler. Kein normaler Stop in diesen Fehlerübergängen |
| Idle nach Fehler | 18→20: 60001 ms | `Notification(idle_prompt)` trat auch nach Fehler auf; kein Nachweis erfolgreicher Fertigstellung |
| Ablehnung B | Down/Down/Down/Enter 35 wählte sichtbares `4. No`; Beobachtung 36 | Dialog geschlossen, Oberfläche `Interrupted`; kein anschließender Hook bis zur nächsten Eingabe nach rund 85 Sekunden |
| Folgeaufgabe B | 38→39→40 | Neuer Prompt kam an; Claude antwortete DENIED ohne erneuten Toolaufruf. Das belegt keine zweite Freigabe |
| Normaler Ausgang A/B | zweimal Ctrl+C 44/45 → `SessionEnd(prompt_input_exit)` 46/47 | Reguläre Ende-Hooks tatsächlich empfangen |
| Längerer Toolaufruf C | Enter 56, Beobachtung 57 rund drei Sekunden später | Freigabedialog geschlossen; vor Esc kein zusätzlicher Hook. Ein unmittelbarer Approval→Working-Hook ist damit nicht belegt |
| Esc während C | Esc 58 → Beobachtung 59, acht Sekunden Beobachtungsfenster | Oberfläche `Interrupted`; weder Stop noch PostToolUseFailure oder anderer Folge-Hook im Mitschnitt |
| Harter Prozessabbruch C | SIGKILL 60 nur an zuvor validierte Test-PID; Beobachtung 61 | `pane_dead=1`, Prozess nicht mehr vorhanden; kein SessionEnd |

Die drei künstlichen Prozesse waren nie über einen tmux-Client angehängt. Der
Recorder reagierte trotzdem. Die drei Freigaben liegen **in verschiedenen Instanzen**:
wiederholte Freigaben derselben geschlossenen Session sind weiterhin offen. Die
Fehler in A wurden als Grenze dokumentiert; es gab keine Änderung von Schutzregeln,
keinen Modellwechsel und keine Versuche, den API-Schutz zu umgehen.

Die Beobachtungsfelder `done_text`/`denied_text` sind Diagnostik, kein Statusdetektor:
insbesondere Datensatz 10 entstand noch mit einem zu breiten Texttest, der Wörter
aus dem künstlichen Prompt traf. Der Harness wurde danach auf ganze Antwortzeilen
korrigiert. Auch eine korrekte ganze Zeile kann als Verlauf sichtbar bleiben. Die
Bewertung oben nutzt Ereignisfolgen und die tatsächlich geprüften Dialoge, nicht
dieses Feld als aktuellen semantischen Zustand. Die ursprünglichen Ereignisse sind
unverändert erhalten. Der zunächst globale Event-Waiter wurde auf die Session-ID
begrenzt; deswegen wurden Paare für die Auswertung ausdrücklich nach Sessionhash
gebildet, nicht nach dem Rückgabewert eines frühen Wait-Aufrufs.

## Folgerung für den Signalvertrag

1. `PermissionRequest` ist ein früher Hinweis; `permission_prompt` ein verzögerter
   Hinweis. Die vier Sekunden der Spec können sich nur auf ein bereits verfügbares
   Signal beziehen. End-to-End-Latenz ab sichtbarem Dialog ist gesondert zu nennen.
2. Ein naiver gespeicherter Wert `waiting` bliebe nach `No` oder Esc falsch stehen.
   Auch zwischen Genehmigung und Toolende fehlt in diesem Setup ein beobachteter
   Hook für den Übergang zu arbeitet. Ablauf einer festen TTL beweist keine Antwort,
   kein Ende und kein Hängen; ein lebender `pane_pid` schließt diese Lücke nicht.
3. `StopFailure` muss getrennt behandelt werden. `idle_prompt` bedeutet nicht Erfolg.
   Ein `SubagentStop` darf den Besitzer der Hauptinstanz nicht löschen.
4. Der Harness startet Claude per `exec` direkt als Pane-Prozess. In handgestarteten
   Produktsessions kann `pane_pid` eine langlebige Shell sein. Die gemessene Bindung
   ist deshalb kein allgemeiner Ownership-Nachweis für Start/Crash/Restart eines Agents.
5. Erst Ereignisquellen für diese Lücken und ihre Instanzbindung klären; danach einen
   kleinen Adapter erneut messen. Bis dahin unbekannt mit Quelle/Grund bzw. getrennte
   Aufmerksamkeit, keine Vollständigkeitszusage und kein veröffentlichtes Hook-Snippet.

Die am 2026-09-08 geprüfte [offizielle Hook-Referenz](https://code.claude.com/docs/en/hooks)
beschreibt den verzögerten Notification-Typ, Stop ohne Nutzerinterrupt, eigene
Fehler- und Session-End-Ereignisse. Die [CLI-Referenz](https://code.claude.com/docs/en/cli-reference)
beschreibt die verwendeten Einstellungsquellen. Ausschlaggebend für obige Aussagen
sind die tatsächlich ausgelösten Hooks in **2.1.263**, keine rückwirkende Behauptung
über 2.1.261, Codex oder Grok.

Offen bleiben: wiederholte Freigaben derselben Instanz, vollständige lange Aufgabe,
angehängter/fokussierter/anderer Client, `/clear`/Resume, absichtlich verzögerte oder
fehlende konkurrierende Hooks, kontrollierte Subagent-/Hintergrundarbeit, generische
Shell-Ownership, gleicher Name/neue ID, Serverneustart, tmux 3.0, Poll-Framing und
AgentBridge-End-to-End-Latenz unter Last. Diese Punkte sind nicht durch das Zählen
dreier unabhängiger Starts bestanden.

## Reproduktion und Bereinigung

Der Harness hat keine autonome Freigabeschleife. Vor jedem Enter muss der Bediener
den künstlichen Befehl im eigenen Pane prüfen. Die eingebauten Fälle `short`, `long`
und `reply` verwenden nur kurze Textantworten oder Python-Sleep/Print. `long` wurde
hier bewusst abgebrochen. Die erlaubten Tasteneingaben genehmigen keine fremde Session.

Vorgehen auf einer bereits autorisierten Test-VM mit vorhandenem Claude, tmux,
Python3 und `pgrep`:

```sh
# Zuerst neues Verzeichnis anlegen und m1-claude-hooks.py dorthin kopieren.
test_dir=$(mktemp -d /tmp/ab-m1-hooks-YYYYMMDD-XXXXXXXX)
# Danach, mit dem kopierten Harness:
python3 "$test_dir/m1-claude-hooks.py" selftest
python3 "$test_dir/m1-claude-hooks.py" init
python3 "$test_dir/m1-claude-hooks.py" start --label case-a
python3 "$test_dir/m1-claude-hooks.py" observe --label case-a
python3 "$test_dir/m1-claude-hooks.py" send --label case-a --case short
python3 "$test_dir/m1-claude-hooks.py" screen --label case-a
# Nur nach sichtbarer Prüfung der Testfreigabe:
python3 "$test_dir/m1-claude-hooks.py" keys --label case-a --keys Enter
python3 "$test_dir/m1-claude-hooks.py" observe --label case-a
python3 "$test_dir/m1-claude-hooks.py" keys --label case-a --keys C-c C-c
python3 "$test_dir/m1-claude-hooks.py" export
# Export außerhalb des Testverzeichnisses sichern, dann:
python3 "$test_dir/m1-claude-hooks.py" cleanup
```

`/exit` war mit den gewählten deaktivierten Slash-Commands ein unbekannter Befehl;
einmal Ctrl+D beendete A ebenfalls nicht. Der geprüfte normale Ausgang ist zweimal
Ctrl+C aus der Eingabezeile. `wait` ist auf höchstens 45 Sekunden und den aktuellen
Sessionhash des Labels begrenzt; ein Timeout wird nicht als bestanden ausgegeben.

Abschließend real ausgeführt: Whitelist-Selbsttest und `python3 -m py_compile`
bestanden; Export enthielt 61 parsebare Datensätze. `cleanup` beendete ausschließlich
den eigenen Testserver mit Exit 0, prüfte verbleibende markierte Testprozesse und
entfernte nur das durch Ownership-Marker und absoluten Pfad geprüfte Verzeichnis.
Rückgabe: `synthetic_children_remaining=0`, `directory_exists=false`,
`socket_exists=false`. Produkt-/Standard-Sockets wurden nicht angesprochen.
