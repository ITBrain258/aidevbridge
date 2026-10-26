//! Measured L/R/C observations and numeric action command builders.
//!
//! Callers must use one socket, control generation and absolute deadline for
//! L-before/R-before/inventory/R-after/L-after. The parsers accept only completed
//! ExecResults; transport failures never become fabricated empty observations.
//! A rename and reversal wholly between observations cannot be detected.
//! Building a guard does not authorize an action or confirm an attached PTY.

use super::inventory::{
    flag, id, number, number32, IncompleteReason, InventoryQuery, InventorySnapshot, PaneId,
    ServerIdentity, SessionId, WindowId, MAX_INVENTORY_BYTES,
};
use crate::{remote, transport::ExecResult};
use std::collections::{BTreeMap, BTreeSet};

pub const LIST_FORMAT: &str = "L|#{pid}|#{start_time}|#{session_id}|#{session_name}";
pub const RESOLVE_FORMAT: &str = "R|#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{window_active}|#{session_windows}";
pub const CREATE_FORMAT: &str =
    "C|#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}";

// Keep the measured, target-independent false branch: display-message needs a
// pane in tmux 3.0. This must remain inside if-shell, since invoking
// list-commands directly could start an absent server in that version.
const GUARD_REJECT: &str =
    "list-commands -F '#{?#{==:#{command_list_name},display-message},AB_M1_REJECT,}'";

/// All builders use the inventory's already validated socket address. There is
/// no separately inferred diagnostic path for a named socket.
pub struct BindingQuery {
    inventory: InventoryQuery,
}

impl BindingQuery {
    pub fn new(inventory: InventoryQuery) -> Self {
        Self { inventory }
    }

    pub fn inventory(&self) -> &InventoryQuery {
        &self.inventory
    }

    fn query_command(&self, args: &[&str]) -> String {
        let [flag, socket] = self.inventory.socket_args();
        let mut argv = vec!["env", "LC_ALL=C", "tmux", "-u", flag, socket];
        argv.extend_from_slice(args);
        remote::build(&argv)
    }

    pub fn list_command(&self) -> String {
        self.query_command(&["list-sessions", "-F", LIST_FORMAT])
    }

    pub fn resolve_command(&self, session: SessionId) -> String {
        let target = format!("${}", session.0);
        self.query_command(&["list-windows", "-t", &target, "-F", RESOLVE_FORMAT])
    }

    /// Builds the measured atomic server/session guard and numeric kill.
    /// The caller must still enforce current host/socket ownership and verify
    /// the outcome. In particular, the rejection marker also exits with zero.
    pub(in crate::tmux) fn guarded_kill_command(
        &self,
        server: ServerIdentity,
        session: SessionId,
    ) -> Result<String, InvalidGuardBinding> {
        validate_guard_server(server)?;
        let target = format!("${}", session.0);
        let test = format!(
            "#{{==:#{{pid}}/#{{start_time}}/#{{session_id}},{}/{}/{target}}}",
            server.pid, server.start_time
        );
        Ok(self.guard_command(&[], &target, &test, "kill-session"))
    }

    /// Adds the selected window/pane/process and active/live flags to the
    /// measured guard. No detach, selection repair or name fallback occurs.
    /// An exec ACK is not attachment evidence; W/J confirmation and the final
    /// PTY publication gate are separate obligations of the future caller.
    #[cfg(test)]
    pub(in crate::tmux) fn guarded_attach_command(
        &self,
        binding: PaneIdentity,
    ) -> Result<String, InvalidGuardBinding> {
        self.attach_guard(&[], binding, "attach-session")
    }

    /// Wie [`Self::guarded_attach_command`], nur schaltet derselbe tmux-Aufruf
    /// vorher die Statuszeile aus ([`super::HIDE_STATUS`]). Der Waechter
    /// dahinter bleibt Byte fuer Byte der gemessene; die Option beruehrt keine
    /// der Identitaeten, die er prueft. Lehnt er ab, ist die Zeile trotzdem
    /// aus, sonst geschieht nichts.
    pub(in crate::tmux) fn guarded_attach_command_without_status(
        &self,
        binding: PaneIdentity,
    ) -> Result<String, InvalidGuardBinding> {
        self.attach_guard(&super::HIDE_STATUS, binding, "attach-session")
    }

    /// Der Waechter fuer eine Session auf dem Standard-Socket des Nutzers
    /// (Spec 2026-10-25 §3, §6.4): derselbe gemessene Test, aber
    /// `attach-session -E`, damit das Anhaengen `update-environment` nicht
    /// anwendet, und ohne `set -g status off` davor. Gemessen am 25.10. auf
    /// 3.3a und 3.6 (`messung-2026-10-25-standard-socket.md`): haengt bei
    /// passender Bindung an, lehnt sonst ab, startet ohne Server nichts und
    /// laesst die Umgebung der Session unveraendert.
    pub(in crate::tmux) fn guarded_attach_command_foreign(
        &self,
        binding: PaneIdentity,
    ) -> Result<String, InvalidGuardBinding> {
        self.attach_guard(&[], binding, "attach-session -E")
    }

    fn attach_guard(
        &self,
        prefix: &[&str],
        binding: PaneIdentity,
        action: &str,
    ) -> Result<String, InvalidGuardBinding> {
        validate_guard_server(binding.server)?;
        if binding.pane_pid == 0 {
            return Err(InvalidGuardBinding::PanePid);
        }
        let target = format!("${}", binding.session_id.0);
        let test = format!(
            "#{{==:#{{pid}}/#{{start_time}}/#{{session_id}}/#{{window_id}}/#{{pane_id}}/#{{pane_pid}}/#{{window_active}}/#{{pane_active}}/#{{pane_dead}},{}/{}/{target}/@{}/%{}/{}/1/1/0}}",
            binding.server.pid, binding.server.start_time,
            binding.window_id.0, binding.pane_id.0, binding.pane_pid
        );
        Ok(self.guard_command(prefix, &target, &test, action))
    }

    fn guard_command(&self, prefix: &[&str], target: &str, test: &str, action: &str) -> String {
        // Only fixed action literals and formatted integers reach this nested
        // tmux command. The validated socket remains a separate outer argv.
        // No command may be inserted between the guard and its action; a fixed
        // prefix runs before the guard.
        let action = format!("{action} -t '{target}'");
        let mut args: Vec<&str> = prefix.to_vec();
        args.extend_from_slice(&["if-shell", "-F", "-t", target, test, &action, GUARD_REJECT]);
        self.query_command(&args)
    }

    /// Keeps the existing product creation policy and the user's locale. This
    /// builder does not execute a mutation, retry or interpret a failed result.
    /// Untrusted listed display names must never be supplied as creation names.
    pub(in crate::tmux) fn create_command(
        &self,
        name: &str,
        cwd: &str,
    ) -> Result<String, InvalidCreateArguments> {
        if !super::session_name_is_acceptable(name) {
            return Err(InvalidCreateArguments::Name);
        }
        if !cwd.starts_with('/') || cwd.chars().any(char::is_control) {
            return Err(InvalidCreateArguments::Directory);
        }
        let cwd = escape_cwd_format(cwd);
        let [flag, socket] = self.inventory.socket_args();
        Ok(remote::build(&[
            "tmux",
            flag,
            socket,
            "new-session",
            "-d",
            "-P",
            "-F",
            CREATE_FORMAT,
            "-s",
            name,
            "-c",
            &cwd,
            ";",
            "set",
            "-g",
            "exit-empty",
            "on",
        ]))
    }
}

/// Schreibt den Startordner so, dass tmux ihn als Format zum woertlichen
/// Ordner auswertet. tmux wertet das rohe Argument von `new-session -c`
/// zweimal unabhaengig voneinander als Format aus: fuer den Ordner der
/// Session (`cmd-new-session.c`) und fuer den der ersten Pane (`spawn.c`,
/// wieder aus dem rohen Argument). Deshalb ist genau eine Verdopplung
/// richtig, nie zwei. Unverdoppelt fuehrt ein Ordner `#(befehl)` den Befehl
/// auf dem Host aus, und `C#Project` startet still in einem anderen Ordner.
///
/// `##` ergibt ein `#` (gemessen auf 3.0a, 3.3a, 3.4 und 3.6). Ausnahme ab
/// 3.3a: Eine Folge aus mindestens zwei `#` direkt vor `[` ist eine
/// Stilmarke und bleibt woertlich stehen; ein einzelnes `#` vor `[` bleibt in
/// allen Versionen ein `#`. Eine `#`-Folge direkt vor `[` bleibt deshalb
/// unveraendert. Nur 3.0a halbiert eine solche Folge aus mindestens zwei
/// `#`; die Pane startet dann im Home-Ordner, wie ohne Verdopplung auch.
///
/// Ausgefuehrt wird so in keiner Version etwas: Jede andere `#`-Folge hat
/// danach gerade Laenge und ergibt nur `#`, und eine Folge vor `[` bildet
/// nie `#(`, `#{` oder eine Ein-Buchstaben-Variable. `#` abzulehnen
/// verweigerte dagegen legitime Ordner wie `C#Project`.
fn escape_cwd_format(cwd: &str) -> String {
    let mut escaped = String::with_capacity(cwd.len() * 2);
    let mut rest = cwd;
    while let Some(start) = rest.find('#') {
        escaped.push_str(&rest[..start]);
        let run = &rest[start..];
        let after = run.trim_start_matches('#');
        let hashes = &run[..run.len() - after.len()];
        escaped.push_str(hashes);
        if !after.starts_with('[') {
            escaped.push_str(hashes);
        }
        rest = after;
    }
    escaped.push_str(rest);
    escaped
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidGuardBinding {
    #[error("guard requires a nonzero server PID and start time")]
    Server,
    #[error("attach guard requires a nonzero pane PID")]
    PanePid,
}

fn validate_guard_server(server: ServerIdentity) -> Result<(), InvalidGuardBinding> {
    if server.pid == 0 || server.start_time == 0 {
        return Err(InvalidGuardBinding::Server);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidCreateArguments {
    #[error("invalid creation name")]
    Name,
    #[error("creation directory must be absolute and contain no control characters")]
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("tmux binding query failed (exit {code})")]
    TmuxError { code: u32 },
    #[error("tmux binding output was not valid UTF-8")]
    InvalidUtf8,
    #[error("incomplete tmux binding response: {0:?}")]
    Incomplete(IncompleteReason),
}

impl From<IncompleteReason> for ParseError {
    fn from(reason: IncompleteReason) -> Self {
        Self::Incomplete(reason)
    }
}

/// Display text is retained verbatim and is never a reusable tmux target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedSnapshot {
    server: Option<ServerIdentity>,
    sessions: BTreeMap<SessionId, String>,
}

impl ListedSnapshot {
    pub fn server(&self) -> Option<ServerIdentity> {
        self.server
    }

    pub fn sessions(&self) -> &BTreeMap<SessionId, String> {
        &self.sessions
    }
}

/// Numeric object evidence only. A runtime host, socket and control generation
/// must still be supplied by the caller before this can become a product binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneIdentity {
    pub server: ServerIdentity,
    pub session_id: SessionId,
    pub window_id: WindowId,
    pub pane_id: PaneId,
    pub pane_pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedWindow {
    pane_id: PaneId,
    pane_pid: u32,
    active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSnapshot {
    server: ServerIdentity,
    session_id: SessionId,
    windows: BTreeMap<WindowId, ResolvedWindow>,
}

impl ResolvedSnapshot {
    pub fn selected(&self) -> PaneIdentity {
        // Construction is private; the parser requires exactly one active row.
        let (window_id, window) = self.windows.iter().find(|(_, w)| w.active).unwrap();
        PaneIdentity {
            server: self.server,
            session_id: self.session_id,
            window_id: *window_id,
            pane_id: window.pane_id,
            pane_pid: window.pane_pid,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreatedRecord(PaneIdentity);

impl CreatedRecord {
    pub fn identity(&self) -> PaneIdentity {
        self.0
    }
}

fn payload(result: &ExecResult, unicode: bool) -> Result<&str, ParseError> {
    if result.stdout.len().saturating_add(result.stderr.len()) > MAX_INVENTORY_BYTES {
        return Err(IncompleteReason::OutputLimit.into());
    }
    if result.code != 0 || !result.stderr.is_empty() {
        return Err(ParseError::TmuxError { code: result.code });
    }
    if !result.utf8_valid {
        return Err(ParseError::InvalidUtf8);
    }
    let text = result.stdout.as_str();
    if (!text.is_empty() && !text.ends_with('\n'))
        || text
            .bytes()
            .any(|b| b != b'\n' && (b < b' ' || b == 127 || (!unicode && !b.is_ascii())))
    {
        return Err(IncompleteReason::InvalidFrame.into());
    }
    Ok(text)
}

fn server(pid: &str, start: &str) -> Result<ServerIdentity, ParseError> {
    let pid = number32(pid, true)?;
    let start_time = number(start)?;
    if start_time == 0 {
        return Err(IncompleteReason::InvalidNumber.into());
    }
    Ok(ServerIdentity { pid, start_time })
}

pub fn parse_list(result: &ExecResult) -> Result<ListedSnapshot, ParseError> {
    let text = payload(result, true)?;
    let mut snapshot = ListedSnapshot {
        server: None,
        sessions: BTreeMap::new(),
    };
    for line in text.split_terminator('\n') {
        let fields: Vec<_> = line.splitn(5, '|').collect();
        let ["L", pid, start, sid, name] = fields.as_slice() else {
            return Err(IncompleteReason::InvalidFrame.into());
        };
        let current = server(pid, start)?;
        if snapshot.server.is_some_and(|previous| previous != current) {
            return Err(IncompleteReason::InconsistentInventory.into());
        }
        snapshot.server = Some(current);
        if name.is_empty() || name.len() > 4096 {
            return Err(IncompleteReason::InvalidFrame.into());
        }
        let sid = SessionId(id(sid, '$')?);
        if snapshot.sessions.insert(sid, (*name).into()).is_some() {
            return Err(IncompleteReason::DuplicateIdentity.into());
        }
    }
    Ok(snapshot)
}

fn pane(fields: &[&str]) -> Result<PaneIdentity, ParseError> {
    Ok(PaneIdentity {
        server: server(fields[1], fields[2])?,
        session_id: SessionId(id(fields[3], '$')?),
        window_id: WindowId(id(fields[4], '@')?),
        pane_id: PaneId(id(fields[5], '%')?),
        pane_pid: number32(fields[6], true)?,
    })
}

pub fn parse_created(result: &ExecResult) -> Result<CreatedRecord, ParseError> {
    let text = payload(result, false)?;
    let mut lines = text.split_terminator('\n');
    let fields: Vec<_> = lines.next().unwrap_or_default().split('|').collect();
    if fields.len() != 7 || fields[0] != "C" || lines.next().is_some() {
        return Err(IncompleteReason::InvalidFrame.into());
    }
    Ok(CreatedRecord(pane(&fields)?))
}

pub fn parse_resolved(result: &ExecResult) -> Result<ResolvedSnapshot, ParseError> {
    let text = payload(result, false)?;
    let mut result: Option<ResolvedSnapshot> = None;
    let mut window_count = 0;
    let mut pane_ids = BTreeSet::new();
    for line in text.split_terminator('\n') {
        let fields: Vec<_> = line.split('|').collect();
        if fields.len() != 9 || fields[0] != "R" {
            return Err(IncompleteReason::InvalidFrame.into());
        }
        let identity = pane(&fields)?;
        let active = flag(fields[7])?;
        let count = number32(fields[8], true)?;
        let snapshot = result.get_or_insert_with(|| {
            window_count = count;
            ResolvedSnapshot {
                server: identity.server,
                session_id: identity.session_id,
                windows: BTreeMap::new(),
            }
        });
        if snapshot.server != identity.server
            || snapshot.session_id != identity.session_id
            || window_count != count
        {
            return Err(IncompleteReason::InconsistentInventory.into());
        }
        if !pane_ids.insert(identity.pane_id)
            || snapshot
                .windows
                .insert(
                    identity.window_id,
                    ResolvedWindow {
                        pane_id: identity.pane_id,
                        pane_pid: identity.pane_pid,
                        active,
                    },
                )
                .is_some()
        {
            return Err(IncompleteReason::DuplicateIdentity.into());
        }
    }
    let snapshot = result.ok_or(IncompleteReason::InvalidFrame)?;
    if snapshot.windows.len() as u64 != u64::from(window_count)
        || snapshot
            .windows
            .values()
            .filter(|window| window.active)
            .count()
            != 1
    {
        return Err(IncompleteReason::InconsistentInventory.into());
    }
    Ok(snapshot)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum UnverifiedReason {
    #[error("the observed session listing changed")]
    ListingChanged,
    #[error("the complete listing and inventory identities do not agree")]
    ListingInventoryMismatch,
    #[error("the requested session resolution changed or addressed another ID")]
    ResolutionChanged,
    #[error("the resolved windows and active panes do not match the inventory")]
    PaneInventoryMismatch,
    #[error("the originally created object is not confirmed")]
    CreationMismatch,
    #[error("the session shares windows with another session")]
    LinkedWindows,
}

/// Validates the shared list envelope, including an empty live-server snapshot.
/// An R failure may leave a row unbound, but cannot bypass this whole-list check.
pub fn confirm_listed_inventory(
    before: &ListedSnapshot,
    inventory: &InventorySnapshot,
    after: &ListedSnapshot,
) -> Result<(), UnverifiedReason> {
    if before != after {
        return Err(UnverifiedReason::ListingChanged);
    }
    // Sessions einer Sitzungsgruppe stehen nur in `linked`, nie zugleich im
    // Inventar; zusammen ergeben beide genau die Liste.
    let inventory_ids: BTreeSet<_> = inventory.sessions.iter().map(|s| s.id).collect();
    let linked: BTreeSet<_> = inventory.linked.iter().copied().collect();
    if inventory_ids.len() != inventory.sessions.len()
        || linked.len() != inventory.linked.len()
        || !inventory_ids.is_disjoint(&linked)
        || before.sessions.keys().copied().collect::<BTreeSet<_>>()
            != inventory_ids.union(&linked).copied().collect()
        || before
            .server
            .is_some_and(|server| server != inventory.server)
    {
        return Err(UnverifiedReason::ListingInventoryMismatch);
    }
    Ok(())
}

/// Confirms only the creation's list transition. A full L/R/inventory binding
/// is still required before choosing the newly created object for an action.
pub fn confirm_created_listing(
    before: &ListedSnapshot,
    created: &CreatedRecord,
    after: &ListedSnapshot,
) -> Result<(), UnverifiedReason> {
    let created = created.identity();
    if before.server.is_some_and(|server| server != created.server)
        || after.server != Some(created.server)
        || before.sessions.contains_key(&created.session_id)
        || !after.sessions.contains_key(&created.session_id)
        || after.sessions.len() != before.sessions.len() + 1
        || before
            .sessions
            .iter()
            .any(|(id, name)| after.sessions.get(id) != Some(name))
    {
        return Err(UnverifiedReason::CreationMismatch);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundObservation {
    pub display_name: String,
    pub selected: PaneIdentity,
    pub creation_matched: bool,
}

/// Correlates observations only; no runtime/transport freshness is inferred.
/// An InventorySnapshot here must have come from the complete inventory parser.
pub fn correlate(
    list_before: &ListedSnapshot,
    before: &ResolvedSnapshot,
    inventory: &InventorySnapshot,
    after: &ResolvedSnapshot,
    list_after: &ListedSnapshot,
    session_id: SessionId,
    created: Option<&CreatedRecord>,
) -> Result<BoundObservation, UnverifiedReason> {
    confirm_listed_inventory(list_before, inventory, list_after)?;
    if inventory.linked.contains(&session_id) {
        return Err(UnverifiedReason::LinkedWindows);
    }
    if before != after || before.session_id != session_id {
        return Err(UnverifiedReason::ResolutionChanged);
    }
    let display_name = list_before
        .sessions
        .get(&session_id)
        .ok_or(UnverifiedReason::ListingInventoryMismatch)?;
    if before.server != inventory.server
        || !inventory
            .sessions
            .iter()
            .any(|s| s.id == session_id && u64::from(s.window_count) == before.windows.len() as u64)
    {
        return Err(UnverifiedReason::PaneInventoryMismatch);
    }
    for (window_id, window) in &before.windows {
        let mut active = inventory
            .panes
            .iter()
            .filter(|p| p.session_id == session_id && p.window_id == *window_id && p.pane_active);
        let pane = active
            .next()
            .ok_or(UnverifiedReason::PaneInventoryMismatch)?;
        if active.next().is_some()
            || pane.pane_id != window.pane_id
            || pane.pane_pid != window.pane_pid
            || pane.window_active != window.active
        {
            return Err(UnverifiedReason::PaneInventoryMismatch);
        }
    }
    if let Some(created) = created {
        let c = created.identity();
        if c.server != before.server
            || c.session_id != session_id
            || !inventory.panes.iter().any(|p| {
                p.session_id == session_id
                    && p.window_id == c.window_id
                    && p.pane_id == c.pane_id
                    && p.pane_pid == c.pane_pid
            })
        {
            return Err(UnverifiedReason::CreationMismatch);
        }
    }
    Ok(BoundObservation {
        display_name: display_name.clone(),
        selected: before.selected(),
        creation_matched: created.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::inventory::{InventoryOutcome, MeasuredVersion};
    use super::*;
    use crate::remote::command::decoded_argv;
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    const L: &str = "L|100|1000|$0|dev\n";
    const R: &str = "R|100|1000|$0|@0|%0|10|1|1\n";
    const C: &str = "C|100|1000|$0|@0|%0|10\n";
    const I: &str = "B|100|1000\nQ|$0|1\nP|$0|@0|%0|10|1|1|0|0|0|1|0|1\nE|100|1000\n";

    fn output(stdout: &str) -> ExecResult {
        ExecResult {
            stdout: stdout.into(),
            stderr: String::new(),
            code: 0,
            utf8_valid: true,
        }
    }

    fn query() -> InventoryQuery {
        InventoryQuery::absolute(MeasuredVersion::V3_4, "/tmp/own/socket").unwrap()
    }

    fn inventory(text: &str) -> InventorySnapshot {
        let InventoryOutcome::Snapshot(snapshot) = query().classify(&output(text)) else {
            panic!("invalid inventory fixture: {text:?}")
        };
        snapshot
    }

    #[test]
    fn builders_share_validated_socket_and_numeric_targets_without_name_interpretation() {
        for inv in [
            InventoryQuery::named(MeasuredVersion::V3_0, "own'|$socket").unwrap(),
            query(),
        ] {
            let q = BindingQuery::new(inv.clone());
            assert_eq!(q.inventory(), &inv);
            let [flag, socket] = inv.socket_args();
            assert_eq!(
                decoded_argv(&q.list_command()),
                [
                    "env",
                    "LC_ALL=C",
                    "tmux",
                    "-u",
                    flag,
                    socket,
                    "list-sessions",
                    "-F",
                    LIST_FORMAT
                ]
            );
            for sid in [SessionId(0), SessionId(u32::MAX)] {
                let target = format!("${}", sid.0);
                assert_eq!(
                    decoded_argv(&q.resolve_command(sid)),
                    [
                        "env",
                        "LC_ALL=C",
                        "tmux",
                        "-u",
                        flag,
                        socket,
                        "list-windows",
                        "-t",
                        &target,
                        "-F",
                        RESOLVE_FORMAT
                    ]
                );
            }
            let cwd = "/tmp/a';$literal|path";
            assert_eq!(
                decoded_argv(&q.create_command("Build 2", cwd).unwrap()),
                [
                    "tmux",
                    flag,
                    socket,
                    "new-session",
                    "-d",
                    "-P",
                    "-F",
                    CREATE_FORMAT,
                    "-s",
                    "Build 2",
                    "-c",
                    cwd,
                    ";",
                    "set",
                    "-g",
                    "exit-empty",
                    "on"
                ]
            );
            for name in [
                "",
                "bad\0name",
                "#(touch /tmp/wrong)",
                "$legacy",
                "name:window",
            ] {
                assert_eq!(
                    q.create_command(name, "/tmp"),
                    Err(InvalidCreateArguments::Name)
                );
            }
            for cwd in ["relative", "", "/tmp/bad\npath", "/tmp/bad\0path"] {
                assert_eq!(
                    q.create_command("dev", cwd),
                    Err(InvalidCreateArguments::Directory)
                );
            }
        }
    }

    /// Links der Ordner, rechts das `-c`-Argument, das tmux zu genau diesem
    /// Ordner auswertet, gemessen auf tmux 3.3a, 3.4 und 3.6; auf 3.0a gilt
    /// das bis auf die Faelle mit `##[`
    /// (docs/messungen/messung-2026-10-26-tmux-cwd-format.md). Ein Ordner
    /// ohne `#` geht unveraendert durch.
    #[test]
    fn create_command_keeps_hash_in_the_start_directory_literal() {
        let q = BindingQuery::new(query());
        let [flag, socket] = q.inventory().socket_args();
        for (cwd, argv_cwd) in [
            ("/srv/#(touch /tmp/wrong)", "/srv/##(touch /tmp/wrong)"),
            ("/srv/A#{session_name}B", "/srv/A##{session_name}B"),
            ("/srv/C#Project", "/srv/C##Project"),
            ("/srv/#P", "/srv/##P"),
            ("/srv/##", "/srv/####"),
            ("/srv/trail#", "/srv/trail##"),
            ("/srv/D####Q", "/srv/D########Q"),
            ("/#/x#", "/##/x##"),
            ("/srv/E#[x]", "/srv/E#[x]"),
            ("/srv/F##[x]", "/srv/F##[x]"),
            ("/srv/G#(id)#[y]", "/srv/G##(id)#[y]"),
            ("/srv/H#a##[b#", "/srv/H##a##[b##"),
            ("/srv/plain", "/srv/plain"),
        ] {
            assert_eq!(
                decoded_argv(&q.create_command("dev", cwd).unwrap()),
                [
                    "tmux",
                    flag,
                    socket,
                    "new-session",
                    "-d",
                    "-P",
                    "-F",
                    CREATE_FORMAT,
                    "-s",
                    "dev",
                    "-c",
                    argv_cwd,
                    ";",
                    "set",
                    "-g",
                    "exit-empty",
                    "on"
                ],
                "{cwd:?}"
            );
        }
    }

    #[test]
    fn list_keeps_display_bytes_and_does_not_apply_creation_name_policy() {
        for name in [
            " dev ",
            "   ",
            "Prüfung_日本",
            "cash$back\\slash|semi;quote'#[x]",
            "$legacy",
            r"back\$pair",
            "\u{fffd}",
            "left\u{2028}right",
            "a\u{85}b",
        ] {
            let parsed = parse_list(&output(&format!("L|100|1000|$0|{name}\n"))).unwrap();
            assert_eq!(parsed.sessions().get(&SessionId(0)).unwrap(), name);
        }
        assert!(parse_list(&output(&format!("L|100|1000|$0|{}\n", "é".repeat(2048)))).is_ok());
        assert!(parse_list(&output(&format!("L|100|1000|$0|{}\n", "é".repeat(2049)))).is_err());
        for text in [
            "L|100|1000|$0|\n",
            "L|100|1000|$0|dev",
            "L|100|1000|$0|dev\r\n",
            "L|100|1000|$0|dev\n\n",
            "L|100|1000|$0|a\tb\n",
            "L|100|1000|$0|a\0b\n",
            "L|100|1000|$0|a\u{7f}b\n",
            "L|100|1000|$0|dev\nL|100|1000|$0|other\n",
            "L|100|1000|$0|dev\nL|101|1000|$1|other\n",
        ] {
            assert!(parse_list(&output(text)).is_err(), "{text:?}");
        }
    }

    #[test]
    fn actual_utf8_proof_and_completed_error_results_are_required() {
        let mut invalid = output(L);
        invalid.utf8_valid = false;
        assert_eq!(parse_list(&invalid), Err(ParseError::InvalidUtf8));
        invalid.stdout = R.into();
        assert_eq!(parse_resolved(&invalid), Err(ParseError::InvalidUtf8));
        invalid.stdout = C.into();
        assert_eq!(parse_created(&invalid), Err(ParseError::InvalidUtf8));
        for (code, stderr) in [
            (0, "unexpected warning\n"),
            (1, "no sessions\n"),
            (1, "no server running on /tmp/own/socket\n"),
            (127, "tmux: not found\n"),
            (1, ""),
        ] {
            let r = ExecResult {
                stdout: String::new(),
                stderr: stderr.into(),
                code,
                utf8_valid: true,
            };
            assert_eq!(parse_list(&r), Err(ParseError::TmuxError { code }));
            assert_eq!(parse_resolved(&r), Err(ParseError::TmuxError { code }));
            assert_eq!(parse_created(&r), Err(ParseError::TmuxError { code }));
        }
        let huge = output(&"x".repeat(MAX_INVENTORY_BYTES + 1));
        assert_eq!(
            parse_list(&huge),
            Err(ParseError::Incomplete(IncompleteReason::OutputLimit))
        );
        assert_eq!(
            parse_resolved(&huge),
            Err(ParseError::Incomplete(IncompleteReason::OutputLimit))
        );
        assert_eq!(
            parse_created(&huge),
            Err(ParseError::Incomplete(IncompleteReason::OutputLimit))
        );
    }

    #[test]
    fn shared_numeric_grammar_rejects_noncanonical_and_overflowing_identity_fields() {
        for (field, values) in [
            (1, vec!["0", "01", "+1", "4294967296"]),
            (2, vec!["0", "01", "-1", "18446744073709551616"]),
            (3, vec!["0", "$01", "$-1", "$4294967296", "$legacy"]),
            (4, vec!["$0", "@01", "@4294967296"]),
            (5, vec!["@0", "%01", "%4294967296"]),
            (6, vec!["0", "01", "4294967296"]),
        ] {
            for value in values {
                let mut c: Vec<_> = C.trim_end_matches('\n').split('|').collect();
                c[field] = value;
                assert!(parse_created(&output(&(c.join("|") + "\n"))).is_err());
                let mut r: Vec<_> = R.trim_end_matches('\n').split('|').collect();
                r[field] = value;
                assert!(parse_resolved(&output(&(r.join("|") + "\n"))).is_err());
                if field <= 3 {
                    let mut l: Vec<_> = L.trim_end_matches('\n').split('|').collect();
                    l[field] = value;
                    assert!(parse_list(&output(&(l.join("|") + "\n"))).is_err());
                }
            }
        }
        let maximum =
            "C|4294967295|18446744073709551615|$4294967295|@4294967295|%4294967295|4294967295\n";
        let parsed = parse_created(&output(maximum)).unwrap().identity();
        assert_eq!(parsed.server.start_time, u64::MAX);
        assert_eq!(parsed.session_id, SessionId(u32::MAX));
        assert_eq!(parsed.pane_pid, u32::MAX);
    }

    #[test]
    fn resolve_and_creation_require_complete_unambiguous_records() {
        for c in [
            "".into(),
            C.trim_end_matches('\n').into(),
            format!("{C}{C}"),
            C.replace("C|", "R|"),
            C.replace("10", "é"),
            C.replace("\n", "|extra\n"),
        ] {
            assert!(parse_created(&output(&c)).is_err(), "{c:?}");
        }
        for r in [
            "".into(),
            R.replace("|1|1\n", "|0|1\n"),
            R.replace("|1|1\n", "|2|1\n"),
            R.replace("|1|1\n", "|1|2\n"),
            format!("{R}{R}"),
            "R|100|1000|$0|@0|%0|10|1|2\nR|100|1000|$0|@1|%0|11|0|2\n".into(),
            "R|100|1000|$0|@0|%0|10|1|2\nR|100|1000|$0|@0|%1|11|0|2\n".into(),
            "R|100|1000|$0|@0|%0|10|1|2\nR|100|1001|$0|@1|%1|11|0|2\n".into(),
            "R|100|1000|$0|@0|%0|10|1|2\nR|100|1000|$1|@1|%1|11|0|2\n".into(),
            "R|100|1000|$0|@0|%0|10|1|2\nR|100|1000|$0|@1|%1|11|1|2\n".into(),
        ] {
            assert!(parse_resolved(&output(&r)).is_err(), "{r:?}");
        }
    }

    #[test]
    fn empty_live_inventory_and_creation_transition_do_not_invent_a_server_or_old_identity() {
        let empty = parse_list(&output("")).unwrap();
        assert_eq!(empty.server(), None);
        assert!(
            confirm_listed_inventory(&empty, &inventory("B|100|1000\nE|100|1000\n"), &empty)
                .is_ok()
        );
        let listed = parse_list(&output(L)).unwrap();
        let created = parse_created(&output(C)).unwrap();
        assert!(confirm_created_listing(&empty, &created, &listed).is_ok());
        assert_eq!(
            confirm_created_listing(&listed, &created, &listed),
            Err(UnverifiedReason::CreationMismatch)
        );
        let mut after = listed.clone();
        after.sessions.insert(SessionId(1), "extra".into());
        assert_eq!(
            confirm_created_listing(&empty, &created, &after),
            Err(UnverifiedReason::CreationMismatch)
        );
        let old = parse_list(&output("L|100|1000|$1|old\n")).unwrap();
        after.sessions.insert(SessionId(1), "renamed".into());
        assert_eq!(
            confirm_created_listing(&old, &created, &after),
            Err(UnverifiedReason::CreationMismatch)
        );
        after.sessions.insert(SessionId(1), "old".into());
        assert!(confirm_created_listing(&old, &created, &after).is_ok());
    }

    #[test]
    fn correlation_rejects_observed_rename_replacement_server_and_pane_changes() {
        let l = parse_list(&output(L)).unwrap();
        let r = parse_resolved(&output(R)).unwrap();
        let inv = inventory(I);
        let c = parse_created(&output(C)).unwrap();
        assert_eq!(
            correlate(&l, &r, &inv, &r, &l, SessionId(0), Some(&c))
                .unwrap()
                .selected,
            c.identity()
        );
        let renamed = parse_list(&output(&L.replace("dev", "renamed"))).unwrap();
        assert_eq!(
            correlate(&l, &r, &inv, &r, &renamed, SessionId(0), None),
            Err(UnverifiedReason::ListingChanged)
        );
        let replacement = parse_list(&output(&L.replace("$0", "$1"))).unwrap();
        assert!(correlate(&l, &r, &inv, &r, &replacement, SessionId(0), None).is_err());
        assert!(correlate(&l, &r, &inv, &r, &l, SessionId(1), None).is_err());
        for newer in [
            R.replace("|100|", "|101|"),
            R.replace("|1000|", "|1001|"),
            R.replace("|10|", "|11|"),
        ] {
            let newer = parse_resolved(&output(&newer)).unwrap();
            assert!(correlate(&l, &r, &inv, &newer, &l, SessionId(0), None).is_err());
        }
        let mut wrong_inventory = inv.clone();
        wrong_inventory.panes[0].pane_pid += 1;
        assert_eq!(
            correlate(&l, &r, &wrong_inventory, &r, &l, SessionId(0), None),
            Err(UnverifiedReason::PaneInventoryMismatch)
        );
        for newer in [
            C.replace("$0", "$1"),
            C.replace("|1000|", "|1001|"),
            C.replace("|10\n", "|11\n"),
        ] {
            let newer = parse_created(&output(&newer)).unwrap();
            assert_eq!(
                correlate(&l, &r, &inv, &r, &l, SessionId(0), Some(&newer)),
                Err(UnverifiedReason::CreationMismatch)
            );
        }
    }

    /// Spec 2026-10-25 §6.2: Eine Session der Gruppe bindet nicht und nennt den
    /// Grund; eine Session ausserhalb bindet wie sonst. Die Liste muss die
    /// Gruppe trotzdem vollstaendig enthalten.
    #[test]
    fn linked_sessions_stay_unbound_while_the_rest_of_the_list_binds() {
        let l = parse_list(&output(
            "L|100|1000|$0|dev
L|100|1000|$1|peer
L|100|1000|$2|solo
",
        ))
        .unwrap();
        let tolerant = query().tolerating_linked_windows();
        let InventoryOutcome::Snapshot(inv) = tolerant.classify(&output(
            "B|100|1000
Q|$0|1
Q|$1|1
Q|$2|1
P|$0|@0|%0|10|1|1|0|0|0|1|0|1
P|$1|@0|%0|10|1|1|0|0|0|1|0|1
P|$2|@1|%1|11|1|1|0|0|1|2|0|1
E|100|1000
",
        )) else {
            panic!()
        };
        let linked = parse_resolved(&output(R)).unwrap();
        assert_eq!(
            correlate(&l, &linked, &inv, &linked, &l, SessionId(0), None),
            Err(UnverifiedReason::LinkedWindows)
        );
        let solo = parse_resolved(&output(
            "R|100|1000|$2|@1|%1|11|1|1
",
        ))
        .unwrap();
        assert_eq!(
            correlate(&l, &solo, &inv, &solo, &l, SessionId(2), None)
                .unwrap()
                .selected
                .pane_pid,
            11
        );
        let without_peer = parse_list(&output(
            "L|100|1000|$0|dev
L|100|1000|$2|solo
",
        ))
        .unwrap();
        assert_eq!(
            confirm_listed_inventory(&without_peer, &inv, &without_peer),
            Err(UnverifiedReason::ListingInventoryMismatch)
        );
    }

    #[test]
    fn full_list_id_sets_prevent_framed_extra_names_or_missing_sessions_from_binding() {
        let l = parse_list(&output(L)).unwrap();
        let extra = parse_list(&output(&format!("{L}L|100|1000|$1|forged\n"))).unwrap();
        let r = parse_resolved(&output(R)).unwrap();
        let inv = inventory(I);
        assert_eq!(
            correlate(&extra, &r, &inv, &r, &extra, SessionId(0), None),
            Err(UnverifiedReason::ListingInventoryMismatch)
        );
        let mut missing = inv.clone();
        missing.sessions.clear();
        assert!(confirm_listed_inventory(&l, &missing, &l).is_err());
        let mut changed = inv.clone();
        changed.server.start_time += 1;
        assert!(confirm_listed_inventory(&l, &changed, &l).is_err());
        changed = inv.clone();
        changed.sessions.push(changed.sessions[0].clone());
        assert!(confirm_listed_inventory(&l, &changed, &l).is_err());
    }

    fn source_result(row: &Value) -> ExecResult {
        assert_eq!(row["termination"], "exit");
        assert_eq!(row["complete_eof"], true);
        ExecResult {
            stdout: row["stdout"].as_str().unwrap().into(),
            stderr: row["stderr"].as_str().unwrap().into(),
            code: u32::try_from(row["exit_code"].as_u64().unwrap()).unwrap(),
            // These hash-bound originals preserve their valid UTF-8. The L
            // recorder also explicitly reports the original-byte UTF-8 check.
            utf8_valid: row
                .get("stdout_utf8_valid")
                .is_none_or(|v| v.as_bool().unwrap()),
        }
    }

    fn expected_pane(expected: &Value) -> PaneIdentity {
        PaneIdentity {
            server: ServerIdentity {
                pid: expected["server"][0].as_u64().unwrap() as u32,
                start_time: expected["server"][1].as_u64().unwrap(),
            },
            session_id: SessionId(id(expected["session_id"].as_str().unwrap(), '$').unwrap()),
            window_id: WindowId(id(expected["window_id"].as_str().unwrap(), '@').unwrap()),
            pane_id: PaneId(id(expected["pane_id"].as_str().unwrap(), '%').unwrap()),
            pane_pid: expected["pane_pid"].as_u64().unwrap() as u32,
        }
    }

    #[test]
    fn action_guards_match_the_executed_30_and_34_commands() {
        // Bytegleiche Kopien der Guard-Laeufe vom 2026-09-12 (tmux 3.0 und 3.4); die
        // Hashes unten binden sie. Die Rohdaten der Messung liegen nicht im Repository.
        for (source, hash, version) in [
            (
                include_str!("../../tests/fixtures/tmux-guard/guard-tmux30.jsonl"),
                "d8dd302bac63bc056fbe3e05ec75a9909c3add8dda133f7a603de40a73ab7653",
                MeasuredVersion::V3_0,
            ),
            (
                include_str!("../../tests/fixtures/tmux-guard/guard-tmux34.jsonl"),
                "0609075c946a4351f49fa10a9561596b51ccd5d79572d39fcef6301e9c07e0af",
                MeasuredVersion::V3_4,
            ),
        ] {
            assert_eq!(format!("{:x}", Sha256::digest(source.as_bytes())), hash);
            let report: Value = source
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .find(|value| value["kind"] == "guard_wj_measurement")
                .unwrap();
            let q = BindingQuery::new(
                InventoryQuery::absolute(version, report["socket"].as_str().unwrap()).unwrap(),
            );
            // Identities come from separate numeric observations, not by
            // decoding the command which the builder is expected to match.
            for (command_name, binding_name, attach) in [
                ("renamed_numeric_kill", "target_create", false),
                ("replacement_old_kill", "old_name_new_bearer", false),
                ("old_server_kill", "anchor_create", false),
                (
                    "last_session_numeric_kill",
                    "replacement_server_session",
                    false,
                ),
                ("true_guard_without_pty", "respawn_binding", true),
            ] {
                let observation = report["bindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["name"] == binding_name)
                    .unwrap();
                let identity = expected_pane(&observation["binding"]);
                let line = if attach {
                    q.guarded_attach_command(identity)
                } else {
                    q.guarded_kill_command(identity.server, identity.session_id)
                }
                .unwrap();
                let row = report["commands"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["name"] == command_name)
                    .unwrap();
                let original: Vec<_> = row["argv"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .skip(6)
                    .map(|arg| arg.as_str().unwrap())
                    .collect();
                let actual = decoded_argv(&line);
                assert_eq!(&actual[6..], original.as_slice(), "{command_name}");
                // A false guard is a successful command, never proof of kill.
                if matches!(command_name, "replacement_old_kill" | "old_server_kill") {
                    assert_eq!(row["exit_code"], 0);
                    assert_eq!(row["stdout"], "AB_M1_REJECT\n");
                }
            }
        }
    }

    #[test]
    fn action_guard_keeps_socket_metacharacters_out_of_nested_tmux_syntax() {
        let identity = parse_created(&output(C)).unwrap().identity();
        let sockets = ["own' ; kill-server #{$socket}", "Prüfung 日本|back\\slash"];
        for socket in sockets {
            let q =
                BindingQuery::new(InventoryQuery::named(MeasuredVersion::V3_0, socket).unwrap());
            for line in [
                q.guarded_attach_command(identity).unwrap(),
                q.guarded_kill_command(identity.server, identity.session_id)
                    .unwrap(),
            ] {
                let argv = decoded_argv(&line);
                assert_eq!(&argv[..6], ["env", "LC_ALL=C", "tmux", "-u", "-L", socket]);
                assert_eq!(argv.len(), 13);
                assert_eq!(&argv[6..10], ["if-shell", "-F", "-t", "$0"]);
                assert!(!argv[10..].iter().any(|arg| arg.contains(socket)));
                assert!(matches!(
                    argv[11].as_str(),
                    "attach-session -t '$0'" | "kill-session -t '$0'"
                ));
                assert_eq!(argv[12], GUARD_REJECT);
            }
        }
    }

    #[test]
    fn action_guards_reject_invalid_public_identities_and_keep_numeric_extremes() {
        let q = BindingQuery::new(query());
        let identity = parse_created(&output(C)).unwrap().identity();
        for server in [
            ServerIdentity {
                pid: 0,
                ..identity.server
            },
            ServerIdentity {
                start_time: 0,
                ..identity.server
            },
        ] {
            assert_eq!(
                q.guarded_kill_command(server, identity.session_id),
                Err(InvalidGuardBinding::Server)
            );
            assert_eq!(
                q.guarded_attach_command(PaneIdentity { server, ..identity }),
                Err(InvalidGuardBinding::Server)
            );
        }
        assert_eq!(
            q.guarded_attach_command(PaneIdentity {
                pane_pid: 0,
                ..identity
            }),
            Err(InvalidGuardBinding::PanePid)
        );
        let largest = PaneIdentity {
            server: ServerIdentity {
                pid: u32::MAX,
                start_time: u64::MAX,
            },
            session_id: SessionId(u32::MAX),
            window_id: WindowId(u32::MAX),
            pane_id: PaneId(u32::MAX),
            pane_pid: u32::MAX,
        };
        let argv = decoded_argv(&q.guarded_attach_command(largest).unwrap());
        assert_eq!(argv[9], "$4294967295");
        assert!(argv[10].ends_with(",4294967295/18446744073709551615/$4294967295/@4294967295/%4294967295/4294967295/1/1/0}"));
        assert_eq!(argv[11], "attach-session -t '$4294967295'");
        // Zero numeric object IDs are valid, unlike process IDs/start times.
        assert!(q.guarded_attach_command(identity).is_ok());
    }

    /// Die Statuszeile geht im selben tmux-Aufruf aus; dahinter steht der
    /// gemessene Waechter unveraendert, und ungueltige Identitaeten bleiben
    /// abgelehnt.
    #[test]
    fn attach_without_status_prefixes_the_unchanged_measured_guard() {
        let q = BindingQuery::new(query());
        let identity = parse_created(&output(C)).unwrap().identity();
        let guarded = decoded_argv(&q.guarded_attach_command(identity).unwrap());
        let hidden = decoded_argv(&q.guarded_attach_command_without_status(identity).unwrap());
        assert_eq!(&hidden[..6], &guarded[..6]);
        assert_eq!(&hidden[6..11], crate::tmux::HIDE_STATUS);
        assert_eq!(&hidden[11..], &guarded[6..]);
        assert_eq!(
            q.guarded_attach_command_without_status(PaneIdentity {
                pane_pid: 0,
                ..identity
            }),
            Err(InvalidGuardBinding::PanePid)
        );
    }

    /// Auf dem Standard-Socket haengt derselbe gemessene Waechter an, nur mit
    /// `attach-session -E` und ohne Befehl davor: Vorne steht `if-shell`,
    /// das ohne Server keinen startet; nichts setzt eine Option oder
    /// Umgebung, beendet oder trennt einen anderen Client ab (Spec 2026-10-25
    /// §3, §6.4).
    #[test]
    fn foreign_attach_is_the_measured_guard_with_e_and_nothing_before_it() {
        let q = BindingQuery::new(query());
        let identity = parse_created(&output(C)).unwrap().identity();
        let guarded = decoded_argv(&q.guarded_attach_command(identity).unwrap());
        let foreign = decoded_argv(&q.guarded_attach_command_foreign(identity).unwrap());
        let action = guarded.len() - 2;
        assert_eq!(foreign.len(), guarded.len());
        assert_eq!(foreign[6], "if-shell");
        assert_eq!(&foreign[..action], &guarded[..action]);
        assert_eq!(guarded[action], "attach-session -t '$0'");
        assert_eq!(foreign[action], "attach-session -E -t '$0'");
        assert_eq!(foreign[action + 1], guarded[action + 1]);
        let words: Vec<&str> = foreign.iter().flat_map(|a| a.split_whitespace()).collect();
        for forbidden in [
            "-d",
            "set",
            "set-option",
            "setw",
            "set-window-option",
            "set-environment",
            "set-hook",
            "start-server",
            "new-session",
            "kill-session",
            "kill-server",
            "detach-client",
        ] {
            assert!(!words.contains(&forbidden), "{forbidden}");
        }
        assert_eq!(
            q.guarded_attach_command_foreign(PaneIdentity {
                pane_pid: 0,
                ..identity
            }),
            Err(InvalidGuardBinding::PanePid)
        );
    }

    #[test]
    fn accepted_30_and_34_originals_replay_parsers_bindings_and_observed_races() {
        // Bytegleiche Kopien der L/ID-Bindungslaeufe vom 2026-09-12 (tmux 3.0 und 3.4);
        // die Hashes unten binden sie. Die Rohdaten der Messung liegen nicht im
        // Repository.
        for (source, hash, version, positives) in [
            (
                include_str!("../../tests/fixtures/tmux-session-binding/binding-tmux30.jsonl"),
                "6b6418d2d499625143117123e5bcff5e4c95550b58ccfe84574a510be2710230",
                MeasuredVersion::V3_0,
                19,
            ),
            (
                include_str!("../../tests/fixtures/tmux-session-binding/binding-tmux34.jsonl"),
                "4f095a3d5cf67b9e0369912a842d5c904c6a630c67ca40b6debf93f8da4a25a5",
                MeasuredVersion::V3_4,
                17,
            ),
        ] {
            assert_eq!(format!("{:x}", Sha256::digest(source.as_bytes())), hash);
            let report: Value = source
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).unwrap())
                .find(|v| v["kind"] == "session_binding_measurement")
                .unwrap();
            let originals = report["commands"].as_array().unwrap();
            let commands: BTreeMap<_, _> = originals
                .iter()
                .map(|c| (c["name"].as_str().unwrap(), c))
                .collect();
            let command = |name: &str| source_result(commands[name]);
            let socket = format!("{}/tmux.sock", report["root"].as_str().unwrap());
            let q = BindingQuery::new(InventoryQuery::absolute(version, &socket).unwrap());
            let mut creations = BTreeMap::new();
            let mut counts = [0; 3];
            for row in originals {
                let result = source_result(row);
                if let Some(expected) = row.get("list_classification") {
                    counts[0] += 1;
                    let parsed = parse_list(&result).unwrap();
                    assert_eq!(expected["class"], "Listed");
                    assert_eq!(
                        parsed.sessions.len(),
                        expected["sessions"].as_object().unwrap().len()
                    );
                    for (sid, name) in parsed.sessions() {
                        assert_eq!(
                            name,
                            expected["sessions"][format!("${}", sid.0)]
                                .as_str()
                                .unwrap()
                        );
                    }
                    let actual = decoded_argv(&q.list_command());
                    let original: Vec<_> = row["argv"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .skip(6)
                        .map(|v| v.as_str().unwrap())
                        .collect();
                    assert_eq!(&actual[6..], original.as_slice());
                }
                if let Some(expected) = row.get("binding_classification") {
                    match expected["class"].as_str().unwrap() {
                        "Created" => {
                            counts[2] += 1;
                            let created = parse_created(&result).unwrap();
                            assert_eq!(created.identity(), expected_pane(expected));
                            let label = row["name"]
                                .as_str()
                                .unwrap()
                                .strip_suffix("_create")
                                .unwrap();
                            let before =
                                parse_list(&command(&format!("{label}_names_before"))).unwrap();
                            let after =
                                parse_list(&command(&format!("{label}_names_after"))).unwrap();
                            confirm_created_listing(&before, &created, &after).unwrap();
                            creations.insert(created.identity().session_id, created);
                        }
                        "Resolved" => {
                            counts[1] += 1;
                            let parsed = parse_resolved(&result).unwrap();
                            let selected = expected["windows"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|w| w["window_active"] == 1)
                                .unwrap();
                            assert_eq!(parsed.selected(), expected_pane(selected));
                            let actual = decoded_argv(&q.resolve_command(parsed.session_id));
                            let original: Vec<_> = row["argv"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .skip(6)
                                .map(|v| v.as_str().unwrap())
                                .collect();
                            assert_eq!(&actual[6..], original.as_slice());
                        }
                        "TmuxError" => assert!(matches!(
                            parse_resolved(&result),
                            Err(ParseError::TmuxError { .. })
                        )),
                        other => panic!("unexpected original classification {other}"),
                    }
                }
            }
            assert!(counts.iter().all(|count| *count > 0));
            let mut bound_count = 0;
            for binding in report["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["result"]["class"] == "Bound")
            {
                let name = binding["name"].as_str().unwrap();
                let l0 = parse_list(&command(&format!("{name}_l_before"))).unwrap();
                let r0 = parse_resolved(&command(&format!("{name}_r_before"))).unwrap();
                let InventoryOutcome::Snapshot(inv) = q
                    .inventory()
                    .classify(&command(&format!("{name}_inventory")))
                else {
                    panic!("{name}")
                };
                let r1 = parse_resolved(&command(&format!("{name}_r_after"))).unwrap();
                let l1 = parse_list(&command(&format!("{name}_l_after"))).unwrap();
                let sid = r0.session_id;
                let created = binding["result"]["creation_matched"]
                    .as_bool()
                    .unwrap()
                    .then(|| &creations[&sid]);
                let actual = correlate(&l0, &r0, &inv, &r1, &l1, sid, created).unwrap();
                assert_eq!(actual.selected, expected_pane(&binding["result"]));
                assert_eq!(actual.display_name, binding["result"]["listed_name"]);
                assert_eq!(
                    actual.creation_matched,
                    binding["result"]["creation_matched"]
                );
                bound_count += 1;
            }
            assert_eq!(bound_count, positives);
            for trial in 1..=3 {
                let l0 = parse_list(&command(&format!("rename_{trial}_l_before"))).unwrap();
                let r0 = parse_resolved(&command(&format!("rename_{trial}_r_before"))).unwrap();
                let l1 = parse_list(&command(&format!("rename_{trial}_l_after"))).unwrap();
                let r1 = parse_resolved(&command(&format!("rename_{trial}_same_id"))).unwrap();
                let InventoryOutcome::Snapshot(inv) = q
                    .inventory()
                    .classify(&command(&format!("rename_{trial}_inventory")))
                else {
                    panic!("rename")
                };
                assert_eq!(r0, r1);
                assert_eq!(
                    correlate(&l0, &r0, &inv, &r1, &l1, r0.session_id, None),
                    Err(UnverifiedReason::ListingChanged)
                );
                assert!(
                    parse_resolved(&command(&format!("replacement_{trial}_r_after_old_id")))
                        .is_err()
                );
                // The recorder uses this label twice: before killing the old
                // ID, then again while binding the replacement it just created.
                // The negative case requires the first, actually old observation.
                let old_name = format!("replacement_{trial}_r_before");
                let old_row = originals
                    .iter()
                    .find(|row| row["name"] == old_name)
                    .unwrap();
                let old = parse_resolved(&source_result(old_row)).unwrap();
                let fresh =
                    parse_resolved(&command(&format!("replacement_{trial}_r_after_new_id")))
                        .unwrap();
                let listed = parse_list(&command(&format!("replacement_{trial}_l_after"))).unwrap();
                let InventoryOutcome::Snapshot(inv) = q
                    .inventory()
                    .classify(&command(&format!("replacement_{trial}_inventory")))
                else {
                    panic!("replacement")
                };
                assert_eq!(
                    correlate(
                        &listed,
                        &fresh,
                        &inv,
                        &fresh,
                        &listed,
                        fresh.session_id,
                        Some(&creations[&old.session_id])
                    ),
                    Err(UnverifiedReason::CreationMismatch)
                );
            }
        }
    }
}
