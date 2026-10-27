// Crate-Name `aidevbridge_lib` statt `aidevbridge` (siehe common/mod.rs).
use aidevbridge_lib::ssh::AuthError;
use aidevbridge_lib::ssh::AuthMethod;
use aidevbridge_lib::transport::{RusshTransport, Transport};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
mod common;

#[tokio::test]
async fn exec_returns_stdout_and_exit_code() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let r = t.exec("echo hallo; exit 0").await.unwrap();
    assert_eq!(r.stdout.trim(), "hallo");
    assert_eq!(r.code, 0);
    t.dispose().await;
}

#[tokio::test]
async fn nonzero_exit_is_reported_not_swallowed() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let r = t.exec("echo fehler >&2; exit 3").await.unwrap();
    assert_eq!(r.code, 3, "Exit-Code darf nicht verschluckt werden");
    assert!(
        r.stderr.contains("fehler"),
        "stderr muss durchgereicht werden"
    );
    t.dispose().await;
}

#[tokio::test]
async fn rejected_host_key_fails_the_connection() {
    let Some(s) = common::spec() else {
        return;
    };
    let res =
        RusshTransport::connect(&s, Arc::new(common::RejectAll), &common::key_auth_method()).await;
    assert!(
        res.is_err(),
        "Verbindung darf bei abgelehntem Host-Key NICHT zustande kommen (Spec §8.1)"
    );
}

/// Verschaerfte Fassung des Tests oben: `assert!(res.is_err())` allein wird
/// von JEDEM Verbindungsfehler erfuellt, nicht nur von einer echten
/// Policy-Ablehnung -- ein unerreichbarer Host oder ein fehlender Schluessel
/// waeren ebenso `Err` und wuerden den Test unbemerkt gruen halten, selbst
/// wenn `check_server_key` die Policy nie befragt (z. B. faelschlich fest
/// verdrahtetes `Ok(true)`). Dieser Test belegt zusaetzlich, dass die
/// Ablehnung tatsaechlich aus der Policy-Konsultation stammt.
#[tokio::test]
async fn rejected_host_key_is_actually_consulted_before_failing() {
    let Some(s) = common::spec() else {
        return;
    };
    let called = Arc::new(AtomicBool::new(false));
    let res = RusshTransport::connect(
        &s,
        Arc::new(common::RecordingReject(called.clone())),
        &common::key_auth_method(),
    )
    .await;
    assert!(
        called.load(Ordering::SeqCst),
        "check_server_key hat die Policy nie befragt -- ein Fehlschlag aus \
         anderem Grund waere sonst nicht von einer echten Ablehnung zu \
         unterscheiden (Spec §8.1)"
    );
    assert!(
        res.is_err(),
        "Verbindung darf bei abgelehntem Host-Key NICHT zustande kommen (Spec §8.1)"
    );
}

/// Nach erfolgreichem `ch.exec()` muss `ch.eof()` folgen. Ein Kommando, das
/// von stdin liest (`cat`), blockierte sonst unbegrenzt -- der Server sendet
/// dafuer weder `Eof` noch `ExitStatus` noch `Close`, das Keepalive sieht das
/// nicht, und `ch.wait()` liefert nie `None`. Der `timeout` stellt sicher,
/// dass DIESER Test bei einem Ruecksturz des Fixes nicht selbst unbegrenzt
/// haengt, sondern kontrolliert rot wird.
#[tokio::test]
async fn exec_sends_eof_so_stdin_reading_commands_do_not_hang() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let outcome = tokio::time::timeout(Duration::from_secs(10), t.exec("cat; exit 7")).await;
    let r = outcome
        .expect("exec() ist haengengeblieben -- fehlt `ch.eof()` nach `ch.exec()`?")
        .unwrap();
    assert_eq!(r.code, 7, "cat muss durch EOF sofort beendet werden");
    t.dispose().await;
}

/// Ein per Signal getoeteter Remote-Prozess sendet laut RFC 4254 KEIN
/// `ExitStatus`, sondern `ChannelMsg::ExitSignal` -- ohne diesen Arm in der
/// `exec()`-Schleife bliebe `code` auf 0 stehen, was als Erfolg gilt. Gegen
/// die echte VM verifiziert (per temporaerem Debug-Log): `sh -c 'kill -TERM
/// $$'` liefert `ExitSignal { signal_name: TERM, .. }` und GAR KEIN
/// `ExitStatus`. Erwartet wird die POSIX-Konvention `128 + Signalnummer` (TERM
/// = 15 unter Linux), dieselbe, die `$?` in bash nach einem signalbedingten
/// Tod zeigt.
///
/// Warum das mehr als Kosmetik ist: `TmuxClient::create_session` entscheidet
/// ausschliesslich an `r.code == 0` auf `CreateOutcome::Created` -- ein per
/// Signal getoetetes `new-session` meldete sonst faelschlich "erstellt",
/// obwohl keine Session existiert.
#[tokio::test]
async fn exec_reports_a_nonzero_code_when_the_remote_process_dies_by_signal() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let r = t.exec("sh -c 'kill -TERM $$'").await.unwrap();
    assert_eq!(
        r.code, 143,
        "SIGTERM-Tod muss als 128+15=143 gemeldet werden, nicht als Erfolg (0)"
    );
    t.dispose().await;
}

/// Belegt, dass die praezise `AuthError`-Variante ueber die
/// `anyhow`-Fehlergrenze von `RusshTransport::connect` hinweg erhalten
/// bleibt (siehe Kommentar an `connect()`, warum die Funktion bei
/// `anyhow::Result` bleibt statt auf `Result<Self, AuthError>`
/// umzustellen).
#[tokio::test]
async fn key_auth_error_survives_the_anyhow_boundary() {
    let Some(mut s) = common::spec() else {
        return;
    };
    s.user = "irrelevant-fuer-diesen-test".into();
    let bad_method = AuthMethod::Key {
        path: std::path::PathBuf::from("/nonexistent/path/id_ed25519"),
        passphrase: None,
    };
    // `RusshTransport` implementiert kein `Debug` (der Handle-Typ aus russh
    // tut das nicht), deshalb kein `.expect_err(...)` -- das wuerde `T: Debug`
    // fuer den (hier nie eintretenden) Ok-Fall verlangen.
    let err = match RusshTransport::connect(&s, Arc::new(common::AcceptAll), &bad_method).await {
        Ok(_) => panic!("nicht vorhandener Schluesselpfad muss fehlschlagen"),
        Err(e) => e,
    };
    let auth_err = err
        .downcast_ref::<AuthError>()
        .unwrap_or_else(|| panic!("kein AuthError in der Fehlerkette: {err:#}"));
    assert!(
        matches!(auth_err, AuthError::KeyUnreadable(_)),
        "erwartet KeyUnreadable, war {auth_err:?}"
    );
}

/// Mit `hash_alg = None` ginge jeder RSA-Schluessel als `ssh-rsa`/SHA-1 raus
/// -- das lehnt OpenSSH ab 8.8 ab (die Testvorlage 192.0.2.20 laeuft OpenSSH
/// 9.6). Ohne `choose_rsa_hash` im Auth-Weg ist dieser Test rot: die
/// Verbindung scheitert mit einer Auth-Ablehnung. Siehe `tests/common::
/// rsa_key_path` fuer die Einrichtung des Testschluessels.
#[tokio::test]
async fn rsa_key_authenticates_against_openssh_8_8_or_newer() {
    let Some(spec) = common::spec() else {
        return;
    };
    let Some(path) = common::rsa_key_path() else {
        eprintln!("SKIP: AIDEVBRIDGE_TEST_RSA_KEY nicht gesetzt");
        return;
    };
    let method = AuthMethod::Key {
        path,
        passphrase: None,
    };
    let t = RusshTransport::connect(&spec, Arc::new(common::AcceptAll), &method).await;
    assert!(
        t.is_ok(),
        "RSA-Schluessel muss mit SHA-2 signiert werden: {:?}",
        t.err()
    );
}
