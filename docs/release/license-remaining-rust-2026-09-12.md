# Letzte fünf Rust-Lizenztextlücken: versionsgenaue Zuordnung

Für `alloc-stdlib 0.2.4`, `pageant 0.2.1`, `delegate 0.13.5`,
`selectors 0.36.1` und `tauri-plugin 2.6.3` liegen jetzt die passenden
vollständigen Lizenztexte und die konkret gefundenen Quellhinweise vor.
Damit ist die ursprüngliche Liste von 15 Paketen ohne lokal benannten
Lizenzvolltext dokumentarisch zugeordnet. Die tatsächliche Release-Auswahl,
Auslieferung und gegebenenfalls zugehörige Quellzugangsangaben sind ein
separater, noch offener Schritt. Eine allgemeine Lizenzfreigabe folgt daraus
nicht.

| Paket | Belegte Lizenz / Auswahl | VCS-Pin und Unterverzeichnis | Rolle im gespeicherten Windows-Releasebaum |
| --- | --- | --- | --- |
| alloc-stdlib 0.2.4 | BSD-3-Clause | `ae42d22078b98549e987d2f03d12df7b984fde47`, `alloc-stdlib` | normaler Laufzeitkandidat; keine Features |
| pageant 0.2.1 | Apache-2.0 | `1947d6b1bb3a9d79840b5adf7eb9b33df2c6e4a7`, `pageant` | normaler Laufzeitkandidat; `default`, `namedpipes`, `wmmessage` |
| delegate 0.13.5 | MIT gewählt aus MIT OR Apache-2.0 | `b129d4cbf4cc499eff7743365dcb0fe5d8d2e820`, Repository-Root | ausschließlich Build-/Proc-Macro-Baum; Proc-Macro, keine Features |
| selectors 0.36.1 | MPL-2.0 | `635e1a19d02960588a00e189bd4bd5bdb150ec3d`, `selectors` | ausschließlich Build-/Proc-Macro-Baum; selbst kein Proc-Macro, keine Features |
| tauri-plugin 2.6.3 | MIT gewählt aus Apache-2.0 OR MIT | `6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a`, `crates/tauri-plugin` | ausschließlich Build-/Proc-Macro-Baum; selbst kein Proc-Macro, nur `build` |

Der technische Kontext stammt aus dem unveränderten
[Rust-Inventar](license-inventory-2026-09-12-rust.json):
`x86_64-pc-windows-msvc`, `tauri/custom-protocol`, Default-Features eingeschaltet,
keine Dev-Abhängigkeiten im Releasebaum. Die Rollen sind Graphbefunde und
keine Aussage über einzelne Codebytes oder generiertes Material in einer
finalen EXE. Es wurde kein neuer Build ausgeführt.

Die fünf lokal vorhandenen `.crate`-Archive stimmen mit ihren SHA-256-Werten im
aktuellen Root-`Cargo.lock` überein. Alle 59 regulären Archiveinträge wurden im
Speicher gelesen und bytegenau mit den installierten Dateien verglichen.
Version, VCS-Pin und `path_in_vcs` stimmen mit dem historischen Inventar
überein. Der Hauptlauf dokumentiert 26 erfolgreiche Bytevergleiche zu den
gepinnten Originalmanifesten, Rust-Quellen und vorhandenen READMEs.

Der unabhängige, rein lesende `selectors`-Vorcheck verglich zusätzlich alle
16 Rust-Dateien, `Cargo.toml.orig`, `README.md` und `CHANGES.md` mit dem Pin:
19 von 19 Paaren sind bytegleich. Seine Einzelhashes und URLs sind im JSON als
separater Agentenbefund gekennzeichnet. Der Hauptlauf wiederholt davon nur
Manifest und `lib.rs`; diese zwei überlappenden Vergleiche werden nicht als
weitere unterschiedliche Dateien gezählt. Der Vorcheck schrieb keine Dateien
und führte keinen Build aus.

| Zugeordneter vollständiger Text | Bytes | SHA-256 |
| --- | ---: | --- |
| [alloc-stdlib BSD-3-Clause](licenses/alloc-stdlib-0.2.4-LICENSE-BSD-3-Clause.txt) | 1.483 | `c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae` |
| [pageant Apache-2.0, bereits vorhandener bytegleicher Export](licenses/russh-cryptovec-0.62.0-util-0.52.0-LICENSE-APACHE.txt) | 11.358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| [delegate MIT](licenses/delegate-0.13.5-LICENSE-MIT.txt) | 1.078 | `be7ee8aa49dc586023669a0c600a0536fce6a9f61264a53a67cdd842564ed899` |
| [selectors MPL-2.0](licenses/selectors-0.36.1-LICENSE-MPL-2.0.txt) | 16.726 | `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04` |
| [tauri-plugin MIT](licenses/tauri-plugin-2.6.3-LICENSE-MIT.txt) | 1.090 | `9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d` |

Die vier neu exportierten Volltexte wurden unverändert übernommen, alle mit
LF und Schluss-LF. Der vorhandene Apache-Text wurde ausschließlich gelesen.
Die zusätzliche [Quellhinweisdatei](licenses/remaining-rust-2026-09-12-SOURCE-NOTICES.txt)
ist eine ausdrücklich bezeichnete AgentBridge-Zusammenstellung tatsächlicher
Hinweise, kein weiterer Upstream-Lizenzvolltext. Sie hat 1.812 Bytes und
SHA-256 `25b6e31287653f3729ee53c29fb2e7924863b36297417bd7af48760af3e05568`.

Bei `alloc-stdlib` stimmen Originalmanifest, README und alle sieben enthaltenen
Rust-Dateien mit dem Paketunterverzeichnis des Dropbox-Pins überein. Seine
BSD-3-Clause-Angabe wird mit der originalen Root-Datei
[LICENSE](https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/ae42d22078b98549e987d2f03d12df7b984fde47/LICENSE)
verbunden; deren Copyright nennt 2016 und Dropbox, Inc. Im vollständigen
Paketunterbaum gibt es keinen spezielleren benannten Lizenz-/Notice-Text.

Bei `pageant` stimmen Originalmanifest und alle fünf Rust-Dateien mit dem
russh-Pin überein. Die dortige
[LICENSE.txt](https://raw.githubusercontent.com/warp-tech/russh/1947d6b1bb3a9d79840b5adf7eb9b33df2c6e4a7/LICENSE.txt)
ist bytegleich mit dem schon gesicherten russh-Support-Text; auch der Git-Blob
`d645695673349e3947e8e5ae42332d0ac3164cd7` ist identisch. Die Zuordnung erfolgt
damit anhand der Quelle und Bytes, nicht allein anhand des Repositorynamens.
Weder Root noch vollständiger `pageant`-Unterbaum enthalten `NOTICE`.
Das Paket implementiert Rust-Transportzugriff auf einen laufenden Pageant;
sein geprüftes Archiv enthält kein Pageant-Programm oder natives Loaderbinary.
Aus dem Paketnamen wird keine zusätzliche PuTTY-Lizenz abgeleitet.

Bei `delegate` belegen Originalmanifest und README ausdrücklich das Wahlrecht.
MIT wird ausgewählt; die originale
[LICENSE-MIT](https://raw.githubusercontent.com/kobzol/rust-delegate/b129d4cbf4cc499eff7743365dcb0fe5d8d2e820/LICENSE-MIT)
nennt `Copyright (c) 2018 The Rust Delegate Crate Developers`. Der Apache-Zweig
wird nicht als zusätzliche kumulative Pflicht behandelt. Beide Rust-Dateien
und README sind bytegleich mit dem Pin. Im gelesenen Root ist keine `NOTICE`
vorhanden; die veröffentlichte Include-Liste enthält nur Rust-Dateien,
Manifest und README, wodurch die vorhandenen Upstream-Lizenzdateien nicht im
Paketarchiv liegen.

Bei `tauri-plugin` erbt das Originalmanifest `license.workspace = true`.
Die gepinnte [Workspace-Definition](https://raw.githubusercontent.com/tauri-apps/tauri/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a/Cargo.toml)
nennt ausdrücklich `Apache-2.0 OR MIT`; daraus wird MIT gewählt. Der vollständige
[MIT-Text](https://raw.githubusercontent.com/tauri-apps/tauri/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a/LICENSE_MIT)
bleibt mit seiner originalen Copyrightangabe `2017 - Present Tauri Apps Contributors`
erhalten. Alle vier Rust-Dateien tragen daneben die tatsächliche
Quellcopyrightzeile `2019-2024 Tauri Programme within The Commons Conservancy`.
Die Root-Datei `LICENSE.spdx` nennt für das Repositorypaket `tauri` zusätzlich
`2019-2025, The Tauri Programme in the Commons Conservancy`. Die Quellhinweise
bewahren beide Angaben mit ihrem jeweiligen Kontext. SPDX-Metadaten ersetzen
hier keinen Volltext; die zwei SPDX-Zeilen allein werden nicht als OR-Beweis
verwendet. Im vollständigen Crate-Unterbaum steht kein weiterer benannter
Lizenz-/Notice-Text. Die `runtime`- und mobilen Quellen werden als
Quellenprovenienz erfasst, ohne ihren Einbau in das Windows-Release zu behaupten.

Bei `selectors` enthalten alle 16 Rust-Dateien denselben originalen MPL-2.0-
Header. Er hat 206 Bytes einschließlich LF und SHA-256
`766674381e88a468d55e07de3596987391cf0e8beebe51baf4fddf11078785b3`.
Im Paketarchiv, gepinnten Repository-Root und vollständigen Crate-Unterbaum
fehlt ein voller Lizenztext. Deshalb stammt die Beigabe aus dem
[offiziellen Mozilla-Text für Version 2.0](https://www.mozilla.org/media/MPL/2.0/index.txt),
auf die der gepinnte Quellheader verweist. Sie wird ausdrücklich nicht als
Datei aus dem Repository-Pin dargestellt. Die geprüften Quellen tragen keine
weitere konkrete Lizenzabweichung oder individuelle Copyrightzeile und keine
angehängte Exhibit-B-Inkompatibilitätskennzeichnung. Der allgemeine Exhibit-B-
Abschnitt im vollständigen Lizenztext ist keine solche Kennzeichnung der
Paketquellen. Die Manifest-Autorenangabe wird nicht in eine erfundene
Copyrightzeile umgewandelt.

Aus der ausschließlich beobachteten Build-Rolle von `selectors` ergibt sich
kein belegter MPL-Binärverstoß der Windows-Anwendung. Für eine spätere
tatsächliche Weitergabe von MPL-Quellen sind deren Hinweise zu erhalten;
bei Weitergabe entsprechenden ausführbaren Codes gehört der Zugang zum
zugehörigen MPL-Quellcode zur Prüfung. Ein Lizenzvolltext allein ersetzt
diesen Zugang nicht. Das betrifft die konkrete Release-Zusammenstellung und
ist kein Nachweis, dass dieser Fall hier bereits vorliegt.
[MPL 2.0, Abschnitte 3.1–3.4](https://www.mozilla.org/en-US/MPL/2.0/)

Der [JSON-Beleg](license-remaining-rust-2026-09-12.json) enthält die genauen
Eingangshashes, 59 Archivdateien, 26 Hauptlaufvergleiche, die 19 gesonderten
`selectors`-Vorprüfvergleiche, Lizenz-/Headerzuordnungen und 48 HTTP-Belege des
Hauptlaufs mit Status, Zeit und Hash. Bei GitHub wurde nur die zuvor konkret
beobachtete russh-API-Weiterleitung auf Repository-ID `456693383` verfolgt.
Die vier gepinnten Repository-Lizenztexte wurden zusätzlich gegen ihre
Git-Blobs geprüft. Die Mozilla-Datei hat keinen behaupteten Git-Blob.

Die ursprünglichen 15 Textlücken sind im JSON einzeln auf diesen Bericht
sowie die bereits gesicherten Berichte zu
[WebView2-Bindings](license-webview2-bindings-2026-09-12.md),
[russh-Support](license-russh-support-2026-09-12.md) und
[UNIC](license-unic-2026-09-12.md) abgebildet. Dies verändert den historischen
Inventarstatus nicht. Native SDK- und Unicode-Datenbedingungen bleiben in den
jeweiligen gesonderten Belegen; sie werden nicht durch eine Crate-Lizenz ersetzt.

Der unabhängige Root-Gegencheck bestätigt acht Eingangshashes, sämtliche
59 Archiveinträge gegen installierte Dateien und alle fünf VCS-Metadaten.
Die 20 tatsächlichen Lizenz-/Copyrightheader stimmen mit den Originalquellen
und ihrer Notice-Zusammenstellung überein. Fünf neue HTTPS-Abrufe bestätigen
alle vollständigen Lizenztexte einschließlich der deduplizierten Pageant-
Zuordnung. Die 15 Name-/Versionszuordnungen stimmen genau mit der ursprünglichen
Lückenliste im historischen Inventar überein. Die maßgeblichen MPL-Abschnitte
wurden zusätzlich in der offiziellen Quelle gelesen; die begrenzte Aussage
zur Build-Rolle und noch offenen Release-Zusammenstellung bleibt erhalten.
Ein anfangs zu breiter Notice-Vergleich erwartete auch normale Quelldateianfänge
ohne Lizenzhinweis in der Beigabe; nach Eingrenzung auf die tatsächlichen
Lizenz-/Copyrightheader besteht der Gegencheck ohne Artefaktänderung.

Beobachteter HEAD beim Export: `9524eb56180fafdffd74568723b9ab9c5cb501ee`.
Alle gehashten Produkt-, Lock-, Konfigurations- und früheren Berichtseingänge
waren vor und nach dem Lauf unverändert. Es entstanden sieben neue Dateien
einschließlich dieses Berichts, keine Tempdateien. Keine Produkt-, Vendor-,
Lock-, Konfigurations- oder historischen Inventardateien wurden geändert;
kein Build, keine Installation, VM-Aktion oder Commit wurde durchgeführt.
