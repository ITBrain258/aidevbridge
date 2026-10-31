# Install

[Back to the README](../../README.md)

Download from the [latest release](https://github.com/ITBrain258/aidevbridge/releases/latest).
There is no automatic update. To hear about new versions, watch the repository's
releases on GitHub (Watch → Custom → Releases).

## Windows

Windows 10 and 11 (x64). Each release comes in three forms with the same
program; pick one:

| File | What it is |
| --- | --- |
| `aidevbridge-<version>-windows-x64-setup.exe` | Setup program. Installs for your Windows account, no administrator rights needed. |
| `aidevbridge-<version>-windows-x64.msi` | Windows Installer package, for example for `msiexec /i`. Installs for all users and asks for administrator rights. |
| `aidevbridge-<version>-windows-x64.zip` | No installation. Extract the whole ZIP into a folder and start `aidevbridge.exe`. |

- **The packages are not code-signed yet.** Windows SmartScreen therefore warns
  with "Windows protected your PC". [Check the file](#check-a-download) first,
  then choose **More info** → **Run anyway**.
- **Smart App Control blocks it.** If Smart App Control is set to On (Windows
  Security → App & browser control → Smart App Control), Windows does not start
  unsigned apps such as this one, also when you build it yourself. There is no
  exception for a single app.
- **WebView2.** The window is drawn by Microsoft Edge WebView2, which current
  Windows 10 and 11 already include. Both installers download and install it if
  it is missing; the ZIP expects it to be installed.
- **Licenses.** Every form carries the license texts in a `licenses` folder
  (`licenses/index.html`) next to the program; keep it there.

**Removing** the app: uninstall it under Settings → Apps → Installed apps, or,
for the ZIP, close it and delete its folder. Your settings and the host keys you
accepted stay unless you let the uninstaller of the setup program delete the app
data; see [Privacy and stored data](data.md) for where they are.

**Upgrading from agentbridge.** Before 0.2.0 the app was called agentbridge.
When its own folder `%APPDATA%\io.github.itbrain258.aidevbridge\` holds no
`settings.toml` yet, aidevbridge copies `settings.toml` from
`%APPDATA%\agentbridge\` on start and leaves the old folder as it is; the window
position starts fresh. Your sessions on the hosts stay visible, because the tmux
socket is still named `agentbridge`.

## macOS

macOS 11 or newer, Apple silicon and Intel: one disk image,
`aidevbridge-<version>-macos-universal.dmg`. Open it and drag **aidevbridge**
onto **Applications**.

- **Not notarized yet.** The image is signed ad-hoc only, so macOS refuses the
  first start ("Apple could not verify …"). After
  [checking the file](#check-a-download), choose **Open Anyway** for aidevbridge
  under System Settings → Privacy & Security.
- **Local network.** From macOS 15 on, the app asks once for access to the local
  network when it connects to a host there; allow it, or hosts on your network
  stay unreachable.
- **Tested by machine so far.** The macOS app has passed an automated
  installation and start test, not yet a test by hand on a Mac.
- The window is drawn by WebKit, which is part of macOS. The license texts are
  inside the app (`aidevbridge.app/Contents/Resources/licenses/index.html`). To
  remove the app, move it to the Trash.

## Android

Android 7.0 or newer: `aidevbridge-<version>-android.apk`. Android asks once
whether the app you open it from may install apps. A Google Play version is in a
closed test. The two are signed differently: uninstall one before installing the
other, which removes the hosts and keys stored in the app.

On a phone the app shows one terminal at a time, with the sessions in a drawer, a
key bar for Esc, Tab, Ctrl, Alt and the arrows, and swipe scrolling.

There is no ssh-agent on Android. When you add a host, choose
**Generate new key…** and add the line it shows to `~/.ssh/authorized_keys` on the
host, or **Choose file…** to import an existing private key, or **Password**.

Android stops the connections when the app has been in the background for a
while; on return, hosts with a key reconnect by themselves. The license texts are
inside the app (`assets/licenses/`).

## Check a download

Every release lists the SHA-256 of each package, taken from the
`release-manifest.json` of its build.

- **Windows, in PowerShell:**
  `Get-FileHash .\aidevbridge-<version>-windows-x64-setup.exe -Algorithm SHA256`
  (or the name of the file you downloaded) must print the same value. It prints
  upper-case letters where the release lists lower-case ones; letter case does
  not matter.
- **macOS, in Terminal:**
  `shasum -a 256 ~/Downloads/aidevbridge-<version>-macos-universal.dmg` must
  print the same value.
- **Android:** the release also lists the digest of the signing certificate;
  `apksigner verify --print-certs <file>` from the Android SDK prints it.

### Optional, stronger: the build provenance

From 0.2.4 on, each file that the run of the release's tag attaches has a build
provenance: a record, signed through Sigstore and kept by GitHub apart from the
release, that ties the file's SHA-256 to this repository's workflow, the tag and
its commit. With the [GitHub CLI](https://cli.github.com/) 2.68 or newer, signed
in to any GitHub account (`gh auth login`), run:

```sh
gh attestation verify <file> --repo ITBrain258/aidevbridge \
  --signer-workflow ITBrain258/aidevbridge/.github/workflows/packages.yml \
  --source-ref refs/tags/v<version>
```

It must print `Verification succeeded!`. The Android APK comes from `android.yml`;
for it, name that workflow in `--signer-workflow`.

GitHub CLI 2.49 to 2.67 lacks `--source-ref`; there,
`gh attestation verify <file> --repo ITBrain258/aidevbridge` is the fallback. It
only checks that a workflow of this repository made the provenance, not that it
was `packages.yml` nor that the file was built from that release's tag.

A file that a manual run from another ref (such as a branch) attached later has no
provenance, and the command fails for it (current versions of the GitHub CLI
report `HTTP 404: Not Found`); for it, only the SHA-256 check above applies.
Details are in
[SECURITY.md](../../SECURITY.md#unsigned-binaries-and-checking-a-download).

## Or build it yourself

See [Build and test](building.md).
