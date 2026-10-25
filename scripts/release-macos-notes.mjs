#!/usr/bin/env node
// The macOS part of a GitHub release text. The release workflow writes it
// between two markers, replacing an earlier macOS part and leaving every other
// line of a hand-written text as it is.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const START = '<!-- aidevbridge:macos:start -->';
export const END = '<!-- aidevbridge:macos:end -->';
const REPOSITORY = 'https://github.com/ITBrain258/aidevbridge';
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export function macosSection({ version, file, sha256, signing }) {
  ensure(/^\d+\.\d+\.\d+$/.test(version), `Invalid version: ${version}`);
  ensure(file === `aidevbridge-${version}-macos-universal.dmg`, `Unexpected file name: ${file}`);
  ensure(/^[a-f0-9]{64}$/.test(sha256), 'Invalid SHA-256');
  ensure(signing === 'ad-hoc' || signing === 'developer-id', `Unknown signing mode: ${signing}`);
  const opening = signing === 'developer-id'
    ? ['- **Signed and notarized.** The app carries a Developer ID signature and Apple\'s notarization, so it opens without a warning.']
    : [
      '- **Not notarized yet.** macOS therefore refuses the first start ("Apple could not verify …"). Check the file first (see below), then open **System Settings** → **Privacy & Security**, choose **Open Anyway** next to the message about aidevbridge and confirm. Alternatively, in Terminal: `xattr -dr com.apple.quarantine /Applications/aidevbridge.app`.',
    ];
  return [
    START,
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
    END,
  ].join('\n');
}

// Replaces the marked part or appends it after a blank line.
export function mergeBody(body, section) {
  ensure(section.startsWith(START) && section.endsWith(END), 'Not a marked macOS section');
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const start = text.indexOf(START), end = text.indexOf(END);
  ensure((start < 0) === (end < 0) && start <= end && text.indexOf(START, start + 1) < 0, 'The release text has a damaged macOS section; repair it by hand');
  if (start >= 0) return `${text.slice(0, start)}${section}${text.slice(end + END.length)}`;
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}

// Text of a release the workflow creates because none exists for the tag yet.
export function newReleaseBody({ version, section }) {
  return mergeBody(`aidevbridge ${version}. All changes: [CHANGELOG](${REPOSITORY}/blob/v${version}/CHANGELOG.md).\n`, section);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    // node scripts/release-macos-notes.mjs <version> <dmg> <sha256> <signing> [<existing body file>]
    const [version, file, sha256, signing, bodyFile, ...rest] = process.argv.slice(2);
    ensure(signing && rest.length === 0, 'Usage: node scripts/release-macos-notes.mjs <version> <dmg file name> <sha256> <ad-hoc|developer-id> [<current release text file>]');
    const section = macosSection({ version, file, sha256, signing });
    process.stdout.write(bodyFile ? mergeBody(fs.readFileSync(bodyFile, 'utf8'), section) : newReleaseBody({ version, section }));
  } catch (error) { process.stderr.write(`release-macos-notes: ${error.message}\n`); process.exitCode = 1; }
}
