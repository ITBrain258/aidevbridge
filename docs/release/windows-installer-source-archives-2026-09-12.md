# Geprüfte Installer-Quellarchive und kleinste Offline-Beigabe

Stand 2026-09-12: Die beiden vollständigen offiziellen Commitarchive sind
heruntergeladen, geprüft und nach Root-Review unverändert als lokale
Quellbeigaben integriert. Der eng begrenzte Lizenzhelfer kopiert diese ZIPs
und die Offline-Anleitung in den vorhandenen Notice-Baum. Ein neuer echter
Paketbuild und die Abnahme seiner Installer-Payloads stehen weiterhin aus.
Die fünf zuvor ausgewählten Lizenzoriginale bleiben bytegenau unverändert.

## Erhaltene Originalarchive

Eigener neuer Prüfordner:
`out/release-inspection/source-archives-20260912-da4de4ce7754`.
Downloadzeit: 2026-09-12, 15:21:44–15:21:46 UTC. Beide HTTP-Aufrufe endeten
mit Status 200; Herkunft, endgültige URL, Antwortheader und tatsächliche
Bytes stehen in `wix-download.json` und `nsis-download.json`.

| Archiv | Tatsächliche ZIP-Bytes | Entpackter Dateiinhalt | Dateien | SHA-256 des Originalarchivs |
| --- | ---: | ---: | ---: | --- |
| `wix-3.14.1-source.zip` | 13.859.146 | 51.651.333 | 3.295 | `3cc4bdaca8070042a182675b047882211d042f35139efcb0eeac35eeb81bf9d3` |
| `nsis-3.11-source.zip` | 4.679.758 | 17.826.239 | 1.668 | `e114ddaf187c12725938095e600d242041f978664c332e14740da7c359c167f3` |

Zusammen sind das **18.538.904 Archivbytes (17,68 MiB)** und 69.477.572
unkomprimierte Dateibytes (66,26 MiB). Die spätere Größe eines zusätzlichen
Installer-Builds ist damit noch nicht gemessen.

- WiX-Primärdownload: [vollständiger Commit ZIP](https://github.com/wixtoolset/wix3/archive/b40e9a32c24033e11b77baf2c91a704382f898ed.zip),
  endgültig `https://codeload.github.com/wixtoolset/wix3/zip/b40e9a32c24033e11b77baf2c91a704382f898ed`.
  Commit `b40e9a32c24033e11b77baf2c91a704382f898ed`, Tag `wix3141rtm`,
  Commit-Tree `7ab21a53151fd23680648a3f8ddb3552c92697f4`.
- NSIS-Primärdownload: [vollständiger Commit ZIP](https://github.com/kichik/nsis/archive/7359413009afd4f0fff472d841fc2f2cc0e0a5f8.zip),
  endgültig nach dem offiziellen Repository-Redirect
  `https://codeload.github.com/nsis-dev/nsis/zip/7359413009afd4f0fff472d841fc2f2cc0e0a5f8`.
  Commit `7359413009afd4f0fff472d841fc2f2cc0e0a5f8`, Tag `v311`,
  Commit-Tree `c0dd8f31f6bbb354a70885942a1d4061aecbb3b8`.

Beide Commitbindungen stimmen mit den vorher erhaltenen `*-commit.json`-
und vollständigen `*-tree.json`-Belegen unter
`out/release-inspection/license-integration-20260912-b27f8c7d7bc2` überein.
Die ZIP-Kommentare nennen zusätzlich genau diese Commits. Die originalen
inneren Verzeichnisnamen und sämtliche Dateibytes wurden beibehalten.

## Tatsächlicher Inhaltsnachweis

Für **jede der 4.963 Dateien** wurden Pfad, Größe, SHA-256 sowie der
Git-Blob-SHA-1 aus den entpackten Bytes berechnet. Alle Pfade, Größen und
Git-Blob-Hashes stimmen mit den bereits geprüften vollständigen Git-Trees
überein. Es gibt keine fehlenden, zusätzlichen oder abweichenden Dateien,
keine Submodule und keine Symlink-Dateien in diesen beiden Trees.
Die vollständigen Vergleiche stehen in `wix-contents.json` und
`nsis-contents.json`; es wurde keine Quelle ausgeführt.

Der vorhandene, selbst hashgebundene **7-Zip 26.03** hat beide Archive
unabhängig mit `t` geprüft und mit `l -slt` gelesen: alle vier Aufrufe
Exit 0, stderr leer. WiX enthält 3.276 Deflate- und 19 Store-Dateien,
NSIS 1.652 Deflate- und 16 Store-Dateien. Die gepackten Mitgliedsdaten
umfassen 12.612.968 beziehungsweise 4.225.664 Bytes; der übrige ZIP-Platz
entfällt auf Header, Verzeichnisse und Metadaten. Originalprotokolle und
deren Hashes stehen im Prüfordner und in `independent-7zip.json`.

`relevant-originals.json` belegt zusätzlich:

- Die 21 konkret relevanten Decoder-, UI- und Build-Einstiegsdateien sind
  enthalten und ebenfalls Git-Blob-genau. Darunter die beiden
  `LZMADecode`-Dateien, `Platform.h`, Stub-`SConscript`, `SConstruct`,
  `INSTALL`, alle acht WiX-CA-Dateien sowie die UI-/Buildprojekte.
- Alle **sechs WiX-Grafiken im Quellarchiv sind bytegleich zu den tatsächlich
  extrahierten MSI-Binary-Ressourcen**. Die beiden kurzen Iconnamen heißen
  im Git-Archiv exakt `New.ico` und `Up.ico`.
- WiX `LICENSE.TXT`, NSIS `COPYING`, Modern-UI-2- und NSISdl-Lizenztexte
  stimmen inhaltlich mit den zuvor kopierten Binärdistributionsoriginalen
  überein. Ihre Quellarchive verwenden LF, die Binärdistributionen CRLF.
  **Es wird keine Bytegleichheit dieser zwei Fassungen behauptet.** Der
  diagnostische Vergleich entfernt ausschließlich CR vor LF in einer
  Speicherkopie. Beide Originalfassungen bleiben unverändert; insbesondere
  Modern UI 2 behält in beiden Fassungen das ANSI-Byte `A9`.

Die Quellen der `uica.dll` sind damit vorhanden; es wurde keine neue DLL
kompiliert und keine binäre Reproduzierbarkeit dieser DLL behauptet.

## Umgesetzte Offline-Integration nach Root-Review

Die zwei ZIPs liegen unverändert unter `docs/release/sources/`, jeweils
mit einem konkreten Git-`binary`-Attribut. Der zusätzliche Archivinhalt im
Repository beträgt 17,68 MiB. Die neue `README.txt` nennt die exakten
Komponenten, Original-URLs, Commits, Hashes und Build-Einstiegspfade.
Sie unterscheidet die unveränderten Quellarchive von den ebenfalls
unveränderten Lizenztexten der Binärdistributionen und behauptet keinen
Rebuild der upstream gelieferten Binärdateien.

Die Auswahl enthält eine eigene `source_archives`-Liste mit genau dem
beschränkten Typ `kind: "source_zip"`. Jeder Record bindet ID, lokalen
Pfad, Lieferdateinamen, Bytes/SHA-256, offizielle URL, vollständigen Commit,
Archivwurzel und ausdrücklich zugeordnete Komponenten. Konkret:

| Archiv-ID | Lokaler Eingang / Liefername | Zuordnung |
| --- | --- | --- |
| `wix-ui-source` | `docs/release/sources/wix-3.14.1-source.zip` | `installer:wix-ui` |
| `nsis-lzma-source` | `docs/release/sources/nsis-3.11-source.zip` | `installer:nsis-lzma-decoder` |

Der Helfer akzeptiert höchstens zwei explizit ausgewählte lokale ZIPs,
prüft ihre Namen, Größe, Hashes und beidseitig vollständige Zuordnung und
kopiert ausschließlich ihre unveränderten Bytes. Es gibt keinen neuen
Download-, Extraktions-, Compiler- oder Collectorpfad. Die bestehende
Offline-Cargo-Metadatenabfrage bleibt unverändert. Die bisherigen
`.txt`-/`.md`-Dokumentregeln wurden nicht erweitert.

Ausgabe unter dem bestehenden Lizenzordner:

```text
licenses/
  index.html
  manifest.json
  texts/...
  sources/
    README.txt
    wix-3.14.1-source.zip
    nsis-3.11-source.zip
```

Die HTML-Übersicht verlinkt beide Archive, ihre Komponenten und die lokale
Offline-Anleitung. Das innere Manifest enthält `source_archives` samt
Provenienz/Hashes, die Komponentenverweise und den Hash der Anleitung.
Die beiden Quellenstatusfelder nennen jetzt die lokale Beigabe; der
Hashabgleich in den nächsten tatsächlichen Paketen bleibt ausdrücklich
offen. Die anderen 415 Komponenten und alle 209 Dokumente bleiben in der
Auswahl strukturell unverändert.

`compareOutput()` prüft den zusätzlichen genau benannten, **flachen**
`sources/`-Ordner samt dessen drei erwarteten Dateien. Fehlende, zusätzliche,
veränderte und fremde Ausgaben sowie verschachtelte leere Verzeichnisse
bleiben Fehler; vorhandene Ausgaben werden dabei nicht überschrieben.
Die unveränderte Strenge gilt zugleich für `texts/`. Der vollständige
Offline-Ordner umfasst damit **215 Dateien**.

Die vorhandene Tauri-Ressourcenzuordnung, der Native-Ressourcenvergleich,
`zipPayload()` und die äußere Manifestprüfung binden bereits den vollständigen
Notice-Baum. Daher ist keine weitere Releasekonfiguration nötig: Die drei
Dateien folgen dem bestehenden `licenses/`-Pfad in MSI, NSIS und portable
ZIP. Das äußere Manifest bindet die Archivbytes über `notices.files` und den
inneren Manifesthash. Diese vorhandene Verbindung ist im synthetischen
Pakettest geprüft; sie ersetzt keine Auslese neuer echter Installer.

## Regressionen und verbleibende Abnahme

Die gezielten Helferfälle prüfen Originalbyteerhalt, deterministische
Wiederholung, Manifest-/Komponenten-/Offline-Verweise und die Ablehnung
veränderter oder fehlender Archive, fremder Formate, unsicherer/mehrfacher
Namen, unvollständiger Zuordnung und einer fehlenden/geänderten Anleitung.
Weitere Gegenfälle prüfen veränderte/fremde Ausgaben und verschachtelte
leere Ordner. Der bestehende synthetische Pakettest prüft jetzt zusätzlich
bytegenau ein verschachteltes Source-ZIP und dessen äußeren Manifestrecord.

Die Testausführung und isolierte Offline-Vorbereitung mit beiden echten
Originalarchiven werden getrennt in
`out/release-inspection/source-integration-20260912-3128ee827beb`
protokolliert. Eine solche Materialisierung prüft die explizit ausgewählten
Eingangsbytes; parallel noch nicht übernommene Rust-Änderungen werden nicht
pauschal neu gehasht oder dadurch als Releaseeingang akzeptiert.

GitHub garantiert bei Commitarchiven stabile Inhalte, aber nicht dauerhaft
identische komprimierte Bytes. Deshalb bleiben diese Originalarchive mit
konkreten Hashes erhalten. Ein künftiger abweichender Download benötigt eine
neue Herkunfts-/Inhaltsprüfung statt automatischer Hashersetzung.
[GitHub-Primärdokumentation](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives#stability-of-source-code-archives).

Nach unabhängigem Diffreview und sauberem Commit bleiben der neue echte
Paketlauf und die MSI-/NSIS-/ZIP-Auslese erforderlich: alle 215 Lizenz- und
Quellbeigaben vollständig vergleichen, insbesondere die beiden ZIP-Hashes
und die fünf zuletzt ergänzten Originaltexte. Die sichtbare RTF-Anzeige,
Installation/Runtime und übrigen Releasekriterien bleiben getrennte offene
Abnahmen. Für diese Implementierung erfolgt kein echter Produktbuild,
Installerstart oder Commit.
