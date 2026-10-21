// Dokumentweite Tastenlauscher, eigenes Modul neben main.ts, damit die
// Tastenregeln ohne den ganzen Anwendungszustand pruefbar sind: der
// Akkord-Handler, die Tasten der Schriftgroesse (UX-Spec §6.7) und das
// Escape fuer die maximierte Kachel. Dazu kommen die Grenzen zum
// Browser (UX-Spec §8.1, §8.2): Tasten und Kontextmenue, die WebView2 sonst wie
// eine Webseite behandelt, und die Akkorde in Textfeldern. Was eine Aktion
// bewirkt, entscheidet main.ts -- dieses Modul kennt weder `AppState` noch das
// DOM ausser dem Ereignisziel und reicht jede Aktion an genau eine
// Abhaengigkeit weiter.
import { fontSizeKeyChange, isAppChord, isPlainCtrlAppKey, matchAction, type FontSizeChange } from "./keymap";

/** Je Aktion ein Rueckruf in den Zustand von main.ts. */
export interface KeyboardDeps {
  /** `session.new`: Session auf dem Zielhost (UX-Spec §7.9, zuerst der Host der
   * fokussierten Kachel). */
  newSession(): void;
  /** `sidebar.toggle` */
  toggleSidebar(): void;
  /** `sidebar.focus` */
  focusSidebar(): void;
  /** `tile.maximize`: die fokussierte Kachel maximieren/wiederherstellen. */
  toggleMaximize(): void;
  /** `tile.moveEarlier`/`tile.moveLater`: die fokussierte Kachel eine
   * Position nach vorn (-1) oder hinten (1) (Spec 2026-10-19 §5.4). */
  moveTile(delta: 1 | -1): void;
  /** `session.select.N`: die Kachel an Position N fokussieren (Spec 2026-10-19 §5.7). */
  selectTile(n: number): void;
  /** `session.prev`: Fokus zur vorigen Kachel. */
  prevSession(): void;
  /** `session.next`: Fokus zur naechsten Kachel. */
  nextSession(): void;
  /** `session.nextWaiting` */
  nextWaiting(): void;
  /** `settings.open` (Strg+,, UX-Spec §8.3): den Einstellungsdialog oeffnen. */
  openSettings(): void;
  /** `quickOpen` (Strg+Umschalt+P, UX-Spec §7.5): das Schnelloeffnen zeigen. */
  openQuickOpen(): void;
  /** Schriftgroesse aller Terminals (UX-Spec §6.7): groesser, kleiner oder
   * zurueck auf den Standard. */
  changeFontSize(change: FontSizeChange): void;
  /** Escape: holt eine maximierte Kachel zurueck; `true`, wenn es eine gab. */
  restoreMaximized(): boolean;
  /** Steht eine Dialog-Ueberlagerung offen? Dann gehoert ihr die Tastatur. */
  isDialogOpen(): boolean;
}

/** `<input>`-Typen, in die getippt wird und die deshalb das native
 * Bearbeitungsmenue und ihre Editiertasten behalten. Schalter, Knoepfe und
 * Regler gehoeren nicht dazu: dort gibt es nichts zu bearbeiten. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** Liegt `target` im Terminal? xterm.js haengt sein Wurzelelement `.xterm` samt
 * Hilfstextfeld in den Container der Kachel (siehe `terminal.ts`). */
function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".xterm") !== null;
}

/** Ein Feld der Oberflaeche, in das getippt wird. Xterms Hilfstextfeld ist
 * ebenfalls ein `<textarea>`, gehoert aber zum Terminal (`inTerminal`). */
function isTextField(target: EventTarget | null): boolean {
  if (inTerminal(target)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

/** Funktionstasten, die WebView2 wie eine Webseite behandelt (UX-Spec §8.1):
 * neu laden (F5), in der Seite suchen (F3) und Caret-Browsing (F7). Mit jedem
 * Modifikator, denn Umschalt+F3 sucht rueckwaerts und Strg+F5 laedt ohne
 * Zwischenspeicher neu. Im Terminal gehoeren sie dem Programm. */
const BROWSER_FUNCTION_KEYS = new Set(["F5", "F3", "F7"]);

/** Die Medientasten des Browsers (UX-Spec §8.1). Anders als alle anderen
 * Browsertasten sind sie ueberall gesperrt, auch im Terminal: xterm schickt sie
 * nicht ans Programm, und ohne Sperre fielen sie zu WebView2 durch --
 * BrowserRefresh luede die App neu. Mit jedem Modifikator. */
const BROWSER_MEDIA_KEYS = new Set([
  "BrowserBack",
  "BrowserForward",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserHome",
  "BrowserStop",
  "BrowserFavorites",
]);

/** Strg+Buchstabe mit Browserfunktion: neu laden (R), drucken (P), in der Seite
 * suchen (F, G), speichern (S), oeffnen (O), Quelltext (U), Downloads (J).
 * Strg+H (Verlauf) fehlt mit Absicht, siehe `isBrowserKey`. */
const BROWSER_CTRL_LETTERS = new Set(["r", "p", "f", "g", "s", "o", "u", "j"]);

/** Ist das eine Taste des Browsers, die ausserhalb des Terminals in der App
 * nichts verloren hat? Die Bearbeitungstasten (Strg+C/V/X/A/Z/Y, Pfeile) und
 * F12 gehoeren nie dazu; die Medientasten sperrt `onBrowserKeydown` vorher,
 * auch im Terminal.
 *
 * Strg+Buchstabe bleibt auch mit Umschalt eine Browsertaste: Strg+Umschalt+R
 * laedt ebenfalls neu, und ein Strg+Umschalt-Akkord ohne App-Aktion bliebe im
 * Textfeld sonst beim Browser (UX-Spec §8.2). Belegte App-Akkorde wie
 * Strg+Umschalt+F oder G laufen zusaetzlich durch den Akkord-Handler unten. */
function isBrowserKey(event: KeyboardEvent): boolean {
  if (BROWSER_FUNCTION_KEYS.has(event.key)) return true;
  // Die billigen Pruefungen zuerst: ein keydown, das kein echtes KeyboardEvent
  // ist (etwa von Autofill), darf hier nicht werfen.
  if (!event.ctrlKey && !event.altKey) return false;
  // AltGr (unter Windows Strg+Alt) erzeugt auf der deutschen Tastatur @, das
  // Eurozeichen, Backslash und die Klammern, auf anderen Layouts Buchstaben mit
  // Akzent. Das ist Eingabe und nie eine Browsertaste, auch wenn die
  // Buchstabentaste in der Liste steht. Ob Chromium dabei Strg und Alt
  // loescht oder nicht: die Taste faellt hier in beiden Faellen heraus (siehe
  // `isAppChord`).
  if (event.metaKey || event.getModifierState("AltGraph")) return false;
  if (event.altKey) {
    // Zurueck und vor sind genau Alt+Pfeil.
    return !event.ctrlKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight");
  }
  // Mit Umschalt oder Feststelltaste kommt "R" statt "r".
  const letter = event.key.toLowerCase();
  if (BROWSER_CTRL_LETTERS.has(letter)) return true;
  // Strg+H (Verlauf) nur ausserhalb von Eingabefeldern (UX-Spec §8.1). Erst hier
  // wird das Ziel auf ein Feld geprueft: nur diese Taste braucht die Antwort.
  return letter === "h" && !isTextField(event.target);
}

/** Haengt die Lauscher an `document` und `window` und liefert die Abmeldung. */
export function installKeyboard(deps: KeyboardDeps): () => void {
  // Designsystem §7.5: dokumentweiter Akkord-Handler fuer alle Aktionen, die
  // `AppState`/Sidebar-DOM brauchen und deshalb NICHT in `terminal.ts` (das
  // bewusst nichts ausser `KeyboardEvent`-Logik importiert -- siehe dortiger
  // Kopfkommentar) verdrahtet werden koennen: `session.prev`/`.next`/
  // `.select.N` (die Zuordnung steht in `keymap.ts`) und
  // `tile.maximize`/`sidebar.toggle`/`sidebar.focus`.
  //
  // Faengt JEDEN Ctrl+Shift-Akkord GENAU EIN zweites Mal ab, auch wenn eine
  // Terminal-Kachel fokussiert ist: `terminal.ts`s `attachCustomKeyEventHandler`
  // ruft zwar `event.preventDefault()`, aber nie `stopPropagation()` (siehe
  // dessen `default`-Zweig-Kommentar) -- das `keydown` erreicht `document`
  // also in JEDEM Fall, ob Terminal, Sidebar oder gar nichts gerade fokussiert
  // ist. `clipboard.copy`/`search.local`/`session.close` bleiben trotzdem
  // ALLEIN `terminal.ts`s Sache (das hat `term`/`SearchAddon`, hier gibt es
  // dafuer keinen Griff), `clipboard.paste` erledigt Chromium selbst, im
  // Terminal (UX-Spec §6.1) wie in einem Textfeld (§8.2) -- der `switch` unten
  // hat fuer sie deshalb keinen eigenen Zweig, `default: break` laesst sie
  // unangetastet.
  // `session.new` ist seit dem Abschlussreview (Important 5) die Ausnahme:
  // es hat hier einen eigenen Zweig UND in `terminal.ts` keinen mehr.
  //
  // UX-Spec §8.3: neben dem Strg+Umschalt-Raum gehoert der App Strg allein auf
  // den Tasten der Ausnahmeliste -- aber nur mit einer Aktion (Strg+,).
  // Strg+=, Strg+- und Strg+0 haben keine; sie sind die festen Tasten der
  // Schriftgroesse (`onFontSizeKeydown` unten) und bleiben hier unberuehrt.
  // Mit Fokus im Terminal kommt Strg+, ebenfalls hier an: `terminal.ts` gibt
  // xterm `false` und stoppt nichts.
  function onAppChordKeydown(event: KeyboardEvent): void {
    const chord = isAppChord(event);
    if (!chord && !isPlainCtrlAppKey(event)) return;
    const action = matchAction(event);
    if (!chord && action === null) return;
    // UX-Spec §8.2: In einem Textfeld ausserhalb des Terminals gehoert ein
    // Akkord der App nur, wenn er eine Aktion hat. Ohne Aktion bleibt er beim
    // Feld: Strg+Umschalt+Pfeil, Pos1, Ende und Z markieren und wiederholen dort.
    // Die Browsertasten (Strg+Umschalt+R, P, ...) haelt `onBrowserKeydown` unten
    // unabhaengig davon an.
    if (action === null && isTextField(event.target)) return;
    // Sonst gehoert der gesamte Ctrl+Shift-Raum der App (siehe keymap.ts), auch
    // ein (noch) unbelegter Akkord -- ein Browser-Vorgabeverhalten (z. B.
    // Chromiums eigenes Ctrl+Shift+B fuer die Lesezeichenleiste) darf nie
    // durchschlagen, unabhaengig davon, ob unten eine Aktion ausgeloest
    // wird. Einzige Ausnahme ist das Einfuegen: im Terminal (UX-Spec §6.1) IST
    // das Vorgabeverhalten gewollt -- Chromium fuegt in xterms Hilfstextfeld
    // ein, ohne Leserecht, und `terminal.ts` laesst die Taste dafuer ebenfalls
    // unverhindert durch --, und in einem Textfeld (§8.2) fuegt Chromium als
    // reinen Text ein. Strg+Umschalt+C bleibt abgefangen. Das Textfeld wird nur
    // fuer diese Aktion geprueft.
    const nativePaste =
      action === "clipboard.paste" && (inTerminal(event.target) || isTextField(event.target));
    if (!nativePaste) event.preventDefault();
    // Waehrend ein Dialog offen ist, gehoert die Tastatur der Fokus-Falle
    // (`onDialogKeydown` in `views/dialog.ts`) -- ein Akkord, der im
    // Hintergrund `state.hosts`/`state.tiles` aendert, waere fuer den Dialog
    // unsichtbar und liesse die Seitenleiste/das Raster hinter dem Scrim
    // driften.
    if (deps.isDialogOpen()) return;

    if (!action) return;

    switch (action) {
      case "session.prev":
        deps.prevSession();
        break;
      case "session.next":
        deps.nextSession();
        break;
      case "session.nextWaiting":
        deps.nextWaiting();
        break;
      case "session.select.1":
      case "session.select.2":
      case "session.select.3":
      case "session.select.4":
      case "session.select.5":
      case "session.select.6":
      case "session.select.7":
      case "session.select.8":
      case "session.select.9":
        deps.selectTile(Number(action.slice("session.select.".length)));
        break;
      case "tile.maximize":
        deps.toggleMaximize();
        break;
      case "tile.moveEarlier":
        deps.moveTile(-1);
        break;
      case "tile.moveLater":
        deps.moveTile(1);
        break;
      case "sidebar.toggle":
        deps.toggleSidebar();
        break;
      case "sidebar.focus":
        deps.focusSidebar();
        break;
      case "session.new":
        deps.newSession();
        break;
      case "settings.open":
        deps.openSettings();
        break;
      case "quickOpen":
        deps.openQuickOpen();
        break;
      default:
        // clipboard.copy/paste, search.local, session.close: bleiben
        // `terminal.ts`s bzw. Chromiums Sache (siehe Kopfkommentar oben).
        // Ausserhalb eines fokussierten Terminals bewusst wirkungslos: ohne
        // Terminal gibt es nichts zu kopieren, zu durchsuchen oder zu
        // schliessen.
        break;
    }
  }

  // Schriftgroesse (UX-Spec §6.7): feste Tasten ausserhalb der Tabelle, nach
  // `event.key` (`fontSizeKeyChange` in keymap.ts). Sie wirken ueberall, auch mit
  // Fokus im Terminal: dessen Hilfstextfeld zaehlt nicht als Eingabefeld, und
  // `terminal.ts` laesst die Tasten zum Dokument durch. Ausgenommen sind
  // Eingabefelder ausserhalb von `.xterm` und ein offener Dialog; dort bleibt die
  // Taste unverhindert. `defaultPrevented` zaehlt hier nicht: `+` ist auf der
  // US-Tastatur Strg+Umschalt+=, also ein Strg+Umschalt-Akkord ohne Aktion, und
  // den verhindert `onAppChordKeydown` oben (frueher angemeldet) schon vor
  // diesem Lauscher. `terminal.ts` verhindert ihn nicht: dessen Tastenhandler
  // gibt fuer die Tasten der Schriftgroesse `false` zurueck, bevor er zum Zweig
  // der Akkorde kommt.
  function onFontSizeKeydown(event: KeyboardEvent): void {
    const change = fontSizeKeyChange(event);
    if (change === null) return;
    if (isTextField(event.target) || deps.isDialogOpen()) return;
    event.preventDefault();
    deps.changeFontSize(change);
  }

  // Zweiter, unabhaengiger Escape-Handler (Designsystem §7.4): stellt eine
  // maximierte Kachel wieder her. NICHT Teil von `onDialogKeydown` (dessen
  // Escape-Zweig nur waehrend eines offenen Dialogs am `document` haengt,
  // siehe `openDialog`/`closeDialog` in `views/dialog.ts`) -- eine maximierte
  // Kachel kann bestehen, OHNE dass ein Dialog offen ist, dieser Handler muss
  // also immer aktiv sein. Kollidiert trotzdem nicht mit `onDialogKeydown`:
  // Escape bei offenem Dialog UND maximierter Kachel soll den Dialog
  // schliessen, nicht die Kachel wiederherstellen (beide gleichzeitig waere
  // verwirrend) -- `if (deps.isDialogOpen()) return` unten macht das
  // unabhaengig von der Registrierungsreihenfolge der beiden Listener
  // verbindlich.
  //
  // `event.target`-Wache gegen den `.xterm`-Teilbaum (Designsystem §7.4,
  // wortwoertlich gefordert): `attachCustomKeyEventHandler` in `terminal.ts`
  // reicht ein einfaches Escape unveraendert ans Terminal durch (kein
  // Ctrl+Shift-Akkord, `isAppChord` liefert `false`) UND das Ereignis
  // blubbert trotzdem bis `document` (siehe `onAppChordKeydown`s
  // Kopfkommentar: kein `stopPropagation()` irgendwo im Pfad) -- ohne diese
  // Wache wuerde JEDES Escape in einem laufenden `vim` innerhalb einer
  // maximierten Kachel diese zusaetzlich wiederherstellen, obwohl vim sein
  // Escape laengst bekommen hat. Ctrl+Shift+M bleibt davon unberuehrt: es
  // ist ein App-Akkord (`isAppChord` liefert `true`) und damit "der Weg
  // heraus, wenn der Fokus im Terminal liegt" (Designsystem §7.5), genau wie
  // vorgesehen.
  //
  // `defaultPrevented` (UX-Spec §8.2): wer dieses Escape fuer sich gebraucht
  // hat -- ein Feld oder eine Leiste, die es schliesst --, ruft
  // `preventDefault()`, und die Kachel bleibt maximiert. Dafuer braucht der
  // andere Lauscher kein `stopPropagation()`.
  function onMaximizedEscapeKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (event.defaultPrevented) return;
    if (inTerminal(event.target)) return;
    if (deps.isDialogOpen()) return;
    if (deps.restoreMaximized()) event.preventDefault();
  }

  // Browsertasten (UX-Spec §8.1): ein Lauscher in der Capture-Phase am `window`,
  // damit er vor jedem Lauscher der Oberflaeche laeuft und auch dann greift, wenn
  // einer davon die Weitergabe stoppt. Ohne ihn laedt F5 oder Strg+R die ganze
  // App neu -- alle Terminals und Verbindungen der Oberflaeche gehen verloren --,
  // und Strg+P, Strg+F oder Strg+S oeffnen Dialoge einer Webseite. Verhindert wird
  // nur das Vorgabeverhalten; das Ereignis laeuft weiter.
  //
  // Im Terminal (`.xterm`) schickt xterm die Funktions- und Strg-Tasten ans
  // Programm: Strg+R ist dort die Rueckwaertssuche der Shell und darf nicht
  // angehalten werden. Die Medientasten stehen davor, sie gelten auch dort.
  function onBrowserKeydown(event: KeyboardEvent): void {
    if (BROWSER_MEDIA_KEYS.has(event.key)) {
      event.preventDefault();
      return;
    }
    if (inTerminal(event.target)) return;
    if (isBrowserKey(event)) event.preventDefault();
  }

  // Das Browsermenue ("Reload", "Print") gibt es in der App nicht (UX-Spec §8.1).
  // Ausgenommen sind Textfelder, die ihr natives Bearbeitungsmenue behalten,
  // und das Terminal, das sein eigenes Menue oeffnet (`terminal.ts`, §6.3):
  // dort ruft der Container selbst `preventDefault()`, dieser Lauscher ist dafuer
  // weder noetig noch beteiligt.
  function onContextMenu(event: MouseEvent): void {
    if (inTerminal(event.target) || isTextField(event.target)) return;
    event.preventDefault();
  }

  window.addEventListener("keydown", onBrowserKeydown, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("keydown", onAppChordKeydown);
  document.addEventListener("keydown", onFontSizeKeydown);
  document.addEventListener("keydown", onMaximizedEscapeKeydown);
  return () => {
    window.removeEventListener("keydown", onBrowserKeydown, true);
    window.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("keydown", onAppChordKeydown);
    document.removeEventListener("keydown", onFontSizeKeydown);
    document.removeEventListener("keydown", onMaximizedEscapeKeydown);
  };
}
