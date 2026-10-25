use super::inventory::{
    InventoryOutcome, InventoryQuery, InventorySnapshot, MeasuredVersion, ServerIdentity, SessionId,
};
use super::session_binding::{self, BindingQuery, BoundObservation, ParseError, UnverifiedReason};
use super::socket::{OwnSocket, SocketKind, TmuxSocket};
use crate::remote;
use crate::transport::{ExecError, ExecPhase, ExecReason, ExecResult, Submission, Transport};
use std::collections::BTreeMap;
use tokio::time::Instant;

/// Complete, socket-bound observations. These contain no runtime-host/control
/// authorization and cannot authorize a later attach or kill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionListObservation {
    pub version: MeasuredVersion,
    pub socket_name: String,
    pub inventory: InventorySnapshot,
    pub sessions: Vec<ListedSessionObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedSessionObservation {
    pub session_id: SessionId,
    pub display_name: String,
    pub binding: Result<BoundObservation, BindingUnavailableReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BindingUnavailableReason {
    #[error("initial numeric resolution unavailable: {0}")]
    ResolveBefore(ParseError),
    #[error("final numeric resolution unavailable: {0}")]
    ResolveAfter(ParseError),
    #[error("numeric observations do not agree: {0}")]
    Changed(UnverifiedReason),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("tmux inventory observation is not a complete snapshot: {0:?}")]
pub struct InventoryObservationUnavailable(pub InventoryOutcome);

/// No tmux server listens on the named socket (MVP spec, addendum of
/// 2026-09-15): the failed first list carries tmux's own connection diagnosis
/// for exactly the path a second read-only query predicts. Callers read it as
/// "no sessions"; an empty observation itself still needs a live server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("no tmux server is running on this socket")]
pub struct ServerAbsent;

/// The socket path tmux 3.3a/3.4/3.6 derive for `-L <name>`: realpath of
/// `$TMUX_TMPDIR` or /tmp, then `tmux-<uid>/<name>` (tmux.c, make_label).
/// Read-only: no tmux call, no file written. A missing directory predicts
/// nothing, so a differently derived path stays an error. (3.6 insists on
/// the realpath where 3.4 fell back to the unresolved path; measured equal.)
const SOCKET_PATH_SCRIPT: &str = r#"d=${TMUX_TMPDIR:-/tmp}
r=$(cd -- "$d/tmux-$(id -u)" 2>/dev/null && pwd -P) || exit 1
printf 'S|%s/%s\n' "$r" "$1""#;

/// Each underlying exec retains ownership of cancellation/cleanup. In the
/// product the caller's CommandTransport also carries this same absolute
/// deadline; a successful late result is never used to start another query.
async fn observation_exec(
    transport: &dyn Transport,
    line: String,
    deadline: Instant,
) -> anyhow::Result<ExecResult> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(ExecError {
            phase: ExecPhase::Admission,
            reason: ExecReason::Timeout,
            submission: Submission::NotSubmitted,
        })?;
    let result = transport.exec_with_deadline(&line, remaining).await?;
    if Instant::now() >= deadline {
        return Err(ExecError {
            phase: ExecPhase::Read,
            reason: ExecReason::Timeout,
            submission: Submission::PossiblySubmitted,
        }
        .into());
    }
    Ok(result)
}

/// Ergebnis von `create_session`. Bewusst kein `bool` oder `Result<(), _>` --
/// eine Namenskollision ist kein technischer Fehler (die Verbindung war
/// intakt, der Befehl lief), sondern ein erwartbarer, vom Aufrufer zu
/// behandelnder Fall: bei Zufallsnamen bedeutet er "neu wuerfeln", niemals
/// "existiert bereits, also anhaengen" (Spec §5.1 -- an eine fremde Session
/// mit gleichem Namen anzuhaengen waere Datenverlust in einem fremden
/// Projekt). Deshalb wird hier auch bewusst NICHT `new-session -A`
/// verwendet, das wuerde attach und create unwiderruflich verschmelzen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateOutcome {
    Created,
    DuplicateName,
}

/// Liest einen tmux-Socket (siehe `-L`): den eigenen oder den
/// Standard-Socket. Mehrere `TmuxClient`s mit unterschiedlichem Socketnamen
/// teilen sich weder Server noch Sessions. Befehle, die einen Server
/// veraendern, hat nur [`OwnTmuxClient`].
pub struct TmuxClient {
    socket: TmuxSocket,
}

impl TmuxClient {
    pub fn new(socket: &TmuxSocket) -> Self {
        Self {
            socket: socket.clone(),
        }
    }

    /// Observe the complete list and bind its numeric IDs without using names
    /// as targets. `version` must come from an exact MeasuredVersion response,
    /// not the trimmed preflight display or a >=3.x/version-prefix guess.
    ///
    /// Use one CommandTransport, one control generation and this same absolute
    /// deadline for the entire call. No per-query deadline reset or retry occurs.
    /// Completed R failures leave that row unbound; failed list/inventory or
    /// transport results fail the observation and cannot prove an empty list.
    /// The one exception is a failed first list on 3.3a/3.4/3.6 that proves the
    /// server absent: it ends as [`ServerAbsent`], not as an empty observation.
    pub async fn observe_sessions(
        &self,
        transport: &dyn Transport,
        version: MeasuredVersion,
        deadline: Instant,
    ) -> anyhow::Result<SessionListObservation> {
        let query = BindingQuery::new(self.inventory_query(version)?);
        let first = observation_exec(transport, query.list_command(), deadline).await?;
        let listed_before = match session_binding::parse_list(&first) {
            Ok(listed) => listed,
            Err(error) => {
                if self
                    .server_proven_absent(transport, version, &first, deadline)
                    .await?
                {
                    return Err(ServerAbsent.into());
                }
                return Err(error.into());
            }
        };
        let mut before = BTreeMap::new();
        for &session_id in listed_before.sessions().keys() {
            let result =
                observation_exec(transport, query.resolve_command(session_id), deadline).await?;
            before.insert(session_id, session_binding::parse_resolved(&result));
        }
        let result = observation_exec(transport, query.inventory().command(), deadline).await?;
        if !result.utf8_valid {
            return Err(ParseError::InvalidUtf8.into());
        }
        let inventory = match query.inventory().classify(&result) {
            InventoryOutcome::Snapshot(inventory) => inventory,
            other => return Err(InventoryObservationUnavailable(other).into()),
        };
        // Reject a mismatched complete ID set/server before any further R calls.
        // This does not replace the obligatory second, actually observed L list.
        session_binding::confirm_listed_inventory(&listed_before, &inventory, &listed_before)?;
        let mut after = BTreeMap::new();
        for &session_id in listed_before.sessions().keys() {
            let result =
                observation_exec(transport, query.resolve_command(session_id), deadline).await?;
            after.insert(session_id, session_binding::parse_resolved(&result));
        }
        let listed_after = session_binding::parse_list(
            &observation_exec(transport, query.list_command(), deadline).await?,
        )?;
        session_binding::confirm_listed_inventory(&listed_before, &inventory, &listed_after)?;
        let sessions = listed_before
            .sessions()
            .iter()
            .map(|(&session_id, display_name)| {
                let binding = match (&before[&session_id], &after[&session_id]) {
                    (Err(error), _) => Err(BindingUnavailableReason::ResolveBefore(error.clone())),
                    (_, Err(error)) => Err(BindingUnavailableReason::ResolveAfter(error.clone())),
                    (Ok(before), Ok(after)) => session_binding::correlate(
                        &listed_before,
                        before,
                        &inventory,
                        after,
                        &listed_after,
                        session_id,
                        None,
                    )
                    .map_err(BindingUnavailableReason::Changed),
                };
                ListedSessionObservation {
                    session_id,
                    display_name: display_name.clone(),
                    binding,
                }
            })
            .collect();
        if Instant::now() >= deadline {
            return Err(ExecError {
                phase: ExecPhase::Read,
                reason: ExecReason::Timeout,
                submission: Submission::PossiblySubmitted,
            }
            .into());
        }
        Ok(SessionListObservation {
            version,
            socket_name: self.socket.name().to_string(),
            inventory,
            sessions,
        })
    }

    /// Die Inventarabfrage dieses Sockets. Auf dem Standard-Socket duldet sie
    /// Sitzungsgruppen (Spec 2026-10-25 §6.2): Deren Sessions bleiben
    /// ungebunden, das uebrige Inventar gilt.
    pub fn inventory_query(
        &self,
        version: MeasuredVersion,
    ) -> Result<InventoryQuery, super::inventory::InvalidSocket> {
        let query = InventoryQuery::named(version, self.socket.name())?;
        Ok(match self.socket.kind() {
            SocketKind::App => query,
            SocketKind::Default => query.tolerating_linked_windows(),
        })
    }

    /// The one failed first list that proves no sessions: on 3.3a/3.4/3.6
    /// tmux's exact connection diagnosis names the path that a separate
    /// read-only query predicts for this socket. Everything else stays the
    /// list's error. Only 3.0 is excluded: its first call derives the path
    /// differently and no prediction was measured there.
    async fn server_proven_absent(
        &self,
        transport: &dyn Transport,
        version: MeasuredVersion,
        failed: &ExecResult,
        deadline: Instant,
    ) -> anyhow::Result<bool> {
        if version == MeasuredVersion::V3_0 {
            return Ok(false);
        }
        let Some(diagnosed) = self.absent_diagnosis(failed) else {
            return Ok(false);
        };
        let prediction = observation_exec(transport, self.socket_path_command(), deadline).await?;
        Ok(self.predicted_path(&prediction) == Some(diagnosed))
    }

    /// Exactly one of the two measured diagnoses and nothing else on either
    /// stream; unlike [`Self::server_absent`] no trailing-whitespace tolerance.
    fn absent_diagnosis<'a>(&self, r: &'a ExecResult) -> Option<&'a str> {
        if r.code != 1 || !r.stdout.is_empty() || !r.utf8_valid {
            return None;
        }
        let line = r.stderr.strip_suffix('\n')?;
        let path = line.strip_prefix("no server running on ").or_else(|| {
            line.strip_prefix("error connecting to ")?
                .strip_suffix(" (No such file or directory)")
        })?;
        self.names_this_socket(path).then_some(path)
    }

    fn socket_path_command(&self) -> String {
        remote::build(&[
            "sh",
            "-c",
            SOCKET_PATH_SCRIPT,
            "aidevbridge-socket",
            self.socket.name(),
        ])
    }

    fn predicted_path<'a>(&self, r: &'a ExecResult) -> Option<&'a str> {
        if r.code != 0 || !r.stderr.is_empty() || !r.utf8_valid {
            return None;
        }
        let path = r.stdout.strip_prefix("S|")?.strip_suffix('\n')?;
        self.names_this_socket(path).then_some(path)
    }

    /// Absolute, free of control characters and ending in `/<socket>`.
    fn names_this_socket(&self, path: &str) -> bool {
        path.starts_with('/')
            && !path.chars().any(char::is_control)
            && path
                .strip_suffix(self.socket.name())
                .is_some_and(|dir| dir.ends_with('/'))
    }

    /// Baut `["tmux", "-L", <socket>, ...args]`. Jede von hier erzeugte
    /// Kommandozeile geht danach durch `remote::build` -- kein `format!`
    /// auf einen SSH-Befehl (Randbedingung des Tasks).
    fn tmux<'a>(&'a self, args: &[&'a str]) -> Vec<&'a str> {
        let mut v = vec!["tmux"];
        v.extend_from_slice(&self.socket.args());
        v.extend_from_slice(args);
        v
    }

    /// Stable strerror text for commands whose errors we classify. Neither
    /// command starts a server, so LC_ALL cannot leak into a new session's
    /// environment. -u preserves UTF-8 names in stdout/stderr: without it,
    /// tmux sanitizes non-ASCII output when LC_ALL=C. Creation and PTY
    /// attachment keep the user's locale.
    fn query_command(&self, args: &[&str]) -> String {
        let mut argv = vec!["env", "LC_ALL=C"];
        let mut tmux = self.tmux(args);
        tmux.insert(1, "-u");
        argv.extend(tmux);
        remote::build(&argv)
    }

    /// Only the documented connection failures prove that no server is
    /// listening. A failed command with empty stdout is otherwise an error.
    /// Error forms: tmux 3.0a/3.4 client.c, client_main (ECONNREFUSED/ENOENT);
    /// the same two texts were measured on 3.6 (2026-10-11).
    /// https://github.com/tmux/tmux/blob/3.0a/client.c
    fn server_absent(&self, r: &ExecResult) -> bool {
        if r.code != 1 || !r.stdout.is_empty() {
            return false;
        }
        let message = r.stderr.trim_end_matches(['\r', '\n']);
        let path = message.strip_prefix("no server running on ").or_else(|| {
            message
                .strip_prefix("error connecting to ")?
                .strip_suffix(" (No such file or directory)")
        });
        path.is_some_and(|path| {
            path.starts_with('/')
                && !path.chars().any(char::is_control)
                && path.rsplit('/').next() == Some(self.socket.name())
        })
    }
}

/// Der Client des eigenen Sockets: liest wie [`TmuxClient`] und darf als
/// einziger einen Server veraendern -- Optionen setzen, Sessions anlegen und
/// beenden (Spec 2026-10-25 §3, §6.1). Es gibt ihn nur fuer einen
/// [`OwnSocket`]; der Standard-Socket des Nutzers bekommt nie einen.
pub struct OwnTmuxClient {
    reader: TmuxClient,
}

impl std::ops::Deref for OwnTmuxClient {
    type Target = TmuxClient;

    fn deref(&self) -> &TmuxClient {
        &self.reader
    }
}

impl OwnTmuxClient {
    pub fn new(socket: &OwnSocket) -> Self {
        Self {
            reader: TmuxClient::new(&TmuxSocket::own(socket)),
        }
    }

    /// Checks remote exit codes as well as transport failures.
    async fn run_checked(&self, t: &dyn Transport, args: &[&str]) -> anyhow::Result<()> {
        let r = t
            .exec_mutation(&remote::build(&self.reader.tmux(args)))
            .await?;
        if r.code != 0 {
            anyhow::bail!(
                "tmux {} failed (exit {}): {}",
                args.join(" "),
                r.code,
                r.stderr.trim()
            );
        }
        Ok(())
    }

    /// Serveroptionen setzen, bevor irgendeine Session existiert.
    ///
    /// Reihenfolge ist kein Stil, sondern Bedingung:
    /// - `history-limit` wirkt nur auf Panes, die NACH dem Setzen erzeugt
    ///   werden (gemessener Befund, nicht dokumentiert -- siehe
    ///   `history_limit_is_set_before_sessions_exist`). Deshalb `start-server`
    ///   + `set -g history-limit` fest VOR `create_session`, nie danach.
    /// - `remain-on-exit` MUSS ueber `setw -g`, nicht `set -g`: mit `set -g`
    ///   stirbt der tmux-Server beim Start (gemessener Befund). Ohne diese
    ///   Option kann `#{pane_dead}` nie 1 werden -- der Zustand "beendet"
    ///   waere fuer spaetere Tasks unerreichbar.
    ///
    /// Vierter, selbst gemessener Befund: ein per
    /// `start-server` gestarteter Server hat null Sessions. tmux' eigene
    /// Serveroption `exit-empty` steht per Default auf "on" --
    /// ein Server ohne Sessions beendet sich selbst, sobald der ihn
    /// startende Client (dieser Aufruf, ein eigener SSH-Exec) die
    /// Verbindung trennt. Der naechste, GETRENNTE Aufruf (`set -g
    /// history-limit`, wieder ein eigener SSH-Exec) trifft dann schon auf
    /// "no server running"; sein Fehler blieb unbemerkt, weil hier nur auf
    /// Transportfehler mit `?` geprueft wird, nicht auf `r.code`. Der
    /// darauffolgende `new-session`-Aufruf (der einzige Befehl, der von
    /// sich aus einen fehlenden Server neu startet) laeuft dann gegen einen
    /// BRANDNEUEN Server mit lauter Voreinstellungen -- `history-limit`
    /// zeigte im ersten Testlauf "2000" (tmux-Default) statt "12345".
    /// `exit-empty off` muss deshalb in DERSELBEN
    /// tmux-Verbindung wie `start-server` gesetzt werden (`;` als eigenes
    /// argv-Element -- `remote::build` transportiert es als Rohwert, keine
    /// Shell-Interpretation noetig, tmux liest es als sein eigenes
    /// Kommando-Trennzeichen). Sonst existiert genau die Luecke, in der der
    /// Server zwischen den beiden separaten SSH-Execs schon wieder weg ist.
    /// Gegenstueck steht in `create_session`: sobald eine Session existiert,
    /// muss `exit-empty` wieder auf "on", sonst wuerde der Server nach
    /// `kill_session` nicht mehr von selbst verschwinden.
    pub async fn prepare_server(
        &self,
        t: &dyn Transport,
        history_limit: u32,
    ) -> anyhow::Result<()> {
        let hl = history_limit.to_string();
        let result = async {
            self.run_checked(t, &["start-server", ";", "set", "-g", "exit-empty", "off"])
                .await?;
            self.run_checked(t, &["set", "-g", "history-limit", &hl])
                .await?;
            self.run_checked(t, &["setw", "-g", "remain-on-exit", "on"])
                .await?;
            // `-ga` haengt an, statt die Standardliste zu ersetzen (Spec
            // §6.8): tmux 3.0/3.1 fuehren dort `Ms` (OSC 52) fuer `xterm*`.
            // Erneutes Anhaengen bei jeder neuen Session ist harmlos.
            self.run_checked(t, &["set", "-ga", "terminal-overrides", ",*:smcup@:rmcup@"])
                .await
        }
        .await;
        if result.is_err() {
            // A later preparation step can fail after exit-empty was disabled.
            // Preserve the original error if best-effort cleanup also fails.
            let _ = self.restore_exit_empty(t).await;
        }
        result
    }

    /// Legt eine neue, entkoppelte (`-d`) Session an.
    ///
    /// Bewusst `new-session` OHNE `-A`: `-A` wuerde attach und create in
    /// einem Aufruf verschmelzen -- der Aufrufer koennte dann nicht mehr
    /// unterscheiden, ob eine neue Session entstanden ist (in der spaeter
    /// ein Agent gestartet werden darf) oder ob an eine vorhandene,
    /// moeglicherweise fremde Session angehaengt wurde (Spec §5.1). Bei
    /// Namen, die zufaellig aus `new_session_name` stammen, ist ein
    /// `duplicate session`-Fehler ausschliesslich als Kollision zu lesen --
    /// nie als "existiert schon, also anhaengen".
    ///
    /// `; set -g exit-empty on` haengt bewusst am selben tmux-Aufruf wie
    /// `new-session` (siehe `prepare_server` fuer die Gegenrichtung): nur
    /// wenn `new-session` erfolgreich war, existiert jetzt eine Session,
    /// und erst dann darf der Server wieder von selbst beenden duerfen,
    /// sobald sie irgendwann geloescht wird (das erwartet `kill_session`
    /// -- "no server running" danach, ohne dass diese Klasse je
    /// `kill-server` aufruft). Schlaegt `new-session` fehl (Kollision),
    /// bricht tmux die Kommandokette VOR dem zweiten Teil ab -- die
    /// Sessionzahl auf dem Socket hat sich dann nicht geaendert, `exit-empty`
    /// bleibt unangetastet richtig.
    pub async fn create_session(
        &self,
        t: &dyn Transport,
        name: &str,
        cwd: &str,
    ) -> anyhow::Result<CreateOutcome> {
        let query = BindingQuery::new(InventoryQuery::conservatively_guarded_named(
            self.reader.socket.name(),
        )?);
        let line = query.create_command(name, cwd)?;
        let r = t.exec_mutation(&line).await?;
        if r.code == 0 {
            // A successful mutation without a parseable C record is unclear,
            // not a completed create and not a reason to retry as Created.
            session_binding::parse_created(&r)?;
            return Ok(CreateOutcome::Created);
        }
        if r.stderr.contains("duplicate session") {
            return Ok(CreateOutcome::DuplicateName);
        }
        Err(anyhow::anyhow!("new-session failed: {}", r.stderr.trim()))
    }

    /// Setzt `exit-empty` wieder auf "on".
    ///
    /// Gegenstueck zu `prepare_server`s `exit-empty off` fuer den Fall, dass
    /// `create_session` NICHT erfolgreich war: dessen eigene Kommandokette
    /// (`; set -g exit-empty on`) erreicht ihren zweiten Teil nur bei
    /// gelungenem `new-session`. Ohne diesen Weg bliebe ein Server, dessen
    /// einziger Anlegeversuch fehlschlug, dauerhaft stehen -- gegen die
    /// Zusage in `prepare_server`s Kommentar.
    ///
    /// Called after failed preparation and creation. Callers retain their
    /// original error if this best-effort cleanup also fails.
    pub async fn restore_exit_empty(&self, t: &dyn Transport) -> anyhow::Result<()> {
        t.exec_mutation(&remote::build(&self.reader.tmux(&[
            "set",
            "-g",
            "exit-empty",
            "on",
        ])))
        .await?;
        Ok(())
    }

    /// Beendet die Session mit GENAU diesem Namen.
    ///
    /// Das `=` vor dem Namen ist der ganze Punkt. Ohne es loest tmux ein
    /// `-t`-Ziel per PRAEFIX auf: `kill-session -t dev` beendet `dev2`, wenn
    /// `dev` nicht existiert -- und meldet Exit 0. An der VM gemessen
    /// (tmux 3.4, eigener Socket). Die Folge waere, dass diese Anwendung die
    /// laufende Sitzung eines fremden Projekts abraeumt und Erfolg anzeigt.
    ///
    /// `remote::build` transportiert jedes Argument base64-kodiert und setzt
    /// es als `"$A<n>"` ein -- das fuehrende `=` kann von der entfernten
    /// Shell nicht umgedeutet werden (in zsh waere `=wort` sonst eine
    /// Pfadexpansion). An der VM bestaetigt.
    ///
    /// **Kein Preis bei escapten Namen, entgegen der urspruenglichen
    /// Annahme.** Der Plan zu diesem Paket ging davon aus, eine Session, die
    /// tmux escapt speichert, sei unter ihrem GELISTETEN Namen mit `=` nicht
    /// mehr adressierbar. In B3 nachgemessen (Testhost 192.0.2.10, tmux
    /// **3.3a** -- die uebrigen Messungen dieses Pakets stammen von
    /// 192.0.2.20 mit 3.4, deshalb hier ausdruecklich) und widerlegt:
    ///
    /// ```text
    /// $ tmux -L zzb3 new-session -d -s 'zz_b3$esc'
    /// $ tmux -L zzb3 list-sessions -F '#{session_name}'
    /// zz_b3\$esc
    /// $ tmux -L zzb3 kill-session -t '=zz_b3\$esc'
    /// exit=0        # und die Session ist weg
    /// ```
    ///
    /// Der gelistete Name traegt die Maskierung, und mit ihr findet `=` die
    /// Session. Diese Zeilen stehen hier, weil der Satz an ihrer Stelle das
    /// Gegenteil behauptet hat -- und dieses Projekt Kommentare als Vertraege
    /// fuehrt.
    pub async fn kill_session(&self, t: &dyn Transport, name: &str) -> anyhow::Result<()> {
        let target = format!("={name}");
        let r = t
            .exec_mutation(&self.reader.query_command(&["kill-session", "-t", &target]))
            .await?;
        // tmux strips the exact-match '=' before reporting a missing session
        // (cmd-find.c). Do not accept an error naming a different session.
        let missing_session = r.code == 1
            && r.stdout.is_empty()
            && r.stderr.trim_end_matches(['\r', '\n']) == format!("can't find session: {name}");
        if r.code == 0 || self.reader.server_absent(&r) || missing_session {
            return Ok(());
        }
        anyhow::bail!(
            "tmux kill-session failed (exit {}): {}",
            r.code,
            r.stderr.trim()
        )
    }

    /// Numeric kill of one bound session. `AB_M1_REJECT` with exit 0 is a
    /// rejected identity, not a successful kill.
    pub async fn kill_session_bound(
        &self,
        t: &dyn Transport,
        server: ServerIdentity,
        session: SessionId,
    ) -> anyhow::Result<()> {
        let query = BindingQuery::new(InventoryQuery::conservatively_guarded_named(
            self.reader.socket.name(),
        )?);
        let line = query.guarded_kill_command(server, session)?;
        let r = t.exec_mutation(&line).await?;
        if r.stdout.trim_end_matches(['\r', '\n']) == "AB_M1_REJECT" {
            anyhow::bail!("the selected session identity was rejected; this is not a kill");
        }
        if r.code == 0 || self.reader.server_absent(&r) {
            return Ok(());
        }
        anyhow::bail!(
            "tmux kill-session failed (exit {}): {}",
            r.code,
            r.stderr.trim()
        )
    }
}

impl TmuxClient {
    /// Die Version des laufenden Servers dieses Sockets (`#{version}`), nicht
    /// die des `tmux` im `PATH`: Den Standard-Socket kann ein anderes tmux
    /// gestartet haben (Spec 2026-10-25 §6.2). `list-sessions` startet keinen
    /// Server (Messung vom 25.10., §1). `Ok(None)` heisst kein Server,
    /// bewiesen wie in [`Self::observe_sessions`], oder ein Server ohne
    /// Session.
    pub async fn server_version(
        &self,
        transport: &dyn Transport,
        deadline: Instant,
    ) -> anyhow::Result<Option<String>> {
        let r = observation_exec(
            transport,
            self.query_command(&["list-sessions", "-F", "#{version}"]),
            deadline,
        )
        .await?;
        if r.code == 0 && r.stderr.is_empty() && r.utf8_valid {
            let mut lines = r.stdout.split_terminator('\n');
            let Some(first) = lines.next() else {
                return Ok(None);
            };
            let plausible = !first.is_empty()
                && first.len() <= 16
                && first
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'));
            if r.stdout.ends_with('\n') && plausible && lines.all(|line| line == first) {
                return Ok(Some(first.to_string()));
            }
            anyhow::bail!("unexpected tmux server version response");
        }
        let installed = observation_exec(transport, self.version_command(), deadline)
            .await
            .ok()
            .and_then(|result| MeasuredVersion::from_response(&result));
        if let Some(installed) = installed {
            if self
                .server_proven_absent(transport, installed, &r, deadline)
                .await?
            {
                return Ok(None);
            }
        }
        anyhow::bail!(
            "tmux list-sessions failed (exit {}): {}",
            r.code,
            r.stderr.trim()
        )
    }

    pub fn version_command(&self) -> String {
        self.query_command(&["-V"])
    }

    pub async fn list_session_names(&self, t: &dyn Transport) -> anyhow::Result<Vec<String>> {
        let r = t
            .exec(&self.query_command(&["list-sessions", "-F", "#{session_name}"]))
            .await?;
        if r.code != 0 {
            let no_sessions = r.code == 1
                && r.stdout.is_empty()
                && r.stderr.trim_end_matches(['\r', '\n']) == "no sessions";
            if self.server_absent(&r) || no_sessions {
                return Ok(Vec::new());
            }
            anyhow::bail!(
                "tmux list-sessions failed (exit {}): {}",
                r.code,
                r.stderr.trim()
            );
        }
        Ok(r.stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }
}

#[cfg(test)]
#[path = "client_observation_tests.rs"]
mod observation_tests;

/// VM-freie Tests ueber einen abgespielten `Transport` -- Muster aus
/// `preflight.rs::run_tests` uebernommen (Review-Befund).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::ExecResult;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Die Tests dieses Moduls pruefen lesende und veraendernde Befehle des
    /// eigenen Sockets; ein `OwnTmuxClient` liest ueber `Deref` wie ein
    /// `TmuxClient`.
    fn own_client(name: &str) -> OwnTmuxClient {
        OwnTmuxClient::new(&OwnSocket::new(name).unwrap())
    }

    /// Nur der Standard-Socket duldet Sitzungsgruppen (Spec 2026-10-25 §6.2).
    #[test]
    fn only_the_default_socket_tolerates_linked_windows() {
        let strict = InventoryQuery::named(MeasuredVersion::V3_6, "sock").unwrap();
        assert_eq!(
            own_client("sock")
                .inventory_query(MeasuredVersion::V3_6)
                .unwrap(),
            strict
        );
        assert_eq!(
            TmuxClient::new(&TmuxSocket::default_named("sock"))
                .inventory_query(MeasuredVersion::V3_6)
                .unwrap(),
            strict.tolerating_linked_windows()
        );
    }

    struct ScriptedTransport {
        responses: Mutex<VecDeque<ExecResult>>,
        calls: Mutex<Vec<String>>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<ExecResult>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                calls: Mutex::new(Vec::new()),
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
            self.calls.lock().unwrap().push(line.to_string());
            Ok(self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("kein Skript-Eintrag mehr -- exec() oefter aufgerufen als erwartet"))
        }
        async fn dispose(&self) {}
    }

    fn ok() -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: String::new(),
            stderr: String::new(),
            code: 0,
        }
    }

    fn created() -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: "C|50|1000|$0|@0|%0|10\n".into(),
            stderr: String::new(),
            code: 0,
        }
    }

    fn failed(stderr: &str) -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: String::new(),
            stderr: stderr.into(),
            code: 1,
        }
    }

    /// Belegt Punkt B aus dem Review: genau dieser Fall blieb
    /// vor der Einfuehrung von `run_checked` unbemerkt -- ein
    /// fehlgeschlagenes Serveroptions-Kommando lief unter `?` (das nur
    /// Transportfehler abfaengt) einfach durch, `prepare_server` gab `Ok(())`
    /// zurueck, obwohl z. B. `history-limit` nie gesetzt wurde.
    #[tokio::test]
    async fn prepare_server_fails_when_a_server_option_command_fails() {
        // start-server ok, aber "set -g history-limit" (zweiter Aufruf)
        // schlaegt fehl.
        let t = ScriptedTransport::new(vec![ok(), failed("history-limit failed"), ok()]);
        let c = own_client("irrelevant");
        let err = c
            .prepare_server(&t, 12345)
            .await
            .expect_err("ein fehlgeschlagenes set -g darf nicht als Erfolg durchgehen");
        assert!(
            err.to_string().contains("history-limit"),
            "Fehlermeldung soll das fehlgeschlagene Kommando benennen: {err}"
        );
        let calls = t.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(
            crate::remote::command::decoded_argv(&calls[2]),
            vec!["tmux", "-L", "irrelevant", "set", "-g", "exit-empty", "on"],
            "failed preparation must restore exit-empty before returning"
        );
    }

    #[tokio::test]
    async fn failed_prepare_cleanup_preserves_the_original_error() {
        let t = ScriptedTransport::new(vec![
            ok(),
            failed("original preparation failure"),
            failed("cleanup failure"),
        ]);
        let error = own_client("sock")
            .prepare_server(&t, 100)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("original preparation failure"));
        assert!(!error.to_string().contains("cleanup failure"));
    }

    #[tokio::test]
    async fn list_sessions_accepts_a_missing_socket_or_a_stopped_server() {
        for message in [
            "no server running on /tmp/tmux-1000/sock\n",
            "error connecting to /tmp/tmux-1000/sock (No such file or directory)\n",
            "no server running on /custom path/tmux-1000/sock\n",
            "no sessions\n",
        ] {
            let t = ScriptedTransport::new(vec![failed(message)]);
            assert!(own_client("sock")
                .list_session_names(&t)
                .await
                .unwrap()
                .is_empty());
            let calls = t.calls.lock().unwrap();
            let argv = crate::remote::command::decoded_argv(&calls[0]);
            assert_eq!(&argv[..4], &["env", "LC_ALL=C", "tmux", "-u"]);
        }
    }

    #[tokio::test]
    async fn list_sessions_preserves_successful_empty_and_populated_snapshots() {
        let mut populated = ok();
        populated.stdout = "dev\nsecond session\n".into();
        let t = ScriptedTransport::new(vec![ok(), populated]);
        let client = own_client("sock");
        assert!(client.list_session_names(&t).await.unwrap().is_empty());
        assert_eq!(
            client.list_session_names(&t).await.unwrap(),
            vec!["dev", "second session"]
        );
    }

    #[tokio::test]
    async fn c_locale_queries_force_utf8_and_preserve_non_ascii_session_names() {
        let name = "Büro_日本語";
        let mut listed = ok();
        listed.stdout = format!("{name}\n");
        let t = ScriptedTransport::new(vec![
            listed,
            failed(&format!("can't find session: {name}\n")),
        ]);
        let client = own_client("sock");
        assert_eq!(client.list_session_names(&t).await.unwrap(), vec![name]);
        client.kill_session(&t, name).await.unwrap();
        let calls = t.calls.lock().unwrap();
        for line in calls.iter() {
            let argv = crate::remote::command::decoded_argv(line);
            assert_eq!(&argv[..4], &["env", "LC_ALL=C", "tmux", "-u"]);
        }
        let kill_argv = crate::remote::command::decoded_argv(&calls[1]);
        assert_eq!(kill_argv.last().unwrap(), &format!("={name}"));
    }

    #[tokio::test]
    async fn stderr_only_failures_are_not_empty_session_lists() {
        for message in [
            "error connecting to /tmp/tmux-1000/sock (Permission denied)\n",
            "env: 'tmux': No such file or directory\n",
            "sh: base64: not found\n",
            "sh: syntax error\n",
            "server exited unexpectedly\n",
            "no server running on /tmp/tmux-1000/other\n",
            "no server running on /tmp/tmux-1000/sock\nadditional error\n",
            "no server running on \n",
            "",
        ] {
            let t = ScriptedTransport::new(vec![failed(message)]);
            assert!(
                own_client("sock").list_session_names(&t).await.is_err(),
                "{message:?}"
            );
        }
    }

    #[tokio::test]
    async fn incomplete_or_unexpected_results_are_not_proof_of_an_absent_server() {
        let mut partial = failed("no server running on /tmp/tmux-1000/sock\n");
        partial.stdout = "dev\n".into();
        let mut wrong_exit = failed("no server running on /tmp/tmux-1000/sock\n");
        wrong_exit.code = 127;
        for result in [partial, wrong_exit] {
            let t = ScriptedTransport::new(vec![result]);
            assert!(own_client("sock").list_session_names(&t).await.is_err());
        }
    }

    #[tokio::test]
    async fn kill_is_idempotent_only_for_the_missing_target_or_server() {
        for message in [
            "can't find session: dev\n",
            "no server running on /tmp/tmux-1000/sock\n",
            "error connecting to /tmp/tmux-1000/sock (No such file or directory)\n",
        ] {
            let t = ScriptedTransport::new(vec![failed(message)]);
            own_client("sock").kill_session(&t, "dev").await.unwrap();
        }
        for message in [
            "can't find session: different\n",
            "can't find session: dev\nadditional error\n",
            "error connecting to /tmp/tmux-1000/sock (Permission denied)\n",
            "sh: tmux: not found\n",
            "server exited unexpectedly\n",
            "",
        ] {
            let t = ScriptedTransport::new(vec![failed(message)]);
            assert!(
                own_client("sock").kill_session(&t, "dev").await.is_err(),
                "{message:?}"
            );
        }
    }

    #[tokio::test]
    async fn prepare_server_succeeds_when_all_four_commands_report_exit_zero() {
        let t = ScriptedTransport::new(vec![ok(), ok(), ok(), ok()]);
        let c = own_client("irrelevant");
        c.prepare_server(&t, 12345).await.unwrap();
        let argv: Vec<Vec<String>> = t
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|line| crate::remote::command::decoded_argv(line))
            .collect();
        let tmux = ["tmux", "-L", "irrelevant"];
        let expected: Vec<Vec<&str>> = [
            &["start-server", ";", "set", "-g", "exit-empty", "off"][..],
            &["set", "-g", "history-limit", "12345"],
            &["setw", "-g", "remain-on-exit", "on"],
            // Spec §6.8: anhaengen statt ersetzen. tmux 3.0/3.1 tragen `Ms`
            // (OSC 52) fuer `xterm*` in der Standardliste; ein `set -g`
            // wuerfe diesen Eintrag weg.
            &["set", "-ga", "terminal-overrides", ",*:smcup@:rmcup@"],
        ]
        .iter()
        .map(|args| tmux.iter().chain(args.iter()).copied().collect())
        .collect();
        assert_eq!(argv, expected);
    }

    /// Globale Randbedingung des Tasks: jede Kommandozeile fuer die
    /// entfernte Shell entsteht ausschliesslich ueber `remote::build`, nie
    /// ueber `format!` auf einen SSH-Befehl. `remote::build` stellt seiner
    /// Ausgabe immer `set -eu;` voran (siehe `remote::command::build`) --
    /// ein struktureller Marker, der nur bei tatsaechlicher Nutzung
    /// auftaucht. Deckt `prepare_server`, `create_session`, `kill_session`
    /// und `list_session_names` in einem Lauf ab.
    #[tokio::test]
    async fn every_emitted_line_is_built_via_remote_build() {
        let t = ScriptedTransport::new(vec![ok(), ok(), ok(), ok(), created(), ok(), ok()]);
        let c = own_client("irrelevant");
        c.prepare_server(&t, 12345).await.unwrap();
        c.create_session(&t, "ab_000000", "/tmp").await.unwrap();
        c.kill_session(&t, "ab_000000").await.unwrap();
        c.list_session_names(&t).await.unwrap();
        let calls = t.calls.lock().unwrap();
        assert_eq!(calls.len(), 7, "4 + 1 + 1 + 1 Aufrufe erwartet");
        for line in calls.iter() {
            assert!(
                line.starts_with("set -eu;"),
                "Zeile stammt nicht aus remote::build: {line}"
            );
        }
    }

    /// Der billige Waechter fuer B0. Bewusst VM-frei und bewusst hier:
    /// `integration_tmux.rs` kehrt ohne gesetztes `AIDEVBRIDGE_TEST_HOST`
    /// still zurueck und ist dann GRUEN, ohne etwas geprueft zu haben -- der
    /// VM-Test allein waere in einem Lauf ohne VM ein leerer Waechter.
    ///
    /// Geprueft wird das dekodierte `argv`, nicht die Zeile: nach
    /// `remote::build` steht der Name nur noch base64-kodiert darin, ein
    /// `assert!(line.contains("=zz_x"))` waere immer falsch.
    /// VM-frei, aus demselben Grund wie der Waechter darunter: der VM-Test
    /// zu `exit-empty` liegt in `integration_commands.rs` und kehrt ohne
    /// `AIDEVBRIDGE_TEST_HOST` STILL zurueck -- er ist dann gruen, ohne
    /// etwas geprueft zu haben (in dieser Runde nachgemessen: 17 Tests
    /// "passed" in 0,07 s). Dieser hier laeuft immer.
    #[tokio::test]
    async fn restore_exit_empty_sets_the_option_back_to_on() {
        let t = ScriptedTransport::new(vec![ok()]);
        let c = own_client("sock");
        c.restore_exit_empty(&t).await.unwrap();
        let calls = t.calls.lock().unwrap();
        assert_eq!(
            crate::remote::command::decoded_argv(&calls[0]),
            vec!["tmux", "-L", "sock", "set", "-g", "exit-empty", "on"],
        );
    }

    #[tokio::test]
    async fn create_session_requires_the_c_record_and_prints_numeric_identity() {
        let t = ScriptedTransport::new(vec![created()]);
        let c = own_client("sock");
        assert_eq!(
            c.create_session(&t, "ab_000000", "/tmp").await.unwrap(),
            CreateOutcome::Created
        );
        let args = crate::remote::command::decoded_argv(&t.calls.lock().unwrap()[0]);
        assert_eq!(
            &args[..8],
            [
                "tmux",
                "-L",
                "sock",
                "new-session",
                "-d",
                "-P",
                "-F",
                "C|#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}",
            ]
        );
        assert_eq!(
            &args[8..],
            [
                "-s",
                "ab_000000",
                "-c",
                "/tmp",
                ";",
                "set",
                "-g",
                "exit-empty",
                "on"
            ]
        );
        let empty = ScriptedTransport::new(vec![ok()]);
        assert!(
            own_client("sock")
                .create_session(&empty, "ab_000000", "/tmp")
                .await
                .is_err(),
            "exit 0 without a C record is an unclear mutation, not Created"
        );
        let dup = ScriptedTransport::new(vec![failed("duplicate session: ab_000000")]);
        assert_eq!(
            own_client("sock")
                .create_session(&dup, "ab_000000", "/tmp")
                .await
                .unwrap(),
            CreateOutcome::DuplicateName
        );
    }

    #[tokio::test]
    async fn kill_session_targets_the_name_exactly_and_not_by_prefix() {
        let t = ScriptedTransport::new(vec![ok()]);
        let c = own_client("sock");
        c.kill_session(&t, "zz_x").await.unwrap();
        let calls = t.calls.lock().unwrap();
        assert_eq!(
            crate::remote::command::decoded_argv(&calls[0]),
            vec![
                "env",
                "LC_ALL=C",
                "tmux",
                "-u",
                "-L",
                "sock",
                "kill-session",
                "-t",
                "=zz_x"
            ],
            "ohne das `=` beendet tmux bei fehlendem `zz_x` die Session `zz_x2` \
             und meldet Erfolg (an der VM gemessen)"
        );
    }
}
