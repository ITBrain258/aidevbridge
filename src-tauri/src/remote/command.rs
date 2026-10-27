use base64::{engine::general_purpose::STANDARD, Engine as _};

/// Bricht ab, wenn `argv` leer ist.
///
/// `exec` ohne Argumente ist in der POSIX-Shell ein No-Op: Die Zeile waere
/// syntaktisch gueltig und liefe mit Exit 0 durch, ohne irgendetwas
/// auszufuehren. Ein Aufruferfehler (z. B. ein leerer Kommandovektor) bliebe
/// damit unsichtbar. Deshalb `assert!` statt `debug_assert!` -- die Pruefung
/// muss auch im Release-Profil bestehen bleiben.
///
/// Diese und die uebrigen `assert!`s in dieser Datei sind Programmier-
/// Invarianten fuer die fest verdrahteten Literale ihrer Aufrufer (`"git"`,
/// `"tmux"`, ...), keine Eingabevalidierung mehr: Hostdaten, die ein Nutzer
/// oder ein fremder tmux liefern kann (`cwd`, `path`, Sessionnamen), werden an
/// der Command-Grenze in `commands.rs` geprueft (H6/H9), BEVOR sie hierher
/// gelangen -- ein Panic hier wuerde den Tauri-`invoke` haengen lassen, statt
/// dem WebView ein `Err(...)` zu liefern.
#[track_caller]
fn assert_argv_not_empty(argv: &[&str]) {
    assert!(
        !argv.is_empty(),
        "argv darf nicht leer sein: `exec` ohne Argumente ist ein No-Op und \
         liefert Exit 0, ein Aufruferfehler bliebe damit unsichtbar (Spec §8.2)"
    );
}

/// Baut den Praeludium-Teil: Zuweisungen `A<n>=...`, die jedes Argument
/// base64-dekodiert in eine Shell-Variable schreiben. `offset` verschiebt
/// die Nummerierung, damit `build_in_dir` `A0` fuer das Verzeichnis belegen
/// kann.
fn encode_prelude(argv: &[&str], offset: usize) -> String {
    let mut prelude = String::new();
    for (i, arg) in argv.iter().enumerate() {
        assert!(
            !arg.contains('\0'),
            "Argument enthaelt ein eingebettetes NUL-Byte: Shell-Variablenwerte \
             sind intern NUL-terminierte C-Strings, der Wert wuerde bei \
             `A<n>=$(... | base64 -d)` still an der NUL-Stelle abgeschnitten \
             (Spec §8.2)"
        );
        let var = format!("A{}", i + offset);
        prelude.push_str(&format!(
            " {var}=$(printf %s '{}' | base64 -d);",
            STANDARD.encode(arg)
        ));
    }
    prelude
}

/// Baut den Aufrufteil `"$A<offset>" "$A<offset+1>" ...` fuer `count`
/// Argumente.
fn call_args(count: usize, offset: usize) -> String {
    let mut call = String::new();
    for i in 0..count {
        call.push_str(&format!(" \"$A{}\"", i + offset));
    }
    call
}

/// Baut eine Shell-Zeile, in der jedes Argument base64-transportiert wird.
///
/// Das Base64-Alphabet (A–Z a–z 0–9 + / =) enthaelt kein Shell-Metazeichen.
/// Ein kodierter Wert kann die einfachen Anfuehrungszeichen, in denen er
/// steht, deshalb per Konstruktion nicht verlassen. Siehe Spec §8.2.
pub fn build(argv: &[&str]) -> String {
    assert_argv_not_empty(argv);
    let prelude = encode_prelude(argv, 0);
    let call = call_args(argv.len(), 0);
    format!("set -eu;{prelude} exec{call}")
}

/// Wie [`build`], wechselt aber vorher in ein absolutes Verzeichnis.
/// Das Verzeichnis liegt in `A0`, die Argumente beginnen bei `A1`.
///
/// Vorgesehen fuer `cd -- "$REPO" && git worktree add` (Gesamtspec §8.2,
/// Anforderung A5) und noch ohne Produktaufrufer. Das Arbeitsverzeichnis
/// einer Session laeuft NICHT hierueber, sondern als Argument von
/// `tmux new-session -c` durch [`build`]; dessen Regel "absoluter Pfad"
/// prueft die Command-Grenze in `commands.rs`.
pub fn build_in_dir(cwd: &str, argv: &[&str]) -> String {
    assert!(
        cwd.starts_with('/'),
        "Pfade muessen absolut sein (Spec §8.2)"
    );
    assert_argv_not_empty(argv);
    let dir_prelude = encode_prelude(&[cwd], 0);
    let prelude = encode_prelude(argv, 1);
    let call = call_args(argv.len(), 1);
    format!("set -eu;{dir_prelude} cd -- \"$A0\";{prelude} exec{call}")
}

/// Dekodiert eine von [`build`] erzeugte Zeile zurueck in ihr `argv`.
///
/// Nur fuer Tests, und bewusst hier statt in jedem Testmodul erneut: der
/// ganze Sinn von [`build`] ist, dass an der fertigen Zeile nicht mehr
/// abzulesen ist, WELCHES Argument abgeschickt wird. Genau das muessen aber
/// mehrere Testmodule pruefen (`tmux::client`, `transport::russh_transport`),
/// seit das Zielargument ein `=` traegt, das ein Tippfehler still wieder
/// entfernen koennte.
///
/// Fuer [`build_in_dir`] steht das Verzeichnis als erstes Element mit drin.
#[cfg(test)]
pub fn decoded_argv(line: &str) -> Vec<String> {
    line.split("printf %s '")
        .skip(1)
        .map(|s| s.split('\'').next().unwrap())
        .map(|b64| String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    /// Zieht die base64-Nutzlasten aus einer erzeugten Kommandozeile.
    fn payloads(line: &str) -> Vec<String> {
        line.split("printf %s '")
            .skip(1)
            .map(|s| s.split('\'').next().unwrap().to_string())
            .collect()
    }

    #[test]
    fn plain_argument_is_base64_transported() {
        let line = build(&["echo", "hallo"]);
        assert!(line.starts_with("set -eu;"));
        assert!(line.contains("base64 -d"));
        assert!(
            !line.contains("hallo"),
            "Rohwert darf nicht im Klartext stehen"
        );
    }

    #[test]
    fn shell_metacharacters_cannot_escape() {
        let evil = "a';touch /tmp/pwned;'";
        let line = build(&["git", "checkout", evil]);

        // 1. Der Rohwert taucht nirgends in der Kommandozeile auf.
        assert!(
            !line.contains(evil),
            "Rohwert steht unmaskiert in der Zeile"
        );
        assert!(
            !line.contains("touch"),
            "Nutzlast erscheint als Kommandotext"
        );

        // 2. Er kommt beim Dekodieren trotzdem unveraendert wieder heraus.
        let p = payloads(&line);
        assert_eq!(p.len(), 3, "drei Argumente, drei Nutzlasten");
        let decoded = String::from_utf8(STANDARD.decode(&p[2]).unwrap()).unwrap();
        assert_eq!(decoded, evil, "Wert muss verlustfrei ankommen");
    }

    #[test]
    fn base64_alphabet_only_for_payloads() {
        let line = build(&["tmux", "new-session", "-s", "feat|x$(id)"]);
        for b64 in payloads(&line) {
            assert!(
                b64.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='),
                "Payload enthaelt Nicht-Base64-Zeichen: {b64}"
            );
        }
    }

    #[test]
    fn build_in_dir_prepends_absolute_cd_and_shifts_arg_indices() {
        let line = build_in_dir("/home/u/repo", &["git", "status"]);
        assert!(line.contains("cd -- \"$A0\""), "Verzeichnis liegt in A0");
        assert!(
            line.contains("\"$A1\" \"$A2\""),
            "Argumente beginnen bei A1"
        );
        let p = payloads(&line);
        assert_eq!(
            String::from_utf8(STANDARD.decode(&p[0]).unwrap()).unwrap(),
            "/home/u/repo"
        );
    }

    #[test]
    #[should_panic(expected = "absolut")]
    fn relative_path_is_rejected() {
        let _ = build_in_dir("relativ/pfad", &["ls"]);
    }

    #[test]
    #[should_panic(expected = "argv darf nicht leer sein")]
    fn build_with_empty_argv_panics() {
        let _ = build(&[]);
    }

    #[test]
    #[should_panic(expected = "argv darf nicht leer sein")]
    fn build_in_dir_with_empty_argv_panics() {
        let _ = build_in_dir("/home/u/repo", &[]);
    }

    #[test]
    #[should_panic(expected = "NUL-Byte")]
    fn argument_with_embedded_nul_is_rejected() {
        let _ = build(&["git", "checkout", "ok\0evil"]);
    }

    #[test]
    #[should_panic(expected = "NUL-Byte")]
    fn cwd_with_embedded_nul_is_rejected_in_build_in_dir() {
        let _ = build_in_dir("/ho\0me", &["ls"]);
    }
}
