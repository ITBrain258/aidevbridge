import test from 'node:test';
import assert from 'node:assert/strict';
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
