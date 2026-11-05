# aidevbridge: Stand und offene Punkte

**Stand:** Version `0.2.7` vom 05.11.2026 (Tag `v0.2.7` auf dem Merge-Commit
von PR #35); beim Tag baut die CI alle Pakete und hängt sie an das Release.
0.2.7 bringt russh 0.65.1, die Abhängigkeitsstufen vom 05.11. (Punkt 12),
den nächsten Agent-Schlüssel nach einer verweigerten Signatur (PR #28),
Hostschlüssel nach `known_hosts` geordnet (PR #30), Live-Tests in der CI
(PR #29) und die Befunde der Prüfung vor dem Release (PR #35); Einzelheiten
im [CHANGELOG](../CHANGELOG.md).

`main` ist seit dem 05.11. per Ruleset geschützt (Entscheidungen vom 05.11.).
Frühere Releases und ihre Einzelheiten stehen im CHANGELOG, frühere Prüfungen
und erledigte Punkte in der Git-Historie dieser Datei.

Das Repository ist seit dem 22.10.2026 öffentlich und beginnt mit einem
einzigen Anfangs-Commit. Die Versionen 0.1.1 und 0.1.2 erschienen nur privat
und noch unter dem Namen agentbridge; ihre Tags gibt es dort nicht.

Dieses Dokument führt den Stand und die offenen Punkte. Was die App kann,
steht im [README](../README.md#what-it-does), die Einzelheiten für Nutzer in den
englischen Anleitungen unter [`guide/`](guide/install.md), die Änderungen im
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
- **Release automatisch:** Bei jedem Release baut, testet und veröffentlicht
  die CI alle Pakete (Nachtrag vom 26.10.); von Hand lädt der Maintainer
  nichts hoch.

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
- **Fragen U1 bis U5:**
  - U1, nach Empfehlung A: Das portable ZIP behält die WiX- und
    NSIS-Quellarchive. Ein eigener Lizenzsatz für das ZIP kann mit der
    nächsten Neuableitung der Lizenzen kommen. Der Maintainer kann noch
    widersprechen.
  - U2, nach Empfehlung a: Bevor `APPLE_*`-Secrets hinterlegt werden,
    wandern Signatur und Notarisierung in einen eigenen Schritt oder Job, der
    nur die gebaute App bekommt (Punkt 9). Der Maintainer kann noch
    widersprechen.
  - U3, offen: Batch 9 (`commands.rs` in `commands/hosts.rs` und
    `commands/inventory.rs` teilen) braucht das Ja des Maintainers (Punkt 10).
  - U4: seit dem 05.11. entschieden (unten).
  - U5: Die Vorauseingabe bleibt. Endgültig entschieden wird an der
    [Handabnahme §10](abnahme-handarbeit.md#10-änderungen-aus-dem-code-review-vom-2610),
    Schritt 3.

## Entscheidung vom 31.10.2026 (öffentliches Repository)

Angaben zu Rechner, Konten und Test-VMs stehen nicht im Repository. Anleitungen
und Messwerkzeuge nennen Platzhalter, Bilder zeigen Beispieldaten. Der Name des
Maintainers bleibt, wo Lizenz und Paketdaten ihn als Urheber nennen. Bereits
veröffentlichte Commits werden nicht umgeschrieben, weil Tags, Releases und
Build-Provenienz an ihnen hängen.

## Entscheidungen vom 05.11.2026

- **`main` geschützt:** Das Ruleset „main“ gilt für den Standard-Branch.
  `main` lässt sich nicht löschen oder überschreiben, Änderungen kommen nur
  über einen Pull Request, und vor dem Merge müssen `rust (windows)`,
  `rust (ubuntu)`, `rust (macos)`, `frontend`, `licenses` und `scripts` grün
  sein. Freigaben verlangt es nicht, weil der Maintainer seine eigenen Pull
  Requests nicht freigeben kann. `packages.yml` und `android.yml` sind keine
  Pflicht, weil die macOS-Runner bei GitHub zeitweise keinen Platz haben.
  Admins dürfen die Regeln im Notfall umgehen. Die Jobnamen nennen das
  Runner-Image nicht, damit ein neues Image die Pflicht-Checks nicht ändert.
- **Abhängigkeiten:** Die Stufen unter Punkt 12 werden abgearbeitet, je
  Stufe ein Pull Request; Rust 1.99 wartet, bis ein Crate es verlangt. Nicht
  übernommen: `noUncheckedIndexedAccess` (877 Stellen, 95 davon außerhalb der
  Tests) und ein Linter.
- **Projektdateien:** keine Discussions und kein `CODE_OF_CONDUCT.md`.
  Erledigte Pläne fallen aus `plans/`, dieses Dokument führt nur noch die
  offenen Punkte; die Geschichte bleibt in Git.
- **Upstream (U4):** Eigene russh-Änderungen dürfen bei russh angeboten
  werden, zuerst das Close-Verhalten. Issue oder Pull Request gehen erst
  hinaus, wenn der Maintainer den Entwurf gesehen hat.

## Gebaut

| Bereich | Stand |
| --- | --- |
| M0 Fundament, UI v2 | abgeschlossen mit 0.1.1 und 0.1.2; Farbwahl (7 Akzente auf 2 Grundtönen) und Einstellungsdialog |
| Stabilität und Verbindung | Kontroll- und Terminalverbindung je Host, Fristen, Kontrollreparatur, Korrekturen an Hostschlüsseln, Erststart und Hostverwaltung, RSA-Blinding; Hostschlüssel-Algorithmen nach `known_hosts`, weitere Agent-Schlüssel nach einer verweigerten Signatur |
| M1 Statuspunkt | Tor bestanden (automatisiert am 23.10., am Fenster gemeldet am 24.10.): numerische Sessionbindung (tmux 3.0, 3.3a, 3.4, 3.6), Statuspille, Aufmerksamkeit; Claude Code über `claude agents --json`, Codex und Grok über den Panetitel ([Messung](messungen/messung-2026-10-23-agentversionen.md)) |
| UX-Überarbeitung | gebaut nach der [Spec vom 11.10.](specs/2026-10-11-ux-ueberarbeitung-design.md): Kopieren und Einfügen wie in Windows Terminal samt OSC 52, Terminalmenü, Links, Suchleiste, Schriftgröße; Selbstheilung für Schlüssel- und Agent-Hosts; Arbeitsplatz, Schnellöffnen, ziehbare Seitenleiste; fünf Einstellungsbereiche |
| Dynamisches Raster | Schritt 0, 1 und 3 nach der [Spec vom 19.10.](specs/2026-10-19-dynamisches-raster-design.md): bis zu 9 Kacheln, höchstens 8 je Host, Tauschen, Spalt, Maximieren, Wartet-Spur |
| M3.1 Standard-Socket | nach der [Spec vom 25.10.](specs/2026-10-25-standard-socket-design.md), mit 0.2.2 ausgeliefert und [abgenommen](messungen/messung-2026-10-25-m31-abnahme.md) |
| Windows-Lieferung | `npm run build:windows` baut MSI, NSIS und ZIP mit Lizenzbeigaben, unsigniert ([Beleg zu NSIS 3.13](release/windows-installer-nsis-3.13-2026-10-30.md)); `packages.yml` baut sie bei jedem Tag, installiert und startet jedes Paket auf einem frischen Runner und hängt sie an das Release |
| macOS-Lieferung | nach der [Spec vom 25.10.](specs/2026-10-25-macos-lieferung-design.md), seit 0.2.3: Universal-DMG, ad-hoc signiert, [macOS-Lizenzauswahl](release/license-selection.macos-universal.json) mit 390 Komponenten; Testinstallation auf Apple silicon und Intel |
| Android | nach der [Spec vom 27.10.](specs/2026-10-27-android-design.md), seit 0.2.4: API 36 ab Android 7.0, kompakte Ansicht und Touch-Leiste, `android.yml` mit Signatur im eigenen Job, eigene [Lizenzauswahl](release/license-selection.android-universal.json) mit 485 Komponenten; eine Abnahme nach [Plan](plans/2026-10-27-android.md) steht aus |
| Abhängigkeiten | zuletzt am 05.11. (PR #24 bis #27, #32, #34); die offenen Stufen unter Punkt 12 |

## Letzte Prüfung

Am 05.11.2026 vor dem Release 0.2.7: Fünf voneinander unabhängige Prüfungen
(Rust und SSH, Frontend und Bau, Lizenzbelege, CI und Android, Doku) haben
alles seit 0.2.6 gelesen; ihre Befunde behebt PR #35. Auf `main` (`4726bc8`)
waren CI, `android.yml` und `packages.yml` grün, die macOS-Jobs erst im
zweiten und dritten Versuch, weil GitHub keinen macOS-arm64-Runner zuteilte.
Im Release-PR liefen CI, `packages.yml` und `android.yml` grün, dazu die
Release-Probeläufe beider Workflows (Windows-Pakete und DMG installiert und
gestartet; APK und App Bundle für drei ABIs). Der Ubuntu-Job bestand 738
Tests, darunter die Live-Tests mit ed25519- und RSA-Schlüssel und für einen
nur mit ECDSA bekannten Host. Lokal: die Auth-Tests, 155 Skripttests,
`npm run typecheck` und `npm run build` mit der Prüfung der
Lizenzhinweise; `check` grün für windows-x64 (393/207), macos-universal
(390/201) und android-universal (485/228). Ein lokaler Android-Bau aller drei
ABIs brach aus Speichermangel ab; die NDK-Belege für armv7 und x86_64 stehen
wie bei 0.2.6 aufgezeichnet.

Die letzte VM-Abnahme (`acceptance_vm`, 11 von 11) lief am 27.10. auf dem Stand
`7b961cf` gegen einen lokalen Linux-Testhost.

## Offene Punkte

Die Nummern bleiben stabil, weil andere Dokumente sie nennen.

1. **M1-Tor:** bestanden, automatisiert am 23.10.
   ([Bericht](messungen/messung-2026-10-23-m1-tor.md)), am Fenster gemeldet am
   24.10. ([Handabnahme §9](abnahme-handarbeit.md#9-m1-tor)).
2. **Erstes Release:** `v0.2.0` am 22.10., seitdem öffentlich mit privatem
   Meldeweg für Sicherheitslücken, Dependabot, Secret Scanning mit Push
   Protection und den Rulesets „Release tags v*“ und „main“; Workflows aus
   Pull Requests externer Beitragender laufen erst nach Freigabe. Die
   Schlüssel unter `src-tauri/tests/fixtures/rsa-signing/`, in
   `src-tauri/src/ssh/auth.rs` und in `vendor/russh` sowie der synthetische
   Schlüssel in `scripts/m1-error-profile.py` sind Testdaten.
3. **Statusquelle:** erledigt am 23.10.
   ([Messung](messungen/messung-2026-10-23-agentversionen.md)). Offen: Grok
   (Freigabe, langer Hintergrundbefehl, aktuelle Version), wenn es
   zurückkommt; Projektdateien und `-c`-Optionen von Codex bleiben ungelesen.
4. **M2:** Tor bestanden, abgenommen am 24.10.
   ([Handabnahme §6](abnahme-handarbeit.md#6-wiederverbinden)). Selbstheilung nur
   für Schlüssel und ssh-agent.
5. **M3:** M3.1 ist ausgeliefert und abgenommen (siehe Gebaut). Bekannte
   Grenzen: Die Statusabfrage liest den Standard-Socket in der Form des tmux
   im `PATH` ([Grenzen](guide/limits.md)). Offen aus der Roadmap vom 05.09.
   (in der Git-Historie): die übrige Windows-Politur nach S3.2
   (Protokolldatei, globaler Diagnosetext), ein neues Logozeichen für den
   Erststart (bisher „a“; geparkt auf `feat/new-logo`), RUSTSEC-2023-0071 zu
   `rsa` (eingeordnet in [`SECURITY.md`](../SECURITY.md)) mit einer echten
   RSA-Abnahme, Signatur der Pakete und winget. Zur Protokolldatei (Review vom
   03.11.): Die App schreibt kein Protokoll, Fehlerdetails gehen verloren. Sie
   braucht neue Abhängigkeiten mit Lizenzprüfung, eine Regel, die Hostnamen
   und Pfade unkenntlich macht, und eine Entscheidung zu Ort und Rotation.
6. **Lieferung:** Alle drei Lizenzauswahlen
   ([Windows](release/license-selection.windows-x64.json),
   [macOS](release/license-selection.macos-universal.json),
   [Android](release/license-selection.android-universal.json)) sind gebunden;
   den Ablauf beschreibt die [Anleitung](lizenzen-pflegen.md). Jede
   weitergegebene Kopie trägt die Lizenzhinweise: An andere geht nur das ZIP
   oder ein Installer, beide mit dem Ordner `licenses/`; die nackte EXE aus
   `npm run build:app` bleibt auf dem eigenen Rechner. Offen:
   - Die Installerabnahme (bestanden am 24.10. an 0.2.0) ist mit NSIS 3.13 neu
     fällig: Der Maintainer prüft die Setup-EXE an den Paketen von 0.2.7. Das
     Manifest jedes Laufs meldet `nsis_msi_payload`, `installer_terms_ui`,
     `installer_stub_notices`, `native_import_family_review` und
     `product_and_windows_acceptance` weiter als `pending`, weil ein Bau sie
     nicht kennt.
   - Der [Beleg zur VC-Laufzeit](release/license-windows-runtime-2026-09-12.md)
     beschreibt einen lokalen Bau mit Visual Studio 2022 (MSVC 14.44); die CI
     baut die Releases auf `windows-2025` mit Visual Studio 2026. Ob die
     statisch gelinkten Laufzeitobjekte dort dieselbe Auswahl tragen, prüft
     der Maintainer an einem Release-Bau.
   - crypto-bigint trägt in `src/modular/safegcd.rs` den Vermerk „Copyright
     (c) 2023 Privacy Scaling Explorations Team“, den die Auswahl nicht als
     Hinweis führt. Zu entscheiden ist, ob er dazukommt.
   - Lokal gebaute Pakete bis 0.2.2 enthalten Pfade des Cargo-Registers mit
     dem Benutzernamen des Bauprofils; hingenommen, seit 0.2.3 baut die CI.
7. **Echte Abnahmen:**
   - die [Handabnahme](abnahme-handarbeit.md) am Windows-Fenster: echte
     Tastatur, Rechtsklick, Skalierung 100 und 150 % am echten Bildschirm,
     Standby und Netzwechsel, Bildschirmleser und die 14 Farbthemen;
     dazu §10 und §11.
   - die offenen Punkte des UI-v2-Tors
     ([Spec](specs/2026-09-05-ui-v2-design.md) §17): Dichte mit
     20 Sessions unter 4 Hosts, WebGL unter 10 Minuten Flutung, Skalierung
     125 und 150 %, Farbwechsel bei laufenden Kacheln, echter Erststart,
     Tastatur in Fingerabdruck- und Sessiondialog.
   - der Zweitrechner: Installation nur nach README, Anmeldung mit `id_rsa`,
     ed25519 und Passwort, handgestartete Session mit Status, Deinstallation.
8. **Raster:** Schritt 3 ist gemessen und abgenommen
   ([Messbericht](messungen/messung-2026-10-21-acht-kacheln.md)); Schritt 2
   (Bewegung) folgt mit eigenem Plan. Am Fenster nicht angesehen: 150 %,
   zweiter Bildschirm (Spec §8.6), Ab- und Andocken, die Wartet-Spur mit einer
   echt wartenden Claude-Session, ob die Windows-Animationseffekte aus sind.
   Verdacht aus dem Review vom 03.11., nicht nachgestellt: Die Seitenleiste
   baut bei jeder Änderung ihres Zustands neu auf; kommt eine solche Änderung
   während eines Drucks, kann Chromium den Klick verlieren. Zu klären, bevor
   sich am Aufbau der Seitenleiste etwas ändert. Bekannte Fehler:
   - Beim Start mit Kacheln mehrerer Hosts ändert ein Host, der erst nach der
     Frist von 5 s gelistet wird, die Größe der übrigen Kacheln; Codex
     verliert dabei seinen Verlauf.
   - Acht Kacheln, die gleichzeitig ungebremst ausgeben, machen die
     Oberfläche zäh (Statuslatenz p95 5,0 s, Ereignisschleife p95 215 ms);
     der Renderer ist der Engpass. Ob ein binärer Ausgabekanal oder weniger
     Neuzeichnen hilft, klärt eine eigene Messung mit eigenem Plan
     (Entscheidung vom 24.10.); ein Kandidat ist die Sperre in
     `TerminalPump::forward` (F2 im
     [Umsetzungsplan vom 26.10.](plans/2026-10-26-review-umsetzung.md)).
   - Eine große Einfügung hält die Seite an, solange Chromium die
     Zwischenablage liest und xterm sie verarbeitet: rund 0,33 s je MB.
9. **macOS:** Bau und Testinstallation auf Apple silicon und Intel laufen in
   der CI grün. Offen ist die Abnahme am Fenster eines Macs nach
   [Spec §9](specs/2026-10-25-macos-lieferung-design.md#9-offen):
   Verbinden mit Schlüssel, ssh-agent und Passwort, Abfrage zum lokalen
   Netz, Kopieren und Einfügen, Schriften, Fensterlage, Neustart; dazu
   Mac-Kürzel mit ⌘ und, sobald Secrets da sind, ein Lauf mit Developer ID
   und Notarisierung, nach U2.
10. **Review vom 26.10.:** Offen sind die
    [Handabnahme §10](abnahme-handarbeit.md#10-änderungen-aus-dem-code-review-vom-2610),
    U3 (Batch 9; seine neuen Dateien kämen in den Baum `src-tauri/src`
    beider Auswahlen) und ein etwaiger Widerspruch zu U1, U2 und U5.
    `integration_default_socket.rs` braucht einen Testhost mit tmux 3.3a oder
    3.6 für seinen vollen Lauf (der CI-Runner hat tmux 3.4, dort meldet er
    SKIP). Außerdem:
    - **`#` vor `[` im Startordner:** Die Regel verdoppelt jede Folge von `#`,
      außer direkt vor `[` (ab tmux 3.3a eine Stilmarke,
      [Messung](messungen/messung-2026-10-26-tmux-cwd-format.md)); der
      Maintainer bestätigt sie noch.
    - **Startordner mit `;` am Ende:** tmux liest ein solches Element als
      Trenner; die Session startet im Ordner ohne das `;`. Einschleusen lässt
      sich nichts. Möglicher Weg: `\;` im Argument von `-c`, nach einer
      Messung auf tmux 3.0a, 3.3a, 3.4 und 3.6.
    - In `src/styles.css` stehen noch private Verlaufsmarker in Kommentaren
      (mindestens 29 Zeilen wie „Shell-Task 11“ oder „Fixrunde 2“).
    - Die Vorschläge aus `~/.ssh/config` schneiden einen Kommentar am
      Zeilenende nicht ab: `Host web # prod` ergibt `web`, `#` und `prod`.
11. **Android:** Die Schritte des Maintainers in der Play Console, ohne Eile:
    der geschlossene Test mit 12 Testern über 14 Tage, die Datenschutz-URL
    und das Hochladen des App Bundles von Hand; erst mit einem
    Play-Dienstkonto im Environment `android-release` lädt `android.yml`
    selbst hoch ([Anleitung](android-veroeffentlichung.md)). Am Gerät zu
    klären (Review vom 03.11.): ob Android den WebView im Hintergrund so
    anhält, dass die Acks länger als 30 s ausbleiben; dann schließt
    `STALL_TIMEOUT` die Terminals, und die Kacheln hängen sich nach der
    Rückkehr neu an.
12. **Abhängigkeiten, weitere Stufen:** jede als eigener Pull Request, weil
    jede in der Herkunft der Release-Bauten oder in den Lizenzbelegen
    gebunden ist. Erledigt bis zum 05.11.: Tauri 2.12, Tauri-CLI 2.12.4 mit
    NSIS 3.13, russh 0.65.1, `lucide-static` 1.69, `dirs` 7, `toml` 1,
    `sha2` 0.11, TypeScript 6, Vitest 5, jsdom 30 und Vite 8 (mit Ziel
    Safari 14 und Chrome 87 wie bisher;
    [Beleg](release/license-frontend-vite-8-2026-11-05.json)), dazu für
    Android Gradle 9.6, AGP 9.3, Kotlin 2.2 und die androidx-Updates mit
    Locks für den Buildscript-Classpath, `verification-metadata.xml` und
    Clippy für das Android-Ziel (PR #34,
    [Nachtrag der Android-Spec](specs/2026-10-27-android-design.md#nachtrag-vom-05112026-gradle-9-agp-9-und-kotlin-2)).
    Offen:
    - **Ziel-SDK 37:** umgesetzt im Branch `feat/android-sdk-37` mit der
      Berechtigung fürs lokale Netz, die Android 17 dafür verlangt
      ([Nachtrag der Android-Spec](specs/2026-10-27-android-design.md#nachtrag-vom-05112026-ziel-sdk-37-und-das-lokale-netz));
      offen ist die Prüfung am Gerät mit Android 17. Mit Tauri v3 fallen die
      Übergangsschalter `android.builtInKotlin=false` und
      `android.newDsl=false`.
    - **TypeScript 7:** Der native Compiler hat in 7.0 keine stabile JS-API;
      `src/source-hygiene.test.ts` und `release-license-inventory-frontend.mjs`
      brauchen `ts.createSourceFile`.
    - **Rust 1.99:** erst, wenn ein Crate sie verlangt. Die Stellen, die die
      Version nennen, gleicht `scripts/rust-toolchain.test.mjs` mit
      `rust-toolchain.toml` ab, die Belege der Standardbibliothek nicht.
    - **Typprüfung der Skripte:** 22 Skripte unter `scripts/` tragen noch
      `// @ts-nocheck` (`tsconfig.node.json`); ein Skript verliert die Marke,
      sobald es mit JSDoc-Typen sauber prüft.
    - **Upstream:** Der Entwurf eines Kommentars zu warp-tech/russh#806 (das
      Close-Verhalten unseres Patches, mit dem zweiten Fall der Antwort auf
      ein lokales Close) wartet auf das OK des Maintainers.
13. **Review vom 03.11., zurückgestellt:**
    - **Gehashte Einträge in `known_hosts` schreiben** bei `HashKnownHosts
      yes`: braucht die Auswertung von `ssh_config` mit `Host` und `Match`
      und HMAC-SHA1 mit Zufallssalz. Empfehlung vom 05.11.: zurückgestellt
      lassen, weil unter Windows und macOS kaum jemand `HashKnownHosts`
      setzt; die [Grenzen-Anleitung](guide/limits.md) nennt den
      Klartext-Eintrag und `ssh-keygen -H`. Gehashte Einträge lesen kann die
      App.
    - **Ablageorte unter macOS:** Nach einem Start ohne Verbindung liegen
      unter `~/Library` nur `WebKit/<id>/WebsiteData` und `Caches/<id>/WebKit`,
      wie `PRIVACY.md` sagt (gemessen am 05.11. auf Apple silicon und Intel,
      PR #31; die Liste läuft bei jedem Push mit). Ob Verbindungen und
      Gebrauch mehr anlegen, prüft die
      [Handabnahme §11](abnahme-handarbeit.md#11-änderungen-aus-dem-code-review-vom-0311),
      Schritt 5.

Push, Tag und Release entscheidet der Maintainer jeweils eigens.

## Feste Vorgaben

Aus den Specs und ihren Nachträgen; bei Abweichung gilt die Spec.

- Windows-Client: nur die App, kein Python, kein weiterer Installer.
- Auf den Hosts nur SSH, tmux und ein von Hand gestarteter Agent. Kein Hook,
  kein Watcher, keine Konfigurationsänderung, kein eigener Startdialog.
  tmux und die übrigen Voraussetzungen richtet der Nutzer selbst ein; die App
  installiert nichts, auch nicht auf Knopfdruck (Entscheidung vom 15.09.,
  siehe [Hosts and tmux](guide/hosts.md#host-requirements)).
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
  [Build-Anleitung](guide/building.md#tests); `.github/workflows/ci.yml` führt sie bei
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
- Pläne unter `plans/`: der [Umsetzungsplan vom 26.10.](plans/2026-10-26-review-umsetzung.md)
  (Batch 9 wartet auf U3) und der [Android-Plan](plans/2026-10-27-android.md)
  (Abnahme am Gerät, Play). Erledigte Pläne, etwa die Roadmap vom 05.09. und
  der Plan zum Standard-Socket, stehen in der Git-Historie.
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
  zum Kanalschluss. Die Bibliotheks- und Integrationstests des eingebetteten
  russh laufen in `.github/workflows/vendored.yml`.
- Bilder im README, Vorschaubild für Links und Telefonbilder des Store-Eintrags:
  `scripts/readme-images/render.mjs` rendert die echte Oberfläche mit
  Beispieldaten nach `docs/images/` und `fastlane/`, ohne Host und ohne neue
  Abhängigkeit. Das Vorschaubild lädt der Maintainer unter Settings → General →
  Social preview von Hand hoch; dafür gibt es keine Schnittstelle.
- [`SECURITY.md`](../SECURITY.md): Meldeweg und Einordnung bekannter
  Meldungen. [`CONTRIBUTING.md`](../CONTRIBUTING.md): Bauen, Tests,
  Live-Tests und Sprachregel.
