// Das Terminal hat keinen Scrollbalken (Entscheidung vom 29.10.2026, hebt
// Regel 9 des Designsystems und v2 §13.3 auf): Gescrollt wird mit dem
// Mausrad, durch Wischen (`touch-scroll.ts`) oder in tmux. `styles.css`
// blendet den Balken aus. Das allein gaebe aber keinen Platz frei: `FitAddon`
// zieht fuer den Balken immer 14 px von der Breite ab, ob er zu sehen ist
// oder nicht, und keine Option schaltet das ab. Diese Unterklasse rechnet die
// Spalten deshalb ueber die volle Breite; die Zeilen bleiben, wie das Addon
// sie rechnet. Ein Uebersichtslineal (`overviewRuler`) gibt es hier nicht.

import { FitAddon, type ITerminalDimensions } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** Die Zellgroesse in CSS-Pixeln, wie `FitAddon` sie selbst aus xterm liest.
 * Nicht Teil der oeffentlichen API: fehlt sie, gilt die Rechnung des Addons. */
interface RenderDimensions {
  _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } };
}

export class FitWithoutScrollbar extends FitAddon {
  private terminal: Terminal | undefined;

  override activate(terminal: Terminal): void {
    super.activate(terminal);
    this.terminal = terminal;
  }

  override proposeDimensions(): ITerminalDimensions | undefined {
    const proposed = super.proposeDimensions();
    const element = this.terminal?.element;
    const parent = element?.parentElement;
    const cellWidth = (this.terminal as RenderDimensions | undefined)?._core?._renderService?.dimensions?.css?.cell
      ?.width;
    if (!proposed || !element || !parent || !cellWidth) return proposed;
    const own = getComputedStyle(element);
    const width =
      Math.max(0, parseInt(getComputedStyle(parent).getPropertyValue("width"))) -
      (parseInt(own.getPropertyValue("padding-left")) || 0) -
      (parseInt(own.getPropertyValue("padding-right")) || 0);
    if (!Number.isFinite(width)) return proposed;
    return { cols: Math.max(2, Math.floor(width / cellWidth)), rows: proposed.rows };
  }
}
