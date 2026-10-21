// AgentBridge local modifications to russh 0.63.2, 2026-10-21.
// Apache-2.0, the same license as russh.

//! Manual receive window for locally opened client session channels.
//!
//! Such a channel advertises a fixed window and, unlike every other channel,
//! does not enlarge it when data arrives. The application returns the bytes
//! it has consumed through [`WindowCredit`]; the session sends them to the
//! peer as `SSH_MSG_CHANNEL_WINDOW_ADJUST`, never beyond the advertised size.
//! A peer therefore never has more than one window of data outstanding.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

/// Credit below this many bytes waits for more; a quarter of a smaller window.
const CREDIT_STEP: u32 = 32 * 1024;

/// Session side of a manual window: its size and the returned credit that
/// the session has not yet sent.
#[derive(Debug, Clone)]
pub(crate) struct ManualWindow {
    size: u32,
    pending: Arc<AtomicU32>,
}

impl ManualWindow {
    pub(crate) fn new(size: u32) -> Self {
        Self {
            size,
            pending: Arc::new(AtomicU32::new(0)),
        }
    }

    pub(crate) fn size(&self) -> u32 {
        self.size
    }

    /// Takes all credit returned so far.
    pub(crate) fn take(&self) -> u32 {
        self.pending.swap(0, Ordering::AcqRel)
    }

    /// The application side. `wake` asks the session to send the credit; it
    /// must not block.
    pub(crate) fn credit(&self, wake: impl Fn() + Send + Sync + 'static) -> WindowCredit {
        WindowCredit {
            pending: self.pending.clone(),
            step: (self.size / 4).clamp(1, CREDIT_STEP),
            wake: Arc::new(wake),
        }
    }
}

/// Returns consumed bytes of a channel opened with
/// [`Handle::channel_open_session_manual_window`](crate::client::Handle::channel_open_session_manual_window).
///
/// Credits accumulate until at least a quarter of the window or 32 KiB is
/// pending, whichever is less; then the session sends one window adjustment
/// for all of it. Only one such request is outstanding per channel.
#[derive(Clone)]
pub struct WindowCredit {
    pending: Arc<AtomicU32>,
    step: u32,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl WindowCredit {
    /// Returns `bytes` that the application has consumed. Never blocks or
    /// awaits; after the channel or the session has ended it does nothing.
    pub fn credit(&self, bytes: usize) {
        let bytes = u32::try_from(bytes).unwrap_or(u32::MAX);
        if bytes == 0 {
            return;
        }
        let added = |pending: u32| Some(pending.saturating_add(bytes));
        let before = self
            .pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, added)
            .unwrap_or_else(|pending| pending);
        // Wake only when crossing the step: until the session takes the
        // credit, the pending amount stays at or above it.
        if before < self.step && before.saturating_add(bytes) >= self.step {
            (self.wake)();
        }
    }
}

impl std::fmt::Debug for WindowCredit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WindowCredit")
            .field("pending", &self.pending.load(Ordering::Acquire))
            .field("step", &self.step)
            .finish()
    }
}
