# Messung: `;` am Ende des Startordners von `new-session -c`

Stand 2026-11-16. `BindingQuery::create_command` gibt den Startordner einer
neuen Session als eigenes Argument an `tmux new-session -c`, gefolgt vom
Trenner `;` und `set -g exit-empty on`. tmux liest ein Argument, das auf `;`
endet, selbst als Trenner. Gemessen mit `cwd-semicolon-measure.sh` auf zwei
Testhosts mit tmux 3.3a und tmux 3.6, so wie es dort installiert ist: je Fall
ein eigener Socket (`abtest_semicolon_<n>`), keine Konfiguration
(`-f /dev/null`), eine Sekunde Pause vor dem Ablesen, danach `kill-server`.
Ordner und Sockets entfernt das Skript am Ende wieder („left over: 0“).
Rohdaten unter `fixtures/tmux-cwd-semikolon-2026-11-16/`; `<W>` steht dort für
den Arbeitsordner der Messung, `<HOME>` für den Home-Ordner des Testkontos.

## Ergebnis

Beide Versionen verhielten sich in allen acht Fällen gleich; die zwei
Ausgaben unterscheiden sich nur in der Versionszeile.

| Fall | Ordner | Argument von `-c` | Pane startet in | Ordner der Session |
|---|---|---|---|---|
| 1 | `job;` | `job;` | `job` | `job` |
| 2 | `job;` | `job\;` | `job;` | `job;` |
| 3 | `a;b` | `a;b` | `a;b` | `a;b` |
| 4 | `back\;` | `back\;` | Home-Ordner | `back;` |
| 5 | `back\;` | `back\\;` | `back\;` | `back\;` |
| 6 | `two;;` | `two;;` | Home-Ordner | `two;` |
| 7 | `two;;` | `two;\;` | `two;;` | `two;;` |
| 8 | `job` (Kontrolle) | `job` | `job` | `job` |

1. Ein Startordner, der auf `;` endet, kommt roh nicht an. tmux nimmt das
   letzte `;` als Trenner und verwendet den Rest: Die Session startet in
   einem anderen Ordner (Fall 1, es gab ihn), oder die Pane fällt auf den
   Home-Ordner zurück (Fälle 4 und 6, es gab ihn nicht). tmux meldet in
   keinem Fall einen Fehler, `new-session` endet mit 0.
2. Ein `;` innerhalb des Namens ist wörtlich (Fall 3).
3. Ein Backslash vor dem letzten `;` ergab in allen drei Fällen den Ordner
   wörtlich, für Session und Pane (Fälle 2, 5 und 7).
4. Einen Befehl kann der Name auf diesem Weg nicht einschleusen. Das ist
   aus der Argumentform gelesen, nicht gemessen: Der Name ist ein einziges
   Argument, tmux trennt nur an dessen Ende, und danach folgt der Trenner
   der App, kein Text aus dem Namen.

## Was die App daraus macht

Die App lehnt einen Startordner, der auf `;` endet, beim Anlegen ab und sagt
warum (`start_directory_ends_in_separator` und
`START_DIRECTORY_SEPARATOR_RULE` in `session_binding.rs`; die Prüfung steht in
`create_session_impl` vor dem ersten Befehl an den Host). Das ist der kleinste
Schritt aus der neutralen Bewertung vom 15.11. Er hängt nicht davon ab, wie
eine tmux-Version das Argument liest.

Der Backslash aus Punkt 3 wäre der andere Weg. Er ist nicht gebaut: Für tmux
3.0a und 3.4 fehlt die Messung, und das Argument läuft zusätzlich durch die
Verdopplung der `#` (`escape_cwd_format`). Ein Ordner mit `;` im Namen bleibt
erlaubt; der Live-Test `a_hash_in_the_start_directory_stays_literal` legt
`a;b` an.

## Nicht gemessen

- tmux 3.0a und 3.4. Auf den Testhosts ließ sich tmux nicht aus den Quellen
  bauen (die Header von libevent fehlen dort), und der Runner der CI führt
  dieses Skript nicht aus.
- Die Rust-Funktion selbst für einen Ordner mit `;` am Ende: Die App lehnt
  ihn ab, bevor ein Befehl entsteht. Das Skript bildet die Argumentform der
  App nach.
- Mehr als die fünf Ordnernamen der Tabelle.
