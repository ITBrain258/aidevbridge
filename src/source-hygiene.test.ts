// @vitest-environment node

// Kommentare im Produktionscode sagen, was gilt und warum (CONTRIBUTING.md):
// deutsch ohne Umlaute und ohne Verweise auf private Arbeitsschritte wie
// nummerierte Aufgaben, Korrekturrunden oder Gutachten, die ein Leser des
// Repositorys nirgends nachschlagen kann. Oeffentliche Verweise bleiben
// erlaubt, ausdruecklich auch "Befund N der Bewertung 2026-09-04", die die
// MVP-Spec zitiert. Das Wort "Befund" allein ist ausserdem ein Fachwort der
// Vorabpruefung. Testdateien sind ausgenommen.

// `node:fs`/`node:path`/`process` sind Node-Globals ohne Typdeklaration in
// diesem browserorientierten Projekt -- dasselbe Muster wie in
// `terminal.test.ts`.
// @ts-expect-error 'node:fs' ist ein Node-Global, siehe Kommentar oben
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error 'node:path' ist ein Node-Global, siehe Kommentar oben
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const UMLAUT = /[äöüÄÖÜß]/;
const HISTORY_MARKER = /Shell-Task|\bTask \d+|Fix-?[Rr]unde|Gutachten|Paket \d+|Review-Befund/;
/** Oeffentlicher Spec-Verweis, der vor der Markerpruefung herausfaellt. */
const SPEC_FINDING = /Befund \d+ der Bewertung/g;

/** Alle Kommentare einer Quelldatei, auch die hinter Code auf derselben
 * Zeile. Ueber den Parser statt ueber Zeilenmuster, damit `//` in einem
 * String oder regulaeren Ausdruck nicht als Kommentar zaehlt. */
function comments(fileName: string, text: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const seen = new Set<number>();
  const found: Array<{ line: number; text: string }> = [];
  const collect = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      found.push({
        line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
        text: text.slice(range.pos, range.end),
      });
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return found.sort((a, b) => a.line - b.line);
}

/** Was an einem Kommentar zu beanstanden ist, mit der Zeile innerhalb des
 * Kommentars (0 fuer die erste). */
function problems(comment: string): Array<{ offset: number; text: string }> {
  return comment.split("\n").flatMap((line, offset) => {
    const found: Array<{ offset: number; text: string }> = [];
    const umlaut = UMLAUT.exec(line);
    if (umlaut) found.push({ offset, text: `Umlaut "${umlaut[0]}"` });
    const marker = HISTORY_MARKER.exec(line.replace(SPEC_FINDING, ""));
    if (marker) found.push({ offset, text: `Marker "${marker[0]}"` });
    return found;
  });
}

/** Produktionsquellen unter `src/`, `cwd`-relativ wie in `terminal.test.ts`;
 * `vitest run` laeuft aus dem Projekt-Wurzelverzeichnis. */
function productionSources(): Array<{ file: string; text: string }> {
  // @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar oben
  const root: string = path.resolve(process.cwd(), "src");
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort()
    .map((file) => ({ file, text: readFileSync(path.join(root, file), "utf-8") as string }));
}

describe("Kommentarhygiene der Produktionsquellen", () => {
  it.each([
    ["// Shell-Task 11: Umbau", 'Marker "Shell-Task"'],
    ["/** Task 16, Punkt B */", 'Marker "Task 16"'],
    ["// Fix-Runde 1, Befund 2", 'Marker "Fix-Runde"'],
    ["// (Fixrunde 3)", 'Marker "Fixrunde"'],
    ["// Gutachten zu diesem Schritt", 'Marker "Gutachten"'],
    ["// Zusage aus Paket 1", 'Marker "Paket 1"'],
    [" * Review-Befund M-1", 'Marker "Review-Befund"'],
    ["// ein bloßes String(error)", 'Umlaut "ß"'],
    ["// Schnellöffnen", 'Umlaut "ö"'],
  ])("beanstandet %s", (comment, expected) => {
    expect(problems(comment).map((problem) => problem.text)).toEqual([expected]);
  });

  it.each([
    "// MVP-Spec M0.1, Befund 9 der Bewertung 2026-09-04",
    "// ein blockierender Befund der Vorabpruefung",
    "// Spec 2026-10-19 §8.4, Nachtrag vom 24.10.",
    "// Waechter-Task der Pumpe",
  ])("laesst %s stehen", (comment) => {
    expect(problems(comment)).toEqual([]);
  });

  it("meldet die Zeile innerhalb eines mehrzeiligen Kommentars", () => {
    expect(problems("/** Kopf\n * Paket 2 */")).toEqual([{ offset: 1, text: 'Marker "Paket 2"' }]);
  });

  it("findet Kommentare hinter Code, aber nicht in Strings", () => {
    const text = 'const a = "// Task 1"; // Schnellöffnen\nconst b = /\\/\\/ Paket 2/;\n';
    expect(comments("probe.ts", text)).toEqual([{ line: 1, text: "// Schnellöffnen" }]);
  });

  const sources = productionSources();

  it("findet die Produktionsquellen", () => {
    expect(sources.map((source) => source.file)).toContain("main.ts");
    expect(sources.some((source) => source.file.endsWith(".test.ts"))).toBe(false);
  });

  it.each(sources)("$file", ({ file, text }) => {
    const found = comments(file, text).flatMap((comment) =>
      problems(comment.text).map((problem) => `${file}:${comment.line + problem.offset}: ${problem.text}`),
    );
    expect(found).toEqual([]);
  });
});
