//! A runtime host owns two SSH connections. Commands snapshot one control
//! generation; PTYs keep the terminal connection across explicit control repair.

mod host_key;
#[cfg(test)]
pub(crate) mod tests;

use crate::ssh::AuthMethod;
use crate::transport::operation_control::{
    ExecError, ExecPhase, ExecReason, OperationControl, Submission,
};
use crate::transport::{
    ConnectControl, ConnectLimits, ExecResult, HostKeyPolicy, HostSpec, RusshTransport, Transport,
};
use async_trait::async_trait;
use host_key::{HostKeyPin, PairHostKeyPolicy, RepairHostKeyPolicy};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

/// Spec 2026-10-19 §8.1 (Schritt 3): hoechstens so viele Pumpaufgaben je Host,
/// schliessende eingerechnet. Doppelt so viele wie PTY-Plaetze der
/// Terminalverbindung (8, `owned_operations.rs`): Mit acht lebenden Kacheln
/// bleibt Raum fuer Pumpen, die nach einem Ende noch auslaufen, damit ein
/// schnelles Wiederanhaengen nicht erst nach dem Oeffnen seines Kanals hier
/// scheitert (`start_pump` laeuft bei der Veroeffentlichung). Weiter begrenzt,
/// damit haengende Pumpen auffallen.
const MAX_PUMPS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlHealth {
    Ready,
    Degraded,
    Reconnecting,
    AuthenticationRequired,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ControlStateEvent {
    pub host_id: String,
    pub control_generation: u64,
    pub state: ControlHealth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalTransportLostEvent {
    pub host_id: String,
}

pub(crate) trait ConnectionEvents: Send + Sync + 'static {
    fn control_state(&self, event: ControlStateEvent);
    fn terminal_transport_lost(&self, event: TerminalTransportLostEvent);
}

/// Die zweite Verbindung eines Paars (oder die Steuerverbindung bei der
/// Reparatur) traf auf einen anderen Hostschluessel als die offene. Der Text
/// ist der, den der Nutzer liest (Spec §10); der Fehlercode `host_key_rejected`
/// entsteht in `commands.rs` aus dem Typ.
#[derive(Debug, thiserror::Error)]
#[error(
    "This server answered with a different host key than the open connection. \
     For safety, the second connection was refused."
)]
pub(crate) struct PairIdentityRejected;

struct Repair {
    control: ConnectControl,
    started: bool,
}

struct State {
    closing: bool,
    terminal_lost: bool,
    generation: u64,
    health: ControlHealth,
    control: Option<Arc<RusshTransport>>,
    repair: Option<Repair>,
    monitor: Option<tokio::task::JoinHandle<()>>,
    pumps: tokio::task::JoinSet<()>,
}

pub(crate) struct HostConnection {
    id: String,
    spec: HostSpec,
    pin: HostKeyPin,
    terminal: Arc<RusshTransport>,
    state: Mutex<State>,
    changed: watch::Sender<()>,
    events: Arc<dyn ConnectionEvents>,
}

impl HostConnection {
    pub(crate) async fn connect(
        id: String,
        spec: HostSpec,
        method: AuthMethod,
        policy: Arc<dyn HostKeyPolicy>,
        control: ConnectControl,
        events: Arc<dyn ConnectionEvents>,
    ) -> anyhow::Result<Arc<Self>> {
        // Both credentials are prepared before either network connection. The
        // first transport's Drop aborts its socket if the second leg fails.
        let (first, second) = RusshTransport::prepare_pair(method, &control).await?;
        let policy = Arc::new(PairHostKeyPolicy::new(&spec, control.clone(), policy));
        let build = async {
            let first = RusshTransport::connect_prepared_controlled(
                &spec,
                policy.clone(),
                first,
                control.clone(),
            )
            .await?;
            let terminal = RusshTransport::connect_prepared_controlled(
                &spec,
                policy.clone(),
                second,
                control.clone(),
            )
            .await?;
            control.with_active(|| ())?;
            let pin = policy.pin().ok_or(PairIdentityRejected)?;
            let (changed, _) = watch::channel(());
            Ok(Arc::new(Self {
                id,
                spec,
                pin,
                terminal: Arc::new(terminal),
                events,
                changed,
                state: Mutex::new(State {
                    closing: false,
                    terminal_lost: false,
                    generation: 0,
                    health: ControlHealth::Ready,
                    control: Some(Arc::new(first)),
                    repair: None,
                    monitor: None,
                    pumps: tokio::task::JoinSet::new(),
                }),
            }))
        }
        .await;
        if policy.rejected() {
            return Err(PairIdentityRejected.into());
        }
        build
    }

    /// One monitor per host, owned and joined by dispose. It holds no strong
    /// HostConnection reference while waiting, so dropping the host aborts IO.
    pub(crate) fn start_monitor(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if state.closing || state.monitor.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let changed = self.changed.subscribe();
        state.monitor = Some(tokio::spawn(Self::monitor(weak, changed)));
    }

    async fn monitor(weak: Weak<Self>, mut changed: watch::Receiver<()>) {
        loop {
            let Some(host) = weak.upgrade() else { return };
            let snapshot = {
                let state = host.state.lock().unwrap();
                if state.closing {
                    return;
                }
                (
                    host.terminal.clone(),
                    state.terminal_lost,
                    state.control.clone(),
                    state.generation,
                    state.repair.as_ref().map(|repair| repair.control.clone()),
                )
            };
            drop(host);
            let (terminal, terminal_lost, control, generation, repair) = snapshot;
            tokio::select! {
                biased;
                result = changed.changed() => { if result.is_err() { return; } },
                _ = terminal.closed(), if !terminal_lost => {
                    if let Some(host) = weak.upgrade() { host.terminal_ended(); }
                },
                _ = async { match control { Some(control) => control.closed().await, None => std::future::pending().await } } => {
                    if let Some(host) = weak.upgrade() { host.control_ended(generation); }
                },
                _ = async { match repair { Some(repair) => { let _ = repair.wait_total(std::future::pending::<()>()).await; }, None => std::future::pending().await } } => {
                    if let Some(host) = weak.upgrade() {
                        host.finish_repair_failure(generation, false, "Control reconnection cancelled or timed out.");
                    }
                }
            }
        }
    }

    fn emit(&self, state: &State, message: Option<String>) {
        // The same short gate admits events and starts Closing. Events already
        // handed to the sink are additionally guarded by runtime ID in the UI.
        if !state.closing {
            self.events.control_state(ControlStateEvent {
                host_id: self.id.clone(),
                control_generation: state.generation,
                state: state.health,
                message,
            });
        }
    }

    fn terminal_ended(&self) {
        let mut state = self.state.lock().unwrap();
        if state.closing || state.terminal_lost {
            return;
        }
        state.terminal_lost = true;
        if let Some(repair) = state.repair.take() {
            repair.control.cancel();
        }
        self.events
            .terminal_transport_lost(TerminalTransportLostEvent {
                host_id: self.id.clone(),
            });
        self.changed.send_replace(());
    }

    fn control_ended(&self, generation: u64) {
        let mut state = self.state.lock().unwrap();
        if state.closing || state.generation != generation || state.control.is_none() {
            return;
        }
        state.control.take();
        state.health = ControlHealth::Degraded;
        self.emit(&state, Some("The control connection has ended.".into()));
        self.changed.send_replace(());
    }

    pub(crate) fn terminal(&self) -> &Arc<RusshTransport> {
        &self.terminal
    }

    pub(crate) fn start_pump(
        &self,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> anyhow::Result<()> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            !state.closing && !state.terminal_lost,
            "host terminal transport is unavailable"
        );
        while state.pumps.try_join_next().is_some() {}
        anyhow::ensure!(
            state.pumps.len() < MAX_PUMPS,
            "too many terminal output tasks are still closing"
        );
        state.pumps.spawn(future);
        Ok(())
    }

    pub(crate) fn command(self: &Arc<Self>, deadline: Instant) -> CommandTransport {
        self.command_transport(OperationControl::with_deadline(deadline), true)
    }

    /// Same control identity as `command`, but reuses an existing operation
    /// (absolute deadline and cancel state) instead of opening a new one.
    /// Dropping this transport must not cancel that shared operation.
    pub(crate) fn command_sharing(
        self: &Arc<Self>,
        operation: OperationControl,
    ) -> CommandTransport {
        self.command_transport(operation, false)
    }

    fn command_transport(
        self: &Arc<Self>,
        operation: OperationControl,
        owns_operation: bool,
    ) -> CommandTransport {
        let state = self.state.lock().unwrap();
        let transport = if !state.closing && state.health == ControlHealth::Ready {
            state.control.clone()
        } else {
            None
        };
        CommandTransport {
            host: Arc::downgrade(self),
            transport,
            generation: state.generation,
            operation,
            owns_operation,
            mutation_completed: AtomicBool::new(false),
            unknown_mutation: AtomicBool::new(false),
        }
    }

    /// Eine Regel fuer jeden Befehl, gleich welcher Phase: Nur ein
    /// unbenutzbarer Transport setzt Degraded. Ein gescheiterter Befehl auf
    /// nutzbarem Transport aendert nichts; seinen Fehler sieht nur der Aufrufer.
    fn observe(&self, generation: u64, result: &anyhow::Result<ExecResult>) {
        let mut state = self.state.lock().unwrap();
        if state.closing || generation != state.generation || state.control.is_none() {
            return;
        }
        let previous = state.health;
        let usable = state
            .control
            .as_ref()
            .is_some_and(|control| control.is_usable());
        let mut message = None;
        if !usable {
            state.control.take();
            state.health = ControlHealth::Degraded;
            message = Some(degraded_message(result));
        } else if result.is_ok() {
            state.health = ControlHealth::Ready;
        }
        if state.health != previous {
            self.emit(&state, message);
            self.changed.send_replace(());
        }
    }

    pub(crate) fn begin_repair(&self) -> anyhow::Result<u64> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            !state.closing && !state.terminal_lost && self.terminal.is_usable(),
            "host terminal transport is unavailable"
        );
        anyhow::ensure!(
            matches!(
                state.health,
                ControlHealth::Degraded | ControlHealth::AuthenticationRequired
            ),
            "control connection does not need reconnection"
        );
        anyhow::ensure!(
            state.repair.is_none(),
            "control reconnection already pending"
        );
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("control generation exhausted"))?;
        state.health = ControlHealth::Reconnecting;
        state.repair = Some(Repair {
            control: ConnectControl::new(ConnectLimits::default()),
            started: false,
        });
        self.emit(&state, None);
        self.changed.send_replace(());
        Ok(state.generation)
    }

    pub(crate) fn take_repair(self: &Arc<Self>, generation: u64) -> anyhow::Result<RepairAttempt> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            !state.closing && !state.terminal_lost && state.generation == generation,
            "control reconnection is no longer current"
        );
        let repair = state
            .repair
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no pending control reconnection"))?;
        anyhow::ensure!(!repair.started, "control reconnection was already started");
        repair.control.with_active(|| ())?;
        repair.started = true;
        Ok(RepairAttempt {
            host: self.clone(),
            generation,
            control: repair.control.clone(),
            finished: false,
        })
    }

    pub(crate) fn cancel_repair(&self, generation: u64) {
        self.finish_repair_failure(generation, false, "Control reconnection cancelled.");
    }

    fn finish_repair_failure(&self, generation: u64, authentication: bool, message: &str) {
        let mut state = self.state.lock().unwrap();
        if state.closing || state.generation != generation || state.repair.is_none() {
            return;
        }
        if let Some(repair) = state.repair.take() {
            repair.control.cancel();
        }
        state.health = if authentication {
            ControlHealth::AuthenticationRequired
        } else {
            ControlHealth::Degraded
        };
        self.emit(&state, Some(message.into()));
        self.changed.send_replace(());
    }

    /// Immediate IO stop is synchronous; no russh queue can delay closing.
    pub(crate) fn abort(&self) {
        let mut state = self.state.lock().unwrap();
        state.closing = true;
        if let Some(repair) = state.repair.take() {
            repair.control.cancel();
        }
        if let Some(control) = &state.control {
            control.abort();
        }
        self.terminal.abort();
        state.pumps.abort_all();
        self.changed.send_replace(());
    }

    pub(crate) async fn dispose(&self) {
        self.abort();
        let (control, monitor, mut pumps) = {
            let mut state = self.state.lock().unwrap();
            (
                state.control.take(),
                state.monitor.take(),
                std::mem::take(&mut state.pumps),
            )
        };
        let terminal = self.terminal.dispose();
        let control = async {
            if let Some(control) = control {
                control.dispose().await;
            }
        };
        let monitor = async {
            if let Some(mut monitor) = monitor {
                if tokio::time::timeout(Duration::from_secs(2), &mut monitor)
                    .await
                    .is_err()
                {
                    monitor.abort();
                    let _ = monitor.await;
                }
            }
        };
        let pumps = async {
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                while pumps.join_next().await.is_some() {}
            })
            .await;
            // JoinSet drop aborts any remaining task; a fallback is not a claim
            // that a blocked synchronous sink was fully joined.
        };
        tokio::join!(terminal, control, monitor, pumps);
    }
}

impl Drop for HostConnection {
    fn drop(&mut self) {
        self.abort();
        if let Some(monitor) = self.state.get_mut().unwrap().monitor.take() {
            monitor.abort();
        }
    }
}

/// Meldung beim Wechsel auf Degraded: Phase und Grund des ausloesenden
/// Fehlers als Woerter, nie als Debug-Ausgabe (V-07).
fn degraded_message(result: &anyhow::Result<ExecResult>) -> String {
    match result
        .as_ref()
        .err()
        .and_then(|error| error.downcast_ref::<ExecError>())
    {
        Some(error) => format!(
            "The control connection has ended ({}, {}).",
            error.phase.as_str(),
            error.reason.as_str()
        ),
        None => "The control connection has ended.".into(),
    }
}

pub(crate) struct RepairAttempt {
    host: Arc<HostConnection>,
    generation: u64,
    pub(crate) control: ConnectControl,
    finished: bool,
}

impl RepairAttempt {
    pub(crate) async fn connect(
        &mut self,
        method: AuthMethod,
        known_hosts: String,
    ) -> anyhow::Result<()> {
        let policy = Arc::new(RepairHostKeyPolicy::new(
            self.host.pin.clone(),
            known_hosts,
            self.control.clone(),
        ));
        let result = RusshTransport::connect_controlled(
            &self.host.spec,
            policy.clone(),
            method,
            self.control.clone(),
        )
        .await;
        if policy.rejected() {
            return Err(PairIdentityRejected.into());
        }
        let transport = Arc::new(result?);
        let mut state = self.host.state.lock().unwrap();
        anyhow::ensure!(
            !state.closing
                && !state.terminal_lost
                && state.generation == self.generation
                && state.repair.is_some(),
            "control reconnection is no longer current"
        );
        self.control.with_active(|| {
            state.control = Some(transport);
            state.repair = None;
            state.health = ControlHealth::Ready;
            self.host.emit(&state, None);
            self.host.changed.send_replace(());
            self.finished = true;
        })?;
        Ok(())
    }

    pub(crate) fn fail(&mut self, authentication: bool, message: &str) {
        self.host
            .finish_repair_failure(self.generation, authentication, message);
        self.finished = true;
    }
}

impl Drop for RepairAttempt {
    fn drop(&mut self) {
        if !self.finished {
            self.host.cancel_repair(self.generation);
        }
    }
}

/// Fixed control identity and one absolute deadline for an entire IPC command.
pub(crate) struct CommandTransport {
    host: Weak<HostConnection>,
    transport: Option<Arc<RusshTransport>>,
    pub(crate) generation: u64,
    operation: OperationControl,
    owns_operation: bool,
    mutation_completed: AtomicBool,
    unknown_mutation: AtomicBool,
}

impl CommandTransport {
    #[cfg(test)]
    pub(crate) fn operation(&self) -> &OperationControl {
        &self.operation
    }

    pub(crate) fn can_cleanup(&self) -> bool {
        !self.unknown_mutation.load(Ordering::Acquire)
            && self.operation.with_active(|| ()).is_ok()
            && self
                .transport
                .as_ref()
                .is_some_and(|transport| transport.is_usable())
    }

    pub(crate) fn unknown_outcome(&self) -> bool {
        self.unknown_mutation.load(Ordering::Acquire)
            || self.mutation_completed.load(Ordering::Acquire)
    }

    async fn execute(
        &self,
        line: &str,
        timeout: Duration,
        mutation: bool,
    ) -> anyhow::Result<ExecResult> {
        // No follow-up mutation/cleanup is admitted after an unconfirmed send.
        // This also protects prepare_server's best-effort restoration path.
        if self.unknown_mutation.load(Ordering::Acquire) {
            return Err(ExecError {
                phase: ExecPhase::Admission,
                reason: ExecReason::Unavailable,
                submission: Submission::NotSubmitted,
            }
            .into());
        }
        let result = match &self.transport {
            Some(transport) => {
                let deadline = self.operation.deadline().min(Instant::now() + timeout);
                if deadline == self.operation.deadline() {
                    transport
                        .exec_controlled(line, self.operation.clone())
                        .await
                } else {
                    // Dropping the child future cancels its owned channel work.
                    match self
                        .operation
                        .wait(
                            transport
                                .exec_controlled(line, OperationControl::with_deadline(deadline)),
                        )
                        .await
                    {
                        Ok(result) => result,
                        Err(error) => Err(ExecError {
                            phase: ExecPhase::Read,
                            reason: error.into(),
                            submission: Submission::PossiblySubmitted,
                        }
                        .into()),
                    }
                }
            }
            None => Err(ExecError {
                phase: ExecPhase::Admission,
                reason: ExecReason::Unavailable,
                submission: Submission::NotSubmitted,
            }
            .into()),
        };
        if mutation {
            match &result {
                Ok(result) if result.code == 0 => {
                    self.mutation_completed.store(true, Ordering::Release);
                }
                Err(error)
                    if error
                        .downcast_ref::<ExecError>()
                        .is_some_and(|error| error.submission == Submission::PossiblySubmitted) =>
                {
                    self.unknown_mutation.store(true, Ordering::Release);
                }
                _ => {}
            }
        }
        if let Some(host) = self.host.upgrade() {
            host.observe(self.generation, &result);
        }
        result
    }
}

#[async_trait]
impl Transport for CommandTransport {
    async fn exec_with_deadline(
        &self,
        line: &str,
        timeout: Duration,
    ) -> anyhow::Result<ExecResult> {
        self.execute(line, timeout, false).await
    }

    async fn exec_mutation(&self, line: &str) -> anyhow::Result<ExecResult> {
        self.execute(line, COMMAND_TIMEOUT, true).await
    }

    async fn dispose(&self) {
        if self.owns_operation {
            self.operation.cancel();
        }
    }
}

impl Drop for CommandTransport {
    fn drop(&mut self) {
        if self.owns_operation {
            self.operation.cancel();
        }
    }
}
