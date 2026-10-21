//! Verlauf beim Anhaengen (Spec §5.6): der eine tmux-Aufruf, der den
//! Verlauf einer Pane liest, und die Aufbereitung seiner Antwort fuer
//! xterm.js. Auslieferung und Frist liegen in `commands.rs`.

/// Erste Antwortzeile (Spec §5.6): `1` heisst "nichts wiederherzustellen",
/// also Vollbildprogramm (`alternate_on`) ODER leerer Verlauf. Ohne die
/// Pruefung von `history_size` klemmt tmux `-E -1` bei leerem Verlauf auf
/// Zeile 0 des SICHTBAREN Bereichs (gemessen mit tmux 3.6 am 2026-10-11: eine
/// frische Session lieferte `first visible\n`), und diese Zeile stuende nach
/// dem Neuzeichnen doppelt im Verlauf.
const FIRST_LINE_FORMAT: &str = "#{?history_size,#{alternate_on},1}";

/// argv fuer `remote::build`: EIN tmux-Aufruf, `;` als eigenes Element wie
/// in `prepare_server`. `-S -5000 -E -1` reicht bis zur letzten
/// Verlaufszeile; den sichtbaren Bereich zeichnet tmux beim Attach selbst.
/// `-J` fuegt umbrochene Zeilen zusammen, xterm.js bricht sie in der eigenen
/// Breite neu um. Gebaut wie `query_command`: rein lesend, startet keinen
/// Server, und `-u` laesst Nicht-ASCII-Text unangetastet.
pub fn history_command(socket: &str, pane_id: u32) -> Vec<String> {
    let pane = format!("%{pane_id}");
    [
        "env",
        "LC_ALL=C",
        "tmux",
        "-u",
        "-L",
        socket,
        "display-message",
        "-p",
        "-t",
        &pane,
        FIRST_LINE_FORMAT,
        ";",
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-S",
        "-5000",
        "-E",
        "-1",
        "-t",
        &pane,
    ]
    .iter()
    .map(|arg| (*arg).to_owned())
    .collect()
}

/// Bereitet die Antwort von [`history_command`] fuer xterm.js auf.
///
/// `None`, wenn es nichts wiederherzustellen gibt: erste Zeile `1`, keine
/// Verlaufszeile, oder eine Antwort, die nicht die Form der tmux-Ausgabe hat.
/// Sonst, nach Spec §5.6:
/// - `\n` wird `\r\n`; die Escape-Folgen aus `-e` bleiben unveraendert.
/// - Hoechstens `max_bytes`, sonst fallen die aeltesten Zeilen weg. Immer
///   ganze Zeilen, damit weder eine Escape-Folge noch ein Zeichen zerfaellt.
/// - Enthaelt der ausgegebene Verlauf ein ESC, folgt `\e[m`: Die Attribute
///   aus `-e` laufen sonst ueber das Zeilenende hinaus, und jede Vorschubzeile
///   bekaeme die letzte Hintergrundfarbe.
/// - Danach genau `rows - 1` x `\r\n`: Das Neuzeichnen beim Attach
///   ueberschreibt den sichtbaren Bereich, und ED2 schiebt in xterm.js nichts
///   in den Verlauf. Ohne diesen Vorschub verschwaenden die letzten Zeilen des
///   Verlaufs; mit `rows` bliebe eine Leerzeile vor dem Bildschirm.
pub fn prepare_history(raw: &str, rows: u16, max_bytes: usize) -> Option<Vec<u8>> {
    let (first, captured) = raw.split_once('\n')?;
    if first != "0" {
        return None;
    }
    // `capture-pane -p` beendet seine Ausgabe immer mit genau einem `\n`.
    let lines: Vec<&str> = captured.strip_suffix('\n')?.split('\n').collect();
    let mut kept = 0;
    let mut size = 0;
    for line in lines.iter().rev() {
        let next = size + line.len() + 2;
        if next > max_bytes {
            break;
        }
        size = next;
        kept += 1;
    }
    if kept == 0 {
        return None;
    }
    let kept = &lines[lines.len() - kept..];
    let reset: &[u8] = if kept.iter().any(|line| line.contains('\x1b')) {
        b"\x1b[m"
    } else {
        b""
    };
    let feeds = usize::from(rows.saturating_sub(1));
    let mut prepared = Vec::with_capacity(size + reset.len() + 2 * feeds);
    for line in kept {
        prepared.extend_from_slice(line.as_bytes());
        prepared.extend_from_slice(b"\r\n");
    }
    prepared.extend_from_slice(reset);
    for _ in 0..feeds {
        prepared.extend_from_slice(b"\r\n");
    }
    Some(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_MIB: usize = 2 * 1024 * 1024;

    fn pad(rows: usize) -> Vec<u8> {
        b"\r\n".repeat(rows)
    }

    /// Spec §5.6: genau `rows - 1` Vorschuebe. Mit `rows` bliebe eine
    /// Leerzeile zwischen Verlauf und neu gezeichnetem Bildschirm. Ohne
    /// Escape-Folge im Verlauf folgt auch kein `\e[m`.
    #[test]
    fn history_then_rows_minus_one_line_feeds_and_no_reset_for_plain_text() {
        assert_eq!(
            prepare_history("0\nline1\nline2\n", 3, TWO_MIB).unwrap(),
            b"line1\r\nline2\r\n\r\n\r\n"
        );
    }

    #[test]
    fn one_or_zero_rows_append_no_line_feeds() {
        for rows in [0, 1] {
            assert_eq!(
                prepare_history("0\nonly\n", rows, TWO_MIB).unwrap(),
                b"only\r\n",
                "{rows}"
            );
        }
    }

    #[test]
    fn a_full_screen_program_or_an_empty_history_restores_nothing() {
        assert_eq!(prepare_history("1\nline1\nline2\n", 3, TWO_MIB), None);
        assert_eq!(prepare_history("1\n", 3, TWO_MIB), None);
        // Leerer Verlauf: kein Vorschub, also gar keine Ausgabe.
        assert_eq!(prepare_history("0\n", 3, TWO_MIB), None);
    }

    #[test]
    fn responses_not_shaped_like_tmux_restore_nothing() {
        for raw in [
            "",
            "0",
            "2\nline\n",
            " 0\nline\n",
            "0\r\nline\n",
            "true\nline\n",
            // capture-pane -p beendet seine Ausgabe immer mit `\n`.
            "0\nunterminated",
        ] {
            assert_eq!(prepare_history(raw, 3, TWO_MIB), None, "{raw:?}");
        }
    }

    /// Escape-Folgen und Leerzeilen bleiben unveraendert; danach setzt `\e[m`
    /// die Attribute zurueck, bevor die Vorschubzeilen kommen (Spec §5.6).
    #[test]
    fn escape_sequences_pass_through_and_end_with_an_sgr_reset_before_the_padding() {
        assert_eq!(
            prepare_history("0\n\x1b[41mred\n\nnext \u{20ac}\n", 3, TWO_MIB).unwrap(),
            [
                b"\x1b[41mred\r\n\r\nnext \xe2\x82\xac\r\n\x1b[m".as_slice(),
                &pad(2)
            ]
            .concat()
        );
    }

    /// Massgeblich ist der ausgegebene Verlauf: fiel die einzige Escape-Folge
    /// mit den aeltesten Zeilen weg, braucht es kein `\e[m`; steht sie in einer
    /// behaltenen Zeile, schon.
    #[test]
    fn the_reset_follows_the_lines_actually_kept() {
        let dropped = prepare_history("0\n\x1b[31mold\nnew\n", 2, 5).unwrap();
        assert_eq!(dropped, b"new\r\n\r\n");
        let kept = prepare_history("0\nold\n\x1b[31mnew\n", 2, 10).unwrap();
        assert_eq!(kept, b"\x1b[31mnew\r\n\x1b[m\r\n");
    }

    /// Spec §5.6: hoechstens `max_bytes`, sonst fallen die aeltesten Zeilen
    /// weg -- ganze Zeilen, die neuesten bleiben.
    #[test]
    fn an_oversized_history_drops_its_oldest_lines() {
        let lines: Vec<String> = (1..=100).map(|n| format!("line {n:03}")).collect();
        let raw = format!("0\n{}\n", lines.join("\n"));
        // Jede Zeile kostet 8 + 2 Bytes; 95 Bytes fassen genau neun Zeilen.
        let rows = 4;
        let prepared = prepare_history(&raw, rows, 95).unwrap();
        let expected: String = lines[91..].iter().map(|l| format!("{l}\r\n")).collect();
        assert_eq!(prepared, [expected.as_bytes(), &pad(3)].concat());
        assert!(prepared.len() <= 95 + usize::from(rows) * 2);
        // Genau an der Grenze bleibt die Zeile.
        let fits = prepare_history(&raw, rows, 100).unwrap();
        assert_eq!(fits.len(), 100 + 3 * 2);
        assert!(fits.starts_with(b"line 091\r\n"));
    }

    #[test]
    fn a_newest_line_larger_than_the_limit_restores_nothing() {
        assert_eq!(prepare_history("0\nshort\nmuch too long\n", 3, 10), None);
    }

    #[test]
    fn the_command_is_one_read_only_tmux_call_for_the_numeric_pane() {
        assert_eq!(
            history_command("own_socket", 7),
            [
                "env",
                "LC_ALL=C",
                "tmux",
                "-u",
                "-L",
                "own_socket",
                "display-message",
                "-p",
                "-t",
                "%7",
                "#{?history_size,#{alternate_on},1}",
                ";",
                "capture-pane",
                "-p",
                "-e",
                "-J",
                "-S",
                "-5000",
                "-E",
                "-1",
                "-t",
                "%7",
            ]
        );
    }

    /// Die Zeile entsteht ausschliesslich ueber `remote::build`; das `%` des
    /// Ziels und die Formatklammern kommen unveraendert an.
    #[test]
    fn the_command_survives_remote_build_unchanged() {
        let argv = history_command("own_socket", 4_294_967_295);
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let line = crate::remote::build(&refs);
        assert!(line.starts_with("set -eu;"));
        assert_eq!(crate::remote::command::decoded_argv(&line), argv);
        assert!(argv.contains(&"%4294967295".to_owned()));
    }
}
