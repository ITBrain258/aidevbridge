//! Read-only numeric inventory basis for the measured tmux versions.
//!
//! This module neither polls nor owns the session list. A Snapshot is complete
//! numeric evidence; only a future identity-aware reducer can infer the end of
//! a previously bound object. Transport errors stay outside this classifier.

use crate::{remote, transport::ExecResult};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_INVENTORY_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeasuredVersion {
    V3_0,
    V3_3A,
    V3_4,
    V3_6,
}

impl MeasuredVersion {
    /// Accept the complete measured `tmux -V` response, not a version prefix.
    ///
    /// `tmux 3.6\n` is the exact answer of the Ubuntu 26.04 package
    /// `tmux 3.6a-2ubuntu0.1`, measured on 2026-10-11. An unmodified upstream
    /// 3.6a build answers `tmux 3.6a\n`; that, 3.5 and 3.5a stay unmeasured.
    pub fn from_response(result: &ExecResult) -> Option<Self> {
        if result.code != 0 || !result.stderr.is_empty() {
            return None;
        }
        match result.stdout.as_str() {
            "tmux 3.0\n" => Some(Self::V3_0),
            "tmux 3.3a\n" => Some(Self::V3_3A),
            "tmux 3.4\n" => Some(Self::V3_4),
            "tmux 3.6\n" => Some(Self::V3_6),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("invalid tmux socket address")]
pub struct InvalidSocket;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Socket {
    Named(String),
    Absolute(String),
}

/// Command envelope style. Not a host version measurement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandEnvelope {
    ConservativelyGuarded,
    DirectDisplay,
}

impl MeasuredVersion {
    fn envelope(self) -> CommandEnvelope {
        match self {
            Self::V3_0 => CommandEnvelope::ConservativelyGuarded,
            Self::V3_3A | Self::V3_4 | Self::V3_6 => CommandEnvelope::DirectDisplay,
        }
    }
}

/// The same validated socket context builds the command and classifies its
/// response. Named sockets deliberately have no inferred diagnostic path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventoryQuery {
    envelope: CommandEnvelope,
    socket: Socket,
}

impl InventoryQuery {
    /// Shared only with the measured session-binding builders; both address
    /// exactly this validated socket, without reconstructing a diagnostic path.
    pub(super) fn socket_args(&self) -> [&str; 2] {
        match &self.socket {
            Socket::Named(name) => ["-L", name.as_str()],
            Socket::Absolute(path) => ["-S", path.as_str()],
        }
    }

    pub fn named(version: MeasuredVersion, name: &str) -> Result<Self, InvalidSocket> {
        if !bounded_address(name) || name.contains('/') || matches!(name, "." | "..") {
            return Err(InvalidSocket);
        }
        Ok(Self {
            envelope: version.envelope(),
            socket: Socket::Named(name.into()),
        })
    }

    pub fn absolute(version: MeasuredVersion, path: &str) -> Result<Self, InvalidSocket> {
        if !bounded_address(path)
            || !path.starts_with('/')
            || path[1..].split('/').any(|s| matches!(s, "" | "." | ".."))
        {
            return Err(InvalidSocket);
        }
        Ok(Self {
            envelope: version.envelope(),
            socket: Socket::Absolute(path.into()),
        })
    }

    /// Conservatively guarded B/E envelope (`if-shell` + list-commands).
    /// This is a command style, not evidence that the host is tmux 3.0.
    pub fn conservatively_guarded_named(name: &str) -> Result<Self, InvalidSocket> {
        if !bounded_address(name) || name.contains('/') || matches!(name, "." | "..") {
            return Err(InvalidSocket);
        }
        Ok(Self {
            envelope: CommandEnvelope::ConservativelyGuarded,
            socket: Socket::Named(name.into()),
        })
    }

    /// Absolute-socket form of [`Self::conservatively_guarded_named`].
    pub fn conservatively_guarded_absolute(path: &str) -> Result<Self, InvalidSocket> {
        if !bounded_address(path)
            || !path.starts_with('/')
            || path[1..].split('/').any(|s| matches!(s, "" | "." | ".."))
        {
            return Err(InvalidSocket);
        }
        Ok(Self {
            envelope: CommandEnvelope::ConservativelyGuarded,
            socket: Socket::Absolute(path.into()),
        })
    }

    /// Static nested tmux syntax; only the separate socket argv value varies.
    /// No start-server, direct list-commands, shell test, metadata or user format.
    pub fn command(&self) -> String {
        let (flag, socket) = match &self.socket {
            Socket::Named(name) => ("-L", name.as_str()),
            Socket::Absolute(path) => ("-S", path.as_str()),
        };
        let mut argv = vec!["env", "LC_ALL=C", "tmux", "-u", flag, socket];
        match self.envelope {
            CommandEnvelope::ConservativelyGuarded => {
                argv.extend(["if-shell", "-F", "1", BEGIN_3_0])
            }
            CommandEnvelope::DirectDisplay => argv.extend(["display-message", "-p", BEGIN]),
        }
        argv.extend([
            ";",
            "list-sessions",
            "-F",
            SESSIONS,
            ";",
            "if-shell",
            "-F",
            "#{session_id}",
            PANES_COMMAND,
            ";",
        ]);
        match self.envelope {
            CommandEnvelope::ConservativelyGuarded => argv.extend(["if-shell", "-F", "1", END_3_0]),
            CommandEnvelope::DirectDisplay => argv.extend(["display-message", "-p", END]),
        }
        remote::build(&argv)
    }

    /// Call only for an actual completed ExecResult. Missing exit status,
    /// transport failure, deadline and transport output limits are errors from
    /// the existing transport, not fabricated successful results with flags.
    pub fn classify(&self, result: &ExecResult) -> InventoryOutcome {
        if result.stdout.len().saturating_add(result.stderr.len()) > MAX_INVENTORY_BYTES {
            return InventoryOutcome::Incomplete(IncompleteReason::OutputLimit);
        }
        if result.code != 0 || !result.stderr.is_empty() {
            if let Socket::Absolute(path) = &self.socket {
                if result.code == 1
                    && result.stdout.is_empty()
                    && (result.stderr == format!("no server running on {path}\n")
                        || result.stderr
                            == format!("error connecting to {path} (No such file or directory)\n"))
                {
                    return InventoryOutcome::NoServer;
                }
            }
            return InventoryOutcome::TmuxError { code: result.code };
        }
        match parse_numeric(&result.stdout) {
            Ok(snapshot) => InventoryOutcome::Snapshot(snapshot),
            Err(reason) => InventoryOutcome::Incomplete(reason),
        }
    }
}

fn bounded_address(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

const BEGIN: &str = "B|#{pid}|#{start_time}";
const END: &str = "E|#{pid}|#{start_time}";
const SESSIONS: &str = "Q|#{session_id}|#{session_windows}";
const PANES_COMMAND: &str = "list-panes -a -F 'P|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{window_active}|#{pane_active}|#{pane_dead}|#{alternate_on}|#{session_attached}|#{window_activity}|#{window_bell_flag}|#{window_panes}'";
// Direct list-commands has CMD_STARTSERVER in 3.0. Its enclosing constant
// if-shell -F is essential, including when the addressed socket is absent.
const BEGIN_3_0: &str =
    "list-commands -F '#{?#{==:#{command_list_name},display-message},B|#{pid}|#{start_time},}'";
const END_3_0: &str =
    "list-commands -F '#{?#{==:#{command_list_name},display-message},E|#{pid}|#{start_time},}'";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SessionId(pub u32);
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct WindowId(pub u32);
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PaneId(pub u32);

/// tmux's observed generation components, not a boot ID or a liveness proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerIdentity {
    pub pid: u32,
    pub start_time: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInventory {
    pub id: SessionId,
    pub window_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneInventory {
    pub session_id: SessionId,
    pub window_id: WindowId,
    pub pane_id: PaneId,
    /// Pane start process, not necessarily the current agent.
    pub pane_pid: u32,
    pub window_active: bool,
    pub pane_active: bool,
    pub pane_dead: bool,
    pub alternate_on: bool,
    pub session_attached: u32,
    /// Output activity and Bell are never working/waiting status sources.
    pub window_activity: u64,
    pub window_bell: bool,
    pub window_panes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventorySnapshot {
    pub server: ServerIdentity,
    pub sessions: Vec<SessionInventory>,
    pub panes: Vec<PaneInventory>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InventoryOutcome {
    Snapshot(InventorySnapshot),
    /// Exact observed absent-socket diagnosis, not an empty error response.
    NoServer,
    TmuxError {
        code: u32,
    },
    /// No partial inventory escapes this branch; it cannot prove absence.
    Incomplete(IncompleteReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncompleteReason {
    OutputLimit,
    InvalidFrame,
    InvalidNumber,
    DuplicateIdentity,
    InconsistentInventory,
    UnsupportedLinkedWindows,
}

pub(super) fn number(value: &str) -> Result<u64, IncompleteReason> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(IncompleteReason::InvalidNumber);
    }
    value.parse().map_err(|_| IncompleteReason::InvalidNumber)
}

pub(super) fn number32(value: &str, positive: bool) -> Result<u32, IncompleteReason> {
    let n = u32::try_from(number(value)?).map_err(|_| IncompleteReason::InvalidNumber)?;
    if positive && n == 0 {
        return Err(IncompleteReason::InvalidNumber);
    }
    Ok(n)
}

pub(super) fn id(value: &str, prefix: char) -> Result<u32, IncompleteReason> {
    number32(
        value
            .strip_prefix(prefix)
            .ok_or(IncompleteReason::InvalidNumber)?,
        false,
    )
}

pub(super) fn flag(value: &str) -> Result<bool, IncompleteReason> {
    match value {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(IncompleteReason::InvalidNumber),
    }
}

fn server(line: &str, marker: &str) -> Result<ServerIdentity, IncompleteReason> {
    let fields: Vec<_> = line.split('|').collect();
    if fields.len() != 3 || fields[0] != marker {
        return Err(IncompleteReason::InvalidFrame);
    }
    let pid = number32(fields[1], true)?;
    let start_time = number(fields[2])?;
    if start_time == 0 {
        return Err(IncompleteReason::InvalidNumber);
    }
    Ok(ServerIdentity { pid, start_time })
}

fn parse_numeric(data: &str) -> Result<InventorySnapshot, IncompleteReason> {
    if !data.ends_with('\n')
        || !data
            .bytes()
            .all(|b| b == b'\n' || (b' '..=b'~').contains(&b))
    {
        return Err(IncompleteReason::InvalidFrame);
    }
    let mut lines = data.split_terminator('\n').peekable();
    let beginning = server(lines.next().ok_or(IncompleteReason::InvalidFrame)?, "B")?;
    let mut sessions = BTreeMap::new();
    let mut panes = Vec::new();
    let mut pane_ids = BTreeSet::new();
    let mut window_owners = BTreeMap::new();
    let mut ended = false;
    while let Some(line) = lines.next() {
        if lines.peek().is_none() {
            if server(line, "E")? != beginning {
                return Err(IncompleteReason::InvalidFrame);
            }
            ended = true;
            break;
        }
        let fields: Vec<_> = line.split('|').collect();
        match fields.as_slice() {
            ["Q", sid, count] if panes.is_empty() => {
                let sid = SessionId(id(sid, '$')?);
                if sessions.insert(sid, number32(count, true)?).is_some() {
                    return Err(IncompleteReason::DuplicateIdentity);
                }
            }
            ["P", sid, wid, pid, process, wa, pa, dead, alternate, attached, activity, bell, count] =>
            {
                let session_id = SessionId(id(sid, '$')?);
                let window_id = WindowId(id(wid, '@')?);
                let pane_id = PaneId(id(pid, '%')?);
                if !sessions.contains_key(&session_id) {
                    return Err(IncompleteReason::InconsistentInventory);
                }
                if let Some(owner) = window_owners.insert(window_id, session_id) {
                    if owner != session_id {
                        return Err(IncompleteReason::UnsupportedLinkedWindows);
                    }
                }
                if !pane_ids.insert(pane_id) {
                    return Err(IncompleteReason::DuplicateIdentity);
                }
                panes.push(PaneInventory {
                    session_id,
                    window_id,
                    pane_id,
                    pane_pid: number32(process, true)?,
                    window_active: flag(wa)?,
                    pane_active: flag(pa)?,
                    pane_dead: flag(dead)?,
                    alternate_on: flag(alternate)?,
                    session_attached: number32(attached, false)?,
                    window_activity: number(activity)?,
                    window_bell: flag(bell)?,
                    window_panes: number32(count, true)?,
                });
            }
            _ => return Err(IncompleteReason::InvalidFrame),
        }
    }
    if !ended {
        return Err(IncompleteReason::InvalidFrame);
    }
    validate_inventory(&sessions, &panes)?;
    Ok(InventorySnapshot {
        server: beginning,
        sessions: sessions
            .into_iter()
            .map(|(id, window_count)| SessionInventory { id, window_count })
            .collect(),
        panes,
    })
}

fn validate_inventory(
    sessions: &BTreeMap<SessionId, u32>,
    panes: &[PaneInventory],
) -> Result<(), IncompleteReason> {
    let mut windows: BTreeMap<SessionId, BTreeMap<WindowId, Vec<&PaneInventory>>> = BTreeMap::new();
    for pane in panes {
        windows
            .entry(pane.session_id)
            .or_default()
            .entry(pane.window_id)
            .or_default()
            .push(pane);
    }
    for (sid, count) in sessions {
        let owned = windows
            .get(sid)
            .ok_or(IncompleteReason::InconsistentInventory)?;
        if owned.len() as u64 != u64::from(*count)
            || owned.values().filter(|rows| rows[0].window_active).count() != 1
        {
            return Err(IncompleteReason::InconsistentInventory);
        }
        let mut attached = None;
        for rows in owned.values() {
            let first = rows[0];
            if rows.len() as u64 != u64::from(first.window_panes)
                || rows.iter().filter(|p| p.pane_active).count() != 1
            {
                return Err(IncompleteReason::InconsistentInventory);
            }
            for pane in rows {
                if pane.window_active != first.window_active
                    || pane.window_panes != first.window_panes
                    || pane.window_activity != first.window_activity
                    || pane.window_bell != first.window_bell
                    || attached.is_some_and(|value| value != pane.session_attached)
                {
                    return Err(IncompleteReason::InconsistentInventory);
                }
                attached = Some(pane.session_attached);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
