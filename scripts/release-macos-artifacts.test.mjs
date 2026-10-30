import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXPECTED_CONFIG, machoArchs, linkedLibraries, signingMode, cleanBuildEnvironment, releaseContract, artifactName, checkAppTree, sourceSnapshot, claimRun, releaseLock, beforeBuild, fileTree, CLI_VERSION } from './release-macos-artifacts.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'aidevbridge-macos-test-'));
  const original = fs.realpathSync(root);
  t.after(() => {
    assert.equal(fs.realpathSync(root), original); assert.equal(path.dirname(original), parent); assert.ok(path.basename(original).startsWith('aidevbridge-macos-test-'));
    fs.rmSync(original, { recursive: true });
  });
  const write = (p, bytes) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), bytes); };
  const read = p => fs.readFileSync(path.join(root, p));
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Delivery fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, '.no-hooks')}`, 'commit', '-m', 'fixture']); };
  write('.gitignore', 'out/\ndist/\nnode_modules/\n');
  write('package.json', encode({ name: 'aidevbridge', version: '0.3.0' }));
  write('package-lock.json', encode({ version: '0.3.0', packages: { '': { version: '0.3.0' } } }));
  write('src-tauri/tauri.conf.json', encode({ productName: 'aidevbridge', version: '0.3.0', identifier: 'io.github.itbrain258.aidevbridge', build: { frontendDist: '../dist' }, bundle: {} }));
  write('src-tauri/tauri.release.macos.json', fs.readFileSync(path.join(repository, 'src-tauri/tauri.release.macos.json')));
  write('node_modules/@tauri-apps/cli/package.json', encode({ version: CLI_VERSION }));
  write('docs/release/license-selection.macos-universal.json', encode({ scope: { product_version: '0.3.0', target: 'universal-apple-darwin', rust_toolchain: '1.97.1', minimum_system_version: '11.0' } }));
  git(['init', '--quiet']); commit();
  return { root, write, read, git, commit };
}

function fat(cpus, magic = 0xcafebabe) {
  const size = magic === 0xcafebabe ? 20 : 32, bytes = Buffer.alloc(8 + cpus.length * size);
  bytes.writeUInt32BE(magic, 0); bytes.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, i) => bytes.writeUInt32BE(cpu, 8 + i * size));
  return bytes;
}

test('the checked-in release configuration is the reviewed delivery contract', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repository, 'src-tauri/tauri.release.macos.json'))), EXPECTED_CONFIG);
});

test('Mach-O headers name both architectures of a universal binary', () => {
  assert.deepEqual(machoArchs(fat([0x01000007, 0x0100000c])), ['arm64', 'x86_64']);
  assert.deepEqual(machoArchs(fat([0x0100000c], 0xcafebabf)), ['arm64']);
  const thin = Buffer.alloc(32); thin.writeUInt32LE(0xfeedfacf, 0); thin.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(machoArchs(thin), ['arm64']);
  assert.deepEqual(machoArchs(fat([0x0000000c])), ['cpu-0xc']);
  assert.throws(() => machoArchs(Buffer.from('MZ\x90\x00\x03\x00\x00\x00')), /Not a 64-bit Mach-O/);
  assert.throws(() => machoArchs(fat([]).subarray(0, 8)), /Invalid universal header/);
});

test('only libraries macOS provides may be linked', () => {
  const output = (...libraries) => `/tmp/aidevbridge (architecture arm64):\n${libraries.map(l => `\t${l} (compatibility version 1.0.0, current version 1.0.0)`).join('\n')}\n`;
  assert.deepEqual(linkedLibraries(output('/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit', '/usr/lib/libSystem.B.dylib')), ['/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit', '/usr/lib/libSystem.B.dylib']);
  assert.throws(() => linkedLibraries(output('/usr/lib/libSystem.B.dylib', '@rpath/libssl.dylib')), /does not provide: @rpath\/libssl\.dylib/);
  assert.throws(() => linkedLibraries(output('/opt/homebrew/lib/libssh2.dylib')), /does not provide/);
  assert.throws(() => linkedLibraries(output('/System/Library/PrivateFrameworks/Foo.framework/Foo')), /does not provide/);
  assert.throws(() => linkedLibraries('/tmp/aidevbridge:\n'), /no libraries/);
});

test('Developer ID signing needs the certificate and notarization secrets, otherwise ad-hoc', () => {
  assert.deepEqual(signingMode({}), { mode: 'ad-hoc', identity: '-', notarize: false });
  const certificate = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAM123456)', APPLE_CERTIFICATE: 'base64', APPLE_CERTIFICATE_PASSWORD: 'secret' };
  assert.deepEqual(signingMode({ ...certificate, APPLE_API_ISSUER: 'issuer', APPLE_API_KEY: 'key', APPLE_API_KEY_PATH: '/tmp/key.p8' }), { mode: 'developer-id', identity: certificate.APPLE_SIGNING_IDENTITY, notarize: true, notary: 'api-key' });
  assert.equal(signingMode({ ...certificate, APPLE_ID: 'a@example.invalid', APPLE_PASSWORD: 'app-password', APPLE_TEAM_ID: 'TEAM123456' }).notary, 'apple-id');
  assert.throws(() => signingMode(certificate), /are notarized/);
  assert.throws(() => signingMode({ APPLE_SIGNING_IDENTITY: certificate.APPLE_SIGNING_IDENTITY }), /APPLE_CERTIFICATE/);
  assert.throws(() => signingMode({ APPLE_API_ISSUER: 'issuer', APPLE_API_KEY: 'key', APPLE_API_KEY_PATH: '/tmp/key.p8' }), /APPLE_SIGNING_IDENTITY/);
});

test('inherited build overrides are refused; the build runs as CI on the pinned toolchain', () => {
  assert.deepEqual(cleanBuildEnvironment({ PATH: '/usr/bin', RUSTFLAGS: '' }), { PATH: '/usr/bin', RUSTFLAGS: '', RUSTUP_TOOLCHAIN: '1.97.1', CI: 'true' });
  for (const key of ['RUSTFLAGS', 'CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER', 'TAURI_CONFIG', 'MACOSX_DEPLOYMENT_TARGET', 'SDKROOT']) assert.throws(() => cleanBuildEnvironment({ [key]: 'x' }), new RegExp(key));
});

test('the contract binds versions and configuration; only release builds need the bound selection', t => {
  const f = fixture(t);
  const preview = releaseContract(f.root, { preview: true, env: {} });
  assert.deepEqual(preview.licenses, { mode: 'placeholder' });
  assert.deepEqual(preview.signing, { mode: 'ad-hoc', identity: '-', notarize: false, notary: null });
  const release = releaseContract(f.root, { preview: false, env: {} });
  assert.equal(release.licenses.sha256, sha(f.read('docs/release/license-selection.macos-universal.json')));
  f.write('docs/release/license-selection.macos-universal.json', encode({ scope: { product_version: '0.2.9', target: 'universal-apple-darwin', rust_toolchain: '1.97.1', minimum_system_version: '11.0' } }));
  assert.throws(() => releaseContract(f.root, { preview: false, env: {} }), /regenerate or rebind/);
  assert.equal(releaseContract(f.root, { preview: true, env: {} }).version, '0.3.0');
  f.write('src-tauri/tauri.macos.conf.json', '{}');
  assert.throws(() => releaseContract(f.root, { preview: true, env: {} }), /tauri\.macos\.conf\.json/);
  fs.unlinkSync(path.join(f.root, 'src-tauri/tauri.macos.conf.json'));
  f.write('src-tauri/tauri.release.macos.json', encode({ ...EXPECTED_CONFIG, bundle: { ...EXPECTED_CONFIG.bundle, targets: ['app'] } }));
  assert.throws(() => releaseContract(f.root, { preview: true, env: {} }), /Release configuration changed/);
});

test('artifact names carry the version, and preview builds the commit', () => {
  assert.equal(artifactName('0.3.0', false, 'a'.repeat(40)), 'aidevbridge-0.3.0-macos-universal.dmg');
  assert.equal(artifactName('0.3.0', true, '0123456789abcdef0123456789abcdef01234567'), 'aidevbridge-0.3.0-preview-0123456789-macos-universal.dmg');
});

test('the app bundle may hold only the binary, its plist, icon, licenses and signature', () => {
  const file = p => ({ path: p, bytes: 1, sha256: '0'.repeat(64) });
  const allowed = ['Contents/Info.plist', 'Contents/MacOS/aidevbridge', 'Contents/Resources/icon.icns', 'Contents/Resources/licenses/index.html', 'Contents/Resources/licenses/texts/MIT.txt', 'Contents/_CodeSignature/CodeResources'];
  checkAppTree({ files: allowed.map(file), directories: [] });
  for (const extra of ['Contents/Frameworks/libssl.dylib', 'Contents/MacOS/helper', 'Contents/Resources/other.txt', 'Info.plist']) {
    assert.throws(() => checkAppTree({ files: [...allowed, extra].map(file), directories: [] }), /Unexpected file in the app bundle/);
  }
});

test('a preview build hook writes the placeholder notice and binds the frontend and notice trees', async t => {
  const f = fixture(t);
  const contract = releaseContract(f.root, { preview: true, env: {} });
  const claimed = claimRun(f.root, sourceSnapshot(f.root), contract, 'fixture');
  const env = { ...process.env, AIDEVBRIDGE_RELEASE_RUN: claimed.run.relative, AIDEVBRIDGE_RELEASE_TOKEN: claimed.lock.token, CARGO_TARGET_DIR: path.join(f.root, claimed.run.relative, 'cargo'), RUSTUP_TOOLCHAIN: '1.97.1' };
  for (const key of ['APPLE_SIGNING_IDENTITY', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) delete env[key];
  const calls = [];
  const licenses = () => assert.fail('a preview build must not prepare the license selection');
  const snapshot = await beforeBuild(f.root, env, { runCommand: async (_root, _run, stage) => { calls.push(stage); f.write('dist/index.html', '<html>fresh frontend</html>'); }, licenses });
  assert.deepEqual(calls, ['frontend']);
  assert.deepEqual(snapshot.notices.files.map(x => x.path), ['.aidevbridge-release-notices.json', 'README.txt']);
  assert.match(f.read('out/release-notices-macos/README.txt').toString(), /not for distribution/);
  assert.deepEqual(fileTree(path.join(f.root, 'dist')), snapshot.dist);
  await assert.rejects(beforeBuild(f.root, env, { runCommand: async () => {}, licenses }), /already run/);
  await assert.rejects(beforeBuild(f.root, { ...env, AIDEVBRIDGE_RELEASE_TOKEN: 'other' }, { runCommand: async () => {}, licenses }), /owner mismatch/);
  releaseLock(f.root, claimed.lock);
  assert.equal(fs.existsSync(path.join(f.root, 'out/.aidevbridge-macos-release.lock')), false);
});

test('the pinned Tauri CLI is the locked one', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repository, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@tauri-apps/cli'].version, CLI_VERSION);
});
