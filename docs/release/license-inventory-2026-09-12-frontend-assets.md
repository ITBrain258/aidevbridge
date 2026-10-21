# Frontend- und Asset-Lizenzinventar

Technischer Offline-Stand zu Commit `1422020f1de3b45a81ea236f59626467a088c80f`,
Version 0.1.2, 12.09.2026. Das [JSON-Inventar](license-inventory-2026-09-12-frontend-assets.json)
enthält Lock- und Installationsversionen, deklarierte SPDX-Angaben, Importstellen,
vorhandene Lizenz-/Notice-Dateien mit SHA-256, Quellheader und Assethashes.
Keine Rechtsfreigabe, keine Downloads oder neuen Builds; Rust wird separat geprüft.

Dieser Bericht ist eine manuelle Bewertung dieses datierten Eingangsstands.
Der Generator in Schema v2 führt die Befunde F1–F8 ausdrücklich unter
`historical_manual_assessment`, gebunden an den ursprünglichen Commit und den
Hash der 260 referenzierten Belegdateien. Ein späterer Lauf sammelt neue
Beobachtungen und kennzeichnet abweichende Eingänge als **nicht neu bewertet**;
er erklärt frühere Textlücken weder automatisch für weiterhin offen noch für
behoben. Beim hier regenerierten Inventar stimmen diese 260 Dateien noch mit
der Baseline überein.

## Tatsächlich unterschieden

Die Lockdatei enthält 151 Pakete, davon acht ohne Dev-Markierung. 92 Pakete sind
lokal installiert; alle installierten Versionen stimmen mit der Lockdatei überein.
Für die übrigen 59, insbesondere optionale Plattformpakete, liegen hier nur
Lockmetadaten vor. Die AST-Auswertung der produktiven TypeScript-Dateien findet
sieben importierte Pakete. Referenzen in Kommentarbeispielen und Tests zählen
nicht als produktiver Import.

| Paket | Installiert/Lock | Deklariert | Technischer Anteil |
|---|---|---|---|
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT | `core` und `event` importiert |
| `@tauri-apps/plugin-dialog` | 2.7.2 | MIT OR Apache-2.0 | Dateiauswahl importiert |
| `@tauri-apps/plugin-opener` | 2.5.4 | MIT OR Apache-2.0 | Deklariert/installiert, kein Frontendimport; Rust separat |
| `@xterm/xterm` | 6.0.0 | MIT | Terminalcode und CSS importiert |
| `@xterm/addon-fit` | 0.11.0 | MIT | Importiert |
| `@xterm/addon-search` | 0.16.0 | MIT | Importiert |
| `@xterm/addon-unicode11` | 0.9.0 | MIT | Importiert |
| `@xterm/addon-webgl` | 0.19.0 | MIT | Importiert |
| `lucide-static` | 1.41.0 | ISC | Dev-Abhängigkeit, aber 16 übernommene SVG-Geometrien |
| `vite` | 6.4.3 | MIT | Buildwerkzeug; modulepreload-Polyfill im vorhandenen Bundle sichtbar |
| `typescript` | 5.6.3 | Apache-2.0 | Compiler; keine eigene Frontendbibliothek importiert |
| `vitest` / `jsdom` | 4.1.11 / 29.1.1 | MIT / MIT | Testumgebung |
| `@tauri-apps/cli` | 2.11.4 | Apache-2.0 OR MIT | Build-/Iconwerkzeug |

Die übrigen Pakete sind einzeln im JSON erfasst. Eine Dev-Markierung allein
entscheidet nicht, ob erzeugte oder kopierte Bestandteile in der Anwendung landen.

## Übernommene Icons und zusätzliche Hinweise

Alle 16 Inhalte in `src/icons.ts` stimmen nach der dokumentierten Transformation
mit den installierten Lucide-SVGs überein. Die vorhandene zentrale Datei enthält
bereits den vollständigen Lucide-Lizenztext einschließlich Feather-MIT. Zehn
verwendete Namen stehen direkt in der Feather-Liste. Zusätzlich hat
`triangle-alert` dieselbe normalisierte Geometrie wie das dort genannte
`alert-triangle`. `trash-2` stimmt auch mit dem gelisteten Alias `trash` überein.
Die verbleibenden Namen werden dadurch nicht als frei von älterer Provenienz
klassifiziert. Beide vorhandenen Texte sollten beim Assetexport erhalten bleiben.

`src-tauri/icons/source.svg` beschreibt ein eigenes geometrisches, schriftfreies
Appzeichen und den Weg über `tauri icon`; alle vorhandenen Raster-/Containerdateien
sind gehasht. Es wurde kein Icon neu gerendert und keine externe Fontdatei im
getrackten Assetbestand gefunden.

Die vorhandenen Lizenztexte sind eine brauchbare Grundlage, schließen die
Mitlieferungsarbeit aber noch nicht ab:

- Vites Core-MIT-Text und Copyright fehlen zentral. Sein Laufzeit-Polyfill ist im
  vorhandenen JS erkennbar. Daraus folgt keine Übernahme aller in Vites eigenem
  Lizenzdokument gelisteten Buildabhängigkeiten.
- Alle fünf installierten xterm-ESM-Einstiegsmodule tragen zusätzlich einen
  Microsoft-MIT-Header. Dieser fehlt zentral und in den erhaltenen dist-Kommentaren.
  Relevante Hinweise übernehmen; eine behauptete Entfernung des betreffenden
  Codes durch Tree-Shaking müsste am konkreten Release belegt werden.
- Die Tauri-Plugin-Datei `LICENSE.spdx` ist Metadatenbestand, kein vollständiger
  MIT-Text. Sie nennt `2019-2022, The Tauri Programme in the Commons Conservancy`;
  der Dialog-JS-Header nennt 2019–2023, API-Core/Event 2019–2024. Diese konkreten
  Copyrightzeilen fehlen neben dem vorhandenen zentralen Tauri-MIT-Text.
- Tauri API führt außerdem einen eingebetteten `external/tslib/tslib.es6.js` mit
  separatem Microsoft-Erlaubnistext. Der genaue Versionspin fehlt; der App-Lock
  führt kein eigenständiges tslib-Paket. Charakteristische Helfertexte fehlen im
  untersuchten dist, passend zur Entfernung ungenutzter Channel/Resource-Exports.
  Deshalb wird keine tatsächliche Mitlieferung dieses gesamten Moduls behauptet.
- Die Herkunft generierten Compiler-Hilfscodes bleibt im Inventar sichtbar;
  dessen rechtliche Einordnung wird nicht allein aus esbuilds Dev-Rolle abgeleitet.

Die falsche Aussage über Rust-Lizenzen in `Cargo.lock` besteht weiterhin und
sollte durch einen Verweis auf das gesonderte Rust-Inventar ersetzt werden.

## Vorhandene Artefakte und nächste Mitlieferungsarbeit

`dist/` enthält HTML, CSS und JS, keine gesonderte Lizenzdatei. Das JS nennt
`agentbridge 0.1.2 (6a45c12)` und erhält fünf xterm-MIT-Header. Das CSS enthält
einen vollständigen älteren xterm-MIT-Block samt zusätzlichem Bellard-Hinweis.
Die geprüften Frontend-Eingabepfade haben zwischen diesem Commit und HEAD keine
getrackten Änderungen. Das ersetzt keine Buildattestierung oder EXE-Extraktion.
Die vorhandene EXE wurde nur gehasht; ihr Inhalt wurde nicht untersucht.

Diese Commit-/Diff-Aussage wurde für diesen Snapshot beobachtet. Der Generator
liest den Stamp künftig aus den tatsächlichen dist-Bytes und protokolliert
Commitauflösung, Commit-Diff, Änderungen im Arbeitsbaum und ungetrackte Pfade
gesondert. Fehlende, mehrdeutige oder lokal unbekannte Stamps ergeben keinen
erfolgreichen leeren Vergleich. Der Hashabgleich der historischen Belege ersetzt
diese Git-Beobachtungen nicht.

Vor einem konkreten Release: ausgewählte Lizenztexte samt relevanten Copyright-
und Notice-Hinweisen zusammenführen, das Ergebnis an Release-/Lock-/Buildstand
binden und seine tatsächliche Offline-Mitlieferung im Installer beziehungsweise
portablen Paket prüfen. Ein bloßes SPDX-Inventar oder erhaltene Einzelkommentare
belegen diese Mitlieferung nicht. Die bestehende Source-Asset-Lizenzierung wird
dabei nicht als vollständig fehlend dargestellt.

Reproduktion ohne Build/Netzwerk: `node scripts/release-license-inventory-frontend.mjs`
gibt das Inventar ausschließlich auf stdout aus. Die ursprünglichen Quellen,
Locks, installierten Pakete und dist-Dateien werden nicht verändert.

Der korrigierte Vertrag wurde mit unveränderten Eingängen sowie fünf gezielten
Gegenfällen in separaten Node-Prozessen geprüft: zentraler Cargo.lock-Satz
korrigiert, anderer dist-Stamp, mehrere dist-Stamps, unbekannter lokaler Commit
und geänderte Git-Diffausgaben. Datei-/Git-Ergebnisse wurden nur im Speicher
ersetzt; Produktdateien und Artefakte blieben unverändert. Ein früher Testtreiber
konvertierte dabei zunächst auch unveränderte Binärdaten nach UTF-8 und wurde
korrigiert; erst der Lauf mit byteerhaltendem Treiber und erfolgreichem
Unverändert-Kontrollfall gilt als Nachweis.
