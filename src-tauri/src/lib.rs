// `clippy::significant_drop_in_scrutinee` ist ein Nursery-Lint (per Default
// aus). Er erkennt einen `MutexGuard` aus einem `if let`-Scrutinee, der bis
// zum Blockende lebt, ueber ein `.await` hinweg. Dauerhaft aktiviert, damit
// diese Fehlerklasse nicht unbemerkt bleibt.
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
        // `build()`. `index.html` traegt KEINE statischen Kindelemente --
        // jedes Pixel baut `main.ts`. Faellt der Start aus, bleibt deshalb ein
        // leeres Fenster zurueck, und die Ursache steht ausschliesslich in
        // einer Konsole, die erst jemand aufklappen muss. Genau daran ist die
        // Fehlersuche am 2026-07-29 dreimal gescheitert.
        .setup(|app| {
            let config = &app.config().app.windows[0];
            let window = tauri::WebviewWindowBuilder::from_config(app, config)?
                .enable_clipboard_access()
                .build()?;
            // `build()` hat die gespeicherte Lage schon hergestellt (das
            // `on_window_ready` von window-state, siehe oben); erst danach
            // laesst sich die Groesse pruefen. Ein maximiertes Fenster fuellt
            // den Bildschirm ohnehin.
            if !window.is_maximized()? {
                let size = window
                    .inner_size()?
                    .to_logical::<f64>(window.scale_factor()?);
                if let Some(raised) = raised_to_minimum(size, config.min_width, config.min_height) {
                    window.set_size(raised)?;
                }
            }
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
        // Natives "Choose file..." im Anmeldungsmenue
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
            // Hostverwaltung, Erststart, TOFU. Die ACL ist scharf: `build.rs`
            // erzeugt per `tauri_build::try_build` ein App-ACL-Manifest, also
            // braucht JEDER Command dieser Liste auch einen
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

/// Fensterlage (Roadmap S3.2): window-state stellt die gespeicherte Groesse
/// in physischen Pixeln her und prueft dabei die Mindestgroesse aus
/// tauri.conf.json nicht, die Windows nur beim Ziehen erzwingt. Gespeichert
/// bei 100 % und hergestellt bei 150 % laege das Fenster darunter. Liefert
/// die angehobene logische Groesse, `None`, wenn sie schon reicht.
fn raised_to_minimum(
    size: tauri::LogicalSize<f64>,
    min_width: Option<f64>,
    min_height: Option<f64>,
) -> Option<tauri::LogicalSize<f64>> {
    let width = min_width.map_or(size.width, |min| size.width.max(min));
    let height = min_height.map_or(size.height, |min| size.height.max(min));
    (width != size.width || height != size.height).then_some(tauri::LogicalSize { width, height })
}

#[cfg(test)]
mod tests {
    use super::raised_to_minimum;
    use tauri::LogicalSize;

    #[test]
    fn a_restored_window_below_the_minimum_is_raised_only_where_it_falls_short() {
        let small = LogicalSize::new(1280.0, 400.0);
        assert_eq!(
            raised_to_minimum(small, Some(1100.0), Some(600.0)),
            Some(LogicalSize::new(1280.0, 600.0))
        );
        let narrow = LogicalSize::new(853.3, 533.3);
        assert_eq!(
            raised_to_minimum(narrow, Some(1100.0), Some(600.0)),
            Some(LogicalSize::new(1100.0, 600.0))
        );
    }

    #[test]
    fn a_window_at_or_above_the_minimum_or_without_one_stays() {
        assert_eq!(
            raised_to_minimum(LogicalSize::new(1100.0, 600.0), Some(1100.0), Some(600.0)),
            None
        );
        assert_eq!(
            raised_to_minimum(LogicalSize::new(1920.0, 1009.0), Some(1100.0), Some(600.0)),
            None
        );
        assert_eq!(
            raised_to_minimum(LogicalSize::new(300.0, 200.0), None, None),
            None
        );
    }
}
