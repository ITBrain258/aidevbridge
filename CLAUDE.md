# aidevbridge

## Ablage der Doku

Specs, Pläne und Messberichte liegen flach unter `docs/`. Das gilt auch für
Skills, die `docs/superpowers/` vorschlagen:

- Specs: `docs/specs/YYYY-MM-DD-<thema>-design.md`
- Pläne: `docs/plans/YYYY-MM-DD-<thema>.md`
- Messberichte: `docs/messungen/messung-YYYY-MM-DD-<thema>.md`, Rohdaten in
  `docs/messungen/fixtures/`
- Anleitungen für Nutzer, auf Englisch: `docs/guide/`
- Bilder: `docs/images/`, erzeugt von `scripts/readme-images/render.mjs`

Den aktuellen Stand und die offenen Punkte führt `docs/stand.md`.

Das Repository ist öffentlich. Angaben zu Rechner, Konten und Test-VMs gehören
nicht hinein: Sie kommen nach `docs/lokal/`, das per `.gitignore` ausgeschlossen
ist. Im Repository stehen Platzhalter.
