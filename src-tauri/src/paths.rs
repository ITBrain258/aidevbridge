//! Heimat- und Konfigurationsordner der App (Spec 2026-10-27 §4.2).
//!
//! Auf dem Desktop die des Nutzers ueber `dirs`, unveraendert seit 0.1:
//! `~/.ssh` fuer `known_hosts`, `config` und die Schluessel, das
//! Konfigurationsverzeichnis fuer `settings.toml`.
//!
//! Auf Android gibt es kein Heimatverzeichnis, das die App beschreiben darf:
//! `dirs::home_dir()` liest dort nur `HOME`, und das zeigt, wenn es ueberhaupt
//! gesetzt ist, nicht in den privaten Speicher der App. Beide Ordner sind dort
//! der private Datenordner, den erst Tauris Pfadaufloeser im `setup` kennt
//! (`lib.rs`); bis dahin liefern beide `None`. `~/.ssh` liegt damit unter
//! `<Datenordner>/.ssh`, `settings.toml` unter
//! `<Datenordner>/io.github.itbrain258.aidevbridge/`.

use std::path::PathBuf;

#[cfg(mobile)]
static MOBILE_BASE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Legt den privaten Datenordner fest, einmal im `setup`. Ein zweiter Aufruf
/// aendert nichts.
#[cfg(mobile)]
pub fn init_mobile(base: PathBuf) {
    let _ = MOBILE_BASE.set(base);
}

/// Das Heimatverzeichnis, unter dem `.ssh` liegt.
#[cfg(not(mobile))]
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Das Konfigurationsverzeichnis, unter dem der Ordner von `settings.toml`
/// liegt.
#[cfg(not(mobile))]
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir()
}

/// Auf Android der private Datenordner, vor dem `setup` `None`.
#[cfg(mobile)]
pub fn home_dir() -> Option<PathBuf> {
    MOBILE_BASE.get().cloned()
}

/// Auf Android derselbe Ordner wie `home_dir`.
#[cfg(mobile)]
pub fn config_dir() -> Option<PathBuf> {
    MOBILE_BASE.get().cloned()
}

/// `~/.ssh`.
pub fn ssh_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh"))
}
