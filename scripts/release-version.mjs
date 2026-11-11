// scripts/release-version.mjs -- every place that names the release version.
//
// `npm run bump <version>` writes the five version files and the version of
// the own package in the Windows license selection (setSelectionVersion
// below). The macOS and Android selections take it from there through
// `npm run licenses:derive`. The texts of a release (changelog, English
// summary, store notes, the header of docs/stand.md, the supported versions
// in SECURITY.md) are written by hand.
//
// `node scripts/release-version.mjs` lists the places that do not carry the
// version in package.json yet, and exits with 1 if there are any.
// scripts/release-version.test.mjs runs the same check on every push, so a
// release pull request cannot merge with a place left behind.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionCode } from './android-version.mjs';

export const WINDOWS_SELECTION = 'docs/release/license-selection.windows-x64.json';
export const SELECTIONS = [
  WINDOWS_SELECTION,
  'docs/release/license-selection.macos-universal.json',
  'docs/release/license-selection.android-universal.json',
];
export const STORE_LOCALES = ['de-DE', 'en-US'];

/** @param {string} text */
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches `<crate>@<version>` as a whole: not `x<crate>@…`, and a version
 * `0.3.2` does not match inside `0.3.20`.
 * @param {string} crate
 * @param {string} version
 */
const packageRef = (crate, version) => new RegExp(`(?<![\\w-])${escapeRegExp(crate)}@${escapeRegExp(version)}(?![\\w.-])`, 'g');

/**
 * Every `<crate>@<version>` of the own crate in `text`, whatever the version.
 * @param {string} text
 * @param {string} crate
 * @returns {string[]}
 */
const ownRefs = (text, crate) =>
  [...text.matchAll(new RegExp(`(?<![\\w-])${escapeRegExp(crate)}@(\\d+\\.\\d+\\.\\d+[\\w.+-]*)`, 'g'))].map(m => m[1]);

/**
 * Sets the version of the own package from `from` to `to` in the text of a
 * license selection, at the places a release changes: `scope.product_version`,
 * every `"package": "<crate>@…"` (package input, manifest and the documents of
 * the own package), the component id `cargo:<crate>@…` and its `version`.
 * The hashes stay as they are; `npm run licenses:rebind-own` binds the new
 * bytes afterwards.
 *
 * Works on the text, so the formatting stays byte for byte. Throws instead of
 * guessing: if the selection is not at `from`, if a place has an unknown form,
 * or if anything else in the JSON would change.
 *
 * @param {string} text
 * @param {string} crate
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function setSelectionVersion(text, crate, from, to) {
  const before = JSON.parse(text);
  if (before?.scope?.product_version !== from) {
    throw new Error(`scope.product_version is ${JSON.stringify(before?.scope?.product_version)}, expected "${from}"`);
  }
  const own = (before.components ?? []).filter(c => c.id === `cargo:${crate}@${from}`);
  if (own.length !== 1 || own[0].version !== from) {
    throw new Error(`expected one component cargo:${crate}@${from} with version "${from}", found ${own.length}`);
  }
  if (from === to) return text;

  let out = text;
  /**
   * @param {RegExp} pattern global
   * @param {string} replacement
   * @param {(n: number) => boolean} countOk
   * @param {string} what
   */
  const replace = (pattern, replacement, countOk, what) => {
    const n = (out.match(pattern) ?? []).length;
    if (!countOk(n)) throw new Error(`${what}: found ${n} times`);
    out = out.replace(pattern, replacement);
  };
  const f = escapeRegExp(from), c = escapeRegExp(crate);
  replace(new RegExp(`("product_version":\\s*")${f}"`, 'g'), `$1${to}"`, n => n === 1, 'scope.product_version');
  replace(new RegExp(`("package":\\s*"${c}@)${f}"`, 'g'), `$1${to}"`, n => n >= 1, `"package": "${crate}@${from}"`);
  replace(
    new RegExp(`("id":\\s*"cargo:${c}@)${f}(",\\s*"name":\\s*"${c}",\\s*"version":\\s*")${f}"`, 'g'),
    `$1${to}$2${to}"`,
    n => n === 1,
    `component cargo:${crate}@${from} (id, name, version in this order)`,
  );
  const left = (out.match(packageRef(crate, from)) ?? []).length;
  if (left > 0) throw new Error(`${crate}@${from} is left at ${left} place(s) of an unknown form; set them by hand or teach this script`);

  // The JSON must differ from the old one at exactly these places.
  const expected = structuredClone(before);
  expected.scope.product_version = to;
  /** @param {unknown} node */
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const record = /** @type {Record<string, unknown>} */ (node);
    if (record.package === `${crate}@${from}`) record.package = `${crate}@${to}`;
    if (record.id === `cargo:${crate}@${from}`) { record.id = `cargo:${crate}@${to}`; record.version = to; }
    Object.values(record).forEach(walk);
  };
  walk(expected);
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(expected)) {
    throw new Error('the selection would change at more than the version places');
  }
  return out;
}

/**
 * Checks every place that must name the version in package.json.
 * @param {string} root repository root
 * @returns {{ version: string, places: number, problems: string[] }}
 */
export function versionProblems(root) {
  /** @param {string} file */
  const exists = file => fs.existsSync(path.join(root, ...file.split('/')));
  /** @param {string} file */
  const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
  /** @param {string} file */
  const json = file => JSON.parse(read(file));

  const version = json('package.json').version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    return { version, places: 0, problems: [`package.json: version ${JSON.stringify(version)} is not major.minor.patch`] };
  }
  /** @type {string[]} */
  const problems = [];
  let places = 0;
  /**
   * @param {string} place
   * @param {unknown} found
   * @param {string} [wanted]
   */
  const expect = (place, found, wanted = version) => {
    places += 1;
    if (found !== wanted) problems.push(`${place}: ${found === undefined ? 'not found' : JSON.stringify(found)}, expected "${wanted}"`);
  };
  /**
   * @param {string} place
   * @param {string} file
   */
  const expectFile = (place, file) => {
    places += 1;
    if (!exists(file)) problems.push(`${place}: ${file} is missing`);
  };

  // The version files that npm run bump writes.
  const lock = json('package-lock.json');
  expect('package-lock.json: version', lock.version);
  expect('package-lock.json: packages[""].version', lock.packages?.['']?.version);
  expect('src-tauri/tauri.conf.json: version', json('src-tauri/tauri.conf.json').version);
  const cargoToml = read('src-tauri/Cargo.toml');
  const crate = /^name = "([^"]+)"/m.exec(cargoToml)?.[1];
  expect('src-tauri/Cargo.toml: version', /^version = "([^"]+)"/m.exec(cargoToml)?.[1]);
  if (!crate) {
    problems.push('src-tauri/Cargo.toml: no package name');
    return { version, places, problems };
  }
  expect(
    `Cargo.lock: package ${crate}`,
    new RegExp(`^name = "${escapeRegExp(crate)}"\\r?\\nversion = "([^"]+)"`, 'm').exec(read('Cargo.lock'))?.[1],
  );

  // The three license selections: the bump writes the Windows one, derive the others.
  for (const file of SELECTIONS) {
    const text = read(file);
    const selection = JSON.parse(text);
    expect(`${file}: scope.product_version`, selection.scope?.product_version);
    const own = (selection.components ?? []).filter(
      /** @param {{ id?: string, name?: string }} c */ c => c.name === crate && c.id?.startsWith('cargo:'),
    );
    if (own.length !== 1) {
      places += 1;
      problems.push(`${file}: expected one component cargo:${crate}@…, found ${own.length}`);
    } else {
      expect(`${file}: component id`, own[0].id, `cargo:${crate}@${version}`);
      expect(`${file}: component version`, own[0].version);
    }
    const refs = ownRefs(text, crate);
    places += refs.length;
    const other = refs.filter(v => v !== version);
    if (refs.length === 0) problems.push(`${file}: no ${crate}@… at all`);
    if (other.length > 0) problems.push(`${file}: ${other.length} place(s) name ${crate}@${[...new Set(other)].join(', ')}, expected ${version}`);
  }

  // The texts of the release.
  expect('CHANGELOG.md: newest version heading', /^## \[(\d+\.\d+\.\d+)\]/m.exec(read('CHANGELOG.md'))?.[1]);
  expectFile('English summary of the release', `docs/release/notes/${version}.md`);
  const code = versionCode(version);
  for (const locale of STORE_LOCALES) {
    expectFile(`store notes ${locale} (versionCode ${code})`, `fastlane/metadata/android/${locale}/changelogs/${code}.txt`);
  }
  expect('docs/stand.md: header "**Stand:** Version `…`"', /^\*\*Stand:\*\* Version `([^`]+)`/m.exec(read('docs/stand.md'))?.[1]);
  const minor = version.split('.').slice(0, 2).join('.');
  expect(
    'SECURITY.md: supported versions "Latest release (x.y.x)"',
    /^\| Latest release \((\d+\.\d+)\.x\) \| Yes \|\s*$/m.exec(read('SECURITY.md'))?.[1],
    minor,
  );
  return { version, places, problems };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version, places, problems } = versionProblems(root);
  if (problems.length === 0) {
    console.log(`Version ${version}: all ${places} places agree.`);
    return;
  }
  console.error(`Version ${version} (package.json): ${problems.length} place(s) do not agree yet.`);
  for (const problem of problems) console.error(`- ${problem}`);
  console.error('The version files and the Windows selection come from npm run bump, the macOS and Android selections from npm run licenses:derive; the texts are written by hand (CONTRIBUTING.md, Releases).');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
