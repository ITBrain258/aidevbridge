# Changelog

Format nach Keep a Changelog, Versionen nach SemVer. Vor 1.0 kann jede
Minor-Version brechen. 0.1.1 und 0.1.2 erschienen nur privat und noch unter
dem Namen agentbridge.

## [Unreleased]

### Added

- Android: aidevbridge laeuft auf Telefonen und Tablets ab Android 7.0 (Spec `docs/specs/2026-10-27-android-design.md`). Bis 720 px Breite zeigt die App eine kompakte Ansicht: oben eine Leiste mit "Sessions" und der fokussierten Session, darunter genau ein Terminal; die Seitenleiste ist eine Schublade darueber, die Zurueck-Geste schliesst sie. Unter dem Raster steht eine Tastenleiste mit Esc, Tab, Ctrl, Alt, Pfeilen, Home/End, PgUp/PgDn und `| ~ / -`; Ctrl und Alt gelten fuer die naechste Taste, auch von der Bildschirmtastatur. Wischen rollt das Terminal und laeuft nach schnellem Loslassen aus; bei tmux mit `mouse on` geht es als Mausrad an tmux. Statt ssh-agent bietet das Anmeldungsmenue "Generate new key..." (ed25519 in der App, mit der Zeile fuer `authorized_keys` zum Kopieren) und uebernimmt mit "Choose file..." eine private Schluesseldatei in die App. Hosts, Schluessel und `known_hosts` liegen im privaten Speicher der App und gehen in keine Android-Sicherung. Der Desktop aendert sich nicht.
- CI: Der Workflow `android.yml` baut bei jedem Push auf `main` und jedem Pull Request eine unsignierte Vorschau-APK. Ein Tag `v*` baut App Bundle und APK fuer arm64, armv7 und x86_64, signiert sie in einem eigenen Job, der als einziger den Schluessel aus dem Environment `android-release` bekommt, haengt `aidevbridge-<version>-android.apk` mit Build-Provenienz an das Release und schreibt einen Abschnitt "Android" in dessen Text; mit dem Secret `PLAY_SERVICE_ACCOUNT_JSON` laedt er das App Bundle zu Google Play. Store-Texte und -Grafiken liegen unter `fastlane/metadata/android/`, die Datenschutzerklaerung in `PRIVACY.md`, die Anleitung fuer die Veroeffentlichung in `docs/android-veroeffentlichung.md`.
- Lizenzen: Die Android-App liefert die Lizenztexte ihrer Fremdsoftware als `assets/licenses/` mit, aus der neuen Auswahl `docs/release/license-selection.android-universal.json` (`scripts/release-license-select-android.mjs`): die Rust-Krates und die Rust-Standardbibliothek der drei Android-Ziele, die eingelinkten Teile des NDK (libunwind, compiler-rt, Bionic-Startobjekte) und jede Java- und Kotlin-Bibliothek der Gradle-Lockdatei samt der NOTICE-Dateien von Jackson, Kotlin und kotlinx. cssparser, selectors und dtoa-short stehen unter MPL-2.0 und sind auf Android Teil der App; ihr Eintrag nennt die unveraenderte Quelle. Der Release-Lauf von `android.yml` prueft jede Datei in der APK.

- CI: Der Workflow `audit.yml` prueft `Cargo.lock` und `package-lock.json` woechentlich, bei jeder Aenderung eines Lockfiles und auf Knopfdruck auf bekannte Sicherheitsmeldungen. RUSTSEC-2023-0071 (`rsa`) ist mit Begruendung ausgenommen, siehe `SECURITY.md`.
- Releases: Die Dateien, die der Lauf eines Tags an das Release haengt, tragen eine Build-Provenienz von GitHub. `gh attestation verify <Datei> --repo ITBrain258/aidevbridge --signer-workflow ITBrain258/aidevbridge/.github/workflows/packages.yml --source-ref refs/tags/v<Version>` prueft sie samt Workflow und Tag (GitHub CLI 2.68 oder neuer). Beim Push eines Tags nennt die Provenienz den gebauten Commit, auch wenn der Tag waehrend des Laufs verschoben wird. Fruehere Releases haben keine.

### Changed

- CI: Der Workflow `packages.yml` ersetzt `macos.yml` und baut bei einem Tag `v*` alle Installer: MSI, Setup-EXE und ZIP mit `npm run build:windows` auf Windows und das DMG auf macOS. Jedes Paket wird auf einem frischen Runner installiert und gestartet, bis das Fenster erscheint; danach haengt der Workflow alle an das Release des Tags und schreibt je einen Abschnitt fuer Windows und macOS in dessen Text (`scripts/release-notes.mjs`). Ein Handlauf mit einem bestehenden Tag haengt an, was dessen Release noch fehlt.
- CI: Alle Actions sind per Commit gepinnt, Dependabot haelt sie aktuell, und Checkouts behalten keine Zugangsdaten. Das Veroeffentlichen ersetzt keine Datei mehr: Fehlt einer Plattform ein Teil ihrer Dateien und weicht eine schon angehaengte Datei vom neuen Bau ab oder hat keinen Digest, bricht der Lauf ab, bevor er etwas anhaengt. Hat eine Plattform schon alle Dateien mit genau den Bytes des Laufs, schreibt er ihren Abschnitt im Releasetext noch einmal, auch wenn nichts mehr hochzuladen ist; so fehlen ihre Hashes nicht, wenn ein frueherer Versuch nach dem Hochladen abbrach. Ein Handlauf, der einen Tag nennt, wartet auf den Lauf dieses Tags und umgekehrt.
- Hosts anlegen, aendern und entfernen und die Einstellungen der Oberflaeche speichern `settings.toml` nicht mehr auf dem Hauptthread: Das Fenster steht nicht still, waehrend die Datei auf die Platte geschrieben wird. Die Speichervorgaenge eines Fensters laufen weiter nacheinander.
- `SECURITY.md` fuehrt bekannte Grenzen und akzeptierte Risiken an einer Stelle, je mit Begruendung und Weg zur Loesung: den SHA-1-Rueckfall bei Servern, die nur `ssh-rsa` anbieten, die fehlende erneute Pruefung des Hostschluessels beim Rekey, RUSTSEC-2023-0071, den russh-Servercode, die unsignierten Pakete und mehrere Fenster zugleich. Sie beschreibt auch die macOS-Lieferung.

### Fixed

- Ein Terminal oeffnet auch dann, wenn auf demselben tmux-Server gerade eine andere Session entsteht oder endet, etwa bei zweimal "New session" kurz nacheinander. Bisher scheiterte das Oeffnen mit "attach identity changed"; jetzt liest die Bestaetigung nach dem Anhaengen erneut, hoechstens viermal. Aendert sich die gewaehlte Session selbst, scheitert es weiter sofort.
- Statusabfrage: Die App liest tmux' Standard-Socket neben dem eigenen Socket statt danach, und die naechste Abfrage beginnt 2 s nach dem Beginn der vorigen statt 2 s nach ihrem Ende, fruehestens 0,5 s danach. Unter vier ungebremst ausgebenden Kacheln zeigt die Seitenleiste einen wartenden Agenten wieder binnen 4 s (gemessen hoechstens 3,3 s statt bis 5,0 s).
- Tastendruecke zwischen dem Klick auf eine Session und dem Anhaengen gehen nicht mehr verloren, ebenso die Antworten des Terminals auf die Abfragen von tmux: Die Kachel puffert sie und sendet sie nach dem Anhaengen in derselben Reihenfolge. Scheitert das Oeffnen, wird die Kachel vorher geschlossen oder gesperrt oder bricht die Verbindung ab, verwirft sie den Puffer. Einfuegen wirkt weiter erst in der angehaengten Kachel: Vorher weiss sie nicht, ob das Programm Bracketed Paste nutzt, und mehrzeiliger Text liefe Zeile fuer Zeile.
- Ein Fehler in einem Teil der Oberflaeche haelt die uebrigen nicht mehr an. Scheitert das Lauschen auf Terminalereignisse, meldet die Kachel einen Oeffnungsfehler und gibt ihren Platz unter den Oeffnungen ihres Hosts frei, statt still zu warten.
- Meldungen setzen jeden Wert genau einmal ein: Ein Hostname oder Anzeigename wie `a{message}` steht woertlich in der Meldung, statt ein zweites Mal ersetzt zu werden.
- Ein Hostname, der nie einer sein kann, wird vor dem Verbinden und vor dem Speichern mit einer klaren Meldung abgewiesen: leer, mit Leerzeichen, Steuerzeichen oder einem der Zeichen `, * ? ! [ ] | @ # / \`, etwa `user@host`. `~/.ssh/known_hosts` bekommt so keine Zeile, die OpenSSH als Muster liest. IPv6-Adressen mit Zone, `_` und internationale Namen gehen weiter.
- Lehnt der ssh-agent eine Signatur ab (abgelehnte Bestaetigung bei `ssh-add -c`, FIDO-Schluessel ohne Beruehrung), meldet die App "Secure signing failed" statt "Host not reachable" und versucht es nicht mehr automatisch erneut.
- Laesst sich nach dem Beenden einer Session nicht pruefen, ob sie wirklich endete, meldet die App das und bittet, die Sessionliste neu zu laden, statt die Session als beendet zu zeigen. Die Meldung nennt die Ursache und die Bitte je genau einmal.
- Die Vorschlaege aus `~/.ssh/config` beim ersten Start lesen die Datei wie OpenSSH: `Match`-Bloecke, `Schluessel=Wert`, Werte in Anfuehrungszeichen (etwa ein `IdentityFile`-Pfad mit Leerzeichen) und mehrere Muster in einer `Host`-Zeile. Es gilt der erste Wert; ist er unbrauchbar, bleibt das Feld leer.
- `settings.toml` wird dauerhaft geschrieben, ueber eine eigene temporaere Datei, die vor dem Umbenennen auf die Platte gebracht wird. Jede Aenderung liest die Datei neu und fuehrt nur sich selbst aus; schrieb ein anderes Fenster der App dazwischen, wiederholt sie sich auf dem neuen Inhalt und meldet nach drei Versuchen den Konflikt, ohne zu schreiben. Hosts eines anderen Fensters gehen so nicht mehr verloren. Temporaere Dateien eines abgebrochenen Speicherns, die aelter als zehn Minuten sind, entfernt der naechste Start.

### Security

- Ein Startordner mit `#` (etwa `C#Project`) startet eine neue Session jetzt genau dort. tmux wertete `#` im Startordner als Format aus: Solche Ordner starteten still in `$HOME`, und ein Ordner namens `#(befehl)` fuehrte den Befehl auf dem Host aus.
- Abhaengigkeiten im SSH-Pfad aktualisiert: crypto-bigint 0.7.10, ctutils 0.4.6 und tokio 1.53.3 beheben RUSTSEC-2026-0387, RUSTSEC-2026-0385 und RUSTSEC-2026-0386. Lizenzen und Lizenztexte bleiben gleich (`docs/release/license-rust-crypto-tokio-2026-10-26.json`).
- Die WebView hat nur noch die Rechte, die das Frontend nutzt (Ereignisse, Fenstertitel, Aufmerksamkeit, Dateiauswahl), statt `core:default`. Die Content-Security-Policy erlaubt keine `blob:`-Worker und keine `data:`-Schriften mehr und setzt `base-uri`, `form-action` und `object-src` auf `'none'`.

## [0.2.3] - 2026-10-25

An der App selbst aendert sich nichts; neu ist die Lieferung fuer macOS.

### Added

- macOS: ein Disk-Image fuer macOS 11 und neuer, ein Universal-Binary fuer Apple silicon und Intel, vorerst nur ad-hoc signiert. `npm run build:macos` baut es und prueft Architekturen, gelinkte Systembibliotheken, Inhalt des Bundles, Signatur und Inhalt des DMG; die Lizenztexte liegen in der App unter `Contents/Resources/licenses`. Die App fragt unter macOS 15 einmal nach dem Zugriff auf das lokale Netz, wenn sie einen Host dort erreicht. Signatur mit Developer ID und Notarisierung schalten sich ein, sobald die Apple-Secrets im Repository liegen.
- CI: Der Workflow `macos.yml` baut bei jedem Push und Pull Request ein Vorschau-DMG, installiert es auf einem Apple-silicon- und einem Intel-Runner und startet die App, bis ihr Fenster erscheint. Ein Tag `v*` baut das Release-DMG und haengt es samt `.sha256` an das Release des Tags, ohne Release legt er es an. Die Rust-Pruefungen laufen auch auf macOS.
- Eigene Lizenzauswahl fuer macOS (`docs/release/license-selection.macos-universal.json`), abgeleitet aus der Windows-Auswahl; `release-licenses.mjs` und `release-license-rebind.mjs` kennen die Profile `windows-x64` und `macos-universal`.

## [0.2.2] - 2026-10-25

### Added

- Sessions auf tmux' Standard-Socket, also die von einem einfachen `tmux` oder `tmux new`: Sie stehen unter jedem Host unter den eigenen als Gruppe "tmux sessions" und tragen in Kachelkopf, Wartet-Spur und Schnelloeffnen das Kennzeichen "tmux". Oeffnen haengt die App als weiteren Client an, ueber denselben geprueften Waechter wie bei eigenen Sessions und mit `attach-session -E`, damit `SSH_AUTH_SOCK`, `DISPLAY` und die uebrigen Namen aus `update-environment` der Session bleiben. Die App setzt dort keine Option, keinen Hook und keine Umgebung und beendet keine Session; "End session…" gibt es fuer sie nicht. Bedient werden Server mit tmux 3.3a und 3.6; fuer einen anderen nennt die Seitenleiste die Version. Sessions einer Sitzungsgruppe (`tmux new -t`) stehen in der Liste, lassen sich aber nicht oeffnen. Neue Sessions des Standard-Sockets erscheinen nach der naechsten Statusabfrage, hoechstens alle 10 s je Host.
- Schalter "Show tmux sessions" im Host-Dialog, Vorgabe an, auch fuer bestehende Hosts (`show_default_socket` in `settings.toml`). Aus, liest die App den Standard-Socket dieses Hosts gar nicht.
- Haengt an einer Session des Standard-Sockets schon ein anderer Client, sagt ein neutraler Hinweis beim Oeffnen einmal je Lauf, dass tmux das Fenster jetzt nach der Kachel bemisst.
- Gespeicherte Kacheln von Sessions des Standard-Sockets kommen nach einem Neustart zurueck, sobald die Liste ihres Hosts da ist. 0.2.1 verwirft solche Kacheln beim Lesen.

### Changed

- Liste und Statusabfrage lesen beide Sockets getrennt: Ein Fehler des Standard-Sockets laesst die eigenen Sessions aktuell, und sein Status veraltet allein.
- Die Bestaetigung nach dem Anhaengen prueft nur noch die Zeile des eigenen Clients streng. Ein anderer Client am selben Server, etwa im Kontrollmodus oder an einer Konsole ohne `/dev/pts/N`, laesst das Oeffnen nicht mehr scheitern.

## [0.2.1] - 2026-10-25

### Changed

- Agentstatus gegen die aktuellen Agentversionen gemessen: Claude Code 2.1.309, Codex 0.163.0 und 0.164.0 (Grok nicht erneut). Es gibt keine feste Versionsliste: jede Version zaehlt, solange ihre Ausgabe die gemessene Form hat; eine andere Form ergibt weiterhin unbekannt.
- Claude Code: Der Wartegrund "goal proposal" (neu in 2.1.309, dort eine Freigabe) ergibt wartet statt unbekannt.
- Codex: Die App liest die `tui`-Schluessel aus `/etc/codex/config.toml` und `$CODEX_HOME/config.toml`, nur solange Codex laeuft und nur diese Schluessel. Mit `tui.animations` oder `tui.effects.progress` aus zaehlt nur noch wartet, sonst unbekannt; mit eigenen Titelelementen (`tui.terminal_title`) unbekannt. Bisher zeigte ein arbeitendes Codex mit solchen Einstellungen untaetig. Ein Titel mit "Action Required" oder dem Mikrofonzeichen "●" vorn ergibt nie untaetig.
- Titelquelle: Der Agent einer Pane gilt ueber die Programmdatei (`/proc/<pid>/exe`) statt ueber den Prozessnamen, den ein Programm selbst setzen kann; ein Skript namens `codex` ist kein Codex. Titel ueber 1024 Byte und Pfade ueber 4096 Byte werden nicht gelesen. agy, das sich beim Start selbst ersetzt und aus `agy.<Ziffern>.old` weiterlaeuft, gilt weiter als agy.

### Fixed

- Eine Kachel haengt sich nach dem Verlust ihres Kanals nicht mehr still an eine neue Session gleichen Namens: Wurde die Session beendet und unter demselben Namen neu angelegt, zeigt die Kachel "This session has ended on the host" ohne Reconnect. Bisher las die Probe nach dem Verlust die Liste neu, und die Kachel zeigte danach die fremde Session (gefunden im M1-Tor).
- Nach einem Neustart zeigt die wiederhergestellte Kachel einer beendeten Session nur noch die Sperrleiste mit "This session has ended on the host", ohne das Banner "Couldn't open …" daneben. Die Sessionliste meldet eine tote Pane jetzt wie die Statusabfrage als beendet; bisher meldete sie unbekannt, und ein Neuladen der Liste setzte einen schon beendeten Status bis zur naechsten Abfrage zurueck (gefunden im M1-Tor).
- Beim Start mit gespeicherten Kacheln mehrerer Hosts aendern die Kacheln des zuerst verbundenen Hosts nicht mehr ihre Groesse, wenn ein weiterer dazukommt; Codex verlor dabei seinen Verlauf. Die App legt die Kacheln jetzt erst an, wenn jeder Host, den sie selbst verbindet, seine Liste hat oder sein Versuch endete, hoechstens nach 5 s, und dann alle auf einmal. Oeffnet der Nutzer vorher selbst eine Session, kommen die schon gelisteten sofort, vor seiner Wahl. Ein Host, der spaeter kommt, reiht seine Kacheln wie bisher ein.
- Eine grosse Einfuegung haelt die Oberflaeche nicht mehr sekundenlang an. Eingabe ueber 64 KiB geht in Teilen hinaus, je Terminal der Reihe nach; was waehrenddessen getippt wird, reiht sich dahinter ein, und scheitert ein Teil, entfaellt der Rest mit einer Meldung. Bisher stand die Seite bei 8 MB rund 6 s still, und mit ihr Eingabe, Groessenaenderung und Schliessen aller anderen Terminals; jetzt sind es rund 2,6 s, die das Einfuegen selbst braucht.
- In einer Kachel unter 260 px Breite bleibt der Titel lesbar: Der Host weicht, die Statuspille zeigt nur ihren Punkt (das Wort steht im Tooltip und fuer Bildschirmleser), der Groessenchip nur die Groesse in Warnfarbe.
- Der neutrale Hinweis an einer Grenze schliesst sich nach 6 s selbst und beim naechsten Druck in eine Kachel; bei neun Kacheln verdeckte er sonst die Koepfe der ersten beiden. Fehlermeldungen bleiben stehen, bis man sie schliesst.
- Eine gesperrte Kachel, die nach dem Neuverbinden ihres Hosts ein frisches Terminal bekommt, misst dieses ohne die Sperrleiste und braucht kein zweites `resize_terminal` mehr.
- Ein Tipp per Touch oder Stift auf eine Session eines anderen Hosts in der Seitenleiste geht nicht mehr verloren; die Markierung haelt jetzt bis zu seinem Klick still, wie bei der Maus.
- Ein gespeichertes Fenster unter der Mindestgroesse von 1100 x 600, etwa bei 100 % gespeichert und bei 150 % gestartet, wird beim Start auf diese angehoben.

## [0.2.0] - 2026-10-22

Erste oeffentliche Version, jetzt unter dem Namen aidevbridge.

### Added

- Dynamisches Raster: bis zu neun Terminals, die sich nach ihrer Zahl selbst anordnen, hoechstens acht je Host. Je Host oeffnen hoechstens vier Terminals zugleich; die uebrigen warten und zeigen "Opening…". Maximieren verbirgt die anderen Kacheln nur: ihre Terminals bleiben verbunden, Zurueckholen oeffnet nur Kacheln neu, deren Terminal keinen lebenden Kanal mehr hat (etwa nach einem Neuverbinden des Hosts), und Maximieren oder Zurueckholen heben keine Sperre auf. Ein Klick auf eine Session fuegt eine Kachel hinzu oder zeigt die vorhandene, die kurz aufleuchtet; Ctrl+Klick und Ctrl+Enter im Schnelloeffnen ersetzen die fokussierte. Zug am Kachelkopf tauscht zwei Kacheln, Zug an der Luecke aendert ihre Groesse (Doppelklick setzt zurueck); Ctrl+Shift+PageUp/PageDown und das Terminalmenue schieben die fokussierte Kachel. An einer Grenze erscheint ein Hinweis, geschlossen wird nichts. Ein Klick, der eine Kachel hinzufuegen wuerde, prueft die Grenzen, bevor er einen getrennten Host verbindet; Ctrl+Klick verbindet zuerst und zeigt den Hinweis gegebenenfalls danach.
- Wartet-Spur oben in der Seitenleiste: wartende Sessions, die aelteste zuerst, mit Wartezeit und Grund; offene Sessions zeigen in Liste und Spur ihre Kachelnummer. Ctrl+Shift+A folgt der Reihenfolge der Spur. Ctrl+Shift+E springt weiterhin auf die erste Hostzeile; die Spur erreicht man per Tastatur mit Pfeil hoch oder Pos1.
- Kacheln unter 80 x 20 zeigen "narrow". Eine volle Kanalgrenze nennt "{host} has no free terminal channel right now. Close a terminal and try again." (Rohtext hinter "Copy details"); ist nur gerade kein Terminalkanal frei, wartet das Oeffnen zuerst bis zu 2 s, etwa bis beim Ersetzen an der Grenze der alte Kanal geschlossen ist. Scheitert das allererste Oeffnen einer neuen Kachel daran, geht sie wieder; jede andere Kachel bleibt mit ihrer Sperrleiste.
- Die Live-Region nennt die Kachel mit "Terminal {index}: {session}" bei jeder Sessionwahl, bei Ctrl+Shift+1-9 und Ctrl+Shift+Up/Down, wenn der Fokus per Klick auf den Kachelkopf in eine andere Kachel wechselt und wenn er nach dem Schliessen zur Nachbarkachel wandert; ein Tausch oder Verschieben nennt "{session} moved to position {index}".
- Terminal in den Einstellungen: "Copy on select" (aus), "Use Ctrl+C and Ctrl+V" (an) und "Right click" mit "Menu" (Terminalmenue mit Copy, Paste, Select all und Find…) oder "Copy/Paste" (kopiert mit Markierung, fuegt sonst ein). Jede Kopie zeigt im Kachelkopf kurz "Copied".
- Links: Ctrl+Klick oeffnet http- und https-Links im Standardbrowser, auch OSC-8-Links; ein Klick ohne Ctrl tut nichts.
- Suchleiste in der Kachel mit Trefferzaehler, vorigem und naechstem Treffer und Gross-/Kleinschreibung; Enter und Shift+Enter springen, Esc schliesst.
- Eine Schriftgroesse fuer alle Terminals, 10 bis 20 px (Standard 13): Ctrl+Mausrad ueber einem Terminal, Ctrl+= / Ctrl+- / Ctrl+0 oder in den Einstellungen unter Terminal.
- Verlauf beim Anhaengen: Oeffnen und Wiederanhaengen zeigen bis zu 5000 Zeilen Verlauf der tmux-Pane (tmux 3.3a, 3.4 und 3.6; nicht waehrend eines Vollbildprogramms).
- Selbstheilung fuer Hosts mit Schluesseldatei oder ssh-agent: Eine abgebrochene Steuerverbindung wird repariert, eine verlorene Terminalverbindung (Standby, Netzwechsel, VPN) neu aufgebaut, mit bis zu fuenf Versuchen nach 2, 5, 15, 30 und 60 s. Ein wartender Versuch startet sofort bei Fensterfokus, ein Neuverbinden auch bei wiederkehrendem Netz; danach haengen sich die Kacheln mit Verlauf wieder an. Hostschluessel- und Anmeldefehler beenden die Reihe, Passwort- und Passphrase-Hosts bleiben von Hand. Waehrenddessen steht unter der Hostzeile nur eine ruhige Zeile ("Reconnecting live updates…" bzw. "Reconnecting…"); die Kacheln eines neu verbindenden Hosts zeigen "Reconnecting…". Eine Kachel, deren Kanal allein abriss, haengt sich bis zu dreimal selbst wieder an.
- Arbeitsplatz: Kacheln, verbundene und aufgeklappte Hosts, Seitenleistenbreite und je Host die letzten Verzeichnisse bleiben ueber Neustarts erhalten. Beim Start verbinden sich Schluessel- und Agent-Hosts wieder (hoechstens drei zugleich) und belegen ihre Kacheln; Passwort-Hosts bleiben offline. Abschaltbar in den Einstellungen unter General. Ein Klick auf eine Session eines getrennten Hosts verbindet ihn und oeffnet die Session.
- Schnelloeffnen (Ctrl+Shift+P): Sessions (wartende zuerst), Hosts und Aktionen mit Filter. Ctrl+Shift+N legt die Session auf dem Host der fokussierten oder zuletzt fokussierten Kachel an, sonst auf dem aktiven oder einzigen verbundenen Host, sonst ueber das Schnelloeffnen. Ctrl+, oeffnet die Einstellungen.
- Neue Session: Namensvorschlag aus dem gewaehlten Ordner (hoechstens 40 Zeichen, bei Kollision `-2`, `-3` ...), Liste "Recent" mit den letzten fuenf Ordnern je Host; der Fokus startet im Namensfeld.
- Hosts haben einen optionalen Anzeigenamen. Aendert sich nur er, bleiben Verbindung und Kacheln; geaenderte Verbindungsangaben werden zuerst gespeichert, danach verbindet der Host einmal neu und behaelt seine Kacheln.
- Seitenleiste: Ein zugeklappter Host zeigt wartende Sessions als "N waiting", "Reload sessions" ist ein Knopf der Hostleiste, und die Breite laesst sich zwischen 208 und 480 px ziehen (Doppelklick: 240 px); die Kacheln folgen dem Ziehen, die Terminals passen sich beim Loslassen einmal an.
- Barrierefreiheit: Dialoge tragen ihre Ueberschrift als Namen, fehlerhafte Felder sind markiert, Windows-Kontrastdesigns zeigen Fokus (durchgezogen) und Auswahl (gestrichelt) in der Systemfarbe. Tooltips von Knoepfen nennen ihr Kuerzel aus der aktiven Belegung.
- Sessionliste mit numerischer tmux-Identitaet auf tmux 3.0, 3.3a, 3.4 und 3.6 (von 3.6 nur die gemessene Ausgabe `tmux 3.6`, Ubuntu 26.04.1 mit Paket `tmux 3.6a-2ubuntu0.1`); Beenden und Status sind daran gebunden. Auf 3.3a, 3.4 und 3.6 bestaetigt das Oeffnen den angehaengten tmux-Client und die Pane, bevor das Terminal Eingaben annimmt; 3.0 und andere Versionen oeffnen ueber den Namen.
- Agentstatus fuer Claude Code: Alle rund 2 s kombiniert ein Overlay mit fuenf kurzen Befehlen je Host (unabhaengig von der Zahl der Sessions; eine unbekannte Claude-Zeile trifft nur ihre Session) das tmux-Inventar (unbekannt/beendet) mit einem lesenden `claude agents --json` (arbeitet/wartet/untaetig), gebunden an den Pane-Prozess oder dessen direktes Kind. Auf dem Host wird nichts installiert oder geschrieben; zu Codex und Grok siehe den naechsten Punkt, agy, OpenCode und Gemini CLI zeigen unbekannt. Anzeige als farbige Pille mit eigener Form in Sessionzeile und Kachelkopf (Waiting, Busy, Idle, Ended, Unknown), Grund im Tooltip; das Kanalwort der Sessionzeile steht dann im Tooltip der Zeile. Nach gescheiterter Abfrage, gestoerter Kontrollverbindung oder Neuverbindung zeigt die Pille "As of hh:mm" statt des letzten Werts.
- Agentstatus fuer Codex und Grok aus dem Terminaltitel, den tmux je Pane haelt: ein zusaetzlicher lesender Befehl je Poll und Listenabruf liest den Titel der aktiven Panes und die Programmnamen unter der Pane-Shell aus `/proc` (keine Kommandozeilen). Der Titel zaehlt nur, solange der Agent dort laeuft, und nur in den gemessenen Formen (Codex 0.154.0, Grok 1.0.30; Groks Freigabetitel `⚠ Action Required` aus der Messung mit 1.0.13 ergibt wartet); jede andere Form ergibt unbekannt. Eine gebundene Claude-Zeile hat Vorrang. agy und OpenCode zeigen keinen Status im Titel und bleiben unbekannt; Gemini CLI ist nicht gemessen.
- Aufmerksamkeit: Zahl wartender Sessions im Fenstertitel, einmaliges Taskleisten-Blinken bei unfokussiertem Fenster, Ctrl+Shift+A springt zur naechsten wartenden Session. Hosts ohne aktuellen Status zaehlen nicht mit.
- Getrennte SSH-Verbindungen fuer Kontrollbefehle und Terminals, an denselben Hostschluessel gebunden. Ein reiner Kontrollausfall erhaelt nutzbare Terminals und die letzte Sessionliste.
- Sichtbare Listenaktualitaet: fehlgeschlagenes Laden und veraltete Listen zeigen Fehler sowie gegebenenfalls den letzten erfolgreichen Abruf; nie geladen und bestaetigt leer bleiben unterscheidbar.
- **Restore updates** in der Seitenleiste ersetzt nur die Kontrollverbindung mit frischer Anmeldung; Schluessel- und Agent-Hosts reparieren sie zuerst selbst (bis zu fuenf Versuche). Passwort oder Passphrase werden bei Bedarf erneut eingegeben; ein gespeicherter Credentialcache wird dafuer nicht verwendet.
- Einstellungen mit Navigation links und Inhalt in Karten, Bereiche General, Appearance, Terminal, Shortcuts und About; Pfeiltasten, Pos1 und Ende wechseln den Bereich. Shortcuts listet alle App-Kuerzel aus der aktuellen Belegung, jede Taste als eigener Chip; eigene Kuerzel sind vorbereitet, aber noch nicht belegbar. About zeigt Version, Commit, Lizenz und den Pfad der Einstellungsdatei, "Copy version info" kopiert `aidevbridge <Version> (<Commit>)`.
- Windows-Lieferlauf `npm run build:windows`: baut aus einem sauberen, committeten Checkout mit gepinnten Werkzeugen MSI, NSIS und ZIP aus einem nativen Build, legt die ausgewaehlten Lizenztexte und die Quellarchive der Installerwerkzeuge offline bei und prueft ZIP-Inhalt und Manifest; `node scripts/release-windows-artifacts.mjs verify` prueft einen Lauf nach. Unsigniert, ohne Installation und Veroeffentlichung.

### Changed

- Neuer Name aidevbridge: Fenstertitel, Programm `aidevbridge.exe`, Pakete `aidevbridge-<Version>-windows-x64.*` und die Kennung `io.github.itbrain258.aidevbridge` statt `dev.agentbridge.app`. Die Einstellungen liegen jetzt im Ordner der Kennung, `%APPDATA%\io.github.itbrain258.aidevbridge\settings.toml`, neben der Fensterlage; der NSIS-Deinstaller entfernt beide, wenn man das Loeschen der App-Daten waehlt. Zum Wechsel siehe Upgrade. Der tmux-Socket auf den Hosts heisst weiter `agentbridge`, laufende Sessions bleiben sichtbar.
- Die Schalter des Debug-Baus und die Live-Tests lesen `AIDEVBRIDGE_*` statt `AGENTBRIDGE_*`. Neu ist `AIDEVBRIDGE_LEGACY_SETTINGS_DIR`: Nur damit uebernimmt eine Testinstanz mit `AIDEVBRIDGE_SETTINGS_DIR` Einstellungen aus einem alten Testordner.
- Werkzeugleiste mit Umschalter 1/2/4 und Ctrl+Shift+G entfallen. Ctrl+Shift+1-9 fokussieren die Kachel an dieser Position, Ctrl+Shift+Up/Down die vorige oder naechste Kachel. "Reconnect" haengt die Kachel an ihrer Position neu an und montiert das frische Terminal gleich in Endgroesse.
- Ein Klick auf eine Session beendet das Maximieren einer anderen Kachel, statt deren Session zu ersetzen; Ctrl+Shift+1-9 und Ctrl+Shift+Up/Down beenden es ebenfalls.
- settings.toml: `[workspace]` speichert bis zu neun Kacheln und `tiles_version = 2`; `layout` wird abgeleitet geschrieben, damit 0.1.2 die ersten vier zeigt.
- Kuerzelregel: App-Kuerzel nutzen Ctrl+Shift. Ausnahmen sind Ctrl+C mit Markierung und Ctrl+V (in den Einstellungen unter Terminal abschaltbar) sowie Ctrl+, und Ctrl+= / Ctrl+- / Ctrl+0, fuer die xterm keine Terminaleingabe erzeugt.
- Fenster mindestens 1100x600 statt 1100x700, damit es bei 150 % Skalierung passt.
- Statusabfrage: Der naechste Poll eines Hosts beginnt fruehestens 2 s nach dem Ende des vorigen und setzt aus, solange die Sessionliste laedt; verzichtbare Lesungen starten nur mit genug Restzeit. Die Sessionliste laedt nur nach einer Reparatur der Steuerung neu, nicht bei jedem Zustandswechsel.
- `settings.toml` hat neue Felder unter `[ui]` und den Abschnitt `[workspace]`; die Dateiversion bleibt 1. Aeltere Builds lesen die Datei weiter, lassen die neuen Felder beim naechsten Speichern aber weg.
- Die App haengt ihre tmux-Option `terminal-overrides` an die Standardliste an, statt sie zu ersetzen; `mouse` und `set-clipboard` setzt sie weiterhin nicht.
- Keine tmux-Statuszeile mehr in den Kacheln: Derselbe tmux-Aufruf, der ein Terminal anhaengt, setzt vorher `set -g status off` auf dem Socket `agentbridge`. Sessionname, Host und Status stehen im Kachelkopf, und jede Kachel gewinnt eine Zeile. Das gilt fuer jede Session des Sockets ohne eigene `status`-Einstellung, auch fuer einen Client, der per Hand anhaengt.
- Fehlt tmux auf dem Host oder ist es zu alt, nennt die Preflight-Meldung den Weg ueber die Paketverwaltung. Die App installiert weiterhin nichts auf dem Host.
- Der Paaraufbau liest und decodiert einen Dateischluessel einmal und bereitet beide RSA-Anmeldungen vor dem ersten TCP-Aufbau vor. Das gesamte Paar teilt die Vier-Minuten-Frist; jede Verbindung hat 15 Sekunden fuer Netzwerkaufbau und eine Minute fuer Authentifizierung. Ein bestaetigungspflichtiger SSH-Agent kann zwei Freigaben verlangen.
- `russh` ist exakt auf 0.63.2 festgelegt, mit lokalen Patches fuer das Schliessen von SSH-Kanaelen, einen Beobachter fuer das Kanalende und ein manuelles Empfangsfenster fuer Terminalkanaele; Krypto-Code und Produktionsfeatures bleiben unveraendert. Herkunft, Umfang und Lizenz stehen in [vendor/russh/AGENTBRIDGE-PATCH.md](vendor/russh/AGENTBRIDGE-PATCH.md).
- Gezielte Dependency-Patches fuer Vitest, Nano ID, chacha20, event-listener und wnaf.
- Farbwahl statt zwei fester Themen: 7 Akzente (Tuerkis, Blau, Violett, Pink, Rot, Orange, Gruen) auf 2 dunklen Grundtoenen (Graphit, Schiefer), also 14 Varianten, unter Appearance. Die bisherigen Werte `turquoise` und `slate` in `settings.toml` bleiben gueltig und werden weiter so geschrieben, damit aeltere Builds sie lesen; ein unbekannter Wert faellt mit Hinweis auf Tuerkis zurueck. "Connecting" nutzt feste neutrale Farben, damit ein gruener Akzent nicht wie verbunden wirkt, und Gefahrknoepfe tragen ein Warnsymbol, damit sie bei rotem Akzent unterscheidbar bleiben.
- Bauen aus dem Quelltext verlangt Node.js 24 oder neuer.

### Fixed

- Endet die Verbindung waehrend der Anmeldung, etwa weil der Server nach zu vielen Versuchen trennt oder das Netz wegbricht, meldet die App einen Verbindungsfehler statt "The server does not offer this authentication method".
- Ctrl+Shift+B (Seitenleiste ausblenden) liess die Terminals auf zwei Spalten schrumpfen.
- Beim Entsorgen eines Terminals wird sein WebGL-Kontext freigegeben.
- Der erste Klick auf eine Session oder Hostzeile eines Hosts, dessen Hostleiste gerade verborgen ist, geht nicht mehr verloren: Die Leiste erscheint erst nach dem Klick. Ein Doppelklick wirkt nur einmal.
- Kopieren und Einfuegen unter Windows wie in Windows Terminal: Ctrl+C kopiert eine Markierung (ohne Markierung geht weiter ^C an das Programm), Ctrl+V, Ctrl+Shift+V und Shift+Insert fuegen nativ ein, ohne nach einer Erlaubnis zu fragen; Ctrl+Shift+C und Ctrl+Insert kopieren. Auf Hosts mit `set -g mouse on` markiert Ziehen in tmux, und die Kopie kommt per OSC 52 in der Windows-Zwischenablage an; Shift+Ziehen markiert lokal. Bisher brach Ctrl+C den Agent ab, Ctrl+V kam als ^V an, auf solchen Hosts markierte nur Shift+Ziehen, und Kopier- oder Einfuegefehler erschienen als "Could not open this terminal …".
- Keine falsche Verbindungsmeldung mehr in der Hostzeile, solange das Terminal laeuft: Nur ein verlorener Transport gilt als Ausfall der Steuerverbindung. Bisher machte eine langsame oder gescheiterte Statusabfrage die Steuerung verdaechtig ("Session updates need attention") und nach drei Fehlschlaegen in Folge unbrauchbar ("Control connection interrupted"), obwohl das Terminal ueber die zweite Verbindung weiterlief. Faellt die Quelle eines Status aus, springt er nicht mehr auf Unknown, sondern bleibt als "As of hh:mm" stehen; kehrt danach Waiting zurueck, blinkt die Taskleiste nicht erneut.
- Eine Kachel, deren Kanal bei minimiertem Fenster abriss, bleibt nicht mehr bei "Not attached" stehen, sondern haengt sich nach dem Wiederherstellen selbst wieder an.
- F5, Ctrl+R und andere Browsertasten laden die App nicht mehr neu; ausserhalb von Textfeldern und Terminal erscheint kein Browsermenue mehr. Im Terminal gehen diese Tasten weiter an das Programm, Browser-Medientasten wirken nirgends.
- In Textfeldern bleiben Ctrl+Shift+Links/Rechts, Pos1, Ende und Z sowie Ctrl+Shift+V beim Feld; ein Esc, das ein Feld oder die Suche schliesst, hebt keine Maximierung mehr auf.
- Das leere Raster nennt nur noch Kuerzel, die wirken.
- Meldungen sagen, was passiert ist und was zu tun ist. Rohtexte des Backends stehen hinter "Copy diagnostics" bzw. "Copy details", ausser sie sind selbst der Hinweis, was zu tun ist.
- Eine lange Hostliste in der Seitenleiste scrollt, statt abgeschnitten zu werden; Knoepfe der Hostleiste behalten beim Neuzeichnen den Fokus.
- Beim Start blitzt das Fenster nicht mehr weiss auf.
- Remote-Kommandos und Terminal-Attach haben jeweils eine vollstaendige 15-Sekunden-Frist ueber Kanalaufbau, Requests und Antworten. Folgepruefungen teilen dieselbe Command-Frist; Kanal-Cleanup verlaengert die Rueckgabe nicht.
- Abgebrochene oder ueberholte Terminal-Opens und verspaetete Terminalereignisse koennen keine neuere Kachel uebernehmen oder sperren; ein Attach-Timeout beendet keine anderen nutzbaren Terminals.
- Unbestaetigte Create-/Kill-Ausgaenge nach moeglichem Absenden werden als unklar gemeldet und nicht automatisch wiederholt. Die Meldung fordert zum Neuladen der Sessionliste auf; ein Timeout ist kein Remote-Rollback.
- Lokale RSA-Dateischluessel werden vor dem Verbindungsaufbau vorbereitet und mit Zufallsblinding signiert; Fehler der Zufallsquelle brechen die Anmeldung ohne ungeblendeten Rueckfall ab.
- Verschluesselte PKCS#8-Dateischluessel mit gueltiger PEM-/DER-Huelle loesen bei fehlender Passphrase die vorhandene Passphrasenabfrage aus.
- Gesperrte SSH-Hostschluessel (`@revoked`) bleiben auch dann abgelehnt, wenn ihr Hostfeld Muster enthaelt, die die App nicht auswertet; die konservative hostuebergreifende Regel ist im README erklaert.
- Erststart bindet Preflight und Speichern an den aktuellen Verbindungsversuch; verspaetete Antworten und Zurueck waehrend des Speicherns koennen keine falsche Verbindung uebergeben.
- Host-Bearbeitung aktualisiert den gespeicherten Eintrag atomar mit unveraenderter ID. Speicherfehler erhalten den Entwurf; fehlgeschlagenes Entfernen behaelt den getrennten Host sichtbar und meldet den Fehler.
- Tastaturfokus bleibt bei laufenden oder fehlgeschlagenen Host-Aenderungen auf erreichbaren Bedienelementen und kehrt beim Schliessen verlaesslich zurueck.
- Kachel-Reconnect baut ausgefallene Hostverbindungen wieder auf und fuehrt bei Bedarf zur Passwort-/Passphrasenabfrage; laufende Verbindungsversuche werden nicht verdoppelt.
- Verspaetete Sessionantworten nach Trennen, Entfernen oder Wiederverbinden ueberschreiben keine aktuelle Sessionliste mehr; Anlegen und Beenden werden je Verbindung geordnet verarbeitet.
- Fehlgeschlagene tmux-Abfragen gelten nicht mehr pauschal als leere Sessionliste; Beenden meldet bei gescheiterter Kontrollabfrage keinen Erfolg.
- tmux-Abfragen behalten Unicode-Namen trotz festgelegter Fehlermeldungssprache bei.
- SSH-Kommandos ohne Exitstatus oder Exit-Signal melden einen unbekannten Ausgang statt Erfolg.
- Fehlgeschlagene tmux-Servervorbereitung stellt `exit-empty` nach Moeglichkeit wieder her.
- Ctrl+Shift+1 bis 9 funktioniert auch mit den Shift-Zeichen deutscher und US-Tastaturlayouts.
- Endet der SSH-Kanal einer Kachel, sperrt die Kachel Eingabe und Groessenaenderung auch dann, wenn noch Ausgabe in der Warteschlange steht; bereits empfangene letzte Ausgabe bleibt erhalten.
- Auf einem Host ohne laufenden tmux-Server der App (frischer Host, Neustart der VM, letzte Session beendet) zeigt die Sessionliste wieder eine leere Liste statt eines Fehlers, und das Beenden der letzten Session meldet keinen Fehler mehr. Der Server gilt nur als abwesend, wenn tmux 3.3a, 3.4 oder 3.6 genau den vorhergesagten Socket-Pfad nennt; unter tmux 3.0 bleibt eine fehlgeschlagene Liste ein Fehler.
- Viel Ausgabe trennt ein Terminal nicht mehr: Bei `yes`, einem grossen `cat` oder einem Build mit viel Ausgabe riss der Terminalkanal schon mit einer Kachel nach gut einer Sekunde ab ("Reconnecting…"). Jetzt gibt jedes Terminal sein SSH-Fenster erst frei, wenn es die Ausgabe abgenommen hat; ist es langsamer als die Ausgabe, wartet der Host, und tmux ueberspringt fuer dieses Terminal Zwischenstaende und zeichnet neu.

### Security

- known_hosts: Steht ein Host nur gehasht darin (`|1|...`, etwa nach `HashKnownHosts yes`), gilt ein anderer Schluessel desselben Typs als Schluesselwechsel und wird ohne Rueckfrage abgewiesen, statt als Erstkontakt die Vertrauensfrage zu stellen; ein passender gehashter Eintrag gilt als bekannt.
- OSC-8-Links, deren sichtbarer Text nicht ihr Ziel zeigt, oeffnen nach Ctrl+Klick nicht sofort: am Zeiger stehen das volle Ziel und "Open link". Der Tooltip nennt das Ziel schon beim Ueberfahren.
- `pageant` 0.2.4 statt 0.2.1 (GHSA-g4mp-vgx3-xrvm). Die App spricht den Windows-OpenSSH-Agenten ueber dessen Pipe an und ruft Pageant nicht auf; der Code steckte trotzdem im Binary.
- [`SECURITY.md`](SECURITY.md): Meldeweg ueber GitHub Private Vulnerability Reporting, unterstuetzte Versionen, gespeicherte Daten, Begruendung zu RUSTSEC-2023-0071 und das Pruefen der SHA-256-Werte.

### Upgrade

- Von agentbridge: Liegt im Ordner der Kennung beim Start keine `settings.toml`, uebernimmt aidevbridge die aus `%APPDATA%\agentbridge\`; nur diese Datei geht mit, Hosts, Kacheln und Sessions bleiben erhalten. Der alte Ordner bleibt unveraendert und kann nach dem Wechsel geloescht werden; solange er liegt, holt ein Start ohne neue `settings.toml` ihn erneut.
- Fensterlage und -groesse sowie die WebView2-Daten haengen an der Kennung und beginnen neu: Das Fenster startet einmal in der Vorgabegroesse, `%APPDATA%\dev.agentbridge.app\` und `%LOCALAPPDATA%\dev.agentbridge.app\` bleiben als Reste liegen. Das Farbschema kommt aus `settings.toml` und bleibt.

## [0.1.2] - 2026-09-06

### Added
- Zwei Themen (Tuerkis auf Graphit, Blau auf Schiefer) im Einstellungsdialog (Zahnrad im Seitenleistenkopf); gespeichert in `settings.toml` unter `[ui]`.
- Erststart als Willkommensseite mit Vorschlaegen aus `~/.ssh/config`, Passwort-/Passphrasenabfrage in der Zeile, Pruefliste.
- Lucide-Icons (Lizenz in THIRD_PARTY_LICENSES.md).
- Fenstergroesse, -lage und maximierter Zustand bleiben ueber Neustarts erhalten.
- Eigenes App-Icon (Eingabeaufforderung auf Akzentflaeche) statt der Tauri-Vorlage.

### Changed
- Oberflaeche nach UI-v2-Spec: Seitenleiste mit Hostkarten und Kuerzeln, Kacheln als Panels mit Akzentkontur, gemeinsame Dialoghuelle, Fenster 1280x800 (mindestens 1100x700).
- Terminal-Scrollbalken bleibt sichtbar.
- Seitenleiste: Sessionaktionen als Icons in der Zeile, kurze Zustandspille (Online/Offline), Kuerzel bei IP-Adressen aus dem letzten Oktett; Leerzustand ohne verbundenen Host mit einem Satz; New session nur bei verbundenem Host.

## [0.1.1] - 2026-09-05

### Fixed
- Sperrleiste war an jeder Kachel dauerhaft sichtbar.
- Ausgabe gleichnamiger Sessions auf zwei Hosts landete in beiden Kacheln.
- RSA-Schluessel wurden nur mit SHA-1 angeboten und von OpenSSH ab 8.8 abgelehnt.
- Rotes Fehlerbanner bei jedem von aussen beendeten tmux.
- Unlesbare known_hosts galt als leer; Preflight pruefte TMPDIR statt TMUX_TMPDIR; anderer Schluesseltyp galt als Angriff.
- Relative Pfade und Steuerzeichen aus Hostdaten konnten den Aufruf haengen lassen.
- Passwort-Hosts liessen sich nach einem Neustart nicht mehr verbinden.
- TOFU-Rueckfrage war fuer Tastatur und Hilfstechnik nicht modal.

### Changed
- russh 0.63.
- Version und Commit stehen in der Seitenleiste und im Diagnosetext.
- Content-Security-Policy gesetzt.

### Upgrade
- Hosts, die vor 0.1.1 per Passwort angelegt wurden, tragen noch keine gespeicherte Anmeldeart. Die App zeigt fuer sie nach einem gescheiterten Versuch ein Passwortfeld in der Hinweisleiste; dauerhaft behebt es Bearbeiten des Hosts und Auswahl von Passwort.
