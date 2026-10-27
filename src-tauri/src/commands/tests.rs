use super::*;

fn sock() -> TmuxSocket {
    TmuxSocket::own(&OwnSocket::new("sock").unwrap())
}

fn bound_listing(id: u32) -> crate::tmux::client::ListedSessionObservation {
    crate::tmux::client::ListedSessionObservation {
        session_id: SessionId(id),
        display_name: format!("ab_{id}"),
        binding: Ok(crate::tmux::session_binding::BoundObservation {
            display_name: format!("ab_{id}"),
            selected: PaneIdentity {
                server: ServerIdentity {
                    pid: 50,
                    start_time: 1000,
                },
                session_id: SessionId(id),
                window_id: WindowId(4),
                pane_id: PaneId(7),
                pane_pid: 10,
            },
            creation_matched: false,
        }),
    }
}

/// tmux 3.0 reports no client flags in `list-clients` (measured J lines),
/// so the confirmed open cannot register there. Its rows must not steer
/// the frontend into that open; kill and status stay bound.
#[test]
fn list_item_offers_the_confirmed_open_only_where_it_can_register() {
    for version in [
        MeasuredVersion::V3_3A,
        MeasuredVersion::V3_4,
        MeasuredVersion::V3_6,
    ] {
        let listing = bound_listing(3);
        let status = crate::status::from_listing(&listing);
        let row = session_list_item(listing, status, version, None);
        assert_eq!(
            (row.window_id, row.pane_id, row.pane_pid),
            (Some(4), Some(7), Some(10)),
            "{version:?}"
        );
    }
    let listing = bound_listing(3);
    let status = crate::status::from_listing(&listing);
    let row = session_list_item(listing, status, MeasuredVersion::V3_0, None);
    assert_eq!(
        (row.session_id, row.server_pid, row.server_start_time),
        (Some(3), Some(50), Some(1000))
    );
    assert_eq!(
        (row.window_id, row.pane_id, row.pane_pid),
        (None, None, None)
    );
}

fn poll_exec(stdout: &str) -> ExecResult {
    ExecResult {
        utf8_valid: true,
        stdout: stdout.into(),
        stderr: String::new(),
        code: 0,
    }
}

const POLL_INVENTORY: &str = "B|50|1000\nQ|$0|1\nQ|$1|1\nP|$0|@0|%0|10|1|1|0|0|0|1789296086|0|1\nP|$1|@1|%1|20|1|1|0|0|0|1789296086|0|1\nE|50|1000\n";

const DEFAULT_INVENTORY: &str =
    "B|60|2000\nQ|$5|1\nP|$5|@3|%9|30|1|1|0|0|1|1789296086|0|1\nE|60|2000\n";

fn failed_exec(stderr: &str) -> ExecResult {
    ExecResult {
        utf8_valid: true,
        stdout: String::new(),
        stderr: stderr.into(),
        code: 1,
    }
}

/// Spec 2026-10-25 §6.3: Beide Sockets in einer Abfrage, der eigene zuerst,
/// jeder mit seinem Inventar und seinen Titeln; claude einmal.
#[tokio::test]
async fn one_poll_reads_both_sockets_and_claude_once() {
    let default = TmuxSocket::default_named("dflt");
    let t = ScriptedTransport::new(vec![
        poll_exec("tmux 3.6\n"),
        poll_exec(POLL_INVENTORY),
        poll_exec(""),
        poll_exec("[]"),
        poll_exec(DEFAULT_INVENTORY),
        poll_exec(""),
    ]);
    let polled = poll_sockets_with(
        &t,
        &sock(),
        Some(&default),
        tokio::time::Instant::now() + COMMAND_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(*t.calls.lock().unwrap(), 6);
    let lines: Vec<_> = t
        .lines
        .lock()
        .unwrap()
        .iter()
        .map(|line| crate::remote::command::decoded_argv(line))
        .collect();
    assert_eq!(&lines[1][4..6], ["-L", "sock"]);
    // claude kommt vor dem Standard-Socket.
    assert!(
        lines[3].iter().any(|arg| arg.contains("claude")),
        "{:?}",
        lines[3]
    );
    assert_eq!(&lines[4][4..6], ["-L", "dflt"]);
    assert_eq!(&lines[5][3..], ["aidevbridge-panes", "dflt", "%9", "30"]);
    let own = polled.own.unwrap();
    assert_eq!((own.server_pid, own.sessions.len()), (Some(50), 2));
    let default = polled.default.unwrap().unwrap();
    assert!(default.complete && default.agents_ok && default.titles_ok);
    assert_eq!(
        (default.server_pid, default.server_start_time),
        (Some(60), Some(2000))
    );
    assert_eq!(
        default
            .sessions
            .iter()
            .map(|row| row.session_id)
            .collect::<Vec<_>>(),
        [5]
    );
}

/// Kein Server auf dem Standard-Socket ist ein vollstaendiges, leeres
/// Ergebnis, wenn tmux genau den vorhergesagten Pfad nennt; jeder andere
/// Fehler dort trifft nur diesen Socket (Spec 2026-10-25 §6.3).
#[tokio::test]
async fn the_default_socket_fails_or_ends_on_its_own() {
    let default = TmuxSocket::default_named("dflt");
    for (prediction, absent) in [
        ("S|/tmp/tmux-1000/dflt\n", true),
        ("S|/tmp/tmux-1000/other\n", false),
    ] {
        let t = ScriptedTransport::new(vec![
            poll_exec("tmux 3.6\n"),
            poll_exec(POLL_INVENTORY),
            poll_exec(""),
            poll_exec("[]"),
            failed_exec("no server running on /tmp/tmux-1000/dflt\n"),
            poll_exec(prediction),
        ]);
        let polled = poll_sockets_with(
            &t,
            &sock(),
            Some(&default),
            tokio::time::Instant::now() + COMMAND_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(polled.own.unwrap().sessions.len(), 2);
        match polled.default.unwrap() {
            Ok(poll) => {
                assert!(absent, "an unproven absence must stay an error");
                assert!(poll.complete && poll.sessions.is_empty());
                assert_eq!(poll.server_pid, None);
            }
            Err(_) => assert!(!absent, "a proven absence is no error"),
        }
    }
}

/// The status poll needs no per-session name binding: version, one
/// inventory, the active panes' titles, the Claude CLI and one /proc
/// lookup -- five commands for any number of sessions.
#[tokio::test]
async fn status_poll_reads_the_inventory_titles_and_the_cli_in_five_commands() {
    let titles = [
        crate::status::title::details_line('T', 1, "[ ! ] Action Required | thread | home"),
        crate::status::title::details_line('C', 1, "/usr/bin/node"),
        crate::status::title::details_line('G', 1, "/usr/lib/node_modules/@openai/codex/bin/codex"),
    ]
    .concat();
    let t = ScriptedTransport::new(vec![
        poll_exec("tmux 3.4\n"),
        poll_exec(POLL_INVENTORY),
        poll_exec(&titles),
        poll_exec(
            r#"[{"kind":"interactive","pid":11,"status":"waiting","waitingFor":"permission prompt"}]"#,
        ),
        poll_exec("11 10\n"),
    ]);
    let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(*t.calls.lock().unwrap(), 5);
    // The title read names exactly the active pane of each session.
    assert_eq!(
        &crate::remote::command::decoded_argv(&t.lines.lock().unwrap()[2])[3..],
        ["aidevbridge-panes", "sock", "%0", "10", "%1", "20"]
    );
    assert_eq!(
        poll,
        StatusPollDto {
            complete: true,
            server_pid: Some(50),
            server_start_time: Some(1000),
            sessions: vec![
                StatusRowDto {
                    session_id: 0,
                    status: "waiting".into(),
                    status_reason: "permission prompt".into(),
                },
                StatusRowDto {
                    session_id: 1,
                    status: "waiting".into(),
                    status_reason: "action required (Codex title)".into(),
                },
            ],
            agents_ok: true,
            titles_ok: true,
        }
    );
}

/// A failed title read means "no title source", not a failed poll.
#[tokio::test]
async fn status_poll_without_titles_still_reports_the_cli_status() {
    let mut failed = poll_exec("");
    failed.code = 1;
    let t = ScriptedTransport::new(vec![
        poll_exec("tmux 3.4\n"),
        poll_exec(POLL_INVENTORY),
        failed,
        poll_exec(r#"[{"kind":"interactive","pid":10,"status":"busy"}]"#),
        poll_exec("10 1\n"),
    ]);
    let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(*t.calls.lock().unwrap(), 5);
    assert_eq!(
        poll.sessions,
        vec![
            StatusRowDto {
                session_id: 0,
                status: "busy".into(),
                status_reason: "agent is busy".into(),
            },
            StatusRowDto {
                session_id: 1,
                status: "unknown".into(),
                status_reason: "no agent source is attached yet".into(),
            },
        ]
    );
}

/// tmux 3.6 (Ubuntu 26.04, gemessen am 2026-10-11) geht wie 3.4 durch die
/// Abfrage: dieselben Befehle, derselbe Inventarweg, dasselbe Ergebnis.
#[tokio::test]
async fn status_poll_runs_the_measured_tmux_3_6_exactly_like_3_4() {
    let mut polls = Vec::new();
    for version in ["tmux 3.4\n", "tmux 3.6\n"] {
        let t = ScriptedTransport::new(vec![
            poll_exec(version),
            poll_exec(POLL_INVENTORY),
            poll_exec(""),
            poll_exec("[]"),
        ]);
        let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(*t.calls.lock().unwrap(), 4, "{version:?}");
        polls.push((poll, t.lines.lock().unwrap()[1..].to_vec()));
    }
    assert!(polls[1].0.complete);
    assert_eq!(polls[1].0.server_pid, Some(50));
    assert_eq!(polls[1].0.sessions.len(), 2);
    assert_eq!(polls[1], polls[0]);
}

#[tokio::test]
async fn status_poll_on_an_unmeasured_tmux_version_claims_nothing() {
    // 3.5/3.5a und das unveraendert gebaute Upstream-3.6a sind nicht
    // gemessen; `tmux 3.6\r\n` ist nicht die gemessene Antwort.
    for version in ["tmux 3.5a\n", "tmux 3.5\n", "tmux 3.6a\n", "tmux 3.6\r\n"] {
        let t = ScriptedTransport::new(vec![poll_exec(version)]);
        let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(*t.calls.lock().unwrap(), 1, "{version:?}");
        assert_eq!(
            poll,
            StatusPollDto {
                complete: false,
                server_pid: None,
                server_start_time: None,
                sessions: vec![],
                agents_ok: false,
                titles_ok: false,
            },
            "{version:?}"
        );
    }
}

/// A named socket has no proven absence diagnosis: an error is a failed
/// poll (shown as not current), never an empty list that ends sessions.
#[tokio::test]
async fn status_poll_fails_when_the_inventory_is_not_a_complete_snapshot() {
    let mut failed = poll_exec("");
    failed.code = 1;
    failed.stderr = "no server running on /tmp/tmux-1000/sock\n".into();
    let t = ScriptedTransport::new(vec![poll_exec("tmux 3.4\n"), failed]);
    assert!(
        poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
            .await
            .is_err()
    );
    assert_eq!(*t.calls.lock().unwrap(), 2);
}

// --- Restzeiten der Statusabfrage, in virtueller Zeit ---

/// Eine Antwort, die nach `elapsed` virtueller Zeit eintrifft.
struct TimedStep {
    result: Result<ExecResult, ExecError>,
    elapsed: Duration,
}

/// Wie in `tmux/client_observation_tests.rs`: spielt Antworten ab, stellt
/// die angehaltene Uhr je Antwort vor und merkt sich Zeile und Frist.
struct TimedTransport {
    steps: StdMutex<VecDeque<TimedStep>>,
    calls: StdMutex<Vec<(String, Duration)>>,
}

impl TimedTransport {
    fn calls(&self) -> Vec<(String, Duration)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl Transport for TimedTransport {
    async fn exec_with_deadline(
        &self,
        line: &str,
        timeout: Duration,
    ) -> anyhow::Result<ExecResult> {
        self.calls.lock().unwrap().push((line.to_owned(), timeout));
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unerwarteter Folgebefehl");
        if !step.elapsed.is_zero() {
            tokio::time::advance(step.elapsed).await;
        }
        step.result.map_err(Into::into)
    }
    async fn dispose(&self) {}
}

fn ms(millis: u64) -> Duration {
    Duration::from_millis(millis)
}

fn answered(result: ExecResult, elapsed: Duration) -> TimedStep {
    TimedStep {
        result: Ok(result),
        elapsed,
    }
}

fn failed(reason: ExecReason) -> TimedStep {
    TimedStep {
        result: Err(ExecError {
            phase: ExecPhase::Read,
            reason,
            submission: Submission::PossiblySubmitted,
        }),
        elapsed: Duration::ZERO,
    }
}

/// Titelbefehl fuer die beiden aktiven Panes aus `POLL_INVENTORY`.
fn title_line() -> String {
    crate::status::title::details_command(&sock(), &[(PaneId(0), 10), (PaneId(1), 20)]).unwrap()
}

/// Poll mit 5 s Gesamtfrist; Version sofort, das Inventar verbraucht
/// `spent`. Jede Antwort in `rest` muss abgerufen werden, jeder weitere
/// Befehl scheitert an `TimedTransport`.
async fn timed_poll(spent: Duration, rest: Vec<TimedStep>) -> (StatusPollDto, TimedTransport) {
    let mut steps = vec![
        answered(poll_exec("tmux 3.4\n"), Duration::ZERO),
        answered(poll_exec(POLL_INVENTORY), spent),
    ];
    steps.extend(rest);
    let t = TimedTransport {
        steps: StdMutex::new(steps.into()),
        calls: StdMutex::new(Vec::new()),
    };
    let deadline = tokio::time::Instant::now() + STATUS_POLL_TIMEOUT;
    let poll = poll_status_with(&t, &sock(), deadline).await.unwrap();
    assert!(
        t.steps.lock().unwrap().is_empty(),
        "Antwort nicht abgerufen"
    );
    (poll, t)
}

#[tokio::test(start_paused = true)]
async fn poll_skips_titles_when_less_than_500ms_remain() {
    // 499 ms nach dem Inventar: weder Titel noch claude.
    let (poll, t) = timed_poll(ms(4501), vec![]).await;
    assert!(poll.complete);
    assert_eq!((poll.titles_ok, poll.agents_ok), (false, false));
    assert_eq!(t.calls().len(), 2);
    // Genau 500 ms reichen, mit der Restzeit als Frist.
    let (poll, t) = timed_poll(ms(4500), vec![answered(poll_exec(""), ms(0))]).await;
    assert!(poll.titles_ok);
    assert_eq!(t.calls()[2], (title_line(), ms(500)));
}

#[tokio::test(start_paused = true)]
async fn poll_skips_claude_when_less_than_1500ms_remain() {
    let (poll, t) = timed_poll(ms(3501), vec![answered(poll_exec(""), ms(0))]).await;
    assert_eq!((poll.titles_ok, poll.agents_ok), (true, false));
    assert_eq!(t.calls().len(), 3);
    assert_eq!(t.calls()[2], (title_line(), ms(1000)));
    // Genau 1500 ms: claude startet mit 1500 - 700 = 800 ms.
    let (poll, t) = timed_poll(
        ms(3500),
        vec![
            answered(poll_exec(""), ms(0)),
            answered(poll_exec("[]"), ms(0)),
        ],
    )
    .await;
    assert!(poll.agents_ok);
    assert_eq!(t.calls()[3], (crate::status::agents_command(), ms(800)));
}

/// Ein Agent mit pid 11: Er bindet nur ueber seinen Elternprozess an die
/// Pane mit pid 10.
fn busy_agent() -> ExecResult {
    poll_exec(r#"[{"kind":"interactive","pid":11,"status":"busy"}]"#)
}

/// 3 s vor claude: Frist min(4 s, 3 s - 700 ms) = 2,3 s. Antwortet claude
/// erst am Ende dieser Frist, bleiben den Elternprozessen genau 700 ms.
#[tokio::test(start_paused = true)]
async fn claude_timeout_leaves_700ms_for_parents() {
    let (poll, t) = timed_poll(
        ms(2000),
        vec![
            answered(poll_exec(""), ms(0)),
            answered(busy_agent(), ms(2300)),
            answered(poll_exec("11 10\n"), ms(0)),
        ],
    )
    .await;
    let calls = t.calls();
    assert_eq!(calls[3], (crate::status::agents_command(), ms(2300)));
    assert_eq!(
        calls[4],
        (crate::status::parents_command(&[11]).unwrap(), ms(700))
    );
    assert!(poll.agents_ok);
    assert_eq!(poll.sessions[0].status, "busy");
}

/// Echt haelt die 700-ms-Reserve den Eltern genug Zeit frei; nur eine
/// verspaetete Skriptantwort von claude erreicht diesen Zweig.
#[tokio::test(start_paused = true)]
async fn poll_skips_parents_when_less_than_500ms_remain() {
    // 5 s - 2 s - 2,501 s = 499 ms: kein Elternbefehl, die Quelle fehlt.
    let (poll, t) = timed_poll(
        ms(2000),
        vec![
            answered(poll_exec(""), ms(0)),
            answered(busy_agent(), ms(2501)),
        ],
    )
    .await;
    assert!(!poll.agents_ok);
    assert_eq!(t.calls().len(), 4);
    // Genau 500 ms reichen, mit der Restzeit als Frist.
    let (poll, t) = timed_poll(
        ms(2000),
        vec![
            answered(poll_exec(""), ms(0)),
            answered(busy_agent(), ms(2500)),
            answered(poll_exec("11 10\n"), ms(0)),
        ],
    )
    .await;
    assert!(poll.agents_ok);
    assert_eq!(
        t.calls()[4],
        (crate::status::parents_command(&[11]).unwrap(), ms(500))
    );
}

#[tokio::test(start_paused = true)]
async fn parents_read_failure_sets_agents_ok_false() {
    let mut refused = poll_exec("");
    refused.code = 1;
    for (parents, agents_ok) in [
        (failed(ExecReason::Transport), false),
        (failed(ExecReason::Timeout), false),
        // Eine Antwort zaehlt, gleich mit welchem Exitcode.
        (answered(refused, ms(0)), true),
    ] {
        let (poll, t) = timed_poll(
            ms(0),
            vec![
                answered(poll_exec(""), ms(0)),
                answered(busy_agent(), ms(0)),
                parents,
            ],
        )
        .await;
        assert_eq!(
            t.calls()[4].0,
            crate::status::parents_command(&[11]).unwrap()
        );
        assert_eq!(poll.agents_ok, agents_ok);
        // Ohne Eltern bindet die Agentenzeile nicht.
        assert_eq!(poll.sessions[0].status, "unknown");
    }
}

#[tokio::test(start_paused = true)]
async fn claude_without_rows_needs_no_parents_read() {
    let (poll, t) = timed_poll(
        ms(0),
        vec![
            answered(poll_exec(""), ms(0)),
            answered(poll_exec("[]"), ms(0)),
        ],
    )
    .await;
    assert!(poll.agents_ok);
    assert_eq!(t.calls().len(), 4);
}

#[tokio::test(start_paused = true)]
async fn claude_exit_127_counts_as_answered() {
    let mut missing = poll_exec("");
    missing.code = 127;
    missing.stderr = "sh: 1: exec: claude: not found\n".into();
    let (poll, t) = timed_poll(
        ms(0),
        vec![answered(poll_exec(""), ms(0)), answered(missing, ms(0))],
    )
    .await;
    assert!(poll.agents_ok);
    // Ohne Agentenzeile gibt es keine Elternabfrage.
    assert_eq!(t.calls().len(), 4);
    assert!(poll.sessions.iter().all(|row| row.status == "unknown"));
}

#[tokio::test(start_paused = true)]
async fn claude_transport_error_sets_agents_ok_false() {
    // Ein Fristfehler zaehlt wie ein Transportfehler.
    for reason in [ExecReason::Transport, ExecReason::Timeout] {
        let (poll, t) =
            timed_poll(ms(0), vec![answered(poll_exec(""), ms(0)), failed(reason)]).await;
        assert!(poll.complete);
        assert_eq!((poll.titles_ok, poll.agents_ok), (true, false));
        assert_eq!(t.calls().len(), 4);
    }
}

/// Fuer die Panetitel gilt dieselbe Regel wie fuer claude.
#[tokio::test(start_paused = true)]
async fn title_answer_with_any_exit_code_counts_a_transport_error_does_not() {
    let mut refused = poll_exec("");
    refused.code = 1;
    let (poll, _) = timed_poll(
        ms(0),
        vec![answered(refused, ms(0)), answered(poll_exec("[]"), ms(0))],
    )
    .await;
    assert!(poll.titles_ok);
    let (poll, _) = timed_poll(
        ms(0),
        vec![
            failed(ExecReason::Transport),
            answered(poll_exec("[]"), ms(0)),
        ],
    )
    .await;
    assert_eq!((poll.titles_ok, poll.agents_ok), (false, true));
}
use crate::transport::operation_control::{ExecPhase, Submission};
use crate::transport::ExecResult;
use async_trait::async_trait;
use rand::SeedableRng;
use std::collections::VecDeque;
use std::sync::Mutex as StdMutex;
use zeroize::Zeroizing;

// --- resolve_auth_method ---
//
// `AuthMethod` hat kein `PartialEq` (siehe dessen Doc-Kommentar in
// `ssh/auth.rs` -- Geheimnisse in `Zeroizing`-Feldern sollen nicht
// versehentlich ueber eine abgeleitete Gleichheitspruefung verglichen
// werden). Assertions unten entpacken deshalb per `match`/`matches!`,
// wie es der Rest der Codebasis fuer `AuthMethod`/`AuthError` bereits
// durchgaengig tut (siehe `ssh/auth.rs`s Testmodul).

#[test]
fn resolve_auth_method_uses_agent_when_neither_key_path_nor_password_is_given() {
    let m = resolve_auth_method(None, None, None);
    assert!(matches!(m, AuthMethod::Agent));
}

#[test]
fn resolve_auth_method_uses_key_without_passphrase_when_only_key_path_is_given() {
    let m = resolve_auth_method(Some("/home/x/.ssh/id_ed25519".to_string()), None, None);
    match m {
        AuthMethod::Key { path, passphrase } => {
            assert_eq!(path, PathBuf::from("/home/x/.ssh/id_ed25519"));
            assert!(passphrase.is_none());
        }
        other => panic!("falsche Variante: {other:?}"),
    }
}

/// `AuthMethod::Key{passphrase: Some(..)}` entsteht ausserhalb der Modultests
/// nur hier, aus `HostSpecDto` (siehe `ssh/auth.rs` fuer die Methode selbst).
#[test]
fn resolve_auth_method_uses_key_with_passphrase_when_both_are_given() {
    let m = resolve_auth_method(
        Some("/home/x/.ssh/id_ed25519".to_string()),
        Some(Zeroizing::new("hunter2".to_string())),
        None,
    );
    match m {
        AuthMethod::Key { path, passphrase } => {
            assert_eq!(path, PathBuf::from("/home/x/.ssh/id_ed25519"));
            assert_eq!(
                passphrase
                    .expect("Passphrase muss erhalten bleiben")
                    .as_str(),
                "hunter2"
            );
        }
        other => panic!("falsche Variante: {other:?}"),
    }
}

/// `AuthMethod::Password` entsteht ausserhalb der Modultests ebenfalls nur
/// hier.
#[test]
fn resolve_auth_method_uses_password_when_no_key_path_is_given() {
    let m = resolve_auth_method(None, None, Some(Zeroizing::new("hunter2".to_string())));
    match m {
        AuthMethod::Password(pw) => assert_eq!(pw.as_str(), "hunter2"),
        other => panic!("falsche Variante: {other:?}"),
    }
}

/// Vorrangregel (siehe Doc-Kommentar an `resolve_auth_method`): ein
/// gesetzter Schluesselpfad gewinnt IMMER gegen ein ebenfalls gesetztes
/// Passwort -- ein Formular, das beide Felder gleichzeitig ausgefuellt
/// zeigt, darf nicht zufaellig das eine oder andere waehlen.
#[test]
fn resolve_auth_method_prefers_key_path_over_password_when_both_are_given() {
    let m = resolve_auth_method(
        Some("/home/x/.ssh/id_ed25519".to_string()),
        None,
        Some(Zeroizing::new("hunter2".to_string())),
    );
    assert!(matches!(m, AuthMethod::Key { .. }));
}

/// Gegenprobe zur Vorrangregel aus der anderen Richtung: eine Passphrase
/// OHNE Schluesselpfad wird stillschweigend verworfen, nicht als Passwort
/// missverstanden (Spec §8.4: Passphrase gehoert ausschliesslich zu
/// Schluessel-Auth).
#[test]
fn resolve_auth_method_ignores_a_passphrase_without_a_key_path() {
    let m = resolve_auth_method(None, Some(Zeroizing::new("hunter2".to_string())), None);
    assert!(matches!(m, AuthMethod::Agent));
}

// --- HostSpecDto ueber den tatsaechlichen Draht (JSON), nicht nur
// per Rust-Struct-Literal -- belegt, dass die Geheimnisfelder auch beim
// ECHTEN `invoke()`-Aufruf aus dem WebView ankommen. ---

#[test]
fn host_spec_dto_deserializes_passphrase_and_password_from_json() {
    let json = r#"{
        "hostname": "192.0.2.10",
        "port": 22,
        "user": "u",
        "key_path": "/home/x/.ssh/id_ed25519",
        "passphrase": "hunter2",
        "password": "irrelevant-bei-key-auth"
    }"#;
    let dto: HostSpecDto = serde_json::from_str(json).unwrap();
    assert_eq!(dto.passphrase.as_ref().map(|p| p.as_str()), Some("hunter2"));
    assert_eq!(
        dto.password.as_ref().map(|p| p.as_str()),
        Some("irrelevant-bei-key-auth")
    );
}

/// Gegenprobe: ein Formular ohne Schluesseldatei (first-run.ts' Zweig
/// ohne `keyPath`) sendet `passphrase`/`password` NICHT als literales
/// `null`, sondern laesst die Schluessel ganz weg -- `#[serde(default)]`
/// muss das ohne Fehler in `None` uebersetzen.
#[test]
fn host_spec_dto_defaults_passphrase_and_password_to_none_when_the_keys_are_absent() {
    let json = r#"{
        "hostname": "192.0.2.10",
        "port": 22,
        "user": "u",
        "key_path": null
    }"#;
    let dto: HostSpecDto = serde_json::from_str(json).unwrap();
    assert!(dto.passphrase.is_none());
    assert!(dto.password.is_none());
}

// --- OutputEvent: der Kern des Bytepfads ---

/// Belegt die zentrale Zusicherung des Bytepfads: `bytes` ueberlebt
/// eine Serde-Rundreise (wie sie ein `app.emit` durchlaeuft) auch dann
/// byteidentisch, wenn der Puffer an einer Mehrbyte-UTF-8-Grenze
/// zerschnitten ist -- `[0xE2, 0x82]` allein ist keine gueltige
/// UTF-8-Sequenz (der Anfang von `€` = `[0xE2, 0x82, 0xAC]` ohne das
/// dritte Byte). `serde_json` serialisiert `Vec<u8>` ohne `serde_bytes`
/// als JSON-Array roher Zahlenwerte, nicht als Text -- deshalb betrifft
/// UTF-8-Gueltigkeit die Serialisierung ueberhaupt nicht.
#[test]
fn output_event_round_trips_bytes_exactly_even_across_a_split_utf8_boundary() {
    let bytes = vec![b'x', 0xE2, 0x82, b'y', 0xE2, 0x82, 0xAC, b'z'];
    let ev = OutputEvent {
        host_id: "h1".into(),
        session: "ab_000000".to_string(),
        bytes: bytes.clone(),
        open_id: "fixture-open".into(),
    };
    let json = serde_json::to_string(&ev).unwrap();
    let back: serde_json::Value = serde_json::from_str(&json).unwrap();
    let round_tripped: Vec<u8> = back["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    assert_eq!(
        round_tripped, bytes,
        "rohe Bytes muessen die Serde-Rundreise unveraendert ueberstehen, \
         auch mit einer abgeschnittenen Mehrbyte-Sequenz darin"
    );
}

// --- session_key / belongs_to_host ---

#[test]
fn session_key_distinguishes_pairs_that_would_collide_under_naive_concatenation() {
    assert_ne!(
        session_key("1", SocketKind::App, "23"),
        session_key("12", SocketKind::App, "3")
    );
    assert_ne!(
        session_key("h1", SocketKind::App, "x"),
        session_key("h1", SocketKind::Default, "x")
    );
    assert!(belongs_to_host(
        &session_key("h1", SocketKind::Default, "x"),
        "h1"
    ));
}

#[test]
fn belongs_to_host_requires_the_separator_not_just_a_prefix() {
    // h1 darf NICHT als Praefix von h10 durchgehen.
    assert!(!belongs_to_host("h10:ab_x", "h1"));
    assert!(belongs_to_host("h1:ab_x", "h1"));
    assert!(!belongs_to_host("h1:ab_x", "h10"));
}

// --- next_host_id ---

#[test]
fn next_host_id_produces_distinct_increasing_ids() {
    let counter = AtomicU64::new(0);
    let a = next_host_id(&counter);
    let b = next_host_id(&counter);
    assert_eq!(a, "h0");
    assert_eq!(b, "h1");
    assert_ne!(a, b);
}

// --- owns_current_entry (Wiedereroeffnen-Wettrennen) ---

#[test]
fn stale_pump_task_does_not_remove_a_reopened_entrys_slot() {
    // Generation 1 ist fertig, aber die Map zeigt inzwischen Generation
    // 2 (ein zwischenzeitliches close+open) -- Generation 1 darf NICHT
    // aufraeumen.
    assert!(!owns_current_entry(Some(2), 1));
}

#[test]
fn pump_task_removes_its_own_still_current_entry() {
    assert!(owns_current_entry(Some(5), 5));
}

#[test]
fn pump_task_for_an_already_removed_entry_does_nothing() {
    assert!(!owns_current_entry(None, 3));
}

// --- auth_error_message (Design §4.2/§4.5) ---
//
// Hermetisch, ohne VM und ohne AIDEVBRIDGE_TEST_HOST. Bewusst NICHT
// ueber `key_auth_error_survives_the_anyhow_boundary` abgedeckt: der
// belegt `KeyUnreadable`, nicht `PassphraseRequired`, und laeuft ohne
// gesetzte Umgebungsvariable als No-Op durch -- genau die Zitierweise,
// die dieses Projekt achtmal bestraft hat.

/// Die Kerneigenschaft: der Nutzer bekommt die handlungsleitende
/// Meldung, nicht `anyhow`s knappen `Display`-Text. Die zweite
/// Zusicherung ist die diskriminierende -- ohne sie waere der Test auch
/// dann gruen, wenn `user_message()` denselben Text wie `Display`
/// zurueckgaebe (dann wuerde er nichts ueber die Verdrahtung sagen).
#[test]
fn auth_error_message_prefers_the_user_message_over_the_terse_display() {
    let e = anyhow::Error::from(AuthError::PassphraseRequired);
    assert_eq!(
        auth_error_message(&e),
        AuthError::PassphraseRequired.user_message()
    );
    assert_ne!(
        auth_error_message(&e),
        "passphrase required",
        "der knappe Display-Text darf NICHT mehr beim Nutzer landen"
    );
}

/// Der wichtigste Einzelfall (Design §4.5): Windows 11 liefert den
/// ssh-agent standardmaessig deaktiviert aus. `AgentUnavailable`s
/// `user_message()` nennt den PowerShell-Befehl, der ihn startet; der Test
/// haelt fest, dass `auth_error_message` genau diese Meldung liefert.
#[test]
fn auth_error_message_carries_the_actionable_ssh_agent_instruction() {
    let e = anyhow::Error::from(AuthError::AgentUnavailable(
        "connection refused".to_string(),
    ));
    let message = auth_error_message(&e);
    assert!(
        message.contains("Set-Service ssh-agent"),
        "die ssh-agent-Meldung muss den Startbefehl enthalten, war: {message}"
    );
}

/// Zwei Nicht-Regressionen in einem: eine `AuthError`-Variante bleibt
/// auch hinter einer `.context()`-Schicht findbar (heute fuegt niemand
/// eine hinzu -- das soll auch dann noch gelten, wenn jemand es tut),
/// und ein Fehler, der KEIN `AuthError` ist, behaelt seinen Text.
#[test]
fn auth_error_message_survives_context_and_falls_back_for_other_errors() {
    let wrapped = anyhow::Error::from(AuthError::PasswordWrong).context("connect failed");
    assert_eq!(
        auth_error_message(&wrapped),
        AuthError::PasswordWrong.user_message()
    );

    let unrelated = anyhow::anyhow!("something else entirely");
    assert_eq!(auth_error_message(&unrelated), "something else entirely");
}

// --- classify_connect_error (Spec §4.8) -- ein ungetesteter
// Klassifikator waere in dieser Datei ein Fremdkoerper (siehe die
// Testdichte um `auth_error_message` direkt oberhalb). Deckt die
// Abbildungstabelle ab: die zehn `AuthError`-Faelle und die beiden
// Host-Key-Sonderfaelle.

/// Der Host, den `classify_connect_error` in der Hostschluesselmeldung
/// nennt (nur dort); die uebrigen Tests brauchen irgendeinen Wert.
const CLASSIFY_HOST: &str = "192.0.2.20";

#[test]
fn classify_connect_error_maps_password_wrong_to_password_required() {
    let e = anyhow::Error::from(AuthError::PasswordWrong);
    let classified = classify_connect_error(&e, None, CLASSIFY_HOST);
    assert_eq!(classified.code, "password_required");
    assert_eq!(classified.message, AuthError::PasswordWrong.user_message());
}

#[test]
fn classify_connect_error_maps_passphrase_variants_to_passphrase_required() {
    for variant in [AuthError::PassphraseRequired, AuthError::PassphraseWrong] {
        let e = anyhow::Error::from(variant);
        assert_eq!(
            classify_connect_error(&e, None, CLASSIFY_HOST).code,
            "passphrase_required"
        );
    }
}

#[test]
fn classify_connect_error_maps_host_unreachable() {
    let e = anyhow::Error::from(AuthError::HostUnreachable);
    assert_eq!(
        classify_connect_error(&e, None, CLASSIFY_HOST).code,
        "host_unreachable"
    );
}

#[test]
fn classify_connect_error_maps_method_not_offered_key_unreadable_and_agent_unavailable_to_auth_rejected(
) {
    for variant in [
        AuthError::MethodNotOffered("publickey".into()),
        AuthError::MultiFactorRequired("publickey".into()),
        AuthError::KeyUnreadable("x".into()),
        AuthError::AgentUnavailable("x".into()),
        AuthError::AgentNoIdentities("x".into()),
    ] {
        let e = anyhow::Error::from(variant);
        assert_eq!(
            classify_connect_error(&e, None, CLASSIFY_HOST).code,
            "auth_rejected"
        );
    }
}

/// Ein Fehler, der KEIN `AuthError` ist (z. B. ein TCP-Verbindungsfehler
/// ohne Host-Key-Entscheidung), faellt auf `"other"` -- dieselbe
/// Rueckfallkategorie, die `auth_error_message` fuer diesen Fall waehlt.
#[test]
fn classify_connect_error_falls_back_to_other_for_a_non_auth_error() {
    let e = anyhow::anyhow!("connection reset by peer");
    let classified = classify_connect_error(&e, None, CLASSIFY_HOST);
    assert_eq!(classified.code, "other");
    assert_eq!(classified.message, "connection reset by peer");
}

/// Host-Key-Ablehnung gewinnt VOR jeder Auth-Klassifikation. Die beiden
/// Meldungstexte sind die aus Spec §10 (UX-Ueberarbeitung) -- Satz fuer
/// Satz, denn der Nutzer liest sie unveraendert im Verbindungsfeld. Der
/// `code` bleibt `host_key_rejected`: das Frontend wertet nur ihn aus,
/// nie den Text.
#[test]
fn classify_connect_error_prefers_host_key_decision_over_auth_classification() {
    // Ein frei erfundener zugrundeliegender Fehler -- die Klassifikation
    // soll ihn bei gesetzter Host-Key-Entscheidung gar nicht erst ansehen.
    let e = anyhow::anyhow!("irrelevant underlying error");

    let unknown = classify_connect_error(&e, Some(HostKeyDecision::Unknown), CLASSIFY_HOST);
    assert_eq!(unknown.code, "host_key_rejected");
    assert_eq!(
        unknown.message,
        "The host key wasn't confirmed, so aidevbridge didn't connect."
    );

    let mismatch = classify_connect_error(&e, Some(HostKeyDecision::Mismatch), CLASSIFY_HOST);
    assert_eq!(mismatch.code, "host_key_rejected");
    assert_eq!(
        mismatch.message,
        "The host key of 192.0.2.20 has changed. Someone may be intercepting the connection \
         — or the server was reinstalled. If you're sure, remove its old entry from \
         ~/.ssh/known_hosts, for example with ssh-keygen -R \"192.0.2.20\", and connect \
         again."
    );
}

/// Der Host in der Meldung ist der Name, unter dem `known_hosts` ihn fuehrt
/// (`known_hosts::host_token`, so ruft `connect_host_core` es auf): ohne
/// Port auf 22 der Host selbst, sonst `[host]:port`, auch ein IPv6-Literal.
/// Unter diesem Namen sucht der Nutzer den alten Eintrag zum Entfernen.
#[test]
fn a_changed_host_key_names_the_known_hosts_token() {
    let e = anyhow::anyhow!("irrelevant underlying error");
    for (hostname, port, named) in [
        ("192.0.2.20", 22, "192.0.2.20"),
        ("vm.example", 22, "vm.example"),
        ("vm.example", 2222, "[vm.example]:2222"),
        ("fe80::1", 22, "fe80::1"),
        ("fe80::1", 2222, "[fe80::1]:2222"),
    ] {
        let host = known_hosts::host_token(hostname, port);
        let mismatch = classify_connect_error(&e, Some(HostKeyDecision::Mismatch), &host);
        assert_eq!(mismatch.code, "host_key_rejected");
        assert!(
            mismatch
                .message
                .starts_with(&format!("The host key of {named} has changed. ")),
            "{hostname}:{port}: {}",
            mismatch.message
        );
    }
}

#[test]
fn rsa_signing_failure_survives_context_and_does_not_request_passphrase() {
    let error = anyhow::Error::new(AuthError::SigningFailed).context("authentication failed");
    for decision in [None, Some(HostKeyDecision::Known)] {
        let classified = classify_connect_error(&error, decision, CLASSIFY_HOST);
        assert_eq!(classified.code, "auth_rejected");
        assert_eq!(classified.message, AuthError::SigningFailed.user_message());
        assert_ne!(
            classified.message,
            AuthError::PassphraseWrong.user_message()
        );
    }
}

// --- AckWindow (reine Buchhaltung) ---

#[test]
fn ack_window_has_room_up_to_capacity() {
    let mut w = AckWindow::new(100);
    assert!(w.has_room(100));
    w.reserve(100);
    assert!(!w.has_room(1));
}

#[test]
fn ack_window_release_restores_room() {
    let mut w = AckWindow::new(100);
    w.reserve(100);
    assert!(!w.has_room(1));
    w.release(40);
    assert!(w.has_room(40));
    assert!(!w.has_room(41));
}

#[test]
fn ack_window_lets_a_single_oversized_chunk_through_when_empty() {
    let w = AckWindow::new(10);
    assert!(w.has_room(999));
}

#[test]
fn ack_window_oversized_chunk_still_blocks_a_second_chunk_until_acked() {
    let mut w = AckWindow::new(10);
    w.reserve(999);
    assert!(!w.has_room(1));
}

#[test]
fn ack_window_release_saturates_instead_of_underflowing() {
    let mut w = AckWindow::new(100);
    w.reserve(10);
    w.release(999); // zu grosser/doppelter Ack
    assert_eq!(w.in_flight(), 0);
    assert!(w.has_room(100));
}

// --- AckGate (die eigentliche Bremse, async) ---

/// Der wichtigste Test der Bremse: belegt, dass `wait_for_room`
/// TATSAECHLICH blockiert, nicht bloss Buchhaltung fuehrt, und dass ein
/// `ack()` es tatsaechlich wieder freigibt.
#[tokio::test]
async fn ack_gate_actually_restrains_and_then_releases() {
    let gate = Arc::new(AckGate::new(10));
    gate.wait_for_room(10).await; // Fenster komplett ausgeschoepft

    let g = gate.clone();
    let mut waiter = tokio::spawn(async move {
        g.wait_for_room(5).await;
    });

    let premature = tokio::time::timeout(std::time::Duration::from_millis(100), &mut waiter).await;
    assert!(
        premature.is_err(),
        "wait_for_room durfte ohne ausreichenden Kredit nicht zurueckkehren"
    );

    gate.ack(5);

    let completed = tokio::time::timeout(std::time::Duration::from_millis(500), waiter).await;
    assert!(
        completed.is_ok(),
        "wait_for_room haette nach ack() zurueckkehren muessen"
    );
}

// --- ack_output_impl gegen einen bereits entfernten Eintrag (Befund 9 der
// Bewertung 2026-09-04): die Pumpaufgabe entfernt den Terminaleintrag, BEVOR
// das WebView das Ack fuer den letzten Chunk aus seinem `write()`-Callback
// schickt. Dasselbe nachlaufende Ack trifft dann ins Leere -- kein Fehler,
// dieselbe Idempotenz wie `disconnect_host_impl`. ---

#[tokio::test]
async fn ack_for_an_unknown_terminal_is_ok_not_an_error() {
    let state = Arc::new(AppState::default());
    let r = ack_output_impl(&state, "h1".into(), "gone".into(), 42).await;
    assert!(
        r.is_ok(),
        "ein nachlaufendes Ack fuer einen bereits entfernten Eintrag ist kein Fehler"
    );
}

// --- wait_for_room_cancel_or_stall (Design §2.4:
// Abbruchsignal gegen das Verwaisen der Pumpaufgabe, wenn ihre Session
// waehrend eines Wartens in `wait_for_room` abgeraeumt wird; Stillstands-
// Zeitlimit gegen einen Renderer, der nicht mehr ackt) ---

/// Der eigentliche Beweis fuer das Abbruchsignal: ohne Kredit UND ohne
/// Abbruch haengt die Funktion. Kommt ein Abbruchsignal, MUSS sie
/// zurueckkehren -- und mit `Cancelled`, nicht `Proceed`: eine
/// Implementierung, die bei Abbruch faelschlich `Proceed` liefert, wuerde
/// den Pump-Loop `sink.send()` aufrufen lassen, obwohl kein Kredit
/// reserviert wurde (Buchhaltung liefe aus dem Ruder).
///
/// `stall_timeout` bewusst eine Stunde: dieser Test prueft den
/// Abbruchpfad, nicht den Waechter. Waere der Wert hier klein, koennte
/// der Test gruen bleiben, weil der WAECHTER zurueckkehrt -- und die
/// Abbrucheigenschaft waere ungeprueft.
#[tokio::test]
async fn wait_for_room_cancel_or_stall_returns_cancelled_instead_of_hanging_forever() {
    let gate = Arc::new(AckGate::new(10));
    gate.wait_for_room(10).await; // Fenster ausgeschoepft, niemand wird je acken

    let cancel = Arc::new(Notify::new());
    let g = gate.clone();
    let c = cancel.clone();
    let mut waiter = tokio::spawn(async move {
        wait_for_room_cancel_or_stall(&g, &c, 5, Duration::from_secs(3600)).await
    });

    let premature = tokio::time::timeout(Duration::from_millis(100), &mut waiter).await;
    assert!(
        premature.is_err(),
        "ohne Kredit, ohne Abbruch und ohne abgelaufenen Waechter darf sie nicht zurueckkehren"
    );

    cancel.notify_one();

    let completed = tokio::time::timeout(Duration::from_millis(500), waiter)
        .await
        .expect("haette nach dem Abbruchsignal zurueckkehren muessen")
        .expect("Task ist gepanickt");
    assert_eq!(
        completed,
        PumpDecision::Cancelled,
        "ein Abbruch muss Cancelled liefern (kein Kredit reserviert)"
    );
}

/// Gegenprobe zur `notify_one`-Entscheidung (siehe `AckGate::ack`s
/// Kommentar): ein Abbruchsignal, das VOR dem Warten ankommt, darf nicht
/// verloren gehen.
#[tokio::test]
async fn wait_for_room_cancel_or_stall_does_not_lose_a_cancel_sent_before_waiting() {
    let gate = AckGate::new(10);
    gate.wait_for_room(10).await; // ausgeschoepft
    let cancel = Notify::new();
    cancel.notify_one(); // Abbruch VOR dem Aufruf

    let decision = tokio::time::timeout(
        Duration::from_millis(200),
        wait_for_room_cancel_or_stall(&gate, &cancel, 5, Duration::from_secs(3600)),
    )
    .await
    .expect("haette nicht haengen duerfen -- verlorenes Weck-Signal?");
    assert_eq!(
        decision,
        PumpDecision::Cancelled,
        "ein VOR dem Warten gesetztes Abbruchsignal darf nicht verloren gehen"
    );
}

/// Kredit vorhanden -> `Proceed`. Der langweiligste Fall, und trotzdem
/// noetig: ohne ihn koennte eine Implementierung, die IMMER `Stalled`
/// liefert, die beiden Abbruchtests oben bestehen.
#[tokio::test]
async fn wait_for_room_cancel_or_stall_proceeds_when_there_is_room() {
    let gate = AckGate::new(1000);
    let cancel = Notify::new();
    let decision =
        wait_for_room_cancel_or_stall(&gate, &cancel, 10, Duration::from_millis(50)).await;
    assert_eq!(decision, PumpDecision::Proceed);
}

/// Der Waechter selbst: Fenster voll, niemand ackt, kein Abbruch --
/// nach `stall_timeout` MUSS `Stalled` kommen statt zu haengen. Das ist
/// die Eigenschaft, die verhindert, dass eine einzige ungeackte Session
/// den geteilten russh-Dispatch-Loop der ganzen Verbindung staut
/// (Design §2.1, empirisch belegt in §2.2).
#[tokio::test]
async fn wait_for_room_cancel_or_stall_reports_stalled_when_no_ack_ever_arrives() {
    let gate = AckGate::new(10);
    gate.wait_for_room(10).await; // ausgeschoepft
    let cancel = Notify::new();

    let started = std::time::Instant::now();
    let decision = tokio::time::timeout(
        Duration::from_secs(5),
        wait_for_room_cancel_or_stall(&gate, &cancel, 5, Duration::from_millis(150)),
    )
    .await
    .expect("der Waechter haette nach stall_timeout zurueckkehren muessen, statt zu haengen");

    assert_eq!(decision, PumpDecision::Stalled);
    assert!(
        started.elapsed() >= Duration::from_millis(150),
        "der Waechter darf nicht VOR seinem Zeitlimit feuern -- sonst wuerde er einen \
         langsamen, aber gesunden Renderer abschiessen (tatsaechlich: {:?})",
        started.elapsed()
    );
}

/// Die andere Richtung, und der wichtigere der beiden Waechter-Tests:
/// ein langsam aber STETIG ackender Renderer darf ueber eine
/// Gesamtdauer von deutlich MEHR als `stall_timeout` hinweg NICHT
/// abgeschossen werden. Das Zeitlimit gilt pro Aufruf, nicht fuer die
/// Lebensdauer der Session.
///
/// Ohne diesen Test bliebe eine spaeter naheliegend aussehende
/// Umstrukturierung gruen -- das Zeitlimit AUSSERHALB der Pumpschleife
/// aufzuspannen -- und wuerde die Bedeutung lautlos zu "jede Session,
/// die unter Rueckstau laenger als STALL_TIMEOUT lebt, stirbt"
/// verschieben.
///
/// Praezisierung, was dieser Test NICHT beweist: er ruft die Pumpschleife in
/// `TerminalPump` selbst nicht auf, sondern ausschliesslich
/// `wait_for_room_cancel_or_stall` direkt -- eine ausserhalb der Schleife
/// aufgespannte Deadline waere fuer diesen Test unsichtbar. Was der Test
/// tatsaechlich beweist: ein stetig ackender Aufrufer bekommt ueber
/// WIEDERHOLTE Aufrufe hinweg nie `Stalled`, UND die Gesamtdauer
/// ueberschreitet `stall_timeout` (siehe die Assertion unten) -- die
/// Pro-Aufruf-Semantik selbst folgt bereits aus der Signatur (die Funktion ist
/// zustandslos, jeder Aufruf spannt sein eigenes `tokio::time::sleep` auf; die
/// Gegenprobe dazu bestaetigt nur, dass ein kleinerer `stall_timeout`-Wert
/// Runde 0 rot werden laesst, nicht, dass das Zeitlimit ueber Aufrufe hinweg
/// zusammenhaengt). Dass die Pumpschleife dieses Pro-Aufruf-Verhalten nicht
/// versehentlich in ein Pro-Session-Verhalten verwandelt, sichert stattdessen
/// der Integrationstest
/// `a_stalled_session_does_not_take_the_whole_connection_down` gegen die echte
/// Schleife ab. Ein spaeterer Umbau auf ein deadline-basiertes statt ein
/// pro-Aufruf-Zeitlimit wuerde die Signatur aendern (kein `stall_timeout:
/// Duration`-Parameter mehr) -- dieser Test wuerde dann ohnehin neu
/// geschrieben, nicht lautlos gruen bleiben.
#[tokio::test]
async fn wait_for_room_cancel_or_stall_budget_is_per_call_not_per_session() {
    // Zeitverhaeltnisse mit Absicht weit auseinander: jede EINZELNE
    // Wartezeit hat gegen das Zeitlimit einen Faktor 20 Luft (25 ms gegen
    // 500 ms), damit der Test auf einer belasteten Maschine nicht
    // flackert -- die SUMME (25 x 25 ms = 625 ms) ueberschreitet das
    // Limit trotzdem. Genau diese Kombination ist der Punkt: mit einem
    // globalen Zeitlimit waere der Test rot, mit einem Pro-Aufruf-Limit
    // gruen.
    let gate = Arc::new(AckGate::new(100));
    let cancel = Notify::new();
    let stall_timeout = Duration::from_millis(500);
    const ROUNDS: usize = 25;
    const ACK_DELAY: Duration = Duration::from_millis(25);

    // Fenster zuerst ausschoepfen, damit ab Runde 0 wirklich gewartet
    // wird. Ohne das laesst `has_room`s `in_flight == 0`-Notausgang die
    // erste Runde sofort durch, und der Test prueeft eine Runde weniger,
    // als er zu pruefen behauptet.
    gate.wait_for_room(100).await;

    let started = std::time::Instant::now();
    for round in 0..ROUNDS {
        // Genau EIN Acker je Runde, der genau die reservierte Menge
        // freigibt -- danach ist `in_flight` wieder 0 und die Runde
        // reserviert erneut 100. Keine ueberzaehligen Acks, die
        // `release`s saturierende Subtraktion stillschweigend
        // verschluckt: die Buchhaltung bleibt fuer den naechsten Leser
        // nachvollziehbar.
        let g = gate.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ACK_DELAY).await;
            g.ack(100);
        });
        let decision = wait_for_room_cancel_or_stall(&gate, &cancel, 100, stall_timeout).await;
        assert_eq!(
            decision,
            PumpDecision::Proceed,
            "Runde {round}: ein stetig ackender Renderer darf nie Stalled bekommen"
        );
    }
    assert!(
        started.elapsed() > stall_timeout,
        "der Test ist vakuos, wenn die Gesamtdauer ({:?}) das Zeitlimit ({stall_timeout:?}) \
         nicht ueberschreitet -- dann haette auch ein einziges globales Zeitlimit gereicht",
        started.elapsed()
    );
}

// --- read_known_hosts_text (H5, Kritikrunde) ---

#[tokio::test]
async fn read_known_hosts_text_missing_file_is_empty_not_an_error() {
    let path = std::env::temp_dir().join(format!(
        "aidevbridge_test_read_known_hosts_missing_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    assert!(!path.exists());
    let text = read_known_hosts_text(&path)
        .await
        .expect("eine fehlende Datei ist kein Fehler");
    assert_eq!(text, "", "eine fehlende Datei zaehlt als leerer Inhalt");
}

/// Der eigentliche Beleg fuer H5: eine Datei, die zwar EXISTIERT, aber
/// nicht gelesen werden kann (hier: ein Verzeichnis unter demselben
/// Pfad -- `read_to_string` auf ein Verzeichnis schlaegt mit einem
/// Fehler fehl, der NICHT `NotFound` ist), darf NICHT wie eine leere
/// Datei behandelt werden. Vor der H5-Behebung verschluckte
/// `unwrap_or_default()` genau diesen Fall -- ein Host waere dann immer
/// `Unknown` statt dass ein tatsaechlich veraenderter Schluessel als
/// `Mismatch` erkannt wird.
#[tokio::test]
async fn read_known_hosts_text_unreadable_path_is_an_error_naming_the_path() {
    let path = std::env::temp_dir().join(format!(
        "aidevbridge_test_read_known_hosts_unreadable_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).unwrap();

    let err = read_known_hosts_text(&path).await.expect_err(
        "ein Verzeichnis laesst sich nicht als Text lesen -- das ist ein Fehler, keine leere Datei",
    );
    assert!(
        err.contains(&path.display().to_string()),
        "Meldung soll den betroffenen Pfad nennen: {err}"
    );

    let _ = std::fs::remove_dir(&path);
}

// --- Hostverwaltung: list_hosts_impl/add_host_impl/remove_host_impl
// -- alle drei nehmen `settings_path` explizit entgegen,
// damit diese Tests niemals die echte `%APPDATA%\io.github.itbrain258.aidevbridge\
// settings.toml` des Bedienrechners anfassen (dasselbe Muster wie
// `settings::load_from`/`save_to` gegenueber `load`/`save`).

fn unique_temp_settings_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("aidevbridge_test_cmd_settings_{tag}_{nanos}.toml"))
}

fn new_host_dto(hostname: &str) -> NewHostEntryDto {
    NewHostEntryDto {
        label: hostname.to_string(),
        hostname: hostname.to_string(),
        user: "u".to_string(),
        port: 22,
        tmux_socket: None,
        history_limit: None,
        key_path: None,
        auth_kind: None,
        show_default_socket: None,
    }
}

#[test]
fn list_hosts_impl_on_a_missing_settings_file_is_an_empty_list_not_an_error() {
    let path = unique_temp_settings_path("list_missing");
    assert!(!path.exists());
    assert_eq!(list_hosts_impl(&path).unwrap(), Vec::new());
}

#[test]
fn add_host_impl_persists_defaults_and_list_hosts_impl_sees_it_afterwards() {
    let path = unique_temp_settings_path("add");
    let entry = add_host_impl(&path, new_host_dto("192.0.2.50")).unwrap();
    assert_eq!(entry.hostname, "192.0.2.50");
    assert_eq!(entry.port, 22);
    assert_eq!(entry.tmux_socket, "agentbridge");
    assert_eq!(entry.history_limit, settings::default_history());
    assert!(!entry.id.is_empty());

    let hosts = list_hosts_impl(&path).unwrap();
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0].id, entry.id);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn add_host_impl_twice_produces_two_distinct_ids_and_keeps_both() {
    let path = unique_temp_settings_path("add_twice");
    let a = add_host_impl(&path, new_host_dto("192.0.2.51")).unwrap();
    let b = add_host_impl(&path, new_host_dto("192.0.2.52")).unwrap();
    assert_ne!(a.id, b.id, "zwei Hosts duerfen nicht dieselbe id bekommen");

    let hosts = list_hosts_impl(&path).unwrap();
    assert_eq!(
        hosts.len(),
        2,
        "der zweite add_host darf den ersten nicht ueberschreiben"
    );
    let _ = std::fs::remove_file(&path);
}

// --- UI v2 (Spec §12.4, §16.3): ui_settings_impl ---

#[test]
fn ui_settings_impl_reads_the_default_without_creating_a_file() {
    let path = unique_temp_settings_path("ui_settings_read");
    let dto = ui_settings_impl(&path, None).unwrap();
    assert_eq!(dto.theme, "turquoise");
    assert!(
        !path.exists(),
        "Lesen darf die Datei nicht anlegen (Spec §12.3)"
    );
}

#[test]
fn ui_settings_impl_patch_writes_the_ui_section_and_keeps_hosts() {
    let path = unique_temp_settings_path("ui_settings_patch");
    add_host_impl(&path, new_host_dto("192.0.2.60")).unwrap();
    let dto = ui_settings_impl(&path, Some(theme_patch("slate"))).unwrap();
    assert_eq!(dto.theme, "slate");
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("[ui]"), "{text}");
    assert!(text.contains("theme = \"slate\""), "{text}");
    assert_eq!(
        list_hosts_impl(&path).unwrap().len(),
        1,
        "Hosts bleiben erhalten"
    );
    assert_eq!(ui_settings_impl(&path, None).unwrap().theme, "slate");
    assert_eq!(
        settings::temp_files_beside(&path),
        Vec::<PathBuf>::new(),
        "temporaere Datei wurde umbenannt"
    );
    let _ = std::fs::remove_file(&path);
}

// --- UX-Ueberarbeitung (Spec §7.1, §9.2): Terminal-Voreinstellungen und
// Arbeitsplatz ueber `ui_settings` ---

fn theme_patch(theme: &str) -> UiSettingsPatchDto {
    UiSettingsPatchDto {
        theme: Some(theme.into()),
        ..Default::default()
    }
}

fn tile(slot: u8, host_id: &str, session: &str) -> TileEntryDto {
    TileEntryDto {
        slot,
        host_id: host_id.into(),
        session: session.into(),
        foreign_session: None,
        socket: None,
    }
}

fn dirs(last: Option<&str>, recent: &[&str]) -> HostDirsDto {
    HostDirsDto {
        last: last.map(String::from),
        recent: recent.iter().map(|d| d.to_string()).collect(),
    }
}

/// Ein Arbeitsplatz, der auf beide Hosts verweist.
fn busy_workspace(a: &str, b: &str) -> WorkspaceDto {
    WorkspaceDto {
        layout: 4,
        tiles_version: 2,
        sidebar_collapsed: true,
        expanded: vec![a.into(), b.into()],
        connected: vec![a.into()],
        tiles: vec![tile(0, a, "one"), tile(1, b, "two")],
        dirs: BTreeMap::from([
            (a.to_string(), dirs(Some("/srv/a"), &["/srv/a", "/opt/x"])),
            (b.to_string(), dirs(None, &["/srv/b"])),
        ]),
    }
}

fn empty_workspace() -> WorkspaceDto {
    WorkspaceDto {
        layout: 1,
        // wie Workspace::default(): diesen Stand liest
        // ui_settings_impl_reads_every_default_and_names_the_settings_file
        // aus einer fehlenden Datei
        tiles_version: settings::TILES_VERSION_SLOTS,
        sidebar_collapsed: false,
        expanded: Vec::new(),
        connected: Vec::new(),
        tiles: Vec::new(),
        dirs: BTreeMap::new(),
    }
}

#[test]
fn ui_settings_impl_reads_every_default_and_names_the_settings_file() {
    let path = unique_temp_settings_path("ui_settings_defaults");
    let dto = ui_settings_impl(&path, None).unwrap();
    assert_eq!(
        dto,
        UiSettingsDto {
            theme: "turquoise".into(),
            terminal_font_size: 13,
            copy_on_select: false,
            ctrl_cv_clipboard: true,
            right_click: "menu".into(),
            restore_workspace: true,
            sidebar_width: 240,
            workspace: empty_workspace(),
            settings_path: path.display().to_string(),
        }
    );
    assert!(!path.exists(), "Lesen legt die Datei nicht an");
}

#[test]
fn ui_settings_impl_patch_with_only_the_theme_changes_nothing_else() {
    let path = unique_temp_settings_path("ui_settings_theme_only");
    let a = add_host_impl(&path, new_host_dto("192.0.2.61")).unwrap();
    let b = add_host_impl(&path, new_host_dto("192.0.2.62")).unwrap();
    // Erst alles vom Standard wegsetzen, damit "unveraendert" etwas heisst.
    let before = ui_settings_impl(
        &path,
        Some(UiSettingsPatchDto {
            theme: Some("slate".into()),
            terminal_font_size: Some(17),
            copy_on_select: Some(true),
            ctrl_cv_clipboard: Some(false),
            right_click: Some("paste".into()),
            restore_workspace: Some(false),
            sidebar_width: Some(300),
            workspace: Some(busy_workspace(&a.id, &b.id)),
        }),
    )
    .unwrap();
    assert_eq!(before.terminal_font_size, 17);
    assert!(before.copy_on_select);
    assert!(!before.ctrl_cv_clipboard);
    assert_eq!(before.right_click, "paste");
    assert!(!before.restore_workspace);
    assert_eq!(before.sidebar_width, 300);
    assert_eq!(before.workspace, busy_workspace(&a.id, &b.id));

    let after = ui_settings_impl(&path, Some(theme_patch("turquoise-slate"))).unwrap();
    assert_eq!(after.theme, "turquoise-slate");
    assert_eq!(
        UiSettingsDto {
            theme: before.theme.clone(),
            ..after.clone()
        },
        before,
        "ausser dem Thema bleibt alles stehen"
    );
    assert_eq!(ui_settings_impl(&path, None).unwrap(), after);
    assert_eq!(list_hosts_impl(&path).unwrap().len(), 2, "Hosts bleiben");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn ui_settings_impl_applies_each_patched_field_alone() {
    let path = unique_temp_settings_path("ui_settings_each_field");
    let patches = [
        UiSettingsPatchDto {
            terminal_font_size: Some(18),
            ..Default::default()
        },
        UiSettingsPatchDto {
            copy_on_select: Some(true),
            ..Default::default()
        },
        UiSettingsPatchDto {
            ctrl_cv_clipboard: Some(false),
            ..Default::default()
        },
        UiSettingsPatchDto {
            right_click: Some("paste".into()),
            ..Default::default()
        },
        UiSettingsPatchDto {
            restore_workspace: Some(false),
            ..Default::default()
        },
        UiSettingsPatchDto {
            sidebar_width: Some(360),
            ..Default::default()
        },
    ];
    let mut expected = ui_settings_impl(&path, None).unwrap();
    for patch in patches {
        let got = ui_settings_impl(&path, Some(patch.clone())).unwrap();
        // Genau das gepatchte Feld aendert sich.
        if let Some(value) = patch.terminal_font_size {
            expected.terminal_font_size = value;
        }
        if let Some(value) = patch.copy_on_select {
            expected.copy_on_select = value;
        }
        if let Some(value) = patch.ctrl_cv_clipboard {
            expected.ctrl_cv_clipboard = value;
        }
        if let Some(value) = patch.right_click {
            expected.right_click = value;
        }
        if let Some(value) = patch.restore_workspace {
            expected.restore_workspace = value;
        }
        if let Some(value) = patch.sidebar_width {
            expected.sidebar_width = value;
        }
        assert_eq!(got, expected);
    }
    assert_eq!(ui_settings_impl(&path, None).unwrap(), expected);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn ui_settings_impl_clamps_patched_values_and_returns_what_was_stored() {
    let path = unique_temp_settings_path("ui_settings_clamp");
    let mut workspace = empty_workspace();
    workspace.layout = 3;
    workspace.tiles = vec![tile(9, "nobody", "x")];
    let dto = ui_settings_impl(
        &path,
        Some(UiSettingsPatchDto {
            terminal_font_size: Some(99),
            right_click: Some("bogus".into()),
            sidebar_width: Some(10),
            workspace: Some(workspace),
            ..Default::default()
        }),
    )
    .unwrap();
    // Die Antwort zeigt den gespeicherten Stand, nicht den gesendeten.
    assert_eq!(dto.terminal_font_size, 13);
    assert_eq!(dto.right_click, "menu");
    assert_eq!(dto.sidebar_width, 240);
    assert_eq!(dto.workspace, empty_workspace());
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("terminal_font_size = 13"), "{text}");
    assert!(text.contains("sidebar_width = 240"), "{text}");
    assert_eq!(ui_settings_impl(&path, None).unwrap(), dto);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn ui_settings_impl_patch_with_a_workspace_replaces_the_whole_workspace() {
    let path = unique_temp_settings_path("ui_settings_workspace");
    let a = add_host_impl(&path, new_host_dto("192.0.2.63")).unwrap();
    let b = add_host_impl(&path, new_host_dto("192.0.2.64")).unwrap();

    let first = busy_workspace(&a.id, &b.id);
    let dto = ui_settings_impl(
        &path,
        Some(UiSettingsPatchDto {
            workspace: Some(first.clone()),
            ..Default::default()
        }),
    )
    .unwrap();
    assert_eq!(dto.workspace, first);

    // Ein zweiter, ganz anderer Arbeitsplatz ersetzt den ersten
    // vollstaendig -- nichts davon wird eingemischt.
    let second = WorkspaceDto {
        layout: 2,
        tiles_version: 2,
        sidebar_collapsed: false,
        expanded: vec![b.id.clone()],
        connected: Vec::new(),
        tiles: vec![tile(2, &b.id, "three")],
        dirs: BTreeMap::from([(b.id.clone(), dirs(Some("/only/b"), &["/only/b"]))]),
    };
    let dto = ui_settings_impl(
        &path,
        Some(UiSettingsPatchDto {
            workspace: Some(second.clone()),
            ..Default::default()
        }),
    )
    .unwrap();
    assert_eq!(dto.workspace, second);
    assert_eq!(ui_settings_impl(&path, None).unwrap().workspace, second);

    // Ohne `workspace` im Patch bleibt er, wie er ist.
    let dto = ui_settings_impl(&path, Some(theme_patch("slate"))).unwrap();
    assert_eq!(dto.workspace, second);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn ui_settings_impl_drops_workspace_entries_of_unknown_hosts_when_saving() {
    let path = unique_temp_settings_path("ui_settings_unknown_hosts");
    let a = add_host_impl(&path, new_host_dto("192.0.2.65")).unwrap();
    let mut workspace = busy_workspace(&a.id, "host_ghost");
    workspace.tiles.push(tile(2, "host_ghost", "three"));
    let dto = ui_settings_impl(
        &path,
        Some(UiSettingsPatchDto {
            workspace: Some(workspace),
            ..Default::default()
        }),
    )
    .unwrap();
    assert_eq!(dto.workspace.expanded, std::slice::from_ref(&a.id));
    assert_eq!(dto.workspace.connected, std::slice::from_ref(&a.id));
    assert_eq!(dto.workspace.tiles, [tile(0, &a.id, "one")]);
    assert_eq!(dto.workspace.dirs.keys().collect::<Vec<_>>(), [&a.id]);
    assert!(!std::fs::read_to_string(&path).unwrap().contains("ghost"));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn remove_host_impl_removes_the_host_from_expanded_connected_tiles_and_dirs() {
    let path = unique_temp_settings_path("remove_host_workspace");
    let a = add_host_impl(&path, new_host_dto("192.0.2.66")).unwrap();
    let b = add_host_impl(&path, new_host_dto("192.0.2.67")).unwrap();
    ui_settings_impl(
        &path,
        Some(UiSettingsPatchDto {
            workspace: Some(busy_workspace(&a.id, &b.id)),
            ..Default::default()
        }),
    )
    .unwrap();

    remove_host_impl(&path, &a.id).unwrap();

    let workspace = ui_settings_impl(&path, None).unwrap().workspace;
    assert_eq!(workspace.expanded, std::slice::from_ref(&b.id));
    assert!(workspace.connected.is_empty());
    assert_eq!(workspace.tiles, [tile(1, &b.id, "two")]);
    assert_eq!(
        workspace.dirs,
        BTreeMap::from([(b.id.clone(), dirs(None, &["/srv/b"]))])
    );
    // Layout und Seitenleiste gehoeren keinem Host.
    assert_eq!(workspace.layout, 4);
    assert!(workspace.sidebar_collapsed);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains(&a.id), "{text}");
    assert_eq!(list_hosts_impl(&path).unwrap().len(), 1);
    let _ = std::fs::remove_file(&path);
}

/// Spec §9.2: die Fehlermeldungen nennen die volle Ursachenkette und den
/// Pfad -- eine kaputte Datei zeigt Zeile, Spalte und welche Datei es ist.
#[test]
fn settings_commands_name_the_file_and_the_toml_position_of_a_broken_file() {
    let path = unique_temp_settings_path("broken");
    let broken = "version = 1\n\n[ui]\ntheme = \n";
    std::fs::write(&path, broken).unwrap();
    let shown = path.display().to_string();
    let errors = [
        (
            "ui_settings read",
            ui_settings_impl(&path, None).unwrap_err(),
        ),
        (
            "ui_settings patch",
            ui_settings_impl(&path, Some(theme_patch("slate"))).unwrap_err(),
        ),
        ("list_hosts", list_hosts_impl(&path).unwrap_err()),
        (
            "add_host",
            add_host_impl(&path, new_host_dto("192.0.2.68")).unwrap_err(),
        ),
        (
            "update_host",
            update_host_impl(&path, "any", new_host_dto("192.0.2.68")).unwrap_err(),
        ),
        ("remove_host", remove_host_impl(&path, "any").unwrap_err()),
    ];
    for (command, error) in errors {
        assert!(error.contains(&shown), "{command}: {error}");
        assert!(error.contains("line 4, column"), "{command}: {error}");
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        broken,
        "eine kaputte Datei wird nie ueberschrieben"
    );
    let _ = std::fs::remove_file(&path);
}

/// Die Form auf dem Draht: `types.ts` spiegelt genau diese Schluessel
/// (snake_case, `last` als `null`, wenn es fehlt).
#[test]
fn ui_settings_dto_serializes_with_the_snake_case_keys_the_frontend_mirrors() {
    let dto = UiSettingsDto {
        theme: "slate".into(),
        terminal_font_size: 16,
        copy_on_select: true,
        ctrl_cv_clipboard: false,
        right_click: "paste".into(),
        restore_workspace: false,
        sidebar_width: 300,
        workspace: WorkspaceDto {
            layout: 2,
            tiles_version: 2,
            sidebar_collapsed: true,
            expanded: vec!["h".into()],
            connected: vec!["h".into()],
            tiles: vec![tile(0, "h", "s")],
            dirs: BTreeMap::from([("h".to_string(), dirs(None, &["/a"]))]),
        },
        settings_path: "C:/x/settings.toml".into(),
    };
    assert_eq!(
        serde_json::to_value(&dto).unwrap(),
        serde_json::json!({
            "theme": "slate",
            "terminal_font_size": 16,
            "copy_on_select": true,
            "ctrl_cv_clipboard": false,
            "right_click": "paste",
            "restore_workspace": false,
            "sidebar_width": 300,
            "workspace": {
                "layout": 2,
                "tiles_version": 2,
                "sidebar_collapsed": true,
                "expanded": ["h"],
                "connected": ["h"],
                "tiles": [{ "slot": 0, "host_id": "h", "session": "s" }],
                "dirs": { "h": { "last": null, "recent": ["/a"] } }
            },
            "settings_path": "C:/x/settings.toml"
        })
    );
}

/// Die Formen, die `main.ts` heute schickt, gelten unveraendert: Lesen mit
/// `{ patch: null }`, Themenwechsel mit `{ patch: { theme } }`.
#[test]
fn ui_settings_patch_accepts_what_the_current_frontend_sends() {
    let read: Option<UiSettingsPatchDto> = serde_json::from_value(serde_json::json!(null)).unwrap();
    assert_eq!(read, None);

    let write: Option<UiSettingsPatchDto> =
        serde_json::from_value(serde_json::json!({ "theme": "slate" })).unwrap();
    assert_eq!(write, Some(theme_patch("slate")));

    // Alle Felder sind optional; unbekannte (ein anderer Frontend-Stand)
    // werden uebergangen.
    let empty: UiSettingsPatchDto = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(empty, UiSettingsPatchDto::default());
    let extra: UiSettingsPatchDto =
        serde_json::from_value(serde_json::json!({ "theme": "slate", "future": 1 })).unwrap();
    assert_eq!(extra, theme_patch("slate"));

    // Ein Wert, der nicht in den Zahlentyp passt, klemmt spaeter wie jeder
    // andere ungueltige Wert, statt den Aufruf zu verwerfen.
    let path = unique_temp_settings_path("ui_settings_wide_numbers");
    let wide: UiSettingsPatchDto = serde_json::from_value(serde_json::json!({
        "terminal_font_size": 300,
        "sidebar_width": -4,
    }))
    .unwrap();
    let dto = ui_settings_impl(&path, Some(wide)).unwrap();
    assert_eq!(dto.terminal_font_size, 13);
    assert_eq!(dto.sidebar_width, 240);
    let _ = std::fs::remove_file(&path);
}

/// Ein unvollstaendiger Arbeitsplatz im Patch wird abgelehnt, statt den Rest
/// stillschweigend auf Standard zu setzen: `workspace` ersetzt als Ganzes.
#[test]
fn ui_settings_patch_rejects_an_incomplete_workspace() {
    let error = serde_json::from_value::<UiSettingsPatchDto>(serde_json::json!({
        "workspace": { "layout": 2 }
    }))
    .unwrap_err()
    .to_string();
    assert!(error.contains("missing field"), "{error}");

    // Auch `tiles_version` ist Pflicht: fehlte es still, gaelte ein Stand
    // der Kachelliste als altes Platzmodell (Spec 2026-10-19 §4.6).
    let error = serde_json::from_value::<UiSettingsPatchDto>(serde_json::json!({
        "workspace": {
            "layout": 2,
            "sidebar_collapsed": false,
            "expanded": [],
            "connected": [],
            "tiles": [],
            "dirs": {}
        }
    }))
    .unwrap_err()
    .to_string();
    assert!(error.contains("missing field `tiles_version`"), "{error}");
}

// --- Spec §4.8: add_host_impl/list_hosts_impl und auth_kind ---

#[test]
fn add_host_impl_stores_the_chosen_auth_kind_and_returns_it_immediately() {
    let path = unique_temp_settings_path("add_password_auth_kind");
    let mut dto = new_host_dto("192.0.2.55");
    dto.auth_kind = Some(AuthKind::Password);
    let entry = add_host_impl(&path, dto).unwrap();
    // Sofort im Rueckgabewert, OHNE einen list_hosts-Umweg --
    // `first-run.ts`/`session-dialog.ts` arbeiten direkt damit weiter.
    assert_eq!(entry.auth_kind, Some(AuthKind::Password));

    let hosts = list_hosts_impl(&path).unwrap();
    assert_eq!(hosts[0].auth_kind, Some(AuthKind::Password));
    let _ = std::fs::remove_file(&path);
}

/// Ein DTO OHNE `auth_kind` (aelterer Frontend-Build) darf trotzdem
/// NIE einen Host mit `auth_kind: None` erzeugen -- `add_host_impl`
/// leitet dann aus `key_path` ab, dieselbe Regel wie
/// `HostEntry::effective_auth_kind()`.
#[test]
fn add_host_impl_derives_auth_kind_from_key_path_when_the_dto_omits_it() {
    let path = unique_temp_settings_path("add_missing_auth_kind");
    let mut dto = new_host_dto("192.0.2.56");
    dto.key_path = Some("C:/Users/x/.ssh/id_ed25519".into());
    assert_eq!(
        dto.auth_kind, None,
        "Vorbedingung: das DTO nennt keine Anmeldeart"
    );
    let entry = add_host_impl(&path, dto).unwrap();
    assert_eq!(entry.auth_kind, Some(AuthKind::Key));
    let _ = std::fs::remove_file(&path);
}

/// Belegt Spec §4.8 direkt an der Command-Grenze (nicht nur ueber
/// `HostEntry::effective_auth_kind()`, siehe `settings.rs`s Testmodul):
/// eine ECHTE, bereits existierende `settings.toml` ohne `auth_kind`
/// bleibt lesbar, UND `list_hosts_impl` liefert dafuer nie `None` --
/// `types.ts`s `HostEntry.auth_kind` ist nicht optional, das Frontend
/// darf an dieser Grenze nie `null` sehen.
#[test]
fn list_hosts_impl_never_returns_a_missing_auth_kind_even_for_an_old_settings_file() {
    let path = unique_temp_settings_path("list_old_format");
    std::fs::write(
        &path,
        "version = 1\n\n\
         [[hosts]]\n\
         id = \"h1\"\n\
         label = \"vm\"\n\
         hostname = \"192.0.2.20\"\n\
         user = \"u\"\n\
         key_path = \"C:/Users/x/.ssh/id_ed25519\"\n\n\
         [[hosts]]\n\
         id = \"h2\"\n\
         label = \"pw\"\n\
         hostname = \"192.0.2.21\"\n\
         user = \"u\"\n",
    )
    .unwrap();

    let hosts = list_hosts_impl(&path).unwrap();
    assert_eq!(hosts.len(), 2);
    assert_eq!(hosts[0].auth_kind, Some(AuthKind::Key));
    assert_eq!(hosts[1].auth_kind, Some(AuthKind::Agent));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn update_host_impl_preserves_id_position_other_hosts_and_ui() {
    let path = unique_temp_settings_path("update");
    let a = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
    let b = add_host_impl(&path, new_host_dto("other.example.test")).unwrap();
    let mut current = settings::load_from(&path).unwrap();
    current.ui.theme = "slate".into();
    current.hosts[0].tmux_socket = "custom-socket".into();
    current.hosts[0].history_limit = 12345;
    settings::save_to(&path, &current).unwrap();
    let mut dto = new_host_dto("new.example.test");
    dto.label = "New label".into();
    dto.user = "other-user".into();
    dto.port = 2222;
    dto.key_path = Some("C:/keys/identity".into());
    dto.auth_kind = Some(AuthKind::Key);

    let updated = update_host_impl(&path, &a.id, dto).unwrap();
    assert_eq!(updated.id, a.id);
    assert_eq!(updated.label, "New label");
    assert_eq!(updated.hostname, "new.example.test");
    assert_eq!(updated.user, "other-user");
    assert_eq!(updated.port, 2222);
    assert_eq!(updated.key_path.as_deref(), Some("C:/keys/identity"));
    assert_eq!(updated.auth_kind, Some(AuthKind::Key));
    assert_eq!(updated.tmux_socket, "custom-socket");
    assert_eq!(updated.history_limit, 12345);
    let after = settings::load_from(&path).unwrap();
    assert_eq!(after.hosts, vec![updated, b]);
    assert_eq!(after.ui, current.ui);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn update_host_impl_rejects_unknown_id_without_writing() {
    let path = unique_temp_settings_path("update_unknown");
    add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
    let before = std::fs::read(&path).unwrap();
    let error = update_host_impl(&path, "missing", new_host_dto("new.example.test")).unwrap_err();
    assert!(error.contains("not found"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn update_host_impl_failed_temp_write_preserves_the_complete_settings_file() {
    let path = unique_temp_settings_path("update_write_failure");
    let original = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
    let before = std::fs::read(&path).unwrap();
    let hook = settings::write_hook::set(|stage| match stage {
        settings::WriteStage::BeforeTempWrite => {
            Err(std::io::Error::other("injected write failure"))
        }
        settings::WriteStage::BeforeRename => Ok(()),
    });
    let result = update_host_impl(&path, &original.id, new_host_dto("new.example.test"));
    drop(hook);
    let error = result.unwrap_err();
    assert!(error.contains("could not write"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
    assert_eq!(list_hosts_impl(&path).unwrap(), vec![original]);
    std::fs::remove_file(path).unwrap();
}

/// Wie eine zweite Instanz der App speichern wuerde: die Datei lesen,
/// einen eigenen Host anhaengen, ersetzen. Liefert die geschriebenen Bytes.
fn other_instance_adds_host(path: &Path, id: &str) -> Vec<u8> {
    let mut current = settings::load_from(path).unwrap();
    current.hosts.push(HostEntry {
        id: id.to_string(),
        label: id.to_string(),
        hostname: format!("{id}.example.test"),
        user: "u".into(),
        port: 22,
        tmux_socket: settings::default_socket(),
        history_limit: settings::default_history(),
        key_path: None,
        auth_kind: Some(AuthKind::Agent),
        show_default_socket: true,
    });
    settings::save_to(path, &current).unwrap();
    std::fs::read(path).unwrap()
}

fn saved_host_ids(path: &Path) -> Vec<String> {
    list_hosts_impl(path)
        .unwrap()
        .into_iter()
        .map(|host| host.id)
        .collect()
}

/// Laesst eine zweite Instanz genau einmal dazwischen speichern: beim
/// naechsten Schreibvorgang, nachdem die temporaere Datei fertig ist und
/// bevor sie die Datei ersetzt.
fn another_instance_adds_host_once(path: &Path, id: &str) -> settings::write_hook::Guard {
    let path = path.to_path_buf();
    let mut pending = Some(id.to_string());
    settings::write_hook::set(move |stage| {
        if stage == settings::WriteStage::BeforeRename {
            if let Some(id) = pending.take() {
                other_instance_adds_host(&path, &id);
            }
        }
        Ok(())
    })
}

/// Eine zweite Instanz speichert einen Host, waehrend `add_host_impl`
/// zwischen Lesen und Ersetzen steht: Beide Hosts bleiben erhalten.
#[test]
fn add_host_impl_keeps_a_host_another_instance_saved_meanwhile() {
    let path = unique_temp_settings_path("add_concurrent");
    let first = add_host_impl(&path, new_host_dto("first.example.test")).unwrap();
    let hook = another_instance_adds_host_once(&path, "host_other");
    let added = add_host_impl(&path, new_host_dto("mine.example.test"));
    drop(hook);

    let added = added.unwrap();
    assert_eq!(
        saved_host_ids(&path),
        [first.id, "host_other".to_string(), added.id],
        "der Host der anderen Instanz darf nicht verloren gehen"
    );
    assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
    std::fs::remove_file(path).unwrap();
}

/// Dasselbe fuer `update_host_impl`, `ui_settings_impl` und
/// `remove_host_impl`: Jeder Command wendet nur seine eigene Aenderung auf
/// den neuesten Stand an.
#[test]
fn every_settings_command_keeps_a_host_another_instance_saved_meanwhile() {
    let path = unique_temp_settings_path("commands_concurrent");
    let first = add_host_impl(&path, new_host_dto("first.example.test")).unwrap();

    let hook = another_instance_adds_host_once(&path, "host_during_update");
    let updated = update_host_impl(&path, &first.id, new_host_dto("edited.example.test"));
    drop(hook);
    assert_eq!(updated.unwrap().hostname, "edited.example.test");

    let hook = another_instance_adds_host_once(&path, "host_during_ui");
    let dto = ui_settings_impl(&path, Some(theme_patch("slate")));
    drop(hook);
    assert_eq!(dto.unwrap().theme, "slate");

    let hook = another_instance_adds_host_once(&path, "host_during_remove");
    let removed = remove_host_impl(&path, &first.id);
    drop(hook);
    removed.unwrap();

    assert_eq!(
        saved_host_ids(&path),
        ["host_during_update", "host_during_ui", "host_during_remove"]
    );
    assert_eq!(ui_settings_impl(&path, None).unwrap().theme, "slate");
    assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
    std::fs::remove_file(path).unwrap();
}

/// Schreibt die andere Instanz bei jedem Versuch dazwischen, gibt der
/// Command nach drei Versuchen mit einer Meldung auf. Die Datei traegt
/// dann den Stand der anderen Instanz, und keine temporaere Datei bleibt.
#[test]
fn add_host_impl_gives_up_after_three_attempts_when_another_instance_keeps_writing() {
    let path = unique_temp_settings_path("add_contended");
    add_host_impl(&path, new_host_dto("first.example.test")).unwrap();
    let other_path = path.clone();
    let last_written = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let attempts = std::rc::Rc::new(std::cell::Cell::new(0));
    let (hook_written, hook_attempts) = (last_written.clone(), attempts.clone());
    let hook = settings::write_hook::set(move |stage| {
        if stage == settings::WriteStage::BeforeRename {
            hook_attempts.set(hook_attempts.get() + 1);
            let id = format!("host_other_{}", hook_attempts.get());
            *hook_written.borrow_mut() = other_instance_adds_host(&other_path, &id);
        }
        Ok(())
    });
    let result = add_host_impl(&path, new_host_dto("mine.example.test"));
    drop(hook);

    let error = result.unwrap_err();
    assert!(
        error.contains(&path.display().to_string())
            && error.ends_with(
                "settings.toml was changed by another aidevbridge window at the same time; \
                 try again."
            ),
        "{error}"
    );
    assert_eq!(attempts.get(), 3);
    assert_eq!(std::fs::read(&path).unwrap(), *last_written.borrow());
    assert_eq!(saved_host_ids(&path).len(), 4);
    assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn add_host_impl_refuses_an_impossible_host_name_without_writing() {
    let path = unique_temp_settings_path("add_refused_name");
    add_host_impl(&path, new_host_dto("192.0.2.57")).unwrap();
    let before = std::fs::read(&path).unwrap();
    for hostname in ["*", "a b"] {
        assert_eq!(
            add_host_impl(&path, new_host_dto(hostname)).unwrap_err(),
            HOSTNAME_REFUSED
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
    }
    std::fs::remove_file(path).unwrap();
}

/// Auch ein unveraendert uebernommener, schon gespeicherter Name wird
/// abgewiesen: mit ihm koennte der Host nie verbinden. Ein gueltiger
/// Name repariert denselben Eintrag.
#[test]
fn update_host_impl_refuses_an_impossible_host_name_even_when_it_is_unchanged() {
    let path = unique_temp_settings_path("update_refused_name");
    let valid = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
    let stored = add_host_impl(&path, new_host_dto("other.example.test")).unwrap();
    let mut current = settings::load_from(&path).unwrap();
    current.hosts[1].hostname = "a b".into();
    settings::save_to(&path, &current).unwrap();
    let before = std::fs::read(&path).unwrap();

    let changed = update_host_impl(&path, &valid.id, new_host_dto("user@host"));
    assert_eq!(changed.unwrap_err(), HOSTNAME_REFUSED);
    let mut unchanged = new_host_dto("a b");
    unchanged.label = "Renamed".into();
    let unchanged = update_host_impl(&path, &stored.id, unchanged);
    assert_eq!(unchanged.unwrap_err(), HOSTNAME_REFUSED);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());

    let repaired = update_host_impl(&path, &stored.id, new_host_dto("fixed.example.test"));
    assert_eq!(repaired.unwrap().hostname, "fixed.example.test");
    std::fs::remove_file(path).unwrap();
}

#[cfg(windows)]
#[test]
fn host_update_and_remove_failed_replace_preserve_the_complete_settings_file() {
    use std::os::windows::fs::OpenOptionsExt;

    let path = unique_temp_settings_path("host_replace_failure");
    let original = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
    let before = std::fs::read(&path).unwrap();
    // FILE_SHARE_READ permits the load but denies replacement while held.
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    let update = update_host_impl(&path, &original.id, new_host_dto("new.example.test"));
    assert!(update.unwrap_err().contains("could not replace"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let remove = remove_host_impl(&path, &original.id);
    assert!(remove.unwrap_err().contains("could not replace"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    drop(lock);
    assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn remove_host_impl_removes_exactly_the_matching_id_and_keeps_the_rest() {
    let path = unique_temp_settings_path("remove");
    let a = add_host_impl(&path, new_host_dto("192.0.2.53")).unwrap();
    let b = add_host_impl(&path, new_host_dto("192.0.2.54")).unwrap();

    remove_host_impl(&path, &a.id).unwrap();

    let hosts = list_hosts_impl(&path).unwrap();
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0].id, b.id);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn remove_host_impl_for_an_unknown_id_is_not_an_error() {
    let path = unique_temp_settings_path("remove_unknown");
    add_host_impl(&path, new_host_dto("192.0.2.55")).unwrap();
    assert!(remove_host_impl(&path, "does-not-exist").is_ok());
    assert_eq!(list_hosts_impl(&path).unwrap().len(), 1);
    let _ = std::fs::remove_file(&path);
}

/// Deckt denselben Vertrag ab wie `settings::load_from_a_newer_version_
/// file_propagates_the_error_instead_of_defaulting`, jetzt end-to-end
/// ueber die Command-Huellen: eine `settings.toml` aus einer neueren
/// Version darf kein Hostverwaltungs-Command
/// stillschweigend ueberschreiben -- alle muessen den Fehler
/// durchreichen.
#[test]
fn a_settings_file_from_a_newer_version_blocks_all_host_management_operations() {
    let path = unique_temp_settings_path("newer_version");
    std::fs::write(&path, "version = 99\n").unwrap();

    // Der Nutzer liest die Ursache aus `settings::parse_settings` (Spec
    // §10) hinter dem Pfad; der genaue Wortlaut ist dort festgehalten.
    let error = list_hosts_impl(&path).unwrap_err();
    assert!(
        error.contains(&path.display().to_string())
            && error.contains(": Your settings were saved by a newer aidevbridge. ")
            && error.ends_with("the file was not changed."),
        "{error}"
    );
    assert!(add_host_impl(&path, new_host_dto("192.0.2.56")).is_err());
    assert!(update_host_impl(&path, "anything", new_host_dto("192.0.2.56")).is_err());
    assert!(remove_host_impl(&path, "anything").is_err());

    // Und der wichtigste Teil: die Datei selbst wurde durch keinen der
    // fehlgeschlagenen Aufrufe angetastet.
    let content = std::fs::read_to_string(&path).unwrap();
    assert_eq!(content, "version = 99\n");
    let _ = std::fs::remove_file(&path);
}

// --- create_session_with_retry (abgespielter Transport, wie tmux::client) ---

struct ScriptedTransport {
    responses: StdMutex<VecDeque<ExecResult>>,
    calls: StdMutex<u32>,
    lines: StdMutex<Vec<String>>,
}

impl ScriptedTransport {
    fn new(responses: Vec<ExecResult>) -> Self {
        Self {
            responses: StdMutex::new(responses.into_iter().collect()),
            calls: StdMutex::new(0),
            lines: StdMutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Transport for ScriptedTransport {
    async fn exec_with_deadline(
        &self,
        line: &str,
        _timeout: std::time::Duration,
    ) -> anyhow::Result<ExecResult> {
        *self.calls.lock().unwrap() += 1;
        self.lines.lock().unwrap().push(line.to_owned());
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("kein Skript-Eintrag mehr"))
    }
    async fn dispose(&self) {}
}

fn created() -> ExecResult {
    ExecResult {
        utf8_valid: true,
        stdout: String::new(),
        stderr: String::new(),
        code: 0,
    }
}

fn created_session() -> ExecResult {
    ExecResult {
        utf8_valid: true,
        stdout: "C|50|1000|$0|@0|%0|10\n".into(),
        stderr: String::new(),
        code: 0,
    }
}

fn duplicate() -> ExecResult {
    ExecResult {
        utf8_valid: true,
        stdout: String::new(),
        stderr: "duplicate session: x".to_string(),
        code: 1,
    }
}

fn real_failure() -> ExecResult {
    ExecResult {
        utf8_valid: true,
        stdout: String::new(),
        stderr: "no server running on agentbridge".to_string(),
        code: 1,
    }
}

#[tokio::test]
async fn successful_kill_with_failed_verification_does_not_report_success() {
    let verification_failure = ExecResult {
        utf8_valid: true,
        code: 1,
        stderr: "error connecting to /tmp/tmux-1000/sock (Permission denied)\n".into(),
        ..created()
    };
    let t = ScriptedTransport::new(vec![created(), verification_failure]);
    let error = kill_session_and_verify(
        &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
        &t,
        "dev",
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("Permission denied"));
    assert_eq!(*t.calls.lock().unwrap(), 2);
}

#[tokio::test]
async fn failed_kill_cannot_be_hidden_by_an_empty_followup_query() {
    let kill_failure = ExecResult {
        utf8_valid: true,
        code: 127,
        stderr: "sh: tmux: not found\n".into(),
        ..created()
    };
    let t = ScriptedTransport::new(vec![kill_failure, created()]);
    let error = kill_session_and_verify(
        &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
        &t,
        "dev",
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("tmux: not found"));
    assert_eq!(*t.calls.lock().unwrap(), 1);
}

#[tokio::test]
async fn kill_verification_rejects_a_still_present_session() {
    for kill_result in [
        created(),
        ExecResult {
            utf8_valid: true,
            code: 1,
            stderr: "can't find session: dev\n".into(),
            ..created()
        },
    ] {
        let listing = ExecResult {
            utf8_valid: true,
            stdout: "dev\ndev2\n".into(),
            ..created()
        };
        let t = ScriptedTransport::new(vec![kill_result, listing]);
        let error = kill_session_and_verify(
            &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
            &t,
            "dev",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("still running"));
        assert_eq!(*t.calls.lock().unwrap(), 2);
    }
}

#[tokio::test]
async fn repeated_kill_succeeds_when_the_exact_target_is_verified_absent() {
    let already_missing = ExecResult {
        utf8_valid: true,
        code: 1,
        stderr: "can't find session: dev\n".into(),
        ..created()
    };
    let listing = ExecResult {
        utf8_valid: true,
        stdout: "dev2\n".into(),
        ..created()
    };
    let t = ScriptedTransport::new(vec![already_missing, listing]);
    kill_session_and_verify(
        &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
        &t,
        "dev",
    )
    .await
    .unwrap();
    assert_eq!(*t.calls.lock().unwrap(), 2);
}

#[tokio::test]
async fn killing_the_last_session_accepts_a_verified_absent_server() {
    let no_server = ExecResult {
        utf8_valid: true,
        code: 1,
        stderr: "no server running on /tmp/tmux-1000/sock\n".into(),
        ..created()
    };
    let t = ScriptedTransport::new(vec![created(), no_server]);
    kill_session_and_verify(
        &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
        &t,
        "dev",
    )
    .await
    .unwrap();
    assert_eq!(*t.calls.lock().unwrap(), 2);
}

/// The bound kill verifies through the numeric list. Ending the last
/// session takes the server with it; only an absence proven for exactly
/// the predicted socket path may confirm the kill.
async fn end_last_bound_session(prediction: &str) -> (anyhow::Result<()>, u32) {
    let version = ExecResult {
        utf8_valid: true,
        stdout: "tmux 3.4\n".into(),
        ..created()
    };
    let no_server = ExecResult {
        utf8_valid: true,
        code: 1,
        stderr: "no server running on /tmp/tmux-1000/sock\n".into(),
        ..created()
    };
    let prediction = ExecResult {
        utf8_valid: true,
        stdout: prediction.into(),
        ..created()
    };
    let t = ScriptedTransport::new(vec![created(), version, no_server, prediction]);
    let result = kill_session_bound_and_verify(
        &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
        &t,
        crate::tmux::inventory::ServerIdentity {
            pid: 50,
            start_time: 1000,
        },
        crate::tmux::inventory::SessionId(0),
        tokio::time::Instant::now() + std::time::Duration::from_secs(10),
    )
    .await;
    let calls = *t.calls.lock().unwrap();
    (result, calls)
}

#[tokio::test]
async fn ending_the_last_bound_session_accepts_a_server_proven_absent() {
    let (result, calls) = end_last_bound_session("S|/tmp/tmux-1000/sock\n").await;
    result.unwrap();
    assert_eq!(calls, 4, "kill, version, list and path prediction");
}

#[tokio::test]
async fn ending_the_last_bound_session_rejects_an_unproven_absence() {
    let (result, calls) = end_last_bound_session("S|/tmp/tmux-1000/other\n").await;
    let error = result.unwrap_err();
    assert!(
        error.to_string().contains("tmux binding query failed"),
        "{error:#}"
    );
    assert_eq!(calls, 4);
}

/// Nach einem gelungenen gebundenen Kill erlaubt nur ein gemessenes
/// `tmux -V` die Pruefliste. Jede andere Antwort laesst den Ausgang offen.
async fn end_bound_session_with_version(version: ExecResult) -> (anyhow::Result<()>, u32) {
    let t = ScriptedTransport::new(vec![created(), version]);
    let result = end_bound_session(&t).await;
    let calls = *t.calls.lock().unwrap();
    (result, calls)
}

async fn end_bound_session(transport: &dyn Transport) -> anyhow::Result<()> {
    kill_session_bound_and_verify(
        &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
        transport,
        crate::tmux::inventory::ServerIdentity {
            pid: 50,
            start_time: 1000,
        },
        crate::tmux::inventory::SessionId(0),
        tokio::time::Instant::now() + std::time::Duration::from_secs(10),
    )
    .await
}

/// Nur die Ursache: Die Bitte um eine frische Liste setzt die
/// Command-Grenze davor oder dahinter, genau einmal.
fn assert_unverified_bound_kill(error: &anyhow::Error) {
    assert_eq!(
        error.to_string(),
        "The end of the selected session could not be verified; it may already have ended.",
        "{error:#}"
    );
}

#[tokio::test]
async fn ending_a_bound_session_without_tmux_for_the_version_is_not_reported_done() {
    let (result, calls) = end_bound_session_with_version(ExecResult {
        utf8_valid: true,
        code: 127,
        stderr: "sh: tmux: not found".into(),
        ..created()
    })
    .await;
    assert_unverified_bound_kill(&result.unwrap_err());
    assert_eq!(calls, 2, "kill and version, no list");
}

#[tokio::test]
async fn ending_a_bound_session_on_an_unmeasured_tmux_is_not_reported_done() {
    let (result, calls) = end_bound_session_with_version(ExecResult {
        utf8_valid: true,
        stdout: "tmux 3.5a\n".into(),
        ..created()
    })
    .await;
    assert_unverified_bound_kill(&result.unwrap_err());
    assert_eq!(calls, 2, "kill and version, no list");
}

/// Scheitert die Versionsabfrage selbst, hier an ihrer Frist, bleibt das
/// Ende ebenso unbewiesen. Der `ExecError` bleibt unter der Meldung in der
/// Kette: `operation_error` ordnet den Fehler danach ein.
#[tokio::test]
async fn ending_a_bound_session_whose_version_query_fails_is_not_reported_done() {
    let t = TimedTransport {
        steps: StdMutex::new(
            vec![
                answered(created(), Duration::ZERO),
                failed(ExecReason::Timeout),
            ]
            .into(),
        ),
        calls: StdMutex::new(Vec::new()),
    };
    let error = end_bound_session(&t).await.unwrap_err();
    assert_unverified_bound_kill(&error);
    assert_eq!(
        error.downcast_ref::<ExecError>().map(|error| error.reason),
        Some(ExecReason::Timeout),
        "{error:#}"
    );
    assert_eq!(t.calls().len(), 2, "kill and version, no list");
}

#[tokio::test]
async fn retries_past_duplicate_names_and_succeeds() {
    let t = ScriptedTransport::new(vec![duplicate(), duplicate(), created_session()]);
    let client = OwnTmuxClient::new(&OwnSocket::new("irrelevant").unwrap());
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);
    let name = create_session_with_retry(&client, &t, &mut rng, "/tmp", MAX_NAME_ATTEMPTS)
        .await
        .unwrap();
    assert!(name.starts_with("ab_"));
    assert_eq!(*t.calls.lock().unwrap(), 3, "zwei Kollisionen + ein Erfolg");
}

#[tokio::test]
async fn gives_up_after_max_attempts_consecutive_collisions() {
    let t = ScriptedTransport::new((0..MAX_NAME_ATTEMPTS).map(|_| duplicate()).collect());
    let client = OwnTmuxClient::new(&OwnSocket::new("irrelevant").unwrap());
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);
    let err = create_session_with_retry(&client, &t, &mut rng, "/tmp", MAX_NAME_ATTEMPTS)
        .await
        .expect_err("nach MAX_NAME_ATTEMPTS Kollisionen in Folge muss aufgegeben werden");
    assert!(err.to_string().contains("attempts"));
    assert_eq!(
        *t.calls.lock().unwrap(),
        MAX_NAME_ATTEMPTS,
        "genau MAX_NAME_ATTEMPTS Versuche, kein Off-by-One"
    );
}

#[tokio::test]
async fn does_not_retry_on_a_real_error() {
    // Ein echter Fehlschlag (kein "duplicate session" im Stderr) ist
    // KEINE Namenskollision -- die Schleife darf nicht weiterwuerfeln,
    // sie muss sofort mit dem echten Fehler abbrechen.
    let t = ScriptedTransport::new(vec![real_failure()]);
    let client = OwnTmuxClient::new(&OwnSocket::new("irrelevant").unwrap());
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);
    let err = create_session_with_retry(&client, &t, &mut rng, "/tmp", MAX_NAME_ATTEMPTS)
        .await
        .expect_err("ein echter Fehler darf nicht als Kollision durchgehen");
    assert!(err.to_string().contains("no server running"));
    assert_eq!(
        *t.calls.lock().unwrap(),
        1,
        "ein echter Fehler darf keinen weiteren Versuch ausloesen"
    );
}

// --- is_acceptable_remote_path (H6/H9): Hostdaten, die in eine
// Fernzeile gehen (cwd, path, Sessionname), werden AN DER COMMAND-GRENZE
// geprueft, nicht erst per `assert!` in `remote::build` -- ein Panic dort
// haengt den Tauri-`invoke` (der WebView bekaeme nie eine Antwort), statt
// einen `Err(...)` aufzuloesen. ---

/// Die Regel selbst (und ihr vollstaendiger Test) steht in
/// `settings::is_absolute_remote_path`; dies sind die Grenzfaelle an der
/// Command-Grenze, `is_acceptable_remote_path` ruft sie auf.
#[test]
fn remote_paths_must_be_absolute_and_free_of_control_chars() {
    assert!(is_acceptable_remote_path("/"));
    assert!(is_acceptable_remote_path("/home/u/work"));
    assert!(!is_acceptable_remote_path(""));
    assert!(!is_acceptable_remote_path("relative"));
    assert!(!is_acceptable_remote_path("~/work"));
    assert!(!is_acceptable_remote_path("C:\\work"));
    assert!(!is_acceptable_remote_path("/tmp/a\0b"));
    assert!(!is_acceptable_remote_path("/tmp/a\nb"));
    assert!(!is_acceptable_remote_path("/tmp/a\x1bb"));
}

/// Der eigentliche Beleg: ein relatives `cwd` liefert schon an der
/// Command-Grenze einen `Err(..)` MIT erklaerendem Text (H6/H9). Laeuft
/// OHNE VM -- die Pruefung steht vor dem ersten Zugriff auf `state.hosts`,
/// deshalb genuegt ein nicht verbundener `host_id`.
#[tokio::test]
async fn create_session_rejects_a_relative_cwd_with_an_error_not_a_panic() {
    let state = Arc::new(AppState::default());
    let r = create_session_impl(&state, "no-such-host".into(), "relative".into(), None).await;
    assert!(
        matches!(r, Err(ref e) if e.message.contains("absolute")),
        "erwartet: Err mit 'absolute' in der Meldung, bekommen: {r:?}"
    );
}

/// Pinnt die bewusste Ausnahme in `list_directories_impl`: der LEERE Pfad
/// ist der einzige Weg des Frontends zum Heimatverzeichnis (Spec §3.3,
/// `directory-tree.ts` Zeile 687) und muss deshalb die Pruefung
/// passieren -- er kommt hier als "host not connected" heraus (also erst
/// NACH der Pruefung gescheitert), waehrend ein relativer Pfad weiterhin
/// mit "absolute" im Text abgelehnt wird, VOR jedem Host-Lookup. Ohne
/// diesen Test waere die Ausnahme mit einer gestrichenen Zeile lautlos
/// wieder verschwunden.
#[tokio::test]
async fn list_directories_lets_the_empty_home_path_past_the_boundary_check() {
    let state = Arc::new(AppState::default());

    let r = list_directories_impl(&state, "no-such-host".into(), String::new(), false).await;
    assert_eq!(
        r.unwrap_err(),
        "host not connected",
        "der leere Pfad (Heimatverzeichnis) darf nicht an der Pfadpruefung scheitern"
    );

    let r = list_directories_impl(&state, "no-such-host".into(), "relative".into(), false).await;
    assert!(
        r.unwrap_err().contains("absolute"),
        "ein relativer Pfad muss weiterhin VOR dem Host-Lookup abgelehnt werden"
    );
}

// --- `open_terminal_impl` und `kill_session_impl` pruefen den Sessionnamen
// NICHT gegen die Allowlist aus `session_name_is_acceptable` -- die prueft nur
// Namen, die in `create_session` eingetippt werden. Von Hand in tmux angelegte
// Sessions duerfen Punkte und Nicht-ASCII tragen und muessen sich trotzdem
// oeffnen und beenden lassen; gegen H6 reicht der Ausschluss von leerem Namen
// und Steuerzeichen. Die folgenden zwei Tests belegen fuer beide
// Funktionen, was fuer `create_session_impl`/`list_directories_impl` oben
// bereits gilt: die Namenspruefung steht VOR dem Host-Lookup und ist ohne VM
// erreichbar. ---

/// Test-Doppelgaenger fuer `OutputSink`: in beiden Faellen unten
/// scheitert `open_terminal_impl` entweder an der Namenspruefung oder am
/// Host-Lookup, lange bevor je etwas gesendet wuerde -- die Methode
/// existiert nur, weil der Trait sie verlangt.
struct NullSink;
impl OutputSink for NullSink {
    fn send(&self, _host_id: &str, _session: &str, _bytes: Vec<u8>) -> bool {
        true
    }
}

#[tokio::test]
async fn open_terminal_checks_the_session_name_before_the_host_lookup() {
    let state = Arc::new(AppState::default());

    let r = open_terminal_impl(
        &state,
        NullSink,
        "no-such-host".into(),
        "a\0b".into(),
        80,
        24,
    )
    .await;
    assert_eq!(
        r.unwrap_err(),
        "invalid session name",
        "ein Steuerzeichen im Namen muss VOR dem Host-Lookup abgelehnt werden"
    );

    // "my.project": ein Punkt ist hier erlaubt -- die Allowlist aus
    // `session_name_is_acceptable` gilt nicht fuer von Hand angelegte
    // Sessions. Ohne Verbindung scheitert der Aufruf trotzdem, aber ERST am
    // Host-Lookup, nicht an der Namenspruefung.
    let r = open_terminal_impl(
        &state,
        NullSink,
        "no-such-host".into(),
        "my.project".into(),
        80,
        24,
    )
    .await;
    assert_eq!(
        r.unwrap_err(),
        "host not connected",
        "ein gueltiger Name (auch mit Punkt) darf nicht an der Namenspruefung scheitern"
    );
}

#[tokio::test]
async fn kill_session_checks_the_session_name_before_the_host_lookup() {
    let state = Arc::new(AppState::default());

    let r = kill_session_impl(
        &state,
        "no-such-host".into(),
        SocketKind::App,
        "a\x1bb".into(),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(
        r.unwrap_err(),
        "invalid session name",
        "ein Steuerzeichen im Namen muss VOR dem Host-Lookup abgelehnt werden"
    );

    // "Projekt-Ä": Nicht-ASCII ist hier erlaubt, aus demselben Grund wie
    // oben bei `open_terminal_impl` (siehe `open_terminal_with_history`).
    let r = kill_session_impl(
        &state,
        "no-such-host".into(),
        SocketKind::App,
        "Projekt-Ä".into(),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(
        r.unwrap_err(),
        "host not connected",
        "ein gueltiger Name (auch nicht-ASCII) darf nicht an der Namenspruefung scheitern"
    );
}

// --- open_link (UX-Ueberarbeitung, Spec §6.5) ---

#[test]
fn validate_link_accepts_http_and_https_links() {
    for url in [
        "https://example.com/a?b=c",
        "http://x",
        "https://de.wikipedia.org/wiki/Ärger",
        "https://example.com/a?b=c&d=e#f",
        // RFC 3986 §3.1: das Schema ist unabhaengig von Gross- und
        // Kleinschreibung.
        "HTTPS://EXAMPLE.COM",
        "Http://x",
        // Internationalisierte Domain, unkodiert.
        "https://bücher.de/x",
        // Nutzerangabe, Port und IPv6-Literal sind Teil der Autoritaet,
        // der Host dahinter ist nicht leer.
        "https://user@example.com",
        "https://example.com:8080/x",
        "http://x:80",
        "https://[::1]:8080/",
    ] {
        assert_eq!(validate_link(url), Ok(()), "{url:?}");
    }
}

#[test]
fn validate_link_rejects_other_schemes() {
    for url in [
        "file:///c:/x",
        "javascript:alert(1)",
        "ftp://x",
        "mailto:a@example.com",
        "https:example.com",
        "http:",
        "",
        "example.com",
    ] {
        assert_eq!(validate_link(url), Err(LINK_SCHEME_NOT_ALLOWED), "{url:?}");
    }
}

#[test]
fn validate_link_rejects_a_link_without_host() {
    for url in [
        "https://",
        "http://",
        "https:///etc/passwd",
        "https://?q",
        "https://#f",
        // Nach Abzug von `userinfo@` und `:port` bleibt kein Host.
        "https://:80",
        "https://@",
        "https://user@",
        "https://@:80",
        "https://user:pw@:443/x",
    ] {
        assert_eq!(validate_link(url), Err(LINK_WITHOUT_HOST), "{url:?}");
    }
}

/// Unsichtbare Format- und Bidi-Zeichen (Trojan Source): Der Link saehe
/// im Terminal anders aus, als er geoeffnet wird.
#[test]
fn validate_link_rejects_invisible_format_characters() {
    let invisible = ('\u{200B}'..='\u{200F}')
        .chain('\u{202A}'..='\u{202E}')
        .chain('\u{2066}'..='\u{2069}')
        .chain(['\u{FEFF}']);
    for c in invisible {
        let url = format!("https://exa{c}mple.com/");
        assert_eq!(
            validate_link(&url),
            Err(LINK_HAS_INVISIBLE_FORMAT),
            "U+{:04X}",
            c as u32
        );
    }
    assert_eq!(
        validate_link("https://example.com/\u{202E}gpj.exe"),
        Err(LINK_HAS_INVISIBLE_FORMAT)
    );
}

#[test]
fn validate_link_rejects_whitespace_and_control_characters() {
    for url in [
        "https://exa mple.com",
        "https://x\n",
        " https://x",
        "https://x\ty",
        "https://x\u{a0}y",
        "https://x\u{7f}",
        "https://x\u{85}",
        "https://x\u{1b}[31m",
    ] {
        assert_eq!(
            validate_link(url),
            Err(LINK_HAS_SPACE_OR_CONTROL),
            "{url:?}"
        );
    }
}

#[test]
fn validate_link_allows_at_most_2048_characters() {
    let prefix = "https://x/";
    let longest = format!("{prefix}{}", "a".repeat(MAX_LINK_CHARS - prefix.len()));
    assert_eq!(longest.chars().count(), 2048);
    assert_eq!(validate_link(&longest), Ok(()));
    assert_eq!(validate_link(&format!("{longest}a")), Err(LINK_TOO_LONG));
    // Zeichen, nicht Bytes: 2048 Zeichen mit Umlauten sind laenger als
    // 2048 Bytes und bleiben erlaubt.
    let umlauts = format!("{prefix}{}", "ä".repeat(MAX_LINK_CHARS - prefix.len()));
    assert!(umlauts.len() > MAX_LINK_CHARS);
    assert_eq!(validate_link(&umlauts), Ok(()));
}

/// Der Command selbst lehnt ab, bevor etwas geoeffnet wird. Nur der
/// Fehlerpfad ist so pruefbar -- ein gueltiger Link oeffnete den
/// Browser.
#[tokio::test]
async fn open_link_rejects_a_forbidden_link_before_opening_anything() {
    assert_eq!(
        open_link("javascript:alert(1)".into()).await,
        Err(LINK_SCHEME_NOT_ALLOWED.to_string())
    );
    assert_eq!(
        open_link("https://exa mple.com".into()).await,
        Err(LINK_HAS_SPACE_OR_CONTROL.to_string())
    );
}

/// `ready_host` liefert nur eine fertige Verbindung: ein unbekannter Host
/// und ein noch reservierter Versuch geben `None`, ein `Ready`-Eintrag
/// genau dessen Verbindung. `has_host` folgt derselben Antwort.
#[tokio::test]
async fn ready_host_finds_only_a_ready_connection() {
    let state = Arc::new(AppState::default());
    assert!(state.ready_host("no-such-host").is_none());
    assert!(!state.has_host("no-such-host").await);

    let (expiry, _ended) = oneshot::channel();
    state.hosts.lock().unwrap().insert(
        "pending-h0".into(),
        HostSlot::Pending {
            control: ConnectControl::new(ConnectLimits::default()),
            expiry,
        },
    );
    assert!(state.ready_host("pending-h0").is_none());
    assert!(!state.has_host("pending-h0").await);

    let fixture = crate::connection::tests::Fixture::start(2, false, false, false).await;
    let host = fixture.connect().await.unwrap();
    state
        .hosts
        .lock()
        .unwrap()
        .insert("ready-h0".into(), HostSlot::Ready(host.clone()));
    let found = state.ready_host("ready-h0").expect("ready connection");
    assert!(Arc::ptr_eq(&found, &host));
    assert!(state.has_host("ready-h0").await);
    drop((found, host));

    tokio::time::timeout(
        Duration::from_secs(8),
        disconnect_host_impl(&state, "ready-h0".into()),
    )
    .await
    .unwrap()
    .unwrap();
    fixture.finish(2).await;
}
