# tmux 3.6: Messung vom 11. Oktober 2026

Auf **tmux 3.6** (Ubuntu 26.04.1, Paket `tmux 3.6a-2ubuntu0.1`) liefern das
numerische Inventar, die Sessionbindung, die bestätigte Öffnung (W/J) und der
Titelbefehl dieselben Klassen und Formen wie auf 3.4. Die Messung mit den
bytegenauen Produktbefehlen auf eigenen Testsockets besteht **53 von 53
Prüfungen**. Daraus folgt die Zulassung von `MeasuredVersion::V3_6`, und zwar
**nur für die exakte Ausgabe `tmux 3.6\n`**, sowie ein weiteres bekanntes
Client-Flag. Das ist **keine Freigabe von 3.5, 3.5a oder eines unverändert
gebauten Upstream-3.6a** (siehe „Nicht zugelassen“). Die Anforderung steht in
der [UX-Spec, §12](../specs/2026-10-11-ux-ueberarbeitung-design.md).

## Umgebung und Ressourcen

- Testhost `u@192.0.2.20` (Hostname test-vm), **Ubuntu 26.04.1 LTS**, Kernel
  7.0.0-38-generic, UID 1000. SSH ausschließlich mit der bestehenden
  Testanmeldung (Benutzer `u`).
- Paket **`tmux 3.6a-2ubuntu0.1`**: Sicherheitsupdate für CVE-2026-11623
  (Use-after-free in `image_free`, `image.c`), laut `changelog.Debian.gz` des
  Pakets. `/usr/bin/tmux`, 1 213 112 Bytes, SHA-256
  `3bdeba4db61fa25e569e5d1ca6466acfd193018c7bbc2bc924ec415ffa0c2e58`. Das
  Binary enthält das Versionstoken `3.6` einmal NUL-begrenzt und kein `3.6a`.
  `tmux -V` liefert die Bytes `74 6d 75 78 20 33 2e 36 0a` (`tmux 3.6\n`), mit
  leerem stderr und Exit 0.
- `~/.tmux.conf` enthält nur `set -g mouse on` und `set -g history-limit 50000`.
  Sie wurde nur gelesen. Die SSH-Exec-Umgebung hat `LANG=en_US.UTF-8`, kein
  `TMUX*` und `SHELL=/bin/bash`.
- Das Messskript `measure_tmux36.py` (SHA-256
  `f985195a240a00f2c8298f077a3c04fc9699a63863bda382723379e48baaf9c1`) lief per
  `ssh … python3 -I -` über stdin, ohne Datei auf der VM. Lauf am
  **11.10.2026 um 10:09:37 UTC**, Dauer 12,7 s, 246 JSONL-Datensätze, SSH-Exit
  **0**, stderr leer. Die Rohdaten `raw-measure.jsonl` (SHA-256
  `bbc0c3e36f78ef2098d836c2ad0bb839a096963a89d30869fd341b2d08f9559b`) liegen
  samt Mess- und Auswerteskript unter `fixtures/m1-tmux-inventory/` mit dem
  Präfix `2026-10-11-tmux36-`; daraus ist der Fixture-Auszug abgeleitet (siehe
  „Cleanup und Belege“).
- **Sockets:** ausschließlich eigene. Eine Sperre im Skript verweigert jeden
  anderen tmux-Socket.
  - `abtest_ux36_5`: Inventarmatrix wie bei der 3.4-Messung vom 12.09.
    (`-f /dev/null`, `LC_ALL=C`, `TMUX*` entfernt), adressiert als
    `-S /tmp/tmux-1000/abtest_ux36_5`, der Datei, die auch `-L abtest_ux36_5`
    ableitet. Am Ende derselbe bestätigte Öffnungsablauf als Referenz ohne
    Konfiguration.
  - `abtest_ux36_1`: der Produktablauf. Die Befehlszeilen sind bytegleich zu
    `remote::build` (base64-Präludium) und laufen über `bash -c` wie bei sshd.
    Der Server liest die Standardkonfiguration wie in der App: `prepare_server`,
    `create`, `observe_sessions` (L/R/I/R/L), Titelskript, Guards, Umbenennung,
    Ersatz, bestätigte Öffnung, Serverende.
- **Panes:** `sleep` oder ein kleines `sh → python3`, das sich per `prctl` in
  `codex` bzw. `grok` umbenennt und per OSC 2 einen gemessenen Agent-Titel
  setzt. Es wurde kein Agent und keine interaktive Shell gestartet; die
  Shell-History blieb unberührt.
- **Konstanten:** Alle 16 Produktkonstanten (Formate, WRAPPER, PROCESS,
  DETAILS_SCRIPT, SOCKET_PATH_SCRIPT, Guard-Literal) sind maschinell bytegleich
  gegen den Rust-Quelltext (Stand vom 15.09.2026) geprüft: `compare_constants.py`,
  Ergebnis ALL MATCH.
- **Auswertung:** `analyze_tmux36.py` bildet die Parser getreu in Python nach
  (`parse_numeric`, `validate_inventory`, `classify` aus `inventory.rs`;
  `session_binding.rs`; `attach_confirmation.rs`; `status/title.rs`; die
  ServerAbsent-Logik aus `client.rs`). Bewusst ohne Cargo-Lauf; die echten
  Rust-Parser laufen erst mit dieser Änderung gegen die Fixture und die
  Live-Suiten (siehe unten).

## Gemessene Befehle

Die lesenden Produktbefehle haben die Form `env LC_ALL=C tmux -u -L <s> …` bzw.
`-S <pfad>`; Anlegen und `prepare_server` rufen `tmux -L <s> …` ohne `env` und
`-u` auf. `<s>` ist der eigene Socket, `$n/@n/%n` stehen für numerische IDs.

Inventar (DirectDisplay-Hülle, Matrix mit `-f /dev/null`):

```sh
env LC_ALL=C tmux -u -S "$S" -f /dev/null \
  display-message -p 'B|#{pid}|#{start_time}' ';' \
  list-sessions -F 'Q|#{session_id}|#{session_windows}' ';' \
  if-shell -F '#{session_id}' \
    "list-panes -a -F 'P|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{window_active}|#{pane_active}|#{pane_dead}|#{alternate_on}|#{session_attached}|#{window_activity}|#{window_bell_flag}|#{window_panes}'" ';' \
  display-message -p 'E|#{pid}|#{start_time}'
```

Die Zeilen L, R, C, S, J stammen aus `session_binding.rs` und
`attach_confirmation.rs`:

| Zeile | Befehl, Format |
|---|---|
| L | `list-sessions -F 'L\|#{pid}\|#{start_time}\|#{session_id}\|#{session_name}'` |
| R | `list-windows -t '$n' -F 'R\|#{pid}\|#{start_time}\|#{session_id}\|#{window_id}\|#{pane_id}\|#{pane_pid}\|#{window_active}\|#{session_windows}'` |
| C | `new-session -d -P -F 'C\|#{pid}\|#{start_time}\|#{session_id}\|#{window_id}\|#{pane_id}\|#{pane_pid}' -s <name> -c /tmp ; set -g exit-empty on` |
| S | `display-message -p -t '$n' -F 'S\|#{pid}\|#{start_time}\|#{session_id}\|#{socket_path}'`, mit `-L` und mit `-S` |
| J | `list-clients -F 'J\|#{pid}\|#{start_time}\|#{client_pid}\|#{client_created}\|#{session_id}\|#{window_id}\|#{pane_id}\|#{pane_pid}\|#{window_active}\|#{pane_active}\|#{pane_dead}\|#{client_control_mode}\|#{client_readonly}\|#{client_tty}\|#{client_uid}\|#{client_flags}'` |

Reihenfolge, Trennzeichen und leere Felder: L-Zeilen sowie Q- und P-Blöcke
kommen nach Sessionnamen sortiert, wie in den 3.4-Fixtures. Die Parser hängen
von der Reihenfolge nur über „Q vor P“ ab, und das gilt. Das Trennzeichen ist
überall `|`. Kein numerisches Feld ist leer (`client_uid` ist belegt,
`client_flags` nicht leer). stdout endet jeweils mit genau einem `\n`, ohne `\r`
und ohne Leerzeilen.

| Messgegenstand | Ausgabe tmux 3.6 | Vergleich mit 3.4 |
|---|---|---|
| `tmux -V` | `tmux 3.6\n`, stderr leer, Exit 0 | nur der String weicht ab (`tmux 3.4\n`) |
| Inventar DirectDisplay, 28 Matrixfälle | z. B. `B\|684702\|1791713377\nQ\|$0\|1\nP\|$0\|@0\|%0\|684709\|1\|1\|0\|0\|0\|1791713377\|0\|1\nE\|684702\|1791713377\n` | **gleich:** 28/28 gleiche Klasse (20 Snapshot, 6 NoServer, 2 TmuxError), 28/28 gleiche Form (Zahlen maskiert) |
| Inventar ConservativelyGuarded (benannt und `-S`) | wie DirectDisplay: 14 Sessions, 16 Panes; leerer Server `B\|…\nE\|…\n` | gleich; `list-commands` ohne Argument überspringt leere Zeilen weiter |
| Inventar, Socket abwesend | Exit 1, `error connecting to <pfad> (No such file or directory)\n`; Socket danach weiter abwesend | gleich, NoServer |
| Inventar nach `kill-server` | Exit 1, `no server running on <pfad>\n`; Socketdatei bleibt liegen | gleich, NoServer |
| `list-panes -a` auf leerem Server | Exit 1, `no current target\n` | gleich |
| Teilfehler (`B`; `list-panes -t %999999999`; `E`) | Exit 1, stdout `B\|…\n`, stderr `can't find pane: %999999999\n` | gleich, TmuxError |
| L (14 Sessions) | `L\|685669\|1791713381\|$0\|ab_ux36_codex` …, nach Namen sortiert | gleiche Form |
| R | `R\|…\|$3\|@3\|%15\|687912\|1\|2`; alte ID: `can't find session: $8\n`; leerer Server: `no current target\n` | gleich |
| C | `C\|685669\|1791713381\|$0\|@0\|%0\|686327\n`; Duplikat Exit 1 `duplicate session: ab_ux36_plain\n` | gleich |
| `prepare_server` (vier Befehle) | alle Exit 0; danach `history-limit` 10000, `mouse` on, `exit-empty` off, `remain-on-exit` on, `allow-set-title` on | wie erwartet; `~/.tmux.conf` wirkt nur über `mouse` |
| Guard Kill falsch (falsche PID, falsche Startzeit, fehlende ID, leerer Server) | `AB_M1_REJECT\n`, Exit 0, stderr leer | gleich |
| Guard Kill wahr | Exit 0, leer, die Session fehlt danach in L | gleich |
| Guard Attach falsch / wahr ohne PTY | `AB_M1_REJECT\n` Exit 0 / Exit 1 `open terminal failed: not a terminal\n` | gleich |
| S | `S\|685669\|1791713381\|$0\|/tmp/tmux-1000/abtest_ux36_1\n`, mit `-L` und `-S` identisch | gleich, SocketBinding OK |
| W (WRAPPER in PTY, `TERM=xterm-256color`, 120×30) | `W\|<nonce>\|690464\|8043793\|1000\|34824\|/dev/pts/8\r\n` | gleiche Form |
| P | `P\|690464\|8043793\|1000\|34824\|/dev/pts/8\|R\n` | gleiche Form |
| J | `J\|685669\|1791713381\|690464\|1791713389\|$0\|@0\|%0\|686327\|1\|1\|0\|0\|0\|/dev/pts/8\|1000\|attached,focused,UTF-8\n`, mit und ohne `~/.tmux.conf`; registriert im ersten Versuch | **gleich:** 17 Felder, gleiche Flags |
| Bestätigung L/R/I/R/L nach dem Anhängen | `Bound`, `selected == binding`, `session_attached` 1; nach `detach-client` Exit 0, J leer | gleich |
| Titelskript (`DETAILS_SCRIPT`, `display-message -p -t %n '#{pane_title}'`) | bytegenau: `⠸ thread \| home`, `⠴ - Thinking - chat - grok`, `⚠ Action Required - ⠧ - step… - chat - grok`, sonst `test-vm`; C-Zeilen `codex`/`grok` | gleiches Verfahren, Standardtitel Hostname; Status Busy, Busy, Waiting; tote Pane Ended |
| Abwesenheit benannt: L auf fehlendem bzw. inertem Socket plus `SOCKET_PATH_SCRIPT` | `error connecting to /tmp/tmux-1000/abtest_ux36_1 (No such file or directory)\n` bzw. `no server running on …\n`; Vorhersage `S\|/tmp/tmux-1000/abtest_ux36_1\n` | gleich, die ServerAbsent-Bedingung ist erfüllt |
| Name-Kill `kill-session -t =<name>`, fehlend / inert | `can't find session: ab_ux36_nosuch\n` / `no server running on …\n` | gleich, idempotent |
| `select-pane -T` mit LF/CR/TAB; eigene Option mit LF/TAB | Titel nicht übernommen; Option roh `Q\|$999\|1\nP\|fake\tend\n` | gleich |
| Steuerzeichen in eigener Option (ESC, 0x01, CR, DEL) per `display-message -p` | roh: `a\x1bb\x01c\rd\x7fe\n` | **abweichend:** unter 3.4 vis-escapt, siehe unten |

Umbenennung und Ersatz unter gleichem Namen: Die Umbenennung ergibt
`ListingChanged`, der Ersatz `CreationMismatch`, und die alte ID wird mit
`can't find session` abgewiesen.

## Ergebnis der Auswertung

**53 von 53 Prüfungen bestanden** (`analysis-results.txt`, Schlusszeile
`ALL OK`):

| Gruppe | Prüfungen |
|---|---|
| Version: exakte Ausgabe, das Tor vor dieser Änderung lehnt ab, ein Arm `tmux 3.6\n` würde annehmen, Binary-Identität | 4 |
| Inventarmatrix: 28/28 gleiche Klasse, 28/28 gleiche Form | 2 |
| Ausgabeformen: Steuerzeichen roh, Titel-Steuerzeichen und LF/TAB-Option wie 3.4 | 3 |
| Abwesenheit: ServerAbsent bei fehlendem und inertem Socket, tolerante Namenswege, benannter Socket ist im Klassifizierer kein NoServer, die Proben starteten nichts | 10 |
| Leerer Server: Inventar, Guard-Kill, Resolve | 3 |
| Anlegen: neun Sessions mit C-Zeile, Ersatz, Duplikat, fehlender Name | 12 |
| Beobachtung: Snapshot 14 Sessions / 16 Panes, bewachte gleich direkte Hülle, 14 von 14 `Bound`, tote Pane, Mehr-Window-Resolve | 5 |
| Titel: Statuspipeline und Standardtitel | 2 |
| Guards: argv gleich Builder, falsche Guards lehnen ab, wahrer Guard tötet, Attach ohne PTY | 4 |
| Name-Kill idempotent | 1 |
| Umbenennung und Ersatz | 2 |
| Bestätigte Öffnung auf Produkt- und Matrixsocket | 2 |
| Fremde Sessionnamen: Parse und Anzeige | 2 |
| J-Form gleich 3.4 | 1 |

## Entscheidung

- **`MeasuredVersion::V3_6`** kommt hinzu, **nur für die exakte Ausgabe
  `tmux 3.6\n`** (Exit 0, stderr leer). Sie wird überall wie `V3_4`
  verarbeitet:
  - DirectDisplay-Hülle für das Inventar,
  - bestätigte Öffnung (W/J, `confirmable = true`),
  - Abwesenheitsbeweis (`server_proven_absent`; nur `V3_0` ist ausgenommen).
  Auf einem 3.6-Host erhält die App damit numerische Bindung und Status aus
  Titeln, statt der namensbasierten Liste mit Status „unknown“.
- **Bleiben bei „Unknown“:** `tmux 3.6a\n`, `tmux 3.5\n`, `tmux 3.5a\n` und
  `tmux 3.6\r\n`. Zulassen erst nach eigener Messung.
- **Neues Client-Flag:** `attach_confirmation.rs` kennt künftig auch
  `no-detach-on-destroy`. `list-clients` nennt alle Clients des Servers, auch
  fremde; ein unbekanntes Flag eines einzigen Clients ließe `parse_clients` die
  ganze Ausgabe als `Frame` ablehnen und damit jede bestätigte Öffnung auf dem
  Socket scheitern. Die Registrierungsregeln bleiben unverändert. Der eigene
  Wrapper setzt das Flag nie, und die Menge der als Modus abgelehnten Flags
  (`active-pane`, `suspended`, `read-only`, `control-mode`, `no-output`) wächst
  nicht. Die Schreibweise stammt aus `server_client_get_flags` im
  tmux-3.6-Quelltext; `pause-after=N` (Control-Clients, schon unter 3.4) bleibt
  wie bisher außerhalb der Liste.
- **Fixtures** aus dieser Messung: `tmux-3.6.json` und
  `2026-10-11-tmux-3.6.jsonl` unter `src-tauri/tests/fixtures/tmux-inventory/`.
  Eine Kopie der `.jsonl` liegt unter `docs/messungen/fixtures/m1-tmux-inventory/`.

## Abweichungen ohne Folgen für die App

- **Rohe statt maskierte Ausgabe.** Unter 3.4 lief jede `cmdq_print`-Ausgabe
  durch `utf8_stravisx(VIS_OCTAL|VIS_CSTYLE|VIS_NOSLASH)`, unter 3.6 ruft
  `cmdq_print` `server_client_print(parse=1)`, und es gibt keine
  vis-Kodierung mehr. Gemessen: ESC, 0x01, CR und DEL aus einer eigenen Option
  kommen roh an. Die App-Felder erreicht das nicht:
  - numerische Formate enthalten keine Steuerzeichen,
  - Sessionnamen sind schon beim Speichern escapt (`session_check_name`),
  - Panetitel lehnen Steuerzeichen ab und werden hex-transportiert,
  - `parse_list` und `payload` weisen Steuerbytes ohnehin als `InvalidFrame` ab.
- **Fremde Sessionnamen mit `\` oder `$` erscheinen anders.** Die numerische
  Bindung ist unberührt (alle `Bound`); App-eigene Namen (Allowlist `A-Z a-z
  0-9 _ -` und Leerzeichen) sind gleich.

  | angefordert | unter 3.4 gelistet | unter 3.6 gelistet | `has-session -t =angefordert` / `=gelistet` (3.6) |
  |---|---|---|---|
  | `prüfung`, ` edge ` | gleich | gleich | 0 |
  | `cash$back\slash\|semi;quote'#[x]` | `cash\\$back\\slash\|…` | `cash$back\\slash\|…` | 1 / **0** |
  | `back\$pair` | nicht gemessen | `back\\$pair` | 1 / 0 |
  | `$legacy` | `\$…` (`names.rs`) | `$legacy` | 1 (das `=$…` wird als ID gelesen) |

  Unter 3.4 fand der gelistete Wert die Session nicht
  ([Messung vom 12.09.](messung-2026-09-12-tmux-session-binding-initial.md)).
  Unter 3.6 findet ihn der Namensweg (`=gelistet`); das ist eher besser.
- **Neues Client-Flag** `no-detach-on-destroy` in `client_flags`: es erscheint
  nur auf ausdrückliche Anforderung (`attach -f …`, `refresh-client -f …`); die
  App setzt es nie. Siehe „Entscheidung“.
- **Nicht versionsspezifisch:** Auf einem lebenden Server ohne Sessions liefert
  `kill-session -t =name` den Text `no current target\n` statt `can't find
  session`. Das gilt schon unter 3.4 (`binding_empty_r`) und tritt nur kurz
  zwischen `prepare_server` und `create` auf.

## Quellenabgleich 3.4 bis 3.6a

Quellen: `CHANGES` und Quelltexte der Tags 3.4, 3.5, 3.5a, 3.6 und 3.6a
(raw GitHub).

**Unverändert 3.4 bis 3.6a** (bytegleich): `cmd-list-sessions.c`,
`cmd-list-windows.c`, `cmd-list-panes.c`, `cmd-list-clients.c`, `cmd-find.c`
(Fehlertexte), `cmd-kill-session.c`, `cmd-attach-session.c`. Alle 25 von der App
gelesenen Format-Callbacks sind textgleich (`compare_formats.py`: `pid`,
`start_time`, `session_*`, `window_*`, `pane_*`, `alternate_on`, `client_*`,
`socket_path`). Ebenfalls unverändert: `session_check_name`, `screen_set_title`,
`utf8_isvalid` (lehnt Zeichen unter 0x20 und DEL ab). In `client.c` sind die
Fehlertexte gleich; geändert ist nur das Protokoll (`MSG_IDENTIFY_LONGFLAGS`).

| Version | Änderung | Wirkung auf die App |
|---|---|---|
| 3.5 | `allow-set-title` neu (Standard on) | gemessen `on`; wer es abschaltet, verliert den Titelstatus (Unknown), ohne Fehlstatus |
| 3.5 | `command-error`-Hook | Fehlertexte gemessen unverändert |
| 3.5 / 3.5a | 3.5 nutzt `default-shell` für `#()`, `run-shell`, `if-shell`; 3.5a macht das rückgängig (`/bin/sh`) | die App nutzt nur `if-shell -F` (Format, keine Shell) |
| 3.6 | `list-commands` mit Argument zeigt nur einen Befehl | die App ruft ohne Argument auf; dieser Pfad ist unverändert, gemessen |
| 3.6 | `#?` mit else-if, `&&`/`\|\|` mit n Argumenten, `!`/`!!` | Guard- und B/E-Formate liefern gemessen identisch |
| 3.6 | Umstellung auf `getopt_long` | Hauptoptionen `-u -L/-S … -V` und Befehle gemessen in Ordnung |
| 3.6 | Client-Option `no-detach-on-destroy`, erscheint in `client_flags` | siehe „Entscheidung“ |
| 3.6 | ungültiges UTF-8 wird durch einen Platzhalter ersetzt | Titel bleiben über `utf8_isvalid` geschützt |
| 3.6 (nicht in `CHANGES`) | `cmdq_print` ohne vis-Kodierung | gemessen, siehe „Abweichungen“ |
| 3.6 (nicht in `CHANGES`) | Socketpfad: `realpath()` ist Pflicht (3.4 nahm bei einem Fehler den unaufgelösten Pfad) | `SOCKET_PATH_SCRIPT` nutzt `pwd -P`; die Vorhersage ist gemessen gleich |
| 3.6 | Protokoll (`MSG_IDENTIFY_LONGFLAGS`) | siehe „Betriebshinweis“ |
| 3.6a | Formatfix: Überlesen und Endlosschleife bei abschließendem `#` | kein App-Format endet auf `#` |

## Betriebshinweis

Das Debian-Paket warnt in `NEWS.Debian` (`tmux (3.6a-1)`, auf der VM unter
`/usr/share/doc/tmux/`): **Nach dem Upgrade auf 3.6 ist tmux ganz neu zu
starten.** Ein alter Server und ein neuer Client seien nicht voll kompatibel,
und der neue Client könne hängen. Für die App heißt das: Läuft auf einem Host
nach einem Upgrade noch ein Server von vor 3.6, laufen ihre Befehle gegen
diesen alten Server in das 15-Sekunden-Budget. Abhilfe laut Hinweis: tmux ganz
neu starten. Das beendet den alten Server samt seinen Sessions; solange man sie
noch braucht, erreicht der alte Client den alten Server über `/proc/<pid>/exe`.
Die Messung lief auf frisch gestarteten eigenen Servern und deckt diesen
Mischzustand nicht ab.

## Nicht zugelassen

- **`tmux 3.6a\n`.** Das Ubuntu-Paket 3.6a-2ubuntu0.1 meldet `tmux 3.6\n`. Das
  offizielle 3.6a-Tarball trägt dagegen `PACKAGE_VERSION=3.6a` ein: Builds aus
  dem unveränderten Tarball (Upstream, Arch, Homebrew, sofern unverändert gebaut)
  melden `tmux 3.6a\n`. Ein reines Upstream-3.6 meldet ebenfalls `tmux 3.6\n`;
  der einzige Formatfix von 3.6 nach 3.6a liegt nicht auf dem Pfad der
  App-Formate. Zulassen erst nach eigener Messung, z. B. mit einem privaten
  Upstream-Build und demselben Skript. Meldete eine spätere Revision des
  Ubuntu-Pakets `3.6a`, fiele 26.04 auf „Unknown“ zurück. Das ist
  fail-closed, also ohne falschen Status.
- **`tmux 3.5` und `tmux 3.5a`.** Auf 192.0.2.20 nicht messbar, weil dort nur
  3.6a installiert ist. Die Quellen liegen näher an 3.4 als an 3.6: alle von
  der App genutzten Befehlsquellen und die 25 Format-Callbacks sind gleich,
  `cmdq_print` ist noch vis-kodiert und der Socketpfad hat noch den Fallback.
  Weil Debian 13 und Ubuntu 25.04/25.10 3.5a liefern (nach unserem Kenntnisstand,
  hier nicht geprüft), wäre eine Messung per privatem Build wie bei 3.0
  ([Messung 3.0](messung-2026-09-12-tmux30-inventory.md)) der nächste Schritt.
  3.5 ohne „a“ (Regressionen, `default-shell` für `if-shell`) wird nicht
  angestrebt.
- **`tmux 3.6\r\n`** und jede andere Abweichung von der gemessenen Ausgabe.

## Cleanup und Belege

- Alle eigenen Server dieser Messung sind per `kill-server` beendet (Matrix-
  Generationen 684702, 684753, 684777, 684819 und der Produktserver 685669). Die
  Kontrolle danach fand keine Server-PID, keine Pane-PID und keine Fake-
  Kindprozesse (686350, 686475, 686608) mehr am Leben.
- Die Socketdateien `/tmp/tmux-1000/abtest_ux36_5` und `…_1` sind nach jedem
  Serverende gelöscht und am Ende abwesend. Die abschließende SSH-Kontrolle
  zeigte in `/tmp/tmux-1000/` nur `agentbridge`; `pgrep -af abtest_ux36` fand
  keinen tmux-Prozess.
- Der Socket `agentbridge` war **fremd**: Er entstand um 11:54 Uhr Ortszeit, nach
  der ersten Bestandsaufnahme (11:47, Verzeichnis leer) und vor dem Messlauf. Er
  wurde nicht adressiert und nicht verändert. 192.0.2.10 wurde nicht berührt;
  `default` und `agentbridge` wurden nie verwendet.
- Nichts installiert, keine Datei des Nutzers geändert.
- Alle Rohwerte sind eigene synthetische Metadaten, IDs und Zahlen oder
  begrenzte Befehlsdiagnosen, keine Nutzerprompts, Transcripts oder
  persönlichen Dateien.

| Artefakt | SHA-256 |
|---|---|
| [Fixture-Auszug](fixtures/m1-tmux-inventory/2026-10-11-tmux-3.6.jsonl), Kopie unter `src-tauri/tests/fixtures/tmux-inventory/` | `a3d0359d8c9ec4ce57b3e37d492e042f887104334bb4ef3f7458c7270b961f05` |
| Golden `src-tauri/tests/fixtures/tmux-inventory/tmux-3.6.json` | `529471e036c314b3626cee4bf5c98e17619ca888def4e78e318b351dbd3a0de3` |
| [Rohdaten](fixtures/m1-tmux-inventory/2026-10-11-tmux36-raw-measure.jsonl) (`raw-measure.jsonl`) | `bbc0c3e36f78ef2098d836c2ad0bb839a096963a89d30869fd341b2d08f9559b` |
| [Messskript](fixtures/m1-tmux-inventory/2026-10-11-tmux36-measure.py) (`measure_tmux36.py`) | `f985195a240a00f2c8298f077a3c04fc9699a63863bda382723379e48baaf9c1` |
| [Auswertung](fixtures/m1-tmux-inventory/2026-10-11-tmux36-analyze.py) (`analyze_tmux36.py`) | `35c570ac8fc02404702c078b867dd738292efcaedba670d55f95a4159e567abc` |
| [Ergebnis](fixtures/m1-tmux-inventory/2026-10-11-tmux36-analysis-results.txt) (`analysis-results.txt`) | Original mit CRLF `b05256e38c2ec3ff92a452fd39bbf781e41f0bfbb5d3c2a5baad679c362a98ce`; im Repository nach `eol=lf` `31fe1f2da9e1fb0fcfbb8e66da72899d658526b2fe8a288c018dbc0003d876c1` |

**Für die Veröffentlichung neutralisiert:** Adresse, Benutzer und Hostname der
Test-VM stehen in diesem Bericht und in seinen Belegen als `192.0.2.20`, `u` und
`test-vm`. In den Belegen betrifft das das Feld `host` in Rohdaten und
Fixture-Auszug (beide Kopien), den Standardtitel in den Rohdaten, den Docstring
des Messskripts und den erwarteten Standardtitel im Auswerteskript. Die Hashes
in diesem Bericht, auch die im Abschnitt „Umgebung und Ressourcen“ genannten von
Messskript und Rohdaten, gelten für diese Fassungen; die gelaufenen Originale
unterscheiden sich nur in diesen Platzhaltern. Das Auswerteskript erzeugt aus
den neutralisierten Rohdaten Fixture-Auszug, `tmux-3.6.json` und
`analysis-results.txt` bytegleich neu.

Der Fixture-Auszug entstand ohne neuen Befehl auf der VM aus den Rohdaten. Zeile
1 ist eine Notiz, Zeile 2 der Datensatz `inventory_measurement` mit allen
Befehlen der Matrix (Name, argv, Exitcode, Beendigung, EOF, stdout, stderr) und,
für die 28 Fälle, der `classification` im Format von
`m1-tmux-inventory.py::snapshot()`. `tmux-3.6.json` hat dieselben 28 Fälle in
derselben Reihenfolge wie `tmux-3.4.json`; `socket` ist
`/tmp/tmux-1000/abtest_ux36_5`. Zeilenenden sind LF (`.gitattributes`), der Hash
bezieht sich darauf. `accepted_measurements_and_query_arguments_remain_exact`
prüft Hash, Argumente, 28 Fälle, stdout/stderr/Exitcode gegen das Original,
Klassen und Snapshotdaten.

## Prüfung gegen die Produktsuiten (11.10.2026)

Mit `MeasuredVersion::V3_6` liefen die Rust-Tests und die Live-Suiten gegen
192.0.2.20 mit dem eigenen Testsocket `abtest_20261011_t5`
(`AGENTBRIDGE_TEST_HOST=192.0.2.20 AGENTBRIDGE_TEST_SOCKET=abtest_20261011_t5
cargo test --locked --manifest-path src-tauri/Cargo.toml --all --no-fail-fast`):

- **Lib-Tests und Fixture:** 477 bestanden, 0 fehlgeschlagen. Die 3.6-Fixture
  besteht mit den echten Rust-Parsern (Hash, Argumente, 28 Fälle, Klassen).
- **Live-Suiten:** `integration_commands` 20 von 20, `integration_tmux` 5 von 5
  (darunter `remain_on_exit_and_terminal_overrides_are_applied`),
  `integration_pty` 5 von 5, `integration_preflight` 1 von 1,
  `integration_transport` 8 von 8 (ein Test meldet SKIP, weil
  `AGENTBRIDGE_TEST_RSA_KEY` fehlt), dazu die hermetischen Suiten. Insgesamt 541
  bestanden, 0 fehlgeschlagen; 11 ignoriert (`acceptance_vm`, braucht
  `--ignored` und `AGENTBRIDGE_VM_HOST`).
- **Nachweis, dass der 3.6-Pfad wirkt:**
  `ending_the_last_session_by_its_numeric_identity_succeeds_and_lists_nothing`
  verlangt eine numerisch gebundene Zeile. Ohne den Arm `tmux 3.6\n` schlug der
  Test auf 192.0.2.20 fehl (`unverified: "unmeasured_tmux_version"`,
  `session_id: None`); mit dem Arm besteht er, einschließlich des Beendens der
  letzten Session und der danach leeren Liste über den Abwesenheitsbeweis.
- **`terminal-overrides` unter 3.6** (eigener Socket, die vier Befehle von
  `prepare_server`): Standardwert `terminal-overrides[0] linux*:AX@`; nach
  `set -ga terminal-overrides ',*:smcup@:rmcup@'` steht der Eintrag als
  `terminal-overrides[1] *:smcup@:rmcup@` dahinter, der Standard bleibt erhalten.
- **Flag-Schreibweise live:** Ein zweiter, mit `attach -f no-detach-on-destroy`
  angehängter Client erscheint in `list-clients` mit
  `attached,focused,no-detach-on-destroy`; ein gewöhnlicher Client mit
  `attached,focused`.

Eigene Sockets dieser Läufe: `abtest_20261011_t5*` unter `/tmp/tmux-1000/`; die
Server sind beendet und die Socketdateien gelöscht.

## Was diese Messung offen lässt

3.5 und 3.5a, ein unverändert gebautes Upstream-3.6a, der Mischzustand aus altem
Server und neuem Client, echte Agenten auf 3.6 (die Titel wurden mit
Stand-in-Panes gesetzt, die gemessene Titelformen ausgeben, kein Agent lief),
Last- und Latenzmessungen sowie Windows-UI-Verhalten. Die Messung ändert keine
Produktregel außer der Zulassung der exakten Ausgabe `tmux 3.6\n` und dem
zusätzlichen Client-Flag.
