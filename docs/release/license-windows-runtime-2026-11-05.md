# Windows-Laufzeit im Release-Bau mit Visual Studio 2026

Stand: 2026-11-05. Nachtrag zum [Beleg vom 12.09.](license-windows-runtime-2026-09-12.md).
Der [JSON-Beleg](license-windows-runtime-2026-11-05.json) enthält Hashes,
Tabellen und die zitierten Klauseln.

**Ergebnis:** Die EXE von 0.2.7 aus der CI linkt dieselben
Microsoft-Laufzeitfamilien wie der Bau vom 12.09. Die Auswahl bleibt, wie sie
ist: kein Visual-C++-Redistributable, keine Microsoft-DLL, die UCRT als Teil
von Windows 10/11, WebView2 über `downloadBootstrapper`. Nur der
[Laufzeithinweis](licenses/microsoft-windows-runtime-NOTICE.txt) nennt keine
Toolset-Version mehr.

## Was untersucht wurde

- **Quelle:** die Pakete aus dem Tag-Lauf von `v0.2.7`
  ([Lauf 42086815589](https://github.com/ITBrain258/aidevbridge/actions/runs/42086815589),
  Artefakt `windows-packages`, Commit `b81a437`). Ihre Hashes stimmen mit den
  Release-Assets überein.
- **Gelesen:** die `aidevbridge.exe` aus dem ZIP, 17.519.616 Bytes, SHA-256
  `0b5d93a7…250281`, gleich `native.exe` im `release-manifest.json`. Sie wurde
  nur gelesen, nicht gestartet.
- **Bauumgebung:** Der Runner `windows-2025` lief auf dem Image
  `windows-2025-vs2026` 20261030.294.1, laut
  [Image-Beschreibung](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/images/windows/Windows2025-VS2026-Readme.md):
  - Visual Studio Enterprise 2026 18.11 mit MSVC 14.51 als Standard; daneben
    die Toolsets 14.44 und 14.29;
  - Windows SDK 10.0.26100.0.

  Die statische VC-Laufzeit kommt aus `build.windows.staticVCRuntime` in
  `src-tauri/tauri.release.windows.json`.

## Befund

**Importe.** Die normale Importtabelle nennt 27 Namen, die Delay-Importtabelle
ist leer.
- Gegenüber dem 12.09. (22 Namen) kommen `imm32.dll` und
  `api-ms-win-core-winrt-error-l1-1-0.dll` dazu, beides Windows-DLLs, dazu
  großgeschriebene Doppelungen von ADVAPI32, KERNEL32 und WS2_32 aus einer
  zweiten Importbibliothek.
- Die sieben UCRT-API-Sets sind dieselben.
- VCRUNTIME140, MSVCP140 und WebView2Loader.dll stehen weder in den Importen
  noch als Zeichenkette in der Datei. „WebView2Loader“ erscheint nur als
  UTF-16-Text des statisch gelinkten Loaders.

**Linker.** Die EXE nennt Linker 14.51 statt 14.44.

**Rich-Header.** Die PDB wird in der CI gebaut, aber nicht aufbewahrt; die
Zuordnung über die PDB-Module wie am 12.09. ist für 0.2.7 nicht möglich. Der
Rich-Header zählt, mit welchem Werkzeug und welcher Build-Nummer die gelinkten
Objekte entstanden sind. Verglichen mit einem lokalen Vergleichsbau vom 03.11.
(Visual Studio 2022, MSVC 14.44.35207):

| Werkzeug | Release 0.2.7 | lokal, MSVC 14.44 |
| --- | ---: | ---: |
| MASM | 9 × Build 35721 | 9 × Build 35207 |
| C | 13 × Build 35721 | 13 × Build 35207 |
| C++ | 46 × Build 35721 | 47 × Build 35207 |
| C (eigener Compiler-Build, ring) | 12 × Build 36260 | 12 × Build 35229 |
| Cvtres, Linker | je 1 × Build 36260 | je 1 × Build 35229 |

Die Gruppe aus MASM-, C- und C++-Objekten zeigt die vorgebauten
Laufzeitobjekte:
- **Lokaler Bau:** 69 Objekte mit der Build-Nummer des Toolset-Ordners
  14.44.35207. Am 12.09. ordnete die PDB eines 14.44-Baus ebenso 69 Module zu,
  46 aus `libcmt.lib` und 23 aus `libvcruntime.lib`.
- **Release-Bau:** 68 Objekte mit Build 35721. Das passt zu keinem der beiden
  anderen Toolsets auf dem Image (14.44 hätte 35207, 14.29 eine 30xxx-Nummer)
  und liegt unter dem Compiler-Build 36260. Das sind die `libcmt.lib` und
  `libvcruntime.lib` von MSVC 14.51.

Die zwölf C-Objekte mit dem Build des Compilers stammen von ring, das als
einzige Abhängigkeit C-Code in die EXE bringt; Cvtres ist die App-Ressource.

**Grenzen:**
- Der Rich-Header belegt Werkzeuge und Anzahlen, keine Bibliotheksnamen.
- Der Unterschied von einem Objekt (68 gegenüber 69) ist nicht geklärt.
- Die sechs WebView2-Loader-Objekte vom 12.09. erscheinen in keiner MSVC-Zeile;
  vermutlich sind sie nicht mit MSVC gebaut, geprüft ist das nicht.

**WebView2.** Die EXE enthält weiter
`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`, den
Standard von wry 0.57.1. Die Einordnung zu §9(a) vom 12.09. gilt weiter.

## Bedingungen von Visual Studio 2026

Alle Quellen wurden am 05.11. abgerufen; Links, Hashes und Wortlaut stehen im JSON.

- **Nutzung in der CI:** Der Runner bringt Visual Studio Enterprise 2026 mit.
  Laut den Betreuern der Runner-Images ist der Lizenzschlüssel mit Microsoft
  für öffentliche und private Nutzung auf gehosteten Runnern vereinbart; Nutzer
  brauchen keine eigene Lizenz
  ([Kommentar vom 29.09.2025](https://github.com/actions/runner-images/issues/12945#issuecomment-3348002951)).
- **Weitergabe:** Die
  [Lizenzbedingungen von VS 2026](https://visualstudio.microsoft.com/license-terms/vs2026-ga-pro-enterprise/)
  erlauben, den Objektcode der
  [Distributable-Liste](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution)
  weiterzugeben.
  - Die Liste nennt für C++ nur Merge Modules und `VC\redist`.
  - Microsofts
    [Lizenzierungsleitfaden](https://www.microsoft.com/licensing/guidance/Visual-Studio)
    erklärt: LIB-Dateien dürfen nicht selbst weitergegeben werden, die gelinkte
    Ausgabe schon.
  - Die [C++-Dokumentation](https://learn.microsoft.com/en-us/cpp/c-runtime-library/crt-library-features?view=msvc-170)
    nennt nur die Debug-Varianten (`libcmtd.lib`, `libvcruntimed.lib`) nicht
    weitergebbar.
- **Kein Pflichthinweis:** Die Bedingungen verlangen keinen Microsoft-Hinweis,
  und die Third-Party-Notices von VS 2026 enthalten keinen Eintrag zur
  C-Laufzeit. aidevbridge behält seinen eigenen Herkunftshinweis freiwillig.
- **Toolset freigegeben:** MSVC 14.51 ist seit Visual Studio 18.6 der
  freigegebene Standard, keine Vorabversion. Das Verbot, „Unreleased
  Components“ weiterzugeben, trifft nicht zu.

Der [Laufzeithinweis](licenses/microsoft-windows-runtime-NOTICE.txt) sprach von
„MSVC 14.44 toolset“. Weil das Label `windows-2025` mitwandert und das Toolset
wechselt, heißt es dort jetzt „Microsoft C++ (MSVC) Build Tools“. Die genaue
Version steht in diesem Beleg und in der Komponente
`native:msvc-windows-runtime`.

## Was offen bleibt

- **CI-Nutzung:** Sie stützt sich auf GitHubs öffentliche Aussage, nicht auf
  ein veröffentlichtes Lizenzdokument. Die Klausel „Build Devices“ nennt
  gehostete Rechner Dritter nicht ausdrücklich.
- **Gelinkte LIB-Ausgabe:** Dass sie weitergegeben werden darf, steht im
  Leitfaden und in der C++-Dokumentation, nicht in der Distributable-Liste;
  das gilt so für jedes mit MSVC gebaute Programm.
- **Schützende Bedingungen:** Die Bedingung, die verteilten Code schützende
  Bedingungen verlangt, erfüllt praktisch nur der Hinweis; das ZIP hat keinen
  Zustimmungsschritt.
- **PDB:** Ab diesem Stand bewahrt `packages.yml` die PDB des Windows-Baus
  90 Tage als Workflow-Artefakt `windows-symbols` auf, nicht als Release-Asset.
  So lässt sich ein späterer Werkzeugwechsel Modul für Modul prüfen.
- **Installer-Punkte:** Die übrigen Punkte des Manifests (`nsis_msi_payload`,
  `installer_terms_ui`, `installer_stub_notices`,
  `product_and_windows_acceptance`) bleiben offen.
