# Erster R/C-Bindungslauf: tmux 3.4, negativer Sondernamenfall

Der erste echte R/C-Lauf endete korrekt mit **Exit 1** und
`punctuation_not_bound`. Die beobachtete Sondernamens-Session war weiterhin
vorhanden; ihre fehlgeschlagene Namensauflösung ist kein Abwesenheitsbeleg.
Die spätere L/ID-Folgeprobe
hat inzwischen bestanden; die Produktintegration bleibt offen.

## Originale und geprüfte Archivbindung

Ausführung durch Root auf dem autorisierten `u@192.0.2.20`, 12.09.2026.
Die Originale liegen unter
`C:\Users\U\AppData\Local\Temp\agentbridge-session-binding-20260912-r99ebc7f8cd25`.
Der unabhängige Dokumentationslauf hat alle **20 Einträge** des originalen
[Manifests](fixtures/m1-session-binding/2026-09-12-initial-tmux34/artifact-manifest.json)
gegen tatsächliche Bytezahl und SHA-256 geprüft und anschließend bytegleich
in den neuen Fixtureordner kopiert. Für die Veröffentlichung sind in den vier
Invocation-JSONs und in `invoke-stage.ps1` SSH-Ziel und lokaler Quellpfad durch
`u@192.0.2.20` und `C:\Users\U\…` ersetzt; das Manifest nennt für diese fünf
Dateien die neuen Bytezahlen und Hashes, die übrigen 15 Einträge sind
unverändert. Das Manifest hat danach 3134 Bytes, SHA
`9631ff7ff36e7b69cd55f2f75fe4683545d7e41468e79a75ddd8309f2d279f4e`.
Eine zusätzliche lokale `.gitattributes` mit `* -text` verhindert, dass Git die
archivierten Originalbytes beim Einchecken normalisiert; sie ist kein Eintrag
des historischen Manifests. Die vier Invocation-JSONs sowie Originalmanifest
und Ausführungszusammenfassung sind mit CRLF gespeichert und erhalten
ausschließlich `whitespace=cr-at-eol`.

Mitkopiert sind die tatsächliche
[Orchestrierungsquelle](fixtures/m1-session-binding/2026-09-12-initial-tmux34/invoke-stage.ps1),
alle vier Invocation-/Exit-/stderr-Dateisätze, die
[Abwesenheitsprüfung](fixtures/m1-session-binding/2026-09-12-initial-tmux34/verify-tmux34-absence.py)
und der tatsächlich ausgeführte
[Probehelfer](fixtures/m1-session-binding/2026-09-12-initial-tmux34/m1-tmux-inventory.py)
mit SHA `e7701fc8c14757557cbd619f5077fea82642838aeb080eddfde065ffcca44454`.
Spätere Änderungen an `scripts/m1-tmux-inventory.py` gehören nicht zu diesem Lauf.

| Originalausgabe | Tatsächliches Ergebnis | SSH-Exit / stderr-Bytes |
|---|---|---|
| [Bindungsselbsttest](fixtures/m1-session-binding/2026-09-12-initial-tmux34/binding-selftest.jsonl) | 30/30 bestanden | 0 / 0 |
| [Inventarparser-Selbsttest](fixtures/m1-session-binding/2026-09-12-initial-tmux34/parser-selftest.jsonl) | 22/22 bestanden | 0 / 0 |
| [tmux-3.4-Lauf](fixtures/m1-session-binding/2026-09-12-initial-tmux34/binding-tmux34.jsonl) | `punctuation_not_bound`, Reihe unvollständig | 1 / 0 |
| [Separate Abwesenheitskontrolle](fixtures/m1-session-binding/2026-09-12-initial-tmux34/binding-tmux34-absence.jsonl) | alle acht Pfade abwesend | 0 / 0 |

Leeres äußeres SSH-stderr bedeutet hier nicht, dass alle inneren tmux-Aufrufe
erfolgreich waren: deren tatsächliche Fehler stehen in den einzelnen
Commandobjekten der JSONL-Ausgabe. Die
[Ausführungszusammenfassung](fixtures/m1-session-binding/2026-09-12-initial-tmux34/execution-summary.json)
nennt keine offenen Toolhandles; die Orchestrierung wartet auf SSH-Ende sowie
beide Ausgabekopien und schreibt anschließend den tatsächlichen Exitstatus.

## Tatsächlich erreichter Teilumfang

`/usr/bin/tmux` lieferte exakt `tmux 3.4\n`, Exit 0. Der tatsächlich gelesene
Binaryhash ist `034b15c64035f783d43862f2775eb4828f61571ca62c8199796000b97d556ecd`;
`expected_sha256` ist in diesem Systembinary-Lauf ausdrücklich `null`.
Die neue eigene Root war
`/tmp/ab-m1-inventory-83adb3e7bddf4034b6d5b692f4a019f0`.

Der Lauf enthält 42 benannte Mess-/Cleanup-Kommandos sowie den gesonderten
Versionsaufruf. Er erreichte den anfangs abwesenden Socket, den lebenden leeren
Server und den fehlenden exakten Namen `dev` neben `dev2`. Danach gelangen fünf
R/Inventar/R-Bindungsbeobachtungen für vier Sessioninstanzen:
`prefix_anchor`, `prefix_unchanged`, `normal`, `unicode` und `spaces`.
Die letzte Beobachtung bewahrte die Randspaces des gelisteten Namens.

Die fünfte Anlage C erzeugte Session `$4`, Window `@4`, Pane `%4`,
Pane-PID 2681509 auf Server `(2681451, 1789222822)`. Der angeforderte Name
enthielt Dollar/Backslash/Separator. Die anschließende Liste enthielt zwei
Backslashes vor dem Dollar und zwei vor `slash`. Beide R-Abfragen mit diesem
unverändert gelisteten Wert lieferten Exit 1 und `can't find session`.
Das vollständige numerische Inventar dazwischen enthielt `$4` und `%4`
weiterhin. Das Ergebnis blieb daher **Unverified**.

Nicht erreicht wurden die Dublettenanlage, die Zwei-Window-/Drei-Pane-Auswahl
und die jeweils drei Ersatz-/Rename-Wiederholungen. Kein tmux-3.0-Build oder
3.0-R/C-Lauf wurde in diesem Auftrag begonnen; der Fehler wurde nicht mit
spontaner Escape-Reparatur oder einer Wiederholung verdeckt.

## Cleanup und nächste begrenzte Entscheidung

Der eigene Server wurde über seinen gebundenen Socket beendet. Der
Cleanup-Datensatz meldet `echild=true`, alle gemessenen Prozesse beendet,
Socket abwesend, Export vor Entfernung und Root entfernt; die Liste eigener
PID-Signalierungseskalationen ist leer. Die gesonderte Prüfung bestätigt danach
Root und Socket sowie `/proc/2681451`, `/proc/2681457`, `/proc/2681483`,
`/proc/2681491`, `/proc/2681501` und `/proc/2681509` jeweils tatsächlich abwesend.
Das sind der Server und alle fünf durch C belegten Paneprozesse.

Die quellengestützte Ursachenanalyse
und ihr unabhängiger Review empfehlen eine erweiterte L-Liste mit numerischer
Session-ID und unverändertem Anzeigerest. Der
aktualisierte Bindungsplan übernimmt
diese Empfehlung. Rename wird dabei durch beobachtete L-Unterschiede erkannt;
eine zwischenzeitliche Umbenennung mit Rückbenennung wird nicht als nachgewiesen
ausgeschlossen. Die Folgeprobe auf 3.0/3.4 hat inzwischen bestanden;
Kill-/Attach-Guard und M1-Freigabe sind weiterhin offen.
Dieser Dokumentationsschritt führte keine neue VM-Aktion
und keine Skriptänderung aus.
