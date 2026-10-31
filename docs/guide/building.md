# Build and test

[Back to the README](../../README.md)

To build the desktop app you need Windows 10 or 11 (x64), or macOS 11 or newer, with:

- Rust 1.97.1. `rust-toolchain.toml` pins it, and `rustup` installs it on
  first use.
- On Windows the Microsoft C++ Build Tools (MSVC) and the WebView2 Runtime,
  on macOS the Xcode Command Line Tools (`xcode-select --install`).
- Node.js 24 or newer.

```sh
npm ci
npm run tauri -- dev
```

`package.json` denies the install script of `esbuild` (`allowScripts`, read
by npm 12): the build and the tests run without it.

Builds pin `russh` to the published version **0.65.0** with four local
changes: SSH channel-close acknowledgements, including cleanup of unsent data
after remote close; a public `ChannelEndObserver`/`ChannelEndSnapshot` API
that reports how a client channel ended (EOF, exit status or signal, Close,
session end); a manual receive window for terminal channels, so the host
sends a terminal's output only as fast as the app consumes it; and an error
instead of an empty method list when the session ends during sign-in. Cryptographic
code and requested production features are unchanged. The [vendored source record](../../vendor/russh/AGENTBRIDGE-PATCH.md)
lists every changed and added file and documents the upstream commit, original
archive checksum and Apache-2.0 license; the
[close patch report](../reviews/2026-09-11-neutral/russh-channel-close-patch.md)
(in German) records the scope and validation of the Close change.

## Tests

```sh
npm test
npm run test:scripts
npm run build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all
```

These checks need no SSH host. Tests that need one skip themselves and still
count as passed. To run them against a test host, set `AIDEVBRIDGE_TEST_HOST`,
`AIDEVBRIDGE_TEST_USER`, `AIDEVBRIDGE_TEST_HOST_KEY` and
`AIDEVBRIDGE_TEST_SOCKET`; the VM acceptance suite needs
`AIDEVBRIDGE_VM_HOST`, `AIDEVBRIDGE_VM_USER`, `AIDEVBRIDGE_VM_PASSWORD_USER`
and the same test socket.
[CONTRIBUTING.md](../../CONTRIBUTING.md#live-tests-against-a-test-host) explains
each of them and the rules for the socket name. `.github/workflows/ci.yml`
runs the frontend tests and build on Linux, the Rust checks on Windows, Linux
and macOS, the license check on Linux and the script tests on Windows, also
without an SSH host.
`.github/workflows/packages.yml` builds the installers, installs each one on
a fresh runner and starts the app until its window appears; see
[Release packages in CI](#release-packages-in-ci).

## Release build

```sh
npm run build:app
```

This runs `tauri build --no-bundle` and produces
`target/release/aidevbridge.exe` with the frontend embedded. Use it for
yourself: the bare EXE carries no license notices, so pass on only the
packages from `npm run build:windows`.

## Windows packages

```powershell
npm run build:windows
```

This needs Windows x64, PowerShell 7, Node.js 24 or newer, the pinned Rust
toolchain, the MSVC Build Tools and a clean, committed Git checkout; a source
ZIP downloaded from GitHub only works with `npm run build:app`. Keep the
checkout path short: the run builds 140 characters and more below it, and the
MSVC linker fails with `LNK1104` once a path exceeds 260 characters. The pipeline
installs the locked npm dependencies, fetches the locked Cargo dependencies
and downloads three pinned WiX and NSIS build tools from their upstream URLs,
checking their hashes. From one native build it creates the MSI, the setup
EXE and the ZIP, each with the same offline `licenses` folder, checks the ZIP
contents and writes `release-manifest.json` with the SHA-256 of every
package to `out/release-windows/<run-id>/artifacts/`. Recheck a run with:

```powershell
node scripts/release-windows-artifacts.mjs verify out/release-windows/<run-id>
```

The license selection `docs/release/license-selection.windows-x64.json`
binds the app's inputs by hash and stops the build when one of them changed.
Review the change and update only the affected records; do not refresh all
hashes to get past a failure. `node scripts/release-license-rebind.mjs <path>...`
shows which records the named files would change and writes them with
`--write`; `--add` binds a new input file, and files of a dependency need
`--third-party` after reviewing its new version. It never adds or changes a
license decision. `node scripts/release-licenses.mjs check` confirms the
result; `npm run licenses:status` lists every difference across all three
selections, and [the license guide](../lizenzen-pflegen.md) (in German) describes the
whole routine. The pipeline does not sign, install or publish anything.

## macOS disk image

```sh
npm run build:macos
```

This needs macOS on Apple silicon, the Xcode Command Line Tools, Node.js 24
or newer, the pinned Rust toolchain with both Apple targets
(`rustup target add --toolchain 1.97.1 aarch64-apple-darwin x86_64-apple-darwin`)
and a clean, committed Git checkout. It builds one universal binary for Apple
silicon and Intel, packs the app and its DMG, signs them ad-hoc and checks
the result: both architectures, only system libraries linked, nothing in the
bundle but the program, its icon, the `licenses` folder and the signature,
and the same app inside the DMG. `release-manifest.json` with the SHA-256 of
the DMG lands in `out/release-macos/<run-id>/artifacts/`. When the Apple
secrets named in
[the design](../specs/2026-10-25-macos-lieferung-design.md) are set, it
signs with a Developer ID and notarizes instead.

The macOS license selection
`docs/release/license-selection.macos-universal.json` is derived from the
Windows one by `node scripts/release-license-select-macos.mjs --write`; check
it with `node scripts/release-licenses.mjs check macos-universal`. The rebind
helper updates both selections at once. `npm run build:macos -- --preview`
builds any clean commit without the bound selection: such a disk image
carries a note instead of the license texts and is not for passing on.

## Release packages in CI

`.github/workflows/packages.yml` makes a preview of the macOS disk image for
every pull request and every push to `main` and installs and starts it on an Apple silicon
and an Intel Mac. A tag `v<version>` makes the release builds of all
packages: MSI, setup EXE and ZIP with `npm run build:windows` on Windows, the
disk image with `npm run build:macos` on macOS. Each package is installed on
a fresh runner and the app started until its window appears; then the
workflow attaches them, with the `.sha256` of the disk image, to the release
of the tag and writes a Windows and a macOS part into its text, creating the
release if there is none. A manual run with **release** on makes the release
builds of a branch without publishing them; a manual run naming an existing
tag builds that tag and attaches only the files its release still lacks. A
published file is never replaced by different content: a platform whose files
are all attached stays as it is, and if a platform is only partly attached, an
attached file whose digest differs from the new build, or that has no digest,
stops the run before anything is attached. To rebuild such a file on purpose,
delete it from the release by hand and run the workflow again. Only the run
of the tag itself records a build provenance for the files it attaches
(`actions/attest-build-provenance`, see
[Check a download](install.md#check-a-download)); a manual run that names a tag
but starts from another ref, such as a branch, would record that ref as the
source, so it attaches without provenance and says so in a warning.

## Android

`.github/workflows/android.yml` builds an unsigned preview APK for every pull
request and every push to `main`, and on a tag `v*` the signed APK and App Bundle
for arm64, armv7 and x86_64. The project lies in `src-tauri/gen/android`; building
it locally and publishing it is described in
[the Android guide](../android-veroeffentlichung.md) (in German).

## Images

The pictures in the README, the social preview and the phone screenshots of the
store listing are rendered from the real interface with sample data, without a host
and without new dependencies. Run this after a release that changes the interface;
it needs Microsoft Edge or `AIDEVBRIDGE_BROWSER`:

```sh
node scripts/readme-images/render.mjs
```

## Why not `cargo build --release`

A plain `cargo build --release` produces a binary that does not embed the
frontend. It loads `devUrl` (`http://localhost:1420`) instead, so without a
running Vite dev server the window shows `ERR_CONNECTION_REFUSED`. The build
succeeds, and nothing about the binary looks wrong until you start it.

The switch is the `custom-protocol` Cargo feature: tauri's build script
derives `dev = !has_feature("custom-protocol")`, and `generate_context!`
embeds `frontendDist` only when `dev` is false. The Tauri CLI passes that
feature on a release build; cargo on its own never does. Do not enable it in
`src-tauri/Cargo.toml`: a feature declared there is also active under
`tauri dev`, and the dev window would then load a stale embedded `dist/`
instead of the Vite server. If you need cargo directly:

```sh
npm run build   # tauri build runs this as beforeBuildCommand; cargo does not
cargo build --release --features tauri/custom-protocol
```
