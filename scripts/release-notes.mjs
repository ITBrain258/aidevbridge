#!/usr/bin/env node
// The platform parts of a GitHub release text, made from the
// release-manifest.json of each build. The release workflow writes every part
// between its own markers, replaces an earlier part of the same platform and
// leaves every other line of a hand-written text as it is.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'https://github.com/ITBrain258/aidevbridge';
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
export const markers = platform => [`<!-- aidevbridge:${platform}:start -->`, `<!-- aidevbridge:${platform}:end -->`];
const checkVersion = version => ensure(/^\d+\.\d+\.\d+$/.test(version), `Invalid version: ${version}`);
const checkSha = sha256 => ensure(/^[a-f0-9]{64}$/.test(sha256), 'Invalid SHA-256');

export function windowsSection({ version, setup, msi, zip }) {
  checkVersion(version);
  const files = [[setup, '-setup.exe'], [msi, '.msi'], [zip, '.zip']];
  for (const [file, suffix] of files) {
    ensure(file?.path === `aidevbridge-${version}-windows-x64${suffix}`, `Unexpected file name: ${file?.path}`);
    checkSha(file.sha256);
  }
  const [start, end] = markers('windows');
  return [
    start,
    '## Windows',
    '',
    'Windows 10 and 11, x64. All three files contain the same program; pick one.',
    '',
    '| File | What it is |',
    '| --- | --- |',
    `| \`${setup.path}\` | Setup program. Installs for your Windows account, no administrator rights needed. |`,
    `| \`${msi.path}\` | Windows Installer package. Installs for all users and asks for administrator rights. |`,
    `| \`${zip.path}\` | No installation: extract the whole ZIP into a folder and start \`aidevbridge.exe\`. |`,
    '',
    'Both installers download and install Microsoft Edge WebView2 if it is missing; the ZIP expects it to be installed (current Windows 10 and 11 include it).',
    '',
    '- **The packages are not code-signed.** Windows SmartScreen therefore warns with "Windows protected your PC". Check the file first (see below), then choose **More info** → **Run anyway**.',
    '- **Smart App Control blocks it.** If Smart App Control is set to On, Windows does not start unsigned apps such as this one.',
    '- The release workflow installed each package on a fresh Windows runner and started the app.',
    '',
    'SHA-256, from the `release-manifest.json` of the build:',
    '',
    '```text',
    ...files.map(([file]) => `${file.sha256}  ${file.path}`),
    '```',
    '',
    'In PowerShell, `Get-FileHash .\\<file> -Algorithm SHA256` must print the same value (letter case does not matter).',
    end,
  ].join('\n');
}

export function macosSection({ version, file, sha256, signing }) {
  checkVersion(version);
  ensure(file === `aidevbridge-${version}-macos-universal.dmg`, `Unexpected file name: ${file}`);
  checkSha(sha256);
  ensure(signing === 'ad-hoc' || signing === 'developer-id', `Unknown signing mode: ${signing}`);
  const opening = signing === 'developer-id'
    ? ['- **Signed and notarized.** The app carries a Developer ID signature and Apple\'s notarization, so it opens without a warning.']
    : ['- **Not notarized yet.** macOS therefore refuses the first start ("Apple could not verify …"). Check the file first (see below), then open **System Settings** → **Privacy & Security**, choose **Open Anyway** next to the message about aidevbridge and confirm. Alternatively, in Terminal: `xattr -dr com.apple.quarantine /Applications/aidevbridge.app`.'];
  const [start, end] = markers('macos');
  return [
    start,
    '## macOS',
    '',
    'macOS 11 or newer, Apple silicon and Intel: one universal disk image.',
    '',
    '| File | What it is |',
    '| --- | --- |',
    `| \`${file}\` | Disk image. Open it and drag **aidevbridge** onto **Applications**. |`,
    '',
    ...opening,
    '- **Local network.** From macOS 15 on, the app asks once for access to the local network when it connects to a host there. Allow it, or hosts on your network stay unreachable.',
    '- The macOS build has passed an automated installation and start test, not yet a test by hand on a Mac. Please report problems as an issue.',
    '',
    'SHA-256, from the `release-manifest.json` of the build:',
    '',
    '```text',
    `${sha256}  ${file}`,
    '```',
    '',
    `In Terminal, \`shasum -a 256 ~/Downloads/${file}\` must print the same value.`,
    end,
  ].join('\n');
}

// Replaces the marked part of `platform` or appends it after a blank line.
export function mergeSection(body, platform, section) {
  const [START, END] = markers(platform);
  ensure(section.startsWith(START) && section.endsWith(END), `Not a marked ${platform} section`);
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const start = text.indexOf(START), end = text.indexOf(END);
  ensure((start < 0) === (end < 0) && start <= end && text.indexOf(START, start + 1) < 0, `The release text has a damaged ${platform} section; repair it by hand`);
  if (start >= 0) return `${text.slice(0, start)}${section}${text.slice(end + END.length)}`;
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}

// Sections from the manifests of release-windows-artifacts.mjs and release-macos-artifacts.mjs.
export function sections({ version, windows, macos }) {
  const result = [];
  if (windows) {
    ensure(windows.contract?.version === version && windows.status === 'artifacts_built_and_zip_verified', 'The Windows manifest is not a release build of this version');
    const kind = name => windows.artifacts.find(a => a.kind === name) ?? {};
    result.push(['windows', windowsSection({ version, setup: kind('nsis'), msi: kind('msi'), zip: kind('zip') })]);
  }
  if (macos) {
    ensure(macos.contract?.version === version && macos.status === 'artifacts_built_and_verified', 'The macOS manifest is not a release build of this version');
    const dmg = macos.artifacts.find(a => a.kind === 'dmg') ?? {};
    result.push(['macos', macosSection({ version, file: dmg.path, sha256: dmg.sha256, signing: macos.contract.signing?.mode })]);
  }
  ensure(result.length > 0, 'No platform to describe');
  return result;
}

// The release text: the current one, or for a release the workflow creates a
// line with the changelog of its tag; then the platform parts.
export function releaseBody({ version, body, parts }) {
  let text = body ?? `aidevbridge ${version}. All changes: [CHANGELOG](${REPOSITORY}/blob/v${version}/CHANGELOG.md).\n`;
  for (const [platform, section] of parts) text = mergeSection(text, platform, section);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const usage = 'Usage: node scripts/release-notes.mjs <version> [--body <current release text>] [--windows <release-manifest.json>] [--macos <release-manifest.json>]';
    const [version, ...rest] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      ensure(['--body', '--windows', '--macos'].includes(rest[i]) && rest[i + 1] && !options[rest[i]], usage);
      options[rest[i]] = rest[i + 1];
    }
    ensure(version, usage);
    const manifest = file => file && JSON.parse(fs.readFileSync(file, 'utf8'));
    const parts = sections({ version, windows: manifest(options['--windows']), macos: manifest(options['--macos']) });
    process.stdout.write(releaseBody({ version, body: options['--body'] && fs.readFileSync(options['--body'], 'utf8'), parts }));
  } catch (error) { process.stderr.write(`release-notes: ${error.message}\n`); process.exitCode = 1; }
}
