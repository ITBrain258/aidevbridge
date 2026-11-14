// Das Markenzeichen der Seitenleiste (Spec 2026-11-14 §3): ein kleines
// Quadrat im Akzent mit dem Prompt-Zeichen `>_` darin, dem Motiv des
// App-Icons. Es folgt dem gewaehlten Akzent und ist reine Zier: den Namen
// traegt der Knopf, in dem es steht.
import { icon } from "../icons";

export function buildBrandMark(): HTMLSpanElement {
  const mark = document.createElement("span");
  mark.className = "sb-brand-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.appendChild(icon("terminal", 12));
  return mark;
}
