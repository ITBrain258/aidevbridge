//! Hermetic tests of the proposed IO primitive; it is not yet wired into product.
//! The historical clone-only Windows probe is preserved outside the CI targets.

#[path = "../src/transport/abortable_io.rs"]
mod abortable_io;

use abortable_io::{AbortHandle, AbortableIo};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout_at, Instant};

const CASE_BUDGET: Duration = Duration::from_secs(5);
const NEGATIVE_WINDOW: Duration = Duration::from_millis(100);
const ABORT_OBSERVATION: Duration = Duration::from_millis(500);
const MAX_WRITE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Default)]
struct IoProbe {
    read_pending: AtomicBool,
    write_pending: AtomicBool,
    written: AtomicUsize,
    read_wait: Notify,
    write_wait: Notify,
}

/// The actual stream passed to russh, including its inner session task. This
/// outer wrapper observes delegated IO/drop and contains no cancellation logic.
struct ObservedStream {
    stream: AbortableIo<TcpStream>,
    probe: Arc<IoProbe>,
    dropped: Option<oneshot::Sender<()>>,
}

impl Drop for ObservedStream {
    fn drop(&mut self) {
        if let Some(tx) = self.dropped.take() {
            let _ = tx.send(());
        }
    }
}

impl AsyncRead for ObservedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.stream).poll_read(cx, buf);
        self.probe
            .read_pending
            .store(result.is_pending(), Ordering::SeqCst);
        if result.is_pending() {
            self.probe.read_wait.notify_one();
        }
        result
    }
}

impl AsyncWrite for ObservedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, buf);
        self.probe
            .write_pending
            .store(result.is_pending(), Ordering::SeqCst);
        if result.is_pending() {
            self.probe.write_wait.notify_one();
        }
        if let Poll::Ready(Ok(written)) = result {
            self.probe.written.fetch_add(written, Ordering::SeqCst);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

async fn pair() -> (
    ObservedStream,
    AbortHandle,
    TcpStream,
    oneshot::Receiver<()>,
) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let (client, peer) = tokio::join!(TcpStream::connect(address), listener.accept());
    let (stream, owner) = AbortableIo::from_tcp_stream(client.unwrap()).unwrap();
    let (tx, rx) = oneshot::channel();
    (
        ObservedStream {
            stream,
            probe: Arc::new(IoProbe::default()),
            dropped: Some(tx),
        },
        owner,
        peer.unwrap().0,
        rx,
    )
}

async fn peer_eof(peer: &mut TcpStream) -> io::Result<usize> {
    let mut bytes = 0;
    let mut buffer = [0_u8; 65536];
    loop {
        let count = peer.read(&mut buffer).await?;
        if count == 0 {
            return Ok(bytes);
        }
        bytes += count;
        if bytes > MAX_WRITE_BYTES {
            return Err(io::Error::other("unexpected peer output"));
        }
    }
}

/// Observe only the JoinHandle, never the child's IO future. On failure abort
/// AND observe its join in a separate bounded cleanup window on failure. Cleanup
/// never contributes to a pass or extends the normal case observation budget.
async fn finish<T>(task: &mut JoinHandle<T>, end: Instant) -> Result<T, String> {
    match timeout_at(end, &mut *task).await {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(_) => {
            task.abort();
            if timeout_at(Instant::now() + ABORT_OBSERVATION, task)
                .await
                .is_err()
            {
                Err("IO owner task missed deadline and did not join during cleanup".into())
            } else {
                Err("IO owner task did not finish before deadline".into())
            }
        }
    }
}

fn explicitly_aborted<T>(result: &Result<io::Result<T>, String>) -> bool {
    matches!(result, Ok(Err(error)) if error.kind() == io::ErrorKind::ConnectionAborted)
}

async fn fill<S: AsyncWrite + Unpin>(mut stream: S) -> io::Result<()> {
    let chunk = [0_u8; 65536];
    for _ in 0..MAX_WRITE_BYTES / chunk.len() {
        stream.write_all(&chunk).await?;
    }
    Ok(())
}

async fn pending_read(probe: &IoProbe, end: Instant) -> bool {
    timeout_at(end, probe.read_wait.notified()).await.is_ok()
        && probe.read_pending.load(Ordering::SeqCst)
}

fn observation_end(end: Instant, duration: Duration) -> Instant {
    end.min(Instant::now() + duration)
}

async fn negative_window(end: Instant) -> bool {
    timeout_at(end, sleep(NEGATIVE_WINDOW)).await.is_ok()
}

async fn saturated_write(probe: &IoProbe, end: Instant) -> bool {
    if timeout_at(end, probe.write_wait.notified()).await.is_err() {
        return false;
    }
    if !negative_window(end).await {
        return false;
    }
    let before = probe.written.load(Ordering::SeqCst);
    negative_window(end).await
        && before > 0
        && probe.written.load(Ordering::SeqCst) == before
        && probe.write_pending.load(Ordering::SeqCst)
}

#[tokio::test]
async fn cancellation_wakes_a_proven_pending_read_owner_task() {
    let end = Instant::now() + CASE_BUDGET;
    let (mut stream, owner, mut peer, dropped) = timeout_at(end, pair()).await.unwrap();
    let probe = stream.probe.clone();
    let mut task = tokio::spawn(async move { stream.read(&mut [0_u8; 1]).await });
    let pending = pending_read(&probe, end).await;
    let negative = negative_window(end).await && !task.is_finished();
    let abort = owner.abort();
    let result = finish(&mut task, observation_end(end, ABORT_OBSERVATION)).await;
    let released = timeout_at(end, dropped).await;
    let eof = timeout_at(end, peer_eof(&mut peer)).await;
    // All observations precede any peer drop/drain-induced wake of the reader.
    println!("read: pending={pending}, negative={negative}, result={result:?}, drop={released:?}, EOF={eof:?}");
    assert!(pending && negative && abort.is_ok() && explicitly_aborted(&result));
    assert!(matches!(released, Ok(Ok(()))) && matches!(eof, Ok(Ok(0))));
}

#[tokio::test]
async fn cancellation_wakes_a_proven_saturated_write_owner_task() {
    let end = Instant::now() + CASE_BUDGET;
    let (stream, owner, mut peer, dropped) = timeout_at(end, pair()).await.unwrap();
    let probe = stream.probe.clone();
    let mut task = tokio::spawn(fill(stream));
    let pending = saturated_write(&probe, end).await;
    let negative = !task.is_finished();
    let written = probe.written.load(Ordering::SeqCst);
    let abort = owner.abort();
    let result = finish(&mut task, observation_end(end, ABORT_OBSERVATION)).await;
    let released = timeout_at(end, dropped).await;
    // Drain only AFTER the writer joined, so peer reads cannot create a pass.
    let eof = timeout_at(end, peer_eof(&mut peer)).await;
    println!("write: pending/stable={pending}, accepted={written}, result={result:?}, drop={released:?}, EOF={eof:?}");
    assert!(pending && negative && abort.is_ok() && explicitly_aborted(&result));
    assert!(matches!(released, Ok(Ok(()))) && matches!(eof, Ok(Ok(_))));
}

#[tokio::test]
async fn simultaneous_read_and_write_owners_both_wake_without_peer_help() {
    let end = Instant::now() + CASE_BUDGET;
    let (stream, owner, mut peer, dropped) = timeout_at(end, pair()).await.unwrap();
    let probe = stream.probe.clone();
    let (mut read, write) = tokio::io::split(stream);
    let mut reader = tokio::spawn(async move { read.read(&mut [0_u8; 1]).await });
    let mut writer = tokio::spawn(fill(write));
    let pending_r = pending_read(&probe, end).await;
    let pending_w = saturated_write(&probe, end).await;
    let negative = !reader.is_finished() && !writer.is_finished();
    let abort = owner.abort();
    let wake_end = observation_end(end, ABORT_OBSERVATION);
    let (read_result, write_result) =
        tokio::join!(finish(&mut reader, wake_end), finish(&mut writer, wake_end));
    let released = timeout_at(end, dropped).await;
    let eof = timeout_at(end, peer_eof(&mut peer)).await;
    println!("simultaneous: read={read_result:?}, write={write_result:?}, drop={released:?}, EOF={eof:?}");
    assert!(pending_r && pending_w && negative && abort.is_ok());
    assert!(explicitly_aborted(&read_result) && explicitly_aborted(&write_result));
    assert!(matches!(released, Ok(Ok(()))) && matches!(eof, Ok(Ok(_))));
}

struct RejectKeys;
impl russh::client::Handler for RejectKeys {
    type Error = russh::Error;
}

#[derive(Clone, Copy, Debug)]
enum PeerStage {
    NoBanner,
    StalledKex,
}
#[derive(Clone, Copy, Debug)]
enum Trigger {
    Deadline,
    ExplicitCancel,
}

async fn reach_stage(peer: &mut TcpStream, stage: PeerStage) -> io::Result<()> {
    if matches!(stage, PeerStage::StalledKex) {
        peer.write_all(b"SSH-2.0-aidevbridge-abort-probe\r\n")
            .await?;
    }
    let mut banner = Vec::new();
    loop {
        let byte = peer.read_u8().await?;
        banner.push(byte);
        if banner.len() > 255 {
            return Err(io::Error::other("invalid client banner"));
        }
        if byte == b'\n' {
            break;
        }
    }
    if !banner.starts_with(b"SSH-2.0-") {
        return Err(io::Error::other("invalid client banner"));
    }
    if matches!(stage, PeerStage::StalledKex) {
        let length = peer.read_u32().await? as usize;
        if !(6..=65536).contains(&length) {
            return Err(io::Error::other("invalid KEX packet length"));
        }
        let mut packet = vec![0; length];
        peer.read_exact(&mut packet).await?;
        if packet[1] != 20 {
            return Err(io::Error::other("expected SSH_MSG_KEXINIT"));
        }
    }
    Ok(())
}

async fn probe_russh(stage: PeerStage, trigger: Trigger) {
    let end = Instant::now() + CASE_BUDGET;
    let (stream, owner, mut peer, mut dropped) = timeout_at(end, pair()).await.unwrap();
    let probe = stream.probe.clone();
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: None,
        ..Default::default()
    });
    let mut task = tokio::spawn(russh::client::connect_stream(config, stream, RejectKeys));
    let reached = timeout_at(end, reach_stage(&mut peer, stage)).await;
    let pending = pending_read(&probe, end).await;
    let negative = negative_window(end).await
        && !task.is_finished()
        && matches!(dropped.try_recv(), Err(oneshot::error::TryRecvError::Empty));
    // Only the JoinHandle is timed. We never re-poll the task's IO or its
    // connect future from this parent; KEX IO also belongs to russh's inner task.
    let early = match trigger {
        Trigger::Deadline => timeout_at(observation_end(end, NEGATIVE_WINDOW), &mut task)
            .await
            .ok(),
        Trigger::ExplicitCancel => None,
    };
    let trigger_valid = early.is_none();
    let abort = owner.abort();
    let joined = if early.is_some() {
        true // already joined by the negative deadline observation; case fails.
    } else {
        task.abort(); // explicitly give up the outer connect future, then JOIN it.
        timeout_at(end, &mut task).await.is_ok()
    };
    let released = timeout_at(observation_end(end, ABORT_OBSERVATION), &mut dropped).await;
    let released_before_peer_cleanup = matches!(released, Ok(Ok(())));
    let eof = timeout_at(end, peer_eof(&mut peer)).await;
    // On a failing primitive only, release the peer and observe eventual IO
    // cleanup; it never contributes to released_before_peer_cleanup.
    drop(peer);
    if !released_before_peer_cleanup {
        let _ = timeout_at(end, &mut dropped).await;
    }
    println!("{stage:?}/{trigger:?}: pending={pending}, negative={negative}, outer joined={joined}, actual stream released before peer cleanup={released_before_peer_cleanup}, EOF={eof:?}");
    assert!(
        matches!(reached, Ok(Ok(())))
            && pending
            && negative
            && trigger_valid
            && abort.is_ok()
            && joined
    );
    assert!(released_before_peer_cleanup && matches!(eof, Ok(Ok(_))));
    // russh does not publish its inner pre-KEX JoinHandle. Its actual stream
    // drop is observed before peer cleanup/runtime end; no inner join is claimed.
}

#[tokio::test]
async fn russh_no_banner_deadline_releases_actual_stream_and_peer() {
    probe_russh(PeerStage::NoBanner, Trigger::Deadline).await;
}
#[tokio::test]
async fn russh_no_banner_cancel_releases_actual_stream_and_peer() {
    probe_russh(PeerStage::NoBanner, Trigger::ExplicitCancel).await;
}
#[tokio::test]
async fn russh_stalled_kex_deadline_releases_actual_stream_and_peer() {
    probe_russh(PeerStage::StalledKex, Trigger::Deadline).await;
}
#[tokio::test]
async fn russh_stalled_kex_cancel_releases_actual_stream_and_peer() {
    probe_russh(PeerStage::StalledKex, Trigger::ExplicitCancel).await;
}

#[tokio::test]
async fn normal_io_flush_vectored_write_and_shutdown_work_without_abort() {
    let end = Instant::now() + CASE_BUDGET;
    let (observed, _owner, mut peer, dropped) = timeout_at(end, pair()).await.unwrap();
    let mut stream = observed;
    let mut task = tokio::spawn(async move {
        let written = stream
            .stream
            .write_vectored(&[io::IoSlice::new(b"ping")])
            .await?;
        if written < 4 {
            stream.write_all(&b"ping"[written..]).await?;
        }
        stream.flush().await?;
        let mut reply = [0; 4];
        stream.read_exact(&mut reply).await?;
        stream.shutdown().await?;
        Ok::<_, io::Error>(reply)
    });
    let mut request = [0; 4];
    let peer_result = timeout_at(end, async {
        peer.read_exact(&mut request).await?;
        peer.write_all(b"pong").await?;
        peer_eof(&mut peer).await
    })
    .await;
    let result = finish(&mut task, end).await;
    let released = timeout_at(end, dropped).await;
    assert_eq!(&request, b"ping");
    assert!(matches!(result, Ok(Ok(reply)) if &reply == b"pong"));
    assert!(matches!(peer_result, Ok(Ok(0))) && matches!(released, Ok(Ok(()))));
}

#[tokio::test]
async fn dropping_owner_before_first_poll_is_sticky_for_read_write_flush_shutdown() {
    let end = Instant::now() + CASE_BUDGET;
    let (mut stream, owner, mut peer, dropped) = timeout_at(end, pair()).await.unwrap();
    drop(owner);
    let mut task = tokio::spawn(async move {
        let read = stream.read(&mut [0; 1]).await;
        let write = stream.write(b"x").await;
        let flush = stream.flush().await;
        let shutdown = stream.shutdown().await;
        [read.err(), write.err(), flush.err(), shutdown.err()]
    });
    let result = finish(&mut task, end).await;
    let released = timeout_at(end, dropped).await;
    let eof = timeout_at(end, peer_eof(&mut peer)).await;
    assert!(
        matches!(result, Ok(errors) if errors.iter().all(|error| error.as_ref().is_some_and(|error| error.kind() == io::ErrorKind::ConnectionAborted)))
    );
    assert!(matches!(released, Ok(Ok(()))) && matches!(eof, Ok(Ok(0))));
}
