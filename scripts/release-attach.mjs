#!/usr/bin/env node
// Welche Pakete der Veroeffentlichungsjob an das GitHub-Release seines Tags
// haengt. Eine schon veroeffentlichte Datei wird nie durch andere Bytes
// ersetzt; im Zweifel bricht der Lauf ab, statt etwas hochzuladen.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const SHA256 = /^[a-f0-9]{64}$/;
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// groups: je Plattform die Dateien des neuen Baus, { name, sha256, path }.
// assets: die Dateien am Release, { name, digest }, digest "sha256:<hex>"
// oder null (GitHub fuehrt nicht fuer jedes Asset einen digest).
//
// Entschieden wird je Gruppe, weil der Releasetext die Hashes einer Plattform
// als Block nennt:
// - Alle Dateien sind da: die Gruppe bleibt, wie sie ist, auch wenn der neue
//   Bau andere Hashes hat. Ein Neubau desselben Tags ist selten bitgleich,
//   und ein Handlauf, der den Tag nennt, soll trotzdem die fehlende andere
//   Plattform anhaengen koennen. Haben alle genau die Bytes des neuen Baus,
//   schreibt der Lauf ihren Abschnitt im Text noch einmal: Brach ein frueherer
//   Lauf nach dem Hochladen und vor dem Text ab, etwa beim Wiederholen des
//   Publish-Jobs mit denselben Artefakten, fehlten dort sonst ihre Hashes.
// - Keine Datei ist da: die ganze Gruppe wird hochgeladen.
// - Ein Teil ist da: nur wenn jede vorhandene Datei genau die Bytes des neuen
//   Baus hat, kommen die fehlenden dazu. Ein abweichender oder fehlender
//   digest ist ein Konflikt, denn sonst mischte das Release zwei Builds und der
//   neue Text nennte fuer die alte Datei einen falschen Hash. Es gibt keinen
//   Ersatzweg ueber das Herunterladen der Datei.
// Ein Konflikt irgendwo leert den ganzen Plan.
export function attachPlan({ groups, assets }) {
  ensure(Array.isArray(groups) && groups.length > 0, 'No platform group to attach');
  ensure(Array.isArray(assets), 'The release assets are missing');
  const seen = new Set();
  for (const group of groups) {
    ensure(typeof group?.name === 'string' && group.name !== '' && Array.isArray(group.files) && group.files.length > 0, `Platform group without files: ${group?.name}`);
    for (const file of group.files) {
      ensure(typeof file?.name === 'string' && file.name !== '' && path.posix.basename(file.name) === file.name && !file.name.includes('\\'), `Invalid file name: ${file?.name}`);
      ensure(!seen.has(file.name), `Duplicate file name: ${file.name}`);
      ensure(SHA256.test(file.sha256 ?? ''), `Invalid SHA-256 for ${file.name}`);
      ensure(typeof file.path === 'string' && file.path !== '', `No local path for ${file.name}`);
      seen.add(file.name);
    }
  }
  const published = new Map(assets.map(item => [item.name, typeof item.digest === 'string' ? item.digest : null]));
  const upload = [], notes = [], skipped = [], conflicts = [];
  const sameBytes = file => published.get(file.name)?.toLowerCase() === `sha256:${file.sha256}`;
  for (const { name: group, files } of groups) {
    const missing = files.filter(file => !published.has(file.name));
    if (missing.length === 0) {
      skipped.push(group);
      if (files.every(sameBytes)) notes.push(group);
      continue;
    }
    for (const file of files) {
      if (published.has(file.name) && !sameBytes(file)) conflicts.push({ group, name: file.name, sha256: file.sha256, digest: published.get(file.name) });
    }
    upload.push(...missing.map(file => file.path));
    notes.push(group);
  }
  return conflicts.length > 0 ? { upload: [], notes: [], skipped, conflicts } : { upload, notes, skipped, conflicts };
}

// Die Dateien einer Plattform aus ihrem release-manifest.json. Jede lokale
// Datei muss die Bytes haben, die das Manifest nennt, sonst vergliche der Plan
// etwas anderes, als hochgeladen wird. Zum Disk-Image gehoert die Datei
// <dmg>.sha256 mit dem Hash aus dem Manifest; sie steht in keinem Manifest
// und wird hier gehasht.
function manifestGroup(name, manifestFile) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  ensure(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, `${manifestFile} names no artifacts`);
  const dir = path.dirname(manifestFile);
  const files = manifest.artifacts.map(item => ({ name: item.path, sha256: item.sha256, path: path.join(dir, item.path) }));
  if (name === 'macos') {
    for (const item of manifest.artifacts.filter(a => a.kind === 'dmg')) {
      const sidecar = { name: `${item.path}.sha256`, path: path.join(dir, `${item.path}.sha256`) };
      const bytes = fs.readFileSync(sidecar.path);
      ensure(bytes.toString('utf8') === `${item.sha256}  ${item.path}\n`, `${sidecar.path} does not state the hash of the manifest`);
      files.push({ ...sidecar, sha256: sha256Of(bytes) });
    }
  }
  for (const file of files) ensure(sha256Of(fs.readFileSync(file.path)) === file.sha256, `Changed file: ${file.path}`);
  return { name, files, manifest: manifestFile };
}

const ALREADY = { windows: 'The Windows packages are attached already.', macos: 'The macOS disk image is attached already.' };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const usage = 'Usage: node scripts/release-attach.mjs --release <release.json> [--windows <release-manifest.json>] [--macos <release-manifest.json>] --upload-list <file> --notes-args <file>';
    const args = process.argv.slice(2), options = {};
    const known = ['--release', '--windows', '--macos', '--upload-list', '--notes-args'];
    for (let i = 0; i < args.length; i += 2) {
      ensure(known.includes(args[i]) && args[i + 1] && !options[args[i]], usage);
      options[args[i]] = args[i + 1];
    }
    ensure(options['--release'] && options['--upload-list'] && options['--notes-args'] && (options['--windows'] || options['--macos']), usage);
    const release = JSON.parse(fs.readFileSync(options['--release'], 'utf8'));
    ensure(Array.isArray(release.assets) && release.assets.every(a => typeof a?.name === 'string'), `${options['--release']} lists no release assets`);
    const groups = ['windows', 'macos'].filter(name => options[`--${name}`]).map(name => manifestGroup(name, options[`--${name}`]));
    const plan = attachPlan({ groups, assets: release.assets });
    if (plan.conflicts.length > 0) {
      for (const { name, sha256, digest } of plan.conflicts) {
        console.log(`::error::${name} is attached to the release with ${digest ?? 'no digest'}, this build has sha256:${sha256}`);
      }
      const names = plan.conflicts.map(c => c.name).join(', ');
      console.log(`::error::Nothing was attached. The workflow never replaces a published file. If a rebuild is intended, delete ${names} from the release by hand and run it again.`);
      process.exitCode = 1;
    } else {
      for (const group of plan.skipped) console.log(ALREADY[group]);
      const manifests = Object.fromEntries(groups.map(group => [group.name, group.manifest]));
      fs.writeFileSync(options['--upload-list'], plan.upload.map(file => `${file}\n`).join(''));
      fs.writeFileSync(options['--notes-args'], plan.notes.flatMap(group => [`--${group}`, manifests[group]]).map(line => `${line}\n`).join(''));
    }
  } catch (error) { process.stderr.write(`release-attach: ${error.message}\n`); process.exitCode = 1; }
}
