//! Spec §5.6, Verlauf beim Anhaengen, ueber den echten Oeffnungsweg gegen
//! den hermetischen SSH-Testserver (`connection::tests::Fixture`): Leg 0
//! beantwortet die Erfassung nach Skript, Leg 1 schickt gleich nach dem
//! Attach `fixture-result\n` als Kanaldatum. Dieses liegt also schon bereit,
//! wenn die Pumpe startet -- genau der Fall, gegen den die Reihenfolge
//! halten muss.
use super::*;
use crate::connection::tests::{control_events, Fixture};
use crate::tmux::history::{history_command, prepare_history};
use crate::tmux::inventory::{PaneId, ServerIdentity, SessionId, WindowId};
use tokio::time::timeout;

fn state_socket() -> TmuxSocket {
    TmuxSocket::own(&OwnSocket::new("hermetic_socket").unwrap())
}

const END: Duration = Duration::from_secs(8);
const HOST: &str = "hermetic-h0";
const SESSION: &str = "same-session";
const OPENING: &str = "opening-history";
const PANE: u32 = 7;
const CHANNEL: &[u8] = b"fixture-result\n";
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
    fn events(&self) -> Vec<Vec<u8>> {
        let output = self.output.lock().unwrap().clone();
        assert!(output.iter().all(|(open_id, _)| open_id == OPENING));
        output.into_iter().map(|(_, bytes)| bytes).collect()
    }

    async fn wait_events(&self, count: usize) -> Vec<Vec<u8>> {
        timeout(END, async {
            loop {
                let events = self.events();
                if events.len() >= count {
                    return events;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("pump output")
    }

    fn lost(&self) -> Vec<String> {
        self.lost.lock().unwrap().clone()
    }
}

async fn connected() -> (Fixture, Arc<AppState>) {
    let fixture = Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    let state = Arc::new(AppState::with_own_socket("hermetic_socket".into()));
    host.start_monitor();
    state
        .hosts
        .lock()
        .unwrap()
        .insert(HOST.into(), HostSlot::Ready(host));
    (fixture, state)
}

fn request(timeout: Duration) -> Option<HistoryRequest> {
    Some(HistoryRequest {
        pane_id: PANE,
        timeout,
    })
}

async fn open(
    state: &Arc<AppState>,
    sink: &Recorded,
    rows: u16,
    history: Option<HistoryRequest>,
) -> Result<(), String> {
    timeout(
        END,
        open_terminal_with_history(
            state,
            sink.clone(),
            HOST.into(),
            SESSION.into(),
            80,
            rows,
            OPENING.into(),
            None,
            history,
        ),
    )
    .await
    .expect("open deadline")
}

/// Liest ausserhalb jeder Assertion: ein Fehlschlag mit gehaltener Sperre
/// vergiftete sie fuer das Aufraeumen.
fn in_flight(state: &Arc<AppState>) -> u64 {
    let ack = state
        .terminals
        .lock()
        .unwrap()
        .get(&session_key(HOST, SESSION))
        .expect("published terminal")
        .ack
        .clone();
    let in_flight = ack.window.lock().unwrap().in_flight();
    in_flight
}

fn ack(state: &Arc<AppState>, bytes: usize) {
    ack_output_tagged_impl(
        state,
        HOST.into(),
        SESSION.into(),
        u32::try_from(bytes).unwrap(),
        Some(OPENING.into()),
    )
    .unwrap();
}

/// Rund 1,5 MiB in Zeilen zu 100 Bytes: mehr als ein Ack-Fenster, weniger
/// als die 2-MiB-Grenze.
fn large_history() -> String {
    let lines: String = (0..15_000).map(|n| format!("{n:099}\n")).collect();
    format!("0\n{lines}")
}

async fn finish(fixture: Fixture, state: Arc<AppState>) {
    timeout(END, disconnect_host_impl(&state, HOST.into()))
        .await
        .unwrap()
        .unwrap();
    fixture.finish(2).await;
}

#[test]
fn the_history_limits_follow_the_spec() {
    assert_eq!(HISTORY_TIMEOUT, Duration::from_secs(2));
    assert_eq!(HISTORY_RESERVE, Duration::from_millis(300));
    assert_eq!(HISTORY_MAX_BYTES, 2 * 1024 * 1024);
    assert_eq!(HISTORY_CHUNK_BYTES, 32 * 1024);
}

/// Spec §5.6, Restzeit: erfasst wird nur bei MEHR als Frist plus 300 ms
/// Rest. Dann laeuft die Erfassung mit eigener, kuerzerer Frist und nie auf
/// der Operation des Oeffnens selbst.
#[test]
fn the_capture_needs_more_than_its_deadline_plus_the_reserve() {
    let two = Duration::from_secs(2);
    assert_eq!(history_budget(Duration::from_millis(2300), two), None);
    assert_eq!(history_budget(Duration::from_millis(2301), two), Some(two));
    assert_eq!(history_budget(Duration::ZERO, two), None);
    assert_eq!(history_budget(Duration::from_secs(2), two), None);
    assert_eq!(history_budget(COMMAND_TIMEOUT, two), Some(two));
}

/// Die Restzeit kommt aus der Operation des Oeffnens (15 s ab Reservierung):
/// Eine Erfassung, deren Frist plus Reserve nicht mehr hineinpasst, startet
/// gar nicht, und das Terminal oeffnet ohne Verlauf.
#[tokio::test]
async fn without_enough_remaining_time_the_open_skips_the_capture() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    open(&state, &sink, 3, request(COMMAND_TIMEOUT))
        .await
        .unwrap();
    let events = sink.wait_events(1).await;
    assert_eq!(events[0], CHANNEL);
    assert!(fixture.control_commands().is_empty(), "no capture started");
    finish(fixture, state).await;

    // Gegenprobe: Eine Frist, die samt Reserve noch hineinpasst, erfasst.
    // Die halbe Oeffnungsfrist laesst dem Attach unter Last reichlich Zeit;
    // die genaue Grenze prueft `the_capture_needs_more_than_its_deadline_
    // plus_the_reserve`.
    let (fixture, state) = connected().await;
    fixture.script_control(vec![(Some(0), "0\nline\n", "")]);
    let sink = Recorded::default();
    open(&state, &sink, 3, request(COMMAND_TIMEOUT / 2))
        .await
        .unwrap();
    let events = sink.wait_events(2).await;
    assert_eq!(events[0], b"line\r\n\r\n\r\n");
    assert_eq!(events[1], CHANNEL);
    finish(fixture, state).await;
}

#[tokio::test]
async fn the_history_is_the_first_output_and_counts_into_the_ack_window() {
    let (fixture, state) = connected().await;
    fixture.script_control(vec![(Some(0), "0\nline1\nline2\n", "")]);
    let sink = Recorded::default();
    open(&state, &sink, 3, request(HISTORY_TIMEOUT))
        .await
        .unwrap();
    let events = sink.wait_events(2).await;
    assert_eq!(events[0], b"line1\r\nline2\r\n\r\n\r\n");
    assert_eq!(events[1], CHANNEL);
    assert_eq!(
        in_flight(&state),
        (events[0].len() + events[1].len()) as u64,
        "history bytes are reserved in the same ack window as channel data"
    );
    let commands = fixture.control_commands();
    assert_eq!(
        commands.len(),
        1,
        "one tmux call over the control connection"
    );
    assert_eq!(
        crate::remote::command::decoded_argv(&commands[0]),
        history_command(&state_socket(), PANE)
    );
    // Erst der Attach (Leg 1), dann die Erfassung (Leg 0): nach dem Attach
    // hat tmux das Fenster schon auf die Kachelgroesse gebracht.
    let legs: Vec<usize> = fixture.commands().iter().map(|(leg, _)| *leg).collect();
    assert_eq!(legs, [1, 0], "capture after the attach");
    assert!(sink.lost().is_empty());
    finish(fixture, state).await;
}

#[tokio::test]
async fn a_history_larger_than_the_ack_window_waits_for_acks_and_still_precedes_channel_data() {
    let (fixture, state) = connected().await;
    let raw = large_history();
    let expected = prepare_history(&raw, 24, HISTORY_MAX_BYTES).unwrap();
    assert!(expected.len() as u64 > ACK_WINDOW_BYTES);
    fixture.script_control(vec![(Some(0), &raw, "")]);
    let sink = Recorded::default();
    open(&state, &sink, 24, request(HISTORY_TIMEOUT))
        .await
        .unwrap();
    // Ohne Ack: genau ein volles Fenster Verlauf und noch kein Kanaldatum.
    let window = usize::try_from(ACK_WINDOW_BYTES).unwrap() / HISTORY_CHUNK_BYTES;
    sink.wait_events(window).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let held = sink.events();
    assert_eq!(held.len(), window, "the pump must wait for credit");
    assert!(held.iter().all(|chunk| chunk.len() == HISTORY_CHUNK_BYTES));
    assert_eq!(in_flight(&state), ACK_WINDOW_BYTES);
    // Bestaetigen wie der WebView, Stueck fuer Stueck, bis das Kanaldatum kommt.
    let mut acked = 0;
    let all = timeout(END, async {
        loop {
            let events = sink.events();
            for chunk in &events[acked..] {
                ack(&state, chunk.len());
            }
            acked = events.len();
            if events.last().is_some_and(|last| last == CHANNEL) {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("history and then channel data after acks");
    let (channel, history) = all.split_last().unwrap();
    assert_eq!(channel, CHANNEL);
    assert!(history
        .iter()
        .all(|chunk| chunk.len() <= HISTORY_CHUNK_BYTES));
    assert_eq!(history.concat(), expected);
    assert!(sink.lost().is_empty());
    finish(fixture, state).await;
}

#[tokio::test]
async fn closing_while_the_history_waits_for_credit_ends_the_pump_quietly() {
    let (fixture, state) = connected().await;
    fixture.script_control(vec![(Some(0), &large_history(), "")]);
    let sink = Recorded::default();
    open(&state, &sink, 24, request(HISTORY_TIMEOUT))
        .await
        .unwrap();
    let window = usize::try_from(ACK_WINDOW_BYTES).unwrap() / HISTORY_CHUNK_BYTES;
    sink.wait_events(window).await;
    close_terminal_tagged_impl(&state, HOST.into(), SESSION.into(), Some(OPENING.into())).unwrap();
    assert!(!state.has_terminal(HOST, SESSION).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(sink.events().len(), window);
    assert!(
        sink.lost().is_empty(),
        "a deliberate close is not a lost connection"
    );
    finish(fixture, state).await;
}

#[tokio::test]
async fn a_failed_or_unusable_capture_opens_without_history_and_leaves_control_alone() {
    for reply in [
        (Some(1), "", "can't find pane: %7\n"),
        // Vollbildprogramm oder leerer Verlauf.
        (Some(0), "1\nprompt\n", ""),
        (Some(0), "not tmux\n", ""),
        // Ohne Exitstatus ist die Antwort ein Fehler, keine Ausgabe.
        (None, "0\nline\n", ""),
    ] {
        let (fixture, state) = connected().await;
        fixture.script_control(vec![reply]);
        let sink = Recorded::default();
        open(&state, &sink, 3, request(HISTORY_TIMEOUT))
            .await
            .unwrap();
        let events = sink.wait_events(1).await;
        assert_eq!(events[0], CHANNEL, "{reply:?}");
        assert_eq!(fixture.control_commands().len(), 1, "{reply:?}");
        let controls = control_events(&fixture);
        assert!(controls.is_empty(), "{reply:?}: {controls:?}");
        finish(fixture, state).await;
    }
}

#[tokio::test]
async fn a_capture_past_its_deadline_opens_without_history() {
    let (fixture, state) = connected().await;
    fixture.hold_control_replies();
    let sink = Recorded::default();
    let deadline = Duration::from_millis(200);
    let started = tokio::time::Instant::now();
    open(&state, &sink, 3, request(deadline)).await.unwrap();
    assert!(started.elapsed() >= deadline);
    let events = sink.wait_events(1).await;
    assert_eq!(events[0], CHANNEL);
    assert_eq!(fixture.control_commands().len(), 1);
    // Die abgebrochene Lesung schliesst nur ihren Kanal: kein Zustandswechsel.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let controls = control_events(&fixture);
    assert!(controls.is_empty(), "{controls:?}");
    finish(fixture, state).await;
}

/// `close_terminal` waehrend der Erfassung bricht die gemeinsame Operation
/// ab: Die Erfassung endet sofort, die Veroeffentlichung scheitert an ihrer
/// Generationspruefung, und der schon bestaetigte Attach-Kanal wird
/// geschlossen. Keine Ausgabe, kein Verbindungsverlust, kein Steuerereignis.
#[tokio::test]
async fn closing_during_the_capture_publishes_nothing_and_closes_the_attach() {
    let (fixture, state) = connected().await;
    fixture.hold_control_replies();
    let sink = Recorded::default();
    let opening = {
        let state = state.clone();
        let sink = sink.clone();
        tokio::spawn(async move { open(&state, &sink, 3, request(Duration::from_secs(5))).await })
    };
    // Die Erfassung laeuft: der Testserver hat den Befehl, antwortet aber nie.
    timeout(END, async {
        while fixture.control_commands().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("capture in flight");
    let closed_at = tokio::time::Instant::now();
    close_terminal_tagged_impl(&state, HOST.into(), SESSION.into(), Some(OPENING.into())).unwrap();
    let result = timeout(END, opening).await.unwrap().unwrap();
    assert!(result.is_err(), "a cancelled open must not publish");
    assert!(
        closed_at.elapsed() < Duration::from_secs(4),
        "close cancels the capture at once"
    );
    timeout(END, async {
        while fixture.channel_closes(1) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the confirmed attach channel is closed");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(sink.events().is_empty());
    assert!(sink.lost().is_empty());
    let controls = control_events(&fixture);
    assert!(controls.is_empty(), "{controls:?}");
    assert!(!state.has_terminal(HOST, SESSION).await);
    let pending_empty = state.terminals.lock().unwrap().pending.is_empty();
    assert!(pending_empty);
    finish(fixture, state).await;
}

/// Ohne Bindung (Oeffnen ueber den Namen) gibt es keine Pane-Id und damit
/// keine Erfassung -- ueber denselben Einstieg wie der Command.
#[tokio::test]
async fn without_a_binding_there_is_no_capture() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    timeout(
        END,
        open_terminal_tagged_impl(
            &state,
            sink.clone(),
            HOST.into(),
            SESSION.into(),
            80,
            3,
            OPENING.into(),
            None,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let events = sink.wait_events(1).await;
    assert_eq!(events[0], CHANNEL);
    assert!(fixture.control_commands().is_empty());
    finish(fixture, state).await;
}

fn bound_pane() -> PaneIdentity {
    PaneIdentity {
        server: ServerIdentity {
            pid: 50,
            start_time: 1000,
        },
        session_id: SessionId(3),
        window_id: WindowId(4),
        pane_id: PaneId(9),
        pane_pid: 77,
    }
}

/// Der Command-Einstieg erfasst genau die gebundene Pane, mit der Frist der
/// Spec; ohne Bindung gar nicht.
#[test]
fn only_a_bound_pane_is_captured_and_with_the_spec_deadline() {
    assert!(history_request_for(None).is_none());
    let request = history_request_for(Some(bound_pane())).unwrap();
    assert_eq!(request.pane_id, 9);
    assert_eq!(request.timeout, HISTORY_TIMEOUT);
}

/// Erfasst wird erst nach dem bestaetigten Attach. Der Testserver kann diesen
/// nicht bestaetigen; ein gescheitertes gebundenes Oeffnen liest also keinen
/// Verlauf und liefert nichts aus.
#[tokio::test]
async fn a_bound_open_that_fails_its_confirmation_captures_nothing() {
    let (fixture, state) = connected().await;
    let sink = Recorded::default();
    let result = timeout(
        END,
        open_terminal_tagged_impl(
            &state,
            sink.clone(),
            HOST.into(),
            SESSION.into(),
            80,
            24,
            OPENING.into(),
            Some(bound_pane()),
        ),
    )
    .await
    .unwrap();
    assert!(result.is_err(), "the fixture cannot confirm a bound attach");
    let history = history_command(&state_socket(), 9);
    let commands = fixture.control_commands();
    assert!(!commands.is_empty(), "the confirmation ran");
    assert!(commands
        .iter()
        .all(|line| crate::remote::command::decoded_argv(line) != history));
    assert_eq!(fixture.pty_requests(), 0);
    assert!(sink.events().is_empty());
    assert!(!state.has_terminal(HOST, SESSION).await);
    finish(fixture, state).await;
}
