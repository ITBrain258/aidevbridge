#!/usr/bin/env node
// Offline inventory only: no build, install, package modification or license election.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const target = 'x86_64-pc-windows-msvc';
const baseline = '6a45c12';
const output = 'docs/release/license-inventory-2026-09-12-rust.json';
if (process.argv.slice(2).some(x => x !== '--write')) throw new Error('Only --write is supported; default prints JSON.');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const slash = p => p.replaceAll('\\', '/');
const relative = p => slash(path.relative(root, p));
// R6.2: keine Profilpfade im Inventar. Dateien unter CARGO_HOME und RUSTUP_HOME
// erscheinen als $CARGO_HOME/... und $RUSTUP_HOME/..., Dateien im Checkout relativ
// zu ihm. `neutral` tut dasselbe in jedem Text der Ausgabe (Rohausgaben von cargo,
// Build-Belege, Paket-IDs), in jeder Schreibweise; die Lizenztexte bleiben unberuehrt.
const cargoHome = path.resolve(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'));
const rustupHome = path.resolve(process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup'));
const homes = [[cargoHome, '$CARGO_HOME'], [rustupHome, '$RUSTUP_HOME']];
function neutralPath(p) {
  for (const [base, name] of homes) {
    const rel = path.relative(base, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${name}/${slash(rel)}`;
  }
  return relative(p);
}
const homePatterns = [...homes, [root, '.']].map(([base, name]) =>
  [new RegExp(slash(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('/', '[\\\\/]+'), 'gi'), name]);
const neutral = value => typeof value === 'string' ? homePatterns.reduce((text, [pattern, name]) => text.replace(pattern, () => name), value)
  : Array.isArray(value) ? value.map(neutral)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, neutral(item)])) : value;
const commands = [];
function command(program, args) {
  const data = execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  commands.push({ program, args, exit_code: 0, stdout_sha256: sha(Buffer.from(data)) });
  return data;
}
function file(p) {
  const b = fs.readFileSync(p);
  return { path: neutralPath(p), bytes: b.length, sha256: sha(b) };
}
const inputs = ['Cargo.toml', 'Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'src-tauri/build.rs', 'package.json', 'package-lock.json', 'LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_LICENSES.md', 'vendor/russh/Cargo.toml', 'vendor/russh/LICENSE-APACHE', 'vendor/russh/AGENTBRIDGE-PATCH.md', 'vendor/russh/UPSTREAM-SHA256SUMS', relative(script)];
const inputRecords = inputs.map(p => {
  const item = file(path.join(root, p));
  try {
    const b = execFileSync('git', ['show', `${baseline}:${p}`], { cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    item.baseline_sha256 = sha(b);
    item.same_bytes_as_baseline = item.sha256 === item.baseline_sha256;
  } catch { item.baseline_sha256 = null; item.same_bytes_as_baseline = null; }
  return item;
});
const head = command('git', ['rev-parse', 'HEAD']).trim();
const cargoVersion = command('cargo', ['--version']).trim();
const rustcVersion = command('rustc', ['-vV']).trim();
const common = ['--locked', '--offline', '--target', target, '--features', 'tauri/custom-protocol'];
const metadata = JSON.parse(command('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', target, '--features', 'tauri/custom-protocol']));
function tree(edges) {
  const raw = command('cargo', ['tree', ...common, '--edges', edges, '--prefix', 'none', '--format', '{p}|{l}|{f}', '--charset', 'ascii']);
  const map = new Map();
  for (const line of raw.trim().split(/\r?\n/)) {
    const m = /^([^ ]+) v([^ ]+)(.*?)\|([^|]*)\|(.*?)(?: \(\*\))?$/.exec(line);
    if (!m) throw new Error(`Unparsed cargo tree line: ${line}`);
    const key = `${m[1]}@${m[2]}`;
    const item = map.get(key) ?? { features: new Set(), proc_macro: false };
    m[5].split(',').filter(Boolean).forEach(f => item.features.add(f));
    item.proc_macro ||= m[3].includes('(proc-macro)');
    map.set(key, item);
  }
  return { raw, map };
}
const release = tree('normal,build');
const normal = tree('normal,no-proc-macro');
const withDev = tree('normal,build,dev');
const lock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
const lockEntries = new Map();
for (const part of lock.split('[[package]]').slice(1)) {
  const value = field => new RegExp(`^${field} = "([^"]*)"`, 'm').exec(part)?.[1] ?? null;
  const name = value('name'), version = value('version');
  lockEntries.set(`${name}@${version}`, { source: value('source'), checksum: value('checksum') });
}
const textMap = new Map();
const licenseName = /^(?:licen[sc]e|licen[sc]ing|copying|copyright|notice|unlicense)(?:$|[._-])/i;
function licenseFiles(dir, explicit) {
  const found = new Map();
  let visited = 0;
  function walk(base, depth) {
    if (depth > 16) throw new Error(`License scan depth exceeded: ${base}`);
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 30000) throw new Error(`License scan entry limit exceeded: ${dir}`);
      if (entry.isSymbolicLink()) continue;
      const p = path.join(base, entry.name);
      if (entry.isDirectory()) {
        if (!['target', '.git', 'node_modules'].includes(entry.name)) walk(p, depth + 1);
      } else if (entry.isFile() && (licenseName.test(entry.name) || /(?:^|[\\/])LICENSES[\\/]/i.test(p))) found.set(p, false);
    }
  }
  walk(dir, 0);
  if (explicit) {
    const p = path.resolve(dir, explicit);
    const rel = path.relative(dir, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`license-file escapes package: ${p}`);
    if (fs.existsSync(p) && fs.lstatSync(p).isFile()) found.set(p, true);
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, declared]) => {
    const b = fs.readFileSync(p);
    if (b.length > 2 * 1024 * 1024) throw new Error(`Oversized candidate license: ${p}`);
    const digest = sha(b);
    // Keep original bytes losslessly when text is not valid UTF-8.
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b); } catch { text = null; }
    if (text !== null && !Buffer.from(text, 'utf8').equals(b)) text = null;
    if (!textMap.has(digest)) textMap.set(digest, text === null ? { bytes: b.length, encoding: 'base64', content: b.toString('base64') } : { bytes: b.length, encoding: 'utf8', content: text });
    return { path: slash(path.relative(dir, p)), bytes: b.length, sha256: digest, declared_license_file: declared, candidate_only: true };
  });
}
const packages = [];
const seenKeys = new Set();
for (const pkg of metadata.packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const key = `${pkg.name}@${pkg.version}`;
  if (seenKeys.has(key)) throw new Error(`Ambiguous package name/version: ${key}`);
  seenKeys.add(key);
  const dir = path.dirname(pkg.manifest_path);
  const r = release.map.get(key), n = normal.map.get(key), d = withDev.map.get(key);
  const own = metadata.workspace_members.includes(pkg.id);
  const role = own ? 'workspace-product' : n ? 'normal-runtime-candidate' : r ? 'build-or-proc-macro-only-in-this-tree' : d ? 'dev-only-in-this-tree' : 'outside-selected-windows-tree';
  const texts = licenseFiles(dir, pkg.license_file);
  const lockEntry = lockEntries.get(key);
  packages.push({
    name: pkg.name, version: pkg.version, id: pkg.id, source: pkg.source, repository: pkg.repository,
    declared_spdx: pkg.license, declared_license_file: pkg.license_file, manifest_path: neutralPath(pkg.manifest_path),
    manifest_sha256: sha(fs.readFileSync(pkg.manifest_path)), lock_checksum: lockEntry?.checksum ?? null,
    vcs_info: fs.existsSync(path.join(dir, '.cargo_vcs_info.json')) ? JSON.parse(fs.readFileSync(path.join(dir, '.cargo_vcs_info.json'), 'utf8')) : null,
    technical_role: role, included_in_release_tree: !!r, included_in_normal_tree_without_proc_macros: !!n,
    included_in_tree_with_dev: !!d, proc_macro: pkg.targets.some(t => t.kind.includes('proc-macro')),
    release_tree_features: r ? [...r.features].sort() : null,
    metadata_union_features: metadata.resolve.nodes.find(x => x.id === pkg.id)?.features ?? null,
    license_candidates: texts,
    text_status: texts.length ? 'candidate-files-available-not-legally-mapped' : 'no-named-license-file-found-in-installed-source',
    distributed_as_repo_source: pkg.name === 'russh' && !pkg.source,
  });
}
for (const k of release.map.keys()) if (!seenKeys.has(k)) throw new Error(`Tree package absent from metadata: ${k}`);
const fingerprints = [];
const fpRoot = path.join(root, 'target/release/.fingerprint');
if (fs.existsSync(fpRoot)) for (const dir of fs.readdirSync(fpRoot).filter(n => /^(?:aidevbridge|tauri)-/.test(n)).sort()) {
  for (const name of fs.readdirSync(path.join(fpRoot, dir)).filter(n => /^(?:bin-aidevbridge|lib-aidevbridge_lib|lib-tauri)(?:\.json)?$/.test(n)).sort()) {
    const p = path.join(fpRoot, dir, name), b = fs.readFileSync(p);
    fingerprints.push({ ...file(p), modified_utc: fs.statSync(p).mtime.toISOString(), raw_utf8: b.toString('utf8') });
  }
}
const exe = path.join(root, 'target/release/aidevbridge.exe');
const native = [];
for (const pkg of packages.filter(p => p.included_in_release_tree && /^(?:webview2-com-sys|windows_x86_64_msvc|ring)$/.test(p.name))) {
  const dir = path.dirname(pkg.manifest_path);
  const relevant = pkg.name === 'webview2-com-sys' ? ['build.rs', 'src/lib.rs', 'x64/WebView2LoaderStatic.lib', 'x64/WebView2Loader.dll', 'x64/WebView2Loader.dll.lib'] : pkg.name === 'ring' ? ['build.rs'] : ['lib/windows.0.48.5.lib', 'lib/windows.0.52.0.lib', 'lib/windows.0.53.0.lib'];
  for (const rel of relevant) if (fs.existsSync(path.join(dir, rel))) native.push({ package: `${pkg.name}@${pkg.version}`, package_relative_path: rel, ...file(path.join(dir, rel)) });
}
const buildRoot = path.join(root, 'target/release/build');
const nativeBuildEvidence = [];
if (fs.existsSync(buildRoot)) for (const dir of fs.readdirSync(buildRoot).filter(n => /^webview2-com-sys-/.test(n)).sort()) {
  for (const name of ['output', 'out/x64/WebView2LoaderStatic.lib']) {
    const p = path.join(buildRoot, dir, name);
    if (fs.existsSync(p)) nativeBuildEvidence.push({ ...file(p), raw_utf8: name === 'output' ? fs.readFileSync(p, 'utf8') : null });
  }
}
const sourceContextEvidence = [];
for (const pkg of packages.filter(p => ['dirs-sys', 'option-ext', 'russh-cryptovec'].includes(p.name))) {
  for (const name of ['src/lib.rs', ...(pkg.name === 'dirs-sys' ? ['src/xdg_user_dirs.rs'] : [])]) {
    const p = path.join(path.dirname(pkg.manifest_path), name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    sourceContextEvidence.push({ package: `${pkg.name}@${pkg.version}`, package_relative_path: name, ...file(p),
      relevant_lines: lines.flatMap((line, i) => /option_ext|mod xdg_user_dirs|cfg\(all\(unix|Copyright|Licensed under|apache.org\/licenses/.test(line) ? [{ line: i + 1, text: line }] : []) });
  }
}
for (const item of inputRecords) if (file(path.join(root, item.path)).sha256 !== item.sha256) throw new Error(`Input changed during scan: ${item.path}`);
const counts = {};
for (const p of packages) counts[p.technical_role] = (counts[p.technical_role] ?? 0) + 1;
const report = {
  schema_version: 1, generated_utc: new Date().toISOString(), status: 'inventory-draft-not-a-license-compliance-verdict',
  generator: relative(script), git_head: head, comparison_baseline_commit: baseline, input_files: inputRecords,
  environment: { node: process.version, cargo: cargoVersion, rustc: rustcVersion },
  configuration: { target, features_argument: 'tauri/custom-protocol', default_features_enabled: true, dev_dependencies_in_release_tree: false, workspace_resolver: '2' },
  methodology: [
    'Cargo commands use --locked --offline and do not build, fetch or install.',
    'Release tree is cargo tree -e normal,build; technical approximation of cargo build, not a linker-derived binary SBOM.',
    'normal-runtime-candidate means reachable through normal edges without proc-macro subtrees; unused code may be removed and macro/build output may still be embedded.',
    'metadata packages and feature union are recorded separately; outside-selected-windows-tree does not mean it is shipped.',
    'License candidates are actual local files by name or explicit license-file, recursively scanned to depth 16 without following symlinks; availability is not proof of full applicable license/notice coverage.',
    'License texts are stored once by exact SHA256; nested/test/tooling license candidates require source-to-output applicability review.',
    'No automatic SPDX expression selection, copyright substitution, or legal sufficiency decision is made.',
    'Existing release artifact/fingerprints may predate current HEAD; input baseline comparisons and raw fingerprint evidence are recorded separately.',
    'Rust standard libraries, MSVC/system DLLs, WebView2 runtime redistribution and final installer/portable contents require separate release-artifact inspection.',
  ],
  counts: { metadata_packages: packages.length, release_tree_packages: release.map.size, normal_tree_without_proc_macros: normal.map.size, tree_with_dev_packages: withDev.map.size, roles: counts, unique_candidate_texts: textMap.size },
  release_artifact: fs.existsSync(exe) ? { ...file(exe), modified_utc: fs.statSync(exe).mtime.toISOString() } : null,
  fingerprint_evidence: fingerprints, native_component_evidence: native, native_build_evidence: nativeBuildEvidence, source_context_evidence: sourceContextEvidence,
  commands, tree_outputs: { release_normal_build: release.raw, normal_without_proc_macro: normal.raw, normal_build_dev: withDev.raw },
  packages, candidate_texts_by_sha256: Object.fromEntries([...textMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
const json = JSON.stringify({ ...neutral({ ...report, candidate_texts_by_sha256: null }), candidate_texts_by_sha256: report.candidate_texts_by_sha256 }, null, 2) + '\n';
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
  fs.writeFileSync(path.join(root, output), json, 'utf8');
  console.log(JSON.stringify({ output, bytes: Buffer.byteLength(json), sha256: sha(Buffer.from(json)), counts: report.counts }));
} else process.stdout.write(json);
