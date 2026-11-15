# Erststart: der Weg bis zur ersten Session

**Datum:** 15.11.2026
**Stand:** gebaut, noch nicht veröffentlicht. Geprüft im Headless-Browser gegen Beispieldaten, nicht am Fenster und nicht an einem echten Host (§10).
**Baut auf:** [UI v2](2026-09-05-ui-v2-design.md) §9 (Erststart) und §11.4 (Schlüsselabfrage), [UX-Überarbeitung](2026-10-11-ux-ueberarbeitung-design.md) §7.7 und §10 (Texte), [Android](2026-10-27-android-design.md) §5.3, [Statusanzeige](2026-11-14-statusanzeige-design.md) §2 (Knopfleiste).

## 1. Anlass und Vorgehen

Der Maintainer bat am 15.11. darum, die App wie ein neuer Nutzer vom ersten Start an durchzugehen und zu verbessern, was sich ohne Anleitung nicht erschließt.

Der Weg wurde im Headless-Browser nachgestellt, gegen Beispieldaten, auf dem Desktop (1280 × 800) und in der Telefonansicht (412 × 880): Willkommen mit und ohne Vorschläge, Schlüsselabfrage, Host-Prüfung, Speichern, erste Session; dazu die Fehlerwege (Host nicht erreichbar, Passphrase, ssh-agent aus, Schlüssel nicht angenommen, Hostschlüssel abgelehnt, Prüfung blockiert, Prüfung scheitert). Die Beispiele tragen die echten Meldungen des Backends (`AuthError::user_message`, `blocking_problem`, `classify_connect_error`), keine erfundenen.

Die Befunde, nach einer festen Regel gereiht: zuerst, wo kein nächster Schritt zu sehen ist; dann, wo eine Meldung zur falschen Abhilfe schickt; dann, was kaputt aussieht; zuletzt Fachsprache.

| Rang | Befund | Abschnitt |
| --- | --- | --- |
| 1 | Telefon: Nach dem Speichern des ersten Hosts verdeckt die Hostliste den Knopf „New session“ des leeren Rasters. Sichtbar bleiben eine zugeklappte Karte und drei Symbole ohne Wort. | §2 |
| 2 | Ein Schlüssel, den der Host nicht annimmt (falscher Benutzer, öffentlicher Schlüssel fehlt in `authorized_keys`), meldet „The server does not offer this authentication method.“ | §3.4 |
| 3 | Eine blockierte oder gescheiterte Host-Prüfung lässt nur „Back“. „Back“ trennt die Verbindung; wer tmux nachinstalliert hat, verbindet neu und bestätigt neu. | §4.1 |
| 4 | Ein Vorschlag, der nicht verbindet, bietet nur „Retry“, mit demselben falschen Benutzer oder Port. | §3.2 |
| 5 | In der Vorschlagsliste stoßen Name und Adresszeile ineinander. | §3.1 |
| 6 | Einstieg ohne Vorschläge: „Suggested hosts … / No hosts found“ über einem Formular ohne Titel; „Name“ ohne den Hinweis, dass es freiwillig ist; keine Beispiele; „Show tmux sessions“ ohne Erklärung; „Found in %USERPROFILE%\.ssh …“, obwohl nichts gefunden wurde. | §5 |
| 7 | Die Schlüsselabfrage erklärt nichts; die Beschriftung des Passphrasenfelds widerspricht der Meldung darüber; die Prüfzeilen sind Fachsprache; nach der Prüfung steht weiter „Checking the host…“; „Continue“ sagt nicht, dass es speichert; die gescheiterte Prüfung endet auf „..“ und steht über einer leeren Überschrift. | §3.3, §4, §6 |

Es ändern sich Texte und kleine Stücke Aufbau. Kein neuer Befehl im Backend, keine neue Einstellung, keine Bewegung (UI v2 §14). Alle Texte der Oberfläche bleiben englisch und folgen dem Muster der UX-Spec §10: Was ist passiert. Was tun.

## 2. Nach dem Speichern steht der nächste Schritt da

- `handleHostReady` (`main.ts`) klappt den eben gespeicherten Host auf. Der Arbeitsplatz merkt sich das wie jedes Aufklappen von Hand.
- Unter einer **bestätigt leeren** Sessionliste eines verbundenen, aufgeklappten Hosts steht unter „No sessions“ ein beschrifteter Sekundärknopf **„New session“** (`.session-list-empty` mit `.session-list-new`). Er ruft denselben Weg wie das `+` der Knopfleiste (`onNewSession`).
- Er steht nur dort: nicht bei „Sessions have not been loaded yet.“, nicht bei einer veralteten Liste, nicht sobald der Host eine eigene Session hat, nicht an einem zugeklappten Host, nicht in der Gruppe „tmux sessions“.
- Der Knopf ist ein eigener Tabstopp wie die Knöpfe der Hinweiskästen und trägt den Fokusschlüssel `host:<id>:startSession`.
- Satz und Knopf stehen 6 px eingerückt wie die Knopfleiste darüber. Der Satz allein („Sessions have not been loaded yet.“) klebte bisher am Kartenrand; er rückt mit ein.

Die Regel der Telefonansicht bleibt, wie sie ist: Ohne offene Kachel zeigt sie die Hostliste (`compact-shell.ts`). Der nächste Schritt steht jetzt in dieser Liste. Auf dem Desktop steht er zweimal da, in der Seitenleiste und im leeren Raster; beide öffnen denselben Dialog.

## 3. Vorschläge und Anmeldung

### 3.1 Name und Adresszeile

`.first-run-suggestion-text` bekommt 6 px Abstand zwischen Name und Zweitzeile, dort, wo `text-box: trim-both cap alphabetic` gilt. Beide Zeilen sind auf Versalhöhe beschnitten und standen ohne Abstand untereinander; die Unterlängen des Namens stießen in die Zweitzeile. Der Fehler steht seit der ersten öffentlichen Version in der Liste, im Willkommen wie im Dialog „Add host“.

### 3.2 „Edit details“

Die Fehlerfläche unter einem Vorschlag bekommt neben „Retry“ den Textknopf **„Edit details“**, ebenso die Fläche mit dem Feld für Passwort oder Passphrase (dort neben „Connect“). Er räumt die Fläche und öffnet das Formular mit den Werten des Vorschlags: Name, Host, Benutzer, Port und der Schlüssel, falls der Vorschlag einen nennt. Der Fokus steht im Feld „Hostname or IP“. Ein Vorschlag ohne Schlüssel hat über den Agenten verbunden; im Formular bleibt die Anmeldeart dann offen.

Es ist derselbe Weg, den ein Vorschlag ohne Benutzer schon nimmt (`openForm`).

### 3.3 Beschriftung des Felds unter einem Vorschlag

`buildCredentialField` nimmt eine eigene Beschriftung (`label`). Der Erststart setzt:

| Anlass | Beschriftung |
| --- | --- |
| `passphrase_required` | Passphrase for this key |
| `auth_rejected` ohne Schlüssel (der Agent hat nicht verbunden) | Or enter the password for {user} |
| `password_required` | Password (unverändert) |

Vorher stand unter „This key is passphrase-protected. Enter the passphrase.“ die Beschriftung der Seitenleiste: „Key passphrase (only needed if the stored key has one)“. Die Seitenleiste behält ihre Beschriftungen.

### 3.4 Meldung zur abgelehnten Anmeldung

`AuthError::MethodNotOffered` trägt die versuchte Methode. `user_message` unterscheidet jetzt nach ihr:

| Methode | Meldung |
| --- | --- |
| Schlüsseldatei | The server didn't accept this key for this user. Check the user name, and that the key's public half is in ~/.ssh/authorized_keys on the host. |
| ssh-agent | The server didn't accept any key from ssh-agent for this user. Check the user name, and that one of the agent's public keys is in ~/.ssh/authorized_keys on the host. |
| Passwort, das der Server für das Konto nicht anbietet | This server doesn't accept password sign-in for this account. Sign in with an SSH key instead. |

Vorher galt für alle drei „The server does not offer this authentication method.“ Beim Schlüssel kann der Klassifikator „abgelehnt“ und „gar nicht angeboten“ nicht trennen (`classify_publickey_failure`). Der erste Satz stimmt in beiden Fällen; der zweite nennt die häufige Ursache. Die Marken der Methoden sind Konstanten in `auth.rs` (`METHOD_PASSWORD`, `METHOD_AGENT`), keine Texte des Servers. Die Meldungen bleiben paarweise verschieden.

Die Meldung gilt überall, wo die App verbindet, auch am Hinweiskasten der Seitenleiste.

## 4. Host-Prüfung

### 4.1 „Check again“

Ist die Prüfung blockiert oder gescheitert, steht neben „Back“ der Primärknopf **„Check again“** (`.first-run-recheck`) und trägt den Fokus. Er stellt die drei Fragen auf **derselben Verbindung** noch einmal: kein neues `connect_host`, keine neue Schlüsselabfrage. „Back“ gibt die Verbindung weiter frei. „Save host“ ist in diesem Zustand nicht sichtbar.

Während der Wiederholung steht die Karte wie beim ersten Lauf: „Checking {alias}“, „Running checks…“. Der Knopf ist so lange versteckt, und sein Handler nimmt für denselben Host keinen zweiten Lauf an. Ein Ergebnis, das nach „Back“ oder nach dem Entsorgen der Ansicht eintrifft, wird verworfen wie bisher (Versuchszähler).

Im Backend ist dafür nichts zu ändern: `run_preflight` hält keinen Zustand. Es schlägt den verbundenen Host nach und stellt drei unabhängige Befehle (`tmux -V`, `command -v base64`, `test -w` auf den Socket-Ordner); ein zweiter Aufruf auf derselben Laufzeit-ID ist ein Aufruf wie der erste. Das ist am Code gelesen, nicht an einem Host gemessen (§10).

### 4.2 Ergebnis statt Vorgang

- Die Überschrift nennt nach der Prüfung das Ergebnis: **„{alias} is ready“** oder **„{alias} is not ready yet“**. Während der Prüfung bleibt „Checking {alias}“.
- Die Statuszeile „Connected to {alias}. Checking the host…“ wird nach der Prüfung geleert. Sie blieb bisher stehen.
- Die Zeilen in neuer Reihenfolge und in Worten, weiter als neutrale Gegenstände, nicht als Behauptungen:

  | Zeile | Text |
  | --- | --- |
  | 1 | tmux 3.0 or newer (bestanden mit Zusatz: — found {version}) |
  | 2 | base64 command |
  | 3 | Writable folder for the tmux socket |

  tmux steht oben: An dieser Zeile hängt ein neuer Host am häufigsten. Vorher: „base64“, „tmux (>= 3.0)“, „tmux socket directory“.
- Der Knopf nach bestandener Prüfung heißt **„Save host“** statt „Continue“. Er speichert den Host in `settings.toml`; das Wort sagt es.

### 4.3 Gescheiterte Prüfung

Kommt die Prüfung nicht durch (der Befehl auf dem Host scheitert), steht die Meldung im Abschnitt der Prüfung: unter der Überschrift „Host check“, über den Knöpfen, an derselben Stelle wie der Grund einer blockierten Prüfung. Sie stand in der Fehlerzeile der Karte, über einer Überschrift, unter der nichts mehr kam.

Text: „Connected, but the host check failed: {message}. Check again, or go back.“ Der Schlusspunkt der Backend-Meldung fällt weg, bevor sie eingesetzt wird; vorher endete der Satz auf „(read, timeout).. Go back and try again.“

### 4.4 „What gets checked“

Die aufklappbare Liste im Fuß des Willkommens sagt, wozu jede Voraussetzung da ist:

- tmux 3.0 or newer — it runs your sessions and keeps them alive when you disconnect
- The base64 command — aidevbridge passes its commands to the host through it
- A writable folder for the tmux socket ($TMUX_TMPDIR or /tmp)

## 5. Einstieg und Formular

### 5.1 Ohne Vorschläge

Im Willkommen heißt die Karte ohne Vorschläge **„Add your first host“**. Darunter steht ein Satz, der sagt, was ein Host ist:

- Desktop: „A host is a Linux machine you reach over SSH — the one your agents run on. None were found in ~/.ssh/config, so enter it here.“
- Android (keine `~/.ssh/config`): „A host is a Linux machine you reach over SSH — the one your agents run on.“

Die Liste mit der Zeile „No hosts found in ~/.ssh/config“ entfällt dort. Mit Vorschlägen bleibt alles wie bisher („Suggested hosts (from ~/.ssh/config)“). Der Dialog „Add host“ (`compact`) trägt seinen eigenen Titel und richtet sich an jemanden, der schon einen Host hat: Er behält ohne Vorschläge die knappe Zeile, ohne Überschrift und Satz; auf Android bleibt sein leerer Abschnitt weg wie bisher.

### 5.2 Beispiele in den Feldern

- „Name“ heißt „Name (optional)“.
- „Hostname or IP“ zeigt als Platzhalter „devbox.example.com or 192.0.2.10“.
- „User“ zeigt „Your account on the host, for example ubuntu“.

### 5.3 Hinweis unter „Authentication“

Findet die App auf dem Desktop keinen Schlüssel, steht dort: „No SSH keys found in {Ordner}. Choose a key file, or sign in with ssh-agent or a password.“ Der Ordner ist `~/.ssh` auf macOS, sonst `%USERPROFILE%\.ssh`. Vorher stand „Found in … — only the .pub files are read to build this list.“ über einer leeren Liste. Mit Schlüsseln und auf Android bleiben die Texte.

### 5.4 „Show tmux sessions“

Unter dem Schalter steht: „Also lists the sessions you started with plain tmux on this host.“ Der Satz hängt über `aria-describedby` am Kästchen; jedes Formular vergibt eine eigene Kennung. Er steht im Anlegen wie in „Edit host“, nicht in der Reparatur der Steuerung (dort gibt es den Schalter nicht).

## 6. Schlüsselabfrage

Beim echten Erstkontakt (`known_key_types` leer) steht unter dem Fingerabdruck ein Satz:

„This is expected the first time you connect — to be sure it is your host, compare the fingerprint with the one the host itself shows.“

Er steht in der Lesefarbe (12/16, `--ab-text-secondary`), über der Frist. Mehr als diesen einen Satz bekommt die Abfrage nicht. Unverändert bleiben Titel, Text, Knöpfe und Frist; unverändert bleibt der Fall eines Hosts, der unter einem anderen Schlüsseltyp bekannt ist (dort steht der Satz nicht, die Frage ist dort kein Normalfall), und der abweichende Schlüssel, der ohne Rückfrage scheitert. Wie man den Fingerabdruck am Host abliest, steht in `docs/guide/hosts.md`.

## 7. Was diese Spec ersetzt

- **UI v2 §9.2 Punkt 4:** „Ohne Funde: `firstRun.suggested.empty` und das Formular direkt aufgeklappt.“ Im Willkommen gilt §5.1; die Zeile bleibt nur im Dialog „Add host“.
- **UI v2 §9.3:** Die Beschriftungen des Felds unter einem Vorschlag kommen nicht mehr aus `sidebar.notice.*.label` (§3.3). Die Fehlerfläche trägt zusätzlich „Edit details“ (§3.2). Die Prüfliste trägt nach der Prüfung ihr Ergebnis als Überschrift; der Primärknopf heißt „Save host“; blockierend gibt es „Back“ und „Check again“, der Fokus steht auf „Check again“ (§4.1, §4.2).
- **UX-Spec §10, Texttabelle:** `firstRun.preflight.failed` lautet „Connected, but the host check failed: {message}. Check again, or go back.“ `connect.connected` bleibt, gilt aber nur, solange die Prüfung läuft.
- **Statusanzeige §2:** unverändert. Der Knopf unter der leeren Liste kommt hinzu; die Knopfleiste bleibt, wie sie ist.

## 8. Tests

- `first-run.test.ts`: Einstieg ohne Vorschläge (Desktop, Android, Dialog), „Back“ stellt ihn wieder her; „Edit details“ an beiden Flächen; die drei Beschriftungen; Reihenfolge und Texte der Prüfzeilen; „Check again“ wiederholt auf derselben Verbindung, ohne `connect_host` und ohne `disconnect_host`, und nimmt während eines Laufs keinen zweiten an; nach einem Passwort, das der Server als Weg ablehnt, steht die Fehlerfläche da und nicht wieder das Feld; Fokus; geleerte Statuszeile; die Meldung der gescheiterten Prüfung, ihre Stelle und der einfache Punkt.
- `host-form.test.ts`: Platzhalter, Hinweis ohne Schlüssel, Satz unter dem Schalter samt `aria-describedby`, eigene Kennung je Formular.
- `credential-field.test.ts`, `host-key-prompt.test.ts`, `sidebar.test.ts`, `main.test.ts`: Beschriftung, Satz zum Erstkontakt, Knopf unter der leeren Liste und seine Grenzen, aufgeklappter neuer Host im gemerkten Arbeitsplatz.
- `auth.rs`: die drei Meldungen, gebaut über die Erzeuger, paarweise verschieden.

## 9. Nicht in diesem Zuschnitt

Vorschläge aus derselben Durchsicht, nicht gebaut:

1. **Tastenleiste auf dem Telefon ohne Terminal.** Die Leiste (Esc, Tab, Ctrl …) steht auf Android auch im Willkommen und über der Hostliste, wo sie nichts bewirkt. Die Android-Spec §5.2 sagt nur „Eine Zeile unter dem Raster“. Ausblenden, solange keine Kachel offen ist, wäre eine Änderung dieser Spec.
2. **„☰ Sessions“ ohne Host.** Im Willkommen der Telefonansicht tut der Umschalter nichts. Ausblenden oder sperren, solange es keinen Host gibt.
3. **Ein Hinweis in der ersten Shell.** Nach „Create session“ steht eine leere Shell da. Ein Satz im leeren Kachelkopf („Start your agent here, for example claude or codex“) würde den letzten Schritt des README in die App holen.
4. **Eine Erststart-Szene in `scripts/readme-images/`.** Die Bilder dieser Durchsicht liegen lokal; als Szene im Bildwerkzeug wäre der Erststart bei jedem Release mit im Blick.

## 10. Abnahme am Fenster

Im Headless-Browser geprüft: jeder Schritt und jeder Fehlerweg aus §1, vorher und nachher, in beiden Größen. Nicht geprüft und am Fenster nachzuholen:

- Ein echter erster Start gegen einen echten Host: Schlüsselabfrage, Prüfung, „Save host“, erste Session.
- „Check again“ nach einem wirklich nachinstallierten tmux.
- Ein Schlüssel, den der Host nicht annimmt: Erscheint die neue Meldung, und stimmt sie auch am ssh-agent?
- Telefon oder Tablet: der Knopf „New session“ unter dem frisch gespeicherten Host, mit dem Finger.
- Bildschirmleser: der Satz der Schlüsselabfrage, die Überschrift mit dem Ergebnis, der Satz unter „Show tmux sessions“.
