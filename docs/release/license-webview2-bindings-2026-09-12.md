# MIT-Texte der WebView2-Rust-Bindings, 12.09.2026

Die bisher fehlenden vollständigen MIT-Texte sind für `webview2-com` 0.38.2,
`webview2-com-sys` 0.38.2 und `webview2-com-macros` 0.8.1 versionsgenau zugeordnet.
Die beiden tatsächlichen Upstream-Commits enthalten **bytegleich denselben
Lizenztext**. Er ist einmal als unveränderte
[MIT-Lizenzdatei](licenses/webview2-rs-0.38.2-macros-0.8.1-LICENSE-MIT.txt)
gesichert: 1.067 Bytes, SHA-256
`0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73`,
Copyright (c) 2021 Bill Avery. Originalformat: LF mit abschließendem LF, keine
Endleerzeichen.

Die Zuordnung betrifft die Rust-Crates. Für den mitgelieferten Microsoft-SDK-
Loader gelten die gesondert [belegten SDK-Texte](license-webview2-sdk-2026-09-12.md).
Die Lizenz eines Rust-Bindings wird nicht auf dessen native SDK-Dateien
übertragen. Eine tatsächliche Beigabe zum Release oder abschließende
Lizenzkonformitätsbewertung ist hier nicht nachgewiesen.

## Nachvollziehbare Zuordnung

Die lokalen normalisierten Cargo-Manifeste deklarieren jeweils `MIT` und das
Repository `https://github.com/wravery/webview2-rs`. Ihre Versionen und Hashes
passen zum vorhandenen Inventar; die Paketprüfsummen stimmen weiterhin mit
Root-`Cargo.lock` überein. `.cargo_vcs_info.json` benennt für jedes veröffentlichte
Crate den konkreten Commit und Unterpfad:

| Crate | Version | VCS-Commit | Unterpfad |
|---|---|---|---|
| webview2-com | 0.38.2 | `b74dc5e2b394044bea5191052868ce7a106c202c` | `crates/webview2-com` |
| webview2-com-sys | 0.38.2 | `b74dc5e2b394044bea5191052868ce7a106c202c` | `crates/bindings` |
| webview2-com-macros | 0.8.1 | `dffa41a8a46d3f5565eefbff2de57d38d399f158` | `crates/callback-macros` |

Alle drei lokalen `Cargo.toml.orig` stimmen bytegenau mit der jeweiligen
gepinnten Upstream-Manifestdatei überein. Sie setzen `license.workspace = true`.
Beide Upstream-Workspace-Manifeste setzen unter `[workspace.package]` die Lizenz
auf MIT. Die beiden 0.38.2-Crates übernehmen dort auch ihre Version; das
Makro-Crate deklariert 0.8.1 direkt in seinem Paketmanifest.

| Verglichene Originalmanifestdatei | SHA-256 lokal und gepinnter Upstream |
|---|---|
| webview2-com/Cargo.toml.orig | `104bce84b453f732f4bd571e7c604d271380b02890d70f1c753af9d58063c7a4` |
| webview2-com-sys/Cargo.toml.orig | `00229c125c597e4f0ddb9e598738ee5b38a9086fd59eea6d2577cdda5f8e5875` |
| webview2-com-macros/Cargo.toml.orig | `a615e325d5acebc64f6553724028cd5e3639397e534cef107f172540cb78d0fd` |

Die vollständige MIT-Lizenz wurde unabhängig von beiden Pins geladen:
[LICENSE bei b74dc5e](https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/LICENSE)
und [LICENSE bei dffa41a](https://raw.githubusercontent.com/wravery/webview2-rs/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE).
Die identischen Originalbytes begründen die Deduplizierung; ein generischer
MIT-Mustertext oder ein erfundener Copyrightinhaber wurde nicht eingesetzt.

Der [JSON-Beleg](license-webview2-bindings-2026-09-12.json) enthält sämtliche
lokalen Manifest-/VCS-Pfade und Hashes, Lockprüfsummen sowie die sieben
HTTPS-Quellen mit HTTP-Status, Zeitpunkt, Länge und SHA-256. Darunter sind die
beiden Workspace-Manifeste und alle drei Crate-Manifeste. Die Downloads erfolgten
zwischen 09:28:42.936 und 09:28:43.780 UTC mit HTTP 200 ohne Weiterleitungen.
JSON-SHA-256:
`fde5462c44b85eef9e539194a3319ff9031204d4d91715cad8fed483f526c552`.

## Grenze und nächster Schritt

Die zwei normalen Crates und die technische Proc-Macro-Rolle des dritten sind
im historischen Windows-Inventar getrennt erfasst. Daraus wird hier weder ein
neuer Binärnachweis noch eine pauschale Befreiung erzeugten Makrocodes von
Notice-Pflichten abgeleitet. Es wurde kein Crate-Archiv neu geladen oder gehasht;
die vorliegende Zuordnung stützt sich auf die tatsächlichen installierten
Manifeste/VCS-Daten und exakt gepinnte Primärquellen.

Die gemeinsame Datei kann nun mit ihrer Zuordnung zu allen drei Versionen in
die spätere Release-Textauswahl aufgenommen werden. SDK-LICENSE/NOTICE bleiben
daneben eigenständige Einträge. Andere fehlende Crate-Texte und die abschließende
Installer-/Portable-Beigabe bleiben weitere M3-Arbeit.

Alle Downloads blieben bis zum geprüften Export im Speicher; es wurden keine
Tempdateien angelegt. Der exportierte Lizenztext wurde vollständig gegen beide
Downloads geprüft. Lokale Eingänge und Root-Lock wurden vor und nach dem Abruf
auf unveränderte Hashes geprüft. Historische Inventare, Produkt-/Lock-/Config-
Dateien blieben unverändert; keine Installation, kein Build und kein Commit.

Der unabhängige Root-Review bestätigt die begrenzte Zuordnung und ihre
SDK-/Releasegrenze. Root hat Root-Lock und alle neun lokalen Manifest-/VCS-
Dateihashes erneut abgeglichen und beide gepinnten LICENSE-Dateien selbst über
HTTPS gelesen: jeweils bytegleich mit dem gesicherten Originaltext. Keine
notwendige Korrektur; auch dieser Abgleich benötigte keine Tempdatei.
