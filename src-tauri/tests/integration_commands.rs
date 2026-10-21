// Crate-Name `aidevbridge_lib` statt `aidevbridge` (siehe common/mod.rs).
use aidevbridge_lib::commands::{
    ack_output_impl, close_terminal_impl, connect_host_with_known_hosts, create_session_impl,
    disconnect_host_impl, kill_session_impl, list_sessions_impl, open_terminal_impl,
    open_terminal_tagged_impl, respond_host_key_impl, send_input_impl, AppState, HostKeyRequest,
    HostKeyRequestSink, HostSpecDto, OutputSink, SessionListItemDto, ACK_WINDOW_BYTES,
    STALL_TIMEOUT,
};
use aidevbridge_lib::remote;
use aidevbridge_lib::tmux::inventory::{PaneId, ServerIdentity, SessionId, WindowId};
use aidevbridge_lib::tmux::session_binding::PaneIdentity;
use aidevbridge_lib::tmux::TmuxClient;
use aidevbridge_lib::transport::Transport;
use common::{NeverAnswersSink, PanicIfAskedSink};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
mod common;

/// Pfad fuer Testverbindungen, die garantiert nie `append_entry` erreichen
/// (jeder Aufruf in dieser Datei ausser dem `Unknown`-Timeout-Test landet
/// im `Known`- oder `Mismatch`-Zweig von `TofuPolicy::decide` -- beide
/// ruehren `known_hosts_path` nie an). Existiert absichtlich nie und wird
/// nie angelegt -- fuer die Sonderregel dieses Tasks ("Tests duerfen
/// `~/.ssh/known_hosts` des Bedienrechners nicht veraendern") reicht das:
/// dieser Pfad hat mit der echten Datei nichts zu tun.
fn dummy_known_hosts_path() -> PathBuf {
    std::env::temp_dir().join("aidevbridge_integration_test_unused_known_hosts")
}

/// Produktions-nahe, aber KURZE Wartezeit fuer den `Unknown`-Zweig in
/// Tests -- die volle `HOST_KEY_PROMPT_TIMEOUT` (60s) wuerde
/// `connect_rejects_a_host_missing_from_known_hosts` (siehe unten) seit der
/// TOFU-Verdrahtung um eine volle Minute verlangsamen.
const TEST_PROMPT_TIMEOUT: Duration = Duration::from_millis(300);

fn dto() -> Option<HostSpecDto> {
    let host = common::spec()?;
    Some(HostSpecDto {
        hostname: host.hostname,
        port: host.port,
        user: host.user,
        key_path: dirs::home_dir().map(|h| h.join(".ssh/id_ed25519").display().to_string()),
        // M-B (Abschlussreview): die Testumgebung verwendet einen Schluessel
        // ohne Passphrase (Task-Vorgabe, siehe `common::key_auth_method`),
        // weder Passphrase noch Passwort sind hier gebraucht.
        passphrase: None,
        password: None,
    })
}

/// Sammelt zugestellte `OutputEvent`s ueber einen ungebundenen Kanal --
/// steht im Test fuer den WebView, ohne eine laufende Tauri-Anwendung zu
/// brauchen (siehe `OutputSink`-Doc-Kommentar in `commands.rs`).
#[derive(Clone)]
struct ChannelSink(mpsc::UnboundedSender<(String, Vec<u8>)>);

impl OutputSink for ChannelSink {
    fn send(&self, host_id: &str, session: &str, bytes: Vec<u8>) -> bool {
        self.0.send((format!("{host_id}:{session}"), bytes)).is_ok()
    }
}

#[tokio::test]
async fn connect_succeeds_with_the_real_hosts_actual_key() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .expect("Verbindung mit dem echten, per ssh-keyscan ermittelten Schluessel muss gelingen");
    assert!(state.has_host(&host_id).await);

    disconnect_host_impl(&state, host_id.clone()).await.unwrap();
    assert!(!state.has_host(&host_id).await);
}

/// Der wichtigste End-zu-Ende-Beleg fuer den TOFU-Nachtrag (Task 13): eine
/// echte, bislang unbekannte Verbindung zur realen Test-VM durchlaeuft den
/// GESAMTEN Produktionspfad -- `TofuPolicy::decide` stellt tatsaechlich eine
/// Rueckfrage waehrend des echten SSH-Handshakes, ein zweiter, unabhaengiger
/// `std::thread` antwortet ueber `respond_host_key_impl` (genau die Funktion
/// hinter dem `respond_host_key`-Command) WAEHREND `connect_host_with_known_
/// hosts` noch auf die Antwort wartet, und der akzeptierte, ECHTE Host-Key
/// landet ueber `append_entry` tatsaechlich in einer (temporaeren) Datei.
///
/// Ergaenzt die rein hermetischen `TofuPolicy`-Unit-Tests in
/// `src/commands.rs` (dort mit fabriziertem Schluesselmaterial) um den
/// Beleg, dass dieselbe Eigenschaft auch mit einem ECHTEN, per SSH-Handshake
/// praesentierten Schluessel und ueber die tatsaechliche `connect_host_with_
/// known_hosts`-Oberflaeche gilt -- nicht nur gegen die isolierte Policy.
#[tokio::test]
async fn connect_accepts_a_truly_unknown_real_host_key_after_an_explicit_accept_and_persists_it() {
    let Some(spec) = dto() else { return };
    let hostname = spec.hostname.clone();
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let known_hosts_path =
        std::env::temp_dir().join(format!("aidevbridge_test_accept_real_key_{nanos}"));
    assert!(!known_hosts_path.exists());

    struct ChannelSink(std::sync::mpsc::Sender<HostKeyRequest>);
    impl HostKeyRequestSink for ChannelSink {
        fn request(&self, req: &HostKeyRequest) -> bool {
            self.0.send(req.clone()).is_ok()
        }
    }

    let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
    let state_for_responder = state.clone();
    let expected_host = hostname.clone();
    let responder = std::thread::spawn(move || {
        let req = req_rx
            .recv()
            .expect("ein Host ohne known_hosts-Eintrag muss eine echte Rueckfrage ausloesen");
        assert_eq!(req.host, expected_host);
        assert_eq!(req.key_type, "ssh-ed25519");
        assert!(
            req.fingerprint.starts_with("SHA256:"),
            "Fingerabdruck muss im ssh-keygen-Format vorliegen: {}",
            req.fingerprint
        );
        respond_host_key_impl(&state_for_responder, req.request_id, true)
            .expect("respond_host_key muss die noch wartende Anfrage finden");
    });

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        String::new(), // keine known_hosts-Eintraege -> Unknown
        known_hosts_path.clone(),
        Arc::new(ChannelSink(req_tx)),
        Duration::from_secs(10),
    )
    .await
    .expect("ein expliziter Accept muss die Verbindung tatsaechlich zulassen");
    responder.join().expect("Antwort-Thread darf nicht paniken");

    assert!(state.has_host(&host_id).await);

    let persisted = std::fs::read_to_string(&known_hosts_path)
        .expect("ein akzeptierter Unknown-Schluessel muss known_hosts tatsaechlich anlegen");
    assert!(
        persisted.contains(&hostname),
        "known_hosts-Eintrag muss den Hostnamen enthalten: {persisted:?}"
    );
    assert!(
        persisted.contains("ssh-ed25519"),
        "known_hosts-Eintrag muss den Key-Typ enthalten: {persisted:?}"
    );

    disconnect_host_impl(&state, host_id.clone()).await.unwrap();
    assert!(!state.has_host(&host_id).await);
    let _ = std::fs::remove_file(&known_hosts_path);
}

/// Belegt Task 4/5s weitergereichte Randbedingung praktisch: ein Host ohne
/// known_hosts-Eintrag wird ohne Zustimmung abgelehnt (Spec §8.1), UND die
/// Meldung ist von einem generischen Verbindungsfehler unterscheidbar
/// (Task-14-Vorbereitung).
#[tokio::test]
async fn connect_rejects_a_host_missing_from_known_hosts() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));

    // Seit der TOFU-Verdrahtung (Task 13) ist "kein known_hosts-Eintrag"
    // der `Unknown`-Zweig: `TofuPolicy::decide` stellt eine Rueckfrage und
    // wartet bis zu `prompt_timeout`. `NeverAnswersSink` liefert die
    // Anfrage zu, antwortet aber nie -- der erwartete Ausgang (Ablehnung)
    // bleibt gleich, nur ueber den TOFU-Zeitablauf statt eine sofortige
    // Ablehnung. `TEST_PROMPT_TIMEOUT` (300ms) statt der vollen
    // Produktions-Wartezeit (60s), sonst waere dieser Test seit diesem Task
    // ploetzlich eine Minute langsamer.
    let err = connect_host_with_known_hosts(
        &state,
        spec,
        String::new(),
        dummy_known_hosts_path(),
        Arc::new(NeverAnswersSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .expect_err("ein Host ohne known_hosts-Eintrag darf NIEMALS automatisch akzeptiert werden");
    // Spec §10: der Zeitablauf hat einen eigenen Satz ("in time") und weiter
    // den Code `connect_timeout`, nicht den der abgelehnten Rueckfrage.
    assert_eq!(
        err, "The host key wasn't confirmed in time, so aidevbridge didn't connect.",
        "Eine unbeantwortete Rueckfrage muss den spezifischen TOFU-Zeitablauf melden: {err}"
    );
    assert!(
        !dummy_known_hosts_path().exists(),
        "ein per Zeitablauf abgelehnter Schluessel darf niemals persistiert werden"
    );
    // Diese Verbindung war der einzige Aufruf auf einem frischen `AppState`
    // -- waere sie trotzdem erfolgreich verbucht worden, stuende sie unter
    // "h0" (dem ersten von `next_host_id` vergebenen Wert).
    assert!(
        !state.has_host("h0").await,
        "eine abgelehnte Verbindung darf keinen Host-Eintrag hinterlassen"
    );
}

/// Gegenstueck: ein VORHANDENER, aber FALSCHER Eintrag ist ein Mismatch
/// (moeglicher MITM), keine blosse Unknown-Rueckfrage -- beide Faelle
/// muessen unterscheidbar bleiben (siehe `KnownHostsPolicy`s Doc-Kommentar).
#[tokio::test]
async fn connect_rejects_a_mismatched_key_with_a_distinct_message() {
    let Some(spec) = dto() else { return };
    let hostname = spec.hostname.clone();
    let port = spec.port;
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));

    let err = connect_host_with_known_hosts(
        &state,
        spec,
        common::wrong_key_same_host(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .expect_err("ein falscher, aber vorhandener Eintrag darf nicht akzeptiert werden");
    // Spec §10: "geaendert" statt "nicht bestaetigt", und der Host steht darin,
    // unter dem Namen, den `known_hosts` ihm gibt (Port 22: der Host selbst,
    // sonst `[host]:port`).
    let named = if port == 22 {
        hostname
    } else {
        format!("[{hostname}]:{port}")
    };
    assert!(
        err.starts_with(&format!("The host key of {named} has changed. ")),
        "Mismatch-Meldung muss sich von der Unknown-Meldung unterscheiden: {err}"
    );
    assert!(
        !err.contains("wasn't confirmed"),
        "Mismatch ist keine Unknown-Rueckfrage: {err}"
    );
}

/// Der zentrale End-zu-Ende-Test: verbindet, legt eine Session an, oeffnet
/// ein Terminal, schickt Eingabe, sieht sie im Ausgabestrom, schliesst
/// wieder -- alles ueber die `_impl`-Funktionen, die auch die
/// `#[tauri::command]`-Huellen aufrufen.
#[tokio::test]
async fn full_round_trip_connect_create_open_write_echo_close() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));
    let socket = common::test_socket(); // derselbe Socket wie im AppState oben

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();
    assert!(session.starts_with("ab_"));

    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    let sink = ChannelSink(tx);
    open_terminal_impl(&state, sink, host_id.clone(), session.clone(), 80, 24)
        .await
        .unwrap();
    assert!(state.has_terminal(&host_id, &session).await);

    // Der Attach-Strom beginnt mit einem absoluten Repaint (Spec V7) --
    // erste paar Ereignisse einsammeln.
    let mut collected = Vec::new();
    for _ in 0..5 {
        match tokio::time::timeout(std::time::Duration::from_millis(800), rx.recv()).await {
            Ok(Some((sess, bytes))) => {
                assert_eq!(
                    sess,
                    format!("{host_id}:{session}"),
                    "Event-Schluessel (host_id:session) muss stimmen"
                );
                collected.extend_from_slice(&bytes);
            }
            _ => break,
        }
    }
    let s = String::from_utf8_lossy(&collected);
    assert!(
        s.contains("\x1b[H") && s.contains("\x1b[2J"),
        "erwartet absoluten Repaint ueber den Event-Pfad, bekam: {s:?}"
    );

    // Bytes hin -- ueber send_input_impl, wie der Command es taete.
    send_input_impl(
        &state,
        host_id.clone(),
        session.clone(),
        b"echo CMD_MARKER_XYZ\n".to_vec(),
    )
    .await
    .unwrap();

    // ... und wieder zurueck ueber denselben Event-Pfad. Jedes empfangene
    // Ereignis wird sofort per ack_output_impl bestaetigt (wie es Task 11s
    // Frontend spaeter tun soll) -- ohne das wuerde die Bremse nach 1 MiB
    // greifen, siehe die eigene Bremse-Probe unten.
    let mut seen = String::new();
    for _ in 0..40 {
        if let Ok(Some((_, bytes))) =
            tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await
        {
            ack_output_impl(&state, host_id.clone(), session.clone(), bytes.len() as u32)
                .await
                .unwrap();
            seen.push_str(&String::from_utf8_lossy(&bytes));
            if seen.contains("CMD_MARKER_XYZ") {
                break;
            }
        }
    }
    assert!(
        seen.contains("CMD_MARKER_XYZ"),
        "Eingabe kam nicht im Pane an"
    );

    close_terminal_impl(&state, host_id.clone(), session.clone())
        .await
        .unwrap();
    assert!(!state.has_terminal(&host_id, &session).await);

    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    TmuxClient::new(&socket)
        .kill_session(&t, &session)
        .await
        .unwrap();

    disconnect_host_impl(&state, host_id.clone()).await.unwrap();
    assert!(!state.has_host(&host_id).await);
}

/// Belegt, dass die Ack-Bremse tatsaechlich bremst (Kernanforderung des
/// Tasks): eine Flut ungeackter Ausgabe stoppt den Ereignisstrom lange vor
/// den vollen 2 MB, die der Server erzeugt.
///
/// Beweist NICHT, dass der volle Rueckstau nach `ack_output` 1:1 nachfliesst
/// -- eine erste Fassung dieses Tests nahm das an und schlug fehl. Befund
/// (per `pane_current_command`/`pgrep` auf einer zweiten Verbindung
/// nachgewiesen): der erzeugende Prozess (`yes | head -c
/// 2000000`) war zum Stall-Zeitpunkt LAENGST fertig (Pane zeigte wieder
/// `bash`), tmux liefert einem zurueckgefallenen Client aber offenbar NICHT
/// den vollen Rohbytestrom nach, sondern haelt nur den fuer den aktuellen
/// Bildschirmzustand noetigen Ausschnitt vor -- ein Terminal-Multiplexer ist
/// kein dummes Byte-Rohr. Der eigentliche Beweis fuer "die Bremse wurde nach
/// dem Ack wieder geloest" ist deshalb: frische, NEUE Eingabe nach dem Ack
/// erzeugt frische Ausgabe, die ankommt -- das ist die vom Task geforderte
/// Eigenschaft ("bremst, entwertet sich aber nicht selbst dauerhaft"), ohne
/// eine Annahme ueber tmux' interne Pufferstrategie fuer haengengebliebene
/// Clients zu treffen.
#[tokio::test]
async fn ack_backpressure_actually_stalls_and_then_resumes() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();
    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    let sink = ChannelSink(tx);
    open_terminal_impl(&state, sink, host_id.clone(), session.clone(), 80, 24)
        .await
        .unwrap();

    // Repaint-Ereignisse verwerfen (NICHT geackt -- das gehoert zum
    // Testaufbau: die Bremse muss trotzdem greifen, ein paar hundert
    // ungeackte Repaint-Bytes duerfen das Fenster nicht schon vorher
    // erschoepfen).
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    while rx.try_recv().is_ok() {}

    // Flut, die den Server weit mehr als das Ack-Fenster erzeugen laesst.
    // Befund 4 (Review, Minor): sowohl die Flutgroesse als auch der
    // Erwartungswert unten haengen an `ACK_WINDOW_BYTES` statt an festen
    // Zahlen -- aendert sich das Fenster, prueft dieser Test automatisch
    // wieder dieselbe Eigenschaft, statt stillschweigend etwas anderes zu
    // pruefen als gemeint.
    //
    // `* 2` (nicht `* 4`): eine erste Fassung
    // nutzte `4 * ACK_WINDOW_BYTES` -- non-vakuos (die Grenze unten liegt
    // echt unter der Flutgroesse), aber empirisch gegen die VM lief sie in
    // eine ANDERE Falle (kein Fehler der Bremse, ein Fehler dieses Tests):
    // die Bremse stoppte diesmal tatsaechlich an ihrer echten Kapazitaet
    // (~1.047.500 von 1.048.576 Bytes durch, nicht wie im urspruenglichen
    // Test durch tmux' "kein voller Replay fuer einen abgehaengten Client"-
    // Verhalten begrenzt), wodurch NACH dem Ack noch >3 MB echter
    // Nachzuegler-Rueckstand in kleinen ~2-KB-Haeppchen nachfliessen musste,
    // bevor der frische Marker ueberhaupt drankam -- 40 Runden reichten
    // dafuer nicht (Diagnose-Log: 40 Chunks / 78 KB
    // durchgekommen, Marker noch nicht erreicht). `* 2` haelt sich naeher an
    // die im urspruenglichen Test empirisch bewaehrte Grössenordnung
    // (2.000.000 gegen ein 1-MiB-Fenster), bleibt aber trotzdem non-vakuos:
    // die Grenze unten (`ACK_WINDOW_BYTES + ACK_WINDOW_BYTES / 2`) liegt
    // echt unter der Flutgroesse `ACK_WINDOW_BYTES * 2`.
    let flood_bytes = ACK_WINDOW_BYTES * 2;
    send_input_impl(
        &state,
        host_id.clone(),
        session.clone(),
        format!(
            "yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA | head -c {flood_bytes}\n"
        )
        .into_bytes(),
    )
    .await
    .unwrap();

    // Einsammeln, bis fuer eine ganze Sekunde nichts mehr ankommt.
    let mut total: u64 = 0;
    let collect_start = std::time::Instant::now();
    while let Ok(Some((_, bytes))) =
        tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
    {
        total += bytes.len() as u64;
    }
    eprintln!(
        "[diag] collected {total} bytes over {:?} before a 1s silence (server produced {flood_bytes}, ACK_WINDOW_BYTES={ACK_WINDOW_BYTES})",
        collect_start.elapsed()
    );
    let expected_ceiling = ACK_WINDOW_BYTES + ACK_WINDOW_BYTES / 2;
    assert!(
        total < expected_ceiling,
        "ohne zu acken haette die Bremse (Fenster = {ACK_WINDOW_BYTES} Bytes) den Strom lange \
         vor den erzeugten {flood_bytes} Bytes stoppen muessen (Erwartung: unter \
         {expected_ceiling} Bytes), tatsaechlich angekommen: {total} Bytes"
    );
    assert!(total > 0, "es sollte ueberhaupt etwas angekommen sein");

    // Alles Empfangene acken -- gibt zumindest das reservierte Fenster
    // wieder frei.
    ack_output_impl(&state, host_id.clone(), session.clone(), total as u32)
        .await
        .unwrap();

    // Entscheidender Beweis: NEUE Eingabe nach dem Ack muss durchkommen --
    // die Bremse darf sich nicht selbst dauerhaft blockiert haben.
    send_input_impl(
        &state,
        host_id.clone(),
        session.clone(),
        b"echo FRESH_AFTER_ACK\n".to_vec(),
    )
    .await
    .unwrap();
    // Weiter acken, waehrend gesammelt wird (wie es Task 11s Frontend
    // tun soll, siehe `ack_output_impl`s Doc-Kommentar) -- nicht nur der
    // eine Sammel-Ack oben. Auch bei der jetzigen Flutgroesse
    // (`2 * ACK_WINDOW_BYTES`) kann nach dem ersten Ack noch Nachzuegler-
    // Material folgen, bevor der frische Marker erscheint -- ein einzelner
    // Ack wuerde das Fenster dann erneut fuellen und die Pumpaufgabe
    // erneut blockieren, ohne dass das ein Fehler der Bremse waere.
    let mut fresh_seen = String::new();
    let mut stop_reason = "ran out of iterations";
    for _ in 0..40 {
        match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
            Ok(Some((_, bytes))) => {
                ack_output_impl(&state, host_id.clone(), session.clone(), bytes.len() as u32)
                    .await
                    .unwrap();
                fresh_seen.push_str(&String::from_utf8_lossy(&bytes));
                if fresh_seen.contains("FRESH_AFTER_ACK") {
                    stop_reason = "found marker";
                    break;
                }
            }
            Ok(None) => {
                stop_reason = "channel closed (rx.recv() returned None)";
                break;
            }
            Err(_) => {
                stop_reason = "500ms timeout with no new chunk";
                break;
            }
        }
    }
    assert!(
        fresh_seen.contains("FRESH_AFTER_ACK"),
        "nach ack_output darf die Bremse frische Ausgabe nicht laenger blockieren \
         (Abbruchgrund: {stop_reason})"
    );

    // Aufraeumen: weiterlesen und acken, bis nichts mehr kommt, dann
    // Session/Verbindung schliessen.
    let mut idle_rounds = 0;
    while idle_rounds < 3 {
        match tokio::time::timeout(std::time::Duration::from_millis(800), rx.recv()).await {
            Ok(Some((_, bytes))) => {
                ack_output_impl(&state, host_id.clone(), session.clone(), bytes.len() as u32)
                    .await
                    .ok();
                idle_rounds = 0;
            }
            _ => idle_rounds += 1,
        }
    }

    close_terminal_impl(&state, host_id.clone(), session.clone())
        .await
        .unwrap();
    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    TmuxClient::new(&common::test_socket())
        .kill_session(&t, &session)
        .await
        .unwrap();
    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Befund 1 (Review, Critical): `open_terminal_impl` ueberschrieb den
/// Map-Eintrag bislang per `HashMap::insert`, ohne den VERDRAENGTEN
/// `PtyHandle` zu schliessen. Ruft der WebView `open_terminal` zweimal fuer
/// denselben `(host_id, session)`-Schluessel ohne ein dazwischenliegendes
/// `close_terminal` (z. B. ein erneuter Verbindungsaufbau nach einem
/// Netzwerk-Hickup, der den alten Slot fuer immer offen liess), blieb der
/// alte SSH-Kanal offen -- ein von `MaxSessions = 10` dauerhaft verlorener
/// Slot.
///
/// Beweis: jeder `open_terminal`-Aufruf startet server-seitig einen neuen
/// `tmux attach`-Prozess, der zu einem tmux-KLIENTEN wird
/// (`#{session_attached}` zaehlt die an die Session angehaengten Klienten).
/// Schliesst der zweite Aufruf den ersten Kanal wirklich, sendet SSH ein
/// Channel-Close, das den ersten `tmux attach`-Prozess server-seitig
/// abhaengt (Hangup) -- `#{session_attached}` faellt auf 1 zurueck. Bleibt
/// der erste Kanal offen (der Bug), bleiben BEIDE Prozesse angehaengt,
/// `#{session_attached}` zeigt 2.
#[tokio::test]
async fn open_terminal_twice_for_the_same_key_closes_the_first_channel_instead_of_leaking_it() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));
    let socket = common::test_socket();

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();
    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();

    let (tx1, _rx1) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    open_terminal_impl(
        &state,
        ChannelSink(tx1),
        host_id.clone(),
        session.clone(),
        80,
        24,
    )
    .await
    .unwrap();

    // Kurz warten, bis der erste `tmux attach`-Prozess server-seitig
    // tatsaechlich als angehaengter Klient sichtbar ist, bevor der zweite
    // Aufruf ihn verdraengt.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let (tx2, _rx2) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    open_terminal_impl(
        &state,
        ChannelSink(tx2),
        host_id.clone(),
        session.clone(),
        80,
        24,
    )
    .await
    .unwrap();
    assert!(state.has_terminal(&host_id, &session).await);

    let t = common::connect_test_host()
        .await
        .expect("zweite Verbindung fuer die Klienten-Zaehlung");

    // Kurz pollen statt eines einzelnen festen Schlafs: bei korrektem Fix
    // braucht das Hangup des ersten Kanals etwas Zeit, um server-seitig
    // anzukommen. Ohne den Fix bleibt der Wert dauerhaft bei 2 -- die
    // Gegenprobe blieb deshalb trotzdem zuverlaessig rot.
    let mut attached: u32 = u32::MAX;
    for _ in 0..5 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let out = t
            .exec(&remote::build(&[
                "tmux",
                "-L",
                socket.as_str(),
                "display",
                "-p",
                "-t",
                &session,
                "#{session_attached}",
            ]))
            .await
            .unwrap();
        attached = out.stdout.trim().parse().expect("erwartet eine Ganzzahl");
        if attached == 1 {
            break;
        }
    }
    assert_eq!(
        attached, 1,
        "genau EIN tmux-Klient (der zweite `open_terminal`-Aufruf) haette angehaengt bleiben \
         duerfen -- der erste haette per Kanal-Close abgehaengt werden muessen (Spec V2), \
         zuletzt gemessen: {attached}"
    );

    close_terminal_impl(&state, host_id.clone(), session.clone())
        .await
        .unwrap();
    TmuxClient::new(&socket)
        .kill_session(&t, &session)
        .await
        .unwrap();
    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Befund 2 (Review, Important): blockiert die Pumpaufgabe in
/// `AckGate::wait_for_room` (viel ungeackte Ausgabe -- "Tab schliessen,
/// waehrend der Agent gerade flutet"), und wird in diesem Moment
/// `close_terminal` gerufen, entfernte das bisher den Map-Eintrag, ohne die
/// Pumpaufgabe zu wecken: `wait_for_room` wartet auf einen `ack()`, der fuer
/// eine bereits abgeraeumte Session nie wieder kommt -- die Pumpaufgabe (und
/// ihre `Arc`-Referenzen auf `AppState`/`AckGate`/`OutputSink`) leckt fuer
/// den Rest der Prozesslaufzeit.
///
/// Beweisidee: die Pumpaufgabe haelt `sink` (und damit den letzten lebenden
/// Klon von `tx`) als exklusiven Besitzer -- sie kann `sink` nur droppen,
/// wenn ihr Future vollstaendig durchlaeuft, d. h. wenn die Aufgabe
/// TATSAECHLICH endet. Ohne ein Abbruchsignal waere sie fuer immer in
/// `wait_for_room` gefangen, `tx` wuerde NIE droppen, und `rx.recv()` unten
/// wuerde nie `None` liefern (Timeout). `yes` OHNE `head -c`: erzeugt
/// endlos Ausgabe, damit die Pumpaufgabe garantiert an der Ack-Bremse
/// haengt und nicht etwa an einem leergelaufenen PTY-Kanal (siehe
/// Debugging-Fund zu `ack_backpressure_actually_stalls_and_then_resumes`:
/// ein einzelner, endlicher Burst kann versiegen, WEIL tmux einem
/// zurueckgefallenen Client nicht den vollen Rohbytestrom nachliefert --
/// nicht weil das Ack-Fenster zu ist. Mit endloser Ausgabe steht das nicht
/// zur Debatte).
///
/// Die eigentliche Trennschaerfe fuer Befund 2 liefern die hermetischen
/// Unit-Tests `wait_for_room_cancel_or_stall_*` in `src/commands.rs` (sie
/// pruefen exakt die Funktion, die der Pump-Loop aufruft, ohne von tmux'
/// Pufferverhalten abzuhaengen). Dieser Test hier belegt zusaetzlich, dass
/// die komplette Verdrahtung (`open_terminal_impl` -> Pumpaufgabe ->
/// `close_terminal_impl` -> `close_entry`) gegen die echte VM tatsaechlich
/// nicht haengt.
#[tokio::test]
async fn closing_a_terminal_while_the_pump_task_is_blocked_on_the_ack_gate_unblocks_it_instead_of_leaking_it(
) {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));
    let socket = common::test_socket();

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();
    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    let sink = ChannelSink(tx);
    open_terminal_impl(&state, sink, host_id.clone(), session.clone(), 80, 24)
        .await
        .unwrap();

    // Repaint verwerfen, NICHT acken -- wie bei der Ack-Bremse-Probe oben.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    while rx.try_recv().is_ok() {}

    // Endlose Ausgabe erzeugen (kein `head -c`): haelt sicher, dass immer
    // mehr Daten bereitstehen, damit die Pumpaufgabe zuverlaessig an der
    // Ack-Bremse haengt, nicht an einem leeren PTY-Kanal.
    send_input_impl(
        &state,
        host_id.clone(),
        session.clone(),
        b"yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n".to_vec(),
    )
    .await
    .unwrap();

    // Einsammeln (NICHT acken), bis das Ack-Fenster sicher erschoepft ist
    // und die Pumpaufgabe blockiert: eine ganze Sekunde ohne neue Ereignisse
    // -- bei endloser Quelle kann das nur an der Bremse liegen.
    while let Ok(Some(_)) = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
    {
    }

    // "Tab schliessen", waehrend die Pumpaufgabe blockiert ist.
    close_terminal_impl(&state, host_id.clone(), session.clone())
        .await
        .unwrap();
    assert!(!state.has_terminal(&host_id, &session).await);

    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await;
    assert!(
        matches!(ended, Ok(None)),
        "die blockierte Pumpaufgabe haette nach close_terminal enden (und damit `sink`/`tx` \
         droppen) muessen, stattdessen: {ended:?}"
    );

    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    TmuxClient::new(&socket)
        .kill_session(&t, &session)
        .await
        .unwrap();
    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Ergaenzung zu Befund 2, ueber `disconnect_host_impl` statt
/// `close_terminal_impl` -- derselbe Fund ("Prüfe, ob es weitere Stellen
/// gibt ... und behandle sie gleich") verlangt auch hierfuer einen Beleg,
/// nicht nur dieselbe Korrektur ungeprueft mitzuziehen.
///
/// `disconnect_host_impl` hatte ZUSAETZLICH zwei eigene Lock-Probleme
/// (Review-Hinweis waehrend der Umsetzung) desselben Musters:
/// sowohl `if let Some(entry) = state.terminals.lock().await.remove(&key)
/// { ... }` als auch (erst spaeter aufgefallen -- Task 10,
/// "uebersehener Fehler", siehe `lib.rs`) `if let Some(transport) =
/// state.hosts.lock().await.remove(&host_id) { ... }` halten in Edition
/// 2021 den `MutexGuard` aus dem `if let`-Scrutinee bis zum Ende des
/// Blocks -- also ueber `close_entry(entry).await` bzw.
/// `transport.dispose().await` hinweg. Waehrend dieser Zeit ist die
/// GESAMTE jeweilige Sperre blockiert: jede andere Terminal-Operation (bei
/// `terminals`) bzw. JEDE Host-Operation (bei `hosts`, auf JEDEM Host, nicht
/// nur dem gerade getrennten) muesste warten, bis der Kanal-Close bzw. das
/// `dispose()` durchgelaufen ist -- im pathologischen Fall (haengender
/// Netzwerk-Close) ein unbegrenztes Blockieren der gesamten Anwendung, nicht
/// nur der einen Session/des einen Hosts. Erst binden (`let entry = ...`,
/// Guard faellt am `;`), DANN `if let`, behebt beide.
///
/// Heute sind `state.hosts` und `state.terminals` `std::sync::Mutex`, und
/// `disconnect_host_impl` gibt beide Sperren frei, bevor es auf `dispose()`
/// wartet. Dieser Test wickelt `disconnect_host_impl` in ein Timeout: haengt
/// es (oder haengt die geweckte Pumpaufgabe beim Versuch, dieselbe Sperre
/// fuer ihr eigenes Aufraeumen zu bekommen), schlaegt dieser Test statt
/// eines spaeteren, schwerer zuzuordnenden Timeouts fehl.
#[tokio::test]
async fn disconnecting_a_host_while_the_pump_task_is_blocked_on_the_ack_gate_unblocks_it_instead_of_leaking_it(
) {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));
    let socket = common::test_socket();

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();
    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    let sink = ChannelSink(tx);
    open_terminal_impl(&state, sink, host_id.clone(), session.clone(), 80, 24)
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    while rx.try_recv().is_ok() {}

    send_input_impl(
        &state,
        host_id.clone(),
        session.clone(),
        b"yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n".to_vec(),
    )
    .await
    .unwrap();

    while let Ok(Some(_)) = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
    {
    }

    // Host trennen (z. B. Anwendung entfernt den Host / Nutzer klickt
    // "trennen"), waehrend die Pumpaufgabe blockiert ist -- ueber
    // `disconnect_host_impl`s EIGENE Lock-Disziplin, nicht ueber
    // `close_terminal_impl`s.
    let disconnect_result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        disconnect_host_impl(&state, host_id.clone()),
    )
    .await;
    assert!(
        disconnect_result.is_ok(),
        "disconnect_host_impl haette nicht selbst haengen bleiben duerfen, stattdessen: \
         {disconnect_result:?}"
    );
    disconnect_result.unwrap().unwrap();
    assert!(!state.has_terminal(&host_id, &session).await);
    assert!(!state.has_host(&host_id).await);

    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await;
    assert!(
        matches!(ended, Ok(None)),
        "die blockierte Pumpaufgabe haette nach disconnect_host enden (und damit `sink`/`tx` \
         droppen) muessen, stattdessen: {ended:?}"
    );

    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    TmuxClient::new(&socket)
        .kill_session(&t, &session)
        .await
        .unwrap();
}

// --- M-C (Abschlussreview): terminal://connection-lost ---
//
// `RecordingSink` sammelt BEIDE Ereignisarten (`send`/`connection_lost`)
// ueber je einen eigenen Kanal -- absichtlich derselbe Sink-Typ fuer alle
// Tests unten (Review-Nachtrag): ein Test, der "kein
// `connection_lost`" mit einem Sink prueft, der das Ereignis physisch gar
// nicht aufzeichnen KANN, wuerde vakuos gruen bleiben. Der positive Test
// (externes Kill) belegt zuerst, dass der Rekorder tatsaechlich funktioniert
// -- erst danach beweisen die beiden negativen Tests mit GENAU DEMSELBEN
// Rekorder etwas.
//
// `sent` (Waechter-Task): der Stillstandstest muss wissen, WANN der
// Bytestrom versiegt ist -- vorher steht die Pumpaufgabe noch nicht. Die
// bestehenden M-C-Tests ignorieren diesen Kanal, verlieren aber nichts.
struct RecordingSink {
    lost: mpsc::UnboundedSender<(String, String)>,
    sent: mpsc::UnboundedSender<usize>,
}
impl OutputSink for RecordingSink {
    fn send(&self, _host_id: &str, _session: &str, bytes: Vec<u8>) -> bool {
        let _ = self.sent.send(bytes.len());
        true
    }
    fn connection_lost(&self, host_id: &str, session: &str) {
        let _ = self.lost.send((host_id.to_string(), session.to_string()));
    }
}

/// Verbindet, legt eine Session an und oeffnet ein Terminal mit einem
/// `RecordingSink` -- gemeinsamer Aufbau fuer alle Tests unten. `suffix`
/// waehlt fuer Tests mit Sessionliste einen eigenen Testsocket. Der Socket
/// wird erst nach `dto()` gelesen: ohne Testhost bleibt es ein SKIP.
async fn connect_create_and_open_with_recording_sink(
    suffix: Option<&str>,
) -> Option<(
    Arc<AppState>,
    String,
    String,
    mpsc::UnboundedReceiver<(String, String)>,
    mpsc::UnboundedReceiver<usize>,
)> {
    let spec = dto()?;
    let socket = suffix.map_or_else(common::test_socket, common::test_socket_for);
    let state = Arc::new(AppState::with_default_socket(socket));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();

    let (lost_tx, lost_rx) = mpsc::unbounded_channel::<(String, String)>();
    let (sent_tx, sent_rx) = mpsc::unbounded_channel::<usize>();
    open_terminal_impl(
        &state,
        RecordingSink {
            lost: lost_tx,
            sent: sent_tx,
        },
        host_id.clone(),
        session.clone(),
        80,
        24,
    )
    .await
    .unwrap();
    assert!(state.has_terminal(&host_id, &session).await);

    Some((state, host_id, session, lost_rx, sent_rx))
}

/// Wartet bis zu `timeout` auf ein WEITERES `connection_lost`-Ereignis und
/// schlaegt fehl, wenn eines ankommt.
///
/// Bewusst KEIN blosses `timeout(..., lost_rx.recv()).await.is_err()`
/// (Review-Nachtrag, per echtem Testlauf gegen die VM gefunden, nicht
/// geraten -- eine erste Fassung aller drei Tests unten scheiterte damit
/// AUSNAHMSLOS, auch der positive Fall): sobald die Pumpaufgabe endet, faellt
/// ihr `RecordingSink` aus dem Scope und dropt den einzigen
/// `UnboundedSender` dieses Kanals -- `lost_rx.recv()` liefert dann SOFORT
/// `Ok(None)` (Kanal geschlossen, keine Nachricht mehr), nicht
/// `Err(Elapsed)`. `.is_err()` haette das mit "es kam KEIN Ereignis
/// innerhalb der Frist" verwechselt, obwohl beide FAELLE (Kanal sauber
/// geschlossen, ODER echtes Zeitlimit erreicht waehrend die Pumpaufgabe noch
/// laeuft) unauffaellig sind -- nur `Ok(Some(_))` ist ein tatsaechlicher
/// zweiter/unerwuenschter Fund.
async fn assert_no_further_connection_lost_event(
    lost_rx: &mut mpsc::UnboundedReceiver<(String, String)>,
    timeout: std::time::Duration,
    context: &str,
) {
    if let Ok(Some(event)) = tokio::time::timeout(timeout, lost_rx.recv()).await {
        panic!("{context}: unerwartetes connection_lost-Ereignis {event:?}");
    }
}

/// Der positive Fall: die tmux-Session wird von einer ZWEITEN, von dieser
/// Anwendung unabhaengigen Verbindung aus beendet (`kill-session`) -- ohne
/// `close_terminal`/`disconnect_host` dieser Anwendung je aufzurufen. Das
/// ist funktional dieselbe Situation wie ein hart gekappter SSH-Kanal: die
/// Pumpaufgabe endet von sich aus, `owns_current_entry` ist wahr, weil sie
/// noch niemand sonst abgeraeumt hat. Belegt gleichzeitig, dass der
/// `RecordingSink` selbst funktioniert -- Voraussetzung dafuer, dass die
/// beiden negativen Tests unten ETWAS beweisen (siehe Kommentar an
/// `RecordingSink`).
#[tokio::test]
async fn an_externally_killed_session_emits_exactly_one_connection_lost_event() {
    let Some((state, host_id, session, mut lost_rx, _sent_rx)) =
        connect_create_and_open_with_recording_sink(None).await
    else {
        return;
    };

    let t2 = common::connect_test_host()
        .await
        .expect("zweite, unabhaengige Verbindung fuer das externe Kill");
    TmuxClient::new(&common::test_socket()) // derselbe Socket wie beim Anlegen; der Produktionsdefault ist gepinnt in production_default_socket_is_agentbridge
        .kill_session(&t2, &session)
        .await
        .unwrap();
    t2.dispose().await;

    let received = tokio::time::timeout(std::time::Duration::from_secs(10), lost_rx.recv())
        .await
        .expect("connection_lost kam nicht innerhalb von 10s an")
        .expect("Kanal wurde geschlossen, bevor ein Ereignis ankam");
    assert_eq!(received, (host_id.clone(), session.clone()));

    // Kein zweites Ereignis -- die Pumpaufgabe raeumt genau einmal auf.
    assert_no_further_connection_lost_event(
        &mut lost_rx,
        std::time::Duration::from_millis(300),
        "es darf nur GENAU EIN connection_lost-Ereignis pro Terminal geben",
    )
    .await;
    assert!(!state.has_terminal(&host_id, &session).await);

    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Negativer Fall 1: ein GEWOLLTES Schliessen ueber `close_terminal_impl`
/// (Ctrl+Shift+W-Pendant, `terminalDisconnect`-Knopf-Pendant im Backend)
/// darf NIEMALS ein `connection_lost`-Ereignis erzeugen -- sonst erschiene
/// "Verbindung verloren" nach jedem normalen Schliessen.
/// Derselbe `RecordingSink`-Typ wie im positiven Test oben.
#[tokio::test]
async fn closing_a_terminal_deliberately_emits_no_connection_lost_event() {
    let Some((state, host_id, session, mut lost_rx, _sent_rx)) =
        connect_create_and_open_with_recording_sink(None).await
    else {
        return;
    };

    close_terminal_impl(&state, host_id.clone(), session.clone())
        .await
        .unwrap();
    assert!(!state.has_terminal(&host_id, &session).await);

    assert_no_further_connection_lost_event(
        &mut lost_rx,
        std::time::Duration::from_secs(2),
        "close_terminal_impl (gewolltes Schliessen) darf kein connection_lost ausloesen",
    )
    .await;

    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    TmuxClient::new(&common::test_socket()) // derselbe Socket wie beim Anlegen; der Produktionsdefault ist gepinnt in production_default_socket_is_agentbridge
        .kill_session(&t, &session)
        .await
        .unwrap();
    t.dispose().await;
    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Negativer Fall 2: `disconnect_host_impl` (der "Disconnect"-Knopf) raeumt
/// alle Terminals eines Hosts UND die Verbindung selbst ab -- ebenfalls
/// GEWOLLT, ebenfalls ohne `connection_lost`.
#[tokio::test]
async fn disconnecting_a_host_deliberately_emits_no_connection_lost_event() {
    let Some((state, host_id, session, mut lost_rx, _sent_rx)) =
        connect_create_and_open_with_recording_sink(None).await
    else {
        return;
    };

    disconnect_host_impl(&state, host_id.clone()).await.unwrap();
    assert!(!state.has_terminal(&host_id, &session).await);
    assert!(!state.has_host(&host_id).await);

    assert_no_further_connection_lost_event(
        &mut lost_rx,
        std::time::Duration::from_secs(2),
        "disconnect_host_impl (gewolltes Trennen) darf kein connection_lost ausloesen",
    )
    .await;

    // Aufraeumen: die Session selbst lebt auf der VM weiter (disconnect_host
    // schliesst nur die lokale Verbindung, nicht die entfernte tmux-Session)
    // -- ueber eine frische Verbindung entfernen, damit nichts Eigenes
    // zurueckbleibt.
    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    TmuxClient::new(&common::test_socket()) // derselbe Socket wie beim Anlegen; der Produktionsdefault ist gepinnt in production_default_socket_is_agentbridge
        .kill_session(&t, &session)
        .await
        .unwrap();
    t.dispose().await;
}

/// Der Waechter (Design §2, empirisch belegt in §2.2): eine Session, deren
/// Ausgabe niemand bestaetigt, darf nicht die GANZE Host-Verbindung
/// unbenutzbar machen.
///
/// Vor dem Fix gemessen: `create_session` gelang auf der gesunden
/// Verbindung in 357 ms; nach 1.047.425 ungeackten Bytes (Fenster
/// 1.048.576) lief derselbe Aufruf in einen 20-Sekunden-Timeout. Ursache
/// ist russhs EINZIGER Dispatch-Loop je Verbindung: die Pumpaufgabe haengt,
/// der `mpsc::channel(64)` aus `open_attach` laeuft voll, die Leseaufgabe
/// ruft `read.wait()` nicht mehr, und damit steht die ganze Verbindung.
///
/// ZWEI Zusicherungen, weil die erste allein nicht genuegt: dass die
/// Verbindung wieder benutzbar ist, waere auch dann wahr, wenn der Waechter
/// den Eintrag abraeumt, ohne den Nutzer zu informieren -- das Terminal
/// waere still tot. Die zweite Zusicherung verlangt die Meldung.
///
/// Laufzeit: rund `STALL_TIMEOUT` + Verbindungsaufbau, also etwa 35 s. Das
/// ist der Preis dafuer, den Produktionswert zu pruefen statt einen
/// injizierten Testwert; die Pro-Aufruf-Semantik selbst ist in
/// `commands.rs`s Unit-Tests schnell abgedeckt.
#[tokio::test]
async fn a_stalled_session_does_not_take_the_whole_connection_down() {
    let Some((state, host_id, session, mut lost_rx, mut sent_rx)) =
        connect_create_and_open_with_recording_sink(None).await
    else {
        return;
    };

    // Repaint-Ereignisse abziehen (nicht geackt -- das gehoert zum Aufbau).
    tokio::time::sleep(Duration::from_millis(300)).await;
    while sent_rx.try_recv().is_ok() {}

    // Kontrolle: die Verbindung ist JETZT gesund. Ohne diese Messung
    // koennte der Test unten auch bei einer von Anfang an kaputten
    // Verbindung "gruen" aussehen.
    let control = tokio::time::timeout(
        Duration::from_secs(20),
        create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None),
    )
    .await
    .expect("Kontrolle: create_session darf auf einer gesunden Verbindung nicht haengen")
    .expect("Kontrolle: create_session muss gelingen");

    // Flut, die das Ack-Fenster weit ueberschreitet. Niemand ackt -- genau
    // der Zustand einer abgehaengten Ansicht.
    let flood_bytes = ACK_WINDOW_BYTES * 4;
    send_input_impl(
        &state,
        host_id.clone(),
        session.clone(),
        format!(
            "yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA | head -c {flood_bytes}\n"
        )
        .into_bytes(),
    )
    .await
    .expect("send_input muss gelingen");

    // Sammeln bis Stille -- danach steht die Pumpaufgabe im Kreditwarten.
    let mut total: u64 = 0;
    while let Ok(Some(len)) = tokio::time::timeout(Duration::from_secs(2), sent_rx.recv()).await {
        total += len as u64;
    }
    // Der Grund fuer die Stille MUSS das geschlossene Ack-Fenster sein, nicht
    // eine versiegte Quelle (Review-Nachtrag): die Flut ist endlich
    // (`head -c`), und tmux liefert einem zurueckgefallenen Client nicht den
    // vollen Rohbytestrom nach -- siehe den Debugging-Fund bei
    // `closing_a_terminal_while_the_pump_task_is_blocked_on_the_ack_gate_*`.
    // Waere die Quelle versiegt, hinge die Pumpaufgabe in `rx.recv()` statt
    // an der Bremse, es liefe GAR KEIN Stillstands-Zeitlimit (das spannt
    // `wait_for_room_cancel_or_stall` pro AUFRUF auf), und Zusicherung 1
    // unten scheiterte mit WORTGLEICHER Meldung wie bei einem fehlenden
    // Waechter. Diese Zusicherung trennt die beiden Ursachen, statt das dem
    // Leser des Protokolls zu ueberlassen. Gemessen liegt `total` bei rund
    // 99,9 % des Fensters, die Schwelle hat also reichlich Luft.
    assert!(
        total > ACK_WINDOW_BYTES * 3 / 4,
        "die Stille muss vom geschlossenen Ack-Fenster kommen, nicht von einer versiegten \
         Quelle: nur {total} von {ACK_WINDOW_BYTES} Fensterbytes kamen an -- so weit unter dem \
         Fenster hing die Pumpaufgabe in rx.recv(), nicht an der Bremse, und der Waechter kann \
         gar nicht laufen"
    );
    eprintln!("[flut] eingesammelt bis Stille: total={total} bytes (Fenster {ACK_WINDOW_BYTES})");

    // Zusicherung 1: der Waechter meldet die Session als verloren.
    let lost = tokio::time::timeout(STALL_TIMEOUT + Duration::from_secs(30), lost_rx.recv())
        .await
        .expect("der Waechter haette die stillstehende Session melden muessen")
        .expect("der Kanal darf nicht ohne Ereignis geschlossen werden");
    assert_eq!(
        lost,
        (host_id.clone(), session.clone()),
        "die Meldung muss GENAU die stillstehende Session nennen"
    );

    // Zusicherung 2: die Verbindung ist wieder benutzbar -- ein NEUER
    // exec-Kanal auf derselben Verbindung gelingt.
    let recovered = tokio::time::timeout(
        Duration::from_secs(20),
        create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None),
    )
    .await
    .expect("nach dem Waechter muss die Verbindung wieder benutzbar sein")
    .expect("create_session muss nach der Erholung gelingen");

    // Verbindung schliessen -- `unwrap()` wie in den drei Nachbartests, nicht
    // `ok()`: Zusicherung 2 hat gerade belegt, dass die Verbindung wieder
    // benutzbar ist, ein Fehler hier waere also echtes Signal ueber das
    // Abraeumen NACH einem Waechter-Zugriff und darf nicht verschluckt werden.
    disconnect_host_impl(&state, host_id).await.unwrap();

    // Aufraeumen: die DREI tmux-Sessions dieser Testrunde (`session`,
    // `control`, `recovered`) leben auf der VM weiter -- weder der Waechter
    // noch `disconnect_host_impl` beenden je eine ENTFERNTE tmux-Session, sie
    // schliessen nur lokale Kanaele bzw. die Verbindung. Dafuer braucht es
    // KEINEN Zugriff auf `AppState`: eine frische, unabhaengige Verbindung
    // genuegt, genau wie in den Nachbartests oben. Die Test-VM ist mit einem
    // anderen Projekt geteilt, deshalb raeumt dieser Test selbst auf, statt
    // einen ssh-Schritt von Hand zu verlangen -- sonst sammelten sich mit
    // jedem Suite-Lauf drei Sessions an. Die Zusicherungen oben haengen nicht
    // am Aufraeumen.
    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    let tmux = TmuxClient::new(&common::test_socket()); // derselbe Socket wie beim Anlegen; der Produktionsdefault ist gepinnt in production_default_socket_is_agentbridge
    for name in [&session, &control, &recovered] {
        tmux.kill_session(&t, name)
            .await
            .unwrap_or_else(|e| panic!("Aufraeumen von {name} muss gelingen: {e:#}"));
    }
    t.dispose().await;
}

/// B2, Test 6: ein regelwidriger Name wird abgelehnt, und danach existiert
/// NICHTS Neues.
///
/// Die zweite Haelfte ist die eigentliche Zusicherung. Ein Test, der nur auf
/// den Fehler prueft, waere auch dann gruen, wenn der Name still verstuemmelt
/// angelegt wuerde -- und genau das tut tmux mit `#H` (wird zum Hostnamen)
/// oder `.` (wird zu `_`). Der Nutzer bekaeme eine Session unter einem
/// anderen Namen, als er getippt hat.
#[tokio::test]
async fn a_hostile_session_name_is_rejected_and_creates_nothing() {
    let Some(spec) = dto() else { return };
    // Eigener Socket: Seit der numerischen Liste (12.09.2026) scheitert die
    // Liste unten, sobald parallel laufende Tests Sessions anlegen. Auf dem
    // frischen Socket laeuft kein Server; die Liste ist dann leer.
    let state = Arc::new(AppState::with_default_socket(common::test_socket_for(
        "hostile",
    )));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    let err = create_session_impl(
        &state,
        host_id.clone(),
        "/tmp".to_string(),
        Some("zz_b2hostile#H".to_string()),
    )
    .await
    .expect_err("ein Name mit '#' muss abgelehnt werden");
    assert_eq!(err.kind, "other");
    assert!(
        err.message.contains("letters"),
        "die Meldung muss die REGEL nennen: {}",
        err.message
    );

    // Nach dem MARKER gesucht statt die ganze Liste zu vergleichen. Das
    // stammt aus der Zeit, als sich die parallel laufenden Tests dieser
    // Datei einen Socket teilten und ein Vorher/Nachher-Vergleich die
    // Nachbartests mitmass; seit dem eigenen Socket oben waere er moeglich.
    //
    // Der Marker traegt die Zusicherung vollstaendig: die
    // verstuemmelte Fassung, die tmux ohne die Pruefung anlegen wuerde,
    // BEGINNT mit dem getippten Praefix (an der VM gemessen: `zz_b2#H` wurde
    // zu `zz_b2UnitySystemsLH`, dem Hostnamen).
    let after = list_sessions_impl(&state, host_id.clone()).await.unwrap();
    let mine: Vec<_> = after
        .iter()
        .filter(|n| n.display_name.starts_with("zz_b2hostile"))
        .collect();
    assert!(
        mine.is_empty(),
        "ein abgelehnter Name darf nichts anlegen -- auch keine verstuemmelte \
         Fassung. Gefunden: {mine:?}"
    );

    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// B2, Test 7 und 8 in einem Lauf -- sie teilen sich denselben, teuren
/// Aufbau und pruefen zwei Seiten desselben Schadenszustands.
///
/// **Test 7 (die Zusicherung gegen die Retry-Schleife):** ein doppelter
/// NUTZERNAME ergibt einen Fehler und insbesondere KEINE
/// `ab_*`-Ersatzsession. `create_session_with_retry` reagiert auf
/// `DuplicateName` mit einem neuen Zufallsnamen -- liefe ein Nutzername durch
/// diese Schleife, bekaeme der Nutzer still etwas anderes, als er verlangt
/// hat, und erfuehre es nicht.
///
/// Der Test hiess einmal `..._and_leaves_exit_empty_on` und trug eine zweite
/// Zusicherung auf die gleichnamige Serveroption. Die ist fort -- warum,
/// steht ausfuehrlich im Rumpf, an der Stelle, an der sie stand.
#[tokio::test]
async fn a_duplicate_user_name_is_an_end_error_not_a_silent_replacement() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket()));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    let name = "zz_b2_dup";
    // Defensiv abgeraeumt, BEVOR der Test beginnt: bricht ein Lauf zwischen
    // dem ersten Anlegen und dem Aufraeumen unten ab (eine Gegenprobe tut
    // genau das), traefe der naechste Lauf auf eine vorhandene Session --
    // und scheiterte an seiner ERSTEN Zusicherung statt an der gemeinten.
    // Der Name gehoert ausschliesslich diesem Test.
    {
        let t = common::connect_test_host()
            .await
            .expect("Vorabraeumung braucht eine Verbindung");
        TmuxClient::new(&common::test_socket())
            .kill_session(&t, name)
            .await
            .ok();
        t.dispose().await;
    }

    let created = create_session_impl(
        &state,
        host_id.clone(),
        "/tmp".to_string(),
        Some(name.to_string()),
    )
    .await
    .expect("der erste Anlegeversuch muss gelingen");
    assert_eq!(
        created, name,
        "der getippte Name muss unveraendert ankommen"
    );

    // Die Zusicherung "keine Ersatzsession" steckt VOLLSTAENDIG in diesem
    // `expect_err`, und das ist kein Ausweichen: `create_session_with_retry`
    // liefert die von ihr angelegte Session als `Ok(name)` zurueck -- es gibt
    // keinen Pfad, auf dem sie eine anlegt, ohne ihren Namen zu liefern.
    // Liefe der Nutzername durch die Schleife, staende hier also ein
    // `Ok("ab_xxxxxx")`. Gemessen in der Gegenprobe: genau diese Zeile wurde
    // rot, mit `"ab_1a09cc"` im Text.
    //
    // Bewusst KEIN Vorher/Nachher-Vergleich der Sessionliste: die Tests
    // dieser Datei laufen parallel auf demselben Socket, der Vergleich maesse
    // die Nachbartests mit (gemessen -- er war die erste, wettlaufanfaellige
    // Fassung dieses Tests).
    let err = create_session_impl(
        &state,
        host_id.clone(),
        "/tmp".to_string(),
        Some(name.to_string()),
    )
    .await
    .expect_err("ein doppelter NUTZERNAME ist ein Endfehler, keine Neuwuerfelung");
    assert_eq!(err.kind, "duplicate", "der Typ traegt die Unterscheidung");

    // HIER STAND EINE SONDE AUF `exit-empty`, UND SIE IST BEWUSST FORT.
    //
    // Sie las die globale Serveroption nach dem Endfehler und verlangte
    // "on". Gemessen: allein gefahren gruen, unter der vollen Suite ROT --
    // `exit-empty` gehoert dem SERVER, und `create_session_impl` legt fest
    // auf `settings::default_socket()` an. Die 17 Tests dieser Datei laufen
    // parallel auf genau diesem einen Server; jeder von ihnen ruft
    // `prepare_server` und schaltet die Option dabei kurz auf "off". Die
    // Sonde mass also die Nachbartests mit -- dieselbe Falle wie beim
    // Vorher/Nachher-Vergleich der Sessionliste weiter oben, nur an einem
    // globalen Wert statt an einer Liste.
    //
    // Und die naheliegende Reparatur waere die schlechtere: mit einer
    // Wiederholschleife wuerde sie gruen, sobald IRGENDEIN Nachbartest
    // erfolgreich anlegt und die Option dabei selbst zurueckstellt -- ein
    // Test, der auch dann gruen ist, wenn `restore_exit_empty` gar nicht
    // gerufen wurde.
    //
    // Was stattdessen deckt, ehrlich aufgezaehlt:
    //   - `tmux::client::tests::restore_exit_empty_sets_the_option_back_to_on`
    //     (VM-frei) prueft, dass der Aufruf `set -g exit-empty on` schickt.
    //   - `create_session_impl` ruft ihn auf EINEM gemeinsamen Fehlerausgang
    //     fuer beide Namensarten -- lesbar an einer Stelle, statt an zwei.
    // Was NICHT gedeckt ist: dass dieser Aufruf im Betrieb tatsaechlich
    // faellt. Das bleibt eine Luecke, und sie steht hier, statt hinter einem
    // Test zu verschwinden, der sie nicht schliesst.

    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung");
    TmuxClient::new(&common::test_socket())
        .kill_session(&t, name)
        .await
        .unwrap();
    t.dispose().await;
    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// B3, Test 5: `kill_session` ist der VIERTE gewollte Schliesspfad und darf
/// deshalb KEIN `connection_lost` erzeugen.
///
/// Die Invariante steht woertlich an `OutputSink::connection_lost`: alle
/// gewollten Schliesspfade entfernen ihren Eintrag VOR dem Zeitpunkt, an dem
/// die Pumpaufgabe endet. Ohne diese Vorkehrung stirbt der Attach-Kanal
/// serverseitig, waehrend die Pumpe ihren Eintrag noch besitzt -- der Nutzer
/// bekaeme eine Sperrleiste auf einer Sitzung, die er gerade selbst beendet
/// hat.
///
/// **RUST, nicht jsdom**, und das ist keine Bequemlichkeit: die Sperrleiste
/// entsteht ausschliesslich, weil das BACKEND dieses Ereignis sendet. In
/// jsdom mit gemocktem `invoke` faellt es nie -- ein Test dort waere unter
/// BEIDEN Zweigen seiner eigenen Gegenprobe gruen.
///
/// Der `RecordingSink` ist derselbe wie im positiven Test oben; dass er
/// ueberhaupt aufzeichnen KANN, belegt jener (siehe Kommentar an
/// `RecordingSink`).
#[tokio::test]
async fn killing_a_session_deliberately_emits_no_connection_lost_event() {
    // Eigener Socket: Die Liste unten scheitert sonst, sobald parallel
    // laufende Tests derselben Datei Sessions anlegen.
    let Some((state, host_id, session, mut lost_rx, _sent_rx)) =
        connect_create_and_open_with_recording_sink(Some("kill")).await
    else {
        return;
    };

    kill_session_impl(&state, host_id.clone(), session.clone(), None, None, None)
        .await
        .expect("das Beenden der eigenen Session muss gelingen");

    // Test 6 nebenbei, mit derselben Verbindung: die Session ist wirklich
    // weg. Ohne diese Zusicherung waere der Test auch dann gruen, wenn
    // `kill_session_impl` gar nichts getan haette -- und "kein Ereignis"
    // ist genau das, was Nichtstun ebenfalls erzeugt.
    let remaining = list_sessions_impl(&state, host_id.clone()).await.unwrap();
    assert!(
        !remaining.iter().any(|row| row.display_name == session),
        "die Session muss nach dem Beenden aus der Liste verschwunden sein: {remaining:?}"
    );

    assert_no_further_connection_lost_event(
        &mut lost_rx,
        std::time::Duration::from_secs(2),
        "ein GEWOLLTES Beenden ist der vierte Schliesspfad und darf keine Sperrleiste ausloesen",
    )
    .await;

    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// B3, Test 7: die WIRKUNG entscheidet, nicht der Exit-Code.
///
/// Der Fall, den dieser Test faehrt: **das Ziel ist sauber abwesend.** Der
/// Nutzer hat doppelt geklickt, oder ein Kollege war schneller. tmux meldet
/// dafuer rc=1 und `can't find session` -- am Exit-Code allein waere das
/// ein Fehlschlag. Das gewuenschte Ergebnis liegt aber vor: die Session ist
/// weg. Wer hier einen Fehler meldete, schickte den Nutzer auf die Suche
/// nach einem Problem, das es nicht gibt.
///
/// **Was dieser Test NICHT faehrt, ausgesprochen statt verschwiegen:** die
/// andere Haelfte der Entscheidung -- "der Aufruf meldet Erfolg, die Session
/// steht danach trotzdem noch in der Liste" -- hat hier keine Vorrichtung.
/// Der Plan wollte sie aus dem Restfall von B0 bauen (eine Session mit `$`
/// im Namen, die tmux escapt speichert). An der VM nachgemessen, tmux 3.4:
///
///     $ tmux -L zzb3 new-session -d -s 'zz_b3$esc'
///     $ tmux -L zzb3 list-sessions -F '#{session_name}'
///     zz_b3\$esc
///     $ tmux -L zzb3 kill-session -t '=zz_b3\$esc'
///     exit=0        # und die Session ist weg
///
/// Unter ihrem GELISTETEN Namen ist sie also sehr wohl adressierbar -- die
/// Annahme des Plans war falsch, und mit ihr die Vorrichtung. Der
/// `still running`-Zweig in `kill_session_impl` bleibt damit vorsorglicher
/// Code ohne eigenen Test: er kostet nichts, deckt fremde tmux-Versionen mit
/// ab, und die Alternative waere, ihn zu streichen und dem Exit-Code doch zu
/// glauben. Das Nachlesen als solches ist durch den Fall UNTEN abgesichert
/// (ohne es waere er rot).
#[tokio::test]
async fn killing_an_absent_session_is_success_not_a_failed_exit_code() {
    let Some(spec) = dto() else { return };
    // Eigener Socket: Die Vorbedingung unten liest die Sessionliste, die
    // sonst an parallel laufenden Tests derselben Datei scheitert.
    let state = Arc::new(AppState::with_default_socket(common::test_socket_for(
        "absent",
    )));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    // Vorbedingung: das Ziel existiert wirklich nicht. Ohne sie pruefte der
    // Test bei einem Namenszusammenstoss etwas ganz anderes.
    let before = list_sessions_impl(&state, host_id.clone()).await.unwrap();
    let absent = "zz_b3_nie_da";
    assert!(
        !before.iter().any(|n| n.display_name == absent),
        "Vorbedingung: {absent:?} darf nicht existieren, gefunden: {before:?}"
    );

    kill_session_impl(
        &state,
        host_id.clone(),
        absent.to_string(),
        None,
        None,
        None,
    )
    .await
    .expect(
        "ein abwesendes Ziel ist Erfolg -- tmux meldet dafuer rc=1 und \
             `can't find session`, das gewuenschte Ergebnis liegt aber vor",
    );

    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Ein Host ohne laufenden tmux-Server der App -- frischer Host, Neustart
/// der VM, letzte Session beendet -- zeigt eine leere Liste, keinen Fehler
/// (MVP-Spec, Nachtrag vom 15.09.). Eigener, frischer Socket: kein Server,
/// keine Socket-Datei.
#[tokio::test]
async fn a_socket_without_a_server_lists_no_sessions() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket_for(
        "fresh",
    )));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    let listed = list_sessions_impl(&state, host_id.clone())
        .await
        .expect("kein Server auf dem Socket heisst keine Sessions, kein Fehler");
    assert!(listed.is_empty(), "{listed:?}");

    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Beenden ueber die numerische Identitaet, wie die Seitenleiste es tut. Die
/// letzte Session nimmt den Server mit; die Kontrolle danach muss das als
/// Erfolg lesen, und die Liste ist danach leer, obwohl die Socket-Datei
/// liegen bleibt.
#[tokio::test]
async fn ending_the_last_session_by_its_numeric_identity_succeeds_and_lists_nothing() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket_for(
        "last",
    )));

    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();

    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();
    let listed = list_sessions_impl(&state, host_id.clone()).await.unwrap();
    let row = listed
        .iter()
        .find(|row| row.display_name == session)
        .unwrap_or_else(|| panic!("die neue Session {session:?} muss gelistet sein: {listed:?}"));
    assert!(
        row.session_id.is_some() && row.server_pid.is_some() && row.server_start_time.is_some(),
        "die Zeile muss numerisch gebunden sein, sonst liefe das Beenden ueber den Namen: {row:?}"
    );

    kill_session_impl(
        &state,
        host_id.clone(),
        session.clone(),
        row.session_id,
        row.server_pid,
        row.server_start_time,
    )
    .await
    .expect("das Beenden der letzten Session muss als Erfolg zurueckkommen");

    let after = list_sessions_impl(&state, host_id.clone())
        .await
        .expect("nach der letzten Session: leere Liste, kein Fehler");
    assert!(after.is_empty(), "{after:?}");

    disconnect_host_impl(&state, host_id).await.unwrap();
}

/// Bindung einer gelisteten Zeile, wie die Seitenleiste sie an
/// `open_terminal` gibt. Alle sechs Felder gibt es nur auf bestaetigbaren
/// tmux-Versionen (3.3a/3.4/3.6).
fn bound_identity(row: &SessionListItemDto) -> PaneIdentity {
    let (
        Some(pid),
        Some(start_time),
        Some(session_id),
        Some(window_id),
        Some(pane_id),
        Some(pane_pid),
    ) = (
        row.server_pid,
        row.server_start_time,
        row.session_id,
        row.window_id,
        row.pane_id,
        row.pane_pid,
    )
    else {
        panic!("die Zeile muss vollstaendig gebunden sein: {row:?}");
    };
    PaneIdentity {
        server: ServerIdentity { pid, start_time },
        session_id: SessionId(session_id),
        window_id: WindowId(window_id),
        pane_id: PaneId(pane_id),
        pane_pid,
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Sammelt und bestaetigt Ausgabe wie der WebView, bis tmux' Neuzeichnen
/// (`ESC[2J`) da ist und danach `after` erscheint. Ereignisse in
/// Ankunftsfolge; das letzte kann ueber das erste Neuzeichnen hinausreichen,
/// denn was beim Oeffnen schon anliegt, kommt zusammengelegt an.
async fn collect_through_redraw(
    state: &Arc<AppState>,
    host_id: &str,
    session: &str,
    rx: &mut mpsc::UnboundedReceiver<(String, Vec<u8>)>,
    after: &str,
) -> Vec<Vec<u8>> {
    let mut events: Vec<Vec<u8>> = Vec::new();
    let done = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some((_, bytes)) = rx.recv().await {
            ack_output_impl(state, host_id.into(), session.into(), bytes.len() as u32)
                .await
                .unwrap();
            events.push(bytes);
            let stream = events.concat();
            if let Some(clear) = find(&stream, b"\x1b[2J") {
                if find(&stream[clear..], after.as_bytes()).is_some() {
                    return true;
                }
            }
        }
        false
    })
    .await;
    assert!(
        matches!(done, Ok(true)),
        "kein Neuzeichnen mit {after:?}: {:?}",
        String::from_utf8_lossy(&events.concat())
    );
    events
}

async fn end_session(state: &Arc<AppState>, host_id: String, session: &str) {
    close_terminal_impl(state, host_id.clone(), session.into())
        .await
        .unwrap();
    let t = common::connect_test_host()
        .await
        .expect("Aufraeumverbindung fuer kill_session");
    TmuxClient::new(&state.default_socket)
        .kill_session(&t, session)
        .await
        .unwrap();
    disconnect_host_impl(state, host_id).await.unwrap();
}

/// Verbindet, legt eine Session an und schreibt ueber ein Oeffnen nach Namen
/// (80x24) 50 nummerierte Zeilen hinein. Zurueck erst, wenn die letzte
/// gesehen ist: dann steht der Verlauf auf dem Host. Das Terminal ist danach
/// wieder geschlossen, das Fenster bleibt 80x24.
async fn host_with_fifty_lines(state: &Arc<AppState>, spec: HostSpecDto) -> (String, String) {
    let host_id = connect_host_with_known_hosts(
        state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();
    let session = create_session_impl(state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    open_terminal_impl(
        state,
        ChannelSink(tx),
        host_id.clone(),
        session.clone(),
        80,
        24,
    )
    .await
    .unwrap();
    send_input_impl(
        state,
        host_id.clone(),
        session.clone(),
        b"printf 'HIST_%03d_END\\n' $(seq 1 50)\n".to_vec(),
    )
    .await
    .unwrap();
    let mut seen = String::new();
    let printed = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some((_, bytes)) = rx.recv().await {
            ack_output_impl(state, host_id.clone(), session.clone(), bytes.len() as u32)
                .await
                .unwrap();
            seen.push_str(&String::from_utf8_lossy(&bytes));
            if seen.contains("HIST_050_END") {
                return true;
            }
        }
        false
    })
    .await;
    assert!(matches!(printed, Ok(true)), "Pane-Ausgabe: {seen:?}");
    close_terminal_impl(state, host_id.clone(), session.clone())
        .await
        .unwrap();
    (host_id, session)
}

/// Spec §5.6 gegen die echte VM: Ein gebundenes Oeffnen (wie aus der
/// Seitenleiste) liefert den Verlauf der Pane als erste Ausgabe, vor tmux'
/// Neuzeichnen. 50 nummerierte Zeilen in 24 Zeilen Hoehe schieben die ersten
/// davon sicher in den Verlauf.
///
/// Jeder Verlaufstest hat einen eigenen Socket: Das bestaetigte Oeffnen
/// verlangt eine unveraenderte Sessionliste (`confirm_inventory`). Legt ein
/// paralleler Test auf demselben Server eine Session an oder beendet eine,
/// scheitert es mit "attach identity changed" (gemessen: zwei von vier
/// Laeufen mit gemeinsamem Socket).
#[tokio::test]
async fn a_bound_open_restores_the_pane_history_before_live_output() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket_for(
        "hist",
    )));
    let (host_id, session) = host_with_fifty_lines(&state, spec).await;

    let listed = list_sessions_impl(&state, host_id.clone()).await.unwrap();
    let row = listed
        .iter()
        .find(|row| row.display_name == session)
        .unwrap_or_else(|| panic!("{session:?} muss gelistet sein: {listed:?}"));
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    open_terminal_tagged_impl(
        &state,
        ChannelSink(tx),
        host_id.clone(),
        session.clone(),
        80,
        24,
        "live-history".into(),
        Some(bound_identity(row)),
    )
    .await
    .expect("gebundenes Oeffnen");
    let events = collect_through_redraw(&state, &host_id, &session, &mut rx, "HIST_050_END").await;

    let first = String::from_utf8_lossy(&events[0]).into_owned();
    assert!(
        first.contains("HIST_001_END") && !first.contains("\x1b[2J"),
        "das erste Ereignis ist der Verlauf mit Zeile 1: {first:?}"
    );
    // Spec §5.6: letzte Verlaufszeile, bei Escape-Folgen im Verlauf (die
    // farbige Eingabeaufforderung) `\e[m`, dann genau `rows - 1` Vorschuebe.
    let reset = if events[0].contains(&0x1b) {
        "\x1b[m"
    } else {
        ""
    };
    let tail = format!("_END\r\n{reset}{}", "\r\n".repeat(23));
    assert!(
        events[0].ends_with(tail.as_bytes()),
        "der Verlauf endet mit {tail:?}: {first:?}"
    );
    let stream = events.concat();
    let clear = find(&stream, b"\x1b[2J").unwrap();
    let line_one = find(&stream[..clear], b"HIST_001_END");
    eprintln!(
        "[diag] Verlaufsereignis {} Bytes, Zeile 1 bei Byte {line_one:?}, Neuzeichnen ab Byte {clear}",
        events[0].len()
    );
    assert!(line_one.is_some(), "Zeile 1 kommt vor tmux' Neuzeichnen");

    end_session(&state, host_id, &session).await;
}

/// Die Naht bei geaenderter Groesse (Maximieren, Wiederherstellen): Der
/// Attach bringt das Fenster auf die Kachelgroesse, und tmux holt dabei
/// Zeilen aus dem Verlauf auf den Bildschirm (groesser) oder schiebt sie
/// hinein (kleiner). Jede Zeile steht trotzdem genau einmal im Verlauf ODER
/// im ersten Neuzeichnen. Ein spaeteres Neuzeichnen ueberschreibt den
/// Bildschirm an Ort und Stelle und zaehlt deshalb nicht mit.
#[tokio::test]
async fn a_bound_open_at_another_size_restores_every_line_exactly_once() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket_for(
        "hist_resize",
    )));
    let (host_id, session) = host_with_fifty_lines(&state, spec).await;
    let listed = list_sessions_impl(&state, host_id.clone()).await.unwrap();
    let row = listed
        .iter()
        .find(|row| row.display_name == session)
        .unwrap_or_else(|| panic!("{session:?} muss gelistet sein: {listed:?}"));
    let identity = bound_identity(row);

    // Erst groesser (24 -> 40 Zeilen), dann kleiner (40 -> 12 Zeilen).
    for rows in [40, 12] {
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
        open_terminal_tagged_impl(
            &state,
            ChannelSink(tx),
            host_id.clone(),
            session.clone(),
            80,
            rows,
            format!("live-resize-{rows}"),
            Some(identity),
        )
        .await
        .expect("gebundenes Oeffnen");
        let stream = collect_through_redraw(&state, &host_id, &session, &mut rx, "HIST_050_END")
            .await
            .concat();
        let clear = find(&stream, b"\x1b[2J").unwrap();
        // Das erste Neuzeichnen endet fuer diese Zaehlung mit Zeile 50, der
        // letzten nummerierten: tmux zeichnet von oben nach unten. Danach
        // kann ein zweites folgen, das mit `ESC[H` ohne `ESC[2J` an Ort und
        // Stelle ueberschreibt (gemessen mit tmux 3.6 bei 40 Zeilen). Es
        // steht oft im selben Ereignis, denn was beim Oeffnen schon anliegt,
        // kommt zusammengelegt an; auf Ereignisgrenzen ist kein Verlass.
        let last = b"HIST_050_END";
        let end = clear
            + find(&stream[clear..], last).expect("collect_through_redraw wartet auf Zeile 50")
            + last.len();
        let restored = &stream[..end];
        let counts: Vec<usize> = (1..=50)
            .map(|n| {
                let line = format!("HIST_{n:03}_END");
                restored
                    .windows(line.len())
                    .filter(|window| *window == line.as_bytes())
                    .count()
            })
            .collect();
        eprintln!("[diag] {rows} Zeilen: Verlauf {clear} Bytes, Zeilen 1..50 je {counts:?}");
        assert!(
            counts.iter().all(|count| *count == 1),
            "bei {rows} Zeilen steht jede Zeile genau einmal da: {counts:?}"
        );
        close_terminal_impl(&state, host_id.clone(), session.clone())
            .await
            .unwrap();
    }

    end_session(&state, host_id, &session).await;
}

/// Spec §5.6, leerer Verlauf: Bei `history_size` 0 (frische Session) liefert
/// tmux mit `-E -1` die erste sichtbare Zeile. Die Pruefung im Befehl macht
/// daraus "kein Verlauf": vor dem Neuzeichnen steht kein einziger
/// Zeilenvorschub.
#[tokio::test]
async fn a_bound_open_of_a_fresh_session_sends_no_history() {
    let Some(spec) = dto() else { return };
    let state = Arc::new(AppState::with_default_socket(common::test_socket_for(
        "hist_fresh",
    )));
    let host_id = connect_host_with_known_hosts(
        &state,
        spec,
        common::real_host_key(),
        dummy_known_hosts_path(),
        Arc::new(PanicIfAskedSink),
        TEST_PROMPT_TIMEOUT,
    )
    .await
    .unwrap();
    let session = create_session_impl(&state, host_id.clone(), "/tmp".to_string(), None)
        .await
        .unwrap();
    let listed = list_sessions_impl(&state, host_id.clone()).await.unwrap();
    let row = listed
        .iter()
        .find(|row| row.display_name == session)
        .unwrap_or_else(|| panic!("{session:?} muss gelistet sein: {listed:?}"));
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    open_terminal_tagged_impl(
        &state,
        ChannelSink(tx),
        host_id.clone(),
        session.clone(),
        80,
        24,
        "live-fresh".into(),
        Some(bound_identity(row)),
    )
    .await
    .expect("gebundenes Oeffnen");
    let events = collect_through_redraw(&state, &host_id, &session, &mut rx, "").await;

    let stream = events.concat();
    let clear = find(&stream, b"\x1b[2J").unwrap();
    assert!(
        !stream[..clear].contains(&b'\n'),
        "ohne Verlauf kein Verlaufsereignis: {:?}",
        String::from_utf8_lossy(&stream[..clear])
    );

    end_session(&state, host_id, &session).await;
}

/// Pin fuer den Produktionsdefault: kein VM-Zugriff, laeuft also immer,
/// unabhaengig von `AIDEVBRIDGE_TEST_HOST`/`AIDEVBRIDGE_TEST_SOCKET`. Jeder
/// Testlauf in dieser Datei legt seine Sessions ueber
/// `AppState::with_default_socket(common::test_socket())` an, nicht mehr
/// ueber ein Literal -- dieser Test allein haelt fest, dass
/// `settings::default_socket()` (und damit `AppState::default()` im
/// Produktivpfad) weiterhin "agentbridge" liefert. Aendert sich der
/// Produktionsdefault, faellt DIESER Test, nicht ein verstreutes Literal.
#[test]
fn production_default_socket_is_agentbridge() {
    assert_eq!(AppState::default().default_socket, "agentbridge");
}
