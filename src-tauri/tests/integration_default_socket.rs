// Spec 2026-10-25 §8: Sessions des Standard-Sockets, gegen einen Testsocket
// anstelle von `default`. Den "fremden" Server legt der Test selbst an, wie
// ein Nutzer es taete, und vergleicht Optionen, Hooks und Umgebung vorher und
// nachher. Den echten Standard-Socket beruehrt kein Test: Die Regeln haengen
// an der Art des Sockets, nicht an seinem Namen.
use aidevbridge_lib::commands::{
    ack_output_tagged_impl, close_terminal_tagged_impl, connect_host_with_known_hosts,
    disconnect_host_impl, kill_session_impl, list_sockets_impl, open_terminal_tagged_impl,
    poll_sockets_impl, send_input_tagged_impl, AppState, HostSpecDto, OutputSink,
    SessionListItemDto, FOREIGN_SESSION, FOREIGN_UNBOUND,
};
use aidevbridge_lib::remote;
use aidevbridge_lib::tmux::inventory::{PaneId, ServerIdentity, SessionId, WindowId};
use aidevbridge_lib::tmux::session_binding::PaneIdentity;
use aidevbridge_lib::tmux::SocketKind;
use aidevbridge_lib::transport::Transport;
use common::PanicIfAskedSink;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
mod common;

const PROMPT_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Clone)]
struct ChannelSink(mpsc::UnboundedSender<Vec<u8>>);

impl OutputSink for ChannelSink {
    fn send(&self, _host_id: &str, _session: &str, bytes: Vec<u8>) -> bool {
        self.0.send(bytes).is_ok()
    }
}

fn dto() -> Option<HostSpecDto> {
    let host = common::spec()?;
    Some(HostSpecDto {
        hostname: host.hostname,
        port: host.port,
        user: host.user,
        key_path: dirs::home_dir().map(|h| h.join(".ssh/id_ed25519").display().to_string()),
        passphrase: None,
        password: None,
    })
}

async fn sh(t: &dyn Transport, script: &str, args: &[&str]) -> String {
    let mut argv = vec!["sh", "-c", script, "sh"];
    argv.extend_from_slice(args);
    let r = t.exec(&remote::build(&argv)).await.unwrap();
    assert_eq!(r.code, 0, "{script}: {}", r.stderr);
    r.stdout
}

/// Was die App am Server des Nutzers nicht aendern darf: globale Optionen
/// samt Hooks (`-H`), Fensteroptionen, Optionen und Umgebung der Sessions.
const STATE: &str = r#"S=$1
tmux -L "$S" show-options -gH
echo ---
tmux -L "$S" show-options -gw
echo ---
tmux -L "$S" show-environment -g
for name in user1 g1 g2; do
  echo "--- $name"
  tmux -L "$S" show-options -t "=$name"
  tmux -L "$S" show-environment -t "=$name"
done"#;

async fn server_state(t: &dyn Transport, socket: &str) -> String {
    sh(t, STATE, &[socket]).await
}

/// Ein Server, wie ihn ein Nutzer startet: ohne Konfiguration, mit eigener
/// Umgebung, eine Session allein und eine Sitzungsgruppe.
const FOREIGN_SERVER: &str = r#"S=$1
tmux -L "$S" kill-server 2>/dev/null
while tmux -L "$S" list-sessions >/dev/null 2>&1; do sleep 0.1; done
rm -f "/tmp/tmux-$(id -u)/$S"
env SSH_AUTH_SOCK=/tmp/abtest-server-sock DISPLAY=:9 tmux -L "$S" -f /dev/null new-session -d -s user1 -x 80 -y 24
tmux -L "$S" new-session -d -s g1 -x 80 -y 24
tmux -L "$S" new-session -d -t g1 -s g2"#;

const NO_SERVER: &str = r#"S=$1
tmux -L "$S" kill-server 2>/dev/null
while tmux -L "$S" list-sessions >/dev/null 2>&1; do sleep 0.1; done
rm -f "/tmp/tmux-$(id -u)/$S"
echo ok"#;

const SOCKET_FILE: &str = r#"if [ -e "/tmp/tmux-$(id -u)/$1" ]; then echo da; else echo fehlt; fi"#;

fn identity(row: &SessionListItemDto) -> PaneIdentity {
    PaneIdentity {
        server: ServerIdentity {
            pid: row.server_pid.expect("server pid"),
            start_time: row.server_start_time.expect("server start time"),
        },
        session_id: SessionId(row.session_id.expect("session id")),
        window_id: WindowId(row.window_id.expect("window id")),
        pane_id: PaneId(row.pane_id.expect("pane id")),
        pane_pid: row.pane_pid.expect("pane pid"),
    }
}

async fn wait_for_output(
    state: &Arc<AppState>,
    host_id: &str,
    rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    needle: &str,
) {
    let mut seen = Vec::new();
    let found = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(bytes) = rx.recv().await {
            ack_output_tagged_impl(
                state,
                host_id.into(),
                SocketKind::Default,
                "user1".into(),
                bytes.len() as u32,
                None,
            )
            .unwrap();
            seen.extend_from_slice(&bytes);
            if String::from_utf8_lossy(&seen).contains(needle) {
                return true;
            }
        }
        false
    })
    .await;
    assert!(
        matches!(found, Ok(true)),
        "{needle:?} erwartet, gesehen: {:?}",
        String::from_utf8_lossy(&seen)
    );
}

#[tokio::test]
async fn sessions_of_the_default_socket_are_listed_attached_and_left_unchanged() {
    let Some(spec) = dto() else { return };
    let foreign = common::test_socket_for("dflt");
    let t = common::connect_test_host().await.unwrap();
    sh(&t, FOREIGN_SERVER, &[&foreign]).await;
    let before = server_state(&t, &foreign).await;

    let state = Arc::new(
        AppState::with_own_socket(common::test_socket_for("dflt_own"))
            .with_default_socket_name(foreign.clone()),
    );
    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        std::env::temp_dir().join("aidevbridge_integration_test_unused_known_hosts"),
        Arc::new(PanicIfAskedSink),
        PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    // Liste: der eigene Socket ohne Server leer, der fremde mit Bindung fuer
    // die allein stehende Session und ohne fuer die Gruppe.
    let listed = list_sockets_impl(&state, host_id.clone(), true)
        .await
        .unwrap();
    assert!(
        listed.own.error.is_none() && listed.own.sessions.is_empty(),
        "{listed:?}"
    );
    let default = listed.default.expect("default socket was asked for");
    // Am Standard-Socket haengt die App nur unter tmux 3.3a und 3.6 an (Spec
    // 2026-10-25 §6.2). Unter einer anderen Version des Testhosts gibt es
    // nichts anzuhaengen: ein sichtbarer SKIP samt Aufraeumen, kein Bestehen.
    if let Some(version) = &default.unsupported_version {
        assert!(
            default.error.is_none() && default.sessions.is_empty(),
            "{default:?}"
        );
        eprintln!(
            "SKIP sessions_of_the_default_socket_are_listed_attached_and_left_unchanged: \
             tmux {version} auf dem Testhost, den Standard-Socket liest die App nur unter \
             3.3a und 3.6"
        );
        disconnect_host_impl(&state, host_id).await.unwrap();
        sh(&t, NO_SERVER, &[&foreign]).await;
        t.dispose().await;
        return;
    }
    assert!(default.error.is_none(), "{default:?}");
    let row = |name: &str| {
        default
            .sessions
            .iter()
            .find(|row| row.display_name == name)
            .unwrap_or_else(|| panic!("{name} muss gelistet sein: {default:?}"))
            .clone()
    };
    let user1 = row("user1");
    assert!(user1.unverified.is_none(), "{user1:?}");
    for name in ["g1", "g2"] {
        let grouped = row(name);
        assert!(
            grouped
                .unverified
                .as_deref()
                .is_some_and(|reason| reason.contains("shares windows")),
            "{grouped:?}"
        );
    }

    // Ohne Bindung und beim Beenden lehnt das Backend ab, ohne etwas zu tun.
    let (tx, mut rx) = mpsc::unbounded_channel();
    assert_eq!(
        open_terminal_tagged_impl(
            &state,
            ChannelSink(tx.clone()),
            host_id.clone(),
            SocketKind::Default,
            "user1".into(),
            80,
            24,
            "foreign-unbound".into(),
            None,
        )
        .await,
        Err(FOREIGN_UNBOUND.to_string())
    );
    assert_eq!(
        kill_session_impl(
            &state,
            host_id.clone(),
            SocketKind::Default,
            "user1".into(),
            user1.session_id,
            user1.server_pid,
            user1.server_start_time,
        )
        .await,
        Err(FOREIGN_SESSION.to_string())
    );

    // Gebunden ueber den Waechter mit -E: Ein- und Ausgabe laufen.
    open_terminal_tagged_impl(
        &state,
        ChannelSink(tx),
        host_id.clone(),
        SocketKind::Default,
        "user1".into(),
        80,
        24,
        "foreign".into(),
        Some(identity(&user1)),
    )
    .await
    .expect("gebundenes Oeffnen auf dem Standard-Socket");
    send_input_tagged_impl(
        &state,
        host_id.clone(),
        SocketKind::Default,
        "user1".into(),
        b"echo FOREIGN_$((6*7))_OK\r".to_vec(),
        None,
    )
    .await
    .unwrap();
    wait_for_output(&state, &host_id, &mut rx, "FOREIGN_42_OK").await;
    assert_eq!(
        server_state(&t, &foreign).await,
        before,
        "angehaengt: keine Option, kein Hook, keine Umgebung geaendert"
    );

    // Abfrage: der fremde Socket vollstaendig, die Gruppe als unbekannt.
    let polled = poll_sockets_impl(&state, host_id.clone(), true)
        .await
        .unwrap();
    let poll = polled.default.unwrap().poll.expect("default poll");
    assert!(poll.complete, "{poll:?}");
    assert_eq!(poll.server_pid, user1.server_pid);
    assert_eq!(poll.sessions.len(), 3, "{poll:?}");

    close_terminal_tagged_impl(
        &state,
        host_id.clone(),
        SocketKind::Default,
        "user1".into(),
        None,
    )
    .unwrap();
    let mut clients = String::new();
    for _ in 0..50 {
        clients = sh(&t, r#"tmux -L "$1" list-clients"#, &[&foreign]).await;
        if clients.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(clients, "", "nach dem Schliessen haengt kein Client mehr");
    assert_eq!(server_state(&t, &foreign).await, before);
    disconnect_host_impl(&state, host_id).await.unwrap();
    sh(&t, NO_SERVER, &[&foreign]).await;
    t.dispose().await;
}

/// Ohne Server ist der Standard-Socket eine leere Liste und eine vollstaendige,
/// leere Abfrage; weder das eine noch das andere startet einen Server.
#[tokio::test]
async fn a_default_socket_without_a_server_is_empty_and_stays_without_one() {
    let Some(spec) = dto() else { return };
    let absent = common::test_socket_for("dflt_none");
    let t = common::connect_test_host().await.unwrap();
    sh(&t, NO_SERVER, &[&absent]).await;
    let state = Arc::new(
        AppState::with_own_socket(common::test_socket_for("dflt_own2"))
            .with_default_socket_name(absent.clone()),
    );
    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        std::env::temp_dir().join("aidevbridge_integration_test_unused_known_hosts"),
        Arc::new(PanicIfAskedSink),
        PROMPT_TIMEOUT,
    )
    .await
    .unwrap();
    let listed = list_sockets_impl(&state, host_id.clone(), true)
        .await
        .unwrap();
    let default = listed.default.unwrap();
    assert!(
        default.error.is_none() && default.sessions.is_empty(),
        "{default:?}"
    );
    let polled = poll_sockets_impl(&state, host_id.clone(), true)
        .await
        .unwrap();
    let poll = polled.default.unwrap().poll.expect("default poll");
    assert!(poll.complete && poll.sessions.is_empty() && poll.server_pid.is_none());
    assert_eq!(sh(&t, SOCKET_FILE, &[&absent]).await, "fehlt\n");
    disconnect_host_impl(&state, host_id).await.unwrap();
    t.dispose().await;
}
