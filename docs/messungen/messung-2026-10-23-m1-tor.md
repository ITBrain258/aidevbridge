# M1-Tor am 23.10.2026: automatisierter Lauf

Das M1-Tor nach [Handabnahme §9](../abnahme-handarbeit.md#9-m1-tor), Schritte 1
bis 11. Schritt 12 ist das M2-Aufwachen; es braucht echten Standby und bleibt
beim Maintainer. Die Rolle am Fenster übernahm ein Treiber über CDP mit echten
Maus- und Tastaturereignissen, die Rolle per SSH Hilfsskripte auf den VMs.
Beides lief durch Claude; eine Person saß nicht vor dem Fenster. Was nur ein
Mensch am Fenster sehen kann, steht unter „Offen am Fenster“.

## Aufbau

- **Bau:** Debug-Bau mit `opt-level 3` und `tauri/custom-protocol` vom Branch
  `prep/m1-gate`. Die Schritte 1 bis 11 liefen auf Commit 43e41d5;
  Schritt 7 lief noch einmal mit den Korrekturen aus 861e434 und 703edf3.
- **Testinstanz:** eigene `settings.toml` (`AIDEVBRIDGE_SETTINGS_DIR`), eigener
  tmux-Socket `abtest_20261023_m1` (`AIDEVBRIDGE_TMUX_SOCKET`), eigener
  WebView2-Ordner, Fenster maximiert. Die Fensterlage der installierten App
  ist vorher gesichert und danach zurückgespielt.
- **Hosts:**
  - vm10 = 192.0.2.10 (Debian 12, tmux 3.3a);
  - vm20 = 192.0.2.20 (Ubuntu 26.04.1, tmux 3.6);
  - `m1-drei` = zweiter Eintrag für 192.0.2.20.

  Alle mit Schlüssel. Die Hostschlüssel standen vorher in `known_hosts`, es
  gab also keine TOFU-Rückfrage. Platzhalter nach RFC 5737.
- **Agents:**
  - Claude Code 2.1.309 mit `--model haiku --permission-mode default`; die
    VMs stehen sonst im Auto-Modus.
  - Codex 0.164.0 auf beiden VMs mit `-m gpt-6-luna -a on-request`. Codex
    auf vm20 aktualisierte sich beim Start von 0.163.0.
  - agy 1.4.6, ebenfalls beim Start selbst aktualisiert.
- **Uhren:** Beide VMs gingen 960 bzw. 956 ms vor (±3 ms, gemessen über eine
  stehende SSH-Verbindung). Die Latenzen unten sind darum bereinigt.
- **Abweichungen vom Ablauf:**
  - Je Host ist die erste Session über „New session“ angelegt, damit die App
    ihren Server einrichtet (`history-limit`, `remain-on-exit`,
    `status off`); die übrigen per SSH auf demselben Socket und dann
    „Reload sessions“.
  - Agents wurden per `tmux send-keys` gestartet, wie von Hand in der Pane.
  - Die Aufträge in Schritt 1 und 2 kamen über die Kachel, in Schritt 4
    und 5 per `send-keys`.
  - „Fenster in den Hintergrund“ heißt hier minimiert.

Rohdaten unter [`fixtures/m1-tor-2026-10-23/`](fixtures/m1-tor-2026-10-23/):
`page-*.jsonl` (Seitenzustand alle 100 ms bei Änderung, lokale Uhr),
`vmgate-*.txt` (Claude-Zeilen mit PPid und Panes des App-Sockets alle
rund 0,3 s, VM-Uhr, Hostnamen als `<host>`), die Werkzeuge in `werkzeuge/`.

## Ergebnis

| Schritt | Ergebnis | Notiz |
|---|---|---|
| Versionen | – | Claude Code 2.1.309, Codex 0.164.0, agy 1.4.6, tmux 3.3a und 3.6 |
| 1 Claude-Zustände | bestanden | Waiting („permission prompt“) bei jeder Freigabe, Busy während `sleep`, Idle nach Ende, nach „No“ und nach Esc; Sessionzeile und Kachelkopf gleich. Latenz JSON → Zeile 0,2 bis 2,8 s. Eine Busy-Phase unter 2 s fiel zwischen zwei Polls und erschien nicht. |
| 2 Geschlossene Kachel | bestanden, bis auf das Blinken | Bei Freigabe 2 und 3 mit geschlossener Kachel und minimiertem Fenster: Zeile Waiting, Fenstertitel „(1) aidevbridge“, Wartet-Spur mit `m1-claude1`, Ctrl+Shift+A öffnet und fokussiert die Kachel. Das Blinken der Taskleiste ist über CDP nicht sichtbar. |
| 3 BEL und Resize | bestanden mit korrigierter Schleife | BEL ändert keinen Status. Wechsel per Ctrl+Shift+1/2, Kopf- und Terminalklick: kein WINCH. Maximieren, Zurückholen, Öffnen und Schließen von `m1-f3`: je eines (1, 2, 3, 4). Die Schleife der Anleitung meldet nie WINCH (Befund 2). |
| 4 Vier flutende Kacheln | bestanden | `yes` in `m1-f1` bis `m1-f4`; Claude in `m1-claude2` fragt um Freigabe zum Schreiben. Zeile Waiting 1,07 s nach `claude agents --json` (Ziel 4 s); im ersten Anlauf mit drei Fluten 3,85 s. Wartet-Spur zeigt die Session. Fenster bedienbar: eine Auswertung der Seite 160 ms statt 5 bis 57 ms in Ruhe, Klicks und Tasten kamen an. |
| 5 Codex | bestanden | Vor dem ersten Auftrag Unknown („the Codex title shows no known status“), Busy, Waiting bei der Freigabe („action required (Codex title)“, auch in der Wartet-Spur), danach Idle. agy: Unknown, aber mit dem allgemeinen Grund (Befund 3). |
| 6 Kontrollausfall | bestanden | Gezielt die `sshd-session` der Kontrollverbindung auf 192.0.2.20 beendet, erkannt an ihren Kindern auf dem App-Socket; zweimal. Agentpillen „As of hh:mm“, nach 5,1 bzw. 5,0 s ohne Klick wieder richtig. Unter der Hostzeile „Reconnecting live updates…“, kurz danach „Showing the last session list. It has not been refreshed for this connection.“; kein Kasten, beides verschwand von selbst. Liste und Kacheln blieben, Tippen in `m1-f3` wirkte während des Ausfalls. Nicht geprüft: Kasten nach fünf gescheiterten Versuchen (braucht eine Sperre auf der VM). |
| 7 Neuanlage gleichen Namens | abweichend, behoben | Auf 43e41d5 hing sich die Kachel von `m1-f4` nach 3 s an die neue Session; die alte Zeile zeigte nie Ended (Befund 1). Mit 861e434: Kachel gesperrt mit „This session has ended on the host. Close the terminal.“, ohne Reconnect, kein Client an der neuen Session. Unter `m1-drei` zeigt die alte Zeile Ended („bound session is absent from a complete inventory“), nach „Reload sessions“ die neue Session ohne alten Status. Unter vm20 zeigt die Zeile gleich die neue Session, weil die Probe nach dem Kanalverlust die Liste dort schon neu geladen hat. |
| 8 Neustart | bestanden | Unknown nach `/exit`, Idle nach neuem `claude`, Ended für `m1-f1`. Nach Schließen (WM_CLOSE) und Neustart verbanden sich beide Hosts selbst, Kacheln am Platz, Status wieder da. Dazu ein Banner „Couldn't open 'm1-f1'. It may have ended on the host“ für die wiederhergestellte Kachel der beendeten Session (Beobachtung). |
| 9 Kein Überwachungsprozess | bestanden | Im Betrieb nur die Kontrollverbindung, deren Kinder je Poll kurz laufen und zwischen den Polls fehlen, und die Terminalverbindung mit den tmux-Clients der offenen Kacheln. Nach „Disconnect“ auf beiden Hosts kein Prozess der App mehr, kein tmux-Client, nur der tmux-Server mit den Sessions. |
| 10 Neun Kacheln | bestanden | Acht Kacheln auf vm20 und `m1-f5` über `m1-drei`; nach dem Neustart alle neun in ihrer Reihenfolge, ohne Abweisung, Capacity oder Sperre; auf vm20 zeigten Kachel 5 bis 8 kurz „Opening…“, höchstens vier öffneten zugleich, nach rund 2 s war alles offen. Neunte Wahl auf vm20: „vm20 already shows 8 terminals, the limit per host.“; zehnte über `m1-drei`: „9 terminals are open, the limit.“; beide neutral, nichts schloss. |
| 11 Tausch und Maximieren | bestanden | Zug am Kopf tauschte `m1-f3` und `m1-f4`; `list-clients` vorher und nachher gleich (tty und Startzeit), kein WINCH. Maximieren und Zurückholen ohne Banner, je ein WINCH in der maximierten Kachel. |
| 12 M2-Aufwachen | offen | beim Maintainer am Gerät |

## Befunde

1. **Neuanlage gleichen Namens (Schritt 7), behoben in 861e434.** Der Kanal
   der Kachel endete. Die Probe nach dem Verlust (`probeHost`) lud die Liste
   neu, und `setSessionRecords` gab dem Eintrag gleichen Namens die neue ID.
   Die stille Wiederanhängung (UX-Spec §5.5) fand ihre Session über den Namen
   und hängte sich an die neue. Jetzt merkt sich eine Reihe die
   numerische Identität vom Montieren. Eine andere ID oder ein anderer
   tmux-Server unter dem Namen gilt als beendete Session.
2. **Anleitung Schritte 3 und 11.** `trap 'echo WINCH' WINCH; while :; do
   sleep 1; done` meldet in einer interaktiven Bash nie WINCH: `sleep` läuft
   als eigene Vordergrund-Prozessgruppe, das Signal erreicht die Bash nicht.
   Die Pane änderte ihre Größe trotzdem (115x56 → 234x56 → 115x56). Die
   Anleitung nimmt jetzt `bash -c 'trap "echo WINCH" WINCH; while :; do sleep
   1 & wait $!; done'`.
3. **agy nach Selbstupdate, behoben in 703edf3.** agy 1.4.6 legt beim Start
   seine laufende Datei als `~/.local/bin/agy.<Ziffern>.old` ab. Über
   `/proc/<pid>/exe` war der Prozess damit kein agy mehr, und der Tooltip
   nannte „no agent source is attached yet“ statt „agy shows no status in
   its title“.

## Beobachtungen

- Nach einem App-Neustart erscheint für die wiederhergestellte Kachel einer
  beendeten Session neben der Sperrleiste ein Fehlerbanner („Couldn't open
  …“). Die Sperrleiste sagt dasselbe.
- „Disconnect“ räumt die Kacheln des Hosts ab, wie in `main.ts` vorgesehen.
- Claude meldete auf beiden VMs „You've used 88% of your weekly limit“.

## Offen am Fenster

- einmaliges Blinken der Taskleiste (Schritt 2);
- Kasten „Live updates stopped“ nach fünf gescheiterten Versuchen (Schritt 6);
- echte Tastatur und Maus statt CDP;
- Schritt 12 (M2).
