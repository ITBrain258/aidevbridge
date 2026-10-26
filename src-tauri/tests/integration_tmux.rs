// Crate-Name `aidevbridge_lib` statt `aidevbridge` (siehe common/mod.rs).
// Der `Transport`-Import ist noetig -- ohne ihn ist
// `t.exec(...)` in `history_limit_is_set_before_sessions_exist` nicht
// sichtbar (E0599, `exec` ist eine Trait-Methode).
use aidevbridge_lib::remote;
use aidevbridge_lib::tmux::{CreateOutcome, OwnSocket, OwnTmuxClient};
use aidevbridge_lib::transport::Transport;
mod common; // stellt `connect_test_host()` bereit, siehe Task 5

#[tokio::test]
async fn create_list_and_kill_session() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("tmux");
    let c = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
    c.prepare_server(&t, 10000).await.unwrap();

    let name = "ab_aa11bb";
    assert!(matches!(
        c.create_session(&t, name, "/tmp").await.unwrap(),
        CreateOutcome::Created
    ));
    assert!(c
        .list_session_names(&t)
        .await
        .unwrap()
        .contains(&name.to_string()));

    // Zweiter Versuch mit gleichem Namen ist eine Kollision, kein Attach (Spec §5.1)
    assert!(matches!(
        c.create_session(&t, name, "/tmp").await.unwrap(),
        CreateOutcome::DuplicateName
    ));

    c.kill_session(&t, name).await.unwrap();
    assert!(!c
        .list_session_names(&t)
        .await
        .unwrap()
        .contains(&name.to_string()));
}

/// B0: `kill_session` darf ein Praefixgeschwister nicht erwischen.
///
/// **Der Schadenszustand ist "Ziel abwesend + Praefixgeschwister
/// anwesend".** Ein Test, der beide Namen anlegt, kann den Fehler nicht
/// sehen: tmux faende dann den exakten Treffer und raeumte den richtigen
/// weg. Deshalb existiert `zz_b0kill` hier absichtlich NIE.
///
/// Ohne `=` meldet der Aufruf Exit 0 und `zz_b0kill2` ist weg (an der VM
/// gemessen, tmux 3.4).
///
/// Eigener Socket, eigenes `zz_`-Praefix: dieser Test darf sich mit den
/// `ab_*`-Sessions auf dem Produktivsocket unter keinen Umstaenden
/// beruehren.
#[tokio::test]
async fn kill_session_does_not_hit_a_prefix_sibling() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("b0kill");
    let c = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
    c.prepare_server(&t, 10000).await.unwrap();

    let sibling = "zz_b0kill2".to_string();
    c.create_session(&t, &sibling, "/tmp").await.unwrap();

    // Positivkontrolle. Ohne sie waere ein Lauf, in dem gar keine Session
    // entstanden ist, von einem geglueckten Test nicht zu unterscheiden --
    // die Schlussassertion prueft schliesslich nur, dass etwas NOCH DA ist.
    assert!(
        c.list_session_names(&t).await.unwrap().contains(&sibling),
        "Vorbedingung: das Praefixgeschwister muss vor dem Kill existieren"
    );

    c.kill_session(&t, "zz_b0kill").await.unwrap();

    let after = c.list_session_names(&t).await.unwrap();
    assert!(
        after.contains(&sibling),
        "kill-session auf das NICHT existierende `zz_b0kill` hat das \
         Praefixgeschwister `zz_b0kill2` erwischt -- das `=` im Ziel fehlt. \
         Uebrige Sessions: {after:?}"
    );

    c.kill_session(&t, &sibling).await.unwrap();
}

#[tokio::test]
async fn history_limit_is_set_before_sessions_exist() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("tmux2");
    let c = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
    c.prepare_server(&t, 12345).await.unwrap();
    c.create_session(&t, "ab_cc22dd", "/tmp").await.unwrap();
    let r = t
        .exec(&remote::build(&[
            "tmux",
            "-L",
            &socket,
            "display",
            "-p",
            "-t",
            "ab_cc22dd",
            "#{history_limit}",
        ]))
        .await
        .unwrap();
    assert_eq!(
        r.stdout.trim(),
        "12345",
        "history-limit muss VOR new-session wirken (Spec V10)"
    );
    c.kill_session(&t, "ab_cc22dd").await.unwrap();
}

/// Review-Befund: der `exit-empty`-Bug hat beim
/// ersten Testlauf ALLE VIER `prepare_server`-Kommandos wirkungslos gemacht,
/// nicht nur `history-limit` -- nur `history-limit` hatte bis dahin eine
/// eigene Probe. Ohne diesen Test waere `remain-on-exit` (Spec V21) undicht
/// geblieben: `#{pane_dead}` koennte nie 1 werden, ohne dass irgendein Test
/// das bemerkt.
#[tokio::test]
async fn remain_on_exit_and_terminal_overrides_are_applied() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("tmux3");
    let c = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
    c.prepare_server(&t, 5000).await.unwrap();
    c.create_session(&t, "ab_ee33ff", "/tmp").await.unwrap();

    let remain = t
        .exec(&remote::build(&[
            "tmux",
            "-L",
            &socket,
            "show",
            "-wg",
            "remain-on-exit",
        ]))
        .await
        .unwrap();
    assert_eq!(
        remain.stdout.trim(),
        "remain-on-exit on",
        "remain-on-exit muss ueber setw -g gesetzt sein (Spec V21)"
    );

    let overrides = t
        .exec(&remote::build(&[
            "tmux",
            "-L",
            &socket,
            "show",
            "-g",
            "terminal-overrides",
        ]))
        .await
        .unwrap();
    assert!(
        overrides.stdout.contains("smcup@") && overrides.stdout.contains("rmcup@"),
        "terminal-overrides fehlt oder unvollstaendig: {}",
        overrides.stdout
    );

    c.kill_session(&t, "ab_ee33ff").await.unwrap();
}

/// Prueft den Rueckweg aus `create_session` (`; set -g exit-empty on`)
/// direkt, nicht ueber `list_session_names` (Review-Befund).
///
/// `list_session_names` liefert nach `kill_session` in ZWEI verschiedenen
/// Situationen eine leere Liste: wenn gar kein Server mehr laeuft (der
/// gewuenschte Zustand) und wenn ein Server mit null Sessions weiterlaeuft
/// (genau der Fehlerzustand, den `exit-empty on` verhindern soll). Ein Test,
/// der nur `!list_session_names(..).contains(name)` prueft (wie
/// `create_list_and_kill_session` oben), sieht beide Faelle gleich und
/// bliebe gruen, entfernte jemand `; set -g exit-empty on` aus
/// `create_session` -- der Server liefe dann als verwaister Prozess auf der
/// VM weiter, ohne dass irgendein Test das bemerkt.
///
/// Deshalb hier: direkte Serverzustandspruefung ueber `list-sessions` auf
/// demselben Socket -- einmal VOR `kill_session` (Positivkontrolle: belegt,
/// dass die Sonde ueberhaupt den richtigen Socket trifft und einen
/// laufenden Server als Exit 0 erkennt -- ohne sie waere ein spaeteres
/// "Exit != 0" nach `kill_session` mehrdeutig, es koennte ja auch ein
/// falsch adressierter Socket sein statt ein toter Server) und einmal
/// DANACH. Exit-Code und Fehlermeldung unterscheiden die beiden Zustaende
/// empirisch eindeutig (verifiziert auf der Test-VM, tmux 3.3a): kein
/// Server laeuft -> Exit != 0, Stderr "no server running on ..."; Server
/// laeuft mit null Sessions weiter -> Exit 0, leeres Stdout. Genau diese
/// Unterscheidung trifft `list_session_names` nicht (sie liefert in beiden
/// Faellen `Ok(vec![])`), deshalb wird hier bewusst nicht darueber gegangen.
///
/// Alternative (verworfen): `show -g exit-empty` direkt nach
/// `create_session` abfragen und auf "on" pruefen. Einfacher, aber nur eine
/// Konfigurationsoption geprueft, nicht der tatsaechliche Serverzustand --
/// ein Refactoring, das denselben Effekt (Server verschwindet nach der
/// letzten Session) ueber einen anderen Mechanismus als die Option
/// `exit-empty` erreicht, wuerde diesen Test grundlos rot machen. Vor allem
/// aber beobachtet diese Variante nie beide Zustaende ("kein Server" und
/// "Server mit null Sessions") im selben Testlauf, sondern prueft nur ein
/// Konfigurationsdetail, aus dem der Serverzustand lediglich erschlossen
/// wird -- genau das, was hier vermieden werden soll.
#[tokio::test]
async fn kill_session_leaves_no_server_running_behind() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("tmux4");
    let c = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
    c.prepare_server(&t, 7000).await.unwrap();

    let name = "ab_44dd55";
    assert!(matches!(
        c.create_session(&t, name, "/tmp").await.unwrap(),
        CreateOutcome::Created
    ));

    // Positivkontrolle: solange die Session existiert, muss dieselbe Sonde
    // einen laufenden Server mit Exit 0 sehen.
    let before = t
        .exec(&remote::build(&["tmux", "-L", &socket, "list-sessions"]))
        .await
        .unwrap();
    assert_eq!(
        before.code, 0,
        "Server muss vor kill_session erreichbar sein: {}",
        before.stderr
    );
    assert!(
        before.stdout.contains(name),
        "list-sessions muss die gerade angelegte Session zeigen: {}",
        before.stdout
    );

    c.kill_session(&t, name).await.unwrap();

    let after = t
        .exec(&remote::build(&["tmux", "-L", &socket, "list-sessions"]))
        .await
        .unwrap();
    assert_ne!(
        after.code, 0,
        "nach kill_session darf ueberhaupt kein Server mehr antworten -- \
         Exit 0 hier heisst: der Server laeuft noch mit null Sessions weiter, \
         weil `exit-empty` nicht wieder auf \"on\" gesetzt wurde"
    );
    assert!(
        after.stderr.contains("no server running"),
        "erwartete Fehlermeldung eines toten Servers, bekam: {}",
        after.stderr
    );
}

/// Ein `#` im Startordner bleibt woertlich: tmux wertet das Argument von
/// `new-session -c` als Format aus. Ohne Verdopplung startete `C#Project`
/// still im Home-Ordner, und ein Ordner `#(...)` fuehrte seinen Befehl auf dem
/// Host aus (gemessen, docs/messungen/messung-2026-10-26-tmux-cwd-format.md).
///
/// Der Befehl im Ordnernamen legt die Marke per `cd` immer im Home-Ordner
/// an, gleich in welchem Ordner tmux den Format-Job startet. Format-Jobs
/// laufen asynchron; die Pause vor der Pruefung laesst einem faelschlich
/// gestarteten Job Zeit.
#[tokio::test]
async fn a_hash_in_the_start_directory_stays_literal() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("cwdhash");
    let c = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
    let base = t
        .exec(&remote::build(&["mktemp", "-d", "/tmp/zz_cwdhash.XXXXXX"]))
        .await
        .unwrap();
    assert_eq!(base.code, 0, "mktemp: {}", base.stderr);
    let base = base.stdout.trim().to_string();
    let marker = format!("zz_cwdhash_marker_{}", std::process::id());
    let cases = [
        ("zz_cwdhash_c", format!("{base}/C#Project")),
        ("zz_cwdhash_job", format!("{base}/#(cd;touch {marker})")),
    ];
    for (_, dir) in &cases {
        let made = t.exec(&remote::build(&["mkdir", dir])).await.unwrap();
        assert_eq!(made.code, 0, "mkdir {dir:?}: {}", made.stderr);
    }

    c.prepare_server(&t, 2000).await.unwrap();
    for (name, dir) in &cases {
        assert!(matches!(
            c.create_session(&t, name, dir).await.unwrap(),
            CreateOutcome::Created
        ));
    }
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // tmux 3.0 kennt `#{session_path}` nicht und gibt dafuer eine leere Zeile
    // aus; dort bleibt nur der Ordner der Pane zu pruefen.
    let version = t
        .exec(&remote::build(&[
            "tmux",
            "-L",
            &socket,
            "display",
            "-p",
            "-t",
            cases[0].0,
            "#{version}",
        ]))
        .await
        .unwrap();
    assert_eq!(version.code, 0, "version: {}", version.stderr);
    let formats: &[&str] = if version.stdout.trim().starts_with("3.0") {
        &["#{pane_current_path}"]
    } else {
        &["#{pane_current_path}", "#{session_path}"]
    };

    for (name, dir) in &cases {
        for &format in formats {
            let r = t
                .exec(&remote::build(&[
                    "tmux", "-L", &socket, "display", "-p", "-t", name, format,
                ]))
                .await
                .unwrap();
            assert_eq!(
                (r.code, r.stdout.trim_end_matches('\n')),
                (0, dir.as_str()),
                "{format} von {name}: {}",
                r.stderr
            );
        }
    }
    let probe = t
        .exec(&remote::build(&[
            "sh",
            "-c",
            "if test -e \"$HOME/$1\"; then echo present; else echo absent; fi",
            "sh",
            &marker,
        ]))
        .await
        .unwrap();
    assert_eq!(
        probe.stdout.trim(),
        "absent",
        "der Befehl im Ordnernamen lief auf dem Host: {}",
        probe.stderr
    );

    for (name, _) in &cases {
        c.kill_session(&t, name).await.unwrap();
    }
    t.exec(&remote::build(&["rm", "-rf", &base])).await.unwrap();
}
