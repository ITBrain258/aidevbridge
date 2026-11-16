# Messung: Startausgabe der Shell und Frist der Sessionliste an einem echten Host

Stand 2026-11-16. Gemessen ist der Release-Branch für 0.3.6 am Kopf `01cf831`
(der Code von `30db55e` mit den Versionszeilen), von Windows aus gegen einen
Testhost mit Debian 12, bash 5.2, OpenSSH 9.2 und tmux 3.3a. Das Konto dort
war ein Wegwerfkonto ohne weitere Rechte, sein tmux-Socket hieß
`abmess_20261116`.

Das Werkzeug `measure_shell_and_walk.rs` ruft die Befehlskerne der App, also
dieselben Funktionen, die hinter den Tauri-Befehlen stehen, und druckt, was
sie liefern. Es prüft nichts. Für die Messung lag es unter `src-tauri/tests/`.
Rohdaten und Werkzeuge liegen unter
`fixtures/shell-ausgabe-und-listenfrist-2026-11-16/`. Dort stehen `<HOME>`
und `<UID>` für Home-Ordner und Benutzernummer des Kontos; Kontoname und
Adresse kommen in den Ausgaben nicht vor (`<account>@<host>` ist Text des
Skripts). Die Zeilen von cargo sind entfernt. Die drei Skripte sind für die
Ablage verallgemeinert: Schlüssel und `known_hosts`-Datei kommen aus
Variablen statt aus festen Dateinamen. In dieser Form liefen `shellvar.sh`
und `measure.sh` für die fünfte Variante; `run-variants.sh` ist so nur auf
seine Syntax geprüft, die fünfte Variante lief mit denselben Schritten von
Hand.

An den tmux-Sockets und Sessions des Kontos, unter dem auf dem Host sonst
gearbeitet wird, änderte sich nichts (vorher und nachher verglichen); weitere
Konten sind nicht verglichen. Am Ende hatte das Wegwerfkonto seine Startdatei
im Auslieferungszustand, keinen tmux-Server und keinen Socket.

## 1. Startausgabe der Shell

Fünf Zustände der `~/.bashrc` des Kontos. Die Zeile steht jeweils ganz oben,
vor der Prüfung auf eine interaktive Shell (`precondition-*.txt`):

| Variante | erste Zeile | `ssh <konto>@<host> true` druckt | mit Terminal (`ssh -tt … true`) |
|---|---|---|---|
| stock | wie ausgeliefert | nichts | nichts |
| stdout | `echo hello` | `hello` auf der Standardausgabe | `hello` |
| stderr | `echo warn >&2` | `warn` auf der Fehlerausgabe | `warn` |
| tty | `[ -t 1 ] && echo hello` | nichts | `hello` |
| interactive | `case $- in *i*) echo hello;; esac` | nichts | nichts; `bash -i -c true` druckt `hello` |

Je Variante ein Durchgang durch das, was ein Nutzer an einem Host tut
(`variant-*.txt`, danach `after-*.txt`). Die Variante interactive hat keine
eigene Spalte: Ihre Ausgabe gleicht der von stock bis auf Zeiten,
Prozessnummern und das „hello“ der Shell in der Pane. Ihr gebundenes Öffnen
brauchte 404 ms.

| Schritt | stock | stdout | stderr | tty |
|---|---|---|---|---|
| Verbinden | gelingt | gelingt | gelingt | gelingt |
| Host-Prüfung | bereit | blockiert, nennt „hello“ | bereit | bereit |
| Liste, Host ohne Session | leer | Fehler `shell_output`, nennt „hello“ | Fehler `shell_output` am eigenen Socket, nennt „warn“ | leer |
| Statusabfrage, Host ohne Session | eigener Socket: Fehler `other` | unvollständig, kein Fehler | unvollständig, kein Fehler | wie stock |
| Ordnerliste des Home-Ordners | gelingt | Fehler, Text „failed“ | gelingt | gelingt |
| Neue Session | gelingt | `outcome_unknown`, die Session entsteht | `outcome_unknown`, die Session entsteht | gelingt |
| Liste danach | Session gebunden | Fehler `shell_output` | Session nach Namen, `unverified: shell_output`, der Grund nennt „warn“; Standard-Socket nicht gelesen | Session gebunden |
| Öffnen | gebunden, gelingt (391 ms) | über den Namen, gelingt | über den Namen, gelingt | gebunden: Fehler nach 86 ms, „attach wrapper was not confirmed“ |
| Beenden nach Namen | gelingt | gelingt | gelingt | gelingt |
| Letzte Session beenden | gelingt | unbestätigter Ausgang, die Session endet | unbestätigter Ausgang, die Session endet | gelingt |
| Liste, wieder ohne Session | leer | Fehler `shell_output` | Fehler `shell_output` am eigenen Socket | leer |

1. **Die Erkennung arbeitet wie beschrieben.** Text auf der Standardausgabe
   hält die Host-Prüfung an und lässt keine Liste zu; beide nennen die erste
   Zeile („it starts with "hello"“). Meldungen nur auf der Fehlerausgabe
   lassen die Host-Prüfung durch und die Liste nach Namen, mit der Shell als
   Grund an jeder Zeile, und der Standard-Socket wird nicht gelesen. Die
   tmux-Version liest die Host-Prüfung in allen fünf Varianten richtig
   (`3.3a`).
2. **„New session“ meldet in beiden Fällen einen unbestätigten Ausgang, und
   die Session entsteht trotzdem.** Mit Text auf der Standardausgabe lautet
   der Rohtext „incomplete tmux binding response: InvalidFrame“, mit
   Meldungen auf der Fehlerausgabe „tmux binding query failed (exit 0)“. Im
   ersten Fall zeigt die Liste die neue Session danach nicht, weil sie ganz
   ausbleibt; dass es sie gibt, zeigen das Öffnen über den Namen und
   `after-stdout.txt`.
3. **Die letzte Session zu beenden meldet in beiden Fällen einen
   unbestätigten Ausgang, und sie endet trotzdem.** Die Prüfung danach liest
   „no server running“ nicht als leeren Host.
4. **Ein Host ohne Session zeigt mit Meldungen auf der Fehlerausgabe den
   Hinweis zur Shell statt einer leeren Liste.**
5. **Mit Text auf der Standardausgabe scheitert auch die Ordnerliste**, mit
   dem bloßen Wort „failed“.
6. **Öffnen über den Namen gelingt mit beiden Ausgaben.** Der Text der
   Shell kommt danach im Terminal vor. Woher, zeigt der Lauf nicht: Das
   Werkzeug sucht nur nach dem Wort, und die Shell in der Pane schreibt
   dieselbe Zeile (in der Variante interactive kommt „hello“ nur von ihr).
7. **Schreibt die Shell nur mit Terminal, bemerken Host-Prüfung und Liste
   nichts, und das Öffnen scheitert sofort** mit „attach wrapper was not
   confirmed“. Die Meldung nennt die Shell nicht.
8. **Schreibt die Shell nur, wenn sie interaktiv ist (`$-` enthält `i`),
   stört nichts**, auch das Öffnen nicht. Das ist der Rat, den die Meldungen
   der App geben („print it only in interactive shells“); `[ -t 1 ]` aus
   Punkt 7 erfüllt ihn nicht.
9. **Ohne Ausgabe der Shell** liefert die Statusabfrage für den eigenen
   Socket ohne tmux-Server den Fehler „tmux inventory is not a complete
   snapshot“, während die Liste denselben Zustand als leer liest.

## 2. Sessionliste über eine langsame Verbindung

`delay-proxy.mjs` lief auf dem Prüfrechner, lauschte nur auf 127.0.0.1 und
verzögerte jede Richtung der Verbindung um eine feste Zeit. Am Host änderte
er nichts. Die Sessions legte das Werkzeug ohne Verzögerung an. Gelistet ist
nur der eigene Socket. Die Läufe in ihrer Reihenfolge (`one-command-*.txt`,
`prepare*.txt`, `walk-*.txt`):

| Lauf | Verzögerung je Richtung | Sessions | Ergebnis |
|---|---|---|---|
| ein Befehl, fünfmal | keine | – | 19 bis 22 ms, der erste 178 ms |
| ein Befehl, fünfmal | 175 ms | – | 765 bis 771 ms |
| Liste | keine | 20 | 1,8 s, alle 20 gebunden |
| Liste | 175 ms | 20 | 36,2 s, alle 20 gebunden |
| Liste, Statusabfrage alle 2 s nebenher | 175 ms | 20 | 36,2 s, alle 20 gebunden; sechs Abfragen, jede nach rund 3,3 s beantwortet |
| Liste, die Verbindung reicht nach 4 s nichts mehr weiter | 175 ms | 20 | Fehler 14,9 s nach dem Stocken: `command_timeout`, „The SSH command failed (open, timeout).“ |
| ein Befehl, fünfmal | 85 ms | – | 390 bis 395 ms |
| Liste | 85 ms | 20 | 18,9 s, alle 20 gebunden |
| Liste | 175 ms | 40 | Fehler nach 60,0 s: `command_timeout`, „The SSH command failed (open, timeout).“ |
| Liste, der tmux-Server des Sockets endet nach 4 s | 175 ms | 40 | Fehler 29,6 s nach dem Ende: `other`, „tmux inventory observation is not a complete snapshot: TmuxError { code: 1 }“ |

1. **Ein Befehl kostet rund das Vierfache der Verzögerung je Richtung** und
   50 bis 70 ms dazu. Das passt zu zwei Hin- und Rückwegen, einem für den
   Kanal und einem für den Befehl; aus den Zahlen geschlossen, nicht am
   Protokoll abgelesen.
2. **Die Frist von 60 s für den Gang trägt.** Die Listen mit 18,9 s und
   36,2 s luden. Bis 0.3.5 hatte der ganze Gang 15 s (`COMMAND_TIMEOUT` in
   `commands.rs` von `v0.3.5`); dass sie damit gescheitert wären, ist am Code
   gelesen, 0.3.5 lief hier nicht. Die Liste mit 20 Sessions kostete rund 47
   Befehlslaufzeiten: die 2N+3 des Gangs und wenige davor und danach. Bei 20
   Sessions reichten 15 s demnach bis rund 320 ms je Befehl, und bei 0,77 s
   je Befehl reichen 60 s für rund 35 Sessions; beides gerechnet.
3. **Das Budget endet auf die Sekunde**, und die Meldung nennt die Phase, in
   der es endet. Hier war es beide Male „open“; nach dem Code kann es auch
   „read“ oder „admission“ sein.
4. **Die Frist von 15 s je Befehl greift**, wenn die Verbindung stockt: Der
   Fehler kam 14,9 s nach dem Stocken, nicht erst am Ende des Budgets.
5. **Die Statusabfrage nebenher stört den Gang nicht** und wird nicht
   abgewiesen; die Liste brauchte mit ihr dieselbe Zeit.
6. **Endet der tmux-Server mitten im Gang, kommt der Fehler erst nach dem
   laufenden Durchgang**, hier 29,6 s später. Erwartet waren höchstens 15 s
   ([Stand](../stand.md), Punkt 15); die Erwartung war falsch. Der Gang fragt
   nach der ersten Liste jede Session einzeln ab (`observe_sessions` in
   `tmux/client.rs`). Ein gescheiterter Einzelbefehl lässt nur diese Zeile
   ungebunden, erst die Inventarabfrage danach bricht ab. Jeder dieser
   Befehle kehrt sofort zurück, die 15 s je Befehl greifen also nicht. Die
   Obergrenze ist das Budget von 60 s. Das Ergebnis ist ein Fehler, keine
   leere oder falsche Liste. Ohne Verzögerung wären es bei 40 Sessions unter
   einer Sekunde; das ist gerechnet, nicht gemessen.

## Nicht gemessen

- Der Standard-Socket von tmux in den Läufen mit Verzögerung. Die App fragt
  ihn in derselben Frist von 60 s mit ab, wenn der Host ihn zeigt; mit
  Sessions dort ist der Spielraum kleiner als hier.
- Die Prüfung nach dem Beenden einer Session über die verzögerte Verbindung.
  Sie nutzt dieselbe Funktion und dieselbe Frist.
- tmux 3.0a, 3.4 und 3.6 und eine andere Shell als bash 5.2, etwa zsh mit
  `~/.zshenv`.
- Das Fenster der App. Gemessen sind die Befehlskerne; was die Oberfläche
  aus ihren Antworten macht, prüfen die Vitest-Tests und die Handabnahme
  (`abnahme-handarbeit.md` §12, A5 und A6).
- Die Pause der Statusabfrage, während eine Liste lädt. Sie liegt im
  Frontend; hier lief die Abfrage absichtlich nebenher.
- Der Zustand der Verbindung nach dem Stocken, über die Trennung am Ende des
  Laufs hinaus.
- Eine Startdatei, die auf Eingabe wartet.
- Paketverlust und schwankende Laufzeiten. Der Verzögerer verzögert
  gleichmäßig.
- Das Ende des tmux-Servers ohne Verzögerung, und während des zweiten
  Durchgangs.
- 0.3.5 zum Vergleich.
