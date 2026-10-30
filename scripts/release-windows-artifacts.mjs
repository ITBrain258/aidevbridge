#!/usr/bin/env node
// Local Windows packaging with explicit inputs. This is not release acceptance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseLicenses } from './release-licenses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'x86_64-pc-windows-msvc';
const TOOLCHAIN = '1.97.1';
export const CLI_VERSION = '2.12.4';
const OWNER = 'aidevbridge-windows-release-v1';
const SELECTION = 'docs/release/license-selection.windows-x64.json';
const CONFIG = 'src-tauri/tauri.release.windows.json';
const NOTICES = 'out/release-notices';
// Tauri CLI 2.12.4 (as 2.11.4) uses PathBuf::ends_with(".rtf"), a whole-component check.
// Keep this basename until the pinned MSI converter is reviewed on CLI upgrades.
const RTF = 'out/release-installer-notice/.rtf';
const LOCK = 'out/.aidevbridge-windows-release.lock';
const ACCEPTANCE = { nsis_msi_payload: 'pending', installer_terms_ui: 'pending', installer_stub_notices: 'pending', native_import_family_review: 'pending', product_and_windows_acceptance: 'pending', public_release: 'not_authorized_by_this_build' };
const LIMIT = 512 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sorted = values => [...values].sort();
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b, message) => ensure(JSON.stringify(a) === JSON.stringify(b), message);

// Pinned to the installed CLI source commit. Archives are retained before extraction.
export const BUNDLER_DOWNLOADS = [
  { name: 'wix314-binaries.zip', version: '3.14.1', url: 'https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip', algorithm: 'sha256', hash: '6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31', destination: 'WixTools314' },
  { name: 'nsis-3.13.zip', version: '3.13', url: 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip', algorithm: 'sha1', hash: 'db14f8af2ea346b786c6ae19343f61aaf5e09b8e', destination: 'NSIS', strip: 'nsis-3.13/' },
  { name: 'nsis_tauri_utils.dll', version: '0.5.3', url: 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll', algorithm: 'sha1', hash: '75197fee3c6a814fe035788d1c34ead39349b860', destination: 'NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll' },
];
export const DOWNLOAD_SOURCE = 'https://github.com/tauri-apps/tauri/tree/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-bundler/src/bundle/windows';

export function safeRelative(value) {
  ensure(typeof value === 'string' && value.length && !/[\\:\x00-\x1f<>"|?*]/.test(value), `Unsafe relative path: ${value}`);
  const parts = value.split('/');
  ensure(parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), `Unsafe relative path: ${value}`);
  return parts;
}
function at(root, rel, missing = false) {
  let current = root;
  const parts = safeRelative(rel);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (missing && error.code === 'ENOENT') return path.join(root, ...parts);
      throw error;
    }
    ensure(!stat.isSymbolicLink(), `Symlink/junction is not allowed: ${rel}`);
    if (i < parts.length - 1) ensure(stat.isDirectory(), `Non-directory parent: ${rel}`);
  }
  return current;
}
function read(root, rel) {
  const file = at(root, rel);
  ensure(fs.lstatSync(file).isFile(), `Not a regular file: ${rel}`);
  return fs.readFileSync(file);
}
function readJson(root, rel) { return JSON.parse(read(root, rel)); }
function mkdir(root, rel, exclusive = false) {
  const parts = safeRelative(rel);
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const dir = at(root, prefix, true);
    if (fs.existsSync(dir)) {
      ensure(!(exclusive && i === parts.length), `Output already exists: ${rel}`);
      ensure(fs.lstatSync(dir).isDirectory(), `Not a directory: ${prefix}`);
    } else fs.mkdirSync(dir);
  }
}
function write(root, rel, bytes) {
  const parent = rel.split('/').slice(0, -1).join('/');
  if (parent) mkdir(root, parent);
  fs.writeFileSync(at(root, rel, true), bytes, { flag: 'wx' });
}
export function fileTree(root, rel) {
  const files = [], directories = [];
  const visit = (prefix, depth) => {
    ensure(depth < 32, `Too deeply nested: ${prefix}`);
    for (const name of fs.readdirSync(at(root, prefix)).sort()) {
      const child = `${prefix}/${name}`;
      const stat = fs.lstatSync(at(root, child));
      if (stat.isDirectory()) { directories.push(child.slice(rel.length + 1)); visit(child, depth + 1); }
      else { ensure(stat.isFile(), `Unsupported file: ${child}`); files.push({ path: child.slice(rel.length + 1), ...record(read(root, child)) }); }
      ensure(files.length + directories.length < 50000, 'Too many files');
    }
  };
  ensure(fs.lstatSync(at(root, rel)).isDirectory(), `Not a directory: ${rel}`);
  visit(rel, 0);
  const all = [...files.map(x => x.path), ...directories];
  ensure(new Set(all.map(x => x.toLowerCase())).size === all.length, 'Case-colliding paths');
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), directories: sorted(directories) };
}
export function verifyTree(root, rel, expected) { equal(fileTree(root, rel), expected, `Changed or additional files in ${rel}`); }
function verifyRecord(root, rel, expected) { equal(record(read(root, rel)), { bytes: expected.bytes, sha256: expected.sha256 }, `Changed file: ${rel}`); }

export function toRtf(text) {
  ensure(typeof text === 'string' && !text.includes('\0'), 'Invalid notice text');
  let body = '';
  // RTF \u takes signed UTF-16 code units; supplementary characters use two.
  for (const c of text.replace(/\r\n?/g, '\n').split('')) {
    const n = c.charCodeAt(0);
    if (c === '\n') body += '\\par\n';
    else if (c === '\t') body += '\\tab ';
    else if ('\\{}'.includes(c)) body += `\\${c}`;
    else if (n >= 32 && n <= 126) body += c;
    else { ensure(n >= 32, 'Unsupported notice control character'); body += `\\u${n > 32767 ? n - 65536 : n}?`; }
  }
  return Buffer.from(`{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fnil Segoe UI;}}\n\\f0\\fs20 ${body}}\n`, 'ascii');
}
function prepareRtf(root) {
  const sources = ['docs/release/windows-installation-notice.txt', 'docs/release/licenses/microsoft-webview2-evergreen-2026-09-12-LICENSE.txt'];
  const bytes = toRtf(sources.map(p => read(root, p).toString('utf8')).join('\n'));
  const marker = `${RTF}.owner.json`;
  const owner = { owner: OWNER, sources: sources.map(p => ({ path: p, ...record(read(root, p)) })), ...record(bytes) };
  if (fs.existsSync(at(root, RTF, true)) || fs.existsSync(at(root, marker, true))) {
    equal(readJson(root, marker), owner, 'RTF output is unowned or stale; retained');
    ensure(read(root, RTF).equals(bytes), 'RTF output changed; retained');
  } else { write(root, marker, json(owner)); write(root, RTF, bytes); }
  return record(bytes);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function checkZipNames(names) {
  const seen = new Map();
  for (const original of names) {
    const directory = original.endsWith('/');
    const name = directory ? original.slice(0, -1) : original;
    safeRelative(name);
    const key = name.toLowerCase();
    ensure(!seen.has(key), `Duplicate/case-colliding ZIP entry: ${name}`);
    seen.set(key, directory);
  }
  for (const key of seen.keys()) {
    const parts = key.split('/');
    while (parts.length > 1) { parts.pop(); ensure(seen.get(parts.join('/')) !== false, 'ZIP file/directory collision'); }
  }
}
export function createZip(entries) {
  const pairs = [...entries.entries()].sort(([a], [b]) => a < b ? -1 : 1);
  ensure(pairs.length > 0 && pairs.length < 65535, 'Invalid ZIP entry count');
  checkZipNames(pairs.map(([name]) => name));
  const locals = [], central = []; let offset = 0;
  for (const [name, bytes] of pairs) {
    ensure(!name.endsWith('/') && Buffer.isBuffer(bytes), 'ZIP requires file bytes');
    const filename = Buffer.from(name, 'utf8'), compressed = deflateRawSync(bytes), checksum = crc32(bytes);
    ensure(bytes.length <= LIMIT && offset + compressed.length < LIMIT && filename.length < 65536, 'ZIP size limit');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(33, 14);
    header.writeUInt32LE(checksum, 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed); central.push(header, filename); offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(pairs.length, 8); end.writeUInt16LE(pairs.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
// Bounded ZIP reader for own ZIPs and pinned bundler archives. No ZIP64/encryption.
export function readZip(bytes) {
  ensure(bytes.length >= 22 && bytes.length <= LIMIT, 'Invalid ZIP size');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  ensure(end >= 0 && bytes.readUInt32LE(end) === 0x06054b50, 'ZIP end missing');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  ensure(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count && count > 0 && count < 65535, 'Unsupported ZIP disks/count');
  ensure(start + size === end && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length, 'ZIP directory bounds mismatch');
  const files = new Map(), directories = [], names = [], ranges = []; let pos = start, total = 0;
  for (let i = 0; i < count; i++) {
    ensure(pos + 46 <= end && bytes.readUInt32LE(pos) === 0x02014b50, 'Invalid ZIP central header');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10), crc = bytes.readUInt32LE(pos + 16), packed = bytes.readUInt32LE(pos + 20), length = bytes.readUInt32LE(pos + 24), n = bytes.readUInt16LE(pos + 28), x = bytes.readUInt16LE(pos + 30), c = bytes.readUInt16LE(pos + 32), off = bytes.readUInt32LE(pos + 42);
    ensure((flags & ~0x80e) === 0 && !(flags & 1) && [0, 8].includes(method) && length <= LIMIT && bytes.readUInt16LE(pos + 34) === 0, 'Unsupported ZIP format');
    ensure(pos + 46 + n + x + c <= end && off + 30 <= start, 'ZIP entry bounds');
    const rawName = bytes.subarray(pos + 46, pos + 46 + n);
    ensure((flags & 0x800) || rawName.every(b => b < 128), 'Non-UTF8 ZIP names are unsupported');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    const unixMode = bytes.readUInt32LE(pos + 38) >>> 16;
    ensure((unixMode & 0xf000) !== 0xa000, 'ZIP symlink is forbidden');
    ensure(bytes.readUInt32LE(off) === 0x04034b50 && bytes.readUInt16LE(off + 6) === flags && bytes.readUInt16LE(off + 8) === method, 'ZIP local header mismatch');
    const ln = bytes.readUInt16LE(off + 26), lx = bytes.readUInt16LE(off + 28), data = off + 30 + ln + lx;
    ensure(data + packed <= start && ln === n && bytes.subarray(off + 30, off + 30 + ln).equals(rawName), 'ZIP local name/bounds mismatch');
    if (!(flags & 8)) ensure(bytes.readUInt32LE(off + 14) === crc && bytes.readUInt32LE(off + 18) === packed && bytes.readUInt32LE(off + 22) === length, 'ZIP local size/CRC mismatch');
    const content = method === 0 ? Buffer.from(bytes.subarray(data, data + packed)) : inflateRawSync(bytes.subarray(data, data + packed), { maxOutputLength: Math.max(1, length) });
    total += content.length;
    ensure(content.length === length && total <= LIMIT && crc32(content) === crc, 'ZIP content size/CRC mismatch');
    names.push(name); ranges.push([off, data + packed]);
    if (name.endsWith('/')) { ensure(length === 0, 'ZIP directory contains data'); directories.push(name.slice(0, -1)); }
    else files.set(name, content);
    pos += 46 + n + x + c;
  }
  ensure(pos === end, 'Extra ZIP directory bytes'); checkZipNames(names);
  ranges.sort((a, b) => a[0] - b[0]); for (let i = 1; i < ranges.length; i++) ensure(ranges[i][0] >= ranges[i - 1][1], 'Overlapping ZIP entries');
  return { files, directories };
}
export function verifyZip(bytes, expected) {
  const zip = readZip(bytes);
  const actual = [...zip.files].map(([name, content]) => ({ path: name, ...record(content) })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  equal(actual, expected.files, 'ZIP payload differs from expected files');
  ensure(zip.directories.every(dir => expected.files.some(file => file.path.startsWith(`${dir}/`))), 'Unexpected empty ZIP directory');
  return zip;
}
function extractZip(root, rel, zip, strip = '') {
  mkdir(root, rel, true);
  for (const [name, bytes] of zip.files) { ensure(name.startsWith(strip), 'Unexpected archive root'); write(root, `${rel}/${name.slice(strip.length)}`, bytes); }
  for (const dir of zip.directories) { if (`${dir}/` === strip) continue; ensure(`${dir}/`.startsWith(strip), 'Unexpected archive directory'); mkdir(root, `${rel}/${dir.slice(strip.length)}`); }
}

function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trimEnd(); }
export function sourceSnapshot(root) {
  ensure(git(root, ['status', '--porcelain=v1', '--untracked-files=all']) === '', 'A clean committed checkout is required; keep changes and commit/review them first');
  const commit = git(root, ['rev-parse', 'HEAD']); ensure(/^[a-f0-9]{40}$/.test(commit), 'Invalid source commit');
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
  return { commit, clean: true, files: paths.map(p => ({ path: p, ...record(read(root, p)) })) };
}
function verifySource(root, expected) { equal(sourceSnapshot(root), expected, 'Source checkout changed during release'); }
export function releaseContract(root, requireCli = true) {
  const selection = readJson(root, SELECTION), base = readJson(root, 'src-tauri/tauri.conf.json'), config = readJson(root, CONFIG), pkg = readJson(root, 'package.json'), lock = readJson(root, 'package-lock.json');
  ensure(pkg.name === 'aidevbridge' && /^\d+\.\d+\.\d+$/.test(pkg.version) && base.productName === pkg.name && base.version === pkg.version && lock.version === pkg.version && lock.packages[''].version === pkg.version && selection.scope.product_version === pkg.version, 'Product version/name mismatch');
  ensure(selection.scope.target === TARGET && selection.scope.rust_toolchain === TOOLCHAIN && selection.scope.default_features === true, 'License target/toolchain mismatch');
  equal(selection.scope.cargo_features, ['tauri/custom-protocol'], 'Unexpected Cargo features');
  ensure(selection.scope.installer_webview2_mode === 'downloadBootstrapper' && selection.scope.installer_webview2_silent === true, 'Runtime selection mismatch');
  equal(config, { build: { beforeBuildCommand: 'node scripts/release-windows-artifacts.mjs before-build', beforeBundleCommand: 'node scripts/release-windows-artifacts.mjs before-bundle' }, bundle: { targets: ['msi', 'nsis'], useLocalToolsDir: true, resources: { '../out/release-notices/': 'licenses/' }, licenseFile: '../out/release-installer-notice/.rtf', windows: { webviewInstallMode: { type: 'downloadBootstrapper', silent: true } } } }, 'Release configuration changed; review its delivery contract');
  ensure(base.build.frontendDist === '../dist' && !base.build.features && !base.build.runner && !base.bundle.externalBin && !base.bundle.windows && !base.bundle.createUpdaterArtifacts, 'Unexpected base build/bundle override');
  if (requireCli) ensure(readJson(root, 'node_modules/@tauri-apps/cli/package.json').version === CLI_VERSION, 'Bundler provenance requires the selected Tauri CLI');
  return { product: pkg.name, version: pkg.version, identifier: base.identifier, target: TARGET, rust_toolchain: TOOLCHAIN, default_features: true, cargo_features: ['tauri/custom-protocol'], configuration: { path: CONFIG, ...record(read(root, CONFIG)) }, license_selection: { path: SELECTION, ...record(read(root, SELECTION)) }, webview2: { type: 'downloadBootstrapper', silent: true }, signed: false };
}
function cleanBuildEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (/^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_TARGET|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.*_(RUSTFLAGS|LINKER|RUNNER)|TAURI_CONFIG|TAURI_SIGNING_.*|TAURI_BUNDLER_.*|STATIC_VCRUNTIME)$/i.test(key) && process.env[key]) throw new Error(`Unsupported inherited build override: ${key}`);
  }
  return { ...process.env, RUSTUP_TOOLCHAIN: TOOLCHAIN, STATIC_VCRUNTIME: 'true' };
}
export function claimRun(root, source, contract, id = `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')}-${crypto.randomBytes(6).toString('hex')}`) {
  ensure(/^[A-Za-z0-9-]{1,80}$/.test(id), 'Invalid run id'); mkdir(root, 'out');
  const lock = { owner: OWNER, id, pid: process.pid, token: crypto.randomBytes(24).toString('hex') };
  write(root, LOCK, json(lock));
  try {
    const rel = `out/release-windows/${id}`; mkdir(root, rel, true);
    const run = { schema_version: 1, owner: OWNER, id, root, relative: rel, pid: process.pid, source, contract };
    write(root, `${rel}/run.json`, json(run)); mkdir(root, `${rel}/cargo`, true);
    return { run, lock };
  } catch (error) { releaseLock(root, lock); throw error; }
}
export function releaseLock(root, lock) { equal(readJson(root, LOCK), lock, 'Release lock owner changed'); fs.unlinkSync(at(root, LOCK)); }
function hookContext(root, env) {
  const rel = env.AIDEVBRIDGE_RELEASE_RUN;
  ensure(typeof rel === 'string' && /^out\/release-windows\/[A-Za-z0-9-]+$/.test(rel), 'Release hook requires the owning build entry point');
  const run = readJson(root, `${rel}/run.json`), lock = readJson(root, LOCK);
  ensure(run.owner === OWNER && run.root === root && run.relative === rel && lock.owner === OWNER && lock.id === run.id && lock.pid === run.pid && lock.token === env.AIDEVBRIDGE_RELEASE_TOKEN, 'Release hook owner mismatch');
  ensure(env.CARGO_TARGET_DIR === path.join(root, rel, 'cargo') && env.RUSTUP_TOOLCHAIN === TOOLCHAIN && env.STATIC_VCRUNTIME === 'true', 'Release hook build environment mismatch');
  process.kill(run.pid, 0); // Liveness check only; never terminate another process.
  return run;
}
export async function command(root, run, stage, executable, args, env, capture = false, { writeLog = fs.writeSync } = {}) {
  const logPath = `${run.relative}/logs/${stage}.log`, exitPath = `${run.relative}/logs/${stage}.exit.json`;
  mkdir(root, `${run.relative}/logs`); const fd = fs.openSync(at(root, logPath, true), 'wx');
  process.stdout.write(`[windows-release] ${stage}\n`);
  let stdout = '', closed = false, ioError;
  const retainError = error => { ioError ??= error; };
  try {
    const outcome = await new Promise(resolve => {
      const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.on('error', error => { spawnError = error; });
      const drain = (bytes, output, save) => {
        // A failed log write must not throw out of an event callback or abandon
        // the still-running child. Continue consuming both pipes until close.
        if (!ioError) { try { writeLog(fd, bytes); } catch (error) { retainError(error); } }
        try { output.write(bytes); } catch (error) { retainError(error); }
        if (capture && save && !ioError) {
          if (stdout.length + bytes.length > 1024 * 1024) retainError(new Error(`${stage} captured output exceeded 1 MiB`));
          else stdout += bytes.toString('utf8');
        }
      };
      child.stdout.on('data', bytes => drain(bytes, process.stdout, true));
      child.stderr.on('data', bytes => drain(bytes, process.stderr, false));
      child.stdout.on('error', retainError); child.stderr.on('error', retainError);
      child.on('close', (code, signal) => resolve({ code, signal, spawnError }));
    });
    // All final filesystem work happens after the direct child's close event.
    // Even a full disk here cannot release ownership while that child is live.
    try { fs.closeSync(fd); } catch (error) { retainError(error); } finally { closed = true; }
    const { code, signal, spawnError } = outcome;
    write(root, exitPath, json({ stage, executable, args, exit_code: code, signal, spawn_error: spawnError?.message ?? null, log_error: ioError?.message ?? null }));
    if (spawnError || ioError || code !== 0 || signal) throw spawnError ?? ioError ?? new Error(`${stage} failed (exit ${code}, signal ${signal})`);
  } finally { if (!closed) fs.closeSync(fd); }
  return stdout.trim();
}
function npmCli() {
  const candidate = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  ensure(path.isAbsolute(candidate) && path.basename(candidate) === 'npm-cli.js' && fs.lstatSync(candidate).isFile(), 'npm CLI not found; use npm run build:windows');
  return fs.realpathSync(candidate);
}
export async function beforeBuild(root, env, { runCommand = command, licenses = releaseLicenses } = {}) {
  const run = hookContext(root, env); verifySource(root, run.source); equal(releaseContract(root), run.contract, 'Release contract changed');
  ensure(!fs.existsSync(at(root, `${run.relative}/before-build.json`, true)), 'Build hook has already run');
  await runCommand(root, run, 'frontend', process.execPath, [npmCli(), 'run', 'build'], env);
  licenses('prepare', { root }); prepareRtf(root); verifySource(root, run.source);
  const snapshot = { contract: releaseContract(root), dist: fileTree(root, 'dist'), notices: fileTree(root, NOTICES), rtf: record(read(root, RTF)), selection: record(read(root, SELECTION)) };
  ensure(snapshot.dist.files.length > 0 && snapshot.dist.files.some(f => f.path === 'index.html'), 'Frontend output missing');
  write(root, `${run.relative}/before-build.json`, json(snapshot));
  return snapshot;
}
function verifyPrepared(root, run, prepared) {
  verifySource(root, run.source); equal(releaseContract(root), prepared.contract, 'Release contract changed'); verifyTree(root, 'dist', prepared.dist); verifyTree(root, NOTICES, prepared.notices); verifyRecord(root, RTF, prepared.rtf); verifyRecord(root, SELECTION, prepared.selection);
}
export function peMachine(bytes) {
  ensure(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Invalid PE image'); const off = bytes.readUInt32LE(60);
  ensure(off + 26 <= bytes.length && bytes.readUInt32LE(off) === 0x4550, 'Invalid PE signature');
  return { machine: bytes.readUInt16LE(off + 4), optional_magic: bytes.readUInt16LE(off + 24) };
}
function generatedInputTrees(root) {
  return (readJson(root, SELECTION).inputs?.trees ?? []).filter(tree => tree.availability === 'generated-by-cargo');
}
function verifyNativeGeneratedInputs(root, native) {
  equal(native.generated_inputs?.map(item => item.path), generatedInputTrees(root).map(tree => tree.path), 'Native generated-input proof missing or changed');
  for (const item of native.generated_inputs) verifyTree(root, item.path, item.tree);
}
export function beforeBundle(root, env, { licenses = releaseLicenses } = {}) {
  const run = hookContext(root, env), prepared = readJson(root, `${run.relative}/before-build.json`); verifyPrepared(root, run, prepared); licenses('check', { root, requireGenerated: true });
  ensure(!fs.existsSync(at(root, `${run.relative}/before-bundle.json`, true)), 'Bundle hook has already run');
  const release = `${run.relative}/cargo/${TARGET}/release`, exe = `${release}/aidevbridge.exe`, pdb = `${release}/aidevbridge.pdb`;
  equal(peMachine(read(root, exe)), { machine: 0x8664, optional_magic: 0x20b }, 'Expected Windows x64 PE32+ application');
  verifyTree(root, `${release}/licenses`, prepared.notices);
  const native = { exe: { path: exe, ...record(read(root, exe)) }, pdb: { path: pdb, ...record(read(root, pdb)) }, copied_notices: `${release}/licenses`, generated_inputs: generatedInputTrees(root).map(tree => ({ path: tree.path, tree: fileTree(root, tree.path) })) };
  write(root, `${run.relative}/before-bundle.json`, json(native)); return native;
}
async function downloadTools(root, run) {
  const results = [], tools = `${run.relative}/cargo/.tauri`; mkdir(root, tools, true);
  for (const item of BUNDLER_DOWNLOADS) {
    process.stdout.write(`[windows-release] download ${item.name}\n`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) }); ensure(response.ok && response.url.startsWith('https://'), `Download failed: ${item.name}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; ensure(size < 128 * 1024 * 1024, 'Bundler download size limit'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks); ensure(crypto.createHash(item.algorithm).update(bytes).digest('hex') === item.hash, `Pinned bundler hash mismatch: ${item.name}`);
    const local = `${run.relative}/downloads/${item.name}`; write(root, local, bytes);
    if (item.name.endsWith('.zip')) extractZip(root, `${tools}/${item.destination}`, readZip(bytes), item.strip ?? '');
    else write(root, `${tools}/${item.destination}`, bytes);
    results.push({ ...item, path: local, final_url: response.url, ...record(bytes) });
  }
  const provenance = { tauri_cli: CLI_VERSION, source: DOWNLOAD_SOURCE, downloads: results, tool_files: fileTree(root, tools) };
  write(root, `${run.relative}/bundler-tools.json`, json(provenance));
  return provenance;
}
function zipPayload(root, prepared, native) {
  const files = new Map([['aidevbridge.exe', read(root, native.exe.path)], ['README.txt', read(root, 'docs/release/windows-zip-readme.txt')]]);
  for (const item of prepared.notices.files) files.set(`licenses/${item.path}`, read(root, `${NOTICES}/${item.path}`));
  return files;
}
function expectedZip(root, prepared, native) {
  return { files: [{ path: 'aidevbridge.exe', bytes: native.exe.bytes, sha256: native.exe.sha256 }, { path: 'README.txt', ...record(read(root, 'docs/release/windows-zip-readme.txt')) }, ...prepared.notices.files.map(item => ({ ...item, path: `licenses/${item.path}` }))].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}
export function verifyTools(root, run, tools) {
  ensure(tools.tauri_cli === CLI_VERSION && tools.source === DOWNLOAD_SOURCE && tools.downloads.length === BUNDLER_DOWNLOADS.length, 'Bundler source contract changed');
  for (let i = 0; i < BUNDLER_DOWNLOADS.length; i++) {
    const expected = BUNDLER_DOWNLOADS[i], item = tools.downloads[i];
    for (const key of Object.keys(expected)) ensure(item[key] === expected[key], `Bundler download contract changed: ${expected.name}`);
    ensure(item.path === `${run.relative}/downloads/${expected.name}`, 'Bundler archive path changed');
    const bytes = read(root, item.path); verifyRecord(root, item.path, item);
    ensure(crypto.createHash(expected.algorithm).update(bytes).digest('hex') === expected.hash, 'Pinned bundler archive no longer matches');
  }
  verifyTree(root, `${run.relative}/cargo/.tauri`, tools.tool_files);
}
export function finishArtifacts(root, run, tools, versions, { verifyBundler = verifyTools } = {}) {
  const prepared = readJson(root, `${run.relative}/before-build.json`), native = readJson(root, `${run.relative}/before-bundle.json`); verifyPrepared(root, run, prepared); verifyRecord(root, native.exe.path, native.exe); verifyRecord(root, native.pdb.path, native.pdb); verifyTree(root, native.copied_notices, prepared.notices);
  verifyNativeGeneratedInputs(root, native);
  verifyTree(root, `${run.relative}/cargo/.tauri`, tools.tool_files);
  const release = `${run.relative}/cargo/${TARGET}/release`, output = `${run.relative}/artifacts`; mkdir(root, output, true);
  const artifacts = [];
  for (const [kind, folder, suffix] of [['msi', 'msi', '.msi'], ['nsis', 'nsis', '.exe']]) {
    const tree = fileTree(root, `${release}/bundle/${folder}`), matches = tree.files.filter(x => x.path.endsWith(suffix));
    ensure(matches.length === 1 && tree.files.length === 1 && tree.directories.length === 0, `Expected exactly one fresh ${kind} artifact`);
    const source = `${release}/bundle/${folder}/${matches[0].path}`, name = `aidevbridge-${run.contract.version}-windows-x64${kind === 'nsis' ? '-setup.exe' : '.msi'}`;
    const bytes = read(root, source); write(root, `${output}/${name}`, bytes); artifacts.push({ kind, path: name, source_path: source, ...record(bytes) });
  }
  const zipName = `aidevbridge-${run.contract.version}-windows-x64.zip`, zipBytes = createZip(zipPayload(root, prepared, native));
  const expected = expectedZip(root, prepared, native); verifyZip(zipBytes, expected); write(root, `${output}/${zipName}`, zipBytes);
  extractZip(root, `${run.relative}/zip-verification`, verifyZip(read(root, `${output}/${zipName}`), expected));
  equal(fileTree(root, `${run.relative}/zip-verification`).files, expected.files, 'Extracted ZIP differs'); artifacts.push({ kind: 'zip', path: zipName, ...record(zipBytes) });
  const manifest = { schema_version: 1, status: 'artifacts_built_and_zip_verified', acceptance: ACCEPTANCE, source: run.source, contract: run.contract, tools: versions, bundler: tools, frontend: prepared.dist, notices: prepared.notices, installer_notice: prepared.rtf, native, zip_payload: expected, artifacts };
  write(root, `${output}/release-manifest.json`, json(manifest)); verifyRelease(root, run.relative, { verifyBundler }); return manifest;
}
export function verifyRelease(root, rel, { verifyBundler = verifyTools } = {}) {
  ensure(/^out\/release-windows\/[A-Za-z0-9-]+$/.test(rel), 'Expected an owned release run under out/release-windows');
  const run = readJson(root, `${rel}/run.json`); ensure(run.owner === OWNER && run.root === root && run.relative === rel, 'Release run ownership mismatch');
  const manifest = readJson(root, `${rel}/artifacts/release-manifest.json`), prepared = readJson(root, `${rel}/before-build.json`), native = readJson(root, `${rel}/before-bundle.json`);
  ensure(manifest.schema_version === 1 && manifest.status === 'artifacts_built_and_zip_verified', 'Unsupported release manifest');
  equal(manifest.acceptance, ACCEPTANCE, 'This builder does not approve release acceptance');
  equal(manifest.source, run.source, 'Manifest source mismatch'); equal(manifest.contract, run.contract, 'Manifest contract mismatch'); equal(manifest.native, native, 'Manifest native mismatch'); equal(manifest.frontend, prepared.dist, 'Manifest frontend mismatch'); equal(manifest.notices, prepared.notices, 'Manifest license tree mismatch'); equal(manifest.installer_notice, prepared.rtf, 'Manifest notice mismatch');
  verifyPrepared(root, run, prepared); verifyRecord(root, native.exe.path, native.exe); verifyRecord(root, native.pdb.path, native.pdb); verifyTree(root, native.copied_notices, prepared.notices);
  verifyNativeGeneratedInputs(root, native);
  equal(manifest.bundler, readJson(root, `${rel}/bundler-tools.json`), 'Bundler provenance mismatch'); verifyBundler(root, run, manifest.bundler);
  equal(manifest.tools, readJson(root, `${rel}/versions.json`), 'Tool versions mismatch');
  equal(manifest.artifacts.map(a => a.kind).sort(), ['msi', 'nsis', 'zip'], 'Expected exactly three artifacts');
  const actual = fileTree(root, `${rel}/artifacts`); equal(sorted(actual.files.map(f => f.path)), sorted([...manifest.artifacts.map(a => a.path), 'release-manifest.json']), 'Additional/missing delivery files'); ensure(actual.directories.length === 0, 'Unexpected artifact directory');
  for (const item of manifest.artifacts) {
    const suffix = item.kind === 'nsis' ? '-setup.exe' : `.${item.kind}`;
    ensure(item.path === `aidevbridge-${run.contract.version}-windows-x64${suffix}`, 'Artifact name changed');
    verifyRecord(root, `${rel}/artifacts/${item.path}`, item);
    if (item.kind !== 'zip') {
      const folder = `${rel}/cargo/${TARGET}/release/bundle/${item.kind}`, tree = fileTree(root, folder);
      ensure(tree.files.length === 1 && tree.directories.length === 0 && item.source_path === `${folder}/${tree.files[0].path}`, 'Fresh installer source changed');
      verifyRecord(root, item.source_path, item);
    }
  }
  const expected = expectedZip(root, prepared, native); equal(manifest.zip_payload, expected, 'ZIP expected payload changed');
  verifyZip(read(root, `${rel}/artifacts/${manifest.artifacts.find(a => a.kind === 'zip').path}`), expected);
  return { status: manifest.status, directory: `${rel}/artifacts`, manifest_sha256: sha(read(root, `${rel}/artifacts/release-manifest.json`)), acceptance: manifest.acceptance };
}
async function build(root) {
  ensure(process.platform === 'win32' && process.arch === 'x64' && Number(process.versions.node.split('.')[0]) >= 24, 'Windows x64 with Node.js 24+ is required');
  const env = cleanBuildEnvironment(), source = sourceSnapshot(root), initial = releaseContract(root, false), { run, lock } = claimRun(root, source, initial);
  env.CARGO_TARGET_DIR = path.join(root, run.relative, 'cargo'); env.AIDEVBRIDGE_RELEASE_RUN = run.relative; env.AIDEVBRIDGE_RELEASE_TOKEN = lock.token;
  try {
    await command(root, run, 'npm-ci', process.execPath, [npmCli(), 'ci'], env);
    await command(root, run, 'cargo-fetch', 'rustup', ['run', TOOLCHAIN, 'cargo', 'fetch', '--locked'], env);
    equal(releaseContract(root), run.contract, 'Installed tool/input contract changed'); verifySource(root, run.source);
    const versions = { node: { version: process.version, ...record(fs.readFileSync(process.execPath)) }, npm: await command(root, run, 'npm-version', process.execPath, [npmCli(), '--version'], env, true), rustc: await command(root, run, 'rustc-version', 'rustup', ['run', TOOLCHAIN, 'rustc', '-Vv'], env, true), cargo: await command(root, run, 'cargo-version', 'rustup', ['run', TOOLCHAIN, 'cargo', '-Vv'], env, true), tauri: await command(root, run, 'tauri-version', process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', '--version'], env, true) };
    write(root, `${run.relative}/versions.json`, json(versions)); const tools = await downloadTools(root, run);
    await command(root, run, 'tauri-build', process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--ci', '--target', TARGET, '--config', CONFIG, '--bundles', 'msi,nsis', '--', '--locked', '--offline'], env);
    finishArtifacts(root, run, tools, versions); process.stdout.write(`${JSON.stringify(verifyRelease(root, run.relative))}\n`);
  } catch (error) { write(root, `${run.relative}/failed.json`, json({ status: 'failed', message: error.message })); throw error; }
  finally { releaseLock(root, lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    ensure(['build', 'before-build', 'before-bundle', 'verify'].includes(mode) && process.argv.length === (mode === 'verify' ? 4 : 3), 'Usage: node scripts/release-windows-artifacts.mjs build|before-build|before-bundle|verify <out/release-windows/run-id>');
    const root = fs.realpathSync(ROOT);
    if (mode === 'build') await build(root);
    else if (mode === 'before-build') await beforeBuild(root, process.env);
    else if (mode === 'before-bundle') beforeBundle(root, process.env);
    else process.stdout.write(`${JSON.stringify(verifyRelease(root, process.argv[3]))}\n`);
  } catch (error) { process.stderr.write(`windows-release: ${error.message}\n`); process.exitCode = 1; }
}
