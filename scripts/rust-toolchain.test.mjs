import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// rust-toolchain.toml legt die Rust-Version fest, aber sie steht noch an
// vielen anderen Stellen: als TOOLCHAIN in den Release-Skripten (der
// Windows-Bau setzt damit RUSTUP_TOOLCHAIN und uebergeht die Toolchain-Datei),
// in den Lizenzauswahlen, in den dtolnay-Pins der Workflows und in der
// Anleitung. Dieser Test liest alle diese Stellen nur als Text, importiert
// keines der Skripte und meldet jede, die von rust-toolchain.toml abweicht.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = '.github/workflows';
const DTOLNAY = 'dtolnay/rust-toolchain@';

// Genau eine TOOLCHAIN-Konstante je Release-Skript.
const TOOLCHAIN_CONSTANT = { pattern: /^(?:export )?const TOOLCHAIN = '([^']+)';/m, count: 1 };
const LICENSE_SCOPE = { json: ['scope', 'rust_toolchain'] };
const RULES = {
  'scripts/release-windows-artifacts.mjs': [TOOLCHAIN_CONSTANT],
  'scripts/release-macos-artifacts.mjs': [TOOLCHAIN_CONSTANT],
  'scripts/release-license-select-macos.mjs': [TOOLCHAIN_CONSTANT],
  'scripts/release-license-select-android.mjs': [TOOLCHAIN_CONSTANT],
  'scripts/release-licenses.mjs': [{ pattern: /scope\.rust_toolchain === '([^']+)'/g, min: 1 }],
  'docs/release/license-selection.windows-x64.json': [LICENSE_SCOPE],
  'docs/release/license-selection.macos-universal.json': [LICENSE_SCOPE],
  'docs/release/license-selection.android-universal.json': [LICENSE_SCOPE],
  '.github/dependabot.yml': [{ pattern: /Branches (\d+\.\d+\.\d+)/g }],
  'docs/guide/building.md': [
    { pattern: /^- Rust (\d+\.\d+\.\d+)\./m, min: 1 },
    { pattern: /--toolchain (\d+\.\d+\.\d+)/g, min: 1 },
  ],
};
// Fuer jede Datei unter .github/workflows: Jede Zeile mit dem dtolnay-Pin muss
// Commit und Versionskommentar tragen, und jede Erwaehnung "Rust x.y.z" zaehlt.
const WORKFLOW_RULES = [
  { marker: DTOLNAY, pattern: /dtolnay\/rust-toolchain@([0-9a-f]{40}) # (\S+)\s*$/ },
  { pattern: /\bRust (\d+\.\d+\.\d+)\b/g },
];

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const where = mention => (mention.line ? `${mention.file}:${mention.line}` : mention.file);

// Alle Versionsangaben einer Datei nach ihren Regeln, als { file, line,
// value } (bei einem dtolnay-Pin dazu sha), und als errors jede Pflichtstelle,
// die fehlt, doppelt ist oder nicht die erwartete Form hat. CRLF zaehlt wie LF.
function toolchainMentions(name, text, rules) {
  const normal = text.replaceAll('\r\n', '\n');
  const mentions = [];
  const errors = [];
  for (const rule of rules) {
    if (rule.json) {
      let value;
      try {
        value = rule.json.reduce((node, key) => node?.[key], JSON.parse(normal));
      } catch (error) {
        errors.push(`${name}: not valid JSON (${error.message})`);
        continue;
      }
      if (typeof value !== 'string') {
        errors.push(`${name}: ${rule.json.join('.')} is missing`);
        continue;
      }
      const index = normal.indexOf(`"${rule.json.at(-1)}"`);
      mentions.push({ file: name, line: index < 0 ? undefined : lineAt(normal, index), value });
    } else if (rule.marker) {
      normal.split('\n').forEach((content, index) => {
        if (!content.includes(rule.marker)) return;
        const match = rule.pattern.exec(content);
        if (match) mentions.push({ file: name, line: index + 1, value: match[2], sha: match[1] });
        else errors.push(`${name}:${index + 1}: ${rule.marker} is not pinned as "<40-hex commit> # <version>": ${content.trim()}`);
      });
    } else {
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
      const found = [...normal.matchAll(new RegExp(rule.pattern.source, flags))];
      for (const match of found) mentions.push({ file: name, line: lineAt(normal, match.index), value: match[1] });
      const min = rule.count ?? rule.min ?? 0;
      const max = rule.count ?? Infinity;
      if (found.length < min || found.length > max) {
        const expected = rule.count !== undefined ? `exactly ${rule.count}` : `at least ${min}`;
        errors.push(`${name}: expected ${expected} match(es) of ${rule.pattern}, found ${found.length}`);
      }
    }
  }
  return { mentions, errors };
}

// Jede Abweichung als eine Zeile: fehlende Pflichtstellen, jede Version
// ungleich channel und jeder dtolnay-Pin auf einem anderen Commit als die
// meisten Pins.
function deviations(channel, results) {
  const problems = results.flatMap(result => result.errors);
  const mentions = results.flatMap(result => result.mentions);
  for (const mention of mentions) {
    if (mention.value !== channel) problems.push(`${where(mention)}: found ${mention.value}, expected ${channel}`);
  }
  const pins = mentions.filter(mention => mention.sha);
  const counts = new Map();
  for (const pin of pins) counts.set(pin.sha, (counts.get(pin.sha) ?? 0) + 1);
  const [common] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  for (const pin of pins) {
    if (pin.sha !== common) problems.push(`${where(pin)}: ${DTOLNAY.slice(0, -1)} commit ${pin.sha}, expected ${common} like the other pins`);
  }
  return problems;
}

const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');

function readChannel() {
  const match = /^channel\s*=\s*"([^"]+)"/m.exec(read('rust-toolchain.toml'));
  assert.ok(match, 'rust-toolchain.toml has no channel = "..." line');
  return match[1];
}

function repositoryMentions() {
  const results = [];
  const scan = (relative, rules) => {
    if (fs.existsSync(path.join(ROOT, ...relative.split('/')))) results.push(toolchainMentions(relative, read(relative), rules));
    else results.push({ mentions: [], errors: [`${relative}: file is missing`] });
  };
  for (const [relative, rules] of Object.entries(RULES)) scan(relative, rules);
  const workflows = fs.readdirSync(path.join(ROOT, ...WORKFLOWS.split('/'))).filter(name => /\.ya?ml$/.test(name)).sort();
  for (const name of workflows) scan(`${WORKFLOWS}/${name}`, WORKFLOW_RULES);
  // Ohne einen einzigen Pin wuerde der Abgleich der Workflows nichts pruefen.
  if (!results.some(result => result.mentions.some(mention => mention.sha))) {
    results.push({ mentions: [], errors: [`${WORKFLOWS}: no ${DTOLNAY.slice(0, -1)} pin found`] });
  }
  return results;
}

test('rust-toolchain.toml pins an exact Rust version', () => {
  // Ein Kanal wie stable oder 1.97 wuerde jeden Abgleich unten aushebeln.
  assert.match(readChannel(), /^\d+\.\d+\.\d+$/);
});

test('every pinned Rust version matches rust-toolchain.toml', () => {
  const channel = readChannel();
  const problems = deviations(channel, repositoryMentions());
  assert.equal(problems.length, 0, `Rust version pins disagree with rust-toolchain.toml (${channel}):\n${problems.join('\n')}`);
});

// Die Selbsttests zeigen mit synthetischem Text, dass der Abgleich beisst.
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const workflow = (sha, version) => `jobs:\n  rust:\n    steps:\n      - uses: ${DTOLNAY}${sha} # ${version}\n`;

test('the check passes when every place names the channel, with LF and with CRLF', () => {
  const files = [
    ['script.mjs', "import x from 'y';\nexport const TOOLCHAIN = '1.97.1';\n", [TOOLCHAIN_CONSTANT]],
    ['ci.yml', workflow(SHA_A, '1.97.1'), WORKFLOW_RULES],
    ['audit.yml', `# rust-toolchain.toml verlangt Rust 1.97.1\n${workflow(SHA_A, '1.97.1')}`, WORKFLOW_RULES],
    ['selection.json', '{\n  "scope": {\n    "rust_toolchain": "1.97.1"\n  }\n}\n', [LICENSE_SCOPE]],
  ];
  for (const eol of ['\n', '\r\n']) {
    const results = files.map(([name, text, rules]) => toolchainMentions(name, text.replaceAll('\n', eol), rules));
    assert.equal(results.flatMap(result => result.mentions).length, 5);
    assert.deepEqual(deviations('1.97.1', results), []);
  }
});

test('the check reports a different version with file, line, found and expected value', () => {
  const guide = '# Build\n\n- Rust 1.97.1. Pinned.\n\n(`rustup target add --toolchain 1.97.2 aarch64-apple-darwin`)\n';
  const results = [
    toolchainMentions('building.md', guide, RULES['docs/guide/building.md']),
    toolchainMentions('selection.json', '{\n  "scope": {\n    "rust_toolchain": "1.98.0"\n  }\n}\n', [LICENSE_SCOPE]),
    toolchainMentions('ci.yml', workflow(SHA_A, '1.96.0'), WORKFLOW_RULES),
  ];
  assert.deepEqual(deviations('1.97.1', results), [
    'building.md:5: found 1.97.2, expected 1.97.1',
    'selection.json:3: found 1.98.0, expected 1.97.1',
    'ci.yml:4: found 1.96.0, expected 1.97.1',
  ]);
});

test('the check reports dtolnay pins on different commits', () => {
  const results = ['android.yml', 'audit.yml', 'ci.yml'].map((name, index) =>
    toolchainMentions(name, workflow(index === 1 ? SHA_B : SHA_A, '1.97.1'), WORKFLOW_RULES));
  assert.deepEqual(deviations('1.97.1', results), [
    `audit.yml:4: dtolnay/rust-toolchain commit ${SHA_B}, expected ${SHA_A} like the other pins`,
  ]);
});

test('the check reports a dtolnay pin without commit or version comment', () => {
  const text = `steps:\n  - uses: ${DTOLNAY}stable\n  - uses: ${DTOLNAY}${SHA_A}\n`;
  const { errors } = toolchainMentions('ci.yml', text, WORKFLOW_RULES);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^ci\.yml:2: /);
  assert.match(errors[1], /^ci\.yml:3: /);
});

test('the check reports a missing or doubled TOOLCHAIN constant and a missing license scope', () => {
  const missing = toolchainMentions('release.mjs', "const OTHER = '1.97.1';\n", [TOOLCHAIN_CONSTANT]);
  const doubled = toolchainMentions('release.mjs', "const TOOLCHAIN = '1.97.1';\nconst TOOLCHAIN = '1.97.1';\n", [TOOLCHAIN_CONSTANT]);
  const scope = toolchainMentions('selection.json', '{ "scope": {} }\n', [LICENSE_SCOPE]);
  assert.deepEqual(deviations('1.97.1', [missing, doubled, scope]), [
    `release.mjs: expected exactly 1 match(es) of ${TOOLCHAIN_CONSTANT.pattern}, found 0`,
    `release.mjs: expected exactly 1 match(es) of ${TOOLCHAIN_CONSTANT.pattern}, found 2`,
    'selection.json: scope.rust_toolchain is missing',
  ]);
});
