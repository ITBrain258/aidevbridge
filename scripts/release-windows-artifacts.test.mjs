import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeRelative, toRtf, crc32, createZip, readZip, verifyZip, fileTree, verifyTree, sourceSnapshot, releaseContract, claimRun, releaseLock, beforeBuild, beforeBundle, finishArtifacts, verifyRelease, verifyTools, command, BUNDLER_DOWNLOADS, CLI_VERSION, DOWNLOAD_SOURCE } from './release-windows-artifacts.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'aidevbridge-delivery-test-'));
  const original = fs.realpathSync(root);
  t.after(() => {
    assert.equal(fs.realpathSync(root), original); assert.equal(path.dirname(original), parent); assert.ok(path.basename(original).startsWith('aidevbridge-delivery-test-'));
    fs.rmSync(original, { recursive: true });
  });
  const write = (p, bytes) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), bytes); };
  const read = p => fs.readFileSync(path.join(root, p));
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Delivery fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, '.no-hooks')}`, 'commit', '-m', 'fixture']); };
  write('.gitignore', 'out/\ndist/\nnode_modules/\n');
  write('package.json', encode({ name: 'aidevbridge', version: '0.1.2' }));
  write('package-lock.json', encode({ version: '0.1.2', packages: { '': { version: '0.1.2' } } }));
  write('src-tauri/tauri.conf.json', encode({ productName: 'aidevbridge', version: '0.1.2', identifier: 'io.github.itbrain258.aidevbridge', build: { frontendDist: '../dist' }, bundle: {} }));
  write('src-tauri/tauri.release.windows.json', fs.readFileSync(path.join(repository, 'src-tauri/tauri.release.windows.json')));
  write('node_modules/@tauri-apps/cli/package.json', encode({ version: CLI_VERSION }));
  write('docs/release/license-selection.windows-x64.json', encode({ scope: { product_version: '0.1.2', target: 'x86_64-pc-windows-msvc', rust_toolchain: '1.97.1', default_features: true, cargo_features: ['tauri/custom-protocol'], installer_webview2_mode: 'downloadBootstrapper', installer_webview2_silent: true } }));
  write('docs/release/windows-installation-notice.txt', 'Introduction.\n');
  write('docs/release/licenses/microsoft-webview2-evergreen-2026-09-12-LICENSE.txt', 'Test terms only: © curly { braces } \\ 😀.\n');
  write('docs/release/windows-zip-readme.txt', 'Fixture start instructions.\n');
  git(['init', '--quiet']); commit();
  return { root, write, read, git, commit };
}
function begin(f) {
  const claimed = claimRun(f.root, sourceSnapshot(f.root), releaseContract(f.root), 'fixture');
  const env = { ...process.env, AIDEVBRIDGE_RELEASE_RUN: claimed.run.relative, AIDEVBRIDGE_RELEASE_TOKEN: claimed.lock.token, CARGO_TARGET_DIR: path.join(f.root, claimed.run.relative, 'cargo'), RUSTUP_TOOLCHAIN: '1.97.1', STATIC_VCRUNTIME: 'true' };
  return { ...claimed, env };
}
function fakeLicense(f) {
  return mode => {
    if (mode === 'prepare') {
      f.write('out/release-notices/index.html', '<html>Fixture notices</html>');
      f.write('out/release-notices/manifest.json', '{"fixture":true}\n');
      f.write('out/release-notices/.aidevbridge-release-notices.json', '{"fixture":true}\n');
      f.write('out/release-notices/texts/original.txt', Buffer.from('Copyright\r\nTerms.  \n'));
      f.write('out/release-notices/sources/fixture.zip', createZip(new Map([['upstream/src/decoder.c', Buffer.from('Original source\r\n')]])));
      f.write('out/release-notices/sources/README.txt', 'Fixture offline source guide.\n');
    }
  };
}
async function prepared(f, claimed) {
  const calls = [];
  const result = await beforeBuild(f.root, claimed.env, { runCommand: async (_root, _run, stage) => { calls.push(stage); f.write('dist/index.html', '<html>fresh frontend</html>'); }, licenses: fakeLicense(f) });
  assert.deepEqual(calls, ['frontend']); return result;
}
function fakeNative(f, claimed) {
  const release = `${claimed.run.relative}/cargo/x86_64-pc-windows-msvc/release`;
  const exe = Buffer.alloc(256); exe.write('MZ'); exe.writeUInt32LE(128, 60); exe.writeUInt32LE(0x4550, 128); exe.writeUInt16LE(0x8664, 132); exe.writeUInt16LE(0x20b, 152);
  f.write(`${release}/aidevbridge.exe`, exe); f.write(`${release}/aidevbridge.pdb`, 'PDB fixture, not a native build');
  for (const file of fileTree(f.root, 'out/release-notices').files) f.write(`${release}/licenses/${file.path}`, f.read(`out/release-notices/${file.path}`));
  return release;
}
const installerNoticePath = f => path.resolve(f.root, 'src-tauri', JSON.parse(f.read('src-tauri/tauri.release.windows.json')).bundle.licenseFile);

test('RTF emits Unicode UTF-16 escapes and preserves literal syntax as displayed text', () => {
  const output = toRtf('A {B} \\ © € 😀\r\nlast').toString('ascii');
  assert.ok(output.includes('A \\{B\\} \\\\ \\u169? \\u8364? \\u-10179?\\u-8704?\\par\nlast'));
  assert.ok([...toRtf('日本語')].every(b => b < 128));
  assert.deepEqual(toRtf('a\r\nb'), toRtf('a\nb'));
  assert.throws(() => toRtf('bad\0text'), /Invalid/);
});

test('configured notice bypasses the pinned Tauri CLI MSI text converter and preserves source bytes', async t => {
  const f = fixture(t), notice = installerNoticePath(f);
  // PathBuf::ends_with(".rtf") compares the complete final component in this CLI.
  assert.equal(path.basename(notice), '.rtf');
  const sources = ['docs/release/windows-installation-notice.txt', 'docs/release/licenses/microsoft-webview2-evergreen-2026-09-12-LICENSE.txt'];
  const originals = sources.map(p => f.read(p));
  const previous = Buffer.from('Retained earlier output, not owned by this run.');
  f.write('out/release-installer-notice.rtf', previous);
  const claimed = begin(f), snapshot = await prepared(f, claimed);
  const bytes = fs.readFileSync(notice), owner = JSON.parse(fs.readFileSync(`${notice}.owner.json`));
  assert.deepEqual(bytes, toRtf(`${originals[0].toString('utf8')}\n${originals[1].toString('utf8')}`));
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '{\\rtf');
  assert.deepEqual(snapshot.rtf, record(bytes));
  assert.equal(owner.owner, 'aidevbridge-windows-release-v1');
  assert.deepEqual({ bytes: owner.bytes, sha256: owner.sha256 }, record(bytes));
  assert.deepEqual(owner.sources, sources.map((p, i) => ({ path: p, ...record(originals[i]) })));
  sources.forEach((p, i) => assert.deepEqual(f.read(p), originals[i]));
  assert.deepEqual(f.read('out/release-installer-notice.rtf'), previous);
});

test('ZIP CRC uses the published standard vector; bytes and attribution survive roundtrip', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const entries = new Map([['licenses/©.txt', Buffer.from('Copyright \r\nTerms.  \n')], ['aidevbridge.exe', Buffer.from([0, 1, 255, 13, 10])]]);
  const bytes = createZip(entries), expected = { files: [...entries].map(([p, b]) => ({ path: p, ...record(b) })).sort((a, b) => a.path.localeCompare(b.path, 'en')) };
  assert.deepEqual(createZip(entries), bytes);
  const checked = verifyZip(bytes, expected); for (const [p, b] of entries) assert.deepEqual(checked.files.get(p), b);
  assert.throws(() => verifyZip(bytes, { files: expected.files.slice(1) }), /payload differs/);
});

for (const name of ['../escape', 'C:/escape', 'dir\\file', 'CON.txt', 'file.', 'a:stream', '/absolute', 'a//b']) {
  test(`unsafe delivery path is rejected: ${name}`, () => assert.throws(() => safeRelative(name), /Unsafe/));
}

test('ZIP rejects case collisions, file-directory collision, changed local names and corrupt CRC', () => {
  assert.throws(() => createZip(new Map([['A', Buffer.from('a')], ['a', Buffer.from('b')]])), /case-colliding/);
  assert.throws(() => createZip(new Map([['a', Buffer.from('a')], ['a/b', Buffer.from('b')]])), /collision/);
  const bytes = createZip(new Map([['a.txt', Buffer.from('payload')]]));
  const nameChanged = Buffer.from(bytes); nameChanged[30] = 98; assert.throws(() => readZip(nameChanged), /name\/bounds mismatch/);
  const crcChanged = Buffer.from(bytes); crcChanged.writeUInt32LE(0, 14); assert.throws(() => readZip(crcChanged), /CRC mismatch/);
  const extra = Buffer.concat([bytes, Buffer.from('trailing')]); assert.throws(() => readZip(extra), /bounds mismatch/);
});

test('ZIP interoperates both directions with Windows .NET ZipArchive', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), entries = new Map([['original.txt', Buffer.from('Copyright ©\r\n')], ['nested/data.bin', Buffer.from([0, 1, 255])]]);
  f.write('out/node.zip', createZip(entries)); f.write('out/input/original.txt', entries.get('original.txt')); f.write('out/input/nested/data.bin', entries.get('nested/data.bin'));
  const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; $taskRoot=$env:AIDEVBRIDGE_ZIP_FIXTURE; [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $taskRoot "out/node.zip"),(Join-Path $taskRoot "out/dotnet-read")); [IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $taskRoot "out/input"),(Join-Path $taskRoot "out/dotnet.zip"))';
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: f.root, env: { ...process.env, AIDEVBRIDGE_ZIP_FIXTURE: f.root }, windowsHide: true, stdio: 'pipe' });
  for (const [p, bytes] of entries) assert.deepEqual(f.read(`out/dotnet-read/${p}`), bytes);
  const zip = readZip(f.read('out/dotnet.zip')); for (const [p, bytes] of entries) assert.deepEqual(zip.files.get(p), bytes);
});

test('fresh run ownership refuses an existing lock and never removes a foreign lock', t => {
  const f = fixture(t), claimed = begin(f);
  assert.throws(() => claimRun(f.root, {}, {}, 'second'), /EEXIST/);
  const foreign = { ...claimed.lock, token: 'changed' }; f.write('out/.aidevbridge-windows-release.lock', encode(foreign));
  assert.throws(() => releaseLock(f.root, claimed.lock), /owner changed/);
  assert.deepEqual(JSON.parse(f.read('out/.aidevbridge-windows-release.lock')), foreign);
});

test('failed frontend hook cannot create a success snapshot or call license preparation', async t => {
  const f = fixture(t), claimed = begin(f); let licenseCalls = 0;
  await assert.rejects(beforeBuild(f.root, claimed.env, { runCommand: async () => { throw new Error('frontend failed'); }, licenses: () => { licenseCalls++; } }), /frontend failed/);
  assert.equal(licenseCalls, 0); assert.equal(fs.existsSync(path.join(f.root, claimed.run.relative, 'before-build.json')), false);
  assert.throws(() => beforeBundle(f.root, claimed.env, { licenses: () => {} }), /ENOENT/);
});

test('log write failure is reported only after the direct child closes, with pipes still drained', async t => {
  const f = fixture(t), claimed = begin(f);
  const proof = path.join(f.root, claimed.run.relative, 'child-ended.txt');
  const script = 'const fs=require("node:fs");process.stdout.write("fixture-start\\n");setTimeout(()=>{fs.writeFileSync(process.argv[1],"finished");process.stderr.write("fixture-end\\n")},60)';
  let writes = 0;
  await assert.rejects(command(f.root, claimed.run, 'failing-log', process.execPath, ['-e', script, proof], process.env, false, { writeLog: () => { writes++; throw new Error('injected disk failure'); } }), /injected disk failure/);
  assert.equal(writes, 1); assert.equal(fs.readFileSync(proof, 'utf8'), 'finished');
  const exit = JSON.parse(f.read(`${claimed.run.relative}/logs/failing-log.exit.json`));
  assert.equal(exit.exit_code, 0); assert.equal(exit.signal, null); assert.equal(exit.log_error, 'injected disk failure');
  assert.deepEqual(JSON.parse(f.read('out/.aidevbridge-windows-release.lock')), claimed.lock);
});

test('hooks require exact owner and prepared state; duplicate successful hooks are rejected', async t => {
  const f = fixture(t), claimed = begin(f);
  await assert.rejects(beforeBuild(f.root, { ...claimed.env, AIDEVBRIDGE_RELEASE_TOKEN: 'foreign' }), /owner mismatch/);
  await prepared(f, claimed); fakeNative(f, claimed);
  const native = beforeBundle(f.root, claimed.env, { licenses: () => {} }); assert.equal(native.exe.bytes, 256);
  assert.throws(() => beforeBundle(f.root, claimed.env, { licenses: () => {} }), /already run/);
  await assert.rejects(beforeBuild(f.root, claimed.env, { runCommand: () => assert.fail('must not rebuild') }), /already run/);
});

test('bundle phase requires generated permission output and freezes it for later artifact verification', async t => {
  const f = fixture(t), selection = JSON.parse(f.read('docs/release/license-selection.windows-x64.json'));
  selection.inputs = { trees: [{ path: 'src-tauri/permissions', availability: 'generated-by-cargo' }] };
  f.write('docs/release/license-selection.windows-x64.json', encode(selection));
  f.write('.gitignore', `${f.read('.gitignore').toString()}src-tauri/permissions/autogenerated/\n`); f.commit();
  const claimed = begin(f); await prepared(f, claimed); fakeNative(f, claimed);
  let required = false;
  const licenses = (mode, options) => { assert.equal(mode, 'check'); required = options.requireGenerated; };
  assert.throws(() => beforeBundle(f.root, claimed.env, { licenses }), /ENOENT/);
  assert.equal(required, true);
  f.write('src-tauri/permissions/autogenerated/example.toml', 'generated fixture');
  const native = beforeBundle(f.root, claimed.env, { licenses });
  assert.deepEqual(native.generated_inputs[0], { path: 'src-tauri/permissions', tree: fileTree(f.root, 'src-tauri/permissions') });
  f.write('src-tauri/permissions/autogenerated/example.toml', 'changed after the native build');
  assert.throws(() => finishArtifacts(f.root, claimed.run, {}, {}), /Changed or additional files in src-tauri\/permissions/);
});

for (const [name, change, expected] of [
  ['changed dist bytes', (f) => f.write('dist/index.html', 'changed'), /Changed or additional/],
  ['extra dist file', (f) => f.write('dist/stale.js', 'stale'), /Changed or additional/],
  ['changed lock', (f) => f.write('package-lock.json', '{}'), /clean committed/],
  ['changed license text', (f) => f.write('out/release-notices/texts/original.txt', 'changed'), /Changed or additional/],
  ['changed prepared RTF', (f) => f.write(path.relative(f.root, installerNoticePath(f)), 'changed'), /Changed file/],
  ['additional copied resource', (f, _c, release) => f.write(`${release}/licenses/extra.txt`, 'stale'), /Changed or additional/],
  ['wrong architecture', (f, _c, release) => { const b = f.read(`${release}/aidevbridge.exe`); b.writeUInt16LE(0x14c, 132); f.write(`${release}/aidevbridge.exe`, b); }, /Windows x64/],
]) {
  test(`bundle hook rejects ${name}`, async t => {
    const f = fixture(t), claimed = begin(f); await prepared(f, claimed); const release = fakeNative(f, claimed); change(f, claimed, release);
    assert.throws(() => beforeBundle(f.root, claimed.env, { licenses: () => {} }), expected);
    assert.equal(fs.existsSync(path.join(f.root, claimed.run.relative, 'before-bundle.json')), false);
  });
}

test('full synthetic packet verifies payload, detects copied EXE swap and extra delivery files', async t => {
  const f = fixture(t), claimed = begin(f); await prepared(f, claimed); const release = fakeNative(f, claimed);
  beforeBundle(f.root, claimed.env, { licenses: () => {} });
  f.write(`${release}/bundle/msi/generated.msi`, 'synthetic MSI output'); f.write(`${release}/bundle/nsis/generated.exe`, 'synthetic NSIS output');
  f.write(`${claimed.run.relative}/cargo/.tauri/fixture.txt`, 'synthetic tools only');
  const tools = { fixture: true, tool_files: fileTree(f.root, `${claimed.run.relative}/cargo/.tauri`) }, versions = { fixture: true };
  f.write(`${claimed.run.relative}/bundler-tools.json`, encode(tools)); f.write(`${claimed.run.relative}/versions.json`, encode(versions));
  // Real bundler archives are deliberately not downloaded in this unit test.
  const verifyBundler = (root, run, data) => verifyTree(root, `${run.relative}/cargo/.tauri`, data.tool_files);
  const manifest = finishArtifacts(f.root, claimed.run, tools, versions, { verifyBundler });
  assert.equal(manifest.status, 'artifacts_built_and_zip_verified'); assert.equal(manifest.acceptance.nsis_msi_payload, 'pending');
  assert.equal(verifyRelease(f.root, claimed.run.relative, { verifyBundler }).status, manifest.status);
  const sourcePath = 'sources/fixture.zip', sourceBytes = f.read(`out/release-notices/${sourcePath}`);
  assert.deepEqual(manifest.notices.files.find(x => x.path === sourcePath), { path: sourcePath, ...record(sourceBytes) });
  const portable = manifest.artifacts.find(x => x.kind === 'zip');
  const portableFiles = readZip(f.read(`${claimed.run.relative}/artifacts/${portable.path}`)).files;
  assert.deepEqual(portableFiles.get(`licenses/${sourcePath}`), sourceBytes);
  assert.deepEqual(readZip(portableFiles.get(`licenses/${sourcePath}`)).files.get('upstream/src/decoder.c'), Buffer.from('Original source\r\n'));
  const installer = manifest.artifacts.find(x => x.kind === 'nsis'), original = f.read(`${claimed.run.relative}/artifacts/${installer.path}`);
  f.write(`${claimed.run.relative}/artifacts/${installer.path}`, 'different installer');
  assert.throws(() => verifyRelease(f.root, claimed.run.relative, { verifyBundler }), /Changed file/);
  f.write(`${claimed.run.relative}/artifacts/${installer.path}`, original); f.write(`${claimed.run.relative}/artifacts/stale.exe`, 'stale');
  assert.throws(() => verifyRelease(f.root, claimed.run.relative, { verifyBundler }), /Additional\/missing/);
});

test('bundler verification rejects altered downloaded bytes against source-pinned hash', t => {
  const f = fixture(t), claimed = begin(f);
  const tools = { tauri_cli: CLI_VERSION, source: DOWNLOAD_SOURCE, downloads: BUNDLER_DOWNLOADS.map(item => { const p = `${claimed.run.relative}/downloads/${item.name}`, bytes = Buffer.from('wrong archive'); f.write(p, bytes); return { ...item, path: p, ...record(bytes) }; }) };
  assert.throws(() => verifyTools(f.root, claimed.run, tools), /Pinned bundler archive/);
});

test('delivery traversal rejects a Windows junction', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); f.write('out/external/data.txt', 'outside selected tree'); f.write('out/tree/regular.txt', 'ordinary');
  fs.symlinkSync(path.join(f.root, 'out/external'), path.join(f.root, 'out/tree/redirect'), 'junction');
  assert.throws(() => fileTree(f.root, 'out/tree'), /Symlink\/junction/);
});

test('the pinned Tauri CLI is the locked one and its bundler source names a commit', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repository, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@tauri-apps/cli'].version, CLI_VERSION);
  assert.match(DOWNLOAD_SOURCE, /^https:\/\/github\.com\/tauri-apps\/tauri\/tree\/[0-9a-f]{40}\/crates\/tauri-bundler\/src\/bundle\/windows$/);
});
