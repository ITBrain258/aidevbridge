# M3.1-Abnahme am 25.10.2026: Tor §1 Punkt 4, 5 und 6

Das Tor der [Standard-Socket-Spec](../specs/2026-10-25-standard-socket-design.md)
§1 an `v0.2.2`. Die Punkte 1 bis 3 hat der Maintainer am selben Tag mit der
MSI am eigenen Rechner abgenommen („Die selbst angelegten TMUX-Sessions werden
angezeigt unter TMUX-Sessions bei dem Host“, „Funktioniert soweit alles“). Die
Punkte 4 bis 6 übernahm auf seinen Auftrag Claude: am Fenster ein Treiber über
CDP mit echten Maus- und Tastaturereignissen, auf den VMs SSH. Dabei fielen
zwei Befunde an, die nicht im Tor stehen. Beide und Punkt 6 sind seitdem
korrigiert; die [Nachmessung vom 27.10.](#nachmessung-am-2710-mit-den-korrekturen)
wiederholt die Läufe mit dem korrigierten Bau.

## Ergebnis

| Punkt | Ergebnis | Notiz |
|---|---|---|
| 4 Nichts verändert | bestanden | auf 192.0.2.20 alle 15 Abschnitte vorher, nach Öffnen, Tippen, zwei Größenänderungen und Schließen und nach allen Latenzläufen gleich, für alle drei Sessions auf dem Standard-Socket |
| 5 Kein Server bleibt kein Server | bestanden | 192.0.2.10 vor dem Verbinden und nach rund 40 min Abfragen ohne Socket `default` und ohne neuen Server; die eigene Liste blieb aktuell |
| 6 Statuslatenz 4 s | an 0.2.2 nicht bestanden, nach den Korrekturen bestanden | an 0.2.2 unter vier flutenden Kacheln 3 von 10 Waiting-Wechseln über 4 s, Median 3,46 s, höchstens 4,97 s; ohne Standard-Socket 1 von 3 (4,15 s). Am 27.10. mit den Korrekturen 12 von 12 unter 4 s, Median 1,73 s, höchstens 3,30 s |

Befunde: [Anhängen scheitert, wenn auf dem Server gerade eine Session
entsteht](#befund-1-anhängen-scheitert-wenn-auf-dem-server-eine-session-entsteht)
(seit 0.2.0) und [die Abfrage dauert mit dem Standard-Socket 0,5 s länger, nicht
0,17 s](#befund-2-die-abfrage-dauert-05-s-länger-nicht-017-s).

## Aufbau

- **Bau:** Debug-Bau mit `opt-level 3` und `tauri/custom-protocol` aus
  `f44a1fa`, dem Commit von `v0.2.2`. Die Umleitungen für Einstellungen und
  Socket wirken nur im Debug-Bau, darum nicht die Release-EXE.
- **Testinstanz:** eigene `settings.toml`, eigener Socket
  `abtest_20261025_m31` (`AIDEVBRIDGE_TMUX_SOCKET`), eigener WebView2-Ordner,
  Fenster maximiert. Der Standard-Socket ist **nicht** umgelenkt: Die App las
  den echten Socket `default` beider VMs.
- **Hosts:** vm10 = 192.0.2.10 (tmux 3.3a, auf dem Standard-Socket kein
  Server), vm20 = 192.0.2.20 (tmux 3.6, auf dem Standard-Socket die Sessions
  `hand` und `test19` des Maintainers und die Testsession `abnahme`, angelegt
  mit `tmux new-session -d -s abnahme -c /tmp`).
- **Agent:** Claude Code 2.1.310 mit `--model haiku --permission-mode default`
  in `/tmp`.
- **Uhr:** vm20 ging 169 bis 262 ms vor (gemessen wie im M1-Tor vor und nach
  jedem Lauf, die Uhr lief in 24 min um 93 ms weg); die Latenzen sind mit dem
  Wert des Laufs bereinigt.
- **Nebenlast:** Ab 15:24 Ortszeit hatte die installierte App des Maintainers
  `abnahme` neben `hand` und `test19` offen (ein Client an derselben
  SSH-Verbindung wie die beiden anderen). Sie fragte vm20 also mit ab.

## Punkt 4: nichts verändert

`snap.sh` hielt auf vm20 den Zustand des Standard-Servers fest: Server-PID und
Startzeit, die Sessions mit ID, `show -g`, `show -gw`, `show -s`,
`show-hooks -g`, `show-environment -g`, und je Session `show -t`,
`show -w -t`, `show-hooks -t` und `show-environment -t`. Die Werte blieben auf
der VM; in den Rohdaten stehen je Abschnitt Zeilenzahl, SHA-256 und bei der
Umgebung nur die Namen.

1. „vorher“: nach dem Anlegen von `abnahme`, vor dem Verbinden von vm20.
2. vm20 verbinden: Die Gruppe „tmux sessions“ zeigt `hand`, `test19` und
   `abnahme`.
3. `abnahme` öffnen: Fenster 234×55 bei einem Client von 234×56, die
   Statuszeile der tmux-Konfiguration blieb also. Eingabe
   `echo ABNAHME_TIPPEN_$((6*7))` kam als `ABNAHME_TIPPEN_42` an.
   Seitenleiste ein- und ausblenden: 269×55, dann wieder 234×55. Schließen:
   kein Client mehr, Fenster blieb 234×55.
4. „nachher“: gleich „vorher“.
5. Nach den Latenzläufen mit Claude in `abnahme`, eigenem Schließen, dem
   Schalter „Show tmux sessions“ aus und wieder an: „ende“ gleich „vorher“.

Entscheidend war `show-environment -t abnahme`: Die Session stammt aus einer
SSH-Verbindung des Rechners, die Kachel aus einer anderen. Ohne `-E` hätte das
Anhängen `SSH_CONNECTION` auf den Quellport der App gesetzt (Messung vom
25.10., §2).

## Punkt 5: kein Server bleibt kein Server

vm10 war ab dem Start der Testinstanz verbunden und wurde rund 40 min
abgefragt. `/tmp/tmux-1000/` enthielt vorher und nachher nur `agentbridge`,
`tmux ls` meldete beide Male „error connecting to /tmp/tmux-1000/default“.
Die Prozessliste unterschied sich nur in einem Client auf `agentbridge`, der
zu einer anderen App gehört und nicht Teil der Messung ist. Die eigene Liste
von vm10 („No sessions“) blieb aktuell; die Abfrage dauerte 0,31 bis 0,49 s.

## Punkt 6: Statuslatenz

Gemessen wie im M1-Tor: `vmgate.sh` bzw. `vmgate2.sh` lasen auf vm20 alle rund
0,3 s `claude agents --json` und die Panes, `pagesamp.mjs` die Seite alle
100 ms; `lat.mjs` rechnet vom ersten JSON mit dem neuen Zustand bis zur
Pille der Sessionzeile. Last: in den eigenen Kacheln `f3`, `f4`, `r2`, `r3`
lief `yes`; Claude in `abnahme` (fremd) bzw. `r1` (eigen) fragte um Freigabe
(`touch` bzw. das Write-Werkzeug), abgelehnt mit Esc. Alle Freigaben erschienen
als Waiting „permission prompt“ und in der Wartet-Spur, danach Idle.

| Lauf | Kacheln | Waiting: JSON → Zeile |
|---|---|---|
| 1, fremd | 4 Fluten + `abnahme` | 1,87 · 3,95 · 3,20 s |
| 2, fremd | 4 Fluten + `abnahme` | 4,58 · 4,82 · 3,19 s |
| „mit“, abwechselnd | 4 Fluten + `abnahme` + `r1` | fremd 4,97 · 3,72 s; eigen 0,77 · 1,64 s |
| „ohne“, Schalter aus | 4 Fluten + `r1` | 4,15 · 0,56 · 3,82 s |

Mit Standard-Socket also 10 Werte von 0,77 bis 4,97 s, Median 3,46 s, drei
über 4 s; ohne einer von drei. Eigene und fremde Sessions bekommen ihren Status
aus derselben Abfrage und demselben `claude agents`; ihr Unterschied im Lauf
„mit“ ist die Phase zum Abfragetakt, nicht der Socket.

Die Ursache zeigt die Dauer der Abfragen (`netpoll.mjs` liest über CDP passiv
die Anfragen an `ipc.localhost/poll_status` mit):

| vm20 | Abfragen | Dauer Median | p90 | Pause bis zur nächsten, Median |
|---|---|---|---|---|
| Fluten, mit Standard-Socket | 57 | 1824 ms | 2020 ms | 2573 ms |
| „mit“ | 36 | 1893 ms | 2049 ms | 2582 ms |
| „ohne“, Schalter aus | 31 | 1349 ms | 1427 ms | 2464 ms |

Ein Takt dauert mit Standard-Socket rund 4,4 s (Abfrage plus Pause), ohne ihn
rund 3,8 s. Die Pause liegt im Median 0,5 s über den 2 s, die `main.ts` vorgibt:
Der Zeitgeber der Seite feuert unter den Fluten spät. Fällt ein Wechsel kurz
hinter das `claude agents` einer Abfrage, sieht ihn erst die nächste; bis zu
deren Ende vergeht mehr als ein Takt. Ohne Last dauerte eine Abfrage von vm20
1,1 bis 1,3 s. Auf der VM selbst brauchen `claude agents --json` rund 0,3 s und
eine tmux-Abfrage 10 ms; der Rest sind die einzelnen SSH-Aufrufe.

Das Fenster blieb bedienbar: eine Auswertung der Seite 90 bis 220 ms, der
nächste Frame nach 88 ms.

Nebenbei: Im Lauf „mit“ (sechs Kacheln, zwei Claude-Oberflächen) zeigten die
vier flutenden Kacheln nacheinander je einmal kurz „Reconnecting…“ und hängten
sich still wieder an; in den Läufen mit fünf Kacheln nicht. Das gehört zum
bekannten Engpass im Renderer bei vielen flutenden Kacheln (`docs/stand.md`).

Ab Lauf 2 gab Claude Code den `touch`-Befehl nach einigen Sekunden selbst frei
und fragte in den Runden 4 und 5 von Lauf 2 gar nicht mehr; das liegt an Claude
Code auf der VM. Diese Runden haben keinen Waiting-Wechsel und zählen nicht.
Es entstanden nur leere Dateien im Testordner.

## Befund 1: Anhängen scheitert, wenn auf dem Server eine Session entsteht

Viermal „New session“ im Abstand von rund 3 s (`f1` bis `f4`): Die Kacheln
von `f1` und `f2` endeten gesperrt, das Banner lautete „Couldn't open 'f2'.
It may have ended on the host“, die Details „attach identity changed“. `f3`
und `f4` gingen.

Ursache: Nachdem der Client angehängt ist, liest `open_terminal`
(`commands.rs`) Liste, Auflösung, Inventar, Auflösung und Liste als fünf
einzelne Befehle, und `confirm_listed_inventory` verlangt beide Listen gleich.
Entsteht in dieser Zeit irgendwo auf demselben Server eine Session oder endet
eine, gilt das als geänderte Identität. Die Prüfung gibt es seit 0.2.0.

Nachgestellt auf dem Testsocket mit `trials.mjs` und `churn.sh` (alle
rund 0,2 s eine Session `zz<n>` an und wieder weg):

| | Öffnen geglückt |
|---|---|
| ohne Schleife | 8 von 8 |
| mit Schleife | 2 von 8; die übrigen nach 1,3 bis 1,5 s mit „attach identity changed“ |

Auf dem Standard-Socket trifft es mehr: Dort legt der Nutzer selbst Sessions
an und beendet sie. Nachgestellt ist es nur auf dem Testsocket; der Weg ist für
beide Sockets derselbe.

## Befund 2: Die Abfrage dauert 0,5 s länger, nicht 0,17 s

Die [Messung vom Vormittag](messung-2026-10-25-standard-socket.md) §3 sagte
für das zweite Inventar samt Titeln +0,17 s im Median voraus; die Spec §6.3
liest den Standard-Socket deshalb in jeder Abfrage. Im fertigen Bau sind es auf
vm20 +0,47 bis +0,54 s (1349 gegen 1824 bzw. 1893 ms). Der Bau schickt wie
der Prototyp zwei Befehle mehr (Inventar und Titel des Standard-Sockets, nach
`claude agents`). Der Prototyp las sie auf 192.0.2.10 mit einer Session auf dem
zweiten Socket, hier sind es drei auf vm20. Woran die Befehle hier mehr kosten,
ist offen.

## Nachmessung am 27.10. mit den Korrekturen

Drei Korrekturen auf dem Zweig `fix/m31-abnahme` (über `main` mit 0.2.3):

- **Bestätigung nach dem Anhängen:** Hat sich zwischen den beiden Listen nur
  die Sessionliste geändert (`ListingChanged` oder `ListingInventoryMismatch`
  in `correlate`), liest `open_terminal` die fünf Antworten erneut, höchstens
  viermal innerhalb der Frist. Eine Änderung der gewählten Session scheitert
  weiter sofort.
- **Abfrage:** Der Standard-Socket wird neben dem eigenen Socket und
  `claude agents` gelesen, auf weiteren Kanälen derselben Verbindung, statt
  danach.
- **Takt:** Die nächste Abfrage beginnt 2 s nach dem Beginn der vorigen,
  frühestens 0,5 s nach ihrem Ende (UX-Spec §5.2, Nachtrag vom 27.10.); vorher
  2 s nach dem Ende.

Aufbau wie oben, Bau aus `62bf523`, Testsocket `abtest_20261027_m31`, vm20 erst
nach der Momentaufnahme „vorher“ verbunden. Claude Code 2.1.310 wie am 25.10.

**Befund 1.** Viermal „New session“ im Abstand von rund 3 s: alle vier Kacheln
offen, kein Banner (am 25.10. scheiterten die ersten beiden). Öffnen von `r1`
mit `trials.mjs`:

| | 25.10. | 27.10. |
|---|---|---|
| ohne Schleife | 8 von 8 | 8 von 8 |
| mit Schleife (`churn.sh`, hier 341 Runden in 75 s) | 2 von 8 | 8 von 8 |

**Punkt 6.** Last wie im Lauf „mit“: `yes` in `f1` bis `f4`, Claude in
`abnahme` (fremd) und `r1` (eigen), sechs Kacheln, Freigaben abwechselnd.
Lauf „neu“ mit dem Auftrag vom 25.10., Lauf „neu2“ mit einer `.md`-Datei mit
Überschrift, weil Claude Code den ersten Auftrag nach einigen Runden ohne
Rückfrage ausführt; 4 von 16 Runden fragten nicht und zählen nicht.

| Lauf | fremd (`abnahme`) | eigen (`r1`) |
|---|---|---|
| neu | 1,67 · 2,03 · 2,36 s | 1,40 · 2,04 · 3,30 s |
| neu2 | 1,33 · 1,78 · 1,56 s | 0,91 · 1,67 · 2,03 s |

12 von 12 unter 4 s, Median 1,73 s, höchstens 3,30 s. Die Abfragen:

| vm20 | Dauer Median | p90 | Pause bis zur nächsten, Median | Takt |
|---|---|---|---|---|
| 25.10., „mit“ | 1893 ms | 2049 ms | 2582 ms | rund 4,5 s |
| 27.10., neu | 962 ms | 1177 ms | 1178 ms | rund 2,1 s |
| 27.10., neu2 | 928 ms | 1033 ms | 1215 ms | rund 2,1 s |

vm10 (ohne Standard-Server) brauchte je Abfrage im Median 0,21 s; dort beginnt
die nächste wie vorgesehen 2 s nach dem Beginn der vorigen (Pause 1,92 s). Die
Abfrage von vm20 ist um mehr kürzer geworden, als die parallele Lesung allein
erklärt (am 25.10. ohne Standard-Socket 1349 ms). Der Tag war ein anderer, die
VM weniger belastet; den Anteil der Korrektur an der Dauer belegt diese
Messung nicht, die Grenze von 4 s schon.

**Punkt 4 und 5** halten weiter: Auf vm20 waren alle Abschnitte nach den
Sessions, dem Öffnen von `abnahme`, Claude darin und beiden Läufen gleich
„vorher“; vm10 hatte nach rund 12 min Abfragen keinen Standard-Socket.

**Nebenbei:** In „neu2“ zeigten `f3` und `f4` je einmal kurz „Reconnecting…“
und eine Auswertung der Seite brauchte bis 1,8 s; in „neu“ nichts davon,
höchstens 0,33 s. Das ist derselbe Engpass im Renderer wie am 25.10.

**Tests:** Rust fmt, Clippy mit `-D warnings`, `cargo test --all
--no-fail-fast` (611 Bibliothekstests, darunter vier neue), 2691
Frontend-Tests, TypeScript- und Vite-Build und 94 Skripttests grün. Live gegen
beide VMs auf eigenen Testsockets mit `--test-threads=4` grün (je 43 Tests,
darunter `integration_default_socket.rs`). Im ersten Lauf auf vm20 scheiterte
einmal `killing_a_session_deliberately_emits_no_connection_lost_event` in
`kill_session_impl`; der Grund ist nicht festgehalten. Einzeln lief er dreimal
grün, der volle Lauf danach auch; den Beenden-Pfad berühren die Korrekturen
nicht.

Aufgeräumt: Testsocket, die Testsession `abnahme` auf dem Standard-Socket von
vm20 (diesmal ohne Client), `/tmp/abnahme-m31` und die Socketdateien der
Live-Tests auf beiden VMs.

## Rohdaten

Unter [`fixtures/m31-abnahme-2026-10-25/`](fixtures/m31-abnahme-2026-10-25/),
IPs als Platzhalter, Hostnamen als `<host>`:

| Datei | Inhalt |
| --- | --- |
| `snap-vorher.txt`, `snap-ende.txt`, `diff-vorher-nachher.txt` | Punkt 4: Zusammenfassungen ohne Werte und die Vergleiche |
| `vm10-vorher.txt`, `vm10-ende.txt` | Punkt 5: Socketordner und tmux-Prozesse auf vm10, fremde Prozesse gekürzt |
| `vmgate-*.txt`, `page-*.jsonl`, `clock-*.json`, `latenz-*.txt` | Punkt 6 je Lauf (`1`, `2`, `mit`, `ohne`) |
| `net-fluten.jsonl`, `net-mit.jsonl`, `net-ohne.jsonl` | Dauer jeder `poll_status`-Abfrage (`h0` = vm10, `h1` = vm20) |
| `oeffnen-ohne-schleife.txt`, `oeffnen-mit-schleife.txt` | Befund 1 |
| `werkzeuge/` | `snap.sh`, `churn.sh`, `vmgate2.sh`, `vm.sh` (VM); `trials.mjs`, `netpoll.mjs`, `netsum.mjs`, `phase.sh` und `lat.mjs` (mit Zustand `null` als `none`) am Rechner, dazu die Werkzeuge vom M1-Tor |
| `nachmessung-2026-10-27/` | dieselben Dateiarten für die Nachmessung, Läufe `neu` und `neu2`; `phase.sh` mit `SOCK=abtest_20261027_m31 FLOOD="f1 f2 f3 f4"` |

Aufgeräumt am 25.10.: der Testsocket auf vm20 und `/tmp/abnahme-m31` mit den
Momentaufnahmen. `abnahme` blieb bis zur Nachmessung auf dem Standard-Socket
von vm20 stehen, weil die App des Maintainers sie offen hatte.
