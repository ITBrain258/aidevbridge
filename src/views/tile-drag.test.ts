import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackPointerDrag } from "./tile-drag";

function handlers() {
  return { start: vi.fn(), move: vi.fn(), end: vi.fn(), cancel: vi.fn() };
}

function pointer(target: Element, type: string, clientX: number, clientY = 0, buttons?: number): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: buttons ?? (type === "pointerdown" || type === "pointermove" ? 1 : 0),
    pointerId: 1,
    clientX,
    clientY,
  });
  target.dispatchEvent(event);
  return event;
}

let handle: HTMLElement;

beforeEach(() => {
  handle = document.createElement("div");
  // jsdom kennt keine Zeigererfassung (wie in sidebar-resize.test.ts).
  handle.setPointerCapture = vi.fn();
  document.body.appendChild(handle);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("trackPointerDrag (Spec 2026-10-19 §4.4, §5.4)", () => {
  it("beginnt erst ab der Schwelle; davor bleibt es ein Klick", () => {
    const h = handlers();
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 4, h);
    pointer(handle, "pointermove", 12, 11);
    expect(h.start).not.toHaveBeenCalled();
    pointer(handle, "pointerup", 12, 11);
    expect(h.end).not.toHaveBeenCalled();
  });

  it("meldet Start, Bewegung und Ende mit dem Weg seit dem Druecken", () => {
    const h = handlers();
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 4, h);
    pointer(handle, "pointermove", 20, 10);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.move).toHaveBeenLastCalledWith(expect.any(PointerEvent), 10, 0);
    pointer(handle, "pointerup", 30, 15);
    expect(h.end).toHaveBeenCalledWith(expect.any(PointerEvent), 20, 5);
    // Nach dem Ende bewegt nichts mehr.
    pointer(handle, "pointermove", 50, 15);
    expect(h.move).toHaveBeenCalledTimes(1);
  });

  it("Esc bricht einen laufenden Zug ab und gehoert dann dem Zug", () => {
    const h = handlers();
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 0, h);
    pointer(handle, "pointermove", 40, 10);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    pointer(handle, "pointerup", 40, 10);
    expect(h.end).not.toHaveBeenCalled();
  });

  it("Esc vor dem Start bleibt frei", () => {
    const h = handlers();
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 4, h);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("pointercancel vor dem Start meldet nichts und beendet die Verfolgung", () => {
    const h = handlers();
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 4, h);
    pointer(handle, "pointercancel", 11, 10);
    pointer(handle, "pointermove", 40, 10);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("Esc im Zug erreicht kein Feld im Dokument, danach wieder", () => {
    const h = handlers();
    // Etwa das Hilfstextfeld von xterm: ihm soll der Esc des Zugs nicht ins Terminal laufen.
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    const seen = vi.fn();
    field.addEventListener("keydown", seen);
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 0, h);
    pointer(handle, "pointermove", 40, 10);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("pointercancel, Verlust der Erfassung und eine losgelassene Taste brechen ab", () => {
    for (const finish of [
      () => pointer(handle, "pointercancel", 40, 10),
      () => handle.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 })),
      () => pointer(handle, "pointermove", 45, 10, 0),
    ]) {
      const h = handlers();
      trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 0, h);
      pointer(handle, "pointermove", 40, 10);
      finish();
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(h.end).not.toHaveBeenCalled();
    }
  });

  it("ohne Zeigererfassung gibt es keinen Zug", () => {
    const h = handlers();
    handle.setPointerCapture = () => {
      throw new Error("no capture");
    };
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 0, h);
    pointer(handle, "pointermove", 40, 10);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("verschwindet der Griff mitten im Zug, bricht der Verlust der Erfassung am Dokument ihn ab", () => {
    const h = handlers();
    trackPointerDrag(handle, pointer(handle, "pointerdown", 10, 10), 0, h);
    pointer(handle, "pointermove", 40, 10);
    // Etwa Strg+Umschalt+W waehrend des Zugs: die Kachel samt Kopf geht.
    // Der Browser schickt `lostpointercapture` dann an das Dokument.
    handle.remove();
    document.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 2 }));
    expect(h.cancel).not.toHaveBeenCalled();
    document.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }));
    expect(h.cancel).toHaveBeenCalledTimes(1);
    // Danach gehoert Esc nicht mehr dem Zug.
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });
});
