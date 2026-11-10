import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedAssets, missingAssets, latestDecision } from './release-latest.mjs';
import { attachPlan } from './release-attach.mjs';
import { windowsSection, macosSection, androidSection } from './release-notes.mjs';
import { artifactName } from './release-macos-artifacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fileURLToPath(new URL('./release-latest.mjs', import.meta.url));
/** @param {string} relative */
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

// Die Assets des veroeffentlichten Release v0.3.1, wie `gh release view` sie
// am 10.11.2026 nannte: was die beiden Workflows wirklich angehaengt haben.
const RELEASE_0_3_1 = [
  'aidevbridge-0.3.1-android.apk',
  'aidevbridge-0.3.1-macos-universal.dmg',
  'aidevbridge-0.3.1-macos-universal.dmg.sha256',
  'aidevbridge-0.3.1-windows-x64-setup.exe',
  'aidevbridge-0.3.1-windows-x64.msi',
  'aidevbridge-0.3.1-windows-x64.zip',
];
const [SETUP, MSI, ZIP, DMG, DMG_SHA, APK] = expectedAssets('0.3.1');
const DESKTOP = [SETUP, MSI, ZIP, DMG, DMG_SHA];
// Ein Asset, wie die Release-API es meldet.
/** @param {string} name @param {string} [state] */
const asset = (name, state = 'uploaded') => ({ name, state, digest: `sha256:${'a'.repeat(64)}` });
/** @param {string[]} names @param {object} [more] */
const release = (names, more = {}) => ({ tag_name: 'v0.3.1', draft: false, prerelease: false, assets: names.map(name => asset(name)), ...more });

test('the expected files are those the builds write and the published 0.3.1 release has', () => {
  assert.deepEqual([...expectedAssets('0.3.1')].sort(), RELEASE_0_3_1);
  // macOS: der Name aus release-macos-artifacts.mjs und die .sha256-Datei daneben.
  assert.equal(DMG, artifactName('0.3.1', false, 'c'.repeat(40)));
  assert.equal(DMG_SHA, `${DMG}.sha256`);
  // release-notes.mjs nimmt fuer den Releasetext genau diese Namen an.
  const sha256 = 'b'.repeat(64);
  windowsSection({ version: '0.3.1', setup: { path: SETUP, sha256 }, msi: { path: MSI, sha256 }, zip: { path: ZIP, sha256 } });
  macosSection({ version: '0.3.1', file: DMG, sha256, signing: 'ad-hoc' });
  androidSection({ version: '0.3.1', file: APK, sha256, certificate: Array.from({ length: 32 }, () => 'AB').join(':') });
  // android.yml benennt die signierte APK im Job sign, packages.yml schreibt
  // die .sha256-Datei neben das Disk-Image.
  assert.ok(read('.github/workflows/android.yml').includes('apk="aidevbridge-$version-android.apk"'));
  assert.ok(read('.github/workflows/packages.yml').includes('fs.writeFileSync(`${file}.sha256`'));
  assert.throws(() => expectedAssets('v0.3.1'), /Invalid version/);
  assert.throws(() => expectedAssets('0.3'), /Invalid version/);
});

test('a release lacks every expected file that is not uploaded completely', () => {
  assert.deepEqual(missingAssets('0.3.1', []), expectedAssets('0.3.1'));
  assert.deepEqual(missingAssets('0.3.1', [asset(APK)]), DESKTOP);
  assert.deepEqual(missingAssets('0.3.1', DESKTOP.map(name => asset(name))), [APK]);
  assert.deepEqual(missingAssets('0.3.1', RELEASE_0_3_1.map(name => asset(name))), []);
  // Ein abgebrochener Upload und ein Asset ohne Zustand zaehlen nicht.
  assert.deepEqual(missingAssets('0.3.1', [...DESKTOP.map(name => asset(name)), asset(APK, 'open')]), [APK]);
  assert.deepEqual(missingAssets('0.3.1', [...DESKTOP.map(name => asset(name)), { name: APK }]), [APK]);
  // Die Dateien einer anderen Version und fremde Dateien zaehlen nicht.
  assert.deepEqual(missingAssets('0.3.2', RELEASE_0_3_1.map(name => asset(name))), expectedAssets('0.3.2'));
  assert.deepEqual(missingAssets('0.3.1', [...RELEASE_0_3_1, 'notes.txt'].map(name => asset(name))), []);
  // Gross- und Kleinschreibung zaehlt: GitHub fuehrt die Namen genau so.
  assert.deepEqual(missingAssets('0.3.1', [...DESKTOP, APK.toUpperCase()].map(name => asset(name))), [APK]);
  assert.throws(() => missingAssets('0.3.1', /** @type {any} */ (undefined)), /release assets are missing/);
});

test('the workflow that attaches last marks the release, whichever comes first', () => {
  // Android zuerst: Das Release entsteht mit der APK allein.
  const afterAndroid = latestDecision({ version: '0.3.1', release: release([APK]), latestTag: 'v0.3.0' });
  assert.deepEqual(afterAndroid, { latest: false, missing: DESKTOP, reason: `v0.3.1 is not marked as the latest release yet: it still lacks ${DESKTOP.join(', ')}.` });
  // Die Desktop-Pakete zuerst.
  const afterPackages = latestDecision({ version: '0.3.1', release: release(DESKTOP), latestTag: 'v0.3.0' });
  assert.deepEqual(afterPackages, { latest: false, missing: [APK], reason: `v0.3.1 is not marked as the latest release yet: it still lacks ${APK}.` });
  // Der zweite Workflow sieht nach seinem Upload alle Dateien.
  for (const names of [[APK, ...DESKTOP], [...DESKTOP, APK]]) {
    assert.deepEqual(latestDecision({ version: '0.3.1', release: release(names), latestTag: 'v0.3.0' }),
      { latest: true, missing: [], reason: 'v0.3.1 has every package and becomes the latest release instead of v0.3.0.' });
  }
  // Das erste Release eines Repositorys: Es gibt noch kein "Latest".
  assert.deepEqual(latestDecision({ version: '0.3.1', release: release(RELEASE_0_3_1) }),
    { latest: true, missing: [], reason: 'v0.3.1 has every package and becomes the latest release.' });
  assert.equal(latestDecision({ version: '0.3.1', release: release(RELEASE_0_3_1), latestTag: null }).latest, true);
});

test('the plan of the packages workflow and the decision agree on what a complete release is', () => {
  // Die Gruppen, wie release-attach.mjs sie aus den Manifesten bildet.
  /** @param {string} name */
  const file = name => ({ name, sha256: 'a'.repeat(64), path: `dir/${name}` });
  const groups = [{ name: 'windows', files: [SETUP, MSI, ZIP].map(file) }, { name: 'macos', files: [DMG, DMG_SHA].map(file) }];
  // Nach dem Android-Workflow fehlt genau das, was der Plan hochlaedt.
  const plan = attachPlan({ groups, assets: [asset(APK)] });
  assert.deepEqual(plan.upload.map(p => path.posix.basename(p)), missingAssets('0.3.1', [asset(APK)]));
  // Ist alles angehaengt, laedt der Plan nichts mehr hoch und nichts fehlt.
  const done = RELEASE_0_3_1.map(name => asset(name));
  assert.deepEqual(attachPlan({ groups, assets: done }).upload, []);
  assert.deepEqual(missingAssets('0.3.1', done), []);
});

test('a repeated run sets a missing mark but never takes it from a newer release', () => {
  const complete = release(RELEASE_0_3_1);
  // Der Lauf, der die Marke setzen sollte, brach danach ab: Die Wiederholung holt es nach.
  assert.equal(latestDecision({ version: '0.3.1', release: complete, latestTag: 'v0.3.0' }).latest, true);
  // Schon markiert: nichts zu tun.
  assert.deepEqual(latestDecision({ version: '0.3.1', release: complete, latestTag: 'v0.3.1' }),
    { latest: false, missing: [], reason: 'v0.3.1 has every package and is the latest release already.' });
  // Ein Handlauf fuer ein aelteres Release.
  for (const newer of ['v0.3.2', 'v0.4.0', 'v1.0.0', 'v0.3.10']) {
    assert.deepEqual(latestDecision({ version: '0.3.1', release: complete, latestTag: newer }),
      { latest: false, missing: [], reason: `v0.3.1 has every package; ${newer} is newer and stays the latest release.` });
  }
  // Zahlen, nicht Zeichenketten: 0.3.10 ist neuer als 0.3.9.
  assert.equal(latestDecision({ version: '0.3.10', release: { ...release(expectedAssets('0.3.10')), tag_name: 'v0.3.10' }, latestTag: 'v0.3.9' }).latest, true);
  // Ein unvollstaendiges Release bleibt, wie es ist, auch wenn es von Hand markiert wurde.
  assert.equal(latestDecision({ version: '0.3.1', release: release(DESKTOP), latestTag: 'v0.3.1' }).latest, false);
});

test('a draft, a pre-release and a latest release without a version are left to the maintainer', () => {
  for (const more of [{ draft: true }, { prerelease: true }]) {
    assert.deepEqual(latestDecision({ version: '0.3.1', release: release(RELEASE_0_3_1, more), latestTag: 'v0.3.0' }),
      { latest: false, missing: [], reason: 'v0.3.1 has every package, but GitHub cannot mark a draft or pre-release as the latest release.' });
  }
  assert.deepEqual(latestDecision({ version: '0.3.1', release: release(RELEASE_0_3_1), latestTag: 'nightly' }),
    { latest: false, missing: [], reason: 'v0.3.1 has every package, but the latest release nightly has no version to compare it with: set the latest release by hand.' });
  assert.throws(() => latestDecision({ version: '0.3.1', release: { ...release(RELEASE_0_3_1), tag_name: 'v0.3.0' } }), /not that of v0\.3\.1/);
  assert.throws(() => latestDecision({ version: '0.3.1', release: /** @type {any} */ ({}) }), /not that of v0\.3\.1/);
  assert.throws(() => latestDecision({ version: '0.3.1', release: /** @type {any} */ ({ tag_name: 'v0.3.1' }) }), /release assets are missing/);
  assert.throws(() => latestDecision({ version: 'v0.3.1', release: release(RELEASE_0_3_1) }), /Invalid version/);
});

// Das Programm, wie der Veroeffentlichungsjob es aufruft: mit den Antworten der
// Release-API als Dateien; die Entscheidung geht nach $GITHUB_OUTPUT.
/** @param {import('node:test').TestContext} t */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-latest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** @param {object} releaseJson @param {object} latestJson @param {string[]} [args] */
  const run = (releaseJson, latestJson, args = ['0.3.1']) => {
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(releaseJson));
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(latestJson));
    fs.writeFileSync(path.join(dir, 'output.txt'), 'exists=true\n');
    const result = spawnSync(process.execPath, [SCRIPT, ...args, '--release', 'release.json', '--latest', 'latest.json', '--output', 'output.txt'], { cwd: dir, encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(path.join(dir, 'output.txt'), 'utf8') };
  };
  return { dir, run };
}

test('the program appends latest=true only for a complete release and says what is missing', t => {
  const { run } = workspace(t);
  const incomplete = run(release([APK]), { tag_name: 'v0.3.0' });
  assert.equal(incomplete.stderr, '');
  assert.equal(incomplete.status, 0);
  assert.equal(incomplete.stdout, `v0.3.1 is not marked as the latest release yet: it still lacks ${DESKTOP.join(', ')}.\n`);
  assert.equal(incomplete.output, 'exists=true\nlatest=false\n');
  const complete = run(release(RELEASE_0_3_1), { tag_name: 'v0.3.0' });
  assert.equal(complete.status, 0);
  assert.equal(complete.stdout, 'v0.3.1 has every package and becomes the latest release instead of v0.3.0.\n');
  assert.equal(complete.output, 'exists=true\nlatest=true\n');
  // Die Antwort {} steht fuer "kein Latest" (HTTP 404).
  const first = run(release(RELEASE_0_3_1), {});
  assert.equal(first.stdout, 'v0.3.1 has every package and becomes the latest release.\n');
  assert.equal(first.output, 'exists=true\nlatest=true\n');
  const already = run(release(RELEASE_0_3_1), { tag_name: 'v0.3.1' });
  assert.equal(already.status, 0);
  assert.equal(already.output, 'exists=true\nlatest=false\n');
});

test('the program fails without a decision on data it cannot read', t => {
  const { run, dir } = workspace(t);
  // Die Fehlerantwort der API statt eines Release.
  const notFound = run({ message: 'Not Found', status: '404' }, { tag_name: 'v0.3.0' });
  assert.equal(notFound.status, 1);
  assert.equal(notFound.stderr, 'release-latest: The release data is not that of v0.3.1\n');
  assert.equal(notFound.output, 'exists=true\n');
  const otherTag = run(release(RELEASE_0_3_1), { tag_name: 'v0.3.0' }, ['0.3.2']);
  assert.equal(otherTag.status, 1);
  assert.equal(otherTag.output, 'exists=true\n');
  const badLatest = run(release(RELEASE_0_3_1), { tag_name: 7 });
  assert.equal(badLatest.status, 1);
  assert.match(badLatest.stderr, /latest\.json is not a release/);
  const usage = spawnSync(process.execPath, [SCRIPT, '0.3.1', '--release', 'release.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^release-latest: Usage: /);
});
