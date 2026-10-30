// AgentBridge local modifications to russh 0.65.0, 2026-09-12.
// Apache-2.0, the same license as russh. No message sender is retained here.
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

/// Sticky observations from a locally opened client channel's dispatcher.
/// These facts neither acknowledge cleanup nor prove remote liveness.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ChannelEndSnapshot {
    pub remote_eof: bool,
    /// The first decoded exit status, including zero.
    pub exit_status: Option<u32>,
    pub exit_signal: bool,
    pub remote_close: bool,
    pub transport_ended: bool,
    /// The unique dispatcher route was dropped, independently of sender clones.
    pub dispatch_route_gone: bool,
}

impl ChannelEndSnapshot {
    pub fn has_end(&self) -> bool {
        self.remote_eof
            || self.exit_status.is_some()
            || self.exit_signal
            || self.remote_close
            || self.transport_ended
            || self.dispatch_route_gone
    }
}

#[derive(Debug, Default)]
struct State {
    snapshot: Mutex<ChannelEndSnapshot>,
    changed: Notify,
}

impl State {
    fn lock(&self) -> MutexGuard<'_, ChannelEndSnapshot> {
        // A caller's admission closure can panic, but cannot mutate the
        // snapshot. Recover that intact state so route/session Drop cannot
        // panic again while unwinding; no remote fact is invented.
        self.snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A sender-free observer. Cloning it cannot keep a channel or session alive.
#[derive(Clone, Debug)]
pub struct ChannelEndObserver(Arc<State>);

impl ChannelEndObserver {
    pub fn snapshot(&self) -> ChannelEndSnapshot {
        *self.0.lock()
    }

    /// Orders a short synchronous admission with dispatcher end observations.
    /// The closure must not await, block, or re-enter this observer.
    /// A successful admission is not evidence that the remote process stays alive.
    pub fn with_no_end<T>(&self, action: impl FnOnce() -> T) -> Result<T, ChannelEndSnapshot> {
        let state = self.0.lock();
        if state.has_end() {
            return Err(*state);
        }
        let result = action();
        drop(state);
        Ok(result)
    }

    /// Waits for any sticky end observation, not for channel-owner cleanup.
    pub async fn wait_ended(&self) -> ChannelEndSnapshot {
        loop {
            let notified = self.0.changed.notified();
            tokio::pin!(notified);
            // Register before the snapshot: an intervening notify is not lost.
            notified.as_mut().enable();
            let state = self.snapshot();
            if state.has_end() {
                return state;
            }
            notified.await;
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ChannelEndEvent {
    Eof,
    ExitStatus(u32),
    ExitSignal,
    Close,
    TransportEnded,
}

/// Unique producer, moved with ChannelRef. Observers do not own this value.
#[derive(Debug)]
pub(super) struct ChannelEndWriter(ChannelEndObserver);

impl ChannelEndWriter {
    pub(super) fn new() -> Self {
        Self(ChannelEndObserver(Arc::new(State::default())))
    }

    pub(super) fn observer(&self) -> ChannelEndObserver {
        self.0.clone()
    }

    fn update(&self, update: impl FnOnce(&mut ChannelEndSnapshot)) {
        {
            let mut state = self.0.0.lock();
            update(&mut state);
        }
        // Waking another task never happens while holding the state mutex.
        self.0.0.changed.notify_waiters();
    }

    pub(super) fn record(&self, event: ChannelEndEvent) {
        self.update(|state| match event {
            ChannelEndEvent::Eof => state.remote_eof = true,
            ChannelEndEvent::ExitStatus(code) => {
                state.exit_status.get_or_insert(code);
            }
            ChannelEndEvent::ExitSignal => state.exit_signal = true,
            ChannelEndEvent::Close => state.remote_close = true,
            ChannelEndEvent::TransportEnded => state.transport_ended = true,
        });
    }
}

impl Drop for ChannelEndWriter {
    fn drop(&mut self) {
        self.update(|state| state.dispatch_route_gone = true);
    }
}
