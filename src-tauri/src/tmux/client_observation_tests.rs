use super::*;
use crate::remote::command::decoded_argv;
use async_trait::async_trait;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

/// Ein lesender Client; die Art des Sockets spielt fuer diese Tests keine Rolle.
fn reader(name: &str) -> TmuxClient {
    TmuxClient::new(&TmuxSocket::own(&OwnSocket::new(name).unwrap()))
}

struct Step {
    result: Result<ExecResult, ExecError>,
    elapsed: Duration,
}

#[derive(Debug)]
struct Call {
    argv: Vec<String>,
    remaining: Duration,
}

struct ScriptedTransport {
    steps: Mutex<VecDeque<Step>>,
    calls: Mutex<Vec<Call>>,
}

impl ScriptedTransport {
    fn new(results: Vec<ExecResult>, elapsed: Duration) -> Self {
        Self {
            steps: Mutex::new(
                results
                    .into_iter()
                    .map(|result| Step {
                        result: Ok(result),
                        elapsed,
                    })
                    .collect(),
            ),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl Transport for ScriptedTransport {
    async fn exec_with_deadline(
        &self,
        line: &str,
        remaining: Duration,
    ) -> anyhow::Result<ExecResult> {
        self.calls.lock().unwrap().push(Call {
            argv: decoded_argv(line),
            remaining,
        });
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected follow-up query");
        if !step.elapsed.is_zero() {
            tokio::time::advance(step.elapsed).await;
        }
        // Deliberately permit a scripted late completed result as well as a
        // transport's own timeout. Neither may produce a usable late observation.
        step.result.map_err(Into::into)
    }

    async fn exec_mutation(&self, _: &str) -> anyhow::Result<ExecResult> {
        panic!("an observation must never submit a mutation")
    }

    async fn dispose(&self) {}
}

fn output(text: &str) -> ExecResult {
    ExecResult {
        stdout: text.into(),
        stderr: String::new(),
        code: 0,
        utf8_valid: true,
    }
}

fn listed(count: u32) -> String {
    (0..count)
        .map(|sid| {
            let name = if sid == 0 {
                r" cash$back\slash|semi;quote'#[x] ".into()
            } else {
                format!("session {sid}")
            };
            format!("L|100|1000|${sid}|{name}\n")
        })
        .collect()
}

fn resolved(sid: u32) -> String {
    format!("R|100|1000|${sid}|@{sid}|%{sid}|{}|1|1\n", 10 + sid)
}

fn numeric_inventory(count: u32) -> String {
    let mut result = "B|100|1000\n".to_string();
    for sid in 0..count {
        result.push_str(&format!("Q|${sid}|1\n"));
    }
    for sid in 0..count {
        result.push_str(&format!(
            "P|${sid}|@{sid}|%{sid}|{}|1|1|0|0|0|1|0|1\n",
            10 + sid
        ));
    }
    result.push_str("E|100|1000\n");
    result
}

fn sequence(count: u32) -> Vec<ExecResult> {
    let mut results = vec![output(&listed(count))];
    results.extend((0..count).map(|sid| output(&resolved(sid))));
    results.push(output(&numeric_inventory(count)));
    results.extend((0..count).map(|sid| output(&resolved(sid))));
    results.push(output(&listed(count)));
    results
}

fn end() -> Instant {
    Instant::now() + Duration::from_secs(20)
}

#[tokio::test(start_paused = true)]
async fn eight_rows_share_one_inventory_and_one_decreasing_absolute_budget() {
    let transport = ScriptedTransport::new(sequence(8), Duration::from_millis(500));
    let deadline = end();
    let observed = reader("own'|$socket")
        .observe_sessions(&transport, MeasuredVersion::V3_0, deadline)
        .await
        .unwrap();
    assert_eq!(observed.version, MeasuredVersion::V3_0);
    assert_eq!(observed.socket_name, "own'|$socket");
    assert_eq!(observed.sessions.len(), 8);
    assert_eq!(observed.inventory.sessions.len(), 8);
    assert_eq!(
        observed.sessions[0].display_name,
        r" cash$back\slash|semi;quote'#[x] "
    );
    for (sid, session) in observed.sessions.iter().enumerate() {
        assert_eq!(session.session_id, SessionId(sid as u32));
        let binding = session.binding.as_ref().unwrap();
        assert_eq!(binding.selected.session_id, session.session_id);
        assert_eq!(binding.display_name, session.display_name);
        assert!(!binding.creation_matched);
    }
    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 19);
    for (index, call) in calls.iter().enumerate() {
        assert_eq!(
            &call.argv[..6],
            ["env", "LC_ALL=C", "tmux", "-u", "-L", "own'|$socket"]
        );
        assert_eq!(
            call.remaining,
            Duration::from_secs(20) - Duration::from_millis(500 * index as u64)
        );
    }
    let list = ["list-sessions", "-F", session_binding::LIST_FORMAT];
    assert_eq!(&calls[0].argv[6..], list);
    assert_eq!(&calls[18].argv[6..], list);
    for sid in 0..8 {
        let target = format!("${sid}");
        let expected = [
            "list-windows",
            "-t",
            &target,
            "-F",
            session_binding::RESOLVE_FORMAT,
        ];
        assert_eq!(&calls[1 + sid].argv[6..], expected);
        assert_eq!(&calls[10 + sid].argv[6..], expected);
    }
    assert_eq!(
        calls[9].argv,
        decoded_argv(
            &InventoryQuery::named(MeasuredVersion::V3_0, "own'|$socket")
                .unwrap()
                .command()
        )
    );
    assert!(transport.steps.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn completed_r_failures_keep_the_row_unavailable_and_other_rows_bound() {
    let mut failed = output("");
    failed.code = 1;
    failed.stderr = "can't find session: $0\n".into();
    let mut invalid_utf8 = output(&resolved(0));
    invalid_utf8.utf8_valid = false;
    for (index, replacement, expected) in [
        (1, failed, "before"),
        (1, invalid_utf8, "before"),
        (4, output(resolved(0).trim_end_matches('\n')), "after"),
        (4, output(&resolved(0).replace("|10|", "|99|")), "changed"),
    ] {
        let mut results = sequence(2);
        results[index] = replacement;
        let transport = ScriptedTransport::new(results, Duration::ZERO);
        let observed = reader("own")
            .observe_sessions(&transport, MeasuredVersion::V3_4, end())
            .await
            .unwrap();
        assert_eq!(observed.sessions.len(), 2);
        let actual = match observed.sessions[0].binding.as_ref().unwrap_err() {
            BindingUnavailableReason::ResolveBefore(_) => "before",
            BindingUnavailableReason::ResolveAfter(_) => "after",
            BindingUnavailableReason::Changed(_) => "changed",
        };
        assert_eq!(actual, expected);
        assert!(observed.sessions[1].binding.is_ok());
        assert_eq!(transport.calls(), 7);
    }
}

#[tokio::test(start_paused = true)]
async fn list_inventory_and_whole_list_mismatches_are_errors_not_partial_or_empty_lists() {
    let mut no_server = output("");
    no_server.code = 1;
    no_server.stderr = "no server running on /unproven/path/own\n".into();
    // A failed first list is an error; its one exception, a server proven
    // absent, has its own tests below.
    let mut denied = output("");
    denied.code = 1;
    denied.stderr = "error connecting to /tmp/tmux-1000/own (Permission denied)\n".into();
    let mut invalid_utf8 = output(&listed(2));
    invalid_utf8.utf8_valid = false;
    let mut invalid_inventory_utf8 = output(&numeric_inventory(2));
    invalid_inventory_utf8.utf8_valid = false;
    for (index, replacement, expected_calls, family) in [
        (0, denied, 1, "list"),
        (0, invalid_utf8, 1, "list"),
        (3, invalid_inventory_utf8, 4, "list"),
        (3, no_server, 4, "inventory"),
        (3, output("B|100|1000\n"), 4, "inventory"),
        (3, output(&numeric_inventory(1)), 4, "envelope"),
        (
            3,
            output(&numeric_inventory(2).replace("1000", "1001")),
            4,
            "envelope",
        ),
        (6, output("not an L record\n"), 7, "list"),
        (
            6,
            output(&listed(2).replace("session 1", "renamed")),
            7,
            "envelope",
        ),
        (6, output(&listed(1)), 7, "envelope"),
    ] {
        let mut results = sequence(2);
        results[index] = replacement;
        let transport = ScriptedTransport::new(results, Duration::ZERO);
        let error = reader("own")
            .observe_sessions(&transport, MeasuredVersion::V3_4, end())
            .await
            .unwrap_err();
        match family {
            "list" => assert!(error.downcast_ref::<ParseError>().is_some(), "{error:?}"),
            "inventory" => assert!(
                error
                    .downcast_ref::<InventoryObservationUnavailable>()
                    .is_some(),
                "{error:?}"
            ),
            "envelope" => assert!(
                error.downcast_ref::<UnverifiedReason>().is_some(),
                "{error:?}"
            ),
            _ => unreachable!(),
        }
        assert_eq!(transport.calls(), expected_calls);
    }
}

#[tokio::test(start_paused = true)]
async fn a_live_empty_server_requires_both_lists_and_the_complete_inventory() {
    let transport = ScriptedTransport::new(sequence(0), Duration::ZERO);
    let observed = reader("own")
        .observe_sessions(&transport, MeasuredVersion::V3_4, end())
        .await
        .unwrap();
    assert!(observed.sessions.is_empty());
    assert_eq!(observed.inventory.server.pid, 100);
    assert_eq!(observed.inventory.server.start_time, 1000);
    assert_eq!(transport.calls(), 3);
}

#[tokio::test(start_paused = true)]
async fn the_absolute_deadline_rejects_expired_admission_and_late_completed_results() {
    let transport = ScriptedTransport::new(sequence(2), Duration::ZERO);
    let error = reader("own")
        .observe_sessions(&transport, MeasuredVersion::V3_4, Instant::now())
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<ExecError>().unwrap(),
        &ExecError {
            phase: ExecPhase::Admission,
            reason: ExecReason::Timeout,
            submission: Submission::NotSubmitted,
        }
    );
    assert_eq!(transport.calls(), 0);

    let transport = ScriptedTransport::new(sequence(2), Duration::from_secs(2));
    transport.steps.lock().unwrap()[2].elapsed = Duration::from_secs(1);
    let deadline = Instant::now() + Duration::from_secs(5);
    let error = reader("own")
        .observe_sessions(&transport, MeasuredVersion::V3_4, deadline)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<ExecError>().unwrap(),
        &ExecError {
            phase: ExecPhase::Read,
            reason: ExecReason::Timeout,
            submission: Submission::PossiblySubmitted,
        }
    );
    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert_eq!(
        calls.iter().map(|c| c.remaining).collect::<Vec<_>>(),
        [5, 3, 1].map(Duration::from_secs)
    );
}

#[tokio::test(start_paused = true)]
async fn transport_failures_at_every_phase_stop_all_follow_up_queries() {
    for (index, reason) in [
        (0, ExecReason::Transport),
        (1, ExecReason::MissingExitStatus),
        (3, ExecReason::OutputLimit),
        (4, ExecReason::Timeout),
        (6, ExecReason::Cancelled),
    ] {
        let transport = ScriptedTransport::new(sequence(2), Duration::ZERO);
        let expected = ExecError {
            phase: ExecPhase::Read,
            reason,
            submission: Submission::PossiblySubmitted,
        };
        transport.steps.lock().unwrap()[index].result = Err(expected);
        let error = reader("own")
            .observe_sessions(&transport, MeasuredVersion::V3_4, end())
            .await
            .unwrap_err();
        assert_eq!(error.downcast_ref::<ExecError>(), Some(&expected));
        assert_eq!(transport.calls(), index + 1);
    }
}

#[tokio::test(start_paused = true)]
async fn invalid_socket_context_is_rejected_before_any_command() {
    let transport = ScriptedTransport::new(Vec::new(), Duration::ZERO);
    let error = reader("/not-a-named-socket")
        .observe_sessions(&transport, MeasuredVersion::V3_4, end())
        .await
        .unwrap_err();
    assert!(error
        .downcast_ref::<super::super::inventory::InvalidSocket>()
        .is_some());
    assert_eq!(transport.calls(), 0);
}

fn absent(stderr: &str) -> ExecResult {
    ExecResult {
        stdout: String::new(),
        stderr: stderr.into(),
        code: 1,
        utf8_valid: true,
    }
}

fn predicted(path: &str) -> ExecResult {
    output(&format!("S|{path}\n"))
}

/// Both forms measured on 2026-09-15 with tmux 3.3a and 3.4 and again on
/// 2026-10-11 with tmux 3.6: socket file missing, and socket file left behind
/// by a server that has ended.
const DIAGNOSES: [&str; 2] = [
    "error connecting to /tmp/tmux-1000/own (No such file or directory)\n",
    "no server running on /tmp/tmux-1000/own\n",
];

#[tokio::test(start_paused = true)]
async fn a_named_socket_is_absent_only_when_tmux_names_the_predicted_path() {
    for version in [
        MeasuredVersion::V3_3A,
        MeasuredVersion::V3_4,
        MeasuredVersion::V3_6,
    ] {
        for diagnosis in DIAGNOSES {
            let transport = ScriptedTransport::new(
                vec![absent(diagnosis), predicted("/tmp/tmux-1000/own")],
                Duration::from_millis(500),
            );
            let error = reader("own")
                .observe_sessions(&transport, version, end())
                .await
                .unwrap_err();
            assert_eq!(
                error.downcast_ref::<ServerAbsent>(),
                Some(&ServerAbsent),
                "{error:?}"
            );
            let calls = transport.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(
                calls[1].argv,
                ["sh", "-c", SOCKET_PATH_SCRIPT, "aidevbridge-socket", "own"]
            );
            // The prediction shares the one absolute budget of the observation.
            assert_eq!(
                calls[1].remaining,
                Duration::from_secs(20) - Duration::from_millis(500)
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_prediction_that_differs_or_fails_keeps_the_failed_list_an_error() {
    let mut failed = predicted("/tmp/tmux-1000/own");
    failed.code = 1;
    let mut noisy = predicted("/tmp/tmux-1000/own");
    noisy.stderr = "warning\n".into();
    let mut invalid_utf8 = predicted("/tmp/tmux-1000/own");
    invalid_utf8.utf8_valid = false;
    for prediction in [
        predicted("/unproven/path/own"),
        predicted("/tmp/tmux-1000/other"),
        predicted("tmp/tmux-1000/own"),
        output("S|/tmp/tmux-1000/own"),
        output("/tmp/tmux-1000/own\n"),
        output("S|/tmp/tmux-1000/own\nS|/tmp/tmux-1000/own\n"),
        output(""),
        failed,
        noisy,
        invalid_utf8,
    ] {
        let transport =
            ScriptedTransport::new(vec![absent(DIAGNOSES[1]), prediction], Duration::ZERO);
        let error = reader("own")
            .observe_sessions(&transport, MeasuredVersion::V3_4, end())
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<ParseError>(),
            Some(&ParseError::TmuxError { code: 1 }),
            "{error:?}"
        );
        assert_eq!(transport.calls(), 2);
    }
}

#[tokio::test(start_paused = true)]
async fn other_list_failures_never_ask_for_a_path_prediction() {
    let mut with_stdout = absent(DIAGNOSES[1]);
    with_stdout.stdout = "L|100|1000|$0|x\n".into();
    let mut exit_two = absent(DIAGNOSES[1]);
    exit_two.code = 2;
    let mut invalid_utf8 = absent(DIAGNOSES[1]);
    invalid_utf8.utf8_valid = false;
    for first in [
        absent("error connecting to /tmp/tmux-1000/own (Permission denied)\n"),
        absent("no server running on /tmp/tmux-1000/other\n"),
        absent("no server running on tmp/tmux-1000/own\n"),
        absent("no server running on /tmp/tmux-1000/own\r\n"),
        absent("no server running on /tmp/tmux-1000/own"),
        absent("no server running on /tmp/tmux-1000/own\nadditional error\n"),
        absent("kein Server auf /tmp/tmux-1000/own\n"),
        absent("no current target\n"),
        absent(""),
        with_stdout,
        exit_two,
        invalid_utf8,
    ] {
        let transport = ScriptedTransport::new(vec![first], Duration::ZERO);
        let error = reader("own")
            .observe_sessions(&transport, MeasuredVersion::V3_4, end())
            .await
            .unwrap_err();
        assert!(error.downcast_ref::<ServerAbsent>().is_none(), "{error:?}");
        assert_eq!(transport.calls(), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn tmux_3_0_keeps_a_failed_first_list_an_error() {
    // 3.0 derives the path differently on its very first call ("/tmp//...")
    // and has no measurement of the prediction.
    let transport = ScriptedTransport::new(vec![absent(DIAGNOSES[0])], Duration::ZERO);
    let error = reader("own")
        .observe_sessions(&transport, MeasuredVersion::V3_0, end())
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<ParseError>(),
        Some(&ParseError::TmuxError { code: 1 })
    );
    assert_eq!(transport.calls(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_failed_prediction_transport_stops_the_observation() {
    let transport = ScriptedTransport::new(
        vec![absent(DIAGNOSES[0]), predicted("/tmp/tmux-1000/own")],
        Duration::ZERO,
    );
    let expected = ExecError {
        phase: ExecPhase::Read,
        reason: ExecReason::Transport,
        submission: Submission::PossiblySubmitted,
    };
    transport.steps.lock().unwrap()[1].result = Err(expected);
    let error = reader("own")
        .observe_sessions(&transport, MeasuredVersion::V3_4, end())
        .await
        .unwrap_err();
    assert_eq!(error.downcast_ref::<ExecError>(), Some(&expected));
    assert_eq!(transport.calls(), 2);
}

fn default_reader() -> TmuxClient {
    TmuxClient::new(&TmuxSocket::default_named("default"))
}

/// Spec 2026-10-25 §6.2: Die Version stammt vom laufenden Server und ist fuer
/// alle Sessions dieselbe; `list-sessions` startet keinen Server.
#[tokio::test(start_paused = true)]
async fn the_server_version_comes_from_the_running_server() {
    let transport = ScriptedTransport::new(vec![output("3.6\n3.6\n")], Duration::ZERO);
    assert_eq!(
        default_reader()
            .server_version(&transport, Some(MeasuredVersion::V3_6), end())
            .await
            .unwrap(),
        Some("3.6".to_string())
    );
    assert_eq!(
        transport.calls.lock().unwrap()[0].argv,
        [
            "env",
            "LC_ALL=C",
            "tmux",
            "-u",
            "-L",
            "default",
            "list-sessions",
            "-F",
            "#{version}"
        ]
    );
    let transport = ScriptedTransport::new(vec![output("")], Duration::ZERO);
    assert_eq!(
        default_reader()
            .server_version(&transport, Some(MeasuredVersion::V3_6), end())
            .await
            .unwrap(),
        None
    );
    for answer in ["3.6\n3.4\n", "3.6", "3.6 \n", "\n"] {
        let transport = ScriptedTransport::new(vec![output(answer)], Duration::ZERO);
        assert!(
            default_reader()
                .server_version(&transport, Some(MeasuredVersion::V3_6), end())
                .await
                .is_err(),
            "{answer:?}"
        );
    }
}

/// Ohne Server ist die Liste leer, bewiesen wie in `observe_sessions`: tmux
/// nennt genau den vorhergesagten Pfad. Sonst bleibt es ein Fehler.
#[tokio::test(start_paused = true)]
async fn a_missing_default_server_is_proven_like_a_missing_own_server() {
    let diagnosis = "no server running on /tmp/tmux-1000/default\n";
    let v36 = Some(MeasuredVersion::V3_6);
    let transport = ScriptedTransport::new(
        vec![absent(diagnosis), predicted("/tmp/tmux-1000/default")],
        Duration::ZERO,
    );
    assert_eq!(
        default_reader()
            .server_version(&transport, v36, end())
            .await
            .unwrap(),
        None
    );
    // Ohne gemessene Vorhersage (tmux 3.0 oder ein ungemessenes tmux im PATH)
    // beweist es die Diagnose wie in list_session_names, ohne weiteren Aufruf.
    for installed in [None, Some(MeasuredVersion::V3_0)] {
        let transport = ScriptedTransport::new(vec![absent(diagnosis)], Duration::ZERO);
        assert_eq!(
            default_reader()
                .server_version(&transport, installed, end())
                .await
                .unwrap(),
            None
        );
        assert_eq!(transport.calls(), 1);
    }
    let denied = "error connecting to /tmp/tmux-1000/default (Permission denied)\n";
    for (script, installed) in [
        (
            vec![absent(diagnosis), predicted("/tmp/tmux-1000/other")],
            v36,
        ),
        (vec![absent(denied)], v36),
        (vec![absent(denied)], None),
    ] {
        let calls = script.len();
        let transport = ScriptedTransport::new(script, Duration::ZERO);
        assert!(default_reader()
            .server_version(&transport, installed, end())
            .await
            .is_err());
        assert_eq!(transport.calls(), calls);
    }
}
