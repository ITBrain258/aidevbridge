//! Explicit cancellation for a TCP stream that may be owned by a russh task.
//! A socket shutdown alone does not reliably wake pending Tokio IO on Windows.

use std::io;
use std::net::Shutdown;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

#[derive(Default)]
struct WakeState {
    aborted: bool,
    read: Option<Waker>,
    write: Option<Waker>,
}

#[derive(Default)]
struct AbortState(Mutex<WakeState>);

impl AbortState {
    fn register(&self, read: bool, waker: &Waker) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        if state.aborted {
            return Err(aborted());
        }
        let slot = if read {
            &mut state.read
        } else {
            &mut state.write
        };
        if slot.as_ref().is_none_or(|old| !old.will_wake(waker)) {
            *slot = Some(waker.clone());
        }
        Ok(())
    }

    fn finish<T>(&self, result: Poll<io::Result<T>>) -> Poll<io::Result<T>> {
        // An in-flight poll cannot undo bytes already read or written. Preserve
        // Ready (including its original error); only replace a cancelled Pending.
        if result.is_pending() && self.0.lock().unwrap().aborted {
            Poll::Ready(Err(aborted()))
        } else {
            result
        }
    }

    fn abort(&self) -> bool {
        let wakers = {
            let mut state = self.0.lock().unwrap();
            if state.aborted {
                return false;
            }
            state.aborted = true;
            [state.read.take(), state.write.take()]
        };
        // Waking can run arbitrary code: never hold the registration mutex here.
        for waker in wakers.into_iter().flatten() {
            waker.wake();
        }
        true
    }
}

fn aborted() -> io::Error {
    io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "connection explicitly aborted",
    )
}

/// Unique cancellation owner. It is deliberately not Clone; dropping it aborts
/// the connection even if the IO has moved into a detached library task.
pub struct AbortHandle {
    socket: std::net::TcpStream,
    state: Arc<AbortState>,
}

impl AbortHandle {
    /// Cancellation is sticky even when the OS shutdown reports an error.
    pub fn abort(&self) -> io::Result<()> {
        if self.state.abort() {
            self.socket.shutdown(Shutdown::Both)
        } else {
            Ok(())
        }
    }
}

impl Drop for AbortHandle {
    fn drop(&mut self) {
        let _ = self.abort();
    }
}

/// Read and write register independent wakers, including when split by Tokio.
/// Registration precedes polling IO; cancellation is checked again afterward.
/// An abort between registration and Pending therefore cannot lose its wake.
pub struct AbortableIo<S> {
    inner: S,
    state: Arc<AbortState>,
}

impl AbortableIo<TcpStream> {
    pub fn from_tcp_stream(stream: TcpStream) -> io::Result<(Self, AbortHandle)> {
        let standard = stream.into_std()?;
        let socket = standard.try_clone()?;
        // Tokio's into_std preserves nonblocking mode, also shared by the clone.
        let inner = TcpStream::from_std(standard)?;
        let state = Arc::new(AbortState::default());
        let owner = AbortHandle {
            socket,
            state: state.clone(),
        };
        Ok((Self { inner, state }, owner))
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for AbortableIo<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.state.register(true, cx.waker())?;
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        self.state.finish(result)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for AbortableIo<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.state.register(false, cx.waker())?;
        let result = Pin::new(&mut self.inner).poll_write(cx, buffer);
        self.state.finish(result)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        self.state.register(false, cx.waker())?;
        let result = Pin::new(&mut self.inner).poll_write_vectored(cx, buffers);
        self.state.finish(result)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.state.register(false, cx.waker())?;
        let result = Pin::new(&mut self.inner).poll_flush(cx);
        self.state.finish(result)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.state.register(false, cx.waker())?;
        let result = Pin::new(&mut self.inner).poll_shutdown(cx);
        self.state.finish(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::Wake;

    #[derive(Default)]
    struct WakeCount(AtomicUsize);

    impl Wake for WakeCount {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct PendingIo {
        abort_during_read: Option<Arc<AbortState>>,
    }

    impl AsyncRead for PendingIo {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if let Some(state) = self.abort_during_read.take() {
                state.abort();
            }
            Poll::Pending
        }
    }

    impl AsyncWrite for PendingIo {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Pending
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    struct ReadyDuringAbort(Arc<AbortState>);

    impl AsyncRead for ReadyDuringAbort {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            buffer.put_slice(b"r");
            self.0.abort();
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for ReadyDuringAbort {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            self.0.abort();
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn read_ready_during_abort_preserves_progress_then_rejects_next_poll() {
        let state = Arc::new(AbortState::default());
        let mut stream = AbortableIo {
            inner: ReadyDuringAbort(state.clone()),
            state,
        };
        let mut cx = Context::from_waker(Waker::noop());
        let mut bytes = [0; 1];
        let mut buffer = ReadBuf::new(&mut bytes);
        assert!(matches!(
            Pin::new(&mut stream).poll_read(&mut cx, &mut buffer),
            Poll::Ready(Ok(()))
        ));
        assert_eq!(buffer.filled(), b"r");
        assert!(matches!(
            Pin::new(&mut stream).poll_read(&mut cx, &mut buffer),
            Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::ConnectionAborted
        ));
    }

    #[test]
    fn write_ready_during_abort_preserves_progress_then_rejects_next_poll() {
        let state = Arc::new(AbortState::default());
        let mut stream = AbortableIo {
            inner: ReadyDuringAbort(state.clone()),
            state,
        };
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(
            Pin::new(&mut stream).poll_write(&mut cx, b"written"),
            Poll::Ready(Ok(7))
        ));
        assert!(matches!(
            Pin::new(&mut stream).poll_write(&mut cx, b"next"),
            Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::ConnectionAborted
        ));
    }

    #[test]
    fn abort_between_registration_and_pending_completes_the_same_poll() {
        let state = Arc::new(AbortState::default());
        let mut stream = AbortableIo {
            inner: PendingIo {
                abort_during_read: Some(state.clone()),
            },
            state,
        };
        let count = Arc::new(WakeCount::default());
        let waker = Waker::from(count.clone());
        let mut cx = Context::from_waker(&waker);
        let mut bytes = [0; 1];
        let result = Pin::new(&mut stream).poll_read(&mut cx, &mut ReadBuf::new(&mut bytes));
        assert!(
            matches!(result, Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::ConnectionAborted)
        );
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn distinct_read_write_wakers_and_all_write_operations_observe_sticky_abort() {
        let state = Arc::new(AbortState::default());
        let mut stream = AbortableIo {
            inner: PendingIo {
                abort_during_read: None,
            },
            state: state.clone(),
        };
        let reads = Arc::new(WakeCount::default());
        let writes = Arc::new(WakeCount::default());
        let read_waker = Waker::from(reads.clone());
        let write_waker = Waker::from(writes.clone());
        let mut read_cx = Context::from_waker(&read_waker);
        let mut write_cx = Context::from_waker(&write_waker);
        let mut bytes = [0; 1];
        assert!(Pin::new(&mut stream)
            .poll_read(&mut read_cx, &mut ReadBuf::new(&mut bytes))
            .is_pending());
        assert!(Pin::new(&mut stream).poll_flush(&mut write_cx).is_pending());
        assert!(Pin::new(&mut stream)
            .poll_shutdown(&mut write_cx)
            .is_pending());
        state.abort();
        state.abort();
        assert_eq!(reads.0.load(Ordering::SeqCst), 1);
        assert_eq!(writes.0.load(Ordering::SeqCst), 1);
        assert!(matches!(
            Pin::new(&mut stream).poll_write(&mut write_cx, b"x"),
            Poll::Ready(Err(_))
        ));
        assert!(matches!(
            Pin::new(&mut stream).poll_write_vectored(&mut write_cx, &[io::IoSlice::new(b"x")]),
            Poll::Ready(Err(_))
        ));
        assert!(matches!(
            Pin::new(&mut stream).poll_flush(&mut write_cx),
            Poll::Ready(Err(_))
        ));
        assert!(matches!(
            Pin::new(&mut stream).poll_shutdown(&mut write_cx),
            Poll::Ready(Err(_))
        ));
    }
}
