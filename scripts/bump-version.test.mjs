import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cargoLockHasVersion } from './bump-version.mjs';

const SCRIPT = fileURLToPath(new URL('./bump-version.mjs', import.meta.url));
const lock = (...entries) =>
  ['version = 4', '', ...entries.map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`)].join('\n');
const crlf = text => text.replaceAll('\n', '\r\n');

// Ein leeres Arbeitsverzeichnis: Liest das Skript dort package.json oder
// Cargo.lock, scheitert es laut, statt still die Dateien des Repos zu lesen.
function emptyDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a dot in the version matches only a dot', () => {
  assert.equal(cargoLockHasVersion(lock(['aidevbridge', '0x2y3']), 'aidevbridge', '0.2.3'), false);
});

test('the exact entry matches with LF and with CRLF line endings', () => {
  const text = lock(['anyhow', '1.0.0'], ['aidevbridge', '0.2.3'], ['zeroize', '1.8.1']);
  assert.equal(cargoLockHasVersion(text, 'aidevbridge', '0.2.3'), true);
  assert.equal(cargoLockHasVersion(crlf(text), 'aidevbridge', '0.2.3'), true);
  assert.equal(cargoLockHasVersion(text, 'aidevbridge', '0.2.4'), false);
  assert.equal(cargoLockHasVersion(lock(['aidevbridge', '0.2.30']), 'aidevbridge', '0.2.3'), false);
});

test('another crate with the same version does not count', () => {
  const text = lock(['aidevbridge', '0.2.2'], ['aidevbridge-core', '0.2.3'], ['other', '0.2.3']);
  assert.equal(cargoLockHasVersion(text, 'aidevbridge', '0.2.3'), false);
  assert.equal(cargoLockHasVersion(crlf(text), 'aidevbridge', '0.2.3'), false);
  assert.equal(cargoLockHasVersion(text, 'aidevbridge-core', '0.2.3'), true);
});

test('importing the module reads and writes no files', t => {
  const cwd = emptyDir(t);
  // Ein gueltiges Versionsargument an der Stelle, an der das Skript es als
  // Programm erwartet: Laeuft beim Import etwas davon, liest es im leeren
  // Verzeichnis package.json und bricht ab.
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`, 'import-only', '9.9.9'],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, '');
  assert.equal(run.status, 0);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('without a version the program prints its usage and exits with 1', t => {
  const cwd = emptyDir(t);
  const run = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /bump-version\.mjs <major\.minor\.patch>/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});
