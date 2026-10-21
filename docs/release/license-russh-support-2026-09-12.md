# Apache-Texte für russh-cryptovec und russh-util

Die fehlenden vollständigen Lizenztexte für `russh-cryptovec` 0.62.0 und
`russh-util` 0.52.0 sind ihren tatsächlichen Paket- und Upstreamquellen
zugeordnet. Beide gepinnten Upstream-Lizenzdateien sind bytegleich. Eine
unveränderte gemeinsame
[Apache-2.0-Datei](licenses/russh-cryptovec-0.62.0-util-0.52.0-LICENSE-APACHE.txt)
ist gesichert: 11.358 Bytes, SHA-256
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
Sie verwendet LF, hat ein abschließendes LF und keine Endleerzeichen.

Dieser Nachtrag betrifft nur diese beiden Versionen. Er verändert das
[historische Inventar](license-inventory-2026-09-12-rust.json) nicht und bestätigt
keine abschließende Release-Mitlieferung oder allgemeine Lizenzkonformität.

## Veröffentlichte Paketquellen statt Namensähnlichkeit

Die tatsächlich installierten Manifeste deklarieren jeweils `Apache-2.0` und
das Repository `https://github.com/warp-tech/russh`. Beide `.crate`-Archive sind
bereits lokal im Cargo-Cache vorhanden. Ihre SHA-256 stimmen mit den jeweiligen
Prüfsummen in Root-`Cargo.lock` überein:

| Paketarchiv | Bytes | SHA-256 / Lock-Prüfsumme | Enthaltene Dateien |
|---|---:|---|---:|
| russh-cryptovec-0.62.0.crate | 13.520 | `3aec6cb630dbe85d72ffd7bcd95f07e1bd69f9f270ee8adfa1afe443a6331438` | 11 |
| russh-util-0.52.0.crate | 1.849 | `668424a5dde0bcb45b55ba7de8476b93831b4aa2fa6947e145f3b053e22c60b6` | 6 |

Alle 17 enthaltenen Dateien stimmen bytegenau mit ihren installierten
Gegenstücken überein, einschließlich normalisierter Manifeste, Originalmanifeste
und VCS-Metadaten. Die Archive wurden ausschließlich im Speicher entpackt;
Tar-Prüfsummen, Größen, Dateitypen, Paketpräfixe, eindeutige Pfade und abschließende
Nullblöcke wurden geprüft. Es wurde nichts daraus im Dateisystem extrahiert.

Für `russh-cryptovec` nennt `.cargo_vcs_info.json` Commit
`907c732562c5732aad6c140dba958eafddc41ba0`, Unterpfad `cryptovec`.
Das Originalmanifest und sämtliche sieben veröffentlichten Rust-Quelldateien
sind bytegleich zu diesem Commit. Der vollständige Text liegt dort als
[LICENSE.txt](https://raw.githubusercontent.com/warp-tech/russh/907c732562c5732aad6c140dba958eafddc41ba0/LICENSE.txt).
Zusätzlich enthält `src/lib.rs` den konkreten Quellhinweis:

```text
Copyright 2016 Pierre-Étienne Meunier
```

Der folgende Quellheader benennt Apache License 2.0. Dieser Copyrightbezug
bleibt im JSON und hier erhalten; das Fehlen einer gesonderten NOTICE-Datei
entfernt ihn nicht.

## Die dirty-Markierung von russh-util bleibt sichtbar

`russh-util` 0.52.0 wurde laut tatsächlicher VCS-Datei mit `dirty: true` am
Commit `3d09c20c52a542ffa327723d3a44cb1edd9b0ca4`, Unterpfad `russh-util`,
veröffentlicht. Deshalb wurde keine pauschale Gleichheit mit dem Commit
angenommen. Der Vergleich ergibt:

- `src/lib.rs`, `src/runtime.rs` und `src/time.rs` stimmen vollständig mit dem
  angegebenen Commit überein.
- `Cargo.toml.orig` unterscheidet sich **ausschließlich** durch die Paketversion:
  im Commit `0.51.0`, im veröffentlichten Paket `0.52.0`. Nach Ersetzen genau
  dieser einen Versionsangabe stimmen die vollständigen Manifesttexte überein.
- Beide Manifestfassungen deklarieren ausdrücklich `Apache-2.0`. Die
  veröffentlichte Originalmanifestdatei hat SHA-256
  `4bb59fc5468939da7a73e8c7356da3632b7686d08b08d43eb5d0a3c63447849f`,
  die gepinnte Upstream-Fassung
  `c8c92d6019967339af30c3d048baa79ab97568c332fba43e644efe4c99dc8c19`.

Der vollständige Apache-Text ist am zugehörigen Commit als
[LICENSE-2.0.txt](https://raw.githubusercontent.com/warp-tech/russh/3d09c20c52a542ffa327723d3a44cb1edd9b0ca4/LICENSE-2.0.txt)
vorhanden und bytegleich zur oben gesicherten Datei. Die deklarierte Lizenz des
veröffentlichten Pakets, die identischen Quelldateien und der genaue Manifest-
Versionsunterschied begründen diese Zuordnung. Mögliche andere uncommittete
Änderungen im damaligen Gesamtworkspace wurden nicht rekonstruiert. Für
`russh-util` wurden keine Copyrightjahre oder Inhaber erfunden.

## NOTICE-Suche und vorhandene Vendor-Datei

In beiden vollständigen veröffentlichten Archiven, den jeweiligen gepinnten
Repositorywurzeln und den vollständigen zugehörigen Crate-Unterbäumen wurde
keine separate NOTICE-Datei gefunden. Die GitHub-Baumantworten waren nicht
abgeschnitten. Die einzige benannte Lizenzdatei im jeweils geprüften Root ist
die oben verlinkte Apache-Datei. Andere Cratefamilien oder Repositorybereiche
wurden nicht allgemein geprüft.

Die beiden Lizenzdateien haben außerdem denselben Git-Blob
`d645695673349e3947e8e5ae42332d0ac3164cd7`; die SHA-1 der heruntergeladenen
Git-Blobbytes wurde gegen die Baumantworten geprüft. Dasselbe geschah für alle
zwölf verglichenen Upstream-Manifest-/Quelldateien. Die GitHub-API leitet den
Repositoryalias mit HTTP 301 auf Repository-ID `456693383` um; das konkrete
Ziel wurde geprüft und diese Weiterleitungen sind im JSON erhalten.

`vendor/russh/LICENSE-APACHE` hat 10.849 Bytes und SHA-256
`a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5`.
Nach Zusammenfassen von Whitespace stimmt sein Text mit den beiden
Upstream-Dateien überein, seine Originalbytes jedoch nicht. Deshalb wird der
belegte Upstreamtext für diese Familie einmal separat bewahrt. Die Vendor-Datei
wurde weder verändert noch als bytegleicher Upstreamtext ausgegeben.

Der [JSON-Beleg](license-russh-support-2026-09-12.json) enthält alle Archivdateien
mit Hashes, VCS-Daten, Root-/Unterbäume, die zwölf Einzelvergleiche, Quellhinweise,
18 gespeicherte HTTP-Belegantworten sowie den Vendor-Vergleich. Sein SHA-256 ist
`517c0d19502b66eb19c57ac18444697ccc81ebc704030f837ab9fd9dac73365e`.

Der unabhängige Gegencheck durch den Root-Agenten bestätigte Root-Lockhash,
beide Archivhashes, sämtliche 17 Tar-Einträge gegen installierte Dateien und
berichtete Hashes sowie beide VCS-Metadaten. Beide gepinnten Lizenztexte wurden
dabei erneut per HTTPS geladen und gegen den Export geprüft. Das ebenfalls
frisch geladene util-Originalmanifest bestätigte die einzige Versionsänderung.
Dieser konkrete Prüfbereich bestand; die übrigen HTTP-Belegantworten werden
dadurch nicht als zusätzlich unabhängig geprüft ausgegeben.

Der gesicherte Text kann mit den beiden Versionszuordnungen und dem erhaltenen
cryptovec-Quellhinweis in die spätere Release-Textauswahl aufgenommen werden.
Die tatsächliche Installer-/Portable-Beigabe bleibt offen. Es wurden keine
Tempdateien angelegt, keine fremden Programme ausgeführt und keine Produkt-,
Lock-, Konfigurations-, Vendor- oder Inventardateien geändert. Keine Installation,
kein Build und kein Commit durch diesen Arbeitsschritt.
