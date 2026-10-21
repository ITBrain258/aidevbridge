# Messung 2026-09-14: Terminaltitel als Statusquelle

Frage: Zeigen Agents außer Claude Code ihren Zustand im Terminaltitel, den
tmux je Pane als `pane_title` hält? Nur gelesen; auf dem Host wurde nichts
installiert, konfiguriert oder geschrieben.

**Aufbau:** Host test-vm (192.0.2.20), tmux 3.4, Socket `agentbridge`. Der
Auftraggeber hat jeden Agent von Hand in einer eigenen AgentBridge-Session
gestartet und bedient: Aufgaben gestellt, Rückfragen über das
Ask-Question-Werkzeug beantwortet und Freigaben erteilt, soweit ein Agent
welche verlangte. Ein lesender Sampler hat von 13:32 bis 13:57 jede Sekunde
`#{pane_id}`, `#{pane_current_command}` und `#{pane_title}` aller Panes
protokolliert. Die Prozessbäume stammen aus `/proc/<pid>/task/*/children`
und `/proc/<pid>/comm`, ebenfalls nur gelesen.

Codex hat sich um 13:36:29 mitten in der Messung selbst aktualisiert
(Paketdatum, danach `codex-cli 0.154.0`). Der Ruhetitel vor 13:36 stammt
von der Vorgängerversion; alle Zustandsbeobachtungen unten stammen von
0.154.0.

Das Rohprotokoll bleibt außerhalb des Repos, weil es die Texte des
Auftraggebers enthält. Unten stehen Threadnamen, Chattitel und Fragen als
Platzhalter (`<thread>`, `<chat>`, `<Frage>`); `<project>` ist der
Projektname, den Codex anzeigt.

## Ergebnis je Agent

| Agent | Version | Unter der Pane-Shell | Titelsignal |
|---|---|---|---|
| Claude Code | 2.1.27x | `claude` (Helfer `node`) | nicht ausgewertet; Quelle bleibt `claude agents --json` |
| Codex | 0.154.0 | `node` → `codex` | ja |
| Grok | 1.0.30 | `grok` (Helfer `node`) | ja |
| agy | 1.2.2 | `agy` | nein, der Titel bleibt der Hostname |
| OpenCode | nicht erfasst | `opencode` | nein, der Titel bleibt `OpenCode` |
| Gemini CLI | – | – | auf keiner der beiden VMs installiert, nicht gemessen |

Spinner sind Braille-Zeichen (U+2800 bis U+28FF); gesehen wurden
⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧.

### Codex 0.154.0

| Beobachteter Zustand | Titel |
|---|---|
| Freigabe offen, Ask-Frage offen (dreimal) | `[ ! ] Action Required \| <thread> \| <project>`, im Sekundentakt wechselnd mit `[ . ] Action Required \| …`; auch während einer Umbenennung: `[ ! ] Action Required \| renaming... ⠼ \| <project>` |
| arbeitet | `<spinner> <thread> \| <project>`, `<spinner> renaming... <spinner> \| <project>`, vor dem ersten Thread `<spinner> <project>` |
| bereit | `<thread> \| <project>`, vor dem ersten Thread nur `<project>` |
| Selbstupdate | während des Updates leerer Titel, danach Pane-Kommando wieder `bash` |
| Neustart | sofort `<spinner> <project>`, dann `<project>` |

Die Formen decken sich mit dem Quelltext von 0.154.0
(`codex-rs/tui/src/chatwidget/status_surfaces.rs`): Voreinstellung
`activity`, `thread-name`, `project-name`, Trennzeichen ` | `. Der Spinner
(`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) erscheint nur bei laufender Aufgabe oder beim Start der
MCP-Server und nur mit `tui.animations`; „Action Required“ nur mit dem
Aktivitätselement. Mit `tui.animations = false` oder eigenem
`tui.terminal_title` fehlt der Spinner.

### Grok 1.0.30

| Beobachteter Zustand | Titel |
|---|---|
| Ask-Frage offen (dreimal) | `<spinner> - Running: Ask: <Frage, gekürzt>… - <chat> - grok` |
| arbeitet | `<spinner> - Waiting for response… - <chat> - grok`, `<spinner> - Thinking - <chat> - grok`, `<spinner> - Responding - <chat> - grok` |
| bereit | `<chat> - grok` |

In dieser Messung verlangte Grok keine Freigabe; andere `Running:`-Werkzeuge
als `Ask` kamen nicht vor. Die
[Messung vom 05.09.](messung-2026-09-05-statussignale.md) mit Grok 1.0.13
zeigte bei offener Freigabe
`⚠ Action Required - <spinner> - <Schritt>… - <chat> - grok` und bei langen
Shell-Befehlen, die Grok in den Hintergrund schiebt, zeitweise den
Ruhetitel. Das 1.0.30-Binary enthält „Action Required“ und „Compacting“
weiterhin.

## Regeln in AgentBridge

- Der Titel zählt nur, solange das Agentprogramm unter der Pane-Shell
  läuft: als Kind, bei Codex über npm als Enkel unter `node`. Ein alter
  Titel überlebt das Agentende also nicht. Zwei verschiedene Agents auf
  einer Ebene ergeben keine Zuordnung.
- **Codex:** `[ ! ]`/`[ . ] Action Required` ergibt wartet, Spinner vorn
  ergibt arbeitet, `<thread> | <project>` ergibt bereit. Ein bloßer Name
  ergibt unbekannt, weil tmux (Hostname) oder eine Shell ihn ebenso setzen
  könnten; ein frisch gestartetes Codex ohne Thread bleibt deshalb
  unbekannt. Mit `tui.animations = false` oder eigenem `tui.terminal_title`
  fehlt der Spinner, ein arbeitendes Codex erschiene dann bereit; die
  Bindung an diese Einstellungen ist offen.
- **Grok:** `⚠ Action Required - … - grok` (Freigabe) und Spinner mit
  `Running: Ask:` ergeben wartet; Spinner mit `Thinking`, `Responding`,
  `Waiting for response…` oder einem anderen `Running:` ergibt arbeitet;
  `<chat> - grok` ohne Spinner ergibt bereit. Ein Titel mit
  „Action Required“ ergibt nie bereit. Läuft ein langer Befehl im
  Hintergrund, zeigt Grok zeitweise den Ruhetitel; AgentBridge zeigt dann
  bereit.
- Jede andere Titelform ergibt unbekannt. agy und OpenCode zeigen
  unbekannt mit dem Grund, dass ihr Titel keinen Status trägt.
- Claude Code bleibt bei `claude agents --json`; eine gebundene
  Claude-Zeile hat Vorrang vor jedem Titel.

Kosten: ein zusätzlicher lesender Befehl je Poll und je Listenabruf, egal
wie viele Sessions laufen. Darin je Session ein `tmux display-message` für
die aktive Pane und die Programmnamen aus `/proc/<pid>/comm` der Kinder und
Enkel der Pane-Shell. Keine Kommandozeilen, keine Umgebungen.
