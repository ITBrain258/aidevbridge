// @vitest-environment node

// Spec 2026-10-19 §8.3: `CAPACITY_ERRORS` (grid.ts) erkennt die Kanalgrenzen
// an den Rohtexten des Backends. Deren Wortlaut legen Rust-Tests fest
// (`terminal_ownership_tests.rs`, `connection/tests.rs`,
// `operation_control.rs`, `operation_tests.rs`). Dieser Test prueft die
// Gegenseite: jeder Eintrag steht woertlich als Zeichenkettenliteral in den
// Rust-Quellen. Aendert sich ein Text nur auf einer Seite, faellt das hier
// auf, statt dass die Meldung still auf den allgemeinen Satz zurueckfaellt.
// Die Kopplung laeuft bewusst nur in diese Richtung: Rust bindet keine
// TS-Dateien ein.

// `node:fs`/`node:path`/`process` sind Node-Globals ohne Typdeklaration in
// diesem browserorientierten Projekt -- dasselbe Muster wie in
// `terminal.test.ts` (dort zuerst eingefuehrt, siehe dessen Kommentar).
// @ts-expect-error 'node:fs' ist ein Node-Global, siehe Kommentar oben
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error 'node:path' ist ein Node-Global, siehe Kommentar oben
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPACITY_ERRORS } from "./grid";

/** Alle Rust-Quellen unter `src-tauri/src`, Tests eingeschlossen: dort steht
 * der erzeugte Text, gegen den die Rust-Tests vergleichen. Der Pfad ist
 * `cwd`-relativ wie in `terminal.test.ts`; `vitest run` laeuft aus dem
 * Projekt-Wurzelverzeichnis. */
function rustSources(): Array<{ file: string; text: string }> {
  // @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar oben
  const root: string = path.resolve(process.cwd(), "src-tauri/src");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".rs"));
  return files.map((file) => ({ file, text: readFileSync(path.join(root, file), "utf-8") as string }));
}

/** Der Eintrag als Rust-Literal in doppelten Anfuehrungszeichen. */
function rustLiteral(text: string): string {
  return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

describe("CAPACITY_ERRORS gegen die Rust-Quellen", () => {
  const sources = rustSources();

  it("findet die Rust-Quellen", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(CAPACITY_ERRORS.length).toBeGreaterThan(0);
  });

  it.each(CAPACITY_ERRORS)("%s steht woertlich in src-tauri/src", (text) => {
    const literal = rustLiteral(text);
    const files = sources.filter((source) => source.text.includes(literal)).map((source) => source.file);
    expect(files, `${literal} in src-tauri/src/**/*.rs`).not.toEqual([]);
  });
});
