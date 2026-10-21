// Task 10, uebersehener Fehler: `clippy::significant_drop_in_scrutinee` ist
// ein Nursery-Lint (per Default aus) und haette den `disconnect_host_impl`-
// Fehler (MutexGuard aus einem `if let`-Scrutinee lebt bis zum Blockende,
// ueber ein `.await` hinweg) erkannt, wenn er an war. Dauerhaft aktiviert,
// damit dieselbe Fehlerklasse nicht ein drittes Mal unbemerkt bleibt.
#![warn(clippy::significant_drop_in_scrutinee)]

pub mod commands;
pub mod connection;
pub mod keymap;
pub mod preflight;
pub mod remote;
pub mod settings;
pub mod ssh;
pub mod status;
pub mod tmux;
pub mod transport;

// Task 11 ersetzt Task 1s Demoseite (die `greet` aufrief) durch die
// TerminalView -- `src/main.ts` hat damit keinen Aufrufer mehr fuer
// `greet`. Der vorherige Kommentar an dieser Stelle kuendigte genau diese
// Entfernung fuer Task 11 an; sie ist jetzt nachgeholt, statt einen toten
// Command registriert zu lassen.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Umzug der `settings.toml` aus 0.1.2: vor allem anderen, damit das
    // erste Laden die umgezogene Datei schon sieht.
    settings::migrate_legacy_settings();
    tauri::Builder::default()
        // Das Fenster `main` entsteht hier statt automatisch aus
        // tauri.conf.json (dort `"create": false`, Spec §8.5): nur der Builder
        // kennt `enable_clipboard_access`. Ohne sie erteilt wry WebView2 die
        // Leseberechtigung fuer die Zwischenablage nicht, und
        // `navigator.clipboard.readText()` loest beim ersten Einfuegen eine
        // Abfrage aus. `from_config(..).build()` ist derselbe Aufruf, mit dem
        // Tauri das Fenster sonst selbst baut (tauri-2.11.5/src/app.rs:2525);
        // window-state stellt Lage und Groesse weiter her, weil sein
        // `on_window_ready` an jedem gebauten Fenster haengt und das Plugin
        // schon in `Builder::build` initialisiert ist, vor `setup`.
        //
        // Nur im Debug-Bau: Entwicklerwerkzeuge sofort oeffnen, erst nach
        // `build()`. `index.html` traegt seit dem Umbau KEINE statischen
        // Kindelemente mehr -- jedes Pixel baut `main.ts`. Faellt der Start
        // aus, bleibt deshalb ein leeres Fenster zurueck, und die Ursache
        // steht ausschliesslich in einer Konsole, die erst jemand aufklappen
        // muss. Genau daran ist die Fehlersuche am 2026-07-29 dreimal
        // gescheitert.
        .setup(|app| {
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .enable_clipboard_access()
                    .build()?;
            #[cfg(debug_assertions)]
            window.open_devtools();
            let _ = window;
            Ok(())
        })
        // Bestand seit dem Projektgeruest. `commands::open_link` braucht diese
        // Registrierung nicht: es ruft die freie Funktion
        // `tauri_plugin_opener::open_url`. Der WebView bekommt kein
        // `opener:`-Recht; Links laufen ausschliesslich ueber `open_link` und
        // dessen Pruefung in `commands::validate_link` (Spec §6.5).
        .plugin(tauri_plugin_opener::init())
        // Shell-Task 8: natives "Choose file..." im Anmeldungsmenue
        // (`src/views/host-form.ts`) braucht den Dateiauswahldialog. Das
        // zugehoerige Recht (`dialog:allow-open`, siehe capabilities/
        // default.json) faellt NICHT in die Command-Zaehlung
        // (`EXPECTED_COMMAND_COUNT` in tests/capabilities_acl.rs) -- es ist
        // kein `#[tauri::command]` dieser App, sondern ein Plugin-Recht.
        .plugin(tauri_plugin_dialog::init())
        // Fensterlage, -groesse und der maximierte Zustand ueberleben den Neustart
        // (Roadmap S3.2). Das Plugin haengt sich an die Fensterereignisse und
        // schreibt beim Beenden nach `app_config_dir()/.window-state.json` --
        // unter Windows `%APPDATA%\io.github.itbrain258.aidevbridge\.window-state.json`,
        // nach dem Identifier aus tauri.conf.json. Seit der Umbenennung liegt
        // `settings.toml` im selben Ordner (`settings::SETTINGS_DIR_NAME`),
        // den auch der Deinstaller kennt. Die Werte aus `tauri.conf.json`
        // gelten damit nur noch beim ALLERERSTEN Start. Rein serverseitig --
        // der WebView ruft davon nichts auf, deshalb braucht die ACL keinen
        // Eintrag (siehe capabilities/default.json).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(std::sync::Arc::new(commands::AppState::from_env()))
        .invoke_handler(tauri::generate_handler![
            commands::begin_connect,
            commands::connect_host,
            commands::begin_control_repair,
            commands::repair_control,
            commands::cancel_control_repair,
            commands::create_session,
            commands::open_terminal,
            commands::send_input,
            commands::resize_terminal,
            commands::ack_output,
            commands::close_terminal,
            commands::kill_session,
            commands::disconnect_host,
            // Task 13 (Hostverwaltung, Erststart, TOFU). Seit Task 7 ist
            // die ACL scharf: `build.rs` erzeugt per
            // `tauri_build::try_build` ein App-ACL-Manifest, also braucht
            // JEDER Command dieser Liste auch einen
            // `allow-<kebab-case>`-Eintrag in `capabilities/default.json`,
            // sonst lehnt Tauri ihn zur Laufzeit ab.
            // `tests/capabilities_acl.rs` haelt alle FUENF Listen zusammen
            // (diese, `build.rs`, `capabilities/default.json`, das
            // Fenster-Label und `tests/acl_runtime.rs`).
            commands::suggest_hosts,
            commands::list_hosts,
            commands::add_host,
            commands::update_host,
            commands::remove_host,
            commands::run_preflight,
            commands::respond_host_key,
            commands::list_ssh_keys,
            commands::list_sessions,
            commands::poll_status,
            commands::list_directories,
            commands::ui_settings,
            commands::open_link,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
