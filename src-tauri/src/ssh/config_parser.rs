// `serde::Serialize` (Task 13, Nachtrag): `suggest_hosts()` liefert diesen
// Typ direkt als `#[tauri::command]`-Rueckgabe an den WebView --
// Tauris IPC verlangt `Serialize` fuer jeden Rueckgabetyp (`IpcResponse`).
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
/// der echten `ssh_config` (u. a. `ProxyJump`, `Include`, `Match`) sind
/// bewusst nicht Gegenstand. Die Funktion liest nur den uebergebenen Text;
/// Datei-I/O passiert beim Aufrufer. Eine Ausnahme: `IdentityFile` loest
/// eine fuehrende Tilde gegen `dirs::home_dir()` auf (siehe
/// `resolve_identity_file`) -- das ist ein LOKALER Pfad, den nur dieser
/// Prozess selbst aufloesen kann, eine woertliche Tilde darf ihn nicht
/// verlassen.
///
/// Wildcard-Bloecke (`Host *`, oder Muster mit `?`) werden uebersprungen,
/// weil sie keinen konkreten Zielrechner benennen. Schluesselwort-Zeilen,
/// die vor dem ersten `Host` stehen, werden verworfen: In der echten
/// `ssh_config` gelten sie als globale Defaults fuer alle nachfolgenden
/// Hosts, aber dieser Parser erzeugt nur konkrete Vorschlaege pro Host und
/// hat keinen Host, dem er sie zuordnen koennte.
pub fn parse(text: &str) -> Vec<SshConfigHost> {
    let mut out: Vec<SshConfigHost> = Vec::new();
    // Ob die zuletzt gesehene Host-Zeile ein konkreter Alias war (und die
    // folgenden Schluesselwort-Zeilen damit `out.last_mut()` zugeordnet
    // werden duerfen). Bleibt `false`, solange noch kein Host gesehen wurde
    // oder der zuletzt gesehene Host ein Wildcard-Muster war.
    let mut in_named_host = false;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or_default().to_ascii_lowercase();
        let value = parts.next().unwrap_or_default().trim().to_string();

        match key.as_str() {
            "host" => {
                let is_wildcard = value.is_empty() || value.contains('*') || value.contains('?');
                if is_wildcard {
                    in_named_host = false;
                } else {
                    out.push(SshConfigHost {
                        alias: value,
                        hostname: None,
                        user: None,
                        port: None,
                        identity_file: None,
                    });
                    in_named_host = true;
                }
            }
            "hostname" if in_named_host => {
                if let Some(h) = out.last_mut() {
                    h.hostname = Some(value);
                }
            }
            "user" if in_named_host => {
                if let Some(h) = out.last_mut() {
                    h.user = Some(value);
                }
            }
            "port" if in_named_host => {
                if let Some(h) = out.last_mut() {
                    h.port = value.parse().ok();
                }
            }
            "identityfile" if in_named_host => {
                if let Some(h) = out.last_mut() {
                    h.identity_file = resolve_identity_file(&value);
                }
            }
            _ => {}
        }
    }
    out
}

/// Loest eine fuehrende `~/`-Tilde in einem `IdentityFile`-Wert gegen
/// `dirs::home_dir()` auf. Anders als Arbeitsverzeichnisse auf dem
/// ENTFERNTEN Rechner (dort MUSS der Pfad absolut sein und eine Tilde wird
/// nie aufgeloest, siehe `remote::command::build_in_dir`) ist ein
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
}
