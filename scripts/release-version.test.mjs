import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELECTIONS, setSelectionVersion, versionProblems, WINDOWS_SELECTION } from './release-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The repository itself: every place names the version in package.json. On a
// release pull request this fails until the bump, the license derive and the
// texts of the release are all done.
test('every version place of the repository agrees with package.json', () => {
  const { version, places, problems } = versionProblems(ROOT);
  assert.deepEqual(problems, [], `version ${version}`);
  assert.ok(places >= 30, `only ${places} places checked`);
});

// A selection in the shape of the real ones, with the places a release
// changes and neighbours that must stay as they are.
const selection = (version = '0.3.2') => `{
  "scope": {
    "product": "aidevbridge",
    "product_version": "${version}"
  },
  "inputs": {
    "cargo_packages": [
      {
        "package": "want@${version}",
        "manifest": { "bytes": 1, "sha256": "aa" }
      },
      {
        "package": "aidevbridge@${version}",
        "source": null,
        "manifest": { "bytes": 5844, "sha256": "bb" }
      }
    ]
  },
  "documents": [
    {
      "package": "aidevbridge@${version}",
      "path": "tests/fixtures/rsa-signing/LICENSE-APACHE-2.0"
    }
  ],
  "components": [
    {
      "id": "cargo:aidevbridge@${version}",
      "name": "aidevbridge",
      "version": "${version}",
      "declared_license": "MIT OR Apache-2.0"
    },
    {
      "id": "cargo:want@${version}",
      "name": "want",
      "version": "${version}",
      "reason": "Updated from aidevbridge-core@0.3.2 and ml-kem@${version}"
    }
  ]
}
`;

test('the selection gets the new version at its places and nowhere else', () => {
  const out = setSelectionVersion(selection(), 'aidevbridge', '0.3.2', '0.4.0');
  const expected = selection()
    .replace('"product_version": "0.3.2"', '"product_version": "0.4.0"')
    .replaceAll('"package": "aidevbridge@0.3.2"', '"package": "aidevbridge@0.4.0"')
    .replace('"id": "cargo:aidevbridge@0.3.2",\n      "name": "aidevbridge",\n      "version": "0.3.2"', '"id": "cargo:aidevbridge@0.4.0",\n      "name": "aidevbridge",\n      "version": "0.4.0"');
  assert.notEqual(expected, selection());
  assert.equal(out, expected);
  assert.match(out, /"package": "want@0\.3\.2"/);
  assert.match(out, /"id": "cargo:want@0\.3\.2",\n\s*"name": "want",\n\s*"version": "0\.3\.2"/);
  assert.match(out, /aidevbridge-core@0\.3\.2/);
});

test('CRLF line endings stay CRLF', () => {
  const crlf = selection().replaceAll('\n', '\r\n');
  const out = setSelectionVersion(crlf, 'aidevbridge', '0.3.2', '0.4.0');
  assert.equal(out, setSelectionVersion(selection(), 'aidevbridge', '0.3.2', '0.4.0').replaceAll('\n', '\r\n'));
});

test('the same version leaves the text untouched', () => {
  assert.equal(setSelectionVersion(selection(), 'aidevbridge', '0.3.2', '0.3.2'), selection());
});

test('a selection at another version is refused', () => {
  assert.throws(() => setSelectionVersion(selection('0.3.1'), 'aidevbridge', '0.3.2', '0.4.0'), /product_version is "0\.3\.1", expected "0\.3\.2"/);
});

test('a version of the own crate in an unknown form is refused, not left behind', () => {
  const text = selection().replace('"declared_license": "MIT OR Apache-2.0"', '"declared_license": "MIT OR Apache-2.0",\n      "note": "see aidevbridge@0.3.2"');
  assert.throws(() => setSelectionVersion(text, 'aidevbridge', '0.3.2', '0.4.0'), /left at 1 place\(s\) of an unknown form/);
});

test('a component whose fields are not id, name, version in this order is refused', () => {
  const text = selection().replace('"name": "aidevbridge",\n      "version": "0.3.2"', '"version": "0.3.2",\n      "name": "aidevbridge"');
  assert.throws(() => setSelectionVersion(text, 'aidevbridge', '0.3.2', '0.4.0'), /component cargo:aidevbridge@0\.3\.2/);
});

test('0.3.2 does not match inside 0.3.20', () => {
  const text = selection().replace('"source": null', '"source": null,\n        "older": "aidevbridge@0.3.20"');
  const out = setSelectionVersion(text, 'aidevbridge', '0.3.2', '0.4.0');
  assert.match(out, /"older": "aidevbridge@0\.3\.20"/);
});

test('each real selection changes at exactly eight lines', () => {
  for (const file of SELECTIONS) {
    const text = fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8');
    const version = JSON.parse(text).scope.product_version;
    const out = setSelectionVersion(text, 'aidevbridge', version, '99.0.0');
    const before = text.split('\n'), after = out.split('\n');
    assert.equal(after.length, before.length, file);
    assert.equal(before.filter((line, i) => line !== after[i]).length, 8, file);
  }
});

// A minimal repository with every place at 1.2.3; each case breaks one place.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('package.json', JSON.stringify({ name: 'aidevbridge', version: '1.2.3' }));
  write('package-lock.json', JSON.stringify({ name: 'aidevbridge', version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
  write('src-tauri/tauri.conf.json', JSON.stringify({ version: '1.2.3' }));
  write('src-tauri/Cargo.toml', '[package]\nname = "aidevbridge"\nversion = "1.2.3"\n');
  write('Cargo.lock', 'version = 4\n\n[[package]]\nname = "aidevbridge"\nversion = "1.2.3"\n');
  for (const file of SELECTIONS) write(file, selection('1.2.3'));
  write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-11-11\n\n## [1.2.2] - 2026-11-10\n');
  write('docs/release/notes/1.2.3.md', 'What changed.\n');
  for (const locale of ['de-DE', 'en-US']) write(`fastlane/metadata/android/${locale}/changelogs/1002003.txt`, 'Text\n');
  write('docs/stand.md', '# Stand\n\n**Stand:** Version `1.2.3` vom 11.11.2026.\n');
  write('SECURITY.md', '| Version | Supported |\n| --- | --- |\n| Latest release (1.2.x) | Yes |\n| Older releases | No |\n');
  return { root, write, edit: (file, from, to) => write(file, fs.readFileSync(path.join(root, file), 'utf8').replace(from, to)) };
}

test('the fixture repository agrees at every place', t => {
  const { root } = fixture(t);
  const { problems, places } = versionProblems(root);
  assert.deepEqual(problems, []);
  // 5 version files, 6 places in each of the 3 selections, 6 for the texts.
  assert.equal(places, 29);
});

test('a selection that was not derived yet is reported at each of its places', t => {
  const f = fixture(t);
  f.write(SELECTIONS[1], selection('1.2.2'));
  const { problems } = versionProblems(f.root);
  assert.deepEqual(problems.map(p => p.replace(/:.*/, '')), Array(4).fill(SELECTIONS[1]));
  assert.match(problems[0], /scope\.product_version: "1\.2\.2", expected "1\.2\.3"/);
  assert.match(problems[3], /3 place\(s\) name aidevbridge@1\.2\.2, expected 1\.2\.3/);
});

/** @type {Array<[string, (f: ReturnType<typeof fixture>) => void, RegExp]>} */
const ONE_PLACE = [
  ['package-lock.json', f => f.edit('package-lock.json', '"version":"1.2.3","packages"', '"version":"1.2.2","packages"'), /^package-lock\.json: version: "1\.2\.2"/],
  ['tauri.conf.json', f => f.write('src-tauri/tauri.conf.json', '{"version":"1.2.2"}'), /^src-tauri\/tauri\.conf\.json: version/],
  ['Cargo.toml', f => f.edit('src-tauri/Cargo.toml', 'version = "1.2.3"', 'version = "1.2.2"'), /^src-tauri\/Cargo\.toml: version/],
  ['Cargo.lock', f => f.edit('Cargo.lock', 'version = "1.2.3"', 'version = "1.2.2"'), /^Cargo\.lock: package aidevbridge/],
  ['a package entry left behind', f => f.edit(WINDOWS_SELECTION, '"package": "aidevbridge@1.2.3",\n      "path"', '"package": "aidevbridge@1.2.2",\n      "path"'), /windows-x64\.json: 1 place\(s\) name aidevbridge@1\.2\.2/],
  ['changelog', f => f.edit('CHANGELOG.md', '## [1.2.3] - 2026-11-11\n\n', ''), /^CHANGELOG\.md: newest version heading: "1\.2\.2"/],
  ['English summary', f => fs.rmSync(path.join(f.root, 'docs/release/notes/1.2.3.md')), /^English summary of the release: docs\/release\/notes\/1\.2\.3\.md is missing/],
  ['store notes', f => fs.rmSync(path.join(f.root, 'fastlane/metadata/android/en-US/changelogs/1002003.txt')), /^store notes en-US \(versionCode 1002003\)/],
  ['stand.md header', f => f.edit('docs/stand.md', '`1.2.3`', '`1.2.2`'), /^docs\/stand\.md: header/],
  ['SECURITY.md', f => f.edit('SECURITY.md', '(1.2.x)', '(1.1.x)'), /^SECURITY\.md: supported versions .*: "1\.1", expected "1\.2"/],
];

for (const [name, change, expected] of ONE_PLACE) {
  test(`a place left behind is reported: ${name}`, t => {
    const f = fixture(t);
    change(f);
    const { problems } = versionProblems(f.root);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], expected);
  });
}
