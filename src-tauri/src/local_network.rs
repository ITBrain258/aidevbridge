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
//! Grund gesperrt. Scheitert der Aufbau dann am Netz, bevor der Host
//! geantwortet hat, setzt `Gate::explain` den Grund an die Stelle der
//! Zeitueberschreitung (`connect_host_core`). Der eigene Code
//! `local_network_denied` haelt auch das Neuverbinden aus UX-Spec §5.4 an:
//! ohne Erlaubnis scheiterte jeder weitere Versuch genauso.
//!
//! Android sperrt nur den Weg ueber WLAN und Ethernet, nicht ueber ein VPN
//! oder das Mobilfunknetz. Erreicht die App einen Host trotz Ablehnung, merkt
//! sie sich das bis zum Ende der App (`note_reached`): Fuer ihn fragt sie
//! nicht mehr, und ein spaeterer Fehler gilt nicht als Sperre.
//!
//! Auf dem Desktop und vor Android 17 ist `prepare` ohne Wirkung.

use std::collections::BTreeSet;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::oneshot;
// Die Uhr von Tokio, damit die Tests mit angehaltener Zeit auch das Ende von
// `RECENT_DENIAL` pruefen.
use tokio::time::Instant;

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
    /// Ersetzt einen Netzfehler durch den Grund, wenn die Berechtigung fehlt
    /// und der Host nicht geantwortet hat. `reached`: Der TCP-Aufbau gelang,
    /// ein Hostschluessel kam an, oder der Host wies den Aufbau ab
    /// (`host_answered`). Dann stand der Weg offen, und auch eine
    /// Zeitueberschreitung hat einen anderen Grund. Andere Fehler (Anmeldung,
    /// Hostschluessel, Abbruch) bleiben, wie sie sind.
    pub fn explain(self, error: ConnectError, reached: bool) -> ConnectError {
        match (self, error.code) {
            (Gate::Denied, "connect_timeout" | "host_unreachable") if !reached => ConnectError {
                code: DENIED_CODE,
                message: DENIED_MESSAGE.to_string(),
            },
            _ => error,
        }
    }
}

/// Hat der Host selbst auf den Aufbau geantwortet? Einen abgewiesenen oder
/// zurueckgesetzten TCP-Aufbau meldet der Host; die Sperre von Android 17
/// laesst den Aufbau dagegen ins Leere laufen.
pub fn host_answered(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
            )
        })
    })
}

/// Hosts, die die App trotz abgelehnter Berechtigung erreicht hat, mit Port.
/// Die Liste lebt nur bis zum Ende der App: Ein Host, der heute ueber ein VPN
/// erreichbar ist, kann morgen im WLAN liegen.
static REACHED: Mutex<BTreeSet<(String, u16)>> = Mutex::new(BTreeSet::new());

fn reached_key(hostname: &str, port: u16) -> (String, u16) {
    (hostname.trim_end_matches('.').to_ascii_lowercase(), port)
}

/// `connect_host_core` meldet einen Host, den es trotz `Gate::Denied`
/// erreicht hat.
pub fn note_reached(hostname: &str, port: u16) {
    REACHED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(reached_key(hostname, port));
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn was_reached(hostname: &str, port: u16) -> bool {
    REACHED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(&reached_key(hostname, port))
}

/// Wer waehrend eines Dialogs gewartet hat und kurz nach einer Ablehnung
/// drankommt, fragt nicht noch einmal: Die Hosts eines Starts bekaemen sonst
/// einen Dialog nach dem anderen.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const RECENT_DENIAL: Duration = Duration::from_secs(10);

/// Stand der Abfrage unter Android, ein Dialog zur Zeit (`android::LocalNetwork`).
#[derive(Default)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct Asking {
    /// Zeitpunkt der letzten Ablehnung.
    last_denial: Option<Instant>,
    /// Die Antwort auf den Dialog, der gerade offen ist. Sie bleibt hier, bis
    /// sie kommt oder die Anfrage ohne Antwort endet, auch wenn niemand mehr
    /// auf sie wartet (Wartezeit vorbei, oder die Zukunft des Aufbaus wird
    /// verworfen; `connect_host` tut das heute nicht). Solange fragt
    /// kein Aufbau neu: Eine zweite Anfrage, waehrend der Dialog offen ist,
    /// beantwortet Android sofort und leer, also als Ablehnung, und dem ersten
    /// Dialog fehlte danach der Rueckruf (Review vom 09.11.; am Geraet nicht
    /// nachgestellt). Darum hat die Anfrage auch keine eigene Frist: Ein Dialog,
    /// der laenger offen bleibt, braechte sonst denselben Fehler zurueck. Ginge
    /// ihre Antwort verloren, gaebe es bis zum Ende der App keinen Dialog mehr;
    /// die Aufbauten liefen dann wie ohne diese Abfrage.
    pending: Option<oneshot::Receiver<Option<bool>>>,
}

/// Der Teil von `prepare` unter Android, der nach der Berechtigung fragt, ohne
/// Tauri, damit die Tests ihn auf jedem System pruefen. `check` liest nur den
/// Stand (`None`: kein Stand, etwa ein Fehler im Plugin). `request` zeigt den
/// Systemdialog und liefert dessen Antwort; er laeuft weiter, auch wenn
/// niemand mehr wartet. Jeder Aufbau wartet hier hoechstens `answer_wait`,
/// gezaehlt ab seinem Eintritt, an der Sperre und auf den Dialog zusammen;
/// dazu kommt die Abfrage des Stands jedes Aufbaus, der vor ihm die Sperre
/// haelt (`check`, unter Android hoechstens 5 s). Wer waehrend des Wartens
/// eines anderen beginnt, wartet so nur den Rest, auch wenn er danach selbst
/// den Dialog oeffnet. Solange der Dialog offen ist, geht jeder Aufbau, sobald
/// er die Sperre hat, ohne Antwort weiter, wie ohne diese Abfrage. Ein zweites Warten unter der Sperre stapelte sich sonst auf
/// das erste und verbrauchte die Frist des Versuchs (240 s), der dann als
/// abgebrochen endete.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn ask_with<C, F, Q>(
    asking: &tokio::sync::Mutex<Asking>,
    check: C,
    request: Q,
    answer_wait: Duration,
) -> Gate
where
    C: Fn() -> F,
    F: Future<Output = Option<bool>>,
    Q: FnOnce() -> oneshot::Receiver<Option<bool>>,
{
    let started = Instant::now();
    let mut asking = asking.lock().await;
    // Waehrend des Wartens kann ein anderer Aufbau die Erlaubnis geholt
    // haben.
    if check().await != Some(false) {
        return Gate::Open;
    }
    if asking
        .last_denial
        .is_some_and(|denied| denied.elapsed() < RECENT_DENIAL)
    {
        return Gate::Denied;
    }
    if let Some(pending) = asking.pending.as_mut() {
        match pending.try_recv() {
            Err(oneshot::error::TryRecvError::Empty) => return Gate::Open,
            // Die Ablehnung kam, als niemand wartete: Sie gilt, ohne gleich
            // den naechsten Dialog zu zeigen.
            Ok(Some(false)) => {
                asking.pending = None;
                asking.last_denial = Some(Instant::now());
                return Gate::Denied;
            }
            // Erlaubnis (die `check` widerspricht), Fehler im Plugin oder
            // verlorene Anfrage: neu fragen.
            Ok(_) | Err(oneshot::error::TryRecvError::Closed) => asking.pending = None,
        }
    }
    let answer = asking.pending.insert(request());
    let rest = answer_wait.saturating_sub(started.elapsed());
    let Ok(answer) = tokio::time::timeout(rest, answer).await else {
        return Gate::Open;
    };
    asking.pending = None;
    if matches!(answer, Ok(Some(false))) {
        asking.last_denial = Some(Instant::now());
        Gate::Denied
    } else {
        Gate::Open
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
    use std::time::Duration;

    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    use super::{ask_with, is_local_address, is_local_name, was_reached, Asking, Gate};

    /// Die Kotlin-Klasse `LocalNetworkPlugin` in `gen/android`.
    struct LocalNetwork<R: Runtime> {
        handle: PluginHandle<R>,
        /// Ein Dialog zur Zeit: Tauris `PluginManager` haelt nur einen
        /// Rueckruf fuer Berechtigungsantworten, ein zweiter Dialog nahm dem
        /// ersten die Antwort weg. Beim Start verbindet die App aber mehrere
        /// Hosts zugleich.
        asking: tokio::sync::Mutex<Asking>,
    }

    #[derive(serde::Deserialize)]
    struct Access {
        granted: bool,
    }

    /// So lange wartet der Aufbau auf die Antwort im Systemdialog. Kommt
    /// keine (der Dialog blieb so lange offen), geht er ohne Antwort weiter,
    /// wie ohne diese Abfrage; der Dialog bleibt die offene Anfrage
    /// (`Asking::pending`).
    const ANSWER_WAIT: Duration = Duration::from_secs(120);
    /// Die Abfrage des Stands zeigt keinen Dialog und antwortet sofort; haengt
    /// sie, haelt sie den Aufbau nicht lange auf (unter der Sperre auch die
    /// anderen).
    const CHECK_WAIT: Duration = Duration::from_secs(5);
    /// Die Namensaufloesung nur fuer die Frage, ob das Ziel lokal ist. Sie
    /// laeuft nur, solange die Berechtigung fehlt; DNS selbst sperrt Android
    /// nicht.
    const RESOLVE_WAIT: Duration = Duration::from_secs(10);

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("local-network")
            .setup(|app, api| {
                let handle = api.register_android_plugin(
                    "io.github.itbrain258.aidevbridge",
                    "LocalNetworkPlugin",
                )?;
                app.manage(LocalNetwork {
                    handle,
                    asking: tokio::sync::Mutex::new(Asking::default()),
                });
                Ok(())
            })
            .build()
    }

    async fn check<R: Runtime>(handle: &PluginHandle<R>) -> Option<bool> {
        match tokio::time::timeout(
            CHECK_WAIT,
            handle.run_mobile_plugin_async::<Access>("checkLocalNetwork", ()),
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
        // Schon einmal trotz Ablehnung erreicht: Der Weg fuehrt nicht durch
        // die Sperre, etwa ueber ein VPN.
        if was_reached(hostname, port) {
            return Gate::Open;
        }
        // Ein Fehler im Plugin zaehlt wie eine Erlaubnis: Dann entscheidet
        // das System, wie ohne diese Abfrage.
        if check(&plugin.handle).await != Some(false) {
            return Gate::Open;
        }
        if !targets_local_network(hostname, port).await {
            return Gate::Open;
        }
        ask_with(
            &plugin.asking,
            || check(&plugin.handle),
            || {
                // In einer eigenen Aufgabe, damit die Antwort ankommt, auch
                // wenn dieser Aufbau nicht mehr wartet (`Asking::pending`).
                let (sender, answer) = tokio::sync::oneshot::channel();
                let handle = plugin.handle.clone();
                tauri::async_runtime::spawn(async move {
                    let granted = handle
                        .run_mobile_plugin_async::<Access>("requestLocalNetwork", ())
                        .await
                        .ok()
                        .map(|access| access.granted);
                    let _ = sender.send(granted);
                });
                answer
            },
            ANSWER_WAIT,
        )
        .await
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
            "febf::1",
            "ff02::fb",
            "fc00::1",
            "fd7a:115c:a1e1::1",
            "::ffff:192.168.1.2",
            "::ffff:10.0.0.1",
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
            "100.128.0.1",
            "fd7a:115c:a1e0::1",
            "fd7a:115c:a1e0:ab12:4843:cd96:6465:6667",
            "fec0::1",
            "127.0.0.1",
            "::1",
            "0.0.0.0",
            "::",
            "2001:db8::1",
            "2a00:1450:4001::1",
            "::ffff:8.8.8.8",
            "::ffff:100.64.0.1",
            "::192.168.1.2",
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
            let explained = Gate::Denied.explain(error(code), false);
            assert_eq!(explained.code, DENIED_CODE);
            assert_eq!(explained.message, DENIED_MESSAGE);
        }
        for code in [
            "auth_rejected",
            "host_key_rejected",
            "connect_cancelled",
            "other",
        ] {
            let kept = Gate::Denied.explain(error(code), false);
            assert_eq!((kept.code, kept.message.as_str()), (code, "original"));
        }
    }

    #[test]
    fn a_denied_gate_keeps_failures_after_the_host_answered() {
        for code in ["connect_timeout", "host_unreachable"] {
            let kept = Gate::Denied.explain(error(code), true);
            assert_eq!((kept.code, kept.message.as_str()), (code, "original"));
        }
    }

    #[test]
    fn an_open_gate_keeps_every_error() {
        let kept = Gate::Open.explain(error("connect_timeout"), false);
        assert_eq!(
            (kept.code, kept.message.as_str()),
            ("connect_timeout", "original")
        );
    }

    fn io_failure(kind: std::io::ErrorKind) -> anyhow::Error {
        anyhow::Error::from(std::io::Error::from(kind)).context("Host not reachable.")
    }

    #[test]
    fn a_refused_or_reset_connection_was_answered_by_the_host() {
        for kind in [
            std::io::ErrorKind::ConnectionRefused,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::ConnectionAborted,
        ] {
            assert!(host_answered(&io_failure(kind)), "{kind:?}");
        }
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::HostUnreachable,
            std::io::ErrorKind::NetworkUnreachable,
            std::io::ErrorKind::PermissionDenied,
        ] {
            assert!(!host_answered(&io_failure(kind)), "{kind:?}");
        }
        assert!(!host_answered(&anyhow::anyhow!("no such host")));
    }

    #[test]
    fn a_reached_host_is_remembered_by_name_and_port() {
        note_reached("Reached-Host.example.", 2222);
        assert!(was_reached("reached-host.example", 2222));
        assert!(!was_reached("reached-host.example", 22));
        assert!(!was_reached("other-host.example", 2222));
    }

    // Review vom 09.11.: Blieb der Systemdialog laenger offen, als ein Aufbau
    // wartet, fragte der naechste Aufbau neu. Android beantwortet eine zweite
    // Anfrage bei offenem Dialog sofort und leer, also als Ablehnung, und das
    // Neuverbinden hielt an. Jetzt fragt niemand neu, solange er offen ist,
    // und nur der Aufbau, der ihn oeffnete, wartet auf ihn.
    const WAIT: Duration = Duration::from_secs(120);

    async fn missing() -> Option<bool> {
        Some(false)
    }

    fn no_request() -> oneshot::Receiver<Option<bool>> {
        panic!("a second request while the dialog is open");
    }

    #[tokio::test(start_paused = true)]
    async fn attempts_during_an_open_dialog_go_on_at_once_without_a_request() {
        let asking = tokio::sync::Mutex::new(Asking::default());
        let (dialog, answer) = oneshot::channel();

        assert_eq!(
            ask_with(&asking, missing, || answer, WAIT).await,
            Gate::Open
        );
        assert!(asking.lock().await.pending.is_some());

        let start = tokio::time::Instant::now();
        assert_eq!(
            ask_with(&asking, missing, no_request, WAIT).await,
            Gate::Open
        );
        assert_eq!(start.elapsed(), Duration::ZERO);
        assert!(asking.lock().await.pending.is_some());

        // Die spaete Ablehnung gilt, ohne einen weiteren Dialog.
        dialog.send(Some(false)).unwrap();
        assert_eq!(
            ask_with(&asking, missing, no_request, WAIT).await,
            Gate::Denied
        );
        let state = asking.lock().await;
        assert!(state.pending.is_none());
        assert!(state.last_denial.is_some());
    }

    // Befund der Pruefung des Branches: Wartete der zweite Aufbau unter der
    // Sperre noch einmal, stapelten sich die Wartezeiten ueber die Frist des
    // Versuchs (240 s).
    #[tokio::test(start_paused = true)]
    async fn the_waits_of_concurrent_attempts_do_not_add_up() {
        let asking = tokio::sync::Mutex::new(Asking::default());
        let (_dialog, answer) = oneshot::channel();
        let start = tokio::time::Instant::now();

        let (first, second) = tokio::join!(
            ask_with(&asking, missing, || answer, WAIT),
            ask_with(&asking, missing, no_request, WAIT),
        );
        assert_eq!((first, second), (Gate::Open, Gate::Open));
        assert_eq!(start.elapsed(), WAIT);
    }

    // Pruefung der dritten Runde: Endete die Anfrage des ersten Aufbaus kurz
    // vor seiner Wartezeit ohne Antwort, wartete der naechste als neuer
    // Oeffner noch einmal die volle Zeit, ueber die Frist des Versuchs hinaus.
    #[tokio::test(start_paused = true)]
    async fn a_queued_attempt_that_opens_the_next_dialog_waits_only_the_rest() {
        let asking = tokio::sync::Mutex::new(Asking::default());
        let (lost, first) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(WAIT - Duration::from_secs(1)).await;
            lost.send(None).unwrap();
        });
        let (_dialog, second) = oneshot::channel();
        let start = tokio::time::Instant::now();

        let (one, two) = tokio::join!(
            ask_with(&asking, missing, || first, WAIT),
            ask_with(&asking, missing, || second, WAIT),
        );
        assert_eq!((one, two), (Gate::Open, Gate::Open));
        assert_eq!(start.elapsed(), WAIT);
        assert!(asking.lock().await.pending.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_attempt_keeps_the_open_dialog() {
        let asking = tokio::sync::Mutex::new(Asking::default());
        let (_dialog, answer) = oneshot::channel();

        let cancelled = tokio::time::timeout(
            Duration::from_secs(5),
            ask_with(&asking, missing, || answer, WAIT),
        )
        .await;
        assert!(cancelled.is_err());
        assert!(asking.lock().await.pending.is_some());
        assert_eq!(
            ask_with(&asking, missing, no_request, WAIT).await,
            Gate::Open
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_grant_a_plugin_error_or_a_lost_request_leads_to_a_new_request() {
        for outcome in [Some(Some(true)), Some(None), None] {
            let asking = tokio::sync::Mutex::new(Asking::default());
            let (dialog, answer) = oneshot::channel();
            assert_eq!(
                ask_with(&asking, missing, || answer, WAIT).await,
                Gate::Open
            );
            match outcome {
                Some(late) => dialog.send(late).unwrap(),
                None => drop(dialog),
            }

            let (again, second) = oneshot::channel();
            again.send(Some(false)).unwrap();
            let requested = std::cell::Cell::new(false);
            let gate = ask_with(
                &asking,
                missing,
                || {
                    requested.set(true);
                    second
                },
                WAIT,
            )
            .await;
            assert!(requested.get(), "{outcome:?}");
            assert_eq!(gate, Gate::Denied, "{outcome:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_denial_answers_the_next_attempts_for_a_moment_without_a_dialog() {
        let asking = tokio::sync::Mutex::new(Asking::default());
        let (dialog, answer) = oneshot::channel();
        dialog.send(Some(false)).unwrap();
        assert_eq!(
            ask_with(&asking, missing, || answer, WAIT).await,
            Gate::Denied
        );
        assert_eq!(
            ask_with(&asking, missing, no_request, WAIT).await,
            Gate::Denied
        );
    }

    #[tokio::test(start_paused = true)]
    async fn after_a_recent_denial_the_next_attempt_asks_again() {
        let asking = tokio::sync::Mutex::new(Asking::default());
        let (dialog, answer) = oneshot::channel();
        dialog.send(Some(false)).unwrap();
        assert_eq!(
            ask_with(&asking, missing, || answer, WAIT).await,
            Gate::Denied
        );

        tokio::time::advance(RECENT_DENIAL).await;
        let (again, second) = oneshot::channel();
        again.send(Some(true)).unwrap();
        let requested = std::cell::Cell::new(false);
        let gate = ask_with(
            &asking,
            missing,
            || {
                requested.set(true);
                second
            },
            WAIT,
        )
        .await;
        assert!(requested.get());
        assert_eq!(gate, Gate::Open);
    }

    #[tokio::test(start_paused = true)]
    async fn a_grant_a_plugin_error_or_a_lost_request_lets_the_attempt_go_on() {
        for outcome in [Some(Some(true)), Some(None), None] {
            let asking = tokio::sync::Mutex::new(Asking::default());
            let (dialog, answer) = oneshot::channel();
            match outcome {
                Some(granted) => dialog.send(granted).unwrap(),
                None => drop(dialog),
            }
            assert_eq!(
                ask_with(&asking, missing, || answer, WAIT).await,
                Gate::Open,
                "{outcome:?}"
            );
            let state = asking.lock().await;
            assert!(
                state.pending.is_none() && state.last_denial.is_none(),
                "{outcome:?}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_permission_granted_meanwhile_needs_no_dialog() {
        let asking = tokio::sync::Mutex::new(Asking::default());
        for state in [Some(true), None] {
            let gate = ask_with(&asking, || async move { state }, no_request, WAIT).await;
            assert_eq!(gate, Gate::Open, "{state:?}");
        }
    }
}
