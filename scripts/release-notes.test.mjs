import test from 'node:test';
import assert from 'node:assert/strict';
import { markers, windowsSection, macosSection, androidSection, mergeSection, sections, releaseBody } from './release-notes.mjs';

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

test('a release the workflow creates links the changelog of its tag; an existing text is kept', () => {
  const parts = sections({ version: '0.3.0', windows: windowsManifest, macos: macosManifest });
  const created = releaseBody({ version: '0.3.0', parts });
  assert.equal(created, `aidevbridge 0.3.0. All changes: [CHANGELOG](https://github.com/ITBrain258/aidevbridge/blob/v0.3.0/CHANGELOG.md).\n\n${win()}\n\n${mac()}\n`);
  assert.equal(releaseBody({ version: '0.3.0', body: 'Hand-written.\n', parts: [parts[0]] }), `Hand-written.\n\n${win()}\n`);
});
