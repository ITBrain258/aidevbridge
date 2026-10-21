# Messung Statussignale, 2026-09-05

Host 192.0.2.20, tmux 3.4, bash. Agents: Claude Code 2.1.261, Codex 0.93.0, Grok 1.0.13.

Aufbau nach Spec Abschnitt 5: eigener tmux-Socket `abmess`, Session `mess` (120x40),
kein Client angehaengt, je Agent ein eigenes Fenster mit `bash -l`. Ein Sampler las
jede Sekunde `pane_title`, `pane_current_command`, `alternate_on`, `window_bell_flag`
und `window_activity` in eine Logdatei. Alle Zeiten sind Ortszeit der VM (CEST).
Die Rohlogs liegen nicht im Repo (Spec 5: nur das Ergebnisdokument), die belegenden
Zeilen stehen unten in "Rohbefunde".

## Einordnung und Korrektur vom 2026-09-08

Die folgenden Rohbefunde, Versionen und Zeitreihen dokumentieren die Messung vom
2026-09-05. Sie wurden nicht erneut gemessen. Die damaligen Schlussfolgerungen sind
keine Freigabe fuer produktive Statusprofile: insbesondere das Claude-Arbeitsmuster
und die Ableitung eines Wartezustands aus BEL plus Aktivitaet werden zurueckgenommen.
Massgeblich ist die [korrigierte Status-Spec, Abschnitte 4 bis 6](../specs/2026-09-05-mvp-und-statuspunkt-design.md#4-design-des-statuspunkts).
Die Spalte `erkennbar` unten beschreibt die damalige Bewertung im Messaufbau; deren
Grenzen stehen in den korrigierten Profilhinweisen und der Bewertung weiter unten.

Die Identitaet des als Grok 1.0.13 bezeichneten Programms ist anhand des nativen
Binaries `~/.grok/bin/grok`, der Version und des Sitzungsverzeichnisses mit xAI
Grok Build vereinbar, hier aber nicht durch Hersteller- oder Paketmetadaten belegt.
Aktuelle Hook-Dokumentation ist auch fuer Codex kein Nachweis fuer Funktionen der
hier gemessenen Version 0.93.0. Vor einem Adapter gelten die Versions-, Herkunfts-
und Lebenszykluspruefungen der korrigierten Spec.
## Je Agent

| Agent | Zustand | pane_title (Muster) | pane_current_command | alternate_on | erkennbar |
|---|---|---|---|---|---|
| Claude Code | untaetig | `^✳ Claude Code$` (nur vor der ersten Aufgabe); nach jeder Aufgabe bleibt `✳ <Aufgabenzusammenfassung>` stehen | `claude` | 1 | nein |
| Claude Code | arbeitet | `^✳ .+$` (`✳ <Aufgabenzusammenfassung>`) | `claude` | 1 | nein, nicht vom Titel her |
| Claude Code | wartet | `^✳ .+$`, identisch zu "arbeitet"; erkennbar nur an `window_bell_flag=1` und stehender `window_activity` | `claude` | 1 | nein am Titel, ja ueber BEL |
| Codex | untaetig | `^[^\x{2800}-\x{28FF}\[].*$` (`<basename des cwd>`, hier `abmess`) | `node` | 0 | ja |
| Codex | arbeitet | `^[\x{2800}-\x{28FF}] .*$` (`⠏ <basename des cwd>`) | `node` | 0 | ja |
| Codex | wartet | `^\[ [.!] \] Action Required \x7c .*$` (`[ . ]` und `[ ! ]` wechseln im Sekundentakt) | `node` | 0 | ja |
| Grok | untaetig | `^(?:[^\x{2800}-\x{28FF}\x{26A0}].* - )?grok$` (`grok` vor der ersten Aufgabe, danach `<Sitzungstitel> - grok`) | `grok` | 1 | ja |
| Grok | arbeitet | `^[\x{2800}-\x{28FF}] - .* - grok$` (`⠧ - <Schritt>… - <Sitzungstitel> - grok`) | `grok` | 1 | ja |
| Grok | wartet | `^⚠ Action Required - [\x{2800}-\x{28FF}] - .* - grok$` | `grok` | 1 | ja |

Erkennbar heisst: in allen drei Wiederholungen gleich gebaut und von den anderen
Zustaenden unterscheidbar.

Zeichen: `✳` ist U+2733, `⚠` ist U+26A0 (ohne Variantenselektor), die Spinner liegen
im Braille-Block U+2800 bis U+28FF, `…` ist U+2026. Pfade und Aufgabentexte sind in
den Mustern als `.*` gesetzt.

Der senkrechte Strich in Codex' Wartemuster steht absichtlich als `\x7c` und nicht als
`\|` da: in einer Markdown-Tabelle wird `\|` beim Rendern zu einem nackten `|`, und ein
nacktes `|` waere in Rust-`regex` eine Alternative, die fast jeden Titel traefe. `\x7c`
ist derselbe Zeichenwert und uebersteht die Tabelle unveraendert.

### Wiederholungen

Beginnzeiten der Abschnitte, aus den Logs berechnet. Bei Claude Code aus dem
Stillstand von `window_activity` (kein Titelwechsel vorhanden), bei Codex und Grok aus
dem Titelwechsel; jede Zuordnung wurde zusaetzlich per `capture-pane` am Bildschirm
gegengeprueft.

| Agent | untaetig | arbeitet | wartet |
|---|---|---|---|
| Claude Code | 4x (12:57:43, 12:59:43, 13:01:43, 13:04:01) | 4x (12:59:07, 13:01:11, 13:02:50, 13:03:33) | 4x (12:58:50, 13:00:51, 13:02:28, 13:03:25) |
| Codex | 4x (13:06:16, 13:07:46, 13:09:32, 13:11:07) | 6x (13:06:45, 13:07:13, 13:08:31, 13:09:01, 13:10:15, 13:10:44) | 3x (13:06:55, 13:08:39, 13:10:25) |
| Grok | 5x (13:12:20, 13:14:11, 13:16:29, 13:17:46, 13:19:03) | 4x (13:13:23, 13:16:26, 13:17:23, 13:18:34) | 3x (13:15:53, 13:16:59, 13:18:06) |

## Profilkandidaten aus der Messung, korrigiert am 2026-09-08

| Profil | commands | waiting | working | idle | idle_measured |
|---|---|---|---|---|---|
| Claude Code | `["claude"]` | `None` | `None` | `None` | `false` |
| Codex | `["node"]` | `^\[ [.!] \] Action Required \x7c .*$` | `^[\x{2800}-\x{28FF}] .*$` | `^[^\x{2800}-\x{28FF}\[].*$` | `true` |
| Grok CLI | `["grok"]` | `^⚠ Action Required - [\x{2800}-\x{28FF}] - .* - grok$` | `^[\x{2800}-\x{28FF}] - .* - grok$` | `^(?:[^\x{2800}-\x{28FF}\x{26A0}].* - )?grok$` | `true` |

Die urspruenglich vorgeschlagenen Muster wurden gegen die gemessenen Titel geprueft (Rust-`regex`-Syntax, ripgrep als
Referenzimplementierung): das Codex-Arbeitsmuster trifft genau die neun Spinnertitel,
das Codex-Wartemuster genau die zwei Blinkzustaende, das Codex-Ruhemuster genau
`abmess` (und den Shell-Titel `test-vm`; der Treffer zeigt zugleich, dass das Muster keinen Agenten identifiziert).
Bei Grok trifft das Wartemuster 24, das Arbeitsmuster 58 und das Ruhemuster genau die
vier gemessenen Ruhetitel, ohne Ueberschneidung.

Die Tabelle enthaelt Kandidaten fuer genau diesen Aufbau, keine freigegebenen
Standardprofile. Claude hat kein belastbares Titelmuster fuer einen der drei
Zustaende. Bei Codex identifizieren weder `node` noch der breite Ruhetitel den Agenten.
Bei Grok widerspricht der unten belegte Hintergrundbefehl einer uneingeschraenkten
Ruheerkennung. `idle_measured = true` bezeichnet hier die damalige Messzuordnung,
nicht eine heutige Freigabe dieses Profilfelds. M1.0 muss daraus erst versionierte,
konfigurierte und im Lebenszyklus validierte Adapter ableiten.

Anmerkungen zu den Eintraegen:

- **Claude Code, `commands`**: `claude`, nicht `node`. Das Binary unter
  `~/.local/share/claude/versions/2.1.261` laeuft direkt im Vordergrund.
- **Claude Code, `waiting`**: kein unterscheidbares Titelmuster gemessen. Beim ersten
  Freigabedialog um 12:58:50 sprang `window_bell_flag` auf 1 und blieb bis zum Ende
  auf 1. Damit ist nur die erste Bell-Flanke belegt; ueber weitere Bells sagt der
  dauerhafte Wert nichts aus. BEL begruendet einen separaten Aufmerksamkeitshinweis,
  keinen dauerhaften semantischen Wartezustand. Die damalige Regel 4 ist verworfen.
- **Claude Code, `working`**: die urspruengliche Empfehlung `^✳ .+$` ist
  zurueckgenommen; `working = None`. Das Zeichen ist `✳` (U+2733), nicht `✻` (U+273B).
  Das Muster trifft Arbeit, Warten und Ruhe nach einer Aufgabe. Ein Arbeitsmuster
  direkt auszuwerten wuerde daher falsches "arbeitet" erzeugen; `idle_measured = false`
  verhindert das nicht. Auch Aktivitaet macht dieses Muster nicht belastbar:
  Bildschirmausgabe kann bei Warten entstehen und waehrend Arbeit ausbleiben.
- **Claude Code, `idle`**: `^✳ Claude Code$` wurde nur vor der ersten Aufgabe
  beobachtet. Spaeter bleibt der Aufgabentitel stehen. Der Rohbefund bleibt erhalten,
  aber die Profil-Empfehlung ist `idle = None`; ohne gueltigen Hook oder einen neu
  validierten Adapter bleibt der semantische Zustand unbekannt.
- **Codex, `commands`**: `node`. `/usr/local/bin/codex` ist ein Node-Shim
  (`codex.js`), im Vordergrund steht `node`. Das heisst: `pane_current_command` ist bei
  Codex kein trennscharfes Merkmal, jedes andere Node-Programm im Pane traegt denselben
  Wert. Die Profilwahl faellt fuer Codex praktisch auf den Titel zurueck.
- **Codex, `idle`**: der Ruhetitel ist der **Basename** des Arbeitsverzeichnisses
  (`abmess` bei cwd `/tmp/abmess`), nicht der volle Pfad wie in V16a notiert. Das
  Muster ist als "weder Spinner noch eckige Klammer am Anfang" formuliert, damit es
  Warte- und Arbeitstitel sicher ausschliesst.
- **Grok, `idle`**: vor der ersten Aufgabe genau `grok`, danach `<Sitzungstitel> - grok`.
  Der Sitzungstitel wechselt, das Suffix ` - grok` und das Fehlen von Spinner und `⚠`
  sind das stabile Merkmal. Dreimal und mehr gleich gebaut, deshalb
  `idle_measured = true`.
- **Grok, `commands`**: `grok`, ein natives Binary unter `~/.grok/bin/grok`.

## tmux

| Frage | Ergebnis |
|---|---|
| Fensteroption im -F-Format | Ja. `set -w -t mess:tmuxw @x 1` gefolgt von `list-panes -a -F "#{session_name}:#{window_name} @x=#{@x}"` liefert `mess:tmuxw @x=1`; die uebrigen Fenster liefern `@x=` (leer). Die Fensteroption loest im Format also auf und ist pro Fenster unterscheidbar. |
| display -p '#{pid}' ohne Client | Ja. `display -p "#{pid}"` gab `763767` zurueck, ohne dass ein Client an der Session hing (`list-clients` war leer). |
| window_bell_flag nach BEL in nicht angehaengter Session | Ja. Frisches Fenster: `bell=0`, nach `printf "\a"` im Pane: `bell=1`. Das Flag klebt: im Claude-Fenster stand es ab 12:58:50 bis zum Ende der Messung (rund sechs Minuten, ueber Arbeits- und Ruhephasen hinweg) durchgehend auf 1. Im Versuch wurde es durch das Anhaengen eines Clients geloescht; andere Reset-Wege wurden nicht getestet. |
| BEL erreicht den Client (exec mit PTY) | Ja. Client per `ssh -tt … 'timeout 25 tmux -L abmess attach -t mess'`, Ausgabe in eine Datei. Im Bytestrom steht genau ein `0x07`, unmittelbar nach dem Echo der Befehlszeile, die das BEL ausgeloest hat. |
| OSC 9 erreicht den Client | Nein. Im selben Strom (2017 Byte, vollstaendig bis `[terminated]`) kommt die Folge `1b 5d 39` (ESC ] 9) kein einziges Mal vor, obwohl im Pane zweimal `printf '\033]9;…\007'` lief. Waeren sie durchgereicht worden, muessten drei `0x07` im Strom stehen (zwei OSC-Abschluesse und die Bell); es steht genau eines da. Die einzigen `1b 5d`-Folgen sind tmux' eigene OSC-10/11-Farbabfragen zu Beginn. tmux 3.4 reicht OSC 9 nicht durch. |
| set-titles Vorgabe | `set-titles off`. `set-titles-string` steht auf `"#S:#I:#W - \"#T\" #{session_alerts}"`. Weiter gemessen: `bell-action any`, `visual-bell off`. |

## Rohbefunde

Format der Zeilen: `Uhrzeit  pane_title  pane_current_command  alternate_on  window_bell_flag  window_activity`.

### Claude Code

Untaetig, vor der ersten Aufgabe (Titel `✳ Claude Code` von 12:57:25 bis 12:58:37):

```
12:57:50	✳ Claude Code	claude	1	0	1788605862
12:57:51	✳ Claude Code	claude	1	0	1788605870
12:57:52	✳ Claude Code	claude	1	0	1788605870
```

Wartet, Freigabedialog fuer `for i in $(seq 1 30); …` (12:58:50 bis 12:59:06;
`capture-pane` zeigte "Do you want to proceed?"). Bell springt auf 1, Aktivitaet steht:

```
12:58:51	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605929
12:58:52	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605929
12:58:53	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605929
```

Arbeitet, nach der Freigabe (12:59:07 bis 12:59:42; `capture-pane` zeigte den Spinner
"Roosting…"). Titel unveraendert, Aktivitaet wandert jede Sekunde:

```
12:59:10	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605950
12:59:11	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605951
12:59:12	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605952
```

Untaetig, nach der Aufgabe (12:59:43 bis 13:00:36; `capture-pane` zeigte
"Worked for 40s · done"). Titel identisch zu "arbeitet", Aktivitaet steht:

```
13:00:05	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605983
13:00:06	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605983
13:00:07	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788605983
```

Wartet, zweite bis vierte Wiederholung (13:00:51, 13:02:28, 13:03:25). Die dritte
Freigabe wurde abgelehnt, die anderen erteilt:

```
13:00:55	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606050
13:00:56	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606050
13:02:30	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606147
13:02:31	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606147
13:03:26	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606204
13:03:27	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606204
```

Arbeitet, zweite und vierte Wiederholung (die dritte, 13:02:50, war die kurze Antwort
auf die abgelehnte Freigabe):

```
13:01:15	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606075
13:01:16	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606076
13:03:40	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606220
13:03:41	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606221
13:03:42	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606222
```

Untaetig, dritte und vierte Wiederholung:

```
13:02:10	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606102
13:02:11	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606102
13:04:20	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606240
13:04:21	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606240
13:04:22	✳ Shell-Befehl Schleife 1 bis 30	claude	1	1	1788606240
```

Nach `/exit` (13:04:48). Claude Code raeumt den Titel auf, er wird leer, nicht schal.
`alternate_on` faellt auf 0, `pane_current_command` auf `bash`, das Bell-Flag bleibt 1:

```
13:04:50		bash	0	1	1788606290
13:04:51		bash	0	1	1788606290
13:04:52		bash	0	1	1788606290
```

Ueber die ganze Claude-Messung (476 Zeilen) gab es genau vier verschiedene Titel:
`test-vm` (Shell vor dem Start), `✳ Claude Code` (73 Zeilen), `✳ Shell-Befehl Schleife 1
bis 30` (370 Zeilen) und den leeren Titel (22 Zeilen, nach `/exit`). Auffaellig: Claude
Code aktualisierte den Titel nur beim ersten Auftrag; die spaeteren Auftraege liefen
unter dem alten Titel weiter. Der Titel ist also nicht einmal ein verlaesslicher
Aufgabenname.

Claude Code stand beim Start auf `⏵⏵ auto mode on`, es haette also nie nach einer
Freigabe gefragt. Fuer die Messung wurde per `shift+tab` (send-keys `BTab`) auf
`⏸ manual mode on` geschaltet. Das ist Sitzungszustand, keine Konfigurationsaenderung.

### Codex

Untaetig (13:06:16 bis 13:06:44, 13:07:46 bis 13:08:30, 13:09:32 bis 13:10:14,
13:11:07 bis 13:11:49):

```
13:06:20	abmess	node	0	0	1788606377
13:08:10	abmess	node	0	0	1788606465
13:09:56	abmess	node	0	0	1788606571
13:11:30	abmess	node	0	0	1788606666
```

Arbeitet, Braille-Spinner vor dem Verzeichnisnamen:

```
13:06:46	⠋ abmess	node	0	0	1788606406
13:07:14	⠹ abmess	node	0	0	1788606434
13:08:32	⠧ abmess	node	0	0	1788606512
13:09:09	⠏ abmess	node	0	0	1788606549
13:10:18	⠼ abmess	node	0	0	1788606618
13:10:55	⠦ abmess	node	0	0	1788606655
```

Wartet, Freigabedialog ("Would you like to run the following command?"). Der Kopf
blinkt zwischen `[ ! ]` und `[ . ]`:

```
13:06:55	[ ! ] Action Required | abmess	node	0	0	1788606414
13:06:56	[ . ] Action Required | abmess	node	0	0	1788606415
13:06:57	[ ! ] Action Required | abmess	node	0	0	1788606416
13:08:40	[ ! ] Action Required | abmess	node	0	0	1788606520
13:08:41	[ . ] Action Required | abmess	node	0	0	1788606521
13:10:26	[ . ] Action Required | abmess	node	0	0	1788606625
13:10:27	[ ! ] Action Required | abmess	node	0	0	1788606626
```

Nach zweimal `Ctrl+C` (13:11:49). Titel leer, `bash` im Vordergrund:

```
13:11:54		bash	0	0	1788606711
13:11:55		bash	0	0	1788606711
13:11:56		bash	0	0	1788606711
```

Ueber die ganze Codex-Messung (393 Zeilen) war `window_bell_flag` durchgehend 0 und
`alternate_on` durchgehend 0. Codex laeutete in diesem Aufbau also nicht und benutzte keinen
Alternate Screen. Beim ersten Start in `/tmp/abmess` fragte Codex nach dem Vertrauen
fuer das Verzeichnis; das wurde bestaetigt (siehe "Spuren auf der VM").

### Grok

Untaetig. Vor der ersten Aufgabe genau `grok`, danach `<Sitzungstitel> - grok`:

```
13:12:50	grok	grok	1	0	1788606769
13:14:30	Bash loop count 1-30 with 1s sleep - grok	grok	1	0	1788606850
13:16:30	Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788606989
13:17:55	Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788607065
13:19:10	Shell-Probes: Dateien anlegen, löschen, … - grok	grok	1	0	1788607148
```

Arbeitet, Spinner vorn, Schrittname in der Mitte:

```
13:13:35	⠋ - Count 1 to 30 with 1s delay… - Bash loop count 1-30 with 1s sleep - grok	grok	1	0	1788606815
13:16:26	⠋ - Waiting for response… - Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788606986
13:17:30	⠋ - Create, delete probe file, count 1-20… - Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788607050
13:18:42	⠙ - Create, delete probe2, count 1-25… - Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788607122
```

Wartet, `⚠ Action Required - ` als Prefix vor dem Arbeitstitel:

```
13:15:53	⚠ Action Required - ⠧ - Delete probe file and verify gone… - Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788606953
13:15:54	⚠ Action Required - ⠹ - Delete probe file and verify gone… - Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788606954
13:17:00	⚠ Action Required - ⠙ - Create, delete probe file, count 1-20… - Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788607020
13:18:15	⚠ Action Required - ⠦ - Create, delete probe2, count 1-25… - Shell-Schleife und Probe-Datei in /tmp - grok	grok	1	0	1788607095
```

Nach `/exit` (13:19:28). Hier bleibt der Titel schal stehen: `grok` als Titel bei
`bash` im Vordergrund. Das belegt, dass ein Titel den Agenten ueberleben kann:

```
13:19:34	grok	bash	0	0	1788607170
13:19:35	grok	bash	0	0	1788607170
13:19:36	grok	bash	0	0	1788607170
```

Einschraenkung des Arbeitsmusters: laeuft ein Shell-Befehl laenger als Groks eigene
Zeitschranke, schiebt Grok ihn in den Hintergrund und legt den Spinner ab. Der Titel
sieht dann aus wie im Ruhezustand, obwohl der Befehl noch laeuft. Beim ersten Auftrag
(Schleife 1 bis 30) trat das von 13:13:55 bis 13:14:07 auf, also dreizehn Sekunden
falsches "untaetig":

```
13:13:54	⠋ - Responding - Bash loop count 1-30 with 1s sleep - grok	grok	1	0	1788606834
13:13:55	Bash loop count 1-30 with 1s sleep - grok	grok	1	0	1788606835
13:14:07	Bash loop count 1-30 with 1s sleep - grok	grok	1	0	1788606847
13:14:08	⠙ - Waiting for response… - Bash loop count 1-30 with 1s sleep - grok	grok	1	0	1788606848
```

`window_activity` wandert dabei weiter (1788606835 auf 1788606847), weil die
Laufzeitanzeige im Pane jede Sekunde neu gezeichnet wird. Das Titelmuster allein
unterscheidet hier Ruhe und Hintergrundarbeit nicht. Die urspruengliche Empfehlung,
dies mit Aktivitaet zu korrigieren und als harmlose Grenze ins README aufzunehmen,
ist zurueckgenommen: Ausgabe ist kein allgemeiner Arbeitsnachweis. Der Adapter muss
seine Bedeutung von "untaetig" auch fuer Hintergrundarbeit festlegen und validieren;
bis dahin ist dieser Ruhetitel keine freigegebene Statusregel.
Ueber die ganze Grok-Messung (451 Zeilen) war `window_bell_flag` durchgehend 0.
`alternate_on` war 1, solange Grok lief, und 0 in der Shell.

Grok startete im Modus `always-approve` und fragte deshalb nie. Der Modus wurde per
`shift+tab` auf die Vorgabe zurueckgestellt (Reihenfolge des Umschaltens:
Vorgabe, `plan`, `auto`, `always-approve`). Auch in der Vorgabe fuehrt Grok
Schreibzugriffe ausserhalb des Arbeitsverzeichnisses ohne Rueckfrage aus
(`touch /tmp/abmess-probe.txt` lief durch). Eine Rueckfrage erzwang erst ein
loeschender Befehl (`rm`). Die Wartemessung beruht deshalb auf `rm`-Befehlen.

## Bewertung fuer 4.4, korrigiert am 2026-09-08

- **Claude Code:** der Titel trennt die drei Zustaende nicht. Die damalige
  Arbeitsprofil-Empfehlung war falsch. Ein Hook wurde in diesem Lauf nicht getestet;
  erst ein Adapter mit gepruefter Version, Quelle, Aktualitaet und Agent-Instanz kann
  einen Status liefern. Ein nacktes altes `@agent_status`-Feld reicht dafuer nicht.
- **BEL:** das Flag zeigte hier nur die erste neue Bell. Die verworfene Regel 4
  haette nach `bell_seen_at = 1788605929` beim zweiten Warten um 13:00:51 die
  Aktivitaet `1788606050` als Fortschritt gedeutet und die Bell als verbraucht
  behandelt. Zusammen mit `^✳ .+$` haette sie diesen und die spaeteren Wartezustaende
  falsch als "arbeitet" gemeldet. Weder ein erneutes Verfallen des Flags noch
  Stillstand der Ausgabe loest dieses semantische Problem. BEL ist Aufmerksamkeit;
  ein Status braucht ein eigenes belastbares Signal.
- **Codex und Grok:** ihre Titel waren in den aufgezeichneten Vordergrundphasen
  unterscheidbar. "Vollstaendig lesbar" war eine zu starke Schlussfolgerung: Grok
  zeigte bereits bei laufender Hintergrundarbeit einen Ruhetitel, und die Messung
  prueft weder andere Versionen/Konfigurationen noch Ausfall- und Neustartfaelle.
- **Agent-Erkennung:** `node` identifiziert Codex nicht. Auch Prozessnamen und
  Titelsuffixe allein belegen keine Herstelleridentitaet oder Agent-Generation.
  Ein Profil muss an eine erkannte, getestete Instanz gebunden sein.
- **Veraltete Titel:** Grok liess nach dem Ende `grok` bei `bash` stehen. Titel und
  Hook-Metadaten muessen bei einem Wechsel der Instanz verworfen werden. Ein
  Prozessname `bash` allein beweist in allgemeinen Wrapper-Szenarien keine leere Shell.

Die neue Abnahme umfasst wiederholtes Warten ohne angehaengten Client, lange und
Hintergrundaufgaben, Abbruch, Absturz, fehlende oder verspaetete Hooks sowie
Pane-/Server-Neuerzeugung. Sie trennt Signalverzoegerung vom Polling-Budget. Details,
Primaerquellen und das M1.0-Tor stehen in der [korrigierten Spec](../specs/2026-09-05-mvp-und-statuspunkt-design.md).
Diese Korrektur fuegt keine nachtraeglichen Messergebnisse hinzu.
## Spuren auf der VM

Der Messaufbau wurde nach Schritt 6 des Auftrags vollstaendig entfernt: `tmux -L abmess
kill-server`, `rm -rf /tmp/abmess`, dazu die verwaiste Socketdatei
`/tmp/tmux-1000/abmess`. Gegenprobe: `tmux -L abmess ls` scheitert
("error connecting to /tmp/tmux-1000/abmess"), `ls /tmp/abmess` scheitert
("No such file or directory"), kein Sampler-Prozess laeuft mehr, `/tmp/tmux-1000/` ist
leer. Die Sockets `agentbridge` und `default` wurden nicht angefasst; es gab beim Start
der Messung ohnehin keine.

Was die Agents selbst geschrieben haben und bewusst nicht angetastet wurde:

- `~/.codex/config.toml` hat einen neuen Eintrag `[projects."/tmp/abmess"]` mit
  `trust_level = "trusted"`. Er stammt aus der Vertrauensabfrage beim ersten
  Codex-Start und war vom Auftrag ausdruecklich erlaubt. Er zeigt jetzt auf ein
  geloeschtes Verzeichnis.
- `~/.claude.json` hat einen Projekteintrag fuer `/tmp/abmess`.
- `~/.grok/sessions/%2Ftmp%2Fabmess/` enthaelt das Sitzungsprotokoll des Grok-Laufs.

Diese drei sind normale Agentenzustaende, kein Teil des Messaufbaus. Sie zu bearbeiten
waere eine Konfigurationsaenderung gewesen, deshalb blieben sie stehen.

## Was nicht gemessen wurde

- tmux 3.3a und 3.0. 192.0.2.10 ist nach Spec 5 nicht erreichbar; die Messung lief nur
  auf tmux 3.4.
- Ein getrenntes Ruhetitelmuster von Claude Code wurde nicht gefunden: nach der
  ersten Aufgabe traegt der Pane dauerhaft den Aufgabentitel. `^✳ Claude Code$` wurde
  nur einmal beobachtet, vor der ersten Aufgabe, daher `idle_measured = false`.
- Ein Wartezustand von Grok innerhalb des Arbeitsverzeichnisses. Grok fragt dort auch
  in der Vorgabe nicht; die Rueckfrage kam erst bei `rm`. Das Titelmuster ist davon
  unberuehrt, der Ausloeser aber ein anderer als bei den beiden anderen Agents.
- `set-titles on`. Nur die Vorgabe (`off`) wurde abgelesen; die Option wurde nicht
  umgestellt, weil das eine Konfigurationsaenderung auf dem Testsocket gewesen waere
  und `pane_title` davon nicht abhaengt (`set-titles` steuert den Titel, den tmux an
  sein eigenes Aussenterminal schickt).

- Hooks aller drei Agents, ihre Laufzeitversionen und Ende-/Abbruchsemantik; die
  aktuelle Dokumentation ersetzt diese Messung nicht. Insbesondere wurden die
  Herstelleridentitaet von Grok und aktuelle Codex-Hooks fuer 0.93.0 nicht verifiziert.
- Allgemeine Titelfreiheit, veraltete Metadaten nach Instanzwechsel, Control-Ausfall,
  parallele Hook-Schreiber, Subagents und die tmux-3.0-Kompatibilitaet des Protokolls.