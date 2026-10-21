// Schalter der Einstellungen (UX-Spec §9.1): `button[role="switch"]` mit
// `aria-checked`. Leertaste und Enter schalten um, ebenso ein Klick.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSwitch } from "./switch";

function mount(checked = true, describedBy?: string) {
  const onChange = vi.fn((_checked: boolean) => {});
  const handle = createSwitch({ checked, onChange, labelledBy: "label-id", describedBy });
  document.body.appendChild(handle.element);
  return { handle, onChange, el: handle.element };
}

function key(target: HTMLElement, type: "keydown" | "keyup", init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("createSwitch (UX-Spec §9.1)", () => {
  it("ist ein Knopf mit role=switch, aria-checked und Beschriftung", () => {
    const { el } = mount(true, "hint-id");

    expect(el.tagName).toBe("BUTTON");
    expect(el.type).toBe("button");
    expect(el.getAttribute("role")).toBe("switch");
    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(el.getAttribute("aria-labelledby")).toBe("label-id");
    expect(el.getAttribute("aria-describedby")).toBe("hint-id");
    expect(el.classList.contains("ab-switch")).toBe(true);
    expect(el.querySelector(".ab-switch-thumb")).not.toBeNull();
  });

  it("ohne Hinweis kein aria-describedby; aus heisst aria-checked=false", () => {
    const { el } = mount(false);

    expect(el.hasAttribute("aria-describedby")).toBe(false);
    expect(el.getAttribute("aria-checked")).toBe("false");
  });

  it("ein Klick schaltet um und meldet den neuen Wert", () => {
    const { el, onChange } = mount(true);

    el.click();
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(onChange).toHaveBeenLastCalledWith(false);

    el.click();
    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  // Ohne preventDefault klickte der Browser selbst noch einmal (Enter beim
  // Druecken, Leertaste beim Loslassen), und der Schalter sprang zurueck.
  it("Leertaste und Enter schalten je einmal um und verhindern den eigenen Klick des Browsers", () => {
    const { el, onChange } = mount(false);

    const space = key(el, "keydown", { key: " ", code: "Space" });
    const spaceUp = key(el, "keyup", { key: " ", code: "Space" });
    expect(space.defaultPrevented).toBe(true);
    expect(spaceUp.defaultPrevented).toBe(true);
    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenCalledTimes(1);

    const enter = key(el, "keydown", { key: "Enter", code: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("eine gehaltene Taste schaltet nicht immer wieder um", () => {
    const { el, onChange } = mount(false);

    key(el, "keydown", { key: "Enter" });
    const repeated = key(el, "keydown", { key: "Enter", repeat: true });

    expect(repeated.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("andere Tasten tun nichts", () => {
    const { el, onChange } = mount(true);

    for (const k of ["a", "Tab", "ArrowRight", "Escape"]) {
      expect(key(el, "keydown", { key: k }).defaultPrevented, k).toBe(false);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(el.getAttribute("aria-checked")).toBe("true");
  });

  it("setChecked zeigt einen Wert von aussen, ohne onChange zu rufen", () => {
    const { el, handle, onChange } = mount(true);

    handle.setChecked(false);

    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
    el.click();
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});
