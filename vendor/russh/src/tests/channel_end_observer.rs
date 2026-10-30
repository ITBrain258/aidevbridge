// AgentBridge local modifications to russh 0.65.0, 2026-09-12.
// Apache-2.0, the same license as russh. Included inside client::tests.

fn end_patch_insert(
    session: &mut Session,
    confirmed: bool,
) -> (ChannelId, Receiver<ChannelMsg>, crate::ChannelEndObserver) {
    let enc = session.common.encrypted.as_mut().unwrap();
    let id = enc.new_channel(1024, 1024);
    let params = enc.channels.get_mut(&id).unwrap();
    params.confirmed = confirmed;
    params.recipient_channel = 77;
    params.recipient_maximum_packet_size = 1024;
    params.recipient_window_size = 1024;
    let (sender, receiver) = channel(1);
    let channel_ref = crate::channels::ChannelRef::new_observed(sender);
    let observer = channel_ref.end_observer().unwrap();
    session.channels.insert(id, channel_ref);
    (id, receiver, observer)
}

#[derive(Clone, Copy, Debug)]
enum EndPatchPacket {
    Eof,
    ExitZero,
    Signal,
    Close,
}

impl EndPatchPacket {
    fn encode(self, id: ChannelId) -> Vec<u8> {
        let mut packet = vec![match self {
            Self::Eof => crate::msg::CHANNEL_EOF,
            Self::Close => crate::msg::CHANNEL_CLOSE,
            _ => crate::msg::CHANNEL_REQUEST,
        }];
        id.encode(&mut packet).unwrap();
        match self {
            Self::ExitZero => {
                "exit-status".encode(&mut packet).unwrap();
                0u8.encode(&mut packet).unwrap();
                0u32.encode(&mut packet).unwrap();
            }
            Self::Signal => {
                "exit-signal".encode(&mut packet).unwrap();
                0u8.encode(&mut packet).unwrap();
                "TERM".encode(&mut packet).unwrap();
                0u8.encode(&mut packet).unwrap();
                "detail".encode(&mut packet).unwrap();
                "en".encode(&mut packet).unwrap();
            }
            _ => {}
        }
        packet
    }

    fn assert_snapshot(self, state: crate::ChannelEndSnapshot) {
        assert!(state.has_end());
        assert_eq!(state.remote_eof, matches!(self, Self::Eof));
        assert_eq!(
            state.exit_status,
            matches!(self, Self::ExitZero).then_some(0)
        );
        assert_eq!(state.exit_signal, matches!(self, Self::Signal));
        assert_eq!(state.remote_close, matches!(self, Self::Close));
        assert!(!state.transport_ended);
        assert!(!state.dispatch_route_gone);
    }

    fn assert_message(self, message: ChannelMsg) {
        match (self, message) {
            (Self::Eof, ChannelMsg::Eof)
            | (Self::Close, ChannelMsg::Close)
            | (Self::ExitZero, ChannelMsg::ExitStatus { exit_status: 0 }) => {}
            (
                Self::Signal,
                ChannelMsg::ExitSignal {
                    signal_name: crate::Sig::TERM,
                    core_dumped: false,
                    error_message,
                    lang_tag,
                },
            ) => {
                assert_eq!(error_message, "detail");
                assert_eq!(lang_tag, "en");
            }
            other => panic!("original terminal message changed: {other:?}"),
        }
    }
}

async fn end_patch_full_queue(kind: EndPatchPacket) {
    let mut session = close_patch_session();
    let (id, mut receiver, observer) = end_patch_insert(&mut session, true);
    session.channels[&id]
        .try_send(ChannelMsg::Data {
            data: bytes::Bytes::from_static(b"before"),
        })
        .unwrap();
    let mut handler = ClosePatchProbe::default();
    let packet = kind.encode(id);
    {
        let dispatch = session.process_packet(&mut handler, &packet);
        tokio::pin!(dispatch);
        assert!(futures::poll!(dispatch.as_mut()).is_pending());
        kind.assert_snapshot(observer.snapshot());
        kind.assert_snapshot(
            tokio::time::timeout(std::time::Duration::from_secs(1), observer.wait_ended())
                .await
                .unwrap(),
        );
        assert!(
            observer
                .with_no_end(|| panic!("must not admit after decoded end"))
                .is_err()
        );
        assert!(
            matches!(receiver.try_recv(), Ok(ChannelMsg::Data { data }) if data == b"before"[..])
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), dispatch)
            .await
            .unwrap()
            .unwrap();
    }
    kind.assert_message(receiver.try_recv().unwrap());
    if matches!(kind, EndPatchPacket::Close) {
        close_patch_assert_removed(&session, id);
        close_patch_assert_one_wire_close(&session);
        assert_eq!(handler.closes, vec![id]);
        assert!(observer.snapshot().dispatch_route_gone);
    }
}

#[tokio::test]
async fn end_patch_full_queue_eof() {
    end_patch_full_queue(EndPatchPacket::Eof).await;
}

#[tokio::test]
async fn end_patch_full_queue_exit_zero() {
    end_patch_full_queue(EndPatchPacket::ExitZero).await;
}

#[tokio::test]
async fn end_patch_full_queue_signal() {
    end_patch_full_queue(EndPatchPacket::Signal).await;
}

#[tokio::test]
async fn end_patch_full_queue_close() {
    end_patch_full_queue(EndPatchPacket::Close).await;
}

#[tokio::test]
async fn end_patch_malformed_end_does_not_publish_an_observation() {
    for kind in [
        EndPatchPacket::Eof,
        EndPatchPacket::ExitZero,
        EndPatchPacket::Signal,
        EndPatchPacket::Close,
    ] {
        let mut session = close_patch_session();
        let (id, mut receiver, observer) = end_patch_insert(&mut session, true);
        let mut packet = kind.encode(id);
        packet.push(1); // The actual dispatcher must validate the entire packet first.
        assert!(
            session
                .process_packet(&mut ClosePatchProbe::default(), &packet)
                .await
                .is_err()
        );
        assert!(!observer.snapshot().has_end(), "{kind:?}");
        assert!(receiver.try_recv().is_err());
    }
}

#[tokio::test]
async fn end_patch_close_requires_established_or_retained_ack_route() {
    let mut session = close_patch_session();
    let (id, mut receiver, observer) = end_patch_insert(&mut session, false);
    let mut handler = ClosePatchProbe::default();
    for channel_id in [ChannelId(9999), id] {
        close_patch_dispatch(
            &mut session,
            &mut handler,
            crate::msg::CHANNEL_CLOSE,
            channel_id,
        )
        .await;
    }
    assert!(!observer.snapshot().has_end());
    assert!(session.common.encrypted.as_ref().unwrap().write.is_empty());
    session.close(id).unwrap();
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert!(!observer.snapshot().has_end());
    assert!(!session.channels[&id].awaiting_close);
    assert!(receiver.try_recv().is_err());
    assert!(handler.closes.is_empty());

    let mut session = close_patch_session();
    let (id, mut receiver, observer) = end_patch_insert(&mut session, true);
    session.close(id).unwrap();
    assert!(!session.common.is_established_channel(id));
    assert!(session.channels[&id].awaiting_close);
    assert!(!observer.snapshot().has_end());
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert!(observer.snapshot().remote_close);
    assert!(observer.snapshot().dispatch_route_gone);
    assert!(!observer.snapshot().transport_ended);
    assert!(matches!(receiver.try_recv(), Ok(ChannelMsg::Close)));
    close_patch_assert_one_wire_close(&session);
    close_patch_assert_removed(&session, id);
}

#[tokio::test]
async fn end_patch_open_confirmation_and_split_preserve_observer() {
    let (sender, mut commands) = channel(4);
    let (_, receiver) = unbounded_channel();
    let (priority_sender, _priority_commands) = unbounded_channel();
    let handle = Handle::<TestHandler> {
        sender,
        receiver,
        channel_buffer_size: 1,
        join: russh_util::runtime::spawn(async { Ok(()) }),
        priority_sender,
        agent_session_binding: None,
    };
    let opened;
    let channel_ref;
    {
        let opening = handle.channel_open_session();
        tokio::pin!(opening);
        assert!(futures::poll!(opening.as_mut()).is_pending());
        channel_ref = match commands.try_recv().unwrap() {
            Msg::ChannelOpenSession { channel_ref } => channel_ref,
            message => panic!("unexpected open command: {message:?}"),
        };
        // The latch exists before Open confirmation, and is not reset by it.
        channel_ref.record_end(ChannelEndEvent::Eof);
        channel_ref
            .send(ChannelMsg::Open {
                id: ChannelId(7),
                max_packet_size: 1024,
                window_size: 1024,
            })
            .await
            .unwrap();
        opened = opening.await.unwrap();
    }
    let (read, write) = opened.split();
    let observer = read.end_observer().unwrap();
    assert!(observer.snapshot().remote_eof);
    assert!(!observer.snapshot().dispatch_route_gone);
    drop(channel_ref);
    assert!(observer.snapshot().dispatch_route_gone);
    drop(read);
    drop(write);
    handle.await.unwrap(); // No test-owned task left running.
}

#[tokio::test]
async fn end_patch_writer_and_session_drop_ignore_observer_and_raw_sender_clones() {
    for drop_session in [false, true] {
        let mut session = close_patch_session();
        let (id, mut receiver, observer) = end_patch_insert(&mut session, true);
        let observer_clone = observer.clone();
        let raw_sender = (*session.channels[&id]).clone();
        raw_sender.try_send(ChannelMsg::Success).unwrap();
        if drop_session {
            drop(session);
        } else {
            drop(session.channels.remove(&id).unwrap());
        }
        let state = observer_clone.wait_ended().await;
        assert!(state.dispatch_route_gone);
        assert_eq!(state.transport_ended, drop_session);
        assert!(!state.remote_close);
        assert!(!state.remote_eof);
        assert!(matches!(receiver.try_recv(), Ok(ChannelMsg::Success)));
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        drop(raw_sender);
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
        ));
        assert!(observer.snapshot().dispatch_route_gone);
    }
}

#[tokio::test]
async fn end_patch_observations_stick_and_notify_all_waiters() {
    let (sender, _receiver) = channel(1);
    let channel_ref = crate::channels::ChannelRef::new_observed(sender);
    let observer = channel_ref.end_observer().unwrap();
    let first = observer.wait_ended();
    let second = observer.wait_ended();
    tokio::pin!(first, second);
    assert!(futures::poll!(first.as_mut()).is_pending());
    assert!(futures::poll!(second.as_mut()).is_pending());
    channel_ref.record_end(ChannelEndEvent::ExitStatus(0));
    assert_eq!(first.await.exit_status, Some(0));
    assert_eq!(second.await.exit_status, Some(0));
    channel_ref.record_end(ChannelEndEvent::ExitStatus(17));
    channel_ref.record_end(ChannelEndEvent::Eof);
    channel_ref.record_end(ChannelEndEvent::Close);
    let late_waiter = observer.wait_ended().await;
    assert_eq!(late_waiter.exit_status, Some(0));
    assert!(late_waiter.remote_eof && late_waiter.remote_close);
}

#[test]
fn end_patch_admission_and_end_share_a_synchronous_gate() {
    let (sender, _receiver) = channel(1);
    let channel_ref = crate::channels::ChannelRef::new_observed(sender);
    let observer = channel_ref.end_observer().unwrap();
    let other_observer = observer.clone();
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let (done_sender, done_receiver) = std::sync::mpsc::channel();
    let gate_entered = entered.clone();
    let gate_release = release.clone();
    let admission = std::thread::spawn(move || {
        other_observer.with_no_end(|| {
            // Deliberate test-only blocking exposes the synchronization boundary.
            gate_entered.wait();
            gate_release.wait();
            23
        })
    });
    entered.wait();
    let marking = std::thread::spawn(move || {
        channel_ref.record_end(ChannelEndEvent::Close);
        done_sender.send(()).unwrap();
        channel_ref
    });
    assert!(
        done_receiver
            .recv_timeout(std::time::Duration::from_millis(30))
            .is_err()
    );
    release.wait();
    assert_eq!(admission.join().unwrap(), Ok(23));
    let channel_ref = marking.join().unwrap();
    done_receiver.recv().unwrap();
    assert!(
        observer
            .with_no_end(|| panic!("end must win the next admission"))
            .is_err()
    );
    drop(channel_ref);
}

#[test]
fn end_patch_common_unobserved_constructor_reports_none() {
    let (sender, _receiver) = channel::<Msg>(1);
    let (channel, channel_ref) = Channel::new(ChannelId(1), sender, 1024, 1024, 1);
    assert!(channel_ref.end_observer().is_none());
    let (read, _write) = channel.split();
    assert!(read.end_observer().is_none());
}

#[test]
fn end_patch_panicking_admission_does_not_hide_or_panic_during_route_drop() {
    let (sender, _receiver) = channel(1);
    let channel_ref = crate::channels::ChannelRef::new_observed(sender);
    let observer = channel_ref.end_observer().unwrap();
    let failed_admission = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = observer.with_no_end(|| panic!("deliberate caller failure"));
    }));
    assert!(failed_admission.is_err());
    assert!(!observer.snapshot().has_end());
    drop(channel_ref);
    assert!(observer.snapshot().dispatch_route_gone);
    assert!(observer.with_no_end(|| panic!("route ended")).is_err());
}

struct EndPatchBlockedShutdown(Arc<std::sync::atomic::AtomicBool>);

impl tokio::io::AsyncRead for EndPatchBlockedShutdown {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        _: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

impl tokio::io::AsyncWrite for EndPatchBlockedShutdown {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::task::Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        std::task::Poll::Pending
    }
}

#[tokio::test]
async fn end_patch_transport_end_precedes_blocked_shutdown_and_drop() {
    let mut session = close_patch_session();
    let (id, _receiver, observer) = end_patch_insert(&mut session, true);
    let _raw_sender = (*session.channels[&id]).clone();
    session.common.disconnected = true;
    let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let run = session.run(
            SshRead::new(EndPatchBlockedShutdown(shutdown.clone())),
            TestHandler,
            None,
        );
        tokio::pin!(run);
        assert!(futures::poll!(run.as_mut()).is_pending());
        assert!(shutdown.load(std::sync::atomic::Ordering::SeqCst));
        let state = observer.snapshot();
        assert!(state.transport_ended);
        assert!(!state.dispatch_route_gone);
        assert!(!state.remote_close);
    } // Dropping the whole run future also drops the unique route.
    assert!(observer.snapshot().dispatch_route_gone);
}

#[test]
fn end_patch_local_disconnect_marks_transport_without_inventing_remote_close() {
    let mut session = close_patch_session();
    let (_, _receiver, observer) = end_patch_insert(&mut session, true);
    session
        .disconnect(crate::Disconnect::ByApplication, "done", "en")
        .unwrap();
    assert!(observer.snapshot().transport_ended);
    assert!(!observer.snapshot().remote_close);
    assert!(!observer.snapshot().dispatch_route_gone);
}

#[derive(Default)]
struct EndPatchOpenFailureProbe {
    failures: Vec<(ChannelId, ChannelOpenFailure, String, String)>,
}

impl Handler for EndPatchOpenFailureProbe {
    type Error = crate::Error;

    async fn channel_open_failure(
        &mut self,
        id: ChannelId,
        reason: ChannelOpenFailure,
        description: &str,
        language: &str,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.failures
            .push((id, reason, description.into(), language.into()));
        Ok(())
    }
}

#[tokio::test]
async fn end_patch_open_failure_drops_removed_route_before_full_queue_delivery() {
    // Preserve the dispatcher's existing existence gate: it accepts either
    // confirmed or unconfirmed IDs, without inventing a remote Close.
    for confirmed in [true, false] {
        let (mut session, _commands, mut replies) = keyboard_interactive_session();
        session.common.encrypted.as_mut().unwrap().state = EncryptedState::Authenticated;
        let (id, mut receiver, observer) = end_patch_insert(&mut session, confirmed);
        session.channels[&id]
            .try_send(ChannelMsg::Data {
                data: bytes::Bytes::from_static(b"before failure"),
            })
            .unwrap();
        let mut packet = vec![crate::msg::CHANNEL_OPEN_FAILURE];
        id.encode(&mut packet).unwrap();
        2u32.encode(&mut packet).unwrap();
        "open failed".encode(&mut packet).unwrap();
        "en".encode(&mut packet).unwrap();
        let mut handler = EndPatchOpenFailureProbe::default();
        {
            let dispatch = session.process_packet(&mut handler, &packet);
            tokio::pin!(dispatch);
            assert!(futures::poll!(dispatch.as_mut()).is_pending());
            assert_eq!(
                observer.snapshot(),
                crate::ChannelEndSnapshot {
                    dispatch_route_gone: true,
                    ..Default::default()
                },
                "confirmed={confirmed}: removed route hidden behind delivery"
            );
            assert!(
                observer
                    .with_no_end(|| panic!("removed route must not admit"))
                    .is_err()
            );
            assert!(observer.wait_ended().await.dispatch_route_gone);
            assert!(
                matches!(receiver.try_recv(), Ok(ChannelMsg::Data { data }) if data == b"before failure"[..])
            );
            tokio::time::timeout(std::time::Duration::from_secs(1), dispatch)
                .await
                .unwrap()
                .unwrap();
        }
        close_patch_assert_removed(&session, id);
        assert!(session.common.encrypted.as_ref().unwrap().write.is_empty());
        assert!(matches!(
            receiver.try_recv(),
            Ok(ChannelMsg::OpenFailure(ChannelOpenFailure::ConnectFailed))
        ));
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
        ));
        assert!(matches!(replies.try_recv(), Ok(Reply::ChannelOpenFailure)));
        assert_eq!(
            handler.failures,
            vec![(
                id,
                ChannelOpenFailure::ConnectFailed,
                "open failed".into(),
                "en".into()
            )]
        );
        assert!(observer.snapshot().dispatch_route_gone);
    }
}
