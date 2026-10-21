# WebView2-SDK 1.0.3650.58: Loader- und Lizenzzuordnung

**Die bisher fehlende Zuordnung ist für diesen konkreten SDK-/x64-Loaderstand
belegt.** Das offizielle Microsoft-NuGet-Paket liefert einen vollständigen
Microsoft-Lizenztext mit Bedingungen für Source-/Binary-Weitergabe sowie eine
separate NOTICE-Datei. Die drei x64-Loaderdateien stimmen bytegenau mit den
installierten Crate-Dateien und dem vorhandenen Release-Buildoutput überein.
Die Texte sind jetzt als unveränderte Dateien gesichert. Ihre tatsächliche
Beigabe zu einem Release bleibt ein eigener M3-Schritt.

Dies ist ausschließlich die Ergänzung des offenen SDK-Falls aus dem
[historischen Inventar](license-inventory-2026-09-12.md). Weder dieses Inventar
noch dessen Generatoren, Produkt-/Lockdateien, Tauri-Konfiguration oder die
zentrale Frontend-Lizenzdatei wurden dabei verändert.

## Offizielles Paket und Texte

Die [versionsgenaue NuGet-Seite](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3650.58)
nennt Microsoft als Owner. Das Paket wurde am 12.09.2026 um 09:17:09.654 UTC
über den offiziellen HTTPS-Endpunkt
[Microsoft.Web.WebView2 1.0.3650.58](https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3650.58/microsoft.web.webview2.1.0.3650.58.nupkg)
geladen: HTTP 200, keine Weiterleitung, 8.965.153 Bytes, SHA-256
`911a472128c82ac8baa0c486c23342cc9dd6e7dc50d754e676726642ca065c60`.
Die NuGet-Paketsignatur wurde nicht zusätzlich unabhängig geprüft.

`Microsoft.Web.WebView2.nuspec` enthält ID/Version/Autor passend zu diesem Paket
und bindet die Lizenz ausdrücklich als Datei `LICENSE.txt` ein. Es deklariert
keinen SPDX-Ausdruck. Die vollständigen Nuspec-Bytes sind im
[JSON-Beleg](license-webview2-sdk-2026-09-12.json) verlustfrei als UTF-8-Text
enthalten; ihr SHA-256 ist
`7cef90215900c89711502ae3aae1fc31bca3c3c736be2264d2d3cfa8b537aaf2`.

| Gesicherter Originaltext | Bytes | SHA-256 |
|---|---:|---|
| [Microsoft-SDK LICENSE.txt](licenses/microsoft-web-webview2-1.0.3650.58-LICENSE.txt) | 1.487 | `0af8f1b807512aae39c2ac1aa4d0cae65cabecb6fd554b8439a5162a0d6eca55` |
| [SDK NOTICE.txt](licenses/microsoft-web-webview2-1.0.3650.58-NOTICE.txt) | 3.894 | `106423785c5b7eba0a8e61d1837f2132e9c828e20ad530f565d981c1df60dd90` |

Der Microsoft-Text hat die Struktur einer dreigliedrigen BSD-Lizenz. Er erlaubt
Source- und Binary-Weitergabe unter den genannten Bedingungen; bei Binaries
müssen Copyright, Bedingungen und Haftungsausschluss in den begleitenden
Materialien erhalten bleiben. Namensnutzung zur Bewerbung wird eingeschränkt.
Dies ist eine enge Beschreibung des konkreten Textes, keine aus dem Crate-MIT-Feld
abgeleitete Lizenzzuordnung. Der Text ist auch auf der
[versionsgenauen NuGet-Lizenzseite](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3650.58/License)
abrufbar; der frühere fehlgeschlagene Webabruf im Inventar ist damit für diesen
Nachtrag aufgelöst.

Die unveränderte SDK-NOTICE enthält Paket-Dritthinweise zu Antlr3.Runtime
3.5.2-rc1 und StringTemplate4 4.0.9-rc1. Ihre Sicherung behauptet nicht, diese
beiden Komponenten seien als Code im x64-Loader nachgewiesen. Der Text wird
als begleitende Information des vollständigen SDK-Pakets erhalten. Auf einen
separat installierten oder künftig verteilten WebView2-Runtime/Bootstrapper
werden diese SDK-Bedingungen nicht automatisch übertragen.

## Tatsächliche Loaderbytes und Upstreampin

Verglichen wurden jeweils drei Fassungen: Eintrag im offiziellen NuGet-Paket,
installierte Datei unter
`C:/Users/U/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/webview2-com-sys-0.38.2/x64/`
und vorhandene Kopie unter
`target/release/build/webview2-com-sys-8cc9f05c85db159e/out/x64/`.
Alle drei Fassungen haben jeweils dieselbe Länge und SHA-256:

| NuGet-Archivpfad | Bytes | SHA-256 aller drei Fassungen |
|---|---:|---|
| `build/native/x64/WebView2LoaderStatic.lib` | 10.500.016 | `0659b741bde6348d4c4a6ec4ceb9af50e3d0048ed9cd3c8659bccbb61fde55ee` |
| `build/native/x64/WebView2Loader.dll` | 160.320 | `8427b1fc58ec707813e5c0a51eb5d69397bb333250a7b891be4d3b123f1e0f1c` |
| `build/native/x64/WebView2Loader.dll.lib` | 2.916 | `bfc8ccaaa056be95243a5b66a827e5849d2bb39676fca4dcc2053796d8e15c6d` |

Die lokale `.cargo_vcs_info.json` nennt weiterhin
`b74dc5e2b394044bea5191052868ce7a106c202c`, Unterpfad `crates/bindings`.
Der [Generator an diesem Commit](https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/crates/update-bindings/src/main.rs)
setzt SDK 1.0.3650.58 und kopiert die Loader aus dem zugehörigen NuGet-Paket.
Die heruntergeladene Generatordatei hat SHA-256
`ac57a332152787eceee71905fdbf23df37857da2b8446e2336ce375eb59310fd`.

Das [gepinnte Buildskript](https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/crates/bindings/build.rs)
ist bytegleich zur installierten Fassung, SHA-256
`ea73d2566f434a25e8172d0fb9eaad5fa29ee687a8f05b9c2be02b19e4366e16`.
Die [gepinnte lib.rs](https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/crates/bindings/src/lib.rs)
bindet für MSVC `WebView2LoaderStatic` statisch. Sie ist im Download 1.812 Bytes
groß, SHA-256 `b0f575a4f8c711f35972254de4a3b1732d500f301a6af10f727131ece97a5786`.
Die lokale Fassung ist wegen 66 CRLF-Zeilenenden 1.878 Bytes groß, SHA-256
`bd953534fa9b15d39ac69c9afa82762adaaa81621a0adb687ba385327ee6689a`.
Nach ausschließlich CRLF-zu-LF-Normalisierung stimmen die Texte vollständig
überein. Der erste strikte Quellbytevergleich endete deshalb korrekt mit Exit 1;
dieser Unterschied wurde nicht als Bytegleichheit umgedeutet und betrifft
keinen der drei Loadervergleiche.

Diese Belege ordnen die vorhandenen Crate-/Builddateien zu. Es wurde keine neue
EXE erzeugt und kein Installer oder vollständiger EXE-Linkerbeitrag untersucht.
Die getrennte MIT-Lizenz der Rust-Bindings bleibt ebenfalls ein eigenständiger
Teil des Lizenzinventars.

## Export, Bereinigung und nächste Arbeit

Vor jeder Extraktion wurden alle 135 ZIP-Einträge geprüft: keine absoluten
Pfade, Traversal-/Doppelnamen oder Linktypen, zusammen 46.165.738 unkomprimierte
Bytes. Extrahiert wurden nur LICENSE, NOTICE und Nuspec unter festen flachen
Dateinamen im neu erzeugten eigenen Tempordner. Loader wurden direkt aus dem
Archiv gehasht, keine heruntergeladene Binärdatei ausgeführt.

Der eigene Ordner war
`C:/Users/U/AppData/Local/Temp/ab-m3-webview2-4343bdf13f704270856105f5a07a2576`,
Owner `test-pc\U`. Ein kombinierter Prüf-/Cleanupaufruf wurde vor Ausführung
automatisch mit `blocked by policy` abgewiesen. Anschließend wurden Pfadgrenze,
Owner, eigener Marker und die vollständige Allowlist der zwölf Dateien separat
lesend geprüft. Genau diese literal benannten Dateien und danach der geprüfte
leere Ordner wurden ohne rekursive Löschung entfernt. Seine Abwesenheit wurde
am 12.09.2026 um 09:22:27.330146 UTC bestätigt. Es bleiben keine eigenen Downloads
oder laufenden Prozesse zurück.

Die exportierten Texte wurden byteweise gegen ihre Archiv-Hashes geprüft.
**LICENSE.txt bleibt absichtlich originalgetreu:** LF-Zeilenenden, ein
abschließendes Leerzeichen in Zeile 13 und kein finales LF. Diese Merkmale nicht
stillschweigend normalisieren; sonst ändern sich die nachgewiesenen Bytes.
NOTICE und die eigenen JSON-/Markdown-Dateien verwenden LF.
Die Dateiattribute nehmen ausschließlich den Original-LICENSE-Pfad von der
Prüfung auf Leerraum am Zeilenende aus; übrige Dateien behalten ihre bisherigen
Whitespace-Regeln. Die verifizierten Lizenzbytes werden dadurch nicht geändert.

Der unabhängige Root-Review hat den Bericht und die Zuordnungsgrenzen gelesen,
die offizielle versionsgenaue NuGet-/Lizenzseite geprüft und die drei lokalen
Crate-/Buildloaderpaare erneut gegen die aufgezeichneten NuGet-Hashes abgeglichen.
Beide exportierten Textdateien und die vollständige rückkodierte Nuspec stimmen
mit ihren Archivhashes; der eigene Downloadordner ist auch bei Roots Kontrolle
abwesend. Kein notwendiger Korrekturbefund innerhalb dieses SDK-Teilnachweises.

Der [JSON-Beleg](license-webview2-sdk-2026-09-12.json), einschließlich
Archivverzeichnis, Nuspec, Versions-/Hashabgleichen und Cleanup, hat SHA-256
`7b77925cd34c32974a4be7c1512a65f804ceedb8559d6bf99a7267504d9ad66a`.
Nächster begrenzter Schritt ist die Zuordnung dieser beiden gesicherten Texte
zum endgültigen Release-Notice-Paket und der Nachweis ihrer Beigabe zum
konkreten Installer/portablen Release. Die übrigen fehlenden Crate-Texte und
eine abschließende Lizenzkonformitätsbewertung sind nicht Teil dieses Schritts.
