// @ts-nocheck -- not yet checked through checkJs (tsconfig.node.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .github/workflows/vendored.yml testet das eingebettete russh mit fest
// eingetragenen Features (`--no-default-features --features ...`). Sie sind
// die der russh-Abhaengigkeit in src-tauri/Cargo.toml und muessen ihr folgen,
// und der Workflow muss auch laufen, wenn sich src-tauri/Cargo.toml aendert.
// Dieser Test liest beide Dateien nur als Text, ohne TOML- oder
// YAML-Bibliothek, und meldet jede Abweichung. CRLF zaehlt wie LF.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/vendored.yml';
const MANIFEST = 'src-tauri/Cargo.toml';
const CRATE = 'russh';
// Diese Ereignisse muessen eine paths-Liste mit dem Manifest tragen.
const PATH_EVENTS = ['push', 'pull_request'];

const lines = text => text.replaceAll('\r\n', '\n').split('\n');
// Entfernt einen Kommentar ab `#`, aber nicht innerhalb von Anfuehrungszeichen.
const stripComment = line => /^((?:[^#"']|"[^"]*"|'[^']*')*)/.exec(line)[1];
const unquote = value => value.trim().replace(/^(["'])(.*)\1$/, '$2');
const quotedStrings = text => [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map(match => match[1] ?? match[2]);
const sorted = values => [...new Set(values)].sort();

// Die russh-Abhaengigkeit aus [dependencies] oder einer
// [target.<cfg>.dependencies]-Tabelle, als Inline-Tabelle, als
// Versionsangabe oder als eigene Tabelle [dependencies.russh]. Liefert
// { defaultFeatures, features } oder errors.
function manifestRussh(text) {
  const declarations = [];
  let section = '';
  let table = null;
  for (const raw of lines(text)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      section = header[1];
      table = null;
      if (section === `dependencies.${CRATE}` || new RegExp(`^target\\..+\\.dependencies\\.${CRATE}$`).test(section)) {
        table = { defaultFeatures: true, features: [] };
        declarations.push(table);
      }
      continue;
    }
    if (table) {
      const entry = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
      if (entry?.[1] === 'default-features') table.defaultFeatures = entry[2].trim() !== 'false';
      if (entry?.[1] === 'features') table.features = quotedStrings(entry[2]);
      continue;
    }
    if (section !== 'dependencies' && !/^target\..+\.dependencies$/.test(section)) continue;
    const entry = new RegExp(`^${CRATE}\\s*=\\s*(.+)$`).exec(line);
    if (!entry) continue;
    const value = entry[1].trim();
    if (!value.startsWith('{')) {
      declarations.push({ defaultFeatures: true, features: [] });
      continue;
    }
    const defaults = /default-features\s*=\s*(true|false)/.exec(value);
    const features = /features\s*=\s*\[([^\]]*)\]/.exec(value.replace(/default-features\s*=\s*(true|false)/, ''));
    declarations.push({ defaultFeatures: defaults?.[1] !== 'false', features: features ? quotedStrings(features[1]) : [] });
  }
  if (declarations.length !== 1) {
    return { errors: [`${MANIFEST}: expected exactly 1 ${CRATE} dependency, found ${declarations.length}`] };
  }
  return { ...declarations[0], features: sorted(declarations[0].features), errors: [] };
}

// Die Features der einen Zeile `cargo test -p russh ...` im Workflow;
// Kommentare zaehlen nicht, sie nennen den Befehl auch. Was nach `--` steht,
// geht an das Testprogramm.
function workflowRussh(text) {
  const commands = lines(text).map(stripComment).filter(line => new RegExp(`\\bcargo test\\b.*-p ${CRATE}\\b`).test(line));
  if (commands.length !== 1) {
    return { errors: [`${WORKFLOW}: expected exactly 1 "cargo test -p ${CRATE}" line, found ${commands.length}`] };
  }
  const words = commands[0].trim().split(/\s+/);
  const end = words.indexOf('--');
  const args = (end < 0 ? words : words.slice(0, end)).map(unquote);
  const features = [];
  args.forEach((arg, index) => {
    if (arg === '--features' || arg === '-F') features.push(...(args[index + 1] ?? '').split(','));
    else if (arg.startsWith('--features=')) features.push(...arg.slice('--features='.length).split(','));
  });
  return {
    defaultFeatures: !args.includes('--no-default-features'),
    features: sorted(features.map(feature => feature.trim()).filter(Boolean)),
    errors: [],
  };
}

// Die paths-Listen der Ereignisse unter `on:`, als Map Ereignis -> Pfade.
// Versteht die Fluss-Form `paths: [a, 'b']` und die Blockform mit `- a`.
function workflowPaths(text) {
  const result = new Map();
  const all = lines(text).map(stripComment);
  let inOn = false;
  let eventIndent = null;
  let event = null;
  for (let index = 0; index < all.length; index++) {
    const line = all[index].trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inOn = /^(?:on|'on'|"on"):$/.test(line);
      eventIndent = null;
      event = null;
      continue;
    }
    if (!inOn) continue;
    if (eventIndent === null || indent <= eventIndent) {
      eventIndent = indent;
      event = /^([\w-]+):/.exec(line.trim())?.[1] ?? null;
      continue;
    }
    const key = /^paths:\s*(.*)$/.exec(line.trim());
    if (!key || event === null) continue;
    let items = [];
    if (key[1].startsWith('[')) {
      let flow = key[1];
      while (!flow.includes(']') && index + 1 < all.length) flow += ` ${all[++index].trim()}`;
      items = flow.slice(1, flow.indexOf(']')).split(',').map(unquote).filter(Boolean);
    } else if (key[1] === '') {
      while (index + 1 < all.length && /^\s*-\s/.test(all[index + 1])) items.push(unquote(all[++index].replace(/^\s*-\s/, '')));
    }
    result.set(event, items);
  }
  return result;
}

// Jede Abweichung als eine Zeile: Features, Standard-Features und die
// paths-Listen ohne das Manifest.
function deviations(manifestText, workflowText) {
  const manifest = manifestRussh(manifestText);
  const workflow = workflowRussh(workflowText);
  const problems = [...manifest.errors, ...workflow.errors];
  if (!problems.length) {
    if (manifest.defaultFeatures !== workflow.defaultFeatures) {
      problems.push(manifest.defaultFeatures
        ? `${WORKFLOW}: passes --no-default-features, but ${MANIFEST} keeps the default features of ${CRATE}`
        : `${WORKFLOW}: lacks --no-default-features, but ${MANIFEST} sets default-features = false for ${CRATE}`);
    }
    const missing = manifest.features.filter(feature => !workflow.features.includes(feature));
    const extra = workflow.features.filter(feature => !manifest.features.includes(feature));
    if (missing.length || extra.length) {
      problems.push(`${WORKFLOW}: --features ${workflow.features.join(',') || '(none)'} differs from the ${CRATE} features in ${MANIFEST} (${manifest.features.join(',') || 'none'})`);
    }
  }
  const paths = workflowPaths(workflowText);
  for (const event of PATH_EVENTS) {
    if (!paths.has(event)) problems.push(`${WORKFLOW}: on.${event} has no paths list`);
    else if (!paths.get(event).includes(MANIFEST)) problems.push(`${WORKFLOW}: on.${event}.paths lacks ${MANIFEST}`);
  }
  return problems;
}

const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

test('vendored.yml tests russh with the features of src-tauri/Cargo.toml and runs when it changes', () => {
  const problems = deviations(read(MANIFEST), read(WORKFLOW));
  assert.equal(problems.length, 0, `${WORKFLOW} disagrees with ${MANIFEST}:\n${problems.join('\n')}`);
});

// Die Selbsttests zeigen mit synthetischem Text, dass der Abgleich beisst.
const manifest = (dependency = `${CRATE} = { version = "=0.65.0", default-features = false, features = ["ring", "flate2", "rsa"] }`) =>
  `[package]\nname = "app"\n\n[dependencies]\n# ${CRATE} mit eigenen Features\n${dependency}\ntokio = "1"\n\n[dev-dependencies]\ntempfile = "3"\n`;
const workflow = ({
  command = `cargo test -p ${CRATE} --lib --no-default-features --features ring,flate2,rsa -- --test-threads=4`,
  push = "['vendor/russh/**', Cargo.lock, src-tauri/Cargo.toml]",
  pullRequest = "['vendor/russh/**', Cargo.lock, src-tauri/Cargo.toml]",
} = {}) => `name: Vendored\n# Kommentar am Anfang\non:\n  push:\n    branches: [main]\n    paths: ${push}\n  pull_request:\n    paths: ${pullRequest}\n  workflow_dispatch:\njobs:\n  russh:\n    steps:\n      - run: |\n          cd "$work"\n          ${command}\n`;

test('the check passes on matching text, with LF and with CRLF and with block lists', () => {
  const block = workflow({ pullRequest: '' }).replace("    paths: \n", "    paths:\n      - 'vendor/russh/**'\n      - \"src-tauri/Cargo.toml\"\n");
  for (const eol of ['\n', '\r\n']) {
    assert.deepEqual(deviations(manifest().replaceAll('\n', eol), workflow().replaceAll('\n', eol)), []);
    assert.deepEqual(deviations(manifest().replaceAll('\n', eol), block.replaceAll('\n', eol)), []);
  }
  // Reihenfolge und Schreibweise der Features zaehlen nicht.
  assert.deepEqual(deviations(manifest(), workflow({ command: `cargo test -p ${CRATE} --lib --no-default-features --features=rsa --features "ring,flate2"` })), []);
  assert.deepEqual(deviations(manifest(`[dependencies.${CRATE}]\nversion = "=0.65.0"\ndefault-features = false\nfeatures = ["rsa", "ring", "flate2"]`), workflow()), []);
});

test('the check reports features that differ from src-tauri/Cargo.toml', () => {
  assert.deepEqual(deviations(manifest(), workflow({ command: `cargo test -p ${CRATE} --lib --no-default-features --features ring,rsa -- --test-threads=4` })), [
    `${WORKFLOW}: --features ring,rsa differs from the ${CRATE} features in ${MANIFEST} (flate2,ring,rsa)`,
  ]);
  const extra = manifest(`${CRATE} = { version = "=0.65.0", default-features = false, features = ["ring", "flate2"] }`);
  assert.deepEqual(deviations(extra, workflow()), [
    `${WORKFLOW}: --features flate2,ring,rsa differs from the ${CRATE} features in ${MANIFEST} (flate2,ring)`,
  ]);
  // Features nach `--` gehen an das Testprogramm, nicht an cargo.
  assert.equal(deviations(manifest(), workflow({ command: `cargo test -p ${CRATE} --lib --no-default-features -- --features ring,flate2,rsa` })).length, 1);
});

test('the check reports default-features and --no-default-features that disagree', () => {
  assert.deepEqual(deviations(manifest(), workflow({ command: `cargo test -p ${CRATE} --lib --features ring,flate2,rsa` })), [
    `${WORKFLOW}: lacks --no-default-features, but ${MANIFEST} sets default-features = false for ${CRATE}`,
  ]);
  const defaults = manifest(`${CRATE} = { version = "=0.65.0", features = ["ring", "flate2", "rsa"] }`);
  assert.deepEqual(deviations(defaults, workflow()), [
    `${WORKFLOW}: passes --no-default-features, but ${MANIFEST} keeps the default features of ${CRATE}`,
  ]);
});

test('the check reports a paths list without src-tauri/Cargo.toml or without paths', () => {
  assert.deepEqual(deviations(manifest(), workflow({ pullRequest: "['vendor/russh/**', Cargo.lock, Cargo.toml]" })), [
    `${WORKFLOW}: on.pull_request.paths lacks ${MANIFEST}`,
  ]);
  assert.deepEqual(deviations(manifest(), workflow({ push: '[Cargo.toml]', pullRequest: '[Cargo.toml]' })), [
    `${WORKFLOW}: on.push.paths lacks ${MANIFEST}`,
    `${WORKFLOW}: on.pull_request.paths lacks ${MANIFEST}`,
  ]);
  const noPaths = workflow().replace(/^ {4}paths: .*\n/m, '');
  assert.deepEqual(deviations(manifest(), noPaths), [`${WORKFLOW}: on.push has no paths list`]);
});

test('the check reports a missing or doubled russh dependency and cargo line', () => {
  assert.deepEqual(deviations(manifest('serde = "1"'), workflow()), [
    `${MANIFEST}: expected exactly 1 ${CRATE} dependency, found 0`,
  ]);
  const doubled = `${manifest()}\n[target.'cfg(unix)'.dependencies]\n${CRATE} = "0.65"\n`;
  assert.deepEqual(deviations(doubled, workflow()), [`${MANIFEST}: expected exactly 1 ${CRATE} dependency, found 2`]);
  // Eine russh-Zeile unter [dev-dependencies] ist nicht die der App.
  assert.deepEqual(deviations(manifest('serde = "1"').replace('tempfile = "3"', `${CRATE} = "0.65"`), workflow()), [
    `${MANIFEST}: expected exactly 1 ${CRATE} dependency, found 0`,
  ]);
  assert.deepEqual(deviations(manifest(), workflow({ command: 'cargo build' })), [
    `${WORKFLOW}: expected exactly 1 "cargo test -p ${CRATE}" line, found 0`,
  ]);
});
