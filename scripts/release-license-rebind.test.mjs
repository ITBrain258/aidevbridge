import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { rebind } from './release-license-rebind.mjs';
import { releaseLicenses } from './release-licenses.mjs';

const selectionPath = 'docs/release/license-selection.windows-x64.json';
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const record = b => ({ bytes: b.length, sha256: digest(b) });

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'aidevbridge-rebind-test-'));
  const originalRoot = fs.realpathSync(root);
  t.after(() => {
    // Recursion is confined to this independently created test fixture.
    assert.equal(fs.realpathSync(root), originalRoot);
    assert.equal(path.dirname(originalRoot), parent);
    assert.ok(path.basename(originalRoot).startsWith('aidevbridge-rebind-test-'));
    fs.rmSync(originalRoot, { recursive: true });
  });
  const write = (p, bytes) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), bytes); };
  const read = p => fs.readFileSync(path.join(root, p));
  const notices = Buffer.from('Third-party notices, package 1.0\n');
  const lock = Buffer.from('locked dependency 1\n');
  const source = Buffer.from('fn main() {}\n');
  const dependency = Buffer.from('{"version":"1.0.0"}\n');
  write('NOTICES.md', notices); write('lock.json', lock); write('src/main.rs', source); write('node_modules/dep/package.json', dependency);
  const noticeId = `sha256:${digest(notices)}`;
  const selection = {
    schema_version: 1, selection_id: 'fixture',
    scope: { target: 'x86_64-pc-windows-msvc', default_features: true, cargo_features: ['tauri/custom-protocol'], rust_toolchain: '1.97.1' },
    inputs: {
      files: [{ path: 'NOTICES.md', ...record(notices) }, { path: 'lock.json', ...record(lock) }, { path: 'node_modules/dep/package.json', ...record(dependency) }],
      absent: [], trees: [{ path: 'src', files: [{ path: 'src/main.rs', ...record(source) }] }], cargo_packages: [], cargo_files: [],
    },
    documents: [{ id: noticeId, file_name: 'NOTICES.md', ...record(notices), sources: [{ kind: 'file', path: 'NOTICES.md' }], source_names: ['NOTICES.md'], source_urls: [] }],
    components: ['first', 'second'].map(name => ({ id: `npm:${name}@1.0.0`, name, version: '1.0.0', disposition: 'include', selected_license: 'MIT', documents: [noticeId], reason: 'Fixture selection' })),
    pending_delivery: ['Installer acceptance remains.'],
  };
  const selectionBytes = Buffer.from(`${JSON.stringify(selection, null, 2)}\n`);
  write(selectionPath, selectionBytes);
  return { root, write, read, selectionBytes, noticeId, selection: () => JSON.parse(read(selectionPath)) };
}

test('a dry run lists every changed record and leaves the selection untouched', t => {
  const f = fixture(t);
  f.write('lock.json', 'locked dependency 2\n');
  f.write('src/main.rs', 'fn main() { run() }\n');
  const result = rebind(['lock.json', 'src/main.rs'], { root: f.root });
  assert.equal(result.written, false);
  assert.deepEqual(result.changes.map(c => [c.path, c.binding]), [['lock.json', 'inputs.files'], ['src/main.rs', 'inputs.trees:src']]);
  assert.deepEqual(f.read(selectionPath), f.selectionBytes);
});

test('write rebinds files, tree entries and a document with every reference, and the helper check passes', t => {
  const f = fixture(t);
  const notices = Buffer.from('Third-party notices, package 1.1\n');
  f.write('NOTICES.md', notices);
  f.write('src/main.rs', 'fn main() { run() }\n');
  const result = rebind(['NOTICES.md', 'src/main.rs'], { root: f.root, write: true });
  assert.equal(result.written, true);
  const selection = f.selection();
  const newId = `sha256:${digest(notices)}`;
  assert.deepEqual(selection.documents.map(d => d.id), [newId]);
  assert.deepEqual(selection.components.map(c => c.documents), [[newId], [newId]]);
  assert.equal(selection.inputs.files[0].sha256, digest(notices));
  assert.match(f.read(selectionPath).toString(), /^\{\n {2}"schema_version": 1,/);
  assert.ok(f.read(selectionPath).toString().endsWith('}\n'));
  assert.equal(releaseLicenses('prepare', { root: f.root, metadata: [] }).components, 2);
});

test('it refuses unbound paths, files outside a tree list and dependency files without --third-party', t => {
  const f = fixture(t);
  f.write('README.md', 'not bound\n');
  f.write('src/new.rs', 'pub fn new() {}\n');
  f.write('node_modules/dep/package.json', '{"version":"1.0.1"}\n');
  assert.throws(() => rebind(['README.md'], { root: f.root }), /Not bound by the license selection: README\.md/);
  assert.throws(() => rebind(['src/new.rs'], { root: f.root }), /not listed in tree src/);
  assert.throws(() => rebind(['node_modules/dep/package.json'], { root: f.root, write: true }), /--third-party/);
  assert.deepEqual(f.read(selectionPath), f.selectionBytes);
  assert.equal(rebind(['node_modules/dep/package.json'], { root: f.root, write: true, thirdParty: true }).changes.length, 1);
});

test('--add binds a new input file in path order', t => {
  const f = fixture(t);
  f.write('docs/report.json', '{"decision":"fixture"}\n');
  assert.throws(() => rebind(['docs/report.json'], { root: f.root }), /Not bound/);
  rebind(['docs/report.json'], { root: f.root, write: true, add: true });
  assert.deepEqual(f.selection().inputs.files.map(x => x.path), ['NOTICES.md', 'docs/report.json', 'lock.json', 'node_modules/dep/package.json']);
});
