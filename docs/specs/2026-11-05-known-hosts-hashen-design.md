# Gehashte Einträge in `known_hosts` schreiben: Entscheidung

Stand 2026-11-05, nach 0.2.7. Herkunft: Code-Review vom 03.11.
([Stand](../stand.md), Punkt 13). Entscheidung des Maintainers vom 05.11.:
**zurückgestellt**. Diese Notiz hält fest, warum, welche Wege es gibt und was
eine spätere Umsetzung einhalten muss. Verweise nennen Funktionen statt
Zeilen; gemeint ist `main` nach `v0.2.7`.

## 1. Worum es geht

`known_hosts` ordnet jedem Host seinen Hostschlüssel zu. Mit
`HashKnownHosts yes` in der `ssh_config` schreibt OpenSSH den Namen nicht im
Klartext, sondern als `|1|<Salz>|<Hash>`:

- Das Salz sind 20 Zufallsbytes, jede Zeile hat ihr eigenes.
- Der Hash ist HMAC-SHA1 mit dem Salz als Schlüssel über den klein
  geschriebenen Namen, und zwar `host` für Port 22, sonst `[host]:port`.
- Beide stehen Base64-kodiert in der Zeile.

Wer die Datei liest, etwa Schadsoftware oder ein geleaktes Backup, sieht damit
nicht direkt, mit welchen Hosts der Nutzer arbeitet. Das richtet sich gegen
SSH-Würmer, die `known_hosts` als Liste ihrer nächsten Ziele lesen.

Raten bleibt möglich: Eine Liste vermuteter Namen oder der ganze
IPv4-Adressraum lässt sich gegen jede Zeile durchprobieren. Hostnamen schützt
das Hashen gut, IP-Adressen kaum.

## 2. Verhalten der App (0.2.7)

- **Lesen:** `host_field_matches` und `hashed_name_matches` in
  `src-tauri/src/ssh/known_hosts.rs` werten gehashte Einträge aus wie
  OpenSSH. Ein gehashter Eintrag zählt wie ein Klartexteintrag. Steht dahinter
  ein anderer Schlüssel desselben Typs, ist das ein Schlüsselwechsel und wird
  abgewiesen. Die Tests sind gegen `ssh-keygen -F` gegengeprüft.
- **Schreiben:** Nach der Bestätigung beim Erstkontakt hängt `append_entry`
  die Zeile aus `format_entry` an, mit dem Namen im Klartext. Das gilt auch
  bei `HashKnownHosts yes`. Bestehende Zeilen fasst die App nie an.
- **Folge:** Bei einem Nutzer mit `HashKnownHosts yes` steht jeder Host, den
  er in der App bestätigt, lesbar in der Datei; die übrigen Einträge bleiben
  gehasht. OpenSSH liest die Zeile ohne Probleme.
- **Abhilfe:** `ssh-keygen -H` hasht die Datei nachträglich. Es legt die alte
  Fassung mit Klartextnamen als `known_hosts.old` ab, die man löschen sollte.
  Das steht in der [Grenzen-Anleitung](../guide/limits.md) und in
  [PRIVACY.md](../../PRIVACY.md).

Ein Sicherheitsloch ist das nicht: Die Prüfung des Hostschlüssels hängt nicht
davon ab, ob der Name gehasht oder im Klartext steht.

## 3. Warum das Schreiben nicht klein ist

Das Rechnen ist klein. HMAC-SHA1 und Base64 hat die App fürs Lesen schon, dazu
kämen 20 Bytes aus dem Zufallsgenerator des Systems.

Schwierig ist die Frage, **ob** gehasht werden soll. OpenSSH entscheidet das
je Verbindung aus der `ssh_config`:

- `Host`-Blöcke mit Mustern (`*`, `?`) und Negation (`!`),
- `Match`-Blöcke mit Bedingungen, bis hin zu `Match exec`, das einen Befehl
  ausführt,
- `Include`, auch mit Mustern im Dateinamen,
- die systemweite Datei (Windows `%PROGRAMDATA%\ssh\ssh_config`, macOS
  `/etc/ssh/ssh_config`),
- der erste gefundene Wert gilt.

Der Parser des Imports, `src-tauri/src/ssh/config_parser.rs`, liest bewusst
nur `Host`, `HostName`, `User`, `Port` und `IdentityFile`. Muster, `Match`
und `Include` lässt er aus. Eine Auswertung, die von OpenSSH abweicht, würde
mal gehasht schreiben und mal nicht, ohne dass der Nutzer nachvollziehen
kann, warum.

## 4. Wen es betrifft

- **OpenSSH:** Der Standard ist `no`. OpenSSH for Windows und macOS liefern
  es so aus.
- **Debian und Ubuntu:** Sie setzen `HashKnownHosts yes` in ihrer
  `/etc/ssh/ssh_config`. Linux ist aber keine Zielplattform der App, und WSL
  hat ein eigenes `~/.ssh`, getrennt vom Windows-Heimatverzeichnis.
- **Android:** `known_hosts` liegt im privaten Datenordner der App
  (`paths.rs`), den andere Apps nicht lesen können, und eine `ssh_config`
  gibt es dort nicht.

Betroffen ist damit nur, wer die Option unter Windows oder macOS selbst
gesetzt hat.

## 5. Wege

| Weg | Aufwand | Dafür | Dagegen |
|---|---|---|---|
| 1. So lassen | keiner | Abhilfe `ssh-keygen -H` ist dokumentiert, Lesen geht | der bestätigte Host steht im Klartext, bis der Nutzer nachhasht |
| 2. Eigene Einstellung „Neue Einträge in `known_hosts` hashen“ | klein: Einstellung, Schreibweg, Tests | vorhersehbar, keine Auswertung der `ssh_config` | eine zweite Stelle neben `HashKnownHosts`, die der Nutzer kennen muss |
| 3. Gehasht schreiben, wenn die Datei schon gehashte Einträge hat | klein | trifft die typischen Nutzer ohne neue Einstellung | geraten: ein einziger alter gehashter Eintrag schaltet um |
| 4. `HashKnownHosts` wie OpenSSH auswerten | groß, mit dauerhafter Pflege | das einzig genaue Verhalten | ein fast vollständiger `ssh_config`-Auswerter; `Match exec` führt Befehle des Nutzers aus |
| 5. Immer gehasht schreiben | klein | kein Klartext mehr | Nutzer ohne die Option bekommen unlesbare Zeilen, die sie nicht wollten; die Datei lässt sich nicht mehr lesen oder mit `grep` durchsuchen |

## 6. Entscheidung

Am 05.11.2026 hat der Maintainer entschieden, Weg 1 zu nehmen: zurückgestellt.
Auf den Zielplattformen betrifft das nur, wer die Option selbst setzt. Die
Abhilfe ist dokumentiert, und gehashte Einträge lesen kann die App.

Das Thema wird wieder aufgenommen, wenn

- ein Nutzer es meldet,
- Linux Zielplattform wird oder
- die App ohnehin eine vollständigere `ssh_config`-Auswertung bekommt, etwa
  für `ProxyJump` oder `Include`.

Dann kommen Weg 2 oder 3 vor Weg 4 in Frage. Weg 5 nicht.

## 7. Was eine Umsetzung einhalten muss

- **Format wie OpenSSH** (`hostfile.c`, `host_hash`): `|1|`, dann
  Base64(Salz), `|`, Base64(HMAC-SHA1 über das klein geschriebene Token).
  - Das Salz hat 20 Bytes aus dem Zufallsgenerator des Systems.
  - Das Token kommt aus `host_token`.
  - Je Name eine Zeile, keine Kommaliste.
- **Nur anhängen:** Der Schreibweg bleibt `append_entry`; bestehende Zeilen
  werden nie umgeschrieben.
- **Gegenprobe:** Jede geschriebene Zeile wird mit
  `ssh-keygen -F <host> -f <datei>` geprüft, wie bei den Lesetests.
- **Doku:** Die Grenzen-Anleitung und `PRIVACY.md` werden angepasst, diese
  Notiz bekommt einen Nachtrag, und `stand.md` Punkt 13 wird geschlossen.
