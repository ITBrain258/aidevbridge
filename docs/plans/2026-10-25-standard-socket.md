# Plan: Standard-Socket (M3.1)

Stand 2026-10-25. Umsetzung der
[Spec vom 25.10.](../specs/2026-10-25-standard-socket-design.md) (dort §9),
nach Kritikrunde und Entscheidungen. Ein Branch, je Schritt Commits mit
grünen Prüfungen (tsc, vitest, cargo fmt, Clippy mit `-D warnings`,
`cargo test --all`, Skripttests), ein PR am Ende. Tests gegen die VMs nur
mit eigenem Testsocket; der echte Standard-Socket nur im Lauf am Fenster
(Schritt 6), mit Sessions, die der Maintainer dafür startet.

## Schritt 1: Messen, bevor gebaut wird (0,5 d)

**Erledigt am 25.10.** ([Messbericht](../messungen/messung-2026-10-25-standard-socket.md)):
Der Wächter mit `-E` hängt auf 3.3a und 3.6 an, lehnt ab und startet ohne
Server nichts, und er lässt die Umgebung unverändert. Ein zweites Inventar
kostet 0,17 s im Median; die Abfrage liest den Standard-Socket in jedem
Durchgang.

Ziel: die zwei Annahmen der Spec belegen, die Code und Frist bestimmen.

1. **Wächter mit `-E`.** Auf beiden VMs (3.3a, 3.6): den Wächter aus
   `session_binding.rs::guarded_attach_command` mit `attach-session -E` statt
   `attach-session` an einem Testsocket. Gemessen wird wie im
   Messbericht vom 12.09. (`messung-2026-09-12-tmux-session-binding-initial.md`):
   bei passender Bindung hängt er an, bei jeder abweichenden Kennung lehnt er
   ab, ohne Server bleibt er ohne Wirkung. Dazu: `show-environment -t` vor und
   nach dem Anhängen mit und ohne `-E`.
   tmux 3.4 nur, wenn ein Host damit bereitsteht (gemessen wurde 3.4 am 12.09.
   auf einem Host, den es nicht mehr gibt); bis dahin gilt der Standard-Socket
   unter 3.4 als nicht unterstützt (Spec §6.2).
2. **Abfrage mit zweitem Inventar.** Mit den Werkzeugen vom 21.10.
   (`fixtures/acht-kacheln/`) vier flutende Kacheln auf dem eigenen Socket,
   dazu eine Session auf einem zweiten Testsocket. Ein Prototyp von
   `poll_status_with` liest das zweite Inventar und dessen Titel mit; gemessen
   werden Dauer der Abfrage und Statuslatenz p95 gegen die Reihe vom 21.10.
3. **Ergebnis:** Messbericht `docs/messungen/messung-2026-10-25-standard-socket.md`,
   Rohdaten unter `fixtures/`. Hält die Latenz nicht (über 4 s p95 bei vier
   Kacheln), gilt der Rückfall der Spec §6.3: Standard-Socket nur in jeder
   zweiten Abfrage.

## Schritt 2: Socket als Typ (1 d)

**Erledigt am 25.10.** `tmux/socket.rs` führt `OwnSocket` (lehnt `default` ab),
`TmuxSocket` mit der Art `app`/`default` und `args()` für `-L <name>`. Anlegen,
Beenden und Serveroptionen hat nur noch `OwnTmuxClient`, gebaut aus einem
`OwnSocket`; die verändernden Bauer in `session_binding` sind auf `crate::tmux`
beschränkt. `SocketBinding` wählt den Wächter nach der Art: eigener Socket wie
bisher mit `HIDE_STATUS`, Standard-Socket mit `attach-session -E` ohne
Präfix. `TmuxClient`, `history_command`, `details_command` und die Wege in
`commands.rs` nehmen `&TmuxSocket`; `AppState` hat `own_socket` und
`default_socket` (umlenkbar über `with_default_socket_name`). Abweichung von
der Liste unten: `InventoryQuery::named` und `named_probe` behalten den
geprüften Namen, weil beide Sockets lesen dürfen und der Typ dort nichts
sperren würde. Tests: alle bestehenden grün (eigener Socket bytegleich), neue
für den Wächter mit `-E`; die Live-Tests liefen gegen 192.0.2.10 auf eigenen
Testsockets mit `--test-threads=4` grün. Mit der Vorgabe der Thread-Zahl
scheitern zwölf der Befehlstests an der Zulassung der Schlüsselvorbereitung
(acht Plätze je Prozess, „Too many key preparations are already pending“);
dieser Schritt ändert den Verbindungsweg nicht.

- `tmux/socket.rs` (neu): `TmuxSocket { Own(String), Default }`, `OwnSocket`,
  `socket_args()` (beide `-L <name>`), Kennung `app`/`default` für Schlüssel
  und DTOs, Testumlenkung des Namens `default`.
- Lesende Bauer auf `&TmuxSocket`: `TmuxClient::tmux`/`query_command`,
  `InventoryQuery::named`, `BindingQuery` (Liste, Auflösung, Wächter zum
  Anhängen), `attach_confirmation` (Probe), `history.rs::history_command`,
  `status/title.rs::details_command`, `russh_transport.rs::attach_command_line`.
- Verändernde Bauer auf `&OwnSocket`: `prepare_server`, `restore_exit_empty`,
  `create_command`, Kill-Wächter, `HIDE_STATUS`.
- Wächter für den Standard-Socket: `attach-session -E`, ohne `HIDE_STATUS`,
  mit den in Schritt 1 gemessenen Bytes.
- `AppState.default_socket` wird `own_socket: OwnSocket`; dazu
  `default_socket_name` für die Testumlenkung.
- Tests: eigener Socket Byte für Byte wie heute (bestehende Tests grün);
  Standard-Socket: kein serverstartender Kopfbefehl, keine verbotenen Befehle
  (Spec §8), `-E` bei jedem Anhängen, nie `-d`. Ein Kompiliertest
  ist nicht nötig: verändernde Bauer haben keine Signatur mit
  `TmuxSocket`, das prüft der Übersetzer.

## Schritt 3: Backend je Socket (1,5 d)

- `session_key` mit Socket; `TerminalAttempt`, Terminaltabelle, Ereignisse.
- Befehle mit Socket-Parameter: `open_terminal`, `send_input`,
  `resize_terminal`, `ack_output`, `close_terminal`, `kill_session`. ACL und
  `capabilities_acl` bleiben bei gleicher Befehlszahl.
- `kill_session`: `foreign_session` vor `invalidate_terminal`.
- `open_terminal` auf dem Standard-Socket nur mit Bindung, sonst
  `foreign_unbound`; nur gemessene Serverversionen (`#{version}`).
- `list_sessions`: Ergebnis je Socket (`SessionListDto { own, default }`, jedes
  mit Zeilen oder Fehler); kein Server als leere Liste; Sitzungsgruppen als
  ungebundene Zeilen (`UnsupportedLinkedWindows` nur für die betroffene
  Session); Schalter `show_default_socket` des Hosts.
- `poll_status`: Ergebnis je Socket, Klassifikation „kein Server“ über den
  absoluten Pfad; `claude agents` und Eltern einmal; eigener Socket zuerst.
- `attach_confirmation::parse_clients`: streng nur die eigene J-Zeile.
- `settings.rs`: `HostEntry.show_default_socket` (fehlt = an),
  `TileEntry` mit `foreign_session` und `socket`, ungültig für die Form von
  0.2.x.
- Tests in `commands/*_tests.rs`, `tmux/*tests.rs`, `settings.rs`; Live-Test
  `integration_default_socket.rs` gegen einen Testsocket anstelle von
  `default`, mit Vergleich von Optionen, Umgebung und Hooks vorher und
  nachher.

## Schritt 4: Frontend-Zustand (1,5 d)

- `Session.socket`, `sessionKey(hostId, socket, name)`; alle Stellen aus
  Spec §5 (gehaltener Status, Sperren, Öffnen, Raster- und Seitenleisten-
  Rückrufe, `closeSessionTile`, `openSessionByUser`,
  `sessionsAfterConnect`).
- `setSessionRecords(host, socket, records)`; Listenzustand und Frische je
  (Host, Socket); `probeHost` liest den eigenen Socket.
- `patchSessionStatus` je Socket; ein Ausfall des Standard-Sockets macht nur
  dessen Sessions veraltet.
- Neuladen der Liste des Standard-Sockets bei unbekannter Session-ID oder
  neuem Server, höchstens alle 10 s je Host.
- Arbeitsplatz: fremde Kacheln speichern und herstellen; der Start wartet auf
  die Listen beider Sockets.
- Terminal: Socket in jedem Aufruf (`terminal.ts`).
- Tests: `app-state`, `workspace`, `main`, `grid`, `terminal` je mit
  gleichnamigen Sessions auf beiden Sockets.

## Schritt 5: Oberfläche (0,75 d)

- Seitenleiste: Gruppe „tmux sessions“, fremde Zeilen ohne „End session…“, mit
  Tooltip; ungebundene Zeilen nicht wählbar, mit Grund; Hostzeile nennt eine
  nicht unterstützte Serverversion.
- Kennzeichen „tmux“ in Kachelkopf (im schmalen Kopf als Symbol), Wartet-Spur
  und Schnellöffnen.
- Host-Dialog: Schalter „Show tmux sessions“.
- Hinweis zur Fenstergröße beim Öffnen, wenn `session_attached` schon über 0
  liegt, höchstens einmal je Lauf (Spec §10 Nr. 2).
- Texte in `en.json`; README („Sessions on tmux's default socket“, Fenstergröße,
  `TMUX_TMPDIR`).
- Tests: Seitenleiste, Raster, Host-Dialog, Hinweis; `styles.test.ts` für das
  Kennzeichen im schmalen Kopf.

## Schritt 6: Abnahme und Doku (0,5 d)

- Live-Test aus Schritt 3 gegen beide VMs.
- Lauf am Fenster mit dem Maintainer (Spec §8, Tor §1 Punkt 1 bis 6), mit dem
  Vergleich von `show -g`, `-gw`, `-s`, `-t`, `show-hooks -g` und
  `show-environment` vorher und nachher.
- CHANGELOG, `docs/stand.md`, Lizenzauswahl neu binden, Lieferlauf.

## Reihenfolge und Abhängigkeiten

Schritt 1 vor allem anderen: Er entscheidet die Bytes des Wächters (Schritt 2)
und den Rhythmus der Abfrage (Schritt 3). Schritt 2 und 3 bauen aufeinander
auf; Schritt 4 braucht die DTOs aus 3; Schritt 5 braucht den Zustand aus 4.
