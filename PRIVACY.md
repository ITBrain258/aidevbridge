# Privacy policy

This policy covers aidevbridge on Android, Windows and macOS, including the app
distributed through Google Play. It was last changed on 3 November 2026.

## Short version

aidevbridge collects no data. It has no account, no server of its own, no
analytics, no crash reporting and no ads. The app talks only to the SSH hosts
that you add yourself.

## What the app stores, and where

Everything stays on your device. On Android it is in the app's private
storage, which other apps cannot read; on Windows and macOS it is in your user
profile:

- **Your hosts:** name, host name or address, port, user name, the chosen
  login method and the path of a key file, plus the layout of your terminals
  and your settings (`settings.toml`). On Windows the file is in
  `%APPDATA%\io.github.itbrain258.aidevbridge\`, on macOS in
  `~/Library/Application Support/io.github.itbrain258.aidevbridge/`.
- **Known host keys** (`known_hosts`), so that the app can warn you when a
  host's key changes. On Windows and macOS this is the file `known_hosts` in
  `~/.ssh` (on Windows `%USERPROFILE%\.ssh\known_hosts`), which OpenSSH uses
  as well. The app only appends to it, and its entries stay after you
  uninstall the app.
- **SSH keys you generate or import in the app** (Android). On Windows and
  macOS the app reads your existing keys in `~/.ssh` and never copies them.
- **Window position and size and the data of the web view** (Windows and
  macOS). The window position is kept in the same folder as `settings.toml`.
  The web view keeps its own data in
  `%LOCALAPPDATA%\io.github.itbrain258.aidevbridge\` on Windows and in
  `~/Library/WebKit/io.github.itbrain258.aidevbridge/` and
  `~/Library/Caches/io.github.itbrain258.aidevbridge/` on macOS; its local
  storage holds only the color theme.

Passwords and key passphrases are never written to storage. They stay in
memory for as long as a connection needs them.

On Android, the app's storage is excluded from Google's cloud backup and from
the transfer to a new device, so your keys and hosts do not leave the device
that way either.

## What the app sends, and to whom

- The app opens SSH connections only to hosts that you add. Everything it
  exchanges with them — your login, the terminal contents, the commands that
  list tmux sessions and read the status of coding agents — is encrypted by
  SSH between your device and your host. The developer receives none of it.
- When you open a link from the terminal, your browser opens it.
- The app makes no other network connection. It does not check for updates;
  Google Play or you do that.
- On Windows, if WebView2 is missing, the setup EXE and the MSI download
  Microsoft's WebView2 bootstrapper and run it, which installs the WebView2
  runtime. The ZIP expects WebView2 to be installed.
- The app's window is drawn by the system's web view: Microsoft Edge WebView2
  on Windows, WebKit on macOS and Android System WebView on Android. These are
  components of Microsoft, Apple and Google with their own updates and data
  practices; the app loads no remote content into them.

## Permissions (Android)

- **Internet access:** for the SSH connections to your hosts.
- **Nearby devices (local network access), Android 17 and newer:** for SSH
  connections to hosts on your local network. Android blocks the local network
  until you allow it; the app asks only when you connect to such a host. It
  doesn't search the network for devices and connects only to the hosts you
  enter.
- No other permission is requested. Importing a key uses the system file
  picker, which gives the app access to the one file you choose.

## Third parties

None. No data is shared with or sold to anyone. Google Play may collect data
about the installation itself under Google's own privacy policy. For the
system web view and the WebView2 installer, see
[What the app sends, and to whom](#what-the-app-sends-and-to-whom).

## Children

aidevbridge is a tool for software developers and is not directed at children.

## Deleting your data

Remove a host in the app, or delete all of the app's data:

- **Android:** uninstall the app. This removes everything it stored.
- **Windows:** delete the folders `%APPDATA%\io.github.itbrain258.aidevbridge`
  and `%LOCALAPPDATA%\io.github.itbrain258.aidevbridge`. The uninstaller of
  the setup EXE offers to do this and asks first.
- **macOS:** delete the folders
  `~/Library/Application Support/io.github.itbrain258.aidevbridge`,
  `~/Library/WebKit/io.github.itbrain258.aidevbridge` and
  `~/Library/Caches/io.github.itbrain258.aidevbridge`.
- **Host keys** (Windows and macOS): remove a host's key from `known_hosts`
  with `ssh-keygen -R <host>`.
- If you used agentbridge before 0.2.0, its old folder `%APPDATA%\agentbridge`
  stays until you delete it.

The app stores nothing anywhere else and nothing on a server of the developer,
so there is nothing for the developer to delete.

## Contact

Questions about this policy: open an issue at
<https://github.com/ITBrain258/aidevbridge/issues>.

## Changes

Changes to this policy are made in this file; its history on GitHub shows
every change.
