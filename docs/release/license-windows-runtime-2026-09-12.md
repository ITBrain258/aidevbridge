# Windows-Runtime und Installer-Lieferumfang

Stand: 2026-09-12. **Die technische Zuordnung und Textauswahl sind abgeschlossen.**
Für die untersuchte EXE sind weder ein zusätzliches Visual-C++-Redistributable
noch eine WebView2Loader-DLL zu liefern. Für NSIS und MSI bleibt
`downloadBootstrapper` die gewählte WebView2-Variante. Der tatsächliche
Installer-/ZIP-Inhalt und die konkrete Vermittlung der Microsoft-Bedingungen
sind noch nicht abgenommen. Der [JSON-Beleg](license-windows-runtime-2026-09-12.json)
enthält Eingänge, Originalquellen, Hashes und ausgeführte Leseprogramme.

## Was in der bestehenden EXE steckt

Untersucht wurde ausschließlich die vorhandene native EXE des Produktstands
**6a45c12**, 16.016.896 Bytes, SHA-256
**8aa177e304e0b8c067159ac7912d7894b770bc05021a47bd9b0de593cd8255e9**.
Das neuere Frontend-Bundle mit Stamp bfa8de5 gehört weiterhin zu keinem neuen
nativen Build. Cargo, Tauri, Installer und Runtime wurden hier nicht gestartet.

Die normale Importtabelle enthält **22 Windows-/UCRT-DLL-Namen**. Die
Delay-Import-Tabelle ist leer: RVA und Größe jeweils null. Es gibt keinen
normalen oder verzögerten Import von VCRUNTIME140, MSVCP140 oder
WebView2Loader.dll. Die sieben `api-ms-win-crt-*`-Imports sind Math, String,
Convert, Runtime, Stdio, Locale und Heap; die übrigen 15 sind Windows-APIs.
Die vollständigen Namen stehen im JSON. `dumpbin /dependents` und `/headers`
sowie ein direktes PE-Leseprogramm stimmen überein.

CodeView-GUID und Age der EXE stimmen mit der tatsächlich gelesenen PDB
überein: GUID-Bytes **9f9643b8d47a284ebd910f348e046951**, Age **1**.
Die PDB hat SHA-256
**8f6451daf43b1f32c8bf9e8d661060656db211a185df61eda6ac92e13768c48c**.
Ihr DBI-Modulverzeichnis enthält 755 Module. Die gezielt ausgewählten
98 nativen Modul-/Importeinträge ordnen sich wie folgt zu:

| Familie | PDB-Einträge | Folgerung für die Lieferung |
| --- | ---: | --- |
| MSVC 14.44.35207 `libcmt.lib` | 46 | Startup-/CRT-Unterstützung ist in die EXE gelinkt. Kein separates LIB-Paket. |
| MSVC 14.44.35207 `libvcruntime.lib` | 23 | Statische Exception-/Compiler-Runtime-Unterstützung, keine VCRUNTIME-DLL-Abhängigkeit in den beiden Importtabellen. |
| Windows SDK 10.0.26100.0 `ucrt.lib` | 14 | Sieben DLL- und sieben Importmodule; die finale EXE importiert die sieben UCRT-API-Sets dynamisch. Keine Behauptung einer vollständig statischen C-Runtime. |
| WebView2-Crate-RLIB | 6 | Konkrete `WebView2LoaderLib/*.obj`-Module, darunter loader_impl, loader_override und environment_helper. Die vorhandenen SDK-Lizenztexte bleiben erforderlich. |
| windows_x86_64_msvc 0.53.1 Importbibliothek | 7 | Import-Stubs aus der bereits inventarisierten Rust-Abhängigkeit. |
| SDK `ntdll.lib` / eigene `resource.lib` | 1 / 1 | Windows-Importunterstützung beziehungsweise eigene App-Ressource. |

Die heutigen Hashes aller sieben Archive sind aufgezeichnet. Sie ersetzen
keine historische Hashliste jedes damaligen Linkereingangs. PDB-Module belegen
zugeordnete Objekte, nicht das Überleben jedes ihrer Bytes nach Linkeroptimierung.
PDB-Importmodule werden ausdrücklich nicht als finale DLL-Liste ausgegeben:
etwa userenv/aclui erscheinen darin, obwohl die finale Importtabelle sie nicht
enthält. Dynamisches `LoadLibrary` und Abhängigkeiten des separat laufenden
WebView2-Prozesses sind mit den beiden PE-Tabellen nicht vollständig erfasst.

## MSVC und Windows: eng begrenzte Auswahl

Lokal liegt **Visual Studio 2022 Build Tools**, MSVC-Verzeichnis
**14.44.35207**. Das vorhandene link.exe trägt Dateiversion **14.44.35228.0**;
die EXE nennt Linker **14.44**. `vswhere -all` liefert derzeit eine leere Liste,
obwohl die konkreten Build-Tools-Dateien vorhanden sind. Daraus folgt weder
ein Nutzungsrecht noch ein Lizenzverstoß.

Die aktuellen [Build-Tools-Bedingungen, März 2024](https://visualstudio.microsoft.com/license-terms/vs2022-ga-diagnosticbuildtools/)
regeln die Nutzung mit Visual-Studio-Produkten und zusätzlich das Bauen
benötigter Drittanbieter-C++-Open-Source-Abhängigkeiten. Die
[Community-2022-Bedingungen](https://visualstudio.microsoft.com/license-terms/vs2022-ga-community/)
nennen Individualnutzung und organisatorische Entwicklung unter OSI-Lizenzen.
Diese Klauseln sind keine Gleichsetzung von beliebiger Build-Tools-Nutzung
mit Community-Lizenzierung. Der Nutzer hat die bestehende Toolchain und das
Open-Source-Ziel autorisiert; dieses Paket erfindet ohne gegenteiligen Befund
keine zusätzliche Kaufbeleg-, Account- oder Lizenzannahme-Abnahme.

Microsofts [Lizenzierungsleitfaden](https://www.microsoft.com/licensing/guidance/Visual-Studio)
unterscheidet verteilbaren gelinkten LIB-Output von einer direkten Weitergabe
der LIB-Dateien. Die [Redistributable-Liste für VS 2022](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution)
und die [Weitergabedokumentation](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170)
regeln separat die Runtime-Pakete, Merge Modules und einzelnen DLLs. Solche
zusätzlichen Dateien sind für diesen EXE-Befund nicht ausgewählt. Die
Endnutzer-[Visual-C++-Runtime-EULA](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/)
wird nicht als Weitergabegenehmigung ausgegeben: Sie enthält selbst keine
solche Erlaubnis. Eine pauschale Kopie aller 7 MB Visual-Studio-Dritthinweise
würde überwiegend Werkzeuge und andere Produktteile beschreiben und ist
für die belegten Startup-/VCRuntime-Objekte nicht begründet.

Die [Microsoft-UCRT-Dokumentation](https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment?view=msvc-170)
ordnet die UCRT unter Windows 10 und neuer dem Betriebssystem zu. Für den
Windows-10/11-Lieferweg werden daher keine DLLs aus System32, kein Downlevel-
UCRT-Installer und kein `vc_redist.x64.exe` beigefügt. Das ist eine Auswahl
für diesen Lieferweg; die Mindest-Windows-Version und der Start auf einem
Rechner ohne Entwicklungswerkzeuge müssen am frischen Release geprüft werden.
Andere Cargo-Ausgaben wie agentbridge_lib.dll/.lib sind ebenfalls nicht
automatisch portable Release-Dateien.

## WebView2: vorhandener Vertrag und konkrete Folgen

Das installierte CLI-Schema **2.11.4** setzt ohne Override
`{ "type": "downloadBootstrapper", "silent": true }`.
Die unveränderte tauri.conf.json enthält keinen Override. Der offizielle
Tag tauri-cli-v2.11.4 verweist auf Commit
**8909f221d1515955fc843808032bdc5d62209c96**. Die dortigen
[NSIS-](https://github.com/tauri-apps/tauri/blob/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
und [MSI-Templates](https://github.com/tauri-apps/tauri/blob/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/windows/msi/main.wxs)
prüfen die Runtime-Registrierung. Bei fehlender Runtime laden sie während der
Installation Microsofts Bootstrapper über LinkId=2124703 in den Tempordner
und starten ihn mit `/silent /install`. Der Download-Modus bettet weder den
Bootstrapper noch eine komplette Runtime in den zu verteilenden Installer ein.
Das ist der Quellenvertrag; die tatsächlichen Installer wurden nicht gebaut.

Die Auswahl bleibt **downloadBootstrapper für beide Installer**. Für ZIP bleibt
eine bereits installierte Evergreen-Runtime Voraussetzung. Ein zusätzlicher
Fixed-/Offline-Payload oder eine Änderung der bisherigen Browserargumente ist
durch diesen Befund nicht begründet. Die separat bereits ausgewählten
[SDK-Texte](license-webview2-sdk-2026-09-12.md) betreffen den gelinkten Loader;
sie lizenzieren nicht automatisch die Evergreen-Runtime. Die Runtime-Version
ist unabhängig von der SDK-Version **1.0.3650.58** und wird durch Evergreen
fortlaufend von Microsoft aktualisiert.

Die Primärquelle für die Bedingungen ist der heutige
[Microsoft-Entwicklerdialog](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
Sein tatsächlich geladenes Modul CLddbZSB.js weist sowohl „Get the Link“ als
auch den Evergreen-Bootstrapper-Download demselben
[Evergreen-EULA-Endpunkt](https://developer.microsoft.com/microsoft-edge/api/eula/webview2)
zu. Der JSON-Beleg sichert Modul-URL, Antwort-URL, Abrufzeit und SHA-256.
Die Antwort ist **en-us**, enthält `evergreenHtml` und keine Dokumentrevision.
Die Referenz ist daher der Abruf vom 12.09.2026, keine erfundene Versionsnummer.
Der getrennte Consumer-Endpunkt wurde zum Vergleich gelesen; dessen Text
enthält keine Distributable-Code-Sektion und ersetzt die Entwicklerbedingungen
nicht. Fixed-Version- und Preview-Bedingungen werden nicht ausgewählt.

Für den Lieferweg relevant sind insbesondere §2(b) zu schützenden Bedingungen
und Microsoft als Bezugsquelle sowie §3 zu Daten. Die Bedingung von §9(a)
zum SmartScreen-Hinweis muss am konkreten App-Verhalten geprüft werden.
Der Volltext bewahrt auch Haftungs-, Regional-, Update-, Codec- und
Open-Source-Ausnahmen. AgentBridge stellt seine eigenen Open-Source-Bedingungen nicht als
Neulizenzierung dieser Microsoft-Komponenten dar.

**Ein enger Quellenwiderspruch bleibt sichtbar:** §2(c)(iii) lautet
„provide any Microsoft download sites or shortcuts that provides access to
this software to a third party.“ Dem steht Microsofts aktuelle
[Anleitung für Online-Deployment](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#online-only-deployment)
gegenüber, die genau das programmatische Herunterladen über „Get the Link“
vorsieht. Derselbe Entwicklerdialog stellt diesen Link bereit. Das ist kein
SDK-/Runtime-Verwechslungsbefund. Die historische
[Microsoft-Antwort vom 13.03.2021](https://github.com/MicrosoftEdge/WebView2Feedback/issues/907#issuecomment-797836825)
entfernte ein anderes Produktionsverbot und löst diesen Absatz nicht auf.
Der Bericht behauptet weder eine rechtliche Auflösung noch leitet er daraus
einen Produktfehler oder einen pauschalen Veröffentlichungsstopp ab. Die
konkrete Distributionsentscheidung muss diesen eng benannten Widerspruch
berücksichtigen; ein Wechsel zu anderen Runtime-Paketen wäre keine belegte
Lösung dafür.

## Vorbereitete Beigaben und verbleibende Abnahme

| Datei | Bytes | SHA-256 |
| --- | ---: | --- |
| [Evergreen-Bedingungen](licenses/microsoft-webview2-evergreen-2026-09-12-LICENSE.txt) | 16.720 | `7d13f1952f688824aa83d198dddaa45ed8a3721709d5a774a347853afbb893c0` |
| [Windows-Runtime-Hinweis](licenses/microsoft-windows-runtime-NOTICE.txt) | 1.379 | `8dd7e7f047a16d3ae1c68ac67e212d59b407d8a36773026d031df3a78a4d0b02` |

Der erste Text ist eine **vollständige Textübertragung**, keine bytegleiche
HTML-Datei: Markup wird entfernt, `&nbsp;` dekodiert und Darstellungsleerraum
innerhalb von Absätzen vereinheitlicht. Alle Zeichen des dekodierten Textes
außer Darstellungsleerraum stimmen in ihrer Reihenfolge überein; Absatznummern
bleiben erhalten. Das unveränderte ursprüngliche HTML steht verlustfrei im JSON
mit eigenem Hash. Bestehende Originaltexte und Dateiattribute wurden nicht
verändert. Die Microsoft-DOCX-Quellen dienen ausschließlich der gelesenen
Klauselzuordnung; ihre XML-Absatzextraktion ist keine Liefertranskription.

Der zweite Text ist ein ausdrücklich von AgentBridge formulierter Herkunfts-
und Datenschutzhinweis. Er nennt WebView2, automatische Updates und mögliche
Datenerfassung mit dem Microsoft-Privacy-Link. Er ersetzt keine erforderliche
Zustimmung zu Bedingungen.

**Der zunächst aus der allgemeinen API-Dokumentation abgeleitete zusätzliche
SmartScreen-Hinweis ist für diesen App-Stand nicht erforderlich.** Wry 0.55.1
setzt in `create_environment` standardmäßig
`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`.
Die beiden relevanten installierten Wry-Dateien stimmen bytegleich mit dem
frisch geladenen offiziellen, gegen Cargo.lock gehashten Crate-Archiv überein.
Tauri-runtime-wry setzt andere Browserargumente nur bei `Some(...)`;
AgentBridges Quellcode und Konfiguration setzen keinen solchen Override.
Die vorhandene EXE enthält dieselbe Argumentfolge bei Byteoffset 11.743.832.
Damit ist der konfigurierte Standardpfad zur Deaktivierung belegt, nicht die
Live-Wirksamkeit unter jeder zukünftigen Runtime und externen Richtlinie.
Das allgemeine WebView2-API-Default true wurde deshalb nicht ungeprüft auf
AgentBridge übertragen. Für den unveränderten Pfad wird keine neue
SmartScreen-Zustimmung oder Sicherheitskonfigurationsänderung verlangt.
Bei geänderten Browserargumenten ist diese konkrete §9(a)-Zuordnung erneut
zu prüfen; eine pauschale Aussage „keine Microsoft-Telemetrie“ folgt daraus nicht.

Die kleinste nächste Umsetzung ist die Einbindung dieser Texte in den
gemeinsamen Lizenzordner und eine verständliche Runtime-Information
im vorhandenen Installations-/Lieferweg. Falls schützende Bedingungen vom
Endnutzer vereinbart werden müssen, muss der tatsächliche Ablauf dies leisten;
ein unsichtbar mitkopierter Text oder `/silent` beweist keine Zustimmung.
Ein vorhandener `bundle.licenseFile`-Mechanismus kann dafür geprüft werden,
ohne vorab eigene Installer-Templates oder zusätzliche App-Funktionen einzuführen.
Die konkreten Bedingungen dürfen dabei die Open-Source-Rechte an AgentBridge
und separat lizenzierten Komponenten nicht einschränken.

Danach bleiben die bereits vereinbarten Payload-/Zweitrechner-Prüfungen:
NSIS und MSI tatsächlich auslesen/installieren, ZIP entpacken, gleiche Texte
mit Hashes nachweisen, Runtime-vorhanden/-fehlend und Update/Deinstallation
prüfen. Auch die erst durch NSIS/WiX hinzugefügten Installer-Stubs/-Plugins
sind am tatsächlichen Paket zuzuordnen. Der finale native Build benötigt
einen erneuten Import-/Familienabgleich, keine weitere Gesamtauditrunde.

Dieser Schritt änderte nur diesen Bericht, seinen JSON-Beleg und die zwei
genannten Textdateien. Keine Lizenz wurde angenommen, kein Runtime-Binary
heruntergeladen oder ausgeführt, keine Installation, VM-Aktion oder externe
Nachricht durchgeführt und kein Commit erstellt. Lesend abgerufene
Originale und Programme bleiben im eigenen, im JSON genannten Tempordner
für den unabhängigen Review erhalten; es läuft kein eigener Prozess weiter.

Der unabhängige Review ist abgeschlossen und akzeptiert dieses Auswahlpaket
ohne notwendige Korrektur: 59 Datei-/Quellbindungen, eine eigene PE-/PDB-
Auswertung, zwölf frische Primärabrufe und das Wry-Originalarchiv bestätigen
die entscheidenden Aussagen. EULA-Textvollständigkeit und NOTICE sind geprüft.
Der Link-Widerspruch bleibt wie oben ausdrücklich benannt; tatsächliche
Payloadprüfung und Bedingungenvermittlung sind weiterhin Lieferaufgaben.
