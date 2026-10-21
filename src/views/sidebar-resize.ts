// Ziehgriff der Seitenleiste (UX-Spec §7.8): ein 6 px breiter Streifen am
// rechten Rand von `#sidebar`, `role="separator"`. Die Breite steht im Token
// `--ab-sidebar-w`, aus dem `#app` seine erste Spalte nimmt; dieses Modul setzt
// es inline an seinem Ziel (`#app`) und ist zur Laufzeit dessen einziger
// Schreiber. Ohne Aenderung gilt die Vorgabe aus styles.css.
//
// Waehrend des Ziehens folgen das Token und, ueber `onInput`, die Lage der
// Kacheln (Spec 2026-10-19 §4.5). Die Terminals passen sich erst beim
// Loslassen an, einmal: `onCommit` ruft in main.ts `gridHandle.refit()` und das
// entprellte Speichern. Tasten und Doppelklick melden je Aenderung einmal. Eine
// Eingabe, die die Breite nicht aendert, meldet nichts -- ein Zug zurueck an
// den Ausgangspunkt ebenso wie ← an der Untergrenze oder Pos1 bei 240.
//
// Eingeklappt verschwindet der Griff mit `#sidebar` (`display: none` in
// styles.css); `setHidden` setzt zusaetzlich `hidden`, das auch die Fokus-Falle
// (`focusableElements`) und die Tests sehen.
import en from "../i18n/en.json";

type TranslationKey = keyof typeof en;

function t(key: TranslationKey): string {
  return en[key];
}

/** Vorgabe und Grenzen der Breite in px (UX-Spec §7.8). Die Vorgabe ist die
 * von `--ab-sidebar-w` in styles.css (`styles.test.ts` prueft das).
 *
 * Untergrenze 208 statt der 200 aus der Spec (Aufgabe 19, Fixrunde 2): erst
 * ab 208 px passt die Leiste eines verbundenen Hosts
 * (Disconnect, New session, Reload sessions, ⋯) auch mit dem Scrollbalken der
 * Liste in eine Zeile, und von 240 aus treffen die Pfeilschritte genau 224 und
 * 208. Rust klemmt weiter auf 200 bis 480 (alles ausserhalb wird 240); einen
 * gespeicherten Wert von 200 bis 207 zeigt die Klemme hier als 208, ohne ihn zu
 * schreiben. */
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 208;
export const SIDEBAR_WIDTH_MAX = 480;
/** Schritt der Pfeiltasten. */
const KEY_STEP = 16;

export interface SidebarResizeOptions {
  /** Das Element, dessen Spalte die Breite liest (`#app`): dort steht das
   * Token inline. */
  target: HTMLElement;
  /** Eine Aenderung ist abgeschlossen: Loslassen nach einem Zug, eine Taste,
   * ein Doppelklick -- nur, wenn sich die Breite wirklich geaendert hat. */
  onCommit(width: number): void;
  /** Die Breite hat sich geaendert, auch mitten im Zug (Spec 2026-10-19 §4.5):
   * das Token steht schon. Fuer alles, was der neuen Flaeche sofort folgen
   * muss, ohne zu vermessen -- das Vermessen bleibt bei `onCommit`. Auch
   * `setWidth` meldet hier (die gespeicherte Breite beim Start). */
  onInput?(width: number): void;
}

export interface SidebarResizeHandle {
  /** Setzt eine Breite, ohne `onCommit` zu rufen (die gespeicherte beim
   * Start). Geklemmt und ganzzahlig; `true`, wenn sie sich geaendert hat. */
  setWidth(width: number): boolean;
  /** Eingeklappte Seitenleiste: der Griff ist weder zu sehen noch zu
   * erreichen. Ein laufender Zug endet dabei und meldet seine Breite, wenn sie
   * sich geaendert hat. */
  setHidden(hidden: boolean): void;
}

function clampWidth(value: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

/** Haengt den Griff an `container` an (in der App `#sidebar`, hinter die
 * Leiste selbst). */
export function mountSidebarResize(container: HTMLElement, opts: SidebarResizeOptions): SidebarResizeHandle {
  let width = SIDEBAR_WIDTH_DEFAULT;
  /** Der laufende Zug: welcher Zeiger, wo er anfing, mit welcher Breite. */
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;

  const handle = document.createElement("div");
  handle.className = "sb-resize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", t("sidebar.resize"));
  handle.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
  handle.setAttribute("aria-valuemax", String(SIDEBAR_WIDTH_MAX));
  handle.setAttribute("aria-valuenow", String(width));
  // Ein eigener Tabstopp: ←/→ und Pos1 wirken nur mit Fokus auf dem Griff.
  handle.tabIndex = 0;
  container.appendChild(handle);

  /** Nach dem Aufbau einziger Schreiber von Token und `aria-valuenow`. */
  function apply(next: number): boolean {
    const clamped = clampWidth(next);
    if (clamped === width) return false;
    width = clamped;
    opts.target.style.setProperty("--ab-sidebar-w", `${width}px`);
    handle.setAttribute("aria-valuenow", String(width));
    opts.onInput?.(width);
    return true;
  }

  function commit(next: number): void {
    if (apply(next)) opts.onCommit(width);
  }

  /** Schliesst den laufenden Zug und meldet die Breite, wenn sie sich
   * geaendert hat. Der Browser schickt beim Loslassen erst `pointerup`, dann
   * `lostpointercapture`: der erste schliesst den Zug, der zweite findet keinen
   * mehr. Ein Abbruch (`pointercancel`) kommt allein ueber den zweiten an. */
  function endDrag(): void {
    if (!drag) return;
    const { startWidth } = drag;
    drag = null;
    handle.classList.remove("sb-resize--dragging");
    if (width !== startWidth) opts.onCommit(width);
  }

  handle.addEventListener("pointerdown", (event) => {
    // Ein zweiter Zeiger waehrend eines Zugs uebernimmt ihn nicht.
    if (event.button !== 0 || drag) return;
    // Sonst markierte der Zug Text in Seitenleiste und Kacheln, und der Druck
    // zoege den Fokus auf den Griff. Ein Zug mit der Maus laesst ihn, wo er
    // war -- meist im Terminal, das danach weiter die Tastendruecke bekommt
    // (Fixrunde 3); die Tastatur erreicht den Griff ueber den Tabulator.
    event.preventDefault();
    // Die Erfassung leitet jedes weitere Ereignis dieses Zeigers an den Griff,
    // auch wenn er den 6-px-Streifen laengst verlassen hat. Ohne sie gibt es
    // keinen Zug: sein Loslassen kaeme womoeglich nie hier an.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    handle.classList.add("sb-resize--dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    // Ist die Haupttaste nicht mehr gedrueckt, ist der Zug vorbei, auch wenn
    // sein `pointerup` nie ankam. Diese Bewegung gehoert nicht mehr dazu.
    if ((event.buttons & 1) === 0) {
      endDrag();
      return;
    }
    apply(drag.startWidth + event.clientX - drag.startX);
  });
  handle.addEventListener("pointerup", (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    apply(drag.startWidth + event.clientX - drag.startX);
    endDrag();
  });
  handle.addEventListener("lostpointercapture", (event) => {
    if (drag?.pointerId === event.pointerId) endDrag();
  });

  handle.addEventListener("dblclick", () => commit(SIDEBAR_WIDTH_DEFAULT));

  handle.addEventListener("keydown", (event) => {
    // Mit Umschalt, Strg, Alt oder Meta gehoert die Taste anderen:
    // Strg+Umschalt+Pfeil ist ein Akkord, Alt+Pfeil sperrt keyboard.ts als
    // Browsertaste.
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = width - KEY_STEP;
        break;
      case "ArrowRight":
        next = width + KEY_STEP;
        break;
      case "Home":
        next = SIDEBAR_WIDTH_DEFAULT;
        break;
      default:
        return;
    }
    event.preventDefault();
    commit(next);
  });

  return {
    setWidth: apply,
    setHidden(hidden) {
      // Eingeklappt waehrend eines Zugs: der Zug endet sofort und meldet die
      // Breite, die eben noch zu sehen war (wenn sie sich geaendert hat) --
      // dieselbe erscheint beim Aufklappen wieder. Ein spaeteres Loslassen am
      // verborgenen Griff meldet dann nichts mehr.
      if (hidden) endDrag();
      handle.hidden = hidden;
    },
  };
}
