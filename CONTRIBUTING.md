# Contributing to aidevbridge

Thank you for your interest. aidevbridge has a single maintainer who reviews
issues and pull requests as time allows; there is no response deadline.

## Before you start

- **Bugs:** open an issue with the bug report template. It asks for the line
  from Settings → About → **Copy version info**.
- **Larger changes:** open an issue first and describe the idea, so that we
  can agree on the approach before you write code.
- **Security problems:** never in a public issue; see [SECURITY.md](SECURITY.md).
- **Scope:** aidevbridge installs nothing on a host, writes nothing there and
  reads agent status only from read-only sources. Changes that need a hook, a
  daemon or a configuration change on the host are out of scope.

## Build and test

You need Windows 10 or 11 (x64) or macOS 11 or newer, the Rust toolchain
from `rust-toolchain.toml` (installed by `rustup` on first use), Node.js 24
or newer and, on Windows, the Microsoft C++ Build Tools (MSVC) and the
WebView2 Runtime, on macOS the Xcode Command Line Tools; see the
[build guide](docs/guide/building.md).

```sh
npm ci
npm run tauri -- dev
```

Before you open a pull request, all of these must pass:

```sh
npm test
npm run test:scripts
npm run build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all
```

They need no SSH host. Tests that would need one return early, print a line
starting with `SKIP` (visible with `-- --nocapture`) and still count as
passed, so a green run does not prove a real SSH connection.

`.github/workflows/audit.yml` checks `Cargo.lock` with `cargo audit` and the
runtime packages in `package-lock.json` with `npm audit --omit=dev` against
known security advisories: weekly, on every change of either lockfile or of
`vendor/`, and when started by hand. It is not part of the checks above, which `ci.yml` runs
(see [Tests](docs/guide/building.md#tests)), and a new advisory can turn it red without
any change here. `cargo audit` checks only packages that `Cargo.lock`
records with a registry source and never matches advisories against a path
dependency such as the vendored russh in `vendor/russh`; a third job runs
`scripts/check-vendored-advisories.mjs` for those, against GitHub's advisory
database and the upstream repository's own advisories
([SECURITY.md](SECURITY.md)). The `cargo audit` job ignores RUSTSEC-2023-0071 (`rsa`), which has no
fixed version; SECURITY.md explains why the app accepts it, and also lists
the warnings `cargo audit` prints without failing.

## Live tests against a test host

Some integration tests and the VM acceptance suite
(`src-tauri/tests/acceptance_vm.rs`) talk to a real Linux host over SSH. Use
a disposable test host, never a machine with sessions you care about.

- Set `AIDEVBRIDGE_TEST_HOST` to the host and `AIDEVBRIDGE_TEST_USER` to the
  SSH account on it; there is no built-in account. Tests that check the
  host's real key also need `AIDEVBRIDGE_TEST_HOST_KEY`: the base64 part of
  `ssh-keyscan -t ed25519 <host>`, compared with a trusted source such as
  your own `known_hosts`. Without it they fail instead of skipping.
- The acceptance suite is ignored by default. For it also set
  `AIDEVBRIDGE_VM_HOST`, `AIDEVBRIDGE_VM_USER` (the account for key
  authentication) and `AIDEVBRIDGE_VM_PASSWORD_USER` (a disposable account
  without `authorized_keys`), and pass `--include-ignored`. The password
  branch also needs `AIDEVBRIDGE_VM_PASSWORD`; without it that branch is
  skipped.
- Always set `AIDEVBRIDGE_TEST_SOCKET` to a tmux socket name reserved for this
  run, for example `abtest_20261020_run1`. Both suites reject a missing or
  invalid name before they connect; there is no fallback to the app's socket.
- A valid name has 1 to 48 ASCII letters, digits, `_` or `-`. `agentbridge`
  (the app's socket), `default`, paths and whitespace are rejected. The PTY
  and tmux tests derive further names such as `<socket>_pty2` and
  `<socket>_tmux3`: reserve the base name and all its suffixes for the run.
  The check cannot tell whether someone else on the host already uses a name.
- Run with `--no-fail-fast` and `--nocapture` and keep the output: skipped
  branches (RSA key, password, SSH agent) are only visible there.
- Run with `--test-threads=4`: the key preparation admits eight jobs per
  test process, and with the default thread count about twelve live
  command tests fail at that admission.

```sh
AIDEVBRIDGE_TEST_HOST=<test host> AIDEVBRIDGE_TEST_USER=<account> \
AIDEVBRIDGE_TEST_HOST_KEY=<base64 key> AIDEVBRIDGE_TEST_SOCKET=abtest_20261020_run1 \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --all --no-fail-fast -- --nocapture --test-threads=4
```

- tmux leaves the socket file behind when its server ends. After the run, end
  the servers of your own test sockets (`tmux -L <socket> kill-server`, for
  the base name and each suffix) and delete their leftover socket files.
  Never touch the `agentbridge` socket or anyone else's.
- The remaining variables (`AIDEVBRIDGE_TEST_RSA_KEY` for the RSA branch,
  `AIDEVBRIDGE_VM_KEY_PATH` for a key file other than `~/.ssh/id_ed25519`)
  and the setup are documented in `src-tauri/tests/common/mod.rs` and
  `src-tauri/tests/acceptance_vm.rs`.
  `cargo test --locked --test test_environment` checks these rules without
  connecting anywhere.

## Pull requests

- One topic per pull request. Changed behaviour comes with a test that fails
  without the change.
- Commit messages are in English: `type(scope): summary`, for example
  `fix(sidebar): keep focus on the host bar after a reload`.
- Say in the description what you changed, why, and how you tested it. Review
  aims for one round.
- All text of the user interface lives in `src/i18n/en.json`.
- The three release license selections
  (`docs/release/license-selection.*.json`) bind the app's sources by hash. For
  a change to your own code you do not need to update them; the maintainer
  rebinds them before a release. A pull request that changes a dependency
  needs its license review in the same pull request: the CI job `licenses` fails
  otherwise ([guide](docs/lizenzen-pflegen.md), in German). The packages workflow
  builds a preview disk image of your pull request, which does not need them.

## Releases

1. `npm run bump <version>` and a CHANGELOG entry.
2. Bring the three license selections up to date with `npm run licenses:status`
   and `npm run licenses:rebind-own`, set the version at its places by hand and
   confirm with `npm run licenses:check`. [The license guide](docs/lizenzen-pflegen.md)
   (in German) describes every case.
3. Optionally start the packages and Android workflows by hand with **release**
   on: they make the release builds without publishing them.
4. Push the tag `v<version>`. Only an administrator can create tags `v*`. The
   packages workflow builds MSI, setup EXE, ZIP and the disk image, installs and
   starts each one, and attaches them to the release of the tag, creating it if
   needed; the Android workflow signs and attaches the APK. Do not use a draft,
   which the workflows cannot find. A manual run naming the tag attaches only the
   files the release still lacks. A published file is never replaced by different
   content: a platform whose files are all attached stays as it is, and if a
   platform is only partly attached, an attached file whose digest differs from
   the new build, or that has no digest, stops the run before anything is attached.
   To rebuild such a file on purpose, delete it from the release by hand and run
   the workflow again.
5. If the interface changed, render the pictures again
   ([Images](docs/guide/building.md#images)).

## Language

The user interface, the README, the guides under `docs/guide/` and the files
for contributors are in English. The changelog, the other project documents
under `docs/` and code comments are in German; code comments write ä, ö, ü and ß as ae, oe, ue and ss.
Identifiers are English. You may write issues and pull requests in English or
German.

## License of contributions

aidevbridge is licensed under either of the Apache License, Version 2.0, or
the MIT license, at your option. Unless you explicitly state otherwise, any
contribution intentionally submitted for inclusion in this work by you, as
defined in the Apache-2.0 license, shall be dual licensed as above, without
any additional terms or conditions.
