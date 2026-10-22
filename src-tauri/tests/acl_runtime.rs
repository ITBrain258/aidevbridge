//! Die ACL, vom echten Auflöser geprüft -- nicht vom Textvergleich.
//!
//! `tests/capabilities_acl.rs` haelt die fuenf Listen zusammen -- Handler,
//! `build.rs`, `capabilities/default.json`, das Fenster-Label und die
//! `COMMANDS`-Liste weiter unten in DIESER Datei. Es liest Dateien. Es kann NICHT belegen, dass
//! Tauris Laufzeit-Auflöser diese Namen auch akzeptiert -- ein Tippfehler im
//! Schema, ein falsch geschriebenes Fenster-Label oder eine kaputte
//! Manifest-Erzeugung in `build.rs` bleiben dort unsichtbar und schlagen erst
//! im laufenden Fenster zu.
//!
//! Dieser Test schliesst genau diese Luecke: er baut eine echte
//! `tauri::App` auf dem `MockRuntime` mit dem ECHTEN
//! `generate_context!()` -- also mit dem real erzeugten ACL-Manifest und der
//! real geparsten `capabilities/default.json` -- und schickt jeden der
//! registrierten Commands durch `on_message`, wo Tauri bei
//! `webview/mod.rs:1795` `resolve_access` aufruft.
//!
//! **Warum dabei kein einziger Command ausgefuehrt wird:** Die ACL-Pruefung
//! sitzt in `on_message` VOR der Weitergabe an den Invoke-Handler und
//! kehrt bei Ablehnung sofort zurueck (`return` in `webview/mod.rs`). Dieser
//! Test registriert deshalb bewusst GAR KEINEN Handler. Wer die ACL
//! passiert, faellt danach auf "not found" -- wer sie nicht passiert, auf
//! "not allowed". Genau diese beiden Faelle unterscheidet der Test.
//!
//! Das ist nicht nur bequem, es ist die sichere Variante: `add_host` und
//! `remove_host` wuerden sonst wirklich laufen und
//! `%APPDATA%\io.github.itbrain258.aidevbridge\settings.toml` beschreiben -- dieselbe Klasse von
//! Uebergriff, die dieses Projekt fuer `~/.ssh/known_hosts` verbietet.
//!
//! Braucht KEINE VM, keine Umgebungsvariable und kein Fenster.

use std::collections::BTreeSet;

use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;

/// Der Textbaustein, mit dem Tauri eine ACL-Ablehnung meldet.
///
/// Bewusst nur das Fragment, nicht der ganze Satz: Tauri haengt je nach
/// Fall Capability-Hinweise an. Der Gegenprobe-Test unten belegt, dass
/// dieses Fragment wirklich erscheint, wenn ein Eintrag fehlt.
const ACL_DENIAL: &str = "not allowed";

/// Das Fenster-Label, auf das `capabilities/default.json` die Capability
/// begrenzt (`"windows": ["main"]`). Ein anderes Label wuerde ALLE neunzehn
/// Commands ablehnen -- der Test waere flaechendeckend rot und damit
/// wertlos. `tests/capabilities_acl.rs` haelt dieses Label mit
/// `tauri.conf.json` zusammen.
const WINDOW_LABEL: &str = "main";

/// Dieselbe Liste wie in `lib.rs`, `build.rs` und `capabilities/default.json`
/// -- die fuenfte Stelle. Bewusst ausgeschrieben: `capabilities_acl.rs`
/// erzwingt bereits, dass die anderen vier uebereinstimmen, und ein neuer
/// Command soll auch hier jemanden zwingen hinzusehen.
const COMMANDS: &[&str] = &[
    "begin_connect",
    "connect_host",
    "begin_control_repair",
    "repair_control",
    "cancel_control_repair",
    "create_session",
    "open_terminal",
    "send_input",
    "resize_terminal",
    "ack_output",
    "close_terminal",
    "kill_session",
    "disconnect_host",
    "suggest_hosts",
    "list_hosts",
    "add_host",
    "update_host",
    "remove_host",
    "run_preflight",
    "respond_host_key",
    "list_ssh_keys",
    "list_sessions",
    "poll_status",
    "list_directories",
    "ui_settings",
    "open_link",
];

/// Baut die App auf dem `MockRuntime` -- ohne Invoke-Handler, siehe
/// Modulkommentar.
///
/// `generate_context!()` ohne Argument ist der Punkt: es zieht die ECHTE
/// `tauri.conf.json`, das ECHTE von `build.rs` erzeugte ACL-Manifest und die
/// ECHTE `capabilities/default.json`. Mit `mock_context(noop_assets())`
/// waere die ACL leer und der Test bewiese nichts.
fn app() -> tauri::App<tauri::test::MockRuntime> {
    mock_builder()
        .build(tauri::generate_context!())
        .expect("App liess sich nicht bauen")
}

/// Schickt `cmd` mit leerem Body durch den echten IPC-Pfad und gibt den
/// Fehlertext zurueck (oder `None`, wenn der Command erfolgreich war).
fn invoke_and_get_error(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
) -> Option<String> {
    let res = get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            // Die lokale Herkunft der App, wie `tauri::protocol::origin` sie
            // bildet: unter Windows (und Android) `http://tauri.localhost`,
            // sonst `tauri://localhost`. Mit der jeweils anderen gilt die
            // Anfrage als entfernt, und die Capability lehnt alles ab.
            url: if cfg!(windows) || cfg!(target_os = "android") {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    );
    match res {
        Ok(_) => None,
        Err(v) => Some(v.to_string()),
    }
}

/// Der eigentliche Test: kein einziger der registrierten Commands wird von der
/// ACL abgelehnt.
#[test]
fn every_registered_command_passes_the_real_acl_resolver() {
    let app = app();
    let webview = WebviewWindowBuilder::new(&app, WINDOW_LABEL, Default::default())
        .build()
        .expect("Webview liess sich nicht bauen");

    let mut denied: BTreeSet<String> = BTreeSet::new();
    let mut erfolgreich = 0;
    for cmd in COMMANDS {
        match invoke_and_get_error(&webview, cmd) {
            Some(err) => {
                if err.contains(ACL_DENIAL) {
                    denied.insert(format!("{cmd}: {err}"));
                }
            }
            None => erfolgreich += 1,
        }
    }

    assert!(
        denied.is_empty(),
        "Von der ACL abgelehnt (im laufenden Fenster waeren das tote Knoepfe):\n{}",
        denied.into_iter().collect::<Vec<_>>().join("\n")
    );

    // Jeder Command MUSS einen Fehler ergeben (es ist keiner registriert),
    // und dieser Fehler darf NIE der ACL-Ablehnung entsprechen. Ohne diese
    // Zusicherung waere der Test auch dann gruen, wenn alle Aufrufe
    // klaglos durchgingen -- er pruefte dann nur, dass nichts in eine
    // Menge faellt, in die nie etwas faellt.
    assert_eq!(
        erfolgreich, 0,
        "kein Command darf erfolgreich sein -- dieser Test registriert \
         bewusst keinen Handler. Erfolgreiche Aufrufe bedeuten, dass \
         irgendwo doch einer haengt, und dann ist die Aussage dieses Tests \
         eine andere als die behauptete."
    );
}

/// Gegenprobe, fest verdrahtet: ein Command-Name, den `capabilities/default.json`
/// NICHT erlaubt, MUSS abgelehnt werden.
///
/// Ohne diesen Test waere der obige gruen, selbst wenn die ACL komplett
/// abgeschaltet waere oder `ACL_DENIAL` nie im Fehlertext vorkaeme -- er
/// wuerde dann nur belegen, dass die Command-Namen nicht in einer Menge
/// landen, in die nie etwas landet. Das ist genau das Muster, das dieses
/// Projekt achtmal als "gruen, aber prueft nichts" protokolliert hat.
#[test]
fn a_command_without_an_allow_entry_is_actually_denied() {
    let app = app();
    let webview = WebviewWindowBuilder::new(&app, WINDOW_LABEL, Default::default())
        .build()
        .expect("Webview liess sich nicht bauen");

    let err = invoke_and_get_error(&webview, "kein_echter_command_dieser_app")
        .expect("Ein nicht erlaubter Command darf nicht erfolgreich sein");

    assert!(
        err.contains(ACL_DENIAL),
        "Erwartet wurde eine ACL-Ablehnung mit dem Fragment {ACL_DENIAL:?}, \
         bekommen: {err:?}. Entweder greift die ACL nicht, oder Tauri hat den \
         Wortlaut geaendert -- dann ist `every_registered_command_passes_the_real_acl_resolver` \
         blind und muss nachgezogen werden."
    );
}
