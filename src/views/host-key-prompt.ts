// TOFU-Rueckfrage (Nachtrag vom 2026-07-25): zeigt die vom Backend
// per `hostkey://request` gemeldete Rueckfrage an und beantwortet sie ueber
// `respond_host_key`. Wird EINMALIG, GLOBAL gemountet (siehe `main.ts`) --
// unabhaengig davon, welche Ansicht (Erststart, Hostliste, Terminal) gerade
// sichtbar ist, weil `connect_host` von JEDER dieser Ansichten aus
// ausgeloest werden kann und die Rueckfrage mitten im SSH-Handshake auf der
// Rust-Seite auf eine ausdrueckliche Entscheidung wartet (TofuPolicy).
//
// Zeigt AUSSCHLIESSLICH den Fingerabdruck (`SHA256:...`), NIEMALS einen
// rohen Base64-Schluessel -- die Nutzlast von `hostkey://request`
// (`HostKeyRequest` in `commands.rs`) traegt den rohen Schluessel gar nicht
// erst, nur `fingerprint`. Diese Ansicht kann deshalb strukturell keinen
// rohen Schluessel zeigen, nicht nur durch Disziplin (siehe Testmodul).
//
// Ruft `respond_host_key` NIEMALS von selbst auf -- nur ein Klick auf
// "Trust and continue" oder "Reject" loest den Aufruf aus (siehe
// Testmodul: kein invoke() vor einem Klick).
//
// Zwei Zusagen zum Ausgang einer Rueckfrage:
//
// (a) Ein Fehlschlag von `respond_host_key` (z. B. weil das Backend die
// Anfrage inzwischen selbst per Zeitablauf aufgegeben hat) wird ueber
// `showNotice` sichtbar gemacht UND bleibt sichtbar, bis der Nutzer
// "Dismiss" klickt -- ein `finally { renderNext() }` im selben
// Funktionsaufruf (synchron, ohne `await` dazwischen) entfernte die Meldung
// sonst sofort wieder aus dem DOM, bevor der Browser sie je rendern konnte.
//
// (b) Jede Anfrage traegt `expires_at_unix_ms` (siehe
// `HostKeyRequest`s Doc-Kommentar in `commands.rs`) -- eine absolute
// Unix-Zeit, zu der das Backend das Warten fuer GENAU DIESE Anfrage
// aufgibt. Diese Ansicht zeigt daraus eine live aktualisierte Restzeit an
// (bewusste Entscheidung: eine unsichtbare Uhr ist eine
// schlechte Eigenschaft bei einer sicherheitsrelevanten Entscheidung mit
// Zeitlimit) UND schliesst sich selbst, sobald die Frist ablaeuft --
// automatisch, ohne dass der Nutzer erst klicken muesste. Warum, sagt der
// eine Satz aus UX-Spec §10, den das Backend mit dem Verbindungsfehler
// (`connect_timeout`) liefert; er steht dort, wo jeder Verbindungsfehler
// steht. Ein eigener Satz hier waere fuer dieselbe abgelaufene Frage ein
// zweiter, anderer Text. Eine Anfrage, die schon VOR dem Rendern abgelaufen
// ist (z. B. eine zweite, waehrend eine erste Rueckfrage noch offen war
// eingegangene Anfrage, deren eigene 60-Sekunden-Frist im Backend die ganze
// Wartezeit ueber weiterlief), wird gar nicht erst als interaktiver Dialog
// aufgebaut -- ein `respond_host_key`-Aufruf fuer sie wuerde ohnehin nur den
// Fehlerpfad treffen, weil das Backend ihren Eintrag laengst vergessen hat.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n/t";

/** Deckungsgleich mit `commands::HostKeyRequest` (`serde::Serialize`) --
 * `fingerprint` ist bereits der fertige `SHA256:...`-String, kein rohes
 * Schluesselmaterial. `expires_at_unix_ms`: siehe Modulkommentar (b). */
interface HostKeyRequestPayload {
  request_id: number;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  expires_at_unix_ms: number;
  /** Schluesseltypen, unter denen dieser Host bereits bekannt ist (MVP-Spec
   * M0.3, H8: `known_hosts::key_types_for`). Leer bei einem echten Erstkontakt
   * -- nicht leer, wenn der Server einen ANDEREN Typ anbietet als den/die
   * bereits hinterlegten (siehe `buildDialog`: nur dann erscheint der
   * zusaetzliche Hinweis). */
  known_key_types: string[];
}

/** Deckungsgleich mit `commands::HostKeyPersistFailure`. */
interface HostKeyPersistFailurePayload {
  host: string;
  port: number;
  message: string;
}

interface HostKeyRequestClosedPayload {
  request_id: number;
  expires_at_unix_ms: number;
  reason: "cancelled" | "expired" | "answered" | "unavailable";
}

export interface HostKeyPromptHandle {
  readonly ready: Promise<void>;
  dispose(): void;
}

export interface HostKeyPromptOptions {
  /** Meldet JEDEN Wechsel zwischen "diese Ansicht zeigt gerade etwas" und
   * "sie ist leer" -- und zwar NUR bei einem echten Wechsel, nicht bei
   * jedem Neuaufbau des Inhalts (`renderNext` raeumt `root` erst leer und
   * fuellt es im selben synchronen Durchlauf wieder; ein aus
   * `root.childElementCount` an beiden Punkten abgeleitetes Signal wuerde
   * dabei false/true flackern und den Aufrufer mitten in einem Uebergang
   * handeln lassen).
   *
   * Der Grund, warum es diesen Rueckruf gibt: die Rueckfrage kann VOR einer
   * offenen Dialog-Ueberlagerung erscheinen (`dialog.ts::openDialog`, z. B.
   * "Add host"). Sie liegt darueber (Stapelleiter in `styles.css`), aber die
   * Ueberlagerung bringt zwei Dinge mit, die kein z-index aufhebt: ihre
   * Fokus-Falle und ihre Tab-Erreichbarkeit. Beides muss der Aufrufer
   * stilllegen, solange hier etwas steht -- und er kann das nur, wenn er es
   * erfaehrt.
   *
   * Bewusst KEIN Zustand, den der Aufrufer selbst abfragen kann: eine
   * `isOpen()`-Methode muesste er pollen, und genau der Moment des
   * Wechsels ist das, worauf er reagieren muss. */
  onOpenChange?(open: boolean): void;
  /** Eine Frage ist abgelaufen und verschwindet still (UX-Spec §10). Den Satz
   * dazu traegt der Verbindungsfehler; ob er angesagt werden muss, weiss nur
   * der Weg, der verbunden hat -- darum meldet diese Ansicht nur Host und Port
   * der Frage (`host` ist der Hostname, mit dem verbunden wurde). */
  onExpired?(request: { host: string; port: number }): void;
}

/**
 * Mountet die TOFU-Rueckfrage-Ansicht in `root`. `root` bleibt leer, solange
 * keine Rueckfrage ansteht -- eine Anfrage fuellt sie, eine Antwort
 * (Klick) leert sie wieder (oder zeigt die naechste wartende Anfrage, falls
 * inzwischen mehrere eingegangen sind -- Warteschlange statt Ueberschreiben,
 * damit keine Rueckfrage stillschweigend verloren geht).
 *
 * Mountet zusaetzlich einen von `root` UNABHAENGIGEN Hinweis-Banner direkt in
 * `document.body` fuer `hostkey://persist-failed`: Der Anfrage-Dialog in `root`
 * nutzt `root.childElementCount === 0` als "gerade nichts angezeigt"-Signal, um
 * zu entscheiden, ob eine neu eintreffende Anfrage sofort gerendert werden darf
 * (siehe unten) -- ein Persistenzfehler-Hinweis, der stattdessen in `root`
 * selbst haengen wuerde, wuerde dieses Signal verfaelschen und eine WARTENDE,
 * echte Rueckfrage stillschweigend in der Warteschlange stecken lassen, obwohl
 * der Nutzer gerade nur einen unabhaengigen Hinweis sieht.
 */
export function mountHostKeyPrompt(
  root: HTMLElement,
  opts: HostKeyPromptOptions = {},
): HostKeyPromptHandle {
  const queue: HostKeyRequestPayload[] = [];
  let disposed = false;
  let currentRequest: HostKeyRequestPayload | null = null;
  let responsePending = false;
  // Close can arrive before request across asynchronous event delivery. Keep
  // only still-relevant IDs; after their original deadline no dialog is usable.
  const closedRequests = new Map<number, number>();
  let closedRequestsTimer: ReturnType<typeof setTimeout> | null = null;

  function pruneClosedRequests(): void {
    if (closedRequestsTimer !== null) clearTimeout(closedRequestsTimer);
    closedRequestsTimer = null;
    const now = Date.now();
    for (const [id, expiry] of closedRequests) {
      if (expiry <= now) closedRequests.delete(id);
    }
    if (closedRequests.size > 0) {
      let nextExpiry = Infinity;
      for (const expiry of closedRequests.values()) nextExpiry = Math.min(nextExpiry, expiry);
      closedRequestsTimer = setTimeout(pruneClosedRequests, Math.min(nextExpiry - now, 2_147_483_647));
    }
  }

  function rememberClosed(req: { request_id: number; expires_at_unix_ms: number }): void {
    closedRequests.set(req.request_id, req.expires_at_unix_ms);
    pruneClosedRequests();
  }

  // Zuletzt GEMELDETER Zustand (siehe `HostKeyPromptOptions.onOpenChange`)
  // -- nicht der aktuelle Inhalt von `root`, der waehrend eines Uebergangs
  // kurzzeitig leer ist, ohne dass die Ansicht deshalb zugeklappt waere.
  let notifiedOpen = false;
  // Wohin der Fokus zurueckgeht, wenn hier nichts mehr steht (WAI-ARIA-
  // Dialog-Muster, dasselbe wie `dialog.ts::lastFocusedBeforeDialog`). Wird
  // beim Uebergang leer -> gefuellt gemerkt, nicht bei jedem Neuaufbau:
  // sonst stuende darin die Schaltflaeche der VORIGEN Rueckfrage, die es
  // gleich nicht mehr gibt.
  let focusBeforePrompt: HTMLElement | null = null;

  function rememberFocusIfClosed(): void {
    if (notifiedOpen) return;
    focusBeforePrompt = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  /** Meldet einen ECHTEN Wechsel des Anzeigezustands und gibt beim
   * Zuklappen den Fokus zurueck. Wird am ENDE jedes Uebergangs gerufen,
   * nie zwischendrin. */
  function syncOpen(): void {
    const open = root.childElementCount > 0;
    if (open === notifiedOpen) return;
    notifiedOpen = open;
    // Reihenfolge ist eine Korrektheitsbedingung, keine Politur: der
    // Aufrufer setzt auf diese Meldung hin `#dialog-root.inert`
    // (`dialog.ts::setHostKeyPromptOpen`).
    // Ein `focus()` auf ein Element, das noch in einem inerten Teilbaum
    // liegt, verpufft im Browser -- erst melden (der Teilbaum wird wieder
    // bedienbar), dann den Fokus dorthin zurueckgeben.
    opts.onOpenChange?.(open);
    if (open) return;
    if (focusBeforePrompt && document.contains(focusBeforePrompt)) {
      focusBeforePrompt.focus();
    }
    focusBeforePrompt = null;
  }

  // Timer, die an den GERADE angezeigten Dialog in `root` gebunden sind --
  // eine laufende Restzeit-Anzeige (Intervall) und ein Zeitablauf-Timeout.
  // `clear()` raeumt sie IMMER zuerst auf, bevor neuer Inhalt aufgebaut wird
  // -- sonst wuerde ein stiller, aus einer frueheren Anzeige uebrig
  // gebliebener Timer spaeter auf einen inzwischen laengst anderen Inhalt von
  // `root` einwirken (z. B. eine naechste Anfrage vorzeitig wegraeumen).
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function clearTimers(): void {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function clear(): void {
    clearTimers();
    currentRequest = null;
    responsePending = false;
    root.replaceChildren();
  }

  function renderNext(): void {
    clear();
    const next = queue.shift();
    if (!next) {
      // Ende des Uebergangs: nichts steht mehr an. `render()` meldet den
      // anderen Ausgang selbst (ueber `buildDialog`) -- deshalb
      // hier NUR der leere Fall, sonst faellt zwischen `clear()` und dem
      // erneuten Fuellen ein ueberfluessiges "zu"/"auf"-Paar an.
      syncOpen();
      return;
    }
    render(next);
  }

  /** Zeigt eine persistente Fehlermeldung (a) mit einem "Dismiss"-Button, der
   * zur naechsten wartenden Anfrage weiterschaltet. Die Meldung bleibt
   * stehen, bis der Nutzer sie aktiv wegklickt, weil ein Fehlschlag beim
   * Beantworten kein Zeitlimit hat, das ihn von selbst aufloesen wuerde. */
  function showNotice(message: string): void {
    rememberFocusIfClosed();
    clear();

    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = message;
    root.appendChild(notice);

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.className = "btn btn--secondary btn--row";
    dismissButton.textContent = t("hostKeyPrompt.dismiss");
    dismissButton.addEventListener("click", () => {
      renderNext();
    });
    root.appendChild(dismissButton);

    syncOpen();
  }

  /** Eine abgelaufene Frage verschwindet still (b), und die naechste wartende
   * kommt dran. Den einen Satz dazu liefert das Backend mit dem
   * Verbindungsfehler (UX-Spec §10, siehe Modulkommentar); `onExpired` laesst
   * den Aufrufer ihn ansagen, wo kein Alert ihn ohnehin vorliest. */
  function dropExpired(req: HostKeyRequestPayload): void {
    opts.onExpired?.({ host: req.host, port: req.port });
    renderNext();
  }

  async function respond(requestId: number, accept: boolean): Promise<void> {
    const req = currentRequest;
    if (disposed || !req || req.request_id !== requestId || responsePending) return;
    if (req.expires_at_unix_ms <= Date.now()) {
      dropExpired(req);
      return;
    }
    responsePending = true;
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
    // Keep the expiry running while the IPC response is pending. Its eventual
    // resolution owns only this request, never a newer dialog or notice.
    try {
      await invoke("respond_host_key", { requestId, accept });
      if (disposed || currentRequest !== req) return;
      rememberClosed(req);
      renderNext();
    } catch (error) {
      if (disposed || currentRequest !== req) return;
      rememberClosed(req);
      // Die Rueckfrage selbst ist beim Backend ggf. schon per Zeitablauf
      // aufgegeben worden (kein Antwort-Fenster nach `prompt_timeout`) -- ein
      // Fehlschlag hier hat dann keine Wirkung mehr auf die laengst abgelehnte
      // Verbindung, wird aber trotzdem sichtbar gemacht (und bleibt sichtbar,
      // bis der Nutzer sie wegklickt), statt still zu verschwinden (siehe
      // Kopfkommentar, Punkt (a)).
      showNotice(t("hostKeyPrompt.respondError", { message: String(error) }));
    }
  }

  function buildDialog(req: HostKeyRequestPayload, remainingMs: number): void {
    const dialog = document.createElement("div");
    // Dieselbe Huelle wie die generischen Ueberlagerungen (Spec 11.1,
    // `dialog.ts::openDialog`): Kopf mit Ueberschrift, scrollender Koerper,
    // gleiche Flaeche/Radius/Schatten. `.host-key-prompt` bleibt daneben
    // stehen -- sie traegt die eigene Breite (440 statt 480) UND ist der
    // Selektor, an dem Tests und die Stapelleiter diesen Dialog erkennen.
    // KEIN Schliessen-Kreuz im Kopf: dieser Dialog hat keinen dritten
    // Ausgang neben "Reject" und "Trust and continue" (dieselbe
    // Begruendung, aus der Escape hier wirkungslos bleibt).
    dialog.className = "host-key-prompt dialog-panel";
    dialog.setAttribute("role", "alertdialog");
    // Fokusziel beim Erscheinen (siehe `dialog.focus()` weiter unten):
    // `-1` haelt den Knoten aus der Tab-Reihenfolge heraus, macht ihn aber
    // programmatisch fokussierbar. Bewusst der BEHAELTER, nicht "Reject"
    // oder "Trust and continue" -- eine vorbelegte Antwort waere auf eine
    // Sicherheitsfrage genau die falsche Bequemlichkeit (ein reflexhaftes
    // Enter beantwortete sie ungelesen). Von hier aus fuehrt Tab in die
    // beiden Schaltflaechen.
    dialog.tabIndex = -1;
    // Tastatur/Hilfstechnik: `role="alertdialog"` allein macht den Dialog fuer
    // unterstuetzende Technologien noch nicht ausdruecklich MODAL, und ohne
    // `aria-labelledby` fehlt ihm ein zugeordneter Name -- beides ergaenzt
    // hier, `heading.id` erst NACH dem Anhaengen an `dialog` gesetzt, damit die
    // ID sich nicht mit einer frueheren Anzeige ueberschneidet (`clear()`
    // entfernt den vorigen Knoten vollstaendig, bevor `buildDialog` erneut
    // laeuft).
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.textContent = t("hostKeyPrompt.heading");
    const head = document.createElement("div");
    head.className = "dialog-head";
    head.appendChild(heading);
    dialog.appendChild(head);
    heading.id = "host-key-prompt-title";
    dialog.setAttribute("aria-labelledby", heading.id);

    // Alles Weitere in den scrollenden Koerper -- ein langer Fingerabdruck
    // oder ein Hinweis auf mehrere bekannte Schluesseltypen darf den Kopf
    // nicht wegschieben.
    const body = document.createElement("div");
    body.className = "dialog-body";
    dialog.appendChild(body);

    const intro = document.createElement("p");
    intro.textContent = t("hostKeyPrompt.body", {
      host: req.host,
      port: String(req.port),
    });
    body.appendChild(intro);

    const fingerprintLabel = document.createElement("p");
    fingerprintLabel.className = "host-key-prompt-fingerprint-label";
    fingerprintLabel.textContent = t("hostKeyPrompt.fingerprint.label", {
      keyType: req.key_type,
    });
    body.appendChild(fingerprintLabel);

    // Eigener Knoten mit eigener Klasse, damit ein Test gezielt DIESEN
    // Textinhalt pruefen kann -- der Fingerabdruck selbst, nicht die
    // umgebende Beschriftung.
    const fingerprintValue = document.createElement("code");
    fingerprintValue.className = "host-key-prompt-fingerprint-value";
    fingerprintValue.textContent = req.fingerprint;
    body.appendChild(fingerprintValue);

    // H8-Nachtrag: der Server bietet einen ANDEREN Schluesseltyp an als
    // den/die bereits in `known_hosts` hinterlegten -- `lookup` liefert
    // dafuer `Unknown`, nicht `Mismatch` (wie OpenSSH: ein neuer Typ ist ein
    // neuer Schluessel, keine MITM-Warnung), aber ein Nutzer sollte das
    // trotzdem sehen koennen, statt einen voelligen Erstkontakt zu
    // vermuten. Nur gezeigt, wenn die Liste tatsaechlich etwas enthaelt --
    // ein echter Erstkontakt (leere Liste) bekommt keinen irrefuehrenden
    // Hinweis auf einen Typ, den es nie gab.
    if (req.known_key_types.length > 0) {
      const otherTypeNotice = document.createElement("p");
      otherTypeNotice.textContent = t("hostKey.otherTypeKnown", {
        types: req.known_key_types.join(", "),
        keyType: req.key_type,
      });
      body.appendChild(otherTypeNotice);
    }

    // Restzeit-Anzeige (Kopfkommentar, Punkt (b)): eine sicherheitsrele-
    // vante Entscheidung mit Zeitlimit sollte das Limit nicht verstecken --
    // sonst verschwindet der Dialog fuer den Nutzer scheinbar grundlos,
    // sobald die Frist ablaeuft. Aktualisiert sich jede Sekunde aus
    // `req.expires_at_unix_ms` neu (nicht herunterzaehlend aus einem
    // gespeicherten Startwert), damit sie auch dann korrekt bleibt, wenn der
    // Tab zwischenzeitlich im Hintergrund gedrosselt wurde.
    const countdown = document.createElement("p");
    countdown.className = "host-key-prompt-countdown";
    body.appendChild(countdown);

    function updateCountdown(): void {
      const remaining = Math.max(0, req.expires_at_unix_ms - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      countdown.textContent = t("hostKeyPrompt.expiresIn", { seconds: String(seconds) });
    }
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);

    const actions = document.createElement("div");
    actions.className = "host-key-prompt-actions";

    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    // Ablehnen ist der zerstoererische Ausgang (die Verbindung faellt), das
    // Vertrauen der primaere -- Spec 11.4 vergibt die Rollen so herum.
    rejectButton.className = "btn btn--danger";
    rejectButton.textContent = t("hostKeyPrompt.reject");
    rejectButton.addEventListener("click", () => {
      void respond(req.request_id, false);
    });

    const acceptButton = document.createElement("button");
    acceptButton.type = "button";
    acceptButton.className = "btn btn--primary";
    acceptButton.textContent = t("hostKeyPrompt.accept");
    acceptButton.addEventListener("click", () => {
      void respond(req.request_id, true);
    });

    actions.appendChild(rejectButton);
    actions.appendChild(acceptButton);
    body.appendChild(actions);

    root.appendChild(dialog);

    // Self-close bei Ablauf (Kopfkommentar, Punkt (b)): niemand muss
    // klicken, damit ein abgelaufener Dialog verschwindet -- er schliesst
    // sich selbst (siehe `dropExpired`).
    expiryTimer = setTimeout(() => {
      dropExpired(req);
    }, remainingMs);

    // Erst melden, dann fokussieren (siehe `syncOpen`s Kommentar zur
    // Reihenfolge). Der Fokus MUSS hier hin: steht dahinter eine
    // Dialog-Ueberlagerung offen, liegt der Fokus in DEREN Fokus-Falle -- ein
    // blosses Ueberlagern per z-index machte die Rueckfrage sichtbar und
    // anklickbar, aber nicht bedienbar, und die Vorgabe "die gesamte
    // Oberflaeche ist mit der Tastatur allein bedienbar" gaelte ausgerechnet an
    // einer Sicherheitsentscheidung nicht.
    syncOpen();
    dialog.focus();
  }

  function render(req: HostKeyRequestPayload): void {
    rememberFocusIfClosed();
    currentRequest = req;
    const remainingMs = req.expires_at_unix_ms - Date.now();
    if (remainingMs <= 0) {
      // Die Frist ist bereits abgelaufen, WAEHREND diese Anfrage noch in
      // der Warteschlange stand (etwa eine zweite Rueckfrage, deren eigene
      // 60-Sekunden-Frist im Backend unsichtbar weiterlief, waehrend die
      // erste noch offen war).
      // Das Backend hat `decide()` fuer sie laengst per Zeitablauf beendet
      // und den Eintrag vergessen -- ein `respond_host_key`-Aufruf fuer
      // diese `request_id` wuerde nur noch den Fehlerpfad treffen. Gar
      // nicht erst als interaktiven Dialog mit toten Buttons aufbauen.
      dropExpired(req);
      return;
    }
    buildDialog(req, remainingMs);
  }

  const unlistenPromise = listen<HostKeyRequestPayload>("hostkey://request", (event) => {
    if (disposed) return;
    pruneClosedRequests();
    if (closedRequests.has(event.payload.request_id) ||
      currentRequest?.request_id === event.payload.request_id ||
      queue.some((req) => req.request_id === event.payload.request_id)) return;
    queue.push(event.payload);
    // Nur rendern, wenn gerade NICHTS angezeigt wird -- sonst wuerde eine
    // zweite, waehrend die erste noch offen ist eintreffende Anfrage die
    // erste unbeantwortet aus dem DOM verdraengen.
    if (root.childElementCount === 0) {
      renderNext();
    }
  });

  const closedUnlistenPromise = listen<HostKeyRequestClosedPayload>("hostkey://request-closed", (event) => {
    if (disposed) return;
    const closed = event.payload;
    rememberClosed(closed);
    const queuedIndex = queue.findIndex((req) => req.request_id === closed.request_id);
    const queued = queuedIndex >= 0 ? queue.splice(queuedIndex, 1)[0] : null;
    // Auch eine wartende, nie gezeigte Frage kann ablaufen; ihr Verbindungsfehler
    // braucht dieselbe Meldung wie der einer gezeigten.
    if (queued && closed.reason === "expired") opts.onExpired?.({ host: queued.host, port: queued.port });
    const current = currentRequest;
    if (current?.request_id !== closed.request_id) return;
    // Jeder Grund schliesst still (siehe `dropExpired`).
    if (closed.reason === "expired") dropExpired(current);
    else renderNext();
  });

  // Persistenzfehler-Hinweis: bewusst NICHT in `root` (siehe Doc-Kommentar
  // oben), sondern ein eigener, unabhaengiger Knoten direkt in `document.body`.
  // Ein solcher Hinweis kann eintreffen, NACHDEM die eigentliche Rueckfrage
  // fuer diese Anfrage bereits beantwortet und aus `root` entfernt wurde
  // (`decide()` ruft `sink.notify_persist_failed` erst NACH der Antwort auf,
  // siehe `commands.rs`) -- oder waehrend `root` gerade eine VOELLIG ANDERE,
  // noch offene Rueckfrage zeigt. Beides darf den Anfrage-Dialog nicht
  // verdraengen.
  // Aussehen und Position leben in `src/styles.css`
  // (`.host-key-persist-failure-banner`) -- NICHT hier inline, siehe dessen
  // Kommentar: eine Autoren-Regel mit `display` gewinnt gegen die
  // `[hidden]`-UA-Regel. `display: flex` steht deshalb nur in
  // `.host-key-persist-failure-banner:not([hidden])`; dazu stellt die globale
  // Regel `[hidden] { display: none !important }` in styles.css `hidden`
  // ueberall wieder her.
  const persistFailureBanner = document.createElement("div");
  persistFailureBanner.className = "host-key-persist-failure-banner";
  persistFailureBanner.setAttribute("role", "alert");
  persistFailureBanner.hidden = true;

  const persistFailureText = document.createElement("span");
  persistFailureBanner.appendChild(persistFailureText);

  const persistFailureDismiss = document.createElement("button");
  persistFailureDismiss.type = "button";
  // Zeilenknopf wie im globalen Fehlerbanner (Spec 11.2) -- beide sind
  // schmale Streifen, kein Ort fuer einen 32er Knopf.
  persistFailureDismiss.className = "btn btn--secondary btn--row";
  persistFailureDismiss.textContent = t("hostKeyPrompt.dismiss");
  persistFailureDismiss.addEventListener("click", () => {
    persistFailureBanner.hidden = true;
  });
  persistFailureBanner.appendChild(persistFailureDismiss);

  document.body.appendChild(persistFailureBanner);

  const persistFailureUnlistenPromise = listen<HostKeyPersistFailurePayload>(
    "hostkey://persist-failed",
    (event) => {
      if (disposed) return;
      persistFailureText.textContent = t("hostKeyPrompt.persistFailed", {
        host: event.payload.host,
        port: String(event.payload.port),
        message: event.payload.message,
      });
      persistFailureBanner.hidden = false;
    },
  );

  const registrations = [unlistenPromise, closedUnlistenPromise, persistFailureUnlistenPromise];
  const ready = Promise.all(registrations).then(() => {});
  // Consumers surface readiness failures at their connect/startup boundary.
  // Also handle rejection if the view is disposed before a consumer awaits it.
  void ready.catch(() => {});

  return {
    ready,
    dispose() {
      disposed = true;
      for (const registration of registrations) {
        void registration.then((unlisten) => unlisten()).catch(() => {});
      }
      queue.length = 0;
      closedRequests.clear();
      if (closedRequestsTimer !== null) clearTimeout(closedRequestsTimer);
      closedRequestsTimer = null;
      clear();
      // Auch das Abraeumen ist ein Uebergang: stand hier noch eine
      // Rueckfrage, muss der Aufrufer erfahren, dass sie weg ist -- sonst
      // bliebe `#dialog-root` inert zurueck
      // (`dialog.ts::setHostKeyPromptOpen`).
      syncOpen();
      persistFailureBanner.remove();
    },
  };
}
