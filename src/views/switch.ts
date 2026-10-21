// Schalter (UX-Spec §9.1): `button[role="switch"][aria-checked]` im Stil der
// Token. Ein Knopf statt eines Kontrollkaestchens, weil "an/aus mit sofortiger
// Wirkung" genau die Rolle `switch` ist. Die Beschriftung steht daneben in der
// Zeile (`labelledBy`), ein Hinweis darunter (`describedBy`) -- beide liefert der
// Aufrufer, dieses Modul kennt keinen Text.

export interface SwitchOptions {
  checked: boolean;
  /** Nach jedem Umschalten durch den Nutzer, mit dem neuen Wert. */
  onChange: (checked: boolean) => void;
  /** Id des Elements, das den Schalter benennt. */
  labelledBy: string;
  /** Id eines Hinweises zum Schalter, falls es einen gibt. */
  describedBy?: string;
  /** Fuer `<label for>`: ein Klick auf die Beschriftung schaltet dann ebenfalls. */
  id?: string;
}

export interface SwitchHandle {
  readonly element: HTMLButtonElement;
  /** Zeigt einen Wert von aussen (etwa nach dem Laden), ohne `onChange`. */
  setChecked(checked: boolean): void;
}

export function createSwitch(opts: SwitchOptions): SwitchHandle {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "ab-switch";
  element.setAttribute("role", "switch");
  element.setAttribute("aria-labelledby", opts.labelledBy);
  if (opts.describedBy) element.setAttribute("aria-describedby", opts.describedBy);
  if (opts.id) element.id = opts.id;
  const thumb = document.createElement("span");
  thumb.className = "ab-switch-thumb";
  thumb.setAttribute("aria-hidden", "true");
  element.appendChild(thumb);

  let checked = opts.checked;
  function show(): void {
    element.setAttribute("aria-checked", String(checked));
  }
  show();

  function toggle(): void {
    checked = !checked;
    show();
    opts.onChange(checked);
  }

  // Maus, Beschriftung (`<label for>`) und Hilfstechnik kommen als Klick.
  element.addEventListener("click", toggle);
  // Leertaste und Enter schalten selbst um und verhindern den Klick, den der
  // Browser sonst nachschiebt (Enter beim Druecken, die Leertaste beim
  // Loslassen) -- der Schalter spraenge sonst gleich wieder zurueck. Eine
  // gehaltene Taste schaltet nur einmal.
  element.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) toggle();
  });
  element.addEventListener("keyup", (event) => {
    if (event.key === " ") event.preventDefault();
  });

  return {
    element,
    setChecked(next) {
      checked = next;
      show();
    },
  };
}
