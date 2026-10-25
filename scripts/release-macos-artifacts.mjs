#!/usr/bin/env node
// macOS packaging with explicit inputs: one universal app bundle (Apple silicon
// and Intel) and its DMG. `build` is the release build and needs the bound
// macOS license selection; `build --preview` makes a test build of any clean
// commit, with a placeholder instead of the license texts. Neither is release
// acceptance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORMS, releaseLicenses } from './release-licenses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'universal-apple-darwin';
const TOOLCHAIN = '1.97.1';
const CLI_VERSION = '2.11.4';
const OWNER = 'aidevbridge-macos-release-v1';
const PREVIEW_OWNER = 'aidevbridge-macos-preview-notice';
const PROFILE = PLATFORMS['macos-universal'];
const SELECTION = PROFILE.selection;
const NOTICES = PROFILE.output;
const CONFIG = 'src-tauri/tauri.release.macos.json';
const LOCK = 'out/.aidevbridge-macos-release.lock';
const RUNS = 'out/release-macos';
const IDENTIFIER = 'io.github.itbrain258.aidevbridge';
const MINIMUM_SYSTEM = '11.0';
export const EXPECTED_CONFIG = {
  build: { beforeBuildCommand: 'node scripts/release-macos-artifacts.mjs before-build', beforeBundleCommand: 'node scripts/release-macos-artifacts.mjs before-bundle' },
  bundle: { targets: ['app', 'dmg'], category: 'DeveloperTool', resources: { '../out/release-notices-macos/': 'licenses/' }, macOS: { minimumSystemVersion: MINIMUM_SYSTEM, signingIdentity: '-', hardenedRuntime: true } },
};
// What a build proves. Installation and start on a clean Mac are the CI smoke
// test's job; acceptance on a real Mac stays with the maintainer.
const ACCEPTANCE = { app_bundle_payload: 'checked_by_this_build', dmg_payload: 'checked_by_this_build', install_and_launch: 'ci_smoke_test_only', product_and_macos_acceptance: 'pending', public_release: 'not_authorized_by_this_build' };
const CPU = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' };
// Every file a bundle may contain; anything else stops the build.
const APP_FILES = /^(?:Info\.plist|PkgInfo|MacOS\/aidevbridge|Resources\/icon\.icns|Resources\/licenses\/.+|_CodeSignature\/CodeResources)$/;
// Top level of the image besides the app; metadata macOS itself writes is tolerated and recorded.
const DMG_EXTRA = new Set(['.VolumeIcon.icns', '.DS_Store', '.fseventsd', '.Trashes']);
const SYSTEM_LIBRARY = /^\/(?:System\/Library\/Frameworks|usr\/lib)\//;

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b, message) => ensure(JSON.stringify(a) === JSON.stringify(b), message);

function at(root, rel) {
  ensure(typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && rel.split('/').every(p => p && p !== '.' && p !== '..'), `Unsafe relative path: ${rel}`);
  return path.join(root, ...rel.split('/'));
}
const read = (root, rel) => { const file = at(root, rel); ensure(fs.lstatSync(file).isFile(), `Not a regular file: ${rel}`); return fs.readFileSync(file); };
const readJson = (root, rel) => JSON.parse(read(root, rel));
function write(root, rel, bytes) {
  fs.mkdirSync(path.dirname(at(root, rel)), { recursive: true });
  fs.writeFileSync(at(root, rel), bytes, { flag: 'wx' });
}

// Files and directories below `dir` with hashes; symlinks are refused.
export function fileTree(dir) {
  const files = [], directories = [];
  const visit = (base, prefix, depth) => {
    ensure(depth < 32, `Too deeply nested: ${prefix}`);
    for (const name of fs.readdirSync(base).sort()) {
      const full = path.join(base, name), rel = prefix ? `${prefix}/${name}` : name, stat = fs.lstatSync(full);
      if (stat.isDirectory()) { directories.push(rel); visit(full, rel, depth + 1); }
      else { ensure(stat.isFile(), `Unsupported file: ${rel}`); files.push({ path: rel, ...record(fs.readFileSync(full)) }); }
      ensure(files.length + directories.length < 50000, 'Too many files');
    }
  };
  ensure(fs.lstatSync(dir).isDirectory(), `Not a directory: ${dir}`);
  visit(dir, '', 0);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), directories: directories.sort() };
}

function tool(executable, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  ensure(!result.error, `${executable} failed to start: ${result.error?.message}`);
  ensure(allowFailure || result.status === 0, `${executable} ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const git = (root, args) => tool('git', args, { cwd: root }).stdout.trimEnd();
export function sourceSnapshot(root) {
  ensure(git(root, ['status', '--porcelain=v1', '--untracked-files=all']) === '', 'A clean committed checkout is required; keep changes and commit/review them first');
  const commit = git(root, ['rev-parse', 'HEAD']); ensure(/^[a-f0-9]{40}$/.test(commit), 'Invalid source commit');
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
  return { commit, clean: true, files: paths.map(p => ({ path: p, ...record(read(root, p)) })) };
}

// Architectures of a Mach-O file, fat (universal) or thin.
export function machoArchs(bytes) {
  ensure(bytes.length >= 8, 'Not a Mach-O file');
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4), size = magic === 0xcafebabe ? 20 : 32;
    ensure(count > 0 && count < 16 && 8 + count * size <= bytes.length, 'Invalid universal header');
    return Array.from({ length: count }, (_, i) => CPU[bytes.readUInt32BE(8 + i * size)] ?? `cpu-0x${bytes.readUInt32BE(8 + i * size).toString(16)}`).sort();
  }
  ensure(bytes.readUInt32LE(0) === 0xfeedfacf, 'Not a 64-bit Mach-O file');
  return [CPU[bytes.readUInt32LE(4)] ?? `cpu-0x${bytes.readUInt32LE(4).toString(16)}`];
}

// `otool -L` output -> linked libraries; only macOS system libraries may appear.
export function linkedLibraries(output) {
  const libraries = output.split(/\r?\n/).slice(1).map(line => /^\s+(\S.*?) \(compatibility version/.exec(line)?.[1]).filter(Boolean);
  ensure(libraries.length > 0, 'otool listed no libraries');
  for (const library of libraries) ensure(SYSTEM_LIBRARY.test(library), `Links a library macOS does not provide: ${library}`);
  return libraries;
}

// Developer ID signing and notarization only when the secrets are complete;
// otherwise the configured ad-hoc signature.
export function signingMode(env) {
  const identity = env.APPLE_SIGNING_IDENTITY ?? '';
  const certificate = !!(env.APPLE_CERTIFICATE && env.APPLE_CERTIFICATE_PASSWORD);
  const apiKey = !!(env.APPLE_API_ISSUER && env.APPLE_API_KEY && env.APPLE_API_KEY_PATH), appleId = !!(env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID);
  if (!identity && !certificate && !apiKey && !appleId) return { mode: 'ad-hoc', identity: '-', notarize: false };
  ensure(identity && identity !== '-' && certificate, 'Developer ID signing needs APPLE_SIGNING_IDENTITY, APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD');
  ensure(apiKey || appleId, 'Developer ID builds are notarized: set APPLE_API_ISSUER, APPLE_API_KEY and APPLE_API_KEY_PATH, or APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID');
  return { mode: 'developer-id', identity, notarize: true, notary: apiKey ? 'api-key' : 'apple-id' };
}

export function cleanBuildEnvironment(env) {
  for (const key of Object.keys(env)) {
    if (/^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_TARGET|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.*_(RUSTFLAGS|LINKER|RUNNER)|TAURI_CONFIG|TAURI_SIGNING_.*|TAURI_BUNDLER_.*|MACOSX_DEPLOYMENT_TARGET|SDKROOT)$/i.test(key) && env[key]) throw new Error(`Unsupported inherited build override: ${key}`);
  }
  // CI makes the Tauri DMG script skip its Finder styling (AppleScript), the same on every machine.
  return { ...env, RUSTUP_TOOLCHAIN: TOOLCHAIN, CI: 'true' };
}

export function releaseContract(root, { preview, requireCli = true, env = process.env } = {}) {
  const base = readJson(root, 'src-tauri/tauri.conf.json'), config = readJson(root, CONFIG), pkg = readJson(root, 'package.json'), lock = readJson(root, 'package-lock.json');
  ensure(pkg.name === 'aidevbridge' && /^\d+\.\d+\.\d+$/.test(pkg.version) && base.productName === pkg.name && base.version === pkg.version && lock.version === pkg.version && lock.packages[''].version === pkg.version && base.identifier === IDENTIFIER, 'Product version/name mismatch');
  equal(config, EXPECTED_CONFIG, 'Release configuration changed; review its delivery contract');
  ensure(base.build.frontendDist === '../dist' && !base.build.features && !base.build.runner && !base.bundle.externalBin && !base.bundle.macOS && !base.bundle.createUpdaterArtifacts && !base.bundle.resources, 'Unexpected base build/bundle override');
  ensure(!fs.existsSync(at(root, 'src-tauri/tauri.macos.conf.json')), 'src-tauri/tauri.macos.conf.json would change every macOS build; review it first');
  let licenses = { mode: 'placeholder' };
  if (!preview) {
    const selection = readJson(root, SELECTION);
    ensure(selection.scope.product_version === pkg.version && selection.scope.target === TARGET && selection.scope.rust_toolchain === TOOLCHAIN && selection.scope.minimum_system_version === MINIMUM_SYSTEM, 'License selection does not match this version/target; regenerate or rebind it');
    licenses = { mode: 'selection', path: SELECTION, ...record(read(root, SELECTION)) };
  }
  if (requireCli) ensure(readJson(root, 'node_modules/@tauri-apps/cli/package.json').version === CLI_VERSION, 'Bundler provenance requires the selected Tauri CLI');
  const { mode, identity, notarize, notary } = signingMode(env);
  return { product: pkg.name, version: pkg.version, identifier: IDENTIFIER, target: TARGET, rust_toolchain: TOOLCHAIN, minimum_system_version: MINIMUM_SYSTEM, preview: !!preview, configuration: { path: CONFIG, ...record(read(root, CONFIG)) }, licenses, signing: { mode, identity, notarize, notary: notary ?? null } };
}

export const artifactName = (version, preview, commit) => `aidevbridge-${version}${preview ? `-preview-${commit.slice(0, 10)}` : ''}-macos-universal.dmg`;

export function claimRun(root, source, contract, id = `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')}-${crypto.randomBytes(6).toString('hex')}`) {
  ensure(/^[A-Za-z0-9-]{1,80}$/.test(id), 'Invalid run id');
  const lock = { owner: OWNER, id, pid: process.pid, token: crypto.randomBytes(24).toString('hex') };
  write(root, LOCK, json(lock));
  try {
    const rel = `${RUNS}/${id}`;
    ensure(!fs.existsSync(at(root, rel)), `Output already exists: ${rel}`);
    const run = { schema_version: 1, owner: OWNER, id, root, relative: rel, pid: process.pid, source, contract };
    write(root, `${rel}/run.json`, json(run)); fs.mkdirSync(at(root, `${rel}/cargo`));
    return { run, lock };
  } catch (error) { releaseLock(root, lock); throw error; }
}
export function releaseLock(root, lock) { equal(readJson(root, LOCK), lock, 'Release lock owner changed'); fs.unlinkSync(at(root, LOCK)); }
function hookContext(root, env) {
  const rel = env.AIDEVBRIDGE_RELEASE_RUN;
  ensure(typeof rel === 'string' && new RegExp(`^${RUNS}/[A-Za-z0-9-]+$`).test(rel), 'Release hook requires the owning build entry point');
  const run = readJson(root, `${rel}/run.json`), lock = readJson(root, LOCK);
  ensure(run.owner === OWNER && run.root === root && run.relative === rel && lock.owner === OWNER && lock.id === run.id && lock.pid === run.pid && lock.token === env.AIDEVBRIDGE_RELEASE_TOKEN, 'Release hook owner mismatch');
  ensure(env.CARGO_TARGET_DIR === path.join(root, rel, 'cargo') && env.RUSTUP_TOOLCHAIN === TOOLCHAIN, 'Release hook build environment mismatch');
  process.kill(run.pid, 0); // Liveness check only; never terminate another process.
  return run;
}

async function command(root, run, stage, executable, args, env, capture = false) {
  const logPath = at(root, `${run.relative}/logs/${stage}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'wx');
  process.stdout.write(`[macos-release] ${stage}\n`);
  let stdout = '';
  try {
    const { code, signal, error } = await new Promise(resolve => {
      const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.on('error', e => { spawnError = e; });
      child.stdout.on('data', bytes => { fs.writeSync(fd, bytes); process.stdout.write(bytes); if (capture) stdout += bytes.toString('utf8'); });
      child.stderr.on('data', bytes => { fs.writeSync(fd, bytes); process.stderr.write(bytes); });
      child.on('close', (code, signal) => resolve({ code, signal, error: spawnError }));
    });
    write(root, `${run.relative}/logs/${stage}.exit.json`, json({ stage, executable, args, exit_code: code, signal, spawn_error: error?.message ?? null }));
    if (error || code !== 0 || signal) throw error ?? new Error(`${stage} failed (exit ${code}, signal ${signal})`);
  } finally { fs.closeSync(fd); }
  return stdout.trim();
}
function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidate = [process.env.npm_execpath, path.join(bin, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(bin, 'node_modules/npm/bin/npm-cli.js')]
    .find(p => p && path.isAbsolute(p) && path.basename(p) === 'npm-cli.js' && fs.existsSync(p));
  ensure(candidate, 'npm CLI not found; use npm run build:macos');
  return fs.realpathSync(candidate);
}

// Preview builds carry this note instead of the texts; the owner marker keeps
// `release-licenses.mjs prepare` from adopting the folder.
function previewNotices(root, run) {
  ensure(!fs.existsSync(at(root, NOTICES)), `${NOTICES} already exists; remove it before a preview build`);
  write(root, `${NOTICES}/.aidevbridge-release-notices.json`, json({ schema_version: 1, owner: PREVIEW_OWNER, commit: run.source.commit }));
  write(root, `${NOTICES}/README.txt`, Buffer.from(`aidevbridge ${run.contract.version} preview build of commit ${run.source.commit}.\n\nThis build is for testing and not for distribution. It does not carry the\nthird-party license texts; release builds do, in this folder.\n`));
}

export async function beforeBuild(root, env, { runCommand = command, licenses = releaseLicenses } = {}) {
  const run = hookContext(root, env); equal(sourceSnapshot(root), run.source, 'Source checkout changed during release');
  equal(releaseContract(root, { preview: run.contract.preview, env }), run.contract, 'Release contract changed');
  ensure(!fs.existsSync(at(root, `${run.relative}/before-build.json`)), 'Build hook has already run');
  await runCommand(root, run, 'frontend', process.execPath, [npmCli(), 'run', 'build'], env);
  if (run.contract.preview) previewNotices(root, run); else licenses('prepare', { root, platform: 'macos-universal' });
  equal(sourceSnapshot(root), run.source, 'Source checkout changed during release');
  const snapshot = { contract: run.contract, dist: fileTree(at(root, 'dist')), notices: fileTree(at(root, NOTICES)) };
  ensure(snapshot.dist.files.some(f => f.path === 'index.html'), 'Frontend output missing');
  write(root, `${run.relative}/before-build.json`, json(snapshot));
  return snapshot;
}

function verifyPrepared(root, run, prepared) {
  equal(sourceSnapshot(root), run.source, 'Source checkout changed during release');
  equal(fileTree(at(root, 'dist')), prepared.dist, 'Frontend output changed');
  equal(fileTree(at(root, NOTICES)), prepared.notices, 'License folder changed');
}

function binaryFacts(file) {
  const archs = machoArchs(fs.readFileSync(file));
  equal(archs, ['arm64', 'x86_64'], `Expected a universal arm64/x86_64 binary, found ${archs.join(', ')}`);
  return { archs, libraries: Object.fromEntries(archs.map(arch => [arch, linkedLibraries(tool('otool', ['-arch', arch, '-L', file]).stdout)])) };
}

export function beforeBundle(root, env, { licenses = releaseLicenses } = {}) {
  const run = hookContext(root, env), prepared = readJson(root, `${run.relative}/before-build.json`);
  verifyPrepared(root, run, prepared);
  if (!run.contract.preview) licenses('check', { root, platform: 'macos-universal', requireGenerated: true });
  ensure(!fs.existsSync(at(root, `${run.relative}/before-bundle.json`)), 'Bundle hook has already run');
  const binary = `${run.relative}/cargo/${TARGET}/release/aidevbridge`;
  const native = { binary: { path: binary, ...record(read(root, binary)) }, ...binaryFacts(at(root, binary)) };
  write(root, `${run.relative}/before-bundle.json`, json(native));
  return native;
}

function plist(file) { return JSON.parse(tool('plutil', ['-convert', 'json', '-o', '-', file]).stdout); }

// Signature facts from `codesign -dvv`; the release mode decides what must hold.
function signature(app, contract) {
  tool('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const details = tool('codesign', ['-dvv', app]).stderr;
  const field = name => details.split(/\r?\n/).filter(l => l.startsWith(`${name}=`)).map(l => l.slice(name.length + 1));
  const facts = { identifier: field('Identifier')[0] ?? null, signature: field('Signature')[0] ?? null, authority: field('Authority'), team: field('TeamIdentifier')[0] ?? null, runtime: /flags=.*\bruntime\b/.test(details) };
  ensure(facts.identifier === IDENTIFIER, `Signed identifier is ${facts.identifier}`);
  if (contract.signing.mode === 'ad-hoc') ensure(facts.signature === 'adhoc', 'Expected an ad-hoc signature');
  else {
    ensure(facts.authority[0]?.startsWith('Developer ID Application:') && facts.runtime, 'Expected a Developer ID signature with hardened runtime');
    tool('xcrun', ['stapler', 'validate', app]);
    facts.gatekeeper = tool('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]).stderr.trim();
  }
  return facts;
}

function dmgContents(root, run, dmg, appTree) {
  const mount = at(root, `${run.relative}/dmg-mount`);
  fs.mkdirSync(mount);
  tool('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
  try {
    const entries = fs.readdirSync(mount).sort();
    for (const name of entries) ensure(name === 'aidevbridge.app' || name === 'Applications' || DMG_EXTRA.has(name), `Unexpected entry in the DMG: ${name}`);
    ensure(entries.includes('aidevbridge.app') && entries.includes('Applications'), 'The DMG lacks the app or the Applications link');
    const link = path.join(mount, 'Applications');
    ensure(fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === '/Applications', 'Applications is not a link to /Applications');
    equal(fileTree(path.join(mount, 'aidevbridge.app')), appTree, 'The app in the DMG differs from the built app');
    return { entries };
  } finally {
    if (tool('hdiutil', ['detach', mount], { allowFailure: true }).status !== 0) tool('hdiutil', ['detach', '-force', mount]);
  }
}

export function checkAppTree(tree) {
  for (const file of tree.files) ensure(APP_FILES.test(file.path.replace(/^Contents\//, '')) && file.path.startsWith('Contents/'), `Unexpected file in the app bundle: ${file.path}`);
}

function finishArtifacts(root, run, versions) {
  const prepared = readJson(root, `${run.relative}/before-build.json`), native = readJson(root, `${run.relative}/before-bundle.json`);
  verifyPrepared(root, run, prepared);
  const bundle = `${run.relative}/cargo/${TARGET}/release/bundle`;
  const apps = fs.readdirSync(at(root, `${bundle}/macos`)).filter(n => n.endsWith('.app'));
  const dmgs = fs.readdirSync(at(root, `${bundle}/dmg`)).filter(n => n.endsWith('.dmg'));
  ensure(apps.length === 1 && apps[0] === 'aidevbridge.app' && dmgs.length === 1, 'Expected exactly one fresh app bundle and one DMG');
  const app = at(root, `${bundle}/macos/aidevbridge.app`), dmg = at(root, `${bundle}/dmg/${dmgs[0]}`);
  const appTree = fileTree(app);
  checkAppTree(appTree);
  equal(fileTree(path.join(app, 'Contents/Resources/licenses')), prepared.notices, 'The app bundle carries other license files than prepared');
  const info = plist(path.join(app, 'Contents/Info.plist'));
  const infoFacts = { CFBundleIdentifier: info.CFBundleIdentifier, CFBundleShortVersionString: info.CFBundleShortVersionString, CFBundleExecutable: info.CFBundleExecutable, LSMinimumSystemVersion: info.LSMinimumSystemVersion, NSLocalNetworkUsageDescription: info.NSLocalNetworkUsageDescription };
  ensure(infoFacts.CFBundleIdentifier === IDENTIFIER && infoFacts.CFBundleShortVersionString === run.contract.version && infoFacts.CFBundleExecutable === 'aidevbridge' && infoFacts.LSMinimumSystemVersion === MINIMUM_SYSTEM && typeof infoFacts.NSLocalNetworkUsageDescription === 'string', `Unexpected Info.plist: ${JSON.stringify(infoFacts)}`);
  const binary = path.join(app, 'Contents/MacOS/aidevbridge');
  const facts = binaryFacts(binary);
  equal(facts, { archs: native.archs, libraries: native.libraries }, 'The bundled binary links differently than the built one');
  const signed = signature(app, run.contract);
  const image = dmgContents(root, run, dmg, appTree);
  const name = artifactName(run.contract.version, run.contract.preview, run.source.commit), output = `${run.relative}/artifacts`;
  const bytes = fs.readFileSync(dmg);
  write(root, `${output}/${name}`, bytes);
  const artifacts = [{ kind: 'dmg', path: name, source_path: `${bundle}/dmg/${dmgs[0]}`, ...record(bytes) }];
  const manifest = {
    schema_version: 1, status: run.contract.preview ? 'preview_built_and_verified_not_for_distribution' : 'artifacts_built_and_verified', acceptance: ACCEPTANCE,
    source: { commit: run.source.commit, clean: true, files: run.source.files.length }, contract: run.contract, tools: versions, roles: readJson(root, `${run.relative}/roles.json`),
    frontend: prepared.dist, notices: prepared.notices, native,
    app: { tree: appTree, info_plist: infoFacts, binary: { ...record(fs.readFileSync(binary)), ...facts }, signature: signed },
    dmg: image, artifacts,
  };
  write(root, `${output}/release-manifest.json`, json(manifest));
  return verifyRelease(root, run.relative);
}

export function verifyRelease(root, rel) {
  ensure(new RegExp(`^${RUNS}/[A-Za-z0-9-]+$`).test(rel), `Expected an owned release run under ${RUNS}`);
  const run = readJson(root, `${rel}/run.json`); ensure(run.owner === OWNER && run.root === root && run.relative === rel, 'Release run ownership mismatch');
  const manifest = readJson(root, `${rel}/artifacts/release-manifest.json`), prepared = readJson(root, `${rel}/before-build.json`), native = readJson(root, `${rel}/before-bundle.json`);
  ensure(manifest.schema_version === 1 && manifest.status === (run.contract.preview ? 'preview_built_and_verified_not_for_distribution' : 'artifacts_built_and_verified'), 'Unsupported release manifest');
  equal(manifest.acceptance, ACCEPTANCE, 'This builder does not approve release acceptance');
  equal(manifest.contract, run.contract, 'Manifest contract mismatch'); equal(manifest.native, native, 'Manifest native mismatch');
  equal(manifest.frontend, prepared.dist, 'Manifest frontend mismatch'); equal(manifest.notices, prepared.notices, 'Manifest license tree mismatch');
  ensure(manifest.source.commit === run.source.commit, 'Manifest source mismatch');
  equal(fs.readdirSync(at(root, `${rel}/artifacts`)).sort(), [...manifest.artifacts.map(a => a.path), 'release-manifest.json'].sort(), 'Additional/missing delivery files');
  for (const item of manifest.artifacts) {
    ensure(item.kind === 'dmg' && item.path === artifactName(run.contract.version, run.contract.preview, run.source.commit), 'Artifact name changed');
    equal(record(read(root, `${rel}/artifacts/${item.path}`)), { bytes: item.bytes, sha256: item.sha256 }, `Changed file: ${item.path}`);
  }
  return { status: manifest.status, directory: `${rel}/artifacts`, artifacts: manifest.artifacts.map(a => ({ path: a.path, sha256: a.sha256 })), manifest_sha256: sha(read(root, `${rel}/artifacts/release-manifest.json`)), signing: run.contract.signing.mode, acceptance: manifest.acceptance };
}

// The selection records each package's role; the release runner is the real
// build host, so a difference means the selection needs regenerating.
async function checkRoles(root, run, preview) {
  const { macosMetadata, macosRoles } = await import('./release-license-select-macos.mjs');
  const metadata = macosMetadata(root), roles = macosRoles(root, metadata);
  const mismatches = [];
  if (!preview) {
    for (const component of readJson(root, SELECTION).components.filter(c => c.id.startsWith('cargo:'))) {
      const actual = roles.get(component.id.slice(6));
      if (actual?.role !== component.technical_role) mismatches.push({ id: component.id, selection: component.technical_role, actual: actual?.role ?? null });
    }
  }
  const result = { checked: !preview, packages: roles.size, mismatches };
  write(root, `${run.relative}/roles.json`, json(result));
  ensure(mismatches.length === 0, `Package roles differ on this build host; regenerate the macOS selection: ${mismatches.map(m => m.id).join(', ')}`);
  return result;
}

async function build(root, { preview }) {
  ensure(process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24, 'macOS with Node.js 24+ is required');
  const env = cleanBuildEnvironment(process.env), source = sourceSnapshot(root), initial = releaseContract(root, { preview, requireCli: false, env }), { run, lock } = claimRun(root, source, initial);
  env.CARGO_TARGET_DIR = path.join(root, run.relative, 'cargo'); env.AIDEVBRIDGE_RELEASE_RUN = run.relative; env.AIDEVBRIDGE_RELEASE_TOKEN = lock.token;
  try {
    await command(root, run, 'npm-ci', process.execPath, [npmCli(), 'ci'], env);
    await command(root, run, 'cargo-fetch', 'rustup', ['run', TOOLCHAIN, 'cargo', 'fetch', '--locked'], env);
    equal(releaseContract(root, { preview, env }), run.contract, 'Installed tool/input contract changed'); equal(sourceSnapshot(root), run.source, 'Source checkout changed during release');
    await checkRoles(root, run, preview);
    const versions = {
      node: process.version, npm: await command(root, run, 'npm-version', process.execPath, [npmCli(), '--version'], env, true),
      rustc: await command(root, run, 'rustc-version', 'rustup', ['run', TOOLCHAIN, 'rustc', '-Vv'], env, true), cargo: await command(root, run, 'cargo-version', 'rustup', ['run', TOOLCHAIN, 'cargo', '-Vv'], env, true),
      tauri: await command(root, run, 'tauri-version', process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', '--version'], env, true),
      macos: await command(root, run, 'sw-vers', 'sw_vers', [], env, true), xcode: await command(root, run, 'xcode-version', 'xcodebuild', ['-version'], env, true),
    };
    write(root, `${run.relative}/versions.json`, json(versions));
    const configs = ['--config', CONFIG];
    if (run.contract.signing.mode === 'developer-id') {
      // The CLI merges further --config values in order; this one only swaps the ad-hoc identity.
      write(root, `${run.relative}/signing.json`, json({ bundle: { macOS: { signingIdentity: run.contract.signing.identity } } }));
      configs.push('--config', `${run.relative}/signing.json`);
    }
    await command(root, run, 'tauri-build', process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--ci', '--target', TARGET, ...configs, '--bundles', 'app,dmg', '--', '--locked', '--offline'], env);
    process.stdout.write(`${JSON.stringify(finishArtifacts(root, run, versions))}\n`);
  } catch (error) { write(root, `${run.relative}/failed.json`, json({ status: 'failed', message: error.message })); throw error; }
  finally { releaseLock(root, lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    const usage = 'Usage: node scripts/release-macos-artifacts.mjs build [--preview] | before-build | before-bundle | verify <out/release-macos/run-id>';
    ensure(mode === 'build' ? rest.length === 0 || (rest.length === 1 && rest[0] === '--preview') : mode === 'verify' ? rest.length === 1 : ['before-build', 'before-bundle'].includes(mode) && rest.length === 0, usage);
    const root = fs.realpathSync(ROOT);
    if (mode === 'build') await build(root, { preview: rest[0] === '--preview' });
    else if (mode === 'before-build') await beforeBuild(root, process.env);
    else if (mode === 'before-bundle') beforeBundle(root, process.env);
    else process.stdout.write(`${JSON.stringify(verifyRelease(root, rest[0]))}\n`);
  } catch (error) { process.stderr.write(`macos-release: ${error.message}\n`); process.exitCode = 1; }
}
