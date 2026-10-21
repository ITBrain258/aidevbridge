# Konkrete Installer-Attribution und noch nötige Quellbeigaben

Stand 2026-09-12: Fünf Originaltexte und sechs eng begrenzte Installerfamilien
sind der bestehenden Auswahl hinzugefügt. Die bisherigen 411 Komponenten,
204 Dokumente und ihre Entscheidungen bleiben unverändert. Der Lizenzhelfer
benötigt keine Änderung. Dies ergänzt die lokale Attribution; die neuen
Texte sind noch nicht Bestandteil der zuvor gebauten Installer.

## Übernommene Originalbytes

Die vier Archivtexte wurden erneut gegen die hashgebundenen ZIP-Mitglieder
des ersten erhaltenen Runs `20260912T134528325-4baf35c28cbd` verglichen und
bytegenau kopiert. Das fünfte Original stammt unmittelbar aus dem bestätigten
Plugin-Quellcommit, ohne Textkonvertierung.

| Neue Datei unter `docs/release/licenses/` | Bytes | SHA-256 |
| --- | ---: | --- |
| `wix-3.14.1-LICENSE.txt` | 3.369 | `4004370957cfc16afa52582f0cbd56c98a2f00846d6dadc51c7c7ab0500c0000` |
| `nsis-3.11-COPYING.txt` | 15.632 | `e7dd514003ab96cb3ddccbc028fe5c795fccf57dc41f21cfb9d4dd16ead23bf5` |
| `nsis-3.11-Modern-UI-2-LICENSE.txt` | 840 | `d5957bd99460eb21148bd2695eeb5a3718abae6b118040a4678926da3f4cfbc0` |
| `nsis-3.11-NSISdl-LICENSE.txt` | 943 | `326e587f36ca58e14bd09cca153f9e69f1c5ed701189aa47d2d0627af7e16280` |
| `nsis-tauri-utils-0.5.3-LICENSE-MIT.txt` | 1.110 | `1c1020fa10a6bf318717e82c911bcc54ebdfb9bb280460ae332bcb2f82f57fbe` |

Die Herkunft ist das [WiX-Binärarchiv](https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip),
Tauris [NSIS-3.11-Distribution](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip)
und der [MIT-Text von nsis-tauri-utils am exakten Commit](https://raw.githubusercontent.com/tauri-apps/nsis-tauri-utils/13d9edd27b69310e108d6fbd49f90992f8a05390/LICENSE_MIT).
Archivhashes, Mitgliedsnamen, lokale Originalpfade, HTTP-Herkunft und
Zeilenende-/Byteangaben stehen im erhaltenen Nachweis
`out/release-inspection/license-integration-20260912-b27f8c7d7bc2/license-originals.json`.

Alle vier Archivtexte haben CRLF. Modern UI 2 enthält das originale
ANSI-Copyrightbyte `A9`. Vier exakt dateigebundene `.gitattributes`-Einträge
mit `-text whitespace=cr-at-eol` erhalten diese Bytes auch beim Commit.
COPYING enthält außerdem originale Leerzeichen am Ende der Zeilen
40, 69, 83, 87, 97, 99, 103, 107, 109 und 139. Die entsprechenden
Git-Whitespacehinweise werden offengelegt; keine zusätzliche Ausnahme und
keine Bereinigung dieser Lizenzbytes wurde eingeführt. Eigene Änderungen
müssen die gewöhnliche Whitespaceprüfung bestehen.

## Zuordnung zum tatsächlich untersuchten Paket

Grundlage ist der erfolgreiche Run `20260912T140132351-74840f2ccf5b` auf
`de2df77`, mit getrennten gegenseitigen MSI-/NSIS-Prüfungen. Die MSI-Auslese
liegt unter `out/release-inspection/msi-20260912-c16e906964ff`, die NSIS-Auslese
und Roots MSI-Gegenreview unter
`out/release-inspection/20260912-nsis-r3ce849a201fb`.

- NSIS-Engine, Installer/Uninstaller, **System, nsDialogs, StartMenu** und das
  Wizard-Bild erhalten die vollständige COPYING-Zuordnung. Die drei DLLs und
  das Bild sind bytegleich zu den gepinnten Originalen. Andere Archivplugins
  werden nicht als geliefert behauptet.
- Der **LZMA-Decoder** erhält dieselbe vollständige COPYING-Datei als eigene
  CPL-Familie mit der enthaltenen Link-Ausnahme. Das erzeugte Skript setzt
  `SetCompressor /SOLID "lzma"`; der konkrete Stub-Bau bindet den Decoder ein.
  Seine Quellbeigabe bleibt erforderlich.
- **Modern UI 2** ist über `MUI2.nsh` im erzeugten Skript belegt und erhält
  seinen eigenen unveränderten Verburg-Text.
- **NSISdl** ist der vierte tatsächlich extrahierte Standardplugin und
  erhält seinen eigenen Text samt COPYING. Die DLL ist bytegleich zum
  gepinnten `x86-unicode`-Original.
- **nsis_tauri_utils 0.5.3** ist der fünfte Plugin und bytegleich zum
  gepinnten einzelnen DLL-Download. Sein eigener MIT-Text kommt hinzu.
  Bereits ausgewählte MIT-Texte für Rust core/alloc, windows-sys und semver
  werden als konservative Familienhinweise wiederverwendet. Das
  [Quellmanifest](https://github.com/tauri-apps/nsis-tauri-utils/blob/13d9edd27b69310e108d6fbd49f90992f8a05390/crates/nsis-tauri-utils/Cargo.toml)
  und die [Plugin-API](https://github.com/tauri-apps/nsis-tauri-utils/blob/13d9edd27b69310e108d6fbd49f90992f8a05390/crates/nsis-plugin-api/src/lib.rs)
  belegen diese Familien. Die versionierten Namen bereits vorhandener
  Lizenzdateien bezeichnen deren gespeicherte Herkunft; sie behaupten keine
  exakten Compiler-/Dependencyversionen der vorgebauten DLL. Daraus wird
  ohne konkrete Textlücke kein zusätzlicher Blocker abgeleitet.
- **WiX UI** umfasst tatsächlich `WixUIWixca` (x86-`uica.dll`), sechs Bilder
  und die zugehörigen MSI-UI-Tabellen. Alle sieben Binary-Dateien sind
  bytegleich zum eingebetteten CAB der gepinnten `WixUIExtension.dll`.
  `WixUIValidatePath` und `WixUIPrintEula` referenzieren diese DLL. Die
  WiX-LICENSE-Zuordnung umfasst diese Teile; **kein WixUtil-Binary** wird
  behauptet. Passende Quellen und Buildbezüge bleiben als Beigabe offen.

## Quellumfang und Entscheidung für den nächsten Schritt

Die bereits unabhängig geprüften CPL-/MS-RL-Quellpflichten werden hier
nicht neu bewertet. Konkret betroffen sind folgende Quell- und Buildbezüge:

**NSIS:** `Source/7zip/LZMADecode.c` (14.826 Bytes) und `LZMADecode.h`
(2.730 Bytes). Der Header bindet zusätzlich `Source/Platform.h` ein. Zum
richtigen Buildkontext gehören `Source/exehead/SConscript`, die Stub-Dateien
unter `Source/exehead/`, das zentrale `SConstruct`, `SCons/`, `INSTALL` und
`COPYING`. Zwei herauskopierte Decoderdateien allein würden diesen Bezug
nicht vollständig wiedergeben. [Header](https://github.com/kichik/nsis/blob/7359413009afd4f0fff472d841fc2f2cc0e0a5f8/Source/7zip/LZMADecode.h),
[Stub-Bau](https://github.com/kichik/nsis/blob/7359413009afd4f0fff472d841fc2f2cc0e0a5f8/Source/exehead/SConscript),
[Buildanleitung](https://github.com/kichik/nsis/blob/7359413009afd4f0fff472d841fc2f2cc0e0a5f8/INSTALL).

**WiX:** Die acht Dateien unter `src/ext/UIExtension/ca/` umfassen
25.771 Bytes, darunter `DriveCheck.cpp`, `PrintEula.cpp`, `dllmain.cpp`,
die Header sowie `uica.def`, `uica.rc` und `uica.vcxproj`. Das
[Projekt](https://github.com/wixtoolset/wix3/blob/b40e9a32c24033e11b77baf2c91a704382f898ed/src/ext/UIExtension/ca/uica.vcxproj)
bindet `dutil`/`wcautil` und zentrale `tools/WixBuild.*`-Regeln ein. Dazu
kommen UI-Fragmente/Übersetzungen und die sechs Originalgrafiken, deren
Zuordnung [Common.wxs](https://github.com/wixtoolset/wix3/blob/b40e9a32c24033e11b77baf2c91a704382f898ed/src/ext/UIExtension/wixlib/Common.wxs)
und [UIExtension.wixproj](https://github.com/wixtoolset/wix3/blob/b40e9a32c24033e11b77baf2c91a704382f898ed/src/ext/UIExtension/wixlib/UIExtension.wixproj)
festlegen. Eine Liste nur der beiden aufgerufenen C++-Funktionen wäre keine
vollständige Quellbeigabe dieser DLL und UI-Ressourcen.

Die offiziellen rekursiven Tagtrees wurden vollständig gelesen
(`truncated: false`); ihre unveränderten JSON-Antworten und Commit-Auflösung
liegen im oben genannten neuen Prüfordner:

| Vollständiger Quellstand | Dateien | Summe unkomprimierter Git-Dateibytes |
| --- | ---: | ---: |
| NSIS `v311`, Commit `7359413009afd4f0fff472d841fc2f2cc0e0a5f8` | 1.668 | 17.826.239 |
| WiX `wix3141rtm`, Commit `b40e9a32c24033e11b77baf2c91a704382f898ed` | 3.295 | 51.651.333 |

**Empfehlung:** Je ein vollständiges originales Quellarchiv dieser beiden
Commits als gesonderte Releasebeigabe. Rund 66,3 MiB unkomprimierter
Dateiinhalt insgesamt sind überschaubar; das vermeidet eine eigens gepflegte
transitive Auswahl von gemeinsamen Headern, Bibliotheken und Buildregeln.
Die Archive selbst wurden in diesem Auftrag nicht heruntergeladen; ihre
komprimierten Größen und SHA-256 sind noch nicht gemessen. Nächster Schritt
ist ihre einmalige Beschaffung aus den offiziellen Repositories, Festhalten
der Originalbytes und eine kurze Zuordnung der betroffenen Pfade plus
vorhandener Buildanleitungen. Ein tatsächlicher Wiederaufbau oder eine
binäre Reproduzierbarkeit wird damit nicht behauptet. Eine allgemeine
Archivpipeline wurde nicht eingeführt.

## Begrenzte lokale Prüfung

`node --test scripts/release-licenses.test.mjs` bestand unter Windows mit
**21/21 Tests**, Exit 0, ohne übersprungene Fälle. Für die wirkliche erweiterte
Auswahl wurden 272 genau gebundene Quelldateien in einen neuen isolierten
Eingangsordner kopiert. `prepare`, `check` und erneutes `prepare` bestanden;
alle fünf Ergänzungen sind bytegleich zu den Originalen, sämtliche 210
lokalen Dateilinks sind vorhanden. Die Ausgabe umfasst 417 Komponenten,
209 Volltexte und insgesamt 212 Dateien. Der erhaltene `offline-check.json`
im eigenen Prüfordner dokumentiert die genaue Auswahl und Ergebnisdateien.
Kein bisheriger Notice- oder Installerordner wurde ersetzt.

Vor Veröffentlichung bleiben die tatsächliche Quellarchivbeigabe, neue
Installer-/ZIP-Payloadprüfung dieser Texte, RTF-/Dialogabnahme und die
übrige Produkt-/Windows-Abnahme erforderlich. Dieser Schritt ist weder ein
neuer Paketbuild noch eine pauschale Lizenz- oder Releasefreigabe.
