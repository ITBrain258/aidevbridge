//! Agent status from the terminal title that tmux keeps per pane
//! (`pane_title`), for agents whose title carries their state. Measured on
//! 2026-09-14 (`docs/messungen/messung-2026-09-14-titel.md`): Codex 0.154.0
//! and Grok 1.0.30 on tmux 3.4; Grok's approval title on 2026-09-05 with
//! 1.0.13. On tmux 3.6 the title read returns the same bytes (measured on
//! 2026-10-11 with stand-in panes that set these title shapes, no real agent
//! started: `docs/messungen/messung-2026-10-11-tmux36.md`). A title counts only
//! while the agent's own process runs below the pane shell; every other title
//! shape is unknown.

use crate::status::StatusKind;
use crate::tmux::inventory::PaneId;
use std::collections::BTreeMap;

/// What one read-only exec saw for one pane.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneDetails {
    /// `None` when tmux gave no title (the pane vanished since the inventory).
    pub title: Option<String>,
    /// Program names (`/proc/<pid>/comm`) of the pane shell's children ...
    pub children: Vec<String>,
    /// ... and of their children.
    pub grandchildren: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedAgent {
    Claude,
    Codex,
    Grok,
    Agy,
    OpenCode,
}

/// Per pane: `T %<pane> <hex>` with the title, then `C` (child) and `G`
/// (grandchild) lines with program names. Only `/proc/<pid>/comm`, never
/// command lines or environments; hex keeps every title byte exact.
const DETAILS_SCRIPT: &str = r#"sock=$1
shift
while [ "$#" -ge 2 ]; do
  pane=$1
  pid=$2
  shift 2
  title=$(tmux -u -L "$sock" display-message -p -t "$pane" '#{pane_title}' 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
  printf 'T %s %s\n' "$pane" "$title"
  for child in $(cat /proc/"$pid"/task/*/children 2>/dev/null); do
    printf 'C %s %s\n' "$pane" "$(od -An -v -tx1 /proc/"$child"/comm 2>/dev/null | tr -d ' \n')"
    for grandchild in $(cat /proc/"$child"/task/*/children 2>/dev/null); do
      printf 'G %s %s\n' "$pane" "$(od -An -v -tx1 /proc/"$grandchild"/comm 2>/dev/null | tr -d ' \n')"
    done
  done
done
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

/// Exactly one value: even hex, UTF-8, one final newline. Anything else is
/// not what the script sent and is skipped.
fn decode(hex: &str) -> Option<String> {
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes)
        .ok()?
        .strip_suffix('\n')
        .map(str::to_owned)
}

pub fn parse_details(stdout: &str) -> BTreeMap<PaneId, PaneDetails> {
    let mut details: BTreeMap<PaneId, PaneDetails> = BTreeMap::new();
    for line in stdout.lines() {
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
                if let Some(title) = decode(hex) {
                    details.entry(pane).or_default().title = Some(title);
                }
            }
            "C" | "G" => {
                if let Some(name) = decode(hex) {
                    let entry = details.entry(pane).or_default();
                    if kind == "C" {
                        entry.children.push(name);
                    } else {
                        entry.grandchildren.push(name);
                    }
                }
            }
            _ => {}
        }
    }
    details
}

fn agent_named(name: &str) -> Option<DetectedAgent> {
    match name {
        "claude" => Some(DetectedAgent::Claude),
        "codex" => Some(DetectedAgent::Codex),
        "grok" => Some(DetectedAgent::Grok),
        "agy" => Some(DetectedAgent::Agy),
        "opencode" => Some(DetectedAgent::OpenCode),
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
    // Codex's own "<thread> | <project>" shape shows it ready.
    let plain = !title.starts_with('[') && !title.starts_with(is_spinner);
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
        DetectedAgent::Codex => "the Codex title shows no known status",
        DetectedAgent::Grok => "the Grok title shows no known status",
    };
    Some(classify(agent, title).unwrap_or((StatusKind::Unknown, unrecognized)))
}

/// One output line as the remote script prints it: the value plus the
/// newline `display-message -p` and `/proc/<pid>/comm` end with, hex-encoded.
#[cfg(test)]
pub fn details_line(kind: char, pane: u32, text: &str) -> String {
    let hex: String = text.bytes().map(|b| format!("{b:02x}")).collect();
    format!("{kind} %{pane} {hex}0a\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(title: Option<&str>, children: &[&str], grandchildren: &[&str]) -> PaneDetails {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect();
        PaneDetails {
            title: title.map(str::to_owned),
            children: names(children),
            grandchildren: names(grandchildren),
        }
    }

    #[test]
    fn details_decode_titles_and_programs_per_pane() {
        let stdout = [
            details_line('T', 5, "[ ! ] Action Required | thread | home"),
            details_line('C', 5, "node"),
            details_line('G', 5, "codex"),
            details_line('T', 4, "⠸ - Thinking - chat - grok"),
            details_line('C', 4, "grok"),
            details_line('G', 4, "node"),
        ]
        .concat();
        let details = parse_details(&stdout);
        assert_eq!(
            details[&PaneId(5)],
            tree(
                Some("[ ! ] Action Required | thread | home"),
                &["node"],
                &["codex"]
            )
        );
        assert_eq!(
            details[&PaneId(4)],
            tree(Some("⠸ - Thinking - chat - grok"), &["grok"], &["node"])
        );
    }

    #[test]
    fn details_skip_what_they_cannot_decode_exactly() {
        // %1: tmux gave no title (the pane vanished since the inventory).
        // %2 odd hex, %3 not hex, %4 unknown kind, "5" no pane id, %6 not
        // UTF-8, %7 no final newline, %8 a program that exited meanwhile.
        let stdout = "T %1 \nT %2 0\nT %3 zz\nX %4 780a\nT 5 780a\nT %6 ff0a\nT %7 78\nC %8 \n";
        let details = parse_details(stdout);
        assert_eq!(details.keys().copied().collect::<Vec<_>>(), vec![PaneId(1)]);
        assert_eq!(details[&PaneId(1)], tree(None, &[], &[]));
    }

    #[test]
    fn the_agent_is_the_one_known_program_below_the_pane_shell() {
        let d = |children: &[&str], grandchildren: &[&str]| {
            detect(&tree(None, children, grandchildren))
        };
        // Measured process trees (2026-09-14): Codex's npm launcher is
        // `node` with `codex` below it; Grok and Claude keep `node` helpers.
        assert_eq!(d(&["node"], &["codex"]), Some(DetectedAgent::Codex));
        assert_eq!(d(&["grok"], &["node", "node"]), Some(DetectedAgent::Grok));
        assert_eq!(
            d(&["claude"], &["node", "node"]),
            Some(DetectedAgent::Claude)
        );
        assert_eq!(d(&["agy"], &[]), Some(DetectedAgent::Agy));
        assert_eq!(d(&["opencode"], &[]), Some(DetectedAgent::OpenCode));
        // The hand-started agent is the child; what it runs does not speak
        // for the pane.
        assert_eq!(d(&["grok"], &["codex"]), Some(DetectedAgent::Grok));
        assert_eq!(d(&["node"], &[]), None);
        assert_eq!(d(&[], &[]), None);
        assert_eq!(d(&["codex", "grok"], &[]), None);
        assert_eq!(d(&["bash"], &["codex", "grok"]), None);
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
                &["node"],
                &["codex"]
            ),
            Some((StatusKind::Waiting, "action required (Codex title)"))
        );
        assert_eq!(
            s(Some("⠴ - Thinking - chat - grok"), &["grok"], &["node"]),
            Some((StatusKind::Busy, "working (Grok title)"))
        );
        assert_eq!(
            s(Some("chat - grok"), &["grok"], &[]),
            Some((StatusKind::Idle, "ready (Grok title)"))
        );
        assert_eq!(
            s(
                Some("⚠ Action Required - ⠧ - step… - chat - grok"),
                &["grok"],
                &[]
            ),
            Some((StatusKind::Waiting, "approval required (Grok title)"))
        );
        assert_eq!(
            s(Some("home"), &["node"], &["codex"]),
            Some((StatusKind::Unknown, "the Codex title shows no known status"))
        );
        assert_eq!(
            s(None, &["grok"], &[]),
            Some((StatusKind::Unknown, "the Grok title shows no known status"))
        );
        assert_eq!(
            s(Some("test-vm"), &["agy"], &[]),
            Some((StatusKind::Unknown, "agy shows no status in its title"))
        );
        assert_eq!(
            s(Some("OpenCode"), &["opencode"], &[]),
            Some((StatusKind::Unknown, "OpenCode shows no status in its title"))
        );
        // Claude's source is its CLI; after an agent exits, its last title
        // no longer counts.
        assert_eq!(s(Some("✳ thing"), &["claude"], &["node"]), None);
        assert_eq!(s(Some("thread | home"), &[], &[]), None);
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
        assert!(script.contains("-L \"$sock\" display-message -p -t \"$pane\" '#{pane_title}'"));
        assert!(script.contains("/children"));
        assert!(script.contains("/comm"));
        assert!(!script.contains("cmdline"));
        assert!(!script.contains("environ"));
        assert!(details_command("agentbridge", &[]).is_none());
    }
}
