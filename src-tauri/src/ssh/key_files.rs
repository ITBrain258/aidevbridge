//! Schluessel auf dem Geraet anlegen (Spec 2026-10-27 §5.3): einen neuen
//! ed25519-Schluessel erzeugen oder eine gewaehlte Schluesseldatei in den
//! `.ssh`-Ordner der App uebernehmen.
//!
//! Gebraucht auf Android: Dort gibt es weder `~/.ssh` des Nutzers noch einen
//! ssh-agent, und die Dateiauswahl liefert eine `content://`-URI, die nur
//! waehrend dieser Wahl lesbar ist. Beide Wege schreiben deshalb eine private
//! Datei und ihre `.pub` nach `paths::ssh_dir()`; `keys::list_keys_in` fuehrt
//! sie danach wie jeden anderen Schluessel. Der Desktop ruft beides nicht auf.
//!
//! Ausnahme von der Regel in `keys` (Spec §8.2, private Dateien nie lesen):
//! Die uebernommene Datei muss gelesen werden, sonst liesse sich weder ihre
//! Art pruefen noch die `.pub` ableiten. Der Inhalt liegt dabei nur in
//! `Zeroizing`-Puffern und geht unveraendert in die neue Datei.

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey};
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

use super::keys::SshKeyDto;

/// Groesser ist keine Schluesseldatei; schuetzt vor einer versehentlich
/// gewaehlten grossen Datei.
pub const MAX_KEY_FILE_BYTES: usize = 64 * 1024;

/// Erzeugter Schluessel: der Eintrag fuer die Liste und die Zeile fuer
/// `authorized_keys` auf dem Host.
#[derive(serde::Serialize)]
pub struct GeneratedKeyDto {
    pub key: SshKeyDto,
    pub public_key: String,
}

/// Erzeugt einen ed25519-Schluessel ohne Passphrase in `dir`: der private
/// Speicher der App ist nur ihr selbst zugaenglich, und eine Passphrase
/// muesste bei jeder Verbindung neu eingegeben werden. Der Name ist
/// `aidevbridge_ed25519`, bei Bedarf mit Zaehler.
pub fn generate_into(dir: &Path, comment: &str) -> Result<GeneratedKeyDto, String> {
    let mut key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|error| format!("could not generate a key: {error}"))?;
    key.set_comment(comment);
    let private = key
        .to_openssh(LineEnding::LF)
        .map_err(|error| format!("could not encode the key: {error}"))?;
    let public_key = key
        .public_key()
        .to_openssh()
        .map_err(|error| format!("could not encode the public key: {error}"))?;
    let path = write_pair(dir, "aidevbridge_ed25519", private.as_bytes(), &public_key)?;
    Ok(GeneratedKeyDto {
        key: dto(&path, "ed25519", comment),
        public_key,
    })
}

/// Uebernimmt den Text einer privaten Schluesseldatei nach `dir`. Angenommen
/// wird, was die Anmeldung spaeter laden kann: OpenSSH-Format, auch
/// verschluesselt, und die PEM-Formate, die `russh` unverschluesselt liest.
/// Der Name ist `imported_<art>`, bei Bedarf mit Zaehler.
pub fn import_into(dir: &Path, source: &[u8]) -> Result<SshKeyDto, String> {
    if source.len() > MAX_KEY_FILE_BYTES {
        return Err("The file is too large to be a private key".to_string());
    }
    let text = Zeroizing::new(
        std::str::from_utf8(source)
            .map_err(|_| "The file is not a private key".to_string())?
            .to_string(),
    );
    let public = public_key_of(&text)?;
    let key_type = super::keys::short_type(public.algorithm().as_str());
    let public_key = public
        .to_openssh()
        .map_err(|error| format!("could not encode the public key: {error}"))?;
    let comment = public.comment().as_str_lossy().to_string();
    let path = write_pair(
        dir,
        &format!("imported_{key_type}"),
        text.as_bytes(),
        &public_key,
    )?;
    Ok(dto(&path, &key_type, &comment))
}

/// Der oeffentliche Schluessel einer privaten Datei. Das OpenSSH-Format
/// traegt ihn auch verschluesselt im Klartext; die PEM-Formate nur im
/// verschluesselten Teil, verschluesselt werden sie deshalb abgelehnt.
fn public_key_of(text: &str) -> Result<russh::keys::PublicKey, String> {
    if let Ok(key) = PrivateKey::from_openssh(text) {
        return Ok(key.public_key().clone());
    }
    match russh::keys::decode_secret_key(text, None) {
        Ok(key) => Ok(key.public_key().clone()),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(
            "This key is encrypted in a PEM format; convert it with `ssh-keygen -p -f <file>` first"
                .to_string(),
        ),
        Err(_) => Err("The file is not a private key".to_string()),
    }
}

fn dto(path: &Path, key_type: &str, comment: &str) -> SshKeyDto {
    SshKeyDto {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        key_type: key_type.to_string(),
        comment: comment.to_string(),
    }
}

/// Schreibt die private Datei (nur fuer den Eigentuemer lesbar) und ihre
/// `.pub` unter dem ersten freien Namen `stem`, `stem_2`, ... Nie wird eine
/// vorhandene Datei ueberschrieben: `create_new` haelt beide Namen frei.
fn write_pair(
    dir: &Path,
    stem: &str,
    private: &[u8],
    public_line: &str,
) -> Result<PathBuf, String> {
    create_private_dir(dir)?;
    for n in 1..=99u32 {
        let name = if n == 1 {
            stem.to_string()
        } else {
            format!("{stem}_{n}")
        };
        let private_path = dir.join(&name);
        let public_path = dir.join(format!("{name}.pub"));
        if public_path.exists() {
            continue;
        }
        let mut file = match open_new_private(&private_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "could not write {}: {error}",
                    private_path.display()
                ))
            }
        };
        let written = file
            .write_all(private)
            .and_then(|()| file.sync_all())
            .and_then(|()| std::fs::write(&public_path, format!("{}\n", public_line.trim_end())));
        if let Err(error) = written {
            let _ = std::fs::remove_file(&private_path);
            let _ = std::fs::remove_file(&public_path);
            return Err(format!(
                "could not write {}: {error}",
                private_path.display()
            ));
        }
        return Ok(private_path);
    }
    Err(format!("no free file name for {stem} in {}", dir.display()))
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn open_new_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::keys::list_keys_in;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ab_key_files_{name}"));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_generated_key_lands_in_the_list_and_loads_without_passphrase() {
        let d = tmpdir("generate");
        let generated = generate_into(&d, "aidevbridge@phone").unwrap();
        assert_eq!(generated.key.file_name, "aidevbridge_ed25519");
        assert_eq!(generated.key.key_type, "ed25519");
        assert!(generated.public_key.starts_with("ssh-ed25519 "));
        assert!(generated.public_key.ends_with(" aidevbridge@phone"));
        let listed = list_keys_in(&d);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, generated.key.path);
        let text = std::fs::read_to_string(&generated.key.path).unwrap();
        assert!(russh::keys::decode_secret_key(&text, None).is_ok());
    }

    #[test]
    fn a_second_key_gets_the_next_free_name_and_nothing_is_overwritten() {
        let d = tmpdir("second");
        let first = generate_into(&d, "a").unwrap();
        let first_text = std::fs::read_to_string(&first.key.path).unwrap();
        let second = generate_into(&d, "b").unwrap();
        assert_eq!(second.key.file_name, "aidevbridge_ed25519_2");
        assert_eq!(
            std::fs::read_to_string(&first.key.path).unwrap(),
            first_text
        );
        assert_eq!(list_keys_in(&d).len(), 2);
    }

    #[test]
    fn an_imported_key_keeps_its_bytes_and_gets_a_derived_pub_file() {
        let source_dir = tmpdir("import_source");
        let generated = generate_into(&source_dir, "u@pc").unwrap();
        let bytes = std::fs::read(&generated.key.path).unwrap();
        let d = tmpdir("import");
        let imported = import_into(&d, &bytes).unwrap();
        assert_eq!(imported.file_name, "imported_ed25519");
        assert_eq!(imported.comment, "u@pc");
        assert_eq!(std::fs::read(&imported.path).unwrap(), bytes);
        let public = std::fs::read_to_string(d.join("imported_ed25519.pub")).unwrap();
        assert_eq!(public.trim_end(), generated.public_key);
    }

    #[test]
    fn an_encrypted_openssh_key_is_accepted_without_its_passphrase() {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let encrypted = key.encrypt(&mut rand::rng(), "secret").unwrap();
        let text = encrypted.to_openssh(LineEnding::LF).unwrap();
        let d = tmpdir("encrypted");
        let imported = import_into(&d, text.as_bytes()).unwrap();
        assert_eq!(imported.key_type, "ed25519");
        let loaded = std::fs::read_to_string(&imported.path).unwrap();
        assert!(russh::keys::decode_secret_key(&loaded, Some("secret")).is_ok());
    }

    #[test]
    fn anything_else_is_refused_and_leaves_no_file() {
        let d = tmpdir("refused");
        for source in [
            &b"ssh-ed25519 AAAA public only"[..],
            b"hello",
            &[0xff, 0xfe, 0x00],
        ] {
            assert!(import_into(&d, source).is_err());
        }
        assert!(import_into(&d, &vec![b'a'; MAX_KEY_FILE_BYTES + 1]).is_err());
        assert!(!d.exists() || std::fs::read_dir(&d).unwrap().next().is_none());
    }
}
