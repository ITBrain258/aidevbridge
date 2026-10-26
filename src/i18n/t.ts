// Die eine Uebersetzungsfunktion der Oberflaeche: liest den Text aus en.json
// und setzt Platzhalter wie `{host}` ein. Alle Ansichten nutzen sie, damit die
// Ersetzungsregel nur an einer Stelle steht.
import en from "./en.json";

export type TranslationKey = keyof typeof en;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Text zu `key`; mit `params` werden die Platzhalter in EINEM Durchgang
 * ersetzt. Ein eingesetzter Wert wird nicht noch einmal durchsucht: ein
 * Hostname wie `lab{message}` bleibt woertlich stehen, statt den Grund ein
 * zweites Mal aufzunehmen. Die Ersetzung laeuft ueber einen Rueckruf, damit
 * `$&` oder `$1` in einem Wert woertlich bleiben. Ein Platzhalter ohne
 * eigenen Eintrag in `params` bleibt stehen; `hasOwnProperty` statt `in`,
 * damit `{constructor}` nicht aus dem Prototyp ersetzt wird, und nicht
 * `Object.hasOwn`, das es unter `lib` ES2020 noch nicht gibt. */
export function t(key: TranslationKey, params?: Record<string, string>): string {
  const template = en[key];
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
