import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// vendor/russh ist das veroeffentlichte russh mit einem dokumentierten lokalen
// Patch. UPSTREAM-SHA256SUMS nennt die SHA-256 jeder Datei des unveraenderten
// Archivs, AGENTBRIDGE-PATCH.md unter "Changed files" die geaenderten und die
// hinzugefuegten Dateien. Dieser Test gleicht den Baum mit beiden ab:
// - Eine Upstream-Datei darf nur dann von ihrer Summe abweichen, wenn das
//   Patch-Dokument sie als geaendert nennt.
// - Eine als geaendert genannte Datei, die bytegleich mit Upstream ist, zeigt
//   ein veraltetes Dokument.
// - Jede versionierte Datei unter vendor/russh steht in den Summen oder ist
//   als hinzugefuegt genannt.
// .gitattributes (`* text=auto eol=lf`) haelt den Arbeitsbaum auch unter
// Windows auf LF, darum zaehlen die Bytes der Dateien, wie sie dort liegen.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = 'vendor/russh';
const SUMS = 'UPSTREAM-SHA256SUMS';
const PATCH = 'AGENTBRIDGE-PATCH.md';

/** @param {string} text */
const lines = text => text.replaceAll('\r\n', '\n').split('\n');
/** @param {crypto.BinaryLike} bytes */
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// UPSTREAM-SHA256SUMS im Format von sha256sum: 64 Hex-Zeichen, zwei
// Leerzeichen, Pfad relativ zum Paket mit `/`.
/**
 * @param {string} text
 * @returns {{ sums: Map<string, string>, errors: string[] }}
 */
function upstreamSums(text) {
  const sums = new Map();
  const errors = [];
  lines(text).forEach((line, index) => {
    if (line === '') return;
    const match = /^([0-9a-f]{64}) {2}(\S(?:.*\S)?)$/.exec(line);
    if (!match) errors.push(`${SUMS}:${index + 1}: not a "<sha256>  <path>" line`);
    else if (sums.has(match[2])) errors.push(`${SUMS}:${index + 1}: ${match[2]} is listed twice`);
    else sums.set(match[2], match[1]);
  });
  if (sums.size === 0) errors.push(`${SUMS}: lists no file`);
  return { sums, errors };
}

// Die beiden Listen unter "## Changed files". Ein Absatz mit "modified"
// leitet die geaenderten Dateien ein, einer mit "added" die hinzugefuegten.
// Ein Listenpunkt nennt seine Pfade in Backticks vor einer Klammer; was in
// der Klammer oder auf einer Folgezeile steht, erlaeutert nur
// ("`src/lib_inner.rs` (re-exports `ChannelEndObserver` ...").
/**
 * @param {string} text
 * @returns {{ changed: string[], added: string[], errors: string[] }}
 */
function patchLists(text) {
  const all = lines(text);
  const start = all.findIndex(line => /^## Changed files\s*$/.test(line));
  if (start < 0) return { changed: [], added: [], errors: [`${PATCH}: no "## Changed files" section`] };
  /** @type {{ changed: string[], added: string[] }} */
  const lists = { changed: [], added: [] };
  const errors = [];
  /** @type {'changed' | 'added' | null} */
  let kind = null;
  for (let index = start + 1; index < all.length && !/^#{1,2} /.test(all[index]); index++) {
    const line = all[index];
    if (/^\s*$/.test(line)) continue;
    if (!line.startsWith('- ')) {
      // Folgezeile eines Listenpunkts oder ein Absatz zwischen den Listen.
      if (/^\s/.test(line)) continue;
      if (/\bmodified\b/.test(line)) kind = 'changed';
      else if (/\badded\b/.test(line)) kind = 'added';
      continue;
    }
    const paths = [...line.slice(2).split('(')[0].matchAll(/`([^`]+)`/g)].map(match => match[1]);
    if (kind === null) errors.push(`${PATCH}:${index + 1}: list item before a paragraph that says "modified" or "added"`);
    else if (paths.length === 0) errors.push(`${PATCH}:${index + 1}: list item without a path in backticks`);
    else lists[kind].push(...paths);
  }
  for (const [name, list] of Object.entries(lists)) {
    if (list.length === 0) errors.push(`${PATCH}: the list of ${name} files under "## Changed files" is empty or was not found`);
    for (const file of list) {
      if (list.indexOf(file) !== list.lastIndexOf(file)) errors.push(`${PATCH}: ${file} is listed twice as ${name}`);
    }
  }
  return { ...lists, errors: [...new Set(errors)] };
}

// Jede Abweichung als eine Zeile. `files` sind die versionierten Dateien des
// Baums mit ihrer SHA-256, die Pfade relativ zu vendor/russh.
/**
 * @param {{ sums: Map<string, string>, changed: string[], added: string[], files: Map<string, string> }} tree
 * @returns {string[]}
 */
function deviations({ sums, changed, added, files }) {
  const problems = [];
  for (const [file, expected] of sums) {
    const actual = files.get(file);
    const documented = changed.includes(file);
    if (actual === undefined) problems.push(`${file}: upstream file is missing`);
    else if (actual !== expected && !documented) problems.push(`${file}: differs from upstream, but ${PATCH} does not name it as changed`);
    else if (actual === expected && documented) problems.push(`${file}: ${PATCH} names it as changed, but it is byte-identical with upstream`);
  }
  for (const file of changed) {
    if (!sums.has(file)) problems.push(`${file}: ${PATCH} names it as changed, but ${SUMS} does not list it`);
  }
  for (const file of added) {
    if (sums.has(file)) problems.push(`${file}: ${PATCH} names it as added, but ${SUMS} lists it as an upstream file`);
    else if (!files.has(file)) problems.push(`${file}: ${PATCH} names it as added, but it is missing`);
  }
  for (const file of files.keys()) {
    if (!sums.has(file) && !added.includes(file)) problems.push(`${file}: neither listed in ${SUMS} nor named as added in ${PATCH}`);
  }
  return problems;
}

// Die versionierten Dateien unter vendor/russh. Ohne Git (ein entpacktes
// Quellarchiv) zaehlt jede Datei, die dort liegt.
/** @returns {string[]} */
function trackedFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', VENDORED], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = output.split('\0').filter(Boolean).map(file => file.slice(VENDORED.length + 1));
    if (files.length > 0) return files;
  } catch {
    // Kein Git oder kein Repository: weiter mit dem Verzeichnis.
  }
  const base = path.join(ROOT, ...VENDORED.split('/'));
  return fs.readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(base, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

/** @param {string} relative */
const read = relative => fs.readFileSync(path.join(ROOT, ...VENDORED.split('/'), ...relative.split('/')));

test('vendor/russh is the published archive except for the files its patch document names', () => {
  const { sums, errors: sumErrors } = upstreamSums(read(SUMS).toString('utf8'));
  const { changed, added, errors: patchErrors } = patchLists(read(PATCH).toString('utf8'));
  assert.deepEqual([...sumErrors, ...patchErrors], []);
  const files = new Map();
  // Eine versionierte Datei, die im Arbeitsbaum fehlt, bleibt ohne Eintrag
  // und erscheint unten als fehlend.
  for (const file of trackedFiles()) {
    try {
      files.set(file, sha256(read(file)));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
  }
  const problems = deviations({ sums, changed, added, files });
  assert.equal(problems.length, 0, `${VENDORED} disagrees with ${SUMS} and ${PATCH}:\n${problems.join('\n')}`);
  // Ohne eine einzige geaenderte und eine unveraenderte Datei pruefte der
  // Abgleich nichts.
  assert.ok(changed.length > 0 && sums.size > changed.length);
});

// Die Selbsttests zeigen mit synthetischem Text, dass der Abgleich beisst.
const hash = (/** @type {string} */ c) => c.repeat(64);
const SUMS_TEXT = `${hash('a')}  Cargo.toml\n${hash('b')}  src/lib.rs\n${hash('c')}  src/client/mod.rs\n${hash('d')}  .cargo_vcs_info.json\n`;
const PATCH_TEXT = [
  '# Local patch', '', 'Changed for it: `src/session.rs`; new: `src/other.rs`.', '',
  '## Changed files', '',
  'Compared with the published archive, these upstream files are modified;', 'each starts with the two-line notice:', '',
  '- `src/client/mod.rs`', '- `src/lib.rs` (re-exports `Observer` and', '  `WindowCredit`)', '',
  'These files are added:', '',
  '- `src/channels/window_credit.rs`', '- `AGENTBRIDGE-PATCH.md`, `LICENSE-APACHE` and `UPSTREAM-SHA256SUMS`', '',
  'All other files are byte-identical with the published archive.', '',
].join('\n');
const tree = (/** @type {Record<string, string>} */ overrides = {}) => {
  const files = new Map([
    ['Cargo.toml', hash('a')], ['src/lib.rs', hash('1')], ['src/client/mod.rs', hash('2')], ['.cargo_vcs_info.json', hash('d')],
    ['src/channels/window_credit.rs', hash('3')], ['AGENTBRIDGE-PATCH.md', hash('4')], ['LICENSE-APACHE', hash('5')], ['UPSTREAM-SHA256SUMS', hash('6')],
  ]);
  for (const [file, value] of Object.entries(overrides)) {
    if (value === '') files.delete(file); else files.set(file, value);
  }
  return files;
};
const check = (/** @type {Map<string, string>} */ files, sumsText = SUMS_TEXT, patchText = PATCH_TEXT) => {
  const { sums, errors: sumErrors } = upstreamSums(sumsText);
  const { changed, added, errors: patchErrors } = patchLists(patchText);
  return [...sumErrors, ...patchErrors, ...deviations({ sums, changed, added, files })];
};

test('the sums and the two lists of the patch document are read, with LF and with CRLF', () => {
  for (const eol of ['\n', '\r\n']) {
    const { sums, errors } = upstreamSums(SUMS_TEXT.replaceAll('\n', eol));
    assert.deepEqual(errors, []);
    assert.deepEqual([...sums], [['Cargo.toml', hash('a')], ['src/lib.rs', hash('b')], ['src/client/mod.rs', hash('c')], ['.cargo_vcs_info.json', hash('d')]]);
    // Namen in der Klammer und auf der Folgezeile sind keine Pfade, und was
    // vor dem Abschnitt steht, zaehlt nicht.
    assert.deepEqual(patchLists(PATCH_TEXT.replaceAll('\n', eol)), {
      changed: ['src/client/mod.rs', 'src/lib.rs'],
      added: ['src/channels/window_credit.rs', 'AGENTBRIDGE-PATCH.md', 'LICENSE-APACHE', 'UPSTREAM-SHA256SUMS'],
      errors: [],
    });
    assert.deepEqual(check(tree(), SUMS_TEXT.replaceAll('\n', eol), PATCH_TEXT.replaceAll('\n', eol)), []);
  }
});

test('the check reports an upstream file that differs without being named as changed', () => {
  assert.deepEqual(check(tree({ 'Cargo.toml': hash('9') })), [`Cargo.toml: differs from upstream, but ${PATCH} does not name it as changed`]);
  assert.deepEqual(check(tree({ '.cargo_vcs_info.json': '' })), ['.cargo_vcs_info.json: upstream file is missing']);
});

test('the check reports a file named as changed that is byte-identical with upstream', () => {
  assert.deepEqual(check(tree({ 'src/lib.rs': hash('b') })), [`src/lib.rs: ${PATCH} names it as changed, but it is byte-identical with upstream`]);
  const unknown = PATCH_TEXT.replace('- `src/client/mod.rs`', '- `src/client/mod.rs`\n- `src/gone.rs`');
  assert.deepEqual(check(tree(), SUMS_TEXT, unknown), [`src/gone.rs: ${PATCH} names it as changed, but ${SUMS} does not list it`]);
});

test('the check reports a file that is neither upstream nor named as added, and a stale added entry', () => {
  assert.deepEqual(check(tree({ 'src/extra.rs': hash('7') })), [`src/extra.rs: neither listed in ${SUMS} nor named as added in ${PATCH}`]);
  assert.deepEqual(check(tree({ 'src/channels/window_credit.rs': '' })), [`src/channels/window_credit.rs: ${PATCH} names it as added, but it is missing`]);
  const upstreamNow = PATCH_TEXT.replace('- `src/channels/window_credit.rs`', '- `src/channels/window_credit.rs`\n- `Cargo.toml`');
  assert.deepEqual(check(tree(), SUMS_TEXT, upstreamNow), [`Cargo.toml: ${PATCH} names it as added, but ${SUMS} lists it as an upstream file`]);
});

test('the check reports sums and a patch document it cannot read', () => {
  assert.deepEqual(upstreamSums(`${hash('a')} Cargo.toml\n${hash('b')}  src/lib.rs\n${hash('c')}  src/lib.rs\nABC  x\n`).errors, [
    `${SUMS}:1: not a "<sha256>  <path>" line`, `${SUMS}:3: src/lib.rs is listed twice`, `${SUMS}:4: not a "<sha256>  <path>" line`,
  ]);
  assert.deepEqual(upstreamSums('\n').errors, [`${SUMS}: lists no file`]);
  assert.deepEqual(patchLists('# Patch\n\nNo section.\n').errors, [`${PATCH}: no "## Changed files" section`]);
  assert.deepEqual(patchLists('## Changed files\n\nThese files are added:\n\n- `a.rs`\n- `a.rs`\n').errors, [
    `${PATCH}: the list of changed files under "## Changed files" is empty or was not found`, `${PATCH}: a.rs is listed twice as added`,
  ]);
  assert.deepEqual(patchLists('## Changed files\n\n- `a.rs`\n\nThese upstream files are modified:\n\n- no path here\n- `b.rs`\n\nThese files are added:\n\n- `c.rs`\n').errors, [
    `${PATCH}:3: list item before a paragraph that says "modified" or "added"`, `${PATCH}:7: list item without a path in backticks`,
  ]);
});
