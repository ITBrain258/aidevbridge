# Lizenzinventar für den Windows-Release: Entwurf vom 12.09.2026

**Befund 10 bleibt relevant, M3.3 ist noch offen.** Die vorhandenen eigenen
MIT-/Apache-Texte und die bisherigen Frontendtexte sind vorhanden. Der Satz in
`THIRD_PARTY_LICENSES.md`, Rust-Lizenzen seien in `Cargo.lock` aufgeführt, ist
weiterhin falsch. Dieses Paket ergänzt einen reproduzierbaren Inventarentwurf;
es ändert weder die zentrale Lizenzdatei noch die Release-Mitlieferung und gibt
keine abschließende Lizenzfreigabe.

Grundlage sind der neutrale Befund 10,
das Release-Goal und M3.3/M3.4 des
[MVP-Plans](../specs/2026-09-05-mvp-und-statuspunkt-design.md).
M1/M2 werden durch diese unabhängige Vorbereitung nicht ersetzt.

## Eingangsstand und Reproduktion

Erfasst wurde HEAD `1422020f1de3b45a81ea236f59626467a088c80f`, Version 0.1.2,
für `x86_64-pc-windows-msvc`, Cargo 1.97.1 und rustc 1.97.1. Die 14 bestehenden
Rust-Generator-Eingänge einschließlich Workspace-/App-Manifeste, Root-Lock,
Tauri-Konfiguration, npm-Manifeste, eigene Lizenztexte und russh-Provenienz
stimmen bytegenau mit `6a45c12` überein. Ihre einzelnen SHA-256 stehen im JSON.
Das Produkt verwendet **Root-`Cargo.lock`**; es gibt kein `src-tauri/Cargo.lock`.
`vendor/russh/Cargo.lock` ist kein Produktlock.

Der korrigierte Frontend-Generator wurde anschließend auf `7e26d71` erneut
ausgeführt; sein JSON nennt diesen Beobachtungsstand. Die 260 inhaltlichen
Belegdateien stimmen weiterhin mit der historischen Baseline `1422020` überein.
Der zusätzliche Commit betrifft ausschließlich M1-Messhelfer und deren Plan.

Die vorhandene EXE wurde am 12.09.2026 um 07:18:07 UTC geschrieben, ist
16.016.896 Bytes groß und hat SHA-256
`8aa177e304e0b8c067159ac7912d7894b770bc05021a47bd9b0de593cd8255e9`.
Das vorhandene dist nennt `agentbridge 0.1.2 (6a45c12)`. Die Abgleichung der
Eingänge und vorhandenen Buildfingerprints ist keine neue Buildattestierung
oder vollständige Untersuchung des EXE-Inhalts.

Der Rust-Generator verwendet `--features tauri/custom-protocol` mit
Standardfeatures, keine Dev-Kanten und kein `--all-features`. Das ist am
vorhandenen Release-Fingerprint begründet: `agentbridge-d6760445c8995c66` verweist
für Tauri auf den Fingerprint `08327215484ed029`, der zu
`tauri-92d112d69bb458cb` mit `custom-protocol`, ohne `test`, gehört. Rohdaten und
Hashes der Fingerprints sind erhalten. Dagegen enthält Cargo-Metadatas
Featureunion zusätzlich `tauri/test`; sie wird nicht als Produktionsfeature
übernommen. Namen wie `webkit2gtk` in Tauri-Features beweisen keine Linux-Bibliothek
im Windows-Release.

Reproduktion aus demselben Checkout mit vorhandenen lokalen Cargo-/npm-Quellen:

```text
node scripts/release-license-inventory.mjs
node scripts/release-license-inventory-frontend.mjs
```

Beide geben standardmäßig nur JSON auf stdout aus. Der Rust-Generator schreibt
mit `--write` ausschließlich seine datierte JSON-Datei. Er ruft Cargo metadata
und Cargo tree mit `--locked --offline` auf, baut und installiert nichts.
Das Datum, der absolute Cachepfad, HEAD und vorhandene Artefakte werden bei einem
späteren Lauf naturgemäß neu erfasst. Versionen, Lizenztextbytes und fachliche
Zuordnung sind anhand der aufgezeichneten Eingänge vergleichbar.

Die manuellen Frontend-Befunde F1–F8 sind in Schema v2 ausdrücklich historische
Baseline-Daten. Der Generator vergleicht den Hash von 260 tatsächlich
referenzierten Belegdateien; abweichende Eingänge werden als nicht neu bewertet
markiert. Die hier regenerierten Eingänge stimmen noch mit der Baseline
überein. Aktuelle dist-Commitstamps und Git-Diff-/Worktree-Angaben werden separat
beobachtet, nicht aus dem historischen Bericht übernommen. Damit behauptet ein
späterer Lauf nach einer Lizenzkorrektur nicht ungeprüft denselben offenen
Befund. Beide Markdownberichte bleiben datierte manuelle Bewertungen.

| Artefakt | SHA-256 |
|---|---|
| [Rust-Generator](../../scripts/release-license-inventory.mjs) | `4840e8359dadfadb0c5e637d4089eb29189503c12fe758caeded2e2532237384` |
| [Rust-Inventar einschließlich tatsächlicher Textbytes](license-inventory-2026-09-12-rust.json) | `9e9637f332eaa701a88475cbd677885e65ca6ce9fd67f981643973836d31d021` |
| [Frontend-Generator](../../scripts/release-license-inventory-frontend.mjs) | `a5045e145833e7a128fa581464998cfe1760df3b5ce990500fdce3bf106e0e3d` |
| [Frontend-/Asset-Inventar](license-inventory-2026-09-12-frontend-assets.json) | `d87c713331c5ba7488ac270494ff5424bfbc23e7226a03349ff5ffe7b5b98b63` |
| [Frontend-/Asset-Bewertung](license-inventory-2026-09-12-frontend-assets.md) | `e349f70d70b4886c49b5098849e886205b983796d6bdb37825e3544bac50d120` |

## Rust: technisch belegte Reichweite

Cargo metadata liefert 386 Pakete. Der gewählte Windows-Graph mit normalen und
Build-Kanten umfasst 370 einschließlich AgentBridge: **279 normale
Laufzeitkandidaten, 90 weitere Build-/Proc-Macro-Pakete und das eigene Produkt**.
16 Metadatenpakete liegen außerhalb dieses Graphen. Hinzunahme der Dev-Kanten
ändert hier die Paketmenge nicht, wohl aber Features. Kein Paket im gewählten
Graphen hat ein leeres Lizenzfeld.

Bei 355 der 370 Pakete wurden insgesamt 661 benannte Lizenz-/Notice-Kandidaten
gefunden; 15 besitzen keine solche Datei in der installierten Quelle. Das JSON
enthält pro Paket Version, Quelle, Manifestpfad/-hash, Lock-Prüfsumme,
VCS-Provenienz soweit vorhanden, unveränderte Lizenzdeklaration, technische
Rolle, Features und relative Textpfade samt Hash. Alle 386 Pakete bleiben
nachvollziehbar enthalten; ihre insgesamt 233 unterschiedlichen gefundenen
Textdateien sind verlustfrei nach SHA-256 dedupliziert. Auch verschachtelte
Texte, etwa aus `ring`, werden erfasst. Eine Textdatei in einem Testunterordner
gilt dadurch nicht automatisch als passende Gesamtpaketlizenz.

Die Rollen sind eine technische Vorauswahl. Cargo selbst beschreibt
`cargo tree -e normal,build` nur als Annäherung an den Build. Normale
Abhängigkeiten können durch cfg/Optimierung wegfallen; Makros und Buildskripte
können Code oder Daten für die Anwendung erzeugen. Der Metadaten-Plattformfilter
reduziert außerdem nicht die gesamte Paketliste. Deshalb ist die Datei kein
aus dem Linker abgeleitetes Binär-SBOM. [Cargo tree](https://doc.rust-lang.org/cargo/commands/cargo-tree.html),
[Cargo metadata](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html).

Diese vollständige Liste bezeichnet fehlende **benannte lokale Dateien**,
nicht automatisch fehlende Nutzungsrechte oder einen Lizenzverstoß:

| Paket/Version | Deklaration | Technische Rolle |
|---|---|---|
| alloc-stdlib 0.2.4 | BSD-3-Clause | normal |
| pageant 0.2.1 | Apache-2.0 | normal |
| russh-cryptovec 0.62.0 | Apache-2.0 | normal |
| russh-util 0.52.0 | Apache-2.0 | normal |
| unic-char-property, unic-char-range, unic-common, unic-ucd-ident, unic-ucd-version jeweils 0.9.0 | MIT/Apache-2.0 | normal |
| webview2-com und webview2-com-sys jeweils 0.38.2 | MIT | normal |
| delegate 0.13.5 | MIT OR Apache-2.0 | Build/Makro |
| selectors 0.36.1 | MPL-2.0 | Build/Makro |
| tauri-plugin 2.6.3 | Apache-2.0 OR MIT | Build/Makro |
| webview2-com-macros 0.8.1 | MIT | Build/Makro |

`russh-cryptovec/src/lib.rs` enthält beispielsweise einen Apache-Verweis samt
Copyright, aber keinen vollständigen Lizenztext. Die Originaldeklarationen mit
Schrägstrichen werden nicht stillschweigend in moderne SPDX-Ausdrücke umgedeutet.
OR-Alternativen brauchen eine dokumentierte Auswahl; AND-Verknüpfungen dürfen
nicht als Wahlrecht behandelt werden. Besonders sichtbar sind `ring`
(`Apache-2.0 AND ISC`, zusätzlich verschachtelte Teilquellen), `brotli`
(`BSD-3-Clause AND MIT`), `dpi` (`Apache-2.0 AND MIT`) sowie Unicode-Texte in ICU
und `unicode-ident`.

`option-ext 0.2.0` mit MPL-2.0 ist über dirs-sys 0.4.1/0.5.0 normal erreichbar.
Der konkrete `OptionExt`-Import liegt jedoch jeweils im XDG-Modul hinter einer
Unix-cfg-Grenze. Die gehashten Quellstellen sind als `source_context_evidence`
erhalten. Das Inventar behauptet deshalb keine tatsächliche MPL-Codeübernahme
in diese Windows-EXE. Falls ein Release MPL-Code mitliefert, muss die zugehörige
Quellenverfügbarkeit mit einem passenden Hinweis behandelt werden; daraus
folgt keine pauschale Umlizenzierung des gesamten Projekts.
[Mozilla MPL-FAQ, Fragen 8 und 11](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

Die lokale russh-Quelle ist anders gelagert als reine Registry-Referenzen: Sie
wird im Repository tatsächlich mitverteilt. Ihr Apache-Text,
`AGENTBRIDGE-PATCH.md`, Upstream-Pin und Patchmarkierungen sind vorhanden und
bleiben erhalten. Die Lizenzdateien der RSA-Testfixtures sind Source-/Testdaten;
ihre Aufnahme ins Inventar behauptet keine Einbettung in die EXE.

## Windows-Bestandteile außerhalb eines einzelnen Crate-SPDX-Felds

`webview2-com-sys 0.38.2/src/lib.rs` bindet für MSVC ausdrücklich
`WebView2LoaderStatic` statisch. Sein Buildskript kopiert die nativen Bibliotheken;
das vorhandene Release-Buildoutput nennt den x64-Suchpfad. Die dortige statische
Bibliothek ist bytegleich mit der installierten Crate-Datei: 10.500.016 Bytes,
SHA-256 `0659b741bde6348d4c4a6ec4ceb9af50e3d0048ed9cd3c8659bccbb61fde55ee`.
Auch die drei Windows-MSVC-Importbibliotheksversionen sind mit Dateihashes erfasst.
Diese Buildbelege ersetzen keine vollständige Analyse aller Linkerbeiträge.

Im installierten WebView2-Crate liegen weder ein eigenständiger MIT-Text noch
SDK-Lizenztexte. Am in `.cargo_vcs_info.json` gepinnten Upstream-Commit
`b74dc5e2b394044bea5191052868ce7a106c202c` ist der
[MIT-Text für die Rust-Bindings](https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/LICENSE)
abrufbar; beim getrennten Makro-Commit
`dffa41a8a46d3f5565eefbff2de57d38d399f158` ebenfalls ein
[eigener gepinnter Lizenzpfad](https://raw.githubusercontent.com/wravery/webview2-rs/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE).
Diese Webtexte wurden nur gelesen, nicht in die Offline-Textsammlung übernommen.

Der gepinnte [Upstream-Generator](https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/crates/update-bindings/src/main.rs)
nennt Microsoft.Web.WebView2 **1.0.3650.58** und kopiert daraus die Loader-Dateien.
Die lokal gelesenen Windows-Versionsressourcen von `x64/WebView2Loader.dll`
bestätigen FileVersion/ProductVersion 1.0.3650.58 und Microsoft als Hersteller.
Das ist Herkunftsevidenz, kein byteweiser Vergleich mit einem hier neu geladenen
NuGet-Archiv. Offen bleibt die präzise Beschaffung und Zuordnung der für diesen
SDK-/Loaderstand geltenden Microsoft-Texte; das MIT-Feld des Rust-Crates wird
nicht ungeprüft auf den Microsoft-Loader übertragen. Der versuchte direkte
NuGet-License-Webabruf lieferte keinen verwendbaren Text.

Der extern installierte WebView2-Runtime ist wiederum vom SDK-Loader zu trennen.
Welche Runtime-/Bootstrapperdateien später tatsächlich verteilt werden, hängt
vom finalen Installer ab. [Microsoft dokumentiert diese Distributionsvarianten](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).
Rust-Standardbibliotheken, MSVC-Laufzeitanteile und Windows-Systemdateien sind
keine Cargo-Pakete und bleiben bis zur konkreten Artefakt-/Installerprüfung
ausdrückliche Inventargrenzen.

## Frontend und konkrete Abschlussarbeit für M3

Die gesonderte Frontendanalyse erfasst 151 Lockpakete, 92 installierte Pakete mit
passenden Versionen und 93 Lizenz-/Notice-Dateien. Sie belegt sieben produktiv
importierte Pakete, acht nominelle Runtime-Abhängigkeiten, 16 kopierte
Lucide-SVG-Geometrien und den Vite-modulepreload-Polyfill im vorhandenen dist.
Lucide/Feather-Texte sind zentral bereits vollständig vorhanden. Ergänzungsbedarf
besteht insbesondere für Vites Core-MIT, Microsoft-Header in xterm und konkrete
Tauri-Copyrightzeilen. Die Bewertung behauptet keine Bundleübernahme sämtlicher
Dev-Pakete oder des ungenutzten Tauri-tslib-Moduls.

Die nächsten Arbeiten sind begrenzt und in dieser Reihenfolge sinnvoll:

1. Den falschen Cargo.lock-Satz berichtigen und den Inventarprozess als Grundlage
   der Lizenzpflege dokumentieren. Bestehende korrekte Lizenztexte behalten.
2. Die 15 lokalen Dateilücken anhand der aufgezeichneten Versionen/VCS-Pins
   schließen oder ihre tatsächliche Nichtmitlieferung belegen. Vorhandene
   Lizenztexte, Copyrights und relevante verschachtelte Notices zuordnen;
   SDK-Loaderbedingungen gesondert klären. Keine erfundenen Copyrightinhaber.
3. Für den festgelegten Release-Target-/Featurestand eine konkrete Textauswahl
   erzeugen. Kopierte Assets und Build-Ausgaben berücksichtigen; MPL-/Unicode-
   und AND-Fälle ausdrücklich behandeln. Das vorhandene JSON ist dafür ein
   Entwurf, kein automatisch rechtlich vollständiges NOTICE-Dokument.
4. Diese Texte samt Quellenhinweisen im portablen Paket und den vorgesehenen
   NSIS-/MSI-Artefakten tatsächlich mitliefern. Anschließend die Inhalte am
   konkreten Release-Commit/Hash offline prüfen und an die Release-Provenienz
   binden. Aktuell existiert keine dafür nachgewiesene Bundle-Ressourcenkonfiguration;
   `build:app` baut weiterhin mit `--no-bundle` und dist enthält keine separate
   Lizenzdatei.

Der enge Abschlusscheck hat die 233 gespeicherten Rust-Textblobs aus dem JSON
byteweise gegen ihre SHA-256 geprüft und alle Textreferenzen aufgelöst. Die
gespeicherten Build-/Manifest-/Lizenzdaten stammen aus lesenden lokalen Aufrufen;
keine Dependency wurde installiert, kein Produktbuild gestartet und kein
Release erzeugt. Der Frontendteil wurde unabhängig von `connect_frontend`
erstellt; für dieses vorbereitende Paket wurde keine zusätzliche allgemeine
Lizenzreviewrunde gestartet.
