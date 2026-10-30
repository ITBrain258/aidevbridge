# Lizenzen pflegen

Die Release-Pakete tragen die Lizenztexte ihrer Fremdsoftware aus drei
Auswahlen: `docs/release/license-selection.windows-x64.json`,
`…macos-universal.json` und `…android-universal.json`. Jede bindet ihre
Eingänge per SHA-256: eigene Quellen, Lockfiles, Dateien aus `node_modules`,
Cargo-Pakete samt ihrer Lizenzdateien, gespeicherte Lizenztexte und
Quellarchive. Ändert sich ein gebundener Eingang, verweigern `prepare` und
`check` die Hinweise, bis die Änderung geprüft und neu gebunden ist. Die
macOS- und die Android-Auswahl werden aus der Windows-Auswahl abgeleitet.

## Befehle

| Befehl | Wirkung |
| --- | --- |
| `npm run licenses:status` | Listet alle Abweichungen aller drei Auswahlen auf einmal, getrennt in eigene Quellen und Fremdcode bzw. Belege. |
| `npm run licenses:rebind-own` | Bindet geänderte, neue und gelöschte eigene Quellen neu (Bäume `src/`, `src-tauri/src/` …, eigene Einzeldateien, das Manifest des eigenen Pakets). Fremdcode fasst es nicht an. |
| `npm run licenses:check` | `prepare` und `check` für alle drei Plattformen, wenn nichts mehr abweicht. |
| `npm run licenses:derive` | Leitet macOS und Android aus der Windows-Auswahl neu ab (braucht `NDK_HOME`, auf Windows auch für die macOS-Ableitung). |

Als Fremdcode bzw. Beleg zählen Lockfiles (`Cargo.lock`,
`package-lock.json`, `gradle.lockfile`), alles unter `node_modules/`,
`vendor/` und `docs/release/`, `THIRD_PARTY_LICENSES.md` und jedes
Cargo-Paket aus der Registry.

Der CI-Job `licenses` (`.github/workflows/ci.yml`) führt
`release-license-status.mjs --ci` aus: Er scheitert, sobald Fremdcode
abweicht, denn eine geänderte Abhängigkeit braucht ihre Lizenzprüfung im
selben Pull Request. Abweichende eigene Quellen meldet er nur. Weicht nichts
ab, prüft er alle drei Plattformen vollständig.

## Eigene Quellen

Eigene Änderungen werden spätestens vor einem Release neu gebunden:
`npm run licenses:rebind-own`, den Diff der drei Auswahlen ansehen,
`npm run licenses:check`, committen. Kopierter fremder Code in einer
eigenen Datei ist Fremdcode und braucht eine eigene Entscheidung.

Von Hand bleiben, das Werkzeug meldet sie unter `manual`:

- die Version des eigenen Pakets beim Release (sie steht in jeder Auswahl
  an mehreren Stellen: `scope.product_version`, Paketeintrag und Manifest,
  die Komponente `cargo:aidevbridge@…` und die Dokumente unter
  `tests/fixtures/rsa-signing/`),
- ein gebundener Eingang, der fehlt, und eine Bauvariable unter
  `inputs.absent`, die aufgetaucht ist.

## Rust-Abhängigkeiten

1. `cargo update` (oder gezielt `-p`), Tests und Clippy.
2. Unter Windows x64: `node scripts/release-license-update-cargo.mjs`
   zeigt den Plan. Ein Paket zieht nur dann ohne Prüfung auf die neue
   Version um, wenn deklarierte Lizenz, Rolle im Release-Graphen, die Menge
   der Lizenzdateien und die Bytes jeder gebundenen Datei gleich bleiben
   und jeder ausgewählte Text eine eigene Datei des Pakets ist. Alles unter
   `review` braucht einen Eintrag in `REVIEWED` mit Notiz:
   - `changed`, `renames`, `added`, `declared` beschreiben, was sich
     geändert hat; das Skript prüft diese Fakten nach.
   - `external` hält fest, wie ein Text von außerhalb des Crates
     (Repository, Schwester-Crate, gemeinsamer Text) für die neue Version
     geprüft wurde, etwa durch Vergleich mit der Lizenzdatei am
     Veröffentlichungs-Commit (`.cargo_vcs_info.json`).
   - `reason` ersetzt eine Begründung, deren Beleg die alte Version nennt.
   - `new` entscheidet ein neues Paket (nur MIT), `role` eine neue Rolle.

   Einträge eines früheren Updates gehören aus der Tabelle; ihr Beleg
   behält sie.
3. `node scripts/release-license-update-cargo.mjs --write --date=JJJJ-MM-TT`
   schreibt die Windows-Auswahl und den Beleg
   `docs/release/license-rust-update-<Datum>.json`. Danach binden:
   `node scripts/release-license-rebind.mjs --write --add --platform=windows-x64 docs/release/license-rust-update-<Datum>.json`
   und `node scripts/release-license-rebind.mjs --write --third-party Cargo.lock`.
4. `npm run licenses:derive`. Verlangt die macOS- oder Android-Ableitung
   eine Entscheidung (`No macOS decision for …`, `No Android decision for …`,
   `Stale … decision`), kommt sie in die Tabellen von
   `scripts/release-license-select-macos.mjs` bzw.
   `scripts/release-license-select-android.mjs`, mit derselben Sorgfalt
   wie unter Punkt 2.
5. `npm run licenses:status` (keine Abweichung), `npm run licenses:check`,
   `npm run test:scripts`.

Muster: `docs/release/license-rust-update-2026-10-29.json` und Pull Request
#15.

## npm-Abhängigkeiten

Gebunden ist, was ins Frontend-Bundle kommt (Tauri-API-Module, xterm,
`tslib`, der Modulepreload-Polyfill von Vite) samt Lizenztexten und
Hinweisen. Bei einem Update die betroffenen `npm:`-Komponenten der
Windows-Auswahl von Hand umziehen (Version, URLs, Begründung), einen Beleg
unter `docs/release/` anlegen (Muster:
`license-frontend-tauri-2.12-2026-10-29.json`,
`license-frontend-vite-6.4.5-2026-10-29.json`), die geänderten Dateien mit
`--third-party` neu binden, `THIRD_PARTY_LICENSES.md` nachziehen, dann
`npm run licenses:derive` und die Prüfungen wie oben.

## Android-Bibliotheken

Jede Bibliothek der Release-Laufzeit aus
`src-tauri/gen/android/app/gradle.lockfile` braucht eine Entscheidung in
der Tabelle `MAVEN` von `scripts/release-license-select-android.mjs`
(Lizenz, Texte aus dem Archiv, Quell-Repository). Gradle schreibt das
Lockfile mit CRLF; vor dem Binden auf LF umstellen.

## Tauri-CLI und Installer-Werkzeuge

Die Release-Skripte binden den Bundler an eine CLI-Version
(`CLI_VERSION`, `BUNDLER_DOWNLOADS` und `DOWNLOAD_SOURCE` in
`scripts/release-windows-artifacts.mjs`, `CLI_VERSION` in
`scripts/release-macos-artifacts.mjs`); Tests vergleichen sie mit
`package-lock.json`. Ein CLI-Update heißt: den Windows-Teil des Bundlers
zwischen beiden Tags lesen, neue Downloads gegen die Prüfsummen des
Bundlers prüfen, Lizenztexte vergleichen, ein neues Quellarchiv gegen
seinen Git-Baum verifizieren, lokal mit `npm run build:windows` bauen und
Setup und MSI auslesen und mit dem letzten Release vergleichen. Muster:
`docs/release/windows-installer-nsis-3.13-2026-10-30.md` und Pull Request
#16.

## Rust-Toolchain

Die Toolchain steckt in den Belegen der Standardbibliothek
(`docs/release/licenses/rust-1.97.1-*`, Tabellen `STDLIB` der beiden
Ableitungen, Komponenten `rust-toolchain:*` der Windows-Auswahl) und in der
Prüfung `scope.rust_toolchain` von `scripts/release-licenses.mjs`; ein
Wechsel ist eine eigene Stufe.

## Vor dem Merge

Keine Abweichung, `check` grün für alle drei, und bei Änderungen an
Fremdcode oder Release-Werkzeugen die Probeläufe von `android.yml` und
`packages.yml` mit `release=true` auf dem Branch.
