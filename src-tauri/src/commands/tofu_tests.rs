use super::*;

// --- TofuPolicy (TOFU, Spec §8.1) ---
//
// Policy-Tests laufen auf Tokios einzelner Test-Worker-Thread-Runtime.
// `decide` wartet asynchron auf Antwort, Frist oder Connect-Abbruch.
// Bestehende Antwortthreads bedienen nur begrenzte std-Kanaele; ihr
// Join liegt in spawn_blocking und blockiert keinen Tokio-Worker.

const KH: &str = "192.0.2.10 ssh-ed25519 AAAAKNOWNKEY\n";
const UNKNOWN_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAD1+Ea/eX8XGszB1Ee5udPD85hQSr6XBZCh4YIzFLng";

fn unique_temp_known_hosts_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("aidevbridge_test_tofu_known_hosts_{tag}_{nanos}"))
}

/// Sink, der nie erreicht werden sollte -- jeder Aufruf ist ein
/// Testfehlschlag. Genutzt fuer `Known`, wo `decide` gar nicht fragen
/// darf.
struct PanicSink;
impl HostKeyRequestSink for PanicSink {
    fn request(&self, req: &HostKeyRequest) -> bool {
        panic!("decide() durfte hier keine Rueckfrage stellen, tat es aber fuer {req:?}");
    }
}

/// Zeichnet jede gestellte Anfrage in einem geteilten `Vec` auf, ohne
/// selbst zu antworten (liefert `true` = "zugestellt"). Fuer den
/// Mismatch- und den Zeitablauf-Test: beide muessen zaehlen koennen,
/// WIE OFT tatsaechlich gefragt wurde.
struct RecordingSink(Arc<std::sync::Mutex<Vec<HostKeyRequest>>>);
impl HostKeyRequestSink for RecordingSink {
    fn request(&self, req: &HostKeyRequest) -> bool {
        self.0.lock().unwrap().push(req.clone());
        true
    }
}

/// Leitet jede gestellte Anfrage ueber einen `mpsc`-Kanal weiter -- fuer
/// die Tests, die tatsaechlich antworten muessen (ein zweiter,
/// unabhaengiger `std::thread` liest von hier und ruft
/// `respond_host_key_impl` auf, WAEHREND `decide()` asynchron wartet).
struct ChannelSink(std::sync::mpsc::Sender<HostKeyRequest>);
impl HostKeyRequestSink for ChannelSink {
    fn request(&self, req: &HostKeyRequest) -> bool {
        self.0.send(req.clone()).is_ok()
    }
}

struct LifecycleSink {
    requests: mpsc::UnboundedSender<HostKeyRequest>,
    closed: std::sync::Mutex<Vec<HostKeyRequestClosed>>,
}

impl HostKeyRequestSink for LifecycleSink {
    fn request(&self, request: &HostKeyRequest) -> bool {
        self.requests.send(request.clone()).is_ok()
    }

    fn request_closed(&self, event: &HostKeyRequestClosed) {
        self.closed.lock().unwrap().push(event.clone());
    }
}

fn lifecycle_sink() -> (Arc<LifecycleSink>, mpsc::UnboundedReceiver<HostKeyRequest>) {
    let (requests, receiver) = mpsc::unbounded_channel();
    (
        Arc::new(LifecycleSink {
            requests,
            closed: std::sync::Mutex::new(Vec::new()),
        }),
        receiver,
    )
}

// Pollt die Policy bis zu ihrer Rueckfrage, ohne die wartende Future
// danach abzubrechen oder den einzigen Tokio-Test-Worker zu blockieren.
async fn prompt_while_pending<F>(
    decision: &mut F,
    requests: &mut mpsc::UnboundedReceiver<HostKeyRequest>,
) -> HostKeyRequest
where
    F: std::future::Future<Output = bool> + Unpin,
{
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::select! {
            biased;
            accepted = decision => panic!("decide returned before a response: {accepted}"),
            request = requests.recv() => request.expect("request channel closed before the prompt"),
        }
    })
    .await
    .expect("the policy must publish its prompt without waiting for an answer")
}

fn assert_request_closed(sink: &LifecycleSink, request: &HostKeyRequest, reason: &str) {
    let closed = sink.closed.lock().unwrap();
    let matching: Vec<_> = closed
        .iter()
        .filter(|event| event.request_id == request.request_id)
        .collect();
    assert_eq!(matching.len(), 1, "a prompt must close exactly once");
    assert_eq!(matching[0].expires_at_unix_ms, request.expires_at_unix_ms);
    assert_eq!(matching[0].reason, reason);
}

fn policy_with(
    known_hosts_text: &str,
    known_hosts_path: PathBuf,
    sink: Arc<dyn HostKeyRequestSink>,
    timeout: Duration,
) -> TofuPolicy {
    TofuPolicy::new(
        known_hosts_text.to_string(),
        known_hosts_path,
        Arc::new(AppState::default()),
        sink,
        timeout,
    )
}

#[tokio::test]
async fn tofu_policy_accepts_known_and_records_the_decision_without_ever_prompting() {
    let p = policy_with(
        KH,
        unique_temp_known_hosts_path("known"),
        Arc::new(PanicSink),
        Duration::from_secs(5),
    );
    assert!(
        p.decide("192.0.2.10", 22, "ssh-ed25519", "AAAAKNOWNKEY")
            .await
    );
    assert_eq!(p.last_decision(), Some(HostKeyDecision::Known));
}

/// `Mismatch` loest NIEMALS eine Rueckfrage aus. Geprueft werden ZWEI
/// unabhaengige Aspekte -- kein Prompt UND keine Spur in `known_hosts` (die
/// Datei existiert danach immer noch nicht, siehe
/// `tofu_policy_mismatch_leaves_an_existing_known_hosts_file_byte_identical`
/// fuer die Variante mit VORHANDENEM Inhalt).
///
/// GEGENPROBE: mit dem `Mismatch`-Zweig in `decide`
/// probeweise auf denselben Pfad wie `Unknown` umgeleitet (`Mismatch |
/// Unknown => { ... }`), wurde dieser Test rot --
/// `recorded.lock().unwrap().is_empty()` schlug fehl (eine Anfrage
/// wurde aufgezeichnet). Fix zurueckgesetzt, Test wieder gruen.
#[tokio::test]
async fn tofu_policy_rejects_mismatch_without_ever_prompting_or_touching_known_hosts() {
    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let known_hosts_path = unique_temp_known_hosts_path("mismatch_no_file");
    assert!(!known_hosts_path.exists());

    let p = policy_with(
        KH,
        known_hosts_path.clone(),
        Arc::new(RecordingSink(recorded.clone())),
        Duration::from_millis(50),
    );
    let accepted = p
        .decide("192.0.2.10", 22, "ssh-ed25519", "AAAADIFFERENTKEY")
        .await;

    assert!(!accepted);
    assert_eq!(p.last_decision(), Some(HostKeyDecision::Mismatch));
    assert!(
        recorded.lock().unwrap().is_empty(),
        "Mismatch darf niemals eine Host-Key-Rueckfrage ausloesen"
    );
    assert!(
        !known_hosts_path.exists(),
        "Mismatch darf niemals append_entry erreichen -- die Datei haette sonst \
         (neu) entstehen muessen"
    );
}

/// Variante mit VORHANDENEM known_hosts-Inhalt: belegt zusaetzlich zu
/// "kein Prompt", dass die Datei durch einen Mismatch-Entscheid nicht
/// einmal indirekt (z. B. durch ein "hilfreiches" Neuschreiben)
/// veraendert wird -- byte-identisch vorher/nachher.
#[tokio::test]
async fn tofu_policy_mismatch_leaves_an_existing_known_hosts_file_byte_identical() {
    let known_hosts_path = unique_temp_known_hosts_path("mismatch_untouched");
    std::fs::write(&known_hosts_path, KH).unwrap();

    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let p = policy_with(
        KH,
        known_hosts_path.clone(),
        Arc::new(RecordingSink(recorded.clone())),
        Duration::from_millis(50),
    );
    let accepted = p
        .decide("192.0.2.10", 22, "ssh-ed25519", "AAAADIFFERENTKEY")
        .await;
    assert!(!accepted);
    assert!(recorded.lock().unwrap().is_empty());

    let after = std::fs::read_to_string(&known_hosts_path).unwrap();
    assert_eq!(
        after, KH,
        "Mismatch darf known_hosts nicht veraendern, nicht einmal byteweise"
    );
    let _ = std::fs::remove_file(&known_hosts_path);
}

#[tokio::test]
async fn tofu_policy_rejects_unsupported_revocation_without_prompt_or_file_change() {
    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAD1+Ea/eX8XGszB1Ee5udPD85hQSr6XBZCh4YIzFLng";
    for hosts in [
        "*",
        "|1|AQIDBAUGBwgJCgsMDQ4PEBESExQ=|7XU5FTvdyNi5n/eSAt36r2y/0Tc=",
    ] {
        let revoked = format!("@revoked {hosts} ssh-ed25519 {KEY}\n");
        let literal = format!("node.example.test ssh-ed25519 {KEY}\n");
        for text in [
            revoked.clone(),
            format!("{revoked}{literal}"),
            format!("{literal}{revoked}"),
        ] {
            let path = unique_temp_known_hosts_path("unsupported_revocation");
            std::fs::write(&path, &text).unwrap();
            let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
            let policy = policy_with(
                &text,
                path.clone(),
                Arc::new(RecordingSink(recorded.clone())),
                Duration::from_millis(1),
            );
            assert!(
                !policy
                    .decide("node.example.test", 22, "ssh-ed25519", KEY)
                    .await
            );
            assert_eq!(policy.last_decision(), Some(HostKeyDecision::Mismatch));
            assert!(recorded.lock().unwrap().is_empty());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
            std::fs::remove_file(path).unwrap();
        }
    }
}

/// Wie bei OpenSSH: steht der Host nur gehasht in known_hosts (wie nach
/// `HashKnownHosts yes`), nimmt ein anderer Schluessel denselben Weg wie ein
/// Klartext-Mismatch: keine Rueckfrage, die Datei bleibt, wie sie war, und
/// die Entscheidung `Mismatch` fuehrt in `classify_connect_error` zur Meldung
/// "The host key of ... has changed".
#[tokio::test]
async fn tofu_policy_rejects_a_changed_key_behind_a_hashed_entry_without_prompting() {
    // `node.example.test`, mit `ssh-keygen -F` gegengeprueft (siehe die
    // Tests zu gehashten Hostfeldern in `ssh::known_hosts`).
    let text = "|1|KSorLC0uLzAxMjM0NTY3ODk6Ozw=|PF+6EwBlzN80tHgE6xcOVDraMSU= ssh-ed25519 AAAAHASHEDKNOWNKEY\n";
    let path = unique_temp_known_hosts_path("hashed_mismatch");
    std::fs::write(&path, text).unwrap();
    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let policy = policy_with(
        text,
        path.clone(),
        Arc::new(RecordingSink(recorded.clone())),
        Duration::from_millis(50),
    );

    assert!(
        !policy
            .decide("node.example.test", 22, "ssh-ed25519", "AAAADIFFERENTKEY")
            .await
    );
    assert_eq!(policy.last_decision(), Some(HostKeyDecision::Mismatch));
    assert!(
        recorded.lock().unwrap().is_empty(),
        "ein Wechsel hinter einem gehashten Eintrag darf keine TOFU-Rueckfrage ausloesen"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    std::fs::remove_file(path).unwrap();
}

/// `Unknown` stellt genau EINE Rueckfrage, und ein expliziter
/// `respond_host_key(..., true)` laesst `decide()` mit `true` zurueckkehren
/// UND persistiert den akzeptierten Schluessel tatsaechlich in `known_hosts`
/// (`append_entry`). Ein zweiter `std::thread` antwortet, waehrend `decide()`
/// asynchron wartet. Die Verbindung darf erst nach der ausdruecklichen Antwort
/// fortgesetzt werden.
#[tokio::test]
async fn tofu_policy_prompts_on_unknown_and_an_explicit_accept_persists_the_key() {
    let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
    let known_hosts_path = unique_temp_known_hosts_path("accept");
    assert!(!known_hosts_path.exists());

    // Eigener `Arc<AppState>`-Handle (nicht ueber `policy_with`, das
    // seinen `AppState` intern verkapselt): dieser Test braucht
    // `state`, um `respond_host_key_impl` von einem ZWEITEN Thread aus
    // aufzurufen, WAEHREND `decide()` noch asynchron wartet.
    let state = Arc::new(AppState::default());
    let p = TofuPolicy::new(
        String::new(), // kein Eintrag -> Unknown
        known_hosts_path.clone(),
        state.clone(),
        Arc::new(ChannelSink(req_tx)),
        Duration::from_secs(5),
    );

    let responder = std::thread::spawn(move || {
        let req = req_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("decide() muss fuer Unknown genau eine Rueckfrage stellen");
        assert_eq!(req.host, "10.0.9.9");
        assert_eq!(req.port, 22);
        assert_eq!(req.key_type, "ssh-ed25519");
        assert!(
            req.fingerprint.starts_with("SHA256:"),
            "Fingerabdruck muss im ssh-keygen-Format vorliegen, nicht der rohe \
             Base64-Schluessel: {}",
            req.fingerprint
        );
        assert!(respond_host_key_impl(&state, req.request_id, true).is_ok());
    });

    let accepted = p
        .decide("10.0.9.9", 22, "ssh-ed25519", "AAAAACCEPTME")
        .await;
    assert!(
        accepted,
        "ein expliziter Accept muss decide() true liefern lassen"
    );
    tokio::task::spawn_blocking(move || responder.join())
        .await
        .unwrap()
        .expect("Antwort-Thread darf nicht paniken");

    let persisted = std::fs::read_to_string(&known_hosts_path)
        .expect("ein akzeptierter Unknown-Schluessel muss known_hosts anlegen");
    assert_eq!(
        persisted, "10.0.9.9 ssh-ed25519 AAAAACCEPTME\n",
        "append_entry muss genau die Zeile schreiben, die format_entry fuer diesen \
         Host/Key erzeugen wuerde"
    );
    let _ = std::fs::remove_file(&known_hosts_path);
}

/// Gegenstueck: ein expliziter Reject laesst `decide()` `false`
/// liefern und persistiert NICHTS.
#[tokio::test]
async fn tofu_policy_prompts_on_unknown_and_an_explicit_reject_does_not_persist() {
    let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
    let known_hosts_path = unique_temp_known_hosts_path("reject");
    assert!(!known_hosts_path.exists());

    let state = Arc::new(AppState::default());
    let p = TofuPolicy::new(
        String::new(),
        known_hosts_path.clone(),
        state.clone(),
        Arc::new(ChannelSink(req_tx)),
        Duration::from_secs(5),
    );

    let responder = std::thread::spawn(move || {
        let req = req_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("decide() muss eine Rueckfrage stellen");
        assert!(respond_host_key_impl(&state, req.request_id, false).is_ok());
    });

    let accepted = p
        .decide("10.0.9.11", 22, "ssh-ed25519", "AAAAREJECTME")
        .await;
    assert!(
        !accepted,
        "ein expliziter Reject muss decide() false liefern lassen"
    );
    tokio::task::spawn_blocking(move || responder.join())
        .await
        .unwrap()
        .unwrap();

    assert!(
        !known_hosts_path.exists(),
        "ein abgelehnter Schluessel darf niemals persistiert werden"
    );
}

/// Ein Zeitablauf OHNE jede Antwort ist eine Ablehnung. Drei unabhaengige
/// Assertions, keine davon allein wuerde reichen:
///   (a) `decide()` liefert `false`,
///   (b) es wurde tatsaechlich GENAU EINE Rueckfrage gestellt -- der
///       Nutzer haette also wirklich die Chance gehabt zu antworten
///       (eine Implementierung, die `Unknown` weiterhin sofort UND
///       ohne jede Rueckfrage ablehnt, waere sonst nicht von einer
///       echten TOFU-Rueckfrage zu unterscheiden),
///   (c) die verstrichene Zeit ist mindestens der konfigurierte
///       Timeout -- eine Implementierung, die vorzeitig `false`
///       zurueckgibt, waere sonst nicht von "hat wirklich gewartet" zu
///       unterscheiden.
///
/// Historische GEGENPROBE: der damalige synchrone
/// Timeout-Zweig wurde probeweise auf `true` statt `false` gesetzt
/// (simuliert einen Zeitablauf-als-Annahme-Bug). Dieser Test wurde rot
/// (`assert!(!accepted, ...)` schlug fehl: "false-Erwartung, bekam
/// true"). Fix zurueckgesetzt, Test wieder gruen.
#[tokio::test]
async fn tofu_policy_times_out_as_rejection_when_nobody_responds() {
    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let known_hosts_path = unique_temp_known_hosts_path("timeout");
    let timeout = Duration::from_millis(150);

    let p = policy_with(
        "",
        known_hosts_path.clone(),
        Arc::new(RecordingSink(recorded.clone())),
        timeout,
    );

    let start = std::time::Instant::now();
    // Muss gueltiges Base64 sein (Laenge Vielfaches von 4) -- sonst
    // schlaegt schon `known_hosts::fingerprint` fehl und `decide` lehnt
    // VOR dem Stellen der Rueckfrage ab (ein anderer, hier nicht
    // gemeinter Codepfad, siehe
    // `tofu_policy_rejects_undecodable_key_instead_of_prompting_with_a_placeholder`).
    let accepted = p
        .decide("10.0.9.12", 22, "ssh-ed25519", "AAAATIMEDOUTKEY0")
        .await;
    let elapsed = start.elapsed();

    assert!(
        !accepted,
        "keine Antwort innerhalb des Timeouts muss als Ablehnung gelten"
    );
    assert_eq!(
        recorded.lock().unwrap().len(),
        1,
        "es muss genau eine Rueckfrage gestellt worden sein -- der Nutzer muss \
         tatsaechlich die Chance gehabt haben zu antworten"
    );
    assert!(
        elapsed >= timeout,
        "decide() muss den vollen Timeout abwarten, nicht vorzeitig zurueckkehren -- \
         wartete nur {elapsed:?} bei konfiguriertem {timeout:?}"
    );
    assert!(
        !known_hosts_path.exists(),
        "ein per Zeitablauf abgelehnter Schluessel darf niemals persistiert werden"
    );
}

#[tokio::test]
async fn tofu_policy_cancel_closes_only_its_prompt_and_rejects_a_late_accept() {
    let state = Arc::new(AppState::default());
    let (sink, mut requests) = lifecycle_sink();
    let control = ConnectControl::default();
    let cancelled_path = unique_temp_known_hosts_path("cancelled");
    let other_path = unique_temp_known_hosts_path("other_pending");
    let cancelled_policy = TofuPolicy::with_control(
        String::new(),
        cancelled_path.clone(),
        state.clone(),
        sink.clone(),
        Duration::from_secs(5),
        control.clone(),
    );
    let other_policy = TofuPolicy::new(
        String::new(),
        other_path.clone(),
        state.clone(),
        sink.clone(),
        Duration::from_secs(5),
    );
    let mut cancelled = cancelled_policy.decide("10.0.9.40", 22, "ssh-ed25519", UNKNOWN_KEY);
    let cancelled_request = prompt_while_pending(&mut cancelled, &mut requests).await;
    let mut other = other_policy.decide("10.0.9.41", 22, "ssh-ed25519", UNKNOWN_KEY);
    let other_request = prompt_while_pending(&mut other, &mut requests).await;
    assert_ne!(cancelled_request.request_id, other_request.request_id);
    assert_eq!(state.pending_host_key.lock().unwrap().len(), 2);

    control.cancel();
    // Auch vor dem naechsten Poll der Policy darf Cancel nicht mehr
    // durch eine spaete positive IPC-Antwort ueberholt werden.
    assert!(respond_host_key_impl(&state, cancelled_request.request_id, true).is_err());
    assert!(!tokio::time::timeout(Duration::from_secs(1), cancelled)
        .await
        .expect("cancel must wake the pending policy"));
    {
        let pending = state.pending_host_key.lock().unwrap();
        assert!(!pending.contains_key(&cancelled_request.request_id));
        assert!(pending.contains_key(&other_request.request_id));
        assert_eq!(pending.len(), 1);
    }
    assert_eq!(sink.closed.lock().unwrap().len(), 1);
    assert_request_closed(&sink, &cancelled_request, "cancelled");
    assert!(respond_host_key_impl(&state, cancelled_request.request_id, true).is_err());
    assert!(!cancelled_path.exists());

    assert!(respond_host_key_impl(&state, other_request.request_id, false).is_ok());
    assert!(!other.await);
    assert_request_closed(&sink, &other_request, "answered");
    assert_eq!(sink.closed.lock().unwrap().len(), 2);
    assert!(state.pending_host_key.lock().unwrap().is_empty());
    assert!(!other_path.exists());
}

#[tokio::test]
async fn tofu_policy_dropping_the_outer_future_closes_the_prompt_and_rejects_late_accept() {
    let state = Arc::new(AppState::default());
    let (sink, mut requests) = lifecycle_sink();
    let path = unique_temp_known_hosts_path("future_drop");
    let policy = TofuPolicy::new(
        String::new(),
        path.clone(),
        state.clone(),
        sink.clone(),
        Duration::from_secs(5),
    );
    let mut decision = policy.decide("10.0.9.42", 22, "ssh-ed25519", UNKNOWN_KEY);
    let request = prompt_while_pending(&mut decision, &mut requests).await;
    assert!(state
        .pending_host_key
        .lock()
        .unwrap()
        .contains_key(&request.request_id));

    drop(decision);

    assert!(state.pending_host_key.lock().unwrap().is_empty());
    assert_eq!(sink.closed.lock().unwrap().len(), 1);
    assert_request_closed(&sink, &request, "cancelled");
    assert!(respond_host_key_impl(&state, request.request_id, true).is_err());
    assert!(!path.exists());
}

#[tokio::test]
async fn tofu_policy_accepted_unknown_preserves_subsequent_auth_error_classification() {
    let state = Arc::new(AppState::default());
    let (sink, mut requests) = lifecycle_sink();
    let path = unique_temp_known_hosts_path("accepted_auth_error");
    let policy = TofuPolicy::new(
        String::new(),
        path.clone(),
        state.clone(),
        sink.clone(),
        Duration::from_secs(5),
    );
    let mut decision = policy.decide("10.0.9.43", 22, "ssh-ed25519", UNKNOWN_KEY);
    let request = prompt_while_pending(&mut decision, &mut requests).await;
    assert_eq!(policy.last_decision(), Some(HostKeyDecision::Unknown));
    assert!(respond_host_key_impl(&state, request.request_id, true).is_ok());
    assert!(decision.await);
    assert_eq!(policy.last_decision(), Some(HostKeyDecision::Known));
    assert_request_closed(&sink, &request, "answered");
    assert!(state.pending_host_key.lock().unwrap().is_empty());
    for (error, code) in [
        (AuthError::SigningFailed, "auth_rejected"),
        (AuthError::PasswordWrong, "password_required"),
    ] {
        let expected_message = error.user_message();
        let classified = classify_connect_error(
            &anyhow::Error::from(error).context("authentication after accepted host key"),
            policy.last_decision(),
            "10.0.9.43",
        );
        assert_eq!(classified.code, code);
        assert_eq!(classified.message, expected_message);
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        format!("10.0.9.43 ssh-ed25519 {UNKNOWN_KEY}\n")
    );
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn tofu_policy_shorter_prompt_deadline_closes_pending_and_rejects_late_accept() {
    let state = Arc::new(AppState::default());
    let (sink, mut requests) = lifecycle_sink();
    let path = unique_temp_known_hosts_path("short_prompt_deadline");
    // Die Promptfrist ist absichtlich kuerzer als TOFU- und Gesamtbudget:
    // Die Policy muss dieselbe Frist abwarten, die sie dem Overlay meldet.
    let prompt_timeout = Duration::from_millis(60);
    let control = ConnectControl::new(ConnectLimits {
        tofu: Duration::from_secs(5),
        total: Duration::from_secs(5),
        ..ConnectLimits::default()
    });
    let policy = TofuPolicy::with_control(
        String::new(),
        path.clone(),
        state.clone(),
        sink.clone(),
        prompt_timeout,
        control,
    );
    let before = tokio::time::Instant::now();
    let mut decision = policy.decide("10.0.9.44", 22, "ssh-ed25519", UNKNOWN_KEY);
    let request = prompt_while_pending(&mut decision, &mut requests).await;
    let registered_deadline = state.pending_host_key.lock().unwrap()[&request.request_id].deadline;
    assert!(registered_deadline >= before + prompt_timeout);
    assert!(registered_deadline <= tokio::time::Instant::now() + prompt_timeout);

    assert!(!tokio::time::timeout(Duration::from_secs(1), decision)
        .await
        .expect("the prompt deadline must win over the longer connect budgets"));
    assert!(tokio::time::Instant::now() >= registered_deadline);
    assert!(state.pending_host_key.lock().unwrap().is_empty());
    assert_eq!(sink.closed.lock().unwrap().len(), 1);
    assert_request_closed(&sink, &request, "expired");
    assert!(respond_host_key_impl(&state, request.request_id, true).is_err());
    assert!(!path.exists());
}

#[tokio::test]
async fn tofu_policy_expired_request_rejects_accept_before_the_policy_is_polled_again() {
    let state = Arc::new(AppState::default());
    let (sink, mut requests) = lifecycle_sink();
    let path = unique_temp_known_hosts_path("expired_unpolled");
    let policy = TofuPolicy::new(
        String::new(),
        path.clone(),
        state.clone(),
        sink.clone(),
        Duration::from_millis(60),
    );
    let mut decision = policy.decide("10.0.9.45", 22, "ssh-ed25519", UNKNOWN_KEY);
    let request = prompt_while_pending(&mut decision, &mut requests).await;
    let deadline = state.pending_host_key.lock().unwrap()[&request.request_id].deadline;
    tokio::time::sleep_until(deadline).await;
    assert!(respond_host_key_impl(&state, request.request_id, true).is_err());
    assert!(!decision.await);
    assert!(state.pending_host_key.lock().unwrap().is_empty());
    assert_eq!(sink.closed.lock().unwrap().len(), 1);
    assert_request_closed(&sink, &request, "expired");
    assert!(!path.exists());
}

/// Ein Schluessel, dessen Base64 sich nicht dekodieren laesst, wird
/// abgelehnt, statt mit einem Platzhalter zur Bestaetigung angezeigt
/// zu werden (siehe `known_hosts::fingerprint`s Doc-Kommentar).
#[tokio::test]
async fn tofu_policy_rejects_undecodable_key_instead_of_prompting_with_a_placeholder() {
    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let p = policy_with(
        "",
        unique_temp_known_hosts_path("undecodable"),
        Arc::new(RecordingSink(recorded.clone())),
        Duration::from_millis(50),
    );
    let accepted = p
        .decide("10.0.9.13", 22, "ssh-ed25519", "!!!not-base64!!!")
        .await;
    assert!(!accepted);
    assert!(
        recorded.lock().unwrap().is_empty(),
        "ein Schluessel ohne anzeigbaren Fingerabdruck darf gar nicht erst zur \
         Bestaetigung angeboten werden"
    );
}

/// `respond_host_key_impl` lehnt eine `request_id` ab, die nie registriert
/// wurde (z. B. ein Tippfehler, ein veralteter Client, oder ein Aufruf, der
/// aus einer anderen Instanz stammt). Ohne diese Pruefung koennte
/// `resolve_host_key_request`s `bool`-Rueckgabewert stillschweigend ignoriert
/// werden, ohne dass ein Test das je bemerken wuerde.
#[test]
fn respond_host_key_impl_returns_an_error_for_an_unknown_request_id() {
    let state = Arc::new(AppState::default());
    let result = respond_host_key_impl(&state, 424242, true);
    assert!(
        result.is_err(),
        "eine nie registrierte request_id darf niemals als Erfolg gelten"
    );
}

/// Eine bereits beantwortete Anfrage darf kein ZWEITES Mal aufgeloest werden
/// -- `resolve_host_key_request` entfernt den Eintrag beim ersten Erfolg
/// (`HashMap::remove`), ein zweiter Aufruf mit derselben `id` findet ihn nicht
/// mehr. Deckt denselben Codepfad ab, den auch eine per Zeitablauf laengst
/// vergessene Anfrage traefe (siehe `forget_host_key_request`s Doc-Kommentar)
/// -- beide raeumen denselben Map-Eintrag weg, bevor ein zweiter
/// `respond_host_key`-Aufruf ihn noch vorfaende.
#[test]
fn respond_host_key_impl_returns_an_error_when_the_same_request_id_is_answered_twice() {
    let state = Arc::new(AppState::default());
    let control = ConnectControl::default();
    let (id, _rx) = state.register_host_key_request(control.clone(), control.tofu_deadline());

    assert!(
        respond_host_key_impl(&state, id, true).is_ok(),
        "die erste Antwort auf eine wartende Anfrage muss erfolgreich sein"
    );
    let second = respond_host_key_impl(&state, id, true);
    assert!(
        second.is_err(),
        "eine zweite Antwort auf dieselbe, bereits aufgeloeste request_id muss \
         fehlschlagen, nicht stillschweigend erneut erfolgreich sein"
    );
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Das Overlay muss die Restzeit anzeigen koennen -- dafuer muss
/// `expires_at_unix_ms` ungefaehr `jetzt + prompt_timeout` sein, gemessen zum
/// Zeitpunkt der Anfrage (nicht z. B. zum Zeitpunkt einer spaeteren Antwort).
/// Anfrage und wartende Policy werden auf derselben Runtime gepollt; kein
/// Kanalempfang blockiert sie.
#[tokio::test]
async fn tofu_policy_sets_the_requests_deadline_to_roughly_now_plus_the_configured_timeout() {
    let timeout = Duration::from_millis(200);
    let (sink, mut requests) = lifecycle_sink();
    let p = policy_with("", unique_temp_known_hosts_path("deadline"), sink, timeout);

    let before_ms = now_unix_ms();
    let mut decision = p.decide("10.0.9.30", 22, "ssh-ed25519", "AAAADEADLINEKEY0");
    let req = prompt_while_pending(&mut decision, &mut requests).await;
    let after_ms = now_unix_ms();

    assert!(
        req.expires_at_unix_ms >= before_ms + timeout.as_millis() as u64,
        "Deadline liegt VOR now+timeout (expires_at_unix_ms={}, \
         before_ms+timeout={}) -- das Overlay wuerde dem Nutzer weniger \
         Zeit anzeigen, als er tatsaechlich hat",
        req.expires_at_unix_ms,
        before_ms + timeout.as_millis() as u64
    );
    assert!(
        req.expires_at_unix_ms <= after_ms + timeout.as_millis() as u64,
        "Deadline liegt unplausibel weit in der Zukunft (expires_at_unix_ms={}, \
         after_ms+timeout={})",
        req.expires_at_unix_ms,
        after_ms + timeout.as_millis() as u64
    );

    assert!(!decision.await);
}

/// Sink, der Anfragen ueber einen Kanal weiterleitet (wie `ChannelSink` oben)
/// UND zusaetzlich jeden `notify_persist_failed`-Aufruf aufzeichnet -- fuer
/// die beiden Tests unten, die belegen muessen, dass DIESES Ereignis genau
/// dann und nur dann ausgeloest wird, wenn `append_entry` tatsaechlich
/// fehlschlaegt.
struct ChannelAndPersistFailureSink {
    req_tx: std::sync::mpsc::Sender<HostKeyRequest>,
    persist_failures: Arc<std::sync::Mutex<Vec<(String, u16)>>>,
}
impl HostKeyRequestSink for ChannelAndPersistFailureSink {
    fn request(&self, req: &HostKeyRequest) -> bool {
        self.req_tx.send(req.clone()).is_ok()
    }
    fn notify_persist_failed(&self, host: &str, port: u16, _message: &str) {
        self.persist_failures
            .lock()
            .unwrap()
            .push((host.to_string(), port));
    }
}

/// Legt fuer die Dauer des Tests ein leeres Verzeichnis an den
/// known_hosts-Pfad, damit `known_hosts::append_entry`s
/// `OpenOptions::create(true).append(true).open(..)` garantiert
/// fehlschlaegt: unter Linux und macOS mit EISDIR, und zwar auch fuer
/// root, der ein Schreibschutzbit einfach uebergehen wuerde; unter
/// Windows mit "Zugriff verweigert", weil sich ein Verzeichnis ohne
/// `FILE_FLAG_BACKUP_SEMANTICS` nicht oeffnen laesst.
///
/// Scheitern darf dabei nur das Oeffnen zum Anhaengen:
/// `TofuPolicy::decide` entscheidet ueber den uebergebenen
/// known_hosts-Text im Speicher und fasst den Pfad dafuer nicht an, und
/// `append_entry` liest den Pfad vor dem Oeffnen mit
/// `read(..).unwrap_or_default()`, sodass der Lesefehler am Verzeichnis
/// nur als leere Datei zaehlt. `Drop` entfernt das Verzeichnis mit
/// `remove_dir`, das ausschliesslich leere Verzeichnisse loescht.
struct KnownHostsDirectoryGuard(PathBuf);
impl KnownHostsDirectoryGuard {
    fn new(path: PathBuf) -> Self {
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for KnownHostsDirectoryGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// GEGENPROBE: mit `self.sink.notify_persist_failed(..)`
/// probeweise entfernt (nur noch `eprintln!`), wurde dieser Test rot --
/// `persist_failures.lock().unwrap().as_slice()` war leer statt der
/// erwarteten einen Zeile. Fix zurueckgesetzt, Test wieder gruen.
#[tokio::test]
async fn tofu_policy_notifies_the_sink_when_append_entry_fails_but_still_accepts_the_connection() {
    let known_hosts_path = unique_temp_known_hosts_path("persist_fail");
    let _guard = KnownHostsDirectoryGuard::new(known_hosts_path.clone());

    let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
    let persist_failures = Arc::new(std::sync::Mutex::new(Vec::new()));
    let state = Arc::new(AppState::default());
    let p = TofuPolicy::new(
        String::new(),
        known_hosts_path,
        state.clone(),
        Arc::new(ChannelAndPersistFailureSink {
            req_tx,
            persist_failures: persist_failures.clone(),
        }),
        Duration::from_secs(5),
    );

    let responder = std::thread::spawn(move || {
        let req = req_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("decide() muss fuer Unknown eine Rueckfrage stellen");
        assert!(respond_host_key_impl(&state, req.request_id, true).is_ok());
    });

    let accepted = p
        .decide("10.0.9.20", 22, "ssh-ed25519", "AAAAPERSISTFAILKEY00")
        .await;
    tokio::task::spawn_blocking(move || responder.join())
        .await
        .unwrap()
        .expect("Antwort-Thread darf nicht paniken");

    assert!(
        accepted,
        "ein Schreibfehlschlag beim Persistieren darf die fuer DIESE \
         Verbindung bereits erteilte Zustimmung nicht rueckwirkend \
         verwerfen (Kompromiss aus dem Befund: die Verbindung bleibt \
         bestehen, nur die Dauerhaftigkeit geht verloren)"
    );
    assert_eq!(
        persist_failures.lock().unwrap().as_slice(),
        &[("10.0.9.20".to_string(), 22)],
        "ein fehlgeschlagenes append_entry muss ueber den Sink an die \
         Oberflaeche gemeldet werden -- eine `eprintln!`-Zeile allein \
         sieht in einer gepackten Anwendung niemand, und der Nutzer \
         haelt die naechste, erneute Rueckfrage sonst faelschlich fuer \
         einen Fehler"
    );
}

/// Gegenstueck zum Test oben: ein ERFOLGREICHES `append_entry` darf
/// `notify_persist_failed` NICHT ausloesen. Ohne diesen Test wuerde ein
/// zu grosszuegiger Fix (der den Sink bei JEDEM Accept benachrichtigt,
/// nicht nur bei einem tatsaechlichen Fehlschlag) den Test oben
/// trotzdem bestehen -- dieser Test schliesst genau diese Verwechslung
/// aus.
#[tokio::test]
async fn tofu_policy_does_not_notify_persist_failure_when_append_entry_succeeds() {
    let known_hosts_path = unique_temp_known_hosts_path("persist_ok");
    assert!(!known_hosts_path.exists());

    let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
    let persist_failures = Arc::new(std::sync::Mutex::new(Vec::new()));
    let state = Arc::new(AppState::default());
    let p = TofuPolicy::new(
        String::new(),
        known_hosts_path.clone(),
        state.clone(),
        Arc::new(ChannelAndPersistFailureSink {
            req_tx,
            persist_failures: persist_failures.clone(),
        }),
        Duration::from_secs(5),
    );

    let responder = std::thread::spawn(move || {
        let req = req_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("decide() muss fuer Unknown eine Rueckfrage stellen");
        assert!(respond_host_key_impl(&state, req.request_id, true).is_ok());
    });

    let accepted = p
        .decide("10.0.9.21", 22, "ssh-ed25519", "AAAAPERSISTOKKEY")
        .await;
    tokio::task::spawn_blocking(move || responder.join())
        .await
        .unwrap()
        .expect("Antwort-Thread darf nicht paniken");

    assert!(accepted);
    assert!(
        persist_failures.lock().unwrap().is_empty(),
        "ein ERFOLGREICHES append_entry darf keinen Persistenzfehler melden"
    );
    let _ = std::fs::remove_file(&known_hosts_path);
}
