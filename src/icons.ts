// GENERIERT von scripts/gen-icons.mjs aus lucide-static -- nicht von Hand aendern.
// Lizenz: THIRD_PARTY_LICENSES.md (Lucide, ISC; aus Feather uebernommene Icons MIT).
// UI-v2-Spec §13.1 plus Nachtrag Task 16 (`trash-2`) plus die Suchleiste
// (`chevron-up`, `case-sensitive`): 18 Icons,
// `icon(name, size)` liefert ein dekoratives SVG in currentColor mit
// Strichstaerke 1,75. Jedes Icon steht neben Text oder traegt am umgebenden
// Knopf `title` und `aria-label` (§13.2).

export const ICON_NAMES = ["plus","settings","chevron-right","chevron-down","maximize-2","minimize-2","x","search","refresh-cw","copy","triangle-alert","check","terminal","key-round","lock","trash-2","chevron-up","case-sensitive"] as const;
export type IconName = (typeof ICON_NAMES)[number];

const PATHS: Record<IconName, string> = {
  "plus": "<path d=\"M5 12h14\" /><path d=\"M12 5v14\" />",
  "settings": "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\" /><circle cx=\"12\" cy=\"12\" r=\"3\" />",
  "chevron-right": "<path d=\"m9 18 6-6-6-6\" />",
  "chevron-down": "<path d=\"m6 9 6 6 6-6\" />",
  "maximize-2": "<path d=\"M15 3h6v6\" /><path d=\"m21 3-7 7\" /><path d=\"m3 21 7-7\" /><path d=\"M9 21H3v-6\" />",
  "minimize-2": "<path d=\"m14 10 7-7\" /><path d=\"M20 10h-6V4\" /><path d=\"m3 21 7-7\" /><path d=\"M4 14h6v6\" />",
  "x": "<path d=\"M18 6 6 18\" /><path d=\"m6 6 12 12\" />",
  "search": "<path d=\"m21 21-4.34-4.34\" /><circle cx=\"11\" cy=\"11\" r=\"8\" />",
  "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /><path d=\"M21 3v5h-5\" /><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /><path d=\"M8 16H3v5\" />",
  "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />",
  "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /><path d=\"M12 9v4\" /><path d=\"M12 17h.01\" />",
  "check": "<path d=\"M20 6 9 17l-5-5\" />",
  "terminal": "<path d=\"M12 19h8\" /><path d=\"m4 17 6-6-6-6\" />",
  "key-round": "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\" /><circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />",
  "lock": "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /><path d=\"M7 11V7a5 5 0 0 1 10 0v4\" />",
  "trash-2": "<path d=\"M10 11v6\" /><path d=\"M14 11v6\" /><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\" /><path d=\"M3 6h18\" /><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" />",
  "chevron-up": "<path d=\"m18 15-6-6-6 6\" />",
  "case-sensitive": "<path d=\"m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16\" /><path d=\"M22 9v7\" /><path d=\"M3.304 13h6.392\" /><circle cx=\"18.5\" cy=\"12.5\" r=\"3.5\" />",
};

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("ab-icon");
  // Vertrauenswuerdige, zur Bauzeit eingebettete Konstanten -- kein Nutzertext.
  svg.innerHTML = PATHS[name];
  return svg;
}
