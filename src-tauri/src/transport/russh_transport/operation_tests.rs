//! Real local SSH peers; no shell, tmux process, external host or user secrets.
//! Each case joins its test task, server session, and any fixture data producer.

use super::pty_output::WINDOW;
use super::{PtyHandle, PtyOutputReceiver, RusshTransport, SLOT_WAIT};
use crate::ssh::auth::AuthMethod;
use crate::transport::{
    ConnectControl, ConnectLimits, ExecError, ExecPhase, ExecReason, HostKeyPolicy, HostSpec,
    OperationControl, PtyError, PtyPhase, PtyReason, Submission, Transport,
};
use async_trait::async_trait;
use russh::keys::PublicKeyBase64;
use russh::server::{ChannelOpenHandle, Msg, Session};
use russh::{Channel, ChannelId, ChannelWriteHalf};
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout, Instant};
use zeroize::Zeroizing;

const END: Duration = Duration::from_secs(5);
const BODY_END: Duration = Duration::from_secs(12);
const CHUNK: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    DelayedEndlessExec,
    MissingExit,
    SuccessfulExec,
    Utf8Output {
        invalid_stdout: bool,
        invalid_stderr: bool,
        code: u32,
    },
    ExcessOutput,
    HoldOpen,
    NoPtyAck,
    NoAttachAck,
    StallClose,
    EndAtAck {
        attach: bool,
        after: bool,
        end: EndKind,
    },
    TailPty(EndKind),
    NaturalEndPty,
    ExitWithoutBoundary,
    EarlyPty,
    ZeroWindow,
    BlockDispatcher,
    Echo,
    WrapperFirst,
    /// Accepts PTY and exec, then sends nothing and keeps the channel open.
    SilentAttach,
    /// Jedes Anhaengen flutet `flood_byte`s, so schnell sein Fenster es
    /// zulaesst: endlos oder `total` Bytes, danach Exit 0, EOF und Close.
    Flood {
        total: Option<usize>,
    },
    /// Ein Anhaengen, dessen Befehl "flood" nennt, flutet endlos; jedes
    /// andere meldet "attached\n" und gibt Eingaben zurueck.
    FloodBesideEcho,
    /// Ein Exec antwortet mit `EXEC_FLOOD` Bytes `exec_byte`, dann Exit 0.
    LargeExec,
}

/// Ein Schreibaufruf der Flut. Weder eine Stueck- noch eine Paketgroesse
/// teilt ihn, so liegen Zusammenlegen und Aufteilen an wechselnden Stellen.
const FLOOD_CHUNK: usize = 7 * 1024 + 3;

/// Mehr als das anfaengliche Fenster eines Execs (russh-Vorgabe 2 MiB) und
/// weniger als dessen Ausgabegrenze (4 MiB).
const EXEC_FLOOD: usize = 3 * 1024 * 1024;

/// Das Byte jeder Flut an der Stromposition `offset`.
fn flood_byte(offset: usize) -> u8 {
    (offset % 251) as u8
}

/// Wie `flood_byte`, aber ASCII: Exec-Ausgabe kommt als Text an.
fn exec_byte(offset: usize) -> u8 {
    b'a' + (offset % 26) as u8
}

/// Prueft, dass `chunk` die Flut an `offset` fortsetzt, und rueckt vor.
fn expect_flood(chunk: &[u8], offset: &mut usize) {
    for byte in chunk {
        assert_eq!(
            *byte,
            flood_byte(*offset),
            "flood byte {offset} out of order"
        );
        *offset += 1;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EndKind {
    Eof,
    ExitZero,
    Signal,
    Close,
}

fn send_end(session: &mut Session, channel: ChannelId, end: EndKind) -> Result<(), russh::Error> {
    match end {
        EndKind::Eof => session.eof(channel),
        EndKind::ExitZero => session.exit_status_request(channel, 0),
        EndKind::Signal => session.exit_signal_request(channel, russh::Sig::TERM, false, "", ""),
        EndKind::Close => session.close(channel),
    }
}

fn tail(index: u8) -> Vec<u8> {
    vec![index, 0, 0xff, b'\r', 0xc3, 0x28]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PeerEnd {
    Eof,
    IoError(io::ErrorKind),
}

struct Observations {
    opens: AtomicUsize,
    ptys: AtomicUsize,
    execs: AtomicUsize,
    closes: AtomicUsize,
    inputs: AtomicUsize,
    resizes: AtomicUsize,
    produced: AtomicUsize,
    handler_dropped: AtomicBool,
    io_dropped: AtomicBool,
    io_end: Mutex<Option<PeerEnd>>,
    close_gate: Semaphore,
    stop: watch::Sender<bool>,
    producers: Mutex<Vec<JoinHandle<()>>>,
    /// Je Kanal das groesste `new_size` aus `window_adjusted`: das Fenster,
    /// das dem russh-Server nach einem `WINDOW_ADJUST` des Clients bleibt,
    /// nachdem er zurueckgehaltene Bytes nachgesendet hat, nicht das
    /// gewaehrte. Also nur eine grobe Gegenprobe: Liegt es ueber einem
    /// Fenster, war schon das gewaehrte zu gross. Dass nie mehr als ein
    /// Fenster aussteht, belegen die Bytezaehlungen der Tests: Liest niemand,
    /// kommt genau ein Fenster an und bleibt, und nach jedem Lesen liegt
    /// hoechstens ein Fenster ungelesen an (`queued_bytes()`).
    windows: Mutex<HashMap<ChannelId, u32>>,
}

impl Observations {
    fn new() -> Arc<Self> {
        let (stop, _) = watch::channel(false);
        Arc::new(Self {
            opens: AtomicUsize::new(0),
            ptys: AtomicUsize::new(0),
            execs: AtomicUsize::new(0),
            closes: AtomicUsize::new(0),
            inputs: AtomicUsize::new(0),
            resizes: AtomicUsize::new(0),
            produced: AtomicUsize::new(0),
            handler_dropped: AtomicBool::new(false),
            io_dropped: AtomicBool::new(false),
            io_end: Mutex::new(None),
            close_gate: Semaphore::new(0),
            stop,
            producers: Mutex::new(Vec::new()),
            windows: Mutex::new(HashMap::new()),
        })
    }

    fn windows(&self) -> HashMap<ChannelId, u32> {
        self.windows.lock().unwrap().clone()
    }
}

/// Observe the actual protocol reader/writer; never race it with a TCP clone.
struct ObservedIo {
    inner: TcpStream,
    seen: Arc<Observations>,
}

impl AsyncRead for ObservedIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let remaining = buf.remaining();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        let end = match &result {
            Poll::Ready(Ok(())) if remaining > 0 && buf.filled().len() == before => {
                Some(PeerEnd::Eof)
            }
            Poll::Ready(Err(error)) => Some(PeerEnd::IoError(error.kind())),
            _ => None,
        };
        if let Some(end) = end {
            self.seen.io_end.lock().unwrap().get_or_insert(end);
        }
        result
    }
}

impl AsyncWrite for ObservedIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, bytes);
        if let Poll::Ready(Err(error)) = &result {
            self.seen
                .io_end
                .lock()
                .unwrap()
                .get_or_insert(PeerEnd::IoError(error.kind()));
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl Drop for ObservedIo {
    fn drop(&mut self) {
        self.seen.io_dropped.store(true, Ordering::SeqCst);
    }
}

struct FixturePolicy(String);

#[async_trait]
impl HostKeyPolicy for FixturePolicy {
    async fn decide(&self, host: &str, _: u16, _: &str, key: &str) -> bool {
        host == "127.0.0.1" && key == self.0
    }
}

struct FixtureServer {
    scenario: Scenario,
    seen: Arc<Observations>,
    delayed: mpsc::UnboundedSender<ChannelOpenHandle>,
    writers: HashMap<ChannelId, ChannelWriteHalf<Msg>>,
}

impl FixtureServer {
    fn produce(&mut self, channel: ChannelId, finite: bool) {
        let writer = self
            .writers
            .remove(&channel)
            .expect("owned accepted channel");
        let seen = self.seen.clone();
        let mut stop = seen.stop.subscribe();
        let task = tokio::spawn(async move {
            let mut sent = 0;
            loop {
                tokio::select! {
                    _ = stop.wait_for(|stopped| *stopped) => return,
                    result = writer.data_bytes(vec![b'x'; CHUNK]) => {
                        if result.is_err() { return; }
                    }
                }
                sent += CHUNK;
                seen.produced.fetch_add(CHUNK, Ordering::SeqCst);
                if finite && sent > 4 * 1024 * 1024 {
                    let _ = writer.exit_status(0).await;
                    let _ = writer.eof().await;
                    let _ = writer.close().await;
                    return;
                }
            }
        });
        self.seen.producers.lock().unwrap().push(task);
    }

    fn flood(&mut self, channel: ChannelId, total: Option<usize>, byte: fn(usize) -> u8) {
        let writer = self
            .writers
            .remove(&channel)
            .expect("owned accepted channel");
        let mut stop = self.seen.stop.subscribe();
        let task = tokio::spawn(async move {
            let mut sent = 0;
            loop {
                let len = total.map_or(FLOOD_CHUNK, |total| FLOOD_CHUNK.min(total - sent));
                if len == 0 {
                    let _ = writer.exit_status(0).await;
                    let _ = writer.eof().await;
                    let _ = writer.close().await;
                    return;
                }
                let bytes: Vec<u8> = (sent..sent + len).map(byte).collect();
                tokio::select! {
                    _ = stop.wait_for(|stopped| *stopped) => return,
                    result = writer.data_bytes(bytes) => {
                        if result.is_err() { return; }
                    }
                }
                sent += len;
            }
        });
        self.seen.producers.lock().unwrap().push(task);
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.seen.handler_dropped.store(true, Ordering::SeqCst);
    }
}

impl russh::server::Handler for FixtureServer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        Ok(
            if user == "fixture-user" && password == "operation-fixture-password" {
                russh::server::Auth::Accept
            } else {
                russh::server::Auth::reject()
            },
        )
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        let id = channel.id();
        let (reader, writer) = channel.split();
        // Handler callbacks consume client data. An unused channel receiver
        // must not fill and stall the real protocol loop during window updates.
        drop(reader);
        self.writers.insert(id, writer);
        self.seen.opens.fetch_add(1, Ordering::SeqCst);
        if matches!(
            self.scenario,
            Scenario::HoldOpen | Scenario::DelayedEndlessExec
        ) {
            self.delayed
                .send(reply)
                .expect("test owns delayed reply receiver");
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
        self.seen.ptys.fetch_add(1, Ordering::SeqCst);
        if let Scenario::EndAtAck {
            attach: false,
            after,
            end,
        } = self.scenario
        {
            if after {
                session.channel_success(channel)?;
            }
            send_end(session, channel, end)?;
            if !after {
                session.channel_success(channel)?;
            }
            return Ok(());
        }
        if self.scenario == Scenario::EarlyPty {
            session.data(channel, tail(0))?;
            session.extended_data(channel, 1, tail(1))?;
        }
        if self.scenario != Scenario::NoPtyAck {
            session.channel_success(channel)?;
        }
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen.execs.fetch_add(1, Ordering::SeqCst);
        if self.scenario == Scenario::BlockDispatcher && command == b"fixture-fill-output" {
            session.channel_success(channel)?;
            // Success + 99 Data fill the client's configured 100-message
            // channel queue. The next status is marked before its blocked send.
            for index in 0..99 {
                session.data(channel, vec![index])?;
            }
            session.exit_status_request(channel, 0)?;
            for index in 99..=255 {
                session.data(channel, vec![index])?;
            }
            return Ok(());
        }
        if let Scenario::EndAtAck {
            attach: true,
            after,
            end,
        } = self.scenario
        {
            if after {
                session.channel_success(channel)?;
            }
            send_end(session, channel, end)?;
            if !after {
                session.channel_success(channel)?;
            }
            return Ok(());
        }
        if self.scenario == Scenario::NoAttachAck {
            return Ok(());
        }
        if self.scenario == Scenario::EarlyPty {
            session.extended_data(channel, 1, tail(2))?;
        }
        session.channel_success(channel)?;
        match self.scenario {
            Scenario::EarlyPty => {
                session.data(channel, tail(3))?;
            }
            Scenario::SuccessfulExec => {
                session.data(channel, b"complete result".to_vec())?;
                session.exit_status_request(channel, 0)?;
                session.eof(channel)?;
                session.close(channel)?;
            }
            Scenario::Utf8Output {
                invalid_stdout,
                invalid_stderr,
                code,
            } => {
                // Valid non-ASCII spans packets. A real replacement character
                // and an invalid byte also render alike, but are distinct data.
                session.data(channel, b"Gr\xc3".to_vec())?;
                session.data(channel, b"\xbc\xc3\x9fe ".to_vec())?;
                for byte in if invalid_stdout {
                    b"\xff".as_slice()
                } else {
                    b"\xef\xbf\xbd".as_slice()
                } {
                    session.data(channel, vec![*byte])?;
                }
                session.extended_data(channel, 1, b"diagnostic ".to_vec())?;
                for byte in if invalid_stderr {
                    b"\xff".as_slice()
                } else {
                    b"\xef\xbf\xbd".as_slice()
                } {
                    session.extended_data(channel, 1, vec![*byte])?;
                }
                session.exit_status_request(channel, code)?;
                session.eof(channel)?;
                session.close(channel)?;
            }
            Scenario::MissingExit => {
                session.data(channel, b"complete bytes without exit status".to_vec())?;
                session.eof(channel)?;
                session.close(channel)?;
            }
            Scenario::ExcessOutput => self.produce(channel, true),
            Scenario::Flood { total } => self.flood(channel, total, flood_byte),
            Scenario::FloodBesideEcho
                if crate::remote::command::decoded_argv(&String::from_utf8_lossy(command))
                    .iter()
                    .any(|arg| arg.contains("flood")) =>
            {
                self.flood(channel, None, flood_byte)
            }
            Scenario::FloodBesideEcho => {
                session.data(channel, b"attached\n".to_vec())?;
            }
            Scenario::LargeExec => self.flood(channel, Some(EXEC_FLOOD), exec_byte),
            Scenario::Echo | Scenario::StallClose => {
                session.data(channel, b"attached\n".to_vec())?;
            }
            Scenario::WrapperFirst => {
                session.data(
                    channel,
                    b"W|0123456789abcdef0123456789abcdef|10|20|1000|3|/dev/pts/3\n\x00\xff"
                        .to_vec(),
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen.inputs.fetch_add(1, Ordering::SeqCst);
        if let Scenario::TailPty(end) = self.scenario {
            if matches!(end, EndKind::ExitZero | EndKind::Signal) {
                send_end(session, channel, end)?;
            }
            for index in 0..64 {
                if index % 2 == 0 {
                    session.data(channel, tail(index))?;
                } else {
                    session.extended_data(channel, 1, tail(index))?;
                }
            }
            if matches!(end, EndKind::Eof | EndKind::Close) {
                send_end(session, channel, end)?;
            } else {
                session.eof(channel)?;
            }
            if end != EndKind::Close {
                session.close(channel)?;
            }
            return Ok(());
        }
        if self.scenario == Scenario::NaturalEndPty {
            session.data(channel, tail(0))?;
            session.extended_data(channel, 1, tail(1))?;
            session.disconnect(russh::Disconnect::ByApplication, "fixture natural end", "")?;
            return Ok(());
        }
        if self.scenario == Scenario::ExitWithoutBoundary {
            session.exit_status_request(channel, 0)?;
            session.data(channel, tail(0))?;
            return Ok(());
        }
        session.data(channel, data.to_vec())?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _: ChannelId,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen.resizes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn window_adjusted(
        &mut self,
        channel: ChannelId,
        new_size: u32,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        // `new_size` ist schon um nachgesendete, zurueckgehaltene Bytes
        // verringert (`server/encrypted.rs`): das Restfenster.
        let mut windows = self.seen.windows.lock().unwrap();
        let largest = windows.entry(channel).or_insert(0);
        *largest = (*largest).max(new_size);
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen.closes.fetch_add(1, Ordering::SeqCst);
        if self.scenario == Scenario::StallClose {
            // russh has encoded its mandatory reply but cannot flush it until
            // this callback returns. This is a real missing on-wire close ACK.
            drop(self.seen.close_gate.acquire().await.unwrap());
        }
        self.writers.remove(&channel);
        Ok(())
    }
}

struct Peer {
    transport: Arc<RusshTransport>,
    seen: Arc<Observations>,
    delayed: mpsc::UnboundedReceiver<ChannelOpenHandle>,
    server: JoinHandle<Result<(), russh::Error>>,
}

impl Peer {
    async fn new(scenario: Scenario) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let spec = HostSpec {
            hostname: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            user: "fixture-user".into(),
        };
        let key = russh::keys::load_secret_key(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/rsa-signing/rsa2048-pkcs1.pem"),
            None,
        )
        .unwrap();
        let policy = Arc::new(FixturePolicy(key.public_key().public_key_base64()));
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            inactivity_timeout: None,
            // The russh server starts its keepalive timer before
            // authentication, and the russh client ends the session on a
            // GLOBAL_REQUEST it receives during authentication. Under load a
            // 30ms timer fires mid-handshake and the connect fails as "method
            // not offered: password". Only the deadline case asserts on live
            // keepalives, so only it enables them; it stays alive well beyond
            // three missed replies. That case keeps the race: under four
            // parallel test processes it failed its connect once in 50 runs.
            keepalive_interval: (scenario == Scenario::DelayedEndlessExec)
                .then_some(Duration::from_millis(30)),
            keepalive_max: 3,
            nodelay: true,
            window_size: match scenario {
                Scenario::ZeroWindow => 0,
                Scenario::BlockDispatcher => 16 * 1024,
                _ => 2 * 1024 * 1024,
            },
            ..Default::default()
        });
        let seen = Observations::new();
        let server_seen = seen.clone();
        let (tx, delayed) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (stream, _) = timeout(END, listener.accept())
                .await
                .expect("own accept deadline")?;
            russh::server::run_stream(
                config,
                ObservedIo {
                    inner: stream,
                    seen: server_seen.clone(),
                },
                FixtureServer {
                    scenario,
                    seen: server_seen,
                    delayed: tx,
                    writers: HashMap::new(),
                },
            )
            .await?
            .await
        });
        let result = timeout(
            END,
            RusshTransport::connect_controlled(
                &spec,
                policy,
                AuthMethod::Password(Zeroizing::new("operation-fixture-password".into())),
                ConnectControl::new(ConnectLimits {
                    total: END,
                    network: END,
                    auth: END,
                    tofu: END,
                }),
            ),
        )
        .await;
        let transport = match result {
            Ok(Ok(transport)) => Arc::new(transport),
            failed => {
                let cause = match failed {
                    Ok(Err(err)) => format!("{err:#}"),
                    _ => "outer deadline".to_string(),
                };
                // Connect's own abort closes the peer; explicitly join it even
                // when fixture setup fails rather than relying on runtime Drop.
                seen.close_gate.add_permits(1);
                seen.stop.send_replace(true);
                let mut server = server;
                let server_end = match timeout(END, &mut server).await {
                    Ok(end) => format!("{end:?}"),
                    Err(_) => {
                        server.abort();
                        let _ = server.await;
                        "server deadline".to_string()
                    }
                };
                panic!("own operation-test connection failed: {cause}; server: {server_end}");
            }
        };
        Self {
            transport,
            seen,
            delayed,
            server,
        }
    }

    async fn check<F, Fut>(mut self, body: F)
    where
        F: FnOnce(
            Arc<RusshTransport>,
            Arc<Observations>,
            mpsc::UnboundedReceiver<ChannelOpenHandle>,
        ) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (_, empty) = mpsc::unbounded_channel();
        let delayed = std::mem::replace(&mut self.delayed, empty);
        let mut task = tokio::spawn(body(self.transport.clone(), self.seen.clone(), delayed));
        let result = timeout(BODY_END, &mut task).await;
        if result.is_err() {
            task.abort();
            let _ = task.await;
        }
        // Cleanup executes after an assertion panic too: that panic is owned
        // by the joined body task, not allowed to detach the fixture peer.
        self.seen.close_gate.add_permits(1);
        self.seen.stop.send_replace(true);
        self.transport.abort();
        let disposed = timeout(END, self.transport.dispose()).await;
        let closed = timeout(END, self.transport.closed()).await;
        let server_end = timeout(END, &mut self.server).await;
        if server_end.is_err() {
            self.server.abort();
            let _ = self.server.await;
        }
        let producers = std::mem::take(&mut *self.seen.producers.lock().unwrap());
        let mut producers_joined = true;
        for mut producer in producers {
            match timeout(END, &mut producer).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => producers_joined = false,
                Err(_) => {
                    producers_joined = false;
                    producer.abort();
                    let _ = producer.await;
                }
            }
        }
        assert!(
            disposed.is_ok() && closed.is_ok(),
            "transport did not finish disposal"
        );
        assert!(
            matches!(server_end, Ok(Ok(_))),
            "server session did not join cleanly before fallback abort: {server_end:?}"
        );
        assert!(self.seen.handler_dropped.load(Ordering::SeqCst));
        assert!(self.seen.io_dropped.load(Ordering::SeqCst));
        assert!(
            producers_joined,
            "fixture producer did not observe explicit stop"
        );
        assert!(
            matches!(result, Ok(Ok(()))),
            "operation case failed: {result:?}"
        );
    }
}

async fn observed(counter: &AtomicUsize, minimum: usize) {
    timeout(END, async {
        while counter.load(Ordering::SeqCst) < minimum {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

/// Liest genau `len` Bytes: Pakete, die vor dem Lesen anliegen, kommen
/// zusammengelegt an, ihre Grenzen bedeuten nichts.
async fn read_bytes(output: &mut PtyOutputReceiver, len: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    while bytes.len() < len {
        let chunk = timeout(END, output.recv()).await.unwrap();
        bytes.extend(chunk.expect("output ended early"));
    }
    assert_eq!(bytes.len(), len, "more output than expected");
    bytes
}

/// Wartet, bis genau `bytes` Bytes ungelesen anliegen.
async fn queued(pty: &PtyHandle, bytes: usize) {
    timeout(END, async {
        while pty.data.queued_bytes() != bytes {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} bytes queued, not {bytes}", pty.data.queued_bytes()));
}

/// Wartet, bis die Gegenseite steht: 100 ms lang kommt nichts mehr an.
async fn settled(pty: &PtyHandle) -> usize {
    timeout(END, async {
        let mut last = pty.data.queued_bytes();
        let mut since = Instant::now();
        loop {
            sleep(Duration::from_millis(10)).await;
            let now = pty.data.queued_bytes();
            if now != last {
                (last, since) = (now, Instant::now());
            } else if since.elapsed() >= Duration::from_millis(100) {
                return now;
            }
        }
    })
    .await
    .unwrap()
}

fn exec_error(result: anyhow::Result<crate::transport::ExecResult>) -> ExecError {
    match result {
        Ok(_) => panic!("unexpected successful exec"),
        Err(error) => *error
            .downcast_ref::<ExecError>()
            .expect("typed exec failure"),
    }
}

fn pty_error<T>(result: anyhow::Result<T>) -> PtyError {
    match result {
        Ok(_) => panic!("unexpected PTY success"),
        Err(error) => *error.downcast_ref::<PtyError>().expect("typed PTY failure"),
    }
}

async fn assert_peer_ended_before_fixture_cleanup(seen: &Observations) {
    timeout(END, async {
        while !seen.io_dropped.load(Ordering::SeqCst) {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let end = *seen.io_end.lock().unwrap();
    println!("actual operation peer IO end: {end:?}");
    assert!(
        matches!(
            end,
            Some(
                PeerEnd::Eof
                    | PeerEnd::IoError(
                        io::ErrorKind::ConnectionReset
                            | io::ErrorKind::ConnectionAborted
                            | io::ErrorKind::BrokenPipe
                    )
            )
        ),
        "no observed EOF/reset/terminal IO error"
    );
    assert!(seen.handler_dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn operation_exec_uses_total_deadline_despite_open_delay_and_live_keepalives() {
    Peer::new(Scenario::DelayedEndlessExec)
        .await
        .check(|transport, seen, mut delayed| async move {
            let start = Instant::now();
            let control = OperationControl::with_deadline(start + Duration::from_millis(600));
            let query = transport.exec_controlled("synthetic-never-exits", control);
            tokio::pin!(query);
            // Poll both the real operation and the handler-provided delayed ACK.
            let reply = tokio::select! {
                result = &mut query => panic!("exec ended before Open ACK: {result:?}"),
                reply = delayed.recv() => reply.unwrap(),
            };
            sleep(Duration::from_millis(350)).await;
            reply.accept().await;
            let error = exec_error(query.await);
            assert_eq!(error.reason, ExecReason::Timeout);
            assert_eq!(error.submission, Submission::PossiblySubmitted);
            assert!(
                start.elapsed() < Duration::from_millis(800),
                "later phase restarted the deadline"
            );
            assert_eq!(seen.execs.load(Ordering::SeqCst), 1);
            assert!(
                !seen.handler_dropped.load(Ordering::SeqCst),
                "the SSH peer must still be live"
            );
            assert!(transport.is_usable());
            observed(&seen.closes, 1).await;
        })
        .await;
}

#[tokio::test]
async fn operation_exec_preserves_original_utf8_validity_and_known_exit_status() {
    for code in [0, 17] {
        for (invalid_stdout, invalid_stderr) in [(false, false), (true, false), (false, true)] {
            Peer::new(Scenario::Utf8Output {
                invalid_stdout,
                invalid_stderr,
                code,
            })
            .await
            .check(move |transport, seen, _| async move {
                let control = OperationControl::new(END);
                let result = transport
                    .exec_controlled("synthetic-utf8-result", control.clone())
                    .await
                    .unwrap();
                assert_eq!(result.code, code);
                assert_eq!(result.stdout, "Grüße \u{fffd}");
                assert_eq!(result.stderr, "diagnostic \u{fffd}");
                assert_eq!(result.utf8_valid, !invalid_stdout && !invalid_stderr);
                assert!(control.with_active(|| ()).is_ok());
                assert!(transport.is_usable());
                assert_eq!(seen.execs.load(Ordering::SeqCst), 1);
            })
            .await;
        }
    }
}

#[tokio::test]
async fn operation_exec_missing_exit_or_excess_output_never_returns_success() {
    Peer::new(Scenario::SuccessfulExec)
        .await
        .check(|transport, seen, _| async move {
            let control = OperationControl::new(END);
            for _ in 0..2 {
                let result = transport
                    .exec_controlled("successful-child", control.clone())
                    .await
                    .unwrap();
                assert_eq!(
                    (result.code, result.stdout.as_str()),
                    (0, "complete result")
                );
                assert!(
                    control.with_active(|| ()).is_ok(),
                    "normal child return cancelled shared parent"
                );
            }
            assert_eq!(seen.execs.load(Ordering::SeqCst), 2);
        })
        .await;
    for (scenario, expected) in [
        (Scenario::MissingExit, ExecReason::MissingExitStatus),
        (Scenario::ExcessOutput, ExecReason::OutputLimit),
    ] {
        Peer::new(scenario)
            .await
            .check(move |transport, seen, _| async move {
                let error = exec_error(
                    transport
                        .exec_controlled("synthetic-result", OperationControl::new(END))
                        .await,
                );
                assert_eq!(error.reason, expected);
                assert_eq!(error.submission, Submission::PossiblySubmitted);
                assert_eq!(seen.execs.load(Ordering::SeqCst), 1);
            })
            .await;
    }
}

#[tokio::test]
async fn operation_pending_exec_open_cancel_aborts_transport_without_submission() {
    for drop_caller in [false, true] {
        Peer::new(Scenario::HoldOpen)
        .await
        .check(move |transport, seen, mut delayed| async move {
            let control = OperationControl::new(END);
            let mut query = Box::pin(transport.exec_controlled("must-not-be-submitted", control.clone()));
            let held = tokio::select! {
                result = &mut query => panic!("unexpected result before open reply: {result:?}"),
                reply = delayed.recv() => reply.unwrap(),
            };
            if drop_caller {
                // Drop the actual allocated caller future, not just a Pin<&mut>.
                drop(query);
                assert!(control.is_cancelled());
                timeout(END, transport.closed()).await.unwrap();
            } else {
                control.cancel();
                let error = exec_error(query.await);
                assert_eq!((error.phase, error.reason, error.submission), (ExecPhase::Open, ExecReason::Cancelled, Submission::NotSubmitted));
            }
            assert!(!transport.is_usable());
            assert_eq!(seen.execs.load(Ordering::SeqCst), 0);
            assert_peer_ended_before_fixture_cleanup(&seen).await;
            drop(held); // only after observing the product's transport abort
        })
        .await;
    }
}

#[tokio::test]
async fn operation_cancelled_pty_open_accepts_late_ack_only_to_close_without_requests() {
    for drop_caller in [false, true] {
        Peer::new(Scenario::HoldOpen)
        .await
        .check(move |transport, seen, mut delayed| async move {
            let control = OperationControl::new(END);
            let mut opening = Box::pin(transport.open_attach_controlled("fixture", "own-session", 80, 24, control.clone()));
            let reply = tokio::select! {
                result = &mut opening => { let _ = result; panic!("PTY ended before open reply") },
                reply = delayed.recv() => reply.unwrap(),
            };
            if drop_caller {
                drop(opening);
                assert!(control.is_cancelled());
            } else {
                control.cancel();
                let error = pty_error(opening.await);
                assert_eq!((error.phase, error.reason), (PtyPhase::Open, PtyReason::Cancelled));
            }
            assert!(transport.is_usable());
            reply.accept().await;
            observed(&seen.closes, 1).await;
            assert_eq!(seen.ptys.load(Ordering::SeqCst), 0);
            assert_eq!(seen.execs.load(Ordering::SeqCst), 0);
            assert!(transport.is_usable());
        })
        .await;
    }
}

#[tokio::test]
async fn operation_pty_and_attach_each_require_actual_success_reply() {
    for (scenario, phase) in [
        (Scenario::NoPtyAck, PtyPhase::Request),
        (Scenario::NoAttachAck, PtyPhase::Attach),
    ] {
        Peer::new(scenario)
            .await
            .check(move |transport, seen, _| async move {
                let error = pty_error(
                    transport
                        .open_attach_controlled(
                            "fixture",
                            "own-session",
                            80,
                            24,
                            OperationControl::new(Duration::from_millis(350)),
                        )
                        .await,
                );
                assert_eq!((error.phase, error.reason), (phase, PtyReason::Timeout));
                assert_eq!(seen.ptys.load(Ordering::SeqCst), 1);
                assert_eq!(
                    seen.execs.load(Ordering::SeqCst),
                    usize::from(scenario == Scenario::NoAttachAck)
                );
                observed(&seen.closes, 1).await;
                assert!(transport.is_usable());
            })
            .await;
    }
}

#[tokio::test]
async fn operation_stalled_pty_closes_retain_eight_slots_without_aborting_terminal_transport() {
    Peer::new(Scenario::StallClose)
        .await
        .check(|transport, seen, _| async move {
            let mut ptys = Vec::new();
            for index in 0..8 {
                ptys.push(
                    transport
                        .open_attach_controlled(
                            "fixture",
                            &format!("own-{index}"),
                            80,
                            24,
                            OperationControl::new(END),
                        )
                        .await
                        .unwrap(),
                );
            }
            for pty in &ptys {
                pty.request_close();
            }
            observed(&seen.closes, 1).await;
            sleep(Duration::from_millis(2200)).await; // cross the real 2s cleanup deadline
            assert!(transport.is_usable());
            // Spec 2026-10-19 §8.1 (Schritt 3): Das neunte Oeffnen wartet auf
            // einen Platz, hoechstens SLOT_WAIT, und scheitert dann mit dem
            // bisherigen Fehler, ohne ein Open zu senden.
            let start = Instant::now();
            let error = pty_error(
                transport
                    .open_attach_controlled("fixture", "ninth", 80, 24, OperationControl::new(END))
                    .await,
            );
            assert!(
                start.elapsed() >= SLOT_WAIT,
                "the ninth open must wait for a slot first"
            );
            assert_eq!(
                (error.phase, error.reason),
                (PtyPhase::Admission, PtyReason::Capacity)
            );
            // Spec 2026-10-19 §8.3: diesen Rohtext erkennt das Frontend als
            // Kanalgrenze (`CAPACITY_ERRORS` in `src/views/grid.ts`).
            assert_eq!(
                error.to_string(),
                "Terminal operation failed during Admission: Capacity"
            );
            assert!(transport.is_usable());
            seen.close_gate.add_permits(1);
            observed(&seen.closes, 8).await;
            for pty in &ptys {
                timeout(END, pty.closed()).await.unwrap();
            }
            drop(ptys);
            // Die Gegenseite stand still; erst ein weiteres Oeffnen zeigt, dass
            // das abgewiesene kein Open gesendet hat: acht plus dieses eine.
            let after = transport
                .open_attach_controlled(
                    "fixture",
                    "after-close",
                    80,
                    24,
                    OperationControl::new(END),
                )
                .await
                .unwrap();
            assert_eq!(
                seen.opens.load(Ordering::SeqCst),
                9,
                "capacity rejection must not send Open"
            );
            after.close().await;
        })
        .await;
}

/// Flusskontrolle statt Ueberlauf: Liest niemand, sendet die Gegenseite genau
/// ein Fenster und wartet dann; der Kanal endet nicht. Was der Leser
/// entnimmt, geht an das Fenster zurueck, nie steht mehr als ein Fenster aus.
/// Schliessen wartet weiterhin nicht auf den Leser, und die ungelesenen Bytes
/// bleiben in Reihenfolge lesbar.
#[tokio::test]
async fn operation_unread_flood_stops_the_peer_at_one_window_and_closes_without_the_reader() {
    Peer::new(Scenario::Flood { total: None })
        .await
        .check(|transport, seen, _| async move {
            let mut pty = transport
                .open_attach_controlled("fixture", "own-flood", 80, 24, OperationControl::new(END))
                .await
                .unwrap();
            let window = WINDOW as usize;
            // Ohne Leser kommt genau ein Fenster an, dann steht die Gegenseite.
            queued(&pty, window).await;
            sleep(Duration::from_millis(200)).await;
            assert_eq!(
                pty.data.queued_bytes(),
                window,
                "the peer sent beyond its window"
            );
            assert_eq!(pty.end_snapshot().0, None);
            assert!(seen.windows().is_empty(), "nothing read, nothing returned");
            // Ein halbes Fenster lesen: so viel kommt nach, bis auf einen noch
            // nicht gemeldeten Rest unter 32 KiB.
            let mut offset = 0;
            while offset < window / 2 {
                let chunk = timeout(END, pty.data.recv()).await.unwrap().unwrap();
                expect_flood(&chunk, &mut offset);
                assert!(pty.data.queued_bytes() <= window);
            }
            let unread = settled(&pty).await;
            assert!(
                unread <= window && unread > window - 32 * 1024,
                "{unread} bytes unread after reading {offset}"
            );
            let windows = seen.windows();
            assert_eq!(windows.len(), 1, "the reader returned no credit");
            assert!(
                windows.values().all(|largest| *largest <= WINDOW),
                "the peer got more than one window: {windows:?}"
            );
            // Schliessen wartet nicht auf den Leser; was anliegt, bleibt lesbar.
            pty.request_close();
            observed(&seen.closes, 1).await;
            timeout(END, pty.closed()).await.unwrap();
            while let Some(chunk) = timeout(END, pty.data.recv()).await.unwrap() {
                expect_flood(&chunk, &mut offset);
            }
            assert_eq!(pty.end_snapshot().0, Some(PtyReason::Cancelled));
            assert!(transport.is_usable());
        })
        .await;
}

/// Eine endliche Flut, die erst niemand liest: Sobald der Leser alles
/// abnimmt, kommt jedes Byte in Reihenfolge an, danach das natuerliche Ende.
#[tokio::test]
async fn operation_finite_flood_arrives_complete_and_in_order_once_the_reader_drains() {
    const TOTAL: usize = 4 * 1024 * 1024 + 5;
    Peer::new(Scenario::Flood { total: Some(TOTAL) })
        .await
        .check(|transport, seen, _| async move {
            let mut pty = transport
                .open_attach_controlled(
                    "fixture",
                    "finite-flood",
                    80,
                    24,
                    OperationControl::new(END),
                )
                .await
                .unwrap();
            queued(&pty, WINDOW as usize).await;
            let mut offset = 0;
            while let Some(chunk) = timeout(END, pty.data.recv()).await.unwrap() {
                expect_flood(&chunk, &mut offset);
            }
            assert_eq!(offset, TOTAL);
            let (reason, end, drain_timed_out) = pty.end_snapshot();
            assert_eq!(
                (reason, end.exit_status, drain_timed_out),
                (None, Some(0), false)
            );
            observed(&seen.closes, 1).await;
            assert!(transport.is_usable());
        })
        .await;
}

/// Ein zweites Terminal derselben Verbindung antwortet zuegig, waehrend das
/// erste flutet und sein Leser so schnell abnimmt, wie er kann: beide teilen
/// sich Verbindung und Sitzungsschleife, das Fenster begrenzt den Vorlauf.
#[tokio::test]
async fn operation_second_pty_round_trips_promptly_while_a_sibling_floods() {
    Peer::new(Scenario::FloodBesideEcho)
        .await
        .check(|transport, _, _| async move {
            let mut flood = transport
                .open_attach_controlled("fixture", "flood-a", 80, 24, OperationControl::new(END))
                .await
                .unwrap();
            let mut echo = transport
                .open_attach_controlled("fixture", "echo-b", 80, 24, OperationControl::new(END))
                .await
                .unwrap();
            assert_eq!(read_bytes(&mut echo.data, 9).await, b"attached\n");
            let flooded = Arc::new(AtomicUsize::new(0));
            let progress = flooded.clone();
            let mut output = flood.take_output();
            let reader = tokio::spawn(async move {
                let mut offset = 0;
                while let Some(chunk) = output.recv().await {
                    expect_flood(&chunk, &mut offset);
                    progress.store(offset, Ordering::SeqCst);
                }
            });
            // Erst den Rueckstau von einem Fenster abnehmen: Danach kommt nur
            // noch an, was die Gegenseite waehrend der Runden neu sendet.
            timeout(END, async {
                while flooded.load(Ordering::SeqCst) < WINDOW as usize {
                    sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            let start = flooded.load(Ordering::SeqCst);
            let mut slowest = Duration::ZERO;
            let mut rounds = 0;
            // Mindestens 20 Runden, und solange, bis die Flut waehrenddessen
            // ein weiteres Fenster weit gelaufen ist.
            while rounds < 20 || flooded.load(Ordering::SeqCst) < start + WINDOW as usize {
                assert!(rounds < 5000, "the flood stalled");
                let line = format!("ping-{rounds}\n");
                let sent = Instant::now();
                echo.write(line.as_bytes()).await.unwrap();
                assert_eq!(
                    read_bytes(&mut echo.data, line.len()).await,
                    line.as_bytes()
                );
                slowest = slowest.max(sent.elapsed());
                rounds += 1;
            }
            assert!(
                slowest < Duration::from_millis(500),
                "slowest round trip {slowest:?} in {rounds} rounds"
            );
            assert_eq!(flood.end_snapshot().0, None);
            reader.abort();
            match reader.await {
                Err(ended) if ended.is_cancelled() => {}
                other => panic!("the flood reader ended on its own: {other:?}"),
            }
            flood.close().await;
            echo.close().await;
        })
        .await;
}

/// Acht flutende Terminals auf einer Verbindung: keines endet mit
/// `OutputLimit`, keine Warteschlange haelt mehr als ein Fenster, und jedes
/// liefert seine Bytes in Reihenfolge.
#[tokio::test]
async fn operation_eight_flooding_ptys_on_one_connection_never_hit_the_output_limit() {
    Peer::new(Scenario::Flood { total: None })
        .await
        .check(|transport, seen, _| async move {
            let window = WINDOW as usize;
            let mut ptys = Vec::new();
            for index in 0..8 {
                ptys.push(
                    transport
                        .open_attach_controlled(
                            "fixture",
                            &format!("flood-{index}"),
                            80,
                            24,
                            OperationControl::new(END),
                        )
                        .await
                        .unwrap(),
                );
            }
            // Ohne Leser steht jede Gegenseite nach genau einem Fenster.
            for pty in &ptys {
                queued(pty, window).await;
            }
            sleep(Duration::from_millis(200)).await;
            for pty in &ptys {
                assert_eq!(pty.data.queued_bytes(), window);
                assert_eq!(pty.end_snapshot().0, None);
            }
            // Jedes Terminal liest fuer sich und ohne Pause, wie seine Pumpe,
            // bis alle acht drei Fenster weit sind. Die russh-Gegenseite
            // dieser Tests nimmt keine Ausgabe mehr an, solange ein Kanal
            // ungesendete Daten hat (`vendor/russh/src/server/session.rs`):
            // Ein Leser, der wartet oder aufhoert, hielte alle anderen auf.
            let (stop, stopped) = watch::channel(false);
            let passed = Arc::new(AtomicUsize::new(0));
            let readers: Vec<_> = ptys
                .iter_mut()
                .map(|pty| {
                    let mut output = pty.take_output();
                    let mut stopped = stopped.clone();
                    let passed = passed.clone();
                    tokio::spawn(async move {
                        let mut offset = 0;
                        loop {
                            let chunk = tokio::select! {
                                _ = stopped.wait_for(|stopped| *stopped) => break,
                                chunk = timeout(END, output.recv()) => chunk.unwrap().unwrap(),
                            };
                            let before = offset;
                            expect_flood(&chunk, &mut offset);
                            assert!(output.queued_bytes() <= window);
                            if before < 3 * window && offset >= 3 * window {
                                passed.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        // Ein fallengelassener Leser beendete den Kanal.
                        output
                    })
                })
                .collect();
            timeout(2 * END, async {
                while passed.load(Ordering::SeqCst) < 8 {
                    sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            stop.send_replace(true);
            let mut outputs = Vec::new();
            for reader in readers {
                outputs.push(reader.await.unwrap());
            }
            for pty in &ptys {
                assert_eq!(pty.end_snapshot().0, None);
            }
            let windows = seen.windows();
            assert_eq!(windows.len(), 8, "every reader returned credit");
            assert!(
                windows.values().all(|largest| *largest <= WINDOW),
                "a peer got more than one window: {windows:?}"
            );
            assert!(transport.is_usable());
            for pty in &ptys {
                pty.close().await;
            }
            drop(outputs);
        })
        .await;
}

/// Exec-Kanaele behalten das selbsttaetige russh-Fenster: 3 MiB passen nicht
/// in das anfaengliche Fenster, kommen aber ohne jede Rueckgabe durch den
/// Leser an, und die Gegenseite bekommt mehr als ein Terminalfenster.
#[tokio::test]
async fn operation_exec_keeps_the_automatic_window() {
    Peer::new(Scenario::LargeExec)
        .await
        .check(|transport, seen, _| async move {
            let result = transport
                .exec_controlled("large-output", OperationControl::new(END))
                .await
                .unwrap();
            assert_eq!((result.code, result.stdout.len()), (0, EXEC_FLOOD));
            assert!(result
                .stdout
                .bytes()
                .enumerate()
                .all(|(offset, byte)| byte == exec_byte(offset)));
            let windows = seen.windows();
            assert!(
                windows.values().any(|largest| *largest > WINDOW),
                "the exec channel never got more than a terminal window: {windows:?}"
            );
        })
        .await;
}

/// Abnahmefund der Lastmessung vom 21.10.: `yes` in einer Kachel trennte den
/// Terminalkanal nach gut einer Sekunde. Die Gegenseite flutet hier mit
/// Loopback-Tempo, der Leser nimmt etwa 1 MB/s ab (so schnell hat das
/// Frontend eine geflutete Kachel bestaetigt: 0,9 MB in 1,1 s). Der Kanal muss
/// leben bleiben, und jedes Byte muss in Reihenfolge ankommen.
#[tokio::test]
async fn operation_flooded_pty_with_a_slow_reader_keeps_its_channel_and_byte_order() {
    Peer::new(Scenario::Flood { total: None })
        .await
        .check(|transport, _, _| async move {
            let mut pty = transport
                .open_attach_controlled("fixture", "flood", 80, 24, OperationControl::new(END))
                .await
                .unwrap();
            let mut offset = 0;
            let until = Instant::now() + Duration::from_millis(1500);
            while Instant::now() < until {
                let chunk = timeout(END, pty.data.recv())
                    .await
                    .unwrap()
                    .expect("the flood output ended");
                expect_flood(&chunk, &mut offset);
                assert_eq!(
                    pty.end_snapshot().0,
                    None,
                    "the flooded terminal ended after {offset} bytes"
                );
                sleep(Duration::from_micros(chunk.len() as u64)).await;
            }
            assert!(
                offset >= 512 * 1024,
                "the slow reader got only {offset} bytes"
            );
            pty.close().await;
        })
        .await;
}

#[tokio::test]
async fn operation_control_open_failure_preserves_independent_terminal_io_and_resize() {
    Peer::new(Scenario::Echo)
        .await
        .check(|terminal, terminal_seen, _| async move {
            let mut pty = terminal
                .open_attach_controlled(
                    "fixture",
                    "own-terminal",
                    80,
                    24,
                    OperationControl::new(END),
                )
                .await
                .unwrap();
            assert_eq!(
                timeout(END, pty.data.recv()).await.unwrap().unwrap(),
                b"attached\n"
            );
            Peer::new(Scenario::HoldOpen)
                .await
                .check(move |control, seen, mut delayed| async move {
                    let budget = OperationControl::new(END);
                    let query = control.exec_controlled("control-read", budget.clone());
                    tokio::pin!(query);
                    let held = tokio::select! {
                        result = &mut query => panic!("control ended before held open: {result:?}"),
                        reply = delayed.recv() => reply.unwrap(),
                    };
                    budget.cancel();
                    assert_eq!(exec_error(query.await).reason, ExecReason::Cancelled);
                    assert_peer_ended_before_fixture_cleanup(&seen).await;
                    drop(held);
                    assert!(!control.is_usable());
                    assert!(terminal.is_usable());
                    pty.write(b"still-live").await.unwrap();
                    assert_eq!(
                        timeout(END, pty.data.recv()).await.unwrap().unwrap(),
                        b"still-live"
                    );
                    pty.resize(101, 37).await.unwrap();
                    observed(&terminal_seen.resizes, 1).await;
                    observed(&terminal_seen.inputs, 1).await;
                    pty.request_close();
                    observed(&terminal_seen.closes, 1).await;
                })
                .await;
        })
        .await;
}

#[tokio::test]
async fn operation_decoded_end_before_or_beside_each_ack_never_hands_off() {
    for attach in [false, true] {
        for after in [false, true] {
            for end in [
                EndKind::Eof,
                EndKind::ExitZero,
                EndKind::Signal,
                EndKind::Close,
            ] {
                Peer::new(Scenario::EndAtAck { attach, after, end })
                    .await
                    .check(move |transport, seen, _| async move {
                        let error = pty_error(
                            transport
                                .open_attach_controlled(
                                    "fixture",
                                    "ended-ack",
                                    80,
                                    24,
                                    OperationControl::new(END),
                                )
                                .await,
                        );
                        assert_eq!(
                            error.reason,
                            PtyReason::Transport,
                            "{attach}/{after}/{end:?}"
                        );
                        assert_eq!(
                            error.phase,
                            if attach {
                                PtyPhase::Attach
                            } else {
                                PtyPhase::Request
                            }
                        );
                        assert_eq!(seen.execs.load(Ordering::SeqCst), usize::from(attach));
                        observed(&seen.closes, 1).await;
                        assert!(transport.is_usable());
                    })
                    .await;
            }
        }
    }
}

#[tokio::test]
async fn operation_early_data_and_extended_data_keep_original_order_across_both_acks() {
    Peer::new(Scenario::EarlyPty)
        .await
        .check(|transport, _, _| async move {
            let mut pty = transport
                .open_attach_controlled("fixture", "early", 80, 24, OperationControl::new(END))
                .await
                .unwrap();
            // Die fruehen Pakete liegen schon vor dem Lesen an und kommen
            // zusammengelegt, aber in Reihenfolge an.
            assert_eq!(
                read_bytes(&mut pty.data, 4 * tail(0).len()).await,
                (0..4).flat_map(tail).collect::<Vec<_>>()
            );
            pty.write(&tail(4)).await.unwrap();
            assert_eq!(timeout(END, pty.data.recv()).await.unwrap(), Some(tail(4)));
            pty.close().await;
        })
        .await;
}

#[tokio::test]
async fn operation_unread_binary_tail_outlives_the_owner_but_input_stops_at_decoded_end() {
    for end in [
        EndKind::Eof,
        EndKind::ExitZero,
        EndKind::Signal,
        EndKind::Close,
    ] {
        Peer::new(Scenario::TailPty(end))
            .await
            .check(move |transport, seen, _| async move {
                let mut pty = transport
                    .open_attach_controlled("fixture", "tail", 80, 24, OperationControl::new(END))
                    .await
                    .unwrap();
                pty.write(b"trigger").await.unwrap();
                timeout(END, pty.end_changed()).await.unwrap();
                assert!(pty.end_snapshot().1.has_end());
                assert!(pty.write(b"too late").await.is_err());
                assert!(pty.resize(99, 33).await.is_err());
                let tails: Vec<u8> = (0..64).flat_map(tail).collect();
                queued(&pty, tails.len()).await;
                // Besitzer und Close enden, waehrend der Empfaenger noch jedes
                // ungelesene Byte haelt.
                timeout(END, pty.closed()).await.unwrap();
                assert_eq!(read_bytes(&mut pty.data, tails.len()).await, tails);
                assert_eq!(timeout(END, pty.data.recv()).await.unwrap(), None);
                assert!(!pty.end_snapshot().2);
                assert_eq!(seen.inputs.load(Ordering::SeqCst), 1);
                assert_eq!(seen.resizes.load(Ordering::SeqCst), 0);
            })
            .await;
    }
}

#[tokio::test]
async fn operation_natural_transport_end_keeps_preceding_binary_output() {
    Peer::new(Scenario::NaturalEndPty)
        .await
        .check(|transport, _, _| async move {
            let mut pty = transport
                .open_attach_controlled(
                    "fixture",
                    "transport-tail",
                    80,
                    24,
                    OperationControl::new(END),
                )
                .await
                .unwrap();
            pty.write(b"trigger").await.unwrap();
            timeout(END, pty.end_changed()).await.unwrap();
            timeout(END, pty.closed()).await.unwrap();
            assert!(pty.write(b"late").await.is_err());
            // Beide Pakete lagen vor dem Lesen an: ein Stueck, in Reihenfolge.
            assert_eq!(pty.data.recv().await, Some([tail(0), tail(1)].concat()));
            assert_eq!(pty.data.recv().await, None);
            assert!(!pty.end_snapshot().2);
        })
        .await;
}

#[tokio::test]
async fn operation_exit_without_fifo_boundary_records_one_drain_timeout_and_keeps_bytes() {
    Peer::new(Scenario::ExitWithoutBoundary)
        .await
        .check(|transport, seen, _| async move {
            let mut pty = transport
                .open_attach_controlled(
                    "fixture",
                    "drain-timeout",
                    80,
                    24,
                    OperationControl::new(END),
                )
                .await
                .unwrap();
            let start = Instant::now();
            let probe = Arc::new(WriterProbe::default());
            pty.test_writer(PendingWriter {
                probe: probe.clone(),
                ready_polls: 0,
            })
            .await;
            let mut pending = Box::pin(pty.write(b"blocked input"));
            std::future::poll_fn(|cx| {
                assert!(pending.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            assert_eq!(probe.polls.load(Ordering::SeqCst), 1);
            // A distinct, genuine SSH send triggers remote exit while the
            // product's writer remains pending and exclusively serialized.
            pty.test_write_half()
                .data_bytes(b"trigger".to_vec())
                .await
                .unwrap();
            let error = timeout(END, pending).await.unwrap().unwrap_err();
            assert_eq!(
                error.downcast_ref::<PtyError>().unwrap().reason,
                PtyReason::Transport
            );
            assert!(probe.dropped.load(Ordering::SeqCst));
            assert!(probe.sent.lock().unwrap().is_empty());
            let ended_polls = probe.polls.load(Ordering::SeqCst);
            release_writer(&probe);
            timeout(END, pty.end_changed()).await.unwrap();
            assert_eq!(pty.end_snapshot().1.exit_status, Some(0));
            assert!(pty.write(b"late").await.is_err());
            assert_eq!(probe.polls.load(Ordering::SeqCst), ended_polls);
            assert_eq!(timeout(END, pty.data.recv()).await.unwrap(), Some(tail(0)));
            assert_eq!(timeout(END, pty.data.recv()).await.unwrap(), None);
            assert!(
                pty.end_snapshot().2,
                "missing FIFO end is separately observable"
            );
            assert_eq!(pty.end_snapshot().0, Some(PtyReason::Transport));
            assert!(start.elapsed() >= Duration::from_secs(2));
            observed(&seen.closes, 1).await;
            timeout(END, pty.closed()).await.unwrap();
            assert!(transport.is_usable());
        })
        .await;
}

#[derive(Default)]
struct WriterProbe {
    polls: AtomicUsize,
    sent: Mutex<Vec<usize>>,
    dropped: AtomicBool,
    released: AtomicBool,
    wake: Mutex<Option<std::task::Waker>>,
}

/// A controlled pending reservation, used only to prove ownership of the
/// persistent writer and that every resumed poll must pass the current gate.
struct PendingWriter {
    probe: Arc<WriterProbe>,
    ready_polls: usize,
}
impl Drop for PendingWriter {
    fn drop(&mut self) {
        self.probe.dropped.store(true, Ordering::SeqCst);
    }
}
impl AsyncWrite for PendingWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let count = self.probe.polls.fetch_add(1, Ordering::SeqCst);
        assert!(bytes.len() <= 16 * 1024, "one bounded admission");
        if count < self.ready_polls || self.probe.released.load(Ordering::SeqCst) {
            self.probe.sent.lock().unwrap().push(bytes.len());
            Poll::Ready(Ok(bytes.len()))
        } else {
            *self.probe.wake.lock().unwrap() = Some(cx.waker().clone());
            Poll::Pending
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn release_writer(probe: &WriterProbe) {
    probe.released.store(true, Ordering::SeqCst);
    let wake = probe.wake.lock().unwrap().take();
    if let Some(wake) = wake {
        wake.wake();
    }
}

#[tokio::test]
async fn operation_pending_writer_drop_deadline_and_local_stop_never_poll_a_late_send() {
    for mode in 0..3 {
        Peer::new(Scenario::Echo)
            .await
            .check(move |transport, seen, _| async move {
                let pty = transport
                    .open_attach_controlled(
                        "fixture",
                        "pending-input",
                        80,
                        24,
                        OperationControl::new(END),
                    )
                    .await
                    .unwrap();
                let probe = Arc::new(WriterProbe::default());
                pty.test_writer(PendingWriter {
                    probe: probe.clone(),
                    ready_polls: 1,
                })
                .await;
                let bytes = vec![1; 33 * 1024];
                let mut writing = Box::pin(
                    pty.test_write_until(&bytes, Instant::now() + Duration::from_millis(100)),
                );
                std::future::poll_fn(|cx| {
                    assert!(writing.as_mut().poll(cx).is_pending());
                    Poll::Ready(())
                })
                .await;
                assert_eq!(probe.polls.load(Ordering::SeqCst), 2);
                assert_eq!(*probe.sent.lock().unwrap(), vec![16 * 1024]);
                match mode {
                    0 => drop(writing),
                    1 => {
                        let error = writing.await.unwrap_err();
                        assert_eq!(
                            error.downcast_ref::<PtyError>().unwrap().reason,
                            PtyReason::Timeout
                        );
                    }
                    _ => {
                        pty.request_close();
                        release_writer(&probe);
                        assert!(writing.await.is_err());
                    }
                }
                assert!(probe.dropped.load(Ordering::SeqCst));
                let final_polls = probe.polls.load(Ordering::SeqCst);
                release_writer(&probe);
                assert!(pty.write(b"late").await.is_err());
                assert_eq!(probe.polls.load(Ordering::SeqCst), final_polls);
                assert_eq!(*probe.sent.lock().unwrap(), vec![16 * 1024]);
                observed(&seen.closes, 1).await;
                assert!(transport.is_usable());
                // The same terminal transport still serves a distinct PTY.
                let mut sibling = transport
                    .open_attach_controlled(
                        "fixture",
                        "sibling",
                        80,
                        24,
                        OperationControl::new(END),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    timeout(END, sibling.data.recv()).await.unwrap().unwrap(),
                    b"attached\n"
                );
                sibling.write(b"live sibling").await.unwrap();
                assert_eq!(
                    timeout(END, sibling.data.recv()).await.unwrap().unwrap(),
                    b"live sibling"
                );
                sibling.close().await;
            })
            .await;
    }
}

#[tokio::test]
async fn operation_input_deadline_covers_serializer_and_expiry_before_first_poll() {
    Peer::new(Scenario::Echo)
        .await
        .check(|transport, _, _| async move {
            let pty = transport
                .open_attach_controlled(
                    "fixture",
                    "input-deadline",
                    80,
                    24,
                    OperationControl::new(END),
                )
                .await
                .unwrap();
            let probe = Arc::new(WriterProbe::default());
            pty.test_writer(PendingWriter {
                probe: probe.clone(),
                ready_polls: 0,
            })
            .await;
            assert!(pty
                .test_write_until(b"expired", Instant::now())
                .await
                .is_err());
            assert_eq!(probe.polls.load(Ordering::SeqCst), 0);
            assert!(!probe.dropped.load(Ordering::SeqCst));
            let mut first = Box::pin(pty.write(b"blocked"));
            std::future::poll_fn(|cx| {
                assert!(first.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            let error = pty
                .test_write_until(b"queued", Instant::now() + Duration::from_millis(20))
                .await
                .unwrap_err();
            assert_eq!(
                error.downcast_ref::<PtyError>().unwrap().reason,
                PtyReason::Timeout
            );
            assert_eq!(probe.polls.load(Ordering::SeqCst), 1);
            assert!(
                !probe.dropped.load(Ordering::SeqCst),
                "queued caller does not own pending credits"
            );
            drop(first);
            assert!(probe.dropped.load(Ordering::SeqCst));
        })
        .await;
}

#[tokio::test]
async fn operation_zero_remote_window_input_is_cancellable_without_aborting_transport() {
    Peer::new(Scenario::ZeroWindow)
        .await
        .check(|transport, seen, _| async move {
            let pty = transport
                .open_attach_controlled(
                    "fixture",
                    "zero-window",
                    80,
                    24,
                    OperationControl::new(END),
                )
                .await
                .unwrap();
            let mut writing = Box::pin(pty.write(b"unsent"));
            tokio::select! {
                result = &mut writing => panic!("zero window must not send: {result:?}"),
                _ = sleep(Duration::from_millis(30)) => {},
            }
            drop(writing);
            assert!(pty.write(b"later").await.is_err());
            observed(&seen.closes, 1).await;
            assert_eq!(seen.inputs.load(Ordering::SeqCst), 0);
            assert!(transport.is_usable());
        })
        .await;
}

#[tokio::test]
async fn operation_four_unpublished_late_opens_keep_capacity_until_owned_cleanup() {
    Peer::new(Scenario::HoldOpen)
        .await
        .check(|transport, seen, mut delayed| async move {
            let mut held = Vec::new();
            for index in 0..4 {
                let control = OperationControl::new(END);
                let name = format!("unpublished-{index}");
                let mut opening = Box::pin(transport.open_attach_controlled(
                    "fixture",
                    &name,
                    80,
                    24,
                    control.clone(),
                ));
                held.push(tokio::select! {
                    result = &mut opening => panic!("must await owned Open: {}", result.is_ok()),
                    reply = delayed.recv() => reply.unwrap(),
                });
                control.cancel();
                assert_eq!(pty_error(opening.await).reason, PtyReason::Cancelled);
            }
            // Spec 2026-10-19 §8.1 (Schritt 3): Das fuenfte wartet auf eine
            // Erlaubnis, hoechstens SLOT_WAIT; die vier spaeten Kanaele halten
            // sie weiter, also Capacity, ohne ein Open zu senden.
            let start = Instant::now();
            let fifth = pty_error(
                transport
                    .open_attach_controlled("fixture", "fifth", 80, 24, OperationControl::new(END))
                    .await,
            );
            assert!(
                start.elapsed() >= SLOT_WAIT,
                "the fifth open must wait for a permit first"
            );
            assert_eq!(
                (fifth.phase, fifth.reason),
                (PtyPhase::Admission, PtyReason::Capacity)
            );
            assert_eq!(seen.opens.load(Ordering::SeqCst), 4);
            assert_eq!(seen.ptys.load(Ordering::SeqCst), 0);
            // Ein weiteres Oeffnen wartet ebenso. Erst das Close der spaeten
            // Kanaele gibt die Erlaubnisse frei; dann sendet es sein Open,
            // ohne neuen Versuch.
            let mut opening = Box::pin(transport.open_attach_controlled(
                "fixture",
                "after-cleanup",
                80,
                24,
                OperationControl::new(END),
            ));
            tokio::select! {
                result = &mut opening => panic!("must wait for an unpublished permit: {}", result.is_ok()),
                _ = sleep(Duration::from_millis(100)) => {},
            }
            assert_eq!(seen.opens.load(Ordering::SeqCst), 4);
            for reply in held {
                reply.accept().await;
            }
            let reply = tokio::select! {
                result = &mut opening => panic!("must send Open once a permit is free: {}", result.is_ok()),
                reply = delayed.recv() => reply.unwrap(),
            };
            reply.accept().await;
            let pty = opening.await.unwrap();
            pty.close().await;
            observed(&seen.closes, 5).await;
            assert_eq!(seen.opens.load(Ordering::SeqCst), 5);
            assert_eq!(seen.ptys.load(Ordering::SeqCst), 1);
            assert!(transport.is_usable());
        })
        .await;
}

#[tokio::test]
async fn operation_pending_pty_holds_unpublished_permit_until_drop() {
    Peer::new(Scenario::Echo)
        .await
        .check(|transport, seen, _| async move {
            let mut pending = Vec::new();
            for index in 0..4 {
                pending.push(
                    transport
                        .open_attach_pending_controlled(
                            "fixture",
                            &format!("pending-{index}"),
                            80,
                            24,
                            OperationControl::new(END),
                        )
                        .await
                        .unwrap(),
                );
            }
            // Spec 2026-10-19 §8.1 (Schritt 3): Das fuenfte wartet auf eine
            // Erlaubnis, statt abgewiesen zu werden. Fallenlassen eines
            // unveroeffentlichten gibt seine sofort frei, vor dem Close.
            let mut fifth = Box::pin(transport.open_attach_pending_controlled(
                "fixture",
                "fifth",
                80,
                24,
                OperationControl::new(END),
            ));
            tokio::select! {
                result = &mut fifth => panic!("must wait for an unpublished permit: {}", result.is_ok()),
                _ = sleep(Duration::from_millis(100)) => {},
            }
            drop(pending.pop());
            let extra = timeout(END, fifth).await.unwrap().unwrap();
            extra.request_close();
            extra.confirm().close().await;
            for held in pending {
                held.request_close();
                drop(held);
            }
            assert_eq!(seen.opens.load(Ordering::SeqCst), 5);
            assert!(transport.is_usable());
        })
        .await;
}

/// Spec 2026-10-19 §8.1 (Schritt 3): Ein Oeffnen, das auf einen Platz wartet,
/// endet sofort mit dem Abbruch seiner Operation (so wirkt `close_terminal`)
/// oder mit dem Ende des Transports, und es hat bis dahin nichts gesendet.
#[tokio::test]
async fn operation_waiting_open_ends_on_cancel_or_transport_end_without_open() {
    for end_transport in [false, true] {
        Peer::new(Scenario::Echo)
            .await
            .check(move |transport, seen, _| async move {
                let mut ptys = Vec::new();
                for index in 0..8 {
                    ptys.push(
                        transport
                            .open_attach_controlled(
                                "fixture",
                                &format!("own-{index}"),
                                80,
                                24,
                                OperationControl::new(END),
                            )
                            .await
                            .unwrap(),
                    );
                }
                let control = OperationControl::new(END);
                // Ab dem Oeffnen gemessen: endete das Warten erst mit
                // `SLOT_WAIT`, laege `elapsed` darueber.
                let start = Instant::now();
                let mut ninth = Box::pin(transport.open_attach_controlled(
                    "fixture",
                    "ninth",
                    80,
                    24,
                    control.clone(),
                ));
                tokio::select! {
                    result = &mut ninth => panic!("the ninth open must wait for a slot: {}", result.is_ok()),
                    _ = sleep(Duration::from_millis(100)) => {},
                }
                if end_transport {
                    transport.abort();
                } else {
                    control.cancel();
                }
                let error = pty_error(timeout(END, ninth).await.unwrap());
                assert!(
                    start.elapsed() < SLOT_WAIT,
                    "{end_transport}: the wait must end with its cause, not with SLOT_WAIT"
                );
                let expected = if end_transport {
                    PtyReason::Unavailable
                } else {
                    PtyReason::Cancelled
                };
                assert_eq!((error.phase, error.reason), (PtyPhase::Admission, expected));
                if end_transport {
                    // Erst wenn die Gegenseite zu Ende ist, steht ihre Zaehlung fest.
                    assert_peer_ended_before_fixture_cleanup(&seen).await;
                    assert_eq!(seen.opens.load(Ordering::SeqCst), 8);
                } else {
                    // Ein Platz wird frei; das naechste Oeffnen ist das neunte
                    // Open, das die Gegenseite sieht.
                    drop(ptys.pop());
                    let tenth = transport
                        .open_attach_controlled(
                            "fixture",
                            "tenth",
                            80,
                            24,
                            OperationControl::new(END),
                        )
                        .await
                        .unwrap();
                    assert_eq!(seen.opens.load(Ordering::SeqCst), 9);
                    tenth.close().await;
                    assert!(transport.is_usable());
                }
                drop(ptys);
            })
            .await;
    }
}

#[tokio::test]
async fn operation_pending_wrapper_strips_first_w_and_keeps_later_bytes() {
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    Peer::new(Scenario::WrapperFirst)
        .await
        .check(|transport, _, _| async move {
            let pending = transport
                .open_attach_pending(
                    super::attach_command_line("fixture", "wrap"),
                    80,
                    24,
                    OperationControl::new(END),
                    Some(NONCE),
                )
                .await
                .unwrap();
            let identity = pending.wait_wrapper().await.expect("W frame");
            assert_eq!(identity.pid, 10);
            assert_eq!(identity.tty, "/dev/pts/3");
            let mut pty = pending.confirm();
            let mut output = pty.take_output();
            let first = timeout(END, output.recv()).await.unwrap().unwrap();
            assert_eq!(first, [0, 0xff]);
            assert!(!first.starts_with(b"W|"));
            pty.close().await;
        })
        .await;
}

#[tokio::test]
async fn operation_pending_wrapper_wait_ends_with_the_operation_deadline() {
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    Peer::new(Scenario::SilentAttach)
        .await
        .check(|transport, _, _| async move {
            let pending = transport
                .open_attach_pending(
                    super::attach_command_line("fixture", "silent"),
                    80,
                    24,
                    OperationControl::new(Duration::from_millis(300)),
                    Some(NONCE),
                )
                .await
                .unwrap();
            // No W frame and no channel end: e.g. a shell rc file that waits
            // for input. The open must end with its operation, not hang.
            let waited = timeout(END, pending.wait_wrapper()).await;
            assert!(
                matches!(waited, Ok(None)),
                "wrapper wait must end at the operation deadline"
            );
            pending.request_close();
        })
        .await;
}

#[tokio::test]
async fn operation_real_full_outbound_queue_drops_reserved_write_without_late_send() {
    for cancel_caller in [false, true] {
        Peer::new(Scenario::BlockDispatcher)
            .await
            .check(move |transport, seen, _| async move {
                let pty = transport
                    .open_attach_controlled(
                        "fixture",
                        "queue-owner",
                        80,
                        24,
                        OperationControl::new(END),
                    )
                    .await
                    .unwrap();
                let (mut raw, raw_write) = pty.test_raw_channel().await.split();
                let raw_end = raw.end_observer().unwrap();
                raw_write
                    .exec(true, b"fixture-fill-output".as_slice())
                    .await
                    .unwrap();
                let blocked = timeout(END, raw_end.wait_ended()).await.unwrap();
                assert_eq!(blocked.exit_status, Some(0));
                assert!(!blocked.remote_eof && !blocked.remote_close);
                // The marker is decoded while its actual delivery is blocked
                // behind Success + 99 Data. No sleep or callback-count gate.
                let write = pty.test_write_half();
                for _ in 0..10 {
                    timeout(END, write.window_change(80, 24, 0, 0))
                        .await
                        .unwrap()
                        .unwrap();
                }
                let mut full = Box::pin(write.window_change(80, 24, 0, 0));
                std::future::poll_fn(|cx| {
                    assert!(
                        full.as_mut().poll(cx).is_pending(),
                        "actual outbound queue is full"
                    );
                    Poll::Ready(())
                })
                .await;
                drop(full);
                assert_eq!(write.writable_packet_size().await, 16 * 1024);
                let mut writing = Box::pin(pty.write(b"unsent"));
                std::future::poll_fn(|cx| {
                    assert!(writing.as_mut().poll(cx).is_pending());
                    Poll::Ready(())
                })
                .await;
                // Actual ChannelTx has already reserved positive window credit
                // and is waiting for reserve_owned; this is not a fake writer.
                assert_eq!(write.writable_packet_size().await, 16 * 1024 - 6);
                assert_eq!(seen.inputs.load(Ordering::SeqCst), 0);
                if cancel_caller {
                    drop(writing);
                } else {
                    pty.request_close();
                    assert!(writing.await.is_err());
                }
                // Let the genuine dispatcher and outbound queue proceed only
                // after invalidation destroyed the persistent pending writer.
                let mut count = 0;
                let mut status = false;
                timeout(END, async {
                    while count < 256 {
                        match raw.wait().await {
                            Some(russh::ChannelMsg::Data { data }) => {
                                assert_eq!(data.as_ref(), &[count as u8]);
                                count += 1;
                            }
                            Some(russh::ChannelMsg::Success) => {}
                            Some(russh::ChannelMsg::ExitStatus { exit_status: 0 }) => {
                                assert_eq!(count, 99);
                                assert!(!status);
                                status = true;
                            }
                            other => panic!("unexpected raw drain: {other:?}"),
                        }
                    }
                })
                .await
                .unwrap();
                assert!(status);
                observed(&seen.resizes, 10).await;
                observed(&seen.closes, 1).await;
                timeout(END, pty.closed()).await.unwrap();
                assert_eq!(seen.inputs.load(Ordering::SeqCst), 0);
                assert!(pty.write(b"late").await.is_err());
                timeout(END, raw_write.close()).await.unwrap().unwrap();
                timeout(END, async {
                    while !matches!(raw.wait().await, Some(russh::ChannelMsg::Close) | None) {}
                })
                .await
                .unwrap();
                drop(raw);
                assert!(transport.is_usable());
            })
            .await;
    }
}
