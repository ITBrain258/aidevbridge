// Titelquelle gegen einen echten Host mit Attrappen-Agents: eine Kopie von
// `sleep` unter dem Namen `codex`, der Titel per OSC 2 gesetzt. Prueft das
// Lese-Skript selbst (tmux, /proc/<pid>/exe, awk-Filter der
// Codex-Einstellungen), nicht nur seinen Parser. Eigener Socket, nichts
// ausserhalb eines eigenen Temp-Verzeichnisses wird geschrieben.
use aidevbridge_lib::remote;
use aidevbridge_lib::status::title::{details_command, pane_status, parse_details, CodexTitle};
use aidevbridge_lib::status::StatusKind;
use aidevbridge_lib::tmux::inventory::PaneId;
use aidevbridge_lib::transport::Transport;
mod common;

/// Startet in einer neuen Session `sh -c <body>`; `$1` ist ein eigenes
/// Temp-Verzeichnis, das beim Ende der Pane wieder verschwindet.
async fn start(t: &dyn Transport, socket: &str, name: &str, dir: &str, body: &str) {
    let script = format!("trap 'rm -rf \"$1\"' EXIT HUP TERM\n{body}\nwait");
    let r = t
        .exec(&remote::build(&[
            "tmux",
            "-L",
            socket,
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            "80",
            "-y",
            "24",
            "sh",
            "-c",
            &script,
            "sh",
            dir,
        ]))
        .await
        .unwrap();
    assert_eq!(r.code, 0, "new-session {name}: {}", r.stderr);
}

async fn sh(t: &dyn Transport, script: &str) -> String {
    let r = t.exec(&remote::build(&["sh", "-c", script])).await.unwrap();
    assert_eq!(r.code, 0, "{script}: {}", r.stderr);
    r.stdout
}

/// Pane und Startprozess der Session, sobald unter ihrer Shell `want`
/// Prozesse laufen (Kinder und Enkel zusammen).
async fn pane_of(t: &dyn Transport, socket: &str, name: &str, want: usize) -> (PaneId, u32) {
    for _ in 0..50 {
        let out = sh(
            t,
            &format!(
                // `=name` allein trifft keine Pane, erst `=name:` (3.3a, 3.6).
                "set -- $(tmux -L '{socket}' display-message -p -t '={name}:' '#{{pane_id}} #{{pane_pid}}')\n\
                 n=0\n\
                 for c in $(cat /proc/$2/task/*/children 2>/dev/null); do\n\
                   n=$((n+1)); for g in $(cat /proc/$c/task/*/children 2>/dev/null); do n=$((n+1)); done\n\
                 done\n\
                 echo $1 $2 $n"
            ),
        )
        .await;
        let mut parts = out.split_whitespace();
        let pane = parts
            .next()
            .and_then(|p| p.strip_prefix('%'))
            .unwrap()
            .parse()
            .unwrap();
        let pid = parts.next().unwrap().parse().unwrap();
        let count: usize = parts.next().unwrap().parse().unwrap();
        if count >= want {
            return (PaneId(pane), pid);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("{name}: Attrappe startete nicht");
}

#[tokio::test]
async fn the_title_counts_only_below_an_agent_executable_and_within_codex_settings() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("title");
    // Reste eines abgebrochenen Laufs auf dem eigenen Socket.
    sh(
        &t,
        &format!("tmux -L '{socket}' kill-server 2>/dev/null; true"),
    )
    .await;
    let base = sh(&t, "mktemp -d /tmp/abtitle.XXXXXX").await;
    let base = base.trim();
    let dirs: Vec<String> = (1..=5).map(|i| format!("{base}/s{i}")).collect();
    sh(&t, &format!("mkdir {}", dirs.join(" "))).await;
    let title = |text: &str| format!("printf '\\033]2;%s\\033\\\\' '{text}'");
    // Die Attrappe ist eine Kopie der Shell: `sleep` taugt nicht, unter
    // Ubuntu 26.04 ist es ein Name des Multicall-Programms `coreutils`, das
    // unter dem Namen `codex` abbricht. `; :` haelt die Shell am Leben.
    let agent = |name: &str| format!("cp \"$(command -v sh)\" \"$1/{name}\"");
    let run_codex = "\"$1/codex\" -c 'sleep 120; :' &";

    // 1: Codex direkt unter der Shell, arbeitend.
    start(
        &t,
        &socket,
        "ab_t1",
        &dirs[0],
        &format!(
            "{}\n{}\n{run_codex}",
            agent("codex"),
            title("⠸ m1-thread | m1-project")
        ),
    )
    .await;
    // 2: Codex wie von npm: `node` mit `codex` darunter, Freigabe offen.
    start(
        &t,
        &socket,
        "ab_t2",
        &dirs[1],
        &format!(
            "{}; {}\n{}\n\"$1/node\" -c '\"$0/codex\" -c \"sleep 120; :\" & wait' \"$1\" &",
            agent("node"),
            agent("codex"),
            title("[ ! ] Action Required | m1-thread | m1-project")
        ),
    )
    .await;
    // 3: derselbe Titel ohne Agent darunter zaehlt nicht.
    start(
        &t,
        &socket,
        "ab_t3",
        &dirs[2],
        &format!("{}\nsleep 120 &", title("⠸ m1-thread | m1-project")),
    )
    .await;
    // 4: Codex, dessen Titel laenger ist als gelesen wird.
    let long = format!("{} | m1-project", "x".repeat(1100));
    start(
        &t,
        &socket,
        "ab_t4",
        &dirs[3],
        &format!("{}\n{}\n{run_codex}", agent("codex"), title(&long)),
    )
    .await;
    // 5: ein Shellskript namens `codex`. Sein comm ist `codex`, sein exe die
    // Shell: kein Codex, auch mit Codex-Titel.
    start(
        &t,
        &socket,
        "ab_t5",
        &dirs[4],
        &format!(
            "printf '#!/bin/sh\\nsleep 120\\n' > \"$1/codex\"; chmod +x \"$1/codex\"\n{}\n\"$1/codex\" &",
            title("⠸ m1-thread | m1-project")
        ),
    )
    .await;

    let panes = [
        pane_of(&t, &socket, "ab_t1", 2).await,
        pane_of(&t, &socket, "ab_t2", 2).await,
        pane_of(&t, &socket, "ab_t3", 1).await,
        pane_of(&t, &socket, "ab_t4", 2).await,
        pane_of(&t, &socket, "ab_t5", 2).await,
    ];
    let read = |prefix: String| {
        let command = details_command(&socket, &panes).unwrap();
        let t = &t;
        async move {
            let r = t.exec(&format!("{prefix}{command}")).await.unwrap();
            assert_eq!(r.code, 0, "{}", r.stderr);
            r.stdout
        }
    };

    // Ohne eigene Einstellungen: die Voreinstellung, sofern der Host keine
    // /etc/codex/config.toml und keine ~/.codex/config.toml mit tui-Schluesseln
    // fuer den Titel hat (auf den Test-VMs so).
    let codex_home = format!("{base}/codex-home");
    sh(&t, &format!("mkdir {codex_home}")).await;
    let stdout = read(format!("export CODEX_HOME={codex_home}; ")).await;
    let details = parse_details(&stdout);
    let status = |i: usize| pane_status(&details[&panes[i].0]).map(|(kind, _)| kind);
    assert_eq!(details[&panes[0].0].codex, CodexTitle::Full);
    assert_eq!(status(0), Some(StatusKind::Busy));
    assert_eq!(status(1), Some(StatusKind::Waiting));
    assert_eq!(
        status(2),
        None,
        "Titel ohne Agent: {:?}",
        details[&panes[2].0]
    );
    assert_eq!(details[&panes[3].0].title, None);
    assert_eq!(status(3), Some(StatusKind::Unknown));
    assert_eq!(status(4), None, "{:?}", details[&panes[4].0]);
    assert!(!details[&panes[4].0].children[0].ends_with("/codex"));
    assert!(details[&panes[0].0].children[0].ends_with("/s1/codex"));

    // Mit Einstellungen: der awk-Filter laesst nur die tui-Schluessel durch,
    // nichts aus anderen Tabellen.
    sh(
        &t,
        &format!(
            "printf '%s\\n' 'model = \"m\"' '[mcp_servers.x.env]' 'TOKEN = \"m1-geheim\"' \
             '[tui]' 'animations = false' '[notice]' 'x = 1' > {codex_home}/config.toml"
        ),
    )
    .await;
    let stdout = read(format!("export CODEX_HOME={codex_home}; ")).await;
    let k_lines: Vec<&str> = stdout.lines().filter(|l| l.starts_with("K ")).collect();
    assert_eq!(k_lines.len(), 1, "{stdout}");
    let filtered = String::from_utf8(
        (2..k_lines[0].len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&k_lines[0][i..i + 2], 16).unwrap())
            .collect(),
    )
    .unwrap();
    assert_eq!(filtered, "[tui]\nanimations = false\n");
    let details = parse_details(&stdout);
    let status = |i: usize| pane_status(&details[&panes[i].0]).map(|(kind, _)| kind);
    assert_eq!(details[&panes[0].0].codex, CodexTitle::NoProgress);
    assert_eq!(status(0), Some(StatusKind::Unknown));
    assert_eq!(status(1), Some(StatusKind::Waiting));

    sh(
        &t,
        &format!("tmux -L '{socket}' kill-server; rm -rf {base}"),
    )
    .await;
}
