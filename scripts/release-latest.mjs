#!/usr/bin/env node
// Wann ein Release die Marke "Latest" bekommt. packages.yml und android.yml
// haengen ihre Pakete getrennt an dasselbe Release; wer zuerst fertig ist,
// legt es an. GitHub wuerde es dabei sofort als "Latest" fuehren, und der
// Download-Link der README zeigt auf /releases/latest: Minuten lang, oder bis
// ein gescheiterter Workflow repariert ist, stuende dort nur die APK oder nur
// die Desktop-Pakete. Darum legen die Workflows das Release mit --latest=false
// an, und jeder fragt nach seinem eigenen Upload dieses Skript, ob das Release
// jetzt alle Pakete seiner Version hat. Erst dann setzt er die Marke.
//
// Die Veroeffentlichungsjobs beider Workflows teilen eine concurrency-Gruppe
// je Tag und laufen darum nacheinander: Der zweite sieht die Dateien des
// ersten und setzt die Marke; ein wiederholter Lauf fuer ein vollstaendiges
// Release setzt sie nach, falls sie noch fehlt. Ein aelteres Release nimmt
// einem neueren die Marke nie weg.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {unknown} condition @param {string} message */
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

// Die Dateien eines vollstaendigen Release, mit den Namen, unter denen die
// Builds sie schreiben: MSI, Setup-EXE und ZIP aus
// release-windows-artifacts.mjs, das Disk-Image aus release-macos-artifacts.mjs
// (artifactName) mit der Datei <dmg>.sha256 daneben (packages.yml,
// release-attach.mjs) und die signierte APK aus dem Job sign von android.yml.
// release-notes.mjs verlangt dieselben Namen; der Test gleicht sie ab.
/**
 * @param {string} version
 * @returns {string[]}
 */
export function expectedAssets(version) {
  ensure(VERSION.test(version), `Invalid version: ${version}`);
  return [
    `aidevbridge-${version}-windows-x64-setup.exe`,
    `aidevbridge-${version}-windows-x64.msi`,
    `aidevbridge-${version}-windows-x64.zip`,
    `aidevbridge-${version}-macos-universal.dmg`,
    `aidevbridge-${version}-macos-universal.dmg.sha256`,
    `aidevbridge-${version}-android.apk`,
  ];
}

// Welche Dateien dem Release noch fehlen. `assets` sind die Assets, wie die
// Release-API sie meldet; nur fertig hochgeladene zaehlen (state "uploaded"),
// ein abgebrochener Upload hinterlaesst eines im Zustand "open".
/**
 * @param {string} version
 * @param {{ name?: unknown, state?: unknown }[]} assets
 * @returns {string[]}
 */
export function missingAssets(version, assets) {
  ensure(Array.isArray(assets), 'The release assets are missing');
  const uploaded = new Set(assets.filter(asset => asset?.state === 'uploaded').map(asset => asset.name));
  return expectedAssets(version).filter(name => !uploaded.has(name));
}

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const x = (VERSION.exec(a) ?? []).slice(1).map(Number), y = (VERSION.exec(b) ?? []).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Ob der Lauf das Release jetzt als "Latest" markiert, mit der Begruendung
// fuer das Protokoll. `release` ist die Antwort von
// GET /repos/{owner}/{repo}/releases/tags/v<version>, `latestTag` der Tag des
// Release, das GitHub gerade als "Latest" fuehrt, oder null, wenn es keines
// gibt.
/**
 * @param {{ version: string, release: { tag_name?: unknown, draft?: unknown, prerelease?: unknown, assets?: any }, latestTag?: string | null }} state
 * @returns {{ latest: boolean, missing: string[], reason: string }}
 */
export function latestDecision({ version, release, latestTag = null }) {
  ensure(VERSION.test(version), `Invalid version: ${version}`);
  const tag = `v${version}`;
  ensure(release && typeof release === 'object' && release.tag_name === tag, `The release data is not that of ${tag}`);
  const missing = missingAssets(version, release.assets);
  /** @param {boolean} latest @param {string} reason */
  const result = (latest, reason) => ({ latest, missing, reason });
  if (missing.length > 0) return result(false, `${tag} is not marked as the latest release yet: it still lacks ${missing.join(', ')}.`);
  if (release.draft || release.prerelease) return result(false, `${tag} has every package, but GitHub cannot mark a draft or pre-release as the latest release.`);
  if (latestTag === tag) return result(false, `${tag} has every package and is the latest release already.`);
  if (latestTag === null) return result(true, `${tag} has every package and becomes the latest release.`);
  const other = /^v(\d+\.\d+\.\d+)$/.exec(latestTag)?.[1];
  if (!other) return result(false, `${tag} has every package, but the latest release ${latestTag} has no version to compare it with: set the latest release by hand.`);
  if (compareVersions(other, version) > 0) return result(false, `${tag} has every package; ${latestTag} is newer and stays the latest release.`);
  return result(true, `${tag} has every package and becomes the latest release instead of ${latestTag}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const usage = 'Usage: node scripts/release-latest.mjs <version> --release <release.json> --latest <latest release.json, {} if there is none> [--output <file for latest=true|false>]';
    const [version, ...rest] = process.argv.slice(2);
    /** @type {Record<string, string>} */
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      ensure(['--release', '--latest', '--output'].includes(rest[i]) && rest[i + 1] && !options[rest[i]], usage);
      options[rest[i]] = rest[i + 1];
    }
    ensure(version && options['--release'] && options['--latest'], usage);
    const release = JSON.parse(fs.readFileSync(options['--release'], 'utf8'));
    const latest = JSON.parse(fs.readFileSync(options['--latest'], 'utf8'));
    ensure(latest && typeof latest === 'object' && (latest.tag_name === undefined || typeof latest.tag_name === 'string'), `${options['--latest']} is not a release`);
    const decision = latestDecision({ version, release, latestTag: latest.tag_name ?? null });
    console.log(decision.reason);
    if (options['--output']) fs.appendFileSync(options['--output'], `latest=${decision.latest}\n`);
  } catch (error) { process.stderr.write(`release-latest: ${/** @type {Error} */ (error).message}\n`); process.exitCode = 1; }
}
