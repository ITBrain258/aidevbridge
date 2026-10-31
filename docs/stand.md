# aidevbridge: Stand und offene Punkte

**Stand:** Version `0.2.5` ist seit dem 31.10.2026 in `main` (PR #19,
`8aaa46b`), ein Sicherheitsrelease. Tag und Release stehen noch aus: Den Tag
`v0.2.5` setzt der Maintainer und prüft die Installer an den Paketen des
Releases. Das letzte veröffentlichte Release ist `0.2.4` vom 29.10.2026.

Neu in 0.2.5 gegenüber 0.2.4:

- **Härtung (PR #14):** CI-Läufe einmal je Commit (Push nur auf `main`,
  ein Branch läuft über seinen Pull Request), die Gradle-Distribution ist
  per Prüfsumme gebunden und `gradle-wrapper.jar` wird vor jedem
  Android-Bau geprüft, Vite 6.4.5 (GHSA-8g5g-mxqh-grgj, nur
  Entwicklungsserver). Das Ruleset „Release tags v*“ ist seit dem 29.10.
  aktiv: Tags `v*` legt nur ein Admin an.
- **Stufe 1 der Updates (PR #15):** Tauri 2.12 (`tauri` 2.12.5, wry
  0.57.1, tao 0.37.2, `@tauri-apps/api` 2.12.4 und die Plugins) und alle
  semver-kompatiblen Rust-Crates. Alle drei Lizenzauswahlen sind
  nachgeführt, neu dafür `scripts/release-license-update-cargo.mjs`. Eine
  unabhängige Durchsicht der 33 von Hand entschiedenen Lizenzfälle fand
  keinen falschen, aber eine Lücke im Skript (Texte von außerhalb eines
  Crates zogen ungeprüft mit); sie ist geschlossen, die fünf betroffenen
  Texte sind nachgeprüft.
- **Stufe 2 (PR #16):** Tauri-CLI 2.12.4 für die Release-Bauten; die
  Setup-EXE baut es mit NSIS 3.13 statt 3.11, das MSI weiter mit WiX 3.14.1.
  Lokal gebaute Installer sind ausgelesen und mit denen von 0.2.4
  verglichen: dieselben Plugins und WiX-Teile, jeweils bytegleich zu den
  gepinnten Originalen; das mitgelieferte NSIS-Quellarchiv ist jetzt `v313`
  ([Beleg](release/windows-installer-nsis-3.13-2026-10-30.md)).
- **Lizenzwerkzeuge (PR #17):** `npm run licenses:status`, `:rebind-own`,
  `:check` und `:derive`; der CI-Job `licenses` lässt einen Pull Request
  scheitern, der Fremdcode ohne Lizenzprüfung ändert
  ([Anleitung](lizenzen-pflegen.md)).
- **Sicherheit (PR #18):** russh 0.65.0 statt 0.63.2, mit den vier eigenen
  Änderungen. Es behebt drei Lücken, die den SSH-Client von 0.2.4 und früher
  treffen (GHSA-3hm4-p7h4-rvwp hoch, GHSA-4p9f-7p9m-5vfg, GHSA-fw5c-8223-6h42;
  [SECURITY.md](../SECURITY.md)): Ein Server konnte die App abstürzen lassen
  oder anhalten. Weder `cargo audit` noch Dependabot sehen das eingebettete
  russh; der Audit-Job `vendored` prüft es jetzt gegen die Advisory-Datenbank
  und die Meldungen des russh-Repositorys.

Android ist seit 0.2.4 ausgeliefert und lief am 29.10. erstmals auf einem
Telefon des Maintainers, mit Wischen im Terminal. In der Play Console steht
ein geschlossener Test mit 0.2.3; offen sind die Schritte des Maintainers
(Punkt 11).

Frühere Releases, Einzelheiten im [CHANGELOG](../CHANGELOG.md):

- `0.2.4` (29.10.): das erste Release mit Android und mit den Korrekturen aus
  dem Review vom 26.10. Der Tag steht auf `c279bce`. Erstmals lief alles auf
  einem Tag: `packages.yml` hat MSI, Setup-EXE, ZIP und das DMG gebaut, auf
  frischen Runnern installiert, gestartet und angehängt; `android.yml` hat APK
  und App Bundle gebaut, im eigenen Job mit dem Upload-Schlüssel signiert
  (Zertifikat `07:EA:32:E6…5E:2D`) und die APK samt Build-Provenienz angehängt.
- `0.2.3` (26.10.): die macOS-Lieferung (Universal-DMG, ad-hoc signiert). Seit
  dem 26.10. baut `packages.yml` bei jedem Tag alle Installer.
- `0.2.2` (25.10.): die Sessions auf tmux' Standard-Socket (M3.1).
- `0.2.1` (25.10.) und `0.2.0` (22.10.): die ersten öffentlichen Releases.
  `0.2.0` erschien auf Entscheidung des Maintainers vor dem M1-Tor und vor der
  Installerabnahme; beides ist seitdem bestanden (gemeldet am 24.10.).

Das Repository ist seit dem 22.10.2026 öffentlich und beginnt mit einem
einzigen Anfangs-Commit. Die Versionen 0.1.1 und 0.1.2 erschienen nur
privat und noch unter dem Namen agentbridge; ihre Tags gibt es dort nicht.

Dieses Dokument führt den Stand und die offenen Punkte. Was die App kann,
steht im [README](../README.md#what-it-is), die Änderungen im
[CHANGELOG](../CHANGELOG.md). Die Doku liegt flach unter `docs/` (`specs/`,
`plans/`, `messungen/`); im Baum bleibt nur, was aktuell ist. Was nur diesen
Rechner oder die Konten des Maintainers betrifft, liegt lokal unter
`docs/lokal/` und ist per `.gitignore` vom Repository ausgeschlossen.

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

## Entscheidung vom 31.10.2026 (öffentliches Repository)

Angaben zu Rechner, Konten und Test-VMs stehen nicht im Repository. Anleitungen
und Messwerkzeuge nennen Platzhalter, Bilder zeigen Beispieldaten. Der Name des
Maintainers bleibt, wo Lizenz und Paketdaten ihn als Urheber nennen. Bereits
veröffentlichte Commits werden nicht umgeschrieben, weil Tags, Releases und
Build-Provenienz an ihnen hängen.

## Gebaut

| Bereich | Stand |
| --- | --- |
| M0 Fundament | abgeschlossen mit 0.1.1 |
| UI v2 | abgeschlossen mit 0.1.2; seit 14.09. Farbwahl (7 Akzente auf 2 Grundtönen) und Einstellungsdialog |
| Stabilität und Verbindung | Kontroll- und Terminalverbindung je Host, Fristen, Kontrollreparatur, Korrekturen an Hostschlüsseln, Erststart und Hostverwaltung, RSA-Blinding |
| M1 Statuspunkt | abgeschlossen, Tor bestanden (automatisiert am 23.10., am Fenster gemeldet am 24.10.): numerische Sessionbindung (tmux 3.0, 3.3a, 3.4, 3.6), Statuspille, Aufmerksamkeit; Claude Code über `claude agents --json`, Codex und Grok über den Panetitel. Seit 23.10. gemessen gegen Claude Code 2.1.309 und Codex 0.163.0/0.164.0 ([Messung](messungen/messung-2026-10-23-agentversionen.md)), Agent über `/proc/<pid>/exe`, Codex-Einstellungen gelesen, Größengrenzen, VM-Test mit Attrappen |
| UX-Überarbeitung | gebaut nach der [Spec vom 11.10.](specs/2026-10-11-ux-ueberarbeitung-design.md): Kopieren und Einfügen wie in Windows Terminal samt OSC 52, Terminalmenü, Links, Suchleiste, Schriftgröße; Steuerzustand nur bei echtem Verlust, Selbstheilung für Schlüssel- und Agent-Hosts und Verlauf beim Anhängen; Arbeitsplatz, Schnellöffnen, Namensvorschlag, Anzeigename, ziehbare Seitenleiste; fünf Einstellungsbereiche; tmux 3.6 |
| Dynamisches Raster | Schritt 0, 1 und 3 abgeschlossen nach der [Spec vom 19.10.](specs/2026-10-19-dynamisches-raster-design.md): bis zu 9 Kacheln, höchstens 8 je Host, je Host höchstens 4 Öffnungen zugleich („Opening…“), Tauschen per Zug am Kopf, Größe per Spalt, Maximieren verbirgt die übrigen Kacheln statt sie zu schließen, Wartet-Spur mit Wartezeit, Kachelnummer in Liste und Spur |
| M3.1 Standard-Socket | gebaut nach der [Spec vom 25.10.](specs/2026-10-25-standard-socket-design.md) und mit 0.2.2 ausgeliefert: Sessions auf tmux' Standard-Socket als Gruppe „tmux sessions“, Anhängen nur über den Wächter mit `-E`, kein Beenden, Schalter „Show tmux sessions“ je Host; Abnahme bestanden ([Bericht](messungen/messung-2026-10-25-m31-abnahme.md)): Punkt 1 bis 5 am 25.10., die Statuslatenz unter Last erst mit den Korrekturen vom 27.10. (parallele Abfrage, Takt ab dem Beginn), ausgeliefert mit 0.2.4 |
| Windows-Lieferung | `npm run build:windows` baut MSI, NSIS und ZIP mit Lizenzbeigaben, unsigniert; letzter vollständiger lokaler Lauf am 30.10. mit Tauri-CLI 2.12.4 und NSIS 3.13, Installer ausgelesen ([Beleg](release/windows-installer-nsis-3.13-2026-10-30.md)). Seit 26.10. baut der Workflow `packages.yml` sie bei jedem Tag, installiert jedes Paket auf einem frischen Runner, startet die App und hängt sie an das Release |
| macOS-Lieferung | gebaut nach der [Spec vom 25.10.](specs/2026-10-25-macos-lieferung-design.md) und mit 0.2.3 ausgeliefert: `npm run build:macos` baut ein Universal-DMG, ad-hoc signiert, und prüft Bundle und DMG; [macOS-Lizenzauswahl](release/license-selection.macos-universal.json) mit 396 Komponenten (Stand Tauri 2.12), `prepare`/`check` grün; in der CI Vorschau bei jedem Push, Release-Bau mit Testinstallation auf Apple silicon und Intel am Tag |
| Review vom 26.10. | umgesetzt nach dem [Plan](plans/2026-10-26-review-umsetzung.md), Batches 1 bis 8 und 10 bis 20; Batch 9 wartet auf U3. Seit 27.10. in `main` (PR #8, nach den Korrekturen aus der M3.1-Abnahme in PR #7), CI auf Windows, Ubuntu und macOS grün. Mit 0.2.4 ausgeliefert |
| Android | gebaut nach der [Spec vom 27.10.](specs/2026-10-27-android-design.md) und mit 0.2.4 ausgeliefert: Projekt `src-tauri/gen/android` (API 36, ab Android 7.0), Ordner der App statt `~/.ssh`, Schlüssel auf dem Gerät, kompakte Ansicht und Touch-Leiste, Wischen im Terminal, Workflow `android.yml` mit Signatur im eigenen Job, GitHub-Release und Play-Upload, Store-Eintrag und `PRIVACY.md`, eigene [Lizenzauswahl](release/license-selection.android-universal.json) mit 487 Komponenten, deren Texte als `assets/licenses/` in APK und App Bundle gehen. Am 29.10. erstmals auf einem Telefon des Maintainers gelaufen; eine Abnahme nach Plan steht aus ([Plan](plans/2026-10-27-android.md)) |
| Abhängigkeiten | Mit 0.2.5: Stufe 1 (PR #15): Tauri 2.12 und alle semver-kompatiblen Rust-Crates, Lizenzauswahlen mit `scripts/release-license-update-cargo.mjs` nachgeführt; Stufe 2 (PR #16): Tauri-CLI 2.12.4 und NSIS 3.13; russh 0.65.0 (PR #18); die weiteren Stufen stehen unter Punkt 12 |

## Letzte Prüfung

Am 31.10.2026 für 0.2.5: In der CI auf dem Merge-Commit `8aaa46b` sind Rust auf
Windows, Ubuntu und macOS, Frontend, Skripte, der Job `licenses`, Audit,
`packages.yml` und `android.yml` grün, ebenso auf dem Release-Branch die
Handläufe von `packages.yml` und `android.yml`. Der Merge-Commit hat denselben
Dateistand wie der geprüfte Kopf `752d9e1`. Lokal laut PR #19: 729 Rust-Tests
mit `--test-threads=4`, 2872 Frontend-Tests, 133 Skripttests, `check` grün für
alle drei Auswahlen.

Am 30.10.2026 für PR #16 (Tauri-CLI 2.12.4, NSIS 3.13): ein vollständiger
lokaler Lauf von `npm run build:windows`, dessen Setup-EXE und MSI mit
7-Zip 26.03 und der Windows-Installer-Schnittstelle ausgelesen und mit den
Installern von 0.2.4 verglichen sind
([Beleg](release/windows-installer-nsis-3.13-2026-10-30.md)); eine
unabhängige Durchsicht des Pull Requests fand keinen Blocker. `tsc`, 2872
Frontend-Tests und 123 Skripttests grün, `check` grün für alle drei
Auswahlen (402/208, 396/202, 487/228). In der CI auf dem geprüften Stand
`1175a41` grün: Rust auf drei Systemen, Frontend, Skripte, Audit und beide
Probeläufe (Windows-Pakete mit NSIS 3.13 auf einem frischen Runner
installiert und gestartet, DMG auf Apple silicon und Intel, Android für drei
ABIs). `main` (`508208a`) hat nach dem Merge denselben Dateistand; die
Push-Läufe dort sind am 30.10. grün.

Die letzte VM-Abnahme (`acceptance_vm`, 11 von 11) lief am 27.10. auf dem Stand
`7b961cf` gegen einen lokalen Linux-Testhost. Ältere Prüfungen stehen in der
Git-Historie dieser Datei.

## Offene Punkte

Die Nummern bleiben stabil, weil andere Dokumente sie nennen.

1. **M1-Tor:** bestanden, automatisiert am 23.10.
   ([Bericht](messungen/messung-2026-10-23-m1-tor.md)), am Fenster gemeldet am
   24.10. ([Handabnahme §9](abnahme-handarbeit.md#9-m1-tor)).
2. **Erstes Release:** `v0.2.0` am 22.10. Das Repository ist seitdem öffentlich,
   mit privatem Meldeweg für Sicherheitslücken (Private Vulnerability
   Reporting), Warnungen von Dependabot, Secret Scanning mit Push Protection und
   GitHub Actions; Workflows aus Pull Requests externer Beitragender laufen erst
   nach Freigabe. Die Schlüssel unter `src-tauri/tests/fixtures/rsa-signing/`, in
   `src-tauri/src/ssh/auth.rs` und in `vendor/russh` sowie der synthetische
   Schlüssel in `scripts/m1-error-profile.py` sind Testdaten.
3. **Statusquelle:** erledigt am 23.10.
   ([Messung](messungen/messung-2026-10-23-agentversionen.md),
   [Nachtrag der MVP-Spec](specs/2026-09-05-mvp-und-statuspunkt-design.md)). Keine
   feste Versionsbindung. Offen: Grok (Freigabe, langer Hintergrundbefehl,
   aktuelle Version), wenn es zurückkommt; Projektdateien und `-c`-Optionen von
   Codex bleiben ungelesen.
4. **M2:** Tor bestanden, abgenommen vom Maintainer am Gerät, gemeldet am 24.10.
   ([Handabnahme §6](abnahme-handarbeit.md#6-wiederverbinden)). Selbstheilung nur
   für Schlüssel und ssh-agent.
5. **M3:** M3.1, fremde Sessions auf dem Standard-Socket
   ([Design](specs/2026-10-25-standard-socket-design.md),
   [Plan](plans/2026-10-25-standard-socket.md)), ist mit 0.2.2 ausgeliefert und
   [abgenommen](messungen/messung-2026-10-25-m31-abnahme.md); die Korrekturen zur
   Statuslatenz kamen mit 0.2.4. Bekannte Grenzen: Die Statusabfrage liest den
   Standard-Socket in der Form des tmux im `PATH` (README); Live-Tests brauchen
   `--test-threads=4`, wie CONTRIBUTING es vorgibt. Offen aus der
   [Roadmap](plans/2026-09-05-roadmap-bis-release.md): die übrige Windows-Politur
   nach S3.2 (Protokolldatei, globaler Diagnosetext), ein neues Logozeichen für
   den Erststart (bisher „a“; Entscheidung vom 21.10.), die Rust-Meldung
   RUSTSEC-2023-0071 zu `rsa` (eingeordnet in [`SECURITY.md`](../SECURITY.md)) mit
   einer echten RSA-Abnahme, Signatur der Pakete und winget.
6. **Lieferung:** Alle drei Lizenzauswahlen
   ([Windows](release/license-selection.windows-x64.json),
   [macOS](release/license-selection.macos-universal.json),
   [Android](release/license-selection.android-universal.json)) sind für 0.2.5
   gebunden; den Ablauf beschreibt die [Anleitung](lizenzen-pflegen.md). Jede
   weitergegebene Kopie trägt die Lizenzhinweise: An andere, auch an Beta-Tester,
   geht nur das ZIP oder ein Installer aus `npm run build:windows` oder dem
   Release, beide mit dem Ordner `licenses/`. Die nackte EXE aus
   `npm run build:app` bleibt auf dem eigenen Rechner.
   Die Installerabnahme hat der Maintainer am 24.10. an MSI und Setup-EXE von
   0.2.0 bestanden: Anzeige der Lizenzseite, WebView2-Bedingungen, Hinweise der
   Installer-Stubs. Das Manifest jedes Laufs meldet sie weiter als `pending`
   (`nsis_msi_payload`, `installer_terms_ui`, `installer_stub_notices`), weil ein
   Bau sie nicht kennt; erneut abzunehmen ist sie, wenn sich Installer,
   Lizenzseite oder Stubs ändern. **Das ist mit NSIS 3.13 der Fall:** Der
   Maintainer prüft die Setup-EXE an den Paketen von 0.2.5. Offen bleiben
   `native_import_family_review` für die Durchsicht der nativen Importe der EXE
   und `product_and_windows_acceptance` für die Abnahme am Fenster.
   Lokal gebaute Binaries enthalten die Pfade des Cargo-Registers
   (`<Profil>\.cargo\registry\src\…`) und damit den Benutzernamen des
   Bauprofils; das betrifft die lokal gebauten Pakete bis 0.2.2 und ist
   hingenommen. Seit 0.2.3 baut die CI die Release-Pakete.
   Offen: crypto-bigint trägt in `src/modular/safegcd.rs` für übernommenen Code
   den Vermerk „Copyright (c) 2023 Privacy Scaling Explorations Team“, den die
   Auswahl seit dem 12.09. nicht als Hinweis führt. Zu entscheiden ist, ob er als
   Copyright-Hinweis der Komponente dazukommt.
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
10. **Review vom 26.10.:** Seit 27.10. in `main`; die CI auf Windows,
    Ubuntu und macOS ist grün, unter Windows auch der TOFU-Test, der das
    Anhängen an `known_hosts` über einen Ordner scheitern lässt. Offen sind
    die
    [Handabnahme §10](abnahme-handarbeit.md#10-änderungen-aus-dem-code-review-vom-2610)
    am Windows-Fenster (die macOS-Punkte, sobald ein Mac bereitsteht),
    U3 und U4 und ein etwaiger Widerspruch zu U1, U2 und U5 (oben).
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
    - Aus der Durchsicht von PR #7 und #8 am 27.10., ohne Korrektur:
      - Der Polltakt rechnet mit `Date.now()` (`scheduleStatusPoll` in
        `src/main.ts`). Stellt eine Zeitsynchronisation die Uhr zurück,
        pausiert der Statuspoll des Hosts um diesen Betrag; `performance.now()`
        oder eine Obergrenze von 2 s behebt das.
      - Die Vorschläge aus `~/.ssh/config` schneiden einen Kommentar am
        Zeilenende nicht ab: `Host web # prod` ergibt die Vorschläge `web`,
        `#` und `prod`.
      - Ein I/O-Fehler des ssh-agent zählt seit F1 als `auth_rejected`; das
        Wiederverbinden versucht es dann nicht erneut. Nötig, weil russh nach
        einer abgelehnten Signatur sonst hängt.
      - Das CHANGELOG sagt, Dependabot halte die gepinnten Actions aktuell;
        `dtolnay/rust-toolchain` ist davon ausgenommen.
11. **Android:** Die Schritte des Maintainers in der Play Console, ohne
    Eile, solange die App in Entwicklung ist: der geschlossene Test mit 12
    Testern über 14 Tage, die Datenschutz-URL und das Hochladen des App
    Bundles des neuesten Release (Artefakt des Release-Laufs) von Hand. Erst wenn ein
    Play-Dienstkonto als Secret im Environment `android-release` liegt,
    lädt `android.yml` selbst hoch
    ([Anleitung](android-veroeffentlichung.md)).
12. **Abhängigkeiten, weitere Stufen:** jede als eigener Pull Request, weil
    jede in der Herkunft der Release-Bauten oder in den Lizenzbelegen
    gebunden ist und ein bloßes Hochziehen deren Prüfungen bricht. Erledigt
    sind Tauri 2.12 (PR #15), Tauri-CLI 2.12.4 mit NSIS 3.13 (PR #16) und
    russh 0.65.0 (PR #18). Die Reihenfolge unten ist die Empfehlung vom
    30.10., noch nicht entschieden:
    - **Frontend-Werkzeuge:** Vite 8, TypeScript 7, Vitest 5 und jsdom 30
      (stehen auf 6.4, 5.6, 4.1 und 29). Vite ändert die gebaute Ausgabe,
      also den Beleg zum Modulepreload-Polyfill.
    - **Kotlin 2 mit AGP 9 und Gradle 9**, zusammen mit den androidx-Updates:
      deren neue Versionen tragen Kotlin-2.1-Metadaten, die das
      Kotlin-Gradle-Plugin 1.9.25 nicht liest. Spätestens fällig, wenn
      Google Play ein neueres Ziel-SDK verlangt.
    - **Rust 1.99:** Die Toolchain 1.97.1 steckt in den Belegen der
      Standardbibliothek und in den Prüfungen der Lizenzauswahlen; nötig
      erst, wenn ein Crate sie verlangt.
    - Klein: `tauri-build` 2.7.4 meldet `STATIC_VCRUNTIME` (gesetzt von
      `release-windows-artifacts.mjs`) als veraltet; es linkt weiter
      statisch, und die Ersatzoption `build.windows.staticVCRuntime` ist
      standardmäßig an. `lucide-static` (Icons) steht auf 1.41, aktuell 1.65.
    - Nach russh 0.65: Nach einer abgelehnten Agent-Signatur weitere
      Identitäten probieren, was 0.65 erlaubt (upstream #788,
      `src-tauri/src/ssh/auth.rs`). Eigene Änderungen upstream anbieten,
      zuerst das Close-Verhalten, das upstream in #789 selbst vorschlägt; U4
      braucht dazu das OK des Maintainers.

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
