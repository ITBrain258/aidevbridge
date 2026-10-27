import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModifiers, consumeModifiers, latchedModifiers, TOUCH_KEYS } from "../touch-keys";
import { mountTouchKeysBar } from "./touch-keys-bar";

function setup() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onKey = vi.fn();
  const bar = mountTouchKeysBar(parent, onKey);
  const button = (id: string) => parent.querySelector<HTMLButtonElement>(`.touch-key[data-key="${id}"]`)!;
  return { parent, onKey, bar, button };
}

afterEach(() => {
  clearModifiers();
  document.body.replaceChildren();
});

describe("Touch-Leiste (Spec 2026-10-27 §5.2)", () => {
  it("ist eine benannte Werkzeugleiste mit einem Knopf je Taste", () => {
    const { parent } = setup();
    const bar = parent.querySelector("#touch-keys")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe("Terminal keys");
    expect(bar.querySelectorAll(".touch-key")).toHaveLength(TOUCH_KEYS.length);
    expect(parent.classList.contains("has-touch-keys")).toBe(true);
  });

  it("reicht eine Taste weiter und nimmt beim Druecken keinen Fokus", () => {
    const { onKey, button } = setup();
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    button("esc").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button("esc").click();
    expect(onKey).toHaveBeenCalledWith("esc");
  });

  it("Strg und Alt schalten den Merker selbst und zeigen ihn an", () => {
    const { onKey, button } = setup();
    expect(button("ctrl").getAttribute("aria-pressed")).toBe("false");
    button("ctrl").click();
    expect(onKey).not.toHaveBeenCalled();
    expect(latchedModifiers().ctrl).toBe(true);
    expect(button("ctrl").getAttribute("aria-pressed")).toBe("true");
    consumeModifiers("c");
    expect(button("ctrl").getAttribute("aria-pressed")).toBe("false");
  });

  it("raeumt beim Entsorgen Leiste, Klasse und Merker ab", () => {
    const { parent, bar, button } = setup();
    button("alt").click();
    bar.dispose();
    expect(parent.querySelector("#touch-keys")).toBeNull();
    expect(parent.classList.contains("has-touch-keys")).toBe(false);
    expect(latchedModifiers()).toEqual({ ctrl: false, alt: false });
  });
});
