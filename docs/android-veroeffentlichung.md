# aidevbridge im Google Play Store: Anleitung

Stand 27.10.2026. Diese Anleitung führt von dem, was auf dem Branch
`feat/android` schon fertig ist, bis zur App im Play Store und zu jedem
späteren Update. Die Entscheidungen dahinter stehen in der
[Spec](specs/2026-10-27-android-design.md), der Stand der Schritte im
[Plan](plans/2026-10-27-android.md).

Grob: **A** ist erledigt. **B** und **D** sind je etwa eine Viertelstunde am PC.
**C** ist die Play Console mit Wartezeiten bei Google: Kontoprüfung (Tage),
für ein neues privates Konto ein geschlossener Test mit 12 Testern über 14
Tage, danach die Prüfung der App (meist 1 bis 7 Tage). **E** ist jedes
spätere Update: ein Tag, sonst nichts.

---

## A Was schon erledigt ist

Auf dem Branch `feat/android` (Worktree
`.claude/worktrees/android`):

- **Android-Projekt** unter `src-tauri/gen/android`: Ziel Android 16 (API 36),
  ab Android 7.0, App-Icon, dunkles Theme, randlose Darstellung mit Platz für
  Systemleisten und Tastatur, keine Cloud-Sicherung der Schlüssel, einzige
  Berechtigung Internet.
- **Backend**: läuft auf Android (eigene Ordner der App statt `~/.ssh`),
  Schlüssel auf dem Gerät erzeugen oder importieren.
- **Oberfläche fürs Telefon**: kompakte Ansicht mit Session-Schublade,
  Tastenleiste (Esc, Tab, Strg, Alt, Pfeile …), Android-Zurück-Geste.
- **Signaturschlüssel** in `C:\Users\test\aidevbridge-android-signing\`
  (siehe `LIES-MICH.txt` dort). **Bitte sichern**, Schritt B4.
- **Werkzeuge auf diesem PC**: Android-SDK (Plattform 36, Build-Tools, NDK r29,
  Emulator) in `%LOCALAPPDATA%\Android\Sdk`, JDK 21 in
  `%USERPROFILE%\.jdks\jdk-21.0.12.1+1`, Rust-Ziele für Android.
- **CI** `.github/workflows/android.yml`: baut bei jedem Tag AAB und APK,
  signiert sie in einem eigenen Job, hängt die APK ans GitHub-Release und lädt
  das AAB zu Google Play.
- **Store-Eintrag** in `fastlane/metadata/android/` (Deutsch und Englisch):
  Titel, Kurz- und Langbeschreibung, Änderungstext, Icon 512 × 512,
  Feature-Grafik 1024 × 500. Datenschutzerklärung `PRIVACY.md`.
- **Testpakete** der aktuellen Fassung (arm64, armv7 und x86_64, signiert,
  mit den Lizenztexten in `assets/licenses/`):
  `C:\Users\test\Desktop\aidevbridge-android\` (siehe B3).
- **Lizenzauswahl für Android** (`docs/release/license-selection.android-universal.json`):
  Rust-Krates, NDK-Teile und alle Java-/Kotlin-Bibliotheken; der Release-Lauf
  legt die Texte in die App und prüft sie (Spec §8).
- **Pull Request #10** mit allem oben; CI und erster Android-Bau grün.

Was fehlt und nur du tun kannst: Konten anlegen und bestätigen, Bildschirmfotos
vom echten Gerät, der Test am Telefon und das Zusammenführen des Branches.

---

## B Am PC, einmalig

### B1 Pull Request

Erledigt: `feat/android` ist gepusht, Pull Request #10 offen, CI und
Android-Vorschau grün. Zusammenführen erst nach Test und Abnahme (B3).

### B2 Windows-Entwicklermodus (für lokale Android-Bauten)

`tauri android build` hängt die gebaute Bibliothek per Symlink ein, und
Windows erlaubt Symlinks nur im Entwicklermodus:
**Einstellungen → System → Für Entwickler → Entwicklermodus: Ein.**
Ohne ihn bricht ein lokaler Bau nach dem Kompilieren mit „Creation symbolic
link is not allowed“ ab. Die CI braucht das nicht.

Danach baut im Repository:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME     = "$env:LOCALAPPDATA\Android\Sdk\ndk\29.0.14206865"
$env:JAVA_HOME    = "$env:USERPROFILE\.jdks\jdk-21.0.12.1+1"
npm run tauri -- android build --apk --aab --target aarch64
```

Ergebnis, signiert mit deinem Schlüssel:
`src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk`
und `...\bundle\universalRelease\app-universal-release.aab`.

Ein lokal gebautes Paket enthält die Lizenztexte nur, wenn sie vorher in den
Assets liegen. Für ein Paket, das du weitergibst oder hochlädst, vor dem Bau:

```powershell
node scripts/release-licenses.mjs prepare android-universal
New-Item -ItemType Directory -Force src-tauri\gen\android\app\src\main\assets\licenses | Out-Null
Copy-Item -Recurse -Force out\release-notices-android\* src-tauri\gen\android\app\src\main\assets\licenses\
```

Die Release-Läufe der CI machen das selbst.

**Android Studio** (optional): beim ersten Start „Custom“ wählen und als SDK
`%LOCALAPPDATA%\Android\Sdk` angeben (ist schon eingerichtet), dann
`src-tauri\gen\android` öffnen. Als Gradle-JDK nimmt es Java 21 aus
`~\.jdks` (das Projekt verlangt es in `gradle/gradle-daemon-jvm.properties`).
Das mitgelieferte Java 25 geht mit diesem Gradle nicht.

### B3 Auf dem eigenen Telefon testen

Auf diesem PC startet der Android-Emulator nicht: Die VM reicht keine
Virtualisierung durch. Die Ansicht fürs Telefon ist deshalb bisher nur in
einer Vorschau im Browser geprüft. Am echten Telefon:

1. `C:\Users\test\Desktop\aidevbridge-android\aidevbridge-android.apk`
   aufs Telefon kopieren (Kabel, Cloud, Mail an dich selbst) und dort öffnen;
   Android fragt einmal, ob diese Quelle Apps installieren darf.
   Oder per Kabel: Telefon in den Entwickleroptionen auf „USB-Debugging“,
   dann `& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r <apk>`.
2. Testen (Checkliste):
   - Host anlegen mit **Generate new key…**, die angezeigte Zeile auf dem
     Host an `~/.ssh/authorized_keys` anhängen (etwa über aidevbridge am
     Desktop), verbinden, Hostschlüssel bestätigen.
   - Alternativ **Choose file…** mit einer privaten Schlüsseldatei oder
     **Password**.
   - Session öffnen: Terminal füllt den Bildschirm, Tastatur öffnet beim
     Tippen, die Tastenleiste steht über der Tastatur, Strg dann C bricht ab,
     Pfeile funktionieren in der Shell und in `less`.
   - Oben „Sessions“: Schublade auf und zu, Zurück-Geste schließt sie, eine
     zweite Session öffnen und zwischen beiden wechseln.
   - App in den Hintergrund und nach ein paar Minuten zurück: der Host
     verbindet sich neu.
   - Drehen ins Querformat.
3. **Bildschirmfotos:** Unter
   `fastlane/metadata/android/<Sprache>/images/phoneScreenshots/` liegen schon
   drei vorläufige (Terminal, Hostliste, neuer Schlüssel). Sie zeigen die
   echte Oberfläche mit Beispieldaten, gerendert im Browser; Schriften und
   Systemleisten weichen vom Telefon ab. Besser: beim Test eigene vom Telefon
   machen (Ein/Aus + Leiser) und die Dateien `1.png` usw. ersetzen. Keine
   echten Hostnamen oder Inhalte zeigen, die du nicht veröffentlichen willst.

Fehler oder Auffälligkeiten bitte notieren; ich behebe sie vor dem Release.

### B4 Signaturschlüssel sichern

Den Ordner `C:\Users\test\aidevbridge-android-signing\` (Schlüssel,
Passwort, `LIES-MICH.txt`) an einen zweiten Ort kopieren: Passwortmanager mit
Dateianhang oder verschlüsselter USB-Stick. Nie ins Repository, nie in Chat
oder Mail.

---

## C Google Play Console

### C1 Entwicklerkonto anlegen

1. <https://play.google.com/console/signup> mit dem Google-Konto, unter dem
   die App erscheinen soll.
2. **Kontotyp:** „Für mich selbst“ (privat) oder „Für eine Organisation“
   (braucht eine D-U-N-S-Nummer). Für ein Open-Source-Projekt einer Person:
   privat.
3. Einmalige Gebühr 25 US-Dollar.
4. **Identität bestätigen:** Ausweis, Adresse, Telefonnummer, Kontakt-E-Mail.
   Dazu bestätigt die Play-Console-App auf einem Android-Telefon, dass du
   Zugang zu einem echten Gerät hast. Die Prüfung dauert Stunden bis einige
   Tage.
5. Öffentlich sichtbar sind der Entwicklername und eine Kontakt-E-Mail. Nimm
   ruhig eine eigene Adresse dafür; die private Anschrift bleibt bei einem
   privaten Konto ohne Verkäufe verborgen.

### C2 App anlegen

**Alle Apps → App erstellen**

| Feld | Eintrag |
| --- | --- |
| App-Name | `aidevbridge` |
| Standardsprache | Englisch (USA) – en-US |
| App oder Spiel | App |
| Kostenlos oder kostenpflichtig | Kostenlos |
| Erklärungen | Richtlinien für Entwickler und US-Exportgesetze bestätigen |

Der Paketname steht ab dem ersten Upload fest:
`io.github.itbrain258.aidevbridge`.

### C3 Store-Eintrag

**Wachstum → Store-Präsenz → Haupteintrag im Store**

- App-Name: Inhalt von `fastlane/metadata/android/en-US/title.txt`
- Kurzbeschreibung: `.../en-US/short_description.txt`
- Vollständige Beschreibung: `.../en-US/full_description.txt`
  (die `<b>`-Auszeichnung übernimmt Play)
- App-Symbol: `.../en-US/images/icon.png`
- Feature-Grafik: `.../en-US/images/featureGraphic.png`
- Screenshots Telefon: `.../en-US/images/phoneScreenshots/1.png` bis `3.png`
  oder deine eigenen aus B3 (mindestens 2)
- Optional Tablet-Screenshots (7 und 10 Zoll), sonst erscheint die App auf
  Tablets mit dem Hinweis, nicht dafür gestaltet zu sein.

Dann **Übersetzung hinzufügen → Deutsch (de-DE)** mit den Dateien aus `de-DE`.

**Store-Einstellungen:** App-Kategorie **Tools**, Tags z. B. „Entwickler“,
Kontakt-E-Mail (öffentlich), Website
`https://github.com/ITBrain258/aidevbridge`.

### C4 Datenschutzerklärung

**Richtlinien → App-Inhalte → Datenschutzerklärung:**
`https://github.com/ITBrain258/aidevbridge/blob/main/PRIVACY.md`
(erreichbar, sobald `feat/android` in `main` ist).

### C5 App-Inhalte (Fragebögen)

**Richtlinien → App-Inhalte**, jeweils „Starten“:

| Abschnitt | Antwort |
| --- | --- |
| Anzeigen | Nein, keine Anzeigen |
| App-Zugriff | „Alle oder einige Funktionen sind eingeschränkt“ → Anleitung unten |
| Einstufung | Fragebogen, Kategorie „Alle anderen App-Typen“; alle Fragen Nein (keine Gewalt, keine Sexualität, kein Glücksspiel, kein Nutzer-zu-Nutzer-Austausch, kein Standort teilen, keine digitalen Käufe) → PEGI 3 / USK 0 |
| Zielgruppe | 18 Jahre und älter; „Spricht die App Kinder an?“ Nein |
| Nachrichten-App | Nein |
| Datensicherheit | siehe unten |
| Werbe-ID | Nein, die App verwendet keine Werbe-ID |
| Behörden-App | Nein |
| Finanzfunktionen | Keine |
| Gesundheit | Keine Gesundheitsfunktionen |

**App-Zugriff, Text für die Prüfer** (englisch):

> aidevbridge is an SSH client. It needs no account. To try the main
> function, add any Linux host that you can reach over SSH and that has tmux
> 3.0 or newer installed: tap "Add host", enter host name, user and port,
> choose "Password" or "Generate new key…" (then add the shown public key to
> ~/.ssh/authorized_keys on the host), and tap Connect. The host's tmux
> sessions appear in the list; tap one to open its terminal.

Wenn du einen Prüfhost bereitstellen willst (beschleunigt die Prüfung, ist
aber nicht nötig): einen kleinen VPS mit eigenem Benutzer, nur tmux, und
dessen Zugangsdaten hier eintragen.

**Datensicherheit:**

1. „Erhebt oder teilt deine App erforderliche Nutzerdatentypen?“ → **Nein**.
   Begründung für dich: Die App überträgt Daten nur an Server, die der Nutzer
   selbst einträgt, und nur Ende-zu-Ende-verschlüsselt per SSH; Google nimmt
   so übertragene Daten von der Angabepflicht aus. An dich oder Dritte geht
   nichts.
2. „Sind alle Nutzerdaten bei der Übertragung verschlüsselt?“ → Ja.
3. „Können Nutzer das Löschen ihrer Daten anfordern?“ → Es werden keine Daten
   erhoben; Hinweis: Deinstallieren oder Host in der App entfernen.

### C6 Erste Version hochladen (interner Test)

Die allererste Version muss von Hand hochgeladen werden; danach übernimmt die
CI.

1. **Testen und veröffentlichen → Testen → Interner Test → Neuen Release
   erstellen.**
2. **App-Signatur:** „Play App Signing“ mit von Google erstelltem Schlüssel
   annehmen (Voreinstellung). Dein Schlüssel ist ab dann der Upload-Schlüssel.
3. App Bundle hochladen:
   `C:\Users\test\Desktop\aidevbridge-android\aidevbridge-android.aab`
   (Testbau dieses Branches, Version 0.2.3) oder besser das signierte AAB aus
   dem ersten Release-Lauf der CI (E2, Artefakt `android-signed`).
4. Release-Name z. B. `0.3.0`, Versionshinweise aus `changelogs/default.txt`.
5. **Speichern → Release überprüfen → Roll-out für internen Test starten.**
6. **Tester:** E-Mail-Liste anlegen (bis 100), Link zum Beitreten an dich und
   die Tester schicken. Die App kommt dann über Play aufs Telefon.

Play meldet vielleicht „Keine Deobfuskierungsdatei“ und „native
Debugsymbole fehlen“. Beides sind Hinweise, keine Fehler; die CI lädt die
R8-Zuordnung (`mapping.txt`) ab dem zweiten Upload mit.

### C7 Geschlossener Test mit 12 Testern (nur neue private Konten)

Neue private Entwicklerkonten dürfen erst in die Produktion, wenn ein
geschlossener Test mit **mindestens 12 Testern** **14 Tage am Stück** lief.

1. **Testen → Geschlossener Test → Track „Alpha“ → Tester:** eine Google
   Group oder E-Mail-Liste mit mindestens 12 Personen (Kollegen, Freunde;
   jede braucht ein Google-Konto und ein Android-Gerät).
2. Release aus dem internen Test in den geschlossenen Test übernehmen
   („Release hochstufen“) oder in E2 den Track `alpha` wählen.
3. Jeder Tester öffnet den Beitrittslink, nimmt teil, installiert die App und
   behält sie 14 Tage. Fällt die Zahl darunter, beginnt die Frist neu.
4. Danach erscheint im **Dashboard „Produktionszugriff beantragen“**: ein
   paar Fragen zum Test beantworten. Google antwortet meist binnen einer
   Woche.

Ein Organisationskonto braucht diesen Schritt nicht.

### C8 Produktion

**Produktion → Neuen Release erstellen** (oder den Release aus dem
geschlossenen Test hochstufen) → Länder wählen (alle) → **Zur Prüfung
senden.** Die erste Prüfung dauert meist 1 bis 7 Tage. Danach ist die App
öffentlich unter
<https://play.google.com/store/apps/details?id=io.github.itbrain258.aidevbridge>.

---

## D Automatisierung einrichten, einmalig

### D1 Signaturschlüssel in die CI

Nachdem `feat/android` in `main` ist, im Repository:

```powershell
pwsh -File scripts/android-github-secrets.ps1
```

Das legt das GitHub-Environment `android-release` an und darin die vier
Secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Nur die Jobs `sign` und `play`
sehen sie.

Empfohlen: **GitHub → Settings → Environments → android-release →
Deployment branches and tags → Selected: Tag `v*`.** Dann kann nur ein Tag
den Schlüssel benutzen.

### D2 Zugang der CI zu Google Play

1. <https://console.cloud.google.com> → neues Projekt „aidevbridge-play“.
2. **APIs & Dienste → Bibliothek → „Google Play Android Developer API“ →
   Aktivieren.**
3. **IAM & Verwaltung → Dienstkonten → Dienstkonto erstellen**, Name
   `github-release`, keine Rolle zuweisen → fertig. Dann beim Dienstkonto
   **Schlüssel → Schlüssel hinzufügen → JSON** → die Datei wird
   heruntergeladen.
4. **Play Console → Nutzer und Berechtigungen → Neue Nutzer einladen:** die
   E-Mail des Dienstkontos (`github-release@…iam.gserviceaccount.com`).
   Unter **App-Berechtigungen** aidevbridge hinzufügen mit
   „Releases für Test-Tracks veröffentlichen“ und, wenn die CI auch direkt in
   die Produktion soll, „Releases in der Produktion veröffentlichen …“.
   **Nutzer einladen.**
5. Im Repository:

   ```powershell
   pwsh -File scripts/android-github-secrets.ps1 -SkipKeystore -PlayServiceAccountJson "$HOME\Downloads\<datei>.json"
   ```

   Danach die JSON-Datei löschen.

### D3 Spur wählen (optional)

Ohne weitere Einstellung lädt jeder Tag in den **internen Test**; von dort
stufst du in der Play Console hoch. Wer direkt veröffentlichen will:
**GitHub → Settings → Secrets and variables → Actions → Variables:**
`PLAY_TRACK` = `production` (oder `alpha` für den geschlossenen Test).
Solange die App noch nie geprüft wurde, verlangt Play Entwürfe: dann
`PLAY_RELEASE_STATUS` = `draft` und den Entwurf in der Console freigeben.

---

## E Jede neue Version

1. Version erhöhen wie bisher: `npm run bump 0.3.0`, `CHANGELOG.md` pflegen.
2. Optional eigener Store-Text für diese Version:
   `fastlane/metadata/android/<Sprache>/changelogs/<versionCode>.txt`, mit
   versionCode = Major × 1.000.000 + Minor × 1.000 + Patch (0.3.0 → 3000;
   höchstens 500 Zeichen). Sonst gilt `default.txt`.
3. Commit, Tag, Push:

   ```powershell
   git tag v0.3.0
   git push origin main v0.3.0
   ```

4. Automatisch: `packages.yml` baut Windows und macOS, `android.yml` baut,
   signiert, hängt `aidevbridge-0.3.0-android.apk` ans Release und lädt das
   AAB in die Play-Spur.
5. In der Play Console den Release hochstufen (wenn nicht direkt
   `production`).

Ein fehlgeschlagener Play-Upload lässt sich ohne neuen Tag wiederholen:
**Actions → Android → Run workflow**, Tag `v0.3.0`, Spur wählen. Eine schon
hochgeladene Version nimmt Play nicht noch einmal an; dann eine neue
Patch-Version.

---

## F Wenn etwas hakt

| Meldung | Ursache und Abhilfe |
| --- | --- |
| `Creation symbolic link is not allowed for this system` | Windows-Entwicklermodus fehlt (B2). |
| `Unsupported class file major version 69` | Gradle läuft mit Java 25; `JAVA_HOME` auf das JDK 21 setzen bzw. in Android Studio Gradle-JDK 21 wählen. |
| `SDK location not found` | `ANDROID_HOME` setzen oder in `src-tauri/gen/android/local.properties` `sdk.dir=C\:\\Users\\test\\AppData\\Local\\Android\\Sdk`. |
| Play: „Version code … has already been used“ | Version erhöhen (E1). |
| Play: „Only releases with status draft may be created on draft app“ | `PLAY_RELEASE_STATUS` = `draft` (D3). |
| Play: „The caller does not have permission“ | Dienstkonto in der Play Console nicht eingeladen oder ohne Recht für die App (D2 Schritt 4); nach dem Einladen kann es bis zu einem Tag dauern. |
| Job `sign`: „Secret … is missing“ | D1 ausführen. |
| App startet, bleibt aber schwarz | `adb logcat -s RustStdoutStderr Tauri chromium` zeigt die Ursache; bitte mitschicken. |
| Die Play-Version lässt sich nicht über die GitHub-APK installieren | Gewollt: verschiedene Signaturen (Spec §3). Erst deinstallieren. |
