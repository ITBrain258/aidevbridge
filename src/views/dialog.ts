// Dialoghuelle: die generische Ueberlagerung in `#dialog-root` mit Kopfzeile,
// Fokus-Falle, `inert` auf `#app`, dokumentweitem Escape und Fokusrueckgabe.
//
// Den Zustand haelt die Huelle, die `mountDialogShell` anlegt, nicht das Modul:
// `main()` legt je Lauf eine eigene an. `main.test.ts` ruft `main()` je Test
// auf demselben `document` auf -- ein Modulzustand liesse eine offen gebliebene
// Ueberlagerung oder einen spaeten Rueckruf eines frueheren Laufs in den
// naechsten hineinwirken. Einzige Ausnahme ist der Zaehler fuer die Kennungen
// der Ueberschriften (`dialogTitles`): er haelt Kennungen im ganzen Dokument
// eindeutig und wirkt auf keinen Lauf.
import { t } from "../i18n/t";
import { icon } from "../icons";

/** Alle Elemente in `root`, die per Tastatur einen eigenen Tab-Stopp
 * darstellen -- fuer den Fokus-Falle-Umlauf in `openDialog` unten
 * gebraucht. Filtert versteckte Vorfahren UND `disabled`-Elemente heraus:
 * `first-run.ts` haengt z. B. ganze Abschnitte per `hidden` ein-/aus (das
 * Formular waehrend des Preflight, "Continue" waehrend eines blockierenden
 * Befunds) -- ein per `hidden` verstecktes, aber weiterhin im DOM
 * vorhandenes Element darf die Falle nicht als Tab-Ziel behandeln, sonst
 * landet Tab auf einem unsichtbaren Knopf. Bewusst ueber `.hidden`
 * (reflektiertes Attribut) statt `getComputedStyle`/`offsetParent` geprueft
 * -- Letztere liefern unter jsdom (Testumgebung) keine echte Layout-
 * Auskunft, `.hidden` dagegen ist ein einfacher DOM-Zustand, unter jsdom
 * wie im echten Browser gleich verlaesslich.
 *
 * Zweiter Durchgang: eine RADIOGRUPPE ist genau EIN Tab-Halt. HTML legt
 * fest, dass von einer Gruppe (gleicher `name` am selben Formular bzw. --
 * ohne Formular -- im selben Dokument) nur das gewaehlte Radio in der
 * sequentiellen Fokusreihenfolge steht; ist keines gewaehlt, ist es das
 * erste nicht deaktivierte. Der nackte `input`-Selektor oben zaehlte sonst
 * beide Themenradios des Einstellungsdialogs (Spec 12.1) und die Falle
 * rechnete mit einem `last`, das der Browser nie fokussiert -- Tab aus dem
 * gewaehlten Radio verliesse das Panel unbemerkt, Shift+Tab aus "Close"
 * landete auf dem NICHT gewaehlten Radio. Exportiert, damit
 * `main.test.ts` genau diese Zaehlung pruefen kann (Spec 16.2) -- main.ts
 * reicht es dafuer weiter und braucht es selbst fuer `focusSidebar`. */
export function focusableElements(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  );
  const visible = candidates.filter((el) => {
    if (el.matches(":disabled")) return false;
    for (let node: HTMLElement | null = el; node && node !== root; node = node.parentElement) {
      if (node.hidden || node.inert || node.hasAttribute("inert")) return false;
    }
    return true;
  });
  return visible.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio") return true;
    // Ein Radio ohne `name` bildet keine Gruppe und bleibt sein eigener
    // Tab-Halt.
    if (el.name === "") return true;
    // Gruppenumfang BEWUSST ueber Formular/Dokument statt ueber `root`: der
    // Browser bildet die Gruppe genau so, und die Falle muss dieselbe
    // Reihenfolge sehen wie er.
    const scope: ParentNode = el.form ?? el.ownerDocument;
    const group = Array.from(
      scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ).filter((r) => r.name === el.name && (r.form ?? r.ownerDocument) === scope && !r.disabled);
    return (group.find((r) => r.checked) ?? group[0]) === el;
  });
}

/** Zaehler fuer die Kennung der Ueberschrift, die `aria-labelledby` nennt --
 * je Oeffnen eine neue, im ganzen Dokument eindeutig (dasselbe Muster wie
 * `settingsId` in `settings-rows.ts`). */
let dialogTitles = 0;

export interface DialogOptions {
  /** Ueberschrift im Kopf der Ueberlagerung. */
  title: string;
  /** Breite Huelle (Spec 11.1), siehe `openDialog`. */
  wide?: boolean;
  /** Grosse Huelle mit fester Hoehe (Einstellungs-Spec §2), siehe `openDialog`. */
  large?: boolean;
  /** Rueckkehrziel fuer den Fokus, wenn das Element, das die Ueberlagerung
   * geoeffnet hat, beim Schliessen nicht mehr im Dokument steht (oder
   * `document.body` war). */
  fallbackFocus?: () => HTMLElement | null;
}

export interface DialogHandle {
  /** Der Koerper der Ueberlagerung, in den `build` den Inhalt gelegt hat. */
  body: HTMLElement;
  /** Schliesst genau diese Ueberlagerung. Ist sie schon zu oder durch eine
   * neue ersetzt, geschieht nichts. */
  close(): void;
}

export interface DialogShell {
  /** Oeffnet eine Ueberlagerung und schliesst vorher eine offene.
   * `build` legt den Inhalt in den Koerper; dessen `dispose()` laeuft auf
   * jedem Weg hinaus (Schliessen-Kreuz, Escape, `closeDialog`, Ersetzen). */
  openDialog(options: DialogOptions, build: (container: HTMLElement) => { dispose(): void }): DialogHandle;
  /** Schliesst die offene Ueberlagerung, gleich welche. */
  closeDialog(): void;
  isDialogOpen(): boolean;
  /** Meldet eine erscheinende oder verschwindende TOFU-Rueckfrage
   * (`mountHostKeyPrompt`s `onOpenChange`), siehe `hostKeyPromptOpen`. */
  setHostKeyPromptOpen(open: boolean): void;
}

/** Legt die Dialoghuelle ueber `dialogRoot` (`#dialog-root`) an und legt
 * waehrend einer offenen Ueberlagerung `app` (`#app`) still. Beim Anlegen
 * geschieht noch nichts am DOM. */
export function mountDialogShell(dialogRoot: HTMLElement, app: HTMLElement): DialogShell {
  /** Der Inhalt der offenen Ueberlagerung, `null`, solange keine offen ist. */
  let dialogHandle: { dispose(): void } | null = null;

  // `aria-modal="true"` behauptet Screenreadern, ALLES ausserhalb der
  // Ueberlagerung sei inert -- von selbst stimmt das nicht: `#dialog-root`
  // liegt im DOM NACH `#app` (index.html), die Seitenleiste bleibt vollstaendig
  // gemountet und ihre Knoepfe blieben tab-erreichbar, der Scrim blockiert nur
  // die Maus, nicht den Tastaturfokus. Ein Tastaturnutzer koennte so hinter dem
  // Scrim z. B. "Remove" auf einem unsichtbaren Host ausloesen. Diese drei
  // Stuecke (Fokus-Falle, `#app.inert`, dokumentweiter statt Panel-gebundener
  // Escape-Handler) machen die Zusage `aria-modal` erst wahr, statt sie nur zu
  // behaupten. `lastFocusedBeforeDialog` merkt sich, WOHER der Fokus kam, damit
  // er beim Schliessen dorthin zurueckkehrt (WAI-ARIA-Dialog-Muster), statt
  // irgendwo (oder nirgends) zu landen.
  let lastFocusedBeforeDialog: HTMLElement | null = null;
  let dialogFocusFallback: (() => HTMLElement | null) | null = null;

  /** Steht gerade eine TOFU-Rueckfrage? Gesetzt ueber
   * `setHostKeyPromptOpen` unten, das main.ts als `onOpenChange` an
   * `mountHostKeyPrompt` reicht.
   *
   * Truegen `#host-key-prompt-root` und `#dialog-root` denselben `z-index`,
   * malte die Ueberlagerung ueber die Rueckfrage, weil `#dialog-root` in
   * index.html spaeter steht. Der naive Weg -- Seitenleiste "+ Add host" ->
   * Formular -> Absenden -- fuehrte damit in eine Minute Nichts und danach in
   * "Connection failed": das Backend blockiert den Handshake in `recv_timeout`,
   * bis jemand antwortet oder `HOST_KEY_PROMPT_TIMEOUT` (60 s) ablaeuft, und
   * ein Zeitablauf zaehlt als Ablehnung. Der Fingerabdruck, den der Nutzer
   * pruefen SOLL, waere dabei zwar gerendert, aber weder sichtbar noch
   * erreichbar.
   *
   * Die Ebene allein (200 gegen 100, siehe die Stapelleiter in
   * styles.css) behebt Maus und Sichtbarkeit. Sie behebt NICHT die beiden
   * Dinge, die diese Datei beisteuert: die Fokus-Falle unten holt den
   * Fokus in `.dialog-panel` zurueck, egal wo er steht, und `#dialog-root`
   * bliebe tab-erreichbar. Beides wird stillgelegt, solange eine
   * Rueckfrage steht.
   *
   * Warum die Ueberlagerung dabei NICHT geschlossen wird (die naheliegende
   * Alternative): sie zeigt in diesem Moment `first-run.ts` mit einem noch
   * laufenden `connect_host`. Dessen `dispose()` setzt `disposed`, und der
   * Waechter hinter dem `await` in `first-run.ts` schliesst die Verbindung
   * dann sofort wieder, sobald sie zustande kommt. Ein Schliessen wuerde
   * also genau die Verbindung wegwerfen, die der Nutzer mit "Trust and
   * continue" gerade freigibt -- er beantwortete eine Sicherheitsfrage,
   * deren einziges Ergebnis waere, dass nichts passiert, und haette
   * nebenbei seine Eingaben verloren. Auch nicht ausgeblendet
   * (`hidden`): die Rueckfrage bringt ihren eigenen fensterfuellenden
   * Scrim mit und verdeckt die Ueberlagerung ohnehin; sichtbar bleiben
   * darf sie, weil ihr "Connecting..." erklaert, WARUM gerade nach einem
   * Hostschluessel gefragt wird. Also: ueberlagert und stillgelegt, nicht
   * geschlossen. */
  let hostKeyPromptOpen = false;

  function onDialogKeydown(event: KeyboardEvent): void {
    // Solange eine TOFU-Rueckfrage steht, gehoert die Tastatur IHR (siehe
    // `hostKeyPromptOpen` oben) -- inklusive Escape: das schloesse sonst
    // die Ueberlagerung und waere der einzige, voellig unbeschilderte Weg zu
    // einer bedienbaren Rueckfrage. Ein Escape, das mitten in der
    // Entscheidung die Verbindung dahinter verwirft, ist als Fluchtweg
    // schlechter als gar keiner -- die Rueckfrage selbst hat mit "Reject"
    // einen benannten.
    if (hostKeyPromptOpen) return;
    if (event.key === "Escape") {
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;

    const panel = dialogRoot.querySelector<HTMLElement>(".dialog-panel");
    if (!panel) return;
    const focusables = focusableElements(panel);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    // Wickelt am jeweils anderen Ende weiter, UND holt den Fokus zurueck in
    // die Falle, falls er (z. B. programmatisch) bereits ausserhalb steht --
    // `!panel.contains(active)` deckt beides mit derselben Zeile ab.
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  /** Generische Ueberlagerung fuer die drei Formular-Ablaeufe, die den
   * Rasterbereich NICHT verdraengen duerfen (Add/Edit host, neue Session --
   * anders als der Erststart bei null Hosts, siehe `showFirstRunInGrid` in
   * main.ts): `dialogRoot` (`#dialog-root`) liegt ausserhalb von `#app`
   * (index.html), also ausserhalb von `#grid`, ein bereits gemountetes
   * Raster samt seiner laufenden Terminals bleibt unberuehrt. `host-form.ts`
   * und `first-run.ts` bieten selbst keine Abbrechen-Schaltflaeche (nur
   * `session-dialog.ts` hat "Cancel") -- die Kopfzeile hier mit einer
   * Schliessen-Schaltflaeche UND Escape schafft fuer alle drei denselben
   * Fluchtweg, statt ihn dreimal einzeln nachzuruesten.
   *
   * `options.wide` (Spec 11.1): der Sessiondialog traegt den
   * Verzeichnisbaum und braucht dafuer 520 statt 480 Pixel -- die Breite
   * gehoert der Huelle, nicht dem Inhalt, deshalb ein Schalter hier statt
   * einer Regel in `session-dialog.ts`.
   *
   * `options.large` (Einstellungs-Spec §2): 760 x 540 mit fester Hoehe fuer
   * den Einstellungsdialog mit Navigation -- ein Bereichswechsel laesst den
   * Dialog nicht springen, das Panel darin scrollt selbst. */
  function openDialog(
    options: DialogOptions,
    build: (container: HTMLElement) => { dispose(): void },
  ): DialogHandle {
    // `closeDialog()` raeumt `dialogRoot` bereits leer, falls eine
    // vorherige Ueberlagerung noch offen war -- kein zweiter Aufruf hier
    // noetig.
    closeDialog();

    lastFocusedBeforeDialog = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogFocusFallback = options.fallbackFocus ?? null;
    // Siehe den Kommentar zu `aria-modal` oben: solange die Ueberlagerung
    // offen ist, ist der Rest der Anwendung fuer Tastatur UND Hilfstechnik
    // tatsaechlich unerreichbar, nicht nur behauptet.
    app.inert = true;

    const panel = document.createElement("div");
    panel.className = "dialog-panel";
    if (options.wide) panel.classList.add("dialog-panel--wide");
    if (options.large) panel.classList.add("dialog-panel--large");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const head = document.createElement("div");
    head.className = "dialog-head";
    const heading = document.createElement("h2");
    heading.textContent = options.title;
    // UX-Spec §11: der Dialog heisst wie seine Ueberschrift -- hier in der
    // Huelle, damit jeder Inhalt den Namen bekommt, ohne daran zu denken.
    heading.id = `dialog-title-${++dialogTitles}`;
    panel.setAttribute("aria-labelledby", heading.id);
    head.appendChild(heading);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "dialog-close-btn";
    closeButton.setAttribute("aria-label", t("app.close"));
    closeButton.title = t("app.close");
    // Icon statt eines "✕"-Zeichens (Spec 13): ein Ornament, der
    // Name steckt weiter in aria-label/title (dasselbe Muster wie tile.close
    // in grid.ts). Der Kasten haelt die 16 Pixel, `icon()` liefert das SVG
    // bereits mit `aria-hidden`.
    const closeIcon = document.createElement("span");
    closeIcon.className = "icon-box";
    closeIcon.setAttribute("aria-hidden", "true");
    closeIcon.appendChild(icon("x"));
    closeButton.appendChild(closeIcon);
    closeButton.addEventListener("click", () => closeDialog());
    head.appendChild(closeButton);
    panel.appendChild(head);

    const body = document.createElement("div");
    body.className = "dialog-body";
    panel.appendChild(body);

    dialogRoot.appendChild(panel);
    // Der umgekehrte Fall zu `setHostKeyPromptOpen` unten: eine
    // Ueberlagerung, die aufgeht, WAEHREND eine Rueckfrage schon steht (per
    // Tastatur aus der Seitenleiste heraus moeglich). Ohne diese Zeile waere
    // sie die einzige Ueberlagerung, die nicht stillgelegt ist.
    dialogRoot.inert = hostKeyPromptOpen;

    const contentHandle = build(body);
    dialogHandle = contentHandle;

    // Escape haengt am `document`, NICHT am `panel` (siehe den Kommentar zu
    // `aria-modal` oben): ein Panel-gebundener Handler greift nur, solange
    // der Fokus noch INNERHALB des Panels steht -- steht er ausserhalb, genau
    // der Fall, gegen den Fokus-Falle und `inert` antreten, bliebe Escape
    // wirkungslos. Auf `keydown` statt `keyup`, dasselbe Ereignis, an dem auch
    // der Tab-Umlauf oben haengt.
    document.addEventListener("keydown", onDialogKeydown);

    // Fokus als ERSTES Bedienelement in die Ueberlagerung (WAI-ARIA-
    // Dialog-Muster) -- die Schliessen-Schaltflaeche ist im DOM tatsaechlich
    // das erste Tab-Ziel (Kopfzeile vor Koerper), kein Sonderfall.
    closeButton.focus();

    return {
      body,
      // `closeDialog()` leert `dialogRoot`: haengt das Panel dort nicht
      // mehr, ist diese Ueberlagerung schon zu oder ersetzt, und ein spaeter
      // Aufruf darf nicht ihre Nachfolgerin schliessen.
      close: () => {
        if (panel.parentNode === dialogRoot) closeDialog();
      },
    };
  }

  function closeDialog(): void {
    dialogHandle?.dispose();
    dialogHandle = null;
    dialogRoot.replaceChildren();
    document.removeEventListener("keydown", onDialogKeydown);
    // NICHT unbedingt `false`: steht gerade eine TOFU-Rueckfrage offen, haelt
    // SIE #app weiter fest -- sonst waere die Seitenleiste dahinter fuer die
    // Dauer der Rueckfrage wieder per Tab erreichbar, nur weil diese generische
    // Ueberlagerung zufaellig gleichzeitig geschlossen wurde.
    app.inert = hostKeyPromptOpen;
    // Fokus zurueck auf das Element, das die Ueberlagerung geoeffnet hat
    // (WAI-ARIA-Dialog-Muster) -- `document.contains` schuetzt gegen ein
    // inzwischen aus dem DOM entferntes Element (z. B. ein Sidebar-Eintrag,
    // dessen Host in der Zwischenzeit entfernt wurde).
    const originalTarget = lastFocusedBeforeDialog;
    const returnTarget = originalTarget && originalTarget !== document.body && document.contains(originalTarget)
      ? originalTarget
      : dialogFocusFallback?.() ?? originalTarget;
    dialogFocusFallback = null;
    if (returnTarget && document.contains(returnTarget)) {
      returnTarget.focus();
    }
    lastFocusedBeforeDialog = null;
  }

  /** Siehe `hostKeyPromptOpen` oben fuer die volle Begruendung. `inert`
   * deckt beide Kanaele auf einmal ab, die ein z-index nicht erreicht:
   * kein Klick und kein Tab-Stopp mehr in der Ueberlagerung, und sie ist
   * fuer Hilfstechnik weg -- dasselbe Werkzeug, mit dem `openDialog`
   * bereits `#app` stilllegt, nur eine Ebene weiter oben angesetzt. */
  function setHostKeyPromptOpen(open: boolean): void {
    hostKeyPromptOpen = open;
    dialogRoot.inert = open;
    // Auch die Anwendung selbst, nicht nur die Dialogebene: sonst ist die
    // Seitenleiste hinter dem Scrim per Tab erreichbar, bis hin zu "Remove".
    // Frei nur, wenn AUCH kein generischer Dialog offen ist (`dialogHandle`,
    // siehe `openDialog`/`closeDialog` oben) -- eine TOFU-Rueckfrage, die
    // schliesst, waehrend "Add host" noch offen ist, darf #app nicht vorzeitig
    // freigeben.
    app.inert = open || dialogHandle !== null;
  }

  return {
    openDialog,
    closeDialog,
    isDialogOpen: () => dialogHandle !== null,
    setHostKeyPromptOpen,
  };
}
