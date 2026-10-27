# aidevbridge: Stand und offene Punkte

**Stand:** Version `0.2.3`, Release am 26.10.2026: Sie bringt die
macOS-Lieferung (Universal-DMG, ad-hoc signiert); die App selbst ist
unverändert. Der Tag `v0.2.3` steht auf `95b17ae`; der Workflow hat das DMG
gebaut, auf Apple silicon und Intel installiert und gestartet und an das
Release gehängt. Seit dem 26.10. baut der Workflow `packages.yml` bei jedem
Tag alle Installer, auch MSI, Setup-EXE und ZIP; die Windows-Pakete für 0.2.3
hängt ein Handlauf mit dem Tag an. Davor: Version `0.2.2`, Release am 25.10.2026 mit
MSI, Setup-EXE und ZIP, unsigniert. Es bringt die Sessions auf tmux' Standard-Socket (M3.1);
ihre Abnahme ist bestanden, die Statuslatenz erst mit den Korrekturen vom
27.10., die noch in keinem Release sind. `0.2.1`
erschien am selben Tag. Das erste Release, `0.2.0`, erschien am 22.10. auf
Entscheidung des Maintainers vor dem M1-Tor und vor der Installerabnahme;
Installerabnahme, M1- und M2-Tor sind seitdem bestanden (gemeldet am 24.10.).
Das Repository ist seit dem 22.10.2026 öffentlich und beginnt mit einem
einzigen Anfangs-Commit. Die Versionen 0.1.1 und 0.1.2 erschienen nur
privat und noch unter dem Namen agentbridge; ihre Tags gibt es dort nicht.

Auf dem Branch `claude/intelligent-rubin-jygw4u` liegt die Umsetzung des
Code-Reviews vom 26.10. an 0.2.3 ([Plan](plans/2026-10-26-review-umsetzung.md)),
noch ohne Release: Sicherheits- und Fehlerkorrekturen in Backend und
Frontend, eine gehärtete CI mit Audit und Build-Provenienz, `SECURITY.md` mit
bekannten Grenzen und akzeptierten Risiken; beide Lizenzauswahlen sind am
27.10. neu gebunden. U1, U2 und U5 sind nach Empfehlung entschieden, U3 und
U4 warten auf den Maintainer; offen sind außerdem die Handabnahme und die
CI auf drei Systemen (Punkt 10).

Auf dem Branch `feat/android` liegt die Android-App nach der
[Spec vom 27.10.](specs/2026-10-27-android-design.md), noch ohne Release und
ohne Abnahme am Gerät: Backend und Oberfläche für Android, Signatur, Workflow
`android.yml` bis Google Play, Store-Eintrag und
[Anleitung](android-veroeffentlichung.md). Offen sind die Schritte des
Maintainers (Play-Konto, Test am Telefon, Bildschirmfotos, Secrets) und die
Android-Lizenzauswahl ([Plan](plans/2026-10-27-android.md), Phase 6).

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

## Entscheidungen vom 23.10.2026

- **Keine feste Versionsbindung:** Die Statusformen werden gegen die jeweils
  neueste Agentversion gemessen; jede Version zählt, solange ihre Ausgabe eine
  gemessene Form hat, sonst „Unknown“. Keine Version im Tooltip.
- **Grok vorerst nicht:** Messungen und M1-Tor nur mit Claude Code und Codex.
  Die Titelregeln für Grok bleiben im Code, sind aber nicht erneut gemessen.

## Entscheidungen vom 25.10.2026 (macOS)

Nach der [Spec vom 25.10.](specs/2026-10-25-macos-lieferung-design.md):

- **macOS kommt dazu:** ein Universal-DMG für Apple silicon und Intel,
  macOS 11 und neuer.
- **Ad-hoc signiert:** Developer ID und Notarisierung sind im Workflow
  vorbereitet und greifen, sobald die Apple-Secrets im Repository liegen.
- **Lizenzbeigaben gleichwertig:** eigene, gebundene macOS-Auswahl, aus der
  Windows-Auswahl abgeleitet.
- **Release automatisch:** Ein Tag baut das DMG in der CI und hängt es an das
  Release des Tags; gibt es keins, legt der Workflow es veröffentlicht an.
  Der Maintainer lädt für macOS nichts von Hand hoch.
- **Nachtrag 26.10., alle Installer:** Bei jedem Release baut, testet und
  veröffentlicht die CI alle Pakete, auch die für Windows; von Hand lädt der
  Maintainer nichts mehr hoch.

## Entscheidungen vom 26.10.2026 (Code-Review)

Nach dem [Umsetzungsplan](plans/2026-10-26-review-umsetzung.md):

- **Leitlinie:** Funktionierendes wird nicht eingeschränkt. Kostet eine
  Härtung Funktion, bleibt die Funktion, und das Restrisiko steht in
  [`SECURITY.md`](../SECURITY.md) unter „Known limitations and accepted
  risks“.
- **Bleibt so:** der SHA-1-Rückfall bei Servern, die nur `ssh-rsa`
  anbieten; keine erneute Prüfung des Hostschlüssels beim Rekey, ohne
  eigenen russh-Patch; mehrere Instanzen, ohne Single-Instance-Plugin, dafür
  mit dauerhaftem Schreiben und Zusammenführen von `settings.toml`.
- **Ausgeschlossen:** S2 und S5; OSC 52 bleibt damit unberührt.
- **Stand der Fragen U1 bis U5 am 27.10.:**
  - U1, nach Empfehlung A: Das portable ZIP behält die WiX- und
    NSIS-Quellarchive. Ein eigener Lizenzsatz für das ZIP kann mit der
    nächsten Neuableitung der Lizenzen kommen. Der Maintainer kann noch
    widersprechen.
  - U2, nach Empfehlung a: Die Vorbedingung steht in `SECURITY.md` und in
    Punkt 9. Bevor `APPLE_*`-Secrets hinterlegt werden, wandern Signatur und
    Notarisierung in einen eigenen Schritt oder Job, der nur die gebaute App
    bekommt, denn der Bauschritt führt die Lifecycle-Skripte von npm, die
    `build.rs` und die Proc-Makros mit den Secrets im Environment aus. Der
    Maintainer kann noch widersprechen.
  - U3, offen: Batch 9 (`commands.rs` in `commands/hosts.rs` und
    `commands/inventory.rs` teilen) ist nicht gelaufen und braucht das Ja
    des Maintainers; die beiden neuen Dateien kämen dann in die Lizenzbäume
    (Punkt 10).
  - U4: Die Prüfung beim Rekey wird bei russh upstream nur nach
    ausdrücklichem OK des Maintainers vorgeschlagen; eingereicht ist nichts.
  - U5: Die Vorauseingabe bleibt. Endgültig entschieden wird an der
    [Handabnahme §10](abnahme-handarbeit.md#10-änderungen-aus-dem-code-review-vom-2610),
    Schritt 3.

## Gebaut

| Bereich | Stand |
| --- | --- |
| M0 Fundament | abgeschlossen mit 0.1.1 |
| UI v2 | abgeschlossen mit 0.1.2; seit 14.09. Farbwahl (7 Akzente auf 2 Grundtönen) und Einstellungsdialog |
| Stabilität und Verbindung | Kontroll- und Terminalverbindung je Host, Fristen, Kontrollreparatur, Korrekturen an Hostschlüsseln, Erststart und Hostverwaltung, RSA-Blinding |
| M1 Statuspunkt | abgeschlossen, Tor bestanden (automatisiert am 23.10., am Fenster gemeldet am 24.10.): numerische Sessionbindung (tmux 3.0, 3.3a, 3.4, 3.6), Statuspille, Aufmerksamkeit; Claude Code über `claude agents --json`, Codex und Grok über den Panetitel. Seit 23.10. gemessen gegen Claude Code 2.1.309 und Codex 0.163.0/0.164.0 ([Messung](messungen/messung-2026-10-23-agentversionen.md)), Agent über `/proc/<pid>/exe`, Codex-Einstellungen gelesen, Größengrenzen, VM-Test mit Attrappen |
| UX-Überarbeitung | gebaut nach der [Spec vom 11.10.](specs/2026-10-11-ux-ueberarbeitung-design.md): Kopieren und Einfügen wie in Windows Terminal samt OSC 52, Terminalmenü, Links, Suchleiste, Schriftgröße; Steuerzustand nur bei echtem Verlust, Selbstheilung für Schlüssel- und Agent-Hosts und Verlauf beim Anhängen; Arbeitsplatz, Schnellöffnen, Namensvorschlag, Anzeigename, ziehbare Seitenleiste; fünf Einstellungsbereiche; tmux 3.6 |
| Dynamisches Raster | Schritt 0, 1 und 3 abgeschlossen nach der [Spec vom 19.10.](specs/2026-10-19-dynamisches-raster-design.md): bis zu 9 Kacheln, höchstens 8 je Host, je Host höchstens 4 Öffnungen zugleich („Opening…“), Tauschen per Zug am Kopf, Größe per Spalt, Maximieren verbirgt die übrigen Kacheln statt sie zu schließen, Wartet-Spur mit Wartezeit, Kachelnummer in Liste und Spur |
| M3.1 Standard-Socket | gebaut nach der [Spec vom 25.10.](specs/2026-10-25-standard-socket-design.md) und mit 0.2.2 ausgeliefert: Sessions auf tmux' Standard-Socket als Gruppe „tmux sessions“, Anhängen nur über den Wächter mit `-E`, kein Beenden, Schalter „Show tmux sessions“ je Host; Abnahme bestanden ([Bericht](messungen/messung-2026-10-25-m31-abnahme.md)): Punkt 1 bis 5 am 25.10., die Statuslatenz unter Last erst mit den Korrekturen vom 27.10. (parallele Abfrage, Takt ab dem Beginn), die mit dem nächsten Release kommen |
| Windows-Lieferung | `npm run build:windows` baut MSI, NSIS und ZIP mit Lizenzbeigaben, unsigniert; letzter vollständiger lokaler Lauf für 0.2.2 nach dem Neubinden der Lizenzauswahl. Seit 26.10. baut der Workflow `packages.yml` sie bei jedem Tag, installiert jedes Paket auf einem frischen Runner, startet die App und hängt sie an das Release |
| macOS-Lieferung | gebaut nach der [Spec vom 25.10.](specs/2026-10-25-macos-lieferung-design.md) und mit 0.2.3 ausgeliefert: `npm run build:macos` baut ein Universal-DMG, ad-hoc signiert, und prüft Bundle und DMG; [macOS-Lizenzauswahl](release/license-selection.macos-universal.json) mit 400 Komponenten, `prepare`/`check` grün; in der CI Vorschau bei jedem Push, Release-Bau mit Testinstallation auf Apple silicon und Intel am Tag |
| Review vom 26.10. | umgesetzt auf dem Branch `claude/intelligent-rubin-jygw4u` nach dem [Plan](plans/2026-10-26-review-umsetzung.md), Batches 1 bis 8 und 10 bis 20; Batch 9 wartet auf U3. Noch kein Release |
| Android | gebaut auf `feat/android` nach der [Spec vom 27.10.](specs/2026-10-27-android-design.md): Projekt `src-tauri/gen/android` (API 36, ab Android 7.0), Ordner der App statt `~/.ssh`, Schlüssel auf dem Gerät, kompakte Ansicht und Touch-Leiste, Workflow `android.yml` mit Signatur im eigenen Job, GitHub-Release und Play-Upload, Store-Eintrag und `PRIVACY.md`. Lokal gebaut und signiert für arm64 und x86_64 am 27.10.; nicht am Gerät abgenommen, kein Release ([Plan](plans/2026-10-27-android.md)) |

## Letzte Prüfung

Am 27.10.2026 für den Branch der Review-Umsetzung mit den Korrekturen aus
der M3.1-Abnahme (`fix/m31-abnahme` hineingeführt) und vier Korrekturen aus
der Durchsicht beider Pull Requests: Einfügen vor dem Anhängen wird
verworfen statt gepuffert, `ui_settings` wird nacheinander geschrieben, der
Releasetext nennt auch eine schon vollständige Plattform mit gleichen Bytes,
und ein Handlauf mit Tag teilt die Warteschlange mit dem Lauf des Tags. Auf
dem Rechner mit 8 GB Arbeitsspeicher: `tsc`, 2800 Frontend-Tests in 52
Dateien, Vite-Build und 115 Skripttests grün; Rust fmt, Clippy mit
`-D warnings` und `cargo test --lib` mit `-j 2` grün, 647
Bibliothekstests. Integrations- und Live-Tests liefen dafür nicht neu. Die
Lizenzauswahl ist für die seit dem Neubinden geänderten Quellen vor dem
nächsten Release neu zu binden; offen bleibt die Handabnahme §10 am Fenster.

Am 27.10.2026 für den Branch der Review-Umsetzung, in einem Linux-Container
als root (kein Windows, kein macOS): Rust fmt, Clippy mit `-D warnings` und
`cargo test --locked --all --no-fail-fast` grün, 642 Bibliothekstests; 2797
Frontend-Tests in 52 Dateien, `tsc`, Vite-Build und 112 Skripttests grün,
drei davon nur unter Windows und hier übersprungen. `cargo audit` meldet nur
RUSTSEC-2023-0071 und die zehn erwarteten Warnungen aus `SECURITY.md`,
`npm audit` nichts; `vendor/` ist unverändert. Nach dem Neubinden sind
`prepare` und `check` für beide Lizenzauswahlen grün. Der letzte Live-Lauf
auf dem Stand `7b961cf` ging gegen einen lokalen Linux-Testhost im
Container mit OpenSSH 9.6 und tmux 3.4, auf eigenen Testsockets mit
`--test-threads=4`: `integration_commands` 23, `socket_abort_probe` 13,
`integration_transport` 8 (mit RSA-Schlüssel), `test_environment` 7,
`integration_tmux` 6, `capabilities_acl` 6, `acl_runtime` 4,
`integration_pty` 4, `integration_default_socket` 2,
`integration_status_title` und `integration_preflight` je 1 grün. Der
Listentest in `integration_default_socket.rs` braucht tmux 3.3a oder 3.6
und meldet auf 3.4 wie vorgesehen ein SKIP (Punkt 10). Die VM-Abnahme
(`acceptance_vm` mit `--include-ignored`) gegen denselben Host: 11 von 11
grün, der ssh-agent-Zweig mangels Agent übersprungen; vorher scheiterten
unter Linux neun der elf, weil der Test die Windows-Herkunft der App fest
einsetzte und `list_sessions` als bloße Liste las. Offen sind die CI auf
Windows, Ubuntu und macOS und die Handabnahme am Fenster.
Am 27.10.2026 für die Korrekturen aus der M3.1-Abnahme (Zweig
`fix/m31-abnahme` über `main` mit 0.2.3), auf dem Rechner mit 8 GB
Arbeitsspeicher: Rust fmt, Clippy mit `-D warnings` und `cargo test --all
--no-fail-fast` grün, 611 Bibliothekstests; 2691 Frontend-Tests in 49 Dateien,
TypeScript- und Vite-Build und 94 Skripttests grün. Live gegen beide Test-VMs
auf eigenen Testsockets mit `--test-threads=4` grün, je 43 Tests; im ersten
Lauf auf 192.0.2.20 scheiterte einmal
`killing_a_session_deliberately_emits_no_connection_lost_event`, danach
einzeln dreimal und im vollen Lauf grün. Am Fenster einer Testinstanz am echten
Standard-Socket die [Nachmessung](messungen/messung-2026-10-25-m31-abnahme.md#nachmessung-am-2710-mit-den-korrekturen).
`node scripts/release-licenses.mjs check` meldet die geänderten Quellen als
ungebunden; das Neubinden gehört wie immer zum nächsten Release.

Am 25.10.2026 für 0.2.2, auf dem Rechner mit 8 GB Arbeitsspeicher: 2691
Frontend-Tests in 49 Dateien, TypeScript- und Vite-Build und 76 Skripttests
grün; Rust fmt, Clippy mit `-D warnings` und `cargo test --all --no-fail-fast`
mit `-j 2` grün, 607 Bibliothekstests; `node scripts/release-licenses.mjs
check` nach `prepare` grün. Live gegen beide Test-VMs auf eigenen Testsockets
(tmux 3.3a und 3.6) mit `--test-threads=4` grün, darunter
`integration_default_socket.rs` mit einem Testsocket anstelle von `default`.
Eine Code-Review von PR #5 fand 15 Punkte; die neun Verhaltensfehler sind
behoben. Am Fenster einer abgeschotteten Testinstanz, deren Standard-Socket auf
einen Testsocket umgelenkt war (`AIDEVBRIDGE_TMUX_DEFAULT_SOCKET`): Gruppe,
Öffnen, Eingabe, Kennzeichen, Hinweis zur Fenstergröße, gesperrte
Gruppensessions, Wiederherstellen nach Neustart und der Schalter gingen; zwei
Optikfehler am Schalter sind behoben. Der volle Lauf stand zuerst still, weil
C: voll war (LNK1318 beim Linken); die inkrementellen Zwischenstände der beiden
Build-Ordner sind gelöscht.

Am 24.10.2026 nach den Korrekturen der bekannten Rasterfehler, auf dem
Rechner mit 8 GB Arbeitsspeicher: 2659 Frontend-Tests in 49 Dateien,
TypeScript- und Vite-Build und 76 Skripttests grün; Rust fmt, Clippy mit
`-D warnings` und `cargo test --all --no-fail-fast` mit `-j 2` vollständig
grün, 587 Bibliothekstests. Die `commands::connect_tests` wackeln nicht mehr:
Sie warteten unbegrenzt, wenn parallele Tests den prozessweiten
Vorbereitungs-Pool füllten (`connect_capacity` vor jeder TCP-Verbindung), und
wiederholen diesen Fehler jetzt wie `Fixture::connect`; direkt aufgerufen
scheiterte die Bibliothek vorher sechs von sechs Mal, danach keinmal in acht
Läufen.

Am 24.10.2026 für 0.2.1, auf dem Rechner mit 8 GB Arbeitsspeicher: 2645
Frontend-Tests in 49 Dateien und TypeScript- und Vite-Build grün; Rust fmt
und Clippy mit `-D warnings` grün, `cargo test --all --no-fail-fast` mit
`-j 2` grün bis auf fünf wechselnde `commands::connect_tests`, die einzeln
alle elf grün laufen (siehe unten); 76 Skripttests grün;
`node scripts/release-licenses.mjs check` nach `prepare` grün. Am Fenster
einer abgeschotteten Testinstanz (Debug-Bau mit eingebettetem Frontend,
eigener Socket auf beiden Test-VMs, tmux 3.3a und 3.6): vier Kacheln über
beide Hosts gespeichert, eine davon mit beendeter Shell; nach Schließen und
Neustart kamen alle vier an ihre Plätze, die beendete nur mit Sperrleiste
(„This session has ended on the host“, ohne „Reconnect“) und ohne Banner,
und keine der drei übrigen Panes bekam ein WINCH.

Am 23.10.2026 nach den Korrekturen aus dem M1-Tor: 2635 Frontend-Tests in
49 Dateien und TypeScript- und Vite-Build grün; Rust fmt und Clippy grün,
Bibliothekstests bis auf einen wechselnden `commands::connect_tests` grün
(siehe unten); 76 Skripttests grün. CI auf `main` für 0.2.0 nach dem
Neustart des abgebrochenen Jobs grün.

Am 23.10.2026 nach der Statusquelle, auf einem Rechner mit 8 GB
Arbeitsspeicher: Rust fmt und Clippy mit `-D warnings` grün,
`cargo test --all --no-fail-fast` grün bis auf zwei bis drei wechselnde
`commands::connect_tests` (Frist von 5 s für eine lokale Testverbindung). Sie
fallen auf diesem Rechner auch ohne die Änderungen aus, einzeln laufen sie
grün; `-j 2` war nötig, weil sonst die Auslagerungsdatei nicht reichte.
`integration_status_title` gegen beide Test-VMs grün (tmux 3.3a und 3.6).
Frontend und Skripte unverändert, nicht neu geprüft. Die Lizenzauswahl ist
für die geänderten eigenen Quellen vor dem nächsten Release neu zu binden.

Am 22.10.2026 nach den Korrekturen für die CI, den Abhängigkeits-Updates und
dem russh-Patch für Anmeldefehler: 2631 Frontend-Tests in 49 Dateien,
TypeScript- und Vite-Build und 76 Skripttests grün; Rust: fmt, Clippy mit
`-D warnings` und `cargo test --all --no-fail-fast` grün, 644 Tests
bestanden, die 11 VM-Abnahmetests ignoriert;
`node scripts/release-licenses.mjs check` und `npm run build:windows` grün
(MSI, NSIS und ZIP, unsigniert). Vom 21.10., also vor diesen Änderungen:
Live-Suiten gegen eine eigene Test-VM (tmux 3.6) mit eigenem Testsocket:
Bibliothek 575, `integration_commands` 23, `socket_abort_probe` 13,
`integration_transport` 8, `test_environment` 7, `integration_tmux` 5,
`capabilities_acl` 5, `integration_pty` 4, `acl_runtime` 2,
`integration_preflight` 1; VM-Abnahme: 11 bestanden, der
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
   [Handabnahme §9](abnahme-handarbeit.md#9-m1-tor), seit 23.10. ohne Grok
   und mit Agents, die zurückfragen.
   **Stand 23.10.:** automatisierter Lauf (CDP und SSH, isolierte
   Testinstanz) über die Schritte 1 bis 11 bestanden
   ([Bericht](messungen/messung-2026-10-23-m1-tor.md)); Statuslatenz unter
   vier flutenden Kacheln 1,07 s. Schritt 7 scheiterte zuerst: Die Kachel
   hing sich nach `kill-session`/`new-session` gleichen Namens an die neue
   Session (behoben, die stille Wiederanhängung prüft jetzt die
   Session-ID). Die WINCH-Schleife der Schritte 3 und 11 ist korrigiert.
   **Bestanden:** Die Punkte am Fenster (Taskleistenblinken, der Kasten
   nach fünf gescheiterten Kontrollreparaturen, echte Tastatur und Maus) hat
   der Maintainer am Stand vom 23.10. abgenommen, gemeldet am 24.10.; damit
   ist das M1-Tor bestanden. Schritt 12 ist das M2-Tor (Punkt 4). Die
   Beobachtung aus Schritt 8 ist am 24.10. behoben: Nach
   einem Neustart zeigte die Kachel einer beendeten Session neben der
   Sperrleiste ein Fehlerbanner, weil die Sessionliste eine tote Pane noch
   als unbekannt meldete; sie meldet sie jetzt wie die Statusabfrage als
   beendet.
2. **Erstes Release:** Abweichend von der Planung (erst nach dem M1-Tor,
   MSI und Setup-EXE erst nach der Installerabnahme) erschien `v0.2.0` auf
   Entscheidung des Maintainers schon am 22.10.: Der Tag steht auf dem
   Commit, aus dem die Pakete gebaut sind; das Release trägt MSI, Setup-EXE
   und ZIP aus `npm run build:windows` mit ihren SHA-256-Werten. Die
   Installerabnahme (Punkt 6) hat der Maintainer am 24.10. an diesen
   Paketen nachgeholt; das M1-Tor bleibt offen (Punkt 1). Das Repository ist seit dem 22.10. öffentlich, mit privatem
   Meldeweg für Sicherheitslücken (Private Vulnerability Reporting),
   Warnungen von Dependabot, Secret Scanning mit Push Protection und GitHub
   Actions für `.github/workflows/ci.yml`; Workflows aus Pull Requests
   externer Beitragender laufen erst nach Freigabe. Die Schlüssel unter
   `src-tauri/tests/fixtures/rsa-signing/`, in `src-tauri/src/ssh/auth.rs`
   und in `vendor/russh` sowie der synthetische Schlüssel in
   `scripts/m1-error-profile.py` sind Testdaten.
3. **Statusquelle:** erledigt am 23.10. ([Messung](messungen/messung-2026-10-23-agentversionen.md),
   [Nachtrag der MVP-Spec](specs/2026-09-05-mvp-und-statuspunkt-design.md)
   vom 23.10.). Keine feste Versionsbindung; gemessen Claude Code 2.1.309
   und Codex 0.163.0 und 0.164.0, „goal proposal“ ergibt wartet. Die
   Codex-Einstellungen `tui.animations`, `tui.effects.progress` und
   `tui.terminal_title` werden gelesen. Die Titelquelle erkennt den Agent
   über `/proc/<pid>/exe`, begrenzt Titel auf 1024 und Pfade auf 4096 Byte,
   bekommt den Socket als Argument und hat einen VM-Test mit Attrappen.
   Offen: Grok (Freigabe, langer Hintergrundbefehl, aktuelle Version), wenn
   es zurückkommt; Projektdateien und `-c`-Optionen von Codex bleiben
   ungelesen.
4. **M2:** History-Restore und Auto-Reconnect sind mit der UX-Überarbeitung
   gebaut ([Spec](specs/2026-10-11-ux-ueberarbeitung-design.md) §5.3–§5.6),
   die Selbstheilung nur für Schlüssel und ssh-agent. **Das Tor ist
   bestanden:** 10 Minuten Ruhezustand, danach ohne Klick verbunden, der
   Verlauf ist lesbar ([Handabnahme §6](abnahme-handarbeit.md#6-wiederverbinden)),
   auch mit 8 + 1 Kacheln
   ([Raster-Spec](specs/2026-10-19-dynamisches-raster-design.md) §10.2);
   abgenommen vom Maintainer am Gerät am Stand vom 23.10., gemeldet am
   24.10.
5. **M3:** fremde Sessions auf dem Standard-Socket sehen und bedienen, mit
   gesperrtem Beenden ([Roadmap](plans/2026-09-05-roadmap-bis-release.md)
   S3.1; [Design](specs/2026-10-25-standard-socket-design.md) vom 25.10. nach
   Kritikrunde und Entscheidungen, [Plan](plans/2026-10-25-standard-socket.md)
   vom selben Tag; Schritt 1, die [Messung](messungen/messung-2026-10-25-standard-socket.md),
   und die Schritte 2 bis 5 (Socket als Typ, Backend je Socket,
   Frontend-Zustand, Oberfläche) sind erledigt und mit 0.2.2 ausgeliefert;
   die [Abnahme](messungen/messung-2026-10-25-m31-abnahme.md) an 0.2.2 am selben Tag: Punkt 1 bis 5
   bestanden, Punkt 6 nicht: Unter vier flutenden Kacheln kamen 3 von 10
   Statuswechseln später als 4 s (höchstens 4,97 s), weil die Abfrage mit dem
   Standard-Socket 0,5 s länger dauerte und erst 2 s nach ihrem Ende die
   nächste begann. Ebenfalls dort gefunden, seit 0.2.0: Das Anhängen scheiterte
   mit „attach identity changed“, wenn auf demselben Server gerade eine Session
   entstand oder endete, etwa bei zwei „New session“ kurz nacheinander. Seit
   dem 27.10. (noch in keinem Release) liest
   die Bestätigung dann erneut, die Abfrage liest den Standard-Socket parallel,
   und der Takt zählt ab dem Beginn der vorigen Abfrage (UX-Spec §5.2,
   Nachtrag). Nachmessung: 12 von 12 Wechseln unter 4 s, höchstens 3,30 s;
   Öffnen unter wechselnden Sessions 8 von 8 statt 2 von 8).
   Bekannte Grenzen: Die Statusabfrage liest den Standard-Socket in der
   Form des tmux im `PATH` (README); Live-Tests brauchen `--test-threads=4`,
   wie CONTRIBUTING es vorgibt, weil die Schlüsselvorbereitung je
   Prozess nur acht Aufträge zulässt: Mit der voreingestellten Thread-Zahl
   scheitern rund zwölf Live-Befehlstests an dieser Zulassung; die übrige
   Windows-Politur nach S3.2 (Protokolldatei, globaler
   Diagnosetext; Mindestgröße, Fensterlage und Icon sind erledigt), dazu ein
   neues Logozeichen für den Erststart (Entscheidung vom 21.10.); die
   Rust-Meldung RUSTSEC-2023-0071 zu `rsa`, eingeordnet in
   [`SECURITY.md`](../SECURITY.md), und eine echte RSA-Abnahme; ein
   russh-Update, das die beiden Meldungen zum russh-Servercode mitnimmt
   (ebenfalls in `SECURITY.md`; die App nutzt diesen Code nicht); Signatur
   der Pakete und winget.
6. **Lieferung:** Die [Lizenzauswahl](release/license-selection.windows-x64.json)
   ist für 0.2.0 neu gebunden: `@xterm/addon-web-links`, die Tauri-Module
   `window`, `dpi` und `image` und die tslib-Helfer sind aufgenommen; die
   geänderten eigenen Quellen, die erzeugten Permissions, `pageant` und die
   Änderungsvermerke in `vendor/russh` sind neu gebunden. Am 22.10. kamen
   vite 6.4.4 (Lizenztext, Polyfill und gebautes Frontend byte-gleich mit
   6.4.3, siehe [Nachweis](release/license-frontend-vite-6.4.4-2026-10-22.json)),
   die seither geänderten eigenen Quellen und der russh-Patch dazu, gebunden
   mit `scripts/release-license-rebind.mjs`.
   `npm run build:windows` lief danach vollständig durch (MSI, NSIS und ZIP,
   unsigniert). Für 0.2.1 sind am 24.10. die zwölf seit 0.2.0 geänderten
   gebundenen Eingänge neu gebunden (sieben eigene Quellen, `package.json`,
   `src-tauri/Cargo.toml`, `tauri.conf.json` und beide Lockfiles; sie tragen
   kein neues Fremdmaterial, Manifeste und Lockfiles ändern nur die eigene
   Version). Die Version des eigenen Pakets steht in
   der Auswahl an acht Stellen (`scope.product_version`, der Paketeintrag
   samt Manifest-Hash, die Komponente und vier Dokumente unter
   `tests/fixtures/rsa-signing/`); das Rebind-Werkzeug ändert keine
   Versionen, sie sind von Hand gesetzt. Nach den Korrekturen der bekannten Rasterfehler sind am 24.10. neun
   weitere eigene Quellen neu gebunden. Das Release `v0.2.1` vom 25.10. trägt MSI, Setup-EXE und ZIP aus
   `npm run build:windows` seines eigenen Commits (dem, der das CHANGELOG
   datiert), `verify` grün, unsigniert; ihre SHA-256-Werte stehen in den
   Release-Notes. Die Probeläufe vom 24.10. aus `cb59da2`, `5cabf45` und
   `1da8da2` sind damit überholt. Für 0.2.2 sind am 25.10. die 39 seit 0.2.1
   geänderten gebundenen Eingänge neu gebunden (eigene Quellen, beide
   Manifeste, beide Lockfiles, `tauri.conf.json`; kein neues Fremdmaterial)
   und `src-tauri/src/tmux/socket.rs` in den Baum aufgenommen; die Version des
   eigenen Pakets steht von Hand auf 0.2.2. Das Release `v0.2.2` vom 25.10.
   trägt MSI, Setup-EXE und ZIP aus `npm run build:windows` seines eigenen
   Commits, unsigniert; ihre SHA-256-Werte stehen in den Release-Notes. Jede weitergegebene Kopie trägt die Lizenzhinweise: An andere,
   auch an Beta-Tester, geht nur das ZIP oder ein Installer aus
   `npm run build:windows`, beide mit dem Ordner `licenses/`. Die nackte EXE
   aus `npm run build:app` bleibt auf dem eigenen Rechner. Ändert sich ein
   gebundener Eingang, vor dem nächsten Lauf die Änderungen auf neues
   Fremdmaterial prüfen und nur die betroffenen Einträge mit
   `scripts/release-license-rebind.mjs` neu binden (README, „Windows
   packages“). Die Installerabnahme hat der Maintainer am 24.10. an MSI
   und Setup-EXE von 0.2.0 bestanden: Anzeige der Lizenzseite,
   WebView2-Bedingungen, Hinweise der Installer-Stubs. Das Manifest jedes
   Laufs meldet sie weiter als `pending` (`nsis_msi_payload`,
   `installer_terms_ui`, `installer_stub_notices`), weil ein Bau sie nicht
   kennt; erneut abzunehmen ist sie, wenn sich Installer, Lizenzseite oder
   Stubs ändern. Offen bleiben `native_import_family_review` für die
   Durchsicht der nativen Importe der EXE und
   `product_and_windows_acceptance` für die Abnahme am Fenster. Die
   Release-Binaries enthalten die Pfade des Cargo-Registers der Baumaschine
   (Panic-Orte von Kisten aus
   crates.io unter `<Profil>\.cargo\registry\src\…`); damit steht der
   Benutzername des Bauprofils in den Panic-Pfaden der Binaries. Das ist
   hingenommen. Der Lieferlauf weist `RUSTFLAGS` und `.cargo/config.toml`
   ab; ein Lauf mit neutralem `CARGO_HOME` wäre der Weg, das zu ändern.
   Am 27.10. sind nach dem Code-Review beide Auswahlen neu gebunden:
   crypto-bigint 0.7.10, ctutils 0.4.6 und tokio 1.53.3 tragen dieselben
   Lizenzen und byte-gleiche Lizenztexte
   ([Nachweis](release/license-rust-crypto-tokio-2026-10-26.json)) und sind
   in der Windows-Auswahl von Hand nachgeführt; dazu 65 geänderte gebundene
   Eingänge (eigene Quellen, `Cargo.lock`, CSP in `tauri.conf.json`,
   Capability, Kommentare in `src-tauri/Cargo.toml` und
   `scripts/gen-icons.mjs`); außer den drei Crates bringt keiner neues
   Fremdmaterial. `src/i18n/t.ts` und `src-tauri/src/commands/tests.rs` sind
   in ihre Bäume aufgenommen. Die macOS-Auswahl ist neu abgeleitet; `prepare` und `check`
   sind für beide grün. Offen: crypto-bigint trägt in
   `src/modular/safegcd.rs` für übernommenen Code den Vermerk „Copyright (c)
   2023 Privacy Scaling Explorations Team“, den die Auswahl seit dem 12.09.
   nicht als Hinweis führt (in 0.7.5 und 0.7.10 gleich). Vor dem nächsten
   Release entscheiden, ob er als Copyright-Hinweis der Komponente dazukommt.
   Nach den letzten Korrekturen sind fünf weitere eigene Quellen neu gebunden
   (`commands.rs`, `settings.rs`, zwei Testdateien der Commands und
   `src/main.ts`, ohne neues Fremdmaterial) und die macOS-Auswahl erneut
   abgeleitet; `prepare` und `check` sind für beide grün.
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
   Loslassen nach Alt+Tab. Am 24.10. behoben (Kopf bei 200 px und
   Grenzhinweis nach der Optik-Runde mit dem Maintainer, Spec §5.3 und §8.4,
   Nachträge vom 24.10.): der Kachelkopf unter 260 px, der Grenzhinweis, der
   bei 9 Kacheln die Köpfe verdeckte, das zusätzliche `resize_terminal` einer
   gesperrten Kachel nach dem Neuverbinden ihres Hosts, der verlorene Tipp
   per Touch oder Stift und die Fensterlage unter der Mindestgröße. Am Fenster
   der Testinstanz geprüft: der schmale Kopf (224 px: Punkt, Größe, ganzer
   Titel), drei Touch-Tipps auf einen anderen Host und die Anhebung einer
   gespeicherten Lage von 900 × 400 auf 1100 × 600. Bekannte Fehler:
   - Beim Start mit Kacheln mehrerer Hosts ändert ein Host, der erst nach
     der Frist von 5 s gelistet wird (oder von Hand verbunden), die Größe der
     übrigen Kacheln, je Kachel ein `resize_terminal`; Codex verliert dabei
     seinen Verlauf. Innerhalb der Frist kommen seit dem 24.10. alle Kacheln
     in einem Zug (Raster-Spec §4.6, Nachtrag vom 24.10.).
   - Acht Kacheln, die gleichzeitig ungebremst ausgeben, machen die
     Oberfläche zäh (Statuslatenz p95 5,0 s, Ereignisschleife p95 215 ms);
     der Renderer ist der Engpass. Offen, ob ein binärer Ausgabekanal statt
     JSON-Zahlenfeldern oder weniger Neuzeichnen das behebt; auf Entscheidung
     des Maintainers vom 24.10. mit eigener Messung und eigenem Plan. In der
     M3.1-Abnahme vom 25.10. hängten sich vier flutende Kacheln neben zwei
     Claude-Oberflächen (sechs Kacheln) je einmal still neu an
     („Reconnecting…“). Ein Kandidat für diese Messung (F2 im
     [Umsetzungsplan vom 26.10.](plans/2026-10-26-review-umsetzung.md)) ist
     die Sperre in `TerminalPump::forward`: Sie hält `state.terminals` und
     `state.hosts`, während sie die Ausgabe an den WebView sendet. Zu messen
     sind die Haltedauer dieser Sperre, die Latenz von `send_input` und die
     Wartezeiten der synchronen Befehle auf dem Hauptthread.
   - Eine große Einfügung hält die Seite an, solange Chromium die
     Zwischenablage liest und xterm sie verarbeitet: gemessen am 24.10. rund
     0,33 s je MB (8 MB: 2,6 s), danach laufen Eingabe, Größenänderung und
     Schließen anderer Terminals sofort. Bis zum 24.10. ging die Einfügung
     als ein `send_input` hinaus und hielt die Seite rund 0,8 s je MB an; das
     Backend bediente die anderen Kanäle dabei weiter. Seitdem geht Eingabe
     über 64 KiB in Teilen hinaus. Der tmux-Server nimmt die Einfügung in ein
     Programm, das stdin nicht liest, ganz an und puffert sie selbst.
9. **macOS:** Bau und Testinstallation auf Apple silicon und Intel laufen in
   der CI grün (erstmals am 25.10.); offen ist die
   Abnahme am Fenster eines Macs nach
   [Spec §9](specs/2026-10-25-macos-lieferung-design.md#9-offen):
   Verbinden mit Schlüssel, ssh-agent und Passwort, Abfrage zum lokalen
   Netz, Kopieren und Einfügen, Schriften, Fensterlage, Neustart. Offen
   bleiben Mac-Kürzel mit ⌘ und, sobald Secrets da sind, ein Lauf mit
   Developer ID und Notarisierung. Vorbedingung dafür (U2): Signatur und
   Notarisierung laufen in einem eigenen Schritt oder Job, der nur die
   gebaute App bekommt; erst danach werden die `APPLE_*`-Secrets hinterlegt
   ([`SECURITY.md`](../SECURITY.md), „Unsigned binaries and checking a
   download“).
10. **Review vom 26.10.:** Offen sind die
    [Handabnahme §10](abnahme-handarbeit.md#10-änderungen-aus-dem-code-review-vom-2610)
    am Windows-Fenster (die macOS-Punkte, sobald ein Mac bereitsteht), die
    CI auf Windows, Ubuntu und macOS nach dem Push (unter Windows auch der
    TOFU-Test, der das Anhängen an `known_hosts` über einen Ordner scheitern
    lässt), U3 und U4 und ein etwaiger Widerspruch zu U1, U2 und U5 (oben).
    Batch 9 folgt nur nach U3; seine neuen Dateien `commands/hosts.rs` und
    `commands/inventory.rs` sind dann in den Baum `src-tauri/src` beider
    Auswahlen aufzunehmen. `integration_default_socket.rs` braucht einen
    Testhost mit tmux 3.3a oder 3.6: Auf 3.4 liest die App den
    Standard-Socket bewusst nicht, und der Listentest meldet dort ein SKIP;
    sein voller Lauf steht aus. Außerdem offen:
    - **`#` vor `[` im Startordner:** Die umgesetzte Regel verdoppelt jede
      Folge von `#` im Startordner, außer einer Folge direkt vor `[`. Ab
      tmux 3.3a ist `##[` eine Stilmarke, die wörtlich stehen bleibt
      ([Messung](messungen/messung-2026-10-26-tmux-cwd-format.md)); bloßes
      Verdoppeln hätte solche Pfade gebrochen. Der Maintainer bestätigt die
      Regel noch.
    - **Fehler, Startordner mit `;` am Ende:** tmux liest ein Element der
      Befehlszeile, das auf `;` endet, als Trenner zwischen Befehlen; die
      Session startet dann im Ordner ohne das `;`. Befehle lassen sich so
      nicht einschleusen, der Inhalt bleibt ein Argument. Möglicher Weg:
      ein `;` am Ende im Argument von `-c` als `\;` schreiben, nach einer
      Messung auf tmux 3.0a, 3.3a, 3.4 und 3.6.
    - **Temp-Dateien von `settings.toml`:** Seit `3a34e5b` entfernt der
      Start liegen gebliebene `settings.toml.<pid>.<n>.tmp`, die älter als
      zehn Minuten sind. Die Frist lässt die Temp-Datei einer zweiten
      Instanz stehen, die gerade speichert.
    - In `src/styles.css` stehen noch private Verlaufsmarker in Kommentaren:
      mindestens 29 Zeilen mit Markern wie „Shell-Task 11“, „Fixrunde 2“,
      „Abschlussreview“ oder „Review Runde 1, Befund 2“, 23 davon nach dem
      Muster von `src/source-hygiene.test.ts`; dazu Formen wie „Nachtrag B“
      oder „Review Runde 2“, die keines der Muster zählt. Die Bereinigung
      dieser Runde galt nur `.ts`- und `.rs`-Dateien.
    - Der Vermerk in `safegcd.rs` von crypto-bigint (Punkt 6) wartet weiter
      auf die Entscheidung, ob er als Copyright-Hinweis dazukommt.

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
  (`history-limit`, `remain-on-exit`, `terminal-overrides`, seit 22.10.
  `status off` vor jedem Anhängen, siehe
  [UX-Spec](specs/2026-10-11-ux-ueberarbeitung-design.md) §6.8); `mouse` und
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
- macOS-Lieferung: [Spec](specs/2026-10-25-macos-lieferung-design.md), die
  [macOS-Lizenzauswahl](release/license-selection.macos-universal.json) mit
  [Bericht](release/license-macos-universal-2026-10-25.json) und Inventar
  vom 25.10., erzeugt von `scripts/release-license-select-macos.mjs`; Bau mit
  `scripts/release-macos-artifacts.mjs`. Alle Installer baut, testet und
  veröffentlicht `.github/workflows/packages.yml`; den Release-Text schreibt
  `scripts/release-notes.mjs`.
- russh-Patch: [Herkunft, Umfang und Lizenz](../vendor/russh/AGENTBRIDGE-PATCH.md)
  und der [Patchbericht](reviews/2026-09-11-neutral/russh-channel-close-patch.md)
  zum Kanalschluss.
- [`SECURITY.md`](../SECURITY.md): Meldeweg und Einordnung bekannter
  Meldungen. [`CONTRIBUTING.md`](../CONTRIBUTING.md): Bauen, Tests,
  Live-Tests und Sprachregel.
