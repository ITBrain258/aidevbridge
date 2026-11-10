import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// packages.yml und android.yml veroeffentlichen nur bei einem Release, ihre
// Schritte dafuer laufen in keinem Pull Request. Dieser Test liest die beiden
// Dateien als Text, ohne YAML-Bibliothek, und haelt fest, was dort stehen
// muss:
// - Jeder Job, der fuer ein Release baut, prueft vor dem Bau, dass der Commit
//   auf main liegt (scripts/release-on-main.mjs), und nur in Laeufen, die
//   veroeffentlichen koennen.
// - Ein Release entsteht nie als "Latest"; die Marke setzt erst der Schritt
//   nach der Pruefung auf Vollstaendigkeit (scripts/release-latest.mjs).
// - Der Build-Job von android.yml fragt die gebaute APK nach ihrer Identitaet.
// - Jedes Skript, das ein Workflow aufruft, gibt es. CRLF zaehlt wie LF.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = '.github/workflows';
const PUBLISHING = "if: env.PUBLISH_TAG != ''";
// Je Workflow: die Jobs, die fuer ein Release bauen, mit ihrem Baubefehl, und
// der Job, der veroeffentlicht.
const RELEASE = {
  'packages.yml': { builds: { 'macos-package': 'npm run build:macos', 'windows-package': 'npm run build:windows' }, publish: 'publish' },
  'android.yml': { builds: { build: 'npm run tauri -- android build' }, publish: 'publish' },
};

/** @param {string} text */
const lines = text => text.replaceAll('\r\n', '\n').split('\n');
// Entfernt einen Kommentar ab `#`, aber nicht innerhalb von Anfuehrungszeichen.
/** @param {string} line */
const stripComment = line => (/^((?:[^#"']|"[^"]*"|'[^']*')*)/.exec(line) ?? ['', ''])[1].trimEnd();

// Die Schritte je Job: jeder Schritt als seine Zeilen ohne Kommentare, in der
// Reihenfolge der Datei. Jobs stehen mit zwei Leerzeichen unter `jobs:`,
// Schritte beginnen mit `      - `.
/**
 * @param {string} text
 * @returns {Map<string, string[][]>}
 */
function jobSteps(text) {
  const jobs = new Map();
  let inJobs = false;
  /** @type {string[][] | null} */
  let steps = null;
  for (const raw of lines(text)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    if (/^\S/.test(line)) { inJobs = line === 'jobs:'; steps = null; continue; }
    if (!inJobs) continue;
    const job = /^ {2}([\w-]+):$/.exec(line);
    if (job) { steps = []; jobs.set(job[1], steps); continue; }
    if (!steps) continue;
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (/^ {7,}\S/.test(line) && steps.length > 0) steps[steps.length - 1].push(line);
  }
  return jobs;
}

/** @param {string[][]} steps @param {string} needle */
const stepsWith = (steps, needle) => steps.map((step, index) => ({ step, index })).filter(({ step }) => step.some(line => line.includes(needle)));

// Jede Abweichung eines Workflows als eine Zeile.
/**
 * @param {string} name
 * @param {string} text
 * @param {{ builds: Record<string, string>, publish: string }} expected
 * @returns {string[]}
 */
function deviations(name, text, expected) {
  const jobs = jobSteps(text);
  const problems = [];
  for (const [job, command] of Object.entries(expected.builds)) {
    const steps = jobs.get(job);
    if (!steps) { problems.push(`${name}: no job ${job}`); continue; }
    const gates = stepsWith(steps, 'node scripts/release-on-main.mjs'), builds = stepsWith(steps, command);
    if (builds.length === 0) problems.push(`${name}: job ${job} has no step with "${command}"`);
    if (gates.length !== 1) problems.push(`${name}: job ${job} must check once that the commit to publish is on main, found ${gates.length} steps`);
    else {
      if (!gates[0].step.some(line => line.trim() === PUBLISHING)) problems.push(`${name}: the main check of job ${job} must run with "${PUBLISHING}"`);
      if (builds.length > 0 && gates[0].index > builds[0].index) problems.push(`${name}: the main check of job ${job} must come before "${command}"`);
    }
  }
  const publish = jobs.get(expected.publish) ?? [];
  const creates = [...jobs.values()].flat().flat().filter(line => line.includes('gh release create'));
  if (creates.length === 0) problems.push(`${name}: no "gh release create"`);
  for (const line of creates) {
    if (!/\s--latest=false(\s|$)/.test(line)) problems.push(`${name}: "gh release create" without --latest=false would make a half-finished release the latest one`);
    if (!/\s--verify-tag(\s|$)/.test(line)) problems.push(`${name}: "gh release create" without --verify-tag`);
  }
  const checks = stepsWith(publish, 'node scripts/release-latest.mjs'), marks = stepsWith(publish, 'gh release edit "$PUBLISH_TAG" --latest');
  const uploads = publish.map((step, index) => ({ step, index })).filter(({ step }) => step.some(line => /gh release (create|upload) /.test(line)));
  if (checks.length !== 1 || !checks[0].step.includes('        id: complete')) problems.push(`${name}: job ${expected.publish} needs one step with id "complete" that runs scripts/release-latest.mjs`);
  else if (uploads.length === 0 || checks[0].index < uploads.at(-1).index) problems.push(`${name}: the check for a complete release must come after the upload`);
  if (marks.length !== 1 || !marks[0].step.includes("        if: steps.complete.outputs.latest == 'true'")) problems.push(`${name}: job ${expected.publish} must mark the release as latest in one step with "if: steps.complete.outputs.latest == 'true'"`);
  else if (checks.length === 1 && marks[0].index < checks[0].index) problems.push(`${name}: the release is marked as latest before the check for a complete release`);
  const others = [...jobs.values()].flat().flat().filter(line => /gh release edit .*\s--latest(?!=false)(?:[\s=]|$)/.test(line)).length - marks.length;
  if (others > 0) problems.push(`${name}: the release is marked as latest outside the step that follows the check`);
  return problems;
}

/** @param {string} relative */
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

test('the release workflows check main before they build and mark a release as latest only when it is complete', () => {
  const problems = Object.entries(RELEASE).flatMap(([name, expected]) => deviations(name, read(`${WORKFLOWS}/${name}`), expected));
  assert.equal(problems.length, 0, `The release workflows lack a safeguard:\n${problems.join('\n')}`);
});

test('android.yml asks the built APK for its identity in the build job, before anything is signed', () => {
  const jobs = jobSteps(read(`${WORKFLOWS}/android.yml`));
  const build = jobs.get('build') ?? [];
  const identity = stepsWith(build, 'node scripts/android-apk-identity.mjs'), built = stepsWith(build, 'npm run tauri -- android build'), collected = stepsWith(build, 'actions/upload-artifact@');
  assert.equal(identity.length, 1);
  assert.ok(identity[0].step.some(line => line.includes('aapt2" dump badging')));
  assert.ok(built.length === 1 && built[0].index < identity[0].index, 'the identity check must follow the build');
  assert.ok(collected.length >= 1 && identity[0].index < collected[0].index, 'the identity check must come before the files leave the job');
  // Der Job mit dem Schluessel fuehrt nur die Signierwerkzeuge aus.
  assert.deepEqual(stepsWith(jobs.get('sign') ?? [[]], 'node scripts/'), []);
});

test('every script a workflow runs exists', () => {
  const missing = [];
  let found = 0;
  for (const name of fs.readdirSync(path.join(ROOT, ...WORKFLOWS.split('/'))).filter(file => /\.ya?ml$/.test(file)).sort()) {
    for (const line of lines(read(`${WORKFLOWS}/${name}`)).map(stripComment)) {
      for (const match of line.matchAll(/(?:^|[\s"'=])(scripts\/[\w./-]+\.(?:mjs|ps1))/g)) {
        found++;
        if (!fs.existsSync(path.join(ROOT, ...match[1].split('/')))) missing.push(`${name}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(found >= 10, `expected the workflows to run scripts, found ${found} calls`);
});

// Die Selbsttests zeigen mit synthetischem Text, dass der Abgleich beisst.
const workflow = ({
  gateIf = `        ${PUBLISHING}\n`,
  gate = `      - name: The commit to publish is on main\n${gateIf}        run: node scripts/release-on-main.mjs\n`,
  beforeBuild = gate, afterBuild = '',
  create = 'gh release create "$tag" "$apk" --verify-tag --latest=false --title "x"',
  check = '      - name: Check whether the release has every package\n        id: complete\n        run: |\n          node scripts/release-latest.mjs "${PUBLISH_TAG#v}" --output "$GITHUB_OUTPUT"\n',
  mark = "      - name: Mark the release as the latest one\n        if: steps.complete.outputs.latest == 'true'\n        run: gh release edit \"$PUBLISH_TAG\" --latest\n",
  order = (/** @type {string} */ attach, /** @type {string} */ checkStep, /** @type {string} */ markStep) => `${attach}${checkStep}${markStep}`,
} = {}) => [
  'name: Android\n# node scripts/release-on-main.mjs steht auch in diesem Kommentar\non:\n  push:\n    tags: [\'v*\']\njobs:\n',
  '  build:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@0000000000000000000000000000000000000000 # v1\n',
  beforeBuild,
  '      # Der Bau.\n      - name: Build\n        run: |\n          set -euo pipefail\n          npm run tauri -- android build --ci --apk\n',
  afterBuild,
  '  publish:\n    needs: build\n    steps:\n',
  order(`      - name: Attach the APK, or create the release\n        run: |\n          if [ "$EXISTS" = true ]; then\n            gh release upload "$tag" "$apk"\n          else\n            ${create}\n          fi\n`, check, mark),
].join('');
const expected = RELEASE['android.yml'];

test('the check passes on a workflow with every safeguard, with LF and with CRLF', () => {
  for (const eol of ['\n', '\r\n']) assert.deepEqual(deviations('android.yml', workflow().replaceAll('\n', eol), expected), []);
});

test('the check reports a build job without the main check, with an unconditional one or with one after the build', () => {
  assert.deepEqual(deviations('android.yml', workflow({ beforeBuild: '' }), expected), [
    'android.yml: job build must check once that the commit to publish is on main, found 0 steps',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ gateIf: '' }), expected), [
    `android.yml: the main check of job build must run with "${PUBLISHING}"`,
  ]);
  const gate = `      - name: The commit to publish is on main\n        ${PUBLISHING}\n        run: node scripts/release-on-main.mjs\n`;
  assert.deepEqual(deviations('android.yml', workflow({ beforeBuild: '', afterBuild: gate }), expected), [
    'android.yml: the main check of job build must come before "npm run tauri -- android build"',
  ]);
  assert.deepEqual(deviations('android.yml', workflow(), { builds: { other: 'make' }, publish: 'publish' }), ['android.yml: no job other']);
});

test('the check reports a release that would be created or marked as latest too early', () => {
  assert.deepEqual(deviations('android.yml', workflow({ create: 'gh release create "$tag" "$apk" --verify-tag --title "x"' }), expected), [
    'android.yml: "gh release create" without --latest=false would make a half-finished release the latest one',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ create: 'gh release create "$tag" "$apk" --latest=false' }), expected), [
    'android.yml: "gh release create" without --verify-tag',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ check: '' }), expected), [
    'android.yml: job publish needs one step with id "complete" that runs scripts/release-latest.mjs',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ mark: '      - name: Mark the release as the latest one\n        run: gh release edit "$PUBLISH_TAG" --latest\n' }), expected), [
    'android.yml: job publish must mark the release as latest in one step with "if: steps.complete.outputs.latest == \'true\'"',
  ]);
  // Die Marke beim Schreiben des Textes zu setzen, kaeme vor der Pruefung;
  // --latest=false dort ist erlaubt.
  const created = 'gh release create "$tag" "$apk" --verify-tag --latest=false --title "x"\n            gh release edit "$tag"';
  assert.deepEqual(deviations('android.yml', workflow({ create: `${created} --latest --notes-file notes.md` }), expected), [
    'android.yml: the release is marked as latest outside the step that follows the check',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ create: `${created} --notes-file notes.md --latest` }), expected), [
    'android.yml: the release is marked as latest outside the step that follows the check',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ create: `${created} --latest=false --notes-file notes.md` }), expected), []);
  assert.deepEqual(deviations('android.yml', workflow({ order: (attach, check, mark) => `${check}${attach}${mark}` }), expected), [
    'android.yml: the check for a complete release must come after the upload',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ order: (attach, check, mark) => `${attach}${mark}${check}` }), expected), [
    'android.yml: the release is marked as latest before the check for a complete release',
  ]);
});
