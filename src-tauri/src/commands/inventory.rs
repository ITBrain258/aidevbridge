//! Sitzungsliste und Statusabfrage fuer die Seitenleiste, dazu die
//! Verzeichnisauswahl des Sitzungsdialogs. Teil des Moduls `commands`; die
//! Huellen-Regel aus dessen Kopf gilt auch hier.

use super::*;

// ---------------------------------------------------------------------
// Verwaltungsschale: Sitzungsliste fuer die Seitenleiste.
// ---------------------------------------------------------------------

/// Gibt die Namen aller Sessions auf dem App-Socket eines verbundenen Hosts
/// zurueck, ueber `TmuxClient::list_session_names` (Spec §2.4).
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
pub(super) fn session_list_item(
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
pub(super) enum SocketListing {
    Observed {
        observed: crate::tmux::client::SessionListObservation,
        titles: std::collections::BTreeMap<PaneId, crate::status::title::PaneDetails>,
    },
    /// Eigener Socket ohne strenge Liste: nur Namen. `shell_messages` nennt
    /// die Zeile der Shell, wenn sie der Grund ist
    /// (`VersionAnswer::ShellMessages`), sonst ist es die ungemessene
    /// tmux-Version.
    Names {
        names: Vec<String>,
        shell_messages: Option<String>,
    },
    /// Kein Server: eine leere Liste, kein Fehler.
    Empty,
    /// Standard-Socket mit einer Serverversion ohne Messung.
    Unsupported(String),
}

/// Was die Antwort auf `tmux -V` der Sessionliste erlaubt. Neben
/// `MeasuredVersion::from_response`, das unveraendert bleibt: Dort zaehlt nur
/// die genaue Antwort einer gemessenen Version. Hier kommt dazu, WARUM eine
/// Antwort nicht genau ist. Eine Startdatei der Shell, die vor jedem
/// SSH-Befehl schreibt (`~/.bashrc` vor ihrer Pruefung auf eine interaktive
/// Shell, `~/.zshenv`), sah bisher aus wie eine ungemessene tmux-Version:
/// Ihre Zeilen standen als Sessions in der Liste.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum VersionAnswer {
    /// Die genaue Antwort einer gemessenen Version: die strenge Liste.
    Measured(MeasuredVersion),
    /// Genau die Zeile `tmux …` einer ungemessenen Version, oder der Befehl
    /// scheiterte: nur Namen, wie bisher.
    Unmeasured,
    /// Genau die Zeile `tmux …`, daneben Text auf der Fehlerausgabe (etwa
    /// `stty` ohne Terminal); getragen wird dessen erste Zeile. Die Namen
    /// bleiben genau, die strenge Rahmung nicht.
    ShellMessages(String),
    /// Auf der Standardausgabe steht anderes als die eine Zeile `tmux …`;
    /// getragen wird die erste fremde Zeile. Text der Shell laesst sich von
    /// Sessionnamen nicht trennen: Es gibt keine Liste.
    ShellOutput(String),
}

impl VersionAnswer {
    pub(super) fn from_response(result: &crate::transport::ExecResult) -> Self {
        if let Some(version) = MeasuredVersion::from_response(result) {
            return Self::Measured(version);
        }
        if result.code != 0 {
            return Self::Unmeasured;
        }
        let lines: Vec<&str> = result
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let is_version = |line: &&str| line.starts_with("tmux ");
        match lines.as_slice() {
            // Nichts auf der Standardausgabe: kein Text der Shell, den eine
            // Meldung nennen koennte. Wie bisher nur Namen.
            [] => Self::Unmeasured,
            [line] if is_version(line) => match crate::preflight::shell_line(&result.stderr) {
                Some(message) => Self::ShellMessages(message),
                None => Self::Unmeasured,
            },
            lines => {
                let foreign = lines.iter().find(|line| !is_version(line));
                let quoted = foreign.or(lines.first()).copied().unwrap_or_default();
                Self::ShellOutput(crate::preflight::shell_line(quoted).unwrap_or_default())
            }
        }
    }
}

/// ` (it starts with "…")`, oder nichts, wenn die Zeile kein druckbares
/// Zeichen trug.
fn shell_line_note(line: &str) -> String {
    match line.is_empty() {
        true => String::new(),
        false => format!(" (it starts with \"{line}\")"),
    }
}

/// Code einer Liste, die es nicht gibt, weil die Shell des Hosts Text auf die
/// Standardausgabe schreibt. Dann scheitert auch das Anlegen einer Session:
/// tmux legte sie an, ihre Bestaetigung (`session_binding::parse_created`)
/// waere aber unlesbar. Das Frontend sperrt deshalb "New session".
pub const SHELL_STDOUT: &str = "shell_stdout";

/// Code einer Liste, die wegen Meldungen der Shell auf der Fehlerausgabe
/// scheiterte. Anlegen geht dort, und an einem leeren Host ist es der
/// einzige Weg zur ersten Session.
const SHELL_MESSAGES: &str = "shell_output";

/// Die Liste eines Sockets gibt es nicht, weil die Shell des Hosts in die
/// Antworten schreibt. `detail` ist der Rohtext eines gescheiterten Befehls
/// und steht am Ende, fuer "Details" und "Copy diagnostics".
fn shell_output_error(
    transport: &CommandTransport,
    code: &'static str,
    line: &str,
    detail: Option<&anyhow::Error>,
) -> OperationErrorDto {
    OperationErrorDto {
        code,
        message: shell_output_message(line, detail),
        control_generation: transport.generation,
    }
}

pub(super) fn shell_output_message(line: &str, detail: Option<&anyhow::Error>) -> String {
    let mut message = format!(
        "The host's shell prints text on every SSH command{}, so the app cannot read exact \
         answers. {}",
        shell_line_note(line),
        crate::preflight::SHELL_OUTPUT_REMEDY
    );
    if let Some(detail) = detail {
        message.push_str(&format!(" ({detail})"));
    }
    message
}

/// Der Grund an jeder Zeile einer Namensliste, die es wegen Meldungen der
/// Shell auf der Fehlerausgabe nur als Namen gibt (Tooltip an "Unknown").
fn shell_messages_reason(line: &str) -> String {
    format!(
        "the host's shell prints messages on every SSH command (\"{line}\"); status and \
         history need a shell that stays silent there"
    )
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
/// eigenen zuerst, beide mit derselben Frist: `SESSION_WALK_TIMEOUT` fuer
/// alles zusammen, jeder einzelne Befehl hoechstens 15 s. Ein fehlender Host
/// und ein gescheiterter Befehl `tmux -V` scheitern ganz, ein Fehler eines
/// Sockets nur fuer diesen.
pub async fn list_sockets_impl(
    state: &Arc<AppState>,
    host_id: String,
    include_default: bool,
) -> Result<SessionListDto, OperationErrorDto> {
    let deadline = tokio::time::Instant::now() + SESSION_WALK_TIMEOUT;
    // Nur eine fertige Verbindung zaehlt; `ready_host` gibt die
    // `hosts`-Sperre vor dem ersten `await` wieder frei.
    let transport = state
        .ready_host(&host_id)
        .ok_or_else(|| OperationErrorDto {
            code: "host_unavailable",
            message: "host not connected".into(),
            control_generation: 0,
        })?;
    let transport = transport.command(deadline);
    // Nur eine Antwort entscheidet, ob die Version gemessen ist. Scheitert
    // schon der Befehl (kein freier Exec-Platz beim Start mit vielen Kacheln,
    // Frist, Transport), scheitert die ganze Liste mit diesem Grund, und die
    // naechste liest erneut; als "ungemessen" verloeren die eigenen Sessions
    // sonst bis dahin Bindung und Verlauf, unter einem irrefuehrenden Grund.
    let answer = match transport
        .exec_with_deadline(
            &TmuxClient::new(&state.own_tmux_socket()).version_command(),
            COMMAND_TIMEOUT,
        )
        .await
    {
        Ok(result) => VersionAnswer::from_response(&result),
        Err(error) => return Err(operation_error(&transport, &error)),
    };
    let (installed, shell_messages) = match answer {
        VersionAnswer::Measured(version) => (Some(version), None),
        VersionAnswer::Unmeasured => (None, None),
        VersionAnswer::ShellMessages(line) => (None, Some(line)),
        VersionAnswer::ShellOutput(line) => {
            return Err(shell_output_error(&transport, SHELL_STDOUT, &line, None))
        }
    };
    let observed = |listing: &Result<SocketListing, OperationErrorDto>| {
        matches!(listing, Ok(SocketListing::Observed { .. }))
    };
    let own = list_own_socket(
        state,
        &transport,
        installed,
        shell_messages.as_deref(),
        deadline,
    )
    .await;
    // claude gleich nach dem eigenen Socket: ein langsamer Standard-Socket
    // nimmt den eigenen Sessions so nicht die Zeit fuer ihren Status (Spec
    // 2026-10-25 §6.3, der eigene Socket zuerst).
    let mut agents = None;
    if observed(&own) {
        agents = Some(read_claude_agents(&transport, deadline).await);
    }
    let default = match (include_default, &shell_messages) {
        (false, _) => None,
        // Der Standard-Socket braucht die strenge Rahmung; mit Meldungen der
        // Shell auf der Fehlerausgabe scheiterte sie an jeder Antwort. Er
        // wird dann gar nicht gelesen und nennt denselben Grund.
        (true, Some(line)) => Some(Err(shell_output_error(
            &transport,
            SHELL_MESSAGES,
            line,
            None,
        ))),
        (true, None) => Some(list_default_socket(state, &transport, installed, deadline).await),
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
// Dass `HostEntry.tmux_socket` insgesamt ungelesen bleibt, legt Spec
// 2026-10-25 §2 fest ("`HostEntry.tmux_socket` bleibt ungelesen"). Eine
// Aenderung muesste BEIDE Stellen gleichzeitig umstellen.
async fn list_own_socket(
    state: &Arc<AppState>,
    transport: &CommandTransport,
    installed: Option<MeasuredVersion>,
    shell_messages: Option<&str>,
    deadline: tokio::time::Instant,
) -> Result<SocketListing, OperationErrorDto> {
    let socket = state.own_tmux_socket();
    let client = TmuxClient::new(&socket);
    match installed {
        Some(version) => observed_listing(&client, &socket, transport, version, deadline).await,
        None => client
            .list_session_names(transport)
            .await
            .map(|names| SocketListing::Names {
                names,
                shell_messages: shell_messages.map(str::to_string),
            })
            .map_err(|e| match shell_messages {
                // tmux hat geantwortet, aber nicht lesbar: Auch "kein Server"
                // erkennt die Namensliste nur an der genauen Fehlerausgabe.
                // Ein Fehler des Transports behaelt seinen eigenen Grund.
                Some(line) if e.downcast_ref::<ExecError>().is_none() => {
                    shell_output_error(transport, SHELL_MESSAGES, line, Some(&e))
                }
                _ => operation_error(transport, &e),
            }),
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

pub(super) fn socket_sessions(
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
        Ok(SocketListing::Names {
            names,
            shell_messages,
        }) => {
            let (unverified, reason) = match &shell_messages {
                Some(line) => (SHELL_MESSAGES, shell_messages_reason(line)),
                None => (
                    "unmeasured_tmux_version",
                    "tmux version is not a measured 3.0/3.3a/3.4/3.6 inventory".to_string(),
                ),
            };
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
                    unverified: Some(unverified.into()),
                    status: "unknown".into(),
                    status_reason: reason.clone(),
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
pub(super) const STATUS_POLL_TIMEOUT: Duration = Duration::from_secs(5);

// Verzichtbare Lesungen starten nur mit genug Restzeit: Laeuft eine Frist
// mitten im Kanaloeffnen ab und bleibt dessen Antwort auch 2 s danach aus,
// bricht der Transport die Steuerverbindung ab (`owned_operations.rs`,
// Phase Open).
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

pub(super) struct SocketsPoll {
    pub(super) own: anyhow::Result<StatusPollDto>,
    pub(super) default: Option<anyhow::Result<StatusPollDto>>,
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
pub(super) async fn poll_status_with(
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
pub(super) async fn poll_sockets_with(
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
    // claude gleich nach dem eigenen Socket. Der Standard-Socket laeuft
    // daneben auf eigenen Kanaelen derselben Verbindung: Seine Lesungen
    // verlaengern die Abfrage nicht um ihre eigene Dauer, sondern nur, wenn
    // sie laenger brauchen als eigener Socket und claude zusammen (Spec
    // 2026-10-25 §6.3, Abnahme vom 25.10.: nacheinander 0,5 s mehr).
    let own_branch = async {
        let polled = poll_socket(transport, own, version, deadline).await;
        let agents = if observed(&polled) {
            Some(read_claude_agents(transport, deadline).await)
        } else {
            None
        };
        (polled, agents)
    };
    let default_branch = async {
        match default {
            Some(socket) => Some(poll_socket(transport, socket, version, deadline).await),
            None => None,
        }
    };
    let ((own_polled, mut agents), default_polled) = tokio::join!(own_branch, default_branch);
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

pub async fn poll_sockets_impl(
    state: &Arc<AppState>,
    host_id: String,
    include_default: bool,
) -> Result<StatusPollsDto, OperationErrorDto> {
    let deadline = tokio::time::Instant::now() + STATUS_POLL_TIMEOUT;
    // Same lookup as `list_sockets_impl`: the control connection only.
    let transport = state
        .ready_host(&host_id)
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

    let transport = state
        .ready_host(&host_id)
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
