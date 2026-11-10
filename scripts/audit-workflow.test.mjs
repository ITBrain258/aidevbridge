import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './check-vendored-advisories.mjs';

// .github/workflows/audit.yml nimmt einzelne Meldungen von `cargo audit` aus
// (`--ignore RUSTSEC-...`). Eine solche Ausnahme veraltet lautlos: Ist das
// Paket aktualisiert oder aus Cargo.lock verschwunden, bleibt sie stehen und
// deckt spaeter nichts oder das Falsche. Dieser Test bindet jede Ausnahme an
// ihren Grund in Cargo.lock: Sie darf nur stehen, solange das betroffene Paket
// dort in einer betroffenen Version eingetragen ist. Er liest beide Dateien nur
// als Text, ohne TOML- oder YAML-Bibliothek. CRLF zaehlt wie LF.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/audit.yml';
const LOCKFILE = 'Cargo.lock';
const SELF = 'scripts/audit-workflow.test.mjs';

// Jede Ausnahme mit dem Paket, das die Meldung trifft, und der ersten
// Version, die sie behebt (wie SECURITY.md sie nennt). Unterhalb von `fixed`
// ist das Paket betroffen.
const REASONS = {
  // rsa, Marvin-Angriff: behoben in rsa 0.10.0.
  'RUSTSEC-2023-0071': { crate: 'rsa', fixed: '0.10.0' },
  // glib, VariantStrIter (unsound): behoben in glib 0.20.0; nur im
  // GTK-Backend fuer Linux, in keinem ausgelieferten Paket.
  'RUSTSEC-2024-0429': { crate: 'glib', fixed: '0.20.0' },
};

/** @param {string} text */
const lines = text => text.replaceAll('\r\n', '\n').split('\n');
// Entfernt einen Kommentar ab `#`, aber nicht innerhalb von Anfuehrungszeichen.
/** @param {string} line */
const stripComment = line => (/^((?:[^#"']|"[^"]*"|'[^']*')*)/.exec(line) ?? ['', ''])[1];

// Die eine Zeile `cargo audit ...` des Workflows: ihre Ausnahmen (--ignore)
// und was sie scheitern laesst (--deny). `cargo install cargo-audit` und die
// Kommentare, die den Befehl nennen, zaehlen nicht.
/**
 * @param {string} text
 * @returns {{ ignored: string[], denied: string[], errors: string[] }}
 */
function auditCommand(text) {
  const commands = lines(text).map(stripComment).filter(line => /\bcargo audit\b/.test(line));
  if (commands.length !== 1) {
    return { ignored: [], denied: [], errors: [`${WORKFLOW}: expected exactly 1 "cargo audit" line, found ${commands.length}`] };
  }
  const words = commands[0].trim().split(/\s+/);
  /** @param {string} flag @param {string} [short] */
  const values = (flag, short) => words.flatMap((word, index) => {
    if (word === flag || word === short) return [words[index + 1] ?? ''];
    return word.startsWith(`${flag}=`) ? [word.slice(flag.length + 1)] : [];
  });
  const ignored = values('--ignore');
  const errors = ignored.filter(id => !/^RUSTSEC-\d{4}-\d{4}$/.test(id)).map(id => `${WORKFLOW}: --ignore without an advisory id: ${JSON.stringify(id)}`);
  return { ignored, denied: values('--deny', '-D'), errors };
}

// Die Versionen, mit denen Cargo.lock ein Paket fuehrt (mehrere, wenn zwei
// Hauptversionen nebeneinander stehen).
/**
 * @param {string} text
 * @param {string} crate
 * @returns {string[]}
 */
function lockedVersions(text, crate) {
  const versions = [];
  for (const block of lines(text).join('\n').split(/^\[\[package\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    if (name === crate && version) versions.push(version);
  }
  return versions;
}

// Jede Abweichung als eine Zeile: eine Ausnahme ohne Grund, eine veraltete
// Ausnahme, ein Grund ohne Ausnahme und ein Befehl, der unsound nicht mehr
// scheitern laesst.
/**
 * @param {string} workflowText
 * @param {string} lockText
 * @param {Record<string, { crate: string, fixed: string }>} reasons
 * @returns {string[]}
 */
function deviations(workflowText, lockText, reasons) {
  const command = auditCommand(workflowText);
  const problems = [...command.errors];
  if (problems.length) return problems;
  if (!command.denied.includes('unsound') && !command.denied.includes('warnings')) {
    problems.push(`${WORKFLOW}: cargo audit lacks --deny unsound, so a new unsound notice would pass as a warning`);
  }
  for (const id of command.ignored) {
    const reason = reasons[id];
    if (!reason) {
      problems.push(`${WORKFLOW}: --ignore ${id} has no reason in ${SELF}`);
      continue;
    }
    const versions = lockedVersions(lockText, reason.crate);
    if (versions.length === 0) {
      problems.push(`${WORKFLOW}: --ignore ${id} is stale, ${LOCKFILE} no longer contains ${reason.crate}`);
    } else if (!versions.some(version => compareVersions(version, reason.fixed) < 0)) {
      problems.push(`${WORKFLOW}: --ignore ${id} is stale, ${LOCKFILE} has ${reason.crate} ${versions.join(' and ')} and the advisory is fixed in ${reason.fixed}`);
    }
  }
  for (const id of Object.keys(reasons)) {
    if (!command.ignored.includes(id)) problems.push(`${SELF}: reason for ${id}, which ${WORKFLOW} does not ignore`);
  }
  return problems;
}

/** @param {string} relative */
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

test('every advisory that audit.yml ignores still has its reason in Cargo.lock', () => {
  const problems = deviations(read(WORKFLOW), read(LOCKFILE), REASONS);
  assert.equal(problems.length, 0, `${WORKFLOW} disagrees with ${LOCKFILE}:\n${problems.join('\n')}`);
});

// npm: die Laufzeitpakete bei jeder Meldung, dazu alle Pakete ab der Stufe
// high, denn die Entwicklungspakete (Vite, rolldown, @tauri-apps/cli) bauen,
// was ausgeliefert wird. Beide ohne Installation, nur aus package-lock.json.
test('audit.yml audits the runtime packages at every level and all packages from high on', () => {
  const commands = lines(read(WORKFLOW)).map(stripComment).filter(line => /\bnpm audit\b/.test(line)).map(line => line.trim().split(/\s+/));
  assert.equal(commands.length, 2, `expected two "npm audit" lines in ${WORKFLOW}`);
  for (const words of commands) assert.ok(words.includes('--package-lock-only'), words.join(' '));
  const runtime = commands.filter(words => words.includes('--omit=dev')), all = commands.filter(words => !words.some(word => word.startsWith('--omit')));
  assert.equal(runtime.length, 1);
  assert.ok(!runtime[0].some(word => word.startsWith('--audit-level')), 'every advisory for a runtime package must fail the audit');
  assert.equal(all.length, 1);
  assert.ok(all[0].includes('--audit-level=high'), 'the audit of all packages fails from high on');
});

// Die Selbsttests zeigen mit synthetischem Text, dass der Abgleich beisst.
const workflow = (command ='cargo audit --deny unsound --ignore RUSTSEC-2023-0071 --ignore RUSTSEC-2024-0429') =>
  `name: Audit\njobs:\n  rust:\n    steps:\n      - run: cargo install cargo-audit --locked --version 0.22.2\n      # RUSTSEC-2023-0071: ein lokales \`cargo audit\` meldet sie weiter.\n      - run: ${command}\n`;
const lock = ({ rsa = ['0.10.0-rc.18'], glib = ['0.18.5'] } = {}) => [
  '# This file is automatically @generated by Cargo.\nversion = 4\n',
  '[[package]]\nname = "aidevbridge"\nversion = "0.3.1"\ndependencies = [\n "rsa",\n]\n',
  ...rsa.map(version => `[[package]]\nname = "rsa"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`),
  ...glib.map(version => `[[package]]\nname = "glib"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`),
  '[[package]]\nname = "glib-sys"\nversion = "0.18.1"\n',
].join('\n');

test('the check passes while every ignored advisory still affects Cargo.lock, with LF and with CRLF', () => {
  for (const eol of ['\n', '\r\n']) {
    assert.deepEqual(deviations(workflow().replaceAll('\n', eol), lock().replaceAll('\n', eol), REASONS), []);
  }
  // Schreibweise mit `=`, andere Reihenfolge und --deny warnings zaehlen gleich.
  assert.deepEqual(deviations(workflow('cargo audit --ignore=RUSTSEC-2024-0429 -D warnings --ignore RUSTSEC-2023-0071'), lock(), REASONS), []);
  // Eine betroffene Version genuegt, wenn zwei nebeneinander stehen.
  assert.deepEqual(deviations(workflow(), lock({ glib: ['0.18.5', '0.21.0'] }), REASONS), []);
});

test('the check reports an ignore whose package is fixed or gone', () => {
  assert.deepEqual(deviations(workflow(), lock({ rsa: ['0.10.0'] }), REASONS), [
    `${WORKFLOW}: --ignore RUSTSEC-2023-0071 is stale, ${LOCKFILE} has rsa 0.10.0 and the advisory is fixed in 0.10.0`,
  ]);
  assert.deepEqual(deviations(workflow(), lock({ rsa: ['0.10.2'], glib: ['0.20.0'] }), REASONS), [
    `${WORKFLOW}: --ignore RUSTSEC-2023-0071 is stale, ${LOCKFILE} has rsa 0.10.2 and the advisory is fixed in 0.10.0`,
    `${WORKFLOW}: --ignore RUSTSEC-2024-0429 is stale, ${LOCKFILE} has glib 0.20.0 and the advisory is fixed in 0.20.0`,
  ]);
  // glib-sys ist ein anderes Paket: Ohne glib selbst ist die Ausnahme veraltet.
  assert.deepEqual(deviations(workflow(), lock({ glib: [] }), REASONS), [
    `${WORKFLOW}: --ignore RUSTSEC-2024-0429 is stale, ${LOCKFILE} no longer contains glib`,
  ]);
});

test('the check reports an ignore without a reason and a reason without an ignore', () => {
  assert.deepEqual(deviations(workflow('cargo audit --deny unsound --ignore RUSTSEC-2023-0071 --ignore RUSTSEC-2024-0429 --ignore RUSTSEC-2026-9999'), lock(), REASONS), [
    `${WORKFLOW}: --ignore RUSTSEC-2026-9999 has no reason in ${SELF}`,
  ]);
  assert.deepEqual(deviations(workflow('cargo audit --deny unsound --ignore RUSTSEC-2023-0071'), lock(), REASONS), [
    `${SELF}: reason for RUSTSEC-2024-0429, which ${WORKFLOW} does not ignore`,
  ]);
  assert.deepEqual(deviations(workflow('cargo audit --deny unsound --ignore RUSTSEC-2023-0071 --ignore'), lock(), REASONS), [
    `${WORKFLOW}: --ignore without an advisory id: ""`,
  ]);
});

test('the check reports a cargo audit line that lets unsound notices pass, or none at all', () => {
  assert.deepEqual(deviations(workflow('cargo audit --ignore RUSTSEC-2023-0071 --ignore RUSTSEC-2024-0429'), lock(), REASONS), [
    `${WORKFLOW}: cargo audit lacks --deny unsound, so a new unsound notice would pass as a warning`,
  ]);
  assert.deepEqual(deviations(workflow('cargo deny check'), lock(), REASONS), [
    `${WORKFLOW}: expected exactly 1 "cargo audit" line, found 0`,
  ]);
});
