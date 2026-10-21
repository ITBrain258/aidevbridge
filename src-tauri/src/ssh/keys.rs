//! Auflistung nutzbarer SSH-Schluessel in einem Verzeichnis (typischerweise
//! `~/.ssh`). Verbindliche Regel (Spec §8.2): AUSSCHLIESSLICH `.pub`-Dateien
//! werden geoeffnet. Der private Pfad wird nur ueber `Path::exists()`
//! geprueft, niemals gelesen -- eine Liste zu bauen ist kein Anlass,
//! Schluesselmaterial anzufassen. Derselbe Massstab, den dieses Projekt
//! seinen Tests fuer `~/.ssh/known_hosts` auferlegt, gilt hier im
//! Produktivpfad (siehe Testmodul, `ein_unlesbarer_privater_schluessel_
//! laesst_die_liste_stehen`).

use std::path::Path;

/// Ein in einem Verzeichnis gefundener, benutzbarer Schluessel: eine
/// `.pub`-Datei MIT vorhandenem privaten Gegenstueck (siehe `list_keys_in`).
///
/// `serde::Serialize` (wie `ssh::config_parser::SshConfigHost`): `list_ssh_keys`
/// liefert diesen Typ direkt als `#[tauri::command]`-Rueckgabe an den
/// WebView -- Tauris IPC verlangt `Serialize` fuer jeden Rueckgabetyp
/// (`IpcResponse`).
#[derive(serde::Serialize)]
pub struct SshKeyDto {
    /// Pfad der PRIVATEN Datei -- der Wert, den `HostSpecDto::key_path`
    /// erwartet. Nur ihre Existenz wird geprueft, ihr Inhalt nie gelesen.
    pub path: String,
    pub file_name: String,
    pub key_type: String,
    pub comment: String,
}

/// Rang fuer die Sortierung (Spec §9.2): `ed25519` vor `ecdsa` vor `rsa` vor
/// allem Uebrigen. Bewusst NICHT die von OpenSSH selbst dokumentierte
/// Reihenfolge -- Ziel ist, dass die staerkste vorhandene Art die
/// Vorauswahl in einer Dropdown-Liste ist: der ssh-agent-Fallback (leeres
/// Schluesselfeld) braucht unter Windows 11 Administratorrechte, weil der
/// Dienst dort standardmaessig deaktiviert ist, und ein guter Vorschlag
/// umgeht genau diese Falle (siehe `commands::list_ssh_keys`).
fn type_rank(key_type: &str) -> u8 {
    match key_type {
        "ed25519" => 0,
        "ecdsa" => 1,
        "rsa" => 2,
        _ => 3,
    }
}

/// Liest den Kurztyp aus dem OpenSSH-Praefix der `.pub`-Zeile
/// (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256` usw.). Unbekannte
/// Praefixe behalten ihren Rohwert -- besser ein unerwarteter String in der
/// Liste als eine stillschweigend verworfene Zeile.
fn short_type(prefix: &str) -> String {
    match prefix {
        "ssh-ed25519" => "ed25519".to_string(),
        "ssh-rsa" => "rsa".to_string(),
        p if p.starts_with("ecdsa-sha2-") => "ecdsa".to_string(),
        other => other.to_string(),
    }
}

/// Baut aus einer `.pub`-Datei einen `SshKeyDto`, wenn (a) sich ihre erste
/// Zeile in mindestens Typ und Schluesselwert aufspalten laesst UND (b) der
/// private Gegenpart existiert. Der private Pfad wird dafuer AUSSCHLIESSLICH
/// mit `Path::exists()` geprueft -- diese Funktion oeffnet ausser `pub_path`
/// keine weitere Datei.
fn read_pub_entry(pub_path: &Path, private_path: &Path, file_name: &str) -> Option<SshKeyDto> {
    if !private_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(pub_path).ok()?;
    let first_line = content.lines().next()?;
    let mut fields = first_line.split_whitespace();
    let prefix = fields.next()?;
    fields.next()?; // der Base64-Schluesselwert selbst, hier nicht gebraucht
    let comment = fields.next().unwrap_or("").to_string();

    Some(SshKeyDto {
        path: private_path.to_string_lossy().to_string(),
        file_name: file_name.to_string(),
        key_type: short_type(prefix),
        comment,
    })
}

/// Listet alle benutzbaren Schluessel in `dir`. "Benutzbar" heisst: eine
/// `.pub`-Datei MIT vorhandenem privaten Gegenstueck (Spec §8.2/§9.2).
/// Ein Verzeichnis, das nicht existiert oder nicht lesbar ist, liefert eine
/// leere Liste -- kein Fehlerfall fuer den Aufrufer (`commands::
/// list_ssh_keys`): ein frisches System ohne `~/.ssh` ist der Normalfall,
/// nicht die Ausnahme.
pub fn list_keys_in(dir: &Path) -> Vec<SshKeyDto> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut keys: Vec<SshKeyDto> = entries
        .flatten()
        .filter_map(|entry| {
            let pub_path = entry.path();
            let file_name = pub_path.file_name()?.to_str()?;
            let base_name = file_name.strip_suffix(".pub")?;
            let private_path = dir.join(base_name);
            read_pub_entry(&pub_path, &private_path, base_name)
        })
        .collect();

    keys.sort_by(|a, b| {
        type_rank(&a.key_type)
            .cmp(&type_rank(&b.key_type))
            .then_with(|| a.file_name.cmp(&b.file_name))
    });

    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ab_keys_{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &std::path::Path, name: &str, content: &str) {
        let mut f = std::fs::File::create(dir.join(name)).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    const PUB_ED: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAD1+Ea/eX8XGszB1Ee5udPD85hQSr6XBZCh4YIzFLng u@test-pc\n";

    #[test]
    fn liest_typ_und_kommentar_aus_der_pub_datei() {
        let d = tmpdir("typ");
        write(&d, "id_ed25519.pub", PUB_ED);
        write(&d, "id_ed25519", "PRIVAT-DARF-NIE-GELESEN-WERDEN");
        let keys = list_keys_in(&d);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].file_name, "id_ed25519");
        assert_eq!(keys[0].key_type, "ed25519");
        assert_eq!(keys[0].comment, "u@test-pc");
    }

    #[test]
    fn eine_pub_datei_ohne_privaten_gegenpart_erscheint_nicht() {
        let d = tmpdir("verwaist");
        write(&d, "verwaist.pub", PUB_ED);
        assert!(
            list_keys_in(&d).is_empty(),
            "eine .pub ohne zugehoerige private Datei ist kein benutzbarer Schluessel"
        );
    }

    #[test]
    fn ein_unlesbarer_privater_schluessel_laesst_die_liste_stehen() {
        // Der eigentliche Beleg dafuer, dass private Dateien NICHT geoeffnet
        // werden (Spec §8.2, Abnahmekriterium 7): der Inhalt ist absichtlich
        // kein gueltiger Schluessel. Wuerde die Umsetzung ihn oeffnen und
        // parsen, muesste dieser Test scheitern.
        let d = tmpdir("unlesbar");
        write(&d, "id_rsa.pub", "ssh-rsa AAAAB3NzaC1yc2EAAAA kommentar\n");
        write(&d, "id_rsa", "\u{0}\u{0}KEIN GUELTIGER SCHLUESSEL\u{0}");
        let keys = list_keys_in(&d);
        assert_eq!(
            keys.len(),
            1,
            "die Liste haengt nicht am Inhalt der privaten Datei"
        );
        assert_eq!(keys[0].key_type, "rsa");
    }

    #[test]
    fn sortiert_ed25519_vor_ecdsa_vor_rsa() {
        // Spec §9.2. Bewusst NICHT die dokumentierte OpenSSH-Reihenfolge.
        let d = tmpdir("reihenfolge");
        for (n, t) in [
            ("id_rsa", "ssh-rsa"),
            ("id_ed25519", "ssh-ed25519"),
            ("id_ecdsa", "ecdsa-sha2-nistp256"),
        ] {
            write(&d, &format!("{n}.pub"), &format!("{t} AAAAB3Nz k\n"));
            write(&d, n, "x");
        }
        let names: Vec<_> = list_keys_in(&d).into_iter().map(|k| k.file_name).collect();
        assert_eq!(names, vec!["id_ed25519", "id_ecdsa", "id_rsa"]);
    }
}
