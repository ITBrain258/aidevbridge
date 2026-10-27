use super::*;
use crate::transport::ConnectLimits;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Notify};
use tokio::time::timeout;
use zeroize::Zeroizing;

const TEST_END: Duration = Duration::from_secs(5);

fn limits() -> ConnectLimits {
    ConnectLimits {
        total: Duration::from_secs(3),
        network: Duration::from_millis(350),
        auth: Duration::from_millis(150),
        tofu: Duration::from_secs(1),
    }
}

fn password() -> AuthMethod {
    AuthMethod::Password(Zeroizing::new("hermetic-fixture-password".into()))
}

async fn listener() -> (TcpListener, HostSpec) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let spec = HostSpec {
        hostname: "127.0.0.1".into(),
        port: listener.local_addr().unwrap().port(),
        user: "fixture-user".into(),
    };
    (listener, spec)
}

struct Policy {
    dropped: Option<oneshot::Sender<()>>,
    waiting: Option<Arc<Notify>>,
}

#[async_trait]
impl HostKeyPolicy for Policy {
    async fn decide(&self, _: &str, _: u16, _: &str, _: &str) -> bool {
        if let Some(waiting) = &self.waiting {
            waiting.notify_one();
            std::future::pending::<()>().await;
        }
        true
    }
}

impl Drop for Policy {
    fn drop(&mut self) {
        if let Some(tx) = self.dropped.take() {
            let _ = tx.send(());
        }
    }
}

fn policy(waiting: Option<Arc<Notify>>) -> (Arc<dyn HostKeyPolicy>, oneshot::Receiver<()>) {
    let (tx, rx) = oneshot::channel();
    (
        Arc::new(Policy {
            dropped: Some(tx),
            waiting,
        }),
        rx,
    )
}

fn connect_error(result: anyhow::Result<RusshTransport>) -> ConnectError {
    match result {
        Ok(_) => panic!("unexpected connected transport"),
        Err(error) => *error
            .downcast_ref::<ConnectError>()
            .expect("typed connect failure"),
    }
}

async fn raw_stall(kex: bool, cancel: bool) {
    let (listener, spec) = listener().await;
    let control = ConnectControl::new(limits());
    let (policy, dropped) = policy(None);
    let child_control = control.clone();
    let mut client = tokio::spawn(async move {
        RusshTransport::connect_controlled(&spec, policy, password(), child_control).await
    });
    let (mut peer, _) = timeout(TEST_END, listener.accept()).await.unwrap().unwrap();
    if kex {
        peer.write_all(b"SSH-2.0-aidevbridge-product-probe\r\n")
            .await
            .unwrap();
    }
    timeout(TEST_END, async {
        let mut banner = Vec::new();
        loop {
            let byte = peer.read_u8().await.unwrap();
            banner.push(byte);
            assert!(banner.len() <= 255);
            if byte == b'\n' {
                break;
            }
        }
        assert!(banner.starts_with(b"SSH-2.0-"));
        if kex {
            let length = peer.read_u32().await.unwrap() as usize;
            assert!((6..=65536).contains(&length));
            let mut packet = vec![0; length];
            peer.read_exact(&mut packet).await.unwrap();
            assert_eq!(packet[1], 20, "the actual client entered KEX");
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!client.is_finished(), "negative observation before trigger");
    if cancel {
        control.cancel();
    }
    let result = timeout(TEST_END, &mut client).await.unwrap().unwrap();
    // This policy is owned only by the actual russh Handler after the observed
    // banner/KEX phase. Its Drop proves callback/session ownership was released.
    timeout(TEST_END, dropped).await.unwrap().unwrap();
    let eof = timeout(TEST_END, peer.read(&mut [0; 1]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(eof, 0, "EOF before any peer close or additional peer data");
    assert_eq!(
        connect_error(result),
        if cancel {
            ConnectError::Cancelled
        } else {
            ConnectError::NetworkTimeout
        }
    );
}

#[tokio::test]
async fn controlled_connect_no_banner_cancel_releases_handler_and_peer() {
    raw_stall(false, true).await;
}
#[tokio::test]
async fn controlled_connect_no_banner_deadline_releases_handler_and_peer() {
    raw_stall(false, false).await;
}
#[tokio::test]
async fn controlled_connect_stalled_kex_cancel_releases_handler_and_peer() {
    raw_stall(true, true).await;
}
#[tokio::test]
async fn controlled_connect_stalled_kex_deadline_releases_handler_and_peer() {
    raw_stall(true, false).await;
}

struct PasswordServer {
    entered: Arc<Notify>,
    release: oneshot::Receiver<()>,
}

impl russh::server::Handler for PasswordServer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        _: &str,
        _: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        self.entered.notify_one();
        let _ = (&mut self.release).await;
        Ok(russh::server::Auth::reject())
    }
}

fn server_settings() -> russh::server::Config {
    russh::server::Config {
        keys: vec![russh::keys::load_secret_key(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/rsa-signing/rsa2048-pkcs1.pem"),
            None,
        )
        .unwrap()],
        auth_rejection_time: Duration::ZERO,
        inactivity_timeout: None,
        ..Default::default()
    }
}

fn server_config() -> Arc<russh::server::Config> {
    Arc::new(server_settings())
}

async fn callback_or_auth_stall(callback: bool, cancel: bool) {
    let (listener, spec) = listener().await;
    let mut budget = limits();
    budget.network = Duration::from_secs(1);
    let control = ConnectControl::new(budget);
    let entered = Arc::new(Notify::new());
    let (policy, dropped) = policy(callback.then(|| entered.clone()));
    let child_control = control.clone();
    let mut client = tokio::spawn(async move {
        RusshTransport::connect_controlled(&spec, policy, password(), child_control).await
    });
    let (peer, _) = timeout(TEST_END, listener.accept()).await.unwrap().unwrap();
    let standard = peer.into_std().unwrap();
    // Only after auth_password is actually waiting do we read this clone to
    // observe EOF. No concurrent server protocol reader then consumes input.
    let mut eof_peer = TcpStream::from_std(standard.try_clone().unwrap()).unwrap();
    let peer = TcpStream::from_std(standard).unwrap();
    let (release, rx) = oneshot::channel();
    let server_entered = entered.clone();
    let mut server = tokio::spawn(async move {
        russh::server::run_stream(
            server_config(),
            peer,
            PasswordServer {
                entered: server_entered,
                release: rx,
            },
        )
        .await?
        .await
    });
    timeout(TEST_END, entered.notified()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(
        !client.is_finished(),
        "the actual callback/auth response is still pending"
    );
    if cancel {
        control.cancel();
    }
    let result = timeout(TEST_END, &mut client).await.unwrap().unwrap();
    timeout(TEST_END, dropped).await.unwrap().unwrap();
    // In the policy case the server is still a protocol reader; client sends
    // no more data after callback entry. Both readers can only observe EOF.
    let peer_end = timeout(TEST_END, async {
        let mut rest = Vec::new();
        (&mut eof_peer)
            .take(1024 * 1024)
            .read_to_end(&mut rest)
            .await?;
        if rest.len() == 1024 * 1024 {
            return Err(std::io::Error::other("peer drain limit exceeded"));
        }
        Ok::<_, std::io::Error>(rest.len())
    })
    .await;
    // With a real SSH peer, unread handshake data can accompany forced socket
    // teardown. Windows may report ConnectionReset rather than graceful EOF;
    // both are terminal socket observations, but they are not the same result.
    // Record the observation before any additional peer intervention.
    println!("callback={callback}, cancel={cancel}, peer terminal observation={peer_end:?}");
    let peer_ended = matches!(&peer_end, Ok(Ok(_)))
        || matches!(&peer_end, Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionReset);
    let _ = release.send(()); // cleanup only AFTER client-handler Drop and read observation.
    let ended = timeout(TEST_END, &mut server).await;
    if ended.is_err() {
        server.abort();
        let _ = server.await;
    }
    assert!(
        ended.is_ok(),
        "own server task must join without runtime cleanup"
    );
    assert!(
        peer_ended,
        "neither EOF nor reset before peer cleanup: {peer_end:?}"
    );
    let expected = if cancel {
        ConnectError::Cancelled
    } else if callback {
        ConnectError::NetworkTimeout
    } else {
        ConnectError::AuthTimeout
    };
    assert_eq!(connect_error(result), expected);
}

#[tokio::test]
async fn controlled_connect_pending_policy_cancel_drops_callback() {
    callback_or_auth_stall(true, true).await;
}
#[tokio::test]
async fn controlled_connect_pending_policy_network_deadline_drops_callback() {
    callback_or_auth_stall(true, false).await;
}
#[tokio::test]
async fn controlled_connect_silent_password_cancel_aborts_socket() {
    callback_or_auth_stall(false, true).await;
}
#[tokio::test]
async fn controlled_connect_silent_password_auth_deadline_aborts_socket() {
    callback_or_auth_stall(false, false).await;
}

struct EndingPasswordServer;

impl russh::server::Handler for EndingPasswordServer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        _: &str,
        _: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        // The peer ends the session instead of answering, as a server does
        // after too many failed attempts or when the network drops.
        Err(russh::Error::Disconnect)
    }
}

#[tokio::test]
async fn a_session_ending_during_password_auth_is_a_connection_error() {
    let (listener, spec) = listener().await;
    let (policy, _) = policy(None);
    let server = tokio::spawn(async move {
        let (peer, _) = listener.accept().await?;
        russh::server::run_stream(server_config(), peer, EndingPasswordServer)
            .await?
            .await
    });
    let control = ConnectControl::new(ConnectLimits {
        total: TEST_END,
        network: TEST_END,
        auth: TEST_END,
        tofu: TEST_END,
    });
    let result = timeout(
        TEST_END,
        RusshTransport::connect_controlled(&spec, policy, password(), control),
    )
    .await
    .unwrap();
    let error = match result {
        Ok(_) => panic!("unexpected connected transport"),
        Err(error) => error,
    };
    // Not "method not offered": the server never answered the request.
    assert!(
        matches!(
            error.downcast_ref::<AuthError>(),
            Some(AuthError::HostUnreachable)
        ),
        "{error:#}"
    );
    let _ = timeout(TEST_END, server).await.unwrap();
}

async fn late_key_worker(cancel: bool) {
    let pool = Arc::new(BlockingPool::new(1, 1));
    let (listener, spec) = listener().await;
    let mut budget = limits();
    if !cancel {
        budget.total = Duration::from_millis(150);
    }
    let control = ConnectControl::new(budget);
    let worker_entered = Arc::new(Notify::new());
    let entered = worker_entered.clone();
    let (release, wait) = std::sync::mpsc::channel();
    let (ended, worker_ended) = oneshot::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let connector_calls = calls.clone();
    let child_pool = pool.clone();
    let child_control = control.clone();
    let (policy, _) = policy(None);
    let mut task = tokio::spawn(async move {
        let address = (spec.hostname.clone(), spec.port);
        RusshTransport::connect_with(
            &spec,
            policy,
            password(),
            child_control,
            &child_pool,
            move |method| {
                entered.notify_one();
                wait.recv_timeout(TEST_END).unwrap();
                let result = prepare_auth_owned(method);
                let _ = ended.send(());
                result
            },
            move || {
                connector_calls.fetch_add(1, Ordering::SeqCst);
                TcpStream::connect(address)
            },
        )
        .await
    });
    timeout(TEST_END, worker_entered.notified()).await.unwrap();
    if cancel {
        control.cancel();
    }
    assert_eq!(
        connect_error(timeout(TEST_END, &mut task).await.unwrap().unwrap()),
        if cancel {
            ConnectError::Cancelled
        } else {
            ConnectError::DeadlineExceeded
        }
    );
    let busy = pool
        .prepare(
            password(),
            &ConnectControl::new(limits()),
            prepare_auth_owned,
        )
        .await;
    assert!(
        matches!(busy, Err(error) if error.downcast_ref::<ConnectError>() == Some(&ConnectError::PreparationBusy))
    );
    release.send(()).unwrap();
    timeout(TEST_END, worker_ended).await.unwrap().unwrap();
    // The connect caller has joined, but its uninterruptible blocking worker
    // was deliberately detached on timeout/cancel. Observe closure completion
    // and both retained permits returning; this is not a claimed worker Join.
    timeout(TEST_END, async {
        loop {
            if pool.admitted.available_permits() == 1 && pool.workers.available_permits() == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(timeout(Duration::from_millis(50), listener.accept())
        .await
        .is_err());
}

#[tokio::test]
async fn controlled_connect_cancelled_key_worker_cannot_start_tcp_and_retains_capacity() {
    late_key_worker(true).await;
}

#[tokio::test]
async fn controlled_connect_expired_key_worker_cannot_start_tcp_and_retains_capacity() {
    late_key_worker(false).await;
}

#[tokio::test]
async fn controlled_preparation_queue_wait_uses_reserved_total_deadline() {
    let pool = BlockingPool::new(1, 2);
    let occupied = pool.workers.clone().acquire_owned().await.unwrap();
    let mut budget = limits();
    budget.total = Duration::from_millis(50);
    let control = ConnectControl::new(budget);
    let result = pool
        .prepare(password(), &control, |_| {
            panic!("expired queued preparation must never start a blocking worker")
        })
        .await;
    assert!(
        matches!(result, Err(error) if error.downcast_ref::<ConnectError>() == Some(&ConnectError::DeadlineExceeded))
    );
    assert_eq!(
        pool.admitted.available_permits(),
        2,
        "cancelled queue admission is released"
    );
    drop(occupied);
}

async fn late_resolver(expected: ConnectError) {
    let pool = Arc::new(BlockingPool::new(1, 1));
    let (listener, mut spec) = listener().await;
    let resolved = listener.local_addr().unwrap();
    spec.hostname = "stalled-resolver.fixture.invalid".into();
    let mut budget = limits();
    if expected == ConnectError::NetworkTimeout {
        budget.network = Duration::from_millis(150);
    } else if expected == ConnectError::DeadlineExceeded {
        budget.total = Duration::from_millis(150);
        budget.network = Duration::from_secs(2);
    }
    let control = ConnectControl::new(budget);
    let entered = Arc::new(Notify::new());
    let worker_entered = entered.clone();
    let (release, wait) = std::sync::mpsc::channel();
    let (ended, worker_ended) = oneshot::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let tcp_calls = calls.clone();
    let child_pool = pool.clone();
    let child_control = control.clone();
    let (policy, _) = policy(None);
    let mut task = tokio::spawn(async move {
        let resolver_control = child_control.clone();
        RusshTransport::connect_with(
            &spec,
            policy,
            password(),
            child_control,
            &PREPARATION_POOL,
            prepare_auth_owned,
            || {
                resolve_and_connect(
                    &spec,
                    &resolver_control,
                    &child_pool,
                    move |host, _| {
                        assert_eq!(host, "stalled-resolver.fixture.invalid");
                        worker_entered.notify_one();
                        wait.recv_timeout(TEST_END).unwrap();
                        let _ = ended.send(());
                        Ok(vec![resolved])
                    },
                    move |address| {
                        tcp_calls.fetch_add(1, Ordering::SeqCst);
                        TcpStream::connect(address)
                    },
                )
            },
        )
        .await
    });
    timeout(TEST_END, entered.notified()).await.unwrap();
    if expected == ConnectError::Cancelled {
        control.cancel();
    }
    assert_eq!(
        connect_error(timeout(TEST_END, &mut task).await.unwrap().unwrap()),
        expected
    );
    // The unresolved job remains admitted even though the host/connect caller
    // has finished. Repeating cancelled connects cannot grow Tokio's queue.
    let capacity = pool
        .run(
            &ConnectControl::new(limits()),
            ConnectError::NetworkCapacity,
            ConnectError::ResolverFailed,
            || Ok(()),
        )
        .await;
    assert!(
        matches!(capacity, Err(error) if error.downcast_ref::<ConnectError>() == Some(&ConnectError::NetworkCapacity))
    );
    release.send(()).unwrap();
    timeout(TEST_END, worker_ended).await.unwrap().unwrap();
    // Observe the actual blocking closure's completion/permit release; its
    // abandoned JoinHandle is not claimed to have been explicitly joined.
    timeout(TEST_END, async {
        while pool.admitted.available_permits() != 1 || pool.workers.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "late DNS cannot initiate TCP"
    );
    assert!(timeout(Duration::from_millis(50), listener.accept())
        .await
        .is_err());
}

#[tokio::test]
async fn controlled_resolver_cancel_retains_capacity_and_never_connects_late() {
    late_resolver(ConnectError::Cancelled).await;
}

#[tokio::test]
async fn controlled_resolver_network_deadline_retains_capacity_and_never_connects_late() {
    late_resolver(ConnectError::NetworkTimeout).await;
}

#[tokio::test]
async fn controlled_resolver_total_deadline_retains_capacity_and_never_connects_late() {
    late_resolver(ConnectError::DeadlineExceeded).await;
}

#[tokio::test]
async fn controlled_resolver_queue_wait_consumes_network_budget() {
    let pool = BlockingPool::new(1, 2);
    let occupied = pool.workers.clone().acquire_owned().await.unwrap();
    let mut budget = limits();
    budget.network = Duration::from_millis(50);
    let control = ConnectControl::new(budget);
    let spec = HostSpec {
        hostname: "queued-resolver.fixture.invalid".into(),
        port: 22,
        user: "fixture".into(),
    };
    let result = control
        .wait_network(resolve_and_connect(
            &spec,
            &control,
            &pool,
            |_, _| panic!("queued resolver must not start after network deadline"),
            |_| std::future::ready(Err(std::io::Error::other("TCP must not start"))),
        ))
        .await;
    assert!(matches!(result, Err(ConnectError::NetworkTimeout)));
    assert_eq!(pool.admitted.available_permits(), 2);
    drop(occupied);
}

#[tokio::test]
async fn controlled_ip_literals_bypass_resolver_admission_entirely() {
    for hostname in ["127.0.0.1", "::1"] {
        let pool = BlockingPool::new(0, 0);
        let control = ConnectControl::new(limits());
        let spec = HostSpec {
            hostname: hostname.into(),
            port: 1234,
            user: "fixture".into(),
        };
        let mut attempted = Vec::new();
        let result = control
            .wait_network(resolve_and_connect(
                &spec,
                &control,
                &pool,
                |_, _| panic!("an IP literal must not use a resolver worker"),
                |address| {
                    attempted.push(address);
                    std::future::ready(Err(std::io::Error::from(
                        std::io::ErrorKind::ConnectionRefused,
                    )))
                },
            ))
            .await
            .unwrap();
        assert!(result.is_err());
        assert_eq!(
            attempted,
            vec![SocketAddr::new(hostname.parse().unwrap(), 1234)]
        );
    }
}

#[tokio::test]
async fn controlled_resolver_preserves_address_order_and_connects_fallback() {
    // A bound but non-listening socket reserves a guaranteed refused first
    // destination, rather than guessing a supposedly unused global port.
    // macOS silently drops a SYN to such a socket, so the connect would run
    // into the deadline instead; there the port is released again, and the
    // kernel refuses it with RST unless another process takes exactly this
    // ephemeral port in between.
    let refused = tokio::net::TcpSocket::new_v4().unwrap();
    refused.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let first = refused.local_addr().unwrap();
    #[cfg(target_os = "macos")]
    drop(refused);
    let (listener, mut spec) = listener().await;
    let second = listener.local_addr().unwrap();
    spec.hostname = "ordered-resolver.fixture.invalid".into();
    // Windows can take roughly two seconds to finish a refused loopback
    // connect. This success/fallback case needs room for the real OS failure;
    // the separate deadline cases retain their short injected budgets.
    let control = ConnectControl::new(ConnectLimits {
        total: TEST_END,
        network: TEST_END,
        ..limits()
    });
    let pool = BlockingPool::new(1, 1);
    let mut attempted = Vec::new();
    let stream = control
        .wait_network(resolve_and_connect(
            &spec,
            &control,
            &pool,
            move |host, _| {
                assert_eq!(host, "ordered-resolver.fixture.invalid");
                Ok(vec![first, second])
            },
            |address| {
                attempted.push(address);
                async move {
                    let started = std::time::Instant::now();
                    let result = TcpStream::connect(address).await;
                    if address == first {
                        println!("first fallback address: elapsed={:?}, error={:?}", started.elapsed(), result.as_ref().err());
                        assert!(matches!(&result, Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused));
                    }
                    result
                }
            },
        ))
        .await
        .unwrap()
        .unwrap();
    let (mut peer, _) = timeout(TEST_END, listener.accept()).await.unwrap().unwrap();
    assert_eq!(attempted, vec![first, second]);
    assert_eq!(stream.peer_addr().unwrap(), second);
    drop(stream);
    assert_eq!(
        timeout(TEST_END, peer.read(&mut [0; 1]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn controlled_resolver_fallback_cannot_reset_an_exhausted_network_budget() {
    let pool = BlockingPool::new(1, 1);
    let control = ConnectControl::new(limits());
    let spec = HostSpec {
        hostname: "expired-fallback.fixture.invalid".into(),
        port: 22,
        user: "fixture".into(),
    };
    let mut calls = 0;
    let result = control
        .wait_network(resolve_and_connect(
            &spec,
            &control,
            &pool,
            |_, _| {
                Ok(vec![
                    "127.0.0.1:1".parse().unwrap(),
                    "127.0.0.1:2".parse().unwrap(),
                ])
            },
            |_| {
                calls += 1;
                // Deliberately cross the deadline inside one ready poll. The next
                // fallback must check the same clock before initiating any TCP.
                std::thread::sleep(Duration::from_millis(380));
                std::future::ready(Err(std::io::Error::from(
                    std::io::ErrorKind::ConnectionRefused,
                )))
            },
        ))
        .await;
    assert!(matches!(result, Err(ConnectError::NetworkTimeout)));
    assert_eq!(calls, 1);
}

/// Vertraut jedem Schluessel und zaehlt, wie oft russh die Policy fragt.
struct CountingPolicy(Arc<AtomicUsize>);

#[async_trait]
impl HostKeyPolicy for CountingPolicy {
    async fn decide(&self, _: &str, _: u16, _: &str, _: &str) -> bool {
        self.0.fetch_add(1, Ordering::SeqCst);
        true
    }
}

/// Hat der Server so viele Bytes geschrieben, beginnt er einen neuen
/// Schluesselaustausch mit demselben Hostschluessel.
const REKEY_WRITE_LIMIT: usize = 32 * 1024;
const LARGE_OUTPUT: usize = REKEY_WRITE_LIMIT + REKEY_WRITE_LIMIT / 2;

/// Jeder Austausch rechnet auf beiden Seiten in einer 3072-Bit-Gruppe; im
/// Debug-Build dauert der Test so einige Sekunden. Die Frist faengt nur ein
/// Haengen ab und darf auf einem belasteten CI-Runner nicht vorher greifen.
const REKEY_TEST_END: Duration = Duration::from_secs(60);

/// Nimmt jedes Passwort an und beantwortet den Exec "large" mit mehr Bytes
/// als `REKEY_WRITE_LIMIT`, jeden anderen mit "small". `exchanges` zaehlt die
/// Schluesselaustausche: der Server bietet nur den
/// Diffie-Hellman-Gruppenaustausch an, und dessen Gruppe holt russh bei jedem
/// Austausch, dem ersten wie jedem Rekey, beim Handler.
struct RekeyServer {
    exchanges: Arc<AtomicUsize>,
}

impl russh::server::Handler for RekeyServer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        _: &str,
        _: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        command: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let output = if command == b"large" {
            vec![b'r'; LARGE_OUTPUT]
        } else {
            b"small".to_vec()
        };
        session.data(channel, output)?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)
    }

    async fn lookup_dh_gex_group(
        &mut self,
        _: &russh::client::GexParams,
    ) -> Result<Option<russh::kex::dh::groups::DhGroup>, Self::Error> {
        self.exchanges.fetch_add(1, Ordering::SeqCst);
        // Die kleinste Gruppe, die der Client annimmt (mindestens 3072 Bit).
        Ok(Some(russh::kex::dh::groups::DH_GROUP15))
    }
}

/// russh 0.63.2 ruft `check_server_key` nur beim ersten
/// Schluesselaustausch. Ein Rekey mit demselben Hostschluessel laesst die
/// Sitzung nutzbar und fragt die Policy nicht erneut. Ruft ein kuenftiges
/// russh sie auch beim Rekey, faellt dieser Test auf; dann muessen Policy und
/// Zeitbudget neu entworfen werden (siehe `Handler::check_server_key`).
#[tokio::test]
async fn a_same_key_rekey_keeps_the_session_usable_and_asks_the_policy_once() {
    let (listener, spec) = listener().await;
    let exchanges = Arc::new(AtomicUsize::new(0));
    let config = Arc::new(russh::server::Config {
        limits: russh::Limits::new(REKEY_WRITE_LIMIT, 1 << 30, Duration::from_secs(3600)),
        preferred: russh::Preferred {
            kex: std::borrow::Cow::Borrowed(&[
                russh::kex::DH_GEX_SHA256,
                russh::kex::EXTENSION_SUPPORT_AS_SERVER,
                russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
            ]),
            ..Default::default()
        },
        ..server_settings()
    });
    let handler = RekeyServer {
        exchanges: exchanges.clone(),
    };
    let server = tokio::spawn(async move {
        let (peer, _) = listener.accept().await?;
        russh::server::run_stream(config, peer, handler)
            .await?
            .await
    });
    let decisions = Arc::new(AtomicUsize::new(0));
    let transport = timeout(
        REKEY_TEST_END,
        RusshTransport::connect(
            &spec,
            Arc::new(CountingPolicy(decisions.clone())),
            &password(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(exchanges.load(Ordering::SeqCst), 1);
    assert_eq!(decisions.load(Ordering::SeqCst), 1);

    let large = timeout(
        REKEY_TEST_END,
        transport.exec_controlled("large", OperationControl::new(REKEY_TEST_END)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!((large.code, large.stdout.len()), (0, LARGE_OUTPUT));
    // Der Rekey beginnt nach der grossen Ausgabe. Die Antwort auf diesen Exec
    // haelt der Server zurueck, bis der Austausch abgeschlossen ist.
    let small = timeout(
        REKEY_TEST_END,
        transport.exec_controlled("small", OperationControl::new(REKEY_TEST_END)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!((small.code, small.stdout.as_str()), (0, "small"));
    assert_eq!(
        exchanges.load(Ordering::SeqCst),
        2,
        "the server did not rekey exactly once"
    );
    assert_eq!(decisions.load(Ordering::SeqCst), 1);
    assert!(transport.is_usable());
    transport.abort();
    let _ = timeout(REKEY_TEST_END, server).await.unwrap();
}
