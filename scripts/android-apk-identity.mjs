#!/usr/bin/env node
// Prueft, wer die gebaute APK ist. Dateinamen, Releasetext und Store-Eintrag
// nehmen die Version aus package.json und dem Tag; die APK selbst nimmt sie
// aus tauri.properties, das die Tauri-CLI beim Bau erzeugt. Fehlt diese Datei,
// faellt src-tauri/gen/android/app/build.gradle.kts ohne Meldung auf
// versionCode 1 und versionName "1.0" zurueck. Darum fragt der Build-Job von
// android.yml die APK selbst: `aapt2 dump badging` aus den Build-Tools des SDK
// nennt in der Zeile `package:` Paketname, versionCode und versionName, und
// dieses Skript vergleicht sie mit package.json (versionCode nach der Formel
// von Tauri, android-version.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionCode } from './android-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Die Anwendungs-ID: identifier in src-tauri/tauri.conf.json, applicationId in
// build.gradle.kts und PACKAGE_NAME in android.yml (der Test gleicht sie ab).
export const PACKAGE_NAME = 'io.github.itbrain258.aidevbridge';

// Die Attribute der einen Zeile `package: name='...' versionCode='...' ...`
// aus der Ausgabe von `aapt2 dump badging`. Die Schluessel zaehlen genau, damit
// platformBuildVersionName nicht fuer versionName gehalten wird. Unter Windows
// endet jede Zeile der Ausgabe mit CRLF.
/**
 * @param {string} output
 * @returns {Record<string, string>}
 */
export function badgingPackage(output) {
  const found = output.split(/\r?\n/).filter(line => line.startsWith('package:'));
  if (found.length !== 1) throw new Error(`Expected exactly one "package:" line in the aapt2 output, found ${found.length}`);
  return Object.fromEntries([...found[0].matchAll(/\s([A-Za-z][\w-]*)='([^']*)'/g)].map(match => [match[1], match[2]]));
}

// Jede Abweichung der APK von der erwarteten Identitaet als eine Zeile; leer,
// wenn Paketname, versionName und versionCode stimmen.
/**
 * @param {string} output Ausgabe von `aapt2 dump badging`
 * @param {{ version: string, packageName?: string }} expected
 * @returns {string[]}
 */
export function identityProblems(output, { version, packageName = PACKAGE_NAME }) {
  const expected = { name: packageName, versionName: version, versionCode: String(versionCode(version)) };
  const actual = badgingPackage(output);
  const problems = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key, value]) => `${key} is ${actual[key] === undefined ? 'missing' : `'${actual[key]}'`}, expected '${value}'`);
  if (problems.length > 0 && actual.versionCode === '1' && actual.versionName === '1.0') {
    problems.push('versionCode 1 and versionName 1.0 are the fallback of build.gradle.kts: the build found no tauri.properties');
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [file, ...rest] = process.argv.slice(2);
    if (!file || rest.length > 0) throw new Error('Usage: node scripts/android-apk-identity.mjs <output of "aapt2 dump badging <apk>">');
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const output = fs.readFileSync(file, 'utf8');
    const problems = identityProblems(output, { version });
    if (problems.length > 0) {
      for (const problem of problems) console.log(`::error::The built APK is not aidevbridge ${version}: ${problem}`);
      process.exitCode = 1;
    } else {
      const { name, versionName, versionCode: code } = badgingPackage(output);
      console.log(`The built APK is ${name}, versionName ${versionName}, versionCode ${code}, as package.json has it.`);
    }
  } catch (error) { process.stderr.write(`android-apk-identity: ${/** @type {Error} */ (error).message}\n`); process.exitCode = 1; }
}
