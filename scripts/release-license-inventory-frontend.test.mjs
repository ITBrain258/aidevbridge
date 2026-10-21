import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Das Inventar liest diesen Checkout so, wie er ist: installierte node_modules, Git und src/.
// Ohne Git-Checkout (Quell-ZIP) gibt es nichts zu inventarisieren; dann werden die Tests uebersprungen.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repository, 'scripts', 'release-license-inventory-frontend.mjs');
let skip = false;
try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repository, stdio: 'ignore', windowsHide: true }); } catch { skip = 'needs a Git checkout'; }
const inventory = skip ? null : JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }));

test('every production package import reaches an inventoried runtime module', { skip }, () => {
  assert.ok(inventory.production_imports.length > 0);
  for (const item of inventory.production_imports) {
    assert.ok(inventory.runtime_entry_headers.some(entry => entry.reached_from.includes(item.specifier)), `${item.path}:${item.line} ${item.specifier}`);
  }
});

test('runtime modules follow the ESM entries and relative imports the bundler uses', { skip }, () => {
  const paths = inventory.runtime_entry_headers.map(entry => entry.path);
  for (const expected of [
    'node_modules/@xterm/xterm/lib/xterm.mjs',
    'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
    'node_modules/@tauri-apps/plugin-dialog/dist-js/index.js',
    'node_modules/@tauri-apps/api/window.js',
    'node_modules/@tauri-apps/api/dpi.js',
    'node_modules/@tauri-apps/api/image.js',
    'node_modules/@tauri-apps/api/external/tslib/tslib.es6.js',
  ]) assert.ok(paths.includes(expected), expected);
  assert.ok(!paths.includes('node_modules/@xterm/xterm/lib/xterm.js'), 'the CommonJS entry must not replace the ESM bundle');
  assert.equal(inventory.embedded_helpers.tauri_vendored_tslib.inspected_entry, 'node_modules/@tauri-apps/api/core.js');
});

test('icons inlined into tracked CSS are listed with their Lucide geometry', { skip }, () => {
  const masks = inventory.copied_assets.css_embedded_svgs.filter(item => item.path === 'src/styles.css');
  assert.ok(masks.length >= 1);
  for (const mask of masks) assert.ok(mask.matching_lucide_icons.length > 0, `${mask.path}:${mask.line}`);
  assert.ok(masks.some(mask => mask.matching_lucide_icons.includes('triangle-alert')));
});
