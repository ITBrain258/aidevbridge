// Kuerzel fuer das Hostquadrat (UI-v2-Spec §7.3). Traegt nur Identitaet,
// keinen Zustand; das Element dazu ist `aria-hidden`, der Name steht daneben.
//
// Regel: Alias an `-`, `_`, `.` und Leerzeichen teilen; reine Ziffernteile
// sind keine Wortteile.
//  (a) Wortteile vorhanden und letzter Teil reine Ziffern -> Anfangsbuchstabe
//      des letzten Wortteils plus letzte Ziffer   (vm-build-01 -> B1)
//  (b) sonst zwei oder mehr Wortteile -> Anfangsbuchstaben der ersten zwei
//                                                  (dev-box -> DB)
//  (c) genau ein Wortteil -> dessen erste zwei Zeichen (dev -> DE)
//  (d) keine Wortteile -> erste zwei Zeichen des Alias (2024 -> 20)
//  Kein Alias -> erste zwei Zeichen des Hostnamens. Alles in Versalien.
//  Sonderfall vor allem anderen: eine IPv4-Adresse ergibt ihr LETZTES Oktett
//  (192.0.2.20 -> 20, Sichtpruefung 2026-09-07 der UI-v2-Spec, Punkt C).
//  Es zaehlen nur Buchstaben und Ziffern: andere Zeichen in einem Teil werden
//  uebergangen, ein Teil ohne Buchstaben und Ziffern entfaellt, und ein Alias
//  ganz ohne sie gilt wie kein Alias. So ergibt "VM 20 (accept)" VA statt "V(".

/** Nur die Buchstaben und Ziffern eines Textes, in jeder Schrift. */
function lettersAndDigits(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, "");
}

function hostnameInitials(hostname: string): string {
  return lettersAndDigits(hostname).slice(0, 2).toUpperCase();
}

export function hostInitials(alias: string, hostname: string): string {
  const name = alias.trim();
  if (name.length === 0) return hostnameInitials(hostname);

  // VOR dem Zerlegen: zwei Hosts im selben Netz unterscheiden sich nur
  // hinten. Die ersten zwei Zeichen gaeben beiden dasselbe Kuerzel ("19"),
  // und das Quadrat traegt genau eine Aufgabe -- Identitaet.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) return name.slice(name.lastIndexOf(".") + 1);

  const parts = name
    .split(/[-_.\s]+/)
    .map(lettersAndDigits)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return hostnameInitials(hostname);
  const isDigits = (part: string) => /^\d+$/.test(part);
  const words = parts.filter((part) => !isDigits(part));
  const last = parts[parts.length - 1];

  if (words.length > 0 && parts.length >= 2 && isDigits(last)) {
    return (words[words.length - 1][0] + last[last.length - 1]).toUpperCase();
  }
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return parts.join("").slice(0, 2).toUpperCase();
}
