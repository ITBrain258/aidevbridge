import { afterEach, describe, expect, it, vi } from "vitest";
import { focusableElements } from "./dialog";
import { mountSidebarResize, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "./sidebar-resize";

/** Baut den Griff in einen Behaelter unter einem eigenen Ziel -- wie in der
 * App, wo er in `#sidebar` haengt und das Token an `#app` setzt. */
function setup(onInput?: (width: number) => void) {
  const target = document.createElement("div");
  const container = document.createElement("div");
  target.appendChild(container);
  document.body.appendChild(target);
  const onCommit = vi.fn();
  const resize = mountSidebarResize(container, { target, onCommit, onInput });
  const handle = container.querySelector<HTMLElement>(".sb-resize")!;
  // jsdom kennt keine Zeigererfassung: `setPointerCapture` fehlt dort ganz,
  // und der Griff ruft sie beim Druecken. Im Browser leitet sie jedes
  // folgende Zeigerereignis an den Griff -- darum schicken die Tests sie dort
  // hin.
  const capture = vi.fn();
  handle.setPointerCapture = capture;
  return { target, container, handle, onCommit, resize, capture };
}

function token(target: HTMLElement): string {
  return target.style.getPropertyValue("--ab-sidebar-w");
}

function pointer(handle: HTMLElement, type: string, clientX: number, init: PointerEventInit = {}): PointerEvent {
  // Waehrend eines Zugs ist die Haupttaste gedrueckt (`buttons` 1), beim
  // Loslassen und danach nicht mehr -- wie im Browser.
  const buttons = type === "pointerdown" || type === "pointermove" ? 1 : 0;
  const event = new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons, pointerId: 1, clientX, ...init,
  });
  handle.dispatchEvent(event);
  return event;
}

function key(handle: HTMLElement, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  handle.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Ziehgriff der Seitenleiste (UX-Spec §7.8)", () => {
  // Untergrenze 208 statt der 200 aus der Spec (Aufgabe 19, Fixrunde 2):
  // erst ab 208 px passt die Leiste eines verbundenen
  // Hosts auch mit Scrollbalken in eine Zeile.
  it("startet bei 240 innerhalb der Grenzen 208 bis 480", () => {
    expect([SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX]).toEqual([208, 240, 480]);
  });

  it("ist ein senkrechter Trenner mit Namen, Wert und Grenzen und ein eigener Tabstopp", () => {
    const { container, handle } = setup();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize sidebar");
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    expect(handle.getAttribute("aria-valuemin")).toBe("208");
    expect(handle.getAttribute("aria-valuemax")).toBe("480");
    expect(handle.tabIndex).toBe(0);
    expect(focusableElements(container)).toEqual([handle]);
  });

  it("Ziehen von 240 auf 300: nur das Token folgt, gemeldet wird genau einmal beim Loslassen", () => {
    const { target, handle, onCommit, capture } = setup();
    const down = pointer(handle, "pointerdown", 500);
    expect(capture).toHaveBeenCalledExactlyOnceWith(1);
    // Kein Markieren und kein Fokussprung, waehrend die Maus zieht.
    expect(down.defaultPrevented).toBe(true);

    pointer(handle, "pointermove", 530);
    expect(token(target)).toBe("270px");
    pointer(handle, "pointermove", 560);
    expect(token(target)).toBe("300px");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(onCommit).not.toHaveBeenCalled();

    // Der Browser schickt beim Loslassen beide: erst `pointerup`, dann
    // `lostpointercapture`. Gemeldet wird trotzdem nur einmal.
    pointer(handle, "pointerup", 560);
    pointer(handle, "lostpointercapture", 0);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(300);
    expect(token(target)).toBe("300px");
  });

  it("meldet jede neue Breite schon waehrend des Zugs ueber onInput, vermessen wird beim Loslassen (Spec 2026-10-19 §4.5)", () => {
    const onInput = vi.fn();
    const { handle, onCommit } = setup(onInput);
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 530);
    expect(onInput).toHaveBeenLastCalledWith(270);
    // Dieselbe Breite meldet nichts.
    pointer(handle, "pointermove", 530);
    expect(onInput).toHaveBeenCalledTimes(1);
    pointer(handle, "pointermove", 560);
    expect(onInput).toHaveBeenLastCalledWith(300);
    expect(onCommit).not.toHaveBeenCalled();
    pointer(handle, "pointerup", 560);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(300);
  });

  it("nimmt beim Loslassen die Lage des Loslassens", () => {
    const { target, handle, onCommit } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 520);
    pointer(handle, "pointerup", 540);
    expect(token(target)).toBe("280px");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(280);
  });

  it("klemmt beim Ziehen auf 208 bis 480 und auf ganze Pixel", () => {
    const { target, handle, onCommit } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 100);
    expect(token(target)).toBe("208px");
    expect(handle.getAttribute("aria-valuenow")).toBe("208");
    // 240 - 36 = 204 liegt unter der Grenze.
    pointer(handle, "pointermove", 464);
    expect(token(target)).toBe("208px");
    pointer(handle, "pointermove", 900);
    expect(token(target)).toBe("480px");
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    pointer(handle, "pointermove", 520.4);
    expect(token(target)).toBe("260px");
    pointer(handle, "pointerup", 520.6);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(261);
  });

  it("ein Zug, der die Breite nicht aendert, meldet nichts", () => {
    const { handle, onCommit } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 530);
    pointer(handle, "pointermove", 500);
    pointer(handle, "pointerup", 500);
    pointer(handle, "lostpointercapture", 0);
    expect(onCommit).not.toHaveBeenCalled();
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
  });

  it("schliesst den Zug auch ab, wenn nur die Erfassung verloren geht", () => {
    const { handle, onCommit } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 548);
    pointer(handle, "lostpointercapture", 0);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(288);
    // Danach zieht eine Bewegung ohne neuen Druck nichts mehr mit.
    pointer(handle, "pointermove", 700);
    pointer(handle, "pointerup", 700);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(handle.getAttribute("aria-valuenow")).toBe("288");
  });

  it("zieht nur mit der linken Taste und nur mit dem Zeiger, der gedrueckt hat", () => {
    const { target, handle, onCommit, capture } = setup();
    pointer(handle, "pointerdown", 500, { button: 2, buttons: 2 });
    pointer(handle, "pointermove", 560, { button: -1, buttons: 2 });
    expect(capture).not.toHaveBeenCalled();
    expect(token(target)).toBe("");

    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 600, { pointerId: 2 });
    expect(token(target)).toBe("");
    pointer(handle, "pointerup", 600, { pointerId: 2 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Doppelklick setzt 240 zurueck und meldet einmal; bei 240 meldet er nichts", () => {
    const { target, handle, onCommit, resize } = setup();
    resize.setWidth(320);
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(token(target)).toBe("240px");
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(240);

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("Pfeiltasten aendern um 16 px, Pos1 setzt 240; jede Taste meldet einmal", () => {
    const { target, handle, onCommit } = setup();
    expect(key(handle, "ArrowRight").defaultPrevented).toBe(true);
    expect(token(target)).toBe("256px");
    key(handle, "ArrowRight");
    expect(token(target)).toBe("272px");
    expect(handle.getAttribute("aria-valuenow")).toBe("272");
    key(handle, "ArrowLeft");
    expect(token(target)).toBe("256px");
    expect(key(handle, "Home").defaultPrevented).toBe(true);
    expect(token(target)).toBe("240px");
    expect(onCommit.mock.calls).toEqual([[256], [272], [256], [240]]);
  });

  it("Tasten bleiben in den Grenzen; eine Taste ohne Wirkung meldet nichts", () => {
    const { target, handle, onCommit, resize } = setup();
    resize.setWidth(472);
    key(handle, "ArrowRight");
    expect(token(target)).toBe("480px");
    key(handle, "ArrowRight");
    expect(token(target)).toBe("480px");
    // Von 240 aus treffen die 16-px-Schritte genau 224 und die Grenze 208.
    resize.setWidth(240);
    key(handle, "ArrowLeft");
    expect(token(target)).toBe("224px");
    key(handle, "ArrowLeft");
    expect(token(target)).toBe("208px");
    key(handle, "ArrowLeft");
    expect(token(target)).toBe("208px");
    // Ein Schritt ueber die Grenze hinaus landet auf ihr.
    resize.setWidth(216);
    key(handle, "ArrowLeft");
    expect(token(target)).toBe("208px");
    resize.setWidth(240);
    key(handle, "Home");
    expect(onCommit.mock.calls).toEqual([[480], [224], [208], [208]]);
  });

  it("laesst Tasten mit Umschalt, Strg, Alt oder Meta und alle anderen Tasten durch", () => {
    const { target, handle, onCommit } = setup();
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(key(handle, "ArrowRight", init).defaultPrevented).toBe(false);
    }
    expect(key(handle, "End").defaultPrevented).toBe(false);
    expect(key(handle, "ArrowUp").defaultPrevented).toBe(false);
    expect(token(target)).toBe("");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("setWidth wendet einen gespeicherten Wert an, ohne zu melden, und klemmt ihn", () => {
    const { target, handle, onCommit, resize } = setup();
    expect(resize.setWidth(300)).toBe(true);
    expect(token(target)).toBe("300px");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(resize.setWidth(300)).toBe(false);
    expect(resize.setWidth(1000)).toBe(true);
    expect(token(target)).toBe("480px");
    expect(resize.setWidth(150.6)).toBe(true);
    expect(token(target)).toBe("208px");
    // Rust laesst 200 bis 207 stehen; gezeigt wird die Grenze 208.
    resize.setWidth(300);
    expect(resize.setWidth(200)).toBe(true);
    expect(token(target)).toBe("208px");
    expect(handle.getAttribute("aria-valuenow")).toBe("208");
    expect(resize.setWidth(207)).toBe(false);
    resize.setWidth(301.4);
    expect(token(target)).toBe("301px");
    expect(onCommit).not.toHaveBeenCalled();

    // Ein Zug danach rechnet vom angewandten Wert aus.
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointerup", 510);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(311);
  });

  it("setHidden blendet den Griff aus und nimmt ihn aus der Tab-Folge", () => {
    const { container, handle, resize } = setup();
    resize.setHidden(true);
    expect(handle.hidden).toBe(true);
    expect(focusableElements(container)).toEqual([]);
    resize.setHidden(false);
    expect(handle.hidden).toBe(false);
    expect(focusableElements(container)).toEqual([handle]);
  });

  // Fixrunde 3 (B, nimmt Fixrunde 1 H zurueck): ein Zug mit der Maus laesst den
  // Fokus, wo er war -- meist im Terminal, das danach weiter die Tastendruecke
  // bekommt. Die Tastatur erreicht den Griff ueber den Tabulator.
  it("laesst den Fokus beim Ziehen, wo er war", () => {
    const { target, handle, onCommit } = setup();
    const elsewhere = document.createElement("textarea");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    pointer(handle, "pointerdown", 500);
    expect(document.activeElement).toBe(elsewhere);
    pointer(handle, "pointermove", 540);
    pointer(handle, "pointerup", 540);
    expect(document.activeElement).toBe(elsewhere);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(280);

    // Mit Fokus aus dem Tabulator wirken die Pfeiltasten.
    handle.focus();
    key(handle, "ArrowRight");
    expect(token(target)).toBe("296px");
  });

  it("traegt die Klasse sb-resize--dragging genau waehrend des Zugs", () => {
    const { handle } = setup();
    expect(handle.classList.contains("sb-resize--dragging")).toBe(false);
    pointer(handle, "pointerdown", 500);
    expect(handle.classList.contains("sb-resize--dragging")).toBe(true);
    pointer(handle, "pointermove", 520);
    expect(handle.classList.contains("sb-resize--dragging")).toBe(true);
    pointer(handle, "pointerup", 520);
    expect(handle.classList.contains("sb-resize--dragging")).toBe(false);
  });

  // Fixrunde 1, G: ohne die Wache gegen einen zweiten Druck uebernaehme der
  // zweite Zeiger den Zug, und der erste fiele ins Leere -- sein Loslassen
  // meldete nichts.
  it("ignoriert einen zweiten Druck waehrend eines Zugs", () => {
    const { target, handle, onCommit, capture } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 560);
    pointer(handle, "pointerdown", 700, { pointerId: 2 });
    expect(capture).toHaveBeenCalledExactlyOnceWith(1);
    pointer(handle, "pointermove", 580);
    expect(token(target)).toBe("320px");
    pointer(handle, "pointerup", 580);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(320);
  });

  // Fixrunde 1, D: ein Loslassen, dessen `pointerup` nie ankam, liesse den Zug
  // sonst stehen -- jede spaetere Bewegung zoege die Leiste weiter.
  it("beendet den Zug, sobald eine Bewegung ohne gedrueckte Haupttaste kommt", () => {
    const { target, handle, onCommit } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 548);
    pointer(handle, "pointermove", 600, { buttons: 0 });
    // Die Bewegung nach dem Loslassen gehoert nicht mehr zum Zug.
    expect(token(target)).toBe("288px");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(288);
    expect(handle.classList.contains("sb-resize--dragging")).toBe(false);

    pointer(handle, "pointermove", 700, { buttons: 1 });
    pointer(handle, "pointerup", 700);
    pointer(handle, "lostpointercapture", 0);
    expect(token(target)).toBe("288px");
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("beginnt keinen Zug, wenn die Zeigererfassung scheitert", () => {
    const { target, handle, onCommit, capture } = setup();
    capture.mockImplementation(() => {
      throw new DOMException("no active pointer", "NotFoundError");
    });
    pointer(handle, "pointerdown", 500);
    expect(handle.classList.contains("sb-resize--dragging")).toBe(false);
    pointer(handle, "pointermove", 560);
    pointer(handle, "pointerup", 560);
    expect(token(target)).toBe("");
    expect(onCommit).not.toHaveBeenCalled();
  });

  // Fixrunde 1, D: Einklappen waehrend eines Zugs beendet ihn. Gemeldet wird
  // die Breite, die eben noch zu sehen war -- dieselbe erscheint beim
  // Aufklappen wieder; ein spaeteres Loslassen meldet nichts mehr.
  it("setHidden(true) beendet einen laufenden Zug und meldet die zuletzt sichtbare Breite", () => {
    const { target, handle, onCommit, resize } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 532);
    resize.setHidden(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(272);
    expect(handle.classList.contains("sb-resize--dragging")).toBe(false);

    pointer(handle, "pointermove", 600);
    pointer(handle, "pointerup", 600);
    pointer(handle, "lostpointercapture", 0);
    expect(token(target)).toBe("272px");
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("setHidden(true) waehrend eines Zugs ohne Aenderung meldet nichts", () => {
    const { handle, onCommit, resize } = setup();
    pointer(handle, "pointerdown", 500);
    resize.setHidden(true);
    pointer(handle, "pointerup", 540);
    expect(onCommit).not.toHaveBeenCalled();
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
  });
});
