# NSIS 3.13 und Tauri-CLI 2.12.4 für die Windows-Installer

Stand 2026-10-30: Das Tauri-CLI geht von 2.11.4 auf 2.12.4. Sein Bundler lädt
NSIS 3.13 statt 3.11; WiX 3.14.1 und `nsis_tauri_utils` 0.5.3 bleiben. Dieser
Bericht hält fest, was dafür neu geprüft ist. Er ergänzt die Berichte vom
12.09. ([Attribution](windows-installer-attribution-2026-09-12.md),
[Quellarchive](windows-installer-source-archives-2026-09-12.md)), deren
Vorgehen er wiederholt.

## Bundler-Quelle

Das CLI 2.12.4 baut aus Commit
[`993038c`](https://github.com/tauri-apps/tauri/tree/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-bundler/src/bundle/windows)
(Tag `tauri-cli-v2.12.4`), das CLI 2.11.4 aus `8909f22`. Zwischen beiden
liegen 329 Commits. Für die Windows-Pakete zählt:

- `nsis/mod.rs`: NSIS 3.13 statt 3.11 (URL und SHA-1 der Distribution), und
  ein vorhandener Werkzeugordner wird zusätzlich über die SHA-1 von
  `NSIS.exe` geprüft. `nsis_tauri_utils` bleibt 0.5.3 mit derselben SHA-1.
  Neu ist die Option `bundle_vc_runtime`, die Visual-C++-Laufzeit-DLLs in
  den Installer legt; sie ist in `tauri-utils` 2.10.2 standardmäßig aus, und
  `src-tauri/tauri.release.windows.json` setzt sie nicht. Das
  Release-Skript prüft diese Konfiguration auf Gleichheit.
- `nsis/installer.nsi` und `nsis/utils.nsh`: `CheckIfAppIsRunning` sucht
  die laufende App jetzt über den Windows Restart Manager
  (`Win\RestartManager.nsh` aus NSIS, Aufrufe über das `System`-Plugin)
  statt über `FindProcess` und `KillProcess` aus `nsis_tauri_utils`. Die
  Suche nach einer früheren WiX-Installation ist in eine eigene Funktion
  gezogen, die auch die stillen Modi für die Downgrade-Sperre nutzen; dazu
  ein Rückfall für den falsch geschriebenen Sprachtext `choowHowToInstall`
  und das Aufräumen des alten Installationsordners nach einer
  Deinstallation an Ort und Stelle. Ein neues Plugin ruft die Vorlage nicht
  auf.
- `msi/mod.rs`: Die Ressourcen werden als Verzeichnisbaum mit eigenen
  WiX-Kennungen geschrieben; dazu dieselbe abgeschaltete
  `bundle_vc_runtime`-Option. Keine neue WiX-Erweiterung. Die Lizenzseite
  wird unverändert behandelt: Eine Datei, deren letzter Pfadbestandteil
  `.rtf` ist, geht ungewandelt in das MSI (`PathBuf::ends_with(".rtf")`,
  in beiden Versionen wörtlich gleich).

## NSIS-3.13-Distribution

| Archiv | Bytes | SHA-1 (im Bundler gepinnt) | SHA-256 |
| --- | ---: | --- | --- |
| [`nsis-3.11.zip`](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip) | 2.361.546 | `ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d` | `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1` |
| [`nsis-3.13.zip`](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip) | 2.363.925 | `db14f8af2ea346b786c6ae19343f61aaf5e09b8e` | `ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8` |

Beide Downloads stimmen mit der SHA-1 ihres Bundlers überein, `NSIS.exe`
aus 3.13 mit der neuen Prüfsumme `6d45d4e8ccf18fe1fdac9164058f356102a2ecf2`.

Die drei Lizenztexte, die die Auswahl aus der Distribution übernimmt:

| Neue Datei unter `docs/release/licenses/` | Mitglied von `nsis-3.13.zip` | Bytes | SHA-256 | gegenüber 3.11 |
| --- | --- | ---: | --- | --- |
| `nsis-3.13-COPYING.txt` | `COPYING` | 15.632 | `388357c1215ff403c5ebde3a5ecd273e68f8b79a579996775245d1ee65442aba` | nur `1999-2025` → `1999-2026` in Zeile 4 |
| `nsis-3.13-Modern-UI-2-LICENSE.txt` | `Docs/Modern UI 2/License.txt` | 840 | `36608f72902ac188e45eab9bf6f673df72dd76f871f61d0c6d60592dfc15461c` | nur `2002-2025` → `2002-2026` |
| `nsis-3.13-NSISdl-LICENSE.txt` | `Docs/NSISdl/License.txt` | 943 | `326e587f36ca58e14bd09cca153f9e69f1c5ed701189aa47d2d0627af7e16280` | bytegleich |

Bedingungen, Länge und Zeilenenden (CRLF, im Modern-UI-Text das ANSI-Byte
`A9`) sind gleich; die neuen Bytes werden ausgeliefert, die
`.gitattributes`-Einträge gelten für die neuen Namen.

Die gelieferten Bausteine sind in 3.13 neu gebaut: `System.dll`,
`nsDialogs.dll`, `StartMenu.dll` und `NSISdl.dll` unter
`Plugins/x86-unicode/` sowie der Stub `Stubs/lzma_solid-x86-unicode`
unterscheiden sich in den Bytes von 3.11. Das Wizard-Bild
`Contrib/Graphics/Wizard/win.bmp` und `Include/Win/RestartManager.nsh` sind
bytegleich. Die Plugin-Liste der Distribution ist dieselbe (16 DLLs).

## Quellarchiv v313

| | |
| --- | --- |
| Tag | `v313` (Tag-Objekt `3255586f67626dd397760cd7a68daa9847284020`) |
| Commit | `a4ba28e60bd9e7c271cd2bfc1558889ce3355653` |
| Download | `https://github.com/nsis-dev/nsis/archive/a4ba28e60bd9e7c271cd2bfc1558889ce3355653.zip`, HTTP 200, endgültig `https://codeload.github.com/nsis-dev/nsis/zip/a4ba28e60bd9e7c271cd2bfc1558889ce3355653`, `application/zip`, 2026-10-30 17:02 UTC |
| Datei | `docs/release/sources/nsis-3.13-source.zip`, 2.337.690 Bytes, SHA-256 `649b8c2a9c856fa8116cf0e2d6d91492acf3922d7dde10736e5742a178c8b22d` |
| ZIP-Kommentar | der Commit |
| Archivwurzel | `nsis-a4ba28e60bd9e7c271cd2bfc1558889ce3355653` |

Jede der 835 Dateien (8.924.374 Bytes entpackt) stimmt in Pfad, Größe und
Git-Blob-SHA-1 mit dem vollständigen Baum des Commits überein
(`truncated: false`); es fehlt keine, keine ist zusätzlich, es gibt keine
Symlinks und keine Submodule. Dieselbe Prüfung bestätigt das bisherige
Archiv `nsis-3.11-source.zip` gegen den Baum von `v311` (1.668 Dateien).
Der Unterschied in der Größe kommt aus `v311` selbst: Dessen Baum enthält
zusätzlich einen doppelten Ordner `trunk/` mit 834 Dateien aus der
Geschichte des Repositorys, den `v313` nicht mehr hat; sonst kommt in
`v313` nur `.gitignore` hinzu.

Die für den Decoder maßgeblichen Dateien ändern sich nur im Copyright-Jahr:
`Source/7zip/LZMADecode.c` und `LZMADecode.h` (`2003-2025` → `2003-2026`,
weiter „Licensed under the Common Public License version 1.0“) und
`Source/Platform.h` (zlib/libpng). Der Stub-Bau `Source/exehead/SConscript`
ist derselbe Blob wie in `v311`; der Stub bindet den Decoder also wie
bisher ein.

## Auslese der gebauten Installer

Gebaut mit `npm run build:windows` auf Commit `70ced95` (Lauf
`20261030T171031005-c9ace27052ef`, Tauri-CLI 2.12.4, Rust 1.97.1); das
Release-Skript hat die drei Downloads gegen ihre gepinnten Hashes geprüft
und das ZIP verifiziert. Ausgelesen mit 7-Zip 26.03 (offizielles Release
`ip7z/7zip`, `7z2603-x64.msi`, SHA-256
`c0680064d698a62dd4a5a47f403db356a6531a5473e4c4b1d090ea2590513926`, ohne
Installation entpackt) und der Windows-Installer-Schnittstelle, nur lesend.
Zum Vergleich dieselbe Auslese an Setup und MSI des Releases 0.2.4 (CLI
2.11.4, NSIS 3.11).

**Setup-EXE** (`aidevbridge-0.2.4-windows-x64-setup.exe`, 19.042.588 Bytes):
Außer der App, dem Uninstaller und `licenses/` enthält es genau

| Datei unter `$PLUGINSDIR` | Bytes | bytegleich zu |
| --- | ---: | --- |
| `System.dll` | 12.288 | `nsis-3.13.zip`, `Plugins/x86-unicode/System.dll` |
| `nsDialogs.dll` | 9.728 | `Plugins/x86-unicode/nsDialogs.dll` |
| `StartMenu.dll` | 7.680 | `Plugins/x86-unicode/StartMenu.dll` |
| `NSISdl.dll` | 15.360 | `Plugins/x86-unicode/NSISdl.dll` |
| `nsis_tauri_utils.dll` | 34.304 | dem gepinnten Download 0.5.3 |
| `modern-wizard.bmp` | 26.494 | `Contrib/Graphics/Wizard/win.bmp` |

Das ist derselbe Satz wie im Setup von 0.2.4, dort bytegleich zu NSIS 3.11.
Das erzeugte Skript setzt `SetCompressor /SOLID "lzma"` (Stub
`lzma_solid-x86-unicode` mit dem LZMA-Decoder), bindet `MUI2.nsh` und
`Win\RestartManager.nsh` ein und ruft als Plugins nur `System`,
`nsDialogs`, `NSISdl` und `nsis_tauri_utils` auf; `StartMenu` und das
Wizard-Bild kommen über Modern UI 2. `RSTRTMGR::…` und die
`I…`-Schnittstellen in den Skripten sind Windows-Funktionen, die über
`System.dll` aufgerufen werden, keine Plugins. `licenses/` im Setup ist
Datei für Datei gleich dem geprüften Hinweisordner (214 Dateien, darunter
die drei NSIS-3.13-Texte und `sources/nsis-3.13-source.zip`).

**MSI** (`aidevbridge-0.2.4-windows-x64.msi`, 21.307.508 Bytes): Die
Tabelle `Binary` enthält dieselben sieben Einträge wie das MSI von 0.2.4,
jeder mit denselben Bytes: `WixUIWixca` (135.440), `WixUI_Bmp_Banner`,
`WixUI_Bmp_Dialog`, `WixUI_Ico_Exclam`, `WixUI_Ico_Info`, `WixUI_Bmp_New`,
`WixUI_Bmp_Up`. Dieselben Custom Actions verweisen auf `WixUIWixca`
(`WixUIValidatePath`, `WixUIPrintEula`); kein WixUtil-Binary. Eine Datei
weniger als 0.2.4 (215 statt 216): der Lizenztext, der mit dem Update auf
Tauri 2.12 entfallen ist.

## Entscheidung

Die Zuordnung vom 12.09. gilt unverändert für NSIS 3.13: dieselben
Bausteine, dieselben Lizenzen, die Texte mit neuem Jahr. Die vier
NSIS-Komponenten führen 3.13, ihre Texte und das Quellarchiv `v313`;
`nsis_tauri_utils` und WiX UI bleiben und sind an den neuen Installern
nachgeprüft. Offen bleibt wie bisher die Abnahme am Fenster (Lizenzseite,
Installation, Start); die CI installiert und startet die Pakete auf einem
frischen Windows-Runner.
