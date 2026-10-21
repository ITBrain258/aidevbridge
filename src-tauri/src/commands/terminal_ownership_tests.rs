use super::*;
use crate::connection::tests::Fixture;
use crate::transport::russh_transport::SLOT_WAIT;
use tokio::time::timeout;

const END: Duration = Duration::from_secs(8);
type TaggedOutput = Arc<std::sync::Mutex<Vec<(String, Vec<u8>)>>>;

#[derive(Default, Clone)]
struct Recorded {
    output: TaggedOutput,
    lost: Arc<std::sync::Mutex<Vec<String>>>,
}

impl OutputSink for Recorded {
    fn send(&self, _: &str, _: &str, _: Vec<u8>) -> bool {
        panic!("pump must include opening identity")
    }
    fn send_open(&self, _: &str, _: &str, open_id: &str, bytes: Vec<u8>) -> bool {
        self.output.lock().unwrap().push((open_id.into(), bytes));
        true
    }
    fn connection_lost_open(&self, _: &str, _: &str, open_id: &str) {
        self.lost.lock().unwrap().push(open_id.into());
    }
}

impl Recorded {
    async fn wait_output(&self, id: &str) {
        timeout(END, async {
            while !self
                .output
                .lock()
                .unwrap()
                .iter()
                .any(|(open_id, _)| open_id == id)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("current output");
    }
}

async fn connected() -> (Fixture, Arc<AppState>) {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    let state = Arc::new(AppState::with_default_socket("hermetic_socket".into()));
    host.start_monitor();
    state
        .hosts
        .lock()
        .unwrap()
        .insert("hermetic-h0".into(), HostSlot::Ready(host));
    (fixture, state)
}

fn open(
    state: &Arc<AppState>,
    sink: &Recorded,
    id: &str,
) -> tokio::task::JoinHandle<Result<(), String>> {
    open_session(state, sink, "same-session", id)
}

/// Wie `open`, fuer eine eigene Session: Kacheln desselben Hosts brauchen
/// verschiedene Schluessel.
fn open_session(
    state: &Arc<AppState>,
    sink: &Recorded,
    session: &str,
    id: &str,
) -> tokio::task::JoinHandle<Result<(), String>> {
    let state = state.clone();
    let sink = sink.clone();
    let session = session.to_string();
    let id = id.to_string();
    tokio::spawn(async move {
        open_terminal_tagged_impl(
            &state,
            sink,
            "hermetic-h0".into(),
            session,
            80,
            24,
            id,
            None,
        )
        .await
    })
}

/// Oeffnet "tile-0" bis "tile-7" nacheinander (Session und Oeffnungs-Id
/// gleich; je Host laufen hoechstens vier Oeffnungen) und wartet auf ihre
/// erste Ausgabe. Danach sind alle acht PTY-Plaetze der Terminalverbindung
/// belegt.
async fn open_eight(state: &Arc<AppState>, sink: &Recorded) {
    for index in 0..8 {
        let name = format!("tile-{index}");
        timeout(END, open_session(state, sink, &name, &name))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        sink.wait_output(&name).await;
    }
}

/// Wartet, bis das Oeffnen von `session` als laufend eingetragen ist. Ohne
/// Bindung steht es von da an an der Kanalzulassung (`reserve` und die
/// Zulassung laufen ohne Pause hintereinander); endet es vorher, scheitert
/// der Test mit seinem Ergebnis.
async fn wait_until_pending(
    state: &Arc<AppState>,
    opening: &mut tokio::task::JoinHandle<Result<(), String>>,
    session: &str,
) {
    let key = session_key("hermetic-h0", session);
    tokio::select! {
        result = opening => panic!("the open must wait for a channel: {result:?}"),
        waited = timeout(END, async {
            while !state.terminals.lock().unwrap().pending.contains_key(&key) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }) => waited.expect("pending terminal open"),
    }
}

async fn finish(fixture: Fixture, state: Arc<AppState>) {
    timeout(END, disconnect_host_impl(&state, "hermetic-h0".into()))
        .await
        .unwrap()
        .unwrap();
    assert!(state.terminals.lock().unwrap().pending.is_empty());
    assert!(state.terminals.lock().unwrap().is_empty());
    fixture.finish(2).await;
}

#[tokio::test]
async fn late_open_after_tagged_close_cannot_publish_and_old_commands_cannot_touch_the_replacement()
{
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    fixture.hold_terminal_opens();
    let mut old = open(&state, &sink, "opening-old");
    fixture.wait_pending_opens(1).await;
    close_terminal_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "same-session".into(),
        Some("opening-old".into()),
    )
    .unwrap();
    assert!(timeout(END, &mut old).await.unwrap().unwrap().is_err());
    fixture.release_terminal_opens().await;
    let mut current = open(&state, &sink, "opening-current");
    timeout(END, &mut current).await.unwrap().unwrap().unwrap();
    sink.wait_output("opening-current").await;
    assert_eq!(
        fixture.pty_requests(),
        1,
        "the cancelled late open must never send PTY or attach"
    );
    assert!(sink
        .output
        .lock()
        .unwrap()
        .iter()
        .all(|(id, _)| id == "opening-current"));
    assert!(sink.lost.lock().unwrap().is_empty());
    close_terminal_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "same-session".into(),
        Some("opening-old".into()),
    )
    .unwrap();
    assert!(state.has_terminal("hermetic-h0", "same-session").await);
    assert!(send_input_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "same-session".into(),
        b"old-input".to_vec(),
        Some("opening-old".into())
    )
    .await
    .is_err());
    assert!(resize_terminal_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "same-session".into(),
        99,
        35,
        Some("opening-old".into())
    )
    .await
    .is_err());
    let ack = state
        .terminals
        .lock()
        .unwrap()
        .get(&session_key("hermetic-h0", "same-session"))
        .unwrap()
        .ack
        .clone();
    let before = ack.window.lock().unwrap().in_flight();
    assert!(before > 0);
    ack_output_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "same-session".into(),
        1,
        Some("opening-old".into()),
    )
    .unwrap();
    assert_eq!(ack.window.lock().unwrap().in_flight(), before);
    ack_output_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "same-session".into(),
        1,
        Some("opening-current".into()),
    )
    .unwrap();
    assert_eq!(ack.window.lock().unwrap().in_flight(), before - 1);
    finish(fixture, state).await;
    assert!(sink.lost.lock().unwrap().is_empty());
}

#[tokio::test]
async fn replacement_of_a_pending_open_survives_the_old_callers_drop() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    fixture.hold_terminal_opens();
    let mut old = open(&state, &sink, "opening-a");
    fixture.wait_pending_opens(1).await;
    let mut replacement = open(&state, &sink, "opening-b");
    fixture.wait_pending_opens(2).await;
    assert!(timeout(END, &mut old).await.unwrap().unwrap().is_err());
    assert_eq!(
        state
            .terminals
            .lock()
            .unwrap()
            .pending
            .get(&session_key("hermetic-h0", "same-session"))
            .unwrap()
            .open_id,
        "opening-b"
    );
    fixture.release_terminal_opens().await;
    timeout(END, &mut replacement)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    sink.wait_output("opening-b").await;
    assert_eq!(fixture.pty_requests(), 1);
    assert!(sink
        .output
        .lock()
        .unwrap()
        .iter()
        .all(|(id, _)| id == "opening-b"));
    finish(fixture, state).await;
}

#[tokio::test]
async fn disconnect_invalidates_unpublished_open_and_joins_without_emitting_late_output() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    fixture.hold_terminal_opens();
    let mut pending = open(&state, &sink, "before-disconnect");
    fixture.wait_pending_opens(1).await;
    timeout(END, disconnect_host_impl(&state, "hermetic-h0".into()))
        .await
        .unwrap()
        .unwrap();
    assert!(timeout(END, &mut pending).await.unwrap().unwrap().is_err());
    fixture.release_terminal_opens().await;
    assert!(state.terminals.lock().unwrap().pending.is_empty());
    assert!(sink.output.lock().unwrap().is_empty());
    assert!(sink.lost.lock().unwrap().is_empty());
    fixture.finish(2).await;
    assert!(sink.output.lock().unwrap().is_empty());
}

#[tokio::test]
async fn active_terminal_pumps_do_not_keep_the_app_state_alive() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    let mut opening = open(&state, &sink, "drop-app-state");
    timeout(END, &mut opening).await.unwrap().unwrap().unwrap();
    sink.wait_output("drop-app-state").await;
    let weak = Arc::downgrade(&state);
    drop(state);
    timeout(END, async {
        while weak.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("no pump/AppState/HostConnection reference cycle");
    fixture.finish(2).await;
}

#[tokio::test]
async fn duplicate_name_does_not_hide_an_unconfirmed_restore_mutation() {
    let (fixture, state) = connected().await;
    fixture.script_control(vec![
        (Some(0), "", ""),
        (Some(0), "", ""),
        (Some(0), "", ""),
        (Some(0), "", ""),
        (Some(1), "", "duplicate session: selected-name"),
        (None, "", ""),
    ]);
    let error = create_session_impl(
        &state,
        "hermetic-h0".into(),
        "/fixture".into(),
        Some("selected-name".into()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, "outcome_unknown");
    assert!(
        error.message.contains("already exists"),
        "{}",
        error.message
    );
    assert!(error.message.contains("Cleanup outcome"));
    assert_eq!(
        fixture.command_count(),
        6,
        "no retry or fresh cleanup after the unconfirmed restore"
    );
    finish(fixture, state).await;
}

#[tokio::test]
async fn an_unconfirmed_kill_ends_its_message_with_a_readable_ssh_sentence() {
    let (fixture, state) = connected().await;
    // Kein Exitstatus auf das abgeschickte kill-session: der Ausgang ist offen.
    fixture.script_control(vec![(None, "", "")]);
    let message = kill_session_impl(
        &state,
        "hermetic-h0".into(),
        "victim".into(),
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(
        message.starts_with("The remote operation may have taken effect"),
        "{message}"
    );
    assert!(
        message
            .ends_with("before trying again. The SSH command failed (read, missing exit status)."),
        "{message}"
    );
    assert_eq!(
        fixture.command_count(),
        1,
        "no verification after the open outcome"
    );
    finish(fixture, state).await;
}

/// Spec 2026-10-19 §8.1 (Schritt 3), Ersetzen an der Grenze: Mit acht offenen
/// Terminals sind alle PTY-Plaetze belegt. Schliessen und sofort Oeffnen
/// wartet, bis der alte Kanal zu ist, statt an der Kanalgrenze zu scheitern.
#[tokio::test]
async fn replace_at_eight_open_waits_until_the_old_channel_is_closed() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    open_eight(&state, &sink).await;
    close_terminal_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "tile-0".into(),
        Some("tile-0".into()),
    )
    .unwrap();
    timeout(END, open_session(&state, &sink, "tile-8", "tile-8"))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    sink.wait_output("tile-8").await;
    assert_eq!(fixture.channel_opens(1), 9);
    finish(fixture, state).await;
}

/// Review Focus 4: Ersetzen an der Grenze bei langsamem Close. Das neue
/// Oeffnen wartet `SLOT_WAIT` auf den Platz und scheitert dann mit dem Rohtext
/// der PTY-Grenze, nie mit dem der Pumpengrenze, ohne ein Open zu senden. Ist
/// der alte Kanal zu, gelingt es.
#[tokio::test]
async fn replace_with_slow_close_reports_capacity_after_the_slot_wait() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    open_eight(&state, &sink).await;
    fixture.hold_terminal_closes();
    close_terminal_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "tile-0".into(),
        Some("tile-0".into()),
    )
    .unwrap();
    let started = tokio::time::Instant::now();
    let refused = timeout(END, open_session(&state, &sink, "tile-8", "tile-8"))
        .await
        .unwrap()
        .unwrap();
    assert!(
        started.elapsed() >= SLOT_WAIT,
        "the replacing open must wait for the slot first"
    );
    assert_eq!(
        refused,
        Err("Terminal operation failed during Admission: Capacity".to_string())
    );
    fixture.release_terminal_closes();
    timeout(END, open_session(&state, &sink, "tile-8", "tile-8-retry"))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    sink.wait_output("tile-8-retry").await;
    // Das abgewiesene Oeffnen hat kein Open gesendet: acht plus das neue.
    assert_eq!(fixture.channel_opens(1), 9);
    finish(fixture, state).await;
}

/// Spec 2026-10-19 §8.1 (Schritt 3): Schliesst die Kachel, waehrend ihr
/// Oeffnen auf einen Kanal wartet, endet es sofort als abgebrochen und hat
/// nichts gesendet; Platz und Erlaubnis bleiben fuer das naechste frei.
#[tokio::test]
async fn close_ends_a_waiting_open_as_cancelled_without_open() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    open_eight(&state, &sink).await;
    let begun = tokio::time::Instant::now();
    let mut waiting = open_session(&state, &sink, "tile-8", "tile-8");
    wait_until_pending(&state, &mut waiting, "tile-8").await;
    close_terminal_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "tile-8".into(),
        Some("tile-8".into()),
    )
    .unwrap();
    assert_eq!(
        timeout(END, &mut waiting).await.unwrap().unwrap(),
        Err("Terminal operation failed during Admission: Cancelled".to_string())
    );
    assert!(
        begun.elapsed() < SLOT_WAIT,
        "the cancel must end the wait at once"
    );
    close_terminal_tagged_impl(
        &state,
        "hermetic-h0".into(),
        "tile-0".into(),
        Some("tile-0".into()),
    )
    .unwrap();
    timeout(END, open_session(&state, &sink, "tile-9", "tile-9"))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    // Das abgebrochene Oeffnen hat kein Open gesendet: acht plus "tile-9".
    assert_eq!(fixture.channel_opens(1), 9);
    assert!(!sink
        .output
        .lock()
        .unwrap()
        .iter()
        .any(|(id, _)| id == "tile-8"));
    finish(fixture, state).await;
}

/// Spec 2026-10-19 §8.1 (Schritt 3): Trennt der Host, waehrend ein Oeffnen auf
/// einen Kanal wartet, endet es sofort am Ende des Transports, ohne spaete
/// Ausgabe und ohne Verlustmeldung.
#[tokio::test]
async fn disconnect_ends_a_waiting_open_at_once() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    open_eight(&state, &sink).await;
    let mut waiting = open_session(&state, &sink, "tile-8", "tile-8");
    wait_until_pending(&state, &mut waiting, "tile-8").await;
    timeout(END, disconnect_host_impl(&state, "hermetic-h0".into()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        timeout(END, &mut waiting).await.unwrap().unwrap(),
        Err("Terminal operation failed during Admission: Unavailable".to_string())
    );
    assert!(state.terminals.lock().unwrap().pending.is_empty());
    assert!(state.terminals.lock().unwrap().is_empty());
    assert!(!sink
        .output
        .lock()
        .unwrap()
        .iter()
        .any(|(id, _)| id == "tile-8"));
    assert!(sink.lost.lock().unwrap().is_empty());
    fixture.finish(2).await;
}

/// Spec 2026-10-19 §8.3: Das Frontend erkennt eine Kanalgrenze am Rohtext
/// (`CAPACITY_ERRORS` in `src/views/grid.ts`). Bei vier laufenden Oeffnungen
/// eines Hosts weist `reserve` die fuenfte mit genau diesem Text ab.
#[tokio::test]
async fn fifth_pending_open_of_a_host_names_the_known_raw_text() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    fixture.hold_terminal_opens();
    let held: Vec<_> = (0..4)
        .map(|index| {
            let name = format!("held-{index}");
            open_session(&state, &sink, &name, &name)
        })
        .collect();
    fixture.wait_pending_opens(4).await;
    assert_eq!(
        timeout(END, open_session(&state, &sink, "fifth", "fifth"))
            .await
            .unwrap()
            .unwrap(),
        Err("too many terminal setups are already pending for this host".to_string())
    );
    fixture.release_terminal_opens().await;
    for opening in held {
        timeout(END, opening).await.unwrap().unwrap().unwrap();
    }
    finish(fixture, state).await;
}
