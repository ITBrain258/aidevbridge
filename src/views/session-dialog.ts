// Sitzungsdialog (Shell-Task 9b, Spec §6.4): fragt vor JEDER neuen Session
// nach dem Arbeitsverzeichnis auf dem Host, vorbelegt mit dem zuletzt
// genutzten (`initialCwd`, leer heisst Heimatverzeichnis). Seit der
// Verzeichnisauswahl (Entwurf 2026-07-29) steht unter dem Feld ein
// Verzeichnisbaum (`directory-tree.ts`): das Feld bleibt der erste Weg zum
// Pfad (Entwurf E4), der Baum ist der zweite fuer alle, die nicht wissen, was
// auf der VM liegt. Seit UX-Spec §7.6 steht dazwischen die Liste "Recent" mit
// den letzten Verzeichnissen, und jede Wahl eines Verzeichnisses schlaegt
// einen Sessionnamen aus dem Ordnernamen vor (`suggestSessionName`).
//
// Woher die Vorbelegung und die Liste kommen und wohin der benutzte Pfad
// zurueckgeht, weiss diese Datei NICHT -- `mountSessionDialog` kennt weder
// `Host` noch `AppState` noch den Arbeitsplatz, nur `initialCwd`,
// `recentDirs` und `onSubmit`. Beides ist Sache des Aufrufers (`main.ts`).
//
// Die Pfadpruefung hier ist keine Formularhoeflichkeit:
// `remote::command::build_in_dir` (`src-tauri/src/remote/command.rs`)
// prueft `cwd.starts_with('/')` per `assert!` -- ein relativer Pfad bringt
// den Rust-PROZESS zum Absturz, ohne Fehlermeldung, das Fenster ist
// einfach weg. Diese Ansicht faengt das ab, BEVOR der Wert das Backend je
// erreicht.
//
// Eine Tilde wird ebenfalls abgelehnt -- aber durch KEINE eigene Regel:
// Argumente werden base64 transportiert (Spec §8.2), `~` kaeme woertlich auf
// der VM an, und `build_in_dir` schlaegt ohnehin am fehlenden `/` fehl. Die
// Absolutpruefung unten faengt das schon ab (kein String beginnt mit `/`
// UND `~`), eine zweite Klausel dafuer waere toter Code (siehe
// `isAcceptableRemotePath`). Anders als bei `IdentityFile` (`host-form.ts`),
// wo eine Tilde ein LOKALER Pfad ist, den dieser Prozess selbst aufloesen
// kann -- ein Arbeitsverzeichnis liegt auf der REMOTE-Maschine und muss
// absolut ankommen.
//
// Diese Datei traegt zusaetzlich `editHost`: die Absendereihenfolge fuer
// "Edit" an einem gespeicherten Host (Spec §9.3). Kein eigener Dialog-Mount
// dafuer -- der Knopf in `sidebar.ts` ruft bereits `opts.onEditHost(hostId)`
// (Shell-Task 9), das eigentliche Oeffnen von `mountHostForm` mit `initial`
// aus dem gespeicherten Host ist Sache des Aufrufers (Shell-Task 11,
// `main.ts`). Diese Datei liefert die getestete, wiederverwendbare
// Absendelogik dafuer; der Aufrufer in main.ts verwaltet Formular und
// Laufzeitverbindung, der Helper speichert nur die neuen Hostwerte.

import { invoke } from "@tauri-apps/api/core";
import { mountDirectoryTree } from "./directory-tree";
import type { HostFormValue } from "./host-form";
import type { Host } from "../state/app-state";
import { RECENT_DIRS_LIMIT } from "../state/workspace";
import type { HostEntry } from "./types";
import en from "../i18n/en.json";

type TranslationKey = keyof typeof en;

function t(key: TranslationKey, params?: Record<string, string>): string {
  const template = en[key];
  if (!params) return template;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.split(`{${name}}`).join(value),
    template,
  );
}

export interface SessionDialogOptions {
  /** Die LAUFZEIT-ID des Hosts (die von `connect_host`), NICHT die in
   * `settings.toml` gespeicherte: `list_directories_impl` schlaegt den Host
   * in derselben Tabelle nach wie `create_session` und `open_terminal`
   * (`commands.rs`). Mit der settings.toml-ID kaeme an jeder Baumzeile
   * "host not connected" an. `main.ts` reicht den Wert durch und traegt
   * dort die Erklaerung der beiden ID-Raeume. */
  hostId: string;
  initialCwd: string;
  /** Die auf diesem Host BEKANNTEN Sessionnamen -- fuer die Duplikatpruefung
   * im Formular.
   *
   * Ausdruecklich BEST EFFORT: es gibt keinen periodischen Poll, und ein
   * fremder tmux-Klient kann jederzeit gleichnamig anlegen. Die Pruefung
   * spart den Umweg ueber den Host, sie ersetzt ihn nicht -- verbindlich ist
   * die Pruefung im Backend, die den strukturierten `duplicate`-Fehler
   * liefert. */
  existingSessions: string[];
  /** Die letzten Verzeichnisse dieses Hosts, neueste zuerst (UX-Spec §7.6).
   * Der Dialog zeigt hoechstens fuenf als Liste "Recent" ueber dem Baum; ohne
   * Eintrag fehlt sie. */
  recentDirs: readonly string[];
  /** `name` ist `null`, wenn der Nutzer das Feld leer gelassen hat (oder nur
   * Leerzeichen eingetippt hat) -- dann erzeugt das Backend wie bisher
   * `ab_<6 hex>`. */
  onSubmit: (cwd: string, name: string | null) => void;
  onCancel: () => void;
}

export interface SessionDialogHandle {
  /** Legt den Fokus ins Namensfeld (UX-Spec §7.6). Erst rufen, wenn
   * `openDialog` zurueckgekehrt ist: die Huelle legt ihren eigenen Fokus NACH
   * dem Aufbau auf das Schliessen-Kreuz. */
  focusName(): void;
  dispose(): void;
}

/** Hoechstens so lang ist ein Namensvorschlag, das Suffix (`-2`, `-3` ...)
 * eingeschlossen (UX-Spec §7.6). Nur der Vorschlag: einen getippten Namen
 * begrenzen weder dieser Dialog noch das Backend. */
export const SESSION_NAME_SUGGESTION_MAX = 40;

/** Die Liste "Recent" braucht eine Kennung fuer `aria-labelledby`, je Dialog
 * eine eigene. */
let recentLists = 0;

/** Ebenso die Meldung, auf die ein Feld mit Fehler per `aria-describedby`
 * zeigt (UX-Spec §11). */
let errorMessages = 0;

function trimSuggestionEdges(value: string): string {
  return value.replace(/^[- ]+|[- ]+$/g, "");
}

/** Der Namensvorschlag fuer eine Session in `dir` (UX-Spec §7.6). Grundlage ist
 * der Ordnername, das letzte Glied des Pfads. Jedes Zeichen ausserhalb der
 * Regel von `isAcceptableSessionName` wird zu `-`, mehrere `-` werden einer,
 * Rand-`-` und Leerzeichen fallen weg -- ein Vorschlag ist also immer ein
 * gueltiger Name oder leer (die Wurzel `/`). Kennt `taken` ihn schon, kommt
 * `-2`, `-3` ... dazu. Hoechstens `SESSION_NAME_SUGGESTION_MAX` Zeichen samt
 * Suffix. */
export function suggestSessionName(dir: string, taken: ReadonlySet<string>): string {
  const segments = dir.split("/").filter((segment) => segment !== "");
  const folder = segments[segments.length - 1] ?? "";
  const base = trimSuggestionEdges(folder.replace(/[^A-Za-z0-9 _-]/g, "-").replace(/-+/g, "-"));
  if (base === "") return "";
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    // Erst kuerzen, dann die Raender erneut putzen: der Schnitt kann auf ein
    // Leerzeichen oder `-` fallen. Das Suffix passt so immer hinein.
    const candidate = trimSuggestionEdges(base.slice(0, SESSION_NAME_SUGGESTION_MAX - suffix.length)) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Nur `/`: absoluter Pfad auf dem Remote-Host (siehe Kopfkommentar). KEINE
 * eigene `!value.startsWith("~")`-Klausel -- eine Tilde wird bereits durch
 * DIESE Bedingung abgelehnt, denn kein String beginnt gleichzeitig mit `/`
 * und `~`. Eine eigene Tilde-Klausel wuerde hier NIE etwas ablehnen, was
 * `startsWith("/")` nicht schon ablehnt: toter Code, der einen kuenftigen
 * Leser glauben liesse, er sichere eine eigene Regel ab (Beleg aus der
 * Gegenprobe, zweite Runde: Entfernen NUR der
 * fruehere zweiten Klausel liess den Tilde-Test gruen -- die Ablehnung von
 * `~/repo` FOLGT aus der Absolutheitsforderung, sie ist keine eigene Regel).
 * Der Test "lehnt eine Tilde ab" bleibt trotzdem bestehen: er sichert eine
 * echte, aus Nutzersicht relevante Zusage zu (eine Tilde wird abgelehnt),
 * auch wenn dafuer keine eigene Codezeile mehr existiert. */
function isAcceptableRemotePath(value: string): boolean {
  return value.startsWith("/");
}

/** Dieselbe ALLOWLIST wie `tmux::names::session_name_is_acceptable` im
 * Backend -- `A-Z`, `a-z`, `0-9`, Leerzeichen, `_`, `-`.
 *
 * Bewusst zweimal geschrieben, statt sie ueber einen Command zu holen: die
 * Regel muss beim Tippen greifen, ohne SSH-Runde. Die Begruendung, warum
 * gerade DIESE Zeichen, steht einmal -- im Backend, an der gemessenen
 * Tabelle. Dass beide Seiten dieselbe Regel fahren, ist damit eine Zusage
 * dieses Kommentars und der Tests, nicht des Typsystems.
 *
 * Warum ueberhaupt hier, wo das Backend ohnehin prueft: der Nutzer soll die
 * Regel LESEN, bevor er absendet -- nicht danach ein Banner bekommen. Und
 * ein abgelehnter Name kostet sonst eine volle Runde ueber den Host. */
function isAcceptableSessionName(value: string): boolean {
  return /^[A-Za-z0-9 _-]+$/.test(value);
}

export function mountSessionDialog(el: HTMLElement, opts: SessionDialogOptions): SessionDialogHandle {
  let disposed = false;
  el.replaceChildren();

  const root = document.createElement("div");
  root.className = "session-dialog-view";

  const form = document.createElement("form");

  // UEBER dem Arbeitsverzeichnis: der Name ist das, was der Nutzer sich
  // merkt, und das Verzeichnis ist vorbelegt. Nicht `required` -- leer
  // heisst "erzeug mir einen", genau wie bisher.
  const nameLabel = document.createElement("label");
  nameLabel.textContent = t("sessionDialog.name.label");
  const nameInput = document.createElement("input");
  nameInput.name = "sessionName";
  nameInput.autocomplete = "off";
  nameInput.placeholder = t("sessionDialog.name.placeholder");
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const cwdLabel = document.createElement("label");
  cwdLabel.textContent = t("sessionDialog.cwd.label");
  const cwdInput = document.createElement("input");
  cwdInput.name = "cwd";
  cwdInput.required = true;
  cwdInput.autocomplete = "off";
  cwdInput.value = opts.initialCwd;
  /** Hat der Nutzer das Feld selbst angefasst? Entscheidet unten, ob die
   * spaet eintreffende Aufloesung des Heimatverzeichnisses noch eingetragen
   * werden darf. Muss VOR dem Mounten des Baums stehen -- dessen
   * `onInitialPath` liest es. */
  let cwdEdited = false;
  cwdLabel.appendChild(cwdInput);
  form.appendChild(cwdLabel);

  // UX-Spec §7.6: die letzten Verzeichnisse als kompakte Liste zwischen Feld
  // und Baum. Ohne Eintrag fehlt sie ganz -- eine Ueberschrift ueber nichts
  // sagte nichts. Ihre Zeilen sind `type="button"`: ein Klick waehlt, er
  // sendet nicht ab.
  const recentDirs = opts.recentDirs.slice(0, RECENT_DIRS_LIMIT);
  if (recentDirs.length > 0) {
    const recent = document.createElement("div");
    recent.className = "session-dialog-recent";
    const caption = document.createElement("p");
    caption.className = "session-dialog-recent-label";
    caption.id = `session-dialog-recent-${++recentLists}`;
    caption.textContent = t("sessionDialog.recent.label");
    const list = document.createElement("ul");
    list.setAttribute("aria-labelledby", caption.id);
    for (const dir of recentDirs) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ab-row session-dialog-recent-row";
      // Ein langer Pfad wird abgeschnitten; der Tooltip traegt ihn ganz.
      row.title = dir;
      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = dir;
      row.appendChild(label);
      row.addEventListener("click", () => {
        if (!disposed) chooseRecent(dir);
      });
      const item = document.createElement("li");
      item.appendChild(row);
      list.appendChild(item);
    }
    recent.append(caption, list);
    form.appendChild(recent);
  }

  // Der Baum steht INNERHALB des Formulars, direkt unter dem Feld (und der
  // Liste "Recent"): damit laeuft die Tabulatorreihenfolge Feld -> letzte
  // Verzeichnisse -> Versteckt-Schalter -> Baum -> Abbrechen -> Absenden, ohne
  // dass hier ein einziges `tabindex` gesetzt werden muss (der Baum belegt
  // zwei Stationen, siehe seinen Kopfkommentar). Fuers Absenden
  // ungefaehrlich: seine Zeilen sind `type="button"`, und `Enter` haelt er
  // selbst an.
  const treeHost = document.createElement("div");
  form.appendChild(treeHost);

  const actions = document.createElement("div");
  actions.className = "session-dialog-actions";

  const cancelButton = document.createElement("button");
  // `type="button"`, NICHT die Vorgabe "submit" -- sonst loest ein Klick auf
  // "Cancel" dasselbe `submit`-Ereignis wie "Create session" aus.
  cancelButton.type = "button";
  cancelButton.className = "btn btn--secondary";
  cancelButton.textContent = t("sessionDialog.cancel");
  cancelButton.addEventListener("click", () => {
    if (!disposed) opts.onCancel();
  });
  actions.appendChild(cancelButton);

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "btn btn--primary";
  submitButton.textContent = t("sessionDialog.submit");
  actions.appendChild(submitButton);

  form.appendChild(actions);
  root.appendChild(form);

  // Genau EIN [role=alert]-Knoten im Teilbaum (dasselbe Muster wie
  // `host-form.ts`s `warningEl`) -- `el.querySelector("[role=alert]")`
  // liefert immer den ERSTEN Treffer, ein zweiter wuerde diesen Test
  // verfaelschen.
  const errorEl = document.createElement("p");
  errorEl.setAttribute("role", "alert");
  errorEl.id = `session-dialog-error-${++errorMessages}`;
  root.appendChild(errorEl);

  el.appendChild(root);

  /** UX-Spec §11: ein Feldfehler markiert genau sein Feld -- `aria-invalid`
   * und `aria-describedby` auf die eine Meldung des Dialogs. */
  function showFieldError(field: HTMLInputElement, text: string): void {
    clearFieldError();
    errorEl.textContent = text;
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", errorEl.id);
  }

  /** Leert die Meldung und nimmt die Markierung von beiden Feldern. */
  function clearFieldError(): void {
    errorEl.textContent = "";
    for (const field of [nameInput, cwdInput]) {
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-describedby");
    }
  }

  // UX-Spec §7.6: jede Wahl eines Verzeichnisses -- Baum, Liste "Recent",
  // getippter Pfad -- traegt den Vorschlag ins Namensfeld, solange es leer
  // ist oder noch den letzten Vorschlag haelt. Das Oeffnen selbst waehlt
  // nichts: wer sofort absendet, bekommt wie bisher einen erzeugten Namen.
  // "Vergeben" heisst, was der Dialog kennt -- dieselbe Liste wie die
  // Duplikatpruefung beim Absenden.
  const taken = new Set(opts.existingSessions);
  let lastSuggestion = "";
  function suggestFor(dir: string): void {
    if (nameInput.value !== "" && nameInput.value !== lastSuggestion) return;
    lastSuggestion = suggestSessionName(dir, taken);
    nameInput.value = lastSuggestion;
  }

  /** Ein Klick in "Recent" waehlt wie ein Klick im Baum, und der Baum oeffnet
   * dort (Aufgabe 17). */
  function chooseRecent(dir: string): void {
    cwdInput.value = dir;
    // Wie bei `onSelect` unten von Hand: `.value` loest kein `input` aus.
    clearFieldError();
    suggestFor(dir);
    tree.reveal(dir);
  }

  const tree = mountDirectoryTree(treeHost, {
    hostId: opts.hostId,
    // Der FELDWERT ist der Startpfad (Entwurf E3/§5): der Baum oeffnet
    // aufgeklappt auf dessen Ahnenkette. Gelesen wird er hier genau EINMAL,
    // beim Mounten -- absichtlich, siehe den `input`-Behandler unten.
    initialPath: cwdInput.value,
    // Der Baum loest einen LEEREN Startpfad auf das Heimatverzeichnis auf und
    // meldet ihn hier -- ohne das bliebe das Feld leer, waehrend der Baum
    // richtig steht, und die Absendepruefung (`isAcceptableRemotePath`)
    // blockierte "Anlegen".
    //
    // BEDINGT uebernommen, anders als `onSelect`: die Meldung trifft erst
    // nach zwei SSH-Runden ein. Wer in dieser Zeit selbst getippt hat, hat
    // entschieden, und seine Eingabe wegzuwischen waere die schlimmere
    // Ueberraschung -- gerade weil hier ein Verzeichnis auf einem fremden
    // Rechner drinsteht.
    onInitialPath: (path) => {
      if (cwdEdited) return;
      cwdInput.value = path;
      clearFieldError();
    },
    onSelect: (path) => {
      cwdInput.value = path;
      // Von Hand nachgezogen, weil eine Zuweisung an `.value` KEIN
      // `input`-Ereignis ausloest: ohne diese Zeile bliebe eine vorherige
      // Ablehnung stehen, obwohl der Wert sich gerade geaendert hat.
      clearFieldError();
      suggestFor(path);
    },
    // Keine eigene `disposed`-Wache an `onSelect`: `dispose()` unten
    // entsorgt den Baum, und der ruft danach keinen Rueckruf mehr -- er
    // haengt seine Behandler ab und leert seinen Behaelter.
  });

  // Eine vorherige Ablehnung wird gegenstandslos, sobald der Nutzer den Wert
  // aendert -- dieselbe Frischentscheidung wie `host-form.ts`s
  // `clearDuplicateWarning`, hier fuer eine harte Ablehnung statt einer
  // Warnung.
  //
  // Der Baum bleibt dabei UNBERUEHRT: fuehrte er dem
  // Feld nach, kostete jedes Zeichen eine SSH-Runde. Er ist nicht die
  // Anzeige des Feldwerts, sondern ein zweiter Weg zu einem.
  cwdInput.addEventListener("input", () => {
    // Merkt sich, dass der Nutzer selbst Hand angelegt hat -- gelesen von
    // `onInitialPath` oben. Bewusst nur hier gesetzt und nirgends
    // zurueckgenommen: einmal getippt heisst getippt, auch wenn das Feld
    // danach wieder leer ist.
    cwdEdited = true;
    clearFieldError();
    // Jede Eingabe ist eine Wahl; der Ordnername ist das letzte Glied.
    suggestFor(cwdInput.value.trim());
  });

  // Dieselbe Frischentscheidung fuer das Namensfeld: wer den Namen aendert,
  // hat die Ablehnung des Namens beantwortet. Ein Fehler des Verzeichnisfelds
  // bleibt dagegen stehen -- er betrifft ein anderes Feld.
  nameInput.addEventListener("input", () => {
    if (nameInput.getAttribute("aria-invalid") === "true") clearFieldError();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (disposed) return;

    // Getrimmt VOR jeder Pruefung, und leer heisst "kein Name": das
    // Backend trimmt genauso, und `list_session_names` filtert leere Zeilen
    // -- ein Nur-Leerzeichen-Name verschwaende sonst komplett aus jeder
    // Liste.
    const typedName = nameInput.value.trim();
    if (typedName !== "" && !isAcceptableSessionName(typedName)) {
      showFieldError(nameInput, t("sessionDialog.error.nameChars"));
      return;
    }
    if (typedName !== "" && opts.existingSessions.includes(typedName)) {
      showFieldError(nameInput, t("sessionDialog.error.nameTaken", { name: typedName }));
      return;
    }

    const value = cwdInput.value.trim();
    if (!isAcceptableRemotePath(value)) {
      showFieldError(cwdInput, t("sessionDialog.error.absolute"));
      return;
    }

    opts.onSubmit(value, typedName === "" ? null : typedName);
  });

  return {
    focusName() {
      nameInput.focus();
    },
    dispose() {
      disposed = true;
      // Der AUFRUF muss sein, und zwar auf jedem Weg aus dem Dialog:
      // `dispose()` des Baums setzt die Sperre, hinter der eine spaet
      // eintreffende `list_directories`-Antwort keine weiteren Runden mehr
      // ausloest -- `el.replaceChildren()` allein haengt nur das DOM ab und
      // liesse die Ahnenkette weiterlaufen (Doc-Kommentar an
      // `DirectoryTreeHandle.dispose`; gemessen: drei zusaetzliche Runden
      // nach dem Schliessen).
      //
      // Die REIHENFOLGE der beiden Zeilen ist dagegen ohne Wirkung und von
      // keinem Test gehalten: `tree.dispose()` raeumt `treeHost`, und dem
      // ist gleichgueltig, ob ein Vorfahre schon geleert wurde. Sie steht
      // hier oben, weil sie die einzige der beiden mit Folgen ist -- nicht,
      // weil andersherum etwas braeche.
      //
      // Dass wirklich jeder Weg hier ankommt, ist Sache des Aufrufers:
      // `closeDialog()` der Dialoghuelle (`dialog.ts`) ruft
      // `dialogHandle?.dispose()`, und
      // Abbrechen, Escape, das Kreuz in der Kopfzeile und ein
      // erfolgreiches Absenden fuehren allesamt dorthin. Diese Datei
      // schliesst sich NICHT selbst (siehe `onCancel`).
      tree.dispose();
      el.replaceChildren();
    },
  };
}

/** Aendert die Bearbeitung, wie die App den Host erreicht (UX-Spec §7.7)?
 * Hostname, Benutzer, Port, Anmeldeart oder Schluesselpfad -- nicht der Name,
 * und auch kein eingetipptes Passwort oder eine Passphrase (beides wird nie
 * gespeichert). Nur dann trennt `main.ts` nach dem gelungenen Speichern einen
 * Host, der eine Verbindung will, und verbindet ihn neu. */
export function changesConnection(host: Host, values: HostFormValue): boolean {
  const keyPath = values.auth.kind === "key" ? values.auth.path : null;
  return (
    values.hostname !== host.hostname ||
    values.user !== host.user ||
    values.port !== host.port ||
    values.auth.kind !== host.authKind ||
    keyPath !== host.keyPath
  );
}

/** Das im Bearbeiten-Formular getippte Geheimnis -- ein Passwort oder eine
 * Passphrase, ein leeres Feld ist keins -- fuer genau den einen Aufbau nach
 * "Save" (UX-Spec §7.7, Aufgabe 18). Gespeichert wird
 * es nie; `main.ts` reicht es nur an diesen Aufbau weiter. */
export function reconnectSecret(values: HostFormValue): { password?: string; passphrase?: string } | undefined {
  if (values.auth.kind === "password" && values.auth.password !== "") return { password: values.auth.password };
  if (values.auth.kind === "key" && values.auth.passphrase !== "") return { passphrase: values.auth.passphrase };
  return undefined;
}

/** Speichert eine Bearbeitung mit einem einzigen Befehl und behaelt die
 * settings.toml-ID. Der Aufrufer fuellt das Formular mit dem gespeicherten
 * Namen und der Anmeldeart und nimmt diesen Host von der Duplikatpruefung aus;
 * ob die Laufzeitverbindung nach einem gelungenen Speichern getrennt und neu
 * aufgebaut wird, entscheidet ebenfalls er (`changesConnection`, UX-Spec
 * §7.7). Eigene Socket- und Verlaufswerte und die gewaehlte Anmeldeart
 * bleiben erhalten; Passwoerter und Passphrasen gehen nie an den
 * Speicherbefehl. */
export async function editHost(host: Host, newValues: HostFormValue): Promise<HostEntry> {
  return invoke<HostEntry>("update_host", {
    id: host.id,
    entry: {
      label: newValues.label,
      hostname: newValues.hostname,
      user: newValues.user,
      port: newValues.port,
      tmux_socket: host.tmuxSocket ?? null,
      history_limit: host.historyLimit ?? null,
      key_path: newValues.auth.kind === "key" ? newValues.auth.path : null,
      auth_kind: newValues.auth.kind,
    },
  });
}
