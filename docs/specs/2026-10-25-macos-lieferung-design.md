# macOS-Lieferung: Design

Stand 2026-10-25. Auftrag des Maintainers: aidevbridge auch für MacBooks
anbieten, mit einer Testinstallation in der CI und einem Mac-Installer an
jedem neuen Tag, ohne dass er selbst etwas hochlädt. Verweise nennen Dateien
und Funktionen; gemeint ist der Branch nach `v0.2.2`.

## 1. Entscheidungen vom 25.10.2026

| Frage | Entscheidung |
| --- | --- |
| Signatur | Ad-hoc signiert. Developer ID und Notarisierung sind vorbereitet und greifen, sobald die Secrets (§6) hinterlegt sind. |
| Architektur | Ein Universal-DMG für Apple silicon und Intel. |
| Lizenzbeigaben | Eigene, gebundene macOS-Lizenzauswahl gleich mit, gleichwertig zur Windows-Auswahl. |
| Release | Vollautomatisch: Am Tag hängt der Workflow das DMG an das Release, gibt es keins, legt er es veröffentlicht an. |

## 2. Ziel und Tor

1. `npm run build:macos` baut auf einem Mac aus einem sauberen Checkout ein
   Universal-DMG mit der App und ihrem `licenses`-Ordner und prüft, was darin
   liegt (§4).
2. Jeder Push und jeder Pull Request baut ein Vorschau-DMG, installiert es auf
   einem Apple-silicon- und einem Intel-Runner aus dem Image, startet die App
   und findet ihr Fenster (§5).
3. Ein Tag `v<version>` baut das Release-DMG gegen die gebundene Auswahl und
   hängt es mit seiner SHA-256 an das Release dieses Tags (§5).
4. Die Windows-Lieferung ändert sich nicht: dieselbe Auswahl, derselbe Ordner,
   dieselben Pakete.

Nicht Teil dieses Schritts: Mac-typische Kürzel (⌘ statt Strg), Anpassungen
an WKWebView und die Abnahme am Fenster eines echten Macs (§7).

## 3. Warum es ohne Codeänderung geht

- aidevbridge ist eine Tauri-2-App. Tauri baut auf macOS `.app` und `.dmg`;
  `src-tauri/icons/icon.icns` liegt bereits vor.
- Der Rust-Teil läuft schon auf Unix (Linux in der CI). Der ssh-agent kommt
  über `SSH_AUTH_SOCK` (`ssh::auth::connect_agent`, Zweig `cfg(unix)`), das
  macOS über launchd setzt. Die Einstellungen landen über `dirs::config_dir()`
  in `~/Library/Application Support/io.github.itbrain258.aidevbridge/`.
- Tauri legt auf macOS das Standardmenü an (`enable_macos_default_menu`);
  darüber gehen ⌘C, ⌘V, ⌘Q und ⌘W.
- Neu ist nur `src-tauri/Info.plist`: Tauri mischt sie in die `Info.plist`
  der App. Sie trägt `NSLocalNetworkUsageDescription`, den Text der Abfrage,
  die macOS 15 beim ersten Zugriff auf einen Host im lokalen Netz zeigt.

## 4. Bau: `scripts/release-macos-artifacts.mjs`

Aufbau wie `release-windows-artifacts.mjs`: sauberer Checkout, festes
Rust 1.97.1 und Tauri CLI 2.11.4, keine geerbten Bauvariablen, eigener
Laufordner `out/release-macos/<run-id>/` mit Sperre, Hooks
`before-build`/`before-bundle` über `src-tauri/tauri.release.macos.json`.
Gebaut wird `tauri build --target universal-apple-darwin --bundles app,dmg`
mit `CI=true`, damit das DMG-Skript von Tauri ohne Finder-Gestaltung läuft.

Vor dem Bau vergleicht es die Rollen der Pakete (Laufzeit, nur Build,
außerhalb) aus der Auswahl mit `cargo tree` auf diesem Build-Host. Nach dem
Bau prüft es:

- Universal-Binary mit genau `arm64` und `x86_64` (Mach-O-Kopf);
- `otool -L` je Architektur: nur `/System/Library/Frameworks/…` und
  `/usr/lib/…`;
- im Bundle nur `Info.plist`, `MacOS/aidevbridge`, `Resources/icon.icns`,
  `Resources/licenses/**` und `_CodeSignature/CodeResources`;
- `Resources/licenses` gleich dem vorbereiteten Ordner;
- `Info.plist`: Kennung, Version, `LSMinimumSystemVersion` 11.0, der
  Netzwerktext;
- `codesign --verify --deep --strict`, ad-hoc oder Developer ID mit
  Hardened Runtime, Stapel und Gatekeeper;
- im eingehängten DMG genau diese App (Hashvergleich), der Link auf
  `/Applications` und höchstens Volume-Icon und Dateisystem-Metadaten.

`release-manifest.json` hält alles fest, mit der SHA-256 des DMG.
`--preview` baut jeden sauberen Commit ohne gebundene Auswahl: statt der
Lizenztexte liegt eine `README.txt` im Ordner, das DMG heißt
`aidevbridge-<version>-preview-<commit>-macos-universal.dmg` und ist nicht
zur Weitergabe.

## 5. CI: `.github/workflows/macos.yml`

| Auslöser | Bau | danach |
| --- | --- | --- |
| Push, Pull Request | Vorschau | Testinstallation, Artefakt `macos-dmg` |
| manuell, `release` an | Release | Testinstallation, nichts veröffentlicht |
| Tag `v*` | Release, Tag gleich `package.json` | Testinstallation, dann Veröffentlichen |

Die Testinstallation läuft auf `macos-latest` (Apple silicon) und
`macos-15-intel`: Prüfsumme, DMG einhängen, App mit `ditto` nach
`/Applications`, Signatur, Architekturen, Gatekeeper (ad-hoc wird abgelehnt,
notarisiert muss passen), App starten, ihr Fenster über
`CGWindowListCopyWindowInfo` finden, beenden, aufräumen. Bildschirmfoto und
Log bleiben als Artefakt.

Veröffentlichen hängt DMG und `.sha256` an das Release des Tags
(`gh release upload --clobber`) und setzt den macOS-Teil des Textes zwischen
die Marken `<!-- aidevbridge:macos:start/end -->`
(`scripts/release-macos-notes.mjs`); der übrige Text bleibt. Gibt es kein
Release, legt der Workflow es veröffentlicht an, mit Verweis auf den
CHANGELOG. Wer danach die Windows-Pakete ergänzt, bearbeitet dieses Release
und legt kein zweites an; Entwürfe findet der Workflow nicht.

`ci.yml` lässt fmt, Clippy und die Rust-Tests zusätzlich auf `macos-latest`
laufen.

## 6. Signatur und Notarisierung

Ohne Secrets signiert der Bau ad-hoc (`signingIdentity: "-"`, Hardened
Runtime). macOS lehnt den ersten Start ab; der Release-Text erklärt
„Dennoch öffnen“ und `xattr`. Für Developer ID braucht das Repository diese
Secrets, und der Workflow reicht sie nur bei Tags weiter:

- `APPLE_CERTIFICATE` (Developer-ID-Application-Zertifikat als .p12, Base64),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`;
- `APPLE_API_ISSUER`, `APPLE_API_KEY` und `APPLE_API_KEY_P8` (Inhalt der
  .p8-Datei eines App-Store-Connect-API-Schlüssels) für die Notarisierung.

Unvollständige Secrets brechen den Bau ab, statt still ad-hoc zu signieren.

## 7. Lizenzauswahl

`scripts/release-license-select-macos.mjs` leitet
`docs/release/license-selection.macos-universal.json` aus der geprüften
Windows-Auswahl ab; der Bericht
`docs/release/license-macos-universal-2026-10-25.json` hält Belege und jede
Änderung fest.

- 343 gemeinsame Crates behalten Entscheidung und Text; nur Rolle, Features
  und das Wort „Windows runtime“ ändern sich. Für `option-ext` und
  `selectors` tritt ein macOS-Beleg (cfg, Feature-Trennung) an die Stelle der
  Windows-Binärbelege.
- 43 reine Windows-Crates und die Familien WebView2, MSVC, NSIS und WiX
  entfallen.
- 25 neue Crates: MIT mit vollständigem Originaltext. Die neun objc2-Crates
  liefern keinen Text; sie tragen den SPDX-MIT-Text (Liste 3.29.0), den ihre
  `LICENSE.md` verlinkt, und diese `LICENSE.md` wörtlich.
- Standardbibliothek nach den installierten RLIBs beider Apple-Ziele: außer
  windows-msvc bringt std `libc`, `addr2line`, `gimli`, `object`,
  `miniz_oxide`, `adler2` und `memchr` mit.
- Rollen gelten für den Build-Host `aarch64-apple-darwin`; der Generator
  meldet ihn `cargo tree` außerhalb eines Macs über einen rustc-Wrapper, der
  Bau prüft sie auf dem echten Host nach.

`release-licenses.mjs` und `release-license-rebind.mjs` kennen dafür die
Profile `windows-x64` (Vorgabe) und `macos-universal`.

## 8. Ablauf eines Releases

1. `npm run bump <version>`, CHANGELOG.
2. Windows-Auswahl neu binden wie bisher
   (`release-license-rebind.mjs … --write`, Version von Hand).
3. macOS-Auswahl neu ableiten:
   `node scripts/release-license-select-macos.mjs --write` (Linux oder macOS,
   mit `rust-src` und den beiden Apple-Zielen für 1.97.1), dann
   `node scripts/release-licenses.mjs prepare macos-universal`.
4. Optional: macOS-Workflow manuell mit `release` an starten.
5. Tag pushen. Der Workflow veröffentlicht das DMG; die Windows-Pakete kommen
   wie bisher dazu.

## 9. Offen

- Abnahme am Fenster eines echten Macs: Verbinden mit Schlüssel, ssh-agent
  und Passwort, Abfrage zum lokalen Netz, Kopieren und Einfügen (⌘ und das
  Kontextmenü, OSC 52 über WKWebView), Schriften, Fensterlage, Schließen und
  Neustart.
- Tastatur: Die Kürzel bleiben die von Windows (Strg+Umschalt). Ob
  Strg+Umschalt+V in WKWebView einfügt, ist ungeprüft.
- Developer-ID-Signatur und Notarisierung sind gebaut, aber ohne Secrets
  ungetestet.
- Bindung der Auswahl an das gebaute Binary: Lastbefehle prüft der Bau schon,
  die Zuordnung der std-Zweige zu Objekten im Binary noch nicht.
