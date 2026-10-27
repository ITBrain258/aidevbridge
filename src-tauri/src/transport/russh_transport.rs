use super::abortable_io::{AbortHandle, AbortableIo};
use super::OperationControl;
use super::{ConnectControl, ConnectError, ExecResult, HostKeyPolicy, HostSpec, Transport};
use crate::ssh::auth::{
    authenticate_prepared, prepare_auth_owned, prepare_auth_pair_owned, AuthError, AuthMethod,
    PreparedAuth,
};
use crate::tmux::OwnSocket;
use anyhow::Context;
use async_trait::async_trait;
use russh::client::{self, Handle, Msg};
use russh::keys::PublicKeyBase64;
use russh::{ChannelMsg, Sig};
use std::future::Future;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, LazyLock};
use tokio::net::TcpStream;
use tokio::sync::{watch, Semaphore};
mod owned_operations;
mod pty_output;
use owned_operations::Operations;
pub use owned_operations::{PendingPty, PtyHandle};
pub use pty_output::PtyOutputReceiver;

/// Fuer Tests, die das Warten auf einen Kanalplatz messen (auch in `commands`).
#[cfg(test)]
pub(crate) use owned_operations::SLOT_WAIT;

// Admission includes queued and running jobs. Permits move into spawn_blocking
// so cancellation cannot create unbounded detached key/KDF or resolver work.
struct BlockingPool {
    admitted: Arc<Semaphore>,
    workers: Arc<Semaphore>,
}

static PREPARATION_POOL: LazyLock<BlockingPool> = LazyLock::new(|| BlockingPool::new(2, 8));
static RESOLVER_POOL: LazyLock<BlockingPool> = LazyLock::new(|| BlockingPool::new(2, 8));

impl BlockingPool {
    fn new(workers: usize, admitted: usize) -> Self {
        Self {
            admitted: Arc::new(Semaphore::new(admitted)),
            workers: Arc::new(Semaphore::new(workers)),
        }
    }

    async fn prepare<P>(
        &self,
        method: AuthMethod,
        control: &ConnectControl,
        prepare: P,
    ) -> anyhow::Result<PreparedAuth>
    where
        P: FnOnce(AuthMethod) -> Result<PreparedAuth, AuthError> + Send + 'static,
    {
        self.run(
            control,
            ConnectError::PreparationBusy,
            ConnectError::PreparationFailed,
            move || prepare(method).map_err(anyhow::Error::from),
        )
        .await
    }

    async fn run<T, F>(
        &self,
        control: &ConnectControl,
        busy: ConnectError,
        failed: ConnectError,
        work: F,
    ) -> anyhow::Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    {
        control.with_active(|| ())?;
        let admission = self
            .admitted
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy)?;
        let worker = control
            .wait_total(self.workers.clone().acquire_owned())
            .await?
            .map_err(|_| failed)?;
        let worker_control = control.clone();
        let job = tokio::task::spawn_blocking(move || {
            let (_admission, _worker) = (admission, worker);
            worker_control.with_active(|| ())?;
            work()
        });
        control.wait_total(job).await?.map_err(|_| failed)?
    }
}

/// DNS runs only in a retained-capacity worker; that closure never owns a TCP
/// connector. Addresses keep std/Tokio's original order and sequential fallback.
/// The caller includes this entire function in the single network budget.
async fn resolve_and_connect<R, C, CF>(
    spec: &HostSpec,
    control: &ConnectControl,
    pool: &BlockingPool,
    resolve: R,
    mut connect: C,
) -> anyhow::Result<TcpStream>
where
    R: FnOnce(String, u16) -> std::io::Result<Vec<SocketAddr>> + Send + 'static,
    C: FnMut(SocketAddr) -> CF,
    CF: Future<Output = std::io::Result<TcpStream>>,
{
    control.check_network()?;
    let addresses = if let Ok(ip) = spec.hostname.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, spec.port)]
    } else {
        let host = spec.hostname.clone();
        let port = spec.port;
        pool.run(
            control,
            ConnectError::NetworkCapacity,
            ConnectError::ResolverFailed,
            move || resolve(host, port).context(AuthError::HostUnreachable),
        )
        .await?
    };
    let mut last_error = None;
    for address in addresses {
        control.check_network()?;
        match connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "could not resolve to any address",
        )
    }))
    .context(AuthError::HostUnreachable)
}

fn resolve_hostname(host: String, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    (host.as_str(), port)
        .to_socket_addrs()
        .map(Iterator::collect)
}

struct AttemptGuard(Option<ConnectControl>);
impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if let Some(control) = &self.0 {
            control.cancel();
        }
    }
}

struct Handler {
    host: String,
    port: u16,
    policy: Arc<dyn HostKeyPolicy>,
    control: ConnectControl,
    ended: watch::Sender<bool>,
}

impl Drop for Handler {
    fn drop(&mut self) {
        self.ended.send_replace(true);
    }
}

impl client::Handler for Handler {
    type Error = russh::Error;

    /// russh lehnt in der Standardimplementierung ALLE Keys ab (Spec V20).
    /// Wir ueberschreiben bewusst und delegieren an die Policy — niemals
    /// bedingungslos `Ok(true)` zurueckgeben.
    ///
    /// Seit russh 0.63 (Task 5b) uebergibt der Trait
    /// `&PublicKeyOrCertificate` statt `&PublicKey` -- der Server koennte
    /// statt eines blossen Schluessels ein SSH-Zertifikat vorweisen.
    /// Zertifikate sind kein Auth-Weg dieser App (Spec 8.4): der Zweig
    /// liefert `Ok(false)`, niemals blind akzeptieren (V20). Der
    /// `PublicKey`-Variantenname ist unveraendert, nur ihre Form wechselte
    /// von einer Tupel-Variante `PublicKey(key)` (0.62) zu einer
    /// Struct-Variante `PublicKey { key, hash_alg }` (0.63, siehe
    /// russh-0.63.2/src/cert.rs) -- `hash_alg` ist der fuer die
    /// Signaturpruefung ausgehandelte RSA-Hash und fuer die
    /// Host-Key-Entscheidung hier irrelevant.
    ///
    /// russh 0.63.2 ruft diese Methode nur beim ersten Schluesselaustausch
    /// einer Verbindung. Bei einem Rekey prueft es den Hostschluessel nicht
    /// erneut; das ist eine bewusst hingenommene Grenze (siehe SECURITY.md).
    /// Ruft ein kuenftiges russh sie auch beim Rekey, muessen die Policy und
    /// das Zeitbudget aus `wait_total` neu entworfen werden: beide gehoeren
    /// zum Verbindungsversuch, dessen Frist dann laengst abgelaufen ist, und
    /// jede lange Sitzung endete bei ihrem ersten Rekey. Der Rekey-Test in
    /// `russh_transport/connect_tests.rs` faellt in diesem Fall auf.
    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = server_public_key else {
            return Ok(false);
        };
        let key_type = key.algorithm().to_string();
        let key_b64 = key.public_key_base64();
        self.control
            .wait_total(
                self.policy
                    .decide(&self.host, self.port, &key_type, &key_b64),
            )
            .await
            .map_err(|_| russh::Error::Disconnect)
    }
}

pub struct RusshTransport {
    operations: Operations,
}

impl RusshTransport {
    pub(crate) async fn prepare_pair(
        method: AuthMethod,
        control: &ConnectControl,
    ) -> anyhow::Result<(PreparedAuth, PreparedAuth)> {
        PREPARATION_POOL
            .run(
                control,
                ConnectError::PreparationBusy,
                ConnectError::PreparationFailed,
                move || prepare_auth_pair_owned(method).map_err(anyhow::Error::from),
            )
            .await
    }

    pub(crate) async fn connect_prepared_controlled(
        spec: &HostSpec,
        policy: Arc<dyn HostKeyPolicy>,
        prepared: PreparedAuth,
        control: ConnectControl,
    ) -> anyhow::Result<Self> {
        let resolver_control = control.clone();
        Self::connect_prepared_with(spec, policy, prepared, control, || {
            resolve_and_connect(
                spec,
                &resolver_control,
                &RESOLVER_POOL,
                resolve_hostname,
                TcpStream::connect,
            )
        })
        .await
    }
    /// Compatibility entry point. Production reservations pass owned credentials
    /// and their already-started control to connect_controlled instead.
    pub async fn connect(
        spec: &HostSpec,
        policy: Arc<dyn HostKeyPolicy>,
        method: &AuthMethod,
    ) -> anyhow::Result<Self> {
        Self::connect_controlled(spec, policy, method.clone(), ConnectControl::default()).await
    }

    pub async fn connect_controlled(
        spec: &HostSpec,
        policy: Arc<dyn HostKeyPolicy>,
        method: AuthMethod,
        control: ConnectControl,
    ) -> anyhow::Result<Self> {
        let resolver_control = control.clone();
        Self::connect_with(
            spec,
            policy,
            method,
            control,
            &PREPARATION_POOL,
            prepare_auth_owned,
            || {
                resolve_and_connect(
                    spec,
                    &resolver_control,
                    &RESOLVER_POOL,
                    resolve_hostname,
                    TcpStream::connect,
                )
            },
        )
        .await
    }

    // Both preparation and TCP injection retain the actual product ownership,
    // budget, AbortableIo, russh handler and authentication path in hermetic tests.
    async fn connect_with<P, C, CF, E>(
        spec: &HostSpec,
        policy: Arc<dyn HostKeyPolicy>,
        method: AuthMethod,
        control: ConnectControl,
        pool: &BlockingPool,
        prepare: P,
        connect: C,
    ) -> anyhow::Result<Self>
    where
        P: FnOnce(AuthMethod) -> Result<PreparedAuth, AuthError> + Send + 'static,
        C: FnOnce() -> CF,
        CF: Future<Output = Result<TcpStream, E>>,
        E: Into<anyhow::Error>,
    {
        let mut attempt = AttemptGuard(Some(control.clone()));
        let result = async {
            // A late blocking result has no connector and can only be dropped.
            let prepared = pool.prepare(method, &control, prepare).await?;
            Self::connect_prepared_with(spec, policy, prepared, control.clone(), connect).await
        }
        .await;
        attempt.0 = None;
        result
    }

    async fn connect_prepared_with<C, CF, E>(
        spec: &HostSpec,
        policy: Arc<dyn HostKeyPolicy>,
        prepared: PreparedAuth,
        control: ConnectControl,
        connect: C,
    ) -> anyhow::Result<Self>
    where
        C: FnOnce() -> CF,
        CF: Future<Output = Result<TcpStream, E>>,
        E: Into<anyhow::Error>,
    {
        let mut attempt = AttemptGuard(Some(control.clone()));
        let result = async {
            let config = Arc::new(client::Config {
                keepalive_interval: Some(std::time::Duration::from_secs(15)),
                inactivity_timeout: None,
                ..Default::default()
            });
            let (ended, end_receiver) = watch::channel(false);
            let handler = Handler {
                host: spec.hostname.clone(),
                port: spec.port,
                policy,
                control: control.clone(),
                ended,
            };
            let mut abort = None;
            let mut handle = control
                .wait_network(async {
                    let tcp = connect()
                        .await
                        .map_err(Into::into)
                        .context(AuthError::HostUnreachable)?;
                    let (io, owner) =
                        AbortableIo::from_tcp_stream(tcp).context(AuthError::HostUnreachable)?;
                    abort = Some(owner);
                    client::connect_stream(config, io, handler)
                        .await
                        .context(AuthError::HostUnreachable)
                })
                .await??;
            // One auth budget covers all agent identities, hash negotiation,
            // signer callbacks and password/server responses without resets.
            control
                .wait_auth(authenticate_prepared(&mut handle, &spec.user, prepared))
                .await??;
            control.with_active(|| ())?;
            Ok(Self {
                operations: Operations::new(
                    handle,
                    abort.expect("connected stream owns its abort handle"),
                    end_receiver,
                ),
            })
        }
        .await;
        // Ordinary errors preserve their AuthError/source classification. A
        // dropped pending future instead cancels any waiting policy callback.
        attempt.0 = None;
        result
    }

    #[cfg(test)]
    async fn connect_using<C, CF>(
        spec: &HostSpec,
        policy: Arc<dyn HostKeyPolicy>,
        method: &AuthMethod,
        connect: C,
    ) -> anyhow::Result<Self>
    where
        C: FnOnce() -> CF,
        CF: Future<Output = std::io::Result<TcpStream>>,
    {
        Self::connect_with(
            spec,
            policy,
            method.clone(),
            ConnectControl::default(),
            &PREPARATION_POOL,
            prepare_auth_owned,
            connect,
        )
        .await
    }

    /// Haengt sich mit fester 15-s-Frist an `session` an. Nur fuer Tests
    /// (`tests/integration_pty.rs`, `connection/tests.rs`); die App selbst
    /// geht in `open_terminal_with_history` (`commands.rs`) ueber
    /// `open_attach_pending` (gebundener Attach) oder `open_attach_controlled`.
    /// Kein `#[cfg(test)]`: Integrationstests bauen die Bibliothek ohne
    /// `cfg(test)`.
    pub async fn open_attach(
        &self,
        socket: &OwnSocket,
        session: &str,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<PtyHandle> {
        self.open_attach_controlled(
            socket,
            session,
            cols,
            rows,
            OperationControl::new(std::time::Duration::from_secs(15)),
        )
        .await
    }

    pub async fn open_attach_controlled(
        &self,
        socket: &OwnSocket,
        session: &str,
        cols: u16,
        rows: u16,
        control: OperationControl,
    ) -> anyhow::Result<PtyHandle> {
        self.operations
            .open_attach(attach_command_line(socket, session), cols, rows, control)
            .await
    }

    pub async fn open_attach_pending(
        &self,
        line: String,
        cols: u16,
        rows: u16,
        control: OperationControl,
        nonce: Option<&str>,
    ) -> anyhow::Result<PendingPty> {
        self.operations
            .open_attach_pending(line, cols, rows, control, nonce)
            .await
    }

    #[cfg(test)]
    pub async fn open_attach_pending_controlled(
        &self,
        socket: &OwnSocket,
        session: &str,
        cols: u16,
        rows: u16,
        control: OperationControl,
    ) -> anyhow::Result<PendingPty> {
        self.open_attach_pending(
            attach_command_line(socket, session),
            cols,
            rows,
            control,
            None,
        )
        .await
    }

    pub async fn exec_controlled(
        &self,
        line: &str,
        control: OperationControl,
    ) -> anyhow::Result<ExecResult> {
        self.operations.exec(line.to_owned(), control).await
    }

    pub fn is_usable(&self) -> bool {
        self.operations.is_usable()
    }
    pub fn abort(&self) {
        self.operations.abort();
    }
    /// Observes the actual russh handler's end, not a requested abort or PTY end.
    pub async fn closed(&self) {
        self.operations.closed().await;
    }
}
/// Baut die Kommandozeile fuer `tmux attach`.
///
/// Bewusst aus `open_attach` herausgezogen: dort ist sie nur mit einem
/// echten russh-`Handle` erreichbar, also nur gegen die VM pruefbar. In
/// einem Lauf ohne VM waere das `=` unten damit voellig ungeschuetzt.
///
/// Das `=` erzwingt einen EXAKTEN Treffer. Ohne es loest tmux ein `-t`-Ziel
/// per Praefix auf -- `attach -t dev` haengt sich an `dev2`, wenn `dev`
/// nicht existiert. Beim Anhaengen ist der Schaden noch groesser als beim
/// Beenden: der Nutzer tippt dann in die Sitzung eines fremden Projekts,
/// waehrend die Oberflaeche den von ihm gewaehlten Namen anzeigt. Siehe
/// `TmuxClient::kill_session` fuer die Messung und fuer den Preis.
///
/// Davor schaltet derselbe tmux-Aufruf die Statuszeile aus
/// (`crate::tmux::HIDE_STATUS`).
fn attach_command_line(socket: &OwnSocket, session: &str) -> String {
    let target = format!("={session}");
    let mut argv = vec!["tmux"];
    argv.extend_from_slice(&socket.args());
    argv.extend_from_slice(&crate::tmux::HIDE_STATUS);
    argv.extend_from_slice(&["attach", "-t", &target]);
    crate::remote::build(&argv)
}

#[async_trait]
impl Transport for RusshTransport {
    async fn exec_with_deadline(
        &self,
        line: &str,
        timeout: std::time::Duration,
    ) -> anyhow::Result<ExecResult> {
        self.exec_controlled(line, OperationControl::new(timeout))
            .await
    }
    async fn dispose(&self) {
        self.operations.dispose().await;
    }
}
#[cfg(test)]
mod connect_tests;
#[cfg(test)]
mod operation_tests;
#[cfg(test)]
mod rsa_tests;

/// Channel closure alone does not establish whether a remote command ran.
/// russh's Channel::wait returns None when its receiver closes, including
/// connection loss; reporting exit zero then would turn partial results into
/// successful snapshots or successful mutations.
#[derive(Debug, thiserror::Error)]
#[error("SSH command ended without an exit status; its outcome is unknown")]
pub struct ExecMissingExitStatus;

#[derive(Default)]
struct ExecOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    code: Option<u32>,
}

impl ExecOutput {
    /// Returns true only for channel close. EOF can arrive before ExitStatus.
    fn record(&mut self, msg: ChannelMsg) -> bool {
        match msg {
            ChannelMsg::Data { data } => self.stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext: 1 } => self.stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => self.code = Some(exit_status),
            // Signal termination has no ExitStatus (RFC 4254). Preserve the
            // existing POSIX 128 + signal convention instead of losing it.
            ChannelMsg::ExitSignal { signal_name, .. } => {
                self.code = Some(signal_exit_code(&signal_name));
            }
            ChannelMsg::Close => return true,
            _ => {}
        }
        false
    }

    fn finish(self) -> anyhow::Result<ExecResult> {
        let code = self.code.ok_or(ExecMissingExitStatus)?;
        Ok(ExecResult {
            utf8_valid: std::str::from_utf8(&self.stdout).is_ok()
                && std::str::from_utf8(&self.stderr).is_ok(),
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            code,
        })
    }
}

/// Bildet ein SSH-Signal (`ChannelMsg::ExitSignal`) auf seine POSIX-Nummer
/// unter Linux ab -- die einzige Zielplattform der Remote-VMs (Spec §1).
/// Genutzt fuer die `128 + Signalnummer`-Konvention in `Transport::exec`
/// (M-A, Abschlussreview): dieselbe, die `$?` in bash nach einem
/// signalbedingten Tod zeigt.
///
/// `Sig::name()`/`Sig::from_name()` sind in russh 0.62 crate-privat
/// (`lib_inner.rs`) -- deshalb bilden wir hier selbst ab, statt sie
/// wiederzuverwenden.
///
/// `Sig::Custom` deckt RFC-4254-Signalnamen ab, die russh nicht als eigene
/// Variante kennt (z. B. Realtime-Signale). Dafuer gibt es keine
/// verlaessliche Nummer -- der Rueckgabewert 0 sorgt trotzdem fuer einen von
/// 0 verschiedenen `code` (128 + 0 = 128), was fuer alle Aufrufer reicht,
/// die nur "kein Erfolg" pruefen (`TmuxClient::create_session`,
/// `TmuxClient::run_checked`).
fn posix_signal_number(sig: &Sig) -> u32 {
    match sig {
        Sig::HUP => 1,
        Sig::INT => 2,
        Sig::QUIT => 3,
        Sig::ILL => 4,
        Sig::ABRT => 6,
        Sig::FPE => 8,
        Sig::KILL => 9,
        Sig::USR1 => 10,
        Sig::SEGV => 11,
        Sig::PIPE => 13,
        Sig::ALRM => 14,
        Sig::TERM => 15,
        Sig::Custom(_) => 0,
    }
}

/// Die tatsaechlich in `Transport::exec` verwendete Funktion: `128 +
/// posix_signal_number(sig)`. Eigene Funktion statt der Ausdruck inline im
/// Match-Arm (Review-Nachtrag): eine fruehere Testfassung rechnete
/// `128 + posix_signal_number(..)` im TEST nach, statt gegen den in `exec()`
/// tatsaechlich verwendeten Wert zu pruefen -- ein Test, der die Arithmetik
/// selbst dupliziert, bleibt gruen, selbst wenn `exec()`s Match-Arm die
/// Konvention aendert oder ganz entfernt. Mit
/// dieser Funktion pruefen die Tests unten denselben Code, der auch in
/// `exec()` laeuft.
fn signal_exit_code(sig: &Sig) -> u32 {
    128 + posix_signal_number(sig)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_exec_without_exit_status_is_not_success() {
        let mut output = ExecOutput::default();
        output.record(ChannelMsg::Data {
            data: b"partial snapshot\n".as_slice().into(),
        });
        assert!(!output.record(ChannelMsg::Eof));
        assert!(output.record(ChannelMsg::Close));
        let error = output.finish().unwrap_err();
        assert!(error.downcast_ref::<ExecMissingExitStatus>().is_some());
    }

    #[test]
    fn receiver_ending_without_a_close_or_exit_status_is_not_success() {
        // Channel::wait can return None after connection loss without Close.
        let error = ExecOutput::default().finish().unwrap_err();
        assert!(error.downcast_ref::<ExecMissingExitStatus>().is_some());
    }

    #[test]
    fn exec_keeps_output_and_the_exit_status_that_arrives_after_eof() {
        for code in [0, 3] {
            let mut output = ExecOutput::default();
            output.record(ChannelMsg::Data {
                data: b"result\n".as_slice().into(),
            });
            output.record(ChannelMsg::ExtendedData {
                data: b"diagnostic\n".as_slice().into(),
                ext: 1,
            });
            assert!(!output.record(ChannelMsg::Eof));
            assert!(!output.record(ChannelMsg::ExitStatus { exit_status: code }));
            assert!(output.record(ChannelMsg::Close));
            let result = output.finish().unwrap();
            assert_eq!(result.code, code);
            assert_eq!(result.stdout, "result\n");
            assert_eq!(result.stderr, "diagnostic\n");
        }
    }

    #[test]
    fn signal_termination_is_a_known_nonzero_exec_result() {
        let mut output = ExecOutput::default();
        output.record(ChannelMsg::ExitSignal {
            signal_name: Sig::TERM,
            core_dumped: false,
            error_message: String::new(),
            lang_tag: String::new(),
        });
        output.record(ChannelMsg::Close);
        assert_eq!(output.finish().unwrap().code, 143);
    }

    /// Der zweite billige Waechter fuer B0, Gegenstueck zu
    /// `kill_session_targets_the_name_exactly_and_not_by_prefix`. Der
    /// VM-Test dazu (`integration_pty.rs`) kehrt ohne gesetztes
    /// `AIDEVBRIDGE_TEST_HOST` still zurueck und ist dann gruen, ohne etwas
    /// geprueft zu haben -- dieser hier laeuft immer.
    #[test]
    fn attach_targets_the_session_exactly_and_not_by_prefix() {
        assert_eq!(
            crate::remote::command::decoded_argv(&attach_command_line(
                &OwnSocket::new("sock").unwrap(),
                "zz_x"
            )),
            vec!["tmux", "-L", "sock", "set", "-g", "status", "off", ";", "attach", "-t", "=zz_x"],
            "ohne das `=` haengt sich tmux bei fehlendem `zz_x` an `zz_x2` an"
        );
    }

    /// Abschlussreview (Important 4), Gegenprobe zum haeufigsten Fehlerfall
    /// ueberhaupt: ein Verbindungsversuch, der schon VOR jeder
    /// Authentifizierung scheitert (falscher Hostname, ausgeschaltete VM,
    /// totes Netz), muss `AuthError::HostUnreachable` in der Fehlerkette
    /// tragen -- sonst faellt `auth_error_message` (commands.rs) auf
    /// `e.to_string()` zurueck und der Nutzer liest deutschen Text in einer
    /// verbindlich englischen Oberflaeche.
    ///
    /// Hermetisch: `127.0.0.1:1` ist auf jeder Maschine unbelegt und
    /// antwortet sofort mit RST (Connection refused) -- kein Netz, keine VM,
    /// kein `AIDEVBRIDGE_VM_HOST`. Der Timeout ist nur ein Netz, falls eine
    /// lokale Firewall das Paket doch stillschweigend verwirft, statt
    /// abzulehnen.
    ///
    /// Prueft ZUSAETZLICH, dass `anyhow` tatsaechlich auf den KONTEXTWERT
    /// downcastet (nicht nur auf die Ursache) -- daran haengt die ganze
    /// Zuordnung, und es ist eine Eigenschaft von `anyhow`, keine unserer
    /// eigenen.
    #[tokio::test]
    async fn a_failed_tcp_connect_carries_host_unreachable_in_the_error_chain() {
        struct AcceptAll;
        #[async_trait]
        impl HostKeyPolicy for AcceptAll {
            async fn decide(&self, _h: &str, _p: u16, _t: &str, _b: &str) -> bool {
                true
            }
        }

        let spec = HostSpec {
            hostname: "127.0.0.1".to_string(),
            port: 1,
            user: "irrelevant".to_string(),
        };
        let method = AuthMethod::Password(zeroize::Zeroizing::new("irrelevant".to_string()));

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            RusshTransport::connect(&spec, Arc::new(AcceptAll), &method),
        )
        .await
        .expect("Verbindungsversuch auf 127.0.0.1:1 haette sofort abgelehnt werden muessen");

        let err = match outcome {
            Ok(_) => panic!("auf 127.0.0.1:1 darf nichts lauschen"),
            Err(e) => e,
        };
        let auth = err
            .downcast_ref::<AuthError>()
            .unwrap_or_else(|| panic!("kein AuthError in der Fehlerkette: {err:#}"));
        assert!(
            matches!(auth, AuthError::HostUnreachable),
            "erwartet HostUnreachable, war {auth:?}"
        );
        // Die eigentliche Zusicherung fuer den Nutzer: KEIN deutscher Text.
        assert_eq!(
            auth.user_message(),
            "Host not reachable. Check hostname, port and network."
        );
    }

    /// Verankert die Zuordnungstabelle selbst -- ohne I/O, unabhaengig vom
    /// VM-Test. Deckt Spec §13 Ebene 1 ("Unit, ohne I/O") ab, waehrend
    /// `exec_reports_a_nonzero_code_when_the_remote_process_dies_by_signal`
    /// (tests/integration_transport.rs) den End-zu-Ende-Pfad gegen die echte
    /// VM belegt.
    #[test]
    fn posix_signal_number_matches_linux_signal_numbers() {
        assert_eq!(posix_signal_number(&Sig::HUP), 1);
        assert_eq!(posix_signal_number(&Sig::INT), 2);
        assert_eq!(posix_signal_number(&Sig::QUIT), 3);
        assert_eq!(posix_signal_number(&Sig::KILL), 9);
        assert_eq!(posix_signal_number(&Sig::SEGV), 11);
        assert_eq!(posix_signal_number(&Sig::TERM), 15);
    }

    /// Prueft `signal_exit_code` -- dieselbe Funktion, die `exec()`s
    /// `ExitSignal`-Arm tatsaechlich aufruft, nicht eine im Test nachgebaute
    /// Kopie der `128 +`-Arithmetik (siehe Doc-Kommentar an
    /// `signal_exit_code`). Ein SIGTERM-Tod muss exakt 143 ergeben --
    /// dieselbe Zahl, die `exec_reports_a_nonzero_code_when_the_remote_
    /// process_dies_by_signal` gegen die echte VM belegt.
    #[test]
    fn signal_exit_code_matches_bash_convention_for_a_known_signal() {
        assert_eq!(signal_exit_code(&Sig::TERM), 143);
        assert_eq!(signal_exit_code(&Sig::KILL), 137);
    }

    /// Ein Signal, das russh nicht als eigene Variante kennt, darf trotzdem
    /// keinen Erfolg (0) vortaeuschen. Ruft `signal_exit_code` auf, nicht
    /// `posix_signal_number` plus einer im Test wiederholten `128 +` --
    /// sonst wuerde diese Assertion gruen bleiben, selbst wenn `exec()`s
    /// Match-Arm den `128 +`-Offset verliert (Review-Nachtrag).
    #[test]
    fn signal_exit_code_falls_back_to_a_nonzero_value_for_unknown_custom_signals() {
        assert_eq!(
            signal_exit_code(&Sig::Custom("RTMIN+1".to_string())),
            128,
            "auch ohne bekannte Signalnummer darf der Exit-Code nicht 0 (Erfolg) sein"
        );
    }
}
