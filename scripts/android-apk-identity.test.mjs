import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, badgingPackage, identityProblems } from './android-apk-identity.mjs';
import { versionCode } from './android-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fileURLToPath(new URL('./android-apk-identity.mjs', import.meta.url));

// Der Anfang der Ausgabe von `aapt2 dump badging` (Build-Tools 36.0.0) fuer
// die veroeffentlichte aidevbridge-0.3.1-android.apk, aufgenommen am
// 10.11.2026; es folgen dort weitere application-label-Zeilen.
const BADGING_0_3_1 = [
  "package: name='io.github.itbrain258.aidevbridge' versionCode='3001' versionName='0.3.1' platformBuildVersionName='17' platformBuildVersionCode='37' compileSdkVersion='37' compileSdkVersionCodename='17'",
  "minSdkVersion:'24'",
  "targetSdkVersion:'37'",
  "uses-permission: name='android.permission.INTERNET'",
  "uses-permission: name='android.permission.ACCESS_LOCAL_NETWORK'",
  "uses-permission: name='io.github.itbrain258.aidevbridge.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'",
  "application-label:'aidevbridge'",
  "application-label-de:'aidevbridge'",
  '',
].join('\n');
/** @param {{ name?: string, code?: string, version?: string }} [values] */
const badging = ({ name = PACKAGE_NAME, code = '3001', version = '0.3.1' } = {}) => BADGING_0_3_1
  .replace(`package: name='${PACKAGE_NAME}'`, `package: name='${name}'`).replace("versionCode='3001'", `versionCode='${code}'`).replace("versionName='0.3.1'", `versionName='${version}'`);

test('the package line of aapt2 is read by its exact attribute names, with LF and with CRLF', () => {
  for (const eol of ['\n', '\r\n']) {
    assert.deepEqual(badgingPackage(BADGING_0_3_1.replaceAll('\n', eol)), {
      name: 'io.github.itbrain258.aidevbridge', versionCode: '3001', versionName: '0.3.1',
      platformBuildVersionName: '17', platformBuildVersionCode: '37', compileSdkVersion: '37', compileSdkVersionCodename: '17',
    });
  }
  // uses-permission: name='...' ist nicht der Paketname.
  assert.throws(() => badgingPackage(BADGING_0_3_1.split('\n').slice(1).join('\n')), /exactly one "package:" line.*found 0/);
  assert.throws(() => badgingPackage(''), /found 0/);
  assert.throws(() => badgingPackage(`${BADGING_0_3_1}${BADGING_0_3_1}`), /found 2/);
});

test('the released 0.3.1 APK has the identity of version 0.3.1', () => {
  assert.equal(versionCode('0.3.1'), 3001);
  assert.deepEqual(identityProblems(BADGING_0_3_1, { version: '0.3.1' }), []);
  assert.deepEqual(identityProblems(BADGING_0_3_1.replaceAll('\n', '\r\n'), { version: '0.3.1' }), []);
});

test('another package, version name or version code is reported', () => {
  assert.deepEqual(identityProblems(BADGING_0_3_1, { version: '0.3.2' }), ["versionName is '0.3.1', expected '0.3.2'", "versionCode is '3001', expected '3002'"]);
  assert.deepEqual(identityProblems(badging({ name: 'com.example.other' }), { version: '0.3.1' }), [`name is 'com.example.other', expected '${PACKAGE_NAME}'`]);
  assert.deepEqual(identityProblems(badging({ code: '3010' }), { version: '0.3.1' }), ["versionCode is '3010', expected '3001'"]);
  // platformBuildVersionName='17' ist nicht versionName.
  assert.deepEqual(identityProblems(BADGING_0_3_1.replace(" versionName='0.3.1'", ''), { version: '0.3.1' }), ["versionName is missing, expected '0.3.1'"]);
  assert.throws(() => identityProblems(BADGING_0_3_1, { version: '0.3' }), /Unreadable version/);
});

test('the silent fallback of build.gradle.kts is named as such', () => {
  assert.deepEqual(identityProblems(badging({ code: '1', version: '1.0' }), { version: '0.3.1' }), [
    "versionName is '1.0', expected '0.3.1'",
    "versionCode is '1', expected '3001'",
    'versionCode 1 and versionName 1.0 are the fallback of build.gradle.kts: the build found no tauri.properties',
  ]);
});

/** @param {string} relative */
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

test('the expected package name is the one of the app and of android.yml', () => {
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).identifier, PACKAGE_NAME);
  assert.match(read('src-tauri/gen/android/app/build.gradle.kts'), new RegExp(`^\\s*applicationId = "${PACKAGE_NAME.replaceAll('.', '\\.')}"\\s*$`, 'm'));
  assert.match(read('.github/workflows/android.yml'), new RegExp(`^\\s*PACKAGE_NAME: ${PACKAGE_NAME.replaceAll('.', '\\.')}\\s*$`, 'm'));
});

// Das Programm, wie es der Build-Job aufruft: mit der Datei, in die er die
// Ausgabe von aapt2 schreibt. Es vergleicht mit der Version in package.json.
test('the program accepts the badging of the current version and refuses any other', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { version } = JSON.parse(read('package.json'));
  const file = path.join(dir, 'badging.txt');
  /** @param {string} text */
  const run = text => {
    fs.writeFileSync(file, text);
    return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  };
  const good = run(badging({ code: String(versionCode(version)), version }));
  assert.equal(good.stderr, '');
  assert.equal(good.status, 0);
  assert.equal(good.stdout, `The built APK is ${PACKAGE_NAME}, versionName ${version}, versionCode ${versionCode(version)}, as package.json has it.\n`);
  const fallback = run(badging({ code: '1', version: '1.0' }));
  assert.equal(fallback.status, 1);
  assert.match(fallback.stdout, new RegExp(`^::error::The built APK is not aidevbridge ${version.replaceAll('.', '\\.')}: versionName is '1\\.0', expected '${version.replaceAll('.', '\\.')}'$`, 'm'));
  assert.match(fallback.stdout, /^::error::.*fallback of build\.gradle\.kts/m);
  const empty = run('');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /^android-apk-identity: Expected exactly one "package:" line/);
  const missing = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'none.txt')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^android-apk-identity: /);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 1);
});
