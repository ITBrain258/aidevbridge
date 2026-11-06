// @ts-nocheck -- not yet checked through checkJs (tsconfig.node.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { lockedLibraries, zipEntries, runtimeArchive, sdkLevels, MAVEN, NEW_CRATES, TARGETS } from './release-license-select-android.mjs';

// A ZIP archive with stored (0) and deflated (8) entries, as JAR and AAR files are.
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data, method } of entries) {
    const nameBytes = Buffer.from(name), body = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(method, 10); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body);
    central.push(record, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

test('the ZIP reader returns stored and deflated entries byte for byte', () => {
  const notice = Buffer.from('Jackson NOTICE\n'), license = Buffer.from('Apache License\n'.repeat(50));
  const entries = zipEntries(zip([{ name: 'META-INF/NOTICE', data: notice, method: 0 }, { name: 'META-INF/LICENSE', data: license, method: 8 }]));
  assert.deepEqual([...entries.keys()], ['META-INF/NOTICE', 'META-INF/LICENSE']);
  assert.ok(entries.get('META-INF/NOTICE')().equals(notice));
  assert.ok(entries.get('META-INF/LICENSE')().equals(license));
  assert.throws(() => zipEntries(Buffer.from('not a zip')), /Not a ZIP/);
});

test('the release runtime classpath comes from the lockfile, nothing else', () => {
  const lock = [
    '# This is a Gradle generated file for dependency locking.',
    'androidx.core:core:1.13.1=universalReleaseCompileClasspath,universalReleaseRuntimeClasspath',
    'junit:junit:4.13.2=universalDebugUnitTestRuntimeClasspath',
    'org.jetbrains.kotlin:kotlin-stdlib:2.0.21=arm64ReleaseRuntimeClasspath,universalReleaseRuntimeClasspath',
    'empty=annotationProcessor',
  ].join('\n');
  assert.deepEqual(lockedLibraries(lock), ['androidx.core:core:1.13.1', 'org.jetbrains.kotlin:kotlin-stdlib:2.0.21']);
  assert.throws(() => lockedLibraries('not a lock line'), /Unparsed lockfile line/);
});

test('every library of the committed lockfile has exactly one decision', () => {
  const libraries = lockedLibraries(fs.readFileSync('src-tauri/gen/android/app/gradle.lockfile', 'utf8'));
  assert.deepEqual([...libraries].sort(), Object.keys(MAVEN).sort());
  for (const [coordinate, decision] of Object.entries(MAVEN)) {
    if (decision.redirect) assert.ok(MAVEN[decision.redirect] && !MAVEN[decision.redirect].redirect, `${coordinate} redirects to a library with code`);
    else if (!decision.bom) assert.match(decision.repo, /^https:\/\/github\.com\//, coordinate);
  }
});

test('the committed selection covers the three ABIs and decides every Android-only crate and library', () => {
  const selection = JSON.parse(fs.readFileSync('docs/release/license-selection.android-universal.json', 'utf8'));
  assert.deepEqual(selection.scope.cargo_targets, TARGETS);
  const ids = new Set(selection.components.map(c => c.id));
  for (const key of Object.keys(NEW_CRATES)) assert.ok(ids.has(`cargo:${key}`), key);
  for (const key of Object.keys(MAVEN)) assert.ok(ids.has(`maven:${key}`), key);
  for (const id of ['native:android-ndk-llvm-runtime', 'native:android-ndk-crt', 'native:android-system-libraries']) assert.ok(ids.has(id), id);
  const included = selection.components.filter(c => c.disposition === 'include');
  assert.ok(included.every(c => c.documents.length > 0));
  // By name, not version: the MPL-2.0 crates stay runtime on Android across updates.
  for (const name of ['cssparser', 'selectors', 'dtoa-short']) {
    const component = selection.components.find(c => c.id.startsWith('cargo:') && c.name === name);
    const id = component?.id ?? name;
    assert.ok(component, name);
    assert.equal(component.disposition, 'include', id);
    assert.equal(component.selected_license, 'MPL-2.0', id);
    assert.match(component.reason, /Source Code Form is available at https:\/\/static\.crates\.io\//, id);
  }
});

test('the SDK levels of the selection are the ones the build sets', () => {
  const gradle = fs.readFileSync('src-tauri/gen/android/app/build.gradle.kts', 'utf8');
  const levels = sdkLevels(gradle);
  const selection = JSON.parse(fs.readFileSync('docs/release/license-selection.android-universal.json', 'utf8'));
  assert.deepEqual({ minimum_sdk: selection.scope.minimum_sdk, target_sdk: selection.scope.target_sdk }, levels);
  assert.deepEqual(sdkLevels('    minSdk = 24\n        targetSdk = 37\n'), { minimum_sdk: 24, target_sdk: 37 });
  assert.throws(() => sdkLevels('minSdk = 24\n'), /expected one "targetSdk = <number>", found 0/);
  assert.throws(() => sdkLevels('minSdk = 24\ntargetSdk = 36\ntargetSdk = 37\n'), /found 2/);
});

// Gradle module metadata as AndroidX and Kotlin publish it, cut down to the
// attributes the selection reads.
const variant = (name, attributes, extra = {}) => ({ name, attributes: { 'org.gradle.category': 'library', ...attributes }, ...extra });
const runtimeJvm = { 'org.gradle.usage': 'java-runtime', 'org.jetbrains.kotlin.platform.type': 'jvm' };
const metadataApi = { 'org.gradle.usage': 'kotlin-metadata', 'org.jetbrains.kotlin.platform.type': 'common' };

test('the archive is the one of the Android runtime variant, not a metadata jar or a root aar', () => {
  const kmp = { variants: [
    variant('metadataApiElements', metadataApi, { files: [{ name: 'lib-metadata-1.0.jar' }] }),
    variant('androidRuntimeElements-published', { ...runtimeJvm, 'org.gradle.jvm.environment': 'android' }, { 'available-at': { group: 'g', module: 'lib-android', version: '1.0' } }),
    variant('jvmRuntimeElements-published', { ...runtimeJvm, 'org.gradle.jvm.environment': 'standard-jvm' }, { 'available-at': { group: 'g', module: 'lib-jvm', version: '1.0' } }),
  ] };
  assert.deepEqual(runtimeArchive({ artifact: 'lib', version: '1.0', module: kmp, names: ['lib-metadata-1.0.jar', 'lib-1.0.aar', 'lib-1.0.pom'] }), { archive: null, redirect: 'g:lib-android:1.0' });
  const android = { variants: [variant('releaseRuntimeElements-published', { 'org.gradle.usage': 'java-runtime', 'org.jetbrains.kotlin.platform.type': 'androidJvm' }, { files: [{ name: 'lib-release.aar' }] })] };
  assert.deepEqual(runtimeArchive({ artifact: 'lib-android', version: '1.0', module: android, names: ['lib-release.aar'] }), { archive: 'lib-release.aar', redirect: null });
  const stdlib = { variants: [
    variant('jvmRuntimeElements', runtimeJvm, { files: [{ name: 'kotlin-stdlib-2.2.10.jar' }] }),
    variant('metadataApiElements', metadataApi, { files: [{ name: 'kotlin-stdlib-2.2.10-all.jar' }] }),
  ] };
  assert.deepEqual(runtimeArchive({ artifact: 'kotlin-stdlib', version: '2.2.10', module: stdlib, names: ['kotlin-stdlib-2.2.10-all.jar', 'kotlin-stdlib-2.2.10.jar'] }), { archive: 'kotlin-stdlib-2.2.10.jar', redirect: null });
});

test('without module metadata only <artifact>-<version> counts, and a platform has no archive', () => {
  assert.deepEqual(runtimeArchive({ artifact: 'core', version: '1.0', module: null, names: ['core-1.0-sources.jar', 'core-metadata-1.0.jar', 'core-1.0.aar'] }), { archive: 'core-1.0.aar', redirect: null });
  assert.deepEqual(runtimeArchive({ artifact: 'core', version: '1.0', module: null, names: ['core-1.0.pom'] }), { archive: null, redirect: null });
  const bom = { variants: [variant('apiElements', { 'org.gradle.category': 'platform', 'org.gradle.usage': 'java-runtime' })] };
  assert.deepEqual(runtimeArchive({ artifact: 'bom', version: '1.0', module: bom, names: [] }), { archive: null, redirect: null });
});

test('two equally good runtime variants or a missing file fail', () => {
  const two = { variants: [
    variant('a', { ...runtimeJvm, 'org.gradle.jvm.environment': 'android' }, { files: [{ name: 'a.aar' }] }),
    variant('b', { ...runtimeJvm, 'org.gradle.jvm.environment': 'android' }, { files: [{ name: 'b.aar' }] }),
  ] };
  assert.throws(() => runtimeArchive({ artifact: 'x', version: '1', module: two, names: ['a.aar', 'b.aar'] }), /2 Android runtime variants/);
  assert.throws(() => runtimeArchive({ artifact: 'x', version: '1', module: { variants: [two.variants[0]] }, names: [] }), /not in the Gradle cache/);
});
