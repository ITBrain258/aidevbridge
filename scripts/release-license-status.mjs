#!/usr/bin/env node
// Lists every input of the license selections that no longer matches its
// binding, all at once instead of one error at a time, and sorts it into own
// sources and third-party or evidence inputs (dependencies, lock files,
// vendored code, docs/release). Usage:
//
//   node scripts/release-license-status.mjs              list the drift
//   node scripts/release-license-status.mjs --rebind-own rebind changed, new and deleted own sources
//   node scripts/release-license-status.mjs --check      prepare and check every platform
//   node scripts/release-license-status.mjs --ci         fail on third-party drift only
//
// Own sources are rebound before a release, or with --rebind-own after their
// review; a dependency change needs its license review in the pull request
// that makes it, so --ci fails only on third-party drift and runs the full
// check when nothing has drifted. --rebind-own never touches third-party
// inputs, the own package version or anything outside the bound trees.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORMS, releaseLicenses, walk, cargoMetadata } from './release-licenses.mjs';
import { rebind } from './release-license-rebind.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node scripts/release-license-status.mjs [--rebind-own | --check | --ci]';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = message => { throw new Error(message); };

// Inputs whose change is a dependency or evidence change, not an own edit.
const THIRD_PARTY = [/(^|\/)node_modules\//, /^Cargo\.lock$/, /^package-lock\.json$/, /^src-tauri\/gen\/android\/app\/gradle\.lockfile$/, /^docs\/release\//, /^vendor\//, /^THIRD_PARTY_LICENSES\.md$/];
export const isThirdParty = relative => THIRD_PARTY.some(re => re.test(relative));

const selectionPath = platform => PLATFORMS[platform].selection;
const readSelection = (root, platform) => JSON.parse(fs.readFileSync(path.join(root, ...selectionPath(platform).split('/')), 'utf8'));
// The platforms whose selection exists in this checkout.
export const platformsIn = root => Object.keys(PLATFORMS).filter(platform => fs.existsSync(path.join(root, ...selectionPath(platform).split('/'))));

// null when the file matches its record, else 'missing' or 'changed'.
function state(base, relative, record) {
  const file = path.join(base, ...relative.split('/'));
  if (!fs.existsSync(file)) return 'missing';
  const bytes = fs.readFileSync(file);
  return bytes.length === record.bytes && digest(bytes) === record.sha256 ? null : 'changed';
}

// Every binding of one platform's selection that no longer holds. `metadata`
// replaces `cargo metadata` (tests); `cargo: false` skips the cargo inputs.
export function drift(root, platform, { metadata, cargo = true } = {}) {
  const selection = readSelection(root, platform);
  const found = [];
  const note = (relative, problem, binding, thirdParty = isThirdParty(relative)) => found.push({ platform, path: relative, problem, binding, third_party: thirdParty });
  for (const item of selection.inputs.files) { const s = state(root, item.path, item); if (s) note(item.path, s, 'inputs.files'); }
  for (const relative of selection.inputs.absent ?? []) if (fs.existsSync(path.join(root, ...relative.split('/')))) note(relative, 'appeared', 'inputs.absent');
  for (const tree of selection.inputs.trees) {
    const dir = path.join(root, ...tree.path.split('/'));
    if (tree.availability === 'generated-by-cargo' && !fs.existsSync(dir)) continue;
    const bound = new Map(tree.files.map(f => [f.path, f]));
    const actual = fs.existsSync(dir) ? walk(root, tree.path).filter(p => !(tree.exclude_suffixes ?? []).some(s => p.endsWith(s))) : [];
    for (const relative of actual) {
      const record = bound.get(relative);
      if (!record) note(relative, 'added', `inputs.trees:${tree.path}`);
      else { const s = state(root, relative, record); if (s) note(relative, s, `inputs.trees:${tree.path}`); }
    }
    for (const relative of bound.keys()) if (!actual.includes(relative)) note(relative, 'missing', `inputs.trees:${tree.path}`);
  }
  for (const doc of selection.documents) for (const source of doc.sources) if (source.kind === 'file') { const s = state(root, source.path, doc); if (s) note(source.path, s, `documents:${doc.id}`); }
  for (const item of selection.source_archives ?? []) { const s = state(root, item.path, item); if (s) note(item.path, s, 'source_archives'); }
  if (selection.source_readme) { const s = state(root, selection.source_readme.path, selection.source_readme); if (s) note(selection.source_readme.path, s, 'source_readme'); }
  if (cargo && selection.inputs.cargo_packages.length > 0) found.push(...cargoDrift(root, platform, selection, metadata));
  return found;
}

// The platform's cargo package set and every bound file of each package.
// Registry packages are third-party; path packages are classified by path.
function cargoDrift(root, platform, selection, metadata) {
  const found = [];
  const packages = metadata ?? cargoMetadata(root, selection.scope, PLATFORMS[platform]);
  const actual = new Map(packages.map(p => [`${p.name}@${p.version}`, p]));
  const bound = new Map(selection.inputs.cargo_packages.map(p => [p.package, p]));
  const dirs = new Map();
  // A registry package is named by its key; a path package (the app, vendored
  // crates) by its folder, which also decides whether it is third-party.
  const where = key => {
    const pkg = actual.get(key);
    if (pkg?.source) return { label: `cargo:${key}`, thirdParty: true };
    if (!pkg) return { label: `cargo:${key}`, thirdParty: Boolean(bound.get(key)?.source) };
    const folder = path.relative(root, path.dirname(fs.realpathSync(pkg.manifest_path))).split(path.sep).join('/');
    return { label: folder, thirdParty: isThirdParty(`${folder}/`) };
  };
  const note = (key, file, problem, binding) => { const w = where(key); found.push({ platform, path: file ? `${w.label}/${file}` : w.label, problem, binding, third_party: w.thirdParty, package: key }); };
  for (const key of actual.keys()) if (!bound.has(key)) note(key, null, 'added', 'inputs.cargo_packages');
  for (const [key, expected] of bound) {
    const pkg = actual.get(key);
    if (!pkg) { note(key, null, 'missing', 'inputs.cargo_packages'); continue; }
    const dir = path.dirname(fs.realpathSync(pkg.manifest_path));
    dirs.set(key, dir);
    if (pkg.license !== expected.declared_license) note(key, null, 'license declaration changed', 'inputs.cargo_packages');
    if (state(dir, 'Cargo.toml', expected.manifest)) note(key, 'Cargo.toml', 'changed', 'inputs.cargo_packages');
  }
  for (const file of selection.inputs.cargo_files) {
    const dir = dirs.get(file.package);
    if (!dir) continue;
    const s = state(dir, file.path, file);
    if (s) note(file.package, file.path, s, 'inputs.cargo_files');
  }
  for (const tree of selection.inputs.cargo_trees ?? []) {
    const dir = dirs.get(tree.package);
    if (!dir) continue;
    const boundFiles = new Map(tree.files.map(f => [f.path, f]));
    const files = fs.existsSync(path.join(dir, ...tree.path.split('/'))) ? walk(dir, tree.path) : [];
    for (const relative of files) {
      const record = boundFiles.get(relative);
      if (!record) note(tree.package, relative, 'added', `inputs.cargo_trees:${tree.path}`);
      else { const s = state(dir, relative, record); if (s) note(tree.package, relative, s, `inputs.cargo_trees:${tree.path}`); }
    }
    for (const relative of boundFiles.keys()) if (!files.includes(relative)) note(tree.package, relative, 'missing', `inputs.cargo_trees:${tree.path}`);
  }
  return found;
}

// What --rebind-own may do by itself: a changed own file or document, a new,
// changed or deleted file of an own source tree, and a changed manifest of
// the app's own package. A missing own input, an appeared absent one and a
// new package version (the release version bump) need a decision by hand.
const automatic = d => {
  if (d.binding === 'inputs.files' || d.binding.startsWith('documents:')) return d.problem === 'changed';
  if (d.binding.startsWith('inputs.trees:')) return true;
  return d.binding === 'inputs.cargo_packages' && d.problem === 'changed' && d.path.endsWith('/Cargo.toml');
};

// Rebinds the own drift of every selection: changed files through
// release-license-rebind.mjs, new and deleted files of own source trees in
// the tree lists, the own package manifest in the cargo inputs. Returns what
// it did and what still needs a decision.
export function rebindOwn(root, { metadata, cargo = true } = {}) {
  const all = platformsIn(root).flatMap(platform => drift(root, platform, { metadata: metadata?.[platform], cargo }));
  const own = all.filter(d => !d.third_party);
  const done = own.filter(automatic), manual = own.filter(d => !automatic(d));
  for (const platform of platformsIn(root)) {
    const mine = done.filter(d => d.platform === platform && (d.problem !== 'changed' || d.binding === 'inputs.cargo_packages'));
    if (mine.length === 0) continue;
    const selection = readSelection(root, platform);
    for (const d of mine) {
      if (d.binding === 'inputs.cargo_packages') {
        const bytes = fs.readFileSync(path.join(root, ...d.path.split('/')));
        selection.inputs.cargo_packages.find(p => p.package === d.package).manifest = { bytes: bytes.length, sha256: digest(bytes) };
        continue;
      }
      const tree = selection.inputs.trees.find(t => `inputs.trees:${t.path}` === d.binding);
      if (d.problem === 'added') tree.files.push({ path: d.path, bytes: 0, sha256: '' });
      else tree.files = tree.files.filter(f => f.path !== d.path);
      tree.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    }
    fs.writeFileSync(path.join(root, ...selectionPath(platform).split('/')), encode(selection));
  }
  const paths = [...new Set(done.filter(d => d.problem !== 'missing' && d.binding !== 'inputs.cargo_packages').map(d => d.path))].sort();
  const rebound = paths.length ? rebind(paths, { root, write: true }).changes : [];
  const brief = ({ platform, path: p, problem, binding }) => ({ platform, path: p, problem, binding });
  return { rebound, handled: done.map(brief), manual: manual.map(brief), third_party: all.filter(d => d.third_party).map(brief) };
}

// prepare and check for every platform; an existing notice folder of this
// helper is removed first, anything else at that place stops the run.
export function checkAll(root) {
  return platformsIn(root).map(platform => {
    const out = path.join(root, ...PLATFORMS[platform].output.split('/'));
    if (fs.existsSync(out)) {
      const owner = path.join(out, '.aidevbridge-release-notices.json');
      if (!fs.existsSync(owner) || JSON.parse(fs.readFileSync(owner, 'utf8')).owner !== 'aidevbridge-release-licenses') fail(`${PLATFORMS[platform].output} is not a notice folder of release-licenses.mjs; remove it by hand`);
      fs.rmSync(out, { recursive: true });
    }
    releaseLicenses('prepare', { root, platform });
    const result = releaseLicenses('check', { root, platform });
    return { platform, components: result.components, texts: result.texts, files: result.files };
  });
}

function print(entries, annotate) {
  for (const d of entries) {
    const line = `${d.platform} ${d.third_party ? 'third-party' : 'own'} ${d.problem}: ${d.path} (${d.binding})`;
    console.log(annotate ? `::${d.third_party ? 'error' : 'warning'}::${line}` : line);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !['--rebind-own', '--check', '--ci'].includes(args[0]))) fail(usage);
    const mode = args[0];
    const annotate = mode === '--ci' && process.env.GITHUB_ACTIONS === 'true';
    if (mode === '--rebind-own') {
      const result = rebindOwn(ROOT);
      console.log(JSON.stringify({ rebound: result.rebound.length, handled: result.handled, manual: result.manual, third_party: result.third_party.length }, null, 2));
      if (result.manual.length) console.log('The entries under "manual" need a decision by hand; see docs/lizenzen-pflegen.md.');
      if (result.third_party.length) console.log(`${result.third_party.length} third-party inputs drifted as well; they need their review (docs/lizenzen-pflegen.md).`);
    } else {
      const entries = platformsIn(ROOT).flatMap(platform => drift(ROOT, platform));
      print(entries, annotate);
      const thirdParty = entries.filter(d => d.third_party).length, own = entries.length - thirdParty;
      console.log(`drift: ${thirdParty} third-party, ${own} own`);
      if (mode === '--check' || (mode === '--ci' && entries.length === 0)) {
        if (mode === '--check' && entries.length > 0) fail('Bound inputs drifted; rebind or review them first');
        for (const r of checkAll(ROOT)) console.log(`${r.platform}: check green, ${r.components} components, ${r.texts} texts, ${r.files} files`);
      } else if (mode === '--ci' && own > 0 && thirdParty === 0) console.log('Own sources changed; they are rebound before the next release (npm run licenses:rebind-own). The full check runs once nothing has drifted.');
      if (mode === '--ci' ? thirdParty > 0 : mode === undefined && entries.length > 0) process.exitCode = 1;
    }
  } catch (error) { console.error(`release-license-status: ${error.message}`); process.exitCode = 1; }
}
