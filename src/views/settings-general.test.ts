// Einstellungen, Bereich "General" (UX-Spec §9.1): eine Karte "Startup" mit dem
// Schalter "Restore hosts and terminals".
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountGeneralSection } from "./settings-general";

function mount(restoreWorkspace = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onRestoreWorkspaceChange = vi.fn((_value: boolean) => {});
  const handle = mountGeneralSection(container, { restoreWorkspace, onRestoreWorkspaceChange });
  const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  return { container, handle, toggle, onRestoreWorkspaceChange };
}

/** Der Text des Elements, auf das `attribute` (eine Id) zeigt. */
function referencedText(el: Element, attribute: string): string | null {
  const id = el.getAttribute(attribute);
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("settings-general (UX-Spec §9.1)", () => {
  it("eine Karte Startup mit dem Schalter und seinem Hinweis", () => {
    const { container, toggle } = mount();

    const cards = Array.from(container.querySelectorAll(".settings-card"));
    expect(cards.map((card) => card.querySelector("h3.settings-card-title")?.textContent)).toEqual(["Startup"]);
    expect(referencedText(toggle, "aria-labelledby")).toBe("Restore hosts and terminals");
    expect(referencedText(toggle, "aria-describedby")).toBe(
      "Reconnects hosts that use a key file or the SSH agent and reopens your terminals. Hosts with a password stay offline until you connect them.",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("zeigt den gespeicherten Wert", () => {
    const { toggle } = mount(false);

    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("Klick und Leertaste melden den neuen Wert", () => {
    const { toggle, onRestoreWorkspaceChange } = mount(true);

    toggle.click();
    expect(onRestoreWorkspaceChange).toHaveBeenLastCalledWith(false);

    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(onRestoreWorkspaceChange).toHaveBeenLastCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("ein Klick auf die Beschriftung schaltet ebenfalls um", () => {
    const { container, onRestoreWorkspaceChange } = mount(true);

    container.querySelector<HTMLLabelElement>("label.settings-label")!.click();

    expect(onRestoreWorkspaceChange).toHaveBeenCalledWith(false);
  });

  it("dispose entfernt den Bereich", () => {
    const { container, handle } = mount();

    handle.dispose();

    expect(container.childElementCount).toBe(0);
  });
});
