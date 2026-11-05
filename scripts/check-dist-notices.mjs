#!/usr/bin/env node
// Checks that the built frontend still carries the license notices of the
// code it bundles. Vite 8 drops comments when it minifies; vite.config.ts
// keeps the legal comments of the JS (`comments.legal`) and puts the CSS
// copyright comments back at the start of each CSS file. Nothing else fails
// when one of them stops working, so `npm run build` runs this check.
// Usage: node scripts/check-dist-notices.mjs [dist directory]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The notices the bundle must carry (THIRD_PARTY_LICENSES.md, section xterm):
// each CSS file starts with the copyright of xterm.css, and the JS keeps the
// MIT headers of the xterm modules.
export const RULES = [
  { kind: 'css', every: true, mustStartWith: '/*!', needles: ['Copyright', 'The xterm.js authors'] },
  { kind: 'js', every: false, needles: ['Copyright', 'The xterm.js authors', '@license MIT'] },
];

/** @param {string} text */
const comments = (text) => text.match(/\/\*[\s\S]*?\*\//g) ?? [];

/**
 * @param {{ name: string, text: string }[]} files the files under dist/assets
 * @returns {string[]} the problems found, empty when every notice is there
 */
export function checkNotices(files) {
  const problems = [];
  for (const rule of RULES) {
    const matching = files.filter((file) => file.name.endsWith(`.${rule.kind}`));
    if (matching.length === 0) {
      problems.push(`no .${rule.kind} file in the build`);
      continue;
    }
    const carries = (file) => comments(file.text).some((comment) => rule.needles.every((needle) => comment.includes(needle)));
    if (rule.every) {
      for (const file of matching) {
        if (rule.mustStartWith && !file.text.startsWith(rule.mustStartWith)) {
          problems.push(`${file.name} does not start with ${rule.mustStartWith}`);
        }
        if (!carries(file)) problems.push(`${file.name} lacks a comment with ${rule.needles.join(', ')}`);
      }
    } else if (!matching.some(carries)) {
      problems.push(`no .${rule.kind} file has a comment with ${rule.needles.join(', ')}`);
    }
  }
  return problems;
}

/** @param {string} dist */
export function readAssets(dist) {
  const assets = path.join(dist, 'assets');
  return fs.readdirSync(assets).sort().map((name) => ({ name, text: fs.readFileSync(path.join(assets, name), 'utf8') }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(process.argv[2] ?? 'dist');
  const files = readAssets(dist);
  const problems = checkNotices(files);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-dist-notices: ${problem}`);
    process.exit(1);
  }
  console.log(`check-dist-notices: license notices present in ${files.length} files`);
}
