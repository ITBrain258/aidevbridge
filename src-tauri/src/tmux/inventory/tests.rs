use super::*;
use crate::remote::command::decoded_argv;
use serde_json::Value;
use sha2::{Digest, Sha256};

const ONE: &str = "B|100|1000\nQ|$0|1\nP|$0|@0|%0|10|1|1|0|0|0|1|0|1\nE|100|1000\n";

fn output(code: u32, stdout: &str, stderr: &str) -> ExecResult {
    ExecResult {
        utf8_valid: true,
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
}

fn query() -> InventoryQuery {
    InventoryQuery::absolute(MeasuredVersion::V3_4, "/tmp/own/socket").unwrap()
}

fn incomplete(text: &str) {
    assert!(
        matches!(
            query().classify(&output(0, text, "")),
            InventoryOutcome::Incomplete(_)
        ),
        "{text:?}"
    );
}

#[test]
fn accepted_measurements_and_query_arguments_remain_exact() {
    for (text, source) in [
        (
            include_str!("../../../tests/fixtures/tmux-inventory/tmux-3.0.json"),
            include_str!("../../../tests/fixtures/tmux-inventory/2026-09-12-tmux-3.0.jsonl"),
        ),
        (
            include_str!("../../../tests/fixtures/tmux-inventory/tmux-3.4.json"),
            include_str!("../../../tests/fixtures/tmux-inventory/2026-09-12-tmux-3.4.jsonl"),
        ),
        (
            include_str!("../../../tests/fixtures/tmux-inventory/tmux-3.6.json"),
            include_str!("../../../tests/fixtures/tmux-inventory/2026-10-11-tmux-3.6.jsonl"),
        ),
    ] {
        let golden: Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(source.as_bytes())),
            golden["source_sha256"]
        );
        let report = source
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find(|v| v["kind"] == "inventory_measurement")
            .unwrap();
        let version = MeasuredVersion::from_response(&output(
            0,
            golden["version_output"].as_str().unwrap(),
            "",
        ))
        .unwrap();
        let query = InventoryQuery::absolute(version, golden["socket"].as_str().unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(decoded_argv(&query.command())).unwrap(),
            golden["query_argv"]
        );
        assert_eq!(golden["cases"].as_array().unwrap().len(), 28);
        for case in golden["cases"].as_array().unwrap() {
            let original = report["commands"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == case["name"])
                .unwrap();
            for key in ["stdout", "stderr"] {
                assert_eq!(case[key], original[key]);
            }
            assert_eq!(case["code"], original["exit_code"]);
            let result = query.classify(&output(
                case["code"].as_u64().unwrap() as u32,
                case["stdout"].as_str().unwrap(),
                case["stderr"].as_str().unwrap(),
            ));
            match case["expected"]["class"].as_str().unwrap() {
                "NoServer" => assert_eq!(result, InventoryOutcome::NoServer),
                "TmuxError" => assert!(matches!(result, InventoryOutcome::TmuxError { .. })),
                "Snapshot" => {
                    assert_eq!(case["expected"], original["classification"]);
                    let InventoryOutcome::Snapshot(s) = result else {
                        panic!("{}: {result:?}", case["name"])
                    };
                    let expected = &case["expected"];
                    assert_eq!(s.server.pid as u64, expected["server"][0].as_u64().unwrap());
                    assert_eq!(s.server.start_time, expected["server"][1].as_u64().unwrap());
                    assert_eq!(
                        s.sessions.len(),
                        expected["sessions"].as_object().unwrap().len()
                    );
                    for session in &s.sessions {
                        assert_eq!(
                            session.window_count as u64,
                            expected["sessions"][format!("${}", session.id.0)]
                                .as_u64()
                                .unwrap()
                        );
                    }
                    assert_eq!(s.panes.len(), expected["panes"].as_array().unwrap().len());
                    for (pane, fields) in s.panes.iter().zip(expected["panes"].as_array().unwrap())
                    {
                        let actual = vec![
                            format!("${}", pane.session_id.0),
                            format!("@{}", pane.window_id.0),
                            format!("%{}", pane.pane_id.0),
                            pane.pane_pid.to_string(),
                            u8::from(pane.window_active).to_string(),
                            u8::from(pane.pane_active).to_string(),
                            u8::from(pane.pane_dead).to_string(),
                            u8::from(pane.alternate_on).to_string(),
                            pane.session_attached.to_string(),
                            pane.window_activity.to_string(),
                            u8::from(pane.window_bell).to_string(),
                            pane.window_panes.to_string(),
                        ];
                        assert_eq!(serde_json::to_value(actual).unwrap(), *fields);
                    }
                }
                other => panic!("unexpected historical classification {other}"),
            }
        }
    }
}

#[test]
fn version_selection_rejects_unmeasured_or_incomplete_responses() {
    for text in [
        "tmux 3.0a\n",
        "tmux 3.4-next\n",
        "tmux 3.3\n",
        "tmux 3.4",
        "tmux 3.4\r\n",
        "tmux 3.4\nextra\n",
        // Nur die gemessene Ausgabe `tmux 3.6\n` (Ubuntu-Paket 3.6a-2ubuntu0.1)
        // gilt. Das unveraendert gebaute Upstream-Release meldet `3.6a`, 3.5 und
        // 3.5a sind nicht gemessen, und `\r\n` ist eine andere Antwort.
        "tmux 3.6a\n",
        "tmux 3.5a\n",
        "tmux 3.5\n",
        "tmux 3.6\r\n",
        "tmux 3.6",
        "tmux 3.6\nextra\n",
        "tmux 3.60\n",
        "tmux 3.6-next\n",
        "tmux 3.6 \n",
        "tmux  3.6\n",
        " tmux 3.6\n",
        "tmux 3.6\n\n",
    ] {
        assert_eq!(MeasuredVersion::from_response(&output(0, text, "")), None);
    }
    for version in ["tmux 3.4\n", "tmux 3.6\n"] {
        assert_eq!(
            MeasuredVersion::from_response(&output(1, version, "")),
            None
        );
        assert_eq!(
            MeasuredVersion::from_response(&output(0, version, "warning\n")),
            None
        );
    }
}

#[test]
fn v3_3a_is_a_measured_direct_display_version_not_an_alias_of_3_4() {
    assert_eq!(
        MeasuredVersion::from_response(&output(0, "tmux 3.3a\n", "")),
        Some(MeasuredVersion::V3_3A)
    );
    assert_ne!(MeasuredVersion::V3_3A, MeasuredVersion::V3_4);
    assert_eq!(
        decoded_argv(
            &InventoryQuery::named(MeasuredVersion::V3_3A, "own-socket")
                .unwrap()
                .command()
        ),
        decoded_argv(
            &InventoryQuery::named(MeasuredVersion::V3_4, "own-socket")
                .unwrap()
                .command()
        )
    );
    let args = decoded_argv(
        &InventoryQuery::named(MeasuredVersion::V3_3A, "own-socket")
            .unwrap()
            .command(),
    );
    assert!(args.iter().any(|s| s == "display-message"));
    assert!(!args.iter().any(|s| s == "list-commands"));
    let query =
        InventoryQuery::absolute(MeasuredVersion::V3_3A, "/tmp/ab-inv33a-nosuch-4e82").unwrap();
    assert_eq!(
        query.classify(&output(
            1,
            "",
            "error connecting to /tmp/ab-inv33a-nosuch-4e82 (No such file or directory)\n",
        )),
        InventoryOutcome::NoServer
    );
    let InventoryOutcome::Snapshot(snapshot) = InventoryQuery::named(MeasuredVersion::V3_3A, "own")
        .unwrap()
        .classify(&output(
            0,
            "B|11096|1789296086\nQ|$0|1\nP|$0|@0|%0|11097|1|1|0|0|0|1789296086|0|1\nE|11096|1789296086\n",
            "",
        ))
    else {
        panic!("measured 3.3a B/E/Q/P must classify as a snapshot");
    };
    assert_eq!(snapshot.server.pid, 11096);
    assert_eq!(snapshot.sessions.len(), 1);
    assert_eq!(snapshot.panes[0].pane_pid, 11097);
}

/// Gemessen am 2026-10-11 auf Ubuntu 26.04.1 (Paket 3.6a-2ubuntu0.1, meldet
/// `tmux 3.6\n`): Befehl, Klassen und Abwesenheitsdiagnosen wie unter 3.4.
#[test]
fn v3_6_is_a_measured_direct_display_version_not_an_alias_of_3_4() {
    assert_eq!(
        MeasuredVersion::from_response(&output(0, "tmux 3.6\n", "")),
        Some(MeasuredVersion::V3_6)
    );
    assert_ne!(MeasuredVersion::V3_6, MeasuredVersion::V3_4);
    assert_ne!(MeasuredVersion::V3_6, MeasuredVersion::V3_3A);
    assert_ne!(MeasuredVersion::V3_6, MeasuredVersion::V3_0);
    assert_eq!(
        decoded_argv(
            &InventoryQuery::named(MeasuredVersion::V3_6, "own-socket")
                .unwrap()
                .command()
        ),
        decoded_argv(
            &InventoryQuery::named(MeasuredVersion::V3_4, "own-socket")
                .unwrap()
                .command()
        )
    );
    assert_eq!(
        decoded_argv(
            &InventoryQuery::absolute(MeasuredVersion::V3_6, "/tmp/tmux-1000/abtest_ux36_5")
                .unwrap()
                .command()
        ),
        decoded_argv(
            &InventoryQuery::absolute(MeasuredVersion::V3_4, "/tmp/tmux-1000/abtest_ux36_5")
                .unwrap()
                .command()
        )
    );
    let args = decoded_argv(
        &InventoryQuery::named(MeasuredVersion::V3_6, "own-socket")
            .unwrap()
            .command(),
    );
    assert!(args.iter().any(|s| s == "display-message"));
    assert!(!args.iter().any(|s| s == "list-commands"));
    // Beide gemessenen Abwesenheitsdiagnosen fuer den eigenen Socket.
    let query =
        InventoryQuery::absolute(MeasuredVersion::V3_6, "/tmp/tmux-1000/abtest_ux36_5").unwrap();
    for message in [
        "error connecting to /tmp/tmux-1000/abtest_ux36_5 (No such file or directory)\n",
        "no server running on /tmp/tmux-1000/abtest_ux36_5\n",
    ] {
        assert_eq!(
            query.classify(&output(1, "", message)),
            InventoryOutcome::NoServer,
            "{message:?}"
        );
    }
    // Gemessener Snapshot (`first_named` der 3.6-Matrix).
    let InventoryOutcome::Snapshot(snapshot) = query.classify(&output(
        0,
        "B|684702|1791713377\nQ|$0|1\nP|$0|@0|%0|684709|1|1|0|0|0|1791713377|0|1\nE|684702|1791713377\n",
        "",
    )) else {
        panic!("measured 3.6 B/E/Q/P must classify as a snapshot");
    };
    assert_eq!(snapshot.server.pid, 684702);
    assert_eq!(snapshot.server.start_time, 1791713377);
    assert_eq!(snapshot.sessions.len(), 1);
    assert_eq!(snapshot.panes[0].pane_pid, 684709);
    // Gemessen: ein Teilfehler bleibt ein Fehler, kein leerer Snapshot.
    assert!(matches!(
        query.classify(&output(
            1,
            "B|684702|1791713377\n",
            "can't find pane: %999999999\n"
        )),
        InventoryOutcome::TmuxError { .. }
    ));
}

#[test]
fn conservatively_guarded_envelope_matches_v3_0_style_without_claiming_that_version() {
    let named = InventoryQuery::conservatively_guarded_named("own-socket").unwrap();
    let absolute = InventoryQuery::conservatively_guarded_absolute("/tmp/own/socket").unwrap();
    assert_eq!(
        decoded_argv(&named.command()),
        decoded_argv(
            &InventoryQuery::named(MeasuredVersion::V3_0, "own-socket")
                .unwrap()
                .command()
        )
    );
    assert_eq!(
        decoded_argv(&absolute.command()),
        decoded_argv(
            &InventoryQuery::absolute(MeasuredVersion::V3_0, "/tmp/own/socket")
                .unwrap()
                .command()
        )
    );
    assert!(decoded_argv(&named.command())
        .iter()
        .any(|s| s.starts_with("list-commands")));
    assert!(
        !format!("{named:?}").contains("V3_0"),
        "guarded envelope must not debug as a measured 3.0 host"
    );
}

#[test]
fn socket_is_one_quoted_argument_and_not_nested_tmux_syntax() {
    let socket = "/tmp/é'; $(false); #{pid}/socket";
    for version in [
        MeasuredVersion::V3_0,
        MeasuredVersion::V3_3A,
        MeasuredVersion::V3_4,
        MeasuredVersion::V3_6,
    ] {
        let args = decoded_argv(&InventoryQuery::absolute(version, socket).unwrap().command());
        assert_eq!(&args[..6], ["env", "LC_ALL=C", "tmux", "-u", "-S", socket]);
        assert!(!args[6..].iter().any(|s| s.contains(socket)));
        assert!(!args.iter().any(|s| matches!(
            s.as_str(),
            "list-commands" | "start-server" | "new-session" | "-f"
        )));
    }
    let args = decoded_argv(
        &InventoryQuery::named(MeasuredVersion::V3_4, "ab; ' socket")
            .unwrap()
            .command(),
    );
    assert_eq!(&args[4..6], ["-L", "ab; ' socket"]);
}

#[test]
fn invalid_addresses_fail_before_remote_builder_assertions() {
    for name in ["", ".", "..", "a/b", "a\0b", "a\nb", "a\u{7f}b"] {
        assert!(InventoryQuery::named(MeasuredVersion::V3_0, name).is_err());
    }
    for path in [
        "", "/", "relative", "//a", "/a/", "/a/../b", "/a/./b", "/a\nb", "/a\0b",
    ] {
        assert!(InventoryQuery::absolute(MeasuredVersion::V3_4, path).is_err());
    }
    assert!(InventoryQuery::named(MeasuredVersion::V3_4, &"a".repeat(4097)).is_err());
}

#[test]
fn no_server_requires_exact_path_exit_and_diagnosis() {
    for message in [
        "no server running on /tmp/own/socket\n",
        "error connecting to /tmp/own/socket (No such file or directory)\n",
    ] {
        assert_eq!(
            query().classify(&output(1, "", message)),
            InventoryOutcome::NoServer
        );
        for code in [0, 2, 127] {
            assert!(matches!(
                query().classify(&output(code, "", message)),
                InventoryOutcome::TmuxError { .. }
            ));
        }
        assert!(matches!(
            query().classify(&output(1, ONE, message)),
            InventoryOutcome::TmuxError { .. }
        ));
        let named = InventoryQuery::named(MeasuredVersion::V3_4, "socket").unwrap();
        assert!(matches!(
            named.classify(&output(1, "", message)),
            InventoryOutcome::TmuxError { .. }
        ));
    }
    for message in [
        "no server running on /tmp/other/socket\n",
        "no server running on /tmp/own/socket\r\n",
        "no server running on /tmp/own/socket\n\n",
        "no server running on /tmp/own/socket",
        "Kein Server auf /tmp/own/socket\n",
        "No such file or directory\n",
        "error connecting to /tmp/own/socket (Permission denied)\n",
        "no current target\n",
        "",
    ] {
        assert!(matches!(
            query().classify(&output(1, "", message)),
            InventoryOutcome::TmuxError { .. }
        ));
    }
}

#[test]
fn diagnostics_do_not_turn_into_empty_snapshots() {
    for result in [
        output(127, "", "tmux: not found\n"),
        output(1, "B|100|1000\n", "missing pane\n"),
        output(0, ONE, "unexpected warning\n"),
    ] {
        assert!(matches!(
            query().classify(&result),
            InventoryOutcome::TmuxError { .. }
        ));
    }
}

#[test]
fn numeric_frame_rejects_partial_injected_and_control_data() {
    for data in [
        "".into(),
        "B|100|1000\n".into(),
        ONE.trim_end().into(),
        ONE.replace("E|100", "E|101"),
        ONE.replace("E|", "free title\nE|"),
        ONE.replace("@0", "@ä"),
        ONE.replace("@0", "@\u{fffd}"),
        ONE.replace("@0", "@0\t"),
        ONE.replace("@0", "@0\0"),
        ONE.replace("@0", "@0\u{7f}"),
        ONE.replace('\n', "\r\n"),
        format!("{ONE}\n"),
        format!("{ONE}{ONE}"),
    ] {
        incomplete(&data);
    }
}

#[test]
fn integers_and_ids_are_canonical_and_bounded() {
    for text in [
        ONE.replace("B|100", "B|0"),
        ONE.replace("|1000", "|0"),
        ONE.replace("|1000", "|18446744073709551616"),
        ONE.replace("$0", "$00"),
        ONE.replace("@0", "@-1"),
        ONE.replace("%0", "%+1"),
        ONE.replace("%0", "%4294967296"),
        ONE.replace("|10|", "|4294967296|"),
        ONE.replace("|10|", "|0|"),
        ONE.replace("|10|", "|01|"),
        ONE.replace("Q|$0|1", "Q|$0|0"),
        ONE.replace("Q|$0|1", "Q|$0|4294967296"),
        ONE.replace("|1|1|0|0|", "|2|1|0|0|"),
    ] {
        incomplete(&text);
    }
}

#[test]
fn size_limit_precedes_success_or_absence() {
    assert_eq!(
        query().classify(&output(0, &"B".repeat(MAX_INVENTORY_BYTES + 1), "")),
        InventoryOutcome::Incomplete(IncompleteReason::OutputLimit)
    );
    assert_eq!(
        query().classify(&output(1, "", &"x".repeat(MAX_INVENTORY_BYTES + 1))),
        InventoryOutcome::Incomplete(IncompleteReason::OutputLimit)
    );
}

#[test]
fn missing_duplicate_or_late_inventory_cannot_prove_absence() {
    let pane = "P|$0|@0|%0|10|1|1|0|0|0|1|0|1\n";
    for data in [
        ONE.replace(pane, ""),
        ONE.replace("Q|$0|1\n", ""),
        ONE.replace("Q|$0|1\n", "Q|$0|1\nQ|$0|1\n"),
        ONE.replace("E|", &format!("{pane}E|")),
        ONE.replace("E|", "Q|$1|1\nE|"),
        ONE.replace("Q|$0|1", "Q|$0|2"),
        ONE.replace("P|$0", "P|$1"),
    ] {
        incomplete(&data);
    }
}

fn two_panes() -> String {
    "B|100|1000\nQ|$0|1\nP|$0|@0|%0|10|1|1|0|0|2|5|0|2\nP|$0|@0|%1|11|1|0|0|0|2|5|0|2\nE|100|1000\n"
        .into()
}

#[test]
fn active_selection_and_shared_fields_must_be_consistent() {
    let data = two_panes();
    let InventoryOutcome::Snapshot(s) = query().classify(&output(0, &data, "")) else {
        panic!()
    };
    assert_eq!(s.panes.len(), 2);
    for text in [
        data.replace("11|1|0", "11|1|1"),
        data.replace("10|1|1", "10|1|0"),
        data.replace("11|1|0", "11|0|0"),
        data.replace("11|1|0|0|0|2|5|0|2", "11|1|0|0|0|3|5|0|2"),
        data.replace("11|1|0|0|0|2|5|0|2", "11|1|0|0|0|2|6|0|2"),
        data.replace("11|1|0|0|0|2|5|0|2", "11|1|0|0|0|2|5|1|2"),
        data.replace("11|1|0|0|0|2|5|0|2", "11|1|0|0|0|2|5|0|3"),
    ] {
        incomplete(&text);
    }
}

#[test]
fn linked_windows_are_explicitly_unsupported_not_absent() {
    let data = "B|100|1000\nQ|$0|1\nQ|$1|1\nP|$0|@0|%0|10|1|1|0|0|0|1|0|1\nP|$1|@0|%0|10|1|1|0|0|0|1|0|1\nE|100|1000\n";
    assert_eq!(
        query().classify(&output(0, data, "")),
        InventoryOutcome::Incomplete(IncompleteReason::UnsupportedLinkedWindows)
    );
}

/// Spec 2026-10-25 §6.2: Auf dem Standard-Socket fallen nur die Sessions
/// einer Gruppe heraus; die uebrigen bleiben ein vollstaendiges Inventar. Die
/// verworfenen Zeilen werden trotzdem geprueft, und der Befehl bleibt gleich.
#[test]
fn a_tolerant_query_drops_only_the_sessions_that_share_windows() {
    let data = "B|100|1000
Q|$0|1
Q|$1|1
Q|$2|1
P|$0|@0|%0|10|1|1|0|0|0|1|0|1
P|$1|@0|%0|10|1|1|0|0|0|1|0|1
P|$2|@1|%1|11|1|1|0|0|1|2|0|1
E|100|1000
";
    let tolerant = query().tolerating_linked_windows();
    assert_eq!(tolerant.command(), query().command());
    let InventoryOutcome::Snapshot(s) = tolerant.classify(&output(0, data, "")) else {
        panic!()
    };
    assert_eq!(s.linked, [SessionId(0), SessionId(1)]);
    assert_eq!(
        s.sessions.iter().map(|s| s.id).collect::<Vec<_>>(),
        [SessionId(2)]
    );
    assert_eq!(s.panes.len(), 1);
    assert_eq!(s.panes[0].session_id, SessionId(2));
    assert_eq!(
        tolerant.classify(&output(
            0,
            &data.replace("P|$1|@0|%0|10|", "P|$1|@0|%0|010|"),
            ""
        )),
        InventoryOutcome::Incomplete(IncompleteReason::InvalidNumber)
    );
    let InventoryOutcome::Snapshot(plain) = tolerant.classify(&output(0, ONE, "")) else {
        panic!()
    };
    assert!(plain.linked.is_empty());
}

#[test]
fn multiple_sessions_windows_and_dead_panes_are_numeric_evidence_only() {
    let data = "B|100|1000\nQ|$0|2\nQ|$1|1\nP|$0|@0|%0|10|1|1|1|0|2|1|1|1\nP|$0|@1|%1|11|0|1|0|1|2|4|0|1\nP|$1|@2|%2|12|1|1|0|0|0|6|0|1\nE|100|1000\n";
    let InventoryOutcome::Snapshot(s) = query().classify(&output(0, data, "")) else {
        panic!()
    };
    assert_eq!(s.sessions.len(), 2);
    assert_eq!(s.panes.len(), 3);
    assert!(s.panes[0].pane_dead && s.panes[0].window_bell);
    incomplete(&data.replace("11|0|1", "11|1|1"));
    incomplete(&data.replace("11|0|1|0|1|2", "11|0|1|0|1|3"));
}
