//! Bounded channel owners outlive their callers and retain late SSH replies.
use super::pty_output::{self, Output, PtyOutputReceiver, PushError};
use super::{AbortHandle, ExecOutput, ExecResult, Handle, Handler, Msg};
use crate::tmux::attach_confirmation::{WrapperIdentity, WrapperStream};
use crate::transport::{
    ExecError, ExecPhase, ExecReason, OperationControl, OperationError, PtyError, PtyPhase,
    PtyReason, Submission,
};
use russh::{
    ChannelEndObserver, ChannelEndSnapshot, ChannelMsg, ChannelReadHalf, ChannelWriteHalf,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;
use tokio::io::AsyncWrite;
use tokio::sync::{oneshot, watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{timeout, timeout_at, Instant};

const CLEANUP: Duration = Duration::from_secs(2);
/// Spec 2026-10-19 §8.1 (Schritt 3): so lange wartet ein Oeffnen hoechstens auf
/// einen PTY-Platz und eine Erlaubnis fuer unveroeffentlichte Kanaele, bevor es
/// mit dem bisherigen Kapazitaetsfehler scheitert; dieselbe Geduld wie
/// `CLEANUP`. Ein Platz wird erst mit dem Close der Gegenseite frei
/// (`close_channel`), so wartet ein Ersetzen an der Grenze, bis der alte Kanal
/// zu ist.
pub(crate) const SLOT_WAIT: Duration = Duration::from_secs(2);
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

struct Core {
    handle: Handle<Handler>,
    abort: AbortHandle,
    stop_gate: Mutex<bool>,
    stopping: watch::Sender<bool>,
    ended: watch::Receiver<bool>,
}

async fn signalled(mut signal: watch::Receiver<bool>) {
    loop {
        if *signal.borrow_and_update() {
            return;
        }
        if signal.changed().await.is_err() {
            return;
        }
    }
}

impl Core {
    fn usable(&self) -> bool {
        !*self.stop_gate.lock().unwrap() && !*self.ended.borrow() && !self.handle.is_closed()
    }
    fn abort(&self) {
        *self.stop_gate.lock().unwrap() = true;
        self.stopping.send_replace(true);
        let _ = self.abort.abort();
    }
    async fn stopped(&self) {
        tokio::select! {
            _ = signalled(self.stopping.subscribe()) => {},
            _ = signalled(self.ended.clone()) => {},
        }
    }
}

pub(super) struct Operations {
    core: Arc<Core>,
    tasks: Mutex<JoinSet<()>>,
    exec_slots: Arc<Semaphore>,
    pty_slots: Arc<Semaphore>,
    unpublished: Arc<Semaphore>,
}

impl Operations {
    pub(super) fn new(
        handle: Handle<Handler>,
        abort: AbortHandle,
        ended: watch::Receiver<bool>,
    ) -> Self {
        let (stopping, _) = watch::channel(false);
        Self {
            core: Arc::new(Core {
                handle,
                abort,
                stop_gate: Mutex::new(false),
                stopping,
                ended,
            }),
            tasks: Mutex::new(JoinSet::new()),
            exec_slots: Arc::new(Semaphore::new(8)),
            pty_slots: Arc::new(Semaphore::new(8)),
            unpublished: Arc::new(Semaphore::new(4)),
        }
    }

    fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        while tasks.try_join_next().is_some() {}
        if !self.core.usable() {
            return false;
        }
        tasks.spawn(task);
        true
    }

    pub(super) fn is_usable(&self) -> bool {
        self.core.usable()
    }
    pub(super) fn abort(&self) {
        self.core.abort();
    }
    pub(super) async fn closed(&self) {
        signalled(self.core.ended.clone()).await;
    }

    pub(super) async fn dispose(&self) {
        // Admission and ownership transfer serialize with taking the registry.
        let mut tasks = {
            let mut registry = self.tasks.lock().unwrap();
            self.core.abort();
            std::mem::take(&mut *registry)
        };
        let end = Instant::now() + CLEANUP;
        while !tasks.is_empty() {
            if timeout_at(end, tasks.join_next()).await.is_err() {
                // JoinSet owns every task even on this fallback: dropping it
                // cancels them; it does not detach an untracked cleanup worker.
                tasks.abort_all();
                break;
            }
        }
        let _ = timeout_at(end, self.closed()).await;
    }

    pub(super) async fn exec(
        &self,
        line: String,
        control: OperationControl,
    ) -> anyhow::Result<ExecResult> {
        let mut lease = control.caller_lease();
        let progress = Arc::new(Mutex::new(ExecProgress {
            phase: ExecPhase::Admission,
            submission: Submission::NotSubmitted,
            open_started: false,
        }));
        let result = async {
            control
                .with_active(|| ())
                .map_err(|e| progress.lock().unwrap().error(e.into()))?;
            let permit = self
                .exec_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| progress.lock().unwrap().error(ExecReason::Capacity))?;
            let (reply, receiver) = oneshot::channel();
            if !self.spawn(exec_actor(
                self.core.clone(),
                line,
                control.clone(),
                progress.clone(),
                permit,
                reply,
            )) {
                return Err(progress
                    .lock()
                    .unwrap()
                    .error(ExecReason::Unavailable)
                    .into());
            }
            match control.wait(receiver).await {
                Ok(Ok(result)) => result.map_err(anyhow::Error::from),
                Ok(Err(_)) => Err(progress.lock().unwrap().error(ExecReason::Transport).into()),
                Err(error) => {
                    let current = *progress.lock().unwrap();
                    if current.phase == ExecPhase::Open && current.open_started {
                        self.core.abort();
                    }
                    Err(current.error(error.into()).into())
                }
            }
        }
        .await;
        lease.disarm();
        result
    }

    /// Ungebundener Attach: `open_attach_pending` ohne Nonce, sofort
    /// bestaetigt. Ohne Nonce gibt es keinen Wrapper-Strom, und `confirm` gibt
    /// die Erlaubnis fuer unveroeffentlichte Kanaele ohne Await-Punkt nach dem
    /// Entschaerfen der Lease frei.
    pub(super) async fn open_attach(
        &self,
        line: String,
        cols: u16,
        rows: u16,
        control: OperationControl,
    ) -> anyhow::Result<PtyHandle> {
        self.open_attach_pending(line, cols, rows, control, None)
            .await
            .map(PendingPty::confirm)
    }

    pub(super) async fn open_attach_pending(
        &self,
        line: String,
        cols: u16,
        rows: u16,
        control: OperationControl,
        nonce: Option<&str>,
    ) -> anyhow::Result<PendingPty> {
        let mut lease = control.caller_lease();
        let phase = Arc::new(Mutex::new(PtyPhase::Admission));
        let result = async {
            control.with_active(|| ()).map_err(|error| PtyError {
                phase: PtyPhase::Admission,
                reason: error.into(),
            })?;
            let (slot, unpublished) = self.admit_pty(&control).await?;
            let wrapper = match nonce {
                Some(nonce) => {
                    Some(WrapperStream::new(nonce.to_owned()).map_err(|_| PtyError {
                        phase: PtyPhase::Admission,
                        reason: PtyReason::Rejected,
                    })?)
                }
                None => None,
            };
            let (reply, receiver) = oneshot::channel();
            if !self.spawn(pty_actor(
                self.core.clone(),
                line,
                cols,
                rows,
                control.clone(),
                phase.clone(),
                slot,
                unpublished,
                reply,
                wrapper,
            )) {
                return Err(PtyError {
                    phase: PtyPhase::Admission,
                    reason: PtyReason::Unavailable,
                }
                .into());
            }
            match control.wait(receiver).await {
                Ok(Ok(result)) => result
                    .map(|handoff| PendingPty::from_handoff(handoff, control.clone()))
                    .map_err(anyhow::Error::from),
                Ok(Err(_)) => Err(PtyError {
                    phase: *phase.lock().unwrap(),
                    reason: PtyReason::Transport,
                }
                .into()),
                Err(error) => Err(PtyError {
                    phase: *phase.lock().unwrap(),
                    reason: error.into(),
                }
                .into()),
            }
        }
        .await;
        lease.disarm();
        result
    }

    /// Spec 2026-10-19 §8.1 (Schritt 3): erst ein PTY-Platz, dann eine
    /// Erlaubnis fuer unveroeffentlichte Kanaele, zusammen hoechstens
    /// `SLOT_WAIT`, statt sofort abzuweisen; bis dahin geht nichts zur
    /// Gegenseite. Nach der Frist kommt der bisherige Fehler (`Admission`,
    /// `Capacity`), dessen Text das Frontend als Kanalgrenze erkennt. Ein
    /// Kreislauf ist ausgeschlossen: Wer eine Erlaubnis haelt, wartet nur noch
    /// auf die Gegenseite.
    async fn admit_pty(
        &self,
        control: &OperationControl,
    ) -> Result<(OwnedSemaphorePermit, OwnedSemaphorePermit), PtyError> {
        let until = Instant::now() + SLOT_WAIT;
        let error = |reason| PtyError {
            phase: PtyPhase::Admission,
            reason,
        };
        let slot = admit(&self.core, &self.pty_slots, control, until)
            .await
            .map_err(error)?;
        let unpublished = admit(&self.core, &self.unpublished, control, until)
            .await
            .map_err(error)?;
        Ok((slot, unpublished))
    }
}

impl Drop for Operations {
    fn drop(&mut self) {
        self.core.abort();
    }
}

#[derive(Clone, Copy)]
struct ExecProgress {
    phase: ExecPhase,
    submission: Submission,
    open_started: bool,
}
impl ExecProgress {
    fn error(&self, reason: ExecReason) -> ExecError {
        ExecError {
            phase: self.phase,
            reason,
            submission: self.submission,
        }
    }
}

enum StepError {
    Operation(OperationError),
    Transport,
}
impl From<StepError> for ExecReason {
    fn from(error: StepError) -> Self {
        match error {
            StepError::Operation(e) => e.into(),
            StepError::Transport => Self::Transport,
        }
    }
}
impl From<StepError> for PtyReason {
    fn from(error: StepError) -> Self {
        match error {
            StepError::Operation(e) => e.into(),
            StepError::Transport => Self::Transport,
        }
    }
}

async fn step<T>(
    core: &Core,
    control: &OperationControl,
    future: impl Future<Output = T>,
) -> Result<T, StepError> {
    control.with_active(|| ()).map_err(StepError::Operation)?;
    tokio::select! {
        biased;
        _ = core.stopped() => Err(StepError::Transport),
        stopped = control.wait(std::future::pending::<()>()) => Err(StepError::Operation(stopped.unwrap_err())),
        // Preserve an already obtained channel/message. A post-poll cancellation
        // check could discard the only Close acknowledgement or Open channel ID.
        // The next phase and the caller publication gate check the sticky stop.
        result = future => Ok(result),
    }
}

/// Eine Erlaubnis aus `permits`, sobald eine frei ist, spaetestens bis `until`
/// (dann `Capacity`). Abbruch und Frist der Operation beenden das Warten mit
/// ihrem Grund, das Ende des Transports mit `Unavailable`, wie bei einem
/// Oeffnen, das schon ohne Transport ankommt (`Operations::spawn`). Der
/// Semaphor bedient Wartende der Reihe nach; ein beendetes Warten verlaesst
/// die Reihe.
async fn admit(
    core: &Core,
    permits: &Arc<Semaphore>,
    control: &OperationControl,
    until: Instant,
) -> Result<OwnedSemaphorePermit, PtyReason> {
    tokio::select! {
        biased;
        _ = core.stopped() => Err(PtyReason::Unavailable),
        stopped = control.wait(std::future::pending::<()>()) => Err(stopped.unwrap_err().into()),
        // Vor der Frist: Ist beides zugleich bereit, gilt die Erlaubnis.
        // Geschlossen wird keiner der Semaphore dieses Moduls.
        permit = permits.clone().acquire_owned() => permit.map_err(|_| PtyReason::Unavailable),
        _ = tokio::time::sleep_until(until) => Err(PtyReason::Capacity),
    }
}

async fn exec_actor(
    core: Arc<Core>,
    line: String,
    control: OperationControl,
    progress: Arc<Mutex<ExecProgress>>,
    _slot: OwnedSemaphorePermit,
    reply: oneshot::Sender<Result<ExecResult, ExecError>>,
) {
    let end_core = core.clone();
    async {
        let error = |reason| progress.lock().unwrap().error(reason);
        if let Err(e) = control.with_active(|| progress.lock().unwrap().phase = ExecPhase::Open) {
            let _ = reply.send(Err(error(e.into())));
            return;
        }
        let mut started = false;
        let opened = step(&core, &control, async {
            started = true;
            progress.lock().unwrap().open_started = true;
            core.handle.channel_open_session().await
        })
        .await;
        let channel = match opened {
            Ok(Ok(channel)) => channel,
            Ok(Err(russh::Error::ChannelOpenFailure(_))) => {
                let _ = reply.send(Err(error(ExecReason::Rejected)));
                return;
            }
            Ok(Err(_)) => {
                core.abort();
                let _ = reply.send(Err(error(ExecReason::Transport)));
                return;
            }
            Err(e) => {
                // Losing a possibly submitted Open loses its future channel ID.
                // Only this control connection is sacrificed; PTY uses another owner.
                if started {
                    core.abort();
                }
                let _ = reply.send(Err(error(e.into())));
                return;
            }
        };
        let (mut read, write) = channel.split();
        let mut closed = false;
        let result = async {
            control
                .with_active(|| {
                    let mut current = progress.lock().unwrap();
                    current.phase = ExecPhase::Send;
                    current.submission = Submission::PossiblySubmitted;
                })
                .map_err(|e| error(e.into()))?;
            step(&core, &control, write.exec(true, line))
                .await
                .map_err(|e| error(e.into()))?
                .map_err(|_| error(ExecReason::Transport))?;
            control
                .with_active(|| progress.lock().unwrap().phase = ExecPhase::Eof)
                .map_err(|e| error(e.into()))?;
            step(&core, &control, write.eof())
                .await
                .map_err(|e| error(e.into()))?
                .map_err(|_| error(ExecReason::Transport))?;
            control
                .with_active(|| progress.lock().unwrap().phase = ExecPhase::Read)
                .map_err(|e| error(e.into()))?;
            let mut output = ExecOutput::default();
            loop {
                let msg = step(&core, &control, read.wait())
                    .await
                    .map_err(|e| error(e.into()))?;
                let Some(msg) = msg else {
                    break;
                };
                if matches!(msg, ChannelMsg::Failure) {
                    return Err(error(ExecReason::Rejected));
                }
                let size = match &msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => data.len(),
                    _ => 0,
                };
                if output.stdout.len() + output.stderr.len() + size > OUTPUT_LIMIT {
                    return Err(error(ExecReason::OutputLimit));
                }
                if output.record(msg) {
                    closed = true;
                    break;
                }
            }
            output
                .finish()
                .map_err(|_| error(ExecReason::MissingExitStatus))
        }
        .await;
        let _ = reply.send(result);
        if !closed && !close_channel(&core, &mut read, &write, Some(Instant::now() + CLEANUP)).await
        {
            core.abort();
        }
    }
    .await;
    // Drop readers first to unblock russh's bounded message delivery. Retain
    // the operation permit until its actual handler has then ended.
    if !end_core.usable() {
        signalled(end_core.ended.clone()).await;
    }
}

/// Queueing Close is not completion. Continue receiving until the remote Close
/// (russh queues its reciprocal reply before publishing that message). EOF alone
/// never releases a permit. PTY callers pass no deadline: a stuck close retains
/// its bounded owner until a late reply or transport end, without killing peers.
async fn close_channel(
    core: &Core,
    read: &mut ChannelReadHalf,
    write: &ChannelWriteHalf<Msg>,
    deadline: Option<Instant>,
) -> bool {
    let close = write.close();
    tokio::pin!(close);
    let mut sent = false;
    loop {
        tokio::select! {
            biased;
            _ = core.stopped() => return true,
            _ = async { match deadline { Some(end) => tokio::time::sleep_until(end).await, None => std::future::pending().await } } => return false,
            result = &mut close, if !sent => { sent = true; if result.is_err() && !core.usable() { return true; } },
            message = read.wait() => match message {
                Some(ChannelMsg::Close) => return true,
                None => {
                    return match deadline {
                        Some(end) => timeout_at(end, core.stopped()).await.is_ok(),
                        None => { core.stopped().await; true },
                    };
                },
                _ => {},
            }
        }
    }
}

struct EndGuard(watch::Sender<bool>);
impl Drop for EndGuard {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

struct PtyHandoff {
    handle: PtyHandle,
    unpublished: OwnedSemaphorePermit,
    wrapper: watch::Receiver<Option<WrapperIdentity>>,
}

/// Unpublished attach: no UI receiver, no input/resize, 4-permit held until
/// confirm() or drop. Drop aborts the owner.
#[must_use]
pub struct PendingPty {
    handle: Option<PtyHandle>,
    _unpublished: Option<OwnedSemaphorePermit>,
    wrapper: watch::Receiver<Option<WrapperIdentity>>,
    /// The opening operation. After the transport handoff the PTY owner no
    /// longer watches it, so the wrapper wait must.
    control: OperationControl,
}

impl PendingPty {
    fn from_handoff(handoff: PtyHandoff, control: OperationControl) -> Self {
        Self {
            handle: Some(handoff.handle),
            _unpublished: Some(handoff.unpublished),
            wrapper: handoff.wrapper,
            control,
        }
    }

    /// `None` when the channel ends, or the opening operation is cancelled or
    /// reaches its deadline, before a W frame arrived.
    pub(crate) async fn wait_wrapper(&self) -> Option<WrapperIdentity> {
        let mut rx = self.wrapper.clone();
        let seen = self.control.wait(rx.wait_for(Option::is_some)).await.ok()?;
        seen.ok().and_then(|seen| seen.clone())
    }

    pub fn end_snapshot(&self) -> (Option<PtyReason>, ChannelEndSnapshot, bool) {
        self.handle.as_ref().unwrap().end_snapshot()
    }

    pub fn request_close(&self) {
        if let Some(handle) = &self.handle {
            handle.request_close();
        }
    }

    /// Releases the unpublished permit and yields the owner. Callers still
    /// must not expose input until their publication gate has committed.
    pub fn confirm(mut self) -> PtyHandle {
        drop(self._unpublished.take());
        self.handle
            .take()
            .expect("pending PTY confirm is single-use")
    }
}

impl Drop for PendingPty {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.request_close();
        }
    }
}

#[must_use]
pub struct PtyHandle {
    pub data: PtyOutputReceiver,
    write: Arc<ChannelWriteHalf<Msg>>,
    input: tokio::sync::Mutex<Option<PtyWriter>>,
    stop: Arc<PtyStop>,
    observer: ChannelEndObserver,
    ended: watch::Receiver<bool>,
    core: Arc<Core>,
}

type PtyWriter = Pin<Box<dyn AsyncWrite + Send>>;

struct PtyStop {
    state: Mutex<StopState>,
    changed: watch::Sender<bool>,
    aborting: watch::Sender<bool>,
}

#[derive(Default)]
struct StopState {
    reason: Option<PtyReason>,
    abort_output: bool,
    drain_timed_out: bool,
}

impl PtyStop {
    fn new() -> Self {
        Self {
            state: Mutex::new(StopState::default()),
            changed: watch::channel(false).0,
            aborting: watch::channel(false).0,
        }
    }

    fn set(&self, reason: PtyReason, abort_output: bool) {
        {
            let mut state = self.state.lock().unwrap();
            state.reason.get_or_insert(reason);
            state.abort_output |= abort_output;
        }
        self.changed.send_replace(true);
        if abort_output {
            self.aborting.send_replace(true);
        }
    }

    fn drain_timeout(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.drain_timed_out = true;
            state.reason.get_or_insert(PtyReason::Timeout);
        }
        self.changed.send_replace(true);
    }
}

/// Holds the sole writer even across a Pending poll. Cancellation drops its
/// reserved send future and closes this PTY; credits are never guessed back.
struct InputLease<'a> {
    writer: tokio::sync::MutexGuard<'a, Option<PtyWriter>>,
    stop: &'a PtyStop,
    observer: &'a ChannelEndObserver,
    polled: bool,
    complete: bool,
}

impl Drop for InputLease<'_> {
    fn drop(&mut self) {
        if self.polled && !self.complete {
            // Remote end stops input, but must not erase already received tail
            // output. An independent caller cancellation is a local abort.
            self.stop
                .set(PtyReason::Cancelled, !self.observer.snapshot().has_end());
            self.writer.take();
        }
    }
}

impl PtyHandle {
    pub fn take_output(&mut self) -> PtyOutputReceiver {
        std::mem::replace(&mut self.data, PtyOutputReceiver::empty())
    }

    pub fn request_close(&self) {
        self.stop.set(PtyReason::Cancelled, true);
    }
    pub async fn close(&self) {
        self.request_close();
        let _ = timeout(CLEANUP, signalled(self.ended.clone())).await;
    }
    pub async fn closed(&self) {
        signalled(self.ended.clone()).await;
    }
    pub(crate) fn end_snapshot(&self) -> (Option<PtyReason>, ChannelEndSnapshot, bool) {
        let state = self.stop.state.lock().unwrap();
        (
            state.reason,
            self.observer.snapshot(),
            state.drain_timed_out,
        )
    }

    pub(crate) async fn end_changed(&self) {
        tokio::select! {
            _ = signalled(self.stop.changed.subscribe()) => {},
            _ = self.observer.wait_ended() => {},
            _ = self.core.stopped() => {},
        }
    }

    fn input_gate<T>(&self, deadline: Instant, action: impl FnOnce() -> T) -> Result<T, PtyReason> {
        // Same ordering as abort/local close/dispatcher; never await here.
        let core_stop = self.core.stop_gate.lock().unwrap();
        if *core_stop || *self.core.ended.borrow() || self.core.handle.is_closed() {
            return Err(PtyReason::Transport);
        }
        let local_stop = self.stop.state.lock().unwrap();
        if let Some(reason) = local_stop.reason {
            return Err(reason);
        }
        self.observer
            .with_no_end(|| {
                // Check after acquiring every gate, immediately before admission.
                if Instant::now() >= deadline {
                    Err(PtyReason::Timeout)
                } else {
                    Ok(action())
                }
            })
            .map_err(|_| PtyReason::Transport)?
    }

    async fn input_wait<T>(
        &self,
        deadline: Instant,
        future: impl Future<Output = T>,
    ) -> Result<T, PtyReason> {
        tokio::select! {
            biased;
            _ = self.end_changed() => Err(self.end_snapshot().0.unwrap_or(PtyReason::Transport)),
            result = timeout_at(deadline, future) => result.map_err(|_| PtyReason::Timeout),
        }
    }

    pub async fn write(&self, bytes: &[u8]) -> anyhow::Result<()> {
        self.write_until(bytes, Instant::now() + Duration::from_secs(15))
            .await
    }

    async fn write_until(&self, bytes: &[u8], deadline: Instant) -> anyhow::Result<()> {
        let error = |reason| PtyError {
            phase: PtyPhase::Input,
            reason,
        };
        let writer = self
            .input_wait(deadline, self.input.lock())
            .await
            .map_err(error)?;
        let mut lease = InputLease {
            writer,
            stop: &self.stop,
            observer: &self.observer,
            polled: false,
            complete: false,
        };
        let result = async {
            let mut offset = 0;
            self.input_gate(deadline, || ())?;
            while offset < bytes.len() {
                let end = bytes.len().min(offset.saturating_add(16 * 1024));
                let count = self
                    .input_wait(
                        deadline,
                        std::future::poll_fn(|cx| {
                            match self.input_gate(deadline, || {
                                lease.polled = true;
                                match lease.writer.as_mut() {
                                    Some(writer) => writer
                                        .as_mut()
                                        .poll_write(cx, &bytes[offset..end])
                                        .map(|result| result.map_err(|_| PtyReason::Transport)),
                                    None => Poll::Ready(Err(PtyReason::Transport)),
                                }
                            }) {
                                Ok(poll) => poll,
                                Err(reason) => Poll::Ready(Err(reason)),
                            }
                        }),
                    )
                    .await??;
                if count == 0 {
                    return Err(PtyReason::Transport);
                }
                offset += count;
            }
            Ok(())
        }
        .await;
        if let Err(reason) = result {
            if lease.polled {
                self.stop.set(reason, !self.observer.snapshot().has_end());
            }
            return Err(error(reason).into());
        }
        lease.complete = true;
        Ok(())
    }

    #[cfg(test)]
    pub(super) async fn test_writer(&self, writer: impl AsyncWrite + Send + 'static) {
        *self.input.lock().await = Some(Box::pin(writer));
    }

    #[cfg(test)]
    pub(super) async fn test_raw_channel(&self) -> russh::Channel<Msg> {
        self.core.handle.channel_open_session().await.unwrap()
    }

    #[cfg(test)]
    pub(super) fn test_write_half(&self) -> &ChannelWriteHalf<Msg> {
        &self.write
    }

    #[cfg(test)]
    pub(super) async fn test_write_until(
        &self,
        bytes: &[u8],
        deadline: Instant,
    ) -> anyhow::Result<()> {
        self.write_until(bytes, deadline).await
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(15);
        let error = |reason| PtyError {
            phase: PtyPhase::Resize,
            reason,
        };
        let writer = self
            .input_wait(deadline, self.input.lock())
            .await
            .map_err(error)?;
        let mut lease = InputLease {
            writer,
            stop: &self.stop,
            observer: &self.observer,
            polled: false,
            complete: false,
        };
        let resize = self.write.window_change(cols as u32, rows as u32, 0, 0);
        tokio::pin!(resize);
        let result = self
            .input_wait(
                deadline,
                std::future::poll_fn(|cx| {
                    match self.input_gate(deadline, || {
                        lease.polled = true;
                        resize
                            .as_mut()
                            .poll(cx)
                            .map(|result| result.map_err(|_| PtyReason::Transport))
                    }) {
                        Ok(poll) => poll,
                        Err(reason) => Poll::Ready(Err(reason)),
                    }
                }),
            )
            .await
            .and_then(|result| result);
        if let Err(reason) = result {
            if lease.polled {
                self.stop.set(reason, !self.observer.snapshot().has_end());
            }
            return Err(error(reason).into());
        }
        lease.complete = true;
        Ok(())
    }
}
impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.request_close();
    }
}

#[allow(clippy::too_many_arguments)]
async fn pty_actor(
    core: Arc<Core>,
    line: String,
    cols: u16,
    rows: u16,
    control: OperationControl,
    phase: Arc<Mutex<PtyPhase>>,
    _slot: OwnedSemaphorePermit,
    unpublished: OwnedSemaphorePermit,
    reply: oneshot::Sender<Result<PtyHandoff, PtyError>>,
    wrapper: Option<WrapperStream>,
) {
    let (ended, end_receiver) = watch::channel(false);
    let _end = EndGuard(ended);
    pty_work(
        core.clone(),
        line,
        cols,
        rows,
        control,
        phase,
        unpublished,
        reply,
        end_receiver,
        wrapper,
    )
    .await;
    // The inner work has dropped its channel reader, unblocking any full russh
    // delivery queue. Only its actual end releases this outer owner's slot.
    if !core.usable() {
        signalled(core.ended.clone()).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn pty_work(
    core: Arc<Core>,
    line: String,
    cols: u16,
    rows: u16,
    control: OperationControl,
    phase: Arc<Mutex<PtyPhase>>,
    unpublished: OwnedSemaphorePermit,
    reply: oneshot::Sender<Result<PtyHandoff, PtyError>>,
    end_receiver: watch::Receiver<bool>,
    mut wrapper: Option<WrapperStream>,
) {
    let (wrapper_tx, wrapper_rx) = watch::channel(None);
    let error = |reason| PtyError {
        phase: *phase.lock().unwrap(),
        reason,
    };
    if let Err(e) = control.with_active(|| *phase.lock().unwrap() = PtyPhase::Open) {
        let _ = reply.send(Err(error(e.into())));
        return;
    }
    // This future remains owned after caller cancellation: a late Open ACK must
    // still be received so its concrete channel can be closed without any PTY.
    let open = async {
        // If cancellation won before the first poll, do not submit a new Open.
        control
            .with_active(|| ())
            .map_err(|_| russh::Error::Disconnect)?;
        // Flusskontrolle: Der Kanal kuendigt `WINDOW` an und bekommt Bytes
        // erst zurueck, wenn der Leser sie der Warteschlange entnimmt.
        core.handle
            .channel_open_session_manual_window(pty_output::WINDOW)
            .await
    };
    tokio::pin!(open);
    let mut reply = Some(reply);
    let channel = tokio::select! {
        biased;
        _ = core.stopped() => { let _ = reply.take().unwrap().send(Err(error(PtyReason::Transport))); return; },
        stopped = control.wait(std::future::pending::<()>()) => {
            let _ = reply.take().unwrap().send(Err(error(stopped.unwrap_err().into())));
            // The open future has not necessarily been polled by this select.
            // Its first poll itself checks cancellation before submitting.
            tokio::select! { _ = core.stopped() => return, channel = &mut open => channel }
        },
        channel = &mut open => channel,
    };
    let (channel, credit) = match channel {
        Ok(opened) => opened,
        Err(cause) => {
            if let Some(reply) = reply {
                let reason = if matches!(cause, russh::Error::ChannelOpenFailure(_)) {
                    PtyReason::Rejected
                } else {
                    PtyReason::Transport
                };
                let _ = reply.send(Err(error(reason)));
            }
            return;
        }
    };
    let (mut read, write) = channel.split();
    if reply.is_none() || control.with_active(|| ()).is_err() {
        if let Some(reply) = reply {
            let reason = control.with_active(|| ()).unwrap_err();
            let _ = reply.send(Err(error(reason.into())));
        }
        close_channel(&core, &mut read, &write, None).await;
        return;
    }
    let Some(observer) = read.end_observer() else {
        let _ = reply.take().unwrap().send(Err(error(PtyReason::Transport)));
        close_channel(&core, &mut read, &write, None).await;
        return;
    };
    // The withheld receiver is also the early-output buffer. There is no
    // second queue whose credits or final bytes could escape the common limit.
    //
    // Flusskontrolle: Bytes gehen erst beim Entnehmen an das Kanalfenster
    // zurueck; bis der Empfaenger uebergeben ist und gelesen wird, steht die
    // Gegenseite nach einem Fenster.
    let (output, data) = pty_output::channel(move |bytes| credit.credit(bytes));
    let mut remote_closed = false;
    let result = async {
        setup_gate(&core, &control, &observer, || {
            *phase.lock().unwrap() = PtyPhase::Request
        })?;
        pty_step(
            &core,
            &control,
            &observer,
            write.request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]),
        )
        .await?
        .map_err(|_| PtyReason::Transport)?;
        acknowledge(
            &core,
            &control,
            &observer,
            &mut read,
            &output,
            &mut remote_closed,
            &mut wrapper,
            &wrapper_tx,
        )
        .await?;
        setup_gate(&core, &control, &observer, || {
            *phase.lock().unwrap() = PtyPhase::Attach
        })?;
        pty_step(&core, &control, &observer, write.exec(true, line))
            .await?
            .map_err(|_| PtyReason::Transport)?;
        acknowledge(
            &core,
            &control,
            &observer,
            &mut read,
            &output,
            &mut remote_closed,
            &mut wrapper,
            &wrapper_tx,
        )
        .await
    }
    .await;
    if let Err(reason) = result {
        let _ = reply.take().unwrap().send(Err(error(reason)));
        if !remote_closed {
            close_channel(&core, &mut read, &write, None).await;
        }
        return;
    }
    let input = tokio::sync::Mutex::new(Some(Box::pin(write.make_writer()) as PtyWriter));
    let write = Arc::new(write);
    let stop = Arc::new(PtyStop::new());
    let mut handle = Some(PtyHandle {
        data,
        write: write.clone(),
        input,
        stop: stop.clone(),
        observer: observer.clone(),
        ended: end_receiver,
        core: core.clone(),
    });
    // No new W/J/publication promise: this is the existing transport handoff,
    // now ordered with operation cancellation, local abort and decoded end.
    #[allow(clippy::result_large_err)]
    let handed = setup_gate(&core, &control, &observer, || {
        reply.take().unwrap().send(Ok(PtyHandoff {
            handle: handle.take().unwrap(),
            unpublished,
            wrapper: wrapper_rx,
        }))
    });
    match handed {
        Ok(Ok(())) => {}
        other => {
            if let Err(reason) = other {
                let _ = reply.take().unwrap().send(Err(error(reason)));
            }
            drop(handle);
            drop(output);
            close_channel(&core, &mut read, &write, None).await;
            return;
        }
    }
    forward(
        &core,
        &observer,
        &stop,
        &mut read,
        output,
        &mut remote_closed,
        wrapper,
        wrapper_tx,
    )
    .await;
    if !remote_closed {
        close_channel(&core, &mut read, &write, None).await;
    }
}

fn setup_gate<T>(
    core: &Core,
    control: &OperationControl,
    observer: &ChannelEndObserver,
    action: impl FnOnce() -> T,
) -> Result<T, PtyReason> {
    control
        .with_active(|| {
            let stopped = core.stop_gate.lock().unwrap();
            if *stopped || *core.ended.borrow() || core.handle.is_closed() {
                return Err(PtyReason::Transport);
            }
            observer
                .with_no_end(|| {
                    // The operation deadline may have expired while acquiring gates.
                    if Instant::now() >= control.deadline() {
                        Err(PtyReason::Timeout)
                    } else {
                        Ok(action())
                    }
                })
                .map_err(|_| PtyReason::Transport)?
        })
        .map_err(PtyReason::from)?
}

async fn pty_step<T>(
    core: &Core,
    control: &OperationControl,
    observer: &ChannelEndObserver,
    future: impl Future<Output = T>,
) -> Result<T, PtyReason> {
    tokio::pin!(future);
    tokio::select! {
        biased;
        _ = core.stopped() => Err(PtyReason::Transport),
        _ = observer.wait_ended() => Err(PtyReason::Transport),
        stopped = control.wait(std::future::pending::<()>()) => Err(stopped.unwrap_err().into()),
        result = std::future::poll_fn(|cx| {
            match setup_gate(core, control, observer, || future.as_mut().poll(cx)) {
                Ok(poll) => poll.map(Ok),
                Err(reason) => Poll::Ready(Err(reason)),
            }
        }) => result,
    }
}

fn push_output(output: &Output, data: &[u8]) -> Result<(), PtyReason> {
    output.push(data).map_err(|error| match error {
        PushError::Limit => PtyReason::OutputLimit,
        PushError::Closed => PtyReason::Cancelled,
    })
}

fn push_channel_bytes(
    output: &Output,
    wrapper: &mut Option<WrapperStream>,
    seen: &watch::Sender<Option<WrapperIdentity>>,
    data: &[u8],
    extended: bool,
) -> Result<(), PtyReason> {
    let Some(stream) = wrapper.as_mut() else {
        return push_output(output, data);
    };
    let stripped = stream
        .ingest(data, extended)
        .map_err(|_| PtyReason::Rejected)?;
    // Die W-Zeile verbraucht der Wrapper selbst: Sie kommt nie in die
    // Warteschlange und geht sofort an das Kanalfenster zurueck.
    output.consumed(stripped);
    if let Some(identity) = stream.identity() {
        let _ = seen.send(Some(identity.clone()));
        if stripped < data.len() {
            push_output(output, &data[stripped..])?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn acknowledge(
    core: &Core,
    control: &OperationControl,
    observer: &ChannelEndObserver,
    read: &mut ChannelReadHalf,
    output: &Output,
    closed: &mut bool,
    wrapper: &mut Option<WrapperStream>,
    seen: &watch::Sender<Option<WrapperIdentity>>,
) -> Result<(), PtyReason> {
    loop {
        match pty_step(core, control, observer, read.wait()).await? {
            Some(ChannelMsg::Success) => return setup_gate(core, control, observer, || ()),
            Some(ChannelMsg::Failure) => return Err(PtyReason::Rejected),
            Some(ChannelMsg::Close) => {
                *closed = true;
                return Err(PtyReason::Transport);
            }
            Some(
                ChannelMsg::Eof | ChannelMsg::ExitStatus { .. } | ChannelMsg::ExitSignal { .. },
            )
            | Some(ChannelMsg::OpenFailure(_))
            | None => return Err(PtyReason::Transport),
            Some(ChannelMsg::Data { data }) => {
                push_channel_bytes(output, wrapper, seen, &data, false)?
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                push_channel_bytes(output, wrapper, seen, &data, true)?
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn forward(
    core: &Core,
    observer: &ChannelEndObserver,
    stop: &PtyStop,
    read: &mut ChannelReadHalf,
    output: Output,
    remote_closed: &mut bool,
    mut wrapper: Option<WrapperStream>,
    seen: watch::Sender<Option<WrapperIdentity>>,
) {
    let mut drain_end = None;
    loop {
        if stop.state.lock().unwrap().abort_output {
            break;
        }
        if drain_end.is_none() && (observer.snapshot().has_end() || *core.ended.borrow()) {
            drain_end = Some(Instant::now() + CLEANUP);
        }
        let message = tokio::select! {
            biased;
            // Explicit local abort may discard output. Natural transport end
            // must instead drain its already queued bytes to receiver end.
            _ = signalled(core.stopping.subscribe()) => break,
            _ = signalled(stop.aborting.subscribe()) => break,
            _ = async { match drain_end { Some(end) => tokio::time::sleep_until(end).await, None => std::future::pending().await } } => {
                stop.drain_timeout();
                break;
            },
            _ = observer.wait_ended(), if drain_end.is_none() => continue,
            _ = signalled(core.ended.clone()), if drain_end.is_none() => continue,
            message = read.wait() => message,
        };
        match message {
            Some(ChannelMsg::Data { data }) => {
                if let Err(reason) = push_channel_bytes(&output, &mut wrapper, &seen, &data, false)
                {
                    stop.set(reason, true);
                    break;
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                if let Err(reason) = push_channel_bytes(&output, &mut wrapper, &seen, &data, true) {
                    stop.set(reason, true);
                    break;
                }
            }
            Some(ChannelMsg::Close) => {
                *remote_closed = true;
                break;
            }
            Some(ChannelMsg::Eof) | None => break,
            Some(ChannelMsg::ExitStatus { .. } | ChannelMsg::ExitSignal { .. }) => {
                drain_end.get_or_insert_with(|| Instant::now() + CLEANUP);
            }
            _ => {}
        }
    }
    // Drop only the sender: previously budgeted tail chunks remain ordered
    // until the consumer extracts them, even after the owner has ended.
    drop(output);
}
