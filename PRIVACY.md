# Privacy policy

This policy covers aidevbridge on Android, Windows and macOS, including the app
distributed through Google Play. It was last changed on 27 October 2026.

## Short version

aidevbridge collects no data. It has no account, no server of its own, no
analytics, no crash reporting and no ads. The app talks only to the SSH hosts
that you add yourself.

## What the app stores, and where

Everything stays on your device, in storage that only the app can read:

- **Your hosts:** name, host name or address, port, user name, the chosen
  login method and the path of a key file, plus the layout of your terminals
  and your settings (`settings.toml`).
- **Known host keys** (`known_hosts`), so that the app can warn you when a
  host's key changes.
- **SSH keys you generate or import in the app** (Android). On Windows and
  macOS the app reads your existing keys in `~/.ssh` and never copies them.

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

## Permissions (Android)

- **Internet access:** for the SSH connections to your hosts. No other
  permission is requested. Importing a key uses the system file picker, which
  gives the app access to the one file you choose.

## Third parties

None. No data is shared with or sold to anyone. Google Play may collect data
about the installation itself under Google's own privacy policy.

## Children

aidevbridge is a tool for software developers and is not directed at children.

## Deleting your data

Remove a host in the app, or uninstall the app (Android) or delete the folder
`io.github.itbrain258.aidevbridge` in your configuration directory (Windows:
`%APPDATA%`, macOS: `~/Library/Application Support`). Nothing is stored
anywhere else, so there is nothing for the developer to delete.

## Contact

Questions about this policy: open an issue at
<https://github.com/ITBrain258/aidevbridge/issues>.

## Changes

Changes to this policy are made in this file; its history on GitHub shows
every change.
