use anyhow::Context;
use base64::{
    engine::general_purpose::STANDARD, engine::general_purpose::STANDARD_NO_PAD, Engine as _,
};
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyDecision {
    /// Host und Key stehen so in known_hosts.
    Known,
    /// Fuer diesen Host gibt es keinen Eintrag — Rueckfrage beim Nutzer (TOFU).
    Unknown,
    /// Abweichender oder ausdruecklich gesperrter Key. Niemals
    /// stillschweigend akzeptieren oder per TOFU bestaetigen lassen.
    Mismatch,
}

/// Der Name, unter dem `known_hosts` einen Host fuehrt: bei Port 22 der Host
/// selbst, sonst `[host]:port` (auch ein IPv6-Literal). `lookup` und
/// `format_entry` suchen und schreiben unter diesem Namen, und die Meldung zu
/// einem geaenderten Schluessel (`commands::classify_connect_error`) nennt ihn,
/// damit der Nutzer den Eintrag zum Entfernen findet.
pub(crate) fn host_token(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

pub fn format_entry(host: &str, port: u16, key_type: &str, key_b64: &str) -> String {
    format!("{} {} {}", host_token(host, port), key_type, key_b64)
}

/// Haengt `line` an die Datei unter `path` an (TOFU-Nachtrag, Task 13:
/// Eigenschaft 4). Erstellt Datei und Elternverzeichnis, falls sie noch
/// nicht existieren.
///
/// Bestehende Zeilen werden NIE gelesen, veraendert oder neu geschrieben --
/// dieser Pfad oeffnet die Datei ausschliesslich mit `.append(true)`
/// (O_APPEND unter Unix, `FILE_APPEND_DATA` unter Windows): jeder
/// `write_all`-Aufruf haengt atomar an das JEWEILS aktuelle Dateiende an,
/// die Datei wird dabei nie verkuerzt oder neu geschrieben (kein
/// `truncate(true)`, kein Lesen-Modifizieren-Zurueckschreiben der
/// bestehenden Bytes).
///
/// Ein fehlender Zeilenumbruch am Dateiende wird VOR der neuen Zeile
/// ergaenzt -- sonst wuerde `line` mit der letzten bestehenden Zeile zu
/// einem ungueltigen, aus zwei Eintraegen verschmolzenen Eintrag
/// verschmelzen (siehe Testmodul, Gegenprobe
/// `missing_trailing_newline_would_merge_entries_without_the_fix`).
///
/// Nimmt bewusst KEINE `HostKeyDecision` entgegen -- der Aufrufer
/// (`commands::TofuPolicy::decide`) ruft diese Funktion nur im
/// `Unknown`-Zweig nach einer expliziten Nutzerzustimmung auf. Es gibt
/// hier keinen Parameter, ueber den ein `Mismatch` versehentlich denselben
/// Weg nehmen koennte (Eigenschaft 1 des TOFU-Nachtrags).
pub fn append_entry(path: &Path, line: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
    }

    // Reiner Lesezugriff, um zu pruefen, ob ein fuehrender Zeilenumbruch
    // noetig ist -- veraendert die Datei nicht. Eine fehlende Datei zaehlt
    // als "kein fuehrender Zeilenumbruch noetig" (die neue Zeile ist dann
    // die erste).
    let existing = std::fs::read(path).unwrap_or_default();
    let needs_leading_newline = !existing.is_empty() && !existing.ends_with(b"\n");

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("could not open {}", path.display()))?;

    let mut payload = String::new();
    if needs_leading_newline {
        payload.push('\n');
    }
    payload.push_str(line);
    payload.push('\n');

    file.write_all(payload.as_bytes())
        .with_context(|| format!("could not append to {}", path.display()))?;
    Ok(())
}

/// SHA256-Fingerabdruck im Format, das `ssh-keygen -lf` ausgibt (z. B.
/// `SHA256:cd4xJCbJywoyJ+atpjT31411tIy9KUZajEpme8VfVOc`) -- TOFU-Nachtrag
/// Eigenschaft 3: der Nutzer bekommt diesen kurzen, mit einer anderen
/// Quelle (Server-Admin, Cloud-Konsole) vergleichbaren String angezeigt,
/// NIEMALS den rohen Base64-Schluessel selbst (den vergleicht niemand von
/// Hand ueber 68+ Zeichen).
///
/// `key_b64` ist Standard-Base64 (wie es `known_hosts`-Zeilen und
/// `PublicKey::public_key_base64()` liefern); der Fingerabdruck ist SHA256
/// ueber die DEKODIERTEN Rohbytes, base64-kodiert OHNE Padding (wie
/// OpenSSH es tut -- kein `=` am Ende).
///
/// Liefert `Err`, wenn `key_b64` sich nicht einmal dekodieren laesst --
/// ein solcher Schluessel darf dem Nutzer nicht mit einem Platzhalter
/// ("?") zur Bestaetigung angezeigt werden, das waere eine blinde
/// Bestaetigungsaufforderung ohne vergleichbaren Inhalt (siehe Aufrufer:
/// `commands::TofuPolicy::decide` lehnt in diesem Fall sofort ab, statt zu
/// fragen).
pub fn fingerprint(key_b64: &str) -> anyhow::Result<String> {
    let raw = STANDARD
        .decode(key_b64)
        .context("host key is not valid base64 -- cannot compute a fingerprint")?;
    let digest = Sha256::digest(&raw);
    Ok(format!("SHA256:{}", STANDARD_NO_PAD.encode(digest)))
}

/// Prueft einen Host-Key gegen den Inhalt einer `known_hosts`-Datei.
///
/// Unterstuetzt mehrere durch Komma getrennte Aliase pro Zeile
/// (`host1,host2,1.2.3.4 ssh-ed25519 AAAA`), wie es echte `known_hosts`-
/// Dateien verwenden, wenn z. B. Hostname und IP denselben Key teilen.
///
/// Der Hostvergleich ist ASCII-case-insensitiv (wie bei OpenSSH: ein Eintrag
/// fuer `HOST.example` matcht eine Anfrage fuer `host.example`). Der
/// Key-Vergleich bleibt bewusst zeichengenau -- Base64 ist case-signifikant,
/// ein case-insensitiver Key-Vergleich waere ein Sicherheitsloch.
///
/// `@revoked`-Zeilen (siehe `sshd(8)`) markieren einen Key
/// fuer einen Host ausdruecklich als gesperrt. Der Marker wird erkannt und
/// abgetrennt, danach werden Host und Key normal verglichen. Passt Host
/// *und* Key einer `@revoked`-Zeile, ist das Ergebnis `Mismatch` -- niemals
/// `Known`, niemals `Unknown`, und zwar unabhaengig davon, ob an anderer
/// Stelle in derselben Datei eine Klartext-Zeile mit demselben Schluessel
/// steht (Revocation hat Vorrang vor jedem Known-Treffer). Ein Key, der von
/// der `@revoked`-Zeile nicht betroffen ist (anderer Key fuer denselben
/// Host), bleibt normal bewertbar -- die Sperre ist key-, nicht host-weit.
/// Enthaelt das Hostfeld jedoch nicht unterstuetzte Syntax (`*`, `?`, `!`
/// oder `|`), wird derselbe Typ/Key konservativ fuer ALLE Hosts und Ports
/// gesperrt, auch bei einem Klartext-Treffer in einer anderen Zeile.
/// Negierte Ausnahmen werden dabei nicht ausgewertet. Das kann legitime
/// Hosts mit demselben Key mit sperren; eine unklare Sperre darf weder als
/// `Known` durchgehen noch als `Unknown` zur TOFU-Bestaetigung gelangen.
/// `HostKeyDecision` hat bewusst genau drei Varianten: `Mismatch`
/// transportiert bereits "bekannt und nicht vertrauenswuerdig", deckt damit
/// auch einen gesperrten Key ab und loest dieselbe Behandlung aus wie ein
/// echter MITM-Verdacht. Eine eigene `Revoked`-Variante waere praeziser (z. B.
/// fuer eine spezifischere Nutzermeldung), ist aber nicht gebaut.
///
/// `@cert-authority`-Zeilen (CA-basiertes Vertrauen) werden nicht
/// unterstuetzt und komplett uebersprungen: sie zaehlen weder
/// als Treffer noch als "Host gesehen". Ein Host, der ausschliesslich per CA
/// vertraut wird, erscheint dadurch als `Unknown` statt `Known`.
///
/// Gehashte Hostfelder (`|1|salt|hash`, wie sie `HashKnownHosts yes` und
/// `ssh-keygen -H` schreiben) wertet `host_field_matches` wie OpenSSH aus:
/// ein gehashter Eintrag fuer den Host zaehlt wie ein
/// Klartexteintrag, ein anderer Key desselben Typs dahinter ist also
/// `Mismatch`, kein Erstkontakt. Das gilt fuer positive Zeilen; ein
/// gehashtes `@revoked`-Feld nimmt den konservativen Weg oben.
///
/// Ausserhalb davon bleiben Hostfelder woertliche Aliaslisten: Wildcards
/// (`*.example.com`, `?`) und Negation (`!`) werden nicht ausgewertet, ein
/// reiner Wildcard-Eintrag matcht keinen konkreten Hostnamen. Das ist eine
/// Kompatibilitaetsgrenze, keine vollstaendige OpenSSH-Host-Key-Pruefung.
pub fn lookup(
    known_hosts: &str,
    host: &str,
    port: u16,
    key_type: &str,
    key_b64: &str,
) -> HostKeyDecision {
    let token = host_token(host, port);
    let mut saw_host = false;
    let mut key_matched = false;
    let mut revoked_hit = false;

    for line in known_hosts.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let mut fields = line.split_whitespace();
        let Some(first) = fields.next() else {
            continue;
        };

        // `@cert-authority`: CA-basiertes Vertrauen wird nicht unterstuetzt.
        // Die Zeile wird komplett uebersprungen -- sie zaehlt weder als
        // Treffer noch als "Host gesehen".
        if first == "@cert-authority" {
            continue;
        }

        // `@revoked`: Marker abtrennen, danach normal weiterlesen.
        let (revoked, host_field) = if first == "@revoked" {
            let Some(h) = fields.next() else {
                continue;
            };
            (true, h)
        } else {
            (false, first)
        };

        let (Some(line_key_type), Some(k)) = (fields.next(), fields.next()) else {
            continue;
        };

        // Nicht auswertbare Sperr-Hostfelder duerfen denselben Key weder
        // durch einen positiven Eintrag noch durch TOFU freigeben. Bewusst
        // host-/portuebergreifend; siehe dokumentierte False-Positive-Policy.
        if revoked
            && line_key_type == key_type
            && k == key_b64
            && host_field.contains(['*', '?', '!', '|'])
        {
            revoked_hit = true;
            continue;
        }

        // Gehashte Felder zaehlen nur in positiven Zeilen: ein gehashtes
        // `@revoked`-Feld hat oben schon den konservativen Weg genommen, und
        // `ssh-keygen -H` hasht Markerzeilen nie.
        let host_matches = if revoked {
            literal_aliases_match(host_field, &token)
        } else {
            host_field_matches(host_field, &token)
        };
        if host_matches {
            if line_key_type != key_type {
                // Anderer Typ: zaehlt nicht als "diesen Schluessel gesehen".
                // Wie OpenSSH: ein neuer Typ ist ein neuer Schluessel, keine
                // MITM-Warnung (H8, Kritikrunde).
                continue;
            }
            saw_host = true;
            if k == key_b64 {
                if revoked {
                    revoked_hit = true;
                } else {
                    key_matched = true;
                }
            }
        }
    }

    // Reihenfolge nach Prioritaet: eine Revocation fuer genau den
    // praesentierten Key schlaegt jeden anderswo gefundenen Known-Treffer
    // (siehe Doc-Kommentar oben). Erst danach zaehlt ein regulaerer
    // Key-Treffer, dann der reine "Host gesehen"-Fallback.
    if revoked_hit {
        HostKeyDecision::Mismatch
    } else if key_matched {
        HostKeyDecision::Known
    } else if saw_host {
        HostKeyDecision::Mismatch
    } else {
        HostKeyDecision::Unknown
    }
}

/// Schluesseltypen, unter denen der Host bereits bekannt ist (fuer den
/// Hinweis in der TOFU-Rueckfrage, wenn der Server einen anderen Typ
/// anbietet als den/die in `known_hosts` hinterlegten -- H8, Kritikrunde:
/// `lookup` liefert fuer diesen Fall `Unknown`, nicht `Mismatch`, aber ein
/// Nutzer sollte trotzdem sehen koennen, dass der Host unter einem ANDEREN
/// Typ bereits bekannt war, statt einen voelligen Erstkontakt zu vermuten).
pub fn key_types_for(known_hosts: &str, host: &str, port: u16) -> Vec<String> {
    let token = host_token(host, port);
    let mut types = Vec::new();
    for line in known_hosts.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(host_field), Some(t)) = (fields.next(), fields.next()) else {
            continue;
        };
        if host_field_matches(host_field, &token) && !types.iter().any(|x| x == t) {
            types.push(t.to_string());
        }
    }
    types
}

/// Laenge des Salts in einem gehashten Hostfeld: die Ausgabe von HMAC-SHA1.
/// OpenSSH verwirft ein Feld mit anderer Saltlaenge.
const HASHED_HOST_SALT_LEN: usize = 20;

/// Passt ein Hostfeld aus `known_hosts` zum Namen `token` (`host_token`)?
///
/// Ein gehashter Eintrag `|1|salt|hash` (so schreiben `HashKnownHosts yes`
/// und `ssh-keygen -H` einen Host, je Zeile einen) passt, wenn HMAC-SHA1
/// ueber das klein geschriebene Token mit dem dekodierten Salt als
/// Schluessel den Hash ergibt. So rechnet auch OpenSSH (`hostfile.c`,
/// `host_hash`), das Namen vor dem Hashen klein schreibt. Ein solcher
/// Eintrag, der sich nicht lesen laesst (kein Hash, kein Base64, Salt nicht
/// 20 Bytes), passt nie; OpenSSH ueberspringt ihn ebenso.
///
/// Anders als OpenSSH zaehlt hier jeder Eintrag einer Kommaliste fuer sich,
/// gehasht oder woertlich (ASCII-case-insensitiv wie in
/// `literal_aliases_match`), so wie in russhs `match_hostname`. OpenSSH
/// (`match_maybe_hashed`) liest ein Feld, das mit `|` beginnt, als einen
/// einzigen Hash und schreibt gehashte Namen nie in eine Liste. Der Weg
/// hier behaelt jeden Treffer der frueheren, rein woertlichen Auswertung,
/// und ein gehashter Eintrag in einer Liste passt trotzdem nur, wenn sein
/// HMAC fuer genau dieses Token stimmt.
fn host_field_matches(host_field: &str, token: &str) -> bool {
    host_field
        .split(',')
        .any(|alias| match alias.strip_prefix("|1|") {
            Some(salt_and_hash) => hashed_name_matches(salt_and_hash, token),
            None => alias.eq_ignore_ascii_case(token),
        })
}

/// Die Kommaliste woertlicher Aliase, ASCII-case-insensitiv verglichen;
/// Hashes, Wildcards und Negation wertet sie nicht aus.
fn literal_aliases_match(host_field: &str, token: &str) -> bool {
    host_field
        .split(',')
        .any(|alias| alias.eq_ignore_ascii_case(token))
}

/// `salt|hash` hinter `|1|`: passt der HMAC-SHA1 des klein geschriebenen
/// Tokens? `verify_slice` vergleicht in konstanter Zeit und prueft die Laenge
/// des Hashs mit.
fn hashed_name_matches(salt_and_hash: &str, token: &str) -> bool {
    let Some((salt, hash)) = salt_and_hash.split_once('|') else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (STANDARD.decode(salt), STANDARD.decode(hash)) else {
        return false;
    };
    if salt.len() != HASHED_HOST_SALT_LEN {
        return false;
    }
    let Ok(mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
        return false;
    };
    mac.chain_update(token.to_ascii_lowercase().as_bytes())
        .verify_slice(&hash)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KH: &str = "\
192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEY1
[192.0.2.10]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEY2
";

    /// Der Name, unter dem eine `known_hosts`-Zeile den Host fuehrt: bei Port
    /// 22 der Host selbst, sonst `[host]:port` (auch fuer ein IPv6-Literal). Die
    /// Meldung zu einem geaenderten Schluessel nennt genau diesen Namen
    /// (`commands::classify_connect_error`), unter dem der Nutzer den Eintrag
    /// zum Entfernen findet -- `lookup` sucht mit demselben Token.
    #[test]
    fn host_token_is_the_name_a_known_hosts_line_uses() {
        assert_eq!(host_token("192.0.2.20", 22), "192.0.2.20");
        assert_eq!(host_token("vm.example", 22), "vm.example");
        assert_eq!(host_token("192.0.2.10", 2222), "[192.0.2.10]:2222");
        assert_eq!(host_token("fe80::1", 22), "fe80::1");
        assert_eq!(host_token("fe80::1", 2222), "[fe80::1]:2222");
        // Dasselbe Token steht vorn in der Zeile, die `format_entry` schreibt.
        assert!(format_entry("192.0.2.10", 2222, "ssh-ed25519", "KEY")
            .starts_with("[192.0.2.10]:2222 "));
    }

    #[test]
    fn known_key_is_accepted() {
        assert_eq!(
            lookup(
                KH,
                "192.0.2.20",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIKEY1"
            ),
            HostKeyDecision::Known
        );
    }

    #[test]
    fn nonstandard_port_uses_bracket_form() {
        assert_eq!(
            lookup(
                KH,
                "192.0.2.10",
                2222,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIKEY2"
            ),
            HostKeyDecision::Known
        );
    }

    #[test]
    fn unknown_host_is_unknown_not_known() {
        assert_eq!(
            lookup(
                KH,
                "192.0.2.1",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIKEYX"
            ),
            HostKeyDecision::Unknown
        );
    }

    #[test]
    fn changed_key_is_mismatch_not_unknown() {
        assert_eq!(
            lookup(
                KH,
                "192.0.2.20",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIOTHER"
            ),
            HostKeyDecision::Mismatch
        );
    }

    #[test]
    fn entry_format_matches_openssh() {
        assert_eq!(
            format_entry("192.0.2.20", 22, "ssh-ed25519", "AAAA"),
            "192.0.2.20 ssh-ed25519 AAAA"
        );
        assert_eq!(
            format_entry("h", 2222, "ssh-ed25519", "AAAA"),
            "[h]:2222 ssh-ed25519 AAAA"
        );
    }

    // known_hosts erlaubt mehrere durch Komma getrennte Aliase auf einer
    // Zeile (`host1,host2,1.2.3.4 ssh-ed25519 AAAA`). Dieser Test wuerde
    // fehlschlagen (Unknown statt Known), wenn `lookup` faelschlich nur den
    // ersten Alias vor dem Komma vergliche -- er prueft absichtlich einen
    // mittleren Alias, nicht den ersten.
    const KH_MULTI: &str = "jump,192.0.2.30,bastion ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEY3\n";

    #[test]
    fn comma_separated_aliases_all_match() {
        assert_eq!(
            lookup(
                KH_MULTI,
                "192.0.2.30",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIKEY3"
            ),
            HostKeyDecision::Known,
            "Match ueber einen mittleren Alias in einer Komma-Liste muss erkannt werden"
        );
    }

    // Ein veraenderter Key hinter einem Komma-Alias muss weiterhin als
    // Mismatch erkannt werden -- nicht als Unknown. Wuerde die
    // Komma-Aufspaltung `saw_host` nicht korrekt setzen, faellt dieser Test
    // faelschlich auf Unknown zurueck.
    #[test]
    fn comma_separated_alias_change_is_mismatch_not_unknown() {
        assert_eq!(
            lookup(
                KH_MULTI,
                "bastion",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIOTHER"
            ),
            HostKeyDecision::Mismatch
        );
    }

    // --- Gehashte Hostfelder (`|1|salt|hash`), ausgewertet wie OpenSSH ---
    //
    // `HashKnownHosts yes` (Standard unter Debian und Ubuntu) und
    // `ssh-keygen -H` schreiben den Host nur als HMAC-SHA1 mit Zufallssalt.
    // Beide Felder sind mit `ssh-keygen -F <host> -f <datei>` gegen OpenSSH
    // gegengeprueft (OpenSSH for Windows und OpenSSH 10.5p1): das erste ist
    // `node.example.test` (Salt 0x29..0x3c), das zweite
    // `[node.example.test]:2222` (Salt 0x15..0x28).
    const HASHED_NODE: &str = "|1|KSorLC0uLzAxMjM0NTY3ODk6Ozw=|PF+6EwBlzN80tHgE6xcOVDraMSU=";
    const HASHED_NODE_2222: &str = "|1|FRYXGBkaGxwdHh8gISIjJCUmJyg=|8t6nSWvT27FA1osycHmX2KTGecU=";
    const HASHED_OLD_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIHASHEDOLD";
    const HASHED_NEW_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIHASHEDNEW";

    fn hashed_line(field: &str, key_type: &str, key: &str) -> String {
        format!("{field} {key_type} {key}\n")
    }

    /// Der Kern der Auswertung: steht der Host nur gehasht in known_hosts, ist
    /// ein anderer Schluessel desselben Typs ein Wechsel (`Mismatch`,
    /// Abweisung ohne Rueckfrage), kein Erstkontakt.
    #[test]
    fn hashed_entry_with_another_key_is_mismatch_not_unknown() {
        let kh = hashed_line(HASHED_NODE, "ssh-ed25519", HASHED_OLD_KEY);
        assert_eq!(
            lookup(&kh, "node.example.test", 22, "ssh-ed25519", HASHED_NEW_KEY),
            HostKeyDecision::Mismatch,
            "ein gehashter Eintrag mit anderem Schluessel ist ein Wechsel, kein Erstkontakt"
        );
    }

    #[test]
    fn hashed_entry_with_the_same_key_is_known() {
        let kh = hashed_line(HASHED_NODE, "ssh-ed25519", HASHED_OLD_KEY);
        assert_eq!(
            lookup(&kh, "node.example.test", 22, "ssh-ed25519", HASHED_OLD_KEY),
            HostKeyDecision::Known
        );
    }

    /// Wie OpenSSH, das Hostnamen vor dem Hashen klein schreibt; der
    /// Klartextvergleich ist ohnehin case-insensitiv.
    #[test]
    fn hashed_entry_matches_the_host_in_any_case() {
        let kh = hashed_line(HASHED_NODE, "ssh-ed25519", HASHED_OLD_KEY);
        assert_eq!(
            lookup(&kh, "NODE.Example.test", 22, "ssh-ed25519", HASHED_NEW_KEY),
            HostKeyDecision::Mismatch
        );
    }

    /// Der Port gehoert zum gehashten Namen (`[host]:port`, siehe
    /// `host_token`): der Eintrag fuer Port 2222 gilt nicht fuer Port 22 und
    /// umgekehrt.
    #[test]
    fn hashed_entry_keeps_the_port_boundary() {
        let kh_2222 = hashed_line(HASHED_NODE_2222, "ssh-ed25519", HASHED_OLD_KEY);
        assert_eq!(
            lookup(
                &kh_2222,
                "node.example.test",
                2222,
                "ssh-ed25519",
                HASHED_NEW_KEY
            ),
            HostKeyDecision::Mismatch
        );
        assert_eq!(
            lookup(
                &kh_2222,
                "node.example.test",
                22,
                "ssh-ed25519",
                HASHED_NEW_KEY
            ),
            HostKeyDecision::Unknown
        );
        let kh_22 = hashed_line(HASHED_NODE, "ssh-ed25519", HASHED_OLD_KEY);
        assert_eq!(
            lookup(
                &kh_22,
                "node.example.test",
                2222,
                "ssh-ed25519",
                HASHED_NEW_KEY
            ),
            HostKeyDecision::Unknown
        );
    }

    /// Ein gehashter Eintrag fuer einen ANDEREN Host passt nicht, und er
    /// verdeckt den Klartexteintrag eines weiteren Hosts nicht.
    #[test]
    fn hashed_entry_for_another_host_neither_matches_nor_shadows_plaintext() {
        let kh = format!(
            "{}192.0.2.99 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPLAIN\n",
            hashed_line(HASHED_NODE, "ssh-ed25519", HASHED_OLD_KEY)
        );
        assert_eq!(
            lookup(&kh, "other.example.test", 22, "ssh-ed25519", HASHED_NEW_KEY),
            HostKeyDecision::Unknown
        );
        assert_eq!(
            lookup(
                &kh,
                "192.0.2.99",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIPLAIN"
            ),
            HostKeyDecision::Known
        );
    }

    /// Wie bei Klartext (H8): ein anderer Typ hinter dem gehashten Eintrag ist
    /// ein neuer Schluessel, kein Wechsel -- und die Rueckfrage nennt den
    /// schon bekannten Typ.
    #[test]
    fn hashed_entry_of_another_type_is_unknown_and_listed_as_known_type() {
        let kh = hashed_line(HASHED_NODE, "ecdsa-sha2-nistp256", "AAAAecdsa");
        assert_eq!(
            lookup(&kh, "node.example.test", 22, "ssh-ed25519", HASHED_NEW_KEY),
            HostKeyDecision::Unknown
        );
        assert_eq!(
            key_types_for(&kh, "node.example.test", 22),
            vec!["ecdsa-sha2-nistp256".to_string()]
        );
    }

    /// Wie OpenSSH (`ssh-keygen -F node.example.test` findet keines davon):
    /// andere Kennung als `1`, fehlender Hash, Salt kein Base64 und ein Salt
    /// mit 19 statt 20 Bytes (der Hash dazu ist richtig gerechnet).
    #[test]
    fn malformed_hashed_fields_never_match() {
        for field in [
            "|2|KSorLC0uLzAxMjM0NTY3ODk6Ozw=|PF+6EwBlzN80tHgE6xcOVDraMSU=",
            "|1|KSorLC0uLzAxMjM0NTY3ODk6Ozw=",
            "|1|!!!!|PF+6EwBlzN80tHgE6xcOVDraMSU=",
            "|1|KSorLC0uLzAxMjM0NTY3ODk6Ow==|jFkgiuRPv2VtQ9xlyovurnYUZU0=",
        ] {
            let kh = hashed_line(field, "ssh-ed25519", HASHED_OLD_KEY);
            for key in [HASHED_OLD_KEY, HASHED_NEW_KEY] {
                assert_eq!(
                    lookup(&kh, "node.example.test", 22, "ssh-ed25519", key),
                    HostKeyDecision::Unknown,
                    "{field}"
                );
            }
            assert!(
                key_types_for(&kh, "node.example.test", 22).is_empty(),
                "{field}"
            );
        }
    }

    /// OpenSSH liest ein Hostfeld, das mit `|` beginnt, als einen einzigen
    /// Hash und schreibt gehashte Namen nie in eine Kommaliste. Hier zaehlt
    /// jeder Eintrag der Liste fuer sich (`host_field_matches`): der
    /// woertliche Alias passt wie bisher, in beiden Reihenfolgen, und der
    /// gehashte passt nur auf genau sein Token (Host und Port).
    #[test]
    fn hashed_alias_in_a_comma_list_matches_only_its_exact_token() {
        for field in [
            format!("other.example.test,{HASHED_NODE}"),
            format!("{HASHED_NODE},other.example.test"),
        ] {
            let kh = hashed_line(&field, "ssh-ed25519", HASHED_OLD_KEY);
            for (host, port, key, expected) in [
                (
                    "other.example.test",
                    22,
                    HASHED_OLD_KEY,
                    HostKeyDecision::Known,
                ),
                (
                    "other.example.test",
                    22,
                    HASHED_NEW_KEY,
                    HostKeyDecision::Mismatch,
                ),
                (
                    "node.example.test",
                    22,
                    HASHED_OLD_KEY,
                    HostKeyDecision::Known,
                ),
                (
                    "node.example.test",
                    22,
                    HASHED_NEW_KEY,
                    HostKeyDecision::Mismatch,
                ),
                (
                    "node.example.test",
                    2222,
                    HASHED_OLD_KEY,
                    HostKeyDecision::Unknown,
                ),
                (
                    "third.example.test",
                    22,
                    HASHED_OLD_KEY,
                    HostKeyDecision::Unknown,
                ),
            ] {
                assert_eq!(
                    lookup(&kh, host, port, "ssh-ed25519", key),
                    expected,
                    "{field}: {host}:{port}"
                );
            }
        }
    }

    /// Ein gueltiger gehashter Eintrag neben einem Klartexteintrag fuer
    /// denselben Host mit anderem Schluessel (etwa eine Zeile von OpenSSH und
    /// eine im Klartext nachgetragene): beide Schluessel sind bekannt, ein
    /// dritter ist ein Wechsel, in beiden Reihenfolgen der Zeilen.
    /// `hashed_line_does_not_hide_plaintext_mismatch` unten deckt nur ein
    /// gehashtes Feld ab, das sich nicht dekodieren laesst.
    #[test]
    fn valid_hashed_and_plaintext_entries_for_the_same_host_are_both_known() {
        const PLAIN_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIPLAINNODE";
        let hashed = hashed_line(HASHED_NODE, "ssh-ed25519", HASHED_OLD_KEY);
        let plain = format!("node.example.test ssh-ed25519 {PLAIN_KEY}\n");
        for kh in [format!("{hashed}{plain}"), format!("{plain}{hashed}")] {
            for (key, expected) in [
                (HASHED_OLD_KEY, HostKeyDecision::Known),
                (PLAIN_KEY, HostKeyDecision::Known),
                (HASHED_NEW_KEY, HostKeyDecision::Mismatch),
            ] {
                assert_eq!(
                    lookup(&kh, "node.example.test", 22, "ssh-ed25519", key),
                    expected,
                    "{key}: {kh}"
                );
            }
        }
    }

    // Die eigentliche Gefahr: Eine gehashte Zeile
    // darf einen echten, im Klartext vorhandenen Mismatch nicht verdecken.
    // Steht neben der gehashten Zeile ein Klartext-Eintrag fuer denselben
    // Host mit einem anderen Key, MUSS das Ergebnis weiterhin Mismatch sein.
    // Dieser Test wuerde fehlschlagen (Unknown statt Mismatch), wenn eine
    // kuenftige Implementierung bei einer `|1|`-Zeile vorzeitig mit Unknown
    // zurueckkehrt, statt die restlichen Zeilen weiter zu pruefen.
    const KH_MIXED: &str = "\
|1|F1E1KeoE/eEWhi10WpGv36f/nJvC=|3Fnk7cKehtQ4gGYWpxXP6Voo2vY= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEYH
192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEY1
";

    #[test]
    fn hashed_line_does_not_hide_plaintext_mismatch() {
        assert_eq!(
            lookup(
                KH_MIXED,
                "192.0.2.20",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIOTHER"
            ),
            HostKeyDecision::Mismatch
        );
    }

    // format_entry und lookup muessen zueinander passen: Was der TOFU-Flow
    // schreibt, muss lookup beim naechsten Verbindungsversuch als Known
    // wiederfinden. Ohne diesen Test koennten beide Funktionen unabhaengig
    // "korrekt" bleiben, waehrend Nutzer bei jeder Verbindung erneut nach
    // Bestaetigung gefragt wuerden, weil die Token-Bildung auseinanderlaeuft.
    #[test]
    fn format_entry_round_trips_through_lookup() {
        for (host, port) in [("192.0.2.20", 22u16), ("h", 2222)] {
            let line = format_entry(host, port, "ssh-ed25519", "AAAA");
            assert_eq!(
                lookup(&line, host, port, "ssh-ed25519", "AAAA"),
                HostKeyDecision::Known,
                "von format_entry geschriebene Zeile muss von lookup als Known erkannt werden"
            );
        }
    }

    // --- Punkt 2 des Reviews: Hostvergleich muss case-insensitiv sein, ---
    // --- der Key-Vergleich ausdruecklich nicht.                        ---

    const KH_CASE: &str = "HOST.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEYC\n";

    #[test]
    fn host_comparison_is_case_insensitive() {
        assert_eq!(
            lookup(KH_CASE, "host.example", 22, "ssh-ed25519", "AAAAC3NzaC1lZDI1NTE5AAAAIKEYC"),
            HostKeyDecision::Known,
            "Hostvergleich muss ASCII-case-insensitiv erfolgen (wie bei OpenSSH), \
             sonst erscheint ein bekannter Host bei abweichender Gross-/Kleinschreibung als Unknown"
        );
    }

    #[test]
    fn key_comparison_stays_case_sensitive() {
        // Base64 ist case-signifikant. Nur der Hostvergleich wird
        // case-insensitiv (siehe oben) -- der Key-Vergleich ausdruecklich
        // nicht, sonst waere das ein Sicherheitsloch.
        assert_eq!(
            lookup(KH, "192.0.2.20", 22, "ssh-ed25519", "aaaac3nzac1lzdi1nte5aaaaikey1"),
            HostKeyDecision::Mismatch,
            "ein Key mit abweichender Gross-/Kleinschreibung darf nicht als Known akzeptiert werden"
        );
    }

    // --- Punkt 1 des Reviews: @revoked und @cert-authority. ---

    const KH_REVOKED: &str = "@revoked 192.0.2.40 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIREVOKED\n";

    // Gueltige oeffentliche Ed25519-Wegwerfschluessel, eigens fuer diese Tests
    // erzeugt; die privaten Teile sind verworfen.
    const REVOKED_KEY: &str =
        "AAAAC3NzaC1lZDI1NTE5AAAAIAD1+Ea/eX8XGszB1Ee5udPD85hQSr6XBZCh4YIzFLng";
    const OTHER_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIKx0DhpgHDEtznfG4ogHox1pOezWEVkWVz9zwbcrqHik";
    // Hash von node.example.test, im neutralen Review per ssh-keygen -F geprueft.
    const REVOKED_HOST_HASH: &str = "|1|AQIDBAUGBwgJCgsMDQ4PEBESExQ=|7XU5FTvdyNi5n/eSAt36r2y/0Tc=";
    const UNSUPPORTED_REVOCATION_HOSTS: &[&str] = &[
        "*",
        "*.example.test",
        "node.example.tes?",
        REVOKED_HOST_HASH,
        "!other.example.test",
        "!other.example.test,*.example.test",
        "other.example.test,*.example.test",
        "[*.example.test]:2222",
    ];

    #[test]
    fn unsupported_revocation_blocks_known_and_unknown_paths_in_either_line_order() {
        for host_field in UNSUPPORTED_REVOCATION_HOSTS {
            let revoked = format!("@revoked {host_field} ssh-ed25519 {REVOKED_KEY}\n");
            for port in [22, 2222] {
                let known = format_entry("node.example.test", port, "ssh-ed25519", REVOKED_KEY);
                for content in [
                    format!("{known}\n{revoked}"),
                    format!("{revoked}{known}\n"),
                    revoked.clone(),
                ] {
                    assert_eq!(
                        lookup(
                            &content,
                            "node.example.test",
                            port,
                            "ssh-ed25519",
                            REVOKED_KEY
                        ),
                        HostKeyDecision::Mismatch,
                        "unsupported @revoked host field {host_field:?}, port {port}: {content}"
                    );
                }
            }
        }
    }

    #[test]
    fn unsupported_revocation_only_blocks_the_same_key_and_type() {
        for host_field in UNSUPPORTED_REVOCATION_HOSTS {
            // Die falsche Typangabe bei identischen Key-Bytes prueft den
            // Typvergleich auch fuer eine inkonsistente known_hosts-Zeile.
            for (revoked_type, revoked_key) in
                [("ssh-ed25519", OTHER_KEY), ("ssh-rsa", REVOKED_KEY)]
            {
                let revoked = format!("@revoked {host_field} {revoked_type} {revoked_key}\n");
                let known = format_entry("node.example.test", 22, "ssh-ed25519", REVOKED_KEY);
                assert_eq!(
                    lookup(
                        &revoked,
                        "node.example.test",
                        22,
                        "ssh-ed25519",
                        REVOKED_KEY
                    ),
                    HostKeyDecision::Unknown
                );
                assert_eq!(
                    lookup(
                        &format!("{revoked}{known}\n"),
                        "node.example.test",
                        22,
                        "ssh-ed25519",
                        REVOKED_KEY
                    ),
                    HostKeyDecision::Known
                );
            }
        }
    }

    #[test]
    fn unsupported_revocation_conservatively_blocks_unrelated_or_excluded_hosts() {
        for host_field in [
            "*.unrelated.test",
            "*,!node.example.test",
            REVOKED_HOST_HASH,
        ] {
            let revoked = format!("@revoked {host_field} ssh-ed25519 {REVOKED_KEY}\n");
            for (host, port) in [("node.example.test", 22), ("other.test", 2222)] {
                assert_eq!(
                    lookup(&revoked, host, port, "ssh-ed25519", REVOKED_KEY),
                    HostKeyDecision::Mismatch,
                    "same-key fallback intentionally ignores host/port and negation: {host_field}"
                );
            }
        }
    }

    #[test]
    fn literal_revocation_preserves_alias_case_and_port_boundaries() {
        let revoked = format!(
            "@revoked [NODE.example.test]:2222,[alias.example.test]:2222 ssh-ed25519 {REVOKED_KEY}\n"
        );
        for (host, port, expected) in [
            ("node.example.test", 2222, HostKeyDecision::Mismatch),
            ("ALIAS.example.test", 2222, HostKeyDecision::Mismatch),
            ("node.example.test", 22, HostKeyDecision::Known),
            ("other.test", 2222, HostKeyDecision::Known),
        ] {
            let known = format_entry(host, port, "ssh-ed25519", REVOKED_KEY);
            for content in [format!("{known}\n{revoked}"), format!("{revoked}{known}\n")] {
                assert_eq!(
                    lookup(&content, host, port, "ssh-ed25519", REVOKED_KEY),
                    expected,
                    "literal revocation for {host}:{port}"
                );
            }
        }
    }

    #[test]
    fn revoked_marker_with_matching_key_is_mismatch_not_known_not_unknown() {
        assert_eq!(
            lookup(
                KH_REVOKED,
                "192.0.2.40",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIREVOKED"
            ),
            HostKeyDecision::Mismatch,
            "ein @revoked-markierter, exakt passender Key muss als Mismatch (gesperrt) erkannt werden"
        );
    }

    #[test]
    fn revoked_marker_with_different_presented_key_is_mismatch_via_normal_logic() {
        // Host passt (per @revoked-Zeile gesehen), aber der praesentierte Key
        // weicht vom gesperrten Key ab -> normale Mismatch-Logik (saw_host,
        // kein Known gefunden).
        assert_eq!(
            lookup(
                KH_REVOKED,
                "192.0.2.40",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIDIFFERENT"
            ),
            HostKeyDecision::Mismatch
        );
    }

    // Die eigentliche Gefahr: Ein Admin haengt eine Revocation an, ohne den
    // alten Klartext-Eintrag zu loeschen. Steht VOR der @revoked-Zeile ein
    // Klartext-Eintrag mit demselben Host und demselben (jetzt gesperrten)
    // Key, darf der fruehere Klartext-Treffer die Revocation nicht
    // verdecken -- das Ergebnis muss trotzdem Mismatch sein, nicht Known.
    const KH_PLAINTEXT_THEN_REVOKED_SAME_KEY: &str = "\
192.0.2.40 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIREVOKED
@revoked 192.0.2.40 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIREVOKED
";

    #[test]
    fn revoked_entry_overrides_earlier_plaintext_known_match_for_same_key() {
        assert_eq!(
            lookup(
                KH_PLAINTEXT_THEN_REVOKED_SAME_KEY,
                "192.0.2.40",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIREVOKED"
            ),
            HostKeyDecision::Mismatch,
            "eine Revocation muss auch dann greifen, wenn eine fruehere Klartext-Zeile \
             denselben Key bereits als Known bestaetigt hat -- Revoke hat Vorrang"
        );
    }

    // Gegenrichtung: Die Sperre ist key-spezifisch, nicht host-weit. Ein
    // ANDERER, nicht gesperrter Key fuer denselben Host muss weiterhin ganz
    // normal als Known durchgehen.
    const KH_REVOKED_OLD_KEY_PLUS_NEW_KEY: &str = "\
@revoked 192.0.2.41 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLDREV
192.0.2.41 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINEWGOOD
";

    #[test]
    fn revoked_marker_does_not_block_a_different_key_for_the_same_host() {
        assert_eq!(
            lookup(
                KH_REVOKED_OLD_KEY_PLUS_NEW_KEY,
                "192.0.2.41",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAINEWGOOD"
            ),
            HostKeyDecision::Known,
            "@revoked darf nur den konkret gesperrten Key betreffen, nicht den ganzen Host"
        );
    }

    // `@cert-authority`: CA-basiertes Vertrauen wird nicht unterstuetzt, die
    // Zeile wird uebersprungen. Ein Host, dessen einziger Eintrag eine
    // CA-Zeile ist, muss als Unknown erscheinen -- selbst wenn Host UND der
    // in der Zeile genannte Key exakt zur Anfrage passen. (Ein einfaches
    // Zuruecksetzen des Skips bleibt hier zufaellig gruen, weil das
    // Marker-Token "@cert-authority" selbst nie als Host matcht -- die
    // eigentliche Gefahr ist eine Implementierung, die den Marker abtrennt
    // und die Zeile wie einen normalen Eintrag behandelt.)
    const KH_CERT_AUTHORITY: &str =
        "@cert-authority ca.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICAKEY\n";

    #[test]
    fn cert_authority_line_is_skipped_not_treated_as_entry() {
        assert_eq!(
            lookup(
                KH_CERT_AUTHORITY,
                "ca.example.com",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAICAKEY"
            ),
            HostKeyDecision::Unknown,
            "@cert-authority-Zeilen duerfen nicht wie normale Eintraege behandelt werden \
             -- CA-Vertrauen wird nicht unterstuetzt"
        );
    }

    // --- Punkt 4 des Reviews: fehlende Abdeckung. ---

    // Zwei separate Zeilen fuer denselben Host (z. B. nach Key-Rotation, alte
    // Zeile noch nicht aufgeraeumt): Findet sich der praesentierte Key in
    // irgendeiner der Zeilen, muss das Ergebnis Known sein -- unabhaengig
    // davon, dass eine frueher gelesene Zeile fuer denselben Host nicht
    // passte.
    const KH_TWO_LINES_SAME_HOST: &str = "\
192.0.2.50 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLDKEY
192.0.2.50 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINEWKEY
";

    #[test]
    fn two_lines_for_same_host_one_matching_is_known() {
        assert_eq!(
            lookup(
                KH_TWO_LINES_SAME_HOST,
                "192.0.2.50",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAINEWKEY"
            ),
            HostKeyDecision::Known,
            "findet sich der praesentierte Key in irgendeiner Zeile fuer den Host, muss \
             das Ergebnis Known sein, auch wenn eine frueher gelesene Zeile nicht passte"
        );
    }

    // Wildcard-Patterns (`*.example.com`) werden nicht unterstuetzt: Das
    // Host-Feld wird woertlich (bis auf Gross-/Kleinschreibung) verglichen,
    // nicht als Glob interpretiert. Charakterisierungstest ohne entfernbare
    // Schutzmassnahme -- haelt die bewusste Einschraenkung
    // fest, statt einen konkreten Bug zu belegen.
    const KH_WILDCARD: &str = "*.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWILD\n";

    #[test]
    fn wildcard_host_pattern_is_not_supported_documented_limitation() {
        assert_eq!(
            lookup(
                KH_WILDCARD,
                "sub.example.com",
                22,
                "ssh-ed25519",
                "AAAAC3NzaC1lZDI1NTE5AAAAIWILD"
            ),
            HostKeyDecision::Unknown,
            "Wildcard-Host-Patterns werden nicht als Glob interpretiert -- \
             ein Eintrag '*.example.com' matcht keinen konkreten Hostnamen"
        );
    }

    // --- append_entry (TOFU-Nachtrag, Task 13) ---

    fn unique_temp_path(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("aidevbridge_test_known_hosts_{tag}_{nanos}"))
    }

    #[test]
    fn append_entry_creates_a_missing_file() {
        let path = unique_temp_path("create");
        assert!(!path.exists());
        append_entry(&path, "192.0.2.60 ssh-ed25519 AAAANEW").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "192.0.2.60 ssh-ed25519 AAAANEW\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn append_entry_preserves_existing_lines_and_appends_after_them() {
        let path = unique_temp_path("preserve");
        std::fs::write(&path, "192.0.2.20 ssh-ed25519 AAAAEXISTING\n").unwrap();
        append_entry(&path, "192.0.2.61 ssh-ed25519 AAAANEW").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            "192.0.2.20 ssh-ed25519 AAAAEXISTING\n192.0.2.61 ssh-ed25519 AAAANEW\n"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// Der eigentliche Beweis fuer Eigenschaft 4 des Nachtrags: fehlt der
    /// Zeilenumbruch am Dateiende, wird er VOR der neuen Zeile ergaenzt --
    /// sonst verschmilzt sie mit der letzten bestehenden Zeile zu einem
    /// einzigen, ungueltigen Eintrag. Gegenprobe: mit der
    /// `needs_leading_newline`-Pruefung entfernt, faellt dieser Test auf
    /// den verschmolzenen String zurueck und schlaegt fehl.
    #[test]
    fn append_entry_adds_a_missing_trailing_newline_before_the_new_line() {
        let path = unique_temp_path("no_trailing_newline");
        std::fs::write(&path, "192.0.2.20 ssh-ed25519 AAAAEXISTING").unwrap(); // kein \n am Ende
        append_entry(&path, "192.0.2.62 ssh-ed25519 AAAANEW").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content, "192.0.2.20 ssh-ed25519 AAAAEXISTING\n192.0.2.62 ssh-ed25519 AAAANEW\n",
            "ohne die Ergaenzung waeren die beiden Zeilen zu einer verschmolzen"
        );
        // Die urspruengliche Zeile muss als eigenstaendige, unveraenderte
        // Zeile wiederzufinden sein -- nicht als Praefix eines laengeren
        // verschmolzenen Strings.
        assert!(content
            .lines()
            .any(|l| l == "192.0.2.20 ssh-ed25519 AAAAEXISTING"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn append_entry_appended_line_round_trips_through_lookup_as_known() {
        let path = unique_temp_path("roundtrip_lookup");
        append_entry(
            &path,
            &format_entry("192.0.2.63", 22, "ssh-ed25519", "AAAART"),
        )
        .unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            lookup(&content, "192.0.2.63", 22, "ssh-ed25519", "AAAART"),
            HostKeyDecision::Known,
            "eine per append_entry geschriebene Zeile muss beim naechsten \
             Verbindungsversuch von lookup als Known erkannt werden"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn append_entry_multiple_calls_produce_independent_lines() {
        let path = unique_temp_path("multiple");
        append_entry(&path, "a ssh-ed25519 AAAA1").unwrap();
        append_entry(&path, "b ssh-ed25519 AAAA2").unwrap();
        append_entry(&path, "c ssh-ed25519 AAAA3").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            "a ssh-ed25519 AAAA1\nb ssh-ed25519 AAAA2\nc ssh-ed25519 AAAA3\n"
        );
        let _ = std::fs::remove_file(&path);
    }

    // --- fingerprint (TOFU-Nachtrag, Task 13) ---

    /// Bekannter, unabhaengig nachrechenbarer Vektor: SHA256("") base64
    /// (ohne Padding) ist der oft zitierte Konstantenwert
    /// "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" -- unabhaengig ueber
    /// `[Convert]::ToBase64String([SHA256]::Create().ComputeHash(@()))`
    /// nachgerechnet. `key_b64 = ""` dekodiert zu leeren
    /// Rohbytes, deren SHA256 genau dieser Wert ist.
    #[test]
    fn fingerprint_matches_known_sha256_of_empty_input() {
        assert_eq!(
            fingerprint("").unwrap(),
            "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"
        );
    }

    /// Gegen eine ECHTE, lokal per `ssh-keygen -t ed25519` erzeugte
    /// Testschluessel-Datei geprueft: `ssh-keygen -lf` auf dem `.pub`
    /// lieferte "256 SHA256:cd4xJCbJywoyJ+atpjT31411tIy9KUZajEpme8VfVOc
    /// fp_test (ED25519)" fuer genau den Base64-Block unten. Das ist die
    /// geforderte Eigenschaft ("SHA256 in der Form, die ssh-keygen -lf
    /// ausgibt"), nicht nur eine interne Selbstkonsistenzpruefung.
    #[test]
    fn fingerprint_matches_real_ssh_keygen_lf_output() {
        let key_b64 = "AAAAC3NzaC1lZDI1NTE5AAAAIGnfcsdz52gqKOHZgB/zulihJmeJX1n9qFxHiNvGwoE4";
        assert_eq!(
            fingerprint(key_b64).unwrap(),
            "SHA256:cd4xJCbJywoyJ+atpjT31411tIy9KUZajEpme8VfVOc"
        );
    }

    #[test]
    fn fingerprint_rejects_undecodable_base64_instead_of_a_placeholder() {
        // "!!!!" ist kein gueltiges Base64-Alphabet -- ein Schluessel, der
        // sich nicht dekodieren laesst, darf nicht mit einem Platzhalter
        // ("?") zur Bestaetigung angeboten werden (siehe Doc-Kommentar).
        assert!(fingerprint("!!!!").is_err());
    }

    // --- H8 (Kritikrunde): ein anderer Schluesseltyp am selben Host ist ---
    // --- ein neuer Schluessel, kein Mismatch -- wie bei OpenSSH.        ---

    #[test]
    fn same_type_different_key_is_mismatch() {
        let kh = "192.0.2.20 ssh-ed25519 AAAAknown\n";
        assert_eq!(
            lookup(kh, "192.0.2.20", 22, "ssh-ed25519", "AAAAother"),
            HostKeyDecision::Mismatch
        );
    }

    #[test]
    fn other_type_for_known_host_is_unknown_not_mismatch() {
        // OpenSSH behandelt einen neuen Schluesseltyp als neuen Schluessel,
        // nicht als Wechsel: known_hosts kennt nur ecdsa, der Server bietet
        // ed25519.
        let kh = "192.0.2.20 ecdsa-sha2-nistp256 AAAAecdsa\n";
        assert_eq!(
            lookup(kh, "192.0.2.20", 22, "ssh-ed25519", "AAAAed"),
            HostKeyDecision::Unknown
        );
        assert_eq!(
            key_types_for(kh, "192.0.2.20", 22),
            vec!["ecdsa-sha2-nistp256".to_string()]
        );
    }

    #[test]
    fn matching_type_and_key_is_known() {
        let kh = "192.0.2.20 ssh-ed25519 AAAAknown\n";
        assert_eq!(
            lookup(kh, "192.0.2.20", 22, "ssh-ed25519", "AAAAknown"),
            HostKeyDecision::Known
        );
    }
}
