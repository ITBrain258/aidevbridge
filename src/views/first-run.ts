// Erststart-Ansicht (Spec §4.2):
// zeigt Vorschlaege aus `~/.ssh/config` (`suggest_hosts()`) und ein
// Anmeldungsformular, danach `run_preflight` sichtbar mit einem Haekchen je
// Pruefung; ein blockierender Befund zeigt die Meldung aus
// `blocking_problem()` und laesst das Fortfahren nicht zu.
//
// Das Formular ist `host-form.ts`s Anmeldungsmenue: ein angeklickter
// Vorschlag mit gesetzter `identity_file` reicht den Schluessel als
// `initial.auth` weiter, statt ihn stillschweigend zu verlieren -- ohne den
// Schluesselpfad landete der Nutzer beim Verbinden auf ssh-agent, einem
// unter Windows 11 ab Werk deaktivierten Dienst.
//
// UI v2 (Spec 9.2, 9.5, 9.6): die Ansicht ist ein Willkommen aus
// Markenblock, Karte und Fusszeile. Ein Vorschlag ist eine ZEILE mit genau
// einem Connect-Knopf und verbindet DIREKT (`valueFromSuggestion`), statt das
// Formular zu fuellen -- der Umweg ueber `initial.auth` bleibt fuer die
// beiden Faelle, in denen der Vorschlag NICHT blind verbinden darf: ohne
// `user` (Rust verlangt ihn), oder bereits gespeichert (Duplikat-Warnung,
// Spec 9.4). Das Formular liegt zugeklappt hinter
// "Add a host manually" und steht nur dann offen da, wenn es gar keine
// Vorschlaege gibt. `compact` laesst im "Add host"-Dialog weg, was der
// Dialogkopf schon traegt.
//
// UI v2 (Spec 9.3 bis 9.5): was NACH dem Connect passiert,
// bleibt in derselben Karte. Der `code` eines gescheiterten `connect_host`
// entscheidet, ob unter der angeklickten Vorschlagszeile ein Geheimnisfeld
// erscheint (`credential-field.ts`, Spec 9.3) oder eine Fehlerflaeche mit
// Retry und Copy diagnostics; die Pruefliste traegt die Ueberschrift
// "Checking {alias}" und Zeilen mit Icon plus verstecktem Zustandswort
// (Spec 9.4), und der Fokus wandert von der Zeile ueber das Feld zu
// Continue bzw. Back (Spec 9.5).
//
// Bewertet die drei Einzelpruefungen NUR zur Anzeige aus den rohen
// Feldern des DTOs -- die eigentliche Blockier-Entscheidung kommt
// AUSSCHLIESSLICH aus `blocking_problem` (vom Backend vorberechnet, siehe
// `commands::PreflightReportDto`s Doc-Kommentar): eine zweite, abweichende
// Logik hier (z. B. eigene Versionsvergleiche) waere eine zweite Quelle,
// die von `preflight.rs`s Regeln (Git-Master-Builds, "next-3.5", etc.)
// abdriften koennte.

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/t";
import { icon } from "../icons";
import { appVersionLine } from "../version";
import { isAndroid } from "../platform";
import { buildCredentialField } from "./credential-field";
import {
  matchesExistingHost,
  mountHostForm,
  type AuthChoice,
  type HostFormHandle,
  type HostFormValue,
} from "./host-form";
import { hostInitials } from "./initials";
import type { HostEntry, SshConfigHost } from "./types";

interface PreflightReportPayload {
  tmux_version: string | null;
  has_base64: boolean;
  socket_dir_writable: boolean;
  blocking_problem: string | null;
}

/** UX-Spec §10: jeder `ConnectError`-Code ausser `other` traegt schon die
 * Nutzermeldung des Backends, die steht allein. Nur `other` -- und ein Fehler
 * ganz ohne Code, etwa eine abgelehnte Reservierung -- nennt davor den Host. */
function connectErrorText(code: unknown, host: string, message: string): string {
  return typeof code === "string" && code !== "other" ? message : t("connect.error", { host, message });
}

export interface FirstRunHandle {
  dispose(): void;
}

export interface FirstRunOptions {
  /** Ein Host wurde verbunden UND (bei bestandenem Preflight) dauerhaft in
   * `settings.toml` gespeichert -- der Aufrufer (main.ts) macht mit
   * `hostId` weiter (Session anlegen, Terminal mounten). `entry` ist das
   * vollstaendige, vom Backend zurueckgegebene `HostEntry` (samt der
   * SETTINGS.TOML-`id`, die von `hostId` -- der Laufzeit-Verbindungs-ID aus
   * `connect_host` -- verschieden ist, siehe main.ts' Doc-Kommentar zur
   * Zwei-ID-Situation): main.ts braucht beide, um spaeteres Bearbeiten/
   * Entfernen gegen die RICHTIGE settings.toml-id zu richten, waehrend
   * Session-Operationen weiter die Laufzeit-`hostId` benutzen.
   *
   * `usedSecret`: die Verbindung brauchte eine Passphrase oder ein Passwort.
   * Einen solchen Host verbindet main.ts nach einem Transportverlust nicht
   * selbst neu (UX-Spec §5.4) -- und nur diese Ansicht weiss es. */
  onHostReady: (hostId: string, entry: HostEntry, usedSecret: boolean) => void;
  /** Spec 9.6: im "Add host"-Dialog ohne Logo, Name, Satz und Anforderungszeile. */
  compact?: boolean;
  /** Global TOFU listeners must be ready before any reservation/network work. */
  beforeConnect?: () => Promise<void>;
  /** Registers events for the owned runtime before connect can publish them.
   * Handoff is delivered through onHostReady; false means explicit release. */
  onRuntimeOwnershipChange?: (runtimeId: string, owned: boolean) => void;
}

// `label` traegt bewusst einen NEUTRALEN
// Pruefgegenstand ("tmux (>= 3.0)"), keine positive Behauptung ("tmux is
// installed") -- ein "✗" vor einer positiven Behauptung ("✗ tmux is
// installed (>= 3.0)") liest sich wie ein Widerspruch in sich selbst. Vor
// einem neutralen Pruefgegenstand lesen sich beide Symbole als das, was sie
// sind: das Ergebnis DIESER Pruefung (siehe `en.json`s
// `firstRun.preflight.*`-Strings).
function checkRow(label: string, ok: boolean, detail?: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = ok ? "preflight-check preflight-check-ok" : "preflight-check preflight-check-fail";
  // Spec 9.4: Icon im 16er-Kasten; das Zustandswort ist der Glyphentext,
  // nur fuer Hilfstechnik -- so
  // bleiben die Textzusicherungen ("✓ base64") wortwoertlich gueltig.
  const box = document.createElement("span");
  box.className = "icon-box";
  box.dataset.icon = ok ? "check" : "x";
  box.setAttribute("aria-hidden", "true");
  box.appendChild(icon(ok ? "check" : "x"));
  li.appendChild(box);
  const glyph = document.createElement("span");
  glyph.className = "preflight-check-glyph ab-visually-hidden";
  glyph.textContent = ok ? "✓" : "✗";
  li.appendChild(glyph);
  li.appendChild(document.createTextNode(detail ? ` ${label} — ${detail}` : ` ${label}`));
  return li;
}

/** Vorrangregel (dieselbe wie `resolve_auth_method` auf der Rust-Seite,
 * siehe commands.rs): uebersetzt die Menue-Auswahl aus `host-form.ts` in
 * die drei rohen `HostSpecDto`-Felder -- genau EINES der drei ist gesetzt,
 * die anderen bleiben `null`, selbst wenn ein verstecktes Feld noch einen
 * Wert traegt (`host-form.ts` haelt das ohnehin nicht vor, siehe dessen
 * `updateVisibleFields`). */
function specFieldsFromAuth(
  auth: AuthChoice,
): { key_path: string | null; passphrase: string | null; password: string | null } {
  switch (auth.kind) {
    case "key":
      return {
        key_path: auth.path,
        passphrase: auth.passphrase.length > 0 ? auth.passphrase : null,
        password: null,
      };
    case "agent":
      return { key_path: null, passphrase: null, password: null };
    case "password":
      return { key_path: null, passphrase: null, password: auth.password.length > 0 ? auth.password : null };
  }
}

/** Laufende Nummer je Mount, allein fuer die `id` der Pruefliste. Die
 * Ansicht kann ZWEIMAL gleichzeitig im Dokument stehen -- das Willkommen in
 * `#grid` und daneben ein kompakter "Add host"-Dialog. Eine feste `id` waere
 * damit doppelt vergeben, und `aria-controls` beider Aufklapper zeigte auf
 * dasselbe (das erste) Element. */
let checksIdCounter = 0;

export function mountFirstRun(container: HTMLElement, options: FirstRunOptions): FirstRunHandle {
  let disposed = false;
  container.replaceChildren();

  const root = document.createElement("div");
  root.className = options.compact ? "first-run-view first-run-view--compact" : "first-run-view";

  // --- Marke (Spec 9.2, Punkte 1-3), im Dialog ausgeblendet (9.6) ---
  // Keine Ueberschrift `firstRun.heading` in BEIDEN
  // Varianten: im Willkommen traegt der Name sie, im Dialog der Dialogkopf
  // (Spec 13.4) -- zwei Titel uebereinander waeren doppelt gemoppelt.
  const brand = document.createElement("div");
  brand.className = "first-run-brand";
  brand.hidden = options.compact === true;
  const logo = document.createElement("div");
  logo.className = "first-run-logo";
  logo.setAttribute("aria-hidden", "true");
  logo.textContent = t("app.title").slice(0, 1);
  brand.appendChild(logo);
  const name = document.createElement("h2");
  name.className = "first-run-name";
  name.textContent = t("app.title");
  brand.appendChild(name);
  const tagline = document.createElement("p");
  tagline.className = "first-run-tagline";
  tagline.textContent = t("firstRun.welcome.tagline");
  brand.appendChild(tagline);
  root.appendChild(brand);

  // --- Karte (Spec 9.2, Punkt 4) ---
  const card = document.createElement("div");
  card.className = "first-run-card";

  const loadingNotice = document.createElement("p");
  loadingNotice.className = "first-run-notice";
  loadingNotice.textContent = t("firstRun.loading");
  card.appendChild(loadingNotice);

  // --- Vorschlagsliste aus ~/.ssh/config ---
  // Die `<h3>` sind Abschnittslabels (Designsystem
  // §3.2: `--ab-fs-xs`, 600, Grossbuchstaben, `letter-spacing`), dieselbe
  // ROLLE wie `.sb-head h1` ("HOSTS") in der Seitenleiste -- eine bereits
  // etablierte Konvention, keine neue. Dieselbe Rolle
  // heisst hier NICHT dieselbe Schriftgroesse -- `.sb-head h1` setzt
  // `--ab-fs-sm`, diese Klasse das von §3.2 geforderte `--ab-fs-xs`.
  const suggestedHeading = document.createElement("h3");
  suggestedHeading.className = "first-run-section-label";
  suggestedHeading.textContent = t("firstRun.suggested.heading");
  suggestedHeading.hidden = true;
  card.appendChild(suggestedHeading);

  const suggestedList = document.createElement("ul");
  suggestedList.className = "first-run-suggested-list";
  suggestedList.hidden = true;
  card.appendChild(suggestedList);

  // --- Anmeldungsformular (`host-form.ts`), zugeklappt hinter
  // dem Umschalter (Spec 9.2): mit Vorschlaegen ist der kurze Weg der
  // Regelfall, das Formular der Ausnahmefall. Ohne Vorschlaege gibt es
  // nichts umzuschalten -- dann steht das Formular offen da und der
  // Umschalter bleibt `hidden` (siehe `loadInitialData`).
  const manualToggle = document.createElement("button");
  manualToggle.type = "button";
  manualToggle.className = "btn btn--secondary first-run-manual-toggle";
  manualToggle.textContent = t("firstRun.manual.toggle");
  manualToggle.setAttribute("aria-expanded", "false");
  manualToggle.hidden = true;
  card.appendChild(manualToggle);

  const hostFormContainer = document.createElement("div");
  hostFormContainer.className = "first-run-host-form";
  hostFormContainer.hidden = true;
  card.appendChild(hostFormContainer);

  const statusEl = document.createElement("p");
  statusEl.className = "first-run-notice";
  statusEl.setAttribute("aria-live", "polite");
  card.appendChild(statusEl);

  const errorEl = document.createElement("p");
  errorEl.setAttribute("role", "alert");
  card.appendChild(errorEl);

  // --- Preflight-Anzeige ---
  const preflightSection = document.createElement("section");
  preflightSection.className = "first-run-preflight";
  preflightSection.hidden = true;
  const preflightHeading = document.createElement("h3");
  preflightHeading.className = "first-run-section-label";
  preflightHeading.textContent = t("firstRun.preflight.heading");
  preflightSection.appendChild(preflightHeading);
  const preflightList = document.createElement("ul");
  preflightList.className = "first-run-preflight-list";
  preflightSection.appendChild(preflightList);
  const preflightBlocked = document.createElement("p");
  preflightBlocked.setAttribute("role", "alert");
  preflightSection.appendChild(preflightBlocked);

  // Eine Zeile fuer beide Schaltflaechen statt zweier gestapelter Bloecke:
  // dieselben beiden Knoten unter `preflightSection`, nur mit einem
  // gemeinsamen Layout-Container dazwischen.
  const preflightActions = document.createElement("div");
  preflightActions.className = "first-run-preflight-actions";
  // OHNE diesen Button waere ein
  // blockierender Preflight-Befund eine Sackgasse. Immer sichtbar, sobald
  // `preflightSection` selbst sichtbar ist: es gibt IMMER einen Weg zurueck
  // zum Formular, nie nur einen Weg vorwaerts oder gar keinen.
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "btn btn--secondary";
  backButton.textContent = t("firstRun.back");
  preflightActions.appendChild(backButton);
  const continueButton = document.createElement("button");
  continueButton.type = "button";
  continueButton.className = "btn btn--primary";
  continueButton.textContent = t("firstRun.continue");
  continueButton.hidden = true;
  preflightActions.appendChild(continueButton);
  preflightSection.appendChild(preflightActions);
  card.appendChild(preflightSection);
  root.appendChild(card);

  // --- Fusszeile (Spec 9.2, Punkt 5), im Dialog ausgeblendet (9.6) ---
  const footer = document.createElement("div");
  footer.className = "first-run-footer";
  footer.hidden = options.compact === true;
  const requirements = document.createElement("span");
  requirements.className = "first-run-requirements";
  requirements.textContent = t("firstRun.requirements");
  footer.appendChild(requirements);
  const disclosure = document.createElement("button");
  disclosure.type = "button";
  disclosure.className = "btn btn--text btn--row first-run-disclosure";
  disclosure.textContent = t("firstRun.whatGetsChecked");
  disclosure.setAttribute("aria-expanded", "false");
  footer.appendChild(disclosure);
  const checks = document.createElement("ul");
  checks.id = `first-run-checks-${++checksIdCounter}`;
  disclosure.setAttribute("aria-controls", checks.id);
  checks.className = "first-run-checks";
  checks.hidden = true;
  for (const key of ["firstRun.preflight.tmux", "firstRun.preflight.base64", "firstRun.preflight.socketDir"] as const) {
    const li = document.createElement("li");
    li.textContent = t(key);
    checks.appendChild(li);
  }
  footer.appendChild(checks);
  disclosure.addEventListener("click", () => {
    const open = checks.hidden;
    checks.hidden = !open;
    disclosure.setAttribute("aria-expanded", String(open));
  });
  root.appendChild(footer);

  container.appendChild(root);

  // Zustand ausserhalb des DOM, damit `continueButton`s Klick-Handler auf
  // den gerade verbundenen Host zugreifen kann.
  // Owned from reservation through preflight/save; null only after release or handoff.
  let connectedHostId: string | null = null;
  let pendingValue: HostFormValue | null = null;
  // Ein Preflight gehoert zu genau einem Versuch, auch nach Back und
  // einem neuen Connect innerhalb derselben Ansicht.
  let attemptGeneration = 0;
  let preflightReady = false;
  let saveInFlight = false;
  let existingHosts: { hostname: string; user: string; port: number }[] = [];
  let hostFormHandle: HostFormHandle | null = null;
  /** Laeuft gerade ein `connect_host`? Lebte der Waechter gegen doppeltes
   * Absenden AUSSCHLIESSLICH im DOM (`submitButton.disabled`, siehe
   * `connect()`), braechte ein neu gemountetes Formular einen frischen,
   * FREIGEGEBENEN Knopf mit, auch mitten in einem laufenden Versuch.
   *
   * `mountForm` hat nur EINEN Aufrufer, `openForm` -- ein Vorschlagsklick
   * fuehrt nicht hierher (er verbindet direkt oder oeffnet das Formular ueber
   * denselben `openForm`-Weg, wenn `user` fehlt oder der Vorschlag ein
   * Duplikat ist). Die Variable deckt zwei Faelle: (1)
   * eine SCHNELLE Doppelabsendung -- der Vorschlags-Knopf-Handler prueft sie
   * DIREKT (`if (disposed || connectInFlight) return;`), bevor ein zweiter
   * Verbindungsversuch ueberhaupt startet, und faengt so auch ein Ereignis
   * ab, das die DOM-Sperre der Knoepfe umgeht (direkt dispatcht); (2) ein
   * Formular, das der Umschalter "Add a host manually" MITTEN in einem
   * laufenden Versuch frisch mountet -- `mountForm` reicht `connectInFlight`
   * sofort an `setSubmitDisabled` weiter (siehe dort), das frische Formular
   * bringt seinen Absenden-Knopf deshalb von Anfang an GESPERRT mit, statt
   * eines freigegebenen. Der Mount ist also KEINE Versuchsgrenze; diese
   * Variable ist es, weil sie den Mount ueberlebt. */
  let connectInFlight = false;
  /** Die zuletzt gerenderten Vorschlaege und die Quelle des laufenden bzw.
   * letzten Versuchs -- `goBack()` stellt damit genau den Zustand wieder
   * her, den der Erfolgspfad ausgeblendet hat (Liste, Ueberschrift,
   * Umschalter, Formular). Ohne beide muesste "Back" raten, ob es eine
   * Vorschlagsliste gab und ob der Nutzer aus dem Formular kam. */
  let lastSuggestions: SshConfigHost[] = [];
  let lastSource: ConnectSource | null = null;

  function mountForm(initial?: Partial<HostFormValue>): void {
    hostFormHandle?.dispose();
    hostFormHandle = mountHostForm(hostFormContainer, {
      initial,
      existing: existingHosts,
      onSubmit: (value) => {
        void connect(value, { kind: "form" });
      },
    });
    // Siehe `connectInFlight` oben: der frische Knopf uebernimmt den Zustand
    // des LAUFENDEN Versuchs, nicht seinen Vorgabezustand.
    hostFormHandle.setSubmitDisabled(connectInFlight);
  }

  /** Klappt das Formular auf, mountet es frisch (ggf. vorbelegt) und setzt
   * den Fokus in das genannte Feld. `hidden` faellt VOR dem `focus()`, sonst
   * greift der Fokus auf einem versteckten Feld ins Leere. */
  function openForm(initial?: Partial<HostFormValue>, focusField = "hostname"): void {
    hostFormContainer.hidden = false;
    manualToggle.setAttribute("aria-expanded", "true");
    mountForm(initial);
    hostFormContainer.querySelector<HTMLElement>(`[name="${focusField}"]`)?.focus();
  }

  manualToggle.addEventListener("click", () => {
    if (disposed) return;
    if (hostFormContainer.hidden) openForm();
    else {
      hostFormContainer.hidden = true;
      manualToggle.setAttribute("aria-expanded", "false");
    }
  });

  /** Woher ein Verbindungsversuch kommt -- entscheidet, wo Zustand und
   * Fehler erscheinen (Formular: in der Karte; Vorschlag: in der Zeile). */
  type ConnectSource =
    | { kind: "form" }
    | { kind: "suggestion"; host: SshConfigHost; li: HTMLLIElement; button: HTMLButtonElement; meta: HTMLElement };

  /** Die Werte eines Vorschlags als Formularwert -- oder `null`, wenn der
   * Vorschlag keinen `user` traegt: `connect_host` verlangt ihn, ein blindes
   * Raten (etwa der Windows-Anmeldename) waere eine erfundene Angabe. */
  function valueFromSuggestion(host: SshConfigHost): HostFormValue | null {
    if (!host.user) return null;
    return {
      label: host.alias,
      hostname: host.hostname ?? host.alias,
      user: host.user,
      port: host.port ?? 22,
      auth: host.identity_file ? { kind: "key", path: host.identity_file, passphrase: "" } : { kind: "agent" },
    };
  }

  /** "Jeder Eintrag zeigt Alias UND user@host:port, kein
   * bloser Knopf" -- baut die Zweitzeile aus den vier ohnehin optionalen
   * Feldern des DTOs, ohne eine dieser Optionalitaeten zu behaupten weg
   * (kein erfundener Nutzername, kein erfundener Port).
   * Spec 9.2: eine gesetzte `identity_file` erscheint als
   * blosser DATEINAME hinter einem Mittelpunkt -- der volle Pfad sprengt die
   * Zeile, und das Wort "key" waere ein neuer, in Spec 13.4 nicht
   * vorgesehener Text. */
  function suggestionDetail(host: SshConfigHost): string {
    const userPart = host.user ? `${host.user}@` : "";
    const hostPart = host.hostname ?? host.alias;
    const portPart = host.port ? `:${host.port}` : "";
    const keyPart = host.identity_file ? ` · ${host.identity_file.split(/[\\/]/).pop() ?? ""}` : "";
    return `${userPart}${hostPart}${portPart}${keyPart}`;
  }

  function renderSuggestions(hosts: SshConfigHost[]): void {
    suggestedList.replaceChildren();
    if (hosts.length === 0) {
      const li = document.createElement("li");
      li.className = "first-run-suggestion-empty";
      li.textContent = t("firstRun.suggested.empty");
      suggestedList.appendChild(li);
      return;
    }
    for (const host of hosts) {
      const li = document.createElement("li");
      li.className = "first-run-suggestion";
      const row = document.createElement("div");
      row.className = "first-run-suggestion-row";

      const avatar = document.createElement("span");
      avatar.className = "sb-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = hostInitials(host.alias, host.hostname ?? "");
      row.appendChild(avatar);

      const text = document.createElement("span");
      text.className = "first-run-suggestion-text";
      const alias = document.createElement("span");
      alias.className = "first-run-suggestion-alias";
      alias.textContent = host.alias;
      text.appendChild(alias);
      const detail = document.createElement("span");
      detail.className = "first-run-suggestion-detail";
      detail.textContent = suggestionDetail(host);
      text.appendChild(detail);
      row.appendChild(text);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn--primary btn--row first-run-suggestion-connect";
      button.textContent = t("connect.submit");
      button.setAttribute("aria-label", t("firstRun.suggested.connect", { alias: host.alias }));
      button.addEventListener("click", () => {
        if (disposed || connectInFlight) return;
        const value = valueFromSuggestion(host);
        if (value === null) {
          // Ohne user kann niemand blind verbinden -- Formular vorbelegt oeffnen.
          // Konsumstelle fuer `identity_file`:
          // traegt der Vorschlag einen Schluesselpfad, gibt `initial.auth`
          // ihm den Vorrang vor der Erkennungsreihenfolge (siehe
          // `host-form.ts::applyPreselection`) -- OHNE das faellt das Menue
          // auf den ersten gefundenen `~/.ssh`-Schluessel oder den
          // deaktivierten Platzhalter zurueck, und der per `IdentityFile`
          // gemeinte Schluessel ist verloren.
          const initial: Partial<HostFormValue> = { hostname: host.hostname ?? host.alias };
          if (host.port) initial.port = host.port;
          if (host.identity_file) initial.auth = { kind: "key", path: host.identity_file, passphrase: "" };
          openForm(initial, "user");
          return;
        }
        // `existingHosts` (aus `list_hosts`) wird HIER gegengeprueft: die
        // Duplikat-Warnung aus Spec 9.4 lebt ausschliesslich in
        // `host-form.ts`, das dieser Pfad sonst gar nicht durchlaeuft. Ein
        // Treffer oeffnet deshalb das vorbelegte Formular
        // (dasselbe `openForm`, das auch der "ohne user"-Zweig oben nutzt) --
        // NUR dort traegt der Absenden-Knopf die Warnung, ein blindes
        // `connect()` haette sie dem Nutzer stillschweigend vorenthalten.
        if (
          matchesExistingHost({ hostname: value.hostname, user: value.user, port: value.port }, existingHosts)
        ) {
          openForm(
            { label: value.label, hostname: value.hostname, user: value.user, port: value.port, auth: value.auth },
            "hostname",
          );
          return;
        }
        void connect(value, { kind: "suggestion", host, li, button, meta: detail });
      });
      row.appendChild(button);
      // Spec 9.2: ein Klick auf die Zeile leitet an den einzigen Knopf weiter.
      // Kein `event.stopPropagation()` im Knopf-Handler noetig: der Filter
      // `event.target.closest("button")` hier reicht
      // bereits aus, um eine Rueckkopplung (Zeilenklick -> `button.click()`
      // -> erneuter Zeilenklick) zu verhindern -- `stopPropagation()`
      // schluckte den Klick zusaetzlich VOR `document`, wo die Seitenleiste
      // ihren Klick-ausserhalb-Handler registriert, und liesse ein offenes
      // Seitenleistenmenue faelschlich offen stehen.
      row.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        button.click();
      });
      li.appendChild(row);
      suggestedList.appendChild(li);
    }
  }

  /** Steht der Abschnitt der Vorschlaege da? Android (Spec 2026-10-27 §5.3)
   * hat keine `~/.ssh/config` des Nutzers; eine leere Liste dort waere nur
   * ein Hinweis auf eine Datei, die es nicht gibt. */
  function suggestionsShown(): boolean {
    return lastSuggestions.length > 0 || !isAndroid();
  }

  async function loadInitialData(): Promise<void> {
    // Beide Aufrufe VOR dem ersten Mount von `host-form.ts` abgewartet
    // (nicht nacheinander mit Zwischen-Mount): `HostFormOptions.existing`
    // ist ein Pflichtfeld, das `host-form.ts` nur beim KONSTRUIEREN liest
    // (`applyPreselection` laeuft beim Mount und nach `loadKeys`, es gibt
    // keine Update-API) -- ein fruehes Mounten mit `existing: []` und ein
    // spaeteres Neumounten mit den echten Daten wuerde bereits getippte
    // Werte des Nutzers verwerfen.
    const [suggestedResult, existingResult] = await Promise.allSettled([
      invoke<SshConfigHost[]>("suggest_hosts"),
      invoke<HostEntry[]>("list_hosts"),
    ]);
    if (disposed) return;

    // Eine fehlende/unlesbare ~/.ssh/config ist kein Fehler dieses
    // Formulars -- nur die Vorschlagsliste bleibt leer.
    const hosts = suggestedResult.status === "fulfilled" ? suggestedResult.value : [];
    lastSuggestions = hosts;
    renderSuggestions(hosts);

    // Ein fehlgeschlagenes `list_hosts` hier faellt auf "keine bekannten
    // Hosts" zurueck: die Duplikat-Warnung (Spec §9.4) bleibt dann einfach
    // stumm, kein Datenverlust -- anders als der TOP-LEVEL-Fall in
    // `main.ts` (unlesbare `settings.toml` darf dort nicht als "Erststart"
    // durchgehen), der laengst entschieden ist, BEVOR diese Ansicht je
    // gemountet wird.
    // `Array.isArray` zusaetzlich zu `status === "fulfilled"` geprueft: ein
    // Testdoppel (oder ein kuenftiger Backend-Fehlerfall, der `null` statt
    // eines Fehlschlags liefert) darf `.map` unten nicht zum Absturz
    // bringen.
    existingHosts =
      existingResult.status === "fulfilled" && Array.isArray(existingResult.value)
        ? existingResult.value.map((entry) => ({
            hostname: entry.hostname,
            user: entry.user,
            port: entry.port,
          }))
        : [];

    loadingNotice.hidden = true;
    suggestedHeading.hidden = !suggestionsShown();
    suggestedList.hidden = !suggestionsShown();
    // Startfokus (Spec 9.5): gibt es Vorschlaege, ist der erste Connect-Knopf
    // der wahrscheinlichste naechste Griff und das Formular bleibt
    // zugeklappt; gibt es keine, ist das Formular der einzige Weg -- es steht
    // dann offen da, und der Umschalter waere ein Knopf ohne Gegenstueck.
    // Erst HIER verzweigt (nach `existingHosts`), nicht direkt nach
    // `renderSuggestions`: `mountForm` liest `existingHosts` beim
    // Konstruieren, ein frueherer Mount verlore die Duplikat-Warnung.
    if (hosts.length > 0) {
      manualToggle.hidden = false;
      suggestedList.querySelector<HTMLButtonElement>("button")?.focus();
    } else {
      openForm();
    }
  }

  async function connect(value: HostFormValue, source: ConnectSource): Promise<void> {
    if (disposed || connectInFlight || saveInFlight || connectedHostId !== null) return;
    const attempt = ++attemptGeneration;
    resetPreflight();
    errorEl.textContent = "";
    lastSource = source;

    const { key_path, passphrase, password } = specFieldsFromAuth(value.auth);

    // Sperrt den Absenden-Knopf, BEVOR der
    // erste `await` unten die Kontrolle abgibt -- alles vor diesem Punkt
    // laeuft synchron innerhalb desselben Aufrufs, der den Klick/das Enter
    // ausloeste, ein zweiter, unmittelbar nachfolgender Absendeversuch (z. B.
    // ein gewoehnlicher Doppelklick) trifft `host-form.ts`s eigenen
    // `submitButton.disabled`-Waechter deshalb VOR jedem weiteren
    // `connect_host`-Aufruf. Ohne diese Sperre haette ein zweiter Aufruf
    // genau das Leck aus dem `if (disposed)`-Zweig unten reproduzieren
    // koennen, nur ueber einen anderen Ausloeser (der AELTERE der beiden
    // Aufrufe ueberschriebe beim spaeteren Aufloesen die vom juengeren
    // bereits uebernommene Verbindung).
    //
    // `connectInFlight` fuehrt denselben Zustand
    // ausserhalb des DOM mit -- der Knopf allein traegt ihn nur bis zum
    // naechsten `mountForm`, siehe dessen Kommentar.
    connectInFlight = true;
    hostFormHandle?.setSubmitDisabled(true);
    // Dieselbe Sperre fuer die Vorschlagszeilen: ALLE Connect-Knoepfe, nicht
    // nur der angeklickte -- ein zweiter Vorschlag waere sonst ein zweiter,
    // ueberlappender Versuch (`connectInFlight` faengt ihn zwar ohnehin ab,
    // aber ein Knopf, der sich druecken laesst und nichts tut, ist eine
    // stille Sackgasse).
    for (const b of suggestedList.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true;
    if (source.kind === "suggestion") {
      // Die Fehler-/Feldflaeche des VORIGEN Versuchs verschwindet
      // hier, nicht erst beim naechsten Fehler -- sonst stapelten sich zwei
      // Flaechen unter derselben Zeile (Retry aus der Flaeche heraus fuehrt
      // ebenfalls durch diese Stelle).
      clearFollowup(source.li);
      // Der Zustand steht IN der Zeile, die der Nutzer angeklickt hat --
      // nicht in einer Statuszeile weit darunter (Spec 9.5).
      source.li.classList.add("is-connecting");
      source.meta.textContent = t("connect.connecting");
      statusEl.textContent = "";
    } else {
      statusEl.textContent = t("connect.connecting");
    }
    let hostId: string | undefined;
    try {
      await options.beforeConnect?.();
      if (disposed || attempt !== attemptGeneration) return;
      hostId = await invoke<string>("begin_connect", {});
      if (disposed || attempt !== attemptGeneration) {
        void invoke("disconnect_host", { hostId }).catch(() => {});
        return;
      }
      // Own the reservation before connect can suspend in TCP/auth/TOFU.
      connectedHostId = hostId;
      options.onRuntimeOwnershipChange?.(hostId, true);
      await invoke<string>("connect_host", {
        hostId,
        spec: {
          hostname: value.hostname,
          port: value.port,
          user: value.user,
          key_path,
          passphrase,
          password,
        },
      });
    } catch (error) {
      if (hostId !== undefined) {
        options.onRuntimeOwnershipChange?.(hostId, false);
        void invoke("disconnect_host", { hostId }).catch(() => {});
        if (connectedHostId === hostId) connectedHostId = null;
      }
      if (disposed || attempt !== attemptGeneration) return;
      // Spec §4.8: `connect_host` liefert
      // `ConnectError { code, message }` statt einer blossen Zeichenkette
      // -- ein blosses `String(error)` zeigte hier sonst `"[object
      // Object]"` statt der Meldung. Dasselbe Muster wie `main.ts`s
      // `connectHost`-Fehlerauswertung: `message`
      // ausgelesen, wenn vorhanden, sonst der Fehler selbst als Text.
      const code = (error as { code?: unknown } | null)?.code;
      const message = String((error as { message?: unknown } | null)?.message ?? error);
      if (source.kind === "suggestion") {
        // Spec 9.3: der Fehler bleibt IN der Zeile, die der
        // Nutzer angeklickt hat -- `code` entscheidet, ob dort ein
        // Geheimnis fehlt (Feld) oder etwas anderes schiefging (Flaeche).
        const wantsSecret =
          code === "passphrase_required" ||
          code === "password_required" ||
          // Ohne Schluessel ist ein abgelehnter Agent der
          // Windows-Normalfall (Dienst ab Werk aus) -- Passwort anbieten.
          // `auth_rejected` ist hier der richtige Zweig fuer den Sonderfall,
          // kein falscher Treffer: `src-tauri/src/commands.rs::classify_connect_error`
          // bildet `AuthError::PasswordWrong`/`PassphraseWrong` auf
          // `password_required`/`passphrase_required` ab, `auth_rejected`
          // bekommen nur die dort aufgezaehlten uebrigen Anmeldefehler (etwa
          // `MethodNotOffered` oder `AgentUnavailable`)
          // -- ein falsch getipptes Passwort landet also nie in dieser
          // Flaeche, sondern immer im Geheimnisfeld oben.
          (code === "auth_rejected" && value.auth.kind === "agent");
        if (wantsSecret) {
          showCredentialFollowup(source, value, code === "passphrase_required" ? "passphrase" : "password", message);
        } else {
          showErrorFollowup(source, value, connectErrorText(code, value.label, message), message);
        }
      } else {
        errorEl.textContent = connectErrorText(code, value.label, message);
        statusEl.textContent = "";
      }
      return;
    } finally {
      // IMMER wieder freigeben, auch im Fehlerfall --
      // sonst waere das Formular nach einem blossen Tippfehler (falscher
      // Hostname, falscher Port) dauerhaft tot, ohne jede Moeglichkeit zur
      // Korrektur. `hostFormHandle` kann inzwischen ein ANDERES Formular
      // sein als das, welches diesen Versuch ausloeste (Klick auf den
      // Umschalter "Add a host manually" waehrend des Wartens, ueber
      // `openForm` frisch gemountet) -- freigegeben
      // wird trotzdem, und zwar richtigerweise: der Versuch ist beendet, und
      // das jetzt sichtbare Formular ist das, das der Nutzer vor sich hat.
      connectInFlight = false;
      hostFormHandle?.setSubmitDisabled(false);
      for (const b of suggestedList.querySelectorAll<HTMLButtonElement>("button")) b.disabled = false;
      if (source.kind === "suggestion") {
        source.li.classList.remove("is-connecting");
        source.meta.textContent = suggestionDetail(source.host);
      }
    }

    if (disposed || attempt !== attemptGeneration) {
      // Dispose kann vor der Rueckkehr der Laufzeit-ID stattfinden.
      // Auch diese spaete Verbindung gehoert uns und muss geschlossen werden.
      void invoke("disconnect_host", { hostId }).catch(() => {});
      return;
    }
    connectedHostId = hostId;
    pendingValue = value;
    statusEl.textContent = t("connect.connected", { alias: value.label });
    // Die Karte zeigt ab hier NUR noch die Pruefliste: Vorschlaege, der
    // Umschalter und das Formular gehoeren zu einem Schritt, der bereits
    // vorbei ist (Spec 9.3). `goBack()` macht genau diese vier Zeilen
    // rueckgaengig.
    hostFormContainer.hidden = true;
    manualToggle.hidden = true;
    suggestedHeading.hidden = true;
    suggestedList.hidden = true;
    // Spec 9.4: die Ueberschrift nennt den Host, der gerade geprueft wird --
    // die Vorschlagszeile, die den Namen trug, ist eine Zeile darueber gerade
    // verschwunden. `goBack()` setzt sie auf den neutralen Text zurueck.
    preflightHeading.textContent = t("firstRun.checking", { alias: value.label });
    preflightSection.hidden = false;
    preflightList.replaceChildren();
    const running = document.createElement("li");
    running.textContent = t("firstRun.preflight.running");
    preflightList.appendChild(running);

    try {
      const report = await invoke<PreflightReportPayload>("run_preflight", { hostId });
      if (disposed || attempt !== attemptGeneration || connectedHostId !== hostId) return;
      renderPreflight(report);
    } catch (error) {
      if (disposed || attempt !== attemptGeneration || connectedHostId !== hostId) return;
      resetPreflight();
      // Verbunden WAR der Host -- ein Text "Couldn't connect" waere hier falsch.
      errorEl.textContent = t("firstRun.preflight.failed", { message: String(error) });
      statusEl.textContent = "";
      // Spec 9.5: gescheitertes Pruefen laesst nur den Weg zurueck offen --
      // "Continue" ist hier gar nicht sichtbar.
      backButton.focus();
    }
  }

  function clearFollowup(li: HTMLLIElement): void {
    li.querySelector(".first-run-suggestion-followup")?.remove();
  }

  /** Box und Meldung sind in beiden Followups gleich; nur die Toenung und
   * das, was darunter steht, unterscheiden sich. `role="status"` plus
   * `aria-live="polite"` bleiben an der Meldung. */
  function followupBox(message: string, danger: boolean): { box: HTMLDivElement; note: HTMLParagraphElement } {
    const box = document.createElement("div");
    box.className = danger
      ? "first-run-suggestion-followup first-run-suggestion-followup--error"
      : "first-run-suggestion-followup";
    const note = document.createElement("p");
    note.className = "first-run-followup-message";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    note.textContent = message;
    box.appendChild(note);
    return { box, note };
  }

  /** Spec 9.3: Feld unter der Zeile, erneutes Connect mit Geheimnis. Die
   * Anmeldeart kommt aus dem Vorschlag, nicht aus einem gespeicherten Host. */
  function showCredentialFollowup(
    source: Extract<ConnectSource, { kind: "suggestion" }>,
    value: HostFormValue,
    kind: "passphrase" | "password",
    message: string,
  ): void {
    const { box } = followupBox(message, false);
    const field = buildCredentialField({ kind });
    box.appendChild(field.root);
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn btn--primary btn--row";
    submit.textContent = t("connect.submit");
    const go = () => {
      if (disposed || connectInFlight) return;
      const secret = field.value();
      if (secret === undefined) {
        field.input.focus();
        return;
      }
      const next: HostFormValue =
        kind === "passphrase" && value.auth.kind === "key"
          ? { ...value, auth: { ...value.auth, passphrase: secret } }
          : { ...value, auth: { kind: "password", password: secret } };
      void connect(next, source);
    };
    submit.addEventListener("click", go);
    field.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        go();
      }
    });
    box.appendChild(submit);
    source.li.appendChild(box);
    field.input.focus();
  }

  /** Spec 9.3: `auth_rejected`, `host_unreachable`, `host_key_rejected`,
   * `other` -- Fehlerflaeche in der Zeile mit Retry und Copy diagnostics.
   * `text` ist der Satz fuer den Nutzer, `message` der Rohtext des Backends
   * fuer die Diagnose (UX-Spec §10). */
  function showErrorFollowup(
    source: Extract<ConnectSource, { kind: "suggestion" }>,
    value: HostFormValue,
    text: string,
    message: string,
  ): void {
    const { box } = followupBox(text, true);
    const acts = document.createElement("div");
    acts.className = "acts";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn--secondary btn--row";
    retry.textContent = t("sidebar.notice.retry");
    retry.addEventListener("click", () => {
      if (disposed || connectInFlight) return;
      void connect(value, source);
    });
    acts.appendChild(retry);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn btn--text btn--row";
    copy.textContent = t("sidebar.notice.copyDiagnostics");
    copy.addEventListener("click", () => {
      if (!navigator.clipboard) return;
      void navigator.clipboard.writeText(`${appVersionLine()}\n${message}`).catch(() => {});
    });
    acts.appendChild(copy);
    box.appendChild(acts);
    source.li.appendChild(box);
    retry.focus();
  }

  function resetPreflight(): void {
    preflightReady = false;
    continueButton.hidden = true;
    preflightBlocked.hidden = true;
    preflightBlocked.textContent = "";
  }

  function renderPreflight(report: PreflightReportPayload): void {
    preflightReady = !report.blocking_problem;
    preflightList.replaceChildren();
    preflightList.appendChild(checkRow(t("firstRun.preflight.base64"), report.has_base64));
    preflightList.appendChild(
      checkRow(
        t("firstRun.preflight.tmux"),
        report.tmux_version !== null,
        report.tmux_version ?? undefined,
      ),
    );
    preflightList.appendChild(
      checkRow(t("firstRun.preflight.socketDir"), report.socket_dir_writable),
    );

    if (report.blocking_problem) {
      preflightBlocked.textContent = t("firstRun.preflight.blocked", {
        message: report.blocking_problem,
      });
      preflightBlocked.hidden = false;
      continueButton.hidden = true;
    } else {
      preflightBlocked.hidden = true;
      preflightBlocked.textContent = "";
      continueButton.hidden = false;
    }
    // Spec 9.5: der Fokus geht auf den Knopf, der jetzt dran ist -- nach
    // einem sauberen Bericht "Continue", nach einem blockierenden Befund
    // "Back" (der einzige Weg, der dann noch offen steht). ERST NACH dem
    // `hidden`-Umschalten oben: ein verstecktes Bedienelement nimmt keinen
    // Fokus an.
    if (report.blocking_problem) backButton.focus();
    else continueButton.focus();
  }

  backButton.addEventListener("click", () => {
    goBack();
  });

  /** Gibt die eigene Reservierung oder aufgebaute SSH-Verbindung wieder frei --
   * best effort, dasselbe Muster wie `main.ts`s `onDisconnectHost()`.
   *
   * Gerufen von `goBack()` UND von `dispose()`: die Fluchtwege aus der
   * Ueberlagerung, die Schliessen-Schaltflaeche und der dokumentweite
   * Escape-Handler (`closeDialog()` in `dialog.ts`), laufen ausschliesslich
   * ueber `dispose()`. Wer nach einem erfolgreichen `connect_host` waehrend des
   * Preflight Escape drueckte, liesse sonst eine vollstaendig aufgebaute
   * russh-Sitzung samt Keepalive-Aufgabe zurueck -- unerreichbar fuer die
   * Oberflaeche, weil ihre Laufzeit-ID nirgends sonst im Frontend existiert
   * (kein Seitenleisteneintrag, kein `AppState`-Host). Jede Wiederholung leckte
   * eine weitere.
   *
   * Fire-and-forget statt `await`: `dispose()` ist synchron (Schnittstelle
   * von `FirstRunHandle`) und kann nicht warten -- und ein Ergebnis gibt es
   * ohnehin nicht auszuwerten, `disconnect_host_impl` ist idempotent. */
  function releaseConnection(): void {
    ++attemptGeneration;
    resetPreflight();
    const idToClose = connectedHostId;
    connectedHostId = null;
    pendingValue = null;
    if (!idToClose) return;
    options.onRuntimeOwnershipChange?.(idToClose, false);
    void invoke("disconnect_host", { hostId: idToClose }).catch(() => {});
  }

  /** Fuehrt aus einem blockierten
   * (oder fehlgeschlagenen) Preflight zurueck zum Formular UND schliesst
   * die bereits geoeffnete SSH-Verbindung. */
  function goBack(): void {
    // Save ist der letzte Schritt dieses Versuchs. Dispose bleibt moeglich
    // und raeumt auf; Back darf keine inzwischen gespeicherte Verbindung
    // gegen einen anderen Versuch austauschen.
    if (disposed || saveInFlight || connectInFlight) return;
    releaseConnection();

    preflightSection.hidden = true;
    preflightBlocked.hidden = true;
    preflightBlocked.textContent = "";
    preflightList.replaceChildren();
    // Die Ueberschrift nennt beim naechsten Versuch einen ANDEREN Host --
    // bis dahin steht wieder der neutrale Text da.
    preflightHeading.textContent = t("firstRun.preflight.heading");
    // Die Gegenrichtung zum Erfolgspfad oben: dorthin zurueck, wo der
    // Versuch begann. Ueberschrift und Liste kommen zurueck, wie sie beim
    // Mounten standen -- auch ohne Vorschlaege zeigt die Liste dann die
    // "No hosts found"-Zeile, nur auf Android nicht (`suggestionsShown`).
    // Nur der Umschalter
    // bleibt an Vorschlaege gebunden: ohne sie gaebe es nichts umzuschalten,
    // das Formular stand von Anfang an offen. Das Formular selbst nur, wenn
    // der Versuch aus ihm kam.
    const hadSuggestions = lastSuggestions.length > 0;
    suggestedHeading.hidden = !suggestionsShown();
    suggestedList.hidden = !suggestionsShown();
    manualToggle.hidden = !hadSuggestions;
    hostFormContainer.hidden = lastSource?.kind !== "form";
    // `aria-expanded` folgt dem, was tatsaechlich sichtbar ist -- sonst
    // behauptet der Umschalter nach einem Vorschlagsversuch weiter "offen",
    // waehrend das Formular zu ist.
    manualToggle.setAttribute("aria-expanded", String(!hostFormContainer.hidden));
    statusEl.textContent = "";
    errorEl.textContent = "";
    // Spec 9.5: der Fokus geht dorthin zurueck, wo der Versuch begann --
    // ERST HIER, nach dem `hidden`-Umschalten oben: der Connect-Knopf liegt
    // in der Vorschlagsliste, die eine Zeile zuvor noch versteckt war.
    if (lastSource?.kind === "suggestion") lastSource.button.focus();
    else hostFormContainer.querySelector<HTMLElement>("[name=hostname]")?.focus();
  }

  continueButton.addEventListener("click", () => {
    void finishAndPersist();
  });

  async function finishAndPersist(): Promise<void> {
    if (disposed || saveInFlight || !preflightReady || !connectedHostId || !pendingValue) return;
    const attempt = attemptGeneration;
    const handedOverHostId = connectedHostId;
    const value = pendingValue;
    saveInFlight = true;
    continueButton.disabled = true;
    backButton.disabled = true;
    errorEl.textContent = "";
    try {
      const entry = await invoke<HostEntry>("add_host", {
        entry: {
          label: value.label,
          hostname: value.hostname,
          user: value.user,
          port: value.port,
          tmux_socket: null,
          history_limit: null,
          key_path: value.auth.kind === "key" ? value.auth.path : null,
          // Spec §4.8: ohne dieses Feld verloere `add_host_impl` die
          // gewaehlte Anmeldeart -- ein per Passwort verbundener Host fiele
          // nach dem naechsten Programmstart still auf ssh-agent zurueck
          // (`AuthChoice.kind` und `AuthKind` sind bereits deckungsgleich
          // benannt, siehe `host-form.ts`).
          auth_kind: value.auth.kind,
          // Spec 2026-10-25 §10.1: Vorgabe an.
          show_default_socket: value.showDefaultSocket ?? true,
        },
      });
      if (disposed || attempt !== attemptGeneration || connectedHostId !== handedOverHostId) return;
      // Besitzuebergabe, und zwar GENAU HIER -- vor dem Rueckruf, und nur
      // auf dem Erfolgspfad: `onHostReady`
      // fuehrt in main.ts unmittelbar zu einem `dispose()` dieser Ansicht
      // (ueber `closeDialog()` bei der "Add host"-Ueberlagerung, ueber
      // `ensureGridMounted()` beim Erststart im Rasterbereich). Wuerde
      // `connectedHostId` dabei noch gesetzt sein, schloesse `dispose()`s
      // `releaseConnection()` genau die Verbindung wieder, die der Aufrufer
      // gerade uebernommen hat -- der Host stuende in der Seitenleiste als
      // "connected", waehrend seine russh-Sitzung bereits tot waere.
      // Schlaegt `add_host` dagegen fehl (catch unten), bleibt der Besitz
      // hier: Zurueck/Escape muessen die Verbindung dann weiterhin freigeben.
      connectedHostId = null;
      pendingValue = null;
      preflightReady = false;
      const secret = specFieldsFromAuth(value.auth);
      options.onHostReady(handedOverHostId, entry, secret.passphrase !== null || secret.password !== null);
    } catch (error) {
      if (disposed) return;
      // Ein Fehler der Einstellungsdatei: das Backend nennt Pfad und Ursache in
      // einem ganzen Satz (Spec §9.2), der hier ohne zweiten Satz steht -- wie
      // beim Laden der Hosts. Ein Verbindungstext waere falsch: verbunden ist
      // der Host ja.
      errorEl.textContent = String(error);
    } finally {
      saveInFlight = false;
      if (!disposed) {
        continueButton.disabled = false;
        backButton.disabled = false;
      }
    }
  }

  void loadInitialData();

  return {
    dispose() {
      disposed = true;
      // Siehe `releaseConnection()`: derselbe Aufraeumschritt wie beim
      // Zurueck-Knopf. Ohne ihn leckt jeder Weg aus dieser Ansicht, der
      // NICHT ueber "Back" laeuft, eine offene SSH-Verbindung.
      releaseConnection();
      hostFormHandle?.dispose();
      container.replaceChildren();
    },
  };
}
