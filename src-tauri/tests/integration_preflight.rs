// Crate-Name `aidevbridge_lib` statt `aidevbridge` (siehe common/mod.rs).
use aidevbridge_lib::preflight;
use aidevbridge_lib::transport::Transport;
mod common;

/// Belegt `run()` gegen die echte Test-VM (siehe `common::spec()`): dort
/// laeuft tmux 3.3a, base64 ist vorhanden, `/tmp` ist beschreibbar -- alle
/// drei abbrechenden Voraussetzungen aus Spec §6.9 muessen erfuellt sein.
/// Ohne `AIDEVBRIDGE_TEST_HOST` wird der Test uebersprungen, statt rot zu
/// werden -- sonst waere die CI ohne VM dauerhaft rot (Muster aus
/// `tests/integration_transport.rs` uebernommen).
#[tokio::test]
async fn run_finds_all_three_blocking_requirements_satisfied_on_the_real_vm() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let report = preflight::run(&t).await.unwrap();
    assert!(
        report.tmux_version.is_some(),
        "tmux -V lieferte keine Version: {report:?}"
    );
    assert!(report.has_base64, "base64 fehlt auf dem Testhost");
    assert!(
        report.socket_dir_writable,
        "Socket-Verzeichnis (${{TMUX_TMPDIR:-${{TMPDIR:-/tmp}}}}) ist nicht beschreibbar"
    );
    assert!(
        report.blocking_problem().is_none(),
        "blockierendes Problem trotz erfuellter Voraussetzungen: {:?}",
        report.blocking_problem()
    );
    t.dispose().await;
}
