import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionCode } from './android-version.mjs';

// Google Play zeigt unter "Neuigkeiten" changelogs/<versionCode>.txt jeder
// Sprache aus fastlane/metadata; fehlt die Datei, nimmt android.yml
// changelogs/default.txt ("Erste Android-Version"), ohne den Tag scheitern zu
// lassen. Darum prueft dieser Test fuer die Version in package.json, dass
// jede Sprache ihre Datei hat, nicht leer und hoechstens 500 Zeichen lang
// (die Grenze von Google Play). versionCode wie Tauri und android.yml:
// major * 1000000 + minor * 1000 + patch (android-version.mjs). android.yml
// rechnet die Formel in bash ein zweites Mal; der Test vergleicht den Text
// beider Stellen, damit sie nicht unbemerkt auseinanderlaufen.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METADATA = path.join(ROOT, 'fastlane', 'metadata', 'android');
const PLAY_LIMIT = 500;
// Die Formel als Text, wie sie in android-version.mjs und in android.yml steht
// (in JavaScript und in der Arithmetik von bash derselbe Ausdruck), und die
// Zeile von android.yml, die den Tag davor in major, minor und patch zerlegt.
const FORMULA = 'major * 1000000 + minor * 1000 + patch';
const SPLIT = 'IFS=. read -r major minor patch <<< "${PUBLISH_TAG#v}"';

// Jede Abweichung der beiden Stellen von der Formel als eine Zeile. Leerraum
// zaehlt nicht: in der Formel gar nicht, in der Zeile mit `read` nicht seine
// Menge. CRLF zaehlt wie LF.
/**
 * @param {string} moduleText Text von scripts/android-version.mjs
 * @param {string} workflowText Text von .github/workflows/android.yml
 * @returns {string[]}
 */
function formulaProblems(moduleText, workflowText) {
  /** @param {string} text */
  const squeeze = text => text.replace(/\s+/g, '');
  /** @param {string} text */
  const rows = text => text.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' '));
  const problems = [];
  const returned = rows(moduleText).filter(line => line.startsWith('return '));
  if (!returned.some(line => squeeze(line) === squeeze(`return ${FORMULA};`))) {
    problems.push(`scripts/android-version.mjs: versionCode must return "${FORMULA}", found ${JSON.stringify(returned)}`);
  }
  const workflow = rows(workflowText);
  const computed = workflow.filter(line => /^code=/.test(line)), at = workflow.indexOf(computed[0]);
  if (computed.length !== 1 || squeeze(computed[0]) !== squeeze(`code=$((${FORMULA}))`)) {
    problems.push(`.github/workflows/android.yml: the versionCode for the store texts must be "code=$((${FORMULA}))", found ${JSON.stringify(computed)}`);
  } else if (workflow[at - 1] !== SPLIT) {
    problems.push(`.github/workflows/android.yml: the line before the versionCode must be ${JSON.stringify(SPLIT)}, found ${JSON.stringify(workflow[at - 1])}`);
  }
  return problems;
}

test('versionCode follows the Tauri formula', () => {
  assert.equal(versionCode('0.3.0'), 3000);
  assert.equal(versionCode('0.3.1'), 3001);
  assert.equal(versionCode('0.2.7'), 2007);
  assert.equal(versionCode('1.0.12'), 1000012);
  assert.throws(() => versionCode('0.3'));
  assert.throws(() => versionCode('v0.3.1'));
  assert.throws(() => versionCode('0.3.1-rc.1'));
});

/** @param {string} relative */
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

test('android.yml computes the versionCode for the store texts with the formula of android-version.mjs', () => {
  assert.deepEqual(formulaProblems(read('scripts/android-version.mjs'), read('.github/workflows/android.yml')), []);
});

// Der Selbsttest aendert den echten Text beider Dateien nur im Speicher.
test('the comparison reports a formula that differs in android.yml or in android-version.mjs', () => {
  const module = read('scripts/android-version.mjs'), workflow = read('.github/workflows/android.yml');
  /** @param {string} text @param {string} from @param {string} to */
  const changed = (text, from, to) => {
    assert.ok(text.includes(from), `expected ${JSON.stringify(from)} in the text`);
    return text.replace(from, () => to);
  };
  const bash = `code=$((${FORMULA}))`;
  // Leerraum und CRLF aendern nichts.
  assert.deepEqual(formulaProblems(module.replaceAll('\n', '\r\n'), workflow.replaceAll('\n', '\r\n')), []);
  assert.deepEqual(formulaProblems(module, changed(workflow, bash, 'code=$(( major*1000000 + minor*1000 + patch ))')), []);
  assert.deepEqual(formulaProblems(module, changed(workflow, SPLIT, SPLIT.replace('read -r major', 'read  -r  major'))), []);
  assert.deepEqual(formulaProblems(module, changed(workflow, bash, 'code=$((major * 1000000 + minor * 100 + patch))')), [
    `.github/workflows/android.yml: the versionCode for the store texts must be "${bash}", found ["code=$((major * 1000000 + minor * 100 + patch))"]`,
  ]);
  assert.deepEqual(formulaProblems(module, changed(workflow, `          ${bash}\n`, '')), [
    `.github/workflows/android.yml: the versionCode for the store texts must be "${bash}", found []`,
  ]);
  // Dieselbe Formel mit vertauschten Teilen der Version rechnet etwas anderes.
  const swapped = SPLIT.replace('major minor patch', 'minor major patch');
  assert.deepEqual(formulaProblems(module, changed(workflow, SPLIT, swapped)), [
    `.github/workflows/android.yml: the line before the versionCode must be ${JSON.stringify(SPLIT)}, found ${JSON.stringify(swapped)}`,
  ]);
  // Aendert sich die Formel im Modul, muss android.yml folgen.
  const moved = changed(module, `return ${FORMULA};`, 'return major * 10000 + minor * 100 + patch;');
  assert.deepEqual(formulaProblems(moved, workflow), [
    `scripts/android-version.mjs: versionCode must return "${FORMULA}", found ["return major * 10000 + minor * 100 + patch;"]`,
  ]);
});

test('every store language has the changelog of the current version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const code = versionCode(pkg.version);
  const locales = fs.readdirSync(METADATA, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(locales.length >= 2, 'expected the store languages under fastlane/metadata/android');
  for (const locale of locales) {
    const file = path.join(METADATA, locale.name, 'changelogs', `${code}.txt`);
    assert.ok(fs.existsSync(file), `${locale.name}: missing changelogs/${code}.txt for ${pkg.version}`);
    const text = fs.readFileSync(file, 'utf8').trim();
    assert.ok(text.length > 0, `${locale.name}: changelogs/${code}.txt is empty`);
    const characters = Array.from(text).length;
    assert.ok(characters <= PLAY_LIMIT, `${locale.name}: changelogs/${code}.txt has ${characters} characters, Google Play takes ${PLAY_LIMIT}`);
  }
});
