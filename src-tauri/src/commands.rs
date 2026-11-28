//! Tauri-Commands und die Byte-Bruecke zum WebView.
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
    TerminalTransportLostEvent, COMMAND_TIMEOUT, SESSION_WALK_TIMEOUT,
};
use crate::settings::{self, AuthKind, HostEntry};
use crate::ssh::known_hosts::{self, HostKeyDecision};
use crate::ssh::{AuthError, AuthMethod};
use crate::tmux::attach_confirmation::{
    absolute_probe, named_probe, parse_clients, process_command, registered_with_process,
    registration_ready, verify_process, SocketBinding, Unverified,
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
/// (TOFU, Spec §8.1). 60 Sekunden: waehrend `decide`
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
/// `pub`, nicht nur crate-intern: der Integrationstest
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
/// Untere Grenze: dieser Wert ist eine LEBENDE Uhr unter
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
/// `manage`/`State`-Lifetime direkt), damit die Pumpaufgabe (`TerminalPump`)
/// einen `'static`-Verweis bekommt, ohne auf einen `AppHandle` angewiesen zu
/// sein -- das haelt die `_impl`-Funktionen Tauri-frei und damit ausserhalb
/// einer laufenden Anwendung testbar.
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

/// Sperrt eines der Register (`hosts`, `terminals`, `pending_host_key`), auch
/// nach einer Panik unter dieser Sperre. Mit `lock().unwrap()` scheiterte
/// danach jeder Befehl, der das Register braucht, bis zum Neustart der App,
/// auch Trennen und Schliessen. Jede Aenderung unter diesen Sperren ist ein
/// einzelnes Einfuegen, Entfernen oder Setzen ohne `await` (siehe die Felder
/// oben); eine Panik dazwischen hinterlaesst schlimmstenfalls einen Eintrag,
/// den der naechste Abbau oder Verbindungsversuch ersetzt. Wie
/// `settings.rs` und `local_network.rs` mit ihren Sperren.
fn registry<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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

    /// Die fertige Verbindung zu `host_id`; `None`, wenn der Host unbekannt
    /// oder erst reserviert ist. Die `hosts`-Sperre gilt nur fuer den
    /// Nachschlag und ist bei der Rueckgabe schon frei, der Aufrufer kann mit
    /// dem `Arc` also awaiten. Wer unter derselben Sperre noch mehr pruefen
    /// muss (etwa zusammen mit `terminals`), liest `hosts` direkt.
    fn ready_host(&self, host_id: &str) -> Option<Arc<HostConnection>> {
        let hosts = registry(&self.hosts);
        hosts.get(host_id).and_then(HostSlot::ready)
    }

    /// Nur fuer Tests/Diagnose: ob fuer `host_id` eine Verbindung gefuehrt
    /// wird.
    pub async fn has_host(&self, host_id: &str) -> bool {
        self.ready_host(host_id).is_some()
    }

    /// Nur fuer Tests/Diagnose: ob fuer `(host_id, session)` ein offener
    /// PTY-Kanal gefuehrt wird.
    pub async fn has_terminal(&self, host_id: &str, session: &str) -> bool {
        registry(&self.terminals).contains_key(&session_key(host_id, SocketKind::App, session))
    }

    /// Registers the response channel awaited asynchronously by the policy.
    fn register_host_key_request(
        &self,
        control: ConnectControl,
        deadline: tokio::time::Instant,
    ) -> (u64, oneshot::Receiver<bool>) {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        registry(&self.pending_host_key).insert(
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
        registry(&self.pending_host_key).remove(&id);
    }

    /// Von `respond_host_key_impl`: liefert `true`, wenn eine noch
    /// wartende Anfrage gefunden und beantwortet wurde -- `false`, wenn
    /// `request_id` unbekannt ist (bereits beantwortet oder per
    /// Zeitablauf schon abgelehnt worden).
    fn resolve_host_key_request(&self, id: u64, accept: bool) -> bool {
        // Erst binden (der `MutexGuard` faellt am `;` dieses Statements),
        // DANN erst `match` -- dasselbe Muster wie `disconnect_host_impl`
        // weiter unten: ein
        // `match registry(&self.pending_host_key).remove(&id) { ... }`
        // liesse den Guard sonst als Scrutinee-Temporary bis zum Ende des
        // `match`-Ausdrucks leben (`clippy::significant_drop_in_scrutinee`,
        // in `lib.rs` dauerhaft aktiviert, schlaegt hier zu Recht an).
        let control = registry(&self.pending_host_key)
            .get(&id)
            .map(|p| p.control.clone());
        let Some(control) = control else { return false };
        control
            .with_active(|| {
                let pending = registry(&self.pending_host_key).remove(&id);
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
        let mut hosts = registry(&state.hosts);
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
            let mut hosts = registry(&state.hosts);
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
            let mut hosts = registry(&state.hosts);
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
        let mut hosts = registry(&self.state.hosts);
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
        let mut hosts = registry(&self.state.hosts);
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
/// `cancel` weckt eine Pumpaufgabe, die gerade in `AckGate::wait_for_room`
/// haengt, wenn IHR Eintrag abgeraeumt wird (`close_terminal`,
/// `disconnect_host`, oder ein verdraengendes `open_terminal`). Ohne dieses
/// Signal wartet `wait_for_room` auf einen `ack()`, der fuer eine bereits
/// entfernte Session nie wieder kommt -- die Pumpaufgabe (und ihre
/// `Arc`-Referenzen auf `AppState`/`AckGate`/`OutputSink`) leckt fuer die
/// restliche Prozesslaufzeit. Bewusst NICHT Teil von `AckGate` selbst: die
/// Rueckstaubremse (Kredit-Buchhaltung, Kette bis zum SSH-Fenster) bleibt
/// unveraendert, das Abbruchsignal ist ein rein aeusserlicher
/// Orchestrierungs-Mechanismus (siehe `wait_for_room_cancel_or_stall`).
struct OpenTerminal {
    open_id: String,
    // `Arc`, nicht `PtyHandle` direkt: `send_input_tagged_impl` und
    // `resize_terminal_tagged_impl` muessen einen Verweis aus dieser Map
    // ziehen koennen, der die `state.terminals`-Sperre ueberlebt, OHNE den
    // Eintrag selbst aus der Map zu entfernen (der Eintrag bleibt ja offen).
    // Ein `Arc::clone()` ist billig und laesst sich waehrend die Sperre noch
    // gehalten wird ziehen; die Sperre faellt danach sofort, das eigentliche
    // `write()`/`resize()` laeuft komplett ohne sie (siehe dortige
    // Kommentare). `PtyHandle::close` nimmt bewusst `&self` statt `self`
    // entgegen (siehe dort) -- sonst koennte `close_entry` beim Abraeumen
    // nicht garantieren, den `PtyHandle` per Wert aus dem `Arc`
    // zurueckzubekommen, wenn just in diesem Moment noch ein
    // `send_input_tagged_impl`/`resize_terminal_tagged_impl` einen zweiten
    // Klon haelt.
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
            let mut terms = registry(&state.terminals);
            let hosts = registry(&state.hosts);
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
        let mut terms = registry(&self.state.terminals);
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
/// Von der Pumpaufgabe (`TerminalPump::forward`) TATSAECHLICH aufgerufen
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
/// konfigurierten Host lebt in `settings::HostEntry::id`, nicht hier.
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
/// paarweise als verschieden getestete Meldungen; dies ist ihr einziger
/// Produktivaufrufer (Design §4.5). `e.to_string()` liefert nur `anyhow`s
/// knappen Display-Text ("passphrase required"). Am teuersten waere der
/// Verlust bei `AgentUnavailable`, dessen Meldung den PowerShell-Befehl
/// nennt, den Windows 11 braucht, weil der ssh-agent-Dienst dort
/// standardmaessig deaktiviert ist.
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
/// Methodenliste. `e.to_string()` haette es durchgereicht. Es gibt keine
/// Logdatei, aus der es sich zurueckholen liesse. Die Meldung ist damit besser
/// fuer den Nutzer und schlechter fuer einen Fehlerbericht; erst wenn es
/// dafuer eine Senke gibt (Logdatei oder ein Detailfeld im DTO), lohnt es
/// sich, das Detail zusaetzlich zu transportieren.
fn auth_error_message(e: &anyhow::Error) -> String {
    match e.downcast_ref::<AuthError>() {
        Some(auth) => auth.user_message().to_string(),
        None => e.to_string(),
    }
}

/// Typisierter Fehler von `connect_host` (Spec §4.8):
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
/// `message` ist die lesbare Fehlermeldung -- `code` kommt als ZUSAETZLICHE
/// Information dazu, keine Ersetzung. Die Hostschluesseltexte hat die
/// UX-Ueberarbeitung neu gefasst (Spec §10); die Codes blieben, und nur sie
/// wertet das Frontend aus.
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

/// Die Meldung zu einem geaenderten Hostschluessel (`Mismatch`, UX-Spec §10).
/// Auf Android gibt es kein `ssh-keygen` und keinen Zugriff auf die Datei; dort
/// vergisst die App den Schluessel, wenn der Nutzer den Host entfernt
/// (`remove_host_impl`), und die Meldung sagt genau das.
fn changed_host_key_message(host: &str, android: bool) -> String {
    if android {
        format!(
            "The host key of {host} has changed. Someone may be intercepting the connection \
             — or the server was reinstalled. If you're sure, remove the host in aidevbridge, \
             add it again and compare the new key's fingerprint before you trust it."
        )
    } else {
        format!(
            "The host key of {host} has changed. Someone may be intercepting the connection \
             — or the server was reinstalled. If you're sure, remove its old entry from \
             ~/.ssh/known_hosts, for example with ssh-keygen -R \"{host}\", and connect \
             again."
        )
    }
}

/// Klassifiziert einen gescheiterten `connect_host`-Versuch in `ConnectError`
/// (Spec §4.8) -- `message` ist die lesbare `String`-Fehlermeldung
/// (siehe `connect_host_with_known_hosts`s duenne Huelle um
/// `connect_host_core` unten, die aus Kompatibilitaetsgruenden weiterhin nur
/// `message` herausreicht), `code` kommt zusaetzlich dazu.
///
/// Nach einem etwaigen Cancel-/Zeitlimitgrund wird `host_key_decision` vor den
/// Auth-Fehlern geprueft: ein von der TOFU-Politik abgelehnter Host-Schluessel
/// ist KEIN `AuthError` (die Verbindung scheitert schon vor jedem
/// Auth-Versuch, siehe `TofuPolicy`/`RusshTransport::connect`) und braucht
/// deshalb eine eigene, hier fest verdrahtete Meldung. Die zwei Texte stehen
/// in Spec §10 (UX-Ueberarbeitung), der Code bleibt `host_key_rejected`.
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
            message: changed_host_key_message(host, cfg!(target_os = "android")),
        },
        // `Known` (der Schluessel stand schon passend in `known_hosts`) und
        // `None` (die Verbindung scheiterte VOR jeder TOFU-Entscheidung, z. B.
        // TCP-Verbindungsaufbau) sind beide KEINE Host-Key-Ablehnung -- der
        // Fehler liegt dann in der Auth-Klassifikation unten.
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
/// `passphrase`/`password` sind der einzige Weg, auf dem
/// `AuthMethod::Password` und `AuthMethod::Key{passphrase: Some(..)}` aus dem
/// WebView entstehen. Direkt als `Zeroizing<String>` deserialisiert
/// (Spec §8.5, `zeroize`s `serde`-Feature, siehe Cargo.toml-Kommentar) -- ab
/// der Deserialisierung liegt das Geheimnis damit in keinem gewoehnlichen
/// `String` mehr.
///
/// Was das ausdruecklich NICHT heisst, damit die Frage nicht wiederkehrt:
/// Tauri deserialisiert Befehlsargumente aus einem BEREITS materialisierten
/// `serde_json::Value` (`tauri-2.12.5/src/ipc/command.rs`), der Klartext lebt
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

/// Waehlt die `AuthMethod` aus den rohen DTO-Feldern.
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
    /// den Eintrag aus `state.terminals` entfernt hatte. Aufgerufen genau
    /// dort, wo die Pumpaufgabe (`TerminalPump`) beim eigenen Aufraeumen
    /// feststellt, dass sie selbst noch Eigentuemerin des Map-Eintrags ist
    /// (`owns_current_entry`) -- alle drei gewollten Schliesspfade entfernen
    /// den Eintrag VOR diesem Zeitpunkt (siehe deren Code),
    /// `owns_current_entry` waere dann bereits `false` und dieser Aufruf
    /// bliebe aus. Ein gewolltes Schliessen erzeugt dieses Signal deshalb
    /// strukturell nie, nicht nur durch eine zusaetzliche Fallunterscheidung,
    /// die vergessen werden koennte.
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

/// Nutzlast von `terminal://connection-lost` -- siehe
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
/// Nimmt an, dass hoechstens EINE Aufgabe gleichzeitig `wait_for_room` aufruft
/// -- zutreffend, weil es genau eine Pumpaufgabe je offenem Terminal gibt, ein
/// `AckGate` je Terminal. `notify_one()` speichert ein Weck-Signal, falls
/// `ack()` laeuft, bevor die Pumpaufgabe ueberhaupt wartet (siehe Tokio-Doku
/// zu `Notify::notify_one`) -- das schliesst das "verlorene
/// Weck-Signal"-Rennen fuer den Einzel-Warter-Fall. Ein zweiter gleichzeitiger
/// Warter auf demselben `AckGate` waere NICHT fair bedient (`notify_one` weckt
/// irgendeinen, nicht zwingend den mit dem kleinsten Bedarf) -- ausserhalb des
/// Anwendungsfalls dieses Moduls, deshalb bewusst nicht geloest.
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
    /// Pumpaufgabe hier haengt, ruft sie `rx.recv()` nicht erneut auf; die
    /// Ausgabewarteschlange des Kanals (`pty_output`) wird nicht geleert,
    /// ihre Bytes gehen nicht an das SSH-Fenster zurueck, und die Gegenseite
    /// haelt an der Fenstergrenze an (`WINDOW`). Der entfernte
    /// `tmux attach`-Prozess blockiert; der Rueckstau reicht bis zu ihm
    /// (Spec §9.1).
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
/// bislang unbekannter Host-Key vertraut werden soll (TOFU, Spec §8.1).
/// `fingerprint` ist bereits der SHA256-Fingerabdruck im
/// `ssh-keygen -lf`-Format -- NIEMALS der rohe Base64-Schluessel, den
/// vergleicht niemand von Hand.
///
/// `expires_at_unix_ms` spiegelt die monotone Backend-Frist dieser Anfrage
/// fuer den Countdown im WebView. Ob eine Zustimmung noch gilt, prueft das
/// Backend immer an der monotonen Frist selbst; eine verstellte Wanduhr
/// verlaengert die Zustimmung nicht.
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
    /// `known_hosts` geschrieben werden konnte (ein `eprintln!` allein waere
    /// in einer gepackten Anwendung ohne Konsole unsichtbar). Die Verbindung
    /// DIESER einen Zustimmung bleibt bestehen (siehe `decide()`s Kommentar
    /// zum Kompromiss) -- dieses Ereignis dient ausschliesslich dazu, den
    /// Nutzer darueber zu informieren, dass die naechste Verbindung zu diesem
    /// Host erneut fragen wird, statt ihn vor einem kommentarlos wiederholten
    /// Prompt raetseln zu lassen.
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

/// Nutzlast von `hostkey://persist-failed` -- siehe
/// `HostKeyRequestSink::notify_persist_failed`s Doc-Kommentar.
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
    fn known_key_types(&self, host: &str, port: u16) -> Vec<String> {
        known_hosts::key_types_for(&self.known_hosts_text, host, port)
    }

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

/// `local_network` ist das Ergebnis der Abfrage, die Android 17 fuer Hosts
/// im lokalen Netz verlangt (`local_network::prepare`); ausserhalb von
/// Android immer `Gate::Open`.
pub async fn connect_host_impl(
    state: &Arc<AppState>,
    sink: Arc<dyn HostKeyRequestSink>,
    host_id: String,
    spec: HostSpecDto,
    local_network: crate::local_network::Gate,
) -> Result<String, ConnectError> {
    let mut attempt = ConnectAttempt::take(state, host_id)?;
    let known_hosts_path = crate::paths::ssh_dir()
        .ok_or_else(|| ConnectError::other("could not determine home directory"))?
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
        local_network,
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
        crate::local_network::Gate::Open,
    )
    .await
    .map_err(|error| error.message)
}

// Acht Parameter: die Tests geben `known_hosts`, die Frist der Rueckfrage und
// das Ergebnis der Abfrage fuers lokale Netz einzeln vor.
#[allow(clippy::too_many_arguments)]
async fn connect_host_core(
    state: &Arc<AppState>,
    attempt: &mut ConnectAttempt,
    spec: HostSpecDto,
    known_hosts_text: String,
    known_hosts_path: PathBuf,
    sink: Arc<dyn HostKeyRequestSink>,
    prompt_timeout: Duration,
    local_network: crate::local_network::Gate,
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
    let target = (spec.hostname.clone(), spec.port);
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
    let result = HostConnection::connect(
        attempt.host_id.clone(),
        host_spec,
        method,
        policy.clone(),
        attempt.control.clone(),
        Arc::new(ConnectionEventSink(sink)),
    )
    .await;
    // Android 17 sperrt ohne Berechtigung den Weg ins lokale Netz, nicht
    // aber ueber ein VPN. Stand die TCP-Verbindung, kam ein Hostschluessel
    // an oder wies der Host den Aufbau ab, war der Weg offen: Ein Fehler
    // danach (die Rueckfrage, die Anmeldung) hat einen anderen Grund, und
    // fuer diesen Host fragt die App bis zu ihrem Ende nicht mehr.
    let reached = match &result {
        Ok(_) => true,
        Err(error) => {
            policy.last_decision().is_some()
                || attempt.control.tcp_connected()
                || crate::local_network::host_answered(error)
        }
    };
    if reached && local_network == crate::local_network::Gate::Denied {
        crate::local_network::note_reached(&target.0, target.1);
    }
    match result {
        Ok(transport) => attempt.publish(transport),
        Err(error) if error.is::<PairIdentityRejected>() => Err(ConnectError {
            code: "host_key_rejected",
            message: error.to_string(),
        }),
        Err(error) => {
            let classified = classify_connect_error(&error, policy.last_decision(), &host);
            Err(local_network.explain(classified, reached))
        }
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
    /// Genau vier Werte: `"duplicate"`, `"outcome_unknown"`, `"shell_stdout"`
    /// (nichts angelegt, die Shell schreibt auf die Standardausgabe) und
    /// `"other"`.
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
    fn shell_stdout(message: impl Into<String>) -> Self {
        Self {
            kind: SHELL_STDOUT.into(),
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

/// Die Bitte nach einem Eingriff mit offenem Ausgang.
const REFRESH_SESSION_LIST: &str = "Refresh the session list before trying again.";

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
        format!("The remote operation may have taken effect, but its final outcome could not be confirmed. {REFRESH_SESSION_LIST} {error}")
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
/// werden HIER, an der Command-Grenze, geprueft (Bewertung H6/H9). Die Regel
/// "absoluter Pfad" stammt aus Gesamtspec §8.2 und gilt hier (und fuer
/// `cwd` noch einmal in `create_command`), nicht in `remote::build`: das
/// prueft per `assert!` nur NUL-Bytes (`encode_prelude`) und ein nicht
/// leeres argv, und ein Panic dort haengt den Tauri-`invoke` fuer immer,
/// statt dem WebView ein `Err(...)` zu liefern. `cwd` erreicht den Host als
/// Argument von `tmux new-session -c` ueber `remote::build`. `build` bleibt
/// eine Programmier-Invariante -- viele Aufrufer, aber nur eine Handvoll
/// Stellen, an denen ueberhaupt Hostdaten (statt fest verdrahteter Literale
/// wie `"git"`) hineinfliessen.
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

/// `name`: `None` -> erzeugter Name mit Retry. `Some(n)` -> genau dieser Name,
/// EINMAL, ohne Retry.
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
    // Verbindung erreichbar bleibt (siehe Testmodul). `cwd` geht als
    // Argument von `tmux new-session -c` durch `remote::build`, dessen
    // `assert!` nur NUL-Bytes abfaengt (ein Panic liesse den `invoke`
    // haengen); die Regel "absoluter Pfad ohne Steuerzeichen" (Gesamtspec
    // §8.2) gilt hier und in `create_command`.
    if !is_acceptable_remote_path(&cwd) {
        return Err(SessionError::other(
            "working directory must be an absolute path without control characters",
        ));
    }
    // Ebenfalls vor `prepare_server`, aus demselben Grund wie der Name oben.
    if crate::tmux::start_directory_ends_in_separator(&cwd) {
        return Err(SessionError::other(
            crate::tmux::START_DIRECTORY_SEPARATOR_RULE,
        ));
    }

    let transport = state
        .ready_host(&host_id)
        .ok_or_else(|| SessionError::other("host not connected"))?;

    let client = OwnTmuxClient::new(&state.own_socket);
    let transport = transport.command(deadline);
    // Schreibt die Shell auf die Standardausgabe, legte tmux die Session an,
    // ihre Bestaetigung waere aber unlesbar, und keine Liste zeigte sie
    // (`SHELL_STDOUT`); jeder weitere Versuch legte noch eine an. Die Sperre
    // des Frontends haengt an der letzten Liste, und die kann fehlen: direkt
    // nach dem Verbinden, nach einem Listenfehler anderer Art. Darum fragt
    // das Backend selbst, vor `prepare_server` aus demselben Grund wie beim
    // Namen oben. Scheitert schon die Frage, ist nichts angelegt; ein offener
    // Ausgang dieser Abfrage beruehrt keine Session.
    let answer = transport
        .exec_with_deadline(&client.version_command(), COMMAND_TIMEOUT)
        .await
        .map_err(|e| SessionError::other(e.to_string()))?;
    if let VersionAnswer::ShellOutput(line) = VersionAnswer::from_response(&answer) {
        return Err(SessionError::shell_stdout(shell_output_message(
            &line, None,
        )));
    }
    // Jedes Mal, nicht einmalig gecacht: robuster gegen einen tmux-Server, der
    // zwischen zwei `create_session`-Aufrufen gestorben ist (V21b), auf Kosten
    // von drei zusaetzlichen Roundtrips je Aufruf. Kehrseite: das Fenster, in
    // dem `exit-empty` aus steht, bis ein `new-session` gelingt (siehe unten),
    // oeffnet sich bei JEDEM Aufruf erneut, nicht nur beim ersten je Host.
    client
        .prepare_server(&transport, settings::default_history())
        .await
        .map_err(|e| SessionError::operation(&transport, &e))?;

    // Ab hier steht `exit-empty` auf "off", und nur ein ERFOLGREICHES
    // `new-session` setzt es in derselben Kommandokette zurueck. JEDER
    // Rueckweg von hier muss es deshalb selbst richten -- deswegen die
    // gemeinsame Auswertung unten statt eines frueheren `return`, auch fuer
    // den haeufigeren Zweig mit ERZEUGTEM Namen (`name: null`).
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
        // und mit "Session beenden" sichtbar. Ein Fehlschlag beim
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

/// tmux hat den Attach nicht bestaetigt, obwohl noch Zeit war. Gemessen am
/// 16.11. an einem echten Host: Schreibt die Shell nur mit Terminal
/// (`[ -t 1 ]` in `~/.bashrc`), bemerken Host-Pruefung und Liste nichts, und
/// das Oeffnen scheitert genau hier. Das Frontend erkennt den Text
/// (`SHELL_TERMINAL_ERRORS` in `grid.ts`) und nennt die Shell als moeglichen
/// Grund.
pub(crate) const ATTACH_NOT_CONFIRMED: &str = "attach wrapper was not confirmed";

/// Nach Ablauf der Frist oder einem Abbruch heisst die Meldung anders: Dann
/// spricht nichts fuer die Shell.
fn attach_not_confirmed(control: &OperationControl) -> String {
    if control.is_cancelled() || remaining_control(control).is_zero() {
        "the terminal setup ended before tmux confirmed the attach".into()
    } else {
        ATTACH_NOT_CONFIRMED.into()
    }
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
        .ok_or_else(|| attach_not_confirmed(&control))?;
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
    confirm_attached_binding(&commands, &binding, selected.session_id, || {
        remaining_control(&control)
    })
    .await?;
    Ok(pending.confirm())
}

/// So oft liest die Bestaetigung nach dem Anhaengen hoechstens, wenn sich
/// zwischendurch nur die Sessionliste des Servers geaendert hat.
const CONFIRM_ATTEMPTS: u32 = 4;

/// Liste, Aufloesung, Inventar, Aufloesung, Liste nach dem Anhaengen. Entsteht
/// oder endet waehrenddessen anderswo auf demselben Server eine Session, aendert
/// das nur die Liste, nicht die gewaehlte Bindung; dann liest die Pruefung
/// erneut (Abnahme vom 25.10., Befund 1). Jede andere Abweichung ist endgueltig.
async fn confirm_attached_binding(
    commands: &dyn Transport,
    binding: &SocketBinding,
    session: SessionId,
    remaining: impl Fn() -> Duration,
) -> Result<(), String> {
    let list = binding.query().list_command();
    let resolve = binding.query().resolve_command(session);
    let inventory = binding.query().inventory().command();
    let mut attempt = 1;
    loop {
        let mut results = Vec::with_capacity(5);
        for line in [&list, &resolve, &inventory, &resolve, &list] {
            results.push(
                commands
                    .exec_with_deadline(line, remaining())
                    .await
                    .map_err(|error| error.to_string())?,
            );
        }
        let results: [_; 5] = results
            .try_into()
            .unwrap_or_else(|_| unreachable!("five reads"));
        match binding.confirm_inventory(&results) {
            Err(Unverified::ListingChanged)
                if attempt < CONFIRM_ATTEMPTS && !remaining().is_zero() =>
            {
                attempt += 1;
            }
            outcome => return outcome.map_err(|error| error.to_string()),
        }
    }
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
/// Frist schon beim Kanaloeffnen ab und bleibt dessen Antwort auch 2 s danach
/// aus, bricht der Exec wie jeder befristete Befehl die Steuerverbindung ab
/// (§5.1 mit Nachtrag vom 10.11.); das Terminal oeffnet trotzdem.
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
/// aendert ein gescheiterter Befehl auf nutzbarem Transport nicht.
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
    // H6/H9: bewusst nicht die Allowlist aus `create_session_impl`
    // (`tmux::session_name_is_acceptable`); sie prueft nur Namen, die in
    // `create_session` eingetippt werden. Von Hand angelegte Sessions duerfen
    // Punkte und Nicht-ASCII tragen und muessen sich trotzdem oeffnen lassen;
    // gegen H6 reicht der Ausschluss von leerem Namen und Steuerzeichen.
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
        .ready_host(&host_id)
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
        let mut terms = registry(&state.terminals);
        let hosts = registry(&state.hosts);
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
            let mut terms = registry(&state.terminals);
            let hosts = registry(&state.hosts);
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
        let terms = registry(&state.terminals);
        let hosts = registry(&state.hosts);
        terms
            .get(&self.key)
            .is_some_and(|entry| entry.generation == self.generation)
            && hosts.get(&self.host_id).and_then(HostSlot::ready).is_some()
            && self
                .sink
                .send_open(&self.host_id, &self.session, &self.open_id, bytes)
    }
}
// `send_input_tagged_impl` und `resize_terminal_tagged_impl` duerfen den
// `state.terminals`-Guard NICHT ueber `pty.write(..).await` bzw.
// `pty.resize(..).await` hinweg halten. Als GEWOEHNLICHE `let`-Bindung bis
// zum Ende der Funktion (kein `if let`/`while let`/`match`-Scrutinee) faengt
// `clippy::significant_drop_in_scrutinee` das nicht ab, deshalb steht es
// hier. Waehrend diese Sperre gehalten wird, kann KEINE andere
// Terminal-Operation auf IRGENDEINER Session laufen -- `open_terminal`,
// `close_terminal`, `send_input`/`resize_terminal` auf jeder anderen
// Session, sogar `ack_output_impl`.
//
// Wie langsam `pty.write()`/`pty.resize()` tatsaechlich werden koennen:
// GEPRUEFT, nicht angenommen. Die naheliegende Vermutung -- die
// Ack-Rueckstaubremse (Spec §9.1) lasse ueber ein ausgehungertes
// SSH-Empfangsfenster auch `pty.write()` auf DERSELBEN Session blockieren --
// wurde gezielt gegen die echte Test-VM geprueft (Session geflutet, NIE
// geackt, danach `send_input_impl` auf genau dieser Session aufgerufen) und
// NICHT bestaetigt: der Aufruf kehrte nach ~125 Mikrosekunden zurueck, nicht
// blockiert. Das ist beim Nachdenken auch plausibel: SSH-Kanal-Flusskontrolle
// ist PRO RICHTUNG unabhaengig (RFC 4254) -- ein ausgehungertes
// Server-zu-Client-Fenster (unser Ack-Rueckstand) muss das
// Client-zu-Server-Fenster (unsere Eingaben) nicht mitbetreffen. Die
// eigentliche Gefahr bleibt trotzdem real, nur allgemeiner:
// `pty.write()`/`pty.resize()` sind fremdes Netzwerk-I/O (SSH-Kanalschreiben)
// und koennen aus ANDEREN Gruenden blockieren -- eine haengende/degradierte
// Verbindung, ein volles TCP-Sendefenster auf dem gemeinsamen
// Verbindungs-Socket, o.ae. Haelt `state.terminals` in so einem Moment noch
// die Sperre, blockiert das trotzdem JEDE andere Terminal-Operation auf JEDER
// Session -- der Fix unten ist deshalb unabhaengig vom genauen Ausloeser
// richtig.
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
        let terms = registry(&state.terminals);
        terms
            .get(&key)
            .filter(|entry| open_id.as_ref().is_none_or(|id| entry.open_id == *id))
            .map(|entry| entry.pty.clone())
            .ok_or_else(|| "no terminal open for this session".to_string())?
    };
    pty.write(&bytes).await.map_err(|e| e.to_string())
}

/// Dieselbe Form und derselbe Fix wie `send_input_tagged_impl` direkt
/// oberhalb -- siehe den Kommentar vor `send_input_impl`.
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
        let terms = registry(&state.terminals);
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
/// `write()`-Callback, mit der Laenge dieses einen Pakets. Ein Frontend, das
/// stattdessen die kumulative Summe schickt, wuerde `in_flight` zu schnell
/// leerlaufen lassen und die Bremse stillschweigend abschalten -- kein Test
/// hier kann das erkennen; das pinnt `src/terminal.test.ts`.
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
    let terms = registry(&state.terminals);
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
    invalidate_terminal(&mut registry(&state.terminals), &key, open_id.as_deref());
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
    // Die Pruefung nach einem gebundenen Kill geht einmal durch alle Sessions
    // (2N+3 Befehle); der Kill selbst behaelt `COMMAND_TIMEOUT`.
    let deadline = tokio::time::Instant::now() + SESSION_WALK_TIMEOUT;
    // H6/H9, dieselbe Ausnahme von der Allowlist wie in
    // `open_terminal_with_history`: von Hand angelegte Sessions duerfen Punkte
    // und Nicht-ASCII tragen und muessen sich trotzdem beenden lassen, nur
    // Steuerzeichen und der leere Name werden hier abgelehnt.
    if session.is_empty() || session.chars().any(|c| c.is_control()) {
        return Err("invalid session name".into());
    }

    let transport = state
        .ready_host(&host_id)
        .ok_or_else(|| "host not connected".to_string())?;

    // VOR dem Toeten, siehe Doc-Kommentar. Dasselbe Muster wie
    // `close_terminal_impl` -- erst binden, damit der Guard am `;` faellt.
    let key = session_key(&host_id, socket, &session);
    invalidate_terminal(&mut registry(&state.terminals), &key, None);

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
            .map_err(|e| bound_kill_error(&transport, &e))
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
    let remaining = match client.list_session_names(transport).await {
        Err(error) if asks_again_after_kill(&error) => {
            tokio::time::sleep(KILL_CHECK_PAUSE).await;
            client.list_session_names(transport).await?
        }
        listed => listed?,
    };
    if remaining.iter().any(|n| n == session) {
        anyhow::bail!(
            "the session {session:?} is still running on the host after the request to end it"
        );
    }
    Ok(())
}

/// Pause vor der zweiten Pruefliste nach einem Kill (`asks_again_after_kill`).
const KILL_CHECK_PAUSE: Duration = Duration::from_millis(250);

/// Ob eine gescheiterte Pruefliste nach einem Kill eine zweite bekommt. Endet
/// mit der letzten Session der Server, kann die Liste ihn noch beim
/// Herunterfahren erreichen; tmux meldet dann einen eigenen Fehler (unter
/// Last gesehen: "server exited unexpectedly") statt des gemessenen "no
/// server running". Diese Antwort beweist nichts. Die zweite Liste kommt nach
/// dem Ende des Servers an; gezaehlt wird nur sie. Ein Fehler des Transports
/// bekommt keine zweite: Er sagt nichts ueber tmux.
fn asks_again_after_kill(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ExecError>().is_none()
}

/// Ein gebundener Kill, dessen Ende sich nicht pruefen liess. Nur die
/// Ursache; die Bitte um eine frische Liste setzt `bound_kill_error` genau
/// einmal dazu.
const UNVERIFIED_BOUND_KILL: &str =
    "The end of the selected session could not be verified; it may already have ended.";

/// Meldung eines gescheiterten gebundenen Kills. Hat das kill-session mit
/// Exit 0 geendet, setzt `operation_error` den Vorsatz zum offenen Ausgang
/// samt Bitte um eine frische Liste davor. Hat tmux es mit "no server"
/// quittiert, fehlt dieser Vorsatz; ist das Ende dann unbewiesen, kommt die
/// Bitte hier hinter die Ursache.
fn bound_kill_error(transport: &CommandTransport, error: &anyhow::Error) -> String {
    let OperationErrorDto { code, message, .. } = operation_error(transport, error);
    if code != "outcome_unknown" && error.to_string() == UNVERIFIED_BOUND_KILL {
        format!("{message} {REFRESH_SESSION_LIST}")
    } else {
        message
    }
}

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
    // Fehler, nie ein Erfolg. Die Meldung sagt selbst, dass die Session schon
    // beendet sein kann: Hat tmux den Kill mit "no server" quittiert, fehlt
    // der Vorsatz zum offenen Ausgang (siehe `bound_kill_error`).
    let version = transport
        .exec_with_deadline(&client.version_command(), COMMAND_TIMEOUT)
        .await
        .map_err(|error| error.context(UNVERIFIED_BOUND_KILL))?;
    let Some(version) = MeasuredVersion::from_response(&version) else {
        anyhow::bail!(UNVERIFIED_BOUND_KILL);
    };
    let mut asked_again = false;
    let observed = loop {
        match client.observe_sessions(transport, version, deadline).await {
            Ok(observed) => break observed,
            // Ending the last session took the server with it: nothing is left.
            Err(error) if error.is::<ServerAbsent>() => return Ok(()),
            Err(error) if !asked_again && asks_again_after_kill(&error) => {
                asked_again = true;
                tokio::time::sleep_until(
                    deadline.min(tokio::time::Instant::now() + KILL_CHECK_PAUSE),
                )
                .await;
            }
            Err(error) => return Err(error),
        }
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
        let mut hosts = registry(&state.hosts);
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
        let mut terms = registry(&state.terminals);
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

/// Die Verbindung, deren Kontrollkanal repariert werden soll.
fn host_to_repair(
    state: &Arc<AppState>,
    host_id: &str,
) -> Result<Arc<HostConnection>, ConnectError> {
    state
        .ready_host(host_id)
        .ok_or_else(|| ConnectError::other("host not connected"))
}

pub fn begin_control_repair_impl(
    state: &Arc<AppState>,
    host_id: String,
) -> Result<u64, ConnectError> {
    host_to_repair(state, &host_id)?
        .begin_repair()
        .map_err(|error| ConnectError::other(error.to_string()))
}

pub fn cancel_control_repair_impl(
    state: &Arc<AppState>,
    host_id: String,
    control_generation: u64,
) -> Result<(), ConnectError> {
    if let Some(host) = state.ready_host(&host_id) {
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
    let host = host_to_repair(state, &host_id)?;
    let mut attempt = host
        .take_repair(control_generation)
        .map_err(|error| ConnectError::other(error.to_string()))?;
    let known_hosts_path = crate::paths::ssh_dir()
        .ok_or_else(|| ConnectError::other("could not determine home directory"))?
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
    // Android 17: vor dem Aufbau die Berechtigung fuers lokale Netz
    // (`local_network`). Der Dialog laeuft innerhalb der Gesamtfrist des
    // Versuchs (240 s), nicht in der Frist des Netzes. Ein Name, der nie ein
    // Hostname sein kann, erreicht weder den Dialog noch die
    // Namensaufloesung; `connect_host_core` weist ihn gleich ab.
    let local_network = if known_hosts::is_acceptable_hostname(&spec.hostname) {
        crate::local_network::prepare(&app, &spec.hostname, spec.port).await
    } else {
        crate::local_network::Gate::Open
    };
    connect_host_impl(state.inner(), Arc::new(app), host_id, spec, local_network).await
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

// Hostverwaltung, Einstellungen und Schluessel stehen in `commands/hosts.rs`,
// Sitzungsliste, Statusabfrage und Verzeichnisauswahl in
// `commands/inventory.rs`. Beide sind Teil dieses Moduls; was sie
// veroeffentlichen, heisst weiter `commands::<name>`.
mod hosts;
mod inventory;
pub use hosts::*;
pub use inventory::*;

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
mod tests;

#[cfg(test)]
mod tofu_tests;

#[cfg(test)]
mod connect_tests;

#[cfg(test)]
mod terminal_ownership_tests;

#[cfg(test)]
mod history_tests;
