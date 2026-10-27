// Anmeldungsmenue statt drei Feldern (Spec §9): EIN Menue mit den gefundenen
// Schluesseln, `ssh-agent`, `Password` und `Choose file...` statt
// Schluesselpfad/Passphrase/Passwort.
//
// Warum: `resolve_auth_method` (commands.rs) gibt einem gefuellten
// Schluesselpfad STILLEN Vorrang vor einem Passwort, und ein LEERES
// Schluesselfeld bedeutet "ssh-agent" -- ein unter Windows 11 ab Werk
// DEAKTIVIERTER Dienst. Bei drei gleichzeitig sichtbaren Feldern ist diese
// Regel fuer den Nutzer unsichtbar; am 2026-07-28 landete die Abnahme
// deshalb zweimal auf einem gespeicherten Host, der sich nie verbinden liess.
// `resolve_auth_method` bleibt die Rueckfallabsicherung, falls doch einmal
// mehrere Felder ankommen.
//
// `initial.auth` ist die Konsumstelle fuer `SshConfigHost.identity_file`:
// ein Aufrufer, der einen Vorschlag mit gesetzter `IdentityFile` uebernimmt
// (`first-run.ts`), reicht `{kind: "key", path: identity_file, passphrase:
// ""}` als `initial.auth` herein, und `applyPreselection()` unten gibt ihr
// Vorrang vor der Erkennungsreihenfolge. Diese Datei verdrahtet
// `identity_file` NICHT selbst gegen `suggest_hosts`.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n/t";

export type AuthChoice =
  | { kind: "key"; path: string; passphrase: string }
  | { kind: "agent" }
  | { kind: "password"; password: string };

export interface HostFormValue {
  label: string;
  hostname: string;
  user: string;
  port: number;
  auth: AuthChoice;
  /** Schalter "Show tmux sessions" (Spec 2026-10-25 §10.1). Die Reparatur
   * der Steuerung zeigt ihn nicht und laesst das Feld weg. */
  showDefaultSocket?: boolean;
}

/** Deckungsgleich mit `ssh::keys::SshKeyDto` (`serde::Serialize`) --
 * `list_ssh_keys` liefert die Liste bereits sortiert `ed25519 -> ecdsa ->
 * rsa`, alphabetisch innerhalb einer Gruppe (Spec §9.2). Diese Ansicht
 * sortiert NICHT nach -- eine zweite Sortierung hier koennte von der
 * Rust-Seite abdriften. */
interface SshKeyDto {
  path: string;
  file_name: string;
  key_type: string;
  comment: string;
}

export interface HostFormOptions {
  /** `control-repair`: reuse the authentication controls without editable
   * endpoint metadata. `edit`: a saved host is edited; the submit button
   * says "Save" (UX-Spec §7.7). Without a mode the form adds a host. */
  mode?: "control-repair" | "edit";
  initial?: Partial<HostFormValue>;
  existing: { hostname: string; user: string; port: number }[];
  onSubmit: (value: HostFormValue) => void;
}

export interface HostFormHandle {
  dispose(): void;
  /** Der Aufrufer (`first-run.ts`) sperrt damit den Absenden-Knopf fuer die
   * Dauer eines laufenden `connect_host` -- ohne diese Sperre startete ein
   * gewoehnlicher Doppelklick (oder ein zweites Enter) auf "Connect" einen
   * ZWEITEN `connect_host`-Aufruf, bevor der erste aufgeloest hatte, und der
   * AELTERE der beiden Aufrufe koennte beim spaeteren Aufloesen die vom
   * juengeren bereits uebernommene Verbindung kommentarlos ueberschreiben --
   * derselbe Lecktyp wie der dispose()-waehrend-in-flight-Fall, nur ueber einen
   * anderen Ausloeser erreicht. */
  setSubmitDisabled(disabled: boolean): void;
}

/** Zaehler fuer die Kennung der Meldung, auf die `aria-describedby` zeigt --
 * je Formular eine eigene, denn Erststart und Hinweisleiste koennen zugleich
 * eines tragen. */
let hostForms = 0;

const KEY_VALUE_PREFIX = "key:";
const AGENT_VALUE = "agent";
const PASSWORD_VALUE = "password";
const CHOOSE_FILE_VALUE = "choose-file";
/** Kein Eintrag, sondern das Fehlen einer Wahl -- siehe `ensurePlaceholderOption`. */
const PLACEHOLDER_VALUE = "";

function authChoiceToValue(auth: AuthChoice): string {
  switch (auth.kind) {
    case "key":
      return `${KEY_VALUE_PREFIX}${auth.path}`;
    case "agent":
      return AGENT_VALUE;
    case "password":
      return PASSWORD_VALUE;
  }
}

/** Letztes Pfadsegment, ueber `\` UND `/` -- Windows-Pfade in dieser App
 * verwenden `\`, aber weder `list_ssh_keys` noch der native Dateidialog
 * garantieren das (der Dialog liefert, was das Betriebssystem liefert). */
function baseName(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const segments = normalised.split("/");
  return segments[segments.length - 1] || path;
}

/** Dieselbe Dreifachpruefung (Hostname/User/Port) braucht `first-run.ts` fuer
 * den direkten Verbindungspfad eines Vorschlags mit `user` ein zweites Mal.
 * `mountHostForm`s eigenes `isDuplicate` unten ist ueber `opts.existing`
 * geschlossen und laesst sich deshalb nicht direkt exportieren -- diese
 * modul-oeffentliche Fassung nimmt die Liste als Parameter und dient beiden
 * Aufrufern. */
export function matchesExistingHost(
  entry: { hostname: string; user: string; port: number },
  existing: { hostname: string; user: string; port: number }[],
): boolean {
  return existing.some(
    (candidate) =>
      candidate.hostname === entry.hostname && candidate.user === entry.user && candidate.port === entry.port,
  );
}

export function mountHostForm(el: HTMLElement, opts: HostFormOptions): HostFormHandle {
  let disposed = false;
  el.replaceChildren();

  const root = document.createElement("div");
  root.className = "host-form-view";

  const form = document.createElement("form");

  // UX-Spec §7.7: der Anzeigename, optional und oben -- beim Anlegen wie beim
  // Bearbeiten. Leer ergibt der Hostname das Label, darum ist er der
  // Platzhalter. `name="label"` wie das Feld in `HostFormValue`; ein Feld
  // namens "name" verdeckte `form.name`.
  const nameLabel = document.createElement("label");
  nameLabel.textContent = t("hostForm.name.label");
  const nameInput = document.createElement("input");
  nameInput.name = "label";
  nameInput.autocomplete = "off";
  // Ein Label, das nur den Hostnamen wiederholt, ist kein eigener Name: das
  // Feld bleibt leer und der Platzhalter zeigt ihn. Sonst stuende der
  // Hostname zweimal da, und ein geaenderter Hostname liesse den alten als
  // Namen zurueck.
  const initialLabel = opts.initial?.label ?? "";
  nameInput.value = initialLabel === (opts.initial?.hostname ?? "") ? "" : initialLabel;
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const hostnameLabel = document.createElement("label");
  hostnameLabel.textContent = t("connect.hostname.label");
  const hostnameInput = document.createElement("input");
  hostnameInput.name = "hostname";
  hostnameInput.required = true;
  hostnameInput.autocomplete = "off";
  hostnameInput.value = opts.initial?.hostname ?? "";
  hostnameLabel.appendChild(hostnameInput);
  form.appendChild(hostnameLabel);

  // Der Platzhalter folgt dem Hostnamen, waehrend er getippt wird.
  function syncNamePlaceholder(): void {
    nameInput.placeholder = hostnameInput.value.trim();
  }
  syncNamePlaceholder();
  hostnameInput.addEventListener("input", syncNamePlaceholder);

  const userLabel = document.createElement("label");
  userLabel.textContent = t("connect.user.label");
  const userInput = document.createElement("input");
  userInput.name = "user";
  userInput.required = true;
  userInput.autocomplete = "off";
  userInput.value = opts.initial?.user ?? "";
  userLabel.appendChild(userInput);
  form.appendChild(userLabel);

  const portLabel = document.createElement("label");
  portLabel.textContent = t("connect.port.label");
  const portInput = document.createElement("input");
  portInput.name = "port";
  portInput.type = "number";
  portInput.min = "1";
  portInput.max = "65535";
  portInput.required = true;
  portInput.value = String(opts.initial?.port ?? 22);
  portLabel.appendChild(portInput);
  form.appendChild(portLabel);
  if (opts.mode === "control-repair") {
    for (const label of [nameLabel, hostnameLabel, userLabel, portLabel]) label.hidden = true;
    for (const input of [nameInput, hostnameInput, userInput, portInput]) input.disabled = true;
  }

  // Einmal ausgelesen statt mehrfach `opts.initial?.auth` verkettet -- eine
  // einzelne lokale Variable narrowt zuverlaessig ueber `.kind`, ein
  // wiederholter optionaler Verkettungsausdruck ist dafuer nicht noetig und
  // schwerer zu lesen.
  const initialAuth = opts.initial?.auth;

  // --- Anmeldungsmenue (Spec §9, §9.2) ---
  const authLabel = document.createElement("label");
  authLabel.textContent = t("hostForm.auth.label");
  const authSelect = document.createElement("select");
  authSelect.name = "auth";
  authLabel.appendChild(authSelect);
  form.appendChild(authLabel);

  const authHint = document.createElement("p");
  authHint.className = "host-form-hint";
  authHint.textContent = t("hostForm.auth.keyHint");
  form.appendChild(authHint);

  // Deaktivierter Platzhalter: NUR eingefuegt, wenn `applyPreselection()` unten
  // keine sinnvolle Vorauswahl hat -- siehe dort. Nicht von Anfang an im DOM,
  // damit der Normalfall (Schluessel gefunden oder identity_file vorhanden)
  // keinen zusaetzlichen, nie ausgewaehlten Eintrag im Menue zeigt.
  const placeholderOption = document.createElement("option");
  placeholderOption.value = PLACEHOLDER_VALUE;
  placeholderOption.disabled = true;
  placeholderOption.textContent = t("hostForm.auth.placeholder");

  // Feste Eintraege sofort da -- unabhaengig davon, wie lange `list_ssh_keys`
  // braucht. Die gefundenen Schluessel werden spaeter VOR `separatorOption`
  // eingefuegt (siehe `addKeyOption`/`findOrAddKeyOption`).
  const separatorOption = document.createElement("option");
  separatorOption.disabled = true;
  separatorOption.textContent = "──────────";

  const agentOption = document.createElement("option");
  agentOption.value = AGENT_VALUE;
  agentOption.textContent = t("hostForm.auth.agent");

  const passwordOption = document.createElement("option");
  passwordOption.value = PASSWORD_VALUE;
  passwordOption.textContent = t("hostForm.auth.password");

  const chooseFileOption = document.createElement("option");
  chooseFileOption.value = CHOOSE_FILE_VALUE;
  chooseFileOption.textContent = t("hostForm.auth.chooseFile");

  authSelect.append(separatorOption, agentOption, passwordOption, chooseFileOption);

  // Passphrase-/Passwortfeld werden bei Bedarf tatsaechlich aus dem DOM
  // entfernt statt nur per `.hidden` versteckt -- ein verstecktes, aber
  // vorhandenes Feld bliebe eine Tab-Station (Designsystem §8.6: "ein
  // deaktiviertes Feld ist Tastaturnavigations-Rauschen", dasselbe gilt fuer
  // ein unsichtbares).
  const passphraseLabel = document.createElement("label");
  passphraseLabel.textContent = t("hostForm.passphrase.label");
  const passphraseInput = document.createElement("input");
  passphraseInput.name = "passphrase";
  passphraseInput.type = "password";
  passphraseInput.autocomplete = "off";
  if (initialAuth?.kind === "key") passphraseInput.value = initialAuth.passphrase;
  passphraseLabel.appendChild(passphraseInput);

  const passwordLabel = document.createElement("label");
  passwordLabel.textContent = t("hostForm.auth.password");
  const passwordInput = document.createElement("input");
  passwordInput.name = "password";
  passwordInput.type = "password";
  passwordInput.autocomplete = "off";
  if (initialAuth?.kind === "password") passwordInput.value = initialAuth.password;
  passwordLabel.appendChild(passwordInput);

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "btn btn--primary";
  submitButton.textContent = t(
    opts.mode === "control-repair" ? "control.repairSubmit" : opts.mode === "edit" ? "hostForm.save" : "connect.submit",
  );

  // Eigener rechtsbuendiger Aktionen-Container statt eines direkten
  // Form-Kindes: das Formular ist Spalten-Flex, ein Knopf direkt darin rendert
  // volle Breite -- derselbe Container wie bei
  // `.host-key-prompt-actions`/`.session-dialog-actions` (siehe dortige Regel
  // weiter unten in styles.css).
  // Spec 2026-10-25 §10.1: ob die App die Sessions auf tmux' Standard-Socket
  // dieses Hosts zeigt. Vorgabe an, auch fuer bestehende Hosts.
  const showDefaultLabel = document.createElement("label");
  showDefaultLabel.className = "host-form-check";
  const showDefaultBox = document.createElement("input");
  showDefaultBox.type = "checkbox";
  showDefaultBox.name = "showDefaultSocket";
  showDefaultBox.checked = opts.initial?.showDefaultSocket !== false;
  showDefaultLabel.append(showDefaultBox, document.createTextNode(t("hostForm.showDefaultSocket")));
  if (opts.mode !== "control-repair") form.appendChild(showDefaultLabel);

  const actions = document.createElement("div");
  actions.className = "host-form-actions";
  actions.appendChild(submitButton);
  form.appendChild(actions);
  // Die Felder der Anmeldeart kommen vor den Schalter.
  const fieldsEnd = opts.mode === "control-repair" ? actions : showDefaultLabel;

  root.appendChild(form);

  // Genau EIN [role=alert]-Knoten im Teilbaum -- die Duplikat-Warnung
  // (Spec §9.4). Ein zweiter (z. B. fuer einen fehlgeschlagenen
  // `list_ssh_keys`-Aufruf) wuerde `el.querySelector("[role=alert]")`
  // verfaelschen, das immer den ERSTEN Treffer liefert.
  const warningEl = document.createElement("p");
  warningEl.setAttribute("role", "alert");
  warningEl.id = `host-form-warning-${++hostForms}`;
  root.appendChild(warningEl);

  el.appendChild(root);

  /** UX-Spec §11: der eine Feldfehler dieses Formulars -- keine Anmeldeart
   * gewaehlt. Das Menue traegt ihn fuer Hilfstechnik (`aria-invalid`) und
   * verweist auf die Meldung. Die Duplikat-Warnung im selben Knoten ist kein
   * Feldfehler: ein zweites Absenden geht durch. */
  function showAuthRequired(): void {
    warningEl.textContent = t("hostForm.auth.required");
    authSelect.setAttribute("aria-invalid", "true");
    authSelect.setAttribute("aria-describedby", warningEl.id);
  }

  /** Leert die Meldung und nimmt die Markierung vom Menue. */
  function clearWarning(): void {
    warningEl.textContent = "";
    authSelect.removeAttribute("aria-invalid");
    authSelect.removeAttribute("aria-describedby");
  }

  function updateVisibleFields(value: string): void {
    const isKey = value.startsWith(KEY_VALUE_PREFIX);
    const isPassword = value === PASSWORD_VALUE;

    // `insertBefore(..., actions)`, nicht `submitButton`: der Knopf steckt
    // im Aktionen-Container (oben), nicht direkt im Formular -- `submitButton`
    // waere hier kein gueltiger Referenzknoten von `form`.
    if (isKey) {
      if (!passphraseLabel.isConnected) form.insertBefore(passphraseLabel, fieldsEnd);
    } else {
      passphraseLabel.remove();
    }

    if (isPassword) {
      if (!passwordLabel.isConnected) form.insertBefore(passwordLabel, fieldsEnd);
    } else {
      passwordLabel.remove();
    }
  }

  function addKeyOption(key: SshKeyDto): void {
    const option = document.createElement("option");
    option.value = `${KEY_VALUE_PREFIX}${key.path}`;
    option.title = key.path;
    option.textContent = key.comment
      ? `${key.file_name} — ${key.key_type} · ${key.comment}`
      : `${key.file_name} — ${key.key_type}`;
    authSelect.insertBefore(option, separatorOption);
  }

  /** Liefert den `<option>`-Wert fuer `path` und legt ihn an, falls er noch
   * nicht existiert -- etwa fuer eine `IdentityFile`, die ausserhalb der von
   * `list_ssh_keys` durchsuchten `~/.ssh` liegt, oder eine per "Choose
   * file..." gewaehlte Datei. */
  function findOrAddKeyOption(path: string): string {
    const value = `${KEY_VALUE_PREFIX}${path}`;
    const exists = Array.from(authSelect.options).some((option) => option.value === value);
    if (!exists) {
      const option = document.createElement("option");
      option.value = value;
      option.title = path;
      option.textContent = baseName(path);
      authSelect.insertBefore(option, separatorOption);
    }
    return value;
  }

  /** Setzt den deaktivierten Platzhalter ins Menue (falls noch nicht
   * geschehen) und liefert seinen Wert. Aufgerufen ausschliesslich aus dem
   * Zweig in `applyPreselection()`, der keine sinnvolle Vorauswahl hat. */
  function ensurePlaceholderOption(): string {
    if (!placeholderOption.isConnected) {
      authSelect.insertBefore(placeholderOption, authSelect.firstChild);
    }
    return PLACEHOLDER_VALUE;
  }

  let discoveredKeys: SshKeyDto[] = [];
  let lastSelectedValue = AGENT_VALUE;

  // Vorauswahl (Spec §9.2): eine `initial.auth`-Angabe (siehe Modulkommentar
  // oben -- der Konsum von `identity_file`) gewinnt VOR der
  // Erkennungsreihenfolge `ed25519 -> ecdsa -> rsa`, die `list_ssh_keys`
  // bereits liefert. KEIN STILLES DURCHPROBIEREN: diese Funktion waehlt nur
  // VOR, sie loest nichts im Hintergrund aus -- ein passphrasengeschuetzter
  // Schluessel wird nicht angefasst, nur seine Option markiert.
  //
  // Gegenprobe-Marker: wird die Bevorzugung von `opts.initial?.auth` unten
  // entfernt, muss GENAU der Test "bevorzugt eine IdentityFile-Angabe vor
  // der Erkennungsreihenfolge" rot werden -- die anderen Faelle pruefen
  // diesen Vorrang nicht und muessen gruen bleiben.
  function applyPreselection(): void {
    let value: string;
    if (initialAuth) {
      value = authChoiceToValue(initialAuth);
      if (value.startsWith(KEY_VALUE_PREFIX)) {
        findOrAddKeyOption(value.slice(KEY_VALUE_PREFIX.length));
      }
    } else if (discoveredKeys.length > 0) {
      value = `${KEY_VALUE_PREFIX}${discoveredKeys[0].path}`;
    } else {
      // Weder eine identity_file-Angabe noch ein gefundener Schluessel -- es
      // gibt KEINE sinnvolle Vorauswahl. Auf `ssh-agent` zurueckzufallen
      // hiesse, dem Nutzer eine Entscheidung unterzuschieben, die er nicht
      // getroffen hat, UND ihn genau auf den unter Windows 11 ab Werk
      // deaktivierten Dienst zu lenken -- die Sackgasse, gegen die dieses Menue
      // existiert (Spec §9.2: "ssh-agent bleibt ein gleichrangiger Eintrag im
      // Menue -- eine Wahl, keine Voreinstellung"). Das Menue steht stattdessen
      // auf einem deaktivierten Platzhalter; der submit-Handler unten weist ein
      // Absenden in diesem Zustand zurueck.
      //
      // Gegenprobe-Marker: wird dieser Zweig durch `value = AGENT_VALUE;`
      // ersetzt, muss GENAU der Test "laesst das Menue auf einem
      // Platzhalter, wenn weder identity_file noch ein Schluessel vorliegt"
      // rot werden.
      value = ensurePlaceholderOption();
    }
    authSelect.value = value;
    lastSelectedValue = authSelect.value;
    updateVisibleFields(authSelect.value);
  }

  async function loadKeys(): Promise<void> {
    let keys: SshKeyDto[] = [];
    try {
      keys = await invoke<SshKeyDto[]>("list_ssh_keys");
    } catch (error) {
      // Ein unlesbares/fehlendes ~/.ssh ist kein Fehler dieses Formulars --
      // das Menue bleibt bei ssh-agent/Password/Choose file stehen, genau
      // wie auf einem frischen System ohne Schluessel. Bewusst KEINE zweite
      // [role=alert]-Meldung dafuer (siehe `warningEl`s Kommentar oben).
      void error;
    }
    if (disposed) return;
    discoveredKeys = keys;
    for (const key of keys) addKeyOption(key);
    applyPreselection();
  }
  void loadKeys();

  /** Eine gewaehlte Anmeldeart behebt den Feldfehler "keine Anmeldeart";
   * eine Duplikat-Warnung im selben Knoten bleibt dagegen stehen. */
  function clearAuthRequired(): void {
    if (authSelect.getAttribute("aria-invalid") === "true") clearWarning();
  }

  authSelect.addEventListener("change", () => {
    if (authSelect.value === CHOOSE_FILE_VALUE) {
      void handleChooseFile();
      return;
    }
    lastSelectedValue = authSelect.value;
    updateVisibleFields(authSelect.value);
    clearAuthRequired();
  });

  async function handleChooseFile(): Promise<void> {
    const previous = lastSelectedValue;
    let picked: string | string[] | null = null;
    try {
      picked = await open({
        multiple: false,
        directory: false,
        title: t("hostForm.auth.chooseFile"),
      });
    } catch (error) {
      // Ein Fehlschlag des nativen Dialogs (z. B. vom Nutzer weggeklickt)
      // ist kein Formularfehler -- die Auswahl faellt auf den vorherigen
      // Eintrag zurueck, genau wie ein regulaeres Abbrechen (`picked ===
      // null`).
      void error;
    }
    if (disposed) return;
    if (typeof picked === "string" && picked.length > 0) {
      authSelect.value = findOrAddKeyOption(picked);
      clearAuthRequired();
    } else {
      authSelect.value = previous;
    }
    lastSelectedValue = authSelect.value;
    updateVisibleFields(authSelect.value);
  }

  function isDuplicate(hostname: string, user: string, port: number): boolean {
    return matchesExistingHost({ hostname, user, port }, opts.existing);
  }

  let duplicateAcknowledged = false;

  // Eine Aenderung an hostname/user/port macht eine vorherige Warnung
  // gegenstandslos -- die naechste Absendung ist wieder eine FRISCHE
  // Entscheidung (Spec §9.4: "Warnung statt Ablehnung", nicht "einmal
  // warnen, dann fuer immer stumm").
  function clearDuplicateWarning(): void {
    duplicateAcknowledged = false;
    clearWarning();
  }
  hostnameInput.addEventListener("input", clearDuplicateWarning);
  userInput.addEventListener("input", clearDuplicateWarning);
  portInput.addEventListener("input", clearDuplicateWarning);

  function buildAuth(): AuthChoice | null {
    const value = authSelect.value;
    if (value.startsWith(KEY_VALUE_PREFIX)) {
      return {
        kind: "key",
        path: value.slice(KEY_VALUE_PREFIX.length),
        passphrase: passphraseInput.value,
      };
    }
    if (value === AGENT_VALUE) return { kind: "agent" };
    if (value === PASSWORD_VALUE) return { kind: "password", password: passwordInput.value };
    // Platzhalter (kein Schluessel gefunden, keine identity_file, noch nichts
    // gewaehlt), Trennlinie oder "choose-file": kein gueltiger Absendezustand.
    // Der Platzhalter-Fall wird im submit-Handler in eine sichtbare Meldung
    // uebersetzt (`hostForm.auth.required`) und ist getestet;
    // Trennlinie/"choose-file" bleiben reine Absicherung -- der change-Handler
    // loest "choose-file" sofort wieder auf (siehe `handleChooseFile`), beide
    // sind im Test nicht erreichbar.
    return null;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (disposed) return;
    // Waehrend der Knopf gesperrt ist, laeuft bereits ein Aufruf fuer eine
    // vorherige Absendung -- ein zweites `submit` (Doppelklick, zweites Enter,
    // oder wie im Test direkt dispatcht) darf `opts.onSubmit` kein zweites Mal
    // aufrufen. Ueber den Knopf selbst geprueft (keine zweite, separat
    // gefuehrte `submitting`-Variable): der Aufrufer setzt/loescht exakt dieses
    // Attribut per `setSubmitDisabled`, ein einziger Wahrheitsort.
    if (submitButton.disabled) return;

    const hostname = opts.mode === "control-repair" ? opts.initial?.hostname ?? "" : hostnameInput.value.trim();
    const user = opts.mode === "control-repair" ? opts.initial?.user ?? "" : userInput.value.trim();
    const port = opts.mode === "control-repair" ? opts.initial?.port ?? 22 : Number(portInput.value);

    if (isDuplicate(hostname, user, port) && !duplicateAcknowledged) {
      duplicateAcknowledged = true;
      // Die Meldung beschreibt ab hier kein Feld mehr.
      clearWarning();
      warningEl.textContent = t("hostForm.duplicate.warning", {
        hostname,
        user,
        port: String(port),
      });
      return;
    }

    const auth = buildAuth();
    if (!auth) {
      // Platzhalter (kein Schluessel gefunden, keine identity_file) oder
      // Trennlinie: dieselbe Mechanik wie die Duplikat-Warnung -- eine
      // Meldung statt eines stillen Nicht-Absendens, kein `onSubmit`-Aufruf.
      showAuthRequired();
      return;
    }

    // Geheimnis-Disziplin (Spec §8.5): der Wert steckt bereits im gerade
    // gebauten `auth`-Objekt -- das Eingabefeld selbst muss ihn ab jetzt nicht
    // mehr im DOM vorhalten. Das raeumt HIER, nach erfolgreicher LOKALER
    // Validierung und VOR jedem Verbindungsversuch, nicht erst nach einer
    // erfolgreichen Verbindung: `onSubmit` ist synchron (feste Schnittstelle),
    // diese Funktion sieht das Ergebnis eines spaeteren `connect_host` gar
    // nicht. Schlaegt die Verbindung danach an einem falschen Passwort fehl,
    // muss der Nutzer es neu eintippen -- anders als ein Weg, der erst nach
    // ERFOLGREICHEM Verbinden raeumt und bei einem Fehlschlag ausdruecklich
    // stehen laesst. Der Unterschied ist architektonisch durch die synchrone
    // `onSubmit`-Signatur bedingt, nicht durch eine andere Haltung zu
    // Geheimnissen.
    passphraseInput.value = "";
    passwordInput.value = "";

    clearWarning();
    // UX-Spec §7.7: der eingetragene Name, sonst der Hostname. Die
    // Reparatur der Steuerung zeigt das Feld nicht und behaelt den Namen.
    const label = opts.mode === "control-repair" ? (opts.initial?.label ?? hostname) : nameInput.value.trim() || hostname;
    const showDefault = opts.mode === "control-repair" ? {} : { showDefaultSocket: showDefaultBox.checked };
    opts.onSubmit({ label, hostname, user, port, auth, ...showDefault });
  });

  return {
    dispose() {
      disposed = true;
      passwordInput.value = "";
      passphraseInput.value = "";
      el.replaceChildren();
    },
    setSubmitDisabled(disabled: boolean) {
      submitButton.disabled = disabled;
    },
  };
}
