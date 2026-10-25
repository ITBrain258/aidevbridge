//! Welche tmux-Sockets die App anspricht (Spec 2026-10-25 §2, §6.1).
//!
//! Der eigene Socket (`agentbridge`) gehoert der App: Nur dort setzt sie
//! Serveroptionen, legt Sessions an und beendet sie. Den Standard-Socket des
//! Nutzers liest sie nur und haengt dort nur ueber den geprueften Waechter an.
//! Die Trennung steht im Typ: Was einen Server veraendert, nimmt einen
//! [`OwnSocket`], und den gibt es fuer den Namen `default` nicht.

/// Der Name von tmux' Standard-Socket. `-L default` ist derselbe Pfad wie ein
/// Aufruf ohne `-L`, faellt aber nicht auf `$TMUX` zurueck (Spec §6.1).
pub const DEFAULT_SOCKET_NAME: &str = "default";

/// Art eines Sockets, als Kennung in Schluesseln und an der IPC-Grenze.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SocketKind {
    /// Der eigene Socket der App.
    App,
    /// tmux' Standard-Socket des Nutzers.
    Default,
}

impl SocketKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Default => "default",
        }
    }
}

/// Der eigene Socket der App. Nur er darf an Befehle, die einen Server
/// veraendern (Optionen, Anlegen, Beenden, `set -g status off`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnSocket(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the app's own tmux socket must have a name other than '{DEFAULT_SOCKET_NAME}'")]
pub struct NotAnOwnSocket;

impl OwnSocket {
    /// Lehnt einen leeren Namen und den des Standard-Sockets ab: Auf den
    /// Server des Nutzers darf kein veraendernder Befehl gelangen, auch nicht
    /// ueber eine Einstellung oder eine Testumgebung.
    pub fn new(name: impl Into<String>) -> Result<Self, NotAnOwnSocket> {
        let name = name.into();
        if name.is_empty() || name.eq_ignore_ascii_case(DEFAULT_SOCKET_NAME) {
            return Err(NotAnOwnSocket);
        }
        Ok(Self(name))
    }

    pub fn name(&self) -> &str {
        &self.0
    }

    /// `-L <name>` fuer eine tmux-Befehlszeile.
    pub fn args(&self) -> [&str; 2] {
        ["-L", &self.0]
    }
}

/// Ein Socket, den die App liest: der eigene oder der Standard-Socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxSocket {
    name: String,
    kind: SocketKind,
}

impl TmuxSocket {
    pub fn own(socket: &OwnSocket) -> Self {
        Self {
            name: socket.name().to_string(),
            kind: SocketKind::App,
        }
    }

    /// Der Standard-Socket unter `name`: im Produkt immer
    /// [`DEFAULT_SOCKET_NAME`], in Tests ein Testsocket, damit kein
    /// automatischer Test den echten Standard-Socket beruehrt (Spec §6.1).
    /// Die Regeln haengen an der Art, nicht am Namen.
    pub fn default_named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: SocketKind::Default,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn kind(&self) -> SocketKind {
        self.kind
    }

    /// `-L <name>`, fuer beide Arten gleich: `-L default` statt eines
    /// Aufrufs ohne `-L` (Spec §6.1).
    pub fn args(&self) -> [&str; 2] {
        ["-L", &self.name]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_socket_can_never_be_an_own_socket() {
        for name in ["default", "DEFAULT", "Default", ""] {
            assert_eq!(OwnSocket::new(name), Err(NotAnOwnSocket), "{name:?}");
        }
        assert_eq!(OwnSocket::new("agentbridge").unwrap().name(), "agentbridge");
    }

    #[test]
    fn a_read_socket_keeps_its_name_and_kind() {
        let own = TmuxSocket::own(&OwnSocket::new("agentbridge").unwrap());
        assert_eq!((own.name(), own.kind()), ("agentbridge", SocketKind::App));
        let default = TmuxSocket::default_named(DEFAULT_SOCKET_NAME);
        assert_eq!(
            (default.name(), default.kind()),
            ("default", SocketKind::Default)
        );
        let redirected = TmuxSocket::default_named("abtest_default");
        assert_eq!(redirected.kind(), SocketKind::Default);
        assert_eq!(default.args(), ["-L", "default"]);
        assert_eq!(own.args(), ["-L", "agentbridge"]);
    }

    #[test]
    fn the_kind_crosses_the_ipc_border_as_app_or_default() {
        assert_eq!(serde_json::to_string(&SocketKind::App).unwrap(), "\"app\"");
        assert_eq!(
            serde_json::to_string(&SocketKind::Default).unwrap(),
            "\"default\""
        );
        assert_eq!(SocketKind::Default.as_str(), "default");
    }
}
