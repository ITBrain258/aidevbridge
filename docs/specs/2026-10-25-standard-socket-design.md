# Standard-Socket (M3.1): Design

Stand 2026-10-25, nach der Kritikrunde (§11). Auftrag: Roadmap S3.1
(`docs/plans/2026-09-05-roadmap-bis-release.md`), MVP-Spec §2, Zeile
„Fremde Sessions“, und §3.1 Nr. 5 (Kritikrunde mit Widerlegern für den
Standard-Socket). Diese Spec löst die Regel der Gesamtspec §6.0 ab, nach der
fremde Sockets nur als eigener Host-Eintrag erscheinen, und für den
Standard-Socket die Regel der UX-Spec §5.2, nach der die Liste nur bei einer
neuen Kontrollgeneration neu lädt (§6.3). Verweise nennen Funktionen statt
Zeilen; gemeint ist `main` nach `v0.2.1`.

## 1. Ziel und Tor

Wer tmux von Hand startet (`tmux new -s work`), sieht diese Session in
aidevbridge, mit Status, und kann in ihr arbeiten, auch wenn er sie erst
startet, während die App läuft. Heute bleibt die Seitenleiste leer, solange
nichts auf dem eigenen Socket `agentbridge` läuft (README, „Sessions on
tmux's default socket do not appear“).

Tor (Roadmap S3.1, ergänzt):

1. Eine per Hand auf dem Standard-Socket gestartete Session erscheint unter
   ihrem Host mit Status, auch wenn sie nach dem Verbinden entsteht, und auch
   mit einem Agent, der zurückfragt.
2. Öffnen, Tippen, Größe ändern und Schließen gehen. Schließen hängt nur den
   eigenen Client ab; ein anderer Client des Nutzers bleibt angehängt, und die
   Session läuft weiter (außer der Nutzer hat `destroy-unattached` gesetzt,
   §4).
3. „Beenden“ gibt es für diese Session nicht, und das Backend lehnt es ab.
4. Die App hat auf dem Standard-Socket nichts verändert: `show -g`,
   `show -gw`, `show -s`, `show -t <session>`, `show-hooks -g`,
   `show-environment -g` und `show-environment -t <session>` gleichen sich
   vorher und nachher; keine Session angelegt, kein Server gestartet.
5. Läuft auf dem Standard-Socket kein Server, bleibt das so: Die App legt
   keinen Socket an, startet keinen Server, und der Status der eigenen
   Sessions bleibt aktuell.
6. Die Statuslatenz des M1-Tors (4 s, MVP-Spec §3.4) hält mit einer fremden
   und vier eigenen flutenden Kacheln (§9, Schritt 1).

## 2. Begriffe

- **Eigener Socket:** `agentbridge` (`settings::default_socket`, im
  Debug-Bau über `AIDEVBRIDGE_TMUX_SOCKET` ersetzbar). Die App ist Eigentümer
  dieses Servers und darf seine Optionen setzen (UX-Spec §6.8).
- **Standard-Socket:** der Socket mit dem Namen `default`,
  `$TMUX_TMPDIR/tmux-<uid>/default`, ohne `TMUX_TMPDIR` unter `/tmp`. Es ist
  derselbe, den `tmux` ohne `-L`/`-S` nimmt, solange `$TMUX` nicht gesetzt
  ist. Er gehört dem Nutzer und seiner `~/.tmux.conf`.
- **Fremd:** jede Session, die nicht auf dem eigenen Socket liegt. In M3.1
  ist das genau der Standard-Socket. Weitere Sockets bleiben außen vor;
  `HostEntry.tmux_socket` bleibt ungelesen.

## 3. Regeln für den Standard-Socket

Verbindlich aus der MVP-Spec, hier je Befehl ausbuchstabiert und nach der
Kritikrunde verschärft.

| Vorgang | Standard-Socket |
| --- | --- |
| Inventar, Liste, Bindung, Titel, Verlauf lesen | erlaubt, dieselben gemessenen Lesebefehle wie auf dem eigenen Socket |
| Anhängen | nur über den geprüften Wächter (`if-shell -F` auf Server, Session, Fenster, Pane), mit `attach-session -E`, nie `-d`, ohne vorangestelltes `set -g status off` |
| Anhängen per Name | nie: `attach-session` als oberster Befehl startet einen fehlenden Server (§4, gemessen) |
| Tippen, Größe ändern | erlaubt |
| Kachel schließen | hängt den eigenen Client ab (Kanal zu), sonst nichts |
| Beenden | gibt es nicht: kein Knopf; das Backend lehnt ab (`foreign_session`), bevor es irgendetwas am Terminal ändert |
| Anlegen | nie; „New session“ legt immer auf dem eigenen Socket an |
| Server starten | nie; kein Befehl auf dem Standard-Socket beginnt mit einem Befehl, der einen Server startet |
| Server-, Session-, Fenster-, Pane-Optionen, Umgebung, Hooks, `source-file` | nie |

Ohne numerische Bindung kann die App eine fremde Session nur zeigen, nicht
öffnen (§5): eine Zeile, deren Bindung scheitert, oder eine Session einer
Sitzungsgruppe. Die Zeile nennt den Grund. Server anderer Versionen als der
gemessenen zeigt die App gar nicht (§6.2).

Der Prüfstein im Code ist der Typ, nicht die Disziplin der Aufrufer (§6.1).

## 4. Was das für den Nutzer heißt

Bewusste Folgen der Regeln. Gemessen am 25.10. auf beiden Test-VMs (tmux 3.3a
und 3.6, Server ohne Konfiguration), Versionsangaben aus den tmux-Quellen
(Kritikrunde, §11):

- **Fenstergröße:** Ab tmux 3.1 steht `window-size` auf `latest`. Schon das
  Öffnen der Kachel und jede ihrer Größenänderungen geben dem Fenster die
  Größe der Kachel, auch für den anderen Client des Nutzers; wird dieser
  wieder aktiv, folgt das Fenster ihm. Unter 3.0 (`smallest`) bliebe das
  Fenster so klein wie die Kachel, solange sie offen ist; die App zeigt
  Server unter 3.0 aber gar nicht (§6.2). Die App ändert nichts daran.
- **Statuszeile:** `status` steht auf `on`; die Kachel zeigt tmux' eigene
  Statuszeile und hat eine Zeile weniger als eine Kachel des eigenen Sockets.
- **Verlauf:** `history-limit` ist 2000; beim Anhängen kommt höchstens, was
  der Server hat (UX-Spec §5.6 holt bis zu 5000 Zeilen).
- **Beendete Shell:** `remain-on-exit` ist aus. Endet die letzte Shell,
  verschwindet die Session; die Kachel zeigt „This session has ended on the
  host“ über den bestehenden Weg.
- **Konfiguration des Nutzers gilt:** Präfix, Maus, Farben, `set-clipboard`
  (Vorgabe `external`). Seine Hooks laufen beim Anhängen, Größe ändern und
  Abhängen der App (`client-attached`, `client-resized`, `client-active`
  ab 3.3, `client-detached`). Mit `destroy-unattached` endet eine Session, wenn
  der letzte Client abhängt, auch wenn das die Kachel war.
- **Umgebung:** Ohne `-E` übernähme tmux beim Anhängen `SSH_AUTH_SOCK`,
  `SSH_CONNECTION`, `DISPLAY` und die übrigen Namen aus `update-environment`
  aus der Verbindung der App in die Session und löschte fehlende. Die App
  hängt deshalb immer mit `-E` an.
- **Kein Server:** `list-sessions`, `display-message` und der `if-shell`-Wächter
  starten keinen Server; `attach-session` als oberster Befehl schon, samt
  `~/.tmux.conf` (gemessen am 25.10. auf beiden VMs mit einer Testkonfiguration,
  die beim Laden eine Datei anlegt). tmux legt beim Lesen höchstens das
  Verzeichnis `tmux-<uid>` an, das der eigene Socket ohnehin braucht.

## 5. Identität

Der Socket ist Teil der Identität, der Name bleibt Anzeige (MVP-Spec, Nachtrag
vom 13.09.).

- **Schlüssel:** Host, Socket und Name, numerisch gebunden wie bisher über
  Server-PID, Startzeit und Session-ID. Der Socket als Kennung: `app` oder
  `default`.
- **Backend:** `session_key` wird `"{host}:{socket}:{name}"`. Jeder Befehl,
  der heute Host und Session nimmt, nimmt auch den Socket: `open_terminal`,
  `send_input`, `resize_terminal`, `ack_output`, `close_terminal`,
  `kill_session`; ebenso die Ereignisse des Terminals (`terminal://output`,
  `connection-lost`), die das Frontend schon über die Öffnungskennung filtert.
- **Frontend:** `sessionKey(hostId, socket, name)`; jede `Session` trägt
  `socket`. Alles, was heute über den Namen sucht, sucht über den Schlüssel:
  gehaltener Status (`#keptStatus`, `isSessionStatusCurrent`,
  `sessionStatusObservedAt`), Sperren (`lockInput`, `applyInputLocks`),
  Öffnen (`openSession`, `replaceFocusedTile`, `openLimit`, `restoreTiles`,
  `#markOpened`), der Namensrückfall in `patchSessionStatus`, die Rückrufe von
  Raster, Seitenleiste und Schnellöffnen, `closeSessionTile`,
  `openSessionByUser`, `sessionsAfterConnect`. Zwei gleichnamige Sessions auf
  beiden Sockets sind zwei Zeilen, zwei Kacheln, zwei Schlüssel.
- **Statusabgleich:** `patchSessionStatus` gleicht je Socket ab; „fehlt im
  vollständigen Inventar“ gilt nur innerhalb desselben Sockets.
- **Arbeitsplatz:** Eine fremde Kachel wird als `{ slot, host_id,
  session = "", foreign_session = "<name>", socket = "default" }` gespeichert.
  0.2.x verwirft sie beim Laden (`TileEntry::is_valid` verlangt eine Session),
  statt sie für eine Kachel des eigenen Sockets zu halten; beim nächsten
  Schreiben fällt sie dort weg. Der Rückweg verliert fremde Kacheln, öffnet aber
  nie eine falsche Session. `tiles_version` bleibt 2.

## 6. Backend

### 6.1 Socket und Regel als Typ

- `enum TmuxSocket { Own(String), Default }`. Beide ergeben `-L <name>`,
  `Default` also `-L default`: derselbe Pfad wie ohne Argument, aber ohne
  Rückfall auf `$TMUX`, und mit denselben gemessenen Bauern
  (`InventoryQuery::named`, `SOCKET_PATH_SCRIPT`, die Diagnose über den
  letzten Pfadteil). Die Bestätigung nach dem Anhängen bindet wie heute an
  `#{socket_path}` (`-S`).
- Lesende Bauer nehmen `&TmuxSocket`. Verändernde Bauer (`prepare_server`,
  `restore_exit_empty`, `create_command`, der Kill-Wächter, `HIDE_STATUS`)
  nehmen nur den eigenen Socket als eigenen Typ (`OwnSocket`); ein Aufruf mit
  dem Standard-Socket übersetzt nicht. Die Trennung reicht durch
  `TmuxClient::tmux`, `InventoryQuery`, `BindingQuery` und `SocketBinding`.
- Hart verdrahtetes `-L` fällt weg: `tmux/history.rs::history_command`, das
  Skript in `status/title.rs::details_command` und
  `russh_transport.rs::attach_command_line`.
- Tests: Der Name `default` lässt sich für Tests durch einen Testsocket
  ersetzen (injizierbar wie `AppState.default_socket`). Weil beide Formen
  `-L <name>` sind, laufen Live-Tests die Befehle des Produkts; die Regeln
  hängen am Typ. Kein automatischer Test berührt den echten Standard-Socket.

### 6.2 Liste

- `list_sessions` liest beide Sockets und liefert je Socket ein eigenes
  Ergebnis: die Sessions mit ihrem Feld `socket`, oder einen Fehler. Ein Fehler
  des Standard-Sockets lässt die Liste des eigenen gelten und umgekehrt.
- Kein Server auf dem Standard-Socket ist eine leere Liste, kein Fehler,
  erkannt wie heute über die vorhergesagte Socket-Datei und tmux' Diagnose.
- Die Version des Standard-Sockets ist die seines laufenden Servers
  (`#{version}` im Inventar), nicht die des `tmux` im `PATH`. Unterstützt
  sind die Versionen, für die Bindung, Wächter und Bestätigung gemessen sind:
  3.3a, 3.4 und 3.6. Bei jeder anderen, auch 3.0 (dort lässt sich ein
  fehlender Server nicht beweisen, und die Bestätigung fehlt), bleibt die
  Gruppe leer, und die Hostzeile nennt die Version als Grund.
- Sitzungsgruppen (`new -t`) teilen Fenster; heute bricht das ganze Inventar
  dann ab (`UnsupportedLinkedWindows`). Auf dem Standard-Socket wird eine
  solche Session als Zeile ohne Bindung geführt, das übrige Inventar gilt.
- Die Bestätigung nach dem Anhängen prüft streng nur die eigene J-Zeile;
  fremde Clients (Kontrollmodus mit `pause-after`, Konsole ohne
  `/dev/pts/N`) lassen sie nicht scheitern.

### 6.3 Status und neue Sessions

- `poll_status` liest je Socket ein Inventar und die Titel seiner Panes;
  `claude agents --json` und die Elternprozesse einmal je Abfrage, denn sie
  binden über PIDs. Das Ergebnis trägt je Socket `complete`, Server und
  Zeilen. Kein Server auf dem Standard-Socket ist ein vollständiges, leeres
  Ergebnis dieses Sockets (Klassifikation über den absoluten Pfad, den die
  Liste vorhergesagt hat); ein Fehler dort macht nur dessen Sessions veraltet.
- Frische und gehaltener Status gelten je (Host, Socket). Ein Ausfall des
  Standard-Sockets markiert die eigenen Sessions nie als veraltet.
- **Neue Sessions:** Zeigt das Inventar des Standard-Sockets eine
  unbekannte Session-ID oder einen neuen Server, lädt die App die Liste dieses
  Sockets neu, höchstens alle 10 s je Host. Das löst für den Standard-Socket
  UX-Spec §5.2 ab; der eigene Socket bleibt bei §5.2.
- Die Frist von 5 s gilt für alles zusammen, der eigene Socket zuerst. Ob die
  Statuslatenz unter Last hält, misst Schritt 1 (§9); hält sie nicht, liest die
  App den Standard-Socket nur in jeder zweiten Abfrage.

### 6.4 Terminal

- `open_terminal` nimmt den Socket. Auf dem Standard-Socket nur mit
  numerischer Bindung, über den Wächter, mit `attach-session -E`, ohne
  `HIDE_STATUS`; die Bytes des Wächters werden für diese Form neu gemessen.
  Ohne Bindung lehnt das Backend ab (`foreign_unbound`).
- Verlauf beim Anhängen (UX-Spec §5.6): derselbe lesende Befehl mit den
  Socket-Argumenten.
- Schließen, Wiederanhängen, Kapazitäten, Fristen: unverändert, je Schlüssel.

### 6.5 Beenden und Anlegen

- `kill_session` mit Socket `default` antwortet mit `foreign_session`,
  bevor es den Terminaleintrag ungültig macht oder tmux aufruft.
- `create_session` hat keinen Socket-Parameter: immer der eigene Socket.

## 7. Frontend

- **Liste je Socket:** `setSessionRecords(host, socket, records)` ersetzt nur
  die Sessions dieses Sockets und schließt nur dessen verschwundene Kacheln.
  Listenzustand (`current`, `stale`, Fehler) und Fehlerkasten gelten je
  (Host, Socket). Ob der Host lebt (`probeHost`), entscheidet die Liste des
  eigenen Sockets.
- **Seitenleiste:** Unter jedem Host zuerst die eigenen Sessions wie heute,
  darunter, nur wenn es welche gibt, die Gruppe „tmux sessions“. Gleicher
  Zeilenaufbau (Status, Kachelnummer, Wartezeit). Fremde Zeilen haben keinen
  Knopf „End session…“; der Tooltip der Zeile sagt „tmux session, started
  outside aidevbridge. End it in tmux.“ Eine Zeile ohne Bindung ist nicht
  wählbar und nennt im Tooltip den Grund.
- **Kennzeichen:** Fremde Kacheln, Zeilen der Wartet-Spur und Einträge des
  Schnellöffnens tragen „tmux“ neben dem Host. Im schmalen Kopf (Raster-Spec
  §8.4, Nachtrag) bleibt das Kennzeichen als kurzes Symbol, der Host weicht
  wie bisher.
- **Wartet-Spur, Aufmerksamkeit, Schnellöffnen, Strg+Umschalt+A:** schließen
  fremde Sessions ein.
- **Grenzen:** 8 je Host und 9 insgesamt zählen über beide Sockets (heute schon
  über das Hostpräfix des Schlüssels).
- **„New session“:** unverändert, eigener Socket.
- **Arbeitsplatz:** Eine gespeicherte fremde Kachel wartet, bis die Liste des
  Standard-Sockets ihres Hosts da ist; die Frist des Starts (Raster-Spec §4.6,
  Nachtrag vom 24.10.) wartet auf die Listen beider Sockets.

## 8. Tests und Abnahme

- **Befehlsbauer:** Für den Standard-Socket beginnt kein erzeugter Befehl mit
  einem Befehl, der einen Server startet, und keiner enthält `set`, `setw`,
  `set-option`, `set-environment`, `set-hook`, `source-file`, `start-server`,
  `new-session`, `kill-session`, `kill-server`; jedes Anhängen trägt `-E` und
  nie `-d`. Für den eigenen Socket bleibt jeder Befehl Byte für Byte wie heute.
- **Backend:** Kill auf `default` abgelehnt, ohne Terminal und tmux zu
  berühren; Öffnen ohne Bindung abgelehnt; Liste und Abfrage mit getrennten
  Ergebnissen je Socket, kein Server als leeres, vollständiges Ergebnis;
  Sitzungsgruppe als ungebundene Zeile; fremde Clients stören die Bestätigung
  nicht; gleichnamige Sessions auf beiden Sockets.
- **Frontend:** Schlüssel mit Socket an allen Stellen aus §5; Liste je Socket,
  ein Fehler des einen schließt keine Kachel des anderen; Arbeitsplatz hin und
  zurück, und eine fremde Kachel ist für die Form von 0.2.x ungültig; kein
  Knopf zum Beenden; Neuladen der Liste bei neuer Session-ID, höchstens alle
  10 s.
- **Live:** gegen die Test-VMs mit einem Testsocket anstelle von `default`
  (§6.1): Liste, Status, Öffnen mit `-E`, Schließen, keine Änderung an
  Optionen, Umgebung und Hooks, kein Server bei fehlendem Server.
- **Am Fenster (Tor §1):** Der Maintainer startet auf einer VM von Hand
  `tmux new -s hand` und darin einen Agent; ein zweites Mal startet er eine
  Session, während die App läuft. Geprüft werden Punkt 1 bis 5 von §1 mit den
  Vergleichen aus Punkt 4. Der echte Standard-Socket wird nur hier und nur mit
  diesen Sessions berührt.

## 9. Lieferschritte

| Schritt | Inhalt | d |
| --- | --- | --- |
| 1 | Messung: Abfrage mit zweitem Inventar unter Last (Werkzeuge vom 21.10.), Wächter mit `-E` auf 3.3a/3.4/3.6 neu gemessen | 0,5 |
| 2 | `TmuxSocket`/`OwnSocket` durch Client, Inventar, Bindung, Verlauf, Titel, Anhängen; Tests der Bauer | 1 |
| 3 | Liste und Abfrage je Socket, Sitzungsgruppen, Bestätigung, Terminalbefehle und Kill mit Socket; Backend-Tests | 1,5 |
| 4 | Frontend: `Session.socket`, Schlüssel, Liste und Frische je Socket, Neuladen, Arbeitsplatz | 1,5 |
| 5 | Seitenleiste, Kennzeichen, Texte, README | 0,5 |
| 6 | Live-Test, Lauf am Fenster, Doku | 0,5 |
| **Zusammen** | | **5,5** |

Die Roadmap rechnete 3,5 d unter der Annahme, der Socket stehe schon an jeder
Session (S1.6); das ist nicht so.

## 10. Entscheidungen vor dem Plan

1. **Schalter je Host:** „tmux sessions anzeigen“, Vorgabe an. Vorschlag: ja,
   weil das Anhängen Fenstergröße und Hooks des Nutzers berührt (§4) und ein
   Host den Standard-Socket mit vielen Werkzeugen teilen kann.
2. **Hinweis zur Fenstergröße:** Vorschlag: einmaliger, schließbarer Satz beim
   ersten Öffnen einer fremden Kachel, dazu README.
3. **`TMUX_TMPDIR`:** Setzt der Nutzer es nur in einer interaktiven
   Startdatei, sucht die App an anderer Stelle und zeigt eine leere Gruppe.
   Vorschlag für M3.1: Satz im README; ein Hinweis aus `/proc/net/unix`
   (lauschende tmux-Sockets anderswo) gehört in die Diagnose (M3, S3.2).

## 11. Kritikrunde vom 25.10.

Zwei Widerleger, getrennt nach tmux-Verhalten und Einbau in den Code, gegen
den Entwurf vom selben Tag. Ihre Befunde und was daraus wurde:

| Befund | Ergebnis |
| --- | --- |
| Anhängen per Name startet einen fehlenden Server samt `~/.tmux.conf` | bestätigt am 25.10. auf beiden VMs; Anhängen nur über den Wächter, ohne Bindung nur zeigen (§3, §6.4) |
| Anhängen ändert die Umgebung der Session (`update-environment`) | `attach-session -E`, Tor um `show-environment` ergänzt (§1, §4) |
| `window-size` ist unter 3.0 `smallest`, ab 3.1 `latest`, und schon Öffnen und Größe ändern übernehmen das Fenster | §4 je Version |
| Ohne `-L` gilt zuerst `$TMUX`; Tests liefen nie die Form des Produkts | `-L default` (§6.1) |
| Unter 3.0 lässt sich ein fehlender Server nicht beweisen; die Version des Servers kann von der des Clients abweichen | 3.0: Gruppe leer mit Hinweis; Version aus `#{version}` (§6.2) |
| Hooks des Nutzers, `destroy-unattached` | §4, Tor §1 Nr. 2 und 4 |
| Fremde Clients lassen die Bestätigung scheitern; Sitzungsgruppen brechen das Inventar ab | §6.2 |
| Von Hand gestartete Sessions erscheinen nie, weil die Abfrage keine Sessions hinzufügt | Neuladen bei neuer Session-ID (§6.3) |
| Kein Server lässt jede Abfrage scheitern und macht alle Sessions des Hosts veraltet | Ergebnis und Frische je Socket (§6.3) |
| Das Frontend führt eine Liste je Host; ein Fehler des Standard-Sockets schlösse fremde Kacheln | Liste je Socket (§7) |
| Terminalbefehle und Kill nehmen keinen Socket; Kill macht den Eintrag vor der Ablehnung ungültig | §5, §6.5 |
| Statuslatenz liegt unter Last schon nahe 4 s | Messung als Schritt 1, Rückfall jede zweite Abfrage (§6.3, §9) |
| Rückweg: `tiles_version` 3 schützt nicht, 0.2.x schreibt fremde Kacheln als eigene zurück | für 0.2.x ungültige Form (§5) |
| Sessionzeilen haben kein Menü, ein ausgegrauter Knopf hat keinen Tooltip; im schmalen Kopf fehlte das Kennzeichen | §7 |
| Schätzung 3,5 d zu niedrig | 5,5 d (§9) |
