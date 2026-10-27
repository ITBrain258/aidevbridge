import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachPlan } from './release-attach.mjs';

const sha = c => c.repeat(64);
const file = (dir, name, c) => ({ name, sha256: sha(c), path: `${dir}/${name}` });
const windows = {
  name: 'windows',
  files: [
    file('win', 'aidevbridge-0.3.0-windows-x64-setup.exe', 'a'),
    file('win', 'aidevbridge-0.3.0-windows-x64.msi', 'b'),
    file('win', 'aidevbridge-0.3.0-windows-x64.zip', 'c'),
  ],
};
const macos = {
  name: 'macos',
  files: [
    file('mac', 'aidevbridge-0.3.0-macos-universal.dmg', 'd'),
    file('mac', 'aidevbridge-0.3.0-macos-universal.dmg.sha256', 'e'),
  ],
};
const groups = [windows, macos];
const paths = group => group.files.map(f => f.path);
// Ein Asset, wie es die GitHub-API meldet: digest "sha256:<hex>" oder null.
const asset = (f, digest = `sha256:${f.sha256}`) => ({ name: f.name, digest });

test('a release without any of the files gets every group', () => {
  const plan = attachPlan({ groups, assets: [] });
  assert.deepEqual(plan.upload, [...paths(windows), ...paths(macos)]);
  assert.deepEqual(plan.notes, ['windows', 'macos']);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.conflicts, []);
});

test('a release that has every file gets nothing, whatever their digests', () => {
  const assets = [
    asset(windows.files[0]),
    asset(windows.files[1], `sha256:${sha('f')}`),
    asset(windows.files[2], null),
    asset(macos.files[0], `sha256:${sha('0')}`),
    asset(macos.files[1], null),
  ];
  const plan = attachPlan({ groups, assets });
  assert.deepEqual(plan.upload, []);
  assert.deepEqual(plan.notes, []);
  assert.deepEqual(plan.skipped, ['windows', 'macos']);
  assert.deepEqual(plan.conflicts, []);
});

test('a complete group from an earlier build is kept and the missing group still attached', () => {
  // Ein Handlauf, der den Tag nennt, baut Windows neu; die neuen Hashes weichen
  // von den veroeffentlichten ab. Die veroeffentlichten Dateien bleiben, und
  // die fehlende macOS-Gruppe kommt trotzdem dazu.
  const assets = windows.files.map(f => asset(f, `sha256:${sha('9')}`));
  const plan = attachPlan({ groups, assets });
  assert.deepEqual(plan.upload, paths(macos));
  assert.deepEqual(plan.notes, ['macos']);
  assert.deepEqual(plan.skipped, ['windows']);
  assert.deepEqual(plan.conflicts, []);
});

test('a complete group with the same bytes keeps its files and gets its section written again', () => {
  // Der Publish-Job wird mit denselben Artefakten wiederholt, nachdem der
  // erste Versuch Windows hochlud und vor dem Releasetext abbrach.
  const assets = windows.files.map(f => asset(f));
  const plan = attachPlan({ groups, assets });
  assert.deepEqual(plan.upload, paths(macos));
  assert.deepEqual(plan.notes, ['windows', 'macos']);
  assert.deepEqual(plan.skipped, ['windows']);
  assert.deepEqual(plan.conflicts, []);
});

test('a release that has every file with the same bytes gets no upload, only the text', () => {
  const assets = [...windows.files, ...macos.files].map(f => asset(f));
  const plan = attachPlan({ groups, assets });
  assert.deepEqual(plan.upload, []);
  assert.deepEqual(plan.notes, ['windows', 'macos']);
  assert.deepEqual(plan.skipped, ['windows', 'macos']);
  assert.deepEqual(plan.conflicts, []);
});

test('a partial group with the same bytes gets only its missing files', () => {
  // Gross- und Kleinschreibung des Hex-Werts zaehlt nicht.
  const assets = [asset(macos.files[0], `sha256:${sha('d').toUpperCase()}`), asset(windows.files[1])];
  const plan = attachPlan({ groups, assets });
  assert.deepEqual(plan.upload, [windows.files[0].path, windows.files[2].path, macos.files[1].path]);
  assert.deepEqual(plan.notes, ['windows', 'macos']);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.conflicts, []);
});

test('a partial group with other bytes is a conflict and nothing is attached', () => {
  const assets = [asset(windows.files[1], `sha256:${sha('7')}`)];
  const plan = attachPlan({ groups, assets });
  assert.deepEqual(plan.upload, []);
  assert.deepEqual(plan.notes, []);
  assert.deepEqual(plan.conflicts, [{ group: 'windows', name: windows.files[1].name, sha256: sha('b'), digest: `sha256:${sha('7')}` }]);
});

test('a partial group without a digest to compare is a conflict', () => {
  for (const digest of [null, undefined, `sha512:${sha('d')}`, '']) {
    const assets = [{ name: macos.files[0].name, digest }];
    const plan = attachPlan({ groups, assets });
    assert.deepEqual(plan.upload, [], `digest ${digest}`);
    assert.deepEqual(plan.conflicts, [{ group: 'macos', name: macos.files[0].name, sha256: sha('d'), digest: digest ?? null }]);
  }
});

test('release assets that no manifest names are ignored', () => {
  const extra = [{ name: 'aidevbridge-0.2.2-windows-x64.msi', digest: null }, { name: 'notes.txt', digest: `sha256:${sha('1')}` }];
  assert.deepEqual(attachPlan({ groups, assets: extra }).upload, [...paths(windows), ...paths(macos)]);
  const complete = attachPlan({ groups, assets: [...extra, ...windows.files.map(f => asset(f)), ...macos.files.map(f => asset(f))] });
  assert.deepEqual(complete.upload, []);
  assert.deepEqual(complete.conflicts, []);
});

test('the inputs are checked before anything is planned', () => {
  assert.throws(() => attachPlan({ groups: [], assets: [] }), /No platform group/);
  assert.throws(() => attachPlan({ groups, assets: undefined }), /release assets/);
  assert.throws(() => attachPlan({ groups: [{ name: 'macos', files: [] }], assets: [] }), /without files/);
  assert.throws(() => attachPlan({ groups: [windows, { name: 'other', files: [windows.files[0]] }], assets: [] }), /Duplicate file name/);
  assert.throws(() => attachPlan({ groups: [{ name: 'macos', files: [{ ...macos.files[0], sha256: 'abc' }] }], assets: [] }), /Invalid SHA-256/);
  assert.throws(() => attachPlan({ groups: [{ name: 'macos', files: [{ ...macos.files[0], name: 'mac/x.dmg' }] }], assets: [] }), /Invalid file name/);
});

// Das Programm, wie es der Veroeffentlichungsjob aufruft: win/ und mac/ mit je
// einem release-manifest.json und den Dateien, die es nennt, dazu die Antwort
// der Release-API als Datei. Die Pfade sind relativ zum Arbeitsverzeichnis wie
// im Workflow; path.join gibt sie auf Windows mit Backslash zurueck.
const SCRIPT = fileURLToPath(new URL('./release-attach.mjs', import.meta.url));
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const WINDOWS = [
  ['aidevbridge-0.3.0-windows-x64-setup.exe', 'nsis'],
  ['aidevbridge-0.3.0-windows-x64.msi', 'msi'],
  ['aidevbridge-0.3.0-windows-x64.zip', 'zip'],
];
const DMG = 'aidevbridge-0.3.0-macos-universal.dmg';

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-attach-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const write = (dir, name, content) => {
    fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    fs.writeFileSync(path.join(cwd, dir, name), content);
  };
  const artifacts = WINDOWS.map(([name, kind]) => ({ path: name, kind, sha256: sha256Of(`bytes of ${name}`) }));
  for (const [name] of WINDOWS) write('win', name, `bytes of ${name}`);
  write('win', 'release-manifest.json', JSON.stringify({ artifacts }));
  const dmgSha = sha256Of(`bytes of ${DMG}`);
  write('mac', DMG, `bytes of ${DMG}`);
  write('mac', `${DMG}.sha256`, `${dmgSha}  ${DMG}\n`);
  write('mac', 'release-manifest.json', JSON.stringify({ artifacts: [{ path: DMG, kind: 'dmg', sha256: dmgSha }] }));
  const sha = Object.fromEntries([...artifacts.map(a => [a.path, a.sha256]), [DMG, dmgSha]]);
  return { cwd, write, sha };
}

function attach(cwd, assets) {
  fs.writeFileSync(path.join(cwd, 'release.json'), JSON.stringify({ assets }));
  return spawnSync(process.execPath, [
    SCRIPT, '--release', 'release.json',
    '--windows', 'win/release-manifest.json', '--macos', 'mac/release-manifest.json',
    '--upload-list', 'upload.txt', '--notes-args', 'notes-args.txt',
  ], { cwd, encoding: 'utf8' });
}

const lines = items => items.map(item => `${item}\n`).join('');
const read = (cwd, name) => fs.readFileSync(path.join(cwd, name), 'utf8');
const written = (cwd, name) => fs.existsSync(path.join(cwd, name));

test('the program writes the upload list and the notes arguments for every missing group', t => {
  const { cwd } = workspace(t);
  const run = attach(cwd, []);
  assert.equal(run.stderr, '');
  assert.equal(run.status, 0);
  assert.equal(read(cwd, 'upload.txt'), lines([
    ...WINDOWS.map(([name]) => path.join('win', name)),
    path.join('mac', DMG),
    path.join('mac', `${DMG}.sha256`),
  ]));
  assert.equal(read(cwd, 'notes-args.txt'), lines(['--windows', 'win/release-manifest.json', '--macos', 'mac/release-manifest.json']));
});

test('the program leaves out a group the release already has and says so', t => {
  const { cwd } = workspace(t);
  // Von einem frueheren Bau: der Text nennt schon dessen Hashes.
  const run = attach(cwd, WINDOWS.map(([name]) => ({ name, digest: `sha256:${'9'.repeat(64)}` })));
  assert.equal(run.status, 0);
  assert.match(run.stdout, /The Windows packages are attached already\./);
  assert.equal(read(cwd, 'upload.txt'), lines([path.join('mac', DMG), path.join('mac', `${DMG}.sha256`)]));
  assert.equal(read(cwd, 'notes-args.txt'), lines(['--macos', 'mac/release-manifest.json']));
});

test('the program writes the text again for a group the release has with the same bytes', t => {
  const { cwd, sha } = workspace(t);
  const run = attach(cwd, WINDOWS.map(([name]) => ({ name, digest: `sha256:${sha[name]}` })));
  assert.equal(run.status, 0);
  assert.match(run.stdout, /The Windows packages are attached already\./);
  assert.equal(read(cwd, 'upload.txt'), lines([path.join('mac', DMG), path.join('mac', `${DMG}.sha256`)]));
  assert.equal(read(cwd, 'notes-args.txt'), lines(['--windows', 'win/release-manifest.json', '--macos', 'mac/release-manifest.json']));
});

test('a local file with other bytes than its manifest names stops the program', t => {
  const { cwd, write } = workspace(t);
  write('win', WINDOWS[1][0], 'tampered');
  const run = attach(cwd, []);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, `release-attach: Changed file: ${path.join('win', WINDOWS[1][0])}\n`);
  assert.equal(written(cwd, 'upload.txt'), false);
  assert.equal(written(cwd, 'notes-args.txt'), false);
});

test('a .dmg.sha256 that does not state the manifest hash stops the program', t => {
  const { cwd, write, sha } = workspace(t);
  for (const content of [
    `${'0'.repeat(64)}  ${DMG}\n`,
    `${sha[DMG].toUpperCase()}  ${DMG}\n`,
    `${sha[DMG]}  ${DMG}`,
    `${sha[DMG]} ${DMG}\n`,
    `${sha[DMG]}  other.dmg\n`,
  ]) {
    write('mac', `${DMG}.sha256`, content);
    const run = attach(cwd, []);
    assert.equal(run.status, 1, JSON.stringify(content));
    assert.match(run.stderr, /\.dmg\.sha256 does not state the hash of the manifest/);
    assert.equal(written(cwd, 'upload.txt'), false);
  }
});

test('a conflict with a published file exits with 1 and writes neither list', t => {
  const { cwd } = workspace(t);
  const msi = WINDOWS[1][0];
  const run = attach(cwd, [{ name: msi, digest: `sha256:${'7'.repeat(64)}` }]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, new RegExp(`::error::${msi.replaceAll('.', '\\.')} is attached to the release with sha256:7{64}`));
  assert.match(run.stdout, /::error::Nothing was attached\./);
  assert.equal(written(cwd, 'upload.txt'), false);
  assert.equal(written(cwd, 'notes-args.txt'), false);
});
