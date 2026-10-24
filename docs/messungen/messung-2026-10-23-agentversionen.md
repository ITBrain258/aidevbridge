# Messung 2026-10-23: Claude Code und Codex in aktuellen Versionen

Frage: Gelten die gemessenen Statusformen für die aktuellen Versionen von
Claude Code und Codex noch, und was ändert sich an der Titelquelle? Grok
bleibt auf Wunsch des Maintainers vorerst außen vor. Auf den Hosts wurde nur
gelesen; was die Agents selbst geändert haben, steht unter „Eingriffe“.

**Aufbau:** zwei eigene Test-VMs, 192.0.2.10 (Debian 12, tmux 3.3a) und
192.0.2.20 (Ubuntu 26.04.1, tmux 3.6), Platzhalter nach RFC 5737 wie in der
[Handabnahme](../abnahme-handarbeit.md). Eigener Socket
`abtest_20261023_mess`, je Agent eine Session in `/tmp`. Die Agents wurden
per `tmux send-keys` gestartet und bedient, wie von Hand in der Pane-Shell.
Ein lesender Sampler hat alle rund 0,25 s (mit `claude agents --json` alle
0,5 bis 0,7 s) den Panetitel, den Prozessbaum unter der Pane-Shell
(`/proc/<pid>/comm` und `/proc/<pid>/exe`), die Claude-Zeilen und den
Bildschirm protokolliert, jeweils bei Änderung.

| VM | Claude Code | Codex |
|---|---|---|
| 192.0.2.10 | 2.1.309 (Installer) | 0.162.1, während der Messung 0.164.0 (npm, global im Home) |
| 192.0.2.20 | 2.1.309 (Installer) | 0.163.0 (npm unter nvm) |

Neueste Versionen am Messtag laut npm: Claude Code 2.1.309, Codex 0.164.0.

**Nur für diese Sitzungen gesetzt**, ohne Einfluss auf Titelform und
JSON-Vokabular:

- Codex mit `-m gpt-6-luna`: Das eingestellte Modell der VMs nimmt das
  angemeldete ChatGPT-Konto nicht an (Fehler 400), der Thread lief trotzdem
  an.
- Codex auf 192.0.2.10 mit `-a on-request`: Ohne diese Option lehnte die
  Sandbox-Regel des Kontos jede Freigabe selbst ab, es kam keine Rückfrage.
- Claude mit `--model haiku --permission-mode default`: Die Voreinstellung
  der VMs ist der Auto-Modus, der Befehle ohne Rückfrage freigibt.

**Eingriffe:** Codex 0.162.1 auf 192.0.2.10 bot beim Start ein Update an.
Die erste Eingabe bestätigte es, und Codex aktualisierte sich per
`npm install -g @openai/codex` auf 0.164.0. Auf 192.0.2.10 war `/tmp` für
Claude noch nicht als vertraut eingetragen; der Dialog wurde bestätigt
(Eintrag in `~/.claude.json`). Die Probedateien (`/tmp/m1-claude-probe*`,
`/var/tmp/m1-codex-probe.txt`) sind gelöscht, Socket und Sessions beendet.

Rohdaten bereinigt unter
[`fixtures/agentversionen-2026-10-23/`](fixtures/agentversionen-2026-10-23/):
Hostnamen als `<host>`, Home als `~`, Claude-Zeilen nur mit `pid`, `kind`,
`status` und `waitingFor`, Bildschirme nur als Marke `V <ts> prompt`, wenn
eine Rückfrage sichtbar wurde. Dort auch Sampler, Abfrage, Auswertung und
Bereinigung (`werkzeuge/`).

## Claude Code 2.1.309

Auf 192.0.2.20 nach Schritt 1 des M1-Tors, auf 192.0.2.10 eine Kurzprobe
(Freigabe, Arbeit, Ende):

| Ablauf | `claude agents --json` der Pane |
|---|---|
| Start | eine Lesung ohne `status`, danach `idle` |
| Auftrag | `busy` |
| Freigabe offen | `waiting`, `waitingFor: "permission prompt"` |
| freigegeben, `sleep 20` läuft | `busy`, danach `idle` |
| abgelehnt („No“) | `idle` |
| freigegeben, Esc während der Arbeit | `busy`, dann `idle` |
| Frage über AskUserQuestion offen | `waiting`, `waitingFor: "input needed"` |
| nach `/exit` | keine Zeile mehr |

- **Felder:** wie gemessen, `pid`, `cwd`, `kind`, `startedAt`, `sessionId`,
  `name`, `status`, bei `waiting` dazu `waitingFor`. Hintergrundzeilen tragen
  `state` (etwa `blocked`) und teils keine `pid`; sie bleiben ungenutzt.
- **Bindung:** Der Claude-Prozess ist das direkte Kind der Pane-Shell, auf
  tmux 3.3a wie auf 3.6. `comm` ist `claude`, `exe`
  `~/.local/share/claude/versions/2.1.309`.
- **Verzögerung:** In allen vier Rückfragen stand `waiting` in derselben
  Abtastung in der JSON-Ausgabe, in der die Rückfrage auf dem Bildschirm
  erschien, also unter 0,7 s.
- **Start:** Die erste Lesung nach dem Start zeigte die interaktive Zeile
  ohne `status`. Die App zeigt dafür einen Poll lang „Unknown“ mit dem Grund
  „claude reported an unrecognized status“.
- **Vokabular:** Das Bundle von 2.1.309 kennt als `waitingFor` „permission
  prompt“, „input needed“, „sandbox request“, „worker request“, „dialog
  open“ und neu „goal proposal“. Es ordnet „goal proposal“ wie „permission
  prompt“ als Freigabe ein. Gemessen sind „permission prompt“ und „input
  needed“; „goal proposal“ ist nur aus dem Bundle gelesen.
- **Freigabe im Tor:** `sleep 20 && echo fertig` führt 2.1.309 auch im
  manuellen Modus ohne Rückfrage aus, weil es harmlose Befehle selbst
  freigibt. Eine Rückfrage kam erst mit einem schreibenden Befehl
  (`sleep 20 && touch /tmp/m1-claude-probe && echo fertig`).

## Codex 0.163.0 und 0.164.0

| Beobachteter Zustand | Titel |
|---|---|
| vor dem ersten Thread | `tmp` (nur der Projektname) |
| Start, MCP-Server | `<spinner> tmp` |
| arbeitet | `<spinner> <thread> \| tmp` |
| arbeitet, Thread bekommt seinen Namen (nur 0.163.0) | `<spinner> <spinner> \| tmp`, `<spinner> \| tmp` |
| Freigabe offen | `[ ! ] Action Required \| <thread> \| tmp`, im Sekundentakt wechselnd mit `[ . ] Action Required \| …`, bis zur Antwort |
| Frage über das Frage-Werkzeug offen | dieselbe Form; die Frage schloss sich nach rund 2 s von selbst |
| bereit, auch nach Freigabe und nach Ablehnung | `<thread> \| tmp` |
| nach `/quit` | leerer Titel, Pane-Kommando wieder `bash` |

`<thread>` war hier der von Codex selbst vergebene Threadname („Run
command“, „Request approval for probe file“), `tmp` der Projektname.

- **Prozessbaum:** `node` (`/usr/bin/node` oder die nvm-Version) als Kind
  der Pane-Shell, darunter das native Programm
  `…/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
  Während des Selbstupdates zeigte `exe` des laufenden Programms kurz in den
  Zwischenordner `…/@openai/.codex-ywMJpJyc/…`; der Dateiname blieb `codex`.
- **Quelltext:** `codex-rs/tui/src/chatwidget/status_surfaces.rs` von
  0.154.0 und 0.164.0 verglichen. Unverändert: die Voreinstellung
  `activity`, `thread-name`, `project-name`, die Trennzeichen (` ` nach dem
  Spinner, sonst ` | `), die Spinnerbilder und beide „Action
  Required“-Präfixe. Neu sind die Einstellungen `tui.effects.progress` (ohne
  sie kein Spinner) und `tui.effects.title` (ohne sie blinkt „Action
  Required“ nicht, steht aber). Ebenfalls neu: das Mikrofonzeichen „●“ vor
  dem ganzen Titel, solange das Mikrofon hört. Die Fortschrittsanzeige
  „renaming...“ beim Benennen des Threads ist entfallen. Den Spinner
  schalten außerdem ab: `tui.animations = false`, das Codex bei einem
  erkannten Bildschirmleser selbst in die `config.toml` schreibt, und die
  Einstellung „reduzierte Bewegung“ des Desktops (Portal
  `org.freedesktop.appearance`).
- **Einstellungen der VMs:** In `[tui]` stehen nur
  `screen_reader_detection_done` und `[tui.model_availability_nux]`, also
  die Voreinstellung für den Titel. `/etc/codex/config.toml` gibt es nicht.

## Folgen für aidevbridge

- **Keine feste Versionsbindung** (Entscheidung des Maintainers vom 23.10.):
  Die Formen werden gegen die jeweils neueste Version gemessen. Jede Version
  zählt, solange ihre Ausgabe eine gemessene Form hat; jede andere Form
  ergibt weiter „Unknown“. Eine Version im Tooltip gibt es nicht: Claude
  nennt sie nur über den Programmpfad, Codex gar nicht billig.
- **„goal proposal“** ergibt wartet.
- **Identität über `/proc/<pid>/exe`:** Der Agent einer Pane gilt über den
  Dateinamen seines Programms statt über `comm`, den ein Prozess selbst
  setzen kann (ein Skript namens `codex` hat `comm` `codex`, aber die Shell
  als `exe`). Claude Codes Installer ruft eine Datei mit der Version als
  Namen auf; ein Pfad in `…/claude/versions/` gilt deshalb als Claude. Ein
  ersetztes Programm (`… (deleted)`) zählt weiter, ebenso agy 1.4.6, das
  sich beim Start selbst ersetzt und aus `agy.<Ziffern>.old` weiterläuft
  (gesehen im [M1-Tor](messung-2026-10-23-m1-tor.md)).
- **Grenzen:** Titel bis 1024 Byte, Programmpfade bis 4096 Byte, je
  Einstellungsdatei bis 16384 Byte nach dem Filter. Was länger ist, wird
  verworfen; ein zu langer Titel ergibt „Unknown“.
- **Codex-Einstellungen:** Nur solange unter einer Pane Codex läuft, liest
  derselbe Befehl `/etc/codex/config.toml` und
  `${CODEX_HOME:-$HOME/.codex}/config.toml`, gefiltert auf die
  `tui`-Schlüssel. Die Datei mit höherer Priorität überschreibt Schlüssel
  für Schlüssel. Ohne Spinner (`tui.animations` oder `tui.effects.progress`
  aus) zählt nur „Action Required“ als wartet, alles andere ergibt
  „Unknown“. Eigene Titelelemente (`tui.terminal_title`, außer der
  Voreinstellung, auch mit `spinner` statt `activity`) ergeben „Unknown“,
  eine unlesbare oder zu große Datei ebenso. Nicht gelesen: Projektdateien
  (`.codex/config.toml`), `-c`-Optionen, Profile und die reduzierte Bewegung
  des Desktops. Dort kann ein arbeitendes Codex weiter als bereit
  erscheinen.
- **Mikrofonzeichen:** Ein Codex-Titel mit „●“ vorn oder mit „Action
  Required“ ergibt nie bereit; gemessen ist die Form mit „●“ nicht.
- Der Socket geht dem Lesebefehl weiterhin als Argument zu, nie als Teil
  des Skripttexts.

## VM-Test mit Attrappen

`src-tauri/tests/integration_status_title.rs` startet auf einem eigenen
Socket fünf Panes mit gesetztem Titel und prüft Lesebefehl und Parser
zusammen:

- eine Kopie der Shell unter dem Namen `codex`;
- `node` und `codex` als Kopien wie bei npm;
- einen Codex-Titel ohne Agent darunter;
- einen Titel über 1024 Byte;
- ein Shellskript namens `codex`.

Danach legt er eine `config.toml` mit `tui.animations = false` und einem
Geheimnis in `[mcp_servers.x.env]` an. Am 23.10. bestanden auf 192.0.2.20
(tmux 3.6) und 192.0.2.10 (tmux 3.3a), beide mit `mawk`; das Geheimnis
verließ den Host nicht. Eine Kopie von `sleep` taugt dort nicht als
Attrappe: Unter Ubuntu 26.04 ist `sleep` ein Name des Multicall-Programms
`coreutils`, das unter dem Namen `codex` mit „unknown program“ abbricht.

## Nicht gemessen

- Grok (ausgelassen), die Programmpfade von agy und OpenCode (agy liegt auf
  beiden VMs als `~/.local/bin/agy`; OpenCodes Pfad ist angenommen).
- Codex aus dem Release-Archiv: Heißt das Programm dort noch
  `codex-x86_64-unknown-linux-musl`, erkennt die App es nicht, wie schon
  über `comm`.
- Claude Code über npm: `exe` ist dann `node`, die Titelquelle erkennt
  keinen Claude. Der Claude-Status selbst kommt aus `claude agents --json`
  und ist davon nicht berührt.
- „goal proposal“ ausgelöst, Codex mit Mikrofon, Codex mit Einstellungen
  abseits der Voreinstellung an einem echten Codex (nur mit Attrappe).
