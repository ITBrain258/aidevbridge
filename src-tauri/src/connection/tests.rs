//! Hermetic pair/repair tests use real SSH handshakes and channels on loopback.
//! No remote shell, user key, known_hosts file or tmux process is touched.
use super::*;
use crate::transport::ConnectError;
use russh::keys::PublicKeyBase64;
use russh::server::Session;
use russh::{Channel, ChannelId};
use std::sync::atomic::AtomicUsize;
use tokio::net::TcpListener;
use tokio::time::timeout;

const END: Duration = Duration::from_secs(8);
/// Hoechstens rund 2 s Warten auf einen freien Vorbereitungsplatz.
const PREPARATION_ATTEMPTS: u32 = 40;
const PREPARATION_RETRY: Duration = Duration::from_millis(50);

#[derive(Default)]
struct Events {
    controls: Mutex<Vec<ControlStateEvent>>,
    terminals: Mutex<Vec<TerminalTransportLostEvent>>,
}

impl ConnectionEvents for Events {
    fn control_state(&self, event: ControlStateEvent) {
        self.controls.lock().unwrap().push(event);
    }
    fn terminal_transport_lost(&self, event: TerminalTransportLostEvent) {
        self.terminals.lock().unwrap().push(event);
    }
}

struct Consent {
    key: String,
    calls: AtomicUsize,
}

#[async_trait]
impl HostKeyPolicy for Consent {
    async fn decide(&self, host: &str, _: u16, _: &str, key: &str) -> bool {
        self.calls.fetch_add(1, Ordering::SeqCst);
        host == "127.0.0.1" && key == self.key
    }
}

#[derive(Default)]
struct Seen {
    auth: Mutex<Vec<usize>>,
    commands: Mutex<Vec<(usize, String)>>,
    ptys: Mutex<Vec<usize>>,
    ended: AtomicUsize,
    hold_terminal_opens: AtomicBool,
    pending_opens: Mutex<Vec<russh::server::ChannelOpenHandle>>,
    replies: Mutex<std::collections::VecDeque<(Option<u32>, String, String)>>,
    hold_control_replies: AtomicBool,
    closes: Mutex<Vec<usize>>,
    /// Kanal-Opens je Leg, in Ankunftsfolge, auch gehaltene.
    opens: Mutex<Vec<usize>>,
    /// Solange gesetzt, haelt die Terminalverbindung (Leg 1) jedes Close an,
    /// bis `closes_released` weckt.
    hold_terminal_closes: AtomicBool,
    closes_released: tokio::sync::Notify,
}

struct PeerHandler {
    leg: usize,
    seen: Arc<Seen>,
    reject: bool,
    incomplete: bool,
}

impl Drop for PeerHandler {
    fn drop(&mut self) {
        self.seen.ended.fetch_add(1, Ordering::SeqCst);
    }
}

impl russh::server::Handler for PeerHandler {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        _: &str,
        password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        assert_eq!(password, "only-this-hermetic-fixture");
        self.seen.auth.lock().unwrap().push(self.leg);
        Ok(if self.reject {
            russh::server::Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            }
        } else {
            russh::server::Auth::Accept
        })
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen.opens.lock().unwrap().push(self.leg);
        if self.leg == 1 && self.seen.hold_terminal_opens.load(Ordering::SeqCst) {
            self.seen.pending_opens.lock().unwrap().push(reply);
        } else {
            reply.accept().await;
        }
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen.ptys.lock().unwrap().push(self.leg);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen
            .commands
            .lock()
            .unwrap()
            .push((self.leg, String::from_utf8_lossy(command).into_owned()));
        session.channel_success(channel)?;
        // Ein haengender Befehl: angenommen, aber nie beantwortet. Er
        // verbraucht keinen Skripteintrag. Dasselbe fuer jeden Steuerbefehl,
        // solange `hold_control_replies` gilt (gebaute Zeilen sind nie `hang`).
        if command == b"hang"
            || (self.leg == 0 && self.seen.hold_control_replies.load(Ordering::SeqCst))
        {
            return Ok(());
        }
        let scripted = if self.leg == 0 {
            self.seen.replies.lock().unwrap().pop_front()
        } else {
            None
        };
        if let Some((code, stdout, stderr)) = scripted {
            if !stdout.is_empty() {
                session.data(channel, stdout.into_bytes())?;
            }
            if !stderr.is_empty() {
                session.extended_data(channel, 1, stderr.into_bytes())?;
            }
            if let Some(code) = code {
                session.exit_status_request(channel, code)?;
            }
            session.eof(channel)?;
            session.close(channel)?;
            return Ok(());
        }
        session.data(channel, b"fixture-result\n".to_vec())?;
        if self.leg != 1 {
            if !self.incomplete {
                session.exit_status_request(channel, 0)?;
            }
            session.eof(channel)?;
            session.close(channel)?;
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        bytes: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, bytes.to_vec())?;
        Ok(())
    }

    /// Buchfuehrung: russh hat das Close schon vor diesem Aufruf beantwortet,
    /// schickt die Antwort aber erst ab, wenn er zurueckkehrt. Solange
    /// `hold_terminal_closes` gilt, haelt die Terminalverbindung (Leg 1) hier
    /// an: ein echtes, ausbleibendes Close der Gegenseite, wie `StallClose` in
    /// `operation_tests.rs`.
    async fn channel_close(&mut self, _: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.seen.closes.lock().unwrap().push(self.leg);
        if self.leg == 1 && self.seen.hold_terminal_closes.load(Ordering::SeqCst) {
            self.seen.closes_released.notified().await;
        }
        Ok(())
    }
}

pub(crate) struct Fixture {
    spec: HostSpec,
    consent: Arc<Consent>,
    events: Arc<Events>,
    seen: Arc<Seen>,
    server: Option<tokio::task::JoinHandle<()>>,
}

impl Fixture {
    pub(crate) async fn start(
        legs: usize,
        changed_second: bool,
        reject_second: bool,
        incomplete: bool,
    ) -> Self {
        let key = russh::keys::load_secret_key(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/rsa-signing/rsa2048-pkcs1.pem"),
            None,
        )
        .unwrap();
        let key2 = if changed_second {
            russh::keys::load_secret_key(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/rsa-signing/rsa3072-openssh.key"),
                None,
            )
            .unwrap()
        } else {
            key.clone()
        };
        let consent = Arc::new(Consent {
            key: key.public_key().public_key_base64(),
            calls: AtomicUsize::new(0),
        });
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let spec = HostSpec {
            hostname: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            user: "fixture-user".into(),
        };
        let seen = Arc::new(Seen::default());
        let peer_seen = seen.clone();
        let server = tokio::spawn(async move {
            let mut peers = tokio::task::JoinSet::new();
            for leg in 0..legs {
                let (stream, _) = timeout(END, listener.accept())
                    .await
                    .expect("fixture accept deadline")
                    .unwrap();
                let config = Arc::new(russh::server::Config {
                    keys: vec![if leg == 1 { key2.clone() } else { key.clone() }],
                    auth_rejection_time: Duration::ZERO,
                    auth_rejection_time_initial: Some(Duration::ZERO),
                    inactivity_timeout: None,
                    nodelay: true,
                    ..Default::default()
                });
                let handler = PeerHandler {
                    leg,
                    seen: peer_seen.clone(),
                    reject: leg == 1 && reject_second,
                    incomplete,
                };
                peers.spawn(async move {
                    if let Ok(running) = russh::server::run_stream(config, stream, handler).await {
                        let _ = running.await;
                    }
                });
            }
            while let Some(ended) = peers.join_next().await {
                ended.unwrap();
            }
        });
        Self {
            spec,
            consent,
            events: Arc::new(Events::default()),
            seen,
            server: Some(server),
        }
    }

    /// Der Pool fuer die Schluesselvorbereitung ist prozessweit (8 Plaetze),
    /// parallele Tests teilen ihn. Nur `PreparationBusy` wird wiederholt: Der
    /// Fehler faellt vor jeder TCP-Verbindung und verbraucht keinen Zugang des
    /// Testservers. Jeder andere Fehler geht unveraendert zurueck.
    pub(crate) async fn connect(&self) -> anyhow::Result<Arc<HostConnection>> {
        let mut attempt = 1;
        loop {
            let result = timeout(
                END,
                HostConnection::connect(
                    "hermetic-h0".into(),
                    self.spec.clone(),
                    password(),
                    self.consent.clone(),
                    ConnectControl::default(),
                    self.events.clone(),
                ),
            )
            .await
            .expect("pair deadline");
            let busy = result
                .as_ref()
                .err()
                .and_then(|error| error.downcast_ref::<ConnectError>())
                == Some(&ConnectError::PreparationBusy);
            if !busy || attempt == PREPARATION_ATTEMPTS {
                return result;
            }
            attempt += 1;
            tokio::time::sleep(PREPARATION_RETRY).await;
        }
    }

    pub(crate) async fn finish(mut self, expected: usize) {
        timeout(END, self.server.as_mut().unwrap())
            .await
            .expect("all actual SSH peers must end")
            .unwrap();
        self.server.take();
        assert_eq!(self.seen.ended.load(Ordering::SeqCst), expected);
    }

    pub(crate) fn hold_terminal_opens(&self) {
        self.seen.hold_terminal_opens.store(true, Ordering::SeqCst);
    }

    pub(crate) async fn wait_pending_opens(&self, count: usize) {
        timeout(END, async {
            while self.seen.pending_opens.lock().unwrap().len() < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("actual pending SSH open");
    }

    pub(crate) async fn release_terminal_opens(&self) {
        self.seen.hold_terminal_opens.store(false, Ordering::SeqCst);
        let pending = std::mem::take(&mut *self.seen.pending_opens.lock().unwrap());
        for reply in pending {
            reply.accept().await;
        }
    }

    pub(crate) fn pty_requests(&self) -> usize {
        self.seen.ptys.lock().unwrap().len()
    }

    pub(crate) fn script_control(&self, replies: Vec<(Option<u32>, &str, &str)>) {
        *self.seen.replies.lock().unwrap() = replies
            .into_iter()
            .map(|(code, stdout, stderr)| (code, stdout.into(), stderr.into()))
            .collect();
    }

    pub(crate) fn command_count(&self) -> usize {
        self.seen.commands.lock().unwrap().len()
    }

    /// Alle Exec-Anfragen beider Legs als (Leg, Zeile), in Ankunftsfolge.
    pub(crate) fn commands(&self) -> Vec<(usize, String)> {
        self.seen.commands.lock().unwrap().clone()
    }

    /// Kommandozeilen auf der Steuerverbindung (Leg 0), in Ankunftsfolge.
    pub(crate) fn control_commands(&self) -> Vec<String> {
        self.seen
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(leg, _)| *leg == 0)
            .map(|(_, command)| command.clone())
            .collect()
    }

    /// Jeder weitere Steuerbefehl wird angenommen, aber nie beantwortet.
    pub(crate) fn hold_control_replies(&self) {
        self.seen.hold_control_replies.store(true, Ordering::SeqCst);
    }

    /// Wie viele Kanaele die Gegenseite auf `leg` geschlossen hat.
    pub(crate) fn channel_closes(&self, leg: usize) -> usize {
        self.seen
            .closes
            .lock()
            .unwrap()
            .iter()
            .filter(|closed| **closed == leg)
            .count()
    }

    /// Wie viele Kanaele der Client auf `leg` zu oeffnen verlangt hat, auch
    /// gehaltene und wieder geschlossene.
    pub(crate) fn channel_opens(&self, leg: usize) -> usize {
        self.seen
            .opens
            .lock()
            .unwrap()
            .iter()
            .filter(|opened| **opened == leg)
            .count()
    }

    /// Ab jetzt haelt die Terminalverbindung (Leg 1) das naechste Close an;
    /// bis `release_terminal_closes` verarbeitet ihre Gegenseite dann gar
    /// nichts mehr (wie `StallClose`): keine Daten, kein Open, kein weiteres
    /// Close. Je Test hoechstens einmal halten.
    pub(crate) fn hold_terminal_closes(&self) {
        self.seen.hold_terminal_closes.store(true, Ordering::SeqCst);
    }

    /// Laesst das angehaltene Close weiterlaufen; die folgenden werden wieder
    /// sofort beantwortet. Ohne angehaltenes Close bleibt der Weckruf
    /// gespeichert, und das naechste gehaltene Close liefe sofort durch.
    pub(crate) fn release_terminal_closes(&self) {
        self.seen
            .hold_terminal_closes
            .store(false, Ordering::SeqCst);
        self.seen.closes_released.notify_one();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(server) = &self.server {
            server.abort();
        }
    }
}

fn password() -> AuthMethod {
    AuthMethod::Password(zeroize::Zeroizing::new("only-this-hermetic-fixture".into()))
}

async fn wait_health(host: &HostConnection, expected: ControlHealth) {
    timeout(END, async {
        loop {
            if host.state.lock().unwrap().health == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("control state transition");
}

// Beide lesen ausserhalb der Assertion: Ein Fehlschlag mit gehaltener Sperre
// vergiftet sie, und dann bricht `HostConnection::drop` den Testlauf ab.
fn health(host: &HostConnection) -> ControlHealth {
    host.state.lock().unwrap().health
}

pub(crate) fn control_events(fixture: &Fixture) -> Vec<ControlStateEvent> {
    fixture.events.controls.lock().unwrap().clone()
}

#[tokio::test]
async fn pair_prompts_once_routes_commands_and_terminal_separately_and_disposes_without_loss_event()
{
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    host.start_monitor();
    assert_eq!(fixture.consent.calls.load(Ordering::SeqCst), 1);
    let command = host.command(Instant::now() + COMMAND_TIMEOUT);
    assert_eq!(
        command.exec("fixture-control").await.unwrap().stdout,
        "fixture-result\n"
    );
    let mut pty = host
        .terminal()
        .open_attach("fixture_socket", "fixture_session", 80, 24)
        .await
        .unwrap();
    assert_eq!(
        timeout(END, pty.data.recv()).await.unwrap().unwrap(),
        b"fixture-result\n"
    );
    assert_eq!(*fixture.seen.auth.lock().unwrap(), [0, 1]);
    assert_eq!(*fixture.seen.ptys.lock().unwrap(), [1]);
    assert_eq!(
        fixture.seen.commands.lock().unwrap()[0],
        (0, "fixture-control".into())
    );
    assert_eq!(fixture.seen.commands.lock().unwrap()[1].0, 1);
    host.dispose().await;
    assert!(fixture.events.terminals.lock().unwrap().is_empty());
    assert!(fixture.events.controls.lock().unwrap().is_empty());
    let weak = Arc::downgrade(&host);
    drop(host);
    assert!(
        weak.upgrade().is_none(),
        "monitor/command must not retain host"
    );
    drop(pty);
    fixture.finish(2).await;
}

#[tokio::test]
async fn shared_command_transport_drop_does_not_cancel_the_parent_operation() {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    let control = crate::transport::operation_control::OperationControl::new(COMMAND_TIMEOUT);
    {
        let shared = host.command_sharing(control.clone());
        assert_eq!(
            shared.exec("fixture-control").await.unwrap().stdout,
            "fixture-result\n"
        );
        drop(shared);
    }
    assert!(
        !control.is_cancelled(),
        "bound attach reuses this operation after command_sharing returns"
    );
    assert!(control.with_active(|| ()).is_ok());
    let owned = host.command(Instant::now() + COMMAND_TIMEOUT);
    let owned_control = owned.operation().clone();
    drop(owned);
    assert!(owned_control.is_cancelled());
    host.dispose().await;
    fixture.finish(2).await;
}

#[tokio::test]
async fn a_changed_second_key_never_prompts_again_and_aborts_both_legs() {
    let fixture = Fixture::start(2, true, false, false).await;
    let error = fixture.connect().await.err().unwrap();
    assert!(error.is::<PairIdentityRejected>(), "{error:#}");
    // Spec §10: der Text, den der Nutzer liest (der Fehlercode
    // `host_key_rejected` entsteht in `commands.rs` aus dem Typ, nicht aus
    // dem Text).
    assert_eq!(
        error.to_string(),
        "This server answered with a different host key than the open connection. \
         For safety, the second connection was refused."
    );
    assert_eq!(fixture.consent.calls.load(Ordering::SeqCst), 1);
    assert_eq!(*fixture.seen.auth.lock().unwrap(), [0]);
    fixture.finish(2).await;
}

#[tokio::test]
async fn second_auth_failure_releases_the_authenticated_first_leg() {
    let fixture = Fixture::start(2, false, true, false).await;
    let error = fixture.connect().await.err().unwrap();
    assert!(
        matches!(
            error.downcast_ref::<crate::ssh::AuthError>(),
            Some(crate::ssh::AuthError::PasswordWrong | crate::ssh::AuthError::MethodNotOffered(_))
        ),
        "{error:#}"
    );
    assert_eq!(fixture.consent.calls.load(Ordering::SeqCst), 1);
    assert_eq!(*fixture.seen.auth.lock().unwrap(), [0, 1]);
    fixture.finish(2).await;
}

#[tokio::test]
async fn explicit_control_repair_keeps_terminal_and_rejects_stale_command_and_cancel_generation() {
    let fixture = Fixture::start(3, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    host.start_monitor();
    let terminal = host.terminal().clone();
    let old_command = host.command(Instant::now() + COMMAND_TIMEOUT);
    old_command.transport.as_ref().unwrap().abort();
    wait_health(&host, ControlHealth::Degraded).await;
    let generation = host.begin_repair().unwrap();
    assert_eq!(generation, 1);
    let mut attempt = host.take_repair(generation).unwrap();
    assert!(host.take_repair(generation).is_err());
    attempt.connect(password(), String::new()).await.unwrap();
    host.cancel_repair(0);
    drop(attempt);
    assert_eq!(host.state.lock().unwrap().health, ControlHealth::Ready);
    assert!(Arc::ptr_eq(host.terminal(), &terminal));
    assert!(old_command.exec("stale-command").await.is_err());
    assert_eq!(host.state.lock().unwrap().health, ControlHealth::Ready);
    let current = host.command(Instant::now() + COMMAND_TIMEOUT);
    assert_eq!(current.generation, 1);
    assert_eq!(current.exec("new-control").await.unwrap().code, 0);
    assert_eq!(fixture.seen.commands.lock().unwrap().last().unwrap().0, 2);
    assert!(fixture.events.terminals.lock().unwrap().is_empty());
    assert_eq!(fixture.consent.calls.load(Ordering::SeqCst), 1);
    host.dispose().await;
    fixture.finish(3).await;
}

#[tokio::test]
async fn actual_terminal_end_emits_once_and_control_failure_alone_does_not() {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    host.start_monitor();
    host.state.lock().unwrap().control.as_ref().unwrap().abort();
    wait_health(&host, ControlHealth::Degraded).await;
    assert!(fixture.events.terminals.lock().unwrap().is_empty());
    host.terminal().abort();
    timeout(END, async {
        while fixture.events.terminals.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    host.terminal_ended();
    assert_eq!(fixture.events.terminals.lock().unwrap().len(), 1);
    host.dispose().await;
    fixture.finish(2).await;
}

/// Eine langsame Lesung ist kein Verbindungsverlust: Frist abgelaufen,
/// Transport nutzbar, also bleibt der Zustand Ready, und es geht kein
/// Ereignis hinaus.
#[tokio::test]
async fn hung_exec_with_short_deadline_leaves_ready_and_emits_nothing() {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    host.start_monitor();
    let command = host.command(Instant::now() + Duration::from_millis(200));
    let error = command.exec("hang").await.unwrap_err();
    let error = error.downcast_ref::<ExecError>().unwrap();
    // Read, nicht Open: Ein langsames Kanaloeffnen auf belasteter Maschine
    // bricht den Transport ab und zeigt sich hier, nicht als Fehler in observe.
    assert_eq!(
        (error.phase, error.reason),
        (ExecPhase::Read, ExecReason::Timeout)
    );
    // Das Schliessen des haengenden Kanals laeuft nach der Antwort weiter.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(health(&host), ControlHealth::Ready);
    let events = control_events(&fixture);
    assert!(events.is_empty(), "{events:?}");
    assert!(command.transport.as_ref().unwrap().is_usable());
    let next = host.command(Instant::now() + COMMAND_TIMEOUT);
    assert_eq!(next.exec("fixture-control").await.unwrap().code, 0);
    let events = control_events(&fixture);
    assert!(events.is_empty(), "{events:?}");
    host.dispose().await;
    fixture.finish(2).await;
}

#[tokio::test]
async fn expired_deadline_at_admission_emits_nothing() {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    host.start_monitor();
    let command = host.command(Instant::now());
    let error = command.exec("never-submitted").await.unwrap_err();
    let error = error.downcast_ref::<ExecError>().unwrap();
    assert_eq!(
        (error.phase, error.reason, error.submission),
        (
            ExecPhase::Admission,
            ExecReason::Timeout,
            Submission::NotSubmitted
        )
    );
    assert_eq!(fixture.command_count(), 0);
    assert_eq!(health(&host), ControlHealth::Ready);
    let events = control_events(&fixture);
    assert!(events.is_empty(), "{events:?}");
    host.dispose().await;
    fixture.finish(2).await;
}

/// Ohne Monitor: Den Wechsel auf Degraded loest hier allein das Ergebnis
/// eines Befehls auf dem unbenutzbaren Transport aus.
#[tokio::test]
async fn unusable_control_after_failure_sets_degraded() {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    host.state.lock().unwrap().control.as_ref().unwrap().abort();
    let command = host.command(Instant::now() + COMMAND_TIMEOUT);
    let error = command.exec("after-abort").await.unwrap_err();
    assert_eq!(
        error.downcast_ref::<ExecError>().unwrap().reason,
        ExecReason::Unavailable
    );
    assert_eq!(health(&host), ControlHealth::Degraded);
    let control_taken = host.state.lock().unwrap().control.is_none();
    assert!(control_taken);
    let events = control_events(&fixture);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].state, ControlHealth::Degraded);
    assert_eq!(
        events[0].message.as_deref(),
        Some("The control connection has ended (admission, unavailable).")
    );
    host.dispose().await;
    fixture.finish(2).await;
}

#[test]
fn degraded_message_names_phase_and_reason_in_words() {
    let failed = |phase, reason| -> anyhow::Result<ExecResult> {
        Err(ExecError {
            phase,
            reason,
            submission: Submission::PossiblySubmitted,
        }
        .into())
    };
    assert_eq!(
        degraded_message(&failed(ExecPhase::Read, ExecReason::Timeout)),
        "The control connection has ended (read, timeout)."
    );
    assert_eq!(
        degraded_message(&failed(ExecPhase::Open, ExecReason::Transport)),
        "The control connection has ended (open, transport)."
    );
    assert_eq!(
        degraded_message(&failed(ExecPhase::Eof, ExecReason::MissingExitStatus)),
        "The control connection has ended (eof, missing exit status)."
    );
    let answered = Ok(ExecResult {
        utf8_valid: true,
        stdout: String::new(),
        stderr: String::new(),
        code: 0,
    });
    assert_eq!(
        degraded_message(&answered),
        "The control connection has ended."
    );
}

#[tokio::test]
async fn incomplete_mutation_blocks_followup_cleanup_on_the_same_live_control() {
    let fixture = Fixture::start(2, false, false, true).await;
    let host = fixture.connect().await.unwrap();
    let command = host.command(Instant::now() + COMMAND_TIMEOUT);
    let error = command.exec_mutation("mutation").await.unwrap_err();
    assert_eq!(
        error.downcast_ref::<ExecError>().unwrap().reason,
        ExecReason::MissingExitStatus
    );
    assert!(command.unknown_outcome());
    assert!(!command.can_cleanup());
    assert!(command.exec_mutation("unsafe-restore").await.is_err());
    assert_eq!(fixture.seen.commands.lock().unwrap().len(), 1);
    host.dispose().await;
    fixture.finish(2).await;
}

#[tokio::test]
async fn a_composed_command_cannot_start_a_fresh_budget_after_its_first_exec() {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    let command = host.command(Instant::now() + Duration::from_millis(250));
    assert_eq!(command.exec("first").await.unwrap().code, 0);
    tokio::time::sleep_until(command.operation.deadline()).await;
    let error = command.exec("late-second").await.unwrap_err();
    assert_eq!(
        error.downcast_ref::<ExecError>().unwrap().submission,
        Submission::NotSubmitted
    );
    assert_eq!(fixture.seen.commands.lock().unwrap().len(), 1);
    host.dispose().await;
    fixture.finish(2).await;
}

/// Spec 2026-10-19 §8.1 (Schritt 3), §8.3: Die Pumpengrenze liegt bei 16,
/// doppelt so hoch wie die acht PTY-Plaetze der Terminalverbindung. Die
/// siebzehnte Pumpe scheitert mit dem Rohtext, den das Frontend als
/// Kanalgrenze erkennt (`CAPACITY_ERRORS` in `src/views/grid.ts`).
#[tokio::test]
async fn pump_limit_admits_sixteen_and_names_the_seventeenth_with_the_known_raw_text() {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    for _ in 0..16 {
        host.start_pump(std::future::pending::<()>()).unwrap();
    }
    let error = host.start_pump(std::future::pending::<()>()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "too many terminal output tasks are still closing"
    );
    host.dispose().await;
    fixture.finish(2).await;
}
