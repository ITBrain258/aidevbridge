# Messung: `#` im Startordner von `new-session -c`

Stand 2026-10-26. `BindingQuery::create_command` gab den Startordner einer
neuen Session unverändert an `tmux new-session -c`, und tmux wertet dieses
Argument als Format aus. Gemessen auf tmux 3.4 (`/usr/bin/tmux`,
Ubuntu-Paket 3.4-1ubuntu0.2) mit `cwd-format-measure.sh`: privater Socket
über einen relativen Pfad (`-S ./s`), keine Konfiguration (`-f /dev/null`),
nach jedem Fall `kill-server` und Socket entfernt. tmux 3.0a, 3.3a und 3.6
sind **nicht gemessen**: Diese Umgebung gab das Bauen aus den
Release-Tarballs nicht frei. Für sie ist nur der Quelltext gelesen (unten).
Rohdaten unter `fixtures/tmux-cwd-format-2026-10-26/`.

## Ergebnis

1. tmux wertet das rohe `-c`-Argument zweimal unabhängig voneinander als
   Format aus: für den Ordner der Session (`#{session_path}`) und, wieder aus
   dem rohen Argument, für den der ersten Pane (`#{pane_current_path}`).
   Genau eine Verdopplung ist deshalb richtig. Der Ordner `#(touch MARK)`
   führte den Befehl aus; `C#Project`, `A#{session_name}B` und `D####Q`
   starteten still im Home-Ordner.
2. Jedes `#` verdoppelt ergibt den Ordner wörtlich und führt nichts aus, mit
   einer Ausnahme: Eine Folge aus mindestens zwei `#` direkt vor `[` ist eine
   Stilmarke und bleibt stehen (`E##[x]` bleibt `E##[x]`, die Pane startet im
   Home-Ordner). Ein einzelnes `#` vor `[` ist schon roh wörtlich.
3. Die App verdoppelt deshalb jede `#`-Folge außer einer direkt vor `[`
   (`escape_cwd_format` in `session_binding.rs`). Diese Form ergab in allen
   acht Fällen den Ordner wörtlich, für Session und Pane, und kein MARK.
4. Im Quelltext von 3.0a, 3.3a und 3.6 laufen beide Auswertungen genauso, und
   `##` ergibt `#`. Die Stilmarke steht in 3.3a und 3.6, nicht in 3.0a: Dort
   halbiert tmux eine Folge aus mindestens zwei `#` vor `[`, `F##[x]` startete
   auf 3.0a also im Home-Ordner. Ausgeführt wird in keiner Version etwas,
   denn jede andere `#`-Folge hat gerade Länge, und eine Folge vor `[` bildet
   kein `#(`, `#{` oder `#X`.

## tmux 3.4

`d/` ist der Messordner, „Home“ der Rückfall von tmux auf `$HOME`.

| Ordner | roh: Session | roh: Pane | roh: MARK | App-Form für `-c` | App: Session und Pane |
| --- | --- | --- | --- | --- | --- |
| `#(touch MARK)` | `d/` | `d` | ja | `##(touch MARK)` | wörtlich, kein MARK |
| `C#Project` | `d/Croject` | Home | nein | `C##Project` | wörtlich |
| `A#{session_name}B` | `d/AB` | Home | nein | `A##{session_name}B` | wörtlich |
| `trail#` | `d/trail#` | `d/trail#` | nein | `trail##` | wörtlich |
| `D####Q` | `d/D##Q` | Home | nein | `D########Q` | wörtlich |
| `E#[x]` | `d/E#[x]` | `d/E#[x]` | nein | `E#[x]` | wörtlich |
| `F##[x]` | `d/F##[x]` | `d/F##[x]` | nein | `F##[x]` | wörtlich |
| `G#(touch MARK)#[y]` | `d/G#[y]` | Home | ja | `G##(touch MARK)#[y]` | wörtlich, kein MARK |

Jedes `#` ohne Ausnahme verdoppelt war in den ersten fünf Fällen ebenso
wörtlich. Bei `E#[x]`, `F##[x]` und `G…#[y]` blieb `##[` bzw. `####[`
stehen, die Pane startete im Home-Ordner; MARK entstand auch dort nicht.

## Quelltext

Aus den Release-Tarballs, Zeilen in `quellen.txt`:

| Stelle | 3.0a | 3.3a | 3.6 |
| --- | --- | --- | --- |
| Session: `format_single` auf `args_get(args, 'c')` | `cmd-new-session.c:156` | `:167` | `:167` |
| Pane: rohes Argument in `sc.cwd` | `cmd-new-session.c:268` | `:290` | `:290` |
| Pane: `format_single(item, sc->cwd, …)` | `spawn.c:282` | `spawn.c:229` | `spawn.c:230` |
| `##` ergibt `#` (`format_expand1`) | `format.c:1956` | `format.c:4701` | `format.c:5601` |
| `##…[` bleibt Stilmarke | fehlt | `format.c:4703` | `format.c:5603` |

https://github.com/tmux/tmux/blob/3.0a/cmd-new-session.c,
https://github.com/tmux/tmux/blob/3.6/spawn.c,
https://github.com/tmux/tmux/blob/3.6/format.c (jeweils auch für die anderen
Tags).

Offen: die Messung auf 3.0a, 3.3a und 3.6 mit einem aus dem Tarball gebauten
tmux (`bash cwd-format-measure.sh <tmux> <leerer Ordner>`). Erwartet wie
oben, auf 3.0a zusätzlich `F##[x]` in der App-Form im Home-Ordner.

## Rohdaten

| Datei | Inhalt |
| --- | --- |
| `cwd-format-measure.sh` | Messskript, Formen roh, verdoppelt und App |
| `ausgabe-3.4.txt` | Ausgabe auf tmux 3.4, Messordner durch `<W>` ersetzt |
| `quellen.txt` | Quelltextstellen aus 3.0a, 3.3a und 3.6 mit SHA-256 der Tarballs |
