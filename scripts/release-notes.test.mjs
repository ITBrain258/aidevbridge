// @ts-nocheck -- not yet checked through checkJs (tsconfig.node.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markers, windowsSection, macosSection, androidSection, mergeSection, sections, releaseBody, introduction, releaseNote, noteProblem, NOTE_DIRECTORY, NOTE_LIMIT } from './release-notes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));

const sha = c => c.repeat(64);
const winFiles = { setup: { path: 'aidevbridge-0.3.0-windows-x64-setup.exe', sha256: sha('a') }, msi: { path: 'aidevbridge-0.3.0-windows-x64.msi', sha256: sha('b') }, zip: { path: 'aidevbridge-0.3.0-windows-x64.zip', sha256: sha('c') } };
const win = () => windowsSection({ version: '0.3.0', ...winFiles });
const mac = (signing = 'ad-hoc') => macosSection({ version: '0.3.0', file: 'aidevbridge-0.3.0-macos-universal.dmg', sha256: sha('d'), signing });
const windowsManifest = { status: 'artifacts_built_and_zip_verified', contract: { version: '0.3.0' }, artifacts: [{ kind: 'msi', ...winFiles.msi }, { kind: 'nsis', ...winFiles.setup }, { kind: 'zip', ...winFiles.zip }] };
const macosManifest = { status: 'artifacts_built_and_verified', contract: { version: '0.3.0', signing: { mode: 'ad-hoc' } }, artifacts: [{ kind: 'dmg', path: 'aidevbridge-0.3.0-macos-universal.dmg', sha256: sha('d') }] };

test('the Windows part names all three packages and their hashes', () => {
  const text = win();
  const [start, end] = markers('windows');
  assert.ok(text.startsWith(`${start}\n## Windows\n`) && text.endsWith(end));
  for (const file of Object.values(winFiles)) assert.match(text, new RegExp(`${file.sha256}  ${file.path.replaceAll('.', '\\.')}`));
  assert.match(text, /Get-FileHash/);
  assert.throws(() => windowsSection({ version: '0.3.0', ...winFiles, zip: { path: 'other.zip', sha256: sha('c') } }), /Unexpected file name/);
  assert.throws(() => windowsSection({ version: '0.3.0', ...winFiles, msi: { ...winFiles.msi, sha256: 'abc' } }), /SHA-256/);
});

test('the macOS part names the file, its hash and how to open an ad-hoc signed app', () => {
  const text = mac();
  const [start, end] = markers('macos');
  assert.ok(text.startsWith(`${start}\n## macOS\n`) && text.endsWith(end));
  assert.match(text, new RegExp(`${sha('d')}  aidevbridge-0\\.3\\.0-macos-universal\\.dmg`));
  assert.match(text, /Open Anyway/);
  assert.match(mac('developer-id'), /Signed and notarized/);
  assert.doesNotMatch(mac('developer-id'), /Open Anyway/);
  assert.throws(() => macosSection({ version: 'v0.3.0', file: 'aidevbridge-v0.3.0-macos-universal.dmg', sha256: sha('d'), signing: 'ad-hoc' }), /Invalid version/);
  assert.throws(() => macosSection({ version: '0.3.0', file: 'aidevbridge-0.3.0-macos-universal.dmg', sha256: sha('d'), signing: 'none' }), /signing mode/);
});

test('a hand-written text keeps every line; each platform part is appended once and then replaced', () => {
  const body = 'Intro.\r\n\r\n## What changed\r\n\r\nNotes.\r\n';
  const first = mergeSection(mergeSection(body, 'windows', win()), 'macos', mac());
  assert.equal(first, `Intro.\n\n## What changed\n\nNotes.\n\n${win()}\n\n${mac()}\n`);
  const edited = first.replace('Notes.', 'Notes, edited by hand.') + '\nA later remark.\n';
  const second = mergeSection(edited, 'macos', mac('developer-id'));
  assert.equal(second, edited.replace(mac(), mac('developer-id')));
  assert.equal(mergeSection(second, 'macos', mac('developer-id')), second);
  assert.equal(mergeSection(second, 'windows', win()), second);
  assert.equal(mergeSection(null, 'macos', mac()), `${mac()}\n`);
});

test('a damaged marker pair is not guessed at', () => {
  const [start, end] = markers('macos');
  assert.throws(() => mergeSection(`Intro\n${start}\nhalf`, 'macos', mac()), /damaged macos/);
  assert.throws(() => mergeSection(`${end}\n${start}`, 'macos', mac()), /damaged/);
  assert.throws(() => mergeSection(`${start}${end}\n${start}${end}`, 'macos', mac()), /damaged/);
  assert.throws(() => mergeSection('Intro', 'windows', mac()), /Not a marked windows section/);
});

test('the parts come from the build manifests of the same version', () => {
  assert.deepEqual(sections({ version: '0.3.0', windows: windowsManifest, macos: macosManifest }), [['windows', win()], ['macos', mac()]]);
  assert.deepEqual(sections({ version: '0.3.0', macos: macosManifest }), [['macos', mac()]]);
  assert.throws(() => sections({ version: '0.3.1', windows: windowsManifest }), /not a release build of this version/);
  assert.throws(() => sections({ version: '0.3.0', macos: { ...macosManifest, status: 'preview_built_and_verified_not_for_distribution' } }), /not a release build/);
  assert.throws(() => sections({ version: '0.3.0' }), /No platform/);
});

const certificate = Array.from({ length: 32 }, () => 'AB').join(':');
const androidManifest = { status: 'signed_and_verified', contract: { version: '0.3.0', certificate }, artifacts: [{ kind: 'apk', path: 'aidevbridge-0.3.0-android.apk', sha256: sha('e') }] };
const android = () => androidSection({ version: '0.3.0', file: 'aidevbridge-0.3.0-android.apk', sha256: sha('e'), certificate });

test('the Android part names the APK, its hash and the signing certificate', () => {
  const text = android();
  const [start, end] = markers('android');
  assert.ok(text.startsWith(`${start}\n## Android\n`) && text.endsWith(end));
  assert.match(text, new RegExp(`${sha('e')}  aidevbridge-0\\.3\\.0-android\\.apk`));
  assert.match(text, new RegExp(`certificate SHA-256: ${certificate}`));
  assert.match(text, /Google Play or this file, not both/);
  assert.match(text, /From Android 17 on, the app asks for .*Nearby devices/);
  assert.throws(() => androidSection({ version: '0.3.0', file: 'app-universal-release.apk', sha256: sha('e'), certificate }), /Unexpected file name/);
  assert.throws(() => androidSection({ version: '0.3.0', file: 'aidevbridge-0.3.0-android.apk', sha256: sha('e'), certificate: 'abc' }), /certificate digest/);
});

test('the Android part comes after the desktop parts and only from a signed build of the same version', () => {
  assert.deepEqual(sections({ version: '0.3.0', windows: windowsManifest, macos: macosManifest, android: androidManifest }), [['windows', win()], ['macos', mac()], ['android', android()]]);
  assert.deepEqual(sections({ version: '0.3.0', android: androidManifest }), [['android', android()]]);
  assert.throws(() => sections({ version: '0.3.0', android: { ...androidManifest, status: 'unsigned' } }), /not a release build/);
  assert.throws(() => sections({ version: '0.3.1', android: androidManifest }), /not a release build of this version/);
  const body = releaseBody({ version: '0.3.0', parts: sections({ version: '0.3.0', windows: windowsManifest }) });
  const merged = releaseBody({ version: '0.3.0', body, parts: [['android', android()]] });
  assert.equal(releaseBody({ version: '0.3.0', body: merged, parts: sections({ version: '0.3.0', windows: windowsManifest }) }), merged);
});

test('a release the workflow creates links the changelog of its tag and says it is German; an existing text is kept', () => {
  const parts = sections({ version: '0.3.0', windows: windowsManifest, macos: macosManifest });
  const created = releaseBody({ version: '0.3.0', parts });
  assert.equal(created, `aidevbridge 0.3.0. All changes are in the [CHANGELOG](https://github.com/ITBrain258/aidevbridge/blob/v0.3.0/CHANGELOG.md), which is written in German.\n\n${win()}\n\n${mac()}\n`);
  assert.equal(releaseBody({ version: '0.3.0', body: 'Hand-written.\n', parts: [parts[0]] }), `Hand-written.\n\n${win()}\n`);
  // Without a usable summary the text is the same line.
  assert.equal(releaseBody({ version: '0.3.0', parts, note: null }), created);
  assert.equal(releaseBody({ version: '0.3.0', parts, note: ' \n' }), created);
  // An existing text gets no introduction, not even with a summary at hand.
  assert.equal(releaseBody({ version: '0.3.0', body: 'Hand-written.\n', parts: [parts[0]], note: NOTE }), `Hand-written.\n\n${win()}\n`);
  assert.equal(releaseBody({ version: '0.3.0', body: '', parts: [parts[0]], note: NOTE }), `${win()}\n`);
});

const CHANGELOG = '[CHANGELOG](https://github.com/ITBrain258/aidevbridge/blob/v0.3.0/CHANGELOG.md)';
const NOTE = 'Typing over slow connections responds faster.\n\n- **Errors:** a message stays until you close it.';
const count = (text, part) => text.split(part).length - 1;

test('the introduction carries the English summary as "What\'s new" before the link to the German changelog', () => {
  assert.equal(introduction({ version: '0.3.0', note: `\r\n${NOTE.replaceAll('\n', '\r\n')}\r\n` }),
    `## What's new\n\n${NOTE}\n\nAll changes are in the ${CHANGELOG}, which is written in German.\n`);
  assert.equal(introduction({ version: '0.3.0' }), `aidevbridge 0.3.0. All changes are in the ${CHANGELOG}, which is written in German.\n`);
  assert.throws(() => introduction({ version: 'v0.3.0', note: NOTE }), /Invalid version/);
});

test('a summary that would break the release text is not used', () => {
  assert.equal(noteProblem(NOTE), null);
  assert.equal(noteProblem(''), 'it is empty');
  assert.equal(noteProblem(' \n'), 'it is empty');
  assert.equal(noteProblem(undefined), 'it is empty');
  assert.match(noteProblem(`Fine. ${markers('windows')[0]}`), /section marker/);
  assert.match(noteProblem('x'.repeat(NOTE_LIMIT + 1)), /more than/);
  assert.equal(noteProblem('x'.repeat(NOTE_LIMIT)), null);
  assert.match(noteProblem('## Windows\n\nForged.'), /heading/);
  assert.equal(noteProblem('### Details\n\nAllowed.'), null);
  // The introduction falls back to the plain line instead of writing it.
  const forged = introduction({ version: '0.3.0', note: `Fine. ${markers('windows')[0]}` });
  assert.equal(forged, introduction({ version: '0.3.0' }));
});

test('the summary stands in the release text once, whichever workflow creates the release', () => {
  const desktop = sections({ version: '0.3.0', windows: windowsManifest, macos: macosManifest });
  const mobile = sections({ version: '0.3.0', android: androidManifest });
  for (const [first, second] of [[desktop, mobile], [mobile, desktop]]) {
    // The first workflow finds no release and creates it with the introduction.
    const created = releaseBody({ version: '0.3.0', parts: first, note: NOTE });
    assert.ok(created.startsWith(`## What's new\n\n${NOTE}\n\nAll changes are in the ${CHANGELOG}, which is written in German.\n\n<!-- aidevbridge:`));
    // The second one passes the current text and only adds its own part.
    const merged = releaseBody({ version: '0.3.0', body: created, parts: second, note: NOTE });
    assert.ok(merged.startsWith(created.trimEnd()));
    for (const once of ["## What's new", NOTE, 'written in German', '## Windows', '## macOS', '## Android']) assert.equal(count(merged, once), 1, once);
    // A repeated run of either workflow changes nothing.
    assert.equal(releaseBody({ version: '0.3.0', body: merged, parts: first, note: NOTE }), merged);
    assert.equal(releaseBody({ version: '0.3.0', body: merged, parts: second, note: NOTE }), merged);
  }
});

test('the summary of a version is its file under docs/release/notes, or nothing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notes = path.join(root, ...NOTE_DIRECTORY.split('/'));
  assert.equal(releaseNote(root, '0.3.0'), null);
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, '0.3.0.md'), `\r\n${NOTE.replaceAll('\n', '\r\n')}\r\n\r\n`);
  assert.equal(releaseNote(root, '0.3.0'), NOTE);
  assert.equal(releaseNote(root, '0.3.1'), null);
  fs.writeFileSync(path.join(notes, '0.3.1.md'), ' \n');
  assert.equal(releaseNote(root, '0.3.1'), null);
  fs.writeFileSync(path.join(notes, '0.3.2.md'), `Fine. ${markers('android')[1]}\n`);
  assert.equal(releaseNote(root, '0.3.2'), null);
});

// Each release has its English summary: the changelog is German. The release
// pull request writes the file with the version bump; without it the release
// text would only link the changelog.
test('the version in package.json has its English summary for the release text', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const file = path.join(ROOT, ...NOTE_DIRECTORY.split('/'), `${version}.md`);
  assert.ok(fs.existsSync(file), `missing ${NOTE_DIRECTORY}/${version}.md for ${version}`);
  const problem = noteProblem(fs.readFileSync(file, 'utf8'));
  assert.equal(problem, null, `${NOTE_DIRECTORY}/${version}.md cannot be used: ${problem}`);
  assert.ok(releaseNote(ROOT, version));
});

// The program as both workflows call it, in this checkout.
test('the program writes the summary of this checkout into a release it creates, and none into an existing text', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const note = releaseNote(ROOT, version);
  assert.ok(note, `no usable English summary for ${version}`);
  const manifest = path.join(dir, 'android-manifest.json'), body = path.join(dir, 'body.md');
  fs.writeFileSync(manifest, JSON.stringify({ status: 'signed_and_verified', contract: { version, certificate }, artifacts: [{ kind: 'apk', path: `aidevbridge-${version}-android.apk`, sha256: sha('e') }] }));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, version, ...args, '--android', manifest], { encoding: 'utf8' });
  const created = run();
  assert.equal(created.stderr, '');
  assert.equal(created.status, 0);
  assert.ok(created.stdout.startsWith(`## What's new\n\n${note}\n\nAll changes are in the [CHANGELOG](https://github.com/ITBrain258/aidevbridge/blob/v${version}/CHANGELOG.md), which is written in German.\n\n${markers('android')[0]}\n`));
  assert.equal(count(created.stdout, "## What's new"), 1);
  // The other workflow passes the text the release has by then.
  fs.writeFileSync(body, created.stdout);
  const again = run('--body', body);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, created.stdout);
  fs.writeFileSync(body, 'Written by hand.\n');
  const kept = run('--body', body);
  assert.equal(kept.status, 0);
  assert.ok(kept.stdout.startsWith(`Written by hand.\n\n${markers('android')[0]}\n`));
  assert.equal(count(kept.stdout, "What's new"), 0);
});
