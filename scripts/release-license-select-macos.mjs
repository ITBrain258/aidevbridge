#!/usr/bin/env node
// Derive the macOS universal license selection from the reviewed Windows x64
// selection. Packages shared with Windows keep their decision and texts,
// Windows-only families are dropped, and every macOS-only crate and
// standard-library branch has an explicit entry below. Nothing is inferred from
// SPDX expressions and nothing is fetched: cargo runs --offline, texts come from
// the registry cache, the installed rust-src/rust-std components and
// docs/release/licenses. Without --write it only prints a summary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOLCHAIN = '1.97.1';
export const TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
// The universal build runs on an Apple silicon host; build scripts and proc
// macros are resolved for it.
export const BUILD_HOST = 'aarch64-apple-darwin';
const DATE = '2026-10-25';
const WINDOWS = 'docs/release/license-selection.windows-x64.json';
const WINDOWS_INVENTORY = 'docs/release/license-inventory-2026-09-12-rust.json';
const SELECTION = 'docs/release/license-selection.macos-universal.json';
const INVENTORY = 'docs/release/license-inventory-2026-10-25-macos-rust.json';
const REPORT = 'docs/release/license-macos-universal-2026-10-25.json';
const LICENSES = 'docs/release/licenses';
const RUST_COMMIT = '8bab26f4f68e0e26f0bb7960be334d5b520ea452';
const OBJC2 = { commit: '7b1abfd750a2cacaea71d6a56ecfb83cb7de560b', license: `${LICENSES}/objc2-7b1abfd-LICENSE.md`, url: 'https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md' };
const SPDX_MIT = { path: `${LICENSES}/spdx-license-list-3.29.0-MIT.txt`, url: 'https://github.com/spdx/license-list-data/blob/31ba1a50e5397e00a304dbadc76531740e89ee48/text/MIT.txt', tag: 'v3.29.0', commit: '31ba1a50e5397e00a304dbadc76531740e89ee48' };

// Inputs of the Windows payload that the macOS payload does not use.
const WINDOWS_ONLY_FILES = [
  'docs/release/license-webview2-bindings-2026-09-12.json', 'docs/release/license-webview2-sdk-2026-09-12.json', 'docs/release/license-windows-runtime-2026-09-12.json',
  `${LICENSES}/microsoft-web-webview2-1.0.3650.58-LICENSE.txt`, `${LICENSES}/microsoft-web-webview2-1.0.3650.58-NOTICE.txt`, `${LICENSES}/microsoft-webview2-evergreen-2026-09-12-LICENSE.txt`, `${LICENSES}/microsoft-windows-runtime-NOTICE.txt`,
  `${LICENSES}/nsis-3.11-COPYING.txt`, `${LICENSES}/nsis-3.11-Modern-UI-2-LICENSE.txt`, `${LICENSES}/nsis-3.11-NSISdl-LICENSE.txt`, `${LICENSES}/nsis-tauri-utils-0.5.3-LICENSE-MIT.txt`,
  `${LICENSES}/webview2-rs-0.38.2-macros-0.8.1-LICENSE-MIT.txt`, `${LICENSES}/wix-3.14.1-LICENSE.txt`,
  'docs/release/sources/README.txt', 'docs/release/sources/nsis-3.11-source.zip', 'docs/release/sources/wix-3.14.1-source.zip',
  'docs/release/windows-installation-notice.txt', 'docs/release/windows-installer-attribution-2026-09-12.md', 'docs/release/windows-installer-source-archives-2026-09-12.md', 'docs/release/windows-zip-readme.txt',
  'scripts/release-windows-artifacts.mjs', 'scripts/release-windows.ps1', 'src-tauri/tauri.release.windows.json',
];
// Build configuration and texts of the macOS payload. INVENTORY and REPORT are
// written by this script before the selection binds them.
const MACOS_FILES = ['scripts/release-macos-artifacts.mjs', 'src-tauri/Info.plist', 'src-tauri/tauri.release.macos.json', INVENTORY, REPORT,
  OBJC2.license, SPDX_MIT.path, `${LICENSES}/rust-stdlib-addr2line-0.25.1-LICENSE-MIT.txt`, `${LICENSES}/rust-stdlib-object-0.37.3-LICENSE-MIT.txt`];
// Tauri merges tauri.macos.conf.json into every macOS build; its appearance would change the payload.
const ABSENT = ['.cargo/config', '.cargo/config.toml', 'src-tauri/.cargo/config', 'src-tauri/.cargo/config.toml', 'src-tauri/tauri.macos.conf.json', 'public'];

// Every package that exists only in the macOS graph. `files` are the complete
// original texts selected from the package root; `objc2` crates ship no text.
// 2026-10-29 (Tauri 2.12): objc2 0.6.4 -> 0.6.5 and the new objc2-quartz-core
// 0.3.2 ship no license file either; same repository and declarations.
const OBJC2_CRATES = ['block2@0.6.2', 'dispatch2@0.3.1', 'objc2@0.6.5', 'objc2-app-kit@0.3.2', 'objc2-core-foundation@0.3.2', 'objc2-encode@4.1.0', 'objc2-exception-helper@0.1.1', 'objc2-foundation@0.3.2', 'objc2-quartz-core@0.3.2', 'objc2-web-kit@0.3.2'];
export const NEW_CRATES = {
  'base64@0.21.7': { files: ['LICENSE-MIT'] },
  'cfg_aliases@0.2.2': { files: ['LICENSE', 'NOTICES.md'], note: 'The original NOTICES.md for the tectonic_cfg_support code that cfg_aliases reuses is retained.' },
  'core-foundation-sys@0.8.7': { files: ['LICENSE-MIT'] },
  'core-foundation@0.10.1': { files: ['LICENSE-MIT'] },
  'core-graphics-types@0.2.0': { files: ['LICENSE-MIT'] },
  'core-graphics@0.25.0': { files: ['LICENSE-MIT'] },
  'embed_plist@1.2.2': { files: ['LICENSE-MIT'] },
  'foreign-types-macros@0.2.4': { files: ['LICENSE-MIT'] },
  'foreign-types-shared@0.3.1': { files: ['LICENSE-MIT'] },
  'foreign-types@0.5.0': { files: ['LICENSE-MIT'] },
  'iana-time-zone@0.1.65': { outside: true },
  'nix@0.31.3': { files: ['LICENSE'] },
  'objc2-core-graphics@0.3.2': { outside: true },
  'objc2-io-surface@0.3.2': { outside: true },
  // 1.0.7 -> 1.0.9 on 2026-10-29: LICENSE-MIT byte-identical.
  'swift-rs@1.0.9': { files: ['LICENSE-MIT'] },
  ...Object.fromEntries(OBJC2_CRATES.map(id => [id, { objc2: true }])),
};

const RUNTIME = 'macOS runtime candidate notice coverage; no claim every object survives linking.';
const BUILD = 'Conservative permissive build/source family disclosure; no claim that the tool program is delivered.';
const WINDOWS_OUTSIDE = 'Outside the locked Windows release normal/build graph (development or other target). No source/code from this package is selected for the application payload.';
const OUTSIDE = 'Outside the locked macOS release normal/build graph (development or other target). No source/code from this package is selected for the application payload.';
const GENERIC = /^(Explicit \S+ selection using the complete original text\. )(?:Windows runtime candidate notice coverage; no claim every object survives linking\.|Conservative permissive build\/source family disclosure; no claim that the tool program is delivered\.)(.*)$/s;
const WINDOWS_WORDS = /Windows|WebView2|COFF|\bPE\b|\bEXE\b|\bPDB\b|MSVC/;
// Shared decisions whose Windows reason cites Windows build evidence. The
// decision stands for macOS on the evidence given here.
const MACOS_REASONS = {
  'option-ext@0.2.0': 'Both dirs-sys versions unconditionally declare extern crate option_ext, so the dependency tree alone does not exclude it. Their only OptionExt use is user_dir.contains in xdg_user_dirs.rs, whose module is gated by cfg(all(unix, not(any(target_os = "macos", target_os = "ios")))) and is therefore not compiled for either macOS target. option-ext consists of a generic trait and generic impl only, with no initializer or non-generic runtime payload. The Windows COFF size evidence is not repeated for macOS; the caller/cfg proof carries the decision.',
  'selectors@0.38.0': 'The runtime tauri-utils instance for both macOS targets has only the features brotli, compression, resources and walkdir; html-manipulation-2 and dom_query belong to the separate build-host instance used by tauri-build and tauri-codegen. dom_query Matcher parses and matches selectors to DOM nodes; tauri-utils html2 modifies/serializes document content; context_codegen emits CSP hashes and transformed asset bytes through EmbeddedAssets, not the selector matcher or generated selector attribute table. selectors build.rs generates an internal attribute-name PHF consumed by selectors parser.rs; it stays in the host library path. No claim that all build tools are automatically excluded from output.',
};

// The Rust 1.97.1 standard library as the installed aarch64/x86_64-apple-darwin
// rust-std components ship it. `lock` names entries of library/Cargo.lock.
const STDLIB = [
  { name: 'Rust std/core/alloc/panic_unwind/std_detect/unwind and in-tree support', version: TOOLCHAIN, declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-1.97.1-LICENSE-MIT.txt`, `${LICENSES}/rust-1.97.1-SOURCE-NOTICES.txt`], rlibs: ['std', 'core', 'alloc', 'panic_unwind', 'panic_abort', 'std_detect', 'unwind'], reason: 'Installed rust-std RLIBs for both Apple targets and the exact Rust source commit. On Apple targets std links libSystem, which provides the unwinder; unwind contains only bindings. Additional library/backtrace and std/sync/mpmc attributions retained from the standard-library copyright notices.' },
  { name: 'core Unicode tables', version: 'Unicode 17.0.0 at Rust 1.97.1 commit', declared: 'Unicode-3.0', selected: 'Unicode-3.0', texts: [`${LICENSES}/rust-1.97.1-LICENSE-UNICODE.txt`], rlibs: ['core'], reason: 'library/core/src/unicode/unicode_data.rs at the exact Rust commit declares UNICODE_VERSION=(17,0,0); the release copyright index and LICENSES/Unicode-3.0.txt retain the 1991-2024 notice. Same source as the Windows selection.' },
  { name: 'cfg-if', version: '1.0.4', lock: 'cfg-if', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-cfg-if-1.0.4-LICENSE-MIT.txt`], rlibs: ['cfg_if'] },
  { name: 'rustc-demangle', version: '0.1.27', lock: 'rustc-demangle', declared: 'MIT/Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-cfg-if-1.0.4-LICENSE-MIT.txt`], rlibs: ['rustc_demangle'], note: 'Its upstream MIT bytes are identical to cfg-if 1.0.4 and reused without notice loss.' },
  { name: 'hashbrown', version: '0.17.1', lock: 'hashbrown', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-hashbrown-0.17.1-LICENSE-MIT.txt`], rlibs: ['hashbrown'], note: 'std uses default-features=false and rustc-dep-of-std; no foldhash RLIB is installed for either Apple target.' },
  { name: 'compiler_builtins', version: '0.1.160 in the Rust commit, not app Cargo.lock', declared: 'MIT AND Apache-2.0 WITH LLVM-exception', selected: 'MIT AND Apache-2.0 WITH LLVM-exception', texts: [`${LICENSES}/compiler-builtins-0.1.160-LICENSE.txt`], rlibs: ['compiler_builtins'], reason: 'Installed compiler_builtins RLIBs for both Apple targets. The full upstream combined text includes the LLVM exception and historical attribution; it is retained instead of relying on embedding exceptions to remove a notice.' },
  { name: 'libm source embedded in compiler_builtins', version: 'libm manifest 0.2.16 in same Rust source tree; not separate app dependency', declared: 'MIT', selected: 'MIT', texts: [`${LICENSES}/compiler-builtins-0.1.160-libm-LICENSE.txt`], rlibs: ['compiler_builtins'], reason: 'The compiler_builtins math path imports libm source. Full upstream text retained including attributions; this does not assert every libm function is linked.' },
  { name: 'compiler-rt builtins family', version: 'Rust llvm-project submodule dcc3606807c989700e0ac1cac18c31741bcd40d9', declared: 'Apache-2.0 WITH LLVM-exception', selected: 'Apache-2.0 WITH LLVM-exception; MIT alternative for legacy dual-licensed material', texts: [`${LICENSES}/rust-1.97.1-compiler-rt-LICENSE.txt`, `${LICENSES}/rust-1.97.1-compiler-rt-CREDITS.txt`], rlibs: ['compiler_builtins'], nativeObjects: true, reason: 'The installed compiler_builtins RLIBs carry native-named builtins objects (counted per target in the report), built from the compiler-rt source of Rust\'s pinned llvm-project. Supplemental complete upstream file retained, including original legacy alternatives. No claim all objects or LLVM itself are in the binary.' },
  // std selects these for every target except windows-msvc (backtrace symbolization).
  { name: 'libc', version: '0.2.185', lock: 'libc', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: ['sha256:123a331b5dbf04c30097fa43b8f858bc85df671fe776de498d01f3d6b7c1f69e'], rlibs: ['libc'], note: 'std depends on it for cfg(not(all(windows, target_env = "msvc"))); its MIT bytes equal those of the application\'s libc 0.2.189.' },
  { name: 'addr2line', version: '0.25.1', lock: 'addr2line', declared: 'Apache-2.0 OR MIT', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-addr2line-0.25.1-LICENSE-MIT.txt`], rlibs: ['addr2line'], note: 'Backtrace symbolization dependency of std outside windows-msvc.' },
  { name: 'gimli', version: '0.32.3', lock: 'gimli', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: ['sha256:7b63ecd5f1902af1b63729947373683c32745c16a10e8e6292e2e2dcd7e90ae0'], rlibs: ['gimli'], note: 'Backtrace symbolization dependency of std (through addr2line); its MIT bytes are shared with already selected texts.' },
  { name: 'object', version: '0.37.3', lock: 'object', declared: 'Apache-2.0 OR MIT', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-object-0.37.3-LICENSE-MIT.txt`], rlibs: ['object'], note: 'Backtrace symbolization dependency of std outside windows-msvc and AIX, with the macho reader feature.' },
  { name: 'miniz_oxide', version: '0.8.9', lock: 'miniz_oxide', declared: 'MIT OR Zlib OR Apache-2.0', selected: 'MIT', texts: ['sha256:799e9ca9d179295ef372f25d3769cdda7d25bb2668add6a6a1e22d1e4c678b8d'], rlibs: ['miniz_oxide'], note: 'Backtrace symbolization dependency of std outside windows-msvc; same version and text as the application\'s miniz_oxide.' },
  { name: 'adler2', version: '2.0.1', lock: 'adler2', declared: '0BSD OR MIT OR Apache-2.0', selected: 'MIT', texts: ['sha256:23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'], rlibs: ['adler2'], note: 'Dependency of std\'s miniz_oxide; same version and text as the application\'s adler2.' },
  { name: 'memchr', version: '2.7.6', lock: 'memchr', declared: 'Unlicense OR MIT', selected: 'MIT', texts: ['sha256:0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f', 'sha256:01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f'], rlibs: ['memchr'], note: 'Dependency of std\'s object reader; MIT text and COPYING are byte-identical to those selected for the application\'s memchr.' },
];
// Installed std libraries that are not linked into an application binary.
const STDLIB_NOT_LINKED = ['getopts', 'proc_macro', 'profiler_builtins', 'rustc_literal_escaper', 'rustc_std_workspace_alloc', 'rustc_std_workspace_core', 'rustc_std_workspace_std', 'sysroot', 'test'];

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = message => { throw new Error(message); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const licenseName = /^(?:licen[sc]e|licen[sc]ing|copying|copyright|notice|unlicense)(?:$|[._-])/i;

function readFile(root, relative) {
  const file = path.join(root, ...relative.split('/'));
  const info = fs.lstatSync(file);
  ensure(info.isFile() && !info.isSymbolicLink(), `Not a regular file: ${relative}`);
  return fs.readFileSync(file);
}
function run(root, program, args, env = process.env) {
  return execFileSync(program, args, { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}
const cargo = (root, args, env) => run(root, 'rustup', ['run', TOOLCHAIN, 'cargo', ...args], env);
const platformArgs = flag => TARGETS.flatMap(target => [flag, target]);

export function macosMetadata(root) {
  return JSON.parse(cargo(root, ['metadata', '--locked', '--offline', '--format-version', '1', ...platformArgs('--filter-platform'), '--features', 'tauri/custom-protocol']));
}

// cargo tree resolves build scripts and proc macros for the host. Off an Apple
// silicon host, a small rustc wrapper reports BUILD_HOST and passes it as the
// default target, so host cfgs evaluate as on the release runner. The wrapper
// is a Rust program, as in release-license-select-android.mjs, so that it runs
// on every host, Windows included (the former shell script did not).
function hostEnvironment(root) {
  if (process.platform === 'darwin' && process.arch === 'arm64') return { env: process.env, cleanup() {} };
  const rustc = run(root, 'rustup', ['which', '--toolchain', TOOLCHAIN, 'rustc']).trim();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aidevbridge-macos-host-'));
  fs.writeFileSync(path.join(dir, 'wrapper.rs'), `use std::process::{exit, Command};
fn main() {
    let real = std::env::var("AIDEVBRIDGE_REAL_RUSTC").unwrap();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-vV") {
        let out = Command::new(&real).arg("-vV").output().unwrap();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if line.starts_with("host: ") { println!("host: ${BUILD_HOST}"); } else { println!("{line}"); }
        }
        exit(0);
    }
    let mut cmd = Command::new(&real);
    if !args.iter().any(|a| a == "--target" || a.starts_with("--target=")) { cmd.arg("--target").arg("${BUILD_HOST}"); }
    exit(cmd.args(&args).status().unwrap().code().unwrap_or(1));
}
`);
  const wrapper = path.join(dir, process.platform === 'win32' ? 'rustc-host.exe' : 'rustc-host');
  run(root, rustc, ['-O', '-o', wrapper, path.join(dir, 'wrapper.rs')]);
  return { env: { ...process.env, RUSTC: wrapper, AIDEVBRIDGE_REAL_RUSTC: rustc, CARGO_TARGET_DIR: path.join(dir, 'target') }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Same classification as release-license-inventory.mjs, for both Apple targets.
export function macosRoles(root, metadata) {
  const host = hostEnvironment(root);
  try {
    const tree = edges => {
      const raw = cargo(root, ['tree', '--locked', '--offline', ...platformArgs('--target'), '--features', 'tauri/custom-protocol', '--edges', edges, '--prefix', 'none', '--format', '{p}|{l}|{f}', '--charset', 'ascii'], host.env);
      const map = new Map();
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        const m = /^([^ ]+) v([^ ]+)(.*?)\|([^|]*)\|(.*?)(?: \(\*\))?$/.exec(line);
        ensure(m, `Unparsed cargo tree line: ${line}`);
        const key = `${m[1]}@${m[2]}`;
        const features = map.get(key) ?? new Set();
        m[5].split(',').filter(Boolean).forEach(f => features.add(f));
        map.set(key, features);
      }
      return map;
    };
    const release = tree('normal,build'), normal = tree('normal,no-proc-macro'), withDev = tree('normal,build,dev');
    const roles = new Map();
    for (const pkg of metadata.packages) {
      const key = `${pkg.name}@${pkg.version}`;
      const role = metadata.workspace_members.includes(pkg.id) ? 'workspace-product' : normal.has(key) ? 'normal-runtime-candidate'
        : release.has(key) ? 'build-or-proc-macro-only-in-this-tree' : withDev.has(key) ? 'dev-only-in-this-tree' : 'outside-selected-macos-tree';
      roles.set(key, { role, features: release.has(key) ? [...release.get(key)].sort() : null });
    }
    for (const key of release.keys()) ensure(roles.has(key), `Tree package absent from metadata: ${key}`);
    return roles;
  } finally { host.cleanup(); }
}

function licenseCandidates(dir) {
  const found = [];
  const walk = (base, depth) => {
    ensure(depth <= 16, `License scan depth exceeded: ${base}`);
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(base, entry.name);
      if (entry.isDirectory() && !['target', '.git', 'node_modules'].includes(entry.name)) walk(p, depth + 1);
      else if (entry.isFile() && licenseName.test(entry.name)) found.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir, 0);
  return found.sort();
}
// License candidates plus the texts a decision selects under another name (NOTICES.md).
const boundFiles = (key, dir) => [...new Set([...licenseCandidates(dir), ...(NEW_CRATES[key].files ?? [])])].sort();

// `ar t` lists the members of an archive. Windows has no `ar`; there the NDK's
// llvm-ar (NDK_HOME, as for the Android selection) prints the same list.
function arTool() {
  if (process.platform !== 'win32') return 'ar';
  ensure(process.env.NDK_HOME, 'Set NDK_HOME: on Windows the NDK\'s llvm-ar lists the members of compiler_builtins');
  return path.join(process.env.NDK_HOME, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin', 'llvm-ar.exe');
}

function stdlibEvidence(root) {
  const sysroot = run(root, 'rustup', ['run', TOOLCHAIN, 'rustc', '--print', 'sysroot']).trim();
  const library = path.join(sysroot, 'lib/rustlib/src/rust/library');
  ensure(fs.existsSync(path.join(library, 'Cargo.lock')), `rust-src for ${TOOLCHAIN} is missing: rustup component add rust-src --toolchain ${TOOLCHAIN}`);
  const lockText = fs.readFileSync(path.join(library, 'Cargo.lock'), 'utf8');
  const lock = new Map();
  for (const part of lockText.split('[[package]]').slice(1)) {
    const value = field => new RegExp(`^${field} = "([^"]*)"`, 'm').exec(part)?.[1] ?? null;
    lock.set(value('name'), { version: value('version'), source: value('source'), checksum: value('checksum') });
  }
  const targets = {};
  for (const target of TARGETS) {
    const dir = path.join(sysroot, 'lib/rustlib', target, 'lib');
    ensure(fs.existsSync(dir), `rust-std for ${target} is missing: rustup target add --toolchain ${TOOLCHAIN} ${target}`);
    const rlibs = fs.readdirSync(dir).filter(n => n.endsWith('.rlib')).sort();
    const builtins = rlibs.find(n => /^libcompiler_builtins-[0-9a-f]+\.rlib$/.test(n));
    const members = run(root, arTool(), ['t', path.join(dir, builtins)]).split(/\r?\n/).filter(Boolean);
    targets[target] = { rlibs, compiler_builtins_native_objects: members.filter(m => m.endsWith('.o') && !m.startsWith('compiler_builtins-')).length };
  }
  return {
    rustc: run(root, 'rustup', ['run', TOOLCHAIN, 'rustc', '-vV']).trim(),
    library_cargo_lock: record(fs.readFileSync(path.join(library, 'Cargo.lock'))),
    std_cargo_toml: record(fs.readFileSync(path.join(library, 'std/Cargo.toml'))),
    lock, targets,
  };
}

export function deriveSelection(root, { metadata = macosMetadata(root), roles = macosRoles(root, metadata), stdlib = stdlibEvidence(root) } = {}) {
  const windows = JSON.parse(readFile(root, WINDOWS));
  const windowsInventoryTexts = JSON.parse(readFile(root, WINDOWS_INVENTORY)).candidate_texts_by_sha256;
  const pkgVersion = JSON.parse(readFile(root, 'package.json')).version;
  ensure(windows.scope.product_version === pkgVersion, 'Rebind the Windows selection for this version first');
  for (const file of MACOS_FILES.filter(f => f !== INVENTORY && f !== REPORT)) ensure(fs.existsSync(path.join(root, ...file.split('/'))), `Missing macOS delivery input: ${file}`);
  const packages = new Map(metadata.packages.map(p => [`${p.name}@${p.version}`, p]));
  ensure(packages.size === metadata.packages.length, 'Ambiguous package name/version');
  const lockChecksums = new Map();
  for (const part of readFile(root, 'Cargo.lock').toString('utf8').split('[[package]]').slice(1)) {
    const value = field => new RegExp(`^${field} = "([^"]*)"`, 'm').exec(part)?.[1] ?? null;
    lockChecksums.set(`${value('name')}@${value('version')}`, value('checksum'));
  }
  const windowsCargo = new Map(windows.components.filter(c => c.id.startsWith('cargo:')).map(c => [c.id.slice(6), c]));
  const windowsDocs = new Map(windows.documents.map(d => [d.id, d]));
  const docs = new Map(), newTexts = new Map(), components = [], changes = { role: [], reason: [] };

  // Documents: an id `sha256:<hex>` reuses a Windows record, a path makes a file record.
  function useDocument(ref) {
    if (ref.startsWith('sha256:')) {
      const doc = windowsDocs.get(ref) ?? docs.get(ref);
      ensure(doc, `Unknown document ${ref}`);
      if (!docs.has(ref)) docs.set(ref, structuredClone(doc));
      return ref;
    }
    const bytes = readFile(root, ref), id = `sha256:${sha(bytes)}`;
    if (!docs.has(id)) docs.set(id, windowsDocs.has(id) ? structuredClone(windowsDocs.get(id)) : { id, file_name: path.posix.basename(ref), ...record(bytes), sources: [{ kind: 'file', path: ref }], source_names: [ref], source_urls: [] });
    return id;
  }
  function crateText(key, file) {
    const pkg = packages.get(key), bytes = fs.readFileSync(path.join(path.dirname(pkg.manifest_path), ...file.split('/'))), hex = sha(bytes), id = `sha256:${hex}`;
    if (!docs.has(id) && windowsDocs.has(id)) docs.set(id, structuredClone(windowsDocs.get(id)));
    else if (!docs.has(id)) {
      // Bytes the Windows inventory already saved stay there; only new bytes go to the macOS inventory.
      const blob = windowsInventoryTexts[hex] ? WINDOWS_INVENTORY : INVENTORY;
      if (blob === INVENTORY) newTexts.set(hex, bytes);
      const name = `${pkg.name}-${pkg.version}-${file.replaceAll('/', '-')}`;
      docs.set(id, { id, file_name: /\.(?:txt|md)$/.test(name) ? name : `${name}.txt`, ...record(bytes), sources: [{ kind: 'inventory_blob', path: blob, sha256: hex }], source_names: [], source_urls: [] });
    }
    const doc = docs.get(id), urls = [`https://crates.io/crates/${pkg.name}/${pkg.version}`, ...(pkg.repository ? [pkg.repository] : [])];
    if (!doc.source_names.includes(`${key}/${file}`)) doc.source_names.push(`${key}/${file}`);
    for (const url of urls) if (!doc.source_urls.includes(url)) doc.source_urls.push(url);
    return id;
  }
  const sourceUrls = pkg => [`https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`, `https://crates.io/crates/${pkg.name}/${pkg.version}`, ...(pkg.repository ? [pkg.repository] : [])];
  const sourceArchive = pkg => pkg.source ? { url: sourceUrls(pkg)[0], sha256: lockChecksums.get(`${pkg.name}@${pkg.version}`) } : undefined;
  const isRuntime = role => role === 'normal-runtime-candidate' || role === 'workspace-product';

  for (const [key, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const { role, features } = roles.get(key) ?? fail(`No role for ${key}`);
    const base = windowsCargo.get(key);
    if (base) {
      const component = structuredClone(base);
      if (role !== base.technical_role && !(base.technical_role === 'outside-selected-windows-tree' && role === 'outside-selected-macos-tree')) changes.role.push({ id: base.id, windows: base.technical_role, macos: role });
      component.technical_role = role;
      component.release_tree_features = features;
      let reason = base.reason;
      if (MACOS_REASONS[key]) reason = MACOS_REASONS[key];
      else if (base.reason === WINDOWS_OUTSIDE) { ensure(role === 'outside-selected-macos-tree', `${key} is outside the Windows graph but ${role} on macOS; it needs a decision`); reason = OUTSIDE; }
      else {
        ensure(role !== 'outside-selected-macos-tree' || base.disposition === 'exclude', `${key} is outside the macOS graph; review its inclusion`);
        const generic = GENERIC.exec(base.reason);
        if (generic) reason = `${generic[1]}${isRuntime(role) ? RUNTIME : BUILD}${generic[2]}`;
        ensure(!WINDOWS_WORDS.test(reason), `${key}: the Windows reason cites Windows evidence; add a macOS reason`);
      }
      if (base.disposition === 'exclude' && base.reason !== WINDOWS_OUTSIDE) ensure(!isRuntime(role) || MACOS_REASONS[key], `${key}: an excluded package became runtime on macOS`);
      if (reason !== base.reason) { changes.reason.push({ id: base.id, windows: base.reason, macos: reason }); component.reason = reason; if (!component.decision_basis.includes(REPORT)) component.decision_basis.push(REPORT); }
      component.documents = component.documents.map(useDocument);
      components.push(component);
      continue;
    }
    const decision = NEW_CRATES[key] ?? fail(`No macOS decision for ${key}`);
    const outside = role === 'outside-selected-macos-tree';
    ensure(outside === !!decision.outside, `${key}: decision and role (${role}) disagree`);
    const component = { id: `cargo:${key}`, name: pkg.name, version: pkg.version, declared_license: pkg.license, selected_license: outside ? null : 'MIT', disposition: outside ? 'exclude' : 'include', technical_role: role, release_tree_features: features, documents: [], reason: OUTSIDE, source_urls: sourceUrls(pkg), decision_basis: [`${INVENTORY}#packages/${key}`, REPORT], source_archive: sourceArchive(pkg) };
    if (decision.objc2) {
      ensure(/^(?:MIT|Zlib OR Apache-2\.0 OR MIT)$/.test(pkg.license), `${key}: unexpected objc2 license ${pkg.license}`);
      // The framework crates name no author; the others keep their authors entry as notice.
      const manifest = fs.readFileSync(pkg.manifest_path, 'utf8').split(/\r?\n/);
      const start = manifest.findIndex(l => l.startsWith('authors = '));
      if (start >= 0) {
        const end = manifest.findIndex((l, i) => i >= start && l.includes(']'));
        ensure(end >= start, `${key}: unterminated authors entry`);
        component.copyright_notices = [{ text: manifest.slice(start, end + 1).join('\n'), path: 'Cargo.toml', line: start + 1 }];
      }
      component.documents = [useDocument(SPDX_MIT.path), useDocument(OBJC2.license)];
      component.source_urls.push(OBJC2.url, SPDX_MIT.url);
      component.reason = `The crate ships no license file. The objc2 repository's LICENSE.md (unchanged at ${OBJC2.commit.slice(0, 7)} and at the commits these crates were published from) names MIT for objc2, block2, objc2-foundation and objc2-encode and Zlib OR Apache-2.0 OR MIT for the other crates, and carries no copyright line. Select MIT with the canonical SPDX MIT text it links (license list ${SPDX_MIT.tag}) and retain LICENSE.md verbatim, including its note on the Apple SDKs the bindings derive from. ${start >= 0 ? 'The Cargo.toml authors entry is recorded as the copyright notice.' : 'Cargo.toml names no author.'} ${RUNTIME}`;
    } else if (!outside) {
      ensure(/\bMIT\b/.test(pkg.license), `${key}: MIT is not offered (${pkg.license})`);
      component.documents = decision.files.map(file => crateText(key, file));
      component.reason = `Explicit MIT selection using the complete original text. ${isRuntime(role) ? RUNTIME : BUILD}${decision.note ? ` ${decision.note}` : ''}`;
    }
    components.push(component);
  }
  for (const key of Object.keys(NEW_CRATES)) ensure(packages.has(key) && !windowsCargo.has(key), `Stale macOS decision: ${key}`);

  // Frontend and npm decisions are platform independent: the same dist is bundled.
  for (const component of windows.components.filter(c => /^(?:npm|frontend):/.test(c.id))) {
    ensure(!WINDOWS_WORDS.test(component.reason), `${component.id}: the reason cites Windows evidence`);
    components.push({ ...structuredClone(component), documents: component.documents.map(useDocument) });
  }

  STDLIB.forEach((item, index) => {
    const locked = item.lock ? stdlib.lock.get(item.lock) : null;
    if (item.lock) ensure(locked?.version === item.version && /^[a-f0-9]{64}$/.test(locked.checksum ?? ''), `library/Cargo.lock no longer pins ${item.lock} ${item.version}`);
    for (const target of TARGETS) for (const rlib of item.rlibs) ensure(stdlib.targets[target].rlibs.some(n => n.startsWith(`lib${rlib}-`)), `No ${rlib} RLIB for ${target}`);
    const evidence = item.lock ? `Installed rust-std RLIB lib${item.rlibs[0]} for both Apple targets; library/Cargo.lock pins ${item.version} with crates.io checksum ${locked.checksum}, equal to the SHA-256 of the archive the text comes from.` : '';
    components.push({
      id: `rust-toolchain:${index}`, name: item.name, version: item.version, declared_license: item.declared, selected_license: item.selected, disposition: 'include',
      documents: item.texts.map(useDocument), reason: [item.reason ?? evidence, item.note].filter(Boolean).join(' '), decision_basis: [REPORT],
      source_urls: item.lock ? [`https://static.crates.io/crates/${item.name}/${item.name}-${item.version}.crate`] : [`https://github.com/rust-lang/rust/tree/${RUST_COMMIT}/library`],
    });
  });
  components.push(
    { id: 'native:apple-system-libraries', name: 'macOS system libraries and frameworks', version: 'provided by macOS 11 or newer', declared_license: 'Apple macOS terms', selected_license: null, disposition: 'exclude', documents: [], reason: 'libSystem (including the unwinder std links against), Foundation, AppKit, WebKit, CoreFoundation, CoreGraphics and the other frameworks are part of macOS and are loaded from the system at run time. No Apple library bytes are copied into the .app or the DMG. The objc2 bindings derived from Apple SDK headers are mapped separately.', decision_basis: [REPORT], source_urls: [] },
    { id: 'installer:macos-dmg', name: 'DMG disk image', version: 'Tauri CLI 2.11.4 bundle_dmg.sh with hdiutil', declared_license: null, selected_license: null, disposition: 'exclude', documents: [], reason: 'The image holds the .app, a link to /Applications and at most the volume icon made from the app\'s own icon and file-system metadata macOS writes itself (.DS_Store, .fseventsd, .Trashes); scripts/release-macos-artifacts.mjs refuses any other entry. hdiutil and the Tauri bundler script only build the image; no third-party installer code, graphics or license agreement is delivered.', decision_basis: [REPORT, 'scripts/release-macos-artifacts.mjs'], source_urls: [] },
  );
  ensure(new Set(components.map(c => c.id)).size === components.length, 'Duplicate component');
  // The rust-toolchain ids recur with the Apple standard-library mapping.
  const ids = new Set(components.map(c => c.id)), windowsIds = new Set(windows.components.map(c => c.id));
  changes.dropped = [...windowsIds].filter(id => !ids.has(id));
  changes.added = [...ids].filter(id => !windowsIds.has(id));
  changes.replaced = [...ids].filter(id => id.startsWith('rust-toolchain:') && windowsIds.has(id));

  // Keep source names and URLs of dropped Windows packages out of shared records.
  const dropped = new Set(changes.dropped.filter(id => id.startsWith('cargo:')).map(id => id.slice(6)));
  const keptUrls = new Set(components.flatMap(c => c.source_urls));
  const droppedUrls = new Set(changes.dropped.flatMap(id => windows.components.find(c => c.id === id)?.source_urls ?? []).filter(u => !keptUrls.has(u)));
  const used = new Set(components.flatMap(c => c.documents));
  const documents = [...docs.values()].filter(doc => used.has(doc.id)).map(doc => ({
    ...doc, source_names: doc.source_names.filter(n => !dropped.has(n.split('/')[0])), source_urls: doc.source_urls.filter(u => !droppedUrls.has(u)),
  }));
  const decisionReports = [...new Set([...windows.decision_reports.filter(r => components.some(c => c.decision_basis.some(b => b.split('#')[0] === r))), REPORT])];
  return { windows, windowsInventoryTexts, components, documents, newTexts, changes, decisionReports, packages, roles, stdlib, pkgVersion, lockChecksums };
}

function inventory(derived) {
  const packages = [...derived.packages].sort(([a], [b]) => a.localeCompare(b)).map(([key, pkg]) => {
    const { role, features } = derived.roles.get(key), dir = path.dirname(pkg.manifest_path);
    const candidates = NEW_CRATES[key] && !NEW_CRATES[key].outside ? boundFiles(key, dir).map(p => ({ path: p, ...record(fs.readFileSync(path.join(dir, ...p.split('/')))) })) : undefined;
    return { name: pkg.name, version: pkg.version, source: pkg.source, declared_spdx: pkg.license, technical_role: role, release_tree_features: features, lock_checksum: derived.lockChecksums.get(key) ?? null, ...(candidates ? { license_candidates: candidates } : {}) };
  });
  const texts = {};
  for (const pkg of packages) for (const c of pkg.license_candidates ?? []) {
    if (derived.windowsInventoryTexts[c.sha256] || texts[c.sha256]) continue;
    const dir = path.dirname(derived.packages.get(`${pkg.name}@${pkg.version}`).manifest_path), bytes = fs.readFileSync(path.join(dir, ...c.path.split('/')));
    let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { text = null; }
    texts[c.sha256] = text !== null && Buffer.from(text, 'utf8').equals(bytes) ? { bytes: bytes.length, encoding: 'utf8', content: text } : { bytes: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
  }
  for (const hex of derived.newTexts.keys()) ensure(texts[hex], `Selected text missing from inventory: ${hex}`);
  return {
    schema_version: 1, generated: DATE, status: 'pending-not-an-approval', generator: 'scripts/release-license-select-macos.mjs',
    configuration: { targets: TARGETS, build_host: BUILD_HOST, features_argument: 'tauri/custom-protocol', default_features_enabled: true, rust_toolchain: TOOLCHAIN },
    methodology: [
      'Package set: cargo metadata --locked --offline with --filter-platform for both Apple targets (their union).',
      `Roles: cargo tree --locked --offline with --target for both Apple targets and the edges normal,build / normal,no-proc-macro / normal,build,dev, resolved with ${BUILD_HOST} as build host, the host of the universal release build.`,
      'License candidates and texts are recorded only for packages that the Windows inventory does not cover; shared packages keep the Windows inventory records.',
    ],
    packages, candidate_texts_by_sha256: texts,
  };
}

function report(derived, root) {
  const { stdlib } = derived;
  return {
    schema_version: 1, date: DATE, status: 'targeted_selection_complete_delivery_not_yet_verified',
    scope: { target: 'universal-apple-darwin', cargo_targets: TARGETS, build_host: BUILD_HOST, rust_toolchain: TOOLCHAIN, rust_commit: RUST_COMMIT, features: ['tauri/custom-protocol'], product_version: derived.pkgVersion },
    base_selection: { path: WINDOWS, selection_id: derived.windows.selection_id, ...record(readFile(root, WINDOWS)) },
    method: [
      'Start from the reviewed Windows x64 selection. Every cargo package of the macOS graph that the Windows selection covers keeps its decision, selected license and texts; only role, features and platform-specific wording change.',
      'Windows-only packages, the WebView2, MSVC and Windows runtime families, the NSIS/WiX installer families and their source archives are dropped.',
      'Each macOS-only package has an explicit decision in scripts/release-license-select-macos.mjs; MIT is selected where offered, using the complete original text.',
      'The standard-library mapping follows the installed aarch64/x86_64-apple-darwin rust-std RLIB names, std/Cargo.toml and library/Cargo.lock of the exact Rust commit. Outside windows-msvc, std carries the backtrace symbolization crates.',
      'Frontend and npm decisions are reused unchanged: the same dist is bundled on both platforms.',
    ],
    evidence: {
      rustc: stdlib.rustc,
      library_cargo_lock: stdlib.library_cargo_lock, std_cargo_toml: stdlib.std_cargo_toml,
      installed_rlibs: Object.fromEntries(TARGETS.map(t => [t, stdlib.targets[t].rlibs.map(n => n.replace(/-[0-9a-f]+\.rlib$/, '.rlib'))])),
      compiler_builtins_native_objects: Object.fromEntries(TARGETS.map(t => [t, stdlib.targets[t].compiler_builtins_native_objects])),
      stdlib_crates: STDLIB.filter(s => s.lock).map(s => ({ name: s.name, version: s.version, lock_checksum: stdlib.lock.get(s.lock).checksum, archive: `https://static.crates.io/crates/${s.name}/${s.name}-${s.version}.crate`, archive_sha256_verified_equal_on: DATE })),
      objc2: { license_md: { path: OBJC2.license, ...record(readFile(root, OBJC2.license)), url: OBJC2.url, unchanged_at_publish_commits: ['8852b424193ca41602281b3d7540d7c8ed51e49a', 'b4167b582b2f75f9a1be75495c41b765344fd03c', '8d214f5477365ffcbcbb7de058c86ed9a518efb7'] }, crates: OBJC2_CRATES },
      spdx_mit: { path: SPDX_MIT.path, ...record(readFile(root, SPDX_MIT.path)), url: SPDX_MIT.url, tag: SPDX_MIT.tag, commit: SPDX_MIT.commit },
    },
    changes: derived.changes,
    exclusions: [
      { components: STDLIB_NOT_LINKED, reason: 'Installed with rust-std for test, proc-macro, profiling or workspace plumbing; not linked into an application binary built without tests or instrumentation.' },
      { components: ['foldhash'], reason: 'hashbrown default-hasher is disabled in std; no foldhash RLIB is installed for either Apple target.' },
      { components: ['LLVM libunwind', 'unwinding'], reason: 'library/unwind links no unwinder library for Apple targets; std links libSystem, which provides it (std/src/sys/pal/unix/mod.rs).' },
      { components: ['windows_link', 'windows-sys', 'windows-targets', 'webview2-com', 'pageant'], reason: 'Windows-only branches of std and of the application graph.' },
    ],
    remaining: [
      'Bind the selection against the built universal binary: Mach-O load commands must reference only /System/Library and /usr/lib, and the linked std branch must match the RLIB mapping.',
      'Recheck the roles on the macOS release runner; scripts/release-macos-artifacts.mjs compares them before it builds.',
      'Complete product, installation and run-time acceptance on a real Mac.',
    ],
  };
}

function selection(derived, root, pending) {
  const { windows } = derived;
  const files = windows.inputs.files.filter(f => !WINDOWS_ONLY_FILES.includes(f.path)).map(f => f.path);
  for (const file of WINDOWS_ONLY_FILES) ensure(windows.inputs.files.some(f => f.path === file), `Not a Windows input: ${file}`);
  const allFiles = [...new Set([...files, ...MACOS_FILES, ...derived.documents.flatMap(d => d.sources.filter(s => s.kind === 'file').map(s => s.path))])].sort();
  for (const doc of derived.documents) for (const s of doc.sources) if (s.kind === 'file') ensure(!WINDOWS_ONLY_FILES.includes(s.path), `Dropped file still used: ${s.path}`);
  const trees = windows.inputs.trees.map(tree => ({ ...tree, files: tree.files.map(f => ({ path: f.path, ...(tree.availability === 'generated-by-cargo' ? { bytes: f.bytes, sha256: f.sha256 } : record(readFile(root, f.path))) })) }));
  const cargoFiles = windows.inputs.cargo_files.filter(f => derived.packages.has(f.package));
  for (const [key, decision] of Object.entries(NEW_CRATES)) {
    if (decision.outside) continue;
    const dir = path.dirname(derived.packages.get(key).manifest_path);
    for (const p of boundFiles(key, dir)) cargoFiles.push({ package: key, path: p, ...record(fs.readFileSync(path.join(dir, ...p.split('/')))) });
  }
  return {
    schema_version: 1,
    selection_id: `aidevbridge-macos-universal-${DATE}`,
    scope: {
      target: 'universal-apple-darwin', cargo_targets: TARGETS, build_host: BUILD_HOST, default_features: true, cargo_features: ['tauri/custom-protocol'], rust_toolchain: TOOLCHAIN, product_version: derived.pkgVersion,
      bundle_targets: ['app', 'dmg'], minimum_system_version: '11.0',
      meaning: 'License text selection for the macOS application (one universal binary for Apple silicon and Intel) plus explicitly disclosed source/build families; not binary, app bundle or disk image acceptance.',
      historical_evidence: `Derived on ${DATE} from ${WINDOWS} (selection ${windows.selection_id}) by scripts/release-license-select-macos.mjs; ${REPORT} records the macOS evidence, every dropped and added component and every reworded reason. Shared decisions keep their Windows decision reports; their Windows binary evidence is not repeated for macOS.`,
    },
    selection_policy: [
      'Each component below has an explicit decision. The helper does not derive permission from inventory status fields or parse SPDX expressions to choose licenses.',
      'Packages shared with the Windows x64 selection keep its decision and texts. For ordinary permissive OR alternatives of macOS-only packages, choose a complete existing MIT text; where a package ships none, retain its upstream license statement and use the canonical SPDX text it names.',
      'Disclose complete permissive build/source family notices conservatively without claiming that the whole build tool is linked. The MPL cases keep their individual output-boundary decisions, rechecked for the macOS cfgs.',
      'Full texts are deduplicated only by exact SHA-256 bytes. Every original component, filename, notice and source association is retained.',
      'Source repository test fixtures and other operating systems are outside this selected application payload. Apple system libraries are provided by macOS and not delivered. Future payload changes require review of this explicit selection.',
      'Existing consolidated notice files retain their original historical progress notes. Their bytes are included for complete text/attribution, not used as current release status.',
    ],
    decision_reports: derived.decisionReports,
    inputs: {
      files: allFiles.map(p => ({ path: p, ...record(pending.get(p) ?? readFile(root, p)) })),
      trees,
      absent: ABSENT,
      cargo_packages: windows.inputs.cargo_packages.filter(p => derived.packages.has(p.package)).concat(Object.keys(NEW_CRATES).map(key => {
        const pkg = derived.packages.get(key);
        return { package: key, source: pkg.source, manifest: record(fs.readFileSync(pkg.manifest_path)), declared_license: pkg.license };
      })).sort((a, b) => a.package.localeCompare(b.package)),
      cargo_files: cargoFiles.sort((a, b) => a.package.localeCompare(b.package) || byPath(a, b)),
      cargo_trees: windows.inputs.cargo_trees.filter(t => derived.packages.has(t.package)),
    },
    components: derived.components,
    documents: derived.documents,
    pending_delivery: [
      'Integrate this exact folder into the app bundle (Contents/Resources/licenses) and the DMG, then inspect the actual bundle and image contents.',
      'Rebuild the application with the selected frontend/configuration and bind the final universal Mach-O, app bundle and DMG hashes.',
      'Bind the standard-library and system-library mapping against the built universal binary: load commands must reference only /System/Library and /usr/lib.',
      'Complete the remaining product, macOS installation/run-time and source-repository release acceptance; this helper makes no release-ready or legal-approval claim.',
    ],
  };
}

export function write(root, { dryRun = false } = {}) {
  const derived = deriveSelection(root);
  // The selection binds the bytes of INVENTORY and REPORT, so they are made first.
  const pending = new Map([[INVENTORY, encode(inventory(derived))], [REPORT, encode(report(derived, root))]]);
  pending.set(SELECTION, encode(selection(derived, root, pending)));
  const summary = { components: derived.components.length, documents: derived.documents.length, added: derived.changes.added.length, dropped: derived.changes.dropped.length, replaced: derived.changes.replaced.length, role_changes: derived.changes.role.length, reworded: derived.changes.reason.length, new_texts: derived.newTexts.size, written: [] };
  for (const [relative, bytes] of pending) {
    if (dryRun) continue;
    fs.writeFileSync(path.join(root, ...relative.split('/')), bytes);
    summary.written.push(relative);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    ensure(args.every(a => a === '--write'), 'Usage: node scripts/release-license-select-macos.mjs [--write]');
    const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    console.log(JSON.stringify(write(root, { dryRun: !args.includes('--write') }), null, 2));
  } catch (error) { console.error(`release-license-select-macos: ${error.message}`); process.exitCode = 1; }
}
