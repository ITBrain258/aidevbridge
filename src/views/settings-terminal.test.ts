// Einstellungen, Bereich "Terminal" (UX-Spec §9.1): Karten "Text" (Schriftgroesse)
// und "Clipboard" (zwei Schalter, Rechtsklick). Der Bereich liest und schreibt
// `terminal-prefs`; was daraus folgt (Kacheln, settings.toml), macht main.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_PREFS, setTerminalPrefs, terminalPrefs } from "../terminal-prefs";
import { mountTerminalSection } from "./settings-terminal";

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = mountTerminalSection(container);
  return { container, handle };
}

/** Der Text des Elements, auf das `attribute` (eine Id) zeigt. */
function referencedText(el: Element, attribute: string): string | null {
  const id = el.getAttribute(attribute);
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
}

function switchNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')).find(
    (el) => referencedText(el, "aria-labelledby") === name,
  );
  if (!found) throw new Error(`switch not found: ${name}`);
  return found;
}

function stepper(container: HTMLElement) {
  const group = container.querySelector<HTMLElement>(".settings-stepper")!;
  const [decrease, increase] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
  return {
    group,
    decrease,
    increase,
    value: () => group.querySelector(".settings-stepper-value")?.textContent,
    reset: container.querySelector<HTMLButtonElement>(".settings-font-reset")!,
  };
}

function radio(container: HTMLElement, value: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
}

function choose(input: HTMLInputElement): void {
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  setTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("settings-terminal: Karten und Texte (UX-Spec §9.1)", () => {
  it("zwei Karten: Text und Clipboard", () => {
    const { container } = mount();

    expect(
      Array.from(container.querySelectorAll(".settings-card"), (card) => card.querySelector("h3.settings-card-title")?.textContent),
    ).toEqual(["Text", "Clipboard"]);
  });

  it("Font size: Stepper mit Wert, benannten Knoepfen, Reset und Hinweis", () => {
    const { container } = mount();
    const { group, decrease, increase, value, reset } = stepper(container);

    expect(referencedText(group, "aria-labelledby")).toBe("Font size");
    expect(group.getAttribute("role")).toBe("group");
    expect(value()).toBe("13");
    expect(decrease.getAttribute("aria-label")).toBe("Decrease font size");
    expect(increase.getAttribute("aria-label")).toBe("Increase font size");
    expect(reset.textContent).toBe("Reset");
    expect(referencedText(group, "aria-describedby")).toBe("Ctrl+mouse wheel or Ctrl+= / Ctrl+− / Ctrl+0 over a terminal.");
  });

  it("Clipboard: zwei Schalter mit den Standards, Rechtsklick als Segmentwahl, Hinweis zum Markieren", () => {
    const { container } = mount();

    expect(switchNamed(container, "Copy on select").getAttribute("aria-checked")).toBe("false");
    const ctrlCv = switchNamed(container, "Use Ctrl+C and Ctrl+V");
    expect(ctrlCv.getAttribute("aria-checked")).toBe("true");
    expect(referencedText(ctrlCv, "aria-describedby")).toBe(
      "Ctrl+C copies only when text is selected; otherwise it interrupts the program as usual.",
    );

    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(referencedText(group, "aria-labelledby")).toBe("Right click");
    expect(Array.from(group.querySelectorAll("label"), (label) => label.textContent)).toEqual(["Menu", "Copy/Paste"]);
    expect(radio(container, "menu").checked).toBe(true);
    expect(radio(container, "paste").checked).toBe(false);

    const cards = container.querySelectorAll(".settings-card");
    expect(cards[1].querySelector(".settings-card-hint")?.textContent).toBe(
      "Shift+drag selects text while a program uses the mouse.",
    );
  });
});

describe("settings-terminal: Schriftgroesse (UX-Spec §6.7)", () => {
  it("plus und minus aendern die Schrift um je 1 px", () => {
    const { container } = mount();
    const { decrease, increase, value } = stepper(container);

    increase.click();
    expect(terminalPrefs().fontSize).toBe(14);
    expect(value()).toBe("14");

    decrease.click();
    decrease.click();
    expect(terminalPrefs().fontSize).toBe(12);
    expect(value()).toBe("12");
  });

  it("an den Grenzen 10 und 20 ist der Knopf als wirkungslos markiert und bleibt fokussierbar", () => {
    setTerminalPrefs({ fontSize: 20 });
    const { container } = mount();
    const { decrease, increase, value } = stepper(container);

    expect(increase.getAttribute("aria-disabled")).toBe("true");
    expect(increase.disabled).toBe(false);
    increase.click();
    expect(terminalPrefs().fontSize).toBe(20);
    expect(value()).toBe("20");

    setTerminalPrefs({ fontSize: 10 });
    expect(decrease.getAttribute("aria-disabled")).toBe("true");
    expect(increase.getAttribute("aria-disabled")).toBe("false");
    decrease.click();
    expect(terminalPrefs().fontSize).toBe(10);
  });

  it("Reset setzt 13", () => {
    setTerminalPrefs({ fontSize: 18 });
    const { container } = mount();
    const { reset, value } = stepper(container);

    reset.click();

    expect(terminalPrefs().fontSize).toBe(13);
    expect(value()).toBe("13");
  });

  // Strg+Mausrad und die Tasten schreiben `terminal-prefs` auch bei offenem
  // Bereich (Ladevorgang beim Start, Rad in einem Terminal).
  it("folgt einer Aenderung von aussen", () => {
    const { container } = mount();

    setTerminalPrefs({ fontSize: 17 });

    expect(stepper(container).value()).toBe("17");
  });
});

describe("settings-terminal: Zwischenablage (UX-Spec §6.1, §6.3, §6.4)", () => {
  it("die Schalter schreiben ihre Einstellung", () => {
    const { container } = mount();

    switchNamed(container, "Copy on select").click();
    expect(terminalPrefs().copyOnSelect).toBe(true);

    switchNamed(container, "Use Ctrl+C and Ctrl+V").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(terminalPrefs().ctrlCvClipboard).toBe(false);
  });

  it("die Segmentwahl schreibt Menu oder Copy/Paste", () => {
    const { container } = mount();

    choose(radio(container, "paste"));
    expect(terminalPrefs().rightClick).toBe("paste");

    choose(radio(container, "menu"));
    expect(terminalPrefs().rightClick).toBe("menu");
  });

  it("folgt Aenderungen von aussen", () => {
    const { container } = mount();

    setTerminalPrefs({ copyOnSelect: true, ctrlCvClipboard: false, rightClick: "paste" });

    expect(switchNamed(container, "Copy on select").getAttribute("aria-checked")).toBe("true");
    expect(switchNamed(container, "Use Ctrl+C and Ctrl+V").getAttribute("aria-checked")).toBe("false");
    expect(radio(container, "paste").checked).toBe(true);
    expect(radio(container, "menu").checked).toBe(false);
  });
});

describe("settings-terminal: dispose", () => {
  it("entfernt den Bereich und hoert nicht mehr zu", () => {
    const { container, handle } = mount();
    const valueEl = container.querySelector(".settings-stepper-value")!;

    handle.dispose();
    setTerminalPrefs({ fontSize: 19 });

    expect(container.childElementCount).toBe(0);
    expect(valueEl.textContent).toBe("13");
  });
});
