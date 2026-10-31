# Limits and known gaps

[Back to the README](../../README.md)

- **Not built yet:** status for agy, OpenCode and Gemini CLI; changing
  shortcuts (Settings → Shortcuts lists them); `git worktree` when creating a
  session; code signing, automatic updates and winget.
- **Installers:** `npm run build:windows` builds and checks MSI, setup EXE
  and ZIP, `npm run build:macos` the macOS disk image. They are unsigned (the
  disk image ad-hoc signed). For every release the packages workflow installs
  each one on a fresh runner and starts the app.
- **tmux's default socket:** only servers running tmux 3.3a or 3.6 are
  attached to; sessions of a session group are listed but not opened; a
  server outside `/tmp/tmux-<uid>` is not found (see
  [Sessions on tmux's default socket](hosts.md#sessions-on-tmuxs-default-socket)).
  The status poll reads the default socket in the form of the tmux on the
  PATH: if that tmux is not 3.3a, 3.4 or 3.6 while the server is, the
  sessions are listed but their status stays unknown, and sessions started
  later appear only after **Reload sessions**.
- **macOS:** the shortcuts are those of Windows (Ctrl, Ctrl+Shift); ⌘C, ⌘V,
  ⌘W and ⌘Q work through the app menu. Shortcuts with ⌘ and a check by hand
  on a Mac (copy and paste, the local-network prompt, fonts) are still open.
- **Android:** the system stops the connections when the app has been in the
  background for a while; on return, hosts with a key reconnect by themselves.
  There is no ssh-agent on Android. On a phone the app shows one terminal at a
  time. A Google Play version is in a closed test.
- **Authentication:** a key file, the Windows OpenSSH agent (the `ssh-agent`
  service; on macOS the agent of `SSH_AUTH_SOCK`) or a password. No keyboard-interactive or two-factor prompts, no
  Pageant, no jump hosts or proxies. The import from `~/.ssh/config` reads
  `Host`, `HostName`, `User`, `Port` and `IdentityFile`; other keywords such
  as `ProxyJump`, `Include` and `Match`, and wildcard defaults, are ignored.
- **Two connections per host:** each host opens two SSH connections
  (control and terminals) bound to the same host key. An SSH agent that asks
  for approval may therefore ask twice, and again on every automatic
  reconnect attempt.
- **Several windows:** aidevbridge can run more than once, and all windows
  share `settings.toml`. A window applies only its own change to what
  another one saved, so hosts another window added or removed stay; if two
  windows edit the same host, the later save sets all of that host's
  fields. Each preference keeps the value of the window that changed it
  last, the workspace (open terminals, layout) is that of the window that
  saved it last, and a window shows hosts changed in another one only after
  a restart. Two windows on the same session attach to it as two tmux
  clients. Details in
  [SECURITY.md](../../SECURITY.md#several-windows-at-the-same-time).
- **Automatic recovery** covers hosts with a key file or ssh-agent whose last
  connection needed no passphrase. Password and passphrase hosts reconnect
  by hand; when only the live updates stopped, **Restore updates** in the
  sidebar asks for the password again.
- **History on attach** needs the pane identity that only tmux 3.3a, 3.4 and
  3.6 provide; on tmux 3.0 and unmeasured versions a reopened terminal
  starts without history. While a full-screen program runs (alternate
  screen), no history is loaded.
- **Resizing:** opening or closing a terminal, releasing a dragged gap and
  swapping two terminals of different sizes resize every terminal whose size
  changes. Codex clears its tmux history on each resize.
- **Clipboard:** copies that programs send themselves via OSC 52 are ignored.
  tmux keeps its default `set-clipboard external`, so only tmux's own copies
  (drag, double-click) reach the Windows clipboard, not the built-in copy
  commands of the agents.
- **`known_hosts`:** plain and hashed host entries (`|1|…`, as written by
  `HashKnownHosts yes` or `ssh-keygen -H`) are matched alike: a different key
  of the same type behind a hashed entry is refused as a changed key. After
  a real key change, remove the old entry with `ssh-keygen -R <host>`
  (`ssh-keygen -R "[host]:port"` for another port; it finds hashed entries
  too) and connect again; the error message names that command.
  Wildcard and negated host patterns are not evaluated, and CA trust
  (`@cert-authority`) is not supported. A `@revoked` line with a wildcard,
  negated or hashed host field makes the app reject that key for every host
  and port, even where another line trusts it; such a key cannot be accepted
  through the first-contact prompt.
- **Shell startup output:** opening a listed session expects the app's own
  marker line first. A shell startup file that prints output, or waits for
  input, in non-interactive SSH commands makes opening fail, at the latest
  after 15 seconds.
- **Unconfirmed changes:** if creating or ending a session times out after
  the command was sent, the app says that it may already have happened and
  does not repeat it. Reload the session list before trying again.
- **Reserved settings:** the per-host `tmux_socket` and `history_limit` in
  `settings.toml` are loaded and kept, but do not change anything yet. The
  app always uses the `agentbridge` socket and sets a 10,000-line history
  for new panes; the local scrollback holds 5,000 lines.
