// Messwerkzeug, kein Test der Suite: Es ruft die Befehlskerne der App gegen
// ein Wegwerfkonto auf einem echten Host und druckt, was sie liefern. Es
// behauptet nichts; die Auswertung steht im Messbericht.
//
// Es liegt nur waehrend der Messung unter `src-tauri/tests/` und sonst bei
// den Rohdaten des Berichts. Aufruf je Szenario:
//
//   cargo test --test measure_shell_and_walk -- --ignored --exact <name> --nocapture
//
// Umgebung:
//   AIDEVBRIDGE_MEASURE_HOST       Host oder 127.0.0.1 fuer den Verzoegerer
//   AIDEVBRIDGE_MEASURE_PORT       Port, sonst 22
//   AIDEVBRIDGE_MEASURE_DIRECT     Host ohne Verzoegerer (fuer die zweite Verbindung)
//   AIDEVBRIDGE_MEASURE_USER       das Wegwerfkonto
//   AIDEVBRIDGE_MEASURE_HOST_KEY   ed25519-Schluessel des Hosts, base64
//   AIDEVBRIDGE_MEASURE_KEY        privater Schluessel des Kontos
//   AIDEVBRIDGE_MEASURE_SOCKET     eigener tmux-Socket, beginnt mit abmess_
//   AIDEVBRIDGE_MEASURE_LABEL      Name des Laufs in der Ausgabe
//   AIDEVBRIDGE_MEASURE_SESSIONS   Zahl der Sessions fuer prepare_sessions
//   AIDEVBRIDGE_MEASURE_POLL       1: waehrend des Gangs alle 2 s die Statusabfrage
//   AIDEVBRIDGE_MEASURE_STALL_FLAG Datei, bei der der Verzoegerer nichts mehr weiterreicht
use aidevbridge_lib::commands::{
    close_terminal_impl, connect_host_with_known_hosts, create_session_impl, disconnect_host_impl,
    kill_session_impl, list_directories_impl, list_sockets_impl, open_terminal_tagged_impl,
    poll_sockets_impl, run_preflight_impl, AppState, HostSpecDto, OperationErrorDto, OutputSink,
    SessionListDto, SessionListItemDto,
};
use aidevbridge_lib::ssh::AuthMethod;
use aidevbridge_lib::tmux::inventory::{PaneId, ServerIdentity, SessionId, WindowId};
use aidevbridge_lib::tmux::session_binding::PaneIdentity;
use aidevbridge_lib::tmux::SocketKind;
use aidevbridge_lib::transport::{HostKeyPolicy, HostSpec, RusshTransport, Transport};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
mod common;

struct Config {
    host: String,
    port: u16,
    direct: String,
    user: String,
    host_key: String,
    key: String,
    socket: String,
    label: String,
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} fehlt"))
}

fn config() -> Config {
    let socket = required("AIDEVBRIDGE_MEASURE_SOCKET");
    assert!(
        socket.starts_with("abmess_")
            && socket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
        "der Socket muss ein eigener Messsocket sein (abmess_...)"
    );
    let host = required("AIDEVBRIDGE_MEASURE_HOST");
    Config {
        port: std::env::var("AIDEVBRIDGE_MEASURE_PORT")
            .map(|port| port.parse().expect("AIDEVBRIDGE_MEASURE_PORT"))
            .unwrap_or(22),
        direct: std::env::var("AIDEVBRIDGE_MEASURE_DIRECT").unwrap_or_else(|_| host.clone()),
        host,
        user: required("AIDEVBRIDGE_MEASURE_USER"),
        host_key: required("AIDEVBRIDGE_MEASURE_HOST_KEY"),
        key: required("AIDEVBRIDGE_MEASURE_KEY"),
        socket,
        label: std::env::var("AIDEVBRIDGE_MEASURE_LABEL").unwrap_or_default(),
    }
}

/// Die Zeile, unter der `known_hosts` diesen Host fuehrt; sie geht als Text
/// hinein, die echte Datei des Rechners wird nie gelesen oder geschrieben.
fn known_hosts_line(cfg: &Config) -> String {
    match cfg.port {
        22 => format!("{} ssh-ed25519 {}\n", cfg.host, cfg.host_key),
        port => format!("[{}]:{port} ssh-ed25519 {}\n", cfg.host, cfg.host_key),
    }
}

async fn connect(cfg: &Config) -> Result<(Arc<AppState>, String), String> {
    let state = Arc::new(AppState::with_own_socket(cfg.socket.clone()));
    let spec = HostSpecDto {
        hostname: cfg.host.clone(),
        port: cfg.port,
        user: cfg.user.clone(),
        key_path: Some(cfg.key.clone()),
        passphrase: None,
        password: None,
    };
    let host = connect_host_with_known_hosts(
        &state,
        spec,
        known_hosts_line(cfg),
        std::env::temp_dir().join("aidevbridge_measure_unused_known_hosts"),
        Arc::new(common::PanicIfAskedSink),
        Duration::from_secs(5),
    )
    .await?;
    Ok((state, host))
}

/// Nimmt nur den bekannten Schluessel des Hosts an.
struct Pinned(String);

#[async_trait::async_trait]
impl HostKeyPolicy for Pinned {
    async fn decide(&self, _: &str, _: u16, key_type: &str, key_b64: &str) -> bool {
        key_type == "ssh-ed25519" && key_b64 == self.0
    }
    fn known_key_types(&self, _: &str, _: u16) -> Vec<String> {
        vec!["ssh-ed25519".into()]
    }
}

/// Eine zweite Verbindung am Verzoegerer vorbei, fuer den einen tmux-Befehl
/// auf dem eigenen Messsocket.
async fn direct(cfg: &Config) -> RusshTransport {
    RusshTransport::connect(
        &HostSpec {
            hostname: cfg.direct.clone(),
            port: 22,
            user: cfg.user.clone(),
        },
        Arc::new(Pinned(cfg.host_key.clone())),
        &AuthMethod::Key {
            path: cfg.key.clone().into(),
            passphrase: None,
        },
    )
    .await
    .expect("zweite Verbindung")
}

fn show<T: std::fmt::Debug>(step: &str, started: Instant, result: &T) {
    println!(
        "STEP {step} ({} ms): {result:#?}",
        started.elapsed().as_millis()
    );
}

/// Sammelt, was das Terminal liefert, und meldet eine verlorene Verbindung.
#[derive(Clone, Default)]
struct Collecting(Arc<Mutex<Vec<u8>>>);

impl OutputSink for Collecting {
    fn send(&self, _host_id: &str, _session: &str, bytes: Vec<u8>) -> bool {
        self.0.lock().unwrap().extend(bytes);
        true
    }
    fn connection_lost(&self, _host_id: &str, session: &str) {
        println!("STEP terminal of {session}: connection lost");
    }
}

type Listed = Result<SessionListDto, OperationErrorDto>;

/// Die Bindung einer Zeile, wie die Seitenleiste sie an `open_terminal` gibt:
/// nur mit allen sechs Feldern, sonst oeffnet sie ueber den Namen.
fn bound(row: &SessionListItemDto) -> Option<PaneIdentity> {
    Some(PaneIdentity {
        server: ServerIdentity {
            pid: row.server_pid?,
            start_time: row.server_start_time?,
        },
        session_id: SessionId(row.session_id?),
        window_id: WindowId(row.window_id?),
        pane_id: PaneId(row.pane_id?),
        pane_pid: row.pane_pid?,
    })
}

/// Die Identitaet, die die Liste fuer `name` nennt; ohne Liste oder ohne
/// Eintrag bleibt nur der Name.
fn identity(listed: &Listed, name: &str) -> (Option<u32>, Option<u32>, Option<u64>) {
    listed
        .as_ref()
        .ok()
        .and_then(|list| list.own.sessions.iter().find(|s| s.display_name == name))
        .map(|s| (s.session_id, s.server_pid, s.server_start_time))
        .unwrap_or((None, None, None))
}

async fn list(state: &Arc<AppState>, host: &str, step: &str) -> Listed {
    let started = Instant::now();
    let listed = list_sockets_impl(state, host.to_string(), true).await;
    show(step, started, &listed);
    listed
}

async fn end(state: &Arc<AppState>, host: &str, listed: &Listed, name: &str, step: &str) {
    let (session_id, server_pid, server_start_time) = identity(listed, name);
    let started = Instant::now();
    let ended = kill_session_impl(
        state,
        host.to_string(),
        SocketKind::App,
        name.to_string(),
        session_id,
        server_pid,
        server_start_time,
    )
    .await;
    show(step, started, &ended);
}

/// Ein Durchgang durch das, was ein Nutzer an einem Host tut, mit der
/// Startdatei der Shell, wie sie gerade ist.
#[tokio::test]
#[ignore = "Messwerkzeug, braucht AIDEVBRIDGE_MEASURE_*"]
async fn shell_variant() {
    let cfg = config();
    println!("VARIANT {}", cfg.label);

    let started = Instant::now();
    let connected = connect(&cfg).await;
    show("connect", started, &connected.as_ref().map(|_| "connected"));
    let Ok((state, host)) = connected else { return };

    let started = Instant::now();
    show(
        "host check",
        started,
        &run_preflight_impl(&state, host.clone()).await,
    );
    let _ = list(&state, &host, "list, before anything").await;
    let started = Instant::now();
    show(
        "status poll",
        started,
        &poll_sockets_impl(&state, host.clone(), true).await,
    );
    let started = Instant::now();
    show(
        "directory listing of the home folder",
        started,
        &list_directories_impl(&state, host.clone(), String::new(), false).await,
    );

    let started = Instant::now();
    show(
        "new session mess_a",
        started,
        &create_session_impl(&state, host.clone(), "/tmp".into(), Some("mess_a".into())).await,
    );
    let listed = list(&state, &host, "list, after mess_a").await;

    let selected = listed
        .as_ref()
        .ok()
        .and_then(|list| {
            list.own
                .sessions
                .iter()
                .find(|s| s.display_name == "mess_a")
        })
        .and_then(bound);
    let sink = Collecting::default();
    let started = Instant::now();
    let opened = open_terminal_tagged_impl(
        &state,
        sink.clone(),
        host.clone(),
        SocketKind::App,
        "mess_a".into(),
        80,
        24,
        "measure-open".into(),
        selected,
    )
    .await;
    show(
        match selected {
            Some(_) => "open mess_a, bound to the listed pane",
            None => "open mess_a, by name",
        },
        started,
        &opened,
    );
    tokio::time::sleep(Duration::from_millis(800)).await;
    {
        let bytes = sink.0.lock().unwrap();
        println!(
            "STEP terminal within 800 ms: {} bytes, shell text in it: hello {}, warn {}",
            bytes.len(),
            bytes.windows(5).any(|w| w == b"hello"),
            bytes.windows(4).any(|w| w == b"warn")
        );
    }
    let started = Instant::now();
    show(
        "close mess_a",
        started,
        &close_terminal_impl(&state, host.clone(), "mess_a".into()).await,
    );

    let started = Instant::now();
    show(
        "new session mess_b",
        started,
        &create_session_impl(&state, host.clone(), "/tmp".into(), Some("mess_b".into())).await,
    );
    let listed = list(&state, &host, "list, with mess_a and mess_b").await;
    end(&state, &host, &listed, "mess_a", "end mess_a").await;
    let listed = list(&state, &host, "list, after ending mess_a").await;
    end(&state, &host, &listed, "mess_b", "end mess_b, the last one").await;
    let _ = list(&state, &host, "list, empty host").await;
    let started = Instant::now();
    show(
        "status poll, empty host",
        started,
        &poll_sockets_impl(&state, host.clone(), true).await,
    );

    let started = Instant::now();
    show(
        "disconnect",
        started,
        &disconnect_host_impl(&state, host).await,
    );
}

/// Legt die Sessions fuer den langsamen Gang an, ohne Verzoegerer.
#[tokio::test]
#[ignore = "Messwerkzeug, braucht AIDEVBRIDGE_MEASURE_*"]
async fn prepare_sessions() {
    let cfg = config();
    let count: usize = required("AIDEVBRIDGE_MEASURE_SESSIONS")
        .parse()
        .expect("AIDEVBRIDGE_MEASURE_SESSIONS");
    let (state, host) = connect(&cfg).await.expect("connect");
    let mut created = 0;
    for index in 0..count {
        let name = format!("slow_{index:02}");
        match create_session_impl(&state, host.clone(), "/tmp".into(), Some(name.clone())).await {
            Ok(_) => created += 1,
            Err(error) => println!("STEP new session {name}: {error:?}"),
        }
    }
    println!("STEP sessions created: {created} of {count}");
    let _ = disconnect_host_impl(&state, host).await;
}

/// Fuenfmal ein einzelner SSH-Befehl: die Laufzeit eines Befehls auf dieser
/// Verbindung.
#[tokio::test]
#[ignore = "Messwerkzeug, braucht AIDEVBRIDGE_MEASURE_*"]
async fn one_command() {
    let cfg = config();
    println!("RUN {}", cfg.label);
    let started = Instant::now();
    let (state, host) = connect(&cfg).await.expect("connect");
    println!("STEP connect: {} ms", started.elapsed().as_millis());
    for round in 1..=5 {
        let started = Instant::now();
        let listing = list_directories_impl(&state, host.clone(), String::new(), false).await;
        println!(
            "STEP one command, round {round}: {} ms, ok {}",
            started.elapsed().as_millis(),
            listing.is_ok()
        );
    }
    let _ = disconnect_host_impl(&state, host).await;
}

fn summary(listed: &Listed) -> String {
    match listed {
        Ok(list) => format!(
            "sessions {}, unverified {}, error of the own socket: {:?}",
            list.own.sessions.len(),
            list.own
                .sessions
                .iter()
                .filter(|s| s.unverified.is_some())
                .count(),
            list.own.error
        ),
        Err(error) => format!("failed: {error:?}"),
    }
}

/// Die Statusabfrage alle 2 s, solange der Gang laeuft: was sie ohne die
/// Pause des Frontends liefert.
fn poll_alongside(
    state: &Arc<AppState>,
    host: &str,
    started: Instant,
) -> tokio::task::JoinHandle<()> {
    let (state, host) = (state.clone(), host.to_string());
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let asked = started.elapsed().as_millis();
            let polled = poll_sockets_impl(&state, host.clone(), false).await;
            let answer = match &polled {
                Ok(polls) => match (&polls.own.poll, &polls.own.error) {
                    (Some(poll), _) => format!(
                        "ok, {} rows, complete {}",
                        poll.sessions.len(),
                        poll.complete
                    ),
                    (None, error) => format!("socket error: {error:?}"),
                },
                Err(error) => format!("failed: {error:?}"),
            };
            println!(
                "POLL asked at {asked} ms, answered at {} ms: {answer}",
                started.elapsed().as_millis()
            );
        }
    })
}

/// Die Sessionliste des eigenen Sockets, einmal, mit Stoppuhr.
#[tokio::test]
#[ignore = "Messwerkzeug, braucht AIDEVBRIDGE_MEASURE_*"]
async fn walk() {
    let cfg = config();
    println!("RUN {}", cfg.label);
    let (state, host) = connect(&cfg).await.expect("connect");
    let started = Instant::now();
    let poller = (std::env::var("AIDEVBRIDGE_MEASURE_POLL").as_deref() == Ok("1"))
        .then(|| poll_alongside(&state, &host, started));
    let listed = list_sockets_impl(&state, host.clone(), false).await;
    println!(
        "STEP list of the own socket: {} ms, {}",
        started.elapsed().as_millis(),
        summary(&listed)
    );
    if let Some(poller) = poller {
        poller.abort();
    }
    let _ = disconnect_host_impl(&state, host).await;
}

/// Der tmux-Server des Messsockets endet, waehrend die Liste laedt.
#[tokio::test]
#[ignore = "Messwerkzeug, braucht AIDEVBRIDGE_MEASURE_*"]
async fn walk_server_ends() {
    let cfg = config();
    println!("RUN {}", cfg.label);
    let (state, host) = connect(&cfg).await.expect("connect");
    let second = direct(&cfg).await;
    let started = Instant::now();
    let walk = {
        let (state, host) = (state.clone(), host.clone());
        tokio::spawn(async move { list_sockets_impl(&state, host, false).await })
    };
    tokio::time::sleep(Duration::from_secs(4)).await;
    let ended = second
        .exec(&format!("tmux -L {} kill-server", cfg.socket))
        .await;
    let ended_at = started.elapsed();
    println!(
        "STEP server ended at {} ms: {:?}",
        ended_at.as_millis(),
        ended.map(|result| (result.code, result.stderr))
    );
    let listed = walk.await.expect("walk");
    println!(
        "STEP list of the own socket: answered at {} ms, {} ms after the server ended, {}",
        started.elapsed().as_millis(),
        (started.elapsed() - ended_at).as_millis(),
        summary(&listed)
    );
    second.dispose().await;
    let _ = disconnect_host_impl(&state, host).await;
}

/// Die Verbindung reicht mitten im Gang nichts mehr weiter.
#[tokio::test]
#[ignore = "Messwerkzeug, braucht AIDEVBRIDGE_MEASURE_*"]
async fn walk_link_stalls() {
    let cfg = config();
    println!("RUN {}", cfg.label);
    let flag = required("AIDEVBRIDGE_MEASURE_STALL_FLAG");
    let (state, host) = connect(&cfg).await.expect("connect");
    let started = Instant::now();
    let walk = {
        let (state, host) = (state.clone(), host.clone());
        tokio::spawn(async move { list_sockets_impl(&state, host, false).await })
    };
    tokio::time::sleep(Duration::from_secs(4)).await;
    std::fs::write(&flag, "stall").expect("stall flag");
    let stalled_at = started.elapsed();
    println!("STEP link stalled at {} ms", stalled_at.as_millis());
    let listed = walk.await.expect("walk");
    println!(
        "STEP list of the own socket: answered at {} ms, {} ms after the stall, {}",
        started.elapsed().as_millis(),
        (started.elapsed() - stalled_at).as_millis(),
        summary(&listed)
    );
    let _ = std::fs::remove_file(&flag);
    let disconnected =
        tokio::time::timeout(Duration::from_secs(20), disconnect_host_impl(&state, host)).await;
    println!("STEP disconnect: {disconnected:?}");
}
