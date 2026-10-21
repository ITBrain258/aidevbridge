// Zeigerzug fuer Spalt und Kachelkopf (Spec 2026-10-19 §4.4, §5.4): dasselbe
// Muster wie der Ziehgriff der Seitenleiste (`sidebar-resize.ts`) --
// `setPointerCapture`, Ende ueber `pointerup`, Abbruch ueber `pointercancel`,
// den Verlust der Erfassung, eine losgelassene Taste oder Esc. Kein
// HTML5-Drag-and-drop. Das Modul weiss nichts von Kacheln: es meldet Beginn,
// Bewegung und Ende, und den Weg seit dem Druecken.

export interface PointerDragHandlers {
  /** Die Bewegung hat die Schwelle erreicht. */
  start(event: PointerEvent): void;
  /** Jede Bewegung nach dem Start; `dx`/`dy` seit dem Druecken. */
  move(event: PointerEvent, dx: number, dy: number): void;
  /** Losgelassen nach dem Start. */
  end(event: PointerEvent, dx: number, dy: number): void;
  /** Abgebrochen nach dem Start. */
  cancel(): void;
}

/** Verfolgt den Zeiger von `down` an am Element `handle`. Bis die Bewegung
 * `threshold` Pixel erreicht, geschieht nichts -- ein Klick bleibt ein Klick,
 * und ein Doppelklick kommt durch. Liefert eine Funktion, die den Zug
 * abbricht. */
export function trackPointerDrag(
  handle: HTMLElement,
  down: PointerEvent,
  threshold: number,
  handlers: PointerDragHandlers,
): () => void {
  const { pointerId, clientX: startX, clientY: startY } = down;
  let started = false;
  let done = false;
  // Die Erfassung leitet jedes weitere Ereignis dieses Zeigers an `handle`,
  // auch wenn er es laengst verlassen hat. Ohne sie gibt es keinen Zug.
  try {
    handle.setPointerCapture(pointerId);
  } catch {
    return () => {};
  }

  function finish(): void {
    done = true;
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onLost);
    handle.removeEventListener("lostpointercapture", onLost);
    document.removeEventListener("lostpointercapture", onLost, true);
    document.removeEventListener("keydown", onKey, true);
  }

  function abort(): void {
    if (done) return;
    const wasStarted = started;
    finish();
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // Schon frei, oder der Zeiger ist fort.
    }
    if (wasStarted) handlers.cancel();
  }

  function onMove(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    // Ist die Haupttaste nicht mehr gedrueckt, kam ihr `pointerup` nie an:
    // der Zug ist vorbei, und diese Bewegung gehoert nicht mehr dazu.
    if ((event.buttons & 1) === 0) {
      abort();
      return;
    }
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!started) {
      if (Math.hypot(dx, dy) < threshold) return;
      started = true;
      handlers.start(event);
    }
    handlers.move(event, dx, dy);
  }

  function onUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const wasStarted = started;
    // Erst abmelden: das folgende `lostpointercapture` findet keinen Zug mehr.
    finish();
    if (wasStarted) handlers.end(event, event.clientX - startX, event.clientY - startY);
  }

  function onLost(event: PointerEvent): void {
    if (event.pointerId === pointerId) abort();
  }

  // In der Fangphase und nur waehrend eines laufenden Zugs: dann gehoert Esc
  // ihm und holt keine maximierte Kachel zurueck (`keyboard.ts` uebergeht ein
  // Ereignis mit `defaultPrevented`). Vor dem Start bleibt Esc frei.
  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !started) return;
    event.preventDefault();
    event.stopPropagation();
    abort();
  }

  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onLost);
  handle.addEventListener("lostpointercapture", onLost);
  // Verschwindet `handle` mitten im Zug (die Kachel schliesst: Strg+Umschalt+W,
  // eine verschwundene Session, ein entfernter Host), schickt der Browser
  // `lostpointercapture` an das Dokument, und am Griff kommt nichts mehr an.
  // Ohne diesen Lauscher bliebe der Zug haengen: die Zielkontur stuende, und
  // das naechste Esc gehoerte weiter ihm. Fangphase, damit auch ein Ereignis
  // am Griff selbst hier ankommt; `onLost` prueft die `pointerId`, `abort` ist
  // nach dem ersten Aufruf wirkungslos (`done`).
  document.addEventListener("lostpointercapture", onLost, true);
  document.addEventListener("keydown", onKey, true);
  return abort;
}
