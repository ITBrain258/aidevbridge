// rand 0.10 hat `random_range` von `Rng` in den Blanket-Trait `RngExt`
// verschoben (fuer jedes `R: Rng` automatisch implementiert, aber ohne
// expliziten Import nicht aufrufbar). Die oeffentliche Signatur bleibt
// `impl rand::Rng` -- exakt wie in der Vorgabe -- dieser Import bringt nur
// die Methode in den Scope.
use rand::RngExt as _;

/// Erzeugt `ab_<6-hex>`. Nur `[a-z0-9_]`, damit tmux' stille Zeichenersetzung
/// (Spec V13) nie greifen kann.
pub fn new_session_name(rng: &mut impl rand::Rng) -> String {
    let n: u32 = rng.random_range(0..0x100_0000);
    format!("ab_{n:06x}")
}

/// Die erlaubten Zeichen fuer einen SELBST GEWAEHLTEN Sessionnamen:
/// `A-Z`, `a-z`, `0-9`, Leerzeichen, `_` und `-`.
///
/// Eine ALLOWLIST, und das ist die ganze Pointe. Eine Denylist aus Spec V13
/// ("`.` und `:` werden ersetzt, `#{…}` wird abgelehnt") traegt nicht -- an
/// der VM gemessen (tmux 3.4, jeweils angelegt und per `#{session_name}`
/// zurueckgelesen):
///
/// | eingetippt | gespeichert |
/// |---|---|
/// | `zzr2#H` | `zzr2test-vm` -- der Hostname der VM |
/// | `zzr4##` | `zzr4#` |
/// | `zzqa#{x}` | `zzqa` |
/// | `zzs1#(touch /tmp/…)` | `zzs1` -- **und die Datei existierte danach** |
///
/// Also: `#{…}` wird auf 3.4 NICHT abgelehnt, sondern still expandiert;
/// `#S`/`#H`/`#W`/`##` sind weitere Formatsyntaxen, die eine Denylist mit
/// `#{` nicht kennt; und `#(…)` fuehrt ein Kommando auf dem Host aus. Das
/// verletzt `remote::build` nicht (der Transport haelt, Spec §8.2) -- tmux
/// expandiert selbst. Es hebt aber die Zusicherung auf, dass ein
/// Sessionname nur ein Name ist.
///
/// Zweiter Messwert, der die Liste so eng macht: ein `$` erzeugt eine
/// Session, die diese Anwendung weder oeffnen noch beenden kann. tmux
/// speichert `$zznew` als `\$zznew`; weder `attach -t '$zznew'` noch die
/// `=`-Form findet sie. Erreichbar waere sie nur ueber die interne
/// Session-ID, die diese Anwendung nie erfaehrt.
///
/// **Umlaute und Nicht-ASCII sind bewusst draussen**, obwohl sie auf 3.4
/// ueberleben: der Preflight laesst tmux >= 3.0 zu, und auf 3.3a werden sie
/// verstuemmelt. Ein Name, der je nach Serverversion anders heisst, ist
/// genau die stille Ueberraschung, die diese Pruefung verhindern soll.
/// Dass ein Name wie "buero-deploy" ohne Umlaut geschrieben werden muss, ist
/// der Preis, und er ist bewusst bezahlt.
pub fn session_name_is_acceptable(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-')
}

/// Der Satz, der die Regel NENNT, statt nur abzulehnen. Steht hier und nicht
/// in `commands.rs`, damit Regel und Erklaerung nicht auseinanderlaufen
/// koennen.
pub const SESSION_NAME_RULE: &str =
    "a session name may only contain letters A-Z a-z, digits, spaces, '_' and '-'";

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn name_matches_required_shape() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        for _ in 0..100 {
            let n = new_session_name(&mut rng);
            assert!(n.starts_with("ab_"));
            assert_eq!(n.len(), 9);
            assert!(n
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'));
        }
    }

    #[test]
    fn generated_names_pass_the_rule_for_typed_names() {
        // Sonst gaebe es zwei Namensbegriffe im selben System: einen, den
        // die Anwendung erzeugt, und einen, den sie akzeptiert.
        let mut rng = rand::rngs::StdRng::seed_from_u64(3);
        for _ in 0..100 {
            assert!(session_name_is_acceptable(&new_session_name(&mut rng)));
        }
    }

    #[test]
    fn the_rule_rejects_every_measured_hostile_form() {
        // Jeder Eintrag ist an der VM gemessen worden (siehe Doc-Kommentar).
        for hostile in [
            "zzr2#H",                   // -> Hostname der VM
            "zzr4##",                   // -> "zzr4#"
            "zzqa#{x}",                 // -> "zzqa"
            "zzs1#(touch /tmp/beweis)", // -> fuehrt ein Kommando aus
            "$zznew",                   // -> nicht mehr adressierbar
            "mit.punkt",                // -> tmux ersetzt still (V13)
            "mit:doppelpunkt",          // -> dito
            "b\u{00fc}ro",              // -> je nach Serverversion anders
            "",                         // -> leer ist kein Name
        ] {
            assert!(
                !session_name_is_acceptable(hostile),
                "haette abgelehnt werden muessen: {hostile:?}"
            );
        }
    }

    #[test]
    fn the_rule_accepts_the_forms_a_user_would_actually_type() {
        for ok in ["deploy", "Build 2", "feature-x", "log_tail", "abc123"] {
            assert!(
                session_name_is_acceptable(ok),
                "haette gelten muessen: {ok:?}"
            );
        }
    }

    #[test]
    fn name_never_contains_tmux_hostile_characters() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        for _ in 0..100 {
            let n = new_session_name(&mut rng);
            // tmux ersetzt '.' und ':' still durch '_' (Spec V13)
            assert!(!n.contains('.') && !n.contains(':'));
        }
    }
}
