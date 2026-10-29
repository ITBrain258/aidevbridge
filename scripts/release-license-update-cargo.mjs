#!/usr/bin/env node
// Carries the reviewed Windows x64 license selection over to a changed
// Cargo.lock. A package whose version changed keeps its decision only when its
// declared license, its role in the release graph, its set of license files
// and the bytes of every license file are unchanged; the decision then moves to
// the new version. A package that left the graph leaves the selection with its
// cargo inputs and with the documents no other component uses. A new package
// outside the release graph is excluded as before. Everything else (a new
// package in the graph, a changed license text, file set, declaration or
// role) is listed for a decision by hand, and then nothing is written.
//
// Nothing is decided from SPDX expressions and nothing is fetched: cargo runs
// --offline, the old and new sources come from the registry cache. Run it on
// Windows x64, the build host of the Windows release, so that host cfgs match.
// Without --write it only prints the plan. Afterwards: rebind Cargo.lock and
// the new record (release-license-rebind.mjs), derive macOS and Android again
// and run release-licenses.mjs check for all three.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELECTION = 'docs/release/license-selection.windows-x64.json';
const TARGET = 'x86_64-pc-windows-msvc';
const licenseName = /^(?:licen[sc]e|licen[sc]ing|copying|copyright|notice|unlicense)(?:$|[._-])/i;

const fail = message => { throw new Error(message); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });
const byKey = (key) => (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

function run(root, args) {
  return execFileSync('rustup', args, { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

// Same package set as release-licenses.mjs (cargoMetadata) for this target.
function metadata(root, toolchain) {
  return JSON.parse(run(root, ['run', toolchain, 'cargo', 'metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', TARGET, '--features', 'tauri/custom-protocol']));
}

// Same classification as release-license-inventory.mjs: the release graph is
// normal and build edges from the product, the runtime part its normal edges
// without proc macros; anything else in the metadata is outside the tree.
function roles(root, toolchain, meta) {
  ensure(process.platform === 'win32' && process.arch === 'x64', `Run this on Windows x64, the build host of ${TARGET}`);
  const tree = edges => {
    const raw = run(root, ['run', toolchain, 'cargo', 'tree', '--locked', '--offline', '--target', TARGET, '--features', 'tauri/custom-protocol', '--edges', edges, '--prefix', 'none', '--format', '{p}|{f}', '--charset', 'ascii']);
    const map = new Map();
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const m = /^([^ ]+) v([^ ]+)(.*?)\|(.*?)(?: \(\*\))?$/.exec(line);
      ensure(m, `Unparsed cargo tree line: ${line}`);
      const key = `${m[1]}@${m[2]}`;
      const features = map.get(key) ?? new Set();
      m[4].split(',').filter(Boolean).forEach(f => features.add(f));
      map.set(key, features);
    }
    return map;
  };
  const release = tree('normal,build'), normal = tree('normal,no-proc-macro');
  const result = new Map();
  for (const pkg of meta.packages) {
    const key = `${pkg.name}@${pkg.version}`;
    const role = meta.workspace_members.includes(pkg.id) ? 'workspace-product' : normal.has(key) ? 'normal-runtime-candidate'
      : release.has(key) ? 'build-or-proc-macro-only-in-this-tree' : 'outside-selected-windows-tree';
    result.set(key, { role, features: release.has(key) ? [...release.get(key)].sort() : null });
  }
  return result;
}

function licenseCandidates(dir) {
  const found = [];
  const walk = (base, depth) => {
    ensure(depth <= 16, `License scan depth exceeded: ${base}`);
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(base, entry.name);
      if (entry.isDirectory() && !['target', '.git', 'node_modules'].includes(entry.name)) walk(p, depth + 1);
      else if (entry.isFile() && licenseName.test(entry.name)) found.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir, 0);
  return found.sort();
}

function lockChecksums(root) {
  const map = new Map();
  for (const part of fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8').split('[[package]]').slice(1)) {
    const value = field => new RegExp(`^${field} = "([^"]*)"`, 'm').exec(part)?.[1] ?? null;
    map.set(`${value('name')}@${value('version')}`, value('checksum'));
  }
  return map;
}

// Cargo's compatibility class: the major version, or 0.minor before 1.0.
const compatClass = version => { const [major, minor] = version.split(/[.+-]/).map(Number); return major > 0 ? `${major}` : `0.${minor}`; };
const nameOf = key => key.slice(0, key.lastIndexOf('@'));
const versionOf = key => key.slice(key.lastIndexOf('@') + 1);
const crateUrl = (name, version) => `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
const pageUrl = (name, version) => `https://crates.io/crates/${name}/${version}`;

// Pairs every new version of a package with the version it replaces: first
// within Cargo's compatibility class, then one remaining old with one
// remaining new version.
function pairVersions(added, removed) {
  const pairs = new Map(), byName = new Map();
  for (const key of removed) byName.set(nameOf(key), [...(byName.get(nameOf(key)) ?? []), key]);
  const open = [];
  for (const key of added) {
    const candidates = byName.get(nameOf(key)) ?? [];
    const same = candidates.filter(old => compatClass(versionOf(old)) === compatClass(versionOf(key)));
    if (same.length === 1) { pairs.set(key, same[0]); byName.set(nameOf(key), candidates.filter(old => old !== same[0])); }
    else open.push(key);
  }
  for (const key of open) {
    const candidates = byName.get(nameOf(key)) ?? [];
    if (candidates.length === 1 && open.filter(k => nameOf(k) === nameOf(key)).length === 1) { pairs.set(key, candidates[0]); byName.set(nameOf(key), []); }
  }
  return pairs;
}

export function plan(root, { date }) {
  const selection = JSON.parse(fs.readFileSync(path.join(root, SELECTION), 'utf8'));
  const toolchain = selection.scope.rust_toolchain;
  const meta = metadata(root, toolchain);
  const roleMap = roles(root, toolchain, meta);
  const checksums = lockChecksums(root);
  const packages = new Map(meta.packages.map(p => [`${p.name}@${p.version}`, p]));
  const oldPackages = new Map(selection.inputs.cargo_packages.map(p => [p.package, p]));
  const components = new Map(selection.components.map(c => [c.id, c]));
  const added = [...packages.keys()].filter(k => !oldPackages.has(k)).sort();
  const removed = [...oldPackages.keys()].filter(k => !packages.has(k)).sort();
  const pairs = pairVersions(added, removed);
  const result = { moved: [], unchanged: 0, featureChanges: 0, removed: [], newOutside: [], review: [], features: new Map([...roleMap].map(([key, value]) => [key, value.features])) };

  for (const [key, pkg] of packages) {
    const { role, features } = roleMap.get(key);
    if (oldPackages.has(key)) {
      const component = components.get(`cargo:${key}`);
      ensure(component, `No component for bound package ${key}`);
      if (component.technical_role !== role) result.review.push({ package: key, problem: `role ${component.technical_role} -> ${role}` });
      else if (oldPackages.get(key).declared_license !== pkg.license) result.review.push({ package: key, problem: 'declared license changed' });
      else { result.unchanged++; if (JSON.stringify(component.release_tree_features) !== JSON.stringify(features)) result.featureChanges++; }
      continue;
    }
    const old = pairs.get(key);
    if (!old) {
      if (role === 'outside-selected-windows-tree') result.newOutside.push({ package: key, pkg, role, features });
      else result.review.push({ package: key, problem: `new package (${role}, declared ${pkg.license ?? 'none'})` });
      continue;
    }
    const component = components.get(`cargo:${old}`);
    ensure(component, `No component for bound package ${old}`);
    const oldPackage = oldPackages.get(old);
    const dir = path.dirname(fs.realpathSync(pkg.manifest_path));
    const oldDir = path.join(path.dirname(dir), `${nameOf(old)}-${versionOf(old)}`);
    const bound = selection.inputs.cargo_files.filter(f => f.package === old);
    const problems = [];
    if (component.technical_role !== role) problems.push(`role ${component.technical_role} -> ${role}`);
    if (oldPackage.declared_license !== pkg.license) problems.push(`declared license ${oldPackage.declared_license} -> ${pkg.license}`);
    if (oldPackage.source !== pkg.source) problems.push('source changed');
    const files = [];
    for (const file of bound) {
      const target = path.join(dir, ...file.path.split('/'));
      if (!fs.existsSync(target)) { problems.push(`${file.path} is gone`); continue; }
      const now = record(fs.readFileSync(target));
      if (now.sha256 !== file.sha256) problems.push(`${file.path} changed`);
      files.push({ path: file.path, ...now });
    }
    const newCandidates = licenseCandidates(dir);
    const oldCandidates = fs.existsSync(oldDir) ? licenseCandidates(oldDir) : null;
    const boundPaths = new Set(bound.map(f => f.path));
    if (oldCandidates) {
      if (JSON.stringify(oldCandidates) !== JSON.stringify(newCandidates)) problems.push(`license files ${oldCandidates.join(',')} -> ${newCandidates.join(',')}`);
      else for (const candidate of newCandidates.filter(c => !boundPaths.has(c))) {
        const a = record(fs.readFileSync(path.join(oldDir, ...candidate.split('/')))), b = record(fs.readFileSync(path.join(dir, ...candidate.split('/'))));
        if (a.sha256 !== b.sha256) problems.push(`unbound ${candidate} changed`);
      }
    } else if (newCandidates.some(c => !boundPaths.has(c))) problems.push(`old source not cached; new unbound license files ${newCandidates.filter(c => !boundPaths.has(c)).join(',')}`);
    if (problems.length > 0) { result.review.push({ package: key, replaces: old, problem: problems.join('; ') }); continue; }
    result.moved.push({ key, old, pkg, role, features, files, manifest: record(fs.readFileSync(pkg.manifest_path)), oldManifest: oldPackage.manifest, checksum: checksums.get(key) ?? null });
  }
  const movedOld = new Set(result.moved.map(m => m.old));
  const reviewedOld = new Set(result.review.map(r => r.replaces).filter(Boolean));
  for (const key of removed) if (!movedOld.has(key) && !reviewedOld.has(key)) {
    const component = components.get(`cargo:${key}`);
    result.removed.push({ package: key, role: component?.technical_role ?? null, disposition: component?.disposition ?? null });
  }
  return { selection, toolchain, result, recordPath: `docs/release/license-rust-update-${date}.json` };
}

function replaceVersion(text, name, oldVersion, newVersion) {
  return text.split(`${name}-${oldVersion}`).join(`${name}-${newVersion}`).split(`/${name}/${oldVersion}`).join(`/${name}/${newVersion}`).split(`${name}@${oldVersion}`).join(`${name}@${newVersion}`);
}

export function apply(root, { selection, toolchain, result, recordPath }, { date }) {
  ensure(result.review.length === 0, `Decisions needed by hand:\n${result.review.map(r => `  ${r.package}${r.replaces ? ` (replaces ${r.replaces})` : ''}: ${r.problem}`).join('\n')}`);
  const outsideReason = selection.components.find(c => c.technical_role === 'outside-selected-windows-tree')?.reason;
  ensure(outsideReason, 'No reviewed reason for packages outside the Windows tree');
  const before = selection.inputs.files.find(f => f.path === 'Cargo.lock');
  const lockNow = record(fs.readFileSync(path.join(root, 'Cargo.lock')));

  for (const move of result.moved) {
    const name = move.pkg.name, oldVersion = versionOf(move.old), newVersion = move.pkg.version;
    const component = selection.components.find(c => c.id === `cargo:${move.old}`);
    component.id = `cargo:${move.key}`;
    component.version = newVersion;
    component.release_tree_features = move.features;
    component.source_urls = component.source_urls.map(u => replaceVersion(u, name, oldVersion, newVersion));
    component.source_archive = { url: crateUrl(name, newVersion), sha256: move.checksum };
    component.decision_basis = [...component.decision_basis, recordPath];
    component.reason = `${component.reason} Updated from ${oldVersion} to ${newVersion} on ${date}; same declared license, role and byte-identical license files.`;
    const pkg = selection.inputs.cargo_packages.find(p => p.package === move.old);
    pkg.package = move.key;
    pkg.manifest = move.manifest;
    for (const file of selection.inputs.cargo_files) if (file.package === move.old) file.package = move.key;
    for (const doc of selection.documents) {
      doc.source_names = doc.source_names.map(n => n.startsWith(`${move.old}/`) ? `${move.key}/${n.slice(move.old.length + 1)}` : n);
      doc.source_urls = doc.source_urls.map(u => u === pageUrl(name, oldVersion) ? pageUrl(name, newVersion) : u);
      if (doc.file_name.startsWith(`${name}-${oldVersion}-`)) doc.file_name = `${name}-${newVersion}-${doc.file_name.slice(`${name}-${oldVersion}-`.length)}`;
    }
  }
  for (const item of result.newOutside) {
    selection.components.push({ id: `cargo:${item.package}`, name: item.pkg.name, version: item.pkg.version, declared_license: item.pkg.license, selected_license: null, disposition: 'exclude', technical_role: item.role, release_tree_features: null, documents: [], reason: outsideReason, source_urls: [crateUrl(item.pkg.name, item.pkg.version), pageUrl(item.pkg.name, item.pkg.version)], decision_basis: [recordPath], source_archive: { url: crateUrl(item.pkg.name, item.pkg.version), sha256: lockChecksums(root).get(item.package) } });
    selection.inputs.cargo_packages.push({ package: item.package, source: item.pkg.source, manifest: record(fs.readFileSync(item.pkg.manifest_path)), declared_license: item.pkg.license });
  }
  const gone = new Set(result.removed.map(r => r.package));
  selection.components = selection.components.filter(c => !gone.has(c.id.replace(/^cargo:/, '')));
  selection.inputs.cargo_packages = selection.inputs.cargo_packages.filter(p => !gone.has(p.package));
  selection.inputs.cargo_files = selection.inputs.cargo_files.filter(f => !gone.has(f.package));
  const used = new Set(selection.components.flatMap(c => c.documents));
  const droppedDocuments = selection.documents.filter(d => !used.has(d.id)).map(d => d.file_name);
  selection.documents = selection.documents.filter(d => used.has(d.id));
  // Features follow the new graph for every package (feature unification can
  // change them for an unchanged version too); they describe, they decide nothing.
  for (const c of selection.components) if (c.id.startsWith('cargo:') && result.features.has(c.id.slice(6))) c.release_tree_features = result.features.get(c.id.slice(6));

  selection.components.sort(byKey(c => c.id));
  selection.inputs.cargo_packages.sort(byKey(p => p.package));
  selection.inputs.cargo_files.sort(byKey(f => `${f.package}\u0000${f.path}`));
  selection.documents.sort(byKey(d => d.id));
  if (!selection.decision_reports.includes(recordPath)) selection.decision_reports.push(recordPath);
  selection.scope.historical_evidence = `${selection.scope.historical_evidence} Updated on ${date} for a Cargo.lock update (${recordPath}): ${result.moved.length} packages moved to new versions with the same declared license, role and byte-identical license files, ${result.removed.length} packages left the graph, ${result.newOutside.length} new packages outside the Windows tree are excluded.`;

  const evidence = {
    schema_version: 1,
    observed_utc: new Date().toISOString(),
    scope: `Cargo.lock update carried over to the Windows x64 license selection by scripts/release-license-update-cargo.mjs; target ${TARGET}, Rust ${toolchain}, features tauri/custom-protocol. Not final application compliance or installer delivery.`,
    basis: [SELECTION],
    lockfile: { path: 'Cargo.lock', before: before ? { bytes: before.bytes, sha256: before.sha256 } : null, after: lockNow },
    rule: 'A decision moves to a new version only when the declared license, the role in the release graph, the set of license-named files and the bytes of every bound license file are unchanged; the old and new sources are compared from the registry cache.',
    moved: result.moved.map(m => ({ package: m.pkg.name, before: versionOf(m.old), after: m.pkg.version, role: m.role, declared_license: m.pkg.license, archive: { url: crateUrl(m.pkg.name, m.pkg.version), sha256: m.checksum }, manifest: { before: m.oldManifest, after: m.manifest }, license_files: m.files })),
    new_outside_tree: result.newOutside.map(n => ({ package: n.package, declared_license: n.pkg.license, decision: 'exclude' })),
    removed: result.removed,
    dropped_documents: droppedDocuments,
    unchanged_packages: result.unchanged,
    decision: 'The reviewed decisions stand for the moved packages. Removed packages and documents that no component uses any more leave the selection.',
  };
  fs.writeFileSync(path.join(root, recordPath), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(root, SELECTION), `${JSON.stringify(selection, null, 2)}\n`);
  return { written: [recordPath, SELECTION], droppedDocuments };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const date = (args.find(a => a.startsWith('--date=')) ?? '').slice(7) || new Date().toISOString().slice(0, 10);
    ensure(/^\d{4}-\d{2}-\d{2}$/.test(date) && args.every(a => a === '--write' || a.startsWith('--date=')), 'Usage: node scripts/release-license-update-cargo.mjs [--write] [--date=YYYY-MM-DD]');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const planned = plan(root, { date });
    const { result } = planned;
    const summary = { moved: result.moved.length, unchanged: result.unchanged, feature_changes_on_unchanged: result.featureChanges, removed: result.removed.length, new_outside_tree: result.newOutside.map(n => n.package), review: result.review };
    if (write) Object.assign(summary, apply(root, planned, { date }));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) { console.error(`release-license-update-cargo: ${error.message}`); process.exitCode = 1; }
}
