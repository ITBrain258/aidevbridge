// Das Terminal ohne Scrollbalken: `FitWithoutScrollbar` rechnet die Spalten
// ueber die volle Breite, waehrend das echte `FitAddon` 14 px fuer den Balken
// abzieht. Getestet gegen das echte Addon mit einem nachgebauten Terminal,
// das nur hat, was das Addon liest; jsdom kennt Groessen nur aus `style`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { FitWithoutScrollbar } from "./terminal-fit";

interface FakeTerminal {
  element: HTMLElement;
  options: { scrollback: number };
  cols: number;
  rows: number;
  resize: ReturnType<typeof vi.fn>;
  _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } }; clear(): void } };
}

/** Ein Container 400 x 300 px, Zellen 8 x 17 px. */
function fakeTerminal(cell = { width: 8, height: 17 }, padding = "0px"): FakeTerminal {
  const parent = document.createElement("div");
  parent.style.width = "400px";
  parent.style.height = "300px";
  const element = document.createElement("div");
  element.style.padding = padding;
  parent.appendChild(element);
  document.body.appendChild(parent);
  return {
    element,
    options: { scrollback: 5000 },
    cols: 80,
    rows: 24,
    resize: vi.fn(),
    _core: { _renderService: { dimensions: { css: { cell } }, clear: () => undefined } },
  };
}

function load<T extends FitAddon>(addon: T, term: FakeTerminal): T {
  addon.activate(term as unknown as Terminal);
  return addon;
}

describe("FitWithoutScrollbar", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("gibt die 14 px des Scrollbalkens den Spalten: 50 statt 48 bei 400 px und 8 px je Zelle", () => {
    const term = fakeTerminal();

    expect(load(new FitAddon(), term).proposeDimensions()).toEqual({ cols: 48, rows: 17 });
    expect(load(new FitWithoutScrollbar(), term).proposeDimensions()).toEqual({ cols: 50, rows: 17 });
  });

  it("zieht den Innenabstand des Terminals ab wie das Addon", () => {
    const term = fakeTerminal({ width: 8, height: 17 }, "0px 4px");

    expect(load(new FitWithoutScrollbar(), term).proposeDimensions()).toEqual({ cols: 49, rows: 17 });
  });

  it("schlaegt nichts vor, solange xterm keine Zellgroesse kennt", () => {
    const term = fakeTerminal({ width: 0, height: 0 });

    expect(load(new FitWithoutScrollbar(), term).proposeDimensions()).toBeUndefined();
  });

  it("stellt das Terminal mit fit() auf die volle Breite", () => {
    const term = fakeTerminal();

    load(new FitWithoutScrollbar(), term).fit();

    expect(term.resize).toHaveBeenCalledWith(50, 17);
  });
});
