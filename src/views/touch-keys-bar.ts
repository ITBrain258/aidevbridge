// Die Touch-Leiste unter dem Raster (Spec 2026-10-27 §5.2): eine Zeile von
// Tasten, die waagerecht rollt, wenn sie nicht passt. Die Bytes jeder Taste
// und den Merker fuer Strg und Alt fuehrt `touch-keys.ts`; diese Datei baut
// nur die Knoepfe und zeigt den Merker an.
//
// Kein Knopf nimmt den Fokus: Ein Tipp darf weder das Terminal verlassen noch
// die Bildschirmtastatur schliessen. `pointerdown` mit `preventDefault`
// verhindert das Fokussieren und die nachgeahmten Mausereignisse, der Klick
// kommt trotzdem.

import {
  clearModifiers,
  isModifier,
  latchedModifiers,
  onModifiersChanged,
  toggleModifier,
  TOUCH_KEYS,
  type TouchKeyId,
} from "../touch-keys";
import { t } from "../i18n/t";

export interface TouchKeysBarHandle {
  dispose(): void;
}

/** Haengt die Leiste an `parent` an; `onKey` bekommt jede Taste ausser den
 * Umschaltern (`GridHandle.sendTouchKey`), die schalten den Merker selbst. */
export function mountTouchKeysBar(parent: HTMLElement, onKey: (id: TouchKeyId) => void): TouchKeysBarHandle {
  const bar = document.createElement("div");
  bar.id = "touch-keys";
  bar.className = "touch-keys";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t("touchKeys.label"));

  const modifierButtons = new Map<TouchKeyId, HTMLButtonElement>();
  for (const key of TOUCH_KEYS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "touch-key";
    button.dataset.key = key.id;
    button.textContent = key.label;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    const id = key.id;
    if (isModifier(id)) {
      // Der Merker gilt auch, solange noch keine Kachel fokussiert ist.
      button.classList.add("touch-key--modifier");
      button.addEventListener("click", () => toggleModifier(id));
      modifierButtons.set(id, button);
    } else {
      button.addEventListener("click", () => onKey(id));
    }
    bar.appendChild(button);
  }

  function showModifiers(): void {
    const latched = latchedModifiers();
    for (const [id, button] of modifierButtons) {
      const on = isModifier(id) && latched[id];
      button.setAttribute("aria-pressed", String(on));
    }
  }

  const offModifiers = onModifiersChanged(showModifiers);
  showModifiers();
  parent.appendChild(bar);
  parent.classList.add("has-touch-keys");

  return {
    dispose() {
      offModifiers();
      clearModifiers();
      bar.remove();
      parent.classList.remove("has-touch-keys");
    },
  };
}
