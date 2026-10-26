#!/usr/bin/env node
// Prepare an offline notice directory. This is not an installer or release gate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// One selection per delivered platform. `cargo_targets` are the triples whose
// union `cargo metadata --filter-platform` must reproduce; `label` names the
// application in the generated index. Windows stays the default.
export const PLATFORMS = Object.freeze({
  'windows-x64': Object.freeze({ selection: 'docs/release/license-selection.windows-x64.json', output: 'out/release-notices', target: 'x86_64-pc-windows-msvc', cargo_targets: Object.freeze(['x86_64-pc-windows-msvc']), label: 'Windows x64 application' }),
  'macos-universal': Object.freeze({ selection: 'docs/release/license-selection.macos-universal.json', output: 'out/release-notices-macos', target: 'universal-apple-darwin', cargo_targets: Object.freeze(['aarch64-apple-darwin', 'x86_64-apple-darwin']), label: 'macOS application (Apple silicon and Intel)' }),
});
export const DEFAULT_PLATFORM = 'windows-x64';
const usage = `Usage: node scripts/release-licenses.mjs prepare|check [${Object.keys(PLATFORMS).join('|')}]`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const ordered = values => [...values].sort();
const fail = message => { throw new Error(message); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const html = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function relativeParts(value) {
  requireValue(typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes(':') && !value.includes('\0'), `Unsafe relative path: ${value}`);
  const parts = value.split('/');
  requireValue(parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), `Unsafe relative path: ${value}`);
  return parts;
}

function within(root, relative, { missing = false } = {}) {
  const parts = relativeParts(relative);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info;
    try { info = fs.lstatSync(current); } catch (error) {
      if (missing && error.code === 'ENOENT') return path.join(root, ...parts);
      throw error;
    }
    requireValue(!info.isSymbolicLink(), `Symlink/reparse path is not permitted: ${relative}`);
    if (i < parts.length - 1) requireValue(info.isDirectory(), `Parent is not a directory: ${relative}`);
  }
  return current;
}

function readFile(root, relative) {
  const resolved = within(root, relative);
  requireValue(fs.lstatSync(resolved).isFile(), `Not a regular file: ${relative}`);
  return fs.readFileSync(resolved);
}

function verify(bytes, record, label) {
  requireValue(Number.isSafeInteger(record.bytes) && record.bytes >= 0 && /^[a-f0-9]{64}$/.test(record.sha256), `Invalid hash record: ${label}`);
  requireValue(bytes.length === record.bytes && digest(bytes) === record.sha256, `Input changed or missing: ${label}`);
}

function walk(root, relative) {
  const directory = within(root, relative);
  requireValue(fs.lstatSync(directory).isDirectory(), `Not a directory: ${relative}`);
  const result = [];
  function visit(dir, prefix, depth) {
    requireValue(depth <= 32, `Directory nesting limit: ${relative}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const rel = `${prefix}/${entry.name}`;
      relativeParts(rel);
      const resolved = within(root, rel);
      const stat = fs.lstatSync(resolved);
      if (stat.isDirectory()) visit(resolved, rel, depth + 1);
      else { requireValue(stat.isFile(), `Unsupported entry: ${rel}`); result.push(rel); }
      requireValue(result.length <= 30000, `Directory entry limit: ${relative}`);
    }
  }
  visit(directory, relative, 0);
  return ordered(result);
}

function unique(items, key, label) {
  const keys = items.map(key);
  requireValue(new Set(keys).size === keys.length, `Duplicate ${label}`);
}

function cargoMetadata(root, scope, profile) {
  // Several --filter-platform flags yield the union of their package sets.
  const platforms = profile.cargo_targets.flatMap(target => ['--filter-platform', target]);
  const args = ['run', scope.rust_toolchain, 'cargo', 'metadata', '--locked', '--offline', '--format-version', '1', ...platforms, '--features', scope.cargo_features.join(',')];
  // rustup run (without --install) requires an already installed toolchain.
  const raw = execFileSync('rustup', args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return JSON.parse(raw).packages;
}

function cargoRead(packageRoots, record) {
  const root = packageRoots.get(record.package);
  requireValue(root, `Cargo source is unavailable: ${record.package}`);
  return readFile(root, record.path);
}

function materialize(root, selection, profile, { metadata, requireGenerated = false } = {}) {
  requireValue(selection.schema_version === 1, 'Unsupported license selection schema');
  const scope = selection.scope;
  const targets = scope?.cargo_targets ?? [scope?.target];
  requireValue(scope?.target === profile.target && JSON.stringify(targets) === JSON.stringify(profile.cargo_targets) && scope.default_features === true && JSON.stringify(scope.cargo_features) === '["tauri/custom-protocol"]' && scope.rust_toolchain === '1.97.1', `Target/features/toolchain do not match this ${profile.label} license selection`);
  requireValue(selection.components?.length > 0 && Array.isArray(selection.documents), 'Empty license selection');
  unique(selection.components, x => x.id, 'component');
  unique(selection.documents, x => x.id, 'document');
  unique(selection.documents, x => x.file_name.toLowerCase(), 'output filename');
  unique(selection.documents, x => x.sha256, 'document bytes (use shared references)');
  requireValue(!selection.components.some(x => x.disposition === 'unresolved'), `Unresolved license selection: ${selection.components.filter(x => x.disposition === 'unresolved').map(x => x.id).join(', ')}`);
  requireValue(Array.isArray(selection.pending_delivery) && selection.pending_delivery.length > 0, 'Delivery boundaries must be explicit');

  unique(selection.inputs.files, x => x.path.toLowerCase(), 'input file');
  for (const relative of selection.inputs.absent ?? []) requireValue(!fs.existsSync(within(root, relative, { missing: true })), `Previously absent build configuration appeared: ${relative}`);
  for (const item of selection.inputs.files) verify(readFile(root, item.path), item, item.path);
  for (const tree of selection.inputs.trees) {
    requireValue(tree.availability === undefined || tree.availability === 'generated-by-cargo', `Unknown input availability: ${tree.path}`);
    if (tree.availability === 'generated-by-cargo') {
      // This exact directory is produced by the selected AppManifest command
      // generator. It is absent in Git checkouts, not an optional source tree.
      requireValue(tree.path === 'src-tauri/permissions' && tree.files.length > 0 &&
        (tree.exclude_suffixes ?? []).length === 0 &&
        tree.files.every(item => /^src-tauri\/permissions\/autogenerated\/[a-z0-9_]+\.toml$/.test(item.path)),
      'Only the explicit generated Tauri permissions tree supports pre-Cargo absence');
      const generatedPath = within(root, tree.path, { missing: !requireGenerated });
      if (!requireGenerated && !fs.existsSync(generatedPath)) continue;
    }
    const actual = walk(root, tree.path).filter(p => !(tree.exclude_suffixes ?? []).some(s => p.endsWith(s)));
    requireValue(JSON.stringify(actual) === JSON.stringify(ordered(tree.files.map(x => x.path))), `Input tree changed (added/removed files): ${tree.path}`);
    for (const item of tree.files) verify(readFile(root, item.path), item, item.path);
  }
  const packageRoots = new Map();
  if (selection.inputs.cargo_packages.length > 0) {
    const packages = metadata ?? cargoMetadata(root, scope, profile);
    const identity = p => `${p.package ?? `${p.name}@${p.version}`}|${p.source ?? 'workspace'}`;
    requireValue(JSON.stringify(ordered(packages.map(identity))) === JSON.stringify(ordered(selection.inputs.cargo_packages.map(identity))), 'Cargo package set changed');
    for (const expected of selection.inputs.cargo_packages) {
      const actual = packages.filter(p => `${p.name}@${p.version}` === expected.package && p.source === expected.source);
      requireValue(actual.length === 1, `Cargo package identity changed: ${expected.package}`);
      const manifest = fs.realpathSync(actual[0].manifest_path);
      const packageRoot = path.dirname(manifest);
      packageRoots.set(expected.package, packageRoot);
      verify(readFile(packageRoot, 'Cargo.toml'), expected.manifest, `${expected.package}/Cargo.toml`);
      requireValue(actual[0].license === expected.declared_license, `Cargo license declaration changed: ${expected.package}`);
    }
  }
  for (const item of selection.inputs.cargo_files) verify(cargoRead(packageRoots, item), item, `${item.package}/${item.path}`);
  for (const tree of selection.inputs.cargo_trees ?? []) {
    const packageRoot = packageRoots.get(tree.package);
    requireValue(packageRoot, `Cargo source is unavailable: ${tree.package}`);
    const actual = walk(packageRoot, tree.path);
    requireValue(JSON.stringify(actual) === JSON.stringify(ordered(tree.files.map(x => x.path))), `Cargo source tree changed: ${tree.package}/${tree.path}`);
    for (const item of tree.files) verify(readFile(packageRoot, item.path), item, `${tree.package}/${item.path}`);
  }

  const blobs = new Map();
  function documentBytes(doc) {
    requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:txt|md)$/.test(doc.file_name), `Unsafe document filename: ${doc.file_name}`);
    requireValue(Array.isArray(doc.sources) && doc.sources.length > 0, `Document has no source: ${doc.id}`);
    let selected;
    for (const source of doc.sources) {
      let bytes;
      if (source.kind === 'file') bytes = readFile(root, source.path);
      else if (source.kind === 'inventory_blob') {
        if (!blobs.has(source.path)) blobs.set(source.path, JSON.parse(readFile(root, source.path)).candidate_texts_by_sha256);
        const blob = blobs.get(source.path)?.[source.sha256];
        requireValue(blob && ['utf8', 'base64'].includes(blob.encoding) && typeof blob.content === 'string', `Missing saved license bytes: ${source.sha256}`);
        bytes = Buffer.from(blob.content, blob.encoding === 'utf8' ? 'utf8' : 'base64');
        verify(bytes, { bytes: blob.bytes, sha256: source.sha256 }, source.sha256);
      } else fail(`Unsupported document source: ${source.kind}`);
      verify(bytes, doc, `${doc.id} from ${source.path}`);
      selected = bytes;
    }
    return selected;
  }
  const docs = new Map(selection.documents.map(doc => [doc.id, { ...doc, bytes_value: documentBytes(doc) }]));
  const used = new Set();
  for (const component of selection.components) {
    requireValue(['include', 'exclude'].includes(component.disposition) && component.reason && component.name && component.selected_license !== undefined, `Incomplete component decision: ${component.id}`);
    requireValue(Array.isArray(component.documents), `No document list: ${component.id}`);
    if (component.disposition === 'include') requireValue(component.documents.length > 0, `Included component has no full text/notice: ${component.id}`);
    if (component.disposition === 'exclude') requireValue(component.documents.length === 0, `Excluded component has copied documents: ${component.id}`);
    for (const id of component.documents) { requireValue(docs.has(id), `Unknown document ${id} in ${component.id}`); used.add(id); }
  }
  requireValue(used.size === docs.size, 'Unassigned license documents');
  // Only reviewed local ZIPs are copied. No archive parsing, fetching or build
  // takes place here; their original bytes and provenance are selected inputs.
  const selectedArchives = selection.source_archives === undefined ? [] : selection.source_archives;
  requireValue(Array.isArray(selectedArchives) && selectedArchives.length <= 2, 'Expected at most two selected source ZIPs');
  const archives = new Map(), filenames = new Set();
  for (const item of selectedArchives) {
    requireValue(item.kind === 'source_zip', `Unsupported source archive kind: ${item.kind}`);
    requireValue(typeof item.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(item.id) && !archives.has(item.id), 'Invalid or duplicate source archive ID');
    requireValue(typeof item.file_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(item.file_name), `Unsafe source ZIP filename: ${item.file_name}`);
    relativeParts(item.file_name);
    requireValue(!filenames.has(item.file_name.toLowerCase()), 'Duplicate source ZIP filename');
    filenames.add(item.file_name.toLowerCase());
    requireValue(item.path === `docs/release/sources/${item.file_name}`, `Unexpected source ZIP path: ${item.path}`);
    requireValue(Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= 64 * 1024 * 1024, `Invalid source ZIP size: ${item.id}`);
    requireValue(typeof item.commit === 'string' && /^[a-f0-9]{40}$/.test(item.commit) && typeof item.archive_root === 'string' && relativeParts(item.archive_root).length === 1, `Invalid source ZIP commit/root: ${item.id}`);
    let sourceUrl;
    try { sourceUrl = new URL(item.source_url); } catch { fail(`Invalid source ZIP provenance URL: ${item.id}`); }
    requireValue(sourceUrl.protocol === 'https:' && !sourceUrl.username && !sourceUrl.password, `Invalid source ZIP provenance URL: ${item.id}`);
    requireValue(Array.isArray(item.components) && item.components.length > 0 && item.components.every(id => typeof id === 'string'), `Source ZIP has no component mapping: ${item.id}`);
    unique(item.components, id => id, 'source ZIP component');
    const bytes = readFile(root, item.path);
    verify(bytes, item, item.path);
    archives.set(item.id, { ...item, bytes_value: bytes });
  }
  for (const component of selection.components) {
    const ids = component.source_archives ?? [];
    requireValue(Array.isArray(ids), `Invalid source archive list: ${component.id}`);
    unique(ids, id => id, 'component source archive');
    requireValue(component.disposition === 'include' || ids.length === 0, `Excluded component has source archives: ${component.id}`);
    for (const id of ids) requireValue(archives.get(id)?.components.includes(component.id), `Unknown or mismatched source archive ${id} in ${component.id}`);
  }
  for (const item of archives.values()) for (const id of item.components) {
    const component = selection.components.find(c => c.id === id);
    requireValue(component?.disposition === 'include' && component.source_archives?.includes(item.id), `Unassigned source ZIP ${item.id}: ${id}`);
  }
  let sourceReadme;
  if (archives.size > 0) {
    requireValue(selection.source_readme?.path === 'docs/release/sources/README.txt', 'Selected source ZIPs require the local sources README');
    sourceReadme = readFile(root, selection.source_readme.path);
    verify(sourceReadme, selection.source_readme, selection.source_readme.path);
  } else requireValue(selection.source_readme === undefined, 'Sources README without selected source ZIPs');
  return { docs, archives, sourceReadme };
}

function outputFiles(selection, selectionBytes, profile, { docs, archives, sourceReadme }) {
  const selectionHash = digest(selectionBytes);
  const archiveRecords = [...archives.values()].map(item => ({ id: item.id, kind: item.kind, path: `sources/${item.file_name}`, bytes: item.bytes, sha256: item.sha256, source_url: item.source_url, commit: item.commit, archive_root: item.archive_root, components: item.components }));
  const archiveLinks = ids => ids.map(id => {
    const item = archives.get(id);
    return { id, path: `sources/${item.file_name}`, bytes: item.bytes, sha256: item.sha256 };
  });
  const components = selection.components.map(component => ({ ...component, documents: component.documents.map(id => {
    const doc = docs.get(id);
    return { id, path: `texts/${doc.file_name}`, bytes: doc.bytes, sha256: doc.sha256 };
  }), ...(component.source_archives ? { source_archives: archiveLinks(component.source_archives) } : {}) }));
  const records = selection.documents.map(doc => ({ id: doc.id, path: `texts/${doc.file_name}`, bytes: doc.bytes, sha256: doc.sha256, source_names: doc.source_names, source_urls: doc.source_urls }));
  const sourceRecords = archives.size ? { source_archives: archiveRecords, source_readme: { path: 'sources/README.txt', bytes: sourceReadme.length, sha256: digest(sourceReadme) } } : {};
  const manifest = { schema_version: 1, status: 'notice_directory_only_not_a_release_approval', selection_id: selection.selection_id, selection_sha256: selectionHash, scope: selection.scope, pending_delivery: selection.pending_delivery, components, documents: records, ...sourceRecords };
  const rows = components.map(c => `<tr><td>${html(c.name)} ${html(c.version ?? '')}</td><td>${html(c.disposition)}</td><td>${html(c.selected_license ?? 'Not included')}</td><td>${c.documents.map(d => `<a href="${html(d.path)}">${html(d.path.slice(6))}</a>`).join('<br>')}${(c.source_archives ?? []).map(a => `<br>Source: <a href="${html(a.path)}">${html(a.path.slice(8))}</a>`).join('')}</td><td>${html(c.reason)}${(c.copyright_notices ?? []).map(n => `<p style="white-space:pre-wrap">${html(n.text)} (${html(n.path)}:${html(n.line)})</p>`).join('')}${(c.source_urls ?? []).map(u => `<br><a href="${html(u)}">${html(u)}</a>`).join('')}</td></tr>`).join('\n');
  const sourceSection = archives.size ? `<h2>Offline source archives</h2><p>The following unchanged source ZIPs accompany the explicitly mapped installer components. <a href="sources/README.txt">Offline source guide, provenance and build entry points</a>. These sources do not imply that the upstream binaries have been rebuilt.</p><ul>${archiveRecords.map(a => `<li><a href="${html(a.path)}">${html(a.path.slice(8))}</a> (${html(a.commit)}; SHA-256 ${html(a.sha256)})</li>`).join('')}</ul>` : '';
  const index = `<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>aidevbridge license texts</title>\n<style>body{font:16px system-ui,sans-serif;line-height:1.5;margin:2rem;max-width:110rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.6rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eee}a{color:#0645ad}</style>\n<h1>aidevbridge license texts and notices</h1><p>This folder contains the explicitly selected texts for the ${html(profile.label)} and disclosed build/source families. A listed family is not a claim that every part is present in the executable. Original text bytes are preserved; files with identical hashes are shared without removing component or copyright associations.</p><p>Open the linked local files to read the complete texts offline. External source links are provenance references and are not needed to read these texts. <a href="manifest.json">Machine-readable mapping and SHA-256 values</a>.</p><p><strong>This folder does not prove that an installer, binary release, required terms agreement or source repository has passed release acceptance.</strong></p><h2>Delivery work still pending</h2><ul>${selection.pending_delivery.map(x => `<li>${html(x)}</li>`).join('')}</ul>${sourceSection}<h2>Component mapping</h2><table><thead><tr><th>Component</th><th>Decision</th><th>Selected terms</th><th>Local full texts and notices</th><th>Scope and original sources</th></tr></thead><tbody>\n${rows}\n</tbody></table></html>\n`;
  const files = new Map([
    ['.aidevbridge-release-notices.json', encode({ schema_version: 1, owner: 'aidevbridge-release-licenses', selection_sha256: selectionHash })],
    ['index.html', Buffer.from(index)],
    ['manifest.json', encode(manifest)],
  ]);
  for (const doc of docs.values()) files.set(`texts/${doc.file_name}`, doc.bytes_value);
  for (const item of archives.values()) files.set(`sources/${item.file_name}`, item.bytes_value);
  if (sourceReadme) files.set('sources/README.txt', sourceReadme);
  return files;
}

function compareOutput(root, files, outputPath) {
  const actual = walk(root, outputPath).map(p => p.slice(outputPath.length + 1));
  requireValue(JSON.stringify(actual) === JSON.stringify(ordered(files.keys())), 'Output contains missing, additional or stale files; retained without modification');
  for (const [name, bytes] of files) requireValue(readFile(root, `${outputPath}/${name}`).equals(bytes), `Output differs: ${name}; retained without modification`);
  // Empty unexpected directories are stale output too.
  const dirs = ordered(fs.readdirSync(within(root, outputPath), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name));
  const expectedDirs = files.has('sources/README.txt') ? ['sources', 'texts'] : ['texts'];
  requireValue(JSON.stringify(dirs) === JSON.stringify(expectedDirs) && expectedDirs.every(dir => fs.readdirSync(within(root, `${outputPath}/${dir}`), { withFileTypes: true }).every(x => x.isFile())), 'Output contains unexpected directories');
}

export function releaseLicenses(mode, { root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), metadata, requireGenerated = false, platform = DEFAULT_PLATFORM } = {}) {
  requireValue(mode === 'prepare' || mode === 'check', usage);
  requireValue(Object.hasOwn(PLATFORMS, platform), usage);
  requireValue(typeof requireGenerated === 'boolean', 'requireGenerated must be boolean');
  const profile = PLATFORMS[platform];
  const { selection: selectionPath, output: outputPath } = profile;
  root = fs.realpathSync(root);
  const selectionBytes = readFile(root, selectionPath);
  const selection = JSON.parse(selectionBytes);
  const materialized = materialize(root, selection, profile, { metadata, requireGenerated });
  const files = outputFiles(selection, selectionBytes, profile, materialized);
  const destination = within(root, outputPath, { missing: true });
  if (fs.existsSync(destination)) {
    // Refuse unowned, damaged or old contents. No recursive delete/overwrite.
    const owner = JSON.parse(readFile(root, `${outputPath}/.aidevbridge-release-notices.json`));
    requireValue(owner.owner === 'aidevbridge-release-licenses' && owner.schema_version === 1, 'Output directory is not owned by this helper');
    compareOutput(root, files, outputPath);
  } else {
    requireValue(mode === 'prepare', 'Notice directory does not exist; run prepare first');
    const parent = within(root, 'out', { missing: true });
    if (!fs.existsSync(parent)) fs.mkdirSync(parent);
    requireValue(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(), 'Unsafe out directory');
    fs.mkdirSync(destination); // Exclusive claim; existing directory is never adopted.
    fs.mkdirSync(path.join(destination, 'texts'));
    if (materialized.archives.size) fs.mkdirSync(path.join(destination, 'sources'));
    for (const [name, bytes] of files) {
      const filename = within(root, `${outputPath}/${name}`, { missing: true });
      fs.writeFileSync(filename, bytes, { flag: 'wx' });
    }
    compareOutput(root, files, outputPath);
  }
  return { status: 'notice_directory_verified_not_release_approved', directory: outputPath, components: selection.components.length, texts: materialized.docs.size, source_archives: materialized.archives.size, files: files.size, selection_sha256: digest(selectionBytes), mode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    requireValue(process.argv.length === 3 || process.argv.length === 4, usage);
    console.log(JSON.stringify(releaseLicenses(process.argv[2], { platform: process.argv[3] ?? DEFAULT_PLATFORM })));
  } catch (error) { console.error(`release-licenses: ${error.message}`); process.exitCode = 1; }
}
