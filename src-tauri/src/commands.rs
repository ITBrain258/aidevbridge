//! Tauri-Commands und die Byte-Bruecke zum WebView (Task 10).
//!
//! Sicherheitsmodell (Spec §8.3): der WebView bekommt ausschliesslich diese
//! semantischen Commands -- kein `ssh_exec(cmd)`, keine rohe Kommandozeile.
//! Jede entfernte Kommandozeile entsteht weiterhin ausschliesslich ueber
//! `remote::build`, hier indirekt ueber `TmuxClient` und `Transport::exec`.
//!
//! Jeder `#[tauri::command]` ist bewusst eine duenne Huelle: Sie entpackt
//! `State`/`AppHandle` und ruft eine gleichnamige `_impl`-Funktion, die nur
//! noch `&Arc<AppState>` (und ggf. einen `OutputSink`) kennt -- kein
//! Tauri-Typ mehr. Integrationstests rufen diese `_impl`-Funktionen direkt
//! auf, ohne eine laufende Tauri-Anwendung zu brauchen (siehe
//! `tests/integration_commands.rs`). Nur die Huelle selbst (Auspacken von
//! `State`, Weiterreichen) bleibt automatisiert ungetestet.

use crate::connection::{
    CommandTransport, ConnectionEvents, ControlStateEvent, HostConnection, PairIdentityRejected,
    TerminalTransportLostEvent, COMMAND_TIMEOUT,
};
use crate::settings::{self, AuthKind, HostEntry};
use crate::ssh::known_hosts::{self, HostKeyDecision};
use crate::ssh::{AuthError, AuthMethod};
use crate::tmux::attach_confirmation::{
    absolute_probe, named_probe, parse_clients, process_command, registered_with_process,
    registration_ready, verify_process, SocketBinding,
};
use crate::tmux::inventory::{
    InventoryOutcome, MeasuredVersion, PaneId, ServerIdentity, SessionId, WindowId,
};
use crate::tmux::session_binding::PaneIdentity;
use crate::tmux::{
    CreateOutcome, OwnSocket, OwnTmuxClient, ServerAbsent, SocketKind, TmuxClient, TmuxSocket,
    DEFAULT_SOCKET_NAME,
};
use crate::transport::connect_control::{
    ConnectControl, ConnectError as ConnectFailure, ConnectLimits,
};
use crate::transport::operation_control::{ExecError, ExecReason, OperationControl};
use crate::transport::{HostKeyPolicy, HostSpec, PtyHandle, Transport};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
#[cfg(test)]
use tokio::sync::mpsc;
use tokio::sync::{oneshot, Notify};

/// Spec §5.1: "bis zu fuenf Versuche, danach Fehler."
const MAX_NAME_ATTEMPTS: u32 = 5;

/// Wie lange `TofuPolicy::decide` auf eine Antwort aus `respond_host_key`
/// wartet, bevor ein unbeantworteter Host-Key als abgelehnt gilt
/// (TOFU-Nachtrag, Task 13, Eigenschaft 2). 60 Sekunden: waehrend `decide`
/// blockiert, haengt der SSH-Handshake selbst noch VOR der Authentifizierung
/// (`check_server_key` laeuft vor `authenticate`, siehe
/// `RusshTransport::connect`) -- OpenSSHs serverseitiges `LoginGraceTime`
/// (Standard 120s) trennt eine solche Verbindung von sich aus, wenn der
/// gesamte Handshake laenger dauert. 60s laesst reichlich Vorlauf, damit ein
/// Nutzer, der genau an dieser Schwelle zustimmt, nicht einen akzeptierten
/// Schluessel bei bereits toter Verbindung bekommt.
const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);

const MAX_CONNECT_ATTEMPTS: usize = 32;

enum HostSlot {
    Pending {
        control: ConnectControl,
        expiry: oneshot::Sender<()>,
    },
    Building {
        control: ConnectControl,
        _expiry: oneshot::Sender<()>,
    },
    Ready(Arc<HostConnection>),
}

impl HostSlot {
    fn ready(&self) -> Option<Arc<HostConnection>> {
        match self {
            Self::Ready(transport) => Some(transport.clone()),
            _ => None,
        }
    }

    fn control(&self) -> Option<&ConnectControl> {
        match self {
            Self::Pending { control, .. } | Self::Building { control, .. } => Some(control),
            Self::Ready(_) => None,
        }
    }
}

struct PendingHostKey {
    sender: oneshot::Sender<bool>,
    control: ConnectControl,
    deadline: tokio::time::Instant,
}

/// Kredit-Fenster fuer die Ack-Rueckstaubremse (Spec §9.1), bewusst weit
/// unter xterm.js' DISCARD_WATERMARK von 50 MB (V31): Ziel ist, dass der
/// Renderer nie in die Naehe der Verwurfsgrenze kommt, nicht die Grenze
/// selbst auszureizen. 1 MiB erlaubt handelsuebliche Bursts (ein "voller"
/// SSH-Kanalpaket-Batch liegt weit darunter), ohne dass bei normalem Tempo
/// staendige Ack-Rundreisen noetig waeren.
///
/// `pub`, nicht nur crate-intern (Review-Befund, Minor): der Integrationstest
/// `ack_backpressure_actually_stalls_and_then_resumes` in
/// `tests/integration_commands.rs` bindet Flutgroesse UND Erwartungswert an
/// diese Konstante, statt feste Zahlen zu wiederholen -- aendert sich das
/// Fenster, wandert der Test automatisch mit, statt etwas anderes zu pruefen
/// als gemeint.
pub const ACK_WINDOW_BYTES: u64 = 1 << 20;

/// Wie lange die Pumpaufgabe auf Kredit wartet, bevor sie die Session als
/// stillstehend aufgibt (Design §2.4).
///
/// Der Wert ist eine CHARAKTERISIERUNG, keine Messung. Er feuert nur, wenn
/// UEBERHAUPT KEIN Ack ankommt, waehrend das Fenster voll ist -- ein
/// langsamer, aber fortschreitender Renderer setzt das Zeitlimit bei jeder
/// Schleifenrunde zurueck, weil `wait_for_room_cancel_or_stall` es pro
/// AUFRUF aufspannt (siehe
/// `wait_for_room_cancel_or_stall_budget_is_per_call_not_per_session`).
/// Bekannte legitime Verzoegerung: xterm.js' `setTimeout`-Verarbeitung,
/// Groessenordnung Millisekunden bis wenige Sekunden -- aus der
/// Bibliotheksarchitektur geschlossen, nicht gemessen. Feuert der Waechter
/// im manuellen Durchlauf ohne echten Stillstand, ist DIESE KONSTANTE zu
/// erhoehen, nicht der Waechter zu entfernen.
///
/// Untere Grenze (Review-Nachtrag): dieser Wert ist eine LEBENDE Uhr unter
/// `tests/integration_commands.rs` -- mehrere Tests dort fluten das
/// Ack-Fenster absichtlich und beobachten den Pumpzustand danach ueber
/// Fenster von 500 ms bis 10 s (z. B. `ack_backpressure_actually_stalls_
/// and_then_resumes`, `a_stalled_session_does_not_take_the_whole_
/// connection_down`). Ein Absenken deutlich unter ca. 15 s faengt an, mit
/// diesen Beobachtungsfenstern zu wettlaufen: der Waechter koennte dann
/// eine Session abschiessen, die der jeweilige Test noch als "bewusst
/// zurueckgestaut, aber gesund" pruefen wollte.
///
/// `pub`, nicht nur crate-intern -- aus demselben Grund wie bei
/// `ACK_WINDOW_BYTES` oben: `a_stalled_session_does_not_take_the_whole_
/// connection_down` bindet seine Wartefrist an DIESE Konstante
/// (`STALL_TIMEOUT + 30s`) statt eine feste Zahl zu wiederholen -- aendert
/// sich das Zeitlimit, wandert der Test automatisch mit, statt in ein
/// Zeitlimit zu laufen, das nichts mehr mit dem Waechter zu tun hat.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Spec §5.6: Frist der verzichtbaren Verlaufserfassung beim Oeffnen.
const HISTORY_TIMEOUT: Duration = Duration::from_secs(2);

/// Spec §5.6, Restzeit: so viel muss vom Oeffnen nach der Erfassungsfrist
/// noch uebrig sein.
const HISTORY_RESERVE: Duration = Duration::from_millis(300);

/// Spec §5.6: hoechstens so viel Verlauf; aeltere Zeilen fallen weg.
const HISTORY_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Spec §5.6: Groesse der Verlaufsstuecke in `terminal://output`.
const HISTORY_CHUNK_BYTES: usize = 32 * 1024;

/// Zustand der laufenden Anwendung. `Arc`-verwaltet (nicht Tauris eigenes
/// `manage`/`State`-Lifetime direkt), damit die Pumpaufgabe in
/// `open_terminal_impl` eine `'static`-Kopie fuer `tokio::spawn` bekommt,
/// ohne auf einen `AppHandle` angewiesen zu sein -- das haelt die
/// `_impl`-Funktionen Tauri-frei und damit ausserhalb einer laufenden
/// Anwendung testbar.
pub struct AppState {
    /// Der eigene Socket der App fuer alle tmux-Aufrufe dieses Zustands.
    /// Produktiv `settings::default_socket()`, im Debug-Bau ersetzbar (siehe
    /// `from_env`); Tests setzen ueber `with_own_socket` einen eigenen
    /// Socket, damit ein Testlauf gegen dieselbe VM nicht mit den Sessions
    /// eines anderen Nutzers auf dem Produktionssocket kollidiert. Als
    /// `OwnSocket` nie der Standard-Socket (Spec 2026-10-25 §6.1).
    pub own_socket: OwnSocket,
    /// Der Standard-Socket des Nutzers: nur gelesen und nur ueber den
    /// Waechter angehaengt. Im Produkt `default`; Tests lenken ihn ueber
    /// `with_default_socket_name` auf einen Testsocket um, damit kein
    /// automatischer Test den echten beruehrt (Spec 2026-10-25 §6.1).
    pub default_socket: TmuxSocket,
    // The same short synchronous lock reserves, publishes and removes attempts.
    // No network, channel cleanup or file IO is awaited while it is held.
    hosts: std::sync::Mutex<HashMap<String, HostSlot>>,
    terminals: std::sync::Mutex<TerminalRegistry>,
    next_host_id: AtomicU64,
    next_generation: AtomicU64,
    // Short synchronous mutations only; response resolution is serialized
    // against cancellation through ConnectControl. No lock spans an await.
    pending_host_key: std::sync::Mutex<HashMap<u64, PendingHostKey>>,
    next_request_id: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self::with_own_socket(settings::default_socket())
    }
}

impl AppState {
    /// Zustand der laufenden App (`lib.rs`): Socket aus
    /// `settings::app_socket()`, im Debug-Bau also ggf. aus
    /// `AIDEVBRIDGE_TMUX_SOCKET` (Spec §9.3). Ein gesetzter, aber ungueltiger
    /// Name bricht den Start ab, statt still auf dem Produktionssocket zu
    /// landen; das Debug-Fenster hat eine Konsole fuer die Meldung.
    ///
    /// Bewusst nicht `Default`: die Unit-Tests bauen ihren Zustand ueber
    /// `AppState::default()` und sollen nicht von der Umgebung abhaengen.
    pub fn from_env() -> Self {
        let own = settings::app_socket().unwrap_or_else(|error| panic!("{error}"));
        let default = settings::default_socket_name().unwrap_or_else(|error| panic!("{error}"));
        // Zeigten beide auf denselben Server, stuenden seine Sessions doppelt da.
        assert_ne!(
            own, default,
            "the own and the default tmux socket must differ"
        );
        Self::with_own_socket(own).with_default_socket_name(default)
    }

    /// Fuer Tests: eigener tmux-Socket, damit Laeufe gegen die VM nicht mit
    /// den Sessions eines Nutzers auf derselben Maschine kollidieren.
    pub fn with_own_socket(own_socket: String) -> Self {
        Self {
            own_socket: OwnSocket::new(own_socket).unwrap_or_else(|error| panic!("{error}")),
            default_socket: TmuxSocket::default_named(DEFAULT_SOCKET_NAME),
            hosts: std::sync::Mutex::new(HashMap::new()),
            terminals: std::sync::Mutex::new(TerminalRegistry::default()),
            next_host_id: AtomicU64::new(0),
            next_generation: AtomicU64::new(0),
            pending_host_key: std::sync::Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(0),
        }
    }

    /// Fuer Tests: der Standard-Socket unter einem Testnamen.
    pub fn with_default_socket_name(mut self, name: String) -> Self {
        self.default_socket = TmuxSocket::default_named(name);
        self
    }

    /// Der eigene Socket als Socket zum Lesen.
    pub fn own_tmux_socket(&self) -> TmuxSocket {
        TmuxSocket::own(&self.own_socket)
    }

    /// Der Socket zum Lesen fuer `kind`.
    pub fn tmux_socket(&self, kind: SocketKind) -> TmuxSocket {
        match kind {
            SocketKind::App => self.own_tmux_socket(),
            SocketKind::Default => self.default_socket.clone(),
        }
    }

    /// Nur fuer Tests/Diagnose: ob fuer `host_id` eine Verbindung gefuehrt
    /// wird.
    pub async fn has_host(&self, host_id: &str) -> bool {
        self.hosts
            .lock()
            .unwrap()
            .get(host_id)
            .and_then(HostSlot::ready)
            .is_some()
    }

    /// Nur fuer Tests/Diagnose: ob fuer `(host_id, session)` ein offener
    /// PTY-Kanal gefuehrt wird.
    pub async fn has_terminal(&self, host_id: &str, session: &str) -> bool {
        self.terminals
            .lock()
            .unwrap()
            .contains_key(&session_key(host_id, SocketKind::App, session))
    }

    /// Registers the response channel awaited asynchronously by the policy.
    fn register_host_key_request(
        &self,
        control: ConnectControl,
        deadline: tokio::time::Instant,
    ) -> (u64, oneshot::Receiver<bool>) {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending_host_key.lock().unwrap().insert(
            id,
            PendingHostKey {
                sender: tx,
                control,
                deadline,
            },
        );
        (id, rx)
    }

    /// Entfernt eine Anfrage ohne sie zu beantworten -- Aufraeumen nach
    /// einem Zeitablauf (niemand ruft dann noch `respond_host_key` mit
    /// Erfolg fuer dieselbe `id` auf; ein spaeter eintreffender Aufruf
    /// findet den Eintrag nicht mehr und liefert einen Fehler, siehe
    /// `respond_host_key_impl`).
    fn forget_host_key_request(&self, id: u64) {
        self.pending_host_key.lock().unwrap().remove(&id);
    }

    /// Von `respond_host_key_impl`: liefert `true`, wenn eine noch
    /// wartende Anfrage gefunden und beantwortet wurde -- `false`, wenn
    /// `request_id` unbekannt ist (bereits beantwortet oder per
    /// Zeitablauf schon abgelehnt worden).
    fn resolve_host_key_request(&self, id: u64, accept: bool) -> bool {
        // Erst binden (der `MutexGuard` faellt am `;` dieses Statements),
        // DANN erst `match` -- dasselbe Muster wie `disconnect_host_impl`
        // weiter unten: ein
        // `match self.pending_host_key.lock().unwrap().remove(&id) { ... }`
        // liesse den Guard sonst als Scrutinee-Temporary bis zum Ende des
        // `match`-Ausdrucks leben (`clippy::significant_drop_in_scrutinee`,
        // in `lib.rs` dauerhaft aktiviert, schlaegt hier zu Recht an).
        let control = self
            .pending_host_key
            .lock()
            .unwrap()
            .get(&id)
            .map(|p| p.control.clone());
        let Some(control) = control else { return false };
        control
            .with_active(|| {
                let pending = self.pending_host_key.lock().unwrap().remove(&id);
                pending.is_some_and(|pending| {
                    tokio::time::Instant::now() < pending.deadline
                        && pending.sender.send(accept).is_ok()
                })
            })
            .unwrap_or(false)
    }
}

/// Pending reservations expire even if their IPC response never reaches a view.
pub fn begin_connect_impl(state: &Arc<AppState>) -> Result<String, ConnectError> {
    begin_connect_with_limits(state, ConnectLimits::default())
}

fn begin_connect_with_limits(
    state: &Arc<AppState>,
    limits: ConnectLimits,
) -> Result<String, ConnectError> {
    let control = ConnectControl::new(limits);
    let deadline = control.deadline();
    let (expiry, ended) = oneshot::channel();
    let host_id;
    {
        let mut hosts = state.hosts.lock().unwrap();
        if hosts
            .values()
            .filter(|slot| slot.control().is_some())
            .count()
            >= MAX_CONNECT_ATTEMPTS
        {
            return Err(ConnectError {
                code: "connect_capacity",
                message: "Too many connection attempts are already pending.".into(),
            });
        }
        host_id = next_host_id(&state.next_host_id);
        hosts.insert(host_id.clone(), HostSlot::Pending { control, expiry });
    }
    let weak = Arc::downgrade(state);
    let expired_id = host_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = ended => return,
            _ = tokio::time::sleep_until(deadline) => {},
        }
        if let Some(state) = weak.upgrade() {
            let mut hosts = state.hosts.lock().unwrap();
            if hosts
                .get(&expired_id)
                .is_some_and(|slot| slot.control().is_some())
            {
                if let Some(slot) = hosts.remove(&expired_id) {
                    if let Some(control) = slot.control() {
                        // Record the elapsed total budget before releasing the
                        // attempt; expiry is distinct from a user cancellation.
                        let _ = control.with_active(|| ());
                    }
                }
            }
        }
    });
    Ok(host_id)
}

struct ConnectAttempt {
    state: Arc<AppState>,
    host_id: String,
    control: ConnectControl,
    published: bool,
}

impl ConnectAttempt {
    fn take(state: &Arc<AppState>, host_id: String) -> Result<Self, ConnectError> {
        let control = {
            let mut hosts = state.hosts.lock().unwrap();
            if !matches!(hosts.get(&host_id), Some(HostSlot::Pending { .. })) {
                return Err(ConnectError {
                    code: "connect_cancelled",
                    message: "Connection attempt is no longer available.".into(),
                });
            }
            let Some(HostSlot::Pending { control, expiry }) = hosts.remove(&host_id) else {
                unreachable!()
            };
            control.with_active(|| ()).map_err(connect_failure)?;
            hosts.insert(
                host_id.clone(),
                HostSlot::Building {
                    control: control.clone(),
                    _expiry: expiry,
                },
            );
            control
        };
        Ok(Self {
            state: state.clone(),
            host_id,
            control,
            published: false,
        })
    }

    fn publish(&mut self, transport: Arc<HostConnection>) -> Result<String, ConnectError> {
        let mut hosts = self.state.hosts.lock().unwrap();
        if !matches!(hosts.get(&self.host_id), Some(HostSlot::Building { .. })) {
            return Err(connect_failure(
                self.control
                    .with_active(|| ())
                    .err()
                    .unwrap_or(ConnectFailure::Cancelled),
            ));
        }
        self.control
            .with_active(|| {
                transport.start_monitor();
                hosts.insert(self.host_id.clone(), HostSlot::Ready(transport));
                self.published = true;
                self.host_id.clone()
            })
            .map_err(connect_failure)
    }
}

impl Drop for ConnectAttempt {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let mut hosts = self.state.hosts.lock().unwrap();
        self.control.cancel();
        hosts.remove(&self.host_id);
    }
}

/// Ein offener PTY-Kanal plus sein Ack-Fenster. `generation` loest das
/// Wiedereroeffnen-Wettrennen (siehe `owns_current_entry`): schliesst
/// `close_terminal` eine Session und `open_terminal` legt sofort danach
/// eine neue fuer denselben Schluessel an, darf die noch laufende
/// Pumpaufgabe der ALTEN Session beim eigenen Aufraeumen nicht den NEUEN
/// Eintrag aus der Map reissen.
///
/// `cancel` (Review-Befund 2, Important): weckt eine Pumpaufgabe, die
/// gerade in `AckGate::wait_for_room` haengt, wenn IHR Eintrag abgeraeumt
/// wird (`close_terminal`, `disconnect_host`, oder ein verdraengendes
/// `open_terminal`, siehe Befund 1). Ohne dieses Signal wartet
/// `wait_for_room` auf einen `ack()`, der fuer eine bereits entfernte
/// Session nie wieder kommt -- die Pumpaufgabe (und ihre `Arc`-Referenzen
/// auf `AppState`/`AckGate`/`OutputSink`) leckt fuer die restliche
/// Prozesslaufzeit. Bewusst NICHT Teil von `AckGate` selbst: die
/// Rueckstaubremse (Kredit-Buchhaltung, Kette bis zum SSH-Fenster) bleibt
/// unveraendert, das Abbruchsignal ist ein rein aeusserlicher
/// Orchestrierungs-Mechanismus (siehe `wait_for_room_cancel_or_stall`).
struct OpenTerminal {
    open_id: String,
    // `Arc`, nicht `PtyHandle` direkt (Task 10, Nachtrag): `send_input_impl`
    // und `resize_terminal_impl` muessen einen Verweis aus dieser Map
    // ziehen koennen, der die `state.terminals`-Sperre ueberlebt, OHNE den
    // Eintrag selbst aus der Map zu entfernen (der Eintrag bleibt ja offen).
    // Ein `Arc::clone()` ist billig und laesst sich waehrend die Sperre
    // noch gehalten wird ziehen; die Sperre faellt danach sofort, das
    // eigentliche `write()`/`resize()` laeuft komplett ohne sie (siehe
    // dortige Kommentare). `PtyHandle::close` nimmt seit demselben Nachtrag
    // bewusst `&self` statt `self` entgegen (siehe dort) -- sonst koennte
    // `close_entry` beim Abraeumen nicht garantieren, den `PtyHandle` per
    // Wert aus dem `Arc` zurueckzubekommen, wenn just in diesem Moment noch
    // ein `send_input_impl`/`resize_terminal_impl` einen zweiten Klon haelt.
    pty: Arc<PtyHandle>,
    ack: Arc<AckGate>,
    cancel: Arc<Notify>,
    generation: u64,
}

/// Stops forwarding and hands cleanup to the existing bounded channel owner.
/// Returning here does not claim a remote close acknowledgement.
fn close_entry(entry: OpenTerminal) {
    entry.cancel.notify_one();
    entry.pty.request_close();
}

#[derive(Default)]
struct TerminalRegistry {
    open: HashMap<String, OpenTerminal>,
    pending: HashMap<String, PendingTerminal>,
}

struct PendingTerminal {
    generation: u64,
    control: OperationControl,
    open_id: String,
}

impl std::ops::Deref for TerminalRegistry {
    type Target = HashMap<String, OpenTerminal>;
    fn deref(&self) -> &Self::Target {
        &self.open
    }
}

impl std::ops::DerefMut for TerminalRegistry {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.open
    }
}

/// Owns the local intent before channel_open_session can send anything.
/// Close, Kill, replacement and Disconnect invalidate this same generation.
struct TerminalAttempt {
    state: Arc<AppState>,
    key: String,
    generation: u64,
    control: OperationControl,
}

impl TerminalAttempt {
    fn reserve(
        state: &Arc<AppState>,
        host_id: &str,
        socket: SocketKind,
        session: &str,
        open_id: &str,
        host: &Arc<HostConnection>,
    ) -> Result<Self, String> {
        let key = session_key(host_id, socket, session);
        let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
        let control = OperationControl::new(COMMAND_TIMEOUT);
        {
            let mut terms = state.terminals.lock().unwrap();
            let hosts = state.hosts.lock().unwrap();
            let current = hosts.get(host_id).and_then(HostSlot::ready);
            if !current.is_some_and(|current| Arc::ptr_eq(&current, host)) {
                return Err("host disconnected during terminal setup".into());
            }
            if !terms.pending.contains_key(&key)
                && terms
                    .pending
                    .keys()
                    .filter(|key| belongs_to_host(key, host_id))
                    .count()
                    >= 4
            {
                return Err("too many terminal setups are already pending for this host".into());
            }
            if let Some(pending) = terms.pending.insert(
                key.clone(),
                PendingTerminal {
                    generation,
                    control: control.clone(),
                    open_id: open_id.into(),
                },
            ) {
                pending.control.cancel();
            }
            if let Some(entry) = terms.remove(&key) {
                close_entry(entry);
            }
        }
        Ok(Self {
            state: state.clone(),
            key,
            generation,
            control,
        })
    }
}

impl Drop for TerminalAttempt {
    fn drop(&mut self) {
        let mut terms = self.state.terminals.lock().unwrap();
        if terms
            .pending
            .get(&self.key)
            .is_some_and(|pending| pending.generation == self.generation)
        {
            terms.pending.remove(&self.key);
            self.control.cancel();
        }
    }
}

fn invalidate_terminal(terms: &mut TerminalRegistry, key: &str, open_id: Option<&str>) {
    if terms
        .pending
        .get(key)
        .is_some_and(|pending| open_id.is_none_or(|id| pending.open_id == id))
    {
        if let Some(pending) = terms.pending.remove(key) {
            pending.control.cancel();
        }
    }
    if terms
        .get(key)
        .is_some_and(|entry| open_id.is_none_or(|id| entry.open_id == id))
    {
        if let Some(entry) = terms.remove(key) {
            close_entry(entry);
        }
    }
}

/// Ausgang eines Kreditwartens in der Pumpaufgabe. Dreiwertig, nicht `bool`
/// (Design §2.4): "kein Kredit bekommen" hat zwei Ursachen mit
/// unterschiedlicher Bedeutung -- ein gewolltes Abraeumen der Session
/// (`Cancelled`, der Eintrag ist schon weg) und ein Renderer, der nicht mehr
/// bestaetigt (`Stalled`, der Eintrag lebt noch und muss abgeraeumt werden).
/// Ein `bool` konnte das nicht unterscheiden.
#[derive(Debug, PartialEq, Eq)]
enum PumpDecision {
    /// Kredit gewaehrt UND reserviert -- weitersenden.
    Proceed,
    /// Abbruchsignal: die Session wurde von einem der drei gewollten
    /// Schliesspfade bereits aus der Map entfernt. NICHTS reserviert.
    Cancelled,
    /// Zeitlimit: waehrend das Fenster voll war, kam ueber `stall_timeout`
    /// hinweg kein einziges Ack. NICHTS reserviert.
    Stalled,
}

/// Wartet auf Kredit (`AckGate::wait_for_room`), auf ein Abbruchsignal und
/// auf das Stillstands-Zeitlimit gleichzeitig.
///
/// Bei `Cancelled` und `Stalled` wurde NICHTS reserviert: die
/// `wait_for_room`-Zukunft wird verworfen, bevor sie `reserve()` erreicht
/// (siehe `AckGate::wait_for_room`s Kommentar; `Notify::notified()` und
/// `tokio::time::sleep` sind an jedem Punkt abbruchsicher droppbar).
///
/// `stall_timeout` ist ein PARAMETER, keine gelesene Konstante -- damit die
/// Unit-Tests oben kurze Werte einsetzen koennen, ohne dreissig Sekunden zu
/// warten, und damit die Pro-Aufruf-Semantik in der Signatur sichtbar ist.
///
/// Von der Pumpaufgabe in `open_terminal_impl` TATSAECHLICH aufgerufen
/// (nicht nur eine Testkopie) -- siehe die Unit-Tests im Testmodul fuer die
/// Gegenprobe, dass diese Funktion tatsaechlich abbricht bzw. den Waechter
/// feuert, statt fuer immer zu warten.
async fn wait_for_room_cancel_or_stall(
    ack: &AckGate,
    cancel: &Notify,
    len: u64,
    stall_timeout: Duration,
) -> PumpDecision {
    tokio::select! {
        _ = ack.wait_for_room(len) => PumpDecision::Proceed,
        _ = cancel.notified() => PumpDecision::Cancelled,
        _ = tokio::time::sleep(stall_timeout) => PumpDecision::Stalled,
    }
}

/// Baut den Map-Schluessel fuer `(host_id, session)`.
///
/// `host_id` ist ausschliesslich `next_host_id`s eigene Ausgabe
/// (`format!("h{n}")`, nur Ziffern) -- ein `:` kann darin nicht vorkommen,
/// und DAS ist es, worauf `belongs_to_host` unten sich stuetzt.
///
/// Fuer `session` galt das einmal ebenso ("ausschliesslich
/// `tmux::new_session_name`s Ausgabe, `[a-z0-9_]`, Spec V13"): seit
/// `list_sessions` kommen Sessionnamen vom FREMDEN Rechner und koennen alles
/// enthalten, was tmux zulaesst. Die Zusicherung ist damit hinfaellig; die
/// Eindeutigkeit haelt trotzdem, weil sie nur vom ERSTEN Teil abhaengt --
/// `belongs_to_host` schneidet `host_id` samt Trenner vorn ab und schaut
/// nicht weiter. Ein `:` im Sessionnamen landet also im Rest und kann kein
/// anderes Paar treffen.
///
/// Der Trenner selbst ist das, was zwei UNTERSCHIEDLICHE Paare vor einer
/// Kollision unter naiver Verkettung schuetzt, z. B. ("1", "23") und
/// ("12", "3").
///
/// Der Socket steht zwischen Host und Name (Spec 2026-10-25 §5): Dieselbe
/// Session kann auf dem eigenen und dem Standard-Socket heissen. Seine
/// Kennung (`app`/`default`) enthaelt keinen Trenner, der Name bleibt der
/// Rest.
fn session_key(host_id: &str, socket: SocketKind, session: &str) -> String {
    format!("{host_id}:{}:{session}", socket.as_str())
}

/// Ob `key` (wie von `session_key` erzeugt) zu `host_id` gehoert --
/// gebraucht von `disconnect_host_impl`, um alle Terminals eines Hosts zu
/// finden. Prueft den Trenner ausdruecklich, damit `host_id` "h1" keine
/// Session von `host_id` "h10" trifft -- ein blosses
/// `key.starts_with(host_id)` wuerde das (siehe Testmodul, Gegenprobe).
fn belongs_to_host(key: &str, host_id: &str) -> bool {
    key.strip_prefix(host_id)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some()
}

/// Vergibt `host_id`s der Form `h<n>`, aufsteigend und eindeutig innerhalb
/// eines Anwendungslaufs. Nicht persistiert (Randbedingung: keine lokale
/// Datenbank fuer Session-Zustand) -- die dauerhafte Kennung fuer einen
/// konfigurierten Host lebt in `settings::HostEntry::id` (Task 13), nicht
/// hier.
fn next_host_id(counter: &AtomicU64) -> String {
    let n = counter.fetch_add(1, Ordering::Relaxed);
    format!("h{n}")
}

/// Ob die gerade beendete Pumpaufgabe (`my_generation`) noch Eigentuemerin
/// des Map-Eintrags ist, den sie beim Beenden aufraeumen will.
/// `current_generation` ist `None`, wenn gar kein Eintrag mehr da ist
/// (schon von woanders geschlossen -- auch dann nichts zu tun). Reine
/// Entscheidungsfunktion, absichtlich ohne Map-Zugriff, damit das
/// Wettrennen-Argument ohne einen echten `PtyHandle` (der ausserhalb eines
/// echten SSH-Kanals nicht konstruierbar ist) unit-testbar bleibt.
fn owns_current_entry(current_generation: Option<u64>, my_generation: u64) -> bool {
    current_generation == Some(my_generation)
}

/// Der Text, den der WebView bei einem gescheiterten Verbindungsversuch
/// zeigt.
///
/// `AuthError::user_message()` traegt zehn sorgfaeltig formulierte,
/// paarweise als verschieden getestete Meldungen -- und hatte bis zu diesem
/// Punkt KEINEN Produktivaufrufer (Design §4.5): `connect_host_with_known_
/// hosts` gab `e.to_string()` zurueck, also `anyhow`s knappen Display-Text
/// ("passphrase required"). Am teuersten war der Verlust bei
/// `AgentUnavailable`, dessen Meldung den PowerShell-Befehl nennt, den
/// Windows 11 braucht, weil der ssh-agent-Dienst dort standardmaessig
/// deaktiviert ist. Strukturell dieselbe Klasse wie M-B: getesteter Code
/// ohne Aufrufer.
///
/// `downcast_ref` statt eines Textvergleichs: `authenticate` liefert
/// `Result<(), AuthError>`, und `RusshTransport::connect` konvertiert per
/// `?` OHNE `.context()` -- die Variante bleibt in der Kette.
/// `anyhow::Error::downcast_ref` durchsucht die ganze Kette, ein spaeter
/// ergaenztes `.context()` bricht das also nicht (siehe
/// `auth_error_message_survives_context_and_falls_back_for_other_errors`).
///
/// BEWUSSTER TAUSCH, kein Nebeneffekt: `user_message()` liefert `&'static
/// str`, also geht das mit `KeyUnreadable(detail)`, `AgentUnavailable(detail)`
/// und den uebrigen Varianten mitgefuehrte Detail hier VERLOREN -- der
/// fehlgeschlagene Pfad, der Betriebssystemfehler, die vom Server angebotene
/// Methodenliste. Das vorherige `e.to_string()` reichte es durch. Es gibt
/// keine Logdatei, aus der es sich zurueckholen liesse. Die Meldung ist damit
/// besser fuer den Nutzer und schlechter fuer einen Fehlerbericht; erst wenn
/// es dafuer eine Senke gibt (Logdatei oder ein Detailfeld im DTO), lohnt es
/// sich, das Detail zusaetzlich zu transportieren.
fn auth_error_message(e: &anyhow::Error) -> String {
    match e.downcast_ref::<AuthError>() {
        Some(auth) => auth.user_message().to_string(),
        None => e.to_string(),
    }
}

/// Typisierter Fehler von `connect_host` (Task 8, Spec §4.8):
/// `#[tauri::command]`-Fehlertypen mit `serde::Serialize` kommen im WebView
/// als gewoehnliches Objekt an (`{ code, message }`), nicht als blosse
/// Zeichenkette -- dasselbe Muster wie `SessionError` oben, fuer denselben
/// Zweck: die Seitenleiste muss "Passphrase noetig" von "falsches Passwort"
/// unterscheiden koennen, um das richtige Eingabefeld zu zeigen (`sidebar.ts`s
/// `buildHostNotice`), ohne auf den englischen Meldungstext aus `auth.rs` zu
/// mustern -- eine Musterung auf Prosa, die dieses Backend selbst formuliert,
/// wuerde bei der naechsten Wortlaut-Aenderung still brechen (siehe
/// `SessionError`s Doc-Kommentar fuer dieselbe Regel).
///
/// `message` ist das, was `connect_host` vor diesem Task als `Err(String)`
/// lieferte -- `code` kommt als ZUSAETZLICHE Information dazu, keine
/// Ersetzung. Die Hostschluesseltexte hat die UX-Ueberarbeitung neu gefasst
/// (Spec §10); die Codes blieben, und nur sie wertet das Frontend aus.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectError {
    pub code: &'static str,
    pub message: String,
}

impl ConnectError {
    /// Fuer Fehler, die vor jeder Auth-Klassifikation entstehen (z. B. das
    /// Heimatverzeichnis laesst sich nicht bestimmen, `known_hosts` ist
    /// unlesbar) -- dieselbe Kategorie, die `auth_error_message` fuer einen
    /// Fehler waehlt, der KEIN `AuthError` ist.
    fn other(message: impl Into<String>) -> Self {
        Self {
            code: "other",
            message: message.into(),
        }
    }
}

fn connect_failure(error: ConnectFailure) -> ConnectError {
    let code = match error {
        ConnectFailure::Cancelled => "connect_cancelled",
        ConnectFailure::DeadlineExceeded
        | ConnectFailure::NetworkTimeout
        | ConnectFailure::AuthTimeout
        | ConnectFailure::TofuTimeout => "connect_timeout",
        ConnectFailure::PreparationBusy | ConnectFailure::NetworkCapacity => "connect_capacity",
        ConnectFailure::PreparationFailed
        | ConnectFailure::ResolverFailed
        | ConnectFailure::AlreadyActive => "other",
    };
    ConnectError {
        code,
        message: error.to_string(),
    }
}

/// Klassifiziert einen gescheiterten `connect_host`-Versuch in `ConnectError`
/// (Task 8, Spec §4.8) -- `message` ist die bisherige `String`-Fehlermeldung
/// (siehe `connect_host_with_known_hosts`s duenne Huelle um
/// `connect_host_core` unten, die aus Kompatibilitaetsgruenden weiterhin nur
/// `message` herausreicht), `code` kommt zusaetzlich dazu.
///
/// Nach einem etwaigen Cancel-/Zeitlimitgrund wird `host_key_decision`
/// vor den Auth-Fehlern geprueft, aus demselben Grund, aus dem
/// `connect_host_with_known_hosts` das bisher tat: ein von der TOFU-Politik
/// abgelehnter Host-Schluessel ist KEIN `AuthError` (die Verbindung scheitert
/// schon vor jedem Auth-Versuch, siehe `TofuPolicy`/`RusshTransport::connect`)
/// und braucht deshalb eine eigene, hier fest verdrahtete Meldung. Die zwei
/// Texte stehen in Spec §10 (UX-Ueberarbeitung), der Code bleibt
/// `host_key_rejected`.
///
/// `host` ist der Name, unter dem `known_hosts` den Host fuehrt
/// (`known_hosts::host_token`: bei Port 22 der Host, sonst `[host]:port`), denn
/// unter diesem Namen sucht der Nutzer den alten Eintrag zum Entfernen. Gelesen
/// wird er nur fuer `Mismatch`; wer keine Entscheidung uebergibt, nennt keinen
/// Host.
fn classify_connect_error(
    e: &anyhow::Error,
    host_key_decision: Option<HostKeyDecision>,
    host: &str,
) -> ConnectError {
    if let Some(error) = e.downcast_ref::<ConnectFailure>() {
        return connect_failure(*error);
    }
    match host_key_decision {
        Some(HostKeyDecision::Unknown) => ConnectError {
            code: "host_key_rejected",
            message: "The host key wasn't confirmed, so aidevbridge didn't connect.".to_string(),
        },
        Some(HostKeyDecision::Mismatch) => ConnectError {
            code: "host_key_rejected",
            message: format!(
                "The host key of {host} has changed. Someone may be intercepting the connection \
                 — or the server was reinstalled. If you're sure, remove its old entry from \
                 ~/.ssh/known_hosts, for example with ssh-keygen -R \"{host}\", and connect \
                 again."
            ),
        },
        // `Known` (der Schluessel stand schon passend in `known_hosts`) und
        // `None` (die Verbindung scheiterte VOR jeder TOFU-Entscheidung, z. B.
        // TCP-Verbindungsaufbau) sind beide KEINE Host-Key-Ablehnung -- der
        // Fehler liegt dann in der Auth-Klassifikation unten, wie vor
        // diesem Task.
        Some(HostKeyDecision::Known) | None => {
            let message = auth_error_message(e);
            let code = match e.downcast_ref::<AuthError>() {
                Some(AuthError::PassphraseRequired) | Some(AuthError::PassphraseWrong) => {
                    "passphrase_required"
                }
                Some(AuthError::PasswordWrong) => "password_required",
                Some(AuthError::HostUnreachable) => "host_unreachable",
                Some(AuthError::MethodNotOffered(_))
                | Some(AuthError::MultiFactorRequired(_))
                | Some(AuthError::KeyUnreadable(_))
                | Some(AuthError::SigningFailed)
                | Some(AuthError::AgentUnavailable(_))
                | Some(AuthError::AgentNoIdentities(_)) => "auth_rejected",
                None => "other",
            };
            ConnectError { code, message }
        }
    }
}

/// DTO aus dem WebView. `key_path: None` bedeutet "kein expliziter
/// Schluesselpfad angegeben" und wird als ssh-agent gelesen (siehe
/// `resolve_auth_method`), nicht als geratener Default-Pfad -- ein
/// Rateversuch waere eine stille Annahme ueber Nutzerdaten, die dieses DTO
/// nicht traegt.
///
/// `passphrase`/`password` (M-B, Abschlussreview): bis dahin waren
/// `AuthMethod::Password` und `AuthMethod::Key{passphrase: Some(..)}`
/// implementiert und getestet, aber ausserhalb der Modultests nirgends
/// konstruierbar -- dieses DTO kannte nur `Some(pfad) -> Key{passphrase:
/// None}` und `None -> Agent`. Direkt als `Zeroizing<String>` deserialisiert
/// (Spec §8.5, `zeroize`s `serde`-Feature, siehe Cargo.toml-Kommentar) --
/// ab der Deserialisierung liegt das Geheimnis damit in keinem gewoehnlichen
/// `String` mehr.
///
/// Was das ausdruecklich NICHT heisst, damit die Frage nicht wiederkehrt:
/// Tauri deserialisiert Befehlsargumente aus einem BEREITS materialisierten
/// `serde_json::Value` (`tauri-2.11.5/src/ipc/command.rs`), der Klartext lebt
/// vorher also in dessen `String` -- und im Fenster ohnehin in
/// unveraenderlichen JS-Zeichenketten, die niemand ueberschreiben kann. Eine
/// vollstaendige Behebung braeuchte einen eigenen `Raw`-Payload-Weg am
/// JSON-Parser vorbei; das steht in keinem Verhaeltnis zum Gewinn, solange
/// die Zeichenkette im WebView davor ohnehin ungeschuetzt ist. `Zeroizing`
/// deckt den laengsten und am weitesten gereisten Teil des Lebenswegs ab
/// (Verbindungsaufbau, Weitergabe durch mehrere Schichten) und nicht die
/// erste Millisekunde.
///
/// KEIN `#[derive(Debug)]` auf diesem Typ (siehe `AuthMethod`s
/// handgeschriebene `Debug`-Implementierung in `ssh/auth.rs` fuer denselben
/// Grund) -- ein abgeleitetes `Debug` haette hier ohnehin keine Redaction.
#[derive(serde::Deserialize)]
pub struct HostSpecDto {
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<zeroize::Zeroizing<String>>,
    #[serde(default)]
    pub password: Option<zeroize::Zeroizing<String>>,
}

/// Waehlt die `AuthMethod` aus den rohen DTO-Feldern (M-B, Abschlussreview).
/// Eigene, reine Funktion statt inline in `connect_host_with_known_hosts`:
/// so ist die Vorrangregel ohne SSH-Verbindung testbar (Spec §13 Ebene 1,
/// "Unit, ohne I/O") -- `connect_host_with_known_hosts` selbst laesst sich
/// nur gegen die echte VM testen (`RusshTransport::connect` ist keine
/// austauschbare Abstraktion, siehe Modulkommentar).
///
/// Vorrang: `key_path` VOR `password` -- ein Nutzer, der beide Felder
/// ausgefuellt hat (z. B. beim Formularwechsel), meint mit einem gesetzten
/// Schluesselpfad eindeutig Schluessel-Auth; `password` waere sonst eine
/// gemeinsame Auswertung zweier einander ausschliessender Formularzweige.
/// `passphrase` ist nur zusammen mit `key_path` sinnvoll (Spec §8.4) --
/// bleibt `key_path` leer, wird `passphrase` stillschweigend verworfen,
/// niemals als Passwort missverstanden.
fn resolve_auth_method(
    key_path: Option<String>,
    passphrase: Option<zeroize::Zeroizing<String>>,
    password: Option<zeroize::Zeroizing<String>>,
) -> AuthMethod {
    match key_path {
        Some(p) => AuthMethod::Key {
            path: PathBuf::from(p),
            passphrase,
        },
        None => match password {
            Some(pw) => AuthMethod::Password(pw),
            None => AuthMethod::Agent,
        },
    }
}

/// Nutzlast von `terminal://output`. `bytes` bleibt `Vec<u8>` -- niemals
/// `String` --, damit xterm.js' zustandsbehafteter UTF-8-Dekoder nie einen
/// an einer Chunk-Grenze zerschnittenen Mehrbyte-Codepunkt sieht. Serde
/// serialisiert `Vec<u8>` ohne `serde_bytes` als JSON-Array roher
/// Byte-Werte, nicht als Text -- das ist bereits die "keine Dekodierung"-
/// Eigenschaft, kein zusaetzlicher Mechanismus noetig (siehe
/// `output_event_round_trips_bytes_exactly_even_across_a_split_utf8_boundary`).
#[derive(Clone, serde::Serialize)]
pub struct OutputEvent {
    pub host_id: String,
    pub session: String,
    pub bytes: Vec<u8>,
    pub open_id: String,
}

/// Abstraktion ueber "ein Datenpaket an den WebView liefern", damit die
/// Pumpaufgabe und die Ack-Bremse ohne laufende Tauri-Anwendung gegen die
/// echte VM testbar sind. Die Produktivimplementierung ist `AppHandle`
/// (unten); Tests liefern einen Kanal-basierten Sammler.
///
/// `send` liefert `false`, wenn keine weitere Zustellung mehr moeglich ist
/// (Pendant zu `AppHandle::emit(..).is_err()`) -- die Pumpaufgabe beendet
/// sich dann.
pub trait OutputSink: Send + Sync + 'static {
    fn send(&self, host_id: &str, session: &str, bytes: Vec<u8>) -> bool;

    /// Meldet, dass eine Terminalverbindung endete, OHNE dass zuvor ein
    /// expliziter Schliessvorgang (`close_terminal_impl`, `disconnect_host_
    /// impl`, ein verdraengendes `open_terminal` fuer denselben Schluessel)
    /// den Eintrag aus `state.terminals` entfernt hatte (M-C,
    /// Abschlussreview). Aufgerufen genau dort, wo `open_terminal_impl`s
    /// Pumpaufgabe beim eigenen Aufraeumen feststellt, dass sie selbst noch
    /// Eigentuemerin des Map-Eintrags ist (`owns_current_entry`) -- alle drei
    /// gewollten Schliesspfade entfernen den Eintrag VOR diesem Zeitpunkt
    /// (siehe deren Code), `owns_current_entry` waere dann bereits `false`
    /// und dieser Aufruf bliebe aus. Ein gewolltes Schliessen erzeugt
    /// dieses Signal deshalb strukturell nie, nicht nur durch eine
    /// zusaetzliche Fallunterscheidung, die vergessen werden koennte.
    ///
    /// Default-Implementierung: no-op -- dasselbe Muster wie
    /// `HostKeyRequestSink::notify_persist_failed`. Bestehende Test-Sinks,
    /// denen dieses Ereignis gleichgueltig ist, muessen dafuer nicht
    /// angefasst werden.
    fn connection_lost(&self, _host_id: &str, _session: &str) {}

    fn send_open(&self, host_id: &str, session: &str, _open_id: &str, bytes: Vec<u8>) -> bool {
        self.send(host_id, session, bytes)
    }

    fn connection_lost_open(&self, host_id: &str, session: &str, _open_id: &str) {
        self.connection_lost(host_id, session);
    }
}

impl OutputSink for AppHandle {
    fn send(&self, host_id: &str, session: &str, bytes: Vec<u8>) -> bool {
        self.send_open(host_id, session, "", bytes)
    }

    fn send_open(&self, host_id: &str, session: &str, open_id: &str, bytes: Vec<u8>) -> bool {
        self.emit(
            "terminal://output",
            OutputEvent {
                host_id: host_id.to_string(),
                session: session.to_string(),
                bytes,
                open_id: open_id.into(),
            },
        )
        .is_ok()
    }

    fn connection_lost(&self, host_id: &str, session: &str) {
        self.connection_lost_open(host_id, session, "");
    }

    fn connection_lost_open(&self, host_id: &str, session: &str, open_id: &str) {
        let _ = self.emit(
            "terminal://connection-lost",
            ConnectionLostEvent {
                host_id: host_id.to_string(),
                session: session.to_string(),
                open_id: open_id.into(),
            },
        );
    }
}

/// Nutzlast von `terminal://connection-lost` (M-C, Abschlussreview) -- siehe
/// `OutputSink::connection_lost`s Doc-Kommentar fuer die genaue
/// Unterscheidung zu einem gewollten Schliessen.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionLostEvent {
    pub host_id: String,
    pub session: String,
    pub open_id: String,
}

/// Reine Kredit-Buchhaltung fuer die Ack-Rueckstaubremse (Spec §9.1). Bewusst
/// frei von async/Tauri-Typen, damit sie ohne Laufzeit unit-testbar ist.
/// `in_flight` zaehlt Bytes, die bereits an den WebView geschickt, aber noch
/// nicht per `ack_output` bestaetigt wurden.
#[derive(Debug)]
struct AckWindow {
    capacity: u64,
    in_flight: u64,
}

impl AckWindow {
    fn new(capacity: u64) -> Self {
        Self {
            capacity,
            in_flight: 0,
        }
    }

    /// Ob `len` weitere Bytes verschickt werden duerften, ohne das Fenster
    /// zu ueberschreiten -- ODER das Fenster gerade leer ist. Der zweite
    /// Fall ist der Notausgang fuer ein einzelnes Datenpaket, das groesser
    /// als die gesamte Fensterkapazitaet ist: ohne ihn koennte kein Ack
    /// (kleiner als das Paket selbst) je genug Platz "schaffen", und die
    /// Pumpaufgabe wuerde fuer immer haengen.
    fn has_room(&self, len: u64) -> bool {
        self.in_flight == 0 || self.in_flight + len <= self.capacity
    }

    fn reserve(&mut self, len: u64) {
        self.in_flight += len;
    }

    /// Saturierend: ein zu grosser oder doppelter Ack vom Renderer darf
    /// `in_flight` niemals unterlaufen -- das wuerde die Bremse fuer den
    /// Rest der Sitzung stillschweigend abschalten (siehe Testmodul,
    /// Gegenprobe).
    fn release(&mut self, len: u64) {
        self.in_flight = self.in_flight.saturating_sub(len);
    }

    #[cfg(test)]
    fn in_flight(&self) -> u64 {
        self.in_flight
    }
}

/// Async-Huelle um `AckWindow`: blockiert die Pumpaufgabe, bis genug Platz
/// da ist, geweckt durch `ack_output`.
///
/// Nimmt an, dass hoechstens EINE Aufgabe gleichzeitig `wait_for_room`
/// aufruft -- fuer diesen Task zutreffend (genau eine Pumpaufgabe je
/// offenem Terminal, ein `AckGate` je Terminal). `notify_one()` speichert
/// ein Weck-Signal, falls `ack()` läuft, bevor die Pumpaufgabe ueberhaupt
/// wartet (siehe Tokio-Doku zu `Notify::notify_one`) -- das schliesst das
/// "verlorene Weck-Signal"-Rennen fuer den Einzel-Warter-Fall. Ein zweiter
/// gleichzeitiger Warter auf demselben `AckGate` waere NICHT fair bedient
/// (`notify_one` weckt irgendeinen, nicht zwingend den mit dem kleinsten
/// Bedarf) -- ausserhalb des Anwendungsfalls dieses Moduls, deshalb bewusst
/// nicht geloest.
struct AckGate {
    window: std::sync::Mutex<AckWindow>,
    notify: Notify,
}

impl AckGate {
    fn new(capacity: u64) -> Self {
        Self {
            window: std::sync::Mutex::new(AckWindow::new(capacity)),
            notify: Notify::new(),
        }
    }

    /// Blockiert, bis `len` weitere Bytes verschickt werden duerften, dann
    /// reserviert es sie. Das ist die eigentliche Bremse: Solange die
    /// Pumpaufgabe hier haengt, ruft sie `rx.recv()` nicht erneut auf --
    /// der bounded(64)-Kanal aus `PtyHandle` fuellt sich, `tx.send()` in der
    /// Leseaufgabe blockiert, das SSH-Fenster schliesst, der entfernte
    /// `tmux attach`-Prozess blockiert. Der Rueckstau reicht damit bis zum
    /// entfernten Prozess (Spec §9.1).
    async fn wait_for_room(&self, len: u64) {
        loop {
            {
                let mut w = self.window.lock().unwrap();
                if w.has_room(len) {
                    w.reserve(len);
                    return;
                }
            }
            self.notify.notified().await;
        }
    }

    /// Von `ack_output` gerufen: gibt `len` Bytes frei und weckt eine
    /// wartende Pumpaufgabe.
    fn ack(&self, len: u64) {
        self.window.lock().unwrap().release(len);
        self.notify.notify_one();
    }
}

/// Nutzlast von `hostkey://request` -- eine Rueckfrage an den Nutzer, ob ein
/// bislang unbekannter Host-Key vertraut werden soll (TOFU-Nachtrag, Task
/// 13). `fingerprint` ist bereits der SHA256-Fingerabdruck im
/// `ssh-keygen -lf`-Format (Eigenschaft 3 des Nachtrags) -- NIEMALS der
/// rohe Base64-Schluessel, den vergleicht niemand von Hand.
///
/// xpires_at_unix_ms mirrors this request's monotonic backend deadline
/// for the local WebView countdown. Backend acceptance always checks the
/// monotonic deadline itself; a wall-clock change cannot extend consent.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HostKeyRequest {
    pub request_id: u64,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub expires_at_unix_ms: u64,
    /// Schluesseltypen, unter denen dieser Host in `known_hosts` bereits
    /// bekannt ist (H8, Kritikrunde: `known_hosts::key_types_for`). Leer,
    /// wenn der Host ueberhaupt keinen Eintrag hat (echter Erstkontakt) --
    /// nicht leer, wenn der Server einen ANDEREN Typ anbietet als den/die
    /// bereits hinterlegten (`lookup` liefert dafuer `Unknown`, nicht
    /// `Mismatch`, siehe dessen Doc-Kommentar). Das Frontend zeigt in
    /// diesem Fall einen zusaetzlichen Hinweis, damit der Nutzer nicht
    /// faelschlich einen voelligen Erstkontakt vermutet.
    pub known_key_types: Vec<String>,
}

/// Abstraktion ueber "eine Host-Key-Rueckfrage an den WebView melden" --
/// dasselbe Muster wie `OutputSink` oben, aus demselben Grund: `TofuPolicy`
/// (unten) muss ohne laufende Tauri-Anwendung testbar bleiben. Liefert
/// `false`, wenn keine Zustellung mehr moeglich ist (kein WebView mehr
/// erreichbar) -- `TofuPolicy::decide` behandelt das wie jeden anderen
/// Nichtantwort-Fall: Ablehnung, niemals Annahme.
pub trait HostKeyRequestSink: Send + Sync + 'static {
    fn request(&self, req: &HostKeyRequest) -> bool;

    fn request_closed(&self, _event: &HostKeyRequestClosed) {}

    fn control_state(&self, _event: ControlStateEvent) {}

    fn terminal_transport_lost(&self, _event: TerminalTransportLostEvent) {}

    /// Meldet, dass ein bereits akzeptierter Host-Key NICHT dauerhaft nach
    /// `known_hosts` geschrieben werden konnte (Review-Befund, Important 3:
    /// `TofuPolicy::decide` gab diesen Fehlschlag bislang nur per
    /// `eprintln!` aus -- unsichtbar in einer gepackten Anwendung ohne
    /// Konsole). Die Verbindung DIESER einen Zustimmung bleibt bestehen
    /// (siehe `decide()`s Kommentar zum Kompromiss) -- dieses Ereignis
    /// dient ausschliesslich dazu, den Nutzer darueber zu informieren, dass
    /// die naechste Verbindung zu diesem Host erneut fragen wird, statt ihn
    /// vor einem kommentarlos wiederholten Prompt raetseln zu lassen.
    ///
    /// Default-Implementierung: no-op. Bestehende Test-Sinks (`PanicSink`,
    /// `RecordingSink`, `ChannelSink`, siehe Testmodul), denen dieses
    /// Ereignis gleichgueltig ist, muessen dafuer nicht angefasst werden.
    fn notify_persist_failed(&self, _host: &str, _port: u16, _message: &str) {}
}

impl HostKeyRequestSink for AppHandle {
    fn request(&self, req: &HostKeyRequest) -> bool {
        self.emit("hostkey://request", req.clone()).is_ok()
    }

    fn request_closed(&self, event: &HostKeyRequestClosed) {
        let _ = self.emit("hostkey://request-closed", event.clone());
    }

    fn control_state(&self, event: ControlStateEvent) {
        let _ = self.emit("control://state", event);
    }

    fn terminal_transport_lost(&self, event: TerminalTransportLostEvent) {
        let _ = self.emit("terminal://transport-lost", event);
    }

    fn notify_persist_failed(&self, host: &str, port: u16, message: &str) {
        let _ = self.emit(
            "hostkey://persist-failed",
            HostKeyPersistFailure {
                host: host.to_string(),
                port,
                message: message.to_string(),
            },
        );
    }
}

struct ConnectionEventSink(Arc<dyn HostKeyRequestSink>);

impl ConnectionEvents for ConnectionEventSink {
    fn control_state(&self, event: ControlStateEvent) {
        self.0.control_state(event);
    }
    fn terminal_transport_lost(&self, event: TerminalTransportLostEvent) {
        self.0.terminal_transport_lost(event);
    }
}

/// Nutzlast von `hostkey://persist-failed` (Review-Befund, Important 3) --
/// siehe `HostKeyRequestSink::notify_persist_failed`s Doc-Kommentar.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HostKeyPersistFailure {
    pub host: String,
    pub port: u16,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HostKeyRequestClosed {
    pub request_id: u64,
    pub expires_at_unix_ms: u64,
    pub reason: &'static str,
}

struct HostKeyRequestGuard {
    state: Arc<AppState>,
    sink: Arc<dyn HostKeyRequestSink>,
    deadline: tokio::time::Instant,
    event: HostKeyRequestClosed,
}

impl Drop for HostKeyRequestGuard {
    fn drop(&mut self) {
        if self.event.reason == "cancelled" && tokio::time::Instant::now() >= self.deadline {
            self.event.reason = "expired";
        }
        self.state.forget_host_key_request(self.event.request_id);
        self.sink.request_closed(&self.event);
    }
}

/// Known keys are accepted and mismatches rejected without prompting. Unknown
/// keys wait asynchronously under the same cancellation owner as the connect.
struct TofuPolicy {
    known_hosts_text: String,
    known_hosts_path: PathBuf,
    state: Arc<AppState>,
    sink: Arc<dyn HostKeyRequestSink>,
    prompt_timeout: Duration,
    control: ConnectControl,
    last_decision: std::sync::Mutex<Option<HostKeyDecision>>,
}

impl TofuPolicy {
    #[cfg(test)]
    fn new(
        known_hosts_text: String,
        known_hosts_path: PathBuf,
        state: Arc<AppState>,
        sink: Arc<dyn HostKeyRequestSink>,
        prompt_timeout: Duration,
    ) -> Self {
        Self::with_control(
            known_hosts_text,
            known_hosts_path,
            state,
            sink,
            prompt_timeout,
            ConnectControl::new(ConnectLimits {
                tofu: prompt_timeout,
                ..ConnectLimits::default()
            }),
        )
    }

    fn with_control(
        known_hosts_text: String,
        known_hosts_path: PathBuf,
        state: Arc<AppState>,
        sink: Arc<dyn HostKeyRequestSink>,
        prompt_timeout: Duration,
        control: ConnectControl,
    ) -> Self {
        Self {
            known_hosts_text,
            known_hosts_path,
            state,
            sink,
            prompt_timeout,
            control,
            last_decision: std::sync::Mutex::new(None),
        }
    }

    /// The trust decision, rather than the original lookup alone. Accepted
    /// Unknown must not hide a later password/signature/deadline error.
    fn last_decision(&self) -> Option<HostKeyDecision> {
        *self.last_decision.lock().unwrap()
    }
}

#[async_trait::async_trait]
impl HostKeyPolicy for TofuPolicy {
    async fn decide(&self, host: &str, port: u16, key_type: &str, key_b64: &str) -> bool {
        let decision = known_hosts::lookup(&self.known_hosts_text, host, port, key_type, key_b64);
        *self.last_decision.lock().unwrap() = Some(decision);
        if decision != HostKeyDecision::Unknown {
            return self
                .control
                .with_active(|| decision == HostKeyDecision::Known)
                .unwrap_or(false);
        }
        let fingerprint = match known_hosts::fingerprint(key_b64) {
            Ok(value) => value,
            Err(_) => return false,
        };
        let deadline = self
            .control
            .tofu_deadline()
            .min(tokio::time::Instant::now() + self.prompt_timeout);
        let expires_at_unix_ms = std::time::SystemTime::now()
            .checked_add(deadline.saturating_duration_since(tokio::time::Instant::now()))
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let registered = self.control.with_active(|| {
            self.state
                .register_host_key_request(self.control.clone(), deadline)
        });
        let Ok((id, receiver)) = registered else {
            return false;
        };
        let mut guard = HostKeyRequestGuard {
            state: self.state.clone(),
            sink: self.sink.clone(),
            deadline,
            event: HostKeyRequestClosed {
                request_id: id,
                expires_at_unix_ms,
                reason: "cancelled",
            },
        };
        let request = HostKeyRequest {
            request_id: id,
            host: host.to_string(),
            port,
            key_type: key_type.to_string(),
            fingerprint,
            expires_at_unix_ms,
            known_key_types: known_hosts::key_types_for(&self.known_hosts_text, host, port),
        };
        if !self.sink.request(&request) {
            guard.event.reason = "unavailable";
            return false;
        }
        let accepted = match self.control.wait_for_tofu_until(deadline, receiver).await {
            Ok(Ok(value)) => {
                guard.event.reason = "answered";
                value
            }
            _ => {
                if tokio::time::Instant::now() >= deadline {
                    guard.event.reason = "expired";
                }
                false
            }
        };
        drop(guard);
        if !accepted {
            return false;
        }
        *self.last_decision.lock().unwrap() = Some(HostKeyDecision::Known);

        // File work must never block a Tokio worker or the synchronous answer
        // command. Admission stays bounded even if an accepted attempt is later
        // cancelled while a filesystem operation is still in progress.
        static PERSIST_SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> =
            std::sync::OnceLock::new();
        let slots = PERSIST_SLOTS
            .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
            .clone();
        let path = self.known_hosts_path.clone();
        let line = known_hosts::format_entry(host, port, key_type, key_b64);
        let sink = self.sink.clone();
        let owned_host = host.to_string();
        let launched = self
            .control
            .with_active(|| match slots.try_acquire_owned() {
                Ok(permit) => Some(tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    if let Err(error) = known_hosts::append_entry(&path, &line) {
                        sink.notify_persist_failed(&owned_host, port, &error.to_string());
                    }
                })),
                Err(_) => None,
            });
        match launched {
            Ok(Some(job)) => {
                if matches!(self.control.wait_total(job).await, Ok(Err(_))) {
                    self.sink.notify_persist_failed(
                        host,
                        port,
                        "Host key persistence worker failed.",
                    );
                }
            }
            Ok(None) => self.sink.notify_persist_failed(
                host,
                port,
                "Too many host key writes are already pending.",
            ),
            Err(_) => return false,
        }
        true
    }
}

/// Liefert einen geseedeten `StdRng` fuer `new_session_name`. Bewusst NICHT
/// `rand::rng()` (`ThreadRng`): `ThreadRng` haelt thread-lokalen `Rc`-Zustand
/// und ist deshalb nicht `Send` -- ueber einen `.await`-Punkt hinweg
/// gehalten (das Retry-`await` in `create_session_with_retry`), macht das
/// die gesamte `async fn`-Zukunft nicht-`Send`, und Tauris
/// `generate_handler!` verlangt `Send`-Futures fuer jeden Command (sonst
/// schlaegt die Kompilierung fehl). `StdRng` traegt keinen thread-lokalen
/// Zustand und ist `Send`. Die Qualitaet der Seed-Quelle ist hier
/// unkritisch -- die 24 Bit Zufall in `new_session_name` dienen nur der
/// Kollisionsvermeidung, nicht der Sicherheit, und `create_session_with_retry`
/// faengt eine echte Kollision ohnehin ab.
fn seed_rng() -> rand::rngs::StdRng {
    use rand::SeedableRng;
    static SALT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let salt = SALT.fetch_add(1, Ordering::Relaxed);
    rand::rngs::StdRng::seed_from_u64(nanos ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

/// Versucht bis zu `max_attempts` zufaellige Session-Namen, bis
/// `create_session` NICHT mit `DuplicateName` antwortet (Spec §5.1). Nimmt
/// bewusst `t: &dyn Transport` statt `Arc<RusshTransport>` und `rng: &mut
/// impl rand::Rng` statt einer festen Quelle -- so bleibt die Funktion mit
/// einem abgespielten `Transport` und einem geseedeten RNG unit-testbar
/// (siehe Testmodul), im selben Muster wie `tmux::client`s eigene Tests.
///
/// `prepare_server` bewusst NICHT hier drin: der Aufrufer ruft es einmal
/// vorab. Waere es Teil der Schleife, muesste jedes Testskript vier
/// zusaetzliche Auftraege fuer die Serveroptionen mitfuehren, und ein
/// Fehlschlag dort waere von einer Namenskollision nicht mehr zu
/// unterscheiden.
async fn create_session_with_retry(
    client: &OwnTmuxClient,
    t: &dyn Transport,
    rng: &mut impl rand::Rng,
    cwd: &str,
    max_attempts: u32,
) -> anyhow::Result<String> {
    for _ in 0..max_attempts {
        let name = crate::tmux::new_session_name(rng);
        match client.create_session(t, &name, cwd).await? {
            CreateOutcome::Created => return Ok(name),
            CreateOutcome::DuplicateName => continue,
        }
    }
    anyhow::bail!("could not find a free session name after {max_attempts} attempts (all collided)")
}

// ---------------------------------------------------------------------
// _impl-Funktionen: die eigentliche Logik, Tauri-frei und damit ohne
// laufende Anwendung gegen die echte VM testbar (siehe Moduldoku oben).
// ---------------------------------------------------------------------

/// Liest `known_hosts` fuer `connect_host_impl` -- eigene, testbare
/// Funktion (dasselbe Muster wie `settings::load_from`, siehe dessen
/// Doc-Kommentar): `connect_host_impl` selbst haengt an einem hartkodierten
/// Pfad im echten Home-Verzeichnis und ist deshalb nicht mit einer
/// praeparierten Datei testbar, diese Funktion schon.
///
/// Fehlt die Datei, ist der Inhalt "leer" -- jeder Host ist dann `Unknown`
/// und loest die TOFU-Rueckfrage aus (siehe `TofuPolicy`), nicht `Known`.
/// JEDER ANDERE Lesefehler (Rechte, kaputtes UTF-8, ...) wird dagegen
/// durchgereicht (H5, Kritikrunde) -- NICHT mit `unwrap_or_default()`
/// verschluckt: eine unlesbare Datei saehe sonst wie eine leere aus, und
/// ein tatsaechlich veraenderter Schluessel wuerde als `Unknown` (freundliche
/// Erstkontakt-Rueckfrage) statt als `Mismatch` (MITM-Ablehnung ohne
/// Rueckfrage) behandelt -- genau der Fall, den `known_hosts` ueberhaupt
/// verhindern soll.
async fn read_known_hosts_text(path: &Path) -> Result<String, String> {
    // Cancelling an async filesystem wrapper cannot stop an OS read that has
    // started. Keep admission occupied until the actual worker releases it.
    static READ_SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    let permit = READ_SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Too many known-host file reads are already pending.".to_string())?;
    let owned_path = path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        std::fs::read_to_string(owned_path)
    })
    .await
    .map_err(|error| format!("known-host file reader failed: {error}"))?;
    match result {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Die Meldung zu einem Hostnamen, den `known_hosts::is_acceptable_hostname`
/// abweist. Sie wiederholt den Wert nicht: er kann Zeilenumbrueche oder
/// Steuerzeichen enthalten, und der Nutzer sieht ihn ohnehin im Dialog. Sie
/// nennt dafuer den haeufigsten Grund, einen mitgetippten Benutzernamen.
const HOSTNAME_REFUSED: &str = "This host name can't be used. Enter only the host name or \
     address, without a user name, spaces or any of , * ? ! [ ] | @ # / or backslash.";

fn usable_hostname(hostname: &str) -> Result<(), &'static str> {
    if known_hosts::is_acceptable_hostname(hostname) {
        Ok(())
    } else {
        Err(HOSTNAME_REFUSED)
    }
}

pub async fn connect_host_impl(
    state: &Arc<AppState>,
    sink: Arc<dyn HostKeyRequestSink>,
    host_id: String,
    spec: HostSpecDto,
) -> Result<String, ConnectError> {
    let mut attempt = ConnectAttempt::take(state, host_id)?;
    let known_hosts_path = dirs::home_dir()
        .ok_or_else(|| ConnectError::other("could not determine home directory"))?
        .join(".ssh")
        .join("known_hosts");
    let known_hosts_text = attempt
        .control
        .wait_total(read_known_hosts_text(&known_hosts_path))
        .await
        .map_err(connect_failure)?
        .map_err(ConnectError::other)?;
    connect_host_core(
        state,
        &mut attempt,
        spec,
        known_hosts_text,
        known_hosts_path,
        sink,
        HOST_KEY_PROMPT_TIMEOUT,
    )
    .await
}

/// Existing integration callers supply isolated known-host text/path explicitly.
/// They use the same reservation/ownership path; product IPC must reserve first.
pub async fn connect_host_with_known_hosts(
    state: &Arc<AppState>,
    spec: HostSpecDto,
    known_hosts_text: String,
    known_hosts_path: PathBuf,
    sink: Arc<dyn HostKeyRequestSink>,
    prompt_timeout: Duration,
) -> Result<String, String> {
    let limits = ConnectLimits {
        tofu: prompt_timeout,
        ..ConnectLimits::default()
    };
    let id = begin_connect_with_limits(state, limits).map_err(|error| error.message)?;
    let mut attempt = ConnectAttempt::take(state, id).map_err(|error| error.message)?;
    connect_host_core(
        state,
        &mut attempt,
        spec,
        known_hosts_text,
        known_hosts_path,
        sink,
        prompt_timeout,
    )
    .await
    .map_err(|error| error.message)
}

async fn connect_host_core(
    state: &Arc<AppState>,
    attempt: &mut ConnectAttempt,
    spec: HostSpecDto,
    known_hosts_text: String,
    known_hosts_path: PathBuf,
    sink: Arc<dyn HostKeyRequestSink>,
    prompt_timeout: Duration,
) -> Result<String, ConnectError> {
    // Vor jeder Namensaufloesung und jedem TCP-Aufbau: ein Name, der nie ein
    // Hostname sein kann, darf weder den Resolver noch die TOFU-Rueckfrage
    // erreichen, nach der `format_entry` ihn roh in `known_hosts` schriebe.
    // Alle Verbindungswege laufen hier durch; eine Reparatur nutzt die Spec
    // der schon bestehenden Verbindung.
    usable_hostname(&spec.hostname).map_err(ConnectError::other)?;
    // Vor dem Zerlegen von `spec`: die Meldung zu einem geaenderten
    // Hostschluessel nennt den Host unter seinem Namen in `known_hosts`.
    let host = known_hosts::host_token(&spec.hostname, spec.port);
    let host_spec = HostSpec {
        hostname: spec.hostname,
        port: spec.port,
        user: spec.user,
    };
    let method = resolve_auth_method(spec.key_path, spec.passphrase, spec.password);
    let policy = Arc::new(TofuPolicy::with_control(
        known_hosts_text,
        known_hosts_path,
        state.clone(),
        sink.clone(),
        prompt_timeout,
        attempt.control.clone(),
    ));
    match HostConnection::connect(
        attempt.host_id.clone(),
        host_spec,
        method,
        policy.clone(),
        attempt.control.clone(),
        Arc::new(ConnectionEventSink(sink)),
    )
    .await
    {
        Ok(transport) => attempt.publish(transport),
        Err(error) if error.is::<PairIdentityRejected>() => Err(ConnectError {
            code: "host_key_rejected",
            message: error.to_string(),
        }),
        Err(error) => Err(classify_connect_error(
            &error,
            policy.last_decision(),
            &host,
        )),
    }
}

/// Fehler aus `create_session`, STRUKTURIERT statt als blosser Text.
///
/// Der Grund ist eine Regel, keine Vorliebe: das Frontend muss "dieser Name
/// ist schon vergeben" von jedem anderen Fehlschlag unterscheiden koennen,
/// und die einzige Alternative waere eine Musterung auf Prosa, die dieses
/// Backend formuliert -- eine Kopplung, die bei der naechsten
/// Formulierungsaenderung still bricht.
///
/// Die Grenze dazu, ausgesprochen: eine Musterung auf tmux-EIGENE
/// Fehlertexte hier im Rust-Code ist zulaessig und im Projekt gaengig
/// (`client.rs` mustert auf "duplicate session"). Verboten ist die
/// Musterung im Frontend auf Text, den dieses Backend selbst schreibt.
///
/// `message` bleibt der Rohtext -- fuer "Copy diagnostics", nicht fuer die
/// erste Zeile, die der Nutzer liest.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionError {
    /// Heute genau zwei Werte: `"duplicate"` und `"other"`.
    pub kind: String,
    pub message: String,
}

impl SessionError {
    fn operation(transport: &CommandTransport, error: &anyhow::Error) -> Self {
        let error = operation_error(transport, error);
        Self {
            kind: if error.code == "outcome_unknown" {
                "outcome_unknown"
            } else {
                "other"
            }
            .into(),
            message: error.message,
        }
    }
    fn other(message: impl Into<String>) -> Self {
        Self {
            kind: "other".into(),
            message: message.into(),
        }
    }
    fn duplicate(message: impl Into<String>) -> Self {
        Self {
            kind: "duplicate".into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OperationErrorDto {
    pub code: &'static str,
    pub message: String,
    pub control_generation: u64,
}

impl std::fmt::Display for OperationErrorDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}

fn operation_error(transport: &CommandTransport, error: &anyhow::Error) -> OperationErrorDto {
    let code = if transport.unknown_outcome() {
        "outcome_unknown"
    } else {
        match error.downcast_ref::<ExecError>().map(|error| error.reason) {
            Some(ExecReason::Timeout) => "command_timeout",
            Some(ExecReason::Cancelled) => "command_cancelled",
            Some(ExecReason::Capacity) => "command_capacity",
            Some(ExecReason::Unavailable | ExecReason::Transport) => "control_unavailable",
            Some(ExecReason::OutputLimit | ExecReason::MissingExitStatus) => "incomplete_result",
            _ => "other",
        }
    };
    let message = if code == "outcome_unknown" {
        format!("The remote operation may have taken effect, but its final outcome could not be confirmed. Refresh the session list before trying again. {error}")
    } else {
        error.to_string()
    };
    OperationErrorDto {
        code,
        message,
        control_generation: transport.generation,
    }
}

/// Hostdaten, die in eine Fernzeile gehen -- `cwd`, `path`, Sessionnamen --
/// werden HIER, an der Command-Grenze, geprueft, nicht erst per `assert!` in
/// `remote::build`/`build_in_dir` (Bewertung H6/H9): ein Panic dort haengt
/// den Tauri-`invoke` fuer immer, statt dem WebView ein `Err(...)` zu
/// liefern. `build`/`build_in_dir` selbst bleiben unveraendert -- 30
/// Aufrufer von `build`, aber nur eine Handvoll Stellen, an denen ueberhaupt
/// Hostdaten (statt fest verdrahteter Literale wie `"git"`) hineinfliessen.
///
/// Ein Pfad gilt als akzeptabel, wenn er absolut ist (beginnt mit `/`) und
/// kein Steuerzeichen enthaelt -- NUL wuerde die C-String-Weitergabe in der
/// Shell stumm abschneiden (siehe `remote::command`), ein Zeilenumbruch
/// wuerde das zeilenweise `list_directories`-Protokoll sprengen, und jedes
/// andere Steuerzeichen (z. B. ESC) hat in einem Dateipfad keinen legitimen
/// Grund.
///
/// Die Regel steht an einer Stelle, in `settings::is_absolute_remote_path`:
/// `settings.rs` braucht sie fuer den gespeicherten Arbeitsplatz und kennt
/// `commands.rs` nicht, also ruft diese Funktion jene auf.
pub fn is_acceptable_remote_path(p: &str) -> bool {
    settings::is_absolute_remote_path(p)
}

/// `name`: `None` -> erzeugter Name mit Retry wie bisher. `Some(n)` -> genau
/// dieser Name, EINMAL, ohne Retry.
///
/// Der fehlende Retry ist die eigentliche Entscheidung:
/// `create_session_with_retry` reagiert auf `DuplicateName` mit einem neuen
/// ZUFALLSNAMEN. Liefe ein Nutzername naiv durch diese Schleife, ergaebe ein
/// doppelter Name still eine `ab_xxxxxx`-Session statt einer Meldung -- der
/// Nutzer bekaeme etwas anderes, als er verlangt hat, und erfuehre es nicht.
pub async fn create_session_impl(
    state: &Arc<AppState>,
    host_id: String,
    cwd: String,
    name: Option<String>,
) -> Result<String, SessionError> {
    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
    // Getrimmt VOR der Pruefung, und ein danach leerer Name gilt als "kein
    // Name": `list_session_names` trimmt jede Zeile und filtert leere
    // (`client.rs`) -- ein Name mit Randleerzeichen hiesse in der Liste
    // anders als bei der Anlage, ein Nur-Leerzeichen-Name verschwaende
    // vollstaendig aus jeder Liste.
    let wanted = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());

    // VOR `prepare_server`, und das ist kein Zufall: `prepare_server` setzt
    // `exit-empty off`, und nur ein ERFOLGREICHES `new-session` setzt es in
    // derselben Kommandokette zurueck. Ein hier abgelehnter Name ist ein
    // Endfehler ohne Retry -- lief `prepare_server` vorher, bliebe der
    // Server mit `exit-empty off` stehen und verschwaende nach seiner
    // letzten Session nicht mehr von selbst.
    //
    // Die Pruefung gehoert AUCH hierher und nicht nur ins Formular: das
    // Frontend ist kein Vertrauensanker, und die Zusicherung "ein
    // Sessionname ist nur ein Name" gilt fuer JEDEN Weg, auf dem einer
    // entsteht.
    if let Some(n) = &wanted {
        if !crate::tmux::session_name_is_acceptable(n) {
            return Err(SessionError::other(format!(
                "{}: {n:?}",
                crate::tmux::SESSION_NAME_RULE
            )));
        }
    }

    // H6/H9: VOR dem Host-Lookup, damit dieser Fehlerzweig ohne bestehende
    // Verbindung erreichbar bleibt (siehe Testmodul) -- und damit ein
    // ungueltiges `cwd` nie bis zu `remote::build_in_dir`s `assert!` kommt,
    // wo ein Panic den `invoke` haengen liesse, statt ihn aufzuloesen.
    if !is_acceptable_remote_path(&cwd) {
        return Err(SessionError::other(
            "working directory must be an absolute path without control characters",
        ));
    }

    let transport = state
        .hosts
        .lock()
        .unwrap()
        .get(&host_id)
        .and_then(HostSlot::ready)
        .ok_or_else(|| SessionError::other("host not connected"))?;

    let client = OwnTmuxClient::new(&state.own_socket);
    let transport = transport.command(deadline);
    // Jedes Mal, nicht einmalig gecacht: robuster gegen einen tmux-Server,
    // der zwischen zwei `create_session`-Aufrufen gestorben ist (V21b), auf
    // Kosten von drei zusaetzlichen Roundtrips je Aufruf. Kehrseite: Task
    // 8s bekannte Gefahr ("exit-empty bleibt aus, wenn nach prepare_server
    // nie eine Session gelingt") wird dadurch bei JEDEM Aufruf erneut
    // durchlaufen, nicht nur beim ersten je Host.
    client
        .prepare_server(&transport, settings::default_history())
        .await
        .map_err(|e| SessionError::operation(&transport, &e))?;

    // Ab hier steht `exit-empty` auf "off", und nur ein ERFOLGREICHES
    // `new-session` setzt es in derselben Kommandokette zurueck. JEDER
    // Rueckweg von hier muss es deshalb selbst richten -- deswegen die
    // gemeinsame Auswertung unten statt eines frueheren `return`.
    //
    // Die erste Fassung hatte genau hier eine Luecke: der Zweig mit
    // ERZEUGTEM Namen (der Standardfall, `name: null`) kehrte direkt zurueck
    // und liess `exit-empty` bei jedem seiner Fehlerausgaenge ausgeschaltet.
    // Der Zweig mit getipptem Namen raeumte auf, der haeufigere nicht.
    let outcome = match wanted {
        None => {
            let mut rng = seed_rng();
            create_session_with_retry(&client, &transport, &mut rng, &cwd, MAX_NAME_ATTEMPTS)
                .await
                .map_err(|e| SessionError::operation(&transport, &e))
        }
        Some(wanted) => match client.create_session(&transport, &wanted, &cwd).await {
            Ok(CreateOutcome::Created) => Ok(wanted),
            Ok(CreateOutcome::DuplicateName) => Err(SessionError::duplicate(format!(
                "a session named {wanted:?} already exists on this host"
            ))),
            Err(e) => Err(SessionError::operation(&transport, &e)),
        },
    };

    if outcome.is_err() && transport.can_cleanup() {
        // Ohne diese Zeile bliebe der Server auch nach seiner letzten
        // Session stehen -- gegen die Zusage in `prepare_server`s Kommentar,
        // und mit "Session beenden" (B3) sichtbar. Ein Fehlschlag beim
        // Zuruecksetzen darf die Meldung an den Nutzer nicht ersetzen: sie
        // ist die wichtigere.
        //
        // UNGEPINNT, und das steht hier, statt verschwiegen zu werden:
        // dieser Block ersatzlos entfernt macht KEINEN Test rot -- gemessen,
        // nicht vermutet. Der Grund ist strukturell, nicht Nachlaessigkeit:
        // die Wirkung ist eine GLOBALE Serveroption, `create_session_impl`
        // legt fest auf `state.own_socket` an, und `state.hosts`
        // haelt einen konkreten `Arc<RusshTransport>` -- ein abgespielter
        // Transport laesst sich hier nicht einsetzen. Ein VM-Test darauf
        // kippte unter der parallelen Suite (siehe
        // `integration_commands.rs`, wo die Sonde stand).
        //
        // Was deckt: `restore_exit_empty_sets_the_option_back_to_on`
        // (VM-frei) prueft die Kommandozeile, und dieser EINE gemeinsame
        // Fehlerausgang macht die Stelle an einem Ort lesbar statt an zwei.
        // Was nicht deckt: dass er faellt. Wer das aendern will, braucht
        // einen einsetzbaren Socket in `create_session_impl` -- das waere
        // eine Aenderung an der Produktionsschnittstelle fuer einen Test,
        // und die ist bewusst nicht gemacht worden.
        if let Err(cleanup) = client.restore_exit_empty(&transport).await {
            if transport.unknown_outcome() {
                let original = outcome.as_ref().err().unwrap();
                let mut error = SessionError::operation(&transport, &cleanup);
                error.message = format!("{} Cleanup outcome: {}", original.message, error.message);
                return Err(error);
            }
        }
    }
    outcome
}

/// Oeffnet ueber den Namen, ohne Bindung und damit ohne Verlauf (Spec
/// §5.6); der Command selbst geht ueber `open_terminal_tagged_impl`.
pub async fn open_terminal_impl<S: OutputSink>(
    state: &Arc<AppState>,
    sink: S,
    host_id: String,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let open_id = format!(
        "internal-{}",
        state.next_generation.fetch_add(1, Ordering::Relaxed)
    );
    open_terminal_tagged_impl(
        state,
        sink,
        host_id,
        SocketKind::App,
        session,
        cols,
        rows,
        open_id,
        None,
    )
    .await
}

fn fresh_attach_nonce() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{n:032x}")
}

fn remaining_control(control: &OperationControl) -> Duration {
    control
        .deadline()
        .saturating_duration_since(tokio::time::Instant::now())
}

async fn open_confirmed_pty(
    host: &Arc<HostConnection>,
    socket: &TmuxSocket,
    selected: PaneIdentity,
    cols: u16,
    rows: u16,
    control: OperationControl,
) -> Result<crate::transport::PtyHandle, String> {
    let commands = host.command_sharing(control.clone());
    let named = commands
        .exec_with_deadline(
            &named_probe(socket.name(), selected).map_err(|error| error.to_string())?,
            remaining_control(&control),
        )
        .await
        .map_err(|error| error.to_string())?;
    let absolute = commands
        .exec_with_deadline(
            &absolute_probe(&named, selected).map_err(|error| error.to_string())?,
            remaining_control(&control),
        )
        .await
        .map_err(|error| error.to_string())?;
    let binding = SocketBinding::from_responses(&named, &absolute, selected, socket.kind())
        .map_err(|error| error.to_string())?;
    let nonce = fresh_attach_nonce();
    let attach = binding
        .attach_command(&nonce)
        .map_err(|error| error.to_string())?;
    let pending = host
        .terminal()
        .open_attach_pending(attach, cols, rows, control.clone(), Some(&nonce))
        .await
        .map_err(|error| error.to_string())?;
    let wrapper = pending
        .wait_wrapper()
        .await
        .ok_or_else(|| "attach wrapper was not confirmed".to_string())?;
    let process = commands
        .exec_with_deadline(&process_command(&wrapper), remaining_control(&control))
        .await
        .map_err(|error| error.to_string())?;
    verify_process(&process, &wrapper).map_err(|error| error.to_string())?;
    const J_ATTEMPTS: u32 = 64;
    const J_GAP: Duration = Duration::from_millis(20);
    let mut registered = false;
    for attempt in 0..J_ATTEMPTS {
        let leftover = remaining_control(&control);
        if leftover.is_zero() {
            break;
        }
        let clients = commands
            .exec_with_deadline(&binding.clients_command(), leftover)
            .await
            .map_err(|error| error.to_string())?;
        let rows = parse_clients(&clients, wrapper.pid).map_err(|error| error.to_string())?;
        if registration_ready(registered_with_process(&rows, &wrapper, selected, &process))
            .map_err(|error| error.to_string())?
        {
            registered = true;
            break;
        }
        if attempt + 1 == J_ATTEMPTS {
            break;
        }
        let gap = J_GAP.min(remaining_control(&control));
        if gap.is_zero() {
            break;
        }
        tokio::time::sleep(gap).await;
    }
    if !registered {
        return Err("attach wrapper was not a registered client".into());
    }
    let list = binding.query().list_command();
    let resolve = binding.query().resolve_command(selected.session_id);
    let inventory = binding.query().inventory().command();
    let l0 = commands
        .exec_with_deadline(&list, remaining_control(&control))
        .await
        .map_err(|error| error.to_string())?;
    let r0 = commands
        .exec_with_deadline(&resolve, remaining_control(&control))
        .await
        .map_err(|error| error.to_string())?;
    let inv = commands
        .exec_with_deadline(&inventory, remaining_control(&control))
        .await
        .map_err(|error| error.to_string())?;
    let r1 = commands
        .exec_with_deadline(&resolve, remaining_control(&control))
        .await
        .map_err(|error| error.to_string())?;
    let l1 = commands
        .exec_with_deadline(&list, remaining_control(&control))
        .await
        .map_err(|error| error.to_string())?;
    binding
        .confirm_inventory(&[l0, r0, inv, r1, l1])
        .map_err(|error| error.to_string())?;
    Ok(pending.confirm())
}

/// Woher `open_terminal` den Verlauf holt (Spec §5.6): nur die Pane-Id aus
/// der Sessionbindung fuehrt zu einer Erfassung. Die Frist ist ein Feld,
/// damit die Tests nicht die vollen zwei Sekunden warten.
#[derive(Debug, Clone, Copy)]
struct HistoryRequest {
    pane_id: u32,
    timeout: Duration,
}

/// Spec §5.6, Restzeit: die Frist der Erfassung, wenn vom Oeffnen MEHR als
/// diese Frist plus `HISTORY_RESERVE` uebrig ist; sonst `None` (ohne
/// Verlauf oeffnen). So endet die Frist der Erfassung immer vor der des
/// Oeffnens: `CommandTransport::execute` gibt ihr eine eigene, kuerzere
/// Operation, deren Ablauf die des Oeffnens nicht beruehrt, und die Reserve
/// bleibt fuer die Veroeffentlichung. Ohne diese Pruefung liefe die Erfassung
/// kurz vor Ablauf auf der Operation des Oeffnens selbst; ihr Ablauf liesse
/// dann die Veroeffentlichung scheitern. Unberuehrt bleibt: Laeuft die eigene
/// Frist schon beim Kanaloeffnen ab, bricht der Exec wie jeder befristete
/// Befehl die Steuerverbindung ab (§5.1); das Terminal oeffnet trotzdem.
fn history_budget(remaining: Duration, timeout: Duration) -> Option<Duration> {
    (remaining > timeout.saturating_add(HISTORY_RESERVE)).then_some(timeout)
}

/// Antwort von `kill_session` auf dem Standard-Socket: Die App beendet dort
/// nichts (Spec 2026-10-25 §3, §6.5).
pub const FOREIGN_SESSION: &str = "foreign_session";

/// Antwort von `open_terminal` auf dem Standard-Socket ohne numerische
/// Bindung: Dort haengt die App nur ueber den Waechter an (Spec 2026-10-25
/// §6.4).
pub const FOREIGN_UNBOUND: &str = "foreign_unbound";

/// Spec §5.6: Verlauf nur mit der Pane-Id aus der Sessionbindung.
fn history_request_for(selected: Option<PaneIdentity>) -> Option<HistoryRequest> {
    selected.map(|selected| HistoryRequest {
        pane_id: selected.pane_id.0,
        timeout: HISTORY_TIMEOUT,
    })
}

/// `_impl` des Commands `open_terminal`. Mit `selected` (der numerischen
/// Bindung aus `list_sessions`) haengt es bestaetigt an und liefert den
/// Verlauf der Pane mit (Spec §5.6); ohne Bindung oeffnet es ueber den Namen
/// und ohne Verlauf.
#[allow(clippy::too_many_arguments)]
pub async fn open_terminal_tagged_impl<S: OutputSink>(
    state: &Arc<AppState>,
    sink: S,
    host_id: String,
    socket: SocketKind,
    session: String,
    cols: u16,
    rows: u16,
    open_id: String,
    selected: Option<PaneIdentity>,
) -> Result<(), String> {
    let history = history_request_for(selected);
    open_terminal_with_history(
        state, sink, host_id, socket, session, cols, rows, open_id, selected, history,
    )
    .await
}

/// Liest den Verlauf ueber die Steuerverbindung: ein einziger verzichtbarer
/// tmux-Aufruf im Rahmen dieses Oeffnens (Spec §5.6). Er teilt dessen
/// Operation, ein `close_terminal` bricht ihn also mit ab. Dass seine eigene,
/// kuerzere Frist diese Operation unberuehrt laesst, stellt der Aufrufer mit
/// `history_budget` sicher.
///
/// Jeder Fehler, jede Fristueberschreitung und jede unerwartete Antwort heisst
/// "ohne Verlauf"; das Oeffnen scheitert daran nicht. Den Steuerzustand
/// aendert ein gescheiterter Befehl auf nutzbarem Transport seit Task 1 nicht.
/// Unerwartet ist auch ungueltiges UTF-8: `stdout` waere dann nur eine
/// verlustbehaftete Umwandlung der Bytes.
///
/// Bekannte Grenze, vorerst hingenommen: Eine Rohantwort ueber der
/// Exec-Grenze von 4 MiB scheitert als `OutputLimit` und verwirft damit den
/// GANZEN Verlauf, statt wie `prepare_history` die neuesten 2 MiB zu behalten.
async fn capture_history(
    host: &Arc<HostConnection>,
    socket: &TmuxSocket,
    request: HistoryRequest,
    rows: u16,
    control: OperationControl,
) -> Option<Vec<u8>> {
    let argv = crate::tmux::history::history_command(socket, request.pane_id);
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    let result = host
        .command_sharing(control)
        .exec_with_deadline(&crate::remote::build(&argv), request.timeout)
        .await
        .ok()?;
    if result.code != 0 || !result.utf8_valid {
        return None;
    }
    crate::tmux::history::prepare_history(&result.stdout, rows, HISTORY_MAX_BYTES)
}

#[allow(clippy::too_many_arguments)]
async fn open_terminal_with_history<S: OutputSink>(
    state: &Arc<AppState>,
    sink: S,
    host_id: String,
    socket: SocketKind,
    session: String,
    cols: u16,
    rows: u16,
    open_id: String,
    selected: Option<PaneIdentity>,
    history: Option<HistoryRequest>,
) -> Result<(), String> {
    if session.is_empty() || session.chars().any(char::is_control) {
        return Err("invalid session name".into());
    }
    if open_id.is_empty()
        || open_id.len() > 128
        || !open_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid terminal opening identifier".into());
    }
    // Auf dem Standard-Socket nur ueber den Waechter, also nur mit Bindung;
    // ueber den Namen haengt die App nur am eigenen Socket an.
    if socket == SocketKind::Default && selected.is_none() {
        return Err(FOREIGN_UNBOUND.into());
    }
    let tmux_socket = state.tmux_socket(socket);
    let host = state
        .hosts
        .lock()
        .unwrap()
        .get(&host_id)
        .and_then(HostSlot::ready)
        .ok_or_else(|| "host not connected".to_string())?;
    let attempt = TerminalAttempt::reserve(state, &host_id, socket, &session, &open_id, &host)?;
    let mut pty = if let Some(selected) = selected {
        open_confirmed_pty(
            &host,
            &tmux_socket,
            selected,
            cols,
            rows,
            attempt.control.clone(),
        )
        .await?
    } else {
        host.terminal()
            .open_attach_controlled(
                &state.own_socket,
                &session,
                cols,
                rows,
                attempt.control.clone(),
            )
            .await
            .map_err(|error| error.to_string())?
    };
    // Spec §5.6: erfasst wird nach dem bestaetigten Attach. Der Attach bringt
    // das Fenster auf die Kachelgroesse, und tmux schiebt dabei Zeilen
    // zwischen Verlauf und Bildschirm (gemessen mit tmux 3.6: von 24 auf 40
    // Zeilen holt es 16 aus dem Verlauf, von 40 auf 12 schiebt es 28 hinein).
    // Vorher erfasst, stuenden sie doppelt oder fehlten, bei jedem Maximieren
    // und Wiederherstellen. Das Neuzeichnen wartet so lange unweitergeleitet
    // im Kanal. Preis: Was zwischen Neuzeichnen und Erfassen ausgegeben wird,
    // steht doppelt, und so lange fuellt sich der Kanalpuffer ohne Abnehmer.
    // Ohne genug Restzeit (Spec §5.6) oeffnet das Terminal ohne Verlauf.
    let history = history.and_then(|request| {
        history_budget(remaining_control(&attempt.control), request.timeout)
            .map(|timeout| HistoryRequest { timeout, ..request })
    });
    let history = match history {
        Some(request) => {
            capture_history(&host, &tmux_socket, request, rows, attempt.control.clone()).await
        }
        None => None,
    };
    let rx = pty.take_output();
    let pty = Arc::new(pty);
    let ack = Arc::new(AckGate::new(ACK_WINDOW_BYTES));
    let cancel = Arc::new(Notify::new());
    let generation = attempt.generation;
    let key = attempt.key.clone();
    let pump = TerminalPump {
        state: Arc::downgrade(state),
        sink,
        host_id: host_id.clone(),
        session,
        key: key.clone(),
        open_id: open_id.clone(),
        generation,
        ack: ack.clone(),
        cancel: cancel.clone(),
        history,
        rx,
    };
    // Register the pump and publish under the same gate used by invalidation.
    // A scheduled pump cannot emit before it finds this exact live entry.
    let publication = {
        let mut terms = state.terminals.lock().unwrap();
        let hosts = state.hosts.lock().unwrap();
        let current = hosts.get(&host_id).and_then(HostSlot::ready);
        if current.is_some_and(|current| Arc::ptr_eq(&current, &host))
            && terms
                .pending
                .get(&key)
                .is_some_and(|pending| pending.generation == generation)
        {
            attempt
                .control
                .with_active(|| {
                    host.start_pump(pump.run())
                        .map_err(|error| error.to_string())?;
                    terms.pending.remove(&key);
                    terms.insert(
                        key,
                        OpenTerminal {
                            pty: pty.clone(),
                            ack,
                            cancel,
                            generation,
                            open_id,
                        },
                    );
                    Ok(())
                })
                .map_err(|error| error.to_string())
                .and_then(|result| result)
        } else {
            Err("terminal setup was cancelled or replaced".into())
        }
    };
    if publication.is_err() {
        pty.request_close();
    }
    publication
}

struct TerminalPump<S> {
    state: std::sync::Weak<AppState>,
    sink: S,
    host_id: String,
    session: String,
    key: String,
    open_id: String,
    generation: u64,
    ack: Arc<AckGate>,
    cancel: Arc<Notify>,
    /// Aufbereiteter Verlauf dieser Oeffnung (Spec §5.6), `None` ohne.
    history: Option<Vec<u8>>,
    rx: crate::transport::russh_transport::PtyOutputReceiver,
}

impl<S: OutputSink> TerminalPump<S> {
    async fn run(mut self) {
        // Spec §5.6: Der Verlauf sind die ERSTEN `terminal://output`-
        // Ereignisse dieser `open_id`, in Stuecken von hoechstens 32 KiB.
        // Die Reihenfolge haelt diese eine Aufgabe selbst: aus `rx` liest sie
        // erst danach, bis dahin staut der begrenzte Kanal die Kanaldaten wie
        // bei jedem Rueckstau. Ein Rueckgabewert von `open_terminal` liefe
        // dagegen um die Wette mit dieser Pumpe.
        let mut open = true;
        if let Some(history) = self.history.take() {
            for chunk in history.chunks(HISTORY_CHUNK_BYTES) {
                if !self.forward(chunk.to_vec()).await {
                    open = false;
                    break;
                }
            }
        }
        while open {
            let bytes = tokio::select! {
                biased;
                _ = self.cancel.notified() => break,
                bytes = self.rx.recv() => match bytes { Some(bytes) => bytes, None => break },
            };
            open = self.forward(bytes).await;
        }
        if let Some(state) = self.state.upgrade() {
            let mut terms = state.terminals.lock().unwrap();
            let hosts = state.hosts.lock().unwrap();
            if owns_current_entry(
                terms.get(&self.key).map(|entry| entry.generation),
                self.generation,
            ) {
                if let Some(entry) = terms.remove(&self.key) {
                    close_entry(entry);
                }
                if hosts.get(&self.host_id).and_then(HostSlot::ready).is_some() {
                    self.sink
                        .connection_lost_open(&self.host_id, &self.session, &self.open_id);
                }
            }
        }
    }

    /// Ein Stueck an den WebView, fuer Verlauf und Kanaldaten derselbe Weg:
    /// erst Kredit im Ack-Fenster (mit Abbruchsignal und Stillstandswaechter),
    /// dann nur, solange der Eintrag noch dieser Oeffnung gehoert und der Host
    /// lebt. `false` beendet die Pumpe; das Aufraeumen in `run` folgt.
    async fn forward(&self, bytes: Vec<u8>) -> bool {
        match wait_for_room_cancel_or_stall(
            &self.ack,
            &self.cancel,
            bytes.len() as u64,
            STALL_TIMEOUT,
        )
        .await
        {
            PumpDecision::Proceed => {}
            PumpDecision::Cancelled | PumpDecision::Stalled => return false,
        }
        let Some(state) = self.state.upgrade() else {
            return false;
        };
        let terms = state.terminals.lock().unwrap();
        let hosts = state.hosts.lock().unwrap();
        terms
            .get(&self.key)
            .is_some_and(|entry| entry.generation == self.generation)
            && hosts.get(&self.host_id).and_then(HostSlot::ready).is_some()
            && self
                .sink
                .send_open(&self.host_id, &self.session, &self.open_id, bytes)
    }
}
// Task 10, Nachtrag (gemeldeter, damals bewusst nicht behobener Fund):
// `send_input_impl` und `resize_terminal_impl` hielten den
// `state.terminals`-Guard bislang ueber eine GEWOEHNLICHE `let`-Bindung
// (kein `if let`/`while let`/`match`-Scrutinee -- `clippy::
// significant_drop_in_scrutinee` greift hier deshalb nicht) bis zum Ende
// der Funktion, also ueber `pty.write(..).await` bzw. `pty.resize(..).await`
// hinweg. Waehrend diese Sperre gehalten wird, kann KEINE andere
// Terminal-Operation auf IRGENDEINER Session laufen -- `open_terminal`,
// `close_terminal`, `send_input`/`resize_terminal` auf jeder anderen
// Session, sogar `ack_output_impl`.
//
// Wie langsam `pty.write()`/`pty.resize()` tatsaechlich werden koennen:
// GEPRUEFT, nicht angenommen. Die ursprüngliche Vermutung -- die
// Ack-Rueckstaubremse (Spec §9.1) lasse ueber ein ausgehungertes
// SSH-Empfangsfenster auch `pty.write()` auf DERSELBEN Session blockieren
// -- wurde gezielt gegen die echte Test-VM geprueft (Session geflutet,
// NIE geackt, danach `send_input_impl` auf genau dieser Session
// aufgerufen) und NICHT bestaetigt: der Aufruf kehrte nach ~125
// Mikrosekunden zurueck, nicht blockiert. Das ist beim Nachdenken auch
// plausibel: SSH-Kanal-Flusskontrolle ist PRO RICHTUNG unabhaengig
// (RFC 4254) -- ein ausgehungertes Server-zu-Client-Fenster (unser
// Ack-Rueckstand) muss das Client-zu-Server-Fenster (unsere Eingaben)
// nicht mitbetreffen. Die eigentliche Gefahr bleibt trotzdem real, nur
// allgemeiner: `pty.write()`/`pty.resize()` sind fremdes Netzwerk-I/O
// (SSH-Kanalschreiben) und koennen aus ANDEREN Gruenden blockieren --
// eine haengende/degradierte Verbindung, ein volles TCP-Sendefenster auf
// dem gemeinsamen Verbindungs-Socket, o.ae. --, genau wie
// `disconnect_host_impl`s `hosts`-Fund fuer den "haengenden
// Netzwerk-Close"-Fall bereits zeigte. Haelt `state.terminals` in so
// einem Moment noch die Sperre, blockiert das trotzdem JEDE andere
// Terminal-Operation auf JEDER Session -- der Fix unten ist deshalb
// unabhaengig vom genauen Ausloeser richtig.
//
// Fix: NUR ein `Arc::clone()` des `PtyHandle` verlaesst den Block, in dem
// die Sperre gehalten wird -- der `MutexGuard` `terms` faellt an dessen
// Ende (letzte Zeile vor der schliessenden Klammer), also VOR dem
// `.await`. Das erfordert `OpenTerminal::pty: Arc<PtyHandle>` statt eines
// nackten `PtyHandle` (siehe dortigen Kommentar) -- ein `PtyHandle`
// selbst ist nicht `Clone` (`ChannelWriteHalf` hat keine oeffentlichen
// Felder, aus denen sich ausserhalb von russh ein Klon bauen liesse).
pub async fn send_input_impl(
    state: &Arc<AppState>,
    host_id: String,
    session: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    send_input_tagged_impl(state, host_id, SocketKind::App, session, bytes, None).await
}

pub async fn send_input_tagged_impl(
    state: &Arc<AppState>,
    host_id: String,
    socket: SocketKind,
    session: String,
    bytes: Vec<u8>,
    open_id: Option<String>,
) -> Result<(), String> {
    let key = session_key(&host_id, socket, &session);
    let pty = {
        let terms = state.terminals.lock().unwrap();
        terms
            .get(&key)
            .filter(|entry| open_id.as_ref().is_none_or(|id| entry.open_id == *id))
            .map(|entry| entry.pty.clone())
            .ok_or_else(|| "no terminal open for this session".to_string())?
    };
    pty.write(&bytes).await.map_err(|e| e.to_string())
}

/// Dieselbe Form und derselbe Fix wie `send_input_impl` direkt oberhalb --
/// siehe dessen Kommentar.
pub async fn resize_terminal_impl(
    state: &Arc<AppState>,
    host_id: String,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    resize_terminal_tagged_impl(state, host_id, SocketKind::App, session, cols, rows, None).await
}

pub async fn resize_terminal_tagged_impl(
    state: &Arc<AppState>,
    host_id: String,
    socket: SocketKind,
    session: String,
    cols: u16,
    rows: u16,
    open_id: Option<String>,
) -> Result<(), String> {
    let key = session_key(&host_id, socket, &session);
    let pty = {
        let terms = state.terminals.lock().unwrap();
        terms
            .get(&key)
            .filter(|entry| open_id.as_ref().is_none_or(|id| entry.open_id == *id))
            .map(|entry| entry.pty.clone())
            .ok_or_else(|| "no terminal open for this session".to_string())?
    };
    pty.resize(cols, rows).await.map_err(|e| e.to_string())
}

/// `byte_count` ist INKREMENTELL (die Groesse des gerade verarbeiteten
/// Datenpakets), NICHT kumulativ ueber die gesamte Sitzung -- passend zu
/// Spec §9.1s `term.write(chunk, () => invoke('ack', …))`: ein Aufruf je
/// `write()`-Callback, mit der Laenge dieses einen Pakets. Ein kuenftiger
/// Frontend-Code (Task 11), der stattdessen die kumulative Summe schickt,
/// wuerde `in_flight` zu schnell leerlaufen lassen und die Bremse
/// stillschweigend abschalten -- kein Test hier kann das erkennen, weil
/// Task 10 den Frontend-Code nicht schreibt. Muss in Task 11 eingehalten
/// werden.
pub async fn ack_output_impl(
    state: &Arc<AppState>,
    host_id: String,
    session: String,
    byte_count: u32,
) -> Result<(), String> {
    ack_output_tagged_impl(state, host_id, SocketKind::App, session, byte_count, None)
}

pub fn ack_output_tagged_impl(
    state: &Arc<AppState>,
    host_id: String,
    socket: SocketKind,
    session: String,
    byte_count: u32,
    open_id: Option<String>,
) -> Result<(), String> {
    let key = session_key(&host_id, socket, &session);
    let terms = state.terminals.lock().unwrap();
    // Kein Eintrag: der Kanal wurde bereits abgebaut (Pumpe, close, disconnect).
    // Ein Ack, das aus dem write()-Callback des WebView nachlaeuft, ist dann
    // kein Fehler -- dieselbe Idempotenz wie disconnect_host_impl.
    if let Some(entry) = terms
        .get(&key)
        .filter(|entry| open_id.as_ref().is_none_or(|id| entry.open_id == *id))
    {
        entry.ack.ack(byte_count as u64);
    }
    Ok(())
}

/// Cancels pending opens and published output for this session. The tagged
/// renderer path affects only its own opening; session-level callers explicitly
/// invalidate the current local intent. Remote tmux processes keep running.
pub async fn close_terminal_impl(
    state: &Arc<AppState>,
    host_id: String,
    session: String,
) -> Result<(), String> {
    close_terminal_tagged_impl(state, host_id, SocketKind::App, session, None)
}

pub fn close_terminal_tagged_impl(
    state: &Arc<AppState>,
    host_id: String,
    socket: SocketKind,
    session: String,
    open_id: Option<String>,
) -> Result<(), String> {
    let key = session_key(&host_id, socket, &session);
    invalidate_terminal(
        &mut state.terminals.lock().unwrap(),
        &key,
        open_id.as_deref(),
    );
    Ok(())
}

/// Beendet die tmux-Session auf dem Host -- die Sitzung selbst, samt allem,
/// was darin laeuft. Das Gegenstueck zu `close_terminal_impl`, das
/// ausdruecklich NUR die Ansicht schliesst.
///
/// **Der VIERTE gewollte Schliesspfad**, und damit ein Fall fuer die
/// Invariante an `OutputSink::connection_lost`: der Eintrag wird entfernt
/// und der Kanal geschlossen, BEVOR `kill-session` faellt. Ohne das stirbt
/// der Attach-Kanal serverseitig, waehrend die Pumpaufgabe ihren Eintrag
/// noch besitzt -- sie meldete `connection-lost`, und der Nutzer bekaeme
/// eine Sperrleiste auf einer Sitzung, die er gerade selbst beendet hat.
///
/// The remote command must succeed or report this exact target absent.
/// Then a successful list query must confirm its absence. Errors in either
/// operation stay errors; a failed verification never means an empty host.
pub async fn kill_session_impl(
    state: &Arc<AppState>,
    host_id: String,
    socket: SocketKind,
    session: String,
    session_id: Option<u32>,
    server_pid: Option<u32>,
    server_start_time: Option<u64>,
) -> Result<(), String> {
    // Vor allem anderen: Kein Terminaleintrag und kein tmux-Aufruf fuer eine
    // Session des Standard-Sockets (Spec 2026-10-25 §6.5).
    if socket == SocketKind::Default {
        return Err(FOREIGN_SESSION.into());
    }
    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
    // H6/H9, dieselbe Ausnahme von der Allowlist wie in `open_terminal_impl`
    // -- Begruendung dort: von Hand angelegte Sessions duerfen Punkte und
    // Nicht-ASCII tragen und muessen sich trotzdem beenden lassen, nur
    // Steuerzeichen und der leere Name werden hier abgelehnt.
    if session.is_empty() || session.chars().any(|c| c.is_control()) {
        return Err("invalid session name".into());
    }

    let transport = state
        .hosts
        .lock()
        .unwrap()
        .get(&host_id)
        .and_then(HostSlot::ready)
        .ok_or_else(|| "host not connected".to_string())?;

    // VOR dem Toeten, siehe Doc-Kommentar. Dasselbe Muster wie
    // `close_terminal_impl` -- erst binden, damit der Guard am `;` faellt.
    let key = session_key(&host_id, socket, &session);
    invalidate_terminal(&mut state.terminals.lock().unwrap(), &key, None);

    let transport = transport.command(deadline);

    let client = OwnTmuxClient::new(&state.own_socket);
    match (session_id, server_pid, server_start_time) {
        (Some(session_id), Some(server_pid), Some(server_start_time)) => {
            kill_session_bound_and_verify(
                &client,
                &transport,
                crate::tmux::inventory::ServerIdentity {
                    pid: server_pid,
                    start_time: server_start_time,
                },
                crate::tmux::inventory::SessionId(session_id),
                deadline,
            )
            .await
            .map_err(|e| operation_error(&transport, &e).message)
        }
        _ => kill_session_and_verify(&client, &transport, &session)
            .await
            .map_err(|e| operation_error(&transport, &e).message),
    }
}

/// Keep the mutation and its verification together, with an injectable
/// transport so false-success cases are covered without a live host.
async fn kill_session_and_verify(
    client: &OwnTmuxClient,
    transport: &dyn Transport,
    session: &str,
) -> anyhow::Result<()> {
    client.kill_session(transport, session).await?;
    let remaining = client.list_session_names(transport).await?;
    if remaining.iter().any(|n| n == session) {
        anyhow::bail!(
            "the session {session:?} is still running on the host after the request to end it"
        );
    }
    Ok(())
}

/// Ein gebundener Kill, dessen Ende sich nicht pruefen liess.
const UNVERIFIED_BOUND_KILL: &str = "the end of the selected session could not be verified; \
     it may already have ended. Refresh the session list before trying again.";

async fn kill_session_bound_and_verify(
    client: &OwnTmuxClient,
    transport: &dyn Transport,
    server: crate::tmux::inventory::ServerIdentity,
    session: crate::tmux::inventory::SessionId,
    deadline: tokio::time::Instant,
) -> anyhow::Result<()> {
    client
        .kill_session_bound(transport, server, session)
        .await?;
    // Die Pruefliste braucht eine gemessene Version. Scheitert die Abfrage
    // oder ist die Antwort ungemessen, bleibt das Ende unbewiesen: ein
    // Fehler, nie ein Erfolg. Hat tmux den Kill mit "no server" quittiert,
    // kommt die Meldung ohne den Vorsatz zum offenen Ausgang beim Nutzer an;
    // sie sagt deshalb selbst, dass die Session schon beendet sein kann.
    let version = transport
        .exec_with_deadline(&client.version_command(), COMMAND_TIMEOUT)
        .await
        .map_err(|error| error.context(UNVERIFIED_BOUND_KILL))?;
    let Some(version) = MeasuredVersion::from_response(&version) else {
        anyhow::bail!(UNVERIFIED_BOUND_KILL);
    };
    let observed = match client.observe_sessions(transport, version, deadline).await {
        Ok(observed) => observed,
        // Ending the last session took the server with it: nothing is left.
        Err(error) if error.is::<ServerAbsent>() => return Ok(()),
        Err(error) => return Err(error),
    };
    if observed
        .sessions
        .iter()
        .any(|row| row.session_id == session)
    {
        anyhow::bail!("the selected session is still present after the request to end it");
    }
    Ok(())
}

/// Schliesst alle offenen Terminals eines Hosts und die Verbindung selbst.
/// Ohne diesen Befehl gaebe es innerhalb eines Anwendungslaufs keinen Weg,
/// eine `RusshTransport`-Verbindung je wieder loszuwerden.
pub async fn disconnect_host_impl(state: &Arc<AppState>, host_id: String) -> Result<(), String> {
    let slot = {
        let mut hosts = state.hosts.lock().unwrap();
        let slot = hosts.remove(&host_id);
        if let Some(control) = slot.as_ref().and_then(HostSlot::control) {
            control.cancel();
        }
        if let Some(HostSlot::Ready(host)) = &slot {
            host.abort();
        }
        slot
    };
    // Stop socket IO before waiting for channel cleanup. Pending connect
    // attempts and successful transports share the same removal point.
    {
        let mut terms = state.terminals.lock().unwrap();
        let keys: Vec<String> = terms
            .keys()
            .chain(terms.pending.keys())
            .filter(|key| belongs_to_host(key, &host_id))
            .cloned()
            .collect();
        for key in keys {
            invalidate_terminal(&mut terms, &key, None);
        }
    }
    if let Some(HostSlot::Ready(transport)) = slot {
        transport.dispose().await;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Tauri-Commands: duenne Huellen um die `_impl`-Funktionen oben.
// ---------------------------------------------------------------------

#[tauri::command]
pub fn begin_connect(state: State<'_, Arc<AppState>>) -> Result<String, ConnectError> {
    begin_connect_impl(state.inner())
}

/// Only fresh authentication crosses this IPC boundary. Endpoint, user, socket
/// and trusted host key remain those of the existing runtime host.
#[derive(serde::Deserialize)]
pub struct RepairAuthDto {
    pub key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<zeroize::Zeroizing<String>>,
    #[serde(default)]
    pub password: Option<zeroize::Zeroizing<String>>,
}

fn ready_host(state: &Arc<AppState>, host_id: &str) -> Result<Arc<HostConnection>, ConnectError> {
    state
        .hosts
        .lock()
        .unwrap()
        .get(host_id)
        .and_then(HostSlot::ready)
        .ok_or_else(|| ConnectError::other("host not connected"))
}

pub fn begin_control_repair_impl(
    state: &Arc<AppState>,
    host_id: String,
) -> Result<u64, ConnectError> {
    ready_host(state, &host_id)?
        .begin_repair()
        .map_err(|error| ConnectError::other(error.to_string()))
}

pub fn cancel_control_repair_impl(
    state: &Arc<AppState>,
    host_id: String,
    control_generation: u64,
) -> Result<(), ConnectError> {
    if let Ok(host) = ready_host(state, &host_id) {
        host.cancel_repair(control_generation);
    }
    Ok(())
}

pub async fn repair_control_impl(
    state: &Arc<AppState>,
    host_id: String,
    control_generation: u64,
    auth: RepairAuthDto,
) -> Result<(), ConnectError> {
    let host = ready_host(state, &host_id)?;
    let mut attempt = host
        .take_repair(control_generation)
        .map_err(|error| ConnectError::other(error.to_string()))?;
    let known_hosts_path = dirs::home_dir()
        .ok_or_else(|| ConnectError::other("could not determine home directory"))?
        .join(".ssh")
        .join("known_hosts");
    let known_hosts = attempt
        .control
        .wait_total(read_known_hosts_text(&known_hosts_path))
        .await
        .map_err(connect_failure)?
        .map_err(ConnectError::other)?;
    let method = resolve_auth_method(auth.key_path, auth.passphrase, auth.password);
    match attempt.connect(method, known_hosts).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let classified = if error.is::<PairIdentityRejected>() {
                ConnectError {
                    code: "host_key_rejected",
                    message: error.to_string(),
                }
            } else {
                // Die Reparatur kennt keine TOFU-Entscheidung (ein anderer
                // Hostschluessel endet oben als `PairIdentityRejected`), also
                // ist sie immer `None`, und `host` wird nie gelesen.
                classify_connect_error(&error, None, "")
            };
            attempt.fail(
                matches!(
                    classified.code,
                    "password_required" | "passphrase_required" | "auth_rejected"
                ),
                &classified.message,
            );
            Err(classified)
        }
    }
}

#[tauri::command]
pub fn begin_control_repair(
    state: State<'_, Arc<AppState>>,
    host_id: String,
) -> Result<u64, ConnectError> {
    begin_control_repair_impl(state.inner(), host_id)
}

#[tauri::command]
pub fn cancel_control_repair(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    control_generation: u64,
) -> Result<(), ConnectError> {
    cancel_control_repair_impl(state.inner(), host_id, control_generation)
}

#[tauri::command]
pub async fn repair_control(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    control_generation: u64,
    auth: RepairAuthDto,
) -> Result<(), ConnectError> {
    repair_control_impl(state.inner(), host_id, control_generation, auth).await
}

#[tauri::command]
pub async fn connect_host(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    host_id: String,
    spec: HostSpecDto,
) -> Result<String, ConnectError> {
    connect_host_impl(state.inner(), Arc::new(app), host_id, spec).await
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    cwd: String,
    name: Option<String>,
) -> Result<String, SessionError> {
    create_session_impl(state.inner(), host_id, cwd, name).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_terminal(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    host_id: String,
    session: String,
    cols: u16,
    rows: u16,
    open_id: String,
    session_id: Option<u32>,
    server_pid: Option<u32>,
    server_start_time: Option<u64>,
    window_id: Option<u32>,
    pane_id: Option<u32>,
    pane_pid: Option<u32>,
    socket: Option<SocketKind>,
) -> Result<(), String> {
    let selected = match (
        session_id,
        server_pid,
        server_start_time,
        window_id,
        pane_id,
        pane_pid,
    ) {
        (
            Some(session_id),
            Some(server_pid),
            Some(server_start_time),
            Some(window_id),
            Some(pane_id),
            Some(pane_pid),
        ) => Some(PaneIdentity {
            server: ServerIdentity {
                pid: server_pid,
                start_time: server_start_time,
            },
            session_id: SessionId(session_id),
            window_id: WindowId(window_id),
            pane_id: PaneId(pane_id),
            pane_pid,
        }),
        _ => None,
    };
    open_terminal_tagged_impl(
        state.inner(),
        app,
        host_id,
        socket.unwrap_or(SocketKind::App),
        session,
        cols,
        rows,
        open_id,
        selected,
    )
    .await
}

#[tauri::command]
pub async fn send_input(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    session: String,
    bytes: Vec<u8>,
    open_id: Option<String>,
    socket: Option<SocketKind>,
) -> Result<(), String> {
    let socket = socket.unwrap_or(SocketKind::App);
    send_input_tagged_impl(state.inner(), host_id, socket, session, bytes, open_id).await
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    session: String,
    cols: u16,
    rows: u16,
    open_id: Option<String>,
    socket: Option<SocketKind>,
) -> Result<(), String> {
    let socket = socket.unwrap_or(SocketKind::App);
    resize_terminal_tagged_impl(state.inner(), host_id, socket, session, cols, rows, open_id).await
}

#[tauri::command]
pub async fn ack_output(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    session: String,
    byte_count: u32,
    open_id: Option<String>,
    socket: Option<SocketKind>,
) -> Result<(), String> {
    let socket = socket.unwrap_or(SocketKind::App);
    ack_output_tagged_impl(state.inner(), host_id, socket, session, byte_count, open_id)
}

#[tauri::command]
pub async fn close_terminal(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    session: String,
    open_id: Option<String>,
    socket: Option<SocketKind>,
) -> Result<(), String> {
    let socket = socket.unwrap_or(SocketKind::App);
    close_terminal_tagged_impl(state.inner(), host_id, socket, session, open_id)
}

#[tauri::command]
pub async fn kill_session(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    session: String,
    session_id: Option<u32>,
    server_pid: Option<u32>,
    server_start_time: Option<u64>,
    socket: Option<SocketKind>,
) -> Result<(), String> {
    kill_session_impl(
        state.inner(),
        host_id,
        socket.unwrap_or(SocketKind::App),
        session,
        session_id,
        server_pid,
        server_start_time,
    )
    .await
}

#[tauri::command]
pub async fn disconnect_host(
    state: State<'_, Arc<AppState>>,
    host_id: String,
) -> Result<(), String> {
    disconnect_host_impl(state.inner(), host_id).await
}

// ---------------------------------------------------------------------
// Hostverwaltung und TOFU-Rueckfrage (Task 13).
// ---------------------------------------------------------------------

/// Liest `~/.ssh/config` und schlaegt daraus konkrete Hosts fuer den
/// Erststart vor (`src/views/first-run.ts`). Fehlt die Datei, ist das KEIN
/// Fehler -- eine leere Vorschlagsliste ist ein gueltiges Bild (der Nutzer
/// nutzt dann nur das manuelle Formular).
pub fn suggest_hosts_impl() -> Result<Vec<crate::ssh::SshConfigHost>, String> {
    let path = dirs::home_dir()
        .ok_or_else(|| "could not determine home directory".to_string())?
        .join(".ssh")
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
/// `settings::load_from` gegenueber `settings::load`): ohne diesen Parameter
/// waere diese Funktion nur gegen die ECHTE `%APPDATA%\io.github.itbrain258.aidevbridge\
/// settings.toml` testbar -- Unit-Tests duerften diese Datei aber nicht
/// anfassen (dieselbe Sonderregel wie fuer `~/.ssh/known_hosts`, auf die
/// gleiche Weise geloest).
pub fn list_hosts_impl(settings_path: &Path) -> Result<Vec<HostEntry>, String> {
    settings::load_from(settings_path)
        .map(|s| {
            // Task 8 (Spec §4.8): `auth_kind` kommt hier IMMER als `Some(..)`
            // an, egal was in `settings.toml` tatsaechlich steht -- eine
            // Datei aus der Zeit vor diesem Task hat das Feld nie
            // geschrieben (`None`), `add_host_impl` speichert seit diesem
            // Task zwar immer `Some(..)`, aber ein von Hand bearbeiteter
            // Eintrag koennte das Feld ebenso weglassen. `types.ts`s
            // `HostEntry.auth_kind` ist NICHT optional -- das Frontend darf
            // an dieser Grenze nie `null` sehen.
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
    // M-D (Abschlussreview): ohne dieses Feld verlor `finishAndPersist`
    // (first-run.ts) den Schluesselpfad beim Speichern -- ein Nutzer, der
    // sich mit Schluesseldatei verbindet und den Host speichert, landete ab
    // dem zweiten Start stillschweigend auf ssh-agent. `#[serde(default)]`:
    // Anmeldearten ohne Schluesseldatei lassen das Feld weg.
    #[serde(default)]
    pub key_path: Option<String>,
    // Task 8 (Spec §4.8): die vom Nutzer GEWAEHLTE Anmeldeart --
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

/// Fuegt einen Host zu `settings.toml` hinzu und speichert sofort (Task 13:
/// keine Session-artige "add now, save later"-Zwischenablage -- Hosts
/// SIND die Voreinstellungen, die laut Randbedingung dauerhaft in
/// `settings.toml` leben). Lesen-Aendern-Schreiben ueber
/// `settings::update_at`: Ein Host, den eine zweite Instanz inzwischen
/// gespeichert hat, bleibt erhalten. Ladefehler werden durchgereicht,
/// NIEMALS mit einem frischen Default ueberschrieben (siehe
/// `settings::load_from`) -- eine zu neue `settings.toml` bleibt
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
    // Task 8 (Spec §4.8): IMMER ein konkretes `Some(..)` speichern (und damit
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
pub fn add_host(entry: NewHostEntryDto) -> Result<HostEntry, String> {
    let path = settings::settings_path().map_err(settings_error)?;
    add_host_impl(&path, entry)
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
pub fn update_host(id: String, entry: NewHostEntryDto) -> Result<HostEntry, String> {
    let path = settings::settings_path().map_err(settings_error)?;
    update_host_impl(&path, &id, entry)
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

/// Synchron wie `add_host` und `remove_host` (kein `async`): Tauri fuehrt
/// synchrone Commands seriell aus, so bleibt Lesen-Aendern-Schreiben an
/// `settings.toml` innerhalb einer Instanz frei von Ueberschneidungen (Spec
/// §12.4); gegen eine zweite Instanz schuetzt `settings::update_at`.
#[tauri::command]
pub fn ui_settings(patch: Option<UiSettingsPatchDto>) -> Result<UiSettingsDto, String> {
    let path = settings::settings_path().map_err(settings_error)?;
    ui_settings_impl(&path, patch)
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
pub fn remove_host_impl(settings_path: &Path, id: &str) -> Result<(), String> {
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
pub fn remove_host(id: String) -> Result<(), String> {
    let path = settings::settings_path().map_err(settings_error)?;
    remove_host_impl(&path, &id)
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
        .hosts
        .lock()
        .unwrap()
        .get(&host_id)
        .and_then(HostSlot::ready)
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
// Verwaltungsschale (Shell-Task 4): Schluesselauswahl fuer die Anmeldemaske.
// ---------------------------------------------------------------------

/// Listet benutzbare Schluessel in `~/.ssh`. Oeffnet AUSSCHLIESSLICH
/// `.pub`-Dateien -- eine Liste zu bauen ist kein Anlass, Schluesselmaterial
/// anzufassen (Spec §8.2). Dieses Projekt verbietet Tests den Zugriff auf
/// `known_hosts`; derselbe Massstab gilt im Produktivpfad.
#[tauri::command]
pub async fn list_ssh_keys() -> Result<Vec<crate::ssh::keys::SshKeyDto>, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "Home directory not found".to_string())?
        .join(".ssh");
    Ok(crate::ssh::keys::list_keys_in(&dir))
}

// ---------------------------------------------------------------------
// Verwaltungsschale (Shell-Task 5): Sitzungsliste fuer die Seitenleiste.
// ---------------------------------------------------------------------

/// Gibt die Namen aller Sessions auf dem App-Socket eines verbundenen Hosts
/// zurueck. Damit bekommt `TmuxClient::list_session_names` seinen ersten
/// Aufrufer (Spec §2.4) -- die Funktion existiert seit Plan 1 und wurde nie
/// gerufen.
///
/// Zeigt bewusst ALLE Sessions, nicht nur die in dieser Sitzung angelegten:
/// eine Session, die einen App-Neustart ueberlebt hat, muss wiederfindbar
/// sein (Spec §6.2).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SessionListItemDto {
    pub display_name: String,
    pub session_id: Option<u32>,
    pub server_pid: Option<u32>,
    pub server_start_time: Option<u64>,
    pub window_id: Option<u32>,
    pub pane_id: Option<u32>,
    pub pane_pid: Option<u32>,
    pub unverified: Option<String>,
    pub status: String,
    pub status_reason: String,
    /// Angehaengte Clients laut Inventar (`#{session_attached}`), ohne
    /// Inventar `None`. Fuer den Hinweis zur Fenstergroesse beim Oeffnen einer
    /// Session des Standard-Sockets (Spec 2026-10-25 §10 Nr. 2).
    pub session_attached: Option<u32>,
}

/// One row of the slim status poll: numeric identity only, no names.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StatusRowDto {
    pub session_id: u32,
    pub status: String,
    pub status_reason: String,
}

/// `complete` is true only for one complete numeric inventory of one tmux
/// server; only then may the frontend treat an absent session as ended. An
/// unmeasured tmux version answers `complete: false` without rows.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StatusPollDto {
    pub complete: bool,
    pub server_pid: Option<u32>,
    pub server_start_time: Option<u64>,
    pub sessions: Vec<StatusRowDto>,
    /// `false`, wenn der claude-Befehl uebersprungen wurde oder ohne Antwort
    /// scheiterte; jede Antwort zaehlt, auch Exitcode 127. Nennt claude
    /// Agenten, gilt dasselbe fuer die Lesung ihrer Elternprozesse.
    pub agents_ok: bool,
    /// `false`, wenn der Titelbefehl uebersprungen wurde oder ohne Antwort
    /// scheiterte; jede Antwort zaehlt.
    pub titles_ok: bool,
}

/// DTO row for one numerically observed session. `window_id`, `pane_id` and
/// `pane_pid` are published only where the confirmed open (W/J) can
/// register; without them the frontend opens by name. tmux 3.0 reports no
/// `client_flags` (measured J lines), so its confirmation would retry until
/// it fails. Kill and status stay bound to server plus session id.
fn session_list_item(
    session: crate::tmux::client::ListedSessionObservation,
    status: crate::status::SessionStatus,
    version: MeasuredVersion,
    session_attached: Option<u32>,
) -> SessionListItemDto {
    // Exhaustive on purpose: a newly measured version needs its own decision.
    let confirmable = match version {
        MeasuredVersion::V3_0 => false,
        MeasuredVersion::V3_3A | MeasuredVersion::V3_4 | MeasuredVersion::V3_6 => true,
    };
    match session.binding {
        Ok(bound) => SessionListItemDto {
            display_name: session.display_name,
            session_id: Some(session.session_id.0),
            server_pid: Some(bound.selected.server.pid),
            server_start_time: Some(bound.selected.server.start_time),
            window_id: confirmable.then_some(bound.selected.window_id.0),
            pane_id: confirmable.then_some(bound.selected.pane_id.0),
            pane_pid: confirmable.then_some(bound.selected.pane_pid),
            unverified: None,
            status: status.kind.as_str().into(),
            status_reason: status.reason,
            session_attached,
        },
        Err(reason) => SessionListItemDto {
            display_name: session.display_name,
            session_id: Some(session.session_id.0),
            server_pid: None,
            server_start_time: None,
            window_id: None,
            pane_id: None,
            pane_pid: None,
            unverified: Some(reason.to_string()),
            status: status.kind.as_str().into(),
            status_reason: status.reason,
            session_attached,
        },
    }
}

/// Ergebnis von `list_sessions` je Socket (Spec 2026-10-25 §6.2): Ein Fehler
/// des einen Sockets laesst die Liste des anderen gelten.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionListDto {
    pub own: SocketSessionsDto,
    /// `None`, wenn der Standard-Socket nicht verlangt war (Schalter des
    /// Hosts aus): Dann liest die App ihn gar nicht.
    pub default: Option<SocketSessionsDto>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SocketSessionsDto {
    pub sessions: Vec<SessionListItemDto>,
    /// Gesetzt, wenn dieser Socket nicht gelesen werden konnte.
    pub error: Option<OperationErrorDto>,
    /// Die Version eines laufenden Servers, an dem die App nicht anhaengt
    /// (nur Standard-Socket); `sessions` ist dann leer.
    pub unsupported_version: Option<String>,
}

/// Was ein Socket fuer die Liste ergab, bevor die gemeinsame claude-Lesung
/// den Status liefert.
enum SocketListing {
    Observed {
        observed: crate::tmux::client::SessionListObservation,
        titles: std::collections::BTreeMap<PaneId, crate::status::title::PaneDetails>,
    },
    /// Eigener Socket mit ungemessener tmux-Version: nur Namen.
    Names(Vec<String>),
    /// Kein Server: eine leere Liste, kein Fehler.
    Empty,
    /// Standard-Socket mit einer Serverversion ohne Messung.
    Unsupported(String),
}

pub async fn list_sessions_impl(
    state: &Arc<AppState>,
    host_id: String,
) -> Result<Vec<SessionListItemDto>, OperationErrorDto> {
    let listed = list_sockets_impl(state, host_id, false).await?;
    match listed.own.error {
        Some(error) => Err(error),
        None => Ok(listed.own.sessions),
    }
}

/// Liest den eigenen Socket und, wenn verlangt, den Standard-Socket; den
/// eigenen zuerst, beide mit derselben Frist. Ein fehlender Host scheitert
/// ganz, ein Fehler eines Sockets nur fuer diesen.
pub async fn list_sockets_impl(
    state: &Arc<AppState>,
    host_id: String,
    include_default: bool,
) -> Result<SessionListDto, OperationErrorDto> {
    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
    // Direktzugriff auf das private Feld ist hier zulaessig und richtig:
    // dieselbe Datei, dasselbe Modul. `create_session_impl` macht es
    // identisch -- kein zusaetzlicher Accessor, der nur eine zweite
    // Zugriffsart auf denselben Zustand waere.
    let transport = state
        .hosts
        .lock()
        .unwrap()
        .get(&host_id)
        .and_then(HostSlot::ready)
        .ok_or_else(|| OperationErrorDto {
            code: "host_unavailable",
            message: "host not connected".into(),
            control_generation: 0,
        })?;
    let transport = transport.command(deadline);
    let installed = transport
        .exec_with_deadline(
            &TmuxClient::new(&state.own_tmux_socket()).version_command(),
            COMMAND_TIMEOUT,
        )
        .await
        .ok()
        .and_then(|result| MeasuredVersion::from_response(&result));
    let observed = |listing: &Result<SocketListing, OperationErrorDto>| {
        matches!(listing, Ok(SocketListing::Observed { .. }))
    };
    let own = list_own_socket(state, &transport, installed, deadline).await;
    // claude gleich nach dem eigenen Socket: ein langsamer Standard-Socket
    // nimmt den eigenen Sessions so nicht die Zeit fuer ihren Status (Spec
    // 2026-10-25 §6.3, der eigene Socket zuerst).
    let mut agents = None;
    if observed(&own) {
        agents = Some(read_claude_agents(&transport, deadline).await);
    }
    let default = match include_default {
        true => Some(list_default_socket(state, &transport, installed, deadline).await),
        false => None,
    };
    if agents.is_none() && default.as_ref().is_some_and(observed) {
        agents = Some(read_claude_agents(&transport, deadline).await);
    }
    let (agents, parents, _) = agents.unwrap_or_default();
    Ok(SessionListDto {
        own: socket_sessions(own, &agents, &parents),
        default: default.map(|listing| socket_sessions(listing, &agents, &parents)),
    })
}

// `state.own_socket` und NICHT der per-Host konfigurierte
// `HostEntry.tmux_socket`: `create_session_impl` legt Sessions ebenfalls auf
// `state.own_socket` an. Eine abweichende Wahl hier wuerde einen ANDEREN
// Socket auflisten als den, auf dem die Sessions liegen -- die Liste bliebe
// leer, und niemand saehe warum.
//
// Dass `HostEntry.tmux_socket` insgesamt ungelesen bleibt, ist ein
// BESTEHENDER Befund aus Plan 1, kein neuer dieses Tasks. Er wird hier
// bewusst nicht behoben: ihn zu beheben hiesse, ihn an BEIDEN Stellen
// gleichzeitig zu beheben, und das gehoert nicht in diesen Umbau.
async fn list_own_socket(
    state: &Arc<AppState>,
    transport: &CommandTransport,
    installed: Option<MeasuredVersion>,
    deadline: tokio::time::Instant,
) -> Result<SocketListing, OperationErrorDto> {
    let socket = state.own_tmux_socket();
    let client = TmuxClient::new(&socket);
    match installed {
        Some(version) => observed_listing(&client, &socket, transport, version, deadline).await,
        None => client
            .list_session_names(transport)
            .await
            .map(SocketListing::Names)
            .map_err(|e| operation_error(transport, &e)),
    }
}

/// Der Standard-Socket mit der Version seines laufenden Servers; an einer
/// ungemessenen haengt die App nicht an, sie nennt sie nur (Spec 2026-10-25
/// §6.2).
async fn list_default_socket(
    state: &Arc<AppState>,
    transport: &CommandTransport,
    installed: Option<MeasuredVersion>,
    deadline: tokio::time::Instant,
) -> Result<SocketListing, OperationErrorDto> {
    let socket = state.default_socket.clone();
    let client = TmuxClient::new(&socket);
    let version = match client.server_version(transport, installed, deadline).await {
        Ok(Some(version)) => version,
        Ok(None) => return Ok(SocketListing::Empty),
        Err(error) => return Err(operation_error(transport, &error)),
    };
    match MeasuredVersion::from_server_version(&version).filter(|v| v.supports_default_socket()) {
        Some(measured) => observed_listing(&client, &socket, transport, measured, deadline).await,
        None => Ok(SocketListing::Unsupported(version)),
    }
}

async fn observed_listing(
    client: &TmuxClient,
    socket: &TmuxSocket,
    transport: &CommandTransport,
    version: MeasuredVersion,
    deadline: tokio::time::Instant,
) -> Result<SocketListing, OperationErrorDto> {
    let observed = match client.observe_sessions(transport, version, deadline).await {
        Ok(observed) => observed,
        // No server means no sessions: a fresh host, a rebooted VM or the
        // last session ended.
        Err(error) if error.is::<ServerAbsent>() => return Ok(SocketListing::Empty),
        Err(error) => return Err(operation_error(transport, &error)),
    };
    let (titles, _) = read_pane_details(
        transport,
        socket,
        &crate::status::listed_title_panes(&observed.sessions),
        deadline,
    )
    .await;
    Ok(SocketListing::Observed { observed, titles })
}

fn socket_sessions(
    listing: Result<SocketListing, OperationErrorDto>,
    agents: &[crate::status::AgentRow],
    parents: &std::collections::BTreeMap<u32, u32>,
) -> SocketSessionsDto {
    let mut dto = SocketSessionsDto {
        sessions: Vec::new(),
        error: None,
        unsupported_version: None,
    };
    match listing {
        Err(error) => dto.error = Some(error),
        Ok(SocketListing::Empty) => {}
        Ok(SocketListing::Unsupported(version)) => dto.unsupported_version = Some(version),
        Ok(SocketListing::Names(names)) => {
            dto.sessions = names
                .into_iter()
                .map(|display_name| SessionListItemDto {
                    display_name,
                    session_id: None,
                    server_pid: None,
                    server_start_time: None,
                    window_id: None,
                    pane_id: None,
                    pane_pid: None,
                    unverified: Some("unmeasured_tmux_version".into()),
                    status: "unknown".into(),
                    status_reason: "tmux version is not a measured 3.0/3.3a/3.4/3.6 inventory"
                        .into(),
                    session_attached: None,
                })
                .collect();
        }
        Ok(SocketListing::Observed { observed, titles }) => {
            let version = observed.version;
            dto.sessions = observed
                .sessions
                .into_iter()
                .map(|session| {
                    let status = crate::status::listed_status(
                        &session,
                        &observed.inventory,
                        agents,
                        parents,
                        &titles,
                    );
                    let attached = observed
                        .inventory
                        .panes
                        .iter()
                        .find(|pane| pane.session_id == session.session_id)
                        .map(|pane| pane.session_attached);
                    session_list_item(session, status, version, attached)
                })
                .collect();
        }
    }
    dto
}

#[tauri::command]
/// Liste je Socket (Spec 2026-10-25 §6.2). Den Standard-Socket liest es nur,
/// wenn das Frontend ihn verlangt: der Schalter des Hosts lebt dort.
pub async fn list_sessions(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    include_default: Option<bool>,
) -> Result<SessionListDto, OperationErrorDto> {
    list_sockets_impl(state.inner(), host_id, include_default.unwrap_or(false)).await
}

/// Spec 4.1: the poll has five seconds, channel setup included.
const STATUS_POLL_TIMEOUT: Duration = Duration::from_secs(5);

// Verzichtbare Lesungen starten nur mit genug Restzeit: Laeuft eine Frist
// mitten im Kanaloeffnen ab, bricht der Transport die Steuerverbindung ab
// (`owned_operations.rs`, Phase Open).
const OPTIONAL_READ_MIN_REMAINING: Duration = Duration::from_millis(500);
const CLAUDE_MIN_REMAINING: Duration = Duration::from_millis(1500);
/// Bleibt nach `claude agents --json` fuer die Elternprozesse uebrig.
const CLAUDE_RESERVE: Duration = Duration::from_millis(700);

/// Lesender Claude-Status: `claude agents --json` (hoechstens 4 s, nur bei
/// mindestens 1,5 s Restzeit, 700 ms bleiben uebrig) und nur fuer die dort
/// genannten pids deren Eltern aus /proc (hoechstens 1 s, nur bei mindestens
/// 500 ms Restzeit), alles innerhalb von `deadline`. Das `bool` ist `false`,
/// wenn claude uebersprungen wurde oder ohne Antwort scheiterte. Nennt claude
/// Agenten, braucht ihre Bindung an die Pane auch die Eltern: Wird deren
/// Lesung uebersprungen oder scheitert sie ohne Antwort, ist es ebenfalls
/// `false`. Jede Antwort zaehlt, gleich mit welchem Exitcode. Ein Fehler hier
/// heisst "keine Agentenquelle", nie eine gescheiterte Liste.
async fn read_claude_agents(
    transport: &dyn Transport,
    deadline: tokio::time::Instant,
) -> (
    Vec<crate::status::AgentRow>,
    std::collections::BTreeMap<u32, u32>,
    bool,
) {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining < CLAUDE_MIN_REMAINING {
        return (Vec::new(), Default::default(), false);
    }
    let cli_timeout = Duration::from_secs(4).min(remaining.saturating_sub(CLAUDE_RESERVE));
    let agents = match transport
        .exec_with_deadline(&crate::status::agents_command(), cli_timeout)
        .await
    {
        Ok(result) if result.code == 0 => {
            crate::status::parse_agents(&result.stdout).unwrap_or_default()
        }
        Ok(_) => Vec::new(),
        Err(_) => return (Vec::new(), Default::default(), false),
    };
    let pids: Vec<u32> = agents.iter().map(|row| row.pid).collect();
    let Some(command) = crate::status::parents_command(&pids) else {
        return (agents, Default::default(), true);
    };
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining < OPTIONAL_READ_MIN_REMAINING {
        return (agents, Default::default(), false);
    }
    match transport
        .exec_with_deadline(&command, Duration::from_secs(1).min(remaining))
        .await
    {
        Ok(result) if result.code == 0 => {
            let parents = crate::status::parse_parents(&result.stdout);
            (agents, parents, true)
        }
        Ok(_) => (agents, Default::default(), true),
        Err(_) => (agents, Default::default(), false),
    }
}

/// Titel und Programmnamen der Panes (hoechstens 1 s, nur bei mindestens
/// 500 ms Restzeit, innerhalb von `deadline`). Das `bool` ist `false`, wenn
/// die Lesung uebersprungen wurde oder ohne Antwort scheiterte; jede Antwort
/// zaehlt, gleich mit welchem Exitcode. Ohne Pane gibt es nichts zu lesen,
/// das ist kein Ausfall. Ein Fehler hier heisst "keine Titelquelle", nie eine
/// gescheiterte Liste oder Abfrage.
async fn read_pane_details(
    transport: &dyn Transport,
    socket: &TmuxSocket,
    panes: &[(crate::tmux::inventory::PaneId, u32)],
    deadline: tokio::time::Instant,
) -> (
    std::collections::BTreeMap<crate::tmux::inventory::PaneId, crate::status::title::PaneDetails>,
    bool,
) {
    let Some(command) = crate::status::title::details_command(socket, panes) else {
        return (Default::default(), true);
    };
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining < OPTIONAL_READ_MIN_REMAINING {
        return (Default::default(), false);
    }
    match transport
        .exec_with_deadline(&command, Duration::from_secs(1).min(remaining))
        .await
    {
        Ok(result) if result.code == 0 => {
            (crate::status::title::parse_details(&result.stdout), true)
        }
        Ok(_) => (Default::default(), true),
        Err(_) => (Default::default(), false),
    }
}

/// Status je Socket (Spec 2026-10-25 §6.3).
#[derive(Debug, Clone, serde::Serialize)]
pub struct StatusPollsDto {
    pub own: SocketPollDto,
    /// `None`, wenn der Standard-Socket nicht verlangt war (Schalter des
    /// Hosts aus).
    pub default: Option<SocketPollDto>,
}

/// Ein Socket der Abfrage: sein Ergebnis oder sein Fehler. Ein Fehler macht
/// nur die Sessions dieses Sockets veraltet.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SocketPollDto {
    pub poll: Option<StatusPollDto>,
    pub error: Option<OperationErrorDto>,
}

struct SocketsPoll {
    own: anyhow::Result<StatusPollDto>,
    default: Option<anyhow::Result<StatusPollDto>>,
}

/// Inventar und Titel eines Sockets; `inventory` ist `None`, wenn auf dem
/// Standard-Socket bewiesen kein Server laeuft.
struct PolledSocket {
    inventory: Option<crate::tmux::inventory::InventorySnapshot>,
    titles: std::collections::BTreeMap<PaneId, crate::status::title::PaneDetails>,
    titles_ok: bool,
}

/// Nur der eigene Socket, wie vor dem Standard-Socket: fuer die Tests der
/// Abfrage.
#[cfg(test)]
async fn poll_status_with(
    transport: &dyn Transport,
    socket: &TmuxSocket,
    deadline: tokio::time::Instant,
) -> anyhow::Result<StatusPollDto> {
    poll_sockets_with(transport, socket, None, deadline)
        .await?
        .own
}

/// The slim status poll: `tmux -V`, one complete numeric inventory, the
/// active panes' titles, the Claude CLI and, only for its pids, /proc -- five
/// commands for any number of sessions. It neither names nor lists sessions;
/// membership and display names stay with `list_sessions`. Each session is
/// judged by its active pane (`status::statuses_from_inventory`).
///
/// Liest je Socket ein Inventar und die Titel seiner Panes, den eigenen
/// zuerst; `claude agents --json` und die Elternprozesse einmal, denn sie
/// binden ueber PIDs (Spec 2026-10-25 §6.3). Fuer den eigenen Socket bleibt
/// die Folge der Aufrufe dieselbe wie ohne Standard-Socket.
///
/// Der Rahmen der Inventarabfrage folgt dem `tmux` im `PATH`; fuer 3.3a, 3.4
/// und 3.6 ist er derselbe. Welche Sessions des Standard-Sockets die App
/// bindet, entscheidet die Liste nach der Version des laufenden Servers.
async fn poll_sockets_with(
    transport: &dyn Transport,
    own: &TmuxSocket,
    default: Option<&TmuxSocket>,
    deadline: tokio::time::Instant,
) -> anyhow::Result<SocketsPoll> {
    let remaining = || deadline.saturating_duration_since(tokio::time::Instant::now());
    let version = transport
        .exec_with_deadline(&TmuxClient::new(own).version_command(), remaining())
        .await?;
    let Some(version) = MeasuredVersion::from_response(&version) else {
        // Weder Titel noch claude wurden gelesen.
        let unmeasured = || {
            Ok(StatusPollDto {
                complete: false,
                server_pid: None,
                server_start_time: None,
                sessions: Vec::new(),
                agents_ok: false,
                titles_ok: false,
            })
        };
        return Ok(SocketsPoll {
            own: unmeasured(),
            default: default.map(|_| unmeasured()),
        });
    };
    let observed = |polled: &anyhow::Result<PolledSocket>| {
        polled
            .as_ref()
            .is_ok_and(|polled| polled.inventory.is_some())
    };
    let own_polled = poll_socket(transport, own, version, deadline).await;
    // claude gleich nach dem eigenen Socket, vor dem Standard-Socket: dessen
    // Inventar und Titel nehmen den eigenen Sessions so nie die Zeit fuer
    // ihren Status (Spec 2026-10-25 §6.3).
    let mut agents = None;
    if observed(&own_polled) {
        agents = Some(read_claude_agents(transport, deadline).await);
    }
    let default_polled = match default {
        Some(socket) => Some(poll_socket(transport, socket, version, deadline).await),
        None => None,
    };
    if agents.is_none() && default_polled.as_ref().is_some_and(observed) {
        agents = Some(read_claude_agents(transport, deadline).await);
    }
    let (agents, parents, agents_ok) = agents.unwrap_or_default();
    let rows = |polled: anyhow::Result<PolledSocket>| {
        polled.map(|polled| status_poll(polled, &agents, &parents, agents_ok))
    };
    Ok(SocketsPoll {
        own: rows(own_polled),
        default: default_polled.map(rows),
    })
}

async fn poll_socket(
    transport: &dyn Transport,
    socket: &TmuxSocket,
    version: MeasuredVersion,
    deadline: tokio::time::Instant,
) -> anyhow::Result<PolledSocket> {
    let remaining = || deadline.saturating_duration_since(tokio::time::Instant::now());
    let client = TmuxClient::new(socket);
    let query = client.inventory_query(version)?;
    let result = transport
        .exec_with_deadline(&query.command(), remaining())
        .await?;
    if !result.utf8_valid {
        anyhow::bail!("tmux inventory is not valid UTF-8");
    }
    // Anything but a complete snapshot (including a NoServer the named
    // socket cannot prove) is a failed poll, never an empty inventory. On the
    // default socket a missing server is proven like in the list, by tmux
    // naming the predicted path, and is a complete, empty result.
    let inventory = match query.classify(&result) {
        InventoryOutcome::Snapshot(inventory) => inventory,
        _ if socket.kind() == SocketKind::Default
            && client
                .server_proven_absent(transport, version, &result, deadline)
                .await? =>
        {
            return Ok(PolledSocket {
                inventory: None,
                titles: Default::default(),
                titles_ok: true,
            });
        }
        _ => anyhow::bail!("tmux inventory is not a complete snapshot"),
    };
    let (titles, titles_ok) = read_pane_details(
        transport,
        socket,
        &crate::status::title_panes(&inventory),
        deadline,
    )
    .await;
    Ok(PolledSocket {
        inventory: Some(inventory),
        titles,
        titles_ok,
    })
}

fn status_poll(
    polled: PolledSocket,
    agents: &[crate::status::AgentRow],
    parents: &std::collections::BTreeMap<u32, u32>,
    agents_ok: bool,
) -> StatusPollDto {
    let Some(inventory) = polled.inventory else {
        return StatusPollDto {
            complete: true,
            server_pid: None,
            server_start_time: None,
            sessions: Vec::new(),
            agents_ok,
            titles_ok: polled.titles_ok,
        };
    };
    StatusPollDto {
        complete: true,
        server_pid: Some(inventory.server.pid),
        server_start_time: Some(inventory.server.start_time),
        sessions: crate::status::statuses_from_inventory(
            &inventory,
            agents,
            parents,
            &polled.titles,
        )
        .into_iter()
        .map(|row| StatusRowDto {
            session_id: row.session_id.0,
            status: row.kind.as_str().into(),
            status_reason: row.reason,
        })
        .collect(),
        agents_ok,
        titles_ok: polled.titles_ok,
    }
}

pub async fn poll_status_impl(
    state: &Arc<AppState>,
    host_id: String,
) -> Result<StatusPollDto, OperationErrorDto> {
    let polled = poll_sockets_impl(state, host_id, false).await?;
    match (polled.own.poll, polled.own.error) {
        (Some(poll), _) => Ok(poll),
        (None, Some(error)) => Err(error),
        (None, None) => unreachable!("a socket poll has a result or an error"),
    }
}

pub async fn poll_sockets_impl(
    state: &Arc<AppState>,
    host_id: String,
    include_default: bool,
) -> Result<StatusPollsDto, OperationErrorDto> {
    let deadline = tokio::time::Instant::now() + STATUS_POLL_TIMEOUT;
    // Same lookup as `list_sessions_impl`: the control connection only.
    let transport = state
        .hosts
        .lock()
        .unwrap()
        .get(&host_id)
        .and_then(HostSlot::ready)
        .ok_or_else(|| OperationErrorDto {
            code: "host_unavailable",
            message: "host not connected".into(),
            control_generation: 0,
        })?;
    let transport = transport.command(deadline);
    let default_socket = include_default.then(|| state.default_socket.clone());
    let polled = poll_sockets_with(
        &transport,
        &state.own_tmux_socket(),
        default_socket.as_ref(),
        deadline,
    )
    .await
    .map_err(|e| operation_error(&transport, &e))?;
    let socket = |result: anyhow::Result<StatusPollDto>| match result {
        Ok(poll) => SocketPollDto {
            poll: Some(poll),
            error: None,
        },
        Err(error) => SocketPollDto {
            poll: None,
            error: Some(operation_error(&transport, &error)),
        },
    };
    Ok(StatusPollsDto {
        own: socket(polled.own),
        default: polled.default.map(socket),
    })
}

#[tauri::command]
/// Status je Socket (Spec 2026-10-25 §6.3), der Standard-Socket wie bei
/// `list_sessions` nur auf Verlangen.
pub async fn poll_status(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    include_default: Option<bool>,
) -> Result<StatusPollsDto, OperationErrorDto> {
    poll_sockets_impl(state.inner(), host_id, include_default.unwrap_or(false)).await
}

// ---------------------------------------------------------------------
// Verzeichnisauswahl: eine Ebene Unterverzeichnisse fuer den Baum im
// Sitzungsdialog.
// ---------------------------------------------------------------------

/// Eine gelesene Ebene, wie der WebView sie bekommt.
///
/// Eigener Typ neben `remote::dirs::Listing`: jener ist der
/// Auswertungstyp des Fernskripts und soll nicht dadurch zur
/// IPC-Schnittstelle werden, dass ihm jemand ein `Serialize` anhaengt.
/// Dasselbe Verhaeltnis wie `HostSpecDto` zu `HostSpec`.
#[derive(serde::Serialize)]
pub struct DirectoryListingDto {
    /// Der tatsaechlich aufgeloeste, absolute Pfad. Weicht von der
    /// Anfrage ab, wenn diese leer war -- dann steht hier das
    /// Heimatverzeichnis des Anmeldebenutzers (Spec §3.3).
    pub path: String,
    /// Nur die NAMEN der Untereintraege, nicht deren Pfade.
    pub entries: Vec<String>,
}

/// Listet die Unterverzeichnisse EINER Ebene unterhalb von `path`.
///
/// Nichts Rekursives: jede Ebene ist ein eigener SSH-Aufruf, weil der Pfad
/// auf dem entfernten Rechner liegt und nichts Lokales dabei helfen kann
/// (Spec §1).
pub async fn list_directories_impl(
    state: &Arc<AppState>,
    host_id: String,
    path: String,
    include_hidden: bool,
) -> Result<crate::remote::dirs::Listing, String> {
    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
    // H6/H9: VOR dem Host-Lookup, siehe `create_session_impl`. Ausnahme
    // bewusst nur fuer den LEEREN Pfad: er ist der eigens vorgesehene
    // Sonderfall "Heimatverzeichnis des Anmeldebenutzers" (Spec §3.3, siehe
    // `script()`s `[ -n "${d}" ] || d=$HOME`) und der einzige Weg, den das
    // Frontend dafuer kennt (`directory-tree.ts`) -- kein Steuerzeichen,
    // keine Interpolation, also keine Gefahr fuer `remote::build`. Jeder
    // ANDERE, nicht-absolute oder Steuerzeichen enthaltende Pfad wird
    // abgelehnt.
    if !path.is_empty() && !is_acceptable_remote_path(&path) {
        return Err("path must be an absolute path without control characters".into());
    }

    // Direktzugriff auf das private Feld, wie in `list_sessions_impl` --
    // dieselbe Datei, dasselbe Modul, kein zusaetzlicher Accessor.
    let transport = state
        .hosts
        .lock()
        .unwrap()
        .get(&host_id)
        .and_then(HostSlot::ready)
        .ok_or_else(|| "host not connected".to_string())?;

    // `sh -c <skript> sh <pfad>`: `$0` wird `sh`, `$1` der Pfad. Beide
    // gehen als eigene, base64-kodierte Argumente durch `remote::build`.
    let line = crate::remote::build(&["sh", "-c", crate::remote::dirs::script(), "sh", &path]);
    let transport = transport.command(deadline);
    let r = transport.exec(&line).await.map_err(|e| e.to_string())?;

    let mut listing = crate::remote::dirs::parse(&r.stdout).map_err(|e| e.to_string())?;
    // Das Filtern geschieht HIER, nicht im Skript: so bleibt das
    // Fernkommando konstant und fuer sich pruefbar, und ein Umschalten
    // kostet keinen anderen Befehl.
    if !include_hidden {
        listing.entries.retain(|e| !e.starts_with('.'));
    }
    // Ohne Ruecksicht auf Gross-/Kleinschreibung, damit `Repo` und `repo`
    // beieinander stehen -- eine Liste, die nach ASCII sortiert, wirkt
    // willkuerlich sortiert.
    listing.entries.sort_by_key(|e| e.to_lowercase());
    Ok(listing)
}

#[tauri::command]
pub async fn list_directories(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    path: String,
    include_hidden: bool,
) -> Result<DirectoryListingDto, String> {
    let listing = list_directories_impl(state.inner(), host_id, path, include_hidden).await?;
    Ok(DirectoryListingDto {
        path: listing.path,
        entries: listing.entries,
    })
}

// ---------------------------------------------------------------------
// UX-Ueberarbeitung (Spec §6.5): Links aus dem Terminal oeffnen.
// ---------------------------------------------------------------------

/// Hoechstlaenge eines Links in Zeichen (Spec §6.5).
const MAX_LINK_CHARS: usize = 2048;

const LINK_TOO_LONG: &str = "link is longer than 2048 characters";
const LINK_HAS_SPACE_OR_CONTROL: &str = "link contains whitespace or control characters";
const LINK_HAS_INVISIBLE_FORMAT: &str = "link contains invisible formatting characters";
const LINK_SCHEME_NOT_ALLOWED: &str = "only http and https links can be opened";
const LINK_WITHOUT_HOST: &str = "link has no host";

/// Prueft einen Link, bevor `open_link` ihn dem System uebergibt (Spec §6.5):
/// Schema `http://` oder `https://` (ohne Ruecksicht auf Gross- und
/// Kleinschreibung, RFC 3986 §3.1), ein Host dahinter, keine Leer- und
/// Steuerzeichen, keine unsichtbaren Format- oder Bidi-Zeichen, hoechstens
/// 2048 Zeichen.
///
/// Das Leerzeichenverbot haelt die URL im `%1` der Befehlsvorlage des
/// Browsers zu einem einzigen Argument; es darf nicht gelockert werden.
///
/// Das ist die einzige Schranke: `tauri_plugin_opener::open_url` aus Rust
/// laeuft an der Scope-Pruefung des Plugins vorbei, und der WebView bekommt
/// kein `opener:`-Recht (capabilities/default.json).
pub fn validate_link(url: &str) -> Result<(), &'static str> {
    if url.chars().count() > MAX_LINK_CHARS {
        return Err(LINK_TOO_LONG);
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(LINK_HAS_SPACE_OR_CONTROL);
    }
    if url.chars().any(is_invisible_format) {
        return Err(LINK_HAS_INVISIBLE_FORMAT);
    }
    let rest = ["http://", "https://"]
        .into_iter()
        .find_map(|scheme| {
            url.get(..scheme.len())
                .filter(|head| head.eq_ignore_ascii_case(scheme))
                .map(|_| &url[scheme.len()..])
        })
        .ok_or(LINK_SCHEME_NOT_ALLOWED)?;
    // Autoritaet bis zum ersten `/`, `?` oder `#`, davon `userinfo@` (bis
    // zum letzten `@`, wie Browser es lesen) und `:port` ab. Ein
    // IPv6-Literal (`[::1]:8080`) beginnt mit `[` und ist damit nie leer.
    let authority = rest.find(['/', '?', '#']).map_or(rest, |end| &rest[..end]);
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host_port.split_once(':').map_or(host_port, |(h, _)| h);
    if host.is_empty() {
        return Err(LINK_WITHOUT_HOST);
    }
    Ok(())
}

/// Unsichtbare Format- und Bidi-Zeichen, die `char::is_control` nicht
/// erfasst (Trojan Source): Nullbreiten, Richtungsmarken, -einbettungen und
/// -isolate sowie U+FEFF. Ein Link mit ihnen saehe im Terminal anders aus,
/// als er geoeffnet wird.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

/// Oeffnet einen Link aus dem Terminal im Standardbrowser (Spec §6.5; das
/// Frontend ruft das nur nach Strg+Klick). Ein abgelehnter Link bleibt ohne
/// Wirkung. `async`, weil synchrone Commands auf dem Hauptthread laufen:
/// tauri-plugin-opener schaltet beim Crate `open` `shellexecute-on-windows`
/// ein, `open_url` ruft unter Windows also im Prozess `ShellExecuteExW` auf,
/// und das kann blockieren. Auch der eigene `open_url`-Command des Plugins
/// ist `async`.
#[tauri::command]
pub async fn open_link(url: String) -> Result<(), String> {
    validate_link(&url).map_err(String::from)?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sock() -> TmuxSocket {
        TmuxSocket::own(&OwnSocket::new("sock").unwrap())
    }

    fn bound_listing(id: u32) -> crate::tmux::client::ListedSessionObservation {
        crate::tmux::client::ListedSessionObservation {
            session_id: SessionId(id),
            display_name: format!("ab_{id}"),
            binding: Ok(crate::tmux::session_binding::BoundObservation {
                display_name: format!("ab_{id}"),
                selected: PaneIdentity {
                    server: ServerIdentity {
                        pid: 50,
                        start_time: 1000,
                    },
                    session_id: SessionId(id),
                    window_id: WindowId(4),
                    pane_id: PaneId(7),
                    pane_pid: 10,
                },
                creation_matched: false,
            }),
        }
    }

    /// tmux 3.0 reports no client flags in `list-clients` (measured J lines),
    /// so the confirmed open cannot register there. Its rows must not steer
    /// the frontend into that open; kill and status stay bound.
    #[test]
    fn list_item_offers_the_confirmed_open_only_where_it_can_register() {
        for version in [
            MeasuredVersion::V3_3A,
            MeasuredVersion::V3_4,
            MeasuredVersion::V3_6,
        ] {
            let listing = bound_listing(3);
            let status = crate::status::from_listing(&listing);
            let row = session_list_item(listing, status, version, None);
            assert_eq!(
                (row.window_id, row.pane_id, row.pane_pid),
                (Some(4), Some(7), Some(10)),
                "{version:?}"
            );
        }
        let listing = bound_listing(3);
        let status = crate::status::from_listing(&listing);
        let row = session_list_item(listing, status, MeasuredVersion::V3_0, None);
        assert_eq!(
            (row.session_id, row.server_pid, row.server_start_time),
            (Some(3), Some(50), Some(1000))
        );
        assert_eq!(
            (row.window_id, row.pane_id, row.pane_pid),
            (None, None, None)
        );
    }

    fn poll_exec(stdout: &str) -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: stdout.into(),
            stderr: String::new(),
            code: 0,
        }
    }

    const POLL_INVENTORY: &str = "B|50|1000\nQ|$0|1\nQ|$1|1\nP|$0|@0|%0|10|1|1|0|0|0|1789296086|0|1\nP|$1|@1|%1|20|1|1|0|0|0|1789296086|0|1\nE|50|1000\n";

    const DEFAULT_INVENTORY: &str =
        "B|60|2000\nQ|$5|1\nP|$5|@3|%9|30|1|1|0|0|1|1789296086|0|1\nE|60|2000\n";

    fn failed_exec(stderr: &str) -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: String::new(),
            stderr: stderr.into(),
            code: 1,
        }
    }

    /// Spec 2026-10-25 §6.3: Beide Sockets in einer Abfrage, der eigene zuerst,
    /// jeder mit seinem Inventar und seinen Titeln; claude einmal.
    #[tokio::test]
    async fn one_poll_reads_both_sockets_and_claude_once() {
        let default = TmuxSocket::default_named("dflt");
        let t = ScriptedTransport::new(vec![
            poll_exec("tmux 3.6\n"),
            poll_exec(POLL_INVENTORY),
            poll_exec(""),
            poll_exec("[]"),
            poll_exec(DEFAULT_INVENTORY),
            poll_exec(""),
        ]);
        let polled = poll_sockets_with(
            &t,
            &sock(),
            Some(&default),
            tokio::time::Instant::now() + COMMAND_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(*t.calls.lock().unwrap(), 6);
        let lines: Vec<_> = t
            .lines
            .lock()
            .unwrap()
            .iter()
            .map(|line| crate::remote::command::decoded_argv(line))
            .collect();
        assert_eq!(&lines[1][4..6], ["-L", "sock"]);
        // claude kommt vor dem Standard-Socket.
        assert!(
            lines[3].iter().any(|arg| arg.contains("claude")),
            "{:?}",
            lines[3]
        );
        assert_eq!(&lines[4][4..6], ["-L", "dflt"]);
        assert_eq!(&lines[5][3..], ["aidevbridge-panes", "dflt", "%9", "30"]);
        let own = polled.own.unwrap();
        assert_eq!((own.server_pid, own.sessions.len()), (Some(50), 2));
        let default = polled.default.unwrap().unwrap();
        assert!(default.complete && default.agents_ok && default.titles_ok);
        assert_eq!(
            (default.server_pid, default.server_start_time),
            (Some(60), Some(2000))
        );
        assert_eq!(
            default
                .sessions
                .iter()
                .map(|row| row.session_id)
                .collect::<Vec<_>>(),
            [5]
        );
    }

    /// Kein Server auf dem Standard-Socket ist ein vollstaendiges, leeres
    /// Ergebnis, wenn tmux genau den vorhergesagten Pfad nennt; jeder andere
    /// Fehler dort trifft nur diesen Socket (Spec 2026-10-25 §6.3).
    #[tokio::test]
    async fn the_default_socket_fails_or_ends_on_its_own() {
        let default = TmuxSocket::default_named("dflt");
        for (prediction, absent) in [
            ("S|/tmp/tmux-1000/dflt\n", true),
            ("S|/tmp/tmux-1000/other\n", false),
        ] {
            let t = ScriptedTransport::new(vec![
                poll_exec("tmux 3.6\n"),
                poll_exec(POLL_INVENTORY),
                poll_exec(""),
                poll_exec("[]"),
                failed_exec("no server running on /tmp/tmux-1000/dflt\n"),
                poll_exec(prediction),
            ]);
            let polled = poll_sockets_with(
                &t,
                &sock(),
                Some(&default),
                tokio::time::Instant::now() + COMMAND_TIMEOUT,
            )
            .await
            .unwrap();
            assert_eq!(polled.own.unwrap().sessions.len(), 2);
            match polled.default.unwrap() {
                Ok(poll) => {
                    assert!(absent, "an unproven absence must stay an error");
                    assert!(poll.complete && poll.sessions.is_empty());
                    assert_eq!(poll.server_pid, None);
                }
                Err(_) => assert!(!absent, "a proven absence is no error"),
            }
        }
    }

    /// The status poll needs no per-session name binding: version, one
    /// inventory, the active panes' titles, the Claude CLI and one /proc
    /// lookup -- five commands for any number of sessions.
    #[tokio::test]
    async fn status_poll_reads_the_inventory_titles_and_the_cli_in_five_commands() {
        let titles = [
            crate::status::title::details_line('T', 1, "[ ! ] Action Required | thread | home"),
            crate::status::title::details_line('C', 1, "/usr/bin/node"),
            crate::status::title::details_line(
                'G',
                1,
                "/usr/lib/node_modules/@openai/codex/bin/codex",
            ),
        ]
        .concat();
        let t = ScriptedTransport::new(vec![
            poll_exec("tmux 3.4\n"),
            poll_exec(POLL_INVENTORY),
            poll_exec(&titles),
            poll_exec(
                r#"[{"kind":"interactive","pid":11,"status":"waiting","waitingFor":"permission prompt"}]"#,
            ),
            poll_exec("11 10\n"),
        ]);
        let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(*t.calls.lock().unwrap(), 5);
        // The title read names exactly the active pane of each session.
        assert_eq!(
            &crate::remote::command::decoded_argv(&t.lines.lock().unwrap()[2])[3..],
            ["aidevbridge-panes", "sock", "%0", "10", "%1", "20"]
        );
        assert_eq!(
            poll,
            StatusPollDto {
                complete: true,
                server_pid: Some(50),
                server_start_time: Some(1000),
                sessions: vec![
                    StatusRowDto {
                        session_id: 0,
                        status: "waiting".into(),
                        status_reason: "permission prompt".into(),
                    },
                    StatusRowDto {
                        session_id: 1,
                        status: "waiting".into(),
                        status_reason: "action required (Codex title)".into(),
                    },
                ],
                agents_ok: true,
                titles_ok: true,
            }
        );
    }

    /// A failed title read means "no title source", not a failed poll.
    #[tokio::test]
    async fn status_poll_without_titles_still_reports_the_cli_status() {
        let mut failed = poll_exec("");
        failed.code = 1;
        let t = ScriptedTransport::new(vec![
            poll_exec("tmux 3.4\n"),
            poll_exec(POLL_INVENTORY),
            failed,
            poll_exec(r#"[{"kind":"interactive","pid":10,"status":"busy"}]"#),
            poll_exec("10 1\n"),
        ]);
        let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(*t.calls.lock().unwrap(), 5);
        assert_eq!(
            poll.sessions,
            vec![
                StatusRowDto {
                    session_id: 0,
                    status: "busy".into(),
                    status_reason: "agent is busy".into(),
                },
                StatusRowDto {
                    session_id: 1,
                    status: "unknown".into(),
                    status_reason: "no agent source is attached yet".into(),
                },
            ]
        );
    }

    /// tmux 3.6 (Ubuntu 26.04, gemessen am 2026-10-11) geht wie 3.4 durch die
    /// Abfrage: dieselben Befehle, derselbe Inventarweg, derselbe Befund.
    #[tokio::test]
    async fn status_poll_runs_the_measured_tmux_3_6_exactly_like_3_4() {
        let mut polls = Vec::new();
        for version in ["tmux 3.4\n", "tmux 3.6\n"] {
            let t = ScriptedTransport::new(vec![
                poll_exec(version),
                poll_exec(POLL_INVENTORY),
                poll_exec(""),
                poll_exec("[]"),
            ]);
            let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
                .await
                .unwrap();
            assert_eq!(*t.calls.lock().unwrap(), 4, "{version:?}");
            polls.push((poll, t.lines.lock().unwrap()[1..].to_vec()));
        }
        assert!(polls[1].0.complete);
        assert_eq!(polls[1].0.server_pid, Some(50));
        assert_eq!(polls[1].0.sessions.len(), 2);
        assert_eq!(polls[1], polls[0]);
    }

    #[tokio::test]
    async fn status_poll_on_an_unmeasured_tmux_version_claims_nothing() {
        // 3.5/3.5a und das unveraendert gebaute Upstream-3.6a sind nicht
        // gemessen; `tmux 3.6\r\n` ist nicht die gemessene Antwort.
        for version in ["tmux 3.5a\n", "tmux 3.5\n", "tmux 3.6a\n", "tmux 3.6\r\n"] {
            let t = ScriptedTransport::new(vec![poll_exec(version)]);
            let poll = poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
                .await
                .unwrap();
            assert_eq!(*t.calls.lock().unwrap(), 1, "{version:?}");
            assert_eq!(
                poll,
                StatusPollDto {
                    complete: false,
                    server_pid: None,
                    server_start_time: None,
                    sessions: vec![],
                    agents_ok: false,
                    titles_ok: false,
                },
                "{version:?}"
            );
        }
    }

    /// A named socket has no proven absence diagnosis: an error is a failed
    /// poll (shown as not current), never an empty list that ends sessions.
    #[tokio::test]
    async fn status_poll_fails_when_the_inventory_is_not_a_complete_snapshot() {
        let mut failed = poll_exec("");
        failed.code = 1;
        failed.stderr = "no server running on /tmp/tmux-1000/sock\n".into();
        let t = ScriptedTransport::new(vec![poll_exec("tmux 3.4\n"), failed]);
        assert!(
            poll_status_with(&t, &sock(), tokio::time::Instant::now() + COMMAND_TIMEOUT)
                .await
                .is_err()
        );
        assert_eq!(*t.calls.lock().unwrap(), 2);
    }

    // --- Restzeiten der Statusabfrage, in virtueller Zeit ---

    /// Eine Antwort, die nach `elapsed` virtueller Zeit eintrifft.
    struct TimedStep {
        result: Result<ExecResult, ExecError>,
        elapsed: Duration,
    }

    /// Wie in `tmux/client_observation_tests.rs`: spielt Antworten ab, stellt
    /// die angehaltene Uhr je Antwort vor und merkt sich Zeile und Frist.
    struct TimedTransport {
        steps: StdMutex<VecDeque<TimedStep>>,
        calls: StdMutex<Vec<(String, Duration)>>,
    }

    impl TimedTransport {
        fn calls(&self) -> Vec<(String, Duration)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Transport for TimedTransport {
        async fn exec_with_deadline(
            &self,
            line: &str,
            timeout: Duration,
        ) -> anyhow::Result<ExecResult> {
            self.calls.lock().unwrap().push((line.to_owned(), timeout));
            let step = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("unerwarteter Folgebefehl");
            if !step.elapsed.is_zero() {
                tokio::time::advance(step.elapsed).await;
            }
            step.result.map_err(Into::into)
        }
        async fn dispose(&self) {}
    }

    fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }

    fn answered(result: ExecResult, elapsed: Duration) -> TimedStep {
        TimedStep {
            result: Ok(result),
            elapsed,
        }
    }

    fn failed(reason: ExecReason) -> TimedStep {
        TimedStep {
            result: Err(ExecError {
                phase: ExecPhase::Read,
                reason,
                submission: Submission::PossiblySubmitted,
            }),
            elapsed: Duration::ZERO,
        }
    }

    /// Titelbefehl fuer die beiden aktiven Panes aus `POLL_INVENTORY`.
    fn title_line() -> String {
        crate::status::title::details_command(&sock(), &[(PaneId(0), 10), (PaneId(1), 20)]).unwrap()
    }

    /// Poll mit 5 s Gesamtfrist; Version sofort, das Inventar verbraucht
    /// `spent`. Jede Antwort in `rest` muss abgerufen werden, jeder weitere
    /// Befehl scheitert an `TimedTransport`.
    async fn timed_poll(spent: Duration, rest: Vec<TimedStep>) -> (StatusPollDto, TimedTransport) {
        let mut steps = vec![
            answered(poll_exec("tmux 3.4\n"), Duration::ZERO),
            answered(poll_exec(POLL_INVENTORY), spent),
        ];
        steps.extend(rest);
        let t = TimedTransport {
            steps: StdMutex::new(steps.into()),
            calls: StdMutex::new(Vec::new()),
        };
        let deadline = tokio::time::Instant::now() + STATUS_POLL_TIMEOUT;
        let poll = poll_status_with(&t, &sock(), deadline).await.unwrap();
        assert!(
            t.steps.lock().unwrap().is_empty(),
            "Antwort nicht abgerufen"
        );
        (poll, t)
    }

    #[tokio::test(start_paused = true)]
    async fn poll_skips_titles_when_less_than_500ms_remain() {
        // 499 ms nach dem Inventar: weder Titel noch claude.
        let (poll, t) = timed_poll(ms(4501), vec![]).await;
        assert!(poll.complete);
        assert_eq!((poll.titles_ok, poll.agents_ok), (false, false));
        assert_eq!(t.calls().len(), 2);
        // Genau 500 ms reichen, mit der Restzeit als Frist.
        let (poll, t) = timed_poll(ms(4500), vec![answered(poll_exec(""), ms(0))]).await;
        assert!(poll.titles_ok);
        assert_eq!(t.calls()[2], (title_line(), ms(500)));
    }

    #[tokio::test(start_paused = true)]
    async fn poll_skips_claude_when_less_than_1500ms_remain() {
        let (poll, t) = timed_poll(ms(3501), vec![answered(poll_exec(""), ms(0))]).await;
        assert_eq!((poll.titles_ok, poll.agents_ok), (true, false));
        assert_eq!(t.calls().len(), 3);
        assert_eq!(t.calls()[2], (title_line(), ms(1000)));
        // Genau 1500 ms: claude startet mit 1500 - 700 = 800 ms.
        let (poll, t) = timed_poll(
            ms(3500),
            vec![
                answered(poll_exec(""), ms(0)),
                answered(poll_exec("[]"), ms(0)),
            ],
        )
        .await;
        assert!(poll.agents_ok);
        assert_eq!(t.calls()[3], (crate::status::agents_command(), ms(800)));
    }

    /// Ein Agent mit pid 11: Er bindet nur ueber seinen Elternprozess an die
    /// Pane mit pid 10.
    fn busy_agent() -> ExecResult {
        poll_exec(r#"[{"kind":"interactive","pid":11,"status":"busy"}]"#)
    }

    /// 3 s vor claude: Frist min(4 s, 3 s - 700 ms) = 2,3 s. Antwortet claude
    /// erst am Ende dieser Frist, bleiben den Elternprozessen genau 700 ms.
    #[tokio::test(start_paused = true)]
    async fn claude_timeout_leaves_700ms_for_parents() {
        let (poll, t) = timed_poll(
            ms(2000),
            vec![
                answered(poll_exec(""), ms(0)),
                answered(busy_agent(), ms(2300)),
                answered(poll_exec("11 10\n"), ms(0)),
            ],
        )
        .await;
        let calls = t.calls();
        assert_eq!(calls[3], (crate::status::agents_command(), ms(2300)));
        assert_eq!(
            calls[4],
            (crate::status::parents_command(&[11]).unwrap(), ms(700))
        );
        assert!(poll.agents_ok);
        assert_eq!(poll.sessions[0].status, "busy");
    }

    /// Echt haelt die 700-ms-Reserve den Eltern genug Zeit frei; nur eine
    /// verspaetete Skriptantwort von claude erreicht diesen Zweig.
    #[tokio::test(start_paused = true)]
    async fn poll_skips_parents_when_less_than_500ms_remain() {
        // 5 s - 2 s - 2,501 s = 499 ms: kein Elternbefehl, die Quelle fehlt.
        let (poll, t) = timed_poll(
            ms(2000),
            vec![
                answered(poll_exec(""), ms(0)),
                answered(busy_agent(), ms(2501)),
            ],
        )
        .await;
        assert!(!poll.agents_ok);
        assert_eq!(t.calls().len(), 4);
        // Genau 500 ms reichen, mit der Restzeit als Frist.
        let (poll, t) = timed_poll(
            ms(2000),
            vec![
                answered(poll_exec(""), ms(0)),
                answered(busy_agent(), ms(2500)),
                answered(poll_exec("11 10\n"), ms(0)),
            ],
        )
        .await;
        assert!(poll.agents_ok);
        assert_eq!(
            t.calls()[4],
            (crate::status::parents_command(&[11]).unwrap(), ms(500))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn parents_read_failure_sets_agents_ok_false() {
        let mut refused = poll_exec("");
        refused.code = 1;
        for (parents, agents_ok) in [
            (failed(ExecReason::Transport), false),
            (failed(ExecReason::Timeout), false),
            // Eine Antwort zaehlt, gleich mit welchem Exitcode.
            (answered(refused, ms(0)), true),
        ] {
            let (poll, t) = timed_poll(
                ms(0),
                vec![
                    answered(poll_exec(""), ms(0)),
                    answered(busy_agent(), ms(0)),
                    parents,
                ],
            )
            .await;
            assert_eq!(
                t.calls()[4].0,
                crate::status::parents_command(&[11]).unwrap()
            );
            assert_eq!(poll.agents_ok, agents_ok);
            // Ohne Eltern bindet die Agentenzeile nicht.
            assert_eq!(poll.sessions[0].status, "unknown");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn claude_without_rows_needs_no_parents_read() {
        let (poll, t) = timed_poll(
            ms(0),
            vec![
                answered(poll_exec(""), ms(0)),
                answered(poll_exec("[]"), ms(0)),
            ],
        )
        .await;
        assert!(poll.agents_ok);
        assert_eq!(t.calls().len(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn claude_exit_127_counts_as_answered() {
        let mut missing = poll_exec("");
        missing.code = 127;
        missing.stderr = "sh: 1: exec: claude: not found\n".into();
        let (poll, t) = timed_poll(
            ms(0),
            vec![answered(poll_exec(""), ms(0)), answered(missing, ms(0))],
        )
        .await;
        assert!(poll.agents_ok);
        // Ohne Agentenzeile gibt es keine Elternabfrage.
        assert_eq!(t.calls().len(), 4);
        assert!(poll.sessions.iter().all(|row| row.status == "unknown"));
    }

    #[tokio::test(start_paused = true)]
    async fn claude_transport_error_sets_agents_ok_false() {
        // Ein Fristfehler zaehlt wie ein Transportfehler.
        for reason in [ExecReason::Transport, ExecReason::Timeout] {
            let (poll, t) =
                timed_poll(ms(0), vec![answered(poll_exec(""), ms(0)), failed(reason)]).await;
            assert!(poll.complete);
            assert_eq!((poll.titles_ok, poll.agents_ok), (true, false));
            assert_eq!(t.calls().len(), 4);
        }
    }

    /// Fuer die Panetitel gilt dieselbe Regel wie fuer claude.
    #[tokio::test(start_paused = true)]
    async fn title_answer_with_any_exit_code_counts_a_transport_error_does_not() {
        let mut refused = poll_exec("");
        refused.code = 1;
        let (poll, _) = timed_poll(
            ms(0),
            vec![answered(refused, ms(0)), answered(poll_exec("[]"), ms(0))],
        )
        .await;
        assert!(poll.titles_ok);
        let (poll, _) = timed_poll(
            ms(0),
            vec![
                failed(ExecReason::Transport),
                answered(poll_exec("[]"), ms(0)),
            ],
        )
        .await;
        assert_eq!((poll.titles_ok, poll.agents_ok), (false, true));
    }
    use crate::transport::operation_control::{ExecPhase, Submission};
    use crate::transport::ExecResult;
    use async_trait::async_trait;
    use rand::SeedableRng;
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;
    use zeroize::Zeroizing;

    // --- M-B (Abschlussreview): resolve_auth_method ---
    //
    // `AuthMethod` hat kein `PartialEq` (siehe dessen Doc-Kommentar in
    // `ssh/auth.rs` -- Geheimnisse in `Zeroizing`-Feldern sollen nicht
    // versehentlich ueber eine abgeleitete Gleichheitspruefung verglichen
    // werden). Assertions unten entpacken deshalb per `match`/`matches!`,
    // wie es der Rest der Codebasis fuer `AuthMethod`/`AuthError` bereits
    // durchgaengig tut (siehe `ssh/auth.rs`s Testmodul).

    #[test]
    fn resolve_auth_method_uses_agent_when_neither_key_path_nor_password_is_given() {
        let m = resolve_auth_method(None, None, None);
        assert!(matches!(m, AuthMethod::Agent));
    }

    #[test]
    fn resolve_auth_method_uses_key_without_passphrase_when_only_key_path_is_given() {
        let m = resolve_auth_method(Some("/home/x/.ssh/id_ed25519".to_string()), None, None);
        match m {
            AuthMethod::Key { path, passphrase } => {
                assert_eq!(path, PathBuf::from("/home/x/.ssh/id_ed25519"));
                assert!(passphrase.is_none());
            }
            other => panic!("falsche Variante: {other:?}"),
        }
    }

    /// Der zentrale Befund: `AuthMethod::Key{passphrase: Some(..)}` war schon
    /// immer implementiert und getestet (siehe `ssh/auth.rs`), aber ausserhalb
    /// der Modultests nirgends konstruierbar, weil `HostSpecDto` kein Feld
    /// dafuer hatte.
    #[test]
    fn resolve_auth_method_uses_key_with_passphrase_when_both_are_given() {
        let m = resolve_auth_method(
            Some("/home/x/.ssh/id_ed25519".to_string()),
            Some(Zeroizing::new("hunter2".to_string())),
            None,
        );
        match m {
            AuthMethod::Key { path, passphrase } => {
                assert_eq!(path, PathBuf::from("/home/x/.ssh/id_ed25519"));
                assert_eq!(
                    passphrase
                        .expect("Passphrase muss erhalten bleiben")
                        .as_str(),
                    "hunter2"
                );
            }
            other => panic!("falsche Variante: {other:?}"),
        }
    }

    /// Der zweite zentrale Befund: `AuthMethod::Password` war ebenfalls schon
    /// immer implementiert und getestet, aber ausserhalb der Modultests
    /// nirgends konstruierbar.
    #[test]
    fn resolve_auth_method_uses_password_when_no_key_path_is_given() {
        let m = resolve_auth_method(None, None, Some(Zeroizing::new("hunter2".to_string())));
        match m {
            AuthMethod::Password(pw) => assert_eq!(pw.as_str(), "hunter2"),
            other => panic!("falsche Variante: {other:?}"),
        }
    }

    /// Vorrangregel (siehe Doc-Kommentar an `resolve_auth_method`): ein
    /// gesetzter Schluesselpfad gewinnt IMMER gegen ein ebenfalls gesetztes
    /// Passwort -- ein Formular, das beide Felder gleichzeitig ausgefuellt
    /// zeigt, darf nicht zufaellig das eine oder andere waehlen.
    #[test]
    fn resolve_auth_method_prefers_key_path_over_password_when_both_are_given() {
        let m = resolve_auth_method(
            Some("/home/x/.ssh/id_ed25519".to_string()),
            None,
            Some(Zeroizing::new("hunter2".to_string())),
        );
        assert!(matches!(m, AuthMethod::Key { .. }));
    }

    /// Gegenprobe zur Vorrangregel aus der anderen Richtung: eine Passphrase
    /// OHNE Schluesselpfad wird stillschweigend verworfen, nicht als Passwort
    /// missverstanden (Spec §8.4: Passphrase gehoert ausschliesslich zu
    /// Schluessel-Auth).
    #[test]
    fn resolve_auth_method_ignores_a_passphrase_without_a_key_path() {
        let m = resolve_auth_method(None, Some(Zeroizing::new("hunter2".to_string())), None);
        assert!(matches!(m, AuthMethod::Agent));
    }

    // --- M-B: HostSpecDto ueber den tatsaechlichen Draht (JSON), nicht nur
    // per Rust-Struct-Literal -- belegt, dass die neuen Felder auch beim
    // ECHTEN `invoke()`-Aufruf aus dem WebView ankommen. ---

    #[test]
    fn host_spec_dto_deserializes_passphrase_and_password_from_json() {
        let json = r#"{
            "hostname": "192.0.2.10",
            "port": 22,
            "user": "u",
            "key_path": "/home/x/.ssh/id_ed25519",
            "passphrase": "hunter2",
            "password": "irrelevant-bei-key-auth"
        }"#;
        let dto: HostSpecDto = serde_json::from_str(json).unwrap();
        assert_eq!(dto.passphrase.as_ref().map(|p| p.as_str()), Some("hunter2"));
        assert_eq!(
            dto.password.as_ref().map(|p| p.as_str()),
            Some("irrelevant-bei-key-auth")
        );
    }

    /// Gegenprobe: ein Formular ohne Schluesseldatei (first-run.ts' Zweig
    /// ohne `keyPath`) sendet `passphrase`/`password` NICHT als literales
    /// `null`, sondern laesst die Schluessel ganz weg -- `#[serde(default)]`
    /// muss das ohne Fehler in `None` uebersetzen.
    #[test]
    fn host_spec_dto_defaults_passphrase_and_password_to_none_when_the_keys_are_absent() {
        let json = r#"{
            "hostname": "192.0.2.10",
            "port": 22,
            "user": "u",
            "key_path": null
        }"#;
        let dto: HostSpecDto = serde_json::from_str(json).unwrap();
        assert!(dto.passphrase.is_none());
        assert!(dto.password.is_none());
    }

    // --- OutputEvent: der Kern des Tasks ---

    /// Belegt die zentrale Zusicherung des Bytepfads: `bytes` ueberlebt
    /// eine Serde-Rundreise (wie sie ein `app.emit` durchlaeuft) auch dann
    /// byteidentisch, wenn der Puffer an einer Mehrbyte-UTF-8-Grenze
    /// zerschnitten ist -- `[0xE2, 0x82]` allein ist keine gueltige
    /// UTF-8-Sequenz (der Anfang von `€` = `[0xE2, 0x82, 0xAC]` ohne das
    /// dritte Byte). `serde_json` serialisiert `Vec<u8>` ohne `serde_bytes`
    /// als JSON-Array roher Zahlenwerte, nicht als Text -- deshalb betrifft
    /// UTF-8-Gueltigkeit die Serialisierung ueberhaupt nicht.
    #[test]
    fn output_event_round_trips_bytes_exactly_even_across_a_split_utf8_boundary() {
        let bytes = vec![b'x', 0xE2, 0x82, b'y', 0xE2, 0x82, 0xAC, b'z'];
        let ev = OutputEvent {
            host_id: "h1".into(),
            session: "ab_000000".to_string(),
            bytes: bytes.clone(),
            open_id: "fixture-open".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        let round_tripped: Vec<u8> = back["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(
            round_tripped, bytes,
            "rohe Bytes muessen die Serde-Rundreise unveraendert ueberstehen, \
             auch mit einer abgeschnittenen Mehrbyte-Sequenz darin"
        );
    }

    // --- session_key / belongs_to_host ---

    #[test]
    fn session_key_distinguishes_pairs_that_would_collide_under_naive_concatenation() {
        assert_ne!(
            session_key("1", SocketKind::App, "23"),
            session_key("12", SocketKind::App, "3")
        );
        assert_ne!(
            session_key("h1", SocketKind::App, "x"),
            session_key("h1", SocketKind::Default, "x")
        );
        assert!(belongs_to_host(
            &session_key("h1", SocketKind::Default, "x"),
            "h1"
        ));
    }

    #[test]
    fn belongs_to_host_requires_the_separator_not_just_a_prefix() {
        // h1 darf NICHT als Praefix von h10 durchgehen.
        assert!(!belongs_to_host("h10:ab_x", "h1"));
        assert!(belongs_to_host("h1:ab_x", "h1"));
        assert!(!belongs_to_host("h1:ab_x", "h10"));
    }

    // --- next_host_id ---

    #[test]
    fn next_host_id_produces_distinct_increasing_ids() {
        let counter = AtomicU64::new(0);
        let a = next_host_id(&counter);
        let b = next_host_id(&counter);
        assert_eq!(a, "h0");
        assert_eq!(b, "h1");
        assert_ne!(a, b);
    }

    // --- owns_current_entry (Wiedereroeffnen-Wettrennen) ---

    #[test]
    fn stale_pump_task_does_not_remove_a_reopened_entrys_slot() {
        // Generation 1 ist fertig, aber die Map zeigt inzwischen Generation
        // 2 (ein zwischenzeitliches close+open) -- Generation 1 darf NICHT
        // aufraeumen.
        assert!(!owns_current_entry(Some(2), 1));
    }

    #[test]
    fn pump_task_removes_its_own_still_current_entry() {
        assert!(owns_current_entry(Some(5), 5));
    }

    #[test]
    fn pump_task_for_an_already_removed_entry_does_nothing() {
        assert!(!owns_current_entry(None, 3));
    }

    // --- auth_error_message (Design §4.2/§4.5) ---
    //
    // Hermetisch, ohne VM und ohne AIDEVBRIDGE_TEST_HOST. Bewusst NICHT
    // ueber `key_auth_error_survives_the_anyhow_boundary` abgedeckt: der
    // belegt `KeyUnreadable`, nicht `PassphraseRequired`, und laeuft ohne
    // gesetzte Umgebungsvariable als No-Op durch -- genau die Zitierweise,
    // die dieses Projekt achtmal bestraft hat.

    /// Die Kerneigenschaft: der Nutzer bekommt die handlungsleitende
    /// Meldung, nicht `anyhow`s knappen `Display`-Text. Die zweite
    /// Zusicherung ist die diskriminierende -- ohne sie waere der Test auch
    /// dann gruen, wenn `user_message()` denselben Text wie `Display`
    /// zurueckgaebe (dann wuerde er nichts ueber die Verdrahtung sagen).
    #[test]
    fn auth_error_message_prefers_the_user_message_over_the_terse_display() {
        let e = anyhow::Error::from(AuthError::PassphraseRequired);
        assert_eq!(
            auth_error_message(&e),
            AuthError::PassphraseRequired.user_message()
        );
        assert_ne!(
            auth_error_message(&e),
            "passphrase required",
            "der knappe Display-Text darf NICHT mehr beim Nutzer landen"
        );
    }

    /// Der wichtigste Einzelfall (Design §4.5): Windows 11 liefert den
    /// ssh-agent standardmaessig deaktiviert aus. `AgentUnavailable`s
    /// `user_message()` nennt den PowerShell-Befehl, der ihn startet --
    /// diese Meldung war bisher unerreichbar.
    #[test]
    fn auth_error_message_carries_the_actionable_ssh_agent_instruction() {
        let e = anyhow::Error::from(AuthError::AgentUnavailable(
            "connection refused".to_string(),
        ));
        let message = auth_error_message(&e);
        assert!(
            message.contains("Set-Service ssh-agent"),
            "die ssh-agent-Meldung muss den Startbefehl enthalten, war: {message}"
        );
    }

    /// Zwei Nicht-Regressionen in einem: eine `AuthError`-Variante bleibt
    /// auch hinter einer `.context()`-Schicht findbar (heute fuegt niemand
    /// eine hinzu -- das soll auch dann noch gelten, wenn jemand es tut),
    /// und ein Fehler, der KEIN `AuthError` ist, behaelt seinen Text.
    #[test]
    fn auth_error_message_survives_context_and_falls_back_for_other_errors() {
        let wrapped = anyhow::Error::from(AuthError::PasswordWrong).context("connect failed");
        assert_eq!(
            auth_error_message(&wrapped),
            AuthError::PasswordWrong.user_message()
        );

        let unrelated = anyhow::anyhow!("something else entirely");
        assert_eq!(auth_error_message(&unrelated), "something else entirely");
    }

    // --- classify_connect_error (Task 8, Spec §4.8) -- ein ungetesteter
    // Klassifikator waere in dieser Datei ein Fremdkoerper (siehe die
    // Testdichte um `auth_error_message` direkt oberhalb). Deckt die
    // Abbildungstabelle ab: die zehn `AuthError`-Faelle und die beiden
    // Host-Key-Sonderfaelle.

    /// Der Host, den `classify_connect_error` in der Hostschluesselmeldung
    /// nennt (nur dort); die uebrigen Tests brauchen irgendeinen Wert.
    const CLASSIFY_HOST: &str = "192.0.2.20";

    #[test]
    fn classify_connect_error_maps_password_wrong_to_password_required() {
        let e = anyhow::Error::from(AuthError::PasswordWrong);
        let classified = classify_connect_error(&e, None, CLASSIFY_HOST);
        assert_eq!(classified.code, "password_required");
        assert_eq!(classified.message, AuthError::PasswordWrong.user_message());
    }

    #[test]
    fn classify_connect_error_maps_passphrase_variants_to_passphrase_required() {
        for variant in [AuthError::PassphraseRequired, AuthError::PassphraseWrong] {
            let e = anyhow::Error::from(variant);
            assert_eq!(
                classify_connect_error(&e, None, CLASSIFY_HOST).code,
                "passphrase_required"
            );
        }
    }

    #[test]
    fn classify_connect_error_maps_host_unreachable() {
        let e = anyhow::Error::from(AuthError::HostUnreachable);
        assert_eq!(
            classify_connect_error(&e, None, CLASSIFY_HOST).code,
            "host_unreachable"
        );
    }

    #[test]
    fn classify_connect_error_maps_method_not_offered_key_unreadable_and_agent_unavailable_to_auth_rejected(
    ) {
        for variant in [
            AuthError::MethodNotOffered("publickey".into()),
            AuthError::MultiFactorRequired("publickey".into()),
            AuthError::KeyUnreadable("x".into()),
            AuthError::AgentUnavailable("x".into()),
            AuthError::AgentNoIdentities("x".into()),
        ] {
            let e = anyhow::Error::from(variant);
            assert_eq!(
                classify_connect_error(&e, None, CLASSIFY_HOST).code,
                "auth_rejected"
            );
        }
    }

    /// Ein Fehler, der KEIN `AuthError` ist (z. B. ein TCP-Verbindungsfehler
    /// ohne Host-Key-Entscheidung), faellt auf `"other"` -- dieselbe
    /// Rueckfallkategorie, die `auth_error_message` fuer diesen Fall waehlt.
    #[test]
    fn classify_connect_error_falls_back_to_other_for_a_non_auth_error() {
        let e = anyhow::anyhow!("connection reset by peer");
        let classified = classify_connect_error(&e, None, CLASSIFY_HOST);
        assert_eq!(classified.code, "other");
        assert_eq!(classified.message, "connection reset by peer");
    }

    /// Host-Key-Ablehnung gewinnt VOR jeder Auth-Klassifikation. Die beiden
    /// Meldungstexte sind die aus Spec §10 (UX-Ueberarbeitung) -- Satz fuer
    /// Satz, denn der Nutzer liest sie unveraendert im Verbindungsfeld. Der
    /// `code` bleibt `host_key_rejected`: das Frontend wertet nur ihn aus,
    /// nie den Text.
    #[test]
    fn classify_connect_error_prefers_host_key_decision_over_auth_classification() {
        // Ein frei erfundener zugrundeliegender Fehler -- die Klassifikation
        // soll ihn bei gesetzter Host-Key-Entscheidung gar nicht erst ansehen.
        let e = anyhow::anyhow!("irrelevant underlying error");

        let unknown = classify_connect_error(&e, Some(HostKeyDecision::Unknown), CLASSIFY_HOST);
        assert_eq!(unknown.code, "host_key_rejected");
        assert_eq!(
            unknown.message,
            "The host key wasn't confirmed, so aidevbridge didn't connect."
        );

        let mismatch = classify_connect_error(&e, Some(HostKeyDecision::Mismatch), CLASSIFY_HOST);
        assert_eq!(mismatch.code, "host_key_rejected");
        assert_eq!(
            mismatch.message,
            "The host key of 192.0.2.20 has changed. Someone may be intercepting the connection \
             — or the server was reinstalled. If you're sure, remove its old entry from \
             ~/.ssh/known_hosts, for example with ssh-keygen -R \"192.0.2.20\", and connect \
             again."
        );
    }

    /// Der Host in der Meldung ist der Name, unter dem `known_hosts` ihn fuehrt
    /// (`known_hosts::host_token`, so ruft `connect_host_core` es auf): ohne
    /// Port auf 22 der Host selbst, sonst `[host]:port`, auch ein IPv6-Literal.
    /// Unter diesem Namen sucht der Nutzer den alten Eintrag zum Entfernen.
    #[test]
    fn a_changed_host_key_names_the_known_hosts_token() {
        let e = anyhow::anyhow!("irrelevant underlying error");
        for (hostname, port, named) in [
            ("192.0.2.20", 22, "192.0.2.20"),
            ("vm.example", 22, "vm.example"),
            ("vm.example", 2222, "[vm.example]:2222"),
            ("fe80::1", 22, "fe80::1"),
            ("fe80::1", 2222, "[fe80::1]:2222"),
        ] {
            let host = known_hosts::host_token(hostname, port);
            let mismatch = classify_connect_error(&e, Some(HostKeyDecision::Mismatch), &host);
            assert_eq!(mismatch.code, "host_key_rejected");
            assert!(
                mismatch
                    .message
                    .starts_with(&format!("The host key of {named} has changed. ")),
                "{hostname}:{port}: {}",
                mismatch.message
            );
        }
    }

    #[test]
    fn rsa_signing_failure_survives_context_and_does_not_request_passphrase() {
        let error = anyhow::Error::new(AuthError::SigningFailed).context("authentication failed");
        for decision in [None, Some(HostKeyDecision::Known)] {
            let classified = classify_connect_error(&error, decision, CLASSIFY_HOST);
            assert_eq!(classified.code, "auth_rejected");
            assert_eq!(classified.message, AuthError::SigningFailed.user_message());
            assert_ne!(
                classified.message,
                AuthError::PassphraseWrong.user_message()
            );
        }
    }

    // --- AckWindow (reine Buchhaltung) ---

    #[test]
    fn ack_window_has_room_up_to_capacity() {
        let mut w = AckWindow::new(100);
        assert!(w.has_room(100));
        w.reserve(100);
        assert!(!w.has_room(1));
    }

    #[test]
    fn ack_window_release_restores_room() {
        let mut w = AckWindow::new(100);
        w.reserve(100);
        assert!(!w.has_room(1));
        w.release(40);
        assert!(w.has_room(40));
        assert!(!w.has_room(41));
    }

    #[test]
    fn ack_window_lets_a_single_oversized_chunk_through_when_empty() {
        let w = AckWindow::new(10);
        assert!(w.has_room(999));
    }

    #[test]
    fn ack_window_oversized_chunk_still_blocks_a_second_chunk_until_acked() {
        let mut w = AckWindow::new(10);
        w.reserve(999);
        assert!(!w.has_room(1));
    }

    #[test]
    fn ack_window_release_saturates_instead_of_underflowing() {
        let mut w = AckWindow::new(100);
        w.reserve(10);
        w.release(999); // zu grosser/doppelter Ack
        assert_eq!(w.in_flight(), 0);
        assert!(w.has_room(100));
    }

    // --- AckGate (die eigentliche Bremse, async) ---

    /// Der wichtigste Test des Tasks: belegt, dass `wait_for_room`
    /// TATSAECHLICH blockiert, nicht bloss Buchhaltung fuehrt, und dass ein
    /// `ack()` es tatsaechlich wieder freigibt.
    #[tokio::test]
    async fn ack_gate_actually_restrains_and_then_releases() {
        let gate = Arc::new(AckGate::new(10));
        gate.wait_for_room(10).await; // Fenster komplett ausgeschoepft

        let g = gate.clone();
        let mut waiter = tokio::spawn(async move {
            g.wait_for_room(5).await;
        });

        let premature =
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut waiter).await;
        assert!(
            premature.is_err(),
            "wait_for_room durfte ohne ausreichenden Kredit nicht zurueckkehren"
        );

        gate.ack(5);

        let completed = tokio::time::timeout(std::time::Duration::from_millis(500), waiter).await;
        assert!(
            completed.is_ok(),
            "wait_for_room haette nach ack() zurueckkehren muessen"
        );
    }

    // --- ack_output_impl gegen einen bereits entfernten Eintrag (Befund 9,
    // Abschlussbewertung 2026-09-04): die Pumpaufgabe entfernt den
    // Terminaleintrag, BEVOR das WebView das Ack fuer den letzten Chunk aus
    // seinem `write()`-Callback schickt. Dasselbe nachlaufende Ack trifft
    // dann ins Leere -- kein Fehler, dieselbe Idempotenz wie
    // `disconnect_host_impl`. ---

    #[tokio::test]
    async fn ack_for_an_unknown_terminal_is_ok_not_an_error() {
        let state = Arc::new(AppState::default());
        let r = ack_output_impl(&state, "h1".into(), "gone".into(), 42).await;
        assert!(
            r.is_ok(),
            "ein nachlaufendes Ack fuer einen bereits entfernten Eintrag ist kein Fehler"
        );
    }

    // --- wait_for_room_cancel_or_stall (Befund 2, Task 10 + Design §2.4:
    // Abbruchsignal gegen das Verwaisen der Pumpaufgabe, wenn ihre Session
    // waehrend eines Wartens in `wait_for_room` abgeraeumt wird; Stillstands-
    // Zeitlimit gegen einen Renderer, der nicht mehr ackt) ---

    /// Der eigentliche Beweis fuer Befund 2 (Task 10): ohne Kredit UND ohne
    /// Abbruch haengt die Funktion. Kommt ein Abbruchsignal, MUSS sie
    /// zurueckkehren -- und mit `Cancelled`, nicht `Proceed`: eine
    /// Implementierung, die bei Abbruch faelschlich `Proceed` liefert, wuerde
    /// den Pump-Loop `sink.send()` aufrufen lassen, obwohl kein Kredit
    /// reserviert wurde (Buchhaltung liefe aus dem Ruder).
    ///
    /// `stall_timeout` bewusst eine Stunde: dieser Test prueft den
    /// Abbruchpfad, nicht den Waechter. Waere der Wert hier klein, koennte
    /// der Test gruen bleiben, weil der WAECHTER zurueckkehrt -- und die
    /// Abbrucheigenschaft waere ungeprueft.
    #[tokio::test]
    async fn wait_for_room_cancel_or_stall_returns_cancelled_instead_of_hanging_forever() {
        let gate = Arc::new(AckGate::new(10));
        gate.wait_for_room(10).await; // Fenster ausgeschoepft, niemand wird je acken

        let cancel = Arc::new(Notify::new());
        let g = gate.clone();
        let c = cancel.clone();
        let mut waiter = tokio::spawn(async move {
            wait_for_room_cancel_or_stall(&g, &c, 5, Duration::from_secs(3600)).await
        });

        let premature = tokio::time::timeout(Duration::from_millis(100), &mut waiter).await;
        assert!(
            premature.is_err(),
            "ohne Kredit, ohne Abbruch und ohne abgelaufenen Waechter darf sie nicht zurueckkehren"
        );

        cancel.notify_one();

        let completed = tokio::time::timeout(Duration::from_millis(500), waiter)
            .await
            .expect("haette nach dem Abbruchsignal zurueckkehren muessen")
            .expect("Task ist gepanickt");
        assert_eq!(
            completed,
            PumpDecision::Cancelled,
            "ein Abbruch muss Cancelled liefern (kein Kredit reserviert)"
        );
    }

    /// Gegenprobe zur `notify_one`-Entscheidung (siehe `AckGate::ack`s
    /// Kommentar): ein Abbruchsignal, das VOR dem Warten ankommt, darf nicht
    /// verloren gehen.
    #[tokio::test]
    async fn wait_for_room_cancel_or_stall_does_not_lose_a_cancel_sent_before_waiting() {
        let gate = AckGate::new(10);
        gate.wait_for_room(10).await; // ausgeschoepft
        let cancel = Notify::new();
        cancel.notify_one(); // Abbruch VOR dem Aufruf

        let decision = tokio::time::timeout(
            Duration::from_millis(200),
            wait_for_room_cancel_or_stall(&gate, &cancel, 5, Duration::from_secs(3600)),
        )
        .await
        .expect("haette nicht haengen duerfen -- verlorenes Weck-Signal?");
        assert_eq!(
            decision,
            PumpDecision::Cancelled,
            "ein VOR dem Warten gesetztes Abbruchsignal darf nicht verloren gehen"
        );
    }

    /// Kredit vorhanden -> `Proceed`. Der langweiligste Fall, und trotzdem
    /// noetig: ohne ihn koennte eine Implementierung, die IMMER `Stalled`
    /// liefert, die beiden Abbruchtests oben bestehen.
    #[tokio::test]
    async fn wait_for_room_cancel_or_stall_proceeds_when_there_is_room() {
        let gate = AckGate::new(1000);
        let cancel = Notify::new();
        let decision =
            wait_for_room_cancel_or_stall(&gate, &cancel, 10, Duration::from_millis(50)).await;
        assert_eq!(decision, PumpDecision::Proceed);
    }

    /// Der Waechter selbst: Fenster voll, niemand ackt, kein Abbruch --
    /// nach `stall_timeout` MUSS `Stalled` kommen statt zu haengen. Das ist
    /// die Eigenschaft, die verhindert, dass eine einzige ungeackte Session
    /// den geteilten russh-Dispatch-Loop der ganzen Verbindung staut
    /// (Design §2.1, empirisch belegt in §2.2).
    #[tokio::test]
    async fn wait_for_room_cancel_or_stall_reports_stalled_when_no_ack_ever_arrives() {
        let gate = AckGate::new(10);
        gate.wait_for_room(10).await; // ausgeschoepft
        let cancel = Notify::new();

        let started = std::time::Instant::now();
        let decision = tokio::time::timeout(
            Duration::from_secs(5),
            wait_for_room_cancel_or_stall(&gate, &cancel, 5, Duration::from_millis(150)),
        )
        .await
        .expect("der Waechter haette nach stall_timeout zurueckkehren muessen, statt zu haengen");

        assert_eq!(decision, PumpDecision::Stalled);
        assert!(
            started.elapsed() >= Duration::from_millis(150),
            "der Waechter darf nicht VOR seinem Zeitlimit feuern -- sonst wuerde er einen \
             langsamen, aber gesunden Renderer abschiessen (tatsaechlich: {:?})",
            started.elapsed()
        );
    }

    /// Die andere Richtung, und der wichtigere der beiden Waechter-Tests:
    /// ein langsam aber STETIG ackender Renderer darf ueber eine
    /// Gesamtdauer von deutlich MEHR als `stall_timeout` hinweg NICHT
    /// abgeschossen werden. Das Zeitlimit gilt pro Aufruf, nicht fuer die
    /// Lebensdauer der Session.
    ///
    /// Ohne diesen Test bliebe eine spaeter naheliegend aussehende
    /// Umstrukturierung gruen -- das Zeitlimit AUSSERHALB der Pumpschleife
    /// aufzuspannen -- und wuerde die Bedeutung lautlos zu "jede Session,
    /// die unter Rueckstau laenger als STALL_TIMEOUT lebt, stirbt"
    /// verschieben. Die Fehlerklasse "Test war gruen, prueft aber nichts"
    /// trat in diesem Projekt schon achtmal auf; das hier ist ein
    /// offensichtlicher Kandidat fuer das neunte Mal.
    ///
    /// Praezisierung, was dieser Test NICHT beweist (Review-Nachtrag): er
    /// ruft die Pumpschleife in `open_terminal_impl` selbst nicht auf,
    /// sondern ausschliesslich `wait_for_room_cancel_or_stall` direkt --
    /// eine ausserhalb der Schleife aufgespannte Deadline waere fuer diesen
    /// Test unsichtbar. Was der Test tatsaechlich beweist: ein stetig
    /// ackender Aufrufer bekommt ueber WIEDERHOLTE Aufrufe hinweg nie
    /// `Stalled`, UND die Gesamtdauer ueberschreitet `stall_timeout` (siehe
    /// die Assertion unten) -- die Pro-Aufruf-Semantik selbst folgt bereits
    /// aus der Signatur (die Funktion ist zustandslos, jeder Aufruf spannt
    /// sein eigenes `tokio::time::sleep` auf; die Gegenprobe dazu
    /// bestaetigt nur, dass ein kleinerer `stall_timeout`-Wert Runde 0 rot
    /// werden laesst, nicht, dass das Zeitlimit ueber Aufrufe hinweg
    /// zusammenhaengt). Dass die Pumpschleife dieses Pro-Aufruf-Verhalten
    /// nicht versehentlich in ein Pro-Session-Verhalten verwandelt, sichert
    /// stattdessen Task 2s Integrationstest
    /// `a_stalled_session_does_not_take_the_whole_connection_down` gegen die
    /// echte Schleife ab. Ein spaeterer Umbau auf ein deadline-basiertes
    /// statt ein pro-Aufruf-Zeitlimit wuerde die Signatur aendern (kein
    /// `stall_timeout: Duration`-Parameter mehr) -- dieser Test wuerde dann
    /// ohnehin neu geschrieben, nicht lautlos gruen bleiben.
    #[tokio::test]
    async fn wait_for_room_cancel_or_stall_budget_is_per_call_not_per_session() {
        // Zeitverhaeltnisse mit Absicht weit auseinander: jede EINZELNE
        // Wartezeit hat gegen das Zeitlimit einen Faktor 20 Luft (25 ms gegen
        // 500 ms), damit der Test auf einer belasteten Maschine nicht
        // flackert -- die SUMME (25 x 25 ms = 625 ms) ueberschreitet das
        // Limit trotzdem. Genau diese Kombination ist der Punkt: mit einem
        // globalen Zeitlimit waere der Test rot, mit einem Pro-Aufruf-Limit
        // gruen.
        let gate = Arc::new(AckGate::new(100));
        let cancel = Notify::new();
        let stall_timeout = Duration::from_millis(500);
        const ROUNDS: usize = 25;
        const ACK_DELAY: Duration = Duration::from_millis(25);

        // Fenster zuerst ausschoepfen, damit ab Runde 0 wirklich gewartet
        // wird. Ohne das laesst `has_room`s `in_flight == 0`-Notausgang die
        // erste Runde sofort durch, und der Test prueeft eine Runde weniger,
        // als er zu pruefen behauptet.
        gate.wait_for_room(100).await;

        let started = std::time::Instant::now();
        for round in 0..ROUNDS {
            // Genau EIN Acker je Runde, der genau die reservierte Menge
            // freigibt -- danach ist `in_flight` wieder 0 und die Runde
            // reserviert erneut 100. Keine ueberzaehligen Acks, die
            // `release`s saturierende Subtraktion stillschweigend
            // verschluckt: die Buchhaltung bleibt fuer den naechsten Leser
            // nachvollziehbar.
            let g = gate.clone();
            tokio::spawn(async move {
                tokio::time::sleep(ACK_DELAY).await;
                g.ack(100);
            });
            let decision = wait_for_room_cancel_or_stall(&gate, &cancel, 100, stall_timeout).await;
            assert_eq!(
                decision,
                PumpDecision::Proceed,
                "Runde {round}: ein stetig ackender Renderer darf nie Stalled bekommen"
            );
        }
        assert!(
            started.elapsed() > stall_timeout,
            "der Test ist vakuos, wenn die Gesamtdauer ({:?}) das Zeitlimit ({stall_timeout:?}) \
             nicht ueberschreitet -- dann haette auch ein einziges globales Zeitlimit gereicht",
            started.elapsed()
        );
    }

    // --- read_known_hosts_text (H5, Kritikrunde) ---

    #[tokio::test]
    async fn read_known_hosts_text_missing_file_is_empty_not_an_error() {
        let path = std::env::temp_dir().join(format!(
            "aidevbridge_test_read_known_hosts_missing_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(!path.exists());
        let text = read_known_hosts_text(&path)
            .await
            .expect("eine fehlende Datei ist kein Fehler");
        assert_eq!(text, "", "eine fehlende Datei zaehlt als leerer Inhalt");
    }

    /// Der eigentliche Beleg fuer H5: eine Datei, die zwar EXISTIERT, aber
    /// nicht gelesen werden kann (hier: ein Verzeichnis unter demselben
    /// Pfad -- `read_to_string` auf ein Verzeichnis schlaegt mit einem
    /// Fehler fehl, der NICHT `NotFound` ist), darf NICHT wie eine leere
    /// Datei behandelt werden. Vor der H5-Behebung verschluckte
    /// `unwrap_or_default()` genau diesen Fall -- ein Host waere dann immer
    /// `Unknown` statt dass ein tatsaechlich veraenderter Schluessel als
    /// `Mismatch` erkannt wird.
    #[tokio::test]
    async fn read_known_hosts_text_unreadable_path_is_an_error_naming_the_path() {
        let path = std::env::temp_dir().join(format!(
            "aidevbridge_test_read_known_hosts_unreadable_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();

        let err = read_known_hosts_text(&path)
            .await
            .expect_err("ein Verzeichnis laesst sich nicht als Text lesen -- das ist ein Fehler, keine leere Datei");
        assert!(
            err.contains(&path.display().to_string()),
            "Meldung soll den betroffenen Pfad nennen: {err}"
        );

        let _ = std::fs::remove_dir(&path);
    }

    // --- Hostverwaltung: list_hosts_impl/add_host_impl/remove_host_impl
    // (Task 13) -- alle drei nehmen `settings_path` explizit entgegen,
    // damit diese Tests niemals die echte `%APPDATA%\io.github.itbrain258.aidevbridge\
    // settings.toml` des Bedienrechners anfassen (dasselbe Muster wie
    // `settings::load_from`/`save_to` gegenueber `load`/`save`).

    fn unique_temp_settings_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("aidevbridge_test_cmd_settings_{tag}_{nanos}.toml"))
    }

    fn new_host_dto(hostname: &str) -> NewHostEntryDto {
        NewHostEntryDto {
            label: hostname.to_string(),
            hostname: hostname.to_string(),
            user: "u".to_string(),
            port: 22,
            tmux_socket: None,
            history_limit: None,
            key_path: None,
            auth_kind: None,
            show_default_socket: None,
        }
    }

    #[test]
    fn list_hosts_impl_on_a_missing_settings_file_is_an_empty_list_not_an_error() {
        let path = unique_temp_settings_path("list_missing");
        assert!(!path.exists());
        assert_eq!(list_hosts_impl(&path).unwrap(), Vec::new());
    }

    #[test]
    fn add_host_impl_persists_defaults_and_list_hosts_impl_sees_it_afterwards() {
        let path = unique_temp_settings_path("add");
        let entry = add_host_impl(&path, new_host_dto("192.0.2.50")).unwrap();
        assert_eq!(entry.hostname, "192.0.2.50");
        assert_eq!(entry.port, 22);
        assert_eq!(entry.tmux_socket, "agentbridge");
        assert_eq!(entry.history_limit, settings::default_history());
        assert!(!entry.id.is_empty());

        let hosts = list_hosts_impl(&path).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].id, entry.id);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn add_host_impl_twice_produces_two_distinct_ids_and_keeps_both() {
        let path = unique_temp_settings_path("add_twice");
        let a = add_host_impl(&path, new_host_dto("192.0.2.51")).unwrap();
        let b = add_host_impl(&path, new_host_dto("192.0.2.52")).unwrap();
        assert_ne!(a.id, b.id, "zwei Hosts duerfen nicht dieselbe id bekommen");

        let hosts = list_hosts_impl(&path).unwrap();
        assert_eq!(
            hosts.len(),
            2,
            "der zweite add_host darf den ersten nicht ueberschreiben"
        );
        let _ = std::fs::remove_file(&path);
    }

    // --- UI v2 (Spec §12.4, §16.3): ui_settings_impl ---

    #[test]
    fn ui_settings_impl_reads_the_default_without_creating_a_file() {
        let path = unique_temp_settings_path("ui_settings_read");
        let dto = ui_settings_impl(&path, None).unwrap();
        assert_eq!(dto.theme, "turquoise");
        assert!(
            !path.exists(),
            "Lesen darf die Datei nicht anlegen (Spec §12.3)"
        );
    }

    #[test]
    fn ui_settings_impl_patch_writes_the_ui_section_and_keeps_hosts() {
        let path = unique_temp_settings_path("ui_settings_patch");
        add_host_impl(&path, new_host_dto("192.0.2.60")).unwrap();
        let dto = ui_settings_impl(&path, Some(theme_patch("slate"))).unwrap();
        assert_eq!(dto.theme, "slate");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[ui]"), "{text}");
        assert!(text.contains("theme = \"slate\""), "{text}");
        assert_eq!(
            list_hosts_impl(&path).unwrap().len(),
            1,
            "Hosts bleiben erhalten"
        );
        assert_eq!(ui_settings_impl(&path, None).unwrap().theme, "slate");
        assert_eq!(
            settings::temp_files_beside(&path),
            Vec::<PathBuf>::new(),
            "temporaere Datei wurde umbenannt"
        );
        let _ = std::fs::remove_file(&path);
    }

    // --- UX-Ueberarbeitung (Spec §7.1, §9.2): Terminal-Voreinstellungen und
    // Arbeitsplatz ueber `ui_settings` ---

    fn theme_patch(theme: &str) -> UiSettingsPatchDto {
        UiSettingsPatchDto {
            theme: Some(theme.into()),
            ..Default::default()
        }
    }

    fn tile(slot: u8, host_id: &str, session: &str) -> TileEntryDto {
        TileEntryDto {
            slot,
            host_id: host_id.into(),
            session: session.into(),
            foreign_session: None,
            socket: None,
        }
    }

    fn dirs(last: Option<&str>, recent: &[&str]) -> HostDirsDto {
        HostDirsDto {
            last: last.map(String::from),
            recent: recent.iter().map(|d| d.to_string()).collect(),
        }
    }

    /// Ein Arbeitsplatz, der auf beide Hosts verweist.
    fn busy_workspace(a: &str, b: &str) -> WorkspaceDto {
        WorkspaceDto {
            layout: 4,
            tiles_version: 2,
            sidebar_collapsed: true,
            expanded: vec![a.into(), b.into()],
            connected: vec![a.into()],
            tiles: vec![tile(0, a, "one"), tile(1, b, "two")],
            dirs: BTreeMap::from([
                (a.to_string(), dirs(Some("/srv/a"), &["/srv/a", "/opt/x"])),
                (b.to_string(), dirs(None, &["/srv/b"])),
            ]),
        }
    }

    fn empty_workspace() -> WorkspaceDto {
        WorkspaceDto {
            layout: 1,
            // wie Workspace::default(): diesen Stand liest
            // ui_settings_impl_reads_every_default_and_names_the_settings_file
            // aus einer fehlenden Datei
            tiles_version: settings::TILES_VERSION_SLOTS,
            sidebar_collapsed: false,
            expanded: Vec::new(),
            connected: Vec::new(),
            tiles: Vec::new(),
            dirs: BTreeMap::new(),
        }
    }

    #[test]
    fn ui_settings_impl_reads_every_default_and_names_the_settings_file() {
        let path = unique_temp_settings_path("ui_settings_defaults");
        let dto = ui_settings_impl(&path, None).unwrap();
        assert_eq!(
            dto,
            UiSettingsDto {
                theme: "turquoise".into(),
                terminal_font_size: 13,
                copy_on_select: false,
                ctrl_cv_clipboard: true,
                right_click: "menu".into(),
                restore_workspace: true,
                sidebar_width: 240,
                workspace: empty_workspace(),
                settings_path: path.display().to_string(),
            }
        );
        assert!(!path.exists(), "Lesen legt die Datei nicht an");
    }

    #[test]
    fn ui_settings_impl_patch_with_only_the_theme_changes_nothing_else() {
        let path = unique_temp_settings_path("ui_settings_theme_only");
        let a = add_host_impl(&path, new_host_dto("192.0.2.61")).unwrap();
        let b = add_host_impl(&path, new_host_dto("192.0.2.62")).unwrap();
        // Erst alles vom Standard wegsetzen, damit "unveraendert" etwas heisst.
        let before = ui_settings_impl(
            &path,
            Some(UiSettingsPatchDto {
                theme: Some("slate".into()),
                terminal_font_size: Some(17),
                copy_on_select: Some(true),
                ctrl_cv_clipboard: Some(false),
                right_click: Some("paste".into()),
                restore_workspace: Some(false),
                sidebar_width: Some(300),
                workspace: Some(busy_workspace(&a.id, &b.id)),
            }),
        )
        .unwrap();
        assert_eq!(before.terminal_font_size, 17);
        assert!(before.copy_on_select);
        assert!(!before.ctrl_cv_clipboard);
        assert_eq!(before.right_click, "paste");
        assert!(!before.restore_workspace);
        assert_eq!(before.sidebar_width, 300);
        assert_eq!(before.workspace, busy_workspace(&a.id, &b.id));

        let after = ui_settings_impl(&path, Some(theme_patch("turquoise-slate"))).unwrap();
        assert_eq!(after.theme, "turquoise-slate");
        assert_eq!(
            UiSettingsDto {
                theme: before.theme.clone(),
                ..after.clone()
            },
            before,
            "ausser dem Thema bleibt alles stehen"
        );
        assert_eq!(ui_settings_impl(&path, None).unwrap(), after);
        assert_eq!(list_hosts_impl(&path).unwrap().len(), 2, "Hosts bleiben");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ui_settings_impl_applies_each_patched_field_alone() {
        let path = unique_temp_settings_path("ui_settings_each_field");
        let patches = [
            UiSettingsPatchDto {
                terminal_font_size: Some(18),
                ..Default::default()
            },
            UiSettingsPatchDto {
                copy_on_select: Some(true),
                ..Default::default()
            },
            UiSettingsPatchDto {
                ctrl_cv_clipboard: Some(false),
                ..Default::default()
            },
            UiSettingsPatchDto {
                right_click: Some("paste".into()),
                ..Default::default()
            },
            UiSettingsPatchDto {
                restore_workspace: Some(false),
                ..Default::default()
            },
            UiSettingsPatchDto {
                sidebar_width: Some(360),
                ..Default::default()
            },
        ];
        let mut expected = ui_settings_impl(&path, None).unwrap();
        for patch in patches {
            let got = ui_settings_impl(&path, Some(patch.clone())).unwrap();
            // Genau das gepatchte Feld aendert sich.
            if let Some(value) = patch.terminal_font_size {
                expected.terminal_font_size = value;
            }
            if let Some(value) = patch.copy_on_select {
                expected.copy_on_select = value;
            }
            if let Some(value) = patch.ctrl_cv_clipboard {
                expected.ctrl_cv_clipboard = value;
            }
            if let Some(value) = patch.right_click {
                expected.right_click = value;
            }
            if let Some(value) = patch.restore_workspace {
                expected.restore_workspace = value;
            }
            if let Some(value) = patch.sidebar_width {
                expected.sidebar_width = value;
            }
            assert_eq!(got, expected);
        }
        assert_eq!(ui_settings_impl(&path, None).unwrap(), expected);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ui_settings_impl_clamps_patched_values_and_returns_what_was_stored() {
        let path = unique_temp_settings_path("ui_settings_clamp");
        let mut workspace = empty_workspace();
        workspace.layout = 3;
        workspace.tiles = vec![tile(9, "nobody", "x")];
        let dto = ui_settings_impl(
            &path,
            Some(UiSettingsPatchDto {
                terminal_font_size: Some(99),
                right_click: Some("bogus".into()),
                sidebar_width: Some(10),
                workspace: Some(workspace),
                ..Default::default()
            }),
        )
        .unwrap();
        // Die Antwort zeigt den gespeicherten Stand, nicht den gesendeten.
        assert_eq!(dto.terminal_font_size, 13);
        assert_eq!(dto.right_click, "menu");
        assert_eq!(dto.sidebar_width, 240);
        assert_eq!(dto.workspace, empty_workspace());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("terminal_font_size = 13"), "{text}");
        assert!(text.contains("sidebar_width = 240"), "{text}");
        assert_eq!(ui_settings_impl(&path, None).unwrap(), dto);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ui_settings_impl_patch_with_a_workspace_replaces_the_whole_workspace() {
        let path = unique_temp_settings_path("ui_settings_workspace");
        let a = add_host_impl(&path, new_host_dto("192.0.2.63")).unwrap();
        let b = add_host_impl(&path, new_host_dto("192.0.2.64")).unwrap();

        let first = busy_workspace(&a.id, &b.id);
        let dto = ui_settings_impl(
            &path,
            Some(UiSettingsPatchDto {
                workspace: Some(first.clone()),
                ..Default::default()
            }),
        )
        .unwrap();
        assert_eq!(dto.workspace, first);

        // Ein zweiter, ganz anderer Arbeitsplatz ersetzt den ersten
        // vollstaendig -- nichts davon wird eingemischt.
        let second = WorkspaceDto {
            layout: 2,
            tiles_version: 2,
            sidebar_collapsed: false,
            expanded: vec![b.id.clone()],
            connected: Vec::new(),
            tiles: vec![tile(2, &b.id, "three")],
            dirs: BTreeMap::from([(b.id.clone(), dirs(Some("/only/b"), &["/only/b"]))]),
        };
        let dto = ui_settings_impl(
            &path,
            Some(UiSettingsPatchDto {
                workspace: Some(second.clone()),
                ..Default::default()
            }),
        )
        .unwrap();
        assert_eq!(dto.workspace, second);
        assert_eq!(ui_settings_impl(&path, None).unwrap().workspace, second);

        // Ohne `workspace` im Patch bleibt er, wie er ist.
        let dto = ui_settings_impl(&path, Some(theme_patch("slate"))).unwrap();
        assert_eq!(dto.workspace, second);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ui_settings_impl_drops_workspace_entries_of_unknown_hosts_when_saving() {
        let path = unique_temp_settings_path("ui_settings_unknown_hosts");
        let a = add_host_impl(&path, new_host_dto("192.0.2.65")).unwrap();
        let mut workspace = busy_workspace(&a.id, "host_ghost");
        workspace.tiles.push(tile(2, "host_ghost", "three"));
        let dto = ui_settings_impl(
            &path,
            Some(UiSettingsPatchDto {
                workspace: Some(workspace),
                ..Default::default()
            }),
        )
        .unwrap();
        assert_eq!(dto.workspace.expanded, std::slice::from_ref(&a.id));
        assert_eq!(dto.workspace.connected, std::slice::from_ref(&a.id));
        assert_eq!(dto.workspace.tiles, [tile(0, &a.id, "one")]);
        assert_eq!(dto.workspace.dirs.keys().collect::<Vec<_>>(), [&a.id]);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("ghost"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn remove_host_impl_removes_the_host_from_expanded_connected_tiles_and_dirs() {
        let path = unique_temp_settings_path("remove_host_workspace");
        let a = add_host_impl(&path, new_host_dto("192.0.2.66")).unwrap();
        let b = add_host_impl(&path, new_host_dto("192.0.2.67")).unwrap();
        ui_settings_impl(
            &path,
            Some(UiSettingsPatchDto {
                workspace: Some(busy_workspace(&a.id, &b.id)),
                ..Default::default()
            }),
        )
        .unwrap();

        remove_host_impl(&path, &a.id).unwrap();

        let workspace = ui_settings_impl(&path, None).unwrap().workspace;
        assert_eq!(workspace.expanded, std::slice::from_ref(&b.id));
        assert!(workspace.connected.is_empty());
        assert_eq!(workspace.tiles, [tile(1, &b.id, "two")]);
        assert_eq!(
            workspace.dirs,
            BTreeMap::from([(b.id.clone(), dirs(None, &["/srv/b"]))])
        );
        // Layout und Seitenleiste gehoeren keinem Host.
        assert_eq!(workspace.layout, 4);
        assert!(workspace.sidebar_collapsed);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&a.id), "{text}");
        assert_eq!(list_hosts_impl(&path).unwrap().len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    /// Spec §9.2: die Fehlermeldungen nennen die volle Ursachenkette und den
    /// Pfad -- eine kaputte Datei zeigt Zeile, Spalte und welche Datei es ist.
    #[test]
    fn settings_commands_name_the_file_and_the_toml_position_of_a_broken_file() {
        let path = unique_temp_settings_path("broken");
        let broken = "version = 1\n\n[ui]\ntheme = \n";
        std::fs::write(&path, broken).unwrap();
        let shown = path.display().to_string();
        let errors = [
            (
                "ui_settings read",
                ui_settings_impl(&path, None).unwrap_err(),
            ),
            (
                "ui_settings patch",
                ui_settings_impl(&path, Some(theme_patch("slate"))).unwrap_err(),
            ),
            ("list_hosts", list_hosts_impl(&path).unwrap_err()),
            (
                "add_host",
                add_host_impl(&path, new_host_dto("192.0.2.68")).unwrap_err(),
            ),
            (
                "update_host",
                update_host_impl(&path, "any", new_host_dto("192.0.2.68")).unwrap_err(),
            ),
            ("remove_host", remove_host_impl(&path, "any").unwrap_err()),
        ];
        for (command, error) in errors {
            assert!(error.contains(&shown), "{command}: {error}");
            assert!(error.contains("line 4, column"), "{command}: {error}");
        }
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            broken,
            "eine kaputte Datei wird nie ueberschrieben"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// Die Form auf dem Draht: `types.ts` spiegelt genau diese Schluessel
    /// (snake_case, `last` als `null`, wenn es fehlt).
    #[test]
    fn ui_settings_dto_serializes_with_the_snake_case_keys_the_frontend_mirrors() {
        let dto = UiSettingsDto {
            theme: "slate".into(),
            terminal_font_size: 16,
            copy_on_select: true,
            ctrl_cv_clipboard: false,
            right_click: "paste".into(),
            restore_workspace: false,
            sidebar_width: 300,
            workspace: WorkspaceDto {
                layout: 2,
                tiles_version: 2,
                sidebar_collapsed: true,
                expanded: vec!["h".into()],
                connected: vec!["h".into()],
                tiles: vec![tile(0, "h", "s")],
                dirs: BTreeMap::from([("h".to_string(), dirs(None, &["/a"]))]),
            },
            settings_path: "C:/x/settings.toml".into(),
        };
        assert_eq!(
            serde_json::to_value(&dto).unwrap(),
            serde_json::json!({
                "theme": "slate",
                "terminal_font_size": 16,
                "copy_on_select": true,
                "ctrl_cv_clipboard": false,
                "right_click": "paste",
                "restore_workspace": false,
                "sidebar_width": 300,
                "workspace": {
                    "layout": 2,
                    "tiles_version": 2,
                    "sidebar_collapsed": true,
                    "expanded": ["h"],
                    "connected": ["h"],
                    "tiles": [{ "slot": 0, "host_id": "h", "session": "s" }],
                    "dirs": { "h": { "last": null, "recent": ["/a"] } }
                },
                "settings_path": "C:/x/settings.toml"
            })
        );
    }

    /// Die Formen, die `main.ts` heute schickt, gelten unveraendert: Lesen mit
    /// `{ patch: null }`, Themenwechsel mit `{ patch: { theme } }`.
    #[test]
    fn ui_settings_patch_accepts_what_the_current_frontend_sends() {
        let read: Option<UiSettingsPatchDto> =
            serde_json::from_value(serde_json::json!(null)).unwrap();
        assert_eq!(read, None);

        let write: Option<UiSettingsPatchDto> =
            serde_json::from_value(serde_json::json!({ "theme": "slate" })).unwrap();
        assert_eq!(write, Some(theme_patch("slate")));

        // Alle Felder sind optional; unbekannte (ein anderer Frontend-Stand)
        // werden uebergangen.
        let empty: UiSettingsPatchDto = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty, UiSettingsPatchDto::default());
        let extra: UiSettingsPatchDto =
            serde_json::from_value(serde_json::json!({ "theme": "slate", "future": 1 })).unwrap();
        assert_eq!(extra, theme_patch("slate"));

        // Ein Wert, der nicht in den Zahlentyp passt, klemmt spaeter wie jeder
        // andere ungueltige Wert, statt den Aufruf zu verwerfen.
        let path = unique_temp_settings_path("ui_settings_wide_numbers");
        let wide: UiSettingsPatchDto = serde_json::from_value(serde_json::json!({
            "terminal_font_size": 300,
            "sidebar_width": -4,
        }))
        .unwrap();
        let dto = ui_settings_impl(&path, Some(wide)).unwrap();
        assert_eq!(dto.terminal_font_size, 13);
        assert_eq!(dto.sidebar_width, 240);
        let _ = std::fs::remove_file(&path);
    }

    /// Ein unvollstaendiger Arbeitsplatz im Patch wird abgelehnt, statt den Rest
    /// stillschweigend auf Standard zu setzen: `workspace` ersetzt als Ganzes.
    #[test]
    fn ui_settings_patch_rejects_an_incomplete_workspace() {
        let error = serde_json::from_value::<UiSettingsPatchDto>(serde_json::json!({
            "workspace": { "layout": 2 }
        }))
        .unwrap_err()
        .to_string();
        assert!(error.contains("missing field"), "{error}");

        // Auch `tiles_version` ist Pflicht: fehlte es still, gaelte ein Stand
        // der Kachelliste als altes Platzmodell (Spec 2026-10-19 §4.6).
        let error = serde_json::from_value::<UiSettingsPatchDto>(serde_json::json!({
            "workspace": {
                "layout": 2,
                "sidebar_collapsed": false,
                "expanded": [],
                "connected": [],
                "tiles": [],
                "dirs": {}
            }
        }))
        .unwrap_err()
        .to_string();
        assert!(error.contains("missing field `tiles_version`"), "{error}");
    }

    // --- Task 8 (Spec §4.8): add_host_impl/list_hosts_impl und auth_kind ---

    #[test]
    fn add_host_impl_stores_the_chosen_auth_kind_and_returns_it_immediately() {
        let path = unique_temp_settings_path("add_password_auth_kind");
        let mut dto = new_host_dto("192.0.2.55");
        dto.auth_kind = Some(AuthKind::Password);
        let entry = add_host_impl(&path, dto).unwrap();
        // Sofort im Rueckgabewert, OHNE einen list_hosts-Umweg --
        // `first-run.ts`/`session-dialog.ts` arbeiten direkt damit weiter.
        assert_eq!(entry.auth_kind, Some(AuthKind::Password));

        let hosts = list_hosts_impl(&path).unwrap();
        assert_eq!(hosts[0].auth_kind, Some(AuthKind::Password));
        let _ = std::fs::remove_file(&path);
    }

    /// Ein DTO OHNE `auth_kind` (aelterer Frontend-Build) darf trotzdem
    /// NIE einen Host mit `auth_kind: None` erzeugen -- `add_host_impl`
    /// leitet dann aus `key_path` ab, dieselbe Regel wie
    /// `HostEntry::effective_auth_kind()`.
    #[test]
    fn add_host_impl_derives_auth_kind_from_key_path_when_the_dto_omits_it() {
        let path = unique_temp_settings_path("add_missing_auth_kind");
        let mut dto = new_host_dto("192.0.2.56");
        dto.key_path = Some("C:/Users/x/.ssh/id_ed25519".into());
        assert_eq!(
            dto.auth_kind, None,
            "Vorbedingung: das DTO nennt keine Anmeldeart"
        );
        let entry = add_host_impl(&path, dto).unwrap();
        assert_eq!(entry.auth_kind, Some(AuthKind::Key));
        let _ = std::fs::remove_file(&path);
    }

    /// Belegt Spec §4.8 direkt an der Command-Grenze (nicht nur ueber
    /// `HostEntry::effective_auth_kind()`, siehe `settings.rs`s Testmodul):
    /// eine ECHTE, bereits existierende `settings.toml` ohne `auth_kind`
    /// bleibt lesbar, UND `list_hosts_impl` liefert dafuer nie `None` --
    /// `types.ts`s `HostEntry.auth_kind` ist nicht optional, das Frontend
    /// darf an dieser Grenze nie `null` sehen.
    #[test]
    fn list_hosts_impl_never_returns_a_missing_auth_kind_even_for_an_old_settings_file() {
        let path = unique_temp_settings_path("list_old_format");
        std::fs::write(
            &path,
            "version = 1\n\n\
             [[hosts]]\n\
             id = \"h1\"\n\
             label = \"vm\"\n\
             hostname = \"192.0.2.20\"\n\
             user = \"u\"\n\
             key_path = \"C:/Users/x/.ssh/id_ed25519\"\n\n\
             [[hosts]]\n\
             id = \"h2\"\n\
             label = \"pw\"\n\
             hostname = \"192.0.2.21\"\n\
             user = \"u\"\n",
        )
        .unwrap();

        let hosts = list_hosts_impl(&path).unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].auth_kind, Some(AuthKind::Key));
        assert_eq!(hosts[1].auth_kind, Some(AuthKind::Agent));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn update_host_impl_preserves_id_position_other_hosts_and_ui() {
        let path = unique_temp_settings_path("update");
        let a = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
        let b = add_host_impl(&path, new_host_dto("other.example.test")).unwrap();
        let mut current = settings::load_from(&path).unwrap();
        current.ui.theme = "slate".into();
        current.hosts[0].tmux_socket = "custom-socket".into();
        current.hosts[0].history_limit = 12345;
        settings::save_to(&path, &current).unwrap();
        let mut dto = new_host_dto("new.example.test");
        dto.label = "New label".into();
        dto.user = "other-user".into();
        dto.port = 2222;
        dto.key_path = Some("C:/keys/identity".into());
        dto.auth_kind = Some(AuthKind::Key);

        let updated = update_host_impl(&path, &a.id, dto).unwrap();
        assert_eq!(updated.id, a.id);
        assert_eq!(updated.label, "New label");
        assert_eq!(updated.hostname, "new.example.test");
        assert_eq!(updated.user, "other-user");
        assert_eq!(updated.port, 2222);
        assert_eq!(updated.key_path.as_deref(), Some("C:/keys/identity"));
        assert_eq!(updated.auth_kind, Some(AuthKind::Key));
        assert_eq!(updated.tmux_socket, "custom-socket");
        assert_eq!(updated.history_limit, 12345);
        let after = settings::load_from(&path).unwrap();
        assert_eq!(after.hosts, vec![updated, b]);
        assert_eq!(after.ui, current.ui);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn update_host_impl_rejects_unknown_id_without_writing() {
        let path = unique_temp_settings_path("update_unknown");
        add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
        let before = std::fs::read(&path).unwrap();
        let error =
            update_host_impl(&path, "missing", new_host_dto("new.example.test")).unwrap_err();
        assert!(error.contains("not found"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn update_host_impl_failed_temp_write_preserves_the_complete_settings_file() {
        let path = unique_temp_settings_path("update_write_failure");
        let original = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
        let before = std::fs::read(&path).unwrap();
        let hook = settings::write_hook::set(|stage| match stage {
            settings::WriteStage::BeforeTempWrite => {
                Err(std::io::Error::other("injected write failure"))
            }
            settings::WriteStage::BeforeRename => Ok(()),
        });
        let result = update_host_impl(&path, &original.id, new_host_dto("new.example.test"));
        drop(hook);
        let error = result.unwrap_err();
        assert!(error.contains("could not write"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
        assert_eq!(list_hosts_impl(&path).unwrap(), vec![original]);
        std::fs::remove_file(path).unwrap();
    }

    /// Wie eine zweite Instanz der App speichern wuerde: die Datei lesen,
    /// einen eigenen Host anhaengen, ersetzen. Liefert die geschriebenen Bytes.
    fn other_instance_adds_host(path: &Path, id: &str) -> Vec<u8> {
        let mut current = settings::load_from(path).unwrap();
        current.hosts.push(HostEntry {
            id: id.to_string(),
            label: id.to_string(),
            hostname: format!("{id}.example.test"),
            user: "u".into(),
            port: 22,
            tmux_socket: settings::default_socket(),
            history_limit: settings::default_history(),
            key_path: None,
            auth_kind: Some(AuthKind::Agent),
            show_default_socket: true,
        });
        settings::save_to(path, &current).unwrap();
        std::fs::read(path).unwrap()
    }

    fn saved_host_ids(path: &Path) -> Vec<String> {
        list_hosts_impl(path)
            .unwrap()
            .into_iter()
            .map(|host| host.id)
            .collect()
    }

    /// Laesst eine zweite Instanz genau einmal dazwischen speichern: beim
    /// naechsten Schreibvorgang, nachdem die temporaere Datei fertig ist und
    /// bevor sie die Datei ersetzt.
    fn another_instance_adds_host_once(path: &Path, id: &str) -> settings::write_hook::Guard {
        let path = path.to_path_buf();
        let mut pending = Some(id.to_string());
        settings::write_hook::set(move |stage| {
            if stage == settings::WriteStage::BeforeRename {
                if let Some(id) = pending.take() {
                    other_instance_adds_host(&path, &id);
                }
            }
            Ok(())
        })
    }

    /// Eine zweite Instanz speichert einen Host, waehrend `add_host_impl`
    /// zwischen Lesen und Ersetzen steht: Beide Hosts bleiben erhalten.
    #[test]
    fn add_host_impl_keeps_a_host_another_instance_saved_meanwhile() {
        let path = unique_temp_settings_path("add_concurrent");
        let first = add_host_impl(&path, new_host_dto("first.example.test")).unwrap();
        let hook = another_instance_adds_host_once(&path, "host_other");
        let added = add_host_impl(&path, new_host_dto("mine.example.test"));
        drop(hook);

        let added = added.unwrap();
        assert_eq!(
            saved_host_ids(&path),
            [first.id, "host_other".to_string(), added.id],
            "der Host der anderen Instanz darf nicht verloren gehen"
        );
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
        std::fs::remove_file(path).unwrap();
    }

    /// Dasselbe fuer `update_host_impl`, `ui_settings_impl` und
    /// `remove_host_impl`: Jeder Command wendet nur seine eigene Aenderung auf
    /// den neuesten Stand an.
    #[test]
    fn every_settings_command_keeps_a_host_another_instance_saved_meanwhile() {
        let path = unique_temp_settings_path("commands_concurrent");
        let first = add_host_impl(&path, new_host_dto("first.example.test")).unwrap();

        let hook = another_instance_adds_host_once(&path, "host_during_update");
        let updated = update_host_impl(&path, &first.id, new_host_dto("edited.example.test"));
        drop(hook);
        assert_eq!(updated.unwrap().hostname, "edited.example.test");

        let hook = another_instance_adds_host_once(&path, "host_during_ui");
        let dto = ui_settings_impl(&path, Some(theme_patch("slate")));
        drop(hook);
        assert_eq!(dto.unwrap().theme, "slate");

        let hook = another_instance_adds_host_once(&path, "host_during_remove");
        let removed = remove_host_impl(&path, &first.id);
        drop(hook);
        removed.unwrap();

        assert_eq!(
            saved_host_ids(&path),
            ["host_during_update", "host_during_ui", "host_during_remove"]
        );
        assert_eq!(ui_settings_impl(&path, None).unwrap().theme, "slate");
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
        std::fs::remove_file(path).unwrap();
    }

    /// Schreibt die andere Instanz bei jedem Versuch dazwischen, gibt der
    /// Command nach drei Versuchen mit einer Meldung auf. Die Datei traegt
    /// dann den Stand der anderen Instanz, und keine temporaere Datei bleibt.
    #[test]
    fn add_host_impl_gives_up_after_three_attempts_when_another_instance_keeps_writing() {
        let path = unique_temp_settings_path("add_contended");
        add_host_impl(&path, new_host_dto("first.example.test")).unwrap();
        let other_path = path.clone();
        let last_written = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let attempts = std::rc::Rc::new(std::cell::Cell::new(0));
        let (hook_written, hook_attempts) = (last_written.clone(), attempts.clone());
        let hook = settings::write_hook::set(move |stage| {
            if stage == settings::WriteStage::BeforeRename {
                hook_attempts.set(hook_attempts.get() + 1);
                let id = format!("host_other_{}", hook_attempts.get());
                *hook_written.borrow_mut() = other_instance_adds_host(&other_path, &id);
            }
            Ok(())
        });
        let result = add_host_impl(&path, new_host_dto("mine.example.test"));
        drop(hook);

        let error = result.unwrap_err();
        assert!(
            error.contains(&path.display().to_string())
                && error.ends_with(
                    "settings.toml was changed by another aidevbridge window at the same time; \
                     try again."
                ),
            "{error}"
        );
        assert_eq!(attempts.get(), 3);
        assert_eq!(std::fs::read(&path).unwrap(), *last_written.borrow());
        assert_eq!(saved_host_ids(&path).len(), 4);
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn add_host_impl_refuses_an_impossible_host_name_without_writing() {
        let path = unique_temp_settings_path("add_refused_name");
        add_host_impl(&path, new_host_dto("192.0.2.57")).unwrap();
        let before = std::fs::read(&path).unwrap();
        for hostname in ["*", "a b"] {
            assert_eq!(
                add_host_impl(&path, new_host_dto(hostname)).unwrap_err(),
                HOSTNAME_REFUSED
            );
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
        }
        std::fs::remove_file(path).unwrap();
    }

    /// Auch ein unveraendert uebernommener, schon gespeicherter Name wird
    /// abgewiesen: mit ihm koennte der Host nie verbinden. Ein gueltiger
    /// Name repariert denselben Eintrag.
    #[test]
    fn update_host_impl_refuses_an_impossible_host_name_even_when_it_is_unchanged() {
        let path = unique_temp_settings_path("update_refused_name");
        let valid = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
        let stored = add_host_impl(&path, new_host_dto("other.example.test")).unwrap();
        let mut current = settings::load_from(&path).unwrap();
        current.hosts[1].hostname = "a b".into();
        settings::save_to(&path, &current).unwrap();
        let before = std::fs::read(&path).unwrap();

        let changed = update_host_impl(&path, &valid.id, new_host_dto("user@host"));
        assert_eq!(changed.unwrap_err(), HOSTNAME_REFUSED);
        let mut unchanged = new_host_dto("a b");
        unchanged.label = "Renamed".into();
        let unchanged = update_host_impl(&path, &stored.id, unchanged);
        assert_eq!(unchanged.unwrap_err(), HOSTNAME_REFUSED);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());

        let repaired = update_host_impl(&path, &stored.id, new_host_dto("fixed.example.test"));
        assert_eq!(repaired.unwrap().hostname, "fixed.example.test");
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn host_update_and_remove_failed_replace_preserve_the_complete_settings_file() {
        use std::os::windows::fs::OpenOptionsExt;

        let path = unique_temp_settings_path("host_replace_failure");
        let original = add_host_impl(&path, new_host_dto("old.example.test")).unwrap();
        let before = std::fs::read(&path).unwrap();
        // FILE_SHARE_READ permits the load but denies replacement while held.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let update = update_host_impl(&path, &original.id, new_host_dto("new.example.test"));
        assert!(update.unwrap_err().contains("could not replace"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let remove = remove_host_impl(&path, &original.id);
        assert!(remove.unwrap_err().contains("could not replace"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        drop(lock);
        assert_eq!(settings::temp_files_beside(&path), Vec::<PathBuf>::new());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn remove_host_impl_removes_exactly_the_matching_id_and_keeps_the_rest() {
        let path = unique_temp_settings_path("remove");
        let a = add_host_impl(&path, new_host_dto("192.0.2.53")).unwrap();
        let b = add_host_impl(&path, new_host_dto("192.0.2.54")).unwrap();

        remove_host_impl(&path, &a.id).unwrap();

        let hosts = list_hosts_impl(&path).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].id, b.id);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn remove_host_impl_for_an_unknown_id_is_not_an_error() {
        let path = unique_temp_settings_path("remove_unknown");
        add_host_impl(&path, new_host_dto("192.0.2.55")).unwrap();
        assert!(remove_host_impl(&path, "does-not-exist").is_ok());
        assert_eq!(list_hosts_impl(&path).unwrap().len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    /// Deckt denselben Vertrag ab wie `settings::load_from_a_newer_version_
    /// file_propagates_the_error_instead_of_defaulting`, jetzt end-to-end
    /// ueber die Command-Huellen: eine `settings.toml` aus einer neueren
    /// Version darf kein Hostverwaltungs-Command
    /// stillschweigend ueberschreiben -- alle muessen den Fehler
    /// durchreichen.
    #[test]
    fn a_settings_file_from_a_newer_version_blocks_all_host_management_operations() {
        let path = unique_temp_settings_path("newer_version");
        std::fs::write(&path, "version = 99\n").unwrap();

        // Der Nutzer liest die Ursache aus `settings::parse_settings` (Spec
        // §10) hinter dem Pfad; der genaue Wortlaut ist dort festgehalten.
        let error = list_hosts_impl(&path).unwrap_err();
        assert!(
            error.contains(&path.display().to_string())
                && error.contains(": Your settings were saved by a newer aidevbridge. ")
                && error.ends_with("the file was not changed."),
            "{error}"
        );
        assert!(add_host_impl(&path, new_host_dto("192.0.2.56")).is_err());
        assert!(update_host_impl(&path, "anything", new_host_dto("192.0.2.56")).is_err());
        assert!(remove_host_impl(&path, "anything").is_err());

        // Und der wichtigste Teil: die Datei selbst wurde durch keinen der
        // fehlgeschlagenen Aufrufe angetastet.
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "version = 99\n");
        let _ = std::fs::remove_file(&path);
    }

    // --- create_session_with_retry (abgespielter Transport, wie tmux::client) ---

    struct ScriptedTransport {
        responses: StdMutex<VecDeque<ExecResult>>,
        calls: StdMutex<u32>,
        lines: StdMutex<Vec<String>>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<ExecResult>) -> Self {
            Self {
                responses: StdMutex::new(responses.into_iter().collect()),
                calls: StdMutex::new(0),
                lines: StdMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl Transport for ScriptedTransport {
        async fn exec_with_deadline(
            &self,
            line: &str,
            _timeout: std::time::Duration,
        ) -> anyhow::Result<ExecResult> {
            *self.calls.lock().unwrap() += 1;
            self.lines.lock().unwrap().push(line.to_owned());
            Ok(self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("kein Skript-Eintrag mehr"))
        }
        async fn dispose(&self) {}
    }

    fn created() -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: String::new(),
            stderr: String::new(),
            code: 0,
        }
    }

    fn created_session() -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: "C|50|1000|$0|@0|%0|10\n".into(),
            stderr: String::new(),
            code: 0,
        }
    }

    fn duplicate() -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: String::new(),
            stderr: "duplicate session: x".to_string(),
            code: 1,
        }
    }

    fn real_failure() -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: String::new(),
            stderr: "no server running on agentbridge".to_string(),
            code: 1,
        }
    }

    #[tokio::test]
    async fn successful_kill_with_failed_verification_does_not_report_success() {
        let verification_failure = ExecResult {
            utf8_valid: true,
            code: 1,
            stderr: "error connecting to /tmp/tmux-1000/sock (Permission denied)\n".into(),
            ..created()
        };
        let t = ScriptedTransport::new(vec![created(), verification_failure]);
        let error = kill_session_and_verify(
            &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
            &t,
            "dev",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("Permission denied"));
        assert_eq!(*t.calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn failed_kill_cannot_be_hidden_by_an_empty_followup_query() {
        let kill_failure = ExecResult {
            utf8_valid: true,
            code: 127,
            stderr: "sh: tmux: not found\n".into(),
            ..created()
        };
        let t = ScriptedTransport::new(vec![kill_failure, created()]);
        let error = kill_session_and_verify(
            &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
            &t,
            "dev",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("tmux: not found"));
        assert_eq!(*t.calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn kill_verification_rejects_a_still_present_session() {
        for kill_result in [
            created(),
            ExecResult {
                utf8_valid: true,
                code: 1,
                stderr: "can't find session: dev\n".into(),
                ..created()
            },
        ] {
            let listing = ExecResult {
                utf8_valid: true,
                stdout: "dev\ndev2\n".into(),
                ..created()
            };
            let t = ScriptedTransport::new(vec![kill_result, listing]);
            let error = kill_session_and_verify(
                &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
                &t,
                "dev",
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("still running"));
            assert_eq!(*t.calls.lock().unwrap(), 2);
        }
    }

    #[tokio::test]
    async fn repeated_kill_succeeds_when_the_exact_target_is_verified_absent() {
        let already_missing = ExecResult {
            utf8_valid: true,
            code: 1,
            stderr: "can't find session: dev\n".into(),
            ..created()
        };
        let listing = ExecResult {
            utf8_valid: true,
            stdout: "dev2\n".into(),
            ..created()
        };
        let t = ScriptedTransport::new(vec![already_missing, listing]);
        kill_session_and_verify(
            &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
            &t,
            "dev",
        )
        .await
        .unwrap();
        assert_eq!(*t.calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn killing_the_last_session_accepts_a_verified_absent_server() {
        let no_server = ExecResult {
            utf8_valid: true,
            code: 1,
            stderr: "no server running on /tmp/tmux-1000/sock\n".into(),
            ..created()
        };
        let t = ScriptedTransport::new(vec![created(), no_server]);
        kill_session_and_verify(
            &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
            &t,
            "dev",
        )
        .await
        .unwrap();
        assert_eq!(*t.calls.lock().unwrap(), 2);
    }

    /// The bound kill verifies through the numeric list. Ending the last
    /// session takes the server with it; only an absence proven for exactly
    /// the predicted socket path may confirm the kill.
    async fn end_last_bound_session(prediction: &str) -> (anyhow::Result<()>, u32) {
        let version = ExecResult {
            utf8_valid: true,
            stdout: "tmux 3.4\n".into(),
            ..created()
        };
        let no_server = ExecResult {
            utf8_valid: true,
            code: 1,
            stderr: "no server running on /tmp/tmux-1000/sock\n".into(),
            ..created()
        };
        let prediction = ExecResult {
            utf8_valid: true,
            stdout: prediction.into(),
            ..created()
        };
        let t = ScriptedTransport::new(vec![created(), version, no_server, prediction]);
        let result = kill_session_bound_and_verify(
            &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
            &t,
            crate::tmux::inventory::ServerIdentity {
                pid: 50,
                start_time: 1000,
            },
            crate::tmux::inventory::SessionId(0),
            tokio::time::Instant::now() + std::time::Duration::from_secs(10),
        )
        .await;
        let calls = *t.calls.lock().unwrap();
        (result, calls)
    }

    #[tokio::test]
    async fn ending_the_last_bound_session_accepts_a_server_proven_absent() {
        let (result, calls) = end_last_bound_session("S|/tmp/tmux-1000/sock\n").await;
        result.unwrap();
        assert_eq!(calls, 4, "kill, version, list and path prediction");
    }

    #[tokio::test]
    async fn ending_the_last_bound_session_rejects_an_unproven_absence() {
        let (result, calls) = end_last_bound_session("S|/tmp/tmux-1000/other\n").await;
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains("tmux binding query failed"),
            "{error:#}"
        );
        assert_eq!(calls, 4);
    }

    /// Nach einem gelungenen gebundenen Kill erlaubt nur ein gemessenes
    /// `tmux -V` die Pruefliste. Jede andere Antwort laesst den Ausgang offen.
    async fn end_bound_session_with_version(version: ExecResult) -> (anyhow::Result<()>, u32) {
        let t = ScriptedTransport::new(vec![created(), version]);
        let result = kill_session_bound_and_verify(
            &OwnTmuxClient::new(&OwnSocket::new("sock").unwrap()),
            &t,
            crate::tmux::inventory::ServerIdentity {
                pid: 50,
                start_time: 1000,
            },
            crate::tmux::inventory::SessionId(0),
            tokio::time::Instant::now() + std::time::Duration::from_secs(10),
        )
        .await;
        let calls = *t.calls.lock().unwrap();
        (result, calls)
    }

    fn assert_unverified_bound_kill(error: &anyhow::Error) {
        let message = error.to_string();
        assert!(message.contains("could not be verified"), "{error:#}");
        assert!(message.contains("may already have ended"), "{error:#}");
        assert!(message.contains("Refresh the session list"), "{error:#}");
    }

    #[tokio::test]
    async fn ending_a_bound_session_without_tmux_for_the_version_is_not_reported_done() {
        let (result, calls) = end_bound_session_with_version(ExecResult {
            utf8_valid: true,
            code: 127,
            stderr: "sh: tmux: not found".into(),
            ..created()
        })
        .await;
        assert_unverified_bound_kill(&result.unwrap_err());
        assert_eq!(calls, 2, "kill and version, no list");
    }

    #[tokio::test]
    async fn ending_a_bound_session_on_an_unmeasured_tmux_is_not_reported_done() {
        let (result, calls) = end_bound_session_with_version(ExecResult {
            utf8_valid: true,
            stdout: "tmux 3.5a\n".into(),
            ..created()
        })
        .await;
        assert_unverified_bound_kill(&result.unwrap_err());
        assert_eq!(calls, 2, "kill and version, no list");
    }

    #[tokio::test]
    async fn retries_past_duplicate_names_and_succeeds() {
        let t = ScriptedTransport::new(vec![duplicate(), duplicate(), created_session()]);
        let client = OwnTmuxClient::new(&OwnSocket::new("irrelevant").unwrap());
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let name = create_session_with_retry(&client, &t, &mut rng, "/tmp", MAX_NAME_ATTEMPTS)
            .await
            .unwrap();
        assert!(name.starts_with("ab_"));
        assert_eq!(*t.calls.lock().unwrap(), 3, "zwei Kollisionen + ein Erfolg");
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts_consecutive_collisions() {
        let t = ScriptedTransport::new((0..MAX_NAME_ATTEMPTS).map(|_| duplicate()).collect());
        let client = OwnTmuxClient::new(&OwnSocket::new("irrelevant").unwrap());
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let err = create_session_with_retry(&client, &t, &mut rng, "/tmp", MAX_NAME_ATTEMPTS)
            .await
            .expect_err("nach MAX_NAME_ATTEMPTS Kollisionen in Folge muss aufgegeben werden");
        assert!(err.to_string().contains("attempts"));
        assert_eq!(
            *t.calls.lock().unwrap(),
            MAX_NAME_ATTEMPTS,
            "genau MAX_NAME_ATTEMPTS Versuche, kein Off-by-One"
        );
    }

    #[tokio::test]
    async fn does_not_retry_on_a_real_error() {
        // Ein echter Fehlschlag (kein "duplicate session" im Stderr) ist
        // KEINE Namenskollision -- die Schleife darf nicht weiterwuerfeln,
        // sie muss sofort mit dem echten Fehler abbrechen.
        let t = ScriptedTransport::new(vec![real_failure()]);
        let client = OwnTmuxClient::new(&OwnSocket::new("irrelevant").unwrap());
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let err = create_session_with_retry(&client, &t, &mut rng, "/tmp", MAX_NAME_ATTEMPTS)
            .await
            .expect_err("ein echter Fehler darf nicht als Kollision durchgehen");
        assert!(err.to_string().contains("no server running"));
        assert_eq!(
            *t.calls.lock().unwrap(),
            1,
            "ein echter Fehler darf keinen weiteren Versuch ausloesen"
        );
    }

    // --- is_acceptable_remote_path (Task 7, H6/H9): Hostdaten, die in eine
    // Fernzeile gehen (cwd, path, Sessionname), werden AN DER COMMAND-GRENZE
    // geprueft, nicht erst per `assert!` in `remote::build`/`build_in_dir` --
    // ein Panic dort haengt den Tauri-`invoke` (der WebView bekaeme nie eine
    // Antwort), statt einen `Err(...)` aufzuloesen. ---

    /// Die Regel selbst (und ihr vollstaendiger Test) steht in
    /// `settings::is_absolute_remote_path`; dies sind die Grenzfaelle an der
    /// Command-Grenze, `is_acceptable_remote_path` ruft sie auf.
    #[test]
    fn remote_paths_must_be_absolute_and_free_of_control_chars() {
        assert!(is_acceptable_remote_path("/"));
        assert!(is_acceptable_remote_path("/home/u/work"));
        assert!(!is_acceptable_remote_path(""));
        assert!(!is_acceptable_remote_path("relative"));
        assert!(!is_acceptable_remote_path("~/work"));
        assert!(!is_acceptable_remote_path("C:\\work"));
        assert!(!is_acceptable_remote_path("/tmp/a\0b"));
        assert!(!is_acceptable_remote_path("/tmp/a\nb"));
        assert!(!is_acceptable_remote_path("/tmp/a\x1bb"));
    }

    /// Der eigentliche Beleg: ein relatives `cwd` liefert einen `Err(..)` MIT
    /// erklaerendem Text, statt die Anwendung per `assert!` in
    /// `remote::build_in_dir`/`build` abstuerzen zu lassen (H6/H9). Laeuft
    /// OHNE VM -- die Pruefung steht vor dem ersten Zugriff auf `state.hosts`,
    /// deshalb genuegt ein nicht verbundener `host_id`.
    #[tokio::test]
    async fn create_session_rejects_a_relative_cwd_with_an_error_not_a_panic() {
        let state = Arc::new(AppState::default());
        let r = create_session_impl(&state, "no-such-host".into(), "relative".into(), None).await;
        assert!(
            matches!(r, Err(ref e) if e.message.contains("absolute")),
            "erwartet: Err mit 'absolute' in der Meldung, bekommen: {r:?}"
        );
    }

    /// Pinnt die bewusste Ausnahme in `list_directories_impl`: der LEERE Pfad
    /// ist der einzige Weg des Frontends zum Heimatverzeichnis (Spec §3.3,
    /// `directory-tree.ts` Zeile 687) und muss deshalb die Pruefung
    /// passieren -- er kommt hier als "host not connected" heraus (also erst
    /// NACH der Pruefung gescheitert), waehrend ein relativer Pfad weiterhin
    /// mit "absolute" im Text abgelehnt wird, VOR jedem Host-Lookup. Ohne
    /// diesen Test waere die Ausnahme mit einer gestrichenen Zeile lautlos
    /// wieder verschwunden.
    #[tokio::test]
    async fn list_directories_lets_the_empty_home_path_past_the_boundary_check() {
        let state = Arc::new(AppState::default());

        let r = list_directories_impl(&state, "no-such-host".into(), String::new(), false).await;
        assert_eq!(
            r.unwrap_err(),
            "host not connected",
            "der leere Pfad (Heimatverzeichnis) darf nicht an der Pfadpruefung scheitern"
        );

        let r =
            list_directories_impl(&state, "no-such-host".into(), "relative".into(), false).await;
        assert!(
            r.unwrap_err().contains("absolute"),
            "ein relativer Pfad muss weiterhin VOR dem Host-Lookup abgelehnt werden"
        );
    }

    // --- Fix-Runde 1 (Task 7): `open_terminal_impl`
    // und `kill_session_impl` pruefen den Sessionnamen NICHT gegen die
    // Allowlist aus `session_name_is_acceptable` -- die gilt nur fuer Namen,
    // die diese Anwendung selbst erzeugt (Spec, Befund B2). Von Hand in tmux
    // angelegte Sessions duerfen Punkte, Grossbuchstaben und Nicht-ASCII
    // tragen und muessen sich trotzdem oeffnen und beenden lassen; gegen H6
    // reicht der Ausschluss von leerem Namen und Steuerzeichen. Die
    // folgenden zwei Tests belegen fuer beide Funktionen, was fuer
    // `create_session_impl`/`list_directories_impl` oben bereits gilt: die
    // Namenspruefung steht VOR dem Host-Lookup und ist ohne VM erreichbar. ---

    /// Test-Doppelgaenger fuer `OutputSink`: in beiden Faellen unten
    /// scheitert `open_terminal_impl` entweder an der Namenspruefung oder am
    /// Host-Lookup, lange bevor je etwas gesendet wuerde -- die Methode
    /// existiert nur, weil der Trait sie verlangt.
    struct NullSink;
    impl OutputSink for NullSink {
        fn send(&self, _host_id: &str, _session: &str, _bytes: Vec<u8>) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn open_terminal_checks_the_session_name_before_the_host_lookup() {
        let state = Arc::new(AppState::default());

        let r = open_terminal_impl(
            &state,
            NullSink,
            "no-such-host".into(),
            "a\0b".into(),
            80,
            24,
        )
        .await;
        assert_eq!(
            r.unwrap_err(),
            "invalid session name",
            "ein Steuerzeichen im Namen muss VOR dem Host-Lookup abgelehnt werden"
        );

        // "my.project": ein Punkt ist hier erlaubt -- die Allowlist aus
        // `session_name_is_acceptable` gilt nicht fuer von Hand angelegte
        // Sessions (Task 7, Fix-Runde 1). Ohne
        // Verbindung scheitert der Aufruf trotzdem, aber ERST am
        // Host-Lookup, nicht an der Namenspruefung.
        let r = open_terminal_impl(
            &state,
            NullSink,
            "no-such-host".into(),
            "my.project".into(),
            80,
            24,
        )
        .await;
        assert_eq!(
            r.unwrap_err(),
            "host not connected",
            "ein gueltiger Name (auch mit Punkt) darf nicht an der Namenspruefung scheitern"
        );
    }

    #[tokio::test]
    async fn kill_session_checks_the_session_name_before_the_host_lookup() {
        let state = Arc::new(AppState::default());

        let r = kill_session_impl(
            &state,
            "no-such-host".into(),
            SocketKind::App,
            "a\x1bb".into(),
            None,
            None,
            None,
        )
        .await;
        assert_eq!(
            r.unwrap_err(),
            "invalid session name",
            "ein Steuerzeichen im Namen muss VOR dem Host-Lookup abgelehnt werden"
        );

        // "Projekt-Ä": Nicht-ASCII ist hier erlaubt, aus demselben Grund wie
        // oben bei `open_terminal_impl`.
        let r = kill_session_impl(
            &state,
            "no-such-host".into(),
            SocketKind::App,
            "Projekt-Ä".into(),
            None,
            None,
            None,
        )
        .await;
        assert_eq!(
            r.unwrap_err(),
            "host not connected",
            "ein gueltiger Name (auch nicht-ASCII) darf nicht an der Namenspruefung scheitern"
        );
    }

    // --- open_link (UX-Ueberarbeitung, Spec §6.5) ---

    #[test]
    fn validate_link_accepts_http_and_https_links() {
        for url in [
            "https://example.com/a?b=c",
            "http://x",
            "https://de.wikipedia.org/wiki/Ärger",
            "https://example.com/a?b=c&d=e#f",
            // RFC 3986 §3.1: das Schema ist unabhaengig von Gross- und
            // Kleinschreibung.
            "HTTPS://EXAMPLE.COM",
            "Http://x",
            // Internationalisierte Domain, unkodiert.
            "https://bücher.de/x",
            // Nutzerangabe, Port und IPv6-Literal sind Teil der Autoritaet,
            // der Host dahinter ist nicht leer.
            "https://user@example.com",
            "https://example.com:8080/x",
            "http://x:80",
            "https://[::1]:8080/",
        ] {
            assert_eq!(validate_link(url), Ok(()), "{url:?}");
        }
    }

    #[test]
    fn validate_link_rejects_other_schemes() {
        for url in [
            "file:///c:/x",
            "javascript:alert(1)",
            "ftp://x",
            "mailto:a@example.com",
            "https:example.com",
            "http:",
            "",
            "example.com",
        ] {
            assert_eq!(validate_link(url), Err(LINK_SCHEME_NOT_ALLOWED), "{url:?}");
        }
    }

    #[test]
    fn validate_link_rejects_a_link_without_host() {
        for url in [
            "https://",
            "http://",
            "https:///etc/passwd",
            "https://?q",
            "https://#f",
            // Nach Abzug von `userinfo@` und `:port` bleibt kein Host.
            "https://:80",
            "https://@",
            "https://user@",
            "https://@:80",
            "https://user:pw@:443/x",
        ] {
            assert_eq!(validate_link(url), Err(LINK_WITHOUT_HOST), "{url:?}");
        }
    }

    /// Unsichtbare Format- und Bidi-Zeichen (Trojan Source): Der Link saehe
    /// im Terminal anders aus, als er geoeffnet wird.
    #[test]
    fn validate_link_rejects_invisible_format_characters() {
        let invisible = ('\u{200B}'..='\u{200F}')
            .chain('\u{202A}'..='\u{202E}')
            .chain('\u{2066}'..='\u{2069}')
            .chain(['\u{FEFF}']);
        for c in invisible {
            let url = format!("https://exa{c}mple.com/");
            assert_eq!(
                validate_link(&url),
                Err(LINK_HAS_INVISIBLE_FORMAT),
                "U+{:04X}",
                c as u32
            );
        }
        assert_eq!(
            validate_link("https://example.com/\u{202E}gpj.exe"),
            Err(LINK_HAS_INVISIBLE_FORMAT)
        );
    }

    #[test]
    fn validate_link_rejects_whitespace_and_control_characters() {
        for url in [
            "https://exa mple.com",
            "https://x\n",
            " https://x",
            "https://x\ty",
            "https://x\u{a0}y",
            "https://x\u{7f}",
            "https://x\u{85}",
            "https://x\u{1b}[31m",
        ] {
            assert_eq!(
                validate_link(url),
                Err(LINK_HAS_SPACE_OR_CONTROL),
                "{url:?}"
            );
        }
    }

    #[test]
    fn validate_link_allows_at_most_2048_characters() {
        let prefix = "https://x/";
        let longest = format!("{prefix}{}", "a".repeat(MAX_LINK_CHARS - prefix.len()));
        assert_eq!(longest.chars().count(), 2048);
        assert_eq!(validate_link(&longest), Ok(()));
        assert_eq!(validate_link(&format!("{longest}a")), Err(LINK_TOO_LONG));
        // Zeichen, nicht Bytes: 2048 Zeichen mit Umlauten sind laenger als
        // 2048 Bytes und bleiben erlaubt.
        let umlauts = format!("{prefix}{}", "ä".repeat(MAX_LINK_CHARS - prefix.len()));
        assert!(umlauts.len() > MAX_LINK_CHARS);
        assert_eq!(validate_link(&umlauts), Ok(()));
    }

    /// Der Command selbst lehnt ab, bevor etwas geoeffnet wird. Nur der
    /// Fehlerpfad ist so pruefbar -- ein gueltiger Link oeffnete den
    /// Browser.
    #[tokio::test]
    async fn open_link_rejects_a_forbidden_link_before_opening_anything() {
        assert_eq!(
            open_link("javascript:alert(1)".into()).await,
            Err(LINK_SCHEME_NOT_ALLOWED.to_string())
        );
        assert_eq!(
            open_link("https://exa mple.com".into()).await,
            Err(LINK_HAS_SPACE_OR_CONTROL.to_string())
        );
    }
}

#[cfg(test)]
mod tofu_tests;

#[cfg(test)]
mod connect_tests;

#[cfg(test)]
mod terminal_ownership_tests;

#[cfg(test)]
mod history_tests;
