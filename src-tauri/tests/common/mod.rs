#![allow(dead_code)] // nicht jeder Testbinary nutzt jedes Hilfsmittel

// `[lib] name = "aidevbridge_lib"` in Cargo.toml bestimmt, unter welchem Namen
// Integrationstests die Bibliothek importieren -- nicht der Paketname
// `aidevbridge`. Mit `use aidevbridge::...` bricht der Compiler mit E0432
// ("unresolved import") ab.
use aidevbridge_lib::commands::{HostKeyRequest, HostKeyRequestSink};
use aidevbridge_lib::ssh::AuthMethod;
use aidevbridge_lib::transport::{HostKeyPolicy, HostSpec, RusshTransport};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Akzeptiert jeden Host-Key. NUR fuer Tests — im Produktivpfad entscheidet
/// `HostKeyVerifier` gegen known_hosts (Spec §8.1).
pub struct AcceptAll;
#[async_trait::async_trait]
impl HostKeyPolicy for AcceptAll {
    async fn decide(&self, _h: &str, _p: u16, _t: &str, _k: &str) -> bool {
        true
    }
}

/// Lehnt jeden Host-Key ab — belegt, dass eine Ablehnung die Verbindung
/// tatsaechlich verhindert.
pub struct RejectAll;
#[async_trait::async_trait]
impl HostKeyPolicy for RejectAll {
    async fn decide(&self, _h: &str, _p: u16, _t: &str, _k: &str) -> bool {
        false
    }
}

/// Wie `RejectAll`, zeichnet aber zusaetzlich auf, ob `decide` tatsaechlich
/// aufgerufen wurde. Grund: `assert!(res.is_err())` allein wird von JEDEM
/// Verbindungsfehler erfuellt (unerreichbarer Host, fehlender Schluessel,
/// Auth-Fehler, Timeout) -- nicht nur von einer Ablehnung durch die Policy.
/// Ein Test, der nur auf `is_err()` prueft, waere auch dann gruen, wenn
/// `check_server_key` die Policy nie befragt (z. B. weil jemand faelschlich
/// `Ok(true)` fest verdrahtet und die Verbindung aus einem ganz anderen
/// Grund trotzdem scheitert). Der Flag beweist, dass der Fehler tatsaechlich
/// von der Policy-Ablehnung stammt.
pub struct RecordingReject(pub Arc<AtomicBool>);
#[async_trait::async_trait]
impl HostKeyPolicy for RecordingReject {
    async fn decide(&self, _h: &str, _p: u16, _t: &str, _k: &str) -> bool {
        self.0.store(true, Ordering::SeqCst);
        false
    }
}

/// TOFU (Spec §8.1): meldet eine Host-Key-Rueckfrage als zugestellt, antwortet
/// aber nie -- fuer Tests, die bewusst einen unbeantworteten
/// `Unknown`-Zeitablauf pruefen wollen (siehe
/// `connect_rejects_a_host_missing_from_known_hosts` in
/// `integration_commands.rs`, das selbst den `Unknown`-Zweig durchlaeuft und
/// deshalb einen KURZEN, injizierten Timeout braucht statt der vollen
/// Produktions-Wartezeit).
pub struct NeverAnswersSink;
impl HostKeyRequestSink for NeverAnswersSink {
    fn request(&self, _req: &HostKeyRequest) -> bool {
        true
    }
}

/// Jeder Aufruf ist ein Testfehlschlag -- fuer Testverbindungen, die
/// garantiert nie den `Unknown`-Zweig treffen sollten (Known/Mismatch-
/// Szenarien, die den grossteil dieser Testdatei ausmachen). Faengt eine
/// Regression, die versehentlich auch fuer `Known`/`Mismatch` fragen wuerde.
pub struct PanicIfAskedSink;
impl HostKeyRequestSink for PanicIfAskedSink {
    fn request(&self, req: &HostKeyRequest) -> bool {
        panic!("unerwartete Host-Key-Rueckfrage in einem Known/Mismatch-Testszenario: {req:?}");
    }
}

/// Reine Konfigurationspruefung: Ein gesetzter Host darf erst nach gueltiger
/// Socket-Pruefung an einen Verbindungspfad weitergegeben werden. Kein
/// Umgebungszugriff, damit die Gegenfaelle parallel testbar bleiben.
pub fn validate_live_test_host<'a>(
    hostname: Option<&'a str>,
    socket: Option<&str>,
) -> Result<Option<&'a str>, &'static str> {
    let Some(hostname) = hostname else {
        return Ok(None);
    };
    if hostname.trim().is_empty() {
        return Err("gesetzter Testhost darf nicht leer sein");
    }
    validate_test_socket(socket)?;
    Ok(Some(hostname))
}

/// Nur explizite Socket-Namen fuer `tmux -L`, keine Pfade oder impliziten
/// Standard-Sockets. Der Nutzer reserviert den Namen und seine Test-Suffixe
/// fuer diesen Lauf; die Syntaxpruefung beweist nicht, dass ein beliebiger
/// anderer Socket auf dem Host unbenutzt ist.
pub fn validate_test_socket(socket: Option<&str>) -> Result<&str, &'static str> {
    let socket = socket.ok_or("AIDEVBRIDGE_TEST_SOCKET muss fuer Live-Tests gesetzt sein")?;
    if socket.is_empty()
        || socket.len() > 48
        || !socket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(
            "AIDEVBRIDGE_TEST_SOCKET braucht 1..48 ASCII-Zeichen aus A-Z, a-z, 0-9, _ und -",
        );
    }
    if socket.eq_ignore_ascii_case("default")
        || socket.eq_ignore_ascii_case("agentbridge")
        || socket.eq_ignore_ascii_case(&aidevbridge_lib::settings::default_socket())
    {
        return Err("AIDEVBRIDGE_TEST_SOCKET darf weder Standard- noch Produktionssocket sein");
    }
    Ok(socket)
}

/// Reine Konfigurationspruefung des SSH-Kontos fuer Live-Tests. Es gibt
/// bewusst keinen eingebauten Benutzer: Wer einen Testhost setzt, nennt auch
/// das Konto. Kein Umgebungszugriff, damit die Gegenfaelle parallel testbar
/// bleiben.
pub fn validate_live_test_user(user: Option<&str>) -> Result<&str, &'static str> {
    let user = user.ok_or("Testkonto fehlt")?;
    if user.trim().is_empty() {
        return Err("Testkonto darf nicht leer sein");
    }
    Ok(user)
}

/// Reine Konfigurationspruefung des Host-Schluessels fuer das Known-Szenario:
/// nur der base64-Teil eines ed25519-Schluessels, ohne Typ, Kommentar oder
/// Leerraum. Eine eingebaute Liste bekannter Test-VMs gibt es nicht.
pub fn validate_test_host_key(key: Option<&str>) -> Result<&str, &'static str> {
    let key = key.ok_or(
        "AIDEVBRIDGE_TEST_HOST_KEY fehlt (base64-Teil aus `ssh-keyscan -t ed25519 <host>`)",
    )?;
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return Err(
            "AIDEVBRIDGE_TEST_HOST_KEY braucht nur den base64-Teil, ohne Typ, Kommentar oder Leerraum",
        );
    }
    Ok(key)
}

fn optional_env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("{name} muss gueltiger Unicode sein"),
    }
}

/// SSH-Konto fuer Live-Tests aus `variable` (`AIDEVBRIDGE_TEST_USER` fuer die
/// Integrationstests, `AIDEVBRIDGE_VM_USER` und `AIDEVBRIDGE_VM_PASSWORD_USER`
/// fuer die VM-Abnahme). Erst rufen, wenn der Host feststeht: ohne Host meldet
/// der Test SKIP, mit Host aber ohne Konto schlaegt er vor SSH fehl.
pub fn live_test_user(variable: &str) -> String {
    let user = optional_env(variable);
    validate_live_test_user(user.as_deref())
        .unwrap_or_else(|error| {
            panic!("Live-Testkonfiguration abgelehnt vor SSH: {variable}: {error}")
        })
        .to_string()
}

/// Gemeinsamer Einstieg fuer TEST_HOST und die separat angeforderte
/// VM_HOST-Suite. Die Pruefung findet vor Schluesselladen und SSH statt.
/// Fehlender Host meldet einen SKIP (mit `--nocapture` sichtbar), kein
/// bestandener SSH-Nachweis. Ein gesetzter, ungueltiger Lauf schlaegt fehl.
pub fn configured_test_host(variable: &str) -> Option<String> {
    let hostname = optional_env(variable);
    let socket = optional_env("AIDEVBRIDGE_TEST_SOCKET");
    match validate_live_test_host(hostname.as_deref(), socket.as_deref()) {
        Ok(Some(_)) => hostname,
        Ok(None) => {
            eprintln!(
                "SKIP {}: {variable} nicht gesetzt; keine SSH-Pruefung ausgefuehrt",
                std::thread::current().name().unwrap_or("SSH-Test")
            );
            None
        }
        Err(error) => panic!("Live-Testkonfiguration fuer {variable} abgelehnt vor SSH: {error}"),
    }
}

/// Liefert `None` mit SKIP-Hinweis, wenn `AIDEVBRIDGE_TEST_HOST` fehlt.
/// Ein gesetzter Host verlangt vor jedem Verbindungspfad einen isolierten
/// `AIDEVBRIDGE_TEST_SOCKET` und das Konto in `AIDEVBRIDGE_TEST_USER`, auch
/// bei Tests ohne eigene tmux-Mutation.
pub fn spec() -> Option<HostSpec> {
    let hostname = configured_test_host("AIDEVBRIDGE_TEST_HOST")?;
    Some(HostSpec {
        hostname,
        port: 22,
        user: live_test_user("AIDEVBRIDGE_TEST_USER"),
    })
}

/// Auth-Methode fuer die Testumgebung: Schluessel ohne Passphrase. Bewusst von
/// `spec()` getrennt -- `HostSpec` beschreibt nur das "Wo", `AuthMethod` das
/// "Wie".
pub fn key_auth_method() -> AuthMethod {
    AuthMethod::Key {
        path: dirs::home_dir()
            .map(|h| h.join(".ssh/id_ed25519"))
            .expect("HOME/USERPROFILE nicht ermittelbar"),
        passphrase: None,
    }
}

/// Expliziter Socket fuer Command-/VM-Integration. Keine Produktionsvorgabe;
/// deren separater hermetischer Test braucht weder Host noch Umgebung.
pub fn test_socket() -> String {
    let socket = optional_env("AIDEVBRIDGE_TEST_SOCKET");
    validate_test_socket(socket.as_deref())
        .unwrap_or_else(|error| panic!("Live-Testkonfiguration abgelehnt vor SSH: {error}"))
        .to_string()
}

/// PTY-/tmux-Faelle brauchen getrennte Serveroptionen und behalten deshalb
/// eigene Suffixe, nun innerhalb des explizit reservierten Testnamensraums.
pub fn test_socket_for(suffix: &str) -> String {
    assert!(
        !suffix.is_empty()
            && suffix.len() <= 16
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "Testsocket-Suffix muss eine kurze interne Kennung sein"
    );
    format!("{}_{suffix}", test_socket())
}

const WRONG_KEY_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn test_host_name() -> String {
    std::env::var("AIDEVBRIDGE_TEST_HOST")
        .expect("AIDEVBRIDGE_TEST_HOST muss gesetzt sein, wenn ein Test real_host_key() ruft")
}

/// Der Host-Schluessel des Testhosts kommt nur aus `AIDEVBRIDGE_TEST_HOST_KEY`.
fn test_host_key_b64() -> String {
    let key = optional_env("AIDEVBRIDGE_TEST_HOST_KEY");
    validate_test_host_key(key.as_deref())
        .unwrap_or_else(|error| panic!("Live-Testkonfiguration abgelehnt: {error}"))
        .to_string()
}

/// known_hosts-Zeile mit dem ECHTEN Schluessel des Test-Hosts (Known-Szenario).
/// Absichtlich laut statt still: ein Testhost ohne `AIDEVBRIDGE_TEST_HOST_KEY`
/// ist ein Einrichtungsfehler des Testlaufs, kein Grund fuer ein gruenes
/// Ueberspringen. Den Wert liefert die dritte Spalte von
/// `ssh-keyscan -t ed25519 <host>`, abgeglichen mit einer vertrauenswuerdigen
/// Quelle wie der eigenen known_hosts.
///
/// Erlaubt, die Verdrahtung von `connect_host_with_known_hosts` gegen die
/// echte VM zu pruefen, OHNE je `~/.ssh/known_hosts` des Bedienrechners
/// anzufassen: der Text wird direkt als Parameter uebergeben (siehe
/// Doc-Kommentar der Funktion in `commands.rs`).
pub fn real_host_key() -> String {
    format!("{} ssh-ed25519 {}\n", test_host_name(), test_host_key_b64())
}

/// Dieselbe Zeile mit falschem Schluessel (Mismatch-Szenario).
pub fn wrong_key_same_host() -> String {
    format!("{} ssh-ed25519 {}\n", test_host_name(), WRONG_KEY_B64)
}

/// RSA-Schluessel fuer den Test gegen OpenSSH >= 8.8 (Befund 3 der
/// Bewertung 2026-09-04).
/// `None`: Test meldet SKIP.
///
/// `AIDEVBRIDGE_TEST_RSA_KEY` nennt eine private RSA-Schluesseldatei ohne
/// Passphrase (einmalig `ssh-keygen -t rsa -b 3072 -N "" -f <datei>`), deren
/// oeffentlicher Teil in `~/.ssh/authorized_keys` des Testkontos auf dem
/// Testhost steht. Ohne die Variable bleibt
/// `rsa_key_authenticates_against_openssh_8_8_or_newer` ein lauter SKIP.
pub fn rsa_key_path() -> Option<std::path::PathBuf> {
    std::env::var("AIDEVBRIDGE_TEST_RSA_KEY")
        .ok()
        .map(Into::into)
}

/// Verbindet mit dem Testhost oder liefert `None`, wenn keiner konfiguriert ist.
pub async fn connect_test_host() -> Option<RusshTransport> {
    let s = spec()?;
    Some(
        RusshTransport::connect(&s, Arc::new(AcceptAll), &key_auth_method())
            .await
            .expect("Verbindung zum Testhost fehlgeschlagen"),
    )
}
