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

`npm run bump` ändert beim Release auch die Versionszeile des eigenen Pakets
in `Cargo.lock` und `package-lock.json`. Beide Dateien binden die Auswahlen
als Fremdcode, `rebind-own` fasst sie nicht an. Zeigt der Diff nur diese
Zeile, bindet sie
`node scripts/release-license-rebind.mjs --write --third-party Cargo.lock package-lock.json`
in allen drei Auswahlen neu; danach `npm run licenses:derive`.

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
     Darunter fällt auch eine eigene Quellhinweisdatei wie
     `crypto-bigint-0.7.10-SOURCE-NOTICES.txt`,
     `futures-channel-0.3.34-SOURCE-NOTICES.txt` oder
     `crypto-primes-0.7.2-SOURCE-NOTICES.txt`: die zitierten Zeilen im
     neuen Archiv nachsehen, die Datei für die neue Version neu anlegen und
     unter `external` festhalten, wie geprüft wurde. Welche Vermerke so
     beiliegen und warum, steht in
     `license-crypto-bigint-notices-2026-11-05.json` und
     `license-source-notices-2026-11-06.json`.
   - `reason` ersetzt eine Begründung, deren Beleg die alte Version nennt.
   - `new` entscheidet ein neues Paket (nur MIT), `role` eine neue Rolle.

   Einträge eines früheren Updates gehören aus der Tabelle; ihr Beleg
   behält sie.
3. `node scripts/release-license-update-cargo.mjs --write --date=JJJJ-MM-TT`
   schreibt die Windows-Auswahl und den Beleg
   `docs/release/license-rust-update-<Datum>.json`; ein zweites Update am
   selben Tag braucht `--label=<name>` (Beleg
   `license-rust-update-<Datum>-<name>.json`), einen vorhandenen Beleg
   überschreibt das Skript nicht. Danach binden:
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
`tslib`, der Modulepreload-Polyfill von Vite, die Babel-Helfer, die oxc für
private Klassenmitglieder einfügt) samt Lizenztexten und Hinweisen. Seit
Vite 8 erzeugt rolldowns native Bibliothek Polyfill und Helfer; ein Update
von Vite oder rolldown prüft beide neu, wie in
`license-frontend-vite-8-2026-11-05.json`. Die Lizenzkommentare im Bundle
hält `vite.config.ts` (`comments.legal` für JS, ein Plugin für CSS);
`scripts/check-dist-notices.mjs` prüft sie nach jedem Bau. Bei einem Update
die betroffenen `npm:`-Komponenten der Windows-Auswahl von Hand umziehen
(Version, URLs, Begründung), einen Beleg unter `docs/release/` anlegen
(Muster: `license-frontend-tauri-2.12-2026-10-29.json`,
`license-frontend-vite-8-2026-11-05.json`) und in `decision_reports` der
Windows-Auswahl eintragen, die geänderten Dateien mit `--third-party` neu
binden, `THIRD_PARTY_LICENSES.md` nachziehen, dann `npm run licenses:derive`
und die Prüfungen wie oben. `scripts/release-license-inventory-frontend.mjs`
liest den Polyfill aus der rolldown-Bibliothek der eigenen Plattform: Pfad,
Hash und Byte-Offset gelten nur für sie, der Hash des Polyfill-Texts überall.

## Eingebettete Crates (`vendor/`)

`vendor/russh` ist russh mit eigenen Änderungen; Cargo sieht es als
Pfad-Paket, `cargo audit` und Dependabot sehen es nicht (dafür der Job
`vendored` in `audit.yml`). Ein Upstream-Wechsel, wie am 30.10. auf 0.65.0
und am 05.11. auf 0.65.1:

1. Altes und neues Paket von crates.io laden und gegen die Prüfsumme des
   Index prüfen, das alte zusätzlich gegen `UPSTREAM-SHA256SUMS`.
2. Die eigenen Änderungen dreiseitig übertragen (`git merge-file`:
   eigene Fassung, altes Paket, neues Paket), Konflikte von Hand lösen,
   `UPSTREAM-SHA256SUMS` und `AGENTBRIDGE-PATCH.md` neu schreiben, die
   exakte Version in `src-tauri/Cargo.toml` und den Kommentar im
   Root-Manifest nachziehen. Akzeptierte Meldungen, die die neue Version
   behebt, aus `ACCEPTED` in `scripts/check-vendored-advisories.mjs` und aus
   `SECURITY.md` nehmen.
3. Die App testen (`--test-threads=4`) und die Tests des Crates in einem
   temporären Workspace mit einer Kopie und den Produktions-Features, wie
   in `AGENTBRIDGE-PATCH.md` beschrieben. Dieselben Bibliotheks- und
   Integrationstests laufen auch in `.github/workflows/vendored.yml`, im
   Pull Request des Updates und danach bei jeder Änderung am Crate.
4. Lizenzen: `node scripts/release-license-update-cargo.mjs --write --date=…`
   zieht die Komponente um (deklarierte Lizenz und Lizenzdatei gleich),
   den Beleg mit `--add` binden, `Cargo.lock` mit `--third-party`, den
   geprüften Baum mit `node scripts/release-license-rebind.mjs --write --tree vendor/russh`,
   danach `npm run licenses:rebind-own`, `npm run licenses:derive` und
   `npm run licenses:check`.

## Android-Bibliotheken

Jede Bibliothek der Release-Laufzeit aus
`src-tauri/gen/android/app/gradle.lockfile` braucht eine Entscheidung in
der Tabelle `MAVEN` von `scripts/release-license-select-android.mjs`
(Lizenz, Texte aus dem Archiv, Quell-Repository). Gradle schreibt das
Lockfile mit CRLF; vor dem Binden auf LF umstellen.

Ein Update der Android-Bibliotheken oder der Gradle-Plugins, wie am 05.11. auf
AGP 9.3 und Kotlin 2.2:

1. Versionen in `app/build.gradle.kts` bzw. im Root- und
   `buildSrc`-Manifest ändern, einmal `tauri android build` laufen lassen
   (unter Windows ohne Entwicklermodus danach die `.so` nach
   `app/src/main/jniLibs/<abi>/` kopieren und `gradlew` direkt aufrufen).
2. In `src-tauri/gen/android` die Locks neu schreiben:
   `gradlew :app:dependencies --write-locks` (App) und
   `gradlew buildEnvironment --write-locks` (`buildscript-gradle.lockfile`,
   `buildSrc/gradle.lockfile`), alle auf LF.
3. Die Prüfsummen neu schreiben, nach `gradlew --stop` und ohne die Ordner
   `.gradle`, `build`, `buildSrc/.gradle`, `buildSrc/build` und `app/build`:
   `gradlew --no-configuration-cache --refresh-dependencies
   --write-verification-metadata sha256 buildEnvironment :app:dependencies
   assembleUniversalRelease bundleUniversalRelease assembleUniversalDebug`
   (mit `-PabiList=arm64-v8a -ParchList=arm64 -PtargetList=aarch64` und
   ohne die Rust-Aufgaben). `aapt2` ist je Bauplattform ein eigenes
   Artefakt: Die Einträge für Linux, macOS und Windows von Hand ergänzen,
   mit der SHA-256 der Dateien aus Google Maven. Die Datei auf LF. Ohne
   `--refresh-dependencies` nimmt Gradle bereits Aufgelöstes aus seinem
   Cache und zeichnet es nicht auf; die CI scheitert dann an der Prüfung.
4. Für jede neue oder geänderte Bibliothek des Laufzeit-Classpaths einen
   Eintrag in `MAVEN`; neue Texte aus einem Upstream-Repository (etwa
   Kotlins `license/`) unter `docs/release/licenses/` mit Version im Namen.
   Dann `npm run licenses:derive`, `licenses:status` und `licenses:check`.

Das Archiv einer Bibliothek wählt die Ableitung wie Gradle: über die
Android-Laufzeitvariante der Modul-Metadaten (`.module`), sonst
`<artifact>-<version>.aar` oder `.jar`. Leitet die Variante auf ein anderes
Modul um, gehört in `MAVEN` ein `redirect` auf genau dieses Modul.

Die NDK-Belege (`evidence.ndk.targets.<ziel>.built_library` in
`license-android-universal-2026-10-28.json`) liest die Ableitung aus
`target/<ziel>/release/libaidevbridge_lib.so`. Fehlt eine dieser
Bibliotheken, setzt sie den Beleg auf `null`. Dann vorher alle drei Ziele
bauen, oder den zuletzt aufgezeichneten Beleg übernehmen, wenn sich NDK und
native Abhängigkeiten nicht geändert haben, und die Datei mit
`--third-party` neu binden (so bei 0.2.6 und 0.2.7). Die Belege für armv7
und x86_64 stammen noch von der ersten Android-Auswahl vom 28.10.; arm64
wurde mit 0.2.5 und 0.2.7 neu aufgezeichnet.

Beim Release kommt zur Version in der Windows-Auswahl (siehe oben) die
Ableitung `npm run licenses:derive`: Erst sie trägt die Version in die
macOS- und Android-Auswahl und in ihre Belege und Inventare und schreibt den
Bezug auf die Windows-Auswahl (`base_selection`) neu; geprüft wird das sonst
nicht.

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
Wechsel ist eine eigene Stufe. Die Stellen, die die Version nennen und bei
einem Wechsel mitziehen, von den Release-Skripten über die Lizenzauswahlen
bis zu den Workflows und der Bauanleitung, listet
`scripts/rust-toolchain.test.mjs` auf; es meldet jede, die von
`rust-toolchain.toml` abweicht. Die Belege der Standardbibliothek gehören
nicht dazu.

## Vor dem Merge

Keine Abweichung, `check` grün für alle drei, und bei Änderungen an
Fremdcode oder Release-Werkzeugen die Probeläufe von `android.yml` und
`packages.yml` mit `release=true` auf dem Branch.
