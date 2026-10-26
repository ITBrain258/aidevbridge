// Bausteine der Einstellungsbereiche mit Bedienelementen (UX-Spec §9.1): eine
// Karte mit Titel und Zeilen, und die Zeile "links Beschriftung und Hinweis,
// rechts das Element". General und Terminal bauen daraus; die Texte kommen
// fertig uebersetzt vom Aufrufer.
import { createSwitch, type SwitchHandle } from "./switch";

let lastId = 0;

/** Eine im Dokument eindeutige Id fuer `aria-labelledby`, `aria-describedby`
 * und `<label for>`. */
export function settingsId(prefix: string): string {
  lastId += 1;
  return `${prefix}-${lastId}`;
}

/** `div.settings-card` mit Titel und `div.settings-rows` fuer die Zeilen. */
export function settingsCard(title: string): { card: HTMLDivElement; rows: HTMLDivElement } {
  const card = document.createElement("div");
  card.className = "settings-card";
  const heading = document.createElement("h3");
  heading.className = "settings-card-title settings-card-title--rows";
  heading.textContent = title;
  const rows = document.createElement("div");
  rows.className = "settings-rows";
  card.append(heading, rows);
  return { card, rows };
}

export interface ControlRow {
  row: HTMLDivElement;
  labelId: string;
  /** Id des Hinweises unter der Beschriftung, oder `null` ohne Hinweis. */
  hintId: string | null;
}

/** Eine Zeile mit Bedienelement: links die Beschriftung und darunter ein
 * Hinweis, rechts haengt der Aufrufer das Element an `row`. Mit `forId` ist die
 * Beschriftung ein `<label for>`, ein Klick darauf bedient dann das Element
 * (Schalter); sonst ein `span`, auf das eine Gruppe per `aria-labelledby` zeigt. */
export function controlRow(label: string, hint: string | null, forId?: string): ControlRow {
  const row = document.createElement("div");
  row.className = hint === null ? "settings-row" : "settings-row settings-row--hint";
  const text = document.createElement("div");
  text.className = "settings-row-text";
  const labelEl = document.createElement(forId ? "label" : "span");
  if (labelEl instanceof HTMLLabelElement && forId) labelEl.htmlFor = forId;
  labelEl.className = "settings-label";
  labelEl.id = settingsId("settings-label");
  labelEl.textContent = label;
  text.appendChild(labelEl);
  let hintId: string | null = null;
  if (hint !== null) {
    const hintEl = document.createElement("p");
    hintEl.className = "settings-row-hint";
    hintEl.id = settingsId("settings-hint");
    hintEl.textContent = hint;
    text.appendChild(hintEl);
    hintId = hintEl.id;
  }
  row.appendChild(text);
  return { row, labelId: labelEl.id, hintId };
}

/** Eine Zeile mit Schalter (`switch.ts`), benannt von ihrer Beschriftung und
 * beschrieben von ihrem Hinweis. */
export function switchRow(
  label: string,
  hint: string | null,
  checked: boolean,
  onChange: (checked: boolean) => void,
): { row: HTMLDivElement; toggle: SwitchHandle } {
  const id = settingsId("settings-switch");
  const { row, labelId, hintId } = controlRow(label, hint, id);
  const toggle = createSwitch({ checked, onChange, labelledBy: labelId, describedBy: hintId ?? undefined, id });
  row.appendChild(toggle.element);
  return { row, toggle };
}
