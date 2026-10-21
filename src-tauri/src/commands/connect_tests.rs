use super::*;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::time::{timeout, Instant};

const TEST_END: Duration = Duration::from_secs(5);

#[tokio::test]
async fn cancelled_reservation_cannot_be_consumed() {
    let state = Arc::new(AppState::default());
    let id = begin_connect_impl(&state).unwrap();
    assert!(!state.has_host(&id).await);
    disconnect_host_impl(&state, id.clone()).await.unwrap();
    assert_eq!(
        ConnectAttempt::take(&state, id).err().unwrap().code,
        "connect_cancelled"
    );
    assert!(state.hosts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn duplicate_claim_preserves_original_and_drop_releases_capacity() {
    let state = Arc::new(AppState::default());
    let id = begin_connect_impl(&state).unwrap();
    let attempt = ConnectAttempt::take(&state, id.clone()).unwrap();
    assert!(ConnectAttempt::take(&state, id.clone()).is_err());
    assert!(!attempt.control.is_cancelled());
    for _ in 1..MAX_CONNECT_ATTEMPTS {
        begin_connect_impl(&state).unwrap();
    }
    assert_eq!(
        begin_connect_impl(&state).unwrap_err().code,
        "connect_capacity"
    );
    drop(attempt);
    assert!(!state.hosts.lock().unwrap().contains_key(&id));
    begin_connect_impl(&state).unwrap();
    // Dropping the application releases all timer senders without a strong
    // state reference retained by the reservation expiry tasks.
    let weak = Arc::downgrade(&state);
    drop(state);
    assert!(weak.upgrade().is_none());
}

#[tokio::test]
async fn unclaimed_reservation_expires_without_an_ipc_followup() {
    let state = Arc::new(AppState::default());
    let id = begin_connect_with_limits(
        &state,
        ConnectLimits {
            total: Duration::from_millis(60),
            ..ConnectLimits::default()
        },
    )
    .unwrap();
    let control = state
        .hosts
        .lock()
        .unwrap()
        .get(&id)
        .unwrap()
        .control()
        .unwrap()
        .clone();
    timeout(TEST_END, async {
        while state.hosts.lock().unwrap().contains_key(&id) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        control.with_active(|| ()),
        Err(ConnectFailure::DeadlineExceeded)
    );
    assert!(ConnectAttempt::take(&state, id).is_err());
}

struct RejectPrompt;
impl HostKeyRequestSink for RejectPrompt {
    fn request(&self, _: &HostKeyRequest) -> bool {
        false
    }
}

async fn connect_before_banner(disconnect: bool) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(AppState::default());
    let id = begin_connect_impl(&state).unwrap();
    let child_state = state.clone();
    let child_id = id.clone();
    let mut connecting = tokio::spawn(async move {
        let mut attempt = ConnectAttempt::take(&child_state, child_id).unwrap();
        connect_host_core(
            &child_state,
            &mut attempt,
            HostSpecDto {
                hostname: "127.0.0.1".into(),
                port,
                user: "fixture-user".into(),
                key_path: None,
                passphrase: None,
                password: Some(zeroize::Zeroizing::new("fixture-password".into())),
            },
            String::new(),
            PathBuf::from("unused-hermetic-known-hosts"),
            Arc::new(RejectPrompt),
            Duration::from_secs(1),
        )
        .await
    });
    let (mut peer, _) = timeout(TEST_END, listener.accept()).await.unwrap().unwrap();
    timeout(TEST_END, async {
        let mut length = 0;
        while peer.read_u8().await.unwrap() != b'\n' {
            length += 1;
            assert!(length < 255);
        }
    })
    .await
    .unwrap();
    assert!(!connecting.is_finished());
    let started = Instant::now();
    if disconnect {
        timeout(TEST_END, disconnect_host_impl(&state, id.clone()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            timeout(TEST_END, &mut connecting)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            "connect_cancelled"
        );
    } else {
        connecting.abort();
        assert!(timeout(TEST_END, &mut connecting)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled());
    }
    assert!(!state.hosts.lock().unwrap().contains_key(&id));
    assert!(!state.has_host(&id).await);
    assert_eq!(
        timeout(TEST_END, peer.read(&mut [0; 1]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(started.elapsed() < TEST_END);
}

#[tokio::test]
async fn disconnect_building_attempt_removes_registry_and_stops_real_socket() {
    connect_before_banner(true).await;
}

#[tokio::test]
async fn dropped_connect_future_removes_registry_and_stops_real_socket() {
    connect_before_banner(false).await;
}

struct AcceptPassword {
    entered: Arc<Notify>,
    release: oneshot::Receiver<()>,
}

impl russh::server::Handler for AcceptPassword {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        _: &str,
        _: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        self.entered.notify_one();
        let _ = (&mut self.release).await;
        Ok(russh::server::Auth::Accept)
    }
}

enum PublicationCase {
    CancelBeforeAuth,
    DisconnectReady,
    ExpireBeforePublish,
}

async fn publication_and_disconnect(case: PublicationCase) {
    use russh::keys::PublicKeyBase64;
    let key = russh::keys::load_secret_key(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rsa-signing/rsa2048-pkcs1.pem"),
        None,
    )
    .unwrap();
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let known = known_hosts::format_entry(
        "127.0.0.1",
        port,
        key.algorithm().as_ref(),
        &key.public_key().public_key_base64(),
    );
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        inactivity_timeout: None,
        ..Default::default()
    });
    let entered = Arc::new(Notify::new());
    let server_entered = entered.clone();
    let (release, wait) = oneshot::channel();
    let legs = if matches!(case, PublicationCase::CancelBeforeAuth) {
        1
    } else {
        2
    };
    let mut server = tokio::spawn(async move {
        let mut wait = Some(wait);
        let mut peers = tokio::task::JoinSet::new();
        for leg in 0..legs {
            let (peer, _) = listener.accept().await.unwrap();
            let release = if leg == 0 {
                wait.take().unwrap()
            } else {
                let (send, receive) = oneshot::channel();
                send.send(()).unwrap();
                receive
            };
            let running = russh::server::run_stream(
                config.clone(),
                peer,
                AcceptPassword {
                    entered: server_entered.clone(),
                    release,
                },
            )
            .await?;
            peers.spawn(running);
        }
        while let Some(ended) = peers.join_next().await {
            let _ = ended.unwrap();
        }
        Ok::<(), russh::Error>(())
    });
    let state = Arc::new(AppState::default());
    let id = begin_connect_impl(&state).unwrap();
    let child_state = state.clone();
    let child_id = id.clone();
    let mut connecting = tokio::spawn(async move {
        let mut attempt = ConnectAttempt::take(&child_state, child_id).unwrap();
        connect_host_core(
            &child_state,
            &mut attempt,
            HostSpecDto {
                hostname: "127.0.0.1".into(),
                port,
                user: "fixture-user".into(),
                key_path: None,
                passphrase: None,
                password: Some(zeroize::Zeroizing::new("fixture-password".into())),
            },
            known,
            PathBuf::from("unused-hermetic-known-hosts"),
            Arc::new(RejectPrompt),
            Duration::from_secs(1),
        )
        .await
    });
    timeout(TEST_END, entered.notified()).await.unwrap();
    assert!(
        !state.has_host(&id).await,
        "authentication is still pending"
    );
    if matches!(case, PublicationCase::CancelBeforeAuth) {
        timeout(TEST_END, disconnect_host_impl(&state, id.clone()))
            .await
            .unwrap()
            .unwrap();
        // Let the peer complete its already-pending authentication only AFTER
        // removal. That late success must never publish a runtime host.
        let _ = release.send(());
        assert_eq!(
            timeout(TEST_END, &mut connecting)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            "connect_cancelled"
        );
    } else {
        release.send(()).unwrap();
        assert_eq!(
            timeout(TEST_END, &mut connecting)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            id
        );
        assert!(state.has_host(&id).await);
        if matches!(case, PublicationCase::ExpireBeforePublish) {
            // Reuse an actual authenticated transport to force the otherwise
            // narrow interval between return from connect and registry publish.
            let slot = state.hosts.lock().unwrap().remove(&id).unwrap();
            let HostSlot::Ready(transport) = slot else {
                panic!("ready host")
            };
            let expiring = begin_connect_with_limits(
                &state,
                ConnectLimits {
                    total: Duration::from_millis(40),
                    ..ConnectLimits::default()
                },
            )
            .unwrap();
            let mut attempt = ConnectAttempt::take(&state, expiring.clone()).unwrap();
            timeout(TEST_END, async {
                while state.hosts.lock().unwrap().contains_key(&expiring) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                attempt.publish(transport).unwrap_err().code,
                "connect_timeout"
            );
            assert!(!state.has_host(&expiring).await);
        } else {
            timeout(TEST_END, disconnect_host_impl(&state, id.clone()))
                .await
                .unwrap()
                .unwrap();
        }
    }
    assert!(!state.hosts.lock().unwrap().contains_key(&id));
    disconnect_host_impl(&state, id).await.unwrap(); // idempotent
    let ended = timeout(TEST_END, &mut server).await;
    if ended.is_err() {
        server.abort();
        let _ = server.await;
    }
    assert!(
        ended.is_ok(),
        "owned peer session must terminate after socket abort"
    );
}

#[tokio::test]
async fn late_authentication_after_disconnect_cannot_publish_a_host() {
    publication_and_disconnect(PublicationCase::CancelBeforeAuth).await;
}

#[tokio::test]
async fn successful_publication_transfers_ownership_to_disconnect() {
    publication_and_disconnect(PublicationCase::DisconnectReady).await;
}

#[tokio::test]
async fn expiry_before_publish_preserves_timeout_and_closes_authenticated_transport() {
    publication_and_disconnect(PublicationCase::ExpireBeforePublish).await;
}

/// Ein Loopback-SSH-Server, der nur den Schluesselaustausch beantwortet: der
/// Client entscheidet an der Hostschluesselpruefung und bricht ab, bevor eine
/// Anmeldung beginnt.
struct KeyExchangeOnly;

impl russh::server::Handler for KeyExchangeOnly {
    type Error = russh::Error;
}

struct HostKeyServer {
    port: u16,
    key_type: String,
    /// Ein ANDERER Schluessel desselben Typs, wie ihn ein ausgetauschter
    /// Server zeigte: `known_hosts` kennt den Host dann mit diesem hier.
    other_key_b64: String,
    task: tokio::task::JoinHandle<()>,
}

async fn host_key_server() -> HostKeyServer {
    use russh::keys::PublicKeyBase64;
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rsa-signing");
    let key = russh::keys::load_secret_key(fixtures.join("rsa2048-pkcs1.pem"), None).unwrap();
    let other = russh::keys::load_secret_key(fixtures.join("rsa3072-openssh.key"), None).unwrap();
    assert_eq!(key.algorithm(), other.algorithm());
    let key_type = key.algorithm().as_ref().to_string();
    let other_key_b64 = other.public_key().public_key_base64();
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        inactivity_timeout: None,
        ..Default::default()
    });
    let task = tokio::spawn(async move {
        let (peer, _) = listener.accept().await.unwrap();
        if let Ok(running) = russh::server::run_stream(config, peer, KeyExchangeOnly).await {
            let _ = running.await;
        }
    });
    HostKeyServer {
        port,
        key_type,
        other_key_b64,
        task,
    }
}

/// Zeigt die Rueckfrage an (`request` liefert `true`), aber niemand
/// antwortet: die Bestaetigung laeuft ab.
struct NeverAnswers;
impl HostKeyRequestSink for NeverAnswers {
    fn request(&self, _: &HostKeyRequest) -> bool {
        true
    }
}

/// Verbindet gegen `server` mit dem gegebenen `known_hosts`-Text und liefert
/// den Fehler, den der Nutzer im Verbindungsfeld liest. `sink` und
/// `prompt_timeout` bestimmen, wie die Rueckfrage zu einem unbekannten
/// Schluessel ausgeht.
async fn connect_expecting_host_key_failure(
    server: HostKeyServer,
    known_hosts_text: String,
    sink: Arc<dyn HostKeyRequestSink>,
    prompt_timeout: Duration,
) -> ConnectError {
    let state = Arc::new(AppState::default());
    let id = begin_connect_impl(&state).unwrap();
    let mut attempt = ConnectAttempt::take(&state, id).unwrap();
    let error = timeout(
        TEST_END,
        connect_host_core(
            &state,
            &mut attempt,
            HostSpecDto {
                hostname: "127.0.0.1".into(),
                port: server.port,
                user: "fixture-user".into(),
                key_path: None,
                passphrase: None,
                password: Some(zeroize::Zeroizing::new("fixture-password".into())),
            },
            known_hosts_text,
            PathBuf::from("unused-hermetic-known-hosts"),
            sink,
            prompt_timeout,
        ),
    )
    .await
    .unwrap()
    .unwrap_err();
    // Die Reservierung gehoert dem Versuch; mit ihm faellt sie weg, und es
    // bleibt kein Host zurueck.
    drop(attempt);
    assert!(state.hosts.lock().unwrap().is_empty());
    timeout(TEST_END, server.task)
        .await
        .expect("the key exchange peer must end once the client has refused the key")
        .expect("the key exchange peer must not panic");
    error
}

/// Spec §10: ein bekannter Host mit anderem Schluessel heisst "geaendert" und
/// nennt den Host unter dem Namen, den die Zeile in `known_hosts` traegt: bei
/// einem anderen Port als 22 `[host]:port`, so wie der Nutzer den Eintrag
/// zum Entfernen findet. Der Fehlercode bleibt `host_key_rejected`.
#[tokio::test]
async fn a_changed_host_key_names_the_host_and_the_way_out() {
    let server = host_key_server().await;
    let known = known_hosts::format_entry(
        "127.0.0.1",
        server.port,
        &server.key_type,
        &server.other_key_b64,
    );
    let port = server.port;
    let error = connect_expecting_host_key_failure(
        server,
        known,
        Arc::new(RejectPrompt),
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(error.code, "host_key_rejected");
    assert_eq!(
        error.message,
        format!(
            "The host key of [127.0.0.1]:{port} has changed. Someone may be intercepting the \
             connection — or the server was reinstalled. If you're sure, remove its old entry \
             from ~/.ssh/known_hosts, for example with ssh-keygen -R \"[127.0.0.1]:{port}\", \
             and connect again."
        )
    );
}

/// Spec §10: eine Rueckfrage, die der Nutzer nicht bestaetigt, ist kein
/// Fehler des Hosts. Auch hier bleibt der Code `host_key_rejected`.
#[tokio::test]
async fn a_declined_host_key_says_it_was_not_confirmed() {
    let server = host_key_server().await;
    let error = connect_expecting_host_key_failure(
        server,
        String::new(),
        Arc::new(RejectPrompt),
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(error.code, "host_key_rejected");
    assert_eq!(
        error.message,
        "The host key wasn't confirmed, so aidevbridge didn't connect."
    );
}

/// Spec §10: laeuft die Rueckfrage ab, steht dort derselbe Satz wie bei der
/// Ablehnung, mit "in time". Anders als die Ablehnung ist es ein Zeitablauf:
/// der Code bleibt `connect_timeout`.
#[tokio::test]
async fn an_unanswered_host_key_prompt_expires_with_its_own_text_and_code() {
    let server = host_key_server().await;
    let error = connect_expecting_host_key_failure(
        server,
        String::new(),
        Arc::new(NeverAnswers),
        Duration::from_millis(150),
    )
    .await;
    assert_eq!(error.code, "connect_timeout");
    assert_eq!(
        error.message,
        "The host key wasn't confirmed in time, so aidevbridge didn't connect."
    );
}
