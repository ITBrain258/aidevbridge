# Statusanzeige und Knopfleiste der Hosts

**Datum:** 14.11.2026
**Stand:** gebaut, noch nicht veröffentlicht. Geprüft im Headless-Browser gegen Beispieldaten, nicht am Fenster (§8).
**Baut auf:** [UI v2](2026-09-05-ui-v2-design.md), [Farbwahl](2026-09-14-farbwahl-design.md), [Dynamisches Raster](2026-10-19-dynamisches-raster-design.md) §7 (Wartet-Spur), [Seitenleiste und Grundtöne](2026-11-14-seitenleiste-und-grundtoene-design.md).

## 1. Entscheidung

Zwei Wünsche des Maintainers vom 14.11.:

1. Die Knöpfe eines Hosts (Trennen, neue Session, neu laden, mehr) sollen an jedem Host stehen. Bisher zeigte sie nur der aktive Host. Waren mehrere Hosts aufgeklappt, musste man erst eine Zeile des anderen Hosts anklicken oder ihn zu- und wieder aufklappen, um dort etwas zu tun.
2. Die Statusanzeige soll ruhiger und professioneller aussehen und sich ohne Anleitung erschließen.

Der Leitsatz für beides: **Laut ist nur, was den Nutzer braucht.** Der Normalfall (verbunden, Agent arbeitet, Agent ruht) steht ruhig da; Farbe auf der Fläche bekommt, was eine Handlung verlangt (Agent wartet, Verbindung gescheitert, Agent beendet).

Die Wörter bleiben: Waiting, Busy, Idle, Ended, Unknown, Online, Offline, Connecting, Failed. README und Anleitungen lehren sie, und der Text trägt die Bedeutung. Auch die Formen der Zustände bleiben; es ändern sich Farben, Flächen und Anordnung.

Bewegung bleibt, wie UI v2 §14 sie festlegt: Die einzige Animation ist der Bogen von „Connecting“. Ein pulsierendes „Busy“ ist nicht gebaut.

## 2. Knopfleiste an jedem Host

Jede Hostkarte zeigt ihre Leiste, aufgeklappt wie zugeklappt: der Umschalter (Connect oder Disconnect), „New session“, „Reload sessions“ und `⋯`.

- Keine Regel in `styles.css` verbirgt `.host-actions` mehr. Ein Test hält das fest.
- Gerahmt ist nur der Umschalter mit seinem Wort. Die Symbolknöpfe und `⋯` stehen ohne Rahmen daneben und bekommen ihre Fläche unter dem Zeiger. Vier gerahmte Kästen je Karte machten die Liste unruhig.
- **Disconnect** an einem verbundenen Host trägt Rand und Schrift in der Farbe von „Online“ (`host-action-btn--connected`, `--ab-ok`): Leuchtet der Knopf, steht die Verbindung. Er leuchtet in genau dem Zustand, in dem die Pille den grünen Punkt zeigt, also noch nicht während des Verbindens, obwohl er dann schon „Disconnect“ heißt. **Connect** ist ein ruhiger Knopf. Unter dem Zeiger bekommt der leuchtende Knopf die Fläche aller Leistenknöpfe und bleibt grün beschriftet; gefüllt grün läse sich ein Knopf, der Terminals schließt, wie „weiter“. Die Farbe ist ein zweiter Hinweis: Form und Wort des Zustands trägt weiter die Pille darüber.

  Der erste Entwurf hob umgekehrt „Connect“ im Akzent hervor. Der Maintainer hat das am Bild verworfen (14.11.); der Akzent trägt ohnehin keinen Zustand (Farbwahl §2 Regel 2).
- Tastatur unverändert: Es gibt weiter genau einen Tabstopp für die Leisten, an der des aktiven Hosts (`activeHostId()`). Ein Klick oder Fokus in die Leiste eines anderen Hosts macht diesen aktiv; jede Aktion trägt ihren Host ausdrücklich mit.

Die Markierung des aktiven Hosts (`sb-host-block--active`), das Halten beim Druck (`--held`) und `sb-list--pressing` tragen keine Darstellung mehr. Sie stammen aus der Zeit, als das Ein- und Ausblenden der Leiste die Zeilen verschob. `frozenHostId` bleibt das Kennzeichen „ein Druck läuft“, an dem das zurückgehaltene Neuzeichnen hängt; der Abbau des Rests steht in `docs/stand.md`.

## 3. Statusanzeige

### 3.1 Farben

| Farbe | Bedeutung | Token |
| --- | --- | --- |
| Grün | Verbindung steht („Online“) | `--ab-ok` |
| Blau | Agent arbeitet („Busy“) | `--ab-busy` (neu, `#93C5FD`) |
| Bernstein | Agent wartet auf den Nutzer („Waiting“) | `--ab-warn` |
| Rot | gescheitert, beendet („Failed“, „Ended“) | `--ab-danger` |
| Grau | ruht, getrennt, unbekannt, veraltet | `--ab-text-secondary`, `--ab-text-muted` |

Vorher teilten sich „Online“ und „Busy“ das Grün, und „Idle“, der ruhigste Zustand, trug ein kräftiges Blau. `--ab-idle`, `--ab-idle-bg` und `--ab-ok-bg` entfallen.

### 3.2 Pillen

Getönt in ihrer Farbe sind nur „Waiting“, „Ended“ und „Failed“. „Connecting“ behält seine neutrale helle Fläche und den laufenden Bogen (Farbwahl §2 Regel 2). Alle anderen Pillen stehen auf dem neutralen Schleier `--ab-chip-bg` (`rgba(255, 255, 255, 0.07)`) mit dem Wort in `--ab-text-secondary`:

| Zustand | Zeichen | Wort |
| --- | --- | --- |
| Online | grüner Punkt | sekundär, halbfett |
| Offline | grauer Ring | sekundär, normal |
| Busy | drei blaue Punkte | sekundär, halbfett |
| Idle | graue hohle Raute | sekundär, normal |
| Unknown | gestrichelter Kreis | sekundär, halbfett |
| veraltet („As of 12:31“) | letztes Zeichen, abgeblasst | sekundär, halbfett |

Der Schleier ist durchscheinend, damit die Pille auf jeder Fläche sichtbar bleibt: Karte, Zeile unter dem Zeiger, gewählte Zeile, Kachelkopf. Ein gedämpftes Wort (`--ab-text-muted`) hält auf dem Schleier keine 4,5:1 (gemessen 3,4 bis 4,8 je Fläche und Grundton); „Idle“ und „Offline“ treten deshalb über das graue Zeichen und das normale Schriftgewicht zurück, nicht über die Schriftfarbe.

Die Kontrastprüfung (`styles.test.ts`) rechnet für alle 42 Farbkombinationen: das Wort auf dem Schleier über Karte, Panel, Zeile unter dem Zeiger und fokussiertem Kachelkopf (4,5:1) und die Zeichen dort als Grafik (3:1).

### 3.3 Session ohne Kachel

Eine nicht geöffnete Session zeigte links den Ring von „Offline“, obwohl sie auf einem verbundenen Host läuft. Sie trägt jetzt einen kleinen grauen Punkt (`ind-closed`), der den Platz der Kachelnummer hält. Er ist als Rahmen gezeichnet, nicht als Fläche, und bleibt so im Windows-Kontrastdesign sichtbar. Das Wort „Not open“ steht wie bisher in der Zeile, sichtbar, wenn die Session keinen Agentenstatus hat.

### 3.4 Zeile der fokussierten Kachel

Diese Zeile zeigt „Close terminal“ und „End session…“ dauernd und verlor dafür ihren Status, genau dort, wo man arbeitet. Von der Pille bleibt jetzt das Zeichen, links neben den Knöpfen; das Wort ist nur für das Auge ausgeblendet. Unter dem Zeiger gehört der Platz weiter ganz den Knöpfen. In der kompakten Ansicht stehen die Knöpfe hinter der Pille, dort bleibt das Wort.

## 4. Wartet-Spur als Karte

Die Spur stand als lose Zeilen über den Hosts. Sie ist jetzt eine Karte wie die Hostkarten:

- **Kopf**, in der Farbe von „Waiting“ getönt: die Raute, der Titel „Waiting for you“, die Zahl der Wartenden als Marke und das Kürzel `Ctrl+Shift+A` (Tooltip „Jump to the next waiting session“). „for you“ sagt, wer auf wen wartet.
- **Zeilen** wie bisher (Kürzel des Hosts, Name, Kachelnummer, Wartezeit, darunter der Grund), ohne eigene Raute: Jede Zeile der Spur wartet, die Raute steht einmal im Kopf.
- Bei der Standardbreite der Seitenleiste (240 px) passen Titel, Zahl und Kürzel in den Kopf. Darunter fällt das Kürzel weg, nicht der Titel: Es bricht in eine zweite Zeile um, die der Kopf mit seiner festen Höhe abschneidet. In der kompakten Ansicht ist es wie bisher ausgeblendet.

Reihenfolge, Festhalten unter dem Zeiger, „+n more“ und die Fokusbezeichner sind unverändert.

## 5. Was diese Spec ersetzt

- **UI v2 §7.3** (Hostaktionen nur am aktiven Host): ersetzt durch §2.
- **UI v2 §7.8 und §17 Punkt 2** (Dichte: vier Hosts, zwanzig Sessions, eine sichtbare Leiste, unter 760 px): Das Tor ist mit dieser Spec bewusst aufgegeben. Jede Leiste kostet 38 px (34 px Höhe, 4 px Abstand); der Bezugsfall mit vier Leisten misst rund 850 px statt 736, dazu kommt die Karte der Wartet-Spur, wenn jemand wartet. Die Liste rollt wie bisher, und zugeklappte Hosts sind um ihre Leiste höher als vorher. Kein Test hält das alte Tor fest.
- **UI v2, Nachtrag M1.2 vom 14.09.** (Agentenstatus als Pille): Damals fiel am Bild die Wahl auf „jeder Zustand als gleich starke Pille“. Das ist zurückgenommen: Getönt sind nur noch „Waiting“ und „Ended“ (§3.2). Formen, Wörter, Maße der Pille und die Tooltips aus der Tabelle des Nachtrags gelten weiter; die Spalte „Fläche / Text“ ersetzt §3.2. Der Blauton `#93C5FD` wandert von „Idle“ zu „Busy“; im Thema Blau liegt damit „Busy“ nah am Akzent, wie vorher „Idle“. Der Satz „in der ausgewählten Zeile weicht das Meta-Feld den Sessionaktionen“ ist durch §3.4 ersetzt.
- **Farbwahl §2 Regel 1** (feste Zustandsfarben): gilt weiter; in der Liste steht `--ab-busy` an der Stelle von `--ab-idle`, und die Tönungen `--ab-ok-bg` und `--ab-idle-bg` entfallen.
- **Dynamisches Raster §7** (Aussehen der Wartet-Spur): ersetzt durch §4. Verhalten unverändert.
- **UX-Überarbeitung §7.8** (Waiting-Pille der zugeklappten Hostzeile): unverändert.

Unberührt bleiben die Drei-Kanal-Regel (Form, Farbe und Wort; nie Farbe allein), UI v2 §14 (Bewegung) und die Kontrastregel §5.4.

## 6. Tests

- `styles.test.ts`: keine Regel verbirgt `.host-actions`; neue Gruppe „Statusanzeige“ (Token, Pillen, Hostpillen, `ind-closed`, Zeile der fokussierten Kachel samt kompakter Ausnahme, Karte und Kopf der Spur, Knopfleiste); Kontrastpaare für Schleier, Zeichen und die Zahl der Spur über alle 42 Kombinationen.
- `sidebar.test.ts`: ein Knopf in der Leiste eines anderen Hosts macht diesen aktiv und handelt an ihm; der Umschalter leuchtet nur am verbundenen Host, nicht während des Verbindens; „Edit“ und „Remove“ im Menü eines nicht aktiven Hosts treffen diesen Host; Kopf der Spur (Reihenfolge, Titel, Zahl, Kürzel); Zeile der Spur ohne Raute; `ind-closed` statt `ind-off` an der nicht geöffneten Session.

## 7. Nicht in diesem Zuschnitt

- **Andere Wörter.** „Needs input“ statt „Waiting“ oder „Working“ statt „Busy“ wären noch eindeutiger, träfen aber README, Anleitungen und jede Stelle, die den Status nennt. Eine eigene Entscheidung.
- **Bewegung an „Busy“** (pulsierende Punkte): widerspricht UI v2 §14, das die Regel nicht verhandelbar nennt. Wenn, dann als Änderung jener Spec.
- **Neue Statusflächen:** ein Streifen an wartenden Kacheln, eine Übersichtszeile („2 waiting · 3 busy“), Filter nach Status.
- **Abbau der Druck-Markierung** in `sidebar.ts` (§2).
- **README-Bilder und Store-Bilder:** zeigen weiter den Stand von 0.3.4 und werden mit dem nächsten Release neu gerendert.

## 8. Abnahme am Fenster

Am 14.11.2026 im Headless-Browser geprüft, gegen die Beispieldaten der README-Bilder und gegen eine Probeszene mit allen Zuständen (Hosts: Online, Connecting, Failed, Offline; Sessions: Waiting, Busy, Idle, Ended, Unknown, veraltet, ohne Status, mit und ohne Kachel): Seitenleiste bei 280, 240 und 208 px, Kachelköpfe, Symbolleiste, Zeiger auf einer Zeile, „+3 more“ bei acht Wartenden, Telefonansicht, nachgestellter Kontrastmodus, drei Farbkombinationen (Türkis auf Graphite, Rot auf Slate, Blau auf Midnight).

Mit echten Mausereignissen (über das DevTools-Protokoll, nicht `click()`) bei fokussierter Kachel eines anderen Hosts: „Reload sessions“, „New session“, `⋯` mit „Edit…“ und „Disconnect“ an einem nicht aktiven Host sowie „Connect“ an einem zugeklappten Host wirken am angeklickten Host; der andere bleibt verbunden und behält seine Kacheln. Trifft während eines gehaltenen Drucks ein Statuswechsel ein, wartet das Neuzeichnen, und der Klick kommt an.

Offen von Hand:

1. Mehrere aufgeklappte Hosts: an jedem trennen, eine Session anlegen, neu laden, ohne vorher eine Zeile anzuklicken; mit Maus und mit Tastatur (Tab in die Leiste, Pfeiltasten).
2. Status bei laufenden Agenten: Der Wechsel zwischen Busy, Waiting und Idle ist in Liste und Kachelkopf auf einen Blick zu erkennen, auch in schmalen Kacheln ohne Wort.
3. Wartet-Spur: Kopf bei 208, 240 und 320 px Breite; „+n more“ mit mehr als fünf Wartenden.
4. Skalierung 100, 125, 150 Prozent: Zeichen in den Pillen scharf, die Zahl im Kopf der Spur mittig.
5. Windows-Kontrastdesign: Pillen und Kopf der Spur lesbar ohne ihre Flächen. Im nachgestellten Kontrastmodus des Browsers bleiben alle Wörter stehen, und die Symbolknöpfe bekommen dort wieder einen Rahmen. Gefüllte Zeichen (Punkt, Raute, Quadrat) fallen wie bisher weg; in der Zeile der fokussierten Kachel, die nur das Zeichen zeigt, bleiben deshalb allein „Idle“ und „Unknown“ sichtbar.
6. Bildschirmleser: Zeile der fokussierten Kachel nennt ihren Status weiter; Kopf der Spur.
