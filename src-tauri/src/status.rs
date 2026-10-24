//! Inventory-, title- and CLI-backed session status. No host files are
//! written.
//!
//! Inventory yields unknown/ended. For Codex and Grok the pane title may
//! replace unknown with busy/waiting/idle (`title`); a matching
//! `claude agents --json` row does so for Claude and outranks a title. Hooks
//! and writers are out of scope.

use crate::tmux::client::ListedSessionObservation;
use crate::tmux::inventory::{InventorySnapshot, PaneId, PaneInventory, SessionId};
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::BTreeSet;

pub mod title;

/// `waitingFor` values. Claude Code 2.1.309 adds "goal proposal" and counts
/// it as a permission, like "permission prompt" (read from its bundle on
/// 2026-10-23, `docs/messungen/messung-2026-10-23-agentversionen.md`).
const WAITING: &[&str] = &[
    "permission prompt",
    "input needed",
    "sandbox request",
    "worker request",
    "dialog open",
    "goal proposal",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Unknown,
    Ended,
    Busy,
    Waiting,
    Idle,
}

impl StatusKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Ended => "ended",
            Self::Busy => "busy",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStatus {
    pub session_id: Option<SessionId>,
    pub display_name: String,
    pub kind: StatusKind,
    pub reason: String,
    pub source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    pub pid: u32,
    pub kind: StatusKind,
    pub waiting_for: Option<String>,
}

/// Only a document that is not a JSON array fails the whole snapshot; a
/// single unrecognized row is an unknown row (`agent_row`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentsParse {
    InvalidJson,
    NotArray,
}

pub fn agents_command() -> String {
    // Non-interactive SSH has no login PATH. Claude's installer puts the
    // binary in ~/.local/bin; this only prepends that directory.
    crate::remote::build(&[
        "sh",
        "-c",
        r#"PATH="${HOME:+$HOME/.local/bin:}${PATH:-/usr/bin:/bin}"; export PATH; exec env DISABLE_AUTOUPDATER=1 claude agents --json"#,
    ])
}

pub fn from_listing(row: &ListedSessionObservation) -> SessionStatus {
    SessionStatus {
        session_id: Some(row.session_id),
        display_name: row.display_name.clone(),
        kind: StatusKind::Unknown,
        reason: match &row.binding {
            Ok(_) => "no agent source is attached yet".into(),
            Err(_) => "numeric binding is unverified".into(),
        },
        source: "inventory",
    }
}

/// Only a complete current inventory may mark a previously bound id ended.
/// Nur fuer Tests: der Poll setzt "ended" allein ueber die tote aktive Pane
/// (`statuses_from_inventory`).
#[cfg(test)]
pub fn after_complete_inventory(
    previous: &SessionStatus,
    present: &BTreeSet<SessionId>,
) -> SessionStatus {
    match previous.session_id {
        Some(id) if !present.contains(&id) => SessionStatus {
            session_id: Some(id),
            display_name: previous.display_name.clone(),
            kind: StatusKind::Ended,
            reason: "bound session is absent from a complete inventory".into(),
            source: "inventory",
        },
        _ => previous.clone(),
    }
}

pub fn parse_agents(stdout: &str) -> Result<Vec<AgentRow>, AgentsParse> {
    let value: Value = serde_json::from_str(stdout).map_err(|_| AgentsParse::InvalidJson)?;
    let Value::Array(rows) = value else {
        return Err(AgentsParse::NotArray);
    };
    let mut agents = Vec::new();
    for row in rows {
        let Value::Object(map) = row else {
            continue;
        };
        if map.get("kind").and_then(Value::as_str) != Some("interactive") {
            continue;
        }
        let Some(pid) = map
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
        else {
            continue;
        };
        agents.push(agent_row(
            pid,
            map.get("status").and_then(Value::as_str),
            map.get("waitingFor").and_then(Value::as_str),
        ));
    }
    Ok(agents)
}

/// One interactive row. A value outside the measured vocabulary (a newer
/// Claude, a waiting reason that does not fit its status) makes only this
/// row unknown.
fn agent_row(pid: u32, status: Option<&str>, waiting: Option<&str>) -> AgentRow {
    let (kind, waiting_for) = match (status, waiting) {
        (Some("busy"), None) => (StatusKind::Busy, None),
        (Some("idle"), None) => (StatusKind::Idle, None),
        (Some("waiting"), Some(reason)) if WAITING.contains(&reason) => {
            (StatusKind::Waiting, Some(reason.to_owned()))
        }
        _ => (StatusKind::Unknown, None),
    };
    AgentRow {
        pid,
        kind,
        waiting_for,
    }
}

pub fn parse_parents(stdout: &str) -> BTreeMap<u32, u32> {
    let mut parents = BTreeMap::new();
    for line in stdout.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_ascii_whitespace();
        let Some(pid) = parts.next().and_then(|s| s.parse().ok()) else {
            continue;
        };
        let Some(ppid) = parts.next().and_then(|s| s.parse().ok()) else {
            continue;
        };
        if parts.next().is_some() {
            continue;
        }
        parents.insert(pid, ppid);
    }
    parents
}

/// Read-only /proc PPid lookup for already observed CLI pids. No command lines.
pub fn parents_command(pids: &[u32]) -> Option<String> {
    if pids.is_empty() {
        return None;
    }
    let mut unique = pids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let list = unique
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    Some(crate::remote::build(&[
        "sh",
        "-c",
        &format!(
            r#"for pid in {list}; do
  if [ -r "/proc/$pid/status" ]; then
    awk 'BEGIN {{ pid=""; ppid="" }} /^Pid:/ {{ pid=$2 }} /^PPid:/ {{ ppid=$2 }} END {{ if (pid != "" && ppid != "") print pid, ppid }}' "/proc/$pid/status"
  fi
done"#
        ),
    ]))
}

fn row_matches_pane(row: &AgentRow, pane_pid: u32, parents: &BTreeMap<u32, u32>) -> bool {
    row.pid == pane_pid || parents.get(&row.pid) == Some(&pane_pid)
}

/// Bind at most one interactive CLI row that is the pane start process or its
/// direct child. Ended inventory status is never revived. Ambiguous or missing
/// rows stay unknown.
pub fn apply_cli(
    previous: SessionStatus,
    pane_pid: Option<u32>,
    agents: &[AgentRow],
    parents: &BTreeMap<u32, u32>,
) -> SessionStatus {
    if previous.kind == StatusKind::Ended {
        return previous;
    }
    let Some(pid) = pane_pid else {
        return previous;
    };
    let matches: Vec<_> = agents
        .iter()
        .filter(|row| row_matches_pane(row, pid, parents))
        .collect();
    match matches.as_slice() {
        [row] => SessionStatus {
            session_id: previous.session_id,
            display_name: previous.display_name,
            kind: row.kind,
            reason: row.waiting_for.clone().unwrap_or_else(|| match row.kind {
                StatusKind::Busy => "agent is busy".into(),
                StatusKind::Idle => "agent is idle".into(),
                StatusKind::Unknown => "claude reported an unrecognized status".into(),
                _ => previous.reason,
            }),
            source: "claude-agents-json",
        },
        [] => previous,
        _ => SessionStatus {
            kind: StatusKind::Unknown,
            reason: "multiple CLI rows share this pane process".into(),
            source: "claude-agents-json",
            ..previous
        },
    }
}

/// Status of one inventory session for the slim poll: no names, no list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolledStatus {
    pub session_id: SessionId,
    pub kind: StatusKind,
    pub reason: String,
}

fn unobserved(id: SessionId, reason: &str) -> SessionStatus {
    SessionStatus {
        session_id: Some(id),
        display_name: String::new(),
        kind: StatusKind::Unknown,
        reason: reason.into(),
        source: "inventory",
    }
}

/// The title source (`title::pane_status`) for a status no CLI row has spoken
/// for yet: `apply_cli` runs after it, so a bound Claude row still wins.
/// Ended stays ended.
pub fn apply_title(previous: SessionStatus, details: Option<&title::PaneDetails>) -> SessionStatus {
    if previous.kind == StatusKind::Ended {
        return previous;
    }
    match details.and_then(title::pane_status) {
        Some((kind, reason)) => SessionStatus {
            kind,
            reason: reason.into(),
            source: "pane-title",
            ..previous
        },
        None => previous,
    }
}

/// The session's single active pane (active window, active pane), if there
/// is exactly one.
fn single_active_pane(inventory: &InventorySnapshot, id: SessionId) -> Option<&PaneInventory> {
    let mut active = inventory
        .panes
        .iter()
        .filter(|p| p.session_id == id && p.window_active && p.pane_active);
    match (active.next(), active.next()) {
        (Some(pane), None) => Some(pane),
        _ => None,
    }
}

/// The panes whose titles a poll reads: the live single active pane of each
/// session, with its start process.
pub fn title_panes(inventory: &InventorySnapshot) -> Vec<(PaneId, u32)> {
    inventory
        .sessions
        .iter()
        .filter_map(|session| single_active_pane(inventory, session.id))
        .filter(|pane| !pane.pane_dead)
        .map(|pane| (pane.pane_id, pane.pane_pid))
        .collect()
}

fn selected_pane(row: &ListedSessionObservation) -> Option<(PaneId, u32)> {
    row.binding
        .as_ref()
        .ok()
        .map(|bound| (bound.selected.pane_id, bound.selected.pane_pid))
}

/// The panes whose titles a list refresh reads: each bound session's
/// selected pane, as the poll reads its active pane.
pub fn listed_title_panes(rows: &[ListedSessionObservation]) -> Vec<(PaneId, u32)> {
    rows.iter().filter_map(selected_pane).collect()
}

/// A listed session's status from the same sources as the poll, so a list
/// refresh does not undo it: a dead active pane is ended as in the poll, else
/// its selected pane's title, then a bound CLI row. Without the first rule a
/// restored tile of an ended session saw Unknown and tried to attach.
pub fn listed_status(
    row: &ListedSessionObservation,
    inventory: &InventorySnapshot,
    agents: &[AgentRow],
    parents: &BTreeMap<u32, u32>,
    titles: &BTreeMap<PaneId, title::PaneDetails>,
) -> SessionStatus {
    if single_active_pane(inventory, row.session_id).is_some_and(|pane| pane.pane_dead) {
        return SessionStatus {
            kind: StatusKind::Ended,
            reason: "the session's pane is dead".into(),
            ..from_listing(row)
        };
    }
    let pane = selected_pane(row);
    apply_cli(
        apply_title(from_listing(row), pane.and_then(|(id, _)| titles.get(&id))),
        pane.map(|(_, pid)| pid),
        agents,
        parents,
    )
}

/// One complete inventory, one CLI snapshot and the active panes' titles.
/// Each session is judged by its single active pane; hidden panes never speak
/// for it. A dead active pane is ended (spec 4.4 step 2), and neither a CLI
/// row nor a title revives it.
pub fn statuses_from_inventory(
    inventory: &InventorySnapshot,
    agents: &[AgentRow],
    parents: &BTreeMap<u32, u32>,
    titles: &BTreeMap<PaneId, title::PaneDetails>,
) -> Vec<PolledStatus> {
    inventory
        .sessions
        .iter()
        .map(|session| {
            let status = match single_active_pane(inventory, session.id) {
                Some(pane) if pane.pane_dead => SessionStatus {
                    kind: StatusKind::Ended,
                    ..unobserved(session.id, "the session's pane is dead")
                },
                Some(pane) => apply_cli(
                    apply_title(
                        unobserved(session.id, "no agent source is attached yet"),
                        titles.get(&pane.pane_id),
                    ),
                    Some(pane.pane_pid),
                    agents,
                    parents,
                ),
                None => unobserved(session.id, "no single active pane"),
            };
            PolledStatus {
                session_id: session.id,
                kind: status.kind,
                reason: status.reason,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmux::client::BindingUnavailableReason;
    use crate::tmux::inventory::{
        InventorySnapshot, PaneId, PaneInventory, ServerIdentity, SessionInventory, WindowId,
    };
    use crate::tmux::session_binding::{BoundObservation, PaneIdentity, ParseError};

    fn row(id: u32, bound: bool) -> ListedSessionObservation {
        ListedSessionObservation {
            session_id: SessionId(id),
            display_name: format!("ab_{id}"),
            binding: if bound {
                Ok(BoundObservation {
                    display_name: format!("ab_{id}"),
                    selected: PaneIdentity {
                        server: ServerIdentity {
                            pid: 50,
                            start_time: 1000,
                        },
                        session_id: SessionId(id),
                        window_id: WindowId(0),
                        pane_id: PaneId(0),
                        pane_pid: 10,
                    },
                    creation_matched: false,
                })
            } else {
                Err(BindingUnavailableReason::ResolveBefore(
                    ParseError::TmuxError { code: 1 },
                ))
            },
        }
    }

    #[test]
    fn listed_rows_are_unknown_until_an_agent_source_exists() {
        let bound = from_listing(&row(0, true));
        assert_eq!(bound.kind, StatusKind::Unknown);
        assert_eq!(bound.reason, "no agent source is attached yet");
        let unverified = from_listing(&row(1, false));
        assert_eq!(unverified.kind, StatusKind::Unknown);
        assert_eq!(unverified.reason, "numeric binding is unverified");
    }

    #[test]
    fn complete_inventory_absence_ends_a_previously_bound_id() {
        let previous = from_listing(&row(0, true));
        let mut present = BTreeSet::new();
        present.insert(SessionId(1));
        let ended = after_complete_inventory(&previous, &present);
        assert_eq!(ended.kind, StatusKind::Ended);
        assert_eq!(ended.session_id, Some(SessionId(0)));
    }

    #[test]
    fn still_present_ids_are_not_ended() {
        let previous = from_listing(&row(0, true));
        let mut present = BTreeSet::new();
        present.insert(SessionId(0));
        assert_eq!(
            after_complete_inventory(&previous, &present).kind,
            StatusKind::Unknown
        );
    }

    #[test]
    fn parse_keeps_only_interactive_status_and_drops_foreign_fields() {
        let agents = parse_agents(
            r#"[{"kind":"interactive","pid":10,"status":"idle","startedAt":1,"name":"MUST_NOT_LEAK","sessionId":"abc"},{"kind":"background","pid":11,"status":"busy"}]"#,
        )
        .unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].pid, 10);
        assert_eq!(agents[0].kind, StatusKind::Idle);
        assert!(agents[0].waiting_for.is_none());
    }

    #[test]
    fn parse_accepts_an_empty_array() {
        assert!(parse_agents("[]").unwrap().is_empty());
    }

    #[test]
    fn parse_skips_background_rows_that_use_state_instead_of_status() {
        // Live 2.1.269/2.1.270 background rows have been observed with
        // `"state":"blocked"` and no `status`. They must not fail the parse.
        let agents = parse_agents(
            r#"[{"kind":"background","pid":11,"state":"blocked"},{"kind":"interactive","pid":10,"status":"idle"}]"#,
        )
        .unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].pid, 10);
        assert_eq!(agents[0].kind, StatusKind::Idle);
    }

    #[test]
    fn parse_does_not_map_background_state_as_interactive_status() {
        assert!(
            parse_agents(r#"[{"kind":"background","pid":11,"state":"blocked"}]"#)
                .unwrap()
                .is_empty()
        );
    }

    /// A Claude update may add a status or waiting reason. That row alone is
    /// unknown; it must not blank the status of every other session.
    #[test]
    fn an_unrecognized_row_becomes_unknown_without_failing_the_others() {
        let agents = parse_agents(
            r#"[{"kind":"interactive","pid":10,"status":"MUST_NOT_LEAK"},{"kind":"interactive","pid":11,"status":"waiting","waitingFor":"nope"},{"kind":"interactive","pid":12,"status":"idle","waitingFor":"permission prompt"},{"kind":"interactive","pid":14},{"kind":"interactive","pid":13,"status":"idle"}]"#,
        )
        .unwrap();
        assert_eq!(
            agents.iter().map(|a| (a.pid, a.kind)).collect::<Vec<_>>(),
            vec![
                (10, StatusKind::Unknown),
                (11, StatusKind::Unknown),
                (12, StatusKind::Unknown),
                (14, StatusKind::Unknown),
                (13, StatusKind::Idle),
            ]
        );
        assert!(agents.iter().all(|a| a.waiting_for.is_none()));
        assert_eq!(parse_agents("not json"), Err(AgentsParse::InvalidJson));
        assert_eq!(parse_agents("{}"), Err(AgentsParse::NotArray));
    }

    /// Claude Code 2.1.309 on 2026-10-23: a permission prompt and an open
    /// AskUserQuestion dialog were measured; "goal proposal" is read from its
    /// bundle, where it counts as a permission.
    #[test]
    fn every_waiting_reason_of_claude_2_1_309_is_waiting() {
        for reason in [
            "permission prompt",
            "input needed",
            "sandbox request",
            "worker request",
            "dialog open",
            "goal proposal",
        ] {
            let agents = parse_agents(&format!(
                r#"[{{"kind":"interactive","pid":10,"status":"waiting","waitingFor":"{reason}"}}]"#
            ))
            .unwrap();
            assert_eq!(agents[0].kind, StatusKind::Waiting, "{reason}");
            assert_eq!(agents[0].waiting_for.as_deref(), Some(reason));
        }
    }

    /// Measured right after start on 2026-10-23: for one read the row has no
    /// `status` yet. That row is unknown, the next read has its status.
    #[test]
    fn a_freshly_started_row_without_status_is_unknown() {
        let agents = parse_agents(
            r#"[{"pid":10,"cwd":"/tmp","kind":"interactive","startedAt":1,"sessionId":"s","name":"n"}]"#,
        )
        .unwrap();
        assert_eq!(agents[0].kind, StatusKind::Unknown);
    }

    #[test]
    fn a_bound_unrecognized_row_says_so() {
        let status = apply_cli(
            from_listing(&row(0, true)),
            Some(10),
            &[AgentRow {
                pid: 10,
                kind: StatusKind::Unknown,
                waiting_for: None,
            }],
            &BTreeMap::new(),
        );
        assert_eq!(
            (status.kind, status.reason.as_str(), status.source),
            (
                StatusKind::Unknown,
                "claude reported an unrecognized status",
                "claude-agents-json"
            )
        );
    }

    #[test]
    fn cli_row_matching_pane_pid_replaces_unknown() {
        let previous = from_listing(&row(0, true));
        let waiting = apply_cli(
            previous.clone(),
            Some(10),
            &[AgentRow {
                pid: 10,
                kind: StatusKind::Waiting,
                waiting_for: Some("permission prompt".into()),
            }],
            &BTreeMap::new(),
        );
        assert_eq!(waiting.kind, StatusKind::Waiting);
        assert_eq!(waiting.reason, "permission prompt");
        assert_eq!(waiting.source, "claude-agents-json");
        let idle = apply_cli(
            previous,
            Some(10),
            &[AgentRow {
                pid: 11,
                kind: StatusKind::Idle,
                waiting_for: None,
            }],
            &BTreeMap::new(),
        );
        assert_eq!(idle.kind, StatusKind::Unknown);
    }

    #[test]
    fn ended_status_is_not_revived_by_cli() {
        let mut present = BTreeSet::new();
        present.insert(SessionId(1));
        let ended = after_complete_inventory(&from_listing(&row(0, true)), &present);
        let revived = apply_cli(
            ended,
            Some(10),
            &[AgentRow {
                pid: 10,
                kind: StatusKind::Busy,
                waiting_for: None,
            }],
            &BTreeMap::new(),
        );
        assert_eq!(revived.kind, StatusKind::Ended);
    }

    #[test]
    fn agents_command_is_a_read_only_claude_query() {
        let args = crate::remote::command::decoded_argv(&agents_command());
        assert_eq!(args[0], "sh");
        assert_eq!(args[1], "-c");
        assert!(args[2].contains("claude agents --json"));
        assert!(args[2].contains("$HOME/.local/bin"));
        assert!(args[2].contains("DISABLE_AUTOUPDATER=1"));
        assert!(!args[2].contains("install"));
    }

    #[test]
    fn direct_child_of_the_pane_shell_binds_when_pid_is_not_the_pane() {
        let previous = from_listing(&row(0, true));
        let mut parents = BTreeMap::new();
        parents.insert(25040, 24959);
        let idle = apply_cli(
            previous,
            Some(24959),
            &[AgentRow {
                pid: 25040,
                kind: StatusKind::Idle,
                waiting_for: None,
            }],
            &parents,
        );
        assert_eq!(idle.kind, StatusKind::Idle);
        assert_eq!(idle.source, "claude-agents-json");
    }

    #[test]
    fn a_foreign_interactive_row_with_another_parent_does_not_bind() {
        let previous = from_listing(&row(0, true));
        let mut parents = BTreeMap::new();
        parents.insert(897304, 890035);
        parents.insert(906266, 905891);
        let bound = apply_cli(
            previous,
            Some(905891),
            &[
                AgentRow {
                    pid: 897304,
                    kind: StatusKind::Busy,
                    waiting_for: None,
                },
                AgentRow {
                    pid: 906266,
                    kind: StatusKind::Idle,
                    waiting_for: None,
                },
            ],
            &parents,
        );
        assert_eq!(bound.kind, StatusKind::Idle);
    }

    #[test]
    fn two_direct_children_of_the_same_pane_stay_unknown() {
        let previous = from_listing(&row(0, true));
        let mut parents = BTreeMap::new();
        parents.insert(11, 10);
        parents.insert(12, 10);
        let ambiguous = apply_cli(
            previous,
            Some(10),
            &[
                AgentRow {
                    pid: 11,
                    kind: StatusKind::Idle,
                    waiting_for: None,
                },
                AgentRow {
                    pid: 12,
                    kind: StatusKind::Busy,
                    waiting_for: None,
                },
            ],
            &parents,
        );
        assert_eq!(ambiguous.kind, StatusKind::Unknown);
        assert_eq!(
            ambiguous.reason,
            "multiple CLI rows share this pane process"
        );
    }

    #[test]
    fn parse_parents_keeps_only_pid_ppid_pairs() {
        let parents = parse_parents("25040 24959\n906266 905891\nbad\n1 2 3\n");
        assert_eq!(parents.get(&25040), Some(&24959));
        assert_eq!(parents.get(&906266), Some(&905891));
        assert_eq!(parents.len(), 2);
    }

    #[test]
    fn parents_command_is_a_read_only_proc_lookup() {
        let args =
            crate::remote::command::decoded_argv(&parents_command(&[25040, 906266]).unwrap());
        assert_eq!(args[0], "sh");
        assert!(args[2].contains("/proc/"));
        assert!(args[2].contains("25040"));
        assert!(args[2].contains("906266"));
        assert!(args[2].contains("PPid:"));
        assert!(!args[2].contains("kill"));
        assert!(!args[2].contains("install"));
        assert!(parents_command(&[]).is_none());
    }

    fn pane(
        session: u32,
        window: u32,
        pane: u32,
        pid: u32,
        active: bool,
        dead: bool,
    ) -> PaneInventory {
        PaneInventory {
            session_id: SessionId(session),
            window_id: WindowId(window),
            pane_id: PaneId(pane),
            pane_pid: pid,
            window_active: active,
            pane_active: active,
            pane_dead: dead,
            alternate_on: false,
            session_attached: 0,
            window_activity: 0,
            window_bell: false,
            window_panes: 1,
        }
    }

    fn inventory(sessions: &[u32], panes: Vec<PaneInventory>) -> InventorySnapshot {
        InventorySnapshot {
            server: ServerIdentity {
                pid: 50,
                start_time: 1000,
            },
            sessions: sessions
                .iter()
                .map(|&id| SessionInventory {
                    id: SessionId(id),
                    window_count: 1,
                })
                .collect(),
            panes,
        }
    }

    fn agent(pid: u32, kind: StatusKind) -> AgentRow {
        AgentRow {
            pid,
            kind,
            waiting_for: (kind == StatusKind::Waiting).then(|| "permission prompt".into()),
        }
    }

    #[test]
    fn a_polled_session_takes_the_status_of_its_active_pane_only() {
        // Pane 10 is the active pane; its shell's child 11 is waiting. A Claude
        // in a hidden window (child 21 of pane 20) must not win.
        let hidden = pane(0, 1, 1, 20, false, false);
        let snapshot = inventory(&[0], vec![pane(0, 0, 0, 10, true, false), hidden]);
        let mut parents = BTreeMap::new();
        parents.insert(11, 10);
        parents.insert(21, 20);
        let statuses = statuses_from_inventory(
            &snapshot,
            &[agent(21, StatusKind::Busy), agent(11, StatusKind::Waiting)],
            &parents,
            &BTreeMap::new(),
        );
        assert_eq!(
            statuses,
            vec![PolledStatus {
                session_id: SessionId(0),
                kind: StatusKind::Waiting,
                reason: "permission prompt".into(),
            }]
        );
    }

    #[test]
    fn a_dead_active_pane_is_ended_and_revived_by_neither_a_cli_row_nor_a_title() {
        let snapshot = inventory(&[0], vec![pane(0, 0, 0, 10, true, true)]);
        let titles = BTreeMap::from([(PaneId(0), codex_waiting())]);
        let statuses = statuses_from_inventory(
            &snapshot,
            &[agent(10, StatusKind::Busy)],
            &BTreeMap::new(),
            &titles,
        );
        assert_eq!(statuses[0].kind, StatusKind::Ended);
        assert_eq!(statuses[0].reason, "the session's pane is dead");
    }

    #[test]
    fn a_session_without_exactly_one_active_pane_stays_unknown() {
        // Session 0 reports two active panes; session 1 has none at all.
        let snapshot = inventory(
            &[0, 1],
            vec![
                pane(0, 0, 0, 10, true, false),
                pane(0, 0, 1, 11, true, false),
            ],
        );
        let statuses = statuses_from_inventory(
            &snapshot,
            &[agent(10, StatusKind::Idle)],
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            statuses
                .iter()
                .map(|s| (s.session_id, s.kind, s.reason.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (SessionId(0), StatusKind::Unknown, "no single active pane"),
                (SessionId(1), StatusKind::Unknown, "no single active pane"),
            ]
        );
    }

    #[test]
    fn a_polled_session_without_a_cli_row_is_unknown() {
        let snapshot = inventory(&[0], vec![pane(0, 0, 0, 10, true, false)]);
        assert_eq!(
            statuses_from_inventory(&snapshot, &[], &BTreeMap::new(), &BTreeMap::new()),
            vec![PolledStatus {
                session_id: SessionId(0),
                kind: StatusKind::Unknown,
                reason: "no agent source is attached yet".into(),
            }]
        );
    }

    fn codex_waiting() -> title::PaneDetails {
        title::PaneDetails {
            title: Some("[ ! ] Action Required | thread | home".into()),
            children: vec!["/usr/bin/node".into()],
            grandchildren: vec!["/usr/lib/node_modules/@openai/codex/bin/codex".into()],
            codex: title::CodexTitle::Full,
        }
    }

    #[test]
    fn a_polled_session_without_a_cli_row_takes_its_active_pane_title() {
        // Session 0's active pane runs Codex. Session 1 has the same title
        // only on a hidden pane, which speaks for nothing.
        let snapshot = inventory(
            &[0, 1],
            vec![
                pane(0, 0, 0, 10, true, false),
                pane(1, 1, 1, 20, true, false),
                pane(1, 2, 2, 30, false, false),
            ],
        );
        let titles = BTreeMap::from([(PaneId(0), codex_waiting()), (PaneId(2), codex_waiting())]);
        let statuses = statuses_from_inventory(&snapshot, &[], &BTreeMap::new(), &titles);
        assert_eq!(
            statuses
                .iter()
                .map(|s| (s.session_id, s.kind, s.reason.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (
                    SessionId(0),
                    StatusKind::Waiting,
                    "action required (Codex title)"
                ),
                (
                    SessionId(1),
                    StatusKind::Unknown,
                    "no agent source is attached yet"
                ),
            ]
        );
    }

    #[test]
    fn a_bound_cli_row_outranks_the_title() {
        let snapshot = inventory(&[0], vec![pane(0, 0, 0, 10, true, false)]);
        let titles = BTreeMap::from([(PaneId(0), codex_waiting())]);
        let statuses = statuses_from_inventory(
            &snapshot,
            &[agent(10, StatusKind::Idle)],
            &BTreeMap::new(),
            &titles,
        );
        assert_eq!(
            (statuses[0].kind, statuses[0].reason.as_str()),
            (StatusKind::Idle, "agent is idle")
        );
    }

    #[test]
    fn titles_are_read_for_the_live_single_active_pane_of_each_session() {
        let snapshot = inventory(
            &[0, 1, 2],
            vec![
                pane(0, 0, 0, 10, true, false),
                pane(0, 1, 1, 11, false, false),
                pane(1, 2, 2, 20, true, true),
                pane(2, 3, 3, 30, true, false),
                pane(2, 3, 4, 31, true, false),
            ],
        );
        assert_eq!(title_panes(&snapshot), vec![(PaneId(0), 10)]);
    }

    #[test]
    fn a_listed_row_takes_the_title_status_but_an_ended_one_stays_ended() {
        let listed = apply_title(from_listing(&row(0, true)), Some(&codex_waiting()));
        assert_eq!(
            (listed.kind, listed.reason.as_str(), listed.source),
            (
                StatusKind::Waiting,
                "action required (Codex title)",
                "pane-title"
            )
        );
        let ended = SessionStatus {
            kind: StatusKind::Ended,
            ..from_listing(&row(0, true))
        };
        assert_eq!(apply_title(ended.clone(), Some(&codex_waiting())), ended);
        let plain = from_listing(&row(0, true));
        assert_eq!(apply_title(plain.clone(), None), plain);
    }

    /// A list refresh must not undo what the poll shows: it reads the same
    /// title for each bound session's selected pane.
    #[test]
    fn a_listed_session_reads_the_title_of_its_selected_pane() {
        let rows = [row(0, true), row(1, false)];
        let snapshot = inventory(
            &[0, 1],
            vec![
                pane(0, 0, 0, 10, true, false),
                pane(1, 1, 1, 20, true, false),
            ],
        );
        assert_eq!(listed_title_panes(&rows), vec![(PaneId(0), 10)]);
        let titles = BTreeMap::from([(PaneId(0), codex_waiting())]);
        let bound = listed_status(&rows[0], &snapshot, &[], &BTreeMap::new(), &titles);
        assert_eq!(
            (bound.kind, bound.reason.as_str()),
            (StatusKind::Waiting, "action required (Codex title)")
        );
        // An unverified binding names no pane, so no title speaks for it.
        let unbound = listed_status(&rows[1], &snapshot, &[], &BTreeMap::new(), &titles);
        assert_eq!(
            (unbound.kind, unbound.reason.as_str()),
            (StatusKind::Unknown, "numeric binding is unverified")
        );
    }

    /// The poll's first rule holds for the list too: a dead active pane is
    /// ended, bound or not, and neither a title nor a CLI row revives it.
    #[test]
    fn a_listed_session_with_a_dead_active_pane_is_ended() {
        let rows = [row(0, true), row(1, false)];
        let snapshot = inventory(
            &[0, 1],
            vec![pane(0, 0, 0, 10, true, true), pane(1, 1, 1, 20, true, true)],
        );
        let titles = BTreeMap::from([(PaneId(0), codex_waiting())]);
        for listed in &rows {
            let status = listed_status(
                listed,
                &snapshot,
                &[agent(10, StatusKind::Busy)],
                &BTreeMap::new(),
                &titles,
            );
            assert_eq!(
                (
                    status.kind,
                    status.reason.as_str(),
                    status.display_name.as_str()
                ),
                (
                    StatusKind::Ended,
                    "the session's pane is dead",
                    listed.display_name.as_str()
                )
            );
        }
    }
}
