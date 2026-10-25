# Messung: Standard-Socket, Plan M3.1 Schritt 1

Stand 2026-10-25. Schritt 1 des
[Plans](../plans/2026-10-25-standard-socket.md) zur
[Spec vom 25.10.](../specs/2026-10-25-standard-socket-design.md): zwei
Annahmen belegen, bevor gebaut wird. Beide Test-VMs, 192.0.2.10 (tmux 3.3a)
und 192.0.2.20 (tmux 3.6), nur auf eigenen Testsockets
(`abtest_20261025_*`), nach jedem Lauf entfernt. Der Standard-Socket der VMs
lief während der Messung nicht und wurde nur gelesen (`list-sessions`).
Rohdaten unter `fixtures/standard-socket-2026-10-25/`.

## Ergebnis

1. Der Wächter zum Anhängen funktioniert mit `attach-session -E` auf 3.3a und
   3.6 wie ohne: Er hängt bei passender Bindung an, lehnt bei falscher ab und
   startet ohne Server nichts. Mit `-E` bleibt die Umgebung der Session
   unverändert; ohne `-E` ersetzt das Anhängen `SSH_AUTH_SOCK` und
   `SSH_CONNECTION` durch die des Clients und löscht `DISPLAY`.
2. `attach-session` als oberster Befehl startet einen fehlenden Server und lädt
   dessen Konfiguration; der `if-shell`-Wächter und `list-sessions` tun das
   nicht.
3. Ein zweites Inventar samt Titeln verlängert die Statusabfrage unter vier
   flutenden Kacheln um 0,17 s im Median und 0,04 s im p95. Die Abfrage liest
   den Standard-Socket deshalb in jedem Durchgang; der Rückfall der Spec §6.3
   (nur jede zweite Abfrage) ist nicht nötig.

## 1. Server ohne Server starten

Testsocket ohne Server, eine Konfiguration, die beim Laden eine Datei anlegt
(`run-shell "touch …"`), auf beiden VMs gleich:

| Befehl | Ausgabe | Datei angelegt |
| --- | --- | --- |
| `tmux -L <test> -f <conf> attach -t =x` | `no sessions`, Exit 1 | ja: Server gestartet, Konfiguration geladen |
| `tmux -L <test> -f <conf> if-shell -F -t =x "1" "attach-session -t =x" ""` | `no server running on …`, Exit 1 | nein |
| `tmux -L <test> -f <conf> list-sessions` | `no server running on …`, Exit 1 | nein |

Die Ausgabe dieses Laufs steht in `fixtures/…/server-start.txt`.

## 2. Der Wächter mit und ohne `-E`

`guard-measure.sh` baut den Wächter in der Form von
`session_binding.rs::attach_guard` (`if-shell -F -t '$<id>'` auf PID,
Startzeit, Session, Fenster, Pane, Pane-PID, aktiv, nicht tot; sonst
`AB_M1_REJECT`). Der Server startet mit `SSH_AUTH_SOCK=/tmp/server-sock`,
`SSH_CONNECTION=server conn` und `DISPLAY=:9`; der anhängende Client hat
`SSH_AUTH_SOCK=/tmp/client-sock`, `SSH_CONNECTION=client conn`, kein
`DISPLAY`, `TERM=xterm-256color`, ein Terminal über `script`. Beide VMs
gleich:

| Fall | angehängte Clients | Umgebung der Session danach |
| --- | --- | --- |
| mit `-E`, Bindung passt | 1 | unverändert |
| mit `-E`, Pane-PID falsch | 0, `AB_M1_REJECT` | unverändert |
| ohne `-E`, Bindung passt | 1 | `-DISPLAY`, `SSH_AUTH_SOCK=/tmp/client-sock`, `SSH_CONNECTION=client conn` |
| mit `-E`, kein Server | Exit 1, `error connecting to …` | kein Server, keine Socket-Datei |

Drei Fehler des Messaufbaus sind korrigiert und hier nicht mitgezählt: das Ziel
`'$0'` in doppelten Anführungszeichen (bash setzte den Skriptpfad ein), das
fehlende `TERM` des Testterminals und eine Eingabe von `script` aus dem
Skriptstrom selbst, die die Shell der Session beendete.

## 3. Statusabfrage mit zweitem Inventar

Debug-Bau mit eingebettetem Frontend aus `main` nach `v0.2.1`, dazu ein
Messprototyp (`prototype.diff`, nicht im Code): Ist
`AIDEVBRIDGE_MEASURE_SECOND_SOCKET` gesetzt, liest `poll_status_with` nach den
Titeln des eigenen Sockets ein zweites Inventar und dessen Titel und verwirft
sie. Auf 192.0.2.10 vier Sessions auf dem eigenen Testsocket, in allen `yes`,
alle vier als Kachel offen; auf dem zweiten Testsocket eine Session. Andere
Hosts getrennt. Gemessen hat `measure-poll.mjs` über CDP die Dauer jeder
`poll_status`-Abfrage der App (ein Wrapper um `fetch` auf
`http://ipc.localhost/poll_status`), je 90 s. Dass Lauf B das zweite Inventar
las, zeigte eine Stichprobe der Prozesse auf der VM
(`env LC_ALL=C tmux -u -L abtest_20261025_meas2 display-message …`).

| Lauf | Abfragen | Median | p95 | Maximum | Mittel |
| --- | --- | --- | --- | --- | --- |
| A: nur eigener Socket | 26 | 988 ms | 1241 ms | 1562 ms | 1024 ms |
| B: mit zweitem Inventar | 25 | 1161 ms | 1282 ms | 1288 ms | 1159 ms |

Die nächste Abfrage beginnt 2 s nach dem Ende der vorigen; die Statuslatenz
wächst also um etwa so viel, wie die Abfrage länger dauert. Das M1-Tor maß am
23.10. unter vier flutenden Kacheln 1,07 s gegen die Grenze von 4 s.

Was diese Messung offen lässt: ein Standard-Socket mit vielen Sessions (das
Inventar und die Titel wachsen mit), tmux 3.4 (kein Host verfügbar), und die
Statuslatenz selbst mit einem echten Agenten; die prüft der Lauf am Fenster
(Plan, Schritt 6).

## Rohdaten

| Datei | Inhalt |
| --- | --- |
| `guard-measure.sh` | Messskript für §2, auf der VM über `bash -s` |
| `guard-measure-ausgabe.txt` | Ausgabe beider VMs, Adressen durch Platzhalter ersetzt |
| `server-start.txt` | Ausgabe zu §1 |
| `prototype.diff` | der Messprototyp für §3 |
| `measure-poll.mjs` | CDP-Messung für §3 |
| `poll-A.json`, `poll-B.json` | jede Abfrage mit Dauer in ms |
