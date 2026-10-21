import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { releaseLicenses } from './release-licenses.mjs';
import { createZip } from './release-windows-artifacts.mjs';

const selectionPath = 'docs/release/license-selection.windows-x64.json';
const outputPath = 'out/release-notices';
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const record = b => ({ bytes: b.length, sha256: digest(b) });

function fixture(t, { blob = false, cargo = false } = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'aidevbridge-license-test-'));
  const originalRoot = fs.realpathSync(root);
  t.after(() => {
    // Recursion is confined to this independently created test fixture.
    assert.equal(fs.realpathSync(root), originalRoot);
    assert.equal(path.dirname(originalRoot), parent);
    assert.ok(path.basename(originalRoot).startsWith('aidevbridge-license-test-'));
    fs.rmSync(originalRoot, { recursive: true });
  });
  const write = (p, bytes) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), bytes); };
  const read = p => fs.readFileSync(path.join(root, p));
  const terms = Buffer.from('Original copyright \xc2\xa9\r\nPermission text.  \nNo final newline', 'binary');
  const lock = Buffer.from('locked dependency 1\n');
  const asset = Buffer.from('<svg>original</svg>\n');
  write('lock.json', lock); write('assets/icon.svg', asset); write('terms.txt', terms);
  const source = blob ? { kind: 'inventory_blob', path: 'inventory.json', sha256: digest(terms) } : { kind: 'file', path: 'terms.txt' };
  const selection = {
    schema_version: 1, selection_id: 'fixture',
    scope: { target: 'x86_64-pc-windows-msvc', default_features: true, cargo_features: ['tauri/custom-protocol'], rust_toolchain: '1.97.1' },
    inputs: { files: [{ path: 'lock.json', ...record(lock) }], absent: ['override.json'], trees: [{ path: 'assets', files: [{ path: 'assets/icon.svg', ...record(asset) }] }], cargo_packages: [], cargo_files: [] },
    documents: [{ id: 'shared', file_name: 'Original-LICENSE.txt', ...record(terms), sources: [source], source_names: ['first/LICENSE', 'second/LICENSE'], source_urls: [] }],
    components: ['First <component>', 'Second component'].map((name, i) => ({ id: String(i), name, version: '1', disposition: 'include', selected_license: 'MIT', documents: ['shared'], reason: 'Explicit fixture selection', copyright_notices: [{ text: 'Copyright retained', path: 'src/lib.rs', line: 1 }] })),
    pending_delivery: ['Actual installer acceptance remains.'],
  };
  if (blob) {
    const inventory = Buffer.from(JSON.stringify({ status: 'pending-not-an-approval', candidate_texts_by_sha256: { [digest(terms)]: { ...record(terms), encoding: 'base64', content: terms.toString('base64') } } }));
    write('inventory.json', inventory);
    selection.inputs.files.push({ path: 'inventory.json', ...record(inventory) });
  }
  const metadata = [];
  if (cargo) {
    const manifest = Buffer.from('[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT"\n');
    const implementation = Buffer.from('pub fn fixture() {}\n');
    write('cargo/Cargo.toml', manifest); write('cargo/src/lib.rs', implementation);
    selection.inputs.cargo_packages.push({ package: 'fixture@1.0.0', source: null, manifest: record(manifest), declared_license: 'MIT' });
    selection.inputs.cargo_trees = [{ package: 'fixture@1.0.0', path: 'src', files: [{ path: 'src/lib.rs', ...record(implementation) }] }];
    metadata.push({ name: 'fixture', version: '1.0.0', source: null, manifest_path: path.join(root, 'cargo/Cargo.toml'), license: 'MIT' });
  }
  const save = () => write(selectionPath, JSON.stringify(selection));
  save();
  return { root, terms, selection, metadata, write, read, save, run: mode => releaseLicenses(mode, { root, metadata }) };
}

test('prepare/check preserve exact bytes and shared component attribution, repeat deterministically', t => {
  const f = fixture(t);
  const first = f.run('prepare');
  const originalIndex = f.read(`${outputPath}/index.html`);
  const originalMapping = f.read(`${outputPath}/manifest.json`);
  const originalStat = fs.statSync(path.join(f.root, outputPath, 'index.html'));
  assert.equal(first.texts, 1);
  assert.deepEqual(f.read(`${outputPath}/texts/Original-LICENSE.txt`), f.terms);
  assert.match(originalIndex.toString(), /First &lt;component&gt;/);
  assert.match(originalIndex.toString(), /Copyright retained/);
  const mapping = JSON.parse(originalMapping);
  assert.equal(mapping.components.length, 2);
  assert.equal(mapping.components[0].documents[0].path, mapping.components[1].documents[0].path);
  assert.deepEqual(mapping.documents[0].source_names, ['first/LICENSE', 'second/LICENSE']);
  assert.equal(f.run('check').selection_sha256, first.selection_sha256);
  assert.equal(f.run('prepare').selection_sha256, first.selection_sha256);
  assert.deepEqual(f.read(`${outputPath}/index.html`), originalIndex);
  assert.deepEqual(f.read(`${outputPath}/manifest.json`), originalMapping);
  assert.equal(fs.statSync(path.join(f.root, outputPath, 'index.html')).mtimeMs, originalStat.mtimeMs);
});

test('explicit historical blob selection works without interpreting inventory status as approval', t => {
  const f = fixture(t, { blob: true });
  f.run('prepare');
  assert.deepEqual(f.read(`${outputPath}/texts/Original-LICENSE.txt`), f.terms);
});

function withSources(f) {
  const archives = ['first', 'second'].map((name, i) => {
    const commit = String(i + 1).repeat(40), archiveRoot = `${name}-${commit}`;
    const bytes = createZip(new Map([[`${archiveRoot}/src/decoder.c`, Buffer.from(`Original source ${i}\r\n\0\xff`, 'binary')]]));
    const item = { id: `${name}-source`, kind: 'source_zip', path: `docs/release/sources/${name}.zip`, file_name: `${name}.zip`, ...record(bytes), source_url: `https://example.invalid/${name}/archive/${commit}.zip`, commit, archive_root: archiveRoot, components: [String(i)] };
    f.write(item.path, bytes);
    f.selection.components[i].source_archives = [item.id];
    return { item, bytes };
  });
  const readme = Buffer.from('Original source guide.\r\nNo conversion.  \n');
  f.selection.source_archives = archives.map(a => a.item);
  f.selection.source_readme = { path: 'docs/release/sources/README.txt', ...record(readme) };
  f.write(f.selection.source_readme.path, readme); f.save();
  return { archives, readme };
}

test('selected source ZIPs remain byte-exact offline files with reciprocal component links and deterministic output', t => {
  const f = fixture(t), { archives, readme } = withSources(f);
  const prepared = f.run('prepare'), manifest = JSON.parse(f.read(`${outputPath}/manifest.json`));
  assert.equal(prepared.source_archives, 2); assert.equal(prepared.files, 7);
  assert.deepEqual(f.read(`${outputPath}/sources/README.txt`), readme);
  assert.deepEqual(manifest.source_readme, { path: 'sources/README.txt', ...record(readme) });
  const index = f.read(`${outputPath}/index.html`).toString();
  assert.match(index, /href="sources\/README.txt"/);
  for (const { item, bytes } of archives) {
    const output = `sources/${item.file_name}`, mapped = manifest.source_archives.find(a => a.id === item.id);
    assert.deepEqual(f.read(`${outputPath}/${output}`), bytes);
    assert.deepEqual(mapped, { id: item.id, kind: item.kind, path: output, ...record(bytes), source_url: item.source_url, commit: item.commit, archive_root: item.archive_root, components: item.components });
    assert.deepEqual(manifest.components.find(c => c.id === item.components[0]).source_archives, [{ id: item.id, path: output, ...record(bytes) }]);
    assert.ok(index.includes(`href="${output}"`));
  }
  const before = f.read(`${outputPath}/manifest.json`);
  assert.equal(f.run('check').selection_sha256, prepared.selection_sha256);
  assert.equal(f.run('prepare').selection_sha256, prepared.selection_sha256);
  assert.deepEqual(f.read(`${outputPath}/manifest.json`), before);
});

for (const [name, mutate, expected] of [
  ['changed ZIP bytes', f => f.write(f.selection.source_archives[0].path, 'changed'), /Input changed/],
  ['missing ZIP', f => fs.unlinkSync(path.join(f.root, f.selection.source_archives[0].path)), /ENOENT/],
  ['unsupported archive type', f => { f.selection.source_archives[0].kind = 'tar'; }, /Unsupported source archive kind/],
  ['malformed archive list', f => { f.selection.source_archives = null; }, /Expected at most two selected source ZIPs/],
  ['archive path escaping its selected directory', f => { f.selection.source_archives[0].path = '../first.zip'; }, /Unexpected source ZIP path/],
  ['unsafe archive output name', f => { f.selection.source_archives[0].file_name = '../first.zip'; }, /Unsafe source ZIP filename/],
  ['duplicate case-insensitive archive output', f => { f.selection.source_archives[1].file_name = 'FIRST.zip'; }, /Duplicate source ZIP filename/],
  ['duplicate archive ID', f => { f.selection.source_archives[1].id = f.selection.source_archives[0].id; }, /duplicate source archive ID/],
  ['unknown component reference', f => { f.selection.source_archives[0].components.push('unknown'); }, /Unassigned source ZIP/],
  ['missing reverse component reference', f => { delete f.selection.components[0].source_archives; }, /Unassigned source ZIP/],
  ['mismatched component reference', f => { f.selection.components[0].source_archives = ['second-source']; }, /Unknown or mismatched source archive/],
  ['excluded source component', f => { f.selection.components[0].disposition = 'exclude'; f.selection.components[0].documents = []; }, /Excluded component has source archives/],
  ['unbound source README', f => { delete f.selection.source_readme; }, /require the local sources README/],
  ['changed source README', f => f.write(f.selection.source_readme.path, 'changed'), /Input changed/],
  ['invalid provenance URL', f => { f.selection.source_archives[0].source_url = 'javascript:alert(1)'; }, /Invalid source ZIP provenance/],
]) test(`${name} fails before source output is created`, t => {
  const f = fixture(t); withSources(f); mutate(f); f.save();
  assert.throws(() => f.run('prepare'), expected);
  assert.equal(fs.existsSync(path.join(f.root, outputPath)), false);
});

for (const [name, mutate, expected] of [
  ['changed copied ZIP', f => f.write(`${outputPath}/sources/first.zip`, 'retained change'), /Output differs/],
  ['foreign copied ZIP', f => f.write(`${outputPath}/sources/foreign.zip`, 'retain'), /additional or stale files/],
  ['nested empty source directory', f => fs.mkdirSync(path.join(f.root, outputPath, 'sources/nested')), /unexpected directories/],
  ['nested empty text directory beside sources', f => fs.mkdirSync(path.join(f.root, outputPath, 'texts/nested')), /unexpected directories/],
]) test(`${name} is rejected without replacing existing output`, t => {
  const f = fixture(t); withSources(f); f.run('prepare'); mutate(f);
  const before = f.read(`${outputPath}/manifest.json`);
  assert.throws(() => f.run('check'), expected); assert.throws(() => f.run('prepare'), expected);
  assert.deepEqual(f.read(`${outputPath}/manifest.json`), before);
  if (name === 'changed copied ZIP') assert.equal(f.read(`${outputPath}/sources/first.zip`).toString(), 'retained change');
});

function generatedPermissions(f) {
  const items = ['connect_host', 'disconnect_host'].map(name => {
    const path = `src-tauri/permissions/autogenerated/${name}.toml`, bytes = Buffer.from(`Fixture permission ${name}\n`);
    return { path, bytes };
  });
  f.selection.inputs.trees.push({ path: 'src-tauri/permissions', availability: 'generated-by-cargo', files: items.map(item => ({ path: item.path, ...record(item.bytes) })) });
  f.save();
  return { items, strictCheck: () => releaseLicenses('check', { root: f.root, metadata: f.metadata, requireGenerated: true }) };
}

test('fresh checkout may lack generated permissions before Cargo; after Cargo the full exact tree is required', t => {
  const f = fixture(t), { items, strictCheck } = generatedPermissions(f);
  f.run('prepare'); f.run('check');
  assert.equal(fs.existsSync(path.join(f.root, 'src-tauri/permissions')), false);
  assert.throws(strictCheck, /ENOENT/);
  f.write(items[0].path, items[0].bytes);
  assert.throws(() => f.run('check'), /Input tree changed/);
  assert.throws(strictCheck, /Input tree changed/);
  f.write(items[1].path, items[1].bytes);
  assert.equal(strictCheck().status, 'notice_directory_verified_not_release_approved');
  f.write(items[0].path, 'modified permission');
  assert.throws(strictCheck, /Input changed or missing/);
});

test('generated-tree exception still rejects custom permissions and stale orphaned TOMLs', t => {
  const f = fixture(t), { items, strictCheck } = generatedPermissions(f);
  f.run('prepare');
  for (const item of items) f.write(item.path, item.bytes);
  f.write('src-tauri/permissions/custom.toml', 'custom');
  assert.throws(() => f.run('check'), /Input tree changed/);
  assert.throws(strictCheck, /Input tree changed/);
  fs.unlinkSync(path.join(f.root, 'src-tauri/permissions/custom.toml'));
  f.write('src-tauri/permissions/autogenerated/removed_command.toml', 'orphan');
  assert.throws(() => f.run('check'), /Input tree changed/);
  assert.throws(strictCheck, /Input tree changed/);
});

test('ordinary source trees cannot use the generated-permissions absence rule', t => {
  const f = fixture(t);
  f.selection.inputs.trees[0].availability = 'generated-by-cargo'; f.save();
  assert.throws(() => f.run('prepare'), /Only the explicit generated Tauri permissions tree/);
});

test('generated pre-Cargo absence never accepts a Windows junction', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); generatedPermissions(f);
  fs.mkdirSync(path.join(f.root, 'src-tauri'));
  fs.symlinkSync(path.join(f.root, 'assets'), path.join(f.root, 'src-tauri/permissions'), 'junction');
  assert.throws(() => f.run('prepare'), /Symlink\/reparse/);
});

for (const [name, mutate, expected] of [
  ['changed lock', f => f.write('lock.json', 'different'), /Input changed/],
  ['changed asset', f => f.write('assets/icon.svg', '<svg>changed</svg>'), /Input changed/],
  ['added asset', f => f.write('assets/extra.svg', '<svg/>'), /Input tree changed/],
  ['missing original text', f => fs.unlinkSync(path.join(f.root, 'terms.txt')), /ENOENT/],
  ['new override configuration', f => f.write('override.json', '{}'), /Previously absent/],
  ['unresolved component', f => { f.selection.components[0].disposition = 'unresolved'; f.save(); }, /Unresolved license selection/],
  ['changed feature selection', f => { f.selection.scope.cargo_features = []; f.save(); }, /Target\/features\/toolchain/],
  ['escaping source path', f => { f.selection.documents[0].sources[0].path = '../terms.txt'; f.save(); }, /Unsafe relative path/],
]) test(`${name} fails before creating an output directory`, t => {
  const f = fixture(t); mutate(f);
  assert.throws(() => f.run('prepare'), expected);
  assert.equal(fs.existsSync(path.join(f.root, outputPath)), false);
});

for (const [name, mutate, expected] of [
  ['unexpected payload file', f => f.write(`${outputPath}/unexpected.dll`, 'retain me'), /additional or stale files/],
  ['changed copied text', f => f.write(`${outputPath}/texts/Original-LICENSE.txt`, 'retain this change'), /Output differs/],
  ['unexpected empty directory', f => fs.mkdirSync(path.join(f.root, outputPath, 'extra')), /unexpected directories/],
  ['changed selection', f => { f.selection.components[0].reason = 'New selection'; f.save(); }, /Output differs/],
]) test(`${name} is rejected and existing output is retained`, t => {
  const f = fixture(t); f.run('prepare'); mutate(f);
  const before = f.read(`${outputPath}/index.html`);
  assert.throws(() => f.run('check'), expected);
  assert.throws(() => f.run('prepare'), expected);
  assert.deepEqual(f.read(`${outputPath}/index.html`), before);
  if (name === 'unexpected payload file') assert.equal(f.read(`${outputPath}/unexpected.dll`).toString(), 'retain me');
  if (name === 'changed copied text') assert.equal(f.read(`${outputPath}/texts/Original-LICENSE.txt`).toString(), 'retain this change');
});

test('an unowned existing output directory is never adopted or cleared', t => {
  const f = fixture(t); f.write(`${outputPath}/personal.txt`, 'retain');
  assert.throws(() => f.run('prepare'), /ENOENT/);
  assert.equal(f.read(`${outputPath}/personal.txt`).toString(), 'retain');
});

test('Cargo source changes and new package identities invalidate the selected boundary', t => {
  const f = fixture(t, { cargo: true }); f.run('prepare');
  f.write('cargo/src/lib.rs', 'pub fn changed() {}');
  assert.throws(() => f.run('check'), /Input changed/);
  f.metadata.push({ name: 'new', version: '1', source: null });
  assert.throws(() => f.run('check'), /Cargo package set changed/);
});

test('directory link cannot redirect generated output outside its fixed owned path', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'elsewhere'));
  fs.symlinkSync(path.join(f.root, 'elsewhere'), path.join(f.root, 'out'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.run('prepare'), /Symlink\/reparse path/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'elsewhere')), []);
});
