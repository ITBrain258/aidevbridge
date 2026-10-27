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

/// Die Core- und Plugin-Befehle, die das Frontend selbst aufruft -- das
/// Gegenstueck zu den Nicht-App-Eintraegen in `capabilities/default.json`,
/// die `tests/capabilities_acl.rs` woertlich festhaelt.
///
/// - `listen`/`unlisten`: `@tauri-apps/api/event` (`src/main.ts`,
///   `src/terminal.ts`, `src/views/host-key-prompt.ts`).
/// - `set_title`/`request_user_attention`: `getCurrentWindow()` in
///   `src/main.ts`.
/// - `dialog|open`: `@tauri-apps/plugin-dialog` in `src/views/host-form.ts`.
/// - `internal_toggle_devtools`: das Ctrl+Shift+I-Skript, das Tauri nur im
///   Debug-Bau einspielt. Die Tests laufen im Debug-Bau, der Command ist
///   hier also registriert.
const FRONTEND_PLUGIN_COMMANDS: &[&str] = &[
    "plugin:event|listen",
    "plugin:event|unlisten",
    "plugin:window|set_title",
    "plugin:window|request_user_attention",
    "plugin:dialog|open",
    "plugin:webview|internal_toggle_devtools",
];

/// Je ein Befehl aus jedem Teilrecht von `core:default` (path, event,
/// window, webview, app, image, resources, menu, tray), den das Frontend
/// NIE aufruft. `event` und `window` stehen dabei mit einem Befehl, der
/// neben den erlaubten im selben Plugin liegt: die Capability gibt einzelne
/// Befehle frei, nicht ganze Plugins.
const UNUSED_CORE_COMMANDS: &[&str] = &[
    "plugin:path|resolve_directory",
    "plugin:event|emit",
    "plugin:window|inner_size",
    "plugin:webview|get_all_webviews",
    "plugin:app|version",
    "plugin:image|new",
    "plugin:resources|close",
    "plugin:menu|new",
    "plugin:tray|new",
];

/// Die Core- und Plugin-Befehle des Frontends passieren den echten
/// ACL-Aufloeser.
///
/// Erfolg und jeder Fehler ausser der ACL-Ablehnung zaehlen als bestanden:
/// der Body ist leer, `set_title` scheitert also an fehlenden Argumenten,
/// und `dialog|open` am fehlenden Plugin, weil `mock_builder()` keine
/// Plugins registriert. Beides liegt HINTER der ACL-Pruefung in
/// `on_message`; das ACL-Manifest des Dialog-Plugins kommt trotzdem ueber
/// `generate_context!()` herein.
#[test]
fn the_frontends_core_and_plugin_commands_pass_the_real_acl_resolver() {
    let app = app();
    let webview = WebviewWindowBuilder::new(&app, WINDOW_LABEL, Default::default())
        .build()
        .expect("Webview liess sich nicht bauen");

    let denied: Vec<String> = FRONTEND_PLUGIN_COMMANDS
        .iter()
        .filter_map(|cmd| {
            invoke_and_get_error(&webview, cmd)
                .filter(|err| err.contains(ACL_DENIAL))
                .map(|err| format!("{cmd}: {err}"))
        })
        .collect();

    assert!(
        denied.is_empty(),
        "Von der ACL abgelehnt, obwohl das Frontend sie aufruft (im Fenster: kein \
         Terminal-Output, kein Fenstertitel, keine Dateiauswahl):\n{}",
        denied.join("\n")
    );
}

/// Was `core:default` ueber die Liste hinaus freigaebe, das Frontend aber
/// nie aufruft, lehnt die ACL ab.
///
/// Gegenstueck zum Test darueber und zur woertlichen Liste in
/// `tests/capabilities_acl.rs`: jene haelt die Eintraege fest, dieser
/// belegt am echten Aufloeser, dass aus ihnen nichts Weiteres folgt. Steht
/// ein Sammelrecht in der Capability, passieren diese Befehle die ACL
/// (`app|version` liefe sogar erfolgreich durch), und der Test wird rot.
#[test]
fn core_commands_the_frontend_never_uses_are_denied() {
    let app = app();
    let webview = WebviewWindowBuilder::new(&app, WINDOW_LABEL, Default::default())
        .build()
        .expect("Webview liess sich nicht bauen");

    let passed: Vec<String> = UNUSED_CORE_COMMANDS
        .iter()
        .filter_map(|cmd| match invoke_and_get_error(&webview, cmd) {
            Some(err) if err.contains(ACL_DENIAL) => None,
            Some(err) => Some(format!("{cmd}: kein ACL-Fehler, sondern {err}")),
            None => Some(format!("{cmd}: erfolgreich")),
        })
        .collect();

    assert!(
        passed.is_empty(),
        "Diese Befehle passieren die ACL, obwohl das Frontend sie nie aufruft -- \
         capabilities/default.json gibt wieder zu viel frei:\n{}",
        passed.join("\n")
    );
}
