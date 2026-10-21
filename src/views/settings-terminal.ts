// Einstellungen, Bereich "Terminal" (UX-Spec §9.1): Karte "Text" mit der
// Schriftgroesse (§6.7) und Karte "Clipboard" mit "Copy on select" (§6.4),
// "Use Ctrl+C and Ctrl+V" (§6.1) und "Right click" (§6.3).
//
// Der Bereich ist eine Ansicht auf `terminal-prefs`: er liest den Stand, schreibt
// jede Aenderung dorthin und folgt Aenderungen von aussen (Strg+Mausrad, Tasten,
// das Laden beim Start). Was daraus folgt -- die Kacheln, settings.toml --,
// erledigt main.ts fuer alle Schreiber gleich.
import en from "../i18n/en.json";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  onTerminalPrefsChanged,
  setTerminalPrefs,
  terminalPrefs,
  type RightClickMode,
  type TerminalPrefs,
} from "../terminal-prefs";
import { controlRow, settingsCard, settingsId, switchRow } from "./settings-rows";

type TranslationKey = keyof typeof en;

function t(key: TranslationKey): string {
  return en[key];
}

const RIGHT_CLICK_LABEL: Record<RightClickMode, TranslationKey> = {
  menu: "settings.terminal.rightClickMenu",
  paste: "settings.terminal.rightClickPaste",
};

/** Ein Knopf des Steppers. Das Zeichen ist Ornament (`aria-hidden`), der Name
 * steht in `aria-label` und `title`. An der Grenze bleibt er fokussierbar
 * (`aria-disabled` statt `disabled`): ein Knopf, der unter dem Fokus deaktiviert
 * wird, wirft den Fokus aus dem Dialog. */
function stepperButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-stepper-btn";
  button.setAttribute("aria-label", label);
  button.title = label;
  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = glyph;
  button.appendChild(mark);
  button.addEventListener("click", onClick);
  return button;
}

export function mountTerminalSection(container: HTMLElement): { dispose(): void } {
  const root = document.createElement("div");
  root.className = "settings-terminal";
  const initial = terminalPrefs();

  // --- Karte "Text": Schriftgroesse als Stepper (minus, Wert, plus) und
  // "Reset" (13). Das Minus der Anzeige ist das Rechenzeichen U+2212.
  // Geklemmt wird in `setTerminalPrefs`; an der Grenze aendert ein Klick nichts.
  const text = settingsCard(t("settings.terminal.text"));
  const fontRow = controlRow(t("settings.terminal.fontSize"), t("settings.terminal.fontSizeHint"));
  const fontControls = document.createElement("span");
  fontControls.className = "settings-font-controls";
  const stepper = document.createElement("div");
  stepper.className = "settings-stepper";
  stepper.setAttribute("role", "group");
  stepper.setAttribute("aria-labelledby", fontRow.labelId);
  if (fontRow.hintId) stepper.setAttribute("aria-describedby", fontRow.hintId);
  const decrease = stepperButton("−", t("settings.terminal.fontSizeDecrease"), () => {
    setTerminalPrefs({ fontSize: terminalPrefs().fontSize - 1 });
  });
  // `output` ist eine hoefliche Live-Region: der neue Wert wird angesagt.
  const value = document.createElement("output");
  value.className = "settings-stepper-value";
  const increase = stepperButton("+", t("settings.terminal.fontSizeIncrease"), () => {
    setTerminalPrefs({ fontSize: terminalPrefs().fontSize + 1 });
  });
  stepper.append(decrease, value, increase);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn btn--secondary btn--row settings-font-reset";
  reset.textContent = t("settings.terminal.fontSizeReset");
  reset.addEventListener("click", () => {
    setTerminalPrefs({ fontSize: DEFAULT_TERMINAL_FONT_SIZE });
  });
  fontControls.append(stepper, reset);
  fontRow.row.appendChild(fontControls);
  text.rows.appendChild(fontRow.row);

  // --- Karte "Clipboard": zwei Schalter und die Segmentwahl fuer den Rechtsklick.
  const clipboard = settingsCard(t("settings.terminal.clipboard"));
  const copyOnSelect = switchRow(t("settings.terminal.copyOnSelect"), null, initial.copyOnSelect, (checked) => {
    setTerminalPrefs({ copyOnSelect: checked });
  });
  const ctrlCv = switchRow(
    t("settings.terminal.ctrlCv"),
    t("settings.terminal.ctrlCvHint"),
    initial.ctrlCvClipboard,
    (checked) => {
      setTerminalPrefs({ ctrlCvClipboard: checked });
    },
  );

  // Native Radios wie in Appearance: Pfeiltasten und genau ein Tabstopp fuer
  // die Gruppe ohne eigenes Roving. Das Radio selbst ist unsichtbar, das
  // Segment zeigt die Wahl.
  const rightClickRow = controlRow(t("settings.terminal.rightClick"), null);
  const segments = document.createElement("div");
  segments.className = "settings-seg";
  segments.setAttribute("role", "radiogroup");
  segments.setAttribute("aria-labelledby", rightClickRow.labelId);
  const groupName = settingsId("settings-right-click");
  const radios = new Map<RightClickMode, HTMLInputElement>();
  for (const mode of ["menu", "paste"] as const) {
    const option = document.createElement("label");
    option.className = "settings-seg-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = groupName;
    input.value = mode;
    input.className = "ab-visually-hidden";
    input.addEventListener("change", () => {
      if (input.checked) setTerminalPrefs({ rightClick: mode });
    });
    const caption = document.createElement("span");
    caption.textContent = t(RIGHT_CLICK_LABEL[mode]);
    option.append(input, caption);
    segments.appendChild(option);
    radios.set(mode, input);
  }
  rightClickRow.row.appendChild(segments);
  clipboard.rows.append(copyOnSelect.row, ctrlCv.row, rightClickRow.row);

  const mouseHint = document.createElement("p");
  mouseHint.className = "settings-card-hint";
  mouseHint.textContent = t("settings.terminal.mouseHint");
  clipboard.card.appendChild(mouseHint);

  root.append(text.card, clipboard.card);

  function show(prefs: Readonly<TerminalPrefs>): void {
    value.textContent = String(prefs.fontSize);
    decrease.setAttribute("aria-disabled", String(prefs.fontSize <= MIN_TERMINAL_FONT_SIZE));
    increase.setAttribute("aria-disabled", String(prefs.fontSize >= MAX_TERMINAL_FONT_SIZE));
    copyOnSelect.toggle.setChecked(prefs.copyOnSelect);
    ctrlCv.toggle.setChecked(prefs.ctrlCvClipboard);
    for (const [mode, input] of radios) input.checked = prefs.rightClick === mode;
  }
  show(initial);
  const offPrefs = onTerminalPrefsChanged(show);

  container.appendChild(root);
  return {
    dispose() {
      offPrefs();
      root.remove();
    },
  };
}
