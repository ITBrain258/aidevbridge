# tmux-Framing: reale Gegenproben vom 8. September 2026

Gemessen auf der freigegebenen Test-VM `u@192.0.2.20`, **tmux 3.4**, am
2026-09-08 zwischen 14:28:40 und 14:32:44 UTC. SSH verwendete
`StrictHostKeyChecking=yes`, `BatchMode=yes` und `ConnectTimeout=5`.
Der erste Sandboxversuch scheiterte vor dem Verbindungsaufbau; die Messungen
liefen anschließend regulär eskaliert. Jeder Lauf erhielt ein eigenes
`mktemp`-Verzeichnis unter `/tmp/abtest-codex-framing-20260908-*`, einen
absoluten `-S`-Socket darin und `-f /dev/null`. Keine Produkt-Sockets,
Benutzerkonfigurationen oder Installationen wurden verändert.

**tmux 3.0 wurde nicht ausgeführt.** Diese Gegenproben geben keinen vollständigen
Framingcodec frei und ersetzen keine Messung der Mindestversion.

## Lebender Server ohne Sessions

Der Server wurde mit `start-server ; set-option -s exit-empty off` gestartet.
`show-options -sv exit-empty` bestätigte `off` mit Exit 0. Danach, noch vor
der ersten Session:

| Abfrage | Exit | stdout, als JSON-String dargestellt | stderr |
|---|---:|---|---|
| `list-sessions -F '#{session_id}'` | 0 | `""` | leer |
| `display-message -p '#{pid}\|#{start_time}'` | 0 | `"1576037\|1788877720\n"` | leer |
| `list-panes -a -F '#{session_id}\|#{pane_id}'` | 1 | `""` | `no current target` + LF |

Der reale Leerfall ist somit weder ein fehlender Server noch ein erfolgreicher
leerer `list-panes`-Snapshot. Die Parser-/Abfragelogik muss ihn gesondert
belegen. Eine pauschale Übernahme von `no current target` in die NoServer-Liste
wäre falsch. Der erfolgreiche Metadatenaufruf in 3.4 beweist dieses Verhalten
nicht für 3.0.

## Titelvalidierung und q:-Format

Ein direkter `/bin/sleep 60`-Prozess hielt die eigene Session `probe` offen;
`pane_current_command` bestätigte `sleep`. Als Baseline wurde der Titel
`baseline\omega` gesetzt. Anschließend wurde genau dieser synthetische Wert
übergeben (JSON-Schreibweise): `"alpha\nbeta\rgamma\tdelta\\omega"`.

`select-pane -T` meldete **Exit 0, leeres stdout und stderr**, übernahm diesen
Titel aber nicht: Der ausgelesene Titel blieb `baseline\omega`. Die tmux-3.4-
Implementierung verwirft Titel mit diesen Kontrollzeichen in
[`screen_set_title`](https://raw.githubusercontent.com/tmux/tmux/3.4/screen.c);
[`utf8_isvalid`](https://raw.githubusercontent.com/tmux/tmux/3.4/utf8.c) schließt
ASCII unter 0x20 aus. Der Aufrufer meldet die Ablehnung nicht als Fehler.
Es wurde daher **keine erfolgreiche LF/CR/Tab-Injektion in `pane_title`** gemessen.

Damit `q:` trotzdem auf die synthetischen Bytes angewandt wird, wurde derselbe
Wert in der ausschließlich eigenen Sessionoption `@ab_framing_probe` gespeichert.
Alle folgenden Leseabfragen hatten Exit 0 und leeres stderr. stdout wurde direkt
in Dateien geschrieben und danach Base64-kodiert; die Auswertung kürzte keine
Zeilenumbrüche:

| Abfrage | stdout in Base64 |
|---|---|
| `#{pane_title}` vor und nach dem abgelehnten Kontrollzeichentitel | `YmFzZWxpbmVcb21lZ2EK` |
| `#{q:pane_title}` für die Baseline | `YmFzZWxpbmVcXG9tZWdhCg==` |
| `#{@ab_framing_probe}` | `YWxwaGEKYmV0YVxyZ2FtbWEJZGVsdGFcb21lZ2EK` |
| `#{q:@ab_framing_probe}` | `YWxwaGEKYmV0YVxyZ2FtbWEJZGVsdGFcXG9tZWdhCg==` |

Der letzte Wert dekodiert zu `"alpha\nbeta\\rgamma\tdelta\\\\omega\n"`
in JSON-Schreibweise: **LF und Tab bleiben echte Kontrollzeichen.** q: ist
damit auch im realen 3.4-Lauf kein Einzeilen-Framing. CR erscheint bereits
ohne q: als die zwei Zeichen `\r`. Passend dazu verwendet
[`server_client_print`](https://raw.githubusercontent.com/tmux/tmux/3.4/server-client.c)
`VIS_OCTAL|VIS_CSTYLE|VIS_NOSLASH`. Base64 nach `display-message` grenzt eine
einzelne Antwort sicher ab, beweist aber noch keine reversible Abbildung der
ursprünglichen Metadatenbytes; tmux-Ausgabeescaping muss zum Vertrag gehören.

## Reproduzierbare Kernbefehle

Folgender POSIX-sh-Ablauf zeigt die verwendeten Abfragen. Jeder `probe`-Aufruf
erfasst den Exitstatus vor dem Kodieren. Die Leerfallmessung und die abschließende
Titelmessung liefen tatsächlich in getrennten Verzeichnissen; für eine
Wiederholung können sie in dieser Reihenfolge denselben neuen Testserver nutzen.

```sh
unset TMUX TMUX_PANE
probe_dir=$(mktemp -d /tmp/abtest-codex-framing-20260908-XXXXXX) || exit 1
socket="$probe_dir/tmux.sock"
tm() { env LC_ALL=C tmux -u -S "$socket" -f /dev/null "$@"; }
probe() {
  label=$1
  shift
  tm "$@" >"$probe_dir/stdout" 2>"$probe_dir/stderr"
  code=$?
  printf '%s exit=%s\nstdout_base64=' "$label" "$code"
  base64 <"$probe_dir/stdout" | tr -d '\n'
  printf '\nstderr_base64='
  base64 <"$probe_dir/stderr" | tr -d '\n'
  printf '\n'
}
tm start-server ';' set-option -s exit-empty off
probe option show-options -sv exit-empty
probe sessions list-sessions -F '#{session_id}'
probe metadata display-message -p '#{pid}|#{start_time}'
probe panes list-panes -a -F '#{session_id}|#{pane_id}'
tm new-session -d -s probe /bin/sleep 60
server_pid=$(tm display-message -p -t '=probe:' '#{pid}')
pane_pid=$(tm display-message -p -t '=probe:' '#{pane_pid}')
baseline=$(printf 'baseline\\omega')
tm select-pane -t '=probe:' -T "$baseline"
probe baseline display-message -p -t '=probe:' '#{pane_title}'
probe baseline_q display-message -p -t '=probe:' '#{q:pane_title}'
title=$(printf 'alpha\nbeta\rgamma\tdelta\\omega')
probe set_title select-pane -t '=probe:' -T "$title"
probe retained_title display-message -p -t '=probe:' '#{pane_title}'
tm set-option -t '=probe:' @ab_framing_probe "$title"
probe raw display-message -p -t '=probe:' '#{@ab_framing_probe}'
probe quoted display-message -p -t '=probe:' '#{q:@ab_framing_probe}'
tm kill-server
```

Die ausgeführten Messskripte hatten zusätzlich einen Cleanup-Trap: ausschließlich
diesen Server stoppen, seine vorher gelesenen PIDs prüfen, eine anschließende
Abfrage auf den fehlenden Server verifizieren und erst dann die eigenen
bekannten Dateien samt Socket mit `rm -f` und das Verzeichnis mit `rmdir`
entfernen. Es gab keine rekursive Löschung und kein PID-basiertes Kill-Kommando.

## Bestätigter Cleanup

| Eigenes Verzeichnis-Suffix | Nachweis |
|---|---|
| `twM3nL` | Erster Cleanup hielt wegen des zurückbleibenden Socketfiles an. Gezielte Folgeprüfung: Server-PID 1576037 nicht vorhanden, `list-sessions` Exit 1 mit exakt `no server running on <eigener Socket>` und leerem stdout; Socket und Verzeichnis danach entfernt. |
| `Fnelhs` | `kill-server` Exit 0; Server-PID 1579119 und Pane-PID 1579122 anschließend nicht vorhanden; fehlender Server bestätigt; Socket und Verzeichnis entfernt. |
| `UKfbp2` | `kill-server` Exit 0; Server-PID 1580369 und Pane-PID 1580370 anschließend nicht vorhanden; fehlender Server bestätigt; Socket und Verzeichnis entfernt. |

Die ersten beiden Titelversuche lieferten noch den alten Titel und sind kein
positiver Framingnachweis. Die abschließende Baseline-/Optionsmessung oben ist
der relevante Nachweis. Alle angelegten Testserver und temporären Verzeichnisse
sind entfernt. Produktcode und tmux-3.0-Installation blieben unverändert.
