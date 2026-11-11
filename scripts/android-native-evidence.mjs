// scripts/android-native-evidence.mjs -- evidence of the native libraries an
// Android build ships, for the Android license selection.
//
// The selection maps the NDK pieces that the linker copies into
// libaidevbridge_lib.so (libunwind, compiler-rt builtins, the CRT objects) to
// the NDK's NOTICE files, and the library may need only Android system
// libraries. The report records that per ABI as `built_library`
// (docs/release/license-android-universal-2026-10-28.json). android.yml runs
// this script right after the build, while target/<triple>/release/ still
// holds the libraries with their symbols (Gradle strips the copies it packs):
//
//   NDK_HOME=<ndk> node scripts/android-native-evidence.mjs --out <file> <target>...
//
// It writes the records of the built targets to <file> (the artifact
// android-native-evidence) and fails if what a record claims besides its digest
// (NEEDED entries, libunwind and CRT linked) differs from the bound record:
// then the selection no longer describes the build. The digest differs with
// every version and is not compared. The derive takes the file of a release
// build with `--native-evidence <file>`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtLibraryEvidence, committedLibraries, LIBRARY_PROPERTIES, NDK_VERSION, TARGETS, TOOLCHAIN } from './release-license-select-android.mjs';

/**
 * @typedef {{ sha256: string, needed: string[], libunwind_linked: boolean, crt_linked: boolean }} BuiltLibrary
 */

/**
 * What a built library claims differently from its bound record. A missing
 * bound record counts as a difference.
 * @param {Record<string, BuiltLibrary>} built by target
 * @param {Record<string, BuiltLibrary | null>} bound by target
 * @returns {string[]}
 */
export function differences(built, bound) {
  /** @type {string[]} */
  const found = [];
  for (const [target, library] of Object.entries(built)) {
    const record = bound[target];
    if (!record) {
      found.push(`${target}: the report has no built_library record`);
      continue;
    }
    for (const key of LIBRARY_PROPERTIES) {
      const now = JSON.stringify(library[key]), then = JSON.stringify(record[key]);
      if (now !== then) found.push(`${target}: ${key} is ${now}, the bound record says ${then}`);
    }
  }
  return found;
}

/**
 * @param {string[]} args
 * @returns {{ out: string, targets: string[] }}
 */
export function parseArgs(args) {
  const usage = 'Usage: NDK_HOME=<ndk> node scripts/android-native-evidence.mjs --out <file> <target>...';
  const at = args.indexOf('--out');
  const out = at >= 0 ? args[at + 1] : undefined;
  if (!out || out.startsWith('--')) throw new Error(usage);
  const targets = args.filter((_, i) => i !== at && i !== at + 1);
  if (targets.length === 0) throw new Error(usage);
  for (const target of targets) {
    if (!TARGETS.includes(target)) throw new Error(`Unknown target ${target}; the Android targets are ${TARGETS.join(', ')}`);
  }
  if (new Set(targets).size !== targets.length) throw new Error('A target is named twice');
  return { out, targets };
}

function main() {
  const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { out, targets } = parseArgs(process.argv.slice(2));
  /** @type {Record<string, BuiltLibrary>} */
  const built = {};
  for (const target of targets) built[target] = builtLibraryEvidence(root, target);
  const commit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const evidence = { schema_version: 1, commit, ndk: NDK_VERSION, rust_toolchain: TOOLCHAIN, targets: built };
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const [target, library] of Object.entries(built)) {
    console.log(`${target}: sha256 ${library.sha256}, NEEDED ${library.needed.join(' ')}, libunwind ${library.libunwind_linked ? 'linked' : 'not linked'}, CRT ${library.crt_linked ? 'linked' : 'not linked'}`);
  }
  const found = differences(built, committedLibraries(root));
  if (found.length > 0) {
    for (const line of found) console.error(`::error::${line}`);
    console.error('The built libraries no longer match the NDK evidence of the Android license selection. Derive it again with this file: npm run licenses:derive -- --native-evidence <file> (docs/lizenzen-pflegen.md).');
    process.exitCode = 1;
    return;
  }
  console.log(`The ${targets.length} built librar${targets.length === 1 ? 'y matches' : 'ies match'} the bound NDK evidence; written to ${out}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`android-native-evidence: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
