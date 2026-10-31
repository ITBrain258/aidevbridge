# Agents and status

[Back to the README](../../README.md)

## States

| State | Meaning |
| --- | --- |
| Waiting | The agent waits for you: a permission prompt, a question or a dialog. |
| Busy | The agent is working. |
| Idle | The agent is ready for the next prompt. |
| Ended | The session's active pane has exited, or the session is gone from the host. |
| Unknown | No status source: no supported agent runs in the pane, the agent shows no status, its output has a form that was not measured, or the host's tmux version is not one of the measured ones. |
| As of HH:MM | The status could not be read (failed query, interrupted connection, reconnect). The pill keeps the time of the last value, its tooltip names that value, and the host does not count as waiting until a query succeeds again. |

## Agents

| Agent | Where the status comes from | Measured with |
| --- | --- | --- |
| Claude Code | `claude agents --json` on the host, read-only | 2.1.309 (before: 2.1.269 and 2.1.270) |
| Codex | the terminal title that tmux keeps for the pane | 0.163.0 and 0.164.0 (before: 0.154.0) |
| Grok | the terminal title that tmux keeps for the pane | 1.0.30; the approval title with 1.0.13; not measured again |
| agy, OpenCode | no status in their title: Unknown | |
| Gemini CLI and others | not measured: Unknown | |

## How detection works

- The agent must run directly in the session's shell, started by hand. With
  several windows or panes, the active pane of the active window counts.
- Claude Code: `claude` must be in `~/.local/bin` or on the non-interactive
  SSH `PATH`. A row counts only if its process is the pane's process or a
  direct child of it. Waiting covers a permission prompt, input needed, a
  sandbox or worker request, a goal proposal and an open dialog.
- The agent is recognized by the program file it runs
  (`/proc/<pid>/exe`), not by the name a process gives itself.
- Codex: a freshly started Codex shows "Unknown" until its first thread has
  a name. The app reads the `tui` keys of `/etc/codex/config.toml` and
  `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). With
  `tui.animations` or `tui.effects.progress` off, Codex shows no spinner, so
  only "Waiting" still counts and everything else shows "Unknown"; with
  title items of your own (`tui.terminal_title`) Codex shows "Unknown". A
  project's `.codex/config.toml`, `-c` options and a desktop's
  reduced-motion setting are not read: they can still hide the spinner, so
  a working Codex may then show "Idle".
- Grok: when Grok moves a long shell command to the background, its title
  shows "Idle" for a while although the command still runs.
- Newer agent versions may change these forms; a form the app does not know
  shows "Unknown", never a guess.
- While a host is connected, the app polls about every 2 seconds. Each poll
  runs two short tmux commands, one read-only title read for the active
  panes (`tmux display-message`, program files from `/proc` and, while
  Codex runs, the `tui` keys of its settings; no command lines), one short
  `claude` process and, while agents run, one read-only `/proc` lookup,
  whatever the number of sessions. With "Show tmux sessions" on, one more
  tmux command and title read cover tmux's default socket, at the same time.
