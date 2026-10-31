# Hosts and tmux

[Back to the README](../../README.md)

## Host requirements

aidevbridge installs nothing on a host and changes no configuration there.
Each host needs:

- SSH access with a key file, ssh-agent or password, and a POSIX login shell
  such as bash, zsh or dash. fish and csh are not supported.
- `tmux` 3.0 or newer on the non-interactive SSH `PATH`. Numeric session
  identity and agent status work with the measured versions 3.0, 3.3a, 3.4
  and 3.6; other versions list sessions by name and show "Unknown". Debian 12
  ships 3.3a and Ubuntu 24.04 ships 3.4; Ubuntu 22.04 ships 3.2a, which runs
  without status. For 3.6 only the exact answer `tmux 3.6` counts, measured
  on Ubuntu 26.04.1 with the package `tmux 3.6a-2ubuntu0.1`; an unmodified
  3.6a build answers `tmux 3.6a` and, like 3.5 and 3.5a, shows "Unknown".
- `base64` and a writable tmux socket directory (`$TMUX_TMPDIR` or `/tmp`).
  Both are present on common distributions.

Install tmux with the host's package manager, for example:

```sh
sudo apt install tmux      # Debian, Ubuntu
sudo dnf install tmux      # Fedora, RHEL, Rocky, Alma
sudo pacman -S tmux        # Arch
sudo zypper install tmux   # openSUSE
sudo apk add tmux          # Alpine
```

When a host is added, aidevbridge checks these requirements and names the
missing one. Agent status also needs the agent started by hand in a session;
see [Agents and status](agents.md).

## The first connection

The welcome page suggests the hosts from your `~/.ssh/config`
(`%USERPROFILE%\.ssh\config` on Windows). On the first connection the app shows
the fingerprint of the host key. Compare it with the host, for example with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, and choose **Trust and
continue**. The app then checks tmux, `base64` and the tmux socket directory on
the host.

## Which sessions the app shows

The sidebar lists the sessions on the app's own tmux socket, `agentbridge`.
To start one from an SSH shell instead, run `tmux -L agentbridge new -s work`
on the host. Sessions you started with plain `tmux` appear below them as
**tmux sessions**.

## Sessions on tmux's default socket

Sessions on tmux's default socket, the ones plain `tmux` and `tmux new`
create, are listed under each host as **tmux sessions** and marked **tmux**
in the terminal's head, the waiting lane and quick open. Opening one attaches
the app as one more client of that session:

- **The app never ends them.** There is no **End session…** for them; end
  them in tmux.
- **The app changes nothing on that server.** It sets no option, hook or
  environment, and it attaches with `attach-session -E`, so your session
  keeps its `SSH_AUTH_SOCK`, `DISPLAY` and the other variables of
  `update-environment`. Your configuration applies as it is: prefix, mouse,
  colours, the status line (the terminal shows it and has one row less) and
  your hooks, which run when the app attaches, resizes and detaches. With
  `destroy-unattached`, a session ends when the app was its last client.
- **Window size:** from tmux 3.1, `window-size` is `latest`. Opening the
  terminal and every resize give the window the terminal's size, also in
  your other client; when you use that client again, the window follows it.
  When another client is already attached, the app says so once per run.
- **Versions:** the app attaches to servers running tmux 3.3a or 3.6, the
  versions its checks were measured on. For a server running another version
  the sidebar names the version and lists nothing. Sessions of a session
  group (`tmux new -t`) are listed but cannot be opened.
- **Where the app looks:** where tmux puts the default socket for a
  non-interactive SSH command, normally `/tmp/tmux-<uid>/default`. A server
  started with `TMUX_TMPDIR` set only in an interactive shell, or with
  `-S`, is not found.
- **Switching it off:** **Edit host** → **Show tmux sessions**. Off, the app
  does not read the default socket of that host at all.
