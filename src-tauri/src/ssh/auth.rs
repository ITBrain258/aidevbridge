//! Drei Auth-Wege gegen den SSH-Server: Schluessel (mit optionaler
//! Passphrase), ssh-agent, Passwort (Spec §8.4).
//!
//! Der Entwickler dieses Projekts testet nur gegen den einfachsten Fall
//! (Schluessel ohne Passphrase). Echte Nutzer haben Passphrasen,
//! einen unter Windows 11 standardmaessig deaktivierten ssh-agent-Dienst
//! und Passwort-Logins. Deshalb muss jeder Fehlschlag unterscheidbar sein:
//! die Meldung allein muss dem Nutzer sagen, was zu tun ist (Spec §7.5).

use super::rsa_signer::PreparedRsa;
use russh::client::{self, Handle};
use russh::keys::agent::AgentIdentity;
use russh::keys::{ssh_key::private::KeypairData, PrivateKey, PrivateKeyWithHashAlg};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zeroize::Zeroizing;

/// Windows: Named Pipe des OpenSSH-`ssh-agent`-Windows-Dienstes. Der Dienst
/// ist unter Windows 11 standardmaessig deaktiviert. Fehlt die Pipe (Dienst
/// aus), meldet `connect_named_pipe` sofort einen `NotFound`-Fehler -- nur
/// bei `ERROR_PIPE_BUSY` (Dienst laeuft, aber gerade beschaeftigt) wartet
/// russh in einer Schleife (`connect_named_pipe`). Dieser Fall kann warten;
/// der kontrollierte Transport begrenzt Pipeaufbau und alle Identitaeten
/// gemeinsam durch sein einmaliges Auth-Budget.
#[cfg(windows)]
const WINDOWS_SSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Eine der drei Auth-Methoden aus Spec §8.4.
#[derive(Clone)]
pub enum AuthMethod {
    Key {
        path: PathBuf,
        passphrase: Option<Zeroizing<String>>,
    },
    Agent,
    Password(Zeroizing<String>),
}

// `Zeroizing<String>` leitet `Debug` ab und druckt den Klartext (siehe
// zeroize-1.9.0/src/lib.rs: `#[derive(Debug, ...)] pub struct
// Zeroizing<Z>(Z);` -- das Zeroizing betrifft nur `Drop`, nicht `Debug`).
// Ein abgeleitetes `#[derive(Debug)]` auf `AuthMethod` wuerde Passphrase
// und Passwort im Klartext in Logs/Panics ausgeben und damit genau den
// Zweck von `zeroize` unterlaufen. Deshalb von Hand implementiert.
impl std::fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Key { path, passphrase } => f
                .debug_struct("Key")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
            Self::Agent => write!(f, "Agent"),
            Self::Password(_) => write!(f, "Password(<redacted>)"),
        }
    }
}

/// Jede Variante braucht eine eigene, handlungsleitende Meldung (Spec §7.5).
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("host unreachable")]
    HostUnreachable,
    #[error("key unreadable: {0}")]
    KeyUnreadable(String),
    #[error("passphrase required")]
    PassphraseRequired,
    #[error("passphrase wrong")]
    PassphraseWrong,
    #[error("password wrong")]
    PasswordWrong,
    #[error("agent unavailable: {0}")]
    AgentUnavailable(String),
    /// Der Agent ist erreichbar, `request_identities()` liefert aber keine
    /// Identitaet. Getrennt von `AgentUnavailable`, weil die richtige
    /// Handlung eine andere ist: dort den Dienst starten (Windows:
    /// `Start-Service ssh-agent`), hier einen Schluessel mit `ssh-add` laden.
    /// Der Display-Text beginnt wie der von `AgentUnavailable`.
    #[error("agent unavailable: no identities loaded: {0}")]
    AgentNoIdentities(String),
    #[error("method not offered: {0}")]
    MethodNotOffered(String),
    /// `AuthResult::Failure.partial_success`: der Server hat GENAU DEN
    /// VERSUCHTEN FAKTOR akzeptiert, verlangt aber laut RFC 4252 §5.1
    /// mindestens einen weiteren (z. B. `AuthenticationMethods
    /// publickey,password` in `sshd_config`). Der Faktor steht dann u. U.
    /// nicht mehr in `remaining_methods`; "Methode nicht angeboten" oder
    /// "falsches Passwort" waere eine Luege. Mehrfaktor-Anmeldung zu
    /// unterstuetzen ist laut Spec kein Ziel dieser Version -- die Anwendung
    /// muss das aber SAGEN. Der Display-Text beginnt wie der von
    /// `MethodNotOffered`.
    #[error("method not offered: partial-success: {0}")]
    MultiFactorRequired(String),
    #[error("secure signing failed")]
    SigningFailed,
}

impl AuthError {
    /// Jede Variante braucht eine eigene, handlungsleitende Meldung (Spec §7.5).
    /// Der mitgefuehrte Text aendert die Meldung nie.
    pub fn user_message(&self) -> &'static str {
        match self {
            Self::HostUnreachable => "Host not reachable. Check hostname, port and network.",
            Self::KeyUnreadable(_) => "Key file could not be read. Check the path and permissions.",
            Self::PassphraseRequired => "This key is passphrase-protected. Enter the passphrase.",
            Self::PassphraseWrong => "Wrong passphrase for this key.",
            Self::PasswordWrong => "Wrong password for this account.",
            Self::SigningFailed => {
                "Secure signing failed. Try again or choose another authentication method."
            }
            Self::AgentUnavailable(_) => {
                "ssh-agent not reachable. On Windows 11 the service is disabled by default — \
                 start it with: Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent"
            }
            Self::AgentNoIdentities(_) => {
                "ssh-agent is reachable but has no keys loaded. Add one with: ssh-add"
            }
            Self::MethodNotOffered(_) => "The server does not offer this authentication method.",
            Self::MultiFactorRequired(_) => {
                "This account requires more than one authentication factor (e.g. key + \
                 password). aidevbridge does not support multi-factor authentication in \
                 this version."
            }
        }
    }
}

/// Ordnet die Fehlertexte des Schluessel-Laders (`russh::keys::Error`, ueber
/// `.to_string()`) den Varianten zu.
///
/// Massgeblich sind die echten Fehlertexte, nicht erfundene Beispiele wie
/// `"PEM error: ..."`: die tatsaechliche russh/ssh_key-Fehlerkette liefert
/// andere Woerter -- durch Quellstudium (russh 0.62.4, ssh-key
/// 0.7.0-rc.11) und einen hermetischen Test gegen echte Schluessel-Fixturen
/// verifiziert (siehe Testmodul unten, `real_encrypted_key_*`):
///
/// - Kein Passwort angegeben, Schluessel verschluesselt:
///   `russh::keys::Error::KeyIsEncrypted` -> `"The key is encrypted"`.
///   Passt zu `contains("encrypted")`.
/// - Falsches Passwort, OpenSSH-Format mit nicht-AEAD-Chiffre (z. B.
///   `aes256-ctr`, ein von `ssh-keygen` verwendetes Standardformat): der
///   Header-"Checkint"-Vergleich in
///   `ssh_key::PrivateKey::decode_privatekey_comment_pair` schlaegt fehl
///   mit `ssh_key::Error::Crypto` -> `"SshKey: cryptographic error"`.
///   Das enthaelt WEDER `"decryption failed"` NOCH `"mac"` -- die zwei
///   Substrings fuer eine falsche Passphrase. Ohne die zusaetzliche
///   `contains("crypto")`-Klausel waere jede falsche Passphrase bei einem
///   Standard-ed25519-Schluessel als `KeyUnreadable` eingeordnet worden:
///   eine irrefuehrende Meldung ("Datei nicht lesbar" statt "falsche
///   Passphrase").
/// - `"decryption failed"` / `"mac"` bleiben fuer PKCS#8/PKCS#5-verschluesselte
///   PEM-Schluessel (z. B. `ssh-keygen -m PEM`) erhalten, deren
///   Fehlerketten ueber die `pkcs8`-Crate laufen und andere Formulierungen
///   verwenden.
pub fn classify_key_error(msg: &str) -> AuthError {
    let m = msg.to_ascii_lowercase();
    if m.contains("encrypted") && !m.contains("decryption") {
        AuthError::PassphraseRequired
    } else if m.contains("decryption failed") || m.contains("mac") || m.contains("crypto") {
        AuthError::PassphraseWrong
    } else {
        AuthError::KeyUnreadable(msg.to_string())
    }
}

/// Baut `MultiFactorRequired` fuer den `partial_success`-Fall -- gemeinsam
/// fuer alle drei Auth-Wege, damit der Text fuer Schluessel-, Agent- und
/// Passwort-Weg wortgleich aufgebaut ist.
fn partial_success_error(method_label: &str) -> AuthError {
    AuthError::MultiFactorRequired(format!(
        "{method_label} was accepted by the server, but it requires an additional \
         authentication factor (multi-factor authentication is not supported)"
    ))
}

/// Ordnet ein gescheitertes `AuthResult` fuer die beiden Public-Key-Wege
/// (Schluessel- und Agent-Auth, Spec §8.4) der richtigen Variante zu.
///
/// Prueft `partial_success` ZUERST, siehe `AuthError::MultiFactorRequired`.
/// Ist `partial_success` falsch, bleibt es bei `MethodNotOffered`, ohne
/// zusaetzliche Auswertung von `remaining_methods`. Anders als beim
/// Passwort-Weg (`classify_password_failure`) gibt es hier keine
/// `AuthError`-Variante, die "Schluessel korrekt entschluesselt, aber vom
/// Server abgelehnt" von "Methode nicht angeboten" trennen wuerde -- beide
/// Faelle bilden ohnehin auf `MethodNotOffered(method_label)` ab, eine
/// `remaining_methods`-Auswertung haette hier keinen unterscheidbaren
/// Zusatznutzen (bekannte Grenze).
fn classify_publickey_failure(partial_success: bool, method_label: &str) -> AuthError {
    if partial_success {
        return partial_success_error(method_label);
    }
    AuthError::MethodNotOffered(method_label.to_string())
}

/// Ordnet einen fehlgeschlagenen Passwort-Auth-Versuch der richtigen
/// Variante zu, statt jeden Fehlschlag pauschal als "falsches Passwort" zu
/// melden.
///
/// Prueft `partial_success` ZUERST, siehe `AuthError::MultiFactorRequired`:
/// ein akzeptiertes Passwort bei serverseitig erzwungener
/// Mehrfaktor-Authentifizierung darf weder als `PasswordWrong` (das Passwort
/// war korrekt) noch als generisches `MethodNotOffered` (die Methode wurde
/// sehr wohl angeboten und akzeptiert) gemeldet werden.
///
/// Erst danach greift die uebrige Logik: `remaining_methods` listet laut
/// russh-Doc-Kommentar ("The server suggests to proceed with these auth
/// methods") die Methoden, mit denen der Server einen weiteren Versuch fuer
/// sinnvoll haelt -- deckungsgleich mit der "authentications that can
/// continue"-Liste aus RFC 4252 §5.1. Fehlt `Password` darin, bietet der
/// Server Passwort-Auth fuer diesen Account gar nicht an (z. B.
/// `PasswordAuthentication no` in `sshd_config`) -- "falsches Passwort"
/// waere hier irrefuehrend, das Passwort wurde nie tatsaechlich geprueft.
/// Ist `Password` weiterhin enthalten, hat der Server konkret dieses
/// Passwort abgelehnt, bietet die Methode aber grundsaetzlich an.
///
/// Nimmt bewusst `&MethodSet` und `bool` statt der ganzen `AuthResult`
/// entgegen: ein `unreachable!()` fuer den `AuthResult::Success`-Fall waere
/// nur an einer korrekt bewachten Aufrufstelle unerreichbar, also ein stiller
/// Panic-Pfad bei Wiederverwendung. Mit dieser Signatur ist der Erfolgsfall am
/// Aufrufer (`authenticate()`) strukturell ausgeschlossen -- es gibt keinen
/// Wert dieser Parameter, der `AuthResult::Success` entspraeche, also auch
/// keinen Panic-Pfad mehr, der wegdefiniert werden muesste.
fn classify_password_failure(
    remaining_methods: &russh::MethodSet,
    partial_success: bool,
) -> AuthError {
    if partial_success {
        return partial_success_error("password");
    }
    if remaining_methods.contains(&russh::MethodKind::Password) {
        AuthError::PasswordWrong
    } else {
        AuthError::MethodNotOffered("password".into())
    }
}

/// Bildet einen beliebigen Verbindungsfehler (Pipe/Socket nicht erreichbar,
/// `SSH_AUTH_SOCK` nicht gesetzt, ...) auf `AuthError::AgentUnavailable` ab.
/// Gemeinsam fuer Windows- und Unix-Zweig, damit die Fehlerklassifikation
/// an einer Stelle steht statt dreifach dupliziert zu werden.
fn agent_unavailable(e: impl std::fmt::Display) -> AuthError {
    AuthError::AgentUnavailable(e.to_string())
}

/// Baut `AgentNoIdentities` fuer "Agent erreichbar, aber keine Identitaeten
/// geladen". Als eigene Funktion ausgelagert, damit sie ohne echten
/// Agent-Prozess unit-testbar ist (siehe Testmodul unten).
fn agent_has_no_identities_error() -> AuthError {
    AuthError::AgentNoIdentities("agent is reachable but has no identities loaded".into())
}

#[cfg(unix)]
async fn connect_agent(
) -> Result<russh::keys::agent::client::AgentClient<tokio::net::UnixStream>, AuthError> {
    russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(agent_unavailable)
}

/// Wie `connect_agent`, aber mit frei waehlbarem Unix-Socket-Pfad --
/// Pendant zu `connect_agent_at` unter Windows (siehe dort), nur fuer
/// Tests: die Produktionsfunktion `connect_agent` bleibt bewusst bei
/// `connect_env()` (liest `SSH_AUTH_SOCK`, inklusive dessen
/// `NotFound`-auf-`BadAuthSock`-Spezialbehandlung aus russh); ein Test
/// braucht aber einen frei waehlbaren, garantiert nicht existierenden
/// Pfad, unabhaengig vom tatsaechlichen Zustand von `SSH_AUTH_SOCK` auf der
/// Build-Maschine. Deshalb separat und nur unter `#[cfg(test)]`, damit
/// diese Variante in einem normalen (Nicht-Test-)Build kein totes,
/// unbenutztes Symbol ist.
#[cfg(all(unix, test))]
async fn connect_agent_at(
    path: &str,
) -> Result<russh::keys::agent::client::AgentClient<tokio::net::UnixStream>, AuthError> {
    russh::keys::agent::client::AgentClient::connect_uds(path)
        .await
        .map_err(agent_unavailable)
}

#[cfg(windows)]
async fn connect_agent() -> Result<
    russh::keys::agent::client::AgentClient<tokio::net::windows::named_pipe::NamedPipeClient>,
    AuthError,
> {
    connect_agent_at(WINDOWS_SSH_AGENT_PIPE).await
}

/// Wie `connect_agent`, aber mit frei waehlbarem Pipe-Pfad -- ausgelagert,
/// damit ein Test die "Dienst aus"-Situation deterministisch nachstellen
/// kann, ohne vom tatsaechlichen Zustand des `ssh-agent`-Diensts auf der
/// Build-Maschine abzuhaengen (siehe Testmodul unten).
#[cfg(windows)]
async fn connect_agent_at(
    pipe: &str,
) -> Result<
    russh::keys::agent::client::AgentClient<tokio::net::windows::named_pipe::NamedPipeClient>,
    AuthError,
> {
    russh::keys::agent::client::AgentClient::connect_named_pipe(pipe)
        .await
        .map_err(agent_unavailable)
}

/// Fragt die im Agent geladenen Identitaeten ab und probiert sie der Reihe
/// nach durch. Generisch ueber den Stream-Typ, damit Unix-Socket und
/// Windows-Named-Pipe dieselbe Logik teilen.
async fn authenticate_with_agent<H, S>(
    handle: &mut Handle<H>,
    user: &str,
    mut agent: russh::keys::agent::client::AgentClient<S>,
) -> Result<(), AuthError>
where
    H: client::Handler,
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let ids = agent
        .request_identities()
        .await
        .map_err(agent_unavailable)?;
    if ids.is_empty() {
        // Der Agent IST erreichbar, ihm fehlen nur geladene Schluessel -- die
        // richtige Handlung ist `ssh-add`, nicht ein Dienst-Neustart (siehe
        // `AuthError::AgentNoIdentities`).
        return Err(agent_has_no_identities_error());
    }
    for id in ids {
        // Zertifikats-Identitaeten brauchen `authenticate_certificate_with`,
        // einen eigenen Auth-Weg -- hier nicht Gegenstand (Spec §8.4 nennt
        // nur Schluessel/Agent/Passwort, keine Zertifikate).
        let AgentIdentity::PublicKey { key, .. } = id else {
            continue;
        };
        // `best_supported_rsa_hash()` wartet bis zu einer Sekunde auf EXT_INFO
        // (RFC 8308) -- das darf einen ed25519-Login nicht verlangsamen,
        // deshalb nur fuer RSA-Schluessel abgefragt.
        let hash = if key.algorithm().is_rsa() {
            choose_rsa_hash(handle.best_supported_rsa_hash().await)
        } else {
            None
        };
        // Jeder Fehler bricht die Schleife ab, auch eine abgelehnte Signatur:
        // nach einer gescheiterten Signaturanfrage wartet die russh-Session
        // nur noch auf die Signatur und verwirft alles andere, die naechste
        // Identitaet wuerde haengen. Weitere Identitaeten probieren geht erst
        // mit einem russh-Patch.
        let result = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
            .map_err(agent_sign_error)?;
        match result {
            russh::client::AuthResult::Success => return Ok(()),
            // partial_success ZUERST pruefen und sofort melden, statt weitere
            // Identitaeten durchzuprobieren -- ein zweiter Schluessel behebt
            // den fehlenden zweiten Faktor i. d. R. nicht (Spec verlangt kein
            // 2FA-Handling), und ein ehrlicher Abbruch ist einer stillen
            // weiteren Fehlschlagkette vorzuziehen.
            russh::client::AuthResult::Failure {
                partial_success: true,
                ..
            } => return Err(partial_success_error("publickey (agent)")),
            russh::client::AuthResult::Failure {
                partial_success: false,
                ..
            } => continue,
        }
    }
    Err(classify_publickey_failure(false, "publickey (agent)"))
}

/// Ordnet den Fehler einer Agent-Anmeldung zu. `Send` heisst, die
/// SSH-Session selbst ist weg: ein Verbindungsfehler. `Key` kommt vom Agenten:
/// eine verweigerte Signatur (SSH_AGENT_FAILURE, etwa nach abgelehnter
/// `ssh-add -c`-Rueckfrage oder bei einem FIDO-Schluessel ohne Beruehrung),
/// aber auch IO- und Protokollfehler des Agenten. Sie alle zaehlen als
/// Signaturfehler; `SigningFailed` ist ein Anmeldefehler und beendet damit die
/// automatische Wiederverbindung, statt bei jedem Versuch erneut nachzufragen.
fn agent_sign_error(error: russh::AgentAuthError) -> AuthError {
    match error {
        russh::AgentAuthError::Send(_) => AuthError::HostUnreachable,
        russh::AgentAuthError::Key(_) => AuthError::SigningFailed,
    }
}

/// Bildet `server-sig-algs` (aus `Handle::best_supported_rsa_hash()`, EXT_INFO
/// nach RFC 8308) auf den Hash ab, der fuer eine RSA-Publickey-Auth benutzt
/// werden soll. `None` (der Server sagt gar nichts, weil er kein EXT_INFO
/// schickt oder das Warten dafuer scheitert): Rueckfall SHA-256, weil jeder
/// OpenSSH >= 7.2 das kann und OpenSSH >= 8.8 das alte `ssh-rsa`/SHA-1
/// ablehnt. `Some(None)`: der Server hat ausdruecklich geantwortet, kann aber
/// nur `ssh-rsa` -- dann bleibt `hash_alg` bei `None` (kein anderer Weg
/// bliebe uebrig). `Some(Some(h))`: der Server unterstuetzt `h`, das wird
/// benutzt. `Err(_)`: die Abfrage selbst ist fehlgeschlagen (z. B.
/// `SendError`) -- selbes Verhalten wie "Server sagt nichts", SHA-256.
pub fn choose_rsa_hash(
    negotiated: Result<Option<Option<russh::keys::HashAlg>>, russh::Error>,
) -> Option<russh::keys::HashAlg> {
    match negotiated {
        // `Some(None)` gibt es nur, wenn der Server kein rsa-sha2-* anbietet;
        // dann signiert russh mit `ssh-rsa`/SHA-1. Dieser Rueckfall bleibt
        // bewusst erhalten und steht in SECURITY.md als akzeptiertes Risiko.
        Ok(Some(inner)) => inner,
        Ok(None) | Err(_) => Some(russh::keys::HashAlg::Sha256),
    }
}

pub(crate) enum PreparedKey {
    Rsa(Box<PreparedRsa>),
    Other(Arc<PrivateKey>),
}

/// One authentication's prepared credentials. A connection pair may share its
/// password/non-RSA owner; there is no private-key Clone or app-wide cache.
pub(crate) enum PreparedAuth {
    Key(PreparedKey),
    Password(Arc<Zeroizing<String>>),
    Agent,
}

/// russh 0.63.2 parses an encrypted PKCS#8 envelope as plaintext when no
/// password is supplied. Recognize only a structurally valid envelope at
/// the decoder boundary so the UI can request the missing passphrase.
fn decode_key_source(source: &str, passphrase: Option<&str>) -> Result<PrivateKey, AuthError> {
    if passphrase.is_none() && is_encrypted_pkcs8(source) {
        return Err(AuthError::PassphraseRequired);
    }
    russh::keys::decode_secret_key(source, passphrase)
        .map_err(|error| classify_key_error(&error.to_string()))
}

fn is_encrypted_pkcs8(source: &str) -> bool {
    use rsa::pkcs8::{der::pem::Decoder, EncryptedPrivateKeyInfoRef};

    // PuTTY has decoder precedence. An inline comment, another PEM block,
    // or a header without a valid PEM/DER body must not trigger the dialog.
    if source.trim_start().starts_with("PuTTY-User-Key-File-")
        || source.lines().find(|line| line.starts_with("-----BEGIN "))
            != Some("-----BEGIN ENCRYPTED PRIVATE KEY-----")
    {
        return false;
    }
    // russh also accepts unwrapped PEM output. Let the existing PEM library
    // detect the line width rather than restricting files to 64 columns.
    let Ok(mut decoder) = Decoder::new_detect_wrap(source.trim_end().as_bytes()) else {
        return false;
    };
    let mut document = Zeroizing::new(Vec::new());
    decoder.type_label() == "ENCRYPTED PRIVATE KEY"
        && decoder.decode_to_end(&mut document).is_ok()
        && EncryptedPrivateKeyInfoRef::try_from(document.as_slice())
            .is_ok_and(|info| !info.encrypted_data.as_bytes().is_empty())
}

/// Load/decrypt/validate before opening a network connection. The outer file
/// buffer is zeroizing; the existing decoder still owns its own intermediate
/// buffers, so this does not promise complete erasure of all decoder memory.
fn load_key(path: &Path, passphrase: Option<&str>) -> Result<PrivateKey, AuthError> {
    let mut source = Zeroizing::new(String::new());
    std::fs::File::open(path)
        .and_then(|mut file| file.read_to_string(&mut source))
        .map_err(|e| AuthError::KeyUnreadable(e.to_string()))?;
    decode_key_source(&source, passphrase)
}

pub(crate) fn prepare_auth(method: &AuthMethod) -> Result<PreparedAuth, AuthError> {
    match method {
        AuthMethod::Key { path, passphrase } => {
            let key = load_key(path, passphrase.as_ref().map(|value| value.as_str()))?;
            let prepared = match key.key_data() {
                KeypairData::Rsa(rsa) => {
                    PreparedKey::Rsa(Box::new(PreparedRsa::new(rsa, key.public_key().clone())?))
                }
                _ => PreparedKey::Other(Arc::new(key)),
            };
            Ok(PreparedAuth::Key(prepared))
        }
        AuthMethod::Password(password) => Ok(PreparedAuth::Password(Arc::new(password.clone()))),
        AuthMethod::Agent => Ok(PreparedAuth::Agent),
    }
}

/// Production preparation transfers password ownership without a second copy.
/// Key passphrases are released as soon as this bounded worker finishes.
pub(crate) fn prepare_auth_owned(method: AuthMethod) -> Result<PreparedAuth, AuthError> {
    match method {
        AuthMethod::Password(password) => Ok(PreparedAuth::Password(Arc::new(password))),
        method => prepare_auth(&method),
    }
}

/// Prepare both sequential connections before either opens TCP. File loading
/// and decoding happen once; both RSA preparations finish here, before hash
/// negotiation. The password buffer is moved into one attempt-local owner and
/// borrowed by each authentication until the last prepared value is dropped.
pub(crate) fn prepare_auth_pair_owned(
    method: AuthMethod,
) -> Result<(PreparedAuth, PreparedAuth), AuthError> {
    prepare_auth_pair_with_loader(method, load_key)
}

fn prepare_auth_pair_with_loader(
    method: AuthMethod,
    load: impl FnOnce(&Path, Option<&str>) -> Result<PrivateKey, AuthError>,
) -> Result<(PreparedAuth, PreparedAuth), AuthError> {
    match method {
        AuthMethod::Key { path, passphrase } => {
            let key = load(&path, passphrase.as_ref().map(|value| value.as_str()))?;
            drop(passphrase);
            let (first, second) = match key.key_data() {
                KeypairData::Rsa(rsa) => (
                    PreparedKey::Rsa(Box::new(PreparedRsa::new(rsa, key.public_key().clone())?)),
                    PreparedKey::Rsa(Box::new(PreparedRsa::new(rsa, key.public_key().clone())?)),
                ),
                _ => {
                    let key = Arc::new(key);
                    (
                        PreparedKey::Other(Arc::clone(&key)),
                        PreparedKey::Other(key),
                    )
                }
            };
            Ok((PreparedAuth::Key(first), PreparedAuth::Key(second)))
        }
        AuthMethod::Password(password) => {
            let password = Arc::new(password);
            Ok((
                PreparedAuth::Password(Arc::clone(&password)),
                PreparedAuth::Password(password),
            ))
        }
        AuthMethod::Agent => Ok((PreparedAuth::Agent, PreparedAuth::Agent)),
    }
}

/// Only accepts credentials prepared before connect; there is no second,
/// late-loading RSA authentication entry point.
pub(crate) async fn authenticate_prepared<H: client::Handler>(
    handle: &mut Handle<H>,
    user: &str,
    method: PreparedAuth,
) -> Result<(), AuthError> {
    match method {
        PreparedAuth::Key(key) => {
            let result = match key {
                PreparedKey::Rsa(key) => {
                    let hash = choose_rsa_hash(handle.best_supported_rsa_hash().await);
                    let mut signer = key.into_signer(hash)?;
                    handle
                        .authenticate_publickey_with(
                            user,
                            signer.public_key().clone(),
                            hash,
                            &mut signer,
                        )
                        .await
                        .map_err(AuthError::from)?
                }
                PreparedKey::Other(key) => {
                    // Keep this boundary fail-closed even if a future caller
                    // constructs the wrong prepared variant inside the crate.
                    if key.algorithm().is_rsa() {
                        return Err(AuthError::SigningFailed);
                    }
                    handle
                        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(key, None))
                        .await
                        .map_err(|_| AuthError::HostUnreachable)?
                }
            };
            match result {
                russh::client::AuthResult::Success => Ok(()),
                russh::client::AuthResult::Failure {
                    partial_success, ..
                } => Err(classify_publickey_failure(partial_success, "publickey")),
            }
        }
        PreparedAuth::Password(pw) => {
            let r = handle
                .authenticate_password(user, pw.as_str())
                .await
                .map_err(|_| AuthError::HostUnreachable)?;
            match r {
                russh::client::AuthResult::Success => Ok(()),
                russh::client::AuthResult::Failure {
                    remaining_methods,
                    partial_success,
                } => Err(classify_password_failure(
                    &remaining_methods,
                    partial_success,
                )),
            }
        }
        PreparedAuth::Agent => {
            let agent = connect_agent().await?;
            authenticate_with_agent(handle, user, agent).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const ENCRYPTED_PKCS8: &str =
        include_str!("../../tests/fixtures/rsa-signing/russh-rsa-pkcs8-encrypted.pem");
    const PLAIN_PKCS8: &str = include_str!("../../tests/fixtures/rsa-signing/rsa2048-pkcs8.pem");

    struct AuthPairFixture(PathBuf);

    impl AuthPairFixture {
        fn new(source: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "aidevbridge-auth-pair-public-fixture-{}.key",
                rand::random::<u64>()
            ));
            std::fs::write(&path, source).unwrap();
            Self(path)
        }

        fn method(&self, passphrase: Option<&str>) -> AuthMethod {
            AuthMethod::Key {
                path: self.0.clone(),
                passphrase: passphrase.map(|value| Zeroizing::new(value.to_owned())),
            }
        }
    }

    impl Drop for AuthPairFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn auth_pair_loads_and_decodes_once_then_shares_non_rsa_owner() {
        let fixture = AuthPairFixture::new(ED25519_AESCTR_KEY);
        let mut loads = 0;
        let pair = prepare_auth_pair_with_loader(fixture.method(Some("test")), |path, phrase| {
            loads += 1;
            assert_eq!(phrase, Some("test"));
            let key = load_key(path, phrase)?;
            // Neither preparation may read/decode this replacement. The same
            // loader boundary is used by the consuming production entry point.
            std::fs::write(path, "changed synthetic file after first decode").unwrap();
            Ok(key)
        })
        .unwrap();
        assert_eq!(loads, 1);
        let (
            PreparedAuth::Key(PreparedKey::Other(first)),
            PreparedAuth::Key(PreparedKey::Other(second)),
        ) = pair
        else {
            panic!("fixture must prepare two non-RSA authentications")
        };
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(Arc::strong_count(&first), 2);
        let lifetime = Arc::downgrade(&first);
        drop(first);
        assert_eq!(lifetime.strong_count(), 1);
        assert!(!second.algorithm().is_rsa());
        drop(second);
        assert!(lifetime.upgrade().is_none());
        assert!(matches!(
            prepare_auth_pair_owned(fixture.method(Some("test"))),
            Err(AuthError::KeyUnreadable(_))
        ));
    }

    #[test]
    fn auth_pair_password_moves_one_buffer_and_releases_after_last_owner() {
        for reverse_drop_order in [false, true] {
            let password = Zeroizing::new("synthetic-pair-password".to_owned());
            let storage = password.as_ptr();
            let (PreparedAuth::Password(first), PreparedAuth::Password(second)) =
                prepare_auth_pair_owned(AuthMethod::Password(password)).unwrap()
            else {
                panic!("password pair")
            };
            assert!(Arc::ptr_eq(&first, &second));
            assert_eq!(
                first.as_ptr(),
                storage,
                "owned preparation must not clone plaintext"
            );
            assert_eq!(second.as_ptr(), storage);
            assert_eq!(Arc::strong_count(&first), 2);
            let lifetime = Arc::downgrade(&first);
            let (first, second) = if reverse_drop_order {
                (second, first)
            } else {
                (first, second)
            };
            drop(first);
            assert_eq!(lifetime.strong_count(), 1);
            assert_eq!(second.as_str(), "synthetic-pair-password");
            drop(second);
            assert!(lifetime.upgrade().is_none(), "last owner drops Zeroizing");
        }
    }

    #[test]
    fn auth_pair_agent_prepares_two_independent_agent_attempts() {
        assert!(matches!(
            prepare_auth_pair_owned(AuthMethod::Agent),
            Ok((PreparedAuth::Agent, PreparedAuth::Agent))
        ));
    }

    #[test]
    fn auth_pair_preserves_encrypted_pkcs8_and_file_error_classes() {
        let fixture = AuthPairFixture::new(ENCRYPTED_PKCS8);
        assert!(matches!(
            prepare_auth_pair_owned(fixture.method(None)),
            Err(AuthError::PassphraseRequired)
        ));
        assert!(matches!(
            prepare_auth_pair_owned(fixture.method(Some("wrong"))),
            Err(AuthError::PassphraseWrong)
        ));
        assert!(matches!(
            prepare_auth_pair_owned(fixture.method(Some("blabla"))),
            Ok((
                PreparedAuth::Key(PreparedKey::Rsa(_)),
                PreparedAuth::Key(PreparedKey::Rsa(_))
            ))
        ));
        std::fs::remove_file(&fixture.0).unwrap();
        assert!(matches!(
            prepare_auth_pair_owned(fixture.method(Some("blabla"))),
            Err(AuthError::KeyUnreadable(_))
        ));
    }

    #[test]
    fn auth_single_password_preparation_remains_compatible() {
        let password = Zeroizing::new("synthetic-single-password".to_owned());
        let storage = password.as_ptr();
        let PreparedAuth::Password(prepared) =
            prepare_auth_owned(AuthMethod::Password(password)).unwrap()
        else {
            panic!("owned password")
        };
        assert_eq!(prepared.as_ptr(), storage);
        assert_eq!(Arc::strong_count(&prepared), 1);
        let method = AuthMethod::Password(Zeroizing::new("synthetic-borrowed-password".to_owned()));
        let PreparedAuth::Password(borrowed) = prepare_auth(&method).unwrap() else {
            panic!("borrowed password")
        };
        assert_eq!(borrowed.as_str(), "synthetic-borrowed-password");
        drop(borrowed);
        let AuthMethod::Password(original) = method else {
            unreachable!()
        };
        assert_eq!(original.as_str(), "synthetic-borrowed-password");
    }

    #[test]
    fn pkcs8_missing_passphrase_requests_dialog_for_valid_envelope() {
        let unwrapped_body: String = ENCRYPTED_PKCS8
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        for source in [
            ENCRYPTED_PKCS8.to_string(),
            format!("exported public test fixture\n{ENCRYPTED_PKCS8}\n\n"),
            ENCRYPTED_PKCS8.replace('\n', "\r\n"),
            format!("-----BEGIN ENCRYPTED PRIVATE KEY-----\n{unwrapped_body}\n-----END ENCRYPTED PRIVATE KEY-----"),
        ] {
            assert!(matches!(
                decode_key_source(&source, None),
                Err(AuthError::PassphraseRequired)
            ));
        }
    }

    #[test]
    fn pkcs8_supplied_passphrase_uses_existing_decoder() {
        assert!(decode_key_source(ENCRYPTED_PKCS8, Some("blabla")).is_ok());
        for password in ["wrong", ""] {
            assert!(matches!(
                decode_key_source(ENCRYPTED_PKCS8, Some(password)),
                Err(AuthError::PassphraseWrong)
            ));
        }
    }

    #[test]
    fn pkcs8_malformed_or_empty_envelopes_do_not_request_passphrase() {
        use rsa::pkcs8::{der::asn1::OctetStringRef, EncryptedPrivateKeyInfoRef, SecretDocument};
        let (_, document) = SecretDocument::from_pem(ENCRYPTED_PKCS8).unwrap();
        let mut info = document
            .decode_msg::<EncryptedPrivateKeyInfoRef<'_>>()
            .unwrap();
        info.encrypted_data = OctetStringRef::new(&[]).unwrap();
        let empty = SecretDocument::encode_msg(&info)
            .unwrap()
            .to_pem("ENCRYPTED PRIVATE KEY", rsa::pkcs8::LineEnding::LF)
            .unwrap();
        for source in [
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\n-----END ENCRYPTED PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\n%%%\n-----END ENCRYPTED PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMAA=\n-----END ENCRYPTED PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            empty.as_str(),
        ] {
            assert!(matches!(
                decode_key_source(source, None),
                Err(AuthError::KeyUnreadable(_))
            ));
        }
    }

    #[test]
    fn pkcs8_header_detection_is_bound_to_the_valid_envelope() {
        for header in [
            "PRIVATE KEY",
            "RSA PRIVATE KEY",
            "EC PRIVATE KEY",
            "CERTIFICATE",
        ] {
            let source = ENCRYPTED_PKCS8.replace("ENCRYPTED PRIVATE KEY", header);
            assert!(matches!(
                decode_key_source(&source, None),
                Err(AuthError::KeyUnreadable(_))
            ));
        }
        // A label alone does not prove encryption; preserve russh's ability
        // to decode plaintext DER even under this mislabeled PEM envelope.
        let mislabeled = PLAIN_PKCS8.replace("PRIVATE KEY", "ENCRYPTED PRIVATE KEY");
        assert!(decode_key_source(&mislabeled, None).is_ok());
        assert!(decode_key_source(PLAIN_PKCS8, None).is_ok());
        let mixed = format!("{PLAIN_PKCS8}\n{ENCRYPTED_PKCS8}");
        assert!(
            decode_key_source(&mixed, None).is_ok(),
            "first key keeps decoder precedence"
        );
        let comment = format!("# -----BEGIN ENCRYPTED PRIVATE KEY-----\n{PLAIN_PKCS8}");
        assert!(decode_key_source(&comment, None).is_ok());
        let ppk = include_str!("../../tests/fixtures/rsa-signing/rsa3072-putty-v3.ppk");
        assert!(!is_encrypted_pkcs8(&format!("{ppk}\n{ENCRYPTED_PKCS8}")));
    }

    // --- server-sig-algs -> Hash-Algorithmus fuer RSA.
    // `hash_alg = None` bildet jeden RSA-Schluessel auf `ssh-rsa`/SHA-1 ab,
    // das OpenSSH ab 8.8 ablehnt (VM 192.0.2.20 laeuft OpenSSH 9.6).

    #[test]
    fn choose_rsa_hash_falls_back_to_sha256_when_server_says_nothing() {
        use russh::keys::HashAlg;
        assert_eq!(choose_rsa_hash(Ok(None)), Some(HashAlg::Sha256));
        assert_eq!(choose_rsa_hash(Ok(Some(None))), None); // Server kann nur ssh-rsa
        assert_eq!(
            choose_rsa_hash(Ok(Some(Some(HashAlg::Sha512)))),
            Some(HashAlg::Sha512)
        );
        assert_eq!(
            choose_rsa_hash(Err(russh::Error::SendError)),
            Some(HashAlg::Sha256)
        );
    }

    #[test]
    fn passphrase_protected_key_reports_passphrase_required() {
        // Ein Schluessel-Header ohne entschluesselbaren Body
        let err = classify_key_error("PEM error: encrypted private key");
        assert!(matches!(err, AuthError::PassphraseRequired));
    }

    #[test]
    fn wrong_passphrase_is_distinct_from_missing_one() {
        let err = classify_key_error("PEM error: decryption failed");
        assert!(matches!(err, AuthError::PassphraseWrong));
    }

    #[test]
    fn unreadable_file_keeps_the_original_reason() {
        let err = classify_key_error("No such file or directory (os error 2)");
        match err {
            AuthError::KeyUnreadable(msg) => assert!(msg.contains("os error 2")),
            other => panic!("falsche Variante: {other:?}"),
        }
    }

    #[test]
    fn every_variant_has_a_distinct_user_message() {
        use std::collections::HashSet;
        let msgs: HashSet<String> = [
            AuthError::HostUnreachable,
            AuthError::KeyUnreadable("x".into()),
            AuthError::PassphraseRequired,
            AuthError::PassphraseWrong,
            AuthError::PasswordWrong,
            AuthError::AgentUnavailable("x".into()),
            AuthError::AgentNoIdentities("x".into()),
            AuthError::MethodNotOffered("x".into()),
            AuthError::MultiFactorRequired("x".into()),
            AuthError::SigningFailed,
        ]
        .iter()
        .map(|e| e.user_message().to_string())
        .collect();
        assert_eq!(
            msgs.len(),
            10,
            "Meldungen muessen unterscheidbar sein (Spec §7.5)"
        );
    }

    /// Ergaenzung zum Test der unterscheidbaren Varianten oben: dieselben
    /// Meldungen, aber so, wie die Erzeuger sie tatsaechlich bauen
    /// (`agent_has_no_identities_error`, `classify_password_failure` mit
    /// `partial_success`) statt mit dem Platzhaltertext "x". Faellt auf, wenn
    /// ein Erzeuger die falsche Variante waehlt und dadurch z. B. die
    /// ssh-add-Meldung mit der generischen Agent-Meldung zusammenfaellt.
    #[test]
    fn reachable_user_messages_are_pairwise_distinct() {
        use std::collections::HashSet;
        let mut remaining_with_publickey = russh::MethodSet::empty();
        remaining_with_publickey.push(russh::MethodKind::PublicKey);
        let msgs: HashSet<&'static str> = [
            AuthError::HostUnreachable.user_message(),
            AuthError::KeyUnreadable("x".into()).user_message(),
            AuthError::PassphraseRequired.user_message(),
            AuthError::PassphraseWrong.user_message(),
            AuthError::PasswordWrong.user_message(),
            AuthError::SigningFailed.user_message(),
            AuthError::AgentUnavailable("connection refused".into()).user_message(),
            agent_has_no_identities_error().user_message(),
            AuthError::MethodNotOffered("publickey".into()).user_message(),
            classify_password_failure(&remaining_with_publickey, true).user_message(),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            msgs.len(),
            10,
            "alle erreichbaren Meldungen muessen unterscheidbar sein"
        );
    }

    // --- Hermetische Belege fuer die echten Fehlertexte (siehe Doc-Kommentar
    // von `classify_key_error`): echte russh-Schluessel-Fixturen statt
    // erfundener Strings. Beide Konstanten stammen woertlich aus
    // russh-0.62.4/src/keys/mod.rs (dortiges Testmodul), Passwort jeweils im
    // Kommentar dokumentiert. Kein Netzwerk, keine VM, kein temporaeres
    // Schluesseldateien-Anlegen noetig -- `decode_secret_key` nimmt den PEM-Text
    // direkt entgegen.

    /// aes256-cbc, Passwort "blabla" (aus russh-Testsuite uebernommen).
    const ED25519_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jYmMAAAAGYmNyeXB0AAAAGAAAABDLGyfA39
J2FcJygtYqi5ISAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIN+Wjn4+4Fcvl2Jl
KpggT+wCRxpSvtqqpVrQrKN1/A22AAAAkOHDLnYZvYS6H9Q3S3Nk4ri3R2jAZlQlBbUos5
FkHpYgNw65KCWCTXtP7ye2czMC3zjn2r98pJLobsLYQgRiHIv/CUdAdsqbvMPECB+wl/UQ
e+JpiSq66Z6GIt0801skPh20jxOO3F52SoX1IeO5D5PXfZrfSZlw6S8c7bwyp2FHxDewRx
7/wNsnDM0T7nLv/Q==
-----END OPENSSH PRIVATE KEY-----";

    /// aes256-ctr (nicht-AEAD, checkint-basierte Passwort-Pruefung),
    /// Passwort "test" (aus russh-Testsuite uebernommen).
    const ED25519_AESCTR_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD1phlku5
A2G7Q9iP+DcOc9AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHeLC1lWiCYrXsf/
85O/pkbUFZ6OGIt49PX3nw8iRoXEAAAAkKRF0st5ZI7xxo9g6A4m4l6NarkQre3mycqNXQ
dP3jryYgvsCIBAA5jMWSjrmnOTXhidqcOy4xYCrAttzSnZ/cUadfBenL+DQq6neffw7j8r
0tbCxVGp6yCQlKrgSZf6c0Hy7dNEIU2bJFGxLe6/kWChcUAt/5Ll5rI7DVQPJdLgehLzvv
sJWR7W+cGvJ/vLsw==
-----END OPENSSH PRIVATE KEY-----";

    #[test]
    fn real_encrypted_key_without_password_yields_passphrase_required() {
        let err = russh::keys::decode_secret_key(ED25519_KEY, None).unwrap_err();
        let classified = classify_key_error(&err.to_string());
        assert!(
            matches!(classified, AuthError::PassphraseRequired),
            "echte russh-Fehlermeldung war {:?}, klassifiziert als {classified:?}",
            err.to_string()
        );
    }

    #[test]
    fn real_encrypted_key_with_wrong_password_yields_passphrase_wrong() {
        // aes256-ctr: checkint-Vergleich schlaegt bei falschem Passwort fehl,
        // die Fehlermeldung enthaelt "cryptographic error", NICHT
        // "decryption failed" oder "mac" (siehe Doc-Kommentar oben).
        let err = russh::keys::decode_secret_key(ED25519_AESCTR_KEY, Some("definitely-wrong"))
            .unwrap_err();
        let msg = err.to_string();
        let classified = classify_key_error(&msg);
        assert!(
            matches!(classified, AuthError::PassphraseWrong),
            "echte russh-Fehlermeldung war {msg:?}, klassifiziert als {classified:?}"
        );
    }

    #[test]
    fn real_key_with_correct_password_decodes() {
        // Gegenprobe zum vorigen Test: richtiges Passwort funktioniert,
        // die Fixtur ist also tatsaechlich das, was sie zu sein behauptet.
        assert!(russh::keys::decode_secret_key(ED25519_AESCTR_KEY, Some("test")).is_ok());
        assert!(russh::keys::decode_secret_key(ED25519_KEY, Some("blabla")).is_ok());
    }

    // --- Passwort-Zweig: Unit-Tests gegen die Fehlerklassifikation statt
    // gegen die echte VM. `AuthResult` und `MethodSet` sind von aussen
    // konstruierbar (russh::client::AuthResult re-exportiert
    // crate::auth::AuthResult, siehe russh-0.62.4/src/client/mod.rs:60),
    // deshalb ohne Netzwerkverbindung testbar.

    #[test]
    fn password_wrong_when_server_still_offers_password_auth() {
        let mut remaining = russh::MethodSet::empty();
        remaining.push(russh::MethodKind::Password);
        assert!(matches!(
            classify_password_failure(&remaining, false),
            AuthError::PasswordWrong
        ));
    }

    #[test]
    fn password_not_offered_when_server_drops_it_from_remaining_methods() {
        // Server bietet laut Antwort nur noch publickey an -- Passwort-Auth
        // war fuer diesen Account nie eine Option (z. B.
        // `PasswordAuthentication no`). Das Passwort wurde nie geprueft,
        // "falsches Passwort" waere hier die falsche Meldung.
        let mut remaining = russh::MethodSet::empty();
        remaining.push(russh::MethodKind::PublicKey);
        match classify_password_failure(&remaining, false) {
            AuthError::MethodNotOffered(m) => assert_eq!(m, "password"),
            other => panic!("falsche Variante: {other:?}"),
        }
    }

    // --- partial_success in allen drei Auth-Zweigen. Ein korrektes
    // Passwort/Schluessel/Agent-Key bei serverseitig erzwungener
    // Mehrfaktor-Authentifizierung (`AuthenticationMethods
    // publickey,password`) liefert `AuthResult::Failure { partial_success:
    // true, .. }` -- ohne die Pruefung unten waere das als
    // `MethodNotOffered` (Passwort-/Schluessel-Zweig identisch) oder
    // generisch als `PasswordWrong` fehlklassifiziert, obwohl der Faktor
    // akzeptiert wurde.

    #[test]
    fn password_partial_success_is_neither_wrong_password_nor_generic_not_offered() {
        // Server hat ein KORREKTES Passwort akzeptiert, verlangt aber noch
        // einen zweiten Faktor -- weder "falsches Passwort" (das Passwort
        // war korrekt) noch die generische "Server bietet das nicht an"
        // (er bietet es sehr wohl an und hat es akzeptiert) waere hier
        // ehrlich.
        let mut remaining = russh::MethodSet::empty();
        remaining.push(russh::MethodKind::PublicKey);
        let err = classify_password_failure(&remaining, true);
        assert!(
            matches!(err, AuthError::MultiFactorRequired(_)),
            "falsche Variante fuer partial_success: {err:?}"
        );
        assert_ne!(
            err.user_message(),
            AuthError::PasswordWrong.user_message(),
            "partial_success darf nicht als 'falsches Passwort' erscheinen"
        );
        assert_ne!(
            err.user_message(),
            AuthError::MethodNotOffered("password".into()).user_message(),
            "partial_success darf nicht mit der generischen 'nicht angeboten'-Meldung \
             verwechselt werden"
        );
    }

    #[test]
    fn publickey_partial_success_is_reported_as_multi_factor_required() {
        // Schluessel- und Agent-Weg teilen sich `classify_publickey_failure`.
        let err = classify_publickey_failure(true, "publickey");
        assert!(
            matches!(err, AuthError::MultiFactorRequired(_)),
            "falsche Variante fuer partial_success: {err:?}"
        );
        assert_ne!(
            err.user_message(),
            AuthError::MethodNotOffered("publickey".into()).user_message()
        );
    }

    /// Display- und Nutzertext der Mehrfaktor- und der Leerer-Agent-Meldung
    /// sind woertlich festgehalten: beide landen in Fehlerketten und beim
    /// Nutzer, und eine Umstellung der Fehlertypen darf keinen davon aendern.
    #[test]
    fn multi_factor_and_empty_agent_errors_keep_their_display_and_user_text() {
        let mut remaining = russh::MethodSet::empty();
        remaining.push(russh::MethodKind::PublicKey);
        let multi_factor = "This account requires more than one authentication factor (e.g. key + \
                            password). aidevbridge does not support multi-factor authentication in \
                            this version.";
        for (error, display) in [
            (
                classify_password_failure(&remaining, true),
                "method not offered: partial-success: password was accepted by the server, but \
                 it requires an additional authentication factor (multi-factor authentication \
                 is not supported)",
            ),
            (
                classify_publickey_failure(true, "publickey"),
                "method not offered: partial-success: publickey was accepted by the server, but \
                 it requires an additional authentication factor (multi-factor authentication \
                 is not supported)",
            ),
            (
                partial_success_error("publickey (agent)"),
                "method not offered: partial-success: publickey (agent) was accepted by the \
                 server, but it requires an additional authentication factor (multi-factor \
                 authentication is not supported)",
            ),
        ] {
            assert_eq!(error.to_string(), display);
            assert_eq!(error.user_message(), multi_factor);
        }
        let empty_agent = agent_has_no_identities_error();
        assert_eq!(
            empty_agent.to_string(),
            "agent unavailable: no identities loaded: agent is reachable but has no identities \
             loaded"
        );
        assert_eq!(
            empty_agent.user_message(),
            "ssh-agent is reachable but has no keys loaded. Add one with: ssh-add"
        );
    }

    #[test]
    fn publickey_failure_without_partial_success_stays_generic_method_not_offered() {
        // Gegenprobe zum vorigen Test: ohne partial_success bleibt es beim
        // generischen Verhalten.
        let err = classify_publickey_failure(false, "publickey");
        match err {
            AuthError::MethodNotOffered(detail) => assert_eq!(detail, "publickey"),
            other => panic!("falsche Variante: {other:?}"),
        }
    }

    #[test]
    fn auth_method_debug_does_not_leak_passphrase_or_password() {
        let with_passphrase = AuthMethod::Key {
            path: PathBuf::from("/home/x/.ssh/id_ed25519"),
            passphrase: Some(Zeroizing::new("super-secret-passphrase".to_string())),
        };
        let dbg = format!("{with_passphrase:?}");
        assert!(
            !dbg.contains("super-secret-passphrase"),
            "Debug-Ausgabe: {dbg}"
        );

        let pw = AuthMethod::Password(Zeroizing::new("super-secret-password".to_string()));
        let dbg = format!("{pw:?}");
        assert!(
            !dbg.contains("super-secret-password"),
            "Debug-Ausgabe: {dbg}"
        );
    }

    // --- "Agent nicht erreichbar" und "Agent erreichbar, aber keine
    // Identitaeten geladen" muessen unterscheidbare Meldungen liefern -- die
    // erste raet zum Dienst-Neustart, die zweite zu `ssh-add`. Vertauscht
    // waeren beide Ratschlaege falsch.

    #[test]
    fn agent_unreachable_is_distinct_from_agent_reachable_without_identities() {
        let unreachable = AuthError::AgentUnavailable("connection refused".into());
        let no_identities = agent_has_no_identities_error();
        assert!(
            matches!(no_identities, AuthError::AgentNoIdentities(_)),
            "{no_identities:?}"
        );
        assert_ne!(
            unreachable.user_message(),
            no_identities.user_message(),
            "'Agent nicht erreichbar' und 'Agent ohne Identitaeten' duerfen nicht dieselbe \
             Meldung liefern"
        );
        assert!(
            unreachable
                .user_message()
                .to_ascii_lowercase()
                .contains("start-service"),
            "'Agent nicht erreichbar' muss zum Dienst-Neustart raten: {}",
            unreachable.user_message()
        );
        assert!(
            no_identities
                .user_message()
                .to_ascii_lowercase()
                .contains("ssh-add"),
            "'Agent ohne Identitaeten' muss zu ssh-add raten: {}",
            no_identities.user_message()
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn agent_unavailable_when_pipe_does_not_exist() {
        // Testet deterministisch die Windows-11-Standardsituation ("Dienst
        // aus"), unabhaengig davon, ob auf der Build-Maschine zufaellig ein
        // echter ssh-agent-Dienst laeuft: ein frei erfundener Pipe-Name
        // existiert garantiert nicht. `connect_named_pipe` haengt dabei laut
        // Quellstudium nicht (nur `ERROR_PIPE_BUSY` fuehrt zum Retry-Loop,
        // `NotFound` bricht sofort ab) -- der Timeout ist trotzdem als Netz
        // vorhanden, falls diese Annahme je nicht mehr stimmt.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connect_agent_at(r"\\.\pipe\aidevbridge-nonexistent-test-pipe"),
        )
        .await
        .expect("connect_agent_at ist haengengeblieben statt sofort NotFound zu melden");
        assert!(matches!(result, Err(AuthError::AgentUnavailable(_))));
    }

    /// Unix-Pendant zu `agent_unavailable_when_pipe_does_not_exist` oben: der
    /// `#[cfg(unix)]`-Zweig laeuft auf einer Windows-Entwicklungsmaschine
    /// durch keinen Compiler -- dieser Test gibt dem Pfad wenigstens EINEN
    /// Test, den die Ubuntu-CI tatsaechlich ausfuehrt (auf Windows ist er per
    /// `cfg(unix)` komplett abwesend; den Linux-Uebersetzungsnachweis liefert
    /// ein separates `cargo check`).
    #[cfg(unix)]
    #[tokio::test]
    async fn agent_unavailable_when_socket_does_not_exist() {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connect_agent_at("/tmp/aidevbridge-nonexistent-test-socket-xyz"),
        )
        .await
        .expect("connect_agent_at ist haengengeblieben statt sofort einen Fehler zu melden");
        assert!(matches!(result, Err(AuthError::AgentUnavailable(_))));
    }

    #[test]
    fn agent_sign_error_separates_a_lost_session_from_a_refused_signature() {
        assert!(matches!(
            agent_sign_error(russh::AgentAuthError::Send(russh::SendError {})),
            AuthError::HostUnreachable
        ));
        for agent_error in [
            russh::keys::Error::AgentFailure,
            russh::keys::Error::AgentProtocolError,
            russh::keys::Error::IO(std::io::ErrorKind::UnexpectedEof.into()),
        ] {
            assert!(matches!(
                agent_sign_error(russh::AgentAuthError::Key(agent_error)),
                AuthError::SigningFailed
            ));
        }
    }

    // --- Agent-Weg gegen einen echten russh-Server im Prozess. Server und
    // Agent haengen an `tokio::io::duplex`, damit der Test ohne Socket, Pipe
    // oder echten ssh-agent auch in der Windows-CI laeuft.

    struct AnyHostKey;

    impl russh::client::Handler for AnyHostKey {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _: &russh::keys::PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    /// Bietet jeden Schluessel per PK_OK an, sodass der Client wirklich
    /// signieren muss; eine Signatur nimmt er nie an.
    struct OfferingServer {
        offered: Arc<AtomicUsize>,
    }

    impl russh::server::Handler for OfferingServer {
        type Error = russh::Error;
        async fn auth_publickey_offered(
            &mut self,
            _: &str,
            _: &russh::keys::PublicKey,
        ) -> Result<russh::server::Auth, Self::Error> {
            self.offered.fetch_add(1, Ordering::SeqCst);
            Ok(russh::server::Auth::Accept)
        }
        async fn auth_publickey(
            &mut self,
            _: &str,
            _: &russh::keys::PublicKey,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::reject())
        }
    }

    /// Minimaler ssh-agent nach draft-miller-ssh-agent: listet die
    /// uebergebenen Identitaeten und lehnt jede Signatur mit
    /// SSH_AGENT_FAILURE ab, wie nach einer abgelehnten `ssh-add -c`-Rueckfrage
    /// oder einem FIDO-Schluessel ohne Beruehrung.
    async fn refusing_agent(
        mut io: tokio::io::DuplexStream,
        identities: Vec<Vec<u8>>,
        sign_requests: Arc<AtomicUsize>,
    ) -> std::io::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        const FAILURE: u8 = 5;
        const REQUEST_IDENTITIES: u8 = 11;
        const IDENTITIES_ANSWER: u8 = 12;
        const SIGN_REQUEST: u8 = 13;
        fn put_string(out: &mut Vec<u8>, value: &[u8]) {
            out.extend_from_slice(&(value.len() as u32).to_be_bytes());
            out.extend_from_slice(value);
        }
        loop {
            let mut length = [0u8; 4];
            if io.read_exact(&mut length).await.is_err() {
                // Der Client hat seine Seite geschlossen.
                return Ok(());
            }
            let mut request = vec![0u8; u32::from_be_bytes(length) as usize];
            io.read_exact(&mut request).await?;
            let mut answer = Vec::new();
            match request.first() {
                Some(&REQUEST_IDENTITIES) => {
                    answer.push(IDENTITIES_ANSWER);
                    answer.extend_from_slice(&(identities.len() as u32).to_be_bytes());
                    for blob in &identities {
                        put_string(&mut answer, blob);
                        put_string(&mut answer, b"refusing-agent-fixture");
                    }
                }
                Some(&SIGN_REQUEST) => {
                    sign_requests.fetch_add(1, Ordering::SeqCst);
                    answer.push(FAILURE);
                }
                _ => answer.push(FAILURE),
            }
            io.write_all(&(answer.len() as u32).to_be_bytes()).await?;
            io.write_all(&answer).await?;
            io.flush().await?;
        }
    }

    #[tokio::test]
    async fn agent_refused_signature_is_a_signing_failure_and_ends_the_identity_loop() {
        use std::time::Duration;

        let host_key = russh::keys::decode_secret_key(PLAIN_PKCS8, None).unwrap();
        // Zwei Identitaeten: nach der abgelehnten ersten darf die zweite
        // nicht mehr versucht werden.
        let identities = [(ED25519_AESCTR_KEY, "test"), (ED25519_KEY, "blabla")]
            .into_iter()
            .map(|(source, password)| {
                russh::keys::decode_secret_key(source, Some(password))
                    .unwrap()
                    .public_key()
                    .to_bytes()
                    .unwrap()
            })
            .collect();
        let offered = Arc::new(AtomicUsize::new(0));
        let sign_requests = Arc::new(AtomicUsize::new(0));
        let server_config = Arc::new(russh::server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            inactivity_timeout: None,
            ..Default::default()
        });
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let handler = OfferingServer {
            offered: offered.clone(),
        };
        let mut server = tokio::spawn(async move {
            russh::server::run_stream(server_config, server_io, handler)
                .await?
                .await
        });
        let (agent_io, agent_peer) = tokio::io::duplex(64 * 1024);
        let agent = tokio::spawn(refusing_agent(
            agent_peer,
            identities,
            sign_requests.clone(),
        ));

        let mut client = tokio::time::timeout(
            Duration::from_secs(10),
            russh::client::connect_stream(Default::default(), client_io, AnyHostKey),
        )
        .await
        .expect("hermetic handshake deadline")
        .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            authenticate_with_agent(
                &mut client,
                "fixture-user",
                russh::keys::agent::client::AgentClient::connect(agent_io),
            ),
        )
        .await
        .expect("a refused agent signature must end the attempt promptly");

        assert!(
            matches!(result, Err(AuthError::SigningFailed)),
            "refused agent signature classified as {result:?}"
        );
        assert_eq!(offered.load(Ordering::SeqCst), 1, "only the first identity");
        assert_eq!(sign_requests.load(Ordering::SeqCst), 1);

        // Erst das Ende des Handles loest die Session aus dem Warten auf die
        // Signatur; danach muss auch der Server das Ende sehen.
        drop(client);
        let ended = tokio::time::timeout(Duration::from_secs(3), &mut server).await;
        if ended.is_err() {
            server.abort();
            panic!("server session remained open after the client handle was dropped");
        }
        ended.unwrap().expect("server task must not panic").ok();
        tokio::time::timeout(Duration::from_secs(3), agent)
            .await
            .expect("fake agent must see the closed client side")
            .expect("fake agent task must not panic")
            .unwrap();
    }
}
