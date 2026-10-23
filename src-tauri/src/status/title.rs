//! Agent status from the terminal title that tmux keeps per pane
//! (`pane_title`), for agents whose title carries their state. Measured on
//! 2026-09-14 (`docs/messungen/messung-2026-09-14-titel.md`): Codex 0.154.0
//! and Grok 1.0.30 on tmux 3.4; Grok's approval title on 2026-09-05 with
//! 1.0.13. On tmux 3.6 the title read returns the same bytes (measured on
//! 2026-10-11 with stand-in panes that set these title shapes, no real agent
//! started: `docs/messungen/messung-2026-10-11-tmux36.md`). Codex measured
//! again on 2026-10-23 with 0.163.0 (tmux 3.6) and 0.164.0 (tmux 3.3a):
//! same shapes (`docs/messungen/messung-2026-10-23-agentversionen.md`). A
//! title counts only while the agent's own program runs below the pane shell;
//! every other title shape is unknown.

use crate::status::StatusKind;
use crate::tmux::inventory::PaneId;
use std::collections::BTreeMap;

/// What one read-only exec saw for one pane.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneDetails {
    /// `None` when tmux gave no title (the pane vanished since the inventory)
    /// or a longer one than `TITLE_MAX_BYTES`.
    pub title: Option<String>,
    /// Executables (`/proc/<pid>/exe`) of the pane shell's children ...
    pub children: Vec<String>,
    /// ... and of their children.
    pub grandchildren: Vec<String>,
    /// What the host's Codex settings let a Codex title say. The same for
    /// every pane of a host.
    pub codex: CodexTitle,
}

/// What Codex's own settings leave of its title, read from the `tui` keys
/// of `/etc/codex/config.toml` and `${CODEX_HOME:-$HOME/.codex}/config.toml`
/// (Codex 0.164.0, `codex-rs/tui/src/chatwidget/status_surfaces.rs`). Not
/// read: project layers, `-c` overrides and the desktop's reduced-motion
/// setting, which also turns the spinner off.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CodexTitle {
    /// Default title items and animations: every measured shape counts.
    #[default]
    Full,
    /// `tui.animations` or `tui.effects.progress` is off. Without a spinner
    /// working and ready look alike; only "Action Required" still counts.
    NoProgress,
    /// `tui.terminal_title` names other items than the default ones.
    CustomTitle,
    /// A settings file too large to read or no valid TOML.
    Unreadable,
}

/// Longest title read, in bytes. tmux keeps whatever a program sets; Codex
/// cuts its parts to at most 48 characters.
const TITLE_MAX_BYTES: usize = 1024;
/// Longest executable path read, in bytes.
const EXE_MAX_BYTES: usize = 4096;
/// Most bytes read of one Codex settings file after the `tui` filter.
const SETTINGS_MAX_BYTES: usize = 16384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedAgent {
    Claude,
    Codex,
    Grok,
    Agy,
    OpenCode,
}

/// Per pane: `T %<pane> <hex>` with the title, then `C` (child) and `G`
/// (grandchild) lines with executables. Only `/proc/<pid>/exe`, never
/// command lines or environments; hex keeps every byte exact. Every value is
/// cut one byte past its limit, so a longer one lacks its final newline and
/// is dropped. Only when a pane runs Codex: one `K <hex>` line per readable
/// Codex settings file, system before user, filtered down to the `tui` keys
/// (top-level `tui...` lines and the `[tui]`/`[tui.*]` tables).
const DETAILS_SCRIPT: &str = r#"sock=$1
shift
codex=
hex() { head -c "$1" | od -An -v -tx1 | tr -d ' \n'; }
prog() {
  exe=$(readlink /proc/"$2"/exe 2>/dev/null) || return 0
  case $exe in */codex | */codex' (deleted)') codex=1 ;; esac
  printf '%s %s %s\n' "$1" "$pane" "$(printf '%s\n' "$exe" | hex 4097)"
}
while [ "$#" -ge 2 ]; do
  pane=$1
  pid=$2
  shift 2
  printf 'T %s %s\n' "$pane" "$(tmux -u -L "$sock" display-message -p -t "$pane" '#{pane_title}' 2>/dev/null | hex 1025)"
  for child in $(cat /proc/"$pid"/task/*/children 2>/dev/null); do
    prog C "$child"
    for grandchild in $(cat /proc/"$child"/task/*/children 2>/dev/null); do
      prog G "$grandchild"
    done
  done
done
if [ -n "$codex" ]; then
  for file in /etc/codex/config.toml "${CODEX_HOME:-$HOME/.codex}/config.toml"; do
    [ -r "$file" ] || continue
    printf 'K %s\n' "$(awk '
      cont { print; if (index($0, "]")) cont = 0; next }
      /^[ \t]*\[/ { hdr = 1; h = $0; gsub(/[ \t]/, "", h); keep = (h ~ /^\[tui[].]/) }
      keep { print; next }
      !hdr && /^[ \t]*tui[ \t]*[.=]/ { print; if (gsub(/\[/, "[") > gsub(/\]/, "]")) cont = 1 }
    ' "$file" | hex 16385)"
  done
fi
exit 0"#;

/// One read-only exec for the given panes (id, pane start process).
pub fn details_command(socket: &str, panes: &[(PaneId, u32)]) -> Option<String> {
    if panes.is_empty() {
        return None;
    }
    let mut argv = vec![
        "sh".to_owned(),
        "-c".to_owned(),
        DETAILS_SCRIPT.to_owned(),
        "aidevbridge-panes".to_owned(),
        socket.to_owned(),
    ];
    for (pane, pid) in panes {
        argv.push(format!("%{}", pane.0));
        argv.push(pid.to_string());
    }
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    Some(crate::remote::build(&argv))
}

fn number(digits: &str) -> Option<u32> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn decode_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// Exactly one value: even hex, UTF-8, at most `max` bytes, one final
/// newline. Anything else is not what the script sent, or longer than read,
/// and is skipped.
fn decode(hex: &str, max: usize) -> Option<String> {
    let bytes = decode_bytes(hex)?;
    if bytes.len() > max + 1 {
        return None;
    }
    String::from_utf8(bytes)
        .ok()?
        .strip_suffix('\n')
        .map(str::to_owned)
}

const DEFAULT_TERMINAL_TITLE: [&str; 3] = ["activity", "thread-name", "project-name"];

/// The settings files in precedence order, each as the script sent it. A
/// later file overrides an earlier one key by key, as in Codex.
fn codex_title(layers: &[Option<Vec<u8>>]) -> CodexTitle {
    let mut animations = true;
    let mut effects_progress = true;
    let mut items: Option<Vec<String>> = None;
    for layer in layers {
        let Some(text) = layer
            .as_deref()
            .filter(|bytes| bytes.len() <= SETTINGS_MAX_BYTES)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
        else {
            return CodexTitle::Unreadable;
        };
        let Ok(table) = text.parse::<toml::Table>() else {
            return CodexTitle::Unreadable;
        };
        let Some(tui) = table.get("tui") else {
            continue;
        };
        let Some(tui) = tui.as_table() else {
            return CodexTitle::Unreadable;
        };
        // Codex rejects a wrong type itself; what it would run with instead
        // is not known here.
        let progress = match tui.get("effects") {
            None => None,
            Some(effects) => match effects.as_table() {
                Some(effects) => effects.get("progress"),
                None => return CodexTitle::Unreadable,
            },
        };
        for (value, setting) in [
            (tui.get("animations"), &mut animations),
            (progress, &mut effects_progress),
        ] {
            match value.map(toml::Value::as_bool) {
                None => {}
                Some(Some(on)) => *setting = on,
                Some(None) => return CodexTitle::Unreadable,
            }
        }
        if let Some(value) = tui.get("terminal_title") {
            let Some(list) = value.as_array().and_then(|list| {
                list.iter()
                    .map(|item| item.as_str().map(str::to_owned))
                    .collect::<Option<Vec<String>>>()
            }) else {
                return CodexTitle::Unreadable;
            };
            items = Some(list);
        }
    }
    // "spinner" is Codex's other name for "activity".
    let custom = items.is_some_and(|items| {
        !items
            .iter()
            .map(|item| if item == "spinner" { "activity" } else { item })
            .eq(DEFAULT_TERMINAL_TITLE)
    });
    if custom {
        CodexTitle::CustomTitle
    } else if animations && effects_progress {
        CodexTitle::Full
    } else {
        CodexTitle::NoProgress
    }
}

pub fn parse_details(stdout: &str) -> BTreeMap<PaneId, PaneDetails> {
    let mut details: BTreeMap<PaneId, PaneDetails> = BTreeMap::new();
    let mut layers = Vec::new();
    for line in stdout.lines() {
        if let Some(hex) = line.strip_prefix("K ") {
            layers.push(decode_bytes(hex));
            continue;
        }
        let mut parts = line.splitn(3, ' ');
        let (Some(kind), Some(pane), Some(hex)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let Some(pane) = pane.strip_prefix('%').and_then(number).map(PaneId) else {
            continue;
        };
        match kind {
            // No title at all is an answer too; a garbled one is not.
            "T" if hex.is_empty() => {
                details.entry(pane).or_default();
            }
            "T" => {
                if let Some(title) = decode(hex, TITLE_MAX_BYTES) {
                    details.entry(pane).or_default().title = Some(title);
                }
            }
            "C" | "G" => {
                if let Some(exe) = decode(hex, EXE_MAX_BYTES) {
                    let entry = details.entry(pane).or_default();
                    if kind == "C" {
                        entry.children.push(exe);
                    } else {
                        entry.grandchildren.push(exe);
                    }
                }
            }
            _ => {}
        }
    }
    let codex = codex_title(&layers);
    for entry in details.values_mut() {
        entry.codex = codex;
    }
    details
}

/// The agent an executable is, by its file name. The kernel keeps the
/// resolved path the program started from; unlike its name (`comm`), a
/// process cannot change it, and it is not cut to 15 bytes. Measured on
/// 2026-10-23: Claude
/// Code's installer runs `~/.local/share/claude/versions/<version>`, npm's
/// Codex `…/@openai/codex-linux-x64/vendor/<target>/bin/codex` below `node`.
fn agent_named(exe: &str) -> Option<DetectedAgent> {
    // A program replaced while it runs (an update) reads "<path> (deleted)".
    let exe = exe.strip_suffix(" (deleted)").unwrap_or(exe);
    let (dir, name) = exe.rsplit_once('/')?;
    match name {
        "claude" => Some(DetectedAgent::Claude),
        "codex" => Some(DetectedAgent::Codex),
        "grok" => Some(DetectedAgent::Grok),
        "agy" => Some(DetectedAgent::Agy),
        "opencode" => Some(DetectedAgent::OpenCode),
        _ if dir.ends_with("/claude/versions") => Some(DetectedAgent::Claude),
        _ => None,
    }
}

/// The agent is started by hand in the pane shell, so it is a child. Only a
/// child that no known agent is (Codex's npm launcher `node`) lets the
/// grandchildren decide. Two different agents on one level are no answer.
pub fn detect(details: &PaneDetails) -> Option<DetectedAgent> {
    for level in [&details.children, &details.grandchildren] {
        let mut found = level.iter().filter_map(|name| agent_named(name));
        if let Some(first) = found.next() {
            return found.all(|other| other == first).then_some(first);
        }
    }
    None
}

fn is_spinner(c: char) -> bool {
    ('\u{2800}'..='\u{28FF}').contains(&c)
}

/// The rest after a braille spinner frame and `separator`.
fn after_spinner<'a>(title: &'a str, separator: &str) -> Option<&'a str> {
    let mut chars = title.chars();
    is_spinner(chars.next()?)
        .then(|| chars.as_str().strip_prefix(separator))
        .flatten()
}

/// `[ ! ] Action Required | …` (blinking `!`/`.`), `<spinner> <thread> |
/// <project>` and `<thread> | <project>`.
fn codex(title: &str) -> Option<(StatusKind, &'static str)> {
    if title.starts_with("[ ! ] Action Required") || title.starts_with("[ . ] Action Required") {
        return Some((StatusKind::Waiting, "action required (Codex title)"));
    }
    if after_spinner(title, " ").is_some() {
        return Some((StatusKind::Busy, "working (Codex title)"));
    }
    // A bare name is also what tmux (the host name) or a shell sets; only
    // Codex's own "<thread> | <project>" shape shows it ready. A title that
    // asks for anything, or carries the unmeasured microphone mark "●"
    // (0.164.0) in front of any shape, is never ready.
    let plain = !title.starts_with(['[', '●'])
        && !title.starts_with(is_spinner)
        && !title.contains("Action Required");
    (plain && title.contains(" | ")).then_some((StatusKind::Idle, "ready (Codex title)"))
}

/// `⚠ Action Required - <spinner> - …` for an approval (measured on
/// 2026-09-05 with 1.0.13), `<spinner> - <activity> - <title> - grok` while
/// working, `<title> - grok` when ready.
fn grok(title: &str) -> Option<(StatusKind, &'static str)> {
    let body = title.strip_suffix(" - grok")?;
    if body.starts_with("⚠ Action Required - ") {
        return Some((StatusKind::Waiting, "approval required (Grok title)"));
    }
    let Some(activity) = after_spinner(body, " - ") else {
        // A title that asks for anything is never ready.
        let plain = !body.is_empty()
            && !body.starts_with(is_spinner)
            && !body.starts_with('⚠')
            && !body.contains("Action Required");
        return plain.then_some((StatusKind::Idle, "ready (Grok title)"));
    };
    if activity.starts_with("Running: Ask: ") {
        return Some((StatusKind::Waiting, "question open (Grok title)"));
    }
    [
        "Thinking - ",
        "Responding - ",
        "Waiting for response… - ",
        "Running: ",
    ]
    .iter()
    .any(|measured| activity.starts_with(measured))
    .then_some((StatusKind::Busy, "working (Grok title)"))
}

/// The status a measured title shape stands for; `None` for any other shape
/// and for agents whose title carries no status.
pub fn classify(agent: DetectedAgent, title: &str) -> Option<(StatusKind, &'static str)> {
    match agent {
        DetectedAgent::Codex => codex(title),
        DetectedAgent::Grok => grok(title),
        DetectedAgent::Claude | DetectedAgent::Agy | DetectedAgent::OpenCode => None,
    }
}

/// A pane's title status, or `None` when the pane has no title source: no
/// known agent runs below its shell, or it runs Claude, whose source is its
/// CLI.
pub fn pane_status(details: &PaneDetails) -> Option<(StatusKind, &'static str)> {
    let agent = detect(details)?;
    let title = details.title.as_deref().unwrap_or("");
    let unrecognized = match agent {
        DetectedAgent::Claude => return None,
        DetectedAgent::Agy => {
            return Some((StatusKind::Unknown, "agy shows no status in its title"))
        }
        DetectedAgent::OpenCode => {
            return Some((StatusKind::Unknown, "OpenCode shows no status in its title"))
        }
        DetectedAgent::Codex => match details.codex {
            CodexTitle::Full => "the Codex title shows no known status",
            CodexTitle::NoProgress => {
                // Only "Action Required" survives without a spinner.
                let waiting =
                    classify(agent, title).filter(|(kind, _)| *kind == StatusKind::Waiting);
                return Some(waiting.unwrap_or((
                    StatusKind::Unknown,
                    "Codex shows no progress in its title (tui.animations or tui.effects.progress is off)",
                )));
            }
            CodexTitle::CustomTitle => {
                return Some((
                    StatusKind::Unknown,
                    "Codex shows its own terminal title (tui.terminal_title)",
                ))
            }
            CodexTitle::Unreadable => {
                return Some((StatusKind::Unknown, "the Codex settings could not be read"))
            }
        },
        DetectedAgent::Grok => "the Grok title shows no known status",
    };
    Some(classify(agent, title).unwrap_or((StatusKind::Unknown, unrecognized)))
}

/// One output line as the remote script prints it: the value plus the
/// newline `display-message -p` and `readlink` end with, hex-encoded.
#[cfg(test)]
pub fn details_line(kind: char, pane: u32, text: &str) -> String {
    let hex: String = text.bytes().map(|b| format!("{b:02x}")).collect();
    format!("{kind} %{pane} {hex}0a\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Executables as measured on 2026-10-23; Grok's and agy's as installed
    // on the test hosts, OpenCode's an assumed install path.
    const NODE: &str = "/usr/bin/node";
    const CODEX: &str = "/home/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
    const CLAUDE: &str = "/home/u/.local/share/claude/versions/2.1.309";
    const GROK: &str = "/home/u/.grok/bin/grok";
    const AGY: &str = "/home/u/.local/bin/agy";
    const OPENCODE: &str = "/home/u/.opencode/bin/opencode";
    const BASH: &str = "/usr/bin/bash";

    fn tree(title: Option<&str>, children: &[&str], grandchildren: &[&str]) -> PaneDetails {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect();
        PaneDetails {
            title: title.map(str::to_owned),
            children: names(children),
            grandchildren: names(grandchildren),
            codex: CodexTitle::Full,
        }
    }

    fn settings_line(toml: &str) -> String {
        let hex: String = toml.bytes().map(|b| format!("{b:02x}")).collect();
        format!("K {hex}\n")
    }

    #[test]
    fn details_decode_titles_and_programs_per_pane() {
        let stdout = [
            details_line('T', 5, "[ ! ] Action Required | thread | home"),
            details_line('C', 5, NODE),
            details_line('G', 5, CODEX),
            details_line('T', 4, "⠸ - Thinking - chat - grok"),
            details_line('C', 4, GROK),
            details_line('G', 4, NODE),
        ]
        .concat();
        let details = parse_details(&stdout);
        assert_eq!(
            details[&PaneId(5)],
            tree(
                Some("[ ! ] Action Required | thread | home"),
                &[NODE],
                &[CODEX]
            )
        );
        assert_eq!(
            details[&PaneId(4)],
            tree(Some("⠸ - Thinking - chat - grok"), &[GROK], &[NODE])
        );
    }

    #[test]
    fn details_skip_what_they_cannot_decode_exactly() {
        // %1: tmux gave no title (the pane vanished since the inventory).
        // %2 odd hex, %3 not hex, %4 unknown kind, "5" no pane id, %6 not
        // UTF-8, %7 no final newline, %8 an empty program line.
        let stdout = "T %1 \nT %2 0\nT %3 zz\nX %4 780a\nT 5 780a\nT %6 ff0a\nT %7 78\nC %8 \n";
        let details = parse_details(stdout);
        assert_eq!(details.keys().copied().collect::<Vec<_>>(), vec![PaneId(1)]);
        assert_eq!(details[&PaneId(1)], tree(None, &[], &[]));
    }

    #[test]
    fn a_longer_title_or_path_than_read_is_dropped() {
        // The script cuts each value one byte past its limit, so a longer
        // one arrives without its final newline.
        let fits = "x".repeat(TITLE_MAX_BYTES);
        let cut = &"y".repeat(TITLE_MAX_BYTES + 5)[..TITLE_MAX_BYTES + 1];
        let hex = |s: &str| s.bytes().map(|b| format!("{b:02x}")).collect::<String>();
        let stdout = [
            details_line('T', 1, &fits),
            format!("T %2 {}\n", hex(cut)),
            details_line('C', 2, &format!("/{}", "z".repeat(EXE_MAX_BYTES - 1))),
            format!("C %3 {}\n", hex(&format!("/{}", "z".repeat(EXE_MAX_BYTES)))),
            details_line('T', 4, &"w".repeat(TITLE_MAX_BYTES + 1)),
        ]
        .concat();
        let details = parse_details(&stdout);
        assert_eq!(details[&PaneId(1)].title.as_deref(), Some(fits.as_str()));
        assert_eq!(details[&PaneId(2)].title, None);
        assert_eq!(details[&PaneId(2)].children.len(), 1);
        assert!(!details.contains_key(&PaneId(3)));
        // More than the script ever sends: not what it sent.
        assert!(!details.contains_key(&PaneId(4)));
    }

    #[test]
    fn the_agent_is_the_one_known_program_below_the_pane_shell() {
        let d = |children: &[&str], grandchildren: &[&str]| {
            detect(&tree(None, children, grandchildren))
        };
        // Measured process trees (2026-10-23): Codex's npm launcher is
        // `node` with `codex` below it; Claude runs its versioned binary.
        assert_eq!(d(&[NODE], &[CODEX]), Some(DetectedAgent::Codex));
        assert_eq!(d(&[GROK], &[NODE, NODE]), Some(DetectedAgent::Grok));
        assert_eq!(d(&[CLAUDE], &[NODE, BASH]), Some(DetectedAgent::Claude));
        assert_eq!(d(&[AGY], &[]), Some(DetectedAgent::Agy));
        assert_eq!(d(&[OPENCODE], &[]), Some(DetectedAgent::OpenCode));
        // The hand-started agent is the child; what it runs does not speak
        // for the pane.
        assert_eq!(d(&[GROK], &[CODEX]), Some(DetectedAgent::Grok));
        assert_eq!(d(&[NODE], &[]), None);
        assert_eq!(d(&[], &[]), None);
        assert_eq!(d(&[CODEX, GROK], &[]), None);
        assert_eq!(d(&[BASH], &[CODEX, GROK]), None);
    }

    #[test]
    fn the_executable_names_the_agent() {
        let a = |exe: &str| agent_named(exe);
        assert_eq!(a(CODEX), Some(DetectedAgent::Codex));
        assert_eq!(a(CLAUDE), Some(DetectedAgent::Claude));
        assert_eq!(a("/home/u/.local/bin/claude"), Some(DetectedAgent::Claude));
        // Measured during Codex's self-update: npm moves the package aside.
        assert_eq!(
            a("/home/u/.npm-global/lib/node_modules/@openai/.codex-ywMJpJyc/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"),
            Some(DetectedAgent::Codex)
        );
        assert_eq!(a(&format!("{CODEX} (deleted)")), Some(DetectedAgent::Codex));
        // Only the file name counts, never a directory on the way.
        assert_eq!(a("/home/u/codex/bin/node"), None);
        assert_eq!(a("/opt/claude/versions"), None);
        assert_eq!(a("/usr/bin/codex-x86_64-unknown-linux-musl"), None);
        // `comm` was a bare name; a path is all `/proc/<pid>/exe` gives.
        assert_eq!(a("codex"), None);
        assert_eq!(a(""), None);
    }

    // Measured titles, with the user's own thread and question text replaced.
    #[test]
    fn codex_titles_as_measured() {
        let c = |t: &str| classify(DetectedAgent::Codex, t).map(|(kind, _)| kind);
        assert_eq!(
            c("[ ! ] Action Required | thread | home"),
            Some(StatusKind::Waiting)
        );
        assert_eq!(
            c("[ . ] Action Required | thread | home"),
            Some(StatusKind::Waiting)
        );
        assert_eq!(
            c("[ ! ] Action Required | renaming... ⠼ | home"),
            Some(StatusKind::Waiting)
        );
        assert_eq!(c("⠸ thread | home"), Some(StatusKind::Busy));
        assert_eq!(c("⠸ renaming... ⠸ | home"), Some(StatusKind::Busy));
        assert_eq!(c("⠹ home"), Some(StatusKind::Busy));
        assert_eq!(c("thread | home"), Some(StatusKind::Idle));
        // 0.163.0 on 2026-10-23, while the thread got its name.
        assert_eq!(c("⠏ ⠏ | tmp"), Some(StatusKind::Busy));
        assert_eq!(c("⠏ | tmp"), Some(StatusKind::Busy));
        // With the microphone on, Codex puts "●" first: not measured.
        assert_eq!(c("● [ ! ] Action Required | thread | home"), None);
        assert_eq!(c("● ⠸ thread | home"), None);
        // A bare name is also what tmux (the host name) or a shell sets:
        // no evidence of Codex being ready.
        assert_eq!(c("home"), None);
        assert_eq!(c(""), None);
        assert_eq!(c("[ ? ] Something new | home"), None);
        assert_eq!(c("⠸| home"), None);
    }

    #[test]
    fn grok_titles_as_measured() {
        let g = |t: &str| classify(DetectedAgent::Grok, t).map(|(kind, _)| kind);
        assert_eq!(
            g("⠸ - Running: Ask: question… - chat - grok"),
            Some(StatusKind::Waiting)
        );
        // "Waiting for response" is Grok waiting for its model: working.
        assert_eq!(
            g("⠸ - Waiting for response… - chat - grok"),
            Some(StatusKind::Busy)
        );
        assert_eq!(g("⠴ - Thinking - chat - grok"), Some(StatusKind::Busy));
        assert_eq!(g("⠧ - Responding - chat - grok"), Some(StatusKind::Busy));
        assert_eq!(
            g("⠙ - Running: Bash: ls - chat - grok"),
            Some(StatusKind::Busy)
        );
        assert_eq!(g("chat - grok"), Some(StatusKind::Idle));
        // Approval, measured 2026-09-05 with Grok 1.0.13; 1.0.30 still carries
        // the text. "Action Required" in any other shape is unknown, never
        // ready.
        assert_eq!(
            g("⚠ Action Required - ⠧ - step… - chat - grok"),
            Some(StatusKind::Waiting)
        );
        assert_eq!(
            g("⚠ Action Required - ⠹ - step… - chat - grok"),
            Some(StatusKind::Waiting)
        );
        assert_eq!(g("⚠ something else - chat - grok"), None);
        assert_eq!(g("Action Required - chat - grok"), None);
        assert_eq!(g("⠸ - Compacting - chat - grok"), None);
        assert_eq!(g("test-vm"), None);
        assert_eq!(g("grok"), None);
        assert_eq!(g("⠸ unexpected - grok"), None);
    }

    #[test]
    fn agents_without_a_title_signal_classify_as_nothing() {
        for agent in [
            DetectedAgent::Agy,
            DetectedAgent::OpenCode,
            DetectedAgent::Claude,
        ] {
            assert_eq!(classify(agent, "[ ! ] Action Required | x | y"), None);
        }
    }

    #[test]
    fn the_pane_status_names_its_title_source() {
        let s = |title: Option<&str>, children: &[&str], grandchildren: &[&str]| {
            pane_status(&tree(title, children, grandchildren))
        };
        assert_eq!(
            s(
                Some("[ ! ] Action Required | thread | home"),
                &[NODE],
                &[CODEX]
            ),
            Some((StatusKind::Waiting, "action required (Codex title)"))
        );
        assert_eq!(
            s(Some("⠴ - Thinking - chat - grok"), &[GROK], &[NODE]),
            Some((StatusKind::Busy, "working (Grok title)"))
        );
        assert_eq!(
            s(Some("chat - grok"), &[GROK], &[]),
            Some((StatusKind::Idle, "ready (Grok title)"))
        );
        assert_eq!(
            s(
                Some("⚠ Action Required - ⠧ - step… - chat - grok"),
                &[GROK],
                &[]
            ),
            Some((StatusKind::Waiting, "approval required (Grok title)"))
        );
        assert_eq!(
            s(Some("home"), &[NODE], &[CODEX]),
            Some((StatusKind::Unknown, "the Codex title shows no known status"))
        );
        assert_eq!(
            s(None, &[GROK], &[]),
            Some((StatusKind::Unknown, "the Grok title shows no known status"))
        );
        assert_eq!(
            s(Some("test-vm"), &[AGY], &[]),
            Some((StatusKind::Unknown, "agy shows no status in its title"))
        );
        assert_eq!(
            s(Some("OpenCode"), &[OPENCODE], &[]),
            Some((StatusKind::Unknown, "OpenCode shows no status in its title"))
        );
        // Claude's source is its CLI; after an agent exits, its last title
        // no longer counts.
        assert_eq!(s(Some("✳ thing"), &[CLAUDE], &[NODE]), None);
        assert_eq!(s(Some("thread | home"), &[], &[]), None);
    }

    #[test]
    fn codex_settings_limit_what_its_title_says() {
        let s = |codex: CodexTitle, title: &str| {
            pane_status(&PaneDetails {
                codex,
                ..tree(Some(title), &[NODE], &[CODEX])
            })
        };
        let waiting = "[ ! ] Action Required | thread | home";
        let no_progress = (
            StatusKind::Unknown,
            "Codex shows no progress in its title (tui.animations or tui.effects.progress is off)",
        );
        // Without a spinner a working Codex shows its ready shape.
        assert_eq!(
            s(CodexTitle::NoProgress, "thread | home"),
            Some(no_progress)
        );
        assert_eq!(s(CodexTitle::NoProgress, "home"), Some(no_progress));
        assert_eq!(
            s(CodexTitle::NoProgress, waiting),
            Some((StatusKind::Waiting, "action required (Codex title)"))
        );
        for title in [waiting, "⠸ thread | home", "thread | home"] {
            assert_eq!(
                s(CodexTitle::CustomTitle, title),
                Some((
                    StatusKind::Unknown,
                    "Codex shows its own terminal title (tui.terminal_title)"
                ))
            );
            assert_eq!(
                s(CodexTitle::Unreadable, title),
                Some((StatusKind::Unknown, "the Codex settings could not be read"))
            );
        }
        // The settings speak only for Codex.
        assert_eq!(
            pane_status(&PaneDetails {
                codex: CodexTitle::Unreadable,
                ..tree(Some("chat - grok"), &[GROK], &[])
            }),
            Some((StatusKind::Idle, "ready (Grok title)"))
        );
    }

    #[test]
    fn codex_settings_come_from_the_tui_keys_with_the_later_file_winning() {
        let c = |files: &[&str]| {
            codex_title(
                &files
                    .iter()
                    .map(|f| Some(f.as_bytes().to_vec()))
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(c(&[]), CodexTitle::Full);
        assert_eq!(c(&[""]), CodexTitle::Full);
        // What the test hosts carry: nothing that touches the title.
        assert_eq!(
            c(&["[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\ngpt-6-astra = 4\n"]),
            CodexTitle::Full
        );
        assert_eq!(c(&["[tui]\nanimations = false\n"]), CodexTitle::NoProgress);
        assert_eq!(c(&["tui.animations = false\n"]), CodexTitle::NoProgress);
        assert_eq!(
            c(&["tui = { animations = false }\n"]),
            CodexTitle::NoProgress
        );
        assert_eq!(
            c(&["[tui.effects]\nprogress = false\n"]),
            CodexTitle::NoProgress
        );
        // Blinking "Action Required" off leaves every shape.
        assert_eq!(c(&["[tui.effects]\ntitle = false\n"]), CodexTitle::Full);
        // The user file overrides the system file key by key.
        assert_eq!(
            c(&["[tui]\nanimations = false\n", "[tui]\nanimations = true\n"]),
            CodexTitle::Full
        );
        assert_eq!(
            c(&[
                "[tui.effects]\nprogress = false\n",
                "[tui]\nanimations = true\n"
            ]),
            CodexTitle::NoProgress
        );
        assert_eq!(
            c(&["[tui]\nterminal_title = [\"activity\", \"thread-name\", \"project-name\"]\n"]),
            CodexTitle::Full
        );
        assert_eq!(
            c(&["[tui]\nterminal_title = [\n  \"spinner\",\n  \"thread-name\",\n  \"project-name\",\n]\n"]),
            CodexTitle::Full
        );
        assert_eq!(
            c(&["[tui]\nterminal_title = [\"project-name\", \"activity\"]\n"]),
            CodexTitle::CustomTitle
        );
        assert_eq!(
            c(&["[tui]\nterminal_title = []\n"]),
            CodexTitle::CustomTitle
        );
        assert_eq!(
            c(&["[tui]\nterminal_title = [\"activity\"]\nanimations = false\n"]),
            CodexTitle::CustomTitle
        );
        // What Codex itself would reject, or a file cut short.
        assert_eq!(c(&["[tui]\nanimations = \"no\"\n"]), CodexTitle::Unreadable);
        assert_eq!(
            c(&["[tui]\nterminal_title = \"activity\"\n"]),
            CodexTitle::Unreadable
        );
        assert_eq!(c(&["tui = 1\n"]), CodexTitle::Unreadable);
        assert_eq!(c(&["[tui]\nterminal_title = [\n"]), CodexTitle::Unreadable);
        assert_eq!(
            codex_title(&[Some(vec![b'#'; SETTINGS_MAX_BYTES + 1])]),
            CodexTitle::Unreadable
        );
        assert_eq!(codex_title(&[None]), CodexTitle::Unreadable);
    }

    #[test]
    fn the_settings_lines_apply_to_every_pane_of_the_host() {
        let stdout = [
            details_line('T', 1, "thread | home"),
            details_line('C', 1, NODE),
            details_line('G', 1, CODEX),
            details_line('T', 2, "chat - grok"),
            details_line('C', 2, GROK),
            settings_line("[tui]\nanimations = false\n"),
        ]
        .concat();
        let details = parse_details(&stdout);
        assert!(details.values().all(|d| d.codex == CodexTitle::NoProgress));
        // Without settings lines Codex runs with its defaults.
        let plain = parse_details(&details_line('T', 1, "thread | home"));
        assert_eq!(plain[&PaneId(1)].codex, CodexTitle::Full);
        // A garbled settings line is no file Codex could read either.
        let garbled = parse_details(&[details_line('T', 1, "x"), "K 0\n".into()].concat());
        assert_eq!(garbled[&PaneId(1)].codex, CodexTitle::Unreadable);
    }

    #[test]
    fn details_command_reads_titles_and_program_names_only() {
        let command =
            details_command("agentbridge", &[(PaneId(5), 1054885), (PaneId(4), 1051105)]).unwrap();
        let args = crate::remote::command::decoded_argv(&command);
        assert_eq!(&args[..2], ["sh", "-c"]);
        assert_eq!(
            &args[3..],
            [
                "aidevbridge-panes",
                "agentbridge",
                "%5",
                "1054885",
                "%4",
                "1051105"
            ]
        );
        let script = &args[2];
        // The socket is an argument, never part of the script text.
        assert!(!script.contains("agentbridge"));
        assert!(script.contains("-L \"$sock\" display-message -p -t \"$pane\" '#{pane_title}'"));
        assert!(script.contains("/children"));
        assert!(script.contains("readlink /proc/\"$2\"/exe"));
        assert!(!script.contains("/comm"));
        assert!(!script.contains("cmdline"));
        assert!(!script.contains("environ"));
        // Each value is cut one byte past the limit the parser accepts.
        assert!(script.contains(&format!(
            "'#{{pane_title}}' 2>/dev/null | hex {}",
            TITLE_MAX_BYTES + 1
        )));
        assert!(script.contains(&format!("\"$exe\" | hex {}", EXE_MAX_BYTES + 1)));
        assert!(script.contains(&format!("\"$file\" | hex {}", SETTINGS_MAX_BYTES + 1)));
        // Codex's settings only below a Codex pane, and only their tui keys.
        assert!(script.contains("if [ -n \"$codex\" ]; then"));
        assert!(
            script.contains("/etc/codex/config.toml \"${CODEX_HOME:-$HOME/.codex}/config.toml\"")
        );
        assert!(details_command("agentbridge", &[]).is_none());
    }
}
