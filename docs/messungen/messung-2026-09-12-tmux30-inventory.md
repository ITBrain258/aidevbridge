# Numerisches Inventar auf tmux 3.0: tatsächlicher Versionsnachweis

Der begrenzte Inventar-/Identitätsnachweis liegt jetzt auch für **echtes tmux
3.0** auf dem ersten Testhost vor. Ein notwendiger Versionsunterschied wurde
gemessen und eng behandelt: `display-message` braucht unter 3.0 auch für reine
Servermetadaten ein Pane-Ziel. Der bisherige 3.4-Verbund scheitert daher auf
einem lebenden leeren 3.0-Server. Eine ausschließlich für 3.0 gewählte, lesende
Metadatenabfrage liefert anschließend denselben ID-/Zahlenvertrag, ohne einen
abwesenden Server zu starten. Die [bestehende 3.4-Messung](messung-2026-09-12-tmux-inventory.md)
und ihre historischen Hashes bleiben unverändert.

## Privater Build und Herkunft

Auf dem autorisierten `u@192.0.2.20` waren GCC 13.3.0, GNU Make 4.3,
libc6-dev, tar, gzip und dpkg-deb vorhanden. libevent-/ncurses-Runtimebibliotheken
waren installiert, deren Entwicklungsheader und Linkerdateien jedoch nicht.
pkg-config, Autoconf/Automake und yacc/bison fehlten. Es wurde nichts global
installiert, kein PATH verändert und kein vorhandenes tmux ersetzt.

Der [begrenzte Buildhelfer](fixtures/m1-tmux-inventory/2026-09-12-tmux30-build.py)
erzeugte ausschließlich den neuen privaten Ordner
`/tmp/ab-m1-tmux30-750da61084954578aa6da31a136b1923` mit Modus 0700,
UID 1000, Device 2050 und Inode 7082065. Die drei festen Downloads stammen von
offiziellen Quellen; Paketgrößen und Ubuntu-Pakethashes wurden vorher aus dem
vorhandenen APT-Metadatenbestand gelesen und anschließend exakt verglichen.

| Quelle | Bytes | Tatsächlicher SHA-256 |
|---|---:|---|
| [Offizielles tmux-3.0-Releaseasset](https://github.com/tmux/tmux/releases/download/3.0/tmux-3.0.tar.gz) | 546099 | `9edcd78df80962ee2e6471a8f647602be5ded62bb41c574172bb3dc3d0b9b4b4` |
| [Ubuntu libevent-dev 2.1.12-stable-9ubuntu2.1, amd64](https://archive.ubuntu.com/ubuntu/pool/main/libe/libevent/libevent-dev_2.1.12-stable-9ubuntu2.1_amd64.deb) | 274094 | `6576bd85cdf314da2cc14a9f7a8797c2f6a0ee6864c784eda14a783f96c6716c` |
| [Ubuntu libncurses-dev 6.4+20240113-1ubuntu2.2, amd64](https://archive.ubuntu.com/ubuntu/pool/main/n/ncurses/libncurses-dev_6.4+20240113-1ubuntu2.2_amd64.deb) | 384098 | `2c32ce182e90e6636ddb037ba2810cace9e1f076b13fac89034277d8ba943c38` |

Die [Release-API](https://api.github.com/repos/tmux/tmux/releases/tags/3.0)
nennt Asset 16408402, aber keinen offiziellen SHA-Digest. Der tmux-Archivhash
oben ist daher der tatsächlich empfangene und dokumentierte Inhalt, keine
erfundene Herstellersignatur. Die HTTPS-Weiterleitung endete auf
`release-assets.githubusercontent.com`.

Der Git-Tag `3.0` zeigt auf `c22470bd14ba1cdc523e0bfbb0180c75a9db1819`, dessen
`configure.ac` noch `3.0-rc3` nennt. Deshalb wurde das eigenständige Releaseasset
verwendet. Dessen mitgeliefertes `configure` enthält tatsächlich
`PACKAGE_VERSION='3.0'`; `cmd-parse.c` ist ebenfalls vorhanden. Der Build braucht
damit keine nachträgliche Autotools-/Parserinstallation.

Vor Extraktion wurden alle Archivpfade, Dateitypen, Linkziele und Größen geprüft;
die anschließende Extraktion verwendet zusätzlich den schützenden Tar-Datenfilter.
192 tmux-, 74 libevent-dev- und 93 ncurses-dev-Einträge blieben innerhalb des
eigenen Präfixes. Paketentpacken mit `dpkg-deb --fsys-tarfile` führt keine
Installationsskripte aus. Private Include-Pfade und statische Entwicklungsarchive
ersetzen globale Header-/Linkeränderungen. Auch `--prefix` und `--sysconfdir`
verweisen auf unbenutzte Pfade innerhalb des eigenen Ordners; `make install`
wurde nicht aufgerufen.

`configure` und `make -j 2` endeten mit Exit 0 nach 4,767 bzw. 9,736 Sekunden.
Der unveränderte historische Quellcode erzeugt unter GCC 13 sechs Warnungen über
ignorierte Rückgabewerte; kein warnungsfreier Build wird behauptet. Ein Vergleich
nach dem Build bestätigt **alle 192 archivierten Dateien bytegleich** mit dem
Releasearchiv. Es gab keinen Quellpatch oder Versionsstringeingriff.

Das gebaute Binary war 1140432 Bytes groß, SHA-256
`fc5ca5065dbb83b1138110764d7a96fd8130ddb94473f695f1718340b470c550`.
Sein tatsächlicher Versionsaufruf lieferte Exit 0 und exakt `tmux 3.0\n`.
Es war ein temporäres Linux-Testbinary und ist nach der Messung wieder entfernt.

## Gegenfall und begrenzte Abfragekorrektur

Der [erste 3.0-Lauf](fixtures/m1-tmux-inventory/2026-09-12-tmux-3.0-initial.jsonl)
endete mit **Exit 1**. Drei NoServer-Abfragen waren erfolgreich klassifiziert;
anschließend waren der eigene Server und `exit-empty off` nachgewiesen.
Sowohl unbedingtes `list-panes` als auch der bisherige Gesamtverbund lieferten
auf diesem leeren Server Exit 1, stdout leer und `no current target\n`.
Die erste `display-message`-Anweisung scheiterte bereits vor der B-Zeile.
Dieser Fehler wurde weder zu NoServer noch zu einem leeren Snapshot umgedeutet.

Die 3.0-Quellen bestätigen den Unterschied: `display-message` fordert ein
Pane-Ziel, während `list-commands -F` ohne Ziel Formate expandieren kann.
**Ein direktes `list-commands` wäre als Poll ungeeignet**, weil sein
`CMD_STARTSERVER` einen Server starten kann. Der verwendete Ersatz kapselt es
deshalb in ein konstantes äußeres `if-shell -F 1`:

```sh
if-shell -F 1 \
  "list-commands -F '#{?#{==:#{command_list_name},display-message},B|#{pid}|#{start_time},}'"
```

Analog wird die E-Zeile erzeugt. Die Formatbedingung wählt genau einen
eingebauten Kommandonamen; dieser Name selbst wird nicht ausgegeben. Q-Zeilen,
bedingtes `list-panes`, numerische P-Zeilen und Parser bleiben unverändert.
Die tatsächliche vollständige argv-Liste steht in der Finalfixture.

Der äußere Clientverbund enthält nur `if-shell` und `list-sessions`, die keinen
Startserver anfordern. Erst der bereits erreichte Server parst das innere
konstante Kommando. Die Queue hält B vor Q/P und E dahinter. Dies wurde vor der
Ausführung eng und unabhängig gegen die betreffenden Primärquellen geprüft:
[Client](https://raw.githubusercontent.com/tmux/tmux/3.0/client.c),
[if-shell](https://raw.githubusercontent.com/tmux/tmux/3.0/cmd-if-shell.c),
[list-commands](https://raw.githubusercontent.com/tmux/tmux/3.0/cmd-list-keys.c),
[Formate](https://raw.githubusercontent.com/tmux/tmux/3.0/format.c).
Der Nichtstart wird zusätzlich durch die tatsächlichen Abwesenheitsproben unten
belegt. Es gibt keinen externen Shelltest und keine eingefügte freie Metadatenquelle.

## Finaler Messlauf

Der [finale Lauf](fixtures/m1-tmux-inventory/2026-09-12-tmux-3.0.jsonl) begann
am **2026-09-12 um 08:18:07.229 UTC** mit dem Versionsaufruf; die abschließende
NoServer-Abfrage begann um **08:18:10.037 UTC**. SSH verwendete erneut
`BatchMode=yes`, `StrictHostKeyChecking=yes`, `ConnectTimeout=8`.
Helfer-/SSH-Exit **0**, 56 Socket-Kommandos mit vollständigem EOF und tatsächlichem
Exitstatus, zusätzlich der Versionsaufruf; **20 vollständige Snapshots**.

| Fall | Tatsächliches Ergebnis |
|---|---|
| Abwesender Socket, dreimal | Exit 1, stdout leer, exakt `error connecting to <eigener Socket> (No such file or directory)\n`; Pfad bleibt abwesend, ECHILD, null neu adoptierte Kinder |
| Lebender leerer Server, dreimal | Ersatzverbund: Exit 0, stderr leer, exakt B/E mit `(2314035,1789201087)`, keine Q-/P-Zeilen |
| Gleichnamiger Ersatz, dreimal | Serverpaar bleibt; `$0/@0/%0` wechselt über `$1/@1/%1`, `$2/@2/%2` zu `$3/@3/%3`; Pane-Start-PIDs wechseln ebenfalls |
| Pane-Respawn, dreimal | `$3/@3/%3` bleibt; PID wechselt von 2314054 über 2314057 und 2314060 zu 2314063 |
| Zwei Panes | Zwei getrennte P-Zeilen, korrekte Panezahl, genau ein aktiver Pane |
| Freie Metadaten ausgelassen | Separator-Titel und LF-/TAB-haltige eigene Option werden exakt rückgelesen; Inventar bleibt davon unbeeinflusst |
| Fehler im Verbund | B-Zeile vor gezielt ungültigem Pane; Exit 1 mit `can't find pane: %999999999\n`, E fehlt. Fehler, kein leerer Snapshot |
| Inertes Socket, dreimal | Exit 1, stdout leer, exakt `no server running on <eigener Socket>\n`; ECHILD, null neu adoptierte Kinder |
| Serverneustart, dreimal | Neue Paare `(2314085,1789201088)`, `(2314132,1789201089)`, `(2314143,1789201090)`; jeweils neue PID **und** Startzeit; Objekt-IDs starten wieder bei `$0/@0/%0` |

Die vier aufgezeichneten Socketgenerationen verwendeten tatsächlich denselben
Dateiinode 7104308 wieder. Der Generationennachweis stammt aus PID und Startzeit,
nicht aus einem behaupteten neuen Socketinode. `start_time` bleibt sekundengenau
und keine Boot-ID; Wiederverwendung nach unbeobachteter Trennung ist damit nicht
allgemein ausgeschlossen.

Beim Control-Titel besteht ein weiterer tatsächlicher Versionsunterschied:
3.0 gibt `alpha\\nbeta\\rgamma\\tdelta\n` in JSON-Schreibweise aus, während 3.4
den vorherigen Separator-Titel beibehalten hatte. Dies belegt weder rohe
Titelbytes noch einen reversiblen Codec. Die eigene Option liefert dagegen
in beiden Messungen die tatsächlich enthaltenen LF-/TAB-Zeichen. Alle freien
Werte bleiben weiterhin außerhalb des Inventarteils.

Die lokalen Snapshotkommandos dauerten 1,913–2,930 ms. Binaryhashprüfung vor dem
Aufruf, SSH, vollständiger Poll, Last und UI sind darin nicht enthalten.
Parallel waren andere ausdrücklich isolierte Quellenmessungen des Root-Agenten
möglich. Diese Zahlen sind kein isolierter Last- oder Maximallatenznachweis.

## Helferprüfungen und Besitz

Der Inventarhelfer verlangt für ein alternatives Binary zusammen einen absoluten
Pfad, erwartete Version aus `3.0/3.4` und SHA-256. Ein Hashfehler wird vor der
Probeordneranlage abgewiesen; Version und spätere Aufrufe verwenden denselben
gepinnten Pfad. Der unveränderte Default bleibt `/usr/bin/tmux`, erwartet 3.4
und verwendet weiterhin dessen ursprünglichen Verbund.

Acht gezielte Auswahl-/Hashgegenfälle und die 22 bestehenden Parsergegenfälle
bestanden. Der finale 3.0-Lauf enthält die 22 Parserfälle erneut. Fehlender
Exit/EOF, Frist-/Limitmarkierung, unbekannte Diagnose und freie Zeilen bleiben
synthetische Parserfälle, keine tatsächlich ausgelösten SSH-/Outputlimitfehler.

Der unabhängige Helferreview schloss notwendige neue Pfad-/Pin-/Klassifikations-
befunde aus. Der spätere 3.0-Querydelta erhielt vor dem tatsächlichen Folgelauf
einen eigenen engen Review. Der Inhaltspin ist keine atomare stat/read/exec-
Austauschabwehr. Würde das Binary nach Serverstart verschwinden oder wechseln,
verweigert auch Cleanup weitere tmux-Aufrufe; der eigene Prozessfallback bleibt,
aber ein Verzeichnis kann dann ausdrücklich als nicht vollständig bereinigt
zurückbleiben. Dieser ungemessene Fehlerfall wird nicht als vollständig bestanden
ausgegeben.

Im Buildhelfer wurden zwei bestätigte Grenzen vor der echten Ausführung behoben:
Netzwerk-Timeouts begrenzen nicht automatisch DNS/Header/Chunk-Framing; deshalb
läuft jeder Download in einem eigenen Prozess mit 60-s-Parentfrist. Ein schnell
beendeter Logüberlauf wird jetzt auch nach Exit geprüft. Passende echte
synthetische Gegenfälle bestehen: 6 MiB Ausgabe mit Exit 0 werden als
`output_limit` verworfen, ein eigener schlafender Unterprozess wird nach rund
103 ms Parentfrist beendet und geerntet. Kein echter Netzwerk-Timeout wurde
erzeugt. Die Ausführungsfristen haben gesondertes begrenztes Prozesscleanup;
keine harte Gesamtfrist aller Buildschritte wird behauptet.

## Export und abschließende Bereinigung

Die vollständigen configure-/make-/Versionslogs sind komprimiert exportiert und
ihre ursprünglichen Hashes geprüft. Beide Inventarläufe und der Build endeten,
bevor der Buildordner entfernt wurde. Alle final gemessenen 15 Prozessidentitäten
waren beendet; beide Inventarsockets und -ordner bereits abwesend. Der initiale
Fehlversuch brauchte einen ausdrücklich eigenen, per Child-/PIDfd-Besitz
abgesicherten Fallback gegen PID 2308061. Der finale Lauf und der Build brauchten
keine solchen Fallbacksignale.

Die [abschließende Prüfung](fixtures/m1-tmux-inventory/2026-09-12-tmux30-final-cleanup.jsonl)
verifizierte den exakten Buildpfad, Device/Inode/UID, Modus, Besitzmarker,
Binaryhash, beendete Prozessidentitäten und exportierte Logs vor dessen
symlinkgeschützter Entfernung. Danach sind alle vier eigenen Ressourcenordner
abwesend: Build, Buildgegenprobe sowie initialer und finaler Inventarlauf.
Es existierte kein zusätzlicher Transferordner; Helfer kamen über SSH-stdin.
`/usr/bin/tmux` liefert weiterhin `tmux 3.4\n` und unverändert SHA-256
`034b15c64035f783d43862f2775eb4828f61571ca62c8199796000b97d556ecd`.
Keine fremden Sockets, Prozesse oder Konfigurationen wurden verändert.

| Beleg | SHA-256 |
|---|---|
| [Finaler Inventarhelfer](../../scripts/m1-tmux-inventory.py) | `58c5b8bcdbabec046297539e7c6ddfe52688a06085157710b1bb491a0f9827b6` |
| [Ausgeführter Buildhelfer](fixtures/m1-tmux-inventory/2026-09-12-tmux30-build.py) | `abb1fc8fdd8aaaf58a85b86b3f3e59dde984dfc0a82ed0652dc5238aef81031b` |
| [Binaryauswahl-Gegenfälle](fixtures/m1-tmux-inventory/2026-09-12-binary-selection-selftest.jsonl) | `5bb12eba3851e2f20f582c62211682b08b1b1ddb0dfbfec1ea04c9777324c2ca` |
| [Buildgrenzen-Gegenfälle](fixtures/m1-tmux-inventory/2026-09-12-tmux30-build-selftest.jsonl) | `d0a5c8efb63abaf56b32a586a5a07dd3df36d807209e48c027f6203f1b732237` |
| [Buildreport](fixtures/m1-tmux-inventory/2026-09-12-tmux30-build.jsonl) | `de65bd89ed5cc0aa4c8f45c31945b787da902b2171a0f4617007a54b6f5e4091` |
| [Vollständige Buildlogs](fixtures/m1-tmux-inventory/2026-09-12-tmux30-build-logs.json.gz) | `7541e18913002f138dee9d155bb3b1e52838d1a5ee515c2b02c5e9ce4b874a8e` |
| [Quellvergleich und Export](fixtures/m1-tmux-inventory/2026-09-12-tmux30-build-export.json) | `80e3b4fb6d7d111e5a5dff4a0376e81e501a4614dc2bbd58c436f803d7fbc387` |
| [Initialer 3.0-Gegenfall](fixtures/m1-tmux-inventory/2026-09-12-tmux-3.0-initial.jsonl) | `4bcc33bb0ca489e604f75a93ea4bd086dcd902651dad1c64014899dd9e44042e` |
| [Finale 3.0-Matrix](fixtures/m1-tmux-inventory/2026-09-12-tmux-3.0.jsonl) | `a10274f419769fdf858db1db6e9093b46ad98f38d0bbfbf984ba7c05cd2fdcbb` |
| [Abschließendes Cleanup](fixtures/m1-tmux-inventory/2026-09-12-tmux30-final-cleanup.jsonl) | `513ed8da04ff71e437808ebf4a0f89cf7707d15ec3684af41c347b1e02f561af` |

Die `.jsonl.exit`-Dateien erhalten tatsächliche Exitcodes 0/1/0 für Build,
initiale und finale Matrix. Auswahlgegenfälle und initialer 3.0-Lauf verwendeten
den vor dem Querydelta geprüften Helferhash
`37c7414edb994d76f399b74248c117c9d6adec8cde3ca61c42d0efa067c46aec`.
Diese historischen Nachweise werden nicht auf den späteren Hash umgeschrieben.

Ein abschließender unabhängiger Evidenz- und Textreview bestätigt Zählungen,
rohe B/E-/Q-/P-Rahmen, Exitcodes, Log-/Fixturehashes, Versionsantworten,
Identitätswechsel und Cleanup ohne notwendigen Befund. Der Vergleich der 192
Archivdateien bleibt der dokumentierte eigene Exportvergleich; der Reviewer hat
diese inzwischen entfernten Dateien nicht erneut eingelesen. Keine weitere
Messung oder Gesamtprüfung wurde für diesen Abschluss gestartet.

Die Ergebnisse schließen den begrenzten numerischen Inventar-/Identitätsfall
für die beiden tatsächlich gemessenen Versionen auf diesem Host. Offen bleiben
sichere Zuordnung zur namensbasierten Produktliste, Produktionsparser/Integration,
freie Metadaten und deren Codec, fremde/verlinkte Topologien, Last-/Transport-/
Windows-/Zweithostfälle sowie Agentenquellen und die restliche M1.0-Matrix.
Kein Statusadapter oder veröffentlichbarer Release wird dadurch erklärt.
