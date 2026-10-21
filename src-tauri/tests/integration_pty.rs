// Crate-Name `aidevbridge_lib` statt `aidevbridge` (siehe common/mod.rs,
// [lib] name = "aidevbridge_lib" in Cargo.toml seit Task 1).
use aidevbridge_lib::remote;
use aidevbridge_lib::tmux::TmuxClient;
use aidevbridge_lib::transport::Transport;
mod common;

#[tokio::test]
async fn attach_yields_a_working_terminal() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("pty");
    let c = TmuxClient::new(&socket);
    c.prepare_server(&t, 10000).await.unwrap();
    c.create_session(&t, "ab_dd33ee", "/tmp").await.unwrap();

    let mut h = t.open_attach(&socket, "ab_dd33ee", 120, 30).await.unwrap();

    // Der Attach-Strom beginnt mit einem absoluten Repaint (Spec V7). Erste
    // paar Chunks einsammeln statt nur den allerersten zu pruefen: die
    // ESC[?1049h-Abwesenheit (naechste Assertion) darf nicht blind fuer eine
    // Sequenz sein, die erst im zweiten oder dritten Chunk ankommt
    // (Gegenprobe zur Chunk-Granularitaet).
    let mut collected = Vec::new();
    for _ in 0..5 {
        match tokio::time::timeout(std::time::Duration::from_millis(800), h.data.recv()).await {
            Ok(Some(chunk)) => collected.extend_from_slice(&chunk),
            _ => break,
        }
    }
    let s = String::from_utf8_lossy(&collected);
    // V7 (Spec Zeile 63): der Attach-Strom ist ein vollstaendiger ABSOLUTER
    // Repaint -- "ESC[?1h ESC= ESC[H ESC[2J ...", OHNE ESC[3J. Nur auf
    // irgendeine CSI-Sequenz zu pruefen (`s.contains("\x1b[")`, die vorherige
    // Fassung dieser Assertion) waere von jeder beliebigen Escape-Sequenz
    // erfuellt -- z. B. einem einzelnen Farbcode -- und wuerde damit nicht
    // das behaupten, was dieser Kommentar zitiert. Stattdessen die beiden
    // von V7 namentlich genannten Repaint-Marker pruefen (empirisch gegen
    // die VM bestaetigt: der erste Chunk beginnt exakt mit
    // "\x1b[?1h\x1b=\x1b[H\x1b[2J...") sowie die von V7
    // explizit ausgeschlossene Sequenz.
    assert!(
        s.contains("\x1b[H"),
        "erwartet Cursor-Home (ESC[H) als Teil des absoluten Repaints (Spec V7), bekam: {s:?}"
    );
    assert!(
        s.contains("\x1b[2J"),
        "erwartet Bildschirm-Loeschen (ESC[2J) als Teil des absoluten Repaints (Spec V7), bekam: {s:?}"
    );
    assert!(
        !s.contains("\x1b[3J"),
        "ESC[3J (Scrollback-Loeschen) widerspricht V7 (\"absoluter Repaint ... ohne ESC[3J\"), bekam: {s:?}"
    );

    // Ohne terminal-overrides wuerde hier ESC[?1049h stehen (Spec V5/V18) --
    // Task 8 setzt `terminal-overrides ',*:smcup@:rmcup@'` in prepare_server,
    // dieser Test ist der Beleg, dass die Option tatsaechlich wirkt.
    assert!(
        !s.contains("\x1b[?1049h"),
        "Alternate Screen darf nicht aktiviert werden, bekam: {s:?}"
    );

    // Eingabe kommt an
    h.write(b"echo MARKER_XYZ\n").await.unwrap();
    let mut seen = String::new();
    for _ in 0..40 {
        if let Ok(Some(chunk)) =
            tokio::time::timeout(std::time::Duration::from_millis(500), h.data.recv()).await
        {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if seen.contains("MARKER_XYZ") {
                break;
            }
        }
    }
    assert!(seen.contains("MARKER_XYZ"), "Eingabe kam nicht im Pane an");

    h.close().await;
    c.kill_session(&t, "ab_dd33ee").await.unwrap();
}

#[tokio::test]
async fn resize_reaches_the_remote_pane() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("pty2");
    let c = TmuxClient::new(&socket);
    c.prepare_server(&t, 10000).await.unwrap();
    c.create_session(&t, "ab_ff44aa", "/tmp").await.unwrap();
    let h = t.open_attach(&socket, "ab_ff44aa", 80, 24).await.unwrap();
    h.resize(200, 50).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    // Ueber remote::build statt eines rohen String-Literals -- jede
    // Kommandozeile fuer die entfernte Shell muss ausschliesslich
    // darueber entstehen (globale Randbedingung des Tasks).
    let r = t
        .exec(&remote::build(&[
            "tmux",
            "-L",
            &socket,
            "display",
            "-p",
            "-t",
            "ab_ff44aa",
            "#{window_width}",
        ]))
        .await
        .unwrap();
    assert_eq!(r.stdout.trim(), "200");
    h.close().await;
    c.kill_session(&t, "ab_ff44aa").await.unwrap();
}

/// Der wichtigste Test des Tasks (Spec V1/V2): oeffnet und schliesst viele
/// Kanaele; danach muss noch ein weiterer gehen.
///
/// `CYCLES = 20` statt zehn (Review-Befund, Minor):
/// `MaxSessions` auf der VM ist 10, zehn Zyklen feuern also nur, wenn
/// praktisch JEDER Kanal leckt. Ein Bug, der nur jeden zweiten Kanal
/// beeintraechtigt, wuerde bei zehn Zyklen fuenf Slots freigeben und der
/// Test bliebe gruen. Mit 20 Zyklen deckt selbst ein Leck bei jedem zweiten
/// Kanal (10 geleckte von 20) die volle `MaxSessions`-Grenze ab.
///
/// Nicht in jedem Zyklus eine NEUE Session anlegen und sofort danach
/// wieder killen: Das killt auch den
/// `tmux attach`-Prozess auf dem Server, der den SSH-Kanal traegt -- der
/// Server raeumt den Kanal serverseitig auf, WEIL der Prozess stirbt, nicht
/// weil unser Client `close()` gesendet hat. Ein `close()`, das durch ein
/// wirkungsloses `eof()`/No-Op ersetzt wird, waere dadurch nicht von einem
/// echten `close()` zu unterscheiden -- der Test bliebe in beiden Faellen
/// gruen (Gegenprobe). Deshalb hier: EINE Session bleibt ueber
/// alle Zyklen am Leben; nur der SSH-Kanal wird pro Zyklus geoeffnet und
/// wieder geschlossen. Erst danach wird die Session beendet.
#[tokio::test]
async fn closing_frees_the_channel_slot() {
    const CYCLES: u32 = 20;

    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("pty3");
    let c = TmuxClient::new(&socket);
    c.prepare_server(&t, 10000).await.unwrap();
    let name = "ab_leaktest01";
    c.create_session(&t, name, "/tmp").await.unwrap();

    for _ in 0..CYCLES {
        let h = t.open_attach(&socket, name, 80, 24).await.unwrap();
        h.close().await;
    }

    // Ein weiterer Kanal muss noch gehen -- sowohl ein exec- als auch ein
    // weiterer PTY-Kanal (beide sind SSH-"session"-Kanaele und teilen sich
    // denselben `MaxSessions`-Zaehler des sshd).
    //
    // Bewusst NICHT `.unwrap()` auf dem `exec`-Ergebnis (Review-Befund,
    // Minor): im Leckfall schlaegt bereits dieser Aufruf fehl, ein
    // `.unwrap()` wuerde den Test dort mit einer generischen Panic-Meldung
    // beenden -- BEVOR die zweite Pruefung (`open_attach`) je laeuft und
    // BEVOR die aussagekraeftige "Spec V2"-Meldung unten je erreicht wird.
    // Stattdessen beide Ergebnisse zuerst vollstaendig einsammeln (beide
    // Anfragen laufen so in jedem Fall durch), dann mit der
    // aussagekraeftigen Meldung asserten.
    let exec_outcome = t.exec(&remote::build(&["echo", "still_alive"])).await;
    let reattach_outcome = t.open_attach(&socket, name, 80, 24).await;

    match &exec_outcome {
        Ok(r) => assert_eq!(
            r.stdout.trim(),
            "still_alive",
            "Kanal-Slots wurden nicht freigegeben (Spec V2)"
        ),
        Err(e) => {
            panic!("Kanal-Slots wurden nicht freigegeben (Spec V2): exec fehlgeschlagen: {e:?}")
        }
    }

    match reattach_outcome {
        Ok(h) => h.close().await,
        Err(e) => panic!(
            "Kanal-Slots wurden nicht freigegeben (Spec V2): open_attach fehlgeschlagen: {e:?}"
        ),
    }

    c.kill_session(&t, name).await.unwrap();
}

/// B0, Gegenstueck zu `kill_session_does_not_hit_a_prefix_sibling`:
/// `open_attach` darf sich nicht an ein Praefixgeschwister haengen.
///
/// Zugesichert wird das ueber `#{session_attached}` des Geschwisters, NICHT
/// ueber das Ausbleiben von Ausgabe oder einen Fehler aus `open_attach`:
/// die Funktion startet den Befehl nur, tmux meldet den fehlenden Treffer
/// erst auf dem Kanal. Ein Test auf `is_err()` waere hier gruen, ohne
/// irgendetwas ueber das Ziel zu wissen.
///
/// Die Positivkontrolle am Ende ist Pflicht: ohne sie waere der Test auch
/// dann gruen, wenn die Sonde grundsaetzlich 0 liefert (falscher
/// Formatstring, falscher Socket) -- also genau dann, wenn er nichts misst.
#[tokio::test]
async fn open_attach_does_not_hit_a_prefix_sibling() {
    let Some(t) = common::connect_test_host().await else {
        return;
    };
    let socket = common::test_socket_for("b0attach");
    let c = TmuxClient::new(&socket);
    c.prepare_server(&t, 10000).await.unwrap();

    // `zz_b0attach` (ohne die 2) entsteht absichtlich NIE -- der Schaden
    // tritt nur bei "Ziel abwesend, Geschwister anwesend" auf.
    let sibling = "zz_b0attach2".to_string();
    c.create_session(&t, &sibling, "/tmp").await.unwrap();
    assert!(
        c.list_session_names(&t).await.unwrap().contains(&sibling),
        "Vorbedingung: das Praefixgeschwister muss existieren"
    );

    // Bewusst OHNE `=` -- an der VM gemessen (tmux 3.4): `display -t` nimmt
    // ein target-PANE, und dafuer wird das `=` nicht ausgewertet. Der Aufruf
    // meldet dann Exit 0 und druckt eine LEERE Zeile, statt zu scheitern.
    // Hier ist der Praefix ungefaehrlich: `zz_b0attach2` ist der einzige
    // Name auf diesem Socket, der so beginnt.
    async fn attached_count(t: &impl Transport, socket: &str, session: &str) -> u32 {
        let out = t
            .exec(&remote::build(&[
                "tmux",
                "-L",
                socket,
                "display",
                "-p",
                "-t",
                session,
                "#{session_attached}",
            ]))
            .await
            .unwrap();
        out.stdout
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("Sonde lieferte keine Zahl: {:?}", out.stdout))
    }

    let stray = t.open_attach(&socket, "zz_b0attach", 80, 24).await;
    let mut attached = 0;
    for _ in 0..6 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        attached = attached_count(&t, &socket, &sibling).await;
        if attached != 0 {
            break;
        }
    }
    assert_eq!(
        attached, 0,
        "attach auf das NICHT existierende `zz_b0attach` hat sich an \
         `zz_b0attach2` gehaengt -- das `=` im Ziel fehlt. Der Nutzer tippte \
         dann in die Sitzung eines fremden Projekts."
    );
    if let Ok(h) = stray {
        h.close().await;
    }

    // Positivkontrolle: dieselbe Sonde MUSS 1 sehen koennen.
    let real = t
        .open_attach(&socket, &sibling, 80, 24)
        .await
        .expect("attach auf den exakten Namen muss gehen");
    let mut seen = 0;
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        seen = attached_count(&t, &socket, &sibling).await;
        if seen == 1 {
            break;
        }
    }
    assert_eq!(
        seen, 1,
        "die Sonde hat einen echten Attach nicht gesehen -- sie misst nichts, \
         und die Assertion oben ist wertlos"
    );
    real.close().await;

    c.kill_session(&t, &sibling).await.unwrap();
}
