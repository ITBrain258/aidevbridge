mod common;

#[test]
fn absent_host_is_a_skip_and_needs_no_socket() {
    assert_eq!(common::validate_live_test_host(None, None), Ok(None));
}

#[test]
fn configured_host_without_isolated_socket_is_rejected_before_a_spec_is_returned() {
    for socket in [
        None,
        Some(""),
        Some("   "),
        Some("agentbridge"),
        Some("AGENTBRIDGE"),
        Some("default"),
        Some("Default"),
    ] {
        assert!(
            common::validate_live_test_host(Some("vm.example.test"), socket).is_err(),
            "ein gesetzter Host darf mit Socket {socket:?} keinen Verbindungspfad erreichen"
        );
    }
}

#[test]
fn socket_paths_and_ambiguous_names_are_rejected() {
    for socket in [
        "/tmp/tmux-1000/agentbridge",
        "../agentbridge",
        "dir\\agentbridge",
        "abtest run",
        "abtest\nrun",
        "abtest;other",
        " abtest",
        "abtest ",
        "abtest_ä",
        &"x".repeat(49),
    ] {
        assert!(
            common::validate_test_socket(Some(socket)).is_err(),
            "{socket:?}"
        );
    }
}

#[test]
fn explicit_socket_and_host_are_preserved_without_silent_normalization() {
    for socket in ["abtest", "abtest_20260911_run-1", &"x".repeat(48)] {
        assert_eq!(common::validate_test_socket(Some(socket)), Ok(socket));
        assert_eq!(
            common::validate_live_test_host(Some("vm.example.test"), Some(socket)),
            Ok(Some("vm.example.test"))
        );
    }
}

#[test]
fn explicitly_empty_host_is_an_error_not_a_successful_skip() {
    for host in ["", " ", "\t"] {
        assert!(common::validate_live_test_host(Some(host), Some("abtest_run")).is_err());
    }
}

#[test]
fn live_test_user_has_no_built_in_default() {
    assert!(common::validate_live_test_user(None).is_err());
    for user in ["", " ", "\t"] {
        assert!(
            common::validate_live_test_user(Some(user)).is_err(),
            "ein leerer Benutzer {user:?} darf nicht als Testkonto gelten"
        );
    }
    assert_eq!(common::validate_live_test_user(Some("u")), Ok("u"));
}

#[test]
fn test_host_key_comes_only_from_the_environment() {
    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAD1+Ea/eX8XGszB1Ee5udPD85hQSr6XBZCh4YIzFLng";
    assert!(common::validate_test_host_key(None).is_err());
    for key in [
        "",
        " ",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5",
        "AAAAC3NzaC1lZDI1NTE5 kommentar",
        "AAAAC3NzaC1lZDI1NTE5\n",
    ] {
        assert!(
            common::validate_test_host_key(Some(key)).is_err(),
            "nur der base64-Teil ohne Typ, Kommentar oder Leerraum gilt: {key:?}"
        );
    }
    assert_eq!(common::validate_test_host_key(Some(KEY)), Ok(KEY));
}
