# AgentBridge local patch to russh 0.63.2

This directory preserves the published russh 0.63.2 source, with local
channel-close, channel-end observation, manual receive window and
authentication reply changes. It
is not a new upstream release. Original copyright notices and the Apache-2.0
package license remain intact; the local changes use the same license.
Every changed upstream file starts with a two-line notice (Apache-2.0
section 4(b)); most changed blocks also carry a marker comment
(`AgentBridge local patch` or `AgentBridge local modifications`). The complete
list of changed and added files is under "Changed files" below. `LICENSE-APACHE` supplies the standard
license text, which the published crate does not include as a separate file.

Upstream repository: <https://github.com/warp-tech/russh>.
The published `.cargo_vcs_info.json` records commit
`8a51a0dca4f6fbdcc3ce98c627254026b25b3252`, subdirectory `russh`.
The cached published `.crate` archive has SHA-256
`8e134e2480f4e86f83e4aa45b4c0a9723f84beaffa694c54bdf056e74efdd7dd`,
matching the project's existing crates.io lock checksum. All 85 archived files
were compared byte-for-byte by SHA-256 with the registry source before patching.
The copied registry tree additionally contains Cargo's seven-byte `.cargo-ok`
marker: 86 files, 1,247,098 bytes in total before local additions/changes.
That local cache marker was removed from this vendored copy; all 85 published
files remain, with only the documented source modifications.

`UPSTREAM-SHA256SUMS` records the unmodified registry files, including that marker.
The manifest itself has SHA-256
`44b51742872c52721ecfd80e7f6c462b7b25a6ed0eca6c96a731011456169844`.
The copied upstream `Cargo.lock` remains an upstream artifact; the workspace's
root `Cargo.lock` controls AgentBridge builds.

The local change retains a one-bit expected-Close state in an existing
`ChannelRef` after local Close. Only Close may use this state; ordinary channel
messages still require an established encrypted channel. A received Close
replies immediately when needed and removes channel state, including unsent
outbound data, instead of waiting for further peer window space. Local
Close/EOF/flush behavior remains unchanged. No cryptographic code, algorithms,
dependency versions or requested production features were changed.

Packet-dispatch regressions are in `src/tests/channel_close_patch.rs`, included
by both the client and server test modules. For the reason, exact scope,
validation status and eventual removal criteria, see
[`russh-channel-close-patch.md`](../../docs/reviews/2026-09-11-neutral/russh-channel-close-patch.md).

The 2026-09-12 addition provides a sender-free `ChannelEndObserver` for locally
opened client channels. Validated EOF, exit status (including zero), exit signal
and accepted Close become sticky before bounded message delivery; Close is also
recorded before reply bookkeeping. Session termination is recorded before
shutdown/termination callbacks, on local or received disconnect, and on Session
drop. Dropping the unique dispatcher route is independently visible even while
raw sender clones survive. A short synchronous admission gate shares the same
mutex; observers retain neither a channel sender nor a Session. Common inbound
and server constructors explicitly provide `None`, not a liveness assertion.
Existing channel messages, handlers and Close acknowledgements are preserved.
After an accepted OpenFailure removes a route, only a raw sender clone is kept
for final message delivery; the unique ChannelRef is dropped before that send
can wait on a full queue. The existing known-channel gate remains unchanged.

Direct regressions are in `src/tests/channel_end_observer.rs`, included only in
the existing client test module. The vendored change only provides the
observer. AgentBridge's PTY owner consumes it in
`src-tauri/src/transport/russh_transport/owned_operations.rs`, and the bound
W/J attach confirmation (`src-tauri/src/tmux/attach_confirmation.rs`) builds on
that owner. Current status is tracked in [`docs/stand.md`](../../docs/stand.md).

The 2026-10-21 addition gives locally opened client session channels an
optional manual receive window, so that a terminal's output reaches the peer's
window only as fast as the application consumes it. Upstream enlarges every
channel's window when data arrives; under unbounded output (`yes`, a large
`cat`) the application's bounded output queue then overflowed and the terminal
channel ended. `Handle::channel_open_session_manual_window(window)` opens a
session channel that advertises `window` instead of `Config::window_size` and
returns a `WindowCredit` with it. For such a channel, received `CHANNEL_DATA`
and `CHANNEL_EXTENDED_DATA` only reduce the receive window; the automatic
`WINDOW_ADJUST` on arrival is skipped. The application returns consumed bytes
with `WindowCredit::credit`, which never blocks or awaits: credit accumulates
in a shared counter until at least a quarter of the window or 32 KiB is
pending, whichever is less. Only then does one `Msg::ChannelWindowCredit` go
to the session over its existing unbounded priority queue, which is not held
back by pending outbound data; at most one is outstanding per channel. The
session sends one `WINDOW_ADJUST` for the whole pending amount, capped so that
the window never exceeds its advertised size, and nothing for a channel that
has already closed. Every other channel keeps the automatic window byte for
byte: `channel_open_session` and the other channel types still advertise
`Config::window_size`, channels the peer opens and the whole server side are
unchanged, and their arrival path still calls `adjust_window_size`.

Changed for it: `src/channels/{mod.rs,channel_ref.rs}`,
`src/client/{mod.rs,session.rs,encrypted.rs}`, `src/session.rs` and the
re-export in `src/lib_inner.rs`; new: `src/channels/window_credit.rs`. No
vendored test covers it. AgentBridge's loopback tests against a real russh
server do, in `src-tauri/src/transport/russh_transport/operation_tests.rs`
(`operation_flooded_pty_*`, `operation_unread_flood_*`,
`operation_finite_flood_*`, `operation_second_pty_*`,
`operation_eight_flooding_ptys_*`, `operation_exec_keeps_the_automatic_window`).
The PTY owner opens its channels with it in
`src-tauri/src/transport/russh_transport/owned_operations.rs` and returns
credit when the terminal's output queue (`pty_output.rs`) hands a chunk to its
reader.

The 2026-10-22 addition changes what the client's authentication calls return
when the session ends before the server answers. Upstream turns the closed
reply channel into `AuthResult::Failure` with an empty method set, which reads
like a server refusal with no remaining methods; a server that disconnects
after too many attempts, or a dropped network, then looked like "method not
offered". The password, `none`, public key and certificate calls now return
`Error::RecvError`, as upstream's keyboard-interactive wait already does; the
signer-based calls (`authenticate_publickey_with`,
`authenticate_certificate_with`, `authenticate_gssapi_with_mic`) return a
`SendError`, as they do when sending to the closed session fails. Replies the
server actually sent are unchanged, including an empty method list.

Changed for it: `src/client/mod.rs`. No vendored test covers it.
AgentBridge's loopback test against a real russh server does, in
`src-tauri/src/transport/russh_transport/connect_tests.rs`
(`a_session_ending_during_password_auth_is_a_connection_error`).

## Changed files

Compared with the published 0.63.2 archive, these upstream files are modified;
each starts with the two-line notice:

- `src/channels/channel_ref.rs`
- `src/channels/mod.rs`
- `src/client/encrypted.rs`
- `src/client/mod.rs`
- `src/client/session.rs`
- `src/lib_inner.rs` (re-exports `ChannelEndObserver`, `ChannelEndSnapshot` and
  `WindowCredit`)
- `src/server/encrypted.rs`
- `src/server/session.rs`
- `src/session.rs`

These files are added:

- `src/channels/end_observer.rs`
- `src/channels/window_credit.rs`
- `src/tests/channel_close_patch.rs`
- `src/tests/channel_end_observer.rs`
- `AGENTBRIDGE-PATCH.md`, `LICENSE-APACHE` and `UPSTREAM-SHA256SUMS`

All other files are byte-identical with the published archive.
