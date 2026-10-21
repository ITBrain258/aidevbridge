use crate::remote;
use crate::transport::Transport;

#[derive(Debug, Clone)]
pub struct PreflightReport {
    pub tmux_version: Option<String>,
    pub has_base64: bool,
    pub socket_dir_writable: bool,
}

/// Extrahiert die Hauptversion aus `tmux -V`-Text.
///
/// Ein naives `v.split('.').next().parse()` (der naheliegende Ansatz)
/// scheitert an real vorkommenden Formaten: Debian/Ubuntu haengen einen
/// Buchstaben an (`3.3a` -- funktioniert zufaellig, weil "3" vor dem
/// Buchstaben steht), Git-`master`-Builds melden sich als `next-3.5` (die
/// Ziffer steht NICHT am Anfang -- "next-3" laesst sich nicht parsen), und
/// eine leere oder kaputte Ausgabe enthaelt gar keine Ziffer. Diese
/// Funktion sucht die erste Ziffernfolge irgendwo im String, unabhaengig
/// von Praefixen wie `next-`. Liefert `None`, wenn der String ueberhaupt
/// keine Ziffer enthaelt -- das ist ein anderer Fall als "Version zu alt"
/// und wird von `blocking_problem` auch unterschiedlich gemeldet (siehe
/// dort).
fn parse_major_version(v: &str) -> Option<u32> {
    let start = v.find(|c: char| c.is_ascii_digit())?;
    let digits: String = v[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

impl PreflightReport {
    pub fn blocking_problem(&self) -> Option<String> {
        // base64 zuerst, nicht tmux: JEDE Kommandozeile aus `remote::build`
        // (auch die tmux- und die Socket-Verzeichnis-Sonde selbst) braucht
        // `base64 -d` im eigenen Praeludium, um ihre Argumente zu
        // dekodieren (siehe `remote::command::build`). Fehlt `base64`
        // wirklich, schlagen deshalb ALLE DREI Sonden fehl, nicht nur die
        // base64-Sonde -- `tmux_version: None` waere dann kein Beleg fuer
        // "tmux fehlt", sondern nur ein Symptom des kaputten
        // Transportmechanismus. Erst wenn `has_base64` bestaetigt, dass
        // das Praeludium funktioniert, ist ein `None` bei `tmux_version`
        // ein verlaessliches Signal. Review-Befund, siehe
        // `run_reports_base64_not_tmux_as_the_problem_on_a_base64_less_host`.
        if !self.has_base64 {
            return Some("base64 is not available on this host".into());
        }
        match &self.tmux_version {
            None => {
                return Some(
                    "tmux is not installed on this host (need >= 3.0). Install it with the \
                     host's package manager, for example: sudo apt install tmux"
                        .into(),
                )
            }
            Some(v) => match parse_major_version(v) {
                // Bewusst "im Zweifel ablehnen": wir wissen nicht, ob >= 3.0
                // erfuellt ist, und Preflight soll konkrete Ursachen nennen,
                // keine vage Vermutung. Die Meldung behauptet aber NICHT
                // "zu alt" -- das waere bei einem taeuschend echten
                // Zukunftsformat wie `next-3.5` schlicht falsch und wuerde
                // den Nutzer zu einem sinnlosen Upgrade schicken.
                None => {
                    return Some(format!(
                        "could not determine the tmux version from \"{v}\" (need >= 3.0)"
                    ))
                }
                Some(major) if major < 3 => {
                    return Some(format!(
                        "tmux {v} is too old (need >= 3.0). Update it with the host's \
                         package manager."
                    ));
                }
                Some(_) => {}
            },
        }
        if !self.socket_dir_writable {
            return Some("the tmux socket directory is not writable".into());
        }
        None
    }
}

/// Prueft die drei abbrechenden Voraussetzungen aus Spec §6.9 (`tmux`,
/// `base64`, beschreibbares Socket-Verzeichnis). Die beiden restlichen
/// Zeilen der Tabelle (`#{@x}`-Aufloesung, `git --version`) sind bewusst
/// NICHT Teil dieses Reports -- sie sind Warnungen fuer Funktionen, die
/// erst in spaeteren Plaenen entstehen (Reviewbefund aus
/// Task 1: Plan 1 darf nicht an Voraussetzungen scheitern, die er gar
/// nicht benutzt).
///
/// Jede Kommandozeile entsteht ueber `remote::build` -- kein `format!` auf
/// einen SSH-Befehl (siehe `run_builds_every_command_via_remote_build`
/// unten).
pub async fn run(t: &dyn Transport) -> anyhow::Result<PreflightReport> {
    let tmux = t.exec(&remote::build(&["tmux", "-V"])).await?;
    let tmux_version =
        (tmux.code == 0).then(|| tmux.stdout.trim().trim_start_matches("tmux ").to_string());
    let b64 = t
        .exec(&remote::build(&["sh", "-c", "command -v base64"]))
        .await?;
    // `TMUX_TMPDIR` geht `TMPDIR` vor (H7, Kritikrunde): tmux selbst legt
    // seinen Socket unter `TMUX_TMPDIR` an, falls gesetzt, und faellt erst
    // dann auf `TMPDIR`/`/tmp` zurueck (siehe `tmux(1)`, Abschnitt
    // "FILES"). Eine Sonde, die nur `TMPDIR` prueft, koennte ein
    // beschreibbares `TMPDIR` melden, waehrend das tatsaechlich von tmux
    // benutzte `TMUX_TMPDIR` unbeschreibbar ist -- Preflight wuerde dann
    // faelschlich "alles in Ordnung" melden.
    let dir = t
        .exec(&remote::build(&[
            "sh",
            "-c",
            "test -w \"${TMUX_TMPDIR:-${TMPDIR:-/tmp}}\"",
        ]))
        .await?;
    Ok(PreflightReport {
        tmux_version,
        has_base64: b64.code == 0,
        socket_dir_writable: dir.code == 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_tmux_blocks() {
        let r = PreflightReport {
            tmux_version: None,
            has_base64: true,
            socket_dir_writable: true,
        };
        assert!(r.blocking_problem().unwrap().contains("tmux"));
    }

    #[test]
    fn old_tmux_blocks() {
        let r = PreflightReport {
            tmux_version: Some("2.8".into()),
            has_base64: true,
            socket_dir_writable: true,
        };
        assert!(r.blocking_problem().is_some());
    }

    /// Nutzer einer heruntergeladenen Fassung lesen das README womoeglich
    /// nie; die Meldung selbst muss den naechsten Schritt nennen. Die App
    /// installiert nichts.
    #[test]
    fn missing_tmux_names_how_to_install_it() {
        let r = PreflightReport {
            tmux_version: None,
            has_base64: true,
            socket_dir_writable: true,
        };
        let msg = r.blocking_problem().unwrap();
        assert!(msg.contains("package manager"), "{msg}");
        assert!(msg.contains("sudo apt install tmux"), "{msg}");
    }

    #[test]
    fn old_tmux_names_how_to_update_it() {
        let r = PreflightReport {
            tmux_version: Some("2.8".into()),
            has_base64: true,
            socket_dir_writable: true,
        };
        let msg = r.blocking_problem().unwrap();
        assert!(msg.contains("too old"), "{msg}");
        assert!(msg.contains("package manager"), "{msg}");
    }

    #[test]
    fn tmux_3_3a_is_accepted() {
        let r = PreflightReport {
            tmux_version: Some("3.3a".into()),
            has_base64: true,
            socket_dir_writable: true,
        };
        assert!(r.blocking_problem().is_none());
    }

    #[test]
    fn missing_base64_blocks() {
        let r = PreflightReport {
            tmux_version: Some("3.4".into()),
            has_base64: false,
            socket_dir_writable: true,
        };
        assert!(r.blocking_problem().unwrap().contains("base64"));
    }

    #[test]
    fn socket_dir_not_writable_blocks() {
        let r = PreflightReport {
            tmux_version: Some("3.4".into()),
            has_base64: true,
            socket_dir_writable: false,
        };
        let msg = r.blocking_problem().unwrap();
        assert!(
            msg.contains("socket"),
            "Meldung soll auf das Socket-Verzeichnis hinweisen: {msg}"
        );
    }

    /// tmux-Builds direkt aus dem Git-`master`-Zweig melden sich als
    /// `next-<zukuenftige Version>` statt einer regulaeren Versionsnummer
    /// (real beobachtetes Format, kein Konstrukt). Ein solcher Build ist
    /// NEUER als jede veroeffentlichte Version, keine "alte" Installation
    /// -- er darf nicht als "zu alt" abgelehnt werden.
    #[test]
    fn tmux_git_master_build_is_accepted() {
        let r = PreflightReport {
            tmux_version: Some("next-3.5".into()),
            has_base64: true,
            socket_dir_writable: true,
        };
        assert!(
            r.blocking_problem().is_none(),
            "next-3.5 ist ein Git-Master-Build, keine alte Version"
        );
    }

    #[test]
    fn tmux_release_candidate_suffix_is_accepted() {
        let r = PreflightReport {
            tmux_version: Some("3.2-rc".into()),
            has_base64: true,
            socket_dir_writable: true,
        };
        assert!(r.blocking_problem().is_none());
    }

    /// Eine Versionsangabe, aus der sich gar keine Ziffer extrahieren
    /// laesst (leere Ausgabe, kaputte Installation, o.ae.), ist nicht
    /// dasselbe Problem wie eine zu alte Version -- die Abhilfe ist eine
    /// andere ("tmux neu installieren/pruefen" statt "tmux aktualisieren").
    /// Blockiert im Zweifel trotzdem (konservativ), aber mit einer
    /// ehrlichen Meldung statt einer falschen "zu alt"-Behauptung.
    #[test]
    fn unparsable_empty_version_blocks_with_honest_message_not_too_old() {
        let r = PreflightReport {
            tmux_version: Some("".into()),
            has_base64: true,
            socket_dir_writable: true,
        };
        let msg = r.blocking_problem().unwrap();
        assert!(
            !msg.contains("too old"),
            "leere Version ist nicht bewiesenermassen 'zu alt': {msg}"
        );
        assert!(
            msg.contains("determine") || msg.contains("could not"),
            "Meldung soll die Unklarheit benennen: {msg}"
        );
    }

    #[test]
    fn unparsable_garbage_version_blocks_with_honest_message_not_too_old() {
        let r = PreflightReport {
            tmux_version: Some("banana".into()),
            has_base64: true,
            socket_dir_writable: true,
        };
        let msg = r.blocking_problem().unwrap();
        assert!(
            !msg.contains("too old"),
            "unlesbare Version ist nicht bewiesenermassen 'zu alt': {msg}"
        );
    }

    /// Belegt die Staffelung innerhalb der drei abbrechenden Pruefungen:
    /// wenn mehrere Probleme gleichzeitig vorliegen, wird das zuerst
    /// genannte gemeldet -- der Nutzer bekommt EINE konkrete Ursache statt
    /// einer Liste. base64 kommt zuerst, nicht tmux: `remote::build`
    /// braucht `base64` fuer JEDE Sonde (auch die tmux- und die
    /// Socket-Verzeichnis-Sonde selbst), ein fehlendes `base64` macht
    /// deren Ergebnisse unzuverlaessig (Review-Befund, siehe
    /// `run_reports_base64_not_tmux_as_the_problem_on_a_base64_less_host`
    /// fuer den End-zu-End-Beleg ueber `run()`).
    #[test]
    fn base64_problem_is_reported_before_tmux_problem() {
        let r = PreflightReport {
            tmux_version: None,
            has_base64: false,
            socket_dir_writable: false,
        };
        let msg = r.blocking_problem().unwrap();
        assert!(
            msg.contains("base64"),
            "base64-Problem muss zuerst kommen, weil ein fehlendes base64 auch \
             die tmux- und Socket-Verzeichnis-Sonde unzuverlaessig macht: {msg}"
        );
    }

    /// Gegenstueck: bestaetigt, dass die Umstellung die normale Diagnose
    /// nicht kaputt macht -- funktioniert base64 nachweislich, bleibt eine
    /// fehlende tmux-Installation weiterhin als tmux-Problem erkennbar.
    #[test]
    fn tmux_problem_is_still_reported_when_base64_works() {
        let r = PreflightReport {
            tmux_version: None,
            has_base64: true,
            socket_dir_writable: true,
        };
        let msg = r.blocking_problem().unwrap();
        assert!(msg.contains("tmux"), "tmux-Problem erwartet: {msg}");
    }
}

/// Tests fuer `run()`: prueft, wie `ExecResult`s aus drei `exec`-Aufrufen
/// (tmux, base64, Socket-Verzeichnis) in einen `PreflightReport` uebersetzt
/// werden -- ohne echte VM, ueber einen abgespielten `Transport`.
#[cfg(test)]
mod run_tests {
    use super::*;
    use crate::transport::ExecResult;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Liefert vorgefertigte `ExecResult`s in Aufrufreihenfolge und
    /// zeichnet jede ausgefuehrte Kommandozeile auf. `run()`s Aufrufreihenfolge
    /// ist fest (tmux, dann base64, dann Socket-Verzeichnis) -- die Tests
    /// unten nutzen das aus.
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

    fn ok(stdout: &str) -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: stdout.into(),
            stderr: String::new(),
            code: 0,
        }
    }

    fn failed() -> ExecResult {
        ExecResult {
            utf8_valid: true,
            stdout: String::new(),
            stderr: "command not found".into(),
            code: 127,
        }
    }

    #[tokio::test]
    async fn run_reports_everything_present_when_all_three_checks_succeed() {
        let t = ScriptedTransport::new(vec![ok("tmux 3.3a\n"), ok(""), ok("")]);
        let report = run(&t).await.unwrap();
        assert_eq!(report.tmux_version.as_deref(), Some("3.3a"));
        assert!(report.has_base64);
        assert!(report.socket_dir_writable);
        assert!(report.blocking_problem().is_none());
    }

    /// Jede von `run()` ausgefuehrte Zeile muss aus `remote::build` stammen,
    /// nicht aus einem rohen `format!` auf einen SSH-Befehl (Randbedingung
    /// des Tasks). `remote::build` stellt seiner Ausgabe immer `set -eu;`
    /// voran (siehe `remote::command::build`) -- das ist ein struktureller
    /// Marker, der nur bei tatsaechlicher Nutzung von `remote::build`
    /// auftaucht.
    #[tokio::test]
    async fn run_builds_every_command_via_remote_build() {
        let t = ScriptedTransport::new(vec![ok("tmux 3.3a\n"), ok(""), ok("")]);
        let _ = run(&t).await.unwrap();
        let calls = t.calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            3,
            "tmux, base64, Socket-Verzeichnis -- drei Aufrufe"
        );
        for line in calls.iter() {
            assert!(
                line.starts_with("set -eu;"),
                "Zeile stammt nicht aus remote::build: {line}"
            );
        }
    }

    #[tokio::test]
    async fn run_marks_tmux_missing_when_the_command_fails() {
        let t = ScriptedTransport::new(vec![failed(), ok(""), ok("")]);
        let report = run(&t).await.unwrap();
        assert!(
            report.tmux_version.is_none(),
            "ein fehlgeschlagenes `tmux -V` darf keine Version liefern"
        );
    }

    #[tokio::test]
    async fn run_marks_base64_missing_when_the_command_fails() {
        let t = ScriptedTransport::new(vec![ok("tmux 3.3a\n"), failed(), ok("")]);
        let report = run(&t).await.unwrap();
        assert!(!report.has_base64);
    }

    #[tokio::test]
    async fn run_marks_socket_dir_not_writable_when_the_command_fails() {
        let t = ScriptedTransport::new(vec![ok("tmux 3.3a\n"), ok(""), failed()]);
        let report = run(&t).await.unwrap();
        assert!(!report.socket_dir_writable);
    }

    /// H7 (Kritikrunde): tmux nimmt `TMUX_TMPDIR` vor `TMPDIR` (siehe
    /// `tmux(1)`, Abschnitt "FILES") -- die Sonde fuer das
    /// Socket-Verzeichnis muss deshalb genau in dieser Reihenfolge pruefen,
    /// sonst meldet Preflight ein beschreibbares `TMPDIR`, waehrend das
    /// tatsaechlich von tmux benutzte `TMUX_TMPDIR` unbeschreibbar ist.
    ///
    /// Jede von `remote::build` erzeugte Zeile transportiert ihre Argumente
    /// base64-kodiert (siehe `remote::command::build`) -- ein simpler
    /// `str::contains` auf der rohen Zeile faende "TMUX_TMPDIR" deshalb
    /// nie, selbst wenn die Sonde es tatsaechlich prueft. Erst
    /// `decoded_argv` (derselbe Testhelfer wie in `tmux::client` und
    /// `transport::russh_transport`) macht das eigentliche Kommando wieder
    /// lesbar.
    #[tokio::test]
    async fn socket_dir_probe_checks_tmux_tmpdir_before_tmpdir() {
        let t = ScriptedTransport::new(vec![ok("tmux 3.3a\n"), ok(""), ok("")]);
        let _ = run(&t).await.unwrap();
        let calls = t.calls.lock().unwrap();
        let argv = crate::remote::command::decoded_argv(&calls[2]);
        let script = argv.last().expect("sh -c erwartet ein Skript-Argument");
        assert!(
            script.contains("TMUX_TMPDIR"),
            "die Socket-Verzeichnis-Sonde muss TMUX_TMPDIR pruefen, bevor sie auf TMPDIR \
             zurueckfaellt: {script}"
        );
    }

    /// Review-Befund: JEDE von `remote::build` erzeugte Zeile
    /// braucht `base64 -d` im eigenen Praeludium, um ihre Argumente
    /// ueberhaupt zu dekodieren (siehe `remote::command::build`). Fehlt
    /// `base64` auf dem Host wirklich, schlagen deshalb NICHT nur die
    /// base64-Sonde, sondern alle drei Sonden fehl (das Praeludium selbst
    /// bricht unter `set -eu` ab, bevor die eigentliche Nutzlast je
    /// laeuft) -- exakt das Bild, das `ScriptedTransport::new(vec![failed();
    /// 3])` simuliert. `blocking_problem()` darf in diesem Fall NICHT
    /// "tmux is not installed" melden: `tmux_version: None` ist nur dann
    /// ein verlaessliches Signal fuer "tmux fehlt", wenn `base64`
    /// nachweislich funktioniert hat. Der Nutzer wuerde sonst angewiesen,
    /// tmux zu installieren, obwohl das eigentliche (und einzig sichere)
    /// Problem coreutils/base64 ist.
    #[tokio::test]
    async fn run_reports_base64_not_tmux_as_the_problem_on_a_base64_less_host() {
        let t = ScriptedTransport::new(vec![failed(), failed(), failed()]);
        let report = run(&t).await.unwrap();
        let msg = report
            .blocking_problem()
            .expect("ein Host ohne base64 muss blockieren");
        assert!(
            msg.contains("base64"),
            "auf einem base64-losen Host ist tmux_version:None kein verlaessliches \
             Signal fuer 'tmux fehlt' -- die Sonde selbst konnte nicht laufen. \
             Gemeldet wurde stattdessen: {msg}"
        );
    }
}
