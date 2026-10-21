//! `Keymap` (Task 12): trennt Tastenkombinationen, die der App gehoeren, von
//! allem, was dem Terminal gehoert (Spec §7.4).
//!
//! Alles Einfache geht ans Terminal -- auch `Strg+C` und `Strg+V`, wie ein
//! Agent-CLI es erwartet. Die App reagiert auf `Strg+Umschalt+...`-Akkorde
//! und auf genau vier einfache `Strg`-Tasten (`PLAIN_CTRL_KEYS`). Das ist
//! keine willkuerliche Wahl, sondern die Konvention von Windows Terminal/VS
//! Code: eine einzelne `Strg`- oder `Alt`-Kombination zu beanspruchen wuerde
//! die Terminal-Treue verletzen, die dieses Projekt an erster Stelle
//! garantiert (Spec A1). `validate` lehnt deshalb eine solche Belegung ab --
//! sie wird nicht bloss gemeldet und trotzdem akzeptiert.
//!
//! Jede Belegung ist frei konfigurierbar (Spec §12.1, `[keymap]` in
//! `settings.toml`); dieses Modul kennt `SettingsStore` (Task 13) noch nicht
//! und ist bewusst davon unabhaengig -- es validiert eine beliebige
//! `HashMap<Aktion, Belegung>`, unabhaengig davon, woher sie stammt.

use std::collections::{HashMap, HashSet};

/// Die drei Modifikator-Namen, die diese Belegungssprache kennt. Bewusst
/// keine Aliase (`"control"`, `"cmd"`, `"meta"`) und kein eigener
/// Tastennamen-Validator -- das waere mehr Oberflaeche, als Spec §7.4
/// verlangt.
const MODIFIERS: [&str; 3] = ["ctrl", "shift", "alt"];

fn is_modifier(token: &str) -> bool {
    MODIFIERS.contains(&token)
}

/// Die Ausnahmeliste (UX-Ueberarbeitung, Spec §8.3): `Strg` ohne Umschalt und
/// ohne Alt gehoert der App genau fuer diese Tasten. xterm.js 6 erzeugt fuer
/// sie keine Terminaleingabe (`Keyboard.ts`), die App nimmt also keinem
/// Programm im Terminal etwas weg. Das sind die Kuerzel `Strg+,` (Einstellungen)
/// und die Schriftgroesse (`Strg+=`, `Strg+-`, `Strg+0`). Jede andere Taste
/// hinter `Strg` bleibt dem Terminal vorbehalten (auch `Strg+1` bis `Strg+9`),
/// solange nicht belegt ist, dass xterm fuer sie nichts erzeugt.
///
/// Lowercase wie die Tasten nach `canonicalize`. `isReservedForApp` in
/// `src/keymap.ts` muss dieselbe Liste fuehren.
const PLAIN_CTRL_KEYS: [&str; 4] = [",", "=", "-", "0"];

/// Pfeiltasten-Alias, lowercase auf beiden Seiten (nach dem Lowercasing in
/// `canonicalize` unten angewendet). Deckungsgleich mit `ARROW_KEY_NAMES` in
/// `src/keymap.ts`, wo ein echtes `KeyboardEvent` `event.key === "ArrowUp"`
/// zu `"Up"` normalisiert (Spec-Schreibweise) -- ohne diesen Alias HIER
/// wuerde `canonicalize("Ctrl+Shift+ArrowUp")` einen anderen `comparison_key`
/// liefern als `canonicalize("Ctrl+Shift+Up")`, obwohl ein echter Tastendruck
/// auf der Pfeiltaste-hoch IMMER `"Up"` erzeugt, nie `"ArrowUp"` (Task 12,
/// Review-Befund: `validate` wuerde sonst eine tote Belegung zertifizieren
/// -- gueltig laut Validierung, aber durch keinen echten Tastendruck jemals
/// auszuloesen). Betrifft `DEFAULT_KEYMAP` nicht (die nutzt bereits `"Up"`/
/// `"Down"`), wird aber relevant, sobald Task 13 freie Nutzerkonfiguration
/// aus `settings.toml` erlaubt -- dieses Modul validiert eine solche
/// Konfiguration bereits jetzt, unabhaengig von `SettingsStore` selbst.
const ARROW_KEY_ALIASES: [(&str, &str); 4] = [
    ("arrowup", "up"),
    ("arrowdown", "down"),
    ("arrowleft", "left"),
    ("arrowright", "right"),
];

fn resolve_key_alias(token: &str) -> String {
    ARROW_KEY_ALIASES
        .iter()
        .find(|(alias, _)| *alias == token)
        .map(|(_, canonical)| (*canonical).to_string())
        .unwrap_or_else(|| token.to_string())
}

/// Eine Belegung in kanonischer Form: Modifikatoren sortiert und dedupliziert
/// (Gross-/Kleinschreibung und Reihenfolge im Eingabetext duerfen keine
/// Rolle spielen -- `"Shift+Ctrl+F"` und `"ctrl+shift+f"` sind dieselbe
/// physische Tastenkombination), plus genau eine Nicht-Modifikator-Taste.
struct Canonical {
    mods: Vec<String>,
    key: String,
}

impl Canonical {
    /// String-Form fuer den Duplikat-Vergleich, z. B. `"ctrl+shift+f"`.
    fn comparison_key(&self) -> String {
        if self.mods.is_empty() {
            self.key.clone()
        } else {
            format!("{}+{}", self.mods.join("+"), self.key)
        }
    }
}

/// Zerlegt eine Belegung in Modifikatoren und die eigentliche Taste.
/// `None`, wenn keine genau eine Nicht-Modifikator-Taste uebrig bleibt --
/// das deckt sowohl den leeren String als auch eine reine
/// Modifikator-Belegung wie `"Ctrl+Shift"` (kein Ziel zum Draufdruecken) ab.
fn canonicalize(binding: &str) -> Option<Canonical> {
    let parts: Vec<String> = binding
        .split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect();

    let (mut mods, keys): (Vec<String>, Vec<String>) =
        parts.into_iter().partition(|part| is_modifier(part));
    if keys.len() != 1 {
        return None;
    }
    mods.sort();
    mods.dedup();
    let key = resolve_key_alias(&keys.into_iter().next().expect("checked len == 1"));
    Some(Canonical { mods, key })
}

/// Gehoert `binding` der App (Ctrl+Shift+... oder Ctrl mit einer Taste der
/// Ausnahmeliste `PLAIN_CTRL_KEYS`), oder ist es dem Terminal vorbehalten? Ein
/// unparsbarer oder Modifikator-only-Wert gehoert per Definition NICHT der App
/// -- er ist schlicht keine gueltige Belegung.
///
/// Wichtig: das Ergebnis haengt nur von den Modifikatoren (und bei Strg allein
/// von der Taste) ab, nicht davon, ob `binding` gerade an eine bekannte Aktion
/// gebunden ist. Der gesamte Ctrl+Shift-Tastenraum gehoert der App, auch ein
/// (noch) unbelegter Akkord -- sonst waere die Grenze von der aktuellen
/// Konfiguration abhaengig statt fest (das Frontend-Gegenstueck `isAppChord`
/// in `src/keymap.ts` verlaesst sich auf genau diese Eigenschaft).
///
/// Strg ohne Umschalt und ohne Alt gehoert der App nur fuer die vier Tasten
/// der Ausnahmeliste (Spec §8.3); jede andere Taste hinter Strg, jedes
/// Strg+Alt und jedes Alt bleibt beim Terminal.
///
/// Review-Befund (Task 12): die urspruengliche Fassung pruefte "enthaelt
/// Ctrl UND Shift" (`mods.iter().any(...) && mods.iter().any(...)`) statt
/// "besteht ausschliesslich aus Ctrl+Shift". `"Ctrl+Alt+Shift+F"` enthaelt
/// beides und wurde deshalb faelschlich als App-Akkord akzeptiert, obwohl
/// er drei Modifikatoren traegt. Da `mods` bereits sortiert und dedupliziert
/// ist (siehe `canonicalize`), ist "die Menge ist EXAKT {ctrl, shift}"
/// gleichbedeutend mit "Laenge 2 UND beide enthalten" -- ein zusaetzliches
/// drittes Element (`alt`) faellt damit durch, ohne dass `alt` hier namentlich
/// ausgeschlossen werden muss. `"meta"`/`"cmd"` sind ohnehin kein erkannter
/// Modifikator-Token (siehe `MODIFIERS` oben) und fuehren bereits in
/// `canonicalize` zu `None` (zweite Nicht-Modifikator-"Taste").
pub fn is_reserved_for_app(binding: &str) -> bool {
    match canonicalize(binding) {
        Some(c) => {
            let ctrl_shift = c.mods.len() == 2
                && c.mods.iter().any(|m| m == "ctrl")
                && c.mods.iter().any(|m| m == "shift");
            // `mods` ist sortiert und dedupliziert: "genau [ctrl]" schliesst
            // Umschalt und Alt gleichermassen aus.
            let plain_ctrl = c.mods == ["ctrl"] && PLAIN_CTRL_KEYS.contains(&c.key.as_str());
            ctrl_shift || plain_ctrl
        }
        None => false,
    }
}

/// Prueft eine gesamte Belegungstabelle (Aktion -> Belegung). Lehnt ab, statt
/// nur zu warnen (Spec §7.4): eine einzelne Ctrl- oder Alt-Kombination
/// gehoert dem Terminal (bis auf die vier Tasten der Ausnahmeliste,
/// `PLAIN_CTRL_KEYS`), eine doppelt vergebene Belegung ist mehrdeutig. Beide
/// Faelle machen die Konfiguration ungueltig, nicht bloss
/// verbesserungswuerdig.
pub fn validate(bindings: &HashMap<String, String>) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // Deterministische Reihenfolge: `HashMap`-Iteration ist es nicht, und
    // ohne Sortierung wuerde ein Test mit mehreren ungueltigen Belegungen
    // von Lauf zu Lauf ein anderes `problems[0]` sehen.
    let mut entries: Vec<(&str, &str)> = bindings
        .iter()
        .map(|(action, binding)| (action.as_str(), binding.as_str()))
        .collect();
    entries.sort();

    for (action, binding) in entries {
        match canonicalize(binding) {
            None => {
                problems.push(format!(
                    "{binding} is not a usable key combination (action {action}); \
                     needs exactly one non-modifier key"
                ));
            }
            Some(canonical) => {
                if !is_reserved_for_app(binding) {
                    problems.push(format!(
                        "{binding} would take a key away from the terminal (action {action}); \
                         use Ctrl+Shift+..."
                    ));
                }
                if !seen.insert(canonical.comparison_key()) {
                    problems.push(format!("{binding} is assigned twice"));
                }
            }
        }
    }

    problems.sort();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_ctrl_bindings_are_rejected() {
        // Strg+Buchstabe gehoert dem Terminal: Strg+C ist ^C, Strg+V ein
        // Steuerzeichen fuer die Shell. Frei sind nur die vier Tasten der
        // Ausnahmeliste (`plain_ctrl_with_comma_equals_minus_or_zero_is_accepted`).
        for binding in ["Ctrl+N", "Ctrl+A", "Ctrl+C", "Ctrl+V"] {
            let mut m = HashMap::new();
            m.insert("session.next".to_string(), binding.to_string());
            let err = validate(&m).unwrap_err();
            assert!(err[0].contains(binding), "{binding}: {err:?}");
        }
    }

    #[test]
    fn plain_ctrl_with_comma_equals_minus_or_zero_is_accepted() {
        // xterm.js 6 erzeugt fuer diese vier Tasten keine Terminaleingabe
        // (`Keyboard.ts`), also nimmt die App sie (Spec §8.3).
        for binding in ["Ctrl+,", "Ctrl+=", "Ctrl+-", "Ctrl+0"] {
            let mut m = HashMap::new();
            m.insert("settings.open".to_string(), binding.to_string());
            assert!(validate(&m).is_ok(), "{binding}");
            assert!(is_reserved_for_app(binding), "{binding}");
        }
    }

    #[test]
    fn the_plain_ctrl_exception_covers_exactly_four_keys() {
        // Jedes druckbare ASCII-Zeichen (ohne Leerzeichen) als Taste hinter
        // Strg: nur `,` `=` `-` und `0` gehoeren der App. Die Liste ist
        // bewusst eng; die Nachbarn (`Ctrl+1`, `Ctrl+.`, `Ctrl+9`, `Ctrl+/`
        // ...) brauchen jeweils einen eigenen Beleg, bevor sie dazukommen.
        for key in '!'..='~' {
            let binding = format!("Ctrl+{key}");
            let expected = matches!(key, ',' | '=' | '-' | '0');
            assert_eq!(is_reserved_for_app(&binding), expected, "{binding}");
        }
    }

    #[test]
    fn the_exception_keys_are_matched_regardless_of_case_and_spacing() {
        assert!(is_reserved_for_app("ctrl+,"));
        assert!(is_reserved_for_app("CTRL+0"));
        assert!(is_reserved_for_app(" Ctrl + - "));
    }

    #[test]
    fn ctrl_alt_or_alt_with_an_exception_key_is_still_rejected() {
        // Strg+Alt ist AltGr auf deutscher Tastatur (`Ctrl+Alt+0` liefe auf
        // `}`), und Alt+... bleibt dem Terminal (Meta-Praefix).
        for binding in [
            "Ctrl+Alt+0",
            "Ctrl+Alt+,",
            "Ctrl+Alt+=",
            "Ctrl+Alt+-",
            "Alt+,",
            "Alt+0",
            "Alt+-",
            "Shift+,",
            "Ctrl+Alt+Shift+0",
        ] {
            assert!(!is_reserved_for_app(binding), "{binding}");
            let mut m = HashMap::new();
            m.insert("settings.open".to_string(), binding.to_string());
            let err = validate(&m).unwrap_err();
            assert!(err[0].contains(binding), "{binding}: {err:?}");
            assert!(
                err[0].contains("would take a key away from the terminal"),
                "{binding}: {err:?}"
            );
        }
    }

    #[test]
    fn the_exception_keys_take_part_in_duplicate_detection() {
        let mut m = HashMap::new();
        m.insert("settings.open".to_string(), "Ctrl+,".to_string());
        m.insert("other".to_string(), "ctrl+,".to_string());
        let err = validate(&m).unwrap_err();
        assert!(err.iter().any(|p| p.contains("assigned twice")), "{err:?}");

        // Dieselbe Taste mit Umschalt ist eine andere Belegung.
        let mut m = HashMap::new();
        m.insert("settings.open".to_string(), "Ctrl+,".to_string());
        m.insert("other".to_string(), "Ctrl+Shift+,".to_string());
        assert!(validate(&m).is_ok());
    }

    #[test]
    fn exception_keys_and_ctrl_shift_chords_validate_together() {
        let mut m = HashMap::new();
        m.insert("settings.open".to_string(), "Ctrl+,".to_string());
        m.insert("quickOpen".to_string(), "Ctrl+Shift+P".to_string());
        m.insert("session.next".to_string(), "Ctrl+Shift+Down".to_string());
        assert!(validate(&m).is_ok());
    }

    #[test]
    fn ctrl_shift_bindings_are_accepted() {
        let mut m = HashMap::new();
        m.insert("session.next".to_string(), "Ctrl+Shift+Down".to_string());
        assert!(validate(&m).is_ok());
    }

    #[test]
    fn duplicate_bindings_are_reported() {
        let mut m = HashMap::new();
        m.insert("a".to_string(), "Ctrl+Shift+F".to_string());
        m.insert("b".to_string(), "Ctrl+Shift+F".to_string());
        assert!(validate(&m).is_err());
    }

    #[test]
    fn plain_alt_bindings_are_rejected() {
        // Auch eine einzelne Alt-Kombination wird abgelehnt, nicht nur Strg
        // (siehe Moduldoku) -- die drei Vorgabetests oben pruefen nur Ctrl.
        let mut m = HashMap::new();
        m.insert("session.next".to_string(), "Alt+F".to_string());
        let err = validate(&m).unwrap_err();
        assert!(err[0].contains("Alt+F"));
    }

    #[test]
    fn modifier_order_does_not_evade_duplicate_detection() {
        // "Shift+Ctrl+F" und "Ctrl+Shift+F" sind dieselbe physische Taste --
        // eine Belegungstabelle, die beide vergibt, ist trotzdem doppelt
        // vergeben, nicht zwei verschiedene Belegungen.
        let mut m = HashMap::new();
        m.insert("a".to_string(), "Ctrl+Shift+F".to_string());
        m.insert("b".to_string(), "Shift+Ctrl+F".to_string());
        let err = validate(&m).unwrap_err();
        assert!(err.iter().any(|p| p.contains("assigned twice")));
    }

    #[test]
    fn case_does_not_evade_duplicate_detection() {
        let mut m = HashMap::new();
        m.insert("a".to_string(), "Ctrl+Shift+F".to_string());
        m.insert("b".to_string(), "ctrl+shift+f".to_string());
        let err = validate(&m).unwrap_err();
        assert!(err.iter().any(|p| p.contains("assigned twice")));
    }

    #[test]
    fn modifier_only_binding_is_rejected() {
        // "Ctrl+Shift" allein hat keine Zieltaste -- kein gueltiger Akkord,
        // egal wie gross- oder kleingeschrieben.
        let mut m = HashMap::new();
        m.insert("session.next".to_string(), "Ctrl+Shift".to_string());
        assert!(validate(&m).is_err());
    }

    #[test]
    fn multiple_distinct_ctrl_shift_bindings_all_pass() {
        let mut m = HashMap::new();
        m.insert("clipboard.copy".to_string(), "Ctrl+Shift+C".to_string());
        m.insert("clipboard.paste".to_string(), "Ctrl+Shift+V".to_string());
        m.insert("search.local".to_string(), "Ctrl+Shift+F".to_string());
        assert!(validate(&m).is_ok());
    }

    #[test]
    fn is_reserved_for_app_true_for_ctrl_shift_regardless_of_order_or_case() {
        assert!(is_reserved_for_app("Ctrl+Shift+Down"));
        assert!(is_reserved_for_app("Shift+Ctrl+F"));
        assert!(is_reserved_for_app("ctrl+shift+f"));
    }

    #[test]
    fn is_reserved_for_app_false_for_plain_ctrl_or_alt() {
        assert!(!is_reserved_for_app("Ctrl+N"));
        assert!(!is_reserved_for_app("Alt+B"));
        // Ctrl+Alt ohne Shift bleibt dem Terminal vorbehalten -- nur die
        // Kombination aus BEIDEN, Ctrl UND Shift, gehoert der App.
        assert!(!is_reserved_for_app("Ctrl+Alt+F"));
    }

    #[test]
    fn is_reserved_for_app_false_for_ctrl_alt_shift() {
        // Review-Befund (Task 12): die alte Pruefung fragte "enthaelt Ctrl
        // UND Shift", nicht "besteht ausschliesslich aus Ctrl+Shift" --
        // "Ctrl+Alt+Shift+F" enthaelt beides und wurde deshalb faelschlich
        // als App-Akkord akzeptiert. Auf einer AltGr-Tastatur (deutsches
        // Layout u.a.) liefert AltGr+Umschalt auf ALTEREN Chromium-Versionen
        // genau diese Kombination (ctrlKey=true, altKey=true, shiftKey=true,
        // siehe Forschungsnotiz im TS-Gegenstueck) -- ein solcher Akkord darf
        // nicht der App gehoeren, sonst verschwindet das erzeugte Zeichen
        // ersatzlos (kein Ziel in `matchAction`, aber `preventDefault()`
        // hat bereits gefeuert).
        assert!(!is_reserved_for_app("Ctrl+Alt+Shift+F"));
    }

    #[test]
    fn plain_ctrl_alt_shift_binding_is_rejected() {
        let mut m = HashMap::new();
        m.insert("session.next".to_string(), "Ctrl+Alt+Shift+F".to_string());
        let err = validate(&m).unwrap_err();
        assert!(err[0].contains("Ctrl+Alt+Shift+F"));
    }

    #[test]
    fn is_reserved_for_app_ignores_the_exact_key_spelling() {
        // WICHTIG, was dieser Test NICHT prueft: `is_reserved_for_app`
        // inspiziert nur `mods`, nie `key` -- diese Assertion waere auch
        // OHNE den Alias-Fix (Befund 3) wahr (per Gegenprobe bestaetigt:
        // Mutation der Alias-Aufloesung in `canonicalize` liess genau
        // DIESEN Test gruen). Die tatsaechliche Absicherung fuer den Alias
        // ist die Duplikaterkennung unten (`validate` mit "Up" UND
        // "ArrowUp" gleichzeitig) -- dieser Test dokumentiert nur, dass
        // "ArrowUp" als Tastenname keine Sonderbehandlung in dieser
        // Funktion ausloest.
        assert!(is_reserved_for_app("Ctrl+Shift+ArrowUp"));
    }

    #[test]
    fn arrow_key_alias_is_detected_as_duplicate_of_the_spec_spelling() {
        let mut m = HashMap::new();
        m.insert("session.prev".to_string(), "Ctrl+Shift+Up".to_string());
        m.insert("session.next".to_string(), "Ctrl+Shift+ArrowUp".to_string());
        let err = validate(&m).unwrap_err();
        assert!(err.iter().any(|p| p.contains("assigned twice")));
    }

    #[test]
    fn is_reserved_for_app_false_for_modifier_only_or_empty() {
        assert!(!is_reserved_for_app("Ctrl+Shift"));
        assert!(!is_reserved_for_app(""));
    }
}
