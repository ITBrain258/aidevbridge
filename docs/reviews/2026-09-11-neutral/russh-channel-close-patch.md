# Lokaler russh-0.63.2-Patch: tatsächliche Channel-Close-Bestätigung

Stand: 2026-09-12; Verweise auf spätere Änderungen ergänzt am 2026-10-21.
Dieser Bericht beschreibt Anlass, Änderung, Herkunft,
Validierung und Entfernungskriterien der Close-Änderung an `vendor/russh`.
Sie berührt `vendor/russh`, den Patch-Eintrag im Root-Manifest, den
russh-Eintrag im Root-Lockfile und die Versionsanforderung in
`src-tauri/Cargo.toml`; der globale Cargo-Registry-Cache wurde nicht
verändert. Spätere Ergänzungen an `vendor/russh` (Beobachter für das
Kanalende, manuelles Empfangsfenster) und die vollständige Liste der
geänderten Dateien stehen in
[`AGENTBRIDGE-PATCH.md`](../../../vendor/russh/AGENTBRIDGE-PATCH.md).

## Konkreter Auslöser und Änderung

Von acht gezielten Transportregressionen der App, die gegen einen echten
lokalen SSH-Server laufen, bestanden vor dem Patch sechs. Die beiden übrigen
Fälle beobachteten auf dem Server den echten Close-Austausch, aber der
Client-Kanalbesitzer erhielt keine `ChannelMsg::Close`-Bestätigung:

- `operation_stalled_pty_closes_retain_eight_slots_without_aborting_terminal_transport`
- `operation_backpressured_pty_forwarder_still_observes_close_and_ends_receiver`
  (ging mit der Flusskontrolle vom 2026-10-21 in
  `operation_unread_flood_stops_the_peer_at_one_window_and_closes_without_the_reader`
  auf)

Die Quellprüfung bestätigt den Pfad: `Encrypted::close` sendet die lokale
Close-Nachricht und entfernt ohne ausstehende Daten den Eintrag aus
`Encrypted.channels`. Die eingehende Close-Behandlung verlangt anschließend
`CommonSession::is_established_channel`; die Antwort wird deshalb verworfen,
obwohl die bestehende `ChannelRef` noch auf ihr tatsächliches Ende wartet. Client
und Server enthalten denselben Guard. Ein erfolgreicher Queue-Send wird durch
den App-Code ausdrücklich weiterhin nicht als Remote-Bestätigung gewertet.

Der Patch ergänzt `ChannelRef.awaiting_close`, initial `false` an beiden
Konstruktorstellen. Nur das lokale Schließen eines bestätigten Kanals mit
vorhandener Referenz setzt dieses Bit. Ausschließlich der eingehende
`CHANNEL_CLOSE`-Guard akzeptiert zusätzlich diese bestehende Referenz. Nach dem
ersten gültigen Close wird sie entfernt; unbekannte und unbestätigte IDs erhalten
keine solche Berechtigung. Guards für Daten, EOF, Requests, Fensteränderungen und
andere Nachrichten bleiben unverändert. Es gibt keine zusätzliche Queue oder
Sammlung von Kanal-IDs.

Bei noch ungesendeten Daten enthält der ursprüngliche Pfad eine eng verwandte
Kante: `Encrypted::close` setzt nur `pending_close`, lässt aber den bestätigten
Kanal stehen. Nach eingehendem Close wird dessen Referenz bereits entfernt.
Weitere Close-Nachrichten könnten deshalb erneut den Callback erreichen; ohne
weitere Fensterfreigabe bliebe außerdem der verschlüsselte Kanaleintrag erhalten.

Der neue, ausschließlich für tatsächlich empfangenen Close verwendete
`Encrypted::remote_close` sendet daher die gegebenenfalls noch erforderliche
Close-Antwort sofort mit der vorhandenen Peer-ID und entfernt anschließend den
Kanaleintrag samt noch **nicht gesendeten** Daten. War der lokale Close bereits
gesendet und der Eintrag entfernt, wird keine zweite Antwort erzeugt. Lokaler
Close, EOF und normaler Deferred-Flush behalten ihr bisheriges Verhalten.

[RFC 4254 §5.3](https://www.rfc-editor.org/rfc/rfc4254.html#section-5.3) verlangt
eine Close-Antwort, sofern noch keine gesendet wurde, unabhängig vom verfügbaren
Fenster. Geschlossen ist der Kanal nach beiderseitigem Close. Daraus wird hier
abgeleitet, dass noch ungesendete lokale Daten nach empfangenem Close nicht auf
eine weitere Fensterfreigabe warten dürfen. Bereits empfangene Daten werden
weiterhin vor der Close-Meldung an den vorhandenen Empfänger weitergereicht.

## Herkunft und Lizenz

- Paket: `russh` **0.63.2**, unveränderte Version; Registry
  `registry+https://github.com/rust-lang/crates.io-index`.
- Veröffentlichter Archive-Checksum aus dem bereits vorhandenen Root-Lockfile
  und unabhängig berechneter SHA-256 des lokalen `.crate`-Archivs, identisch:
  `8e134e2480f4e86f83e4aa45b4c0a9723f84beaffa694c54bdf056e74efdd7dd`.
- Archiv: **251.605 Bytes**, **85 Dateien / 1.247.091 entpackte Bytes**. Jede
  veröffentlichte Datei per SHA-256 mit der Registry-Quelle verglichen:
  **keine Abweichung**. Kein Archivinhalt wurde ausgeführt.
- Die Registry-Kopie enthält zusätzlich `.cargo-ok` mit sieben Bytes:
  **86 Dateien / 1.247.098 Bytes**, vor dem Patch vollständig kopiert.
  Der ausschließlich lokale Cachemarker wurde danach aus dem Vendorverzeichnis
  entfernt; alle 85 veröffentlichten Dateien bleiben erhalten.
- `.cargo_vcs_info.json`: Upstream-Commit
  `8a51a0dca4f6fbdcc3ce98c627254026b25b3252`, Pfad `russh`.
- Unveränderte Datei-Hashes in
  [`UPSTREAM-SHA256SUMS`](../../../vendor/russh/UPSTREAM-SHA256SUMS).
  SHA-256 der Manifestdatei selbst:
  `44b51742872c52721ecfd80e7f6c462b7b25a6ed0eca6c96a731011456169844`.
- Upstream-Lizenz **Apache-2.0**, Package-Angabe und sämtliche ursprünglichen
  Copyright-/Lizenzhinweise erhalten. Das Archiv enthält keine separate
  Lizenzdatei. Der unveränderte Standardtext wurde deshalb aus der bereits
  lokalen `ssh-key-0.7.0-rc.11/LICENSE-APACHE` als
  [`LICENSE-APACHE`](../../../vendor/russh/LICENSE-APACHE) ergänzt; SHA-256:
  `a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5`.
  Die lokalen Änderungen stehen ebenfalls unter Apache-2.0 und sind an den
  betroffenen Quellstellen gekennzeichnet.

Geänderte Upstream-Dateien dieses Patches: `src/channels/{channel_ref.rs,mod.rs}`,
`src/client/{session.rs,encrypted.rs,mod.rs}`,
`src/server/{session.rs,encrypted.rs}`, `src/session.rs`.
Davon enthält `client/mod.rs` nur die Testeinbindung; die Server-Testeinbindung
liegt im ohnehin geänderten `server/encrypted.rs`. Neuer gemeinsamer Testkörper:
`src/tests/channel_close_patch.rs`. Keine Kryptoänderung, kein Versionswechsel,
keine Änderung der angeforderten Produktionsfeatures.

## Validierung

Geprüft ist der Patch auf drei Wegen: mit zehn direkten Packet-Dispatch-Tests
im Vendorcode, mit den acht Operationstests der App gegen einen echten
SSH-Server und mit einer Durchsicht der Quellen. Eine vollständige
Upstream-Testsuite lief nicht.

Der neue gemeinsame Testkörper wird jeweils im Client- und Server-Testmodul
ausgeführt und enthält fünf Fälle, also zehn Tests:

1. Lokaler Close: genau eine tatsächliche Reader-Close-Meldung und ein Callback;
   verspätete Daten bleiben unzulässig; Duplikat ohne weiteren Callback/Send.
2. Remote-initiierter Close: Antwort und Callback genau einmal.
3. Unbekannte und unbestätigte IDs: weder Callback noch neu verliehene
   Close-Berechtigung, auch nach einem lokalen Close-Versuch.
4. Remote-Close bei null Fenster und ausstehenden Daten, jeweils mit/ohne vorher
   angeforderten lokalen Close: sofort genau eine Antwort, beide Tabellen leer,
   kein nachgeschobenes Data/EOF und kein Duplicate-Callback.
5. Lokaler, wegen Daten zurückgestellter Close nach erfolgreichem Flush:
   bestehende Datenübertragung bleibt erhalten, die spätere Close-Antwort wird
   trotzdem beobachtet und nicht erneut beantwortet.

Paketverifikation und Formatierung der neuen/geänderten Stellen sind
abgeschlossen. Vom Formatter erzeugte, sachfremde Änderungen an vorhandenen
Upstreamstellen wurden entfernt, damit der Quellpatch auf Close und die
Testeinbindung begrenzt bleibt.

Das Root-Manifest verwendet `[patch.crates-io]` mit `vendor/russh`. Der Root-Lockdiff
entfernt **ausschließlich** die beiden `source`-/`checksum`-Zeilen von russh;
keine andere Paketversion oder Dependency-Kante wurde geändert. Die vollständige
Auflösung mit `cargo metadata --locked --offline --format-version 1` bestand
(Exit 0) und identifizierte den lokalen Pfad als russh 0.63.2. Ein
Workspace-Ausschluss war nicht erforderlich.
Die Anforderung in `src-tauri/Cargo.toml` ist zusätzlich exakt
auf `=0.63.2` gesetzt: Ein späteres Cargo-Update darf nicht automatisch eine
höhere, vom lokalen Patch nicht erfasste 0.63.x-Version auswählen.

Cargo erlaubt die Tests eines Nicht-Workspace-Pakets mit Dev-Abhängigkeiten
nicht über `-p russh`. Die zehn Vendorfälle laufen deshalb in einem separaten
temporären Workspace mit **unverändertem Upstream-Testmanifest**, eigenem
Root-Lockfile und eigenem Target. Vor dem Lauf wurden alle **61 Quelldateien**
unter `src` sowie das Manifest zwischen Produktkopie und Testkopie per SHA-256
verglichen: keine Abweichung. Der gemeinsame neue Testkörper hat SHA-256
`c00a0da2f08690a63a613aaaa8777d56a99904ee1ae2c7bd24c24ecef274c98e`.

Toolchain: rustc 1.97.1 (`8bab26f4f`, 2026-07-14), Cargo 1.97.1
(`c980f4866`, 2026-06-30). Angeforderte Produktionsfeatures unverändert:
`--no-default-features --features ring,flate2,rsa`. Benötigte originale
Dev-Abhängigkeiten wurden regulär beschafft; deren zusätzliche Auflösung bleibt
im Testworkspace und verändert das Produktions-Lockfile nicht.

**Ergebnis am 2026-09-12: Exit 0, 10/10 Tests bestanden**, keine fehlgeschlagen
oder ignoriert, 174 vorhandene Upstreamtests gezielt ausgefiltert. Der erstmalige
vollständige Testbuild dauerte 9 min 33 s; die zehn Packet-Dispatch-Tests liefen in
0,01 s. Nach dem Lauf erneut alle 61 Quelldateien und das Manifest zwischen
Produkt- und Testkopie verglichen: weiterhin bytegleich, keine Testkorrektur oder
Produktionsänderung während des Builds erforderlich.

Ausgeführter Befehl im isolierten Workspace:

```text
cargo test --manifest-path <temporary-workspace>/Cargo.toml -p russh --lib --no-default-features --features ring,flate2,rsa close_patch_ -j 2 -- --nocapture --test-threads=4
```

Gegen den gepatchten Stand bestanden zusätzlich alle acht Operationstests der
App, einschließlich der beiden zuvor roten Close-Fälle. Diese Fälle gegen einen
echten SSH-Server sind ein eigener Nachweis in der App, nicht Teil der zehn
direkten Packet-Dispatch-Tests.

Die Durchsicht der Quellen, ohne eigene Testläufe, fand im Änderungsumfang von
acht Dateien keine materielle Guard-, Close- oder PendingData-Lücke und hielt
die Gegenfälle für passend. Ihr Einwand zur zunächst offenen
Versionsanforderung führte zum exakten Pin oben.

## Wartung und Entfernung

Der Patch bleibt anhand des obigen Archiv-Checksums und Datei-Manifests
nachvollziehbar. Ein späteres Upstream-Upgrade darf ihn erst entfernen, wenn der
Close-Austausch einschließlich Pending-Data-, Duplicate- und Unconfirmed-Fällen
dort korrigiert ist und dieselben Regressionen bestehen. Der Patch ist kein
Versionsupdate; bestehende Advisory-Befunde behebt er nicht, und er blendet sie
auch nicht aus.
