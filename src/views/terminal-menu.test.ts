// Terminalmenue (UX-Spec §6.3): Aufbau, Tastatur, Schliessen und Lage. Echte
// DOM-Ereignisse unter jsdom. Layout kennt jsdom nicht (jede Box ist 0 gross,
// siehe `menu-position.ts`), die Lage wird deshalb ueber die reine Funktion
// und eine gestubbte Messung des Menues geprueft.

import css from "../styles.css?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openTerminalMenu,
  placeTerminalMenu,
  type TerminalMenuItem,
  type TerminalMenuOptions,
} from "./terminal-menu";

const ITEMS: TerminalMenuItem[] = [
  { id: "copy", label: "Copy", shortcut: "Ctrl+C" },
  { id: "paste", label: "Paste", shortcut: "Ctrl+V" },
  { id: "selectAll", label: "Select all" },
  { id: "find", label: "Find…", shortcut: "Ctrl+Shift+F" },
];

const openMenus: Array<{ close(): void }> = [];

function open(over: Partial<TerminalMenuOptions> = {}) {
  const onSelect = vi.fn<(id: TerminalMenuItem["id"]) => void>();
  const onClose = vi.fn<() => void>();
  const handle = openTerminalMenu({ x: 100, y: 80, items: ITEMS, onSelect, onClose, ...over });
  openMenus.push(handle);
  return { handle, onSelect, onClose };
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".terminal-menu");
}

function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function itemByLabel(label: string): HTMLElement {
  const found = items().find((i) => i.querySelector(".terminal-menu-label")?.textContent === label);
  if (!found) throw new Error(`Eintrag "${label}" fehlt`);
  return found;
}

function press(key: string, target: Element | null = document.activeElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target?.dispatchEvent(event);
  return event;
}

function outsideInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  return input;
}

const realViewport = { width: window.innerWidth, height: window.innerHeight };

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
}

/** jsdom misst jede Box mit 0. Nur das Menue bekommt hier eine Groesse. */
function stubMenuSize(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const isMenu = this.classList.contains("terminal-menu");
    return {
      x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0,
      width: isMenu ? width : 0,
      height: isMenu ? height : 0,
      toJSON: () => ({}),
    };
  });
}

beforeEach(() => {
  setViewport(realViewport.width, realViewport.height);
});

afterEach(() => {
  openMenus.splice(0).forEach((handle) => handle.close());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  setViewport(realViewport.width, realViewport.height);
});

describe("openTerminalMenu: Aufbau", () => {
  it("baut die Eintraege in der uebergebenen Reihenfolge mit Beschriftung", () => {
    open();

    expect(items().map((i) => i.querySelector(".terminal-menu-label")?.textContent)).toEqual([
      "Copy", "Paste", "Select all", "Find…",
    ]);
  });

  it("nennt ein Kuerzel nur, wo eines uebergeben wurde", () => {
    open();

    expect(items().map((i) => i.querySelector(".terminal-menu-shortcut")?.textContent ?? null)).toEqual([
      "Ctrl+C", "Ctrl+V", null, "Ctrl+Shift+F",
    ]);
  });

  it("haengt an body, ist ein Menue und teilt Huelle und Eintragsoptik mit dem Hostmenue", () => {
    open();

    expect(menu()?.parentElement).toBe(document.body);
    expect(menu()?.querySelectorAll('[role="menu"]')).toHaveLength(1);
    // Huelle und Eintragsoptik teilt es mit dem Hostmenue der Seitenleiste.
    expect(menu()?.classList.contains("sb-menu")).toBe(true);
    for (const entry of items()) expect(entry.classList.contains("sb-menu-item")).toBe(true);
  });

  it("zeigt die Hinweiszeile unter den Eintraegen und macht sie nicht zum Menueeintrag", () => {
    open({ hint: "Shift+drag selects text while a program uses the mouse" });

    const hint = menu()?.querySelector<HTMLElement>(".terminal-menu-hint");
    expect(hint?.textContent).toBe("Shift+drag selects text while a program uses the mouse");
    expect(items()).toHaveLength(4);
    expect(hint?.getAttribute("role")).toBeNull();
    // Unter den Eintraegen, nicht darin: ein Hinweis ist kein Kind von role=menu.
    expect(menu()?.querySelector('[role="menu"]')?.contains(hint ?? null)).toBe(false);
    expect(hint?.previousElementSibling).toBe(menu()?.querySelector('[role="menu"]'));
  });

  it("baut ohne Hinweis keine Hinweiszeile", () => {
    open();

    expect(menu()?.querySelector(".terminal-menu-hint")).toBeNull();
  });

  // Die Rueckfrage vor einem Link zeigt dessen volles Ziel ueber den
  // Eintraegen.
  it("zeigt die Kopfzeile ueber den Eintraegen, macht sie nicht zum Eintrag und benennt damit die Liste", () => {
    open({ heading: "https://evil.example/login" });

    const heading = menu()?.querySelector<HTMLElement>(".terminal-menu-heading");
    const list = menu()?.querySelector('[role="menu"]');
    expect(heading?.textContent).toBe("https://evil.example/login");
    expect(heading?.nextElementSibling).toBe(list);
    expect(list?.contains(heading ?? null)).toBe(false);
    expect(list?.getAttribute("aria-label")).toBe("https://evil.example/login");
    expect(items()).toHaveLength(4);
  });

  it("baut ohne Kopf keine Kopfzeile und keinen Listennamen", () => {
    open();

    expect(menu()?.querySelector(".terminal-menu-heading")).toBeNull();
    expect(menu()?.querySelector('[role="menu"]')?.hasAttribute("aria-label")).toBe(false);
  });

  it("kennzeichnet deaktivierte Eintraege mit aria-disabled", () => {
    open({ items: ITEMS.map((i) => (i.id === "copy" ? { ...i, disabled: true } : i)) });

    expect(items().map((i) => i.getAttribute("aria-disabled"))).toEqual(["true", null, null, null]);
  });
});

describe("openTerminalMenu: Fokus und Tastatur", () => {
  it("fokussiert den ersten Eintrag; genau einer ist per Tabulator ansteuerbar", () => {
    open();

    expect(document.activeElement).toBe(items()[0]);
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
  });

  it("fokussiert den ersten AKTIVEN Eintrag, wenn Copy deaktiviert ist", () => {
    open({ items: ITEMS.map((i) => (i.id === "copy" ? { ...i, disabled: true } : i)) });

    expect(document.activeElement).toBe(itemByLabel("Paste"));
  });

  it("wandert mit den Pfeiltasten umlaufend durch die Eintraege", () => {
    open();

    press("ArrowDown");
    expect(document.activeElement).toBe(itemByLabel("Paste"));
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(itemByLabel("Find…"));
    press("ArrowDown");
    expect(document.activeElement).toBe(itemByLabel("Copy"));
    press("ArrowUp");
    expect(document.activeElement).toBe(itemByLabel("Find…"));
    expect(items().filter((i) => i.tabIndex === 0)).toEqual([itemByLabel("Find…")]);
  });

  it("geht an deaktivierten Eintraegen vorbei, auch beim Umlauf", () => {
    open({ items: ITEMS.map((i) => (i.id === "copy" ? { ...i, disabled: true } : i)) });

    press("ArrowUp"); // von Paste (erster aktiver) rueckwaerts: Copy ueberspringen
    expect(document.activeElement).toBe(itemByLabel("Find…"));
    press("ArrowDown"); // vorwaerts umlaufend: wieder Paste, nicht Copy
    expect(document.activeElement).toBe(itemByLabel("Paste"));
  });

  it("Pos1 und Ende springen an den ersten und den letzten aktiven Eintrag", () => {
    open();

    press("End");
    expect(document.activeElement).toBe(itemByLabel("Find…"));
    press("Home");
    expect(document.activeElement).toBe(itemByLabel("Copy"));
  });

  it("findet nach einem Klick auf die Hinweiszeile mit den Pfeilen zurueck", () => {
    open({ hint: "hint" });
    // Ein Klick auf nichts Fokussierbares fokussiert die Huelle (tabindex -1);
    // der Fokus bleibt damit im Menue, und es schliesst nicht.
    menu()?.focus();
    expect(menu()).not.toBeNull();

    press("ArrowDown", menu());
    expect(document.activeElement).toBe(itemByLabel("Copy"));
    menu()?.focus();
    press("ArrowUp", menu());
    expect(document.activeElement).toBe(itemByLabel("Find…"));
  });

  it("Enter waehlt den fokussierten Eintrag und verhindert die Standardaktion", () => {
    const { onSelect } = open();
    press("ArrowDown");

    const event = press("Enter");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("paste");
    // Ohne preventDefault klickte Chromium den Knopf zusaetzlich nativ.
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
  });

  it("die Leertaste waehlt ebenfalls", () => {
    const { onSelect } = open();
    press("End");

    press(" ");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("find");
  });

  it("Enter auf einem deaktivierten Eintrag wirkt nicht und laesst das Menue offen", () => {
    const { onSelect, onClose } = open({
      items: ITEMS.map((i) => (i.id === "copy" ? { ...i, disabled: true } : i)),
    });
    // Per Mausklick kann ein deaktivierter Eintrag den Fokus bekommen.
    itemByLabel("Copy").focus();

    press("Enter");

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("Escape schliesst, verhindert die Standardaktion und erreicht das Dokument nicht", () => {
    const { onClose } = open();
    const atDocument = vi.fn();
    document.addEventListener("keydown", atDocument);

    const event = press("Escape");
    document.removeEventListener("keydown", atDocument);

    expect(menu()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    // main.ts haengt einen dauerhaften Dokument-Horcher, der eine maximierte
    // Kachel zurueckholt: ohne stopPropagation holte dasselbe Escape sie.
    expect(atDocument).not.toHaveBeenCalled();
  });

  it("Tab schliesst und wird verschluckt", () => {
    const { onClose } = open();

    const event = press("Tab");

    expect(menu()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    // Der Aufrufer legt den Fokus bei onClose ins Terminal; liesse das Menue
    // den Tabulator durch, zoege der Browser ihn von dort sofort weiter.
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("openTerminalMenu: Waehlen", () => {
  it("ein Klick schliesst zuerst und handelt danach", () => {
    const order: string[] = [];
    open({
      onClose: () => order.push("close"),
      onSelect: (id) => order.push(`select:${id}`),
    });

    itemByLabel("Select all").click();

    // Zuerst schliessen: onClose gibt den Fokus ans Terminal, und "Find…"
    // nimmt ihn danach fuer sein Eingabefeld.
    expect(order).toEqual(["close", "select:selectAll"]);
    expect(menu()).toBeNull();
  });

  it("ein Klick auf einen deaktivierten Eintrag wirkt nicht und laesst das Menue offen", () => {
    const { onSelect, onClose } = open({
      items: ITEMS.map((i) => (i.id === "copy" ? { ...i, disabled: true } : i)),
    });

    itemByLabel("Copy").click();

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("waehlt hoechstens einmal, auch wenn nach Enter noch ein Klick eintrifft", () => {
    const { onSelect } = open();
    const paste = itemByLabel("Paste");
    press("ArrowDown");

    press("Enter");
    paste.click();

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("paste");
  });

  // Eine Rueckfrage kann unter dem Zeiger liegen (siehe den hohen Fall bei
  // `placeTerminalMenu` unten): Mit `armDelayMs` gehoeren Klick, Enter und
  // Leertaste kurz nach dem Oeffnen noch zur Geste, die sie oeffnete.
  it("waehlt mit armDelayMs erst nach dieser Zeit: Klick, Enter und Leertaste davor wirken nicht, das Menue bleibt offen", () => {
    vi.useFakeTimers();
    try {
      const { onSelect, onClose } = open({ armDelayMs: 500 });

      itemByLabel("Copy").click();
      press("Enter");
      press(" ");
      vi.advanceTimersByTime(499);
      itemByLabel("Copy").click();

      expect(onSelect).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(menu()).not.toBeNull();

      vi.advanceTimersByTime(1);
      itemByLabel("Copy").click();

      expect(onSelect).toHaveBeenCalledExactlyOnceWith("copy");
      expect(menu()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("openTerminalMenu: Schliessen", () => {
  function mouseDown(target: Element): void {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  }

  it("schliesst bei einem Mausdruck ausserhalb", () => {
    const { onClose } = open();

    mouseDown(outsideInput());

    expect(menu()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("schliesst auch bei einem Rechtsklick ausserhalb, bevor ein neues Menue entsteht", () => {
    open();

    outsideInput().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));

    expect(menu()).toBeNull();
  });

  it("schliesst NICHT bei einem Mausdruck im Menue, auch nicht auf der Hinweiszeile", () => {
    open({ hint: "hint" });

    mouseDown(itemByLabel("Paste"));
    mouseDown(menu()!.querySelector(".terminal-menu-hint")!);
    mouseDown(menu()!);

    expect(menu()).not.toBeNull();
  });

  it("sieht den Mausdruck auch dann, wenn ein Vorfahre die Weitergabe stoppt", () => {
    // Genau das tut `terminal.ts` fuer die rechte Taste am Terminalcontainer.
    open();
    const container = document.createElement("div");
    container.addEventListener("mousedown", (e) => e.stopPropagation());
    const inner = document.createElement("div");
    container.appendChild(inner);
    document.body.appendChild(container);

    mouseDown(inner);

    expect(menu()).toBeNull();
  });

  it("schliesst, wenn der Fokus an ein Element ausserhalb wandert", () => {
    const { onClose } = open();

    outsideInput().focus();

    expect(menu()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("schliesst NICHT, wenn der Fokus nur zwischen den Eintraegen wandert", () => {
    open();

    press("ArrowDown");
    press("ArrowDown");
    menu()?.focus();

    expect(menu()).not.toBeNull();
  });

  it("schliesst beim Mausrad ausserhalb, nicht im Menue", () => {
    open();
    const wheel = (target: Element) =>
      target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));

    wheel(itemByLabel("Copy"));
    expect(menu()).not.toBeNull();
    wheel(document.body);
    expect(menu()).toBeNull();
  });

  it("schliesst bei einer Groessenaenderung des Fensters", () => {
    open();

    window.dispatchEvent(new Event("resize"));

    expect(menu()).toBeNull();
  });

  it("close() von aussen ruft onClose genau einmal und ist danach harmlos", () => {
    const { handle, onClose } = open();

    handle.close();
    handle.close();
    window.dispatchEvent(new Event("resize"));

    expect(menu()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("meldet seine Lauscher an Dokument und Fenster beim Schliessen wieder ab", () => {
    // `window` ist unter vitest `globalThis` und traegt `addEventListener` als
    // EIGENE Eigenschaft (siehe sidebar.test.ts) -- beide Ziele einzeln.
    type Call = [type: string, listener: unknown, capture: boolean];
    const capture = (options: unknown): boolean =>
      typeof options === "boolean" ? options : Boolean((options as { capture?: boolean } | undefined)?.capture);
    const record = (target: EventTarget) => {
      const added: Call[] = [];
      const removed: Call[] = [];
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
        added.push([type, listener, capture(options)]);
        add(type, listener, options);
      });
      vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, options) => {
        removed.push([type, listener, capture(options)]);
        remove(type, listener, options);
      });
      return { added, removed };
    };
    const atDocument = record(document);
    const atWindow = record(window);

    const { handle } = open();
    handle.close();

    expect(atDocument.added.length).toBeGreaterThan(0);
    expect(atWindow.added.length).toBeGreaterThan(0);
    for (const { added, removed } of [atDocument, atWindow]) {
      for (const call of added) expect(removed).toContainEqual(call);
    }
  });

  it("oeffnet auf dem Menue selbst kein Browsermenue", () => {
    open();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    menu()?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("openTerminalMenu: Lage", () => {
  it("setzt die Lage aus der Messung: rechts am Rand nach links geschoben", () => {
    setViewport(500, 400);
    stubMenuSize(200, 100);

    open({ x: 450, y: 60 });

    expect(menu()?.style.left).toBe("300px");
    expect(menu()?.style.top).toBe("60px");
  });

  it("klappt nach oben, wenn unter dem Zeiger kein Platz ist", () => {
    setViewport(500, 400);
    stubMenuSize(200, 100);

    open({ x: 50, y: 350 });

    expect(menu()?.style.left).toBe("50px");
    expect(menu()?.style.top).toBe("250px");
  });

  // Die ausgelieferte Regel ist der Grund, warum `left`/`top` wirken: ohne
  // `position: fixed` (aus `.sb-menu`) stuende das Menue am Ende von body im
  // Fluss und verschoebe das Layout, statt am Zeiger zu schweben.
  it("liegt laut ausgelieferter CSS ausserhalb des Flusses, ueber der klebenden Hostzeile und unter dem Dialog", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    try {
      open();

      const computed = getComputedStyle(menu()!);
      expect(computed.position).toBe("fixed");
      expect(Number(computed.zIndex)).toBeGreaterThan(1); // klebende Hostzeile
      expect(Number(computed.zIndex)).toBeLessThan(100); // Dialog-Ueberlagerung
    } finally {
      style.remove();
    }
  });
});

describe("placeTerminalMenu", () => {
  const size = { width: 200, height: 100 };

  it.each([
    ["passt unter den Zeiger: dort", { x: 50, y: 60 }, { width: 500, height: 400 }, { left: 50, top: 60 }],
    ["rechts zu knapp: so weit nach links, dass die rechte Kante am Rand liegt", { x: 450, y: 60 }, { width: 500, height: 400 }, { left: 300, top: 60 }],
    ["unten zu knapp: nach oben, die Unterkante am Zeiger", { x: 50, y: 350 }, { width: 500, height: 400 }, { left: 50, top: 250 }],
    ["rechts UND unten zu knapp", { x: 480, y: 390 }, { width: 500, height: 400 }, { left: 300, top: 290 }],
    ["nach oben geklappt, aber ueber dem Fensterrand: oben bei 0", { x: 50, y: 60 }, { width: 500, height: 100 }, { left: 50, top: 0 }],
    ["breiter als das Fenster: links bei 0", { x: 50, y: 60 }, { width: 150, height: 400 }, { left: 0, top: 60 }],
  ])("%s", (_name, pointer, viewport, expected) => {
    expect(placeTerminalMenu(pointer, size, viewport)).toEqual(expected);
  });

  // So hoch wird die Rueckfrage vor einem Link mit langem Ziel: Sie passt
  // weder unter noch ueber den Zeiger, bleibt oben bei 0 und liegt dann unter
  // ihm. Deshalb waehlt sie erst nach `armDelayMs`.
  it("haelt ein Menue, das weder unter noch ueber den Zeiger passt, oben bei 0, auch ueber dem Zeiger", () => {
    expect(placeTerminalMenu({ x: 200, y: 300 }, { width: 480, height: 352 }, { width: 1100, height: 568 })).toEqual({
      left: 200,
      top: 0,
    });
  });
});
