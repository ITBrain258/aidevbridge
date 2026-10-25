//! Internal W/J attach protocol used by bound `open_terminal`.
//! Parsed evidence is scoped to one setup; it is not a durable authorization.
use super::inventory::{
    InventoryOutcome, InventoryQuery, PaneId, ServerIdentity, SessionId, WindowId,
    MAX_INVENTORY_BYTES,
};
use super::session_binding::{self, BindingQuery, PaneIdentity};
use super::socket::SocketKind;
use crate::{remote, transport::ExecResult};
use std::collections::BTreeSet;

pub(crate) const W_LIMIT: usize = 257;
const J_FORMAT: &str = "J|#{pid}|#{start_time}|#{client_pid}|#{client_created}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{window_active}|#{pane_active}|#{pane_dead}|#{client_control_mode}|#{client_readonly}|#{client_tty}|#{client_uid}|#{client_flags}";
const SOCKET_FORMAT: &str = "S|#{pid}|#{start_time}|#{session_id}|#{socket_path}";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum Unverified {
    #[error("invalid or incomplete attach protocol response")]
    Frame,
    #[error("attach identity changed")]
    Changed,
    #[error("client flags are unavailable; legacy compatibility is not yet established")]
    FlagsUnavailable,
    #[error("attach client mode is not supported")]
    ClientMode,
    #[error("wrapper process capabilities or identity are not established")]
    Process,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WrapperIdentity {
    pub(crate) pid: u32,
    pub(crate) start_ticks: u64,
    pub(crate) uid: u32,
    pub(crate) tty_nr: u32,
    pub(crate) tty: String,
}

fn number(value: &str, maximum: u64, positive: bool) -> Result<u64, Unverified> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|c| c.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Unverified::Frame);
    }
    let n: u64 = value.parse().map_err(|_| Unverified::Frame)?;
    if n > maximum || (positive && n == 0) {
        return Err(Unverified::Frame);
    }
    Ok(n)
}
fn u32_number(value: &str, positive: bool) -> Result<u32, Unverified> {
    number(value, u32::MAX.into(), positive).map(|n| n as u32)
}
fn id(value: &str, prefix: char) -> Result<u32, Unverified> {
    u32_number(value.strip_prefix(prefix).ok_or(Unverified::Frame)?, false)
}
fn tty(value: &str) -> Result<(), Unverified> {
    let n = value.strip_prefix("/dev/pts/").ok_or(Unverified::Frame)?;
    if n.is_empty() || !n.bytes().all(|c| c.is_ascii_digit()) || (n.len() > 1 && n.starts_with('0'))
    {
        return Err(Unverified::Frame);
    }
    Ok(())
}
fn nonce_valid(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn parse_w(line: &[u8], nonce: &str) -> Result<WrapperIdentity, Unverified> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if !line.is_ascii() {
        return Err(Unverified::Frame);
    }
    let text = std::str::from_utf8(line).map_err(|_| Unverified::Frame)?;
    let f: Vec<_> = text.split('|').collect();
    if f.len() != 7 || f[0] != "W" || f[1] != nonce {
        return Err(Unverified::Frame);
    }
    tty(f[6])?;
    Ok(WrapperIdentity {
        pid: u32_number(f[2], true)?,
        start_ticks: number(f[3], u64::MAX, true)?,
        uid: u32_number(f[4], false)?,
        tty_nr: u32_number(f[5], true)?,
        tty: f[6].into(),
    })
}

/// One fixed scratch record, charged to the owner's common output budget.
/// The first frame is stripped; subsequent bytes are only inspected, never cut.
pub(crate) struct WrapperStream {
    nonce: String,
    scratch: [u8; W_LIMIT],
    len: usize,
    overlong: bool,
    identity: Option<WrapperIdentity>,
}
impl WrapperStream {
    pub(crate) fn new(nonce: String) -> Result<Self, Unverified> {
        if !nonce_valid(&nonce) {
            return Err(Unverified::Frame);
        }
        Ok(Self {
            nonce,
            scratch: [0; W_LIMIT],
            len: 0,
            overlong: false,
            identity: None,
        })
    }
    pub(crate) fn identity(&self) -> Option<&WrapperIdentity> {
        self.identity.as_ref()
    }
    #[cfg(test)]
    pub(crate) fn nonce(&self) -> &str {
        &self.nonce
    }
    pub(crate) fn ingest(&mut self, data: &[u8], extended: bool) -> Result<usize, Unverified> {
        if data.is_empty() {
            return Ok(0);
        }
        if self.identity.is_none() && extended {
            return Err(Unverified::Frame);
        }
        let mut stripped = 0;
        for (index, byte) in data.iter().copied().enumerate() {
            if byte == b'\n' {
                if self.identity.is_none() {
                    if self.overlong {
                        return Err(Unverified::Frame);
                    }
                    self.identity = Some(parse_w(&self.scratch[..self.len], &self.nonce)?);
                    stripped = index + 1;
                } else if !self.overlong && parse_w(&self.scratch[..self.len], &self.nonce).is_ok()
                {
                    return Err(Unverified::Frame);
                }
                self.len = 0;
                self.overlong = false;
            } else if self.len < W_LIMIT - 1 {
                self.scratch[self.len] = byte;
                self.len += 1;
            } else {
                self.overlong = true;
                if self.identity.is_none() {
                    return Err(Unverified::Frame);
                }
            }
        }
        if self.identity.is_none() {
            Ok(data.len())
        } else {
            Ok(stripped)
        }
    }
}

fn complete(result: &ExecResult) -> Result<&str, Unverified> {
    if result.code != 0
        || !result.stderr.is_empty()
        || !result.utf8_valid
        || result.stdout.len() > MAX_INVENTORY_BYTES
        || (!result.stdout.is_empty() && !result.stdout.ends_with('\n'))
    {
        return Err(Unverified::Frame);
    }
    Ok(&result.stdout)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClientRecord {
    binding: PaneIdentity,
    pid: u32,
    created: u64,
    active: [u32; 5],
    tty: String,
    uid: Option<u32>,
    flags: BTreeSet<String>,
}
/// Streng nur die Zeile des eigenen Wrappers (`own_pid`): `list-clients` nennt
/// alle Clients des Servers, und fremde (Kontrollmodus mit `pause-after`, eine
/// Konsole ohne `/dev/pts/N`, Flags spaeterer Versionen) lassen die
/// Bestaetigung nicht scheitern (Spec 2026-10-25 §6.2). Die ganze Ausgabe
/// bleibt druckbares ASCII in Zeilen; die eigene Zeile kommt hoechstens
/// einmal vor.
pub(crate) fn parse_clients(
    result: &ExecResult,
    own_pid: u32,
) -> Result<Vec<ClientRecord>, Unverified> {
    let text = complete(result)?;
    if !text.bytes().all(|b| (32..=126).contains(&b) || b == b'\n') {
        return Err(Unverified::Frame);
    }
    let own = own_pid.to_string();
    let mut records = Vec::new();
    for line in text
        .strip_suffix('\n')
        .into_iter()
        .flat_map(|s| s.split('\n'))
    {
        let f: Vec<_> = line.split('|').collect();
        if f.get(3) != Some(&own.as_str()) {
            continue;
        }
        if f.len() != 17 || f[0] != "J" || !records.is_empty() {
            return Err(Unverified::Frame);
        }
        tty(f[14])?;
        let mut flags = BTreeSet::new();
        for flag in f[16].split(',').filter(|s| !s.is_empty()) {
            // Only the own wrapper's row reaches this check.
            // `no-detach-on-destroy` is tmux 3.6's (only on explicit request,
            // e.g. `attach -f`); our own wrapper never sets it.
            if !matches!(
                flag,
                "attached"
                    | "focused"
                    | "UTF-8"
                    | "suspended"
                    | "read-only"
                    | "ignore-size"
                    | "control-mode"
                    | "active-pane"
                    | "no-output"
                    | "wait-exit"
                    | "no-detach-on-destroy"
            ) || !flags.insert(flag.to_owned())
            {
                return Err(Unverified::Frame);
            }
        }
        if !f[16].is_empty()
            && (f[16].starts_with(',') || f[16].ends_with(',') || f[16].contains(",,"))
        {
            return Err(Unverified::Frame);
        }
        let r = ClientRecord {
            binding: PaneIdentity {
                server: ServerIdentity {
                    pid: u32_number(f[1], true)?,
                    start_time: number(f[2], u64::MAX, true)?,
                },
                session_id: SessionId(id(f[5], '$')?),
                window_id: WindowId(id(f[6], '@')?),
                pane_id: PaneId(id(f[7], '%')?),
                pane_pid: u32_number(f[8], true)?,
            },
            pid: u32_number(f[3], true)?,
            created: number(f[4], u64::MAX, true)?,
            active: [
                number(f[9], 1, false)? as u32,
                number(f[10], 1, false)? as u32,
                number(f[11], 1, false)? as u32,
                number(f[12], 1, false)? as u32,
                number(f[13], 1, false)? as u32,
            ],
            tty: f[14].into(),
            uid: if f[15].is_empty() {
                None
            } else {
                Some(u32_number(f[15], false)?)
            },
            flags,
        };
        records.push(r);
    }
    Ok(records)
}
#[cfg(test)]
pub(crate) fn registered<'a>(
    rows: &'a [ClientRecord],
    w: &WrapperIdentity,
    binding: PaneIdentity,
) -> Result<Option<&'a ClientRecord>, Unverified> {
    if rows.iter().any(|r| r.binding.server != binding.server) {
        return Err(Unverified::Changed);
    }
    let Some(row) = rows.iter().find(|r| r.pid == w.pid) else {
        return Ok(None);
    };
    if row.binding != binding || row.tty != w.tty {
        return Err(Unverified::Changed);
    }
    match row.uid {
        Some(uid) if uid != w.uid => return Err(Unverified::Changed),
        Some(_) => {}
        None => return Err(Unverified::Process),
    }
    if row.flags.is_empty() {
        return Err(Unverified::FlagsUnavailable);
    }
    if row.active != [1, 1, 0, 0, 0]
        || !row.flags.contains("attached")
        || row.flags.iter().any(|f| {
            matches!(
                f.as_str(),
                "active-pane" | "suspended" | "read-only" | "control-mode" | "no-output"
            )
        })
    {
        return Err(Unverified::ClientMode);
    }
    Ok(Some(row))
}

pub(crate) fn registered_with_process<'a>(
    rows: &'a [ClientRecord],
    w: &WrapperIdentity,
    binding: PaneIdentity,
    process: &ExecResult,
) -> Result<Option<&'a ClientRecord>, Unverified> {
    verify_process(process, w)?;
    if rows.iter().any(|r| r.binding.server != binding.server) {
        return Err(Unverified::Changed);
    }
    let Some(row) = rows.iter().find(|r| r.pid == w.pid) else {
        return Ok(None);
    };
    if row.binding != binding || row.tty != w.tty {
        return Err(Unverified::Changed);
    }
    if row.uid.is_some_and(|uid| uid != w.uid) {
        return Err(Unverified::Changed);
    }
    if row.flags.is_empty() {
        return Err(Unverified::FlagsUnavailable);
    }
    if row.active != [1, 1, 0, 0, 0]
        || !row.flags.contains("attached")
        || row.flags.iter().any(|f| {
            matches!(
                f.as_str(),
                "active-pane" | "suspended" | "read-only" | "control-mode" | "no-output"
            )
        })
    {
        return Err(Unverified::ClientMode);
    }
    Ok(Some(row))
}

/// `Ok(true)` is registered. `Ok(false)` means try again. Other errors are final.
pub(crate) fn registration_ready(
    result: Result<Option<&ClientRecord>, Unverified>,
) -> Result<bool, Unverified> {
    match result {
        Ok(Some(_)) => Ok(true),
        Ok(None) | Err(Unverified::FlagsUnavailable) => Ok(false),
        Err(error) => Err(error),
    }
}

// Same measured shell pre-exec stamp. argv are transported independently;
// `exec "$@"` replaces this exact measured shell, preserving its PID.
const WRAPPER: &str = r#"set -efu
nonce=$1
shift
IFS= read -r stamp < "/proc/$$/stat"
stamp=${stamp##*) }
set_args_unused=1
ticks=$(printf '%s\n' "$stamp" | { read -r state ppid pgrp sid device rest; set -- $rest; printf '%s' "${15}"; })
set -- "$@"
device=$(printf '%s\n' "$stamp" | { read -r state ppid pgrp sid device rest; printf '%s' "$device"; })
uid=$(id -u)
terminal=$(tty)
printf 'W|%s|%s|%s|%s|%s|%s\n' "$nonce" "$$" "$ticks" "$uid" "$device" "$terminal"
exec "$@"
"#;

// Read only the actual wrapper process. No remote Python, installation or
// process watcher; malformed/missing /proc data fails this one exec.
const PROCESS: &str = r#"set -efu
pid=$1
IFS= read -r stamp < "/proc/$pid/stat"
stamp=${stamp##*) }
set -- $stamp
state=$1
device=$5
ticks=${20}
found=0
while IFS= read -r line; do
 case "$line" in
  Uid:*) set -- $line; test "$#" -eq 5; test "$2" = "$3"; test "$2" = "$4"; test "$2" = "$5"; uid=$2; found=$((found + 1));;
 esac
done < "/proc/$pid/status"
test "$found" -eq 1
terminal=$(readlink "/proc/$pid/fd/0")
printf 'P|%s|%s|%s|%s|%s|%s\n' "$pid" "$ticks" "$uid" "$device" "$terminal" "$state"
"#;

pub(crate) fn process_command(w: &WrapperIdentity) -> String {
    remote::build(&[
        "sh",
        "-c",
        PROCESS,
        "aidevbridge-process",
        &w.pid.to_string(),
    ])
}
pub(crate) fn verify_process(result: &ExecResult, w: &WrapperIdentity) -> Result<(), Unverified> {
    let text = complete(result)?;
    let f: Vec<_> = text
        .strip_suffix('\n')
        .ok_or(Unverified::Process)?
        .split('|')
        .collect();
    if f.len() != 7
        || f[0] != "P"
        || f[6].len() != 1
        || !f[6].bytes().all(|b| b.is_ascii_alphabetic())
        || matches!(f[6], "Z" | "X")
    {
        return Err(Unverified::Process);
    }
    let process = WrapperIdentity {
        pid: u32_number(f[1], true)?,
        start_ticks: number(f[2], u64::MAX, true)?,
        uid: u32_number(f[3], false)?,
        tty_nr: u32_number(f[4], true)?,
        tty: f[5].into(),
    };
    if &process != w {
        return Err(Unverified::Process);
    }
    Ok(())
}

/// Construction requires both real -L and -S responses for the same binding.
/// This does not certify a permanent inode or infer server absence.
pub(crate) struct SocketBinding {
    query: BindingQuery,
    selected: PaneIdentity,
    /// Welcher Waechter anhaengt: auf dem eigenen Socket mit ausgeschalteter
    /// Statuszeile, auf dem Standard-Socket mit `-E` und ohne Option
    /// (Spec 2026-10-25 §6.4).
    kind: SocketKind,
}
pub(crate) fn named_probe(socket: &str, selected: PaneIdentity) -> Result<String, Unverified> {
    let q = InventoryQuery::conservatively_guarded_named(socket).map_err(|_| Unverified::Frame)?;
    Ok(socket_probe(&q, selected.session_id))
}
fn socket_probe(query: &InventoryQuery, session: SessionId) -> String {
    let [flag, socket] = query.socket_args();
    remote::build(&[
        "env",
        "LC_ALL=C",
        "tmux",
        "-u",
        flag,
        socket,
        "display-message",
        "-p",
        "-t",
        &format!("${}", session.0),
        "-F",
        SOCKET_FORMAT,
    ])
}
fn socket_response(result: &ExecResult, selected: PaneIdentity) -> Result<String, Unverified> {
    let text = complete(result)?;
    let line = text.strip_suffix('\n').ok_or(Unverified::Frame)?;
    let f: Vec<_> = line.splitn(5, '|').collect();
    if f.len() != 5
        || f[0] != "S"
        || u32_number(f[1], true)? != selected.server.pid
        || number(f[2], u64::MAX, true)? != selected.server.start_time
        || id(f[3], '$')? != selected.session_id.0
    {
        return Err(Unverified::Changed);
    }
    InventoryQuery::conservatively_guarded_absolute(f[4]).map_err(|_| Unverified::Frame)?;
    Ok(f[4].into())
}
pub(crate) fn absolute_probe(
    named: &ExecResult,
    selected: PaneIdentity,
) -> Result<String, Unverified> {
    let path = socket_response(named, selected)?;
    let q =
        InventoryQuery::conservatively_guarded_absolute(&path).map_err(|_| Unverified::Frame)?;
    Ok(socket_probe(&q, selected.session_id))
}
impl SocketBinding {
    pub(crate) fn from_responses(
        named: &ExecResult,
        absolute: &ExecResult,
        selected: PaneIdentity,
        kind: SocketKind,
    ) -> Result<Self, Unverified> {
        let path = socket_response(named, selected)?;
        if socket_response(absolute, selected)? != path {
            return Err(Unverified::Changed);
        }
        // Conservatively guarded B/E envelope only. It is neither a version
        // whitelist nor evidence of client-format capabilities. On the default
        // socket a session group must not fail the check after the attach
        // either (spec 2026-10-25 §6.2): its sessions stay unbound, the
        // selected one binds as usual.
        let inventory = InventoryQuery::conservatively_guarded_absolute(&path)
            .map_err(|_| Unverified::Frame)?;
        let query = BindingQuery::new(match kind {
            SocketKind::App => inventory,
            SocketKind::Default => inventory.tolerating_linked_windows(),
        });
        Ok(Self {
            query,
            selected,
            kind,
        })
    }
    #[cfg(test)]
    pub(crate) fn selected(&self) -> PaneIdentity {
        self.selected
    }
    pub(crate) fn query(&self) -> &BindingQuery {
        &self.query
    }
    pub(crate) fn clients_command(&self) -> String {
        let [flag, socket] = self.query.inventory().socket_args();
        remote::build(&[
            "env",
            "LC_ALL=C",
            "tmux",
            "-u",
            flag,
            socket,
            "list-clients",
            "-F",
            J_FORMAT,
        ])
    }
    pub(crate) fn attach_command(&self, nonce: &str) -> Result<String, Unverified> {
        if !nonce_valid(nonce) {
            return Err(Unverified::Frame);
        }
        // Reuse the accepted numeric builder, executing its fixed shell program
        // in the wrapper's own process; no display name enters this command.
        // On the own socket the same tmux client first turns the status line
        // off; on the default socket it attaches with -E and changes nothing.
        let guard = match self.kind {
            SocketKind::App => self
                .query
                .guarded_attach_command_without_status(self.selected),
            SocketKind::Default => self.query.guarded_attach_command_foreign(self.selected),
        }
        .map_err(|_| Unverified::Frame)?;
        Ok(remote::build(&[
            "sh",
            "-c",
            WRAPPER,
            "aidevbridge-wrapper",
            nonce,
            "sh",
            "-c",
            &guard,
        ]))
    }
    pub(crate) fn confirm_inventory(&self, results: &[ExecResult; 5]) -> Result<(), Unverified> {
        let l0 = session_binding::parse_list(&results[0]).map_err(|_| Unverified::Frame)?;
        let r0 = session_binding::parse_resolved(&results[1]).map_err(|_| Unverified::Frame)?;
        if !results[2].utf8_valid {
            return Err(Unverified::Frame);
        }
        let InventoryOutcome::Snapshot(i) = self.query.inventory().classify(&results[2]) else {
            return Err(Unverified::Frame);
        };
        let r1 = session_binding::parse_resolved(&results[3]).map_err(|_| Unverified::Frame)?;
        let l1 = session_binding::parse_list(&results[4]).map_err(|_| Unverified::Frame)?;
        let bound =
            session_binding::correlate(&l0, &r0, &i, &r1, &l1, self.selected.session_id, None)
                .map_err(|_| Unverified::Changed)?;
        if bound.selected != self.selected {
            return Err(Unverified::Changed);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
