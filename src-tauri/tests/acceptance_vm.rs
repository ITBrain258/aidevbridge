//! Maschinelle Abnahme gegen eine echte VM. Laeuft NUR, wenn
//! `AIDEVBRIDGE_VM_HOST`, `AIDEVBRIDGE_VM_USER`,
//! `AIDEVBRIDGE_VM_PASSWORD_USER` und ein isolierter
//! `AIDEVBRIDGE_TEST_SOCKET` gesetzt sind -- im Regellauf explizit
//! ignoriert, damit `cargo test` ohne Netz und ohne VM gruen bleibt.
//!
//! Was hier NICHT geprueft werden kann und deshalb Handarbeit bleibt:
//! Farben, Maus, Bracketed Paste, ob das Fenster unter Dauerlast einfriert.
//! Das sind Wahrnehmungsfragen. Sie stehen in
//! `docs/abnahme-handarbeit.md`.
//!
//! **Warum `connect_host` und `open_terminal` NICHT ueber IPC laufen, alles
//! andere schon.** `tauri::test`s `MockRuntime` + `get_ipc_response`
//! schickt einen Befehl durch denselben Pfad, den ein Knopfdruck nimmt
//! (`acl_runtime.rs` ist das Vorbild) -- das ist der Regelfall in dieser
//! Datei: `create_session`, `send_input`, `resize_terminal`, `ack_output`,
//! `close_terminal`, `disconnect_host`, `respond_host_key`,
//! `list_sessions` und `list_directories` laufen ALLE ueber echtes IPC.
//! Zwei Ausnahmen, aus zwei VERSCHIEDENEN Gruenden:
//!
//! - `connect_host` liest `~/.ssh/known_hosts` DES BEDIENRECHNERS fest
//!   verdrahtet (`connect_host_impl`, `commands.rs`) -- kein Parameter,
//!   keine Umgebungsvariable, kein Weg, ihn ueber IPC auf eine temporaere
//!   Datei umzubiegen. Ihn trotzdem ueber IPC zu rufen wuerde bei einem
//!   TOFU-Accept tatsaechlich in die echte Datei schreiben: exakt der
//!   Uebergriff, den dieses Projekt verbietet (siehe `acl_runtime.rs`s
//!   Modulkommentar zu `add_host`/`remove_host` fuer dieselbe Klasse
//!   Problem).
//! - `open_terminal` nimmt `app: AppHandle` entgegen -- ein NICHT generischer
//!   Typalias (`tauri::AppHandle` ohne Typparameter loest fest auf
//!   `AppHandle<Wry>` auf). Das ist ein ECHTER Compilerfehler, kein
//!   Designentscheid: `cargo test --no-run` mit `open_terminal` in
//!   `generate_handler!` scheitert mit "the trait bound `AppHandle:
//!   CommandArg<'_, MockRuntime>` is not satisfied" -- unter `MockRuntime`
//!   laesst sich dieser Command ueberhaupt nicht registrieren, unabhaengig
//!   von jeder Sicherheitsfrage.
//!
//! Beide Ausnahmen rufen deshalb den testbaren, Tauri-freien Kern direkt:
//! `connect_host_with_known_hosts` bzw. `open_terminal_impl` (beide
//! `commands.rs`) -- exakt das Muster, das `tests/integration_commands.rs`
//! bereits fuer `connect_host_with_known_hosts` verwendet, hier auf
//! `open_terminal_impl` erweitert (dessen `OutputSink`-Parameter ist
//! generisch, ein einfacher kanalbasierter Sink -- wie `ChannelSink` in
//! `integration_commands.rs` -- ersetzt `AppHandle` verlustfrei). Aus
//! demselben Grund wie bei `connect_host` laufen `add_host`/`remove_host`
//! in den drei Bearbeitungssequenzen unten ebenfalls nicht ueber IPC, sondern
//! ueber `add_host_impl`/`remove_host_impl` mit einem temporaeren
//! `settings_path` -- der echte Command schriebe sonst
//! `%APPDATA%\io.github.itbrain258.aidevbridge\settings.toml` des Bedienrechners.
//!
//! **Sonderregel, durchgaengig eingehalten:** kein Test in dieser Datei
//! liest oder schreibt `~/.ssh/known_hosts` des Bedienrechners. Jeder aus
//! einer Verbindung entstehende known_hosts-Zugriff bekommt eine frische
//! Datei unter `std::env::temp_dir()`, angelegt vom Test, geloescht nach
//! dem Test.
//!
//! **Sonderregel, durchgaengig eingehalten:** jede angelegte tmux-Session
//! traegt das `ab_`-Praefix (`create_session`s eigene Namensvergabe) und
//! wird am Ende per EXAKTEM Namen entfernt -- niemals `kill-server`. Andere
//! Sockets auf der VM (auch die abgeleiteten PTY-/tmux-Testsockets und
//! fremde Projekte) werden nie angefasst. Der gewaehlte Testsocket und
//! seine Suffixe muessen ausschliesslich fuer diesen Lauf reserviert sein.
//!
//! **Passwort-Testkonto.** Der dritte Anmeldezweig und der Fall "Methode
//! nicht angeboten" brauchen ein Wegwerfkonto auf der VM ohne
//! `authorized_keys`; seinen Namen nennt `AIDEVBRIDGE_VM_PASSWORD_USER`.
//! Sein Passwort steht NIRGENDS im Quelltext -- fehlt
//! `AIDEVBRIDGE_VM_PASSWORD`, wird der Passwortzweig uebersprungen, nicht rot.
//!
//! **ssh-agent ist Umgebungszustand, kein Testparameter.** `AuthMethod::
//! Agent` verwendet in der Produktion IMMER den echten Windows-Pipe- bzw.
//! Unix-Socket-Pfad (`ssh/auth.rs::connect_agent`) -- es gibt von aussen
//! keinen Weg, ihn auf einen absichtlich nicht existierenden Pfad
//! umzubiegen (das kann nur `ssh/auth.rs`s eigenes `#[cfg(test)]`-Modul).
//! Den echten Windows-Dienst aus einem Test heraus zu stoppen waere
//! dieselbe Art Uebergriff wie ein Test, der `~/.ssh/known_hosts`
//! anfasst -- deshalb PROBIERT dieser Test den Agenten nur und weicht auf
//! Basis des tatsaechlichen Ergebnisses aus (siehe `connect_succeeds_via_
//! ssh_agent_when_available` und den Agenten-Zweig in
//! `seven_failure_branches_are_pairwise_distinguishable`).

mod common;

use aidevbridge_lib::commands::{
    self, HostKeyRequest, HostKeyRequestSink, HostSpecDto, NewHostEntryDto,
};
use aidevbridge_lib::remote;
use aidevbridge_lib::settings;
use aidevbridge_lib::tmux::{OwnSocket, OwnTmuxClient};
use aidevbridge_lib::transport::{HostSpec, RusshTransport, Transport};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};

fn vm_host() -> Option<String> {
    common::configured_test_host("AIDEVBRIDGE_VM_HOST")
}

/// OHNE `#[ignore]` kehrte jeder dieser
/// Tests bei fehlendem `AIDEVBRIDGE_VM_HOST` einfach zurueck, und
/// `cargo test` meldete "9 passed" -- exakt dieselbe Zeile wie nach einem
/// echten VM-Lauf. 1348 Zeilen Abnahmecode waren damit auf einen Blick
/// nicht von "nie ausgefuehrt" zu unterscheiden, und ein gruener Lauf
/// behauptete eine Deckung, die es nicht gab.
///
/// `#[ignore]` macht den Unterschied im Testbericht sichtbar: ein normaler
/// `cargo test` meldet sie jetzt als `ignored`. Ausgefuehrt werden sie mit
/// `cargo test --test acceptance_vm -- --ignored` (dann muessen
/// `AIDEVBRIDGE_VM_HOST`, `AIDEVBRIDGE_VM_USER`,
/// `AIDEVBRIDGE_VM_PASSWORD_USER` und ein isolierter
/// `AIDEVBRIDGE_TEST_SOCKET` gesetzt sein; Host und Socket werden vor jedem
/// Testkoerper geprueft, die Konten beim ersten Gebrauch).
///
/// Und wer sie ausdruecklich anfordert, OHNE die Umgebung zu setzen, bekommt
/// einen Fehlschlag statt eines stillen Durchwinkens: das `panic!` unten ist
/// der ganze Punkt dieser Aenderung -- "ich wollte die VM-Tests laufen
/// lassen" und "sie liefen" duerfen nie wieder dasselbe Ergebnis anzeigen.
macro_rules! vm_test {
    ($name:ident, $body:expr) => {
        #[test]
        #[ignore = "braucht AIDEVBRIDGE_VM_HOST, AIDEVBRIDGE_VM_USER, AIDEVBRIDGE_VM_PASSWORD_USER und isolierten AIDEVBRIDGE_TEST_SOCKET; mit --ignored ausfuehren"]
        fn $name() {
            let Some(host) = vm_host() else {
                panic!(
                    "AIDEVBRIDGE_VM_HOST ist nicht gesetzt -- dieser Test wurde ausdruecklich \
                     angefordert (--ignored), kann ohne Ziel-VM aber nichts pruefen"
                );
            };
            $body(host)
        }
    };
}

// ---------------------------------------------------------------------
// Zielbeschreibung / Anmeldedaten aus der Umgebung.
// ---------------------------------------------------------------------

fn vm_user() -> String {
    common::live_test_user("AIDEVBRIDGE_VM_USER")
}

/// Wegwerfkonto ohne `authorized_keys` fuer den Passwortzweig und den Fall
/// "Methode nicht angeboten" (siehe Modulkommentar).
fn password_account() -> String {
    common::live_test_user("AIDEVBRIDGE_VM_PASSWORD_USER")
}

/// Schluesselpfad fuer den Schluessel- und den "Methode nicht angeboten"-
/// Zweig -- derselbe Vorgabe-Pfad wie in `tests/common/mod.rs::key_auth_
/// method`, konfigurierbar ueber `AIDEVBRIDGE_VM_KEY_PATH` fuer abweichende
/// Umgebungen.
fn vm_key_path() -> PathBuf {
    match std::env::var("AIDEVBRIDGE_VM_KEY_PATH") {
        Ok(p) => PathBuf::from(p),
        Err(_) => dirs::home_dir()
            .expect("HOME/USERPROFILE nicht ermittelbar")
            .join(".ssh")
            .join("id_ed25519"),
    }
}

fn key_spec(host: &str) -> HostSpecDto {
    HostSpecDto {
        hostname: host.to_string(),
        port: 22,
        user: vm_user(),
        key_path: Some(vm_key_path().display().to_string()),
        passphrase: None,
        password: None,
    }
}

fn agent_spec(host: &str) -> HostSpecDto {
    HostSpecDto {
        hostname: host.to_string(),
        port: 22,
        user: vm_user(),
        key_path: None,
        passphrase: None,
        password: None,
    }
}

fn password_account_spec(host: &str, password: String) -> HostSpecDto {
    HostSpecDto {
        hostname: host.to_string(),
        port: 22,
        user: password_account(),
        key_path: None,
        passphrase: None,
        password: Some(password.into()),
    }
}

/// Fuer den "Methode nicht angeboten"-Fehlerzweig: unser EIGENER, gueltiger
/// Schluessel gegen das Passwortkonto, das keine `authorized_keys` hat.
/// Der Schluessel laedt und entschluesselt sich einwandfrei -- der Server
/// lehnt die Methode fuer dieses Konto einfach ab (siehe `classify_
/// publickey_failure` in `ssh/auth.rs`).
fn password_account_key_spec(host: &str) -> HostSpecDto {
    HostSpecDto {
        hostname: host.to_string(),
        port: 22,
        user: password_account(),
        key_path: Some(vm_key_path().display().to_string()),
        passphrase: None,
        password: None,
    }
}

// ---------------------------------------------------------------------
// Temporaere Dateien -- niemals ~/.ssh/known_hosts oder %APPDATA%\...
// ---------------------------------------------------------------------

fn unique_temp_path(tag: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("aidevbridge_acceptance_vm_{tag}_{nanos}_{n}"))
}

/// Einmal pro Testlauf (ueber alle `#[test]`-Funktionen dieser Datei
/// gemeinsam genutzt, da `cargo test` sie im selben Prozess ausfuehrt):
/// verbindet gegen eine LEERE temporaere known_hosts-Kopie, akzeptiert den
/// tatsaechlich praesentierten Schluessel per TOFU und liefert genau die
/// Zeile zurueck, die `known_hosts::append_entry` (Produktionscode)
/// geschrieben hat. Das ist die Grundwahrheit fuer den echten Schluessel
/// dieses Hosts -- gewonnen aus dem echten SSH-Handshake, nicht aus einem
/// `ssh-keyscan`-Subprozess oder einer von Hand abgeschriebenen Konstante.
/// Kein Zugriff auf ~/.ssh/known_hosts des Bedienrechners.
fn bootstrap_known_hosts_line(host: &str) -> String {
    static LINE: OnceLock<String> = OnceLock::new();
    LINE.get_or_init(|| {
        let state = Arc::new(commands::AppState::with_own_socket(
            common::test_socket(),
        ));
        let path = unique_temp_path("bootstrap_known_hosts");
        assert!(!path.exists());

        struct Chan(std::sync::mpsc::Sender<HostKeyRequest>);
        impl HostKeyRequestSink for Chan {
            fn request(&self, req: &HostKeyRequest) -> bool {
                self.0.send(req.clone()).is_ok()
            }
        }
        let (tx, rx) = std::sync::mpsc::channel::<HostKeyRequest>();
        let state_for_responder = state.clone();
        let responder = std::thread::spawn(move || {
            let req = rx
                .recv()
                .expect("Bootstrap: erwartet eine TOFU-Rueckfrage fuer einen unbekannten Host");
            commands::respond_host_key_impl(&state_for_responder, req.request_id, true)
                .expect("Bootstrap: die Anfrage muss noch offen sein");
        });

        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            key_spec(host),
            String::new(),
            path.clone(),
            Arc::new(Chan(tx)),
            Duration::from_secs(15),
        ))
        .expect(
            "Bootstrap-Verbindung (Schluessel-Authentifizierung gegen das Testkonto) muss gelingen -- \
             sonst ist schon die Grundvoraussetzung aller weiteren Tests in dieser Datei \
             verletzt",
        );
        responder.join().expect("Antwort-Thread darf nicht paniken");
        tauri::async_runtime::block_on(commands::disconnect_host_impl(&state, host_id)).ok();

        let content = std::fs::read_to_string(&path)
            .expect("ein akzeptierter Unknown-Schluessel muss known_hosts tatsaechlich anlegen");
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            content.lines().count(),
            1,
            "Bootstrap erwartet genau eine Zeile aus einer leeren Datei: {content:?}"
        );
        content
    })
    .clone()
}

/// Frische temporaere known_hosts-Kopie, vorbelegt mit dem echten Eintrag
/// aus `bootstrap_known_hosts_line` -- fuer Tests, die den `Known`-Pfad
/// brauchen (kein TOFU-Prompt), z. B. um ueberhaupt bis zu `authenticate()`
/// vorzudringen.
fn seeded_known_hosts(host: &str, tag: &str) -> PathBuf {
    let path = unique_temp_path(tag);
    std::fs::write(&path, bootstrap_known_hosts_line(host)).expect("temp known_hosts schreiben");
    path
}

// ---------------------------------------------------------------------
// MockRuntime-App: derselbe IPC-Pfad wie ein Knopfdruck (siehe
// `acl_runtime.rs`), diesmal MIT echtem Invoke-Handler und geteiltem
// `AppState` -- `connect_host`/`add_host`/`remove_host` bewusst NICHT in
// dieser Liste, siehe Modulkommentar oben.
// ---------------------------------------------------------------------

const WINDOW_LABEL: &str = "main";

fn app_with_state(state: Arc<commands::AppState>) -> tauri::App<MockRuntime> {
    mock_builder()
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::send_input,
            commands::resize_terminal,
            commands::ack_output,
            commands::close_terminal,
            commands::disconnect_host,
            commands::respond_host_key,
            commands::list_sessions,
            commands::list_directories,
        ])
        .manage(state)
        .build(tauri::generate_context!())
        .expect("App liess sich nicht bauen")
}

fn webview(app: &tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, WINDOW_LABEL, Default::default())
        .build()
        .expect("Webview liess sich nicht bauen")
}

/// Schickt `cmd` mit `body` durch den echten IPC-Pfad (`on_message`, dort
/// die echte ACL-Pruefung, dann der `#[tauri::command]`-Wrapper) und gibt
/// die Antwort ROH zurueck.
///
/// Eigene Funktion neben `invoke_ok`/`invoke_err`, damit die
/// `InvokeRequest`-Konstruktion nur EINMAL dasteht: die beiden
/// Auswertungen unterscheiden sich ausschliesslich in der Erwartung, nicht
/// im Aufruf.
fn invoke_raw(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

/// Wie [`invoke_raw`], dekodiert aber eine ERFOLGREICHE Antwort als `T` und
/// panickt mit dem Fehlertext, wenn der Aufruf fehlschlaegt.
fn invoke_ok<T: serde::de::DeserializeOwned>(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> T {
    match invoke_raw(webview, cmd, body) {
        Ok(b) => b
            .deserialize::<T>()
            .unwrap_or_else(|e| panic!("Antwort von {cmd} liess sich nicht dekodieren: {e}")),
        Err(e) => panic!("IPC-Aufruf {cmd} schlug unerwartet fehl: {e}"),
    }
}

/// Wie [`invoke_raw`], aber fuer die Faelle, die FEHLSCHLAGEN muessen --
/// liefert die Fehlermeldung des Commands.
///
/// Gebraucht seit `list_directories`: dessen Fehlerzweige ("kein
/// Leserecht", "gibt es nicht") sind auf einer fremden VM der Normalfall
/// und muessen sich UNTERSCHEIDEN (Spec §6, §9). Anders als die
/// Auth-Fehlerzweige weiter oben hat dieser Command keinen Grund, den IPC-
/// Pfad zu meiden: er fasst weder known_hosts noch settings.toml an.
fn invoke_err(webview: &WebviewWindow<MockRuntime>, cmd: &str, body: serde_json::Value) -> String {
    match invoke_raw(webview, cmd, body) {
        Ok(_) => panic!("IPC-Aufruf {cmd} haette fehlschlagen muessen, war aber erfolgreich"),
        Err(e) => e.to_string(),
    }
}

// ---------------------------------------------------------------------
// Unabhaengige Verbindungen fuer Verifikation/Aufraeumen -- dasselbe Muster
// wie `tests/common/mod.rs::connect_test_host`, nur an `AIDEVBRIDGE_VM_HOST`
// statt `AIDEVBRIDGE_TEST_HOST` gebunden.
// ---------------------------------------------------------------------

fn independent_connection(host: &str) -> RusshTransport {
    let spec = HostSpec {
        hostname: host.to_string(),
        port: 22,
        user: vm_user(),
    };
    tauri::async_runtime::block_on(RusshTransport::connect(
        &spec,
        Arc::new(common::AcceptAll),
        &common::key_auth_method(),
    ))
    .expect("unabhaengige Verifikations-/Aufraeumverbindung muss gelingen")
}

// =======================================================================
// Schritt 2: die drei Anmeldezweige
// =======================================================================

vm_test!(connect_succeeds_via_stored_key, |host: String| {
    let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
    let app = app_with_state(state.clone());
    let wv = webview(&app);

    let seeded = seeded_known_hosts(&host, "auth_key");
    let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
        &state,
        key_spec(&host),
        bootstrap_known_hosts_line(&host),
        seeded.clone(),
        Arc::new(common::PanicIfAskedSink),
        Duration::from_secs(10),
    ))
    .expect("Schluessel-Authentifizierung muss gelingen");
    let _ = std::fs::remove_file(&seeded);
    assert!(tauri::async_runtime::block_on(state.has_host(&host_id)));

    let _: () = invoke_ok(
        &wv,
        "disconnect_host",
        serde_json::json!({"hostId": host_id}),
    );
    assert!(!tauri::async_runtime::block_on(state.has_host(&host_id)));
});

vm_test!(
    connect_succeeds_via_ssh_agent_when_available,
    |host: String| {
        // Adaptiv (siehe Modulkommentar): ssh-agent ist Umgebungszustand, nicht
        // vom Test steuerbar. Ein unerreichbarer/leerer Agent ist hier kein
        // Testfehlschlag, sondern ein uebersprungener Zweig mit sichtbarem Grund.
        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        let seeded = seeded_known_hosts(&host, "auth_agent");
        let result = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            agent_spec(&host),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ));
        let _ = std::fs::remove_file(&seeded);

        match result {
            Ok(host_id) => {
                assert!(tauri::async_runtime::block_on(state.has_host(&host_id)));
                let _: () = invoke_ok(
                    &wv,
                    "disconnect_host",
                    serde_json::json!({"hostId": host_id}),
                );
                assert!(!tauri::async_runtime::block_on(state.has_host(&host_id)));
            }
            Err(msg) => {
                eprintln!(
                    "uebersprungen (ssh-agent-Zweig): {msg} -- ssh-agent auf diesem Rechner nicht \
                 erreichbar oder ohne passende Identitaet fuer {}@{host}, siehe \
                 docs/abnahme-handarbeit.md",
                    vm_user()
                );
            }
        }
    }
);

vm_test!(
    connect_succeeds_via_password_when_configured,
    |host: String| {
        let Ok(password) = std::env::var("AIDEVBRIDGE_VM_PASSWORD") else {
            eprintln!(
                "uebersprungen: AIDEVBRIDGE_VM_PASSWORD nicht gesetzt -- Passwort-Zweig (Konto \
             aus AIDEVBRIDGE_VM_PASSWORD_USER) laesst sich ohne dieses Passwort nicht pruefen"
            );
            return;
        };

        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        let seeded = seeded_known_hosts(&host, "auth_password");
        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            password_account_spec(&host, password),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ))
        .expect("Passwort-Authentifizierung fuer das Passwortkonto muss gelingen");
        let _ = std::fs::remove_file(&seeded);
        assert!(tauri::async_runtime::block_on(state.has_host(&host_id)));

        let _: () = invoke_ok(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": host_id}),
        );
        assert!(!tauri::async_runtime::block_on(state.has_host(&host_id)));
    }
);

// =======================================================================
// Schritt 3: sieben Fehlerzweige, paarweise verschieden
//
// Diese Meldungen sind NICHT die sieben `AuthError`-Varianten (die
// umfassen z. B. `PassphraseRequired`, das hier nicht vorkommt) --
// es sind die sieben user-sichtbaren Situationen aus Gesamtentwurf §13,
// verteilt ueber den TOFU-Pfad (Mismatch) und den Auth-Pfad (sechs
// `AuthError`-Varianten). "Host nicht erreichbar" ist der TCP-Fehlschlag
// VOR jedem Host-Key-Check, nicht `AuthError::HostUnreachable` (das
// entsteht nur, wenn der Auth-Request selbst waehrenddessen abbricht --
// gegen eine gesunde VM praktisch nicht deterministisch auszuloesen).
// =======================================================================

vm_test!(
    seven_failure_branches_are_pairwise_distinguishable,
    |host: String| {
        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let mut messages: BTreeSet<String> = BTreeSet::new();
        let mut ran: Vec<&str> = Vec::new();
        let mut skipped: Vec<(&str, String)> = Vec::new();

        // 1. Host nicht erreichbar: derselbe Host, ein garantiert geschlossener
        // Port -- schnelles RST statt eines SYN-Timeouts auf eine unerreichbare
        // Adresse (empirisch geprueft). `tokio::time::timeout`
        // als Netz, falls eine Firewall den Port stattdessen stillschweigend
        // verwirft.
        {
            let unreachable = HostSpecDto {
                hostname: host.clone(),
                port: 65432,
                user: vm_user(),
                key_path: Some(vm_key_path().display().to_string()),
                passphrase: None,
                password: None,
            };
            let kh_path = unique_temp_path("fail_unreachable");
            let outcome = tauri::async_runtime::block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(20),
                    commands::connect_host_with_known_hosts(
                        &state,
                        unreachable,
                        String::new(),
                        kh_path.clone(),
                        Arc::new(common::PanicIfAskedSink),
                        Duration::from_secs(5),
                    ),
                )
                .await
            });
            let _ = std::fs::remove_file(&kh_path);
            let msg = match outcome {
                Ok(Ok(_)) => {
                    panic!("Verbindung zu einem geschlossenen Port haette fehlschlagen muessen")
                }
                Ok(Err(e)) => e,
                // Kein Rueckfall auf eine EIGENE Zeichenkette des Tests
                // (etwa "connect attempt to a closed port timed out"): sie
                // ginge in `messages` ein und balancierte
                // `assert_eq!(messages.len(), ran.len())` kuenstlich aus --
                // ausgerechnet der Zweig, der die Meldung des PRODUKTS auf
                // Unterscheidbarkeit pruefen soll, pruefte damit den
                // selbstgeschriebenen Text des Tests. Ein Rueckfall, der den
                // zu pruefenden Wert erfindet, ist wertlos: laeuft der
                // Versuch in den Timeout, hat dieser Zweig nichts gemessen
                // und MUSS das sagen.
                Err(_elapsed) => panic!(
                    "Verbindungsversuch auf den geschlossenen Port 65432 lief in den 20s-Timeout \
                     -- dieser Zweig konnte die Meldung des Produkts nicht pruefen (erwartet war \
                     ein sofortiges RST; verwirft eine Firewall die Pakete stillschweigend, \
                     braucht dieser Fehlerzweig ein anderes Ziel)"
                ),
            };
            assert!(
                messages.insert(msg.clone()),
                "Kollision bereits bei der ersten Meldung (host unreachable): {msg:?}"
            );
            ran.push("host unreachable");
        }

        // 2. Host-Key abgelehnt (Mismatch): ein vorhandener, aber FALSCHER
        // Eintrag -- braucht NICHT den echten Schluessel, jede abweichende
        // Base64-Zeichenkette fuer denselben Host:Port loest Mismatch aus.
        {
            let mismatch_text =
            format!("{host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
            let kh_path = unique_temp_path("fail_mismatch");
            let err = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
                &state,
                key_spec(&host),
                mismatch_text,
                kh_path.clone(),
                Arc::new(common::PanicIfAskedSink),
                Duration::from_secs(5),
            ))
            .expect_err("ein vorhandener, falscher Eintrag darf nie akzeptiert werden");
            assert!(
                !kh_path.exists(),
                "Mismatch darf known_hosts niemals anlegen/aendern"
            );
            assert!(
                messages.insert(err.clone()),
                "Kollision bei 'host key rejected': {err:?}"
            );
            ran.push("host key rejected");
        }

        // 3. Schluessel nicht lesbar: Known known_hosts (kommt bis zu
        // `authenticate()`), aber ein garantiert nicht existierender Pfad.
        {
            let missing_key = unique_temp_path("fail_missing_key_file");
            assert!(!missing_key.exists());
            let spec = HostSpecDto {
                hostname: host.clone(),
                port: 22,
                user: vm_user(),
                key_path: Some(missing_key.display().to_string()),
                passphrase: None,
                password: None,
            };
            let seeded = seeded_known_hosts(&host, "fail_key_unreadable");
            let err = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
                &state,
                spec,
                bootstrap_known_hosts_line(&host),
                seeded.clone(),
                Arc::new(common::PanicIfAskedSink),
                Duration::from_secs(10),
            ))
            .expect_err("ein nicht existierender Schluesselpfad darf nie erfolgreich sein");
            let _ = std::fs::remove_file(&seeded);
            assert!(
                messages.insert(err.clone()),
                "Kollision bei 'key unreadable': {err:?}"
            );
            ran.push("key unreadable");
        }

        // 4. Falsche Passphrase: ein ECHTER, per `ssh-keygen` lokal erzeugter
        // verschluesselter Schluessel, absichtlich falsche Passphrase.
        {
            let key_path = unique_temp_path("fail_wrong_passphrase_key");
            let status = std::process::Command::new("ssh-keygen")
                .args(["-t", "ed25519", "-f"])
                .arg(&key_path)
                .args(["-N", "richtige-passphrase-fuer-diesen-test", "-q"])
                .status()
                .expect(
                    "ssh-keygen liess sich nicht starten (wird fuer diesen Fehlerzweig gebraucht)",
                );
            assert!(status.success(), "ssh-keygen schlug fehl");

            let spec = HostSpecDto {
                hostname: host.clone(),
                port: 22,
                user: vm_user(),
                key_path: Some(key_path.display().to_string()),
                passphrase: Some("definitiv-falsche-passphrase".to_string().into()),
                password: None,
            };
            let seeded = seeded_known_hosts(&host, "fail_wrong_passphrase");
            let err = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
                &state,
                spec,
                bootstrap_known_hosts_line(&host),
                seeded.clone(),
                Arc::new(common::PanicIfAskedSink),
                Duration::from_secs(10),
            ))
            .expect_err("eine falsche Passphrase darf nie erfolgreich sein");
            let _ = std::fs::remove_file(&seeded);
            let _ = std::fs::remove_file(&key_path);
            let _ = std::fs::remove_file(key_path.with_extension("pub"));
            assert!(
                messages.insert(err.clone()),
                "Kollision bei 'wrong passphrase': {err:?}"
            );
            ran.push("wrong passphrase");
        }

        // 5. Falsches Passwort: kein Geheimnis noetig (die Zeichenkette ist
        // absichtlich falsch, kein echtes Anmeldedatum) -- laeuft deshalb IMMER,
        // unabhaengig von AIDEVBRIDGE_VM_PASSWORD.
        {
            let seeded = seeded_known_hosts(&host, "fail_wrong_password");
            let err = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
                &state,
                password_account_spec(&host, "definitiv-falsches-passwort-xyz".to_string()),
                bootstrap_known_hosts_line(&host),
                seeded.clone(),
                Arc::new(common::PanicIfAskedSink),
                Duration::from_secs(10),
            ))
            .expect_err("ein falsches Passwort darf nie erfolgreich sein");
            let _ = std::fs::remove_file(&seeded);
            assert!(
                messages.insert(err.clone()),
                "Kollision bei 'wrong password': {err:?}"
            );
            ran.push("wrong password");
        }

        // 7 VOR 6: die Meldung von "method not offered" wird als
        // Vergleichswert fuer die Agenten-Probe unten gebraucht (siehe dort).
        let method_not_offered_message = {
            let seeded = seeded_known_hosts(&host, "fail_method_not_offered");
            let err = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
                &state,
                password_account_key_spec(&host),
                bootstrap_known_hosts_line(&host),
                seeded.clone(),
                Arc::new(common::PanicIfAskedSink),
                Duration::from_secs(10),
            ))
            .expect_err(
                "unser eigener Schluessel gegen das Passwortkonto (keine authorized_keys) darf nie \
             erfolgreich sein",
            );
            let _ = std::fs::remove_file(&seeded);
            assert!(
                messages.insert(err.clone()),
                "Kollision bei 'method not offered': {err:?}"
            );
            ran.push("method not offered");
            err
        };

        // 6. Agent nicht erreichbar: adaptiv, siehe Modulkommentar. Nur
        // aufgenommen, wenn der Agent WIRKLICH nicht erreichbar ist -- ein
        // erfolgreicher Verbindungsaufbau oder eine mit (7) kollidierende
        // Meldung (Agent erreichbar, aber Identitaet fuer dieses Konto
        // abgelehnt) zaehlen NICHT als eigener, reproduzierter Fehlerfall.
        {
            let seeded = seeded_known_hosts(&host, "fail_agent_probe");
            let result = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
                &state,
                agent_spec(&host),
                bootstrap_known_hosts_line(&host),
                seeded.clone(),
                Arc::new(common::PanicIfAskedSink),
                Duration::from_secs(10),
            ));
            let _ = std::fs::remove_file(&seeded);
            match result {
                Ok(host_id) => {
                    tauri::async_runtime::block_on(commands::disconnect_host_impl(&state, host_id))
                        .ok();
                    skipped.push((
                        "agent unavailable",
                        "ssh-agent ist auf diesem Rechner erreichbar und funktionsfaehig -- der \
                     Fehlerfall laesst sich nicht reproduzieren, ohne den Windows-Dienst \
                     absichtlich zu stoppen (das waere derselbe Uebergriff wie ein Test, der \
                     known_hosts anfasst)"
                            .to_string(),
                    ));
                }
                Err(msg) if msg == method_not_offered_message => {
                    skipped.push((
                        "agent unavailable",
                        format!(
                            "ssh-agent ist erreichbar, die geladene Identitaet wird von \
                         {}@{host} nur abgelehnt -- dieselbe Meldung wie 'method not offered' \
                         ({msg:?}), kein eigener Fehlerfall",
                            vm_user()
                        ),
                    ));
                }
                Err(msg) => {
                    assert!(
                        messages.insert(msg.clone()),
                        "Kollision bei 'agent unavailable': {msg:?}"
                    );
                    ran.push("agent unavailable");
                }
            }
        }

        eprintln!(
            "Fehlerzweige tatsaechlich ausgefuehrt ({}): {ran:?}",
            ran.len()
        );
        for (name, reason) in &skipped {
            eprintln!("uebersprungen ({name}): {reason}");
        }
        for msg in &messages {
            eprintln!("  Meldung: {msg:?}");
        }

        // Die eigentliche Zusicherung: keine zwei Faelle liefern dieselbe
        // Meldung. `messages.len() == ran.len()` macht das PRUEFBAR statt nur
        // behauptet -- ein BTreeSet, das durch stille Kollisionen kleiner
        // bleibt als die Anzahl der Versuche, waere sonst unbemerkt gruen.
        assert_eq!(
            messages.len(),
            ran.len(),
            "zwei oder mehr Fehlerfaelle lieferten dieselbe Meldung -- Gesamtentwurf §13 verlangt \
         Unterscheidbarkeit. Ausgefuehrt: {ran:?}, aber nur {} verschiedene Meldungen",
            messages.len()
        );
        // Bewusst kein `assert!(ran.len() >= 6)` -- eine Zusicherung, die NIE
        // fehlschlagen koennte. Sechs der sieben Zweige oben pushen
        // unbedingt (nur "agent unavailable" ist adaptiv), `ran.len()` ist an
        // dieser Stelle also mindestens 6, egal was die Zweige gemessen
        // haben. Sie laese sich wie eine Deckungsuntergrenze und waere in
        // Wahrheit eine Tautologie.
        //
        // Was stattdessen tatsaechlich fehlschlagen KANN: jeder der sieben
        // Zweige muss sich am Ende entweder als ausgefuehrt ODER als
        // begruendet uebersprungen wiederfinden. Verschwindet einer bei
        // einer kuenftigen Umarbeitung, oder faellt einer still durch beide
        // Raster, faellt genau das hier auf.
        assert_eq!(
            ran.len() + skipped.len(),
            7,
            "jeder der sieben Fehlerzweige muss entweder ausgefuehrt oder begruendet \
         uebersprungen sein -- ausgefuehrt: {ran:?}, uebersprungen: {:?}",
            skipped.iter().map(|(name, _)| *name).collect::<Vec<_>>()
        );
        // Nur "agent unavailable" darf sich der Reproduktion entziehen
        // (siehe dessen Kommentar oben). Ueberspringt ein Lauf mehr als
        // diesen einen, ist die Aussage des Tests zu schwach, um sie
        // stillschweigend hinzunehmen.
        assert!(
            skipped.len() <= 1,
            "hoechstens EIN Fehlerzweig darf sich der Reproduktion entziehen, uebersprungen \
         wurden {}: {skipped:?}",
            skipped.len()
        );
    }
);

// =======================================================================
// Schritt 4: TOFU in beide Richtungen
// =======================================================================

vm_test!(
    tofu_reject_leaves_known_hosts_untouched_and_accept_appends_a_byte_identical_line,
    |host: String| {
        struct Chan(std::sync::mpsc::Sender<HostKeyRequest>);
        impl HostKeyRequestSink for Chan {
            fn request(&self, req: &HostKeyRequest) -> bool {
                self.0.send(req.clone()).is_ok()
            }
        }

        // Phase A: leere temporaere known_hosts -> Unknown -> ECHTES IPC
        // `respond_host_key(true)` -> Produktionscode haengt die
        // tatsaechlich praesentierte Zeile an. Diese Zeile ist die
        // Grundwahrheit fuer den Byteidentitaets-Beweis unten -- sie kommt
        // aus `append_entry` selbst, nicht aus einer separaten Quelle.
        let state_a = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app_a = app_with_state(state_a.clone());
        let wv_a = webview(&app_a);

        let path_a = unique_temp_path("tofu_ground_truth");
        assert!(!path_a.exists());

        let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
        let wv_for_responder = wv_a.clone();
        let responder = std::thread::spawn(move || {
            let req = req_rx
                .recv()
                .expect("Phase A: erwartet eine TOFU-Rueckfrage fuer einen unbekannten Host");
            let _: () = invoke_ok(
                &wv_for_responder,
                "respond_host_key",
                serde_json::json!({"requestId": req.request_id, "accept": true}),
            );
        });
        let host_id_a = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state_a,
            key_spec(&host),
            String::new(),
            path_a.clone(),
            Arc::new(Chan(req_tx)),
            Duration::from_secs(15),
        ))
        .expect("respond_host_key(true) muss die Verbindung tatsaechlich zulassen");
        responder.join().expect("Antwort-Thread darf nicht paniken");
        let _: () = invoke_ok(
            &wv_a,
            "disconnect_host",
            serde_json::json!({"hostId": host_id_a}),
        );

        let expected = std::fs::read_to_string(&path_a)
            .expect("ein akzeptierter Unknown-Schluessel muss known_hosts tatsaechlich anlegen");
        let _ = std::fs::remove_file(&path_a);
        assert_eq!(expected.lines().count(), 1);
        assert!(expected.ends_with('\n'));

        // Phase B: "Eintrag entfernt" nachgestellt -- eine temporaere Kopie
        // mit Fuellinhalt (steht fuer Zeilen ANDERER Hosts), aber OHNE
        // Zeile fuer `host`. Niemals ~/.ssh/known_hosts des Bedienrechners,
        // auch nicht lesend.
        let filler = "192.0.2.1 ssh-ed25519 AAAAFILLERFILLERFILLERFILLERFILLERFILLERFILLERFILLER\n";

        // B1: respond_host_key(false) -- Ablehnung, Datei unveraendert.
        let state_b1 = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app_b1 = app_with_state(state_b1.clone());
        let wv_b1 = webview(&app_b1);
        let path_b1 = unique_temp_path("tofu_reject");
        std::fs::write(&path_b1, filler).unwrap();

        let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
        let wv_for_responder = wv_b1.clone();
        let responder = std::thread::spawn(move || {
            let req = req_rx
                .recv()
                .expect("Phase B1: erwartet eine TOFU-Rueckfrage");
            let _: () = invoke_ok(
                &wv_for_responder,
                "respond_host_key",
                serde_json::json!({"requestId": req.request_id, "accept": false}),
            );
        });
        let err = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state_b1,
            key_spec(&host),
            filler.to_string(),
            path_b1.clone(),
            Arc::new(Chan(req_tx)),
            Duration::from_secs(15),
        ))
        .expect_err("respond_host_key(false) muss die Verbindung ablehnen");
        responder.join().expect("Antwort-Thread darf nicht paniken");
        assert_eq!(
            err, "The host key wasn't confirmed, so aidevbridge didn't connect.",
            "Meldung: {err:?}"
        );
        let after_reject = std::fs::read_to_string(&path_b1).unwrap();
        assert_eq!(
            after_reject, filler,
            "eine abgelehnte Rueckfrage darf known_hosts NICHT veraendern"
        );
        let _ = std::fs::remove_file(&path_b1);

        // B2: respond_host_key(true) -- Annahme, byteidentische Zeile.
        let state_b2 = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app_b2 = app_with_state(state_b2.clone());
        let wv_b2 = webview(&app_b2);
        let path_b2 = unique_temp_path("tofu_accept_second");
        std::fs::write(&path_b2, filler).unwrap();

        let (req_tx, req_rx) = std::sync::mpsc::channel::<HostKeyRequest>();
        let wv_for_responder = wv_b2.clone();
        let responder = std::thread::spawn(move || {
            let req = req_rx
                .recv()
                .expect("Phase B2: erwartet eine TOFU-Rueckfrage");
            let _: () = invoke_ok(
                &wv_for_responder,
                "respond_host_key",
                serde_json::json!({"requestId": req.request_id, "accept": true}),
            );
        });
        let host_id_b2 = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state_b2,
            key_spec(&host),
            filler.to_string(),
            path_b2.clone(),
            Arc::new(Chan(req_tx)),
            Duration::from_secs(15),
        ))
        .expect("respond_host_key(true) muss die Verbindung zulassen");
        responder.join().expect("Antwort-Thread darf nicht paniken");
        let _: () = invoke_ok(
            &wv_b2,
            "disconnect_host",
            serde_json::json!({"hostId": host_id_b2}),
        );

        let after_accept = std::fs::read_to_string(&path_b2).unwrap();
        let appended = after_accept
            .strip_prefix(filler)
            .expect("die Fuellzeilen muessen unveraendert am Dateianfang stehen");
        assert_eq!(
            appended, expected,
            "die angehaengte Zeile muss BYTEIDENTISCH mit der aus Phase A sein -- das beweist, \
             dass der im Overlay gezeigte Fingerabdruck wirklich zum tatsaechlich \
             praesentierten Host-Key gehoert"
        );
        let _ = std::fs::remove_file(&path_b2);
    }
);

// =======================================================================
// Schritt 5: Sitzungsablauf
// =======================================================================

/// Kanalbasierter `OutputSink` -- steht fuer den WebView, ohne eine laufende
/// Tauri-Anwendung zu brauchen. Notwendig, weil `open_terminal_impl` (siehe
/// Modulkommentar: `open_terminal` selbst laesst sich unter `MockRuntime`
/// nicht registrieren) direkt aufgerufen wird, nicht ueber IPC -- dasselbe
/// Muster wie `ChannelSink` in `tests/integration_commands.rs`.
#[derive(Clone)]
struct ChannelSink(std::sync::mpsc::Sender<(String, Vec<u8>)>);
impl commands::OutputSink for ChannelSink {
    fn send(&self, _host_id: &str, session: &str, bytes: Vec<u8>) -> bool {
        self.0.send((session.to_string(), bytes)).is_ok()
    }
}

fn recv_output(
    rx: &std::sync::mpsc::Receiver<(String, Vec<u8>)>,
    timeout: Duration,
) -> Option<(String, Vec<u8>)> {
    rx.recv_timeout(timeout).ok()
}

vm_test!(
    session_lifecycle_create_open_send_receive_close_no_attach_remains_disconnect,
    |host: String| {
        // Eigener Socket: Seit der numerischen Liste (12.09.2026) verwirft
        // `list_sessions` die ganze Liste, wenn parallel laufende Tests
        // derselben Datei gleichzeitig Sessions anlegen.
        let socket = common::test_socket_for("life");
        let state = Arc::new(commands::AppState::with_own_socket(socket.clone()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        let seeded = seeded_known_hosts(&host, "lifecycle");
        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            key_spec(&host),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ))
        .expect("Verbindung fuer den Sitzungsablauf muss gelingen");
        let _ = std::fs::remove_file(&seeded);

        // create_session -- echtes IPC, wie main.ts's createSession().
        let session: String = invoke_ok(
            &wv,
            "create_session",
            serde_json::json!({"hostId": host_id, "cwd": "/tmp"}),
        );
        assert!(session.starts_with("ab_"), "Sitzungsname: {session:?}");

        // list_sessions -- echtes IPC, in genau dieser Reihenfolge (main.ts:
        // "Reihenfolge verbindlich: list_sessions MUSS vor openSession
        // laufen", main.ts:468). Seit dem 13.09.2026 liefert es je Session ein
        // Objekt mit Namen, numerischen IDs und Status, keine blossen Namen.
        let rows: Vec<serde_json::Value> =
            invoke_ok(&wv, "list_sessions", serde_json::json!({"hostId": host_id}));
        let names: Vec<&str> = rows
            .iter()
            .filter_map(|row| row["display_name"].as_str())
            .collect();
        assert!(
            names.contains(&session.as_str()),
            "list_sessions muss die soeben angelegte Session {session:?} zeigen: {rows:?}"
        );

        // open_terminal -- NICHT ueber IPC, siehe Modulkommentar
        // (`AppHandle` ist unter `MockRuntime` nicht registrierbar, ein
        // echter Compilerfehler). `open_terminal_impl` direkt mit einem
        // kanalbasierten Sink -- alle anderen Aufrufe dieses Tests bleiben
        // echtes IPC.
        let (tx, rx) = std::sync::mpsc::channel::<(String, Vec<u8>)>();
        tauri::async_runtime::block_on(commands::open_terminal_impl(
            &state,
            ChannelSink(tx),
            host_id.clone(),
            session.clone(),
            80,
            24,
        ))
        .expect("open_terminal_impl muss gelingen");

        // Der Attach-Strom beginnt mit einem absoluten Repaint (Spec V7).
        let mut collected = Vec::new();
        for _ in 0..5 {
            match recv_output(&rx, Duration::from_millis(800)) {
                Some((_, bytes)) => collected.extend_from_slice(&bytes),
                None => break,
            }
        }
        let repaint = String::from_utf8_lossy(&collected);
        assert!(
            repaint.contains("\x1b[H") && repaint.contains("\x1b[2J"),
            "erwartet absoluten Repaint ueber den echten IPC-Event-Pfad, bekam: {repaint:?}"
        );

        // send_input -- echtes IPC, wie terminal.ts's term.onData().
        let marker = "echo CMD_MARKER_ACCEPTANCE\n";
        let bytes: Vec<u8> = marker.bytes().collect();
        let _: () = invoke_ok(
            &wv,
            "send_input",
            serde_json::json!({"hostId": host_id, "session": session, "bytes": bytes}),
        );

        // ... und zurueck ueber denselben Event-Pfad, jeweils per
        // ack_output ueber echtes IPC bestaetigt (wie terminal.ts es tut).
        let mut seen = String::new();
        for _ in 0..40 {
            if let Some((_, bytes)) = recv_output(&rx, Duration::from_millis(500)) {
                let byte_count = bytes.len() as u32;
                seen.push_str(&String::from_utf8_lossy(&bytes));
                let _: () = invoke_ok(
                    &wv,
                    "ack_output",
                    serde_json::json!({
                        "hostId": host_id, "session": session, "byteCount": byte_count
                    }),
                );
                if seen.contains("CMD_MARKER_ACCEPTANCE") {
                    break;
                }
            }
        }
        assert!(
            seen.contains("CMD_MARKER_ACCEPTANCE"),
            "Eingabe kam nicht im Pane an"
        );

        // resize_terminal -- echtes IPC, mit echter Wirkung geprueft
        // (dasselbe Muster wie `resize_reaches_the_remote_pane` in
        // integration_pty.rs): das entfernte Pane muss die neue Breite
        // tatsaechlich uebernehmen, nicht nur der Aufruf erfolgreich sein.
        let _: () = invoke_ok(
            &wv,
            "resize_terminal",
            serde_json::json!({"hostId": host_id, "session": session, "cols": 100, "rows": 30}),
        );
        // `tokio::time::sleep(..)` MUSS innerhalb des async-Blocks
        // konstruiert werden, nicht als bereits ausgewerteter Wert
        // uebergeben -- `Sleep::new_timeout` greift beim Konstruieren
        // selbst schon auf den Timer-Treiber der aktuellen Laufzeit zu,
        // und der aufrufende Thread hat ausserhalb von `block_on` gar
        // keine betreten (eine erste Fassung schlug hier mit
        // "there is no reactor running" fehl).
        tauri::async_runtime::block_on(async {
            tokio::time::sleep(Duration::from_millis(300)).await
        });
        let width_check = independent_connection(&host);
        let width_out = tauri::async_runtime::block_on(width_check.exec(&remote::build(&[
            "tmux",
            "-L",
            socket.as_str(),
            "display",
            "-p",
            "-t",
            &session,
            "#{window_width}",
        ])))
        .unwrap();
        assert_eq!(
            width_out.stdout.trim(),
            "100",
            "resize_terminal muss die neue Breite tatsaechlich auf dem entfernten Pane setzen"
        );
        tauri::async_runtime::block_on(width_check.dispose());

        // close_terminal -- echtes IPC.
        let _: () = invoke_ok(
            &wv,
            "close_terminal",
            serde_json::json!({"hostId": host_id, "session": session}),
        );

        // Kein `tmux attach`-Prozess mehr -- ueber einen `exec`-Aufruf auf
        // einer unabhaengigen Verbindung (AppState haelt seine Transport-
        // Instanz privat, es gibt keinen Zugriff von aussen darauf). Kurz
        // gepollt statt eines einzelnen Aufrufs -- dasselbe Muster wie
        // `open_terminal_twice_for_the_same_key_...` in
        // `integration_commands.rs`: das Hangup des Kanals braucht etwas
        // Zeit, um server-seitig anzukommen.
        let verify = independent_connection(&host);
        let mut attached: u32 = u32::MAX;
        for _ in 0..5 {
            let out = tauri::async_runtime::block_on(verify.exec(&remote::build(&[
                "tmux",
                "-L",
                socket.as_str(),
                "display",
                "-p",
                "-t",
                &session,
                "#{session_attached}",
            ])))
            .unwrap();
            attached = out.stdout.trim().parse().expect("erwartet eine Ganzzahl");
            if attached == 0 {
                break;
            }
            tauri::async_runtime::block_on(async {
                tokio::time::sleep(Duration::from_millis(200)).await
            });
        }
        assert_eq!(
            attached, 0,
            "kein tmux-Klient haette nach close_terminal noch angehaengt sein duerfen"
        );

        // disconnect_host -- echtes IPC.
        let _: () = invoke_ok(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": host_id}),
        );
        assert!(!tauri::async_runtime::block_on(state.has_host(&host_id)));

        // Aufraeumen: NUR die eigene, per create_session (ab_-Praefix)
        // angelegte Session -- per exaktem Namen, niemals kill-server.
        let tmux = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
        tauri::async_runtime::block_on(tmux.kill_session(&verify, &session))
            .unwrap_or_else(|e| panic!("Aufraeumen von {session} muss gelingen: {e:#}"));
        tauri::async_runtime::block_on(verify.dispose());
    }
);

/// Wie [`ChannelSink`], schreibt aber zusaetzlich mit, ob
/// `connection_lost` gemeldet wurde. Genau dieses Signal loest in der
/// Oberflaeche die Sperrleiste ("Input locked") aus -- eine Senke, die es
/// verschluckt (wie `ChannelSink` ueber die Default-Implementierung des
/// Traits), kann den Fall gar nicht sehen.
struct WatchingSink {
    tx: std::sync::mpsc::Sender<(String, Vec<u8>)>,
    lost: Arc<AtomicBool>,
}
impl commands::OutputSink for WatchingSink {
    fn send(&self, _host_id: &str, session: &str, bytes: Vec<u8>) -> bool {
        self.tx.send((session.to_string(), bytes)).is_ok()
    }
    fn connection_lost(&self, _host_id: &str, _session: &str) {
        self.lost.store(true, Ordering::SeqCst);
    }
}

// =======================================================================
// Zwei Terminals am selben Host, ueber die Stall-Frist hinaus
//
// Nachgestellt wird ein gemeldeter Ablauf: zwei Sitzungen auf DEMSELBEN
// Host, beide als Kachel offen, und binnen Sekunden zeigen BEIDE die
// Sperrleiste "Input locked" -- obwohl der Host erreichbar ist und die
// Sitzungen weiterlaufen.
//
// Der bestehende Lebenszyklus-Test kann das nicht sehen: er faehrt EINE
// Sitzung, benutzt eine Senke ohne `connection_lost`-Implementierung und
// ist nach wenigen hundert Millisekunden fertig. Dieser Test haelt beide
// Kanaele ueber `STALL_TIMEOUT` (30 s) hinaus offen und bestaetigt dabei
// wie das Fenster: jedes empfangene Paket sofort per `ack_output`.
//
// Damit sind beide Verdaechtigen zugleich abgedeckt:
//   - ein Stall (30 s ohne Bestaetigung bei vollem 1-MiB-Fenster) -- er
//     darf nicht auftreten, wenn ordentlich bestaetigt wird;
//   - ein vorzeitiges Ende der Leseseite, etwa weil ein zweiter Kanal auf
//     derselben Verbindung den ersten stoert.
// =======================================================================

vm_test!(
    two_terminals_on_one_host_survive_beyond_the_stall_timeout,
    |host: String| {
        let socket = common::test_socket();
        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        let seeded = seeded_known_hosts(&host, "twoterm");
        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            key_spec(&host),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ))
        .expect("Verbindung fuer den Zwei-Terminal-Ablauf muss gelingen");
        let _ = std::fs::remove_file(&seeded);

        // Zwei Sitzungen, nacheinander angelegt -- wie zwei Klicks auf
        // "New session".
        let first: String = invoke_ok(
            &wv,
            "create_session",
            serde_json::json!({"hostId": host_id, "cwd": "/tmp"}),
        );
        let second: String = invoke_ok(
            &wv,
            "create_session",
            serde_json::json!({"hostId": host_id, "cwd": "/tmp"}),
        );
        assert_ne!(first, second, "zwei Aufrufe muessen zwei Sitzungen ergeben");

        // Beide als Kachel oeffnen, jede mit eigener beobachtender Senke.
        let (tx1, rx1) = std::sync::mpsc::channel::<(String, Vec<u8>)>();
        let (tx2, rx2) = std::sync::mpsc::channel::<(String, Vec<u8>)>();
        let lost1 = Arc::new(AtomicBool::new(false));
        let lost2 = Arc::new(AtomicBool::new(false));
        for (session, tx, lost) in [(&first, tx1, lost1.clone()), (&second, tx2, lost2.clone())] {
            tauri::async_runtime::block_on(commands::open_terminal_impl(
                &state,
                WatchingSink { tx, lost },
                host_id.clone(),
                session.clone(),
                80,
                24,
            ))
            .unwrap_or_else(|e| panic!("open_terminal_impl fuer {session} muss gelingen: {e}"));
        }

        // Ueber die Stall-Frist hinaus dranbleiben und dabei bestaetigen wie
        // `terminal.ts`: `byteCount` ist die Groesse DIESES Pakets, nicht die
        // kumulative Summe.
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        let mut seen1 = 0usize;
        let mut seen2 = 0usize;
        while std::time::Instant::now() < deadline {
            for (rx, session, seen) in [(&rx1, &first, &mut seen1), (&rx2, &second, &mut seen2)] {
                while let Some((got, bytes)) = recv_output(rx, Duration::from_millis(200)) {
                    assert_eq!(&got, session, "Ausgabe kam unter fremdem Sitzungsnamen an");
                    *seen += bytes.len();
                    let _: () = invoke_ok(
                        &wv,
                        "ack_output",
                        serde_json::json!({
                            "hostId": host_id,
                            "session": session,
                            "byteCount": bytes.len(),
                        }),
                    );
                }
            }
            // Beide Kanaele muessen die ganze Zeit leben. Frueh abbrechen,
            // sobald einer stirbt -- das ist der gesuchte Fall.
            if lost1.load(Ordering::SeqCst) || lost2.load(Ordering::SeqCst) {
                break;
            }
        }

        let died1 = lost1.load(Ordering::SeqCst);
        let died2 = lost2.load(Ordering::SeqCst);

        // Aufraeumen VOR den Zusicherungen: ein Fehlschlag darf keine
        // Sitzungen auf der VM zuruecklassen.
        let verify = independent_connection(&host);
        let tmux = OwnTmuxClient::new(&OwnSocket::new(socket.clone()).unwrap());
        for session in [&first, &second] {
            let _: Result<(), String> = invoke_raw(
                &wv,
                "close_terminal",
                serde_json::json!({"hostId": host_id, "session": session}),
            )
            .map(|_| ())
            .map_err(|e| e.to_string());
            tauri::async_runtime::block_on(tmux.kill_session(&verify, session))
                .unwrap_or_else(|e| panic!("Aufraeumen von {session} muss gelingen: {e:#}"));
        }
        let _: Result<_, _> = invoke_raw(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": host_id}),
        );
        tauri::async_runtime::block_on(verify.dispose());

        // Vorbedingung: es kam ueberhaupt Ausgabe an (der Attach-Strom
        // beginnt mit einem absoluten Repaint, Spec V7). Ohne sie pruefte
        // der Test unten zwei Kanaele, die nie gelebt haben.
        assert!(
            seen1 > 0 && seen2 > 0,
            "beide Kanaele muessen Ausgabe geliefert haben: {seen1}/{seen2}"
        );
        assert!(
            !died1 && !died2,
            "keiner der beiden Kanaele darf von sich aus enden -- genau dieses Signal zeigt die \
             Oberflaeche als 'Input locked' (erster: {died1}, zweiter: {died2})"
        );
    }
);

// =======================================================================
// Verzeichnisauswahl: die beiden Faelle, die sich unter Windows nicht
// herstellen lassen
//
// Die uebrigen Zusicherungen des Fernskripts pruefen die Tests in
// `src/remote/dirs.rs` LOKAL durch eine echte `sh` (Git Bash). Zwei Faelle
// koennen sie dort nicht pruefen, und deshalb stehen sie hier: ein Symlink
// auf ein Verzeichnis (braucht unter Windows besondere Rechte) und ein
// Verzeichnis ohne Leserecht (`chmod` wirkt auf NTFS nicht). Genau diese
// beiden verlangt Spec §9 ausdruecklich.
//
// Ebenfalls nur hier pruefbar: der Versteckt-Filter und die Sortierung.
// Beide sitzen in `list_directories_impl`, nicht im Skript, und
// `AppState.hosts` haelt einen KONKRETEN `Arc<RusshTransport>` -- es gibt
// keine Attrappe, gegen die sich das lokal fahren liesse.
// =======================================================================

/// Antwortform von `list_directories`. `DirectoryListingDto` ist nur
/// `Serialize` (Tauris IPC braucht nicht mehr) -- fuer die Gegenrichtung
/// steht hier das Spiegelbild.
#[derive(serde::Deserialize)]
struct ListingResponse {
    path: String,
    entries: Vec<String>,
}

/// Legt die Fixtur an. `$1` ist das Grundverzeichnis -- Positionsargument,
/// wie im Fernskript selbst, damit auch dieser Aufbau nichts in eine
/// Kommandozeile einsetzt.
///
/// `Zebra` und `apfel`: ASCII sortiert `Z` VOR `a`, die geforderte
/// Sortierung ohne Ruecksicht auf Gross-/Kleinschreibung genau andersherum.
/// Ohne dieses Paar waere die Sortierzusicherung unten nicht
/// unterscheidungsfaehig.
const DIRTEST_SETUP: &str = r#"set -eu
d=$1
mkdir -p "${d}/Zebra" "${d}/apfel" "${d}/ziel" "${d}/.versteckt" "${d}/gesperrt"
ln -s "${d}/ziel" "${d}/verlinkt"
: > "${d}/eine_datei"
chmod 000 "${d}/gesperrt"
"#;

/// Raeumt die Fixtur wieder ab -- NUR das eigene Grundverzeichnis, per
/// exaktem Pfad. `chmod` zuerst, sonst laesst sich `gesperrt` nicht
/// entfernen.
const DIRTEST_CLEANUP: &str = r#"d=$1
chmod 700 "${d}/gesperrt" 2>/dev/null || true
rm -rf -- "${d}"
"#;

vm_test!(
    list_directories_sees_a_symlinked_directory_and_distinguishes_denied_from_notfound,
    |host: String| {
        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        let seeded = seeded_known_hosts(&host, "list_directories");
        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            key_spec(&host),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ))
        .expect("Verbindung fuer die Verzeichnisauswahl muss gelingen");
        let _ = std::fs::remove_file(&seeded);

        // Eigenes Grundverzeichnis auf der VM, per Zeitstempel eindeutig --
        // parallel laufende Abnahmen stoeren einander nicht.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = format!("/tmp/aidevbridge_dirtest_{nanos}");

        // Aufbau und Abbau ueber eine UNABHAENGIGE Verbindung: `AppState`
        // haelt seinen Transport privat, es gibt von aussen keinen Zugriff
        // darauf (dasselbe Muster wie die Breitenpruefung im
        // Sitzungsablauf).
        let fixture = independent_connection(&host);
        tauri::async_runtime::block_on(fixture.exec(&remote::build(&[
            "sh",
            "-c",
            DIRTEST_SETUP,
            "sh",
            &base,
        ])))
        .expect("Fixtur auf der VM muss sich anlegen lassen");

        // --- 1. Eine Ebene, ohne Verstecktes ---
        let l: ListingResponse = invoke_ok(
            &wv,
            "list_directories",
            serde_json::json!({"hostId": host_id, "path": base, "includeHidden": false}),
        );
        assert_eq!(l.path, base, "der aufgeloeste Pfad muss zurueckkommen");
        assert!(
            l.entries.contains(&"verlinkt".to_string()),
            "ein Symlink AUF EIN VERZEICHNIS muss erscheinen (Spec §3.2) -- das ist der \
             Normalfall bei verlinkten Projektordnern: {:?}",
            l.entries
        );
        assert!(
            !l.entries.contains(&"eine_datei".to_string()),
            "Dateien duerfen nicht erscheinen: {:?}",
            l.entries
        );
        assert!(
            !l.entries.contains(&".versteckt".to_string()),
            "ohne includeHidden darf kein Punkteintrag erscheinen: {:?}",
            l.entries
        );
        assert!(
            l.entries.contains(&"gesperrt".to_string()),
            "ein Verzeichnis OHNE Leserecht muss in der ELTERNLISTE stehen -- nur so kann der \
             Baum es zugeklappt mit Hinweis zeigen (Abnahmekriterium 4): {:?}",
            l.entries
        );
        assert_eq!(
            l.entries,
            {
                let mut sortiert = l.entries.clone();
                sortiert.sort_by_key(|e| e.to_lowercase());
                sortiert
            },
            "die Liste muss ohne Ruecksicht auf Gross-/Kleinschreibung sortiert sein -- `Zebra` \
             und `apfel` in der Fixtur unterscheiden das von einer ASCII-Sortierung"
        );

        // --- 2. Mit Verstecktem ---
        let mit_versteckt: ListingResponse = invoke_ok(
            &wv,
            "list_directories",
            serde_json::json!({"hostId": host_id, "path": base, "includeHidden": true}),
        );
        assert!(
            mit_versteckt.entries.contains(&".versteckt".to_string()),
            "mit includeHidden muss der Punkteintrag erscheinen: {:?}",
            mit_versteckt.entries
        );

        // --- 3. Kein Leserecht: ein FEHLER, kein Absturz ---
        let denied = invoke_err(
            &wv,
            "list_directories",
            serde_json::json!({
                "hostId": host_id, "path": format!("{base}/gesperrt"), "includeHidden": false
            }),
        );
        assert!(
            denied.contains("denied"),
            "ein Verzeichnis ohne Leserecht muss `denied` melden, bekommen: {denied:?}. Laeuft \
             die Abnahme als root, greift `chmod 000` nicht -- dann braucht dieser Zweig ein \
             unprivilegiertes Konto"
        );

        // --- 4. Gibt es nicht -- und zwar UNTERSCHEIDBAR ---
        let notfound = invoke_err(
            &wv,
            "list_directories",
            serde_json::json!({
                "hostId": host_id, "path": format!("{base}/gibtesnicht"), "includeHidden": false
            }),
        );
        assert!(
            notfound.contains("notfound"),
            "ein fehlender Pfad muss `notfound` melden, bekommen: {notfound:?}"
        );
        // Der eigentliche Punkt der Unterscheidung (Spec §6): "kein
        // Leserecht" darf den Baum nicht abbrechen, "gibt es nicht"
        // entwertet den gespeicherten Pfad. Eine gemeinsame Meldung machte
        // beide Reaktionen unmoeglich.
        assert_ne!(
            denied, notfound,
            "die beiden Fehlerarten muessen sich unterscheiden lassen"
        );

        // Aufraeumen: NUR das eigene Grundverzeichnis, per exaktem Pfad.
        tauri::async_runtime::block_on(fixture.exec(&remote::build(&[
            "sh",
            "-c",
            DIRTEST_CLEANUP,
            "sh",
            &base,
        ])))
        .unwrap_or_else(|e| panic!("Aufraeumen von {base} muss gelingen: {e:#}"));
        tauri::async_runtime::block_on(fixture.dispose());

        let _: () = invoke_ok(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": host_id}),
        );
    }
);

// =======================================================================
// Drei Bearbeitungssequenzen der Hostverwaltung
// (frontend-seitig bereits in `src/main.test.ts`/`src/views/session-
// dialog.test.ts` abgedeckt -- hier ist die Backend-Haelfte: dieselbe
// Befehlsreihenfolge, tatsaechlich gegen die VM gefahren).
// =======================================================================

// Host waehrend bestehender Verbindung bearbeiten: disconnect -> remove ->
// add -- exakt die Reihenfolge aus `src/views/session-dialog.ts::editHost`
// (Zeilen ~200-219).
//
// Was das hier NICHT beweist: dass die drei Aufrufe im Frontend
// tatsaechlich in dieser Reihenfolge und mit diesen Nutzlasten abgesetzt
// werden -- das ist `session-dialog.test.ts`s Job (es mockt `invoke` und
// prueft die Aufrufliste). Dieser Test beweist die andere Haelfte: dass
// das BACKEND diese drei Aufrufe in dieser Reihenfolge tatsaechlich
// korrekt verarbeitet -- die Verbindung wird wirklich getrennt, der alte
// Settings-Eintrag wirklich entfernt, der neue wirklich mit frischer `id`
// angelegt.
vm_test!(
    editing_a_connected_host_disconnects_removes_and_readds,
    |host: String| {
        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        let seeded = seeded_known_hosts(&host, "edit_host");
        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            key_spec(&host),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ))
        .expect("Verbindung fuer den Editier-Test muss gelingen");
        let _ = std::fs::remove_file(&seeded);

        // Settings-Fixtur: ein gespeicherter Host, wie ihn editHost() vorfindet.
        let settings_path = unique_temp_path("edit_host_settings");
        let original = commands::add_host_impl(
            &settings_path,
            NewHostEntryDto {
                label: "Vor der Bearbeitung".into(),
                hostname: host.clone(),
                user: vm_user(),
                port: 22,
                tmux_socket: None,
                history_limit: None,
                key_path: Some(vm_key_path().display().to_string()),
                auth_kind: None,
                show_default_socket: None,
            },
        )
        .expect("add_host_impl (Fixtur) darf nicht fehlschlagen");

        // disconnect_host -- echtes IPC, wie editHost() es zuerst tut.
        let _: () = invoke_ok(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": host_id}),
        );
        assert!(!tauri::async_runtime::block_on(state.has_host(&host_id)));

        // remove_host / add_host -- NICHT ueber IPC (siehe Modulkommentar):
        // der echte Command schriebe %APPDATA%\io.github.itbrain258.aidevbridge\settings.toml des
        // Bedienrechners.
        commands::remove_host_impl(&settings_path, &original.id).unwrap();
        let edited = commands::add_host_impl(
            &settings_path,
            NewHostEntryDto {
                label: "Nach der Bearbeitung".into(),
                hostname: host.clone(),
                user: vm_user(),
                port: 22,
                tmux_socket: None,
                history_limit: None,
                key_path: Some(vm_key_path().display().to_string()),
                auth_kind: None,
                show_default_socket: None,
            },
        )
        .unwrap();

        let after = settings::load_from(&settings_path).unwrap();
        assert_eq!(
            after.hosts.len(),
            1,
            "genau ein Host nach Entfernen+Neuanlegen"
        );
        assert_eq!(after.hosts[0].label, "Nach der Bearbeitung");
        assert_ne!(
            after.hosts[0].id, original.id,
            "add_host_impl muss eine NEUE id vergeben, nie die alte wiederverwenden"
        );
        assert_eq!(after.hosts[0].id, edited.id);

        let _ = std::fs::remove_file(&settings_path);
    }
);

// Verbundenen Host entfernen: disconnect -> remove -- exakt die Reihenfolge
// aus `src/main.ts::onRemoveHost` (Zeilen ~404-420).
vm_test!(
    removing_a_connected_host_disconnects_and_removes_from_settings,
    |host: String| {
        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        let seeded = seeded_known_hosts(&host, "remove_host");
        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            key_spec(&host),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ))
        .expect("Verbindung fuer den Entfernen-Test muss gelingen");
        let _ = std::fs::remove_file(&seeded);

        let settings_path = unique_temp_path("remove_host_settings");
        let entry = commands::add_host_impl(
            &settings_path,
            NewHostEntryDto {
                label: "Wird entfernt".into(),
                hostname: host.clone(),
                user: vm_user(),
                port: 22,
                tmux_socket: None,
                history_limit: None,
                key_path: Some(vm_key_path().display().to_string()),
                auth_kind: None,
                show_default_socket: None,
            },
        )
        .expect("add_host_impl (Fixtur) darf nicht fehlschlagen");

        // onRemoveHost(): disconnect (IPC), dann remove_host (Fixturpfad).
        let _: () = invoke_ok(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": host_id}),
        );
        assert!(!tauri::async_runtime::block_on(state.has_host(&host_id)));

        commands::remove_host_impl(&settings_path, &entry.id).unwrap();
        let after = settings::load_from(&settings_path).unwrap();
        assert!(
            after.hosts.is_empty(),
            "der entfernte Host darf nicht mehr in settings.toml stehen: {after:?}"
        );

        let _ = std::fs::remove_file(&settings_path);
    }
);

// Trennen, waehrend ein Verbindungsaufbau noch aussteht.
//
// Ehrlich, was das beweist und was nicht: `src/main.ts::onDisconnectHost`
// ruft `disconnect_host` waehrend `state === "connecting"` bewusst NIE auf
// (es gibt noch keine Laufzeit-`hostId` -- stattdessen wird nur ein lokaler
// Generationszaehler erhoeht, siehe main.ts Zeilen 371-386). Diese
// JavaScript-seitige Verzahnung selbst ist NICHT command-level
// nachstellbar und wird bereits von `src/main.test.ts` geprueft.
//
// Was hier auf Backend-Seite tatsaechlich geprueft wird, ist die
// Voraussetzung, die diese Frontend-Strategie erst sicher macht:
// `disconnect_host` fuer eine `host_id`, die es noch gar nicht gibt, ist
// ein folgenloser No-Op (kein Fehler, kein Absturz) -- UND ein spaeter
// erfolgreich abschliessender `connect_host` fuer GENAU diese ID wird
// dadurch nicht verhindert oder korrumpiert. Das ist kein Beleg fuer echtes
// Millisekunden-Timing eines Netzwerk-Rennens, sondern fuer die
// Zustands-Invariante, auf die main.ts sich verlaesst.
vm_test!(
    disconnecting_a_not_yet_assigned_host_id_is_a_harmless_noop_while_connect_is_in_flight,
    |host: String| {
        let state = Arc::new(commands::AppState::with_own_socket(common::test_socket()));
        let app = app_with_state(state.clone());
        let wv = webview(&app);

        // Frischer AppState: `next_host_id` startet bei 0 -- die ERSTE
        // erfolgreiche Verbindung bekommt garantiert "h0" (commands.rs,
        // `next_host_id`). Das erlaubt es, VOR jedem Verbindungsversuch
        // schon auf die spaeter zugewiesene ID zu zielen.
        let predicted_id = "h0";

        // "Disconnect", bevor ueberhaupt eine Verbindung begonnen hat --
        // ueber echtes IPC, wie main.ts es taete.
        let _: () = invoke_ok(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": predicted_id}),
        );

        let seeded = seeded_known_hosts(&host, "inflight_disconnect");
        let host_id = tauri::async_runtime::block_on(commands::connect_host_with_known_hosts(
            &state,
            key_spec(&host),
            bootstrap_known_hosts_line(&host),
            seeded.clone(),
            Arc::new(common::PanicIfAskedSink),
            Duration::from_secs(10),
        ))
        .expect("Verbindung muss trotz des vorangegangenen No-Op-Disconnects gelingen");
        let _ = std::fs::remove_file(&seeded);
        assert_eq!(
            host_id, predicted_id,
            "Testannahme verletzt: die erste Verbindung auf einem frischen AppState muss h0 \
             werden"
        );
        assert!(
            tauri::async_runtime::block_on(state.has_host(&host_id)),
            "der fruehe No-Op-Disconnect darf die spaetere echte Verbindung nicht verhindert \
             haben"
        );

        let _: () = invoke_ok(
            &wv,
            "disconnect_host",
            serde_json::json!({"hostId": host_id}),
        );
        assert!(!tauri::async_runtime::block_on(state.has_host(&host_id)));
    }
);
