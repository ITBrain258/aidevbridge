use super::*;
use crate::remote::command::decoded_argv;
use crate::tmux::inventory::{PaneId, ServerIdentity, SessionId, WindowId};
use crate::tmux::session_binding::PaneIdentity;
use crate::transport::ExecResult;

const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn w_line() -> String {
    format!("W|{NONCE}|10|20|1000|3|/dev/pts/3")
}

fn exec(stdout: &str) -> ExecResult {
    ExecResult {
        utf8_valid: true,
        code: 0,
        stdout: stdout.into(),
        stderr: String::new(),
    }
}

fn pane() -> PaneIdentity {
    PaneIdentity {
        server: ServerIdentity {
            pid: 50,
            start_time: 1000,
        },
        session_id: SessionId(0),
        window_id: WindowId(0),
        pane_id: PaneId(0),
        pane_pid: 10,
    }
}

/// Die PID des eigenen Wrappers in `j_line` und `w_line`.
const OWN_PID: u32 = 10;

fn j_line(flags: &str, uid: &str) -> String {
    format!("J|50|1000|10|20|$0|@0|%0|10|1|1|0|0|0|/dev/pts/3|{uid}|{flags}\n")
}

#[test]
fn wrapper_frame_is_stripped_once_across_chunk_boundaries() {
    let line = format!("{}\n", w_line());
    let bytes = line.as_bytes();
    for split in 1..bytes.len() {
        let mut stream = WrapperStream::new(NONCE.into()).unwrap();
        assert!(stream.identity().is_none());
        stream.ingest(&bytes[..split], false).unwrap();
        let stripped = stream.ingest(&bytes[split..], false).unwrap();
        assert_eq!(stripped, bytes.len() - split);
        let identity = stream.identity().unwrap();
        assert_eq!(stream.nonce(), NONCE);
        assert_eq!(identity.pid, 10);
        assert_eq!(identity.start_ticks, 20);
        assert_eq!(identity.uid, 1000);
        assert_eq!(identity.tty_nr, 3);
        assert_eq!(identity.tty, "/dev/pts/3");
    }
}

#[test]
fn optional_cr_is_accepted_and_binary_after_frame_is_not_stripped() {
    let mut stream = WrapperStream::new(NONCE.into()).unwrap();
    let mut data = format!("{}\r\n", w_line()).into_bytes();
    data.extend_from_slice(&[0, 0xff, b'W']);
    let stripped = stream.ingest(&data, false).unwrap();
    assert_eq!(stripped, w_line().len() + 2);
    assert_eq!(&data[stripped..], &[0, 0xff, b'W']);
}

#[test]
fn prefixed_bytes_wrong_nonce_duplicate_and_oversize_are_unverified() {
    let mut prefixed = WrapperStream::new(NONCE.into()).unwrap();
    let mut data = b"x".to_vec();
    data.extend(format!("{}\n", w_line()).into_bytes());
    assert_eq!(
        prefixed.ingest(&data, false).unwrap_err(),
        Unverified::Frame
    );
    let mut nonce = WrapperStream::new(NONCE.into()).unwrap();
    let bad = format!("W|{}|10|20|1000|3|/dev/pts/3\n", "f".repeat(32));
    assert_eq!(
        nonce.ingest(bad.as_bytes(), false).unwrap_err(),
        Unverified::Frame
    );
    let mut dup = WrapperStream::new(NONCE.into()).unwrap();
    let line = format!("{}\n{}\n", w_line(), w_line());
    assert_eq!(
        dup.ingest(line.as_bytes(), false).unwrap_err(),
        Unverified::Frame
    );
    let mut overlong = WrapperStream::new(NONCE.into()).unwrap();
    let huge = vec![b'a'; 257];
    assert_eq!(
        overlong.ingest(&huge, false).unwrap_err(),
        Unverified::Frame
    );
}

#[test]
fn later_nonmatching_w_line_is_not_another_filter_region() {
    let mut stream = WrapperStream::new(NONCE.into()).unwrap();
    stream
        .ingest(format!("{}\n", w_line()).as_bytes(), false)
        .unwrap();
    let mut other = format!("W|{}|11|21|1001|4|/dev/pts/4\n", "f".repeat(32)).into_bytes();
    other.extend_from_slice(&[0, 0xff]);
    assert_eq!(stream.ingest(&other, false).unwrap(), 0);
    assert_eq!(stream.identity().unwrap().pid, 10);
}

#[test]
fn extended_data_before_wrapper_is_unverified_and_afterward_is_kept() {
    let mut early = WrapperStream::new(NONCE.into()).unwrap();
    assert_eq!(early.ingest(b"x", true).unwrap_err(), Unverified::Frame);
    let mut stream = WrapperStream::new(NONCE.into()).unwrap();
    stream
        .ingest(format!("{}\n", w_line()).as_bytes(), false)
        .unwrap();
    assert_eq!(stream.ingest(&[1, 2, 3], true).unwrap(), 0);
    assert!(stream.identity().is_some());
}

#[test]
fn empty_client_flags_are_unverified_not_legacy_safe() {
    let rows = parse_clients(&exec(&j_line("", "1000")), OWN_PID).unwrap();
    let w = WrapperIdentity {
        pid: 10,
        start_ticks: 20,
        uid: 1000,
        tty_nr: 3,
        tty: "/dev/pts/3".into(),
    };
    assert_eq!(
        registered(&rows, &w, pane()).unwrap_err(),
        Unverified::FlagsUnavailable
    );
}

#[test]
fn registration_ready_retries_absence_and_empty_flags() {
    assert_eq!(registration_ready(Ok(None)), Ok(false));
    assert_eq!(
        registration_ready(Err(Unverified::FlagsUnavailable)),
        Ok(false)
    );
    assert_eq!(
        registration_ready(Err(Unverified::Changed)),
        Err(Unverified::Changed)
    );
    let rows = parse_clients(&exec(&j_line("attached,focused,UTF-8", "1000")), OWN_PID).unwrap();
    let w = WrapperIdentity {
        pid: 10,
        start_ticks: 20,
        uid: 1000,
        tty_nr: 3,
        tty: "/dev/pts/3".into(),
    };
    let process = exec("P|10|20|1000|3|/dev/pts/3|S\n");
    assert_eq!(
        registration_ready(registered_with_process(&rows, &w, pane(), &process)),
        Ok(true)
    );
}

#[test]
fn matching_flags_and_uid_register_the_wrapper() {
    let rows = parse_clients(&exec(&j_line("attached,UTF-8", "1000")), OWN_PID).unwrap();
    let w = WrapperIdentity {
        pid: 10,
        start_ticks: 20,
        uid: 1000,
        tty_nr: 3,
        tty: "/dev/pts/3".into(),
    };
    let row = registered(&rows, &w, pane()).unwrap().unwrap();
    assert_eq!(row.pid, 10);
    assert_eq!(row.tty, "/dev/pts/3");
}

#[test]
fn mismatched_uid_pid_or_mode_is_changed_or_client_mode() {
    let w = WrapperIdentity {
        pid: 10,
        start_ticks: 20,
        uid: 1000,
        tty_nr: 3,
        tty: "/dev/pts/3".into(),
    };
    let uid = parse_clients(&exec(&j_line("attached", "7")), OWN_PID).unwrap();
    assert_eq!(
        registered(&uid, &w, pane()).unwrap_err(),
        Unverified::Changed
    );
    let control = parse_clients(&exec(&j_line("attached,control-mode", "1000")), OWN_PID).unwrap();
    assert_eq!(
        registered(&control, &w, pane()).unwrap_err(),
        Unverified::ClientMode
    );
    let missing = parse_clients(&exec(&j_line("attached", "1000")), OWN_PID).unwrap();
    let no_uid = parse_clients(&exec(&j_line("attached", "")), OWN_PID).unwrap();
    assert_eq!(
        registered(&no_uid, &w, pane()).unwrap_err(),
        Unverified::Process
    );
    let process = exec("P|10|20|1000|3|/dev/pts/3|S\n");
    let row = registered_with_process(&no_uid, &w, pane(), &process)
        .unwrap()
        .unwrap();
    assert_eq!(row.pid, 10);
    assert!(row.uid.is_none());
    let other = WrapperIdentity {
        pid: 11,
        tty: w.tty.clone(),
        ..w
    };
    assert!(registered(&missing, &other, pane()).unwrap().is_none());
}

/// `list-clients` nennt alle Clients des Servers, auch fremde. tmux 3.6 zeigt
/// das Flag `no-detach-on-destroy` (nur auf ausdrueckliche Anforderung, etwa
/// `attach -f`). Ein fremder Client damit darf die Auswertung nicht kippen;
/// der eigene Wrapper setzt das Flag nie, seine Registrierung bleibt gleich.
#[test]
fn a_foreign_client_with_no_detach_on_destroy_does_not_break_the_listing() {
    let w = WrapperIdentity {
        pid: 10,
        start_ticks: 20,
        uid: 1000,
        tty_nr: 3,
        tty: "/dev/pts/3".into(),
    };
    let process = exec("P|10|20|1000|3|/dev/pts/3|S\n");
    let own = j_line("attached,focused,UTF-8", "1000");
    let foreign = "J|50|1000|11|21|$0|@0|%0|10|1|1|0|0|0|/dev/pts/4|1000|attached,focused,UTF-8,no-detach-on-destroy\n";
    for listing in [format!("{own}{foreign}"), format!("{foreign}{own}")] {
        let rows = parse_clients(&exec(&listing), OWN_PID).unwrap();
        assert_eq!(rows.len(), 1, "only the own row is kept");
        assert_eq!(
            registered(&rows, &w, pane()).unwrap().map(|row| row.pid),
            Some(10)
        );
        assert_eq!(
            registered_with_process(&rows, &w, pane(), &process)
                .unwrap()
                .map(|row| row.pid),
            Some(10)
        );
    }
    // Die gemessene tmux-3.6-Zeile des eigenen Clients bleibt unveraendert.
    let rows = parse_clients(&exec(&j_line("attached,focused,UTF-8", "1000")), OWN_PID).unwrap();
    assert!(registered(&rows, &w, pane()).unwrap().is_some());
}

/// Spec 2026-10-25 §6.2: Auf dem Standard-Socket haengen fremde Clients jeder
/// Art. Keiner davon laesst die Bestaetigung scheitern; die eigene Zeile
/// bleibt streng und darf nur einmal vorkommen.
#[test]
fn foreign_clients_of_any_kind_leave_the_own_row_standing() {
    let own = j_line("attached,focused,UTF-8", "1000");
    let mut foreign = String::new();
    for pid in 100..140 {
        foreign.push_str(&format!(
            "J|50|1000|{pid}|21|$0|@0|%0|10|1|1|0|0|0|/dev/pts/9|1000|attached,focused
"
        ));
    }
    foreign.push_str(
        "J|50|1000|11|21|$0|@0|%0|10|1|1|0|0|0||1000|attached,control-mode,pause-after=5
",
    );
    foreign.push_str(
        "J|50|1000|12|21|$0|@0|%0|10|1|1|0|0|0|/dev/tty1|0|attached,some-future-flag
",
    );
    foreign.push_str(
        "J|50|1000|13|21|$0|@0|%0|10|1|1|0|0|0|/dev/pts/5|extra|1000|attached
",
    );
    let rows = parse_clients(&exec(&format!("{foreign}{own}")), OWN_PID).unwrap();
    assert_eq!(rows.len(), 1);
    let w = WrapperIdentity {
        pid: OWN_PID,
        start_ticks: 20,
        uid: 1000,
        tty_nr: 3,
        tty: "/dev/pts/3".into(),
    };
    assert_eq!(
        registered(&rows, &w, pane()).unwrap().map(|row| row.pid),
        Some(OWN_PID)
    );
    assert!(parse_clients(&exec(&foreign), OWN_PID).unwrap().is_empty());
    assert_eq!(
        parse_clients(&exec(&format!("{own}{own}")), OWN_PID).unwrap_err(),
        Unverified::Frame
    );
    assert_eq!(
        parse_clients(&exec(&own.replace("/dev/pts/3", "/dev/tty1")), OWN_PID).unwrap_err(),
        Unverified::Frame
    );
    assert_eq!(
        parse_clients(
            &exec(&format!(
                "{foreign}
{own}"
            )),
            OWN_PID
        )
        .unwrap_err(),
        Unverified::Frame,
        "the whole frame stays printable ASCII"
    );
}

/// Die Erlaubnisliste wird nur um dieses eine Flag laenger: andere unbekannte
/// Flags und ein doppeltes Flag lassen die ganze Ausgabe weiter scheitern.
#[test]
fn other_unknown_or_repeated_client_flags_still_fail_the_listing() {
    for flags in [
        "attached,no-detach-on-destroy-x",
        "attached,bogus-flag",
        "attached,No-Detach-On-Destroy",
        "attached,no-detach-on-destroy,no-detach-on-destroy",
    ] {
        assert_eq!(
            parse_clients(&exec(&j_line(flags, "1000")), OWN_PID).unwrap_err(),
            Unverified::Frame,
            "{flags}"
        );
    }
}

#[test]
fn conservatively_guarded_socket_probe_is_not_a_version_claim() {
    let selected = pane();
    let named = named_probe("own-socket", selected).unwrap();
    let args = decoded_argv(&named);
    assert_eq!(
        &args[..6],
        ["env", "LC_ALL=C", "tmux", "-u", "-L", "own-socket"]
    );
    assert!(args.contains(&"display-message".into()));
    let response = exec("S|50|1000|$0|/tmp/ab/tmux.sock\n");
    let absolute = absolute_probe(&response, selected).unwrap();
    let abs_args = decoded_argv(&absolute);
    assert_eq!(
        &abs_args[..6],
        ["env", "LC_ALL=C", "tmux", "-u", "-S", "/tmp/ab/tmux.sock"]
    );
}

#[test]
fn socket_binding_requires_matching_named_and_absolute_responses() {
    let selected = pane();
    let named = exec("S|50|1000|$0|/tmp/ab/tmux.sock\n");
    let absolute = exec("S|50|1000|$0|/tmp/ab/tmux.sock\n");
    let binding =
        SocketBinding::from_responses(&named, &absolute, selected, SocketKind::App).unwrap();
    assert_eq!(binding.selected(), selected);
    let _ = binding.query();
    let clients = decoded_argv(&binding.clients_command());
    assert!(clients.contains(&"list-clients".into()));
    assert!(clients.iter().any(|s| s.contains("#{client_flags}")));
    let attach = decoded_argv(&binding.attach_command(NONCE).unwrap());
    assert_eq!(attach[0], "sh");
    assert!(attach.contains(&NONCE.into()));
    let tmux = decoded_argv(attach.last().unwrap());
    assert_eq!(
        &tmux[..6],
        ["env", "LC_ALL=C", "tmux", "-u", "-S", "/tmp/ab/tmux.sock"]
    );
    assert_eq!(&tmux[6..11], crate::tmux::HIDE_STATUS);
    assert_eq!(tmux[11], "if-shell");
    let changed = exec("S|50|1000|$0|/tmp/ab/other.sock\n");
    assert_eq!(
        match SocketBinding::from_responses(&named, &changed, selected, SocketKind::App) {
            Err(error) => error,
            Ok(_) => panic!("mismatched sockets must not bind"),
        },
        Unverified::Changed
    );
}

/// Auf dem Standard-Socket haengt die Bindung mit `-E` an und laesst die
/// Statuszeile des Nutzers stehen (Spec 2026-10-25 §6.4).
#[test]
fn a_binding_on_the_default_socket_attaches_with_e_and_keeps_the_status_line() {
    let selected = pane();
    let named = exec("S|50|1000|$0|/tmp/ab/tmux.sock\n");
    let binding =
        SocketBinding::from_responses(&named, &named, selected, SocketKind::Default).unwrap();
    let attach = decoded_argv(&binding.attach_command(NONCE).unwrap());
    let tmux = decoded_argv(attach.last().unwrap());
    assert_eq!(
        &tmux[..6],
        ["env", "LC_ALL=C", "tmux", "-u", "-S", "/tmp/ab/tmux.sock"]
    );
    assert_eq!(tmux[6], "if-shell");
    assert!(!tmux.iter().any(|a| a == "status"));
    assert_eq!(
        tmux[tmux.len() - 2],
        format!("attach-session -E -t '${}'", selected.session_id.0)
    );
}

#[test]
fn process_probe_rejects_zombie_and_identity_drift() {
    let w = WrapperIdentity {
        pid: 10,
        start_ticks: 20,
        uid: 1000,
        tty_nr: 3,
        tty: "/dev/pts/3".into(),
    };
    let command = decoded_argv(&process_command(&w));
    assert_eq!(command[4], "10");
    verify_process(&exec("P|10|20|1000|3|/dev/pts/3|S\n"), &w).unwrap();
    assert_eq!(
        verify_process(&exec("P|10|20|1000|3|/dev/pts/3|Z\n"), &w).unwrap_err(),
        Unverified::Process
    );
    assert_eq!(
        verify_process(&exec("P|11|20|1000|3|/dev/pts/3|S\n"), &w).unwrap_err(),
        Unverified::Process
    );
}
