# aidevbridge: Stand und offene Punkte

**Stand:** Version `0.2.0`, vor dem ersten Release; keine Releasefreigabe.
Das Repository ist seit dem 22.10.2026 öffentlich und beginnt mit einem
einzigen Anfangs-Commit. Die Versionen 0.1.1 und 0.1.2 erschienen nur
privat und noch unter dem Namen agentbridge; ihre Tags gibt es dort nicht.

Dieses Dokument führt den Stand und die offenen Punkte. Was die App kann,
steht im [README](../README.md#what-it-is), die Änderungen im
[CHANGELOG](../CHANGELOG.md). Die Doku liegt flach unter `docs/` (`specs/`,
`plans/`, `messungen/`); im Baum bleibt nur, was aktuell ist.

## Entscheidungen vom 20.10.2026

- **Name:** aidevbridge (klein) für Produkt, Fenstertitel, npm- und
  Cargo-Paket; Bibliothek `aidevbridge_lib`, Programm `aidevbridge.exe`,
  Kennung `io.github.itbrain258.aidevbridge`, Repository
  `ITBrain258/aidevbridge`. Der tmux-Socket auf den Hosts heißt weiter
  `agentbridge`, damit bestehende Sessions sichtbar bleiben; das Format von
  `settings.toml` bleibt. Die Einstellungen liegen im Ordner der Kennung,
  `%APPDATA%\io.github.itbrain258.aidevbridge\`; fehlt dort beim Start die
  `settings.toml`, kopiert die App die aus `%APPDATA%\agentbridge\`, und der
  alte Ordner bleibt liegen.
- **Frische Historie:** Die öffentliche Fassung entsteht als neues
  Repository mit einem Anfangs-Commit. Das private Repository behält die
  volle Historie.
- **Unsigniert:** Die Windows-Pakete sind zunächst nicht signiert. Das README
  erklärt SmartScreen und Smart App Control, und jede Veröffentlichung nennt
  die SHA-256-Werte aus `release-manifest.json` des Lieferlaufs.

## Gebaut

| Bereich | Stand |
| --- | --- |
| M0 Fundament | abgeschlossen mit 0.1.1 |
| UI v2 | abgeschlossen mit 0.1.2; seit 14.09. Farbwahl (7 Akzente auf 2 Grundtönen) und Einstellungsdialog |
| Stabilität und Verbindung | Kontroll- und Terminalverbindung je Host, Fristen, Kontrollreparatur, Korrekturen an Hostschlüsseln, Erststart und Hostverwaltung, RSA-Blinding |
| M1 Statuspunkt | gebaut bis auf das Tor: numerische Sessionbindung (tmux 3.0, 3.3a, 3.4, 3.6), Statuspille, Aufmerksamkeit; Claude Code über `claude agents --json`, Codex und Grok über den Panetitel |
| UX-Überarbeitung | gebaut nach der [Spec vom 11.10.](specs/2026-10-11-ux-ueberarbeitung-design.md): Kopieren und Einfügen wie in Windows Terminal samt OSC 52, Terminalmenü, Links, Suchleiste, Schriftgröße; Steuerzustand nur bei echtem Verlust, Selbstheilung für Schlüssel- und Agent-Hosts und Verlauf beim Anhängen; Arbeitsplatz, Schnellöffnen, Namensvorschlag, Anzeigename, ziehbare Seitenleiste; fünf Einstellungsbereiche; tmux 3.6 |
| Dynamisches Raster | Schritt 0, 1 und 3 abgeschlossen nach der [Spec vom 19.10.](specs/2026-10-19-dynamisches-raster-design.md): bis zu 9 Kacheln, höchstens 8 je Host, je Host höchstens 4 Öffnungen zugleich („Opening…“), Tauschen per Zug am Kopf, Größe per Spalt, Maximieren verbirgt die übrigen Kacheln statt sie zu schließen, Wartet-Spur mit Wartezeit, Kachelnummer in Liste und Spur |
| Windows-Lieferung | `npm run build:windows` baut MSI, NSIS und ZIP mit Lizenzbeigaben, unsigniert; letzter vollständiger Lauf für 0.2.0 nach dem Neubinden der Lizenzauswahl |

## Letzte Prüfung

Am 21.10.2026 auf dem Endstand vor der Veröffentlichung: 2631
Frontend-Tests in 49 Dateien, TypeScript- und Vite-Build und 72
Skripttests grün; Rust: fmt, Clippy mit `-D warnings` und `cargo test --all`
grün, 643 Tests bestanden, die 11 VM-Abnahmetests ignoriert.
`node scripts/release-licenses.mjs check` und `npm run build:windows` grün
(MSI, NSIS und ZIP, unsigniert). Live-Suiten gegen eine eigene Test-VM
(tmux 3.6) mit eigenem Testsocket: Bibliothek 575, `integration_commands`
23, `socket_abort_probe` 13, `integration_transport` 8, `test_environment`
7, `integration_tmux` 5, `capabilities_acl` 5, `integration_pty` 4,
`acl_runtime` 2, `integration_preflight` 1; VM-Abnahme: 11 bestanden, der
Passwortzweig ohne Passwort übersprungen. Fensterabnahme an einer
abgeschotteten Testinstanz der umbenannten App: Sie übernahm die
`settings.toml` aus einem alten Testordner, Host und Kacheln erschienen wie
zuvor, der alte Ordner blieb unverändert. Ein OSC-8-Link mit abweichendem
Text zeigte vor dem Öffnen das volle Ziel; Esc schloss die Rückfrage, ein
Doppelklick öffnete nichts, auch nicht bei einem langen Ziel. Ein neues
Logozeichen für den Erststart (bisher „a“) ist ein offener
Gestaltungspunkt (Punkt 5).

## Offen bis zum Release

In dieser Reihenfolge:

1. **M1-Tor** ([MVP-Spec](specs/2026-09-05-mvp-und-statuspunkt-design.md)
   §3.4 mit Nachtrag vom 13.09.; am neuen Raster mit den Bedingungen der
   [Raster-Spec](specs/2026-10-19-dynamisches-raster-design.md) §10.2):
   acht Sessions auf zwei unabhängigen Endpunkten, vier flutende Kacheln,
   eine gültige Statusänderung binnen 4 s sichtbar. Ein Kontrollausfall
   markiert den Status als veraltet und erhält Liste und Terminals, eine
   Neuanlage gleichen Namens wird über die IDs erkannt, zwischen den Polls
   läuft kein Überwachungsprozess, ein Kachelwechsel ohne Größenänderung
   sendet kein Resize. Ablauf und Log:
   [Handabnahme §9](abnahme-handarbeit.md#9-m1-tor). Die aktuellen
   Agentversionen weichen von den gemessenen ab (Punkt 3).
2. **Erstes Release** nach dem M1-Tor (Entscheidung vom 22.10.; Tag und
   Release setzt der Maintainer): `v0.2.0` ist der Tag auf dem Commit, aus
   dem die Pakete gebaut sind, dazu das ZIP aus `npm run build:windows` mit
   seinem SHA-256-Wert; MSI und Setup-EXE erst nach der Installerabnahme
   (Punkt 6). Das Repository ist seit dem 22.10. öffentlich, mit privatem
   Meldeweg für Sicherheitslücken (Private Vulnerability Reporting),
   Warnungen von Dependabot, Secret Scanning mit Push Protection und GitHub
   Actions für `.github/workflows/ci.yml`; Workflows aus Pull Requests
   externer Beitragender laufen erst nach Freigabe. Die Schlüssel unter
   `src-tauri/tests/fixtures/rsa-signing/`, in `src-tauri/src/ssh/auth.rs`
   und in `vendor/russh` sowie der synthetische Schlüssel in
   `scripts/m1-error-profile.py` sind Testdaten.
3. **Statusquelle vor dem Release-Kandidaten:**
   - Codex-Einstellungen `tui.animations` und `tui.terminal_title` lesend
     berücksichtigen.
   - Über die Versionsbindung entscheiden: feste Liste oder Titelform mit
     Rückfall auf „Unknown“ und Version im Tooltip.
   - Die Formen gegen aktuelle Agentversionen neu messen. Gemessen sind
     Claude Code 2.1.269 und 2.1.270, Codex 0.154.0 und Grok 1.0.30 (der
     Freigabetitel mit 1.0.13); neuere Versionen wie Claude Code 2.1.296,
     Codex 0.156.1 und Grok 1.0.44 sind nicht gemessen. Dabei auch Freigabe
     und langen Hintergrundbefehl von Grok nachmessen.
   - Titelquelle härten: `/proc/<pid>/exe` als Identität, Größengrenze je
     Titel, Socket als Argument, VM-Test mit einem Attrappen-Agent.
4. **M2:** History-Restore und Auto-Reconnect sind mit der UX-Überarbeitung
   gebaut ([Spec](specs/2026-10-11-ux-ueberarbeitung-design.md) §5.3–§5.6),
   die Selbstheilung nur für Schlüssel und ssh-agent. Offen ist das Tor am
   Fenster: 10 Minuten Ruhezustand, danach ohne Klick verbunden, der Verlauf
   ist lesbar ([Handabnahme §6](abnahme-handarbeit.md#6-wiederverbinden)),
   auch mit 8 + 1 Kacheln
   ([Raster-Spec](specs/2026-10-19-dynamisches-raster-design.md) §10.2); das
   prüft der Maintainer am Gerät, über Remote Desktop geht es nicht.
5. **M3:** fremde Sessions auf dem Standard-Socket sehen und bedienen, mit
   gesperrtem Beenden ([Roadmap](plans/2026-09-05-roadmap-bis-release.md)
   S3.1); die übrige Windows-Politur nach S3.2 (Protokolldatei, globaler
   Diagnosetext; Mindestgröße, Fensterlage und Icon sind erledigt), dazu ein
   neues Logozeichen für den Erststart (Entscheidung vom 21.10.); die
   Rust-Meldung RUSTSEC-2023-0071 zu `rsa`, eingeordnet in
   [`SECURITY.md`](../SECURITY.md), und eine echte RSA-Abnahme; Signatur der
   Pakete und winget.
6. **Lieferung:** Die [Lizenzauswahl](release/license-selection.windows-x64.json)
   ist für 0.2.0 neu gebunden: `@xterm/addon-web-links`, die Tauri-Module
   `window`, `dpi` und `image` und die tslib-Helfer sind aufgenommen; die
   geänderten eigenen Quellen, die erzeugten Permissions, `pageant` und die
   Änderungsvermerke in `vendor/russh` sind neu gebunden.
   `npm run build:windows` lief danach vollständig durch (MSI, NSIS und ZIP,
   unsigniert). Jede weitergegebene Kopie trägt die Lizenzhinweise: An andere,
   auch an Beta-Tester, geht nur das ZIP oder ein Installer aus
   `npm run build:windows`, beide mit dem Ordner `licenses/`. Die nackte EXE
   aus `npm run build:app` bleibt auf dem eigenen Rechner. Ändert sich ein
   gebundener Eingang, vor dem nächsten Lauf die Änderungen auf neues
   Fremdmaterial prüfen und nur die betroffenen Einträge neu binden (README,
   „Windows packages“). Offen ist die Installerabnahme: Anzeige der
   Lizenzseite, WebView2-Bedingungen, Hinweise der Installer-Stubs (jeder
   Lauf meldet sie als `pending`: `nsis_msi_payload`, `installer_terms_ui`,
   `installer_stub_notices`; dazu `native_import_family_review` für die
   Durchsicht der nativen Importe der EXE und
   `product_and_windows_acceptance` für die Abnahme am Fenster); bis dahin
   erscheint nur das ZIP, MSI und Setup-EXE bleiben unveröffentlicht. Offen
   ist auch ein eingechecktes Werkzeug zum Neubinden: Für 0.2.0 band ein
   Einmalprogramm, das nicht im Repository liegt, nur die geänderten Einträge
   neu; für künftige Releases fehlt es noch. Beim nächsten Neubinden
   mitnehmen: drei Fehlertexte des Backends sind noch deutsch
   (`run_checked` und `create_session` in `src-tauri/src/tmux/client.rs`,
   `list_ssh_keys` in `src-tauri/src/commands.rs`); zwei Kommentare
   verweisen auf Dateien, die es nicht mehr gibt (`src/views/sidebar.ts`
   auf einen Entwurf der Seitenleiste, `src-tauri/src/commands.rs` auf
   `src/views/host-list.ts`); die [ZIP-Anleitung](release/windows-zip-readme.txt)
   spricht noch in Prüfbegriffen („an execution without the application
   installer“, „product acceptance“); eine `allowScripts`-Regel für esbuild
   in `package.json` nähme die Warnung von npm 12 beim `npm ci`. Die
   Release-Binaries enthalten
   die Pfade des Cargo-Registers der Baumaschine (Panic-Orte von Kisten aus
   crates.io unter `<Profil>\.cargo\registry\src\…`); damit steht der
   Benutzername des Bauprofils in den Panic-Pfaden der Binaries. Das ist
   hingenommen. Der Lieferlauf weist `RUSTFLAGS` und `.cargo/config.toml`
   ab; ein Lauf mit neutralem `CARGO_HOME` wäre der Weg, das zu ändern.
7. **Echte Abnahmen:**
   - die [Handabnahme](abnahme-handarbeit.md) am Windows-Fenster: echte
     Tastatur, Rechtsklick, Skalierung 100 und 150 % am echten Bildschirm,
     Standby und Netzwechsel, Bildschirmleser und die 14 Farbthemen.
   - die offenen Punkte des UI-v2-Tors
     ([Spec](specs/2026-09-05-ui-v2-design.md) §17): Dichte mit
     20 Sessions unter 4 Hosts, WebGL unter 10 Minuten Flutung, Skalierung
     125 und 150 %, Farbwechsel bei laufenden Kacheln, echter Erststart,
     Tastatur in Fingerabdruck- und Sessiondialog.
   - der Zweitrechner: Installation nur nach README, Anmeldung mit `id_rsa`,
     ed25519 und Passwort, handgestartete Session mit Status, Deinstallation.
8. **Raster:** Schritt 3 ist gemessen und abgenommen: Lastmessung mit 4, 6
   und 8 flutenden Kacheln je Host
   ([Messbericht](messungen/messung-2026-10-21-acht-kacheln.md)): Unter
   begrenzter Dauerflut hält jede Kachelzahl die Startschwellen
   (Statuslatenz p95 höchstens 3,2 s, kein Kanalverlust, JS-Heap nach
   erzwungener Bereinigung höchstens +6 % je Lauf, Speicherzuwachs je
   Kachel von 6 auf 8 das 1,32-Fache von 4 auf 6), unter `yes` geht kein
   Kanal mehr verloren, und bei vier so flutenden Kacheln (die Bedingung
   des M1-Tors) bleibt die Statuslatenz mit 4,0 s im Rahmen;
   Fensterabnahme am 21.10.: Neustart mit 8 + 1 Kacheln (je Host höchstens
   4 Öffnungen zugleich; eine Eingabe in eine wartende Kachel kommt nicht
   an, nach dem Anhängen schon), Maximieren und Zurückholen sowie Ersetzen
   an der Grenze auch unter Flut, schnelle Wahl und beide Grenzhinweise
   bestanden.
   Schritt 2 (Bewegung) mit eigenem Plan. Am Fenster nicht angesehen:
   150 %, zweiter Bildschirm (Spec §8.6), Ab- und
   Andocken, die Wartet-Spur mit einer echt wartenden Claude-Session, ob die
   Windows-Animationseffekte aus sind (WebView2 meldet
   `prefers-reduced-motion`). Nur durch Tests und Durchsicht gesichert:
   Klicks in der Hinweisbox eines Hosts mit Anmeldefehler, der Neustart mit
   gespeicherter Seitenleistenbreite unter reduzierter Bewegung, das
   Loslassen nach Alt+Tab. Bekannte Fehler:
   - Bei 200 px Kachelbreite mit Statuspille bleibt für Titel, Host und den
     Größenchip kein Platz, und der Hinweis an der Grenze verdeckt bei 9
     Kacheln die Köpfe der ersten beiden, bis er geschlossen wird
     (Optik-Runde, Spec §12).
   - Beim Start mit Kacheln mehrerer Hosts ändert die Liste eines später
     verbindenden Hosts die Größe der Kacheln früher verbundener, je Kachel
     ein `resize_terminal` (Spec §4.6, §4.7); Codex verliert dabei seinen
     Verlauf.
   - Eine noch gesperrte Session, die nach dem Neuverbinden ihres Hosts neu
     montiert wird, erscheint mit sichtbarer Sperrleiste und bekommt danach
     ein zusätzliches `resize_terminal`; „Reconnect“ in der Sperrleiste
     montiert dagegen gleich in Endgröße.
   - Ein Tipp per Touch oder Stift auf eine Session eines anderen Hosts kann
     verloren gehen; die Korrektur gilt für die Maus.
   - Die Fensterlage wird auch unterhalb der Mindesthöhe von 600 px
     wiederhergestellt.
   - Acht Kacheln, die gleichzeitig ungebremst ausgeben, machen die
     Oberfläche zäh (Statuslatenz p95 5,0 s, Ereignisschleife p95 215 ms);
     der Renderer ist der Engpass. Offen, ob ein binärer Ausgabekanal statt
     JSON-Zahlenfeldern oder weniger Neuzeichnen das behebt.
   - Eine große Einfügung in ein Programm, das stdin nicht liest, kann
     Eingaben, Größenänderungen und das Schließen anderer Terminals
     derselben Verbindung aufhalten (vorbestehend, bei der Flusskontrolle
     gefunden).

Push, Tag und Release entscheidet der Maintainer jeweils eigens.

## Feste Vorgaben

Aus den Specs und ihren Nachträgen; bei Abweichung gilt die Spec.

- Windows-Client: nur die App, kein Python, kein weiterer Installer.
- Auf den Hosts nur SSH, tmux und ein von Hand gestarteter Agent. Kein Hook,
  kein Watcher, keine Konfigurationsänderung, kein eigener Startdialog.
  tmux und die übrigen Voraussetzungen richtet der Nutzer selbst ein; die App
  installiert nichts, auch nicht auf Knopfdruck (Entscheidung vom 15.09.,
  siehe README „Host requirements“).
- Status: Das Inventar liefert unbekannt und beendet. `claude agents --json`
  wird nur gelesen und bindet an `pid == pane_pid` oder ein direktes Kind der
  Pane-Shell, nie über den Namen. Codex und Grok zählen über den Panetitel,
  nur in gemessenen Formen. agy, OpenCode und Gemini CLI bleiben „Unknown“,
  bis es ein tragfähiges Signal gibt.
- Der Poll führt die Sessionliste nicht: kein Hinzufügen, Entfernen,
  Umbenennen oder Schließen von Kacheln.
- Passwörter und Passphrasen werden nicht gespeichert, auch nicht im
  Arbeitsspeicher über einen Verbindungsversuch hinaus. Selbstheilung gibt es
  deshalb nur für Schlüssel und ssh-agent.
- Eigene tmux-Serveroptionen auf dem App-Socket sind erlaubt
  (`history-limit`, `remain-on-exit`, `terminal-overrides`); `mouse` und
  `set-clipboard` setzt die App nicht. Der App-Socket heißt `agentbridge`,
  auch nach der Umbenennung.
- Tests gegen echte Hosts nur mit eigenem Testsocket, nie mit produktiven
  Sessions ([CONTRIBUTING](../CONTRIBUTING.md#live-tests-against-a-test-host)).
- Jede weitergegebene Kopie trägt die Lizenzhinweise (Punkt 6).
- Das Tor sind die lokalen Prüfungen aus dem
  [README](../README.md#tests); `.github/workflows/ci.yml` führt sie bei
  jedem Push und Pull Request aus.

## Wo was steht

- [MVP- und Statusspec](specs/2026-09-05-mvp-und-statuspunkt-design.md):
  Zuschnitt, Tore, Statusdesign, Nachträge vom 13.09., 14.09. und 15.09.
- [UX-Überarbeitung](specs/2026-10-11-ux-ueberarbeitung-design.md) vom
  11.10.: Zwischenablage, Verbindung und Selbstheilung, Arbeitsplatz,
  Tastatur, Einstellungen, tmux 3.6. Sie geht den älteren Specs vor, wo sie
  ihnen widerspricht (§4); §14 nennt, was bewusst fehlt.
- [Dynamisches Raster und Wartet-Spur](specs/2026-10-19-dynamisches-raster-design.md)
  vom 19.10.: bis zu 9 Kacheln, Grenzen je Host, Tauschen, Spalt, Bewegung,
  Wartet-Spur, die Lastmessung (§12). Sie geht den älteren Specs vor, wo sie
  ihnen widerspricht (§11).
- [Gesamtspec](specs/2026-07-25-agentbridge-design.md): Transport,
  tmux, Kanalmodell; gilt, wo die MVP-Spec nichts anderes sagt.
- [UI-v2-Spec](specs/2026-09-05-ui-v2-design.md) mit Mockup, dazu
  die Specs zu [Einstellungen](specs/2026-09-14-einstellungen-geruest-design.md)
  und [Farbwahl](specs/2026-09-14-farbwahl-design.md). Für
  Verhalten (Fokus, Resize, Maximieren, Leer- und Fehlerzustände) gilt das
  [Designsystem v1](specs/2026-07-27-agent-management-shell-designsystem.md)
  weiter.
- [Roadmap](plans/2026-09-05-roadmap-bis-release.md): Wo und Wie
  für M2 und M3.
- [Handabnahme](abnahme-handarbeit.md): was nur am echten Fenster prüfbar
  ist, mit Log.
- Messberichte `messungen/messung-*.md`: die, die Specs, Code und Tests
  zitieren; ihre Rohdaten unter `messungen/fixtures/`, die Messhelfer
  `scripts/m1-*`. Die Messhelfer sind Nachweiswerkzeuge, kein Produktteil.
  Rohdaten und Messskripte nennen mitunter Commits der privaten
  Entwicklungshistorie; dieses Repository beginnt mit einem Anfangs-Commit.
- Lieferung unter `release/`: die
  [Lizenzauswahl](release/license-selection.windows-x64.json) mit den
  Entscheidungsberichten und Inventaren, die sie bindet, die ausgelieferten
  Lizenztexte, die Quellarchive der Installerwerkzeuge sowie die Texte für
  Installer und ZIP; dazu `THIRD_PARTY_LICENSES.md` im Wurzelverzeichnis.
  Die datierten Berichte und Inventare vom 12.09., die Lizenzauswahl und die
  Inventarskripte unter `scripts/` nennen als Herkunft Commits der privaten
  Entwicklungshistorie; sie sind hash-gebunden und bleiben, wie sie sind.
- russh-Patch: [Herkunft, Umfang und Lizenz](../vendor/russh/AGENTBRIDGE-PATCH.md)
  und der [Patchbericht](reviews/2026-09-11-neutral/russh-channel-close-patch.md)
  zum Kanalschluss.
- [`SECURITY.md`](../SECURITY.md): Meldeweg und Einordnung bekannter
  Meldungen. [`CONTRIBUTING.md`](../CONTRIBUTING.md): Bauen, Tests,
  Live-Tests und Sprachregel.
