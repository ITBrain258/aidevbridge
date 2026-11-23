//! Hostverwaltung: Hosts vorschlagen, auflisten, anlegen, aendern und
//! entfernen, die Antwort auf die Hostschluessel-Frage und die Host-Pruefung.
//! Dazu die Einstellungen der Oberflaeche und die SSH-Schluessel auf Android.
//! Teil des Moduls `commands`; die Huellen-Regel aus dessen Kopf gilt auch
//! hier.

use super::*;

// ---------------------------------------------------------------------
// Hostverwaltung und TOFU-Rueckfrage.
// ---------------------------------------------------------------------

/// Liest `~/.ssh/config` und schlaegt daraus konkrete Hosts fuer den
/// Erststart vor (`src/views/first-run.ts`). Fehlt die Datei, ist das KEIN
/// Fehler -- eine leere Vorschlagsliste ist ein gueltiges Bild (der Nutzer
/// nutzt dann nur das manuelle Formular).
pub fn suggest_hosts_impl() -> Result<Vec<crate::ssh::SshConfigHost>, String> {
    let path = crate::paths::ssh_dir()
        .ok_or_else(|| "could not determine home directory".to_string())?
        .join("config");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(crate::ssh::config_parser::parse(&text))
}

#[tauri::command]
pub fn suggest_hosts() -> Result<Vec<crate::ssh::SshConfigHost>, String> {
    suggest_hosts_impl()
}

/// Liefert die in `settings.toml` gespeicherten Hosts (fuer `src/views/sidebar.ts`).
/// Ein Ladefehler (z. B. eine Datei aus einer neueren Version, siehe
/// `settings::parse_settings`) wird an den Aufrufer durchgereicht, NICHT
/// stillschweigend als leere Liste behandelt -- eine leere Liste wuerde dem
/// Nutzer einen Erststart vortaeuschen, obwohl in Wirklichkeit eine
/// unlesbare `settings.toml` vorliegt.
///
/// Nimmt `settings_path` bewusst als Parameter entgegen (dasselbe Muster wie
/// `connect_host_with_known_hosts` gegenueber `connect_host_impl`, und wie
/// `settings::load_from(path)`): ohne diesen Parameter
/// waere diese Funktion nur gegen die ECHTE `%APPDATA%\io.github.itbrain258.aidevbridge\
/// settings.toml` testbar -- Unit-Tests duerften diese Datei aber nicht
/// anfassen (dieselbe Sonderregel wie fuer `~/.ssh/known_hosts`, auf die
/// gleiche Weise geloest).
pub fn list_hosts_impl(settings_path: &Path) -> Result<Vec<HostEntry>, String> {
    settings::load_from(settings_path)
        .map(|s| {
            // Spec §4.8: `auth_kind` kommt hier IMMER als `Some(..)` an, egal
            // was in `settings.toml` tatsaechlich steht -- eine aeltere Datei
            // hat das Feld nie geschrieben (`None`), `add_host_impl` speichert
            // zwar immer `Some(..)`, aber ein von Hand bearbeiteter Eintrag
            // koennte das Feld ebenso weglassen. `types.ts`s
            // `HostEntry.auth_kind` ist NICHT optional -- das Frontend darf an
            // dieser Grenze nie `null` sehen.
            s.hosts
                .into_iter()
                .map(|mut h| {
                    h.auth_kind = Some(h.effective_auth_kind());
                    h
                })
                .collect()
        })
        .map_err(settings_error)
}

#[tauri::command]
pub fn list_hosts() -> Result<Vec<HostEntry>, String> {
    let path = settings::settings_path().map_err(settings_error)?;
    list_hosts_impl(&path)
}

/// DTO aus dem manuellen Formular in `first-run.ts`/`host-form.ts`. Anders
/// als `HostEntry` traegt es keine `id` -- die vergibt `add_host_impl`
/// selbst (siehe `new_host_id`).
#[derive(serde::Deserialize)]
pub struct NewHostEntryDto {
    pub label: String,
    pub hostname: String,
    pub user: String,
    #[serde(default = "default_port_dto")]
    pub port: u16,
    pub tmux_socket: Option<String>,
    pub history_limit: Option<u32>,
    // Ohne dieses Feld verloere `finishAndPersist` (first-run.ts) den
    // Schluesselpfad beim Speichern -- ein Nutzer, der sich mit
    // Schluesseldatei verbindet und den Host speichert, landete ab dem
    // zweiten Start stillschweigend auf ssh-agent. `#[serde(default)]`:
    // Anmeldearten ohne Schluesseldatei lassen das Feld weg.
    #[serde(default)]
    pub key_path: Option<String>,
    // Spec §4.8: die vom Nutzer GEWAEHLTE Anmeldeart --
    // `host-form.ts`s `AuthChoice.kind` uebersetzt direkt hierher (die Werte
    // sind bereits deckungsgleich, siehe `AuthKind`s `rename_all =
    // "lowercase"`). `#[serde(default)]`: ein aelterer Frontend-Build (oder
    // ein Test, der diese Zeile noch nicht kennt) darf dieses Feld weglassen,
    // `add_host_impl` leitet die Anmeldeart dann aus `key_path` ab (siehe
    // dort), genau wie `HostEntry::effective_auth_kind()` es fuer eine alte
    // `settings.toml` tut.
    #[serde(default)]
    pub auth_kind: Option<AuthKind>,
    /// Fehlt es, behaelt `update_host` den gespeicherten Wert, und `add_host`
    /// schaltet an (Spec 2026-10-25 §10.1).
    #[serde(default)]
    pub show_default_socket: Option<bool>,
}

fn default_port_dto() -> u16 {
    22
}

/// Zufaellige, von den Laufzeit-`host_id`s (`h0`, `h1`, ... aus
/// `next_host_id`) UNABHAENGIGE Kennung fuer einen dauerhaft in
/// `settings.toml` gespeicherten Host (Doc-Kommentar auf `next_host_id`
/// weiter oben kuendigt das bereits an). Nutzt den vorhandenen
/// `seed_rng()`-Helfer statt `rand::rng()` (`ThreadRng`) -- hier zwar ohne
/// Async-Grund (keine `.await`-Grenze zu ueberqueren), aber konsistent mit
/// der einzigen anderen Zufallsquelle dieser Datei, keine zweite Quelle
/// ohne Nutzen.
fn new_host_id() -> String {
    // `RngExt` (nicht `Rng`) traegt `.random()` in rand 0.10 -- siehe
    // `tmux::names`s identischer Kommentar/Import fuer `.random_range()`.
    use rand::RngExt as _;
    let mut rng = seed_rng();
    format!("host_{:016x}", rng.random::<u64>())
}

/// Fuegt einen Host zu `settings.toml` hinzu und speichert sofort (keine
/// Session-artige "add now, save later"-Zwischenablage -- Hosts SIND die
/// Voreinstellungen, die laut Randbedingung dauerhaft in `settings.toml`
/// leben). Lesen-Aendern-Schreiben ueber `settings::update_at`: Ein Host, den
/// eine zweite Instanz inzwischen gespeichert hat, bleibt erhalten. Ladefehler
/// werden durchgereicht, NIEMALS mit einem frischen Default ueberschrieben
/// (siehe `settings::load_from`) -- eine zu neue `settings.toml` bleibt
/// schreibgeschuetzt, `add_host` schlaegt dann fehl, statt sie zu
/// ueberschreiben.
///
/// `settings_path` explizit als Parameter (siehe `list_hosts_impl`s
/// Kommentar zur selben Entscheidung).
pub fn add_host_impl(settings_path: &Path, entry: NewHostEntryDto) -> Result<HostEntry, String> {
    // Ein Host, der nie verbinden koennte, wird gar nicht erst gespeichert.
    usable_hostname(&entry.hostname)?;
    let mut host_entry = HostEntry {
        id: new_host_id(),
        label: entry.label,
        hostname: entry.hostname,
        user: entry.user,
        port: entry.port,
        tmux_socket: entry.tmux_socket.unwrap_or_else(settings::default_socket),
        history_limit: entry
            .history_limit
            .unwrap_or_else(settings::default_history),
        key_path: entry.key_path,
        auth_kind: entry.auth_kind,
        show_default_socket: entry.show_default_socket.unwrap_or(true),
    };
    // Spec §4.8: IMMER ein konkretes `Some(..)` speichern (und damit
    // auch zurueckgeben, siehe `first-run.ts::finishAndPersist`/
    // `session-dialog.ts::editHost`, die beide direkt mit diesem
    // Rueckgabewert weiterarbeiten, OHNE einen `list_hosts`-Umweg) --
    // dieselbe `effective_auth_kind()`-Ableitung, die `list_hosts_impl` fuer
    // eine bereits gespeicherte, aeltere `settings.toml` braucht, gilt auch
    // hier: ein DTO ohne `auth_kind` (aelterer Frontend-Build) darf trotzdem
    // NIE einen Host mit `auth_kind: None` erzeugen, sonst saehe das
    // Frontend fuer GENAU DIESEN einen Moment (bis zum naechsten
    // `list_hosts`) ein `null`, das `types.ts`s `HostEntry.auth_kind`
    // ausdruecklich ausschliesst.
    host_entry.auth_kind = Some(host_entry.effective_auth_kind());
    settings::update_at(settings_path, |current| {
        current.hosts.push(host_entry.clone());
        Ok(())
    })
    .map_err(settings_error)?;
    Ok(host_entry)
}

#[tauri::command]
pub async fn add_host(entry: NewHostEntryDto) -> Result<HostEntry, String> {
    off_main_thread(move |path| add_host_impl(path, entry)).await
}

/// Aendert einen gespeicherten Host an Ort und Stelle, per Lesen-Aendern-
/// Schreiben ueber `settings::update_at`. Id, Listenplatz und weggelassene
/// Socket-/Verlaufswerte bleiben; Hosts einer zweiten Instanz bleiben
/// erhalten. Ein gescheitertes Schreiben laesst die bisherige Datei
/// unberuehrt.
pub fn update_host_impl(
    settings_path: &Path,
    id: &str,
    entry: NewHostEntryDto,
) -> Result<HostEntry, String> {
    // Gilt auch fuer einen unveraendert uebernommenen Namen: mit ihm koennte
    // der Host nie verbinden, und erst ein gueltiger Name repariert ihn.
    usable_hostname(&entry.hostname)?;
    settings::update_at(settings_path, |current| {
        let host = current
            .hosts
            .iter_mut()
            .find(|host| host.id == id)
            .ok_or_else(|| anyhow::anyhow!("saved host not found: {id}"))?;
        host.label.clone_from(&entry.label);
        host.hostname.clone_from(&entry.hostname);
        host.user.clone_from(&entry.user);
        host.port = entry.port;
        if let Some(socket) = &entry.tmux_socket {
            host.tmux_socket.clone_from(socket);
        }
        if let Some(history) = entry.history_limit {
            host.history_limit = history;
        }
        host.key_path.clone_from(&entry.key_path);
        host.auth_kind = entry.auth_kind;
        if let Some(show) = entry.show_default_socket {
            host.show_default_socket = show;
        }
        host.auth_kind = Some(host.effective_auth_kind());
        Ok(host.clone())
    })
    .map_err(settings_error)
}

#[tauri::command]
pub async fn update_host(id: String, entry: NewHostEntryDto) -> Result<HostEntry, String> {
    off_main_thread(move |path| update_host_impl(path, &id, entry)).await
}

/// Eine Kachel des Arbeitsplatzes auf dem Draht (`settings::TileEntry`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TileEntryDto {
    #[serde(deserialize_with = "settings::lenient_int")]
    pub slot: u8,
    pub host_id: String,
    pub session: String,
    /// Fremde Kachel (`settings::TileEntry::foreign_session`); fehlt sonst.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreign_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
}

/// Verzeichnisse eines Hosts auf dem Draht (`settings::HostDirs`). `last` ist
/// `null`, wenn es keines gibt.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HostDirsDto {
    pub last: Option<String>,
    pub recent: Vec<String>,
}

/// Der Arbeitsplatz auf dem Draht (`settings::Workspace`). Im Patch ersetzt
/// er den gespeicherten als Ganzes: darum sind alle Felder Pflicht. Ein
/// vergessenes Feld soll als Fehler auffallen, nicht stillschweigend den Rest
/// (z. B. die Verzeichnisse) auf Standard zuruecksetzen.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceDto {
    #[serde(deserialize_with = "settings::lenient_int")]
    pub layout: u8,
    /// `settings::TILES_VERSION_*`; Pflicht wie jedes Feld hier.
    #[serde(deserialize_with = "settings::lenient_int")]
    pub tiles_version: u8,
    pub sidebar_collapsed: bool,
    pub expanded: Vec<String>,
    pub connected: Vec<String>,
    pub tiles: Vec<TileEntryDto>,
    pub dirs: BTreeMap<String, HostDirsDto>,
}

impl From<&settings::Workspace> for WorkspaceDto {
    fn from(workspace: &settings::Workspace) -> Self {
        Self {
            layout: workspace.layout,
            tiles_version: workspace.tiles_version,
            sidebar_collapsed: workspace.sidebar_collapsed,
            expanded: workspace.expanded.clone(),
            connected: workspace.connected.clone(),
            tiles: workspace
                .tiles
                .iter()
                .map(|tile| TileEntryDto {
                    slot: tile.slot,
                    host_id: tile.host_id.clone(),
                    session: tile.session.clone(),
                    foreign_session: tile.foreign_session.clone(),
                    socket: tile.socket.clone(),
                })
                .collect(),
            dirs: workspace
                .dirs
                .iter()
                .map(|(host_id, dirs)| {
                    (
                        host_id.clone(),
                        HostDirsDto {
                            last: dirs.last.clone(),
                            recent: dirs.recent.clone(),
                        },
                    )
                })
                .collect(),
        }
    }
}

impl From<WorkspaceDto> for settings::Workspace {
    fn from(dto: WorkspaceDto) -> Self {
        Self {
            layout: dto.layout,
            tiles_version: dto.tiles_version,
            sidebar_collapsed: dto.sidebar_collapsed,
            expanded: dto.expanded,
            connected: dto.connected,
            tiles: dto
                .tiles
                .into_iter()
                .map(|tile| settings::TileEntry {
                    slot: tile.slot,
                    host_id: tile.host_id,
                    session: tile.session,
                    foreign_session: tile.foreign_session,
                    socket: tile.socket,
                })
                .collect(),
            dirs: dto
                .dirs
                .into_iter()
                .map(|(host_id, dirs)| {
                    (
                        host_id,
                        settings::HostDirs {
                            last: dirs.last,
                            recent: dirs.recent,
                        },
                    )
                })
                .collect(),
        }
    }
}

/// Antwort von `ui_settings` (UI-v2-Spec §12.4, UX-Ueberarbeitung §9.2).
/// Bewusst ein eigener Typ statt `settings::UiSettings`: das DTO ist die
/// Schnittstelle zum WebView, das Settings-Struct das Dateiformat -- heute
/// gleich, muessen es nicht bleiben. Die Werte sind immer geklemmt: auch der
/// WebView sieht nie einen Wert ausserhalb des Bereichs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UiSettingsDto {
    pub theme: String,
    pub terminal_font_size: u8,
    pub copy_on_select: bool,
    pub ctrl_cv_clipboard: bool,
    pub right_click: String,
    pub restore_workspace: bool,
    pub sidebar_width: u16,
    pub screen_reader_mode: bool,
    pub sidebar_rail: bool,
    pub workspace: WorkspaceDto,
    /// Pfad der `settings.toml` fuer die Anzeige unter About.
    pub settings_path: String,
}

impl UiSettingsDto {
    fn from_settings(settings: &settings::Settings, settings_path: &Path) -> Self {
        let ui = &settings.ui;
        Self {
            theme: ui.theme.clone(),
            terminal_font_size: ui.terminal_font_size,
            copy_on_select: ui.copy_on_select,
            ctrl_cv_clipboard: ui.ctrl_cv_clipboard,
            right_click: ui.right_click.clone(),
            restore_workspace: ui.restore_workspace,
            sidebar_width: ui.sidebar_width,
            screen_reader_mode: ui.screen_reader_mode,
            sidebar_rail: ui.sidebar_rail,
            workspace: WorkspaceDto::from(&settings.workspace),
            settings_path: settings_path.display().to_string(),
        }
    }
}

/// Patch von `ui_settings`: nur optionale Felder, jedes wird einzeln
/// angewendet; fehlt eines, bleibt der gespeicherte Wert. `workspace` ersetzt
/// den gespeicherten Arbeitsplatz als Ganzes, wenn es mitkommt (Spec §9.2).
/// `{ theme }` allein funktioniert wie vor der UX-Ueberarbeitung.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(default)]
pub struct UiSettingsPatchDto {
    pub theme: Option<String>,
    #[serde(deserialize_with = "settings::lenient_opt_int")]
    pub terminal_font_size: Option<u8>,
    pub copy_on_select: Option<bool>,
    pub ctrl_cv_clipboard: Option<bool>,
    pub right_click: Option<String>,
    pub restore_workspace: Option<bool>,
    #[serde(deserialize_with = "settings::lenient_opt_int")]
    pub sidebar_width: Option<u16>,
    pub screen_reader_mode: Option<bool>,
    pub sidebar_rail: Option<bool>,
    pub workspace: Option<WorkspaceDto>,
}

impl UiSettingsPatchDto {
    /// Wendet jedes gesetzte Feld an. Klemmen und Verwerfen uebernimmt
    /// `Settings::normalize_for_save` danach.
    fn apply(self, settings: &mut settings::Settings) {
        let ui = &mut settings.ui;
        if let Some(theme) = self.theme {
            ui.theme = theme;
        }
        if let Some(size) = self.terminal_font_size {
            ui.terminal_font_size = size;
        }
        if let Some(copy_on_select) = self.copy_on_select {
            ui.copy_on_select = copy_on_select;
        }
        if let Some(ctrl_cv_clipboard) = self.ctrl_cv_clipboard {
            ui.ctrl_cv_clipboard = ctrl_cv_clipboard;
        }
        if let Some(right_click) = self.right_click {
            ui.right_click = right_click;
        }
        if let Some(restore_workspace) = self.restore_workspace {
            ui.restore_workspace = restore_workspace;
        }
        if let Some(width) = self.sidebar_width {
            ui.sidebar_width = width;
        }
        if let Some(screen_reader_mode) = self.screen_reader_mode {
            ui.screen_reader_mode = screen_reader_mode;
        }
        if let Some(sidebar_rail) = self.sidebar_rail {
            ui.sidebar_rail = sidebar_rail;
        }
        if let Some(workspace) = self.workspace {
            settings.workspace = workspace.into();
        }
    }
}

/// Fehlertext eines Settings-Commands (Spec §9.2): die volle Ursachenkette
/// (`{error:#}`), nicht nur der aeusserste Kontext. `settings::load_from` und
/// `update_at` nennen den Pfad der Datei in jedem ihrer Fehler, bei einer
/// kaputten Datei steht also hier, welche Datei es ist und welche Zeile und
/// Spalte `toml` beanstandet. Ohne Endzeilenumbruch: `toml` haengt einen an.
fn settings_error(error: anyhow::Error) -> String {
    format!("{error:#}").trim_end().to_string()
}

/// Ohne `patch` lesen, mit `patch` Lesen-Aendern-Schreiben ueber
/// `settings::update_at` (wie `add_host_impl`), immer den neuen Stand
/// liefern. Eine fehlende Datei ist ein Erststart (`load_from` liefert
/// `Settings::default()`), Lesen legt sie NICHT an. Hat eine zweite Instanz
/// inzwischen gespeichert, kommt der Patch auf deren Stand: Ihre Hosts
/// bleiben, und `[ui]`/`[workspace]` tragen danach die Werte des Patches.
///
/// `settings_path` explizit als Parameter, dieselbe Entscheidung wie bei
/// `list_hosts_impl`/`add_host_impl` (testbar ohne Konfigurationsverzeichnis).
pub fn ui_settings_impl(
    settings_path: &Path,
    patch: Option<UiSettingsPatchDto>,
) -> Result<UiSettingsDto, String> {
    let Some(patch) = patch else {
        let current = settings::load_from(settings_path).map_err(settings_error)?;
        return Ok(UiSettingsDto::from_settings(&current, settings_path));
    };
    settings::update_at(settings_path, |current| {
        patch.clone().apply(current);
        // Die Antwort zeigt den Stand, der in die Datei geht.
        current.normalize_for_save();
        Ok(UiSettingsDto::from_settings(current, settings_path))
    })
    .map_err(settings_error)
}

/// Die Commands, die `settings.toml` schreiben (`add_host`, `update_host`,
/// `remove_host`, `ui_settings`), sind `async` und schreiben auf dem
/// Blocking-Pool. Synchrone Commands laufen auf dem Hauptthread, der auch das
/// Fenster zeichnet, und jedes Speichern wartet auf `sync_all` fuer Datei und
/// Ordner (unter macOS `F_FULLFSYNC`): Als synchroner Command liesse es das
/// Fenster so lange stehen.
/// Gleichzeitige Speichervorgaenge schliesst `settings::update_at` gegenseitig
/// aus (Spec §12.4), haelt aber nicht ihre Reihenfolge ein: Wer zuerst die
/// Sperre bekommt, schreibt zuerst. Das Frontend schickt `ui_settings` deshalb
/// erst nach der Antwort auf den vorigen Aufruf (`writeUiSettings` in
/// `main.ts`); die Host-Commands kommen aus Dialogen, die auf ihre Antwort
/// warten.
async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = settings::settings_path().map_err(settings_error)?;
        work(&path)
    })
    .await
    .map_err(|error| format!("could not read or save the settings: {error}"))?
}

#[tauri::command]
pub async fn ui_settings(patch: Option<UiSettingsPatchDto>) -> Result<UiSettingsDto, String> {
    off_main_thread(move |path| ui_settings_impl(path, patch)).await
}

/// Entfernt einen Host aus `settings.toml` per `id`. Kein Fehler, wenn `id`
/// nicht (mehr) existiert -- dasselbe idempotente Muster wie
/// `close_terminal_impl`/`TmuxClient::kill_session`.
///
/// Mit dem Host fallen auch seine Eintraege im Arbeitsplatz weg
/// (UX-Ueberarbeitung, Spec §7.1): `expanded`, `connected`, `tiles` und
/// `dirs`. Layout und Seitenleiste gehoeren keinem Host und bleiben.
///
/// Lesen-Aendern-Schreiben ueber `settings::update_at`: Hosts, die eine
/// zweite Instanz inzwischen gespeichert hat, bleiben erhalten.
///
/// `settings_path` explizit als Parameter (siehe `list_hosts_impl`s
/// Kommentar zur selben Entscheidung).
///
/// Auf Android vergisst die App dabei auch den Hostschluessel
/// (`forget_host_key_path`, Nachtrag vom 13.11.2026 zur Android-Spec).
pub fn remove_host_impl(settings_path: &Path, id: &str) -> Result<(), String> {
    remove_host_forgetting_key(settings_path, id, forget_host_key_path().as_deref())
}

/// Die `known_hosts`, deren Eintrag eines entfernten Hosts die App vergisst:
/// nur auf Android. Dort liegt die Datei im privaten Speicher der App, niemand
/// kommt mit `ssh-keygen -R` an sie heran, und ein Host mit neuem
/// Serverschluessel bliebe sonst unerreichbar. Auf dem Desktop teilt sich die
/// App die Datei mit OpenSSH und haengt nur an (`docs/guide/data.md`).
pub(super) fn forget_host_key_path() -> Option<PathBuf> {
    if cfg!(target_os = "android") {
        crate::paths::ssh_dir().map(|dir| dir.join("known_hosts"))
    } else {
        None
    }
}

/// `remove_host_impl` mit ausdruecklicher `known_hosts`; `None` laesst sie
/// unberuehrt. Der Schluessel faellt VOR dem Host weg: scheitert das, bleibt
/// der Host gespeichert, und der Nutzer kann es noch einmal versuchen. Faellt
/// danach das Speichern aus, fragt die naechste Verbindung wie beim
/// Erstkontakt -- die Seite, auf der nichts ungeprueft durchgeht.
///
/// Der Schluessel faellt auch dann, wenn ein anderer gespeicherter Host
/// denselben Namen und Port nutzt (etwa ein zweites Konto): Er sieht denselben
/// Server und denselben Schluessel. Bliebe der Eintrag dann stehen, fuehrte
/// der Weg aus der Meldung zu einem geaenderten Schluessel ("remove the host
/// ... add it again") im Kreis; so fragt der andere Host beim naechsten
/// Verbinden einmal neu, mit Fingerabdruck.
pub(super) fn remove_host_forgetting_key(
    settings_path: &Path,
    id: &str,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    if let Some(known_hosts) = known_hosts {
        let current = settings::load_from(settings_path).map_err(settings_error)?;
        if let Some(removed) = current.hosts.iter().find(|h| h.id == id) {
            known_hosts::forget_host(known_hosts, &removed.hostname, removed.port).map_err(
                |error| {
                    format!(
                        "Couldn't forget the saved host key of {}: {error:#}",
                        removed.hostname
                    )
                },
            )?;
        }
    }
    settings::update_at(settings_path, |current| {
        current.hosts.retain(|h| h.id != id);
        // Verteidigung in der Tiefe: `update_at` verwirft die Eintraege
        // unbekannter Hosts ohnehin, also auch die des eben entfernten.
        current.workspace.forget_host(id);
        Ok(())
    })
    .map_err(settings_error)
}

#[tauri::command]
pub async fn remove_host(id: String) -> Result<(), String> {
    off_main_thread(move |path| remove_host_impl(path, &id)).await
}

/// Serialisierbare Sicht auf `preflight::PreflightReport` fuer den WebView
/// (`first-run.ts`: "Haekchen je Pruefung" plus die
/// blockierende Meldung aus `blocking_problem()`). `blocking_problem` wird
/// HIER (im Backend) einmalig berechnet und mitgeschickt, statt die drei
/// Rohfelder im WebView erneut zu interpretieren -- eine zweite,
/// abweichende Auswertung der Regeln aus `preflight.rs` im TypeScript waere
/// eine zweite Quelle, die driften koennte.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PreflightReportDto {
    pub tmux_version: Option<String>,
    pub has_base64: bool,
    pub socket_dir_writable: bool,
    pub blocking_problem: Option<String>,
}

impl From<crate::preflight::PreflightReport> for PreflightReportDto {
    fn from(r: crate::preflight::PreflightReport) -> Self {
        let blocking_problem = r.blocking_problem();
        Self {
            tmux_version: r.tmux_version,
            has_base64: r.has_base64,
            socket_dir_writable: r.socket_dir_writable,
            blocking_problem,
        }
    }
}

pub async fn run_preflight_impl(
    state: &Arc<AppState>,
    host_id: String,
) -> Result<PreflightReportDto, String> {
    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
    let transport = state
        .ready_host(&host_id)
        .ok_or_else(|| "host not connected".to_string())?;
    let transport = transport.command(deadline);
    let report = crate::preflight::run(&transport)
        .await
        .map_err(|e| e.to_string())?;
    Ok(report.into())
}

#[tauri::command]
pub async fn run_preflight(
    state: State<'_, Arc<AppState>>,
    host_id: String,
) -> Result<PreflightReportDto, String> {
    run_preflight_impl(state.inner(), host_id).await
}

/// Beantwortet eine per `hostkey://request` gestellte TOFU-Rueckfrage
/// (`src/views/host-key-prompt.ts`). Liefert einen Fehler, wenn
/// `request_id` nicht (mehr) bekannt ist -- bereits beantwortet oder per
/// Zeitablauf schon von `TofuPolicy::decide` selbst aufgegeben (siehe
/// `AppState::forget_host_key_request`).
///
/// Synchronous because it only resolves an owned oneshot under short locks.
/// The policy awaits that answer without blocking a runtime worker.
pub fn respond_host_key_impl(
    state: &Arc<AppState>,
    request_id: u64,
    accept: bool,
) -> Result<(), String> {
    if state.resolve_host_key_request(request_id, accept) {
        Ok(())
    } else {
        Err(
            "no pending host key request with this id (it may already have been answered \
             or timed out)"
                .to_string(),
        )
    }
}

#[tauri::command]
pub fn respond_host_key(
    state: State<'_, Arc<AppState>>,
    request_id: u64,
    accept: bool,
) -> Result<(), String> {
    respond_host_key_impl(state.inner(), request_id, accept)
}

// ---------------------------------------------------------------------
// Verwaltungsschale: Schluesselauswahl fuer die Anmeldemaske.
// ---------------------------------------------------------------------

/// Listet benutzbare Schluessel in `~/.ssh`. Oeffnet AUSSCHLIESSLICH
/// `.pub`-Dateien -- eine Liste zu bauen ist kein Anlass, Schluesselmaterial
/// anzufassen (Spec §8.2). Dieses Projekt verbietet Tests den Zugriff auf
/// `known_hosts`; derselbe Massstab gilt im Produktivpfad.
#[tauri::command]
pub async fn list_ssh_keys() -> Result<Vec<crate::ssh::keys::SshKeyDto>, String> {
    let dir = crate::paths::ssh_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(crate::ssh::keys::list_keys_in(&dir))
}

/// Schluessel erzeugen und uebernehmen gibt es nur auf Android (Spec
/// 2026-10-27 §5.3). Auf dem Desktop ruft die Oberflaeche beides nie auf;
/// die Wache haelt eine uebernommene Seite davon ab, darueber in das echte
/// `~/.ssh` zu schreiben oder beliebige Pfade zu oeffnen (unter Windows auch
/// UNC-Pfade, die eine SMB-Anmeldung samt NTLM-Hash ausloesen).
fn android_only() -> Result<(), String> {
    if cfg!(target_os = "android") {
        Ok(())
    } else {
        Err("Only available on Android".to_string())
    }
}

/// Android (Spec 2026-10-27 §5.3): erzeugt einen ed25519-Schluessel im
/// `.ssh`-Ordner der App und liefert die Zeile fuer `authorized_keys`. Der
/// Kommentar nennt App und Datum, damit der Schluessel auf dem Host
/// wiederzuerkennen ist.
#[tauri::command]
pub async fn generate_ssh_key(
    comment: String,
) -> Result<crate::ssh::key_files::GeneratedKeyDto, String> {
    android_only()?;
    let dir = crate::paths::ssh_dir().ok_or_else(|| "Home directory not found".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::ssh::key_files::generate_into(&dir, comment.trim())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Android (Spec 2026-10-27 §5.3): uebernimmt die in der Dateiauswahl
/// gewaehlte Schluesseldatei in den `.ssh`-Ordner der App. `source` ist dort
/// eine `content://`-URI, die nur das fs-Plugin oeffnen kann; auf dem Desktop
/// ein Pfad.
#[tauri::command]
pub async fn import_ssh_key<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    source: String,
) -> Result<crate::ssh::keys::SshKeyDto, String> {
    android_only()?;
    let dir = crate::paths::ssh_dir().ok_or_else(|| "Home directory not found".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_picked_file(&app, &source)?;
        crate::ssh::key_files::import_into(&dir, &bytes)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Liest hoechstens eine Schluesseldatei mehr als erlaubt, damit
/// `import_into` eine zu grosse Datei erkennt, ohne sie ganz zu laden.
fn read_picked_file<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    source: &str,
) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    use std::io::Read;
    #[cfg(target_os = "android")]
    let file = {
        use tauri_plugin_fs::FsExt;
        let path: tauri_plugin_fs::FilePath =
            source.parse().map_err(|_| "Invalid file".to_string())?;
        let mut options = tauri_plugin_fs::OpenOptions::new();
        options.read(true);
        app.fs().open(path, options)
    };
    #[cfg(not(target_os = "android"))]
    let file = {
        let _ = app;
        std::fs::File::open(source)
    };
    // Vorab gross genug: Ein wachsender Vec liesse beim Umkopieren Teile des
    // Schluessels ungeloescht im freigegebenen Speicher.
    let mut bytes = zeroize::Zeroizing::new(Vec::with_capacity(
        crate::ssh::key_files::MAX_KEY_FILE_BYTES + 1,
    ));
    file.and_then(|file| {
        file.take(crate::ssh::key_files::MAX_KEY_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
    })
    .map_err(|error| format!("could not read the file: {error}"))?;
    Ok(bytes)
}

// Befund der Durchsicht vom 29.10.: Beide Befehle waren auch auf dem Desktop
// erreichbar.
#[cfg(all(test, not(target_os = "android")))]
mod android_only_tests {
    #[test]
    fn the_desktop_neither_generates_nor_imports_keys() {
        assert!(super::android_only().is_err());
        let generated = tauri::async_runtime::block_on(super::generate_ssh_key("x".to_string()));
        assert_eq!(
            generated.err().as_deref(),
            Some("Only available on Android")
        );
    }
}
