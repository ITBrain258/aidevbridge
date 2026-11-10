import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionCode } from './android-version.mjs';

// Google Play zeigt unter "Neuigkeiten" changelogs/<versionCode>.txt jeder
// Sprache aus fastlane/metadata; fehlt die Datei, nimmt android.yml
// changelogs/default.txt ("Erste Android-Version"), ohne den Tag scheitern zu
// lassen. Darum prueft dieser Test fuer die Version in package.json, dass
// jede Sprache ihre Datei hat, nicht leer und hoechstens 500 Zeichen lang
// (die Grenze von Google Play). versionCode wie Tauri und android.yml:
// major * 1000000 + minor * 1000 + patch (android-version.mjs).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METADATA = path.join(ROOT, 'fastlane', 'metadata', 'android');
const PLAY_LIMIT = 500;

test('versionCode follows the Tauri formula', () => {
  assert.equal(versionCode('0.3.0'), 3000);
  assert.equal(versionCode('0.3.1'), 3001);
  assert.equal(versionCode('0.2.7'), 2007);
  assert.equal(versionCode('1.0.12'), 1000012);
  assert.throws(() => versionCode('0.3'));
  assert.throws(() => versionCode('v0.3.1'));
  assert.throws(() => versionCode('0.3.1-rc.1'));
});

test('every store language has the changelog of the current version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const code = versionCode(pkg.version);
  const locales = fs.readdirSync(METADATA, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(locales.length >= 2, 'expected the store languages under fastlane/metadata/android');
  for (const locale of locales) {
    const file = path.join(METADATA, locale.name, 'changelogs', `${code}.txt`);
    assert.ok(fs.existsSync(file), `${locale.name}: missing changelogs/${code}.txt for ${pkg.version}`);
    const text = fs.readFileSync(file, 'utf8').trim();
    assert.ok(text.length > 0, `${locale.name}: changelogs/${code}.txt is empty`);
    const characters = Array.from(text).length;
    assert.ok(characters <= PLAY_LIMIT, `${locale.name}: changelogs/${code}.txt has ${characters} characters, Google Play takes ${PLAY_LIMIT}`);
  }
});
