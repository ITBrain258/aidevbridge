// Wischen im Terminal (Spec 2026-10-27 §5.5). xterm.js 6 bringt die
// Touch-Geste von VS Code mit, haengt sie aber an kein Element: Ein Finger
// rollt dort nichts. Dieses Modul macht aus einem senkrechten Zug ganze Zeilen
// und laesst ein schnelles Loslassen auslaufen wie eine Android-Liste. Was eine
// Zeile bewirkt, entscheidet der Aufrufer (`TouchScrollSink.scroll` in
// `terminal.ts`).
//
// Ein Tipp bleibt ein Tipp: Erst ab `SLOP_PX` ist ein Zug Wischen. Ab dann
// unterdrueckt `preventDefault` die Mausereignisse, die der Browser sonst
// nachschoebe; ein Wischen oeffnet also weder die Tastatur, noch klickt es in
// tmux.

/** Ab dieser Strecke in CSS-Pixeln ist ein Zug Wischen statt Tipp (Android
 * nimmt 8 dp). */
export const SLOP_PX = 8;

/** Ab dieser Geschwindigkeit beim Loslassen (px/ms) laeuft die Bewegung aus. */
export const FLING_MIN_PX_PER_MS = 0.3;

/** Zeitkonstante des Auslaufs in ms: In dieser Zeit faellt die
 * Geschwindigkeit auf rund ein Drittel (1/e). */
export const FLING_DECAY_MS = 325;

/** Darunter (px/ms) endet der Auslauf. */
const FLING_STOP_PX_PER_MS = 0.02;

/** Die Geschwindigkeit beim Loslassen misst nur die letzten so vielen ms des
 * Zugs: Ein Finger, der vor dem Loslassen stehen blieb, wirft nichts. */
const VELOCITY_WINDOW_MS = 100;

/** Wo der Finger aufsetzte. Dorthin richtet `terminal.ts` Mausrad-Ereignisse
 * fuer tmux, das daran den Bereich (Pane) waehlt, der rollt. */
export interface TouchOrigin {
  target: EventTarget | null;
  clientX: number;
  clientY: number;
}

export interface TouchScrollSink {
  /** Hoehe einer Zeile in CSS-Pixeln, gelesen, wenn ein Finger aufsetzt. */
  rowHeight(): number;
  /** Rollt um `rows` Zeilen: negativ zur aelteren Ausgabe (Finger nach
   * unten), positiv zur neueren. */
  scroll(rows: number, origin: TouchOrigin): void;
}

/** Uhr und Bildtakt; die Tests setzen eigene ein. */
export interface TouchScrollClock {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
}

const browserClock: TouchScrollClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(() => callback()),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

interface Gesture {
  origin: TouchOrigin;
  startY: number;
  lastY: number;
  rowHeight: number;
  /** Strecke unter einer Zeile, die noch keine ausgeloest hat. */
  rest: number;
  swiping: boolean;
  /** Die juengsten Positionen mit Zeit, fuer die Geschwindigkeit. */
  samples: Array<{ t: number; y: number }>;
}

/** Haengt das Wischen an `el`. `signal` meldet alles wieder ab und haelt einen
 * laufenden Auslauf an. */
export function attachTouchScroll(
  el: HTMLElement,
  sink: TouchScrollSink,
  signal: AbortSignal,
  clock: TouchScrollClock = browserClock,
): void {
  let gesture: Gesture | null = null;
  let frame: number | null = null;

  function stopFling(): void {
    if (frame !== null) clock.cancelFrame(frame);
    frame = null;
  }

  /** Rechnet eine Strecke in ganze Zeilen um; der Rest wartet auf die naechste. */
  function advance(g: Gesture, dy: number): void {
    g.rest += dy;
    const rows = Math.trunc(g.rest / g.rowHeight);
    if (rows === 0) return;
    g.rest -= rows * g.rowHeight;
    // Der Finger nach unten holt aeltere Zeilen herein, wie in jeder Liste.
    sink.scroll(-rows, g.origin);
  }

  function releaseVelocity(g: Gesture): number {
    const end = clock.now();
    const recent = g.samples.filter((sample) => end - sample.t <= VELOCITY_WINDOW_MS);
    if (recent.length < 2) return 0;
    const first = recent[0];
    const last = recent[recent.length - 1];
    if (last.t <= first.t) return 0;
    return (last.y - first.y) / (last.t - first.t);
  }

  function fling(g: Gesture, velocity: number): void {
    let v = velocity;
    let before = clock.now();
    const step = () => {
      const now = clock.now();
      const dt = now - before;
      before = now;
      advance(g, v * dt);
      v *= Math.exp(-dt / FLING_DECAY_MS);
      frame = Math.abs(v) < FLING_STOP_PX_PER_MS ? null : clock.requestFrame(step);
    };
    frame = clock.requestFrame(step);
  }

  el.addEventListener(
    "touchstart",
    (event) => {
      // Ein neuer Finger haelt einen Auslauf an, wie in jeder Liste.
      stopFling();
      gesture = null;
      // Zwei Finger sind keine Rollbewegung.
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const rowHeight = sink.rowHeight();
      if (rowHeight <= 0) return;
      gesture = {
        origin: { target: event.target, clientX: touch.clientX, clientY: touch.clientY },
        startY: touch.clientY,
        lastY: touch.clientY,
        rowHeight,
        rest: 0,
        swiping: false,
        samples: [],
      };
    },
    { passive: true, signal },
  );

  el.addEventListener(
    "touchmove",
    (event) => {
      const g = gesture;
      if (!g) return;
      if (event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const y = event.touches[0].clientY;
      if (!g.swiping) {
        if (Math.abs(y - g.startY) < SLOP_PX) return;
        g.swiping = true;
        // Ab der Schwelle rollt es, ohne um die Schwelle selbst zu springen.
        g.lastY = g.startY + Math.sign(y - g.startY) * SLOP_PX;
      }
      if (event.cancelable) event.preventDefault();
      const now = clock.now();
      g.samples.push({ t: now, y });
      while (g.samples.length > 0 && now - g.samples[0].t > VELOCITY_WINDOW_MS) g.samples.shift();
      advance(g, y - g.lastY);
      g.lastY = y;
    },
    { passive: false, signal },
  );

  el.addEventListener(
    "touchend",
    (event) => {
      const g = gesture;
      if (!g || event.touches.length > 0) return;
      gesture = null;
      if (!g.swiping) return;
      const velocity = releaseVelocity(g);
      if (Math.abs(velocity) >= FLING_MIN_PX_PER_MS) fling(g, velocity);
    },
    { signal },
  );

  el.addEventListener(
    "touchcancel",
    () => {
      gesture = null;
    },
    { signal },
  );

  // Langes Druecken oeffnet das Terminalmenue; was der Finger danach tut,
  // rollt nicht. Capture, weil `terminal.ts` das Ereignis am selben Element
  // anhaelt.
  el.addEventListener(
    "contextmenu",
    () => {
      if (gesture && !gesture.swiping) gesture = null;
    },
    { capture: true, signal },
  );

  signal.addEventListener("abort", stopFling, { once: true });
}
