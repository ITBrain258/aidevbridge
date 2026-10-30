// AgentBridge local modifications to russh 0.65.0, 2026-09-11.
// Apache-2.0, the same license as russh. Included inside each side's existing
// test module; close_patch_session() supplies that side's authenticated fixture.

#[derive(Default)]
struct ClosePatchProbe {
    closes: Vec<ChannelId>,
    data_calls: usize,
}

impl Handler for ClosePatchProbe {
    type Error = crate::Error;

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.closes.push(channel);
        Ok(())
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        _data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.data_calls += 1;
        Ok(())
    }
}

fn close_patch_insert(
    session: &mut Session,
    confirmed: bool,
) -> (ChannelId, tokio::sync::mpsc::Receiver<crate::ChannelMsg>) {
    let enc = session.common.encrypted.as_mut().unwrap();
    let id = enc.new_channel(1024, 1024);
    let params = enc.channels.get_mut(&id).unwrap();
    params.confirmed = confirmed;
    params.recipient_channel = 77;
    params.recipient_maximum_packet_size = 1024;
    params.recipient_window_size = 1024;
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    let channel_ref = crate::channels::ChannelRef::new(sender);
    assert!(!channel_ref.awaiting_close);
    session.channels.insert(id, channel_ref);
    (id, receiver)
}

async fn close_patch_dispatch(
    session: &mut Session,
    handler: &mut ClosePatchProbe,
    kind: u8,
    id: ChannelId,
) {
    let mut packet = vec![kind];
    ssh_encoding::Encode::encode(&id, &mut packet).unwrap();
    if kind == crate::msg::CHANNEL_DATA {
        ssh_encoding::Encode::encode(&"late data", &mut packet).unwrap();
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        session.process_packet(handler, &packet),
    )
    .await
    .expect("channel packet dispatch must not wait for window space or a second Close")
    .unwrap();
}

fn close_patch_assert_removed(session: &Session, id: ChannelId) {
    assert!(!session.channels.contains_key(&id));
    assert!(
        !session
            .common
            .encrypted
            .as_ref()
            .unwrap()
            .channels
            .contains_key(&id)
    );
}

fn close_patch_assert_one_wire_close(session: &Session) {
    // Encrypted.write stores a length-prefixed SSH payload; destination ID is
    // the peer's 77, not our local ID. No pending DATA/EOF follows peer Close.
    assert_eq!(
        session.common.encrypted.as_ref().unwrap().write,
        vec![0, 0, 0, 5, crate::msg::CHANNEL_CLOSE, 0, 0, 0, 77],
    );
}

#[tokio::test]
async fn close_patch_local_close_ack_is_delivered_once_and_not_as_data() {
    let mut session = close_patch_session();
    let (id, mut receiver) = close_patch_insert(&mut session, true);
    let mut handler = ClosePatchProbe::default();
    session.close(id).unwrap();
    assert!(!session.common.is_established_channel(id));
    assert!(session.channels[&id].awaiting_close);

    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_DATA, id).await;
    assert_eq!(handler.data_calls, 0);
    assert!(receiver.try_recv().is_err());

    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert!(matches!(receiver.try_recv(), Ok(crate::ChannelMsg::Close)));
    close_patch_assert_removed(&session, id);
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert_eq!(handler.closes, vec![id]);
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
    ));
    close_patch_assert_one_wire_close(&session);
}

#[tokio::test]
async fn close_patch_remote_initiated_close_is_delivered_and_replied_once() {
    let mut session = close_patch_session();
    let (id, mut receiver) = close_patch_insert(&mut session, true);
    let mut handler = ClosePatchProbe::default();
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert!(matches!(receiver.try_recv(), Ok(crate::ChannelMsg::Close)));
    close_patch_assert_removed(&session, id);
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    session.close(id).unwrap();
    assert_eq!(handler.closes, vec![id]);
    close_patch_assert_one_wire_close(&session);
}

#[tokio::test]
async fn close_patch_unknown_and_unconfirmed_close_never_gain_ack_permission() {
    let mut session = close_patch_session();
    let mut handler = ClosePatchProbe::default();
    let unknown = ChannelId(9999);
    session.close(unknown).unwrap();
    close_patch_dispatch(
        &mut session,
        &mut handler,
        crate::msg::CHANNEL_CLOSE,
        unknown,
    )
    .await;
    assert!(session.channels.is_empty());
    assert!(session.common.encrypted.as_ref().unwrap().write.is_empty());

    let (id, mut receiver) = close_patch_insert(&mut session, false);
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert!(session.channels.contains_key(&id));
    assert!(
        session
            .common
            .encrypted
            .as_ref()
            .unwrap()
            .channels
            .contains_key(&id)
    );
    session.close(id).unwrap();
    assert!(!session.channels[&id].awaiting_close);
    let before = session.common.encrypted.as_ref().unwrap().write.clone();
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert_eq!(session.common.encrypted.as_ref().unwrap().write, before);
    assert!(handler.closes.is_empty());
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn close_patch_remote_close_drops_unsent_data_without_waiting_for_window() {
    for local_close in [false, true] {
        let mut session = close_patch_session();
        let (id, mut receiver) = close_patch_insert(&mut session, true);
        let mut handler = ClosePatchProbe::default();
        let params = session
            .common
            .encrypted
            .as_mut()
            .unwrap()
            .channels
            .get_mut(&id)
            .unwrap();
        params.recipient_window_size = 0;
        params
            .pending_data
            .push_back((bytes::Bytes::from_static(b"unsent"), None, 0));
        params.pending_eof = true;
        if local_close {
            session.close(id).unwrap();
            assert!(session.channels[&id].awaiting_close);
        }
        assert!(session.common.encrypted.as_ref().unwrap().write.is_empty());
        close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
        assert!(matches!(receiver.try_recv(), Ok(crate::ChannelMsg::Close)));
        close_patch_assert_removed(&session, id);
        close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
        assert_eq!(handler.closes, vec![id]);
        close_patch_assert_one_wire_close(&session);
    }
}

#[tokio::test]
async fn close_patch_deferred_local_close_keeps_ack_permission_after_flush() {
    let mut session = close_patch_session();
    let (id, mut receiver) = close_patch_insert(&mut session, true);
    let mut handler = ClosePatchProbe::default();
    let enc = session.common.encrypted.as_mut().unwrap();
    enc.channels.get_mut(&id).unwrap().pending_data.push_back((
        bytes::Bytes::from_static(b"sent before close"),
        None,
        0,
    ));
    session.close(id).unwrap();
    assert!(session.channels[&id].awaiting_close);
    assert!(session.common.is_established_channel(id));
    let enc = session.common.encrypted.as_mut().unwrap();
    assert_eq!(enc.flush_pending(id).unwrap(), b"sent before close".len());
    assert!(!enc.channels.contains_key(&id));
    let before = enc.write.clone();
    close_patch_dispatch(&mut session, &mut handler, crate::msg::CHANNEL_CLOSE, id).await;
    assert!(matches!(receiver.try_recv(), Ok(crate::ChannelMsg::Close)));
    assert_eq!(session.common.encrypted.as_ref().unwrap().write, before);
    close_patch_assert_removed(&session, id);
    assert_eq!(handler.closes, vec![id]);
}
