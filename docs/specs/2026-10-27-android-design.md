# aidevbridge für Android: Entwurf

**Datum:** 27.10.2026 · **Status:** umgesetzt auf dem Branch `feat/android`,
noch nicht auf einem Gerät abgenommen und nicht veröffentlicht. Den Ablauf bis
in den Play Store beschreibt die [Anleitung](../android-veroeffentlichung.md),
die Schritte der [Plan](../plans/2026-10-27-android.md).

## 1 Ziel

aidevbridge läuft auch auf Android-Telefonen und -Tablets, mit demselben
Funktionsumfang für Hosts, Sessions, Agentenzustand und Terminal, und ist als
Open-Source-App über Google Play erhältlich. Jede künftige Version erscheint
ohne Handarbeit: Ein Tag `v<version>` baut, signiert und veröffentlicht die
Android-App zusammen mit den Desktop-Paketen.

## 2 Prüfung: geht das?

Ja. Ergebnis der Prüfung am 27.10.2026:

- **Tauri 2 kann Android.** `lib.rs` trug schon `tauri::mobile_entry_point`,
  `Cargo.toml` schon `staticlib`/`cdylib`. `tauri android init` erzeugt das
  Android-Studio-Projekt unter `src-tauri/gen/android`.
- **Das Backend ist portabel.** russh mit dem `ring`-Backend, tokio, toml und
  die Statuserkennung kompilieren für `aarch64-linux-android` ohne Änderung;
  der erste Bau mit NDK r29 lief am 27.10. durch. Nur drei Stellen hingen am
  Desktop: das Plugin für die Fensterlage, `~/.ssh` und das
  Konfigurationsverzeichnis (§4.2, §4.3).
- **Das Frontend ist ein Desktop-Layout** (Mindestbreite 1100 px, Kürzel mit
  Strg+Umschalt). Für das Telefon braucht es eine kompakte Ansicht, eine
  Tastenleiste und einen anderen Weg zu SSH-Schlüsseln (§5).
- **Google Play nimmt die App an**, wenn sie Android 16 (API 36) als Ziel hat
  (Pflicht für neue Apps und Updates seit 31.08.2026), native Bibliotheken auf
  16-KB-Seiten ausrichtet (seit 01.11.2025) und als App Bundle (AAB) kommt. Alle
  drei Punkte erfüllt der Bau (§4.1, §4.7).

## 3 Vertriebswege

1. **Google Play** (Hauptweg): App Bundle, signiert mit dem Upload-Schlüssel;
   Google signiert die ausgelieferten APKs mit dem eigenen App-Signaturschlüssel
   (Play App Signing).
2. **GitHub-Release**: eine universelle APK an jedem Release, signiert mit
   demselben Projektschlüssel. Mit Obtainium lässt sie sich direkt von der
   Releases-Seite installieren und aktualisieren. Weil Google die
   Play-Version mit seinem Schlüssel signiert, ersetzen sich beide nicht
   gegenseitig; der Releasetext sagt das.
3. **Später, optional:** IzzyOnDroid (nimmt die APK von GitHub) und F-Droid
   (baut selbst aus dem Quellcode; mit Rust, Node und NDK aufwendig). Die
   Store-Texte liegen schon im fastlane-Format, das beide lesen.

**Androids Entwicklerverifizierung:** Seit 30.09.2026 verlangen zertifizierte
Android-Geräte in Brasilien, Indonesien, Singapur und Thailand, dass jede
installierte App von einem bei Google verifizierten Entwickler stammt, auch
außerhalb von Play; weltweit soll das 2027 folgen. Ein Play-Konto ist bereits
verifiziert, die GitHub-APK desselben Pakets gilt damit ebenfalls. Bis dahin
betrifft es nur Nutzer in diesen Ländern.

## 4 Technik

### 4.1 Projekt und Werkzeuge

- `src-tauri/gen/android` liegt im Repository, mit den Anpassungen aus §4.5,
  §4.6 und §6.2. Erzeugte Dateien (`tauri.properties`, `jniLibs`,
  `assets/tauri.conf.json`, `build/`) ignoriert git.
- compileSdk und targetSdk 36, minSdk 24 (Android 7.0). Gebaut werden die
  ABIs arm64-v8a, armeabi-v7a und x86_64; x86 (32 Bit) entfällt.
- NDK **r29** (`29.0.14206865`), Build-Tools 36.0.0, Rust 1.97.1 aus
  `rust-toolchain.toml` mit den drei Android-Zielen.
- **JDK 21 für Gradle.** Das Projekt nutzt Gradle 8.14 und das
  Android-Gradle-Plugin 8.11 aus Tauris Vorlage; beide laufen nicht auf dem
  Java 25, das Android Studio 2026.2 mitbringt.
  `gradle/gradle-daemon-jvm.properties` verlangt Java 21, Android Studio und
  Gradle wählen es damit selbst. Ein Sprung auf Gradle 9 und AGP 9 lohnt erst,
  wenn Tauris Vorlage ihn macht.
- **Windows:** `tauri android build` verlinkt die gebaute Bibliothek per
  Symlink in `jniLibs`; das verlangt den Entwicklermodus von Windows. Ohne ihn
  scheitert der Bau nach dem Kompilieren (Anleitung, Schritt A3).

### 4.2 Ordner der App

Neues Modul `paths.rs`: `home_dir()`, `config_dir()` und `ssh_dir()`. Auf dem
Desktop unverändert `dirs::home_dir()` und `dirs::config_dir()`. Auf Android
gibt es kein beschreibbares Heimatverzeichnis; dort sind beide der private
Datenordner der App (`app_data_dir()`), den Tauris Pfadauflöser erst im
`setup` kennt. Damit liegen `known_hosts`, `config` und die Schlüssel unter
`<Datenordner>/.ssh`, `settings.toml` unter
`<Datenordner>/io.github.itbrain258.aidevbridge/`. Der Umzug aus `agentbridge`
und das Aufräumen alter Schreibreste laufen auf dem Desktop wie bisher vor dem
Builder, auf Android im `setup`.

### 4.3 Plugins und Rechte

- `tauri-plugin-window-state` nur auf dem Desktop (der Krate ist auf Android
  leer), ebenso das Anheben auf die Mindestgröße.
- `tauri-plugin-fs` nur auf Android und nur auf der Rust-Seite: Es öffnet die
  `content://`-URI der Dateiauswahl (§5.3). Der WebView bekommt kein
  `fs:`-Recht.
- Zwei neue App-Befehle, `generate_ssh_key` und `import_ssh_key`, in allen
  fünf Listen (build.rs, lib.rs, Capability, beide ACL-Tests).
- Zwei neue Core-Rechte, `core:app:allow-register-listener` und
  `core:app:allow-remove-listener`, für `onBackButtonPress` (§5.1). Beide
  ACL-Tests halten sie wörtlich fest.

### 4.4 Version und versionCode

Tauri leitet den versionCode aus der Version ab:
`major × 1.000.000 + minor × 1.000 + patch` (0.2.3 → 2003, 0.3.0 → 3000).
Er steigt mit jeder Version, solange die Version steigt. Google Play nimmt
jeden versionCode nur einmal an; ein zweiter Upload derselben Version braucht
eine neue Patch-Version.

### 4.5 Keine Sicherung

`allowBackup="false"` und `data_extraction_rules.xml`: Weder die Cloud-
Sicherung noch der Umzug auf ein neues Gerät nehmen den privaten Speicher mit.
Dort liegen private SSH-Schlüssel, `known_hosts` und die Hostliste. Wer das
Gerät wechselt, legt Schlüssel neu an oder importiert sie.

### 4.6 Systemleisten und Bildschirmtastatur

Ab targetSdk 35 zeichnet jede App randlos unter Status- und Navigationsleiste,
und die Tastatur verkleinert das Fenster nicht mehr von selbst.
`MainActivity` gibt dem WebView deshalb genau die freie Fläche: Leisten,
Kamera-Aussparung und Tastatur werden zum Innenabstand seines Elternelements.
Öffnet sich die Tastatur, wird der WebView niedriger, das `resize` lässt die
Terminals ihre Zeilen anpassen, und die Touch-Leiste steht direkt über der
Tastatur. Die Systemleisten tragen helle Symbole auf dem dunklen Fenster.

Folge für V12: Jedes Öffnen und Schließen der Tastatur ist ein
`resize_terminal`. Ein Agent wie Codex, der beim Resize den Verlauf löscht,
verliert ihn dabei auf dem Host; dasselbe gilt am Desktop für jede
Fenstergröße. Hingenommen, steht in §5.5.

### 4.7 16-KB-Seiten

NDK r28 und neuer richten native Bibliotheken für arm64 auf 16 KB aus; das
Android-Gradle-Plugin legt sie unkomprimiert und ausgerichtet ins Paket. Der
Signaturjob richtet die APK mit `zipalign -P 16` aus und prüft das nach dem
Signieren.

## 5 Bedienung auf dem Telefon

Alles Folgende gilt nur auf Android (`platform.ts`: User-Agent enthält
„Android“). Der Desktop bekommt keine dieser Ansichten; sein DOM bleibt gleich.

### 5.1 Kompakte Ansicht

Bis 720 px Breite (jedes Telefon hochkant) und auf Bildschirmen bis 500 px
Höhe (jedes Telefon quer), zusammen `COMPACT_QUERY`. Für die Höhe zählt der
Bildschirm (`device-height`), nicht das Fenster, das die Tastatur verkleinert:
Ein Tablet quer bleibt so auch beim Tippen beim Desktop-Layout.

- `#app` hat eine Spalte: oben eine Kopfleiste (Knopf „Sessions“ mit Zahl der
  Wartenden, Name der fokussierten Session), darunter das Raster ohne
  Leinwandrand.
- Die Seitenleiste ist eine Schublade über dem Raster (Ebene 20 der
  Stapelleiter). Sie überdeckt es, statt es zu verkleinern: Öffnen und
  Schließen ändert keine Terminalgröße.
- Das Raster zeigt genau eine Kachel, die fokussierte, maximiert. Die übrigen
  bleiben verbunden; die Seitenleiste führt sie mit Nummer.
- Ohne Kachel steht die Schublade offen. Ein Tipp auf eine Session öffnet sie,
  schließt die Schublade und legt den Fokus ins Terminal.
- Die Zurück-Geste schließt eine offene Schublade. Dafür meldet sich die
  Ansicht nur an, solange die Schublade über einer Kachel offen ist; sonst
  bleibt die Geste bei Android und legt die App in den Hintergrund.
- Breiter (Tablet quer) gilt das Desktop-Layout mit Touch-Leiste. Beim Wechsel
  gibt die Ansicht nur das Maximieren frei, das sie selbst gesetzt hat.

### 5.2 Touch-Leiste

Eine Zeile unter dem Raster, waagerecht rollbar: Esc, Tab, Ctrl, Alt, ←, ↓, ↑,
→, Home, End, PgUp, PgDn, `|`, `~`, `/`, `-`.

- Die Bytes sind die der echten Tasten in xterm: Pfeile im Anwendungsmodus
  (DECCKM) als SS3, sonst CSI, mit Umschaltern als `CSI 1;<m>`.
- Ctrl und Alt rasten ein: Ein Tipp merkt den Umschalter für die nächste Taste
  vor, ob aus der Leiste oder von der Bildschirmtastatur, danach fällt er ab.
  Strg macht nur aus ASCII-Zeichen Steuerzeichen (Buchstaben, `@[\]^_`,
  Leertaste, `?`, und `/` wie `_` zu US); `ß` oder `ä` gehen unverändert.
  `terminal.ts` wendet ihn in `term.onData` an; Escape-Folgen (Antworten von
  xterm, Tasten einer echten Tastatur) bleiben unberührt.
- Kein Knopf nimmt den Fokus (`pointerdown` mit `preventDefault`): Die
  Tastatur bleibt offen, und Esc öffnet sie nicht.
- Tasten gehen über `term.input` den Weg getippter Eingabe, also auch durch
  Puffer und Eingabesperre.

### 5.3 Schlüssel auf dem Gerät

Auf Android gibt es weder `~/.ssh` des Nutzers noch einen ssh-agent. Das
Anmeldungsmenü zeigt dort statt „ssh-agent“:

- **Generate new key…**: `generate_ssh_key` erzeugt einen ed25519-Schlüssel
  ohne Passphrase (`aidevbridge_ed25519`, bei Bedarf mit Zähler) im
  `.ssh`-Ordner der App. Das Formular zeigt die Zeile für `authorized_keys`
  mit einem Knopf zum Kopieren.
- **Choose file…**: Die Dateiauswahl liefert eine `content://`-URI, die nur
  während dieser Wahl lesbar ist. `import_ssh_key` liest sie über das
  fs-Plugin (höchstens 64 KiB), prüft, dass es ein privater Schlüssel ist, den
  die Anmeldung laden kann (OpenSSH-Format auch verschlüsselt, PEM nur
  unverschlüsselt), und legt ihn als `imported_<art>` samt abgeleiteter
  `.pub` ab. Nichts wird überschrieben. Die Art kürzt `file_safe` auf
  `[A-Za-z0-9_-]`: Ein unbekannter Algorithmus heißt, was in der Datei steht,
  auch mit `/` und `..`.
- Danach führt `list_ssh_keys` beide wie jeden anderen Schlüssel.
- Beide Befehle antworten auf dem Desktop nur mit einem Fehler
  (`android_only`): Dort öffneten sie sonst beliebige Pfade, unter Windows
  auch UNC-Pfade mit SMB-Anmeldung, und schrieben ins echte `~/.ssh`.

Ausnahme von Spec §8.2 (private Dateien nie lesen): Die übernommene Datei muss
gelesen werden, sonst ließen sich weder ihre Art prüfen noch die `.pub`
ableiten. Der Inhalt liegt dabei nur in `Zeroizing`-Puffern.

### 5.4 Hintergrund und Wiederverbinden

Android friert eine App im Hintergrund nach kurzer Zeit ein; ihre
SSH-Verbindungen brechen ab. Beim Zurückkehren greift die vorhandene
Selbstheilung (Spec 2026-10-11): Hosts mit Schlüssel verbinden sich neu und
hängen ihre Terminals wieder an. Hosts mit Passwort fragen erneut.

### 5.5 Wischen im Terminal

xterm.js 6 rollt nicht mit dem Finger: Die Geste von VS Code ist eingebaut,
aber an kein Element gehängt. `touch-scroll.ts` übernimmt das im Terminal,
nach dem Vorbild von Termux:

- Ab 8 px ist ein Zug Wischen; darunter bleibt er ein Tipp, der wie bisher
  den Fokus legt und die Tastatur öffnet. Ab der Schwelle hält
  `preventDefault` die nachgeschobenen Mausereignisse an, `.tile-terminal`
  hat auf Android `touch-action: none`.
- Je Zeilenhöhe eine Zeile, Reste wandern in die nächste. Finger nach unten
  zeigt ältere Ausgabe.
- Schnelles Loslassen läuft aus (Zeitkonstante 325 ms, ab 0,3 px/ms); ein
  neuer Finger hält es an.
- Was eine Zeile bewirkt, entscheidet `terminal.ts` wie beim Mausrad am
  Desktop: Im eigenen Verlauf rollt `term.scrollLines` genau eine Zeile.
  Nutzt ein Programm die Maus (tmux mit `mouse on`) oder den zweiten
  Bildschirm, geht je Zeile ein Rad-Ereignis an xterm, an die Stelle, an der
  der Finger aufsetzte. xterm gibt es als Mausrad an tmux weiter (tmux rollt
  dann je Ereignis in seinem Verlauf) oder als Pfeiltaste.
- Zwei Finger rollen nicht; langes Drücken öffnet weiter das Terminalmenü.

### 5.6 Grenzen der ersten Fassung

- Kein Halten der Verbindung im Hintergrund (Vordergrunddienst) und keine
  Benachrichtigung, wenn ein Agent wartet. Beides wäre der nächste Schritt;
  ein Vordergrunddienst braucht in Play eine eigene Begründung.
- Markieren und Kopieren im Terminal per Finger ist so begrenzt wie in
  xterm.js; Einfügen geht über die Zwischenablage der Bildschirmtastatur.
- Tasten der Leiste wiederholen sich beim Halten nicht.
- Jedes Öffnen der Tastatur ändert die Terminalgröße (§4.6, V12).
- Strg+Umschalt-Kürzel gibt es nur mit einer Hardwaretastatur.
- Zurück-Geste ohne offene Schublade auf Android 7 bis 11: Dort beendet
  Android die Aktivität; erst ab Android 12 legt die Geste die Startaktivität
  nur in den Hintergrund. Ob Tauri nach dem Beenden sauber neu aufbaut, ist
  auf einem solchen Gerät noch zu prüfen; sonst bekommt `MainActivity` einen
  Rückruf mit `moveTaskToBack`.

## 6 Bau, Signatur, Veröffentlichung

### 6.1 Workflow `android.yml`

- **Vorschau** bei jedem Push auf `main` und jedem Pull Request: unsignierte
  APK für arm64, als Artefakt des Laufs, nie veröffentlicht.
- **Release** bei einem Tag `v*` oder einem Handlauf mit Tag: AAB und
  universelle APK für drei ABIs, dann die Jobs `sign`, `publish` und `play`.
- **Probelauf** von Hand mit `release`: baut wie ein Release, prüft
  Lizenztexte und Ausrichtung, signiert und veröffentlicht nichts. Der Test
  vor einem Tag, denn sonst liefe der Release-Pfad erst beim Tag selbst.
- **Prüfungen im Build-Job:** Die Lizenztexte stehen Byte für Byte in APK
  und App Bundle (aus dem Play die ausgelieferten Pakete baut). Jede native
  64-Bit-Bibliothek (arm64-v8a, x86_64) hat ihre LOAD-Segmente auf 16 KB
  ausgerichtet (`llvm-readelf`; `zipalign -P 16` im Sign-Job ordnet nur die
  Zip-Einträge). armeabi-v7a bleibt bei 4 KB: 16-KB-Seiten gibt es nur auf
  64-Bit-Geräten, und Play verlangt sie nur dort (der erste Probelauf vom
  29.10. hatte die 32-Bit-Bibliothek fälschlich mitgeprüft).
- `publish` teilt sich mit dem Publish-Job von `packages.yml` eine
  Concurrency-Gruppe je Tag: Beide lesen und schreiben den Release-Text, und
  gleichzeitig verlöre einer den Abschnitt des anderen.

### 6.2 Signatur

- Ein Projektschlüssel (`aidevbridge-release.jks`, PKCS12, RSA 4096, Alias
  `upload`, gültig bis 2054) signiert das AAB für Play (Upload-Schlüssel) und
  die APK am GitHub-Release. Er liegt außerhalb des Repositorys
  (`%USERPROFILE%\aidevbridge-android-signing`); `keystore.properties` daneben
  nennt Pfad und Passwort. Eine Kopie unter `src-tauri/gen/android/` (von git
  ignoriert) signiert lokale Release-Bauten; `app/build.gradle.kts` liest sie
  oder die Umgebungsvariablen `ANDROID_KEYSTORE_*`/`ANDROID_KEY_*`, ohne beides
  bleibt der Bau unsigniert.
- **Wie U2 für macOS:** Der Bauschritt führt npm, Gradle-Plugins, `build.rs`
  und Proc-Makros aus und bekommt keine Secrets. Erst der Job `sign` bekommt
  die fertigen Dateien und den Schlüssel, aus dem GitHub-Environment
  `android-release`, und führt nur `zipalign`, `apksigner` und `jarsigner`
  aus; die Build-Tools lädt ein Schritt davor, der den Schlüssel nicht sieht.
  `scripts/android-github-secrets.ps1` legt die Secrets an und erlaubt das
  Environment nur Tags `v*`, auf Wunsch mit Freigabe durch den Maintainer.
  `jarsigner -verify` läuft ohne `-strict`, das jeden selbstsignierten
  Upload-Schlüssel mit Exit 4 ablehnte (Befund der Durchsicht vom 29.10.).
- **Play App Signing:** Google erzeugt und verwahrt den App-Signaturschlüssel.
  Geht der Upload-Schlüssel verloren, setzt der Play-Support ihn zurück; die
  GitHub-APK bräuchte dann einen neuen Schlüssel und eine Neuinstallation.

### 6.3 Google Play

Der Job `play` lädt das AAB mit `r0adkll/upload-google-play` (an Commit
gepinnt) auf eine Spur: Vorgabe `internal`, beim Handlauf wählbar
(`alpha` = geschlossener Test, `beta`, `production`), dauerhaft über die
Repository-Variable `PLAY_TRACK`. Der Status ist `completed`, über
`PLAY_RELEASE_STATUS` auch `draft` (nötig, solange die App nie geprüft
wurde). „Neu in dieser Version“ kommt aus
`fastlane/metadata/android/<Sprache>/changelogs/<versionCode>.txt`, sonst
`default.txt`. Ohne das Secret `PLAY_SERVICE_ACCOUNT_JSON` überspringt der Job
den Upload; das AAB bleibt Artefakt des Laufs. Die allererste Version muss
von Hand in die Play Console, weil die API eine App ohne Upload nicht kennt.

### 6.4 GitHub-Release

Der Job `publish` hängt `aidevbridge-<version>-android.apk` an das Release
des Tags (legt es an, wenn `packages.yml` es noch nicht angelegt hat), ersetzt
nie eine veröffentlichte Datei und schreibt den Abschnitt „Android“ des
Releasetexts zwischen eigene Markierungen (`release-notes.mjs`,
`androidSection`); `packages.yml` lässt ihn stehen. APK und AAB bekommen eine
Build-Provenienz wie die Desktop-Pakete.

## 7 Store-Eintrag

### 7.1 Texte

`fastlane/metadata/android/{en-US,de-DE}/`: Titel (28 von 30 Zeichen),
Kurzbeschreibung (77/76 von 80), Beschreibung, `changelogs/default.txt`. Das
Format lesen Play (über die API oder `fastlane supply`), F-Droid und
IzzyOnDroid.

### 7.2 Grafiken

`scripts/android-store-graphics.ps1` rendert aus `fastlane/store-graphics/`
das Store-Icon (512 × 512, randlos) und die Feature-Grafik (1024 × 500) in
beide Sprachen. Drei vorläufige Bildschirmfotos (968 × 1920) zeigen die echte
Oberfläche mit Beispieldaten, gerendert im Browser mit Android-Kennung; echte
vom Telefon ersetzen sie besser (Plan, Schritt 12).

### 7.3 Datenschutz und Berechtigungen

- Datenschutzerklärung: [`PRIVACY.md`](../../PRIVACY.md), als URL im Store
  `https://github.com/ITBrain258/aidevbridge/blob/main/PRIVACY.md`.
- Einzige Berechtigung: `INTERNET`.
- Datensicherheit („Data safety“): Die App erhebt und teilt keine Daten. Sie
  überträgt nur an Server, die der Nutzer selbst einträgt, und das
  Ende-zu-Ende-verschlüsselt per SSH; Googles Definition nimmt solche
  Übertragungen aus. Die Antworten stehen in der Anleitung, Schritt C5.

### 7.4 Einstufung, Zielgruppe, App-Zugriff

- Kategorie „Tools“, Einstufung über den Fragebogen (keine Gewalt, keine
  Nutzerinteraktion, kein Glücksspiel) → USK 0 / PEGI 3.
- Zielgruppe 18+, nicht für Kinder; damit gilt die Familienrichtlinie nicht.
- App-Zugriff: kein Konto; die Prüfer brauchen einen SSH-Host mit tmux. Der
  Text dafür steht in der Anleitung; ein eigener Prüfhost ist optional.

## 8 Lizenzen

Wie die Desktop-Pakete liefert die Android-App die Lizenztexte der
enthaltenen Fremdsoftware mit, als `assets/licenses/` in APK und App Bundle.
Die Auswahl `docs/release/license-selection.android-universal.json` (am
28.10. abgeleitet, 486 Komponenten, 226 Texte) entsteht wie die macOS-Auswahl
aus der Windows-Auswahl, mit `scripts/release-license-select-android.mjs`:

- **Rust-Krates** der drei Android-Ziele, Rollen mit dem Linux-Runner als
  Bau-Host (ein kleiner rustc-Wrapper gibt ihn auf anderen Rechnern vor).
  Gemeinsame Pakete behalten die Windows-Entscheidung; die 35 nur für
  Android haben je eine eigene. Vier Krates ohne Lizenzdatei bekommen den
  Text ihres Repositorys zum Veröffentlichungs-Commit bzw. die schon
  geprüften Texte von tao.
- **MPL-2.0 in der App:** Auf Android hängt wry zur Laufzeit an dom_query
  und damit an cssparser, selectors und dtoa-short; unter Windows liefen sie
  nur beim Bauen. Sie, cssparser-macros (dessen Expansionen in ihnen stecken)
  und vorsichtshalber option-ext sind mit MPL-2.0-Text und dem Ort der
  unveränderten Quelle (crates.io, SHA-256 aus `Cargo.lock`, MPL §3.2)
  eingeschlossen.
- **Rust-Standardbibliothek** der drei Ziele wie bei macOS; auf Android
  linkt std die libunwind des NDK.
- **NDK:** libunwind und compiler-rt-Builtins (LLVM-NOTICE des NDK) und die
  Bionic-Startobjekte `crtbegin_so.o`/`crtend_so.o` (NOTICE des NDK), beide
  NDK 29.0.14206865. Die gebauten Bibliotheken hängen nur an
  Android-Systembibliotheken (libc, libm, libdl, liblog, libandroid).
- **Java/Kotlin:** jede der 79 Bibliotheken des Release-Klassenpfads aus
  `src-tauri/gen/android/app/gradle.lockfile`, alle Apache-2.0. Texte, die
  ein Artefakt mitbringt (AndroidX, Jackson samt NOTICE), werden übernommen,
  weil Androids Paketierung `META-INF`-Lizenzdateien weglässt; dazu die
  NOTICE-Dateien von Kotlin, kotlinx.coroutines und kotlinx.serialization und
  Kotlins Drittanbieter-Index (GWT, Guava, Boost) zum jeweiligen Tag.
- **Frontend und npm** unverändert wie unter Windows.

Gradle sperrt die Abhängigkeiten über die Lockdatei: Eine neue oder
geänderte Bibliothek lässt den Bau scheitern, bis die Lockdatei neu
geschrieben ist, und dann `release-licenses.mjs check android-universal`, bis
die Auswahl neu abgeleitet ist. Der Release-Lauf von `android.yml` bereitet
den Ordner aus der Auswahl vor, legt ihn in die Assets und vergleicht nach
dem Bau jede Datei in der APK; Vorschau-Bauten tragen nur einen Hinweis.

Die Windows- und die macOS-Auswahl binden die eigenen Quellbäume; sie sind
vor dem nächsten Release ohnehin neu zu binden und erfassen dann auch die
Android-Dateien dieses Branches.

## 9 Entscheidungen für den Maintainer

- **Version der ersten Android-Ausgabe:** Vorschlag 0.3.0 (neue Plattform,
  neuer versionCode 3000).
- **Ein Schlüssel für Play-Upload und GitHub-APK** (so umgesetzt) oder zwei
  getrennte Schlüssel. Ein eigener App-Signaturschlüssel in Play (statt des
  von Google erzeugten) machte Play- und GitHub-APK austauschbar, kostet aber
  einen zusätzlichen Schritt in der Play Console.
- **Prüfhost für Googles Review:** ohne Host kann der Prüfer nur Formular und
  Schublade sehen. Erfahrungsgemäß reicht die Erklärung; ein Demo-Host
  beschleunigt die Prüfung.
- **Vordergrunddienst und Benachrichtigungen** (§5.5) als nächster Ausbau.
