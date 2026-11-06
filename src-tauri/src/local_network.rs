//! Zugriff aufs lokale Netz unter Android 17 (Spec 2026-10-27 §7.3).
//!
//! Fuer Apps mit `targetSdk` 37 sperrt Android 17 jede Verbindung ins lokale
//! Netz, bis der Nutzer `ACCESS_LOCAL_NETWORK` erlaubt. Die Sperre sitzt im
//! Netzwerkstack und trifft auch die Sockets dieser Bibliothek; ein gesperrter
//! TCP-Aufbau endet laut Google in einer Zeitueberschreitung. Den Grund
//! nennt erst `android_getnetworkblockedreason` aus dem NDK von API 37, das
//! diese App nicht aufruft.
//!
//! `prepare` fragt deshalb vor dem Aufbau nach der Berechtigung, wenn sie
//! fehlt und das Ziel im lokalen Netz liegt. Lehnt der Nutzer ab, verbindet
//! die App trotzdem: Welche Adressen Android sperrt, entscheidet allein das
//! System, und Googles Doku zaehlt die Bereiche nicht auf. Eine Adresse, die
//! hier als lokal gilt, ueber ein VPN aber erreichbar ist, bliebe sonst ohne
//! Grund gesperrt. Scheitert der Aufbau dann am Netz, bevor ein
//! Hostschluessel ankam, setzt `Gate::explain` den Grund an die Stelle der
//! Zeitueberschreitung (`connect_host_core`). Der eigene Code
//! `local_network_denied` haelt auch das Neuverbinden aus UX-Spec §5.4 an:
//! ohne Erlaubnis scheiterte jeder weitere Versuch genauso.
//!
//! Auf dem Desktop und vor Android 17 ist `prepare` ohne Wirkung.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::commands::ConnectError;

pub const DENIED_CODE: &str = "local_network_denied";

/// Der Text nennt den Weg in den Einstellungen, weil Android nach
/// Ablehnungen den Dialog nicht bei jedem Versuch wieder zeigt.
pub const DENIED_MESSAGE: &str = "The connection failed, and aidevbridge isn't allowed to reach \
     devices on your local network. Allow \"Nearby devices\" for aidevbridge in Android's \
     settings (Apps → aidevbridge → Permissions), then connect again.";

/// Liegt die Adresse im lokalen Netz? Private IPv4-Bereiche, Link-local,
/// Multicast und Broadcast, bei IPv6 Unique Local (`fc00::/7`), Link-local
/// und Multicast, dazu IPv4 in IPv6 (`::ffff:192.168.1.2`). Loopback zaehlt
/// nicht dazu: Es verlaesst das Geraet nicht. `100.64.0.0/10` (Carrier-NAT,
/// auch Tailscale) ebenso wenig, der Weg dorthin fuehrt ueber den Anbieter
/// oder ein VPN; ebenso Tailscales IPv6-Bereich `fd7a:115c:a1e0::/48`, der
/// sonst als Unique Local zaehlte. Namen in Tailscale loesen meist auf beide
/// Adressen auf und loesten sonst ueber die IPv6-Adresse den Dialog aus.
pub fn is_local_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_local_v4(ip),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => is_local_v4(ip),
            None => is_local_v6(ip),
        },
    }
}

fn is_local_v4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local() || ip.is_multicast() || ip.is_broadcast()
}

fn is_local_v6(ip: Ipv6Addr) -> bool {
    (ip.is_unique_local() && !is_tailscale_v6(ip))
        || ip.is_unicast_link_local()
        || ip.is_multicast()
}

/// `fd7a:115c:a1e0::/48`, die IPv6-Adressen von Tailscale.
fn is_tailscale_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
}

/// Namen unter `.local` loest mDNS im lokalen Netz auf; auch dafuer verlangt
/// Android 17 die Berechtigung.
pub fn is_local_name(hostname: &str) -> bool {
    hostname
        .trim_end_matches('.')
        .to_ascii_lowercase()
        .ends_with(".local")
}

/// Ergebnis von `prepare`: `Denied`, wenn das Ziel im lokalen Netz liegt und
/// der Nutzer die Berechtigung nicht erteilt hat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Open,
    Denied,
}

impl Gate {
    /// Ersetzt einen Netzfehler durch den Grund, wenn die Berechtigung fehlt.
    /// Andere Fehler (Anmeldung, Hostschluessel, Abbruch) bleiben, wie sie
    /// sind. `connect_host_core` ruft das nur, solange kein Hostschluessel
    /// ankam: Danach stand die Verbindung, und auch eine
    /// Zeitueberschreitung hat einen anderen Grund.
    pub fn explain(self, error: ConnectError) -> ConnectError {
        match (self, error.code) {
            (Gate::Denied, "connect_timeout" | "host_unreachable") => ConnectError {
                code: DENIED_CODE,
                message: DENIED_MESSAGE.to_string(),
            },
            _ => error,
        }
    }
}

/// Vor dem Verbindungsaufbau: fragt nach der Berechtigung, wenn sie fehlt und
/// `hostname` im lokalen Netz liegt.
pub async fn prepare<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    hostname: &str,
    port: u16,
) -> Gate {
    #[cfg(target_os = "android")]
    {
        android::prepare(app, hostname, port).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, hostname, port);
        Gate::Open
    }
}

#[cfg(target_os = "android")]
pub use android::init;

#[cfg(target_os = "android")]
mod android {
    use std::net::{IpAddr, ToSocketAddrs};
    use std::time::{Duration, Instant};

    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    use super::{is_local_address, is_local_name, Gate};

    /// Die Kotlin-Klasse `LocalNetworkPlugin` in `gen/android`.
    struct LocalNetwork<R: Runtime> {
        handle: PluginHandle<R>,
        /// Ein Dialog zur Zeit: Tauris `PluginManager` haelt nur einen
        /// Rueckruf fuer Berechtigungsantworten, ein zweiter Dialog nahm dem
        /// ersten die Antwort weg. Beim Start verbindet die App aber mehrere
        /// Hosts zugleich. Der Wert ist der Zeitpunkt der letzten Ablehnung.
        asking: tokio::sync::Mutex<Option<Instant>>,
    }

    #[derive(serde::Deserialize)]
    struct Access {
        granted: bool,
    }

    /// So lange wartet der Aufbau auf die Antwort im Systemdialog. Kommt
    /// keine (der Dialog blieb so lange offen), geht er ohne Antwort weiter,
    /// wie ohne diese Abfrage.
    const ANSWER_WAIT: Duration = Duration::from_secs(120);
    /// Die Namensaufloesung nur fuer die Frage, ob das Ziel lokal ist. Sie
    /// laeuft nur, solange die Berechtigung fehlt; DNS selbst sperrt Android
    /// nicht.
    const RESOLVE_WAIT: Duration = Duration::from_secs(10);
    /// Wer waehrend eines Dialogs gewartet hat und kurz nach einer Ablehnung
    /// drankommt, fragt nicht noch einmal: Die Hosts eines Starts bekaemen
    /// sonst einen Dialog nach dem anderen.
    const RECENT_DENIAL: Duration = Duration::from_secs(10);

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("local-network")
            .setup(|app, api| {
                let handle = api.register_android_plugin(
                    "io.github.itbrain258.aidevbridge",
                    "LocalNetworkPlugin",
                )?;
                app.manage(LocalNetwork {
                    handle,
                    asking: tokio::sync::Mutex::new(None),
                });
                Ok(())
            })
            .build()
    }

    async fn ask<R: Runtime>(handle: &PluginHandle<R>, command: &str) -> Option<bool> {
        match tokio::time::timeout(
            ANSWER_WAIT,
            handle.run_mobile_plugin_async::<Access>(command, ()),
        )
        .await
        {
            Ok(Ok(access)) => Some(access.granted),
            _ => None,
        }
    }

    pub async fn prepare<R: Runtime>(app: &AppHandle<R>, hostname: &str, port: u16) -> Gate {
        let Some(plugin) = app.try_state::<LocalNetwork<R>>() else {
            return Gate::Open;
        };
        // Ein Fehler im Plugin zaehlt wie eine Erlaubnis: Dann entscheidet
        // das System, wie ohne diese Abfrage.
        if ask(&plugin.handle, "checkLocalNetwork").await != Some(false) {
            return Gate::Open;
        }
        if !targets_local_network(hostname, port).await {
            return Gate::Open;
        }
        let mut last_denial = plugin.asking.lock().await;
        // Waehrend des Wartens kann ein anderer Aufbau die Erlaubnis geholt
        // haben.
        if ask(&plugin.handle, "checkLocalNetwork").await != Some(false) {
            return Gate::Open;
        }
        if last_denial.is_some_and(|denied| denied.elapsed() < RECENT_DENIAL) {
            return Gate::Denied;
        }
        match ask(&plugin.handle, "requestLocalNetwork").await {
            Some(false) => {
                *last_denial = Some(Instant::now());
                Gate::Denied
            }
            _ => Gate::Open,
        }
    }

    async fn targets_local_network(hostname: &str, port: u16) -> bool {
        if let Ok(ip) = hostname.parse::<IpAddr>() {
            return is_local_address(ip);
        }
        if is_local_name(hostname) {
            return true;
        }
        let host = hostname.to_string();
        let lookup = tauri::async_runtime::spawn_blocking(move || {
            (host.as_str(), port)
                .to_socket_addrs()
                .map(Iterator::collect::<Vec<_>>)
        });
        match tokio::time::timeout(RESOLVE_WAIT, lookup).await {
            Ok(Ok(Ok(addresses))) => addresses
                .iter()
                .any(|address| is_local_address(address.ip())),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(address: &str) -> bool {
        is_local_address(address.parse().unwrap())
    }

    #[test]
    fn private_link_local_and_multicast_addresses_are_local() {
        for address in [
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.178.20",
            "169.254.10.1",
            "224.0.0.251",
            "255.255.255.255",
            "fd12:3456:789a::1",
            "fe80::1",
            "ff02::fb",
            "::ffff:192.168.1.2",
        ] {
            assert!(local(address), "{address}");
        }
    }

    #[test]
    fn public_loopback_carrier_nat_and_tailscale_addresses_are_not_local() {
        for address in [
            "8.8.8.8",
            "172.32.0.1",
            "192.0.2.20",
            "100.64.0.1",
            "100.101.102.103",
            "fd7a:115c:a1e0::1",
            "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240",
            "127.0.0.1",
            "::1",
            "2001:db8::1",
            "2a00:1450:4001::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(!local(address), "{address}");
        }
    }

    #[test]
    fn names_under_local_are_local() {
        assert!(is_local_name("raspberrypi.local"));
        assert!(is_local_name("NAS.Local."));
        assert!(!is_local_name("local"));
        assert!(!is_local_name("example.com"));
        assert!(!is_local_name("my.localhost"));
    }

    fn error(code: &'static str) -> ConnectError {
        ConnectError {
            code,
            message: "original".to_string(),
        }
    }

    #[test]
    fn a_denied_gate_explains_network_failures_only() {
        for code in ["connect_timeout", "host_unreachable"] {
            let explained = Gate::Denied.explain(error(code));
            assert_eq!(explained.code, DENIED_CODE);
            assert_eq!(explained.message, DENIED_MESSAGE);
        }
        for code in [
            "auth_rejected",
            "host_key_rejected",
            "connect_cancelled",
            "other",
        ] {
            let kept = Gate::Denied.explain(error(code));
            assert_eq!((kept.code, kept.message.as_str()), (code, "original"));
        }
    }

    #[test]
    fn an_open_gate_keeps_every_error() {
        let kept = Gate::Open.explain(error("connect_timeout"));
        assert_eq!(
            (kept.code, kept.message.as_str()),
            ("connect_timeout", "original")
        );
    }
}
