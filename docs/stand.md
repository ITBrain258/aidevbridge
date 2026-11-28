# aidevbridge: Stand und offene Punkte

**Stand:** Version `0.3.8` vom 24.11.2026 (Tag `v0.3.8` auf dem Merge-Commit
des Release-PR); beim Tag baut die CI alle Pakete und hängt sie an das Release.
0.3.8 ist der erste Zug des [Fahrplans vom 23.11.](plans/2026-11-23-fahrplan.md):
Eine Session, in der Claude läuft, nennt den Grund, wenn `claude agents
--json` scheitert (PR #71), und „New session“ ist gesperrt, solange die
Shell eines Hosts auf die Standardausgabe schreibt (PR #72). Dazu kommen
die echten Fehler aus der Durchsicht vom 17.11. (PR #68), eine gemeinsame
Rückfrageleiste für „Remove“ und „Kill“ (PR #70) und Aufräumarbeiten ohne
Wirkung für Nutzer (PR #67, #69, #73, #74).
0.3.7 ist ein Sicherheits-Update (PR #64, Punkt 12): russh 0.65.4, `rsa`
0.10.0, `url` 2.5.9 und `cookie` 0.18.3. 0.3.6 brachte den überarbeiteten
Erststart (PR #61) und die Korrekturen aus den Entscheidungen vom 16.11.
(PR #62): Die App erkennt und nennt eine Shell, die
vor jedem SSH-Befehl Text schreibt, die Sessionliste hat 60 s für den ganzen
Gang und 15 s je Befehl, und ein Arbeitsordner, der auf `;` endet, wird
abgelehnt. Ein Host, dessen Shell auf die Standardausgabe schreibt, zeigt
seitdem keine Sessionliste mehr, bis die Ausgabe entfernt ist. 0.3.5 brachte
die beiden Gestaltungsrunden vom 14.11. (PR #59): eine Knopfleiste an jedem
Host, eine ruhigere Statusanzeige, die Wartet-Spur als Karte, die
Symbolleiste der eingeklappten Seitenleiste und vier weitere Hintergründe.
Seit 0.3.0 gelten die Mindeststände macOS 12.4 und
Android System WebView 105 (Entscheidungen vom 07.11.) und Android 17 als
Ziel mit der Berechtigung fürs lokale Netz; Einzelheiten im
[CHANGELOG](../CHANGELOG.md).

`main` ist seit dem 05.11. per Ruleset geschützt (Entscheidungen vom 05.11.);
reine Doku darf seit dem 15.11. direkt hinein (Entscheidungen vom 15.11.).
Frühere Releases und ihre Einzelheiten stehen im CHANGELOG, frühere Prüfungen
und erledigte Punkte in der Git-Historie dieser Datei.

Das Repository ist seit dem 22.10.2026 öffentlich und beginnt mit einem
einzigen Anfangs-Commit. Die Versionen 0.1.1 und 0.1.2 erschienen nur privat
und noch unter dem Namen agentbridge; ihre Tags gibt es dort nicht.

Dieses Dokument führt den Stand und die offenen Punkte. Was die App kann,
steht im [README](../README.md#what-it-does), die Einzelheiten für Nutzer in den
englischen Anleitungen unter [`guide/`](guide/install.md), die Änderungen im
[CHANGELOG](../CHANGELOG.md). Die Doku liegt flach unter `docs/` (`specs/`,
`plans/`, `messungen/`); im Baum bleibt nur, was aktuell ist. Was nur diesen
Rechner oder die Konten des Maintainers betrifft, liegt lokal unter
`docs/lokal/` und ist per `.gitignore` vom Repository ausgeschlossen.

## Entscheidungen vom 20.10.2026

- **Name:** aidevbridge (klein) für Produkt, Fenstertitel, npm- und
  Cargo-Paket; Bibliothek `aidevbridge_lib`, Programm `aidevbridge.exe`,
  Kennung `io.github.itbrain258.aidevbridge`, Repository
  `ITBrain258/aidevbridge`. Der tmux-Socket auf den Hosts heißt weiter
  `agentbridge`, damit bestehende Sessions sichtbar bleiben; das Format von
  `settings.toml` bleibt. Die Einstellungen liegen im Ordner der Kennung,
  `%APPDATA%\io.github.itbrain258.aidevbridge\`; fehlt dort beim Start die
  `settings.toml`, kopiert die App die aus `%APPDATA%\agentbridge\`, und der
  alte Ordner bleibt liegen.
- **Frische Historie:** Die öffentliche Fassung entsteht als neues
  Repository mit einem Anfangs-Commit. Das private Repository behält die
  volle Historie.
- **Unsigniert:** Die Windows-Pakete sind zunächst nicht signiert. Das README
  erklärt SmartScreen und Smart App Control, und jede Veröffentlichung nennt
  die SHA-256-Werte aus `release-manifest.json` des Lieferlaufs.

## Entscheidungen vom 23.10.2026

- **Keine feste Versionsbindung:** Die Statusformen werden gegen die jeweils
  neueste Agentversion gemessen; jede Version zählt, solange ihre Ausgabe eine
  gemessene Form hat, sonst „Unknown“. Keine Version im Tooltip.
- **Grok vorerst nicht:** Messungen und M1-Tor nur mit Claude Code und Codex.
  Die Titelregeln für Grok bleiben im Code, sind aber nicht erneut gemessen.

## Entscheidungen vom 25.10.2026 (macOS)

Nach der [Spec vom 25.10.](specs/2026-10-25-macos-lieferung-design.md):

- **macOS kommt dazu:** ein Universal-DMG für Apple silicon und Intel,
  macOS 11 und neuer (seit dem 07.11.: macOS 12.4, unten).
- **Ad-hoc signiert:** Developer ID und Notarisierung sind im Workflow
  vorbereitet und greifen, sobald die Apple-Secrets im Repository liegen.
- **Lizenzbeigaben gleichwertig:** eigene, gebundene macOS-Auswahl, aus der
  Windows-Auswahl abgeleitet.
- **Release automatisch:** Bei jedem Release baut, testet und veröffentlicht
  die CI alle Pakete (Nachtrag vom 26.10.); von Hand lädt der Maintainer
  nichts hoch.

## Entscheidungen vom 26.10.2026 (Code-Review)

Nach dem [Umsetzungsplan](plans/2026-10-26-review-umsetzung.md):

- **Leitlinie:** Funktionierendes wird nicht eingeschränkt. Kostet eine
  Härtung Funktion, bleibt die Funktion, und das Restrisiko steht in
  [`SECURITY.md`](../SECURITY.md) unter „Known limitations and accepted
  risks“.
- **Bleibt so:** der SHA-1-Rückfall bei Servern, die nur `ssh-rsa`
  anbieten; keine erneute Prüfung des Hostschlüssels beim Rekey, ohne
  eigenen russh-Patch; mehrere Instanzen, ohne Single-Instance-Plugin, dafür
  mit dauerhaftem Schreiben und Zusammenführen von `settings.toml`.
- **Ausgeschlossen:** S2 und S5; OSC 52 bleibt damit unberührt.
- **Fragen U1 bis U5:**
  - U1, nach Empfehlung A: Das portable ZIP behält die WiX- und
    NSIS-Quellarchive. Ein eigener Lizenzsatz für das ZIP kann mit der
    nächsten Neuableitung der Lizenzen kommen. Der Maintainer kann noch
    widersprechen.
  - U2, nach Empfehlung a: Bevor `APPLE_*`-Secrets hinterlegt werden,
    wandern Signatur und Notarisierung in einen eigenen Schritt oder Job, der
    nur die gebaute App bekommt (Punkt 9). Der Maintainer kann noch
    widersprechen.
  - U3: am 23.11. entschieden (E8) und umgesetzt (Fahrplan Z1.0):
    Hostverwaltung in `commands/hosts.rs`, Sitzungsliste, Statusabfrage und
    Verzeichnisauswahl in `commands/inventory.rs`.
  - U4: seit dem 05.11. entschieden (unten).
  - U5: Die Vorauseingabe bleibt. Endgültig entschieden wird an der
    [Handabnahme §10](abnahme-handarbeit.md#10-änderungen-aus-dem-code-review-vom-2610),
    Schritt 3.

## Entscheidung vom 31.10.2026 (öffentliches Repository)

Angaben zu Rechner, Konten und Test-VMs stehen nicht im Repository. Anleitungen
und Messwerkzeuge nennen Platzhalter, Bilder zeigen Beispieldaten. Der Name des
Maintainers bleibt, wo Lizenz und Paketdaten ihn als Urheber nennen. Bereits
veröffentlichte Commits werden nicht umgeschrieben, weil Tags, Releases und
Build-Provenienz an ihnen hängen.

## Entscheidungen vom 05.11.2026

- **`main` geschützt:** Das Ruleset „main“ gilt für den Standard-Branch.
  `main` lässt sich nicht löschen oder überschreiben, Änderungen kommen nur
  über einen Pull Request, und vor dem Merge müssen `rust (windows)`,
  `rust (ubuntu)`, `rust (macos)`, `frontend`, `licenses` und `scripts` grün
  sein. Freigaben verlangt es nicht, weil der Maintainer seine eigenen Pull
  Requests nicht freigeben kann. `packages.yml` und `android.yml` sind keine
  Pflicht, weil die macOS-Runner bei GitHub zeitweise keinen Platz haben.
  Admins dürfen die Regeln im Notfall umgehen. Die Jobnamen nennen das
  Runner-Image nicht, damit ein neues Image die Pflicht-Checks nicht ändert.
- **Abhängigkeiten:** Die Stufen unter Punkt 12 werden abgearbeitet, je
  Stufe ein Pull Request; Rust 1.99 wartet, bis ein Crate es verlangt. Nicht
  übernommen: `noUncheckedIndexedAccess` (877 Stellen, 95 davon außerhalb der
  Tests) und ein Linter.
- **Projektdateien:** keine Discussions und kein `CODE_OF_CONDUCT.md`.
  Erledigte Pläne fallen aus `plans/`, dieses Dokument führt nur noch die
  offenen Punkte; die Geschichte bleibt in Git.
- **Upstream (U4):** Eigene russh-Änderungen dürfen bei russh angeboten
  werden, zuerst das Close-Verhalten. Issue oder Pull Request gehen erst
  hinaus, wenn der Maintainer den Entwurf gesehen hat.
- **Gehashte Einträge in `known_hosts` schreiben:** zurückgestellt
  (Punkt 13).

## Entscheidungen vom 07.11.2026

- **Mindeststand der Webansicht:** macOS 12.4 statt 11 (WebKit von Safari
  15.5), Android weiter ab 7.0 mit Android System WebView ab 105; die App
  meldet eine ältere beim Start und bietet den Play Store an. Grund: Die
  Oberfläche nutzt `:has()`, `:focus-visible` und `inert`, und das WebKit
  einer App kommt unter macOS 11 und 12 nur mit Updates von macOS, nicht mit
  einem neueren Safari (Review vom 07.11., Punkt 14). Das Build-Ziel bleibt `safari14` und
  `chrome87`; es höher zu setzen ändert die Helfer im Bundle und damit den
  Lizenzbeleg, das kann ein eigener Pull Request tun. Die fehlenden
  Sicherheitsupdates der Webansicht auf alten Systemen stehen in
  [`SECURITY.md`](../SECURITY.md).
- **Wildcards in `known_hosts`:** zurückgestellt (Punkt 14).

## Entscheidungen vom 15.11.2026

- **Reine Doku direkt auf `main`:** Änderungen, die nur Doku sind, dürfen
  ohne Pull Request auf `main`; die Pflicht-Checks laufen dann nach dem Push.
  Ausgelegt als Prosa wie dieses Dokument, Specs, Pläne und Anleitungen.
  Code und Dateien, die eine Lizenzauswahl bindet, ein Skript erzeugt oder
  ein Test prüft (Bilder, Release- und Store-Texte), gehen weiter über einen
  Pull Request.
- **CodeQL:** eingeschaltet (Default Setup, wöchentlich und bei jeder
  Änderung) für die Workflows und für JavaScript und TypeScript. Rust nimmt
  die REST-Schnittstelle des Default Setups nicht an; es bleibt der Weg über
  die Einstellungen im Browser. Funde stehen im Reiter „Security“ des
  Repositorys, nicht in diesem Dokument.
- **Ausgewählte Actions:** zurückgestellt; die Liste erlaubter Actions
  machte den Ablauf vorerst nur umständlicher.
- **Upstream:** vorerst kein Beitrag bei russh (Punkt 12). Die Erlaubnis aus
  U4 vom 05.11. bleibt.

## Entscheidungen vom 16.11.2026

Der Maintainer hat die offenen Entscheidungen dieser Runde am 16.11. an
neutrale Bewertungen abgegeben: je eine unabhängige Prüfung, die nur las, mit
dem Maßstab „so einfach wie möglich, zugleich zuverlässig und
zukunftssicher“. Was hier steht, sind deren Urteile, keine Bestätigungen des
Maintainers.

- **PR #61 (Erststart):** gemergt als `1fdcc20`, nach zwei Korrekturen aus
  der Bewertung. „Edit details“ trug ein im Folgefeld getipptes Passwort samt
  Anmeldeart ins Formular. Und Anleitung, CHANGELOG und Spec nannten als
  Gewinn von „Check again“ eine zweite Fingerabdruckfrage, die es nicht gibt:
  Ein angenommener Schlüssel steht schon in `known_hosts`. Was ohne Eile
  nachkommt, steht unter Punkt 19.
- **Vorschläge aus §9 der Erststart-Spec:** Die Tastenleiste auf dem Telefon
  ohne offenes Terminal auszublenden kommt später, als eigener Android-PR
  vor dem geschlossenen Test. „☰ Sessions“ ohne Host wird nicht gebaut wie
  vorgeschlagen; später kann der Schalter die Schublade öffnen. Kein Hinweis
  in der ersten Shell, keine Erststart-Szene in `scripts/readme-images/`.
- **CodeQL:** Von den 29 Funden sind 27 auf GitHub mit Begründung
  geschlossen (15 in archivierten Messwerkzeugen unter
  `messungen/fixtures/`, 12 in `scripts/`) und 2 behoben
  (`release-workflows.test.mjs`, `release-license-inventory-frontend.mjs`);
  keiner lag im Produktcode. Es bleibt beim Default Setup, ohne
  ausgeschlossene Pfade; `vendor/russh` bleibt bewusst drin. Rust braucht
  einen Klick des Maintainers (Punkt 20). `languages` geht nicht wieder an
  die REST-Schnittstelle des Default Setups: Sie kennt Rust nicht. Jedes neue
  JS-Werkzeug unter `messungen/fixtures/` löst dieselben Funde wieder aus und
  braucht dieselbe Begründung. Für neue Rust-Funde gilt: in `src-tauri/src`
  beheben; in Tests als „used in tests“ schließen; in `vendor/russh` nur an
  den Zeilen des eigenen Patches beheben, sonst upstream melden oder als
  Fehlalarm schließen.
- **Startordner:** Die `#`-Regel bleibt (Bewertung vom 15.11.). Ein Ordner,
  der auf `;` endet, wird abgelehnt (Punkt 10).
- **Drei bekannte Fehler:** Die Startausgabe der Shell wird erkannt und
  benannt, nichts wird herausgefiltert. Die Sessionliste hat 60 s für den
  ganzen Gang und 15 s je Befehl; der gemeinsame Aufruf bleibt später. Der
  Start mit Kacheln mehrerer Hosts bleibt, wie er ist, und steht in den
  Grenzen (Punkte 8 und 15).
- **Messung vor dem Release:** Der Maintainer hat am 16.11. entschieden, vor
  0.3.6 zu messen. Die Bewertung der
  [Messung](messungen/messung-2026-11-16-shell-ausgabe-und-listenfrist.md):
  Die Bedingung „an einem echten Host messen“ ist für beide Änderungen
  erfüllt, und 0.3.6 braucht keine Codeänderung. Eine Erwartung traf nicht
  zu (ein tmux-Server, der mitten im Laden endet); falsch war die Erwartung,
  nicht der Code. Die Anleitung ist an den zwei Stellen berichtigt, die die
  Messung widerlegt (die Meldung nach Ablauf der Frist; was die
  Host-Prüfung nennt), und um die Fälle ergänzt, die sie zeigt. CHANGELOG,
  Zusammenfassung und Store-Texte bleiben: Sie sind knapper, aber nicht
  falsch. Später und nicht für 0.3.6: eine Sperre für „New session“, solange
  die Liste wegen der Shell ausbleibt, und eine Meldung beim Öffnen, die die
  Shell nennt (Punkt 15).

## Entscheidungen vom 23.11.2026

Der Maintainer hat am 23.11. alle Empfehlungen des
[Fahrplans](plans/2026-11-23-fahrplan.md) übernommen (dort Abschnitt 2, E1
bis E12 samt E9 a bis h). Pakete und Reihenfolge stehen im Plan; hier nur die
Festlegungen.

- **Richtung (E1):** andere Nutzer erreichen, aber nur mit billigen
  Schritten: tmux-Versionen, Doku, winget. Kein Geld für Signaturen und kein
  Apple-Konto, solange es keine Nutzer gibt.
- **Takt (E2):** alle 14 Tage ein Zug aus Kandidat, Handprüfungs-Termin und
  Tag. Ein Hotfix nur bei Sicherheit oder einem Blocker; 0.3.7 mit russh
  0.65.4 ist so einer. Den Tag setzt weiter der Maintainer.
- **Englisch (E3):** „B schmal“ statt „alles englisch“ vom 17.11.: nur die
  Kommentare im Produktcode, höchstens eine Woche, als eigener Zug nach Zug 1.
  Ein Werkzeug zeigt vorher, dass sich außer Kommentaren nichts ändert.
  Testnamen bleiben.
- **Audit (E4):** `audit.yml` bleibt rot, bis russh 0.65.4 im Baum ist. Für
  die neuen russh-Meldungen gibt es keine Ausnahme.
- **tmux-Versionen (E5):** Eine Messung in einem Container auf dem CI-Runner,
  nur mit eigenem Testsocket, darf eine Version freigeben. Jede Version
  bekommt einen eigenen Messbericht.
- **Rückfragen vom 17.11. (E6):**
  - Die beiden Bestätigungsleisten der Seitenleiste werden eine. Die
    Pfeiltasten bleiben am Ende stehen, wie in Knopfleiste und Liste.
  - `keymap.rs` wird entfernt. Damit entfällt der Kürzeleditor aus UX-Spec
    §14 (E-07), und `guide/limits.md` wird nachgezogen.
  - Die Ausnahme „Befund N der Bewertung“ im Hygienetest fällt weg.
  - Umgesetzt mit PR #70.
- **`stand.md` (E7):** wird ein kurzer Stand mit einer Statustabelle. Die
  Nummern der Punkte bleiben, denn Code und Workflows zitieren sie.
- **Batch 9 (E8, U3):** `commands.rs` wird zu Beginn von Zug 1 aufgeteilt.
- **Funktionen, die frühere Festlegungen öffnen (E9):**
  - a) Neue Sessions anderer Geräte erscheinen ohne „Reload sessions“: ja.
  - b) Einen alten Hostschlüssel in der Desktop-App entfernen, mit
    Sicherungskopie wie `ssh-keygen -R`: ja.
  - c) Die Zahl der Wartenden an Taskleiste und Dock: ja.
  - d) Ein Toast erst nach c), als eigene Entscheidung.
  - e) Ein Hinweis „fertig“ in der Wartet-Spur, kein sechster Zustand.
  - f) Zuerst nur die Vorschau der Frage; Antworten später.
  - g) Android im Hintergrund erst nach dem Gerätetest zu `STALL_TIMEOUT`.
  - h) Weitere Agenten nur nach einer Messung.
- **Hostschlüssel anderen Typs (E10):** Die Regel wie bei OpenSSH kommt,
  bevor die App über winget mehr Nutzer erreicht (Punkt 15).
- **Updates und Signatur (E11):** Updates kommen über Paketquellen (winget,
  Obtainium), nicht über einen eingebauten Updater. SignPath erst, wenn die
  App Reputation hat. Gesamtspec §11.2 und MVP-Spec bekommen dazu Nachträge.
- **Kleinere Fragen (E12):**
  - Reine Doku-Pushes bauen keine Pakete mehr (öffnet Punkt 16).
  - Gleichzeitige Abfragen der Sessionliste gelten nicht als geänderte Folge;
    gemessen wird trotzdem.
  - Die Protokolldatei liegt im Ordner der Einstellungen, 2 × 1 MB, und hält
    nur Host-IDs und Fehlercodes.
  - Abnahmeläufe bekommen einen eigenen UI-Stub.
  - Die Store-Texte werden erzeugt.

## Entscheidung vom 28.11.2026

Nach der Durchsicht vom 28.11. (Punkt 21) hat der Maintainer gewählt: zuerst
ein kleines 0.3.9, danach Zug 2 (Englisch). Das ändert die Reihenfolge aus E3,
nicht deren Umfang.

- **Inhalt von 0.3.9:** die Funde mit Effekt für Nutzer aus Punkt 21, mit
  Tests, die sie festhalten, und die Meldung beim Öffnen, die die Shell als
  möglichen Grund nennt (zweite Hälfte von Z1.3, Punkt 15). Im Release-PR
  kommen die Korrektur an `|| true` und der Doku-Filter für `android.yml`
  dazu.
- **Nicht in 0.3.9:** die Pakete aus Zug 3. Sie folgen nach Zug 2; ein
  Paket daraus kommt nur auf ein eigenes Wort des Maintainers früher.
- Tag und Release entscheidet der Maintainer weiter eigens.

## Gebaut

| Bereich | Stand |
| --- | --- |
| M0 Fundament, UI v2 | abgeschlossen mit 0.1.1 und 0.1.2; Farbwahl (7 Akzente auf 2 Grundtönen) und Einstellungsdialog |
| Seitenleiste und Grundtöne | nach der [Spec vom 14.11.](specs/2026-11-14-seitenleiste-und-grundtoene-design.md), seit 0.3.5: Einklappknopf und Symbolleiste der eingeklappten Seitenleiste mit der Einstellung `sidebar_rail`, Marke im Fuß ohne Commit, vier weitere Grundtöne (42 Varianten) |
| Statusanzeige und Knopfleiste | nach der [Spec vom 14.11.](specs/2026-11-14-statusanzeige-design.md), seit 0.3.5: Knopfleiste an jedem Host, ruhige Statuspillen (getönt nur Waiting, Ended, Failed; Busy blau, Idle grau), Wartet-Spur als Karte „Waiting for you“, Status-Zeichen an der Zeile der fokussierten Kachel |
| Erststart | nach der [Spec vom 15.11.](specs/2026-11-15-erststart-design.md), seit 0.3.6: „Check again“ und „Save host“ an der Host-Prüfung, „Edit details“ an einem Vorschlag, „New session“ unter einer leeren Sessionliste, eigene Meldungen zu einem Schlüssel, den der Host nicht annimmt, Einstieg „Add your first host“ |
| Stabilität und Verbindung | Kontroll- und Terminalverbindung je Host, Fristen, Kontrollreparatur, Korrekturen an Hostschlüsseln, Erststart und Hostverwaltung, RSA-Blinding; Hostschlüssel-Algorithmen nach `known_hosts`, weitere Agent-Schlüssel nach einer verweigerten Signatur |
| M1 Statuspunkt | Tor bestanden (automatisiert am 23.10., am Fenster gemeldet am 24.10.): numerische Sessionbindung (tmux 3.0, 3.3a, 3.4, 3.6), Statuspille, Aufmerksamkeit; Claude Code über `claude agents --json`, Codex und Grok über den Panetitel ([Messung](messungen/messung-2026-10-23-agentversionen.md)) |
| UX-Überarbeitung | gebaut nach der [Spec vom 11.10.](specs/2026-10-11-ux-ueberarbeitung-design.md): Kopieren und Einfügen wie in Windows Terminal samt OSC 52, Terminalmenü, Links, Suchleiste, Schriftgröße; Selbstheilung für Schlüssel- und Agent-Hosts; Arbeitsplatz, Schnellöffnen, ziehbare Seitenleiste; fünf Einstellungsbereiche |
| Dynamisches Raster | Schritt 0, 1 und 3 nach der [Spec vom 19.10.](specs/2026-10-19-dynamisches-raster-design.md): bis zu 9 Kacheln, höchstens 8 je Host, Tauschen, Spalt, Maximieren, Wartet-Spur |
| M3.1 Standard-Socket | nach der [Spec vom 25.10.](specs/2026-10-25-standard-socket-design.md), mit 0.2.2 ausgeliefert und [abgenommen](messungen/messung-2026-10-25-m31-abnahme.md) |
| Windows-Lieferung | `npm run build:windows` baut MSI, NSIS und ZIP mit Lizenzbeigaben, unsigniert ([Beleg zu NSIS 3.13](release/windows-installer-nsis-3.13-2026-10-30.md)); `packages.yml` baut sie bei jedem Tag, installiert und startet jedes Paket auf einem frischen Runner und hängt sie an das Release |
| macOS-Lieferung | nach der [Spec vom 25.10.](specs/2026-10-25-macos-lieferung-design.md), seit 0.2.3: Universal-DMG, ad-hoc signiert, [macOS-Lizenzauswahl](release/license-selection.macos-universal.json) mit 390 Komponenten; Testinstallation auf Apple silicon und Intel |
| Android | nach der [Spec vom 27.10.](specs/2026-10-27-android-design.md), seit 0.2.4: ab Android 7.0 (seit dem 07.11. mit Android System WebView ab 105), seit 0.3.0 Ziel API 37 mit der Berechtigung fürs lokale Netz (bis 0.2.7 API 36); kompakte Ansicht und Touch-Leiste, `android.yml` mit Signatur im eigenen Job, eigene [Lizenzauswahl](release/license-selection.android-universal.json) mit 485 Komponenten; eine Abnahme nach [Plan](plans/2026-10-27-android.md) steht aus |
| Abhängigkeiten | zuletzt am 05.11. (PR #24 bis #27, #32, #34) und am 06.11. das Ziel-SDK 37 (PR #37); die offenen Stufen unter Punkt 12 |

## Letzte Prüfung

Am Release 0.3.8 (24.11.2026, Tag `v0.3.8` auf `fbfeeec`, dessen Baum dem
geprüften Kopf des Release-PR #75 gleicht; der PR ändert am Code nur die
Versionszeilen): Probeläufe mit **release** auf dem Kopf grün (Packages
45301964535, Android 45301968216, Audit 45301971528). Vor dem Tag lief eine
Prüfung der Release-Texte gegen den Code, die nur las; ihre fünf Korrekturen
stehen im PR. Live-Lauf auf dem Rust-Code des Releases (main mit PR #72; #73
und #74 ändern keinen Rust-Code) an beiden Test-VMs: je 790 Tests ohne
Fehlschlag und die Abnahme mit 11 von 11. Ein Ausreißer im ersten Lauf an der
VM mit tmux 3.6: `a_stalled_session_does_not_take_the_whole_connection_down`
scheiterte unter vier parallelen Testthreads an seiner eigenen Vorbedingung
(nur 36 % des Ack-Fensters kamen vor 2 s Stille an); einzeln zweimal grün, der
volle zweite Lauf ebenfalls. Am Release sechs Dateien; ihre Prüfsummen stimmen
mit dem Release-Text, den Digests von GitHub und der `.sha256`-Datei überein,
die Attestierungen der fünf Pakete nennen Tag und Commit, und das APK trägt
versionCode 3008 und das bisherige Zertifikat. Die Läufe am Tag starteten
beide, obwohl `packages.yml` seit PR #66 einen Pfadfilter hat. Live-Lauf auf
dem sauberen Tag an beiden Test-VMs: je 790 von 790 und die Abnahme mit 11 von
11. Das Hochladen zu Google Play lief nicht (kein Dienstkonto, Punkt 11).
Nicht geprüft: das echte Fenster mit 0.3.8; eine Host-Shell, die auf die
Standardausgabe schreibt, an einer VM (dafür bräuchte es das Wegwerfkonto);
die Anmeldung per Passwort und über den ssh-agent, die ohne Passwort bzw. mit
leerem Agent übersprungen wurden.

Am 23./24.11.2026 für Zug 1 (PR #66 bis #74): neutrale Durchsichten, die nur
lasen, für #68, #70, #71 und #72 und eine Prüfung der Release-Texte; ihre
Funde beheben dieselben PRs (unter anderem konnte der wiederholte `rename` die
Speicherung eines anderen Fensters überschreiben, und die Sessionliste setzte
den Claude-Grund bis zum nächsten Poll zurück). Lokal vor jedem PR: Clippy mit
`-D warnings`, alle Rust-Tests, Vitest, Typprüfung und `licenses:status`. CI
grün; der Linux-Job scheiterte in der Nacht viermal am apt-Mirror von Ubuntu
(drei Zeitüberschreitungen beim Herunterladen) und lief wiederholt grün.

Am Release 0.3.7 (23.11.2026, Tag `v0.3.7` auf `de3286c`, dessen Baum dem
geprüften Kopf des Release-PR #65 gleicht; der PR ändert am Code nur die
beiden Versionszeilen): Probeläufe mit **release** auf dem Kopf grün (die
macOS-Jobs erst im zweiten Versuch, weil sich 15 Minuten lang kein Runner
fand). Live-Lauf auf dem Stand des Tags an beiden Test-VMs: je 803 Tests ohne
Fehlschlag und die Abnahme mit 11 von 11. Am Release sechs Dateien; ihre
Prüfsummen stimmen mit dem Release-Text, den Digests von GitHub und der
`.sha256`-Datei überein, die Attestierungen der fünf Pakete nennen Tag und
Commit, und das APK trägt versionCode 3007 und das bisherige Zertifikat. Das
Hochladen zu Google Play lief nicht (kein Dienstkonto, Punkt 11). Nicht
geprüft: das echte Fenster mit 0.3.7.

Am 23.11.2026 für PR #64 (russh 0.65.4, `rsa` 0.10.0, `url` 2.5.9 und
`cookie` 0.18.3; gemergt als `93532e1`): eine neutrale Durchsicht des
Vendor-Diffs, die nur las und die drei Bäume verglich; ihre Funde behebt
derselbe PR. Lokal: Clippy, 727 Rust-Bibliothekstests, mit den
Integrationstests 803, 4968 Vitest-Tests, 251 Skripttests, die Tests des
eingebetteten russh (244 Bibliotheks- und 35 Integrationstests) und
`licenses:check` für alle drei Auswahlen. CI, Audit und beide Probeläufe
mit **release** grün. An beiden Test-VMs, nur mit eigenen Testsockets: alle
Live-Tests mit einem RSA-Testschlüssel, der nur für den Lauf in
`authorized_keys` stand (der RSA-Zweig lief damit zum ersten Mal gegen echtes
OpenSSH, 10.2 und 9.2), und die Abnahme mit 11 von 11 je VM, mit dem Zweig
über den ssh-agent. Zwei Ausreißer, beide einzeln wiederholt grün:
`kill_session_leaves_no_server_running_behind` traf unter Last den
tmux-Server beim Beenden („server exited unexpectedly“ statt „no server
running“), und zwei `known_hosts`-Tests scheiterten in einem vollen
Windows-Lauf an einer gesperrten Temp-Datei (`os error 32` beim `rename`).
Nicht geprüft: das echte Fenster; die Anmeldung per Passwort (kein Passwort
für das Wegwerfkonto); der Rückfall auf `ssh-rsa`/SHA-1 gegen OpenSSH, den
OpenSSH ab 8.8 nicht mehr anbietet (er läuft im Loopback-Test gegen einen
russh-Server).

Am 16.11.2026 nach 0.3.5: drei neutrale Bewertungen, die nur lasen (PR #61;
die 29 CodeQL-Funde und das Setup; die drei bekannten Fehler aus den Punkten
8 und 15), danach PR #61 mit zwei Korrekturen und PR #62 (Entscheidungen vom
16.11.). Lokal für PR #62: Clippy, 727 Rust-Bibliothekstests, mit den
Integrationstests 803, 4968 Vitest-Tests, 251 Skripttests und
`npm run build`. An den beiden Test-VMs, nur mit eigenen Testsockets: die
Messung zum `;` und der Live-Lauf, der unten steht.
Danach, am Kopf des Release-Branches (`01cf831`): die Erkennung der
Startausgabe und die neue Frist an einem echten Host, mit einem
Wegwerfkonto auf der VM mit tmux 3.3a
([Messung](messungen/messung-2026-11-16-shell-ausgabe-und-listenfrist.md):
fünf Zustände der Startdatei, die Liste über eine verzögerte Verbindung).
Eine vierte neutrale Bewertung las die Rohdaten gegen Code und Anleitung
(Entscheidungen vom 16.11., Punkt 15).
Am Release 0.3.6 (Tag `v0.3.6` auf `fbf5cc2`, dessen Baum dem geprüften Kopf
des Release-PR gleicht): sechs Dateien; ihre Prüfsummen stimmen mit dem
Release-Text und der `.sha256`-Datei überein, die Attestierungen der fünf
Pakete nennen Tag und Commit, und das APK trägt versionCode 3006 und das
bisherige Zertifikat. Das Hochladen zu Google Play lief nicht (kein
Dienstkonto, Punkt 11).
Nicht geprüft: das echte Fenster; Startausgabe und Frist mit zsh, mit
anderen tmux-Versionen und mit dem Standard-Socket; die Anmeldung mit einem
RSA-Schlüssel (die per Passwort und über den ssh-agent liefen am selben Tag
nach, siehe den Live-Lauf unten; am Fenster sind beide nicht geprüft); ob
der macOS-Test jetzt hält (die beiden Läufe der CI zu PR #62 bestanden);
CodeQL für Rust.

Am 14.11.2026 nach 0.3.4, vor PR #59 (CHANGELOG `[0.3.5]`): eine Durchsicht
des Branches mit den beiden Gestaltungsrunden, die nur las. Neun Funde. Fünf
mit Effekt für Nutzer behebt derselbe PR: Strg+Umschalt+B nimmt
den Fokus mit, wenn die Leiste verschwindet, in der er stand; Einstellungen
aus der Symbolleiste geben ihn nicht an einen verborgenen Knopf zurück; ohne
Symbolleiste steht der Einklappknopf nicht im Fuß; der Zähler der
Symbolleiste gibt den Fokus weiter, wenn er verschwindet; der graue Ring von
„Offline“ gilt. Der Rest steht unter Punkt 18. Lokal: Clippy, 716
Rust-Bibliothekstests, mit den Integrationstests 792, 4940 Vitest-Tests, 251
Skripttests und `npm run build`. Nicht geprüft: das echte Fenster mit echten
Hosts, ein Bildschirmleser, ein Kontrastdesign, ein Android-Tablet (Punkte 17
und 18).

Am 13.11.2026 nach 0.3.3: drei Prüfungen auf `main` (`9a6a03c`), die nur
lasen: der Code seit der Durchsicht vom 10.11., der Aufbau der großen Dateien
und die Tests. Danach bewertete je ein neutraler Agent jeden Fund; zwei stellten
das Verhalten von Chromium in Edge 157 an einer Minimalseite nach. Kein hoher
Befund. Was einen Effekt für Nutzer hat, behebt PR #56 (CHANGELOG
`[0.3.4]`): Ein Klick in der
Seitenleiste geht nicht mehr verloren, wenn sie während des Drucks neu gebaut
wird; mit „Screen reader support“ laden Browsertasten auf einer Zeile des
Bildschirmlesers die App nicht mehr neu; und auf Android vergisst das Entfernen
eines Hosts dessen Hostschlüssel. Eine neutrale Prüfung las den Branch gegen
und fand, dass der Ausweg unter Android bei zwei gespeicherten Hosts mit
derselben Adresse im Kreis führte und dass ein aufgeschobenes Neuzeichnen die
Fokusrettung nach dem Entfernen verpassen konnte; behoben im selben PR. Was
offen bleibt oder nicht übernommen wurde, steht unter Punkt 16. Lokal: `licenses:status` ohne Abweichung nach
`rebind-own`, Clippy für Windows und `aarch64-linux-android`, 716
Rust-Bibliothekstests, mit den Integrationstests 792, 3031 Vitest-Tests, 251
Skripttests und `npm run build`. Nicht geprüft: der Klick-Verlust in der
laufenden App (der Tipp in der Telefonansicht nur emuliert), die Tasten mit
einem echten Bildschirmleser, das Vergessen des Schlüssels an einem
Android-Gerät. Die Durchsicht vom 10.11. steht in der Git-Historie dieser Datei.

Der letzte Live-Lauf ging am 16.11. auf dem Stand von PR #62 (`c03444f`; der
gemergte Kopf `d8742b2` ändert danach nur einen Kommentar in einer Testdatei
des Frontends) von Windows aus gegen beide Test-VMs, auf eigenen Testsockets.
Gegen die VM mit Ubuntu 26.04, OpenSSH 10.2 und tmux 3.6 und gegen die VM mit
Debian 12, OpenSSH 9.2 und tmux 3.3a: je alle 803 Rust-Tests grün, darunter
`integration_default_socket`, und die VM-Abnahme (`acceptance_vm`) 11 von
11. Die Sessions auf den übrigen Sockets waren danach dieselben wie davor.
Die VM mit tmux 3.3a hat weiter kein Wegwerfkonto für den Passwortzweig. Der
Test der sieben Fehlerzweige bestand dort trotzdem: Er lief mit einem
Kontonamen, den es auf dieser VM nicht gibt, und sshd beantwortet ein
fehlendes Konto wie eines ohne `authorized_keys`. Am 14.11. (Tag `v0.3.4`)
brach er vor SSH ab, weil `AIDEVBRIDGE_VM_PASSWORD_USER` nicht gesetzt war.
Übersprungen auf beiden und trotzdem als bestanden gezählt: der RSA-Zweig
(kein `AIDEVBRIDGE_TEST_RSA_KEY`), der Passwortzweig (kein
`AIDEVBRIDGE_VM_PASSWORD`) und der ssh-agent-Zweig (Dienst auf dem Rechner
aus).
Den Passwortzweig holte ein Lauf am 16.11. nach dem Release nach, auf
`762daa4` (Code wie `v0.3.6`) gegen beide VMs: je ein Wegwerfkonto mit
Zufallspasswort und ohne `authorized_keys`, das nur für den Lauf bestand.
Die Anmeldung per Passwort bestand, und der Test der sieben Fehlerzweige
lief mit allen sieben gegen ein Konto, das es gibt, auf der VM mit tmux 3.3a
zum ersten Mal. Vorher geprüft, je VM: Das Konto nimmt den Testschlüssel
nicht an, und ein einfaches `ssh` meldet sich mit dem Passwort an. Keine
Zeile „uebersprungen“ in der Ausgabe; die Sockets waren danach dieselben wie
davor, die Konten sind entfernt.
Der ssh-agent-Zweig lief danach am selben Tag gegen beide VMs, nachdem der
Maintainer den Agent-Dienst von Windows gestartet hatte. Ohne
Administratorrechte startet der Dienst nicht, auch nicht als Prozess
(`ssh-agent -d` endet mit „cannot create agent root reg key“). Im Agenten
lag nur der Testschlüssel. Vorher geprüft, je VM: Das `ssh` von Windows
meldet sich ohne Schlüsseldatei über den Agenten an. Die Anmeldung der App
über den Agenten bestand, ohne Zeile „uebersprungen“; danach ist der
Schlüssel wieder aus dem Agenten entfernt. Weiter übersprungen: der
RSA-Zweig. Nicht geprüft: ein Schlüssel im Agenten, den der Host nicht
annimmt (Handabnahme §12, A3).
Für die Änderungen vom 16.11. zeigt der Lauf nur, dass ein Host ohne
Startausgabe der Shell keinen Fehlalarm auslöst und dass die Liste mit der
neuen Frist lädt wie bisher. Die Erkennung selbst und eine langsame Verbindung
löst er nicht aus; die zeigt die Messung vom selben Tag (Punkt 15).
0.3.6 lief nicht eigens live: In `src-tauri/`, `src/` und `vendor/`
unterscheidet es sich vom Stand dieses Laufs nur durch die beiden
Versionszeilen und jenen Kommentar.
0.3.5 lief nicht live: Sein Rust-Teil unterscheidet sich von `v0.3.4` nur
durch das Feld `sidebar_rail` der Einstellungen, das die Unit-Tests prüfen,
und durch die Versionszeile.
Kein Live-Test löst die Frist beim Kanalöffnen aus, die 0.3.2 geändert hat;
den neuen Pfad prüfen nur die Unit-Tests. Den Passwortzweig prüfte zuletzt der
Lauf vom 27.10. auf `7b961cf` gegen einen lokalen Linux-Testhost mit tmux 3.4
(VM-Abnahme 11 von 11, nur der ssh-agent-Zweig übersprungen).

## Offene Punkte

Die Nummern bleiben stabil, weil andere Dokumente sie nennen.

1. **M1-Tor:** bestanden, automatisiert am 23.10.
   ([Bericht](messungen/messung-2026-10-23-m1-tor.md)), am Fenster gemeldet am
   24.10. ([Handabnahme §9](abnahme-handarbeit.md#9-m1-tor)).
2. **Erstes Release:** `v0.2.0` am 22.10., seitdem öffentlich mit privatem
   Meldeweg für Sicherheitslücken, Dependabot, Secret Scanning mit Push
   Protection, seit dem 15.11. CodeQL (Entscheidungen vom 15.11.) und den
   Rulesets „Release tags v*“ und „main“; Workflows aus
   Pull Requests externer Beitragender laufen erst nach Freigabe. Die
   Schlüssel unter `src-tauri/tests/fixtures/rsa-signing/`, in
   `src-tauri/src/ssh/auth.rs` und in `vendor/russh` sowie der synthetische
   Schlüssel in `scripts/m1-error-profile.py` sind Testdaten.
3. **Statusquelle:** erledigt am 23.10.
   ([Messung](messungen/messung-2026-10-23-agentversionen.md)). Offen: Grok
   (Freigabe, langer Hintergrundbefehl, aktuelle Version), wenn es
   zurückkommt; Projektdateien und `-c`-Optionen von Codex bleiben ungelesen.
4. **M2:** Tor bestanden, abgenommen am 24.10.
   ([Handabnahme §6](abnahme-handarbeit.md#6-wiederverbinden)). Selbstheilung nur
   für Schlüssel und ssh-agent.
5. **M3:** M3.1 ist ausgeliefert und abgenommen (siehe Gebaut). Bekannte
   Grenzen: Die Statusabfrage liest den Standard-Socket in der Form des tmux
   im `PATH` ([Grenzen](guide/limits.md)). Offen aus der Roadmap vom 05.09.
   (in der Git-Historie): die übrige Windows-Politur nach S3.2
   (Protokolldatei, globaler Diagnosetext), ein neues Logozeichen für den
   Erststart (bisher „a“; geparkt auf `feat/new-logo`), RUSTSEC-2023-0071 zu
   `rsa` (eingeordnet in [`SECURITY.md`](../SECURITY.md); behoben in `rsa`
   0.10.0, der Wechsel wartet auf russh, Punkt 12) mit einer echten
   RSA-Abnahme, Signatur der Pakete und winget. Zur Protokolldatei (Review vom
   03.11.): Die App schreibt kein Protokoll, Fehlerdetails gehen verloren. Sie
   braucht neue Abhängigkeiten mit Lizenzprüfung, eine Regel, die Hostnamen
   und Pfade unkenntlich macht, und eine Entscheidung zu Ort und Rotation.
6. **Lieferung:** Alle drei Lizenzauswahlen
   ([Windows](release/license-selection.windows-x64.json),
   [macOS](release/license-selection.macos-universal.json),
   [Android](release/license-selection.android-universal.json)) sind gebunden;
   den Ablauf beschreibt die [Anleitung](lizenzen-pflegen.md). Jede
   weitergegebene Kopie trägt die Lizenzhinweise: An andere geht nur das ZIP
   oder ein Installer, beide mit dem Ordner `licenses/`; die nackte EXE aus
   `npm run build:app` bleibt auf dem eigenen Rechner. Die EXE von 0.2.7 aus
   der CI (Visual Studio 2026, MSVC 14.51) linkt laut Importtabelle und
   Rich-Header dieselben Microsoft-Laufzeitfamilien wie der lokale Bau vom
   12.09.; zu liefern ist nichts zusätzlich
   ([Beleg vom 05.11.](release/license-windows-runtime-2026-11-05.md)). Ihre
   PDB ist nicht erhalten; seitdem bewahrt `packages.yml` sie 90 Tage als
   Artefakt `windows-symbols` auf, damit der nächste Werkzeugwechsel Modul
   für Modul geprüft werden kann. Copyright-Zeilen im Quelltext, die kein
   ausgelieferter Text nennt, liefern die Auswahlen wörtlich in
   `<Paket>-<Version>-SOURCE-NOTICES.txt` mit: seit dem 05.11. für
   crypto-bigint, seit dem 06.11. für futures-channel und crypto-primes und
   nach einem Scan aller 405 Komponenten für tao (W3C-Lizenz der
   Tastaturnamen), curve25519-dalek, tauri, tauri-plugin-fs, polyval, der,
   toml, cookie und dtoa, auf Android auch für is-wsl und cesu8. Warum die
   übrigen Treffer nicht dazugehören, steht im
   [Beleg](release/license-source-notices-2026-11-06-scan.json).
   Offen:
   - Die Installerabnahme (bestanden am 24.10. an 0.2.0) ist mit NSIS 3.13 neu
     fällig: Der Maintainer prüft die Setup-EXE an den Paketen von 0.3.2. Das
     Manifest jedes Laufs meldet `nsis_msi_payload`, `installer_terms_ui`,
     `installer_stub_notices`, `native_import_family_review` und
     `product_and_windows_acceptance` weiter als `pending`, weil ein Bau sie
     nicht kennt.
   - Die NDK-Belege aller drei ABIs stammen aus dem Android-Probelauf
     43005268807 auf `4243ed2` (Release-PR von 0.3.3). Ihr SHA-256 gehört zu
     diesem Bau: Der Tag-Bau trägt in der Oberfläche einen anderen Commit und
     hat deshalb einen anderen. Seit dem 11.11. liest jeder Lauf von
     `android.yml` die Belege aus dem eigenen Bau und scheitert, wenn sich eine
     Aussage geändert hat; `licenses:derive` behält die gebundenen Belege und
     nimmt neue nur aus der Datei eines Release-Laufs (`--native-evidence`,
     [Anleitung](lizenzen-pflegen.md)).
   - Lokal gebaute Pakete bis 0.2.2 enthalten Pfade des Cargo-Registers mit
     dem Benutzernamen des Bauprofils; hingenommen, seit 0.2.3 baut die CI.
7. **Echte Abnahmen:**
   - die [Handabnahme](abnahme-handarbeit.md) am Windows-Fenster: echte
     Tastatur, Rechtsklick, Skalierung 100 und 150 % am echten Bildschirm,
     Standby und Netzwechsel, Bildschirmleser und die Farbthemen (42 seit
     der Spec vom 14.11.); dazu §10 und §11. §12 bündelt seit dem 16.11.,
     was aus den Punkten 17 bis 19 am Fenster offen ist, nach Risiko
     geordnet, dazu zwei Schritte zur Startausgabe der Shell (Punkt 15).
   - die offenen Punkte des UI-v2-Tors
     ([Spec](specs/2026-09-05-ui-v2-design.md) §17): Dichte mit
     20 Sessions unter 4 Hosts, WebGL unter 10 Minuten Flutung, Skalierung
     125 und 150 %, Farbwechsel bei laufenden Kacheln, echter Erststart,
     Tastatur in Fingerabdruck- und Sessiondialog.
   - der Zweitrechner: Installation nur nach README, Anmeldung mit `id_rsa`,
     ed25519 und Passwort, handgestartete Session mit Status, Deinstallation.
8. **Raster:** Schritt 3 ist gemessen und abgenommen
   ([Messbericht](messungen/messung-2026-10-21-acht-kacheln.md)); Schritt 2
   (Bewegung) folgt mit eigenem Plan. Am Fenster nicht angesehen: 150 %,
   zweiter Bildschirm (Spec §8.6), Ab- und Andocken, die Wartet-Spur mit einer
   echt wartenden Claude-Session, ob die Windows-Animationseffekte aus sind.
   Der Klick-Verlust der Seitenleiste (Verdacht aus dem Review vom 03.11.) ist
   am 13.11. bestätigt und behoben: Fiel die gedrückte Zeile vor dem Loslassen
   aus dem Dokument, schickte Chromium keinen Klick (Edge 157, Minimalseite).
   Sicher traf es den ersten Klick nach einem Fokus in der Wartet-Spur. Seitdem
   wartet ein Neuzeichnen während eines Drucks bis nach dem Klick, höchstens
   2 s. In der laufenden App nicht nachgestellt. Bekannte Fehler:
   - Beim Start mit Kacheln mehrerer Hosts ändert ein Host, der erst nach der
     Frist von 5 s gelistet wird, die Größe der übrigen Kacheln; Codex
     verliert dabei seinen Verlauf. Das bleibt so (Bewertung vom 16.11.):
     Eine längere Frist ließe die Kacheln erreichbarer Hosts warten, sobald
     einer nicht antwortet, und einen später oder von Hand verbundenen Host
     deckt sie ohnehin nicht. Es steht seitdem in
     [Grenzen](guide/limits.md) unter „Resizing“. Eine echte Lösung hielte
     die Plätze frei (Platzhalter-Kacheln) und braucht eine eigene Spec.
   - Acht Kacheln, die gleichzeitig ungebremst ausgeben, machen die
     Oberfläche zäh (Statuslatenz p95 5,0 s, Ereignisschleife p95 215 ms);
     der Renderer ist der Engpass. Ob ein binärer Ausgabekanal oder weniger
     Neuzeichnen hilft, klärt eine eigene Messung mit eigenem Plan
     (Entscheidung vom 24.10.); ein Kandidat ist die Sperre in
     `TerminalPump::forward` (F2 im
     [Umsetzungsplan vom 26.10.](plans/2026-10-26-review-umsetzung.md)).
   - Eine große Einfügung hält die Seite an, solange Chromium die
     Zwischenablage liest und xterm sie verarbeitet: rund 0,33 s je MB.
9. **macOS:** Bau und Testinstallation auf Apple silicon und Intel laufen in
   der CI grün. Offen ist die Abnahme am Fenster eines Macs nach
   [Spec §9](specs/2026-10-25-macos-lieferung-design.md#9-offen):
   Verbinden mit Schlüssel, ssh-agent und Passwort, Abfrage zum lokalen
   Netz, Kopieren und Einfügen, Schriften, Fensterlage, Neustart; dazu
   Mac-Kürzel mit ⌘ und, sobald Secrets da sind, ein Lauf mit Developer ID
   und Notarisierung, nach U2.
10. **Review vom 26.10.:** Offen sind die
    [Handabnahme §10](abnahme-handarbeit.md#10-änderungen-aus-dem-code-review-vom-2610)
    und ein etwaiger Widerspruch zu U1, U2 und U5. U3 (Batch 9) ist mit
    PR #67 erledigt (Entscheidungen vom 23.11., E8).
    `integration_default_socket.rs` braucht einen Testhost mit tmux 3.3a oder
    3.6 für seinen vollen Lauf (der CI-Runner hat tmux 3.4, dort meldet er
    SKIP); auf 3.6 lief er zuletzt am 11.11., auf 3.3a am 25.10. (Letzte
    Prüfung). Außerdem:
    - **`#` vor `[` im Startordner:** Die Regel verdoppelt jede Folge von `#`,
      außer direkt vor `[` (ab tmux 3.3a eine Stilmarke,
      [Messung](messungen/messung-2026-10-26-tmux-cwd-format.md)); der
      Maintainer bestätigt sie noch. Eine neutrale Bewertung vom 15.11., die
      nur las und nichts nachmaß, empfiehlt, die Regel zu behalten: Auf 3.3a,
      3.4 und 3.6 ergeben alle acht gemessenen Namen den Ordner wörtlich, auf
      3.0a startet nur `##[` im Home-Ordner, und in keiner maskierten Form
      wurde etwas ausgeführt. Alles zu verdoppeln wäre auf den aktuellen
      Versionen schlechter, `##[` abzulehnen sperrte dort Funktionierendes.
      Seit dem 16.11. nennt [Grenzen](guide/limits.md) die Grenze, und der
      Live-Test `a_hash_in_the_start_directory_stays_literal` legt über die
      Rust-Funktion Ordner mit `##[`, `###[` und `a;b` an (bestanden auf
      tmux 3.3a und 3.6; die CI fährt ihn auf 3.4). Offen daraus:
      - „Ab 3.3a“ ist nur belegt als „fehlt in 3.0a, vorhanden in 3.3a“; 3.1
        bis 3.3 sind ungemessen.
      - Die Handabnahme hat keinen Fall mit `[`.
    - **Startordner mit `;` am Ende:** erledigt am 16.11. Dialog und
      Backend lehnen ihn ab und nennen den Grund; ein `;` im Namen bleibt
      erlaubt. [Gemessen](messungen/messung-2026-11-16-tmux-cwd-semikolon.md)
      auf tmux 3.3a und 3.6: Roh startet die Session im Ordner ohne das `;`
      oder im Home-Ordner, ohne Fehler. `\;` im Argument von `-c` ergab dort
      den Ordner wörtlich; gebaut ist das nicht, weil 3.0a und 3.4 ungemessen
      sind.
11. **Android:** Die Schritte des Maintainers in der Play Console, ohne Eile:
    der geschlossene Test mit 12 Testern über 14 Tage (dafür fehlen noch
    Tester, das dauert voraussichtlich noch einige Monate; bis dahin ist die
    App für den eigenen Gebrauch gedacht und nur als APK auf GitHub zu haben),
    die Datenschutz-URL
    und das Hochladen des App Bundles von Hand; erst mit einem
    Play-Dienstkonto im Environment `android-release` lädt `android.yml`
    selbst hoch ([Anleitung](android-veroeffentlichung.md)). Das signierte
    App Bundle von 0.3.8 (versionCode 3008) liegt nur als Artefakt
    `android-signed` des Laufs 45304643673 vor, bis zum 22.02.2027. Ist es
    abgelaufen, baut ein Lauf von `android.yml` von Hand mit der Eingabe `tag`
    es neu, und mit Dienstkonto lädt derselbe Lauf es hoch; der Job, der das APK
    anhängt, kann dabei rot werden, wenn der Neubau andere Bytes hat, das
    Hochladen hängt nicht an ihm. Am Gerät zu
    klären (Review vom 03.11.): ob Android den WebView im Hintergrund so
    anhält, dass die Acks länger als 30 s ausbleiben; dann schließt
    `STALL_TIMEOUT` die Terminals, und die Kacheln hängen sich nach der
    Rückkehr neu an. Ziel-SDK 37: Die Prüfung der Berechtigung fürs lokale
    Netz nach Schritt B3 der [Anleitung](android-veroeffentlichung.md) bestand
    am 06.11. auf einem Telefon mit Android 17. Hosts hinter einem VPN sperrt
    Android laut seiner Doku nicht; ob es Loopback sperrt, ist ungeprüft.
    Offen aus dem Review vom 06.11. (Spec-Nachtrag zum Ziel-SDK 37):
    - Die App erkennt das lokale Netz an Adressbereichen, Android an der
      Schnittstelle. Ein Host im WLAN mit öffentlicher IPv6-Adresse bekommt
      keinen Dialog; genauer ginge es mit den Präfixen aus `LinkProperties`,
      das braucht einen Gerätetest.
    - Die Namensauflösung, mit der `prepare` ein Ziel einordnet, läuft
      außerhalb des begrenzten Pools der Verbindungen und wird nach 10 s nur
      verlassen, nicht beendet. `prepare` bemerkt auch kein Abbrechen des
      Versuchs; ein abgebrochener Versuch kann noch einen Dialog öffnen.
    - Ein Dialog, der länger als 120 s offen bleibt, gilt für den wartenden
      Aufbau als unbeantwortet. Seit 0.3.1 fragt kein weiterer Host neu,
      solange der Dialog offen ist, und geht ohne Antwort weiter (Prüfung vom
      09.11.); am Gerät nicht nachgestellt.
12. **Abhängigkeiten, weitere Stufen:** jede als eigener Pull Request, weil
    jede in der Herkunft der Release-Bauten oder in den Lizenzbelegen
    gebunden ist. Erledigt bis zum 06.11.: Tauri 2.12, Tauri-CLI 2.12.4 mit
    NSIS 3.13, russh 0.65.1, `lucide-static` 1.69, `dirs` 7, `toml` 1,
    `sha2` 0.11, TypeScript 6, Vitest 5, jsdom 30 und Vite 8 (mit Ziel
    Safari 14 und Chrome 87 wie bisher;
    [Beleg](release/license-frontend-vite-8-2026-11-05.json)), dazu für
    Android Gradle 9.6, AGP 9.3, Kotlin 2.2 und die androidx-Updates mit
    Locks für den Buildscript-Classpath, `verification-metadata.xml` und
    Clippy für das Android-Ziel (PR #34,
    [Nachtrag der Android-Spec](specs/2026-10-27-android-design.md#nachtrag-vom-05112026-gradle-9-agp-9-und-kotlin-2)),
    am 06.11. das Ziel-SDK 37 mit der Berechtigung fürs lokale Netz, die
    Android 17 dafür verlangt (PR #37,
    [Nachtrag der Android-Spec](specs/2026-10-27-android-design.md#nachtrag-vom-05112026-ziel-sdk-37-und-das-lokale-netz)).
    Am 23.11. russh 0.65.4 (sechs Meldungen vom 21.11., drei davon im
    Client) und mit ihm `rsa` 0.10.0, `pkcs1` 0.8.0 und `ssh-key`
    0.7.0-rc.12; damit ist RUSTSEC-2023-0071 behoben, und `audit.yml`
    ignoriert nur noch die `glib`-Meldung
    ([`AGENTBRIDGE-PATCH.md`](../vendor/russh/AGENTBRIDGE-PATCH.md),
    [`SECURITY.md`](../SECURITY.md)). PR #64; die Abnahme mit RSA-Schlüssel
    lief auf beiden Test-VMs (Letzte Prüfung).
    Offen:
    - **Tauri v3:** Mit ihm fallen die Übergangsschalter
      `android.builtInKotlin=false` und `android.newDsl=false`. Stand am
      23.11.: `3.0.0-alpha.6`; die Android-Vorlage auf dem Hauptzweig setzt
      beide weiter auf `false`. Das neueste 2er-Release ist am 28.11. 2.12.7,
      die App steht auf 2.12.5. Keiner der Fixes aus 2.12.6 und 2.12.7 betrifft
      die App; ein Update bindet alle drei Auswahlen neu und kommt deshalb mit
      einem anderen.
    - **TypeScript 7:** Der native Compiler hat in 7.0 keine stabile JS-API;
      `src/source-hygiene.test.ts`, `src/ipc.contract.test.ts` und
      `release-license-inventory-frontend.mjs` brauchen `ts.createSourceFile`. Stand am 23.11.: 7.0.2 ist das neueste
      Release, 7.1 ist als Beta erschienen; ob sie diese API mitbringt, ist
      nicht geprüft.
    - **Jackson 2.15.3** in der Android-App, über Tauris Android-Bibliothek:
      15 Meldungen, alle in 2.18.11 behoben und für die App nicht erreichbar
      ([`SECURITY.md`](../SECURITY.md)). Tauri 2.12.7 nennt am 28.11. weiter
      2.15.3. Ein Gradle-Constraint auf 2.18.11
      braucht einen eigenen Pull Request; kein Workflow prüft bisher die
      Android-Bibliotheken auf Meldungen (etwa `app/gradle.lockfile` gegen
      OSV in `audit.yml`).
    - **Rust 1.99:** erst, wenn ein Crate sie verlangt. Die Stellen, die die
      Version nennen, gleicht `scripts/rust-toolchain.test.mjs` mit
      `rust-toolchain.toml` ab, die Belege der Standardbibliothek nicht.
    - **Typprüfung der Skripte:** 22 Skripte unter `scripts/` tragen noch
      `// @ts-nocheck` (`tsconfig.node.json`); ein Skript verliert die Marke,
      sobald es mit JSDoc-Typen sauber prüft.
    - **Upstream:** Der Entwurf eines Kommentars zu Eugeny/russh#806 (das
      Close-Verhalten unseres Patches, mit dem zweiten Fall der Antwort auf
      ein lokales Close) ist seit dem 15.11. zurückgestellt: vorerst kein
      Beitrag bei russh (Entscheidungen vom 15.11.). Stand am 23.11.: Das
      Issue ist offen. 0.65.4 behebt seinen Fall, die ausstehenden Daten
      beim empfangenen Close, mit `close_from_peer`, das Zeile für Zeile
      unserem früheren `remote_close` entspricht. Der zweite Fall, die
      Antwort auf ein lokales Close, bleibt im eigenen Patch. Das
      Repository heißt inzwischen Eugeny/russh, der alte Name
      warp-tech/russh leitet weiter.
13. **Review vom 03.11., zurückgestellt:**
    - **Gehashte Einträge in `known_hosts` schreiben** bei `HashKnownHosts
      yes`: am 05.11. vom Maintainer zurückgestellt. Die App schreibt einen
      bestätigten Host im Klartext, liest gehashte Einträge aber; die
      [Grenzen-Anleitung](guide/limits.md) nennt `ssh-keygen -H`. Gründe:
      Unter Windows und macOS setzt kaum jemand die Option, `settings.toml`
      führt dieselben Hosts ohnehin im Klartext, und genau ginge es nur mit
      einer Auswertung der `ssh_config` wie bei OpenSSH (`Host`, `Match`,
      `Include`). Empfehlung vom 08.11., falls das Thema mit den
      Linux-Paketen oder `IdentityAgent` (Punkt 14) wiederkommt: gehasht
      schreiben, wenn die Datei schon gehashte Einträge hat, ohne eigene
      Einstellung. Die ausführliche Abwägung steht im geschlossenen PR #36.
    - **Ablageorte unter macOS:** Nach einem Start ohne Verbindung liegen
      unter `~/Library` nur `WebKit/<id>/WebsiteData` und `Caches/<id>/WebKit`,
      wie `PRIVACY.md` sagt (gemessen am 05.11. auf Apple silicon und Intel,
      PR #31; die Liste läuft bei jedem Push mit). Ob Verbindungen und
      Gebrauch mehr anlegen, prüft die
      [Handabnahme §11](abnahme-handarbeit.md#11-änderungen-aus-dem-code-review-vom-0311),
      Schritt 5.
14. **Review vom 07.11.:** Fünf voneinander unabhängige Prüfungen, die nur
    lasen (Rust-Backend, Sicherheit, Frontend, Aufbau und Release-Ablauf,
    Plattformen), auf `main` (`59bea6a`). Die Fehler mit Wirkung für Nutzer
    behebt PR #42 (CHANGELOG `[0.3.0]`). Offen:
    - **Mindeststand der Webansicht:** entschieden am 07.11. (oben) und mit
      PR #42 in 0.3.0 umgesetzt. Offen: das Build-Ziel auf `safari15.5` und
      `chrome105` heben, mit neuem Lizenzbeleg für die Helfer im Bundle; der
      Hinweis auf eine alte WebView unter Android ist nur in der CI gebaut,
      nicht am Gerät gesehen.
    - **Wildcards und systemweite `known_hosts`:** Hosts, die nur über ein
      Muster (`*.example.com`) oder `/etc/ssh/ssh_known_hosts` bekannt sind,
      fragt die App wie beim Erstkontakt. Am 07.11. vom Maintainer
      zurückgestellt, weil zurückgesetzte Hosts sonst an der strengeren
      Prüfung scheitern. Zuerst kommt ein Weg, den alten Eintrag eines Hosts
      in der App zu entfernen. Auf Android vergisst seit dem 13.11. das
      Entfernen eines Hosts dessen Schlüssel (Nachtrag der Android-Spec); für
      den Desktop, wo die App die Datei mit OpenSSH teilt, fehlt der Weg weiter.
    - **CI und Release:** keine Paketbauten bei reinen Doku-PRs (Frist und
      Wiederholung für den apt-Schritt kamen mit der Prüfung vom 09.11.), die
      volle Lizenzprüfung auch bei geänderten eigenen Quellen,
      CHANGELOG-Einträge je PR; dazu GitHub-Einstellungen: CodeQL läuft seit
      dem 15.11., die ausgewählten Actions sind zurückgestellt (Entscheidungen
      vom 15.11.), die Freigabe für `android-release` ist offen. Seit dem 11.11. setzt
      `npm run bump` die Version auch in der Windows-Auswahl, und
      `scripts/release-version.mjs` prüft bei jedem Push alle Versionsstellen
      (Version, Auswahlen, CHANGELOG, Kurzfassung, Store-Texte, Kopf dieser
      Datei, `SECURITY.md`).
    - **Aufbau:** ein typisierter IPC-Vertrag zwischen Rust und TS ohne neue
      Abhängigkeit, `main.ts` in Controller mit Abbau zerlegen und ein
      gemeinsamer Fehlertyp der Commands. Batch 9 (U3) ist mit PR #67
      erledigt.
    - **Plattformen:** Strg+V und Strg+Klick auf dem Mac (mit der
      Mac-Abnahme, Punkt 9), `IdentityAgent` für 1Password und Secretive,
      Linux-Pakete (deb und rpm), Testhosts mit mehreren tmux-Versionen und
      Shells.
15. **Durchsicht vom 10.11.:** Fünf voneinander unabhängige Prüfungen, die nur
    lasen, auf `main` (`4c61495`); PR #47 behebt, was sich lohnte (oben).
    Offen:
    - **Hostschlüssel anderen Typs:** Ist ein Host mit einem Schlüssel eines
      Typs bekannt und bietet der Server nur einen anderen Typ an, fragt die
      App wie beim Erstkontakt, mit einem Hinweissatz; OpenSSH lehnt das als
      geänderten Schlüssel ab (`check_hostkeys_by_key_or_type`). Jemand im
      Netz kommt so an der harten Ablehnung vorbei zur Rückfrage. Am 10.11.
      vom Maintainer zurückgestellt, solange die App in Entwicklung ist;
      als Grenze in [`SECURITY.md`](../SECURITY.md). Dazu gehören: Wartende
      Rückfragen erscheinen sofort mit aktiven Knöpfen (ein Doppelklick
      bestätigt die nächste ungelesen), und die Entscheidung liest
      `known_hosts` vom Beginn des Aufbaus, nicht erneut vor dem Anhängen.
    - **Sessionliste:** `observe_sessions` braucht 2N+3 Befehle
      nacheinander. Seit dem 16.11. hat der ganze Gang 60 s und jeder Befehl
      15 s (`SESSION_WALK_TIMEOUT`, `DEFAULT_EXEC_DEADLINE`; Nachtrag im
      Absatz „Deadline“ der
      [MVP-Spec](specs/2026-09-05-mvp-und-statuspunkt-design.md)). Mit 15 s
      für alles listete ein Host mit 20 Sessions ab rund 350 ms je Befehl
      nie; das war mit einem Skript-Transport nachgestellt. Am 16.11. an
      einem Host mit tmux 3.3a gemessen, am eigenen Socket
      ([Messung](messungen/messung-2026-11-16-shell-ausgabe-und-listenfrist.md)):
      Bei 0,77 s je Befehl lud die Liste mit 20 Sessions in 36,2 s, auch mit
      dem Poll nebenher. Aus den Zeiten gerechnet, nicht gezählt, waren das
      rund 47 Befehle; die alte Frist reichte
      demnach bis rund 320 ms je Befehl. Mit 40 Sessions endete die Liste
      nach 60,0 s mit einem Zeitfehler, und als die Verbindung stockte, kam
      der Fehler 14,9 s später. Nicht eingetreten ist die Erwartung, ein
      tmux-Server, der mitten im Laden endet, zeige sich nach höchstens
      15 s: Der Fehler kam 29,6 s später, am Ende des laufenden Durchgangs.
      Die Einzelabfragen kehren dann sofort zurück, die Obergrenze ist das
      Budget von 60 s, und das Ergebnis ist ein Fehler, keine falsche Liste.
      Nicht gemessen: der Standard-Socket in derselben Frist und andere
      tmux-Versionen. Während die Liste
      lädt, pausiert der Poll dieses Hosts. Offen bleibt der gemeinsame
      Aufruf: Er ändert die gemessene Folge und braucht eine Messung auf
      tmux 3.0, 3.3a, 3.4 und 3.6.
    - **Startausgabe der Shell:** Seit dem 16.11. erkennt die App eine
      Startdatei, die vor jedem SSH-Befehl schreibt, und nennt sie. Text auf
      der Standardausgabe hält die Host-Prüfung an und lässt keine Liste zu;
      Meldungen nur auf der Fehlerausgabe lassen die Liste nach Namen, mit
      dem Grund an jeder Zeile (`VersionAnswer` in `commands/inventory.rs`,
      [Grenzen](guide/limits.md)). Herausgefiltert wird nichts. Am 16.11. an
      einem Host mit bash 5.2 und tmux 3.3a gemessen, an den Befehlskernen
      und nicht am Fenster
      ([Messung](messungen/messung-2026-11-16-shell-ausgabe-und-listenfrist.md));
      für das Fenster bleiben die zwei Schritte der Handabnahme (§12, A5 und
      A6). Die Erkennung arbeitet in beiden Fällen wie beschrieben. Gemessen
      ist auch, was vorher nur am Code gelesen war: Mit Meldungen auf der
      Fehlerausgabe meldet „New session“ einen unbestätigten Ausgang, obwohl
      die Session entsteht; ein Host ohne Session zeigt den Hinweis zur Shell
      statt einer leeren Liste; das Beenden der letzten Session meldet einen
      unbestätigten Ausgang, obwohl sie endet; Öffnen und Beenden nach Namen
      gehen. Neu aus der Messung, alles in den Grenzen: Mit Text auf der
      Standardausgabe legt „New session“ eine Session an, die die App nicht
      zeigen kann, und die Ordnerliste scheitert. Schreibt die Shell nur mit
      Terminal (`[ -t 1 ]`), bemerken Host-Prüfung und Liste nichts, und
      keine Session öffnet; die Meldung nennt die Shell nicht. Schreibt sie
      nur, wenn sie interaktiv ist (`$-` enthält `i`), stört nichts. Nach
      der neutralen Bewertung der Messung später, nicht für 0.3.6: eine
      Sperre für „New session“, solange die Liste wegen der Shell ausbleibt.
      Erledigt mit Z1.3 des Fahrplans: Text auf der Standardausgabe trägt
      den eigenen Code `shell_stdout` und sperrt „New session“ (Knopf, alle
      Wege über `onNewSession` und das Absenden eines schon offenen
      Dialogs); Meldungen nur auf der Fehlerausgabe behalten `shell_output`
      und sperren nichts. Eine erfolgreiche Liste hebt die Sperre auf. Offen: eine Meldung beim
      Öffnen, die die Shell als möglichen Grund nennt. Nicht gemessen: zsh, andere tmux-Versionen,
      eine Startdatei, die auf Eingabe wartet.
    - **Backend, klein:** Zweite Verbindung und Reparatur lösen den Hostnamen
      neu auf (Round-Robin-DNS kann sie auf zwei Rechner führen);
      `close_terminal` kann sein `open_terminal` überholen (Verdacht, enges
      Fenster). Erledigt mit
      0.3.3: die vergiftete Sperre der Register und die Aufnahme von Auflösung
      und Schlüsselvorbereitung, die jetzt bis zu 5 s auf einen Platz wartet.
      Ein `[profile.release]` fehlt weiter: Ein Überlauf ist nicht
      belegt, und eine Änderung beträfe jede Release-EXE samt Laufzeitbeleg.
    - **Release:** Die Windows-Pakete hängen an den macOS-Jobs (`publish`
      braucht alle vier); kein Starttest der APK in einem Emulator (der
      Versuch vom 06.11. scheiterte am Android-17-Image des Runners, dessen
      surfaceflinger abbricht; Commit `e4f5444`);
      `release-manifest.json` liegt nur 90 Tage als Artefakt vor, nicht am
      Release; das Play-Geheimnis käme in dasselbe Environment wie der
      Signaturschlüssel (vor dem Hinterlegen trennen, wie U2 für Apple); die
      Node-Version ist nur auf `24` gepinnt. Die neuen Schritte (Schranke
      „auf `main`“, Marke „Latest“) liefen beim Tag von 0.3.2 zum ersten Mal
      und hielten; das Release trägt die Marke.
    - **Frontend:** `main()` baut beim Abbau nicht alles ab (Seitenleiste,
      Dialoghülle, Rückfrage; betrifft die Tests). Seit 0.3.3 gibt es
      „Screen reader support“ (mit einem echten Bildschirmleser nicht
      geprüft), und in der Telefonansicht sind auch Felder und Knöpfe der
      Dialoge 40 px hoch; am Gerät ist die Telefonansicht weiter nicht
      angesehen.
    - **Doku:** Seit 0.3.2 steht auf jeder Release-Seite eine englische
      Kurzfassung (`docs/release/notes/<Version>.md`, Entscheidung des
      Maintainers vom 10.11.); das CHANGELOG bleibt deutsch. Ob es auf Englisch
      wechselt, ist offen. Android-Bau und Lizenzroutine sind nur deutsch
      beschrieben. Die Regel zur
      Kommentarsprache beschreibt den Stand nicht (Rust überwiegend deutsch,
      Skripte und Workflows überwiegend englisch). Die Merge-Commits tragen
      die private Mailadresse des Maintainers als Autor; die
      GitHub-Einstellung „Keep my email addresses private“ beendet das für
      künftige.
16. **Durchsicht vom 13.11.:** drei Prüfungen auf `main` (`9a6a03c`), danach
    je ein neutraler Agent je Fund (Letzte Prüfung). Offen:
    - **Umschalt+F10 mit „Screen reader support“:** xterm schickt die Taste
      ans Programm und hält sie nicht an; Chromium macht daraus zusätzlich
      ein Kontextmenü, das je nach Einstellung kopiert, einfügt oder das
      Terminalmenü öffnet. Ohne die Einstellung hält xterm die Taste an. Ob
      sie Menütaste bleibt oder nur ans Programm geht, entscheidet der
      Maintainer, am besten nach dem Test mit einem echten Bildschirmleser.
    - **Innere Sperren:** Die Absicherung der Register aus 0.3.3 erreicht
      `OperationControl`, `ConnectControl`, `HostConnection.state` und
      `Core.stop_gate` nicht. Panikt etwas unter einer davon (nie
      beobachtet), panikt das Aufräumen beim Abwickeln erneut, und die App
      bricht ab. Vorschlag mit niedriger Priorität: der Helfer von
      `registry()` für alle Sperren, die ein `Drop` erreicht (rund 45
      Stellen); ungeprüft ist, ob `HostConnection.state` nach einer Panik
      mitten in einer Änderung stimmig bliebe.
    - **CI:** `tests/socket_abort_probe.rs` scheiterte unter macOS dreimal
      (Lauf 40909348883 zweimal, 42359933034 einmal); jede Wiederholung
      bestand. Untersucht am 16.11.: Der Abbruch war jedes Mal richtig
      (`ConnectionAborted`), falsch war der Beweis des Tests für
      „gesättigt“. macOS vergrößert die Loopback-Puffer nach dem ersten
      abgewiesenen Schreiben und nimmt danach weiter an. Der Test wartet
      jetzt auf ein ganzes Fenster ohne weiteres Byte. Ob das reicht, zeigen
      erst mehrere Läufe der CI.
    - **Aufbau und Tests:** Die Tests aus `settings.rs` können ohne Änderung
      nach `settings/tests.rs`. Batch 9 (U3) lief wie geplant und nicht
      erweitert, mit PR #67 zu Beginn von Zug 1. Vom
      IPC-Vertrag (Punkt 14) lohnt vorerst nur ein Vertragstest, der die
      Aufrufe des Frontends gegen die Rust-Quellen prüft. Erledigt mit Z1.4:
      `src/ipc.contract.test.ts` liest jeden `invoke(...)` in `src/` und
      jeden `#[tauri::command]` und prüft Namen, Pflicht- und optionale
      Parameter, auch die aus `...socketArg` und `...includeDefaultArg()`.
      Die Rückgabetypen prüft er nicht. Der Abbau von
      `main()` (Punkt 15) betrifft nur Tests. Nicht übernommen: ein
      gemeinsames strenges Fake-Backend für die Tests und kürzere
      Zeitkonstanten unter `cfg(test)`; beides kostet mehr, als es bringt.
    - **Paketbauten bei Doku-PRs (Punkt 14):** Seit Z1.6 (Entscheidung E12
      vom 23.11.) baut `packages.yml` bei Pushes und Pull Requests nicht,
      die nur Prosa ändern: `docs/` außer `docs/release/` und die
      Markdown-Dateien im Wurzelverzeichnis außer
      `THIRD_PARTY_LICENSES.md`. Ein Tag baut immer.
      `scripts/release-workflows.test.mjs` hält die Liste fest. `android.yml`
      ist eine gebundene Eingabe der Android-Auswahl und folgt mit dem
      nächsten Release.
17. **Seitenleiste und Grundtöne (Spec vom 14.11.):** ausgeliefert mit
    0.3.5, vor dem Release nur im Headless-Browser gegen Beispieldaten
    angesehen. Am 15.11. meldete der Maintainer, 0.3.5 laufe unter Windows
    und Android bisher sehr gut; einzeln abgenommen sind die Punkte unten und
    die von Punkt 18 damit nicht. Offen:
    - **Am Fenster:** die sechs Punkte aus §7 der Spec (Grundtöne bei
      laufenden Kacheln, Symbolleiste bei Zustandswechseln, Skalierung,
      Bildschirmleser, Android-Tablet, Kontrastdesign).
    - **Zurückgestellt (§6 der Spec):** helles Thema, Aktionen in der
      Symbolleiste, weitere Darstellungsoptionen.
18. **Statusanzeige und Knopfleiste (Spec vom 14.11.):** ausgeliefert mit
    0.3.5, vor dem Release nur im Headless-Browser gegen Beispieldaten
    angesehen; zur Meldung des Maintainers vom 15.11. siehe Punkt 17. Offen:
    - **Am Fenster:** die sechs Punkte aus §8 der Spec (Knopfleisten bei
      mehreren aufgeklappten Hosts mit Maus und Tastatur, Zustandswechsel bei
      laufenden Agenten, Kopf der Wartet-Spur bei 208 bis 320 px, Skalierung,
      Kontrastdesign, Bildschirmleser).
    - **Aufräumen in `sidebar.ts`:** Die Markierung des aktiven Hosts
      (`sb-host-block--active`, `--held`) und `sb-list--pressing`
      tragen keine Darstellung mehr. `frozenHostId` bleibt nötig als
      Kennzeichen „ein Druck läuft“ für das zurückgehaltene Neuzeichnen; der
      Rest lässt sich abbauen.
    - **Aufräumen in `sidebar-rail.ts`** (Durchsicht vor dem PR): Die
      Zuordnung Hostzustand zu Form und Wort samt der Regel für das
      Neuverbinden steht dort ein zweites Mal neben `hostIndicator` in
      `sidebar.ts`, die Suche nach dem Host der fokussierten Kachel ein
      drittes Mal; beides gehört an eine Stelle. In der kompakten Ansicht
      zeichnet die Symbolleiste mit, obwohl das Stylesheet sie dort
      herausnimmt.
    - **Dichte:** Das Tor aus UI v2 §17 Punkt 2 (vier Hosts, zwanzig
      Sessions unter 760 px) ist mit einer Leiste je Host aufgegeben, rund
      850 px statt 736 (§5 der Spec).
    - **Kontrastdesign:** Gefüllte Zeichen (Punkt, Raute, Quadrat) fallen dort
      weg, das Wort trägt. In der Zeile der fokussierten Kachel steht nur das
      Zeichen; dort bleibt im Kontrastdesign allein „Idle“ und „Unknown“
      sichtbar (vorher stand dort gar kein Status).
    - **Nicht gebaut (§7 der Spec):** andere Wörter („Needs input“,
      „Working“), Bewegung an „Busy“ (UI v2 §14), ein Streifen an wartenden
      Kacheln, eine Übersichtszeile, Filter nach Status.
19. **Erststart (Spec vom 15.11.):** ausgeliefert mit 0.3.6 (PR #61,
    `1fdcc20`). Der
    Weg eines neuen Nutzers bis zur ersten Session wurde im Headless-Browser
    gegen Beispieldaten nachgestellt, vorher und nachher, in Desktop- und
    Telefongröße; am Fenster und an einem echten Host ist nichts davon
    geprüft. Offen:
    - **Am Fenster:** die fünf Punkte aus §10 der Spec (ein echter erster
      Start gegen einen echten Host, „Check again“ nach nachinstalliertem
      tmux, ein Schlüssel, den der Host nicht annimmt, auch am ssh-agent,
      „New session“ unter dem frisch gespeicherten Host auf Telefon oder
      Tablet, Bildschirmleser).
    - **Vorschläge aus §9 der Spec:** entschieden (Entscheidungen vom
      16.11.). Offen bleibt daraus nur die Tastenleiste auf dem Telefon, als
      eigener Android-PR vor dem geschlossenen Test (ändert Android-Spec
      §5.2).
    - **Nachzügler aus der Bewertung vom 16.11., ohne Eile:** Die tmux-Zeile
      der Host-Prüfung trägt auch bei einer zu alten Version einen Haken
      (ein `tmux_ok` im DTO behöbe es). „Check again“ auf einer toten
      Verbindung sollte nur „Back“ anbieten. `MethodNotOffered` vergleicht
      Zeichenketten statt eines Enums (`ssh/auth.rs`). Das Passwortfeld
      erscheint nach jedem `auth_rejected` des Agenten, auch bei
      `MultiFactorRequired` und `SigningFailed`. Das Store-Bild 3
      (`phones`) zeigt den alten Erststart und wird beim nächsten Release
      neu erzeugt.
20. **CodeQL für Rust:** ein Klick des Maintainers, die REST-Schnittstelle
    kann es nicht: Settings → Advanced Security → Code scanning → CodeQL
    analysis → „⋯“ → View CodeQL configuration → Edit → Rust ankreuzen →
    Save. Die Query-Suite bleibt auf Default, Python und Java/Kotlin bleiben
    aus. Danach muss
    `gh api "repos/ITBrain258/aidevbridge/code-scanning/analyses?ref=refs/heads/main"`
    einen Eintrag der Kategorie `/language:rust` mit leerem `error` zeigen.
    Der erste Lauf bringt einen unbewerteten Stapel Funde; die Regeln dafür
    stehen bei den Entscheidungen vom 16.11. Bietet der Dialog Rust nicht an
    oder erscheint keine solche Analyse, ist der Ausweg ein eigener Workflow
    für alle drei Sprachen (`build-mode: none`), nachdem das Default Setup
    abgeschaltet ist; beides zugleich nimmt GitHub nicht an. Ob der Dialog
    Rust anbietet, ist nur aus GitHubs Doku bekannt.
21. **Durchsicht vom 28.11.:** nach P1 des Fahrplans nur der Diff seit der
    Durchsicht vom 17.11. (`12c5a9b` bis `c760eeb`): zwei neutrale Agenten
    für `src-tauri/` und `src/`, `.github/` und `scripts/` selbst gelesen.
    Audit grün, keine Meldung von Dependabot oder CodeQL offen, kein schwerer
    Fehler. Die Funde sind am Code nachgelesen, keiner ist beobachtet.
    - **Mit Effekt für Nutzer, für 0.3.9 (Entscheidung vom 28.11.):**
      - Die Sperre für „New session“ (PR #72) lebt nur im Frontend. Wird der
        Dialog direkt nach dem Verbinden abgeschickt, verwirft die App den
        Fehler `shell_stdout` der ersten Liste; ein späterer Listenfehler
        anderer Art hebt die Sperre auf. Jeder Versuch legt dann eine Session
        an, die erst nach „Reload sessions“ erscheint. Abhilfe: Das Backend
        prüft selbst, bevor es anlegt.
      - Eine Shell, die nur Leerzeilen auf die Standardausgabe schreibt,
        entgeht `shell_stdout`; der Grund an der Liste nennt dann tmux.
      - Das Beenden der letzten Session gilt unter Last als unbestätigt,
        weil „server exited unexpectedly“ nicht als „Server weg“ zählt.
        PR #68 hat dafür nur den Test angepasst.
      - Die Rückfrage zu „Kill“ erscheint nach einem Neuverbinden von selbst
        wieder, wenn sie beim Abbruch der Verbindung offen war.
    - **Latent:** Die Wiederholung des `rename` unter Windows hilft nicht,
      wenn ein fremder Prozess die Zieldatei auch fürs Lesen sperrt (kein
      Rückschritt). Die Rückfrage zu „Kill“ folgt einer neueren Session
      gleichen Namens. Ein Anlegen, das hinter einem „Kill“ wartet, läuft
      trotz Sperre.
    - **Testlücken:** der Claude-Grund im Listenpfad auf Befehlsebene; der
      Code `shell_output`; die Felder der übergebenen Objekte im
      IPC-Vertragstest (er prüft nur die Argumentnamen); der Ausreißer
      `a_stalled_session_does_not_take_the_whole_connection_down`.
    - **Kleinigkeiten:** Claudes Fehlerausgabe geht verloren; der Grund am
      gesperrten Knopf steht nur im `title` und ist mit Tastatur und
      Bildschirmleser nicht erreichbar; Hinweis und Banner sagen „retry“ und
      „reload“ für dasselbe.

Push, Tag und Release entscheidet der Maintainer jeweils eigens.

## Feste Vorgaben

Aus den Specs und ihren Nachträgen; bei Abweichung gilt die Spec.

- Windows-Client: nur die App, kein Python, kein weiterer Installer.
- Auf den Hosts nur SSH, tmux und ein von Hand gestarteter Agent. Kein Hook,
  kein Watcher, keine Konfigurationsänderung, kein eigener Startdialog.
  tmux und die übrigen Voraussetzungen richtet der Nutzer selbst ein; die App
  installiert nichts, auch nicht auf Knopfdruck (Entscheidung vom 15.09.,
  siehe [Hosts and tmux](guide/hosts.md#host-requirements)).
- Status: Das Inventar liefert unbekannt und beendet. `claude agents --json`
  wird nur gelesen und bindet an `pid == pane_pid` oder ein direktes Kind der
  Pane-Shell, nie über den Namen. Codex und Grok zählen über den Panetitel,
  nur in gemessenen Formen. agy, OpenCode und Gemini CLI bleiben „Unknown“,
  bis es ein tragfähiges Signal gibt.
- Der Poll führt die Sessionliste nicht: kein Hinzufügen, Entfernen,
  Umbenennen oder Schließen von Kacheln.
- Passwörter und Passphrasen werden nicht gespeichert, auch nicht im
  Arbeitsspeicher über einen Verbindungsversuch hinaus. Selbstheilung gibt es
  deshalb nur für Schlüssel und ssh-agent.
- Eigene tmux-Serveroptionen auf dem App-Socket sind erlaubt
  (`history-limit`, `remain-on-exit`, `terminal-overrides`, seit 22.10.
  `status off` vor jedem Anhängen, siehe
  [UX-Spec](specs/2026-10-11-ux-ueberarbeitung-design.md) §6.8); `mouse` und
  `set-clipboard` setzt die App nicht. Der App-Socket heißt `agentbridge`,
  auch nach der Umbenennung.
- Tests gegen echte Hosts nur mit eigenem Testsocket, nie mit produktiven
  Sessions ([CONTRIBUTING](../CONTRIBUTING.md#live-tests-against-a-test-host)).
- Jede weitergegebene Kopie trägt die Lizenzhinweise (Punkt 6).
- Das Tor sind die lokalen Prüfungen aus der
  [Build-Anleitung](guide/building.md#tests); `.github/workflows/ci.yml` führt sie bei
  jedem Push und Pull Request aus.

## Wo was steht

- [MVP- und Statusspec](specs/2026-09-05-mvp-und-statuspunkt-design.md):
  Zuschnitt, Tore, Statusdesign, Nachträge vom 13.09., 14.09. und 15.09.
- [UX-Überarbeitung](specs/2026-10-11-ux-ueberarbeitung-design.md) vom
  11.10.: Zwischenablage, Verbindung und Selbstheilung, Arbeitsplatz,
  Tastatur, Einstellungen, tmux 3.6. Sie geht den älteren Specs vor, wo sie
  ihnen widerspricht (§4); §14 nennt, was bewusst fehlt.
- [Dynamisches Raster und Wartet-Spur](specs/2026-10-19-dynamisches-raster-design.md)
  vom 19.10.: bis zu 9 Kacheln, Grenzen je Host, Tauschen, Spalt, Bewegung,
  Wartet-Spur, die Lastmessung (§12). Sie geht den älteren Specs vor, wo sie
  ihnen widerspricht (§11).
- [Gesamtspec](specs/2026-07-25-agentbridge-design.md): Transport,
  tmux, Kanalmodell; gilt, wo die MVP-Spec nichts anderes sagt.
- [UI-v2-Spec](specs/2026-09-05-ui-v2-design.md) mit Mockup, dazu
  die Specs zu [Einstellungen](specs/2026-09-14-einstellungen-geruest-design.md)
  und [Farbwahl](specs/2026-09-14-farbwahl-design.md). Für
  Verhalten (Fokus, Resize, Maximieren, Leer- und Fehlerzustände) gilt das
  [Designsystem v1](specs/2026-07-27-agent-management-shell-designsystem.md)
  weiter.
- Pläne unter `plans/`: der [Fahrplan vom 23.11.](plans/2026-11-23-fahrplan.md)
  mit den Zügen nach 0.3.6, der [Umsetzungsplan vom 26.10.](plans/2026-10-26-review-umsetzung.md)
  (Batch 9 erledigt mit PR #67) und der [Android-Plan](plans/2026-10-27-android.md)
  (Abnahme am Gerät, Play). Erledigte Pläne, etwa die Roadmap vom 05.09. und
  der Plan zum Standard-Socket, stehen in der Git-Historie.
- [Handabnahme](abnahme-handarbeit.md): was nur am echten Fenster prüfbar
  ist, mit Log.
- Messberichte `messungen/messung-*.md`: die, die Specs, Code und Tests
  zitieren; ihre Rohdaten unter `messungen/fixtures/`, die Messhelfer
  `scripts/m1-*`. Die Messhelfer sind Nachweiswerkzeuge, kein Produktteil.
  Rohdaten und Messskripte nennen mitunter Commits der privaten
  Entwicklungshistorie; dieses Repository beginnt mit einem Anfangs-Commit.
- Lieferung unter `release/`: die
  [Lizenzauswahl](release/license-selection.windows-x64.json) mit den
  Entscheidungsberichten und Inventaren, die sie bindet, die ausgelieferten
  Lizenztexte, die Quellarchive der Installerwerkzeuge sowie die Texte für
  Installer und ZIP; dazu `THIRD_PARTY_LICENSES.md` im Wurzelverzeichnis.
  Die datierten Berichte und Inventare vom 12.09., die Lizenzauswahl und die
  Inventarskripte unter `scripts/` nennen als Herkunft Commits der privaten
  Entwicklungshistorie; sie sind hash-gebunden und bleiben, wie sie sind.
- macOS-Lieferung: [Spec](specs/2026-10-25-macos-lieferung-design.md), die
  [macOS-Lizenzauswahl](release/license-selection.macos-universal.json) mit
  [Bericht](release/license-macos-universal-2026-10-25.json) und Inventar
  vom 25.10., erzeugt von `scripts/release-license-select-macos.mjs`; Bau mit
  `scripts/release-macos-artifacts.mjs`. Alle Installer baut, testet und
  veröffentlicht `.github/workflows/packages.yml`; den Release-Text schreibt
  `scripts/release-notes.mjs`.
- russh-Patch: [Herkunft, Umfang und Lizenz](../vendor/russh/AGENTBRIDGE-PATCH.md)
  und der [Patchbericht](reviews/2026-09-11-neutral/russh-channel-close-patch.md)
  zum Kanalschluss. Die Bibliotheks- und Integrationstests des eingebetteten
  russh laufen in `.github/workflows/vendored.yml`.
- Bilder im README, Vorschaubild für Links und Telefonbilder des Store-Eintrags:
  `scripts/readme-images/render.mjs` rendert die echte Oberfläche mit
  Beispieldaten nach `docs/images/` und `fastlane/`, ohne Host und ohne neue
  Abhängigkeit. Das Vorschaubild lädt der Maintainer unter Settings → General →
  Social preview von Hand hoch; dafür gibt es keine Schnittstelle.
- [`SECURITY.md`](../SECURITY.md): Meldeweg und Einordnung bekannter
  Meldungen. [`CONTRIBUTING.md`](../CONTRIBUTING.md): Bauen, Tests,
  Live-Tests und Sprachregel.
