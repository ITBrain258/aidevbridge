# agentbridge — Design

**Datum:** 2026-07-25
**Status:** Entwurf, Fassung 3 (Stack auf Rust/Tauri gewechselt)
**Arbeitstitel:** `agentbridge` (provisorisch)

---

## 1. Zweck

Eine Windows-Desktop-Anwendung, mit der eine Person mehrere Coding-Agents überwacht und
bedient, die in tmux-Sessions auf entfernten Linux-VMs laufen.

Das Problem, das sie löst, ist nicht "Terminal über SSH" — das können vorhandene Werkzeuge.
Es ist: **Bei sechs gleichzeitig laufenden Agents erkennen, welcher davon gerade auf eine
Antwort wartet**, ohne sechs Textströme parallel lesen zu müssen.

Die Anwendung wird als Open Source veröffentlicht und richtet sich an Windows-Nutzer, die
Agents auf eigenen VMs betreiben.

### Kernanforderungen

| # | Anforderung |
|---|---|
| A1 | Volle Terminal-Treue für interaktive TUIs: Alternate Screen, Maus-Events, Bracketed Paste, Truecolor, korrektes `SIGWINCH` |
| A2 | Persistenz **gerätübergreifend**: Der Agent läuft weiter, wenn der Rechner zuklappt; von einem zweiten Rechner ist dieselbe Session wieder erreichbar |
| A3 | Sidebar über alle VMs hinweg mit Statuspunkt je Session; rechts ein großes aktives Terminal |
| A4 | Statuserkennung: *wartet auf Eingabe* / *arbeitet* / *untätig* / *beendet* / *unbekannt* |
| A5 | Beim Anlegen einer Session optional `git worktree add` mit neuem Branch |
| A6 | Beliebige Kommandos in der Session — Agent-Presets sind Bequemlichkeit, kein Zwang |
| A7 | Mehrere VMs gleichzeitig von einem zentralen Gerät aus |
| A8 | **Native Desktop-Anwendung für Windows** — keine TUI, keine Terminal-Abhängigkeit |

### Nicht-Ziele

- Kein eigener Terminal-Multiplexer. tmux auf der VM ist die Persistenzschicht.
- Kein Cloud-Dienst, kein Sync-Server, kein Konto.
- Keine Unterstützung für Windows-lokale Sessions. tmux läuft auf Linux; WSL ist nicht vorausgesetzt.
- Kein Editor, kein Diff-Viewer, keine Git-Oberfläche über das für Worktrees Nötige hinaus.
- Keine automatische Aufräumlogik für Worktrees (siehe §10.2).
- **Keine Betriebssystem-Benachrichtigungen** (Produktentscheidung, siehe §7.1).
- **Kein `keyboard-interactive` / 2FA in v1** (§8.4).
- Kein Splitten von Panes innerhalb einer Session (§6.7).
- **Keine Abhängigkeit von thurbox.** Eigenständiges Repository; einzelne Lösungsideen und
  ggf. einzelne Codeteile werden unter Beachtung der MIT-Lizenz übernommen (§17).

---

## 2. Verifizierte Grundlagen

Dieser Entwurf ruht auf Messungen gegen die Zielumgebung (tmux 3.3a und 3.4, OpenSSH),
nicht auf Annahmen. **V1–V23 und V25–V31 sind sprachunabhängig** — sie beschreiben
tmux- und SSH-Verhalten und gelten unverändert nach dem Stackwechsel.

| # | Befund | Konsequenz |
|---|---|---|
| V1 | `sshd` `MaxSessions` = 10 (Default). 10 Kanäle auf einer Verbindung lassen **null** exec-Kanäle übrig; Kanal 11 scheitert mit `Channel open failure (reason=2)` | Zwei Verbindungen pro Host, Semaphore je Arbeitsklasse (§4.2) |
| V2 | Ein Kanal, der nur mit EOF auf stdin beendet wird, gibt den SSH-Session-Slot **nicht** frei; erst ein echtes Schließen tut das | Teardown schließt den Kanal, statt nur stdin zu beenden |
| V3 | 8 Kanäle auf einer Verbindung, 7 flutend: 7,82 MB/s, **kein Head-of-Line-Blocking** — p95 auf dem stillen Kanal unter Last nicht schlechter als im Leerlauf | Multiplexing über eine Verbindung ist tragfähig |
| V4 | Kanalöffnung: exec 69–75 ms, PTY-Kanal 101–130 ms, Verbindungsaufbau samt Auth 221–257 ms | Kanäle werden **lazy** geöffnet (§6.8) |
| V5 | `tmux attach` sendet `ESC[?1049h` → alles vorher Geschriebene liegt im verborgenen Normalpuffer | Alternate Screen für den *Client* abschalten (§6.3) |
| V6 | `capture-pane -e -p -J -S -N -E -1` liefert **exakt die History ohne den sichtbaren Bereich** | Reattach ohne Pufferung und ohne Timing (§6.2) |
| V7 | Der Attach-Strom ist ein vollständiger absoluter Repaint (`ESC[?1h ESC= ESC[H ESC[2J …`), **ohne** `ESC[3J` | Grundlage des Disjunktheitsarguments (§6.2) |
| V8 | `capture-pane` liefert `\n`, nicht `\r\n` | Vor dem Schreiben ersetzen, sonst Treppeneffekt (250 Zeilen wurden zu 333) |
| V9 | `capture-pane -e -p -J -S -5000`: 613 KB, 35 ms serverseitig. `-e` kostet Faktor 1,72 gegenüber Klartext | N = 5000 als Vorgabe |
| V10 | `history-limit` wirkt nur auf Panes, die **danach** erzeugt werden | Vor `new-session` setzen |
| V11 | `window-size latest` (Default): Bei zwei attachten Clients springt die Größe **bei jedem Tastendruck** zwischen ihnen | `window-size manual` + `resize-window` |
| V12 | Ein inline rendernder Agent (Codex) sendet bei Resize `ESC[3J` und löscht den tmux-Scrollback (`history_size` 53 → 1) | Resize nur bei echter Fenstergrößenänderung, Debounce 300 ms (§6.4) |
| V13 | tmux ersetzt `.` **und** `:` im Session-Namen still durch `_`; auf 3.3a zusätzlich Nicht-ASCII. `#{…}` wird abgelehnt | Nur `[a-z0-9_]` in erzeugten Namen (§5.1) |
| V14 | Eine Shell-Schleife mit `sleep` **überlebt** den Verbindungsabriss (`ppid=1`); `trap PIPE` hilft nicht. `while read -r -t 1 … \|\| [ $? -gt 128 ]` stirbt sofort | Poll-Schleife als `read`-Form (§6.1) |
| V15 | Codex sendet am Freigabe-Prompt einen **1-Hz-Heartbeat** (12.320 B / 30 s) | Output-Stille ist als primäres Statussignal unbrauchbar |
| V16a | **Codex 0.145.0** setzt im OSC-Titel: untätig `<cwd>`; arbeitet `⠏ <cwd>`; wartet `[ . ] Action Required \| <cwd>` | Primäres Statussignal (§6.1) |
| V16b | **Claude Code 2.1.219** setzt: untätig `✳ <name>`; arbeitet `⠂`/`⠐ <name>`. Der Wartezustand wurde **nicht gemessen** | Muster als Daten, `unbekannt` als Vorgabe (§6.1) |
| V16c | **Ungemessen:** ob der Titel im Alternate Screen weiter aktualisiert wird; `opencode` vollständig | Offener Punkt (§16) |
| V17 | `#{pane_title}` ist durch jedes Programm im Pane setzbar → gefälschte Poll-Zeilen möglich | Titel als **letztes** Feld, Rest positionell, Zeilenvalidierung (§6.1) |
| V18 | `terminal-overrides ',*:smcup@:rmcup@'` betrifft nur den äußeren Client; `vim`/`less` im Pane behalten `alternate_on=1`. Die schädliche Option ist `alternate-screen off` | Gewählte Lösung für §6.3 |
| V19 | Ein Shell-Kanal liefert `Last login: …` plus Echo der Kommandozeile; ein exec-Kanal mit PTY-Anforderung beginnt direkt mit dem Repaint | Attach über exec mit PTY-Anforderung (§6.2) |
| V20 | **`russh`s `check_server_key` ist eine Provided Method, deren Standardimplementierung *alle* Keys ablehnt.** Doku wörtlich: *"The default implementation rejects all keys."* | Fällt sicher aus — eigene Implementierung ist Pflicht, um überhaupt zu verbinden (§8.1) |
| V21 | **Korrigiert 2026-07-25.** Die ursprüngliche Behauptung lautete: `set -g remain-on-exit on` lasse den tmux-Server beim Start sterben. Das ließ sich in Task 8 auf tmux 3.3a in vier Proben **nicht reproduzieren** — `set -g` und `setw -g` verhalten sich identisch, `#{pane_dead}` wird in beiden Fällen 1. Die ursprüngliche Messung hat mit hoher Wahrscheinlichkeit V21b beobachtet und der `set`-Form zugeschrieben | `setw -g` bleibt trotzdem die richtige Form — `remain-on-exit` **ist** eine Fensteroption. Die Begründung war falsch, die Entscheidung nicht |
| V21b | **Gemessen in Task 8:** `start-server` erzeugt einen Server mit null Sessions. `exit-empty` (Serverdefault „on" seit tmux 3.2) beendet ihn, sobald der startende Client trennt — also bevor ein zweiter, getrennter SSH-Exec ihn erreicht. Ein danach gesetztes `history-limit` landet auf einem Server, der schon tot ist; `new-session` erzeugt einen frischen mit Default 2000. Gemessen: `left: "2000", right: "12345"` | Serveroptionen und `new-session` müssen **in einer verketteten tmux-Kommandozeile** laufen, oder `exit-empty off` muss mit `start-server` verkettet und nach erfolgreichem `new-session` wieder auf `on` gesetzt werden (§6.5) |
| V22 | tmux-Optionen (`@name`) leben nur im Serverprozess und sind nach `kill-server`/Reboot weg | Zusätzlich eine Datei im Worktree (§5.2) |
| V23 | `capture-pane -t %999` auf einen toten Pane: exit 1, `can't find pane` — deterministisch | Als normaler Ausgang behandeln (§9.4) |
| V25 | `MaxStartups 10:30:100` ist der Engpass beim Reconnect, nicht `MaxSessions` | Backoff mit Jitter, global serialisiert |
| V26 | `#{@ab}` löst in `list-panes -a` auf tmux 3.3a auf; `tmux display -p '#{pid}'` funktioniert ohne attachten Client | Metadaten und Epoche sind serverseitig abfragbar |
| V27 | `new-session -d -s <existierender Name>` → exit 1, `duplicate session: <name>`, deterministisch | Kollisionserkennung beim Namenswürfeln (§5.1) |
| V28 | Ein `\|` im Wert von `@ab` erzeugt eine zusätzliche Spalte in der Poll-Zeile und verschiebt alle folgenden Felder | `@ab` **nicht** in der Poll-Zeile; Trenner `\x1f` (§6.1) |
| V29 | tmux Control Mode: Ein Tastendruck wird zu einer tmux-Kommandozeile; +16,7 % Bytes auf der Leitung gegenüber rohem PTY-Strom | Argument gegen Control Mode als Transport (§3) |
| V30 | tmux-Server-CPU: 6,9 % ohne Clients, 9,8–10,9 % mit 8 Clients — rund 0,5 % je zusätzlichem Client | Unsichtbare Kanäle dürfen volle Größe behalten (§6.4) |
| V31 | xterm.js verwirft Ausgabe oberhalb `DISCARD_WATERMARK` = 50 MB — sichtbar als **fehlende Zeilen**, nicht als Verlangsamung | Flow Control ist Korrektheit, nicht Performance (§9.1) |
| V32 | `russh` 0.62.4, Apache-2.0, aktiv gepflegt. `Channel::request_pty(want_reply, term, cols, rows, pix_w, pix_h, modes)` und `Channel::window_change(cols, rows, pix_w, pix_h)` existieren als reguläre Methoden | Programmatische PTY- und Resize-Semantik ist gegeben (§6.4) |
| V33 | `portable-pty` 0.9.0, MIT, von Wez Furlong (WezTerm), ~1,5 Mio. Downloads/Monat. ConPTY unter Windows, Prozess-Spawn im PTY, Resize. Abhängigkeiten `libc`/`winapi` sind gewöhnliche Crates ohne externe Bauwerkzeuge | Der `ssh.exe`-Rückfallpfad ist in Rust billig (§3) |
| V34 | thurbox (MIT, Rust, 92k Zeilen) erkennt Agent-Zustände über OSC 0/1/2 **und** OSC 9/777 sowie BEL. Quelltext-Kommentar: *"This is how we surface a real 'needs attention' state instead of timing-only Busy/Waiting."* | OSC 9/777 als zusätzliches Signal übernehmen (§6.1) |

*V24 (npm/`cpu-features`) ist mit dem Stackwechsel entfallen.*

---

## 3. Stack- und Transportentscheidung

### 3.1 Warum Tauri und nicht Electron

Beide Ansätze rendern das Terminal mit **xterm.js** in einem WebView und die Sidebar in
HTML — der sichtbare Teil der Anwendung ist identisch. Der Unterschied liegt im Backend.

| | **Tauri (gewählt)** | Electron |
|---|---|---|
| Backend | Rust | Node/TypeScript |
| Installationsgröße | ~7 MB (WebView2 ist auf Windows 11 vorinstalliert) | ~96 MB komprimiert, 200 MB+ mit Modulen |
| Arbeitsspeicher | rund die Hälfte — kein zweiter Chromium-Prozessbaum, kein Node-Hauptprozess | — |
| SSH-Bibliothek | `russh` — fällt bei fehlender Host-Key-Prüfung **sicher** aus (V20) | `ssh2` — akzeptiert ohne Prüfung **jeden** Host |
| PTY-Rückfallpfad | `portable-pty`, gewöhnliche Crate (V33) | `node-pty`, natives Modul mit Bauwerkzeug-Bedarf |

Für ein Werkzeug, das den ganzen Tag offenbleibt, ist der Ressourcenunterschied real. Der
Sicherheitsunterschied bei der Host-Key-Prüfung ist der stärkere Grund: Er verwandelt den
gefährlichsten Einzelbefund der vorigen Fassung in einen Nicht-Befund.

### 3.2 Transport

**Gewählt: `russh`** — eine Verbindung je Host, mehrere Kanäle darin, PTY-Anforderung und
`window_change` je Kanal.

**Verworfen: `ssh.exe` als Kindprozess** (der Weg, den thurbox geht). Er erbt `~/.ssh/config`,
ProxyJump, Agent und Hardware-Schlüssel geschenkt und ist mit `portable-pty` in Rust billig
zu haben (V33). Er passt aber nicht zum gemessenen Design: Der Windows-OpenSSH-Client
beherrscht kein `ControlMaster`-Multiplexing, also wäre **jedes** `capture-pane` und jede
tmux-Abfrage ein vollständiger neuer Verbindungsaufbau (221–257 ms statt 69–75 ms, V4). Der
Control-Kanal aus §6.1 wäre gar nicht darstellbar.

**Verworfen: tmux Control Mode als Transport.** Ein Control-Client ist an genau eine Session
gebunden, ein Protokoll-Parser wäre selbst zu schreiben, und jeder Tastendruck kostet +16,7 %
Leitungsbytes (V29).

Der Transport liegt hinter einem schmalen Rust-Trait. Dessen Begründung ist **Testnaht und
eine einzige Stelle für Auth und Reconnect**. Ein `ssh.exe`-Backend für exotische
SSH-Konfigurationen ist damit nachrüstbar, ohne den Rest anzufassen — in Rust kostet es nur
eine weitere Trait-Implementierung.

---

## 4. Architektur

### 4.1 Prozess- und Schichtaufteilung

```
┌─ WebView (WebView2) ────────────────────────────────────────────┐
│  Sidebar   TerminalView (xterm.js 6)   Dialoge   Statusleiste   │
└──────────────────────────┬──────────────────────────────────────┘
   Tauri-Events: Bytes als │ Uint8Array  ·  Ack je write()-Callback
   Tauri-Commands: Aktionen│
┌──────────────────────────┴──────────────────────────────────────┐
│  Rust-Backend — besitzt allen Netzwerk- und Schlüsselzugriff    │
│                                                                 │
│  commands (Tauri) · SessionStore · SessionManager ·             │
│  SettingsStore · Secrets · Diagnostics · Keymap                 │
│                                                                 │
│  HostConnection (je VM)                                         │
│   ├─ ControlConn  ── 1 Dauerkanal: Status-Schleife              │
│   │                └ ad-hoc exec: tmux, git, capture-pane       │
│   └─ TerminalConn ── PTY-Kanäle, hartes Limit 8                 │
│                                                                 │
│  TmuxClient · TmuxFormatParser · GitWorktrees · AgentProfiles    │
│  SessionController (je Session) · StatusDetector (je Session)    │
│  RemoteCommand · Preflight                                      │
│  Transport (Trait) · RusshTransport · SshAuth ·                 │
│  HostKeyVerifier · SshConfigParser                              │
└─────────────────────────────────────────────────────────────────┘
```

Der WebView hat keinen Zugriff auf Dateisystem, Netzwerk oder Schlüssel — Tauri erlaubt nur
die ausdrücklich registrierten Commands. Das ersetzt Electrons `contextIsolation` und ist
enger als dieses.

Async-Laufzeit ist **Tokio** (von `russh` ohnehin vorausgesetzt).

### 4.2 Verbindungs- und Kanalmodell

**Zwei SSH-Verbindungen je Host.** Die Trennung isoliert einen flutenden Agenten vom
Statuspfad und verhindert, dass ein voller Terminal-Kanalsatz das Kommandobudget aufbraucht
(V1).

| Verbindung | Inhalt | Gleichzeitige Kanäle |
|---|---|---|
| `ControlConn` | Dauerkanal (Status-Schleife) + ad-hoc exec | Loop 1 · Kontrolle/Capture ≤4 · Git ≤3 · **Summe ≤8**, 2 Slots bleiben unvergeben |
| `TerminalConn` | PTY-Kanäle für Sessions mit offenem Terminal | hart ≤8, LRU-Verdrängung |

**Warteschlangenpolitik.** Jede Arbeitsklasse hat eine FIFO-Warteschlange (Tokio-`Semaphore`).
Ist sie erschöpft, wird eingereiht, nicht abgewiesen. Zeitüberschreitungen: Kontrolle/Capture
15 s, Git 300 s. Danach gilt die Operation als fehlgeschlagen und erscheint an der
auslösenden Stelle (§7.5). Warteschlangenlängen und Wartezeiten gehen in `Diagnostics`.

**LRU-Verdrängung.** Kanäle bleiben nach einem Tab-Wechsel offen, damit ein Rückwechsel
sofort ist und kein Resize ausgelöst wird (§6.4). Beim Öffnen der neunten Session wird der am
längsten nicht sichtbare Kanal geschlossen. Die Session läuft auf der VM weiter; nur die
lokale Anzeige verliert ihren Puffer und wird über §6.2 wiederhergestellt.

**Kanalabbau schließt den Kanal wirklich** (V2) — EOF auf stdin allein lässt den
Attach-Prozess weiterlaufen und den Session-Slot belegt.

### 4.3 Module und ihre Grenzen

| Modul | Aufgabe | Kennt nicht |
|---|---|---|
| `Transport` (Trait) | `open_pty_channel(size)`, `exec(argv) -> {stdout, stderr, code}`, `dispose()` | tmux, git, UI |
| `RusshTransport` | einzige Implementierung in v1. Verbindung, Kanäle, Backpressure, Reconnect | tmux, git, UI |
| `SshAuth` | Schlüssel, Passphrasen, Passwort, ssh-agent (§8.4) | tmux, git, UI |
| `HostKeyVerifier` | `known_hosts`, TOFU-Rückfrage. **Pflicht-Feld** von `RusshTransport` | alles andere |
| `SshConfigParser` | reine Funktion über `~/.ssh/config` | alles andere |
| `RemoteCommand` | **Die einzige Stelle**, die entfernte Kommandozeilen erzeugt (§8.2) | tmux, git, UI |
| `Preflight` | prüft beim Verbinden die Voraussetzungen auf der VM (§6.9) | UI |
| `TmuxClient` | tmux-Syntax, Formatstrings, Benutzeroptionen, `history-limit` | SSH-Details, UI |
| `TmuxFormatParser` | I/O-frei: Poll-Zeilen → Strukturen, inkl. Zeilenvalidierung | alles andere |
| `GitWorktrees` | `list_worktrees`, `add_worktree`, `remove_worktree` | tmux, UI |
| `AgentProfiles` | Daten: Startkommando, PATH-Ergänzung, Titelmuster (§12.2) | Code-Pfade |
| `HostConnection` | je VM: besitzt beide Verbindungen, Semaphore, Reconnect-Ebene 1 | UI |
| `SessionController` | je Session: PTY-Kanal, Attach- und Reattach-Ablauf | SSH-Details |
| `StatusDetector` | je Session: **I/O-freie** Zustandsmaschine, `feed(PollRow, Option<Instant>, Instant) -> Status` | alles andere |
| `SessionStore` | Modell aller bekannten Sessions, **host-qualifizierte** Identität ab Tag 1 | I/O |
| `SessionManager` | Fassade, Aggregation für die UI | SSH-Details |
| `Keymap` | Tastenzuordnung App vs. Terminal (§7.4) | Domäne |
| `commands` | Tauri-Commands: schmale, semantische Schnittstelle zum WebView | Domäne |
| `SettingsStore` | TOML in `%APPDATA%`, versioniert (§12.1) | Domäne |
| `Secrets` | Passphrasen und Passwörter über Windows-DPAPI (§8.5) | Domäne |
| `Diagnostics` | rotierendes Log, Ringpuffer der letzten SSH-/tmux-Kommandos mit Timing, Redaktion, "Diagnose kopieren" | Domäne |

`HostKeyVerifier` ist Pflicht-Feld von `RusshTransport` und nicht dessen Nachbar: Als
getrenntes Modul könnte jemand den Transport ohne Verifikation bauen. In Rust ist das über
den Konstruktor erzwingbar.

`StatusDetector` ist bewusst I/O-frei — die Komponente mit der höchsten Bugdichte wird damit
der am leichtesten testbare Teil des Systems.

---

## 5. Datenmodell

### 5.1 Session-Identität

Session-Namen werden **nicht** aus Repo und Branch abgeleitet. Zwei Repos mit gleichem
Branchnamen — oder Namen, die sich nach der stillen Ersetzung aus V13 gleichen — ergäben
denselben Namen, und ein Attach darauf träfe die **fremde** Session. Bei Agents mit
Schreibzugriff ist das Datenverlust in einem anderen Projekt.

- Name = `ab_<6-hex>`, ausschließlich aus `[a-z0-9_]` — damit greift V13 nie.
- **`new-session -A` wird nicht verwendet.** Es verschmilzt *attach* und *create*; nur bei
  *create* darf ein Agent gestartet werden.
- Beim Anlegen bedeutet `duplicate session` (V27) eine **Namenskollision**: neu würfeln, bis
  zu fünf Versuche, danach Fehler. Es bedeutet **niemals** "existiert bereits, attachen".
- Attach erfolgt nur auf eine Session, die zuvor über den Poll entdeckt wurde und deren
  `@ab`-Metadaten zur Aufgabe passen.
- Der vergebene Name wird nach dem Anlegen zurückgelesen — Absicherung gegen künftige
  tmux-Änderungen.
- `SessionStore` führt Identitäten **host-qualifiziert** (`host_id + session_name`) ab dem
  ersten Meilenstein, damit die zweite VM später kein Umbau ist.

### 5.2 Metadaten

Als tmux-Benutzeroption, JSON-kodiert, gesetzt über `RemoteCommand` (§8.2) — also
base64-transportiert wie jeder andere aus der UI stammende Wert.

`meta` = `{ repo, worktree, branch, agent, title, created_at }`.

`@ab` wird **nicht** in der Poll-Zeile transportiert (V28), sondern beim Entdecken einer
Session und nach jedem Epochenwechsel einzeln gelesen. Metadaten ändern sich nur beim
Anlegen; sie gehören nicht in einen Sekundentakt.

Weil tmux-Optionen `kill-server` und Reboot nicht überleben (V22), wird dieselbe Information
zusätzlich abgelegt — **aber nur, wenn ein Worktree angelegt wurde**: als
`.agentbridge/session.json` im Worktree. Der Pfad wird in `.git/info/exclude` des Worktrees
eingetragen, **nicht** in `.gitignore` — sonst würde ein Agent die Datei mitcommitten.

Für Sessions ohne Worktree gibt es keine Datei. Das ist konsistent: Ohne Worktree gibt es
keinen Ort, der die Session überdauert, und mit dem tmux-Server stirbt ohnehin die Session.

**Wiederherstellung nach `kill-server`:** Die App scannt die in `SettingsStore` bekannten
Repo-Wurzeln nach `*/.agentbridge/session.json` und bietet an, die Session neu zu starten.
Automatisch geschieht nichts.

### 5.3 Was lokal liegt

Die Prämisse lautet präzise: **keine lokale Datenbank als Quelle der Wahrheit für den
Session-Zustand**. Lokal liegen dennoch: Hostliste (vorrangig aus `~/.ssh/config`),
Zugangsdaten, Agent-Presets, Tastenbelegung, UI-Layout, Repo-Wurzeln für den Scan, und ein
**Cache** der zuletzt gesehenen Sessions je Host — ausschließlich, um "alle Sessions sind
tot" von "ich konnte nicht verbinden" zu unterscheiden (§9.3).

Der Cache ist nachrangig: Was der Server liefert, gewinnt immer. Auf einem zweiten Gerät ist
er leer; dort sind alle vom Server entdeckten Sessions maßgeblich. Diese Trennung ist der
Grund, warum die App **keine** Session-Datenbank führt — sie ist die Bedingung für A2.

---

## 6. Kernabläufe

### 6.0 Socket

Die App arbeitet auf einem **eigenen tmux-Socket**, Vorgabe `agentbridge`, je Host
konfigurierbar. Sämtliche tmux-Aufrufe tragen `-L <socket>`.

Begründung: `set -g history-limit` und `setw -g remain-on-exit` sind Serveroptionen. Auf dem
Standard-Socket würden sie **alle** Sessions des Nutzers verändern — auf der Referenz-VM
liegen rund 130 fremde Sockets anderer Werkzeugketten. Ein eigener Socket macht die App zum
alleinigen Eigentümer ihres Servers.

Folgen, die dadurch entfallen: kein Konflikt mit fremden Sessions, keine Filterregel für
fremde Einträge, und kein Deployment eines eigenen terminfo (§6.3).

Wer Sessions einer anderen Werkzeugkette sehen will, konfiguriert deren Socket als weiteren
Host-Eintrag. Sessions ohne `@ab` erscheinen als **fremd** und werden nur angezeigt.

### 6.1 Statuserkennung

Ein **Dauerkanal** je Host, kein wiederholtes Öffnen von exec-Kanälen:

```sh
US=$(printf '\037'); SEQ=0
FMT="#{session_name}${US}#{pane_dead}${US}#{pane_current_command}${US}#{alternate_on}${US}#{history_size}${US}#{session_attached}${US}#{pane_title}"
while read -r -t 1 _ || [ $? -gt 128 ]; do
  printf 'E%s%s%s\n' "$SEQ" "$US" "$(tmux -L "$SOCK" display -p '#{pid}')"
  tmux -L "$SOCK" list-panes -a -f '#{pane_active}' -F "$FMT"
  printf 'X%s\n' "$SEQ"
  SEQ=$((SEQ+1))
done
```

**Die `read`-Form statt `sleep`** ist keine Stilfrage: Die `sleep`-Variante überlebt den
Verbindungsabriss und hinterlässt bei jedem Suspend einen weiteren 1-Hz-Poller auf der VM
(V14). Nebeneffekt: Ein Byte auf stdin löst sofortiges Pollen aus.

**Sequenznummer und Server-PID als Epoche.** Ohne Sequenznummer ist "Schleife hängt" nicht
von "nichts geändert" unterscheidbar; ohne Epoche bleibt ein `kill-server` unbemerkt, nach
dem tmux `pane_id`s neu vergibt. Die `E…`/`X…`-Rahmung macht unvollständige Runden erkennbar.

**`\x1f` als Trenner, `@ab` außerhalb der Zeile** (V28). **`#{pane_title}` als letztes Feld,
`-f '#{pane_active}'` als Filter** (V17): Der Parser liest die ersten sechs Felder positionell
und fügt alles Weitere wieder zum Titel zusammen, damit eine Titel-Injektion keine Felder
verschieben kann. Zeilen, deren erstes Feld nicht dem Muster `ab_[0-9a-f]{6}` oder einer
bekannten fremden Session entspricht, werden verworfen und in `Diagnostics` gezählt.

**Zusätzliches Signal aus dem PTY-Strom (V34):** Für die sichtbare Session wertet die App den
Bytestrom mit auf OSC 0/1/2 (Titel), OSC 9 und OSC 777 (Desktop-Benachrichtigung) sowie BEL
aus. Ein solches Signal bedeutet "fertig oder braucht Eingabe" und ist präziser als jede
Zeitheuristik. Die Idee stammt aus thurbox (§17).

**Zustandsableitung** im `StatusDetector`:

| Signal | Zustand |
|---|---|
| `pane_dead = 1` | **beendet** |
| OSC 9/777 oder BEL seit letzter Eingabe | **wartet auf dich** |
| Titel enthält `Action Required` oder `[ ! ]` | **wartet auf dich** |
| Titel enthält Braille-Zeichen (`U+2800`–`U+28FF`) | **arbeitet** |
| Titel entspricht dem Ruhemuster des Profils (z. B. führendes `✳`) | **untätig** |
| `pane_current_command` ist die Login-Shell und kein Profil greift | **untätig** (freies Kommando, A6) |
| sonst | **unbekannt** |

Output-Stille ist ausschließlich **sekundäres** Signal mit Schwelle 1,5 s und nur in Richtung
"könnte fertig sein". Grund ist gemessen: Codex sendet ausgerechnet am Freigabe-Prompt einen
1-Hz-Heartbeat (V15). Der Wert ist nur für die sichtbare Session verfügbar; für alle anderen
ist er `None`, und der Detektor kommt ohne ihn aus.

Die Titelsemantik ist undokumentiert und versionsabhängig (V16a–c). **unbekannt** ist deshalb
ein erstklassiger Zustand und niemals ein stilles "untätig". Die Muster liegen in
`AgentProfiles` als nutzerüberschreibbare Daten (§12.2).

### 6.2 Reattach

Ohne Pufferung, ohne Zeitstempelvergleich, ohne Warten auf ein Burst-Ende:

1. `capture-pane -t <sess> -e -p -J -S -5000 -E -1` über die `ControlConn` — **exakt die
   History ohne den sichtbaren Bereich** (V6).
2. `\n` → `\r\n` ersetzen (V8), in xterm.js schreiben, `ESC[0m` anhängen.
3. `rows` Zeilenvorschübe schreiben.
4. Kanal öffnen, `request_pty(false, term, cols, rows, 0, 0, &[])`, dann
   `exec(false, "tmux -L <socket> attach -t <sess>")` — **kein** `request_shell` (V19).
5. Alle eingehenden Bytes ungefiltert an xterm.js.

History und sichtbarer Bereich sind **per Konstruktion disjunkt**: Schritt 1 liefert alles
oberhalb des Viewports, der Attach-Repaint malt den Viewport, und er enthält kein `ESC[3J`
(V7). Kein Loch, keine Dopplung, keine Zeitannahme. Der Ablauf ist zustandslos und idempotent
— ein Abbruch mittendrin heißt `terminal.reset()` und von vorn.

**Guard:** Schritt 1–3 nur, wenn `#{alternate_on} == 0`. Läuft der Agent im Alternate Screen,
existiert keine tmux-History; dann beginnt der Ablauf bei Schritt 4 und die UI zeigt "nur
aktueller Bildschirm". Der Wert wird zur Laufzeit gepollt, nicht pro CLI angenommen.

**Restrisiko:** Zeilen, die zwischen Capture und Attach aus dem Viewport scrollen, fehlen im
lokalen Puffer. Sie stehen weiterhin in der tmux-History; die App bietet dafür **keine**
Suche an (§6.4 erklärt, warum ein Verweis darauf trügen würde).

### 6.3 Alternate Screen des Clients

`tmux attach` schaltet den *Client* in den Alternate Screen (V5), wodurch der zurückgespielte
Scrollback unsichtbar würde. Gegenmaßnahme beim Erzeugen des eigenen Servers:

```
tmux -L agentbridge set -g terminal-overrides ',*:smcup@:rmcup@'
```

Gemessen unschädlich: betrifft nur den äußeren Client; `vim`, `less` und `htop` innerhalb der
Panes behalten `alternate_on=1` (V18). Weil die App alleiniger Eigentümer ihres Sockets ist
(§6.0), wirkt die Option auf niemanden sonst. `alternate-screen off` wird **nicht** verwendet
— sie zerstört den Viewport messbar.

### 6.4 Größe und Resize

- **Eine kanonische Größe** für alle Kanäle, abgeleitet vom großen UI-Terminal. Unsichtbare
  Kanäle behalten sie; die Kosten sind gemessen und klein (V30).
- `window-size manual` (V11), Größe über `resize-window` auf der `ControlConn`. `window_change`
  auf dem Kanal (V32) hält zusätzlich das entfernte PTY synchron.
- Umgestellt wird **nur bei echter Fenstergrößenänderung**, mit 300 ms Debounce — niemals
  beim Tab-Wechsel.

**Der Grund ist Datenverlust:** Ein inline rendernder Agent sendet bei jedem Resize `ESC[3J`
und löscht damit den **serverseitigen** tmux-Scrollback unwiderruflich (V12). Ein lokal
vorgehaltener Capture mildert das nur für bereits Erfasstes. Nach einem Resize zeigt die App
einen einmaligen Hinweis: *"Fenstergröße geändert — der Verlauf älterer Ausgaben kann
verloren sein."* Ein Versprechen, die Zeilen seien "über die Suche erreichbar", wird bewusst
nicht gemacht.

### 6.5 Session anlegen

1. `set -g history-limit 10000` — **vor** `new-session` (V10). Deutlich über dem
   Capture-Fenster von 5000 Zeilen. Je Host überschreibbar.
2. `setw -g remain-on-exit on` — mit `setw`, nicht `set` (V21).
3. Optional `git worktree add -b <branch> -- <absoluter Pfad>` über `GitWorktrees`.
4. `new-session -d -s ab_<hex> -c <cwd>`. Bei `duplicate session` neu würfeln (§5.1).
5. Namen zurücklesen, `@ab` setzen (§5.2), bei Worktree zusätzlich `session.json`.
6. Optional das Agent-Kommando aus dem Preset senden.

Der `PATH` einer nicht-interaktiven SSH-Shell ist minimal; Agent-CLIs liegen typischerweise
in `~/.local/bin` oder `~/.npm-global/bin`. tmux startet eine Login-Shell, was nicht immer
genügt. `AgentProfiles` hält je Agent eine PATH-Ergänzung; das Startkommando ist editierbar.

### 6.6 Mehrere Geräte

`#{session_attached}` steht in der Poll-Zeile. Ist bereits ein Client verbunden, **fragt die
App nach**, bevor sie `attach -d` verwendet.

Auf dem abgehängten Gerät beendet sich der Attach-Prozess; weil der Kanal ein exec mit
PTY-Anforderung ist und keine dahinterliegende Login-Shell hat (V19), **schließt der Kanal
dabei**. `SessionController` behandelt das Kanalende als "von außen abgehängt", sperrt die
Eingabe und zeigt es in der Sidebar an. Ein Klick verbindet neu.

### 6.7 Ein Pane je Session

v1 modelliert **einen Pane je Session**. Der Poll filtert mit `-f '#{pane_active}'`, und
`capture-pane` zielt auf die Session. Splittet jemand den Pane, bleibt die Session bedienbar —
Status und Verlauf beziehen sich dann auf den **aktiven** Pane, und die Sidebar zeigt einen
Hinweis. Ein vollständiges Pane-Modell ist v2.

### 6.8 Lazy öffnen

PTY-Kanäle werden erst geöffnet, wenn eine Session sichtbar wird (V4: 101–130 ms). Die
Sidebar wird ausschließlich aus dem Poll gefüllt und braucht keinen Terminal-Kanal. Beim
Start sind null PTY-Kanäle offen. Der spürbare Aufwand beim Wechsel ist nicht der Kanal,
sondern der Capture (613 KB, V9) — deshalb bleiben Kanäle nach dem Wechsel offen (§4.2, LRU).

### 6.9 Preflight

| Prüfung | Fehlt es, dann | Ab Plan |
|---|---|---|
| `tmux -V` vorhanden, ≥ 3.0 | **Abbruch** mit Installationshinweis | 1 |
| `base64` vorhanden | **Abbruch** — `RemoteCommand` ist darauf angewiesen (§8.2) | 1 |
| Socket-Verzeichnis beschreibbar | **Abbruch** mit Pfadangabe | 1 |
| `#{@x}` löst in `list-panes` auf (V26) | Warnung — Metadaten nicht nutzbar | 2 |
| `git --version` | Warnung — Worktree-Funktionen deaktiviert | 3 |

Nur die ersten drei brechen ab. Die übrigen betreffen Funktionen, die es im jeweiligen Plan
noch nicht gibt — sonst scheitert Plan 1 an einer Voraussetzung, die er nicht benutzt. Das
Ergebnis wird je Host zwischengespeichert und bei Versionswechsel erneuert.

---

## 7. Interaktion

### 7.1 Sidebar

Gruppiert nach Host, darunter die Sessions — genau das Bild aus der Anforderung: links die
SSH-Verbindungen, darunter je mehrere Terminal-Sessions mit unterschiedlichen Agents.

Je Eintrag: Statuspunkt, Anzeigename, Agent-Kennzeichen, bei Worktree der Branchname. Fremde
Sessions (ohne `@ab`) stehen in einer eigenen Gruppe und sind nur lesbar.

Statuspunkte: ● wartet auf dich · ◐ arbeitet · ○ untätig · ✕ beendet · ? unbekannt.
**Ohne Betriebssystem-Benachrichtigung** — der Zustand steht in der Sidebar.

Ein Eintrag zeigt zusätzlich an, wenn die Session auf einem anderen Gerät geöffnet ist, wenn
nur der aktuelle Bildschirm verfügbar ist (`alternate_on`), oder wenn der Pane gesplittet
wurde (§6.7).

### 7.2 Klick auf eine Session

| Zustand | Verhalten |
|---|---|
| lebend | Reattach nach §6.2, Eingabe frei |
| **beendet** (`pane_dead=1`) | Kein Attach. Der letzte Bildschirm wird über `capture-pane` gezeigt — mit `remain-on-exit on` liefert er weiterhin Inhalt (V23), der Nutzer sieht also, **woran** der Agent starb. Eingabe gesperrt. Schaltflächen *Neu starten* und *Session entfernen* |
| auf anderem Gerät | Rückfrage nach §6.6 |
| fremd (ohne `@ab`) | Nur-Lesen-Attach, Eingabe gesperrt, Hinweis |

### 7.3 Session beenden und Worktree entfernen

Zwei getrennte Aktionen, niemals gekoppelt (§10.2).

**Session beenden** — Bestätigungsdialog, der benennt, welcher Prozess läuft
(`pane_current_command`). Danach `kill-session`. Der Worktree bleibt unangetastet.

**Worktree entfernen** — eigene Aktion in einem Verwaltungsdialog. Zeigt vorher
`git status --porcelain` des Worktrees. Bei uncommitteten Änderungen ist die Schaltfläche
gesperrt, bis der Nutzer ausdrücklich "trotzdem entfernen" wählt; die App verwendet dann
`--force`. Läuft noch eine Session darin, wird zuerst deren Beendigung verlangt.

### 7.4 Tastatur

Alles Einfache geht ans Terminal — auch `Strg+C` und `Strg+V`. Die App reagiert nur auf
`Strg+Umschalt+…`:

| Vorgabe | Aktion |
|---|---|
| `Strg+Umschalt+C` / `V` | Kopieren / Einfügen |
| `Strg+Umschalt+F` | Im lokalen Puffer suchen |
| `Strg+Umschalt+N` | Neue Session |
| `Strg+Umschalt+W` | Terminal schließen (Session läuft weiter) |
| `Strg+Umschalt+↑` / `↓` | Vorherige / nächste Session |
| `Strg+Umschalt+1…9` | Session direkt wählen |

**Jede Belegung ist frei konfigurierbar** (`Keymap`, §12.1). Die Oberfläche zeigt Konflikte an
und lehnt Belegungen ab, die eine einzelne `Strg`- oder `Alt`-Kombination beanspruchen würden
— das würde A1 verletzen. Rechtsklick fügt ein (mit Bracketed Paste, sofern angefordert).

### 7.5 Fehler

- **Modal** nur, wenn eine Entscheidung nötig ist: unbekannter Host-Key (TOFU),
  Passphrase- oder Passwortabfrage, Rückfrage vor `attach -d`.
- **Statusleiste je Session**: Verbindung getrennt, Eingabe gesperrt, nur aktueller
  Bildschirm, Resize-Hinweis.
- **Hinweisleiste je Host**: Verbindungs- und Preflight-Fehler, mit "Erneut versuchen" und
  "Diagnose kopieren".

Jede Meldung nennt Ursache und nächsten Schritt. Für die Auth-Zweige ist das Abnahmekriterium
(§13): unterscheidbar, ob Host nicht erreichbar, Host-Key abgelehnt, Schlüssel nicht lesbar,
Passphrase falsch, Passwort falsch, Agent nicht erreichbar oder Methode nicht angeboten.

### 7.6 Erststart

Ist kein Host konfiguriert, zeigt die App eine Startseite: gefundene Einträge aus
`~/.ssh/config` als Vorschlagsliste, daneben "Host manuell hinzufügen". Nach der Auswahl
läuft `Preflight` (§6.9) sichtbar durch, mit Häkchen je Prüfung.

### 7.7 Sprache und Bedienbarkeit

v1 ist einsprachig **Englisch**; alle Zeichenketten liegen in einer Ressourcendatei.
Tastaturbedienbarkeit der gesamten Oberfläche ist Anforderung; die Statuspunkte tragen
zusätzlich zur Farbe eine Form und ein Textlabel für Screenreader.

---

## 8. Sicherheit

### 8.1 Host-Key-Verifikation

`russh`s `check_server_key` hat eine Standardimplementierung, die **alle Keys ablehnt**
(V20). Die Bibliothek fällt also sicher aus — anders als vergleichbare Bibliotheken, die
ohne Prüfung jeden Host akzeptieren.

`HostKeyVerifier` implementiert die Prüfung gegen `known_hosts`; unbekannte Hosts lösen eine
Rückfrage aus (TOFU). Ein Test stellt sicher, dass ein unbekannter Host **ohne** Zustimmung
abgelehnt wird (§13).

### 8.2 Kommando-Erzeugung

SSH `exec` überträgt **einen String**, den die entfernte Shell interpretiert; ein `argv` gibt
es nicht.

**`RemoteCommand` ist die einzige Stelle im Code, die entfernte Kommandozeilen erzeugt.** Sie
nimmt ein Argument-Slice und transportiert jeden nicht konstanten Wert base64-kodiert. Das
Base64-Alphabet enthält kein Shell-Metazeichen; ein kodierter Wert kann seine Quotes per
Konstruktion nicht verlassen:

```rust
// remote.exec(&["git", "worktree", "add", "-b", branch, "--", wt_path])
// erzeugt:
// set -eu; A1=$(printf %s 'ZmVhdC94' | base64 -d); A2=$(printf %s '…' | base64 -d);
// cd -- "$REPO" && git worktree add -b "$A1" -- "$A2"
```

**Diese Regel gilt ausnahmslos** — auch für tmux-Session-Namen, `-c <cwd>`, Anzeigenamen und
den JSON-Wert von `@ab` (§5.2). Der Anzeigename ist freier Nutzertext; ein `'` darin würde
naives Quoting aufbrechen. String-Formatierung für entfernte Kommandos ist außerhalb von
`RemoteCommand` nicht erlaubt; ein Clippy-Lint bzw. ein Test prüft das (§13).

Nötig ist das, weil `git check-ref-format` `;`, `&`, `|`, `$` und Backticks in Branchnamen
**erlaubt** — `feat/x$(id)` ist ein gültiger Branchname. "Git hat es akzeptiert" ist kein
Sicherheitsargument.

Gegen Argument-Injection: Pfade werden **immer absolut** erzeugt (können dann nie mit `-`
beginnen), Branchnamen gegen die Semantik von `git check-ref-format --branch` geprüft.

### 8.3 Tauri-Schnittstelle

Der WebView bekommt keine Dateisystem-, Netzwerk- oder Prozessrechte; die
Tauri-Capabilities-Datei listet ausschließlich die registrierten Commands. Diese sind
semantisch (`worktree_add(repo_id, branch)`), nicht generisch (`ssh_exec(cmd)`). Validierung
findet im Rust-Backend statt.

**Terminal-Ausgabe ist angreiferbeeinflussbar** (Repo-Inhalte, Werkzeug-Output). xterm.js
erlaubt bei OSC-8-Hyperlinks unter anderem `file://`. Link-Klicks werden auf `http`/`https`
gefiltert und mit Bestätigungsdialog geöffnet.

### 8.4 Authentifizierung

v1 unterstützt drei Wege. Jeder ist ein Abnahmekriterium mit eigener Fehlermeldung (§7.5):

| Weg | Umsetzung |
|---|---|
| **Schlüssel + Passphrase** | Schlüsseldatei aus `~/.ssh` oder frei gewählt; `russh-keys` zum Laden. Passphrase als `Zeroizing<String>`, damit sie nach Gebrauch gelöscht wird; optional über `Secrets` gemerkt |
| **ssh-agent** | Windows-OpenSSH-Agent über Named Pipe `\\.\pipe\openssh-ssh-agent`. Der Dienst ist unter Windows 11 standardmäßig **deaktiviert** — die App erkennt das und sagt es, statt zu scheitern |
| **Passwort** | Abfrage je Verbindung, optional über `Secrets` gemerkt |

`keyboard-interactive` / 2FA ist **nicht** in v1 (§1). Wird es nachgerüstet, muss die
Zeitüberschreitung des Verbindungsaufbaus auf ~120 s steigen, sonst bricht der Handshake ab,
während der Nutzer den Code tippt.

### 8.5 Schlüssel und Geheimnisse

Rangfolge: (1) gar nichts speichern, Agent nutzen; (2) Schlüsseldatei auf Platte, Passphrase
je Sitzung im Speicher; (3) verschlüsselt auf Platte über **Windows-DPAPI**.

DPAPI bindet an das Benutzerkonto, nicht an die Anwendung: Es schützt gegen Dateidiebstahl
und andere Benutzer desselben Rechners, **nicht** gegen Schadsoftware, die bereits unter
derselben Kennung läuft. Das wird so dokumentiert, nicht beschönigt.

Rust bietet hier einen echten Vorteil gegenüber der vorigen Fassung: Geheimnisse liegen in
`Zeroizing`-Puffern und werden beim Verlassen des Gültigkeitsbereichs überschrieben — bei
unveränderlichen Strings einer verwalteten Laufzeit war das nicht erreichbar.

---

## 9. Fehlerbehandlung

### 9.1 Flow Control

xterm.js verwirft Ausgabe oberhalb von 50 MB (V31) — sichtbar als **fehlende Zeilen**, nicht
als Verlangsamung. Deshalb eine Ack-Schleife: `term.write(chunk, () => invoke('ack', …))`,
Acks gesammelt; im Backend wird das Kanal-Fenster nicht weiter geöffnet, bis der WebView
nachgezogen hat. Der Rückstau propagiert über das SSH-Fenster bis zum entfernten Prozess.

Bytes werden **nie** in einen String dekodiert, bevor sie xterm.js erreichen — der Dekoder
ist zustandsbehaftet, und ein zerschnittener Puffer zerstört Mehrbyte-Zeichen an der
Chunk-Grenze. Der Transportweg zum WebView ist binär (`Uint8Array`).

### 9.2 Verbindungsverlust

Keepalive wird gesetzt. Ohne das hängt die TCP-Verbindung minutenlang, und der Nutzer tippt
in ein totes Terminal, ohne es zu merken.

Bei degradiertem Transport: Zustand je Session in der Sidebar sichtbar, **Eingabe gesperrt**.
Reconnect mit Backoff **und Jitter**, global serialisiert — der Engpass ist
`MaxStartups 10:30:100` (V25).

Zwei Ebenen: Wiederaufbau der Verbindung gehört zu `RusshTransport`, Wiederherstellung der
Sitzungsbindung (Reattach nach §6.2) zu `SessionController`.

**Abbruch mitten im Reattach** ist unkritisch, weil §6.2 zustandslos und idempotent ist.

### 9.3 tmux-Server tot oder VM neu gestartet

`list-panes` liefert dann leer — ununterscheidbar von "konnte nicht verbinden", wenn man nur
auf die Liste schaut. Deshalb der Cache aus §5.3: Sessions, die der Cache kennt und der
Server nicht liefert, erscheinen als **beendet** mit Grund. Ist die Verbindung selbst gestört,
erscheint stattdessen der Hostfehler (§7.5) und die Sidebar bleibt unverändert.

Die Server-PID aus dem Poll dient als Epoche: Ändert sie sich, sind alle Bindungen ungültig
und Metadaten werden neu gelesen.

### 9.4 Pane stirbt zwischen Poll und Capture

`capture-pane` auf einen toten Pane liefert deterministisch exit 1 mit `can't find pane`
(V23) — **normaler Ausgang**, kein Fehler. Mit `remain-on-exit on` bleibt der Pane als
`pane_dead=1` bestehen und liefert weiterhin Inhalt (Grundlage für §7.2).

---

## 10. Abläufe mit Datenverlustrisiko

### 10.1 Worktrees

`git worktree add` gibt jedem Branch ein eigenes Arbeitsverzeichnis bei geteiltem `.git`.
Zwei Agents können damit parallel an zwei Branches desselben Repos arbeiten; bei einem
einzigen Checkout blockieren sie sich sofort. Im Anlegen-Dialog ist der Worktree ein
**Häkchen**, keine Pflicht.

### 10.2 Trennung der Lebenszyklen

Session-Lebenszyklus und Worktree-Lebenszyklus sind **strikt getrennt**. "Session beenden"
entfernt **niemals** einen Worktree — sonst vernichtet ein Klick uncommittete Agentenarbeit.

---

## 11. Auslieferung

### 11.1 Abhängigkeiten

**Backend:** Tauri 2, `tokio`, `russh` (Apache-2.0, V32), `russh-keys`, `rusqlite` **nicht**
(kein Session-Zustand lokal, §5.3), `serde`/`serde_json`, `toml`, `zeroize`, DPAPI-Anbindung.
Nachrüstbar: `portable-pty` (MIT, V33) für ein `ssh.exe`-Backend.

**Frontend:** `@xterm/xterm` 6.0.0 mit `addon-fit`, `addon-webgl`, `addon-search`,
`addon-serialize`, `addon-unicode11` — keine transitiven Abhängigkeiten. Der Canvas-Renderer
ist in xterm 6 entfernt; der Fallback bei fehlendem WebGL ist der DOM-Renderer.

Rust-Version wird über `rust-toolchain.toml` festgeschrieben, damit alle Mitwirkenden
denselben Compiler nutzen.

### 11.2 Paket und Signatur

Tauris eigener Bundler erzeugt NSIS- und MSI-Installer. WebView2 ist auf Windows 11
vorinstalliert; für ältere Systeme bindet der Installer die Bootstrapper-Variante ein.

Unter Windows 11 **blockiert Smart App Control unsignierte Programme**, statt nur zu warnen.
Der Weg:

1. **winget und Scoop als Hauptinstallationsweg.** Beide verlangen keine Signatur, lösen
   keine SmartScreen-Warnung aus und setzen kein Mark-of-the-Web.
2. **SignPath Foundation** beantragen (kostenlos, für diesen Projekttyp vorgesehen). Als
   Herausgeber erscheint dann "SignPath Foundation", die Freigabe ist manuell je Release.
3. Fallback **Certum Open Source** (~60–105 € im ersten Jahr, Cloud-Variante wegen CI).

Auto-Update über Tauris Updater-Plugin mit signiertem Manifest und GitHub Releases. Solange
unsigniert: SHA256-Summen und Artifact Attestations veröffentlichen und den Zustand im README
benennen.

### 11.3 CI

Matrix, weil auf `windows-latest` kein brauchbares tmux existiert:

- **`ubuntu-latest`** — `cargo test` samt Integrationstests gegen echtes `sshd` + `tmux`.
  Der Backend-Code ist plattformunabhängig.
- **`windows-latest`** — `cargo test`, `cargo clippy -- -D warnings`, Tauri-Build (der
  NSIS-Bundler muss dort laufen), E2E über den WebDriver von Tauri.

`fail-fast: false`. `cargo audit` und `cargo deny` in einem eigenen Job mit
`continue-on-error`. `Cargo.lock` wird eingecheckt.

---

## 12. Konfigurationsformate

### 12.1 `SettingsStore`

TOML in `%APPDATA%\agentbridge\settings.toml`, mit `version` ab Tag 1. Beim Laden wird
`version` geprüft; unbekannt höhere Version → App startet schreibgeschützt mit Hinweis,
statt die Datei zu überschreiben.

```toml
version = 1

[[hosts]]
id = "h1"
label = "prod-20"
hostname = "192.0.2.20"
user = "u"
port = 22
auth = "key"                       # "key" | "agent" | "password"
key_path = "~/.ssh/id_ed25519"
tmux_socket = "agentbridge"
history_limit = 10000
repo_roots = ["/home/u/Projekt"]

[keymap]
"session.next" = "Ctrl+Shift+Down"

[ui]
last_session_id = "h1:ab_3f9a21"
terminal_cols = 200
terminal_rows = 50
```

Geheimnisse stehen **nicht** in dieser Datei, sondern in `Secrets` (§8.5).

### 12.2 `AgentProfiles`

Mitgeliefert als `profiles.toml` im Anwendungspaket, überschreibbar durch eine gleichnamige
Datei in `%APPDATA%\agentbridge`. Nur so ist das Versprechen aus §6.1 — "ein CLI-Update
erzwingt kein Code-Update" — einlösbar.

```toml
version = 1

[[profiles]]
id = "codex"
label = "Codex CLI"
command = "codex"                          # frei editierbar
path_prepend = ["~/.npm-global/bin", "~/.local/bin"]

[profiles.title]
busy    = "[\\u{2800}-\\u{28FF}]"          # Braille-Spinner
waiting = "Action Required|\\[ ! \\]"
idle    = ""                               # leer → "unbekannt"
```

Die Muster sind reguläre Ausdrücke und werden **nur gelesen**, nie ausgeführt. `command`
dagegen **wird ausgeführt**: Die Oberfläche zeigt beim Bearbeiten den vollständigen Befehl und
weist darauf hin, dass er auf der VM läuft. Eine Nutzerdatei ersetzt ein mitgeliefertes Profil
nur bei gleicher `id` und wird beim Erststart sichtbar gemeldet.

---

## 13. Teststrategie

Drei Ebenen. Ein handgeschriebenes Transport-Double, das tmux-Ausgaben nachbaut, prüft nur, ob
die eigene Annahme über tmux mit der eigenen Annahme über tmux übereinstimmt — und die Fehler,
die auftreten werden, sind genau die falschen Annahmen.

1. **Unit, ohne I/O** — `StatusDetector`, `TmuxFormatParser` (inkl. Titel-Injektion mit
   eingebettetem `\x1f` und Zeilenumbruch), `RemoteCommand`, Namensvergabe,
   `Keymap`-Konflikte. Für den Parser zusätzlich Property-Tests mit `proptest`.
2. **Integration gegen echtes `sshd` und `tmux`** auf Ubuntu:
   - Host-Key-Prüfung: unbekannter Host wird **ohne** Zustimmung abgelehnt (§8.1).
   - Injection-Regression: Branch `a;touch /tmp/pwned` und Anzeigename `it's "quoted"`
     anlegen, prüfen dass die Datei **nicht** existiert und die Metadaten korrekt zurückkommen.
   - Lint: keine String-Formatierung für entfernte Kommandos außerhalb `RemoteCommand`.
   - Kanal-Teardown: nach dem Schließen muss ein weiterer Kanal öffnen können (V2).
   - Poll-Schleife: nach hartem Abriss darf auf dem Server **kein** Prozess zurückbleiben (V14).
   - Namenskollision: `new-session` auf einen belegten Namen muss neu würfeln, nicht attachen.
   - Reattach: History und Viewport zusammensetzen, auf fehlende und doppelte Zeilen prüfen.
   - Flow Control: `yes` laufen lassen, prüfen dass nichts verworfen wird und Strg-C wirkt.
   - Semaphore: 3 parallele Git-Operationen plus ein `capture-pane` — Letzteres muss durchkommen.
3. **E2E** über Tauris WebDriver: Erststart, Sidebar-Rendering, ein Command-Roundtrip.

Das Transport-Double bleibt nützlich — als **Record/Replay** echter Sitzungen aus Ebene 2.

---

## 14. Umsetzung in drei Plänen

Jeder Plan endet mit etwas Benutzbarem und hat Abnahmekriterien.

### Plan 1 — Transport und ein Terminal

Tauri-Grundgerüst, `Transport`-Trait, `RusshTransport`, `SshAuth` (drei Wege),
`HostKeyVerifier`, `SshConfigParser`, `RemoteCommand`, `Preflight`, `TmuxClient`
(Grundlagen), `SessionController` (Attach ohne History-Restore), `TerminalView` mit xterm.js,
`Keymap`, minimale Hostverwaltung.

**Abnahme:** Ein Host aus `~/.ssh/config` wird verbunden (Schlüssel, Agent und Passwort je
einmal geprüft), `Preflight` läuft durch, eine Session wird angelegt, ein Agent-CLI gestartet
und interaktiv bedient (Maus, Bracketed Paste, Farben, Resize). Verbindung hart kappen →
Eingabe gesperrt, Zustand angezeigt. Neu verbinden → Session lebt, **der aktuelle Bildschirm
erscheint; hochscrollen zeigt bewusst noch keinen Verlauf.** Ein unbekannter Host-Key wird
ohne Zustimmung abgelehnt.

*Kein History-Restore in Plan 1* — der braucht `terminal-overrides` (§6.3) und den
`alternate_on`-Guard aus dem Poll und gehört in Plan 2.

### Plan 2 — Poll, Status, Sidebar, mehrere Sessions und Hosts

Status-Dauerkanal, `TmuxFormatParser`, `StatusDetector` inklusive OSC-9/777-Auswertung,
`SessionStore` (host-qualifiziert), Sidebar, `AgentProfiles`, `terminal-overrides`,
vollständiger Reattach nach §6.2, Größenmodell (§6.4), LRU und Semaphore (§4.2),
Mehrgeräte-Rückfrage (§6.6).

**Abnahme:** Acht Sessions über zwei Hosts, eine sichtbar. Statuspunkte wechseln korrekt für
Codex (alle drei Zustände) und zeigen für unbekannte Muster **unbekannt**. Tab-Wechsel löst
keinen Resize aus. Reattach stellt History und Bildschirm ohne Lücke und ohne Dopplung her.
Ein Abriss hinterlässt keinen Prozess auf der VM. Die neunte Session verdrängt per LRU.

### Plan 3 — Verwaltung, Worktrees, Auslieferung

`GitWorktrees`, Anlegen- und Verwaltungsdialoge (§7.3), Metadaten samt `session.json` und
Wiederherstellung (§5.2), `SettingsStore` mit Migration, `Secrets`, `Diagnostics`, Reconnect
mit Backoff, Paketierung, CI, winget/Scoop.

**Abnahme:** Session mit neuem Worktree und Branch anlegen; Session beenden lässt den Worktree
samt uncommitteter Änderungen unangetastet; Worktree entfernen zeigt den Dirty-State und
verlangt Bestätigung. Nach `kill-server` findet der Scan die Sessions wieder. Ein Installer
wird gebaut und installiert.

---

## 15. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| **Titelsemantik der Agent-CLIs bricht bei einem Update.** Undokumentiert; für Claude Code ist der Wartezustand ungemessen (V16b) | Muster als nutzerüberschreibbare Daten (§12.2); **unbekannt** als erstklassiger Zustand; zusätzlich OSC 9/777, das nicht an Textmustern hängt (V34) |
| **Rust-Einarbeitung.** Die Toolchain fehlt bisher auf dem Entwicklungsrechner | Der Rust-Anteil ist überwiegend Verdrahtung; die schwierigen Teile (tmux-Semantik, Reattach) sind in §2 und §6 bereits gelöst und sprachunabhängig |
| **Windows blockiert die unsignierte App** (Smart App Control) | winget/Scoop als Hauptkanal, SignPath früh beantragen (Wochen Vorlauf) |
| **Fremde SSH-Setups.** Entwickelt wird mit dem einfachsten Fall | Drei Auth-Zweige als Abnahmekriterium; `ssh.exe`-Backend über `portable-pty` bleibt nachrüstbar (§3.2) |
| **Resize vernichtet Remote-Scrollback** bei inline rendernden Agents (V12) | Debounce 300 ms, Hinweis in der Statusleiste (§6.4), kein Suchversprechen |
| **Vergleichbare Werkzeuge existieren.** `thurbox` (MIT, Rust, TUI) deckt Hosts, Sessions, Worktrees und Statuserkennung bereits ab; `cmux` (GPL) dasselbe als native macOS-App | Die Lücke ist **native Windows-Desktop-Anwendung statt TUI** — cmux ist Swift/AppKit und damit für Windows eine Neuentwicklung, thurbox ist bewusst terminalgebunden. Das ist die Positionierung im README, statt "es gibt nichts Vergleichbares" |

---

## 16. Offene Punkte

- **Claude Code:** Wartezustand im OSC-Titel ungemessen (V16b), ebenso das
  Alternate-Screen-Verhalten in der laufenden REPL (V16c). Vor Plan 2 nachzuholen.
- **`opencode`** war auf den Testsystemen nicht als Binärdatei auffindbar; sein Profil fehlt.
- **Titel im Alternate Screen:** ob tmux `#{pane_title}` dort weiter aktualisiert, ist
  ungemessen. Falls nicht, trägt für Alternate-Screen-Agents nur das OSC-9/777-Signal.
- **`russh` im Dauerbetrieb** mit 8 Kanälen ist von uns nicht gemessen; V3 wurde mit einer
  anderen Bibliothek erhoben. In Plan 1 nachzuholen.
- **Windows-OpenSSH-Agent über Named Pipe** mit `russh` ist ungetestet.
- **Zwei App-Instanzen desselben Nutzers gegen dieselbe VM** ist ungetestet.
- **Vollständiges Pane-Modell (v2)** statt der Ein-Pane-Annahme aus §6.7.

---

## 17. Herkunft und Lizenzen

`agentbridge` ist ein eigenständiges Projekt. Es übernimmt jedoch bewusst Ideen aus
**thurbox** (MIT, © 2026 Thurbeen), das dieselbe Aufgabe als TUI löst:

- Eigener tmux-Socket statt des Standard-Sockets (unabhängig auch hier hergeleitet, §6.0)
- Agent-Definitionen als Konfigurationsdaten statt als Code (§12.2)
- **OSC 9/777 und BEL als Aufmerksamkeitssignal** zusätzlich zum OSC-Titel (V34, §6.1) —
  diese Idee stammt eindeutig von dort

Wird darüber hinaus Quelltext übernommen, steht der MIT-Copyright-Vermerk in der betreffenden
Datei, und `THIRD_PARTY_LICENSES.md` führt Herkunft und Lizenz auf. Die eigene Lizenz wird vor der
ersten Veröffentlichung festgelegt; MIT oder Apache-2.0 sind mit allen genannten
Abhängigkeiten verträglich (`russh` ist Apache-2.0, `portable-pty` MIT, xterm.js MIT).
