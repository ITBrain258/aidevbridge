#!/usr/bin/env node
// Checks the vendored crates against the security advisories published for
// them. `cargo audit` and Dependabot only match packages with a registry
// source, so a path dependency such as vendor/russh is invisible to both.
// This script reads each vendored version and asks two sources which
// advisories cover it: GitHub's advisory database and the upstream
// repository's own advisories, which can be days ahead of the database. It
// fails when one covers the vendored version or when a source can't be read.
// GITHUB_TOKEN, when set, raises GitHub's rate limit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each vendored crate and the repository that publishes its advisories.
export const VENDORED = [{ crate: 'russh', manifest: 'vendor/russh/Cargo.toml', repository: 'warp-tech/russh' }];

// Advisories that affect a vendored version but not the app, with the reason
// (as SECURITY.md gives it). They are listed but don't fail the check.
export const ACCEPTED = {};

// Splits "0.34.0-beta.1" into numbers and pre-release identifiers; a missing
// minor or patch counts as 0, as in GitHub's ranges ("< 0.65").
function parse(version) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!m) throw new Error(`Unreadable version: ${version}`);
  return { core: [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number), pre: m[4] ? m[4].split('.') : [] };
}

// Semver order: release numbers, then a pre-release before its release.
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
    return numeric ? (Number(p) < Number(q) ? -1 : 1) : (p < q ? -1 : 1);
  }
  return 0;
}

// True when `version` meets every comparator of a GitHub vulnerable range,
// such as "< 0.65" or ">= 0.60.0, <= 0.64.1". A lone version means exactly
// that version. Anything else, such as a missing range or a second part
// without an operator (">= 0.34.0-beta.1,0.61.0" occurs in hand-typed
// repository advisories), is unreadable and throws, so the check fails
// instead of passing a version it cannot judge.
export function inRange(version, range) {
  if (typeof range !== 'string' || !range.trim()) throw new Error(`Unreadable vulnerable range: ${JSON.stringify(range)}`);
  // Read every part before judging any, so a bad part can't hide behind a
  // false one.
  const parts = range.split(',').map(s => s.trim()).map(part => {
    const m = /^(<=|>=|<|>|=)?\s*(\S+)$/.exec(part);
    if (!m) throw new Error(`Unreadable vulnerable range: ${JSON.stringify(range)}`);
    parse(m[2]);
    return { op: m[1], bound: m[2] };
  });
  if (parts.length > 1 && parts.some(p => !p.op)) throw new Error(`Unreadable vulnerable range: ${JSON.stringify(range)}`);
  return parts.every(({ op, bound }) => {
    const c = compareVersions(version, bound);
    return { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '=': c === 0 }[op ?? '='];
  });
}

// Advisories of both sources, reduced to { id, severity, summary, ranges }
// for this crate, one entry per GHSA id. The database's reviewed ranges win;
// a repository's own ranges count only for advisories the database lacks.
export function normalize(crate, globalList, repositoryList) {
  const byId = new Map();
  const ofCrate = (a, ecosystem) => a.vulnerabilities.filter(v => (v.package?.ecosystem ?? ecosystem) === 'rust' && v.package?.name === crate).map(v => v.vulnerable_version_range);
  for (const a of globalList) byId.set(a.ghsa_id, { id: a.ghsa_id, severity: a.severity, summary: a.summary, ranges: [...new Set(ofCrate(a))] });
  for (const a of repositoryList) {
    if (byId.has(a.ghsa_id) || (a.state !== undefined && a.state !== 'published')) continue;
    byId.set(a.ghsa_id, { id: a.ghsa_id, severity: a.severity, summary: a.summary, ranges: [...new Set(ofCrate(a, 'rust'))] });
  }
  return [...byId.values()].filter(a => a.ranges.length > 0);
}

export const affecting = (version, advisories) => advisories.filter(a => a.ranges.some(r => {
  try { return inRange(version, r); } catch (error) { throw new Error(`${a.id}: ${error.message}`); }
}));

export function vendoredVersion(root, manifest) {
  const text = fs.readFileSync(path.join(root, ...manifest.split('/')), 'utf8');
  const pkg = /^\[package\]\s*$([\s\S]*?)(?=^\[)/m.exec(text);
  const version = pkg && /^version\s*=\s*"([^"]+)"/m.exec(pkg[1]);
  if (!version) throw new Error(`No package version in ${manifest}`);
  return version[1];
}

// Every page of a GitHub list, following the Link header.
async function github(url) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const items = [];
  for (let next = url, pages = 0; next; pages++) {
    if (pages >= 20) throw new Error(`${url}: more than 20 pages`);
    const response = await fetch(next, { headers });
    if (!response.ok) throw new Error(`${next}: HTTP ${response.status}`);
    items.push(...await response.json());
    next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
  }
  return items;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let affected = 0;
    for (const { crate, manifest, repository } of VENDORED) {
      const version = vendoredVersion(ROOT, manifest);
      const [globalList, repositoryList] = await Promise.all([
        github(`https://api.github.com/advisories?ecosystem=rust&affects=${encodeURIComponent(crate)}&per_page=100`),
        github(`https://api.github.com/repos/${repository}/security-advisories?state=published&per_page=100`),
      ]);
      const advisories = normalize(crate, globalList, repositoryList);
      const hits = affecting(version, advisories);
      console.log(`${crate} ${version} (${manifest}): ${advisories.length} advisories known, ${hits.length} affect this version`);
      for (const a of hits) console.log(`  ${a.id} (${a.severity}): ${a.summary} [${a.ranges.join('; ')}]${ACCEPTED[a.id] ? ` - accepted: ${ACCEPTED[a.id]}` : ''}`);
      affected += hits.filter(a => !ACCEPTED[a.id]).length;
    }
    if (affected > 0) process.exitCode = 1;
  } catch (error) { console.error(`check-vendored-advisories: ${error.message}`); process.exitCode = 1; }
}
