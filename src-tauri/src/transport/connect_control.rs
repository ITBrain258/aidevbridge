//! One reserved connect attempt's cancellation and absolute time budgets.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

#[derive(Clone, Copy, Debug)]
pub struct ConnectLimits {
    pub total: Duration,
    pub network: Duration,
    pub auth: Duration,
    pub tofu: Duration,
}

impl Default for ConnectLimits {
    fn default() -> Self {
        Self {
            total: Duration::from_secs(240),
            network: Duration::from_secs(15),
            auth: Duration::from_secs(60),
            tofu: Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    #[error("Connection cancelled.")]
    Cancelled,
    #[error("Connection attempt timed out.")]
    DeadlineExceeded,
    #[error("SSH connection timed out.")]
    NetworkTimeout,
    #[error("Authentication timed out.")]
    AuthTimeout,
    // Text und Form wie bei der abgelehnten Rueckfrage (`commands.rs`,
    // `classify_connect_error`), mit "in time" (Spec §10).
    #[error("The host key wasn't confirmed in time, so aidevbridge didn't connect.")]
    TofuTimeout,
    #[error("Too many key preparations are already pending.")]
    PreparationBusy,
    #[error("Key preparation worker failed.")]
    PreparationFailed,
    #[error("Too many hostname resolutions are already pending.")]
    NetworkCapacity,
    #[error("Hostname resolution worker failed.")]
    ResolverFailed,
    #[error("Connection operation is already active.")]
    AlreadyActive,
}

struct NetworkClock {
    remaining: Duration,
    started: Option<Instant>,
}

#[derive(Default)]
struct State {
    stopped: Option<ConnectError>,
    cancelled: bool,
    network: Option<NetworkClock>,
    tofu_waiting: bool,
}

struct Inner {
    deadline: Instant,
    limits: ConnectLimits,
    state: Mutex<State>,
    changed: watch::Sender<()>,
}

/// Clone shares one attempt; construction belongs at reservation, before any
/// capacity/key waiting. No network, credentials or application locks live here.
#[derive(Clone)]
pub struct ConnectControl(Arc<Inner>);

#[derive(Clone, Copy)]
enum Budget {
    Total,
    Network,
    Until(Instant, ConnectError),
}

impl ConnectControl {
    pub fn new(limits: ConnectLimits) -> Self {
        Self::with_deadline(Instant::now() + limits.total, limits)
    }

    pub fn with_deadline(deadline: Instant, limits: ConnectLimits) -> Self {
        let (changed, _) = watch::channel(());
        Self(Arc::new(Inner {
            deadline,
            limits,
            state: Mutex::new(State::default()),
            changed,
        }))
    }

    pub fn deadline(&self) -> Instant {
        self.0.deadline
    }

    pub fn limits(&self) -> ConnectLimits {
        self.0.limits
    }

    /// For the prompt's displayed expiry; the actual wait also checks this
    /// absolute attempt deadline. Call immediately before starting the wait.
    pub fn tofu_deadline(&self) -> Instant {
        self.deadline().min(Instant::now() + self.0.limits.tofu)
    }

    fn stop(&self, reason: ConnectError) -> ConnectError {
        let reason = *self.0.state.lock().unwrap().stopped.get_or_insert(reason);
        self.0.changed.send_replace(());
        reason
    }

    pub fn cancel(&self) {
        let mut state = self.0.state.lock().unwrap();
        state.cancelled = true;
        state.stopped.get_or_insert(ConnectError::Cancelled);
        drop(state);
        self.0.changed.send_replace(());
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.state.lock().unwrap().cancelled
    }

    /// Waits for explicit cancellation, not for a timeout. Budgeted operations
    /// use the runners below and preserve their specific timeout reason.
    pub async fn cancelled(&self) {
        let mut changed = self.0.changed.subscribe();
        loop {
            if self.is_cancelled() {
                return;
            }
            let _ = changed.changed().await;
        }
    }

    /// A short, synchronous decision gate shared with cancel. Never await or do
    /// file/network IO here. Application lock order is HostSlotMutex -> Control
    /// -> PendingPromptMap; never acquire HostSlotMutex from this gate.
    pub fn with_active<T>(&self, decide: impl FnOnce() -> T) -> Result<T, ConnectError> {
        let mut state = self.0.state.lock().unwrap();
        if let Some(reason) = state.stopped {
            return Err(reason);
        }
        if Instant::now() >= self.deadline() {
            state.stopped = Some(ConnectError::DeadlineExceeded);
            drop(state);
            self.0.changed.send_replace(());
            return Err(ConnectError::DeadlineExceeded);
        }
        Ok(decide())
    }

    fn next_deadline(&self, budget: Budget) -> (Instant, ConnectError) {
        let local = match budget {
            Budget::Total => None,
            Budget::Until(end, reason) => Some((end, reason)),
            Budget::Network => self
                .0
                .state
                .lock()
                .unwrap()
                .network
                .as_ref()
                .and_then(|clock| {
                    clock
                        .started
                        .map(|started| (started + clock.remaining, ConnectError::NetworkTimeout))
                }),
        };
        local
            .filter(|(end, _)| *end < self.deadline())
            .unwrap_or((self.deadline(), ConnectError::DeadlineExceeded))
    }

    pub(crate) fn check_network(&self) -> Result<(), ConnectError> {
        self.with_active(|| ())?;
        let (end, reason) = self.next_deadline(Budget::Network);
        if Instant::now() >= end {
            return Err(self.stop(reason));
        }
        Ok(())
    }

    async fn run<F: Future>(&self, future: F, budget: Budget) -> Result<F::Output, ConnectError> {
        let mut changed = self.0.changed.subscribe();
        tokio::pin!(future);
        loop {
            self.with_active(|| ())?;
            let (end, reason) = self.next_deadline(budget);
            if Instant::now() >= end {
                return Err(self.stop(reason));
            }
            tokio::select! {
                biased;
                _ = changed.changed() => {},
                _ = tokio::time::sleep_until(end) => {},
                output = &mut future => {
                    self.with_active(|| ())?;
                    let (end, reason) = self.next_deadline(budget);
                    if Instant::now() >= end {
                        return Err(self.stop(reason));
                    }
                    return Ok(output);
                }
            }
        }
    }

    pub async fn wait_total<F: Future>(&self, future: F) -> Result<F::Output, ConnectError> {
        self.run(future, Budget::Total).await
    }

    pub(crate) async fn wait_auth<F: Future>(&self, future: F) -> Result<F::Output, ConnectError> {
        self.run(
            future,
            Budget::Until(
                Instant::now() + self.0.limits.auth,
                ConnectError::AuthTimeout,
            ),
        )
        .await
    }

    /// One cumulative DNS/TCP/banner/KEX budget. Only wait_for_tofu can pause
    /// it. Dropping this operation also clears its per-leg clock.
    pub(crate) async fn wait_network<F: Future>(
        &self,
        future: F,
    ) -> Result<F::Output, ConnectError> {
        self.with_active(|| ())?;
        {
            let mut state = self.0.state.lock().unwrap();
            if state.network.is_some() {
                return Err(ConnectError::AlreadyActive);
            }
            state.network = Some(NetworkClock {
                remaining: self.0.limits.network,
                started: Some(Instant::now()),
            });
        }
        let _guard = NetworkGuard(self.clone());
        self.run(future, Budget::Network).await
    }

    /// Scope this only around the actual user's response future. A dropped or
    /// externally shortened wait resumes the network clock through its guard.
    pub async fn wait_for_tofu<F: Future>(&self, future: F) -> Result<F::Output, ConnectError> {
        self.wait_for_tofu_until(self.tofu_deadline(), future).await
    }

    /// Use the same absolute end as the visible prompt. Expiry remains a typed
    /// terminal TOFU timeout instead of becoming a normal false policy result.
    pub async fn wait_for_tofu_until<F: Future>(
        &self,
        deadline: Instant,
        future: F,
    ) -> Result<F::Output, ConnectError> {
        let deadline = deadline.min(self.tofu_deadline());
        self.with_active(|| ())?;
        {
            let mut state = self.0.state.lock().unwrap();
            if state.tofu_waiting {
                return Err(ConnectError::AlreadyActive);
            }
            // Use one instant for expiry and subtraction: a second elapsed()
            // could cross the boundary and pause an already exhausted budget.
            let now = Instant::now();
            if state.network.as_ref().is_some_and(|clock| {
                clock
                    .started
                    .is_some_and(|started| now.duration_since(started) >= clock.remaining)
            }) {
                let reason = *state.stopped.get_or_insert(ConnectError::NetworkTimeout);
                drop(state);
                self.0.changed.send_replace(());
                return Err(reason);
            }
            state.tofu_waiting = true;
            if let Some(clock) = &mut state.network {
                if let Some(started) = clock.started.take() {
                    clock.remaining = clock.remaining.saturating_sub(now.duration_since(started));
                }
            }
        }
        let _guard = TofuGuard(self.clone());
        self.0.changed.send_replace(());
        self.run(future, Budget::Until(deadline, ConnectError::TofuTimeout))
            .await
    }
}

impl Default for ConnectControl {
    fn default() -> Self {
        Self::new(ConnectLimits::default())
    }
}

struct NetworkGuard(ConnectControl);
impl Drop for NetworkGuard {
    fn drop(&mut self) {
        self.0 .0.state.lock().unwrap().network = None;
        self.0 .0.changed.send_replace(());
    }
}

struct TofuGuard(ConnectControl);
impl Drop for TofuGuard {
    fn drop(&mut self) {
        let mut state = self.0 .0.state.lock().unwrap();
        state.tofu_waiting = false;
        if let Some(clock) = &mut state.network {
            clock.started = Some(Instant::now());
        }
        drop(state);
        self.0 .0.changed.send_replace(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> ConnectLimits {
        ConnectLimits {
            total: Duration::from_secs(2),
            network: Duration::from_millis(80),
            auth: Duration::from_millis(80),
            tofu: Duration::from_millis(500),
        }
    }

    #[tokio::test]
    async fn connect_control_cancel_is_sticky_and_rejects_decision_and_wait() {
        let control = ConnectControl::new(limits());
        control.cancel();
        control.cancelled().await;
        assert!(control.is_cancelled());
        assert_eq!(
            control.with_active(|| panic!("late decision")),
            Err::<(), _>(ConnectError::Cancelled)
        );
        assert_eq!(
            control.wait_total(std::future::ready(1)).await,
            Err(ConnectError::Cancelled)
        );
    }

    #[tokio::test]
    async fn connect_control_expired_reservation_never_polls_work() {
        let control = ConnectControl::with_deadline(Instant::now(), limits());
        let result = control
            .wait_total(async { panic!("expired work was polled") })
            .await;
        assert_eq!(result, Err::<(), _>(ConnectError::DeadlineExceeded));
        control.cancel();
        assert_eq!(
            control.with_active(|| ()),
            Err(ConnectError::DeadlineExceeded)
        );
        control.cancelled().await;
    }

    #[tokio::test]
    async fn connect_control_tofu_wait_pauses_network_but_not_total() {
        let control = ConnectControl::new(limits());
        let result = control
            .wait_network(async {
                control
                    .wait_for_tofu(tokio::time::sleep(Duration::from_millis(150)))
                    .await?;
                Ok::<_, ConnectError>(7)
            })
            .await;
        assert_eq!(result, Ok(Ok(7)));

        let control =
            ConnectControl::with_deadline(Instant::now() + Duration::from_millis(80), limits());
        let result = control
            .wait_network(control.wait_for_tofu(std::future::pending::<()>()))
            .await;
        assert_eq!(result, Err(ConnectError::DeadlineExceeded));
    }

    #[tokio::test]
    async fn connect_control_shortened_tofu_scope_resumes_the_remaining_network_budget() {
        let control = ConnectControl::new(limits());
        let result = control
            .wait_network(async {
                assert!(tokio::time::timeout(
                    Duration::from_millis(150),
                    control.wait_for_tofu(std::future::pending::<()>())
                )
                .await
                .is_err());
                std::future::pending::<()>().await;
            })
            .await;
        assert_eq!(result, Err(ConnectError::NetworkTimeout));
    }

    #[tokio::test]
    async fn connect_control_tofu_timeout_is_preserved_across_policy_false() {
        let mut short = limits();
        short.tofu = Duration::from_millis(40);
        let control = ConnectControl::new(short);
        let result = control
            .wait_network(async {
                control
                    .wait_for_tofu(std::future::pending::<()>())
                    .await
                    .is_ok()
            })
            .await;
        assert_eq!(result, Err(ConnectError::TofuTimeout));
    }

    #[tokio::test]
    async fn connect_control_expired_network_cannot_enter_or_extend_a_tofu_wait() {
        let control = ConnectControl::new(limits());
        let entered = std::sync::atomic::AtomicBool::new(false);
        let result = control
            .wait_network(async {
                // A synchronous callback segment can cross the network deadline
                // before the enclosing timer gets polled again. TOFU entry itself
                // must reject it without ever polling the response/prompt future.
                std::thread::sleep(Duration::from_millis(110));
                let result = control
                    .wait_for_tofu(async {
                        entered.store(true, std::sync::atomic::Ordering::SeqCst);
                    })
                    .await;
                assert_eq!(result, Err(ConnectError::NetworkTimeout));
            })
            .await;
        assert_eq!(result, Err(ConnectError::NetworkTimeout));
        assert!(!entered.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// Der Text, den der Nutzer liest, wenn seine Bestaetigung des
    /// Hostschluessels nicht rechtzeitig kam (UX-Ueberarbeitung, Spec §10):
    /// gleiche Form wie der Text zur abgelehnten Rueckfrage. Der Code
    /// `connect_timeout` entsteht in `commands.rs` aus dem Typ.
    #[test]
    fn an_expired_host_key_confirmation_reads_as_not_confirmed_in_time() {
        assert_eq!(
            ConnectError::TofuTimeout.to_string(),
            "The host key wasn't confirmed in time, so aidevbridge didn't connect."
        );
    }

    #[tokio::test]
    async fn connect_control_prompt_absolute_end_keeps_shorter_tofu_timeout_typed() {
        let control = ConnectControl::new(limits());
        let prompt_end = Instant::now() + Duration::from_millis(35);
        let result = control
            .wait_network(async {
                control
                    .wait_for_tofu_until(prompt_end, std::future::pending::<bool>())
                    .await
                    .unwrap_or(false)
            })
            .await;
        assert_eq!(result, Err(ConnectError::TofuTimeout));
        assert_eq!(control.with_active(|| ()), Err(ConnectError::TofuTimeout));
    }
}
