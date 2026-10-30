import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isThirdParty, drift, rebindOwn, platformsIn } from './release-license-status.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SELECTION = 'docs/release/license-selection.windows-x64.json';

// A checkout with one Windows selection that binds an own file, an own source
// tree (tests excluded), a lock file, a license document and an absent file.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidevbridge-license-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { const file = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const record = rel => { const bytes = fs.readFileSync(path.join(root, ...rel.split('/'))); return { path: rel, bytes: bytes.length, sha256: sha(bytes) }; };
  for (const [rel, text] of Object.entries({ 'src-tauri/tauri.conf.json': '{}\n', 'src/a.ts': 'a\n', 'src/c.ts': 'c\n', 'package-lock.json': '{}\n', 'docs/release/licenses/dep-LICENSE.txt': 'MIT\n', 'src-tauri/Cargo.toml': '[package]\n' })) write(rel, text);
  const doc = record('docs/release/licenses/dep-LICENSE.txt');
  const selection = {
    schema_version: 1,
    components: [],
    documents: [{ id: `sha256:${doc.sha256}`, file_name: 'dep-LICENSE.txt', bytes: doc.bytes, sha256: doc.sha256, sources: [{ kind: 'file', path: doc.path }], source_names: [], source_urls: [] }],
    inputs: {
      files: [record('src-tauri/tauri.conf.json'), record('package-lock.json')],
      trees: [{ path: 'src', exclude_suffixes: ['.test.ts'], files: [record('src/a.ts'), record('src/c.ts')] }],
      absent: ['.cargo/config.toml'],
      cargo_packages: [
        { package: 'app@1.0.0', source: null, manifest: { bytes: 1, sha256: '0'.repeat(64) }, declared_license: 'MIT' },
        { package: 'dep@1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', manifest: { bytes: 1, sha256: '0'.repeat(64) }, declared_license: 'MIT' },
      ],
      cargo_files: [],
      cargo_trees: [],
    },
  };
  write(SELECTION, `${JSON.stringify(selection, null, 2)}\n`);
  return { root, write };
}
const metadataFor = root => ({ 'windows-x64': [
  { name: 'app', version: '1.0.0', source: null, license: 'MIT', manifest_path: path.join(root, 'src-tauri', 'Cargo.toml') },
  { name: 'dep', version: '2.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', license: 'MIT', manifest_path: path.join(root, 'src-tauri', 'Cargo.toml') },
] });
const brief = entries => entries.map(d => `${d.third_party ? 'third' : 'own'} ${d.problem} ${d.path}`).sort();

test('lock files, dependencies, vendored code and release evidence count as third-party', () => {
  for (const p of ['Cargo.lock', 'package-lock.json', 'node_modules/vite/LICENSE.md', 'src-tauri/gen/android/app/gradle.lockfile', 'docs/release/licenses/x.txt', 'vendor/russh/', 'THIRD_PARTY_LICENSES.md']) assert.equal(isThirdParty(p), true, p);
  for (const p of ['src/main.ts', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.toml', 'package.json', 'scripts/release-licenses.mjs', 'docs/stand.md']) assert.equal(isThirdParty(p), false, p);
});

test('drift lists every changed binding at once and sorts own from third-party', t => {
  const f = fixture(t);
  assert.deepEqual(platformsIn(f.root), ['windows-x64']);
  f.write('src/a.ts', 'a changed\n');
  f.write('src/b.ts', 'new\n');
  fs.rmSync(path.join(f.root, 'src', 'c.ts'));
  f.write('src/b.test.ts', 'excluded\n');
  f.write('package-lock.json', '{"changed":true}\n');
  f.write('docs/release/licenses/dep-LICENSE.txt', 'MIT, changed\n');
  f.write('.cargo/config.toml', '[build]\n');
  f.write('src-tauri/Cargo.toml', '[package]\nversion = "1.0.0"\n');
  assert.deepEqual(brief(drift(f.root, 'windows-x64', { metadata: metadataFor(f.root)['windows-x64'] })), [
    'own added src/b.ts',
    'own appeared .cargo/config.toml',
    'own changed src-tauri/Cargo.toml',
    'own changed src/a.ts',
    'own missing src/c.ts',
    'third added cargo:dep@2.0.0',
    'third changed docs/release/licenses/dep-LICENSE.txt',
    'third changed package-lock.json',
    'third missing cargo:dep@1.0.0',
  ]);
});

test('rebinding own drift refreshes own files, trees and the app manifest and leaves the rest', t => {
  const f = fixture(t);
  f.write('src/a.ts', 'a changed\n');
  f.write('src/b.ts', 'new\n');
  fs.rmSync(path.join(f.root, 'src', 'c.ts'));
  f.write('package-lock.json', '{"changed":true}\n');
  f.write('.cargo/config.toml', '[build]\n');
  f.write('src-tauri/Cargo.toml', '[package]\nversion = "1.0.0"\n');
  const metadata = metadataFor(f.root);
  const result = rebindOwn(f.root, { metadata });
  assert.deepEqual(result.handled.map(d => `${d.problem} ${d.path}`).sort(), ['added src/b.ts', 'changed src-tauri/Cargo.toml', 'changed src/a.ts', 'missing src/c.ts']);
  assert.deepEqual(result.manual.map(d => `${d.problem} ${d.path}`), ['appeared .cargo/config.toml']);
  assert.deepEqual(result.third_party.map(d => d.path).sort(), ['cargo:dep@1.0.0', 'cargo:dep@2.0.0', 'package-lock.json']);
  assert.deepEqual(brief(drift(f.root, 'windows-x64', { metadata: metadata['windows-x64'] })), ['own appeared .cargo/config.toml', 'third added cargo:dep@2.0.0', 'third changed package-lock.json', 'third missing cargo:dep@1.0.0']);
  const selection = JSON.parse(fs.readFileSync(path.join(f.root, ...SELECTION.split('/')), 'utf8'));
  assert.deepEqual(selection.inputs.trees[0].files.map(x => x.path), ['src/a.ts', 'src/b.ts']);
  assert.equal(selection.inputs.files.find(x => x.path === 'package-lock.json').sha256, sha(Buffer.from('{}\n')));
});
