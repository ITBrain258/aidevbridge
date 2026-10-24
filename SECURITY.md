# Security policy

aidevbridge is a Windows desktop app that connects to your own Linux hosts
over SSH and shows the tmux sessions your AI coding agents run there. It
handles SSH keys, passwords and host keys, so please report security problems
privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
[report a vulnerability](https://github.com/ITBrain258/aidevbridge/security/advisories/new)
(Security tab → "Report a vulnerability"). Please keep details out of public
issues, discussions and pull requests.

Please include:

- the aidevbridge version (Settings → About → "Copy version info") or the
  exact commit, and your Windows version;
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

- the app: the Windows binary, its WebView frontend, the Rust backend and the
  commands the frontend may call;
- SSH: host key checks against `~/.ssh/known_hosts`, confirming a new host
  key, and signing in with a key file, a password or the Windows OpenSSH
  agent;
- remote output: everything a host sends to a terminal is untrusted,
  including links (they open only for `http` and `https` and only with
  Ctrl+click; a link whose text doesn't show its address shows the address
  first) and clipboard writes via OSC 52;
- the commands the app runs on your hosts (tmux, status polling);
- the release scripts and the installers and ZIP they build.

Out of scope:

- vulnerabilities in your hosts, OpenSSH, tmux or the AI agents themselves;
- attacks that already need your Windows account or administrator rights on
  your machine;
- vulnerabilities in dependencies that don't affect aidevbridge; please
  report them upstream. `vendor/russh` is russh 0.63.2 with local patches
  (Close acknowledgement, a channel-end observer and a manual receive window
  for terminal channels, described in `vendor/russh/AGENTBRIDGE-PATCH.md`):
  report problems in those patches here and everything else to russh.

## What the app stores and sends

- `%APPDATA%\io.github.itbrain258.aidevbridge\settings.toml`: your hosts
  (name, address, port, user, the path of a key file, the sign-in method),
  the app settings and the workspace (open terminals with their session
  names, recently used remote folders). Passwords and passphrases are never
  stored; they stay in memory only while a connection is being made.
- `~/.ssh/known_hosts`: a host key you confirm on first contact is appended
  to this file, which OpenSSH uses as well. The app never rewrites or removes
  lines there, so the entries stay after you uninstall.
- Window position and size, in `.window-state.json` in the same folder as
  `settings.toml`, and the WebView2 data folder
  `%LOCALAPPDATA%\io.github.itbrain258.aidevbridge\`, whose local storage
  holds only the color theme.

The app writes no log files. It talks only SSH, to the hosts you add;
Ctrl+click on a link opens your default browser. Installers, once offered,
download the WebView2 runtime from Microsoft if it is missing; the ZIP
expects it to be installed.

## Known advisory: RUSTSEC-2023-0071 (`rsa`)

`cargo audit` reports RUSTSEC-2023-0071 ("Marvin Attack") for the `rsa`
crate; no fixed version exists. The attack recovers an RSA private key by
precisely timing many decryptions or signatures made with it.

aidevbridge uses `rsa` only to sign the SSH login with your own RSA key file,
on your machine and with blinding, and, through russh, to verify RSA host
keys, which needs no private key. It never decrypts. The app signs once per
login and only when you connect, so a server can't collect the many
precisely timed operations the attack needs. We accept the advisory for that
reason and will update `rsa` as soon as a fixed release exists. Where you
can, use an ed25519 key.

## Known advisories in code the app doesn't run

GitHub reports two advisories for the vendored `russh` 0.63.2:

- [GHSA-j7h2-66j4-ghjf](https://github.com/advisories/GHSA-j7h2-66j4-ghjf):
  a russh SSH server accepts a public key login whose signature uses a
  different algorithm than the request names (fixed in 0.64.0);
- [GHSA-4wc5-f2rc-q74m](https://github.com/advisories/GHSA-4wc5-f2rc-q74m):
  russh's SSH agent server allocates unbounded memory for crafted
  constraint records (fixed in 0.64.1).

Both affect only server code that aidevbridge never runs. The app is an SSH
client: it doesn't accept SSH connections and doesn't act as an SSH agent;
it talks to the Windows OpenSSH agent as a client. Its tests start russh
servers on 127.0.0.1 as test peers, nothing else does. The vendored copy
stays on 0.63.2 because of its local patches; the next russh update moves
to a fixed version.

[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
concerns `glib` 0.18 (unsound `VariantStrIter`, fixed in 0.20). Tauri uses
`glib` only for its Linux GTK backend; the Windows build doesn't contain it
(`cargo tree --target x86_64-pc-windows-msvc -i glib` finds nothing). It
stays in `Cargo.lock` until Tauri moves to a newer GTK binding.

## Unsigned binaries and checking a download

The Windows binaries are not code-signed yet, so Windows SmartScreen warns
about an unknown publisher. Download them only from the
[releases page](https://github.com/ITBrain258/aidevbridge/releases) and
compare their SHA-256 checksum with the value listed in the release notes
(the release build records it in `release-manifest.json`). In PowerShell:

```powershell
Get-FileHash .\aidevbridge-0.2.1-windows-x64.zip -Algorithm SHA256
```

The `Hash` it prints must match the release notes exactly; upper or lower
case doesn't matter. If it doesn't match, don't run the file, and report it
through the private form.
