#!/usr/bin/env node
// Carries the reviewed Windows x64 license selection over to a changed
// Cargo.lock. A package whose version changed keeps its decision only when its
// declared license, its role in the release graph, its set of license files
// and the bytes of every bound file are unchanged and every selected text is
// one of its own bound files; the decision then moves to the new version. A package that left the graph leaves the selection with its
// cargo inputs and with the documents no other component uses. A new package
// outside the release graph is excluded as before. Everything else needs an
// entry in REVIEWED below, decided by hand; without one nothing is written.
//
// Nothing is decided from SPDX expressions and nothing is fetched: cargo runs
// --offline, the old and new sources come from the registry cache. New texts
// are kept in the update record (candidate_texts_by_sha256), from which
// release-licenses.mjs reads them like the 2026-09-12 inventory. Run it on
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

const RUNTIME_MIT = 'Explicit MIT selection using the complete original text. Windows runtime candidate notice coverage; no claim every object survives linking.';
const BUILD_MIT = 'Explicit MIT selection using the complete original text. Conservative permissive build/source family disclosure; no claim that the tool program is delivered.';
const TAURI_RENAMES = { LICENSE_MIT: 'LICENSE-MIT', 'LICENSE_APACHE-2.0': 'LICENSE-APACHE-2.0' };

// Reviewed by hand, keyed by the new package. The script still checks the
// facts each entry relies on: `changed` names exactly the bound files whose
// bytes changed, `renames` maps bound files to new names with the same bytes,
// `added` names exactly the new license-named files, `declared` the new
// declaration. A changed bound file that a document was made from gives a new
// document from the new bytes. `external` records how a selected text that is
// not one of the package's own files (a repository text, a sibling crate's or
// a shared text) was checked against the new version; such a move needs it.
// `reason` replaces the base reason when its evidence named the old build.
// `role` accepts a new role for an unchanged version; `new` decides a package
// that had no version in the selection (MIT only: the reasons say so).
const REVIEWED = {
  // 2026-10-29, Tauri 2.12 and the semver-compatible updates.
  'argon2@0.6.0': { changed: ['LICENSE-MIT'], note: 'MIT text: copyright years 2021-2024 -> 2021-2026, same terms; the new text ships.' },
  'cpufeatures@0.3.1': { changed: ['LICENSE-MIT'], note: 'MIT text: copyright years 2020-2025 -> 2020-2026, same terms; the new text ships.' },
  'keccak@0.2.2': { changed: ['LICENSE-MIT'], note: 'MIT text: copyright line now "2018-2026 The RustCrypto Project Developers", same terms; the new text ships.' },
  'quick-xml@0.42.0': { changed: ['LICENSE-MIT.md'], note: 'MIT text: line endings CRLF -> LF only; the new bytes ship.' },
  'serde_spanned@1.1.2': { changed: ['LICENSE-APACHE'], note: 'Only the Apache-2.0 copyright placeholder was filled in; the shipped MIT text is unchanged.' },
  'toml@1.1.8+spec-1.1.0': { changed: ['LICENSE-APACHE'], note: 'Only the Apache-2.0 copyright placeholder was filled in; the shipped MIT text is unchanged.' },
  'toml_datetime@1.1.2+spec-1.1.0': { changed: ['LICENSE-APACHE'], note: 'Only the Apache-2.0 copyright placeholder was filled in; the shipped MIT text is unchanged.' },
  'toml_parser@1.1.5+spec-1.1.0': { changed: ['LICENSE-APACHE'], note: 'Only the Apache-2.0 copyright placeholder was filled in; the shipped MIT text is unchanged.' },
  'toml_writer@1.1.3+spec-1.1.0': { changed: ['LICENSE-APACHE'], note: 'Only the Apache-2.0 copyright placeholder was filled in; the shipped MIT text is unchanged.' },
  'tauri@2.12.5': { renames: TAURI_RENAMES, changed: ['Cargo.toml.orig', 'build.rs'], note: 'License files renamed with the same bytes; Cargo.toml.orig and build.rs changed without license or notice lines.' },
  'tauri-build@2.7.4': { renames: TAURI_RENAMES, changed: ['Cargo.toml.orig'], note: 'License files renamed with the same bytes; Cargo.toml.orig changed without license lines.' },
  'tauri-codegen@2.7.4': { renames: TAURI_RENAMES, changed: ['Cargo.toml.orig'], note: 'License files renamed with the same bytes; Cargo.toml.orig changed without license lines.' },
  'tauri-macros@2.7.4': { renames: TAURI_RENAMES, changed: ['Cargo.toml.orig'], note: 'License files renamed with the same bytes; Cargo.toml.orig changed without license lines.' },
  'tauri-runtime@2.12.2': { renames: TAURI_RENAMES, note: 'License files renamed with the same bytes.' },
  'tauri-runtime-wry@2.12.3': { renames: TAURI_RENAMES, note: 'License files renamed with the same bytes.' },
  'tauri-utils@2.10.2': { renames: TAURI_RENAMES, changed: ['Cargo.toml.orig'], note: 'License files renamed with the same bytes; Cargo.toml.orig changed without license lines.' },
  'tauri-plugin@2.7.2': { changed: ['src/build/mobile.rs', 'src/build/mod.rs', 'src/lib.rs'], note: 'Source changes without copyright or license lines (documentation examples, and src/build/mobile.rs returns early when DOCS_RS is set); build-only role unchanged.', external: 'The crate ships no license file; the selected MIT text is the tauri repository\'s LICENSE-MIT, byte-identical at the publish commit 59b63ab of 2.7.2.' },
  'webview2-com-sys@0.39.1': { changed: ['build.rs'], note: 'build.rs adds the arm64ec machine type only; linking for x64 is unchanged.', external: 'The crate ships no license file; the LICENSE of wravery/webview2-rs at the publish commit edc2caf of 0.39.1 is byte-identical to the selected MIT text.' },
  'webview2-com@0.39.1': { external: 'The crate ships no license file; the LICENSE of wravery/webview2-rs at the publish commit edc2caf of 0.39.1 is byte-identical to the selected MIT text.' },
  'alloc-stdlib@0.3.0': { external: 'The crate ships no license file; the LICENSE of dropbox/rust-alloc-no-stdlib at the publish commit 0a81fd6 of 0.3.0 is byte-identical to the selected BSD-3-Clause text, as at 0.2.4.' },
  'brotli@9.1.1': { external: 'The selected Google notice is the header of src/enc/entropy_encode.rs, unchanged in 9.1.1; the set of copyright and license lines in the crate\'s Rust sources is identical to 8.0.4.' },
  'pageant@0.2.5': { external: 'The crate ships no license file; the LICENSE.txt of warp-tech/russh at the publish commit 183a22e of 0.2.5 is byte-identical to the selected Apache-2.0 text, as at 0.2.4.' },
  'wry@0.57.1': { changed: ['Cargo.toml.orig', 'build.rs'], note: 'build.rs adds a macOS-only cfg check; no license or notice lines.' },
  'cssparser@0.37.0': { changed: ['Cargo.toml.orig'], note: 'Still build-only in this graph; the host-side reasoning of the exclusion stands. No license lines changed.' },
  'cssparser-macros@0.7.1': { changed: ['Cargo.toml.orig', 'lib.rs'], note: 'Still a host-side proc macro whose consumers are build-only; the exclusion reasoning stands. No license lines changed.' },
  'dom_query@0.28.0': { changed: ['Cargo.toml.orig'], note: 'Still build-only; MIT text unchanged.' },
  'selectors@0.38.0': {
    changed: ['Cargo.toml.orig', 'parser.rs'], note: 'Still build-only in this graph; the exclusion reasoning stands. No license lines changed.',
    reason: 'The runtime tauri-utils 2.10.2 instance (under tauri, tauri-runtime and tauri-runtime-wry) has only the features brotli, compression, resources and walkdir; html-manipulation-2 and dom_query belong to the separate build-host instance used by tauri-build, tauri-codegen, tauri-macros and the tauri-plugin build scripts (cargo tree, 2026-10-29). dom_query Matcher parses and matches selectors to DOM nodes; tauri-utils html2 modifies/serializes document content; context_codegen emits CSP hashes and transformed asset bytes through EmbeddedAssets, not the selector matcher or generated selector attribute table. selectors build.rs generates an internal attribute-name PHF consumed by selectors parser.rs; it stays in the host library path. No claim that all build tools are automatically excluded from output.',
  },
  'siphasher@1.0.4': { declared: 'MIT OR Apache-2.0', added: ['LICENSE-APACHE', 'LICENSE-MIT'], note: 'Declaration written in SPDX form (was MIT/Apache-2.0) and the crate now ships LICENSE-APACHE and LICENSE-MIT; COPYING is unchanged and still offers Apache-2.0, so the Apache-2.0 decision with the original notice stands.', external: 'The selected Apache-2.0 text stays the full text from this project\'s LICENSE-APACHE; the crate\'s new LICENSE-APACHE has the same terms in a different layout.' },
  'rfd@0.17.2': { added: ['src/backend/xdg_desktop_portal/window_identifier/LICENSE'], note: 'New MIT text for the XDG desktop portal window identifier, a backend that src/backend.rs compiles for Linux and the BSDs only, and there only without the gtk3 feature; tauri-plugin-dialog enables gtk3, so no build of this app compiles it.' },
  'bitflags@1.3.2': { role: 'outside-selected-windows-tree', note: 'Only bitflags 2 remains in the Windows release graph.' },
  'miniz_oxide@0.8.9': { role: 'build-or-proc-macro-only-in-this-tree', note: 'Now used by build tools only; the runtime uses miniz_oxide 0.9.1. The conservative inclusion stays.' },
  'base64@0.23.1': { new: { selected: 'MIT', texts: ['LICENSE-MIT'] }, note: 'MIT OR Apache-2.0; MIT with the original text, as for base64 0.22.1.' },
  'miniz_oxide@0.9.1': { new: { selected: 'MIT', texts: ['LICENSE-MIT.md'] }, note: 'MIT OR Zlib OR Apache-2.0; license files byte-identical to 0.8.9; MIT as there.' },
  'shake@0.1.0': { new: { selected: 'MIT', texts: ['LICENSE-MIT'] }, note: 'MIT OR Apache-2.0 (RustCrypto); MIT with the original text.' },
  'utf_types@1.0.0': { new: { selected: 'MIT', texts: ['LICENSE-MIT', 'COPYRIGHT'] }, note: 'Apache-2.0 OR MIT; MIT with the original text and the COPYRIGHT notice.' },
  'web-time@1.1.0': { new: { selected: 'MIT', texts: ['LICENSE-MIT'] }, note: 'MIT OR Apache-2.0; MIT with the original text.' },
  'static_vcruntime@3.0.0': { new: { selected: 'MIT', texts: ['LICENSE-MIT'] }, note: 'MIT OR Apache-2.0 OR Zlib, build-only; MIT with the original text, as for other build tools.' },
};

const fail = message => { throw new Error(message); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });
const byKey = (key) => (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

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
    const sameClass = candidates.filter(old => compatClass(versionOf(old)) === compatClass(versionOf(key)));
    if (sameClass.length === 1) { pairs.set(key, sameClass[0]); byName.set(nameOf(key), candidates.filter(old => old !== sameClass[0])); }
    else open.push(key);
  }
  for (const key of open) {
    const candidates = byName.get(nameOf(key)) ?? [];
    if (candidates.length === 1 && open.filter(k => nameOf(k) === nameOf(key)).length === 1) { pairs.set(key, candidates[0]); byName.set(nameOf(key), []); }
  }
  return pairs;
}

// Lists a source tree like release-licenses.mjs (walk): paths relative to the
// package root, sorted.
function walkTree(dir, relative) {
  const result = [];
  const visit = (base, prefix, depth) => {
    ensure(depth <= 32, `Directory nesting limit: ${relative}`);
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path.join(base, entry.name), rel, depth + 1);
      else if (entry.isFile()) result.push(rel);
    }
  };
  visit(path.join(dir, ...relative.split('/')), relative, 0);
  return result.sort();
}

// The notices of a bound source tree: every distinct line naming a copyright,
// an SPDX identifier or a license grant. Code may change; these may not.
const noticeLine = /copyright|spdx-license-identifier|mozilla public license|licensed under/i;
function treeNotices(dir, files) {
  const lines = new Set();
  for (const file of files) for (const line of fs.readFileSync(path.join(dir, ...file.split('/')), 'utf8').split(/\r?\n/)) if (noticeLine.test(line)) lines.add(line.trim());
  return [...lines].sort();
}

// A bound source tree moves when its notices stay the same.
function compareTrees(selection, old, dir) {
  const oldDir = path.join(path.dirname(dir), `${nameOf(old)}-${versionOf(old)}`);
  const trees = [], problems = [];
  for (const tree of (selection.inputs.cargo_trees ?? []).filter(t => t.package === old)) {
    if (!fs.existsSync(path.join(dir, ...tree.path.split('/')))) { problems.push(`tree ${tree.path} is gone`); continue; }
    if (!fs.existsSync(oldDir)) { problems.push(`old source of ${old} is not cached`); continue; }
    const files = walkTree(dir, tree.path);
    const before = treeNotices(oldDir, tree.files.map(f => f.path)), after = treeNotices(dir, files);
    if (JSON.stringify(before) !== JSON.stringify(after)) problems.push(`tree ${tree.path} notices: -${before.filter(l => !after.includes(l)).join(' | ')} +${after.filter(l => !before.includes(l)).join(' | ')}`);
    trees.push({ path: tree.path, files: files.map(f => ({ path: f, ...record(fs.readFileSync(path.join(dir, ...f.split('/')))) })), notices: after.length });
  }
  return { trees, problems };
}

// What changed between the bound files of the old version and the new source.
function compare(selection, old, key, dir, renames) {
  const oldDir = path.join(path.dirname(dir), `${nameOf(old)}-${versionOf(old)}`);
  const bound = selection.inputs.cargo_files.filter(f => f.package === old);
  const facts = { changed: [], gone: [], renamed: [], files: [] };
  for (const file of bound) {
    const newPath = renames?.[file.path] ?? file.path;
    const target = path.join(dir, ...newPath.split('/'));
    if (!fs.existsSync(target)) { facts.gone.push(file.path); continue; }
    const now = record(fs.readFileSync(target));
    if (newPath !== file.path) { if (now.sha256 === file.sha256) facts.renamed.push(file.path); else facts.changed.push(file.path); }
    else if (now.sha256 !== file.sha256) facts.changed.push(file.path);
    facts.files.push({ oldPath: file.path, path: newPath, oldSha256: file.sha256, ...now });
  }
  const boundNew = new Set(facts.files.map(f => f.path));
  const newCandidates = licenseCandidates(dir);
  facts.added = newCandidates.filter(c => !boundNew.has(c) && !(fs.existsSync(oldDir) && licenseCandidates(oldDir).map(p => renames?.[p] ?? p).includes(c)));
  facts.unboundChanged = [];
  if (fs.existsSync(oldDir)) for (const c of licenseCandidates(oldDir)) {
    const n = renames?.[c] ?? c;
    if (boundNew.has(n) || !newCandidates.includes(n)) continue;
    if (digest(fs.readFileSync(path.join(oldDir, ...c.split('/')))) !== digest(fs.readFileSync(path.join(dir, ...n.split('/'))))) facts.unboundChanged.push(c);
  }
  return facts;
}

// Selected texts that are not one of the package's own bound files: a
// repository text, a sibling crate's or a shared one. The byte comparison does
// not cover their source, so their move needs `external` in REVIEWED.
function externalTexts(selection, component, old) {
  const own = new Set(selection.inputs.cargo_files.filter(f => f.package === old).map(f => f.sha256));
  return component.documents.map(id => selection.documents.find(d => d.id === id)).filter(d => !own.has(d.sha256)).map(d => d.file_name);
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
  const result = { moved: [], unchanged: 0, roleChanges: [], newPackages: [], removed: [], newOutside: [], review: [], features: new Map([...roleMap].map(([key, value]) => [key, value.features])), checksums };

  for (const [key, pkg] of packages) {
    const { role, features } = roleMap.get(key);
    const reviewed = REVIEWED[key];
    if (oldPackages.has(key)) {
      const component = components.get(`cargo:${key}`);
      ensure(component, `No component for bound package ${key}`);
      if (oldPackages.get(key).declared_license !== pkg.license) result.review.push({ package: key, problem: 'declared license changed' });
      else if (component.technical_role === role) result.unchanged++;
      else if (reviewed?.role === role) result.roleChanges.push({ key, role, from: component.technical_role, note: reviewed.note });
      else result.review.push({ package: key, problem: `role ${component.technical_role} -> ${role}` });
      continue;
    }
    const old = pairs.get(key);
    const dir = path.dirname(fs.realpathSync(pkg.manifest_path));
    if (!old) {
      if (role === 'outside-selected-windows-tree') result.newOutside.push({ package: key, pkg, role });
      else if (reviewed?.new) {
        ensure(reviewed.new.selected === 'MIT', `${key}: the reasons for new packages state an MIT selection; decide ${reviewed.new.selected} with its own reason`);
        for (const text of reviewed.new.texts) ensure(fs.existsSync(path.join(dir, text)), `${key}: ${text} is missing`);
        result.newPackages.push({ key, pkg, role, features, dir, decision: reviewed.new, note: reviewed.note });
      } else result.review.push({ package: key, problem: `new package (${role}, declared ${pkg.license ?? 'none'})` });
      continue;
    }
    const component = components.get(`cargo:${old}`);
    ensure(component, `No component for bound package ${old}`);
    const oldPackage = oldPackages.get(old);
    const facts = compare(selection, old, key, dir, reviewed?.renames);
    const trees = compareTrees(selection, old, dir);
    if (trees.problems.length > 0) { result.review.push({ package: key, replaces: old, problem: trees.problems.join('; ') }); continue; }
    facts.trees = trees.trees;
    facts.external = externalTexts(selection, component, old);
    const declaredChanged = oldPackage.declared_license !== pkg.license;
    const automatic = component.technical_role === role && !declaredChanged && oldPackage.source === pkg.source
      && facts.changed.length + facts.gone.length + facts.renamed.length + facts.added.length + facts.unboundChanged.length + facts.external.length === 0;
    const matches = reviewed && component.technical_role === role && oldPackage.source === pkg.source && facts.gone.length === 0 && facts.unboundChanged.length === 0
      && same(facts.changed, reviewed.changed ?? []) && same(facts.renamed, Object.keys(reviewed.renames ?? {}).filter(p => facts.files.some(f => f.oldPath === p)))
      && same(facts.added, reviewed.added ?? []) && (declaredChanged ? reviewed.declared === pkg.license : reviewed.declared === undefined)
      && (facts.external.length > 0) === (reviewed.external !== undefined);
    if (!automatic && !matches) {
      const problems = [];
      if (component.technical_role !== role) problems.push(`role ${component.technical_role} -> ${role}`);
      if (declaredChanged) problems.push(`declared license ${oldPackage.declared_license} -> ${pkg.license}`);
      for (const [label, list] of Object.entries({ changed: facts.changed, gone: facts.gone, renamed: facts.renamed, 'new license files': facts.added, 'unbound changed': facts.unboundChanged, 'texts from outside the crate': facts.external })) if (list.length) problems.push(`${label}: ${list.join(',')}`);
      result.review.push({ package: key, replaces: old, problem: problems.join('; ') });
      continue;
    }
    const note = automatic ? null : [reviewed.note, reviewed.external].filter(Boolean).join(' ');
    result.moved.push({ key, old, pkg, role, features, dir, facts, note, reason: automatic ? null : reviewed.reason ?? null, manifest: record(fs.readFileSync(pkg.manifest_path)), oldManifest: oldPackage.manifest, checksum: checksums.get(key) ?? null });
  }
  // Every entry has to decide something in this update; entries of an earlier
  // update go (its record keeps them).
  const decided = new Set([...result.moved.filter(m => m.note).map(m => m.key), ...result.roleChanges.map(r => r.key), ...result.newPackages.map(n => n.key)]);
  for (const key of Object.keys(REVIEWED)) if (!decided.has(key) && !result.review.some(r => r.package === key)) result.review.push({ package: key, problem: 'REVIEWED entry decides nothing in this update' });
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

// The record keeps every new text; release-licenses.mjs reads it like an inventory.
function textStore(selection, recordPath) {
  const blobs = {};
  const fileNames = new Set(selection.documents.map(d => d.file_name.toLowerCase()));
  function documentFor(bytes, key, sourcePath) {
    const sha256 = digest(bytes);
    const existing = selection.documents.find(d => d.sha256 === sha256);
    if (existing) {
      const name = `${key}/${sourcePath}`;
      if (!existing.source_names.includes(name)) existing.source_names.push(name);
      return existing.id;
    }
    const utf8 = Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
    blobs[sha256] = { encoding: utf8 ? 'utf8' : 'base64', bytes: bytes.length, content: bytes.toString(utf8 ? 'utf8' : 'base64') };
    const base = `${nameOf(key)}-${versionOf(key)}-${path.posix.basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    let fileName = /\.(?:txt|md)$/.test(base) ? base : `${base}.txt`;
    for (let n = 2; fileNames.has(fileName.toLowerCase()); n++) fileName = fileName.replace(/(\.(?:txt|md))$/, `-${n}$1`);
    fileNames.add(fileName.toLowerCase());
    selection.documents.push({ id: `sha256:${sha256}`, file_name: fileName, bytes: bytes.length, sha256, sources: [{ kind: 'inventory_blob', path: recordPath, sha256 }], source_names: [`${key}/${sourcePath}`], source_urls: [pageUrl(nameOf(key), versionOf(key))] });
    return `sha256:${sha256}`;
  }
  return { blobs, documentFor };
}

export function apply(root, { selection, toolchain, result, recordPath }, { date }) {
  ensure(result.review.length === 0, `Decisions needed by hand:\n${result.review.map(r => `  ${r.package}${r.replaces ? ` (replaces ${r.replaces})` : ''}: ${r.problem}`).join('\n')}`);
  const outsideReason = selection.components.find(c => c.technical_role === 'outside-selected-windows-tree')?.reason;
  ensure(outsideReason, 'No reviewed reason for packages outside the Windows tree');
  const before = selection.inputs.files.find(f => f.path === 'Cargo.lock');
  const lockNow = record(fs.readFileSync(path.join(root, 'Cargo.lock')));
  const store = textStore(selection, recordPath);

  for (const move of result.moved) {
    const name = move.pkg.name, oldVersion = versionOf(move.old), newVersion = move.pkg.version;
    const component = selection.components.find(c => c.id === `cargo:${move.old}`);
    component.id = `cargo:${move.key}`;
    component.version = newVersion;
    component.declared_license = move.pkg.license;
    component.source_urls = component.source_urls.map(u => replaceVersion(u, name, oldVersion, newVersion));
    component.source_archive = { url: crateUrl(name, newVersion), sha256: move.checksum };
    component.decision_basis = [...component.decision_basis, recordPath];
    // An excluded package outside the tree keeps the exact standard reason,
    // which the macOS and Android derivations recognise; the record has the move.
    if (component.technical_role !== 'outside-selected-windows-tree') component.reason = `${move.reason ?? component.reason} Updated from ${oldVersion} to ${newVersion} on ${date}; ${move.note ?? 'same declared license, role and byte-identical license files.'}`;
    // A document made from a bound file whose bytes changed is made again from the new bytes.
    for (const file of move.facts.files.filter(f => f.sha256 !== f.oldSha256)) {
      const index = component.documents.findIndex(id => selection.documents.find(d => d.id === id)?.sha256 === file.oldSha256);
      if (index >= 0) component.documents[index] = store.documentFor(fs.readFileSync(path.join(move.dir, ...file.path.split('/'))), move.key, file.path);
    }
    const pkg = selection.inputs.cargo_packages.find(p => p.package === move.old);
    pkg.package = move.key;
    pkg.manifest = move.manifest;
    pkg.declared_license = move.pkg.license;
    selection.inputs.cargo_files = selection.inputs.cargo_files.filter(f => f.package !== move.old);
    for (const file of move.facts.files) selection.inputs.cargo_files.push({ package: move.key, path: file.path, bytes: file.bytes, sha256: file.sha256 });
    for (const added of move.facts.added) selection.inputs.cargo_files.push({ package: move.key, path: added, ...record(fs.readFileSync(path.join(move.dir, ...added.split('/')))) });
    if (selection.inputs.cargo_trees) {
      selection.inputs.cargo_trees = selection.inputs.cargo_trees.filter(t => t.package !== move.old);
      for (const tree of move.facts.trees) selection.inputs.cargo_trees.push({ package: move.key, path: tree.path, files: tree.files });
    }
    const renamed = new Map(move.facts.files.map(f => [f.oldPath, f.path]));
    for (const doc of selection.documents) {
      doc.source_names = doc.source_names.map(n => n.startsWith(`${move.old}/`) ? `${move.key}/${renamed.get(n.slice(move.old.length + 1)) ?? n.slice(move.old.length + 1)}` : n);
      doc.source_urls = doc.source_urls.map(u => u === pageUrl(name, oldVersion) ? pageUrl(name, newVersion) : u);
    }
  }
  for (const change of result.roleChanges) {
    const component = selection.components.find(c => c.id === `cargo:${change.key}`);
    component.technical_role = change.role;
    component.decision_basis = [...component.decision_basis, recordPath];
    if (change.role === 'outside-selected-windows-tree') {
      Object.assign(component, { selected_license: null, disposition: 'exclude', release_tree_features: null, documents: [], reason: outsideReason });
      selection.inputs.cargo_files = selection.inputs.cargo_files.filter(f => f.package !== change.key);
    } else component.reason = `${component.reason} Role changed on ${date}: ${change.note}`;
  }
  for (const item of result.newPackages) {
    const documents = item.decision.texts.map(text => store.documentFor(fs.readFileSync(path.join(item.dir, ...text.split('/'))), item.key, text));
    selection.components.push({ id: `cargo:${item.key}`, name: item.pkg.name, version: item.pkg.version, declared_license: item.pkg.license, selected_license: item.decision.selected, disposition: 'include', technical_role: item.role, release_tree_features: item.features, documents, reason: `${item.role === 'normal-runtime-candidate' ? RUNTIME_MIT : BUILD_MIT} ${item.note}`, source_urls: [crateUrl(item.pkg.name, item.pkg.version), pageUrl(item.pkg.name, item.pkg.version), ...(item.pkg.repository ? [item.pkg.repository] : [])], decision_basis: [recordPath], source_archive: { url: crateUrl(item.pkg.name, item.pkg.version), sha256: result.checksums.get(item.key) } });
    selection.inputs.cargo_packages.push({ package: item.key, source: item.pkg.source, manifest: record(fs.readFileSync(item.pkg.manifest_path)), declared_license: item.pkg.license });
    for (const file of licenseCandidates(item.dir)) selection.inputs.cargo_files.push({ package: item.key, path: file, ...record(fs.readFileSync(path.join(item.dir, ...file.split('/')))) });
  }
  for (const item of result.newOutside) {
    selection.components.push({ id: `cargo:${item.package}`, name: item.pkg.name, version: item.pkg.version, declared_license: item.pkg.license, selected_license: null, disposition: 'exclude', technical_role: item.role, release_tree_features: null, documents: [], reason: outsideReason, source_urls: [crateUrl(item.pkg.name, item.pkg.version), pageUrl(item.pkg.name, item.pkg.version)], decision_basis: [recordPath], source_archive: { url: crateUrl(item.pkg.name, item.pkg.version), sha256: result.checksums.get(item.package) } });
    selection.inputs.cargo_packages.push({ package: item.package, source: item.pkg.source, manifest: record(fs.readFileSync(item.pkg.manifest_path)), declared_license: item.pkg.license });
  }
  const gone = new Set(result.removed.map(r => r.package));
  selection.components = selection.components.filter(c => !gone.has(c.id.replace(/^cargo:/, '')));
  selection.inputs.cargo_packages = selection.inputs.cargo_packages.filter(p => !gone.has(p.package));
  selection.inputs.cargo_files = selection.inputs.cargo_files.filter(f => !gone.has(f.package));
  if (selection.inputs.cargo_trees) selection.inputs.cargo_trees = selection.inputs.cargo_trees.filter(t => !gone.has(t.package));
  // Source names of packages that left: kept only where nothing else names the text.
  for (const doc of selection.documents) {
    const kept = doc.source_names.filter(n => !gone.has(n.slice(0, n.indexOf('/'))));
    if (kept.length > 0) doc.source_names = kept;
  }
  const used = new Set(selection.components.flatMap(c => c.documents));
  const droppedDocuments = selection.documents.filter(d => !used.has(d.id)).map(d => d.file_name);
  selection.documents = selection.documents.filter(d => used.has(d.id));
  // A kept document named after a moved version takes the new one; the record
  // lists dropped documents under the names they had.
  for (const move of result.moved) {
    const prefix = `${move.pkg.name}-${versionOf(move.old)}-`;
    for (const doc of selection.documents) if (doc.file_name.startsWith(prefix)) doc.file_name = `${move.pkg.name}-${move.pkg.version}-${doc.file_name.slice(prefix.length)}`;
  }
  const fileNames = selection.documents.map(d => d.file_name.toLowerCase());
  ensure(new Set(fileNames).size === fileNames.length, `Document file names collide: ${fileNames.filter((n, i) => fileNames.indexOf(n) !== i).join(', ')}`);
  // Features follow the new graph for every package (feature unification can
  // change them for an unchanged version too); they describe, they decide nothing.
  for (const c of selection.components) if (c.id.startsWith('cargo:') && result.features.has(c.id.slice(6)) && c.technical_role !== 'outside-selected-windows-tree') c.release_tree_features = result.features.get(c.id.slice(6));

  selection.components.sort(byKey(c => c.id));
  selection.inputs.cargo_packages.sort(byKey(p => p.package));
  selection.inputs.cargo_files.sort(byKey(f => `${f.package}\u0000${f.path}`));
  if (selection.inputs.cargo_trees) selection.inputs.cargo_trees.sort(byKey(t => `${t.package}\u0000${t.path}`));
  selection.documents.sort(byKey(d => d.id));
  if (!selection.decision_reports.includes(recordPath)) selection.decision_reports.push(recordPath);
  selection.scope.historical_evidence = `${selection.scope.historical_evidence} Updated on ${date} for a Cargo.lock update (${recordPath}): ${result.moved.length} packages moved to new versions (${result.moved.filter(m => m.note).length} of them reviewed by hand), ${result.newPackages.length} new packages decided, ${result.roleChanges.length} role changes, ${result.removed.length} packages left the graph, ${result.newOutside.length} new packages outside the Windows tree are excluded.`;

  const evidence = {
    schema_version: 1,
    observed_utc: new Date().toISOString(),
    scope: `Cargo.lock update carried over to the Windows x64 license selection by scripts/release-license-update-cargo.mjs; target ${TARGET}, Rust ${toolchain}, features tauri/custom-protocol. Not final application compliance or installer delivery.`,
    basis: [SELECTION],
    lockfile: { path: 'Cargo.lock', before: before ? { bytes: before.bytes, sha256: before.sha256 } : null, after: lockNow },
    rule: 'A decision moves to a new version without review only when the declared license, the role in the release graph, the set of license-named files and the bytes of every bound file are unchanged and every selected text is one of the package\'s own bound files; the old and new sources are compared from the registry cache. Every other change is listed under reviewed with the reason of its decision.',
    moved: result.moved.map(m => ({ package: m.pkg.name, before: versionOf(m.old), after: m.pkg.version, role: m.role, declared_license: m.pkg.license, archive: { url: crateUrl(m.pkg.name, m.pkg.version), sha256: m.checksum }, manifest: { before: m.oldManifest, after: m.manifest }, bound_files: m.facts.files.map(f => ({ before: f.oldPath, after: f.path, bytes: f.bytes, sha256: f.sha256, unchanged: f.sha256 === f.oldSha256 })), added_files: m.facts.added, ...(m.facts.trees.length ? { source_trees: m.facts.trees.map(t => ({ path: t.path, files: t.files.length, notice_lines: t.notices, notices_unchanged: true })) } : {}), ...(m.note ? { reviewed: m.note } : {}) })),
    role_changes: result.roleChanges.map(r => ({ package: r.key, before: r.from, after: r.role, reviewed: r.note })),
    new_packages: result.newPackages.map(n => ({ package: n.key, role: n.role, declared_license: n.pkg.license, selected_license: n.decision.selected, texts: n.decision.texts, reviewed: n.note })),
    new_outside_tree: result.newOutside.map(n => ({ package: n.package, declared_license: n.pkg.license, decision: 'exclude' })),
    removed: result.removed,
    dropped_documents: droppedDocuments,
    unchanged_packages: result.unchanged,
    decision: 'The reviewed decisions stand for the moved packages; reviewed changes and new packages are decided as recorded here. Removed packages and documents that no component uses any more leave the selection.',
    candidate_texts_by_sha256: store.blobs,
  };
  fs.writeFileSync(path.join(root, recordPath), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(root, SELECTION), `${JSON.stringify(selection, null, 2)}\n`);
  return { written: [recordPath, SELECTION], new_texts: Object.keys(store.blobs).length, dropped_documents: droppedDocuments };
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
    const summary = { moved: result.moved.length, reviewed_moves: result.moved.filter(m => m.note).map(m => m.key), unchanged: result.unchanged, role_changes: result.roleChanges.map(r => r.key), new_packages: result.newPackages.map(n => n.key), removed: result.removed.length, new_outside_tree: result.newOutside.map(n => n.package), review: result.review };
    if (write) Object.assign(summary, apply(root, planned, { date }));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) { console.error(`release-license-update-cargo: ${error.message}`); process.exitCode = 1; }
}
