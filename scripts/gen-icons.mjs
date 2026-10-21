// Erzeugt src/icons.ts aus lucide-static. Aufruf: npm run gen:icons
// Die 18 Namen sind die Liste aus der UI-v2-Spec §13.1 plus "trash-2"
// (Nachtrag Task 16: "End session…" ist ein Icon-Knopf in der Sessionzeile)
// plus "chevron-up" und "case-sensitive" (UX-Spec §6.6: Suchleiste, vorheriger
// Treffer und "Aa"); ein fehlendes SVG ist ein harter Fehler, kein leeres Icon.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = [
  "plus", "settings", "chevron-right", "chevron-down", "maximize-2", "minimize-2", "x",
  "search", "refresh-cw", "copy", "triangle-alert", "check", "terminal", "key-round", "lock",
  "trash-2", "chevron-up", "case-sensitive",
];

const root = fileURLToPath(new URL("..", import.meta.url));

function innerMarkup(name) {
  const file = resolve(root, "node_modules/lucide-static/icons", `${name}.svg`);
  const svg = readFileSync(file, "utf8");
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*\n\s*/g, "")
    .trim();
  if (!inner.includes("<")) throw new Error(`${name}.svg enthaelt keine Pfade`);
  return inner;
}

const entries = NAMES.map((name) => `  "${name}": ${JSON.stringify(innerMarkup(name))},`);

const out = `// GENERIERT von scripts/gen-icons.mjs aus lucide-static -- nicht von Hand aendern.
// Lizenz: THIRD_PARTY_LICENSES.md (Lucide, ISC; aus Feather uebernommene Icons MIT).
// UI-v2-Spec §13.1 plus Nachtrag Task 16 (\`trash-2\`) plus die Suchleiste
// (\`chevron-up\`, \`case-sensitive\`): 18 Icons,
// \`icon(name, size)\` liefert ein dekoratives SVG in currentColor mit
// Strichstaerke 1,75. Jedes Icon steht neben Text oder traegt am umgebenden
// Knopf \`title\` und \`aria-label\` (§13.2).

export const ICON_NAMES = ${JSON.stringify(NAMES)} as const;
export type IconName = (typeof ICON_NAMES)[number];

const PATHS: Record<IconName, string> = {
${entries.join("\n")}
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
`;

writeFileSync(resolve(root, "src/icons.ts"), out);
console.log(`src/icons.ts geschrieben (${NAMES.length} Icons)`);
