// Die Auf-/Abklapp-Entscheidung des Hostmenues. Bewusst eine REINE Funktion
// ohne DOM: `getBoundingClientRect()` liefert unter jsdom (Testumgebung)
// ausschliesslich Nullen, der Zweig "klappt nach oben" waere in einem
// DOM-Test also nie erreichbar -- und genau diese eine Rechnung ist die, die
// man falsch machen kann. Dieselbe Latte wie bei `state/tile-assignment.ts`
// und `tile-layout.ts::layoutTiles`, das aus demselben Grund ausserhalb von
// `grid.ts` steht (dort: `clientWidth`/`clientHeight` immer 0).

export interface MenuAnchor {
  left: number;
  /** Oberkante des Ankers -- die Unterkante des nach OBEN geklappten Menues. */
  top: number;
  /** Unterkante des Ankers -- die Oberkante des nach UNTEN geklappten Menues. */
  bottom: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  openUpward: boolean;
}

export function computeMenuPosition(
  anchor: MenuAnchor,
  menuHeight: number,
  viewportHeight: number,
): MenuPlacement {
  // `<=`, nicht `<`: passt das Menue GENAU bis zur Unterkante, gibt es
  // keinen Grund, es nach oben zu klappen.
  const fitsBelow = anchor.bottom + menuHeight <= viewportHeight;
  return {
    left: anchor.left,
    top: fitsBelow ? anchor.bottom : anchor.top - menuHeight,
    openUpward: !fitsBelow,
  };
}
