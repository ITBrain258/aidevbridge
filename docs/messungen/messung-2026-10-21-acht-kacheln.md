# Acht Kacheln je Host: Lastmessung vom 21. Oktober 2026

Mit 4, 6 und 8 Kacheln je Host unter begrenzter Dauerflut (rund 180 KB/s je
Kachel) hält die App jede Startschwelle: Statuslatenz p95 unter Flut höchstens
**3,2 s** (Schwelle 4 s aus M1), Ereignisschleife p95 höchstens 16 ms,
**kein Kanalverlust**, und der JS-Heap nach erzwungener Bereinigung wächst über
einen Lauf um höchstens 6 %. Unter unbegrenzter Ausgabe (`yes`) geht ebenfalls
kein Kanal mehr verloren. Mit vier solchen Kacheln, der Bedingung des M1-Tors,
bleibt die Statuslatenz mit 4,0 s im Rahmen. Mit acht steigt sie auf **5,0 s**,
die Ereignisschleife auf 215 ms (p95): Die Oberfläche wird zäh, verliert aber
nichts. Es bleibt bei acht Kacheln je Host; die Grenze bei acht ungebremst
flutenden Kacheln steht unter „Was diese Messung offen lässt“.

Die erste Messreihe am Morgen fand, dass unbegrenzte Ausgabe den Terminalkanal
bei jeder Kachelzahl abriss, schon bei einer Kachel nach gut einer Sekunde.
Der Fehler bestand schon vor Schritt 3. Er ist auf dem Branch behoben (echte
SSH-Flusskontrolle für Terminalkanäle, siehe „Die erste Reihe und die
Flusskontrolle“), und alle Werte oben stammen aus der Reihe danach.

Die Anforderung steht in der
[Raster-Spec, §8.1](../specs/2026-10-19-dynamisches-raster-design.md). Die
Schwellen sind Startwerte aus dem
Plan „Acht Kacheln je Host“; der Nutzer hat die
Entscheidung über sie am 20.10. abgegeben. Nur die 4 s stammen aus M1
([MVP-Spec §3.4](../specs/2026-09-05-mvp-und-statuspunkt-design.md)).

## Aufbau

- **Stand:** `feature/acht-kacheln-je-host` nach Task 5 des Plans und der
  Flusskontrolle; der Commit steht in `build.txt`. Gebaut außerhalb des
  Worktrees aus `git archive`: `npm run build`, dann `cargo build --locked
  --features tauri/custom-protocol` im dev-Profil mit
  `CARGO_PROFILE_DEV_OPT_LEVEL=3` und eigenem Zielordner. `debug_assertions`
  bleiben an, nur dann gelten die Test-Schalter. exe sha256
  `B335AAD86ADFD87BB7CF1698CA6F33B12A7EA8F689055660E10275A3CC936643`.
- **Windows:** Notebook mit Intel Core i5-8365U (4 Kerne, 8 Threads), 32 GB
  RAM und Intel UHD Graphics 620, Windows 11 Pro (Build 26300), 125 %,
  bedient über Remote Desktop. Fenster maximiert, Seite 1536 × 794
  CSS-Pixel, WebView2 Edg/155. Die App des Nutzers war geschlossen, das
  DevTools-Fenster des Debug-Baus während der Läufe zu.
- **Test-VM:** Ubuntu 26.04.1 LTS, Kernel 7.0.0-38, 24 Kerne, tmux 3.6,
  Claude Code 2.1.305 (`claude agents --json` 211 ms), `MaxSessions` nicht
  gesetzt (Vorgabe 10). Die VM teilt sich ein anderes Projekt; ihre Last vor
  und nach jedem Lauf steht in `vm-<lauf>-before.txt` und `-after.txt`.
- **Abschottung:** eigener Einstellungsordner, eigener tmux-Socket, eigener
  WebView2-Datenordner, CDP-Port 9333. Die mit der echten App geteilte
  Fensterlage war vorher gesichert und wurde nach jedem Ende zurückgespielt
  und per sha256 geprüft (`starts.txt`). Verbunden war nur der Eintrag
  `acht-a`.
- **Last:** L1 je flutender Kachel `timeout --foreground 180 sh -c 'while :;
  do head -c 15000 /dev/urandom | base64 -w 76; sleep 0.1; done'`, rund
  180 KB/s angeboten; L2 `timeout --foreground 120 yes`. Beide laufen als Kind
  der Pane-Shell und starten über Go-Dateien binnen 0,2 s in allen Kacheln
  (`flood.txt`). tmux zeichnet langsame Clients neu, statt jedes Byte zu
  schicken; gezählt ist darum, was die Kacheln mit `ack_output` bestätigt
  haben.
- **Statusprobe `p1`**, nie eine Kachel: Ein Python-Prozess nennt sich per
  `prctl` `grok` und wechselt alle 7,3 s den Panetitel zwischen
  `⠴ - Thinking - probe - grok` (Busy) und `probe - grok` (Idle), zwei
  gemessenen Formen; jeder Wechsel steht mit Millisekunden in `probe.txt`.
  Latenz ist die Zeit bis zur Pille dieser Art in der Seitenleiste, mit dem
  Uhrabstand verrechnet (20 Ping-Pongs über eine ssh-Sitzung vor und nach
  jedem Lauf, die kürzeste Rundreise zählt, gemittelt über vorher und
  nachher; `clock.jsonl`).
- **Instrumentierung**, für jedes N gleich (`fixtures/acht-kacheln/werkzeuge/`):
  `hook.js` (IPC-Zeiten, Acks je Kachel, Ereignisschleife im 100-ms-Takt,
  Merker per `MutationObserver`), `sampler.mjs` (nur lesend; alle 5 s
  `Performance.getMetrics` und ein Schnappschuss), `mem.ps1` (alle 5 s
  Private Bytes, Working Set, CPU und GPU-Speicher der eigenen Prozesse),
  `win.ps1` (alle 2 s: Fenster maximiert und nicht minimiert, Sitzung
  verbunden und nicht gesperrt), `raf.mjs` (alle 30 s die Bildrate der Seite),
  `gc.mjs` (erzwungene Speicherbereinigung vor und nach jedem Lauf), `vm.sh`,
  `run.ps1`, `serie.ps1`, `clock.mjs`, `ana.mjs`, `tabellen.mjs`. Kacheln
  öffnete und schloss `abnahme.mjs` über echte Klicks.

## Ablauf

| Lauf | Kacheln | Last | Beginn (UTC) | Uhrabstand vorher / nachher (ms) | Fenster maximiert, Sitzung verbunden |
| --- | --- | --- | --- | --- | --- |
| N4-L1 | f1–f4 | L1 | 10:30:03 | 1272 / 1277 | ja (149 Proben) |
| N6-L1 | f1–f6 | L1 | 10:35:27 | 1277 / 1280 | ja (150 Proben) |
| N8-L1 | f1–f8 | L1 | 10:40:50 | 2054 / 1285 | ja (150 Proben) |
| N8-L2 | f1–f8 | L2 | 10:46:09 | 1287 / 1290 | ja (119 Proben) |
| N4-L2 | f1–f4 | L2 | 10:50:32 | 1289 / 1293 | ja (119 Proben) |

Je Lauf 60 s Ruhe, Flut (L1 180 s, L2 120 s), 60 s Nachlauf, alle auf einer
Instanz in dieser Reihenfolge. Ein Lauf gilt nur, wenn `win.jsonl` über seine
ganze Dauer ein maximiertes Fenster in einer verbundenen Sitzung zeigt; alle
730 Proben der Reihe tun das. Drei Wiederholungen am Vormittag liefen ohne
diese Prüfung in einem verkleinerten, später minimierten Fenster; sie zählen
nicht und liegen nicht bei.

## Ergebnisse

### Status

Latenzen in Millisekunden.

| Lauf | Phase | Wechsel | verpasst | Median | p95 | Max | veraltet | Poll Median / p95 / Max | Ereignisschleife p95 / Max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N4-L1 | Ruhe | 8 | 0 | 1762 | 3086 | 3086 | 0 | 860 / 907 / 921 | 11 / 16 |
| N4-L1 | Flut | 25 | 0 | 1778 | 3080 | 3251 | 0 | 856 / 914 / 993 | 11 / 30 |
| N4-L1 | Nachlauf | 8 | 0 | 1626 | 2938 | 2938 | 0 | 823 / 887 / 897 | 11 / 23 |
| N6-L1 | Ruhe | 8 | 0 | 1881 | 3043 | 3043 | 0 | 803 / 830 / 849 | 10 / 16 |
| N6-L1 | Flut | 25 | 0 | 1646 | 3080 | 3100 | 0 | 816 / 876 / 920 | 16 / 42 |
| N6-L1 | Nachlauf | 8 | 0 | 1882 | 3066 | 3066 | 0 | 816 / 856 / 862 | 11 / 27 |
| N8-L1 | Ruhe | 9 | 0 | 2129 | 3424 | 3424 | 0 | 838 / 916 / 917 | 11 / 16 |
| N8-L1 | Flut | 24 | 0 | 2159 | 3217 | 3497 | 0 | 864 / 935 / 1013 | 14 / 37 |
| N8-L1 | Nachlauf | 9 | 0 | 1349 | 2807 | 2807 | 0 | 870 / 938 / 983 | 11 / 15 |
| N8-L2 | Ruhe | 8 | 0 | 1582 | 3143 | 3143 | 0 | 840 / 923 / 979 | 11 / 20 |
| N8-L2 | Flut | 17 | 0 | 3151 | 5040 | 5040 | 0 | 1429 / 1594 / 1658 | 215 / 1455 |
| N8-L2 | Nachlauf | 8 | 0 | 2188 | 3909 | 3909 | 0 | 974 / 1064 / 1064 | 149 / 222 |
| N4-L2 | Ruhe | 8 | 0 | 1367 | 3046 | 3046 | 0 | 814 / 848 / 869 | 11 / 15 |
| N4-L2 | Flut | 17 | 0 | 2545 | 3976 | 3976 | 0 | 1156 / 1252 / 1253 | 109 / 228 |
| N4-L2 | Nachlauf | 8 | 0 | 1604 | 2981 | 2981 | 0 | 843 / 948 / 1017 | 93 / 138 |

Schon ohne Last hängt die Statuslatenz am Polltakt: Der nächste Poll beginnt
2 s nach dem Ende des vorigen, ein Poll dauert hier rund 0,85 s. Teilausfälle
der Statusabfrage (Titel oder `claude agents`) gab es in keiner Phase.

### Kanäle

| Lauf | Ruhe-Chip / Sperre / Banner | open/close in der Flut | abgewiesen | tmux-Clients gleich | MB je Kachel (Median) | längste Ack-Lücke (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| N4-L1 | 0 / 0 / keins | 0 | 0 | ja | 13 | 152 |
| N6-L1 | 0 / 0 / keins | 0 | 0 | ja | 6,8 | 162 |
| N8-L1 | 0 / 0 / keins | 0 | 0 | ja | 4,2 | 156 |
| N8-L2 | 0 / 0 / keins | 0 | 0 | ja | 1,3 | 1536 |
| N4-L2 | 0 / 0 / keins | 0 | 0 | ja | 3,3 | 284 |

### Speicher und Last

| Lauf | privat Leerlauf | letzte 60 s der Flut | nach dem Nachlauf (über Leerlauf) | Renderer vorher → Flutende | JS-Heap nach erzwungener Bereinigung vor / nach dem Lauf | GPU dediziert / geteilt | CPU Renderer / GPU / App (%) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N4-L1 | 290 MB | 701–849 MB (+21,1 %) | 806 MB (+177,9 %) | 102 → 579 MB | 9,7 / 9,9 MB | 0 / 107 MB | 47 / 15 / 29 |
| N6-L1 | 347 MB | 732–880 MB (+20,3 %) | 870 MB (+151,0 %) | 128 → 619 MB | 13,3 / 13,5 MB | 0 / 116 MB | 63 / 19 / 42 |
| N8-L1 | 390 MB | 758–922 MB (+21,7 %) | 910 MB (+133,2 %) | 146 → 648 MB | 15,6 / 15,6 MB | 0 / 108 MB | 69 / 19 / 45 |
| N8-L2 | 424 MB | 764–825 MB (+8,0 %) | 871 MB (+105,5 %) | 157 → 504 MB | 15,6 / 16,6 MB | 0 / 109 MB | 125 / 11 / 91 |
| N4-L2 | 493 MB | 676–751 MB (+11,0 %) | 733 MB (+48,6 %) | 159 → 405 MB | 10,3 / 10,4 MB | 0 / 112 MB | 124 / 14 / 93 |

Zuwachs je Kachel (Höchstwert privat, letzte 60 s der Flut): 4→6 15,8 MB,
6→8 20,9 MB, Verhältnis 1,32. Über alle Läufe derselbe GPU-Prozess und ein
Renderer.

Die Speicherschwellen des Plans (Plateau ≤ +5 %, nach dem Nachlauf ≤ Leerlauf
+ 20 %) prüfen Private Bytes. Die steigen unter Flut, weil die Ausgabe als
JSON-Zahlenfelder an die Seite geht und V8 große Felder spät einsammelt: Vor
der erzwungenen Bereinigung nach einem L1-Lauf lagen 380 bis 442 MB im JS-Heap,
danach 10 bis 16 MB (`gc.jsonl`). Ein Leck wäre auch nach der Bereinigung zu
sehen. Darum wurde bei der Messung entschieden: Maßgeblich ist der JS-Heap
nach erzwungener Bereinigung, vor und nach jedem Lauf, mit höchstens +20 %.
Die Private-Bytes-Werte stehen oben zum Vergleich.

### Bedienbarkeit

Die Ereignisschleife steht in der Statustabelle: unter L1 p95 höchstens
16 ms, unter L2 109 ms bei vier und 215 ms bei acht Kacheln. Die Seite zeichnete
in Ruhe 31 bis 35, unter L1 21 bis 33 und unter L2 10 bis 18 Bilder je
Sekunde (`raf.jsonl`; unter Remote Desktop liegt die Obergrenze bei rund 30).
Tippen, Maximieren und Zurückholen unter Flut prüft die Fensterabnahme; ihr
Ergebnis steht in `docs/stand.md`.

## Bewertung gegen die Startschwellen

| Größe | Startwert | gemessen | erfüllt |
| --- | --- | --- | --- |
| Statuslatenz unter Flut, p95 | ≤ 4,0 s (M1) | L1: 3,08 / 3,08 / 3,22 s; L2: 3,98 s (N4), 5,04 s (N8) | ja, außer N8-L2 |
| Median unter Flut | ≤ Median in Ruhe + 1 s | L1: 1,78 / 1,65 / 2,16 s gegen 2,76 / 2,88 / 3,13 s; L2: 2,55 gegen 2,37 s (N4), 3,15 gegen 2,58 s (N8) | L1 ja; L2 nein (um 0,18 und 0,57 s) |
| Wechsel der Probe in der Flut | ≥ 20 (L1), ≥ 14 (L2), verpasst 0 | 25 / 25 / 24 und 17 / 17, verpasst 0 | ja |
| veraltete Pille | 0 | 0 | ja |
| Kanalverluste | 0 | 0 in allen fünf Läufen | ja |
| Ack-Lücke unter L2 | ≤ 5 s | 1,54 s (N8), 0,28 s (N4) | ja |
| Speicher | JS-Heap nach Bereinigung ≤ vorher + 20 %; Zuwachs je Kachel 6→8 ≤ 1,5 × 4→6 und ≤ 50 MB; GPU-Prozess gleich; kein Kontextverlust | höchstens +6,4 % (N8-L2: 15,6 → 16,6 MB); 20,9 gegen 15,8 MB (1,32); ein GPU-Prozess; keine WebGL-Meldung | ja |
| Private Bytes (Schwelle des Plans) | Plateau ≤ +5 %, Nachlauf ≤ Leerlauf + 20 % | +8 bis +22 %; +49 bis +178 % | nein; durch die Heap-Schwelle ersetzt (oben) |
| Ereignisschleife | p95 ≤ 200 ms | L1 11 bis 16 ms; L2 109 ms (N4), 215 ms (N8) | ja, außer N8-L2 |
| Exec-Kapazität (Rohtext in `page.jsonl`, Teilausfälle der Statusabfrage) | 0 | 0 | ja |

## Die erste Reihe und die Flusskontrolle

Die erste Reihe am Morgen (Stand vor der Flusskontrolle; Rohdaten samt
Commit unter `fixtures/acht-kacheln/vor-flusskontrolle/`) bestand unter L1
bei 4, 6 und 8 Kacheln ohne Kanalverlust. Bei 8 lag die Statuslatenz p95 mit
4,6 s über der Schwelle, der Renderer bei 108 % CPU. Unter L2 rissen alle
Kanäle ab, 8 von 8 und 4 von 4, je mit Sperre nach drei gescheiterten
Wiederanhängen; schon eine einzelne Kachel zeigte 1,1 s nach dem Start der
Flut „Reconnecting…“, bei 2 % Renderer-CPU.

Die Ursache ist im Test nachgestellt: russh vergrößerte das SSH-Fenster beim
Eintreffen der Daten, nicht beim Verbrauch. Der Host sendete also mit
Netzgeschwindigkeit, die begrenzte Ausgabewarteschlange der App lief über,
und die App schloss den Kanal. Seit der Korrektur gibt jedes Terminal sein
Fenster (384 KiB) erst frei, wenn es die Ausgabe an die Seite weitergegeben
hat. Ist das Terminal langsamer als die Ausgabe, wartet der Host, und tmux
überspringt Zwischenstände. Das ist ein weiterer lokaler Patch an
`vendor/russh` (`AGENTBRIDGE-PATCH.md`). Bei 8 Kacheln unter L1 sank dadurch
auch die Last: Statuslatenz p95 von 4,6 auf 3,2 s, Ereignisschleife p95 von
198 auf 14 ms, Renderer von 108 auf 69 % CPU.

## Beobachtungen

- **Pollzeiten:** In Ruhe und unter L1 dauerte ein Poll im Median 0,80 bis
  0,87 s, unter L2 1,16 s (N4) und 1,43 s (N8). Die VM war nie der Engpass:
  Ihre Last lag vor und nach den Läufen zwischen 0,5 und 2,7 bei 24 Kernen
  (`vm-*.txt`).
- **Bestätigte Menge:** L1 bietet je Kachel rund 32 MB in 180 s an.
  Bestätigt wurden im Median 13 MB bei 4, 6,8 MB bei 6 und 4,2 MB bei 8
  Kacheln, zusammen rund 52, 41 und 34 MB. Den Rest übersprang tmux für die
  gedrosselten Clients. Der Durchsatz der Seite sinkt also mit der Zahl der
  Kacheln; der Engpass ist der Renderer, nicht die Verbindung.
- **Uhrabstand:** Die Messung vor N8-L1 ergab 2054 ms, alle anderen 1272 bis
  1293 ms. Mit dem Mittel aus vorher und nachher (1670 ms) sind die
  Latenzen von N8-L1 bis zu 0,39 s zu hoch angesetzt; die Schwelle hält
  trotzdem.
- **Konsole:** keine Meldung zu WebGL, Kontextverlust, Kapazität oder
  Ausnahmen. Nur der Debug-Bau meldet beim Öffnen seines DevTools-Fensters
  einen CSP-Treffer für `devtools.json`.
- **Ereignisse:** Seit der Flusskontrolle kommt Ausgabe, die während des
  Öffnens anfällt, in weniger und größeren Ereignissen an (bis 32 KiB).

## Was diese Messung offen lässt

- Ein Notebook bei 125 % über Remote Desktop und ein Host: zweiter
  Bildschirm, 150 %, ein lokaler 60-Hz-Bildschirm und zwei Hosts unter Flut
  sind nicht gemessen.
- Acht Kacheln, die gleichzeitig ungebremst ausgeben: Statuslatenz p95 5,0 s,
  Ereignisschleife p95 215 ms, Renderer bei 125 % CPU. Ob ein binärer
  Ausgabekanal statt JSON-Zahlenfeldern oder weniger Neuzeichnen das
  behebt, ist offen.
- Echte Agenten: Die Probe ersetzt sie; die Claude-CLI steht nur als
  Einzelwert oben.
- Ein minimiertes oder verdecktes Fenster (die Seite drosselt dann ihre
  Takte) ist nicht gemessen; ebenso, ob die Private Bytes des Renderers bei
  langer Ruhe wieder auf den Leerlauf fallen (der Nachlauf dauerte 60 s).

## Cleanup und Belege

Testinstanz und Socket liefen für die Fensterabnahme weiter; aufgeräumt wurde
nach ihr: Testsocket beendet und gelöscht, Fensterlage per sha256
zurückgespielt, Junction mit `cmd /c rmdir` gelöst. Prüfsummen über den
Inhalt, wie er im Repository
liegt (LF):

| Datei | SHA-256 |
| --- | --- |
| `fixtures/acht-kacheln/ana.txt` | `34a500a70e5d6fad6e9690fecf33be57145849c25d48b2ec6d1884109fd6c1ef` |
| `fixtures/acht-kacheln/build.txt` | `1d2db271b4fa2e277914eb19a1a8b4a9fac8d5da99a42543b92759c2d3b8a9c6` |
| `fixtures/acht-kacheln/cdp.jsonl` | `58d5ac99bfbf2089a236209af04c2d2b2beaa9c920c074d00cafe2481acdacfd` |
| `fixtures/acht-kacheln/clock.jsonl` | `d5e801b2478d0ba2f2cf1ed7fc7a75d1b2255d4078d31faff6543eee05761e16` |
| `fixtures/acht-kacheln/console.txt` | `3c4edcf6e7e2041837f1fd9010750dd95df90c59aca08e3189c2e1a1cdefe353` |
| `fixtures/acht-kacheln/flood.txt` | `37bae622a3a0d08c1847b78edbcdd23a356d6cb2562c32f705fedf207136f4fe` |
| `fixtures/acht-kacheln/gc.jsonl` | `0ec55aec53fb312d8f468435ee384dd22fa9a79625ae055534b130099692901e` |
| `fixtures/acht-kacheln/mem.jsonl` | `31fb41e93634589d9f1183f723f4eafaa31cb83c51600dc0b47566a1b6dcd7a6` |
| `fixtures/acht-kacheln/page.jsonl` | `3d95865b66ffc278c97b5c5b51ae8049a89cd3e0cd7a9dd96bd1dc84737e529c` |
| `fixtures/acht-kacheln/phases.jsonl` | `a63cae4d03c6239f8bace1676db5df519e96e30d5e25846ba1007fc4357d5353` |
| `fixtures/acht-kacheln/probe.txt` | `5fa029c23ad3ffff8d040447592e1b002ae29c02e08b0568e5994884c538b140` |
| `fixtures/acht-kacheln/raf.jsonl` | `3fe9ed1cd11f606b86970f5aab5f41026bd870b6a3650f400c357f44b0d2cf19` |
| `fixtures/acht-kacheln/serie.txt` | `49e66053b5ff10eea67f4efea313144407299c1e7896630d3d130d916e47f365` |
| `fixtures/acht-kacheln/starts.txt` | `526f88182e02d076930cdc42ff2389c75a56466090a1152970a4deb7583ac071` |
| `fixtures/acht-kacheln/vm-N4-L1-after.txt` | `e6461ef0f366887ecebbd3099e73b2d956d4ab594e7725026f1b4d2718532afd` |
| `fixtures/acht-kacheln/vm-N4-L1-before.txt` | `625ca433fdee12f48c842c81e862e7bc6b546fb39fadc19f719fc31160311e23` |
| `fixtures/acht-kacheln/vm-N4-L2-after.txt` | `8200395cb063a82207b1a4d2a75f3b0ab4d34d5659e9d148e94f4d09ca6d7302` |
| `fixtures/acht-kacheln/vm-N4-L2-before.txt` | `a94c137f23b60d9fb76c7927b737e9274fd2a24db4e40e7739f7b7cdd6d30196` |
| `fixtures/acht-kacheln/vm-N6-L1-after.txt` | `2c85ab7b2ddfe38ab1e18f443d856239453dc19e7e6f48579807322223ea1edd` |
| `fixtures/acht-kacheln/vm-N6-L1-before.txt` | `f9a503d639406f819c7ab99c72f1af877985bdd4de8022dc4c7225f17ef1720a` |
| `fixtures/acht-kacheln/vm-N8-L1-after.txt` | `4eeedb2e8b7dcc75cb59d8ea2da424285625cfd073e32a3b9c78d71ad54357dd` |
| `fixtures/acht-kacheln/vm-N8-L1-before.txt` | `594ab1250dbf7563f33724a21cfe204604b423aa853665fba23b4bfafc21d6ed` |
| `fixtures/acht-kacheln/vm-N8-L2-after.txt` | `333cc8dab9c73932a778b94dc2dd842de64c4fccc48025e6eaabbb701457dbc0` |
| `fixtures/acht-kacheln/vm-N8-L2-before.txt` | `b94fb560e015837c0c704589e21cc6be889613160b07a14afc2b4f0df8042ac7` |
| `fixtures/acht-kacheln/vm-info.txt` | `230be5cf4fcdc48adb2d0f374f79a39e9763a43fd52ce63c675a68b46f311528` |
| `fixtures/acht-kacheln/vor-flusskontrolle/ana.txt` | `b597851619a150743be6e3d8d70267597b505f397f7ab4aa0126e628c3460b88` |
| `fixtures/acht-kacheln/vor-flusskontrolle/build.txt` | `5269d093549bab095d725c2ba45041fdcd8b9e193b67399c310f2e64e22b420b` |
| `fixtures/acht-kacheln/vor-flusskontrolle/cdp.jsonl` | `dab4bb316c38ec509393533d652358bcb74d5c4a54384ccf8e02f118aaa0ceda` |
| `fixtures/acht-kacheln/vor-flusskontrolle/clock.jsonl` | `70a448d7a2869e6b4ca0eb776ff83a9ecaf85dcb5c2e4a729cea87710f8032b5` |
| `fixtures/acht-kacheln/vor-flusskontrolle/console.txt` | `b867e6a5697269b59ae67d59ee3a5dd80b97096010eba421342d80c5a0d1ad48` |
| `fixtures/acht-kacheln/vor-flusskontrolle/flood.txt` | `cdb9d8c8b37bc4fe9d6c8d1e4c36060ca07948a546b9880f79b6bfd9c4b3d473` |
| `fixtures/acht-kacheln/vor-flusskontrolle/gc.jsonl` | `ce7830c86c6ff3d4585f268de1fb37995ed9a6a0d4514d2776dc85f4ac1b21a0` |
| `fixtures/acht-kacheln/vor-flusskontrolle/mem.jsonl` | `868cdef470d9ebdcec68a83b736b9f016dae9a06d1953638669077a1c6ab31f1` |
| `fixtures/acht-kacheln/vor-flusskontrolle/page.jsonl` | `b353c666117643eb06a6f08651431731c8b34017b472e17e8a84fe61255dafca` |
| `fixtures/acht-kacheln/vor-flusskontrolle/phases.jsonl` | `b546701d612b84533bf65d2dca3df7c19c77603414acc8f0113073a53ecbc5b2` |
| `fixtures/acht-kacheln/vor-flusskontrolle/probe.txt` | `6b78f73c6e007cfb84ef52d9f5f75e23970263cb44566dfbf05468d5e1750ef7` |
| `fixtures/acht-kacheln/vor-flusskontrolle/starts.txt` | `71d8f3e63e438426bdebd2b3054adf188eed7057b4370a7147a6ed8bcce058fe` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N1-L2-after.txt` | `ebeea33348b7139ddeb06357bea038f838bb5e703eee1a46d629903385aaeb1d` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N1-L2-before.txt` | `ab9c7ec02e9caea4d20a9140cdbb5aada37588b1b6650465062683b7b2634d62` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N4-L1-after.txt` | `a51479ccaf5bec2e61d1da3b777b0cf66d3bf969d3c97fab6d10d98d8bacfffc` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N4-L1-before.txt` | `e32a7c3480e5f9af9354c120e3f5fc12da2a7c50e52fb96f080548db7c8b0119` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N4-L2-after.txt` | `5e8611b6a6796171e6bb517bce68cecd4577d4574f3dec28753c74151a739b41` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N4-L2-before.txt` | `77d47f63e6018397047a4d19cd90841cebf0e7e5fce03996ab4ba8a049a108b4` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N6-L1-after.txt` | `db91f774da0f50949e3d02ac5c3c0d7fbe1d0af6ca2cd1a836b604553c0069a1` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N6-L1-before.txt` | `504fb7637cf3739af0749a78e1cb868fc14d055056ea6a337d970a5db13dfd6e` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N8-L1-after.txt` | `2f1ee9d7636f2fb260a4190319a9776fbc73c6c08b3f1d0960f435e4664a885a` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N8-L1-before.txt` | `8ca04d0b96ca44ce9ff47ae1d9eeb9e68c4ad90c24b1a9a16714863f7ec610e5` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N8-L2-after.txt` | `97686d1f6edd526ccc9c4da5db456490a079e42c338851cf58715c7028846aa8` |
| `fixtures/acht-kacheln/vor-flusskontrolle/vm-N8-L2-before.txt` | `bcc71483324de3fcd4fe15ad38c6d73fdd332d6413863bf3962927ab32886d9c` |
| `fixtures/acht-kacheln/werkzeuge/abnahme.mjs` | `88a2957a1220a0077a091ad36e3ca63db8955f0c48f991bd607973b950318efd` |
| `fixtures/acht-kacheln/werkzeuge/abnahme.ps1` | `38ca1b3c4c7945316ccfca654818dc4b5adc908ced1b8f378632b6d85fc8e462` |
| `fixtures/acht-kacheln/werkzeuge/ana-self.mjs` | `f68b63fe121916fdb8a056fbdaa1094fd065bff7b554337e5dc4bc97d9247ebd` |
| `fixtures/acht-kacheln/werkzeuge/ana.mjs` | `832620301c1fee14fbe5c28ba94362dc134ab43e1227398988f434656615c4df` |
| `fixtures/acht-kacheln/werkzeuge/build.ps1` | `69cab7f1d79308603305925a30cec0810b2986446ffae18b128f4f0ff0ba09dc` |
| `fixtures/acht-kacheln/werkzeuge/clock.mjs` | `098f11d12ffd88ea856177d4aa97025fe103292548094e4831b2bd365239a02f` |
| `fixtures/acht-kacheln/werkzeuge/devtools.ps1` | `801233ed83294c9cc2962958857f18e713766353313cf476f8610c41d07771db` |
| `fixtures/acht-kacheln/werkzeuge/gc.mjs` | `4c5febbce7b003a0ee0e5db99503bdfee9f15614a7d87cfdc259f53e249f80c9` |
| `fixtures/acht-kacheln/werkzeuge/hook.js` | `e023b3a1a64c36d89027576a61f0d8c2fb176d07de380fdd2ac736c4d5872b9d` |
| `fixtures/acht-kacheln/werkzeuge/mem.ps1` | `3e97df938fda63f1bf32e68bf15687c62dd3c12e1f59cb603b1d0eb6b64a04a4` |
| `fixtures/acht-kacheln/werkzeuge/raf.mjs` | `acd6f472c08fdfcbd045b9257af0ee41090bfb0df3dbeacab5b92d5e60e43507` |
| `fixtures/acht-kacheln/werkzeuge/run.ps1` | `7a85658a130256ff697a709f41188308a3656ae64f5993ea92dba52c7cc8f807` |
| `fixtures/acht-kacheln/werkzeuge/sampler.mjs` | `ee27b110a072a26d5da59297439ffcdd2921540a846d92948d16ce937ff46ff7` |
| `fixtures/acht-kacheln/werkzeuge/serie.ps1` | `22b46fd7fca1f8bd0705f74dd5906154c53d6a07b85b91c47ea667c1002fdf59` |
| `fixtures/acht-kacheln/werkzeuge/start.ps1` | `c23fd4532a3077b116c45618eea100447fee57fc251a2af1765890e1fcc070fc` |
| `fixtures/acht-kacheln/werkzeuge/stop.ps1` | `243355f0d97dab24b3e1de30213bd1c787db82d647643015c35ba67aa31953a5` |
| `fixtures/acht-kacheln/werkzeuge/tabellen.mjs` | `a39f8cfe2e3da176fdf5906616f14ae8f9de1d7c04e36ab711f2ccdbd780ab2e` |
| `fixtures/acht-kacheln/werkzeuge/vm.ps1` | `fd1b7b8081478344d650bc7af95f5b89b850ebe8a0e54ff49325f8e8a2dd211d` |
| `fixtures/acht-kacheln/werkzeuge/vm.sh` | `0836327d7b0b2ac5638ed927ac8c98511e4307cf728f575de8930a840e86d565` |
| `fixtures/acht-kacheln/werkzeuge/win.ps1` | `dddfc0b309adf55a7576e295d43a20083a3fa38545a3d63d5e06ca6379fe12d7` |
| `fixtures/acht-kacheln/win.jsonl` | `1abce764a2b6dbd08f28fb86471e05cc54586dd937edd4384e280245ffe7db90` |

**Für die Veröffentlichung neutralisiert:** Der Bericht selbst nannte keine
Labordaten. In den Werkzeugen `vm.ps1`, `clock.mjs` und `abnahme.ps1` stehen
Adresse und Benutzer der Test-VM als `192.0.2.20` und `u` und der Profilpfad im
lokalen Schlüsselpfad als `C:\Users\U`, in `vm.sh` die Adresse im
Kopfkommentar; in `build.txt` steht der Bauordner im Scratchpad der Sitzung als
`<Scratchpad>`. Die Hashes dieser fünf Dateien in der Tabelle gelten für die
neutralisierten Fassungen; die Originale unterscheiden sich nur in diesen
Stellen. Alle übrigen Rohdaten und Werkzeuge sind unverändert.
