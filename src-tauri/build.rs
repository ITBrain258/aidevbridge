// Die ACL ist scharf: `try_build` mit `AppManifest::commands(..)` erzeugt
// das App-ACL-Manifest, und ERST DANN prueft Tauri die selbst registrierten
// `#[tauri::command]`-Funktionen ueberhaupt gegen `capabilities/default.json`
// (im Tauri-Quelltext verifiziert: `webview/mod.rs:1823` -- ohne Manifest
// ist `has_app_acl` falsch und der Wachter uebersprungen). Spec §8.3
// verlangt genau das.
//
// DIE LISTE UNTEN EXISTIERT DREIMAL und muss dreimal gepflegt werden:
// hier (Strings), in `src/lib.rs`s `generate_handler!` (Identifier) und in
// `capabilities/default.json` (`allow-<kebab-case>`). Das ist unvermeidbar --
// `generate_handler!` braucht Identifier, die ACL braucht Namen.
// `tests/capabilities_acl.rs` haelt die drei zusammen und wird rot, sobald
// eine abweicht. Diesen Kommentar NICHT als Checkliste benutzen: der Test
// ist die verbindliche Absicherung, ein Kommentar veraltet.
//
// Schreibweise in `default.json` ist KEBAB-CASE (`allow-connect-host`):
// `autogenerate_command_permissions` slugifiziert mit
// `command.replace('_', "-")`. Tauris eigener Doc-Kommentar an
// `AppManifest::commands` sagt "snake_case" und meint damit
// `commands.allow`, nicht den Identifier -- verbindlich ist der Generator.
//
// Ein FALSCHER oder UEBERZAEHLIGER Eintrag in `default.json` bricht den
// Build (`validate_capabilities`). Still ist nur die andere Richtung: ein
// Command, der hier und in `lib.rs` steht, aber nicht in `default.json`.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
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
        ]),
    ))
    .expect("tauri_build::try_build ist fehlgeschlagen");

    // `tests/acl_runtime.rs` baut eine echte `tauri::App`. Sobald die
    // instanziiert wird, zieht der Linker tao/wry mit hinein, und damit
    // Importe auf comctl32-Version-6-Exporte (`TaskDialogIndirect`,
    // `SetWindowSubclass`, `DefSubclassProc`, `RemoveWindowSubclass`).
    // Version 6 gibt es nur ueber ein Side-by-Side-Manifest -- `tauri_build`
    // bettet eines ein, aber nur in BINAERZIELE. Testbinaere bekommen es
    // nicht, laden comctl32 v5 und sterben beim Prozessstart mit
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139), noch bevor eine Testzeile
    // laeuft. Nachgewiesen mit `dumpbin /imports` an genau diesen vier
    // Namen.
    //
    // `-tests` statt `-bins`: das Binaerziel hat sein Manifest bereits, und
    // der Release-Bau bleibt dadurch unangetastet.
    #[cfg(target_os = "windows")]
    println!(
        "cargo::rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}
