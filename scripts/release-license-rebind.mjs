#!/usr/bin/env node
// Rebind hash records of the license selections after a reviewed change.
// It only refreshes bytes/sha256 of the named files; it never decides a
// license, adds a component or reads anything from the network. Every
// existing selection that binds a path is refreshed; `--platform` limits it
// to one. Run `node scripts/release-licenses.mjs check <platform>` afterwards.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORMS } from './release-licenses.mjs';

const usage = `Usage: node scripts/release-license-rebind.mjs [--write] [--add] [--third-party] [--platform=${Object.keys(PLATFORMS).join('|')}] <path>...`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = message => { throw new Error(message); };
const requireValue = (condition, message) => { if (!condition) fail(message); };

function readFile(root, relative) {
  requireValue(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !path.isAbsolute(relative) &&
    relative.split('/').every(p => p && p !== '.' && p !== '..'), `Unsafe relative path: ${relative}`);
  const resolved = path.join(root, ...relative.split('/'));
  const info = fs.lstatSync(resolved);
  requireValue(info.isFile() && !info.isSymbolicLink(), `Not a regular file: ${relative}`);
  return fs.readFileSync(resolved);
}

function refresh(entry, bytes) {
  const before = { bytes: entry.bytes, sha256: entry.sha256 };
  entry.bytes = bytes.length;
  entry.sha256 = digest(bytes);
  return before;
}

export function rebind(paths, { root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), write = false, add = false, thirdParty = false, platform } = {}) {
  requireValue(Array.isArray(paths) && paths.length > 0, usage);
  requireValue(platform === undefined || Object.hasOwn(PLATFORMS, platform), usage);
  root = fs.realpathSync(root);
  const platforms = (platform === undefined ? Object.keys(PLATFORMS) : [platform])
    .filter(name => platform !== undefined || fs.existsSync(path.join(root, ...PLATFORMS[name].selection.split('/'))));
  requireValue(platforms.length > 0, 'No license selection found');
  requireValue(!add || platforms.length === 1, '--add needs --platform while several selections exist');
  const selections = platforms.map(name => ({ platform: name, path: PLATFORMS[name].selection, selection: JSON.parse(readFile(root, PLATFORMS[name].selection)), changed: false }));
  const changes = [];
  for (const relative of paths) {
    const bytes = readFile(root, relative);
    requireValue(thirdParty || !relative.split('/').includes('node_modules'),
      `${relative} belongs to a dependency; review its new version, then pass --third-party`);
    let bound = false;
    for (const target of selections) {
      const found = rebindOne(target.selection, relative, bytes, add);
      bound ||= found.bound;
      for (const change of found.changes) changes.push({ platform: target.platform, ...change });
      target.changed ||= found.changes.length > 0;
    }
    requireValue(bound, `Not bound by the license selection: ${relative}`);
  }
  if (write) for (const target of selections) if (target.changed) fs.writeFileSync(path.join(root, ...target.path.split('/')), encode(target.selection));
  return { written: write && changes.length > 0, changes };
}

// Refreshes every record of one selection that binds `relative`. `bound` is
// false when this selection does not know the path; the caller decides.
function rebindOne(selection, relative, bytes, add) {
  const found = [], changes = [];
  for (const entry of selection.inputs.files) if (entry.path === relative) found.push({ binding: 'inputs.files', entry });
  for (const tree of selection.inputs.trees) {
    if (!relative.startsWith(`${tree.path}/`) || (tree.exclude_suffixes ?? []).some(s => relative.endsWith(s))) continue;
    const entry = tree.files.find(x => x.path === relative);
    requireValue(entry, `${relative} is not listed in tree ${tree.path}; a new file in a bound tree needs a reviewed tree entry`);
    found.push({ binding: `inputs.trees:${tree.path}`, entry });
  }
  const documents = selection.documents.filter(doc => doc.sources.some(s => s.kind === 'file' && s.path === relative));
  if (found.length === 0 && documents.length === 0 && add) {
    const entry = { path: relative, bytes: 0, sha256: '' };
    selection.inputs.files.push(entry);
    selection.inputs.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    found.push({ binding: 'inputs.files (added)', entry });
  }
  for (const { binding, entry } of found) {
    const before = refresh(entry, bytes);
    if (before.sha256 !== entry.sha256) changes.push({ path: relative, binding, before, after: { bytes: entry.bytes, sha256: entry.sha256 } });
  }
  for (const doc of documents) {
    requireValue(doc.sources.length === 1, `Document ${doc.id} has several sources; rebind it by hand`);
    const oldId = doc.id;
    const before = refresh(doc, bytes);
    if (before.sha256 === doc.sha256) continue;
    if (oldId === `sha256:${before.sha256}`) {
      doc.id = `sha256:${doc.sha256}`;
      requireValue(!selection.documents.some(other => other !== doc && other.id === doc.id), `Another document already has the bytes of ${relative}`);
      for (const component of selection.components) component.documents = component.documents.map(id => id === oldId ? doc.id : id);
    }
    changes.push({ path: relative, binding: `documents:${oldId}`, before, after: { bytes: doc.bytes, sha256: doc.sha256, id: doc.id } });
  }
  return { bound: found.length > 0 || documents.length > 0, changes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const flags = new Set(args.filter(a => a.startsWith('--') && !a.startsWith('--platform=')));
    for (const flag of flags) requireValue(['--write', '--add', '--third-party'].includes(flag), usage);
    const platforms = args.filter(a => a.startsWith('--platform=')).map(a => a.slice('--platform='.length));
    requireValue(platforms.length <= 1, usage);
    const result = rebind(args.filter(a => !a.startsWith('--')), { write: flags.has('--write'), add: flags.has('--add'), thirdParty: flags.has('--third-party'), platform: platforms[0] });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`release-license-rebind: ${error.message}`); process.exitCode = 1; }
}
