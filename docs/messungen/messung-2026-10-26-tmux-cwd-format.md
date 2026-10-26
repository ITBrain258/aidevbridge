# Messung: `#` im Startordner von `new-session -c`

Stand 2026-10-26. `BindingQuery::create_command` gab den Startordner einer
neuen Session unverändert an `tmux new-session -c`, und tmux wertet dieses
Argument als Format aus. Gemessen mit `cwd-format-measure.sh` auf tmux 3.4
(`/usr/bin/tmux`, Ubuntu-Paket 3.4-1ubuntu0.2) und auf 3.0a, 3.3a und 3.6,
gebaut aus den Release-Tarballs (SHA-256 in `quellen.txt`): privater Socket
über einen relativen Pfad (`-S ./s`), keine Konfiguration (`-f /dev/null`),
nach jedem Fall `kill-server` und Socket entfernt. `cwd-format-job-count.sh`
zählt zusätzlich, wie oft der Ordner `#(touch MARK)` den Befehl ausführt.
Rohdaten unter `fixtures/tmux-cwd-format-2026-10-26/`.

## Ergebnis

1. tmux wertet das rohe `-c`-Argument zweimal unabhängig voneinander als
   Format aus: für den Ordner der Session (`#{session_path}`) und, wieder aus
   dem rohen Argument, für den der ersten Pane (`#{pane_current_path}`).
   Gemessen ab 3.3a; 3.0a hat kein `#{session_path}`, dort zeigt es nur der
   Quelltext. Genau eine Verdopplung ist deshalb richtig.
   Roh führte der Ordner `#(touch MARK)` auf jeder Version den Befehl aus;
   `C#Project`, `A#{session_name}B` und `D####Q` starteten die Pane still in
   einem anderen Ordner.
2. Jedes `#` verdoppelt ergibt den Ordner wörtlich und führt nichts aus, mit
   einer Ausnahme ab 3.3a: Eine Folge aus mindestens zwei `#` direkt vor `[`
   ist eine Stilmarke und bleibt stehen (`E##[x]` bleibt `E##[x]`, die Pane
   startet woanders). 3.0a kennt die Stilmarke nicht und halbiert auch diese
   Folge. Ein einzelnes `#` vor `[` ist überall schon roh wörtlich.
3. Die App verdoppelt deshalb jede `#`-Folge außer einer direkt vor `[`
   (`escape_cwd_format` in `session_binding.rs`). Diese Form ergab auf 3.3a,
   3.4 und 3.6 in allen acht Fällen den Ordner wörtlich, für Session und
   Pane, auf 3.0a in sieben: `F##[x]` startete dort im Home-Ordner, wie roh
   auch. Für `##[` ist keine Schreibweise auf allen Versionen wörtlich; die
   gewählte ist es ab 3.3a und lässt 3.0a beim bisherigen Verhalten.
4. Die verdoppelte Form und die App-Form führten in keiner Version etwas aus
   (MARK in 0 von 10 Läufen je Version, `job-zaehlung.txt`). Roh entstand
   MARK nur in einem Teil der Läufe: 3.0a 1, 3.3a 5, 3.4 9, 3.6 7 von 10.
   tmux hängt den Job an den Client, der `new-session` schickt, und beendet
   ihn, wenn dieser Client geht (`format_lost_client`); mit `-d` geht er
   sofort, und `touch` gewinnt das Rennen nicht immer. Deshalb steht in den
   Tabellen bei roh teils „nein“. Dass roh ein Job läuft, zeigt auch
   `#{session_path}`: `#(touch MARK)` wird dort durch die leere Ausgabe des
   Jobs ersetzt.

## tmux 3.4 und 3.6

`d/` ist der Messordner, „Home“ der Rückfall von tmux auf `$HOME`. Die
Ausgaben beider Versionen sind gleich bis auf MARK in der rohen Form
(Ergebnis 4).

| Ordner | roh: Session | roh: Pane | roh: MARK 3.4 / 3.6 | App-Form für `-c` | App: Session und Pane |
| --- | --- | --- | --- | --- | --- |
| `#(touch MARK)` | `d/` | `d` | ja / nein | `##(touch MARK)` | wörtlich, kein MARK |
| `C#Project` | `d/Croject` | Home | nein | `C##Project` | wörtlich |
| `A#{session_name}B` | `d/AB` | Home | nein | `A##{session_name}B` | wörtlich |
| `trail#` | `d/trail#` | `d/trail#` | nein | `trail##` | wörtlich |
| `D####Q` | `d/D##Q` | Home | nein | `D########Q` | wörtlich |
| `E#[x]` | `d/E#[x]` | `d/E#[x]` | nein | `E#[x]` | wörtlich |
| `F##[x]` | `d/F##[x]` | `d/F##[x]` | nein | `F##[x]` | wörtlich |
| `G#(touch MARK)#[y]` | `d/G#[y]` | Home | ja / nein | `G##(touch MARK)#[y]` | wörtlich, kein MARK |

Jedes `#` ohne Ausnahme verdoppelt war in den ersten fünf Fällen ebenso
wörtlich. Bei `E#[x]`, `F##[x]` und `G…#[y]` blieb `##[` bzw. `####[`
stehen, die Pane startete im Home-Ordner; MARK entstand auch dort nicht.

## tmux 3.3a

Wie 3.4, nur bleibt eine Pane, deren Ordner fehlt, im Ordner des
Serverprozesses (in der Messung das Arbeitsverzeichnis, „Server“) statt im
Home-Ordner: `spawn.c:392` prüft `find_home() != NULL || chdir(…)` und ruft
`chdir` deshalb nie auf.

| Ordner | roh: Session | roh: Pane | roh: MARK | App: Session und Pane |
| --- | --- | --- | --- | --- |
| `#(touch MARK)` | `d/` | `d` | ja | wörtlich, kein MARK |
| `C#Project` | `d/Croject` | Server | nein | wörtlich |
| `A#{session_name}B` | `d/AB` | Server | nein | wörtlich |
| `trail#` | `d/trail#` | `d/trail#` | nein | wörtlich |
| `D####Q` | `d/D##Q` | Server | nein | wörtlich |
| `E#[x]` | `d/E#[x]` | `d/E#[x]` | nein | wörtlich |
| `F##[x]` | `d/F##[x]` | `d/F##[x]` | nein | wörtlich |
| `G#(touch MARK)#[y]` | `d/G#[y]` | Server | nein | wörtlich, kein MARK |

Verdoppelt wie auf 3.4: wörtlich bis auf `E#[x]`, `F##[x]` und `G…#[y]`,
deren Pane im Ordner des Servers startete.

## tmux 3.0a

3.0a kennt `#{session_path}` nicht (`display -p` gibt eine leere Zeile), es
bleibt der Ordner der Pane. MARK entstand in diesem Lauf in keinem Fall, roh
nur in 1 von 10 Läufen der Zählung.

| Ordner | roh: Pane | verdoppelt: Pane | App: Pane |
| --- | --- | --- | --- |
| `#(touch MARK)` | Home | wörtlich | wörtlich |
| `C#Project` | Home | wörtlich | wörtlich |
| `A#{session_name}B` | Home | wörtlich | wörtlich |
| `trail#` | wörtlich | wörtlich | wörtlich |
| `D####Q` | Home | wörtlich | wörtlich |
| `E#[x]` | wörtlich | wörtlich | wörtlich |
| `F##[x]` | Home | wörtlich | Home |
| `G#(touch MARK)#[y]` | Home | wörtlich | wörtlich |

## Quelltext

Aus den Release-Tarballs, Zeilen in `quellen.txt`:

| Stelle | 3.0a | 3.3a | 3.6 |
| --- | --- | --- | --- |
| Session: `format_single` auf `args_get(args, 'c')` | `cmd-new-session.c:156` | `:167` | `:167` |
| Pane: rohes Argument in `sc.cwd` | `cmd-new-session.c:268` | `:290` | `:290` |
| Pane: `format_single(item, sc->cwd, …)` | `spawn.c:282` | `spawn.c:229` | `spawn.c:230` |
| `##` ergibt `#` (`format_expand1`) | `format.c:1956` | `format.c:4701` | `format.c:5601` |
| `##…[` bleibt Stilmarke | fehlt | `format.c:4703` | `format.c:5603` |
| Job endet mit dem Client (`format_lost_client`) | `format.c:401` | `format.c:456` | `format.c:472` |

https://github.com/tmux/tmux/blob/3.0a/cmd-new-session.c,
https://github.com/tmux/tmux/blob/3.6/spawn.c,
https://github.com/tmux/tmux/blob/3.6/format.c (jeweils auch für die anderen
Tags).

## Rohdaten

| Datei | Inhalt |
| --- | --- |
| `cwd-format-measure.sh` | Messskript, Formen roh, verdoppelt und App |
| `cwd-format-job-count.sh` | Zählt MARK für `#(touch MARK)` über n Läufe, roh und App |
| `ausgabe-3.0a.txt`, `ausgabe-3.3a.txt`, `ausgabe-3.4.txt`, `ausgabe-3.6.txt` | Ausgabe je Version, Messordner durch `<W>` ersetzt |
| `job-zaehlung.txt` | Ausgabe von `cwd-format-job-count.sh` mit n = 10 auf allen vier Versionen |
| `quellen.txt` | Quelltextstellen aus 3.0a, 3.3a und 3.6 mit SHA-256 der Tarballs |
