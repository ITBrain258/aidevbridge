pub mod attach_confirmation;
pub mod client;
pub mod history;
pub mod inventory;
pub mod names;
pub mod session_binding;

pub use client::{CreateOutcome, ServerAbsent, TmuxClient};
pub use names::{new_session_name, session_name_is_acceptable, SESSION_NAME_RULE};

/// Steht im selben tmux-Aufruf vor jedem Anhaengen: schaltet die
/// Statuszeile auf dem App-Socket aus. Sessionname, Host und Status zeigt der
/// Kachelkopf; tmux' eigene Zeile kostete jede Kachel eine Zeile und kuerzte
/// den Namen auf zehn Zeichen. `-g` ist die globale Sessionoption: Sie gilt
/// sofort fuer jede Session des Sockets ohne eigene Einstellung, auch fuer
/// einen Client, der per Hand anhaengt. `;` ist tmux' Kommandotrenner als
/// eigenes argv-Element wie in `prepare_server`.
pub const HIDE_STATUS: [&str; 5] = ["set", "-g", "status", "off", ";"];
