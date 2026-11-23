// @vitest-environment node

// Der Vertrag zwischen Frontend und Backend: jeder `invoke(...)`-Aufruf in den
// Produktionsquellen unter `src/` nennt einen `#[tauri::command]` aus
// `src-tauri/src`, und seine Argumente passen zu dessen Parametern. Tauri
// erwartet die Parameternamen in camelCase (`host_id` -> `hostId`), und
// Parameter, die Tauri selbst einsetzt (`State`, `AppHandle`, Fenster), kommen
// nicht vom Frontend. Ein `Option<...>` darf fehlen, jeder andere Parameter
// muss da sein, und kein Argument darf es auf der Rust-Seite nicht geben.
//
// Die Frontend-Tests ersetzen `invoke` durch Attrappen; ein umbenannter
// Command oder Parameter faellt dort nicht auf, erst zur Laufzeit. Dieser Test
// liest beide Seiten als Quelltext, ohne Rust zu bauen. Die Liste der
// registrierten Commands (`generate_handler!` in `lib.rs`) haelt
// `src-tauri/tests/capabilities_acl.rs` mit der ACL zusammen; hier dient sie
// als Gegenprobe, dass die Zerlegung jeden Command gefunden hat.

// `node:fs`/`node:path`/`process` sind Node-Globals ohne Typdeklaration in
// diesem browserorientierten Projekt -- dasselbe Muster wie in
// `source-hygiene.test.ts`.
// @ts-expect-error 'node:fs' ist ein Node-Global, siehe Kommentar oben
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error 'node:path' ist ein Node-Global, siehe Kommentar oben
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar oben
const ROOT: string = process.cwd();

interface RustCommand {
  name: string;
  file: string;
  /** camelCase-Name -> Pflichtparameter? */
  params: Map<string, boolean>;
}

interface InvokeCall {
  file: string;
  line: number;
  name: string;
  /** Die ausgeschriebenen Schluessel des Argumentobjekts. */
  keys: string[];
  /** Schluessel aus `...`-Ausdruecken: sie koennen fehlen. */
  spreadKeys: string[];
  /** Was sich nicht lesen liess (kein Objektliteral, unbekannter Spread). */
  unreadable: string[];
}

/** Typen, die Tauri selbst einsetzt; sie kommen nie vom Frontend. */
const INJECTED = /^(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow|Webview)\b/;

const camel = (snake: string): string => snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function rustFiles(): Array<{ file: string; text: string }> {
  const root = path.join(ROOT, "src-tauri/src");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".rs"));
  return files.map((file) => ({ file, text: readFileSync(path.join(root, file), "utf-8") as string }));
}

/** Teilt an Kommas der obersten Ebene, nicht in `<...>`, `(...)`, `[...]`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function rustCommands(): RustCommand[] {
  const commands: RustCommand[] = [];
  for (const { file, text } of rustFiles()) {
    // Das Attribut am Zeilenanfang: in Kommentaren steht es mitten im Satz.
    // Dazwischen duerfen weitere Attribute (`#[allow(...)]`) und
    // Kommentarzeilen stehen.
    const pattern = /^[ \t]*#\[tauri::command\][ \t]*\n(?:[ \t]*(?:#\[[^\n]*\]|\/\/[^\n]*)[ \t]*\n)*[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/gm;
    for (const match of text.matchAll(pattern)) {
      // Die Parameterliste bis zur passenden Klammer.
      const start = match.index! + match[0].length;
      let depth = 1;
      let end = start;
      while (depth > 0 && end < text.length) {
        if (text[end] === "(") depth++;
        if (text[end] === ")") depth--;
        end++;
      }
      const params = new Map<string, boolean>();
      for (const param of splitTopLevel(text.slice(start, end - 1))) {
        const colon = param.indexOf(":");
        const name = param.slice(0, colon).replace(/^mut\s+/, "").trim();
        const type = param.slice(colon + 1).trim();
        if (INJECTED.test(type)) continue;
        params.set(camel(name), !type.startsWith("Option<"));
      }
      commands.push({ name: match[1], file, params });
    }
  }
  return commands;
}

/** Die Namen in `tauri::generate_handler![...]` (`lib.rs`). */
function registeredCommands(): string[] {
  const lib = readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf-8") as string;
  const list = /generate_handler!\[([\s\S]*?)\]/.exec(lib)![1];
  return Array.from(list.replace(/\/\/[^\n]*/g, "").matchAll(/(?:\w+::)*(\w+)\s*(?:,|$)/g), (m) => m[1]);
}

/** Die Schluessel der Objektliterale, die ein Ausdruck liefern kann. */
function literalKeys(node: ts.Node, source: ts.SourceFile): string[] {
  const keys: string[] = [];
  const visit = (inner: ts.Node): void => {
    if (ts.isObjectLiteralExpression(inner)) {
      for (const property of inner.properties) if (property.name) keys.push(property.name.getText(source));
      return;
    }
    ts.forEachChild(inner, visit);
  };
  visit(node);
  return keys;
}

/** Ein Spread wie `...socketArg` oder `...includeDefaultArg(hostId)`: der
 * Name wird in derselben Datei aufgeloest, als Konstante mit Initialisierer
 * oder als Funktion, deren `return`s Objektliterale liefern. */
function resolveSpread(expression: ts.Expression, source: ts.SourceFile): string[] | null {
  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
      ? expression.expression.text
      : null;
  if (name === null) return null;
  let keys: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      keys = literalKeys(node.initializer, source);
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      const found: string[] = [];
      const returns = (inner: ts.Node): void => {
        if (ts.isReturnStatement(inner) && inner.expression) found.push(...literalKeys(inner.expression, source));
        else if (!ts.isFunctionLike(inner)) ts.forEachChild(inner, returns);
      };
      ts.forEachChild(node.body, returns);
      keys = found;
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return keys;
}

function invokeCalls(): InvokeCall[] {
  const root = path.join(ROOT, "src");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
  );
  const calls: InvokeCall[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf-8") as string;
    if (!text.includes("invoke")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "invoke") {
        const [first, second] = node.arguments;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const call: InvokeCall = {
          file,
          line,
          name: first && ts.isStringLiteralLike(first) ? first.text : `<not a literal: ${first?.getText(source)}>`,
          keys: [],
          spreadKeys: [],
          unreadable: [],
        };
        if (second && !ts.isObjectLiteralExpression(second)) {
          call.unreadable.push(second.getText(source));
        } else if (second) {
          for (const property of second.properties) {
            if (ts.isSpreadAssignment(property)) {
              const keys = resolveSpread(property.expression, source);
              if (keys === null || keys.length === 0) call.unreadable.push(property.getText(source));
              else call.spreadKeys.push(...keys);
            } else if (property.name) {
              call.keys.push(property.name.getText(source));
            }
          }
        }
        calls.push(call);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

describe("IPC-Vertrag: invoke-Aufrufe gegen die Tauri-Commands", () => {
  const commands = rustCommands();
  const byName = new Map(commands.map((command) => [command.name, command]));
  const calls = invokeCalls();

  it("findet jeden registrierten Command und nur diese", () => {
    const registered = registeredCommands();
    expect(registered.length).toBeGreaterThan(20);
    expect(commands.map((command) => command.name).sort()).toEqual([...registered].sort());
  });

  it("jeder Aufruf nennt einen Command der Rust-Seite", () => {
    expect(calls.length).toBeGreaterThan(20);
    const unknown = calls
      .filter((call) => !byName.has(call.name))
      .map((call) => `${call.file}:${call.line} ${call.name}`);
    expect(unknown).toEqual([]);
  });

  // Der Test sieht nur Aufrufe ueber den Namen `invoke`. Ruft eine Datei einen
  // Command ueber einen anderen Namen oder eine Eigenschaft auf, fehlt er
  // hier, statt still ungeprueft zu bleiben. Ein Command ohne Aufruf aus dem
  // Frontend braeuchte eine Ausnahme mit Begruendung.
  it("jeder registrierte Command hat einen gelesenen Aufruf", () => {
    const invoked = new Set(calls.map((call) => call.name));
    expect(registeredCommands().filter((name) => !invoked.has(name))).toEqual([]);
  });

  it("die Argumente passen zu den Parametern", () => {
    const problems: string[] = [];
    for (const call of calls) {
      const command = byName.get(call.name);
      if (!command) continue;
      const at = `${call.file}:${call.line} ${call.name}`;
      for (const text of call.unreadable) problems.push(`${at}: cannot read ${text}`);
      for (const key of [...call.keys, ...call.spreadKeys]) {
        if (!command.params.has(key)) problems.push(`${at}: no parameter ${key}`);
      }
      for (const [param, required] of command.params) {
        if (required && !call.keys.includes(param)) problems.push(`${at}: missing ${param}`);
      }
    }
    expect(problems).toEqual([]);
  });

  // Gegenprobe der Zerlegung: Pflicht, Option und eingesetzte Parameter, ein
  // Command mit weiterem Attribut, und beide Arten von Spread.
  it("liest Pflicht, Option, eingesetzte Parameter und Spreads", () => {
    expect(Object.fromEntries(byName.get("create_session")!.params)).toEqual({ hostId: true, cwd: true, name: false });
    expect(byName.get("begin_connect")!.params.size).toBe(0);
    expect(byName.get("open_terminal")!.params.get("socket")).toBe(false);
    const spread = (name: string) => calls.filter((call) => call.name === name).flatMap((call) => call.spreadKeys);
    expect(spread("list_sessions")).toContain("includeDefault");
    expect(spread("close_terminal")).toContain("socket");
  });
});
