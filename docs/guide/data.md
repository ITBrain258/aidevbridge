# Privacy and stored data

[Back to the README](../../README.md)

The short version is in the [privacy policy](../../PRIVACY.md): aidevbridge collects no data. This page lists what the app does on your hosts and what it keeps on your device.

- **Only SSH.** The app connects to your hosts over SSH and to nothing else:
  no telemetry, no update check, no account. Its window is drawn by
  Microsoft Edge WebView2, a Windows component with its own updates and data
  practices, on macOS by the system's WebKit and on Android by the system's
  WebView; the app loads no remote content into it.
- **Links.** A plain click on a link in a terminal does nothing. Ctrl+click
  opens http and https links in your default browser. A link whose text
  doesn't show its address (OSC 8) names the address in its tooltip, and
  Ctrl+click first shows the full address with **Open link**.
- **On your hosts** the app runs tmux on its own socket `agentbridge` and
  sets a few tmux options there (`history-limit`, `remain-on-exit`,
  `terminal-overrides`, and `status off`, which hides tmux's status line on
  that socket because each terminal's head already shows the session). For
  the status it runs the read-only
  `claude agents --json`, reads pane titles and program files from `/proc`
  and, while Codex runs, the `tui` keys of Codex's settings. It installs
  nothing and changes no configuration.
- **On your PC or Mac** aidevbridge keeps:
  - `%APPDATA%\io.github.itbrain258.aidevbridge\settings.toml`: your hosts
    (name, address, port, user, key file path, authentication method),
    preferences and the workspace (open terminals, recent folders).
    Settings → About shows the exact path. The window position is stored in
    the same folder.
  - `%USERPROFILE%\.ssh\known_hosts`: the host keys you accepted. The file is
    shared with OpenSSH; the app only appends to it.
  - `%LOCALAPPDATA%\io.github.itbrain258.aidevbridge\`: WebView2 data.
  - On macOS, `settings.toml` and the window position are in
    `~/Library/Application Support/io.github.itbrain258.aidevbridge/`, the
    host keys in `~/.ssh/known_hosts` and the WebKit data under
    `~/Library/WebKit/io.github.itbrain258.aidevbridge/` and
    `~/Library/Caches/io.github.itbrain258.aidevbridge/`.
- **On Android** everything stays in the app's private storage, which other
  apps cannot read: `settings.toml`, `known_hosts` and the keys you generate
  or import in the app. The app excludes this storage from Google's cloud
  backup and from the transfer to a new device.
- **Passwords and key passphrases are never stored.** The app asks again
  when it needs them.
- Removing the app keeps `known_hosts` and `settings.toml`; only the
  uninstaller of the setup EXE can delete the app data, and it asks first.
  Delete the folders by hand if you no longer need them, and remove a host
  key with `ssh-keygen -R <host>`.
