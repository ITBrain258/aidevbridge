# Security policy

aidevbridge is an app for Windows, macOS and Android that connects to your own
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
  exact commit, and your Windows, macOS or Android version;
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
| Latest release (0.3.x) | Yes |
| Older releases | No |

The app doesn't update itself. To hear about fixes, watch the repository's
releases (Watch → Custom → Releases).

## Scope

In scope:

- the app: the Windows, macOS and Android builds, their web view frontend
  (WebView2 on Windows, WebKit on macOS, the system WebView on Android), the
  Rust backend and the commands
  the frontend may call;
- SSH: host key checks against `~/.ssh/known_hosts`, confirming a new host
  key, and signing in with a key file, a password or an SSH agent: the
  Windows OpenSSH agent, or on macOS the agent of `SSH_AUTH_SOCK`; on Android
  the keys generated in or imported into the app;
- remote output: everything a host sends to a terminal is untrusted,
  including links (they open only for `http` and `https` and only with
  Ctrl+click; a link whose text doesn't show its address shows the address
  first) and clipboard writes via OSC 52;
- the commands the app runs on your hosts (tmux, status polling);
- the release scripts, the workflow that builds, attests and publishes the
  packages, and the packages themselves: the setup EXE, the MSI and the ZIP
  for Windows, the disk image for macOS and the APK and App Bundle for Android.

Out of scope:

- vulnerabilities in your hosts, OpenSSH, tmux or the AI agents themselves;
- attacks that already need your user account or administrator rights on
  your machine;
- vulnerabilities in dependencies that don't affect aidevbridge; please
  report them upstream. `vendor/russh` is russh 0.65.1 with four local
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

On Android (from 0.2.4, see `docs/specs/2026-10-27-android-design.md`, in German) all
of this lives in the app's private storage, which other apps cannot
read: `settings.toml` under `io.github.itbrain258.aidevbridge/` and
`known_hosts` under `.ssh/`. On Android only, removing a host also removes
the host key lines the app wrote for its name and port; other saved hosts
with the same address then ask to confirm the key again. The file is replaced
atomically, and comments, `@revoked` lines, alias lists, hashed names and
patterns stay untouched. Keys you generate or import in the app are stored
there too (`.ssh/aidevbridge_ed25519`, `.ssh/imported_<type>`, each with its
`.pub`). The app excludes its storage from Google's cloud backup and
from the transfer to a new device.

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
its host key again. russh 0.65.1, which aidevbridge uses, asks the app's
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

### A known host that presents a key of another type gets the first-contact question

`known_hosts` can list a host with a key of one type, for example ed25519.
If the server then presents a key of a type the file does not list for that
host, for example ECDSA, aidevbridge does not refuse it as a changed key: it
asks as on a first contact, with one more sentence that names the key type
the host is already trusted with and tells you to reject unless you changed
the server. A different key of a type the file does list is refused without
a question. OpenSSH refuses in both cases.

What it means: someone who can intercept the connection can offer only a key
type that the file does not list for the host, and so gets the question
instead of the refusal. The connection still needs your **Trust and
continue**; if you did not change the server's keys, choose **Reject**.

Why it is accepted for now: the question is never skipped and says which key
type the host was trusted with, and the app asks a server for the key types
it already knows first, so a server that still has its known key does not
get there. One exception: a host known only by its RSA key, whose server can
sign with that key only as `ssh-rsa` (SHA-1) and also has a key of another
type, gets the question although nothing changed, because `ssh-rsa` stays
the last resort. The app is still under development, and the stricter rule
is planned.

To resolve: refuse such a key as a changed key, as OpenSSH does.

### Clipboard writes from programs when tmux passes them on

Programs in a terminal can set the clipboard with the escape sequence
OSC 52. aidevbridge writes the text of every valid OSC 52 sequence that
reaches its terminal to the local clipboard. It never answers a request to
read the clipboard, drops anything larger than 1 MiB, and the WebView
writes only while the app's window has the focus.

Which sequences reach the terminal is decided by tmux: by its option
`set-clipboard` and, from tmux 3.3 on, by `allow-passthrough` (see below).
The app sets neither and starts tmux without `-f`, so your `~/.tmux.conf`
applies, on the app's own socket as on tmux's default socket. With
`external`, tmux's default, only tmux's own copies arrive (a drag or
double-click with `set -g mouse on`); tmux drops OSC 52 from programs, as
long as passthrough is off. With `on`, any program in the session, or text
it prints, such as a file shown with `cat`, can replace your clipboard.
Pasted into a shell without bracketed paste, such text can run commands you
didn't intend (pastejacking). The app removes control characters from
everything you paste (all C0 characters except tab, line feed and carriage
return, plus DEL and the C1 range), so pasted text cannot end bracketed paste
early with its own `ESC [201~` and have the rest run as typed input. Line
breaks stay: in a shell or program without bracketed paste, each pasted line
still runs as you paste it. On Android, text that a keyboard app inserts
from its own clipboard (such as a clipboard suggestion of the keyboard)
arrives as typed input and is not filtered; the system menu's **Paste** is.

Why it is accepted: the app follows your tmux configuration and version.
Forcing `external` would take the built-in copy commands of the agents away
from users who set `on` on purpose.

To avoid it, leave `set-clipboard` at `external`, or set it to `off`, which
also stops tmux's own copies from reaching the clipboard. Also leave tmux's
`allow-passthrough` at `off`, its default (the option exists since tmux
3.3, the value `all` since 3.4): with `on` or `all`, a program can wrap
OSC 52 in tmux's passthrough sequence (`ESC Ptmux; … ESC \`), tmux hands
the inner sequence on to the app's terminal, and the app writes it to the
local clipboard even with `set-clipboard external`. tmux before 3.3 has no
such option and always passes these sequences on, so on tmux 3.0 to 3.2a
(Ubuntu 22.04 ships 3.2a) `set-clipboard` does not stop them, not even
`off`; only a newer tmux avoids it.

To resolve: no change is planned; the behavior follows your tmux
configuration and version.

### Known advisory: RUSTSEC-2023-0071 (`rsa`)

`cargo audit` reports RUSTSEC-2023-0071 ("Marvin Attack") for the `rsa`
crate. The attack recovers an RSA private key by precisely timing many
decryptions or signatures made with it. `rsa` 0.10.0 of 8 November 2026 is
the first fixed version; aidevbridge still carries the release candidate
0.10.0-rc.18.

aidevbridge uses `rsa` only to sign the SSH login with your own RSA key file,
on your machine and with blinding, and, through russh, to verify RSA host
keys, which needs no private key. It never decrypts. The app signs only
while it logs in: once for each of the two SSH connections it opens to a
host, and again when it reconnects or repairs one of them. A host with a key
file without passphrase is reconnected automatically after a lost
connection, and a lost control connection is repaired after about two
seconds, each time with one signature. A server you are connected to can
therefore ask for further signatures by dropping a connection: at most one
every few seconds, for as long as the app stays connected to it. The defence
against the attack is the blinding, which the app applies to every signature
with fresh randomness; the limited rate only adds to it. We accept the
advisory for that reason; the audit workflow (`.github/workflows/audit.yml`) ignores it, while
a local `cargo audit` still reports it. Where you can, use an ed25519 key.

To resolve: move to `rsa` 0.10.0. Besides the exact pins on the release
candidate in `src-tauri/Cargo.toml` and in the vendored russh 0.65.1, the
app's own `rsa` line asks for the feature `sha2`, which 0.10.0 dropped,
and PKCS#1 v1.5 signatures now need the feature `pkcs1v15`. Two more pins of
the vendored russh stand in the way: `ssh-key` 0.7.0-rc.11
asks for an `rsa` feature (`sha2`) that 0.10.0 dropped, so russh needs
`ssh-key` 0.7.0-rc.12, and `pkcs1` 0.8.0-rc.4, while `rsa` 0.10.0 needs
`pkcs1` 0.8.0. The move therefore changes the patched russh. It comes with a
russh release that takes these versions, or as an update of the vendored
copy of its own.

### Known advisories for the vendored russh and expected audit warnings

Since 30 October 2026 the vendored `russh` is 0.65.0, and since 5 November
2026 0.65.1, which fixes every advisory published for russh up to then.
Three of them reach an SSH client and affect aidevbridge 0.2.4 and earlier,
which carry russh 0.63.2:

- [GHSA-3hm4-p7h4-rvwp](https://github.com/warp-tech/russh/security/advisories/GHSA-3hm4-p7h4-rvwp)
  (high): a host key with nested OpenSSH certificates exhausts the stack
  during the key exchange, before the host key is checked;
- [GHSA-4p9f-7p9m-5vfg](https://github.com/warp-tech/russh/security/advisories/GHSA-4p9f-7p9m-5vfg):
  repeated `EXT_INFO` messages grow the client's memory without bound
  before authentication;
- [GHSA-fw5c-8223-6h42](https://github.com/warp-tech/russh/security/advisories/GHSA-fw5c-8223-6h42):
  a peer that declares a maximum packet size of 0 stalls the writes of a
  channel for good; the app writes terminal input that way.

A server you connect to can so make those versions crash or hang; the first
one also an attacker on the network, because it strikes before the host key
is checked. None of the three reads or changes session data. Version 0.2.5 contains the fix.
The advisories for russh's server and agent code (GHSA-j7h2-66j4-ghjf,
GHSA-4wc5-f2rc-q74m, GHSA-9wfm-jcj8-jfv9, GHSA-vp5q-ff62-jwqv) are fixed as
well; aidevbridge never ran that code. The app is an SSH client: it doesn't
accept SSH connections and doesn't act as an SSH agent; it talks to the SSH
agent (the Windows OpenSSH agent, or on macOS the agent of `SSH_AUTH_SOCK`)
as a client. Its tests start russh servers on 127.0.0.1 as test peers,
nothing else does.

Two low advisories published on 3 November 2026 cover russh 0.65.0, which
0.2.5 and 0.2.6 carry, but not the app; 0.65.1, which 0.2.7 carries, fixes
both:

- [GHSA-9264-jvgf-6w2f](https://github.com/warp-tech/russh/security/advisories/GHSA-9264-jvgf-6w2f):
  russh calls the client callback `kex_done` with the shared secret of the
  key exchange before the host key is checked. aidevbridge doesn't
  implement `kex_done`; russh's default does nothing with the secret, and
  the connection fails at the host key check as before.
- [GHSA-736f-c93q-9fwx](https://github.com/warp-tech/russh/security/advisories/GHSA-736f-c93q-9fwx):
  russh's SSH agent server can sign with a key that needs confirmation
  after the agent was locked. aidevbridge doesn't act as an SSH agent and
  never runs that code.

The audit workflow listed both as accepted until the vendored russh moved
to 0.65.1.

Neither `cargo audit` nor Dependabot sees the vendored copy: both match only
packages that `Cargo.lock` records with a registry source, and the vendored
russh has none. That is how the three client advisories above went unnoticed
for five days. The audit workflow therefore also checks every vendored crate
against the advisories of GitHub's advisory database and of its upstream
repository, which publishes them days earlier
(`scripts/check-vendored-advisories.mjs`), and fails when one covers the
vendored version. An advisory that can't affect the app is accepted there
with its reason, as RUSTSEC-2023-0071 is for `cargo audit`.

GitHub may also report advisories for `vendor/russh/Cargo.lock`, for
example for `pageant` 0.2.4, `crypto-bigint`, `ctutils`, `tokio` or
`crossbeam-epoch`. That file is the lockfile of the published russh source,
kept unchanged with it; no build reads it. aidevbridge builds with the
`Cargo.lock` at the repository root, which has pageant 0.2.5, crypto-bigint
0.7.10, ctutils 0.4.7 and tokio 1.54.1 and doesn't contain
`crossbeam-epoch`.

`cargo audit` on the root `Cargo.lock` also reports these notices. The audit
workflow fails on any `unsound` notice and ignores the one for `glib` by
flag, until `glib` is 0.20 or newer or gone from `Cargo.lock`;
`unmaintained` and `yanked` notices are warnings and don't fail it:

- `glib` 0.18 (RUSTSEC-2024-0429,
  [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)):
  unsound `VariantStrIter`, fixed in 0.20;
- `proc-macro-error` 1.0.4 (RUSTSEC-2024-0370): unmaintained; a helper of
  `glib`'s macros;
- `zbus_names`, `zvariant` and `zvariant_derive` (RUSTSEC-2026-0371,
  RUSTSEC-2026-0370 and RUSTSEC-2026-0372): unmaintained; D-Bus code of
  `tauri-plugin-opener`;
- `async-executor` 1.14.0: yanked, because dropping an `Executor` could use
  freed memory (fixed in 1.14.1); it comes in through `zbus`, the D-Bus code
  of `tauri-plugin-opener`.

None of these is in a package the project ships. Tauri uses `glib`, and with
it `proc-macro-error`, only for its Linux GTK backend, and
`tauri-plugin-opener` uses D-Bus only on Linux: `cargo tree -i glib` (and
the same for `proc-macro-error`, `zbus_names`, `zvariant` and
`async-executor`) with `--target x86_64-pc-windows-msvc`,
`--target aarch64-apple-darwin`, `--target x86_64-apple-darwin` or
`--target aarch64-linux-android` finds nothing. The `unic` crates that
Tauri used through `urlpattern` until 2.12 are no longer in `Cargo.lock`.

To resolve: the warnings go away when Tauri and its plugins move to newer
GTK and D-Bus crates.

### Known advisories for Jackson in the Android app

The Android app contains `jackson-core` and `jackson-databind` 2.15.3, with
`jackson-annotations` and `jackson-datatype-json-org`. They come with
Tauri's Android library (`tauri` 2.12.5), which pins that version; the
desktop packages contain no Java code. GitHub's advisory database lists 15
advisories for 2.15.3, seven of them rated high, published between February
and October 2026 and fixed in 2.18.11: denial of service through very long
numbers or tokens and through forward references, bypasses of the validators
for polymorphic types, and name lookups while reading `InetAddress`,
`InetSocketAddress` or `Path` values.

The app doesn't use Jackson in a way these need. Tauri reads with it only the
calls to the app's Android plugins and their configuration: JSON that Tauri's
Rust side writes, read with `ObjectMapper.readValue` into fixed classes,
without default typing or `@JsonTypeInfo` (`mobile/android` in the `tauri`
crate, `Invoke.kt` and `PluginManager.kt`). Text from a host, such as a link
you open, can reach it only as a string inside well-formed JSON.

To resolve: the advisories go away when Tauri moves to a fixed Jackson
version, or with a Gradle constraint on 2.18.11 in the app. That needs its own
pull request: lockfile, `verification-metadata.xml`, the license check and a
test on Android 7.0. Dependabot and the audit workflow don't check the
Android libraries.

### Unsigned binaries and checking a download

The Windows packages (setup EXE, MSI and ZIP) are not code-signed, so
Windows SmartScreen warns about an unknown publisher, and Smart App Control,
when it is on, doesn't start them. The macOS disk image and the app in it
are signed ad-hoc only and not notarized, so macOS refuses the first start
until you choose **Open Anyway** (see the
[install guide](docs/guide/install.md#macos)). So neither system can
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
check doesn't rely on the release: from 0.2.4 on, the workflow
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
built by another workflow or for another version doesn't pass. The Android
APK and App Bundle are built and attested by `android.yml`; for them, use
`--signer-workflow ITBrain258/aidevbridge/.github/workflows/android.yml`. GitHub CLI
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

The workflow is prepared to sign and notarize the macOS app as soon as the
Apple secrets (`APPLE_*`) are stored in the repository; none is stored
today. Before they are, signing and notarization must move into a separate
step or job that gets only the built app. Today the secrets would go to the
step that builds the disk image, and that step also runs `npm ci` with the
lifecycle scripts of the npm dependencies and `tauri build` with the build
scripts (`build.rs`) and procedural macros of all Rust dependencies. Any of
that code could read the signing certificate, its password and the
notarization key from its environment.

### Android: keys generated in the app have no passphrase

A key that "Generate new key…" creates on Android has no passphrase, so that
a connection needs no input and the app can reconnect by itself. It is
protected by Android's app sandbox and by the exclusion from backups, not by
encryption at rest of its own. Someone who can read the app's private
storage (a rooted device, or a debug build of the app) can read the key.
Importing a key copies the chosen file as it is, so an encrypted key stays
encrypted and asks for its passphrase on each connection. What would
resolve it: wrapping keys with a key from the Android Keystore.

The release signing key of the Android app reaches only the `sign` and
`play` jobs of `.github/workflows/android.yml`, through the GitHub
environment `android-release`. The job that builds the app, and with it runs
npm, Gradle and every Rust build script, gets no secret; the same rule as for
the planned Developer ID signing on macOS. `scripts/android-github-secrets.ps1`
allows the environment for tags `v*` only: without that rule, any workflow on
any branch of this repository could name the environment and read the key.
A repository ruleset ("Release tags v*") lets only an admin create, move or
delete such a tag, so a workflow or a token without admin rights cannot get
code signed by tagging it.

### The system web view on systems without updates

The window is drawn by the web view of the system: WebView2 on Windows, the
WebKit of macOS, Android System WebView (or Chrome) on Android. The app ships
none of them and gets their security fixes only through the system. On
macOS 12, WebKit is renewed only with macOS updates, not with a newer
Safari, and Apple brings security fixes only to recent macOS versions:
macOS 12 and 13 get none any more. On Android 7 to 9
Google no longer updates the web view (Android 7 stops at version 119,
Android 8 and 9 at 138). The app needs macOS 12.4 and Android System WebView
105, so it runs on such systems, but a flaw in their web view stays open
there.

Why it is accepted: the app loads no web pages. It shows its own interface
from the app bundle, the CSP allows no outside scripts, and the output of
your hosts reaches the screen as text through xterm.js. Requiring the
versions the vendors still support would lock out working systems. If you
can, keep the system and its web view up to date.

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
