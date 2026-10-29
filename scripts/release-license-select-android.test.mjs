import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { lockedLibraries, zipEntries, MAVEN, NEW_CRATES, TARGETS } from './release-license-select-android.mjs';

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
  for (const id of ['cargo:cssparser@0.36.0', 'cargo:selectors@0.36.1', 'cargo:dtoa-short@0.3.5']) {
    const component = selection.components.find(c => c.id === id);
    assert.equal(component.disposition, 'include', id);
    assert.equal(component.selected_license, 'MPL-2.0', id);
    assert.match(component.reason, /Source Code Form is available at https:\/\/static\.crates\.io\//, id);
  }
});
