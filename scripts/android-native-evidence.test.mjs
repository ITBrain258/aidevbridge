import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { differences, parseArgs } from './android-native-evidence.mjs';
import { builtLibraries, committedLibraries, libraryEvidence, NDK_VERSION, TARGETS } from './release-license-select-android.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// llvm-readelf -d and llvm-nm as the NDK prints them, cut down.
const dynamic = (...libs) => [
  'Dynamic section at offset 0xc7e1d0 contains 32 entries:',
  '  Tag                Type         Name/Value',
  ...libs.map(lib => `  0x0000000000000001 (NEEDED)     Shared library: [${lib}]`),
  '  0x000000000000000e (SONAME)     Library soname: [libaidevbridge_lib.so]',
].join('\n');
const SYMBOLS = ['0000000000c3a2f0 t __unw_init_local', '0000000000c80000 d __dso_handle', '                 U malloc'].join('\n');

test('the evidence of a library lists its NEEDED entries sorted and sees libunwind and the CRT', () => {
  const evidence = libraryEvidence(Buffer.from('elf'), dynamic('libm.so', 'libandroid.so', 'libc.so'), SYMBOLS, 'aarch64-linux-android');
  assert.deepEqual(evidence, {
    sha256: crypto.createHash('sha256').update('elf').digest('hex'),
    needed: ['libandroid.so', 'libc.so', 'libm.so'],
    libunwind_linked: true,
    crt_linked: true,
  });
  const bare = libraryEvidence(Buffer.from('elf'), dynamic('libc.so'), '                 U malloc', 'x86_64-linux-android');
  assert.equal(bare.libunwind_linked, false);
  assert.equal(bare.crt_linked, false);
});

test('a library that needs anything but Android system libraries is refused', () => {
  assert.throws(
    () => libraryEvidence(Buffer.from('elf'), dynamic('libc.so', 'libc++_shared.so'), SYMBOLS, 'armv7-linux-androideabi'),
    /armv7-linux-androideabi: unexpected NEEDED libc\+\+_shared\.so/,
  );
});

test('the committed report has a built_library record for each of the three ABIs', () => {
  const libraries = committedLibraries(ROOT);
  assert.deepEqual(Object.keys(libraries), TARGETS);
  for (const target of TARGETS) {
    const library = libraries[target];
    assert.ok(library, target);
    assert.match(library.sha256, /^[0-9a-f]{64}$/, target);
    assert.equal(library.libunwind_linked, true, target);
    assert.equal(library.crt_linked, true, target);
  }
});

const record = (needed = ['libandroid.so', 'libc.so', 'libdl.so', 'liblog.so', 'libm.so']) => ({ sha256: 'a'.repeat(64), needed, libunwind_linked: true, crt_linked: true });

test('only the claims of a library are compared, not its digest', () => {
  const bound = committedLibraries(ROOT);
  const built = { 'aarch64-linux-android': { ...bound['aarch64-linux-android'], sha256: 'b'.repeat(64) } };
  assert.deepEqual(differences(built, bound), []);
  assert.deepEqual(differences({ 'x86_64-linux-android': record(['libc.so']) }, { 'x86_64-linux-android': record() }), [
    'x86_64-linux-android: needed is ["libc.so"], the bound record says ["libandroid.so","libc.so","libdl.so","liblog.so","libm.so"]',
  ]);
  assert.deepEqual(differences({ 'x86_64-linux-android': { ...record(), crt_linked: false } }, { 'x86_64-linux-android': record() }), [
    'x86_64-linux-android: crt_linked is false, the bound record says true',
  ]);
  assert.deepEqual(differences({ 'x86_64-linux-android': record() }, { 'x86_64-linux-android': null }), [
    'x86_64-linux-android: the report has no built_library record',
  ]);
});

function evidenceFile(t, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'native-evidence.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
const allTargets = () => Object.fromEntries(TARGETS.map(target => [target, record(['libm.so', 'libc.so'])]));

test('without an evidence file the derive keeps the committed records', () => {
  const { libraries, source } = builtLibraries(ROOT, null);
  assert.deepEqual(libraries, committedLibraries(ROOT));
  assert.match(source, /^committed records of docs\/release\/license-android-universal-/);
});

test('an evidence file of a release build gives the records of all three ABIs', t => {
  const file = evidenceFile(t, { schema_version: 1, commit: 'abc1234', ndk: NDK_VERSION, targets: allTargets() });
  const { libraries, source } = builtLibraries(ROOT, file);
  assert.deepEqual(Object.keys(libraries), TARGETS);
  assert.deepEqual(libraries['armv7-linux-androideabi'].needed, ['libc.so', 'libm.so']);
  assert.match(source, /\(commit abc1234\)$/);
});

test('an evidence file of a preview build, another NDK or a foreign library is refused', t => {
  const preview = evidenceFile(t, { commit: 'abc', ndk: NDK_VERSION, targets: { 'aarch64-linux-android': record() } });
  assert.throws(() => builtLibraries(ROOT, preview), /lacks armv7-linux-androideabi, x86_64-linux-android: take the evidence of a release build/);
  const ndk = evidenceFile(t, { commit: 'abc', ndk: '28.0.1', targets: allTargets() });
  assert.throws(() => builtLibraries(ROOT, ndk), /NDK 28\.0\.1, expected/);
  const foreign = evidenceFile(t, { commit: 'abc', ndk: NDK_VERSION, targets: { ...allTargets(), 'x86_64-linux-android': record(['libc++_shared.so']) } });
  assert.throws(() => builtLibraries(ROOT, foreign), /x86_64-linux-android: unexpected NEEDED libc\+\+_shared\.so/);
  const broken = evidenceFile(t, { commit: 'abc', ndk: NDK_VERSION, targets: { ...allTargets(), 'x86_64-linux-android': { sha256: 'x' } } });
  assert.throws(() => builtLibraries(ROOT, broken), /x86_64-linux-android is not a built_library record/);
});

test('the arguments name an output file and known targets', () => {
  assert.deepEqual(parseArgs(['--out', 'e.json', 'aarch64-linux-android']), { out: 'e.json', targets: ['aarch64-linux-android'] });
  assert.deepEqual(parseArgs(['aarch64-linux-android', 'x86_64-linux-android', '--out', 'e.json']).targets, ['aarch64-linux-android', 'x86_64-linux-android']);
  assert.throws(() => parseArgs(['aarch64-linux-android']), /Usage/);
  assert.throws(() => parseArgs(['--out', 'e.json']), /Usage/);
  assert.throws(() => parseArgs(['--out', 'e.json', 'aarch64']), /Unknown target aarch64/);
  assert.throws(() => parseArgs(['--out', 'e.json', 'aarch64-linux-android', 'aarch64-linux-android']), /named twice/);
});
