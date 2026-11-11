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
//   veroeffentlichen koennen. Der Schritt besteht aus genau diesem Aufruf, und
//   der Job checkt genau einmal aus, davor.
// - Wer signiert, installiert oder veroeffentlicht, haengt ueber `needs` an
//   den Jobs davor.
// - Ein Release entsteht nie als "Latest"; die Marke setzt erst der Schritt
//   nach der Pruefung auf Vollstaendigkeit (scripts/release-latest.mjs), deren
//   Ergebnis nur dieses Skript schreibt. Wer davor den Text des Release
//   schreibt, laesst die Marke, wo sie ist.
// - Der Build-Job von android.yml fragt die gebaute APK nach ihrer Identitaet.
// - Jedes Skript, das ein Workflow aufruft, gibt es. CRLF zaehlt wie LF, eine
//   mit `\` fortgesetzte Zeile wie eine einzige.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = '.github/workflows';
const PUBLISHING = "if: env.PUBLISH_TAG != ''";
const GATE = 'run: node scripts/release-on-main.mjs';
const COMPLETE = "if: steps.complete.outputs.latest == 'true'";
const MARK = 'run: gh release edit "$PUBLISH_TAG" --latest';
// Die Zeile vor `gh release edit ... "$keep"`: Sie gibt dem Aufruf die Marke
// mit, die das Release gerade hat.
const KEEP = 'if [ "$(gh api "repos/$GH_REPO/releases/latest" --jq .tag_name 2> /dev/null || true)" = "$tag" ]; then keep=--latest; else keep=--latest=false; fi';
// Je Workflow: die Jobs, die fuer ein Release bauen, mit ihrem Baubefehl, der
// Job, der veroeffentlicht, und die Jobs, die auf andere warten, mit genau
// diesen.
const RELEASE = {
  'packages.yml': {
    builds: { 'macos-package': 'npm run build:macos', 'windows-package': 'npm run build:windows' },
    publish: 'publish',
    needs: { 'macos-install': ['macos-package'], 'windows-install': ['windows-package'], publish: ['macos-package', 'macos-install', 'windows-package', 'windows-install'] },
  },
  'android.yml': { builds: { build: 'npm run tauri -- android build' }, publish: 'publish', needs: { sign: ['build'], publish: ['sign'], play: ['sign'] } },
};

/** @param {string} text */
const lines = text => text.replaceAll('\r\n', '\n').split('\n');
// Entfernt einen Kommentar: ab einem `#` am Zeilenanfang oder nach Leerraum,
// ausserhalb von Anfuehrungszeichen. So lesen ihn YAML und die Shell; ein `#`
// in einem Wort (`${tag#v}`, `a#b`) beginnt keinen. Bleibt in der Zeile ein
// Anfuehrungszeichen offen (ein Text ueber mehrere Zeilen), bleibt sie ganz
// stehen: Der Abgleich sieht dann eher einen Kommentar zu viel als einen
// Befehl zu wenig.
/** @param {string} line */
const stripComment = line => {
  const [, code, rest] = /^((?:(?:[^\s"'#]|"[^"]*"|'[^']*')#*|\s+)*)(.*)$/.exec(line) ?? ['', line, ''];
  return (rest.startsWith('#') ? code : line).trimEnd();
};

// Die Zeilen ohne Kommentare. Eine Zeile, die mit `\` endet, setzt die Shell
// in der naechsten fort; beide zaehlen hier als eine, mit der Einrueckung der
// ersten. Ein `\` in einem Kommentar setzt nichts fort.
/**
 * @param {string} text
 * @returns {string[]}
 */
function logicalLines(text) {
  /** @type {string[]} */
  const joined = [];
  let open = false;
  for (const raw of lines(text)) {
    const line = stripComment(raw);
    const continues = raw.endsWith('\\') && line.endsWith('\\');
    const part = continues ? line.slice(0, -1).trimEnd() : line;
    if (open) joined[joined.length - 1] = `${joined[joined.length - 1]} ${part.trim()}`.trimEnd();
    else joined.push(part);
    open = continues;
  }
  return joined;
}

// Die Jobs eines Workflows: je Job, worauf er wartet (`needs`, als ein Name,
// als Liste in eckigen Klammern oder als Liste mit Spiegelstrichen), und seine
// Schritte, jeder als seine Zeilen ohne Kommentare in der Reihenfolge der
// Datei. Jobs stehen mit zwei Leerzeichen unter `jobs:`, ihre Schluessel mit
// vier, Schritte beginnen mit `      - ` unter `steps:`.
/**
 * @typedef {{ needs: string[], steps: string[][] }} Job
 * @param {string} text
 * @returns {Map<string, Job>}
 */
function workflowJobs(text) {
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** @param {string} value */
  const names = value => value.replace(/^\[(.*)\]$/, '$1').split(',').map(name => name.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
  let inJobs = false, key = '';
  /** @type {Job | null} */
  let current = null;
  for (const line of logicalLines(text)) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) { inJobs = line === 'jobs:'; current = null; continue; }
    if (!inJobs) continue;
    const job = /^ {2}([\w-]+):$/.exec(line);
    if (job) { current = { needs: [], steps: [] }; jobs.set(job[1], current); key = ''; continue; }
    if (!current) continue;
    const entry = /^ {4}([\w-]+):\s*(.*)$/.exec(line);
    if (entry) {
      key = entry[1];
      if (key === 'needs') current.needs.push(...names(entry[2]));
    } else if (key === 'needs') {
      current.needs.push(...names(/^ {6}- (.*)$/.exec(line)?.[1] ?? ''));
    } else if (key === 'steps') {
      if (/^ {6}- /.test(line)) current.steps.push([line]);
      else if (/^ {7,}\S/.test(line) && current.steps.length > 0) current.steps[current.steps.length - 1].push(line);
    }
  }
  return jobs;
}

/** @param {string[][]} steps @param {string} needle */
const stepsWith = (steps, needle) => steps.map((step, index) => ({ step, index })).filter(({ step }) => step.some(line => line.includes(needle)));
// Ob der Schritt den Eintrag (Schluessel und Wert) genau so hat: als eigene
// Zeile auf der Ebene des Schritts und ohne tiefer eingerueckte Zeile danach,
// die YAML an den Wert haengt (`|| true` in der Folgezeile).
/** @param {string[]} step @param {string} entry */
const hasEntry = (step, entry) => step.some((line, index) => (line === `        ${entry}` || line === `      - ${entry}`) && !/^ {9,}\S/.test(step[index + 1] ?? ''));

// Jede Abweichung eines Workflows als eine Zeile.
/**
 * @param {string} name
 * @param {string} text
 * @param {{ builds: Record<string, string>, publish: string, needs: Record<string, string[]> }} expected
 * @returns {string[]}
 */
function deviations(name, text, expected) {
  const jobs = workflowJobs(text);
  const problems = [];
  for (const [job, command] of Object.entries(expected.builds)) {
    const steps = jobs.get(job)?.steps;
    if (!steps) { problems.push(`${name}: no job ${job}`); continue; }
    const gates = stepsWith(steps, 'node scripts/release-on-main.mjs'), builds = stepsWith(steps, command), checkouts = stepsWith(steps, 'actions/checkout');
    if (builds.length === 0) problems.push(`${name}: job ${job} has no step with "${command}"`);
    if (gates.length !== 1) problems.push(`${name}: job ${job} must check once that the commit to publish is on main, found ${gates.length} steps`);
    else {
      const gate = gates[0];
      if (!hasEntry(gate.step, PUBLISHING)) problems.push(`${name}: the main check of job ${job} must run with "${PUBLISHING}"`);
      // `|| true`, continue-on-error, eine andere Shell: Alles, was den
      // Schritt bestehen laesst, obwohl das Skript scheitert, steht in der
      // Zeile `run` oder in einer weiteren Zeile.
      if (!hasEntry(gate.step, GATE)) problems.push(`${name}: the main check of job ${job} must be exactly "${GATE}"`);
      const extra = gate.step.map((line, index) => (index === 0 ? line.replace(/^ {6}- /, '        ') : line)).filter(line => !/^ {8}(?:name|if|run): /.test(line));
      if (extra.length > 0) problems.push(`${name}: the main check of job ${job} must have nothing but its name, "if" and "run", found "${extra[0].trim()}"`);
      if (builds.length > 0 && gate.index > builds[0].index) problems.push(`${name}: the main check of job ${job} must come before "${command}"`);
      // Die Pruefung gilt dem ausgecheckten Commit; ein zweiter Checkout nach
      // ihr baute einen anderen.
      if (checkouts.length !== 1) problems.push(`${name}: job ${job} must check out the source once, found ${checkouts.length} checkout steps`);
      else if (checkouts[0].index > gate.index) problems.push(`${name}: job ${job} must check out the source before the main check, which tests the checked-out commit`);
    }
  }
  // Ohne `needs` liefe ein Job neben dem, der prueft, statt nach ihm.
  for (const [job, needed] of Object.entries(expected.needs)) {
    const needs = jobs.get(job)?.needs;
    if (!needs) problems.push(`${name}: no job ${job}`);
    else if ([...needs].sort().join(' ') !== [...needed].sort().join(' ')) problems.push(`${name}: job ${job} must need exactly ${needed.join(', ')}, found ${needs.join(', ') || 'none'}`);
  }
  const all = [...jobs.values()].flatMap(job => job.steps), publish = jobs.get(expected.publish)?.steps ?? [];
  const creates = all.flat().filter(line => line.includes('gh release create'));
  if (creates.length === 0) problems.push(`${name}: no "gh release create"`);
  for (const line of creates) {
    if (!/\s--latest=false(\s|$)/.test(line)) problems.push(`${name}: "gh release create" without --latest=false would make a half-finished release the latest one`);
    if (!/\s--verify-tag(\s|$)/.test(line)) problems.push(`${name}: "gh release create" without --verify-tag`);
  }
  const checks = stepsWith(publish, 'node scripts/release-latest.mjs'), marks = publish.map((step, index) => ({ step, index })).filter(({ step }) => hasEntry(step, MARK));
  const uploads = publish.map((step, index) => ({ step, index })).filter(({ step }) => step.some(line => /gh release (create|upload) /.test(line)));
  if (checks.length !== 1 || !hasEntry(checks[0].step, 'id: complete')) problems.push(`${name}: job ${expected.publish} needs one step with id "complete" that runs scripts/release-latest.mjs`);
  else {
    if (uploads.length === 0 || checks[0].index < uploads.at(-1).index) problems.push(`${name}: the check for a complete release must come after the upload`);
    // `|| echo latest=true >> "$GITHUB_OUTPUT"` machte aus jedem Fehler der
    // Pruefung ein vollstaendiges Release.
    const writers = checks[0].step.filter(line => /GITHUB_OUTPUT|set-output/.test(line));
    if (writers.length !== 1 || !writers[0].includes('node scripts/release-latest.mjs') || writers[0].split('GITHUB_OUTPUT').length !== 2 || !/\s--output "\$GITHUB_OUTPUT"(\s|$)/.test(writers[0])) {
      problems.push(`${name}: in the step with id "complete" only scripts/release-latest.mjs may write the output, with --output "$GITHUB_OUTPUT"`);
    }
  }
  if (marks.length !== 1 || !hasEntry(marks[0].step, COMPLETE)) problems.push(`${name}: job ${expected.publish} must mark the release as latest in one step with "${COMPLETE}" and exactly "${MARK}"`);
  else if (checks.length === 1 && marks[0].index < checks[0].index) problems.push(`${name}: the release is marked as latest before the check for a complete release`);
  const others = all.flat().filter(line => /gh release edit .*\s--latest(?!=false)(?:[\s=]|$)/.test(line)).length - marks.length;
  if (others > 0) problems.push(`${name}: the release is marked as latest outside the step that follows the check`);
  // gh sendet make_latest nur mit --latest, und was GitHub ohne das Feld mit
  // der Marke eines veroeffentlichten Release tut, ist nicht zugesagt. Darum
  // nennt jeder weitere Aufruf die Marke: --latest=false, oder "$keep" aus
  // der Zeile davor, die nachsieht, welches Release sie gerade hat.
  for (const step of all) {
    step.forEach((line, index) => {
      if (!line.includes('gh release edit') || /\s--latest(?:[\s=]|$)/.test(line)) return;
      if (!/\s"\$keep"(\s|$)/.test(line) || step[index - 1]?.trim() !== KEEP) problems.push(`${name}: "gh release edit" must say what becomes of the mark: --latest=false, or "$keep" from the line before it that asks which release is the latest one now`);
    });
  }
  return problems;
}

/** @param {string} relative */
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

test('the release workflows check main before they build and mark a release as latest only when it is complete', () => {
  const problems = Object.entries(RELEASE).flatMap(([name, expected]) => deviations(name, read(`${WORKFLOWS}/${name}`), expected));
  assert.equal(problems.length, 0, `The release workflows lack a safeguard:\n${problems.join('\n')}`);
});

test('android.yml asks the built APK for its identity in the build job, before anything is signed', () => {
  const jobs = workflowJobs(read(`${WORKFLOWS}/android.yml`));
  const build = jobs.get('build')?.steps ?? [];
  const identity = stepsWith(build, 'node scripts/android-apk-identity.mjs'), built = stepsWith(build, 'npm run tauri -- android build'), collected = stepsWith(build, 'actions/upload-artifact@');
  assert.equal(identity.length, 1);
  assert.ok(identity[0].step.some(line => line.includes('aapt2" dump badging')));
  assert.ok(built.length === 1 && built[0].index < identity[0].index, 'the identity check must follow the build');
  assert.ok(collected.length >= 1 && identity[0].index < collected[0].index, 'the identity check must come before the files leave the job');
  // Der Job mit dem Schluessel fuehrt nur die Signierwerkzeuge aus.
  assert.deepEqual(stepsWith(jobs.get('sign')?.steps ?? [], 'node scripts/'), []);
});

test('android.yml records the evidence of every native library it builds, in the build job', () => {
  const jobs = workflowJobs(read(`${WORKFLOWS}/android.yml`));
  const build = jobs.get('build')?.steps ?? [];
  const evidence = stepsWith(build, 'node scripts/android-native-evidence.mjs'), built = stepsWith(build, 'npm run tauri -- android build');
  assert.equal(evidence.length, 1);
  assert.ok(built.length === 1 && built[0].index < evidence[0].index, 'the evidence must follow the build');
  // Ein Release baut drei ABIs; die Liste der Belege muss dieselben drei nennen.
  const release = built[0].step.find(line => line.includes('--aab'));
  assert.match(release ?? '', /--target aarch64 armv7 x86_64$/);
  assert.ok(evidence[0].step.some(line => line.includes('targets=(aarch64-linux-android armv7-linux-androideabi x86_64-linux-android)')));
  const upload = stepsWith(build, 'name: android-native-evidence');
  assert.ok(upload.length === 1 && upload[0].index > evidence[0].index, 'the evidence file must leave the job as its own artifact');
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
const CHECKOUT = '      - uses: actions/checkout@0000000000000000000000000000000000000000 # v1\n';
const GATE_STEP = `      - name: The commit to publish is on main\n        ${PUBLISHING}\n        ${GATE}\n`;
const workflow = ({
  checkout = CHECKOUT,
  gateIf = `        ${PUBLISHING}\n`,
  gateRun = `        ${GATE}\n`,
  gate = `      - name: The commit to publish is on main\n${gateIf}${gateRun}`,
  beforeBuild = gate, afterBuild = '',
  signNeeds = '    needs: build\n', publishNeeds = '    needs: sign\n', playNeeds = '    needs: [sign]\n',
  edit = `${KEEP}\n            gh release edit "$tag" --notes-file notes.md "$keep"`,
  create = 'gh release create "$tag" "$apk" --verify-tag --latest=false --title "x"',
  written = '',
  check = `      - name: Check whether the release has every package\n        id: complete\n        run: |\n          node scripts/release-latest.mjs "\${PUBLISH_TAG#v}" --output "$GITHUB_OUTPUT"${written}\n`,
  markIf = `        ${COMPLETE}\n`,
  markRun = `        ${MARK}\n`,
  mark = `      - name: Mark the release as the latest one\n${markIf}${markRun}`,
  order = (/** @type {string} */ attach, /** @type {string} */ checkStep, /** @type {string} */ markStep) => `${attach}${checkStep}${markStep}`,
} = {}) => [
  'name: Android\n# node scripts/release-on-main.mjs steht auch in diesem Kommentar\non:\n  push:\n    tags: [\'v*\']\njobs:\n',
  `  build:\n    runs-on: ubuntu-24.04\n    steps:\n${checkout}`,
  beforeBuild,
  '      # Der Bau.\n      - name: Build\n        run: |\n          set -euo pipefail\n          npm run tauri -- android build --ci --apk\n',
  afterBuild,
  `  sign:\n${signNeeds}    steps:\n      - run: apksigner sign\n`,
  `  publish:\n${publishNeeds}    steps:\n`,
  order(`      - name: Attach the APK, or create the release\n        run: |\n          if [ "$EXISTS" = true ]; then\n            gh release upload "$tag" "$apk"\n            ${edit}\n          else\n            ${create}\n          fi\n`, check, mark),
  `  play:\n${playNeeds}    steps:\n      - run: upload\n`,
].join('');
const expected = RELEASE['android.yml'];

test('the check passes on a workflow with every safeguard, with LF and with CRLF', () => {
  for (const eol of ['\n', '\r\n']) assert.deepEqual(deviations('android.yml', workflow().replaceAll('\n', eol), expected), []);
  // `needs` als Liste mit Spiegelstrichen und mit Anfuehrungszeichen.
  assert.deepEqual(deviations('android.yml', workflow({ signNeeds: '    needs:\n      - build\n', publishNeeds: "    needs: ['sign']\n" }), expected), []);
});

test('a comment starts at a # after white space only, and a line that ends with a backslash continues', () => {
  assert.equal(stripComment('        run: x # node scripts/release-on-main.mjs'), '        run: x');
  assert.equal(stripComment('      # run: x'), '');
  assert.equal(stripComment('          version="${tag#v}" # "quoted" comment'), '          version="${tag#v}"');
  // Kein Kommentar: ein `#` in einem Wort, und eine Zeile mit offenem Anfuehrungszeichen.
  assert.equal(stripComment('          v=${tag#v}; echo x >> $GITHUB_OUTPUT'), '          v=${tag#v}; echo x >> $GITHUB_OUTPUT');
  assert.equal(stripComment("          node -e ' # kein Kommentar"), "          node -e ' # kein Kommentar");
  assert.deepEqual(logicalLines('a \\\n    b \\\n  c\nd # e \\\nf\r\ng \\\r\n  h'), ['a b c', 'd', 'f', 'g h']);
});

test('the check reports a build job without the main check, with an unconditional one or with one after the build', () => {
  assert.deepEqual(deviations('android.yml', workflow({ beforeBuild: '' }), expected), [
    'android.yml: job build must check once that the commit to publish is on main, found 0 steps',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ gateIf: '' }), expected), [
    `android.yml: the main check of job build must run with "${PUBLISHING}"`,
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ beforeBuild: '', afterBuild: GATE_STEP }), expected), [
    'android.yml: the main check of job build must come before "npm run tauri -- android build"',
  ]);
  assert.deepEqual(deviations('android.yml', workflow(), { builds: { other: 'make' }, publish: 'publish', needs: {} }), ['android.yml: no job other']);
});

test('the check reports a main check that passes although the script fails', () => {
  const exactly = `android.yml: the main check of job build must be exactly "${GATE}"`;
  /** @param {string} line */
  const nothingBut = line => `android.yml: the main check of job build must have nothing but its name, "if" and "run", found "${line}"`;
  assert.deepEqual(deviations('android.yml', workflow({ gateRun: `        ${GATE} || true\n` }), expected), [exactly]);
  // Kein Kommentar: YAML und die Shell lesen `#x || true` als Teil des Befehls.
  assert.deepEqual(deviations('android.yml', workflow({ gateRun: `        ${GATE}#x || true\n` }), expected), [exactly]);
  assert.deepEqual(deviations('android.yml', workflow({ gateRun: `        ${GATE}\n        continue-on-error: true\n` }), expected), [nothingBut('continue-on-error: true')]);
  assert.deepEqual(deviations('android.yml', workflow({ gateRun: `        ${GATE}\n        shell: bash -c "true" {0}\n` }), expected), [nothingBut('shell: bash -c "true" {0}')]);
  // Eine tiefer eingerueckte Folgezeile haengt YAML an den Wert davor.
  assert.deepEqual(deviations('android.yml', workflow({ gateRun: `        ${GATE}\n          || true\n` }), expected), [exactly, nothingBut('|| true')]);
  assert.deepEqual(deviations('android.yml', workflow({ gateIf: `        ${PUBLISHING}\n          && false\n` }), expected), [
    `android.yml: the main check of job build must run with "${PUBLISHING}"`,
    nothingBut('&& false'),
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ gateRun: '        run: |\n          node scripts/release-on-main.mjs || true\n' }), expected), [exactly, nothingBut('node scripts/release-on-main.mjs || true')]);
});

test('the check reports a second checkout, a missing one and one after the main check', () => {
  const other = '      - uses: actions/checkout@0000000000000000000000000000000000000000 # v1\n        with: { ref: refs/heads/other }\n';
  assert.deepEqual(deviations('android.yml', workflow({ beforeBuild: `${GATE_STEP}${other}` }), expected), [
    'android.yml: job build must check out the source once, found 2 checkout steps',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ afterBuild: other }), expected), [
    'android.yml: job build must check out the source once, found 2 checkout steps',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ checkout: '' }), expected), [
    'android.yml: job build must check out the source once, found 0 checkout steps',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ checkout: '', beforeBuild: `${GATE_STEP}${CHECKOUT}` }), expected), [
    'android.yml: job build must check out the source before the main check, which tests the checked-out commit',
  ]);
});

test('the check reports a job that no longer waits for the jobs before it', () => {
  assert.deepEqual(deviations('android.yml', workflow({ signNeeds: '' }), expected), ['android.yml: job sign must need exactly build, found none']);
  assert.deepEqual(deviations('android.yml', workflow({ publishNeeds: '    needs: build\n' }), expected), ['android.yml: job publish must need exactly sign, found build']);
  assert.deepEqual(deviations('android.yml', workflow({ playNeeds: '    needs: [build, sign]\n' }), expected), ['android.yml: job play must need exactly sign, found build, sign']);
  // Mehrere Jobs, wie bei publish in packages.yml: Jeder zaehlt, die Reihenfolge nicht.
  const both = { ...expected, needs: { publish: ['build', 'sign'] } };
  assert.deepEqual(deviations('android.yml', workflow({ publishNeeds: '    needs: [sign, build]\n' }), both), []);
  assert.deepEqual(deviations('android.yml', workflow(), both), ['android.yml: job publish must need exactly build, sign, found sign']);
  assert.deepEqual(deviations('android.yml', workflow(), { ...expected, needs: { other: ['build'] } }), ['android.yml: no job other']);
});

test('the check reports a release that would be created or marked as latest too early', () => {
  const marking = `android.yml: job publish must mark the release as latest in one step with "${COMPLETE}" and exactly "${MARK}"`;
  const outside = 'android.yml: the release is marked as latest outside the step that follows the check';
  assert.deepEqual(deviations('android.yml', workflow({ create: 'gh release create "$tag" "$apk" --verify-tag --title "x"' }), expected), [
    'android.yml: "gh release create" without --latest=false would make a half-finished release the latest one',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ create: 'gh release create "$tag" "$apk" --latest=false' }), expected), [
    'android.yml: "gh release create" without --verify-tag',
  ]);
  // Ueber zwei Zeilen fortgesetzt, zaehlt der Aufruf wie in einer.
  assert.deepEqual(deviations('android.yml', workflow({ create: 'gh release create "$tag" "$apk" --verify-tag \\\n              --latest=false --title "x"' }), expected), []);
  assert.deepEqual(deviations('android.yml', workflow({ create: 'gh release create "$tag" "$apk" --verify-tag \\\n              --title "x"' }), expected), [
    'android.yml: "gh release create" without --latest=false would make a half-finished release the latest one',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ check: '' }), expected), [
    'android.yml: job publish needs one step with id "complete" that runs scripts/release-latest.mjs',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ markIf: '' }), expected), [marking]);
  assert.deepEqual(deviations('android.yml', workflow({ markIf: `        ${COMPLETE}\n          || true\n` }), expected), [marking]);
  // --latest=false ist nicht die Marke, auch wenn der Aufruf sonst derselbe ist.
  assert.deepEqual(deviations('android.yml', workflow({ markRun: `        ${MARK}=false\n` }), expected), [marking]);
  assert.deepEqual(deviations('android.yml', workflow({ markRun: `        ${MARK} || true\n` }), expected), [marking, outside]);
  // Die Marke beim Schreiben des Textes zu setzen, kaeme vor der Pruefung;
  // --latest=false dort ist erlaubt.
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'gh release edit "$tag" --latest --notes-file notes.md' }), expected), [outside]);
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'gh release edit "$tag" --notes-file notes.md --latest' }), expected), [outside]);
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'gh release edit "$tag" --notes-file notes.md \\\n              --latest' }), expected), [outside]);
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'gh release edit "$tag" --latest=false --notes-file notes.md' }), expected), []);
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'gh release edit "$tag" --notes-file notes.md \\\n              --latest=false' }), expected), []);
  assert.deepEqual(deviations('android.yml', workflow({ order: (attach, check, mark) => `${check}${attach}${mark}` }), expected), [
    'android.yml: the check for a complete release must come after the upload',
  ]);
  assert.deepEqual(deviations('android.yml', workflow({ order: (attach, check, mark) => `${attach}${mark}${check}` }), expected), [
    'android.yml: the release is marked as latest before the check for a complete release',
  ]);
});

test('the check reports a release text written without a word about the mark', () => {
  const unsaid = 'android.yml: "gh release edit" must say what becomes of the mark: --latest=false, or "$keep" from the line before it that asks which release is the latest one now';
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'gh release edit "$tag" --notes-file notes.md' }), expected), [unsaid]);
  // "$keep" zaehlt nur mit der Zeile, die nachsieht, direkt davor.
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'gh release edit "$tag" --notes-file notes.md "$keep"' }), expected), [unsaid]);
  assert.deepEqual(deviations('android.yml', workflow({ edit: 'keep=--latest\n            gh release edit "$tag" --notes-file notes.md "$keep"' }), expected), [unsaid]);
  assert.deepEqual(deviations('android.yml', workflow({ edit: `${KEEP}\n            keep=--latest\n            gh release edit "$tag" --notes-file notes.md "$keep"` }), expected), [unsaid]);
  assert.deepEqual(deviations('android.yml', workflow({ edit: `${KEEP}\n            gh release edit "$tag" --notes-file notes.md $flag` }), expected), [unsaid]);
});

test('the check reports a second writer of the result of the check for a complete release', () => {
  const writer = 'android.yml: in the step with id "complete" only scripts/release-latest.mjs may write the output, with --output "$GITHUB_OUTPUT"';
  assert.deepEqual(deviations('android.yml', workflow({ written: ' || echo latest=true >> "$GITHUB_OUTPUT"' }), expected), [writer]);
  assert.deepEqual(deviations('android.yml', workflow({ written: '\n          echo latest=true >> "$GITHUB_OUTPUT"' }), expected), [writer]);
  assert.deepEqual(deviations('android.yml', workflow({ written: ' \\\n            || echo latest=true >> "$GITHUB_OUTPUT"' }), expected), [writer]);
  // Hinter dem `#` von ${...#v} beginnt kein Kommentar, der die Zeile verdeckt.
  assert.deepEqual(deviations('android.yml', workflow({ written: '\n          v=${PUBLISH_TAG#v}; echo latest=true >> $GITHUB_OUTPUT' }), expected), [writer]);
  assert.deepEqual(deviations('android.yml', workflow({ written: '\n          echo "::set-output name=latest::true"' }), expected), [writer]);
  const elsewhere = '      - name: Check whether the release has every package\n        id: complete\n        run: |\n          node scripts/release-latest.mjs "${PUBLISH_TAG#v}" --output "$RUNNER_TEMP/out"\n          echo latest=true >> "$GITHUB_OUTPUT"\n';
  assert.deepEqual(deviations('android.yml', workflow({ check: elsewhere }), expected), [writer]);
});
