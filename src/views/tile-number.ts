// Die Kachelnummer einer offenen Session in Liste und Wartet-Spur (Spec
// 2026-10-19 §7): dieselbe Ziffer wie im Kachelkopf (Position + 1), 14 px,
// hohl; fokussiert gefuellt wie das Abzeichen der fokussierten Kachel. Nur
// fuers Auge -- Screenreader hoeren den Zustand am Wort der Zeile.

export function buildTileNumber(tileNumber: number, focused: boolean): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = focused ? "tile-number tile-number--focused" : "tile-number";
  chip.setAttribute("aria-hidden", "true");
  chip.textContent = String(tileNumber);
  return chip;
}
