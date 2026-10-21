//! Absolute operation deadline plus explicit cancellation, shared across phases.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OperationError {
    #[error("Operation cancelled.")]
    Cancelled,
    #[error("Operation timed out.")]
    Timeout,
}

struct Inner {
    deadline: Instant,
    stopped: Mutex<Option<OperationError>>,
    changed: watch::Sender<()>,
}

#[derive(Clone)]
pub struct OperationControl(Arc<Inner>);

impl OperationControl {
    pub fn new(timeout: Duration) -> Self {
        Self::with_deadline(Instant::now() + timeout)
    }

    pub fn with_deadline(deadline: Instant) -> Self {
        let (changed, _) = watch::channel(());
        Self(Arc::new(Inner {
            deadline,
            stopped: Mutex::new(None),
            changed,
        }))
    }

    pub fn deadline(&self) -> Instant {
        self.0.deadline
    }

    pub fn cancel(&self) {
        self.0
            .stopped
            .lock()
            .unwrap()
            .get_or_insert(OperationError::Cancelled);
        self.0.changed.send_replace(());
    }

    pub fn is_cancelled(&self) -> bool {
        *self.0.stopped.lock().unwrap() == Some(OperationError::Cancelled)
    }

    /// A short synchronous admission/phase transition, never IO or an await.
    pub fn with_active<T>(&self, action: impl FnOnce() -> T) -> Result<T, OperationError> {
        let mut stopped = self.0.stopped.lock().unwrap();
        if let Some(reason) = *stopped {
            return Err(reason);
        }
        if Instant::now() >= self.deadline() {
            *stopped = Some(OperationError::Timeout);
            drop(stopped);
            self.0.changed.send_replace(());
            return Err(OperationError::Timeout);
        }
        Ok(action())
    }

    pub async fn wait<F: Future>(&self, future: F) -> Result<F::Output, OperationError> {
        let mut changed = self.0.changed.subscribe();
        tokio::pin!(future);
        loop {
            self.with_active(|| ())?;
            tokio::select! {
                biased;
                _ = changed.changed() => {},
                _ = tokio::time::sleep_until(self.deadline()) => {},
                result = &mut future => {
                    self.with_active(|| ())?;
                    return Ok(result);
                }
            }
        }
    }

    /// Ends on explicit cancellation or the absolute deadline.
    pub async fn cancelled(&self) {
        let _ = self.wait(std::future::pending::<()>()).await;
    }

    /// Keep this lease in the caller future, not in the actor. A normal child
    /// return must disarm it so a shared parent command can run its next phase.
    pub fn caller_lease(&self) -> CallerLease {
        CallerLease(Some(self.clone()))
    }
}

pub struct CallerLease(Option<OperationControl>);

impl CallerLease {
    pub fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for CallerLease {
    fn drop(&mut self) {
        if let Some(control) = &self.0 {
            control.cancel();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Submission {
    NotSubmitted,
    PossiblySubmitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecPhase {
    Admission,
    Open,
    Send,
    Eof,
    Read,
}

impl ExecPhase {
    /// Die Phase als Wort fuer Meldungen, nie als Debug-Ausgabe.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admission => "admission",
            Self::Open => "open",
            Self::Send => "send",
            Self::Eof => "eof",
            Self::Read => "read",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecReason {
    Cancelled,
    Timeout,
    Unavailable,
    Capacity,
    Rejected,
    Transport,
    OutputLimit,
    MissingExitStatus,
}

impl ExecReason {
    /// Der Grund als Wort fuer Meldungen, nie als Debug-Ausgabe.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
            Self::Capacity => "capacity",
            Self::Rejected => "rejected",
            Self::Transport => "transport",
            Self::OutputLimit => "output limit",
            Self::MissingExitStatus => "missing exit status",
        }
    }
}

impl From<OperationError> for ExecReason {
    fn from(error: OperationError) -> Self {
        match error {
            OperationError::Cancelled => Self::Cancelled,
            OperationError::Timeout => Self::Timeout,
        }
    }
}

/// Die Anzeige ist ein ganzer Satz mit Phase und Grund als Woertern: Sie steht
/// sichtbar am Ende des Satzes zu `outcome_unknown` und im Hinweis auf ein
/// unbestaetigtes Beenden. `submission` bleibt fuer die Auswertung im Code
/// und erscheint nicht im Text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("The SSH command failed ({}, {}).", .phase.as_str(), .reason.as_str())]
pub struct ExecError {
    pub phase: ExecPhase,
    pub reason: ExecReason,
    pub submission: Submission,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyPhase {
    Admission,
    Open,
    Request,
    Attach,
    Forward,
    Input,
    Resize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyReason {
    Cancelled,
    Timeout,
    Unavailable,
    Capacity,
    Rejected,
    Transport,
    OutputLimit,
}

impl From<OperationError> for PtyReason {
    fn from(error: OperationError) -> Self {
        match error {
            OperationError::Cancelled => Self::Cancelled,
            OperationError::Timeout => Self::Timeout,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Terminal operation failed during {phase:?}: {reason:?}")]
pub struct PtyError {
    pub phase: PtyPhase,
    pub reason: PtyReason,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_completed_child_lease_does_not_cancel_the_parent_operation() {
        let control = OperationControl::new(Duration::from_secs(1));
        {
            let mut lease = control.caller_lease();
            lease.disarm();
        }
        assert_eq!(control.wait(std::future::ready(7)).await, Ok(7));
        drop(control.caller_lease());
        assert_eq!(
            control.wait(std::future::ready(8)).await,
            Err(OperationError::Cancelled)
        );
    }

    #[test]
    fn exec_errors_read_as_a_sentence_with_phase_and_reason_in_words() {
        let error = |phase, reason, submission| ExecError {
            phase,
            reason,
            submission,
        };
        assert_eq!(
            error(
                ExecPhase::Read,
                ExecReason::Timeout,
                Submission::PossiblySubmitted
            )
            .to_string(),
            "The SSH command failed (read, timeout)."
        );
        assert_eq!(
            error(
                ExecPhase::Admission,
                ExecReason::Unavailable,
                Submission::NotSubmitted
            )
            .to_string(),
            "The SSH command failed (admission, unavailable)."
        );
        assert_eq!(
            error(
                ExecPhase::Read,
                ExecReason::MissingExitStatus,
                Submission::PossiblySubmitted
            )
            .to_string(),
            "The SSH command failed (read, missing exit status)."
        );
        // Spec 2026-10-19 §8.3: diesen Rohtext erkennt das Frontend als
        // Kanalgrenze (`CAPACITY_ERRORS` in `src/views/grid.ts`).
        assert_eq!(
            error(
                ExecPhase::Admission,
                ExecReason::Capacity,
                Submission::NotSubmitted
            )
            .to_string(),
            "The SSH command failed (admission, capacity)."
        );
    }

    #[tokio::test]
    async fn expired_operations_never_poll_a_later_phase() {
        let control = OperationControl::with_deadline(Instant::now());
        let result = control
            .wait(async { panic!("expired operation polled") })
            .await;
        assert_eq!(result, Err::<(), _>(OperationError::Timeout));
    }
}
