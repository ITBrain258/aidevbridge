// `serde::Serialize`: `suggest_hosts()` liefert diesen Typ direkt als
// `#[tauri::command]`-Rueckgabe an den WebView -- Tauris IPC verlangt
// `Serialize` fuer jeden Rueckgabetyp (`IpcResponse`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// Minimaler Parser fuer `~/.ssh/config`. Deckt `Host`, `HostName`, `User`,
/// `Port` und `IdentityFile` ab -- die uebrigen rund achtzig Schluesselwoerter
/// der echten `ssh_config` (u. a. `ProxyJump`, `Include`) sind bewusst nicht
/// Gegenstand. Die Funktion liest nur den uebergebenen Text; Datei-I/O
/// passiert beim Aufrufer. Eine Ausnahme: `IdentityFile` loest eine fuehrende
/// Tilde gegen `dirs::home_dir()` auf (siehe `resolve_identity_file`) -- das
/// ist ein LOKALER Pfad, den nur dieser Prozess selbst aufloesen kann, eine
/// woertliche Tilde darf ihn nicht verlassen.
///
/// Die Zeilen werden gelesen wie von OpenSSH, soweit es die Vorschlaege
/// betrifft (jeder Vorschlag bietet beim ersten Start ein direktes Verbinden
/// an, ein falsch gelesener Wert fuehrt also zu einem Fehlversuch):
///
/// - Das Schluesselwort endet am ersten Leerraum oder `=`; `Key=Wert`,
///   `Key = Wert` und `Key Wert` sind gleichwertig. Ein `=` im Wert selbst
///   bleibt stehen.
/// - Ein einzelner Wert (`HostName`, `User`, `Port`, `IdentityFile`) verliert
///   ein umschliessendes Paar doppelter Anfuehrungszeichen. Backslashes werden
///   NICHT als Escape gelesen, damit Windows-Pfade wie
///   `"C:\Users\Max Muster\.ssh\id_ed25519"` unveraendert bleiben.
/// - Eine `Host`-Zeile kann mehrere Muster tragen (Anfuehrungszeichen
///   gruppieren). Jedes konkrete Muster wird ein eigener Vorschlag; Muster
///   mit `*` oder `?` und negierte Muster (`!x`) benennen keinen Zielrechner
///   und werden uebersprungen. Die folgenden Schluesselwoerter gelten fuer
///   ALLE Aliase der Zeile. Eine `Host`-Zeile ohne konkretes Muster beendet
///   den vorherigen Block.
/// - `Match` beendet den aktuellen Block ebenfalls; seine Bedingungen werden
///   nicht ausgewertet, seine Schluesselwoerter landen bei keinem Vorschlag.
/// - Innerhalb eines Blocks gilt der ERSTE Wert eines Schluesselworts, wie
///   bei OpenSSH; spaetere Wiederholungen aendern nichts.
///
/// Schluesselwort-Zeilen, die vor dem ersten `Host` stehen, werden verworfen:
/// In der echten `ssh_config` gelten sie als globale Defaults fuer alle
/// nachfolgenden Hosts, aber dieser Parser erzeugt nur konkrete Vorschlaege
/// pro Host und hat keinen Host, dem er sie zuordnen koennte. Ebenso
/// unberuecksichtigt: `Include`, `%`-Tokens, das Zusammenfuehren mehrfach
/// vorkommender `Host`-Bloecke und mehrere `IdentityFile`-Werte.
pub fn parse(text: &str) -> Vec<SshConfigHost> {
    let mut out: Vec<SshConfigHost> = Vec::new();
    // Indizes in `out`, die zum aktuellen Host-Block gehoeren. `out` waechst
    // nur bei einer `Host`-Zeile, darum bleibt der Bereich bis zur naechsten
    // `Host`- oder `Match`-Zeile gueltig. Leer, solange kein Block mit
    // konkretem Alias offen ist; die Schluesselwoerter gehen dann ins Leere.
    let mut block = 0..0;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = split_keyword(line);

        match key.to_ascii_lowercase().as_str() {
            "host" => {
                let start = out.len();
                for pattern in split_patterns(value) {
                    if is_concrete_pattern(&pattern) {
                        out.push(SshConfigHost {
                            alias: pattern,
                            hostname: None,
                            user: None,
                            port: None,
                            identity_file: None,
                        });
                    }
                }
                block = start..out.len();
            }
            "match" => block = out.len()..out.len(),
            "hostname" => {
                let value = unquote(value);
                for h in &mut out[block.clone()] {
                    h.hostname.get_or_insert_with(|| value.to_string());
                }
            }
            "user" => {
                let value = unquote(value);
                for h in &mut out[block.clone()] {
                    h.user.get_or_insert_with(|| value.to_string());
                }
            }
            "port" => {
                let port = unquote(value).parse().ok();
                for h in &mut out[block.clone()] {
                    if h.port.is_none() {
                        h.port = port;
                    }
                }
            }
            "identityfile" => {
                let path = resolve_identity_file(unquote(value));
                for h in &mut out[block.clone()] {
                    if h.identity_file.is_none() {
                        h.identity_file.clone_from(&path);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Trennt eine (bereits getrimmte) Zeile in Schluesselwort und Wert wie
/// OpenSSH: Das Schluesselwort endet am ersten Leerraum oder `=`; danach
/// fallen Leerraum, hoechstens EIN `=` und weiterer Leerraum weg. Der Rest ist
/// der Wert, ein darin enthaltenes `=` bleibt also erhalten.
fn split_keyword(line: &str) -> (&str, &str) {
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let (key, rest) = line.split_at(end);
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
    (key, rest)
}

/// Entfernt ein umschliessendes Paar doppelter Anfuehrungszeichen. Bewusst
/// ohne Escape-Verarbeitung: Ein Backslash bleibt ein Backslash, sonst
/// zerfiele jeder Windows-Pfad.
fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
}

/// Zerlegt die Argumente einer `Host`-Zeile an Leerraum ausserhalb doppelter
/// Anfuehrungszeichen; die Anfuehrungszeichen selbst fallen weg. Ein nicht
/// geschlossenes Anfuehrungszeichen reicht bis zum Zeilenende. Leere Muster
/// (etwa `""`) entfallen.
fn split_patterns(value: &str) -> Vec<String> {
    let mut patterns = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in value.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    patterns.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        patterns.push(current);
    }
    patterns
}

/// Ein Muster benennt nur dann einen konkreten Zielrechner, wenn es weder
/// Platzhalter (`*`, `?`) enthaelt noch negiert ist (`!x` schliesst `x` aus,
/// statt es zu benennen).
fn is_concrete_pattern(pattern: &str) -> bool {
    !pattern.contains(['*', '?']) && !pattern.starts_with('!')
}

/// Loest eine fuehrende `~/`-Tilde in einem `IdentityFile`-Wert gegen
/// `dirs::home_dir()` auf. Anders als Arbeitsverzeichnisse auf dem
/// ENTFERNTEN Rechner (dort MUSS der Pfad absolut sein und eine Tilde wird
/// nie aufgeloest, siehe `settings::is_absolute_remote_path`) ist ein
/// `IdentityFile` ein LOKALER Pfad: dieser Prozess kann und muss ihn selbst
/// aufloesen, bevor er die SSH-Schicht erreicht -- eine woertlich
/// weitergereichte Tilde waere dort schlicht ein nicht existierender
/// Dateiname.
///
/// Liefert `None`, wenn `dirs::home_dir()` das Heimatverzeichnis nicht
/// ermitteln kann (z. B. `HOME`/`USERPROFILE` nicht gesetzt): ein fehlendes
/// Feld faellt ueber den bestehenden `resolve_auth_method`-Pfad auf
/// `AuthMethod::Agent` zurueck -- bekannt unbequem (Windows-Standarddienst
/// aus), aber wenigstens ein EHRLICHER Zustand. Eine woertliche Tilde
/// stumm durchzureichen waere die schlechtere Wahl: sie saehe wie ein
/// gueltiger Pfad aus und schluege erst beim Verbindungsversuch mit einer
/// irrefuehrenden "Datei nicht gefunden"-Meldung fehl.
///
/// YAGNI: nur die fuehrende `~/`-Form wird behandelt (die einzige, die in
/// echten `ssh_config`-Dateien fuer `IdentityFile` ueblich ist). Kein
/// Globbing, keine Mehrfachwerte, kein `IdentitiesOnly`.
fn resolve_identity_file(raw: &str) -> Option<String> {
    match raw.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|home| home.join(rest).to_string_lossy().into_owned()),
        None => Some(raw.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
Host 192.0.2.20
  HostName 192.0.2.20
  User u

Host jump
  HostName bastion.example
  User ops
  Port 2222
";

    #[test]
    fn parses_two_hosts() {
        let hosts = parse(SAMPLE);
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].alias, "192.0.2.20");
        assert_eq!(hosts[0].user.as_deref(), Some("u"));
        assert_eq!(hosts[0].port, None);
        assert_eq!(hosts[1].port, Some(2222));
    }

    #[test]
    fn ignores_comments_and_wildcards() {
        let hosts = parse("# comment\nHost *\n  User nobody\nHost real\n  HostName r\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
    }

    #[test]
    fn keywords_are_case_insensitive() {
        let hosts = parse("host a\n  hostname h\n  USER u\n");
        assert_eq!(hosts[0].hostname.as_deref(), Some("h"));
        assert_eq!(hosts[0].user.as_deref(), Some("u"));
    }

    #[test]
    fn keywords_before_first_host_are_ignored() {
        let hosts = parse("User global\nPort 22\nHost real\n  HostName r\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
        assert_eq!(hosts[0].user, None);
        assert_eq!(hosts[0].port, None);
    }

    #[test]
    fn wildcard_block_does_not_leak_into_previous_named_host() {
        let hosts = parse("Host real\n  HostName r\nHost *\n  User nobody\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
        assert_eq!(hosts[0].hostname.as_deref(), Some("r"));
        assert_eq!(
            hosts[0].user, None,
            "User aus dem Wildcard-Block darf nicht beim vorherigen Host landen"
        );
    }

    #[test]
    fn liest_identity_file_und_loest_die_tilde_auf() {
        let hosts =
            parse("Host vm\n  HostName 192.0.2.20\n  User u\n  IdentityFile ~/.ssh/id_ed25519\n");
        let h = &hosts[0];
        let got = h.identity_file.as_deref().expect("IdentityFile fehlt");
        assert!(
            !got.starts_with('~'),
            "die Tilde muss aufgeloest sein -- sie zeigt auf einen LOKALEN Pfad, \
             den die App selbst aufloesen kann; woertlich weitergereicht waere sie \
             ein nicht existierender Dateiname. Bekommen: {got:?}"
        );
        assert!(got.ends_with("id_ed25519"));
    }

    #[test]
    fn ohne_identity_file_bleibt_das_feld_leer() {
        let hosts = parse("Host vm\n  HostName 192.0.2.20\n  User u\n");
        assert_eq!(hosts[0].identity_file, None);
    }

    #[test]
    fn match_block_does_not_leak_into_previous_host() {
        let hosts = parse(
            "Host real\n  HostName r\nMatch host other exec \"true\"\n  User nobody\n  Port 2200\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
        assert_eq!(hosts[0].hostname.as_deref(), Some("r"));
        assert_eq!(
            hosts[0].user, None,
            "User aus dem Match-Block darf nicht beim vorherigen Host landen"
        );
        assert_eq!(hosts[0].port, None);
    }

    #[test]
    fn first_value_wins() {
        let hosts = parse(
            "Host a\n  HostName first\n  HostName second\n  User u1\n  User u2\n  \
             Port 2201\n  Port 2202\n  IdentityFile /k/one\n  IdentityFile /k/two\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname.as_deref(), Some("first"));
        assert_eq!(hosts[0].user.as_deref(), Some("u1"));
        assert_eq!(hosts[0].port, Some(2201));
        assert_eq!(hosts[0].identity_file.as_deref(), Some("/k/one"));
    }

    #[test]
    fn host_line_with_several_patterns() {
        let hosts = parse("Host a b *.x !c\n  HostName h\n  User u\n");
        let aliases: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, ["a", "b"]);
        for h in &hosts {
            assert_eq!(h.hostname.as_deref(), Some("h"), "Alias {}", h.alias);
            assert_eq!(h.user.as_deref(), Some("u"), "Alias {}", h.alias);
        }
    }

    #[test]
    fn key_equals_value_forms() {
        let hosts = parse(
            "Host=a\n  HostName=h\n  Port = 2222\n  User=u\n  IdentityFile=C:\\x\n  \
             HostKeyAlias=x=y\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "a");
        assert_eq!(hosts[0].hostname.as_deref(), Some("h"));
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[0].user.as_deref(), Some("u"));
        assert_eq!(hosts[0].identity_file.as_deref(), Some("C:\\x"));

        // Ein Wert darf selbst ein '=' enthalten; nur das eine Trennzeichen
        // nach dem Schluesselwort faellt weg.
        let hosts = parse("Host a\n  User = x=y\n");
        assert_eq!(hosts[0].user.as_deref(), Some("x=y"));
    }

    #[test]
    fn quoted_identity_file_with_spaces() {
        let hosts = parse(
            r#"Host win
  HostName "w.example"
  IdentityFile "C:\Users\Max Muster\.ssh\id_ed25519"
Host tilde
  IdentityFile "~/.ssh/id"
"#,
        );
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].hostname.as_deref(), Some("w.example"));
        assert_eq!(
            hosts[0].identity_file.as_deref(),
            Some(r"C:\Users\Max Muster\.ssh\id_ed25519"),
            "Anfuehrungszeichen fallen weg, einfache Backslashes bleiben stehen"
        );
        let tilde = hosts[1]
            .identity_file
            .as_deref()
            .expect("IdentityFile fehlt");
        assert!(
            !tilde.starts_with('~') && !tilde.contains('"'),
            "die Tilde muss auch in Anfuehrungszeichen aufgeloest werden: {tilde:?}"
        );
        assert!(tilde.ends_with("id"), "{tilde:?}");
    }

    #[test]
    fn negated_pattern_is_skipped() {
        assert_eq!(parse("Host !c\n  HostName h\n"), Vec::new());

        let hosts = parse("Host real\n  HostName r\nHost !c\n  User nobody\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
        assert_eq!(
            hosts[0].user, None,
            "eine Host-Zeile ohne konkretes Muster beendet den vorherigen Block"
        );
    }
}
