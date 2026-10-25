//! Hostverwaltung und Voreinstellungen (Task 13). KEIN Session-Zustand --
//! Randbedingung des Projekts: `settings.toml` traegt Hosts und
//! Voreinstellungen, niemals laufende Sessions (die leben ausschliesslich im
//! Arbeitsspeicher der Anwendung bzw. auf dem entfernten `tmux`-Server).
//!
//! Seit der UX-Ueberarbeitung (Spec §7.1, §9.2) kommen die Terminal-
//! Voreinstellungen (`[ui]`) und der Arbeitsplatz (`[workspace]`) dazu: Layout,
//! Kachelzuordnung (Host-Id und Sessionname), aufgeklappte und verbundene
//! Hosts, Seitenleiste und je Host die letzten Verzeichnisse. Das sind
//! Verweise auf Sessions, keine laufenden Sessions. Die Dateiversion bleibt 1:
//! jedes neue Feld hat einen serde-Default und kein Abschnitt lehnt unbekannte
//! Schluessel ab, damit eine alte App die Datei der neuen Version weiter liest
//! (und beim naechsten Speichern die neuen Teile weglaesst, hingenommen).
//!
//! Bewusst Tauri-frei (kein `AppHandle`, kein `tauri::path`-Resolver): der
//! Pfad kommt aus `dirs::config_dir()`, demselben Mechanismus, den
//! `ssh::known_hosts`/`commands::connect_host_impl` schon fuer
//! `dirs::home_dir()` verwenden -- dieses Modul bleibt damit ohne laufende
//! Anwendung testbar (`load_from`/`save_to` nehmen den Pfad explizit
//! entgegen, siehe Testmodul). Im Debug-Bau kann `AIDEVBRIDGE_SETTINGS_DIR`
//! den Ordner ersetzen (Spec §9.3, siehe `settings_path`). Beim Start kopiert
//! `migrate_legacy_settings` die `settings.toml` von 0.1.2 aus dem Ordner
//! `agentbridge`, solange im neuen Ordner keine liegt (seit 0.2.0).

use anyhow::Context;
use serde::Deserializer;
use std::collections::{BTreeMap, HashSet};
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

pub const CURRENT_VERSION: u32 = 1;

// --- Standards und Gueltigkeitsbereiche (UX-Ueberarbeitung, Spec §9.2) ---
//
// Jeder Wert steht hier genau einmal; `Default`, die Klemmregeln und die
// Tests lesen dieselben Konstanten.

/// Schriftgroesse des Terminals in px.
pub const DEFAULT_TERMINAL_FONT_SIZE: u8 = 13;
pub const TERMINAL_FONT_SIZE_RANGE: RangeInclusive<u8> = 10..=20;
/// Breite der Seitenleiste in px.
pub const DEFAULT_SIDEBAR_WIDTH: u16 = 240;
pub const SIDEBAR_WIDTH_RANGE: RangeInclusive<u16> = 200..=480;
/// Rechtsklick im Terminal: Menue oder Einfuegen.
pub const DEFAULT_RIGHT_CLICK: &str = "menu";
pub const RIGHT_CLICK_MODES: [&str; 2] = ["menu", "paste"];
/// Anzahl der Kacheln im Raster. Seit Spec 2026-10-19 §4.6 schreibt das
/// Frontend den Wert nur noch abgeleitet (4 ab vier Kacheln, 2 bei zwei oder
/// drei, sonst 1), damit 0.1.2 die ersten vier Kacheln weiter zeigt.
pub const DEFAULT_LAYOUT: u8 = 1;
pub const LAYOUTS: [u8; 3] = [1, 2, 4];
/// Hoechstens neun Kacheln, Plaetze 0 bis 8 (Spec 2026-10-19 §4.6).
pub const MAX_TILES: usize = 9;
pub const MAX_TILE_SLOT: u8 = 8;
/// `[workspace] tiles_version`: 1 ist das alte Platzmodell (Plaetze hinter
/// `layout` waren geparkt), 2 die Kachelliste. Die Dateiversion bleibt 1,
/// sonst startete 0.1.2 schreibgeschuetzt (`parse_settings`).
pub const TILES_VERSION_SLOTS: u8 = 1;
pub const TILES_VERSION_LIST: u8 = 2;
/// Je Host die letzten fuenf Verzeichnisse.
pub const MAX_RECENT_DIRS: usize = 5;

/// Eine Ganzzahl aus der Datei (oder dem Patch), die nicht in den Zieltyp
/// passt -- negativ oder zu gross --, ist ein ungueltiger Wert wie jeder
/// andere und klemmt auf den Standard. Ohne diesen Weg liesse `u8`/`u16` die
/// ganze Datei als Parsefehler scheitern, und eine handbearbeitete
/// `terminal_font_size = 300` machte die Hostliste unlesbar.
///
/// Der Wert wird zum Hoechstwert des Typs: der liegt in keinem der gueltigen
/// Bereiche und kein Platz 0..=8, die Klemmregeln fangen ihn also wie jeden
/// anderen ungueltigen Wert. (Saettigen auf 0 ginge nicht: ein negativer
/// `slot` wuerde sonst zu Platz 0.)
pub(crate) trait Narrow: Sized {
    fn narrow(value: i64) -> Self;
}

impl Narrow for u8 {
    fn narrow(value: i64) -> Self {
        u8::try_from(value).unwrap_or(u8::MAX)
    }
}

impl Narrow for u16 {
    fn narrow(value: i64) -> Self {
        u16::try_from(value).unwrap_or(u16::MAX)
    }
}

/// `deserialize_with` fuer die Zahlenfelder, siehe [`Narrow`].
pub(crate) fn lenient_int<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Narrow,
{
    use serde::Deserialize as _;
    i64::deserialize(deserializer).map(T::narrow)
}

/// Wie [`lenient_int`] fuer optionale Felder (der Patch von `ui_settings`).
pub(crate) fn lenient_opt_int<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Narrow,
{
    use serde::Deserialize as _;
    Option::<i64>::deserialize(deserializer).map(|value| value.map(T::narrow))
}

/// Ein Pfad auf dem ENTFERNTEN Rechner ist ein POSIX-Pfad: absolut heisst, er
/// beginnt mit `/`. `Path::is_absolute` waere hier falsch -- unter Windows
/// gilt `/home/x` dort nicht als absolut. Dazu keine Steuerzeichen. Das ist
/// die einzige Fassung dieser Regel: `commands::is_acceptable_remote_path`
/// ruft sie auf (die Abhaengigkeit laeuft von `commands` zu `settings`, nicht
/// umgekehrt).
pub(crate) fn is_absolute_remote_path(path: &str) -> bool {
    path.starts_with('/') && !path.chars().any(|c| c.is_control())
}

/// `[ui]`-Abschnitt (UI-v2-Spec §12.3, UX-Ueberarbeitung §9.2). `theme` bleibt
/// eine freie Zeichenkette: Rust prueft den Wert nicht, der Rueckfall auf
/// "turquoise" liegt im Frontend (`src/theme.ts::normalizeTheme`), damit ein
/// unbekannter Wert dort einen Hinweis erzeugen kann, statt hier still zu
/// verschwinden. Alle anderen Felder klemmt [`UiSettings::clamp`] beim Laden
/// und Speichern auf ihren Standard.
/// Die Dateiversion bleibt 1: aeltere Builds ueberlesen den Abschnitt und
/// lassen ihn beim naechsten Speichern weg (akzeptiert, §12.3).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct UiSettings {
    pub theme: String,
    /// 10..=20, sonst 13.
    #[serde(deserialize_with = "lenient_int")]
    pub terminal_font_size: u8,
    pub copy_on_select: bool,
    /// Strg+C kopiert nur bei Markierung, Strg+V fuegt ein.
    pub ctrl_cv_clipboard: bool,
    /// "menu" oder "paste", sonst "menu".
    pub right_click: String,
    /// "Restore hosts and terminals" beim Start.
    pub restore_workspace: bool,
    /// 200..=480, sonst 240.
    #[serde(deserialize_with = "lenient_int")]
    pub sidebar_width: u16,
}

fn default_theme() -> String {
    "turquoise".to_string()
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
            copy_on_select: false,
            ctrl_cv_clipboard: true,
            right_click: DEFAULT_RIGHT_CLICK.to_string(),
            restore_workspace: true,
            sidebar_width: DEFAULT_SIDEBAR_WIDTH,
        }
    }
}

impl UiSettings {
    /// Ungueltige Werte werden zum Standard (Spec §9.2). `theme` bleibt, wie es ist.
    pub fn clamp(&mut self) {
        if !TERMINAL_FONT_SIZE_RANGE.contains(&self.terminal_font_size) {
            self.terminal_font_size = DEFAULT_TERMINAL_FONT_SIZE;
        }
        if !SIDEBAR_WIDTH_RANGE.contains(&self.sidebar_width) {
            self.sidebar_width = DEFAULT_SIDEBAR_WIDTH;
        }
        if !RIGHT_CLICK_MODES.contains(&self.right_click.as_str()) {
            self.right_click = DEFAULT_RIGHT_CLICK.to_string();
        }
    }
}

/// Eine Kachel des Rasters: welche Session auf welchem Platz lag. Der
/// Sessionname ist der Name auf dem entfernten tmux-Server.
///
/// Jedes Feld hat einen Default, damit ein von Hand beschaedigter
/// `[[workspace.tiles]]`-Eintrag (Feld vergessen) die Datei nicht unlesbar
/// macht und mit ihr die Hostliste. Der Default ist ein ungueltiger Wert,
/// und `Workspace::clamp` verwirft die Kachel (siehe [`TileEntry::is_valid`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TileEntry {
    /// Platz 0..=8; ein hoeherer Platz verwirft die Kachel, ein fehlender
    /// ebenso (siehe [`missing_slot`]).
    #[serde(default = "missing_slot", deserialize_with = "lenient_int")]
    pub slot: u8,
    #[serde(default)]
    pub host_id: String,
    #[serde(default)]
    pub session: String,
    /// Name einer Session auf dem Standard-Socket (Spec 2026-10-25 §5). Dann
    /// ist `session` leer und `socket` gleich `default`: 0.2.x verwirft so eine
    /// Kachel, statt eine eigene Session gleichen Namens zu oeffnen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreign_session: Option<String>,
    /// `default` fuer eine fremde Kachel, sonst fehlend. Als Text gelesen,
    /// damit ein von Hand verdorbener Wert nur die Kachel verwirft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
}

/// Platz einer Kachel ohne `slot`: derselbe ungueltige Wert, den [`Narrow`] fuer
/// eine unlesbare Zahl liefert. Ein Platz, den niemand angegeben hat, wird so
/// wenig zu Platz 0 wie ein negativer.
fn missing_slot() -> u8 {
    u8::MAX
}

impl TileEntry {
    /// Platz 0..=8, und die Kachel nennt einen Host und eine Session: eine
    /// eigene in `session` oder eine fremde in `foreign_session` mit `socket =
    /// "default"`, nie beides. Mehr prueft das Laden nicht: ob der Host
    /// existiert, weiss erst `Settings` (beim Speichern), ob die Session noch
    /// laeuft, erst der Start.
    fn is_valid(&self) -> bool {
        let names_a_session = match (&self.foreign_session, self.socket.as_deref()) {
            (None, None) => !self.session.is_empty(),
            (Some(name), Some(socket)) => {
                socket == crate::tmux::SocketKind::Default.as_str()
                    && self.session.is_empty()
                    && !name.is_empty()
            }
            _ => false,
        };
        self.slot <= MAX_TILE_SLOT && !self.host_id.is_empty() && names_a_session
    }
}

/// Verzeichnisse eines Hosts fuer "Neue Session" (Spec §7.1).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostDirs {
    /// Zuletzt genutztes Verzeichnis; nur ein absoluter Pfad gilt.
    pub last: Option<String>,
    /// Die letzten Verzeichnisse, neueste zuerst: hoechstens fuenf absolute Pfade.
    pub recent: Vec<String>,
}

impl HostDirs {
    fn clamp(&mut self) {
        // Erst filtern, dann kuerzen: fuenf gueltige Eintraege, nicht fuenf
        // Eintraege, von denen einige ungueltig waren. Die Reihenfolge bleibt
        // (neueste zuerst), gekuerzt wird also am alten Ende.
        self.recent.retain(|dir| is_absolute_remote_path(dir));
        self.recent.truncate(MAX_RECENT_DIRS);
        if self
            .last
            .as_deref()
            .is_some_and(|dir| !is_absolute_remote_path(dir))
        {
            self.last = None;
        }
    }
}

/// `[workspace]`-Abschnitt (Spec §7.1, §9.2): was beim naechsten Start
/// wiederhergestellt werden kann. Die Felder stehen in der Reihenfolge der
/// Datei: einfache Werte zuerst, die Tabellen `tiles` und `dirs` zuletzt.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Workspace {
    /// 1, 2 oder 4 Kacheln, sonst 1.
    #[serde(deserialize_with = "lenient_int")]
    pub layout: u8,
    /// 1 (altes Platzmodell) oder 2 (Kachelliste), sonst 1. Fehlt der
    /// Schluessel, stammt die Datei aus dem alten Modell (Spec 2026-10-19 §4.6).
    #[serde(deserialize_with = "lenient_int")]
    pub tiles_version: u8,
    pub sidebar_collapsed: bool,
    /// Aufgeklappte Hosts (Host-Ids).
    pub expanded: Vec<String>,
    /// Hosts, die der Nutzer verbunden haben will (Host-Ids).
    pub connected: Vec<String>,
    /// Hoechstens neun Kacheln.
    pub tiles: Vec<TileEntry>,
    /// Je Host-Id die Verzeichnisse. Leer wird weggelassen: eine leere Tabelle
    /// brauchte sonst eine eigene Kopfzeile.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub dirs: BTreeMap<String, HostDirs>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            layout: DEFAULT_LAYOUT,
            tiles_version: TILES_VERSION_SLOTS,
            sidebar_collapsed: false,
            expanded: Vec::new(),
            connected: Vec::new(),
            tiles: Vec::new(),
            dirs: BTreeMap::new(),
        }
    }
}

impl Workspace {
    /// Ungueltige Werte werden zum Standard, ungueltige Kacheln und Pfade
    /// fallen weg (Spec §9.2).
    pub fn clamp(&mut self) {
        if !LAYOUTS.contains(&self.layout) {
            self.layout = DEFAULT_LAYOUT;
        }
        if ![TILES_VERSION_SLOTS, TILES_VERSION_LIST].contains(&self.tiles_version) {
            self.tiles_version = TILES_VERSION_SLOTS;
        }
        // Ein Platz hinter dem letzten gibt es nicht, eine Kachel ohne Host
        // oder Session verweist auf nichts; mehr als neun Kacheln auch nicht
        // (die ersten neun gueltigen bleiben).
        self.tiles.retain(TileEntry::is_valid);
        self.tiles.truncate(MAX_TILES);
        for dirs in self.dirs.values_mut() {
            dirs.clamp();
        }
    }

    /// Behaelt nur Eintraege von Hosts, fuer die `keep` wahr ist.
    pub fn retain_hosts(&mut self, keep: impl Fn(&str) -> bool) {
        self.expanded.retain(|id| keep(id));
        self.connected.retain(|id| keep(id));
        self.tiles.retain(|tile| keep(&tile.host_id));
        self.dirs.retain(|id, _| keep(id));
    }

    /// Entfernt einen Host aus `expanded`, `connected`, `tiles` und `dirs`
    /// (Spec §7.1: `remove_host_impl`).
    pub fn forget_host(&mut self, id: &str) {
        self.retain_hosts(|other| other != id);
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    pub version: u32,
    #[serde(default)]
    pub hosts: Vec<HostEntry>,
    #[serde(default)]
    pub ui: UiSettings,
    #[serde(default)]
    pub workspace: Workspace,
}

impl Default for Settings {
    /// Das Bild einer frischen Installation: aktuelle Version, keine Hosts.
    /// Kein `#[derive(Default)]` -- `version: 0` waere ein KLEINERER Wert
    /// als `CURRENT_VERSION` und damit unbemerkt eine falsche Behauptung
    /// ueber das Dateiformat (siehe `missing_version_key_is_an_error...`-
    /// Test unten: eine ECHTE Datei ohne `version`-Schluessel ist ein
    /// Parsefehler, kein stillschweigendes `0`).
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            hosts: Vec::new(),
            ui: UiSettings::default(),
            workspace: Workspace::default(),
        }
    }
}

impl Settings {
    /// Klemmt alle Werte (Laden UND Speichern, Spec §9.2).
    pub fn clamp(&mut self) {
        self.ui.clamp();
        self.workspace.clamp();
    }

    /// Verwirft Arbeitsplatz-Eintraege zu Hosts, die es nicht gibt (nur beim
    /// Speichern, Spec §9.2: Lesen veraendert nichts).
    pub fn prune_unknown_hosts(&mut self) {
        let known: HashSet<&str> = self.hosts.iter().map(|host| host.id.as_str()).collect();
        self.workspace.retain_hosts(|id| known.contains(id));
    }

    /// Der Stand, der in die Datei gehoert: geklemmt, ohne Eintraege
    /// unbekannter Hosts. Idempotent.
    pub fn normalize_for_save(&mut self) {
        self.clamp();
        self.prune_unknown_hosts();
    }
}

/// Anmeldeart eines Hosts (Spec §4.8): welches Feld die Hinweisleiste bei
/// einem fehlgeschlagenen Verbindungsversuch zeigt (Passphrase fuer `Key`,
/// Passwort fuer `Password`, gar keins fuer `Agent`). `"lowercase"` --
/// `key`/`agent`/`password` -- ist der Wortlaut, den `types.ts`s
/// `HostEntry.auth_kind` und `host-form.ts`s `AuthChoice.kind` bereits
/// verwenden; eine zweite Schreibweise nur auf der Rust-Seite waere eine
/// stille Uebersetzungsstelle, die niemand pflegt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Key,
    Agent,
    Password,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HostEntry {
    pub id: String,
    pub label: String,
    pub hostname: String,
    pub user: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_socket")]
    pub tmux_socket: String,
    #[serde(default = "default_history")]
    pub history_limit: u32,
    // M-D (Abschlussreview): Spec §12.1 sieht `key_path` in `settings.toml`
    // bereits vor (siehe Beispiel dort) -- bislang gab es dafuer schlicht
    // kein Feld. `#[serde(default)]` (-> `None`), NICHT ein Pflichtfeld: eine
    // ECHTE, bereits existierende `settings.toml` eines Nutzers hat diesen
    // Schluessel noch nie geschrieben. Ohne den Default waere jede
    // bestehende Installation ab diesem Update ein Parsefehler
    // (`list_hosts` schlaegt fehl, der Nutzer sieht die Fehler-Banner-Ansicht
    // statt seiner gespeicherten Hosts) -- dasselbe Muster wie `port`/
    // `tmux_socket`/`history_limit` oben. NUR ein Schluesselpfad wird
    // gespeichert (kein Passwort, keine Passphrase -- Randbedingung des
    // Befunds: Geheimnisse gehoeren laut Spec §8.5 in `Secrets`/DPAPI, nicht
    // in diese Klartextdatei, und v1 hat noch keinen `Secrets`-Speicher).
    #[serde(default)]
    pub key_path: Option<String>,
    // Task 8 (Spec §4.8): welche Anmeldeart der Nutzer fuer diesen Host
    // GEWAEHLT hat -- `key_path` allein sagt das nicht mehr eindeutig, seit
    // ein Host auch per Passwort gespeichert werden kann (weder Schluessel
    // noch Passphrase/Passwort selbst landen hier, siehe `key_path`s
    // Kommentar oben: Geheimnisse gehoeren in `Secrets`/DPAPI, nicht in diese
    // Klartextdatei). `#[serde(default)]` aus demselben Grund wie bei
    // `key_path`: eine ECHTE, bereits existierende `settings.toml` hat dieses
    // Feld noch nie geschrieben, ohne den Default waere das ab diesem Update
    // ein Parsefehler. Ein serde-Default kann nicht vom Nachbarfeld
    // `key_path` abhaengen (kein Zugriff auf Geschwisterfelder waehrend der
    // Feld-Deserialisierung) -- deshalb bleibt dieses Feld bei einer alten
    // Datei `None`, und `effective_auth_kind()` unten leitet die Anmeldeart
    // in diesem Fall aus `key_path` ab, statt sie hier zu erraten.
    #[serde(default)]
    pub auth_kind: Option<AuthKind>,
    /// Schalter "Show tmux sessions" (Spec 2026-10-25 §10.1): Ist er aus,
    /// liest die App den Standard-Socket dieses Hosts gar nicht. Fehlt das
    /// Feld, wie in jeder Datei von 0.2.x, gilt an.
    #[serde(default = "default_show_default_socket")]
    pub show_default_socket: bool,
}

fn default_show_default_socket() -> bool {
    true
}

impl HostEntry {
    /// Liefert die Anmeldeart, die dieser Host TATSAECHLICH verwendet --
    /// `auth_kind`, wenn gesetzt (jeder Schreibweg seit Task 8 setzt es),
    /// sonst aus `key_path` abgeleitet (jede Datei aus der Zeit davor):
    /// gesetzt heisst `Key`, sonst `Agent` (der bisherige stille Rueckfall,
    /// siehe `resolve_auth_method` in `commands.rs`). Ein per Passwort
    /// gespeicherter Host aus dieser Vorzeit ist darueber nicht von einem
    /// Agent-Host zu unterscheiden -- den gab es vor diesem Task ohnehin nie
    /// (`password: null` war in `main.ts` bislang fest verdrahtet), das ist
    /// also keine neue Grenze, nur eine, die fuer neue Schreibvorgaenge ab
    /// jetzt geschlossen ist.
    pub fn effective_auth_kind(&self) -> AuthKind {
        self.auth_kind.unwrap_or(if self.key_path.is_some() {
            AuthKind::Key
        } else {
            AuthKind::Agent
        })
    }
}

fn default_port() -> u16 {
    22
}

/// Vorgabe-Socket der App (Spec §6.0). `pub`, weil dies die EINZIGE
/// Definition dieses Wertes im Projekt ist -- `commands.rs` hatte bis zum
/// Haertungspaket ein zweites, unabhaengiges `"agentbridge"`-Literal
/// (`TMUX_SOCKET`). Zwei Quellen fuer denselben Vorgabewert koennen
/// auseinanderlaufen, ohne dass etwas es anzeigt.
///
/// Der Wert ist NICHT der Default-Socket von tmux -- dieser Socket ist auf
/// der Referenz-VM rund 130 fremden Sockets aus anderen Projekten gehorig.
/// Der App-eigene Socket ist zwingend noetig, um nicht in unverwandte
/// Sessions anderer Projekte zu gelangen.
///
/// Der Name bleibt `agentbridge`, auch seit die App aidevbridge heisst:
/// unter einem anderen Socket saehe die App die laufenden Sessions auf den
/// Hosts nicht mehr.
pub fn default_socket() -> String {
    "agentbridge".into()
}

/// Vorgabe-`history-limit` (Spec §6.5 Schritt 1: deutlich ueber dem
/// Capture-Fenster von 5000 Zeilen). `pub` aus demselben Grund wie
/// `default_socket` -- `commands.rs` trug ein zweites `10_000`-Literal
/// (`DEFAULT_HISTORY_LIMIT`).
///
/// Der Verlauf beim Anhaengen (`tmux/history.rs`, UX-Spec §5.6) liest davon
/// hoechstens die letzten 5000 Zeilen.
pub fn default_history() -> u32 {
    10_000
}

/// Eine neuere Version wird NICHT ueberschrieben -- die App startet dann
/// schreibgeschuetzt (Spec §12.1). `version` traegt bewusst KEIN
/// `#[serde(default)]`: eine Datei ganz ohne `version`-Schluessel ist ein
/// Parsefehler (fehlendes Pflichtfeld), nicht stillschweigend Version 0 --
/// eine echte `settings.toml` ohne dieses Feld ist kein gueltiges Dokument
/// dieses Formats, kein frischer Zustand.
pub fn parse_settings(text: &str) -> anyhow::Result<Settings> {
    let mut s: Settings = toml::from_str(text).context("could not parse settings.toml")?;
    if s.version > CURRENT_VERSION {
        // Der Text ist der, den der Nutzer liest (Spec §10): was los ist, was
        // zu tun ist, und dass die Datei unberuehrt bleibt. Die Dateiversion
        // nennt er nicht -- damit kann der Nutzer nichts anfangen.
        anyhow::bail!(
            "Your settings were saved by a newer aidevbridge. \
             Update aidevbridge to use them — the file was not changed."
        );
    }
    // Ungueltige Werte klemmen schon beim Laden (Spec §9.2), damit der Rest
    // der App nie einen Wert ausserhalb des Bereichs sieht. Unbekannte Hosts
    // bleiben stehen: sie fallen erst beim Speichern weg.
    s.clamp();
    Ok(s)
}

// --- Testisolation fuer die Fensterabnahme (UX-Ueberarbeitung, Spec §9.3) ---
//
// Nur der Debug-Bau beachtet die drei Variablen, der Release-Bau
// ueberliest sie. Die Pruefungen bleiben in beiden Bauarten uebersetzt;
// `cfg!(debug_assertions)` schaltet nur ihre Wirkung, sodass im Release-Bau
// kein toter Code entsteht.

/// Ersetzt im Debug-Bau den Socket `agentbridge`.
pub const TMUX_SOCKET_ENV: &str = "AIDEVBRIDGE_TMUX_SOCKET";
/// Ersetzt im Debug-Bau den Namen von tmux' Standard-Socket (Spec 2026-10-25
/// §6.1): So prueft eine Testinstanz die Sessions des Standard-Sockets an
/// einem Testsocket, ohne den echten zu beruehren. Die Regeln haengen an der
/// Art, nicht am Namen.
pub const TMUX_DEFAULT_SOCKET_ENV: &str = "AIDEVBRIDGE_TMUX_DEFAULT_SOCKET";
/// Ersetzt im Debug-Bau den Ordner von `settings.toml`.
pub const SETTINGS_DIR_ENV: &str = "AIDEVBRIDGE_SETTINGS_DIR";
/// Nennt im Debug-Bau, zusammen mit `AIDEVBRIDGE_SETTINGS_DIR`, den alten
/// Ordner, aus dem der Umzug beim Start kopiert (fuer die Fensterabnahme des
/// Umzugs). Ohne ihn zieht eine Testinstanz nichts um.
pub const LEGACY_SETTINGS_DIR_ENV: &str = "AIDEVBRIDGE_LEGACY_SETTINGS_DIR";

/// Rohwert einer der drei Variablen. Ein Wert, der kein gueltiges Unicode
/// ist, zaehlt als gesetzt, aber ungueltig -- nicht als fehlend.
fn test_env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|value| value.into_string().unwrap_or_default())
}

/// Ein Testsocket nach den Regeln aus `tests/common/mod.rs`: 1-48 Zeichen
/// `[A-Za-z0-9_-]`, weder `default` noch der Produktionssocket. Im
/// Release-Bau immer `None`.
pub fn socket_override(raw: Option<&str>) -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let raw = raw?;
    let valid = (1..=48).contains(&raw.len())
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !raw.eq_ignore_ascii_case("default")
        && !raw.eq_ignore_ascii_case(&default_socket());
    valid.then(|| raw.to_string())
}

/// Ein absoluter Ordner fuer `settings.toml`. Ein relativer Pfad hinge vom
/// Arbeitsverzeichnis des Prozesses ab und gilt deshalb nicht. Im
/// Release-Bau immer `None`.
pub fn settings_dir_override(raw: Option<&str>) -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let dir = Path::new(raw?);
    dir.is_absolute().then(|| dir.to_path_buf())
}

/// Socket der laufenden App: `default_socket()`, im Debug-Bau ggf.
/// `AIDEVBRIDGE_TMUX_SOCKET`. Gesetzt, aber ungueltig, ist ein Fehler.
pub fn app_socket() -> Result<String, String> {
    app_socket_from(test_env(TMUX_SOCKET_ENV).as_deref())
}

/// Der Name des Standard-Sockets: `default`, im Debug-Bau ggf. aus
/// `AIDEVBRIDGE_TMUX_DEFAULT_SOCKET`. Gesetzt, aber ungueltig, ist ein Fehler.
pub fn default_socket_name() -> Result<String, String> {
    default_socket_name_from(test_env(TMUX_DEFAULT_SOCKET_ENV).as_deref())
}

/// Testbarer Kern von `default_socket_name()`, mit denselben Regeln wie fuer
/// den eigenen Socket: ein gesetzter, aber ungueltiger Wert faellt nicht still
/// auf den echten Standard-Socket zurueck.
fn default_socket_name_from(raw: Option<&str>) -> Result<String, String> {
    match (raw, socket_override(raw)) {
        (_, Some(socket)) => Ok(socket),
        (Some(raw), None) if cfg!(debug_assertions) => Err(format!(
            "{TMUX_DEFAULT_SOCKET_ENV} must have 1-48 characters from A-Z, a-z, 0-9, _ and - \
             and must not be 'default' or '{}': {raw:?}",
            default_socket()
        )),
        _ => Ok(crate::tmux::DEFAULT_SOCKET_NAME.into()),
    }
}

/// Testbarer Kern von `app_socket()`. Ein gesetzter, aber ungueltiger Wert
/// faellt im Debug-Bau nicht still auf den Produktionssocket zurueck -- dort
/// liegen die echten Sessions des Nutzers.
fn app_socket_from(raw: Option<&str>) -> Result<String, String> {
    match (raw, socket_override(raw)) {
        (_, Some(socket)) => Ok(socket),
        (Some(raw), None) if cfg!(debug_assertions) => Err(format!(
            "{TMUX_SOCKET_ENV} must have 1-48 characters from A-Z, a-z, 0-9, _ and - \
             and must not be 'default' or '{}': {raw:?}",
            default_socket()
        )),
        _ => Ok(default_socket()),
    }
}

/// Ordner von `settings.toml` im Konfigurationsverzeichnis: die Kennung aus
/// `tauri.conf.json`, derselbe Ordner wie `.window-state.json` (lib.rs), den
/// auch der Deinstaller kennt (Roadmap 2026-09-05 §2). Der Test
/// `settings_folder_is_the_tauri_identifier` haelt beide Werte gleich.
pub const SETTINGS_DIR_NAME: &str = "io.github.itbrain258.aidevbridge";
/// Ordner von `settings.toml` bis 0.1.2, Quelle des Umzugs beim Start.
pub const LEGACY_SETTINGS_DIR_NAME: &str = "agentbridge";
/// Die einzige Datei, die die App in diese Ordner schreibt.
const SETTINGS_FILE_NAME: &str = "settings.toml";

/// Pfad zu `settings.toml` im Ordner [`SETTINGS_DIR_NAME`] des
/// Konfigurationsverzeichnisses (unter Windows
/// `%APPDATA%\io.github.itbrain258.aidevbridge\settings.toml`), im Debug-Bau
/// ggf. `<AIDEVBRIDGE_SETTINGS_DIR>/settings.toml`.
pub fn settings_path() -> anyhow::Result<PathBuf> {
    settings_path_from(test_env(SETTINGS_DIR_ENV).as_deref())
}

/// Testbarer Kern von `settings_path()`. Ein gesetzter, aber ungueltiger
/// Ordner ist im Debug-Bau ein Fehler: still auf die echte Datei
/// auszuweichen, hiesse, dass eine Testinstanz sie beschreibt.
fn settings_path_from(raw_dir: Option<&str>) -> anyhow::Result<PathBuf> {
    let dir = match (raw_dir, settings_dir_override(raw_dir)) {
        (_, Some(dir)) => dir,
        (Some(raw), None) if cfg!(debug_assertions) => {
            anyhow::bail!("{SETTINGS_DIR_ENV} must be an absolute directory: {raw:?}")
        }
        _ => dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("could not determine the configuration directory"))?
            .join(SETTINGS_DIR_NAME),
    };
    Ok(dir.join(SETTINGS_FILE_NAME))
}

/// Ergebnis von [`copy_legacy_settings`].
#[derive(Debug, PartialEq, Eq)]
pub enum Migration {
    /// Im neuen Ordner liegt schon eine `settings.toml`; nichts wird kopiert.
    NotNeeded,
    /// Der alte Ordner traegt keine `settings.toml`.
    NoLegacy,
    /// `settings.toml` liegt jetzt auch im neuen Ordner.
    Copied,
}

/// Umzug beim Start (seit 0.2.0), aufgerufen aus `lib.rs::run()` vor dem
/// ersten Laden. Scheitert er, startet die App wie ohne Datei (Erststart);
/// der alte Ordner bleibt, und der naechste Start versucht es erneut. Die
/// App hat kein Protokoll: Die eine Zeile auf stderr steht im Debug-Bau in
/// der Konsole, der Release-Bau hat keine.
pub fn migrate_legacy_settings() {
    let Some((legacy_dir, new_dir)) = migration_dirs_from(
        cfg!(debug_assertions),
        test_env(SETTINGS_DIR_ENV).as_deref(),
        test_env(LEGACY_SETTINGS_DIR_ENV).as_deref(),
        dirs::config_dir(),
    ) else {
        return;
    };
    match copy_legacy_settings(&legacy_dir, &new_dir) {
        Ok(Migration::Copied) => eprintln!(
            "[settings] copied settings.toml from {} to {}; the old folder stays as it is",
            legacy_dir.display(),
            new_dir.display()
        ),
        Ok(Migration::NotNeeded | Migration::NoLegacy) => {}
        Err(error) => eprintln!(
            "[settings] could not copy settings.toml from {} to {}, starting without it: {error:#}",
            legacy_dir.display(),
            new_dir.display()
        ),
    }
}

/// Testbarer Kern der Ordnerwahl: (alt, neu) oder `None` fuer keinen Umzug.
/// Ohne `AIDEVBRIDGE_SETTINGS_DIR` (und immer im Release-Bau) die echten
/// Ordner im Konfigurationsverzeichnis. Eine Testinstanz mit
/// `AIDEVBRIDGE_SETTINGS_DIR` liest nie den echten alten Ordner des Nutzers:
/// Sie zieht nur aus `AIDEVBRIDGE_LEGACY_SETTINGS_DIR` um, beide absolut.
/// `debug` ist `cfg!(debug_assertions)` des Aufrufers; als Parameter, damit
/// die Tests auch den Zweig des Release-Baus in jedem Bau pruefen.
fn migration_dirs_from(
    debug: bool,
    raw_settings_dir: Option<&str>,
    raw_legacy_dir: Option<&str>,
    config_dir: Option<PathBuf>,
) -> Option<(PathBuf, PathBuf)> {
    if debug && raw_settings_dir.is_some() {
        let new_dir = settings_dir_override(raw_settings_dir)?;
        let legacy_dir = settings_dir_override(raw_legacy_dir)?;
        return Some((legacy_dir, new_dir));
    }
    let config_dir = config_dir?;
    Some((
        config_dir.join(LEGACY_SETTINGS_DIR_NAME),
        config_dir.join(SETTINGS_DIR_NAME),
    ))
}

/// Kopiert `<alt>/settings.toml` nach `<neu>/settings.toml`, wenn es dort
/// noch keine gibt. Ausloeser ist die fehlende Datei, nicht der fehlende
/// Ordner: Den neuen Ordner legt `.window-state.json` schon beim ersten
/// Beenden an, auch nach einem gescheiterten Umzug oder in einer Testinstanz.
///
/// Nur `settings.toml` geht mit. Sonst legt die App im alten Ordner nichts
/// an (known_hosts ist `~/.ssh/known_hosts`, die Fensterlage lag unter der
/// alten Kennung); Reste wie `settings.toml.tmp` bleiben dort. Der alte
/// Ordner wird nur gelesen. Die Kopie entsteht wie in [`save_to`] ueber eine
/// temporaere Datei und `rename`, eine halbe `settings.toml` gibt es also
/// nie.
pub fn copy_legacy_settings(legacy_dir: &Path, new_dir: &Path) -> anyhow::Result<Migration> {
    let target = new_dir.join(SETTINGS_FILE_NAME);
    match std::fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        // Vorhanden oder nicht pruefbar: nichts anfassen.
        _ => return Ok(Migration::NotNeeded),
    }
    let source = legacy_dir.join(SETTINGS_FILE_NAME);
    match std::fs::metadata(&source) {
        Ok(metadata) if metadata.is_file() => {}
        // Keine Datei dort (sie fehlt, oder ein Ordner liegt dort): nichts
        // umzuziehen.
        Ok(_) => return Ok(Migration::NoLegacy),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Migration::NoLegacy);
        }
        // Nicht pruefbar heisst nicht fehlend: Der Fehler bringt seine Zeile
        // auf stderr, kopiert wird nichts, der naechste Start versucht es
        // erneut.
        Err(error) => {
            return Err(error).with_context(|| format!("could not read {}", source.display()));
        }
    }
    std::fs::create_dir_all(new_dir)
        .with_context(|| format!("could not create {}", new_dir.display()))?;
    let tmp_path = target.with_extension("toml.tmp");
    let copied = std::fs::copy(&source, &tmp_path)
        .with_context(|| {
            format!(
                "could not copy {} to {}",
                source.display(),
                tmp_path.display()
            )
        })
        .and_then(|_| {
            std::fs::rename(&tmp_path, &target)
                .with_context(|| format!("could not replace {}", target.display()))
        });
    if copied.is_err() {
        // Nur die eigene temporaere Datei geht weg; ist sie ein Ordner, bleibt er.
        let _ = std::fs::remove_file(&tmp_path);
    }
    copied.map(|()| Migration::Copied)
}

/// Laedt `settings.toml` vom Standardpfad (siehe `settings_path`).
pub fn load() -> anyhow::Result<Settings> {
    load_from(&settings_path()?)
}

/// Testbarer Kern von `load()`: nimmt den Pfad explizit entgegen.
///
/// Fehlt die Datei (frische Installation), ist das KEIN Fehler --
/// `Settings::default()` (aktuelle Version, keine Hosts) kommt zurueck,
/// genau das Bild eines Erststarts. JEDER andere Lese- oder Parsefehler
/// (auch "Version ist neuer", siehe `parse_settings`) wird weitergereicht,
/// NIEMALS mit `unwrap_or_default()` verschluckt -- ein Aufrufer, der einen
/// Fehler hier stillschweigend durch einen frischen Default ersetzen und
/// dann speichern wuerde, wuerde genau die Datei ueberschreiben, deren
/// Nicht-Ueberschreiben `parse_settings`s ganzer Zweck ist (siehe
/// `commands::add_host_impl`/`remove_host_impl`, die diesen Fehler an den
/// Aufrufer durchreichen statt ihn zu behandeln).
///
/// Jeder Fehler nennt den Pfad der Datei: `parse_settings` kennt ihn nicht,
/// darum haengt der Kontext hier. Mit `{error:#}` gedruckt (wie die
/// Settings-Commands es tun, Spec §9.2) steht dann Datei, Ursache sowie Zeile
/// und Spalte aus `toml` in der Meldung; `error.to_string()` zeigt nur den
/// aeussersten Kontext.
pub fn load_from(path: &Path) -> anyhow::Result<Settings> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            parse_settings(&text).with_context(|| format!("could not load {}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e).with_context(|| format!("could not read {}", path.display())),
    }
}

/// Schreibt `settings.toml` zum Standardpfad (siehe `settings_path`).
pub fn save(s: &Settings) -> anyhow::Result<()> {
    save_to(&settings_path()?, s)
}

/// Testbarer Kern von `save()`: nimmt den Pfad explizit entgegen.
///
/// Schreibt nicht `s` selbst, sondern dessen geklemmten Stand
/// (`Settings::normalize_for_save`): ungueltige Werte werden zum Standard, und
/// Arbeitsplatz-Eintraege zu Hosts, die `s.hosts` nicht kennt, fallen weg.
/// `load_from` liefert danach also nicht unbedingt `s` zurueck, und ein
/// Aufrufer, der nach dem Speichern weiter mit `s` arbeitet, hat mehr als die
/// Datei.
///
/// Schreibt atomar: erst in eine temporaere Datei im selben Verzeichnis,
/// dann `rename` -- ein Absturz mitten im Schreiben darf niemals eine halb
/// geschriebene `settings.toml` hinterlassen (dieselbe Datei, die Hosts UND
/// Voreinstellungen traegt). `rename` innerhalb desselben Dateisystems ist
/// unter Windows (`MoveFileExW` via `std::fs::rename`, ersetzt ein
/// bestehendes Ziel) wie unter POSIX atomar bezueglich Lesern.
pub fn save_to(path: &Path, s: &Settings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
    }
    // Jede Datei auf der Platte ist geklemmt und ohne Eintraege unbekannter
    // Hosts, egal welcher Schreibweg sie erzeugt (Spec §9.2).
    let mut s = s.clone();
    s.normalize_for_save();
    let text = toml::to_string_pretty(&s)
        .with_context(|| format!("could not serialize settings for {}", path.display()))?;

    // Temporaerer Name im selben Verzeichnis (nicht im System-Temp-Verzeichnis):
    // `rename` ueber Dateisystemgrenzen hinweg ist NICHT atomar (unter
    // Windows sogar ein harter Fehler, siehe `MoveFileExW`-Dokumentation --
    // ein Laufwerkwechsel scheitert ohne `MOVEFILE_COPY_ALLOWED`).
    let tmp_path = path.with_extension("toml.tmp");
    std::fs::write(&tmp_path, text)
        .with_context(|| format!("could not write {}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, path)
        .with_context(|| format!("could not replace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Versionspruefung ---

    /// Der Text, den der Nutzer liest (UX-Ueberarbeitung, Spec §10). Die
    /// Dateiversion steht nicht darin: der Nutzer kann mit ihr nichts tun.
    const NEWER_FILE_TEXT: &str = "Your settings were saved by a newer aidevbridge. \
         Update aidevbridge to use them — the file was not changed.";

    #[test]
    fn unknown_future_version_is_refused_not_overwritten() {
        let toml = "version = 99\n";
        let err = parse_settings(toml).unwrap_err();
        assert_eq!(err.to_string(), NEWER_FILE_TEXT);
    }

    #[test]
    fn current_version_parses() {
        let toml = "version = 1\n";
        assert_eq!(parse_settings(toml).unwrap().version, 1);
    }

    // --- Review-Ergaenzung: ein fehlendes `version`-Feld ist
    // ein Parsefehler, keine stillschweigende Annahme von Version 0. Ohne
    // diesen Test wuerde ein `#[serde(default)]` auf `version` (das eine
    // spaetere Bearbeitung versehentlich ergaenzen koennte, z. B. um
    // `toml::from_str` bei EINEM fehlenden Feld "grosszuegiger" zu machen)
    // grün bleiben, obwohl es genau die falsche Richtung waere: eine Datei
    // ohne Versionsangabe wuerde dann als Version 0 (aeltestes Format)
    // geparst, nicht als Fehler erkannt.
    #[test]
    fn missing_version_key_is_a_parse_error_not_defaulted_to_zero() {
        let toml = "hosts = []\n";
        let err = parse_settings(toml)
            .expect_err("eine Datei ganz ohne `version`-Schluessel muss ein Parsefehler sein");
        // toml/serde formulieren das als "missing field" -- diese Meldung
        // darf nicht mit der "saved by a newer aidevbridge"-Meldung
        // verwechselt werden. `{err:#}`: die ganze Ursachenkette, denn
        // `to_string()` zeigt nur den aeussersten Kontext.
        let chain = format!("{err:#}");
        assert!(chain.contains("missing field"), "{chain}");
        assert!(
            !chain.contains(NEWER_FILE_TEXT),
            "ein fehlendes Feld ist ein anderer Fehler als 'zu neu': {chain}"
        );
    }

    #[test]
    fn host_entry_defaults_apply_when_the_toml_omits_them() {
        let toml = "\
version = 1
[[hosts]]
id = \"h1\"
label = \"Dev VM\"
hostname = \"192.0.2.10\"
user = \"u\"
";
        let s = parse_settings(toml).unwrap();
        assert_eq!(s.hosts.len(), 1);
        let h = &s.hosts[0];
        assert_eq!(h.port, 22);
        assert_eq!(h.tmux_socket, "agentbridge");
        assert_eq!(h.history_limit, 10_000);
        // M-D: eine ECHTE, bereits existierende settings.toml eines Nutzers
        // hat `key_path` nie geschrieben -- ohne `#[serde(default)]` waere
        // das oben bereits ein Parsefehler, nicht erst diese Assertion.
        assert_eq!(h.key_path, None);
    }

    // --- load_from/save_to (Datei-I/O, ohne echte Anwendung) ---

    fn unique_temp_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("aidevbridge_test_settings_{tag}_{nanos}.toml"))
    }

    #[test]
    fn load_from_missing_file_is_a_fresh_default_not_an_error() {
        let path = unique_temp_path("missing");
        assert!(!path.exists());
        let s =
            load_from(&path).expect("eine fehlende settings.toml ist ein Erststart, kein Fehler");
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn save_then_load_round_trips_hosts() {
        let path = unique_temp_path("roundtrip");
        let s = Settings {
            version: CURRENT_VERSION,
            hosts: vec![
                // M-D-Sonde: frueheren toml-Versionen wurde
                // nachgesagt, `Option::None`-Feldwerte beim Serialisieren mit
                // "unsupported None value" abzulehnen. Empirisch gegen die
                // hier gepinnte toml 0.8.2 (Cargo.lock) WIDERLEGT: `save_to`
                // laesst ein `None`-Feld schlicht aus der TOML-Ausgabe weg,
                // kein `skip_serializing_if` noetig (per temporaerem
                // Debug-Log gegen die tatsaechlich geschriebene Datei
                // geprueft). `key_path: None` ist trotzdem der
                // HAEUFIGERE Fall (ssh-agent/Passwort-Hosts) und bleibt
                // deshalb im Test -- ein Test nur mit `Some(..)` haette diese
                // Annahme nie geprueft, in welche Richtung auch immer sie
                // ausgegangen waere.
                HostEntry {
                    id: "h1".into(),
                    label: "Dev VM".into(),
                    hostname: "192.0.2.10".into(),
                    user: "u".into(),
                    port: 22,
                    tmux_socket: "agentbridge".into(),
                    history_limit: 10_000,
                    key_path: None,
                    auth_kind: Some(AuthKind::Agent),
                    show_default_socket: true,
                },
                HostEntry {
                    id: "h2".into(),
                    label: "Staging".into(),
                    hostname: "192.0.2.20".into(),
                    user: "ops".into(),
                    port: 2222,
                    tmux_socket: "agentbridge".into(),
                    history_limit: 10_000,
                    key_path: Some("~/.ssh/id_ed25519".into()),
                    auth_kind: Some(AuthKind::Key),
                    show_default_socket: true,
                },
            ],
            ui: UiSettings::default(),
            workspace: Workspace::default(),
        };
        save_to(&path, &s).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded, s);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    #[test]
    fn save_to_creates_missing_parent_directories() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aidevbridge_test_settings_dir_{nanos}"));
        let path = dir.join("settings.toml");
        assert!(!dir.exists());
        save_to(&path, &Settings::default()).unwrap();
        assert!(path.exists());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// Gegenprobe zum "Version neuer -> nicht ueberschreiben"-Vertrag: ein
    /// `load_from`, das (fehlerhaft) `unwrap_or_default()` verwenden wuerde,
    /// wuerde diesen Fehler verschlucken -- dieser Test belegt, dass der
    /// Fehler tatsaechlich bis zum Aufrufer durchkommt, statt irgendwo
    /// stillschweigend in einen leeren `Settings::default()` verwandelt zu
    /// werden.
    #[test]
    fn load_from_a_newer_version_file_propagates_the_error_instead_of_defaulting() {
        let path = unique_temp_path("newer_version");
        std::fs::write(&path, "version = 99\n").unwrap();
        let err =
            load_from(&path).expect_err("eine neuere Version darf NIE als Default durchgehen");
        // `{err:#}`: die Ursachenkette, nicht nur der aeusserste Kontext (der
        // nennt seit der UX-Ueberarbeitung den Pfad der Datei).
        let chain = format!("{err:#}");
        assert!(chain.contains(&path.display().to_string()), "{chain}");
        assert!(chain.ends_with(NEWER_FILE_TEXT), "{chain}");
        let _ = std::fs::remove_file(&path);
    }

    // --- Task 8 (Spec §4.8): Anmeldeart speichern ---

    /// Die Datei beginnt mit `version = 1`, nicht direkt mit `[[hosts]]`:
    /// ohne `version`-Schluessel waere sie bereits VOR dieser Aenderung ein
    /// Parsefehler ("missing field version", siehe
    /// `missing_version_key_is_a_parse_error_not_defaulted_to_zero` oben),
    /// nicht spezifisch fuer das fehlende `auth_kind`. Mit `version = 1`
    /// prueft der Test tatsaechlich das, was Spec §4.8 verlangt:
    /// eine ECHTE, bereits existierende `settings.toml` (die `version` immer
    /// geschrieben hat, aber `auth_kind` noch nie kannte) bleibt lesbar, und
    /// `effective_auth_kind()` leitet die Anmeldeart aus `key_path` ab.
    #[test]
    fn old_settings_without_auth_kind_still_load_and_derive_the_kind() {
        let toml = r#"
version = 1

[[hosts]]
id = "h1"
label = "vm"
hostname = "192.0.2.20"
user = "u"
key_path = "C:/Users/x/.ssh/id_ed25519"

[[hosts]]
id = "h2"
label = "pw"
hostname = "192.0.2.21"
user = "u"
"#;
        let s = parse_settings(toml).unwrap();
        assert_eq!(s.hosts[0].effective_auth_kind(), AuthKind::Key);
        assert_eq!(s.hosts[1].effective_auth_kind(), AuthKind::Agent);
    }

    // --- UI v2 (Spec §12.3, §16.3): [ui]-Abschnitt ---

    #[test]
    fn ui_section_is_optional_and_defaults_to_turquoise() {
        let s = parse_settings("version = 1\n").unwrap();
        assert_eq!(s.ui.theme, "turquoise");
        assert_eq!(s.ui, UiSettings::default());
    }

    #[test]
    fn ui_theme_is_read_from_the_file() {
        let s = parse_settings("version = 1\n\n[ui]\ntheme = \"slate\"\n").unwrap();
        assert_eq!(s.ui.theme, "slate");
    }

    #[test]
    fn ui_theme_round_trips_and_unknown_values_survive_as_strings() {
        let path = unique_temp_path("ui-theme");
        let mut s = Settings::default();
        s.ui.theme = "slate".to_string();
        save_to(&path, &s).unwrap();
        assert_eq!(load_from(&path).unwrap().ui.theme, "slate");
        // Rust prueft den Wert NICHT (Spec §12.3): der Rueckfall liegt im
        // Frontend, damit es den unbekannten Namen anzeigen kann.
        s.ui.theme = "sepia".to_string();
        save_to(&path, &s).unwrap();
        assert_eq!(load_from(&path).unwrap().ui.theme, "sepia");
        let _ = std::fs::remove_file(&path);
    }

    // --- UX-Ueberarbeitung (Spec §7.1, §9.2): Terminal-Voreinstellungen und
    // Arbeitsplatz ---

    fn host_entry(id: &str) -> HostEntry {
        HostEntry {
            id: id.into(),
            label: format!("vm {id}"),
            hostname: "192.0.2.20".into(),
            user: "u".into(),
            port: 22,
            tmux_socket: default_socket(),
            history_limit: default_history(),
            key_path: None,
            auth_kind: Some(AuthKind::Agent),
            show_default_socket: true,
        }
    }

    /// Jedes neue Feld weicht vom Standard ab, und der Arbeitsplatz verweist
    /// nur auf Hosts, die es gibt (sonst verwirft `save_to` die Eintraege).
    fn full_settings() -> Settings {
        Settings {
            version: CURRENT_VERSION,
            hosts: vec![host_entry("host_a"), host_entry("host_b")],
            ui: UiSettings {
                theme: "slate".into(),
                terminal_font_size: 16,
                copy_on_select: true,
                ctrl_cv_clipboard: false,
                right_click: "paste".into(),
                restore_workspace: false,
                sidebar_width: 300,
            },
            workspace: Workspace {
                layout: 4,
                tiles_version: TILES_VERSION_LIST,
                sidebar_collapsed: true,
                expanded: vec!["host_b".into(), "host_a".into()],
                connected: vec!["host_a".into()],
                tiles: vec![
                    TileEntry {
                        slot: 0,
                        host_id: "host_a".into(),
                        session: "work".into(),
                        foreign_session: None,
                        socket: None,
                    },
                    TileEntry {
                        slot: 3,
                        host_id: "host_b".into(),
                        session: "build".into(),
                        foreign_session: None,
                        socket: None,
                    },
                ],
                dirs: BTreeMap::from([
                    (
                        "host_a".to_string(),
                        HostDirs {
                            last: Some("/home/u/projekt".into()),
                            recent: vec!["/home/u/projekt".into(), "/srv/app".into()],
                        },
                    ),
                    (
                        "host_b".to_string(),
                        HostDirs {
                            last: None,
                            recent: Vec::new(),
                        },
                    ),
                ]),
            },
        }
    }

    /// Eine `settings.toml`, wie sie ein bestehender Nutzer vor diesem Stand
    /// hat: Hosts und `[ui] theme`, keiner der neuen Schluessel.
    const OLD_FILE: &str = r#"
version = 1

[[hosts]]
id = "host_0123456789abcdef"
label = "dev"
hostname = "192.0.2.20"
user = "u"
port = 22
tmux_socket = "agentbridge"
history_limit = 10000
auth_kind = "agent"

[ui]
theme = "slate"
"#;

    /// Die Dateiform der Vorgaengerversion (ohne die neuen Felder): die
    /// laufende alte App liest eine Datei der neuen Version mit genau diesen
    /// Typen -- ohne `deny_unknown_fields`, wie der echte Vorgaenger.
    mod previous_build {
        #[derive(Debug, serde::Deserialize)]
        pub struct Settings {
            pub version: u32,
            #[serde(default)]
            pub hosts: Vec<super::HostEntry>,
            #[serde(default)]
            pub ui: Ui,
        }

        #[derive(Debug, serde::Deserialize)]
        pub struct Ui {
            #[serde(default = "theme")]
            pub theme: String,
        }

        impl Default for Ui {
            fn default() -> Self {
                Self { theme: theme() }
            }
        }

        fn theme() -> String {
            "turquoise".to_string()
        }
    }

    /// Die Dateiform von 0.1.2, mit `[workspace]` aber ohne `tiles_version`:
    /// so liest die installierte Version eine Datei dieses Stands -- ohne
    /// `deny_unknown_fields`, der Platz als `u8`. Ihre Klemmregel (Platz
    /// hoechstens 3, hoechstens vier Kacheln) steht im Test, sie gehoert zum
    /// Vorgaenger und nicht zum Typ.
    // Die Felder stehen da, damit die ganze Form von 0.1.2 geparst wird; der
    // Test liest nur einige davon (rustc zaehlt `Deserialize` nicht als Lesen).
    #[allow(dead_code)]
    mod previous_release {
        use std::collections::BTreeMap;

        #[derive(Debug, serde::Deserialize)]
        pub struct Settings {
            pub version: u32,
            #[serde(default)]
            pub workspace: Workspace,
        }

        #[derive(Debug, Default, serde::Deserialize)]
        #[serde(default)]
        pub struct Workspace {
            pub layout: u8,
            pub sidebar_collapsed: bool,
            pub expanded: Vec<String>,
            pub connected: Vec<String>,
            pub tiles: Vec<TileEntry>,
            pub dirs: BTreeMap<String, HostDirs>,
        }

        #[derive(Debug, serde::Deserialize)]
        pub struct TileEntry {
            pub slot: u8,
            pub host_id: String,
            pub session: String,
        }

        #[derive(Debug, serde::Deserialize)]
        pub struct HostDirs {
            pub last: Option<String>,
            pub recent: Vec<String>,
        }
    }

    fn parse_ui(body: &str) -> UiSettings {
        parse_settings(&format!("version = 1\n\n[ui]\n{body}\n"))
            .unwrap()
            .ui
    }

    fn parse_workspace(body: &str) -> Workspace {
        parse_settings(&format!("version = 1\n\n[workspace]\n{body}\n"))
            .unwrap()
            .workspace
    }

    /// Review Focus 3, Richtung alt -> neu: die Datei eines bestehenden
    /// Nutzers (Hosts, `[ui] theme`, nichts Neues) laedt mit allen Standards.
    #[test]
    fn old_file_without_the_new_fields_loads_with_every_default() {
        let s = parse_settings(OLD_FILE).unwrap();
        assert_eq!(s.hosts.len(), 1);
        assert_eq!(s.ui.theme, "slate", "der vorhandene Wert bleibt");
        // Die Standards als Literale statt ueber `Default::default()`: so
        // faellt auch ein verrutschter Standard auf.
        assert_eq!(s.ui.terminal_font_size, 13);
        assert!(!s.ui.copy_on_select);
        assert!(s.ui.ctrl_cv_clipboard);
        assert_eq!(s.ui.right_click, "menu");
        assert!(s.ui.restore_workspace);
        assert_eq!(s.ui.sidebar_width, 240);
        assert_eq!(s.workspace.layout, 1);
        assert_eq!(
            s.workspace.tiles_version, 1,
            "fehlt der Schluessel: altes Modell"
        );
        assert!(!s.workspace.sidebar_collapsed);
        assert!(s.workspace.expanded.is_empty());
        assert!(s.workspace.connected.is_empty());
        assert!(s.workspace.tiles.is_empty());
        assert!(s.workspace.dirs.is_empty());
        assert_eq!(s.workspace, Workspace::default());
        assert_eq!(
            s.ui,
            UiSettings {
                theme: "slate".into(),
                ..UiSettings::default()
            }
        );
    }

    /// Review Focus 3, "neue Felder fehlen": ein vorhandener Abschnitt, dem
    /// einzelne neue Felder fehlen, faellt Feld fuer Feld auf den Standard
    /// zurueck -- eine halb handbearbeitete Datei kippt nicht.
    #[test]
    fn new_fields_missing_from_a_present_section_fall_back_one_by_one() {
        let s = parse_settings(
            "version = 1\n\n\
             [ui]\ntheme = \"slate\"\nterminal_font_size = 16\n\n\
             [workspace]\nlayout = 2\n\n\
             [workspace.dirs.h1]\nlast = \"/a\"\n\n\
             [workspace.dirs.h2]\nrecent = [\"/b\"]\n",
        )
        .unwrap();
        assert_eq!(s.ui.terminal_font_size, 16);
        assert_eq!(s.ui.sidebar_width, 240);
        assert!(s.ui.ctrl_cv_clipboard);
        assert!(s.ui.restore_workspace);
        assert_eq!(s.workspace.layout, 2);
        assert!(!s.workspace.sidebar_collapsed);
        assert!(s.workspace.tiles.is_empty());
        assert_eq!(
            s.workspace.dirs["h1"],
            HostDirs {
                last: Some("/a".into()),
                recent: Vec::new(),
            }
        );
        assert_eq!(
            s.workspace.dirs["h2"],
            HostDirs {
                last: None,
                recent: vec!["/b".into()],
            }
        );
        // Leere Abschnitte sind ebenso gueltig.
        let empty = parse_settings("version = 1\n\n[ui]\n\n[workspace]\n").unwrap();
        assert_eq!(empty.ui, UiSettings::default());
        assert_eq!(empty.workspace, Workspace::default());
    }

    #[test]
    fn new_file_with_every_field_round_trips() {
        let path = unique_temp_path("full-roundtrip");
        let s = full_settings();
        save_to(&path, &s).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(load_from(&path).unwrap(), s, "{text}");
        for key in [
            "terminal_font_size = 16",
            "copy_on_select = true",
            "ctrl_cv_clipboard = false",
            "right_click = \"paste\"",
            "restore_workspace = false",
            "sidebar_width = 300",
            "[workspace]",
            "layout = 4",
            "tiles_version = 2",
            "sidebar_collapsed = true",
        ] {
            assert!(text.contains(key), "{key} fehlt in:\n{text}");
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    /// Review Focus 3, Richtung neu -> alt: die laufende alte App muss eine
    /// Datei der neuen Version weiter lesen koennen.
    #[test]
    fn a_file_of_the_new_version_stays_readable_for_the_previous_build() {
        let path = unique_temp_path("previous-reader");
        save_to(&path, &full_settings()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let old: previous_build::Settings = toml::from_str(&text).unwrap_or_else(|error| {
            panic!("die alte App kann die neue Datei nicht lesen: {error}\n{text}")
        });
        assert_eq!(old.version, CURRENT_VERSION);
        assert_eq!(old.hosts.len(), 2);
        assert_eq!(old.ui.theme, "slate");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    /// Spec 2026-10-19 §4.6, Rueckweg: 0.1.2 liest eine Datei mit neun
    /// Kacheln, uebergeht `tiles_version` und behaelt mit seiner Regel die
    /// ersten vier -- in Platzreihenfolge, und das abgeleitete `layout` 4
    /// zeigt sie alle.
    #[test]
    fn the_previous_release_keeps_the_first_four_of_nine_tiles() {
        let path = unique_temp_path("previous-release");
        let mut settings = full_settings();
        settings.workspace.layout = 4;
        settings.workspace.tiles_version = TILES_VERSION_LIST;
        settings.workspace.tiles = (0..9)
            .map(|slot| TileEntry {
                slot,
                host_id: "host_a".into(),
                session: format!("s{slot}"),
                foreign_session: None,
                socket: None,
            })
            .collect();
        save_to(&path, &settings).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("tiles_version = 2"), "{text}");
        let old: previous_release::Settings = toml::from_str(&text).unwrap_or_else(|error| {
            panic!("0.1.2 kann die neue Datei nicht lesen: {error}\n{text}")
        });
        assert_eq!(old.version, CURRENT_VERSION);
        assert_eq!(old.workspace.layout, 4);
        let kept: Vec<&str> = old
            .workspace
            .tiles
            .iter()
            .filter(|tile| tile.slot <= 3)
            .take(4)
            .map(|tile| tile.session.as_str())
            .collect();
        assert_eq!(kept, ["s0", "s1", "s2", "s3"]);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    /// Dieselbe Regel fuer kuenftige Felder: kein Abschnitt lehnt unbekannte
    /// Schluessel ab. Der Test deckt auch die Inline-Form der Kacheln aus der
    /// Spec (§9.2) ab.
    #[test]
    fn unknown_keys_in_every_section_are_ignored() {
        let s = parse_settings(
            "version = 1\nfuture = true\n\n\
             [ui]\ntheme = \"slate\"\nfuture = 1\n\n\
             [workspace]\nfuture = []\n\
             tiles = [{ slot = 0, host_id = \"h\", session = \"s\", future = 1 }]\n\n\
             [workspace.dirs.h]\nfuture = \"x\"\n",
        )
        .unwrap();
        assert_eq!(s.ui.theme, "slate");
        assert_eq!(
            s.workspace.tiles,
            vec![TileEntry {
                slot: 0,
                host_id: "h".into(),
                session: "s".into(),
                foreign_session: None,
                socket: None,
            }]
        );
        assert!(s.workspace.dirs.contains_key("h"));
    }

    // --- Klemmregeln beim Laden (Spec §9.2) ---

    #[test]
    fn terminal_font_size_outside_10_to_20_falls_back_to_13() {
        // 256, 300, -1 und i64::MAX passen nicht in `u8`: sie klemmen wie jeder
        // andere ungueltige Wert, statt die ganze Datei unlesbar zu machen.
        for (raw, want) in [
            (0, 13),
            (9, 13),
            (10, 10),
            (13, 13),
            (20, 20),
            (21, 13),
            (255, 13),
            (256, 13),
            (300, 13),
            (-1, 13),
            (i64::MAX, 13),
        ] {
            let ui = parse_ui(&format!("terminal_font_size = {raw}"));
            assert_eq!(ui.terminal_font_size, want, "{raw}");
        }
    }

    #[test]
    fn sidebar_width_outside_200_to_480_falls_back_to_240() {
        for (raw, want) in [
            (0, 240),
            (199, 240),
            (200, 200),
            (240, 240),
            (480, 480),
            (481, 240),
            (65_535, 240),
            (65_536, 240),
            (70_000, 240),
            (-5, 240),
        ] {
            let ui = parse_ui(&format!("sidebar_width = {raw}"));
            assert_eq!(ui.sidebar_width, want, "{raw}");
        }
    }

    #[test]
    fn right_click_other_than_menu_or_paste_falls_back_to_menu() {
        for (raw, want) in [
            ("menu", "menu"),
            ("paste", "paste"),
            ("Menu", "menu"),
            ("middle", "menu"),
            ("", "menu"),
        ] {
            let ui = parse_ui(&format!("right_click = \"{raw}\""));
            assert_eq!(ui.right_click, want, "{raw:?}");
        }
    }

    #[test]
    fn layout_other_than_1_2_or_4_falls_back_to_1() {
        for (raw, want) in [
            (0, 1),
            (1, 1),
            (2, 2),
            (3, 1),
            (4, 4),
            (5, 1),
            (8, 1),
            (255, 1),
            (256, 1),
            (-1, 1),
        ] {
            let workspace = parse_workspace(&format!("layout = {raw}"));
            assert_eq!(workspace.layout, want, "{raw}");
        }
    }

    /// Spec 2026-10-19 §4.6: fehlt der Schluessel, stammt die Datei aus dem
    /// alten Platzmodell -- auch nachdem 0.1.2 sie geschrieben hat, denn 0.1.2
    /// kennt ihn nicht und laesst ihn weg.
    #[test]
    fn tiles_version_is_1_when_missing_and_unknown_values_fall_back_to_1() {
        assert_eq!(parse_workspace("").tiles_version, TILES_VERSION_SLOTS);
        assert_eq!(
            parse_workspace("tiles_version = 2").tiles_version,
            TILES_VERSION_LIST
        );
        for value in ["0", "3", "-1", "300"] {
            assert_eq!(
                parse_workspace(&format!("tiles_version = {value}")).tiles_version,
                TILES_VERSION_SLOTS,
                "{value}"
            );
        }
    }

    #[test]
    fn tiles_with_a_slot_above_8_are_dropped_and_at_most_nine_remain() {
        let workspace = parse_workspace(
            r#"tiles = [
                { slot = 0, host_id = "h", session = "a" },
                { slot = 9, host_id = "h", session = "too-high" },
                { slot = 1, host_id = "h", session = "b" },
                { slot = 300, host_id = "h", session = "out-of-type" },
                { slot = -1, host_id = "h", session = "negative" },
                { slot = 2, host_id = "h", session = "c" },
                { slot = 3, host_id = "h", session = "d" },
                { slot = 4, host_id = "h", session = "e" },
                { slot = 5, host_id = "h", session = "f" },
                { slot = 6, host_id = "h", session = "g" },
                { slot = 7, host_id = "h", session = "i" },
                { slot = 8, host_id = "h", session = "j" },
                { slot = 8, host_id = "h", session = "tenth" },
            ]"#,
        );
        let sessions: Vec<&str> = workspace.tiles.iter().map(|t| t.session.as_str()).collect();
        assert_eq!(sessions, ["a", "b", "c", "d", "e", "f", "g", "i", "j"]);
    }

    /// Review von Task 6: eine von Hand beschaedigte Kachel macht die Datei
    /// nicht unlesbar. Die Hostliste bleibt, nur die Kachel faellt weg.
    #[test]
    fn a_tile_without_a_session_does_not_make_the_file_unreadable() {
        let s = parse_settings(
            "version = 1\n\n\
             [[hosts]]\nid = \"h1\"\nlabel = \"vm\"\nhostname = \"192.0.2.20\"\nuser = \"u\"\n\n\
             [workspace]\nlayout = 2\n\n\
             [[workspace.tiles]]\nslot = 0\nhost_id = \"h1\"\n\n\
             [[workspace.tiles]]\nslot = 1\nhost_id = \"h1\"\nsession = \"work\"\n",
        )
        .expect("eine Kachel ohne session darf die Datei nicht unlesbar machen");
        assert_eq!(s.hosts.len(), 1, "die Hostliste muss erhalten bleiben");
        assert_eq!(s.hosts[0].id, "h1");
        assert_eq!(s.workspace.layout, 2);
        assert_eq!(
            s.workspace.tiles,
            vec![TileEntry {
                slot: 1,
                host_id: "h1".into(),
                session: "work".into(),
                foreign_session: None,
                socket: None,
            }]
        );
    }

    #[test]
    fn tiles_missing_a_field_or_naming_nothing_are_dropped_and_valid_ones_stay() {
        // Ein fehlender Platz ist so ungueltig wie ein Platz ausserhalb 0..=8
        // und wird nicht zu Platz 0 (derselbe Grund wie bei `Narrow`).
        let workspace = parse_workspace(
            r#"tiles = [
                { slot = 0, host_id = "h", session = "keep-a" },
                { slot = 1, host_id = "h" },
                { slot = 2, session = "no-host" },
                { host_id = "h", session = "no-slot" },
                { slot = 3, host_id = "", session = "empty-host" },
                { slot = 3, host_id = "h", session = "" },
                {},
                { slot = 3, host_id = "h", session = "keep-b" },
            ]"#,
        );
        let sessions: Vec<&str> = workspace.tiles.iter().map(|t| t.session.as_str()).collect();
        assert_eq!(sessions, ["keep-a", "keep-b"]);
    }

    #[test]
    fn damaged_tiles_do_not_take_one_of_the_nine_places() {
        // Erst verwerfen, dann auf neun kuerzen: beschaedigte Kacheln vorn in
        // der Liste verdraengen keine gueltigen dahinter.
        let workspace = parse_workspace(
            r#"tiles = [
                { slot = 0, host_id = "h" },
                { slot = 0, session = "x" },
                { slot = 0, host_id = "h", session = "a" },
                { slot = 1, host_id = "h", session = "b" },
                { slot = 2, host_id = "h", session = "c" },
                { slot = 3, host_id = "h", session = "d" },
                { slot = 4, host_id = "h", session = "e" },
                { slot = 5, host_id = "h", session = "f" },
                { slot = 6, host_id = "h", session = "g" },
                { slot = 7, host_id = "h", session = "i" },
                { slot = 8, host_id = "h", session = "j" },
            ]"#,
        );
        let sessions: Vec<&str> = workspace.tiles.iter().map(|t| t.session.as_str()).collect();
        assert_eq!(sessions, ["a", "b", "c", "d", "e", "f", "g", "i", "j"]);
    }

    /// Spec 2026-10-25 §10.1: Ein Host ohne das Feld, wie in jeder Datei von
    /// 0.2.x, zeigt den Standard-Socket; ein ausgeschalteter bleibt aus.
    #[test]
    fn the_default_socket_switch_is_on_unless_saved_off() {
        assert!(parse_settings(OLD_FILE).unwrap().hosts[0].show_default_socket);
        let path = unique_temp_path("default-socket-switch");
        let mut s = full_settings();
        s.hosts[0].show_default_socket = false;
        save_to(&path, &s).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("show_default_socket = false"), "{text}");
        let reloaded = parse_settings(&text).unwrap();
        assert!(!reloaded.hosts[0].show_default_socket);
        assert!(reloaded.hosts[1..]
            .iter()
            .all(|host| host.show_default_socket));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    /// Spec 2026-10-25 §5: Eine fremde Kachel hat ein leeres `session`, ihren
    /// Namen in `foreign_session` und `socket = "default"`; jede gemischte
    /// Form faellt beim Laden weg. Gespeichert behaelt sie das leere
    /// `session`, an dem 0.2.x sie verwirft, und eigene Kacheln bleiben ohne
    /// die neuen Schluessel.
    #[test]
    fn a_foreign_tile_survives_only_in_its_one_form() {
        let workspace = parse_workspace(
            r#"tiles = [
                { slot = 0, host_id = "h", session = "", foreign_session = "main", socket = "default" },
                { slot = 1, host_id = "h", foreign_session = "no-session-key", socket = "default" },
                { slot = 2, host_id = "h", session = "own", foreign_session = "both", socket = "default" },
                { slot = 3, host_id = "h", session = "", foreign_session = "no-socket" },
                { slot = 4, host_id = "h", session = "", foreign_session = "", socket = "default" },
                { slot = 5, host_id = "h", session = "", foreign_session = "app", socket = "app" },
                { slot = 6, host_id = "h", session = "own-with-socket", socket = "default" },
                { slot = 7, host_id = "h", session = "kept" },
            ]"#,
        );
        let kept: Vec<_> = workspace
            .tiles
            .iter()
            .map(|t| (t.slot, t.session.as_str(), t.foreign_session.as_deref()))
            .collect();
        assert_eq!(
            kept,
            [
                (0, "", Some("main")),
                (1, "", Some("no-session-key")),
                (7, "kept", None)
            ]
        );

        let path = unique_temp_path("foreign-tile");
        let mut s = full_settings();
        s.workspace.tiles = vec![
            TileEntry {
                slot: 0,
                host_id: "host_a".into(),
                session: String::new(),
                foreign_session: Some("main".into()),
                socket: Some("default".into()),
            },
            TileEntry {
                slot: 1,
                host_id: "host_a".into(),
                session: "work".into(),
                foreign_session: None,
                socket: None,
            },
        ];
        save_to(&path, &s).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("foreign_session").count(), 1, "{text}");
        assert_eq!(text.matches("socket = \"default\"").count(), 1, "{text}");
        let old: previous_release::Settings = toml::from_str(&text).unwrap();
        assert_eq!(
            old.workspace.tiles[0].session, "",
            "0.2.x drops an empty session"
        );
        assert_eq!(
            parse_settings(&text).unwrap().workspace.tiles,
            s.workspace.tiles
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    #[test]
    fn saving_drops_a_tile_with_an_empty_session() {
        let path = unique_temp_path("save-drops-damaged-tiles");
        let mut s = full_settings();
        // Ein bekannter Host, damit nicht schon das Verwerfen unbekannter
        // Hosts die Kachel faengt.
        s.workspace.tiles.push(TileEntry {
            slot: 2,
            host_id: "host_a".into(),
            session: String::new(),
            foreign_session: None,
            socket: None,
        });
        save_to(&path, &s).unwrap();
        // Absichtlich ohne `parse_settings`: die Datei selbst haelt nur die
        // gueltigen Kacheln, nicht erst der Leser.
        let raw: Settings = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let sessions: Vec<&str> = raw
            .workspace
            .tiles
            .iter()
            .map(|t| t.session.as_str())
            .collect();
        assert_eq!(sessions, ["work", "build"]);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    #[test]
    fn recent_dirs_keep_the_first_five_absolute_paths() {
        let workspace = parse_workspace(
            r#"
[workspace.dirs.h]
last = "relative/dir"
recent = ["rel", "/a", "~/home", "C:\\win", "", "/b", "/c\u001bd", "/c", "/d", "/e", "/f", "/g"]

[workspace.dirs.h2]
last = "/x"
"#,
        );
        let h = &workspace.dirs["h"];
        // Erst filtern, dann kuerzen: fuenf gueltige Eintraege, nicht fuenf
        // Eintraege, von denen einige ungueltig waren. Remote-Pfade sind
        // POSIX-Pfade -- `Path::is_absolute` waere unter Windows falsch.
        assert_eq!(h.recent, ["/a", "/b", "/c", "/d", "/e"]);
        assert_eq!(
            h.last, None,
            "ein nicht absoluter Pfad gilt auch als last nicht"
        );
        assert_eq!(workspace.dirs["h2"].last.as_deref(), Some("/x"));
    }

    // --- Klemmen und Verwerfen beim Speichern ---

    #[test]
    fn saving_clamps_out_of_range_values_in_the_written_file() {
        let path = unique_temp_path("save-clamps");
        let mut s = full_settings();
        s.ui.terminal_font_size = 99;
        s.ui.sidebar_width = 5;
        s.ui.right_click = "bogus".into();
        s.workspace.layout = 3;
        s.workspace.tiles.push(TileEntry {
            slot: 9,
            host_id: "host_a".into(),
            session: "high".into(),
            foreign_session: None,
            socket: None,
        });
        s.workspace.dirs.get_mut("host_a").unwrap().recent =
            (0..8).map(|i| format!("/d{i}")).collect();
        save_to(&path, &s).unwrap();
        // Absichtlich ohne `parse_settings`: die Datei selbst haelt die
        // geklemmten Werte, nicht erst der Leser.
        let raw: Settings = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw.ui.terminal_font_size, 13);
        assert_eq!(raw.ui.sidebar_width, 240);
        assert_eq!(raw.ui.right_click, "menu");
        assert_eq!(raw.workspace.layout, 1);
        assert_eq!(raw.workspace.tiles.len(), 2);
        assert_eq!(raw.workspace.dirs["host_a"].recent.len(), 5);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    #[test]
    fn saving_drops_workspace_entries_of_unknown_hosts_but_loading_keeps_them() {
        let text = "version = 1\n\n\
             [[hosts]]\nid = \"h1\"\nlabel = \"vm\"\nhostname = \"192.0.2.20\"\nuser = \"u\"\n\n\
             [workspace]\n\
             expanded = [\"h1\", \"ghost\"]\n\
             connected = [\"ghost\", \"h1\"]\n\
             tiles = [{ slot = 0, host_id = \"ghost\", session = \"a\" }, { slot = 1, host_id = \"h1\", session = \"b\" }]\n\n\
             [workspace.dirs.ghost]\nlast = \"/g\"\n\n\
             [workspace.dirs.h1]\nlast = \"/h\"\n";
        let loaded = parse_settings(text).unwrap();
        // Lesen verwirft nichts (Spec §9.2: "beim Speichern").
        assert_eq!(loaded.workspace.expanded, ["h1", "ghost"]);
        assert_eq!(loaded.workspace.connected, ["ghost", "h1"]);
        assert_eq!(loaded.workspace.tiles.len(), 2);
        assert_eq!(loaded.workspace.dirs.len(), 2);

        let path = unique_temp_path("save-prunes");
        save_to(&path, &loaded).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(!written.contains("ghost"), "{written}");
        let saved = load_from(&path).unwrap();
        assert_eq!(saved.workspace.expanded, ["h1"]);
        assert_eq!(saved.workspace.connected, ["h1"]);
        assert_eq!(saved.workspace.tiles.len(), 1);
        assert_eq!(saved.workspace.tiles[0].session, "b");
        assert_eq!(
            saved
                .workspace
                .dirs
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["h1"]
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("toml.tmp"));
    }

    #[test]
    fn forgetting_a_host_removes_it_from_every_workspace_list() {
        let mut workspace = full_settings().workspace;
        workspace.forget_host("host_a");
        assert_eq!(workspace.expanded, ["host_b"]);
        assert!(workspace.connected.is_empty());
        let tile_hosts: Vec<&str> = workspace.tiles.iter().map(|t| t.host_id.as_str()).collect();
        assert_eq!(tile_hosts, ["host_b"]);
        assert_eq!(
            workspace
                .dirs
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["host_b"]
        );
        // Layout und Seitenleiste gehoeren keinem Host.
        assert_eq!(workspace.layout, 4);
        assert!(workspace.sidebar_collapsed);
    }

    // --- Fehlertext einer kaputten Datei ---

    #[test]
    fn load_from_a_broken_file_names_the_path_and_the_toml_position() {
        let path = unique_temp_path("broken");
        std::fs::write(&path, "version = 1\n\n[ui]\ntheme = \n").unwrap();
        let error = format!("{:#}", load_from(&path).unwrap_err());
        assert!(error.contains(&path.display().to_string()), "{error}");
        assert!(error.contains("line 4, column"), "{error}");
        let _ = std::fs::remove_file(&path);
    }

    /// `commands::is_acceptable_remote_path` ruft diese Regel auf (absolut,
    /// ohne Steuerzeichen); hier steht ihr Test.
    #[test]
    fn remote_paths_are_posix_absolute_without_control_characters() {
        for ok in ["/", "/home/u/projekt", "/tmp/a b"] {
            assert!(is_absolute_remote_path(ok), "{ok:?}");
        }
        for bad in [
            "",
            "rel",
            "./x",
            "~/x",
            "C:\\x",
            "\\\\host\\share",
            "/a\nb",
            "/a\0b",
            "/a\x1bb",
        ] {
            assert!(!is_absolute_remote_path(bad), "{bad:?}");
        }
    }

    // --- Testisolation (UX-Ueberarbeitung, Spec §9.3) ---

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join("abtest_ux_1")
    }

    #[test]
    #[cfg(debug_assertions)]
    fn socket_override_accepts_test_socket_names() {
        let longest = "a".repeat(48);
        for raw in ["abtest_ux_1", "A-z_09", "x", longest.as_str()] {
            assert_eq!(socket_override(Some(raw)).as_deref(), Some(raw));
        }
    }

    #[test]
    fn socket_override_rejects_reserved_and_malformed_names() {
        let too_long = "a".repeat(49);
        for raw in [
            "agentbridge",
            "AgentBridge",
            "default",
            "DEFAULT",
            "",
            too_long.as_str(),
            "a b",
            "a/b",
            "../x",
            "a.b",
            "ä",
            "x\n",
        ] {
            assert_eq!(socket_override(Some(raw)), None, "{raw:?}");
        }
        assert_eq!(socket_override(None), None);
    }

    #[test]
    #[cfg(debug_assertions)]
    fn settings_dir_override_accepts_an_absolute_directory() {
        assert_eq!(settings_dir_override(test_dir().to_str()), Some(test_dir()));
    }

    #[test]
    fn settings_dir_override_rejects_empty_and_relative_paths() {
        for raw in ["", "   ", "relative", "relative/dir", "./x"] {
            assert_eq!(settings_dir_override(Some(raw)), None, "{raw:?}");
        }
        assert_eq!(settings_dir_override(None), None);
    }

    /// Seit 0.2.0 liegt `settings.toml` im Ordner der Kennung, wie
    /// `.window-state.json` (lib.rs).
    #[test]
    fn settings_path_without_override_stays_in_the_config_directory() {
        let path = settings_path_from(None).unwrap();
        let folder = Path::new("io.github.itbrain258.aidevbridge");
        assert!(path.ends_with(folder.join("settings.toml")));
    }

    /// Der Ordner ersetzt den Ordner der Kennung, `settings.toml` liegt
    /// direkt darin. Ein gesetzter, aber ungueltiger Wert ist ein Fehler --
    /// still auf die echte Datei des Nutzers auszuweichen, hiesse, dass eine
    /// Testinstanz sie beschreibt.
    #[test]
    #[cfg(debug_assertions)]
    fn settings_path_uses_the_override_and_refuses_an_invalid_one() {
        assert_eq!(
            settings_path_from(test_dir().to_str()).unwrap(),
            test_dir().join("settings.toml")
        );
        let error = settings_path_from(Some("relative"))
            .unwrap_err()
            .to_string();
        assert!(error.contains(SETTINGS_DIR_ENV), "{error}");
    }

    /// Spec 2026-10-25 §6.1: der Standard-Socket nach denselben Regeln; ein
    /// ungueltiger Name faellt nicht still auf den echten zurueck.
    #[test]
    #[cfg(debug_assertions)]
    fn default_socket_name_uses_the_override_and_refuses_an_invalid_one() {
        assert_eq!(default_socket_name_from(None), Ok("default".to_string()));
        assert_eq!(
            default_socket_name_from(Some("abtest_dflt_1")),
            Ok("abtest_dflt_1".to_string())
        );
        for raw in ["agentbridge", "default", "a b", ""] {
            let error = default_socket_name_from(Some(raw)).unwrap_err();
            assert!(error.contains(TMUX_DEFAULT_SOCKET_ENV), "{raw:?}: {error}");
        }
    }

    /// Wie oben: ein gesetzter, aber ungueltiger Socketname faellt nicht still
    /// auf den Produktionssocket zurueck.
    #[test]
    #[cfg(debug_assertions)]
    fn app_socket_uses_the_override_and_refuses_an_invalid_one() {
        assert_eq!(app_socket_from(None), Ok(default_socket()));
        assert_eq!(
            app_socket_from(Some("abtest_ux_1")),
            Ok("abtest_ux_1".to_string())
        );
        for raw in ["agentbridge", "a b", ""] {
            let error = app_socket_from(Some(raw)).unwrap_err();
            assert!(error.contains(TMUX_SOCKET_ENV), "{raw:?}: {error}");
        }
    }

    /// Der Release-Bau ueberliest beide Variablen (Spec §9.3), gueltig oder
    /// nicht.
    #[test]
    #[cfg(not(debug_assertions))]
    fn release_builds_ignore_both_variables() {
        assert_eq!(socket_override(Some("abtest_ux_1")), None);
        assert_eq!(settings_dir_override(test_dir().to_str()), None);
        let default_path = settings_path_from(None).unwrap();
        for raw in [test_dir().to_str(), Some("relative")] {
            assert_eq!(settings_path_from(raw).unwrap(), default_path);
        }
        for raw in [Some("abtest_ux_1"), Some("a b")] {
            assert_eq!(app_socket_from(raw), Ok(default_socket()));
        }
    }

    // --- Umzug aus dem Ordner von 0.1.2 ---

    /// Eine `settings.toml` aus 0.1.2 mit einem Host.
    const LEGACY_SETTINGS: &str = r#"version = 1

[[hosts]]
id = "h1"
label = "Test VM"
hostname = "192.0.2.10"
user = "dev"
"#;

    /// Ein frischer Ordner im Temp-Verzeichnis, darin der alte und der neue
    /// Ordner, beide noch nicht angelegt.
    fn migration_dirs(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("aidevbridge_test_migration_{tag}_{nanos}"));
        let legacy = base.join(LEGACY_SETTINGS_DIR_NAME);
        let new = base.join(SETTINGS_DIR_NAME);
        (base, legacy, new)
    }

    /// Ein alter Ordner mit `settings.toml` und zwei Resten, die nicht
    /// mitgehen.
    fn write_legacy_folder(legacy: &Path) {
        std::fs::create_dir_all(legacy).unwrap();
        std::fs::write(legacy.join("settings.toml"), LEGACY_SETTINGS).unwrap();
        std::fs::write(legacy.join("settings.toml.tmp"), "halb geschrieben").unwrap();
        std::fs::write(legacy.join("notes.txt"), "vom Nutzer").unwrap();
    }

    /// Name und Inhalt jeder Datei eines Ordners, sortiert.
    fn folder_files(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                (name, std::fs::read(entry.path()).unwrap())
            })
            .collect();
        files.sort();
        files
    }

    #[test]
    fn legacy_settings_are_copied_once_and_the_old_folder_stays_unchanged() {
        let (base, legacy, new) = migration_dirs("copy");
        write_legacy_folder(&legacy);
        let before = folder_files(&legacy);

        assert_eq!(
            copy_legacy_settings(&legacy, &new).unwrap(),
            Migration::Copied
        );
        assert_eq!(
            folder_files(&new),
            vec![(
                "settings.toml".to_string(),
                LEGACY_SETTINGS.as_bytes().to_vec()
            )]
        );
        let loaded = load_from(&new.join("settings.toml")).unwrap();
        assert_eq!(loaded.hosts[0].hostname, "192.0.2.10");
        assert_eq!(loaded.hosts[0].tmux_socket, "agentbridge");

        // Der naechste Start kopiert nicht noch einmal: die inzwischen
        // geaenderte neue Datei bleibt, wie sie ist.
        std::fs::write(new.join("settings.toml"), "version = 1\n").unwrap();
        assert_eq!(
            copy_legacy_settings(&legacy, &new).unwrap(),
            Migration::NotNeeded
        );
        assert_eq!(
            std::fs::read_to_string(new.join("settings.toml")).unwrap(),
            "version = 1\n"
        );
        assert_eq!(folder_files(&legacy), before);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Ausloeser ist die fehlende Datei: Den Ordner legt `.window-state.json`
    /// schon an, wenn die App einmal ohne Umzug lief.
    #[test]
    fn a_folder_with_only_the_window_state_still_gets_the_settings() {
        let (base, legacy, new) = migration_dirs("window_state");
        write_legacy_folder(&legacy);
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join(".window-state.json"), "{}").unwrap();

        assert_eq!(
            copy_legacy_settings(&legacy, &new).unwrap(),
            Migration::Copied
        );
        assert_eq!(
            std::fs::read_to_string(new.join("settings.toml")).unwrap(),
            LEGACY_SETTINGS
        );
        assert_eq!(
            std::fs::read_to_string(new.join(".window-state.json")).unwrap(),
            "{}"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn without_an_old_settings_file_nothing_is_created() {
        let (base, legacy, new) = migration_dirs("no_legacy");
        assert_eq!(
            copy_legacy_settings(&legacy, &new).unwrap(),
            Migration::NoLegacy
        );
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("notes.txt"), "vom Nutzer").unwrap();
        assert_eq!(
            copy_legacy_settings(&legacy, &new).unwrap(),
            Migration::NoLegacy
        );
        // Ein Ordner namens `settings.toml` ist keine alte Datei.
        std::fs::create_dir_all(legacy.join("settings.toml")).unwrap();
        assert_eq!(
            copy_legacy_settings(&legacy, &new).unwrap(),
            Migration::NoLegacy
        );
        assert!(!new.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Laesst sich die alte Datei nicht pruefen, ist das ein Fehler mit der
    /// Zeile auf stderr, kein stilles `NoLegacy`; kopiert wird nichts. Ein
    /// NUL-Zeichen im Pfad loest das portabel aus: `std::fs` lehnt es unter
    /// Windows wie unter Unix ohne Dateizugriff mit `InvalidInput` ab. Ein
    /// Pfad durch eine Datei taugt dafuer nicht, Windows meldet ihn als
    /// `NotFound`.
    #[test]
    fn an_old_settings_file_that_cannot_be_checked_is_reported_not_skipped() {
        let (base, _, new) = migration_dirs("unchecked");
        let legacy = base.join("agent\0bridge");
        let error = copy_legacy_settings(&legacy, &new).unwrap_err();
        assert!(format!("{error:#}").contains("could not read"), "{error:#}");
        assert!(!new.exists());
    }

    /// Scheitert das Kopieren, bleibt keine `settings.toml` zurueck: Die App
    /// startet mit den Vorgaben, und der naechste Start versucht es erneut.
    /// Die temporaere Datei als Ordner laesst das Kopieren scheitern (wie in
    /// `update_host_impl_failed_temp_write_preserves_the_complete_settings_file`).
    #[test]
    fn a_failed_copy_starts_with_defaults_and_is_retried_on_the_next_start() {
        let (base, legacy, new) = migration_dirs("failure");
        write_legacy_folder(&legacy);
        let before = folder_files(&legacy);
        std::fs::create_dir_all(new.join("settings.toml.tmp")).unwrap();

        let error = copy_legacy_settings(&legacy, &new).unwrap_err();
        assert!(format!("{error:#}").contains("could not copy"), "{error:#}");
        assert!(!new.join("settings.toml").exists());
        assert_eq!(
            load_from(&new.join("settings.toml")).unwrap(),
            Settings::default()
        );
        assert_eq!(folder_files(&legacy), before);

        std::fs::remove_dir(new.join("settings.toml.tmp")).unwrap();
        assert_eq!(
            copy_legacy_settings(&legacy, &new).unwrap(),
            Migration::Copied
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// `settings.toml` liegt im Ordner der Kennung wie `.window-state.json`;
    /// aendert sich die Kennung, muss der Ordner mitgehen.
    #[test]
    fn settings_folder_is_the_tauri_identifier() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], SETTINGS_DIR_NAME);
    }

    #[test]
    fn migration_uses_the_real_folders_without_a_test_override() {
        let config = test_dir().join("config");
        for debug in [false, true] {
            assert_eq!(
                migration_dirs_from(debug, None, None, Some(config.clone())),
                Some((
                    config.join("agentbridge"),
                    config.join("io.github.itbrain258.aidevbridge")
                ))
            );
            assert_eq!(migration_dirs_from(debug, None, None, None), None);
        }
    }

    /// Wie im Release-Bau, der `migration_dirs_from` mit
    /// `cfg!(debug_assertions)`, also `false`, ruft: gesetzte Testvariablen
    /// aendern nichts, es bleiben die echten Ordner. Ein gewoehnlicher Test,
    /// damit dieser Zweig in jedem Bau laeuft.
    #[test]
    fn without_debug_the_migration_ignores_the_test_variables() {
        let config = test_dir().join("config");
        let new = test_dir().join("new");
        let old = test_dir().join("old");
        let real = Some((
            config.join("agentbridge"),
            config.join("io.github.itbrain258.aidevbridge"),
        ));
        for (raw_new, raw_old) in [
            (new.to_str(), old.to_str()),
            (new.to_str(), None),
            (Some("relative"), Some("relative")),
        ] {
            assert_eq!(
                migration_dirs_from(false, raw_new, raw_old, Some(config.clone())),
                real
            );
        }
    }

    /// Eine Testinstanz liest nie den echten alten Ordner des Nutzers: Ohne
    /// `AIDEVBRIDGE_LEGACY_SETTINGS_DIR` zieht sie nichts um.
    #[test]
    #[cfg(debug_assertions)]
    fn a_test_instance_migrates_only_from_its_own_old_folder() {
        let config = Some(test_dir().join("config"));
        let new = test_dir().join("new");
        let old = test_dir().join("old");
        assert_eq!(
            migration_dirs_from(true, new.to_str(), None, config.clone()),
            None
        );
        assert_eq!(
            migration_dirs_from(true, new.to_str(), Some("relative"), config.clone()),
            None
        );
        assert_eq!(
            migration_dirs_from(true, Some("relative"), old.to_str(), config.clone()),
            None
        );
        assert_eq!(
            migration_dirs_from(true, new.to_str(), old.to_str(), config),
            Some((old, new))
        );
    }

    /// Die Gegenrichtung: `AIDEVBRIDGE_LEGACY_SETTINGS_DIR` wirkt nur
    /// zusammen mit `AIDEVBRIDGE_SETTINGS_DIR`. Allein gesetzt aendert es
    /// auch im Debug-Bau nichts, es bleiben die echten Ordner wie ohne die
    /// Variable.
    #[test]
    fn the_legacy_variable_alone_keeps_the_real_folders() {
        let config = test_dir().join("config");
        let old = test_dir().join("old");
        let real = Some((
            config.join("agentbridge"),
            config.join("io.github.itbrain258.aidevbridge"),
        ));
        for raw_old in [old.to_str(), Some("relative")] {
            assert_eq!(
                migration_dirs_from(true, None, raw_old, Some(config.clone())),
                real
            );
        }
    }
}
