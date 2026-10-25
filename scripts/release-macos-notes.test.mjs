import test from 'node:test';
import assert from 'node:assert/strict';
import { START, END, macosSection, mergeBody, newReleaseBody } from './release-macos-notes.mjs';

const sha = 'a'.repeat(64);
const section = (signing = 'ad-hoc') => macosSection({ version: '0.3.0', file: 'aidevbridge-0.3.0-macos-universal.dmg', sha256: sha, signing });

test('the section names the file, its hash and how to open an ad-hoc signed app', () => {
  const text = section();
  assert.ok(text.startsWith(`${START}\n## macOS\n`) && text.endsWith(END));
  assert.match(text, /\| `aidevbridge-0\.3\.0-macos-universal\.dmg` \| Disk image\./);
  assert.match(text, new RegExp(`${sha}  aidevbridge-0\\.3\\.0-macos-universal\\.dmg`));
  assert.match(text, /Open Anyway/);
  assert.match(text, /xattr -dr com\.apple\.quarantine/);
  const signed = section('developer-id');
  assert.match(signed, /Signed and notarized/);
  assert.doesNotMatch(signed, /Open Anyway/);
});

test('invalid inputs are refused', () => {
  assert.throws(() => macosSection({ version: 'v0.3.0', file: 'aidevbridge-v0.3.0-macos-universal.dmg', sha256: sha, signing: 'ad-hoc' }), /Invalid version/);
  assert.throws(() => macosSection({ version: '0.3.0', file: 'other.dmg', sha256: sha, signing: 'ad-hoc' }), /Unexpected file name/);
  assert.throws(() => macosSection({ version: '0.3.0', file: 'aidevbridge-0.3.0-macos-universal.dmg', sha256: 'abc', signing: 'ad-hoc' }), /SHA-256/);
  assert.throws(() => macosSection({ version: '0.3.0', file: 'aidevbridge-0.3.0-macos-universal.dmg', sha256: sha, signing: 'none' }), /signing mode/);
});

test('a hand-written release text keeps every line; the macOS part is appended once and then replaced', () => {
  const body = 'Intro.\r\n\r\n## Downloads\r\n\r\nWindows table.\r\n';
  const first = mergeBody(body, section());
  assert.equal(first, `Intro.\n\n## Downloads\n\nWindows table.\n\n${section()}\n`);
  const edited = first.replace('Windows table.', 'Windows table, edited by hand.') + '\nA later remark.\n';
  const second = mergeBody(edited, section('developer-id'));
  assert.equal(second, edited.replace(section(), section('developer-id')));
  assert.equal(mergeBody(second, section('developer-id')), second);
  assert.equal(mergeBody('', section()), `${section()}\n`);
  assert.equal(mergeBody(null, section()), `${section()}\n`);
});

test('a damaged marker pair is not guessed at', () => {
  assert.throws(() => mergeBody(`Intro\n${START}\nhalf`, section()), /damaged/);
  assert.throws(() => mergeBody(`${END}\n${START}`, section()), /damaged/);
  assert.throws(() => mergeBody(`${START}${END}\n${START}${END}`, section()), /damaged/);
  assert.throws(() => mergeBody('Intro', '## macOS'), /Not a marked/);
});

test('a release the workflow creates links the changelog of its tag', () => {
  const body = newReleaseBody({ version: '0.3.0', section: section() });
  assert.ok(body.startsWith('aidevbridge 0.3.0. All changes: [CHANGELOG](https://github.com/ITBrain258/aidevbridge/blob/v0.3.0/CHANGELOG.md).\n\n'));
  assert.ok(body.endsWith(`${END}\n`));
});
