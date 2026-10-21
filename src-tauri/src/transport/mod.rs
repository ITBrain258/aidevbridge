pub mod abortable_io;
pub mod connect_control;
pub mod operation_control;
pub mod russh_transport;

pub use connect_control::{ConnectControl, ConnectError, ConnectLimits};
pub use operation_control::{
    ExecError, ExecPhase, ExecReason, OperationControl, OperationError, PtyError, PtyPhase,
    PtyReason, Submission,
};

use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct ExecResult {
    /// Whether both complete byte streams were valid UTF-8 before display
    /// conversion. Identity parsers must reject false; the actual exit status
    /// and existing display strings remain available to other callers.
    pub utf8_valid: bool,
    pub stdout: String,
    pub stderr: String,
    pub code: u32,
}

/// Beschreibt nur noch das "Wo" (Host, Port, Login-Name). Das "Wie"
/// (Schluessel/Agent/Passwort) ist seit Task 6 eigenstaendig in
/// `crate::ssh::auth::AuthMethod` -- vorher trug dieser Typ zusaetzlich
/// einen festen `key_path`, der mit drei Auth-Wegen nicht mehr ausreicht.
#[derive(Debug, Clone)]
pub struct HostSpec {
    pub hostname: String,
    pub port: u16,
    pub user: String,
}

/// Entscheidet ueber einen Host-Key. Bewusst ein eigener Trait, damit
/// `RusshTransport` ohne Entscheider gar nicht gebaut werden kann (Spec §4.3).
#[async_trait]
pub trait HostKeyPolicy: Send + Sync {
    async fn decide(&self, host: &str, port: u16, key_type: &str, key_b64: &str) -> bool;
}

#[async_trait]
pub trait Transport: Send + Sync {
    async fn exec_with_deadline(
        &self,
        line: &str,
        timeout: std::time::Duration,
    ) -> anyhow::Result<ExecResult>;
    async fn exec(&self, line: &str) -> anyhow::Result<ExecResult> {
        self.exec_with_deadline(line, std::time::Duration::from_secs(15))
            .await
    }
    async fn exec_mutation(&self, line: &str) -> anyhow::Result<ExecResult> {
        self.exec(line).await
    }
    async fn dispose(&self);
}

// Kein PTY-Kanal im `Transport`-Trait: `open_attach` ist bewusst eine
// INHAERENTE Methode von `RusshTransport`. Der Trait bleibt auf
// exec/dispose beschraenkt, damit ein spaeteres zweites Backend ihn
// erfuellen kann, ohne PTY-Semantik nachzubauen -- deshalb hier nur ein
// Re-Export von `PtyHandle`, keine Trait-Erweiterung.
pub use russh_transport::{PendingPty, PtyHandle, RusshTransport};
