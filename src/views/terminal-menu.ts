// Terminalmenue (UX-Spec §6.3): das Menue, das ein Rechtsklick im Terminal
// oeffnet. Reine Ansicht -- sie kennt weder xterm noch die Zwischenablage;
// `terminal.ts` baut die Eintraege (samt "Copy" aktiv oder ausgegraut) und
// fuehrt aus, was gewaehlt wird. Huelle und Eintragsoptik sind die des
// Hostmenues der Seitenleiste (`.sb-menu`, `.sb-menu-item`).
//
// Das Menue haengt an `body`, nicht am Terminal: `.tile-terminal` beschneidet
// seinen Inhalt, und ein Neuzeichnen der Kachel soll es nicht mitnehmen.
// Geschlossen heisst NICHT IM DOM -- ein nur versteckt gehaltenes Menue waere
// ein weiterer Tabulatorhalt (siehe die Begruendung in `sidebar.ts`).

import { computeMenuPosition } from "./menu-position";

/** Die Eintraege des Rechtsklickmenues (UX-Spec §6.3). */
export type TerminalMenuActionId = "copy" | "paste" | "selectAll" | "find" | "moveEarlier" | "moveLater";

export interface TerminalMenuItem {
  /** Dazu "openLink": der Eintrag der Rueckfrage vor einem OSC-8-Link, dessen
   * sichtbarer Text nicht sein Ziel zeigt. */
  id: TerminalMenuActionId | "openLink";
  label: string;
  /** Kuerzel, rechts im Eintrag. Reiner Hinweis: das Menue bindet keine Taste. */
  shortcut?: string;
  /** Ausgegraut und ohne Wirkung. Der Eintrag bleibt als `aria-disabled` im
   * Baum, nicht als `disabled`: ein deaktivierter Knopf nimmt dem Klick den
   * Fokus, und `focusout` schlosse das Menue, statt dass der Klick nichts tut. */
  disabled?: boolean;
}

/** Beschriftung (samt Kuerzel) je Eintrag und die Hinweiszeile. Kommt vom
 * Aufrufer, weil `terminal.ts` kein i18n kennt -- und keine Tastentabelle. */
export interface TerminalMenuTexts {
  items: Record<TerminalMenuActionId, { label: string; shortcut?: string }>;
  /** Kuerzel von Copy und Paste, solange "Use Ctrl+C and Ctrl+V" aus ist:
   * `items.copy.shortcut` und `items.paste.shortcut` (Strg+C, Strg+V) gelten
   * dann nicht, es bleiben die festen Tasten mit Umschalt. Ein Kuerzel, das
   * nichts tut, waere gelogen. */
  fixedShortcuts: { copy: string; paste: string };
  /** Nicht waehlbare Zeile unter den Eintraegen; `terminal.ts` zeigt sie nur,
   * solange ein Programm die Maus nutzt. */
  mouseHint: string;
}

export interface TerminalMenuOptions {
  /** Lage des Zeigers in Fensterkoordinaten (`clientX`/`clientY`). */
  x: number;
  y: number;
  items: TerminalMenuItem[];
  /** Nicht waehlbare Zeile UEBER den Eintraegen, zugleich der Name der Liste
   * fuer Hilfstechnik (in der Rueckfrage vor einem Link: dessen volles Ziel). */
  heading?: string;
  hint?: string;
  /** So viele Millisekunden nach dem Oeffnen waehlen Klick, Enter und
   * Leertaste noch nichts aus; das Menue bleibt dabei offen. Fuer eine
   * Rueckfrage, deren Ausloeser sonst gleich ihren Eintrag traefe: Ein hohes
   * Menue haelt `placeTerminalMenu` oben im Fenster, dann kann der Eintrag
   * unter dem Zeiger liegen (zweiter Klick eines Doppelklicks), und der
   * Fokus steht auf ihm (ein schnelles Enter). Ohne Wert gilt sofort. */
  armDelayMs?: number;
  /** Ein Eintrag wurde gewaehlt. Das Menue ist dann schon zu und `onClose`
   * gerufen: der Aufrufer legt dort den Fokus ins Terminal, und ein Eintrag
   * wie "Find…" nimmt ihn danach fuer sein Eingabefeld. */
  onSelect(id: TerminalMenuItem["id"]): void;
  /** Das Menue ist zu, gleich warum (Auswahl, Esc, Tab, Klick daneben,
   * Fokusverlust, Mausrad, Groessenaenderung, `close()`). Genau einmal. */
  onClose(): void;
}

interface Size {
  width: number;
  height: number;
}

/** Lage des Menues am Zeiger: nach unten, wenn es passt, sonst nach oben
 * (`computeMenuPosition`); dazu waagerecht und oben im Fenster gehalten, was
 * diese Funktion nicht leistet. Rein, weil jsdom keine Box misst. */
export function placeTerminalMenu(
  pointer: { x: number; y: number },
  size: Size,
  viewport: Size,
): { left: number; top: number } {
  const vertical = computeMenuPosition(
    { left: pointer.x, top: pointer.y, bottom: pointer.y },
    size.height,
    viewport.height,
  );
  return {
    left: Math.max(0, Math.min(vertical.left, viewport.width - size.width)),
    top: Math.max(0, vertical.top),
  };
}

interface Entry {
  item: TerminalMenuItem;
  button: HTMLButtonElement;
}

function buildButton(item: TerminalMenuItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sb-menu-item terminal-menu-item";
  button.setAttribute("role", "menuitem");
  // Den Tabulatorfokus (`tabindex="0"`) setzt allein `focusEntry`.
  button.tabIndex = -1;
  if (item.disabled) button.setAttribute("aria-disabled", "true");

  const label = document.createElement("span");
  label.className = "terminal-menu-label";
  label.textContent = item.label;
  button.appendChild(label);
  if (item.shortcut) {
    const shortcut = document.createElement("span");
    shortcut.className = "terminal-menu-shortcut";
    shortcut.textContent = item.shortcut;
    button.appendChild(shortcut);
  }
  return button;
}

export function openTerminalMenu(opts: TerminalMenuOptions): { close(): void } {
  const root = document.createElement("div");
  root.className = "sb-menu terminal-menu";
  // Fokussierbar, aber nicht per Tabulator: ein Klick auf etwas
  // Nichtfokussierbares im Menue (die Hinweiszeile, der Rand) holt den Fokus
  // sonst auf <body>, und `focusout` schlosse das Menue.
  root.tabIndex = -1;

  // Kopf- und Hinweiszeile stehen neben der Eintragsliste, nicht darin: ein
  // Kind von role=menu ist ein Eintrag, Gruppe oder Trenner.
  if (opts.heading) {
    const heading = document.createElement("div");
    heading.className = "terminal-menu-heading";
    heading.textContent = opts.heading;
    root.appendChild(heading);
  }
  const list = document.createElement("div");
  list.setAttribute("role", "menu");
  if (opts.heading) list.setAttribute("aria-label", opts.heading);
  root.appendChild(list);

  const entries: Entry[] = opts.items.map((item) => ({ item, button: buildButton(item) }));
  for (const entry of entries) list.appendChild(entry.button);
  // Deaktivierte Eintraege bleiben bei der Pfeiltasten-Wanderung aussen vor.
  const enabled = entries.filter((entry) => !entry.item.disabled);

  if (opts.hint) {
    const hint = document.createElement("div");
    hint.className = "terminal-menu-hint";
    hint.textContent = opts.hint;
    root.appendChild(hint);
  }

  let closed = false;
  // `armDelayMs`: bis dahin waehlt nichts aus (siehe `activate`).
  let armed = !opts.armDelayMs;
  const armTimer = armed
    ? undefined
    : window.setTimeout(() => {
        armed = true;
      }, opts.armDelayMs);

  function contains(target: EventTarget | null): boolean {
    return target instanceof Node && root.contains(target);
  }

  function focusEntry(entry: Entry | undefined): void {
    for (const other of entries) other.button.tabIndex = other === entry ? 0 : -1;
    (entry?.button ?? root).focus();
  }

  /** Umlaufend zum naechsten aktiven Eintrag. Steht der Fokus auf keinem
   * (auf der Huelle oder einem ausgegrauten Eintrag), beginnt es am Anfang
   * bzw. Ende der Liste. */
  function move(step: 1 | -1, from: Entry | undefined): void {
    if (enabled.length === 0) return;
    const index = from ? enabled.indexOf(from) : -1;
    if (index === -1) {
      focusEntry(step === 1 ? enabled[0] : enabled[enabled.length - 1]);
      return;
    }
    focusEntry(enabled[(index + step + enabled.length) % enabled.length]);
  }

  function close(): void {
    // Das Flag zuerst: `onClose` legt den Fokus ins Terminal, das feuert
    // `focusout` am noch fokussierten Eintrag und liefe sonst erneut hierher.
    if (closed) return;
    closed = true;
    window.clearTimeout(armTimer);
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("resize", close);
    root.remove();
    opts.onClose();
  }

  function activate(entry: Entry): void {
    // Vor `armDelayMs` gehoert ein Klick oder eine Taste noch zur Geste, die
    // das Menue geoeffnet hat: nichts waehlen, offen bleiben.
    if (closed || entry.item.disabled || !armed) return;
    // ERST schliessen und den Fokus zurueckgeben, DANN handeln (wie im
    // Hostmenue): sonst taete ein Eintrag wie "Find…" seinen Fokus fuer das
    // Eingabefeld, und `onClose` risse ihn ins Terminal zurueck.
    close();
    opts.onSelect(entry.item.id);
  }

  // Capture am Dokument: `terminal.ts` stoppt die rechte Taste am
  // Terminalcontainer (`stopPropagation`), ein Rechtsklick auf ein anderes
  // Terminal darf dieses Menue trotzdem schliessen.
  function onPointerDown(event: MouseEvent): void {
    if (!contains(event.target)) close();
  }

  // "Scrollen" heisst hier das Mausrad, nicht das scroll-Ereignis: xterm
  // schreibt `scrollTop` seines Viewports bei JEDER Bewegung der Ansicht
  // (`DomScrollableElement`), auch wenn nur neue Ausgabe eintrifft. Ein
  // scroll-Lauscher schlosse das Menue unter einem streamenden Agenten von
  // selbst.
  function onWheel(event: WheelEvent): void {
    if (!contains(event.target)) close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const current = entries.find((entry) => entry.button === event.target);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1, current);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1, current);
        break;
      case "Home":
        event.preventDefault();
        focusEntry(enabled[0]);
        break;
      case "End":
        event.preventDefault();
        focusEntry(enabled[enabled.length - 1]);
        break;
      case "Enter":
      case " ":
        // preventDefault: sonst klickt Chromium den Knopf zusaetzlich.
        event.preventDefault();
        if (current) activate(current);
        break;
      case "Escape":
        event.preventDefault();
        // MUSS die Weitergabe stoppen: main.ts haengt einen dauerhaften
        // Dokument-Horcher, der eine maximierte Kachel zurueckholt und auf
        // kein Menue Ruecksicht nimmt.
        event.stopPropagation();
        close();
        break;
      case "Tab":
        // Anders als im Hostmenue der Seitenleiste verschluckt: `onClose` legt
        // den Fokus ins Terminal, und ein durchgelassener Tabulator zoege ihn
        // von dort sofort weiter.
        event.preventDefault();
        close();
        break;
    }
  }

  for (const entry of entries) entry.button.addEventListener("click", () => activate(entry));
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("focusout", (event) => {
    if (!contains(event.relatedTarget)) close();
  });
  // Auf dem Menue selbst gibt es kein Browsermenue.
  root.addEventListener("contextmenu", (event) => event.preventDefault());

  document.body.appendChild(root);
  const box = root.getBoundingClientRect();
  const placement = placeTerminalMenu(
    { x: opts.x, y: opts.y },
    { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  root.style.left = `${placement.left}px`;
  root.style.top = `${placement.top}px`;

  focusEntry(enabled[0]);

  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("wheel", onWheel, { capture: true, passive: true });
  window.addEventListener("resize", close);

  return { close };
}
