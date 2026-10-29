// Spec 2026-10-27 §5.5: die Geste des Wischens -- Schwelle, Zeilen, Reste,
// Auslauf. Was eine Zeile im Terminal bewirkt, prueft `terminal.test.ts`.
// Uhr und Bildtakt sind eigene, damit der Auslauf Bild fuer Bild laeuft.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SLOP_PX, attachTouchScroll, type TouchOrigin, type TouchScrollClock } from "./touch-scroll";

const ROW = 20;

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const clock: TouchScrollClock = {
    now: () => time,
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  };
  return {
    clock,
    advance(ms: number) {
      time += ms;
    },
    /** Ein Bild nach `ms`: jeder angemeldete Rueckruf laeuft einmal. */
    frame(ms = 16) {
      time += ms;
      const due = [...frames.values()];
      frames.clear();
      due.forEach((callback) => callback());
    },
    pending: () => frames.size,
  };
}

/** Ein Touch-Ereignis; jsdom baut keine `Touch`-Objekte. `points` sind die
 * Finger, die danach noch auf dem Glas liegen. */
function touch(target: EventTarget, type: string, points: Array<{ y: number; x?: number }>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: points.map((point) => ({ clientX: point.x ?? 10, clientY: point.y })),
  });
  target.dispatchEvent(event);
  return event;
}

describe("attachTouchScroll (Spec 2026-10-27 §5.5)", () => {
  let el: HTMLElement;
  let controller: AbortController;
  let time: ReturnType<typeof fakeClock>;
  let scrolled: Array<{ rows: number; origin: TouchOrigin }>;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    controller = new AbortController();
    time = fakeClock();
    scrolled = [];
    attachTouchScroll(
      el,
      { rowHeight: () => ROW, scroll: (rows, origin) => scrolled.push({ rows, origin }) },
      controller.signal,
      time.clock,
    );
  });

  afterEach(() => {
    controller.abort();
    el.remove();
  });

  const rows = () => scrolled.map((entry) => entry.rows);
  const total = () => rows().reduce((sum, value) => sum + value, 0);

  /** Ein Zug mit gleichmaessiger Geschwindigkeit: `steps` Schritte zu je
   * `dy` px alle 10 ms. */
  function drag(from: number, dy: number, steps: number): number {
    touch(el, "touchstart", [{ y: from }]);
    let y = from;
    for (let i = 0; i < steps; i++) {
      time.advance(10);
      y += dy;
      touch(el, "touchmove", [{ y }]);
    }
    return y;
  }

  it("laesst einen Tipp ein Tipp sein: unter der Schwelle rollt nichts und nichts wird angehalten", () => {
    touch(el, "touchstart", [{ y: 100 }]);
    const move = touch(el, "touchmove", [{ y: 100 + SLOP_PX - 1 }]);
    touch(el, "touchend", []);

    expect(scrolled).toEqual([]);
    expect(move.defaultPrevented).toBe(false);
  });

  it("holt mit dem Finger nach unten aeltere Zeilen, eine je Zeilenhoehe, ohne Sprung um die Schwelle", () => {
    touch(el, "touchstart", [{ y: 100 }]);
    const first = touch(el, "touchmove", [{ y: 100 + SLOP_PX + ROW }]);
    touch(el, "touchmove", [{ y: 100 + SLOP_PX + 3 * ROW }]);

    expect(rows()).toEqual([-1, -2]);
    expect(first.defaultPrevented).toBe(true);
  });

  it("holt mit dem Finger nach oben neuere Zeilen und nimmt Reste unter einer Zeile mit", () => {
    touch(el, "touchstart", [{ y: 300 }]);
    // Nach der Schwelle 2, 11 und 8 px: erst zusammen eine Zeile.
    touch(el, "touchmove", [{ y: 290 }]);
    touch(el, "touchmove", [{ y: 279 }]);
    expect(scrolled).toEqual([]);
    touch(el, "touchmove", [{ y: 271 }]);

    expect(rows()).toEqual([1]);
  });

  it("meldet die Stelle, an der der Finger aufsetzte, nicht die, an der er gerade ist", () => {
    touch(el, "touchstart", [{ y: 100, x: 42 }]);
    touch(el, "touchmove", [{ y: 160, x: 90 }]);

    expect(scrolled[0].origin).toEqual({ target: el, clientX: 42, clientY: 100 });
  });

  it("laeuft nach schnellem Loslassen in dieselbe Richtung aus und kommt zum Stehen", () => {
    // 20 px je 10 ms: 2 px/ms nach unten.
    const end = drag(100, 20, 6);
    touch(el, "touchend", []);
    const duringDrag = total();
    expect(duringDrag).toBe(-Math.trunc((end - 100 - SLOP_PX) / ROW));
    expect(time.pending()).toBe(1);

    for (let i = 0; i < 1000 && time.pending() > 0; i++) time.frame();

    expect(time.pending()).toBe(0);
    expect(rows().every((value) => value < 0)).toBe(true);
    // Rund Geschwindigkeit mal Zeitkonstante: 2 px/ms x 325 ms = 650 px.
    expect(total() - duringDrag).toBeLessThanOrEqual(-25);
    expect(total() - duringDrag).toBeGreaterThanOrEqual(-40);
  });

  it("wirft nichts, wenn der Finger vor dem Loslassen stehen blieb", () => {
    drag(100, 20, 6);
    time.advance(150);
    touch(el, "touchend", []);

    expect(time.pending()).toBe(0);
  });

  it("wirft nichts bei langsamem Zug", () => {
    // 2 px je 10 ms: 0,2 px/ms.
    drag(100, 2, 20);
    touch(el, "touchend", []);

    expect(time.pending()).toBe(0);
  });

  it("haelt einen Auslauf an, sobald ein Finger aufsetzt", () => {
    drag(100, 20, 6);
    touch(el, "touchend", []);
    time.frame();
    const before = total();

    touch(el, "touchstart", [{ y: 300 }]);
    time.frame();

    expect(time.pending()).toBe(0);
    expect(total()).toBe(before);
  });

  it("rollt nicht mit zwei Fingern", () => {
    touch(el, "touchstart", [{ y: 100 }, { y: 200 }]);
    touch(el, "touchmove", [{ y: 200 }, { y: 300 }]);

    expect(scrolled).toEqual([]);
  });

  it("bricht den Zug ab, wenn ein zweiter Finger dazukommt", () => {
    touch(el, "touchstart", [{ y: 100 }]);
    touch(el, "touchmove", [{ y: 140 }]);
    const before = total();
    touch(el, "touchstart", [{ y: 140 }, { y: 300 }]);
    touch(el, "touchmove", [{ y: 240 }]);

    expect(total()).toBe(before);
  });

  it("rollt nicht, nachdem langes Druecken das Menue geoeffnet hat", () => {
    touch(el, "touchstart", [{ y: 100 }]);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    touch(el, "touchmove", [{ y: 200 }]);

    expect(scrolled).toEqual([]);
  });

  it("rollt nicht, solange die Zeilenhoehe unbekannt ist", () => {
    const other = document.createElement("div");
    const seen: number[] = [];
    attachTouchScroll(other, { rowHeight: () => 0, scroll: (count) => seen.push(count) }, controller.signal, time.clock);

    touch(other, "touchstart", [{ y: 100 }]);
    touch(other, "touchmove", [{ y: 300 }]);

    expect(seen).toEqual([]);
  });

  it("meldet sich ueber das Signal ab und haelt einen laufenden Auslauf an", () => {
    drag(100, 20, 6);
    touch(el, "touchend", []);
    expect(time.pending()).toBe(1);
    const before = total();

    controller.abort();
    time.frame();
    touch(el, "touchstart", [{ y: 100 }]);
    touch(el, "touchmove", [{ y: 300 }]);

    expect(time.pending()).toBe(0);
    expect(total()).toBe(before);
  });
});
