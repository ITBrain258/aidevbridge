//! Eine Ebene Unterverzeichnisse auf dem entfernten Rechner: das Fernskript
//! und die Auswertung seiner Ausgabe. Beides ohne SSH, ohne Tauri und ohne
//! Zustand -- deshalb hier und nicht in `commands.rs`.

/// Warum eine Ebene nicht gelesen werden konnte.
///
/// Drei unterschiedene Faelle statt eines: "kein Leserecht" ist auf einer
/// fremden VM der Normalfall und darf den Baum nicht abbrechen, waehrend
/// "gibt es nicht" den gespeicherten Pfad entwertet (Spec §6).
///
/// [`ListError::Failed`] ist bewusst KEIN vierter Grund, sondern das
/// Eingestaendnis, keinen zu kennen. Ohne ihn landete jede kuenftige,
/// hier noch unbekannte Antwort des Skripts bei `PermissionDenied` -- der
/// harmlosesten der drei Diagnosen, und damit derjenigen, die am
/// gruendlichsten in die Irre fuehrt.
#[derive(Debug)]
pub enum ListError {
    NotFound,
    NotADirectory,
    PermissionDenied,
    Failed,
}

/// Die Meldung ist ein MASCHINENLESBARES Kuerzel, keine Prosa: der
/// `#[tauri::command]` gibt sie als `Err(String)` an den WebView, und der
/// Baum muss die Faelle dort auseinanderhalten koennen, um den betroffenen
/// Knoten zu beschriften, ohne den Rest abzubrechen. Genau diese vier
/// Kuerzel sind die Werte, die `DirNode.error` im Frontend annimmt; die
/// uebersetzte Anzeige entsteht dort aus `en.json`.
///
/// Warum die Trennung scharf sein MUSS: derselbe `Err(String)` traegt auch
/// Prosa -- `"host not connected"` aus `list_directories_impl` und jeden
/// beliebigen Transportfehler. Nur solange die bekannten Kuerzel
/// ausschliesslich aus diesem `impl` stammen, kann das Frontend die beiden
/// Kanaele auseinanderhalten.
impl std::fmt::Display for ListError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ListError::NotFound => "notfound",
            ListError::NotADirectory => "notdir",
            ListError::PermissionDenied => "denied",
            ListError::Failed => "failed",
        })
    }
}

/// Eine gelesene Ebene: der tatsaechlich aufgeloeste Pfad und die Namen
/// (nicht Pfade) der Untereintraege.
#[derive(Debug)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<String>,
}

/// Das Fernskript. Der Pfad kommt als `$1` an -- als Positionsargument,
/// niemals in die Kommandozeile eingesetzt. `remote::build` kodiert es
/// zusaetzlich base64, ein Verzeichnisname kann also weder aus seinen
/// Anfuehrungszeichen ausbrechen noch als Option gelesen werden.
///
/// Leeres `$1` bedeutet Heimatverzeichnis (Spec §3.3): dieses Projekt
/// loest Tilden nirgends auf, und `build_in_dir` besteht per `assert!` auf
/// einem absoluten Pfad -- ohne diese Aufloesung muesste der Baum bei `/`
/// beginnen.
///
/// Bewusst POSIX statt `find -printf` (GNU): der Preflight prueft GNU-find
/// nicht, und ein Skript, das auf einer schlanken VM still nichts liefert,
/// waere schlimmer als eines, das eine Schleife braucht.
///
/// Der Pfad steht AUSSCHLIESSLICH geklammert (`${d}`), nirgends als
/// blankes `$d`. `das_skript_setzt_den_pfad_nie_in_die_kommandozeile_ein`
/// besteht darauf (`!contains("$d")`) -- wer hier "vereinfacht", macht
/// jenen Test rot. Die Klammern sind in POSIX bedeutungsgleich; sie sind
/// eine SCHREIBREGEL, deren Nutzen darin liegt, dass jede Verwendung des
/// Pfades an einer Stelle steht, die die Zusicherung sieht.
///
/// Bekannte Grenze: ein Verzeichnisname MIT ZEILENUMBRUCH bricht das
/// zeilenweise Protokoll. Nicht abgefangen -- kein realer Fall bekannt,
/// und ein laengenpraefigiertes Protokoll waere hier deutlich mehr
/// Maschinerie als Nutzen.
pub fn script() -> &'static str {
    r#"d=$1
[ -n "${d}" ] || d=$HOME
if [ ! -e "${d}" ]; then printf 'ERR notfound\n'; exit 0; fi
if [ ! -d "${d}" ]; then printf 'ERR notdir\n'; exit 0; fi
if [ ! -r "${d}" ] || [ ! -x "${d}" ]; then printf 'ERR denied\n'; exit 0; fi
cd -- "${d}" || { printf 'ERR denied\n'; exit 0; }
printf 'OK %s\n' "$(pwd)"
for e in ./* ./.*; do
  [ -d "$e" ] || continue
  b=${e#./}
  case "$b" in .|..) continue;; esac
  printf '%s\n' "$b"
done
"#
}

/// Wertet die Ausgabe von [`script`] aus.
///
/// Nur die drei BEKANNTEN Kuerzel werden einem Grund zugeordnet. Alles
/// andere -- eine kuenftige `ERR`-Art ebenso wie eine Ausgabe ohne
/// verwertbare Kopfzeile (leerer Datenstrom: das Skript ist gar nicht
/// gelaufen) -- faellt auf [`ListError::Failed`]. Es waere nicht ehrlicher,
/// sondern nur beruhigender, dafuer einen der drei Gruende zu behaupten.
pub fn parse(stdout: &str) -> Result<Listing, ListError> {
    let mut lines = stdout.lines();
    let head = lines.next().unwrap_or_default();
    if let Some(kind) = head.strip_prefix("ERR ") {
        return Err(match kind.trim() {
            "notfound" => ListError::NotFound,
            "notdir" => ListError::NotADirectory,
            "denied" => ListError::PermissionDenied,
            _ => ListError::Failed,
        });
    }
    let path = head
        .strip_prefix("OK ")
        .ok_or(ListError::Failed)?
        .to_string();
    Ok(Listing {
        path,
        // Task 7 (H6/H9): eine Zeile mit einem Steuerzeichen (NUL, ESC, ...)
        // kann in diesem zeilenweisen Protokoll nur von einem manipulierten
        // oder kaputten Fernaufruf stammen -- sie wird verworfen, statt roh
        // an das Frontend (und von dort potenziell weiter in eine
        // `remote::build`-Zeile, siehe `commands::list_directories_impl`)
        // durchgereicht zu werden. Die uebrigen Zeilen bleiben erhalten: ein
        // einzelner kaputter Eintrag darf die ganze Listung nicht verwerfen.
        entries: lines
            .filter(|l| !l.is_empty() && !l.chars().any(|c| c.is_control()))
            .map(str::to_string)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_liest_pfad_und_eintraege() {
        let out = "OK /home/u\nrepo\ndotfiles\n.cache\n";
        let l = parse(out).expect("gueltige Ausgabe");
        assert_eq!(l.path, "/home/u");
        assert_eq!(l.entries, vec!["repo", "dotfiles", ".cache"]);
    }

    #[test]
    fn parse_unterscheidet_die_drei_fehlerarten() {
        // Der Sinn der Unterscheidung: "kein Leserecht" ist auf einer
        // fremden VM der Normalfall und darf den Baum nicht abbrechen,
        // waehrend "gibt es nicht" den gespeicherten Pfad entwertet.
        assert!(matches!(parse("ERR notfound\n"), Err(ListError::NotFound)));
        assert!(matches!(
            parse("ERR notdir\n"),
            Err(ListError::NotADirectory)
        ));
        assert!(matches!(
            parse("ERR denied\n"),
            Err(ListError::PermissionDenied)
        ));
    }

    #[test]
    fn parse_akzeptiert_ein_leeres_verzeichnis() {
        let l = parse("OK /tmp/leer\n").expect("gueltige Ausgabe");
        assert_eq!(l.path, "/tmp/leer");
        assert!(l.entries.is_empty());
    }

    #[test]
    fn das_skript_setzt_den_pfad_nie_in_die_kommandozeile_ein() {
        // Der Pfad kommt als POSITIONSARGUMENT ($1), niemals interpoliert.
        // Genau das macht einen Verzeichnisnamen mit `;` oder `$(...)`
        // harmlos -- zusammen damit, dass `remote::build` jedes Argument
        // base64 kodiert.
        assert!(script().contains("$1"), "der Pfad muss ueber $1 ankommen");
        assert!(
            !script().contains("$d"), // ausschliesslich geklammert: ${d}
            "Platzhalter deuten auf Interpolation hin"
        );
    }

    #[test]
    fn parse_behauptet_bei_einer_unbekannten_antwort_keinen_grund() {
        // Eine kuenftige `ERR`-Art darf NICHT als "kein Leserecht"
        // durchgehen: das ist die harmloseste der drei Diagnosen und
        // fuehrt deshalb am gruendlichsten in die Irre.
        assert!(matches!(parse("ERR irgendwas\n"), Err(ListError::Failed)));
        // Dasselbe fuer eine Ausgabe ohne verwertbare Kopfzeile. Leer
        // heisst "das Skript ist gar nicht gelaufen", nicht "den Pfad gibt
        // es nicht" -- letzteres wuerde den Baum aufs Heimatverzeichnis
        // zurueckfallen lassen und den Grund verschweigen (Spec §5).
        assert!(matches!(parse(""), Err(ListError::Failed)));
        assert!(matches!(parse("voellig anderes\n"), Err(ListError::Failed)));
    }

    /// Task 7 (H6/H9): eine Zeile mit einem Steuerzeichen (hier NUL bzw.
    /// ESC) kann nur von einem Verzeichnisnamen stammen, den ein fremder
    /// Host oder ein manipuliertes Skript geliefert hat -- sie wird
    /// verworfen, statt roh weiterzureichen. Die uebrigen, harmlosen
    /// Zeilen bleiben erhalten: eine kaputte Zeile darf den Rest der
    /// Listung nicht mit sich reissen.
    #[test]
    fn eine_zeile_mit_steuerzeichen_wird_verworfen_die_uebrigen_bleiben() {
        let out = "OK /home/u\nrepo\nbo\0se\nprojekt\nesc\x1bape\ndotfiles\n";
        let l = parse(out).expect("gueltige Ausgabe");
        assert_eq!(l.entries, vec!["repo", "projekt", "dotfiles"]);
    }

    #[test]
    fn die_meldungen_sind_genau_die_kuerzel_auf_die_sich_der_baum_stuetzt() {
        // Task 2s `DirNode.error` ist genau diese Union. Ein Prosasatz
        // waere im Frontend nicht von einem Transportfehler oder von
        // "host not connected" zu unterscheiden -- beide reisen durch
        // dasselbe `Err(String)`.
        assert_eq!(ListError::NotFound.to_string(), "notfound");
        assert_eq!(ListError::NotADirectory.to_string(), "notdir");
        assert_eq!(ListError::PermissionDenied.to_string(), "denied");
        assert_eq!(ListError::Failed.to_string(), "failed");
    }

    // -----------------------------------------------------------------
    // Schritt 4b: das Skript WIRKLICH ausfuehren.
    //
    // Die vier Tests oben belegen die Auswertung und dass der Pfad ueber
    // `$1` ankommt. Sie sagen NICHTS darueber, ob das Skript tut, was es
    // soll -- dort ist es nur ein `&'static str`. Ein Fehler DARIN bliebe
    // unsichtbar, waehrend alle anderen Tests gruen stehen.
    // -----------------------------------------------------------------

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ab_dirs_{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Wo eine POSIX-`sh` gesucht wird, in dieser Reihenfolge.
    ///
    /// Die beiden festen Pfade sind kein Luxus: Git fuer Windows legt
    /// `sh.exe` unter `Git\usr\bin` bzw. `Git\bin` ab, in den PATH schreibt
    /// sein Installer aber nur `Git\cmd` -- und dort liegt keine `sh`. Aus
    /// einer PowerShell heraus gestartet findet `Command::new("sh")` also
    /// nichts, aus einer Git-Bash heraus schon. Ohne diesen Rueckfall
    /// haenge es an der Shell, aus der `cargo test` gestartet wurde, ob
    /// dieser Block ueberhaupt laeuft -- und ein uebersprungener Test sieht
    /// im Bericht aus wie ein bestandener.
    const SH_KANDIDATEN: &[&str] = &[
        "sh",
        r"C:\Program Files\Git\usr\bin\sh.exe",
        r"C:\Program Files\Git\bin\sh.exe",
    ];

    /// Fuehrt `script()` durch eine echte `sh` gegen `pfad` aus -- dieselbe
    /// Aufrufform wie auf der VM (`sh -c <skript> sh <pfad>`), nur ohne SSH
    /// dazwischen.
    ///
    /// `None` heisst: keine `sh` gefunden. Der Aufrufer ueberspringt dann
    /// mit sichtbarem Grund, statt rot zu werden -- eine fehlende Git-Bash
    /// ist kein Produktfehler. Jeder ANDERE Startfehler bricht ab: ein
    /// vorhandenes, aber unstartbares `sh` stillschweigend zu ueberspringen
    /// waere genau das Muster, gegen das dieser Block steht.
    fn run_sh(pfad: &str) -> Option<String> {
        for prog in SH_KANDIDATEN {
            match std::process::Command::new(prog)
                .arg("-c")
                .arg(script())
                .arg("sh")
                .arg(pfad)
                .output()
            {
                Ok(out) => return Some(String::from_utf8_lossy(&out.stdout).into_owned()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => panic!("{prog} liess sich nicht starten: {e}"),
            }
        }
        eprintln!(
            "UEBERSPRUNGEN: keine POSIX-sh gefunden (gesucht: {SH_KANDIDATEN:?}) -- das \
             Fernskript wurde NICHT ausgefuehrt, nur seine Zeichenkette geprueft"
        );
        None
    }

    fn run_script(dir: &std::path::Path) -> Option<String> {
        run_sh(dir.to_str().expect("Testpfad ist kein gueltiges UTF-8"))
    }

    #[test]
    fn skript_listet_verzeichnisse_und_keine_dateien() {
        let d = tmpdir("inhalt");
        std::fs::create_dir(d.join("src")).unwrap();
        std::fs::create_dir(d.join(".git")).unwrap();
        std::fs::write(d.join("README.md"), b"x").unwrap();

        let Some(out) = run_script(&d) else { return };
        let l = parse(&out).expect("gueltige Ausgabe");
        let mut got = l.entries.clone();
        got.sort();
        assert_eq!(got, vec![".git", "src"], "Dateien duerfen nicht erscheinen");
    }

    #[test]
    fn skript_meldet_ein_fehlendes_verzeichnis_als_notfound() {
        let d = tmpdir("fehlt").join("gibtesnicht");
        let Some(out) = run_script(&d) else { return };
        assert!(matches!(parse(&out), Err(ListError::NotFound)));
    }

    #[test]
    fn skript_meldet_eine_datei_als_notdir() {
        let d = tmpdir("keindir");
        let f = d.join("datei");
        std::fs::write(&f, b"x").unwrap();
        let Some(out) = run_script(&f) else { return };
        assert!(matches!(parse(&out), Err(ListError::NotADirectory)));
    }

    #[test]
    fn skript_loest_den_leeren_pfad_zum_heimatverzeichnis_auf() {
        let Some(out) = run_sh("") else { return };
        let l = parse(&out).expect("gueltige Ausgabe");
        assert!(
            l.path.starts_with('/'),
            "aufgeloester Pfad muss absolut sein: {}",
            l.path
        );
        assert!(!l.path.is_empty());
    }
}
