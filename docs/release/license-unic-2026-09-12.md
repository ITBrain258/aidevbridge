# UNIC 0.9.0: MIT-Texte und Unicode-Datenzuordnung

Für die fünf unten genannten Crates wird das belegte Wahlrecht zugunsten der
MIT-Lizenz ausgeübt. Die fehlenden vollständigen UNIC-Texte sind damit
versionsgenau vorbereitet. Die tatsächlich aktivierten Identifier-Tabellen
haben zusätzlich eine belegte Unicode-Datenherkunft; dafür ist die heute
veröffentlichte Unicode License v3 separat gesichert. Dieser Schritt enthält
keine abschließende Rechtsfreigabe und keine fertige Release-Beigabe.

| Crate, jeweils 0.9.0 | VCS-Pin im veröffentlichten Paket | Upstream-Unterverzeichnis | Windows-Features laut gesichertem Inventar |
| --- | --- | --- | --- |
| unic-char-property | `5878605364af97a3358368a6eaef02104af2e016` | `unic/char/property` | keine |
| unic-char-range | `5878605364af97a3358368a6eaef02104af2e016` | `unic/char/range` | `default` |
| unic-common | `5878605364af97a3358368a6eaef02104af2e016` | `unic/common` | `default` |
| unic-ucd-version | `5878605364af97a3358368a6eaef02104af2e016` | `unic/ucd/version` | keine |
| unic-ucd-ident | `8a6ce83063d90b91ae2ce59eddb803edd393fca9` | `unic/ucd/ident` | `default`, `id`, `xid` |

Die Einordnung als normale Laufzeitkandidaten stammt aus dem unveränderten
[Rust-Inventar](license-inventory-2026-09-12-rust.json) für
`x86_64-pc-windows-msvc`, `tauri/custom-protocol`, aktivierte Default-Features
und ohne Dev-Abhängigkeiten im Releasebaum. Sie belegt keine einzelnen Bytes
in einer finalen EXE. Das Inventar wurde nicht neu erzeugt.

Die fünf vorhandenen `.crate`-Archive stimmen mit ihren Checksummen im aktuellen
Root-`Cargo.lock` überein. Alle 60 regulären Archiveinträge wurden im Speicher
gelesen und bytegenau gegen die installierten Paketdateien verglichen. Die
`.cargo_vcs_info.json`-Dateien enthalten die oben genannten Pins, jedoch kein
`path_in_vcs`; die Unterverzeichnisse werden durch die tatsächlich passenden
gepinnten Originalmanifeste belegt. Insgesamt sind 19 direkte Bytevergleiche zu
den Pins dokumentiert: die zehn Manifest-/`lib.rs`-Paare aus der Vorprüfung
sowie neun relevante Source-/Tabellendateien. Kein Paket wurde ausgeführt.

Die Code-Lizenzwahl folgt den Originalmanifests (`MIT/Apache-2.0`), den
Quellheadern mit ausdrücklich freier Wahl und der gepinnten
[COPYRIGHT-Datei](https://raw.githubusercontent.com/open-i18n/rust-unic/8a6ce83063d90b91ae2ce59eddb803edd393fca9/COPYRIGHT.md).
Die MIT- und COPYRIGHT-Originalbytes sind an beiden Pins identisch. Apache wird
für diese Code-Zuordnung nicht zusätzlich ausgewählt oder als weitere
kumulative Pflicht dargestellt; sein vollständiger Text wird hier nicht
nochmals exportiert.

| Gesicherter Text | Bytes | SHA-256 |
| --- | ---: | --- |
| [UNIC LICENSE-MIT](licenses/unic-0.9.0-LICENSE-MIT.txt) | 1.023 | `23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3` |
| [UNIC COPYRIGHT](licenses/unic-0.9.0-COPYRIGHT.md) | 608 | `f5c342c49f3ac804f3e8e7bb62a8040a44c50d47bb36902b1abd13f66a1adf8b` |
| [Quellhinweise](licenses/unic-0.9.0-SOURCE-NOTICES.txt) | 4.916 | `cb02092fe3463f16bcd1537f89312df885f5ba384ac906243546fa263a5c4742` |
| [Unicode License v3, Abruf 2026-09-12](licenses/unicode-data-LICENSE-V3-2026-09-12.txt) | 1.995 | `e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96` |

Die MIT-Datei selbst enthält keine Copyrightzeile. Deshalb bleibt das originale
COPYRIGHT mit den dort genannten Rust-, rust-url-, Servo- und UNIC-Autoren
erhalten. Die zusätzliche, ausdrücklich als AgentBridge-Zusammenstellung
gekennzeichnete Quellhinweisdatei übernimmt die tatsächlichen Header und ordnet
sie allen 26 `src/*.rs`-Dateien dieser Familie zu. Dazu gehören die
UNIC-Zeilen mit 2017 und 2017–2019. Die separate 2018-Zeile gehört zum optionalen
`unic-char-range/src/par_iter.rs`; dessen `rayon`-Feature ist im aufgezeichneten
Releasekontext nicht aktiviert. Diese Zeile wird als Quellenprovenienz erhalten,
ohne ihre Übernahme in die EXE zu behaupten. Es wurden keine Copyrightjahre
zusammengezogen oder ergänzt. Alle vier Textbeigaben haben LF und einen
Schluss-LF; die drei Originaltexte wurden nicht normalisiert.

Der begrenzte Datencheck schließt die bisher offene Herkunft der vier aktiven
Identifier-Tabellen: Beide UNIC-Pins verweisen über `.gitmodules` und den
Gitlink `external/unicode/ucd` auf
`open-i18n/data-unicode-ucd@2a2044479b3c4915ef4213adf1dfd6236dba24c8`.
Der [gepinnt gelesene Generator](https://raw.githubusercontent.com/open-i18n/rust-unic/8a6ce83063d90b91ae2ce59eddb803edd393fca9/gen/src/writer/ucd/ident.rs)
nimmt `ID_Start`, `ID_Continue`, `XID_Start` und `XID_Continue` aus
`DerivedCoreProperties.txt`; der zugehörige Parser liest diese Datei aus genau
diesem Submodul. Die Unicode-Versionskonstanten in beiden betroffenen Crates
nennen 10.0.0.

Das Submodul bezeichnet sich selbst als inoffiziellen Unicode-Spiegel. Deshalb
wurde seine Herkunft nicht allein aus dem Repositorynamen abgeleitet:
`ReadMe.txt` und `DerivedCoreProperties.txt` stimmen bytegenau mit den Dateien
im [offiziellen Unicode-10.0.0-Verzeichnis](https://www.unicode.org/Public/10.0.0/ucd/ReadMe.txt)
überein. Die 960.758 Bytes der offiziellen
[DerivedCoreProperties-Datei](https://www.unicode.org/Public/10.0.0/ucd/DerivedCoreProperties.txt)
haben SHA-256 `e6ca152259189ec4bc2297e93c6c88f86e162cc52814198263497f3c9b46cbe9`.
Für beide Dateien wurde zusätzlich ihr Git-Blob gegen den gepinnten
Submodulbaum geprüft.

| Aktive Eigenschaft | Bereiche im Unicode-Eingang | Bereiche der lokalen Tabelle | Zeichen in beiden Mengen |
| --- | ---: | ---: | ---: |
| ID_Start | 657 | 585 | 125.334 |
| ID_Continue | 1.182 | 689 | 128.108 |
| XID_Start | 660 | 592 | 125.311 |
| XID_Continue | 1.186 | 696 | 128.089 |

Der Vergleich expandiert die vollständigen Bereiche beider Darstellungen in
je einen 1.114.112 Bytes langen Mitgliedschaftsvektor für U+0000 bis U+10FFFF.
Alle vier Vektoren sind bytegleich; auch nicht enthaltene Zeichen werden somit
verglichen. Unterschiedliche Bereichszahlen entstehen durch zusammengefasste
benachbarte Bereiche. Die vier lokalen Tabellendateien sind außerdem bytegleich
mit den Dateien im UNIC-Pin. Parser, Bereichszahlen und Vektorhashes sind im
JSON beschrieben. Die optionalen Pattern-Tabellen und Testdaten wurden nicht
gegen eigene Unicode-Eigenschaften ausgewertet. Die anderen drei Crates haben
kein Laufzeitverzeichnis `tables/`; generische Tabellenlogik und Dev-Fixtures
werden nicht als weitere UCD-Datenbestände ausgegeben.

Die zusätzliche Lizenzzuordnung stützt sich auf die heute gelesenen
[offiziellen Unicode-Bedingungen](https://www.unicode.org/copyright.html):
Abschnitt 2.b zählt die Daten unter `Public/` zu den Unicode-Datendateien;
Abschnitt 3.c ordnet ihnen Unicode License v3 zu, vorbehaltlich speziell
ausgewiesener Bedingungen. Die untersuchten 10.0.0-Dateiheader verweisen auf
Unicode-Nutzungsbedingungen und nennen keine abweichende Lizenz. Der
Submodul-README verweist ebenfalls auf Unicode. Deshalb wird für die belegten
Tabellendaten zusätzlich der unveränderte aktuelle
[Unicode-Lizenztext](https://www.unicode.org/license.txt) mit seiner tatsächlichen
Zeile `Copyright © 1991-2026 Unicode, Inc.` aufbewahrt. Die originalen
2017-Datenheader stehen daneben in der Quellhinweisdatei.

Das ist eine heutige Datenlizenzzuordnung, keine Behauptung, Unicode v3 habe
2017 oder 2019 bereits in diesen Paketen gelegen. Ein damaliger vollständiger
Lizenztext wurde nicht ermittelt; im gelesenen Submodul-Root und dessen
`data`-Verzeichnis liegt kein eigenständiger benannter Lizenztext. Die
Ursprungsdaten werden durch die UNIC-MIT-Wahl nicht pauschal umetikettiert.

Der [JSON-Beleg](license-unic-2026-09-12.json) enthält Eingangs- und Archivhashes,
alle 60 Dateivergleiche, VCS-Metadaten, die 19 Upstreamvergleiche, 41 HTTP-Belege
mit Abrufzeit und Hash, die Gitlink-Kette sowie die Datenvergleiche. Der bei
seiner Erzeugung beobachtete HEAD ist
`b670eef56e28c16537d29c05fcfb56948c4226ff`; Produkt-/Lock-/Konfigurationseingänge
wurden vor und nach dem Lauf gehasht und blieben gleich.

Der unabhängige Root-Gegencheck bestätigte die fünf Eingangsdateihashes,
alle 60 Archiveinträge gegen die installierten Dateien und sämtliche 26
Quellheader gegen ihre Zusammenstellung. Fünf frische HTTPS-Abrufe bestätigten
die originalen MIT-/COPYRIGHT-Texte beider Pins und den Unicode-v3-Text.
Die offizielle UCD-Datei wurde erneut geladen und ihre vier vollständigen
Mitgliedschaftsvektoren unabhängig gegen die lokalen Tabellen, Bereichszahlen,
Zeichenzahlen und Vektorhashes geprüft. Alle vier Exporthashes stimmen.
Die offiziellen aktuellen Unicode-Bedingungen wurden zusätzlich gelesen;
die oben beschriebene historische Grenze bleibt erhalten. Keine Tempdateien
oder Änderungen an den Originaltexten durch diesen Gegencheck.

Nächster Mitlieferungsschritt ist die Aufnahme von MIT, COPYRIGHT,
Quellhinweisen und der separaten Unicode-Datenlizenz in das tatsächlich
installierte beziehungsweise portable Releasepaket. Dabei bleiben der finale
Build-/Featurestand und die fertige Distribution zu prüfen. Keine anderen
Paketfamilien, Inventare, Produktdateien, Lockfiles oder Konfigurationen wurden
geändert. Es entstanden keine Tempdateien; kein Build, keine Installation,
VM-Aktion oder Commit wurde durchgeführt.
