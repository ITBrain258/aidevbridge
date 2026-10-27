# Security policy

aidevbridge is a Windows and macOS desktop app that connects to your own
Linux hosts over SSH and shows the tmux sessions your AI coding agents run
there. It handles SSH keys, passwords and host keys, so please report
security problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
[report a vulnerability](https://github.com/ITBrain258/aidevbridge/security/advisories/new)
(Security tab → "Report a vulnerability"). Please keep details out of public
issues, discussions and pull requests.

Please include:

- the aidevbridge version (Settings → About → "Copy version info") or the
  exact commit, and your Windows or macOS version;
- what an attacker can do and what they need for it;
- minimal steps to reproduce, ideally against a disposable test host;
- a suggested fix, if you have one.

Remove passwords, private keys, tokens and unrelated terminal output from
your report.

aidevbridge has a single maintainer. Reports are read as time allows; there
is no fixed response time. Findings, the fix and the disclosure are discussed
in the private report. Once a fixed release is out, a GitHub security
advisory describes the problem.

## Supported versions

Only the latest release receives security fixes. Fixes ship as a new
release; older versions are not patched.

| Version | Supported |
| --- | --- |
| Latest release (0.2.x) | Yes |
| Older releases | No |

The app doesn't update itself. To hear about fixes, watch the repository's
releases (Watch → Custom → Releases).

## Scope

In scope:

- the app: the Windows and the macOS build, their web view frontend
  (WebView2 on Windows, WebKit on macOS), the Rust backend and the commands
  the frontend may call;
- SSH: host key checks against `~/.ssh/known_hosts`, confirming a new host
  key, and signing in with a key file, a password or an SSH agent: the
  Windows OpenSSH agent, or on macOS the agent of `SSH_AUTH_SOCK`;
- remote output: everything a host sends to a terminal is untrusted,
  including links (they open only for `http` and `https` and only with
  Ctrl+click; a link whose text doesn't show its address shows the address
  first) and clipboard writes via OSC 52;
- the commands the app runs on your hosts (tmux, status polling);
- the release scripts, the workflow that builds, attests and publishes the
  packages, and the packages themselves: the setup EXE, the MSI and the ZIP
  for Windows and the disk image for macOS.

Out of scope:

- vulnerabilities in your hosts, OpenSSH, tmux or the AI agents themselves;
- attacks that already need your user account or administrator rights on
  your machine;
- vulnerabilities in dependencies that don't affect aidevbridge; please
  report them upstream. `vendor/russh` is russh 0.63.2 with four local
  changes, described in `vendor/russh/AGENTBRIDGE-PATCH.md`: a received
  channel Close is acknowledged at once and drops the channel's unsent data;
  a channel-end observer reports how a client channel ended; terminal
  channels get a manual receive window; and the sign-in calls return an
  error instead of an empty method list when the session ends before the
  server answers. Report problems in those changes here and everything else
  to russh.

## What the app stores and sends

- `settings.toml`: your hosts (name, address, port, user, the path of a key
  file, the sign-in method), the app settings and the workspace (open
  terminals with their session names, recently used remote folders). On
  Windows it is in `%APPDATA%\io.github.itbrain258.aidevbridge\`, on macOS
  in `~/Library/Application Support/io.github.itbrain258.aidevbridge/`;
  Settings → About shows the exact path. Passwords and passphrases are never
  stored; they stay in memory only while a connection is being made. The
  app saves the file through a new temporary file next to it
  (`settings.toml.<number>.<number>.tmp`), written to disk before it
  replaces `settings.toml`. If the app or the computer stops at that
  moment, such a file stays behind; the next start of the app deletes it
  once it is at least ten minutes old. A younger one stays, because it may
  belong to another aidevbridge window that is saving right now (see
  "Several windows at the same time" below).
- `~/.ssh/known_hosts` (on Windows `%USERPROFILE%\.ssh\known_hosts`): a host
  key you confirm on first contact is appended to this file, which OpenSSH
  uses as well. The app never rewrites or removes lines there, so the
  entries stay after you uninstall.
- Window position and size, in `.window-state.json` in the same folder as
  `settings.toml`, and the data of the web view: on Windows the WebView2
  data folder `%LOCALAPPDATA%\io.github.itbrain258.aidevbridge\`, on macOS
  the WebKit data under `~/Library/WebKit/io.github.itbrain258.aidevbridge/`
  and `~/Library/Caches/io.github.itbrain258.aidevbridge/`. Its local
  storage holds only the color theme.

The app writes no log files. It talks only SSH, to the hosts you add;
Ctrl+click on a link opens your default browser. If WebView2 is missing, the
setup EXE and the MSI download Microsoft's WebView2 bootstrapper and run it,
which installs the WebView2 runtime; the ZIP expects WebView2 to be
installed. On macOS the app uses the system's WebKit.

## Known limitations and accepted risks

These are the weak points aidevbridge knowingly accepts for now, each with
the reason and what would resolve it. If you find that one of them is worse
than described here, please report it privately.

### SHA-1 signatures for servers that offer only `ssh-rsa`

aidevbridge still uses the old SSH algorithm `ssh-rsa`, which signs with
SHA-1, in two places, and only when the server offers nothing better:

- **Host key:** the app prefers ed25519, ECDSA, `rsa-sha2-512` and
  `rsa-sha2-256`, and takes `ssh-rsa` only from a server that offers none
  of them.
- **Login with an RSA key** (key file or SSH agent): the app signs with
  `rsa-sha2-512` or `rsa-sha2-256` unless the server's `server-sig-algs`
  list names RSA only as `ssh-rsa`. A server that sends no such list gets
  `rsa-sha2-256`.

Why it is accepted: an attacker can't force this fallback. The algorithm
lists of both sides are part of the exchange hash that the server signs
with its host key, so a changed list makes the connection fail, and
`server-sig-algs` arrives already encrypted and authenticated. Both SHA-1
signatures cover the exchange hash of the session, which depends on random
values from both sides, so the known SHA-1 attacks, which need a
chosen-prefix collision, don't apply: a forgery would need a SHA-1 second
preimage. OpenSSH 8.8 and newer turn `ssh-rsa` off by default, so the
fallback concerns only older or specially configured servers, which would
otherwise not work at all.

To avoid it, log in with an ed25519 key, and use servers that offer
`rsa-sha2-256` or `rsa-sha2-512` or a host key other than RSA; OpenSSH
does so since version 7.2.

To resolve: drop the fallback once no supported host needs it.

### No host key check on rekey

During a long session, SSH renews its keys (rekey), and the server presents
its host key again. russh 0.63.2, which aidevbridge uses, asks the app's
handler to check the host key only in the first key exchange of a
connection, and the app checks it there against `known_hosts`. On a rekey
russh doesn't ask again and doesn't compare the presented key with the
first one itself. Upstream russh's main branch behaves the same way.
OpenSSH does check the host key again on a rekey.

Why it is accepted: the rekey messages travel inside the existing
connection, encrypted and authenticated with its current session keys. Only
the server that already proved its host key at the start, or someone who
already holds those session keys, can present another key there, and such
a party can read and change the session anyway. A test runs a session
across a rekey; it fails as soon as a future russh asks the app's host key
check again on a rekey, so the app can be adapted to it.

To resolve: a change in russh that compares the host key on a rekey,
upstream or as a local patch of `vendor/russh`.

### Known advisory: RUSTSEC-2023-0071 (`rsa`)

`cargo audit` reports RUSTSEC-2023-0071 ("Marvin Attack") for the `rsa`
crate; no fixed version exists. The attack recovers an RSA private key by
precisely timing many decryptions or signatures made with it.

aidevbridge uses `rsa` only to sign the SSH login with your own RSA key file,
on your machine and with blinding, and, through russh, to verify RSA host
keys, which needs no private key. It never decrypts. The app signs once per
login and only when you connect, so a server can't collect the many
precisely timed operations the attack needs. We accept the advisory for that
reason; the audit workflow (`.github/workflows/audit.yml`) ignores it, while
a local `cargo audit` still reports it. Where you can, use an ed25519 key.

To resolve: update `rsa` as soon as a fixed release exists.

### Known advisories for the vendored russh and expected audit warnings

GitHub reports two advisories for the vendored `russh` 0.63.2:

- [GHSA-j7h2-66j4-ghjf](https://github.com/advisories/GHSA-j7h2-66j4-ghjf):
  a russh SSH server accepts a public key login whose signature uses a
  different algorithm than the request names (fixed in 0.64.0);
- [GHSA-4wc5-f2rc-q74m](https://github.com/advisories/GHSA-4wc5-f2rc-q74m):
  russh's SSH agent server allocates unbounded memory for crafted
  constraint records (fixed in 0.64.1).

Both affect only server code that aidevbridge never runs. The app is an SSH
client: it doesn't accept SSH connections and doesn't act as an SSH agent;
it talks to the SSH agent (the Windows OpenSSH agent, or on macOS the agent
of `SSH_AUTH_SOCK`) as a client. Its tests start russh servers on
127.0.0.1 as test peers, nothing else does. The vendored copy stays on
0.63.2 because of its local changes.

GitHub may also report advisories for `vendor/russh/Cargo.lock`, for
example for `crypto-bigint`, `ctutils`, `tokio` or `crossbeam-epoch`. That
file is the lockfile of the published russh source, kept unchanged with it;
no build reads it. aidevbridge builds with the `Cargo.lock` at the
repository root, which has the fixed versions crypto-bigint 0.7.10, ctutils
0.4.6 and tokio 1.53.3 and doesn't contain `crossbeam-epoch`.

The audit workflow doesn't cover path dependencies: `cargo audit` checks
only packages that `Cargo.lock` records with a registry source, and the
vendored russh has none. The russh advisories above are therefore tracked
here by hand.

`cargo audit` on the root `Cargo.lock` also prints these warnings, which
don't fail the audit workflow:

- `glib` 0.18 (RUSTSEC-2024-0429,
  [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)):
  unsound `VariantStrIter`, fixed in 0.20;
- `proc-macro-error` 1.0.4 (RUSTSEC-2024-0370): unmaintained; a helper of
  `glib`'s macros;
- `zbus_names`, `zvariant` and `zvariant_derive` (RUSTSEC-2026-0371,
  RUSTSEC-2026-0370 and RUSTSEC-2026-0372): unmaintained; D-Bus code of
  `tauri-plugin-opener`;
- `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`
  and `unic-ucd-version` (RUSTSEC-2025-0081, RUSTSEC-2025-0075,
  RUSTSEC-2025-0080, RUSTSEC-2025-0100 and RUSTSEC-2025-0098):
  unmaintained; Tauri's `tauri-utils` uses them through `urlpattern`.

Of these, the Windows and macOS builds contain only the `unic` crates,
which are marked unmaintained without a known vulnerability. Tauri uses
`glib`, and with it `proc-macro-error`, only for its Linux GTK backend, and
`tauri-plugin-opener` uses D-Bus only on Linux: `cargo tree -i glib` (and
the same for `proc-macro-error`, `zbus_names` and `zvariant`) with
`--target x86_64-pc-windows-msvc`, `--target aarch64-apple-darwin` or
`--target x86_64-apple-darwin` finds nothing.

To resolve: the next russh update moves the vendored copy, and the
lockfile that comes with it, to a version with the fixes (0.64.1 or
newer); the warnings go away when Tauri and its plugins move to newer GTK,
D-Bus and URL pattern crates.

### Unsigned binaries and checking a download

The Windows packages (setup EXE, MSI and ZIP) are not code-signed, so
Windows SmartScreen warns about an unknown publisher, and Smart App Control,
when it is on, doesn't start them. The macOS disk image and the app in it
are signed ad-hoc only and not notarized, so macOS refuses the first start
until you choose **Open Anyway** (see the README). So neither system can
tell you who built a file. Download the files only from the
[releases page](https://github.com/ITBrain258/aidevbridge/releases) and
compare their SHA-256 checksum with the value listed in the release notes
(the release build records it in `release-manifest.json`). In PowerShell:

```powershell
Get-FileHash .\aidevbridge-<version>-windows-x64.zip -Algorithm SHA256
```

On macOS, in Terminal:

```sh
shasum -a 256 ~/Downloads/aidevbridge-<version>-macos-universal.dmg
```

The value it prints (`Hash` in PowerShell, the first field on macOS) must
match the release notes exactly; upper or lower case doesn't matter. If it
doesn't match, don't run the file, and report it through the private form.

The checksum comes from the same release as the file. An optional, stronger
check doesn't rely on the release: from the release after 0.2.3 on, the workflow
`.github/workflows/packages.yml` records a build provenance
(`actions/attest-build-provenance`) for each file that the run of the
release's tag attaches. The provenance is signed through the public Sigstore
instance, kept by GitHub apart from the release files and notes, and ties
the file's SHA-256 to this repository, the workflow, the tag and its commit.
Check it with the
[GitHub CLI](https://cli.github.com/manual/gh_attestation_verify), version
2.68 or newer:

```sh
gh attestation verify aidevbridge-<version>-windows-x64.zip --repo ITBrain258/aidevbridge --signer-workflow ITBrain258/aidevbridge/.github/workflows/packages.yml --source-ref refs/tags/v<version>
```

It must print `Verification succeeded!` and name
`.github/workflows/packages.yml@refs/tags/v<version>` as the build workflow.
`--signer-workflow` requires that this repository's `packages.yml` signed the
provenance, and `--source-ref` requires the tag of that release, so a file
built by another workflow or for another version doesn't pass. GitHub CLI
2.49 to 2.67 lacks `--source-ref`; there,
`gh attestation verify <file> --repo ITBrain258/aidevbridge` is the
fallback. It only checks that a workflow of this repository made the
provenance, not which workflow nor from which tag or branch, so a
provenance from another workflow or another ref of this repository passes
it as well. The command fetches the
provenance from the GitHub API and therefore needs the GitHub CLI signed in
to a GitHub account (`gh auth login`, or a token in `GH_TOKEN`); any account
will do. A manual run that names a tag but starts from another ref, such as
a branch, attaches the files the release still lacks without a provenance,
because the provenance would name that ref as the source. For such a file,
and for every file of 0.2.3 and earlier, the command fails, because GitHub
keeps no provenance for its SHA-256 (current versions of the GitHub CLI
report `HTTP 404: Not Found`), and only the checksum check above applies.
A build provenance is not a code signature: Windows and macOS still treat
the files as unsigned.

To resolve: code signing for the Windows packages, and a Developer ID
signature with notarization for the macOS app.

### Several windows at the same time

You can start aidevbridge more than once; each start opens its own window,
and all of them share one `settings.toml`. Every change of the settings
(adding, editing or removing a host, a preference, the workspace) reads the
file again, applies only that change and writes it through a new temporary
file. Right before that file replaces `settings.toml`, the app reads
`settings.toml` once more. If another window saved in between, it drops its
own write and applies its change again, to the new content. After three
attempts in all it reports that `settings.toml` was changed by another
aidevbridge window at the same time and writes nothing. Between that last
read and the replacement a very short gap remains, because there is no file
lock: a save of another window that lands exactly there is overwritten.

As a result:

- a host another window added stays, and a host it removed stays removed;
  a window reads the host list only when it starts, so it shows such
  changes after a restart;
- if two windows edit the same host, the later save sets all of that
  host's fields, also those the other window changed;
- each preference keeps the value of the window that changed it last;
- the workspace (open terminals, layout, recent folders) is saved as a
  whole, so the next start restores the workspace of the window that saved
  it last; the window position is that of the window that quit last.

Both windows open their own SSH connections and attach to a tmux session
as separate tmux clients, like two terminals attached to the same session:
input from either window reaches the session.

To resolve: a single-instance mode can follow if several windows turn out
to cause problems.
