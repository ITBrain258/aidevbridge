# Plan: Umsetzung des Code-Reviews vom 26.10.

Stand 2026-10-26. Ein Code-Review an `0.2.3` (`e6aa14b`) fand 37 Punkte in sechs Gruppen: Sicherheit (SSH, tmux, Abhängigkeiten), Release/CI/Doku, Robustheit von Backend und Frontend sowie Struktur von Rust und Frontend. S2 und S5 hatte der Maintainer schon ausgeschlossen. Jeder Punkt wurde am Code nachgeprüft und von einer zweiten Prüfung angefochten. Wo beide auseinandergingen, entscheidet dieser Plan in der Sache. Die Entscheidungen des Maintainers vom 26.10. gehen allem vor.

Gearbeitet wird in einem Worktree auf einem Branch (`claude/intelligent-rubin-jygw4u`), mit Commits je Batch. Der Branch wird nur gepusht, damit die CI auf Windows, Ubuntu und macOS laeuft; einen Pull Request, Tag oder Release gibt es dabei nicht, die entscheidet der Maintainer jeweils eigens.

## Ziel

- Sicherheits- und Fehlerbefunde beheben, ohne funktionierende Funktionen einzuschränken.
- Bewusst verbleibende Restrisiken an einer Stelle in `SECURITY.md` begründen, je mit dem Weg zur Lösung.
- Struktur nur dort verbessern, wo der Nutzen das Risiko klar übersteigt: tote Wege entfernen, Duplikate zusammenführen, die größte Datei an Nähten teilen und Kommentare ohne Entwicklungsgeschichte schreiben.
- Am Ende sind die Lizenzauswahlen für Windows und macOS neu gebunden, CHANGELOG, `docs/stand.md` und die Handabnahme nachgeführt und alle Prüfungen grün.

## Leitlinie und Entscheidungen

### Vom Maintainer (26.10.)

Leitlinie: Funktionierendes wird nicht eingeschränkt. Kostet eine Härtung Funktion, bleibt die Funktion, und das Restrisiko steht in `SECURITY.md`. Härtung ohne Funktionsverlust ist erwünscht (sicher als Vorgabe).

- **S2 und S5:** ausgeschlossen, nichts geplant. Damit bleibt auch OSC 52 unberührt.
- **S6a, SHA-1 bei `ssh-rsa`:** bleibt. Der Rückfall greift nur, wenn der Server nichts außer `ssh-rsa` anbietet. Ein Downgrade ist ausgeschlossen, weil die Aushandlung im signierten Exchange-Hash steckt, und eine Fälschung bräuchte ein SHA-1-Second-Preimage. OpenSSH ab 8.8 schaltet `ssh-rsa` ab. Vermeiden lässt sich der Rückfall mit ed25519-Schlüsseln oder einem Server mit rsa-sha2. Der Punkt kommt nur in die Doku.
- **S6c, Hostschlüssel beim Rekey:** Die unerreichbaren `established`-Zweige kommen weg, und die Grenze wird dokumentiert. Es gibt keinen neuen russh-Patch. Ein Vorschlag an russh upstream braucht später ein ausdrückliches OK (U4).
- **F7, `settings.toml`:** kein Single-Instance-Plugin, mehrere Instanzen bleiben möglich. Stattdessen wird dauerhaft geschrieben: eindeutige Temp-Datei, `sync_all` vor dem `rename` und, wo möglich, ein Sync des Verzeichnisses. Ändert eine andere Instanz die Datei, erkennt die App das und führt neu geladen zusammen, ohne Datenverlust. `SECURITY.md` und README beschreiben das Verhalten.
- **S6b:** Eine reduzierte Sperrliste weist nur Werte ab, die nie ein Hostname sein können, mit klarer Meldung etwa bei `user@host`.
- **S6d und S6e:** werden umgesetzt. Nichts fällt weg, was das Frontend nutzt; Tests und die Abnahme am Fenster sichern das.
- **`SECURITY.md`:** ein Abschnitt „Known limitations and accepted risks“ mit SHA-1-Rückfall, Rekey, RUSTSEC-2023-0071, russh-Servercode, unsignierten Paketen und mehreren Instanzen; dazu die Doku-Drift aus D2.

### In diesem Plan entschieden

- **F5 entfällt** (Nachprüfung: reduziert umsetzen; Gegenprüfung: streichen). Die heutige Meldung irrt auf der sicheren Seite, und echte Auslöser sind selten: tmux 3.4 beendet `new-session -c` mit fehlendem Ordner mit Exit 0. Die Änderung würde die Zusage „nie endgültig melden, was vielleicht lief“ allein auf die Submission-Einordnung stützen und könnte zu doppelten Sessions führen.
- **Q3 ohne Kopplung zwischen Rust und TS:** Rust bekommt nur getypte `AuthError`-Varianten, keine `include_str!`-Prüfungen auf Frontend-Dateien. Nach F3 hängt das Frontend nicht mehr am Wortlaut „no terminal open for this session“; der Text kommt mit Q3-fe weg. Die Kapazitätstexte prüft ein Vitest gegen die Rust-Quellen. So bleiben die Spuren unabhängig.
- **Q5-rust:** `remote::build_in_dir` bleibt, weil Gesamtspec §8.2 und Roadmap A5 es brauchen. Korrigiert werden nur die falschen Kommentare dazu.
- **S6f:** Für den eigenen Socket gilt nur der Zeichensatz, keine Längengrenze, denn die Testsockets werden bis zu 65 Zeichen lang.
- **S4:** Beim Anhängen gilt eine Gruppenregel: Eine vollständige Gruppe wird übersprungen, eine leere hochgeladen, eine teilweise vorhandene verglichen; bei abweichendem oder fehlendem Digest bricht der Lauf ab. `dtolnay/rust-toolchain` wird per SHA gepinnt statt ersetzt, und Dependabot für Actions kommt aus D1 hierher.
- **S6g:** Attestiert wird nur im Lauf des Tags und nur, was dieser Lauf hochlädt. Es gibt keine Zeile in den Release-Notes.
- **F3:** Die Kachel puffert Vorauseingabe, statt die Eingabe zu sperren. Die Abnahme prüft ausdrücklich den Fall der Wartet-Spur (U5).
- **S6d:** `core:webview:allow-internal-toggle-devtools` kommt dazu, wenn der Befehl nur im Debug-Bau existiert.

## Gestrichen oder zurückgestellt

- **S2, S5:** vom Maintainer ausgeschlossen.
- **F2** (globale Sperren beim Emit): keine Änderung am Code. Der Punkt kommt in `docs/stand.md` Punkt 8 als Kandidat für die eigene Messung zu acht flutenden Kacheln.
- **F5:** siehe oben.
- **F6:** keine sichtbare Wirkung, betrifft nur genau tmux 3.0; Spec §6.2 und §6.3 stehen dagegen.
- **Q4-rust:** Die Teilformen der Identität sind gewollt. Ein DTO oder ts-rs würde den IPC-Vertrag ändern oder lizenzpflichtige Abhängigkeiten bringen.
- **Q7-fe:** geht in F9 (eine `t()`) und Q2-fe (ein Ticket für veraltete Listen) auf.
- **Teilpunkte, gestrichen:**
  - F10-rust Teil 1: Ein Assert würde in Produktionsskripten auslösen, ein Sentinel gemessene Bytes ändern.
  - F10-fe (d): OSC 52 gehört zu S2.
  - D1: Trigger, Cache, CLI-Pin, `allowScripts` und Dependabot für Cargo/npm entfallen. Die Feste Vorgabe zur CI bleibt, und die Lizenzbindung ginge vor.
  - D4: Die lizenzgebundenen Release-Skripte werden nicht umformatiert.
  - S6c Option A: kein vendored Patch.
  - S6g: keine Zeile in den Release-Notes.
  - Q2-rust: keine Siebenteilung, kein `ipc.rs`, kein `PtyChannel`, kein `with_input_lease`.
  - Q2-fe: kein `global-banner.ts`, kein Auszug aus `reconcile()`, keine Sidebar mit Schlüsseln, keine Teilung von `terminal.ts`, kein Schritt B.
  - Q3: keine strukturierten Fehler über IPC.
  - Q1: keine Übersetzung englischer Kommentare und kein Komplettumschreiben.
- **Teilpunkte, verschoben:**
  - Q5-fe: Das npm-Paket `@tauri-apps/plugin-opener` fällt erst in der nächsten Lizenzrunde weg.
  - Q5-rust: `keymap.rs` und die Felder `tmux_socket` und `history_limit` bleiben, weil die Specs sie verankern.
  - S4: Die Signatur aus npm ci und tauri build herauszulösen, ein Release-Environment und Tag-Rulesets hängen an U2 und an den Repo-Einstellungen.
- **D3:** wartet auf Entscheidung U1. Historie umschreiben und Fixture-Ordner umbenennen entfallen.

## Ausführung

- **Spuren:**
  - Rust: `src-tauri/`, `Cargo.lock`, Messbericht zu S1.
  - Frontend: `src/`.
  - CI und Doku: `.github/`, `scripts/`, README, SECURITY, CONTRIBUTING, `docs/stand.md`.
  - Abschluss: zuletzt, allein.
- **Reihenfolge:** Innerhalb einer Spur laufen die Batches der Reihe nach, erst Sicherheit und Fehler, dann Struktur, die Kommentarbereinigung zuletzt. Die Spuren laufen parallel, mit getrennten Dateien und Testsuiten. Mit zwei Agenten gleichzeitig läuft Rust immer, im zweiten Platz erst Frontend und dann CI/Doku; der kritische Pfad bleibt gleich.
- **Nur der Abschluss** schreibt CHANGELOG, `docs/abnahme-handarbeit.md` und `docs/release/`. Jeder Batch legt im Scratchpad eine Übergabenotiz ab: Commits, CHANGELOG-Zeile auf Deutsch, Schritte für die Handabnahme, Abweichungen.
- **Commits:** nur die eigenen Pfade, Betreff englisch im Stil von `git log`, kein `--amend`, kein Push.
- **Prüfungen:**
  - Rust: `cargo fmt --all -- --check`, Clippy mit `-D warnings`, `cargo test --locked --lib` und benannte Integrationstests, mit eigenem `CARGO_TARGET_DIR`.
  - Frontend: `npx tsc --noEmit`, `npx vitest run`.
  - Skripte: `npm run test:scripts`. Ein bloßes `node --test` scheitert unter Linux an zwölf Windows-Tests ohne `npm_execpath`.
  - Als root scheitert vor Batch 1 ein TOFU-Test.
- **tmux-Messungen** nur mit privatem `-S`-Socket über einen relativen Pfad im Scratch-Verzeichnis, nie mit produktiven Sockets. Ältere tmux-Versionen werden dort aus den Quellen gebaut.
- **Lizenzen:** Zwischenstände sind nicht lizenzkonsistent. Vorschau-Builds prüfen die Auswahl nicht; erst der Abschluss bindet neu.

## Batches

### Spur Rust

1. **Grüne Basis und Krypto-Updates** (F10-rust, S3; 1,5 h). Der TOFU-Test scheitert über einen Ordner statt über das Schreibschutzbit und läuft so auch als root grün. Dazu `cargo update --precise`: crypto-bigint 0.7.10, ctutils 0.4.6, tokio 1.53.3.
   *Abnahme:* Bibliothekstests vollständig grün. Der Lock-Diff betrifft genau drei Pakete, `vendor/russh/Cargo.lock` bleibt unberührt. `cargo audit` meldet nur noch RUSTSEC-2023-0071. Der Baumvergleich für den Abschluss liegt vor.
2. **tmux: `#` im Startordner und Socketnamen** (S1, S6f; 4,5 h). Messung zuerst auf 3.0a, 3.3a, 3.4 und 3.6. Danach verdoppelt `create_command` jedes `#` genau einmal. `OwnSocket::new` akzeptiert nur `[A-Za-z0-9_-]` und nicht `default`, ohne Längengrenze.
   *Abnahme:* Messbericht `docs/messungen/messung-2026-10-26-tmux-cwd-format.md` mit Rohdaten unter `fixtures/tmux-cwd-format-2026-10-26/`. Tabellentest inklusive `D####Q`. Pfade ohne `#` ergeben bytegleiche argv. Die Tests mit feindlichen Socketnamen laufen über einen Test-Konstruktor.
3. **Hostnamen und Rekey** (S6b, S6c; 5 h). Die Sperrliste greift in `connect_host_core` und in `add_host_impl`/`update_host_impl`. Die `established`-Zweige fallen weg; `check_server_key` bekommt einen Kommentar, und ein Loopback-Test prüft den Rekey mit gleichem Schlüssel.
   *Abnahme:* `*`, `a b` und `user@host` werden ohne DNS und ohne Schreiben abgewiesen; normale Namen und IPv6 mit Zone gehen weiter. Die bestehenden Pair- und Repair-Tests bleiben grün.
4. **Agent-Ablehnung und Kill-Prüfung** (F1, F4, Kommentar zu S6a; 3,5 h). `Key(_)` wird zu `SigningFailed`, `Send(_)` bleibt `HostUnreachable`. Ein beendeter gebundener Kill ohne gemessene Prüfung ist ein Fehler.
   *Abnahme:* Ein Test mit falschem Agent über duplex läuft auch auf Windows-CI. Ein hermetischer Test zeigt `outcome_unknown`.
5. **Rechte und CSP** (S6d, S6e; 3,5 h). Statt `core:default` steht eine explizite Liste in der Capability. In der CSP fallen `worker-src blob:` und `font-src data:` weg; `base-uri`, `form-action` und `object-src` stehen auf `'none'`.
   *Abnahme:* Exakt-Mengen-Test und echte ACL-Erlaubt- und Verweigert-Tests; ein CSP-Test hält die Policy fest.
6. **ssh_config und `settings.toml`** (F8, F7; 5 h). Der Parser liest `Match`, `Key=Wert`, Anführungszeichen und mehrere Muster wie OpenSSH; der erste Wert gilt. Schreiben: eindeutige Temp-Datei, `sync_all`, `rename`, Verzeichnis-Sync unter Unix. Jede Änderung wird neu geladen und zusammengeführt, wenn eine andere Instanz dazwischen schrieb; höchstens drei Versuche.
   *Abnahme:* Ein Test, in dem eine fremde Instanz zwischen Laden und `rename` schreibt, verliert keinen Host. Testhaken statt Rechtetricks. Kein fester Temp-Name mehr.
7. **Aufräumen ohne Verhaltensänderung** (Q3-rust, Q5-rust, Q7-rust; 4 h). Getypte `AuthError`-Varianten mit unveränderten Texten. `poll_status_impl` und `resize_terminal_impl` fallen weg. Die Tests laufen gegen `registered_with_process`. `build_in_dir` bleibt mit korrigierten Kommentaren. `AppState::ready_host` wird eingeführt.
   *Abnahme:* Die Testzahl sinkt nur um bewusst entfernte Tests; Meldungen und Codes sind unverändert.
8. **Tests aus `commands.rs`** (Q2-rust A und C; 2 h). Die Tests ziehen nach `commands/tests.rs`, eine reine Verschiebung. `open_attach` läuft über `open_attach_pending`.
   *Abnahme:* `cargo test --lib -- --list` bytegleich; `lib.rs`, `build.rs`, Capability und ACL-Tests unverändert.
9. **`commands.rs` teilen** (Q2-rust B; 2 h; nur nach U3). `commands/hosts.rs` und `commands/inventory.rs` mit Glob-Re-Exports.
   *Abnahme:* wie Batch 8, dazu Clippy ohne neue Warnungen.
10. **Kommentare Rust** (Q1-rust, D2-Kommentar in `src-tauri/Cargo.toml`; 4,5 h). Falsche Kommentare werden korrigiert, private Marker (Task, Befund, Review-Nachtrag, M-A bis M-D, Plan 1) und Umlaute in Kommentaren entfernt, öffentliche Spec- und Messverweise bleiben. Der Manifest-Kommentar nennt vier russh-Patches.
    *Abnahme:* Ohne Kommentare sind alle Dateien identisch; die verbleibenden Treffer stehen auf einer geprüften Ausnahmeliste.

### Spur Frontend

11. **Vorauseingabe und Robustheit** (F3, F10-fe; 5 h). Die Eingabe bis zum Anhängen wird gepuffert und danach in Reihenfolge über die Eingabekette gesendet. Verworfen wird sie bei abgelehntem Öffnen, `dispose`, Sperre und Verbindungsverlust. Jeder Subscriber ist isoliert, ein Fehler wird über das globale `queueMicrotask` gemeldet. Scheitert `listen()`, gibt das einen Öffnungsfehler und gibt den Platz in der Warteschlange frei. `setTitle` läuft nur bei Änderung.
    *Abnahme:* kein `send_input` vor der Antwort; alle Verwerfungsfälle getestet, auch Antworten von xterm vor dem Anhängen.
12. **Eine `t()`** (F9; 2,5 h). `src/i18n/t.ts` ersetzt die 19 Kopien und ersetzt Platzhalter in einem Durchgang mit `hasOwnProperty.call`.
    *Abnahme:* genau eine Implementierung und ein `TranslationKey`; `'a{message}'` bleibt wörtlich; tsc mit ES2020 grün.
13. **Tests: Flush und echte Formen** (Q6-fe, Q5-fe; 4,5 h). Ein fester, tiefer Microtask-Drain ersetzt `flush(N)`. Typisierte Builder und ein Formwächter im Invoke-Mock kommen dazu; die Kompatibilitätsformen in `main.ts` fallen weg.
    *Abnahme:* Der Selbsttest scheitert mit dem alten Flush. Der Formwächter war vorher rot. `package.json` bleibt unverändert.
14. **Wortlaut und Listenticket** (Q3-fe, Q2-fe; 4,5 h). `unpublishedOpenError` fällt weg; ein Vitest prüft `CAPACITY_ERRORS` gegen die Rust-Quellen. Zuerst kommen Charakterisierungstests, dann `beginListRead` und `SessionListFailure`.
    *Abnahme:* Die Stale-Prüfung steht genau einmal im Code, ohne `defaultPart`-Cast; Texte, IPC-Reihenfolge und DOM bleiben unverändert.
15. **Kommentare Frontend** (Q1-fe; 7 h). Geschichtskommentare und Marker fallen weg, `Befund N` wird zum Spec-Verweis, der veraltete Absatz in `dispose()` wird korrigiert, Umlaute verschwinden. Ein Commit je Datei.
    *Abnahme:* Ein tsc-Build mit `--removeComments` vorher und nachher ist identisch; der Test `source-hygiene.test.ts` ist grün und war vorher rot.

### Spur CI und Doku

16. **CI härten** (S4; 4 h). `persist-credentials: false`, `refs/tags/` mit Prüfung des Tags, Werte über `env` statt `${{ }}` in `run`, alle Actions per SHA gepinnt, Dependabot für Actions. `scripts/release-attach.mjs` ersetzt `--clobber` mit der Gruppenregel.
    *Abnahme:* Tests für die Gruppenregel, darunter der Handlauf mit Tag; actionlint ohne Fehler.
17. **Build-Provenienz** (S6g; 1,5 h). Attestiert wird im Publish-Job, nur bei der Ref des Tags und nur für hochgeladene Dateien, sonst gibt es eine Warnung. README und SECURITY beschreiben `gh attestation verify` mit Bedingung.
18. **Audit und Versionsabgleich** (D1, D4; 2,5 h). Ein eigener `audit.yml` (Zeitplan, Lockfiles, Handstart) mit begründetem Ignore; der Gate-Block in `README#tests` bleibt unverändert. `bump-version.mjs` vergleicht die Version wörtlich, mit Test.
19. **Doku** (D2, S6a, F2 sowie die Texte zu S6c, F7 und S3; 3 h; wartet auf Batch 3 und 6). `SECURITY.md` mit dem Abschnitt „Known limitations and accepted risks“ und macOS-Abdeckung. Ein Hinweis auf mehrere Instanzen im README. `--test-threads=4` in CONTRIBUTING. Die Bug-Vorlage gilt für alle Pakete. `stand.md`: die Grenze der Live-Tests umformuliert, F2 als Messkandidat.

### Abschluss

20. **Lizenzen, CHANGELOG, Stand** (6 h; wartet auf U1 und U2).
    - **Umgebung:** `rust-src` und beide Apple-Targets für 1.97.1, `cargo fetch` für Windows, Apple und Linux.
    - **S3:** Entscheidungsbericht `license-rust-crypto-tokio-2026-10-26.json` und Komponenten in der Windows-Auswahl von Hand nachgeführt.
    - **Neue Dateien im Baum:** `src/i18n/t.ts`, `commands/tests.rs`, gegebenenfalls `hosts.rs` und `inventory.rs`.
    - **Neubinden:** `release-license-rebind.mjs` für Windows, macOS mit `release-license-select-macos.mjs --write` neu abgeleitet, `prepare` und `check` für beide Auswahlen.
    - **Doku:** CHANGELOG, Handabnahme-Abschnitt, `stand.md`, Texte zu den Entscheidungen.
    - **Abnahme:** beide Checks grün; jede `source_archive.sha256` gleich der Lock-Prüfsumme; `vendor/` unverändert; `cargo audit` mit Ignore grün; alle Suiten grün.

## Offene Entscheidungen

- **U1 (D3, blockiert Batch 20 nur für die Notiz):** WiX- und NSIS-Quellen im ZIP. Empfehlung: A, so lassen und in `stand.md` festhalten.
- **U2 (S4, blockiert Batch 20 nur für den Text):** Apple-Secrets im Environment von npm ci und tauri build. Empfehlung: a, das Restrisiko und die Vorbedingung dokumentieren; vor dem Hinterlegen der Secrets wird die Signatur ausgelagert.
- **U3 (Q2-rust B, blockiert Batch 9):** `commands.rs` in `hosts.rs` und `inventory.rs` teilen. Empfehlung: ja, wenn gerade kein anderer Branch `commands.rs` ändert.
- **U4 (S6c, blockiert nichts):** die Rekey-Prüfung später upstream bei russh vorschlagen. Empfehlung: ja, aber erst nach ausdrücklichem OK.
- **U5 (F3, blockiert nichts):** Vorauseingabe behalten. Empfehlung: behalten; entschieden wird an der Handabnahme mit dem Fall der Wartet-Spur.

## Handabnahme

Am Windows-Fenster (Debug-Bau für CSP und Rechte, sonst Release-Paket):

1. Konsole ohne CSP-Verletzung und ohne „not allowed“ bei Terminal mit WebGL, Suche, Themen, allen Dialogen, TOFU, Schlüsseldatei und Link; keine unbehandelten Rejections beim Schließen.
2. Fenstertitel „(1) aidevbridge“ und Blinken in der Taskleiste.
3. Sofort tippen beim Öffnen: alles kommt genau einmal an. Dazu der Veto-Punkt mit der Wartet-Spur (U5).
4. Agent-Ablehnung, falls Hardware vorhanden: Signaturfehler statt „Host not reachable“, keine Wiederholung.
5. `user@host`, `a b` und `*` im Host-Dialog werden abgewiesen; `known_hosts` bleibt unverändert.
6. Ziehen und Zoomen ohne Stocken; zwei Instanzen behalten beide Hosts; keine `*.tmp` bleibt liegen.
7. ssh_config mit Pfad in Anführungszeichen, mehreren Mustern und `Match`.
8. Session in `C#Project` startet genau dort.
9. Eine lange Session übersteht den Rekey.
10. Rauchtest: Verbinden, Liste, Banner, Wiederanhängen, Standard-Socket, Kapazitätshinweis.
11. CI auf drei Systemen grün, Audit grün; vor dem nächsten Tag ein Handlauf mit „release“; beim Tag kein Ersetzen, Attestierung prüfbar.
12. Lizenzseiten mit den neuen Crate-Versionen.

Auf macOS, sobald ein Mac bereitsteht: Web Inspector ohne CSP-Fehler, ssh-agent über `SSH_AUTH_SOCK`, Dock und Titel, Speichern ohne Stocken.

## Schätzung und kritischer Pfad

| Spur | Batches | Stunden |
| --- | --- | --- |
| Rust | 1–10 | 35,5 |
| Frontend | 11–15 | 23,5 |
| CI und Doku | 16–19 | 11 |
| Abschluss | 20 | 6 |
| **Summe** | | **76** |

Kritischer Pfad mit parallelen Spuren: Rust (35,5 h) plus Abschluss (6 h), also **41,5 h**. Ohne Batch 9 sind es 39,5 h. Batch 19 wartet auf Batch 6 (etwa nach 23 h) und endet lange vor der Rust-Spur. Mit nur zwei Agenten gleichzeitig (Rust im ersten Platz, im zweiten erst Frontend und dann CI/Doku, zusammen 34,5 h) bleibt der Pfad gleich.
