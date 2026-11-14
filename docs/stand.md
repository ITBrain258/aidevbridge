# aidevbridge: Stand und offene Punkte

**Stand:** Version `0.3.4` vom 14.11.2026 (Tag `v0.3.4` auf dem Merge-Commit
des Release-PR); beim Tag baut die CI alle Pakete und hängt sie an das Release.
0.3.4 bringt die Befunde der Durchsicht vom 13.11. (PR #56): Ein Klick in der
Seitenleiste geht nicht mehr verloren, wenn sie während des Drucks neu gebaut
wird, mit „Screen reader support“ laden Browsertasten auf einer Zeile des
Bildschirmlesers die App nicht mehr neu, und auf Android vergisst das
Entfernen eines Hosts dessen Hostschlüssel. 0.3.3 brachte die Einstellung
„Screen reader support“ und die Aufnahme, die bei mehr als acht gleichzeitigen
Verbindungsaufbauten kurz wartet. Seit 0.3.0 gelten die Mindeststände macOS 12.4 und
Android System WebView 105 (Entscheidungen vom 07.11.) und Android 17 als
Ziel mit der Berechtigung fürs lokale Netz; Einzelheiten im
[CHANGELOG](../CHANGELOG.md).

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
  macOS 11 und neuer (seit dem 07.11.: macOS 12.4, unten).
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
- **Gehashte Einträge in `known_hosts` schreiben:** zurückgestellt
  (Punkt 13).

## Entscheidungen vom 07.11.2026

- **Mindeststand der Webansicht:** macOS 12.4 statt 11 (WebKit von Safari
  15.5), Android weiter ab 7.0 mit Android System WebView ab 105; die App
  meldet eine ältere beim Start und bietet den Play Store an. Grund: Die
  Oberfläche nutzt `:has()`, `:focus-visible` und `inert`, und das WebKit
  einer App kommt unter macOS 11 und 12 nur mit Updates von macOS, nicht mit
  einem neueren Safari (Review vom 07.11., Punkt 14). Das Build-Ziel bleibt `safari14` und
  `chrome87`; es höher zu setzen ändert die Helfer im Bundle und damit den
  Lizenzbeleg, das kann ein eigener Pull Request tun. Die fehlenden
  Sicherheitsupdates der Webansicht auf alten Systemen stehen in
  [`SECURITY.md`](../SECURITY.md).
- **Wildcards in `known_hosts`:** zurückgestellt (Punkt 14).

## Gebaut

| Bereich | Stand |
| --- | --- |
| M0 Fundament, UI v2 | abgeschlossen mit 0.1.1 und 0.1.2; Farbwahl (7 Akzente auf 2 Grundtönen) und Einstellungsdialog |
| Seitenleiste und Grundtöne | nach der [Spec vom 14.11.](specs/2026-11-14-seitenleiste-und-grundtoene-design.md), noch nicht veröffentlicht: Einklappknopf und Symbolleiste der eingeklappten Seitenleiste mit der Einstellung `sidebar_rail`, Marke im Fuß ohne Commit, vier weitere Grundtöne (42 Varianten) |
| Stabilität und Verbindung | Kontroll- und Terminalverbindung je Host, Fristen, Kontrollreparatur, Korrekturen an Hostschlüsseln, Erststart und Hostverwaltung, RSA-Blinding; Hostschlüssel-Algorithmen nach `known_hosts`, weitere Agent-Schlüssel nach einer verweigerten Signatur |
| M1 Statuspunkt | Tor bestanden (automatisiert am 23.10., am Fenster gemeldet am 24.10.): numerische Sessionbindung (tmux 3.0, 3.3a, 3.4, 3.6), Statuspille, Aufmerksamkeit; Claude Code über `claude agents --json`, Codex und Grok über den Panetitel ([Messung](messungen/messung-2026-10-23-agentversionen.md)) |
| UX-Überarbeitung | gebaut nach der [Spec vom 11.10.](specs/2026-10-11-ux-ueberarbeitung-design.md): Kopieren und Einfügen wie in Windows Terminal samt OSC 52, Terminalmenü, Links, Suchleiste, Schriftgröße; Selbstheilung für Schlüssel- und Agent-Hosts; Arbeitsplatz, Schnellöffnen, ziehbare Seitenleiste; fünf Einstellungsbereiche |
| Dynamisches Raster | Schritt 0, 1 und 3 nach der [Spec vom 19.10.](specs/2026-10-19-dynamisches-raster-design.md): bis zu 9 Kacheln, höchstens 8 je Host, Tauschen, Spalt, Maximieren, Wartet-Spur |
| M3.1 Standard-Socket | nach der [Spec vom 25.10.](specs/2026-10-25-standard-socket-design.md), mit 0.2.2 ausgeliefert und [abgenommen](messungen/messung-2026-10-25-m31-abnahme.md) |
| Windows-Lieferung | `npm run build:windows` baut MSI, NSIS und ZIP mit Lizenzbeigaben, unsigniert ([Beleg zu NSIS 3.13](release/windows-installer-nsis-3.13-2026-10-30.md)); `packages.yml` baut sie bei jedem Tag, installiert und startet jedes Paket auf einem frischen Runner und hängt sie an das Release |
| macOS-Lieferung | nach der [Spec vom 25.10.](specs/2026-10-25-macos-lieferung-design.md), seit 0.2.3: Universal-DMG, ad-hoc signiert, [macOS-Lizenzauswahl](release/license-selection.macos-universal.json) mit 390 Komponenten; Testinstallation auf Apple silicon und Intel |
| Android | nach der [Spec vom 27.10.](specs/2026-10-27-android-design.md), seit 0.2.4: ab Android 7.0 (seit dem 07.11. mit Android System WebView ab 105), seit 0.3.0 Ziel API 37 mit der Berechtigung fürs lokale Netz (bis 0.2.7 API 36); kompakte Ansicht und Touch-Leiste, `android.yml` mit Signatur im eigenen Job, eigene [Lizenzauswahl](release/license-selection.android-universal.json) mit 485 Komponenten; eine Abnahme nach [Plan](plans/2026-10-27-android.md) steht aus |
| Abhängigkeiten | zuletzt am 05.11. (PR #24 bis #27, #32, #34) und am 06.11. das Ziel-SDK 37 (PR #37); die offenen Stufen unter Punkt 12 |

## Letzte Prüfung

Am 13.11.2026 nach 0.3.3: drei Prüfungen auf `main` (`9a6a03c`), die nur
lasen: der Code seit der Durchsicht vom 10.11., der Aufbau der großen Dateien
und die Tests. Danach bewertete je ein neutraler Agent jeden Fund; zwei stellten
das Verhalten von Chromium in Edge 157 an einer Minimalseite nach. Kein hoher
Befund. Was einen Effekt für Nutzer hat, behebt PR #56 (CHANGELOG
`[0.3.4]`): Ein Klick in der
Seitenleiste geht nicht mehr verloren, wenn sie während des Drucks neu gebaut
wird; mit „Screen reader support“ laden Browsertasten auf einer Zeile des
Bildschirmlesers die App nicht mehr neu; und auf Android vergisst das Entfernen
eines Hosts dessen Hostschlüssel. Eine neutrale Prüfung las den Branch gegen
und fand, dass der Ausweg unter Android bei zwei gespeicherten Hosts mit
derselben Adresse im Kreis führte und dass ein aufgeschobenes Neuzeichnen die
Fokusrettung nach dem Entfernen verpassen konnte; behoben im selben PR. Was
offen bleibt oder nicht übernommen wurde, steht unter Punkt 16. Lokal: `licenses:status` ohne Abweichung nach
`rebind-own`, Clippy für Windows und `aarch64-linux-android`, 716
Rust-Bibliothekstests, mit den Integrationstests 792, 3031 Vitest-Tests, 251
Skripttests und `npm run build`. Nicht geprüft: der Klick-Verlust in der
laufenden App (der Tipp in der Telefonansicht nur emuliert), die Tasten mit
einem echten Bildschirmleser, das Vergessen des Schlüssels an einem
Android-Gerät. Die Durchsicht vom 10.11. steht in der Git-Historie dieser Datei.

Der letzte Live-Lauf ging am 14.11. auf dem Tag `v0.3.4` (`6cff307`) von
Windows aus gegen beide Test-VMs, auf eigenen Testsockets. Gegen die VM mit
Ubuntu 26.04, OpenSSH 10.2 und tmux 3.6: alle 792 Rust-Tests grün, darunter
`integration_default_socket` voll (sein Listentest braucht tmux 3.3a oder
3.6), und die VM-Abnahme (`acceptance_vm`) 11 von 11. Gegen die VM mit
Debian 12, OpenSSH 9.2 und tmux 3.3a, die davor zuletzt am 25.10. lief
([M3.1-Abnahme](messungen/messung-2026-10-25-m31-abnahme.md)): ebenfalls alle
792 Rust-Tests grün und die VM-Abnahme 10 von 11. Der Test der sieben
Fehlerzweige bricht dort vor SSH ab, weil diese VM kein Wegwerfkonto für den
Passwortzweig hat (`AIDEVBRIDGE_VM_PASSWORD_USER`); ein Fehler der App ist das
nicht. Übersprungen auf beiden: der RSA-Zweig (kein
`AIDEVBRIDGE_TEST_RSA_KEY`), der Passwortzweig (kein
`AIDEVBRIDGE_VM_PASSWORD`) und der ssh-agent-Zweig (Dienst auf dem Rechner
aus).
Kein Live-Test löst die Frist beim Kanalöffnen aus, die 0.3.2 geändert hat;
den neuen Pfad prüfen nur die Unit-Tests. Den Passwortzweig prüfte zuletzt der
Lauf vom 27.10. auf `7b961cf` gegen einen lokalen Linux-Testhost mit tmux 3.4
(VM-Abnahme 11 von 11, nur der ssh-agent-Zweig übersprungen).

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
   `rsa` (eingeordnet in [`SECURITY.md`](../SECURITY.md); behoben in `rsa`
   0.10.0, der Wechsel wartet auf russh, Punkt 12) mit einer echten
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
   `npm run build:app` bleibt auf dem eigenen Rechner. Die EXE von 0.2.7 aus
   der CI (Visual Studio 2026, MSVC 14.51) linkt laut Importtabelle und
   Rich-Header dieselben Microsoft-Laufzeitfamilien wie der lokale Bau vom
   12.09.; zu liefern ist nichts zusätzlich
   ([Beleg vom 05.11.](release/license-windows-runtime-2026-11-05.md)). Ihre
   PDB ist nicht erhalten; seitdem bewahrt `packages.yml` sie 90 Tage als
   Artefakt `windows-symbols` auf, damit der nächste Werkzeugwechsel Modul
   für Modul geprüft werden kann. Copyright-Zeilen im Quelltext, die kein
   ausgelieferter Text nennt, liefern die Auswahlen wörtlich in
   `<Paket>-<Version>-SOURCE-NOTICES.txt` mit: seit dem 05.11. für
   crypto-bigint, seit dem 06.11. für futures-channel und crypto-primes und
   nach einem Scan aller 405 Komponenten für tao (W3C-Lizenz der
   Tastaturnamen), curve25519-dalek, tauri, tauri-plugin-fs, polyval, der,
   toml, cookie und dtoa, auf Android auch für is-wsl und cesu8. Warum die
   übrigen Treffer nicht dazugehören, steht im
   [Beleg](release/license-source-notices-2026-11-06-scan.json).
   Offen:
   - Die Installerabnahme (bestanden am 24.10. an 0.2.0) ist mit NSIS 3.13 neu
     fällig: Der Maintainer prüft die Setup-EXE an den Paketen von 0.3.2. Das
     Manifest jedes Laufs meldet `nsis_msi_payload`, `installer_terms_ui`,
     `installer_stub_notices`, `native_import_family_review` und
     `product_and_windows_acceptance` weiter als `pending`, weil ein Bau sie
     nicht kennt.
   - Die NDK-Belege aller drei ABIs stammen aus dem Android-Probelauf
     43005268807 auf `4243ed2` (Release-PR von 0.3.3). Ihr SHA-256 gehört zu
     diesem Bau: Der Tag-Bau trägt in der Oberfläche einen anderen Commit und
     hat deshalb einen anderen. Seit dem 11.11. liest jeder Lauf von
     `android.yml` die Belege aus dem eigenen Bau und scheitert, wenn sich eine
     Aussage geändert hat; `licenses:derive` behält die gebundenen Belege und
     nimmt neue nur aus der Datei eines Release-Laufs (`--native-evidence`,
     [Anleitung](lizenzen-pflegen.md)).
   - Lokal gebaute Pakete bis 0.2.2 enthalten Pfade des Cargo-Registers mit
     dem Benutzernamen des Bauprofils; hingenommen, seit 0.2.3 baut die CI.
7. **Echte Abnahmen:**
   - die [Handabnahme](abnahme-handarbeit.md) am Windows-Fenster: echte
     Tastatur, Rechtsklick, Skalierung 100 und 150 % am echten Bildschirm,
     Standby und Netzwechsel, Bildschirmleser und die Farbthemen (42 seit
     der Spec vom 14.11.); dazu §10 und §11.
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
   Der Klick-Verlust der Seitenleiste (Verdacht aus dem Review vom 03.11.) ist
   am 13.11. bestätigt und behoben: Fiel die gedrückte Zeile vor dem Loslassen
   aus dem Dokument, schickte Chromium keinen Klick (Edge 157, Minimalseite).
   Sicher traf es den ersten Klick nach einem Fokus in der Wartet-Spur. Seitdem
   wartet ein Neuzeichnen während eines Drucks bis nach dem Klick, höchstens
   2 s. In der laufenden App nicht nachgestellt. Bekannte Fehler:
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
    SKIP); auf 3.6 lief er zuletzt am 11.11., auf 3.3a am 25.10. (Letzte
    Prüfung). Außerdem:
    - **`#` vor `[` im Startordner:** Die Regel verdoppelt jede Folge von `#`,
      außer direkt vor `[` (ab tmux 3.3a eine Stilmarke,
      [Messung](messungen/messung-2026-10-26-tmux-cwd-format.md)); der
      Maintainer bestätigt sie noch.
    - **Startordner mit `;` am Ende:** tmux liest ein solches Element als
      Trenner; die Session startet im Ordner ohne das `;`. Einschleusen lässt
      sich nichts. Möglicher Weg: `\;` im Argument von `-c`, nach einer
      Messung auf tmux 3.0a, 3.3a, 3.4 und 3.6.
11. **Android:** Die Schritte des Maintainers in der Play Console, ohne Eile:
    der geschlossene Test mit 12 Testern über 14 Tage (dafür fehlen noch
    Tester, das dauert voraussichtlich noch einige Monate; bis dahin ist die
    App für den eigenen Gebrauch gedacht und nur als APK auf GitHub zu haben),
    die Datenschutz-URL
    und das Hochladen des App Bundles von Hand; erst mit einem
    Play-Dienstkonto im Environment `android-release` lädt `android.yml`
    selbst hoch ([Anleitung](android-veroeffentlichung.md)). Das signierte
    App Bundle von 0.3.4 (versionCode 3004) liegt nur als Artefakt
    `android-signed` des Laufs 43574406162 vor, bis zum 12.02.2027. Ist es
    abgelaufen, baut ein Lauf von `android.yml` von Hand mit der Eingabe `tag`
    es neu, und mit Dienstkonto lädt derselbe Lauf es hoch; der Job, der das APK
    anhängt, kann dabei rot werden, wenn der Neubau andere Bytes hat, das
    Hochladen hängt nicht an ihm. Am Gerät zu
    klären (Review vom 03.11.): ob Android den WebView im Hintergrund so
    anhält, dass die Acks länger als 30 s ausbleiben; dann schließt
    `STALL_TIMEOUT` die Terminals, und die Kacheln hängen sich nach der
    Rückkehr neu an. Ziel-SDK 37: Die Prüfung der Berechtigung fürs lokale
    Netz nach Schritt B3 der [Anleitung](android-veroeffentlichung.md) bestand
    am 06.11. auf einem Telefon mit Android 17. Hosts hinter einem VPN sperrt
    Android laut seiner Doku nicht; ob es Loopback sperrt, ist ungeprüft.
    Offen aus dem Review vom 06.11. (Spec-Nachtrag zum Ziel-SDK 37):
    - Die App erkennt das lokale Netz an Adressbereichen, Android an der
      Schnittstelle. Ein Host im WLAN mit öffentlicher IPv6-Adresse bekommt
      keinen Dialog; genauer ginge es mit den Präfixen aus `LinkProperties`,
      das braucht einen Gerätetest.
    - Die Namensauflösung, mit der `prepare` ein Ziel einordnet, läuft
      außerhalb des begrenzten Pools der Verbindungen und wird nach 10 s nur
      verlassen, nicht beendet. `prepare` bemerkt auch kein Abbrechen des
      Versuchs; ein abgebrochener Versuch kann noch einen Dialog öffnen.
    - Ein Dialog, der länger als 120 s offen bleibt, gilt für den wartenden
      Aufbau als unbeantwortet. Seit 0.3.1 fragt kein weiterer Host neu,
      solange der Dialog offen ist, und geht ohne Antwort weiter (Prüfung vom
      09.11.); am Gerät nicht nachgestellt.
12. **Abhängigkeiten, weitere Stufen:** jede als eigener Pull Request, weil
    jede in der Herkunft der Release-Bauten oder in den Lizenzbelegen
    gebunden ist. Erledigt bis zum 06.11.: Tauri 2.12, Tauri-CLI 2.12.4 mit
    NSIS 3.13, russh 0.65.1, `lucide-static` 1.69, `dirs` 7, `toml` 1,
    `sha2` 0.11, TypeScript 6, Vitest 5, jsdom 30 und Vite 8 (mit Ziel
    Safari 14 und Chrome 87 wie bisher;
    [Beleg](release/license-frontend-vite-8-2026-11-05.json)), dazu für
    Android Gradle 9.6, AGP 9.3, Kotlin 2.2 und die androidx-Updates mit
    Locks für den Buildscript-Classpath, `verification-metadata.xml` und
    Clippy für das Android-Ziel (PR #34,
    [Nachtrag der Android-Spec](specs/2026-10-27-android-design.md#nachtrag-vom-05112026-gradle-9-agp-9-und-kotlin-2)),
    am 06.11. das Ziel-SDK 37 mit der Berechtigung fürs lokale Netz, die
    Android 17 dafür verlangt (PR #37,
    [Nachtrag der Android-Spec](specs/2026-10-27-android-design.md#nachtrag-vom-05112026-ziel-sdk-37-und-das-lokale-netz)).
    Offen:
    - **Tauri v3:** Mit ihm fallen die Übergangsschalter
      `android.builtInKotlin=false` und `android.newDsl=false`.
    - **TypeScript 7:** Der native Compiler hat in 7.0 keine stabile JS-API;
      `src/source-hygiene.test.ts` und `release-license-inventory-frontend.mjs`
      brauchen `ts.createSourceFile`.
    - **Jackson 2.15.3** in der Android-App, über Tauris Android-Bibliothek:
      15 Meldungen, alle in 2.18.11 behoben und für die App nicht erreichbar
      ([`SECURITY.md`](../SECURITY.md)). Ein Gradle-Constraint auf 2.18.11
      braucht einen eigenen Pull Request; kein Workflow prüft bisher die
      Android-Bibliotheken auf Meldungen (etwa `app/gradle.lockfile` gegen
      OSV in `audit.yml`).
    - **`rsa` 0.10.0** (08.11.) behebt RUSTSEC-2023-0071. Außer den Pins
      auf die Vorabversion (App und vendortes russh) steht die eigene Zeile
      der App im Weg (Feature `sha2` entfällt, PKCS#1 v1.5 braucht das neue
      Feature `pkcs1v15`), dazu zwei weitere Pins von russh 0.65.1: `ssh-key`
      0.7.0-rc.11 verlangt ebenfalls `sha2` (passend ist `ssh-key`
      0.7.0-rc.12 vom 09.11.), und `pkcs1` 0.8.0-rc.4, `rsa` 0.10.0 braucht
      0.8.0. Ob russh dafür Code ändern muss, ist ungeprüft. Der Wechsel kommt
      mit einer russh-Version, die diese Versionen nimmt, oder als eigenes
      Update der Kopie; bis dahin ignoriert `audit.yml` die Meldung weiter
      ([`SECURITY.md`](../SECURITY.md)).
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
      yes`: am 05.11. vom Maintainer zurückgestellt. Die App schreibt einen
      bestätigten Host im Klartext, liest gehashte Einträge aber; die
      [Grenzen-Anleitung](guide/limits.md) nennt `ssh-keygen -H`. Gründe:
      Unter Windows und macOS setzt kaum jemand die Option, `settings.toml`
      führt dieselben Hosts ohnehin im Klartext, und genau ginge es nur mit
      einer Auswertung der `ssh_config` wie bei OpenSSH (`Host`, `Match`,
      `Include`). Empfehlung vom 08.11., falls das Thema mit den
      Linux-Paketen oder `IdentityAgent` (Punkt 14) wiederkommt: gehasht
      schreiben, wenn die Datei schon gehashte Einträge hat, ohne eigene
      Einstellung. Die ausführliche Abwägung steht im geschlossenen PR #36.
    - **Ablageorte unter macOS:** Nach einem Start ohne Verbindung liegen
      unter `~/Library` nur `WebKit/<id>/WebsiteData` und `Caches/<id>/WebKit`,
      wie `PRIVACY.md` sagt (gemessen am 05.11. auf Apple silicon und Intel,
      PR #31; die Liste läuft bei jedem Push mit). Ob Verbindungen und
      Gebrauch mehr anlegen, prüft die
      [Handabnahme §11](abnahme-handarbeit.md#11-änderungen-aus-dem-code-review-vom-0311),
      Schritt 5.
14. **Review vom 07.11.:** Fünf voneinander unabhängige Prüfungen, die nur
    lasen (Rust-Backend, Sicherheit, Frontend, Aufbau und Release-Ablauf,
    Plattformen), auf `main` (`59bea6a`). Die Fehler mit Wirkung für Nutzer
    behebt PR #42 (CHANGELOG `[0.3.0]`). Offen:
    - **Mindeststand der Webansicht:** entschieden am 07.11. (oben) und mit
      PR #42 in 0.3.0 umgesetzt. Offen: das Build-Ziel auf `safari15.5` und
      `chrome105` heben, mit neuem Lizenzbeleg für die Helfer im Bundle; der
      Hinweis auf eine alte WebView unter Android ist nur in der CI gebaut,
      nicht am Gerät gesehen.
    - **Wildcards und systemweite `known_hosts`:** Hosts, die nur über ein
      Muster (`*.example.com`) oder `/etc/ssh/ssh_known_hosts` bekannt sind,
      fragt die App wie beim Erstkontakt. Am 07.11. vom Maintainer
      zurückgestellt, weil zurückgesetzte Hosts sonst an der strengeren
      Prüfung scheitern. Zuerst kommt ein Weg, den alten Eintrag eines Hosts
      in der App zu entfernen. Auf Android vergisst seit dem 13.11. das
      Entfernen eines Hosts dessen Schlüssel (Nachtrag der Android-Spec); für
      den Desktop, wo die App die Datei mit OpenSSH teilt, fehlt der Weg weiter.
    - **CI und Release:** keine Paketbauten bei reinen Doku-PRs (Frist und
      Wiederholung für den apt-Schritt kamen mit der Prüfung vom 09.11.), die
      volle Lizenzprüfung auch bei geänderten eigenen Quellen,
      CHANGELOG-Einträge je PR; dazu GitHub-Einstellungen (ausgewählte
      Actions, CodeQL, Freigabe für `android-release`). Seit dem 11.11. setzt
      `npm run bump` die Version auch in der Windows-Auswahl, und
      `scripts/release-version.mjs` prüft bei jedem Push alle Versionsstellen
      (Version, Auswahlen, CHANGELOG, Kurzfassung, Store-Texte, Kopf dieser
      Datei, `SECURITY.md`).
    - **Aufbau:** ein typisierter IPC-Vertrag zwischen Rust und TS ohne neue
      Abhängigkeit, `main.ts` in Controller mit Abbau zerlegen, Batch 9 (U3)
      und ein gemeinsamer Fehlertyp der Commands.
    - **Plattformen:** Strg+V und Strg+Klick auf dem Mac (mit der
      Mac-Abnahme, Punkt 9), `IdentityAgent` für 1Password und Secretive,
      Linux-Pakete (deb und rpm), Testhosts mit mehreren tmux-Versionen und
      Shells.
15. **Durchsicht vom 10.11.:** Fünf voneinander unabhängige Prüfungen, die nur
    lasen, auf `main` (`4c61495`); PR #47 behebt, was sich lohnte (oben).
    Offen:
    - **Hostschlüssel anderen Typs:** Ist ein Host mit einem Schlüssel eines
      Typs bekannt und bietet der Server nur einen anderen Typ an, fragt die
      App wie beim Erstkontakt, mit einem Hinweissatz; OpenSSH lehnt das als
      geänderten Schlüssel ab (`check_hostkeys_by_key_or_type`). Jemand im
      Netz kommt so an der harten Ablehnung vorbei zur Rückfrage. Am 10.11.
      vom Maintainer zurückgestellt, solange die App in Entwicklung ist;
      als Grenze in [`SECURITY.md`](../SECURITY.md). Dazu gehören: Wartende
      Rückfragen erscheinen sofort mit aktiven Knöpfen (ein Doppelklick
      bestätigt die nächste ungelesen), und die Entscheidung liest
      `known_hosts` vom Beginn des Aufbaus, nicht erneut vor dem Anhängen.
    - **Sessionliste:** `observe_sessions` braucht 2N+3 Befehle nacheinander
      unter einer Frist von 15 s (`tmux/client.rs`); bei 20 Sessions und
      100 ms Laufzeit je Richtung reicht sie nicht. Ein gemeinsamer Aufruf
      ändert die gemessene Folge und braucht eine Messung auf tmux 3.0, 3.3a,
      3.4 und 3.6.
    - **Backend, klein:** Zweite Verbindung und Reparatur lösen den Hostnamen
      neu auf (Round-Robin-DNS kann sie auf zwei Rechner führen); eine Zeile,
      die `.bashrc` oder `.zshenv` ohne Terminal ausgibt, bricht die
      strenge Rahmung der tmux-Abfragen; `close_terminal` kann sein
      `open_terminal` überholen (Verdacht, enges Fenster). Erledigt mit
      0.3.3: die vergiftete Sperre der Register und die Aufnahme von Auflösung
      und Schlüsselvorbereitung, die jetzt bis zu 5 s auf einen Platz wartet.
      Ein `[profile.release]` fehlt weiter: Ein Überlauf ist nicht
      belegt, und eine Änderung beträfe jede Release-EXE samt Laufzeitbeleg.
    - **Release:** Die Windows-Pakete hängen an den macOS-Jobs (`publish`
      braucht alle vier); kein Starttest der APK in einem Emulator;
      `release-manifest.json` liegt nur 90 Tage als Artefakt vor, nicht am
      Release; das Play-Geheimnis käme in dasselbe Environment wie der
      Signaturschlüssel (vor dem Hinterlegen trennen, wie U2 für Apple); die
      Node-Version ist nur auf `24` gepinnt. Die neuen Schritte (Schranke
      „auf `main`“, Marke „Latest“) liefen beim Tag von 0.3.2 zum ersten Mal
      und hielten; das Release trägt die Marke.
    - **Frontend:** `main()` baut beim Abbau nicht alles ab (Seitenleiste,
      Dialoghülle, Rückfrage; betrifft die Tests). Seit 0.3.3 gibt es
      „Screen reader support“ (mit einem echten Bildschirmleser nicht
      geprüft), und in der Telefonansicht sind auch Felder und Knöpfe der
      Dialoge 40 px hoch; am Gerät ist die Telefonansicht weiter nicht
      angesehen.
    - **Doku:** Seit 0.3.2 steht auf jeder Release-Seite eine englische
      Kurzfassung (`docs/release/notes/<Version>.md`, Entscheidung des
      Maintainers vom 10.11.); das CHANGELOG bleibt deutsch. Ob es auf Englisch
      wechselt, ist offen. Android-Bau und Lizenzroutine sind nur deutsch
      beschrieben. Die Regel zur
      Kommentarsprache beschreibt den Stand nicht (Rust überwiegend deutsch,
      Skripte und Workflows überwiegend englisch). Die Merge-Commits tragen
      die private Mailadresse des Maintainers als Autor; die
      GitHub-Einstellung „Keep my email addresses private“ beendet das für
      künftige.
16. **Durchsicht vom 13.11.:** drei Prüfungen auf `main` (`9a6a03c`), danach
    je ein neutraler Agent je Fund (Letzte Prüfung). Offen:
    - **Umschalt+F10 mit „Screen reader support“:** xterm schickt die Taste
      ans Programm und hält sie nicht an; Chromium macht daraus zusätzlich
      ein Kontextmenü, das je nach Einstellung kopiert, einfügt oder das
      Terminalmenü öffnet. Ohne die Einstellung hält xterm die Taste an. Ob
      sie Menütaste bleibt oder nur ans Programm geht, entscheidet der
      Maintainer, am besten nach dem Test mit einem echten Bildschirmleser.
    - **Innere Sperren:** Die Absicherung der Register aus 0.3.3 erreicht
      `OperationControl`, `ConnectControl`, `HostConnection.state` und
      `Core.stop_gate` nicht. Panikt etwas unter einer davon (nie
      beobachtet), panikt das Aufräumen beim Abwickeln erneut, und die App
      bricht ab. Vorschlag mit niedriger Priorität: der Helfer von
      `registry()` für alle Sperren, die ein `Drop` erreicht (rund 45
      Stellen); ungeprüft ist, ob `HostConnection.state` nach einer Panik
      mitten in einer Änderung stimmig bliebe.
    - **CI:** `tests/socket_abort_probe.rs` scheiterte unter macOS dreimal
      (Lauf 40909348883 zweimal, 42359933034 einmal); jede Wiederholung
      bestand. Nicht untersucht.
    - **Aufbau und Tests:** Die Tests aus `settings.rs` können ohne Änderung
      nach `settings/tests.rs`. Batch 9 (U3) wie geplant, nicht erweitert,
      und erst direkt vor der nächsten Arbeit an Hosts oder Inventar. Vom
      IPC-Vertrag (Punkt 14) lohnt vorerst nur ein Vertragstest, der die
      Aufrufe des Frontends gegen die Rust-Quellen prüft. Der Abbau von
      `main()` (Punkt 15) betrifft nur Tests. Nicht übernommen: ein
      gemeinsames strenges Fake-Backend für die Tests und kürzere
      Zeitkonstanten unter `cfg(test)`; beides kostet mehr, als es bringt.
    - **Paketbauten bei Doku-PRs (Punkt 14):** wenn, dann nur für
      `pull_request` und mit fester Liste; `docs/release/**`,
      `THIRD_PARTY_LICENSES.md` und `fastlane/**` gehören nicht dazu, und
      `android.yml` ist eine gebundene Eingabe der Android-Auswahl.
17. **Seitenleiste und Grundtöne (Spec vom 14.11.):** gebaut, nur im
    Headless-Browser gegen Beispieldaten angesehen. Offen:
    - **Am Fenster:** die sechs Punkte aus §7 der Spec (Grundtöne bei
      laufenden Kacheln, Symbolleiste bei Zustandswechseln, Skalierung,
      Bildschirmleser, Android-Tablet, Kontrastdesign).
    - **Mit dem nächsten Release:** README (Zeile zu den Themen: 6
      Hintergründe, 42 Kombinationen; das Einklappen), die Bilder unter
      `docs/images` und für den Store neu rendern, die Anleitungen unter
      `guide/` auf Stellen zur Darstellung durchsehen.
    - **Zurückgestellt (§6 der Spec):** helles Thema, Aktionen in der
      Symbolleiste, weitere Darstellungsoptionen.

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
- Das Tor sind die lokalen Prüfungen aus der
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
